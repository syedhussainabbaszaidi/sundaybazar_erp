<?php

namespace App\Services\Shopify;

use App\Erp\Activity;
use App\Erp\AutoTick;
use App\Erp\Core\PostEx;
use App\Erp\Db;
use App\Erp\Settings;
use Illuminate\Support\Facades\Cache;

/**
 * Runs the Shopify / PostEx syncs. Each kind has its own lock, so a long stock-level import never holds
 * up the minute-by-minute order sync. Progress is kept in the `sync_state` setting so every browser sees it.
 */
class SyncRunner
{
    /** all = the usual incremental syncs; full = the initial import again (everything in the import window) */
    public const KINDS = ['all', 'full', 'orders', 'products', 'customers', 'inventory', 'postex', 'reconcile'];

    private const PARTS = ['all' => ['orders', 'products', 'postex'], 'full' => ['orders', 'products', 'customers', 'inventory']];

    /** Webhooks are registered and Shopify delivered one recently: polling can slow down to a safety net. */
    public static function webhooksHealthy(): bool
    {
        $reg = Settings::get('shopify_webhooks');
        if (! $reg || empty($reg['topics'])) {
            return false;
        }
        // registered for THIS installation's address (a local copy of the live database also has the live registration)
        if (parse_url((string) ($reg['url'] ?? ''), PHP_URL_HOST) !== parse_url(app(WebhookRegistrar::class)->callbackUrl(), PHP_URL_HOST)) {
            return false;
        }
        $last = Db::val('SELECT MAX(received_at) FROM webhook_events');
        return $last && strtotime($last.' UTC') > time() - 6 * 3600;
    }

    /** Has $minutes passed since this kind last ran (or did it never run)? */
    public static function due(string $kind, int $minutes): bool
    {
        $last = (Settings::get('sync_last_run', []) ?: [])[$kind] ?? null;
        return ! $last || strtotime($last) <= time() - $minutes * 60 + 5;
    }

    public static function markRun(string $kind): void
    {
        $runs = Settings::get('sync_last_run', []) ?: [];
        foreach (self::PARTS[$kind] ?? [$kind] as $k) {
            $runs[$k] = gmdate('Y-m-d\TH:i:s\Z');
        }
        Settings::set('sync_last_run', $runs);
    }

    private const LABEL = ['orders' => 'Orders', 'products' => 'Products', 'customers' => 'Customers', 'inventory' => 'Stock levels', 'reconcile' => 'Missing-data check', 'postex' => 'PostEx'];

    /** One state per kind (several syncs can run at the same time). */
    private static function kindState(string $kind): array
    {
        $s = Settings::get('sync_state.'.$kind, []) ?: [];
        $s['running'] = ! empty($s['running']) && ! empty($s['heartbeat']) && strtotime($s['heartbeat']) > time() - 15 * 60;
        return $s;
    }

    public static function state(): array
    {
        $kinds = [];
        $running = [];
        foreach (array_keys(self::LABEL) as $k) {
            $kinds[$k] = self::kindState($k);
            if ($kinds[$k]['running']) {
                $running[] = $k;
            }
        }
        $tick = AutoTick::lastTick();
        $latest = null;
        foreach ($kinds as $k => $x) {
            if (! empty($x['heartbeat']) && (! $latest || $x['heartbeat'] > $kinds[$latest]['heartbeat'])) {
                $latest = $k;
            }
        }
        return [
            'running' => (bool) $running,
            'kind' => $running ? implode(',', $running) : $latest,
            'progress' => $running ? implode(' · ', array_map(fn ($k) => $kinds[$k]['progress'] ?? (self::LABEL[$k].'…'), $running)) : ($latest ? $kinds[$latest]['progress'] ?? '' : ''),
            'queued' => (bool) Settings::get('sync_request'),
            'kinds' => $kinds,
            'auto' => [
                'active' => $tick !== null && $tick > time() - 5 * 60,
                'lastTick' => $tick ? gmdate('Y-m-d H:i:s', $tick) : null,
                'mode' => self::webhooksHealthy() ? 'webhooks' : 'polling',
                'lastRun' => Settings::get('sync_last_run', []) ?: (object) [],
            ],
            'last' => ['orders' => Settings::get('orders_synced_at'), 'products' => Settings::get('products_synced_at'), 'postex' => Settings::get('postex_synced_at')],
        ];
    }

