<?php

namespace App\Erp\Core;

use App\Erp\Db;
use App\Erp\Settings;

/** Business rules: phone numbers, order status, customer score, SKU parsing, pricing suggestions. */
class Logic
{
    public const STATUS = [
        'new' => 'New', 'hold' => 'No answer / hold', 'confirmed' => 'Confirmed', 'cs_cancelled' => 'Cancelled by CS', 'picked' => 'Picked', 'packed' => 'Packed',
        'dispatched' => 'Booked / dispatched', 'in_transit' => 'In transit', 'out_for_delivery' => 'Out for delivery', 'attempted' => 'Delivery attempted',
        'delivered' => 'Delivered', 'returning' => 'Returning', 'returned' => 'Returned (RTO)', 'return_received' => 'Return received', 'cancelled' => 'Cancelled',
        'courier_cancelled' => 'Courier cancelled',
    ];

    public const OPEN_SHIP = ['dispatched', 'in_transit', 'out_for_delivery', 'attempted', 'returning'];

    public const DEFAULT_RULES = [
        'steps' => [['days' => 30, 'off' => 15], ['days' => 60, 'off' => 30], ['days' => 90, 'off' => 40], ['days' => 120, 'off' => 50]],
        'minMargin' => 20, 'roundTo' => 100, 'endWith99' => true, 'fastLot' => 60, 'fastLotRelief' => 10,
    ];

    public static function normPhone($p): string
    {
        if (! $p) {
            return '';
        }
        $d = preg_replace('/\D/', '', (string) $p);
        if (str_starts_with($d, '0092')) {
            $d = substr($d, 4);
        } elseif (str_starts_with($d, '92') && strlen($d) === 12) {
            $d = substr($d, 2);
        }
        if (strlen($d) === 10 && str_starts_with($d, '3')) {
            $d = '0'.$d;
        }
        return $d;
    }

    public static function waNumber($p): string
    {
        $n = self::normPhone($p);
        return str_starts_with($n, '0') ? '92'.substr($n, 1) : $n;
    }

    /** SKU: Rack-Category-Serial (EO-B-89582) or Rack-Serial (DT-56274) */
    public static function parseSku($sku): array
    {
        $parts = array_values(array_filter(explode('-', strtoupper(trim((string) $sku))), fn ($x) => $x !== ''));
        if (count($parts) >= 3) {
            return ['rack' => $parts[0], 'category' => $parts[1], 'serial' => implode('-', array_slice($parts, 2))];
        }
        if (count($parts) === 2) {
            return ['rack' => $parts[0], 'category' => '', 'serial' => $parts[1]];
        }
        return ['rack' => '', 'category' => '', 'serial' => $parts[0] ?? ''];
    }

    /** PostEx status text -> ERP status */
    public static function mapPostex($text): ?string
    {
        $t = strtolower((string) $text);
        if ($t === '') {
            return null;
        }
        if (str_contains($t, 'undeliver')) {
            return 'attempted';
        }
        if (str_contains($t, 'delivered') && ! str_contains($t, 'return')) {
            return 'delivered';
        }
        if ($t === 'returned' || str_contains($t, 'returned to') || str_contains($t, 'return delivered') || str_contains($t, 'returned to shipper')) {
            return 'returned';
        }
        if (str_contains($t, 'return')) {
            return 'returning';
        }
        if (str_contains($t, 'attempt') || str_contains($t, 'refused') || str_contains($t, 'review')) {
            return 'attempted';
        }
        if (str_contains($t, 'out for delivery')) {
            return 'out_for_delivery';
        }
        if (str_contains($t, 'expire') || str_contains($t, 'cancel')) {
            return 'courier_cancelled';
        }
        if (str_contains($t, 'unbooked') || str_contains($t, 'booked')) {
            return 'dispatched';
        }
        return 'in_transit';
    }

    /** Courier names as staff/Shopify type them -> one spelling */
    public static function normCourier($name): ?string
    {
        $s = trim((string) ($name ?? ''));
        if ($s === '') {
            return null;
        }
        $t = preg_replace('/[^a-z]/', '', strtolower($s));
        if (str_starts_with($t, 'tcs')) {
            return 'TCS';
        }
        if (str_starts_with($t, 'postex')) {
            return 'PostEx';
        }
        if (in_array($t, ['rider', 'ownrider', 'sbrider', 'sundaybazarrider'], true)) {
            return 'Rider';
        }
        return $s;
    }

    /** 'TCS', 'Rider' or 'PostEx' (PostEx = PostEx and anything else) */
    public static function courierKey($c): string
    {
        $n = self::normCourier($c);
        return $n === 'TCS' || $n === 'Rider' ? $n : 'PostEx';
    }

