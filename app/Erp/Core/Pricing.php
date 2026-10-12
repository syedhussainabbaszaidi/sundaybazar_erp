<?php

namespace App\Erp\Core;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;

/**
 * Listing prices: the same model as the SundayBazar Lister (port of legacy/server/lib/pricing.js).
 * Price = what customers paid for this type and condition (Shopify), x gender x size x brand x lot x winter (boots),
 * never below the pair's cost + ads + delivery + rent/salaries + its share of the profit target.
 *
 * JS export -> PHP (all static, same names):
 *   constants  CONDS, PLAN3, KIND, GROUP, LUX, P (incl. P['lists']), M3, CEIL, ECON_DEFAULTS, STORE_AVG_VALUE
 *              -> public class constants: Pricing::CONDS, Pricing::P['lists'], ...
 *   functions  types(), allBrands(), knownBrand($b), brandTier($b), groupOf($type, $gender), autoTitle($v),
 *              valueOf($type, $cond, $gender, $brand, $size, $now), r99($x), tagsFor($it),
 *              shopifyCsv($items, $econ, $withCost), engine($econ, $opts) -> PricingEngine
 *              (public $E, $s; quote(), lotPlan(), pairCost(), breakdown(), shipFor(), avgRet()).
 *
 * Objects of the JS code are PHP assoc arrays (input and output, same keys in the same order).
 * Numbers follow JS double arithmetic in the same order; Math.round -> Logic::jsRound.
 * Integral float results are returned as int (JSON "3299" like JS, not "3299.0"); NaN/Infinity -> null (as JSON.stringify).
 * "now" (season of boots, tag dates) is DateTimeInterface | unix seconds | date string | null (= current time);
 * months are taken in the PHP default time zone (UTC on the server, like the Node server's local time).
 */
class Pricing
{
    public const CONDS = ['Like New', 'Premium', 'Excellent', 'Very Good', 'Good'];

    public const OLD_CONDS = PriceData::P['conds'];

    /** Sale plan: share of a lot expected to sell in each step, discount, day the step starts */
    public const PLAN3 = [
        ['share' => .40, 'off' => 0, 'day' => 0], ['share' => .20, 'off' => .10, 'day' => 30], ['share' => .15, 'off' => .20, 'day' => 45],
        ['share' => .15, 'off' => .30, 'day' => 60], ['share' => .10, 'off' => .40, 'day' => 90],
    ];

    public const KIND = ['used' => ['f' => 1, 't' => 'Used'], 'leftover' => ['f' => 1.03, 't' => 'Left-over']];

    public const P = PriceData::P;

    public const CEIL = PriceData::CEIL;

    private const BOOT_MEN = ['Woman' => 1, 'Men' => 1.35];

    /** pricedata M3 plus the tweaks pricing.js applies at load time (KIDS, LAD, WINTER, men's boots in GENDER) */
    public const M3 = [
        ...PriceData::M3,
        'GENDER' => [
            ...PriceData::M3['GENDER'],
            'Block Ankle Boots' => [...self::BOOT_MEN, ...(PriceData::M3['GENDER']['Block Ankle Boots'] ?? [])],
            'Chelsea Ankle Boots' => [...self::BOOT_MEN, ...(PriceData::M3['GENDER']['Chelsea Ankle Boots'] ?? [])],
            'Combat Ankle Boots' => [...self::BOOT_MEN, ...(PriceData::M3['GENDER']['Combat Ankle Boots'] ?? [])],
            'Long Boots' => [...self::BOOT_MEN, ...(PriceData::M3['GENDER']['Long Boots'] ?? [])],
            'Boots' => [...self::BOOT_MEN, ...(PriceData::M3['GENDER']['Boots'] ?? [])],
        ],
        // Kids sell at their own prices (Shopify, last 6 months)
        'KIDS' => ['Shoes' => 2650, 'Flats' => 2300, 'Boots' => 2550, 'Heels' => 2400],
        'LAD' => ['Like New' => 1.15, 'Premium' => 1.06, 'Excellent' => 1, 'Very Good' => 0.86, 'Good' => 0.75],
        // Boots sell for much more in winter (Oct-Feb vs Apr-Sep average price per pair)
        'WINTER' => ['Chelsea Ankle Boots' => 1.45, 'Block Ankle Boots' => 1.33, 'Combat Ankle Boots' => 1.25, 'Long Boots' => 1.38, 'Stilettos Ankle Boots' => 1.41, 'Boots' => 1.36],
    ];

