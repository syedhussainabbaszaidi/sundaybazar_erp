<?php

namespace App\Console\Commands;

use App\Erp\Activity;
use App\Erp\Erp;
use App\Erp\Settings;
use App\Services\Shopify\SyncRunner;
use App\Services\Shopify\WebhookProcessor;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;

/**
 * The ERP's minute clock. Run every minute by the scheduler (cron / schedule:work), or started automatically
 * by the web app when no scheduler is running (App\Erp\AutoTick). It
 *  1. applies Shopify webhook events that have not been processed yet (retries with back-off),
 *  2. runs the incremental Shopify syncs that are due — often while webhooks are not arriving (local PC,
 *     webhooks not registered), rarely as a safety net when they are,
 *  3. runs the module jobs (accounts posting, couriers, HR, tickets …) and queued jobs.
 */
class ErpTick extends Command
{
    protected $signature = 'erp:tick {--tick= : run module jobs as if this were minute N (testing)}';

    protected $description = 'Run the due background work: Shopify sync, webhook retries, module jobs';

    /** minutes between incremental syncs: [without working webhooks, with working webhooks] */
    public const CADENCE = ['orders' => [1, 10], 'products' => [5, 30], 'customers' => [15, 60], 'inventory' => [1440, 1440], 'reconcile' => [1440, 1440], 'postex' => [120, 120]];

    /** quick incremental syncs run before the module jobs; the long ones after, so they never delay new orders */
    private const QUICK = ['orders', 'products'];

    public function handle(): int
    {
        Settings::set('tick_at', gmdate('Y-m-d\TH:i:s\Z'));
        $tick = $this->option('tick') !== null ? (int) $this->option('tick') : intdiv(time(), 60);

        if (! Settings::get('demo')) {
            // 1. webhook events not applied yet
            try {
                app(WebhookProcessor::class)->retryDue();
            } catch (\Throwable $e) {
                report($e);
            }
            // 2. syncs: a "Sync now" request first, then whatever is due
            if ($req = Settings::get('sync_request')) {
                Settings::forget('sync_request');
                $this->runSync((string) ($req['kind'] ?? 'all'), $req['user'] ?? null);
            }
            $this->syncDue(true);
        }

        // 3. module jobs (same rhythm as the original server: tick % every == offset)
        foreach (Erp::modules() as $m) {
            foreach ($m->jobs() as $j) {
                $every = max(1, (int) (is_callable($j['every']) ? ($j['every'])() : $j['every']) ?: 60);
                if ($tick % $every !== (($j['offset'] ?? 0) % $every)) {
                    continue;
                }
                $name = $m->name.':'.($j['name'] ?? 'job');
                $lock = Cache::lock('erp-job:'.$name, 3600);
                if (! $lock->get()) {
                    continue; // still running from an earlier tick
                }
                try {
                    ($j['run'])();
                } catch (\Throwable $e) {
                    report($e);
                    Activity::sync($name, false, $e->getMessage());
                } finally {
                    $lock->release();
                }
            }
        }

        if (! Settings::get('demo')) {
            $this->syncDue(false); // long syncs last (customers, stock levels, reconcile, PostEx)
        }

        // queued jobs (when a queue is used), without needing a permanent worker process
        if (config('queue.default') !== 'sync') {
            try {
                Artisan::call('queue:work', ['--stop-when-empty' => true, '--max-time' => 50, '--tries' => 3, '--quiet' => true]);
            } catch (\Throwable $e) {
                report($e);
            }
        }
        Settings::set('tick_at', gmdate('Y-m-d\TH:i:s\Z'));
        return self::SUCCESS;
    }

    private function syncDue(bool $quick): void
    {
        $fast = ! SyncRunner::webhooksHealthy();
        foreach (self::CADENCE as $kind => [$noHooks, $withHooks]) {
            if (in_array($kind, self::QUICK, true) === $quick && SyncRunner::due($kind, $fast ? $noHooks : $withHooks)) {
                $this->runSync($kind, null);
            }
        }
    }

    private function runSync(string $kind, ?int $uid): void
    {
        SyncRunner::markRun($kind);
        SyncRunner::run($kind, $uid);
    }
}
