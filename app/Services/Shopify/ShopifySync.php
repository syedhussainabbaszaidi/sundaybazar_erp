<?php

namespace App\Services\Shopify;

use App\Erp\Activity;
use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Settings;

/**
 * Shopify -> ERP import (initial and incremental) and single-record refresh used by webhooks.
 *
 * Field ownership (who wins):
 *   Shopify owns: order totals, financial/fulfillment status, cancellation, tags, note, customer & address,
 *                 line items, fulfillments, refunds; product title/status/price/compare-at/cost/stock/media.
 *   ERP owns:     order stage & confirmation calls, pick/pack progress, courier booking (bk_*), PostEx/TCS
 *                 status, COD settlement, rack locations, lots/listings. Imports never overwrite these.
 * Out-of-order updates: a Shopify record older than the stored updated_at is ignored.
 * Pagination state is saved after every page in `sync_runs`, so an interrupted import resumes there.
 */
class ShopifySync
{
    public const ORDER_FIELDS = 'id name createdAt updatedAt cancelledAt cancelReason closedAt displayFinancialStatus displayFulfillmentStatus tags note phone email currencyCode paymentGatewayNames sourceName totalPriceSet{shopMoney{amount}} subtotalPriceSet{shopMoney{amount}} totalTaxSet{shopMoney{amount}} totalRefundedSet{shopMoney{amount}} totalShippingPriceSet{shopMoney{amount}} totalDiscountsSet{shopMoney{amount}} totalReceivedSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}} netPaymentSet{shopMoney{amount}} shippingAddress{name phone address1 address2 city province} customer{id displayName defaultPhoneNumber{phoneNumber}} lineItems(first:50){ pageInfo{hasNextPage endCursor} nodes{ id title quantity sku variant{id} product{id} originalUnitPriceSet{shopMoney{amount}} discountedUnitPriceSet{shopMoney{amount}} } } fulfillments(first:10){ id status displayStatus createdAt updatedAt deliveredAt inTransitAt trackingInfo{number company url} location{id} } refunds(first:10){ id createdAt note totalRefundedSet{shopMoney{amount}} } transactions(first:20){ id kind status gateway processedAt amountSet{shopMoney{amount currencyCode}} }';

    private const LINE_FIELDS = 'id title quantity sku variant{id} product{id} originalUnitPriceSet{shopMoney{amount}} discountedUnitPriceSet{shopMoney{amount}}';

    public const PRODUCT_FIELDS = 'id title handle status createdAt updatedAt vendor productType tags descriptionHtml totalInventory variantsCount{count} featuredMedia{preview{image{url(transform:{maxWidth:200})}}} media(first:5){nodes{id alt preview{image{url}}}} collections(first:5){nodes{id title handle updatedAt}} variants(first:20){ pageInfo{hasNextPage endCursor} nodes{ id title sku barcode price compareAtPrice inventoryQuantity position selectedOptions{name value} inventoryItem{ id unitCost{amount} } } }';

    private const VARIANT_FIELDS = 'id title sku barcode price compareAtPrice inventoryQuantity position selectedOptions{name value} inventoryItem{ id unitCost{amount} }';

    private const CUSTOMER_FIELDS = 'id firstName lastName defaultEmailAddress{emailAddress} defaultPhoneNumber{phoneNumber} numberOfOrders amountSpent{amount} state tags createdAt updatedAt defaultAddress{city province}';

    /** phones whose orders changed in this run: only their customer rows are rebuilt */
    private array $touchedPhones = [];

    public function __construct(private ShopifyClient $shopify) {}

    private static function money($set): float
    {
        return (float) ($set['shopMoney']['amount'] ?? 0);
    }

    private static function ts(?string $iso): ?string
    {
        return $iso ? gmdate('Y-m-d H:i:s', strtotime($iso)) : null;
    }

    /* ================================================================== orders */

