<?php

namespace App\Erp;

use Illuminate\Support\Facades\Log;

/**
 * Fire-and-forget work (the JS code started promises without awaiting them).
 * Runs after the HTTP response has been sent (or at the end of the command / job),
 * so the user does not wait for slow external calls. Failures are logged.
 */
class Defer
{
    public static function run(callable $fn, string $label = 'deferred'): void
    {
        $wrapped = function () use ($fn, $label) {
            try {
                $fn();
            } catch (\Throwable $e) {
                Log::warning("Deferred task {$label} failed: ".$e->getMessage());
                try {
                    Activity::sync($label, false, $e->getMessage());
                } catch (\Throwable) {
                }
            }
        };
        if (app()->runningUnitTests() || app()->runningInConsole() && ! app()->bound('erp.http')) {
            $wrapped(); // tests, artisan commands, queue workers: just run it
            return;
        }
        app()->terminating($wrapped);
    }
}
