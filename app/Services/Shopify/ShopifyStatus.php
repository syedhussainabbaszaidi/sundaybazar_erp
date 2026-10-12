<?php

namespace App\Services\Shopify;

use App\Erp\Db;
use App\Erp\Settings;

/** Connection health, review queue (sync_issues) and alerts for the Shopify integration. */
class ShopifyStatus
{
    /** Flag something for a person to review (deduplicated while open). */
    public static function issue(string $kind, ?string $entity, ?string $entityId, string $message, $detail = null): void
    {
        $open = Db::get("SELECT id FROM sync_issues WHERE status='open' AND kind=? AND COALESCE(entity,'')=? AND COALESCE(entity_id,'')=? AND message=?", $kind, (string) $entity, (string) $entityId, mb_substr($message, 0, 2000));
        if ($open) {
            return;
        }
        Db::run('INSERT INTO sync_issues(kind,entity,entity_id,message,detail,status,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())', $kind, $entity, $entityId, mb_substr($message, 0, 2000),
            $detail === null ? null : json_encode($detail, JSON_UNESCAPED_UNICODE), 'open');
    }

    public static function status(): array
    {
        $c = app(ShopifyClient::class);
        $cfg = $c->cfg();
        $check = Settings::get('shopify_check');
        $state = SyncRunner::state();
        return [
            'configured' => $c->configured(),
            'shop' => $cfg['shop'],
            'apiVersion' => $cfg['apiVersion'],
            'auth' => $cfg['token'] !== '' ? 'fixed access token' : 'client credentials (Dev Dashboard app)',
            'connected' => (bool) ($check['ok'] ?? false),
            'lastCheck' => $check,
            'scopes' => Settings::get('shopify_scopes', []),
            'missingScopes' => $check['missing'] ?? null,
            'accessWarning' => Settings::get('shopify_access_warning'),
            'uninstalled' => Settings::get('shopify_uninstalled'),
            'location' => Db::get('SELECT id,name FROM shopify_locations WHERE id=?', (string) Settings::get('shopify_location', '')),
            'writes' => config('shopify.write'),
            'sync' => $state,
            'lastSync' => [
                'orders' => Settings::get('orders_synced_at'), 'products' => Settings::get('products_synced_at'), 'customers' => Settings::get('customers_synced_at'),
                'inventory' => Settings::get('inventory_synced_at'), 'reconcile' => Settings::get('reconcile_at'),
            ],
            'runs' => Db::all('SELECT id,kind,mode,status,items,pages,error,started_at,finished_at FROM sync_runs ORDER BY id DESC LIMIT 15'),
            'counts' => [
                'orders' => (int) Db::val("SELECT COUNT(*) FROM orders WHERE id LIKE 'gid://shopify/Order/%'"),
                'products' => (int) Db::val('SELECT COUNT(*) FROM shopify_products WHERE deleted_at IS NULL'),
                'variants' => (int) Db::val("SELECT COUNT(*) FROM products WHERE variant_id LIKE 'gid://shopify/ProductVariant/%'"),
                'customers' => (int) Db::val('SELECT COUNT(*) FROM shopify_customers'),
                'locations' => (int) Db::val('SELECT COUNT(*) FROM shopify_locations WHERE is_active=1'),
            ],
            'webhooks' => [
                'registered' => Settings::get('shopify_webhooks'),
                'last' => Db::get('SELECT topic, status, received_at FROM webhook_events ORDER BY id DESC LIMIT 1'),
                'pending' => (int) Db::val("SELECT COUNT(*) FROM webhook_events WHERE status='received'"),
                'failed' => (int) Db::val("SELECT COUNT(*) FROM webhook_events WHERE status='failed'"),
            ],
            'failedSyncs24h' => (int) Db::val('SELECT COUNT(*) FROM sync_log WHERE ok=0 AND at > (UTC_TIMESTAMP() - INTERVAL 1 DAY)'),
            'lastOk' => Settings::get('shopify_last_ok', []) ?: (object) [],
            'recentErrors' => Db::all('SELECT at, kind, message FROM sync_log WHERE ok=0 ORDER BY id DESC LIMIT 10'),
            'recentWrites' => Db::all('SELECT w.id, w.kind, w.target_id, o.name order_name, w.status, w.error, w.at, us.name user FROM shopify_writes w LEFT JOIN users us ON us.id=w.user_id LEFT JOIN orders o ON o.id=w.target_id ORDER BY w.id DESC LIMIT 25'),
            'failedJobs' => (int) Db::val('SELECT COUNT(*) FROM failed_jobs'),
            'pendingJobs' => (int) Db::val('SELECT COUNT(*) FROM jobs'),
            'openIssues' => (int) Db::val("SELECT COUNT(*) FROM sync_issues WHERE status='open'"),
            'failedWrites' => (int) Db::val("SELECT COUNT(*) FROM shopify_writes WHERE status IN ('failed','unknown') AND at > (UTC_TIMESTAMP() - INTERVAL 7 DAY)"),
        ];
    }

    public static function alerts(): array
    {
        $out = [];
        $c = app(ShopifyClient::class);
        if (! $c->configured()) {
            return $out;
        }
        $check = Settings::get('shopify_check');
        if ($check && empty($check['ok'])) {
            $out[] = ['level' => 'bad', 'text' => 'Shopify connection failed: '.mb_substr((string) ($check['error'] ?? ''), 0, 160), 'href' => '#/settings'];
        }
        if (Settings::get('shopify_uninstalled')) {
            $out[] = ['level' => 'bad', 'text' => 'The ERP app was uninstalled from Shopify — sync is stopped', 'href' => '#/settings'];
        }
        $last = Settings::get('orders_synced_at');
        if ($last && strtotime($last) < time() - 6 * 3600) {
            $out[] = ['level' => 'warn', 'text' => 'Shopify orders have not synced for '.round((time() - strtotime($last)) / 3600).' hours', 'href' => '#/settings'];
        }
        $issues = (int) Db::val("SELECT COUNT(*) FROM sync_issues WHERE status='open'");
        if ($issues) {
            $out[] = ['level' => 'warn', 'text' => "{$issues} Shopify sync item(s) need review", 'href' => '#/settings'];
        }
        $failed = (int) Db::val("SELECT COUNT(*) FROM webhook_events WHERE status='failed'");
        if ($failed) {
            $out[] = ['level' => 'warn', 'text' => "{$failed} Shopify webhook(s) failed to process (they are retried by the nightly reconcile)", 'href' => '#/settings'];
        }
        return $out;
    }
}