    /** Luxury brands vs the store average for the same kind of shoe (last 12 months) */
    public const LUX = ['Michael Kors' => 1.8, 'Tory Burch' => 2.0, 'Coach' => 1.8, 'Gucci' => 2.3, 'Prada' => 2.0, 'Christian Louboutin' => 2.3, 'Salvatore Ferragamo' => 1.9,
        'Jimmy Choo' => 2.2, 'Stuart Weitzman' => 2.0, 'Kate Spade' => 1.7, 'Ted Baker' => 1.5, 'UGG' => 1.6, 'Burberry' => 2.2, 'Valentino' => 2.3, 'Saint Laurent' => 2.3,
        'Dior' => 2.4, 'Chanel' => 2.5, 'Louis Vuitton' => 2.5, 'Balenciaga' => 2.3, 'Versace' => 2.1, 'Fendi' => 2.2, 'Marc Jacobs' => 1.7, 'Calvin Klein' => 1.35, 'Tommy Hilfiger' => 1.3];

    /** Owner's numbers (Settings -> Listing costs). Defaults = the Lister's settings, Oct 2026. */
    public const ECON_DEFAULTS = [
        'adsMonthly' => 2350000, 'ordersMonthly' => 2936, 'soldMonthly' => 2700, 'fixedMonthly' => 2155780, 'targetProfit' => 1000000,
        'courierFwd' => 190, 'courierReturn' => 0, 'returnHandling' => 0, 'packing' => 120, 'codPct' => 4, 'shipCharge' => 199, 'maxReturn' => 0.8, 'ladderPct' => 0.05,
        'labelW' => 50, 'labelH' => 25, 'status' => 'draft', 'grams' => 1000,
        'letters' => ['Heels' => 'H', 'Boots' => 'B', 'Shoes' => 'S', 'Flats' => 'F', 'Kids' => 'K', 'Bags' => 'BG'],
        'body' => "<p>Authenticity meets excellence.<br>\nWe don't deal in fakes, copies, or replicas only the real deal.<br>\nOur imported, pre-owned items are meticulously inspected to ensure 100% genuine quality.<br>\nChoose from a variety of colors to match your style.<br>\nEnjoy a 7-day exchange policy for added peace of mind. Shop Sunday Bazar for trusted quality today!</p>",
    ];

    public const GROUP = ['Block Heels' => 'Heels', 'Kitten Heels' => 'Heels', 'Pumps' => 'Heels', 'Stilettos' => 'Heels', 'Wedges' => 'Heels',
        'Block Ankle Boots' => 'Boots', 'Boots' => 'Boots', 'Chelsea Ankle Boots' => 'Boots', 'Combat Ankle Boots' => 'Boots', 'Long Boots' => 'Boots', 'Stilettos Ankle Boots' => 'Boots',
        'Casual' => 'Shoes', 'Formals' => 'Shoes', 'Loafers' => 'Shoes', 'Running' => 'Shoes', 'Sports' => 'Shoes',
        'Flats' => 'Flats', 'Mules' => 'Flats', 'Sandals' => 'Flats', 'Slides' => 'Flats', 'Bags' => 'Bags'];

    public const TITLE_NOUN = ['Block Heels' => 'Block Heel', 'Kitten Heels' => 'Kitten Heel', 'Pumps' => 'Pump', 'Stilettos' => 'Stiletto', 'Wedges' => 'Wedge',
        'Block Ankle Boots' => 'Block Ankle Boot', 'Boots' => 'Boot', 'Chelsea Ankle Boots' => 'Stretchable Ankle Boot', 'Combat Ankle Boots' => 'Combat Ankle Boot', 'Long Boots' => 'Knee High Boot', 'Stilettos Ankle Boots' => 'Stiletto Ankle Boot',
        'Casual' => 'Casual Shoes', 'Formals' => 'Formal Shoes', 'Loafers' => 'Loafers', 'Running' => 'Running Shoes', 'Sports' => 'Sports Shoes',
        'Flats' => 'Flats', 'Mules' => 'Mules', 'Sandals' => 'Sandals', 'Slides' => 'Slides', 'Bags' => 'Bag'];

    public const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    public const STORE_AVG_VALUE = 3650;

    /** Marker for a missing field (JS `undefined`) where JS turns it into the text "undefined" */
    private const UNDEF = "\0undefined\0";

    // ---------------------------------------------------------------- public API

