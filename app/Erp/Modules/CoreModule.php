<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Core\Finance;
use App\Erp\Core\Logic;
use App\Erp\Core\Pricing;
use App\Erp\Db;
use App\Erp\Defer;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Models\User;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\ShopifyWriter;
use App\Services\Shopify\SyncRunner;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Core ERP API (port of the original server.js): login & staff, dashboard, orders, confirmation calls,
 * customers, pick/pack/returns, inventory & racks, lots/listing/pricing, tracking, finance, settings, sync, files.
 */
class CoreModule extends Module
{
    public string $name = 'core';

    public const DEFAULT_WA = 'Assalam o Alaikum {name}! SundayBazar se order {order} confirm karna hai: {items} · Total Rs {total}. Kya hum ye order bhej dein? Reply YES ya NO.';

    private const STAGES = ['new', 'hold', 'confirmed', 'cs_cancelled', 'picked', 'packed'];

    private const PICKABLE = "o.status IN ('confirmed','picked') AND o.cancelled_at IS NULL";

    private const ORDER_COLS = "o.id,o.name,o.created_at,o.cust_name,o.phone,o.city,o.total,o.items,o.status,o.stage,o.tracking,o.px_status,o.cs_attempts,o.tags,o.missing,c.label clabel,c.delivered cdel,c.returned cret,c.orders corders,(SELECT GROUP_CONCAT(CONCAT(title, COALESCE(CONCAT(' (', sku, ')'),'')) SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text";

    public const SETTING_KEYS = ['store_name', 'confirm_mode', 'retry_hours', 'max_attempts', 'auto_cancel_unreachable', 'wa_template',
        'stuck_days', 'postex_days', 'postex_check_payments', 'shopify_location', 'courier_fee', 'return_fee', 'packaging_cost', 'cost_pct', 'expense_categories'];

    public static function defaults(): array
    {
        return ['store_name' => 'SundayBazar', 'confirm_mode' => 'risky', 'retry_hours' => 3, 'max_attempts' => 4, 'auto_cancel_unreachable' => false,
            'wa_template' => self::DEFAULT_WA, 'stuck_days' => 6, 'postex_days' => 45, 'postex_check_payments' => true, 'shopify_location' => '', 'courier_fee' => 250, 'return_fee' => 150,
            'packaging_cost' => 40, 'cost_pct' => 35, 'expense_categories' => ['Salaries', 'Rent', 'Ads (Meta)', 'Lot purchase', 'Packaging', 'Electricity & internet', 'Transport', 'Misc']];
    }

    public function routes(Router $r): void
    {
        // auth
        $r->get('/api/state', null, 'state');
        // dashboard
        $r->get('/api/dashboard', 'dashboard', 'dashboard');
        // orders
        $r->get('/api/orders', 'orders', 'ordersList');
        $r->get('/api/orders/:id', 'orders', 'orderShow');
        $r->post('/api/orders/:id/stage', 'orders_edit', 'orderStage');
        $r->post('/api/orders/:id/note', 'orders', 'orderNote');
        // CS
        $r->get('/api/cs/queue', 'cs', 'csQueue');
        $r->post('/api/cs/:id/call', 'cs', 'csCall');
        // customers
        $r->get('/api/customers', 'customers', 'customersList');
        $r->get('/api/customers/:phone', 'customers', 'customerShow');
        $r->post('/api/customers/:phone/flag', 'customers_edit', 'customerFlag');
        // warehouse
        $r->get('/api/pick', 'warehouse', 'pickList');
        $r->post('/api/pick/scan', 'warehouse', 'pickScan');
        $r->post('/api/pick/item/:id', 'warehouse', 'pickItemRoute');
        $r->post('/api/orders/:id/missing', 'warehouse', 'orderMissing');
        $r->post('/api/pack/scan', 'warehouse', 'packScan');
        $r->get('/api/returns', 'warehouse', 'returnsList');
        $r->post('/api/returns/receive', 'warehouse', 'returnReceive');
        // inventory
        $r->get('/api/inventory', 'inventory', 'inventory');
        $r->get('/api/racks', 'inventory', 'racks');
        $r->post('/api/locations', 'inventory', 'setLocation');
        $r->get('/api/lookup', 'dashboard', 'lookup');
        // lots, listing & pricing
        $r->get('/api/lots', 'listing', 'lots');
        $r->post('/api/lots/:name', 'listing', 'lotUpdate');
        $r->get('/api/list/meta', 'listing', 'listMeta');
        $r->post('/api/list/quote', 'listing', 'listQuote');
        $r->post('/api/list/save', 'listing', 'listSave');
        $r->get('/api/list/recent', 'listing', 'listRecent');
        $r->post('/api/list/delete/:sku', 'listing', 'listDelete');
        $r->post('/api/list/export', 'listing', 'listExport');
        $r->get('/api/list/lots', 'listing', 'listLots');
        $r->post('/api/list/lot-plan', 'listing', 'listLotPlan');
        $r->post('/api/list/lots', 'listing', 'listLotSave');
        $r->post('/api/list/lots/:name/delete', 'listing', 'listLotDelete');
        $r->get('/api/list/econ', 'listing', 'listEconGet');
        $r->post('/api/list/econ', 'settings', 'listEconSave');
        $r->get('/api/pricing/rules', 'listing', 'pricingRules');
        $r->post('/api/pricing/rules', 'listing', 'pricingRulesSave');
        $r->get('/api/pricing/suggestions', 'listing', 'pricingSuggestions');
        $r->post('/api/pricing/apply', 'pricing_apply', 'pricingApply');
        $r->get('/api/pricing/history', 'listing', 'pricingHistory');
        // tracking
        $r->get('/api/tracking', 'tracking', 'tracking');
        $r->post('/api/tracking/:id/refresh', 'tracking', 'trackingRefresh');
        // finance
        $r->get('/api/finance/summary', 'finance', 'financeSummary');
        $r->get('/api/finance/cod', 'finance', 'financeCod');
        $r->post('/api/finance/settle', 'finance', 'financeSettle');
        $r->get('/api/expense-categories', 'finance', 'expenseCategories');
        $r->get('/api/expenses', 'finance', 'expensesList');
        $r->post('/api/expenses', 'finance', 'expenseSave');
        $r->delete('/api/expenses/:id', 'finance', 'expenseDelete');
        $r->get('/api/finance/export', 'reports_export', 'financeExport');
        // reports
        $r->get('/api/reports', 'reports', 'reports');
        // settings & sync
        $r->get('/api/settings', 'settings', 'settingsGet');
        $r->post('/api/settings', 'settings', 'settingsSave');
        $r->post('/api/settings/test-shopify', 'shopify_manage', 'testShopify');
        $r->post('/api/settings/test-postex', 'settings', 'testPostex');
        $r->post('/api/sync', 'sync_run', 'syncStart');
        $r->get('/api/sync', 'dashboard', 'syncGet');
        $r->get('/api/sync/log', 'sync_view', 'syncLogList');
        $r->post('/api/demo/load', 'settings', 'demoLoad');
        $r->post('/api/demo/clear', 'settings', 'demoClear');
        // files
        $r->post('/api/files', 'dashboard', 'fileUpload');
        $r->get('/api/files/:id', 'dashboard', 'fileGet');
    }

    /* =================================================================== auth */

    public function state(?array $u): array
    {
        $roles = Access::roles();
        return [
            'setup' => ! Db::get('SELECT id FROM users LIMIT 1'),
            'setupKey' => (bool) config('erp.setup_key'),
            'registration' => config('erp.registration', 'approval'),
            'isSuper' => $u ? Access::isSuperRole($u['role']) : false,
            'user' => $u,
            'perms' => Access::perms(),
            'roles' => (object) array_map(fn ($v) => $v['label'], $roles),
            'roleInfo' => $u ? (object) array_map(fn ($v) => ['desc' => $v['desc'] ?? '', 'perms' => $v['perms']], $roles) : null,
            'store' => $this->setting('store_name', 'SundayBazar'),
            'demo' => (bool) $this->setting('demo'),
            'shopify' => $this->shopify()->configured(),
            'postex' => $this->postex()->configured(),
            'statuses' => Logic::STATUS,
        ];
    }

    /* ============================================================== dashboard */

