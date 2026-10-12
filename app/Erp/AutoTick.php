<?php

namespace App\Erp;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Keeps the background work (Shopify sync, webhook retries, module jobs) running even when no cron job /
 * `schedule:work` was started: when the ERP is used and the minute clock (`erp:tick`) has not run for a while,
 * it is started in the background. With a real scheduler running this never triggers.
 *
 * Order of preference: a detached `php artisan erp:tick` process; when the host forbids starting processes,
 * the tick runs inside this PHP process after the response has been sent (PHP-FPM / LiteSpeed).
 */
class AutoTick
{
    public static function lastTick(): ?int
    {
        $t = Settings::get('tick_at');
        return $t ? (int) strtotime((string) $t) : null;
    }

    /** Start a tick if the last one is older than $staleSeconds (0 = now). Never throws. */
    public static function kick(int $staleSeconds = 70): void
    {
        try {
            if (! config('erp.autotick', true) || app()->runningUnitTests()) {
                return;
            }
            $last = self::lastTick();
            if ($staleSeconds > 0 && $last && $last > time() - $staleSeconds) {
                return;
            }
            if (! Cache::add('erp-autotick-spawn', 1, $staleSeconds > 0 ? 60 : 5)) {
                return; // another request is already starting one
            }
            if (! self::spawn()) {
                app()->terminating(function () {
                    @set_time_limit(600);
                    @ignore_user_abort(true);
                    Artisan::call('erp:tick');
                });
            }
        } catch (\Throwable $e) {
            Log::warning('AutoTick: '.$e->getMessage());
        }
    }

    public static function phpBinary(): string
    {
        if ($p = config('erp.php_binary')) {
            return $p;
        }
        $b = PHP_BINARY;
        $name = strtolower(basename($b));
        if (preg_match('/^php(\d+(\.\d+)?)?(\.exe)?$/', $name)) {
            return $b; // CLI / built-in server
        }
        // PHP-FPM / CGI: use the CLI binary next to it
        foreach ([PHP_BINDIR.DIRECTORY_SEPARATOR.'php', PHP_BINDIR.DIRECTORY_SEPARATOR.'php.exe', dirname($b).DIRECTORY_SEPARATOR.'php'] as $c) {
            if (@is_file($c)) {
                return $c;
            }
        }
        return 'php';
    }

    /** Start `artisan erp:tick` detached from this request. False when the host does not allow it. */
    public static function spawn(): bool
    {
        $php = self::phpBinary();
        $artisan = base_path('artisan');
        if (PHP_OS_FAMILY === 'Windows') {
            if (! function_exists('popen') || in_array('popen', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true)) {
                return false;
            }
            $h = @popen('start "" /B "'.$php.'" "'.$artisan.'" erp:tick > NUL 2>&1', 'r');
            if (! $h) {
                return false;
            }
            pclose($h);
            return true;
        }
        if (! function_exists('exec') || in_array('exec', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true)) {
            return false;
        }
        @exec(escapeshellarg($php).' '.escapeshellarg($artisan).' erp:tick > /dev/null 2>&1 &', $out, $code);
        return $code === 0;
    }
}
