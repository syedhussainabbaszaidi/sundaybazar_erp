<?php

namespace App\Console\Commands;

use App\Services\Shopify\ShopifyException;
use App\Services\Shopify\WebhookRegistrar;
use Illuminate\Console\Command;

class ShopifyWebhooks extends Command
{
    protected $signature = 'shopify:webhooks {action=list : list|register|remove} {--url= : callback URL (default APP_URL/api/hooks/shopify)}';

    protected $description = 'List, register or remove the Shopify webhook subscriptions of this ERP';

    public function handle(WebhookRegistrar $reg): int
    {
        try {
            $action = $this->argument('action');
            if ($action === 'register') {
                $r = $reg->register($this->option('url') ?: null);
                $this->info('Created: '.(implode(', ', $r['created']) ?: '-'));
                $this->line('Already there: '.(implode(', ', $r['existing']) ?: '-'));
                foreach ($r['failed'] as $t => $e) {
                    $this->warn("Failed {$t}: {$e}");
                }
                return self::SUCCESS;
            }
            if ($action === 'remove') {
                $this->info('Removed '.$reg->removeAll($this->option('url') ?: $reg->callbackUrl()).' subscription(s)');
                return self::SUCCESS;
            }
            foreach ($reg->list() as $w) {
                $this->line(str_pad($w['topic'], 30).' '.$w['uri']);
            }
            return self::SUCCESS;
        } catch (ShopifyException $e) {
            $this->error($e->getMessage());
            return self::FAILURE;
        }
    }
}
