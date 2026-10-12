<?php

namespace App\Erp\Modules;

use App\Erp\Db;
use App\Erp\Module;
use App\Erp\Router;
use App\Erp\Core\Logic;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\WebhookVerifier;
use Illuminate\Http\Request;

/**
 * Shopify abandoned checkouts (port of modules/abandoned.js): customers who started checkout but did not order.
 * Data comes from the Shopify webhooks checkouts/create + checkouts/update (and orders/create for exact matching)
 * at /api/hooks/shopify/checkouts, plus a sync every 30 min (REST checkouts.json). Staff WhatsApp / call them;
 * when an order arrives with the same checkout token, or the same phone / email within 7 days, the cart is marked
 * Recovered and credited to the person who last contacted it.
 */
class AbandonedModule extends Module
{
    public string $name = 'abandoned';

    private const MIN_AGE = 30; // minutes: don't chase people still paying
    private const MATCH_DAYS = 7;
    private const OUTCOMES = ['will_order' => 'Will order', 'no_answer' => 'No answer', 'not_interested' => 'Not interested', 'wrong_number' => 'Wrong number'];
    private const LOST_REASONS = ['Not interested', 'Wrong number', 'No answer after 3 tries', 'Ordered on another number', 'Item sold out', 'Price too high', 'Other'];
    private const DEF_MSG = "Assalam o Alaikum {name}! SundayBazar se baat kar rahi hoon. Aap ne {items} cart mein chhor diya tha. Pair abhi available hai, order sirf ek click door hai: {link}\nKoi sawal ho (size, delivery, COD) to isi number par message karein. Shukriya!";
    private const TABS = ['new' => "status='new'", 'contacted' => "status='contacted'", 'recovered' => "status='recovered'", 'lost' => "status='lost'"];

    private ?bool $demoState = null;

    public function perms(): array
    {
        return []; // 'abandoned' is a core permission
    }

    public function activity(): array
    {
        return [
            'abandoned.contact' => 'Abandoned carts contacted', 'abandoned.note' => 'Abandoned cart note', 'abandoned.lost' => 'Marked abandoned cart lost',
            'abandoned.reopen' => 'Reopened abandoned cart', 'abandoned.sync' => 'Synced abandoned checkouts', 'abandoned.settings' => 'Changed abandoned cart settings',
        ];
    }

    public function routes(Router $r): void
    {
        $r->post('/api/hooks/shopify/checkouts', null, 'hook');
        $r->get('/api/abandoned', 'abandoned', 'listCarts');
        $r->get('/api/abandoned/c/:id', 'abandoned', 'showCart');
        $r->post('/api/abandoned/c/:id/whatsapp', 'abandoned', 'whatsapp');
        $r->post('/api/abandoned/c/:id/call', 'abandoned', 'call');
        $r->post('/api/abandoned/c/:id/note', 'abandoned', 'note');
        $r->post('/api/abandoned/c/:id/lost', 'abandoned', 'lost');
        $r->post('/api/abandoned/c/:id/reopen', 'abandoned', 'reopen');
        $r->post('/api/abandoned/sync', 'abandoned', 'sync');
        $r->get('/api/abandoned/settings', 'abandoned', 'settingsGet');
        $r->post('/api/abandoned/settings', 'abandoned', 'settingsSave');
    }

    public function jobs(): array
    {
        return [['name' => 'abandoned-sync', 'every' => 30, 'offset' => 11, 'run' => fn () => $this->job()]];
    }

    /* ================================================================ helpers */

    private function utcNow(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /** any Shopify / DB timestamp -> UTC 'Y-m-d H:i:s' (null when empty or invalid) */
    private function toUtc($v): ?string
    {
        if ($v === null || $v === '' || $v === false || $v === 0) {
            return null;
        }
        $s = (string) $v;
        if (! (str_contains($s, 'T') || preg_match('/Z|[+-]\d\d:?\d\d$/', $s))) {
            $s = str_replace(' ', 'T', $s).'Z';
        }
        try {
            return (new \DateTimeImmutable($s))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        } catch (\Throwable) {
            return null;
        }
    }

    /** epoch ms of a timestamp (null = NaN) */
    private function ms($v): ?float
    {
        $s = $this->toUtc($v);
        return $s ? (float) strtotime($s.' UTC') * 1000 : null;
    }

    private function isoMs(float $ms): string
    {
        $sec = (int) floor($ms / 1000);
        return gmdate('Y-m-d\TH:i:s', $sec).'.'.str_pad((string) (int) ($ms - $sec * 1000), 3, '0', STR_PAD_LEFT).'Z';
    }

    private function arr($v): array
    {
        return is_array($v) ? $v : [];
    }

    private function truthy($v): bool
    {
        return ! ($v === null || $v === false || $v === 0 || $v === 0.0 || $v === '');
    }

    private function str($v): string
    {
        if ($v === null) {
            return '';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v) && floor($v) == $v && abs($v) < 1e15) {
            return (string) (int) $v;
        }
        return is_array($v) ? '' : (string) $v;
    }

