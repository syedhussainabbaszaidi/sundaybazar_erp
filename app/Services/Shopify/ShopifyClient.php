<?php

namespace App\Services\Shopify;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Sleep;

/**
 * Shopify Admin API client.
 *
 * Authentication: apps made in the Shopify Dev Dashboard and installed on a store of the same
 * organisation use the OAuth client-credentials grant: the Client ID + Secret are exchanged for an
 * Admin API access token that expires (about 24 h). The token is cached encrypted and renewed a few
 * minutes before it expires, or straight away when Shopify answers 401. A fixed legacy token
 * (SHOPIFY_ACCESS_TOKEN) is used instead when set. Secrets never leave the server.
 */
class ShopifyClient
{
    private const TOKEN_CACHE = 'shopify.access_token';

    public function cfg(): array
    {
        $shop = strtolower(trim((string) config('shopify.shop')));
        $shop = preg_replace('#^https?://#', '', $shop);
        $shop = preg_replace('#/.*$#', '', $shop);
        if ($shop !== '' && ! str_contains($shop, '.')) {
            $shop .= '.myshopify.com';
        }
        return [
            'shop' => $shop,
            'token' => (string) config('shopify.access_token'),
            'clientId' => (string) config('shopify.client_id'),
            'clientSecret' => (string) config('shopify.client_secret'),
            'apiVersion' => (string) config('shopify.api_version', '2025-10'),
        ];
    }

    public function configured(): bool
    {
        $c = $this->cfg();
        return $c['shop'] !== '' && ($c['token'] !== '' || ($c['clientId'] !== '' && $c['clientSecret'] !== ''));
    }

    public function baseUrl(): string
    {
        return rtrim((string) config('shopify.base_url') ?: 'https://'.$this->cfg()['shop'], '/');
    }

    /** Is a write direction (prices, inventory, fulfillments, tags, order_cancel) switched on? */
    public function writeEnabled(string $what): bool
    {
        return (bool) config('shopify.write.'.$what, false);
    }

    /* ------------------------------------------------------------------ token */

    public function getToken(bool $fresh = false): string
    {
        $c = $this->cfg();
        if (! $this->configured()) {
            throw new ShopifyException('Shopify is not connected. Set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the .env file.', 'config');
        }
        if ($c['token'] !== '') {
            return $c['token'];
        }
        if (! $fresh) {
            $cached = Cache::get(self::TOKEN_CACHE);
            if ($cached) {
                try {
                    $t = json_decode(Crypt::decryptString($cached), true);
                    if (($t['shop'] ?? '') === $c['shop'] && ($t['exp'] ?? 0) > time() + 300) {
                        return $t['token'];
                    }
                } catch (\Throwable) {
                    // unreadable (APP_KEY changed): fetch a new one
                }
            }
        }
        try {
            $r = Http::asForm()->acceptJson()->timeout(30)->post($this->baseUrl().'/admin/oauth/access_token', [
                'grant_type' => 'client_credentials',
                'client_id' => $c['clientId'],
                'client_secret' => $c['clientSecret'],
            ]);
        } catch (ConnectionException $e) {
            throw new ShopifyException('Cannot reach Shopify ('.$c['shop'].'): '.$e->getMessage(), 'network');
        }
        if (! $r->successful() || ! $r->json('access_token')) {
            // Shopify says why (e.g. application_cannot_be_found = unknown Client ID, invalid_client = wrong secret);
            // its answer never contains our secret, so it is safe to show
            $code = (string) ($r->json('error') ?? '');
            $why = $code !== '' ? ' Shopify: '.$code.' — '.mb_substr(preg_replace('/api_key \S+/', 'api_key (Client ID)', (string) $r->json('error_description')), 0, 160).'.' : '';
            if ($code === 'application_cannot_be_found') {
                $why .= ' The Client ID is not the one of an existing app'.($this->clientIdProblem() ? ' ('.$this->clientIdProblem().')' : '').'.';
            }
            $msg = match ($r->status()) {
                400 => 'Shopify refused the client credentials (400).'.$why.' Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (same app) and that the app is installed on '.$c['shop'].'.',
                401, 403 => 'Shopify login failed ('.$r->status().'). The app must be installed on this store and belong to the same organisation, and the secret must be current.',
                404 => 'Shopify store '.$c['shop'].' was not found. SHOPIFY_STORE_DOMAIN must be the *.myshopify.com domain.',
                default => 'Shopify login failed ('.$r->status().').',
            };
            throw new ShopifyException($msg, 'auth', $r->status());
        }
        $token = (string) $r->json('access_token');
        $ttl = max(600, (int) ($r->json('expires_in') ?: 86399));
        Cache::put(self::TOKEN_CACHE, Crypt::encryptString(json_encode(['shop' => $c['shop'], 'token' => $token, 'exp' => time() + $ttl])), $ttl);
        if ($r->json('scope')) {
            \App\Erp\Settings::set('shopify_scopes', array_values(array_filter(array_map('trim', explode(',', (string) $r->json('scope'))))));
        }
        return $token;
    }