    /**
     * Import/refresh one order (GraphQL node). Returns false when the stored copy is newer (stale event).
     */
    public function upsertOrder(array $n, bool $force = false): bool
    {
        $old = Db::get('SELECT id, updated_at FROM orders WHERE id=?', $n['id']);
        if ($old && ! $force && $old['updated_at'] && ! empty($n['updatedAt']) && strtotime($old['updated_at'].' UTC') > strtotime($n['updatedAt'])) {
            return false; // we already have a newer version
        }
        $items = $n['lineItems']['nodes'] ?? [];
        if (! empty($n['lineItems']['pageInfo']['hasNextPage'])) {
            $items = array_merge($items, $this->moreLineItems($n['id'], $n['lineItems']['pageInfo']['endCursor']));
        }
        $a = $n['shippingAddress'] ?? [];
        $phone = Logic::normPhone(($a['phone'] ?? null) ?: (($n['phone'] ?? null) ?: ($n['customer']['defaultPhoneNumber']['phoneNumber'] ?? null)));
        $ful = null;
        $tr = [];
        foreach ($n['fulfillments'] ?? [] as $f) {
            if (($f['status'] ?? '') === 'CANCELLED') {
                continue;
            }
            foreach ($f['trackingInfo'] ?? [] as $t) {
                if (! empty($t['number'])) {
                    $ful = $f;
                    $tr = $t;
                    break 2;
                }
            }
        }
        // delivery status as Shopify knows it (courier apps such as PostEx post events on the fulfilment)
        $ship = null;
        foreach ($n['fulfillments'] ?? [] as $f) {
            if (($f['status'] ?? '') === 'CANCELLED' || empty($f['displayStatus'])) {
                continue;
            }
            if (! $ship || strtotime($f['updatedAt'] ?? '0') > strtotime($ship['updatedAt'] ?? '0')) {
                $ship = $f;
            }
        }
        $vals = [
            'name' => $n['name'] ?? null, 'created_at' => self::ts($n['createdAt'] ?? null), 'updated_at' => self::ts($n['updatedAt'] ?? null),
            'customer_id' => $n['customer']['id'] ?? null, 'phone' => $phone,
            'cust_name' => mb_substr(($a['name'] ?? '') ?: ($n['customer']['displayName'] ?? ''), 0, 191), 'city' => mb_substr((string) ($a['city'] ?? ''), 0, 120),
            'address' => implode(', ', array_filter([$a['address1'] ?? null, $a['address2'] ?? null])),
            'total' => self::money($n['totalPriceSet'] ?? null), 'shipping' => self::money($n['totalShippingPriceSet'] ?? null), 'discount' => self::money($n['totalDiscountsSet'] ?? null),
            'items' => array_sum(array_map(fn ($i) => (int) ($i['quantity'] ?? 0), $items)),
            'gateway' => mb_substr(implode(', ', $n['paymentGatewayNames'] ?? []), 0, 191), 'financial' => $n['displayFinancialStatus'] ?? null, 'fulfillment' => $n['displayFulfillmentStatus'] ?? null,
            'tags' => implode(', ', $n['tags'] ?? []), 'note' => $n['note'] ?? '', 'cancelled_at' => self::ts($n['cancelledAt'] ?? null), 'source' => mb_substr((string) ($n['sourceName'] ?? ''), 0, 60),
            'tracking' => $tr['number'] ?? null, 'courier' => $tr['company'] ?? null,
            'currency' => $n['currencyCode'] ?? null, 'subtotal' => isset($n['subtotalPriceSet']) ? self::money($n['subtotalPriceSet']) : null,
            'total_tax' => isset($n['totalTaxSet']) ? self::money($n['totalTaxSet']) : null, 'total_refunded' => isset($n['totalRefundedSet']) ? self::money($n['totalRefundedSet']) : null,
            'cancel_reason' => $n['cancelReason'] ?? null, 'closed_at' => self::ts($n['closedAt'] ?? null), 'email' => $n['email'] ?? null,
            'received' => isset($n['totalReceivedSet']) ? self::money($n['totalReceivedSet']) : null,
            'outstanding' => isset($n['totalOutstandingSet']) ? self::money($n['totalOutstandingSet']) : null,
            'net_payment' => isset($n['netPaymentSet']) ? self::money($n['netPaymentSet']) : null,
            'sh_ship_status' => $ship['displayStatus'] ?? null,
            'sh_ship_at' => $ship ? self::ts(($ship['displayStatus'] ?? '') === 'DELIVERED' && ! empty($ship['deliveredAt']) ? $ship['deliveredAt'] : ($ship['updatedAt'] ?? null)) : null,
        ];
        if ($phone !== '') {
            $this->touchedPhones[$phone] = true;
        }
        Db::tx(function () use ($n, $old, $vals, $items, $ful) {
            $keys = array_keys($vals);
            if ($old) {
                Db::run('UPDATE orders SET '.implode(',', array_map(fn ($k) => "`$k`=?", $keys)).', synced_at=UTC_TIMESTAMP() WHERE id=?', ...array_merge(array_values($vals), [$n['id']]));
            } else {
                Db::run('INSERT INTO orders(id,'.implode(',', array_map(fn ($k) => "`$k`", $keys)).',synced_at) VALUES(?,'.implode(',', array_fill(0, count($keys), '?')).',UTC_TIMESTAMP())', $n['id'], ...array_values($vals));
            }
            // line items: keep pick progress when the order is re-synced (matched by line item id, else SKU)
            $prev = Db::all('SELECT line_item_id, sku, picked, picked_by, picked_at FROM order_items WHERE order_id=?', $n['id']);
            $byLine = [];
            $bySku = [];
            foreach ($prev as $p) {
                if ($p['line_item_id']) {
                    $byLine[$p['line_item_id']] = $p;
                }
                $bySku[(string) $p['sku']] = $p;
            }
            Db::run('DELETE FROM order_items WHERE order_id=?', $n['id']);
            foreach ($items as $i) {
                $p = $byLine[$i['id'] ?? ''] ?? $bySku[(string) ($i['sku'] ?? '')] ?? [];
                $price = self::money($i['discountedUnitPriceSet'] ?? $i['originalUnitPriceSet'] ?? null);
                Db::run('INSERT INTO order_items(order_id,line_item_id,sku,title,qty,price,variant_id,product_id,picked,picked_by,picked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                    $n['id'], $i['id'] ?? null, (string) ($i['sku'] ?? ''), mb_substr((string) ($i['title'] ?? ''), 0, 500), (int) ($i['quantity'] ?? 0), $price,
                    $i['variant']['id'] ?? null, $i['product']['id'] ?? null, (int) ($p['picked'] ?? 0), $p['picked_by'] ?? null, $p['picked_at'] ?? null);
            }
            Db::run('DELETE FROM order_fulfillments WHERE order_id=?', $n['id']);
            foreach ($n['fulfillments'] ?? [] as $f) {
                $t = ($f['trackingInfo'] ?? [])[0] ?? [];
                Db::run('INSERT INTO order_fulfillments(id,order_id,status,display_status,tracking_number,tracking_company,tracking_url,delivered_at,in_transit_at,location_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id), status=VALUES(status), display_status=VALUES(display_status), tracking_number=VALUES(tracking_number), tracking_company=VALUES(tracking_company), tracking_url=VALUES(tracking_url), delivered_at=VALUES(delivered_at), in_transit_at=VALUES(in_transit_at), location_id=VALUES(location_id), created_at=VALUES(created_at), updated_at=VALUES(updated_at)',
                    $f['id'], $n['id'], $f['status'] ?? null, $f['displayStatus'] ?? null, $t['number'] ?? null, $t['company'] ?? null, $t['url'] ?? null,
                    self::ts($f['deliveredAt'] ?? null), self::ts($f['inTransitAt'] ?? null), $f['location']['id'] ?? null, self::ts($f['createdAt'] ?? null), self::ts($f['updatedAt'] ?? null));
            }
            Db::run('DELETE FROM order_refunds WHERE order_id=?', $n['id']);
            foreach ($n['refunds'] ?? [] as $r) {
                Db::run('INSERT INTO order_refunds(id,order_id,amount,note,created_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id), amount=VALUES(amount), note=VALUES(note), created_at=VALUES(created_at)', $r['id'], $n['id'], self::money($r['totalRefundedSet'] ?? null), $r['note'] ?? null, self::ts($r['createdAt'] ?? null));
            }
            Db::run('DELETE FROM order_transactions WHERE order_id=?', $n['id']);
            foreach ($n['transactions'] ?? [] as $x) {
                Db::run('INSERT INTO order_transactions(id,order_id,kind,status,gateway,amount,currency,processed_at) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id), kind=VALUES(kind), status=VALUES(status), gateway=VALUES(gateway), amount=VALUES(amount), currency=VALUES(currency), processed_at=VALUES(processed_at)',
                    $x['id'], $n['id'], (string) ($x['kind'] ?? ''), (string) ($x['status'] ?? ''), mb_substr((string) ($x['gateway'] ?? ''), 0, 120),
                    self::money($x['amountSet'] ?? null), $x['amountSet']['shopMoney']['currencyCode'] ?? null, self::ts($x['processedAt'] ?? null));
            }
            if ($ful && ! empty($ful['createdAt'])) {
                Db::run('UPDATE orders SET dispatched_at=COALESCE(dispatched_at,?) WHERE id=?', self::ts($ful['createdAt']), $n['id']);
            }
            Logic::refreshOrder($n['id']);
        });
        return true;
    }

