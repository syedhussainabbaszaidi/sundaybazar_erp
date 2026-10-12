<?php

namespace App\Erp\Modules;

use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\ShopifyStatus;
use App\Services\Shopify\ShopifySync;
use App\Services\Shopify\ShopifyWriter;
use App\Services\Shopify\WebhookRegistrar;
use App\Services\Shopify\WebhookVerifier;
use Illuminate\Http\Request;

/** Shopify integration endpoints: webhook intake, connection status, review queue, write log, order cancel. */
class ShopifyModule extends Module
{
    public string $name = 'shopify';

    public function routes(Router $r): void
    {
        $r->post('/api/hooks/shopify', null, 'webhook');
        $r->get('/api/shopify/status', 'sync_view', 'status');
        $r->post('/api/shopify/webhooks', 'shopify_manage', 'registerWebhooks');
        $r->get('/api/shopify/issues', 'sync_view', 'issues');
        $r->post('/api/shopify/issues/:id/resolve', 'shopify_manage', 'resolveIssue');
        $r->get('/api/shopify/writes', 'sync_view', 'writes');
        $r->post('/api/shopify/reinstalled', 'shopify_manage', 'reinstalled');
        $r->post('/api/orders/:id/shopify-refresh', 'orders', 'refreshOrder');
        $r->post('/api/orders/:id/shopify-cancel', 'orders_cancel', 'cancelOrder');
        $r->post('/api/orders/:id/shopify-fulfil', 'orders_fulfil', 'fulfilOrder');
        $r->get('/api/orders/:id/shopify-refundable', 'orders_refund', 'refundable');
        $r->post('/api/orders/:id/shopify-refund', 'orders_refund', 'refundOrder');
        $r->post('/api/shopify/retry', 'sync_run', 'retryFailed');
    }

    /**
     * Shopify webhook intake: verify the HMAC signature, store the event once (keyed by X-Shopify-Webhook-Id),
     * answer 200 straight away and apply the change right after the answer has been sent.
     */
    public function webhook(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(app(WebhookVerifier::class)->valid($req), 'Bad signature', 401);
        $shop = strtolower((string) $req->header('X-Shopify-Shop-Domain'));
        $want = $this->shopify()->cfg()['shop'];
        $this->need($shop === '' || $want === '' || $shop === $want, 'Unknown shop', 401);
        $topic = (string) $req->header('X-Shopify-Topic');
        $wid = (string) ($req->header('X-Shopify-Webhook-Id') ?: $req->header('X-Shopify-Event-Id') ?: hash('sha256', $req->getContent()));
        $raw = $req->getContent();
        $payload = strlen($raw) <= 900000 ? $raw : json_encode(['id' => $b['id'] ?? null, 'admin_graphql_api_id' => $b['admin_graphql_api_id'] ?? null, 'order_id' => $b['order_id'] ?? null,
            'inventory_item_id' => $b['inventory_item_id'] ?? null, 'location_id' => $b['location_id'] ?? null, 'available' => $b['available'] ?? null, 'updated_at' => $b['updated_at'] ?? null]);
        $res = Db::run('INSERT IGNORE INTO webhook_events(webhook_id,topic,shop_domain,resource_id,api_version,payload,status,triggered_at,received_at) VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',
            mb_substr($wid, 0, 100), mb_substr($topic, 0, 80), $shop ?: null, mb_substr((string) ($b['admin_graphql_api_id'] ?? $b['id'] ?? ''), 0, 64) ?: null,
            mb_substr((string) $req->header('X-Shopify-API-Version'), 0, 20) ?: null, $payload, 'received', $req->header('X-Shopify-Triggered-At') ?: null);
        if (! $res->changes) {
            return ['ok' => true, 'duplicate' => true]; // the same delivery again: already stored
        }
        // apply it right after Shopify has its 200 answer; if that fails, the minute clock retries it
        $eventId = $res->lastInsertRowid;
        \App\Erp\Defer::run(fn () => app(\App\Services\Shopify\WebhookProcessor::class)->process($eventId), 'shopify-webhook');
        return ['ok' => true];
    }

    public function status(): array
    {
        return ShopifyStatus::status() + ['webhookUrl' => app(WebhookRegistrar::class)->callbackUrl()];
    }

    public function registerWebhooks(?array $u): array
    {
        try {
            $r = app(WebhookRegistrar::class)->register();
        } catch (ShopifyException $e) {
            throw new HttpError(400, $e->getMessage());
        }
        $this->log($u['id'], 'shopify.webhooks', 'settings', $r);
        return $r;
    }

