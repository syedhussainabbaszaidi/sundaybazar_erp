<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Database\QueryException;
use Illuminate\Http\Request;

/**
 * Stock line — every pair from the lot to the rack: GRN → sorting → QC → listed → photo → edited → uploaded → handed over → received in warehouse → located.
 * Port of legacy/server/modules/stockline.js.
 *
 * Lot-level steps (sorting, QC) are counts per lot; from listing on, each pair (SKU) has its own row in sl_items with a timestamp + user per step.
 * Stage rules: listed = a listings row exists (since trackFrom) · uploaded = SKU appears in core products (Shopify sync) or marked by hand ·
 * located = core locations has a real slot for it (written by the warehouse receive through the WMS put-away, or any WMS put-away after listing).
 * Marking a later step fills earlier missing ones (user unknown), so a pair never waits in two queues.
 *
 * Services (ctx.services.stockline): summary(), stage($sku), extraBad($lot), sync(), board($lot = '').
 */
class StocklineModule extends Module
{
    public string $name = 'stockline';

    private const PR = 'App\\Erp\\Core\\Pricing';

    private const PAIR = [['listed', 'listed_at', 'Listed', 'photo'], ['photo', 'photo_at', 'Photo done', 'editing'], ['edited', 'edited_at', 'Edited', 'upload'], ['uploaded', 'uploaded_at', 'Uploaded', 'handover to warehouse'],
        ['handed', 'handed_at', 'Handed over', 'warehouse to receive'], ['inwh', 'received_at', 'Received in warehouse', 'a location'], ['located', 'located_at', 'Located', null]];

    private const LOTST = [['grn', 'Received (GRN)', 'sorting'], ['sorted', 'Sorted', 'QC check'], ['qc', 'QC passed', 'listing']];

    private const REJECT = ['torn', 'sole', 'stain', 'mismatched', 'fake'];

    private const NOT_SLOT = "('DAMAGED','OUTLET','REPAIR','SUPPLIER','STUDIO','MISSING','RETURNS','')";

    private const STAGE_SQL = "CASE WHEN located_at IS NOT NULL THEN 'located' WHEN received_at IS NOT NULL THEN 'inwh' WHEN handed_at IS NOT NULL THEN 'handed' WHEN uploaded_at IS NOT NULL THEN 'uploaded'
  WHEN edited_at IS NOT NULL THEN 'edited' WHEN photo_at IS NOT NULL THEN 'photo' ELSE 'listed' END";

    private const QUEUE = [
        'photo' => ['photo_at IS NULL AND uploaded_at IS NULL AND located_at IS NULL', 'i.listed_at'],
        'edit' => ['photo_at IS NOT NULL AND edited_at IS NULL AND uploaded_at IS NULL AND located_at IS NULL', 'i.photo_at'],
        'upload' => ['edited_at IS NOT NULL AND uploaded_at IS NULL', 'i.edited_at'],
        'handover' => ['handed_at IS NULL AND located_at IS NULL', 'COALESCE(i.uploaded_at, i.listed_at)'],
    ];

    private const MARK = [
        'photo' => ['photo_at', 'photo_by', 'photo_batch', 'sl.photo', []],
        'edit' => ['edited_at', 'edited_by', 'edit_batch', 'sl.edited', ['photo_at']],
        'upload' => ['uploaded_at', 'uploaded_by', 'upload_batch', 'sl.uploaded', ['photo_at', 'edited_at']],
    ];

    private const ITEM_COLS = 'i.sku, i.lot, i.title, i.stage, i.grade, i.pref_loc, i.listed_at, i.photo_at, i.edited_at, i.uploaded_at, i.upload_src, i.handed_at, i.handover_id, us.name lister,
      (SELECT p.status FROM products p WHERE p.sku=i.sku LIMIT 1) shop_status';

    /** Used only when the Pricing kernel class (lib/pricing.js port) is missing: PR.CONDS and PR.types() of the original. */
    private const FALLBACK_CONDS = ['Like New', 'Premium', 'Excellent', 'Very Good', 'Good'];

    private const FALLBACK_TYPES = ['Bags', 'Block Ankle Boots', 'Block Heels', 'Boots', 'Casual', 'Chelsea Ankle Boots', 'Combat Ankle Boots', 'Flats', 'Formals', 'Kitten Heels', 'Loafers',
        'Long Boots', 'Mules', 'Pumps', 'Running', 'Sandals', 'Slides', 'Sports', 'Stilettos', 'Stilettos Ankle Boots', 'Wedges'];

    /** ms timestamp of the last sync (module-level `lastSync` of the original) */
    private static float $lastSync = 0;

    public function perms(): array
    {
        return [];
    }

    public function activity(): array
    {
        return ['sl.sorted' => 'Sorted lot', 'sl.qc' => 'QC checked pairs', 'sl.photo' => 'Photo done', 'sl.edited' => 'Edited pictures', 'sl.uploaded' => 'Uploaded to Shopify',
            'sl.handover' => 'Handed over pair', 'sl.received' => 'Received pair from listing', 'sl.located' => 'Put pair on location', 'sl.handover.close' => 'Finished handover receive'];
    }

    /** pairs listed up to two weeks before this module was installed are still followed; older listings are history */
    public function install(): void
    {
        if (! self::truthy($this->setting('stockline.trackFrom', ''))) {
            $this->setSetting('stockline.trackFrom', gmdate('Y-m-d H:i:s', time() - 14 * 86400));
        }
    }

    public function routes(Router $r): void
    {
        $r->get('/api/sl/lots', 'dashboard', 'lotsList');
        $r->get('/api/sl/lots/:name', 'dashboard', 'lotShow');
        $r->post('/api/sl/lots/:name/sort', 'dashboard', 'lotSort');
        $r->post('/api/sl/lots/:name/qc', 'dashboard', 'lotQc');
        $r->get('/api/sl/queue/:kind', 'dashboard', 'queueList');
        $r->post('/api/sl/mark', 'dashboard', 'mark');
        $r->get('/api/sl/upload/check', 'dashboard', 'uploadCheck');
        $r->get('/api/sl/pair/:sku', 'dashboard', 'pairShow');
        $r->post('/api/sl/pair/:sku/location', 'dashboard', 'pairLocation');
        $r->post('/api/sl/handovers/check', 'dashboard', 'handoverCheck');
        $r->post('/api/sl/handovers', 'dashboard', 'handoverCreate');
        $r->get('/api/sl/handovers', 'dashboard', 'handoversList');
        $r->get('/api/sl/handovers/:id', 'dashboard', 'handoverShow');
        $r->post('/api/sl/handovers/:id/scan', 'dashboard', 'handoverScan');
        $r->post('/api/sl/handovers/:id/locate', 'dashboard', 'handoverLocate');
        $r->post('/api/sl/handovers/:id/locate-all', 'dashboard', 'handoverLocateAll');
        $r->post('/api/sl/handovers/:id/close', 'dashboard', 'handoverClose');
        $r->get('/api/sl/board', 'dashboard', 'boardRoute');
        $r->get('/api/sl/stage/:k', 'dashboard', 'stageList');
        $r->get('/api/sl/settings', 'dashboard', 'settingsGet');
        $r->post('/api/sl/settings', 'dashboard', 'settingsSave');
    }

    public function jobs(): array
    {
        return [['name' => 'sync', 'every' => 5, 'offset' => 2, 'run' => fn () => $this->doSync(true)]];
    }

    /* ================================================================ JS helpers */

    private static function up($s): string
    {
        if ($s === null) {
            return '';
        }
        if (is_bool($s)) {
            $s = $s ? 'true' : 'false';
        } elseif (is_float($s)) {
            $s = (floor($s) == $s && abs($s) < 1e15) ? (string) (int) $s : (string) $s;
        } elseif (is_array($s)) {
            $s = implode(',', array_map(fn ($x) => is_array($x) || $x === null ? '' : (string) $x, $s));
        }
        return mb_strtoupper(trim((string) $s));
    }

    private static function truthy($v): bool
    {
        if ($v === null || $v === false || $v === '') {
            return false;
        }
        if (is_int($v)) {
            return $v !== 0;
        }
        if (is_float($v)) {
            return $v != 0.0 && ! is_nan($v);
        }
        return true;
    }

    private static function or($a, $b)
    {
        return self::truthy($a) ? $a : $b;
    }

    private static function num($v)
    {
        if ($v === null || $v === false) {
            return 0;
        }
        if ($v === true) {
            return 1;
        }
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if (is_string($v)) {
            $t = trim($v);
            if ($t === '') {
                return 0;
            }
            return is_numeric($t) ? $t + 0 : NAN;
        }
        if (is_array($v)) {
            return ! $v ? 0 : (count($v) === 1 && ! is_array(reset($v)) ? self::num(reset($v)) : NAN);
        }
        return NAN;
    }

    /** +v || 0 */
    private static function n0($v)
    {
        $n = self::num($v);
        return self::truthy($n) ? $n : 0;
    }

