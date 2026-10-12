<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;

/** Port of legacy/server/modules/tickets.js — CS tickets, exchanges, refunds & store credit, delivery follow-ups. */
class TicketsModule extends Module
{
    public string $name = 'tickets';

    private const TYPES = ['Wrong item', 'Damaged / not as described', 'Size exchange', 'Return request', 'Refund', 'Delivery issue', 'Order inquiry', 'Complaint about staff', 'Other'];
    private const CHANNELS = ['WhatsApp', 'Call', 'Instagram', 'Facebook', 'Email', 'Walk-in/outlet', 'Google Form'];
    private const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    private const STATUSES = ['open' => 'Open', 'waiting' => 'Waiting for customer', 'progress' => 'In progress', 'resolved' => 'Resolved', 'closed' => 'Closed'];
    private const OPEN = "('open','waiting','progress')";
    private const RESOLUTIONS = ['Exchanged', 'Refunded', 'Store credit given', 'Re-delivery arranged', 'Replacement sent', 'Information given', 'Customer cancelled', 'No action needed', 'Other'];
    private const NOFIX = 'Closed without fix';
    private const NOFIX_REASONS = ['Spam', 'Duplicate ticket', 'Customer not responding', 'Opened by mistake', 'Other'];
    // "whose mistake" — department responsible for a customer problem (internal ones count against a person's performance)
    private const FAULT_DEPTS = [
        ['k' => 'listing', 'l' => 'Listing', 'internal' => true, 'hint' => 'wrong size / condition / photo / price listed', 'reasons' => ['Wrong size listed', 'Wrong condition listed', 'Wrong or misleading photo', 'Wrong price', 'Wrong brand / model', 'Defect not mentioned']],
        ['k' => 'sorting', 'l' => 'Sorting & QC', 'internal' => true, 'hint' => 'damaged pair passed QC', 'reasons' => ['Damaged pair passed QC', 'Pair mismatch (left / right)', 'Not cleaned', 'Wrong grade']],
        ['k' => 'warehouse', 'l' => 'Warehouse', 'internal' => true, 'hint' => 'wrong location / missing pair', 'reasons' => ['Wrong rack location', 'Pair missing', 'Damaged in storage', 'Wrong pair put away']],
        ['k' => 'dispatch', 'l' => 'Dispatch', 'internal' => true, 'hint' => 'wrong item packed, wrong courier / address, late', 'reasons' => ['Wrong item packed', 'Missing item in parcel', 'Wrong address / city', 'Wrong courier', 'Late dispatch', 'Poor packing']],
        ['k' => 'cs', 'l' => 'CS', 'internal' => true, 'hint' => 'wrong confirmation / promise', 'reasons' => ['Wrong order confirmation', 'Wrong promise to customer', 'Wrong address taken', 'Late or rude reply']],
        ['k' => 'courier', 'l' => 'Courier', 'internal' => false, 'hint' => 'PostEx / TCS / rider', 'reasons' => ['Late delivery', 'Rider did not attempt', 'Parcel damaged or lost', 'Rider misbehaved']],
        ['k' => 'supplier', 'l' => 'Supplier', 'internal' => false, 'hint' => 'lot quality', 'reasons' => ['Lot quality issue', 'Hidden defect from supplier']],
        ['k' => 'customer', 'l' => 'Customer', 'internal' => false, 'hint' => 'changed mind / no fault of ours', 'reasons' => ['Changed mind', 'Ordered wrong size', 'Refused without reason', 'No fault of ours']],
        ['k' => 'unknown', 'l' => 'Unknown', 'internal' => false, 'hint' => 'could not find out', 'reasons' => ['Could not find out']],
    ];
    private const INTERNAL = ['listing', 'sorting', 'warehouse', 'dispatch', 'cs'];
    private const FAULT_TYPES = ['Wrong item', 'Damaged / not as described', 'Size exchange', 'Delivery issue', 'Complaint about staff'];
    private const FAULT_GUESS = ['Wrong item' => 'dispatch', 'Damaged / not as described' => 'sorting', 'Size exchange' => 'listing', 'Delivery issue' => 'courier', 'Complaint about staff' => 'cs'];
    private const STEPS = ['requested', 'approved', 'received', 'dispatched', 'completed'];
    private const STEP_L = ['requested' => 'Requested', 'approved' => 'Approved', 'received' => 'Old item received', 'dispatched' => 'New item dispatched', 'completed' => 'Completed', 'cancelled' => 'Cancelled'];
    private const METHODS = ['Bank transfer', 'JazzCash', 'EasyPaisa', 'Store credit'];
    private const DEF_SLA = ['urgent' => 2, 'high' => 8, 'normal' => 24, 'low' => 72];
    private const DEF_TEMPLATES = [
        ['name' => 'Greeting', 'text' => 'Assalam o Alaikum {name}! SundayBazar customer care se baat ho rahi hai. Aap ke order {order} ke baare mein aap ka message mila hai, hum abhi check kar rahe hain.'],
        ['name' => 'Ask for photos', 'text' => 'Assalam o Alaikum {name}! Order {order} ka masla samajhne ke liye please shoes ki 2-3 clear pictures (label aur sole ke saath) yahan bhej dein. Shukriya!'],
        ['name' => 'Exchange approved', 'text' => 'Assalam o Alaikum {name}! Aap ka exchange approve ho gaya hai (order {order}). PostEx rider purana pair le jayega aur naya pair bhej diya jayega. Shukriya!'],
        ['name' => 'Parcel on the way', 'text' => 'Assalam o Alaikum {name}! Aap ka SundayBazar order {order} (PostEx {tracking}) raste mein hai. Rider call kare to please receive kar lijiye ga.'],
        ['name' => 'Delivery attempted', 'text' => 'Assalam o Alaikum {name}! PostEx rider ne aap ka order {order} (tracking {tracking}) deliver karne ki koshish ki thi. Kya hum dobara bhejwa dein? Konsa time behtar hai?'],
        ['name' => 'Refund sent', 'text' => 'Assalam o Alaikum {name}! Order {order} ka refund bhej diya gaya hai. Please check kar ke confirm kar dein. Takleef ke liye maazrat.'],
    ];
    private const RET_ST = ['returning', 'returned', 'return_received'];

    private const T_COLS = "t.*, us.name assignee_name, fu.name fault_user_name, c.label clabel, (t.status IN ('open','progress') AND t.due_at<UTC_TIMESTAMP()) overdue,
      (SELECT COUNT(*) FROM tk_notes n WHERE n.ticket_id=t.id AND n.kind<>'system') nnotes";

    public function perms(): array
    {
        return [];
    }

    public function routes(Router $r): void
    {
        $r->get('/api/tickets/meta', 'tickets', 'meta');
        $r->get('/api/tickets', 'tickets', 'ticketsList');
        $r->get('/api/tickets/lookup', 'tickets', 'lookup');
        $r->post('/api/tickets', 'tickets', 'ticketCreate');
        $r->post('/api/tickets/bulk', 'tickets', 'bulk');
        $r->get('/api/tickets/customer/:phone', 'tickets', 'customer360');
        $r->get('/api/tickets/settings', 'tickets', 'settingsGet');
        $r->post('/api/tickets/settings', 'tickets', 'settingsSave');
        $r->post('/api/tickets/auto/run', 'tickets', 'autoRun');
        $r->get('/api/tickets/report', 'tickets', 'report');
        $r->get('/api/tickets/:id', 'tickets', 'ticketGet');
        $r->post('/api/tickets/:id', 'tickets', 'ticketUpdate');
        $r->post('/api/tickets/:id/note', 'tickets', 'ticketNote');
        $r->post('/api/tickets/:id/resolve', 'tickets', 'ticketResolve');
        $r->post('/api/tickets/:id/close', 'tickets', 'ticketClose');
        $r->get('/api/tickets/:id/fault', 'tickets', 'faultGet');
        $r->post('/api/tickets/:id/fault', 'tickets', 'faultSave');
        $r->post('/api/tickets/:id/reopen', 'tickets', 'ticketReopen');
        $r->get('/api/exchanges/products', 'tickets', 'exProducts');
        $r->get('/api/exchanges', 'tickets', 'exList');
        $r->get('/api/exchanges/:id', 'tickets', 'exGet');
        $r->post('/api/exchanges', 'tickets', 'exCreate');
        $r->post('/api/exchanges/:id', 'tickets', 'exUpdate');
        $r->post('/api/exchanges/:id/step', 'tickets', 'exStep');
        $r->get('/api/refunds', 'dashboard', 'refundsList');
        $r->post('/api/refunds', 'tickets', 'refundCreate');
        $r->post('/api/refunds/:id/approve', 'dashboard', 'refundApprove');
        $r->post('/api/refunds/:id/reject', 'dashboard', 'refundReject');
        $r->post('/api/refunds/:id/paid', 'dashboard', 'refundPaid');
        $r->post('/api/refunds/:id/post', 'dashboard', 'refundPost');
    }

    /* ------------------------------------------------------------ JS-like helpers */

    /** JS truthiness */
    private static function tr($v): bool
    {
        return ! ($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0 || (is_float($v) && is_nan($v)));
    }

    /** JS unary plus */
    private static function num($v): int|float
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
        if (is_string($v)) {
            $s = trim($v);
            if ($s === '') {
                return 0;
            }
            if (is_numeric($s)) {
                return $s + 0;
            }
            return NAN;
        }
        if (is_array($v) && ! $v) {
            return 0;
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
        if (is_float($v)) {
            if (is_nan($v)) {
                return 'NaN';
            }
            if (floor($v) == $v && abs($v) < 1e15) {
                return (string) (int) $v;
            }
            return (string) $v;
        }
        if (is_array($v)) {
            return array_is_list($v) ? implode(',', array_map(fn ($x) => is_array($x) ? '[object Object]' : ($x === null ? '' : self::str($x)), $v)) : '[object Object]';
        }
        return (string) $v;
    }

    private static function fd(): array
    {
        static $fd = null;
        if ($fd === null) {
            $fd = [];
            foreach (self::FAULT_DEPTS as $d) {
                $fd[$d['k']] = $d;
            }
        }
        return $fd;
    }

    private static function parseUtc($s): float
    {
        $s = (string) $s;
        $t = strtotime(str_replace(' ', 'T', $s).(str_contains($s, 'Z') ? '' : 'Z'));
        return $t === false ? NAN : (float) $t;
    }

    private static function utc(float $sec): string
    {
        return gmdate('Y-m-d H:i:s', (int) floor($sec));
    }

    /* ------------------------------------------------------------ shared helpers (closures in routes(ctx)) */

    private function sla(): array
    {
        $s = $this->setting('tickets.sla', []);
        return array_merge(self::DEF_SLA, is_array($s) ? $s : []);
    }

    private function dueFrom(float $fromSec, $pr): string
    {
        $h = self::num($this->sla()[$pr] ?? null);
        if (! self::tr($h)) {
            $h = 24;
        }
        return self::utc($fromSec + $h * 3600);
    }

    private function isApprover(?array $u): bool
    {
        return $this->can($u, 'finance') || ($u['role'] ?? null) === 'admin';
    }

    private function isAdminish(?array $u): bool
    {
        return $this->can($u, 'settings') || in_array($u['role'] ?? null, ['admin', 'manager'], true);
    }

    private function agents(): array
    {
        $out = [];
        foreach (Db::all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name') as $x) {
            $p = Access::userPerms($x);
            if (in_array('tickets', $p, true)) {
                $out[] = ['id' => $x['id'], 'name' => $x['name'], 'role' => $x['role'], 'tracking' => in_array('tracking', $p, true)];
            }
        }
        return $out;
    }

    private function sysNote($tid, $uid, string $body): void
    {
        Db::run("INSERT INTO tk_notes(ticket_id,user_id,kind,body) VALUES(?,?,'system',?)", $tid, $uid ?: null, $body);
    }

    private function touch($id): void
    {
        Db::run('UPDATE tk_tickets SET updated_at=UTC_TIMESTAMP() WHERE id=?', $id);
    }

    private function getT($id): array
    {
        $t = Db::get('SELECT * FROM tk_tickets WHERE id=?', (int) self::num($id));
        $this->need($t, 'Ticket not found', 404);
        return $t;
    }