    private function num($v): float
    {
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if (is_string($v) && is_numeric(trim($v))) {
            return (float) trim($v);
        }
        return $v === true ? 1.0 : 0.0; // JS +x || 0
    }

    private function numOut(float $v): int|float
    {
        return floor($v) == $v && abs($v) < 1e15 ? (int) $v : $v;
    }

    private function cfg(): array
    {
        return array_merge(['waTemplate' => '', 'waMessage' => self::DEF_MSG, 'webhookSecret' => ''], $this->arr($this->setting('abandoned.cfg', [])));
    }

    private function ageCut(): string
    {
        return gmdate('Y-m-d H:i:s', time() - self::MIN_AGE * 60);
    }

    private function userName($id): ?string
    {
        if (! $id) {
            return null;
        }
        return (Db::get('SELECT name FROM users WHERE id=?', $id)['name'] ?? null) ?: '#'.$id;
    }

    private function mask(?array $u, $p)
    {
        if ($p === null && ($this->can($u, 'customers') || $this->can($u, 'cs') || $this->can($u, 'tracking'))) {
            return null; // JS returned p as is
        }
        return $this->maskPhone($u, $p === null ? null : (string) $p);
    }

    private function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    /* ================================================================ ingest one Shopify checkout (webhook or REST sync) */

    private function itemsOf(array $co): array
    {
        $out = [];
        foreach (array_slice(array_values($this->arr($co['line_items'] ?? [])), 0, 20) as $i) {
            $i = $this->arr($i);
            $sku = trim($this->str($i['sku'] ?? ''));
            $p = $sku !== '' ? Db::get('SELECT title,size,image FROM products WHERE sku=? LIMIT 1', $sku) : null;
            $vt = trim(explode('/', $this->str($i['variant_title'] ?? ''))[0]);
            $img = $i['image'] ?? null;
            $out[] = [
                'title' => ($i['title'] ?? null) ?: (($i['presentment_title'] ?? null) ?: (($p['title'] ?? null) ?: ($sku ?: 'Item'))),
                'sku' => $sku,
                'size' => ($p['size'] ?? null) ?: ($vt ?: ''),
                'price' => $this->numOut($this->num($i['price'] ?? null)),
                'qty' => $this->numOut($this->num($i['quantity'] ?? null) ?: 1),
                'image' => ($i['image_url'] ?? null) ?: (($img ? (is_array($img) ? ($img['src'] ?? null) : $img) : null) ?: (($p['image'] ?? null) ?: null)),
            ];
        }
        return $out;
    }

