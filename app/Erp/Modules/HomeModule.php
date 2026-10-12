<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Erp;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Home: the owner's command centre (whole business on one page) and every staff member's "My day".
 * Port of legacy/server/modules/home.js (no tables of its own).
 */
class HomeModule extends Module
{
    public string $name = 'home';

    public function routes(Router $r): void
    {
        $r->get('/api/home', 'dashboard', 'dashboard');
        $r->post('/api/home/target', 'settings', 'target');
        // "My day": what this person did today (from the activity log), for everyone
        $r->get('/api/home/me', 'dashboard', 'me');
    }

    private function safe(callable $fn, $def = null)
    {
        try {
            return $fn();
        } catch (\Throwable $e) {
            Log::error('home '.$e->getMessage());
            return $def;
        }
    }

    private static function pkDay(string $col): string
    {
        return "DATE($col + INTERVAL 5 HOUR)";
    }

    private function sales(string $from, string $to): array
    {
        return Db::get('SELECT COUNT(*) orders, COALESCE(SUM(total),0) value, COALESCE(SUM(items),0) pairs FROM orders WHERE '.self::pkDay('created_at')." BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN ('cancelled','cs_cancelled')", $from, $to);
    }

    private static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', strtotime($d.' 00:00:00 UTC') + $n * 86400);
    }

    /** JS unary plus (NaN -> 0) */
    private static function n($v): int|float
    {
        if (is_int($v) || is_float($v)) {
            return is_nan((float) $v) ? 0 : $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_string($v) && is_numeric(trim($v))) {
            return 0 + trim($v);
        }
        return 0;
    }

    public function dashboard(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $today = $this->pkToday();
        $month = substr($today, 0, 7);
        $ms = $month.'-01';
        $yday = self::addDays($today, -1);
        $lastMs = substr(self::addDays($ms, -1), 0, 7).'-01';
        $lastSame = self::addDays($lastMs, (int) substr($today, 8, 2) - 1);
        $out = ['today' => $today, 'name' => $u['name'], 'sections' => []];
        // the owner sets the goal; there is no made-up default (null = not set yet)
        $out['target'] = self::n($this->setting('home_profit_target')) ?: null;
        if ($this->can($u, 'orders') || $this->can($u, 'reports') || $this->can($u, 'finance')) {
            $out['sales'] = ['today' => $this->sales($today, $today), 'yesterday' => $this->sales($yday, $yday), 'mtd' => $this->sales($ms, $today), 'lastMtd' => $this->sales($lastMs, $lastSame)];
            $pk = self::pkDay('created_at');
            $out['daily'] = Db::all("SELECT $pk day, COUNT(*) orders, ROUND(SUM(total)) value FROM orders WHERE $pk >= ? AND cancelled_at IS NULL AND status NOT IN ('cancelled','cs_cancelled') GROUP BY day ORDER BY day", self::addDays($today, -29));
            foreach ($out['daily'] as &$d) {
                $d['value'] = $d['value'] === null ? null : Logic::jsRound($d['value']);
            }
            unset($d);
            $dr = Db::get("SELECT SUM(status='delivered') del, SUM(status IN ('returned','return_received','returning')) ret FROM orders WHERE dispatched_at>=(UTC_TIMESTAMP() - INTERVAL 30 DAY)");
            $del = $dr['del'] ?? 0;
            $ret = $dr['ret'] ?? 0;
            $out['deliveryRate'] = ($del + $ret) ? Logic::jsRound(100 * $del / ($del + $ret)) : null;
            $out['money'] = $this->money($ms, $today);
            $out['pipeline'] = Db::get("SELECT SUM(status IN ('new','hold')) confirm, SUM(status IN ('confirmed','picked','packed')) warehouse, SUM(status IN ('dispatched','in_transit','out_for_delivery')) courier, SUM(status='attempted') attempted, SUM(status IN ('returning','returned')) coming_back FROM orders WHERE created_at>=(UTC_TIMESTAMP() - INTERVAL 60 DAY)");
        }
        $S = fn (string $n) => $this->svc($n);
        if ($this->can($u, 'accounts') && $S('accounts')) {
            $out['accounts'] = $this->safe(fn () => $S('accounts')->summary());
            if ($out['accounts']) {
                $dayN = (int) substr($today, 8, 2);
                $dim = (int) gmdate('t', gmmktime(0, 0, 0, (int) substr($month, 5, 2), 1, (int) substr($month, 0, 4)));
                $out['accounts']['projected'] = Logic::jsRound($out['accounts']['profitMTD'] / max(1, $dayN) * $dim);
                // is there anything posted in the books this month? (otherwise "on track" would be a meaningless 0)
                $out['accounts']['postedMTD'] = (int) Db::val('SELECT COUNT(*) FROM acc_journals WHERE date>=?', $ms);
                $out['accounts']['started'] = (string) $this->setting('accounts_start', '') !== ''; // books need a start date + opening balances
            }
        }
        if ($this->can($u, 'marketing') && $S('marketing')) {
            $out['marketing'] = $this->safe(fn () => $S('marketing')->summary());
        }
        if (($this->can($u, 'hr') || $this->can($u, 'team')) && $S('hr')) {
            $out['hr'] = $this->safe(fn () => $S('hr')->summary());
        }
        if ($this->can($u, 'team') && $S('ops')) {
            $out['ops'] = $this->safe(fn () => $S('ops')->summary());
        }
        if ($this->can($u, 'tickets') && $S('tickets')) {
            $out['tickets'] = $this->safe(fn () => $S('tickets')->summary());
        }
        if (($this->can($u, 'wms') || $this->can($u, 'warehouse')) && $S('wms')) {
            $out['wms'] = $this->safe(fn () => $S('wms')->summary());
        }
        if (($this->can($u, 'listing') || $this->can($u, 'wms') || $this->can($u, 'team')) && $S('stockline')) {
            $out['stockline'] = $this->safe(fn () => $S('stockline')->summary());
        }
        if ($this->can($u, 'couriers') && $S('couriers')) {
            $out['couriers'] = $this->safe(fn () => $S('couriers')->summary());
        }
        if ($this->can($u, 'inbox') && $S('inbox')) {
            $out['inbox'] = $this->safe(fn () => $S('inbox')->summary());
        }
        if ($this->can($u, 'expenses_approve') && $S('expenses')) {
            $out['expenses'] = $this->safe(fn () => $S('expenses')->summary());
        }
        if ($S('purchasing') && array_filter(['listing', 'wms', 'finance', 'accounts_post', 'pricing_apply'], fn ($pp) => $this->can($u, $pp))) {
            $out['purchasing'] = $this->safe(function () use ($S, $u) {
                $x = $S('purchasing')->summary();
                if (! ($this->can($u, 'finance') || $this->can($u, 'accounts_post') || $this->can($u, 'pricing_apply'))) {
                    $x['payablesDue'] = null;
                    $x['overdue'] = null;
                    $x['payablesTotal'] = null;
                }
                return $x;
            });
        }
        // store size for the overview cards: Shopify products (active, not deleted), variants in stock, customers
        if ($this->can($u, 'orders') || $this->can($u, 'inventory') || $this->can($u, 'reports')) {
            $out['catalog'] = $this->safe(fn () => [
                'products' => (int) Db::val("SELECT COUNT(*) FROM shopify_products WHERE status='ACTIVE' AND deleted_at IS NULL"),
                'inStock' => (int) Db::val('SELECT COUNT(*) FROM products WHERE qty>0'),
                'customers' => (int) Db::val('SELECT COUNT(*) FROM shopify_customers'),
                'buyers' => (int) Db::val('SELECT COUNT(*) FROM customers'),
            ]);
        }
        if ($this->can($u, 'finance')) {
            $out['cod'] = Db::get("SELECT COALESCE(SUM(COALESCE(cod,total)),0) v, COUNT(*) n FROM orders WHERE status='delivered' AND settled=0");
        }
        $out['alerts'] = $this->safe(fn () => Erp::alerts($u), []);
        return $out;
    }

    /**
     * Money of the month (Pakistan calendar month, up to today): every order counted once per figure.
     *  placed      orders created this month, not cancelled (gross order value)
     *  delivered   orders delivered this month = sales (cash-on-delivery business: revenue when delivered)
     *  online      money received in Shopify this month (successful sale/capture transactions)
     *  refunds     money refunded this month (Shopify refunds)
     *  courierOwes delivered cash-on-delivery parcels not yet marked as paid out by the courier (all months;
     *              payouts come from the PostEx API or are marked in Finance → COD)
     *  inTransit   cash-on-delivery parcels still out for delivery (to be collected)
     *  unpaid      what customers still owe on online-payment orders (Shopify outstanding), not cancelled
     */
    private function money(string $from, string $to): array
    {
        $pk = fn ($col) => "DATE($col + INTERVAL 5 HOUR)";
        $cod = "(gateway LIKE '%Cash on Delivery%' OR gateway LIKE '%COD%')";
        $placed = Db::get("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders WHERE {$pk('created_at')} BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN ('cancelled','cs_cancelled')", $from, $to);
        $delivered = Db::get("SELECT COUNT(*) n, COALESCE(SUM(total),0) v, COALESCE(SUM(CASE WHEN $cod THEN total ELSE 0 END),0) cod FROM orders WHERE status='delivered' AND {$pk('delivered_at')} BETWEEN ? AND ?", $from, $to);
        $online = Db::get("SELECT COUNT(DISTINCT order_id) n, COALESCE(SUM(amount),0) v FROM order_transactions WHERE kind IN ('SALE','CAPTURE') AND status='SUCCESS' AND {$pk('processed_at')} BETWEEN ? AND ?", $from, $to);
        $refunds = Db::get("SELECT COUNT(DISTINCT order_id) n, COALESCE(SUM(amount),0) v FROM order_refunds WHERE amount>0 AND {$pk('created_at')} BETWEEN ? AND ?", $from, $to);
        $owes = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)),0) v FROM orders WHERE status='delivered' AND settled=0 AND $cod");
        $settledAny = (int) Db::val('SELECT COUNT(*) FROM orders WHERE settled=1') > 0;
        $transit = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)),0) v FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted') AND $cod AND cancelled_at IS NULL");
        $unpaid = Db::get("SELECT COUNT(*) n, COALESCE(SUM(outstanding),0) v FROM orders WHERE outstanding>0 AND cancelled_at IS NULL AND NOT $cod AND status NOT IN ('cancelled','cs_cancelled')");
        $days = (int) substr($to, 8, 2);
        $dim = (int) gmdate('t', gmmktime(0, 0, 0, (int) substr($to, 5, 2), 1, (int) substr($to, 0, 4)));
        $r = fn ($x) => ['n' => (int) $x['n'], 'v' => round((float) $x['v'], 2)];
        return [
            'from' => $from, 'to' => $to, 'currency' => Db::val('SELECT currency FROM orders WHERE currency IS NOT NULL LIMIT 1') ?: 'PKR',
            'placed' => $r($placed), 'delivered' => $r($delivered) + ['cod' => round((float) $delivered['cod'], 2)], 'online' => $r($online), 'refunds' => $r($refunds),
            'courierOwes' => $r($owes) + ['tracked' => $settledAny || app(\App\Erp\Core\PostEx::class)->configured()], 'inTransit' => $r($transit), 'unpaid' => $r($unpaid),
            // month-end estimate at the current pace (only once a few days have passed)
            'pace' => $days >= 3 ? ['placed' => Logic::jsRound($placed['v'] / $days * $dim), 'delivered' => Logic::jsRound($delivered['v'] / $days * $dim), 'days' => $days, 'daysInMonth' => $dim] : null,
        ];
    }

    public function target(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = self::n($b['target'] ?? null);
        $this->need($t > 0, 'Enter a monthly profit target');
        $this->setSetting('home_profit_target', Logic::jsRound($t));
        $this->log($u['id'], 'home.target', 'settings', ['target' => $t]);
        return ['ok' => true];
    }

    public function me(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $today = $this->pkToday();
        $acts = Db::all("SELECT action, COUNT(*) n FROM events WHERE user_id=? AND DATE(at + INTERVAL 5 HOUR)=? AND action NOT IN ('login','setup') GROUP BY action ORDER BY n DESC", $u['id'], $today);
        $calls = Db::val('SELECT COUNT(*) n FROM cs_calls WHERE user_id=? AND DATE(at + INTERVAL 5 HOUR)=?', $u['id'], $today);
        $picks = Db::val('SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE picked_by=? AND DATE(picked_at + INTERVAL 5 HOUR)=?', $u['id'], $today);
        $listed = Db::val('SELECT COUNT(*) n FROM listings WHERE user_id=? AND DATE(at + INTERVAL 5 HOUR)=?', $u['id'], $today);
        $labels = Erp::activityLabels() ?: [];
        $work = [];
        if ($calls) {
            $work[] = ['label' => 'Customer calls', 'n' => $calls];
        }
        if ($picks) {
            $work[] = ['label' => 'Pairs picked', 'n' => $picks];
        }
        if ($listed) {
            $work[] = ['label' => 'Pairs listed', 'n' => $listed];
        }
        foreach ($acts as $a) {
            if (! preg_match('/^(cs:|pick|listing\.save|hr\.check)/', (string) $a['action'])) {
                $work[] = ['label' => ($labels[$a['action']] ?? null) ?: $a['action'], 'n' => $a['n']];
            }
        }
        return ['today' => $today, 'work' => $work];
    }
}
