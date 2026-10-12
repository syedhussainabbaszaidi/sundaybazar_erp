<?php

namespace App\Services\Shopify;

use App\Erp\Activity;
use App\Erp\Db;
use App\Erp\Erp;
use App\Erp\Settings;

/**
 * Applies one stored webhook event. Webhook bodies are only used to know WHAT changed: the current
 * state is fetched from the Admin API (webhooks can arrive late, twice or out of order), so applying
 * an event twice is harmless. Nothing here writes back to Shopify, so there are no sync loops.
 */
class WebhookProcessor
{
    public function __construct(private ShopifySync $sync, private ShopifyClient $shopify) {}

    private static function gid(string $type, $id): ?string
    {
        if ($id === null || $id === '') {
            return null;
        }
        return str_starts_with((string) $id, 'gid://') ? (string) $id : "gid://shopify/{$type}/{$id}";
    }

    /**
     * Events not applied yet: stored but never processed (2+ minutes old), or failed — retried with growing
     * pauses (1, 4, 9 … minutes) up to 10 times. Called by the minute clock.
     */
    public function retryDue(int $max = 100): int
    {
        $n = 0;
        foreach (Db::all("SELECT id FROM webhook_events WHERE (status='received' AND received_at < UTC_TIMESTAMP() - INTERVAL 2 MINUTE)
            OR (status='failed' AND attempts < 10 AND received_at < UTC_TIMESTAMP() - INTERVAL (attempts*attempts) MINUTE) ORDER BY id LIMIT ".(int) $max) as $ev) {
            try {
                $this->process((int) $ev['id']);
                $n++;
            } catch (\Throwable) {
                // stays failed with the error recorded; tried again later
            }
        }
        return $n;
    }

    public function process(int $eventId): string
    {
        $ev = Db::get('SELECT * FROM webhook_events WHERE id=?', $eventId);
        if (! $ev || in_array($ev['status'], ['done', 'skipped'], true)) {
            return $ev['status'] ?? 'missing';
        }
        Db::run('UPDATE webhook_events SET attempts=attempts+1 WHERE id=?', $eventId);
        $p = json_decode((string) $ev['payload'], true) ?: [];
        try {
            $status = $this->apply($ev['topic'], $p);
            Db::run('UPDATE webhook_events SET status=?, error=NULL, processed_at=UTC_TIMESTAMP() WHERE id=?', $status, $eventId);
            return $status;
        } catch (ShopifyException $e) {
            if ($e->kind === 'scope') { // e.g. customer webhooks without protected customer data access
                Db::run("UPDATE webhook_events SET status='skipped', error=?, processed_at=UTC_TIMESTAMP() WHERE id=?", mb_substr($e->getMessage(), 0, 2000), $eventId);
                return 'skipped';
            }
            Db::run("UPDATE webhook_events SET status='failed', error=? WHERE id=?", mb_substr($e->getMessage(), 0, 2000), $eventId);
            throw $e;
        } catch (\Throwable $e) {
            Db::run("UPDATE webhook_events SET status='failed', error=? WHERE id=?", mb_substr($e->getMessage(), 0, 2000), $eventId);
            throw $e;
        }
    }

    private function apply(string $topic, array $p): string
    {
        switch ($topic) {
            case 'orders/create':
            case 'orders/updated':
            case 'orders/cancelled':
            case 'orders/fulfilled':
            case 'orders/partially_fulfilled':
            case 'orders/paid':
            case 'orders/edited':
                $gid = $p['admin_graphql_api_id'] ?? self::gid('Order', $p['id'] ?? ($p['order_edit']['order_id'] ?? null));
                if (! $gid) {
                    return 'skipped';
                }
                $this->sync->refreshOrder($gid);
                return 'done';

            case 'orders/delete':
                $gid = self::gid('Order', $p['id'] ?? null);
                if ($gid && Db::get('SELECT id FROM orders WHERE id=?', $gid)) {
                    // ERP work (calls, picking, courier, COD) may hang on this order: flag it instead of deleting
                    ShopifyStatus::issue('deleted_in_shopify', 'order', $gid, 'Order was deleted in Shopify; it is kept in the ERP for review');
                }
                return 'done';

            case 'fulfillments/create':
            case 'fulfillments/update':
            case 'refunds/create':
                $gid = self::gid('Order', $p['order_id'] ?? null);
                if (! $gid) {
                    return 'skipped';
                }
                $this->sync->refreshOrder($gid);
                return 'done';

            case 'products/create':
            case 'products/update':
                $gid = $p['admin_graphql_api_id'] ?? self::gid('Product', $p['id'] ?? null);
                if (! $gid) {
                    return 'skipped';
                }
                $this->sync->refreshProduct($gid);
                return 'done';

            case 'products/delete':
                $gid = self::gid('Product', $p['id'] ?? null);
                if ($gid) {
                    $this->sync->markProductDeleted($gid);
                }
                return 'done';

            case 'inventory_levels/update':
            case 'inventory_levels/connect':
                $item = self::gid('InventoryItem', $p['inventory_item_id'] ?? null);
                $loc = self::gid('Location', $p['location_id'] ?? null);
                if (! $item || ! $loc) {
                    return 'skipped';
                }
                $this->sync->saveLevel($item, $loc, $p['available'] ?? null, null, null, $p['updated_at'] ?? null);
                $this->sync->refreshInventoryItem($item);
                return 'done';

            case 'inventory_levels/disconnect':
                $item = self::gid('InventoryItem', $p['inventory_item_id'] ?? null);
                $loc = self::gid('Location', $p['location_id'] ?? null);
                if ($item && $loc) {
                    Db::run('DELETE FROM inventory_levels WHERE inventory_item_id=? AND location_id=?', $item, $loc);
                    $this->sync->refreshInventoryItem($item);
                }
                return 'done';

            case 'inventory_items/update':
            case 'inventory_items/create':
                $gid = $p['admin_graphql_api_id'] ?? self::gid('InventoryItem', $p['id'] ?? null);
                if ($gid) {
                    $this->sync->refreshInventoryItem($gid);
                }
                return 'done';

            case 'customers/create':
            case 'customers/update':
                $gid = $p['admin_graphql_api_id'] ?? self::gid('Customer', $p['id'] ?? null);
                if (! $gid) {
                    return 'skipped';
                }
                $this->sync->refreshCustomer($gid);
                return 'done';

            case 'locations/create':
            case 'locations/update':
            case 'locations/delete':
                $this->sync->syncLocations();
                return 'done';

            case 'checkouts/create':
            case 'checkouts/update':
                $ab = Erp::svc('abandoned');
                if (! $ab || ! method_exists($ab, 'ingest')) {
                    return 'skipped';
                }
                $ab->ingest($p, 'hook');
                if (method_exists($ab, 'matchOrders')) {
                    $ab->matchOrders();
                }
                return 'done';

            case 'app/uninstalled':
                Settings::set('shopify_uninstalled', ['at' => gmdate('Y-m-d H:i:s')]);
                $this->shopify->forgetToken();
                ShopifyStatus::issue('uninstalled', 'app', null, 'The ERP app was uninstalled from the Shopify store. Install it again, then clear this flag in Settings.');
                Activity::sync('shopify', false, 'App uninstalled from Shopify');
                return 'done';
        }
        return 'skipped';
    }
}
