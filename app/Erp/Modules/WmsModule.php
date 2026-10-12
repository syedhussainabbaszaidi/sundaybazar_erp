<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;

/**
 * WMS — warehouse control: racks & slots, receiving (GRN), put-away, cycle counts, damage register, transfers, KPIs.
 * Port of legacy/server/modules/wms.js.
 *
 * Services (ctx.services.wms):
 *   summary(), receiveReturn($sku, $note, $userId), lots(), dueRacks(), postGrn($name, $uid),
 *   putaway($uid, $b, $o = []), ensureSlot($code), curLoc($sku), transfer($dest, $skus, $note, $userId)
 *   SLOT_RE (a JS RegExp in the original) is exposed as the PCRE pattern in the public const SLOT_RE,
 *   as slotRe(): string (same pattern) and as isSlot($s): bool (= SLOT_RE.test(s)).
 */
class WmsModule extends Module
{
    public string $name = 'wms';

    /** PCRE twin of the JS SLOT_RE /^([A-Z0-9]+)-R(\d+)-C(\d+)-L(\d+)$/ (D = "$" does not accept a trailing newline, as in JS). */
    public const SLOT_RE = '/^([A-Z0-9]+)-R(\d+)-C(\d+)-L(\d+)$/D';

    private const DESTS = ['OUTLET' => 'Outlet', 'REPAIR' => 'Repair', 'SUPPLIER' => 'Return to supplier', 'STUDIO' => 'Photo studio'];

    private const REASONS = ['torn', 'sole broken', 'stain', 'mold', 'missing pair', 'other'];

    private const AWAY_SQL = "COALESCE(l.location,p.rack,'') NOT IN ('DAMAGED','OUTLET','REPAIR','SUPPLIER','STUDIO','MISSING') AND COALESCE(l.location,'') NOT LIKE 'TRANSIT-%'";

    private const LOC = "UPPER(COALESCE(l.location, p.rack, ''))";

    private const FROM = 'products p LEFT JOIN locations l ON l.sku=p.sku';

    public function perms(): array
    {
        return [];
    }

    public function activity(): array
    {
        return [
            'wms.putaway' => 'Put away pair', 'wms.move' => 'Moved pair', 'wms.counted' => 'Counted slot', 'wms.count.create' => 'Created stock count', 'wms.count.finish' => 'Finished stock count',
            'wms.count.approve' => 'Approved count adjustments', 'wms.grn' => 'Received lot', 'wms.damage.report' => 'Reported damage', 'wms.damage.approve' => 'Approved damage write-off',
            'wms.transfer.send' => 'Sent transfer', 'wms.transfer.receive' => 'Received transfer', 'wms.slots.generate' => 'Set up rack slots', 'wms.missing.resolve' => 'Resolved missing pair',
        ];
    }

    public function routes(Router $r): void
    {
        $r->get('/api/wms/racks', 'inventory', 'racksList');
        $r->get('/api/wms/racks/:rack', 'inventory', 'rackShow');
        $r->get('/api/wms/slots', 'inventory', 'slotsList');
        $r->get('/api/wms/slot/:code', 'inventory', 'slotShow');
        $r->post('/api/wms/slots/generate', 'wms', 'slotsGenerate');
        $r->post('/api/wms/slots/update', 'wms', 'slotsUpdate');
        $r->post('/api/wms/putaway', 'wms', 'putawayRoute');
        $r->get('/api/wms/moves', 'inventory', 'movesList');
        $r->get('/api/wms/lots', 'wms', 'lotsList');
        $r->post('/api/wms/lots/:name/receive', 'wms', 'lotReceive');
        $r->get('/api/wms/people', 'wms', 'people');
        $r->get('/api/wms/counts', 'wms', 'countsList');
        $r->post('/api/wms/counts', 'wms', 'countCreate');
        $r->get('/api/wms/counts/:id', 'wms', 'countShow');
        $r->post('/api/wms/counts/:id/scan', 'wms', 'countScan');
        $r->post('/api/wms/counts/:id/unscan', 'wms', 'countUnscan');
        $r->post('/api/wms/counts/:id/slot-done', 'wms', 'countSlotDone');
        $r->post('/api/wms/counts/:id/move', 'wms', 'countMove');
        $r->post('/api/wms/counts/:id/finish', 'wms', 'countFinish');
        $r->post('/api/wms/counts/:id/approve', 'wms', 'countApprove');
        $r->post('/api/wms/counts/:id/cancel', 'wms', 'countCancel');
        $r->get('/api/wms/missing', 'wms', 'missingList');
        $r->post('/api/wms/missing/:id/resolve', 'wms', 'missingResolve');
        $r->get('/api/wms/damage', 'inventory', 'damageList');
        $r->post('/api/wms/damage', 'inventory', 'damageReport');
        $r->post('/api/wms/damage/:id/approve', 'wms', 'damageApprove');
        $r->get('/api/wms/transfers', 'wms', 'transfersList');
        $r->get('/api/wms/transfers/:id', 'wms', 'transferShow');
        $r->post('/api/wms/transfers', 'wms', 'transferCreate');
        $r->post('/api/wms/transfers/:id/receive', 'wms', 'transferReceive');
        $r->get('/api/wms/overview', 'dashboard', 'overview');
        $r->get('/api/wms/settings', 'wms', 'settingsGet');
        $r->post('/api/wms/settings', 'wms', 'settingsSave');
    }

    /* ================================================================ JS helpers */

    /** String(s == null ? '' : s).trim().toUpperCase() */
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

    /** JS truthiness ('0' and [] are truthy in JS) */
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

    /** a || b */
    private static function or($a, $b)
    {
        return self::truthy($a) ? $a : $b;
    }

    /** JS Number(v) (NAN when not numeric) */
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

    /** Date.parse of a DB 'Y-m-d H:i:s' (UTC) value, in ms; null when it cannot be read */
    private static function msOf(?string $s): ?float
    {
        if ($s === null || $s === '') {
            return null;
        }
        $t = strtotime(str_contains($s, 'Z') || str_contains($s, 'T') ? $s : $s.' UTC');
        return $t === false ? null : $t * 1000.0;
    }

    private static function nowMs(): float
    {
        return floor(microtime(true) * 1000);
    }

    /** Is this a rack slot code (SLOT_RE.test(s))? */
    public function isSlot($s): bool
    {
        return is_string($s) && preg_match(self::SLOT_RE, $s) === 1;
    }

    /** services.wms.SLOT_RE as a PCRE pattern string (use with preg_match). */
    public function slotRe(): string
    {
        return self::SLOT_RE;
    }

    private static function rackOf($loc): string
    {
        $loc = self::up($loc);
        if (preg_match(self::SLOT_RE, $loc, $m)) {
            return $m[1];
        }
        $first = explode('-', $loc)[0];
        return $first !== '' ? $first : '?';
    }

    /* ================================================================ shared helpers */

    /** Settings with defaults */
    private function S(): array
    {
        $s = $this->setting('wms.settings', []);
        return array_merge(['countEvery' => 30, 'stuckDays' => 7, 'stuckPct' => 50, 'varianceAlert' => 5, 'defaultCapacity' => 12], is_array($s) ? $s : []);
    }

    private function acc(): ?Module
    {
        $a = $this->svc('accounts');
        return $a && method_exists($a, 'post') ? $a : null;
    }

    private function post(array $entry, $uid): array
    {
        $a = $this->acc();
        if (! $a) {
            return ['posted' => false, 'error' => null];
        }
        try {
            $a->post($entry, $uid);
            return ['posted' => true, 'error' => null];
        } catch (\Throwable $e) {
            return ['posted' => false, 'error' => $e->getMessage()];
        }
    }

    private function product($sku): ?array
    {
        return Db::get('SELECT p.sku, p.title, p.qty, p.cost, p.price, p.lot, p.size, p.created_at, '.self::LOC.' loc, l.location rawloc FROM '.self::FROM.' WHERE UPPER(p.sku)=? ORDER BY p.qty DESC LIMIT 1', self::up($sku));
    }

    /** Current location of a pair (core locations, else the product rack). */
    public function curLoc($sku): ?string
    {
        $r = Db::get('SELECT location FROM locations WHERE UPPER(sku)=?', self::up($sku));
        if ($r) {
            return $r['location'];
        }
        $p = Db::get('SELECT rack FROM products WHERE UPPER(sku)=? LIMIT 1', self::up($sku));
        return $p ? $p['rack'] : null;
    }

    /** core location update + stock move (the one place WMS changes where a pair is) */
    private function setLoc($sku, $to, string $reason, $uid): ?string
    {
        $sku = self::up($sku);
        $from = $this->curLoc($sku);
        Db::run('INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE location=VALUES(location), updated_at=VALUES(updated_at), updated_by=VALUES(updated_by)', $sku, $to, $uid);
        Db::run('INSERT INTO stock_moves(sku,from_loc,to_loc,reason,user_id) VALUES(?,?,?,?,?)', $sku, self::truthy($from) ? $from : null, $to, $reason, $uid);
        return $from;
    }

    private function slotRow($code): ?array
    {
        return Db::get('SELECT * FROM wms_slots WHERE code=?', self::up($code));
    }

