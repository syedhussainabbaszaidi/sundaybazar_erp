<?php

namespace Tests\Feature;

use App\Services\Shopify\ShopifyClient;
use App\Services\Shopify\ShopifyException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\Support\FakeShopify;
use Tests\TestCase;

/** Shopify authentication, store identity, throttling and failure handling (mocked Admin API). */
class ShopifyClientTest extends TestCase
{
    public function test_exchanges_client_credentials_for_a_token_and_caches_it(): void
    {
        $fake = (new FakeShopify)->on('shop{', fn () => ['shop' => ['name' => 'Test', 'myshopifyDomain' => 'test-shop.myshopify.com']]);
        $c = app(ShopifyClient::class);
        $c->gql('{ shop{ name } }');
        $c->gql('{ shop{ name } }');
        $this->assertSame(1, $fake->tokenCalls, 'token is fetched once and reused');
        $this->assertSame(['grant_type' => 'client_credentials', 'client_id' => 'test-client-id', 'client_secret' => 'test-client-secret'], $fake->calls[0][1]);
        $this->assertSame('tok-1', $fake->gqlCalls()[0][3], 'token sent as X-Shopify-Access-Token');
        // the cached token is encrypted, never stored in plain text
        $this->assertStringNotContainsString('tok-1', (string) Cache::get('shopify.access_token'));
    }

    public function test_renews_the_token_once_on_401(): void
    {
        $fake = (new FakeShopify)->on('shop{', fn ($v, $n) => $n === 1 ? Http::response(['errors' => 'Invalid API key or access token'], 401) : ['shop' => ['name' => 'Test']]);
        $d = app(ShopifyClient::class)->gql('{ shop{ name } }');
        $this->assertSame('Test', $d['shop']['name']);
        $this->assertSame(2, $fake->tokenCalls);
        $this->assertSame('tok-2', $fake->gqlCalls()[1][3]);
    }

    public function test_reports_bad_credentials_clearly(): void
    {
        $fake = new FakeShopify;
        $fake->tokenResponse = fn () => Http::response(['error' => 'invalid_client'], 400);
        try {
            app(ShopifyClient::class)->gql('{ shop{ name } }');
            $this->fail('expected exception');
        } catch (ShopifyException $e) {
            $this->assertSame('auth', $e->kind);
            $this->assertStringContainsString('SHOPIFY_CLIENT_ID', $e->getMessage());
            $this->assertStringNotContainsString('test-client-secret', $e->getMessage(), 'secret never appears in errors');
        }
    }

    public function test_unknown_client_id_is_explained(): void
    {
        config(['shopify.client_id' => 'x8a61590a449e1473f169f2b4e4f9aa4a']); // the real-world mistake: one character pasted in front
        $fake = new FakeShopify;
        $fake->tokenResponse = fn () => Http::response(['error' => 'application_cannot_be_found', 'error_description' => 'Could not find Shopify API application with api_key x8a61590a449e1473f169f2b4e4f9aa4a'], 400);
        $this->assertStringContainsString('an extra character', app(ShopifyClient::class)->clientIdProblem());
        try {
            app(ShopifyClient::class)->getToken(true);
            $this->fail('expected exception');
        } catch (ShopifyException $e) {
            $this->assertStringContainsString('application_cannot_be_found', $e->getMessage());
            $this->assertStringContainsString('extra character', $e->getMessage());
            $this->assertStringNotContainsString('test-client-secret', $e->getMessage());
        }
        config(['shopify.client_id' => '8a61590a449e1473f169f2b4e4f9aa4a']);
        $this->assertNull(app(ShopifyClient::class)->clientIdProblem());
    }