    public function issues(?array $u, array $b, array $p, array $qs): array
    {
        $st = ($qs['status'] ?? 'open') === 'all' ? '' : "WHERE status='open'";
        return Db::all("SELECT i.*, us.name resolver FROM sync_issues i LEFT JOIN users us ON us.id=i.resolved_by {$st} ORDER BY i.id DESC LIMIT 300");
    }

    public function resolveIssue(?array $u, array $b, array $p): array
    {
        $i = Db::get('SELECT * FROM sync_issues WHERE id=?', (int) $p['id']);
        $this->need($i, 'Not found', 404);
        Db::run("UPDATE sync_issues SET status='resolved', resolved_by=?, resolved_at=UTC_TIMESTAMP() WHERE id=?", $u['id'], $i['id']);
        $this->log($u['id'], 'shopify.issue.resolve', 'issue:'.$i['id'], $i['message']);
        return ['ok' => true];
    }

    public function writes(?array $u, array $b, array $p, array $qs): array
    {
        return Db::all('SELECT w.id,w.kind,w.target_id,w.status,w.error,w.at,us.name user FROM shopify_writes w LEFT JOIN users us ON us.id=w.user_id ORDER BY w.id DESC LIMIT 200');
    }

    public function reinstalled(?array $u): array
    {
        $this->shopify()->forgetToken();
        $d = $this->shopify()->shopInfo(); // proves the new installation works
        $this->setSetting('shopify_uninstalled', null);
        Db::run("UPDATE sync_issues SET status='resolved', resolved_by=?, resolved_at=UTC_TIMESTAMP() WHERE kind='uninstalled' AND status='open'", $u['id']);
        return ['ok' => true, 'shop' => $d['shop']];
    }

    public function refreshOrder(?array $u, array $b, array $p): array
    {
        $this->need(str_starts_with($p['id'], 'gid://shopify/Order/'), 'Not a Shopify order');
        try {
            app(ShopifySync::class)->refreshOrder($p['id']);
        } catch (ShopifyException $e) {
            throw new HttpError(400, $e->getMessage());
        }
        return Db::get('SELECT id,status,financial,fulfillment,cancelled_at,updated_at FROM orders WHERE id=?', $p['id']) ?? ['ok' => true];
    }

    private function shopifyOrder(array $p): array
    {
        $o = Db::get('SELECT * FROM orders WHERE id=?', $p['id']);
        $this->need($o, 'Not found', 404);
        $this->need(str_starts_with($o['id'], 'gid://shopify/Order/'), 'Not a Shopify order');
        return $o;
    }

    /** Re-read the order from Shopify and return what the ERP now shows (the confirmed state). */
    private function confirmed(string $id): array
    {
        try {
            app(ShopifySync::class)->refreshOrder($id);
        } catch (ShopifyException) {
        }
        return Db::get('SELECT id,status,financial,fulfillment,cancelled_at,total_refunded,received,outstanding,sh_ship_status FROM orders WHERE id=?', $id) ?? [];
    }

    /** Mark the order fulfilled in Shopify, with the courier tracking number when there is one. */
    public function fulfilOrder(?array $u, array $b, array $p): array
    {
        $o = $this->shopifyOrder($p);
        $this->need(! $o['cancelled_at'], 'The order is cancelled');
        $tracking = trim((string) (($b['tracking'] ?? '') ?: ($o['tracking'] ?? '')));
        $company = trim((string) (($b['company'] ?? '') ?: ($o['courier'] ?? ''))) ?: 'Other';
        $url = trim((string) ($b['url'] ?? '')) ?: null;
        $this->need($url === null || preg_match('#^https?://#', $url), 'The tracking link must start with http:// or https://');
        $r = app(ShopifyWriter::class)->createFulfillment($o['id'], $tracking, $company, $url, $u['id']);
        $this->log($u['id'], 'shopify.fulfil', 'order:'.$o['id'], ['tracking' => $tracking, 'company' => $company, 'ok' => $r['ok'], 'error' => $r['error']]);
        $this->need($r['ok'], 'Shopify did not accept it: '.$r['error'], 400);
        return ['ok' => true, 'fulfillment_id' => $r['fulfillment_id'], 'order' => $this->confirmed($o['id'])];
    }

