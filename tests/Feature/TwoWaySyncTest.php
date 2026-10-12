<?php

namespace Tests\Feature;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Settings;
use App\Services\Shopify\ShopifySync;
use App\Services\Shopify\SyncRunner;
use App\Services\Shopify\WebhookProcessor;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Tests\Support\FakeShopify;
use Tests\TestCase;

/** Delivery status & payments from Shopify, ERP -> Shopify order actions, the automatic sync clock. (mocked Admin API) */
class TwoWaySyncTest extends TestCase
{
    private function paidOrder(int $n, array $over = []): array
    {
        return FakeShopify::order($n, array_replace_recursive([
            'displayFinancialStatus' => 'PAID', 'paymentGatewayNames' => ['XPay - Credit Card'],
            'totalReceivedSet' => ['shopMoney' => ['amount' => '3499.0']], 'totalOutstandingSet' => ['shopMoney' => ['amount' => '0.0']], 'netPaymentSet' => ['shopMoney' => ['amount' => '3499.0']],
            'transactions' => [['id' => "gid://shopify/OrderTransaction/{$n}1", 'kind' => 'SALE', 'status' => 'SUCCESS', 'gateway' => 'xpay', 'processedAt' => '2026-10-01T10:05:00Z', 'amountSet' => ['shopMoney' => ['amount' => '3499.0', 'currencyCode' => 'PKR']]]],
        ], $over));
    }

    private function shipped(string $display, array $extra = []): array
    {
        return ['fulfillments' => [array_merge(['id' => 'gid://shopify/Fulfillment/77', 'status' => 'SUCCESS', 'displayStatus' => $display, 'createdAt' => '2026-10-02T08:00:00Z', 'updatedAt' => '2026-10-04T12:00:00Z',
            'deliveredAt' => $display === 'DELIVERED' ? '2026-10-04T11:30:00Z' : null, 'inTransitAt' => '2026-10-02T15:00:00Z', 'trackingInfo' => [['number' => 'PX77', 'company' => 'PostEx', 'url' => null]], 'location' => ['id' => 'gid://shopify/Location/1']], $extra)]];
    }

    /* ----------------------------------------------------------- Shopify -> ERP */

    public function test_payment_details_and_transactions_are_stored(): void
    {
        app(ShopifySync::class)->upsertOrder($this->paidOrder(9001));
        $o = Db::get('SELECT * FROM orders WHERE id=?', 'gid://shopify/Order/9001');
        $this->assertSame('PAID', $o['financial']);
        $this->assertEquals(3499, $o['received']);
        $this->assertEquals(0, $o['outstanding']);
        $this->assertSame('PKR', $o['currency']);
        $tx = Db::get('SELECT * FROM order_transactions WHERE order_id=?', 'gid://shopify/Order/9001');
        $this->assertSame('SALE', $tx['kind']);
        $this->assertEquals(3499, $tx['amount']);
        // re-import: still one transaction (keyed by Shopify id)
        app(ShopifySync::class)->upsertOrder($this->paidOrder(9001, ['updatedAt' => '2026-10-02T10:00:00Z']));
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM order_transactions'));
    }

