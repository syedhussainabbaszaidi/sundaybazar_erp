<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Shopify ids contain slashes (gid://shopify/Order/123). The browser app sends them URL-encoded in the
 * path (/api/orders/gid%3A%2F%2Fshopify%2FOrder%2F123/stage), and the original router matched the raw,
 * still-encoded path, so an encoded slash stayed inside one path segment. Laravel decodes the path before
 * matching, which would split the id. Before routing, an encoded slash is swapped for a placeholder
 * (U+2215) that ErpApiController turns back into "/" in route parameters.
 */
class KeepEncodedSlashes
{
    public const PLACEHOLDER = "\u{2215}";

    public function handle(Request $request, Closure $next): Response
    {
        $uri = (string) $request->server->get('REQUEST_URI');
        $q = strpos($uri, '?');
        $path = $q === false ? $uri : substr($uri, 0, $q);
        if (stripos($path, '%2F') !== false) {
            $request->server->set('REQUEST_URI', str_ireplace('%2F', '%E2%88%95', $path).($q === false ? '' : substr($uri, $q)));
            // forget the cached path so routing sees the new one
            (function () {
                $this->requestUri = null;
                $this->pathInfo = null;
                $this->baseUrl = null;
                $this->basePath = null;
            })->call($request);
        }
        return $next($request);
    }
}