    private function inSlot($code): int
    {
        return (int) Db::val('SELECT COUNT(*) n FROM '.self::FROM.' WHERE p.qty>0 AND '.self::LOC.'=?', self::up($code));
    }

    /** loc => ['loc','n','cost'] */
    private function locCounts(): array
    {
        $m = [];
        foreach (Db::all('SELECT '.self::LOC.' loc, COUNT(*) n, SUM(p.cost) cost FROM '.self::FROM.' WHERE p.qty>0 GROUP BY 1') as $r) {
            $m[(string) $r['loc']] = $r;
        }
        return $m;
    }

    private function isWms(?array $u): bool
    {
        return $this->can($u, 'wms');
    }

    /** per good pair, same rule as the lister: (cost + extra) / (pieces - planned bad) */
    private static function lotPP(array $l)
    {
        if (($l['per_piece'] ?? 0) > 0) {
            return $l['per_piece'];
        }
        $bad = self::or($l['bad'] ?? null, 0);
        if (($l['cost'] ?? 0) > 0 && ($l['pieces'] ?? 0) > $bad) {
            return Logic::jsRound((self::n0($l['cost']) + self::n0($l['extra'] ?? null)) / ($l['pieces'] - $bad));
        }
        return 0;
    }

    /* ================================================================ racks & slots */

    private function rackSummary(): array
    {
        $slots = Db::all('SELECT rack, zone, COUNT(*) slots, SUM(active) active, SUM(CASE WHEN active=1 THEN capacity ELSE 0 END) capacity FROM wms_slots GROUP BY rack');
        $by = [];
        foreach ($slots as $s) {
            $by[(string) $s['rack']] = ['rack' => $s['rack'], 'zone' => self::or($s['zone'], ''), 'slots' => $s['slots'], 'active' => $s['active'], 'capacity' => $s['capacity'], 'items' => 0, 'slotted' => 0, 'value' => 0, 'empty' => 0, 'full' => 0];
        }
        $known = [];
        $cap = [];
        foreach (Db::all('SELECT code, capacity FROM wms_slots WHERE active=1') as $r) {
            $known[$r['code']] = true;
            $cap[$r['code']] = $r['capacity'];
        }
        $used = [];
        foreach (Db::all('SELECT '.self::LOC.' loc, COUNT(*) n, SUM(p.cost) cost FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL.' GROUP BY 1') as $r) {
            $rk = self::rackOf(self::or($r['loc'], '?'));
            if (! isset($by[$rk])) {
                $by[$rk] = ['rack' => $rk, 'zone' => '', 'slots' => 0, 'active' => 0, 'capacity' => 0, 'items' => 0, 'slotted' => 0, 'value' => 0, 'empty' => 0, 'full' => 0];
            }
            $by[$rk]['items'] += $r['n'];
            $by[$rk]['value'] += self::or($r['cost'], 0);
            if (isset($known[$r['loc']])) {
                $by[$rk]['slotted'] += $r['n'];
                $used[$r['loc']] = $r['n'];
            }
        }
        foreach ($cap as $code => $c) {
            $rk = self::rackOf((string) $code);
            if (! isset($by[$rk])) {
                continue;
            }
            $n = $used[$code] ?? 0;
            if (! $n) {
                $by[$rk]['empty']++;
            } elseif ($n >= $c) {
                $by[$rk]['full']++;
            }
        }
        $out = [];
        foreach ($by as $x) {
            $x['rack'] = (string) $x['rack'];
            $x['fill'] = $x['capacity'] ? Logic::jsRound(100 * $x['slotted'] / $x['capacity']) : null;
            $out[] = $x;
        }
        usort($out, fn ($a, $b) => strcmp($a['rack'], $b['rack']));
        return $out;
    }

    public function racksList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['racks' => $this->rackSummary(), 'settings' => $this->S()];
    }

    public function rackShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $rack = self::up($p['rack'] ?? '');
        $lc = $this->locCounts();
        $slots = array_map(function ($s) use ($lc) {
            $c = $lc[$s['code']] ?? ['n' => 0, 'cost' => 0];
            return $s + ['items' => $c['n'], 'cost' => self::or($c['cost'], 0)];
        }, Db::all('SELECT * FROM wms_slots WHERE rack=? ORDER BY `row`, col, level', $rack));
        $codes = array_flip(array_column($slots, 'code'));
        $other = array_values(array_filter(Db::all('SELECT '.self::LOC.' loc, COUNT(*) n FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL.' GROUP BY 1'),
            fn ($r) => self::rackOf($r['loc']) === $rack && ! isset($codes[$r['loc']])));
        return ['rack' => $rack, 'slots' => $slots, 'unslotted' => $other];
    }

