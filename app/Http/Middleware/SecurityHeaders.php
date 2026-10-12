<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Security headers of the original ERP server. */
class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        $res = $next($request);
        $res->headers->set('X-Frame-Options', 'DENY');
        $res->headers->set('X-Content-Type-Options', 'nosniff');
        $res->headers->set('Referrer-Policy', 'same-origin');
        if (! $res->headers->has('Content-Security-Policy')) {
            $res->headers->set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        }
        if ($request->isSecure()) {
            $res->headers->set('Strict-Transport-Security', 'max-age=15552000');
        }
        return $res;
    }
}