    private function userName($id): string
    {
        if (! $id) {
            return 'nobody';
        }
        $n = Db::val('SELECT name FROM users WHERE id=?', $id);
        return self::tr($n) ? (string) $n : '#'.$id;
    }

    private function orderBrief(?array $o): ?array
    {
        if (! $o) {
            return null;
        }
        $c = Db::get('SELECT label, delivered, returned, orders, cancelled FROM customers WHERE phone=?', $o['phone']) ?? [];
        $items = Db::all('SELECT i.sku, i.title, i.qty, i.price, pr.size, pr.brand, pr.cond FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE i.order_id=?', $o['id']);
        return ['id' => $o['id'], 'name' => $o['name'], 'created_at' => $o['created_at'], 'cust_name' => $o['cust_name'], 'phone' => $o['phone'], 'city' => $o['city'], 'address' => $o['address'],
            'total' => $o['total'], 'status' => $o['status'], 'tracking' => $o['tracking'], 'px_status' => $o['px_status'], 'px_updated' => $o['px_updated'],
            'delivered_at' => $o['delivered_at'], 'clabel' => ($c['label'] ?? null) ?: 'New', 'cdel' => ($c['delivered'] ?? null) ?: 0, 'cret' => ($c['returned'] ?? null) ?: 0,
            'corders' => ($c['orders'] ?? null) ?: 0, 'items' => $items, 'wa' => Logic::waNumber($o['phone'])];
    }

    private function findOrders($term): array
    {
        $t = trim(self::tr($term) ? self::str($term) : '');
        if ($t === '') {
            return [];
        }
        $up = mb_strtoupper($t);
        $nm = preg_match('/^\d{3,7}$/', $t) ? 'SB'.$t : $up;
        $ph = Logic::normPhone($t);
        $usePh = strlen($ph) >= 10 && preg_match('/^[\d\s+\-]+$/', $t);
        $args = [$t, $nm, $t, $t];
        if ($usePh) {
            $args[] = $ph;
        }
        $rows = Db::all('SELECT * FROM orders WHERE name=? OR name=? OR tracking=? OR id=? '.($usePh ? 'OR phone=?' : '').' ORDER BY created_at DESC LIMIT 15', ...$args);
        return array_map(fn ($o) => $this->orderBrief($o), $rows);
    }

    private function findOrder($ref): ?array
    {
        if (! self::tr($ref)) {
            return null;
        }
        $s = self::str($ref);
        return Db::get('SELECT * FROM orders WHERE id=? OR name=?', $s, mb_strtoupper($s));
    }

    private function pkDay($s): string
    {
        if (! $s) {
            return '';
        }
        return gmdate('Y-m-d', (int) (self::parseUtc($s) + 5 * 3600));
    }

    /* ---------- whose mistake: suggestions from the data ---------- */
    private function faultSuggest(array $t): array
    {
        $out = array_fill_keys(self::INTERNAL, []);
        $add = function (string $dept, $uid, string $why) use (&$out) {
            if (! $uid) {
                return;
            }
            $uid = (int) $uid;
            foreach ($out[$dept] as &$x) {
                if ($x['user_id'] === $uid) {
                    if (! in_array($why, $x['why'], true)) {
                        $x['why'][] = $why;
                    }
                    return;
                }
            }
            unset($x);
            $out[$dept][] = ['user_id' => $uid, 'name' => $this->userName($uid), 'why' => [$why]];
        };
        $o = $t['order_id'] ? Db::get('SELECT * FROM orders WHERE id=?', $t['order_id']) : null;
        $items = $o ? Db::all('SELECT sku, picked_by, picked_at FROM order_items WHERE order_id=?', $o['id']) : [];
        $src = $t['sku'] ? [$t['sku']] : array_column($items, 'sku');
        $skus = [];
        foreach ($src as $s) {
            if (self::tr($s) && ! in_array((string) $s, $skus, true)) {
                $skus[] = (string) $s;
            }
        }
        $sl = Schema::hasTable('sl_items');
        $qc = Schema::hasTable('sl_qc');
        $so = Schema::hasTable('sl_sort');
        foreach ($skus as $sku) {
            $li = Db::get('SELECT user_id, at, lot FROM listings WHERE UPPER(sku)=UPPER(?)', $sku);
            if ($li && $li['user_id']) {
                $add('listing', $li['user_id'], "listed {$sku}".($li['at'] ? ' on '.$this->pkDay($li['at']) : ''));
            }
            $si = $sl ? Db::get('SELECT * FROM sl_items WHERE UPPER(sku)=UPPER(?)', $sku) : null;
            if ($si && ($si['listed_by'] ?? null) && ! ($li && $li['user_id'])) {
                $add('listing', $si['listed_by'], "listed {$sku}");
            }
            $lot = ($li['lot'] ?? null) ?: (($si['lot'] ?? null) ?: Db::val('SELECT lot FROM products WHERE UPPER(sku)=UPPER(?)', $sku));
            if ($lot && $qc) {
                foreach (Db::all('SELECT user_id, SUM(passed) n, MAX(at) at FROM sl_qc WHERE lot=? AND user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC', $lot) as $r) {
                    $add('sorting', $r['user_id'], "QC of lot {$lot}");
                }
            }
            if ($lot && $so) {
                $s = Db::get('SELECT sorted_by FROM sl_sort WHERE lot=?', $lot);
                if ($s && $s['sorted_by']) {
                    $add('sorting', $s['sorted_by'], "sorted lot {$lot}");
                }
            }
            $before = $o && ($o['picked_at'] || $o['packed_at']) ? ($o['picked_at'] ?: $o['packed_at']) : null;
            $mv = Db::get('SELECT user_id, to_loc, at FROM stock_moves WHERE UPPER(sku)=UPPER(?) AND user_id IS NOT NULL '.($before ? 'AND at<=?' : '').' ORDER BY at DESC, id DESC LIMIT 1', $sku, ...($before ? [$before] : []));
            if ($mv) {
                $add('warehouse', $mv['user_id'], "put {$sku} at ".($mv['to_loc'] ?: 'a rack'));
            } elseif ($si && ($si['located_by'] ?? null)) {
                $add('warehouse', $si['located_by'], trim("put {$sku} on rack ".(($si['location'] ?? null) ?: '')));
            }
            foreach ($items as $i) {
                if (mb_strtoupper((string) $i['sku']) === mb_strtoupper($sku) && $i['picked_by']) {
                    $add('dispatch', $i['picked_by'], "picked {$sku}");
                }
            }
        }
        if ($o) {
            foreach (Db::all("SELECT DISTINCT user_id FROM events WHERE entity=? AND action='pack' AND user_id IS NOT NULL", 'order:'.$o['id']) as $e) {
                $add('dispatch', $e['user_id'], "packed {$o['name']}");
            }
            foreach (Db::all("SELECT DISTINCT user_id FROM events WHERE entity=? AND action IN ('couriers.book','book') AND user_id IS NOT NULL", 'order:'.$o['id']) as $e) {
                $add('dispatch', $e['user_id'], "booked courier for {$o['name']}");
            }
            if ($o['cs_by']) {
                $add('cs', $o['cs_by'], "confirmed {$o['name']}");
            }
            foreach (Db::all('SELECT DISTINCT user_id FROM cs_calls WHERE order_id=? AND user_id IS NOT NULL ORDER BY at DESC LIMIT 3', $o['id']) as $c) {
                $add('cs', $c['user_id'], "called about {$o['name']}");
            }
        }
        foreach (self::INTERNAL as $k) {
            $out[$k] = array_map(fn ($c) => array_merge($c, ['why' => implode(', ', $c['why'])]), $out[$k]);
        }
        $dept = ($t['fault_dept'] ?? null) ?: (self::FAULT_GUESS[$t['type']] ?? null);
        $best = null;
        if ($dept) {
            $fd = self::fd()[$dept] ?? null;
            $best = ['dept' => $dept, 'user_id' => ($t['fault_user_id'] ?? null) ?: (($fd['internal'] ?? false) && ! empty($out[$dept][0]) ? $out[$dept][0]['user_id'] : null)];
        }
        return ['people' => $out, 'best' => $best, 'skus' => $skus, 'required' => in_array($t['type'], self::FAULT_TYPES, true)];
    }

    // validate + normalise the fault fields sent with resolve / close / fault update
    private function faultIn(array $t, array $b, bool $required): ?array
    {
        $dept = self::tr($b['fault_dept'] ?? null) ? $b['fault_dept'] : null;
        if (! $dept) {
            $this->need(! $required, 'Say whose mistake it was ("'.$t['type'].'" is a customer problem)');
            return null;
        }
        $fd = is_string($dept) ? (self::fd()[$dept] ?? null) : null;
        $this->need($fd, 'Unknown department');
        $fu = $b['fault_user_id'] ?? null;
        if ($fu === 'auto') {
            $uid = ($this->faultSuggest($t)['people'][$dept][0]['user_id'] ?? null) ?: null;
        } else {
            $uid = self::tr($fu) ? self::num($fu) : null;
        }
        if ($fd['internal']) {
            $this->need(self::tr($uid), "Pick the person in {$fd['l']} who made the mistake");
            $this->need(Db::get('SELECT id FROM users WHERE id=?', $uid), 'Unknown staff member');
        } else {
            $uid = null;
        }
        $fc = $b['fault_cost'] ?? null;
        $cost = $fc === '' || $fc === null ? null : self::num($fc);
        $this->need($cost === null || ($cost >= 0 && $cost < 1e7), 'Cost must be a number');
        $reason = mb_substr(self::tr($b['fault_reason'] ?? null) ? self::str($b['fault_reason']) : '', 0, 120);
        $note = mb_substr(self::tr($b['fault_note'] ?? null) ? self::str($b['fault_note']) : '', 0, 1000);
        return ['fault_dept' => $dept, 'fault_user_id' => $uid === null ? null : (int) $uid, 'fault_reason' => $reason !== '' ? $reason : null, 'fault_note' => $note !== '' ? $note : null, 'fault_cost' => $cost];
    }

    private function saveFault(array $t, ?array $f, $uid): void
    {
        if (! $f) {
            return;
        }
        Db::run('UPDATE tk_tickets SET fault_dept=?, fault_user_id=?, fault_reason=?, fault_note=?, fault_cost=?, fault_by=?, fault_at=UTC_TIMESTAMP() WHERE id=?',
            $f['fault_dept'], $f['fault_user_id'], $f['fault_reason'], $f['fault_note'], $f['fault_cost'], $uid ?: null, $t['id']);
        $this->sysNote($t['id'], $uid, 'Whose mistake: '.self::fd()[$f['fault_dept']]['l'].($f['fault_user_id'] ? ' · '.$this->userName($f['fault_user_id']) : '').($f['fault_reason'] ? ' · '.$f['fault_reason'] : ''));
        $this->log($uid ?: null, 'ticket.fault', $f['fault_user_id'] ? 'user:'.$f['fault_user_id'] : 'ticket:'.$t['id'], ['ticket' => $t['id'], 'dept' => $f['fault_dept'], 'reason' => $f['fault_reason'], 'cost' => $f['fault_cost']]);
    }

