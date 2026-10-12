<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Marketing: Meta ad spend pulled daily from the Marketing API, real cost per order / delivered order, ROAS, alerts,
 * spend posted to accounts. (Port of legacy/server/modules/marketing.js)
 */
class MarketingModule extends Module
{
    public string $name = 'marketing';

    private const CANCELLED = "('cancelled','cs_cancelled','courier_cancelled')";

    private const RETURNED = "('returned','return_received','returning')";

    private const DEF = ['token' => '', 'accounts' => [], 'version' => 'v21.0', 'currency' => 'PKR', 'fx' => 280, 'cardPct' => 0, 'post' => false, 'creditAccount' => 'Meta Ads Payable', 'postFrom' => '', 'dailyBudget' => 0, 'zeroThreshold' => 15000];

    private const BANKS = ['Meezan (SB)', 'Cash', 'Petty Cash', 'PayFast'];

    private const OTHER_CATS = ['Influencer', 'Photoshoot', 'Boosted post', 'Printing', 'Other'];

    // Purchases: Meta reports the same purchase under several action types; take the larger of the two, never add them
    private const PURCH = ['purchase', 'offsite_conversion.fb_pixel_purchase'];

    private const RUNNING_KEY = 'erp.marketing.sync_running';

    /** in-process flag (the JS module-level `running`); also mirrored in the cache so other PHP processes see it */
    private bool $running = false;

    public function activity(): array
    {
        return ['marketing.settings' => 'Changed Meta ads settings', 'marketing.sync' => 'Synced Meta ad spend', 'marketing.manual' => 'Entered daily ad spend', 'marketing.manual.delete' => 'Deleted daily ad spend',
            'marketing.payment' => 'Recorded Meta card payment', 'marketing.other' => 'Recorded other marketing spend', 'marketing.entry.delete' => 'Deleted marketing spend entry'];
    }

    public function install(): void
    {
        // older installs had one global currency: seed each saved account with it until Meta tells us the real one
        $k = $this->cfg();
        foreach ($k['accounts'] ?: [] as $a) {
            Db::run('INSERT IGNORE INTO mkt_accounts(id,currency) VALUES(?,?)', $a, self::jt($k['currency']) ? $k['currency'] : 'PKR');
        }
    }

    /* ---------------- helpers (JS semantics) ---------------- */

    private static function jt($v): bool
    {
        if ($v === null || $v === false || $v === '' || $v === 0) {
            return false;
        }
        if (is_float($v)) {
            return ! ($v == 0.0 || is_nan($v));
        }
        return true;
    }

