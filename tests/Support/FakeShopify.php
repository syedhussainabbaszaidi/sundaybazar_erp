<?php

namespace Tests\Support;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

/**
 * A fake Shopify Admin API for tests. Register answers by matching text in the GraphQL query:
 *   $fake->on('orders(first', fn ($vars, $n) => [...data...]);
 * The token endpoint answers a client-credentials token automatically.
 * Every request is recorded in $fake->calls.
 */
class FakeShopify
{
    public array $calls = [];

    public array $handlers = [];

    public int $tokenCalls = 0;

    /** @var callable|null */
    public $tokenResponse = null;

    public function __construct()
    {
        Http::fake(function (Request $req) {
            $url = $req->url();
            if (str_contains($url, '/admin/oauth/access_token')) {
                $this->tokenCalls++;
                $this->calls[] = ['token', $req->data()];
                if ($this->tokenResponse) {
                    return ($this->tokenResponse)($req, $this->tokenCalls);
                }
                return Http::response(['access_token' => 'tok-'.$this->tokenCalls, 'scope' => 'read_products,write_products,read_orders,write_orders,read_inventory,write_inventory,read_locations,read_customers', 'expires_in' => 86399]);
            }
            if (str_contains($url, '/graphql.json')) {
                $body = $req->data();
                $q = $body['query'] ?? '';
                $vars = (array) ($body['variables'] ?? []);
                $this->calls[] = ['gql', $q, $vars, $req->header('X-Shopify-Access-Token')[0] ?? null];
                foreach ($this->handlers as [$needle, $fn, &$count]) {
                    if (str_contains($q, $needle)) {
                        $count++;
                        $r = $fn($vars, $count, $req);
                        if ($r instanceof \GuzzleHttp\Promise\PromiseInterface) {
                            return $r;
                        }
                        return Http::response(['data' => $r, 'extensions' => ['cost' => ['throttleStatus' => ['currentlyAvailable' => 1000, 'restoreRate' => 50]]]]);
                    }
                }
                return Http::response(['errors' => [['message' => 'FakeShopify: no handler for query: '.substr($q, 0, 80)]]]);
            }
            if (str_contains($url, '.json')) {
                $this->calls[] = ['rest', $url];
                foreach ($this->handlers as [$needle, $fn, &$count]) {
                    if (str_contains($url, $needle)) {
                        $count++;
                        return $fn([], $count, $req);
                    }
                }
            }
            return Http::response('not faked: '.$url, 500);
        });
    }

    public function on(string $needle, callable $fn): self
    {
        $this->handlers[] = [$needle, $fn, 0];
        return $this;
    }

    public function gqlCalls(string $needle = ''): array
    {
        return array_values(array_filter($this->calls, fn ($c) => $c[0] === 'gql' && str_contains($c[1], $needle)));
    }

    public static function order(int $n, array $over = []): array
    {
        return array_replace_recursive([
            'id' => "gid://shopify/Order/{$n}", 'name' => "#{$n}", 'createdAt' => '2026-10-01T10:00:00Z', 'updatedAt' => '2026-10-01T10:00:00Z',
            'cancelledAt' => null, 'cancelReason' => null, 'closedAt' => null, 'displayFinancialStatus' => 'PENDING', 'displayFulfillmentStatus' => 'UNFULFILLED',
            'tags' => [], 'note' => null, 'phone' => null, 'email' => 'c@example.com', 'currencyCode' => 'PKR', 'paymentGatewayNames' => ['Cash on Delivery (COD)'], 'sourceName' => 'web',
            'totalPriceSet' => ['shopMoney' => ['amount' => '3499.0']], 'subtotalPriceSet' => ['shopMoney' => ['amount' => '3299.0']], 'totalTaxSet' => ['shopMoney' => ['amount' => '0.0']],
            'totalRefundedSet' => ['shopMoney' => ['amount' => '0.0']], 'totalShippingPriceSet' => ['shopMoney' => ['amount' => '200.0']], 'totalDiscountsSet' => ['shopMoney' => ['amount' => '0.0']],
            'shippingAddress' => ['name' => 'Ayesha Khan', 'phone' => '+92 300 1234567', 'address1' => 'House 1', 'address2' => 'Street 2', 'city' => 'Lahore', 'province' => 'Punjab'],
            'customer' => ['id' => 'gid://shopify/Customer/77', 'displayName' => 'Ayesha Khan', 'defaultPhoneNumber' => ['phoneNumber' => '+923001234567']],
            'lineItems' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => [[
                'id' => "gid://shopify/LineItem/{$n}1", 'title' => 'Nike Air', 'quantity' => 1, 'sku' => 'EA-S-9001', 'variant' => ['id' => 'gid://shopify/ProductVariant/9001'],
                'product' => ['id' => 'gid://shopify/Product/900'], 'originalUnitPriceSet' => ['shopMoney' => ['amount' => '3299.0']], 'discountedUnitPriceSet' => ['shopMoney' => ['amount' => '3299.0']],
            ]]],
            'fulfillments' => [], 'refunds' => [],
        ], $over);
    }

    public static function product(int $n, array $over = []): array
    {
        return array_replace_recursive([
            'id' => "gid://shopify/Product/{$n}", 'title' => "Nike Air {$n}", 'handle' => "nike-air-{$n}", 'status' => 'ACTIVE', 'createdAt' => '2026-09-01T10:00:00Z', 'updatedAt' => '2026-10-01T10:00:00Z',
            'vendor' => 'Nike', 'productType' => 'Sneakers', 'tags' => ['Lot 12', 'Men'], 'descriptionHtml' => '<p>Used, good</p>', 'totalInventory' => 1, 'variantsCount' => ['count' => 1],
            'featuredMedia' => ['preview' => ['image' => ['url' => 'https://cdn.shopify.com/x.jpg']]], 'media' => ['nodes' => [['id' => "gid://shopify/MediaImage/{$n}", 'alt' => 'shoe', 'preview' => ['image' => ['url' => 'https://cdn.shopify.com/x.jpg']]]]],
            'collections' => ['nodes' => [['id' => 'gid://shopify/Collection/5', 'title' => 'Sneakers', 'handle' => 'sneakers', 'updatedAt' => '2026-09-01T00:00:00Z']]],
            'variants' => ['pageInfo' => ['hasNextPage' => false, 'endCursor' => null], 'nodes' => [[
                'id' => "gid://shopify/ProductVariant/{$n}1", 'title' => '42 / Good', 'sku' => "EA-S-{$n}", 'barcode' => null, 'price' => '3299.00', 'compareAtPrice' => '4999.00', 'inventoryQuantity' => 1, 'position' => 1,
                'selectedOptions' => [['name' => 'Size', 'value' => '42'], ['name' => 'Condition', 'value' => 'Good']], 'inventoryItem' => ['id' => "gid://shopify/InventoryItem/{$n}1", 'unitCost' => ['amount' => '1200.0']],
            ]]],
        ], $over);
    }

    public static function page(string $root, array $nodes, ?string $next = null): array
    {
        return [$root => ['pageInfo' => ['hasNextPage' => $next !== null, 'endCursor' => $next], 'nodes' => $nodes]];
    }
}