    private function moreLineItems(string $orderId, ?string $after): array
    {
        $out = [];
        while ($after) {
            $d = $this->shopify->gql('query($id:ID!,$after:String){ order(id:$id){ lineItems(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ '.self::LINE_FIELDS.' } } } }', ['id' => $orderId, 'after' => $after]);
            $li = $d['order']['lineItems'] ?? [];
            $out = array_merge($out, $li['nodes'] ?? []);
            $after = ! empty($li['pageInfo']['hasNextPage']) ? $li['pageInfo']['endCursor'] : null;
        }
        return $out;
    }

    /** Fetch the latest state of one order from Shopify and store it. */
    public function refreshOrder(string $gid): bool
    {
        $d = $this->shopify->gql('query($id:ID!){ order(id:$id){ '.self::ORDER_FIELDS.' } }', ['id' => $gid]);
        if (empty($d['order'])) {
            return false;
        }
        $ok = $this->upsertOrder($d['order'], true);
        Logic::recomputeCustomers(array_keys($this->touchedPhones)); // this customer only
        $this->touchedPhones = [];
        return $ok;
    }

    public function syncOrders(?callable $onProgress = null, string $mode = 'incremental', ?int $uid = null): int
    {
        $first = ! Settings::get('orders_synced_at');
        $since = Settings::get('orders_synced_at');
        if ($mode === 'reconcile') {
            $q = "updated_at:>='".gmdate('Y-m-d\TH:i:s\Z', time() - 3 * 86400)."'";
        } elseif ($since) {
            $q = "updated_at:>='".gmdate('Y-m-d\TH:i:s\Z', strtotime($since) - 600)."'";
        } else {
            $mode = 'initial';
            $q = "created_at:>='".gmdate('Y-m-d\TH:i:s\Z', time() - (int) Settings::get('history_days', 60) * 86400)."'";
        }
        $n = $this->paginate('orders', $mode, $q, $uid,
            'query($q:String,$after:String){ orders(first:50, after:$after, query:$q, sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ '.self::ORDER_FIELDS.' } } }',
            'orders', fn ($o) => $this->upsertOrder($o), $onProgress);
        if ($mode !== 'reconcile') {
            Settings::set('orders_synced_at', Settings::get('_run_started.orders'));
        }
        if ($first || count($this->touchedPhones) > 2000) {
            Logic::recomputeCustomers();
        } elseif ($this->touchedPhones) {
            Logic::recomputeCustomers(array_keys($this->touchedPhones));
        }
        $this->touchedPhones = [];
        Activity::sync('shopify-orders', true, $n.' orders updated');
        return $n;
    }

