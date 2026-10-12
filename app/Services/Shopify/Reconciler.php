<?php

namespace App\Services\Shopify;

use App\Erp\Activity;
use App\Erp\Db;
use App\Erp\Settings;

/**
 * Scheduled safety net behind the webhooks: finds Shopify records that are missing or older in the
 * ERP and refreshes them, retries failed webhook events and records what could not be fixed.
 */
class Reconciler
{
    public function __construct(private ShopifyClient $shopify, private ShopifySync $sync) {}

    public function run(?callable $onProgress = null): array
    {
        $out = ['orders' => 0, 'products' => 0, 'webhooks' => 0];
        $days = (int) Settings::get('history_days', 60);
        $since = gmdate('Y-m-d\TH:i:s\Z', time() - $days * 86400);

        // 1. orders created in the history window: missing or stale locally -> refresh
        $out['orders'] = $this->sweep("created_at:>='{$since}'", 'orders', 'orders', 'SELECT id, updated_at FROM orders WHERE id IN (%s)',
            fn ($id) => $this->sync->refreshOrder($id), $onProgress);

        // 2. products changed in the last 7 days (catches missed product webhooks)
        $p7 = gmdate('Y-m-d\TH:i:s\Z', time() - 7 * 86400);
        $out['products'] = $this->sweep("updated_at:>='{$p7}'", 'products', 'products', 'SELECT id, updated_at FROM shopify_products WHERE id IN (%s)',
            fn ($id) => $this->sync->refreshProduct($id), $onProgress);

        // 3. counts (Shopify vs ERP) for the order window
        try {
            $d = $this->shopify->gql('query($q:String){ ordersCount(query:$q, limit:null){ count precision } }', ['q' => "created_at:>='{$since}'"]);
            $remote = (int) ($d['ordersCount']['count'] ?? 0);
            $local = (int) Db::val("SELECT COUNT(*) FROM orders WHERE id LIKE 'gid://shopify/Order/%' AND created_at >= ?", gmdate('Y-m-d H:i:s', strtotime($since)));
            $out['count'] = ['shopify' => $remote, 'erp' => $local];
            if ($remote !== $local) {
                ShopifyStatus::issue('mismatch', 'orders', null, "Orders in the last {$days} days: Shopify {$remote}, ERP {$local}", $out['count']);
            }
        } catch (ShopifyException $e) {
            $out['countError'] = $e->getMessage();
        }

        // 4. webhook events that failed: process again
        foreach (Db::all("SELECT id FROM webhook_events WHERE status='failed' AND attempts < 10 ORDER BY id LIMIT 200") as $ev) {
            try {
                app(WebhookProcessor::class)->process((int) $ev['id']);
                $out['webhooks']++;
            } catch (\Throwable) {
                // stays failed, with the error recorded
            }
        }
        // old processed events are not needed
        Db::run("DELETE FROM webhook_events WHERE status IN ('done','skipped','duplicate') AND received_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)");

        Settings::set('reconcile_at', gmdate('Y-m-d\TH:i:s\Z'));
        Activity::sync('shopify-reconcile', true, json_encode($out));
        return $out;
    }

    /** Page through id+updatedAt only (cheap) and refresh the ones the ERP lacks or has older. */
    private function sweep(string $query, string $root, string $label, string $localSql, callable $refresh, ?callable $onProgress): int
    {
        $fixed = 0;
        $seen = 0;
        $after = null;
        do {
            $d = $this->shopify->gql('query($q:String,$after:String){ '.$root.'(first:250, after:$after, query:$q){ pageInfo{hasNextPage endCursor} nodes{ id updatedAt } } }', ['q' => $query, 'after' => $after]);
            $conn = $d[$root] ?? [];
            $nodes = $conn['nodes'] ?? [];
            if ($nodes) {
                $ids = array_column($nodes, 'id');
                $local = [];
                foreach (Db::all(sprintf($localSql, Db::marks($ids)), ...$ids) as $r) {
                    $local[$r['id']] = $r['updated_at'];
                }
                foreach ($nodes as $n) {
                    $have = $local[$n['id']] ?? null;
                    if ($have === null || strtotime($have.' UTC') < strtotime($n['updatedAt'])) {
                        try {
                            $refresh($n['id']);
                            $fixed++;
                        } catch (ShopifyException $e) {
                            ShopifyStatus::issue('sync_failed', $label, $n['id'], 'Could not refresh: '.$e->getMessage());
                        }
                    }
                }
            }
            $seen += count($nodes);
            $onProgress && $onProgress("{$label} checked {$seen}, fixed {$fixed}");
            $after = ! empty($conn['pageInfo']['hasNextPage']) ? $conn['pageInfo']['endCursor'] : null;
        } while ($after);
        return $fixed;
    }
}
