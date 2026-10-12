<?php

namespace Tests\Feature;

use App\Erp\Db;
use App\Erp\Settings;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\ShopifySync;
use App\Services\Shopify\SyncRunner;
use Illuminate\Support\Facades\Http;
use Tests\Support\FakeShopify;
use Tests\TestCase;

/** Product / order / customer / inventory import, pagination, duplicates and resume (mocked Admin API). */
class ShopifySyncTest extends TestCase
{
    public function test_imports_orders_with_line_items_over_several_pages_without_duplicates(): void
    {
        $fake = (new FakeShopify)->on('orders(first', fn ($v) => $v['after'] === null
            ? FakeShopify::page('orders', [FakeShopify::order(1001), FakeShopify::order(1002)], 'cursor-2')
            : FakeShopify::page('orders', [FakeShopify::order(1003, ['cancelledAt' => '2026-10-02T09:00:00Z', 'cancelReason' => 'CUSTOMER'])]));
        $sync = app(ShopifySync::class);
        $this->assertSame(3, $sync->syncOrders());
        $this->assertSame('cursor-2', $fake->gqlCalls('orders(first')[1][2]['after']);
        $o = Db::get('SELECT * FROM orders WHERE id=?', 'gid://shopify/Order/1001');
        $this->assertSame('#1001', $o['name']);
        $this->assertSame('03001234567', $o['phone'], 'phone normalised');
        $this->assertSame('Lahore', $o['city']);
        $this->assertEquals(3499, $o['total']);
        $this->assertSame('PENDING', $o['financial']);
        $this->assertSame('UNFULFILLED', $o['fulfillment']);
        $this->assertSame('2026-10-01 10:00:00', $o['created_at']);
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM order_items WHERE order_id=?', 'gid://shopify/Order/1001'));
        $this->assertSame('cancelled', Db::val('SELECT status FROM orders WHERE id=?', 'gid://shopify/Order/1003'), 'cancellation kept apart from ERP stage');
        $this->assertSame('CUSTOMER', Db::val('SELECT cancel_reason FROM orders WHERE id=?', 'gid://shopify/Order/1003'));
        $this->assertNotNull(Settings::get('orders_synced_at'));
        $this->assertSame(1, (int) Db::val("SELECT COUNT(*) FROM customers WHERE phone='03001234567'"), 'customer view rebuilt');

        // run again (incremental): the same orders come back -> still 3 orders, 3 items
        $sync->syncOrders();
        $this->assertSame(3, (int) Db::val('SELECT COUNT(*) FROM orders'));
        $this->assertSame(3, (int) Db::val('SELECT COUNT(*) FROM order_items'));
        $this->assertStringContainsString('updated_at:>=', $fake->gqlCalls('orders(first')[2][2]['q'], 'second run only asks for changes');
    }

    public function test_resync_keeps_erp_work_and_ignores_older_versions(): void
    {
        $sync = app(ShopifySync::class);
        $sync->upsertOrder(FakeShopify::order(2001));
        $id = 'gid://shopify/Order/2001';
        Db::run("UPDATE orders SET stage='confirmed', cs_note='called', cs_attempts=2 WHERE id=?", $id);
        Db::run('UPDATE order_items SET picked=1, picked_by=1 WHERE order_id=?', $id);

        // newer Shopify version: Shopify fields change, ERP fields stay
        $this->assertTrue($sync->upsertOrder(FakeShopify::order(2001, ['updatedAt' => '2026-10-03T10:00:00Z', 'displayFinancialStatus' => 'PAID', 'tags' => ['VIP']])));
        $o = Db::get('SELECT * FROM orders WHERE id=?', $id);
        $this->assertSame('PAID', $o['financial']);
        $this->assertSame('confirmed', $o['stage']);
        $this->assertSame('called', $o['cs_note']);
        $this->assertSame(2, $o['cs_attempts']);
        $this->assertSame(1, (int) Db::val('SELECT picked FROM order_items WHERE order_id=?', $id), 'pick progress kept');

        // an older (late) webhook version must not overwrite
        $this->assertFalse($sync->upsertOrder(FakeShopify::order(2001, ['updatedAt' => '2026-10-02T10:00:00Z', 'displayFinancialStatus' => 'PENDING'])));
        $this->assertSame('PAID', Db::val('SELECT financial FROM orders WHERE id=?', $id));
    }

