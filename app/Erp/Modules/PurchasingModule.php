<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;

/**
 * Purchasing (port of legacy/server/modules/purchasing.js): suppliers, purchase orders (shoe lots & supplies) → approval →
 * GRN (WMS) → supplier bill → payments, supplier scorecards.
 *
 * Accounting (one entry per lot, never two):
 *  • A lot bought on a PO is NOT posted by the accounts 'lot' auto-entry (accounts skips lots linked to a live PO).
 *  • When the lot is received in WMS (GRN), purchasing posts 'pur-lot' / <lot name>: Dr Purchases (lot cost + extra costs) / Cr Accounts Payable
 *    (party vendor:<supplier>) / Cr Accrued Expenses (party lot:<name>) — the same day WMS moves it Purchases → Unlisted Inventory (source 'grn').
 *  • The supplier bill finalises that SAME entry (re-posted with the billed amount and extra-cost lines); if the billed cost differs, the lot cost,
 *    per-pair cost and the GRN entry follow it. Supplies bills post 'pur-bill' / <bill id>: Dr Packaging (or chosen account) / Cr Accounts Payable.
 *  • Debit notes ('pur-dn'): Dr Accounts Payable / Cr Inventory Damage (damaged pairs) / Cr Discount Received (short or other). Payments and
 *    advances ('pur-pay'): Dr Accounts Payable (vendor) / Cr Cash, Meezan (SB), JazzCash… (an advance leaves a debit balance on the vendor).
 */
class PurchasingModule extends Module
{
    public string $name = 'purchasing';

    private const STATUSES = ['draft', 'submitted', 'approved', 'sent', 'partial', 'received', 'billed', 'closed', 'cancelled'];

    private const TYPES = ['lots' => 'Shoe lots', 'packaging' => 'Packaging & supplies', 'services' => 'Services', 'other' => 'Other'];

    private const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    private const COLS = ['supplier', 'expected_date', 'terms', 'credit_days', 'instalments', 'notes', 'files', 'advance_plan', 'lot_name', 'lot_kind', 'pieces', 'pricing', 'rate', 'lump', 'mix', 'bad_est', 'extras', 'extra_total', 'plan'];

    private const PRICING = '\\App\\Erp\\Core\\Pricing';

    public function activity(): array
    {
        return [
            'pur.supplier.save' => 'Saved supplier', 'pur.po.create' => 'Created purchase order', 'pur.po.edit' => 'Edited purchase order', 'pur.po.submit' => 'Sent PO for approval', 'pur.po.approve' => 'Approved purchase order',
            'pur.po.send' => 'Sent PO to supplier', 'pur.po.cancel' => 'Cancelled purchase order', 'pur.po.close' => 'Closed purchase order', 'pur.po.receive' => 'Received supplies', 'pur.advance' => 'Paid supplier advance',
            'pur.bill' => 'Entered supplier bill', 'pur.pay' => 'Paid supplier', 'pur.settle' => 'Settled lot difference with supplier',
        ];
    }

    /** ready(): pre-fill the supplier list from lots / seed names / accounts parties (idempotent). */
    public function install(): void
    {
        try {
            $this->importVendors();
        } catch (\Throwable) {
        }
    }

    /* ======================================================== small helpers */

