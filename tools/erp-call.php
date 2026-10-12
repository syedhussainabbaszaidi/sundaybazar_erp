<?php

/**
 * Development helper: call ERP API routes in-process as a logged-in user.
 *
 *   php tools/erp-call.php GET  /api/orders
 *   php tools/erp-call.php POST /api/orders/123/note '{"note":"hi"}'
 *   php tools/erp-call.php --user=2 GET /api/home
 *   php tools/erp-call.php --batch=calls.txt      (one "METHOD PATH [json]" per line, runs in one process)
 *
 * Creates an admin user "dev" the first time when the users table is empty.
 * Prints "<status> <json>" per call.
 */

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$args = array_slice($argv, 1);
$userId = null;
$batch = null;
$args = array_values(array_filter($args, function ($a) use (&$userId, &$batch) {
    if (str_starts_with($a, '--user=')) { $userId = (int) substr($a, 7); return false; }
    if (str_starts_with($a, '--batch=')) { $batch = substr($a, 8); return false; }
    return true;
}));

$dbName = (string) config('database.connections.'.config('database.default').'.database');
if (! preg_match('/^(sbtest_|.*_test$)/', $dbName)) {
    fwrite(STDERR, "erp-call is a development tool: run it against a test database (DB_DATABASE=sbtest_...), not {$dbName}\n");
    exit(1);
}
if (! App\Erp\Db::get('SELECT id FROM users LIMIT 1')) {
    App\Erp\Db::run("INSERT INTO users(name,username,password,role,perms,active) VALUES('Dev Admin','dev',?,'admin','[]',1)", Illuminate\Support\Facades\Hash::make('dev12345'));
}
$userId = $userId ?: (int) App\Erp\Db::val("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");

$calls = [];
if ($batch) {
    foreach (file($batch, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (str_starts_with(trim($line), '#')) continue;
        $p = preg_split('/\s+/', trim($line), 3);
        $calls[] = [$p[0], $p[1], $p[2] ?? null];
    }
} else {
    $calls[] = [$args[0] ?? 'GET', $args[1] ?? '/api/state', $args[2] ?? null];
}

foreach ($calls as [$method, $path, $body]) {
    $req = Request::create($path, strtoupper($method), [], [], [], ['HTTP_X_SB' => '1', 'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'], $body);
    $app->instance('request', $req);
    Auth::guard('web')->loginUsingId($userId);
    $res = $kernel->handle($req);
    $out = $res->getContent();
    if (str_contains((string) $res->headers->get('content-type'), 'json')) {
        $j = json_decode($out, true);
        $out = json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    echo strtoupper($method).' '.$path.' -> '.$res->getStatusCode().' '.mb_substr((string) $out, 0, (int) (getenv('ERP_CALL_MAX') ?: 1500))."\n";
    $kernel->terminate($req, $res);
}