    public function test_fulfillment_tracking_and_refunds_are_stored(): void
    {
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(3001, [
            'displayFulfillmentStatus' => 'FULFILLED', 'displayFinancialStatus' => 'PARTIALLY_REFUNDED', 'totalRefundedSet' => ['shopMoney' => ['amount' => '500.0']],
            'fulfillments' => [['id' => 'gid://shopify/Fulfillment/1', 'status' => 'SUCCESS', 'createdAt' => '2026-10-02T08:00:00Z', 'updatedAt' => '2026-10-02T08:00:00Z',
                'trackingInfo' => [['number' => 'PX123', 'company' => 'PostEx', 'url' => 'https://postex.pk/tracking?cn=PX123']], 'location' => ['id' => 'gid://shopify/Location/1']]],
            'refunds' => [['id' => 'gid://shopify/Refund/1', 'createdAt' => '2026-10-03T08:00:00Z', 'note' => 'damaged', 'totalRefundedSet' => ['shopMoney' => ['amount' => '500.0']]]],
        ]));
        $o = Db::get('SELECT * FROM orders WHERE id=?', 'gid://shopify/Order/3001');
        $this->assertSame('PX123', $o['tracking']);
        $this->assertSame('PostEx', $o['courier']);
        $this->assertSame('dispatched', $o['status']);
        $this->assertSame('2026-10-02 08:00:00', $o['dispatched_at']);
        $this->assertEquals(500, $o['total_refunded']);
        $this->assertSame('PX123', Db::val('SELECT tracking_number FROM order_fulfillments WHERE order_id=?', 'gid://shopify/Order/3001'));
        $this->assertEquals(500, Db::val('SELECT amount FROM order_refunds WHERE order_id=?', 'gid://shopify/Order/3001'));
    }

    public function test_more_than_fifty_line_items_are_fetched_in_extra_pages(): void
    {
        $item = fn ($i) => ['id' => "gid://shopify/LineItem/{$i}", 'title' => "Item {$i}", 'quantity' => 1, 'sku' => "SKU-{$i}", 'variant' => null, 'product' => null,
            'originalUnitPriceSet' => ['shopMoney' => ['amount' => '100']], 'discountedUnitPriceSet' => ['shopMoney' => ['amount' => '100']]];
        (new FakeShopify)->on('order(id:$id){ lineItems', fn () => ['order' => ['lineItems' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => array_map($item, range(51, 60))]]]);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(4001, ['lineItems' => ['pageInfo' => ['hasNextPage' => true, 'endCursor' => 'li-50'], 'nodes' => array_map($item, range(1, 50))]]));
        $this->assertSame(60, (int) Db::val('SELECT COUNT(*) FROM order_items WHERE order_id=?', 'gid://shopify/Order/4001'));
        $this->assertSame(60, (int) Db::val('SELECT items FROM orders WHERE id=?', 'gid://shopify/Order/4001'));
    }

    public function test_imports_products_variants_media_collections_and_inventory_item(): void
    {
        (new FakeShopify)->on('products(first', fn () => FakeShopify::page('products', [FakeShopify::product(900), FakeShopify::product(901, ['status' => 'ARCHIVED'])]));
        $this->assertSame(2, app(ShopifySync::class)->syncProducts());
        $p = Db::get('SELECT * FROM products WHERE variant_id=?', 'gid://shopify/ProductVariant/9001');
        $this->assertSame('EA-S-900', $p['sku']);
        $this->assertSame('EA', $p['rack']);
        $this->assertEquals(3299, $p['price']);
        $this->assertEquals(4999, $p['compare_at']);
        $this->assertEquals(1200, $p['cost']);
        $this->assertSame('42', $p['size']);
        $this->assertSame('Good', $p['cond']);
        $this->assertSame('Lot 12', $p['lot']);
        $this->assertSame('gid://shopify/InventoryItem/9001', $p['inventory_item']);
        $this->assertSame('ARCHIVED', Db::val('SELECT status FROM shopify_products WHERE id=?', 'gid://shopify/Product/901'), 'archival reflected');
        $this->assertSame(2, (int) Db::val('SELECT COUNT(*) FROM collection_product'));
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM shopify_collections'));
        $this->assertSame(2, (int) Db::val('SELECT COUNT(*) FROM product_media'));
        // re-import does not duplicate
        app(ShopifySync::class)->syncProducts();
        $this->assertSame(2, (int) Db::val('SELECT COUNT(*) FROM products'));
    }

    public function test_sold_out_variant_gets_sold_date_and_removed_variants_are_flagged(): void
    {
        $sync = app(ShopifySync::class);
        $sync->upsertProduct(FakeShopify::product(950));
        $sync->upsertProduct(FakeShopify::product(950, ['variants' => ['nodes' => [array_merge(FakeShopify::product(950)['variants']['nodes'][0], ['inventoryQuantity' => 0])]]]));
        $this->assertNotNull(Db::val('SELECT sold_at FROM products WHERE variant_id=?', 'gid://shopify/ProductVariant/9501'));
        $sync->upsertProduct(FakeShopify::product(950, ['variants' => ['nodes' => [array_merge(FakeShopify::product(950)['variants']['nodes'][0], ['id' => 'gid://shopify/ProductVariant/9502'])]]]));
        $this->assertSame('DELETED', Db::val('SELECT status FROM products WHERE variant_id=?', 'gid://shopify/ProductVariant/9501'));
    }

    public function test_interrupted_import_resumes_from_the_saved_cursor(): void
    {
        $fake = (new FakeShopify)->on('orders(first', function ($v, $n) {
            if ($v['after'] === null) {
                return FakeShopify::page('orders', [FakeShopify::order(5001)], 'c2');
            }
            if ($n === 2) {
                return Http::response(['errors' => [['message' => 'Internal error']]]); // a permanent failure on page 2
            }
            return FakeShopify::page('orders', [FakeShopify::order(5002)]);
        });
        try {
            app(ShopifySync::class)->syncOrders();
            $this->fail('expected failure');
        } catch (ShopifyException) {
        }
        $run = Db::get("SELECT * FROM sync_runs WHERE kind='orders' ORDER BY id DESC LIMIT 1");
        $this->assertSame('failed', $run['status']);
        $this->assertSame('c2', $run['cursor']);
        $this->assertNull(Settings::get('orders_synced_at'), 'checkpoint not moved forward by a failed run');

        $this->assertSame(2, app(ShopifySync::class)->syncOrders(), 'resumed: page 1 is not fetched again');
        $calls = $fake->gqlCalls('orders(first');
        $this->assertSame('c2', $calls[2][2]['after']);
        $this->assertCount(3, $calls);
        $this->assertSame(2, (int) Db::val('SELECT COUNT(*) FROM orders'));
    }

    public function test_first_import_resumes_with_its_own_query_later(): void
    {
        $fake = (new FakeShopify)->on('products(first', function ($v, $n) {
            if ($v['after'] === null) {
                return FakeShopify::page('products', [FakeShopify::product(801)], 'p2');
            }
            return $n === 2 ? Http::response(['errors' => [['message' => 'Internal error']]]) : FakeShopify::page('products', [FakeShopify::product(802)]);
        });
        try {
            app(ShopifySync::class)->syncProducts();
        } catch (ShopifyException) {
        }
        // the first import's date filter was computed when it started; pretend that was hours ago
        Db::run("UPDATE sync_runs SET `query`='created_at:>=''2025-01-01T00:00:00Z'' OR inventory_total:>0' WHERE kind='products'");
        $this->assertSame(2, app(ShopifySync::class)->syncProducts());
        $last = $fake->gqlCalls('products(first')[2][2];
        $this->assertSame('p2', $last['after'], 'continued from the saved cursor');
        $this->assertSame("created_at:>='2025-01-01T00:00:00Z' OR inventory_total:>0", $last['q'], 'with the query that cursor belongs to');
        $this->assertSame(1, (int) Db::val("SELECT COUNT(*) FROM sync_runs WHERE kind='products'"));
    }

    public function test_customer_import_is_skipped_cleanly_without_permission(): void
    {
        (new FakeShopify)->on('customers(first', fn () => Http::response(['errors' => [['message' => 'This app is not approved to access the Customer object.', 'extensions' => ['code' => 'ACCESS_DENIED']]]]));
        $this->assertSame(0, app(ShopifySync::class)->syncCustomers());
        $this->assertSame(1, (int) Db::val("SELECT COUNT(*) FROM sync_issues WHERE kind='missing_scope'"));
    }

    public function test_customers_import(): void
    {
        (new FakeShopify)->on('customers(first', fn () => FakeShopify::page('customers', [['id' => 'gid://shopify/Customer/1', 'firstName' => 'Ali', 'lastName' => 'Raza',
            'defaultEmailAddress' => ['emailAddress' => 'ali@example.com'], 'defaultPhoneNumber' => ['phoneNumber' => '+923211234567'], 'numberOfOrders' => '3', 'amountSpent' => ['amount' => '9000.0'],
            'state' => 'ENABLED', 'tags' => [], 'createdAt' => '2025-01-01T00:00:00Z', 'updatedAt' => '2026-01-01T00:00:00Z', 'defaultAddress' => ['city' => 'Karachi', 'province' => 'Sindh']]]));
        $this->assertSame(1, app(ShopifySync::class)->syncCustomers());
        $c = Db::get('SELECT * FROM shopify_customers');
        $this->assertSame('03211234567', $c['phone']);
        $this->assertSame(3, $c['orders_count']);
    }

    public function test_location_level_inventory(): void
    {
        (new FakeShopify)
            ->on('locations(first', fn () => ['locations' => ['nodes' => [['id' => 'gid://shopify/Location/1', 'name' => 'Warehouse', 'isActive' => true, 'fulfillsOnlineOrders' => true, 'address' => ['city' => 'Karachi']],
                ['id' => 'gid://shopify/Location/2', 'name' => 'Outlet', 'isActive' => true, 'fulfillsOnlineOrders' => false, 'address' => ['city' => 'Karachi']]]]])
            ->on('inventoryLevels', fn ($v) => ['location' => ['inventoryLevels' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => [
                ['updatedAt' => '2026-10-01T00:00:00Z', 'item' => ['id' => 'gid://shopify/InventoryItem/9001'], 'quantities' => [['name' => 'available', 'quantity' => $v['id'] === 'gid://shopify/Location/1' ? 3 : 1], ['name' => 'on_hand', 'quantity' => 4], ['name' => 'committed', 'quantity' => 1]]]]]]]);
        $this->assertSame(2, app(ShopifySync::class)->syncInventoryLevels());
        $this->assertSame(3, (int) Db::val("SELECT available FROM inventory_levels WHERE location_id='gid://shopify/Location/1'"));
        $this->assertSame(1, (int) Db::val("SELECT available FROM inventory_levels WHERE location_id='gid://shopify/Location/2'"));
        $this->assertSame(2, (int) Db::val('SELECT COUNT(*) FROM shopify_locations'));
    }

    public function test_sync_now_is_done_by_the_minute_clock_without_a_queue_worker(): void
    {
        (new FakeShopify)
            ->on('orders(first', fn () => FakeShopify::page('orders', [FakeShopify::order(6001)]))
            ->on('products(first', fn () => FakeShopify::page('products', [FakeShopify::product(960)]));
        $admin = $this->user();
        $this->api('POST', '/api/sync', ['kind' => 'all'], $admin)->assertOk()->assertJson(['queued' => true]);
        $this->artisan('erp:tick')->assertSuccessful();
        $this->assertFalse(SyncRunner::state()['running']);
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM orders'));
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM shopify_products'));
        $this->assertArrayHasKey('orders', Settings::get('shopify_last_ok'));
        $this->assertFalse(SyncRunner::state()['queued']);
    }
}
