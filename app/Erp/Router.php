<?php

namespace App\Erp;

use App\Http\Controllers\ErpApiController;
use Illuminate\Support\Facades\Route;

/**
 * Registers module routes as Laravel routes, keeping the original
 * route('GET', '/api/orders/:id', 'orders', handler) style.
 * perm = null means public (no login needed, e.g. webhooks).
 */
class Router
{
    /** routes already registered, per route collection (first registration wins) */
    private static ?\WeakMap $seen = null;

    public function __construct(private Module $module) {}

    public function route(string $method, string $pattern, ?string $perm, string $handler): void
    {
        $uri = preg_replace('/:(\w+)/', '{$1}', ltrim($pattern, '/'));
        self::$seen ??= new \WeakMap;
        $coll = Route::getRoutes();
        $seen = self::$seen[$coll] ?? [];
        $key = $method.' '.$uri;
        if (isset($seen[$key])) {
            return; // first registration wins, as in the original router
        }
        $seen[$key] = true;
        self::$seen[$coll] = $seen;
        Route::match([$method], $uri, [ErpApiController::class, 'handle'])
            ->middleware(str_starts_with($uri, 'api/hooks/') ? 'api' : 'web')
            ->defaults('_erp', [get_class($this->module), $handler, $perm]);
    }

    public function get(string $p, ?string $perm, string $h): void
    {
        $this->route('GET', $p, $perm, $h);
    }

    public function post(string $p, ?string $perm, string $h): void
    {
        $this->route('POST', $p, $perm, $h);
    }

    public function delete(string $p, ?string $perm, string $h): void
    {
        $this->route('DELETE', $p, $perm, $h);
    }

    public function put(string $p, ?string $perm, string $h): void
    {
        $this->route('PUT', $p, $perm, $h);
    }
}