    public static function r99($x): int|float
    {
        $x = self::num($x);
        if (is_nan($x)) {
            return NAN;
        }
        return self::intish(max(99, ceil($x / 100) * 100 - 1));
    }

    public static function groupOf($type, $gender): string
    {
        return $gender === 'Kids' ? 'Kids' : (self::at(self::GROUP, $type) ?? 'Shoes');
    }

    public static function types(): array
    {
        $k = array_map('strval', array_keys(self::P['grid']));
        sort($k, SORT_STRING);
        return $k;
    }

    public static function knownBrand($b): bool
    {
        return self::ci(self::P['brands'], $b) !== null || self::ci(self::P['brandIdx'], $b) !== null
            || self::ci(self::M3['BRAND'], $b) !== null || self::ci(self::LUX, $b) !== null;
    }

    public static function allBrands(): array
    {
        $all = [];
        foreach ([self::P['brands'], self::P['brandIdx'], self::M3['BRAND'], self::LUX] as $o) {
            foreach (array_keys($o) as $k) {
                $all[(string) $k] = true;
            }
        }
        $all = array_map('strval', array_keys($all));
        sort($all, SORT_STRING);
        return $all;
    }

    public static function brandTier($b): string
    {
        $k = self::ci(self::P['brands'], $b);
        return $k !== null ? self::P['brands'][$k] : 'D';
    }

    public static function autoTitle(array $v): string
    {
        $type = self::field($v, 'type');
        $noun = self::truthy(self::at(self::TITLE_NOUN, $type)) ? self::TITLE_NOUN[$type] : $type;
        $brand = $v['brand'] ?? null;
        $b = self::truthy($brand) ? $brand : 'Brand';
        $material = $v['material'] ?? null;
        if ($material === 'Leather') {
            return self::str($b).' '.self::str($noun).' | 100% Authentic Leather';
        }
        if ($material === 'Suede') {
            return self::str($b).' Suede '.self::str($noun);
        }
        return self::str($b).' '.self::str($noun);
    }

    public static function valueOf($type, $cond, $gender = null, $brand = null, $size = null, $now = null): int|float
    {
        $b = self::baseFor($type, $cond, $gender, $now);
        if (! self::truthy($b)) {
            return 0;
        }
        return $b * self::genderF($type, $gender) * (self::truthy($brand) ? self::brandF($brand, $type)['f'] : 1)
            * (self::truthy($size) ? self::sizeF($type, $size, $gender) : 1);
    }

    /**
     * One pricing engine for a given set of owner numbers.
     * $opts: ['lotAvg' => callable(array $lot): ?number (average value of a pair in that lot), 'now' => date]
     */
    public static function engine(?array $econ = null, ?array $opts = null): PricingEngine
    {
        return new PricingEngine($econ ?? [], $opts ?? []);
    }

    /** Shopify tags of a new listing: date, group, size, condition, lot, type, gender, brand, month, material, Min-price */
    public static function tagsFor(array $it): string
    {
        $d = self::jsDate(array_key_exists('at', $it) ? $it['at'] : self::UNDEF);
        $g = self::field($it, 'grp');
        if ($d) {
            [$y, $mo, $day] = [(int) $d->format('Y'), (int) $d->format('n'), (int) $d->format('j')];
            $dd = sprintf('%02d-%02d-%d', $day, $mo, $y);
            $year = (string) $y;
            $month = self::MONTHS[$mo - 1];
        } else {
            $dd = 'NaN-NaN-NaN';
            $year = 'NaN';
            $month = self::UNDEF;
        }
        $gender = self::field($it, 'gender');
        $t = [$year, $dd, 'All', self::field($it, 'color'), $g, self::field($it, 'size'), self::field($it, 'cond'), self::field($it, 'lot'), self::field($it, 'type'),
            $gender, self::str($gender).'-'.self::str($g), self::field($it, 'brand'), $month];
        if (self::truthy($it['material'] ?? null)) {
            $t[] = $it['material'];
        }
        if (preg_match('/Ankle Boots/', self::str(self::field($it, 'type')))) {
            $t[] = 'Ankle Boots';
        }
        if (self::truthy($it['floor'] ?? null)) {
            $t[] = 'Min-'.self::str(Logic::jsRound(self::num($it['floor'])));
        }
        $seen = [];
        $out = [];
        foreach ($t as $x) {
            if ($x === self::UNDEF || ! self::truthy($x)) {
                continue;
            }
            $key = (is_int($x) || is_float($x)) ? 'n'.self::str($x) : (is_string($x) ? 's'.$x : 'o'.serialize($x));
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = self::str($x);
        }
        return implode(', ', $out);
    }