    public function dashboard(?array $u): array
    {
        $d = [];
        $d['today'] = Db::get('SELECT COUNT(*) orders, COALESCE(SUM(total),0) value FROM orders WHERE DATE(created_at + INTERVAL 5 HOUR)=? AND cancelled_at IS NULL', $this->today());
        $d['week'] = Db::get('SELECT COUNT(*) orders, COALESCE(SUM(total),0) value FROM orders WHERE created_at>=(UTC_TIMESTAMP() - INTERVAL 7 DAY) AND cancelled_at IS NULL');
        $pipe = [];
        foreach (Db::all('SELECT status, COUNT(*) n FROM orders WHERE created_at>=(UTC_TIMESTAMP() - INTERVAL 60 DAY) GROUP BY status') as $r) {
            $pipe[$r['status']] = $r['n'];
        }
        $d['pipeline'] = (object) $pipe;
        $dr = Db::get("SELECT COALESCE(SUM(status='delivered'),0) del, COALESCE(SUM(status IN ('returned','return_received','returning')),0) ret FROM orders WHERE dispatched_at>=(UTC_TIMESTAMP() - INTERVAL 30 DAY)");
        $d['deliveryRate'] = $dr['del'] + $dr['ret'] ? Logic::jsRound(100 * $dr['del'] / ($dr['del'] + $dr['ret'])) : null;
        $d['toConfirm'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE stage IN ('new','hold') AND tracking IS NULL AND cancelled_at IS NULL AND status IN ('new','hold')");
        $d['toPick'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked')");
        $d['stuck'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < (UTC_TIMESTAMP() - INTERVAL 6 DAY)");
        $d['attempted'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status='attempted'");
        $d['returnsPending'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('returned','returning')");
        if ($this->can($u, 'finance')) {
            $d['codPending'] = Db::get("SELECT COALESCE(SUM(COALESCE(cod,total)),0) v, COUNT(*) n FROM orders WHERE status='delivered' AND settled=0");
        }
        $d['stock'] = Db::get('SELECT COUNT(*) items, COALESCE(SUM(price*qty),0) value, SUM(CASE WHEN created_at<(UTC_TIMESTAMP() - INTERVAL 60 DAY) THEN 1 ELSE 0 END) aged FROM products WHERE qty>0');
        $d['daily'] = Db::all('SELECT DATE_FORMAT(created_at + INTERVAL 5 HOUR, \'%Y-%m-%d\') day, COUNT(*) orders, ROUND(SUM(total)) value FROM orders WHERE created_at>=(UTC_TIMESTAMP() - INTERVAL 14 DAY) AND cancelled_at IS NULL GROUP BY day ORDER BY day');
        $d['sync'] = SyncRunner::state();
        return $d;
    }

    /* ================================================================= orders */

    private function orderFilter(array $qs): array
    {
        $w = [];
        $a = [];
        if (! empty($qs['status'])) {
            $s = explode(',', (string) $qs['status']);
            $w[] = 'o.status IN ('.Db::marks($s).')';
            array_push($a, ...$s);
        }
        if (! empty($qs['q'])) {
            $t = '%'.trim($qs['q']).'%';
            $ph = Logic::normPhone($qs['q']);
            $w[] = '(o.name LIKE ? OR o.cust_name LIKE ? OR o.tracking LIKE ? OR o.city LIKE ?'.(strlen($ph) >= 7 ? ' OR o.phone LIKE ?' : '').' OR o.id IN (SELECT order_id FROM order_items WHERE sku LIKE ?))';
            array_push($a, $t, $t, $t, $t);
            if (strlen($ph) >= 7) {
                $a[] = '%'.$ph.'%';
            }
            $a[] = $t;
        }
        if (! empty($qs['from'])) {
            $w[] = 'DATE(o.created_at + INTERVAL 5 HOUR)>=?';
            $a[] = $qs['from'];
        }
        if (! empty($qs['to'])) {
            $w[] = 'DATE(o.created_at + INTERVAL 5 HOUR)<=?';
            $a[] = $qs['to'];
        }
        if (! empty($qs['city'])) {
            $w[] = 'o.city LIKE ?';
            $a[] = $qs['city'].'%';
        }
        if (! empty($qs['label'])) {
            $w[] = 'c.label=?';
            $a[] = $qs['label'];
        }
        return ['where' => $w ? 'WHERE '.implode(' AND ', $w) : '', 'args' => $a];
    }

    public function ordersList(?array $u, array $b, array $p, array $qs): array
    {
        $f = $this->orderFilter($qs);
        $pg = $this->page($qs);
        $rows = Db::all('SELECT '.self::ORDER_COLS." FROM orders o LEFT JOIN customers c ON c.phone=o.phone {$f['where']} ORDER BY o.created_at DESC LIMIT ? OFFSET ?", ...array_merge($f['args'], [$pg['limit'], $pg['offset']]));
        $total = (int) Db::val("SELECT COUNT(*) n FROM orders o LEFT JOIN customers c ON c.phone=o.phone {$f['where']}", ...$f['args']);
        foreach ($rows as &$r) {
            $r['phone'] = $this->maskPhone($u, $r['phone']);
        }
        return ['rows' => $rows, 'total' => $total, 'page' => $pg['page'], 'pages' => (int) ceil($total / $pg['limit'])];
    }

    public function orderShow(?array $u, array $b, array $p): array
    {
        $o = Db::get('SELECT * FROM orders WHERE id=? OR name=?', $p['id'], $p['id']);
        $this->need($o, 'Order not found', 404);
        $items = Db::all('SELECT i.*, pr.image, pr.size, pr.cond, COALESCE(l.location, pr.rack) location FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id LEFT JOIN locations l ON l.sku=i.sku WHERE i.order_id=? ORDER BY i.id', $o['id']);
        $calls = Db::all('SELECT c.*, us.name user FROM cs_calls c LEFT JOIN users us ON us.id=c.user_id WHERE order_id=? ORDER BY c.id DESC', $o['id']);
        $events = Db::all('SELECT e.*, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE entity=? ORDER BY e.id DESC LIMIT 50', 'order:'.$o['id']);
        $cust = Db::get('SELECT * FROM customers WHERE phone=?', $o['phone']);
        $others = Db::all('SELECT id,name,created_at,total,status FROM orders WHERE phone=? AND id<>? ORDER BY created_at DESC LIMIT 20', $o['phone'], $o['id']);
        $fulfillments = Db::all('SELECT id,status,display_status,tracking_number,tracking_company,tracking_url,delivered_at,created_at FROM order_fulfillments WHERE order_id=? ORDER BY created_at', $o['id']);
        $transactions = Db::all('SELECT kind,status,gateway,amount,currency,processed_at FROM order_transactions WHERE order_id=? ORDER BY processed_at', $o['id']);
        $refunds = Db::all('SELECT amount,note,created_at FROM order_refunds WHERE order_id=? ORDER BY created_at', $o['id']);
        $writes = Db::all('SELECT w.kind,w.status,w.error,w.at,us.name user FROM shopify_writes w LEFT JOIN users us ON us.id=w.user_id WHERE w.target_id=? ORDER BY w.id DESC LIMIT 20', $o['id']);
        $showPhone = $this->can($u, 'customers') || $this->can($u, 'cs') || $this->can($u, 'tracking');
        if (! $showPhone) {
            $o['phone'] = $this->maskPhone($u, $o['phone']);
            $o['address'] = '';
            $o['email'] = null;
        }
        $o['px_history'] = $this->J($o['px_history'], []);
        return ['order' => $o, 'items' => $items, 'calls' => $calls, 'events' => $events, 'customer' => $cust, 'others' => $others, 'fulfillments' => $fulfillments, 'transactions' => $transactions, 'refunds' => $refunds, 'shopifyWrites' => $writes,
            'wa' => $showPhone ? Logic::waNumber($o['phone']) : '', 'shop' => $this->shopify()->cfg()['shop']];
    }

    public function orderStage(?array $u, array $b, array $p): array
    {
        $stage = $b['stage'] ?? null;
        $this->need(in_array($stage, self::STAGES, true), 'Unknown stage');
        $o = Db::get('SELECT * FROM orders WHERE id=?', $p['id']);
        $this->need($o, 'Not found', 404);
        Db::run("UPDATE orders SET stage=?, picked_at=CASE WHEN ?='picked' THEN UTC_TIMESTAMP() ELSE picked_at END, packed_at=CASE WHEN ?='packed' THEN UTC_TIMESTAMP() ELSE packed_at END WHERE id=?", $stage, $stage, $stage, $o['id']);
        Logic::refreshOrder($o['id']);
        $this->log($u['id'], 'stage:'.$stage, 'order:'.$o['id'], $b['note'] ?? '');
        return ['ok' => true];
    }

    public function orderNote(?array $u, array $b, array $p): array
    {
        $this->need(! empty($b['note']), 'Write a note');
        $this->log($u['id'], 'note', 'order:'.$p['id'], mb_substr((string) $b['note'], 0, 1000));
        return ['ok' => true];
    }

    /* ===================================================================== CS */

    public function csQueue(?array $u, array $b, array $p, array $qs): array
    {
        $view = $qs['view'] ?? 'todo';
        $where = "o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.cancelled_at IS NULL";
        if ($view === 'todo') {
            $where .= ' AND (o.cs_next IS NULL OR o.cs_next<=UTC_TIMESTAMP())';
        }
        if ($view === 'later') {
            $where .= ' AND o.cs_next>UTC_TIMESTAMP()';
        }
        if ($view === 'attempted') {
            $where = "o.status='attempted'";
        }
        $rows = Db::all('SELECT '.self::ORDER_COLS.", o.cs_next, o.cs_note, o.address, c.cancelled ccan FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE {$where}
     ORDER BY CASE COALESCE(c.label,'New') WHEN 'Blacklisted' THEN 0 WHEN 'Risky' THEN 1 WHEN 'New' THEN 2 ELSE 3 END, o.created_at LIMIT 300");
        foreach ($rows as &$r) {
            $r['wa'] = Logic::waNumber($r['phone']);
        }
        $counts = Db::get("SELECT SUM(cs_next IS NULL OR cs_next<=UTC_TIMESTAMP()) todo, SUM(cs_next>UTC_TIMESTAMP()) later FROM orders WHERE stage IN ('new','hold') AND status IN ('new','hold') AND cancelled_at IS NULL");
        $counts['attempted'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status='attempted'");
        return ['rows' => $rows, 'counts' => $counts, 'mode' => $this->setting('confirm_mode', 'risky'), 'template' => $this->setting('wa_template', self::DEFAULT_WA)];
    }

    public function csCall(?array $u, array $b, array $p): array
    {
        $o = Db::get('SELECT * FROM orders WHERE id=?', $p['id']);
        $this->need($o, 'Not found', 404);
        $OUT = ['confirmed' => 'confirmed', 'cancelled' => 'cs_cancelled', 'no_answer' => 'hold', 'callback' => 'hold', 'wrong_number' => 'hold', 'delivery_retry' => null, 'delivery_cancel' => null];
        $outcome = (string) ($b['outcome'] ?? '');
        $this->need(array_key_exists($outcome, $OUT), 'Unknown outcome');
        $note = (string) ($b['note'] ?? '');
        Db::run('INSERT INTO cs_calls(order_id,user_id,outcome,note,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $o['id'], $u['id'], $outcome, $note);
        $next = null;
        if ($outcome === 'no_answer') {
            $next = gmdate('Y-m-d H:i:s', time() + (int) ((float) $this->setting('retry_hours', 3) * 3600));
        }
        if ($outcome === 'callback' && ! empty($b['next'])) {
            $next = substr(str_replace('T', ' ', (string) $b['next']), 0, 19);
        }
        $stage = $OUT[$outcome];
        if ($stage) {
            Db::run('UPDATE orders SET stage=?, cs_attempts=cs_attempts+1, cs_note=?, cs_by=?, cs_at=UTC_TIMESTAMP(), cs_next=? WHERE id=?', $stage, $note !== '' ? $note : null, $u['id'], $next, $o['id']);
        } else {
            Db::run('UPDATE orders SET cs_note=?, cs_by=?, cs_at=UTC_TIMESTAMP() WHERE id=?', ($outcome === 'delivery_retry' ? 'Customer wants re-attempt: ' : 'Customer refuses: ').$note, $u['id'], $o['id']);
        }
        // auto-cancel after N unanswered calls
        $maxTries = (int) $this->setting('max_attempts', 4);
        if ($outcome === 'no_answer' && $o['cs_attempts'] + 1 >= $maxTries && $this->setting('auto_cancel_unreachable', false)) {
            Db::run("UPDATE orders SET stage='cs_cancelled', cs_note=CONCAT('No answer after ', ?, ' calls') WHERE id=?", $maxTries, $o['id']);
        }
        Logic::refreshOrder($o['id']);
        $this->log($u['id'], 'cs:'.$outcome, 'order:'.$o['id'], $note);
        if ($this->shopify()->configured() && ($outcome === 'confirmed' || $outcome === 'cancelled') && ! str_starts_with($o['id'], 'demo')) {
            $oid = $o['id'];
            $uid = $u['id'];
            $tag = $outcome === 'confirmed' ? 'ERP-Confirmed' : 'ERP-Cancel';
            Defer::run(function () use ($oid, $uid, $tag) {
                try {
                    app(ShopifyWriter::class)->tagOrder($oid, [$tag], $uid);
                } catch (ShopifyException $e) {
                    if ($e->kind !== 'config') {
                        \App\Erp\Activity::log(null, 'shopify.tag.error', 'order:'.$oid, $e->getMessage());
                    }
                }
            }, 'shopify-tag');
        }
        return ['ok' => true];
    }

    /* ============================================================== customers */

    public function customersList(?array $u, array $b, array $p, array $qs): array
    {
        $w = [];
        $a = [];
        if (! empty($qs['q'])) {
            $ph = Logic::normPhone($qs['q']);
            $w[] = '(c.name LIKE ? OR c.city LIKE ?'.(strlen($ph) >= 5 ? ' OR c.phone LIKE ?' : '').')';
            array_push($a, '%'.$qs['q'].'%', '%'.$qs['q'].'%');
            if (strlen($ph) >= 5) {
                $a[] = '%'.$ph.'%';
            }
        }
        if (! empty($qs['label'])) {
            $w[] = 'c.label=?';
            $a[] = $qs['label'];
        }
        $where = $w ? 'WHERE '.implode(' AND ', $w) : '';
        $sort = ['spent' => 'c.spent DESC', 'orders' => 'c.orders DESC', 'risky' => 'c.returned DESC', 'recent' => 'c.last_order DESC'][$qs['sort'] ?? ''] ?? 'c.last_order DESC';
        $pg = $this->page($qs);
        $rows = Db::all("SELECT c.*, f.note fnote FROM customers c LEFT JOIN customer_flags f ON f.phone=c.phone {$where} ORDER BY {$sort} LIMIT ? OFFSET ?", ...array_merge($a, [$pg['limit'], $pg['offset']]));
        $total = (int) Db::val("SELECT COUNT(*) n FROM customers c {$where}", ...$a);
        $labels = Db::all('SELECT label, COUNT(*) n FROM customers GROUP BY label');
        return ['rows' => $rows, 'total' => $total, 'page' => $pg['page'], 'pages' => (int) ceil($total / $pg['limit']), 'labels' => $labels];
    }

    public function customerShow(?array $u, array $b, array $p): array
    {
        $ph = Logic::normPhone($p['phone']);
        return ['customer' => Db::get('SELECT * FROM customers WHERE phone=?', $ph), 'flag' => Db::get('SELECT * FROM customer_flags WHERE phone=?', $ph),
            'orders' => Db::all('SELECT id,name,created_at,total,status,city,tracking FROM orders WHERE phone=? ORDER BY created_at DESC', $ph), 'wa' => Logic::waNumber($ph)];
    }

    public function customerFlag(?array $u, array $b, array $p): array
    {
        $ph = Logic::normPhone($p['phone']);
        $this->need($ph, 'No phone');
        Db::run('INSERT INTO customer_flags(phone,blacklist,vip,note,updated_at) VALUES(?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE blacklist=VALUES(blacklist), vip=VALUES(vip), note=VALUES(note), updated_at=VALUES(updated_at)',
            $ph, ! empty($b['blacklist']) ? 1 : 0, ! empty($b['vip']) ? 1 : 0, ($b['note'] ?? '') ?: null);
        Logic::recomputeCustomers();
        $this->log($u['id'], 'customer.flag', 'customer:'.$ph, $b);
        return ['ok' => true];
    }

    /* ============================================================== warehouse */

    public function pickList(): array
    {
        $items = Db::all('SELECT i.id, i.order_id, i.sku, i.title, i.qty, i.picked, o.name, o.created_at, o.status, o.missing, COALESCE(l.location, pr.rack, \'\') location, pr.image, pr.size, pr.qty stock
    FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products pr ON pr.variant_id=i.variant_id LEFT JOIN locations l ON l.sku=i.sku
    WHERE '.self::PICKABLE.' ORDER BY location, i.sku');
        $orders = Db::all('SELECT o.id, o.name, o.created_at, o.status, o.missing, o.items, (SELECT SUM(picked) FROM order_items WHERE order_id=o.id) picked FROM orders o WHERE '.self::PICKABLE.' ORDER BY o.created_at');
        $packQueue = Db::all("SELECT id, name, created_at, items, city FROM orders WHERE status='packed' ORDER BY packed_at");
        return compact('items', 'orders', 'packQueue');
    }

    private function pickItem(int $itemId, array $u, int $val = 1): array
    {
        $it = Db::get('SELECT * FROM order_items WHERE id=?', $itemId);
        $this->need($it, 'Item not found', 404);
        Db::run('UPDATE order_items SET picked=?, picked_by=?, picked_at=UTC_TIMESTAMP() WHERE id=?', $val, $u['id'], $it['id']);
        $left = (int) Db::val('SELECT COUNT(*) n FROM order_items WHERE order_id=? AND picked=0', $it['order_id']);
        $o = Db::get('SELECT stage FROM orders WHERE id=?', $it['order_id']);
        if (! $left && $o['stage'] === 'confirmed') {
            Db::run("UPDATE orders SET stage='picked', picked_at=UTC_TIMESTAMP(), missing=0 WHERE id=?", $it['order_id']);
        }
        if ($left && $o['stage'] === 'picked') {
            Db::run("UPDATE orders SET stage='confirmed' WHERE id=?", $it['order_id']);
        }
        Logic::refreshOrder($it['order_id']);
        $this->log($u['id'], $val ? 'pick' : 'unpick', 'order:'.$it['order_id'], $it['sku']);
        return ['item' => $it, 'left' => $left, 'order' => Db::get('SELECT id,name,status FROM orders WHERE id=?', $it['order_id'])];
    }

    public function pickScan(?array $u, array $b): array
    {
        $code = mb_strtoupper(trim((string) ($b['code'] ?? '')));
        $this->need($code !== '', 'Scan a SKU');
        $it = Db::get('SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? AND i.picked=0 AND '.self::PICKABLE.' ORDER BY o.created_at LIMIT 1', $code);
        if (! $it) {
            $done = Db::get('SELECT o.name FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? ORDER BY o.created_at DESC LIMIT 1', $code);
            throw new HttpError(404, $done ? "{$code} is not waiting to be picked (last order {$done['name']})" : "{$code} is not in any confirmed order");
        }
        return $this->pickItem((int) $it['id'], $u);
    }

    public function pickItemRoute(?array $u, array $b, array $p): array
    {
        return $this->pickItem((int) $p['id'], $u, ($b['picked'] ?? 1) === 0 ? 0 : 1);
    }

    public function orderMissing(?array $u, array $b, array $p): array
    {
        Db::run('UPDATE orders SET missing=? WHERE id=?', ! empty($b['missing']) ? 1 : 0, $p['id']);
        $this->log($u['id'], ! empty($b['missing']) ? 'item.missing' : 'item.found', 'order:'.$p['id'], $b['note'] ?? '');
        return ['ok' => true];
    }

    public function packScan(?array $u, array $b): array
    {
        $code = trim((string) ($b['code'] ?? ''));
        $this->need($code !== '', 'Scan the order number');
        $o = Db::get('SELECT * FROM orders WHERE name=? OR name=? OR tracking=?', $code, mb_strtoupper($code), $code);
        $this->need($o, 'Order '.$code.' not found', 404);
        $this->need(in_array($o['status'], ['picked', 'confirmed'], true), "{$o['name']} is \"".(Logic::STATUS[$o['status']] ?? $o['status']).'", not ready to pack');
        $left = (int) Db::val('SELECT COUNT(*) n FROM order_items WHERE order_id=? AND picked=0', $o['id']);
        $this->need(! $left || ! empty($b['force']), "{$left} item(s) of {$o['name']} are not picked yet");
        Db::run("UPDATE orders SET stage='packed', packed_at=UTC_TIMESTAMP() WHERE id=?", $o['id']);
        Logic::refreshOrder($o['id']);
        $this->log($u['id'], 'pack', 'order:'.$o['id'], '');
        return ['ok' => true, 'order' => ['id' => $o['id'], 'name' => $o['name']]];
    }

    public function returnsList(): array
    {
        return [
            'pending' => Db::all("SELECT id,name,cust_name,city,tracking,status,returned_at,total,items FROM orders WHERE status IN ('returning','returned') ORDER BY returned_at"),
            'recent' => Db::all('SELECT r.*, o.name, us.name user FROM returns r LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN users us ON us.id=r.user_id ORDER BY r.id DESC LIMIT 50'),
        ];
    }

    public function returnReceive(?array $u, array $b): array
    {
        $code = trim((string) ($b['code'] ?? ''));
        $this->need($code !== '', 'Scan tracking number or order number');
        $o = Db::get('SELECT * FROM orders WHERE tracking=? OR name=? OR name=?', $code, $code, mb_strtoupper($code));
        $this->need($o, 'No order with '.$code, 404);
        $this->need(! $o['return_received_at'], "{$o['name']} was already received on ".substr((string) $o['return_received_at'], 0, 10));
        $items = Db::all('SELECT i.*, pr.inventory_item FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE order_id=? ORDER BY i.id', $o['id']);
        $restock = ($b['restock'] ?? null) !== false && ($b['cond'] ?? '') !== 'damaged';
        $loc = ($b['location'] ?? '') ?: null;
        $results = [];
        $writer = app(ShopifyWriter::class);
        foreach ($items as $it) {
            $pushed = false;
            $err = null;
            $qty = (int) ($it['qty'] ?: 1);
            if ($restock && $this->shopify()->configured() && $it['inventory_item'] && ! str_starts_with($o['id'], 'demo')) {
                try {
                    $writer->adjustInventory($it['inventory_item'], $qty, 'restock', $u['id']);
                    $pushed = true;
                } catch (ShopifyException $e) {
                    $err = $e->getMessage();
                }
            }
            if ($restock && ! $loc && ($wms = $this->svc('wms')) && method_exists($wms, 'receiveReturn')) {
                try {
                    $wms->receiveReturn($it['sku'], 'Return '.($o['name'] ?: $o['id']), $u['id']);
                } catch (\Throwable $e) {
                    report($e);
                }
            }
            if ($restock && $loc) {
                Db::run('INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE location=VALUES(location), updated_at=VALUES(updated_at), updated_by=VALUES(updated_by)', $it['sku'], $loc, $u['id']);
                Db::run('INSERT INTO stock_moves(sku,to_loc,reason,user_id,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $it['sku'], $loc, 'return', $u['id']);
            }
            if ($restock && $it['variant_id']) {
                Db::run('UPDATE products SET qty=qty+?, sold_at=NULL WHERE variant_id=? AND qty<=0', $qty, $it['variant_id']);
            }
            Db::run('INSERT INTO returns(order_id,sku,cond,restocked,location,note,user_id,at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP())', $o['id'], $it['sku'], ($b['cond'] ?? '') ?: 'good', $restock ? 1 : 0, $loc, $err ? 'Shopify: '.$err : (($b['note'] ?? '') ?: null), $u['id']);
            $results[] = ['sku' => $it['sku'], 'restocked' => $restock, 'shopify' => $pushed, 'error' => $err];
        }
        Db::run('UPDATE orders SET return_received_at=UTC_TIMESTAMP() WHERE id=?', $o['id']);
        Logic::refreshOrder($o['id']);
        $this->log($u['id'], 'return.received', 'order:'.$o['id'], $results);
        return ['ok' => true, 'order' => ['id' => $o['id'], 'name' => $o['name']], 'results' => $results];
    }

    /* ============================================================== inventory */

    public function inventory(?array $u, array $b, array $p, array $qs): array
    {
        $w = [];
        $a = [];
        if (($qs['instock'] ?? '') !== '0') {
            $w[] = 'p.qty>0';
        }
        if (! empty($qs['q'])) {
            $t = '%'.trim($qs['q']).'%';
            $w[] = '(p.sku LIKE ? OR p.title LIKE ? OR p.brand LIKE ? OR p.tags LIKE ?)';
            array_push($a, $t, $t, $t, $t);
        }
        if (! empty($qs['rack'])) {
            $w[] = 'COALESCE(l.location,p.rack) LIKE ?';
            $a[] = $qs['rack'].'%';
        }
        if (! empty($qs['lot'])) {
            $w[] = 'p.lot=?';
            $a[] = $qs['lot'];
        }
        if (! empty($qs['age'])) {
            $w[] = 'p.created_at < (UTC_TIMESTAMP() - INTERVAL ? DAY)';
            $a[] = (int) $qs['age'];
        }
        if (($qs['noloc'] ?? '') === '1') {
            $w[] = 'l.location IS NULL';
        }
        $where = $w ? 'WHERE '.implode(' AND ', $w) : '';
        $pg = $this->page($qs, 60);
        $rows = Db::all("SELECT p.*, l.location loc, TIMESTAMPDIFF(DAY, p.created_at, UTC_TIMESTAMP()) age FROM products p LEFT JOIN locations l ON l.sku=p.sku {$where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?", ...array_merge($a, [$pg['limit'], $pg['offset']]));
        $total = Db::get("SELECT COUNT(*) n, COALESCE(SUM(p.price*p.qty),0) value, COALESCE(SUM(p.cost*p.qty),0) cost FROM products p LEFT JOIN locations l ON l.sku=p.sku {$where}", ...$a);
        return ['rows' => $rows, 'total' => $total['n'], 'value' => $total['value'], 'cost' => $total['cost'], 'page' => $pg['page'], 'pages' => (int) ceil($total['n'] / $pg['limit'])];
    }

    public function racks(): array
    {
        return Db::all("SELECT COALESCE(l.location, p.rack, '?') rack, COUNT(*) items, ROUND(SUM(p.price)) value, MIN(p.created_at) oldest
  FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 GROUP BY 1 ORDER BY 1");
    }

    public function setLocation(?array $u, array $b): array
    {
        $sku = mb_strtoupper(trim((string) ($b['sku'] ?? '')));
        $loc = mb_strtoupper(trim((string) ($b['location'] ?? '')));
        $this->need($sku !== '' && $loc !== '', 'SKU and location are needed');
        $prev = Db::get('SELECT location FROM locations WHERE sku=?', $sku);
        Db::run('INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE location=VALUES(location), updated_at=VALUES(updated_at), updated_by=VALUES(updated_by)', $sku, $loc, $u['id']);
        Db::run('INSERT INTO stock_moves(sku,from_loc,to_loc,reason,user_id,at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())', $sku, $prev['location'] ?? null, $loc, ($b['reason'] ?? '') ?: 'putaway', $u['id']);
        $pr = Db::get('SELECT title, qty FROM products WHERE UPPER(sku)=?', $sku);
        return ['ok' => true, 'sku' => $sku, 'location' => $loc, 'product' => $pr];
    }

    public function lookup(?array $u, array $b, array $p, array $qs): array
    {
        $c = trim((string) ($qs['code'] ?? ''));
        $this->need($c !== '', 'Nothing to look up');
        $up = mb_strtoupper($c);
        $prod = Db::get('SELECT p.*, l.location loc FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE UPPER(p.sku)=?', $up);
        $order = Db::get('SELECT id,name,status FROM orders WHERE name=? OR name=? OR tracking=?', $c, $up, $c);
        $inOrders = $prod ? Db::all('SELECT o.id,o.name,o.status,o.created_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? ORDER BY o.created_at DESC LIMIT 5', $up) : [];
        return ['product' => $prod, 'order' => $order, 'inOrders' => $inOrders];
    }

    /* ======================================================= lots & listing */

    public function lotStats(): array
    {
        $rows = Db::all("SELECT p.lot, COUNT(*) listed, SUM(p.qty>0) instock, SUM(p.qty<=0) sold, ROUND(SUM(CASE WHEN p.qty>0 THEN p.price END)) stock_value,
      ROUND(SUM(p.cost)) cost_listed, MIN(p.created_at) first_listed, MAX(p.created_at) last_listed FROM products p WHERE p.lot<>'' GROUP BY p.lot");
        $rev = [];
        foreach (Db::all("SELECT pr.lot, ROUND(SUM(i.price*i.qty)) revenue, COUNT(*) delivered FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products pr ON pr.variant_id=i.variant_id
      WHERE o.status='delivered' AND pr.lot<>'' GROUP BY pr.lot") as $r) {
            $rev[$r['lot']] = $r;
        }
        $ret = [];
        foreach (Db::all("SELECT pr.lot, COUNT(*) n FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products pr ON pr.variant_id=i.variant_id WHERE o.status IN ('returned','return_received','returning') AND pr.lot<>'' GROUP BY pr.lot") as $r) {
            $ret[$r['lot']] = $r['n'];
        }
        $meta = [];
        foreach (Db::all('SELECT * FROM lots') as $r) {
            $meta[$r['name']] = $r;
        }
        $out = array_map(function ($r) use ($meta, $rev, $ret) {
            $m = $meta[$r['lot']] ?? [];
            $rv = $rev[$r['lot']] ?? ['revenue' => 0, 'delivered' => 0];
            $cost = isset($m['cost']) && $m['cost'] !== null ? $m['cost'] : $r['cost_listed'];
            $sellThrough = $r['listed'] ? Logic::jsRound(100 * $r['sold'] / $r['listed']) : 0;
            return array_merge($r, ['vendor' => ($m['vendor'] ?? '') ?: '', 'bought_on' => ($m['bought_on'] ?? '') ?: '', 'pieces' => ($m['pieces'] ?? null) ?: null, 'note' => ($m['note'] ?? '') ?: '',
                'cost' => $cost ?: 0, 'revenue' => $rv['revenue'] ?: 0, 'delivered' => $rv['delivered'] ?: 0, 'returns' => $ret[$r['lot']] ?? 0, 'sellThrough' => $sellThrough,
                'profit' => Logic::jsRound(($rv['revenue'] ?: 0) - ($cost ?: 0)), 'unlisted' => ! empty($m['pieces']) ? max(0, $m['pieces'] - $r['listed']) : null]);
        }, $rows);
        usort($out, fn ($a, $b) => strcmp((string) $b['last_listed'], (string) $a['last_listed']));
        return $out;
    }

    public function lots(): array
    {
        return $this->lotStats();
    }

    public function lotUpdate(?array $u, array $b, array $p): array
    {
        $name = $p['name'];
        Db::run('INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,updated_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE vendor=VALUES(vendor), bought_on=VALUES(bought_on), cost=VALUES(cost), pieces=VALUES(pieces), note=VALUES(note), updated_at=VALUES(updated_at)',
            $name, ($b['vendor'] ?? '') ?: '', ($b['bought_on'] ?? '') ?: '', ($b['cost'] ?? '') === '' || ! isset($b['cost']) ? null : (float) $b['cost'], ! empty($b['pieces']) ? (int) $b['pieces'] : null, ($b['note'] ?? '') ?: '');
        $this->log($u['id'], 'lot.update', 'lot:'.$name, $b);
        return ['ok' => true];
    }

    private function isOwner(?array $u): bool
    {
        return $this->can($u, 'pricing_apply') || $this->can($u, 'finance');
    }

    private function listEcon(): array
    {
        return array_merge(Pricing::ECON_DEFAULTS, (array) ($this->setting('list_econ', []) ?: []));
    }

    /** Lots entered on the old screen have a total cost and pieces but no per-pair cost: work it out */
    private function perPiece(array $l): float|int
    {
        if (($l['per_piece'] ?? 0) > 0) {
            return $l['per_piece'];
        }
        $bad = (int) ($l['bad'] ?? 0);
        return ($l['cost'] ?? 0) > 0 && ($l['pieces'] ?? 0) > $bad ? Logic::jsRound((($l['cost'] ?: 0) + ($l['extra'] ?? 0)) / ($l['pieces'] - $bad)) : 0;
    }

    private function lotRow(string $name): ?array
    {
        $l = Db::get('SELECT * FROM lots WHERE name=?', $name);
        if ($l) {
            $l['comp'] = $this->J($l['comp'], []) ?: [];
            $l['per_piece'] = $this->perPiece($l);
        }
        return $l;
    }

    private function lotAvg(array $lot): float|int
    {
        $its = Db::all('SELECT type,cond,gender,brand,size FROM listings WHERE lot=? LIMIT 2000', $lot['name']);
        if (count($its) < 20) {
            return 0;
        }
        $vs = array_values(array_filter(array_map(fn ($i) => Pricing::valueOf($i['type'], $i['cond'], $i['gender'], $i['brand'], $i['size']), $its), fn ($x) => $x > 0));
        return count($vs) >= 20 ? array_sum($vs) / count($vs) : 0;
    }

    private function eng()
    {
        return Pricing::engine($this->listEcon(), ['lotAvg' => fn ($lot) => $this->lotAvg($lot)]);
    }

    private function nextSerial(): int
    {
        $max = Db::val('SELECT MAX(serial) m FROM listings');
        return (int) max((int) ($this->setting('sku_next', 0) ?: 0), $max === null ? 0 : $max + 1, (int) ($this->listEcon()['startSerial'] ?? 0) ?: 92345);
    }

    private function pairIn(array $b): array
    {
        $v = ['lot' => (string) ($b['lot'] ?? ''), 'type' => (string) ($b['type'] ?? ''), 'gender' => (string) (($b['gender'] ?? '') ?: 'Woman'), 'brand' => trim((string) ($b['brand'] ?? '')), 'size' => (string) ($b['size'] ?? ''),
            'color' => (string) ($b['color'] ?? ''), 'cond' => (string) ($b['cond'] ?? ''), 'material' => (string) ($b['material'] ?? ''), 'note' => trim((string) ($b['note'] ?? '')), 'title' => trim((string) ($b['title'] ?? ''))];
        $v['lotRow'] = $v['lot'] !== '' ? $this->lotRow($v['lot']) : null;
        return $v;
    }

    private function quoteFor(?array $u, array $v, $override): ?array
    {
        $x = $this->eng()->quote(array_merge($v, ['lot' => $v['lotRow'], 'override' => $this->isOwner($u) && (float) $override > 0 ? (float) $override : null]));
        if (! $x) {
            return null;
        }
        $pub = ['final' => $x['final'], 'status' => $x['status'], 'market' => $x['market'], 'floor' => $x['floor'],
            'sales' => array_map(fn ($s) => ['day' => $s['day'], 'off' => $s['off'], 'price' => $s['price']], $x['sales']), 'all' => $x['all'], 'why' => $x['why']];
        return $this->isOwner($u) ? array_merge($pub, $x, ['owner' => true]) : $pub;
    }

    public function listMeta(?array $u): array
    {
        $e = $this->listEcon();
        return ['types' => Pricing::types(), 'conds' => Pricing::CONDS, 'lists' => Pricing::P['lists'], 'brands' => Pricing::allBrands(), 'group' => Pricing::GROUP, 'letters' => $e['letters'] ?? null,
            'labelW' => (float) ($e['labelW'] ?? 0) ?: 50, 'labelH' => (float) ($e['labelH'] ?? 0) ?: 25, 'next' => $this->nextSerial(), 'owner' => $this->isOwner($u), 'plan' => Pricing::PLAN3,
            'lots' => array_map(fn ($l) => ['name' => $l['name'], 'kind' => $l['kind'] ?: '', 'bought_on' => $l['bought_on'] ?: '', 'ready' => (bool) ($this->perPiece($l) || $l['cpv'])],
                Db::all('SELECT * FROM lots ORDER BY COALESCE(NULLIF(bought_on,\'\'),updated_at) DESC'))];
    }

    private const SNEAKERS = ['Running', 'Sports', 'Casual', 'Loafers', 'Formals'];

    /** Mistakes listers make that cost profit. block = cannot save; warn = shown in yellow. */
    private function listChecks(array $u, array $v, array &$b): array
    {
        $block = [];
        $warn = [];
        $sz = (float) preg_replace('/[^0-9.]/', '', (string) $v['size']) ?: 0;
        if ($v['lot'] === '') {
            $block[] = 'Choose a lot.';
        } elseif (! $v['lotRow'] || ! ($v['lotRow']['per_piece'] > 0 || $v['lotRow']['cpv'] > 0)) {
            $block[] = 'This lot has no cost yet. Ask the owner to enter it under Lots.';
        }
        if (! in_array($v['type'], Pricing::types(), true)) {
            $block[] = 'Choose a type from the list.';
        }
        if (! in_array($v['cond'], Pricing::CONDS, true)) {
            $block[] = 'Choose a condition from the list.';
        }
        if (! in_array($v['gender'], ['Woman', 'Men', 'Kids'], true)) {
            $block[] = 'Choose Woman, Men or Kids.';
        }
        if ($v['size'] === '' || ! in_array($v['size'], Pricing::P['lists']['size'], true)) {
            $block[] = 'Choose a size from the list.';
        }
        if ($v['color'] === '') {
            $block[] = 'Choose a colour.';
        }
        if ($v['brand'] === '') {
            $block[] = 'Enter a brand.';
        } elseif (! Pricing::knownBrand($v['brand'])) {
            $msg = "\"{$v['brand']}\" is not on the brand list. Pick it from the list (check the spelling)".($this->isOwner($u) ? '' : ', or ask the owner').'.';
            if ($this->isOwner($u)) {
                $warn[] = $msg;
            } else {
                $block[] = $msg;
            }
        }
        if ($v['cond'] === 'Good' && $v['note'] === '') {
            $block[] = 'Good condition: add a note about the marks.';
        }
        if ($sz) {
            $s = rtrim(rtrim(number_format($sz, 2, '.', ''), '0'), '.');
            if ($v['gender'] !== 'Kids' && $sz <= 33) {
                $block[] = "Size {$s} is a kids' size: choose Kids.";
            }
            if ($v['gender'] === 'Kids' && $sz >= 36) {
                $block[] = "Size {$s} is not a kids' size: choose Woman or Men.";
            }
            if ($v['gender'] === 'Woman' && $sz >= 43 && in_array($v['type'], self::SNEAKERS, true)) {
                $block[] = "Size {$s} {$v['type']}: this is a men's pair. Choose Men (men's pairs sell for more).";
            }
            if ($v['gender'] === 'Men' && $sz <= 38) {
                $warn[] = "Size {$s} for Men is unusual: check it is not a women's pair.";
            }
            if ($v['gender'] === 'Woman' && $sz >= 42 && preg_match('/Heels|Stilettos|Pumps|Wedges/', $v['type'])) {
                $warn[] = "Size {$s} heels are rare: check the size.";
            }
        }
        // same pair saved twice by mistake
        if ($v['lot'] !== '' && $v['brand'] !== '' && empty($b['confirmDup'])) {
            $d = Db::get('SELECT sku FROM listings WHERE user_id=? AND lot=? AND type=? AND brand=? AND size=? AND color=? AND cond=? AND at > (UTC_TIMESTAMP() - INTERVAL 20 MINUTE) ORDER BY serial DESC LIMIT 1',
                $u['id'], $v['lot'], $v['type'], $v['brand'], $v['size'], $v['color'], $v['cond']);
            if ($d) {
                $warn[] = "You saved the same pair {$d['sku']} a few minutes ago. If this is a second pair, save again to confirm.";
                $b['_dup'] = $d['sku'];
            }
        }
        return ['block' => $block, 'warn' => $warn];
    }

    public function listQuote(?array $u, array $b): array
    {
        $v = $this->pairIn($b);
        $x = $this->quoteFor($u, $v, $b['override'] ?? null);
        $bb = array_merge($b, ['confirmDup' => true]);
        $c = $this->listChecks($u, $v, $bb);
        $letters = $this->listEcon()['letters'] ?? [];
        return ['quote' => $x, 'title' => Pricing::autoTitle($v), 'next' => $this->nextSerial(), 'letter' => $letters[Pricing::groupOf($v['type'], $v['gender'])] ?? 'X',
            'msg' => array_merge($c['block'], $c['warn']), 'block' => $c['block'], 'warn' => $c['warn']];
    }

    public function listSave(?array $u, array $b): array
    {
        $v = $this->pairIn($b);
        $chk = $this->listChecks($u, $v, $b);
        $this->need(! $chk['block'], implode(' ', $chk['block']));
        if (! empty($b['_dup'])) {
            $msg = '';
            foreach ($chk['warn'] as $w) {
                if (str_contains($w, $b['_dup'])) {
                    $msg = $w;
                    break;
                }
            }
            throw new HttpError(409, $msg, ['dup' => $b['_dup']]);
        }
        $x = $this->eng()->quote(array_merge($v, ['lot' => $v['lotRow'], 'override' => $this->isOwner($u) && (float) ($b['override'] ?? 0) > 0 ? (float) $b['override'] : null]));
        $this->need($x, 'This type cannot be priced');
        $this->need($x['final'] >= ($x['floor'] ?: 0), "This price loses money. Break-even is Rs {$x['floor']}.");
        $grp = Pricing::groupOf($v['type'], $v['gender']);
        $letter = ($this->listEcon()['letters'] ?? [])[$grp] ?? 'X';
        $it = Db::tx(function () use ($letter, $grp, $v, $x, $u) {
            $serial = $this->nextSerial();
            $sku = "{$letter}-{$serial}";
            Db::run('INSERT INTO listings(sku,serial,letter,grp,lot,gender,type,brand,size,color,cond,material,note,title,price,market,floor,cost,user_id,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',
                $sku, $serial, $letter, $grp, $v['lot'], $v['gender'], $v['type'], $v['brand'], $v['size'], $v['color'], $v['cond'], $v['material'], $v['note'], $v['title'] !== '' ? $v['title'] : Pricing::autoTitle($v), $x['final'], $x['market'], $x['floor'], $x['cost'], $u['id']);
            $this->setSetting('sku_next', $serial + 1);
            return Db::get('SELECT * FROM listings WHERE sku=?', $sku);
        });
        $this->log($u['id'], 'listing.save', 'sku:'.$it['sku'], ['price' => $it['price'], 'lot' => $it['lot']]);
        if (! $this->isOwner($u)) {
            unset($it['cost'], $it['floor']);
        }
        return $it;
    }

    private function listCols(?array $u): string
    {
        return $this->isOwner($u) ? 'l.*, us.name by_name' : 'l.sku,l.serial,l.grp,l.lot,l.gender,l.type,l.brand,l.size,l.color,l.cond,l.material,l.note,l.title,l.price,l.at,l.exported,l.exported_at,l.user_id, us.name by_name';
    }

    public function listRecent(?array $u, array $b, array $p, array $qs): array
    {
        $where = [];
        $args = [];
        if (($qs['mine'] ?? '') === '1') {
            $where[] = 'l.user_id=?';
            $args[] = $u['id'];
        }
        if (($qs['pending'] ?? '') === '1') {
            $where[] = 'l.exported=0';
        }
        if (! empty($qs['lot'])) {
            $where[] = 'l.lot=?';
            $args[] = $qs['lot'];
        }
        if (! empty($qs['q'])) {
            $where[] = '(l.sku LIKE ? OR l.brand LIKE ? OR l.title LIKE ?)';
            array_push($args, ...array_fill(0, 3, '%'.$qs['q'].'%'));
        }
        $lim = min(2000, (int) ($qs['limit'] ?? 0) ?: 200);
        return Db::all('SELECT '.$this->listCols($u).' FROM listings l LEFT JOIN users us ON us.id=l.user_id '.($where ? 'WHERE '.implode(' AND ', $where) : '')." ORDER BY l.serial DESC LIMIT {$lim}", ...$args);
    }

    public function listDelete(?array $u, array $b, array $p): array
    {
        $it = Db::get('SELECT * FROM listings WHERE sku=?', $p['sku']);
        $this->need($it, 'Not found', 404);
        $this->need($this->isOwner($u) || ((int) $it['user_id'] === $u['id'] && ! $it['exported']), 'Only the owner can remove a pair that is already exported', 403);
        Db::run('DELETE FROM listings WHERE sku=?', $it['sku']);
        $this->log($u['id'], 'listing.delete', 'sku:'.$it['sku'], $it);
        return ['ok' => true];
    }

    public function listExport(?array $u, array $b): array
    {
        $skus = is_array($b['skus'] ?? null) ? array_map('strval', $b['skus']) : [];
        $items = $skus ? Db::all('SELECT * FROM listings WHERE sku IN ('.Db::marks($skus).') ORDER BY serial', ...$skus) : Db::all('SELECT * FROM listings WHERE exported=0 ORDER BY serial');
        $this->need($items, 'Nothing to export');
        $csv = Pricing::shopifyCsv($items, $this->listEcon(), $this->isOwner($u));
        if (($b['mark'] ?? null) !== false) {
            Db::run('UPDATE listings SET exported=1, exported_at=UTC_TIMESTAMP() WHERE sku IN ('.Db::marks($items).')', ...array_column($items, 'sku'));
        }
        $this->log($u['id'], 'listing.export', 'listings', ['n' => count($items)]);
        return ['csv' => $csv, 'n' => count($items), 'filename' => 'shopify-import-'.$this->today().'-'.count($items).'.csv'];
    }

    public function listLots(?array $u): array
    {
        $cnt = [];
        foreach (Db::all('SELECT lot, COUNT(*) n, SUM(price) v FROM listings GROUP BY lot') as $r) {
            $cnt[$r['lot']] = $r;
        }
        return array_map(function ($l) use ($cnt, $u) {
            $comp = $this->J($l['comp'], []) ?: [];
            $c = $cnt[$l['name']] ?? ['n' => 0, 'v' => 0];
            $sell = ($l['pieces'] ?: 0) - ($l['bad'] ?: 0);
            $base = ['name' => $l['name'], 'vendor' => $l['vendor'] ?: '', 'bought_on' => $l['bought_on'] ?: '', 'kind' => $l['kind'] ?: '', 'pieces' => $l['pieces'], 'bad' => $l['bad'] ?: 0, 'sellable' => $sell,
                'listed' => $c['n'], 'listed_value' => Logic::jsRound($c['v'] ?: 0), 'ready' => (bool) ($this->perPiece($l) || $l['cpv']), 'note' => $l['note'] ?: ''];
            return $this->isOwner($u) ? array_merge($base, ['cost' => $l['cost'], 'extra' => $l['extra'] ?: 0, 'per_piece' => $this->perPiece($l), 'cpv' => $l['cpv'], 'comp' => $comp]) : $base;
        }, Db::all("SELECT * FROM lots ORDER BY COALESCE(NULLIF(bought_on,''),updated_at) DESC"));
    }

    public function listLotPlan(?array $u, array $b): array
    {
        $this->need($this->isOwner($u), 'Owner only', 403);
        return $this->eng()->lotPlan($b);
    }

    public function listLotSave(?array $u, array $b): array
    {
        $this->need($this->isOwner($u), 'Only the owner can enter lot costs', 403);
        $name = trim((string) ($b['name'] ?? ''));
        $this->need($name !== '', 'Enter a lot name');
        $this->need((float) ($b['cost'] ?? 0) > 0, 'Enter the lot price');
        $this->need((float) ($b['pieces'] ?? 0) > 0, 'Enter the total number of pairs');
        $this->need(((float) ($b['bad'] ?? 0)) < (float) $b['pieces'], "Damaged pairs can't be equal to or more than the total");
        $kind = ($b['kind'] ?? '') === 'leftover' ? 'leftover' : 'used';
        $comp = array_values(array_map(fn ($r) => ['t' => (string) $r['t'], 'g' => (string) (($r['g'] ?? '') ?: 'Woman'), 'c' => (string) $r['c'], 'n' => (float) $r['n'] + 0, 'b' => (string) ($r['b'] ?? '')],
            array_filter(is_array($b['comp'] ?? null) ? $b['comp'] : [], fn ($r) => is_array($r) && (float) ($r['n'] ?? 0) > 0)));
        $plan = $this->eng()->lotPlan(['name' => $name, 'kind' => $kind, 'cost' => (float) $b['cost'], 'extra' => (float) ($b['extra'] ?? 0), 'pieces' => (float) $b['pieces'], 'bad' => (float) ($b['bad'] ?? 0), 'comp' => $comp]);
        Db::run('INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,kind,extra,bad,per_piece,cpv,comp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE vendor=VALUES(vendor),bought_on=VALUES(bought_on),cost=VALUES(cost),pieces=VALUES(pieces),note=VALUES(note),kind=VALUES(kind),extra=VALUES(extra),bad=VALUES(bad),per_piece=VALUES(per_piece),cpv=VALUES(cpv),comp=VALUES(comp),updated_at=VALUES(updated_at)',
            $name, (string) ($b['vendor'] ?? ''), (string) (($b['bought_on'] ?? '') ?: $this->today()), (float) $b['cost'], (int) $b['pieces'], (string) ($b['note'] ?? ''), $kind, (float) ($b['extra'] ?? 0), (int) ($b['bad'] ?? 0), $plan['per_piece'], ($plan['cpv'] ?? null) ?: null, json_encode($comp));
        $this->log($u['id'], 'lot.save', 'lot:'.$name, ['cost' => (float) $b['cost'], 'pieces' => (float) $b['pieces'], 'kind' => $kind]);
        return ['ok' => true, 'plan' => $plan];
    }

    public function listLotDelete(?array $u, array $b, array $p): array
    {
        $this->need($this->isOwner($u), 'Owner only', 403);
        $name = $p['name'];
        $this->need(! Db::get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', $name), 'Pairs are already listed from this lot, so it cannot be removed');
        Db::run('DELETE FROM lots WHERE name=?', $name);
        $this->log($u['id'], 'lot.delete', 'lot:'.$name, null);
        return ['ok' => true];
    }

    public function listEconGet(?array $u): array
    {
        $this->need($this->isOwner($u), 'Owner only', 403);
        $e = $this->eng();
        return ['econ' => $this->listEcon(), 'next' => $this->nextSerial(), 'perPair' => ['ads' => Logic::jsRound($e->E['adsPP']), 'fixed' => Logic::jsRound($e->E['ohBE']), 'profit' => Logic::jsRound($e->E['ohT'] - $e->E['ohBE']), 'keep' => round($e->E['keep'], 4)]];
    }

    public function listEconSave(?array $u, array $b): array
    {
        $nx = (array) ($this->setting('list_econ', []) ?: []);
        foreach (array_keys(Pricing::ECON_DEFAULTS) as $k) {
            if (array_key_exists($k, $b)) {
                $nx[$k] = in_array($k, ['letters', 'body', 'status'], true) ? $b[$k] : (float) $b[$k] + 0;
            }
        }
        $this->setSetting('list_econ', $nx);
        if ((float) ($b['next'] ?? 0) > 0) {
            $this->need((int) $b['next'] >= ((int) Db::val('SELECT MAX(serial) m FROM listings')) + 1, 'The next SKU number must be higher than the last one used');
            $this->setSetting('sku_next', (int) $b['next']);
        }
        $this->log($u['id'], 'listing.econ', 'settings', $b);
        return ['ok' => true];
    }

    public function pricingRules(): array
    {
        return $this->setting('pricing_rules', Logic::DEFAULT_RULES);
    }

    public function pricingRulesSave(?array $u, array $b): array
    {
        $ok = is_array($b['steps'] ?? null);
        foreach ($b['steps'] ?? [] as $s) {
            $ok = $ok && ($s['days'] ?? -1) >= 0 && ($s['off'] ?? -1) >= 0 && $s['off'] < 90;
        }
        $this->need($ok, 'Check the markdown steps');
        $steps = array_map(fn ($s) => ['days' => (float) $s['days'] + 0, 'off' => (float) $s['off'] + 0], $b['steps']);
        usort($steps, fn ($a, $c) => $a['days'] <=> $c['days']);
        $r = array_merge(Logic::DEFAULT_RULES, $b, ['steps' => $steps]);
        $this->setSetting('pricing_rules', $r);
        $this->log($u['id'], 'pricing.rules', 'settings', $r);
        return $r;
    }

    public function pricingSuggestions(?array $u, array $b, array $p, array $qs): array
    {
        $rules = $this->setting('pricing_rules', Logic::DEFAULT_RULES);
        $ls = [];
        foreach ($this->lotStats() as $l) {
            $ls[$l['lot']] = $l;
        }
        $w = ['p.qty>0', "p.status='ACTIVE'"];
        $a = [];
        if (! empty($qs['lot'])) {
            $w[] = 'p.lot=?';
            $a[] = $qs['lot'];
        }
        $rows = Db::all('SELECT p.variant_id,p.product_id,p.sku,p.title,p.price,p.compare_at,p.cost,p.qty,p.created_at,p.lot,p.brand,p.image,p.size,p.cond FROM products p WHERE '.implode(' AND ', $w).' ORDER BY p.created_at LIMIT 5000', ...$a);
        $out = [];
        foreach ($rows as $r) {
            $s = Logic::priceSuggestion($r, $rules, $ls);
            if ($s) {
                $out[] = array_merge($r, $s);
            }
        }
        return ['rows' => array_slice($out, 0, 1000), 'total' => count($out), 'rules' => $rules];
    }

    public function pricingApply(?array $u, array $b): array
    {
        $items = array_slice($b['items'] ?? [], 0, 250);
        $this->need($items, 'Nothing selected');
        $changes = [];
        foreach ($items as $it) {
            $p0 = Db::get('SELECT * FROM products WHERE variant_id=?', $it['variant_id'] ?? '');
            if (! $p0) {
                continue;
            }
            $price = Logic::jsRound((float) ($it['price'] ?? 0));
            $this->need($price > 0, 'Bad price for '.$p0['sku']);
            $compare = ($b['keepCompare'] ?? null) !== false ? ($p0['compare_at'] && $p0['compare_at'] > $price ? $p0['compare_at'] : ($p0['price'] > $price ? $p0['price'] : null)) : null;
            $changes[] = ['product_id' => $p0['product_id'], 'variant_id' => $p0['variant_id'], 'price' => $price, 'compare_at' => $compare, 'old' => $p0['price'], 'sku' => $p0['sku']];
        }
        $demo = (bool) $this->setting('demo');
        if ($this->shopify()->configured() && ! $demo) {
            try {
                $results = app(ShopifyWriter::class)->updatePrices($changes, $u['id']);
            } catch (ShopifyException $e) {
                throw new HttpError(400, $e->getMessage()); // e.g. price writes switched off: nothing was changed
            }
        } else {
            $results = array_map(fn ($c) => ['variant_id' => $c['variant_id'], 'ok' => true, 'error' => $demo ? 'demo: not sent to Shopify' : ''], $changes);
        }
        foreach ($changes as $c) {
            $r = [];
            foreach ($results as $x) {
                if ($x['variant_id'] === $c['variant_id']) {
                    $r = $x;
                    break;
                }
            }
            Db::run('INSERT INTO price_changes(variant_id,sku,old_price,new_price,compare_at,reason,user_id,pushed,error,at) VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',
                $c['variant_id'], $c['sku'], $c['old'], $c['price'], $c['compare_at'], ($b['reason'] ?? '') ?: 'markdown', $u['id'], ! empty($r['ok']) ? 1 : 0, ($r['error'] ?? '') ?: null);
            if (! empty($r['ok'])) {
                Db::run('UPDATE products SET price=?, compare_at=? WHERE variant_id=?', $c['price'], $c['compare_at'], $c['variant_id']);
            }
        }
        $this->log($u['id'], 'pricing.apply', 'products', ['n' => count($changes)]);
        return ['ok' => count(array_filter($results, fn ($r) => ! empty($r['ok']))), 'failed' => array_values(array_filter($results, fn ($r) => empty($r['ok'])))];
    }

    public function pricingHistory(): array
    {
        return Db::all('SELECT pc.*, us.name user FROM price_changes pc LEFT JOIN users us ON us.id=pc.user_id ORDER BY pc.id DESC LIMIT 200');
    }

    /* =============================================================== tracking */

    public function tracking(?array $u, array $b, array $p, array $qs): array
    {
        $stuck = (int) $this->setting('stuck_days', 6);
        $B = [
            'active' => "o.status IN ('dispatched','in_transit','out_for_delivery')",
            'attempted' => "o.status='attempted'",
            'stuck' => "o.status IN ('dispatched','in_transit','out_for_delivery','attempted') AND o.dispatched_at < (UTC_TIMESTAMP() - INTERVAL {$stuck} DAY)",
            'returning' => "o.status IN ('returning','returned')",
            'delivered' => "o.status='delivered' AND o.delivered_at>=(UTC_TIMESTAMP() - INTERVAL 7 DAY)",
        ];
        $where = $B[$qs['bucket'] ?? ''] ?? $B['active'];
        $rows = Db::all("SELECT o.id,o.name,o.cust_name,o.phone,o.city,o.total,o.tracking,o.courier,o.status,o.px_status,o.px_updated,o.dispatched_at,o.cs_note,
      TIMESTAMPDIFF(DAY, o.dispatched_at, UTC_TIMESTAMP()) days, c.label clabel FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE {$where} ORDER BY o.dispatched_at LIMIT 500");
        foreach ($rows as &$r) {
            $r['wa'] = Logic::waNumber($r['phone']);
        }
        $counts = [];
        foreach ($B as $k => $w) {
            $counts[$k] = (int) Db::val("SELECT COUNT(*) n FROM orders o WHERE {$w}");
        }
        return ['rows' => $rows, 'counts' => $counts, 'lastSync' => Db::get("SELECT at, message FROM sync_log WHERE kind='postex' ORDER BY id DESC LIMIT 1")];
    }

    public function trackingRefresh(?array $u, array $b, array $p): array
    {
        $o = Db::get('SELECT * FROM orders WHERE id=?', $p['id']);
        $this->need($o && $o['tracking'], 'No tracking number');
        $this->need($this->postex()->configured(), 'Add the PostEx token in Settings first');
        $this->postex()->trackOne($o['tracking']);
        return Db::get('SELECT status, px_status, px_updated FROM orders WHERE id=?', $o['id']);
    }

    /* ================================================================ finance */

    public function financeSummary(?array $u, array $b, array $p, array $qs): array
    {
        return Finance::summary(($qs['month'] ?? '') ?: substr($this->today(), 0, 7));
    }

    public function financeCod(?array $u, array $b, array $p, array $qs): array
    {
        $settled = ($qs['settled'] ?? '') === '1' ? 1 : 0;
        $rows = Db::all("SELECT id,name,cust_name,city,tracking,total,cod,px_fee,px_tax,delivered_at,settled,settled_at,settle_ref FROM orders WHERE status='delivered' AND settled=? ORDER BY delivered_at DESC LIMIT 1000", $settled);
        $tot = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)),0) cod, COALESCE(SUM(COALESCE(px_fee,0)+COALESCE(px_tax,0)),0) fees FROM orders WHERE status='delivered' AND settled=?", $settled);
        return array_merge(['rows' => $rows], $tot);
    }

    public function financeSettle(?array $u, array $b): array
    {
        $ids = $b['ids'] ?? [];
        $this->need($ids, 'Select orders');
        foreach ($ids as $id) {
            Db::run("UPDATE orders SET settled=1, settled_at=COALESCE(?,DATE_FORMAT(UTC_DATE(),'%Y-%m-%d')), settle_ref=COALESCE(?,settle_ref) WHERE id=? AND status='delivered'", ($b['date'] ?? '') ?: null, ($b['ref'] ?? '') ?: null, (string) $id);
        }
        $this->log($u['id'], 'cod.settled', 'finance', ['n' => count($ids), 'ref' => $b['ref'] ?? null]);
        return ['ok' => true];
    }

    public function expenseCategories(): array
    {
        return $this->setting('expense_categories', self::defaults()['expense_categories']);
    }

    public function expensesList(?array $u, array $b, array $p, array $qs): array
    {
        return Db::all('SELECT e.*, us.name user FROM expenses e LEFT JOIN users us ON us.id=e.user_id WHERE SUBSTR(e.day,1,7)=? ORDER BY e.day DESC, e.id DESC', ($qs['month'] ?? '') ?: substr($this->today(), 0, 7));
    }

    public function expenseSave(?array $u, array $b): array
    {
        $this->need(! empty($b['day']) && ! empty($b['category']) && (float) ($b['amount'] ?? 0) > 0, 'Date, category and amount are needed');
        if (! empty($b['id'])) {
            Db::run('UPDATE expenses SET day=?, category=?, amount=?, note=? WHERE id=?', $b['day'], $b['category'], (float) $b['amount'], ($b['note'] ?? '') ?: '', (int) $b['id']);
        } else {
            Db::run('INSERT INTO expenses(day,category,amount,note,user_id,at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())', $b['day'], $b['category'], (float) $b['amount'], ($b['note'] ?? '') ?: '', $u['id']);
        }
        $this->log($u['id'], ! empty($b['id']) ? 'expense.edit' : 'expense.add', 'finance', $b);
        return ['ok' => true];
    }

    public function expenseDelete(?array $u, array $b, array $p): array
    {
        $e = Db::get('SELECT * FROM expenses WHERE id=?', (int) $p['id']);
        Db::run('DELETE FROM expenses WHERE id=?', (int) $p['id']);
        $this->log($u['id'], 'expense.delete', 'finance', $e);
        return ['ok' => true];
    }

    public function financeExport(?array $u, array $b, array $p, array $qs)
    {
        $m = ($qs['month'] ?? '') ?: substr($this->today(), 0, 7);
        $this->need(preg_match('/^\d{4}-\d{2}$/', $m), 'Bad month');
        $rows = Db::all("SELECT name, DATE_FORMAT(created_at + INTERVAL 5 HOUR,'%Y-%m-%d') created, cust_name, city, total, status, tracking, cod, px_fee, px_tax, px_rev_fee, px_rev_tax, delivered_at, returned_at, settled, settle_ref FROM orders
    WHERE DATE_FORMAT(COALESCE(delivered_at, returned_at, created_at),'%Y-%m')=? ORDER BY created_at", $m);
        $head = array_keys($rows[0] ?? ['name' => '']);
        $lines = [implode(',', $head)];
        foreach ($rows as $r) {
            $lines[] = implode(',', array_map(function ($h) use ($r) {
                $v = $r[$h] === null ? '' : (string) $r[$h];
                return preg_match('/[",\n]/', $v) ? '"'.str_replace('"', '""', $v).'"' : $v;
            }, $head));
        }
        return response("\u{FEFF}".implode("\n", $lines), 200, ['Content-Type' => 'text/csv; charset=utf-8', 'Content-Disposition' => "attachment; filename=\"sundaybazar-orders-{$m}.csv\""]);
    }

    public function reports(?array $u, array $b, array $p, array $qs): array
    {
        return Finance::reports((int) min(365, max(7, (int) ($qs['days'] ?? 0) ?: 30)));
    }

    /* ======================================================== settings & sync */

    public function settingsGet(): array
    {
        $d = self::defaults();
        $s = [];
        foreach (self::SETTING_KEYS as $k) {
            $s[$k] = $this->setting($k, $d[$k]);
        }
        $sh = $this->shopify()->cfg();
        // credentials live in .env: only report whether they are present, never their values
        $s['shopify'] = ['shop' => $sh['shop'], 'hasToken' => $sh['token'] !== '', 'clientId' => $sh['clientId'] !== '' ? mb_substr($sh['clientId'], 0, 6).'…' : '', 'hasSecret' => $sh['clientSecret'] !== '', 'fromEnv' => true,
            'apiVersion' => $sh['apiVersion'], 'locations' => Db::all('SELECT id,name,is_active isActive FROM shopify_locations ORDER BY name'), 'write' => config('shopify.write')];
        $s['postex'] = ['hasToken' => $this->postex()->configured(), 'fromEnv' => (string) config('services.postex.token') !== ''];
        $s['lan'] = [rtrim((string) config('app.url'), '/')];
        $s['data_dir'] = 'MySQL database '.config('database.connections.'.config('database.default').'.database');
        $s['defaults'] = ['wa_template' => self::DEFAULT_WA];
        return $s;
    }

    public function settingsSave(?array $u, array $b): array
    {
        foreach (self::SETTING_KEYS as $k) {
            if (array_key_exists($k, $b)) {
                if ($k === 'shopify_location' && $b[$k] !== '' && Db::val('SELECT COUNT(*) FROM shopify_locations') > 0) {
                    $this->need(Db::get('SELECT id FROM shopify_locations WHERE id=?', $b[$k]), 'Unknown Shopify location — test the connection first');
                }
                $this->setSetting($k, $b[$k]);
            }
        }
        // Shopify credentials are configured in .env only (never stored in the database or sent to the browser)
        if (! empty($b['postex']['token'])) {
            $this->setSetting('postex', ['token' => (string) $b['postex']['token']]);
        }
        $this->log($u['id'], 'settings.save', 'settings', array_keys($b));
        return ['ok' => true];
    }

    public function testShopify(?array $u): array
    {
        try {
            $d = $this->shopify()->shopInfo();
        } catch (ShopifyException $e) {
            $this->setSetting('shopify_check', ['at' => gmdate('Y-m-d H:i:s'), 'ok' => false, 'error' => $e->getMessage()]);
            throw new HttpError(400, $e->getMessage());
        }
        app(\App\Services\Shopify\ShopifySync::class)->saveLocations($d['locations']['nodes'] ?? []);
        $missing = $this->shopify()->missingScopes();
        $this->setSetting('shopify_check', ['at' => gmdate('Y-m-d H:i:s'), 'ok' => true, 'shop' => $d['shop'], 'missing' => $missing]);
        $this->log($u['id'], 'shopify.test', 'settings', $d['shop']['myshopifyDomain'] ?? '');
        return ['shop' => $d['shop'], 'locations' => $d['locations']['nodes'] ?? [], 'missingScopes' => $missing];
    }

    public function testPostex(): array
    {
        $j = $this->postex()->call('/v1/get-order-status');
        return ['ok' => true, 'statuses' => $j['dist'] ?? $j];
    }

    public function syncStart(?array $u, array $b): array
    {
        return SyncRunner::start((string) (($b['kind'] ?? '') ?: 'all'), $u['id']);
    }

    public function syncGet(): array
    {
        return SyncRunner::state();
    }

    public function syncLogList(): array
    {
        return Db::all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 100');
    }

    public function demoLoad(): array
    {
        $this->need(! $this->shopify()->configured() || $this->setting('demo'), 'Demo data cannot be loaded once Shopify is connected');
        \App\Erp\Core\Demo::load();
        return ['ok' => true];
    }

    public function demoClear(?array $u): array
    {
        \App\Erp\Core\Demo::clear();
        $this->log($u['id'], 'demo.clear', 'settings', '');
        return ['ok' => true];
    }

    /* ================================================================== files */

    public function fileUpload(?array $u, array $b): array
    {
        $this->need(! empty($b['data']) && is_string($b['data']), 'No file');
        $size = (int) floor(strlen($b['data']) * 3 / 4);
        $this->need($size <= 4.2e6, 'File is too big (max 4 MB)');
        $bytes = base64_decode($b['data'], true);
        $this->need($bytes !== false, 'No file');
        $id = bin2hex(random_bytes(10));
        $path = 'erp-files/'.substr($id, 0, 2).'/'.$id;
        Storage::disk('local')->put($path, $bytes);
        Db::run('INSERT INTO files(id,name,type,size,path,user_id,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())', $id, mb_substr((string) (($b['name'] ?? '') ?: 'file'), 0, 120), mb_substr((string) (($b['type'] ?? '') ?: 'application/octet-stream'), 0, 80), strlen($bytes), $path, $u['id']);
        return ['id' => $id];
    }

    public function fileGet(?array $u, array $b, array $p)
    {
        $f = Db::get('SELECT * FROM files WHERE id=?', $p['id']);
        $this->need($f && Storage::disk('local')->exists($f['path']), 'Not found', 404);
        $safe = preg_match('#^(image/(png|jpe?g|gif|webp)|application/pdf)$#', (string) $f['type']) ? $f['type'] : 'application/octet-stream';
        $name = preg_replace('/[^\w.\- ]/', '_', (string) $f['name']);
        return response(Storage::disk('local')->get($f['path']), 200, ['Content-Type' => $safe, 'Content-Disposition' => ($safe === 'application/octet-stream' ? 'attachment' : 'inline').'; filename="'.$name.'"',
            'Cache-Control' => 'private, max-age=3600', 'X-Content-Type-Options' => 'nosniff']);
    }

    /* ======================================================= counts & alerts */

    public function counts(array $u): array
    {
        $c = [];
        if ($this->can($u, 'cs')) {
            $c['cs'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE stage IN ('new','hold') AND tracking IS NULL AND cancelled_at IS NULL AND status IN ('new','hold')");
        }
        if ($this->can($u, 'warehouse')) {
            $c['warehouse'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked')");
        }
        if ($this->can($u, 'tracking')) {
            $c['tracking'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status='attempted'");
        }
        return $c;
    }

    public function alerts(array $u): array
    {
        $out = [];
        if ($this->can($u, 'tracking')) {
            $n = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < (UTC_TIMESTAMP() - INTERVAL 6 DAY)");
            if ($n) {
                $out[] = ['level' => 'warn', 'text' => "{$n} parcels have not been delivered in 6+ days", 'href' => '#/tracking/stuck'];
            }
        }
        if ($this->can($u, 'settings')) {
            foreach (\App\Services\Shopify\ShopifyStatus::alerts() as $a) {
                $out[] = $a;
            }
        }
        return $out;
    }
}
