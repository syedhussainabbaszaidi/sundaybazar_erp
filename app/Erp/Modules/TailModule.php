<?php

namespace App\Erp\Modules;

use App\Erp\Core\Backup;
use App\Erp\Erp;
use App\Erp\Module;
use App\Erp\Router;

/** Routes the original server registered after all modules: sidebar counts, alerts, backups. */
class TailModule extends Module
{
    public string $name = 'tail';

    public function routes(Router $r): void
    {
        $r->get('/api/counts', 'dashboard', 'countsRoute');
        $r->get('/api/alerts', 'dashboard', 'alertsRoute');
        $r->post('/api/backup', 'settings', 'backupNow');
        $r->get('/api/backup', 'users', 'backupDownload');
        $r->get('/api/snapshot', null, 'snapshot');
    }

    /**
     * Database snapshot for `php artisan erp:pull-production` on a developer's PC (production -> local copy).
     * Off unless ERP_SNAPSHOT_TOKEN (32+ characters) is set; the caller sends it as "Authorization: Bearer …".
     * Over HTTPS only. Never the other way round: nothing can be uploaded through this.
     */
    public function snapshot(?array $u, array $b, array $p, array $qs, \Illuminate\Http\Request $req)
    {
        $token = (string) config('erp.snapshot_token');
        $this->need(strlen($token) >= 32, 'Not found', 404);
        $this->need($req->isSecure() || app()->environment('local', 'testing'), 'HTTPS only', 403);
        $key = 'snapshot|'.$req->ip();
        $this->need(! \Illuminate\Support\Facades\RateLimiter::tooManyAttempts($key, 5), 'Too many attempts', 429);
        $sent = (string) $req->bearerToken();
        if (! hash_equals($token, $sent)) {
            \Illuminate\Support\Facades\RateLimiter::hit($key, 3600);
            $this->log(null, 'snapshot.denied', 'settings', $req->ip());
            throw new \App\Erp\HttpError(401, 'Bad token');
        }
        $f = Backup::run();
        $this->log(null, 'snapshot.download', 'settings', ['ip' => $req->ip(), 'file' => basename($f)]);
        return response()->download($f, basename($f), ['Content-Type' => 'application/gzip']);
    }

    public function countsRoute(?array $u): object
    {
        $c = [];
        foreach (Erp::modules() as $m) {
            if ($m === $this) {
                continue;
            }
            try {
                $c = array_merge($c, $m->counts($u));
            } catch (\Throwable $e) {
                report($e);
            }
        }
        return (object) $c;
    }

    public function alertsRoute(?array $u): array
    {
        return Erp::alerts($u);
    }

    public function backupNow(?array $u): array
    {
        $f = Backup::run();
        $this->log($u['id'], 'backup', 'settings', basename($f));
        return ['ok' => true, 'file' => basename($f), 'at' => $this->setting('backup_last')];
    }

    public function backupDownload(?array $u)
    {
        $f = Backup::run();
        $this->log($u['id'], 'backup.download', 'settings', basename($f));
        return response()->download($f, basename($f), ['Content-Type' => 'application/gzip']);
    }

    public function jobs(): array
    {
        // daily backup after 02:00 Pakistan time
        return [['name' => 'backup', 'every' => 60, 'offset' => 7, 'run' => function () {
            if (substr((string) $this->setting('backup_last', ''), 0, 10) !== $this->pkToday() && substr($this->pkNow(), 11, 2) >= '02') {
                Backup::run();
            }
        }]];
    }
}