    /* ================================================================ products */

    public function upsertProduct(array $p): void
    {
        $tags = $p['tags'] ?? [];
        $lot = '';
        foreach ($tags as $t) {
            if (preg_match('/lot/i', $t)) {
                $lot = $t;
                break;
            }
        }
        $variants = $p['variants']['nodes'] ?? [];
        if (! empty($p['variants']['pageInfo']['hasNextPage'])) {
            $variants = array_merge($variants, $this->moreVariants($p['id'], $p['variants']['pageInfo']['endCursor']));
        }
        $image = $p['featuredMedia']['preview']['image']['url'] ?? '';
        Db::tx(function () use ($p, $tags, $lot, $variants, $image) {
            Db::run('INSERT INTO shopify_products(id,title,handle,status,vendor,product_type,tags,description_html,image,total_inventory,variants_count,created_at,updated_at,deleted_at,synced_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE title=VALUES(title),handle=VALUES(handle),status=VALUES(status),vendor=VALUES(vendor),product_type=VALUES(product_type),
                tags=VALUES(tags),description_html=VALUES(description_html),image=VALUES(image),total_inventory=VALUES(total_inventory),variants_count=VALUES(variants_count),created_at=VALUES(created_at),
                updated_at=VALUES(updated_at),deleted_at=NULL,synced_at=VALUES(synced_at)',
                $p['id'], mb_substr((string) $p['title'], 0, 500), $p['handle'] ?? null, $p['status'] ?? null, $p['vendor'] ?? null, $p['productType'] ?? null, implode(', ', $tags),
                $p['descriptionHtml'] ?? null, $image, $p['totalInventory'] ?? null, $p['variantsCount']['count'] ?? count($variants), self::ts($p['createdAt'] ?? null), self::ts($p['updatedAt'] ?? null));
            Db::run('DELETE FROM product_media WHERE product_id=?', $p['id']);
            foreach (array_values($p['media']['nodes'] ?? []) as $i => $m) {
                if (! empty($m['id'])) {
                    Db::run('INSERT IGNORE INTO product_media(id,product_id,url,alt,position) VALUES(?,?,?,?,?)', $m['id'], $p['id'], $m['preview']['image']['url'] ?? null, mb_substr((string) ($m['alt'] ?? ''), 0, 500), $i);
                }
            }
            if (isset($p['collections'])) {
                Db::run('DELETE FROM collection_product WHERE product_id=?', $p['id']);
                foreach ($p['collections']['nodes'] ?? [] as $c) {
                    Db::run('INSERT INTO shopify_collections(id,title,handle,updated_at,synced_at) VALUES(?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE title=VALUES(title),handle=VALUES(handle),updated_at=VALUES(updated_at),synced_at=VALUES(synced_at)',
                        $c['id'], $c['title'] ?? null, $c['handle'] ?? null, self::ts($c['updatedAt'] ?? null));
                    Db::run('INSERT IGNORE INTO collection_product(collection_id,product_id) VALUES(?,?)', $c['id'], $p['id']);
                }
            }
            $seen = [];
            foreach ($variants as $v) {
                $seen[] = $v['id'];
                $opt = [];
                foreach ($v['selectedOptions'] ?? [] as $o) {
                    $opt[mb_strtolower($o['name'])] = $o['value'];
                }
                $sk = Logic::parseSku($v['sku'] ?? '');
                $qty = (int) ($v['inventoryQuantity'] ?? 0);
                $prev = Db::get('SELECT qty, sold_at FROM products WHERE variant_id=?', $v['id']);
                $sold = $prev['sold_at'] ?? null;
                if ($prev && $prev['qty'] > 0 && $qty <= 0 && ! $sold) {
                    $sold = gmdate('Y-m-d H:i:s');
                }
                if ($qty > 0) {
                    $sold = null;
                }
                $cost = isset($v['inventoryItem']['unitCost']['amount']) ? (float) $v['inventoryItem']['unitCost']['amount'] : null;
                Db::run('INSERT INTO products(variant_id,product_id,title,variant_title,sku,barcode,rack,category,price,compare_at,cost,qty,status,created_at,updated_at,tags,lot,brand,ptype,size,cond,image,handle,inventory_item,options,sold_at,synced_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE product_id=VALUES(product_id),title=VALUES(title),variant_title=VALUES(variant_title),sku=VALUES(sku),barcode=VALUES(barcode),
                    rack=VALUES(rack),category=VALUES(category),price=VALUES(price),compare_at=VALUES(compare_at),cost=VALUES(cost),qty=VALUES(qty),status=VALUES(status),created_at=VALUES(created_at),updated_at=VALUES(updated_at),
                    tags=VALUES(tags),lot=VALUES(lot),brand=VALUES(brand),ptype=VALUES(ptype),size=VALUES(size),cond=VALUES(cond),image=VALUES(image),handle=VALUES(handle),inventory_item=VALUES(inventory_item),
                    options=VALUES(options),sold_at=VALUES(sold_at),synced_at=VALUES(synced_at)',
                    $v['id'], $p['id'], mb_substr((string) $p['title'], 0, 500), mb_substr((string) ($v['title'] ?? ''), 0, 255), (string) ($v['sku'] ?? ''), $v['barcode'] ?? null, $sk['rack'], $sk['category'],
                    (float) ($v['price'] ?? 0), isset($v['compareAtPrice']) && $v['compareAtPrice'] !== null ? (float) $v['compareAtPrice'] : null, $cost, $qty, $p['status'] ?? null,
                    self::ts($p['createdAt'] ?? null), self::ts($p['updatedAt'] ?? null), implode(', ', $tags), $lot, $p['vendor'] ?? '', $p['productType'] ?? '', $opt['size'] ?? '', $opt['condition'] ?? '',
                    $image, $p['handle'] ?? null, $v['inventoryItem']['id'] ?? null, json_encode($v['selectedOptions'] ?? [], JSON_UNESCAPED_UNICODE), $sold);
            }
            // variants removed in Shopify
            if ($seen) {
                Db::run("UPDATE products SET status='DELETED', qty=0 WHERE product_id=? AND variant_id NOT IN (".Db::marks($seen).')', $p['id'], ...$seen);
            }
        });
    }

