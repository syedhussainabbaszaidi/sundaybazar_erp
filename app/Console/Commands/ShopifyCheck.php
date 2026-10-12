<?php

namespace App\Console\Commands;

use App\Erp\Settings;
use App\Services\Shopify\ShopifyClient;
use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\ShopifySync;
use Illuminate\Console\Command;

/** Verifies the Shopify connection: token exchange, store identity, scopes, locations. Read-only. */
class ShopifyCheck extends Command
{
    protected $signature = 'shopify:check';

    protected $description = 'Test the Shopify Admin API connection (read-only) and show granted permissions';

    public function handle(ShopifyClient $c, ShopifySync $sync): int
    {
        $cfg = $c->cfg();
        $this->line('Store domain : '.($cfg['shop'] ?: '(not set)'));
        $this->line('API version  : '.$cfg['apiVersion']);
        $this->line('Auth         : '.($cfg['token'] !== '' ? 'fixed access token' : 'client credentials').' | client id '.($cfg['clientId'] !== '' ? 'set' : 'MISSING').' | secret '.($cfg['clientSecret'] !== '' ? 'set' : 'MISSING'));
        if (! $c->configured()) {
            $this->error('Shopify is not configured: set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env');
            return self::FAILURE;
        }
        if ($p = $c->clientIdProblem()) {
            $this->warn('Client ID    : '.$p);
        }
        try {
            $c->getToken(true);
            $this->info('Token        : obtained (not shown)');
            $d = $c->shopInfo();
            $s = $d['shop'];
            $this->info('Connected to : '.$s['name'].' ('.$s['myshopifyDomain'].', '.$s['currencyCode'].', '.$s['ianaTimezone'].', '.($s['primaryDomain']['host'] ?? '').')');
            $sync->saveLocations($d['locations']['nodes'] ?? []);
            foreach ($d['locations']['nodes'] ?? [] as $l) {
                $this->line('  location   : '.$l['name'].($l['isActive'] ? '' : ' (inactive)').'  '.$l['id']);
            }
            $scopes = $c->grantedScopes();
            $this->line('Scopes       : '.implode(', ', $scopes));
            $missing = $c->missingScopes($scopes);
            if ($missing) {
                $this->warn('Missing      : '.implode(', ', $missing).'  (features needing these will not work)');
            }
            Settings::set('shopify_check', ['at' => gmdate('Y-m-d H:i:s'), 'ok' => true, 'shop' => $s, 'missing' => $missing]);
            return self::SUCCESS;
        } catch (ShopifyException $e) {
            Settings::set('shopify_check', ['at' => gmdate('Y-m-d H:i:s'), 'ok' => false, 'error' => $e->getMessage()]);
            $this->error($e->getMessage());
            return self::FAILURE;
        }
    }
}