    /** Service: ingest(checkout, src) -> checkout id or null */
    public function ingest($co, $src = null): ?string
    {
        if (! is_array($co) || ! isset($co['id'])) {
            return null;
        }
        $id = $this->str($co['id']);
        $a = $this->arr(($co['shipping_address'] ?? null) ?: (($co['billing_address'] ?? null) ?: []));
        $cu = $this->arr($co['customer'] ?? []);
        $join = fn (...$x) => implode(' ', array_filter($x, fn ($y) => $this->truthy($y)));
        $name = ($a['name'] ?? null) ?: ($join($a['first_name'] ?? null, $a['last_name'] ?? null) ?: ($join($cu['first_name'] ?? null, $cu['last_name'] ?? null) ?: ''));
        $phone = Logic::normPhone(($co['phone'] ?? null) ?: (($a['phone'] ?? null) ?: (($cu['phone'] ?? null) ?: (($co['sms_marketing_phone'] ?? null) ?: '')))) ?: null;
        $v = [
            'token' => ($co['token'] ?? null) ?: null,
            'cart_token' => ($co['cart_token'] ?? null) ?: null,
            'created_at' => $this->toUtc($co['created_at'] ?? null) ?: $this->utcNow(),
            'updated_at' => $this->toUtc($co['updated_at'] ?? null) ?: ($this->toUtc($co['created_at'] ?? null) ?: $this->utcNow()),
            'completed_at' => $this->toUtc($co['completed_at'] ?? null),
            'name' => $name,
            'phone' => $phone && strlen($phone) >= 10 ? $phone : null,
            'email' => strtolower(trim($this->str(($co['email'] ?? null) ?: (($cu['email'] ?? null) ?: '')))) ?: null,
            'city' => ($a['city'] ?? null) ?: '',
            'items' => json_encode($this->itemsOf($co), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'total' => $this->num(($co['total_price'] ?? null) ?: (($co['subtotal_price'] ?? null) ?: 0)),
            'url' => ($co['abandoned_checkout_url'] ?? null) ?: null,
        ];
        $old = Db::get('SELECT id FROM ab_checkouts WHERE id=?', $id);
        $ks = array_keys($v);
        if ($old) {
            Db::run('UPDATE ab_checkouts SET '.implode(',', array_map(fn ($k) => "`$k`=?", $ks)).' WHERE id=?', ...array_merge(array_values($v), [$id]));
        } else {
            Db::run('INSERT INTO ab_checkouts(id,'.implode(',', array_map(fn ($k) => "`$k`", $ks)).',src,ingested_at) VALUES(?,'.Db::marks($ks).',?,UTC_TIMESTAMP())', $id, ...array_merge(array_values($v), [$src ?: 'hook']));
        }
        if ($v['completed_at']) {
            $c = Db::get('SELECT * FROM ab_checkouts WHERE id=?', $id);
            if (in_array($c['status'], ['new', 'contacted'], true)) {
                $this->markDone($c, null, 'Checkout completed in Shopify');
            }
        }
        return $id;
    }

    /* ================================================================ recovered: an order came from this cart */

    private function markDone(array $c, ?array $o, string $how): void
    {
        $by = $c['contacted_by'] ?: null;
        $at = ($o ? $this->toUtc($o['created_at'] ?? null) : null) ?: (($c['completed_at'] ?? null) ?: $this->utcNow());
        // nobody chased it -> the customer finished on their own (kept out of the tabs, not credited)
        Db::run('UPDATE ab_checkouts SET status=?, recovered_order=?, recovered_name=?, recovered_value=?, recovered_at=?, recovered_by=?, recovered_how=? WHERE id=?',
            $by ? 'recovered' : 'completed', $o ? $this->str($o['id']) : null, $o ? (($o['name'] ?? null) ?: null) : null,
            $o ? ($this->num($o['total'] ?? null) ?: $c['total']) : $c['total'], $at, $by, $how, $c['id']);
        Db::run('INSERT INTO ab_events(checkout_id,user_id,kind,note,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $c['id'], $by, $by ? 'recovered' : 'completed', ($o && ! empty($o['name']) ? $o['name'].' · ' : '').$how);
    }

    /** Service: match open carts to orders; returns how many were marked recovered/completed */
    public function matchOrders(): int
    {
        $open = Db::all("SELECT * FROM ab_checkouts WHERE status IN ('new','contacted')");
        $n = 0;
        foreach ($open as $c) {
            $o = null;
            $how = '';
            if ($c['token']) {
                $o = Db::get('SELECT * FROM ab_orders WHERE checkout_token=? LIMIT 1', $c['token']);
                $how = 'Same checkout';
            }
            if (! $o && $c['cart_token']) {
                $o = Db::get('SELECT * FROM ab_orders WHERE cart_token=? LIMIT 1', $c['cart_token']);
                $how = 'Same cart';
            }
            if (! $o && ($c['phone'] || $c['email'])) {
                $base = $this->ms($c['created_at']);
                $cand = [];
                if ($c['phone']) {
                    foreach (Db::all('SELECT id,name,total,created_at FROM orders WHERE phone=? AND cancelled_at IS NULL', $c['phone']) as $x) {
                        $cand[] = $x + ['how' => 'Same phone'];
                    }
                }
                foreach (Db::all('SELECT id,name,total,created_at FROM ab_orders WHERE (phone=? AND phone IS NOT NULL) OR (email=? AND email IS NOT NULL)', $c['phone'] ?: '', $c['email'] ?: '') as $x) {
                    $cand[] = $x + ['how' => $c['email'] ? 'Same phone / email' : 'Same phone'];
                }
                $hit = null;
                if ($base !== null) {
                    $t0 = $base - 10 * 60e3;
                    $t1 = $base + self::MATCH_DAYS * 864e5;
                    $cand = array_values(array_filter($cand, function ($x) use ($t0, $t1) {
                        $t = $this->ms($x['created_at']);
                        return $t !== null && $t >= $t0 && $t <= $t1;
                    }));
                    usort($cand, fn ($x, $y) => $this->ms($x['created_at']) <=> $this->ms($y['created_at']));
                    $hit = $cand[0] ?? null;
                }
                if ($hit) {
                    $o = $hit;
                    $how = $hit['how'].' within '.self::MATCH_DAYS.' days';
                }
            }
            if ($o) {
                if (! $this->truthy($o['total'] ?? null)) {
                    $ord = Db::get('SELECT name,total FROM orders WHERE id=?', $o['id']);
                    if ($ord) {
                        $o = array_merge($o, ['name' => ($o['name'] ?? null) ?: $ord['name'], 'total' => $ord['total']]);
                    }
                }
                $this->markDone($c, $o, $how);
                $n++;
            }
        }
        return $n;
    }

    private function rememberOrder($o): void
    {
        if (! is_array($o) || ! isset($o['id'])) {
            return;
        }
        $id = ($o['admin_graphql_api_id'] ?? null) ?: 'gid://shopify/Order/'.$this->str($o['id']);
        $a = $this->arr(($o['shipping_address'] ?? null) ?: (($o['billing_address'] ?? null) ?: []));
        $cu = $this->arr($o['customer'] ?? []);
        Db::run('INSERT INTO ab_orders(id,name,checkout_token,cart_token,phone,email,total,created_at) VALUES(?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE checkout_token=VALUES(checkout_token), cart_token=VALUES(cart_token), phone=VALUES(phone), email=VALUES(email), total=VALUES(total)',
            $id, ($o['name'] ?? null) ?: null, ($o['checkout_token'] ?? null) ?: null, ($o['cart_token'] ?? null) ?: null,
            Logic::normPhone(($o['phone'] ?? null) ?: (($a['phone'] ?? null) ?: (($cu['phone'] ?? null) ?: ''))) ?: null,
            strtolower($this->str(($o['email'] ?? null) ?: (($cu['email'] ?? null) ?: ''))) ?: null,
            $this->num($o['total_price'] ?? 0), $this->toUtc($o['created_at'] ?? null) ?: $this->utcNow());
    }

    /* ================================================================ practice data (demo mode) */

    private function demoSync(): void
    {
        $demo = (bool) $this->setting('demo');
        if ($demo === $this->demoState) {
            return;
        }
        $this->demoState = $demo;
        if (! $demo) {
            Db::run("DELETE FROM ab_events WHERE checkout_id LIKE 'demo-%'");
            Db::run("DELETE FROM ab_checkouts WHERE id LIKE 'demo-%'");
            return;
        }
        if (Db::get("SELECT 1 FROM ab_checkouts WHERE id LIKE 'demo-%' LIMIT 1")) {
            return;
        }
        $prods = Db::all("SELECT sku,title,size,price,image,qty FROM products WHERE variant_id LIKE 'demo%' AND qty>0 ORDER BY variant_id LIMIT 20");
        $sold = Db::get("SELECT sku,title,size,price FROM products WHERE variant_id LIKE 'demo%' AND COALESCE(qty,0)<=0 LIMIT 1");
        if (! $prods) {
            return;
        }
        $names = ['Ayesha Khan', 'Bilal Ahmed', 'Hira Siddiqui', 'Usman Tariq', 'Mahnoor Ali', 'Fahad Iqbal', 'Sana Javed', 'Hamza Raza', 'Zainab Noor', 'Ali Haider', 'Areeba Shah', 'Saad Malik'];
        $cities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Peshawar'];
        $plan = [[0.6, 'new'], [0.9, 'new'], [2, 'new'], [3.5, 'new'], [5, 'new'], [9, 'new'], [26, 'new'], [0.2, 'new'], [6, 'contacted', 'no_answer'], [20, 'contacted', 'will_order'], [30, 'recovered'], [52, 'recovered'], [40, 'lost']];
        $owner = Db::get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
        $np = count($prods);
        foreach ($plan as $i => $pl) {
            [$hrs, $st] = $pl;
            $oc = $pl[2] ?? null;
            $its = [$prods[$i % $np]];
            if ($i % 3 === 1) {
                $its[] = $prods[($i + 5) % $np];
            }
            if ($i === 2 && $sold) {
                array_unshift($its, $sold);
            }
            $at = gmdate('Y-m-d H:i:s', (int) floor(time() - $hrs * 3600));
            $items = array_map(fn ($p) => ['title' => $p['title'], 'sku' => $p['sku'], 'size' => ($p['size'] ?? null) ?: '', 'price' => $this->numOut($this->num($p['price'])), 'qty' => 1, 'image' => ($p['image'] ?? null) ?: null], $its);
            $total = array_sum(array_column($items, 'price')) + 199;
            $id = 'demo-'.($i + 1);
            $nm = $names[$i % count($names)];
            Db::run('INSERT IGNORE INTO ab_checkouts(id,token,created_at,updated_at,name,phone,email,city,items,total,url,status,src,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',
                $id, 'demotok'.($i + 1), $at, $at, $nm, '0399'.substr((string) (1000000 + $i * 73517), -7), strtolower(explode(' ', $nm)[0]).'@example.com', $cities[$i % count($cities)],
                json_encode($items, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $total, 'https://sundaybazar.pk/checkouts/demo'.($i + 1).'/recover', 'new', 'demo');
            $by = $owner ? $owner['id'] : null;
            $cAt = gmdate('Y-m-d H:i:s', (int) floor(time() - ($hrs - 0.3) * 3600));
            if ($st === 'contacted') {
                Db::run('UPDATE ab_checkouts SET status=?, contacted_by=?, contacted_at=?, contacts=1, last_outcome=? WHERE id=?', 'contacted', $by, $cAt, $oc, $id);
            }
            if ($st === 'recovered') {
                Db::run("UPDATE ab_checkouts SET status='recovered', contacted_by=?, contacted_at=?, contacts=1, last_outcome='will_order', recovered_value=?, recovered_at=?, recovered_by=?, recovered_how='Same phone within 7 days', recovered_name=? WHERE id=?",
                    $by, $cAt, $total, $cAt, $by, 'SB'.(84000 + $i), $id);
            }
            if ($st === 'lost') {
                Db::run("UPDATE ab_checkouts SET status='lost', contacted_by=?, contacted_at=?, contacts=2, last_outcome='not_interested', lost_reason='Not interested', lost_at=?, lost_by=? WHERE id=?", $by, $cAt, $cAt, $by, $id);
            }
        }
    }

    /* ================================================================ Shopify REST sync (every 30 min + "Sync now") */

    private function syncNow(): array
    {
        $this->need($this->shopify()->configured(), 'Shopify is not connected (Settings → Shopify)');
        $since = $this->setting('abandoned.sync_at', null) ?: $this->isoMs((time() - 7 * 86400) * 1000.0);
        $sinceMs = $this->ms($since) ?? (time() - 7 * 86400) * 1000.0;
        $min = $this->isoMs($sinceMs - 3600e3);
        $n = 0;
        $newest = $since;
        $newestMs = $sinceMs;
        $next = 'checkouts.json';
        $query = ['status' => 'open', 'limit' => 250, 'updated_at_min' => $min];
        for ($page = 0; $next && $page < 20; $page++) {
            if ($page > 0) {
                // restGet($url) with an empty query array drops the URL's own query string (page_info): pass it explicitly
                $parts = explode('?', $next, 2);
                $next = $parts[0];
                $query = [];
                parse_str($parts[1] ?? '', $query);
            }
            try {
                [$j, $nextUrl] = $this->shopify()->restGet($next, $query);
            } catch (ShopifyException $e) {
                $st = $e->httpStatus;
                if (! $st) {
                    throw new \RuntimeException('Shopify checkouts: '.$e->getMessage(), 0, $e);
                }
                $body = preg_replace('/^Shopify \d+( \(the app is missing a permission\))? /', '', $e->getMessage());
                throw new \RuntimeException('Shopify checkouts: '.$st.($st === 403 ? ' (the app needs the read_orders scope)' : '').' '.mb_substr($body, 0, 120), 0, $e);
            }
            foreach ($this->arr($j['checkouts'] ?? []) as $co) {
                $this->ingest($co, 'sync');
                $n++;
                $u = $this->ms($co['updated_at'] ?? null);
                if ($u !== null && $u > $newestMs) {
                    $newestMs = $u;
                    $newest = $this->isoMs($u);
                }
            }
            $next = $nextUrl;
        }
        $this->setSetting('abandoned.sync_at', $newest);
        $this->setSetting('abandoned.last_sync', ['at' => $this->utcNow(), 'n' => $n, 'ok' => true]);
        $rec = $this->matchOrders();
        return ['fetched' => $n, 'recovered' => $rec];
    }

    private function expireOld(): void
    {
        Db::run("UPDATE ab_checkouts SET status='lost', lost_reason='Expired (no contact in 14 days)', lost_at=UTC_TIMESTAMP() WHERE status='new' AND updated_at < (UTC_TIMESTAMP() - INTERVAL 14 DAY)");
    }

    /** the 30-minute job */
    public function job(): void
    {
        $this->demoSync();
        $this->expireOld();
        if ($this->shopify()->configured() && ! $this->setting('demo')) {
            try {
                $this->syncNow();
            } catch (\Throwable $e) {
                $this->setSetting('abandoned.last_sync', ['at' => $this->utcNow(), 'ok' => false, 'error' => $e->getMessage()]);
                $this->syncLog('abandoned', false, $e->getMessage());
            }
        } else {
            $this->matchOrders();
        }
    }

    /* ================================================================ webhook */

    public function hook(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $raw = $req->getContent();
        $verifier = app(WebhookVerifier::class);
        $secret = (string) ($this->cfg()['webhookSecret'] ?: '');
        $sent = (string) $req->header('X-Shopify-Hmac-Sha256', '');
        $okSig = $verifier->valid($req)
            || ($secret !== '' && $sent !== '' && hash_equals(base64_encode(hash_hmac('sha256', $raw, $secret, true)), $sent));
        $this->need($okSig, ($secret !== '' || $verifier->secrets()) ? 'Bad signature' : 'Webhook secret not set', 401);
        $topic = (string) $req->header('X-Shopify-Topic', '');
        if (preg_match('#^orders/#', $topic)) {
            $this->rememberOrder($b);
        } elseif (preg_match('#^checkouts/(create|update)$#', $topic) || ($topic === '' && ! empty($b['line_items']))) {
            $this->ingest($b, 'hook');
        }
        $this->setSetting('abandoned.last_hook', ['at' => $this->utcNow(), 'topic' => $topic]);
        $this->matchOrders();
        return ['ok' => true];
    }

    /* ================================================================ screen API */

    private function baseUrl(Request $req): string
    {
        $pub = $this->setting('inbox.public_url', '');
        $proto = $req->header('x-forwarded-proto') ?: 'http';
        $host = $req->header('x-forwarded-host') ?: ($req->header('host') ?: 'localhost');
        return preg_replace('#/+$#', '', $pub ?: "{$proto}://{$host}");
    }

    private function soldOut(array $skus): array
    {
        $out = [];
        $list = array_values(array_unique(array_filter($skus, fn ($s) => $this->truthy($s))));
        if (! $list) {
            return $out;
        }
        foreach (Db::all('SELECT sku, SUM(COALESCE(qty,0)) n FROM products WHERE sku IN ('.Db::marks($list).') GROUP BY sku', ...$list) as $r) {
            if ($r['n'] <= 0) {
                $out[(string) $r['sku']] = true;
            }
        }
        return $out;
    }

    private function skusOf($items): array
    {
        return array_map(fn ($i) => is_array($i) ? ($i['sku'] ?? null) : null, $this->arr($this->J($items, [])));
    }

    private function shape(array $r, ?array $u, array $so): array
    {
        $items = $this->arr($this->J($r['items'], []));
        foreach ($items as &$it) {
            $it['soldOut'] = isset($so[(string) ($it['sku'] ?? '')]) && ($it['sku'] ?? null) !== null;
        }
        unset($it);
        $all = true;
        $any = false;
        foreach ($items as $it) {
            $all = $all && $it['soldOut'];
            $any = $any || $it['soldOut'];
        }
        return array_merge($r, [
            'phone' => $this->mask($u, $r['phone']),
            'wa' => $r['phone'] ? Logic::waNumber($r['phone']) : null,
            'items' => $items,
            'allSoldOut' => count($items) > 0 && $all,
            'anySoldOut' => $any,
            'contacted_name' => $this->userName($r['contacted_by']),
            'recovered_name_by' => $this->userName($r['recovered_by']),
            'lost_by_name' => $this->userName($r['lost_by']),
            'outcome_label' => self::OUTCOMES[$r['last_outcome'] ?? ''] ?? null,
        ]);
    }

    private function tabCounts(): array
    {
        $r = Db::get("SELECT SUM(status='new' AND updated_at<=?) `new`, SUM(status='contacted') contacted, SUM(status='recovered') recovered, SUM(status='lost') lost FROM ab_checkouts", $this->ageCut());
        foreach ($r as $k => $v) {
            $r[$k] = $v ?: 0;
        }
        return $r;
    }

    public function listCarts(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->demoSync();
        $this->matchOrders();
        $tab = isset(self::TABS[$qs['tab'] ?? '']) ? $qs['tab'] : 'new';
        $w = [self::TABS[$tab]];
        $a = [];
        if ($tab === 'new') {
            $w[] = 'updated_at<=?';
            $a[] = $this->ageCut();
        }
        if (! empty($qs['q']) && is_string($qs['q'])) {
            $t = '%'.trim($qs['q']).'%';
            $ph = Logic::normPhone($qs['q']);
            $w[] = '(name LIKE ? OR email LIKE ? OR items LIKE ? OR city LIKE ?'.(strlen($ph) >= 6 ? ' OR phone LIKE ?' : '').')';
            array_push($a, $t, $t, $t, $t);
            if (strlen($ph) >= 6) {
                $a[] = '%'.$ph.'%';
            }
        }
        $order = $tab === 'new' ? 'updated_at ASC' : ($tab === 'contacted' ? 'contacted_at DESC' : ($tab === 'recovered' ? 'recovered_at DESC' : 'COALESCE(lost_at,updated_at) DESC'));
        $rows = Db::all('SELECT * FROM ab_checkouts WHERE '.implode(' AND ', $w)." ORDER BY {$order} LIMIT 200", ...$a);
        $skus = [];
        foreach ($rows as $r) {
            array_push($skus, ...$this->skusOf($r['items']));
        }
        $so = $this->soldOut($skus);
        $today = $this->pkToday();
        $month = substr($today, 0, 7);
        $rec = Db::get("SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND DATE_FORMAT(recovered_at + INTERVAL 5 HOUR,'%Y-%m')=?", $month);
        $mine = Db::get("SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND recovered_by=? AND DATE_FORMAT(recovered_at + INTERVAL 5 HOUR,'%Y-%m')=?", $u['id'], $month);
        $chased = (int) Db::val("SELECT COUNT(*) n FROM ab_checkouts WHERE contacted_by IS NOT NULL AND DATE_FORMAT(contacted_at + INTERVAL 5 HOUR,'%Y-%m')=?", $month);
        $myToday = (int) Db::val("SELECT COUNT(*) n FROM events WHERE user_id=? AND action='abandoned.contact' AND DATE(at + INTERVAL 5 HOUR)=?", $u['id'], $today);
        $late = (int) Db::val("SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=(UTC_TIMESTAMP() - INTERVAL 3 HOUR)");
        $c = $this->cfg();
        $inbox = $this->svc('inbox');
        $wa = (bool) ($inbox && method_exists($inbox, 'waReady') && $inbox->waReady());
        return [
            'tab' => $tab,
            'rows' => array_map(fn ($r) => $this->shape($r, $u, $so), $rows),
            'counts' => $this->tabCounts(),
            'stats' => ['recoveredMonth' => $rec['n'], 'recoveredValue' => $rec['v'], 'mineMonth' => $mine['n'], 'mineValue' => $mine['v'], 'chasedMonth' => $chased, 'myToday' => $myToday, 'late' => $late],
            'setup' => ['shopify' => $this->shopify()->configured(), 'demo' => (bool) $this->setting('demo'), 'lastSync' => $this->setting('abandoned.last_sync', null), 'lastHook' => $this->setting('abandoned.last_hook', null),
                'cequens' => $wa, 'waTemplate' => $c['waTemplate'], 'canSetup' => $this->can($u, 'settings') || $this->can($u, 'inbox_admin'), 'hookUrl' => $this->baseUrl($req).'/api/hooks/shopify/checkouts'],
            'outcomes' => self::OUTCOMES, 'lostReasons' => self::LOST_REASONS,
        ];
    }

    private function getC($id): array
    {
        $c = Db::get('SELECT * FROM ab_checkouts WHERE id=?', (string) $id);
        $this->need($c, 'Cart not found', 404);
        return $c;
    }

    public function showCart(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $so = $this->soldOut($this->skusOf($c['items']));
        $ev = Db::all('SELECT e.*, us.name `user` FROM ab_events e LEFT JOIN users us ON us.id=e.user_id WHERE e.checkout_id=? ORDER BY e.id DESC LIMIT 50', $c['id']);
        return ['cart' => $this->shape($c, $u, $so), 'events' => array_map(fn ($e) => array_merge($e, ['outcome_label' => self::OUTCOMES[$e['outcome'] ?? ''] ?? null]), $ev)];
    }

    private function touch(array $c, array $u, string $via, ?string $outcome, ?string $note): void
    {
        Db::run("UPDATE ab_checkouts SET status=CASE WHEN status IN ('new','contacted') THEN 'contacted' ELSE status END, contacted_by=?, contacted_at=UTC_TIMESTAMP(), contacts=contacts+1, last_outcome=COALESCE(?,last_outcome) WHERE id=?",
            $u['id'], $outcome ?: null, $c['id']);
        Db::run('INSERT INTO ab_events(checkout_id,user_id,kind,outcome,note,at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())', $c['id'], $u['id'], $via, $outcome ?: null, $note ?: null);
        $d = ['via' => $via];
        if ($outcome) {
            $d['outcome'] = $outcome;
        }
        $d['name'] = $c['name'];
        $this->log($u['id'], 'abandoned.contact', 'abandoned:'.$c['id'], $d);
    }

    private function message(array $c): string
    {
        $items = implode(', ', array_map(fn ($i) => $this->str($i['title'] ?? null).(! empty($i['size']) ? ' (size '.$i['size'].')' : ''), $this->arr($this->J($c['items'], [])))) ?: 'apna pair';
        $first = preg_split('/\s+/', trim((string) ($c['name'] ?? '')))[0] ?: 'Sir/Madam';
        $msg = $this->str($this->cfg()['waMessage'] ?: self::DEF_MSG);
        return str_replace(['{name}', '{items}', '{link}', '{total}'], [$first, $items, (string) ($c['url'] ?: ''), 'Rs '.number_format(Logic::jsRound($c['total'] ?: 0), 0, '.', ',')], $msg);
    }

    public function whatsapp(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $this->need($c['phone'], 'This cart has no phone number');
        $this->need(in_array($c['status'], ['new', 'contacted'], true), 'This cart is already closed');
        $s = $this->cfg();
        $inbox = $this->svc('inbox');
        if ($s['waTemplate'] && $inbox && method_exists($inbox, 'waReady') && $inbox->waReady() && ! str_starts_with((string) $c['id'], 'demo-')) {
            $first = preg_split('/\s+/', trim((string) ($c['name'] ?? '')))[0] ?: 'Customer';
            $items = mb_substr(implode(', ', array_map(fn ($i) => $this->str($i['title'] ?? null), $this->arr($this->J($c['items'], [])))), 0, 200);
            $inbox->sendWhatsApp($c['phone'], ['template' => $s['waTemplate'], 'params' => [$first, $items, $c['url'] ?: '']], $u['id']);
            $this->touch($c, $u, 'whatsapp', null, 'Template '.$s['waTemplate'].' sent');
            return ['sent' => true];
        }
        $this->touch($c, $u, 'whatsapp', null, 'WhatsApp opened (wa.me)');
        $m = $this->message($c);
        return ['link' => 'https://wa.me/'.Logic::waNumber($c['phone']).'?text='.$this->encodeURIComponent($m), 'text' => $m];
    }

    public function call(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $oc = $b['outcome'] ?? null;
        $this->need(is_string($oc) && isset(self::OUTCOMES[$oc]), 'Choose what the customer said');
        $this->need(in_array($c['status'], ['new', 'contacted'], true), 'This cart is already closed');
        $note = $this->truthy($b['note'] ?? null) ? mb_substr($this->str($b['note']), 0, 500) : null;
        $this->touch($c, $u, 'call', $oc, $note);
        if ($note !== null) {
            Db::run('UPDATE ab_checkouts SET note=? WHERE id=?', $note, $c['id']);
        }
        $lost = false;
        if ($oc === 'not_interested' || $oc === 'wrong_number') {
            Db::run("UPDATE ab_checkouts SET status='lost', lost_reason=?, lost_at=UTC_TIMESTAMP(), lost_by=? WHERE id=?", self::OUTCOMES[$oc], $u['id'], $c['id']);
            $lost = true;
        }
        return ['ok' => true, 'lost' => $lost];
    }

    public function note(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $note = mb_substr(trim($this->str(($b['note'] ?? null) ?: '')), 0, 500);
        $this->need($note !== '', 'Write a note');
        Db::run('UPDATE ab_checkouts SET note=? WHERE id=?', $note, $c['id']);
        Db::run('INSERT INTO ab_events(checkout_id,user_id,kind,note,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $c['id'], $u['id'], 'note', $note);
        $this->log($u['id'], 'abandoned.note', 'abandoned:'.$c['id'], mb_substr($note, 0, 80));
        return ['ok' => true];
    }

    public function lost(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $this->need(in_array($c['status'], ['new', 'contacted'], true), 'This cart is already closed');
        $reason = mb_substr($this->str(($b['reason'] ?? null) ?: 'Other'), 0, 120);
        Db::run("UPDATE ab_checkouts SET status='lost', lost_reason=?, lost_at=UTC_TIMESTAMP(), lost_by=? WHERE id=?", $reason, $u['id'], $c['id']);
        Db::run('INSERT INTO ab_events(checkout_id,user_id,kind,note,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $c['id'], $u['id'], 'lost', $reason);
        $this->log($u['id'], 'abandoned.lost', 'abandoned:'.$c['id'], $reason);
        return ['ok' => true];
    }

    public function reopen(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id']);
        $this->need($c['status'] === 'lost', 'Only lost carts can be reopened');
        Db::run("UPDATE ab_checkouts SET status=CASE WHEN contacted_by IS NULL THEN 'new' ELSE 'contacted' END, lost_reason=NULL, lost_at=NULL, lost_by=NULL WHERE id=?", $c['id']);
        Db::run('INSERT INTO ab_events(checkout_id,user_id,kind,at) VALUES(?,?,?,UTC_TIMESTAMP())', $c['id'], $u['id'], 'reopen');
        $this->log($u['id'], 'abandoned.reopen', 'abandoned:'.$c['id'], '');
        return ['ok' => true];
    }

    public function sync(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        if ($this->setting('demo')) {
            $this->demoSync();
            return ['fetched' => 0, 'recovered' => $this->matchOrders(), 'demo' => true];
        }
        try {
            $r = $this->syncNow();
            $this->log($u['id'], 'abandoned.sync', 'abandoned', $r);
            return $r;
        } catch (\Throwable $e) {
            $this->setSetting('abandoned.last_sync', ['at' => $this->utcNow(), 'ok' => false, 'error' => $e->getMessage()]);
            throw $e;
        }
    }

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->cfg();
        return ['waTemplate' => $c['waTemplate'], 'waMessage' => $c['waMessage'], 'hasSecret' => $this->truthy($c['webhookSecret']), 'defaultMessage' => self::DEF_MSG];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'settings') || $this->can($u, 'inbox_admin'), 'Only the owner can change this', 403);
        $c = $this->cfg();
        if (array_key_exists('waTemplate', $b)) {
            $c['waTemplate'] = mb_substr(trim($this->str(($b['waTemplate'] ?? null) ?: '')), 0, 80);
        }
        if (array_key_exists('waMessage', $b)) {
            $c['waMessage'] = mb_substr(trim($this->str(($b['waMessage'] ?? null) ?: '')), 0, 1000) ?: self::DEF_MSG;
        }
        if ($this->truthy($b['webhookSecret'] ?? null)) {
            $c['webhookSecret'] = trim($this->str($b['webhookSecret']));
        }
        if ($this->truthy($b['clearSecret'] ?? null)) {
            $c['webhookSecret'] = '';
        }
        $this->setSetting('abandoned.cfg', $c);
        $this->log($u['id'], 'abandoned.settings', 'settings', ['waTemplate' => $c['waTemplate']]);
        return ['ok' => true];
    }

    /* ================================================================ services */

    /** recovered carts credited to a user between PK days [from, to] */
    public function recoveredBy($userId, $from, $to): array
    {
        $r = Db::get("SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND recovered_by=? AND DATE(recovered_at + INTERVAL 5 HOUR)>=? AND DATE(recovered_at + INTERVAL 5 HOUR)<=?", $userId, $from, $to);
        return ['n' => $r['n'] ?: 0, 'value' => $r['v'] ?: 0];
    }

    public function summary(): array
    {
        $c = $this->tabCounts();
        return ['new' => $c['new'], 'contacted' => $c['contacted'],
            'recoveredMonth' => (int) Db::val("SELECT COUNT(*) n FROM ab_checkouts WHERE status='recovered' AND DATE_FORMAT(recovered_at + INTERVAL 5 HOUR,'%Y-%m')=?", substr($this->pkToday(), 0, 7))];
    }

    /* ================================================================ sidebar counts & alerts */

    public function counts(array $u): array
    {
        if (! $this->can($u, 'abandoned')) {
            return [];
        }
        $this->demoSync();
        return ['abandoned' => (int) Db::val("SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=?", $this->ageCut())];
    }

    public function alerts(array $u): array
    {
        if (! $this->can($u, 'abandoned')) {
            return [];
        }
        $n = (int) Db::val("SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=(UTC_TIMESTAMP() - INTERVAL 3 HOUR)");
        return $n > 20 ? [['level' => 'warn', 'text' => "{$n} abandoned carts not contacted for 3+ hours", 'href' => '#/abandoned']] : [];
    }
}