    private function moreVariants(string $productId, ?string $after): array
    {
        $out = [];
        while ($after) {
            $d = $this->shopify->gql('query($id:ID!,$after:String){ product(id:$id){ variants(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ '.self::VARIANT_FIELDS.' } } } }', ['id' => $productId, 'after' => $after]);
            $v = $d['product']['variants'] ?? [];
            $out = array_merge($out, $v['nodes'] ?? []);
            $after = ! empty($v['pageInfo']['hasNextPage']) ? $v['pageInfo']['endCursor'] : null;
        }
        return $out;
    }

    public function refreshProduct(string $gid): bool
    {
        $d = $this->shopify->gql('query($id:ID!){ product(id:$id){ '.self::PRODUCT_FIELDS.' } }', ['id' => $gid]);
        if (empty($d['product'])) {
            $this->markProductDeleted($gid);
            return false;
        }
        $this->upsertProduct($d['product']);
        return true;
    }

    public function markProductDeleted(string $gid): void
    {
        Db::run('UPDATE shopify_products SET deleted_at=UTC_TIMESTAMP(), status=? WHERE id=?', 'DELETED', $gid);
        Db::run("UPDATE products SET status='DELETED', qty=0 WHERE product_id=?", $gid);
    }

    public function syncProducts(?callable $onProgress = null, string $mode = 'incremental', ?int $uid = null): int
    {
        $since = Settings::get('products_synced_at');
        if ($since && $mode !== 'reconcile') {
            $q = "updated_at:>='".gmdate('Y-m-d\TH:i:s\Z', strtotime($since) - 600)."'";
        } else {
            // first import: everything listed in the last N days or still in stock (older sold-out pairs are history);
            // product_history_days = 0 imports the whole catalogue
            $mode = $since ? $mode : 'initial';
            $days = (int) Settings::get('product_history_days', 365);
            $q = $days > 0 ? "created_at:>='".gmdate('Y-m-d\TH:i:s\Z', time() - $days * 86400)."' OR inventory_total:>0" : null;
        }
        $n = $this->paginate('products', $mode, $q, $uid,
            'query($q:String,$after:String){ products(first:50, after:$after, query:$q, sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ '.self::PRODUCT_FIELDS.' } } }',
            'products', function ($p) {
                $this->upsertProduct($p);
                return true;
            }, $onProgress);
        if ($mode !== 'reconcile') {
            Settings::set('products_synced_at', Settings::get('_run_started.products'));
        }
        Activity::sync('shopify-products', true, $n.' products updated');
        return $n;
    }

