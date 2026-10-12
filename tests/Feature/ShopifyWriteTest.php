<?php

namespace Tests\Feature;

use App\Erp\Db;
use App\Erp\Settings;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\ShopifySync;
use App\Services\Shopify\ShopifyWriter;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Tests\Support\FakeShopify;
use Tests\TestCase;

/** ERP -> Shopify writes: switches, audit log, idempotency, confirmation, permissions (mocked Admin API). */
class ShopifyWriteTest extends TestCase
{
    private function enable(string ...$w): void
    {
        foreach ($w as $k) {
            config(["shopify.write.{$k}" => true]);
        }
    }

    public function test_a_switched_off_write_sends_nothing(): void
    {
        config(['shopify.write.prices' => false]); // emergency stop in .env
        $fake = new FakeShopify;
        try {
            app(ShopifyWriter::class)->updatePrices([['product_id' => 'gid://shopify/Product/1', 'variant_id' => 'gid://shopify/ProductVariant/1', 'price' => 999, 'compare_at' => null]]);
            $this->fail('expected exception');
        } catch (ShopifyException $e) {
            $this->assertSame('config', $e->kind);
        }
        $this->assertSame([], $fake->gqlCalls());
        $this->assertSame(0, (int) Db::val('SELECT COUNT(*) FROM shopify_writes'));
    }

    public function test_price_update_is_sent_and_logged(): void
    {
        $this->enable('prices');
        $fake = (new FakeShopify)->on('productVariantsBulkUpdate', fn () => ['productVariantsBulkUpdate' => ['productVariants' => [], 'userErrors' => []]]);
        $r = app(ShopifyWriter::class)->updatePrices([['product_id' => 'gid://shopify/Product/1', 'variant_id' => 'gid://shopify/ProductVariant/1', 'price' => 2999, 'compare_at' => 3999]], 5);
        $this->assertTrue($r[0]['ok']);
        $vars = $fake->gqlCalls('productVariantsBulkUpdate')[0][2];
        $this->assertSame(['id' => 'gid://shopify/ProductVariant/1', 'price' => '2999', 'compareAtPrice' => '3999'], $vars['v'][0]);
        $w = Db::get('SELECT * FROM shopify_writes');
        $this->assertSame('ok', $w['status']);
        $this->assertSame(5, $w['user_id']);
    }

    public function test_shopify_validation_errors_are_returned_per_variant(): void
    {
        $this->enable('prices');
        (new FakeShopify)->on('productVariantsBulkUpdate', fn () => ['productVariantsBulkUpdate' => ['productVariants' => null, 'userErrors' => [['field' => ['price'], 'message' => 'Price must be positive']]]]);
        $r = app(ShopifyWriter::class)->updatePrices([['product_id' => 'gid://shopify/Product/1', 'variant_id' => 'gid://shopify/ProductVariant/1', 'price' => -1, 'compare_at' => null]]);
        $this->assertFalse($r[0]['ok']);
        $this->assertStringContainsString('Price must be positive', $r[0]['error']);
        $this->assertSame('failed', Db::val('SELECT status FROM shopify_writes'));
    }

    public function test_inventory_goes_to_the_chosen_location_only(): void
    {
        $this->enable('inventory');
        $fake = (new FakeShopify)->on('inventoryAdjustQuantities', fn () => ['inventoryAdjustQuantities' => ['inventoryAdjustmentGroup' => ['id' => 'g1'], 'userErrors' => []]]);
        try {
            app(ShopifyWriter::class)->adjustInventory('gid://shopify/InventoryItem/1', 1);
            $this->fail('no location chosen yet');
        } catch (ShopifyException $e) {
            $this->assertStringContainsString('stock location', $e->getMessage());
        }
        app(ShopifySync::class)->saveLocations([['id' => 'gid://shopify/Location/2', 'name' => 'Warehouse', 'isActive' => true]]);
        Settings::set('shopify_location', 'gid://shopify/Location/2');
        app(ShopifyWriter::class)->adjustInventory('gid://shopify/InventoryItem/1', 1, 'restock');
        $in = $fake->gqlCalls('inventoryAdjustQuantities')[0][2]['input'];
        $this->assertSame('gid://shopify/Location/2', $in['changes'][0]['locationId']);
        $this->assertSame(1, $in['changes'][0]['delta']);
        $this->assertSame('available', $in['name']);
    }

    public function test_fulfillment_is_created_once_even_when_asked_twice(): void
    {
        $this->enable('fulfillments');
        $fake = (new FakeShopify)
            ->on('fulfillments(first:20)', fn () => ['order' => ['fulfillments' => []]])
            ->on('fulfillmentOrders', fn () => ['order' => ['id' => 'gid://shopify/Order/1', 'fulfillmentOrders' => ['nodes' => [['id' => 'gid://shopify/FulfillmentOrder/1', 'status' => 'OPEN']]]]])
            ->on('fulfillmentCreate', fn () => ['fulfillmentCreate' => ['fulfillment' => ['id' => 'gid://shopify/Fulfillment/9', 'status' => 'SUCCESS'], 'userErrors' => []]]);
        $w = app(ShopifyWriter::class);
        $a = $w->createFulfillment('gid://shopify/Order/1', 'PX1', 'PostEx', 'https://postex.pk/tracking?cn=PX1');
        $b = $w->createFulfillment('gid://shopify/Order/1', 'PX1', 'PostEx');
        $this->assertTrue($a['ok']);
        $this->assertSame('gid://shopify/Fulfillment/9', $b['fulfillment_id']);
        $this->assertCount(1, $fake->gqlCalls('fulfillmentCreate'), 'no second fulfillment');
        $this->assertFalse($fake->gqlCalls('fulfillmentCreate')[0][2]['f']['notifyCustomer']);
    }