    private static function put(string $kind, array $patch): void
    {
        Settings::set('sync_state.'.$kind, array_merge(Settings::get('sync_state.'.$kind, []) ?: [], $patch, ['heartbeat' => gmdate('Y-m-d\TH:i:s\Z')]));
    }

    /** "Sync now": runs within seconds in the background (no queue worker needed). */
    public static function start(string $kind = 'all', ?int $userId = null): array
    {
        $kind = in_array($kind, self::KINDS, true) ? $kind : 'all';
        if (Settings::get('demo')) {
            return self::state();
        }
        Settings::set('sync_request', ['kind' => $kind, 'user' => $userId, 'at' => gmdate('Y-m-d\TH:i:s\Z')]);
        AutoTick::kick(0);
        return self::state();
    }

    /** Do the work now (erp:tick, shopify:sync). */
    public static function run(string $kind = 'all', ?int $userId = null): void
    {
        if (Settings::get('demo')) {
            return;
        }
        if ($kind === 'full') { // forget the checkpoints: the next runs import the whole window again (same records, no duplicates)
            foreach (['orders_synced_at', 'products_synced_at', 'customers_synced_at'] as $k) {
                Settings::forget($k);
            }
        }
        foreach (self::PARTS[$kind] ?? [$kind] as $part) {
            self::runOne($part, $userId);
        }
        if ($userId) {
            Activity::log($userId, 'sync', 'settings', $kind);
        }
    }

    private static function runOne(string $kind, ?int $userId): void
    {
        $sh = app(ShopifyClient::class)->configured() && ! Settings::get('shopify_uninstalled');
        if ($kind === 'postex' ? ! app(PostEx::class)->configured() : ! $sh) {
            return; // not connected: nothing to do (and nothing to report as done)
        }
        $lock = Cache::lock('erp-sync:'.$kind, 3 * 3600);
        if (! $lock->get()) {
            return; // this kind is already running
        }
        $sync = app(ShopifySync::class);
        $label = self::LABEL[$kind] ?? $kind;
        self::put($kind, ['running' => true, 'progress' => $label.': starting', 'started_at' => gmdate('Y-m-d\TH:i:s\Z')]);
        $progress = fn ($n) => self::put($kind, ['progress' => $label.': '.$n]);
        try {
            match ($kind) {
                'orders' => $sync->syncOrders($progress, 'incremental', $userId),
                'products' => $sync->syncProducts($progress, 'incremental', $userId),
                'customers' => $sync->syncCustomers($progress, 'incremental', $userId),
                'inventory' => $sync->syncInventoryLevels($progress, $userId),
                'reconcile' => app(Reconciler::class)->run($progress),
                'postex' => (function () use ($progress) {
                    app(PostEx::class)->syncAll($progress);
                    Settings::set('postex_synced_at', gmdate('Y-m-d\TH:i:s\Z'));
                })(),
                default => null,
            };
            self::put($kind, ['progress' => $label.': done', 'ok_at' => gmdate('Y-m-d\TH:i:s\Z'), 'error' => null]);
            Settings::set('shopify_last_ok', array_merge(Settings::get('shopify_last_ok', []) ?: [], [$kind => gmdate('Y-m-d\TH:i:s\Z')]));
        } catch (\Throwable $e) {
            self::put($kind, ['progress' => $label.': error', 'error' => mb_substr($e->getMessage(), 0, 500)]);
            Activity::sync($kind, false, $e->getMessage());
            if ($e instanceof ShopifyException && in_array($e->kind, ['auth', 'config'], true)) {
                Settings::set('shopify_check', ['at' => gmdate('Y-m-d H:i:s'), 'ok' => false, 'error' => $e->getMessage()]);
            }
        } finally {
            self::put($kind, ['running' => false]);
            $lock->release();
        }
    }
}