    /* =============================================================== customers */

    public function upsertCustomer(array $c): void
    {
        Db::run('INSERT INTO shopify_customers(id,first_name,last_name,email,phone,orders_count,amount_spent,state,tags,city,province,created_at,updated_at,synced_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE first_name=VALUES(first_name),last_name=VALUES(last_name),email=VALUES(email),phone=VALUES(phone),
            orders_count=VALUES(orders_count),amount_spent=VALUES(amount_spent),state=VALUES(state),tags=VALUES(tags),city=VALUES(city),province=VALUES(province),created_at=VALUES(created_at),
            updated_at=VALUES(updated_at),synced_at=VALUES(synced_at)',
            $c['id'], $c['firstName'] ?? null, $c['lastName'] ?? null, $c['defaultEmailAddress']['emailAddress'] ?? null, Logic::normPhone($c['defaultPhoneNumber']['phoneNumber'] ?? null) ?: null,
            (int) ($c['numberOfOrders'] ?? 0), (float) ($c['amountSpent']['amount'] ?? 0), $c['state'] ?? null, implode(', ', $c['tags'] ?? []),
            $c['defaultAddress']['city'] ?? null, $c['defaultAddress']['province'] ?? null, self::ts($c['createdAt'] ?? null), self::ts($c['updatedAt'] ?? null));
    }

    public function refreshCustomer(string $gid): bool
    {
        $d = $this->shopify->gql('query($id:ID!){ customer(id:$id){ '.self::CUSTOMER_FIELDS.' } }', ['id' => $gid]);
        if (empty($d['customer'])) {
            return false;
        }
        $this->upsertCustomer($d['customer']);
        return true;
    }