    public function slotsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $lc = $this->locCounts();
        $w = ['1=1'];
        $a = [];
        if (self::truthy($qs['rack'] ?? null)) {
            $w[] = 'rack=?';
            $a[] = self::up($qs['rack']);
        }
        if (($qs['active'] ?? null) !== 'all') {
            $w[] = 'active=1';
        }
        $rows = array_map(fn ($s) => $s + ['items' => ($lc[$s['code']]['n'] ?? 0) ?: 0], Db::all('SELECT * FROM wms_slots WHERE '.implode(' AND ', $w).' ORDER BY rack,`row`,col,level', ...$a));
        if (($qs['empty'] ?? null) === '1') {
            $rows = array_values(array_filter($rows, fn ($s) => $s['items'] === 0));
        }
        if (($qs['free'] ?? null) === '1') {
            $rows = array_values(array_filter($rows, fn ($s) => $s['items'] < $s['capacity']));
        }
        $lim = self::n0($qs['limit'] ?? null);
        return array_slice($rows, 0, $lim ? (int) $lim : 2000);
    }

    public function slotShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $code = self::up($p['code'] ?? '');
        $s = $this->slotRow($code);
        $items = Db::all('SELECT p.sku, p.title, p.size, p.cost, p.price, p.created_at FROM '.self::FROM.' WHERE p.qty>0 AND '.self::LOC.'=? ORDER BY p.sku', $code);
        return ['code' => $code, 'slot' => $s ?: null, 'known' => (bool) $s, 'looksLikeSlot' => $this->isSlot($code), 'items' => $items, 'capacity' => $s ? $s['capacity'] : null];
    }

    public function slotsGenerate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $raw = mb_strtoupper(self::truthy($b['racks'] ?? null) ? (is_string($b['racks']) ? $b['racks'] : self::up($b['racks'])) : '');
        $list = [];
        foreach (array_filter(preg_split('/[\s,]+/u', $raw), fn ($x) => $x !== '') as $t) {
            if (preg_match('/^([A-Z])-([A-Z])$/D', $t, $m)) {
                for ($c = ord($m[1]); $c <= ord($m[2]); $c++) {
                    $list[] = chr($c);
                }
            } else {
                $list[] = $t;
            }
        }
        $this->need($list && ! array_filter($list, fn ($r) => ! preg_match('/^[A-Z0-9]{1,4}$/D', $r)), 'Racks: letters like A, B, C or a range A-D');
        $rows = self::n0($b['rows'] ?? null);
        $cols = self::n0($b['cols'] ?? null);
        $levels = self::n0($b['levels'] ?? null);
        $capv = self::n0($b['capacity'] ?? null) ?: $this->S()['defaultCapacity'];
        $this->need($rows > 0 && $cols > 0 && $levels > 0 && $rows <= 50 && $cols <= 50 && $levels <= 20, 'Rows, columns and levels must be between 1 and 50');
        $this->need(count($list) * $rows * $cols * $levels <= 20000, 'Too many slots at once');
        $made = 0;
        $updated = 0;
        $zone = self::or($b['zone'] ?? null, '');
        Db::tx(function () use ($list, $rows, $cols, $levels, $capv, $b, $zone, &$made, &$updated) {
            foreach ($list as $rk) {
                for ($r = 1; $r <= $rows; $r++) {
                    for ($c = 1; $c <= $cols; $c++) {
                        for ($l = 1; $l <= $levels; $l++) {
                            $code = "{$rk}-R{$r}-C{$c}-L{$l}";
                            if ($this->slotRow($code)) {
                                if (self::truthy($b['overwrite'] ?? null)) {
                                    Db::run('UPDATE wms_slots SET capacity=?, zone=?, active=1 WHERE code=?', $capv, $zone, $code);
                                    $updated++;
                                }
                            } else {
                                Db::run('INSERT INTO wms_slots(code,zone,rack,`row`,col,level,capacity) VALUES(?,?,?,?,?,?,?)', $code, $zone, $rk, $r, $c, $l, $capv);
                                $made++;
                            }
                        }
                    }
                }
            }
        });
        $this->log($u['id'], 'wms.slots.generate', 'wms:slots', ['racks' => $list, 'rows' => $rows, 'cols' => $cols, 'levels' => $levels, 'capacity' => $capv, 'made' => $made, 'updated' => $updated]);
        return ['ok' => true, 'made' => $made, 'updated' => $updated, 'racks' => $list];
    }

    public function slotsUpdate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $codes = array_values(array_filter(array_map([self::class, 'up'], is_array($b['codes'] ?? null) ? $b['codes'] : []), fn ($x) => $x !== ''));
        $this->need($codes, 'Pick some slots');
        Db::tx(function () use ($codes, $b) {
            foreach ($codes as $c) {
                if (isset($b['capacity']) && $b['capacity'] !== '') {
                    $n = self::num($b['capacity']);
                    Db::run('UPDATE wms_slots SET capacity=? WHERE code=?', is_float($n) && is_nan($n) ? null : max(0, $n), $c);
                }
                if (array_key_exists('active', $b) && $b['active'] !== null) {
                    Db::run('UPDATE wms_slots SET active=? WHERE code=?', self::truthy($b['active']) ? 1 : 0, $c);
                }
                if (array_key_exists('zone', $b) && $b['zone'] !== null) {
                    Db::run('UPDATE wms_slots SET zone=? WHERE code=?', $b['zone'], $c);
                }
            }
        });
        $this->log($u['id'], 'wms.slots.update', 'wms:slots', ['n' => count($codes), 'capacity' => $b['capacity'] ?? null, 'active' => $b['active'] ?? null]);
        return ['ok' => true, 'n' => count($codes)];
    }

    /* ================================================================ put-away & moves */

    public function putawayRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->putaway($u['id'], $b);
    }

    /**
     * Service: one pair onto a slot: core locations + stock_moves (also used by the Stock line warehouse receive).
     * $b = ['slot','sku','reason'?]; $o['silent'] = caller logs its own event.
     */
    public function putaway($uid, array $b, array $o = []): array
    {
        $slot = self::up($b['slot'] ?? null);
        $sku = self::up($b['sku'] ?? null);
        $this->need($slot !== '', 'Scan a slot first');
        $this->need($sku !== '', 'Scan a SKU');
        $this->need(! $this->isSlot($sku), $sku.' is a slot label, not a shoe');
        $warn = [];
        $s = $this->slotRow($slot);
        $p = $this->product($sku);
        if (! $s) {
            $warn[] = $this->isSlot($slot) ? "Slot {$slot} is not in the rack setup" : "{$slot} is not a rack slot code";
        } elseif (! $s['active']) {
            $warn[] = "Slot {$slot} is switched off";
        }
        if (! $p) {
            $warn[] = "{$sku} is unknown (not in products)";
        } elseif ($p['qty'] <= 0) {
            $warn[] = "{$sku} is SOLD / out of stock";
        }
        if ($p && $p['loc'] === $slot) {
            return ['ok' => true, 'sku' => $sku, 'slot' => $slot, 'same' => true, 'product' => $p, 'warnings' => $warn, 'inSlot' => $this->inSlot($slot), 'capacity' => $s ? $s['capacity'] : null];
        }
        $reason = in_array($b['reason'] ?? null, ['putaway', 'move'], true) ? $b['reason'] : ($p && self::truthy($p['rawloc']) ? 'move' : 'putaway');
        $from = $this->setLoc($sku, $slot, $reason, $uid);
        $n = $this->inSlot($slot);
        if ($s && $n > $s['capacity']) {
            $warn[] = "Slot {$slot} is over capacity ({$n} / {$s['capacity']})";
        }
        $miss = Db::get("SELECT id FROM wms_missing WHERE UPPER(sku)=? AND status='open'", $sku);
        if ($miss) {
            Db::run("UPDATE wms_missing SET status='found', resolved_by=?, resolved_at=UTC_TIMESTAMP(), note=CONCAT(COALESCE(note,''), ?) WHERE id=?", $uid, ' Found at '.$slot, $miss['id']);
            $warn[] = "{$sku} was on the Missing list: marked found";
        }
        if (empty($o['silent'])) {
            $this->log($uid, $reason === 'move' ? 'wms.move' : 'wms.putaway', 'sku:'.$sku, ['from' => $from, 'to' => $slot]);
        }
        return ['ok' => true, 'sku' => $sku, 'slot' => $slot, 'from' => $from, 'reason' => $reason, 'product' => $p ?: null, 'warnings' => $warn, 'inSlot' => $n, 'capacity' => $s ? $s['capacity'] : null];
    }

    /** Service: a valid slot code that is not in the rack setup yet gets its slot record (default capacity). */
    public function ensureSlot($code): ?array
    {
        $code = self::up($code);
        if (! preg_match(self::SLOT_RE, $code, $m)) {
            return null;
        }
        $s = $this->slotRow($code);
        if ($s) {
            return $s;
        }
        Db::run('INSERT INTO wms_slots(code,zone,rack,`row`,col,level,capacity) VALUES(?,?,?,?,?,?,?)', $code, '', $m[1], (int) $m[2], (int) $m[3], (int) $m[4], $this->S()['defaultCapacity']);
        return $this->slotRow($code);
    }

    public function movesList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $has = self::truthy($qs['sku'] ?? null);
        $w = $has ? 'WHERE UPPER(m.sku)=?' : '';
        $a = $has ? [self::up($qs['sku'])] : [];
        $lim = (int) min(500, self::n0($qs['limit'] ?? null) ?: 100);
        return Db::all("SELECT m.*, us.name `user` FROM stock_moves m LEFT JOIN users us ON us.id=m.user_id {$w} ORDER BY m.id DESC LIMIT ?", ...array_merge($a, [$lim]));
    }

    /* ================================================================ receiving (GRN) */

    /** Service `lots`: every lot with its receiving / listing status. */
    public function lots(): array
    {
        return $this->lotRows();
    }

    private function lotRows(): array
    {
        $listed = [];
        foreach (Db::all("SELECT lot, COUNT(*) n, MAX(at) last FROM (SELECT sku, lot, at FROM listings WHERE lot<>'' UNION SELECT sku, lot, created_at at FROM products WHERE lot<>'' AND sku NOT IN (SELECT sku FROM listings)) t GROUP BY lot") as $r) {
            $listed[(string) $r['lot']] = $r;
        }
        $grn = [];
        foreach (Db::all('SELECT g.*, us.name received_name FROM wms_grn g LEFT JOIN users us ON us.id=g.received_by') as $g) {
            $grn[(string) $g['lot']] = $g;
        }
        $st = $this->S();
        $now = self::nowMs();
        return array_map(function ($l) use ($listed, $grn, $st, $now) {
            $g = $grn[(string) $l['name']] ?? null;
            $n = ($listed[(string) $l['name']]['n'] ?? 0) ?: 0;
            $target = $g ? (self::or($g['good'], 0)) : (self::or($l['pieces'], 0));
            $pctListed = $target ? min(100, Logic::jsRound(100 * $n / $target)) : ($n ? 100 : 0);
            $status = ! $g && ! $n ? 'not_received' : (($target && $n >= $target) ? 'fully_listed' : ($n > 0 ? 'listing' : 'received'));
            $days = null;
            if ($g && self::truthy($g['received_at'])) {
                $ms = self::msOf($g['received_at']);
                $days = $ms === null ? null : (int) floor(($now - $ms) / 864e5);
            }
            $stuck = (bool) ($g && $days !== null && $days > $st['stuckDays'] && $pctListed < $st['stuckPct']);
            return ['name' => $l['name'], 'vendor' => self::or($l['vendor'], ''), 'bought_on' => self::or($l['bought_on'], ''), 'pieces' => self::or($l['pieces'], 0), 'cost' => self::or($l['cost'], 0), 'per_piece' => self::lotPP($l), 'kind' => self::or($l['kind'], ''),
                'received' => (bool) $g, 'grn' => $g ? array_merge($g, ['photos' => $this->J($g['photos'], [])]) : null, 'listed' => $n, 'pctListed' => $pctListed, 'status' => $status, 'days' => $days, 'stuck' => $stuck, 'unlisted' => max(0, $target - $n)];
        }, Db::all('SELECT * FROM lots ORDER BY COALESCE(bought_on, updated_at) DESC'));
    }

    public function lotsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['lots' => $this->lotRows(), 'settings' => $this->S(), 'accounts' => (bool) $this->acc()];
    }

    /**
     * Service: accounts posting of a received lot.
     * The lot sits in Purchases at its full cost (+ extra costs) from the day it was bought. Receiving moves ALL of it to Unlisted Inventory,
     * so Purchases clears to zero. Pairs the lot plan already expected to be bad are part of the good pairs' cost;
     * only damage beyond the plan is written off now. (Also called by Purchasing when a supplier bill changes the lot cost.)
     * @return array{posted: bool, error: ?string}
     */
    public function postGrn($name, $uid): array
    {
        $l = Db::get('SELECT * FROM lots WHERE name=?', $name);
        $g = Db::get('SELECT * FROM wms_grn WHERE lot=?', $name);
        $posting = ['posted' => false, 'error' => null];
        if (! $l || ! $g) {
            return $posting;
        }
        $pp = self::lotPP($l);
        $good = self::n0($g['good']);
        $damaged = self::n0($g['damaged']);
        $value = Logic::jsRound(($good + $damaged) * $pp);
        $at = self::or($g['received_at'], gmdate('Y-m-d H:i:s'));
        if ($g['per_piece'] === null || (float) $pp != (float) $g['per_piece'] || $g['value'] === null || (float) $value != (float) $g['value']) {
            Db::run('UPDATE wms_grn SET per_piece=?, `value`=? WHERE lot=?', $pp, $value, $name);
        }
        $total = Logic::jsRound((self::n0($l['cost']) + self::n0($l['extra'])) * 100) / 100;
        if ($value > 0 && $total > 0) {
            $extraBad = max(0, $damaged - self::n0($l['bad']));
            $dmg = min($total, Logic::jsRound($extraBad * $pp));
            $lines = [['account' => 'Unlisted Inventory', 'debit' => Logic::jsRound(($total - $dmg) * 100) / 100]];
            if ($dmg) {
                $lines[] = ['account' => 'Inventory Damage', 'debit' => $dmg];
            }
            $lines[] = ['account' => 'Purchases', 'credit' => $total];
            $ms = self::msOf($at) ?? self::nowMs();
            $posting = $this->post([
                'date' => gmdate('Y-m-d', (int) floor($ms / 1000) + 5 * 3600),
                'memo' => "Lot received: {$name} ({$good} good, {$damaged} damaged)", 'source' => 'grn', 'source_id' => $name,
                'lines' => array_values(array_filter($lines, fn ($x) => (array_key_exists('debit', $x) && $x['debit'] != 0) || self::truthy($x['credit'] ?? null))),
            ], $uid);
        } elseif (! $pp || ! $total) {
            $posting['error'] = 'Lot has no cost yet: nothing posted';
        }
        Db::run('UPDATE wms_grn SET posted=?, post_error=? WHERE lot=?', $posting['posted'] ? 1 : 0, $posting['error'], $name);
        return $posting;
    }

    public function lotReceive(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $name = $p['name'];
        $l = Db::get('SELECT * FROM lots WHERE name=?', $name);
        $this->need($l, 'Lot not found', 404);
        $good = max(0, Logic::jsRound(self::n0($b['good'] ?? null)));
        $damaged = max(0, Logic::jsRound(self::n0($b['damaged'] ?? null)));
        $this->need($good + $damaged > 0, 'Enter the counted pieces');
        $pur = $this->svc('purchasing'); // lot bought on a purchase order (Purchasing): cost follows the pieces received, PO gets its purchase posting
        $expected = isset($b['expected']) && $b['expected'] !== '' ? self::num($b['expected']) : self::or($l['pieces'], 0);
        if (is_float($expected) && is_nan($expected)) {
            $expected = null;
        }
        $pp = self::lotPP($l);
        $diff = $expected === null ? null : $good + $damaged - $expected;
        $value = Logic::jsRound(($good + $damaged) * $pp);
        $at = self::truthy($b['received_at'] ?? null)
            ? mb_substr(str_replace('T', ' ', (string) $b['received_at']), 0, 19)
            : gmdate('Y-m-d H:i:s');
        $photos = array_values(array_filter(is_array($b['photos'] ?? null) ? $b['photos'] : [], [self::class, 'truthy']));
        Db::run('INSERT INTO wms_grn(lot,expected,good,damaged,diff,notes,photos,per_piece,`value`,received_by,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE expected=VALUES(expected), good=VALUES(good), damaged=VALUES(damaged), diff=VALUES(diff), notes=VALUES(notes), photos=VALUES(photos),
            per_piece=VALUES(per_piece), `value`=VALUES(`value`), received_by=VALUES(received_by), received_at=VALUES(received_at)',
            $name, $expected, $good, $damaged, $diff, self::or($b['notes'] ?? null, ''), json_encode($photos, JSON_UNESCAPED_UNICODE), $pp, $value, self::n0($b['received_by'] ?? null) ?: $u['id'], $at);
        $po = null;
        if ($pur && method_exists($pur, 'afterGrn')) {
            try {
                $po = $pur->afterGrn($name, ['good' => $good, 'damaged' => $damaged, 'expected' => $expected, 'at' => $at], $u['id']);
            } catch (\Throwable $e) {
                $po = ['error' => $e->getMessage()];
            }
        }
        $posting = $this->postGrn($name, $u['id']);
        $g2 = Db::get('SELECT per_piece, `value` FROM wms_grn WHERE lot=?', $name) ?: ['per_piece' => $pp, 'value' => $value];
        $this->log($u['id'], 'wms.grn', 'lot:'.$name, ['expected' => $expected, 'good' => $good, 'damaged' => $damaged, 'diff' => $diff, 'value' => $g2['value']]);
        return array_merge(['ok' => true, 'lot' => $name, 'expected' => $expected, 'good' => $good, 'damaged' => $damaged, 'diff' => $diff, 'per_piece' => $g2['per_piece'], 'value' => $g2['value']], $posting, ['po' => $po]);
    }

    public function people(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $out = [];
        foreach (Db::all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name') as $x) {
            $pm = Access::userPerms($x);
            if (in_array('wms', $pm, true) || in_array('warehouse', $pm, true) || in_array('inventory', $pm, true)) {
                $out[] = ['id' => $x['id'], 'name' => $x['name'], 'role' => $x['role']];
            }
        }
        return $out;
    }

    /* ================================================================ stock counts */

    private function countRow($id): array
    {
        $c = Db::get('SELECT c.*, us.name assigned_name FROM wms_counts c LEFT JOIN users us ON us.id=c.assigned_to WHERE c.id=?', (int) self::n0($id));
        $this->need($c, 'Count not found', 404);
        $c['slots'] = $this->J($c['slots'], []);
        $c['summary'] = $this->J($c['summary'], null);
        return $c;
    }

    private function rackSlots(string $rack): array
    {
        $s = array_column(Db::all('SELECT code FROM wms_slots WHERE rack=? AND active=1 ORDER BY `row`,col,level', $rack), 'code');
        $extra = array_values(array_filter(array_column(Db::all('SELECT DISTINCT '.self::LOC.' loc FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL), 'loc'),
            fn ($l) => self::truthy($l) && self::rackOf($l) === $rack && ! in_array($l, $s, true)));
        sort($extra, SORT_STRING);
        return array_merge($s, $extra);
    }

    private function countState(array $c, bool $allSlots): array
    {
        $scans = Db::all('SELECT s.*, p.title, p.cost, p.size FROM wms_count_scans s LEFT JOIN products p ON UPPER(p.sku)=UPPER(s.sku) WHERE s.count_id=? ORDER BY s.id DESC', $c['id']);
        $done = Db::all('SELECT slot, done_at FROM wms_count_slots WHERE count_id=?', $c['id']);
        $doneSet = [];
        foreach ($done as $d) {
            $doneSet[$d['slot']] = true;
        }
        $scanned = [];
        foreach ($scans as $s) {
            $scanned[self::up($s['sku'])] = true;
        }
        $consider = $allSlots ? $c['slots'] : array_values(array_filter($c['slots'], fn ($s) => isset($doneSet[$s])));
        $expected = $consider ? Db::all('SELECT p.sku, p.title, p.cost, p.size, '.self::LOC.' loc FROM '.self::FROM.' WHERE p.qty>0 AND '.self::LOC.' IN ('.Db::marks($consider).')', ...$consider) : [];
        $missing = array_values(array_filter($expected, fn ($e) => ! isset($scanned[self::up($e['sku'])])));
        $found = array_values(array_filter($scans, fn ($s) => $s['result'] === 'found'));
        $extra = array_values(array_filter($scans, fn ($s) => $s['result'] === 'extra'));
        $unknown = array_values(array_filter($scans, fn ($s) => $s['result'] === 'unknown'));
        $v = fn ($a) => Logic::jsRound(array_reduce($a, fn ($t, $x) => $t + self::n0($x['cost'] ?? null), 0));
        $perSlot = [];
        foreach ($c['slots'] as $sl) {
            $perSlot[$sl] = ['slot' => $sl, 'scanned' => 0, 'done' => isset($doneSet[$sl])];
        }
        foreach ($scans as $s) {
            if (isset($perSlot[$s['slot']])) {
                $perSlot[$s['slot']]['scanned']++;
            }
        }
        $expAll = $c['slots'] ? Db::all('SELECT '.self::LOC.' loc, COUNT(*) n FROM '.self::FROM.' WHERE p.qty>0 AND '.self::LOC.' IN ('.Db::marks($c['slots']).') GROUP BY 1', ...$c['slots']) : [];
        foreach ($expAll as $r) {
            if (isset($perSlot[$r['loc']])) {
                $perSlot[$r['loc']]['expected'] = $r['n'];
            }
        }
        $fn = count($found);
        $mn = count($missing);
        return ['scans' => $scans, 'found' => $found, 'extra' => $extra, 'unknown' => $unknown, 'missing' => $missing, 'slots' => array_values($perSlot), 'slotsDone' => count($doneSet),
            'totals' => ['found' => $fn, 'missing' => $mn, 'extra' => count($extra), 'unknown' => count($unknown), 'foundValue' => $v($found), 'missingValue' => $v($missing), 'extraValue' => $v($extra),
                'accuracy' => $fn + $mn ? Logic::jsRound(100 * $fn / ($fn + $mn)) : 100]];
    }

    /** Service: racks and when they were last counted (due = count needed). */
    public function dueRacks(): array
    {
        $every = $this->S()['countEvery'];
        $racks = [];
        foreach (Db::all('SELECT DISTINCT rack FROM wms_slots WHERE active=1') as $r) {
            $racks[(string) $r['rack']] = true;
        }
        foreach (Db::all('SELECT DISTINCT '.self::LOC.' loc FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL) as $r) {
            if (self::truthy($r['loc'])) {
                $racks[self::rackOf($r['loc'])] = true;
            }
        }
        $last = [];
        foreach (Db::all("SELECT rack, MAX(COALESCE(approved_at, finished_at)) at FROM wms_counts WHERE status IN ('done','review') AND rack IS NOT NULL GROUP BY rack") as $r) {
            $last[(string) $r['rack']] = $r['at'];
        }
        $open = [];
        foreach (Db::all("SELECT rack FROM wms_counts WHERE status IN ('open','counting') AND rack IS NOT NULL") as $r) {
            $open[(string) $r['rack']] = true;
        }
        $now = self::nowMs();
        $keys = array_map('strval', array_keys($racks));
        sort($keys, SORT_STRING);
        return array_map(function ($rk) use ($last, $open, $now, $every) {
            $at = $last[$rk] ?? null;
            $ms = self::msOf($at);
            $days = $at ? ($ms === null ? null : (int) floor(($now - $ms) / 864e5)) : null;
            $isOpen = isset($open[$rk]);
            return ['rack' => $rk, 'last' => $at ?: null, 'days' => $days, 'open' => $isOpen, 'due' => ! $isOpen && ($days === null || $days >= $every)];
        }, $keys);
    }

    public function countsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $today = $this->pkToday();
        $rows = array_map(function ($c) use ($today) {
            $c['slots'] = count((array) $this->J($c['slots'], []));
            $c['summary'] = $this->J($c['summary'], null);
            // JS: [...].includes(status) && c.due && c.due < today  (keeps '' / null when due is empty)
            $c['overdue'] = in_array($c['status'], ['open', 'counting'], true) ? (self::truthy($c['due']) ? $c['due'] < $today : $c['due']) : false;
            return $c;
        }, Db::all('SELECT c.*, us.name assigned_name, (SELECT COUNT(*) FROM wms_count_scans s WHERE s.count_id=c.id) scanned FROM wms_counts c LEFT JOIN users us ON us.id=c.assigned_to
            '.(self::truthy($qs['all'] ?? null) ? '' : "WHERE c.status<>'cancelled'")." ORDER BY CASE c.status WHEN 'counting' THEN 0 WHEN 'open' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, c.id DESC LIMIT 200"));
        return ['counts' => $rows, 'due' => $this->dueRacks(), 'settings' => $this->S(), 'missingOpen' => (int) Db::val("SELECT COUNT(*) n FROM wms_missing WHERE status='open'")];
    }

    public function countCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $slots = [];
        $rack = null;
        if (self::truthy($b['rack'] ?? null)) {
            $rack = self::up($b['rack']);
            $slots = $this->rackSlots($rack);
            $this->need($slots, "Rack {$rack} has no slots or stock");
        } else {
            $raw = $b['slots'] ?? null;
            $str = is_array($raw) ? implode(',', array_map(fn ($x) => is_array($x) || $x === null ? '' : (string) self::up($x), $raw)) : (self::truthy($raw) ? (is_string($raw) ? $raw : self::up($raw)) : '');
            $slots = array_values(array_unique(array_filter(array_map([self::class, 'up'], preg_split('/[\s,]+/u', $str)), fn ($x) => $x !== '')));
            $this->need($slots, 'Choose a rack or list some slots');
        }
        $name = self::or($b['name'] ?? null, ($rack ? 'Rack '.$rack : count($slots).' slots').' · '.$this->pkToday());
        $id = Db::run('INSERT INTO wms_counts(name,rack,slots,assigned_to,due,created_by) VALUES(?,?,?,?,?,?)', $name, $rack, json_encode($slots, JSON_UNESCAPED_UNICODE),
            self::n0($b['assigned_to'] ?? null) ?: null, self::or($b['due'] ?? null, $this->pkToday()), $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'wms.count.create', 'count:'.$id, ['rack' => $rack, 'slots' => count($slots)]);
        return ['ok' => true, 'id' => $id, 'slots' => count($slots)];
    }

    public function countShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->countRow($p['id']);
        return array_merge(['count' => $c], $this->countState($c, in_array($c['status'], ['review', 'done'], true)));
    }

    private function openCount($id): array
    {
        $c = $this->countRow($id);
        $this->need(in_array($c['status'], ['open', 'counting'], true), 'This count is already finished');
        return $c;
    }

    public function countScan(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->openCount($p['id']);
        $slot = self::up($b['slot'] ?? null);
        $sku = self::up($b['sku'] ?? null);
        $this->need($slot !== '' && in_array($slot, $c['slots'], true), 'Slot '.($slot !== '' ? $slot : '?').' is not part of this count');
        $this->need($sku !== '', 'Scan a SKU');
        $this->need(! $this->isSlot($sku) && ! in_array($sku, $c['slots'], true), 'That is a slot label');
        $pr = $this->product($sku);
        $result = 'unknown';
        $rec = null;
        $sold = 0;
        if ($pr) {
            $rec = self::truthy($pr['loc']) ? $pr['loc'] : null;
            $sold = $pr['qty'] > 0 ? 0 : 1;
            $result = $pr['qty'] > 0 && $pr['loc'] === $slot ? 'found' : 'extra';
        }
        $prev = Db::get('SELECT slot FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=?', $c['id'], $sku);
        Db::run('INSERT INTO wms_count_scans(count_id,slot,sku,result,recorded_loc,sold,user_id) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE slot=VALUES(slot), result=VALUES(result),
            recorded_loc=VALUES(recorded_loc), sold=VALUES(sold), moved=0, user_id=VALUES(user_id), at=UTC_TIMESTAMP()', $c['id'], $slot, $sku, $result, $rec, $sold, $u['id']);
        if ($c['status'] === 'open') {
            Db::run("UPDATE wms_counts SET status='counting', started_at=UTC_TIMESTAMP() WHERE id=?", $c['id']);
        }
        return ['ok' => true, 'sku' => $sku, 'slot' => $slot, 'result' => $result, 'recorded' => $rec, 'sold' => (bool) $sold, 'product' => $pr ?: null, 'again' => $prev ? $prev['slot'] : null];
    }

    public function countUnscan(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->openCount($p['id']);
        Db::run('DELETE FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=?', $c['id'], self::up($b['sku'] ?? null));
        return ['ok' => true];
    }

    public function countSlotDone(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->openCount($p['id']);
        $slot = self::up($b['slot'] ?? null);
        $this->need(in_array($slot, $c['slots'], true), 'Slot not in this count');
        if (self::truthy($b['undo'] ?? null)) {
            Db::run('DELETE FROM wms_count_slots WHERE count_id=? AND slot=?', $c['id'], $slot);
            return ['ok' => true];
        }
        Db::run('INSERT INTO wms_count_slots(count_id,slot,done_at,user_id) VALUES(?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE done_at=VALUES(done_at), user_id=VALUES(user_id)', $c['id'], $slot, $u['id']);
        if ($c['status'] === 'open') {
            Db::run("UPDATE wms_counts SET status='counting', started_at=UTC_TIMESTAMP() WHERE id=?", $c['id']);
        }
        $n = (int) Db::val('SELECT COUNT(*) n FROM wms_count_scans WHERE count_id=? AND slot=?', $c['id'], $slot);
        $this->log($u['id'], 'wms.counted', 'count:'.$c['id'], ['slot' => $slot, 'scanned' => $n]);
        return ['ok' => true, 'slot' => $slot, 'scanned' => $n];
    }

    public function countMove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->countRow($p['id']);
        $this->need($c['status'] !== 'cancelled', 'Count cancelled');
        $s = Db::get("SELECT * FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=? AND result='extra'", $c['id'], self::up($b['sku'] ?? null));
        $this->need($s, 'Not an extra in this count');
        $this->setLoc($s['sku'], $s['slot'], 'count', $u['id']);
        Db::run('UPDATE wms_count_scans SET moved=1 WHERE id=?', $s['id']);
        $this->log($u['id'], 'wms.move', 'sku:'.self::up($s['sku']), ['from' => $s['recorded_loc'], 'to' => $s['slot'], 'count' => $c['id']]);
        return ['ok' => true];
    }

    public function countFinish(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->openCount($p['id']);
        $st = $this->countState($c, true);
        $summary = array_merge($st['totals'], [
            'slots' => count($c['slots']), 'slotsDone' => $st['slotsDone'],
            'missing' => array_map(fn ($m) => ['sku' => $m['sku'], 'title' => $m['title'], 'loc' => $m['loc'], 'cost' => $m['cost']], $st['missing']),
            'extra' => array_map(fn ($x) => ['sku' => $x['sku'], 'title' => $x['title'], 'slot' => $x['slot'], 'recorded' => $x['recorded_loc'], 'cost' => $x['cost'], 'moved' => $x['moved'], 'sold' => $x['sold']], $st['extra']),
            'unknown' => array_map(fn ($x) => ['sku' => $x['sku'], 'slot' => $x['slot']], $st['unknown']),
        ]);
        Db::run("UPDATE wms_counts SET status='review', finished_at=UTC_TIMESTAMP(), summary=? WHERE id=?", json_encode($summary, JSON_UNESCAPED_UNICODE), $c['id']);
        $this->log($u['id'], 'wms.count.finish', 'count:'.$c['id'], $st['totals']);
        return ['ok' => true, 'summary' => $summary];
    }

    public function countApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->countRow($p['id']);
        $this->need($c['status'] === 'review', 'Finish the count first');
        $sm = is_array($c['summary']) && $c['summary'] ? $c['summary'] : [];
        $moved = 0;
        $missing = 0;
        Db::tx(function () use (&$sm, &$moved, &$missing, $b, $c, $u) {
            if (($b['moveExtras'] ?? null) !== false) {
                foreach (($sm['extra'] ?? []) ?: [] as $i => $x) {
                    if (! self::truthy($x['moved'] ?? null) && ! self::truthy($x['sold'] ?? null)) {
                        $this->setLoc($x['sku'], $x['slot'], 'count', $u['id']);
                        $sm['extra'][$i]['moved'] = 1;
                        $moved++;
                    }
                }
            }
            foreach (($sm['missing'] ?? []) ?: [] as $m) {
                if (! Db::get("SELECT 1 FROM wms_missing WHERE UPPER(sku)=? AND status='open'", self::up($m['sku'] ?? null))) {
                    Db::run('INSERT INTO wms_missing(sku,title,count_id,last_loc,cost) VALUES(?,?,?,?,?)', $m['sku'] ?? null, $m['title'] ?? null, $c['id'], $m['loc'] ?? null, self::or($m['cost'] ?? null, 0));
                    $missing++;
                }
            }
            Db::run("UPDATE wms_counts SET status='done', approved_by=?, approved_at=UTC_TIMESTAMP(), summary=? WHERE id=?", $u['id'], json_encode($sm ?: new \stdClass, JSON_UNESCAPED_UNICODE), $c['id']);
        });
        $this->log($u['id'], 'wms.count.approve', 'count:'.$c['id'], ['moved' => $moved, 'missing' => $missing]);
        return ['ok' => true, 'moved' => $moved, 'missing' => $missing];
    }

    public function countCancel(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->countRow($p['id']);
        $this->need($c['status'] !== 'done', 'Already approved');
        Db::run("UPDATE wms_counts SET status='cancelled' WHERE id=?", $c['id']);
        $this->log($u['id'], 'wms.count.cancel', 'count:'.$c['id'], '');
        return ['ok' => true];
    }

    public function missingList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT m.*, us.name resolved_name FROM wms_missing m LEFT JOIN users us ON us.id=m.resolved_by WHERE '.(self::truthy($qs['all'] ?? null) ? '1=1' : "m.status='open'").' ORDER BY m.id DESC LIMIT 500');
    }

    public function missingResolve(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $m = Db::get('SELECT * FROM wms_missing WHERE id=?', (int) $p['id']);
        $this->need($m && $m['status'] === 'open', 'Not open');
        $posting = ['posted' => false, 'error' => null];
        $action = $b['action'] ?? null;
        $slot = $b['slot'] ?? null;
        if ($action === 'found') {
            if (self::truthy($slot)) {
                $this->setLoc($m['sku'], self::up($slot), 'count', $u['id']);
            }
            Db::run("UPDATE wms_missing SET status='found', note=?, resolved_by=?, resolved_at=UTC_TIMESTAMP() WHERE id=?", self::or($b['note'] ?? null, self::truthy($slot) ? 'Found at '.self::up($slot) : 'Found'), $u['id'], $m['id']);
        } elseif ($action === 'writeoff') {
            $this->need($this->isWms($u), 'No access', 403);
            $this->setLoc($m['sku'], 'MISSING', 'missing', $u['id']);
            if ($m['cost'] > 0) {
                $posting = $this->post(['date' => $this->pkToday(), 'memo' => "Missing pair written off: {$m['sku']}", 'source' => 'wms-missing', 'source_id' => (string) $m['id'],
                    'lines' => [['account' => 'Inventory Damage', 'debit' => $m['cost']], ['account' => 'Listed Inventory', 'credit' => $m['cost']]]], $u['id']);
            }
            Db::run("UPDATE wms_missing SET status='written_off', note=?, resolved_by=?, resolved_at=UTC_TIMESTAMP() WHERE id=?", self::or($b['note'] ?? null, 'Written off'), $u['id'], $m['id']);
        } else {
            $this->need(false, 'Unknown action');
        }
        $this->log($u['id'], 'wms.missing.resolve', 'sku:'.$m['sku'], ['action' => $action, 'slot' => $slot]);
        return array_merge(['ok' => true], $posting);
    }

    /* ================================================================ damage register */

    public function damageList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $month = self::or($qs['month'] ?? null, substr($this->pkToday(), 0, 7));
        $rows = Db::all("SELECT d.*, r.name reported_name, a.name approved_name FROM wms_damage d LEFT JOIN users r ON r.id=d.reported_by LEFT JOIN users a ON a.id=d.approved_by
            ORDER BY CASE d.status WHEN 'reported' THEN 0 ELSE 1 END, d.id DESC LIMIT 300");
        $mtd = Db::get("SELECT COUNT(*) n, COALESCE(SUM(cost),0) v FROM wms_damage WHERE status='approved' AND DATE_FORMAT(approved_at + INTERVAL 5 HOUR,'%Y-%m')=?", $month);
        $stock = Db::val('SELECT COALESCE(SUM(p.cost),0) v FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL) ?? 0;
        $reasons = array_map(fn ($r) => ['reason' => $r, 'n' => 0, 'v' => 0], self::REASONS);
        foreach (Db::all("SELECT reason, COUNT(*) n, SUM(cost) v FROM wms_damage WHERE status<>'rejected' AND at>=(UTC_TIMESTAMP() - INTERVAL 90 DAY) GROUP BY reason") as $r) {
            $i = array_search($r['reason'], self::REASONS, true);
            $i = $i === false ? 5 : $i;
            $reasons[$i]['n'] += $r['n'];
            $reasons[$i]['v'] += self::or($r['v'], 0);
        }
        $months = array_reverse(Db::all("SELECT DATE_FORMAT(at + INTERVAL 5 HOUR,'%Y-%m') month, COUNT(*) n, ROUND(SUM(cost)) v FROM wms_damage WHERE status<>'rejected' GROUP BY 1 ORDER BY 1 DESC LIMIT 6"));
        foreach ($months as &$mo) {
            if (is_float($mo['v']) && floor($mo['v']) == $mo['v']) {
                $mo['v'] = (int) $mo['v'];
            }
        }
        unset($mo);
        return ['rows' => $rows, 'month' => $month, 'mtd' => ['n' => $mtd['n'], 'value' => $mtd['v'], 'pct' => $stock ? round(100 * $mtd['v'] / $stock, 2) : 0], 'stockValue' => $stock,
            'reasons' => $reasons, 'months' => $months, 'REASONS' => self::REASONS, 'accounts' => (bool) $this->acc()];
    }

    public function damageReport(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $sku = self::up($b['sku'] ?? null);
        $this->need($sku !== '', 'Scan or type the SKU');
        $this->need(in_array($b['reason'] ?? null, self::REASONS, true), 'Pick a reason');
        $pr = $this->product($sku);
        $this->need(! Db::get("SELECT 1 FROM wms_damage WHERE UPPER(sku)=? AND status='reported'", $sku), $sku.' is already reported and waiting for approval');
        $id = Db::run('INSERT INTO wms_damage(sku,title,reason,photo,found_at,note,cost,reported_by) VALUES(?,?,?,?,?,?,?,?)', $sku, $pr ? $pr['title'] : '', $b['reason'],
            self::or($b['photo'] ?? null, null), self::or($b['found_at'] ?? null, $pr ? $pr['loc'] : ''), self::or($b['note'] ?? null, ''), $pr ? self::or($pr['cost'], 0) : 0, $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'wms.damage.report', 'sku:'.$sku, ['reason' => $b['reason'], 'id' => $id]);
        return ['ok' => true, 'id' => $id, 'product' => $pr ?: null, 'warning' => $pr ? null : $sku.' is not in products (cost unknown)'];
    }

    public function damageApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $d = Db::get('SELECT * FROM wms_damage WHERE id=?', (int) $p['id']);
        $this->need($d, 'Not found', 404);
        $this->need($d['status'] === 'reported', 'Already '.$d['status']);
        if (($b['approve'] ?? null) === false) {
            Db::run("UPDATE wms_damage SET status='rejected', approved_by=?, approved_at=UTC_TIMESTAMP(), note=CONCAT(COALESCE(note,''), ?) WHERE id=?", $u['id'], self::truthy($b['note'] ?? null) ? ' · '.$b['note'] : '', $d['id']);
            $this->log($u['id'], 'wms.damage.reject', 'sku:'.$d['sku'], '');
            return ['ok' => true, 'status' => 'rejected'];
        }
        $cost = isset($b['cost']) && $b['cost'] !== '' ? self::num($b['cost']) : self::or($d['cost'], 0);
        if (is_float($cost) && is_nan($cost)) {
            $cost = 0;
        }
        $posting = ['posted' => false, 'error' => null];
        if ($cost > 0) {
            $posting = $this->post(['date' => $this->pkToday(), 'memo' => "Damaged pair written off: {$d['sku']} ({$d['reason']})", 'source' => 'wms-damage', 'source_id' => (string) $d['id'],
                'lines' => [['account' => 'Inventory Damage', 'debit' => $cost], ['account' => 'Listed Inventory', 'credit' => $cost]]], $u['id']);
        }
        $this->setLoc($d['sku'], 'DAMAGED', 'damage', $u['id']);
        Db::run("UPDATE wms_damage SET status='approved', cost=?, approved_by=?, approved_at=UTC_TIMESTAMP(), post_error=? WHERE id=?", $cost, $u['id'], $posting['error'], $d['id']);
        $this->log($u['id'], 'wms.damage.approve', 'sku:'.$d['sku'], ['cost' => $cost, 'posted' => $posting['posted']]);
        return array_merge(['ok' => true, 'status' => 'approved', 'cost' => $cost], $posting);
    }

    /* ================================================================ transfers */

    private function transferOut(array $t): array
    {
        return array_merge($t, ['destName' => self::DESTS[$t['dest']] ?? $t['dest'], 'discrepancy' => $this->J($t['discrepancy'], null)]);
    }

    public function transfersList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $rows = Db::all('SELECT t.*, c.name sent_name, r.name received_name, (SELECT COUNT(*) FROM wms_transfer_items i WHERE i.transfer_id=t.id AND i.extra=0) items,
            (SELECT COUNT(*) FROM wms_transfer_items i WHERE i.transfer_id=t.id AND i.received=1) got FROM wms_transfers t LEFT JOIN users c ON c.id=t.created_by LEFT JOIN users r ON r.id=t.received_by ORDER BY t.id DESC LIMIT 200');
        return ['rows' => array_map(fn ($t) => $this->transferOut($t), $rows), 'DESTS' => self::DESTS];
    }

    public function transferShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = Db::get('SELECT t.*, c.name sent_name, r.name received_name FROM wms_transfers t LEFT JOIN users c ON c.id=t.created_by LEFT JOIN users r ON r.id=t.received_by WHERE t.id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        return ['transfer' => $this->transferOut($t), 'items' => Db::all('SELECT i.*, p.title, p.cost, p.size FROM wms_transfer_items i LEFT JOIN products p ON UPPER(p.sku)=UPPER(i.sku) WHERE transfer_id=? ORDER BY i.id', $t['id'])];
    }

    private function createTransfer(string $dest, array $skus, $note, $uid): int
    {
        return Db::tx(function () use ($dest, $skus, $note, $uid) {
            $tid = Db::run('INSERT INTO wms_transfers(dest,note,created_by) VALUES(?,?,?)', $dest, self::or($note, ''), $uid)->lastInsertRowid;
            foreach ($skus as $s) {
                $from = $this->setLoc($s, 'TRANSIT-'.$dest, 'transfer:'.strtolower($dest), $uid);
                Db::run('INSERT INTO wms_transfer_items(transfer_id,sku,from_loc) VALUES(?,?,?)', $tid, $s, $from);
            }
            return $tid;
        });
    }

    private static function skuList($list): array
    {
        return array_values(array_unique(array_filter(array_map([self::class, 'up'], is_array($list) ? $list : []), fn ($x) => $x !== '')));
    }

    public function transferCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $dest = self::up($b['dest'] ?? null);
        $this->need(isset(self::DESTS[$dest]), 'Pick where it is going');
        $skus = self::skuList($b['skus'] ?? null);
        $this->need($skus, 'Scan at least one pair');
        $warnings = array_values(array_map(fn ($s) => $s.' is unknown', array_filter($skus, fn ($s) => ! $this->product($s))));
        $id = $this->createTransfer($dest, $skus, $b['note'] ?? null, $u['id']);
        $this->log($u['id'], 'wms.transfer.send', 'transfer:'.$id, ['dest' => $dest, 'n' => count($skus)]);
        return ['ok' => true, 'id' => $id, 'n' => count($skus), 'warnings' => $warnings];
    }

    public function transferReceive(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = Db::get('SELECT * FROM wms_transfers WHERE id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        $this->need($t['status'] === 'sent', 'Already received');
        $items = Db::all('SELECT * FROM wms_transfer_items WHERE transfer_id=? AND extra=0', $t['id']);
        $sent = array_values(array_unique(array_map(fn ($i) => self::up($i['sku']), $items)));
        $got = self::truthy($b['all'] ?? null) ? $sent : self::skuList($b['skus'] ?? null);
        $short = array_values(array_filter($sent, fn ($s) => ! in_array($s, $got, true)));
        $extra = array_values(array_filter($got, fn ($s) => ! in_array($s, $sent, true)));
        Db::tx(function () use ($got, $sent, $t, $u, $b, $short, $extra) {
            foreach ($got as $s) {
                $this->setLoc($s, $t['dest'], 'transfer-in:'.strtolower((string) $t['dest']), $u['id']);
                if (in_array($s, $sent, true)) {
                    Db::run('UPDATE wms_transfer_items SET received=1 WHERE transfer_id=? AND UPPER(sku)=?', $t['id'], $s);
                } else {
                    Db::run('INSERT INTO wms_transfer_items(transfer_id,sku,received,extra) VALUES(?,?,1,1)', $t['id'], $s);
                }
            }
            Db::run("UPDATE wms_transfers SET status='received', received_by=?, received_at=UTC_TIMESTAMP(), discrepancy=? WHERE id=?", self::n0($b['received_by'] ?? null) ?: $u['id'],
                $short || $extra ? json_encode(['short' => $short, 'extra' => $extra, 'note' => self::or($b['note'] ?? null, '')], JSON_UNESCAPED_UNICODE) : null, $t['id']);
        });
        $this->log($u['id'], 'wms.transfer.receive', 'transfer:'.$t['id'], ['got' => count($got), 'short' => count($short), 'extra' => count($extra)]);
        return ['ok' => true, 'received' => count($got), 'short' => $short, 'extra' => $extra];
    }

    /* ================================================================ overview & KPIs */

    /** Service: warehouse KPIs for the home page. */
    public function summary(): array
    {
        $s = Db::get('SELECT COUNT(*) n, COALESCE(SUM(p.cost),0) v FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL);
        $lc = $this->locCounts();
        $empty = 0;
        foreach (Db::all('SELECT code FROM wms_slots WHERE active=1') as $r) {
            if (! (($lc[$r['code']]['n'] ?? 0))) {
                $empty++;
            }
        }
        $lots = $this->lotRows();
        return ['onHand' => $s['n'], 'stockValue' => Logic::jsRound($s['v']), 'emptySlots' => $empty, 'lotsToReceive' => count(array_filter($lots, fn ($l) => $l['status'] === 'not_received')),
            'countsDue' => count(array_filter($this->dueRacks(), fn ($r) => $r['due'])),
            'damageMTD' => Logic::jsRound(Db::val("SELECT COALESCE(SUM(cost),0) v FROM wms_damage WHERE status='approved' AND DATE_FORMAT(approved_at + INTERVAL 5 HOUR,'%Y-%m')=?", substr($this->pkToday(), 0, 7)) ?? 0)];
    }

    private function returnsWaiting(): array
    {
        return Db::all("SELECT r.sku, r.at, o.name, 'return' src FROM returns r LEFT JOIN orders o ON o.id=r.order_id WHERE r.restocked=1 AND COALESCE(r.location,'')=''
            AND NOT EXISTS(SELECT 1 FROM stock_moves m WHERE m.sku=r.sku AND m.at>=r.at AND m.reason IN ('putaway','move','count'))
            UNION ALL SELECT l.sku, l.updated_at at, NULL name, 'returns-bin' src FROM locations l WHERE l.location='RETURNS' ORDER BY at LIMIT 200");
    }

    public function overview(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'wms') || $this->can($u, 'warehouse'), 'No access', 403);
        $sm = $this->summary();
        $racks = $this->rackSummary();
        $lots = $this->lotRows();
        $cap = array_reduce($racks, fn ($t, $r) => $t + self::or($r['capacity'], 0), 0);
        $slotted = array_reduce($racks, fn ($t, $r) => $t + self::or($r['slotted'], 0), 0);
        $ages = Db::get('SELECT SUM(a<=60) b1, SUM(CASE WHEN a<=60 THEN c END) v1, SUM(a>60 AND a<=120) b2, SUM(CASE WHEN a>60 AND a<=120 THEN c END) v2,
            SUM(a>120 AND a<=365) b3, SUM(CASE WHEN a>120 AND a<=365 THEN c END) v3, SUM(a>365) b4, SUM(CASE WHEN a>365 THEN c END) v4
            FROM (SELECT TIMESTAMPDIFF(SECOND, p.created_at, UTC_TIMESTAMP())/86400.0 a, p.cost c FROM '.self::FROM.' WHERE p.qty>0 AND '.self::AWAY_SQL.') t');
        $aging = array_map(fn ($x) => ['bucket' => $x[0], 'n' => self::or($x[1], 0), 'value' => Logic::jsRound(self::or($x[2], 0))],
            [['0-60 days', $ages['b1'], $ages['v1']], ['61-120 days', $ages['b2'], $ages['v2']], ['121-365 days', $ages['b3'], $ages['v3']], ['365+ days', $ages['b4'], $ages['v4']]]);
        $slowRows = Db::all('SELECT p.sku, p.title, p.size, p.price, p.cost, p.lot, '.self::LOC.' loc, TIMESTAMPDIFF(DAY, p.created_at, UTC_TIMESTAMP()) age FROM '.self::FROM.'
            WHERE p.qty>0 AND '.self::AWAY_SQL.' AND p.created_at < (UTC_TIMESTAMP() - INTERVAL 120 DAY) ORDER BY p.created_at LIMIT 1000');
        $slowBy = [];
        foreach ($slowRows as $r) {
            $k = self::rackOf(self::or($r['loc'], '?'));
            if (! isset($slowBy[$k])) {
                $slowBy[$k] = ['rack' => $k, 'n' => 0, 'value' => 0, 'price' => 0, 'items' => []];
            }
            $slowBy[$k]['n']++;
            $slowBy[$k]['value'] += self::or($r['cost'], 0);
            $slowBy[$k]['price'] += self::or($r['price'], 0);
            if (count($slowBy[$k]['items']) < 50) {
                $slowBy[$k]['items'][] = $r;
            }
        }
        $slow = array_values($slowBy);
        usort($slow, fn ($a, $b) => $b['n'] <=> $a['n']);
        $slow = array_map(fn ($x) => array_merge($x, ['value' => Logic::jsRound($x['value']), 'price' => Logic::jsRound($x['price'])]), $slow);
        $today = $this->pkToday();
        $speed = Db::get("SELECT AVG(TIMESTAMPDIFF(SECOND, cs_at, picked_at)/60) pick, COUNT(*) n FROM orders WHERE picked_at IS NOT NULL AND cs_at IS NOT NULL AND cs_at<=picked_at AND DATE_FORMAT(picked_at + INTERVAL 5 HOUR,'%Y-%m-%d')=?", $today);
        $speed2 = Db::get("SELECT AVG(TIMESTAMPDIFF(SECOND, picked_at, packed_at)/60) pack, COUNT(*) n FROM orders WHERE packed_at IS NOT NULL AND picked_at IS NOT NULL AND picked_at<=packed_at AND DATE_FORMAT(packed_at + INTERVAL 5 HOUR,'%Y-%m-%d')=?", $today);
        $openVar = array_map(fn ($c) => array_merge(['id' => $c['id'], 'name' => $c['name']], (array) ($this->J($c['summary'], []) ?: [])), Db::all("SELECT id, name, summary FROM wms_counts WHERE status='review'"));
        $moves = Db::all("SELECT m.reason, COUNT(*) n FROM stock_moves m WHERE DATE_FORMAT(m.at + INTERVAL 5 HOUR,'%Y-%m-%d')=? GROUP BY m.reason", $today);
        return array_merge($sm, [
            'slotFill' => $cap ? Logic::jsRound(100 * $slotted / $cap) : null, 'capacity' => $cap, 'slotted' => $slotted, 'racks' => $racks,
            'backlog' => array_reduce($lots, fn ($t, $l) => $t + ($l['received'] ? $l['unlisted'] : 0), 0),
            'stuckLots' => array_values(array_filter($lots, fn ($l) => $l['stuck'])),
            'lotsWaiting' => array_slice(array_values(array_filter($lots, fn ($l) => $l['status'] === 'not_received')), 0, 10),
            'openVariances' => array_map(fn ($v) => ['id' => $v['id'], 'name' => $v['name'], 'missing' => is_array($v['missing'] ?? null) ? count($v['missing']) : 0, 'extra' => is_array($v['extra'] ?? null) ? count($v['extra']) : 0, 'missingValue' => self::or($v['missingValue'] ?? null, 0)], $openVar),
            'aging' => $aging, 'slow' => $slow, 'slowTotal' => count($slowRows),
            'speed' => ['pick' => $speed['pick'] !== null ? Logic::jsRound($speed['pick']) : null, 'picked' => $speed['n'], 'pack' => $speed2['pack'] !== null ? Logic::jsRound($speed2['pack']) : null, 'packed' => $speed2['n']],
            'returnsWaiting' => $this->returnsWaiting(), 'movesToday' => $moves,
            'missingOpen' => (int) Db::val("SELECT COUNT(*) n FROM wms_missing WHERE status='open'"), 'damagePending' => (int) Db::val("SELECT COUNT(*) n FROM wms_damage WHERE status='reported'"),
        ]);
    }

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->S();
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $cur = $this->S();
        foreach (['countEvery', 'stuckDays', 'stuckPct', 'varianceAlert', 'defaultCapacity'] as $k) {
            if (isset($b[$k]) && $b[$k] !== '') {
                $cur[$k] = max(1, self::n0($b[$k]) ?: $cur[$k]);
            }
        }
        $this->setSetting('wms.settings', $cur);
        $this->log($u['id'], 'settings.save', 'wms:settings', $cur);
        return $cur;
    }

    /* ================================================================ services */

    /** Service: a returned pair goes to the RETURNS bin. */
    public function receiveReturn($sku, $note = null, $userId = null): array
    {
        $s = self::up($sku);
        $uid = self::truthy($userId) ? $userId : null;
        $from = $this->setLoc($s, 'RETURNS', 'return', $uid);
        $this->log($uid, 'wms.return', 'sku:'.$s, ['from' => $from, 'note' => self::or($note, '')]);
        return ['ok' => true, 'sku' => $s, 'location' => 'RETURNS'];
    }

    /** Service: send pairs to OUTLET / REPAIR / SUPPLIER / STUDIO. Returns the transfer id, or null when no SKU was given. */
    public function transfer($dest, $skus, $note = null, $userId = null): ?int
    {
        $dest = self::up($dest);
        if (! isset(self::DESTS[$dest])) {
            throw new HttpError(400, 'Unknown destination');
        }
        $skus = self::skuList($skus);
        if (! $skus) {
            return null;
        }
        $uid = self::truthy($userId) ? $userId : null;
        $id = $this->createTransfer($dest, $skus, $note, $uid);
        $this->log($uid, 'wms.transfer.send', 'transfer:'.$id, ['dest' => $dest, 'n' => count($skus)]);
        return $id;
    }

    /* ================================================================ badges, alerts */

    public function counts(array $u): array
    {
        if (! $this->can($u, 'wms')) {
            return [];
        }
        $mine = (int) Db::val("SELECT COUNT(*) n FROM wms_counts WHERE status IN ('open','counting') AND (assigned_to=? OR assigned_to IS NULL)", $u['id']);
        $dmg = (int) Db::val("SELECT COUNT(*) n FROM wms_damage WHERE status='reported'");
        $recv = count(array_filter($this->lotRows(), fn ($l) => $l['status'] === 'not_received'));
        return ['counts' => $mine, 'damage' => $dmg, 'receiving' => $recv];
    }

    public function alerts(array $u): array
    {
        if (! $this->can($u, 'wms')) {
            return [];
        }
        $out = [];
        $st = $this->S();
        $today = $this->pkToday();
        $od = (int) Db::val("SELECT COUNT(*) n FROM wms_counts WHERE status IN ('open','counting') AND due<?", $today);
        if ($od) {
            $out[] = ['level' => 'bad', 'text' => "{$od} stock count".($od > 1 ? 's are' : ' is').' overdue', 'href' => '#/counts'];
        }
        $stuck = array_values(array_filter($this->lotRows(), fn ($l) => $l['stuck']));
        if ($stuck) {
            $n = count($stuck);
            $out[] = ['level' => 'warn', 'text' => "{$n} lot".($n > 1 ? 's' : '')." received over {$st['stuckDays']} days ago but less than {$st['stuckPct']}% listed (".implode(', ', array_map(fn ($l) => $l['name'], array_slice($stuck, 0, 3))).')', 'href' => '#/receiving'];
        }
        foreach (Db::all("SELECT id, name, summary FROM wms_counts WHERE status='review'") as $c) {
            $s = $this->J($c['summary'] ?: '{}', []);
            $s = is_array($s) ? $s : [];
            $n = is_array($s['missing'] ?? null) ? count($s['missing']) : 0;
            if ($n >= $st['varianceAlert']) {
                $out[] = ['level' => 'warn', 'text' => "Stock count \"{$c['name']}\": {$n} pairs missing (Rs ".number_format(Logic::jsRound(self::or($s['missingValue'] ?? null, 0))).' at cost)', 'href' => '#/counts/c/'.$c['id']];
            }
        }
        $wk = (int) Db::val("SELECT COUNT(*) n FROM wms_damage WHERE status<>'rejected' AND at>=(UTC_TIMESTAMP() - INTERVAL 7 DAY)");
        $prev = (int) Db::val("SELECT COUNT(*) n FROM wms_damage WHERE status<>'rejected' AND at>=(UTC_TIMESTAMP() - INTERVAL 63 DAY) AND at<(UTC_TIMESTAMP() - INTERVAL 7 DAY)") / 8;
        if ($wk >= 3 && $wk >= 2 * $prev) {
            $out[] = ['level' => 'warn', 'text' => "Damage spike: {$wk} damaged pairs reported this week", 'href' => '#/damage'];
        }
        return $out;
    }
}
