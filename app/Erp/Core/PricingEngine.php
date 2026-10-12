<?php

namespace App\Erp\Core;

use RuntimeException;

/**
 * One pricing engine for a given set of owner numbers (Pricing::engine($econ, $opts), port of engine() in pricing.js).
 *
 *   $E                                  derived numbers: adsPP, ohBE, ohT, cod, keep, maxR, ladder, fwd, back, credit, mix
 *   $s                                  ECON_DEFAULTS merged with the owner's numbers
 *   quote(array $v): ?array             $v = [type, cond, gender, brand, size, lot, override]
 *   lotPlan(array $l): array            $l = [name, kind, pieces, bad, cost, extra, comp => [[t, c, g, b, n], ...]]
 *   pairCost($lot, $type, $cond, $gender = null, $brand = null, $size = null)
 *   breakdown($p, $cost, $type): array  shipFor($type)   avgRet($type)
 *
 * $opts['lotAvg']: callable(array $lot) -> average value of a pair in that lot (lots saved without "pairs by type").
 * $opts['now']: date used for the boots' winter factor (default: now).
 */
class PricingEngine
{
    public array $E;

    public array $s;

    private $lotAvgFn;

    private $now;

    public function __construct(array $settings = [], array $opt = [])
    {
        $this->s = array_merge(Pricing::ECON_DEFAULTS, $settings);
        $this->now = Pricing::nowDate($opt['now'] ?? null);
        $this->lotAvgFn = $opt['lotAvg'] ?? null;
        $M3 = Pricing::M3;
        $sold = $this->n('soldMonthly');
        $adsPP = $sold > 0 ? $this->n('adsMonthly') / $sold : 0;
        $ohBE = $sold > 0 ? $this->n('fixedMonthly') / $sold : 0;
        $ohT = $sold > 0 ? ($this->n('fixedMonthly') + $this->n('targetProfit')) / $sold : 0;
        $cod = $this->n('codPct') / 100;
        $keep = (1 - $M3['DISC']) * (1 - $cod);
        $mr = $this->n('maxReturn');
        $ld = $this->n('ladderPct', 0.04);
        $mix = 0;
        foreach (Pricing::PLAN3 as $x) {
            $mix = $mix + $x['share'] * (1 - $x['off']);
        }
        $this->E = [
            'adsPP' => $adsPP, 'ohBE' => $ohBE, 'ohT' => $ohT, 'cod' => $cod, 'keep' => $keep,
            'maxR' => min(0.95, Pricing::truthy($mr) ? $mr : 0.8), 'ladder' => Pricing::truthy($ld) ? $ld : 0.04,
            'fwd' => ($this->n('courierFwd') + $this->n('packing')) / $M3['IPO'],
            'back' => ($this->n('courierReturn') + $this->n('returnHandling')) / $M3['IPO'],
            'credit' => $this->n('shipCharge', 199) / $M3['IPO'],
            'mix' => $mix,
        ];
    }

    /** Owner number k (default d when missing/empty; NaN -> 0) */
    private function n(string $k, $d = 0): int|float
    {
        $v = $this->s[$k] ?? null;
        if ($v === null || $v === '') {
            return $d;
        }
        $x = Pricing::num($v);
        return Pricing::truthy($x) ? $x : 0;
    }

    public function avgRet($type): int|float
    {
        return Pricing::at(Pricing::M3['RET'], $type) ?? 0.2;
    }

    public function shipFor($type): int|float
    {
        $r = $this->avgRet($type);
        return ($this->E['fwd'] + $r * $this->E['back']) / (1 - $r) - $this->E['credit'];
    }

    private function add($type): array
    {
        return ['add' => $this->E['adsPP'] + $this->shipFor($type), 'fixed' => $this->E['ohBE'], 'profit' => $this->E['ohT'] - $this->E['ohBE'], 'keep' => $this->E['keep']];
    }

    /**
     * Average value of a pair in this lot. Lots saved with pairs-by-type use cpv instead. Otherwise: pairs already listed from the lot,
     * or, with too few, the value of an Excellent pair of the same type (so a sneaker lot is not costed like a heels lot).
     */
    private function lotAvg($lot, $type, $gender)
    {
        if ($this->lotAvgFn) {
            $a = ($this->lotAvgFn)($lot);
            if (Pricing::truthy($a)) {
                return $a;
            }
        }
        if (Pricing::truthy($type)) {
            $v = Pricing::valueOf($type, 'Excellent', $gender, null, null, $this->now);
            if (Pricing::truthy($v)) {
                return $v;
            }
        }
        return Pricing::STORE_AVG_VALUE;
    }