    public function test_partial_payment_and_refund_amounts(): void
    {
        app(ShopifySync::class)->upsertOrder($this->paidOrder(9002, ['displayFinancialStatus' => 'PARTIALLY_REFUNDED', 'totalRefundedSet' => ['shopMoney' => ['amount' => '1000.0']], 'netPaymentSet' => ['shopMoney' => ['amount' => '2499.0']],
            'refunds' => [['id' => 'gid://shopify/Refund/5', 'createdAt' => '2026-10-03T10:00:00Z', 'note' => 'size', 'totalRefundedSet' => ['shopMoney' => ['amount' => '1000.0']]]]]));
        $o = Db::get('SELECT * FROM orders WHERE id=?', 'gid://shopify/Order/9002');
        $this->assertSame('PARTIALLY_REFUNDED', $o['financial']);
        $this->assertEquals(1000, $o['total_refunded']);
        $this->assertEquals(2499, $o['net_payment']);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(9003, ['displayFinancialStatus' => 'PARTIALLY_PAID', 'totalReceivedSet' => ['shopMoney' => ['amount' => '1000.0']], 'totalOutstandingSet' => ['shopMoney' => ['amount' => '2499.0']]]));
        $this->assertEquals(2499, Db::val('SELECT outstanding FROM orders WHERE id=?', 'gid://shopify/Order/9003'));
    }

    public function test_delivery_status_comes_from_the_shopify_fulfilment(): void
    {
        $sync = app(ShopifySync::class);
        $sync->upsertOrder(FakeShopify::order(9010, $this->shipped('IN_TRANSIT')));
        $this->assertSame('in_transit', Db::val('SELECT status FROM orders WHERE id=?', 'gid://shopify/Order/9010'));
        $sync->upsertOrder(FakeShopify::order(9010, ['updatedAt' => '2026-10-04T12:00:00Z'] + $this->shipped('DELIVERED')));
        $o = Db::get('SELECT status, delivered_at, sh_ship_status FROM orders WHERE id=?', 'gid://shopify/Order/9010');
        $this->assertSame('delivered', $o['status']);
        $this->assertSame('2026-10-04 11:30:00', $o['delivered_at'], 'delivery time from Shopify');
        $sync->upsertOrder(FakeShopify::order(9011, $this->shipped('NOT_DELIVERED')));
        $this->assertSame('returning', Db::val('SELECT status FROM orders WHERE id=?', 'gid://shopify/Order/9011'));
        $sync->upsertOrder(FakeShopify::order(9012, $this->shipped('ATTEMPTED_DELIVERY')));
        $this->assertSame('attempted', Db::val('SELECT status FROM orders WHERE id=?', 'gid://shopify/Order/9012'));
    }

    public function test_courier_api_status_takes_priority_over_shopify(): void
    {
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(9013, $this->shipped('IN_TRANSIT')));
        Db::run("UPDATE orders SET px_status='Delivered' WHERE id='gid://shopify/Order/9013'");
        new FakeShopify;
        Logic::refreshOrder('gid://shopify/Order/9013');
        $this->assertSame('delivered', Db::val('SELECT status FROM orders WHERE id=?', 'gid://shopify/Order/9013'));
    }

    /* ----------------------------------------------------------- ERP -> Shopify */

    public function test_erp_courier_update_is_posted_to_the_shopify_fulfilment_once(): void
    {
        $fake = (new FakeShopify)->on('fulfillmentEventCreate', fn () => ['fulfillmentEventCreate' => ['fulfillmentEvent' => ['id' => 'gid://shopify/FulfillmentEvent/1', 'status' => 'DELIVERED', 'happenedAt' => '2026-10-04T10:00:00Z'], 'userErrors' => []]]);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(9020, $this->shipped('IN_TRANSIT')));
        $this->assertSame([], $fake->gqlCalls('fulfillmentEventCreate'), 'a status read FROM Shopify is not sent back');
        // the PostEx API (ERP side) reports delivery
        Db::run("UPDATE orders SET px_status='Delivered', px_updated='2026-10-04 10:00:00' WHERE id='gid://shopify/Order/9020'");
        Logic::refreshOrder('gid://shopify/Order/9020');
        Logic::refreshOrder('gid://shopify/Order/9020'); // again: no second event
        $calls = $fake->gqlCalls('fulfillmentEventCreate');
        $this->assertCount(1, $calls);
        $this->assertSame(['fulfillmentId' => 'gid://shopify/Fulfillment/77', 'status' => 'DELIVERED', 'happenedAt' => '2026-10-04T10:00:00Z'], $calls[0][2]['e']);
        $this->assertSame('ok', Db::val("SELECT status FROM shopify_writes WHERE kind='fulfillment_event'"));
    }

    public function test_fulfil_in_shopify_without_tracking_and_permission(): void
    {
        $fake = (new FakeShopify)
            ->on('fulfillmentOrders', fn () => ['order' => ['id' => 'gid://shopify/Order/9030', 'fulfillmentOrders' => ['nodes' => [['id' => 'gid://shopify/FulfillmentOrder/1', 'status' => 'OPEN']]]]])
            ->on('fulfillmentCreate', fn () => ['fulfillmentCreate' => ['fulfillment' => ['id' => 'gid://shopify/Fulfillment/31', 'status' => 'SUCCESS'], 'userErrors' => []]])
            ->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(9030, ['displayFulfillmentStatus' => 'FULFILLED', 'updatedAt' => '2026-10-05T10:00:00Z'])]);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(9030));
        $url = '/api/orders/'.rawurlencode('gid://shopify/Order/9030').'/shopify-fulfil';
        $this->api('POST', $url, [], $this->user('cs'))->assertStatus(403);
        $this->api('POST', $url, [], $this->user('warehouse'))->assertOk()->assertJsonPath('order.fulfillment', 'FULFILLED');
        $sent = $fake->gqlCalls('fulfillmentCreate')[0][2]['f'];
        $this->assertArrayNotHasKey('trackingInfo', $sent);
        $this->assertFalse($sent['notifyCustomer']);
    }

    private function refundFake(float $paid = 3499, float $refunded = 0, &$sent = null)
    {
        return (new FakeShopify)
            ->on('transactions(first:20){ id kind status gateway processedAt parentTransaction', function () use ($paid, &$refunded) {
                $tx = [['id' => 'gid://shopify/OrderTransaction/1', 'kind' => 'SALE', 'status' => 'SUCCESS', 'gateway' => 'xpay', 'processedAt' => '2026-10-01T00:00:00Z', 'parentTransaction' => null, 'amountSet' => ['shopMoney' => ['amount' => (string) $paid, 'currencyCode' => 'PKR']]]];
                if ($refunded > 0) {
                    $tx[] = ['id' => 'gid://shopify/OrderTransaction/2', 'kind' => 'REFUND', 'status' => 'SUCCESS', 'gateway' => 'xpay', 'processedAt' => '2026-10-02T00:00:00Z', 'parentTransaction' => ['id' => 'gid://shopify/OrderTransaction/1'], 'amountSet' => ['shopMoney' => ['amount' => (string) $refunded, 'currencyCode' => 'PKR']]];
                }
                return ['order' => ['id' => 'gid://shopify/Order/9040', 'displayFinancialStatus' => 'PAID', 'totalReceivedSet' => ['shopMoney' => ['amount' => (string) $paid]], 'totalRefundedSet' => ['shopMoney' => ['amount' => (string) $refunded]], 'transactions' => $tx]];
            })
            ->on('refundCreate', function ($v) use (&$refunded) {
                $refunded += (float) $v['input']['transactions'][0]['amount'];
                return ['refundCreate' => ['refund' => ['id' => 'gid://shopify/Refund/9', 'totalRefundedSet' => ['shopMoney' => ['amount' => $v['input']['transactions'][0]['amount']]]], 'order' => ['id' => 'gid://shopify/Order/9040', 'displayFinancialStatus' => 'PARTIALLY_REFUNDED'], 'userErrors' => []]];
            })
            ->on('order(id:$id){ id name', fn () => ['order' => $this->paidOrder(9040, ['displayFinancialStatus' => 'PARTIALLY_REFUNDED', 'updatedAt' => '2026-10-06T00:00:00Z'])]);
    }

    public function test_refund_needs_permission_confirmation_and_is_limited_to_what_was_paid(): void
    {
        $fake = $this->refundFake();
        app(ShopifySync::class)->upsertOrder($this->paidOrder(9040));
        $url = '/api/orders/'.rawurlencode('gid://shopify/Order/9040').'/shopify-refund';
        $this->api('POST', $url, ['amount' => 500, 'note' => 'x', 'confirm' => 'REFUND'], $this->user('manager'))->assertStatus(403); // not given to managers by default
        $owner = $this->user('admin');
        $this->api('POST', $url, ['amount' => 500, 'note' => 'damaged'], $owner)->assertStatus(400);                                         // no typed confirmation
        $this->api('POST', $url, ['amount' => 5000, 'note' => 'too much', 'confirm' => 'REFUND'], $owner)->assertStatus(400)->assertJsonFragment(['error' => 'Only Rs 3,499.00 can still be refunded in Shopify']);
        $this->assertSame([], $fake->gqlCalls('refundCreate'));
        $this->api('POST', $url, ['amount' => 500, 'note' => 'damaged', 'confirm' => 'REFUND', 'request_id' => 'abc'], $owner)->assertOk()->assertJsonPath('order.financial', 'PARTIALLY_REFUNDED');
        $sent = $fake->gqlCalls('refundCreate')[0][2]['input'];
        $this->assertSame('500.00', $sent['transactions'][0]['amount']);
        $this->assertSame('gid://shopify/OrderTransaction/1', $sent['transactions'][0]['parentId']);
        $this->assertSame('REFUND', $sent['transactions'][0]['kind']);
        $this->assertFalse($sent['notify']);
        // the same click again (same request id): nothing is sent twice
        $this->api('POST', $url, ['amount' => 500, 'note' => 'damaged', 'confirm' => 'REFUND', 'request_id' => 'abc'], $owner)->assertOk()->assertJson(['already' => true]);
        $this->assertCount(1, $fake->gqlCalls('refundCreate'));
        $this->assertSame(2, (int) Db::val("SELECT COUNT(*) FROM events WHERE action='shopify.refund'"), 'both clicks are in the activity log');
    }

    public function test_cash_on_delivery_order_has_nothing_to_refund_in_shopify(): void
    {
        (new FakeShopify)->on('transactions(first:20){ id kind status gateway processedAt parentTransaction', fn () => ['order' => ['id' => 'gid://shopify/Order/9050', 'displayFinancialStatus' => 'PENDING', 'totalReceivedSet' => ['shopMoney' => ['amount' => '0']], 'totalRefundedSet' => ['shopMoney' => ['amount' => '0']], 'transactions' => []]]);
        app(ShopifySync::class)->upsertOrder(FakeShopify::order(9050));
        $this->api('POST', '/api/orders/'.rawurlencode('gid://shopify/Order/9050').'/shopify-refund', ['amount' => 100, 'note' => 'x', 'confirm' => 'REFUND'], $this->user('admin'))
            ->assertStatus(400)->assertJsonFragment(['error' => 'Shopify has no payment on this order that can be refunded (cash on delivery orders are refunded outside Shopify).']);
    }

    public function test_refund_with_unknown_outcome_is_not_sent_twice(): void
    {
        $refunded = 0.0;
        $fake = (new FakeShopify)
            ->on('transactions(first:20){ id kind status gateway processedAt parentTransaction', function () use (&$refunded) {
                $tx = [['id' => 'gid://shopify/OrderTransaction/1', 'kind' => 'SALE', 'status' => 'SUCCESS', 'gateway' => 'xpay', 'processedAt' => '2026-10-01T00:00:00Z', 'parentTransaction' => null, 'amountSet' => ['shopMoney' => ['amount' => '3499', 'currencyCode' => 'PKR']]]];
                if ($refunded) {
                    $tx[] = ['id' => 'gid://shopify/OrderTransaction/2', 'kind' => 'REFUND', 'status' => 'SUCCESS', 'gateway' => 'xpay', 'processedAt' => '2026-10-02T00:00:00Z', 'parentTransaction' => null, 'amountSet' => ['shopMoney' => ['amount' => (string) $refunded, 'currencyCode' => 'PKR']]];
                }
                return ['order' => ['id' => 'gid://shopify/Order/9060', 'displayFinancialStatus' => 'PAID', 'totalReceivedSet' => ['shopMoney' => ['amount' => '3499']], 'totalRefundedSet' => ['shopMoney' => ['amount' => (string) $refunded]], 'transactions' => $tx]];
            })
            ->on('refundCreate', function () use (&$refunded) {
                $refunded = 700.0; // Shopify did it …
                throw new ConnectionException('timed out'); // … but the answer was lost
            });
        $w = app(\App\Services\Shopify\ShopifyWriter::class);
        try {
            $w->refund('gid://shopify/Order/9060', 700, 'size', 'req1');
            $this->fail('expected exception');
        } catch (\App\Services\Shopify\ShopifyException $e) {
            $this->assertSame('network', $e->kind);
        }
        $this->assertSame('unknown', Db::val("SELECT status FROM shopify_writes WHERE kind='refund'"));
        $r = $w->refund('gid://shopify/Order/9060', 700, 'size', 'req1');
        $this->assertTrue($r['already'], 'found in Shopify, not refunded again');
        $this->assertCount(4, $fake->gqlCalls('refundCreate'), 'only the first attempt (with its network retries) sent it');
    }

    /* --------------------------------------------------------- automatic sync */

    public function test_minute_clock_syncs_orders_every_minute_without_webhooks(): void
    {
        $fake = (new FakeShopify)
            ->on('orders(first', fn () => FakeShopify::page('orders', [FakeShopify::order(9100)]))
            ->on('products(first', fn () => FakeShopify::page('products', []))
            ->on('customers(first', fn () => FakeShopify::page('customers', []))
            ->on('locations(first', fn () => ['locations' => ['nodes' => []]])
            ->on('ordersCount', fn () => ['ordersCount' => ['count' => 1, 'precision' => 'EXACT']])
            ->on('id updatedAt', fn ($v) => ['orders' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => []], 'products' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => []]]);
        $this->artisan('erp:tick')->assertSuccessful();
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM orders'), 'new Shopify order picked up');
        $this->assertNotNull(Settings::get('tick_at'));
        $n = count($fake->gqlCalls('orders(first'));
        $this->artisan('erp:tick')->assertSuccessful(); // same minute: not due again
        $this->assertCount($n, $fake->gqlCalls('orders(first'));
        $this->assertTrue(SyncRunner::due('orders', 0));
        $this->assertFalse(SyncRunner::due('products', 5));
        $this->assertSame('polling', SyncRunner::state()['auto']['mode']);
    }

    public function test_webhook_mode_only_for_this_installations_address(): void
    {
        Settings::set('shopify_webhooks', ['at' => gmdate('Y-m-d H:i:s'), 'url' => 'https://erp.example.test/api/hooks/shopify', 'topics' => ['ORDERS_CREATE']]);
        Db::run("INSERT INTO webhook_events(webhook_id,topic,status,received_at) VALUES('w1','orders/create','done',UTC_TIMESTAMP())");
        $this->assertTrue(SyncRunner::webhooksHealthy());
        // a local copy of the live database has the live registration: it must keep polling
        Settings::set('shopify_webhooks', ['at' => gmdate('Y-m-d H:i:s'), 'url' => 'https://erp.sundaybazar.com.pk/api/hooks/shopify', 'topics' => ['ORDERS_CREATE']]);
        $this->assertFalse(SyncRunner::webhooksHealthy());
    }

    public function test_failed_webhook_is_retried_by_the_clock(): void
    {
        $ok = false;
        (new FakeShopify)->on('order(id:$id){ id name', function () use (&$ok) {
            return $ok ? ['order' => FakeShopify::order(9200)] : Http::response(['errors' => [['message' => 'Internal error']]]);
        });
        Db::run("INSERT INTO webhook_events(webhook_id,topic,payload,status,received_at) VALUES('w2','orders/updated',?, 'received', UTC_TIMESTAMP() - INTERVAL 10 MINUTE)", json_encode(['admin_graphql_api_id' => 'gid://shopify/Order/9200']));
        app(WebhookProcessor::class)->retryDue();
        $this->assertSame('failed', Db::val("SELECT status FROM webhook_events WHERE webhook_id='w2'"));
        $ok = true;
        Db::run("UPDATE webhook_events SET received_at=UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE webhook_id='w2'");
        $this->assertSame(1, app(WebhookProcessor::class)->retryDue());
        $this->assertSame('done', Db::val("SELECT status FROM webhook_events WHERE webhook_id='w2'"));
        $this->assertSame(1, (int) Db::val('SELECT COUNT(*) FROM orders'));
    }

    public function test_retry_failed_button(): void
    {
        (new FakeShopify)->on('order(id:$id){ id name', fn () => ['order' => FakeShopify::order(9300)]);
        Db::run("INSERT INTO webhook_events(webhook_id,topic,payload,status,attempts,received_at) VALUES('w3','orders/updated',?,'failed',10,UTC_TIMESTAMP())", json_encode(['admin_graphql_api_id' => 'gid://shopify/Order/9300']));
        $this->api('POST', '/api/shopify/retry', [], $this->user('cs'))->assertStatus(403);
        $this->api('POST', '/api/shopify/retry', [], $this->user('admin'))->assertOk()->assertJson(['webhooksRetried' => 1, 'stillFailed' => 0]);
    }

    public function test_settings_no_longer_have_sync_rules(): void
    {
        $s = $this->actingAs($this->user())->getJson('/api/settings')->assertOk()->json();
        foreach (['tag_shopify', 'restock_shopify', 'sync_minutes', 'history_days'] as $k) {
            $this->assertArrayNotHasKey($k, $s);
        }
        $this->assertArrayHasKey('confirm_mode', $s, 'business settings kept');
        $this->assertArrayHasKey('wa_template', $s);
    }
}
