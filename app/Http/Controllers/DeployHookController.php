<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;

/**
 * POST /deploy-hook — called by the GitHub "Deploy to cPanel" workflow right after the FTP upload, because an
 * FTP-only host cannot run artisan. Runs what deploy/deploy.sh would: migrate, erp:install, fresh caches.
 * Off (404) unless ERP_DEPLOY_TOKEN is set; the caller sends it as the X-Deploy-Token header.
 */
class DeployHookController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $token = (string) config('erp.deploy_token');
        if ($token === '') {
            abort(404);
        }
        if (! hash_equals($token, (string) $request->header('X-Deploy-Token'))) {
            return response()->json(['error' => 'Forbidden'], 403);
        }

        @set_time_limit(300);
        $out = [];
        foreach ([['optimize:clear', []], ['migrate', ['--force' => true]], ['erp:install', []]] as [$cmd, $args]) {
            $code = Artisan::call($cmd, $args);
            $out[] = "$ php artisan $cmd (exit $code)\n".trim(Artisan::output());
            if ($code !== 0) {
                return response()->json(['ok' => false, 'output' => implode("\n\n", $out)], 500);
            }
        }

        return response()->json(['ok' => true, 'output' => implode("\n\n", $out)]);
    }
}