    /** TCS status text (and delivery code) -> ERP status; null = not recognised */
    public static function mapTcs($text, $code = null): ?string
    {
        $t = trim(preg_replace('/\s+/', ' ', strtolower((string) $text)));
        $c = strtoupper((string) $code);
        if ($t === '' && $c === '') {
            return null;
        }
        if (preg_match('/cancel|void/', $t)) {
            return 'courier_cancelled';
        }
        if (preg_match('/returned to (shipper|origin|consignor|client)|(return|rts|rto)[a-z ]*(delivered|received by shipper|complete)|delivered to (shipper|origin|consignor)|^returned$/', $t)) {
            return 'returned';
        }
        if (preg_match('/return|rts|rto|being sent back|send back/', $t)) {
            return 'returning';
        }
        if (preg_match('/undeliver|not deliver|refus|not available|not responding|not answer|consignee (not|absent|moved|shifted)|address (closed|not found|incomplete|incorrect|wrong)|incomplete address|wrong address|closed|attempt|unable|rescheduled|future delivery|awaiting receiver|hold/', $t)) {
            return 'attempted';
        }
        if (preg_match('/out for delivery|on route|en route|with courier|on delivery|for delivery/', $t)) {
            return 'out_for_delivery';
        }
        if (preg_match('/deliver/', $t) || $c === 'OK') {
            return 'delivered';
        }
        if (preg_match('/booked|booking|picked|pick up|pickup|data received|shipment received|received at origin|created/', $t)) {
            return 'dispatched';
        }
        if (preg_match('/arriv|depart|transit|hub|facility|manifest|dispatch|forward|station|sorting|load|connected|received at|bagged|delay/', $t)) {
            return 'in_transit';
        }
        return null;
    }

    /** Own rider: status text written by the rider app */
    public static function mapRider($text): ?string
    {
        $t = strtolower((string) $text);
        if ($t === '') {
            return null;
        }
        foreach (['returned' => 'returned', 'delivered' => 'delivered', 'failed' => 'attempted', 'rescheduled' => 'attempted', 'out' => 'out_for_delivery', 'assigned' => 'dispatched', 'cancel' => 'courier_cancelled'] as $k => $v) {
            if (str_starts_with($t, $k)) {
                return $v;
            }
        }
        return null;
    }

    /** Shopify fulfilment display status -> ERP status (null = says nothing about delivery) */
    public const SHOPIFY_SHIP = [
        'CONFIRMED' => 'dispatched', 'SUBMITTED' => 'dispatched', 'LABEL_PRINTED' => 'dispatched', 'LABEL_PURCHASED' => 'dispatched',
        'FULFILLED' => 'dispatched', 'MARKED_AS_FULFILLED' => 'dispatched', 'CARRIER_PICKED_UP' => 'in_transit', 'IN_TRANSIT' => 'in_transit',
        'DELAYED' => 'in_transit', 'OUT_FOR_DELIVERY' => 'out_for_delivery', 'READY_FOR_PICKUP' => 'out_for_delivery',
        'ATTEMPTED_DELIVERY' => 'attempted', 'FAILURE' => 'attempted', 'NOT_DELIVERED' => 'returning',
        'DELIVERED' => 'delivered', 'PICKED_UP' => 'delivered', 'CANCELED' => null, 'LABEL_VOIDED' => null,
    ];

    /** ERP status -> Shopify fulfilment event the ERP posts when ITS courier data (PostEx API, TCS, own rider) changes */
    public const SHOPIFY_EVENT = ['in_transit' => 'IN_TRANSIT', 'out_for_delivery' => 'OUT_FOR_DELIVERY', 'attempted' => 'ATTEMPTED_DELIVERY', 'delivered' => 'DELIVERED'];

    /**
     * Where the delivery status comes from: 'courier' (TCS / own rider in the ERP), 'postex' (PostEx API),
     * 'shopify' (fulfilment status in Shopify, e.g. posted by the PostEx Shopify app) or null.
     */
    public static function statusSource(array $o): ?string
    {
        $ck = ! empty($o['courier']) ? self::courierKey($o['courier']) : 'PostEx';
        if ($ck !== 'PostEx' && ! empty($o['courier_status'])) {
            return 'courier';
        }
        if (self::mapPostex($o['px_status'] ?? null)) {
            return 'postex';
        }
        if (self::SHOPIFY_SHIP[$o['sh_ship_status'] ?? ''] ?? null) {
            return 'shopify';
        }
        return null;
    }

