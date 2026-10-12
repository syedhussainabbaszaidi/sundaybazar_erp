<?php

namespace Tests\Feature;

use App\Erp\Db;
use App\Services\Shopify\ShopifySync;
use Tests\Support\FakeShopify;
use Tests\TestCase;

/** Webhook signature check, duplicate deliveries, queued processing per topic (mocked Admin API). */
class ShopifyWebhookTest extends TestCase
{
    private function hook(string $topic, array $payload, ?string $secret = 'test-client-secret', array $headers = [])
    {
        $raw = json_encode($payload);
        $sig = $secret === null ? 'nope' : base64_encode(hash_hmac('sha256', $raw, $secret, true));
        return $this->call('POST', '/api/hooks/shopify', [], [], [], $this->transformHeadersToServerVars(array_merge([
            'X-Shopify-Topic' => $topic, 'X-Shopify-Hmac-Sha256' => $sig, 'X-Shopify-Shop-Domain' => 'test-shop.myshopify.com',
            'X-Shopify-Webhook-Id' => 'wh-'.md5($raw.$topic), 'X-Shopify-API-Version' => '2025-10', 'Content-Type' => 'application/json',
        ], $headers)), $raw);
    }

    public function test_rejects_a_bad_signature(): void
    {
        $fake = new FakeShopify;
        $this->hook('orders/updated', ['id' => 1], null)->assertStatus(401);
        $this->hook('orders/updated', ['id' => 1], 'wrong-secret')->assertStatus(401);
        $this->assertSame(0, (int) Db::val('SELECT COUNT(*) FROM webhook_events'));
        $this->assertSame([], $fake->calls);
    }

    public function test_rejects_another_shop(): void
    {
        new FakeShopify;
        $this->hook('orders/updated', ['id' => 1], 'test-client-secret', ['X-Shopify-Shop-Domain' => 'evil.myshopify.com'])->assertStatus(401);
    }