    // resolve (and optionally close) one ticket; b = { resolution, note, close, fault_* }
    private function resolveTicket(array $t, array $b, ?array $u, array $opts = []): void
    {
        $this->need(! in_array($t['status'], ['resolved', 'closed'], true) || (! empty($opts['closeResolved']) && $t['status'] === 'resolved'), 'Ticket is already '.$t['status']);
        if ($t['status'] === 'resolved') {
            $this->setStatus($t, 'closed', $u);
            $this->touch($t['id']);
            return;
        }
        $auto = ! empty($opts['auto']);
        $this->need(in_array($b['resolution'] ?? null, self::RESOLUTIONS, true), 'Pick how it was resolved');
        $f = $this->faultIn($t, $b, ! $auto && in_array($t['type'], self::FAULT_TYPES, true) && ! $t['fault_dept']);
        $close = self::tr($b['close'] ?? null);
        $st = $close ? 'closed' : 'resolved';
        $uid = $u ? $u['id'] : null;
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : '';
        Db::run('UPDATE tk_tickets SET status=?, resolution=?, resolution_note=?, resolved_at=UTC_TIMESTAMP(), closed_at='.($close ? 'UTC_TIMESTAMP()' : 'NULL').', resolved_by=?, first_response_at=COALESCE(first_response_at, UTC_TIMESTAMP()),
        assignee=COALESCE(assignee, ?), updated_at=UTC_TIMESTAMP() WHERE id=?', $st, $b['resolution'], mb_substr($note, 0, 2000), $uid, $auto ? null : $uid, $t['id']);
        $this->saveFault($t, $f, $uid);
        $this->sysNote($t['id'], $uid, ($auto ? 'Auto-resolved: ' : ($close ? 'Resolved & closed: ' : 'Resolved: ')).$b['resolution'].($note !== '' ? ' · '.$note : ''));
        $this->log($uid, $auto ? 'ticket.autoresolve' : 'ticket.resolve', 'ticket:'.$t['id'], ['resolution' => $b['resolution'], 'close' => $close, 'fault' => $f ? $f['fault_dept'] : null]);
    }

    private function closeNoFix(array $t, $b, array $u): void
    {
        $b = is_array($b) ? $b : [];
        $this->need(! in_array($t['status'], ['resolved', 'closed'], true), 'Ticket is already '.$t['status']);
        $reason = in_array($b['reason'] ?? null, self::NOFIX_REASONS, true) ? $b['reason'] : null;
        $this->need($reason, 'Pick why it is closed without a fix');
        $note = $reason.(self::tr($b['note'] ?? null) ? ' · '.mb_substr(self::str($b['note']), 0, 500) : '');
        Db::run("UPDATE tk_tickets SET status='closed', resolution=?, resolution_note=?, resolved_at=UTC_TIMESTAMP(), closed_at=UTC_TIMESTAMP(), resolved_by=?, updated_at=UTC_TIMESTAMP() WHERE id=?", self::NOFIX, $note, $u['id'], $t['id']);
        $this->sysNote($t['id'], $u['id'], 'Closed without fix: '.$note);
        $this->log($u['id'], 'ticket.close', 'ticket:'.$t['id'], ['reason' => $reason]);
    }

    // exchange completed / refund paid → resolve the parent ticket if it is still open
    private function autoResolveParent($tid, string $resolution, string $why, $uid, $fault = null): bool
    {
        $t = $tid ? Db::get('SELECT * FROM tk_tickets WHERE id=?', $tid) : null;
        if (! $t || in_array($t['status'], ['resolved', 'closed'], true)) {
            return false;
        }
        $f = null;
        try {
            if (is_array($fault) && self::tr($fault['fault_dept'] ?? null)) {
                $f = $this->faultIn($t, $fault, false);
            }
        } catch (\Throwable $e) {
            $this->sysNote($t['id'], $uid, 'Whose mistake not saved: '.$e->getMessage());
        }
        $this->resolveTicket($t, ['resolution' => $resolution, 'note' => 'Auto: '.$why], $uid ? ['id' => $uid] : null, ['auto' => true]);
        if ($f) {
            $this->saveFault($t, $f, $uid);
        }
        return true;
    }

    private function setStatus(array $t, string $st, ?array $u): void
    {
        $extra = $st === 'closed' ? ", closed_at=UTC_TIMESTAMP(), resolved_at=COALESCE(resolved_at, UTC_TIMESTAMP()), resolution=COALESCE(resolution, 'No action needed')" : '';
        Db::run("UPDATE tk_tickets SET status=?{$extra}, first_response_at=CASE WHEN ?='waiting' THEN COALESCE(first_response_at, UTC_TIMESTAMP()) ELSE first_response_at END WHERE id=?", $st, $st, $t['id']);
        $this->sysNote($t['id'], $u['id'] ?? null, 'Status: '.(self::STATUSES[$t['status']] ?? 'undefined').' → '.(self::STATUSES[$st] ?? 'undefined'));
        $this->log($u['id'] ?? null, 'ticket.status', 'ticket:'.$t['id'], ['from' => $t['status'], 'to' => $st]);
    }

    /* ---------- tickets ---------- */
    private function createTicket(array $b, $uid, array $opts = []): int
    {
        $this->need(in_array($b['type'] ?? null, self::TYPES, true), 'Pick a ticket type');
        $channel = in_array($b['channel'] ?? null, self::CHANNELS, true) ? $b['channel'] : 'WhatsApp';
        $pr = in_array($b['priority'] ?? null, self::PRIORITIES, true) ? $b['priority'] : 'normal';
        $ref = self::tr($b['order_id'] ?? null) ? $b['order_id'] : ($b['order_name'] ?? null);
        $o = $this->findOrder($ref);
        $this->need(! (self::tr($b['order_id'] ?? null) || self::tr($b['order_name'] ?? null)) || $o, 'Order not found');
        $phRaw = self::tr($b['phone'] ?? null) ? $b['phone'] : (($o['phone'] ?? null) ?: '');
        $phone = Logic::normPhone($phRaw);
        $this->need($phone !== '' || $o, 'Add the customer phone number or link an order');
        $assignee = self::tr($b['assignee'] ?? null) ? (int) self::num($b['assignee']) : null;
        if ($assignee) {
            $this->need(Db::get('SELECT id FROM users WHERE id=? AND active=1', $assignee), 'Unknown staff member');
        }
        $sku = self::tr($b['sku'] ?? null) ? $b['sku'] : null;
        if (! $sku && $o) {
            $its = Db::all('SELECT sku FROM order_items WHERE order_id=?', $o['id']);
            if (count($its) === 1) {
                $sku = $its[0]['sku'];
            }
        }
        $subject = mb_substr(trim(self::tr($b['subject'] ?? null) ? self::str($b['subject']) : ''), 0, 200);
        if ($subject === '') {
            $subject = $b['type'].($o ? ' · '.$o['name'] : '');
        }
        $custName = mb_substr((string) (self::tr($b['cust_name'] ?? null) ? self::str($b['cust_name']) : (($o['cust_name'] ?? null) ?: '')), 0, 120);
        $tracking = ($o['tracking'] ?? null) ?: (self::tr($b['tracking'] ?? null) ? $b['tracking'] : null);
        $files = $b['files'] ?? null;
        $id = Db::tx(function () use ($b, $channel, $subject, $o, $phone, $custName, $tracking, $sku, $pr, $assignee, $opts, $uid, $files) {
            $r = Db::run("INSERT INTO tk_tickets(type,channel,subject,order_id,order_name,phone,cust_name,tracking,sku,priority,assignee,status,auto,created_by,due_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)",
                $b['type'], $channel, $subject, $o ? $o['id'] : null, $o ? $o['name'] : null, $phone, $custName, $tracking, $sku, $pr, $assignee, ! empty($opts['auto']) ? 1 : 0, $uid ?: null, $this->dueFrom(microtime(true), $pr));
            $tid = $r->lastInsertRowid;
            $hasFiles = (is_array($files) && count($files)) || (is_string($files) && $files !== '');
            if (self::tr($b['note'] ?? null) || $hasFiles) {
                Db::run("INSERT INTO tk_notes(ticket_id,user_id,kind,body,files) VALUES(?,?,'note',?,?)", $tid, $uid ?: null, self::tr($b['note'] ?? null) ? self::str($b['note']) : '',
                    json_encode(self::tr($files) ? $files : [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            }
            return $tid;
        });
        $this->log($uid ?: null, 'ticket.create', 'ticket:'.$id, ['type' => $b['type'], 'order' => $o ? $o['name'] : null, 'auto' => ! empty($opts['auto'])]);
        return $id;
    }

    private function listWhere(array $qs, array $u): array
    {
        $w = [];
        $a = [];
        $v = self::tr($qs['view'] ?? null) ? $qs['view'] : 'mine';
        if ($v === 'mine') {
            $w[] = 't.assignee=? AND t.status IN '.self::OPEN;
            $a[] = $u['id'];
        } elseif ($v === 'unassigned') {
            $w[] = 't.assignee IS NULL AND t.status IN '.self::OPEN;
        } elseif ($v === 'overdue') {
            $w[] = "t.status IN ('open','progress') AND t.due_at<UTC_TIMESTAMP()";
        } elseif ($v === 'waiting') {
            $w[] = "t.status='waiting'";
        } elseif ($v === 'open') {
            $w[] = 't.status IN '.self::OPEN;
        } elseif ($v === 'done') {
            $w[] = "t.status IN ('resolved','closed')";
        } elseif ($v === 'nofault') {
            $w[] = "t.status IN ('resolved','closed') AND t.fault_dept IS NULL AND t.type IN (".Db::marks(self::FAULT_TYPES).") AND COALESCE(t.resolution,'')<>'".self::NOFIX."'";
            array_push($a, ...self::FAULT_TYPES);
        }
        if (self::tr($qs['fault_dept'] ?? null)) {
            $w[] = 't.fault_dept=?';
            $a[] = $qs['fault_dept'];
        }
        if (self::tr($qs['fault_user'] ?? null)) {
            $w[] = 't.fault_user_id=?';
            $a[] = self::num($qs['fault_user']);
        }
        if (self::tr($qs['month'] ?? null) && is_string($qs['month']) && preg_match('/^\d{4}-\d{2}$/', $qs['month'])) {
            $w[] = "DATE_FORMAT(t.resolved_at + INTERVAL 5 HOUR,'%Y-%m')=?";
            $a[] = $qs['month'];
        }
        foreach (['type', 'channel', 'priority', 'status'] as $k) {
            if (self::tr($qs[$k] ?? null)) {
                $w[] = "t.{$k}=?";
                $a[] = $qs[$k];
            }
        }
        if (self::tr($qs['assignee'] ?? null)) {
            if ($qs['assignee'] === 'none') {
                $w[] = 't.assignee IS NULL';
            } else {
                $w[] = 't.assignee=?';
                $a[] = self::num($qs['assignee']);
            }
        }
        if (self::tr($qs['q'] ?? null)) {
            $s = trim(self::str($qs['q']));
            $t = '%'.$s.'%';
            $ph = Logic::normPhone($s);
            if (preg_match('/^t-?(\d+)$/i', $s, $idm)) {
                $w[] = 't.id=?';
                $a[] = (int) $idm[1];
            } else {
                $w[] = '(t.subject LIKE ? OR t.cust_name LIKE ? OR t.order_name LIKE ? OR t.tracking LIKE ? OR t.sku LIKE ?'.(strlen($ph) >= 7 ? ' OR t.phone LIKE ?' : '').')';
                array_push($a, $t, $t, $t, $t, $t);
                if (strlen($ph) >= 7) {
                    $a[] = '%'.$ph.'%';
                }
            }
        }
        return ['where' => $w ? 'WHERE '.implode(' AND ', $w) : '', 'args' => $a];
    }

    /* ------------------------------------------------------------ routes: tickets */

    public function meta(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['types' => self::TYPES, 'channels' => self::CHANNELS, 'priorities' => self::PRIORITIES, 'statuses' => self::STATUSES, 'resolutions' => self::RESOLUTIONS, 'steps' => self::STEP_L,
            'methods' => self::METHODS, 'agents' => $this->agents(), 'sla' => $this->sla(), 'faultDepts' => self::FAULT_DEPTS, 'faultTypes' => self::FAULT_TYPES, 'nofixReasons' => self::NOFIX_REASONS,
            'staff' => Db::all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'), 'templates' => $this->setting('tickets.templates', self::DEF_TEMPLATES),
            'auto' => $this->setting('tickets.auto_attempted', true), 'canApprove' => $this->isApprover($u), 'canSettings' => $this->isAdminish($u)];
    }

    public function ticketsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $f = $this->listWhere($qs, $u);
        $pg = $this->page($qs, 50);
        $view = $qs['view'] ?? null;
        $order = $view === 'all' || $view === 'done' ? 't.id DESC' : "overdue DESC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at";
        $rows = Db::all('SELECT '.self::T_COLS." FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee LEFT JOIN users fu ON fu.id=t.fault_user_id LEFT JOIN customers c ON c.phone=t.phone {$f['where']} ORDER BY {$order} LIMIT ? OFFSET ?",
            ...[...$f['args'], $pg['limit'], $pg['offset']]);
        $total = (int) Db::val("SELECT COUNT(*) n FROM tk_tickets t {$f['where']}", ...$f['args']);
        $counts = Db::get('SELECT SUM(assignee=? AND status IN '.self::OPEN.') mine, SUM(assignee IS NULL AND status IN '.self::OPEN.") unassigned, SUM(status IN ('open','progress') AND due_at<UTC_TIMESTAMP()) overdue,
        SUM(status='waiting') waiting, SUM(status IN ".self::OPEN.") `open`, COUNT(*) total,
        SUM(status IN ('resolved','closed') AND fault_dept IS NULL AND type IN (".Db::marks(self::FAULT_TYPES).") AND COALESCE(resolution,'')<>'".self::NOFIX."') nofault FROM tk_tickets", $u['id'], ...self::FAULT_TYPES);
        foreach ($counts as $k => $v) {
            $counts[$k] = $v ?: 0;
        }
        return ['rows' => $rows, 'total' => $total, 'page' => $pg['page'], 'pages' => (int) ceil($total / $pg['limit']), 'counts' => $counts];
    }

    public function lookup(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['orders' => $this->findOrders($qs['q'] ?? null)];
    }

    public function ticketCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['id' => $this->createTicket($b, $u['id'])];
    }

    public function bulk(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = array_values(array_filter(array_map(fn ($x) => self::num($x), is_array($b['ids'] ?? null) ? $b['ids'] : []), fn ($x) => self::tr($x)));
        $this->need(count($ids), 'Select tickets first');
        $hasAssignee = array_key_exists('assignee', $b);
        $assignee = null;
        if ($hasAssignee) {
            $assignee = self::tr($b['assignee']) ? (int) self::num($b['assignee']) : null;
            if ($assignee) {
                $this->need(Db::get('SELECT id FROM users WHERE id=? AND active=1', $assignee), 'Unknown staff member');
            }
        }
        $bst = $b['status'] ?? null;
        if (self::tr($bst)) {
            $this->need(in_array($bst, ['open', 'waiting', 'progress', 'closed'], true), 'Use Resolve to resolve tickets');
        }
        $skipped = [];
        $errors = [];
        Db::tx(function () use ($ids, $hasAssignee, $assignee, $b, $bst, $u, &$skipped, &$errors) {
            foreach ($ids as $id) {
                $t = Db::get('SELECT * FROM tk_tickets WHERE id=?', $id);
                if (! $t) {
                    continue;
                }
                if ($hasAssignee && $t['assignee'] !== $assignee) {
                    Db::run('UPDATE tk_tickets SET assignee=? WHERE id=?', $assignee, $id);
                    $this->sysNote($id, $u['id'], 'Assigned to '.$this->userName($assignee));
                    $this->log($u['id'], 'ticket.assign', 'ticket:'.$id, ['to' => $assignee, 'bulk' => true]);
                }
                if (self::tr($b['resolve'] ?? null)) { // bulk "Resolve & close": same resolution + whose mistake for all (person 'auto' = each ticket's suggested person)
                    $res = is_array($b['resolve']) ? $b['resolve'] : [];
                    if (in_array($t['status'], ['resolved', 'closed'], true)) {
                        if ($t['status'] === 'resolved' && self::tr($res['close'] ?? null)) {
                            $this->setStatus($t, 'closed', $u);
                        }
                    } else {
                        try {
                            $this->resolveTicket($t, $res, $u);
                        } catch (\Throwable $e) {
                            $skipped[] = $id;
                            $errors[] = "T-{$id}: ".$e->getMessage();
                            continue;
                        }
                    }
                } elseif (self::tr($b['nofix'] ?? null)) {
                    if (! in_array($t['status'], ['resolved', 'closed'], true)) {
                        $this->closeNoFix($t, $b['nofix'], $u);
                    }
                } elseif (self::tr($bst) && $t['status'] !== $bst) {
                    if (in_array($t['status'], ['resolved', 'closed'], true) && $bst !== 'closed') {
                        $skipped[] = $id;
                        continue;
                    }
                    if ($bst === 'closed' && $t['status'] !== 'resolved' && in_array($t['type'], self::FAULT_TYPES, true) && ! $t['fault_dept']) {
                        $skipped[] = $id;
                        continue;
                    }
                    $this->setStatus($t, $bst, $u);
                }
                $this->touch($id);
            }
        });
        return ['ok' => true, 'n' => count($ids) - count($skipped), 'skipped' => $skipped, 'errors' => $errors];
    }

    /* customer 360 */
    public function customer360(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ph = Logic::normPhone($p['phone'] ?? '');
        $this->need($ph !== '', 'No phone number');
        $orders = Db::all("SELECT o.id,o.name,o.created_at,o.total,o.status,o.tracking,o.city,(SELECT GROUP_CONCAT(CONCAT(title, ' (', sku, ')') SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o WHERE o.phone=? ORDER BY o.created_at DESC LIMIT 100", $ph);
        $credit = Db::val("SELECT COALESCE(SUM(amount),0) n FROM tk_refunds WHERE phone=? AND method='Store credit' AND status IN ('approved','paid')", $ph);
        return [
            'phone' => $ph, 'wa' => Logic::waNumber($ph), 'customer' => Db::get('SELECT * FROM customers WHERE phone=?', $ph), 'flag' => Db::get('SELECT * FROM customer_flags WHERE phone=?', $ph), 'orders' => $orders,
            'returns' => Db::all('SELECT r.*, o.name order_name FROM `returns` r JOIN orders o ON o.id=r.order_id WHERE o.phone=? ORDER BY r.id DESC LIMIT 50', $ph),
            'tickets' => Db::all('SELECT t.id,t.type,t.status,t.subject,t.created_at,t.order_name,t.resolution,us.name assignee_name FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee WHERE t.phone=? ORDER BY t.id DESC LIMIT 50', $ph),
            'exchanges' => Db::all('SELECT id,step,order_name,diff,created_at FROM tk_exchanges WHERE phone=? ORDER BY id DESC LIMIT 50', $ph),
            'refunds' => Db::all('SELECT id,method,amount,status,created_at,order_name FROM tk_refunds WHERE phone=? ORDER BY id DESC LIMIT 50', $ph), 'storeCredit' => $credit,
        ];
    }

    /* settings */
    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['sla' => $this->sla(), 'templates' => $this->setting('tickets.templates', self::DEF_TEMPLATES), 'auto' => $this->setting('tickets.auto_attempted', true)];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isAdminish($u), 'Only the owner or a manager can change ticket settings', 403);
        if (self::tr($b['sla'] ?? null)) {
            $s = [];
            foreach (self::PRIORITIES as $k) {
                $v = self::num(is_array($b['sla']) ? ($b['sla'][$k] ?? null) : null);
                $this->need($v > 0 && $v <= 720, 'SLA hours must be between 1 and 720');
                $s[$k] = $v;
            }
            $this->setSetting('tickets.sla', $s);
        }
        if (is_array($b['templates'] ?? null) && array_is_list($b['templates'])) {
            $out = [];
            foreach ($b['templates'] as $t) {
                if (is_array($t) && self::tr($t['name'] ?? null) && self::tr($t['text'] ?? null)) {
                    $out[] = ['name' => mb_substr(self::str($t['name']), 0, 60), 'text' => mb_substr(self::str($t['text']), 0, 1000)];
                }
            }
            $this->setSetting('tickets.templates', $out);
        }
        if (array_key_exists('auto', $b)) {
            $this->setSetting('tickets.auto_attempted', self::tr($b['auto']));
        }
        $this->log($u['id'], 'settings.save', 'tickets', array_keys($b));
        return ['ok' => true];
    }

    /* delivery follow-ups */
    private function autoAttempted(): array
    {
        $out = ['created' => 0, 'resolved' => 0];
        // auto-resolve auto tickets whose order got delivered / returned
        foreach (Db::all('SELECT t.id, o.status ost FROM tk_tickets t JOIN orders o ON o.id=t.order_id WHERE t.auto=1 AND t.status IN '.self::OPEN." AND o.status IN ('delivered','returned','return_received')") as $t) {
            $res = $t['ost'] === 'delivered' ? 'Re-delivery arranged' : 'Customer cancelled';
            $st = preg_replace('/_/', ' ', $t['ost'], 1);
            Db::run("UPDATE tk_tickets SET status='resolved', resolution=?, resolution_note=?, resolved_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?", $res, 'Auto: order is now '.$st, $t['id']);
            $this->sysNote($t['id'], null, 'Auto-resolved: order is now '.$st);
            $this->log(null, 'ticket.autoresolve', 'ticket:'.$t['id'], $t['ost']);
            $out['resolved']++;
        }
        if (! self::tr($this->setting('tickets.auto_attempted', true))) {
            return $out;
        }
        $orders = Db::all("SELECT o.* FROM orders o WHERE o.status='attempted'
        AND NOT EXISTS (SELECT 1 FROM tk_tickets t WHERE t.order_id=o.id AND t.status IN ".self::OPEN.")
        AND NOT EXISTS (SELECT 1 FROM tk_tickets t WHERE t.order_id=o.id AND t.auto=1 AND DATE_FORMAT(t.resolved_at,'%Y-%m-%d %H:%i:%s') >= REPLACE(SUBSTR(COALESCE(o.px_updated,''),1,19),'T',' '))
        ORDER BY o.px_updated");
        if (! $orders) {
            return $out;
        }
        $pool = array_values(array_filter($this->agents(), fn ($a) => $a['tracking'] && $a['role'] !== 'admin'));
        if (! $pool) {
            $pool = array_values(array_filter($this->agents(), fn ($a) => $a['tracking']));
        }
        usort($pool, fn ($a, $b) => $a['id'] <=> $b['id']);
        $last = self::num($this->setting('tickets.rr_last', 0));
        if (! self::tr($last)) {
            $last = 0;
        }
        foreach ($orders as $o) {
            $assignee = null;
            if ($pool) {
                $i = -1;
                foreach ($pool as $ix => $a) {
                    if ($a['id'] > $last) {
                        $i = $ix;
                        break;
                    }
                }
                $a = $pool[$i >= 0 ? $i : 0];
                $assignee = $a['id'];
                $last = $a['id'];
            }
            $this->createTicket(['type' => 'Delivery issue', 'channel' => 'Call', 'order_id' => $o['id'], 'priority' => 'high', 'assignee' => $assignee, 'subject' => "Delivery attempted · {$o['name']}",
                'note' => 'PostEx: '.($o['px_status'] ?: 'attempted').'. Call the customer and arrange re-delivery.'], null, ['auto' => true]);
            $out['created']++;
        }
        $this->setSetting('tickets.rr_last', $last);
        return $out;
    }

    public function autoRun(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $r = $this->autoAttempted();
        $this->log($u['id'], 'ticket.autorun', 'tickets', $r);
        return $r;
    }

    /* reports */
    public function report(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $d = self::num($qs['days'] ?? null);
        $days = min(365, max(7, self::tr($d) ? $d : 30));
        $secs = (int) round($days * 86400);
        $since = "(UTC_TIMESTAMP() - INTERVAL {$secs} SECOND)";
        $W = "created_at>={$since}";
        $byType = Db::all("SELECT type k, COUNT(*) n, SUM(status IN ('resolved','closed')) done FROM tk_tickets WHERE {$W} GROUP BY type ORDER BY n DESC");
        $byChannel = Db::all("SELECT channel k, COUNT(*) n FROM tk_tickets WHERE {$W} GROUP BY channel ORDER BY n DESC");
        $byAgent = Db::all("SELECT COALESCE(us.name,'Unassigned') k, COUNT(*) n, SUM(t.status IN ('resolved','closed')) done, SUM(t.status IN ".self::OPEN.") `open`,
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, t.created_at, t.resolved_at)/3600 END),1) avg_res,
        SUM(t.status IN ('open','progress') AND t.due_at<UTC_TIMESTAMP()) overdue FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee WHERE t.{$W} GROUP BY t.assignee ORDER BY n DESC");
        $opened = Db::all("SELECT DATE_FORMAT(created_at + INTERVAL 5 HOUR,'%Y-%m-%d') d, COUNT(*) n FROM tk_tickets WHERE {$W} GROUP BY d");
        $resolved = Db::all("SELECT DATE_FORMAT(resolved_at + INTERVAL 5 HOUR,'%Y-%m-%d') d, COUNT(*) n FROM tk_tickets WHERE resolved_at>={$since} GROUP BY d");
        $om = array_column($opened, 'n', 'd');
        $rm = array_column($resolved, 'n', 'd');
        $perDay = [];
        for ($i = min($days, 30) - 1; $i >= 0; $i--) {
            $day = gmdate('Y-m-d', (int) floor(time() + 5 * 3600 - $i * 86400));
            $perDay[] = ['day' => $day, 'opened' => $om[$day] ?? 0, 'resolved' => $rm[$day] ?? 0];
        }
        $times = Db::get("SELECT ROUND(AVG(CASE WHEN first_response_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, created_at, first_response_at)/3600 END),1) frt,
        ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, created_at, resolved_at)/3600 END),1) res,
        SUM((resolved_at IS NOT NULL AND resolved_at>due_at) OR (resolved_at IS NULL AND status IN ('open','progress') AND due_at<UTC_TIMESTAMP())) breaches, COUNT(*) total,
        SUM(status IN ".self::OPEN.") `open` FROM tk_tickets WHERE {$W}");
        $m = substr($this->pkToday(), 0, 7);
        $ex = Db::get("SELECT COUNT(*) n, SUM(step='completed') done, SUM(step NOT IN ('completed','cancelled')) `open`, COALESCE(SUM(CASE WHEN diff>0 AND step<>'cancelled' THEN diff END),0) extra,
        COALESCE(SUM(CASE WHEN diff<0 AND step<>'cancelled' THEN -diff END),0) back FROM tk_exchanges WHERE DATE_FORMAT(created_at + INTERVAL 5 HOUR,'%Y-%m')=?", $m);
        $rf = Db::get("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status IN ('approved','paid') THEN amount END),0) approved, COALESCE(SUM(CASE WHEN status='paid' AND method<>'Store credit' THEN amount END),0) paid,
        COALESCE(SUM(CASE WHEN status IN ('approved','paid') AND method='Store credit' THEN amount END),0) credit, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending FROM tk_refunds WHERE DATE_FORMAT(created_at + INTERVAL 5 HOUR,'%Y-%m')=?", $m);
        // problem SKUs: ticket sku, or every item on the linked order
        $probs = array_filter(Db::all("SELECT COALESCE(t.sku, i.sku) sku, t.type FROM tk_tickets t LEFT JOIN order_items i ON t.sku IS NULL AND i.order_id=t.order_id
        WHERE t.{$W} AND t.type IN ('Wrong item','Damaged / not as described')"), fn ($r) => self::tr($r['sku']));
        $skuMap = [];
        $brandMap = [];
        foreach ($probs as $r) {
            $pr = Db::get('SELECT title, brand FROM products WHERE UPPER(sku)=UPPER(?)', $r['sku']) ?? [];
            $key = 'k'.$r['sku'];
            if (! isset($skuMap[$key])) {
                $skuMap[$key] = ['sku' => $r['sku'], 'title' => ($pr['title'] ?? null) ?: '', 'brand' => ($pr['brand'] ?? null) ?: '', 'wrong' => 0, 'damaged' => 0, 'n' => 0];
            }
            $skuMap[$key]['n']++;
            if ($r['type'] === 'Wrong item') {
                $skuMap[$key]['wrong']++;
            } else {
                $skuMap[$key]['damaged']++;
            }
            $bk = 'k'.(($pr['brand'] ?? null) ?: 'Unknown');
            $brandMap[$bk] = ($brandMap[$bk] ?? 0) + 1;
        }
        $FW = "t.resolved_at>={$since} AND t.status IN ('resolved','closed') AND t.fault_dept IS NOT NULL";
        $fd = self::fd();
        $byFault = array_map(fn ($r) => array_merge($r, ['label' => $fd[$r['k']]['l'] ?? $r['k'], 'internal' => (bool) ($fd[$r['k']]['internal'] ?? false),
            'reasons' => Db::all("SELECT COALESCE(fault_reason,'(no reason)') k, COUNT(*) n FROM tk_tickets t WHERE {$FW} AND t.fault_dept=? GROUP BY 1 ORDER BY n DESC LIMIT 3", $r['k'])]),
            Db::all("SELECT t.fault_dept k, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost, COUNT(DISTINCT t.fault_user_id) people FROM tk_tickets t WHERE {$FW} GROUP BY t.fault_dept ORDER BY n DESC"));
        $byFaultPerson = array_map(fn ($r) => array_merge($r, ['deptLabel' => $fd[$r['dept']]['l'] ?? $r['dept'], 'ids' => array_slice(array_map(fn ($x) => self::num($x), explode(',', (string) ($r['ids'] ?? ''))), -10)]),
            Db::all("SELECT t.fault_user_id id, us.name k, t.fault_dept dept, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost, GROUP_CONCAT(t.id) ids FROM tk_tickets t LEFT JOIN users us ON us.id=t.fault_user_id
        WHERE {$FW} AND t.fault_user_id IS NOT NULL GROUP BY t.fault_user_id, t.fault_dept ORDER BY n DESC LIMIT 30"));
        $noFault = (int) Db::val("SELECT COUNT(*) n FROM tk_tickets t WHERE t.resolved_at>={$since} AND t.status IN ('resolved','closed') AND t.fault_dept IS NULL AND t.type IN (".Db::marks(self::FAULT_TYPES).") AND COALESCE(t.resolution,'')<>'".self::NOFIX."'", ...self::FAULT_TYPES);
        $top = array_values($skuMap);
        usort($top, fn ($a, $b) => $b['n'] <=> $a['n']);
        $brands = [];
        foreach ($brandMap as $k => $n) {
            $brands[] = ['k' => substr($k, 1), 'n' => $n];
        }
        usort($brands, fn ($a, $b) => $b['n'] <=> $a['n']);
        return ['days' => $days, 'byType' => $byType, 'byChannel' => $byChannel, 'byAgent' => $byAgent, 'perDay' => $perDay, 'byFault' => $byFault, 'byFaultPerson' => $byFaultPerson,
            'noFault' => $noFault, 'times' => $times, 'exchanges' => $ex, 'refunds' => $rf, 'month' => $m,
            'topSkus' => array_slice($top, 0, 15), 'topBrands' => array_slice($brands, 0, 10)];
    }

    public function ticketGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = Db::get('SELECT '.self::T_COLS.' FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee LEFT JOIN users fu ON fu.id=t.fault_user_id LEFT JOIN customers c ON c.phone=t.phone WHERE t.id=?', (int) self::num($p['id']));
        $this->need($t, 'Ticket not found', 404);
        $notes = array_map(fn ($n) => array_merge($n, ['files' => $this->J($n['files'], [])]),
            Db::all('SELECT n.*, us.name `user` FROM tk_notes n LEFT JOIN users us ON us.id=n.user_id WHERE ticket_id=? ORDER BY n.id', $t['id']));
        $order = $this->orderBrief($t['order_id'] ? Db::get('SELECT * FROM orders WHERE id=?', $t['order_id']) : null);
        $flag = $t['phone'] ? Db::get('SELECT blacklist, vip, note FROM customer_flags WHERE phone=?', $t['phone']) : null;
        $prev = $t['phone'] ? Db::all('SELECT id,type,status,created_at,order_name FROM tk_tickets WHERE phone=? AND id<>? ORDER BY id DESC LIMIT 10', $t['phone'], $t['id']) : [];
        $exchanges = Db::all('SELECT id, step, diff, created_at FROM tk_exchanges WHERE ticket_id=? ORDER BY id DESC', $t['id']);
        $refunds = Db::all('SELECT id, method, amount, status, created_at FROM tk_refunds WHERE ticket_id=? ORDER BY id DESC', $t['id']);
        return ['ticket' => $t, 'notes' => $notes, 'order' => $order, 'flag' => $flag, 'prev' => $prev, 'exchanges' => $exchanges, 'refunds' => $refunds, 'wa' => $t['phone'] ? Logic::waNumber($t['phone']) : ''];
    }

    public function ticketUpdate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        Db::tx(function () use ($t, $b, $u) {
            $ch = [];
            if (self::tr($b['priority'] ?? null) && $b['priority'] !== $t['priority']) {
                $this->need(in_array($b['priority'], self::PRIORITIES, true), 'Unknown priority');
                Db::run('UPDATE tk_tickets SET priority=?, due_at=? WHERE id=?', $b['priority'], $this->dueFrom(self::parseUtc($t['created_at']), $b['priority']), $t['id']);
                $ch[] = "Priority: {$t['priority']} → {$b['priority']}";
            }
            if (array_key_exists('assignee', $b)) {
                $a = self::tr($b['assignee']) ? (int) self::num($b['assignee']) : null;
                if ($a !== $t['assignee']) {
                    if ($a) {
                        $this->need(Db::get('SELECT id FROM users WHERE id=? AND active=1', $a), 'Unknown staff member');
                    }
                    Db::run('UPDATE tk_tickets SET assignee=? WHERE id=?', $a, $t['id']);
                    $ch[] = 'Assigned to '.$this->userName($a);
                    $this->log($u['id'], 'ticket.assign', 'ticket:'.$t['id'], ['to' => $a]);
                }
            }
            if (self::tr($b['type'] ?? null) && $b['type'] !== $t['type']) {
                $this->need(in_array($b['type'], self::TYPES, true), 'Unknown type');
                Db::run('UPDATE tk_tickets SET type=? WHERE id=?', $b['type'], $t['id']);
                $ch[] = 'Type: '.$b['type'];
            }
            if (self::tr($b['channel'] ?? null) && $b['channel'] !== $t['channel']) {
                $this->need(in_array($b['channel'], self::CHANNELS, true), 'Unknown channel');
                Db::run('UPDATE tk_tickets SET channel=? WHERE id=?', $b['channel'], $t['id']);
            }
            if (isset($b['subject']) && $b['subject'] !== $t['subject']) {
                Db::run('UPDATE tk_tickets SET subject=? WHERE id=?', mb_substr(self::str($b['subject']), 0, 200), $t['id']);
            }
            if (array_key_exists('sku', $b) && $b['sku'] !== $t['sku']) {
                Db::run('UPDATE tk_tickets SET sku=? WHERE id=?', self::tr($b['sku']) ? $b['sku'] : null, $t['id']);
            }
            if (isset($b['cust_name']) && $b['cust_name'] !== $t['cust_name']) {
                Db::run('UPDATE tk_tickets SET cust_name=? WHERE id=?', mb_substr(self::str($b['cust_name']), 0, 120), $t['id']);
            }
            if (array_key_exists('order_id', $b) && $b['order_id'] !== $t['order_id']) {
                $o = $this->findOrder($b['order_id']);
                $this->need(! self::tr($b['order_id']) || $o, 'Order not found');
                Db::run("UPDATE tk_tickets SET order_id=?, order_name=?, tracking=?, phone=COALESCE(NULLIF(phone,''),?), cust_name=COALESCE(NULLIF(cust_name,''),?) WHERE id=?",
                    $o['id'] ?? null, $o['name'] ?? null, $o['tracking'] ?? null, $o['phone'] ?? null, $o['cust_name'] ?? null, $t['id']);
                $ch[] = $o ? 'Linked order '.$o['name'] : 'Order unlinked';
            }
            $bst = $b['status'] ?? null;
            if (self::tr($bst) && $bst !== $t['status']) {
                $this->need(in_array($bst, ['open', 'waiting', 'progress', 'closed'], true), 'Use Resolve or Reopen for that');
                $this->need(! in_array($t['status'], ['resolved', 'closed'], true) || $bst === 'closed', 'Reopen the ticket first');
                $this->need(! ($bst === 'closed' && $t['status'] !== 'resolved' && in_array($t['type'], self::FAULT_TYPES, true) && ! $t['fault_dept']), 'Use "Resolve & close" and say whose mistake it was');
                $this->setStatus($t, $bst, $u);
            }
            if ($ch) {
                $this->sysNote($t['id'], $u['id'], implode(' · ', $ch));
            }
            $this->touch($t['id']);
        });
        return ['ok' => true];
    }

    public function ticketNote(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        $kind = ($b['kind'] ?? null) === 'message' ? 'message' : 'note';
        $files = [];
        if (is_array($b['files'] ?? null) && array_is_list($b['files'])) {
            foreach ($b['files'] as $f) {
                if (self::tr($f)) {
                    $files[] = self::str($f);
                }
            }
            $files = array_slice($files, 0, 10);
        }
        $body = self::tr($b['body'] ?? null) ? self::str($b['body']) : '';
        $this->need(trim($body) !== '' || count($files), 'Write something first');
        Db::run('INSERT INTO tk_notes(ticket_id,user_id,kind,body,files) VALUES(?,?,?,?,?)', $t['id'], $u['id'], $kind, mb_substr($body, 0, 4000), json_encode($files, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        $wait = self::tr($b['wait'] ?? null);
        if ($kind === 'message') {
            Db::run("UPDATE tk_tickets SET first_response_at=COALESCE(first_response_at, UTC_TIMESTAMP()), status=CASE WHEN status='open' AND ?=1 THEN 'waiting' ELSE status END WHERE id=?", $wait ? 1 : 0, $t['id']);
        }
        if ($kind === 'message' && $t['status'] === 'open' && ! $wait && ! $t['assignee']) {
            Db::run('UPDATE tk_tickets SET assignee=? WHERE id=?', $u['id'], $t['id']);
        }
        $this->touch($t['id']);
        $this->log($u['id'], $kind === 'message' ? 'ticket.reply' : 'ticket.note', 'ticket:'.$t['id'], ['channel' => self::tr($b['channel'] ?? null) ? $b['channel'] : $t['channel']]);
        return ['ok' => true];
    }

    public function ticketResolve(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        $this->need(! in_array($t['status'], ['resolved', 'closed'], true), 'Ticket is already resolved');
        Db::tx(fn () => $this->resolveTicket($t, $b, $u));
        return ['ok' => true];
    }

    public function ticketClose(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        if ($t['status'] === 'resolved') {
            Db::tx(function () use ($t, $u) {
                $this->setStatus($t, 'closed', $u);
                $this->touch($t['id']);
            });
            return ['ok' => true];
        }
        Db::tx(fn () => $this->closeNoFix($t, $b, $u));
        return ['ok' => true];
    }

    public function faultGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->faultSuggest($this->getT($p['id']));
    }

    public function faultSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        $this->need(in_array($t['status'], ['resolved', 'closed'], true), 'Resolve the ticket first (whose mistake is asked there)');
        $f = $this->faultIn($t, $b, true);
        Db::tx(function () use ($t, $f, $u) {
            $this->saveFault($t, $f, $u['id']);
            $this->touch($t['id']);
        });
        return ['ok' => true];
    }

    public function ticketReopen(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->getT($p['id']);
        $this->need(in_array($t['status'], ['resolved', 'closed'], true), 'Ticket is still open');
        Db::run("UPDATE tk_tickets SET status='open', resolved_at=NULL, closed_at=NULL, resolution=NULL, resolution_note=NULL, reopened=reopened+1, due_at=?, updated_at=UTC_TIMESTAMP() WHERE id=?", $this->dueFrom(microtime(true), $t['priority']), $t['id']);
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : '';
        $this->sysNote($t['id'], $u['id'], 'Reopened'.($note !== '' ? ': '.$note : ''));
        $this->log($u['id'], 'ticket.reopen', 'ticket:'.$t['id'], self::tr($b['note'] ?? null) ? $b['note'] : '');
        return ['ok' => true];
    }

    /* ---------- exchanges ---------- */
    private function exItems($id): array
    {
        return Db::all('SELECT * FROM tk_exchange_items WHERE exchange_id=? ORDER BY id', $id);
    }

    private function reservedElsewhere($sku, $exceptId = null): ?array
    {
        return Db::get("SELECT e.id FROM tk_exchange_items i JOIN tk_exchanges e ON e.id=i.exchange_id WHERE i.dir='new' AND UPPER(i.sku)=UPPER(?) AND e.step NOT IN ('completed','cancelled','dispatched') AND e.id<>?", $sku, $exceptId ?: 0);
    }

    private function stockCheck(array $skus, $exceptId = null): array
    {
        $out = [];
        foreach ($skus as $s) {
            $pr = Db::get('SELECT * FROM products WHERE UPPER(sku)=UPPER(?)', trim(self::str($s)));
            $this->need($pr, 'SKU '.self::str($s).' not found');
            $this->need($pr['qty'] > 0, "{$pr['sku']} is not in stock");
            $r = $this->reservedElsewhere($pr['sku'], $exceptId);
            $this->need(! $r, "{$pr['sku']} is already promised in exchange #".($r['id'] ?? ''));
            $out[] = $pr;
        }
        return $out;
    }

    public function exProducts(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $s = trim(self::tr($qs['q'] ?? null) ? self::str($qs['q']) : '');
        if (mb_strlen($s) < 2) {
            return [];
        }
        $t = '%'.$s.'%';
        $rows = Db::all('SELECT p.sku, p.title, p.price, p.size, p.brand, p.cond, p.qty, COALESCE(l.location, p.rack) location FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 AND (p.sku LIKE ? OR p.title LIKE ? OR p.brand LIKE ? OR p.size LIKE ?) ORDER BY p.created_at DESC LIMIT 20', $t, $t, $t, $t);
        return array_map(fn ($r) => array_merge($r, ['reserved' => (bool) $this->reservedElsewhere($r['sku'])]), $rows);
    }

    public function exList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = [];
        $a = [];
        if (self::tr($qs['step'] ?? null)) {
            $w[] = 'e.step=?';
            $a[] = $qs['step'];
        } elseif (($qs['all'] ?? null) !== '1') {
            $w[] = "(e.step NOT IN ('completed','cancelled') OR e.updated_at>=(UTC_TIMESTAMP() - INTERVAL 14 DAY))";
        }
        if (self::tr($qs['q'] ?? null)) {
            $t = '%'.self::str($qs['q']).'%';
            $w[] = '(e.order_name LIKE ? OR e.cust_name LIKE ? OR e.phone LIKE ? OR e.reverse_tracking LIKE ? OR e.out_tracking LIKE ?)';
            array_push($a, $t, $t, $t, $t, $t);
        }
        $rows = Db::all('SELECT e.*, us.name created_by_name FROM tk_exchanges e LEFT JOIN users us ON us.id=e.created_by '.($w ? 'WHERE '.implode(' AND ', $w) : '').' ORDER BY e.updated_at DESC LIMIT 400', ...$a);
        foreach ($rows as &$r) {
            $r['items'] = $this->exItems($r['id']);
        }
        unset($r);
        $counts = [];
        foreach (Db::all('SELECT step, COUNT(*) n FROM tk_exchanges GROUP BY step') as $r) {
            $counts[(string) $r['step']] = $r['n'];
        }
        return ['rows' => $rows, 'counts' => (object) $counts];
    }

    public function exGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = Db::get('SELECT * FROM tk_exchanges WHERE id=?', (int) self::num($p['id']));
        $this->need($e, 'Exchange not found', 404);
        return ['exchange' => $e, 'items' => $this->exItems($e['id']),
            'log' => Db::all('SELECT l.*, us.name `user` FROM tk_exchange_log l LEFT JOIN users us ON us.id=l.user_id WHERE exchange_id=? ORDER BY l.id', $e['id']),
            'refund' => $e['refund_id'] ? Db::get('SELECT * FROM tk_refunds WHERE id=?', $e['refund_id']) : null];
    }

    private function createExchange(array $b, $uid): int
    {
        $t = self::tr($b['ticket_id'] ?? null) ? Db::get('SELECT * FROM tk_tickets WHERE id=?', (int) self::num($b['ticket_id'])) : null;
        $this->need(! self::tr($b['ticket_id'] ?? null) || $t, 'Ticket not found');
        $o = $this->findOrder(self::tr($b['order_id'] ?? null) ? $b['order_id'] : ($t['order_id'] ?? null));
        $this->need(! self::tr($b['order_id'] ?? null) || $o, 'Order not found');
        $clean = fn ($l) => array_values(array_filter(array_map(fn ($s) => trim(self::str($s)), is_array($l) ? $l : []), fn ($s) => $s !== ''));
        $oldSkus = $clean($b['old_items'] ?? []);
        $newSkus = $clean($b['new_items'] ?? []);
        $this->need(count($oldSkus), 'Pick the item the customer is sending back');
        $this->need(count($newSkus), 'Pick the new item to send');
        $old = [];
        foreach ($oldSkus as $s) {
            $it = $o ? Db::get('SELECT i.sku, i.title, i.price, pr.size FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE i.order_id=? AND UPPER(i.sku)=UPPER(?)', $o['id'], $s) : null;
            if ($o) {
                $this->need($it, "{$s} is not in order {$o['name']}");
            }
            if ($it) {
                $old[] = $it;
                continue;
            }
            $pr = Db::get('SELECT sku, title, price, size FROM products WHERE UPPER(sku)=UPPER(?)', $s);
            $op = self::num($b['old_price'] ?? null);
            $old[] = $pr ?: ['sku' => mb_strtoupper($s), 'title' => '', 'price' => self::tr($op) ? $op : 0, 'size' => ''];
        }
        $nw = $this->stockCheck($newSkus);
        $price = function ($x) {
            $v = self::num($x['price']);
            return self::tr($v) ? $v : 0;
        };
        $oldT = 0;
        foreach ($old as $x) {
            $oldT += $price($x);
        }
        $newT = 0;
        foreach ($nw as $x) {
            $newT += $price($x);
        }
        $diff = Logic::jsRound($newT - $oldT);
        $mode = $diff > 0 ? 'pay_extra' : ($diff < 0 ? (($b['diff_mode'] ?? null) === 'refund' ? 'refund' : 'store_credit') : 'none');
        $phRaw = self::tr($b['phone'] ?? null) ? $b['phone'] : ((($o['phone'] ?? null) ?: ($t['phone'] ?? null)) ?: '');
        $phone = Logic::normPhone($phRaw);
        $rm = $b['refund_method'] ?? null;
        $refundMethod = $mode === 'refund' ? (in_array($rm, self::METHODS, true) && $rm !== 'Store credit' ? $rm : 'Bank transfer') : ($mode === 'store_credit' ? 'Store credit' : null);
        $cust = self::tr($b['cust_name'] ?? null) ? self::str($b['cust_name']) : ((($o['cust_name'] ?? null) ?: ($t['cust_name'] ?? null)) ?: '');
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : '';
        $id = Db::tx(function () use ($t, $o, $phone, $cust, $oldT, $newT, $diff, $mode, $refundMethod, $b, $note, $uid, $old, $nw, $price) {
            $r = Db::run('INSERT INTO tk_exchanges(ticket_id,order_id,order_name,phone,cust_name,old_total,new_total,diff,diff_mode,refund_method,reverse_tracking,out_tracking,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                $t ? $t['id'] : null, $o ? $o['id'] : null, $o ? $o['name'] : null, $phone, $cust, $oldT, $newT, $diff, $mode, $refundMethod,
                self::tr($b['reverse_tracking'] ?? null) ? $b['reverse_tracking'] : null, self::tr($b['out_tracking'] ?? null) ? $b['out_tracking'] : null, mb_substr($note, 0, 1000), $uid);
            $eid = $r->lastInsertRowid;
            foreach ($old as $x) {
                Db::run("INSERT INTO tk_exchange_items(exchange_id,dir,sku,title,price,size) VALUES(?,'old',?,?,?,?)", $eid, $x['sku'], $x['title'], $price($x), ($x['size'] ?? null) ?: '');
            }
            foreach ($nw as $x) {
                Db::run("INSERT INTO tk_exchange_items(exchange_id,dir,sku,title,price,size) VALUES(?,'new',?,?,?,?)", $eid, $x['sku'], $x['title'], $price($x), ($x['size'] ?? null) ?: '');
            }
            Db::run("INSERT INTO tk_exchange_log(exchange_id,step,user_id,note) VALUES(?,'requested',?,?)", $eid, $uid, $note);
            if ($t) {
                $this->sysNote($t['id'], $uid, "Exchange #{$eid} created");
                Db::run("UPDATE tk_tickets SET status=CASE WHEN status='open' THEN 'progress' ELSE status END, updated_at=UTC_TIMESTAMP() WHERE id=?", $t['id']);
            }
            return $eid;
        });
        $this->log($uid, 'exchange.create', 'exchange:'.$id, ['order' => $o ? $o['name'] : null, 'diff' => $diff]);
        return $id;
    }

    public function exCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['id' => $this->createExchange($b, $u['id'])];
    }

    public function exUpdate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = Db::get('SELECT * FROM tk_exchanges WHERE id=?', (int) self::num($p['id']));
        $this->need($e, 'Exchange not found', 404);
        Db::run('UPDATE tk_exchanges SET reverse_tracking=?, out_tracking=?, note=?, updated_at=UTC_TIMESTAMP() WHERE id=?',
            $b['reverse_tracking'] ?? $e['reverse_tracking'], $b['out_tracking'] ?? $e['out_tracking'], $b['note'] ?? $e['note'], $e['id']);
        $this->log($u['id'], 'exchange.update', 'exchange:'.$e['id'], '');
        return ['ok' => true];
    }

    public function exStep(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = Db::get('SELECT * FROM tk_exchanges WHERE id=?', (int) self::num($p['id']));
        $this->need($e, 'Exchange not found', 404);
        $st = $b['step'] ?? null;
        $this->need($st === 'cancelled' || in_array($st, self::STEPS, true), 'Unknown step');
        $this->need(! in_array($e['step'], ['completed', 'cancelled'], true), 'This exchange is already '.strtolower(self::STEP_L[$e['step']]));
        if ($st !== 'cancelled') {
            $cur = array_search($e['step'], self::STEPS, true);
            $cur = $cur === false ? -1 : $cur;
            $this->need(array_search($st, self::STEPS, true) === $cur + 1, 'Next step is "'.(self::STEP_L[self::STEPS[$cur + 1] ?? ''] ?? 'undefined').'"');
        }
        $items = $this->exItems($e['id']);
        if ($st === 'approved' || $st === 'dispatched') {
            $this->stockCheck(array_column(array_filter($items, fn ($i) => $i['dir'] === 'new'), 'sku'), $e['id']);
        }
        if (self::tr($b['reverse_tracking'] ?? null)) {
            Db::run('UPDATE tk_exchanges SET reverse_tracking=? WHERE id=?', $b['reverse_tracking'], $e['id']);
        }
        if (self::tr($b['out_tracking'] ?? null)) {
            Db::run('UPDATE tk_exchanges SET out_tracking=? WHERE id=?', $b['out_tracking'], $e['id']);
        }
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : '';
        if ($st === 'received') {
            $w = $this->svc('wms');
            $fn = $w ? (method_exists($w, 'receiveReturn') ? 'receiveReturn' : (method_exists($w, 'receive') ? 'receive' : null)) : null;
            if ($fn) {
                try {
                    foreach (array_filter($items, fn ($x) => $x['dir'] === 'old') as $i) {
                        if ($fn === 'receiveReturn') {
                            // wms.receiveReturn(sku, note, userId) — the JS passed an object as `sku` here (a latent bug); call it as the WMS service defines it
                            $w->receiveReturn($i['sku'], trim('Exchange #'.$e['id'].($note !== '' ? ' · '.$note : '')), $u['id']);
                        } else {
                            $w->{$fn}(['sku' => $i['sku'], 'order_id' => $e['order_id'], 'reason' => 'exchange', 'ref' => 'exchange:'.$e['id'], 'cond' => self::tr($b['cond'] ?? null) ? $b['cond'] : null, 'note' => $note], $u['id']);
                        }
                    }
                    $wn = 'Sent to warehouse receiving';
                } catch (\Throwable $x) {
                    $wn = 'Warehouse receive failed: '.$x->getMessage();
                }
            } else {
                $wn = 'Warehouse module not connected: put the returned pair back on a rack by hand.';
            }
            Db::run('UPDATE tk_exchanges SET wms_note=? WHERE id=?', $wn, $e['id']);
        }
        Db::tx(function () use ($st, $e, $u, $note, $b) {
            Db::run("UPDATE tk_exchanges SET step=?, {$st}_at=UTC_TIMESTAMP(), updated_at=UTC_TIMESTAMP() WHERE id=?", $st, $e['id']);
            Db::run('INSERT INTO tk_exchange_log(exchange_id,step,user_id,note) VALUES(?,?,?,?)', $e['id'], $st, $u['id'], $note);
            if ($st === 'completed' && $e['diff'] < 0 && in_array($e['diff_mode'], ['refund', 'store_credit'], true) && ! $e['refund_id']) {
                $r = Db::run('INSERT INTO tk_refunds(ticket_id,exchange_id,order_id,order_name,phone,cust_name,method,amount,account_details,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                    $e['ticket_id'], $e['id'], $e['order_id'], $e['order_name'], $e['phone'], $e['cust_name'], $e['refund_method'] ?: 'Store credit', -$e['diff'], '', "Exchange #{$e['id']} price difference", $u['id']);
                Db::run('UPDATE tk_exchanges SET refund_id=? WHERE id=?', $r->lastInsertRowid, $e['id']);
                $this->log($u['id'], 'refund.create', 'refund:'.$r->lastInsertRowid, ['exchange' => $e['id'], 'amount' => -$e['diff']]);
            }
            if ($e['ticket_id']) {
                $this->sysNote($e['ticket_id'], $u['id'], "Exchange #{$e['id']}: ".self::STEP_L[$st]);
                $this->touch($e['ticket_id']);
            }
            if ($st === 'completed' && $e['ticket_id']) {
                $this->autoResolveParent($e['ticket_id'], 'Exchanged', "exchange #{$e['id']} completed", $u['id'], $b['fault'] ?? null);
            }
        });
        $this->log($u['id'], 'exchange.step', 'exchange:'.$e['id'], ['step' => $st]);
        return ['ok' => true];
    }

    /* ---------- refunds & store credit ---------- */
    private function refAccess(?array $u): void
    {
        $this->need($this->can($u, 'tickets') || $this->isApprover($u), 'Your account does not have access to this', 403);
    }

    // Accounts for a refund:
    //  approve → Dr Sales Return (or Customer Advances, see below) / Cr Store Credit (store credit) or Cr Accrued Expenses customer:<phone> (money still to send)
    //  paid    → Dr Accrued Expenses customer:<phone> / Cr bank, dated the day it was sent (so the bank ledger matches the statement)
    // A refund on an order whose sale was already reversed by the automatic PostEx return entry (Dr Sales Return / Cr Post Ex) must not hit Sales Return
    // again: the money we give back is the customer's advance, so it debits Customer Advances.
    private function pkDate($s): string
    {
        return gmdate('Y-m-d', (int) (self::parseUtc($s) + 5 * 3600));
    }

    private static function amt2($v): int|float
    {
        return Logic::jsRound(self::num($v) * 100) / 100;
    }

    private function refundLines(array $r): array
    {
        $amt = self::amt2($r['amount']);
        $party = 'customer:'.$r['phone'];
        $o = $r['order_id'] ? Db::get('SELECT status, dispatched_at, cancelled_at FROM orders WHERE id=?', $r['order_id']) : null;
        $reversed = (bool) ($o && $o['dispatched_at'] && ! $o['cancelled_at'] && in_array($o['status'], self::RET_ST, true));
        $dr = $reversed ? ['account' => 'Customer Advances', 'debit' => $amt, 'party' => $party] : ['account' => 'Sales Return', 'debit' => $amt];
        return [$dr, $r['method'] === 'Store credit' ? ['account' => 'Store Credit', 'credit' => $amt, 'party' => $party] : ['account' => 'Accrued Expenses', 'credit' => $amt, 'party' => $party]];
    }

    private function refundBank(): string
    {
        $v = $this->setting('tickets_refund_account', 'Meezan (SB)');
        return self::tr($v) ? (string) $v : 'Meezan (SB)';
    }

    private function postRefund(array $r, $uid): bool
    {
        $acc = $this->svc('accounts');
        if (! $acc || ! method_exists($acc, 'post')) {
            Db::run("UPDATE tk_refunds SET posted=0, post_error='Accounts module not available yet' WHERE id=?", $r['id']);
            return false;
        }
        $amt = self::amt2($r['amount']);
        try {
            $jid = $acc->post(['date' => $r['approved_at'] ? $this->pkDate($r['approved_at']) : $this->pkToday(), 'memo' => trim("Refund #{$r['id']} · {$r['method']} · ".(($r['order_name'] ?: $r['phone']) ?: '')),
                'source' => 'refund', 'source_id' => (string) $r['id'], 'lines' => $this->refundLines($r)], $uid);
            if ($r['method'] !== 'Store credit' && $r['status'] === 'paid') {
                $acc->post(['date' => $r['paid_at'] ? $this->pkDate($r['paid_at']) : $this->pkToday(), 'memo' => "Refund #{$r['id']} sent · {$r['method']}".($r['paid_ref'] ? ' · ref '.$r['paid_ref'] : ''),
                    'source' => 'refund-paid', 'source_id' => (string) $r['id'],
                    'lines' => [['account' => 'Accrued Expenses', 'debit' => $amt, 'party' => 'customer:'.$r['phone']], ['account' => $this->refundBank(), 'credit' => $amt]]], $r['paid_by'] ?: $uid);
            }
            Db::run('UPDATE tk_refunds SET posted=1, post_error=NULL, journal_id=? WHERE id=?', $jid === null ? null : self::str($jid), $r['id']);
            return true;
        } catch (\Throwable $x) {
            Db::run('UPDATE tk_refunds SET posted=0, post_error=? WHERE id=?', mb_substr($x->getMessage(), 0, 300), $r['id']);
            return false;
        }
    }

    /** ctx._tkRepost: post approved/paid refunds that are not in the books yet; move returned orders' refunds to Customer Advances. */
    private function repost(): int
    {
        $acc = $this->svc('accounts');
        if (! $acc) {
            return 0;
        }
        $n = 0;
        foreach (Db::all("SELECT * FROM tk_refunds WHERE status IN ('approved','paid') AND posted=0") as $r) {
            if ($this->postRefund($r, $r['approved_by'])) {
                $n++;
            }
        }
        // order returned after its refund was posted: move the debit from Sales Return to Customer Advances (only while that month is open)
        $L = (method_exists($acc, 'lockDate') ? $acc->lockDate() : null) ?: '';
        $rows = Db::all("SELECT r.* FROM tk_refunds r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('approved','paid') AND r.posted=1 AND o.dispatched_at IS NOT NULL AND o.cancelled_at IS NULL
          AND o.status IN ('returning','returned','return_received') AND EXISTS (SELECT 1 FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id JOIN acc_accounts a ON a.id=l.account_id
          WHERE j.source='refund' AND j.source_id=CAST(r.id AS CHAR) AND j.voided=0 AND a.name='Sales Return' AND j.date>?)", $L);
        foreach ($rows as $r) {
            try {
                if ($this->postRefund($r, $r['approved_by'])) {
                    $n++;
                }
            } catch (\Throwable) {
            }
        }
        return $n;
    }

    public function refundsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->refAccess($u);
        $w = [];
        $a = [];
        if (self::tr($qs['status'] ?? null)) {
            $w[] = 'r.status=?';
            $a[] = $qs['status'];
        }
        if (self::tr($qs['method'] ?? null)) {
            $w[] = 'r.method=?';
            $a[] = $qs['method'];
        }
        if (self::tr($qs['from'] ?? null)) {
            $w[] = "DATE_FORMAT(r.created_at + INTERVAL 5 HOUR,'%Y-%m-%d')>=?";
            $a[] = $qs['from'];
        }
        if (self::tr($qs['to'] ?? null)) {
            $w[] = "DATE_FORMAT(r.created_at + INTERVAL 5 HOUR,'%Y-%m-%d')<=?";
            $a[] = $qs['to'];
        }
        if (self::tr($qs['q'] ?? null)) {
            $t = '%'.self::str($qs['q']).'%';
            $w[] = '(r.order_name LIKE ? OR r.cust_name LIKE ? OR r.phone LIKE ? OR r.paid_ref LIKE ?)';
            array_push($a, $t, $t, $t, $t);
        }
        $where = $w ? 'WHERE '.implode(' AND ', $w) : '';
        $rows = Db::all("SELECT r.*, c.name created_by_name, ap.name approved_by_name, pd.name paid_by_name, TIMESTAMPDIFF(HOUR, r.created_at, UTC_TIMESTAMP()) age_h FROM tk_refunds r
        LEFT JOIN users c ON c.id=r.created_by LEFT JOIN users ap ON ap.id=r.approved_by LEFT JOIN users pd ON pd.id=r.paid_by {$where} ORDER BY r.id DESC LIMIT 1000", ...$a);
        $totals = Db::get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COALESCE(SUM(CASE WHEN status='approved' THEN amount END),0) approved,
        COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) paid FROM tk_refunds r {$where}", ...$a);
        $counts = [];
        foreach (Db::all('SELECT status, COUNT(*) n FROM tk_refunds GROUP BY status') as $r) {
            $counts[(string) $r['status']] = $r['n'];
        }
        return ['rows' => $rows, 'totals' => $totals, 'counts' => (object) $counts, 'canApprove' => $this->isApprover($u), 'canCreate' => $this->can($u, 'tickets'), 'accounts' => (bool) $this->svc('accounts')];
    }

    public function refundCreate(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $method = $b['method'] ?? null;
        $this->need(in_array($method, self::METHODS, true), 'Pick a refund method');
        $amt = self::num($b['amount'] ?? null);
        $this->need($amt > 0, 'Enter the refund amount');
        $t = self::tr($b['ticket_id'] ?? null) ? Db::get('SELECT * FROM tk_tickets WHERE id=?', (int) self::num($b['ticket_id'])) : null;
        $this->need(! self::tr($b['ticket_id'] ?? null) || $t, 'Ticket not found');
        $o = $this->findOrder(self::tr($b['order_id'] ?? null) ? $b['order_id'] : ($t['order_id'] ?? null));
        $phRaw = self::tr($b['phone'] ?? null) ? $b['phone'] : ((($t['phone'] ?? null) ?: ($o['phone'] ?? null)) ?: '');
        $phone = Logic::normPhone($phRaw);
        $this->need($phone !== '', 'Customer phone is needed');
        $details = self::tr($b['account_details'] ?? null) ? self::str($b['account_details']) : '';
        if ($method !== 'Store credit') {
            $this->need(trim($details) !== '', 'Add the customer account details (account / wallet number and name)');
        }
        if ($o) {
            $tot = self::num($o['total']);
            $this->need($amt <= (self::tr($tot) ? $tot : 0) + 1, 'Refund is more than the order total ('.Logic::jsRound((float) $o['total']).')');
        }
        $cust = self::tr($b['cust_name'] ?? null) ? self::str($b['cust_name']) : ((($t['cust_name'] ?? null) ?: ($o['cust_name'] ?? null)) ?: '');
        $r = Db::run('INSERT INTO tk_refunds(ticket_id,exchange_id,order_id,order_name,phone,cust_name,method,amount,account_details,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            $t ? $t['id'] : null, self::tr($b['exchange_id'] ?? null) ? $b['exchange_id'] : null, $o ? $o['id'] : null, $o ? $o['name'] : null, $phone, $cust, $method, $amt,
            mb_substr($details, 0, 300), mb_substr(self::tr($b['reason'] ?? null) ? self::str($b['reason']) : '', 0, 500), $u['id']);
        $id = $r->lastInsertRowid;
        if ($t) {
            $this->sysNote($t['id'], $u['id'], "Refund #{$id} requested: {$method} Rs ".Logic::jsRound($amt));
            Db::run("UPDATE tk_tickets SET status=CASE WHEN status='open' THEN 'progress' ELSE status END, updated_at=UTC_TIMESTAMP() WHERE id=?", $t['id']);
        }
        $this->log($u['id'], 'refund.create', 'refund:'.$id, ['amount' => $amt, 'method' => $method]);
        return ['id' => $id];
    }

    private function getR($id): array
    {
        $r = Db::get('SELECT * FROM tk_refunds WHERE id=?', (int) self::num($id));
        $this->need($r, 'Refund not found', 404);
        return $r;
    }

    public function refundApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isApprover($u), 'Only finance or the owner can approve refunds', 403);
        $r = $this->getR($p['id']);
        $this->need($r['status'] === 'pending', 'Refund is already '.$r['status']);
        $credit = $r['method'] === 'Store credit';
        Db::run('UPDATE tk_refunds SET status=?, approved_by=?, approved_at=UTC_TIMESTAMP()'.($credit ? ", paid_by=?, paid_at=UTC_TIMESTAMP(), paid_ref='Store credit'" : '').' WHERE id=?',
            $credit ? 'paid' : 'approved', $u['id'], ...($credit ? [$u['id']] : []), ...[$r['id']]);
        $posted = $this->postRefund($this->getR($r['id']), $u['id']);
        if ($r['ticket_id']) {
            $this->sysNote($r['ticket_id'], $u['id'], "Refund #{$r['id']} approved".($credit ? ' (store credit added)' : ''));
            $this->touch($r['ticket_id']);
            if ($credit) {
                $this->autoResolveParent($r['ticket_id'], 'Store credit given', "store credit #{$r['id']} added", $u['id']);
            }
        }
        $this->log($u['id'], 'refund.approve', 'refund:'.$r['id'], ['amount' => $r['amount'], 'method' => $r['method']]);
        return ['ok' => true, 'posted' => $posted];
    }

    public function refundReject(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isApprover($u), 'Only finance or the owner can reject refunds', 403);
        $r = $this->getR($p['id']);
        $this->need($r['status'] === 'pending', 'Refund is already '.$r['status']);
        $reason = self::tr($b['reason'] ?? null) ? self::str($b['reason']) : '';
        $this->need(trim($reason) !== '', 'Write why it is rejected');
        Db::run("UPDATE tk_refunds SET status='rejected', rejected_by=?, rejected_at=UTC_TIMESTAMP(), reject_reason=? WHERE id=?", $u['id'], mb_substr($reason, 0, 500), $r['id']);
        if ($r['ticket_id']) {
            $this->sysNote($r['ticket_id'], $u['id'], "Refund #{$r['id']} rejected: {$reason}");
        }
        $this->log($u['id'], 'refund.reject', 'refund:'.$r['id'], $b['reason']);
        return ['ok' => true];
    }

    public function refundPaid(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isApprover($u), 'Only finance or the owner can mark refunds paid', 403);
        $r = $this->getR($p['id']);
        $this->need($r['status'] === 'approved', $r['status'] === 'pending' ? 'Approve the refund first' : 'Refund is already '.$r['status']);
        $ref = self::tr($b['ref'] ?? null) ? self::str($b['ref']) : '';
        $this->need(trim($ref) !== '', 'Enter the transfer reference / transaction ID');
        Db::run("UPDATE tk_refunds SET status='paid', paid_by=?, paid_at=UTC_TIMESTAMP(), paid_ref=? WHERE id=?", $u['id'], mb_substr($ref, 0, 120), $r['id']);
        $this->postRefund($this->getR($r['id']), $u['id']); // books the money leaving the bank (Dr Accrued Expenses / Cr bank)
        if ($r['ticket_id']) {
            $this->sysNote($r['ticket_id'], $u['id'], "Refund #{$r['id']} paid · ref {$ref}");
            $this->autoResolveParent($r['ticket_id'], 'Refunded', "refund #{$r['id']} paid", $u['id']);
        }
        $this->log($u['id'], 'refund.paid', 'refund:'.$r['id'], ['ref' => $b['ref']]);
        return ['ok' => true];
    }

    public function refundPost(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isApprover($u), 'Only finance or the owner can post refunds', 403);
        $r = $this->getR($p['id']);
        $this->need(in_array($r['status'], ['approved', 'paid'], true), 'Approve the refund first');
        $ok = $this->postRefund($r, $u['id']);
        $x = $this->getR($r['id']);
        $this->need($ok, ($x['post_error'] ?? null) ?: 'Could not post');
        return ['ok' => true];
    }

    /* ---------- services (ctx.services.tickets) ---------- */

    public function summary(): array
    {
        $t = Db::get('SELECT SUM(status IN '.self::OPEN.") `open`, SUM(status IN ('open','progress') AND due_at<UTC_TIMESTAMP()) overdue FROM tk_tickets");
        return ['open' => ($t['open'] ?? null) ?: 0, 'overdue' => ($t['overdue'] ?? null) ?: 0, 'exchangesOpen' => (int) Db::val("SELECT COUNT(*) n FROM tk_exchanges WHERE step NOT IN ('completed','cancelled')"),
            'refundsPending' => (int) Db::val("SELECT COUNT(*) n FROM tk_refunds WHERE status='pending'")];
    }

    /** inbox: tickets.create({ type, channel, order_id, phone, cust_name, subject, note, files, priority, assignee, sku, tracking, order_name }, userId) -> ticket id */
    public function create($data, $userId = null): int
    {
        return $this->createTicket(is_array($data) ? $data : [], $userId);
    }

    public function runAutoAttempted(): array
    {
        return $this->autoAttempted();
    }

    /* ---------- jobs / counts / alerts / activity ---------- */

    public function jobs(): array
    {
        return [
            ['name' => 'attempted', 'every' => 30, 'offset' => 7, 'run' => fn () => $this->autoAttempted()],
            ['name' => 'repost', 'every' => 60, 'offset' => 13, 'run' => fn () => $this->repost()],
        ];
    }

    public function counts(array $u): array
    {
        $c = [];
        if ($this->can($u, 'tickets')) {
            $c['tickets'] = (int) Db::val('SELECT COUNT(*) n FROM tk_tickets WHERE status IN '.self::OPEN.' AND (assignee=? OR assignee IS NULL)', $u['id']);
        }
        if ($this->can($u, 'finance') || ($u['role'] ?? null) === 'admin') {
            $c['refunds'] = (int) Db::val("SELECT COUNT(*) n FROM tk_refunds WHERE status IN ('pending','approved')");
        }
        if ($this->can($u, 'tickets')) {
            $c['exchanges'] = (int) Db::val("SELECT COUNT(*) n FROM tk_exchanges WHERE step NOT IN ('completed','cancelled')");
        }
        return $c;
    }

    public function alerts(array $u): array
    {
        $out = [];
        if ($this->can($u, 'tickets')) {
            $mine = (int) Db::val("SELECT COUNT(*) n FROM tk_tickets WHERE status IN ('open','progress') AND due_at<UTC_TIMESTAMP() AND assignee=?", $u['id']);
            $all = (int) Db::val("SELECT COUNT(*) n FROM tk_tickets WHERE status IN ('open','progress') AND due_at<UTC_TIMESTAMP()");
            if ($mine) {
                $out[] = ['level' => 'bad', 'text' => "{$mine} of your tickets are overdue", 'href' => '#/tickets/overdue'];
            } elseif ($all && (in_array($u['role'] ?? null, ['admin', 'manager'], true) || ! Db::get('SELECT 1 FROM tk_tickets WHERE assignee=? LIMIT 1', $u['id']))) {
                $out[] = ['level' => 'warn', 'text' => "{$all} customer tickets are overdue", 'href' => '#/tickets/overdue'];
            }
        }
        if ($this->can($u, 'finance') || ($u['role'] ?? null) === 'admin') {
            $n = (int) Db::val("SELECT COUNT(*) n FROM tk_refunds WHERE status='pending' AND created_at<(UTC_TIMESTAMP() - INTERVAL 1 DAY)");
            if ($n) {
                $out[] = ['level' => 'warn', 'text' => "{$n} refunds waiting for approval for over a day", 'href' => '#/refunds/pending'];
            }
        }
        return $out;
    }

    public function activity(): array
    {
        return [
            'ticket.create' => 'Created ticket', 'ticket.reply' => 'Replied to customer', 'ticket.note' => 'Added ticket note', 'ticket.assign' => 'Assigned ticket', 'ticket.status' => 'Changed ticket status',
            'ticket.resolve' => 'Resolved ticket', 'ticket.close' => 'Closed ticket without fix', 'ticket.fault' => 'Recorded whose mistake', 'ticket.autoresolve' => 'Ticket auto-resolved', 'ticket.reopen' => 'Reopened ticket', 'ticket.autorun' => 'Ran delivery follow-ups', 'exchange.create' => 'Created exchange', 'exchange.step' => 'Moved exchange step',
            'exchange.update' => 'Updated exchange', 'refund.create' => 'Requested refund', 'refund.approve' => 'Approved refund', 'refund.reject' => 'Rejected refund', 'refund.paid' => 'Marked refund paid',
        ];
    }
}
