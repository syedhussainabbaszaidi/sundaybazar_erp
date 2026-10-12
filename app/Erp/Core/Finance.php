<?php

namespace App\Erp\Core;

use App\Erp\Db;
use App\Erp\Settings;

/** Profit & loss, COD and business reports. */
class Finance
{
    private const DONE_RET = "('returned','return_received','returning')";

    public static function summary(string $month): array
    {
        $fee = (float) Settings::get('courier_fee', 250);
        $retFee = (float) Settings::get('return_fee', 150);
        $pack = (float) Settings::get('packaging_cost', 40);
        $costPct = (float) Settings::get('cost_pct', 35);
        $DR = self::DONE_RET;
        $del = Db::get("SELECT COUNT(*) n, COALESCE(SUM(total),0) revenue, COALESCE(SUM(shipping),0) shipping_charged, COALESCE(SUM(COALESCE(cod,total)),0) cod,
      COALESCE(SUM(COALESCE(px_fee,?)+COALESCE(px_tax,0)),0) courier, COALESCE(SUM(px_fee IS NULL),0) est_fee FROM orders WHERE status='delivered' AND DATE_FORMAT(delivered_at,'%Y-%m')=?", $fee, $month);
        $ret = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(px_fee,?)+COALESCE(px_tax,0)+COALESCE(px_rev_fee,?)+COALESCE(px_rev_tax,0)),0) cost, COALESCE(SUM(total),0) value
      FROM orders WHERE status IN $DR AND DATE_FORMAT(returned_at,'%Y-%m')=?", $fee, $retFee, $month);
        $cogs = Db::get("SELECT COALESCE(SUM(COALESCE(p.cost, i.price*?/100.0)*i.qty),0) cogs, COALESCE(SUM(p.cost IS NULL),0) est FROM order_items i JOIN orders o ON o.id=i.order_id
      LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.status='delivered' AND DATE_FORMAT(o.delivered_at,'%Y-%m')=?", $costPct, $month);
        $exp = Db::all("SELECT category, ROUND(SUM(amount)) amount, COUNT(*) n FROM expenses WHERE DATE_FORMAT(day,'%Y-%m')=? GROUP BY category ORDER BY amount DESC", $month);
        $expTotal = array_sum(array_column($exp, 'amount'));
        $packaging = ($del['n'] + $ret['n']) * $pack;
        $gross = $del['revenue'] - $cogs['cogs'] - $del['courier'];
        $net = $gross - $ret['cost'] - $packaging - $expTotal;
        $placed = Db::get("SELECT COUNT(*) n, COALESCE(SUM(total),0) value, COALESCE(SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')),0) cancelled FROM orders WHERE DATE_FORMAT(created_at + INTERVAL 5 HOUR,'%Y-%m')=?", $month);
        $daily = Db::all("SELECT DATE_FORMAT(delivered_at,'%Y-%m-%d') day, COUNT(*) n, ROUND(SUM(total)) revenue FROM orders WHERE status='delivered' AND DATE_FORMAT(delivered_at,'%Y-%m')=? GROUP BY day ORDER BY day", $month);
        $codPending = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total) - COALESCE(px_fee,?) - COALESCE(px_tax,0)),0) net FROM orders WHERE status='delivered' AND settled=0", $fee);
        $rate = $del['n'] + $ret['n'] ? Logic::jsRound(100 * $del['n'] / ($del['n'] + $ret['n'])) : null;
        $notes = [];
        if ($del['est_fee']) {
            $notes[] = "{$del['est_fee']} delivered parcels have no PostEx charge yet, Rs {$fee} each was used.";
        }
        if ($cogs['est']) {
            $notes[] = "{$cogs['est']} sold items have no cost in Shopify, {$costPct}% of price was used.";
        }
        if (! $exp) {
            $notes[] = 'No expenses entered for this month yet (salaries, rent, ads…). Profit will look higher than it is.';
        }
        return ['month' => $month, 'delivered' => $del, 'returned' => $ret, 'cogs' => Logic::jsRound($cogs['cogs']), 'packaging' => $packaging, 'expenses' => $exp, 'expTotal' => $expTotal,
            'gross' => Logic::jsRound($gross), 'net' => Logic::jsRound($net), 'placed' => $placed, 'daily' => $daily, 'codPending' => $codPending, 'deliveryRate' => $rate, 'notes' => $notes,
            'assumptions' => ['fee' => $fee, 'retFee' => $retFee, 'pack' => $pack, 'costPct' => $costPct]];
    }

    public static function reports(int $days): array
    {
        $since = '(UTC_TIMESTAMP() - INTERVAL '.(int) $days.' DAY)';
        $DR = self::DONE_RET;
        $daily = Db::all("SELECT DATE(created_at + INTERVAL 5 HOUR) day, COUNT(*) orders, ROUND(SUM(total)) value, SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled,
      SUM(status='delivered') delivered, SUM(status IN $DR) returned FROM orders WHERE created_at>=$since GROUP BY day ORDER BY day");
        $status = Db::all("SELECT status, COUNT(*) n, ROUND(SUM(total)) value FROM orders WHERE created_at>=$since GROUP BY status ORDER BY n DESC");
        $city = Db::all("SELECT COALESCE(NULLIF(TRIM(city),''),'(blank)') city, COUNT(*) orders, SUM(status='delivered') delivered, SUM(status IN $DR) returned, ROUND(SUM(total)) value
      FROM orders WHERE created_at>=$since GROUP BY 1 ORDER BY orders DESC LIMIT 25");
        $brand = Db::all("SELECT COALESCE(NULLIF(p.brand,''),'(unknown)') name, COUNT(*) units, ROUND(SUM(i.price*i.qty)) revenue, SUM(o.status='delivered') delivered, SUM(o.status IN $DR) returned
      FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.created_at>=$since AND o.cancelled_at IS NULL GROUP BY 1 ORDER BY units DESC LIMIT 20");
        $ptype = Db::all("SELECT COALESCE(NULLIF(p.ptype,''),'(unknown)') name, COUNT(*) units, ROUND(SUM(i.price*i.qty)) revenue, SUM(o.status='delivered') delivered, SUM(o.status IN $DR) returned
      FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.created_at>=$since AND o.cancelled_at IS NULL GROUP BY 1 ORDER BY units DESC LIMIT 20");
        $labels = Db::all("SELECT COALESCE(c.label,'New') label, COUNT(*) orders, SUM(o.status='delivered') delivered, SUM(o.status IN $DR) returned
      FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE o.created_at>=$since GROUP BY 1");
        $hours = Db::all("SELECT HOUR(created_at + INTERVAL 5 HOUR) hour, COUNT(*) orders FROM orders WHERE created_at>=$since GROUP BY hour ORDER BY hour");
        $kpi = Db::get("SELECT COUNT(*) orders, ROUND(AVG(total)) aov, ROUND(SUM(total)) value, SUM(status='delivered') delivered, SUM(status IN $DR) returned,
      SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled, COUNT(DISTINCT phone) customers FROM orders WHERE created_at>=$since");
        $repeat = (int) Db::val("SELECT COUNT(*) n FROM (SELECT phone FROM orders WHERE created_at>=$since AND phone<>'' GROUP BY phone HAVING COUNT(*)>1) t");
        $aging = Db::all("SELECT CASE WHEN TIMESTAMPDIFF(DAY,created_at,UTC_TIMESTAMP())<30 THEN '0-30 days' WHEN TIMESTAMPDIFF(DAY,created_at,UTC_TIMESTAMP())<60 THEN '30-60 days'
      WHEN TIMESTAMPDIFF(DAY,created_at,UTC_TIMESTAMP())<90 THEN '60-90 days' ELSE '90+ days' END bucket, COUNT(*) items, ROUND(SUM(price)) value, ROUND(SUM(COALESCE(cost,0))) cost FROM products WHERE qty>0 GROUP BY 1 ORDER BY 1");
        return compact('days', 'daily', 'status', 'city', 'brand', 'ptype', 'labels', 'hours', 'kpi', 'repeat', 'aging');
    }
}