    /** JS `+v || 0` */
    private static function n($v): int|float
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_float($v)) {
            return is_nan($v) || is_infinite($v) ? 0 : $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_string($v)) {
            $t = trim($v);
            if ($t === '') {
                return 0;
            }
            return is_numeric($t) ? $t + 0 : 0;
        }
        return 0;
    }

    /** whole floats -> int so the JSON looks like the JS numbers */
    private static function num($v): int|float
    {
        if (is_float($v) && floor($v) == $v && abs($v) < 1e15) {
            return (int) $v;
        }
        return $v;
    }

    private static function rnd($v): int|float
    {
        return Logic::jsRound(self::n($v));
    }

    private static function r2($v): int|float
    {
        return self::num(Logic::jsRound(self::n($v) * 100) / 100);
    }

    private static function isDate($s): bool
    {
        return is_scalar($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $s) === 1;
    }

    private static function ts(string $d): int
    {
        return (int) strtotime($d.' 00:00:00 UTC');
    }

    private static function addDays(string $d, $n): string
    {
        return gmdate('Y-m-d', (int) floor(self::ts($d) + $n * 86400));
    }

    private static function daysBetween(string $a, string $b): int
    {
        return (int) Logic::jsRound((self::ts($b) - self::ts($a)) / 86400);
    }

    private static function poNo($id): string
    {
        return 'PO-'.str_pad((string) $id, 4, '0', STR_PAD_LEFT);
    }

    private static function fmt($v): string
    {
        return 'Rs '.number_format((float) Logic::jsRound(self::n($v)), 0, '.', ',');
    }

    private static function str($v): string
    {
        if ($v === null) {
            return '';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_array($v)) {
            return implode(',', array_map(fn ($x) => is_array($x) ? '' : self::str($x), $v));
        }
        return (string) $v;
    }

    /** UTC timestamp -> Pakistan date (YYYY-MM-DD), null when empty / not a date */
    private static function pkDate($utc): ?string
    {
        if (! $utc) {
            return null;
        }
        $s = str_replace(' ', 'T', (string) $utc);
        $t = strtotime(str_contains((string) $utc, 'Z') ? $s : $s.'Z');
        return $t === false ? null : gmdate('Y-m-d', $t + 5 * 3600);
    }

    private function nowUtc(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    private function isAdmin(?array $u): bool
    {
        return ($u['role'] ?? null) === 'admin';
    }

    private function pView(?array $u): bool
    {
        foreach (['listing', 'wms', 'finance', 'accounts_post', 'accounts', 'pricing_apply'] as $p) {
            if ($this->can($u, $p)) {
                return true;
            }
        }
        return false;
    }

    private function pCreate(?array $u): bool
    {
        return $this->can($u, 'listing') || $this->can($u, 'wms');
    }

    private function pApprove(?array $u): bool
    {
        return $this->isAdmin($u) || $this->can($u, 'pricing_apply');
    }

    private function pMoney(?array $u): bool
    {
        return $this->can($u, 'accounts_post') || $this->can($u, 'finance');
    }

    private function pSupplier(?array $u): bool
    {
        return $this->isAdmin($u) || $this->can($u, 'finance');
    }

    private function pOwner(?array $u): bool
    {
        return $this->isAdmin($u) || $this->can($u, 'pricing_apply') || $this->can($u, 'finance');
    }

    /* ======================================================== accounts bridge */

    private function acc(): ?Module
    {
        $a = $this->svc('accounts');
        return $a && method_exists($a, 'post') ? $a : null;
    }

    private function post(array $entry, $uid): array
    {
        $a = $this->acc();
        if (! $a) {
            return ['posted' => false, 'error' => 'Accounts module not available'];
        }
        try {
            return ['posted' => true, 'id' => $a->post($entry, $uid), 'error' => null];
        } catch (\Throwable $e) {
            return ['posted' => false, 'error' => $e->getMessage()];
        }
    }

    private function voidPost(string $source, $id, $uid, $why): void
    {
        $a = $this->acc();
        if (! $a) {
            return;
        }
        try {
            $a->void($source, $id, $uid, $why);
        } catch (\Throwable) {
        }
    }

    private function vendorBal($name): int|float
    {
        $a = $this->acc();
        if (! $a) {
            return 0;
        }
        try {
            return self::n($a->balance('Accounts Payable', null, 'vendor:'.$name));
        } catch (\Throwable) {
            return 0;
        }
    }

    /* ======================================================== pricing engine (same numbers as the lister) */

    private function eng()
    {
        $P = self::PRICING;
        if (! class_exists($P)) {
            throw new \RuntimeException('Pricing engine is not available (App\\Erp\\Core\\Pricing)');
        }
        $def = self::prConst('ECON_DEFAULTS', []);
        $s = $this->setting('list_econ', []);
        return $P::engine(array_merge((array) $def, is_array($s) ? $s : []));
    }

    /** a constant (or static property) of the pricing library */
    private static function prConst(string $k, $def = null)
    {
        $P = self::PRICING;
        if (defined($P.'::'.$k)) {
            return constant($P.'::'.$k);
        }
        if (property_exists($P, $k)) {
            return $P::$$k;
        }
        return $def;
    }

    /** call a function of the engine (array of closures or object with methods); result as plain arrays */
    private static function ecall($E, string $fn, ...$a)
    {
        $r = is_array($E) ? ($E[$fn])(...$a) : $E->{$fn}(...$a);
        return is_array($r) || is_object($r) ? json_decode(json_encode($r), true) : $r;
    }

    /** the engine's E numbers (adsPP, ohBE, mix, ...) */
    private static function eNums($E): array
    {
        $x = is_array($E) ? ($E['E'] ?? []) : ($E->E ?? []);
        return json_decode(json_encode($x), true) ?: [];
    }

    private static function cleanComp($comp): array
    {
        $out = [];
        foreach (is_array($comp) ? $comp : [] as $r) {
            if (! is_array($r) || ! (self::n($r['n'] ?? null) > 0) || empty($r['t']) || empty($r['c'])) {
                continue;
            }
            $g = $r['g'] ?? null;
            $out[] = ['t' => self::str($r['t']), 'g' => in_array($g, ['Woman', 'Men', 'Kids'], true) ? $g : 'Woman', 'c' => self::str($r['c']),
                'n' => self::rnd($r['n']), 'b' => self::str(($r['b'] ?? '') ?: '')];
        }
        return $out;
    }

    /** Buy / Think twice / Don't buy, from the store's own lot planner (prices customers pay, ads, courier, overheads, sale plan) */
    public function verdict(array $x): array
    {
        $E = $this->eng();
        $EE = self::eNums($E);
        $cost = self::n($x['cost'] ?? null);
        $extra = self::n($x['extra'] ?? null);
        $pieces = self::rnd($x['pieces'] ?? null);
        $bad = self::rnd($x['bad'] ?? null);
        $comp = self::cleanComp($x['comp'] ?? null);
        $total = $cost + $extra;
        $good = $pieces - $bad;
        $out = ['cost' => $cost, 'extra' => $extra, 'total' => $total, 'pieces' => $pieces, 'bad' => $bad, 'good' => $good,
            'perPair' => $good > 0 ? Logic::jsRound($total / $good) : 0, 'perPiece' => $pieces ? Logic::jsRound($cost / $pieces) : 0, 'verdict' => null,
            'perPairCosts' => ['ads' => Logic::jsRound($EE['adsPP'] ?? 0), 'overheads' => Logic::jsRound($EE['ohBE'] ?? 0)]];
        if (! ($cost > 0) || ! ($pieces > 0)) {
            return $out + ['why' => 'Enter the price and the number of pieces.'];
        }
        if ($good <= 0) {
            return $out + ['why' => 'Bad pairs cannot be equal to or more than the pieces.'];
        }
        if (! $comp) {
            return $out + ['why' => 'Add the expected mix (types and condition) to see if this lot will make money.'];
        }
        $kind = ($x['kind'] ?? null) === 'leftover' ? 'leftover' : 'used';
        $plan = fn ($c) => self::ecall($E, 'lotPlan', ['name' => ($x['name'] ?? '') ?: '', 'kind' => $kind, 'cost' => $c, 'extra' => $extra, 'pieces' => $pieces, 'bad' => $bad, 'comp' => $comp]);
        $p = $plan($cost);
        $profit = self::n($p['profit'] ?? 0);
        $pairs = self::n($p['pairs'] ?? 0);
        $slow = self::n($p['slow'] ?? 0);
        $fx = $good * 0.9 * self::n($EE['ohBE'] ?? 0);
        $contrib = $profit + $total + $fx;
        $sales = Logic::jsRound(self::n($p['listed'] ?? 0) * self::n($EE['mix'] ?? 0) * 0.9);
        $roi = $total ? $profit / $total : 0;
        $slowPct = $pairs ? $slow / $pairs : 0;
        $perPairProfit = Logic::jsRound($profit / $good);
        // highest lot price that still breaks even (bisection on the lot price: profit falls as the price rises)
        $lo = 0;
        $hi = max($cost * 4, 100000);
        if (self::n($plan($lo)['profit'] ?? 0) < 0) {
            $hi = 0;
        } else {
            for ($i = 0; $i < 22; $i++) {
                $m = ($lo + $hi) / 2;
                if (self::n($plan($m)['profit'] ?? 0) >= 0) {
                    $lo = $m;
                } else {
                    $hi = $m;
                }
            }
        }
        $breakEven = Logic::jsRound($lo / 100) * 100;
        $v = $roi < 0 ? 'dont' : (($roi < 0.15 || $slowPct >= 0.4) ? 'think' : 'buy');
        $payback = $p['payback'] ?? null;
        $why = $v === 'dont' ? 'Loses about '.self::fmt(-$perPairProfit).' per pair after ads, courier and overheads. Pay at most '.self::fmt($breakEven).' ('.self::fmt($breakEven / $pieces).' a piece) to break even.'
            : ($v === 'think' ? ($roi < 0.15 ? 'Thin: about '.self::fmt($perPairProfit).' profit per pair ('.Logic::jsRound($roi * 100).'% on the money). Try to bring the price down; break-even is '.self::fmt($breakEven).'.'
                : 'Profitable on paper ('.self::fmt($perPairProfit).' a pair) but '.$slow.' pairs ('.Logic::jsRound($slowPct * 100).'%) are kinds customers usually pay less for than they cost to sell: they will sell slowly.')
                : 'About '.self::fmt($perPairProfit).' profit per pair after ads, courier and overheads ('.Logic::jsRound($roi * 100).'% on the money). Pays back after about '.($payback ?: '–').' pairs sold.');
        $out['verdict'] = $v;
        return $out + ['why' => $why, 'profit' => $p['profit'] ?? null, 'perPairProfit' => $perPairProfit, 'roi' => self::num(Logic::jsRound($roi * 1000) / 10), 'sales' => $sales,
            'listed' => $p['listed'] ?? null, 'variable' => Logic::jsRound($sales - $contrib), 'overheads' => Logic::jsRound($fx), 'slow' => $p['slow'] ?? null, 'slowPct' => Logic::jsRound($slowPct * 100),
            'payback' => $payback, 'breakEven' => $breakEven, 'breakEvenPiece' => Logic::jsRound($breakEven / $pieces), 'per_piece' => $p['per_piece'] ?? null, 'cpv' => $p['cpv'] ?? null,
            'rows' => array_map(fn ($r) => ['t' => $r['t'] ?? null, 'g' => $r['g'] ?? null, 'c' => $r['c'] ?? null, 'n' => $r['n'] ?? null, 'b' => $r['b'] ?? null, 'cost' => $r['cost'] ?? null,
                'price' => $r['price'] ?? null, 'min' => $r['min'] ?? null, 'slow' => $r['slow'] ?? null], $p['rows'] ?? [])];
    }

    /* ======================================================== lots table (same rules as POST /api/list/lots) */

    private function saveLot(string $name, array $f): array
    {
        $comp = self::cleanComp($f['comp'] ?? null);
        $kind = ($f['kind'] ?? null) === 'leftover' ? 'leftover' : 'used';
        $plan = self::ecall($this->eng(), 'lotPlan', ['name' => $name, 'kind' => $kind, 'cost' => self::n($f['cost'] ?? null), 'extra' => self::n($f['extra'] ?? null),
            'pieces' => self::n($f['pieces'] ?? null), 'bad' => self::n($f['bad'] ?? null), 'comp' => $comp]);
        Db::run('INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,kind,extra,bad,per_piece,cpv,comp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE vendor=VALUES(vendor),bought_on=VALUES(bought_on),cost=VALUES(cost),pieces=VALUES(pieces),note=VALUES(note),kind=VALUES(kind),extra=VALUES(extra),bad=VALUES(bad),per_piece=VALUES(per_piece),cpv=VALUES(cpv),comp=VALUES(comp),updated_at=VALUES(updated_at)',
            $name, self::str(($f['vendor'] ?? '') ?: ''), self::str(($f['bought_on'] ?? null) ?: $this->pkToday()), self::n($f['cost'] ?? null), self::n($f['pieces'] ?? null),
            self::str(($f['note'] ?? '') ?: ''), $kind, self::n($f['extra'] ?? null), self::n($f['bad'] ?? null), $plan['per_piece'] ?? null, ($plan['cpv'] ?? null) ?: null,
            json_encode($comp, JSON_UNESCAPED_UNICODE));
        return $plan;
    }

    private function lotRow($name): ?array
    {
        return Db::get('SELECT * FROM lots WHERE name=?', $name);
    }

    private function grnRow($name): ?array
    {
        try {
            return Db::get('SELECT * FROM wms_grn WHERE lot=?', $name);
        } catch (\Throwable) {
            return null;
        }
    }

    private function updateLotCost($name, $cost, $extra): bool
    {
        $l = $this->lotRow($name);
        if (! $l) {
            return false;
        }
        if (abs(self::n($l['cost']) - $cost) < 0.01 && abs(self::n($l['extra']) - $extra) < 0.01) {
            return false;
        }
        $this->saveLot($name, array_merge($l, ['comp' => $this->J($l['comp'], []), 'cost' => $cost, 'extra' => $extra]));
        return true;
    }

    /* ======================================================== suppliers */

    private function importVendors(): int
    {
        // INSERT OR IGNORE; the existence check first keeps InnoDB from burning an auto-increment id on every ignored row
        $ins = fn ($name, $type, $source) => Db::get('SELECT 1 FROM pur_suppliers WHERE name=?', $name) ? 0
            : Db::run('INSERT IGNORE INTO pur_suppliers(name,type,source) VALUES(?,?,?)', $name, $type, $source)->changes;
        $n = 0;
        foreach (Db::all("SELECT DISTINCT TRIM(vendor) v FROM lots WHERE TRIM(COALESCE(vendor,''))<>''") as $r) {
            $n += $ins($r['v'], 'lots', 'lots');
        }
        foreach (['Shamsullah', 'Jabbar', 'Lal Muhammad'] as $v) {
            $n += $ins($v, 'lots', 'seed'); // the owner's shoe-lot suppliers
        }
        try {
            foreach (Db::all("SELECT DISTINCT SUBSTR(party,8) v FROM acc_lines WHERE party LIKE 'vendor:%'") as $r) {
                if ($r['v'] && trim($r['v']) !== '' && $r['v'] !== 'Unknown') {
                    $n += $ins(trim($r['v']), 'other', 'accounts');
                }
            }
        } catch (\Throwable) {
        }
        return $n;
    }

    private function supRow($id): ?array
    {
        return Db::get('SELECT * FROM pur_suppliers WHERE id=?', (int) self::n($id));
    }

    private function supByName($name): ?array
    {
        return Db::get('SELECT * FROM pur_suppliers WHERE name=?', trim(self::str($name)));
    }

    private static function termsText(?array $s): string
    {
        if (! $s) {
            return '';
        }
        return $s['terms'] === 'credit' ? 'Credit '.($s['credit_days'] ?: 30).' days' : ($s['terms'] === 'instalments' ? ($s['instalments'] ?: 3).' instalments' : 'Cash on delivery');
    }

    /* ======================================================== purchase orders */

    private function poRow($id): array
    {
        $p = Db::get('SELECT * FROM pur_pos WHERE id=?', (int) self::n($id));
        if (! $p) {
            throw new HttpError(404, 'Purchase order not found');
        }
        return $p;
    }

    private function linesOf($id): array
    {
        return Db::all('SELECT * FROM pur_po_lines WHERE po_id=? ORDER BY id', $id);
    }

    private function billOf($poId): ?array
    {
        return Db::get("SELECT * FROM pur_bills WHERE po_id=? AND status<>'void' ORDER BY id DESC LIMIT 1", $poId);
    }

    private function lotPO($name): ?array
    {
        return Db::get("SELECT * FROM pur_pos WHERE kind='lot' AND lot_name=? AND status<>'cancelled' ORDER BY id DESC LIMIT 1", $name);
    }

    private static function rateEff(array $po): int|float
    {
        return $po['pricing'] === 'lump' ? ($po['pieces'] ? self::n($po['lump']) / $po['pieces'] : 0) : self::n($po['rate']);
    }

    private function poAmount(array $po, ?array $lines = null): int|float
    {
        if ($po['kind'] === 'lot') {
            return $po['pricing'] === 'lump' ? self::n($po['lump']) : self::n($po['rate']) * self::n($po['pieces']);
        }
        $s = 0;
        foreach ($lines ?? $this->linesOf($po['id']) as $l) {
            $s += self::n($l['qty']) * self::n($l['rate']);
        }
        return $s;
    }

    private function nextLotName(string $supplier): string
    {
        $s = $this->supByName($supplier);
        $taken = [];
        foreach (Db::all('SELECT name FROM lots UNION SELECT lot_name FROM pur_pos WHERE lot_name IS NOT NULL') as $r) {
            $taken[(string) $r['name']] = true;
        }
        $best = null;
        foreach (Db::all("SELECT name, COALESCE(bought_on,updated_at) d FROM lots WHERE vendor=? UNION ALL SELECT lot_name, created_at FROM pur_pos WHERE supplier=? AND lot_name IS NOT NULL AND status<>'cancelled'", $supplier, $supplier) as $r) {
            if (! preg_match('/^(.*?)(\d+)\s*$/su', (string) ($r['name'] ?? ''), $m)) {
                continue;
            }
            $n = (int) $m[2];
            if (! $best || $n > $best['n']) {
                $best = ['pre' => $m[1], 'n' => $n, 'w' => strlen($m[2])];
            }
        }
        if ($best) {
            ['pre' => $pre, 'n' => $n, 'w' => $w] = $best;
        } else {
            $words = array_values(array_filter(preg_split('/\s+/u', trim($supplier ?: 'Lot')), fn ($x) => $x !== ''));
            if ($s && $s['prefix']) {
                $p = $s['prefix'];
            } elseif (count($words) === 1) {
                $p = mb_strtoupper(mb_substr($words[0], 0, 2));
            } elseif (mb_strlen($words[0]) <= 3) {
                $p = mb_strtoupper($words[0]);
            } else {
                $p = mb_strtoupper(mb_substr(implode('', array_map(fn ($x) => mb_substr($x, 0, 1), $words)), 0, 3));
            }
            $pre = $p.'-Lot ';
            $n = 0;
            $w = 2;
        }
        do {
            $n++;
            $name = $pre.str_pad((string) $n, $w, '0', STR_PAD_LEFT);
        } while (isset($taken[$name]));
        return $name;
    }

    /** money on a PO / bill: advances (paid before the bill), bill payments, debit notes */
    private function money(array $po): array
    {
        $adv = Db::val("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", $po['id']);
        $bill = $this->billOf($po['id']);
        $paid = $bill ? Db::val('SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE bill_id=?', $bill['id']) : 0;
        $dn = Db::val('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', $po['id']);
        $net = $bill ? self::r2(self::n($bill['goods']) - $dn) : null;
        return ['advance' => self::r2($adv), 'paidOnBill' => self::r2($paid), 'debitNotes' => self::r2($dn), 'billed' => $bill ? self::r2($bill['goods']) : null, 'net' => $net,
            'due' => $bill ? self::r2($net - $adv - $paid) : null];
    }

    private function grnDiff(array $po): ?array
    {
        if ($po['kind'] !== 'lot' || ! $po['lot_name']) {
            return null;
        }
        $g = $this->grnRow($po['lot_name']);
        if (! $g) {
            return null;
        }
        $received = self::n($g['good'] ?? 0) + self::n($g['damaged'] ?? 0);
        $expected = self::n($po['pieces']);
        $rate = self::rateEff($po);
        // pairs rejected later at sorting / QC (Stock line) count as damaged for the supplier claim
        $sl = $this->svc('stockline');
        $qcBad = $sl && method_exists($sl, 'extraBad') ? self::n($sl->extraBad($po['lot_name'])) : 0;
        $damaged = self::n($g['damaged'] ?? 0) + $qcBad;
        $short = max(0, $expected - $received);
        $extra = max(0, $received - $expected);
        $expBad = self::n($po['bad_est']);
        $extraDamaged = max(0, $damaged - $expBad);
        $claim = Logic::jsRound($po['pricing'] === 'lump' ? ($short + $extraDamaged) * $rate : $extraDamaged * $rate);
        return ['expected' => $expected, 'received' => $received, 'good' => self::n($g['good'] ?? 0), 'damaged' => $damaged, 'qcRejected' => $qcBad, 'short' => $short, 'extra' => $extra,
            'expBad' => $expBad, 'extraDamaged' => $extraDamaged, 'rate' => Logic::jsRound($rate), 'claim' => $claim,
            'billFor' => Logic::jsRound($po['pricing'] === 'lump' ? self::n($po['lump']) : $rate * $received), 'received_at' => $g['received_at'] ?? null,
            'ok' => ! $short && ! $extra && ! $extraDamaged];
    }

    /** three-way match: PO (agreed rate) × GRN (received) vs bill */
    private function matchFor(array $po, $goods): array
    {
        if ($po['kind'] === 'lot') {
            $d = $this->grnDiff($po);
            $expected = $d ? $d['billFor'] : $this->poAmount($po);
        } else {
            $expected = 0;
            foreach ($this->linesOf($po['id']) as $l) {
                $expected += self::n($l['received']) * self::n($l['rate']);
            }
        }
        $expected = Logic::jsRound($expected);
        return ['po' => Logic::jsRound($this->poAmount($po)), 'expected' => $expected, 'billed' => Logic::jsRound($goods), 'warn' => $goods > $expected + 1, 'diff' => Logic::jsRound($goods - $expected)];
    }

    /** the one purchase entry of a lot bought on a PO */
    private function postLot(array $po, $uid): array
    {
        if (! $po['lot_name'] || ! $po['received_on']) {
            return ['posted' => false, 'error' => null];
        }
        $l = $this->lotRow($po['lot_name']);
        if (! $l || ! (self::n($l['cost']) > 0)) {
            return ['posted' => false, 'error' => 'Lot has no cost'];
        }
        $bill = $this->billOf($po['id']);
        $sup = 'vendor:'.$po['supplier'];
        $extras = $bill ? ($this->J($bill['extras'], []) ?: []) : (self::n($l['extra']) > 0 ? [['label' => 'Extra costs (transport, cleaning)', 'amount' => self::n($l['extra']), 'paid_from' => 'accrued']] : []);
        $ex = self::r2(array_sum(array_map(fn ($e) => self::n($e['amount'] ?? 0), $extras)));
        $lines = [['account' => 'Purchases', 'debit' => self::r2(self::n($l['cost']) + $ex)], ['account' => 'Accounts Payable', 'credit' => self::r2($l['cost']), 'party' => $sup]];
        foreach ($extras as $e) {
            if (self::n($e['amount'] ?? 0) > 0) {
                $lines[] = ! empty($e['paid_from']) && $e['paid_from'] !== 'accrued'
                    ? ['account' => $e['paid_from'], 'credit' => self::r2($e['amount']), 'memo' => $e['label'] ?? null]
                    : ['account' => 'Accrued Expenses', 'credit' => self::r2($e['amount']), 'party' => 'lot:'.$po['lot_name'], 'memo' => $e['label'] ?? null];
            }
        }
        $memo = 'Lot '.$po['lot_name'].' bought from '.$po['supplier'].' ('.self::poNo($po['id']).($bill ? ', bill '.($bill['bill_no'] ?: '#'.$bill['id']) : '').')'
            .($l['pieces'] ? ' — '.$l['pieces'].' pairs' : '').($ex ? ' + '.self::fmt($ex).' extra costs' : '');
        $r = $this->post(['date' => $po['received_on'], 'memo' => $memo, 'source' => 'pur-lot', 'source_id' => $po['lot_name'], 'lines' => $lines, 'meta' => ['po' => $po['id'], 'bill' => $bill ? $bill['id'] : null]], $uid);
        Db::run('UPDATE pur_pos SET post_error=? WHERE id=?', $r['error'], $po['id']);
        return $r;
    }

    private function setStatus(array $po, string $status, array $extra = []): void
    {
        $cols = array_keys($extra);
        Db::run('UPDATE pur_pos SET status=?, updated_at=UTC_TIMESTAMP()'.implode('', array_map(fn ($c) => ", `$c`=?", $cols)).' WHERE id=?', $status, ...array_values($extra), ...[$po['id']]);
    }

    private function maybeClose(array $po, $uid): void
    {
        $po = $this->poRow($po['id']);
        $m = $this->money($po);
        if ($po['status'] === 'billed' && $m['due'] !== null && $m['due'] <= 0.5) {
            $this->setStatus($po, 'closed', ['closed_at' => $this->nowUtc()]);
            Db::run("UPDATE pur_bills SET status='paid' WHERE po_id=? AND status='posted'", $po['id']);
            $this->log($uid, 'pur.po.close', 'po:'.$po['id'], ['auto' => true]);
        }
    }

    /** instalments: what is paid goes to the earliest due first */
    private function schedule(array $bill, $paidTotal): array
    {
        $left = $paidTotal;
        return array_map(function ($i) use (&$left) {
            $p = min($i['amount'], max(0, $left));
            $left -= $p;
            return $i + ['paid' => self::r2($p), 'open' => self::r2($i['amount'] - $p)];
        }, Db::all('SELECT * FROM pur_instalments WHERE bill_id=? ORDER BY due, id', $bill['id']));
    }

    private function billState(array $b): array
    {
        $po = $b['po_id'] ? Db::get('SELECT * FROM pur_pos WHERE id=?', $b['po_id']) : null;
        $adv = $po ? Db::val("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", $po['id']) : 0;
        $paid = Db::val('SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE bill_id=?', $b['id']);
        $dn = $po ? Db::val('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', $po['id']) : 0;
        $net = self::r2(self::n($b['goods']) - $dn);
        $due = self::r2($net - $adv - $paid);
        $inst = $this->schedule($b, $paid); // instalments cover what is left after the advance
        $next = null;
        foreach ($inst as $i) {
            if ($i['open'] > 0.5) {
                $next = $i;
                break;
            }
        }
        return array_merge($b, ['extras' => $this->J($b['extras'], []), 'match' => $this->J($b['match'], null), 'po_no' => $po ? self::poNo($po['id']) : '', 'lot_name' => $po ? $po['lot_name'] : null,
            'kind' => $po ? $po['kind'] : 'supplies', 'advance' => self::r2($adv), 'paid' => self::r2($paid), 'debitNotes' => self::r2($dn), 'net' => $net, 'due' => $due, 'instalments' => $inst,
            'nextDue' => $next ? $next['due'] : $b['due_date'], 'nextAmount' => $next ? $next['open'] : $due]);
    }

    private function openBills(): array
    {
        return array_values(array_filter(array_map(fn ($b) => $this->billState($b), Db::all("SELECT * FROM pur_bills WHERE status='posted' ORDER BY due_date")), fn ($b) => $b['due'] > 0.5));
    }

    private function payables(): array
    {
        $today = $this->pkToday();
        $wk = self::addDays($today, 7);
        $rows = array_map(fn ($b) => $b + ['bucket' => $b['nextDue'] < $today ? 'overdue' : ($b['nextDue'] <= $wk ? 'week' : 'later'),
            'late' => $b['nextDue'] < $today ? self::daysBetween($b['nextDue'], $today) : 0], $this->openBills());
        $t = function ($k) use ($rows) {
            $s = 0;
            foreach ($rows as $r) {
                if ($r['bucket'] === $k) {
                    $s += $k === 'later' ? $r['due'] : $r['nextAmount'];
                }
            }
            return self::r2($s);
        };
        $cnt = fn ($k) => count(array_filter($rows, fn ($r) => $r['bucket'] === $k));
        return ['rows' => $rows, 'totals' => ['overdue' => $t('overdue'), 'week' => $t('week'), 'later' => self::r2(array_sum(array_column($rows, 'due')))],
            'counts' => ['overdue' => $cnt('overdue'), 'week' => $cnt('week'), 'later' => $cnt('later')]];
    }

    /* ======================================================== lot P&L and supplier scorecard */

    public function lotPnl($name): ?array
    {
        $l = $this->lotRow($name);
        if (! $l) {
            return null;
        }
        $E = $this->eng();
        $total = self::n($l['cost']) + self::n($l['extra']);
        $g = $this->grnRow($name);
        $po = $this->lotPO($name);
        $good = $g ? self::n($g['good'] ?? 0) : max(0, self::n($l['pieces']) - self::n($l['bad']));
        $prods = Db::all('SELECT sku, price, cost, qty, created_at, sold_at, ptype FROM products WHERE lot=?', $name);
        $lister = (int) Db::val('SELECT COUNT(*) n FROM listings WHERE lot=? AND sku NOT IN (SELECT sku FROM products WHERE lot=? AND sku IS NOT NULL)', $name, $name);
        $listed = count($prods) + $lister;
        $age = function ($p) {
            if (! $p['sold_at']) {
                return null;
            }
            if (! $p['created_at']) {
                return NAN;
            }
            return (strtotime($p['sold_at'].' UTC') - strtotime($p['created_at'].' UTC')) / 86400;
        };
        $sold = array_values(array_filter($prods, fn ($p) => $p['qty'] <= 0 && $p['sold_at']));
        $sold60 = count(array_filter($sold, fn ($p) => $age($p) <= 60));
        $sold120 = count(array_filter($sold, fn ($p) => $age($p) <= 120));
        $del = Db::all("SELECT i.price, i.qty, p.cost, p.ptype FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.variant_id=i.variant_id WHERE p.lot=? AND o.status='delivered'", $name);
        $pp = self::n($l['per_piece']) > 0 ? self::n($l['per_piece']) : ($good ? $total / $good : 0);
        $revenue = 0;
        $contrib = 0;
        $soldCost = 0;
        $n = 0;
        foreach ($del as $d) {
            $q1 = self::n($d['qty']) ?: 1;
            $n += $q1;
            $revenue += self::n($d['price']) * $q1;
            $contrib += self::n(self::ecall($E, 'breakdown', $d['price'], 0, $d['ptype'])['own'] ?? 0) * $q1;
            $soldCost += (self::n($d['cost']) > 0 ? self::n($d['cost']) : $pp) * $q1;
        }
        $stock = array_values(array_filter($prods, fn ($p) => $p['qty'] > 0));
        $unlisted = max(0, $good - $listed);
        $profit = Logic::jsRound($contrib - $total);
        return ['name' => $name, 'vendor' => $l['vendor'] ?: '', 'bought_on' => $l['bought_on'] ?: '', 'po' => $po ? ['id' => $po['id'], 'no' => self::poNo($po['id']), 'status' => $po['status']] : null,
            'pieces' => self::n($l['pieces']), 'good' => $good, 'cost' => self::n($l['cost']), 'extra' => self::n($l['extra']), 'total' => Logic::jsRound($total), 'perPair' => Logic::jsRound($pp),
            'received' => (bool) $g, 'started' => (bool) $g || $listed > 0, 'damaged' => $g ? self::n($g['damaged'] ?? 0) : null, 'listed' => $listed,
            'listedPct' => $good ? min(100, Logic::jsRound(100 * $listed / $good)) : 0, 'sold' => count($sold), 'delivered' => $n, 'revenue' => Logic::jsRound($revenue),
            'avgPrice' => $n ? Logic::jsRound($revenue / $n) : null, 'afterCosts' => Logic::jsRound($contrib), 'profit' => $profit,
            'profitPerPair' => $n ? Logic::jsRound(($contrib - $soldCost) / $n) : null, 'roi' => $total ? self::num(Logic::jsRound(1000 * $profit / $total) / 10) : null,
            'sellThrough60' => $listed ? Logic::jsRound(100 * $sold60 / $listed) : null, 'sellThrough120' => $listed ? Logic::jsRound(100 * $sold120 / $listed) : null,
            'unsold' => ['pairs' => count($stock), 'price' => Logic::jsRound(array_sum(array_map(fn ($p) => self::n($p['price']), $stock))),
                'cost' => Logic::jsRound(array_sum(array_map(fn ($p) => self::n($p['cost']) ?: $pp, $stock))), 'unlisted' => $unlisted, 'unlistedCost' => Logic::jsRound($unlisted * $pp)],
            'paidBack' => $total ? Logic::jsRound(100 * $contrib / $total) : null];
    }

    public function scorecard($vendor, $months): array
    {
        $from = self::addDays($this->pkToday(), -Logic::jsRound($months * 30.4));
        $lots = array_values(array_filter(array_map(fn ($r) => $this->lotPnl($r['name']),
            Db::all("SELECT name FROM lots WHERE vendor=? AND COALESCE(bought_on,'')>=? ORDER BY bought_on DESC", $vendor, $from))));
        $s = ['pieces' => 0, 'spent' => 0, 'total' => 0, 'expected' => 0, 'received' => 0, 'short' => 0, 'damaged' => 0, 'listed' => 0, 's60' => 0, 's120' => 0, 'delivered' => 0,
            'revenue' => 0, 'profit' => 0, 'afterCosts' => 0, 'soldCostAdj' => 0, 'lateDays' => [], 'onTime' => 0, 'withDate' => 0];
        foreach ($lots as $l) {
            $s['pieces'] += $l['pieces'];
            $s['spent'] += $l['total'];
            $s['listed'] += $l['listed'];
            $s['delivered'] += $l['delivered'];
            $s['revenue'] += $l['revenue'];
            if ($l['started']) {
                $s['total'] += $l['total'];
                $s['profit'] += $l['profit'];
                $s['afterCosts'] += $l['afterCosts'];
            }
            if ($l['profitPerPair'] !== null) {
                $s['soldCostAdj'] += $l['profitPerPair'] * $l['delivered'];
            }
            if ($l['listed']) {
                $s['s60'] += ($l['sellThrough60'] ?: 0) * $l['listed'] / 100;
                $s['s120'] += ($l['sellThrough120'] ?: 0) * $l['listed'] / 100;
            }
            $g = $this->grnRow($l['name']);
            if ($g) {
                $po = $this->lotPO($l['name']);
                $exp = $po ? self::n($po['pieces']) : (self::n($g['expected'] ?? null) ?: $l['pieces']);
                $s['expected'] += $exp;
                $s['received'] += self::n($g['good'] ?? 0) + self::n($g['damaged'] ?? 0);
                $s['short'] += max(0, $exp - self::n($g['good'] ?? 0) - self::n($g['damaged'] ?? 0));
                $s['damaged'] += self::n($g['damaged'] ?? 0);
                if ($po && $po['expected_date'] && $po['received_on']) {
                    $late = self::daysBetween($po['expected_date'], $po['received_on']);
                    $s['lateDays'][] = $late;
                    $s['withDate']++;
                    if ($late <= 0) {
                        $s['onTime']++;
                    }
                }
            }
        }
        $avgLate = $s['lateDays'] ? self::num(Logic::jsRound(10 * array_sum($s['lateDays']) / count($s['lateDays'])) / 10) : null;
        return ['supplier' => $vendor, 'months' => $months, 'lots' => count($lots), 'pieces' => $s['pieces'], 'spent' => Logic::jsRound($s['spent']),
            'avgCost' => $s['pieces'] ? Logic::jsRound($s['spent'] / $s['pieces']) : null, 'started' => count(array_filter($lots, fn ($l) => $l['started'])),
            'shortPct' => $s['expected'] ? self::num(Logic::jsRound(1000 * $s['short'] / $s['expected']) / 10) : null,
            'damagePct' => $s['received'] ? self::num(Logic::jsRound(1000 * $s['damaged'] / $s['received']) / 10) : null,
            'avgLateDays' => $avgLate, 'onTimePct' => $s['withDate'] ? Logic::jsRound(100 * $s['onTime'] / $s['withDate']) : null,
            'sellThrough60' => $s['listed'] ? Logic::jsRound(100 * $s['s60'] / $s['listed']) : null, 'sellThrough120' => $s['listed'] ? Logic::jsRound(100 * $s['s120'] / $s['listed']) : null,
            'delivered' => $s['delivered'], 'avgPrice' => $s['delivered'] ? Logic::jsRound($s['revenue'] / $s['delivered']) : null,
            'profitPerPair' => $s['delivered'] ? Logic::jsRound($s['soldCostAdj'] / $s['delivered']) : null,
            'profit' => Logic::jsRound($s['profit']), 'roi' => $s['total'] ? self::num(Logic::jsRound(1000 * $s['profit'] / $s['total']) / 10) : null, 'lotList' => $lots];
    }

    private function allScores($months): array
    {
        $this->importVendors();
        $out = [];
        foreach (Db::all("SELECT name FROM pur_suppliers WHERE active=1 AND type IN ('lots','other') ORDER BY name") as $r) {
            $s = $this->scorecard($r['name'], $months);
            if ($s['lots'] > 0) {
                $lotList = $s['lotList'];
                unset($s['lotList']);
                $s['lotsRoi'] = array_map(fn ($l) => ['name' => $l['name'], 'roi' => $l['roi']], $lotList);
                $out[] = $s;
            }
        }
        return $out;
    }

    /* ======================================================== summary for home / badges (service) */

    public function summary(): array
    {
        $today = $this->pkToday();
        $wk = self::addDays($today, 7);
        $awaiting = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status='submitted'");
        $open = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status IN ('submitted','approved','sent','partial','received','billed')");
        $arriving = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<=?", $wk);
        $late = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<?", $today);
        $notBilled = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status='received'");
        $pay = $this->payables();
        return ['awaitingApproval' => $awaiting, 'openPOs' => $open, 'arrivingThisWeek' => $arriving, 'late' => $late, 'receivedNotBilled' => $notBilled,
            'payablesDue' => self::r2($pay['totals']['overdue'] + $pay['totals']['week']), 'overdue' => $pay['totals']['overdue'], 'overdueBills' => $pay['counts']['overdue'],
            'payablesTotal' => $pay['totals']['later']];
    }

    /** WMS hook (called from POST /api/wms/lots/:name/receive) */
    public function afterGrn($name, $x, $uid): ?array
    {
        $x = is_array($x) ? $x : [];
        $po = $this->lotPO($name);
        if (! $po) {
            return null;
        }
        $on = self::pkDate($x['at'] ?? null) ?: $this->pkToday();
        $received = self::n($x['good'] ?? null) + self::n($x['damaged'] ?? null);
        $l = $this->lotRow($name);
        // the lot's cost is spread over the pieces that actually came; a per-piece lot is paid only for those pieces (until the bill says otherwise)
        if ($l && $received > 0 && ! $this->billOf($po['id'])) {
            $cost = $po['pricing'] === 'per_piece' ? self::r2(self::n($po['rate']) * $received) : self::n($l['cost']);
            if ($received != self::n($l['pieces']) || abs($cost - self::n($l['cost'])) > 0.009) {
                $this->saveLot($name, array_merge($l, ['comp' => $this->J($l['comp'], []), 'cost' => $cost, 'pieces' => $received]));
            }
        }
        if (in_array($po['status'], ['approved', 'sent', 'partial', 'received'], true)) {
            $this->setStatus($po, 'received', ['received_on' => $on]);
        } else {
            Db::run('UPDATE pur_pos SET received_on=? WHERE id=?', $on, $po['id']);
        }
        $po = $this->poRow($po['id']);
        $ps = $this->postLot($po, $uid);
        $this->log($uid, 'pur.po.receive', 'po:'.$po['id'], ['no' => self::poNo($po['id']), 'lot' => $name, 'good' => $x['good'] ?? null, 'damaged' => $x['damaged'] ?? null]);
        return ['id' => $po['id'], 'no' => self::poNo($po['id']), 'diff' => $this->grnDiff($po), 'posted' => $ps['posted'], 'error' => $ps['error']];
    }

    /** expected mix of a lot bought on a PO (Stock line sorting compares the real mix with it) */
    public function poForLot($name): ?array
    {
        $po = $this->lotPO($name);
        return $po ? ['id' => $po['id'], 'no' => self::poNo($po['id']), 'supplier' => $po['supplier'], 'status' => $po['status'], 'pieces' => self::n($po['pieces']),
            'bad_est' => self::n($po['bad_est']), 'mix' => $this->J($po['mix'], [])] : null;
    }

    /* ======================================================== cash / expense accounts */

    /** cash & bank accounts to pay from; JazzCash (wallet many suppliers are paid from) is offered too and added to the chart the first time it is used */
    private function cashAccounts(): array
    {
        try {
            $l = array_column(Db::all("SELECT name FROM acc_accounts WHERE grp='cash' AND type='asset' AND active=1 ORDER BY code"), 'name');
        } catch (\Throwable) {
            $l = ['Cash', 'Meezan (SB)'];
        }
        foreach ($l as $n) {
            if (mb_strtolower((string) $n) === 'jazzcash') {
                return $l;
            }
        }
        $l[] = 'JazzCash';
        return $l;
    }

    private function ensureJazz($a): void
    {
        if ($a !== 'JazzCash') {
            return;
        }
        try {
            if (! Db::get("SELECT id FROM acc_accounts WHERE LOWER(name)='jazzcash'")) {
                Db::run("INSERT INTO acc_accounts(code,name,type,statement,grp,`system`) VALUES(?, 'JazzCash', 'asset', 'BS', 'cash', 0)", Db::get("SELECT 1 FROM acc_accounts WHERE code='1030'") ? null : '1030');
            }
        } catch (\Throwable) {
        }
    }

    private function expenseAccounts(): array
    {
        try {
            return array_values(array_filter(array_column(Db::all("SELECT name FROM acc_accounts WHERE type='expense' AND active=1 ORDER BY code"), 'name'),
                fn ($n) => ! in_array($n, ['Cost of Goods Sold', 'Salary Exp', 'Social Media Marketing', 'Inventory Damage'], true)));
        } catch (\Throwable) {
            return ['Packaging'];
        }
    }

    private function checkAcct($a): void
    {
        $this->need(in_array($a, $this->cashAccounts(), true), 'Choose where the money was paid from');
        $this->ensureJazz($a);
    }

    private function view(?array $u): void
    {
        $this->need($this->pView($u), 'Your account does not have access to purchasing', 403);
    }

    /* ======================================================== routes */

    public function routes(Router $r): void
    {
        $r->get('/api/pur/meta', 'dashboard', 'meta');
        $r->get('/api/pur/suppliers', 'dashboard', 'suppliersList');
        $r->post('/api/pur/suppliers/import', 'dashboard', 'suppliersImport');
        $r->post('/api/pur/suppliers', 'dashboard', 'supplierSave');
        $r->get('/api/pur/suppliers/:id', 'dashboard', 'supplierShow');
        $r->post('/api/pur/suppliers/:id/pay', 'dashboard', 'supplierPay');
        $r->get('/api/pur/next-lot', 'dashboard', 'nextLot');
        $r->post('/api/pur/plan', 'dashboard', 'plan');
        $r->get('/api/pur/pos', 'dashboard', 'posList');
        $r->get('/api/pur/pos/:id', 'dashboard', 'poShow');
        $r->get('/api/pur/by-lot/:name', 'dashboard', 'byLot');
        $r->post('/api/pur/pos', 'dashboard', 'poSave');
        $r->post('/api/pur/pos/:id/submit', 'dashboard', 'poSubmit');
        $r->post('/api/pur/pos/:id/approve', 'dashboard', 'poApprove');
        $r->post('/api/pur/pos/:id/send', 'dashboard', 'poSend');
        $r->post('/api/pur/pos/:id/cancel', 'dashboard', 'poCancel');
        $r->post('/api/pur/pos/:id/close', 'dashboard', 'poClose');
        $r->post('/api/pur/pos/:id/advance', 'dashboard', 'poAdvance');
        $r->post('/api/pur/bills/:id/pay', 'dashboard', 'billPay');
        $r->post('/api/pur/pos/:id/receive', 'dashboard', 'poReceive');
        $r->post('/api/pur/pos/:id/settle', 'dashboard', 'poSettle');
        $r->post('/api/pur/pos/:id/bill', 'dashboard', 'poBill');
        $r->get('/api/pur/bills/:id', 'dashboard', 'billShow');
        $r->get('/api/pur/payables', 'dashboard', 'payablesRoute');
        $r->get('/api/pur/overview', 'dashboard', 'overview');
        $r->get('/api/pur/lots/:name', 'dashboard', 'lotShow');
        $r->get('/api/pur/scorecard', 'dashboard', 'scorecardRoute');
    }

    public function meta(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $this->importVendors();
        $P = self::PRICING;
        if (! class_exists($P)) {
            throw new \RuntimeException('Pricing engine is not available (App\\Erp\\Core\\Pricing)');
        }
        return ['types' => $P::types(), 'conds' => self::prConst('CONDS', []), 'statuses' => self::STATUSES, 'supTypes' => self::TYPES, 'store' => $this->setting('store_name', 'SundayBazar'),
            'suppliers' => Db::all('SELECT id,name,type,phone,whatsapp,terms,credit_days,instalments,active FROM pur_suppliers ORDER BY active DESC, name'),
            'cashAccounts' => $this->cashAccounts(), 'expenseAccounts' => $this->expenseAccounts(),
            'can' => ['create' => $this->pCreate($u), 'approve' => $this->pApprove($u), 'money' => $this->pMoney($u), 'supplier' => $this->pSupplier($u), 'owner' => $this->pOwner($u)]];
    }

    /* ---------- suppliers ---------- */

    public function suppliersList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $this->importVendors();
        $months = self::n($qs['months'] ?? null) == 12 ? 12 : 6;
        $scores = [];
        if ($this->pOwner($u)) {
            foreach ($this->allScores($months) as $s) {
                $scores[$s['supplier']] = $s;
            }
        }
        $fin = $this->pMoney($u) || $this->pOwner($u);
        return array_map(fn ($s) => array_merge($s, ['termsText' => self::termsText($s),
            'openPOs' => (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE supplier=? AND status IN ('draft','submitted','approved','sent','partial','received','billed')", $s['name']),
            'lots' => (int) Db::val('SELECT COUNT(*) n FROM lots WHERE vendor=?', $s['name']), 'payable' => $fin ? self::r2(-$this->vendorBal($s['name'])) : null,
            'score' => $scores[$s['name']] ?? null]), Db::all('SELECT * FROM pur_suppliers ORDER BY active DESC, name'));
    }

    public function suppliersImport(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pSupplier($u), 'Only the owner or finance can edit suppliers', 403);
        $n = $this->importVendors();
        $this->log($u['id'], 'pur.supplier.save', 'suppliers', ['imported' => $n]);
        return ['ok' => true, 'imported' => $n];
    }

    public function supplierSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pSupplier($u), 'Only the owner or finance can edit suppliers', 403);
        $name = preg_replace('/\s+/u', ' ', trim(self::str(($b['name'] ?? '') ?: '')));
        $this->need($name !== '', 'Enter the supplier name');
        $this->need(mb_strlen($name) <= 60, 'Name is too long');
        $ex = ! empty($b['id']) ? $this->supRow($b['id']) : null;
        if (! empty($b['id'])) {
            $this->need($ex, 'Supplier not found', 404);
        }
        $dup = $this->supByName($name);
        if (! $ex && $dup) {
            $full = Db::get('SELECT * FROM pur_suppliers WHERE id=?', $dup['id']);
            if ($full && $full['source'] === 'seed') {
                $ex = $full;
                Db::run("UPDATE pur_suppliers SET source='manual' WHERE id=?", $full['id']);
            }
        } // pre-filled name only: adding it again fills in its details
        $this->need(! $dup || ($ex && $dup['id'] === $ex['id']), 'A supplier with this name already exists');
        if ($ex && $ex['name'] !== $name) {
            $this->need(! Db::get('SELECT 1 FROM lots WHERE vendor=? LIMIT 1', $ex['name']) && ! Db::get('SELECT 1 FROM pur_pos WHERE supplier=? LIMIT 1', $ex['name'])
                && ! ($this->acc() && abs($this->vendorBal($ex['name'])) > 0.009) && ! Db::get('SELECT 1 FROM pur_payments WHERE supplier=? LIMIT 1', $ex['name']),
                'This supplier already has lots, POs or a balance in the accounts under its name, so the name cannot change (it links them).');
        }
        $terms = in_array($b['terms'] ?? null, ['cash', 'credit', 'instalments'], true) ? $b['terms'] : 'cash';
        $type = $b['type'] ?? null;
        $v = [$name, is_string($type) && isset(self::TYPES[$type]) ? $type : 'lots', trim(self::str(($b['phone'] ?? '') ?: '')), preg_replace('/[^\d]/', '', self::str(($b['whatsapp'] ?? '') ?: '')),
            trim(self::str(($b['city'] ?? '') ?: '')), trim(self::str(($b['address'] ?? '') ?: '')), trim(self::str(($b['bank'] ?? '') ?: '')),
            $terms, $terms === 'credit' ? max(1, self::n($b['credit_days'] ?? null) ?: 30) : null, $terms === 'instalments' ? max(2, self::n($b['instalments'] ?? null) ?: 3) : null,
            mb_substr(mb_strtoupper(trim(self::str(($b['prefix'] ?? '') ?: ''))), 0, 6) ?: null, trim(self::str(($b['note'] ?? '') ?: '')), ($b['active'] ?? null) === false ? 0 : 1];
        if ($ex) {
            Db::run("UPDATE pur_suppliers SET name=?,type=?,phone=?,whatsapp=?,city=?,address=?,bank=?,terms=?,credit_days=?,instalments=?,prefix=?,note=?,active=?,updated_at=UTC_TIMESTAMP() WHERE id=?", ...[...$v, $ex['id']]);
            $id = $ex['id'];
        } else {
            $id = Db::run("INSERT INTO pur_suppliers(name,type,phone,whatsapp,city,address,bank,terms,credit_days,instalments,prefix,note,active,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')", ...$v)->lastInsertRowid;
        }
        $this->log($u['id'], 'pur.supplier.save', 'supplier:'.$id, ['name' => $name]);
        return ['ok' => true, 'id' => $id];
    }

    public function supplierShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $s = $this->supRow($p['id']);
        $this->need($s, 'Supplier not found', 404);
        $owner = $this->pOwner($u);
        $fin = $this->pMoney($u) || $owner;
        $months = self::n($qs['months'] ?? null) == 12 ? 12 : 6;
        $bal = $this->vendorBal($s['name']);
        $pos = array_map(fn ($po) => $this->poBrief($po, $fin), Db::all('SELECT * FROM pur_pos WHERE supplier=? ORDER BY id DESC LIMIT 200', $s['name']));
        $pays = $fin ? Db::all('SELECT py.*, us.name by_name FROM pur_payments py LEFT JOIN users us ON us.id=py.user_id WHERE supplier=? ORDER BY `date` DESC, id DESC LIMIT 200', $s['name']) : [];
        $sc = $owner ? $this->scorecard($s['name'], $months) : null;
        $lots = array_map(fn ($l) => $owner ? $this->lotPnl($l['name']) : ['name' => $l['name'], 'bought_on' => $l['bought_on'], 'pieces' => $l['pieces']],
            Db::all('SELECT name, bought_on, pieces, cost, extra FROM lots WHERE vendor=? ORDER BY COALESCE(bought_on,updated_at) DESC LIMIT 100', $s['name']));
        $openAdv = $fin ? self::r2(Db::val("SELECT COALESCE(SUM(py.amount),0) v FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.supplier=? AND py.kind='advance' AND po.status IN ('approved','sent','partial','received')", $s['name'])) : null;
        if ($sc) {
            unset($sc['lotList']);
        }
        return ['supplier' => array_merge($s, ['termsText' => self::termsText($s)]), 'balance' => $fin ? self::r2($bal) : null, 'payable' => $fin ? self::r2(max(0, -$bal)) : null,
            'advance' => $fin ? self::r2(max(0, $bal)) : null, 'openAdvances' => $openAdv,
            'pos' => $pos, 'payments' => $pays, 'bills' => $fin ? array_map(fn ($x) => $this->billState($x), Db::all('SELECT * FROM pur_bills WHERE supplier=? ORDER BY id DESC LIMIT 100', $s['name'])) : [],
            'lots' => $lots, 'scorecard' => $sc];
    }

    /** a payment not tied to a bill (old balance, e.g. lots bought before purchasing was used) */
    public function supplierPay(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u), 'Only finance can record payments', 403);
        $s = $this->supRow($p['id']);
        $this->need($s, 'Supplier not found', 404);
        return $this->recordPayment(array_merge(['supplier' => $s['name'], 'kind' => 'payment'], $b), $u);
    }

    /* ---------- planner & lot names ---------- */

    public function nextLot(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        return ['name' => $this->nextLotName(self::str(($qs['supplier'] ?? '') ?: ''))];
    }

    public function plan(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $pieces = self::n($b['pieces'] ?? null);
        $cost = ($b['pricing'] ?? null) === 'lump' ? self::n($b['lump'] ?? null) : self::n($b['rate'] ?? null) * $pieces;
        $extra = isset($b['extras']) && is_array($b['extras']) && array_is_list($b['extras'])
            ? array_sum(array_map(fn ($e) => self::n(is_array($e) ? ($e['amount'] ?? null) : null), $b['extras'])) : self::n($b['extra'] ?? null);
        $v = $this->verdict(['name' => $b['lot_name'] ?? null, 'kind' => $b['lot_kind'] ?? null, 'cost' => $cost, 'extra' => $extra, 'pieces' => $pieces, 'bad' => self::n($b['bad_est'] ?? null), 'comp' => $b['mix'] ?? null]);
        if (! $this->pOwner($u)) {
            unset($v['rows']);
        }
        return $v;
    }

    /* ---------- purchase orders ---------- */

    private function poBrief(array $po, bool $fin): array
    {
        $lines = $po['kind'] === 'supplies' ? $this->linesOf($po['id']) : null;
        $m = $fin ? $this->money($po) : null;
        $plan = $this->J($po['plan'], null);
        $today = $this->pkToday();
        return ['id' => $po['id'], 'no' => self::poNo($po['id']), 'kind' => $po['kind'], 'supplier' => $po['supplier'], 'status' => $po['status'], 'lot_name' => $po['lot_name'], 'pieces' => $po['pieces'],
            'amount' => Logic::jsRound($this->poAmount($po, $lines)), 'expected_date' => $po['expected_date'], 'created_at' => $po['created_at'], 'submitted_at' => $po['submitted_at'],
            'approved_at' => $po['approved_at'], 'received_on' => $po['received_on'], 'items' => $lines !== null ? count($lines) : null, 'verdict' => $plan ? ($plan['verdict'] ?? null) : null, 'money' => $m,
            'late' => in_array($po['status'], ['approved', 'sent', 'partial'], true) && $po['expected_date'] && $po['expected_date'] < $today ? self::daysBetween($po['expected_date'], $today) : 0];
    }

    public function posList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $w = [];
        $a = [];
        $st = $qs['status'] ?? null;
        if ($st === 'open') {
            $w[] = "status IN ('draft','submitted','approved','sent','partial','received','billed')";
        } elseif ($st === 'mine') {
            $w[] = "status='draft' AND created_by=?";
            $a[] = $u['id'];
        } elseif (in_array($st, self::STATUSES, true)) {
            $w[] = 'status=?';
            $a[] = $st;
        }
        if (! empty($qs['supplier'])) {
            $w[] = 'supplier=?';
            $a[] = $qs['supplier'];
        }
        if (! empty($qs['kind'])) {
            $w[] = 'kind=?';
            $a[] = $qs['kind'];
        }
        $fin = $this->pMoney($u) || $this->pOwner($u);
        $rows = array_map(fn ($po) => $this->poBrief($po, $fin), Db::all('SELECT * FROM pur_pos '.($w ? 'WHERE '.implode(' AND ', $w) : '').' ORDER BY id DESC LIMIT 500', ...$a));
        $counts = [];
        foreach (Db::all('SELECT status, COUNT(*) n FROM pur_pos GROUP BY status') as $r) {
            $counts[$r['status']] = $r['n'];
        }
        $counts['mine'] = (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status='draft' AND created_by=?", $u['id']);
        return ['rows' => $rows, 'counts' => $counts];
    }

    private function poFull(array $po, array $u): array
    {
        $fin = $this->pMoney($u) || $this->pOwner($u);
        $lines = $this->linesOf($po['id']);
        $bill = $this->billOf($po['id']);
        $us = fn ($id) => $id ? (((Db::get('SELECT name FROM users WHERE id=?', $id) ?? [])['name'] ?? '') ?: '') : '';
        $sup = $this->supByName($po['supplier']);
        $plan = $this->J($po['plan'], null);
        if ($plan && ! $this->pOwner($u) && is_array($plan)) {
            unset($plan['rows']);
        }
        $grn = $this->grnDiff($po);
        return ['po' => array_merge($po, ['no' => self::poNo($po['id']), 'mix' => $this->J($po['mix'], []), 'extras' => $this->J($po['extras'], []), 'files' => $this->J($po['files'], []),
            'settlement' => $this->J($po['settlement'], null), 'plan' => $plan, 'amount' => Logic::jsRound($this->poAmount($po, $lines)), 'created_name' => $us($po['created_by']),
            'approved_name' => $us($po['approved_by']), 'cancelled_name' => $us($po['cancelled_by'])]),
            'supplier' => $sup ? array_merge($sup, ['termsText' => self::termsText($sup)]) : ['name' => $po['supplier']], 'lines' => $lines, 'grn' => $grn,
            'lot' => $po['lot_name'] && $fin ? $this->lotRow($po['lot_name']) : null,
            'money' => $fin ? $this->money($po) : null, 'bill' => $bill && $fin ? $this->billState($bill) : null,
            'payments' => $fin ? Db::all('SELECT py.*, us.name by_name FROM pur_payments py LEFT JOIN users us ON us.id=py.user_id WHERE py.po_id=? OR py.bill_id IN (SELECT id FROM pur_bills WHERE po_id=?) ORDER BY py.`date`, py.id', $po['id'], $po['id']) : [],
            'debitNotes' => Db::all('SELECT * FROM pur_debit_notes WHERE po_id=? ORDER BY id', $po['id']),
            'history' => Db::all('SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.entity=? ORDER BY e.id', 'po:'.$po['id']),
            'can' => ['edit' => in_array($po['status'], ['draft', 'submitted'], true) && ($this->pCreate($u) && ($po['created_by'] === $u['id'] || $this->pApprove($u))),
                'submit' => $po['status'] === 'draft' && $this->pCreate($u), 'approve' => $po['status'] === 'submitted' && $this->pApprove($u),
                'send' => $po['status'] === 'approved' && ($this->pCreate($u) || $this->pApprove($u)),
                'cancel' => in_array($po['status'], ['draft', 'submitted', 'approved', 'sent'], true) && ($this->pApprove($u) || ($po['status'] === 'draft' && $po['created_by'] === $u['id'])),
                'advance' => in_array($po['status'], ['approved', 'sent', 'partial', 'received'], true) && $this->pMoney($u),
                'receive' => $po['kind'] === 'supplies' && in_array($po['status'], ['approved', 'sent', 'partial'], true) && $this->pCreate($u),
                'receiveLot' => $po['kind'] === 'lot' && in_array($po['status'], ['approved', 'sent', 'partial', 'received'], true) && $this->can($u, 'wms'),
                'bill' => in_array($po['status'], ['received', 'partial', 'billed'], true) && $this->pMoney($u) && ! ($bill && $bill['status'] === 'paid'),
                'settle' => $po['kind'] === 'lot' && (bool) $grn && ($this->pMoney($u) || $this->pApprove($u)) && $po['status'] !== 'closed',
                'close' => $po['status'] === 'billed' && $this->pMoney($u)]];
    }

    public function poShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        return $this->poFull($this->poRow($p['id']), $u);
    }

    public function byLot(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'wms') || $this->pView($u), 'No access', 403);
        $po = $this->lotPO($p['name']);
        if (! $po) {
            return ['po' => null];
        }
        $owner = $this->pOwner($u) || $this->pMoney($u);
        $d = $this->grnDiff($po);
        $grn = null;
        if ($d && $owner) {
            $grn = $d;
        } elseif ($d) {
            unset($d['rate'], $d['claim'], $d['billFor']);
            $grn = $d;
        }
        return ['po' => ['id' => $po['id'], 'no' => self::poNo($po['id']), 'supplier' => $po['supplier'], 'status' => $po['status'], 'pieces' => $po['pieces'], 'pricing' => $po['pricing'],
            'rate' => $owner ? $po['rate'] : null, 'lump' => $owner ? $po['lump'] : null, 'bad_est' => $po['bad_est'] ?: 0, 'expected_date' => $po['expected_date'],
            'settlement' => $this->J($po['settlement'], null)], 'grn' => $grn,
            'canSettle' => (bool) $this->grnDiff($po) && ($this->pMoney($u) || $this->pApprove($u)) && $po['status'] !== 'closed'];
    }

    private function readPO(array $b, ?array $ex): array
    {
        $kind = $ex ? $ex['kind'] : (($b['kind'] ?? null) === 'supplies' ? 'supplies' : 'lot');
        $supplier = trim(self::str(($b['supplier'] ?? '') ?: ''));
        $this->need($supplier !== '', 'Choose the supplier');
        $sup = $this->supByName($supplier);
        $this->need($sup, 'Add this supplier first (Suppliers screen) — the name must match the one used on lots and in the accounts');
        $this->need(! ($kind === 'supplies' && $sup['type'] === 'lots'), $sup['name'].' sells shoe lots. Make a Lot PO instead, so the pairs go into stock and listing (a supplies PO would book them as an expense).');
        $terms = in_array($b['terms'] ?? null, ['cash', 'credit', 'instalments'], true) ? $b['terms'] : ($sup['terms'] ?: 'cash');
        $v = ['kind' => $kind, 'supplier' => $sup['name'], 'expected_date' => self::isDate($b['expected_date'] ?? null) ? $b['expected_date'] : null, 'terms' => $terms,
            'credit_days' => $terms === 'credit' ? max(1, self::n($b['credit_days'] ?? null) ?: ($sup['credit_days'] ?: 30)) : null,
            'instalments' => $terms === 'instalments' ? max(2, self::n($b['instalments'] ?? null) ?: ($sup['instalments'] ?: 3)) : null,
            'notes' => mb_substr(trim(self::str(($b['notes'] ?? '') ?: '')), 0, 1000),
            'files' => json_encode(array_slice(array_values(array_filter(isset($b['files']) && is_array($b['files']) && array_is_list($b['files']) ? $b['files'] : [])), 0, 20), JSON_UNESCAPED_UNICODE),
            'advance_plan' => max(0, self::n($b['advance_plan'] ?? null))];
        if ($kind === 'lot') {
            $name = trim(self::str(($b['lot_name'] ?? '') ?: ''));
            $this->need($name !== '', 'Enter the lot name (e.g. SH-Lot 25)');
            $other = Db::get("SELECT id FROM pur_pos WHERE lot_name=? AND status<>'cancelled' AND id<>?", $name, $ex ? $ex['id'] : 0);
            $this->need(! $other, $name.' already has purchase order '.($other ? self::poNo($other['id']) : ''));
            $l = $this->lotRow($name);
            if ($l) {
                $this->need(! $this->grnRow($name) && ! Db::get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', $name) && ! Db::get('SELECT 1 FROM products WHERE lot=? LIMIT 1', $name),
                    $name.' is already received or listed. Pick a new lot name.');
            }
            $pieces = self::rnd($b['pieces'] ?? null);
            $this->need($pieces > 0, 'Enter the expected number of pieces');
            $pricing = ($b['pricing'] ?? null) === 'lump' ? 'lump' : 'per_piece';
            if ($pricing === 'lump') {
                $this->need(self::n($b['lump'] ?? null) > 0, 'Enter the lump-sum price');
            } else {
                $this->need(self::n($b['rate'] ?? null) > 0, 'Enter the price per piece');
            }
            $bad = max(0, self::rnd($b['bad_est'] ?? null));
            $this->need($bad < $pieces, "Expected bad pairs can't be equal to or more than the pieces");
            $extras = [];
            foreach (isset($b['extras']) && is_array($b['extras']) && array_is_list($b['extras']) ? $b['extras'] : [] as $e) {
                if ($e && is_array($e) && self::n($e['amount'] ?? null) > 0) {
                    $extras[] = ['label' => mb_substr(trim(self::str(($e['label'] ?? '') ?: 'Extra cost')), 0, 60), 'amount' => self::r2($e['amount'])];
                }
            }
            $v += ['lot_name' => $name, 'lot_kind' => ($b['lot_kind'] ?? null) === 'leftover' ? 'leftover' : 'used', 'pieces' => $pieces, 'pricing' => $pricing,
                'rate' => $pricing === 'per_piece' ? self::r2($b['rate'] ?? null) : null, 'lump' => $pricing === 'lump' ? self::r2($b['lump'] ?? null) : null,
                'mix' => json_encode(self::cleanComp($b['mix'] ?? null), JSON_UNESCAPED_UNICODE), 'bad_est' => $bad, 'extras' => json_encode($extras, JSON_UNESCAPED_UNICODE),
                'extra_total' => self::r2(array_sum(array_column($extras, 'amount')))];
            $plan = $this->verdict(['name' => $name, 'kind' => $v['lot_kind'], 'cost' => $pricing === 'lump' ? $v['lump'] : $v['rate'] * $pieces, 'extra' => $v['extra_total'],
                'pieces' => $pieces, 'bad' => $bad, 'comp' => self::cleanComp($b['mix'] ?? null)]);
            $v['plan'] = json_encode($plan, JSON_UNESCAPED_UNICODE);
        } else {
            $lines = [];
            foreach (isset($b['lines']) && is_array($b['lines']) && array_is_list($b['lines']) ? $b['lines'] : [] as $l) {
                if ($l && is_array($l) && trim(self::str(($l['item'] ?? '') ?: '')) !== '' && self::n($l['qty'] ?? null) > 0) {
                    $lines[] = ['item' => mb_substr(trim(self::str($l['item'])), 0, 100), 'qty' => self::n($l['qty']), 'unit' => mb_substr(trim(self::str(($l['unit'] ?? '') ?: 'pcs')), 0, 20),
                        'rate' => self::r2($l['rate'] ?? null)];
                }
            }
            $this->need(count($lines), 'Add at least one item with a quantity');
            $this->need(! array_filter($lines, fn ($l) => ! ($l['rate'] >= 0)), 'Rates cannot be negative');
            $v['lines'] = $lines;
            $v['lot_name'] = null;
        }
        return $v;
    }

    public function poSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pCreate($u), 'Only listing or warehouse staff can create purchase orders', 403);
        $ex = ! empty($b['id']) ? $this->poRow($b['id']) : null;
        if ($ex) {
            $this->need(in_array($ex['status'], ['draft', 'submitted'], true), 'Only a draft or a PO waiting for approval can be edited');
            $this->need($ex['created_by'] === $u['id'] || $this->pApprove($u), 'Only the person who made it or an approver can edit it', 403);
        }
        $v = $this->readPO($b, $ex);
        $cols = array_values(array_filter(self::COLS, fn ($k) => array_key_exists($k, $v)));
        $vals = array_map(fn ($k) => $v[$k] ?? null, $cols);
        $id = Db::tx(function () use ($ex, $v, $cols, $vals, $u) {
            if ($ex) {
                Db::run('UPDATE pur_pos SET '.implode(',', array_map(fn ($k) => "`$k`=?", $cols)).", updated_at=UTC_TIMESTAMP() WHERE id=?", ...[...$vals, $ex['id']]);
                $id = $ex['id'];
            } else {
                $id = Db::run('INSERT INTO pur_pos(kind,'.implode(',', array_map(fn ($k) => "`$k`", $cols)).',created_by) VALUES(?,'.implode(',', array_fill(0, count($cols), '?')).',?)',
                    ...[$v['kind'], ...$vals, $u['id']])->lastInsertRowid;
            }
            if (isset($v['lines'])) {
                Db::run('DELETE FROM pur_po_lines WHERE po_id=?', $id);
                foreach ($v['lines'] as $l) {
                    Db::run('INSERT INTO pur_po_lines(po_id,item,qty,unit,rate) VALUES(?,?,?,?,?)', $id, $l['item'], $l['qty'], $l['unit'], $l['rate']);
                }
            }
            return $id;
        });
        $detail = ['no' => self::poNo($id), 'kind' => $v['kind'], 'supplier' => $v['supplier']];
        if (! empty($v['lot_name'])) {
            $detail['lot'] = $v['lot_name'];
        }
        $this->log($u['id'], $ex ? 'pur.po.edit' : 'pur.po.create', 'po:'.$id, $detail);
        if (! empty($b['submit']) && ! $ex) {
            $this->setStatus($this->poRow($id), 'submitted', ['submitted_at' => $this->nowUtc()]);
            $this->log($u['id'], 'pur.po.submit', 'po:'.$id, ['no' => self::poNo($id)]);
        }
        return ['ok' => true, 'id' => $id, 'no' => self::poNo($id)];
    }

    public function poSubmit(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pCreate($u), 'No access', 403);
        $po = $this->poRow($p['id']);
        $this->need($po['status'] === 'draft', 'Only a draft can be sent for approval');
        $this->setStatus($po, 'submitted', ['submitted_at' => $this->nowUtc()]);
        $this->log($u['id'], 'pur.po.submit', 'po:'.$po['id'], ['no' => self::poNo($po['id'])]);
        return ['ok' => true, 'status' => 'submitted'];
    }

    public function poApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pApprove($u), 'Only the owner (or someone allowed to set prices) can approve purchase orders', 403);
        $po = $this->poRow($p['id']);
        $this->need(in_array($po['status'], ['submitted', 'draft'], true), 'This PO is not waiting for approval');
        Db::tx(function () use ($po, $u) {
            if ($po['kind'] === 'lot') {
                $l = $this->lotRow($po['lot_name']);
                if ($l) {
                    $this->need(! $this->grnRow($po['lot_name']), $po['lot_name'].' is already received');
                }
                $this->saveLot($po['lot_name'], ['vendor' => $po['supplier'], 'bought_on' => $po['expected_date'] ?: $this->pkToday(), 'cost' => $this->poAmount($po), 'extra' => $po['extra_total'] ?: 0,
                    'pieces' => $po['pieces'], 'bad' => $po['bad_est'] ?: 0, 'kind' => $po['lot_kind'], 'comp' => $this->J($po['mix'], []),
                    'note' => self::poNo($po['id']).($po['notes'] ? ' · '.mb_substr($po['notes'], 0, 120) : '')]);
            }
            $this->setStatus($po, 'approved', ['approved_by' => $u['id'], 'approved_at' => $this->nowUtc(), 'submitted_at' => $po['submitted_at'] ?: $this->nowUtc()]);
        });
        $d = ['no' => self::poNo($po['id']), 'amount' => Logic::jsRound($this->poAmount($po))];
        if ($po['lot_name']) {
            $d['lot'] = $po['lot_name'];
        }
        $this->log($u['id'], 'pur.po.approve', 'po:'.$po['id'], $d);
        if ($po['kind'] === 'lot') {
            $this->log($u['id'], 'lot.save', 'lot:'.$po['lot_name'], ['cost' => self::num($this->poAmount($po)), 'pieces' => $po['pieces'], 'po' => self::poNo($po['id'])]);
        }
        return ['ok' => true, 'status' => 'approved'];
    }

    public function poSend(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pCreate($u) || $this->pApprove($u), 'No access', 403);
        $po = $this->poRow($p['id']);
        $this->need($po['status'] === 'approved', 'Approve the PO before sending it to the supplier');
        $this->setStatus($po, 'sent', ['sent_at' => $this->nowUtc()]);
        $this->log($u['id'], 'pur.po.send', 'po:'.$po['id'], ['no' => self::poNo($po['id']), 'via' => ($b['via'] ?? null) ?: 'print']);
        return ['ok' => true, 'status' => 'sent'];
    }

    public function poCancel(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $po = $this->poRow($p['id']);
        $this->need(in_array($po['status'], array_merge(['draft', 'submitted', 'approved', 'sent'], $po['kind'] === 'supplies' ? ['partial', 'received'] : []), true),
            'A PO that is already received or billed cannot be cancelled');
        $this->need($this->pApprove($u) || ($po['status'] === 'draft' && $po['created_by'] === $u['id']), 'Only an approver can cancel this PO', 403);
        $reason = trim(self::str(($b['reason'] ?? '') ?: ''));
        $this->need($reason !== '', 'Write why it is cancelled');
        $this->need(! Db::get('SELECT 1 FROM pur_payments WHERE po_id=? LIMIT 1', $po['id']), 'An advance was paid on this PO. Record the refund / adjust it with the supplier first.');
        Db::tx(function () use ($po, $u, $reason) {
            if ($po['kind'] === 'lot' && $po['lot_name'] && in_array($po['status'], ['approved', 'sent'], true)) {
                $l = $this->lotRow($po['lot_name']);
                if ($l && ! $this->grnRow($po['lot_name']) && ! Db::get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', $po['lot_name']) && ! Db::get('SELECT 1 FROM products WHERE lot=? LIMIT 1', $po['lot_name'])) {
                    Db::run('DELETE FROM lots WHERE name=?', $po['lot_name']);
                }
            }
            $this->setStatus($po, 'cancelled', ['cancelled_at' => $this->nowUtc(), 'cancelled_by' => $u['id'], 'cancel_reason' => $reason]);
        });
        $this->log($u['id'], 'pur.po.cancel', 'po:'.$po['id'], ['no' => self::poNo($po['id']), 'reason' => $reason]);
        return ['ok' => true, 'status' => 'cancelled'];
    }

    public function poClose(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u), 'Only finance can close a PO', 403);
        $po = $this->poRow($p['id']);
        $this->need($po['status'] === 'billed', 'Only a billed PO can be closed');
        $this->setStatus($po, 'closed', ['closed_at' => $this->nowUtc()]);
        $this->log($u['id'], 'pur.po.close', 'po:'.$po['id'], ['no' => self::poNo($po['id']), 'due' => $this->money($po)['due']]);
        return ['ok' => true];
    }

    /* ---------- payments & advances ---------- */

    private function recordPayment(array $x, array $u): array
    {
        $amount = self::r2($x['amount'] ?? null);
        $this->need($amount > 0, 'Enter the amount');
        $date = self::isDate($x['date'] ?? null) ? $x['date'] : $this->pkToday();
        $this->checkAcct($x['account'] ?? null);
        $ref = $x['ref'] ?? null;
        $id = Db::run('INSERT INTO pur_payments(supplier,po_id,bill_id,kind,`date`,amount,account,ref,note,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)', $x['supplier'] ?? null, ($x['po_id'] ?? null) ?: null,
            ($x['bill_id'] ?? null) ?: null, $x['kind'] ?? null, $date, $amount, $x['account'], mb_substr(self::str($ref ?: ''), 0, 60), mb_substr(self::str(($x['note'] ?? '') ?: ''), 0, 300), $u['id'])->lastInsertRowid;
        $what = ($x['kind'] ?? null) === 'advance' ? 'Advance to '.self::str($x['supplier'] ?? null).' against '.self::poNo($x['po_id'] ?? '')
            : 'Payment to '.self::str($x['supplier'] ?? null).(! empty($x['bill_id']) ? ' — bill '.((($x['billNo'] ?? null) ?: '#'.$x['bill_id'])) : '');
        $ps = $this->post(['date' => $date, 'memo' => $what.($ref ? ' (ref '.self::str($ref).')' : ''), 'source' => 'pur-pay', 'source_id' => (string) $id, 'kind' => 'PV',
            'lines' => [['account' => 'Accounts Payable', 'debit' => $amount, 'party' => 'vendor:'.self::str($x['supplier'] ?? null)], ['account' => $x['account'], 'credit' => $amount]]], $u['id']);
        if (! $ps['posted']) {
            Db::run('DELETE FROM pur_payments WHERE id=?', $id);
            $this->need(! $this->acc(), 'Not posted to accounts: '.$ps['error']);
        }
        $d = ['amount' => $amount, 'account' => $x['account']];
        if (! empty($x['bill_id'])) {
            $d['bill'] = $x['bill_id'];
        }
        $d['supplier'] = $x['supplier'] ?? null;
        $this->log($u['id'], ($x['kind'] ?? null) === 'advance' ? 'pur.advance' : 'pur.pay', ! empty($x['po_id']) ? 'po:'.$x['po_id'] : 'supplier:'.self::str($x['supplier'] ?? null), $d);
        return ['ok' => true, 'id' => $id, 'posted' => $ps['posted']];
    }

    public function poAdvance(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u), 'Only finance can record payments', 403);
        $po = $this->poRow($p['id']);
        $this->need(in_array($po['status'], ['approved', 'sent', 'partial', 'received'], true), 'Advances can be paid on an approved PO that is not billed yet');
        return $this->recordPayment(array_merge($b, ['supplier' => $po['supplier'], 'po_id' => $po['id'], 'kind' => 'advance']), $u);
    }

    public function billPay(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u), 'Only finance can record payments', 403);
        $bill = Db::get('SELECT * FROM pur_bills WHERE id=?', (int) $p['id']);
        $this->need($bill && $bill['status'] !== 'void', 'Bill not found', 404);
        $st = $this->billState($bill);
        $this->need($st['due'] > 0.5, 'This bill is fully paid');
        $this->need(self::r2($b['amount'] ?? null) <= $st['due'] + 0.5, 'More than what is due ('.self::fmt($st['due']).')');
        $r = $this->recordPayment(array_merge($b, ['supplier' => $bill['supplier'], 'bill_id' => $bill['id'], 'billNo' => $bill['bill_no'], 'kind' => 'payment']), $u);
        if ($bill['po_id']) {
            $this->maybeClose($this->poRow($bill['po_id']), $u['id']);
        } elseif ($this->billState($bill)['due'] <= 0.5) {
            Db::run("UPDATE pur_bills SET status='paid' WHERE id=?", $bill['id']);
        }
        return $r;
    }

    /* ---------- receiving ---------- */

    public function poReceive(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pCreate($u), 'No access', 403);
        $po = $this->poRow($p['id']);
        $this->need($po['kind'] === 'supplies', 'Lots are received in Warehouse → Receiving (GRN)');
        $this->need(in_array($po['status'], ['approved', 'sent', 'partial'], true), 'Approve the PO first');
        $lines = $this->linesOf($po['id']);
        $got = [];
        foreach (isset($b['lines']) && is_array($b['lines']) ? $b['lines'] : [] as $l) {
            if (is_array($l)) {
                $got[(int) self::n($l['id'] ?? null)] = max(0, self::n($l['received'] ?? null));
            }
        }
        $this->need(array_filter($got, fn ($v) => $v > 0) || array_filter($lines, fn ($l) => $l['received'] > 0), 'Enter the quantity received');
        Db::tx(function () use ($lines, $got) {
            foreach ($lines as $l) {
                if (array_key_exists($l['id'], $got)) {
                    Db::run('UPDATE pur_po_lines SET received=? WHERE id=?', $got[$l['id']], $l['id']);
                }
            }
        });
        $nl = $this->linesOf($po['id']);
        $full = ! array_filter($nl, fn ($l) => ! ($l['received'] >= $l['qty']));
        $this->setStatus($po, $full ? 'received' : 'partial', ['received_on' => self::isDate($b['date'] ?? null) ? $b['date'] : $this->pkToday()]);
        $this->log($u['id'], 'pur.po.receive', 'po:'.$po['id'], ['no' => self::poNo($po['id']), 'lines' => array_map(fn ($l) => [$l['item'], $l['received'], $l['qty']], $nl)]);
        return ['ok' => true, 'status' => $full ? 'received' : 'partial',
            'short' => array_values(array_map(fn ($l) => ['item' => $l['item'], 'short' => self::num($l['qty'] - $l['received'])], array_filter($nl, fn ($l) => $l['received'] < $l['qty']))),
            'extra' => array_values(array_map(fn ($l) => ['item' => $l['item'], 'extra' => self::num($l['received'] - $l['qty'])], array_filter($nl, fn ($l) => $l['received'] > $l['qty'])))];
    }

    /** PO vs GRN difference settled with the supplier: discount (debit note) · return the pairs · accept as loss */
    public function poSettle(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u) || $this->pApprove($u), 'Only the owner or finance can settle with the supplier', 403);
        $po = $this->poRow($p['id']);
        $d = $this->grnDiff($po);
        $this->need($d, 'Receive the lot first');
        $this->need($po['status'] !== 'closed', 'This PO is closed');
        $choice = in_array($b['choice'] ?? null, ['discount', 'return', 'loss'], true) ? $b['choice'] : null;
        $this->need($choice, 'Choose how it is settled');
        $note = mb_substr(trim(self::str(($b['note'] ?? '') ?: '')), 0, 300);
        $date = self::isDate($b['date'] ?? null) ? $b['date'] : $this->pkToday();
        $dn = null;
        $transfer = null;
        if ($choice !== 'loss') {
            $amount = self::r2(isset($b['amount']) && $b['amount'] !== '' ? $b['amount'] : $d['claim']);
            $this->need($amount > 0, 'Enter the amount the supplier gives back');
            $dmgPcs = max(0, self::rnd(isset($b['damaged_pcs']) ? $b['damaged_pcs'] : $d['extraDamaged']));
            $shortPcs = max(0, self::rnd(isset($b['short_pcs']) ? $b['short_pcs'] : ($po['pricing'] === 'lump' ? $d['short'] : 0)));
            $rawSkus = $b['skus'] ?? null;
            $skus = array_values(array_filter(array_map(fn ($s) => trim(self::str($s)), is_array($rawSkus) ? $rawSkus : preg_split('/[\s,]+/u', self::str(($rawSkus ?? '') ?: ''))), fn ($s) => $s !== ''));
            $wms = $this->svc('wms');
            if ($choice === 'return' && $skus && $wms && method_exists($wms, 'transfer')) {
                $transfer = $wms->transfer('SUPPLIER', $skus, 'Return to '.$po['supplier'].' ('.self::poNo($po['id']).')', $u['id']);
            }
            $transferId = is_array($transfer) ? ($transfer['id'] ?? null) : $transfer;
            $id = Db::run('INSERT INTO pur_debit_notes(po_id,supplier,`date`,kind,short_pcs,damaged_pcs,amount,reason,transfer_id,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)', $po['id'], $po['supplier'], $date, $choice,
                $shortPcs, $dmgPcs, $amount, $note, $transferId, $u['id'])->lastInsertRowid;
            $dmgPart = min($amount, Logic::jsRound($dmgPcs * $d['rate']));
            $rest = self::r2($amount - $dmgPart);
            $lines = [['account' => 'Accounts Payable', 'debit' => $amount, 'party' => 'vendor:'.$po['supplier']]];
            if ($dmgPart > 0) {
                $lines[] = ['account' => 'Inventory Damage', 'credit' => $dmgPart, 'memo' => $dmgPcs.' damaged pairs'];
            }
            if ($rest > 0) {
                $lines[] = ['account' => 'Discount Received', 'credit' => $rest, 'memo' => $shortPcs ? $shortPcs.' pairs short' : 'Supplier discount'];
            }
            $parts = array_filter([$shortPcs ? $shortPcs.' short' : null, $dmgPcs ? $dmgPcs.' damaged' : null]);
            $dnNo = 'DN-'.str_pad((string) $id, 4, '0', STR_PAD_LEFT);
            $ps = $this->post(['date' => $date, 'memo' => 'Debit note '.$dnNo.' — '.$po['supplier'].', '.$po['lot_name'].' ('.($choice === 'return' ? 'pairs returned' : 'discount').': '
                .(implode(', ', $parts) ?: 'difference').')', 'source' => 'pur-dn', 'source_id' => (string) $id, 'lines' => $lines], $u['id']);
            Db::run('UPDATE pur_debit_notes SET post_error=? WHERE id=?', $ps['error'], $id);
            $dn = ['id' => $id, 'no' => $dnNo, 'amount' => $amount, 'posted' => $ps['posted'], 'error' => $ps['error']];
        }
        $st = ['choice' => $choice, 'at' => $this->nowUtc(), 'by' => $u['id'], 'dn' => $dn ? $dn['id'] : null, 'transfer' => $transfer, 'note' => $note, 'short' => $d['short'],
            'extraDamaged' => $d['extraDamaged'], 'extra' => $d['extra']];
        Db::run('UPDATE pur_pos SET settlement=?, updated_at=UTC_TIMESTAMP() WHERE id=?', json_encode($st, JSON_UNESCAPED_UNICODE), $po['id']);
        $this->log($u['id'], 'pur.settle', 'po:'.$po['id'], ['choice' => $choice, 'amount' => $dn ? $dn['amount'] : 0, 'transfer' => $transfer]);
        return ['ok' => true, 'debitNote' => $dn, 'transfer' => $transfer, 'money' => $this->money($this->poRow($po['id']))];
    }

    /* ---------- supplier bill ---------- */

    public function poBill(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u), 'Only finance can enter supplier bills', 403);
        $po = $this->poRow($p['id']);
        $this->need(in_array($po['status'], ['received', 'partial', 'billed'], true), 'The PO must be received before it is billed');
        $ex = $this->billOf($po['id']);
        if ($ex) {
            $this->need($ex['status'] !== 'paid' && ! Db::get('SELECT 1 FROM pur_payments WHERE bill_id=? LIMIT 1', $ex['id']), 'This bill already has payments. Make a debit note instead of changing it.');
        }
        $goods = self::r2($b['goods'] ?? null);
        $this->need($goods > 0, 'Enter the bill amount');
        $billDate = self::isDate($b['bill_date'] ?? null) ? $b['bill_date'] : $this->pkToday();
        $extras = [];
        foreach (isset($b['extras']) && is_array($b['extras']) && array_is_list($b['extras']) ? $b['extras'] : [] as $e) {
            if ($e && is_array($e) && self::n($e['amount'] ?? null) > 0) {
                $pf = $e['paid_from'] ?? null;
                $extras[] = ['label' => mb_substr(trim(self::str(($e['label'] ?? '') ?: 'Extra cost')), 0, 60), 'amount' => self::r2($e['amount']),
                    'paid_from' => $pf && $pf !== 'accrued' ? self::str($pf) : 'accrued'];
            }
        }
        foreach ($extras as $e) {
            if ($e['paid_from'] !== 'accrued') {
                $this->checkAcct($e['paid_from']);
            }
        }
        $extraTotal = self::r2(array_sum(array_column($extras, 'amount')));
        $sp = $this->supByName($po['supplier']);
        $this->need(! ($po['kind'] === 'supplies' && $sp && $sp['type'] === 'lots'),
            $po['supplier'].' sells shoe lots: this PO was made as a supplies PO by mistake. Cancel it and make a Lot PO, so the bill goes to '.$po['supplier']."'s account and the pairs into stock.");
        $account = $po['kind'] === 'supplies' ? self::str(($b['account'] ?? null) ?: 'Packaging') : 'Purchases';
        if ($po['kind'] === 'supplies') {
            $this->need(in_array($account, $this->expenseAccounts(), true) || in_array($account, ['Office Equipments', 'Outlet Equipments', 'Office Furniture', 'Outlet Furniture'], true), 'Choose the expense account');
        }
        $sup = $this->supByName($po['supplier']) ?: [];
        $terms = $po['terms'] ?: (($sup['terms'] ?? null) ?: 'cash');
        $dn = Db::val('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', $po['id']);
        $adv = Db::val("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", $po['id']);
        $inst = [];
        foreach (isset($b['instalments']) && is_array($b['instalments']) && array_is_list($b['instalments']) ? $b['instalments'] : [] as $i) {
            if ($i && is_array($i) && self::isDate($i['due'] ?? null) && self::n($i['amount'] ?? null) > 0) {
                $inst[] = ['due' => $i['due'], 'amount' => self::r2($i['amount'])];
            }
        }
        $netAfter = self::r2($goods - $dn - $adv);
        if (! $inst && $terms === 'instalments' && $netAfter > 0) {
            $n = (int) ($po['instalments'] ?: (($sup['instalments'] ?? null) ?: 3));
            $each = (int) floor($netAfter / $n);
            for ($i = 0; $i < $n; $i++) {
                $inst[] = ['due' => self::addDays($billDate, 30 * ($i + 1)), 'amount' => $i === $n - 1 ? self::r2($netAfter - $each * ($n - 1)) : $each];
            }
        }
        if ($inst) {
            $this->need(abs(array_sum(array_column($inst, 'amount')) - $netAfter) < 1, 'Instalments must add up to what is left to pay ('.self::fmt($netAfter).')');
        }
        $dueDate = self::isDate($b['due_date'] ?? null) ? $b['due_date'] : ($inst ? $inst[count($inst) - 1]['due']
            : ($terms === 'credit' ? self::addDays($billDate, $po['credit_days'] ?: (($sup['credit_days'] ?? null) ?: 30)) : $billDate));
        $match = $this->matchFor($po, $goods);
        $billNo = $b['bill_no'] ?? null;
        $id = Db::tx(function () use ($po, $billNo, $billDate, $dueDate, $goods, $extras, $extraTotal, $account, $match, $b, $ex, $inst, $u) {
            $vals = [$po['supplier'], mb_substr(trim(self::str($billNo ?: '')), 0, 40), $billDate, $dueDate, $goods, json_encode($extras, JSON_UNESCAPED_UNICODE), $extraTotal, $account,
                json_encode($match, JSON_UNESCAPED_UNICODE), ($b['file_id'] ?? null) ?: null];
            if ($ex) {
                Db::run("UPDATE pur_bills SET supplier=?,bill_no=?,bill_date=?,due_date=?,goods=?,extras=?,extra_total=?,account=?,`match`=?,file_id=?,status='posted' WHERE id=?", ...[...$vals, $ex['id']]);
                $id = $ex['id'];
            } else {
                $id = Db::run('INSERT INTO pur_bills(supplier,bill_no,bill_date,due_date,goods,extras,extra_total,account,`match`,file_id,po_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ...[...$vals, $po['id'], $u['id']])->lastInsertRowid;
            }
            Db::run('DELETE FROM pur_instalments WHERE bill_id=?', $id);
            foreach ($inst as $i) {
                Db::run('INSERT INTO pur_instalments(bill_id,due,amount) VALUES(?,?,?)', $id, $i['due'], $i['amount']);
            }
            $this->setStatus($po, 'billed', ['billed_at' => $this->nowUtc()]);
            return $id;
        });
        if ($po['kind'] === 'lot') {
            // the bill fixes the lot cost: lot row (per-pair cost for listing), the lot's one purchase entry, and the GRN entry follow it
            $changed = $this->updateLotCost($po['lot_name'], $goods, $extraTotal);
            $posting = $this->postLot($this->poRow($po['id']), $u['id']);
            $wms = $this->svc('wms');
            if ($changed && $wms && method_exists($wms, 'postGrn') && $this->grnRow($po['lot_name'])) {
                $wms->postGrn($po['lot_name'], $u['id']);
            }
        } else {
            $lines = [['account' => $account, 'debit' => self::r2($goods + $extraTotal)], ['account' => 'Accounts Payable', 'credit' => $goods, 'party' => 'vendor:'.$po['supplier']]];
            foreach ($extras as $e) {
                $lines[] = $e['paid_from'] !== 'accrued' ? ['account' => $e['paid_from'], 'credit' => $e['amount'], 'memo' => $e['label']]
                    : ['account' => 'Accrued Expenses', 'credit' => $e['amount'], 'party' => 'vendor:'.$po['supplier'], 'memo' => $e['label']];
            }
            $items = implode(', ', array_slice(array_column($this->linesOf($po['id']), 'item'), 0, 3));
            $posting = $this->post(['date' => $billDate, 'memo' => 'Bill '.($billNo ?: '#'.$id).' — '.$po['supplier'].' ('.self::poNo($po['id']).': '.$items.')', 'source' => 'pur-bill',
                'source_id' => (string) $id, 'lines' => $lines], $u['id']);
        }
        Db::run('UPDATE pur_bills SET post_error=? WHERE id=?', $posting['error'], $id);
        $ld = ['bill' => $id, 'bill_no' => $billNo ?: '', 'goods' => $goods, 'extras' => $extraTotal];
        if ($match['warn']) {
            $ld['warn'] = true;
        }
        $this->log($u['id'], 'pur.bill', 'po:'.$po['id'], $ld);
        $this->maybeClose($this->poRow($po['id']), $u['id']);
        return ['ok' => true, 'id' => $id, 'match' => $match, 'posted' => $posting['posted'], 'error' => $posting['error'], 'bill' => $this->billState(Db::get('SELECT * FROM pur_bills WHERE id=?', $id))];
    }

    public function billShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u) || $this->pOwner($u), 'No access', 403);
        $bill = Db::get('SELECT * FROM pur_bills WHERE id=?', (int) $p['id']);
        $this->need($bill, 'Not found', 404);
        return $this->billState($bill);
    }

    public function payablesRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pMoney($u) || $this->pOwner($u), 'Only finance can see payables', 403);
        $pay = $this->payables();
        $today0 = $this->pkToday();
        $balances = [];
        foreach (Db::all('SELECT name FROM pur_suppliers ORDER BY name') as $s) {
            $bal = self::r2($this->vendorBal($s['name']));
            if (abs($bal) > 0.5) {
                $balances[] = ['name' => $s['name'], 'id' => ($this->supByName($s['name']) ?? [])['id'] ?? null, 'balance' => $bal];
            }
        }
        $advances = array_map(fn ($a) => $a + ['no' => self::poNo($a['po_id']), 'late' => $a['expected_date'] && $a['expected_date'] < $today0 ? self::daysBetween($a['expected_date'], $today0) : 0],
            Db::all("SELECT py.supplier, py.po_id, SUM(py.amount) amount, MIN(py.`date`) `date`, po.lot_name, po.expected_date, po.status FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.kind='advance' AND po.status IN ('approved','sent','partial') GROUP BY py.po_id ORDER BY `date`"));
        $neg = 0;
        $posv = 0;
        foreach ($balances as $x) {
            if ($x['balance'] < 0) {
                $neg += $x['balance'];
            } elseif ($x['balance'] > 0) {
                $posv += $x['balance'];
            }
        }
        return $pay + ['balances' => $balances, 'advances' => $advances, 'totalPayable' => self::r2(-$neg), 'totalAdvance' => self::r2($posv)];
    }

    /* ---------- overview, lot P&L, scorecards ---------- */

    public function overview(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->view($u);
        $fin = $this->pMoney($u) || $this->pOwner($u);
        $t = $this->pkToday();
        $wk = self::addDays($t, 7);
        $sm = $this->summary();
        $counts = [];
        foreach (Db::all('SELECT status, COUNT(*) n FROM pur_pos GROUP BY status') as $r) {
            $counts[$r['status']] = $r['n'];
        }
        $list = fn (string $w, ...$a) => array_map(fn ($po) => $this->poBrief($po, $fin), Db::all("SELECT * FROM pur_pos WHERE $w ORDER BY COALESCE(expected_date,'9999'), id LIMIT 30", ...$a));
        $out = ['summary' => $fin ? $sm : array_merge($sm, ['payablesDue' => null, 'overdue' => null, 'payablesTotal' => null]), 'counts' => (object) $counts,
            'awaiting' => $list("status='submitted'"), 'arriving' => $list("status IN ('approved','sent','partial') AND expected_date<=?", $wk),
            'notBilled' => $list("status='received'"), 'mine' => $list("status='draft' AND created_by=?", $u['id']),
            'can' => ['approve' => $this->pApprove($u), 'create' => $this->pCreate($u), 'money' => $this->pMoney($u)]];
        if ($fin) {
            // purchases per month by supplier (lots by date bought + supplies bills), last 6 months
            $from = substr(self::addDays(substr($t, 0, 7).'-01', -150), 0, 7).'-01';
            $rows = Db::all("SELECT SUBSTR(bought_on,1,7) m, vendor s, SUM(cost+COALESCE(extra,0)) v FROM lots WHERE bought_on>=? GROUP BY m, s
                UNION ALL SELECT SUBSTR(b.bill_date,1,7) m, b.supplier s, SUM(b.goods+b.extra_total) v FROM pur_bills b JOIN pur_pos po ON po.id=b.po_id WHERE po.kind='supplies' AND b.status<>'void' AND b.bill_date>=? GROUP BY m, s", $from, $from);
            $tot = [];
            foreach ($rows as $r) {
                $k = ($r['s'] ?? '') ?: '?';
                $tot[$k] = ($tot[$k] ?? 0) + self::n($r['v']);
            }
            $ent = [];
            foreach ($tot as $k => $v) {
                $ent[] = [(string) $k, $v];
            }
            usort($ent, fn ($a, $b) => $b[1] <=> $a[1]);
            $top = array_map(fn ($x) => $x[0], array_slice($ent, 0, 3));
            $months = [];
            for ($i = 5; $i >= 0; $i--) {
                $d = substr(self::addDays(substr($t, 0, 7).'-15', -30.4 * $i), 0, 7);
                if (! in_array($d, $months, true)) {
                    $months[] = $d;
                }
            }
            $out['chart'] = array_map(function ($m) use ($rows, $top) {
                $o = ['m' => substr($m, 0, 4).'-'.self::MON[(int) substr($m, 5, 2) - 1]];
                foreach ($top as $i => $s) {
                    $o['s'.$i] = 0;
                }
                $o['other'] = 0;
                foreach ($rows as $r) {
                    if ($r['m'] !== $m) {
                        continue;
                    }
                    $i = array_search(($r['s'] ?? '') ?: '?', $top, true);
                    if ($i !== false) {
                        $o['s'.$i] += Logic::jsRound(self::n($r['v']));
                    } else {
                        $o['other'] += Logic::jsRound(self::n($r['v']));
                    }
                }
                return $o;
            }, $months);
            $out['chartSeries'] = array_merge(array_map(fn ($s, $i) => ['k' => 's'.$i, 'l' => $s], $top, array_keys($top)), [['k' => 'other', 'l' => 'Others']]);
            $out['payables'] = array_slice($this->payables()['rows'], 0, 8);
        }
        if ($this->pOwner($u)) {
            $sc = array_values(array_filter($this->allScores(12), fn ($s) => $s['roi'] !== null && $s['started']));
            usort($sc, fn ($a, $b) => $b['roi'] <=> $a['roi']);
            $out['top'] = array_slice($sc, 0, 3);
            $out['bottom'] = array_reverse(array_slice($sc, max(3, count($sc) - 3)));
        }
        return $out;
    }

    public function lotShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pOwner($u), 'Only the owner or finance can see lot profit', 403);
        $x = $this->lotPnl($p['name']);
        $this->need($x, 'Lot not found', 404);
        return $x;
    }

    public function scorecardRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->pOwner($u), 'Only the owner or finance can see scorecards', 403);
        return $this->allScores(self::n($qs['months'] ?? null) == 12 ? 12 : 6);
    }

    /* ======================================================== badges & alerts */

    public function counts(array $u): array
    {
        if (! $this->pView($u)) {
            return [];
        }
        $out = ['purchasing' => $this->pApprove($u) ? (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status='submitted'")
            : (int) Db::val("SELECT COUNT(*) n FROM pur_pos WHERE status='draft' AND created_by=?", $u['id'])];
        if ($this->pMoney($u)) {
            $out['payables'] = $this->payables()['counts']['overdue'];
        }
        return $out;
    }

    public function alerts(array $u): array
    {
        if (! $this->pView($u)) {
            return [];
        }
        $out = [];
        $t = $this->pkToday();
        if ($this->pApprove($u)) {
            $n = Db::get("SELECT COUNT(*) n, MIN(id) id FROM pur_pos WHERE status='submitted' AND submitted_at < (UTC_TIMESTAMP() - INTERVAL 1 DAY)");
            if ($n['n']) {
                $out[] = ['level' => 'warn', 'text' => $n['n'].' purchase order'.($n['n'] > 1 ? 's have' : ' has').' been waiting for your approval over a day',
                    'href' => $n['n'] == 1 ? '#/purchasing/po/'.$n['id'] : '#/purchasing/list/submitted'];
            }
        }
        $late = Db::all("SELECT id, supplier, lot_name, expected_date FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<? ORDER BY expected_date", $t);
        if ($late) {
            $out[] = ['level' => 'warn', 'text' => count($late).' order'.(count($late) > 1 ? 's' : '').' past the promised delivery date: '
                .implode(', ', array_map(fn ($p) => ($p['lot_name'] ?: self::poNo($p['id'])).' ('.$p['supplier'].', '.self::daysBetween($p['expected_date'], $t).' days)', array_slice($late, 0, 3))),
                'href' => count($late) === 1 ? '#/purchasing/po/'.$late[0]['id'] : '#/purchasing/list/open'];
        }
        if ($this->pMoney($u)) {
            $pay = $this->payables();
            if ($pay['counts']['overdue']) {
                $c = $pay['counts']['overdue'];
                $out[] = ['level' => 'bad', 'text' => $c.' supplier payment'.($c > 1 ? 's are' : ' is').' overdue ('.self::fmt($pay['totals']['overdue']).')', 'href' => '#/payables'];
            }
            $hi = array_values(array_filter(Db::all("SELECT b.id, b.po_id, b.supplier, b.`match` FROM pur_bills b JOIN pur_pos po ON po.id=b.po_id WHERE b.status='posted' AND po.status<>'closed'"),
                fn ($b) => ! empty(($this->J($b['match'], []) ?: [])['warn'])));
            foreach (array_slice($hi, 0, 3) as $b) {
                $m = $this->J($b['match'], []) ?: [];
                $out[] = ['level' => 'warn', 'text' => 'Bill from '.$b['supplier'].' ('.self::poNo($b['po_id']).') is '.self::fmt($m['diff'] ?? 0).' more than the PO rate × pieces received', 'href' => '#/purchasing/po/'.$b['po_id']];
            }
            $adv = Db::all("SELECT po.id, po.supplier, po.lot_name, SUM(py.amount) v FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.kind='advance' AND po.status IN ('approved','sent','partial') AND po.expected_date<? GROUP BY po.id", $t);
            if ($adv) {
                $out[] = ['level' => 'warn', 'text' => 'Advance paid but goods not received: '.implode(', ', array_map(fn ($a) => self::fmt($a['v']).' to '.$a['supplier'].' ('.($a['lot_name'] ?: self::poNo($a['id'])).')', array_slice($adv, 0, 3))),
                    'href' => '#/payables'];
            }
        }
        return $out;
    }
}