    /** Shopify product import CSV of new listings ($withCost: include "Cost per item", owner only) */
    public static function shopifyCsv(array $items, ?array $econ = null, $withCost = false): string
    {
        $s = array_merge(self::ECON_DEFAULTS, $econ ?? []);
        $head = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
            'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service',
            'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode', 'Image Src', 'Gift Card', 'Cost per item', 'Status'];
        $rows = [$head];
        foreach ($items as $it) {
            $handle = mb_strtolower(self::str(self::field($it, 'brand')).'-'.self::str(self::field($it, 'sku')));
            $handle = preg_replace('/^-|-$/', '', preg_replace('/[^a-z0-9]+/', '-', $handle));
            $cost = $it['cost'] ?? null;
            $rows[] = [$handle, $it['title'] ?? null, $s['body'] ?? null, $it['brand'] ?? null, '', $it['type'] ?? null, self::tagsFor($it), 'TRUE', 'Size', $it['size'] ?? null,
                'Condition', $it['cond'] ?? null, 'Color', $it['color'] ?? null, $it['sku'] ?? null, self::truthy($s['grams'] ?? null) ? $s['grams'] : 1000, 'shopify', 1, 'deny', 'manual',
                $it['price'] ?? null, '', 'TRUE', 'FALSE', $it['sku'] ?? null, '', 'FALSE', self::truthy($withCost) && $cost !== null ? Logic::jsRound(self::num($cost)) : '',
                strtolower(self::str(self::truthy($s['status'] ?? null) ? $s['status'] : 'draft'))];
        }
        return implode("\n", array_map(fn ($r) => implode(',', array_map([self::class, 'csvCell'], $r)), $rows));
    }

    public static function csvCell($v): string
    {
        $v = $v === null ? '' : self::str($v);
        return preg_match('/[",\n]/', $v) ? '"'.str_replace('"', '""', $v).'"' : $v;
    }

    // ---------------------------------------------------------------- model pieces (used by PricingEngine)

    /** @internal Case-insensitive key lookup (first key of $obj equal to trim(lower($key))), or null */
    public static function ci(array $obj, $key): ?string
    {
        $want = mb_strtolower(trim(self::str(self::truthy($key) ? $key : '')));
        foreach ($obj as $k => $_) {
            if (mb_strtolower((string) $k) === $want) {
                return (string) $k;
            }
        }
        return null;
    }

    /** @internal Boots: winter factor in Oct-Feb */
    public static function seasonF($type, $now): int|float
    {
        $m = (int) self::nowDate($now)->format('n');
        return ($m >= 10 || $m <= 2) ? (self::truthy($w = self::at(self::M3['WINTER'], $type)) ? $w : 1) : 1;
    }

    /** @internal What customers pay for this type and condition (null: unknown type) */
    public static function baseFor($type, $cond, $gender, $now): int|float|null
    {
        if ($gender === 'Kids') {
            $g = self::at(self::M3['GROUP'], $type);
            if (! self::truthy($g)) {
                $g = self::at(self::GROUP, $type);
            }
            $k = self::at(self::M3['KIDS'], $g);
            $k = self::truthy($k) ? $k : 2450;
            $l = self::at(self::M3['LAD'], $cond);
            return $k * (self::truthy($l) ? $l : 1);
        }
        $fin = self::at(self::M3['FINAL'], $type);
        if ($fin && self::truthy($fv = self::at($fin, $cond))) {
            return $fv * self::seasonF($type, $now);
        }
        $g = self::at(self::P['grid'], $type);
        if (! $g) {
            return null;
        }
        $ix = array_search($cond === 'Like New' ? 'Premium' : $cond, self::OLD_CONDS, true);
        $v = self::num($ix === false ? self::UNDEF : ($g[$ix] ?? self::UNDEF));
        return $v * ($cond === 'Like New' ? 1.08 : 1);
    }

    /** @internal */
    public static function genderF($type, $gender): int|float
    {
        if ($gender === 'Kids') {
            return 1;
        }
        $t = self::at(self::M3['GENDER'], $type) ?? [];
        $f = self::at($t, $gender);
        return self::truthy($f) ? $f : 1;
    }

    /** @internal */
    public static function sizeF($type, $size, $gender): int|float
    {
        if ($gender === 'Kids') {
            return 1;
        }
        $grp = self::at(self::M3['GROUP'], $type);
        $tab = self::at(self::M3['SIZE'], self::truthy($grp) ? $grp : self::at(self::GROUP, $type));
        if (! $tab) {
            return 1;
        }
        if (! preg_match('/[\d.]+/', self::str(self::truthy($size) ? $size : ''), $m)) {
            return 1;
        }
        $n = preg_match('/^(\d+\.?\d*|\.\d+)/', $m[0], $mm) ? (float) $mm[1] : NAN; // parseFloat
        if (is_nan($n)) {
            return 1;
        }
        $lo = floor($n);
        $hi = ceil($n);
        if ($n != $lo && $lo == 38 && self::truthy($tab['38-39'] ?? null)) {
            return $tab['38-39'];
        }
        $a = self::at($tab, self::str($lo));
        $b = self::at($tab, self::str($hi));
        if (self::truthy($a) && self::truthy($b)) {
            return ($a + $b) / 2;
        }
        return self::truthy($a) ? $a : (self::truthy($b) ? $b : 1);
    }

    /** @internal Brand factor: ['f' => number, 'src' => 'sales'|'tier'] */
    public static function brandF($brand, $type): array
    {
        $g = self::at(self::M3['GROUP'], $type);
        $k = self::ci(self::M3['BRAND'], $brand);
        $lk = self::ci(self::LUX, $brand);
        $lux = $lk !== null ? self::LUX[$lk] : 0;
        if ($k !== null && self::truthy($g) && self::truthy($bv = self::M3['BRAND'][$k][$g] ?? null)) {
            return ['f' => max($bv, $lux), 'src' => 'sales'];
        }
        if (self::truthy($lux)) {
            return ['f' => $lux, 'src' => 'sales'];
        }
        $tg = self::at(self::P['typeGroup'], $type);
        $bk = self::ci(self::P['brandIdx'], $brand);
        if ($bk !== null && self::truthy($tg) && self::truthy($iv = self::P['brandIdx'][$bk][$tg] ?? null)) {
            return ['f' => $iv, 'src' => 'sales'];
        }
        $tier = self::brandTier($brand);
        return ['f' => ['A' => 1.6, 'B' => 1.1][$tier] ?? 1, 'src' => 'tier'];
    }

    /** @internal Lot factor: ['f' => number, 'src' => 'history'|'Used'|'Left-over'|''] */
    public static function lotF($lot): array
    {
        if (! self::isObj($lot)) {
            return ['f' => 1, 'src' => ''];
        }
        $lot = is_array($lot) ? $lot : [];
        $k = self::ci(self::M3['HIST'], $lot['name'] ?? null);
        if ($k !== null) {
            return ['f' => self::M3['HIST'][$k], 'src' => 'history'];
        }
        $kd = self::at(self::KIND, $lot['kind'] ?? null) ?? self::KIND['used'];
        return ['f' => $kd['f'], 'src' => $kd['t']];
    }

    // ---------------------------------------------------------------- JS semantics helpers

    /** @internal JS truthiness ('0' is truthy, NaN is falsy, arrays/objects are truthy) */
    public static function truthy($v): bool
    {
        if ($v === null || $v === false || $v === '' || $v === self::UNDEF) {
            return false;
        }
        if (is_int($v)) {
            return $v !== 0;
        }
        if (is_float($v)) {
            return $v != 0 && ! is_nan($v);
        }
        return true;
    }

    /** @internal A JS object (a lot) is truthy even when empty */
    public static function isObj($v): bool
    {
        return is_array($v) || is_object($v) || self::truthy($v);
    }

    /** @internal JS Number(v) */
    public static function num($v): int|float
    {
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if ($v === null || $v === false) {
            return 0;
        }
        if ($v === true) {
            return 1;
        }
        if (is_string($v) && $v !== self::UNDEF) {
            $t = trim($v, " \t\n\r\v\f");
            if ($t === '') {
                return 0;
            }
            if (is_numeric($t) && ! preg_match('/^[+-]?\s|[eE][+-]?$/', $t)) {
                return $t + 0;
            }
            if (preg_match('/^[+-]?Infinity$/', $t)) {
                return $t[0] === '-' ? -INF : INF;
            }
        }
        return NAN;
    }

    /** @internal JS String(v) for scalars */
    public static function str($v): string
    {
        if ($v === self::UNDEF) {
            return 'undefined';
        }
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_int($v)) {
            return (string) $v;
        }
        if (is_float($v)) {
            if (is_nan($v)) {
                return 'NaN';
            }
            if (is_infinite($v)) {
                return $v > 0 ? 'Infinity' : '-Infinity';
            }
            if ($v == floor($v) && abs($v) < 1e21) {
                return $v == 0 ? '0' : sprintf('%.0f', $v);
            }
            $s = json_encode($v); // shortest round-trip digits, like JS
            if (preg_match('/^(-?)(\d)(?:\.(\d+))?e([+-]?)(\d+)$/i', $s, $m)) {
                $exp = (int) $m[5];
                if ($m[4] === '-' && $exp <= 6) {
                    return $m[1].'0.'.str_repeat('0', $exp - 1).$m[2].($m[3] ?? '');
                }
                return $m[1].$m[2].(($m[3] ?? '') !== '' ? '.'.$m[3] : '').'e'.($m[4] === '-' ? '-' : '+').$exp;
            }
            return $s;
        }
        if (is_array($v)) {
            return array_is_list($v) ? implode(',', array_map(fn ($x) => $x === null ? '' : self::str($x), $v)) : '[object Object]';
        }
        return (string) $v;
    }

    /** @internal $obj[$key] with a JS-style key, null when missing */
    public static function at(array $obj, $key)
    {
        if (! is_scalar($key) && $key !== null) {
            return null;
        }
        $k = self::str($key);
        return array_key_exists($k, $obj) ? $obj[$k] : null;
    }

    /** @internal Field of a JS object: the UNDEF marker when missing (JS turns it into "undefined" in text) */
    public static function field(array $o, string $k)
    {
        return array_key_exists($k, $o) ? $o[$k] : self::UNDEF;
    }

    /** @internal JS Math.max (NaN wins) */
    public static function jsMax(...$a): int|float
    {
        foreach ($a as $x) {
            if (is_float($x) && is_nan($x)) {
                return NAN;
            }
        }
        return max($a);
    }

    /** @internal Integral float -> int (so JSON shows 3299 like JS) */
    public static function intish($x)
    {
        if (is_float($x) && ! is_nan($x) && ! is_infinite($x) && $x == floor($x) && abs($x) < 9007199254740992) {
            return (int) $x;
        }
        return $x;
    }

    /** @internal Output clean-up: integral floats -> int, NaN/Infinity -> null (as JSON.stringify) */
    public static function clean($v)
    {
        if (is_array($v)) {
            foreach ($v as $k => $x) {
                $v[$k] = self::clean($x);
            }
            return $v;
        }
        if (is_float($v)) {
            return (is_nan($v) || is_infinite($v)) ? null : self::intish($v);
        }
        return $v;
    }

    /** @internal "now" option -> date in the default time zone */
    public static function nowDate($now): DateTimeInterface
    {
        if ($now instanceof DateTimeInterface) {
            return (new DateTimeImmutable('@'.$now->getTimestamp()))->setTimezone(new DateTimeZone(date_default_timezone_get()));
        }
        if (is_int($now) || is_float($now)) {
            return (new DateTimeImmutable('@'.(int) $now))->setTimezone(new DateTimeZone(date_default_timezone_get()));
        }
        if (is_string($now) && $now !== '') {
            $d = self::jsDate($now);
            if ($d) {
                return $d;
            }
        }
        return new DateTimeImmutable('now');
    }

    /** JS new Date(x): ms number, null (= epoch), ISO / 'Y-m-d H:i:s' string; null result = Invalid Date */
    private static function jsDate($x): ?DateTimeInterface
    {
        $tz = new DateTimeZone(date_default_timezone_get());
        if ($x === self::UNDEF || is_bool($x) || is_array($x)) {
            return null;
        }
        if ($x === null) {
            $x = 0;
        }
        if (is_int($x) || is_float($x)) {
            if (is_nan((float) $x) || is_infinite((float) $x)) {
                return null;
            }
            $sec = floor($x / 1000);
            return (new DateTimeImmutable('@'.(int) $sec))->setTimezone($tz);
        }
        $s = trim((string) $x);
        if ($s === '') {
            return null;
        }
        try {
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) {           // date only: UTC in JS
                return (new DateTimeImmutable($s.' 00:00:00', new DateTimeZone('UTC')))->setTimezone($tz);
            }
            if (preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/', $s)) {
                return (new DateTimeImmutable($s, $tz))->setTimezone($tz); // no offset: local time
            }
            $ts = strtotime($s);
            return $ts === false ? null : (new DateTimeImmutable('@'.$ts))->setTimezone($tz);
        } catch (\Throwable) {
            return null;
        }
    }
}