    /** String(v || '') */
    private static function str($v): string
    {
        if (! self::truthy($v)) {
            return '';
        }
        if (is_bool($v)) {
            return 'true';
        }
        if (is_array($v)) {
            return self::up($v) === '' ? '' : implode(',', array_map(fn ($x) => is_array($x) ? '' : (string) $x, $v));
        }
        return (string) $v;
    }

    private static function nowUtc(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /** days since a 'Y-m-d H:i:s' (UTC) or ISO value; null when empty, NAN when unreadable */
    private static function ageDays($at)
    {
        if (! self::truthy($at)) {
            return null;
        }
        $s = (string) $at;
        $t = strtotime(str_contains($s, 'Z') ? $s : $s.' UTC');
        if ($t === false) {
            return NAN;
        }
        return (microtime(true) - $t) / 86400;
    }

    /** Math.floor(x): null → 0, NaN → null (JSON of NaN) */
    private static function jsFloor($v): ?int
    {
        if ($v === null) {
            return 0;
        }
        if (is_float($v) && is_nan($v)) {
            return null;
        }
        return (int) floor($v);
    }

    private static function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    /** property of an array or object (other modules' service results) */
    private static function pv($o, string $k)
    {
        if (is_array($o)) {
            return $o[$k] ?? null;
        }
        if (is_object($o)) {
            return $o->$k ?? null;
        }
        return null;
    }

    private static function skuList($list): array
    {
        return array_values(array_unique(array_filter(array_map([self::class, 'up'], is_array($list) ? $list : []), fn ($x) => $x !== '')));
    }

    /* ================================================================ shared helpers */

    private function S(): array
    {
        $s = $this->setting('stockline.settings', []);
        return array_merge(['stuckDays' => 2, 'unsortedDays' => 1, 'blockHandover' => false, 'trackFrom' => $this->setting('stockline.trackFrom', '')], is_array($s) ? $s : []);
    }

    private function anyOf(?array $u, string ...$p): bool
    {
        foreach ($p as $x) {
            if ($this->can($u, $x)) {
                return true;
            }
        }
        return false;
    }

    private function gate(?array $u, string ...$p): void
    {
        $this->need($this->anyOf($u, ...$p), 'Your account does not have access to this', 403);
    }

    private function wms(): ?Module
    {
        return $this->svc('wms');
    }

    /** W && W.SLOT_RE && W.SLOT_RE.test(s) */
    private function slotTest($s): bool
    {
        $W = $this->wms();
        return $W && method_exists($W, 'slotRe') && preg_match($W->slotRe(), (string) $s) === 1;
    }

    private function grnRow($name): ?array
    {
        try {
            return Db::get('SELECT * FROM wms_grn WHERE lot=?', $name);
        } catch (QueryException) {
            return null;
        }
    }

    private function uname($id): string
    {
        if (! self::truthy($id)) {
            return '';
        }
        return (string) (Db::val('SELECT name FROM users WHERE id=?', $id) ?? '');
    }

    /* ---------------- pricing (PR.* of the original) ---------------- */

    private function prTypes(): array
    {
        return class_exists(self::PR) && method_exists(self::PR, 'types') ? [self::PR, 'types']() : self::FALLBACK_TYPES;
    }

    private function prConds(): array
    {
        return class_exists(self::PR) && defined(self::PR.'::CONDS') ? constant(self::PR.'::CONDS') : self::FALLBACK_CONDS;
    }

    /** eng().lotPlan(l) — PR.engine({...PR.ECON_DEFAULTS, ...setting('list_econ')}).lotPlan(l) */
    private function lotPlan(array $l)
    {
        if (class_exists(self::PR) && method_exists(self::PR, 'engine')) {
            $def = defined(self::PR.'::ECON_DEFAULTS') ? constant(self::PR.'::ECON_DEFAULTS') : [];
            $econ = $this->setting('list_econ', []);
            $eng = [self::PR, 'engine'](array_merge($def, is_array($econ) ? $econ : []));
            if (is_object($eng) && method_exists($eng, 'lotPlan')) {
                return $eng->lotPlan($l);
            }
            if (is_object($eng) && isset($eng->lotPlan) && is_callable($eng->lotPlan)) {
                return ($eng->lotPlan)($l);
            }
            if (is_array($eng) && isset($eng['lotPlan']) && is_callable($eng['lotPlan'])) {
                return $eng['lotPlan']($l);
            }
        }
        // Pricing kernel not available: only the plain per good pair cost (cpv needs the price model)
        $ok = self::n0($l['pieces']) - self::n0($l['bad']);
        $total = self::n0($l['cost']) + self::n0($l['extra']);
        return ['ok' => $ok, 'per_piece' => $ok > 0 ? Logic::jsRound($total / $ok) : 0, 'cpv' => 0];
    }

    /* ================================================================ sync: keep the per-pair stages in step */

    private function tx(callable $fn)
    {
        return Db::tx($fn); // nested calls join the open transaction (savepoint)
    }

    private function restage(string $where = '1=1', ...$a): void
    {
        Db::run('UPDATE sl_items SET stage='.self::STAGE_SQL.", updated_at=UTC_TIMESTAMP() WHERE {$where}", ...$a);
    }

    private function doSync(bool $force = false): void
    {
        $now = floor(microtime(true) * 1000);
        if (! $force && $now - self::$lastSync < 5000) {
            return;
        }
        self::$lastSync = $now;
        $trackFrom = $this->S()['trackFrom'];
        $this->tx(function () use ($trackFrom) {
            Db::run('INSERT IGNORE INTO sl_items(sku,lot,title,grade,listed_at,listed_by) SELECT sku, lot, title, cond, at, user_id FROM listings WHERE at>=?', $trackFrom);
            Db::run('DELETE FROM sl_items WHERE handed_at IS NULL AND located_at IS NULL AND sku NOT IN (SELECT sku FROM listings)');
            // live on Shopify (core products, synced by SKU) → uploaded
            Db::run("UPDATE sl_items SET upload_src='shopify', uploaded_at=GREATEST(listed_at, COALESCE((SELECT MIN(p.created_at) FROM products p WHERE p.sku=sl_items.sku), UTC_TIMESTAMP()))
                WHERE uploaded_at IS NULL AND EXISTS(SELECT 1 FROM products p WHERE p.sku=sl_items.sku)");
            Db::run('UPDATE sl_items SET photo_at=COALESCE(photo_at,uploaded_at), edited_at=COALESCE(edited_at,uploaded_at) WHERE uploaded_at IS NOT NULL AND (photo_at IS NULL OR edited_at IS NULL)');
            // a real slot in core locations, set after the pair was listed → located
            Db::run('UPDATE sl_items SET located_at=(SELECT COALESCE(l.updated_at,UTC_TIMESTAMP()) FROM locations l WHERE l.sku=sl_items.sku), location=(SELECT l.location FROM locations l WHERE l.sku=sl_items.sku)
                WHERE located_at IS NULL AND EXISTS(SELECT 1 FROM locations l WHERE l.sku=sl_items.sku AND UPPER(COALESCE(l.location,\'\')) NOT IN '.self::NOT_SLOT." AND l.location NOT LIKE 'TRANSIT-%' AND (l.updated_at IS NULL OR l.updated_at >= sl_items.listed_at))");
            $this->restage('stage <> '.self::STAGE_SQL);
        });
    }

    /** a pair listed before trackFrom is followed as soon as someone scans it */
    private function track($sku): ?array
    {
        $sku = self::up($sku);
        $it = Db::get('SELECT * FROM sl_items WHERE UPPER(sku)=?', $sku);
        if ($it) {
            return $it;
        }
        $l = Db::get('SELECT sku, lot, title, cond, at, user_id FROM listings WHERE UPPER(sku)=?', $sku);
        if (! $l) {
            return null;
        }
        Db::run('INSERT IGNORE INTO sl_items(sku,lot,title,grade,listed_at,listed_by) VALUES(?,?,?,?,?,?)', $l['sku'], $l['lot'], $l['title'], $l['cond'], $l['at'], $l['user_id']);
        self::$lastSync = 0;
        $this->doSync(true);
        return Db::get('SELECT * FROM sl_items WHERE sku=?', $l['sku']);
    }

    private static function nextOf($st): ?string
    {
        foreach (self::PAIR as $p) {
            if ($p[0] === $st) {
                return $p[3];
            }
        }
        return null;
    }

    /** Service `stage`: one pair with all its steps; null when it is not listed in the ERP. */
    public function stage($sku): ?array
    {
        $this->doSync();
        $it = $this->track($sku);
        if (! $it) {
            return null;
        }
        $p = Db::get('SELECT title, status, image, qty FROM products WHERE sku=? LIMIT 1', $it['sku']);
        $loc = Db::get('SELECT location FROM locations WHERE sku=?', $it['sku']);
        $h = self::truthy($it['handover_id']) ? Db::get('SELECT id, status FROM sl_handovers WHERE id=?', $it['handover_id']) : null;
        $steps = array_map(fn ($x) => ['k' => $x[0], 'l' => $x[2], 'at' => self::or($it[$x[1]] ?? null, null), 'by' => $this->uname($it[str_replace('_at', '_by', $x[1])] ?? null)], self::PAIR);
        return array_merge($it, ['next' => self::nextOf($it['stage']), 'steps' => $steps, 'product' => $p ?: null, 'inShopify' => (bool) $p, 'coreLoc' => $loc ? $loc['location'] : null, 'handover' => $h]);
    }

    /* ================================================================ lots: sorting sheet + QC → the lot's real mix */

    private static function cleanRows($rows): array
    {
        $out = [];
        foreach (is_array($rows) ? $rows : [] as $r) {
            if (! self::truthy($r) || ! is_array($r) || ! (self::num($r['n'] ?? null) > 0)) {
                continue;
            }
            $out[] = ['t' => self::str($r['t'] ?? null), 'g' => in_array($r['g'] ?? null, ['Woman', 'Men', 'Kids'], true) ? $r['g'] : 'Woman', 'c' => self::str($r['c'] ?? null),
                'n' => Logic::jsRound(self::num($r['n'])), 'b' => self::str($r['b'] ?? null)];
        }
        return $out;
    }

    private function qcOf($lot): array
    {
        return Db::get('SELECT COALESCE(SUM(passed),0) passed, COALESCE(SUM(rejected),0) rejected, COUNT(*) batches, MAX(at) last FROM sl_qc WHERE lot=?', $lot);
    }

    private function sortOf($lot): ?array
    {
        $s = Db::get('SELECT * FROM sl_sort WHERE lot=?', $lot);
        if ($s) {
            $s['rows'] = $this->J($s['rows'], []);
        }
        return $s;
    }

    /** Service: pairs found bad after the GRN count (sorting + QC): for the supplier claim on the PO */
    public function extraBad($lot): int|float
    {
        $s = $this->sortOf($lot);
        if (! $s) {
            return 0;
        }
        $g = $this->grnRow($lot) ?: [];
        return self::or($this->qcOf($lot)['rejected'], 0) + max(0, self::or($s['damaged'], 0) + self::or($s['unmatched'], 0) - self::n0($g['damaged'] ?? null));
    }

    /** same lot planner as Lots (server /api/list/lots): comp → cost per unit of value, so listing prices follow the real mix */
    private function applyMix($name): ?array
    {
        $l = Db::get('SELECT * FROM lots WHERE name=?', $name);
        $s = $this->sortOf($name);
        if (! $l || ! $s) {
            return null;
        }
        $qc = $this->qcOf($name);
        $pieces = self::n0($l['pieces']) ?: (self::or($s['total'], 0));
        $good = max(1, self::or($s['good'], 0) - self::or($qc['rejected'], 0));
        $bad = max(0, min($pieces - 1, $pieces - $good));
        $plan = $this->lotPlan(['name' => $name, 'kind' => $l['kind'] === 'leftover' ? 'leftover' : 'used', 'cost' => self::n0($l['cost']), 'extra' => self::n0($l['extra']), 'pieces' => $pieces, 'bad' => $bad, 'comp' => $s['rows']]);
        $pp = self::pv($plan, 'per_piece');
        $cpv = self::pv($plan, 'cpv');
        Db::run('UPDATE lots SET bad=?, comp=?, per_piece=?, cpv=?, updated_at=UTC_TIMESTAMP() WHERE name=?', $bad, json_encode($s['rows'], JSON_UNESCAPED_UNICODE), self::or($pp, self::or($l['per_piece'], null)), self::or($cpv, null), $name);
        return ['pieces' => $pieces, 'bad' => $bad, 'good' => $good, 'per_piece' => $pp, 'cpv' => $cpv];
    }

    private function poForLot($name)
    {
        $pur = $this->svc('purchasing');
        return $pur && method_exists($pur, 'poForLot') ? $pur->poForLot($name) : null;
    }

    private function compare($name, ?array $s): array
    {
        $po = $this->poForLot($name);
        if (! $po) {
            return ['po' => null, 'rows' => []];
        }
        $key = fn ($r) => self::pv($r, 'g').'|'.self::pv($r, 't').'|'.self::pv($r, 'c');
        $m = [];
        foreach ((self::pv($po, 'mix') ?: []) as $r) {
            $k = $key($r);
            $x = $m[$k] ?? ['g' => self::pv($r, 'g'), 't' => self::pv($r, 't'), 'c' => self::pv($r, 'c'), 'expected' => 0, 'actual' => 0];
            $x['expected'] += self::n0(self::pv($r, 'n'));
            $m[$k] = $x;
        }
        foreach (($s['rows'] ?? null) ?: [] as $r) {
            $k = $key($r);
            $x = $m[$k] ?? ['g' => $r['g'] ?? null, 't' => $r['t'] ?? null, 'c' => $r['c'] ?? null, 'expected' => 0, 'actual' => 0];
            $x['actual'] += self::n0($r['n'] ?? null);
            $m[$k] = $x;
        }
        $rows = array_map(fn ($x) => $x + ['diff' => $x['actual'] - $x['expected']], array_values($m));
        usort($rows, fn ($a, $b) => abs($b['diff']) <=> abs($a['diff']));
        $qc = $this->qcOf($name);
        $bad = $s ? self::or($s['damaged'], 0) + self::or($s['unmatched'], 0) + self::or($qc['rejected'], 0) : null;
        return ['po' => $po, 'rows' => $rows, 'totals' => ['expected' => self::pv($po, 'pieces'), 'sorted' => $s ? $s['total'] : null, 'expBad' => self::pv($po, 'bad_est'), 'bad' => $bad,
            'diff' => $s ? $s['total'] - self::n0(self::pv($po, 'pieces')) : null]];
    }

    private function lotCard(array $l): array
    {
        $g = $this->grnRow($l['name']);
        $s = $this->sortOf($l['name']);
        $qc = $this->qcOf($l['name']);
        $st = Db::get('SELECT COUNT(*) listed, SUM(located_at IS NOT NULL) located, SUM(uploaded_at IS NOT NULL) uploaded FROM sl_items WHERE lot=?', $l['name']);
        $grnPairs = $g ? self::n0($g['good']) + self::n0($g['damaged']) : 0;
        $sortedGood = $s ? self::or($s['good'], 0) : 0;
        $passed = self::or($qc['passed'], 0);
        $rejected = self::or($qc['rejected'], 0);
        $checked = $passed + $rejected;
        $listed = self::or($st['listed'], 0);
        $located = self::or($st['located'], 0);
        $target = $s ? max(0, $sortedGood - $rejected) : ($g ? self::n0($g['good']) : 0);
        $counts = ['grn' => $g && ! $s ? $grnPairs : 0, 'sorted' => $s ? max(0, $sortedGood - $checked - max(0, $listed - $passed)) : 0, 'qc' => max(0, $passed - $listed)];
        $status = ! $g ? 'not_received' : (! $s ? 'to_sort' : ($checked < $sortedGood && $listed < $target ? 'qc' : ($listed < $target ? 'listing' : ($located >= $target ? 'done' : 'in_line'))));
        return ['name' => $l['name'], 'vendor' => self::or($l['vendor'], ''), 'kind' => self::or($l['kind'], ''), 'received_at' => $g ? $g['received_at'] : null,
            'grn' => $g ? ['good' => self::n0($g['good']), 'damaged' => self::n0($g['damaged']), 'expected' => $g['expected']] : null,
            'sorted' => $s ? ['total' => $s['total'], 'good' => $s['good'], 'damaged' => $s['damaged'], 'unmatched' => $s['unmatched'], 'at' => $s['sorted_at'], 'by' => $this->uname($s['sorted_by'])] : null,
            'qc' => ['passed' => $passed, 'rejected' => $rejected, 'batches' => $qc['batches'], 'last' => $qc['last']], 'listed' => $listed, 'uploaded' => self::or($st['uploaded'], 0), 'located' => $located, 'target' => $target,
            'pct' => $target ? min(100, Logic::jsRound(100 * $located / $target)) : 0, 'days' => $g ? self::jsFloor(self::ageDays($g['received_at'])) : null, 'counts' => $counts, 'status' => $status];
    }

    /** lots in the line: received since trackFrom (or with sorting / tracked pairs), newest first */
    private function lineLots(bool $all): array
    {
        $from = $this->S()['trackFrom'];
        try {
            $names = Db::all('SELECT l.* FROM lots l LEFT JOIN wms_grn g ON g.lot=l.name WHERE g.received_at>=? OR l.name IN (SELECT lot FROM sl_sort) OR l.name IN (SELECT DISTINCT lot FROM sl_items) ORDER BY COALESCE(g.received_at, l.updated_at) DESC LIMIT 300', $from);
        } catch (QueryException) {
            $names = Db::all('SELECT l.* FROM lots l WHERE l.name IN (SELECT lot FROM sl_sort) OR l.name IN (SELECT DISTINCT lot FROM sl_items) ORDER BY l.updated_at DESC LIMIT 300');
        }
        $out = array_map(fn ($l) => $this->lotCard($l), $names);
        return $all ? $out : array_values(array_filter($out, fn ($x) => $x['status'] !== 'done' || ($x['days'] !== null && $x['days'] <= 3)));
    }

    public function lotsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'wms', 'listing');
        $this->doSync();
        return ['lots' => $this->lineLots(($qs['all'] ?? null) === '1'), 'settings' => $this->S()];
    }

    public function lotShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'wms', 'listing');
        $name = $p['name'];
        $l = Db::get('SELECT * FROM lots WHERE name=?', $name);
        $this->need($l, 'Lot not found', 404);
        $s = $this->sortOf($name);
        $batches = array_map(fn ($x) => array_merge($x, ['reasons' => (object) ((array) $this->J($x['reasons'], []))]),
            Db::all('SELECT x.*, us.name by_name FROM sl_qc x LEFT JOIN users us ON us.id=x.user_id WHERE lot=? ORDER BY id DESC', $name));
        return ['lot' => $this->lotCard($l), 'sort' => $s, 'qcBatches' => $batches, 'compare' => $this->compare($name, $s), 'types' => $this->prTypes(), 'conds' => $this->prConds(), 'reasons' => self::REJECT,
            'perPair' => $this->can($u, 'pricing_apply') || $this->can($u, 'finance') ? ['per_piece' => $l['per_piece'], 'cpv' => $l['cpv']] : null];
    }

    public function lotSort(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'wms', 'listing');
        $name = $p['name'];
        $this->need(Db::get('SELECT 1 FROM lots WHERE name=?', $name), 'Lot not found', 404);
        $this->need($this->grnRow($name), 'Receive this lot first (Receiving / GRN)');
        $rows = self::cleanRows($b['rows'] ?? null);
        $types = $this->prTypes();
        $conds = $this->prConds();
        $this->need(! array_filter($rows, fn ($r) => ! (in_array($r['t'], $types, true) && in_array($r['c'], $conds, true))), 'Choose a type and condition for every row');
        $damaged = max(0, Logic::jsRound(self::n0($b['damaged'] ?? null)));
        $unmatched = max(0, Logic::jsRound(self::n0($b['unmatched'] ?? null)));
        $good = array_sum(array_column($rows, 'n'));
        $total = $good + $damaged + $unmatched;
        $this->need($good > 0, 'Count the pairs by type first');
        $ex = $this->sortOf($name);
        $at = self::nowUtc();
        $notes = mb_substr(self::str($b['notes'] ?? null), 0, 500);
        if ($ex) {
            Db::run('UPDATE sl_sort SET `rows`=?, good=?, damaged=?, unmatched=?, total=?, notes=?, updated_by=?, updated_at=? WHERE lot=?', json_encode($rows, JSON_UNESCAPED_UNICODE), $good, $damaged, $unmatched, $total, $notes, $u['id'], $at, $name);
        } else {
            Db::run('INSERT INTO sl_sort(lot,`rows`,good,damaged,unmatched,total,notes,sorted_by,sorted_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', $name, json_encode($rows, JSON_UNESCAPED_UNICODE), $good, $damaged, $unmatched, $total, $notes, $u['id'], $at, $u['id'], $at);
        }
        $mix = $this->applyMix($name);
        $g = $this->grnRow($name) ?: [];
        $grnPairs = self::n0($g['good'] ?? null) + self::n0($g['damaged'] ?? null);
        $this->log($u['id'], 'sl.sorted', 'lot:'.$name, ['n' => $total, 'good' => $good, 'damaged' => $damaged, 'unmatched' => $unmatched, 'again' => (bool) $ex]);
        return ['ok' => true, 'total' => $total, 'good' => $good, 'damaged' => $damaged, 'unmatched' => $unmatched, 'mix' => $mix, 'grnPairs' => $grnPairs, 'countDiff' => $total - $grnPairs, 'compare' => $this->compare($name, $this->sortOf($name))];
    }

