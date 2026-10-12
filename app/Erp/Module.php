<?php

namespace App\Erp;

use App\Erp\Core\PostEx;
use App\Services\Shopify\ShopifyClient;

/**
 * Base class of an ERP business module (PHP port of a modules/*.js file).
 *
 * Route handlers are public methods with the signature
 *     function (?array $u, array $b, array $p, array $qs, \Illuminate\Http\Request $req)
 *   $u  = logged-in user: ['id','name','username','role','perms'=>[...]] (null on public routes)
 *   $b  = JSON body (array), $p = route params (already URL-decoded), $qs = query string
 * They return an array (sent as JSON) or a Symfony Response (files, CSV, PDF).
 * Throw HttpError (or call $this->need()) for 4xx answers.
 */
abstract class Module
{
    public string $name = '';

    /** Extra permissions this module adds: [[key, label], ...] */
    public function perms(): array
    {
        return [];
    }

    /** Seed default rows (idempotent). Runs from `php artisan erp:install` / the database seeder. */
    public function install(): void {}

    public function routes(Router $r): void {}

    /** Background jobs: [['name'=>..., 'every'=>minutes|callable, 'offset'=>int, 'run'=>callable], ...] */
    public function jobs(): array
    {
        return [];
    }

    /** Sidebar badges for this user, e.g. ['tickets' => 3] */
    public function counts(array $u): array
    {
        return [];
    }

    /** Alerts for the home page: [['level'=>'bad|warn|info','text'=>..., 'href'=>...], ...] */
    public function alerts(array $u): array
    {
        return [];
    }

    /** Activity log labels: ['action' => 'Human label'] */
    public function activity(): array
    {
        return [];
    }

    /* ------------------------------------------------------------ helpers */

    protected function setting(string $key, $default = null)
    {
        return Settings::get($key, $default);
    }

    protected function setSetting(string $key, $value): void
    {
        Settings::set($key, $value);
    }

    protected function log($userId, string $action, ?string $entity = null, $detail = null): void
    {
        Activity::log($userId, $action, $entity, $detail);
    }

    protected function syncLog(string $kind, bool $ok, $message): void
    {
        Activity::sync($kind, $ok, $message);
    }

    /** need(cond, msg, code=400): stop with an error answer when cond is falsy */
    protected function need($cond, string $msg, int $code = 400, array $extra = []): void
    {
        if (! $cond) {
            throw new HttpError($code, $msg, $extra);
        }
    }

    protected function can(?array $u, string $perm): bool
    {
        return $u && in_array($perm, $u['perms'] ?? [], true);
    }

    /** ['limit','offset','page'] from ?page= */
    protected function page(array $qs, int $size = 50): array
    {
        $p = max(1, (int) ($qs['page'] ?? 1));
        return ['limit' => $size, 'offset' => ($p - 1) * $size, 'page' => $p];
    }

    /** UTC date YYYY-MM-DD */
    protected function today(): string
    {
        return gmdate('Y-m-d');
    }

    /** Pakistan local time 'YYYY-MM-DD HH:MM:SS' */
    protected function pkNow(): string
    {
        return gmdate('Y-m-d H:i:s', time() + 5 * 3600);
    }

    protected function pkToday(): string
    {
        return substr($this->pkNow(), 0, 10);
    }

    /** ISO-8601 UTC timestamp like JS new Date().toISOString() */
    protected function isoNow(): string
    {
        return gmdate('Y-m-d\TH:i:s.v\Z');
    }

    protected function maskPhone(?array $u, ?string $p): string
    {
        if ($this->can($u, 'customers') || $this->can($u, 'cs') || $this->can($u, 'tracking')) {
            return (string) $p;
        }
        return $p ? mb_substr($p, 0, 4).'•••'.mb_substr($p, -2) : '';
    }

    protected function svc(string $name): ?Module
    {
        return Erp::svc($name);
    }

    protected function shopify(): ShopifyClient
    {
        return app(ShopifyClient::class);
    }

    protected function postex(): PostEx
    {
        return app(PostEx::class);
    }

    /** JSON decode with a default (like the JS J(x, def) helpers) */
    protected function J($v, $def = null)
    {
        if ($v === null || $v === '') {
            return $def;
        }
        if (is_array($v)) {
            return $v;
        }
        $d = json_decode((string) $v, true);
        return json_last_error() === JSON_ERROR_NONE ? $d : $def;
    }
}