    public function pairCost($lot, $type, $cond, $gender = null, $brand = null, $size = null): int|float|null
    {
        if (! Pricing::isObj($lot)) {
            return null;
        }
        $lot = is_array($lot) ? $lot : [];
        $v = Pricing::valueOf($type, $cond, $gender, $brand, $size, $this->now);
        $cpv = Pricing::num(array_key_exists('cpv', $lot) ? $lot['cpv'] : NAN);
        if ($cpv > 0 && Pricing::truthy($v)) {
            return $cpv * $v;
        }
        $pp = Pricing::num(array_key_exists('per_piece', $lot) ? $lot['per_piece'] : NAN);
        $pp = Pricing::truthy($pp) ? $pp : 0;
        return Pricing::truthy($v) ? $pp * $v / Pricing::num($this->lotAvg($lot, $type, $gender)) : $pp;
    }

    /** Average pair cost for a type (12 months of Shopify cost), split across conditions by value */
    private function avgCost($type, $cond, $gender): int|float
    {
        $avg = Pricing::at(Pricing::M3['COST'], $type);
        $avg = Pricing::truthy($avg) ? $avg : 1000;
        $vals = [];
        foreach (Pricing::CONDS as $c) {
            $b = Pricing::baseFor($type, $c, null, $this->now);
            $b = Pricing::truthy($b) ? $b : 0;
            if ($b > 0) {
                $vals[] = $b;
            }
        }
        $sum = 0;
        foreach ($vals as $x) {
            $sum = $sum + $x;
        }
        $mv = $vals ? $sum / count($vals) : 0;
        $b = Pricing::baseFor($type, $cond, $gender, $this->now);
        $v = (Pricing::truthy($b) ? $b : 0) * Pricing::genderF($type, $gender);
        return Pricing::truthy($mv) && Pricing::truthy($v) ? $avg * $v / $mv : $avg;
    }

    /** Prices for all conditions together, so Like New > Premium > Excellent > Very Good > Good always holds */
    private function ladderRows($type, $brand, callable $costOf, array $o): ?array
    {
        $now = $this->now;
        if (Pricing::baseFor($type, 'Excellent', null, $now) === null) {
            return null;
        }
        $gender = $o['gender'] ?? null;
        $size = $o['size'] ?? null;
        $A = $this->add($type);
        $bf = Pricing::brandF($brand, $type);
        $lf = Pricing::lotF($o['lot'] ?? null);
        $f = Pricing::genderF($type, $gender) * Pricing::sizeF($type, $size, $gender) * $bf['f'] * $lf['f'];
        $boot = Pricing::truthy(Pricing::at(Pricing::M3['WINTER'], $type));
        $winter = Pricing::seasonF($type, $now) > 1;
        $rows = [];
        foreach (Pricing::CONDS as $cn) {
            $model = Pricing::r99(Pricing::baseFor($type, $cn, $gender, $now) * $f);
            $cost = $costOf($cn);
            // Ceiling: what customers actually paid for this gender/type/condition (boots: last winter), for this brand and size.
            // Listing above it makes pairs sell at about half the speed (Shopify, Oct 2026).
            $c = (! $boot || $winter) ? (Pricing::CEIL[Pricing::str(Pricing::truthy($gender) ? $gender : 'Woman').'|'.Pricing::str($type).'|'.$cn] ?? null) : null;
            $ceil = Pricing::truthy($c) ? Pricing::r99($c * $bf['f'] * ($gender === 'Men' ? 1 : Pricing::sizeF($type, $size, $gender))) : null;
            $market = $ceil !== null ? min($model, $ceil) : $model;
            if (is_float($model) && is_nan($model)) {
                $market = NAN;
            }
            // break-even incl. ads, courier, rent and salaries: never below it
            $floor = $cost !== null ? Pricing::r99(($cost + $A['add'] + $A['fixed']) / $A['keep']) : null;
            // break-even + profit-target share
            $listFloor = $cost !== null ? Pricing::r99(($cost + $A['add'] + $A['fixed'] + $A['profit']) / $A['keep']) : null;
            // List at what customers pay; never below break-even. Profit is not added on top of the customers' price (that stops sales).
            $raw = $floor !== null ? Pricing::jsMax($market, $floor) : $market;
            $status = $floor === null ? '' : ($market >= $listFloor ? 'ok' : ($market >= $floor ? 'thin' : 'loss'));
            $rows[] = ['cond' => $cn, 'market' => $market, 'model' => $model, 'ceil' => $ceil, 'floor' => $floor, 'listFloor' => $listFloor, 'cost' => $cost, 'raw' => $raw, 'status' => $status];
        }
        $last = count($rows) - 1;
        for ($i = $last; $i >= 0; $i--) {
            $rows[$i]['final'] = $i === $last ? $rows[$i]['raw']
                : Pricing::jsMax($rows[$i]['raw'], $rows[$i + 1]['final'], $rows[$i]['market'] > $rows[$i + 1]['market'] ? 0 : Pricing::r99($rows[$i + 1]['market'] * (1 + $this->E['ladder'])));
        }
        return ['rows' => $rows, 'bf' => $bf, 'lf' => $lf];
    }