    public function refundable(?array $u, array $b, array $p): array
    {
        $o = $this->shopifyOrder($p);
        try {
            $r = app(ShopifyWriter::class)->refundable($o['id']);
        } catch (ShopifyException $e) {
            throw new HttpError(400, $e->getMessage());
        }
        unset($r['parent']['id']);
        return $r;
    }

    /**
     * Refund money in Shopify to the original payment. Financially consequential: needs the orders_refund
     * permission, the typed word REFUND and a request id (a double click cannot refund twice).
     */
    public function refundOrder(?array $u, array $b, array $p): array
    {
        $o = $this->shopifyOrder($p);
        $this->need(($b['confirm'] ?? '') === 'REFUND', 'Type REFUND to confirm: this sends money back to the customer and cannot be undone');
        $amount = (float) ($b['amount'] ?? 0);
        $this->need($amount > 0, 'Enter the amount to refund', 422, ['field' => 'amount']);
        $note = trim((string) ($b['note'] ?? ''));
        $this->need($note !== '', 'Write the reason for the refund', 422, ['field' => 'note']);
        $req = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($b['request_id'] ?? '')) ?: bin2hex(random_bytes(8));
        try {
            $r = app(ShopifyWriter::class)->refund($o['id'], $amount, $note, $req, ! empty($b['notify']), $u['id']);
        } catch (ShopifyException $e) {
            $this->log($u['id'], 'shopify.refund.failed', 'order:'.$o['id'], ['amount' => $amount, 'error' => $e->getMessage()]);
            throw new HttpError(400, $e->getMessage());
        }
        $this->log($u['id'], 'shopify.refund', 'order:'.$o['id'], ['amount' => $amount, 'note' => $note, 'result' => $r]);
        return ['ok' => true, 'already' => ! empty($r['already']), 'order' => $this->confirmed($o['id'])];
    }

    /** Try failed work again now: failed webhook events and the syncs. */
    public function retryFailed(?array $u): array
    {
        Db::run("UPDATE webhook_events SET attempts=0, received_at=UTC_TIMESTAMP() - INTERVAL 5 MINUTE WHERE status='failed'");
        $n = app(\App\Services\Shopify\WebhookProcessor::class)->retryDue(500);
        $state = \App\Services\Shopify\SyncRunner::start('all', $u['id']);
        $this->log($u['id'], 'shopify.retry', 'settings', ['webhooks' => $n]);
        return ['ok' => true, 'webhooksRetried' => $n, 'stillFailed' => (int) Db::val("SELECT COUNT(*) FROM webhook_events WHERE status='failed'"), 'sync' => $state];
    }

    /**
     * Cancel the order in Shopify. Irreversible, so the browser must send confirm="CANCEL".
     * No refund is issued here. Orders already handed to a courier must have their booking cancelled first.
     */
    public function cancelOrder(?array $u, array $b, array $p): array
    {
        $o = Db::get('SELECT * FROM orders WHERE id=?', $p['id']);
        $this->need($o, 'Not found', 404);
        $this->need(str_starts_with($o['id'], 'gid://shopify/Order/'), 'Not a Shopify order');
        $this->need(($b['confirm'] ?? '') === 'CANCEL', 'Type CANCEL to confirm: this cancels the order in Shopify and cannot be undone');
        $this->need(! $o['cancelled_at'], 'Already cancelled');
        $this->need(! $o['tracking'], 'This order has a courier booking ('.$o['tracking'].'). Cancel the booking first.');
        try {
            $r = app(ShopifyWriter::class)->cancelOrder($o['id'], strtoupper((string) (($b['reason'] ?? '') ?: 'CUSTOMER')), ($b['restock'] ?? true) !== false, mb_substr((string) ($b['note'] ?? ''), 0, 500) ?: null, $u['id']);
        } catch (ShopifyException $e) {
            throw new HttpError(400, $e->getMessage());
        }
        $this->log($u['id'], 'shopify.cancel', 'order:'.$o['id'], ['reason' => $b['reason'] ?? 'CUSTOMER', 'result' => $r]);
        // Shopify cancels asynchronously (a job): read back the real state instead of assuming it
        try {
            app(ShopifySync::class)->refreshOrder($o['id']);
        } catch (ShopifyException) {
        }
        $now = Db::get('SELECT cancelled_at, status FROM orders WHERE id=?', $o['id']);
        return ['ok' => true, 'cancelled' => (bool) $now['cancelled_at'], 'status' => $now['status'], 'pending' => ! $now['cancelled_at']];
    }
}
