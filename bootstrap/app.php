<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {
            // ERP JSON API; App\Erp\Router puts each route in the "web" group (session login)
            // or, for /api/hooks/*, in the stateless "api" group.
            Route::group([], base_path('routes/erp.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // /api/* is protected by the X-SB header check in ErpApiController (the browser app always sends it,
        // other sites cannot without a CORS preflight) plus SameSite=strict session cookies.
        // Webhooks under /api/hooks/* are verified by HMAC signature instead.
        // /deploy-hook is checked against ERP_DEPLOY_TOKEN instead.
        $middleware->validateCsrfTokens(except: ['api/*', 'deploy-hook']);
        $middleware->prepend(\App\Http\Middleware\KeepEncodedSlashes::class);
        $middleware->append(\App\Http\Middleware\SecurityHeaders::class);
        $middleware->trustProxies(at: '*');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // JSON errors for the API, never an HTML stack trace
        $exceptions->shouldRenderJsonWhen(fn (Request $r) => $r->is('api/*'));
        $exceptions->render(function (\Symfony\Component\HttpKernel\Exception\NotFoundHttpException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'Not found'], 404);
            }
        });
        $exceptions->render(function (\Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'Not found'], 404);
            }
        });
    })->create();