    public function test_uncertain_fulfillment_is_checked_in_shopify_before_sending_again(): void
    {
        $this->enable('fulfillments');
        $created = false;
        $fake = (new FakeShopify)
            ->on('fulfillments(first:20)', function () use (&$created) {
                return ['order' => ['fulfillments' => $created ? [['id' => 'gid://shopify/Fulfillment/5', 'status' => 'SUCCESS', 'trackingInfo' => [['number' => 'PX2']]]] : []]];
            })
            ->on('fulfillmentOrders', fn () => ['order' => ['fulfillmentOrders' => ['nodes' => [['id' => 'gid://shopify/FulfillmentOrder/1', 'status' => 'OPEN']]]]])
            ->on('fulfillmentCreate', function () use (&$created) {
                $created = true; // Shopify did it, but the answer is lost
                throw new ConnectionException('timed out');
            });
        $r1 = app(ShopifyWriter::class)->createFulfillment('gid://shopify/Order/2', 'PX2', 'PostEx');
        $this->assertFalse($r1['ok']);
        $this->assertSame('unknown', Db::val("SELECT status FROM shopify_writes WHERE kind='fulfillment'"));
        $r2 = app(ShopifyWriter::class)->createFulfillment('gid://shopify/Order/2', 'PX2', 'PostEx');
        $this->assertTrue($r2['ok']);
        $this->assertSame('gid://shopify/Fulfillment/5', $r2['fulfillment_id']);
        $this->assertCount(4, $fake->gqlCalls('fulfillmentCreate'), 'only the first attempt (with its network retries) sent the mutation');
        $this->assertSame('ok', Db::val("SELECT status FROM shopify_writes WHERE kind='fulfillment'"));
    }

    public function test_order_cancel_needs_permission_confirmation_and_switch(): void
    {
        $fake = (new FakeShopify)
            ->on('cancelledAt }', fn () => ['order' => ['id' => 'gid://shopify/Order/8001', 'cancelledAt' => null]])
            ->on('orderCancel', fn () => ['orderCancel' => ['job' => ['id' => 'gid://shopify/Job/1', 'done' => false], 'orderCancelUserErrors' => []]])
            ->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(8001, ['cancelledAt' => '2026-10-07T10:00:00Z', 'updatedAt' => '2026-10-07T10:00:00Z'])]);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(8001));
        $url = '/api/orders/'.rawurlencode('gid://shopify/Order/8001').'/shopify-cancel';

        $packer = $this->user('warehouse');
        $this->api('POST', $url, ['confirm' => 'CANCEL'], $packer)->assertStatus(403);

        $owner = $this->user('admin');
        $this->api('POST', $url, [], $owner)->assertStatus(400)->assertJsonFragment(['error' => 'Type CANCEL to confirm: this cancels the order in Shopify and cannot be undone']);
        config(['shopify.write.order_cancel' => false]);
        $this->api('POST', $url, ['confirm' => 'CANCEL'], $owner)->assertStatus(400); // switched off
        $this->assertSame([], $fake->gqlCalls('orderCancel'));

        $this->enable('order_cancel');
        $this->api('POST', $url, ['confirm' => 'CANCEL', 'reason' => 'CUSTOMER'], $owner)->assertOk()->assertJson(['cancelled' => true, 'status' => 'cancelled']);
        $vars = $fake->gqlCalls('orderCancel')[0][2];
        $this->assertSame('CUSTOMER', $vars['reason']);
        $this->assertFalse($vars['refund']['originalPaymentMethodsRefund'], 'no refund from the ERP');
        $this->api('POST', $url, ['confirm' => 'CANCEL'], $owner)->assertStatus(400)->assertJson(['error' => 'Already cancelled']);
    }

    public function test_dispatched_order_cannot_be_cancelled_from_the_erp(): void
    {
        $this->enable('order_cancel');
        new FakeShopify;
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(8101));
        Db::run("UPDATE orders SET tracking='PX9' WHERE id='gid://shopify/Order/8101'");
        $this->api('POST', '/api/orders/'.rawurlencode('gid://shopify/Order/8101').'/shopify-cancel', ['confirm' => 'CANCEL'], $this->user())->assertStatus(400)->assertJsonFragment(['error' => 'This order has a courier booking (PX9). Cancel the booking first.']);
    }

    public function test_price_apply_from_the_erp_only_changes_local_price_when_shopify_accepted(): void
    {
        $this->enable('prices');
        (new FakeShopify)->on('productVariantsBulkUpdate', fn () => ['productVariantsBulkUpdate' => ['productVariants' => [], 'userErrors' => [['field' => ['price'], 'message' => 'nope']]]]);
        app(ShopifySync::class)->upsertProduct(FakeShopify::product(990));
        $r = $this->api('POST', '/api/pricing/apply', ['items' => [['variant_id' => 'gid://shopify/ProductVariant/9901', 'price' => 2500]]], $this->user())->assertOk()->json();
        $this->assertSame(0, $r['ok']);
        $this->assertEquals(3299, Db::val('SELECT price FROM products WHERE variant_id=?', 'gid://shopify/ProductVariant/9901'), 'local price unchanged');
        $this->assertSame(0, (int) Db::val('SELECT pushed FROM price_changes'));
    }

    public function test_pricing_apply_requires_permission(): void
    {
        new FakeShopify;
        $this->api('POST', '/api/pricing/apply', ['items' => [['variant_id' => 'x', 'price' => 1]]], $this->user('lister'))->assertStatus(403);
    }
}