    /** JS Number(x) / +x */
    private static function num($v)
    {
        if ($v === null) {
            return 0;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if (is_string($v)) {
            $s = trim($v);
            if ($s === '') {
                return 0;
            }
            if (is_numeric($s)) {
                $n = $s + 0;
                return is_float($n) && floor($n) == $n && abs($n) < PHP_INT_MAX && ! preg_match('/[.eE]/', $s) ? (int) $n : $n;
            }
            return NAN;
        }
        return NAN;
    }

    /** JS String(x) */
    private static function str($v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v) && floor($v) == $v && abs($v) < 1e15) {
            return (string) (int) $v;
        }
        if (is_array($v)) {
            return implode(',', array_map(fn ($x) => is_array($x) ? '' : self::str($x), $v));
        }
        return (string) $v;
    }

    private static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', strtotime($d.' 00:00:00 UTC') + $n * 86400);
    }

    /** Math.round((+v || 0) * 100) / 100 */
    private static function r2($v)
    {
        $n = self::num($v);
        if (! self::jt($n)) {
            $n = 0;
        }
        return Logic::jsRound($n * 100) / 100;
    }

    /** Number.toLocaleString('en-PK') */
    private static function loc($v): string
    {
        $v = (float) $v;
        if (floor($v) == $v) {
            return number_format($v, 0, '.', ',');
        }
        return rtrim(rtrim(number_format($v, 3, '.', ','), '0'), '.');
    }

    private static function obj($a)
    {
        return is_array($a) && ! $a ? new \stdClass : $a;
    }

    private function cfg(): array
    {
        $s = $this->setting('marketing', []);
        $c = array_merge(self::DEF, is_array($s) ? $s : []);
        if (! is_array($c['accounts'])) {
            $c['accounts'] = [];
        }
        return $c;
    }

    private function status(): array
    {
        $s = $this->setting('marketing_status', []);
        return is_array($s) ? $s : [];
    }

    private function setStatus(array $p): void
    {
        $this->setSetting('marketing_status', (object) array_merge($this->status(), $p));
    }

    private function connected(?array $c = null): bool
    {
        $c ??= $this->cfg();
        return self::jt($c['token'] ?? null) && count($c['accounts'] ?? []) > 0;
    }

    private function graphBase(): string
    {
        $env = getenv('MKT_GRAPH_URL');
        $b = self::jt($this->setting('marketing_graph_url', '')) ? $this->setting('marketing_graph_url', '') : (self::jt($env) ? $env : 'https://graph.facebook.com');
        return preg_replace('#/+$#', '', (string) $b);
    }

    // currency is per ad account (read from Meta, owner can override); PKR as-is, foreign × USD→PKR rate × (1 + card %)
    private function acctRow($act): ?array
    {
        return Db::get('SELECT * FROM mkt_accounts WHERE id=?', $act);
    }

    private function acctCur(array $c, $act): string
    {
        $a = $this->acctRow($act);
        $v = $a && self::jt($a['override'] ?? null) ? $a['override'] : ($a && self::jt($a['currency'] ?? null) ? $a['currency'] : (self::jt($c['currency'] ?? null) ? $c['currency'] : 'PKR'));
        return strtoupper(self::str($v));
    }

    private function rateFor(array $c, string $cur)
    {
        if ($cur === 'PKR') {
            return 1;
        }
        $fx = self::num($c['fx'] ?? null);
        $card = self::num($c['cardPct'] ?? null);
        return (self::jt($fx) ? $fx : 0) * (1 + (self::jt($card) ? $card : 0) / 100);
    }

    private static function statusTxt($s): string
    {
        $map = [1 => 'Active', 2 => 'Disabled', 3 => 'Unsettled (payment due)', 7 => 'Pending review', 8 => 'Pending settlement', 9 => 'In grace period', 100 => 'Pending closure', 101 => 'Closed'];
        $n = self::num($s);
        if (is_int($n) && isset($map[$n])) {
            return $map[$n];
        }
        return $s === null ? '' : 'Status '.self::str($s);
    }

    private function saveAcct($act, array $j): void
    {
        Db::run('INSERT INTO mkt_accounts(id,name,currency,status,checked_at) VALUES(?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE name=VALUES(name), currency=VALUES(currency), status=VALUES(status), checked_at=VALUES(checked_at)',
            $act, self::jt($j['name'] ?? null) ? $j['name'] : null, self::jt($j['currency'] ?? null) ? strtoupper(self::str($j['currency'])) : null, self::statusTxt($j['account_status'] ?? null));
    }

    private function acctInfo(array $c, $act): array
    {
        $j = $this->graphFetch($this->gUrl($c, $act, ['fields' => 'name,currency,account_status,amount_spent']));
        $this->saveAcct($act, $j);
        return $j;
    }

    private static function normAct($a): string
    {
        $a = trim(self::jt($a) ? self::str($a) : '');
        if ($a === '') {
            return '';
        }
        return str_starts_with($a, 'act_') ? $a : 'act_'.preg_replace('/\D/', '', $a);
    }

    /* ---------- Graph API ---------- */
    private function metaError($j, $httpStatus): RuntimeException
    {
        $e = is_array($j) && is_array($j['error'] ?? null) ? $j['error'] : [];
        $code = self::num($e['code'] ?? null);
        $sub = self::num($e['error_subcode'] ?? null);
        $codeOk = ! (is_float($code) && is_nan($code));
        $m = self::jt($e['message'] ?? null) ? self::str($e['message']) : '';
        if ($code === 190) {
            $msg = 'Meta token expired or was revoked (code 190). Make a new System User token with ads_read and paste it in Marketing → Settings.';
        } elseif ($codeOk && (in_array($code, [4, 17, 32, 613]) || ($code >= 80000 && $code <= 80014))) {
            $msg = 'Meta rate limit reached (code '.self::str($code).'). The ERP will try again at the next sync.';
        } elseif ($codeOk && ($code == 10 || $code == 200 || $code == 294 || ($code >= 200 && $code < 300))) {
            $msg = 'Token has no permission for this ad account (code '.self::str($code).'). Assign the ad account to the system user and include ads_read.';
        } elseif ($codeOk && $code == 100) {
            $msg = 'Meta did not accept the request (code 100'.(self::jt($sub) ? '/'.self::str($sub) : '').'): '.$m.'. Check the ad account id (act_…) and API version.';
        } else {
            $msg = 'Meta error'.(self::jt($code) ? ' (code '.self::str($code).')' : '').(self::jt($httpStatus) ? ' [HTTP '.$httpStatus.']' : '').': '.($m !== '' ? $m : 'unknown');
        }
        return new RuntimeException($msg);
    }

    private static function retryMs(): int
    {
        $v = getenv('MKT_RETRY_MS');
        return $v !== false && $v !== '' ? (int) self::num($v) : 20000;
    }

    private function graphFetch(string $url, int $tries = 0): array
    {
        try {
            $r = Http::withHeaders(['Accept' => 'application/json'])->timeout(60)->get($url);
        } catch (ConnectionException $e) {
            if ($tries < 2) {
                usleep(1500 * ($tries + 1) * 1000);
                return $this->graphFetch($url, $tries + 1);
            }
            throw new RuntimeException('Could not reach Meta ('.$e->getMessage().'). Check the internet connection.');
        }
        $j = json_decode($r->body(), true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $j = null;
        }
        if (! $r->successful() || (is_array($j) && self::jt($j['error'] ?? null))) {
            $err = $this->metaError($j, $r->status());
            if ((str_contains($err->getMessage(), 'rate limit') || $r->status() >= 500) && $tries < 2) {
                usleep(self::retryMs() * ($tries + 1) * 1000);
                return $this->graphFetch($url, $tries + 1);
            }
            throw $err;
        }
        return is_array($j) ? $j : [];
    }

    private function gUrl(array $c, string $path, array $params): string
    {
        return $this->graphBase().'/'.(self::jt($c['version'] ?? null) ? $c['version'] : 'v21.0').'/'.$path.'?'.http_build_query(array_merge($params, ['access_token' => $c['token']]), '', '&', PHP_QUERY_RFC1738);
    }

    private function testConnection(array $c): array
    {
        $out = [];
        foreach ($c['accounts'] as $a) {
            $j = $this->acctInfo($c, $a);
            $out[] = ['id' => $a, 'name' => $j['name'] ?? null, 'currency' => $j['currency'] ?? null, 'used' => $this->acctCur($c, $a), 'status' => self::statusTxt($j['account_status'] ?? null), 'amount_spent' => $j['amount_spent'] ?? null];
        }
        return $out;
    }

    private static function pickPurchase($arr)
    {
        $m = 0;
        foreach (is_array($arr) ? $arr : [] as $a) {
            if (is_array($a) && in_array($a['action_type'] ?? null, self::PURCH, true)) {
                $v = self::num($a['value'] ?? null);
                $v = self::jt($v) ? $v : 0;
                if ($v > $m) {
                    $m = $v;
                }
            }
        }
        return $m;
    }

    private static function n0($v)
    {
        $n = self::num($v);
        return self::jt($n) ? $n : 0;
    }

    private function fetchInsights(array $c, string $act, string $since, string $until): array
    {
        $rows = [];
        $url = $this->gUrl($c, $act.'/insights', ['level' => 'campaign', 'time_increment' => '1', 'time_range' => json_encode(['since' => $since, 'until' => $until]),
            'fields' => 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpm,actions,action_values', 'limit' => '500']);
        for ($pageN = 0; $url && $pageN < 200; $pageN++) {
            $j = $this->graphFetch($url);
            foreach (is_array($j['data'] ?? null) ? $j['data'] : [] as $d) {
                $rows[] = ['date' => $d['date_start'] ?? null, 'campaign_id' => self::str($d['campaign_id'] ?? null), 'campaign_name' => self::jt($d['campaign_name'] ?? null) ? $d['campaign_name'] : '', 'spend' => self::n0($d['spend'] ?? null),
                    'impressions' => self::n0($d['impressions'] ?? null), 'reach' => self::n0($d['reach'] ?? null), 'clicks' => self::n0($d['clicks'] ?? null), 'purchases' => self::pickPurchase($d['actions'] ?? null), 'purchase_value' => self::pickPurchase($d['action_values'] ?? null)];
            }
            $url = $j['paging']['next'] ?? null;
        }
        return $rows;
    }

    private function isRunning(): bool
    {
        if ($this->running) {
            return true;
        }
        try {
            return (bool) Cache::get(self::RUNNING_KEY);
        } catch (\Throwable) {
            return false;
        }
    }

    /** service: pull the last `days` days of campaign spend from Meta */
    public function sync($days, $userId = null): array
    {
        $c = $this->cfg();
        if (! $this->connected($c)) {
            throw new RuntimeException('Meta is not connected. Add the token and ad account in Marketing → Settings.');
        }
        if ($this->isRunning()) {
            throw new RuntimeException('A Meta sync is already running. Try again in a minute.');
        }
        $this->running = true;
        try {
            Cache::put(self::RUNNING_KEY, 1, 1800);
        } catch (\Throwable) {
        }
        $until = $this->pkToday();
        $since = self::addDays($until, -(max(1, (int) $days) - 1));
        $n = 0;
        try {
            $this->setStatus(['lastRun' => $this->isoNow(), 'running' => true]);
            $curs = [];
            foreach ($c['accounts'] as $act) {
                $this->acctInfo($c, $act);
                $cur = $curs[$act] = $this->acctCur($c, $act);
                $fx = $this->rateFor($c, $cur);
                if (! ($fx > 0)) {
                    throw new RuntimeException("Ad account {$act} bills in {$cur}: enter the USD → PKR rate in Marketing → Settings");
                }
                $rows = $this->fetchInsights($c, $act, $since, $until);
                $stamp = Db::val('SELECT UTC_TIMESTAMP() t');
                Db::tx(function () use ($rows, $act, $fx, $stamp, $since, $until) {
                    foreach ($rows as $r) {
                        Db::run('INSERT INTO mkt_daily(date,account_id,campaign_id,campaign_name,spend,spend_pkr,impressions,reach,clicks,purchases,purchase_value,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE campaign_name=VALUES(campaign_name), spend=VALUES(spend), spend_pkr=VALUES(spend_pkr), impressions=VALUES(impressions),
            reach=VALUES(reach), clicks=VALUES(clicks), purchases=VALUES(purchases), purchase_value=VALUES(purchase_value), synced_at=VALUES(synced_at)',
                            $r['date'], $act, $r['campaign_id'], $r['campaign_name'], $r['spend'], self::r2($r['spend'] * $fx), $r['impressions'], $r['reach'], $r['clicks'], $r['purchases'], $r['purchase_value'], $stamp);
                    }
                    // a campaign/day Meta no longer reports in this window (e.g. spend corrected to 0) is removed
                    Db::run('DELETE FROM mkt_daily WHERE account_id=? AND date BETWEEN ? AND ? AND synced_at<?', $act, $since, $until, $stamp);
                });
                $n += count($rows);
            }
            $msg = "{$n} campaign-days, {$since} to {$until}".(count($c['accounts']) > 1 ? ' · '.count($c['accounts']).' ad accounts ('.implode('/', array_values($curs)).')' : '');
            $this->setStatus(['lastOk' => $this->isoNow(), 'lastError' => null, 'lastErrorAt' => null, 'running' => false, 'lastMsg' => $msg]);
            $this->syncLog('meta', true, $msg);
            if ($userId) {
                $this->log($userId, 'marketing.sync', 'meta', ['since' => $since, 'until' => $until, 'rows' => $n]);
            }
            $this->postRange($since, $until);
            return ['rows' => $n, 'since' => $since, 'until' => $until];
        } catch (\Throwable $e) {
            $this->setStatus(['lastError' => $e->getMessage(), 'lastErrorAt' => $this->isoNow(), 'running' => false]);
            $this->syncLog('meta', false, $e->getMessage());
            throw $e;
        } finally {
            $this->running = false;
            try {
                Cache::forget(self::RUNNING_KEY);
            } catch (\Throwable) {
            }
        }
    }

    /* ---------- accounts posting ---------- */
    private function accSvc(): ?Module
    {
        $a = $this->svc('accounts');
        return $a && method_exists($a, 'post') ? $a : null;
    }

    /** service: Meta + manual spend of one day in PKR */
    public function daySpend($date)
    {
        $a = Db::val('SELECT COALESCE(SUM(spend_pkr),0) s FROM mkt_daily WHERE date=?', $date);
        $m = Db::val('SELECT COALESCE(SUM(amount),0) s FROM mkt_manual WHERE date=?', $date);
        return self::r2($a + $m);
    }

    private function postDay(string $date, bool $force = false): ?array
    {
        $c = $this->cfg();
        $acc = $this->accSvc();
        if (! self::jt($c['post']) || ! $acc) {
            return null;
        }
        if (self::jt($c['postFrom']) && $date < $c['postFrom']) {
            return null;
        }
        $amt = $this->daySpend($date);
        $prev = Db::get('SELECT * FROM mkt_posted WHERE date=?', $date);
        if (! $force && $prev && ! self::jt($prev['error']) && abs($prev['amount'] - $amt) < 0.01) {
            return $prev;
        }
        try {
            if ($amt <= 0) {
                if ($prev && method_exists($acc, 'void')) {
                    $acc->void('meta', $date, null);
                }
                Db::run('DELETE FROM mkt_posted WHERE date=?', $date);
                return null;
            }
            $jid = $acc->post(['date' => $date, 'memo' => "Meta ad spend {$date}", 'source' => 'meta', 'source_id' => $date,
                'lines' => [['account' => 'Social Media Marketing', 'debit' => $amt], ['account' => self::jt($c['creditAccount']) ? $c['creditAccount'] : 'Meta Ads Payable', 'credit' => $amt]]], null);
            Db::run('INSERT INTO mkt_posted(date,amount,journal_id,posted_at,error) VALUES(?,?,?,UTC_TIMESTAMP(),NULL) ON DUPLICATE KEY UPDATE amount=VALUES(amount), journal_id=VALUES(journal_id), posted_at=VALUES(posted_at), error=NULL',
                $date, $amt, is_numeric($jid) ? (int) $jid : null);
        } catch (\Throwable $e) {
            Db::run('INSERT INTO mkt_posted(date,amount,posted_at,error) VALUES(?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE amount=VALUES(amount), error=VALUES(error)', $date, $amt, $e->getMessage());
        }
        return Db::get('SELECT * FROM mkt_posted WHERE date=?', $date);
    }

    private function postRange(string $from, string $to): void
    {
        for ($d = $from; $d <= $to; $d = self::addDays($d, 1)) {
            $this->postDay($d);
        }
    }

    private function postEntry($id): void
    {
        $e = Db::get('SELECT * FROM mkt_spend WHERE id=?', $id);
        $acc = $this->accSvc();
        if (! $e) {
            return;
        }
        if (! $acc) {
            Db::run('UPDATE mkt_spend SET posted=0, error=? WHERE id=?', 'Accounts module not available yet', $id);
            return;
        }
        $src = $e['kind'] === 'payment' ? 'meta_pay' : 'mkt_other';
        $credit = $this->cfg()['creditAccount'];
        $lines = $e['kind'] === 'payment'
            ? [['account' => self::jt($credit) ? $credit : 'Meta Ads Payable', 'debit' => $e['amount']], ['account' => $e['bank'], 'credit' => $e['amount']]]
            : [['account' => 'Other Marketing', 'debit' => $e['amount']], ['account' => $e['bank'], 'credit' => $e['amount']]];
        $note = self::jt($e['note']) ? ' — '.$e['note'] : '';
        try {
            $acc->post(['date' => $e['date'], 'memo' => $e['kind'] === 'payment' ? 'Meta card charge / top-up'.$note : $e['category'].$note, 'source' => $src, 'source_id' => (string) $id, 'lines' => $lines], $e['user_id']);
            Db::run('UPDATE mkt_spend SET posted=1, error=NULL WHERE id=?', $id);
        } catch (\Throwable $x) {
            Db::run('UPDATE mkt_spend SET posted=0, error=? WHERE id=?', $x->getMessage(), $id);
        }
    }

    private function postPending(): void
    {
        foreach (Db::all('SELECT id FROM mkt_spend WHERE posted=0 ORDER BY id LIMIT 200') as $e) {
            $this->postEntry($e['id']);
        }
        $c = $this->cfg();
        if (! self::jt($c['post']) || ! $this->accSvc()) {
            return;
        }
        $from = self::jt($c['postFrom']) ? $c['postFrom'] : substr($this->pkToday(), 0, 8).'01';
        $dates = array_column(Db::all('SELECT `date` FROM (SELECT DISTINCT `date` FROM mkt_daily UNION SELECT `date` FROM mkt_manual UNION SELECT `date` FROM mkt_posted) x WHERE `date`>=? ORDER BY `date`', $from), 'date');
        foreach ($dates as $d) {
            $this->postDay($d);
        }
    }

    /* ---------- numbers ---------- */

    /** service: spend / orders / delivery numbers for PK days [from, to] */
    public function stats($from, $to): array
    {
        $ad = Db::get('SELECT COALESCE(SUM(spend_pkr),0) spend, COALESCE(SUM(purchases),0) purchases, COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks FROM mkt_daily WHERE date BETWEEN ? AND ?', $from, $to);
        $man = Db::val('SELECT COALESCE(SUM(amount),0) s FROM mkt_manual WHERE date BETWEEN ? AND ?', $from, $to);
        $o = Db::get('SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders WHERE DATE(created_at + INTERVAL 5 HOUR) BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN '.self::CANCELLED, $from, $to);
        $d = Db::get("SELECT COUNT(*) dispatched, COALESCE(SUM(status='delivered'),0) delivered, COALESCE(SUM(status IN ".self::RETURNED.'),0) returned,
      COALESCE(SUM(CASE WHEN status=\'delivered\' THEN total-COALESCE(shipping,0) ELSE 0 END),0) net
    FROM orders WHERE dispatched_at IS NOT NULL AND DATE(dispatched_at + INTERVAL 5 HOUR) BETWEEN ? AND ?', $from, $to);
        $spend = self::r2($ad['spend'] + $man);
        $dr = $d['delivered'] + $d['returned'];
        return ['from' => $from, 'to' => $to, 'spend' => $spend, 'manual' => self::r2($man), 'metaPurchases' => $ad['purchases'], 'impressions' => $ad['impressions'], 'clicks' => $ad['clicks'], 'orders' => $o['n'], 'orderValue' => $o['v'],
            'cpo' => $o['n'] && $spend ? self::r2($spend / $o['n']) : null, 'dispatched' => $d['dispatched'], 'delivered' => $d['delivered'], 'returned' => $d['returned'], 'pending' => $d['dispatched'] - $d['delivered'] - $d['returned'],
            'deliveryRate' => $dr ? Logic::jsRound(1000 * $d['delivered'] / $dr) / 10 : null,
            'cpd' => $d['delivered'] && $spend ? self::r2($spend / $d['delivered']) : null, 'netSales' => self::r2($d['net']), 'roas' => $spend && $dr ? Logic::jsRound(100 * $d['net'] / $spend) / 100 : null, 'gap' => $ad['purchases'] - $o['n']];
    }

    private function campaigns(string $from, string $to): array
    {
        $c = $this->cfg();
        $avg = Db::get('SELECT SUM(spend_pkr) s, SUM(purchases) p FROM mkt_daily WHERE date BETWEEN ? AND ?', $from, $to);
        $avgCpp = self::jt($avg['p']) ? $avg['s'] / $avg['p'] : null;
        $t = $this->pkToday();
        $last3 = self::addDays($t, -2);
        $thr = self::num($c['zeroThreshold']);
        $thr = self::jt($thr) ? $thr : 15000;
        return array_map(function ($r) use ($avgCpp, $t, $thr) {
            $cpp = self::jt($r['purchases']) ? self::r2($r['spend'] / $r['purchases']) : null;
            $flag = 'ok';
            $why = 'Normal';
            if ($r['spend3'] > $thr && ! self::jt($r['purch3'])) {
                $flag = 'bad';
                $why = 'No sales in 3 days';
            } elseif ($r['spend'] > $thr && ! self::jt($r['purchases'])) {
                $flag = 'bad';
                $why = 'No sales';
            } elseif (self::jt($cpp) && self::jt($avgCpp) && $cpp > $avgCpp * 1.5) {
                $flag = 'warn';
                $why = 'Costly';
            } elseif (self::jt($cpp) && self::jt($avgCpp) && $cpp < $avgCpp * 0.75) {
                $flag = 'good';
                $why = 'Best value';
            }
            if ($r['last_day'] < self::addDays($t, -1)) {
                $flag = $flag === 'bad' ? 'bad' : 'muted';
                $why = $flag === 'bad' ? $why : 'Not running';
            }
            return array_merge($r, ['spend' => self::r2($r['spend']), 'ctr' => self::jt($r['impressions']) ? Logic::jsRound(10000 * $r['clicks'] / $r['impressions']) / 100 : null, 'cpp' => $cpp,
                'metaRoas' => self::jt($r['spend_raw']) ? Logic::jsRound(100 * $r['value'] / $r['spend_raw']) / 100 : null, 'flag' => $flag, 'why' => $why]);
        }, Db::all('SELECT account_id, campaign_id, MAX(campaign_name) name, SUM(spend) spend_raw, SUM(spend_pkr) spend, SUM(impressions) impressions, SUM(reach) reach, SUM(clicks) clicks,
      SUM(purchases) purchases, SUM(purchase_value) value, MAX(date) last_day, SUM(CASE WHEN date>=? THEN spend_pkr ELSE 0 END) spend3, SUM(CASE WHEN date>=? THEN purchases ELSE 0 END) purch3
    FROM mkt_daily WHERE date BETWEEN ? AND ? GROUP BY account_id, campaign_id HAVING SUM(spend)>0 OR SUM(impressions)>0 ORDER BY spend DESC', $last3, $last3, $from, $to));
    }

    private function daily(int $days): array
    {
        $to = $this->pkToday();
        $from = self::addDays($to, -($days - 1));
        $sp = [];
        foreach (Db::all('SELECT date, SUM(spend_pkr) s, SUM(purchases) p FROM mkt_daily WHERE date BETWEEN ? AND ? GROUP BY date', $from, $to) as $r) {
            $sp[$r['date']] = $r;
        }
        $man = [];
        foreach (Db::all('SELECT date, amount FROM mkt_manual WHERE date BETWEEN ? AND ?', $from, $to) as $r) {
            $man[$r['date']] = $r['amount'];
        }
        $od = [];
        foreach (Db::all('SELECT DATE(created_at + INTERVAL 5 HOUR) d, COUNT(*) n FROM orders WHERE DATE(created_at + INTERVAL 5 HOUR) BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN '.self::CANCELLED.' GROUP BY d', $from, $to) as $r) {
            $od[$r['d']] = $r['n'];
        }
        $out = [];
        for ($d = $from; $d <= $to; $d = self::addDays($d, 1)) {
            $s = self::r2((isset($sp[$d]) ? $sp[$d]['s'] : 0) + (self::jt($man[$d] ?? null) ? $man[$d] : 0));
            $o = self::jt($od[$d] ?? null) ? $od[$d] : 0;
            $out[] = ['day' => $d, 'spend' => $s, 'orders' => $o, 'purchases' => isset($sp[$d]) ? $sp[$d]['p'] : 0, 'cpo' => $o && $s ? self::r2($s / $o) : null];
        }
        return $out;
    }

    private function monthly(int $months): array
    {
        $t = $this->pkToday();
        $out = [];
        $y = (int) substr($t, 0, 4);
        $m = (int) substr($t, 5, 2);
        for ($i = 0; $i < $months; $i++) {
            $ym = sprintf('%d-%02d', $y, $m);
            $from = $ym.'-01';
            $last = self::addDays(sprintf('%d-%02d-01', $m === 12 ? $y + 1 : $y, $m === 12 ? 1 : $m + 1), -1);
            $s = $this->stats($from, $last < $t ? $last : $t);
            $other = Db::val("SELECT COALESCE(SUM(amount),0) s FROM mkt_spend WHERE kind='other' AND date BETWEEN ? AND ?", $from, $last);
            $paid = Db::val("SELECT COALESCE(SUM(amount),0) s FROM mkt_spend WHERE kind='payment' AND date BETWEEN ? AND ?", $from, $last);
            if (self::jt($s['spend']) || self::jt($s['orders']) || self::jt($other)) {
                $out[] = array_merge(['month' => $ym], $s, ['other' => $other, 'paid' => $paid]);
            }
            if (--$m === 0) {
                $m = 12;
                $y--;
            }
        }
        return $out;
    }

    private function canSettings(?array $u): bool
    {
        return $this->can($u, 'settings') || ($this->can($u, 'marketing') && in_array($u['role'] ?? null, ['admin', 'manager'], true));
    }

    private function safeCfg(array $c): array
    {
        $tok = self::jt($c['token'] ?? null) ? (string) $c['token'] : '';
        unset($c['token']);
        $c['hasToken'] = $tok !== '';
        $c['tokenHint'] = $tok !== '' ? '••••'.substr($tok, -4) : '';
        $c['accountInfo'] = array_map(function ($a) use ($c) {
            $r = $this->acctRow($a) ?: [];
            $used = $this->acctCur($c, $a);
            return ['id' => $a, 'name' => self::jt($r['name'] ?? null) ? $r['name'] : '', 'currency' => self::jt($r['currency'] ?? null) ? $r['currency'] : '', 'override' => self::jt($r['override'] ?? null) ? $r['override'] : '',
                'status' => self::jt($r['status'] ?? null) ? $r['status'] : '', 'checked_at' => self::jt($r['checked_at'] ?? null) ? $r['checked_at'] : null, 'used' => $used, 'rate' => $this->rateFor($c, $used)];
        }, $c['accounts'] ?: []);
        return $c;
    }

    /** service: home page numbers */
    public function summary(): array
    {
        $t = $this->pkToday();
        $m = $this->stats(substr($t, 0, 8).'01', $t);
        return ['spendToday' => $this->stats($t, $t)['spend'], 'spendMTD' => $m['spend'], 'ordersMTD' => $m['orders'], 'cpo' => $m['cpo'], 'roas' => $m['roas'], 'connected' => $this->connected()];
    }

    /* ======================================================================
     * routes
     * ==================================================================== */

    public function routes(Router $r): void
    {
        $r->get('/api/marketing/settings', 'marketing', 'settingsGet');
        $r->post('/api/marketing/settings', 'marketing', 'settingsSave');
        $r->post('/api/marketing/test', 'marketing', 'testRoute');
        $r->post('/api/marketing/sync', 'marketing', 'syncRoute');
        $r->get('/api/marketing/status', 'marketing', 'statusRoute');
        $r->get('/api/marketing/dashboard', 'marketing', 'dashboard');
        $r->get('/api/marketing/campaigns', 'marketing', 'campaignsRoute');
        $r->get('/api/marketing/monthly', 'marketing', 'monthlyRoute');
        // manual daily spend (no token) + other marketing spend + Meta card payments
        $r->get('/api/marketing/spend', 'marketing', 'spendRoute');
        $r->post('/api/marketing/manual', 'marketing', 'manualSave');
        $r->delete('/api/marketing/manual/:date', 'marketing', 'manualDelete');
        $r->post('/api/marketing/payment', 'marketing', 'paymentRoute');
        $r->post('/api/marketing/other', 'marketing', 'otherRoute');
        $r->delete('/api/marketing/entry/:id', 'marketing', 'entryDelete');
        $r->post('/api/marketing/repost', 'marketing', 'repost');
    }

    public function settingsGet(?array $u): array
    {
        $this->need($this->canSettings($u), 'Only the owner or a manager can see Meta settings', 403);
        return ['settings' => $this->safeCfg($this->cfg()), 'status' => self::obj($this->status()), 'banks' => self::BANKS, 'accountsReady' => (bool) $this->accSvc()];
    }

    private static function splitAccounts($v): array
    {
        $list = is_array($v) && array_is_list($v) ? $v : preg_split('/[\s,]+/', self::str($v));
        return array_values(array_filter(array_map(fn ($a) => self::normAct($a), $list), fn ($a) => $a !== ''));
    }

    public function settingsSave(?array $u, array $b): array
    {
        $this->need($this->canSettings($u), 'Only the owner or a manager can change Meta settings', 403);
        $cur = $this->cfg();
        $n = $cur;
        if (isset($b['token']) && trim(self::str($b['token'])) !== '') {
            $n['token'] = trim(self::str($b['token']));
        }
        if (self::jt($b['clearToken'] ?? null)) {
            $n['token'] = '';
        }
        if (isset($b['accounts'])) {
            $n['accounts'] = array_values(array_unique(self::splitAccounts($b['accounts'])));
        }
        if (self::jt($b['version'] ?? null)) {
            $this->need(preg_match('/^v\d+\.\d+$/', self::str($b['version'])), 'API version looks like v21.0');
            $n['version'] = $b['version'];
        }
        if (self::jt($b['currency'] ?? null)) {
            $this->need(in_array($b['currency'], ['PKR', 'USD'], true), 'Currency must be PKR or USD');
            $n['currency'] = $b['currency'];
        }
        foreach (['fx', 'cardPct', 'dailyBudget', 'zeroThreshold'] as $k) {
            if (isset($b[$k]) && $b[$k] !== '') {
                $v = self::num($b[$k]);
                $this->need(is_finite((float) $v) && $v >= 0, $k.' must be a number');
                $n[$k] = $v;
            }
        }
        if (isset($b['overrides']) && is_array($b['overrides'])) {
            foreach ($b['overrides'] as $a0 => $v) {
                $a = self::normAct((string) $a0);
                $cur2 = strtoupper(self::jt($v) ? self::str($v) : '');
                $this->need($cur2 === '' || preg_match('/^[A-Z]{3}$/', $cur2), 'Currency must be like PKR or USD');
                Db::run('INSERT INTO mkt_accounts(id,override) VALUES(?,?) ON DUPLICATE KEY UPDATE override=VALUES(override)', $a, $cur2 !== '' ? $cur2 : null);
            }
        }
        foreach ($n['accounts'] as $a) {
            Db::run('INSERT IGNORE INTO mkt_accounts(id) VALUES(?)', $a);
        }
        $allPkr = true;
        foreach ($n['accounts'] as $a) {
            if ($this->acctCur($n, $a) !== 'PKR') {
                $allPkr = false;
            }
        }
        $this->need($allPkr || self::num($n['fx']) > 0, 'Enter the USD → PKR exchange rate');
        if (isset($b['post'])) {
            $n['post'] = self::jt($b['post']);
        }
        if (self::jt($b['creditAccount'] ?? null)) {
            $n['creditAccount'] = trim(self::str($b['creditAccount']));
        }
        if (isset($b['postFrom'])) {
            $this->need(! self::jt($b['postFrom']) || preg_match('/^\d{4}-\d{2}-\d{2}$/', self::str($b['postFrom'])), 'Bad date');
            $n['postFrom'] = $b['postFrom'];
        }
        if (self::jt($n['post']) && ! self::jt($cur['post']) && ! self::jt($n['postFrom'])) {
            $n['postFrom'] = substr($this->pkToday(), 0, 8).'01';
        }
        $this->setSetting('marketing', $n);
        $this->log($u['id'], 'marketing.settings', 'meta', ['accounts' => $n['accounts'], 'currency' => $n['currency'], 'post' => $n['post'], 'tokenChanged' => $n['token'] !== $cur['token']]);
        if (self::jt($n['post'])) {
            try {
                $this->postPending();
            } catch (\Throwable) {
            }
        }
        return ['ok' => true, 'settings' => $this->safeCfg($n)];
    }

    public function testRoute(?array $u, array $b): array
    {
        $this->need($this->canSettings($u), 'Not allowed', 403);
        $k = $this->cfg();
        if (self::jt($b['token'] ?? null)) {
            $k['token'] = trim(self::str($b['token']));
        }
        if (self::jt($b['accounts'] ?? null)) {
            $k['accounts'] = self::splitAccounts($b['accounts']);
        }
        $this->need(self::jt($k['token']), 'Paste the access token first');
        $this->need(count($k['accounts']) > 0, 'Add at least one ad account id (act_…)');
        try {
            return ['ok' => true, 'accounts' => $this->testConnection($k)];
        } catch (\Throwable $e) {
            throw new HttpError(400, $e->getMessage());
        }
    }

    public function syncRoute(?array $u, array $b): array
    {
        $this->need($this->canSettings($u) || $this->can($u, 'marketing'), 'Not allowed', 403);
        $d = self::num($b['days'] ?? null);
        $days = min(400, max(1, self::jt($d) ? (int) $d : 3));
        try {
            return $this->sync($days, $u['id']);
        } catch (\Throwable $e) {
            throw new HttpError(400, $e->getMessage());
        }
    }

    public function statusRoute(?array $u): array
    {
        return ['connected' => $this->connected(), 'status' => self::obj($this->status()), 'running' => $this->isRunning(),
            'log' => Db::all("SELECT at, ok, message FROM sync_log WHERE kind='meta' ORDER BY id DESC LIMIT 10"), 'lastData' => Db::get('SELECT MAX(date) d, MAX(synced_at) s FROM mkt_daily') ?: new \stdClass];
    }

    public function dashboard(?array $u): array
    {
        $t = $this->pkToday();
        $y = self::addDays($t, -1);
        return [
            'today' => $t, 'connected' => $this->connected(), 'status' => self::obj($this->status()), 'canSettings' => $this->canSettings($u), 'post' => $this->cfg()['post'],
            'periods' => ['today' => $this->stats($t, $t), 'yesterday' => $this->stats($y, $y), 'last7' => $this->stats(self::addDays($t, -6), $t), 'month' => $this->stats(substr($t, 0, 8).'01', $t)],
            'avg30' => $this->stats(self::addDays($t, -30), self::addDays($t, -1)), 'daily' => $this->daily(30), 'top' => array_slice($this->campaigns(self::addDays($t, -6), $t), 0, 6),
            'hasData' => (bool) Db::get('SELECT 1 FROM mkt_daily LIMIT 1') || (bool) Db::get('SELECT 1 FROM mkt_manual LIMIT 1'),
        ];
    }

    public function campaignsRoute(?array $u, array $b, array $p, array $qs): array
    {
        $t = $this->pkToday();
        $from = $qs['from'] ?? null;
        $to = self::jt($qs['to'] ?? null) ? $qs['to'] : $t;
        if (! self::jt($from)) {
            $dn = self::num($qs['days'] ?? null);
            $from = ($qs['range'] ?? null) === 'mtd' ? substr($t, 0, 8).'01' : self::addDays($t, -((self::jt($dn) ? (int) $dn : 7) - 1));
        }
        return ['from' => $from, 'to' => $to, 'rows' => $this->campaigns((string) $from, (string) $to), 'totals' => $this->stats($from, $to), 'threshold' => $this->cfg()['zeroThreshold']];
    }

    public function monthlyRoute(?array $u, array $b, array $p, array $qs): array
    {
        $m = self::num($qs['months'] ?? null);
        return $this->monthly((int) min(24, self::jt($m) ? $m : 12));
    }

    public function spendRoute(?array $u, array $b, array $p, array $qs): array
    {
        $m = isset($qs['month']) && is_string($qs['month']) && preg_match('/^\d{4}-\d{2}$/', $qs['month']) ? $qs['month'] : substr($this->pkToday(), 0, 7);
        $c = $this->cfg();
        return ['month' => $m, 'banks' => self::BANKS, 'cats' => self::OTHER_CATS, 'connected' => $this->connected($c), 'post' => $c['post'], 'accountsReady' => (bool) $this->accSvc(),
            'manual' => Db::all('SELECT m.*, u.name `user` FROM mkt_manual m LEFT JOIN users u ON u.id=m.user_id WHERE SUBSTR(m.date,1,7)=? ORDER BY m.date DESC', $m),
            'entries' => Db::all('SELECT s.*, u.name `user` FROM mkt_spend s LEFT JOIN users u ON u.id=s.user_id WHERE SUBSTR(s.date,1,7)=? ORDER BY s.date DESC, s.id DESC', $m),
            'posted' => Db::all('SELECT * FROM mkt_posted WHERE SUBSTR(date,1,7)=? ORDER BY date DESC', $m),
            'meta' => Db::all('SELECT date, SUM(spend_pkr) spend FROM mkt_daily WHERE SUBSTR(date,1,7)=? GROUP BY date ORDER BY date DESC', $m)];
    }

    private function okDate($d): bool
    {
        return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && $d <= self::addDays($this->pkToday(), 1);
    }

    public function manualSave(?array $u, array $b): array
    {
        $this->need($this->okDate($b['date'] ?? null), 'Pick a valid date (not in the future)');
        $this->need(self::num($b['amount'] ?? null) > 0, 'Enter the amount in rupees');
        Db::run('INSERT INTO mkt_manual(date,amount,note,user_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount), note=VALUES(note), user_id=VALUES(user_id), at=UTC_TIMESTAMP()',
            $b['date'], self::r2($b['amount']), mb_substr(self::jt($b['note'] ?? null) ? self::str($b['note']) : '', 0, 300), $u['id']);
        $this->log($u['id'], 'marketing.manual', 'mkt_manual:'.$b['date'], ['amount' => self::num($b['amount'])]);
        return ['ok' => true, 'posted' => $this->postDay($b['date'])];
    }

    public function manualDelete(?array $u, array $b, array $p): array
    {
        $this->need(Db::run('DELETE FROM mkt_manual WHERE date=?', $p['date'])->changes, 'Not found', 404);
        $this->log($u['id'], 'marketing.manual.delete', 'mkt_manual:'.$p['date'], null);
        $this->postDay((string) $p['date']);
        return ['ok' => true];
    }

    private function addEntry(string $kind, array $u, array $b): ?array
    {
        $this->need($this->okDate($b['date'] ?? null), 'Pick a valid date');
        $this->need(self::num($b['amount'] ?? null) > 0, 'Enter the amount in rupees');
        $bank = self::jt($b['bank'] ?? null) ? $b['bank'] : 'Meezan (SB)';
        $credit = $this->cfg()['creditAccount'];
        $this->need(in_array($bank, self::BANKS, true) || ($kind === 'other' && $bank === (self::jt($credit) ? $credit : 'Meta Ads Payable')), 'Paid from which account? '.implode(', ', self::BANKS));
        $cat = $kind === 'payment' ? 'Meta payment' : (self::jt($b['category'] ?? null) ? $b['category'] : 'Other');
        $id = Db::run('INSERT INTO mkt_spend(date,kind,category,amount,bank,note,file_id,user_id) VALUES(?,?,?,?,?,?,?,?)', $b['date'], $kind, mb_substr(self::str($cat), 0, 60), self::r2($b['amount']), $bank,
            mb_substr(self::jt($b['note'] ?? null) ? self::str($b['note']) : '', 0, 300), self::jt($b['file'] ?? null) ? $b['file'] : null, $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'marketing.'.$kind, 'mkt_spend:'.$id, ['amount' => self::num($b['amount']), 'category' => $cat, 'bank' => $bank]);
        $this->postEntry($id);
        return Db::get('SELECT * FROM mkt_spend WHERE id=?', $id);
    }

    public function paymentRoute(?array $u, array $b): ?array
    {
        return $this->addEntry('payment', $u, $b);
    }

    public function otherRoute(?array $u, array $b): ?array
    {
        return $this->addEntry('other', $u, $b);
    }

    public function entryDelete(?array $u, array $b, array $p): array
    {
        $e = Db::get('SELECT * FROM mkt_spend WHERE id=?', (int) $p['id']);
        $this->need($e, 'Not found', 404);
        $acc = $this->accSvc();
        if (self::jt($e['posted']) && $acc && method_exists($acc, 'void')) {
            try {
                $acc->void($e['kind'] === 'payment' ? 'meta_pay' : 'mkt_other', (string) $e['id'], $u['id']);
            } catch (\Throwable $x) {
                $this->need(false, 'Could not remove it from accounts: '.$x->getMessage());
            }
        }
        Db::run('DELETE FROM mkt_spend WHERE id=?', $e['id']);
        $this->log($u['id'], 'marketing.entry.delete', 'mkt_spend:'.$e['id'], ['amount' => $e['amount']]);
        return ['ok' => true];
    }

    public function repost(?array $u): array
    {
        $this->need($this->canSettings($u), 'Not allowed', 403);
        $this->postPending();
        return ['ok' => true, 'accountsReady' => (bool) $this->accSvc()];
    }

    /* ---------- jobs ---------- */
    public function jobs(): array
    {
        return [
            ['name' => 'meta-sync', 'every' => 180, 'offset' => 7, 'run' => function () {
                if ($this->connected()) {
                    try {
                        $this->sync(3, null);
                    } catch (\Throwable) {
                    }
                }
                $this->postPending();
            }],
            ['name' => 'meta-post', 'every' => 60, 'offset' => 33, 'run' => fn () => $this->postPending()],
        ];
    }

    public function alerts(array $u): array
    {
        if (! $this->can($u, 'marketing')) {
            return [];
        }
        $out = [];
        $k = $this->cfg();
        $st = $this->status();
        $t = $this->pkToday();
        if ($this->connected($k)) {
            $lastOk = self::jt($st['lastOk'] ?? null) ? strtotime($st['lastOk']) : 0;
            if (self::jt($st['lastError'] ?? null) && (! $lastOk || strtotime((string) ($st['lastErrorAt'] ?? '')) > $lastOk)) {
                $out[] = ['level' => 'bad', 'text' => 'Meta ad spend sync is failing: '.$st['lastError'], 'href' => '#/marketing/settings'];
            } elseif (! $lastOk || time() - $lastOk > 24 * 3600) {
                $out[] = ['level' => 'warn', 'text' => 'No Meta ad spend received for more than 24 hours', 'href' => '#/marketing/settings'];
            }
        }
        $today = $this->stats($t, $t);
        $budget = self::num($k['dailyBudget']);
        if ($budget > 0 && $today['spend'] > $budget) {
            $out[] = ['level' => 'warn', 'text' => 'Ad spend today '.self::loc(Logic::jsRound($today['spend'])).' is above the daily budget of Rs '.self::loc($budget), 'href' => '#/marketing'];
        }
        $thr = self::num($k['zeroThreshold']);
        $thr = self::jt($thr) ? $thr : 15000;
        foreach (Db::all('SELECT MAX(campaign_name) name, SUM(spend_pkr) s FROM mkt_daily WHERE date>=? GROUP BY account_id, campaign_id HAVING SUM(spend_pkr)>? AND SUM(purchases)=0 ORDER BY s DESC LIMIT 5', self::addDays($t, -2), $thr) as $r) {
            $out[] = ['level' => 'warn', 'text' => 'Campaign "'.$r['name'].'" spent Rs '.self::loc(Logic::jsRound($r['s'])).' in 3 days with no purchases', 'href' => '#/campaigns'];
        }
        $avg = $this->stats(self::addDays($t, -30), self::addDays($t, -1));
        if ($today['cpo'] && $avg['cpo'] && $today['orders'] >= 3 && $today['cpo'] > 1.5 * $avg['cpo']) {
            $out[] = ['level' => 'warn', 'text' => 'Cost per order today Rs '.self::loc(Logic::jsRound($today['cpo'])).' is more than 1.5× the 30-day average (Rs '.self::loc(Logic::jsRound($avg['cpo'])).')', 'href' => '#/marketing'];
        }
        return $out;
    }
}