    public static function deriveStatus(array $o): string
    {
        if (! empty($o['cancelled_at'])) {
            return 'cancelled';
        }
        if (! empty($o['return_received_at'])) {
            return 'return_received';
        }
        $ck = ! empty($o['courier']) ? self::courierKey($o['courier']) : 'PostEx';
        if ($ck !== 'PostEx' && ! empty($o['courier_status'])) {
            return ($ck === 'TCS' ? self::mapTcs($o['courier_status']) : self::mapRider($o['courier_status'])) ?: 'in_transit';
        }
        $px = self::mapPostex($o['px_status'] ?? null);
        if ($px) {
            return $px;
        }
        // no courier API data: use the delivery status Shopify has for the shipment
        $sh = self::SHOPIFY_SHIP[$o['sh_ship_status'] ?? ''] ?? null;
        if ($sh) {
            return $sh;
        }
        if (! empty($o['tracking'])) {
            return 'dispatched';
        }
        return ($o['stage'] ?? null) ?: 'new';
    }

    /** Customer score from history: Trusted / Good / New / Risky / Blacklisted */
    public static function scoreCustomer(array $c, ?array $flag): array
    {
        if ($flag && ! empty($flag['blacklist'])) {
            return ['score' => 0, 'label' => 'Blacklisted'];
        }
        $del = (int) ($c['delivered'] ?? 0);
        $ret = (int) ($c['returned'] ?? 0);
        $done = $del + $ret;
        if (! $done) {
            return ['score' => 50, 'label' => ((int) ($c['cancelled'] ?? 0)) >= 2 ? 'Risky' : 'New'];
        }
        $rate = $del / $done;
        $score = (int) round($rate * 80 + min(20, $del * 4));
        $label = 'Good';
        if ($del >= 2 && $rate >= 0.8) {
            $label = 'Trusted';
        }
        if ($rate < 0.5 || ($ret >= 2 && $rate < 0.67)) {
            $label = 'Risky';
        }
        if ($flag && ! empty($flag['vip'])) {
            $label = 'Trusted';
        }
        return ['score' => $score, 'label' => $label];
    }