    public function syncCustomers(?callable $onProgress = null, string $mode = 'incremental', ?int $uid = null): int
    {
        $since = Settings::get('customers_synced_at');
        $q = $since ? "updated_at:>='".gmdate('Y-m-d\TH:i:s\Z', strtotime($since) - 600)."'" : null;
        try {
            $n = $this->paginate('customers', $since ? $mode : 'initial', $q, $uid,
                'query($q:String,$after:String){ customers(first:50, after:$after, query:$q, sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ '.self::CUSTOMER_FIELDS.' } } }',
                'customers', function ($c) {
                    $this->upsertCustomer($c);
                    return true;
                }, $onProgress);
        } catch (ShopifyException $e) {
            if ($e->kind === 'scope') {
                // no read_customers scope / protected customer data access: the ERP keeps working from order data
                ShopifyStatus::issue('missing_scope', 'customers', null, 'Customer import skipped: '.$e->getMessage());
                Activity::sync('shopify-customers', false, $e->getMessage());
                return 0;
            }
            throw $e;
        }
        Settings::set('customers_synced_at', Settings::get('_run_started.customers'));
        Activity::sync('shopify-customers', true, $n.' customers updated');
        return $n;
    }

    /* ======================================================= locations & stock */

    public function saveLocations(array $nodes): void
    {
        foreach ($nodes as $l) {
            Db::run('INSERT INTO shopify_locations(id,name,is_active,fulfills_online,city,synced_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE name=VALUES(name),is_active=VALUES(is_active),fulfills_online=VALUES(fulfills_online),city=VALUES(city),synced_at=VALUES(synced_at)',
                $l['id'], $l['name'], ! empty($l['isActive']) ? 1 : 0, ! empty($l['fulfillsOnlineOrders']) ? 1 : 0, $l['address']['city'] ?? null);
        }
    }

    public function syncLocations(): int
    {
        $d = $this->shopify->gql('{ locations(first:50, includeInactive:true){ nodes{ id name isActive fulfillsOnlineOrders address{ city } } } }');
        $nodes = $d['locations']['nodes'] ?? [];
        $this->saveLocations($nodes);
        return count($nodes);
    }

    /** Location-level stock for every active location (full refresh; webhooks keep it current in between). */
    public function syncInventoryLevels(?callable $onProgress = null, ?int $uid = null): int
    {
        $this->syncLocations();
        $n = 0;
        foreach (Db::all('SELECT id FROM shopify_locations WHERE is_active=1') as $loc) {
            $after = null;
            do {
                $d = $this->shopify->gql('query($id:ID!,$after:String){ location(id:$id){ inventoryLevels(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ updatedAt item{id} quantities(names:["available","on_hand","committed"]){ name quantity } } } } }',
                    ['id' => $loc['id'], 'after' => $after]);
                $lv = $d['location']['inventoryLevels'] ?? [];
                Db::tx(function () use ($lv, $loc, &$n) {
                    foreach ($lv['nodes'] ?? [] as $x) {
                        $q = array_column($x['quantities'] ?? [], 'quantity', 'name');
                        $this->saveLevel($x['item']['id'], $loc['id'], $q['available'] ?? null, $q['on_hand'] ?? null, $q['committed'] ?? null, $x['updatedAt'] ?? null);
                        $n++;
                    }
                });
                $onProgress && $onProgress($n);
                $after = ! empty($lv['pageInfo']['hasNextPage']) ? $lv['pageInfo']['endCursor'] : null;
            } while ($after);
        }
        Settings::set('inventory_synced_at', gmdate('Y-m-d\TH:i:s\Z'));
        Activity::sync('shopify-inventory', true, $n.' stock levels updated');
        return $n;
    }

    public function saveLevel(string $itemId, string $locationId, $available, $onHand = null, $committed = null, ?string $updatedAt = null): void
    {
        Db::run('INSERT INTO inventory_levels(inventory_item_id,location_id,available,on_hand,committed,updated_at,synced_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE available=VALUES(available), on_hand=COALESCE(VALUES(on_hand),on_hand), committed=COALESCE(VALUES(committed),committed), updated_at=VALUES(updated_at), synced_at=VALUES(synced_at)',
            $itemId, $locationId, $available === null ? null : (int) $available, $onHand === null ? null : (int) $onHand, $committed === null ? null : (int) $committed, self::ts($updatedAt) ?? gmdate('Y-m-d H:i:s'));
    }