    /** One delivered pair, line by line. Cancelled and returned orders are already inside these numbers. */
    public function breakdown($p, $cost, $type): array
    {
        return Pricing::clean($this->bk($p, $cost, $type));
    }

    private function bk($p, $cost, $type): array
    {
        $M3 = Pricing::M3;
        $E = $this->E;
        $p0 = $p;
        $cost0 = $cost;
        $p = Pricing::num($p);
        $cost = Pricing::num($cost);
        $r = $this->avgRet($type);
        $coupon = $p * $M3['DISC'];
        $credit = $E['credit'];
        $codAmt = ($p - $coupon + $credit) * $E['cod'];
        $courier = $this->n('courierFwd') / $M3['IPO'] / (1 - $r);
        $pack = $this->n('packing') / $M3['IPO'] / (1 - $r);
        $back = $r * $E['back'] / (1 - $r);
        $own = $p - $coupon + $credit - $codAmt - $cost - $E['adsPP'] - $courier - $pack - $back;
        return ['p' => $p0, 'coupon' => $coupon, 'credit' => $credit, 'cod' => $codAmt, 'inHand' => $p - $coupon + $credit - $codAmt, 'cost' => $cost0, 'ads' => $E['adsPP'],
            'courier' => $courier, 'pack' => $pack, 'back' => $back, 'own' => $own, 'fixed' => $E['ohBE'], 'net' => $own - $E['ohBE'], 'r' => $r];
    }

    /** The price for one pair. $v = [type, cond, gender, brand, size, lot, override] */
    public function quote(array $v): ?array
    {
        $ix = array_search($v['cond'] ?? null, Pricing::CONDS, true);
        if ($ix === false) {
            return null;
        }
        $type = $v['type'] ?? null;
        $gender = $v['gender'] ?? null;
        $brand = $v['brand'] ?? null;
        $size = $v['size'] ?? null;
        $lot = $v['lot'] ?? null;
        $hasLot = Pricing::isObj($lot);
        $costOf = fn ($cn) => $hasLot ? $this->pairCost($lot, $type, $cn, $gender, $brand, $size) : $this->avgCost($type, $cn, $gender);
        $L = $this->ladderRows($type, $brand, $costOf, ['gender' => $gender, 'size' => $size, 'lot' => $lot]);
        if (! $L) {
            return null;
        }
        $x = $L['rows'][$ix];
        $final = $x['final'];
        $why = $x['final'] != $x['raw'] || is_nan((float) $x['final']) ? 'Raised to stay above the lower condition'
            : ($x['status'] === 'ok' ? 'What customers pay for this kind of pair (profit included)'
            : ($x['status'] === 'thin' ? 'What customers pay for this kind of pair: small profit after every cost'
            : ($x['status'] === 'loss' ? 'Customers usually pay less than this pair costs to sell: held at break-even, it will sell slowly'
            : 'What customers pay for this kind of pair')));
        if (Pricing::truthy($v['override'] ?? null)) {
            $final = Logic::jsRound(Pricing::num($v['override']));
            $why = 'Owner override';
        }
        $sales = [];
        foreach (array_slice(Pricing::PLAN3, 1) as $st) {
            $plain = Pricing::r99($final * (1 - $st['off']));
            $price = Pricing::jsMax(Pricing::truthy($x['floor']) ? $x['floor'] : 0, $plain);
            $sales[] = ['day' => $st['day'], 'off' => $st['off'], 'price' => $price, 'held' => $price > $plain, 'net' => $this->bk($price, $x['cost'], $type)['net']];
        }
        return Pricing::clean([
            'final' => $final, 'why' => $why, 'status' => $x['status'], 'ceil' => $x['ceil'], 'market' => $x['market'], 'floor' => $x['floor'], 'listFloor' => $x['listFloor'],
            'cost' => $x['cost'], 'estCost' => ! $hasLot, 'brandSrc' => $L['bf']['src'], 'lotSrc' => $L['lf']['src'],
            'bk' => $this->bk($final, $x['cost'], $type), 'sales' => $sales, 'target' => $this->E['ohT'] - $this->E['ohBE'],
            'all' => array_map(fn ($r) => ['cond' => $r['cond'], 'final' => $r['final']], $L['rows']),
        ]);
    }

