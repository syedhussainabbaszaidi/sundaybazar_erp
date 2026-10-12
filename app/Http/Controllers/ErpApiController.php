<?php

namespace App\Http\Controllers;

use App\Erp\Access;
use App\Erp\HttpError;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Every /api/* route lands here. The route carries [moduleClass, method, perm];
 * this checks login + permission, parses the body and calls the module method.
 */
class ErpApiController extends Controller
{
    public function handle(Request $req): Response
    {
        try {
            $route = $req->route();
            [$class, $method, $perm] = $route->defaults['_erp'];
            $path = '/'.ltrim($req->path(), '/');
            $isHook = str_starts_with($path, '/api/hooks/');

            // Cross-site write protection: the app always sends this header; browsers cannot add it cross-origin
            // without a CORS preflight, which this server never approves. Webhooks are verified by signature instead.
            if ($req->method() !== 'GET' && ! $isHook && $req->header('x-sb') !== '1') {
                throw new HttpError(403, 'Bad request origin');
            }

            Access::flush(); // roles may have changed since the last request (long-running workers, tests)
            app()->terminating(fn () => \App\Erp\AutoTick::kick()); // keep the background sync alive (after the response)
            $u = self::currentUser();
            if ($perm !== null) {
                if (! $u) {
                    throw new HttpError(401, 'Please log in');
                }
                if (! in_array($perm, $u['perms'], true)) {
                    throw new HttpError(403, 'Your account does not have access to this');
                }
            }

            $body = [];
            if ($req->method() !== 'GET') {
                $raw = $req->getContent();
                if (strlen($raw) > 6_000_000) {
                    throw new HttpError(413, 'Too large');
                }
                if ($raw !== '') {
                    $j = json_decode($raw, true);
                    if (json_last_error() === JSON_ERROR_NONE) {
                        $body = is_array($j) ? $j : [];
                    } elseif ($isHook) {
                        $body = str_contains((string) $req->header('content-type'), 'application/x-www-form-urlencoded') ? $req->request->all() : ['_raw' => $raw];
                    } else {
                        throw new HttpError(400, 'Bad JSON');
                    }
                }
            }

            $params = array_map(fn ($v) => is_string($v) ? str_replace(\App\Http\Middleware\KeepEncodedSlashes::PLACEHOLDER, '/', $v) : $v,
                array_filter($route->parameters(), fn ($k) => $k !== '_erp', ARRAY_FILTER_USE_KEY));
            $qs = $req->query->all();
            $out = app($class)->{$method}($u, $body, $params, $qs, $req);

            if ($out instanceof Response) {
                return $out;
            }
            return self::json($out ?? ['ok' => true]);
        } catch (HttpError $e) {
            return self::json(['error' => $e->getMessage()] + $e->extra, $e->status);
        } catch (QueryException $e) {
            report($e);
            return self::json(['error' => config('app.debug') ? $e->getMessage() : 'Database error — the problem was logged.'], 500);
        } catch (\RuntimeException $e) {
            // integration / business failures carry a message written for staff ("PostEx: ...", "Shopify ...")
            \Illuminate\Support\Facades\Log::warning('API '.$req->method().' '.$req->path().': '.$e->getMessage());
            return self::json(['error' => $e->getMessage() ?: 'Error'], 500);
        } catch (\Throwable $e) {
            report($e);
            return self::json(['error' => config('app.debug') ? $e->getMessage() : 'Server error — the problem was logged.'], 500);
        }
    }

    public static function json($data, int $status = 200): JsonResponse
    {
        return response()->json($data, $status, ['Cache-Control' => 'no-store'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    /** The logged-in, active user as the array modules expect, or null. */
    public static function currentUser(): ?array
    {
        $user = Auth::user();
        if (! $user) {
            return null;
        }
        if (! $user->active) {
            Auth::logout();
            return null;
        }
        $row = $user->only(['id', 'name', 'username', 'email', 'role']);
        return ['id' => (int) $row['id'], 'name' => $row['name'], 'username' => $row['username'], 'email' => $row['email'], 'role' => $row['role'], 'perms' => Access::userPerms($row)];
    }
}