    /** After a stock change: refresh the variant's total quantity (all locations) and cost from Shopify. */
    public function refreshInventoryItem(string $itemGid): void
    {
        $d = $this->shopify->gql('query($id:ID!){ inventoryItem(id:$id){ id unitCost{amount} variants(first:5){ nodes{ id inventoryQuantity product{id} } } } }', ['id' => $itemGid]);
        $it = $d['inventoryItem'] ?? null;
        if (! $it) {
            return;
        }
        foreach ($it['variants']['nodes'] ?? [] as $v) {
            $qty = (int) ($v['inventoryQuantity'] ?? 0);
            $prev = Db::get('SELECT qty, sold_at FROM products WHERE variant_id=?', $v['id']);
            if (! $prev) {
                if (! empty($v['product']['id'])) {
                    $this->refreshProduct($v['product']['id']);
                }
                continue;
            }
            $sold = $prev['sold_at'];
            if ($prev['qty'] > 0 && $qty <= 0 && ! $sold) {
                $sold = gmdate('Y-m-d H:i:s');
            }
            if ($qty > 0) {
                $sold = null;
            }
            Db::run('UPDATE products SET qty=?, cost=COALESCE(?,cost), sold_at=?, synced_at=UTC_TIMESTAMP() WHERE variant_id=?', $qty, isset($it['unitCost']['amount']) ? (float) $it['unitCost']['amount'] : null, $sold, $v['id']);
        }
    }

    /* ============================================================ pagination */

    /**
     * Walk a connection page by page. Saves the cursor after each page in sync_runs; a run of the same
     * kind+query that did not finish is resumed from its cursor instead of starting over.
     */
    private function paginate(string $kind, string $mode, ?string $query, ?int $uid, string $gql, string $root, callable $each, ?callable $onProgress): int
    {
        // an interrupted run of the same kind and mode continues where it stopped, with ITS query (a first import
        // filters by a date computed when it started, so a new query would not match the saved cursor)
        $resume = Db::get("SELECT * FROM sync_runs WHERE kind=? AND mode=? AND status IN ('running','failed') AND `cursor` IS NOT NULL AND started_at > (UTC_TIMESTAMP() - INTERVAL 2 DAY) ORDER BY id DESC LIMIT 1",
            $kind, $mode);
        if ($resume) {
            $runId = (int) $resume['id'];
            $query = $resume['query'];
            $after = $resume['cursor'];
            $n = (int) $resume['items'];
            Db::run("UPDATE sync_runs SET status='running', error=NULL WHERE id=?", $runId);
            Activity::sync('shopify-'.$kind, true, "Resuming interrupted {$kind} import after {$n} records");
        } else {
            $runId = Db::run('INSERT INTO sync_runs(kind,mode,status,`query`,user_id,started_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())', $kind, $mode, 'running', $query, $uid)->lastInsertRowid;
            $after = null;
            $n = 0;
            Settings::set('_run_started.'.$kind, gmdate('Y-m-d\TH:i:s\Z'));
        }
        try {
            do {
                $d = $this->shopify->gql($gql, ['q' => $query, 'after' => $after]);
                $conn = $d[$root] ?? ['nodes' => [], 'pageInfo' => []];
                // one transaction per page: much faster than one per record, and a failed page is redone whole on resume
                Db::tx(function () use ($conn, $each, &$n) {
                    foreach ($conn['nodes'] ?? [] as $node) {
                        $each($node);
                        $n++;
                    }
                });
                $after = ! empty($conn['pageInfo']['hasNextPage']) ? $conn['pageInfo']['endCursor'] : null;
                Db::run('UPDATE sync_runs SET `cursor`=?, items=?, pages=pages+1 WHERE id=?', $after, $n, $runId);
                $onProgress && $onProgress($n);
            } while ($after);
            Db::run("UPDATE sync_runs SET status='done', finished_at=UTC_TIMESTAMP() WHERE id=?", $runId);
        } catch (\Throwable $e) {
            Db::run("UPDATE sync_runs SET status='failed', error=?, finished_at=UTC_TIMESTAMP() WHERE id=?", mb_substr($e->getMessage(), 0, 2000), $runId);
            throw $e;
        }
        return $n;
    }
}