    public function test_retries_throttled_and_server_errors(): void
    {
        $fake = (new FakeShopify)
            ->on('throttle', fn ($v, $n) => $n === 1 ? Http::response(['errors' => [['message' => 'Throttled', 'extensions' => ['code' => 'THROTTLED']]]]) : ['ok' => 1])
            ->on('busy', fn ($v, $n) => $n < 3 ? Http::response('busy', 503) : ['ok' => 2])
            ->on('ratelimit', fn ($v, $n) => $n === 1 ? Http::response('slow down', 429, ['Retry-After' => '2']) : ['ok' => 3]);
        $c = app(ShopifyClient::class);
        $this->assertSame(['ok' => 1], $c->gql('{ throttle }'));
        $this->assertSame(['ok' => 2], $c->gql('{ busy }'));
        $this->assertSame(['ok' => 3], $c->gql('{ ratelimit }'));
        $this->assertCount(2, $fake->gqlCalls('throttle'));
        $this->assertCount(3, $fake->gqlCalls('busy'));
    }

    public function test_gives_up_after_repeated_server_errors(): void
    {
        (new FakeShopify)->on('busy', fn () => Http::response('down', 502));
        $this->expectException(ShopifyException::class);
        app(ShopifyClient::class)->gql('{ busy }');
    }

    public function test_missing_permission_is_reported_as_scope_error(): void
    {
        (new FakeShopify)->on('customers', fn () => Http::response(['errors' => [['message' => 'Access denied for customers field. Required access: `read_customers` access scope.', 'extensions' => ['code' => 'ACCESS_DENIED']]]]));
        try {
            app(ShopifyClient::class)->gql('{ customers(first:1){ nodes{ id } } }');
            $this->fail('expected exception');
        } catch (ShopifyException $e) {
            $this->assertSame('scope', $e->kind);
            $this->assertFalse($e->retryable());
        }
    }

    public function test_store_identity_must_match_the_configured_domain(): void
    {
        (new FakeShopify)->on('shop{', fn () => ['shop' => ['name' => 'Other', 'myshopifyDomain' => 'someone-else.myshopify.com'], 'locations' => ['nodes' => []]]);
        $this->expectExceptionMessage('Connected store is someone-else.myshopify.com');
        app(ShopifyClient::class)->shopInfo();
    }

    public function test_reports_missing_scopes(): void
    {
        (new FakeShopify)->on('currentAppInstallation', fn () => ['currentAppInstallation' => ['accessScopes' => [['handle' => 'write_orders'], ['handle' => 'read_products']]]]);
        $missing = app(ShopifyClient::class)->missingScopes();
        $this->assertNotContains('read_orders', $missing, 'write_orders implies read_orders');
        $this->assertContains('write_inventory', $missing);
        $this->assertContains('read_customers', $missing);
    }

    public function test_rest_pagination_follows_the_next_link(): void
    {
        $fake = (new FakeShopify)->on('checkouts.json', fn ($v, $n, $req) => str_contains($req->url(), 'page_info=p2')
            ? Http::response(['checkouts' => [['id' => 2]]])
            : Http::response(['checkouts' => [['id' => 1]]], 200, ['Link' => '<https://test-shop.myshopify.com/admin/api/2025-10/checkouts.json?limit=250&page_info=p2>; rel="next"']));
        $c = app(ShopifyClient::class);
        [$j1, $next] = $c->restGet('checkouts.json', ['limit' => 250]);
        [$j2, $end] = $c->restGet($next);
        $this->assertSame(1, $j1['checkouts'][0]['id']);
        $this->assertSame(2, $j2['checkouts'][0]['id']);
        $this->assertNull($end);
    }

    public function test_not_configured_is_a_clear_error_without_any_request(): void
    {
        config(['shopify.client_secret' => '']);
        $fake = new FakeShopify;
        $this->assertFalse(app(ShopifyClient::class)->configured());
        try {
            app(ShopifyClient::class)->gql('{ shop{ name } }');
        } catch (ShopifyException $e) {
            $this->assertSame('config', $e->kind);
        }
        $this->assertSame([], $fake->calls);
    }
}