    /**
     * Rebuild the per-phone customer view from orders. With $phones only those customers are rebuilt
     * (used after each incremental sync / webhook, so a new order does not rebuild thousands of rows).
     */
    public static function recomputeCustomers(?array $phones = null): int
    {
        if ($phones !== null) {
            $phones = array_values(array_unique(array_filter(array_map('strval', $phones), fn ($p) => $p !== '')));
            if (! $phones) {
                return 0;
            }
        }
        $in = $phones === null ? '' : ' AND phone IN ('.Db::marks($phones).')';
        $args = $phones ?? [];
        $flags = [];
        foreach (Db::all('SELECT * FROM customer_flags'.($phones === null ? '' : ' WHERE phone IN ('.Db::marks($phones).')'), ...$args) as $f) {
            $flags[$f['phone']] = $f;
        }
        $rows = Db::all("SELECT phone, MAX(cust_name) name, MAX(city) city, COUNT(*) orders,
      SUM(status='delivered') delivered, SUM(status IN ('returned','return_received','returning')) returned,
      SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled,
      SUM(status NOT IN ('delivered','returned','return_received','returning','cancelled','cs_cancelled','courier_cancelled')) `open`,
      SUM(CASE WHEN status='delivered' THEN total ELSE 0 END) spent, MIN(created_at) first_order, MAX(created_at) last_order
      FROM orders WHERE phone<>'' AND phone IS NOT NULL{$in} GROUP BY phone", ...$args);
        Db::tx(function () use ($rows, $flags, $phones) {
            if ($phones === null) {
                Db::run('DELETE FROM customers');
            } else {
                Db::run('DELETE FROM customers WHERE phone IN ('.Db::marks($phones).')', ...$phones);
            }
            foreach (array_chunk($rows, 300) as $chunk) {
                $vals = [];
                $args = [];
                foreach ($chunk as $r) {
                    $s = self::scoreCustomer($r, $flags[$r['phone']] ?? null);
                    $vals[] = '(?,?,?,?,?,?,?,?,?,?,?,?,?)';
                    array_push($args, $r['phone'], $r['name'], $r['city'], $r['orders'], $r['delivered'], $r['returned'], $r['cancelled'], $r['open'], $r['spent'] ?: 0, $r['first_order'], $r['last_order'], $s['score'], $s['label']);
                }
                Db::run('INSERT INTO customers(phone,name,city,orders,delivered,returned,cancelled,`open`,spent,first_order,last_order,score,label) VALUES '.implode(',', $vals), ...$args);
            }
        });
        return count($rows);
    }

    /** Recompute status for one order and apply the auto-confirm rule */
    public static function refreshOrder(string $id): void
    {
        $o = Db::get('SELECT * FROM orders WHERE id=?', $id);
        if (! $o) {
            return;
        }
        $fix = [];
        // a parcel booked in the ERP (TCS / own rider) keeps its tracking when a Shopify re-sync brings the order back without a fulfillment
        if (empty($o['tracking']) && ! empty($o['bk_tracking']) && empty($o['cancelled_at'])) {
            $o['tracking'] = $fix['tracking'] = $o['bk_tracking'];
            $o['courier'] = $fix['courier'] = $o['bk_courier'] ?? null;
        }
        if (! empty($o['courier'])) {
            $nc = self::normCourier($o['courier']);
            if ($nc !== $o['courier']) {
                $o['courier'] = $fix['courier'] = $nc;
            }
        }
        $mode = Settings::get('confirm_mode', 'risky'); // off | risky | all
        if (($o['stage'] ?? 'new') === 'new' && empty($o['tracking']) && empty($o['cancelled_at'])) {
            $auto = $mode === 'off';
            if ($mode === 'risky') {
                $c = Db::get('SELECT label FROM customers WHERE phone=?', $o['phone']);
                $auto = $c && $c['label'] === 'Trusted';
            }
            if ($auto) {
                Db::run("UPDATE orders SET stage='confirmed', cs_note=COALESCE(cs_note,'Auto-confirmed') WHERE id=?", $id);
                $o['stage'] = 'confirmed';
            }
        }
        $st = self::deriveStatus($o);
        $now = gmdate('Y-m-d H:i:s');
        $set = $fix + ['status' => $st];
        $source = self::statusSource($o);
        $when = ($o['px_updated'] ?? null) ?: (($o['courier_updated'] ?? null) ?: (($source === 'shopify' ? ($o['sh_ship_at'] ?? null) : null) ?: $now));
        if ($st === 'delivered' && empty($o['delivered_at'])) {
            $set['delivered_at'] = $when;
        }
        if (($st === 'returned' || $st === 'returning') && empty($o['returned_at'])) {
            $set['returned_at'] = $when;
        }
        if (! empty($o['tracking']) && empty($o['dispatched_at'])) {
            $set['dispatched_at'] = $now;
        }
        $keys = array_keys($set);
        Db::run('UPDATE orders SET '.implode(',', array_map(fn ($k) => "`$k`=?", $keys)).' WHERE id=?', ...array_merge(array_values($set), [$id]));

        // ERP -> Shopify: a delivery update that came from the ERP's own courier data goes to the Shopify fulfilment
        // (never one that came from Shopify itself, so nothing bounces back and forth)
        if ($st !== ($o['status'] ?? null) && isset(self::SHOPIFY_EVENT[$st]) && in_array($source, ['courier', 'postex'], true)
            && (self::SHOPIFY_SHIP[$o['sh_ship_status'] ?? ''] ?? null) !== $st && str_starts_with($id, 'gid://shopify/Order/')) {
            \App\Erp\Defer::run(fn () => app(\App\Services\Shopify\ShopifyWriter::class)->fulfillmentEvent($id, self::SHOPIFY_EVENT[$st], $when), 'shopify-fulfilment-event');
        }
    }

    /** Markdown by age on site + lot sell-through, never below cost floor */
    public static function priceSuggestion(array $p, ?array $rules, ?array $lotStats): ?array
    {
        $r = $rules ?: Settings::get('pricing_rules', self::DEFAULT_RULES);
        $age = ! empty($p['created_at']) ? (int) floor((time() - strtotime($p['created_at'].' UTC')) / 86400) : 0;
        $step = null;
        foreach ($r['steps'] as $s) {
            if ($age >= $s['days']) {
                $step = $s;
            }
        }
        if (! $step || ! ((float) $p['qty'] > 0) || ! ((float) $p['price'] > 0)) {
            return null;
        }
        $ls = $lotStats[$p['lot']] ?? null;
        $pct = $step['off'];
        if ($ls && $ls['sellThrough'] >= $r['fastLot']) {
            $pct = max(0, $pct - $r['fastLotRelief']);
        }
        $floor = ((float) ($p['cost'] ?? 0)) * (1 + $r['minMargin'] / 100);
        $price = (float) $p['price'];
        $base = ! empty($p['compare_at']) && $p['compare_at'] > $price ? (float) $p['compare_at'] : $price;
        $round = $r['roundTo'] ?: 1;
        $target = self::jsRound(($base * (1 - $pct / 100)) / $round) * $round - (! empty($r['endWith99']) ? 1 : 0);
        if ($target < $floor) {
            $target = ceil($floor / $round) * $round - (! empty($r['endWith99']) ? 1 : 0);
        }
        if ($target >= $price - $round / 2) {
            return null;
        }
        return ['age' => $age, 'pct' => $pct, 'target' => $target, 'floor' => self::jsRound($floor), 'base' => $base];
    }

    /** Math.round of JavaScript (halves round up, also for negatives) */
    public static function jsRound($v): int|float
    {
        $r = floor((float) $v + 0.5);
        return abs($r) < PHP_INT_MAX ? (int) $r : $r;
    }
}