    public function test_order_update_fetches_the_latest_order_and_ignores_duplicates(): void
    {
        $fake = (new FakeShopify)->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(7001, ['displayFinancialStatus' => 'PAID'])]);
        $p = ['id' => 7001, 'admin_graphql_api_id' => 'gid://shopify/Order/7001', 'financial_status' => 'pending'];
        $this->hook('orders/updated', $p)->assertOk()->assertJson(['ok' => true]);
        $this->assertSame('PAID', Db::val('SELECT financial FROM orders WHERE id=?', 'gid://shopify/Order/7001'), 'state comes from the API, not the webhook body');
        $this->assertSame('done', Db::val('SELECT status FROM webhook_events'));
        // Shopify re-delivers the same webhook id
        $this->hook('orders/updated', $p)->assertOk()->assertJson(['duplicate' => true]);
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM webhook_events'));
        $this->assertCount(1, $fake->gqlCalls('order(id:$id){ id name'), 'duplicate not processed again');
    }

    public function test_cancelled_order_webhook_updates_cancellation_state(): void
    {
        (new FakeShopify)->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(7101, ['cancelledAt' => '2026-10-05T10:00:00Z', 'cancelReason' => 'CUSTOMER', 'updatedAt' => '2026-10-05T10:00:00Z'])]);
        $this->hook('orders/cancelled', ['id' => 7101, 'admin_graphql_api_id' => 'gid://shopify/Order/7101'])->assertOk();
        $o = Db::get('SELECT * FROM orders WHERE id=?', 'gid://shopify/Order/7101');
        $this->assertSame('cancelled', $o['status']);
        $this->assertSame('2026-10-05 10:00:00', $o['cancelled_at']);
    }

    public function test_fulfillment_webhook_refreshes_its_order(): void
    {
        $fake = (new FakeShopify)->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(7201, ['displayFulfillmentStatus' => 'FULFILLED'])]);
        $this->hook('fulfillments/create', ['id' => 55, 'order_id' => 7201])->assertOk();
        $this->assertSame('FULFILLED', Db::val('SELECT fulfillment FROM orders WHERE id=?', 'gid://shopify/Order/7201'));
        $this->assertSame('gid://shopify/Order/7201', $fake->gqlCalls('order(id:$id){ id name')[0][2]['id']);
    }

    public function test_order_deleted_in_shopify_is_flagged_not_deleted(): void
    {
        new FakeShopify;
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(7301));
        $this->hook('orders/delete', ['id' => 7301])->assertOk();
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM orders'));
        $this->assertSame(1, (int) Db::val("SELECT COUNT(*) FROM sync_issues WHERE kind='deleted_in_shopify' AND entity_id='gid://shopify/Order/7301'"));
    }

    public function test_product_update_and_delete(): void
    {
        (new FakeShopify)->on('product(id:$id){ id title', fn () => ['product' => FakeShopify::product(970, ['title' => 'Renamed'])]);
        $this->hook('products/update', ['id' => 970, 'admin_graphql_api_id' => 'gid://shopify/Product/970'])->assertOk();
        $this->assertSame('Renamed', Db::val('SELECT title FROM products WHERE product_id=?', 'gid://shopify/Product/970'));
        $this->hook('products/delete', ['id' => 970])->assertOk();
        $this->assertSame('DELETED', Db::val('SELECT status FROM products WHERE product_id=?', 'gid://shopify/Product/970'));
        $this->assertNotNull(Db::val('SELECT deleted_at FROM shopify_products WHERE id=?', 'gid://shopify/Product/970'));
    }

    public function test_inventory_level_webhook_updates_location_stock_and_total(): void
    {
        app(ShopifySync::class)->upsertProduct(FakeShopify::product(980)); // no API call
        $fake = (new FakeShopify)->on('inventoryItem(id', fn () => ['inventoryItem' => ['id' => 'gid://shopify/InventoryItem/9801', 'unitCost' => ['amount' => '1300'],
            'variants' => ['nodes' => [['id' => 'gid://shopify/ProductVariant/9801', 'inventoryQuantity' => 0, 'product' => ['id' => 'gid://shopify/Product/980']]]]]]);
        $this->hook('inventory_levels/update', ['inventory_item_id' => 9801, 'location_id' => 1, 'available' => 0, 'updated_at' => '2026-10-06T10:00:00+05:00'])->assertOk();
        $this->assertSame(0, (int) Db::val("SELECT available FROM inventory_levels WHERE inventory_item_id='gid://shopify/InventoryItem/9801' AND location_id='gid://shopify/Location/1'"));
        $p = Db::get('SELECT qty, cost, sold_at FROM products WHERE variant_id=?', 'gid://shopify/ProductVariant/9801');
        $this->assertSame(0, $p['qty']);
        $this->assertEquals(1300, $p['cost']);
        $this->assertNotNull($p['sold_at']);
    }

    public function test_app_uninstalled_stops_sync_and_raises_an_issue(): void
    {
        new FakeShopify;
        $this->hook('app/uninstalled', ['id' => 1, 'domain' => 'test-shop.myshopify.com'])->assertOk();
        $this->assertNotNull(\App\Erp\Settings::get('shopify_uninstalled'));
        $this->assertSame(1, (int) Db::val("SELECT COUNT(*) FROM sync_issues WHERE kind='uninstalled'"));
    }

    public function test_failed_processing_is_recorded_for_retry(): void
    {
        (new FakeShopify)->on('order(id:$id){ id name', fn () => \Illuminate\Support\Facades\Http::response(['errors' => [['message' => 'Internal error']]]));
        $this->hook('orders/updated', ['id' => 7401, 'admin_graphql_api_id' => 'gid://shopify/Order/7401'])->assertOk(); // acknowledged quickly
        $ev = Db::get('SELECT * FROM webhook_events');
        $this->assertSame('failed', $ev['status']);
        $this->assertStringContainsString('Internal error', $ev['error']);
    }
}