    public function lotQc(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'wms', 'listing');
        $name = $p['name'];
        $s = $this->sortOf($name);
        $this->need($s, 'Save the sorting sheet first');
        $reasons = [];
        $rej = is_array($b['rejected'] ?? null) ? $b['rejected'] : [];
        foreach (self::REJECT as $r) {
            $n = self::num($rej[$r] ?? null);
            $n = max(0, Logic::jsRound(is_float($n) && is_nan($n) ? 0 : $n));
            if ($n) {
                $reasons[$r] = $n;
            }
        }
        $rejected = array_sum($reasons);
        $passed = max(0, Logic::jsRound(self::n0($b['passed'] ?? null)));
        $this->need($passed + $rejected > 0, 'Enter the pairs checked');
        $qc = $this->qcOf($name);
        $this->need(self::or($qc['passed'], 0) + self::or($qc['rejected'], 0) + $passed + $rejected <= self::or($s['good'], 0), 'More than the '.($s['good'] ?? 'null').' good pairs counted at sorting');
        $id = Db::run('INSERT INTO sl_qc(lot,passed,rejected,reasons,notes,user_id) VALUES(?,?,?,?,?,?)', $name, $passed, $rejected, json_encode((object) $reasons, JSON_UNESCAPED_UNICODE), mb_substr(self::str($b['notes'] ?? null), 0, 500), $u['id'])->lastInsertRowid;
        $mix = $this->applyMix($name);
        $po = $this->poForLot($name);
        $this->log($u['id'], 'sl.qc', 'lot:'.$name, ['n' => $passed + $rejected, 'passed' => $passed, 'rejected' => $rejected, 'reasons' => (object) $reasons]);
        return ['ok' => true, 'id' => $id, 'passed' => $passed, 'rejected' => $rejected, 'reasons' => (object) $reasons, 'mix' => $mix,
            'claim' => $po && $rejected ? ['po' => self::pv($po, 'id'), 'no' => self::pv($po, 'no'), 'supplier' => self::pv($po, 'supplier'), 'pairs' => $rejected] : null,
            'writtenOff' => ! $po && $rejected ? $rejected : 0];
    }

    /* ================================================================ queues & scan marks (photo / editing / upload) */

    private function queue(string $kind, int $lim = 500): array
    {
        [$w, $since] = self::QUEUE[$kind];
        return array_map(fn ($r) => $r + ['waitDays' => self::jsFloor(self::or(self::ageDays($r['since']), 0))],
            Db::all('SELECT '.self::ITEM_COLS.", {$since} since FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by WHERE {$w} ORDER BY {$since}, i.sku LIMIT ?", $lim));
    }

    private function qn(string $kind): int
    {
        return (int) Db::val('SELECT COUNT(*) n FROM sl_items WHERE '.self::QUEUE[$kind][0]);
    }

    public function queueList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $kind = $p['kind'];
        $this->need(isset(self::QUEUE[$kind]), 'Unknown queue', 404);
        $this->gate($u, 'listing');
        $this->doSync(true);
        $rows = $this->queue($kind);
        if ($kind === 'handover') {
            foreach ($rows as &$r) {
                $r['ready'] = self::truthy($r['uploaded_at']);
                $r['warn'] = ! self::truthy($r['photo_at']) ? 'Photo not done' : (! self::truthy($r['uploaded_at']) ? 'Not uploaded yet' : null);
            }
            unset($r);
        }
        $out = ['kind' => $kind, 'rows' => $rows, 'total' => $this->qn($kind), 'settings' => $this->S()];
        if ($kind === 'photo' || $kind === 'edit') {
            $out['counts'] = ['photo' => $this->qn('photo'), 'edit' => $this->qn('edit')];
        }
        return $out;
    }

    public function mark(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing');
        $stage = $b['stage'] ?? null;
        $m = is_string($stage) ? (self::MARK[$stage] ?? null) : null;
        $this->need($m, 'Unknown step');
        [$col, $by, $bcol, $act, $before] = $m;
        $skus = self::skuList(is_array($b['skus'] ?? null) && array_is_list($b['skus']) ? $b['skus'] : [$b['sku'] ?? null]);
        $this->need($skus, 'Scan a SKU');
        $this->doSync();
        $done = [];
        $skipped = [];
        $at = self::nowUtc();
        if (self::truthy($b['undo'] ?? null)) {
            foreach ($skus as $s) {
                $it = Db::get('SELECT * FROM sl_items WHERE UPPER(sku)=?', $s);
                if (! $it || ! self::truthy($it[$col])) {
                    $skipped[] = ['sku' => $s, 'why' => 'not marked'];
                    continue;
                }
                if ($stage === 'upload' && $it['upload_src'] === 'shopify') {
                    $skipped[] = ['sku' => $s, 'why' => 'it is live on Shopify'];
                    continue;
                }
                Db::run("UPDATE sl_items SET {$col}=NULL, {$by}=NULL, {$bcol}=NULL".($stage === 'upload' ? ', upload_src=NULL' : '').' WHERE sku=?', $it['sku']);
                $this->restage('sku=?', $it['sku']);
                $done[] = $it['sku'];
            }
            return ['ok' => true, 'done' => $done, 'skipped' => $skipped];
        }
        $batch = Db::run('INSERT INTO sl_batches(kind,user_id,n) VALUES(?,?,0)', $stage, $u['id'])->lastInsertRowid;
        $this->tx(function () use ($skus, $col, $by, $bcol, $act, $before, $stage, $at, $batch, $u, &$done, &$skipped) {
            foreach ($skus as $s) {
                $it = $this->track($s);
                if (! $it) {
                    $skipped[] = ['sku' => $s, 'why' => $this->slotTest($s) ? 'that is a slot label' : 'not listed in the ERP'];
                    continue;
                }
                if (self::truthy($it[$col])) {
                    $skipped[] = ['sku' => $it['sku'], 'why' => 'already done '.($it['upload_src'] === 'shopify' && $stage === 'upload' ? '(live on Shopify)' : '')];
                    continue;
                }
                Db::run("UPDATE sl_items SET {$col}=?, {$by}=?, {$bcol}=?".($stage === 'upload' ? ", upload_src='manual'" : '').implode('', array_map(fn ($x) => ", {$x}=COALESCE({$x}, ?)", $before)).' WHERE sku=?',
                    $at, $u['id'], $batch, ...array_merge(array_map(fn () => $at, $before), [$it['sku']]));
                $this->restage('sku=?', $it['sku']);
                $this->log($u['id'], $act, 'sku:'.$it['sku'], ['batch' => $batch, 'lot' => $it['lot']]);
                $done[] = $it['sku'];
            }
            Db::run('UPDATE sl_batches SET n=? WHERE id=?', count($done), $batch);
        });
        return ['ok' => true, 'batch' => $batch, 'done' => $done, 'skipped' => $skipped];
    }

    public function uploadCheck(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing');
        $this->doSync(true);
        $cols = 'i.sku, i.lot, i.title, i.uploaded_at, i.upload_src, us.name lister';
        return [
            'autoDetected' => Db::all("SELECT {$cols}, p.status shop_status FROM sl_items i JOIN products p ON p.sku=i.sku LEFT JOIN users us ON us.id=i.listed_by WHERE i.upload_src='shopify' AND i.uploaded_at>=(UTC_TIMESTAMP() - INTERVAL 14 DAY) ORDER BY i.uploaded_at DESC LIMIT 300"),
            'notFound' => Db::all("SELECT {$cols}, ub.name marked_by FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by LEFT JOIN users ub ON ub.id=i.uploaded_by WHERE i.upload_src='manual' AND NOT EXISTS(SELECT 1 FROM products p WHERE p.sku=i.sku) ORDER BY i.uploaded_at LIMIT 300"),
            'drafts' => Db::all("SELECT {$cols}, p.status shop_status FROM sl_items i JOIN products p ON p.sku=i.sku LEFT JOIN users us ON us.id=i.listed_by WHERE UPPER(COALESCE(p.status,''))='DRAFT' AND i.located_at IS NULL ORDER BY i.uploaded_at LIMIT 300"),
        ];
    }

    /* ================================================================ one pair */

    public function pairShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'wms', 'warehouse', 'team');
        $x = $this->stage($p['sku']);
        $this->need($x, 'Not listed in the ERP', 404);
        return $x;
    }

    public function pairLocation(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing');
        $it = $this->track($p['sku']);
        $this->need($it, 'Not listed in the ERP', 404);
        $loc = self::up($b['location'] ?? null);
        $this->need($loc === '' || preg_match('/^[A-Z0-9][A-Z0-9-]{0,24}$/D', $loc), 'Location looks wrong (e.g. A-R2-C2-L1)');
        Db::run('UPDATE sl_items SET pref_loc=? WHERE sku=?', $loc !== '' ? $loc : null, $it['sku']);
        return ['ok' => true, 'sku' => $it['sku'], 'location' => $loc !== '' ? $loc : null];
    }

    /* ================================================================ handover to the warehouse */

    /** pairs per location: stock in Shopify + pairs not synced yet + places promised in open handovers */
    private function occupancy(): array
    {
        $m = [];
        $add = function ($k, $n) use (&$m) {
            if (self::truthy($k)) {
                $m[$k] = ($m[$k] ?? 0) + $n;
            }
        };
        foreach (Db::all("SELECT UPPER(COALESCE(l.location,p.rack,'')) loc, COUNT(*) n FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 GROUP BY 1") as $r) {
            $add($r['loc'], $r['n']);
        }
        foreach (Db::all('SELECT UPPER(l.location) loc, COUNT(*) n FROM locations l WHERE NOT EXISTS(SELECT 1 FROM products p WHERE p.sku=l.sku) GROUP BY 1') as $r) {
            $add($r['loc'], $r['n']);
        }
        foreach (Db::all("SELECT UPPER(COALESCE(i.confirmed_loc,i.suggested)) loc, COUNT(*) n FROM sl_handover_items i JOIN sl_handovers h ON h.id=i.handover_id WHERE h.status='sent' AND i.located=0 GROUP BY 1") as $r) {
            $add($r['loc'], $r['n']);
        }
        return $m;
    }

    /** lister's own location first; the rest go to the next slots with room, as few slots as possible. sku => ['loc','src'] */
    private function suggest(array $items): array
    {
        $out = [];
        $auto = [];
        $W = $this->wms();
        foreach ($items as $it) {
            $pref = self::up($it['pref_loc'] ?? null);
            if ($pref !== '') {
                if ($W && method_exists($W, 'ensureSlot') && $this->slotTest($pref)) {
                    $W->ensureSlot($pref);
                }
                $out[$it['sku']] = ['loc' => $pref, 'src' => 'lister'];
            } else {
                $auto[] = $it['sku'];
            }
        }
        if (! $auto) {
            return $out;
        }
        $slots = [];
        try {
            $slots = Db::all('SELECT code, capacity FROM wms_slots WHERE active=1 ORDER BY rack, `row`, col, level');
        } catch (QueryException) {
        }
        $occ = $this->occupancy();
        foreach ($out as $v) {
            $occ[$v['loc']] = ($occ[$v['loc']] ?? 0) + 1;
        }
        $free = array_values(array_filter(array_map(fn ($s) => ['code' => $s['code'], 'free' => max(0, self::or($s['capacity'], 0) - ($occ[$s['code']] ?? 0))], $slots), fn ($s) => $s['free'] > 0));
        $rest = $auto;
        while ($rest) {
            $fi = null;
            foreach ($free as $i => $s) {
                if ($s['free'] >= count($rest)) {
                    $fi = $i;
                    break;
                }
            }
            if ($fi === null) { // the slot with the most room (first one on ties)
                foreach ($free as $i => $s) {
                    if ($fi === null || $s['free'] > $free[$fi]['free']) {
                        $fi = $i;
                    }
                }
            }
            if ($fi === null || ! $free[$fi]['free']) {
                break;
            }
            $take = array_splice($rest, 0, min($free[$fi]['free'], count($rest)));
            $free[$fi]['free'] -= count($take);
            foreach ($take as $s) {
                $out[$s] = ['loc' => $free[$fi]['code'], 'src' => 'auto'];
            }
        }
        foreach ($rest as $s) {
            $out[$s] = ['loc' => '', 'src' => 'none'];
        }
        return $out;
    }

    private function checkForHandover($sku): array
    {
        $it = $this->track($sku);
        if (! $it) {
            return ['sku' => self::up($sku), 'error' => 'Not listed in the ERP'];
        }
        if (self::truthy($it['located_at'])) {
            return ['sku' => $it['sku'], 'error' => 'Already on a location ('.self::or($it['location'], 'warehouse').')'];
        }
        if (self::truthy($it['handed_at'])) {
            return ['sku' => $it['sku'], 'error' => 'Already handed over (handover #'.$it['handover_id'].')'];
        }
        $warn = array_values(array_filter([! self::truthy($it['photo_at']) ? 'photo not done' : false, ! self::truthy($it['uploaded_at']) ? 'not uploaded to Shopify' : false]));
        if (self::truthy($this->S()['blockHandover']) && ! self::truthy($it['uploaded_at'])) {
            return ['sku' => $it['sku'], 'error' => 'Upload it first (photo, editing and upload must be done before handover)'];
        }
        return ['sku' => $it['sku'], 'it' => $it, 'title' => $it['title'], 'lot' => $it['lot'], 'warn' => $warn ? 'Warning: '.implode(', ', $warn) : null, 'pref_loc' => $it['pref_loc']];
    }

    public function handoverCheck(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing');
        $this->doSync();
        $skus = self::skuList($b['skus'] ?? null);
        $rows = array_map(fn ($s) => $this->checkForHandover($s), $skus);
        $okRows = array_values(array_filter($rows, fn ($r) => ! isset($r['error'])));
        $sg = $this->suggest(array_map(fn ($r) => $r['it'], $okRows));
        return ['rows' => array_map(function ($r) use ($sg) {
            unset($r['it']);
            $x = $sg[$r['sku']] ?? null;
            return $r + ['suggested' => $x ? $x['loc'] : null, 'src' => $x ? $x['src'] : null];
        }, $rows), 'blocking' => $this->S()['blockHandover']];
    }

    public function handoverCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing');
        $this->doSync(true);
        $skus = self::skuList($b['skus'] ?? null);
        $this->need($skus, 'Scan the pairs you are handing over');
        $rows = array_map(fn ($s) => $this->checkForHandover($s), $skus);
        $good = array_values(array_filter($rows, fn ($r) => ! isset($r['error'])));
        $skipped = array_values(array_map(fn ($r) => ['sku' => $r['sku'], 'why' => $r['error']], array_filter($rows, fn ($r) => isset($r['error']))));
        $this->need($good, implode(' · ', array_map(fn ($s) => "{$s['sku']}: {$s['why']}", $skipped)) ?: 'Nothing to hand over');
        $note = mb_substr(self::str($b['note'] ?? null), 0, 300);
        $id = $this->tx(function () use ($good, $note, $u) {
            $sg = $this->suggest(array_map(fn ($r) => $r['it'], $good));
            $hid = Db::run('INSERT INTO sl_handovers(note,created_by,warnings) VALUES(?,?,?)', $note, $u['id'], count(array_filter($good, fn ($r) => self::truthy($r['warn']))))->lastInsertRowid;
            foreach ($good as $r) {
                $s = $sg[$r['sku']] ?? ['loc' => '', 'src' => 'none'];
                Db::run('INSERT INTO sl_handover_items(handover_id,sku,suggested,src,warn) VALUES(?,?,?,?,?)', $hid, $r['sku'], self::or($s['loc'], null), $s['src'], $r['warn']);
                Db::run('UPDATE sl_items SET handed_at=UTC_TIMESTAMP(), handed_by=?, handover_id=? WHERE sku=?', $u['id'], $hid, $r['sku']);
                $this->restage('sku=?', $r['sku']);
                $this->log($u['id'], 'sl.handover', 'sku:'.$r['sku'], ['handover' => $hid]);
            }
            return $hid;
        });
        return ['ok' => true, 'id' => $id, 'n' => count($good), 'skipped' => $skipped, 'handover' => $this->handoverFull($id)];
    }

    private function handoverFull($id): array
    {
        $h = Db::get('SELECT h.*, c.name created_name, r.name received_name FROM sl_handovers h LEFT JOIN users c ON c.id=h.created_by LEFT JOIN users r ON r.id=h.received_by WHERE h.id=?', (int) self::n0($id));
        $this->need($h, 'Handover not found', 404);
        $items = Db::all('SELECT x.*, COALESCE(i.title, (SELECT title FROM listings WHERE sku=x.sku)) title, i.lot, i.photo_at, i.uploaded_at FROM sl_handover_items x LEFT JOIN sl_items i ON i.sku=x.sku WHERE x.handover_id=? ORDER BY x.extra, COALESCE(x.confirmed_loc,x.suggested), x.sku', $h['id']);
        $sent = array_values(array_filter($items, fn ($i) => ! $i['extra']));
        return array_merge($h, ['diff' => $this->J($h['diff'], null), 'items' => $items, 'totals' => [
            'sent' => count($sent), 'received' => count(array_filter($sent, fn ($i) => $i['received'])), 'extra' => count(array_filter($items, fn ($i) => $i['extra'])),
            'located' => count(array_filter($items, fn ($i) => $i['located'])), 'missing' => count(array_filter($sent, fn ($i) => ! $i['received'])),
        ]]);
    }

    public function handoversList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'warehouse', 'wms');
        $st = $qs['status'] ?? null;
        $w = $st === 'sent' ? "h.status='sent'" : ($st === 'received' ? "h.status='received'" : '1=1');
        $mine = ($qs['mine'] ?? null) === '1' ? ' AND h.created_by='.(int) $u['id'] : '';
        return array_map(fn ($h) => array_merge($h, ['diff' => $this->J($h['diff'], null)]), Db::all("SELECT h.*, c.name created_name, r.name received_name, (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.extra=0) n,
            (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.received=1 AND x.extra=0) got, (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.located=1) located
            FROM sl_handovers h LEFT JOIN users c ON c.id=h.created_by LEFT JOIN users r ON r.id=h.received_by WHERE {$w}{$mine} ORDER BY CASE h.status WHEN 'sent' THEN 0 ELSE 1 END, h.id DESC LIMIT 200"));
    }

    public function handoverShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'warehouse', 'wms');
        return $this->handoverFull($p['id']);
    }

    /* ================================================================ warehouse receive & put-away */

    private function whGate(?array $u): void
    {
        $this->gate($u, 'warehouse', 'wms');
    }

    private function openH($id): array
    {
        $h = Db::get('SELECT * FROM sl_handovers WHERE id=?', (int) self::n0($id));
        $this->need($h, 'Handover not found', 404);
        $this->need($h['status'] === 'sent', 'This handover is already received');
        return $h;
    }

    private function receiveOne(array $h, $sku, $uid): array
    {
        $sku = self::up($sku);
        $this->need($sku !== '', 'Scan a SKU');
        $this->need(! $this->slotTest($sku), $sku.' is a slot label, not a pair');
        $x = Db::get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', $h['id'], $sku);
        $warn = null;
        if ($x && $x['received']) {
            return ['sku' => $x['sku'], 'again' => true, 'item' => $x];
        }
        if (! $x) {
            $it = $this->track($sku);
            $warn = ! $it ? 'Not listed in the ERP' : (self::truthy($it['handover_id']) && (int) $it['handover_id'] !== (int) $h['id'] && self::truthy($it['handed_at']) ? "Belongs to handover #{$it['handover_id']}" : 'Not on this handover sheet');
            $sg = $it ? ($this->suggest([$it])[$it['sku']] ?? null) : null;
            Db::run('INSERT INTO sl_handover_items(handover_id,sku,suggested,src,extra,warn) VALUES(?,?,?,?,1,?)', $h['id'], $it ? $it['sku'] : $sku, $sg ? self::or($sg['loc'], null) : null, $sg ? $sg['src'] : 'none', $warn);
            $x = Db::get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', $h['id'], $sku);
        }
        Db::run('UPDATE sl_handover_items SET received=1, received_at=UTC_TIMESTAMP() WHERE id=?', $x['id']);
        if (Db::get('SELECT 1 FROM sl_items WHERE sku=?', $x['sku'])) {
            Db::run('UPDATE sl_items SET received_at=COALESCE(received_at,UTC_TIMESTAMP()), received_by=COALESCE(received_by,?), handed_at=COALESCE(handed_at,UTC_TIMESTAMP()), handover_id=? WHERE sku=?', $uid, $h['id'], $x['sku']);
            $this->restage('sku=?', $x['sku']);
        }
        $this->log($uid, 'sl.received', 'sku:'.$x['sku'], ['handover' => $h['id'], 'extra' => (bool) $x['extra']]);
        return ['sku' => $x['sku'], 'extra' => (bool) $x['extra'], 'warn' => $warn, 'item' => Db::get('SELECT * FROM sl_handover_items WHERE id=?', $x['id'])];
    }

    private function locateOne(array $h, $sku, $slot, $uid): array
    {
        $W = $this->wms();
        $this->need($W && method_exists($W, 'putaway'), 'Warehouse module is not available');
        $x = Db::get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', $h['id'], self::up($sku));
        if (! $x || ! $x['received']) {
            $this->receiveOne($h, $sku, $uid);
            $x = Db::get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', $h['id'], self::up($sku));
        }
        $slot = self::up(self::or($slot, self::or($x['confirmed_loc'], $x['suggested'])));
        $this->need($slot !== '', 'Scan the slot for '.$x['sku']);
        if ($this->slotTest($slot)) {
            $W->ensureSlot($slot);
        }
        $r = $W->putaway($uid, ['sku' => $x['sku'], 'slot' => $slot, 'reason' => 'putaway'], ['silent' => true]);
        Db::run('UPDATE sl_handover_items SET confirmed_loc=?, located=1, located_at=UTC_TIMESTAMP() WHERE id=?', $slot, $x['id']);
        Db::run('UPDATE sl_items SET located_at=UTC_TIMESTAMP(), located_by=?, location=? WHERE sku=?', $uid, $slot, $x['sku']);
        $this->restage('sku=?', $x['sku']);
        $changed = $slot !== self::up(self::or($x['suggested'], ''));
        $this->log($uid, 'sl.located', 'sku:'.$x['sku'], ['slot' => $slot, 'handover' => $h['id'], 'changed' => $changed]);
        return ['sku' => $x['sku'], 'slot' => $slot, 'warnings' => self::or($r['warnings'] ?? null, []), 'changed' => $changed, 'inSlot' => $r['inSlot'] ?? null, 'capacity' => $r['capacity'] ?? null];
    }

    public function handoverScan(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->whGate($u);
        $h = $this->openH($p['id']);
        $r = $this->receiveOne($h, $b['sku'] ?? null, $u['id']);
        return array_merge(['ok' => true], $r, ['totals' => $this->handoverFull($h['id'])['totals']]);
    }

    public function handoverLocate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->whGate($u);
        $h = $this->openH($p['id']);
        $r = $this->tx(fn () => $this->locateOne($h, $b['sku'] ?? null, $b['slot'] ?? null, $u['id']));
        return array_merge(['ok' => true], $r, ['totals' => $this->handoverFull($h['id'])['totals']]);
    }

    public function handoverLocateAll(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->whGate($u);
        $h = $this->openH($p['id']);
        $done = [];
        $skipped = [];
        foreach (Db::all('SELECT * FROM sl_handover_items WHERE handover_id=? AND received=1 AND located=0', $h['id']) as $x) {
            if (! self::truthy($x['suggested']) && ! self::truthy($x['confirmed_loc'])) {
                $skipped[] = ['sku' => $x['sku'], 'why' => 'no location suggested'];
                continue;
            }
            try {
                $done[] = $this->tx(fn () => $this->locateOne($h, $x['sku'], null, $u['id']));
            } catch (\Throwable $e) {
                $skipped[] = ['sku' => $x['sku'], 'why' => $e->getMessage()];
            }
        }
        return ['ok' => true, 'done' => $done, 'skipped' => $skipped, 'totals' => $this->handoverFull($h['id'])['totals']];
    }

    public function handoverClose(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->whGate($u);
        $h = $this->openH($p['id']);
        $full = $this->handoverFull($h['id']);
        $missing = array_values(array_map(fn ($i) => $i['sku'], array_filter($full['items'], fn ($i) => ! $i['extra'] && ! $i['received'])));
        $extra = array_values(array_map(fn ($i) => $i['sku'], array_filter($full['items'], fn ($i) => $i['extra'])));
        $unlocated = array_values(array_map(fn ($i) => $i['sku'], array_filter($full['items'], fn ($i) => $i['received'] && ! $i['located'])));
        $nu = count($unlocated);
        $this->need(! $nu || self::truthy($b['force'] ?? null), "{$nu} received pair".($nu > 1 ? 's have' : ' has').' no location yet');
        $diff = $missing || $extra ? ['missing' => $missing, 'extra' => $extra, 'note' => mb_substr(self::str($b['note'] ?? null), 0, 300)] : null;
        $this->tx(function () use ($missing, $diff, $h, $u) {
            foreach ($missing as $s) {
                Db::run('UPDATE sl_items SET handed_at=NULL, handed_by=NULL, handover_id=NULL WHERE sku=? AND received_at IS NULL', $s);
                $this->restage('sku=?', $s);
            }
            Db::run("UPDATE sl_handovers SET status='received', received_by=?, received_at=UTC_TIMESTAMP(), diff=? WHERE id=?", $u['id'], $diff ? json_encode($diff, JSON_UNESCAPED_UNICODE) : null, $h['id']);
        });
        $this->log($u['id'], 'sl.handover.close', 'handover:'.$h['id'], ['n' => $full['totals']['received'], 'missing' => count($missing), 'extra' => count($extra)]);
        return ['ok' => true, 'missing' => $missing, 'extra' => $extra, 'unlocated' => $unlocated, 'handover' => $this->handoverFull($h['id'])];
    }

    /* ================================================================ board */

    private static function pkDay(string $col): string
    {
        return "DATE_FORMAT({$col} + INTERVAL 5 HOUR,'%Y-%m-%d')";
    }

    private function pairCounts(string $lot): array
    {
        $w = $lot !== '' ? 'WHERE lot=?' : '';
        $a = $lot !== '' ? [$lot] : [];
        $m = [];
        foreach (Db::all("SELECT stage, COUNT(*) n FROM sl_items {$w} GROUP BY stage", ...$a) as $r) {
            $m[$r['stage']] = $r['n'];
        }
        $oldest = [];
        foreach (self::PAIR as [$k, $col]) {
            if ($k !== 'located') {
                $oldest[$k] = Db::val("SELECT MIN({$col}) at FROM sl_items WHERE stage=? ".($lot !== '' ? 'AND lot=?' : ''), $k, ...$a) ?: null;
            }
        }
        return ['m' => $m, 'oldest' => $oldest];
    }

    private function stuckList(string $lot): array
    {
        $d = (int) self::n0($this->S()['stuckDays']);
        $out = [];
        foreach (self::PAIR as [$k, $col, $l, $nx]) {
            if ($k === 'located') {
                continue;
            }
            $r = Db::get("SELECT COUNT(*) n, MIN({$col}) at FROM sl_items WHERE stage=? AND {$col} < (UTC_TIMESTAMP() - INTERVAL ? DAY) ".($lot !== '' ? 'AND lot=?' : ''), $k, $d, ...($lot !== '' ? [$lot] : []));
            if ($r['n']) {
                $out[] = ['stage' => $k, 'label' => $l, 'next' => $nx, 'n' => $r['n'], 'oldest' => $r['at'], 'days' => self::jsFloor(self::ageDays($r['at']))];
            }
        }
        return $out;
    }

    private function lotStuck(array $lots): array
    {
        $st = $this->S();
        $out = [];
        foreach ($lots as $l) {
            if ($l['status'] === 'to_sort' && $l['days'] !== null && $l['days'] >= $st['unsortedDays']) {
                $out[] = ['lot' => $l['name'], 'stage' => 'grn', 'label' => 'Received, not sorted', 'n' => $l['counts']['grn'], 'days' => $l['days']];
            }
            if ($l['counts']['sorted'] && $l['sorted']) {
                $a = self::ageDays(self::or($l['qc']['last'], $l['sorted']['at']));
                if ($a !== null && $a > $st['stuckDays']) {
                    $out[] = ['lot' => $l['name'], 'stage' => 'sorted', 'label' => 'Sorted, QC not finished', 'n' => $l['counts']['sorted'], 'days' => self::jsFloor($a)];
                }
            }
            if ($l['counts']['qc'] && self::truthy($l['qc']['last'])) {
                $a = self::ageDays($l['qc']['last']);
                if ($a !== null && $a > $st['stuckDays']) {
                    $out[] = ['lot' => $l['name'], 'stage' => 'qc', 'label' => 'QC passed, not listed', 'n' => $l['counts']['qc'], 'days' => self::jsFloor($a)];
                }
            }
        }
        return $out;
    }

    /** Service: the whole Stock line board (optionally for one lot). */
    public function board($lot = ''): array
    {
        $lot = (string) ($lot ?? '');
        $this->doSync(true);
        $lots = $this->lineLots(false);
        $pc = $this->pairCounts($lot);
        $scope = $lot !== '' ? array_values(array_filter($lots, fn ($l) => $l['name'] === $lot)) : $lots;
        $lc = ['grn' => 0, 'sorted' => 0, 'qc' => 0];
        $lo = ['grn' => null, 'sorted' => null, 'qc' => null];
        $minAt = fn ($a, $b) => ! self::truthy($a) ? $b : (! self::truthy($b) ? $a : ($a < $b ? $a : $b));
        foreach ($scope as $l) {
            foreach (array_keys($lc) as $k) {
                $lc[$k] += self::or($l['counts'][$k] ?? null, 0);
            }
            if ($l['counts']['grn']) {
                $lo['grn'] = $minAt($lo['grn'], $l['received_at']);
            }
            if ($l['counts']['sorted']) {
                $lo['sorted'] = $minAt($lo['sorted'], $l['sorted'] ? $l['sorted']['at'] : $l['sorted']);
            }
            if ($l['counts']['qc']) {
                $lo['qc'] = $minAt($lo['qc'], $l['qc']['last']);
            }
        }
        $stages = array_merge(
            array_map(fn ($x) => ['k' => $x[0], 'l' => $x[1], 'next' => $x[2], 'lot' => true, 'n' => $lc[$x[0]], 'oldest' => $lo[$x[0]]], self::LOTST),
            array_map(fn ($x) => ['k' => $x[0], 'l' => $x[2], 'next' => $x[3], 'n' => self::or($pc['m'][$x[0]] ?? null, 0), 'oldest' => self::or($pc['oldest'][$x[0]] ?? null, null)], self::PAIR)
        );
        $stages = array_map(fn ($s) => $s + ['oldestDays' => self::truthy($s['oldest']) ? self::jsFloor(self::ageDays($s['oldest'])) : null], $stages);
        // daily throughput (last 7 days, Pakistan days) per step and per person
        $days = [];
        for ($i = 6; $i >= 0; $i--) {
            $days[] = gmdate('Y-m-d', time() + 5 * 3600 - $i * 86400);
        }
        $from = $days[0];
        $lw = $lot !== '' ? ' AND lot=?' : '';
        $la = $lot !== '' ? [$lot] : [];
        $daily = array_map(fn ($d) => ['day' => $d], $days);
        $byDay = array_flip($days);
        $people = [];
        $tally = function (string $k, array $rows) use (&$daily, $byDay, &$people) {
            foreach ($rows as $r) {
                if (isset($byDay[$r['day']])) {
                    $i = $byDay[$r['day']];
                    $daily[$i][$k] = ($daily[$i][$k] ?? 0) + $r['n'];
                }
                if (self::truthy($r['uid'])) {
                    $pp = $people[$r['uid']] ?? ['id' => $r['uid'], 'name' => $this->uname($r['uid']), 'total' => 0];
                    $pp[$k] = ($pp[$k] ?? 0) + $r['n'];
                    $pp['total'] += $r['n'];
                    $people[$r['uid']] = $pp;
                }
            }
        };
        $tally('sorted', Db::all('SELECT '.self::pkDay('sorted_at').' day, sorted_by uid, SUM(total) n FROM sl_sort WHERE '.self::pkDay('sorted_at').">=?{$lw} GROUP BY 1,2", $from, ...$la));
        $tally('qc', Db::all('SELECT '.self::pkDay('at').' day, user_id uid, SUM(passed+rejected) n FROM sl_qc WHERE '.self::pkDay('at').">=?{$lw} GROUP BY 1,2", $from, ...$la));
        foreach (self::PAIR as [$k, $col]) {
            $tally($k, Db::all('SELECT '.self::pkDay($col).' day, '.str_replace('_at', '_by', $col)." uid, COUNT(*) n FROM sl_items WHERE {$col} IS NOT NULL AND ".self::pkDay($col).">=?{$lw} GROUP BY 1,2", $from, ...$la));
        }
        $stuck = $this->stuckList($lot);
        $lstuck = $this->lotStuck($scope);
        $people = array_values($people);
        usort($people, fn ($a, $b) => $b['total'] <=> $a['total']);
        return ['stages' => $stages, 'lots' => $lots, 'daily' => $daily, 'people' => $people, 'stuck' => $stuck, 'lotStuck' => $lstuck, 'settings' => $this->S(), 'lot' => $lot !== '' ? $lot : null,
            'totals' => ['inLine' => array_sum(array_map(fn ($s) => $s['k'] !== 'located' ? $s['n'] : 0, $stages)), 'stuckPairs' => array_sum(array_column($stuck, 'n'))]];
    }

    public function boardRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'wms', 'team');
        return $this->board(self::or($qs['lot'] ?? null, ''));
    }

    public function stageList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'wms', 'team');
        $this->doSync(true);
        $k = $p['k'];
        $lot = (string) self::or($qs['lot'] ?? null, '');
        if (in_array($k, array_column(self::LOTST, 0), true)) {
            return ['k' => $k, 'lots' => array_values(array_filter($this->lineLots(false), fn ($l) => ($l['counts'][$k] ?? 0) > 0 && ($lot === '' || $l['name'] === $lot)))];
        }
        $st = null;
        foreach (self::PAIR as $x) {
            if ($x[0] === $k) {
                $st = $x;
            }
        }
        $this->need($st, 'Unknown stage', 404);
        $rows = array_map(fn ($r) => $r + ['waitDays' => self::jsFloor(self::or(self::ageDays($r['since']), 0))],
            Db::all('SELECT '.self::ITEM_COLS.", i.location, i.received_at, i.located_at, i.{$st[1]} since FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by WHERE i.stage=? ".($lot !== '' ? 'AND i.lot=?' : '')." ORDER BY i.{$st[1]} ".($k === 'located' ? 'DESC' : '').' LIMIT 1000', $k, ...($lot !== '' ? [$lot] : [])));
        return ['k' => $k, 'label' => $st[2], 'next' => $st[3], 'rows' => $rows, 'stuckDays' => $this->S()['stuckDays']];
    }

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->gate($u, 'listing', 'wms', 'team');
        return $this->S();
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'settings') || $this->can($u, 'team') || ($u['role'] ?? null) === 'admin', 'Only the owner or a manager can change these', 403);
        $cur = $this->setting('stockline.settings', []);
        $cur = is_array($cur) ? $cur : [];
        $rnd = function ($v, $def) {
            $n = self::num($v);
            $n = is_float($n) && is_nan($n) ? 0 : Logic::jsRound($n);
            return max(1, $n ?: $def);
        };
        if (isset($b['stuckDays']) && $b['stuckDays'] !== '') {
            $cur['stuckDays'] = $rnd($b['stuckDays'], 2);
        }
        if (isset($b['unsortedDays']) && $b['unsortedDays'] !== '') {
            $cur['unsortedDays'] = $rnd($b['unsortedDays'], 1);
        }
        if (array_key_exists('blockHandover', $b) && $b['blockHandover'] !== null) {
            $cur['blockHandover'] = self::truthy($b['blockHandover']);
        }
        $this->setSetting('stockline.settings', $cur ?: new \stdClass);
        $this->log($u['id'], 'settings.save', 'stockline:settings', $cur ?: new \stdClass);
        return $this->S();
    }

    /* ================================================================ services */

    /** Service: pairs waiting per step + stuck pairs (home page). */
    public function summary(): array
    {
        $this->doSync();
        $m = [];
        foreach (Db::all('SELECT stage, COUNT(*) n FROM sl_items GROUP BY stage') as $r) {
            $m[$r['stage']] = $r['n'];
        }
        return ['waiting' => ['listed' => $m['listed'] ?? 0, 'photo' => $m['photo'] ?? 0, 'edited' => $m['edited'] ?? 0, 'uploaded' => $m['uploaded'] ?? 0, 'handover' => $m['handed'] ?? 0, 'receive' => $m['inwh'] ?? 0],
            'stuck' => array_sum(array_column($this->stuckList(''), 'n'))];
    }

    /** Service `sync`: bring the per-pair stages up to date now. */
    public function sync(): void
    {
        $this->doSync(true);
    }

    /* ================================================================ badges, alerts */

    public function counts(array $u): array
    {
        $can = fn ($p) => $this->can($u, $p);
        $out = [];
        if (! ($can('listing') || $can('wms') || $can('warehouse') || $can('team'))) {
            return $out;
        }
        $this->doSync();
        if ($can('listing')) {
            $out['photos'] = $this->qn('photo') + $this->qn('edit');
            $out['upload'] = $this->qn('upload');
            $out['handover'] = (int) Db::val('SELECT COUNT(*) n FROM sl_items WHERE handed_at IS NULL AND located_at IS NULL AND uploaded_at IS NOT NULL');
        }
        if ($can('warehouse') || $can('wms')) {
            $out['put-away-in'] = (int) Db::val("SELECT COUNT(*) n FROM sl_handover_items x JOIN sl_handovers h ON h.id=x.handover_id WHERE h.status='sent' AND x.located=0 AND x.extra=0");
        }
        if ($can('wms') || $can('listing')) {
            $out['sorting'] = count(array_filter($this->lineLots(false), fn ($l) => $l['status'] === 'to_sort' || ($l['status'] === 'qc' && $l['counts']['sorted'] > 0)));
        }
        if ($can('listing') || $can('wms') || $can('team')) {
            $out['stockline'] = array_sum(array_column($this->stuckList(''), 'n'));
        }
        return $out;
    }

    public function alerts(array $u): array
    {
        $can = fn ($p) => $this->can($u, $p);
        $out = [];
        $st = $this->S();
        $boss = $can('team') || ($u['role'] ?? null) === 'admin';
        if ($can('listing') || $can('wms') || $can('team')) {
            $this->doSync();
            $lots = $this->lineLots(false);
            $ls = $this->lotStuck($lots);
            $uns = array_values(array_filter($ls, fn ($x) => $x['stage'] === 'grn'));
            if ($uns && ($can('wms') || $can('listing') || $boss)) {
                $n = count($uns);
                $out[] = ['level' => 'warn', 'text' => "{$n} lot".($n > 1 ? 's' : '')." received but not sorted after {$st['unsortedDays']} day".($st['unsortedDays'] > 1 ? 's' : '').': '.implode(', ', array_map(fn ($x) => $x['lot'], array_slice($uns, 0, 3))), 'href' => '#/sorting'];
            }
            foreach (array_slice(array_values(array_filter($ls, fn ($x) => $x['stage'] !== 'grn')), 0, 3) as $x) {
                $out[] = ['level' => 'warn', 'text' => "{$x['lot']}: {$x['n']} pairs ".strtolower($x['label'])." for {$x['days']} days", 'href' => '#/sorting/lot/'.self::encodeURIComponent((string) $x['lot'])];
            }
            foreach ($this->stuckList('') as $s) {
                $out[] = ['level' => $s['days'] >= $st['stuckDays'] * 2 ? 'bad' : 'warn', 'text' => "{$s['n']} pair".($s['n'] > 1 ? 's' : '')." waiting for {$s['next']} over {$st['stuckDays']} days (oldest {$s['days']} days)", 'href' => '#/stockline/stage/'.$s['stage']];
            }
        }
        // handover differences: the lister who sent it and the owner / managers
        foreach (Db::all("SELECT id, created_by, diff FROM sl_handovers WHERE status='received' AND diff IS NOT NULL AND received_at>=(UTC_TIMESTAMP() - INTERVAL 3 DAY)") as $h) {
            if (! ($boss || (int) $h['created_by'] === (int) $u['id'])) {
                continue;
            }
            $d = $this->J($h['diff'], []);
            $d = is_array($d) ? $d : [];
            $mi = is_array($d['missing'] ?? null) ? $d['missing'] : [];
            $ex = is_array($d['extra'] ?? null) ? $d['extra'] : [];
            $parts = array_values(array_filter([
                $mi ? 'did not get '.count($mi).' pair'.(count($mi) > 1 ? 's' : '').' ('.implode(', ', array_slice($mi, 0, 3)).')' : null,
                $ex ? 'got '.count($ex).' extra' : null,
            ]));
            $out[] = ['level' => 'bad', 'text' => "Handover #{$h['id']}: warehouse ".implode(' and ', $parts), 'href' => '#/handover/h/'.$h['id']];
        }
        return $out;
    }
}
