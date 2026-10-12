<?php

namespace App\Services\Shopify;

use App\Erp\Activity;
use App\Erp\Db;
use App\Erp\Settings;

/**
 * Every ERP -> Shopify change goes through here.
 *
 * - Each direction has an on/off switch in .env (SHOPIFY_WRITE_*); off = nothing is sent.
 * - Each call is recorded in `shopify_writes` with the request, Shopify's answer and the outcome.
 * - Operations that must not happen twice (fulfillments, order cancellation) carry an idempotency key:
 *   a finished one is not sent again, and one whose outcome is unknown (timeout) is first checked
 *   against Shopify's real state instead of being repeated blindly.
 */
class ShopifyWriter
{
    public function __construct(private ShopifyClient $shopify) {}

    private function guard(string $switch, string $what): void
    {
        if (! $this->shopify->configured()) {
            throw new ShopifyException('Shopify is not connected', 'config');
        }
        if (! $this->shopify->writeEnabled($switch)) {
            throw new ShopifyException("{$what} to Shopify is switched off (SHOPIFY_WRITE_".strtoupper($switch).'=false in .env)', 'config');
        }
    }

    private function begin(string $kind, ?string $target, $request, ?int $uid, ?string $key = null): int
    {
        return Db::run('INSERT INTO shopify_writes(kind,target_id,idempotency_key,request,status,user_id,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())',
            $kind, $target, $key, json_encode($request, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'pending', $uid)->lastInsertRowid;
    }

    private function finish(int $id, string $status, $response = null, ?string $error = null): void
    {
        Db::run('UPDATE shopify_writes SET status=?, response=?, error=? WHERE id=?', $status, $response === null ? null : json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $error, $id);
        if ($status !== 'ok') {
            Activity::sync('shopify-write', false, $error ?: $status);
        }
    }

    /** Run a mutation and record it. Network failures leave status "unknown" (the change may or may not have happened). */
    private function mutate(int $id, string $query, array $vars, string $field, string $what): array
    {
        try {
            $d = $this->shopify->gql($query, $vars);
        } catch (ShopifyException $e) {
            $this->finish($id, in_array($e->kind, ['network'], true) ? 'unknown' : 'failed', $e->details ?: null, $e->getMessage());
            throw $e;
        }
        $payload = $d[$field] ?? [];
        try {
            ShopifyClient::assertNoUserErrors($payload, $what);
        } catch (ShopifyException $e) {
            $this->finish($id, 'failed', $payload, $e->getMessage());
            throw $e;
        }
        $this->finish($id, 'ok', $payload);
        return $payload;
    }

    /* ------------------------------------------------------------------ tags */

    public function tagOrder(string $orderGid, array $tags, ?int $uid = null): void
    {
        $this->guard('tags', 'Tagging orders');
        $id = $this->begin('tags', $orderGid, ['tags' => $tags], $uid);
        $this->mutate($id, 'mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ node{ id } userErrors{ field message } } }', ['id' => $orderGid, 'tags' => array_values($tags)], 'tagsAdd', 'Shopify tags');
    }

    /* ---------------------------------------------------------------- prices */

    /**
     * @param  array  $changes  [['product_id','variant_id','price','compare_at'], ...]
     * @return array [['variant_id','ok','error'], ...]
     */
    public function updatePrices(array $changes, ?int $uid = null): array
    {
        $this->guard('prices', 'Sending prices');
        $byProduct = [];
        foreach ($changes as $c) {
            $byProduct[$c['product_id']][] = $c;
        }
        $results = [];
        foreach ($byProduct as $pid => $list) {
            $variants = array_map(fn ($c) => ['id' => $c['variant_id'], 'price' => (string) $c['price'], 'compareAtPrice' => $c['compare_at'] ? (string) $c['compare_at'] : null], $list);
            $id = $this->begin('price', $pid, ['variants' => $variants], $uid);
            try {
                $this->mutate($id, 'mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ productVariants{ id price compareAtPrice } userErrors{ field message } } }',
                    ['pid' => $pid, 'v' => $variants], 'productVariantsBulkUpdate', 'Price update');
                foreach ($list as $c) {
                    $results[] = ['variant_id' => $c['variant_id'], 'ok' => true, 'error' => ''];
                }
            } catch (ShopifyException $e) {
                foreach ($list as $c) {
                    $results[] = ['variant_id' => $c['variant_id'], 'ok' => false, 'error' => $e->getMessage()];
                }
            }
        }
        return $results;
    }

    /* ------------------------------------------------------------- inventory */

    /** The Shopify location stock changes go to (Settings → Shopify → Stock location). */
    public function stockLocation(): string
    {
        $loc = (string) Settings::get('shopify_location', '');
        if ($loc === '') {
            throw new ShopifyException('Choose the Shopify stock location in Settings first (the store has several locations)', 'config');
        }
        if (! Db::get('SELECT id FROM shopify_locations WHERE id=? AND is_active=1', $loc) && Db::val('SELECT COUNT(*) FROM shopify_locations') > 0) {
            throw new ShopifyException('The chosen stock location is not an active Shopify location any more — choose it again in Settings', 'config');
        }
        return $loc;
    }

    /** Add/remove stock at one location ("available" quantity). Positive delta = restock. */
    public function adjustInventory(string $inventoryItemGid, int $delta, string $reason = 'restock', ?int $uid = null, ?string $locationGid = null): void
    {
        $this->guard('inventory', 'Changing stock');
        $loc = $locationGid ?: $this->stockLocation();
        $reason = in_array($reason, ['correction', 'cycle_count_available', 'damaged', 'movement_created', 'movement_updated', 'movement_received', 'movement_canceled', 'other', 'promotion', 'quality_control', 'received', 'reservation_created', 'reservation_deleted', 'reservation_updated', 'restock', 'safety_stock', 'shrinkage'], true) ? $reason : 'correction';
        $input = ['reason' => $reason, 'name' => 'available', 'changes' => [['delta' => $delta, 'inventoryItemId' => $inventoryItemGid, 'locationId' => $loc]]];
        $id = $this->begin('inventory', $inventoryItemGid, $input, $uid);
        $this->mutate($id, 'mutation($input:InventoryAdjustQuantitiesInput!){ inventoryAdjustQuantities(input:$input){ inventoryAdjustmentGroup{ id reason changes{ name delta } } userErrors{ field message } } }',
            ['input' => $input], 'inventoryAdjustQuantities', 'Inventory');
        // keep the local location-level copy in step
        Db::run('UPDATE inventory_levels SET available=COALESCE(available,0)+? WHERE inventory_item_id=? AND location_id=?', $delta, $inventoryItemGid, $loc);
    }

    /* ---------------------------------------------------------- fulfillments */

    /**
     * Mark an order fulfilled in Shopify with the courier tracking number (all open fulfillment orders).
     * Never throws: returns ['ok', 'error', 'fulfillment_id'].
     */
    public function createFulfillment(string $orderGid, string $tracking, string $company, ?string $url = null, ?int $uid = null): array
    {
        try {
            $this->guard('fulfillments', 'Sending fulfilments');
        } catch (ShopifyException $e) {
            return ['ok' => false, 'error' => $e->getMessage(), 'fulfillment_id' => null];
        }
        $key = 'fulfill:'.$orderGid.':'.$tracking;
        $prev = Db::get('SELECT * FROM shopify_writes WHERE idempotency_key=?', $key);
        if ($prev && $prev['status'] === 'ok') {
            $r = json_decode((string) $prev['response'], true);
            return ['ok' => true, 'error' => null, 'fulfillment_id' => $r['fulfillment']['id'] ?? null];
        }
        try {
            // a previous attempt timed out: look at Shopify before sending again
            $existing = $tracking !== '' ? $this->findFulfillment($orderGid, $tracking) : null;
            if ($existing) {
                if ($prev) {
                    $this->finish((int) $prev['id'], 'ok', ['fulfillment' => ['id' => $existing], 'note' => 'found in Shopify']);
                }
                return ['ok' => true, 'error' => null, 'fulfillment_id' => $existing];
            }
            $d = $this->shopify->gql('query($id:ID!){ order(id:$id){ id fulfillmentOrders(first:20){ nodes{ id status } } } }', ['id' => $orderGid]);
            $fos = array_values(array_filter($d['order']['fulfillmentOrders']['nodes'] ?? [], fn ($f) => in_array($f['status'], ['OPEN', 'IN_PROGRESS', 'SCHEDULED'], true)));
            if (! $fos) {
                return ['ok' => false, 'error' => 'No open fulfillment order in Shopify (already fulfilled, on hold or cancelled)', 'fulfillment_id' => null];
            }
            $input = ['lineItemsByFulfillmentOrder' => array_map(fn ($f) => ['fulfillmentOrderId' => $f['id']], $fos), 'notifyCustomer' => false];
            if ($tracking !== '') { // without a tracking number the order is simply marked fulfilled
                $info = ['number' => $tracking, 'company' => $company];
                if ($url) {
                    $info['url'] = $url;
                }
                $input['trackingInfo'] = $info;
            }
            if ($prev) {
                Db::run('DELETE FROM shopify_writes WHERE id=?', $prev['id']);
            }
            $id = $this->begin('fulfillment', $orderGid, $input, $uid, $key);
            $p = $this->mutate($id, 'mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }', ['f' => $input], 'fulfillmentCreate', 'Fulfilment');
            return ['ok' => true, 'error' => null, 'fulfillment_id' => $p['fulfillment']['id'] ?? null];
        } catch (ShopifyException $e) {
            return ['ok' => false, 'error' => $e->getMessage(), 'fulfillment_id' => null];
        }
    }

    /** Fulfillment id already carrying this tracking number, if any. */
    public function findFulfillment(string $orderGid, string $tracking): ?string
    {
        $d = $this->shopify->gql('query($id:ID!){ order(id:$id){ fulfillments(first:20){ id status trackingInfo{ number } } } }', ['id' => $orderGid]);
        foreach ($d['order']['fulfillments'] ?? [] as $f) {
            if (($f['status'] ?? '') !== 'CANCELLED' && in_array($tracking, array_column($f['trackingInfo'] ?? [], 'number'), true)) {
                return $f['id'];
            }
        }
        return null;
    }

    /** Never throws: returns ['ok', 'error']. */
    public function cancelFulfillment(string $fulfillmentGid, ?int $uid = null): array
    {
        try {
            $this->guard('fulfillments', 'Cancelling fulfilments');
            $id = $this->begin('fulfillment_cancel', $fulfillmentGid, ['id' => $fulfillmentGid], $uid);
            $this->mutate($id, 'mutation($id:ID!){ fulfillmentCancel(id:$id){ fulfillment{ id status } userErrors{ field message } } }', ['id' => $fulfillmentGid], 'fulfillmentCancel', 'Cancel fulfilment');
            return ['ok' => true, 'error' => null];
        } catch (ShopifyException $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    /**
     * Post a delivery event (IN_TRANSIT, OUT_FOR_DELIVERY, ATTEMPTED_DELIVERY, DELIVERED) on the order's Shopify
     * fulfilment, from the ERP's own courier data. Once per fulfilment+status. Never throws.
     */
    public function fulfillmentEvent(string $orderGid, string $status, ?string $happenedAt = null, ?int $uid = null): array
    {
        try {
            $this->guard('fulfillments', 'Sending delivery updates');
        } catch (ShopifyException $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
        $fid = Db::val("SELECT id FROM order_fulfillments WHERE order_id=? AND status='SUCCESS' ORDER BY created_at DESC LIMIT 1", $orderGid)
            ?: (\Illuminate\Support\Facades\Schema::hasTable('cr_fulfil') ? Db::val('SELECT fulfillment_id FROM cr_fulfil WHERE order_id=? AND ok=1', $orderGid) : null);
        if (! $fid) {
            return ['ok' => false, 'error' => 'The order has no Shopify fulfilment yet'];
        }
        $key = 'fevent:'.$fid.':'.$status;
        if (Db::get("SELECT id FROM shopify_writes WHERE idempotency_key=? AND status='ok'", $key)) {
            return ['ok' => true, 'already' => true];
        }
        Db::run("DELETE FROM shopify_writes WHERE idempotency_key=? AND status<>'ok'", $key);
        $ev = ['fulfillmentId' => $fid, 'status' => $status];
        if ($happenedAt && strtotime($happenedAt.' UTC')) {
            $ev['happenedAt'] = gmdate('Y-m-d\TH:i:s\Z', strtotime($happenedAt.' UTC'));
        }
        $id = $this->begin('fulfillment_event', $orderGid, $ev, $uid, $key);
        try {
            $this->mutate($id, 'mutation($e:FulfillmentEventInput!){ fulfillmentEventCreate(fulfillmentEvent:$e){ fulfillmentEvent{ id status happenedAt } userErrors{ field message } } }', ['e' => $ev], 'fulfillmentEventCreate', 'Delivery update');
            return ['ok' => true];
        } catch (ShopifyException $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    /* ---------------------------------------------------------------- refunds */

    /**
     * Money that can still be refunded in Shopify: successful sales/captures minus successful refunds,
     * read live from Shopify (never from the local copy) together with the transaction to refund against.
     */
    public function refundable(string $orderGid): array
    {
        $d = $this->shopify->gql('query($id:ID!){ order(id:$id){ id displayFinancialStatus totalReceivedSet{shopMoney{amount}} totalRefundedSet{shopMoney{amount}} transactions(first:20){ id kind status gateway processedAt parentTransaction{ id } amountSet{ shopMoney{ amount currencyCode } } } } }', ['id' => $orderGid]);
        $o = $d['order'] ?? null;
        if (! $o) {
            throw new ShopifyException('Order not found in Shopify', 'graphql');
        }
        $paid = 0.0;
        $refunded = 0.0;
        $parent = null;
        foreach ($o['transactions'] ?? [] as $t) {
            if (($t['status'] ?? '') !== 'SUCCESS') {
                continue;
            }
            $amt = (float) ($t['amountSet']['shopMoney']['amount'] ?? 0);
            if (in_array($t['kind'], ['SALE', 'CAPTURE'], true)) {
                $paid += $amt;
                $parent = $t; // the latest money-in transaction
            } elseif ($t['kind'] === 'REFUND') {
                $refunded += $amt;
            }
        }
        return ['available' => round(max(0, $paid - $refunded), 2), 'paid' => round($paid, 2), 'refunded' => round($refunded, 2), 'parent' => $parent, 'financial' => $o['displayFinancialStatus'] ?? null];
    }

    /**
     * Refund money in Shopify (to the original payment). Financially consequential: callers require a typed
     * confirmation and the orders_refund permission. $requestId makes a retried click harmless.
     */
    public function refund(string $orderGid, float $amount, string $note, string $requestId, bool $notify = false, ?int $uid = null): array
    {
        $this->guard('refunds', 'Refunding');
        $key = 'refund:'.$orderGid.':'.mb_substr($requestId, 0, 60);
        $amount = round($amount, 2);
        if ($amount <= 0) {
            throw new ShopifyException('Enter the amount to refund', 'config');
        }
        $r = $this->refundable($orderGid); // live state from Shopify
        if ($prev = Db::get('SELECT * FROM shopify_writes WHERE idempotency_key=?', $key)) {
            if ($prev['status'] === 'ok') {
                return ['ok' => true, 'already' => true];
            }
            if (in_array($prev['status'], ['pending', 'unknown'], true)) {
                // outcome of the first attempt unknown: did Shopify refund it? then do not refund again
                $before = (float) (json_decode((string) $prev['request'], true)['beforeRefunded'] ?? 0);
                if ($r['refunded'] >= $before + $amount - 0.01) {
                    $this->finish((int) $prev['id'], 'ok', ['note' => 'found in Shopify', 'refunded' => $r['refunded']]);
                    return ['ok' => true, 'already' => true];
                }
            }
            Db::run('DELETE FROM shopify_writes WHERE id=?', $prev['id']);
        }
        if (! $r['parent'] || $r['available'] <= 0) {
            throw new ShopifyException('Shopify has no payment on this order that can be refunded (cash on delivery orders are refunded outside Shopify).', 'config');
        }
        if ($amount > $r['available'] + 0.001) {
            throw new ShopifyException('Only Rs '.number_format($r['available'], 2).' can still be refunded in Shopify', 'config');
        }
        $input = ['orderId' => $orderGid, 'note' => mb_substr($note, 0, 250) ?: null, 'notify' => $notify,
            'transactions' => [['orderId' => $orderGid, 'parentId' => $r['parent']['id'], 'gateway' => $r['parent']['gateway'], 'kind' => 'REFUND', 'amount' => number_format($amount, 2, '.', '')]]];
        $id = $this->begin('refund', $orderGid, $input + ['beforeRefunded' => $r['refunded']], $uid, $key);
        $p = $this->mutate($id, 'mutation($input:RefundInput!){ refundCreate(input:$input){ refund{ id totalRefundedSet{ shopMoney{ amount } } } order{ id displayFinancialStatus } userErrors{ field message } } }', ['input' => $input], 'refundCreate', 'Refund');
        return ['ok' => true, 'refund' => $p['refund']['id'] ?? null, 'financial' => $p['order']['displayFinancialStatus'] ?? null];
    }

    /* ---------------------------------------------------------- order cancel */

    /**
     * Cancel an order in Shopify (no refund is issued; payment stays as is). Irreversible: callers must have
     * asked the user to confirm. Idempotent per order; an unknown outcome is checked before re-sending.
     */
    public function cancelOrder(string $orderGid, string $reason = 'OTHER', bool $restock = true, ?string $staffNote = null, ?int $uid = null): array
    {
        $this->guard('order_cancel', 'Cancelling orders');
        $reason = in_array($reason, ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF'], true) ? $reason : 'OTHER';
        $key = 'cancel:'.$orderGid;
        $prev = Db::get('SELECT * FROM shopify_writes WHERE idempotency_key=?', $key);
        $now = $this->shopify->gql('query($id:ID!){ order(id:$id){ id cancelledAt } }', ['id' => $orderGid]);
        if (! empty($now['order']['cancelledAt'])) {
            if ($prev && $prev['status'] !== 'ok') {
                $this->finish((int) $prev['id'], 'ok', ['note' => 'already cancelled in Shopify']);
            }
            Db::run('UPDATE orders SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?', $now['order']['cancelledAt'], $orderGid);
            return ['ok' => true, 'already' => true];
        }
        if ($prev) {
            Db::run('DELETE FROM shopify_writes WHERE id=?', $prev['id']);
        }
        $vars = ['id' => $orderGid, 'reason' => $reason, 'restock' => $restock, 'notify' => false, 'note' => $staffNote, 'refund' => ['originalPaymentMethodsRefund' => false]];
        $id = $this->begin('order_cancel', $orderGid, $vars, $uid, $key);
        $p = $this->mutate($id, 'mutation($id:ID!,$reason:OrderCancelReason!,$restock:Boolean!,$notify:Boolean,$note:String,$refund:OrderCancelRefundMethodInput!){ orderCancel(orderId:$id, reason:$reason, restock:$restock, notifyCustomer:$notify, staffNote:$note, refundMethod:$refund){ job{ id done } orderCancelUserErrors{ field message code } } }',
            $vars, 'orderCancel', 'Order cancel');
        return ['ok' => true, 'job' => $p['job']['id'] ?? null];
    }
}
