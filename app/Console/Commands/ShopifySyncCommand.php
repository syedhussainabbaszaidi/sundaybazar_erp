<?php

namespace App\Console\Commands;

use App\Services\Shopify\SyncRunner;
use Illuminate\Console\Command;

/** Run a sync in the foreground: orders, products, customers, inventory, postex, reconcile or all. */
class ShopifySyncCommand extends Command
{
    protected $signature = 'shopify:sync {kind=all : all|orders|products|customers|inventory|postex|reconcile} {--force : clear the lock of a sync that crashed or was stopped (only when none is really running)}';

    protected $description = 'Import / update data from Shopify (and PostEx) now, in this terminal';

    public function handle(): int
    {
        $kind = $this->argument('kind');
        if (! in_array($kind, SyncRunner::KINDS, true)) {
            $this->error('Unknown kind. Use one of: '.implode(', ', SyncRunner::KINDS));
            return self::FAILURE;
        }
        if ($this->option('force')) {
            foreach (SyncRunner::KINDS as $k) {
                \Illuminate\Support\Facades\Cache::lock('erp-sync:'.$k)->forceRelease();
            }
            $this->warn('Cleared the sync locks.');
        }
        $this->info("Syncing {$kind}...");
        SyncRunner::run($kind);
        $s = SyncRunner::state();
        $this->line('Result: '.$s['progress']);
        return str_starts_with((string) $s['progress'], 'Error') ? self::FAILURE : self::SUCCESS;
    }
}