    /** Dev Dashboard Client IDs are 32 hex characters; a pasted extra character or a space is a common mistake. */
    public function clientIdProblem(): ?string
    {
        $id = $this->cfg()['clientId'];
        if ($id === '' || $this->cfg()['token'] !== '') {
            return null;
        }
        if (trim($id) !== $id || preg_match('/\s/', $id)) {
            return 'SHOPIFY_CLIENT_ID contains spaces';
        }
        if (preg_match('/^["\']|["\']$/', $id)) {
            return 'SHOPIFY_CLIENT_ID is wrapped in quotes';
        }
        if (! preg_match('/^[0-9a-f]{32}$/i', $id)) {
            return 'SHOPIFY_CLIENT_ID should be 32 letters/numbers (0-9, a-f); it has '.strlen($id).(preg_match('/[0-9a-f]{32}/i', $id) ? ' — an extra character was probably pasted with it' : '');
        }
        return null;
    }

    public function forgetToken(): void
    {
        Cache::forget(self::TOKEN_CACHE);
    }

    /* ---------------------------------------------------------------- graphql */

    /**
     * Run a GraphQL Admin API operation and return its `data`.
     * Retries throttling / 5xx with back-off, renews the token once on 401 and waits when the
     * cost bucket runs low so bulk imports stay inside the rate limit.
     */
    public function gql(string $query, array $variables = []): array
    {
        $tries = 0;
        $renewed = false;
        while (true) {
            $tries++;
            try {
                $r = Http::withHeaders(['X-Shopify-Access-Token' => $this->getToken()])
                    ->acceptJson()->asJson()->timeout((int) config('shopify.timeout', 30))
                    ->post($this->baseUrl().'/admin/api/'.$this->cfg()['apiVersion'].'/graphql.json', ['query' => $query, 'variables' => (object) $variables]);
            } catch (ConnectionException $e) {
                if ($tries < 4) {
                    Sleep::for(2 * $tries)->seconds();
                    continue;
                }
                throw new ShopifyException('Cannot reach Shopify: '.$e->getMessage(), 'network');
            }

            if ($r->status() === 401 && ! $renewed && $this->cfg()['token'] === '') {
                $renewed = true;
                $this->forgetToken();
                $this->getToken(true);
                continue;
            }
            if ($r->status() === 401) {
                throw new ShopifyException('Shopify rejected the access token (401). The app may have been uninstalled or the secret rotated.', 'auth', 401);
            }
            if ($r->status() === 403) {
                throw new ShopifyException('Shopify refused access (403): the app is missing a permission for this request. '.$this->errorText($r), 'scope', 403);
            }
            if ($r->status() === 429 || $r->status() >= 500) {
                if ($tries < 6) {
                    $wait = (int) ($r->header('Retry-After') ?: 2 * $tries);
                    Sleep::for(min(30, max(1, $wait)))->seconds();
                    continue;
                }
                throw new ShopifyException('Shopify is busy ('.$r->status().'), try again later', $r->status() === 429 ? 'throttled' : 'network', $r->status());
            }
            if (! $r->successful()) {
                throw new ShopifyException('Shopify error '.$r->status().': '.$this->errorText($r), 'graphql', $r->status());
            }

            $j = $r->json() ?? [];
            if (! empty($j['errors'])) {
                $errs = is_array($j['errors']) ? $j['errors'] : [['message' => (string) $j['errors']]];
                $codes = array_map(fn ($e) => $e['extensions']['code'] ?? '', $errs);
                if (in_array('THROTTLED', $codes, true) && $tries < 10) {
                    Sleep::for(3)->seconds();
                    continue;
                }
                $msg = implode('; ', array_map(fn ($e) => $e['message'] ?? 'error', $errs));
                $kind = in_array('ACCESS_DENIED', $codes, true) || preg_match('/access denied|not approved to access|protected customer data|required access/i', $msg) ? 'scope' : 'graphql';
                // a partial answer (data + errors on some fields, e.g. protected customer data) is still usable
                if (! empty($j['data']) && $kind === 'scope') {
                    Log::warning('Shopify partial data: '.$msg);
                    \App\Erp\Settings::set('shopify_access_warning', ['at' => gmdate('Y-m-d H:i:s'), 'message' => mb_substr($msg, 0, 500)]);
                    return $j['data'];
                }
                throw new ShopifyException('Shopify: '.$msg, $kind, $r->status(), ['errors' => $errs]);
            }

            // stay under the query-cost bucket
            $t = $j['extensions']['cost']['throttleStatus'] ?? null;
            if ($t && ($t['currentlyAvailable'] ?? 1000) < 300) {
                $rate = max(1, (int) ($t['restoreRate'] ?? 50));
                Sleep::for((int) ceil((400 - $t['currentlyAvailable']) / $rate))->seconds();
            }
            return $j['data'] ?? [];
        }
    }