    /** A new lot: cost per unit of value from the pairs-by-type counts (cpv), so each pair carries its fair share of the lot cost */
    public function lotPlan(array $l): array
    {
        $now = $this->now;
        $E = $this->E;
        $num0 = fn ($x) => Pricing::truthy($y = Pricing::num($x)) ? $y : 0;
        $ok = $num0($l['pieces'] ?? NAN) - $num0($l['bad'] ?? NAN);
        $total = $num0($l['cost'] ?? NAN) + $num0($l['extra'] ?? NAN);
        $comp = is_array($l['comp'] ?? null) ? $l['comp'] : [];
        $rows = [];
        foreach ($comp as $r) {
            $r = is_array($r) ? $r : [];
            if (Pricing::num($r['n'] ?? NAN) > 0 && Pricing::truthy(Pricing::valueOf($r['t'] ?? null, $r['c'] ?? null, $r['g'] ?? null, $r['b'] ?? null, null, $now))) {
                $rows[] = $r;
            }
        }
        $nn = 0;
        $sumV = 0;
        foreach ($rows as $r) {
            $nn = $nn + Pricing::num($r['n']);
        }
        foreach ($rows as $r) {
            $sumV = $sumV + Pricing::num($r['n']) * Pricing::valueOf($r['t'] ?? null, $r['c'] ?? null, $r['g'] ?? null, $r['b'] ?? null, null, $now);
        }
        $avgV = Pricing::truthy($nn) ? $sumV / $nn : 0;
        $cpv = $ok > 0 && Pricing::truthy($avgV) ? $total / ($avgV * $ok) : 0;
        $per_piece = $ok > 0 ? Logic::jsRound($total / $ok) : 0;
        $fake = ['name' => $l['name'] ?? null, 'kind' => $l['kind'] ?? null, 'cpv' => $cpv, 'per_piece' => $per_piece];
        $contrib = 0;
        $fixed = 0;
        $listed = 0;
        $lossN = 0;
        $pairs = 0;
        $out = [];
        foreach ($rows as $r) {
            $t = $r['t'] ?? null;
            $c = $r['c'] ?? null;
            $g = $r['g'] ?? null;
            $b = $r['b'] ?? null;
            $n = Pricing::num($r['n']);
            $size = $g === 'Kids' ? 'Euro 30' : ((Pricing::at(Pricing::M3['GROUP'], $t) === 'Shoes' && $g === 'Men') ? 'Euro 42' : 'Euro 38');
            $L = $this->ladderRows($t, Pricing::truthy($b) ? $b : '', fn ($cn) => $this->pairCost($fake, $t, $cn, $g, $b), ['gender' => $g, 'size' => $size, 'lot' => $fake]);
            if (! $L) {
                throw new RuntimeException("Cannot read properties of null (reading 'rows')"); // same failure as the JS
            }
            $ix = array_search($c, Pricing::CONDS, true);
            if ($ix === false) {
                throw new RuntimeException("Cannot read properties of undefined (reading 'listFloor')");
            }
            $x = $L['rows'][$ix];
            $slow = $x['listFloor'] !== null && $x['market'] < $x['listFloor'];
            if ($slow) {
                $lossN += $n;
            }
            $contrib += $n * ($x['final'] * $E['mix'] * $E['keep'] - $E['adsPP'] - $this->shipFor($t));
            $fixed += $n * $E['ohBE'];
            $listed += $n * $x['final'];
            $pairs += $n;
            $out[] = array_merge($r, ['cost' => Logic::jsRound($x['cost']), 'price' => $x['final'], 'min' => $x['floor'], 'market' => $x['market'], 'slow' => $slow]);
        }
        $scale = Pricing::truthy($pairs) ? $ok / $pairs : 0;
        $c = $contrib * $scale * 0.9;
        $fx = $fixed * $scale * 0.9;
        $per = Pricing::truthy($ok) ? $c / ($ok * 0.9) : 0;
        $payback = $per > 0 ? (int) ceil($total / $per) : null;
        return Pricing::clean(['ok' => $ok, 'per_piece' => $per_piece, 'cpv' => $cpv, 'rows' => $out, 'pairs' => $pairs, 'listed' => Logic::jsRound($listed * $scale),
            'payback' => $payback, 'profit' => Logic::jsRound($c - $total - $fx), 'slow' => $lossN]);
    }
}
