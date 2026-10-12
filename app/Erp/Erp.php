<?php

namespace App\Erp;

/**
 * Module registry. Order matters: it is the order routes are registered in
 * (first match wins) and the order the original server loaded its modules.
 */
class Erp
{
    public const MODULES = [
        Modules\CoreModule::class,
        Modules\AccessModule::class,
        Modules\AccountsModule::class,
        Modules\ExpensesModule::class,
        Modules\MarketingModule::class,
        Modules\HrModule::class,
        Modules\OpsModule::class,
        Modules\TicketsModule::class,
        Modules\PurchasingModule::class,
        Modules\StocklineModule::class,
        Modules\WmsModule::class,
        Modules\CouriersModule::class,
        Modules\InboxModule::class,
        Modules\AbandonedModule::class,
        Modules\HomeModule::class,
        Modules\ShopifyModule::class,
        Modules\TailModule::class,
    ];

    /** module instances per application container */
    private static ?\WeakMap $loaded = null;

    /** @return Module[] */
    public static function modules(): array
    {
        self::$loaded ??= new \WeakMap;
        if (isset(self::$loaded[app()])) {
            return self::$loaded[app()];
        }
        // ERP_MODULES=Core,Accounts limits the loaded modules (development / tests)
        $only = array_filter(array_map('trim', explode(',', (string) getenv('ERP_MODULES'))));
        $out = [];
        foreach (self::MODULES as $c) {
            $short = preg_replace('/Module$/', '', class_basename($c));
            if ($only && ! in_array($short, $only, true) && ! in_array($short, ['Core', 'Access', 'Shopify', 'Tail'], true)) {
                continue;
            }
            try {
                if (class_exists($c)) {
                    app()->singletonIf($c);
                    $out[] = app($c);
                }
            } catch (\Throwable $e) {
                report($e); // one broken module must not take the whole API down
            }
        }
        self::$loaded[app()] = $out;
        return $out;
    }

    /** Another module's service object, e.g. Erp::svc('accounts')->post([...]). Null when that module is missing. */
    public static function svc(string $name): ?Module
    {
        foreach (self::modules() as $m) {
            if ($m->name === $name) {
                return $m;
            }
        }
        return null;
    }

    /** Labels for the activity log ("what did this person do today"). */
    public static function activityLabels(): array
    {
        $l = ['pack' => 'Packed order', 'return.received' => 'Received return', 'listing.save' => 'Listed pair', 'listing.export' => 'Exported listings', 'lot.save' => 'Saved lot', 'pricing.apply' => 'Changed prices', 'note' => 'Order note', 'customer.flag' => 'Flagged customer', 'cod.settled' => 'Marked COD settled', 'login' => 'Logged in'];
        foreach (self::modules() as $m) {
            $l = array_merge($l, $m->activity());
        }
        return $l;
    }

    /** Alerts from every module, worst first. */
    public static function alerts(array $u): array
    {
        $out = [];
        foreach (self::modules() as $m) {
            try {
                foreach ($m->alerts($u) as $a) {
                    $out[] = $a + ['mod' => $m->name];
                }
            } catch (\Throwable $e) {
                report($e);
            }
        }
        $rank = ['bad' => 0, 'warn' => 1, 'info' => 2];
        usort($out, fn ($a, $b) => ($rank[$a['level'] ?? 'info'] ?? 2) <=> ($rank[$b['level'] ?? 'info'] ?? 2));
        return $out;
    }
}