    /** Throws ShopifyException('user_errors') when a mutation answered userErrors. */
    public static function assertNoUserErrors(array $payload, string $what): void
    {
        $errs = $payload['userErrors'] ?? $payload['orderCancelUserErrors'] ?? [];
        if ($errs) {
            throw new ShopifyException($what.': '.implode('; ', array_map(fn ($e) => $e['message'] ?? 'error', $errs)), 'user_errors', null, ['userErrors' => $errs]);
        }
    }

    /* ------------------------------------------------------------------- rest */

    /**
     * REST Admin GET (used only where GraphQL has no equivalent, e.g. abandoned checkouts).
     * Returns [json, nextPageUrl|null]. $pathOrUrl may be a full "next" URL from a Link header.
     */
    public function restGet(string $pathOrUrl, array $query = [], ?string $version = null): array
    {
        $url = str_starts_with($pathOrUrl, 'http') ? $pathOrUrl : $this->baseUrl().'/admin/api/'.($version ?: $this->cfg()['apiVersion']).'/'.ltrim($pathOrUrl, '/');
        $tries = 0;
        while (true) {
            $tries++;
            try {
                $r = Http::withHeaders(['X-Shopify-Access-Token' => $this->getToken()])->acceptJson()->timeout(30)->get($url, $query ?: null); // null keeps the query of a "next" page URL (page_info)
            } catch (ConnectionException $e) {
                if ($tries < 3) {
                    Sleep::for(2)->seconds();
                    continue;
                }
                throw new ShopifyException('Cannot reach Shopify: '.$e->getMessage(), 'network');
            }
            if ($r->status() === 401 && $tries === 1 && $this->cfg()['token'] === '') {
                $this->forgetToken();
                continue;
            }
            if (($r->status() === 429 || $r->status() >= 500) && $tries < 5) {
                Sleep::for((int) ($r->header('Retry-After') ?: 2))->seconds();
                continue;
            }
            if (! $r->successful()) {
                throw new ShopifyException('Shopify '.$r->status().($r->status() === 403 ? ' (the app is missing a permission)' : '').' '.mb_substr($r->body(), 0, 160), $r->status() === 403 ? 'scope' : 'graphql', $r->status());
            }
            $next = null;
            if (preg_match('/<([^>]+)>;\s*rel="next"/', (string) $r->header('Link'), $m)) {
                $next = $m[1];
            }
            return [$r->json() ?? [], $next];
        }
    }

    /* ------------------------------------------------------------ store info */

    /** Store identity + locations: used by "Test connection". Verifies the token works for this exact shop. */
    public function shopInfo(): array
    {
        $d = $this->gql('{ shop{ name myshopifyDomain currencyCode ianaTimezone primaryDomain{ host } } locations(first:50){ nodes{ id name isActive fulfillsOnlineOrders address{ city } } } }');
        $want = $this->cfg()['shop'];
        $got = strtolower($d['shop']['myshopifyDomain'] ?? '');
        if ($want && $got && $got !== $want && ! config('shopify.base_url')) {
            throw new ShopifyException("Connected store is {$got}, but SHOPIFY_STORE_DOMAIN says {$want}", 'config');
        }
        return $d;
    }

    /** Scopes granted to the installed app. */
    public function grantedScopes(): array
    {
        try {
            $d = $this->gql('{ currentAppInstallation{ accessScopes{ handle } } }');
            $s = array_map(fn ($x) => $x['handle'], $d['currentAppInstallation']['accessScopes'] ?? []);
            \App\Erp\Settings::set('shopify_scopes', $s);
            return $s;
        } catch (ShopifyException) {
            return (array) \App\Erp\Settings::get('shopify_scopes', []);
        }
    }

    /** Scopes from config('shopify.scopes') the app does not have (write_x implies read_x). */
    public function missingScopes(?array $granted = null): array
    {
        $g = $granted ?? $this->grantedScopes();
        $has = fn ($s) => in_array($s, $g, true) || (str_starts_with($s, 'read_') && in_array('write_'.substr($s, 5), $g, true));
        return array_values(array_filter(config('shopify.scopes', []), fn ($s) => ! $has($s)));
    }

    private function errorText(Response $r): string
    {
        $j = $r->json();
        if (is_array($j) && isset($j['errors'])) {
            return is_string($j['errors']) ? $j['errors'] : json_encode($j['errors']);
        }
        return mb_substr($r->body(), 0, 200);
    }
}
