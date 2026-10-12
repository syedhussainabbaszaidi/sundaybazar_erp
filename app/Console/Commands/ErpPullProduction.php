<?php

namespace App\Console\Commands;

use App\Erp\Core\Backup;
use App\Erp\Db;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;

/**
 * Copy the live (production) database into this LOCAL installation, so a developer PC shows the latest live
 * records. One direction only (production -> local); refuses to run on production. The local database is
 * backed up first and then replaced.
 */
class ErpPullProduction extends Command
{
    protected $signature = 'erp:pull-production {--yes : do not ask for confirmation} {--file= : import this downloaded .sql.gz instead of downloading}';

    protected $description = 'Replace the local database with a copy of the live server (production -> local only)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('This is the production server (APP_ENV=production): pulling into it is not allowed.');
            return self::FAILURE;
        }
        $url = rtrim((string) config('erp.production_url'), '/');
        $token = (string) config('erp.snapshot_token');
        $file = $this->option('file');
        if (! $file) {
            if (! preg_match('#^https://#', $url) || strlen($token) < 32) {
                $this->error('Set ERP_PRODUCTION_URL (https://…) and ERP_SNAPSHOT_TOKEN (the same token as on the live server) in this .env first.');
                return self::FAILURE;
            }
        }
        $db = (string) config('database.connections.'.config('database.default').'.database');
        if (! $this->option('yes') && ! $this->confirm("Replace ALL data in the local database \"{$db}\" with the live data? (a backup of the local data is made first)")) {
            return self::FAILURE;
        }
        $local = Backup::run('before-pull-'.gmdate('Y-m-d-His')); // own name: never overwrites the daily backup or the file being imported
        $this->line('Local backup: '.$local);
        if (! $file) {
            $file = storage_path('app/private/backups/production-'.gmdate('Y-m-d-His').'.sql.gz');
            $this->line('Downloading from '.$url.' …');
            $r = Http::withToken($token)->timeout(600)->sink($file)->get($url.'/api/snapshot');
            if (! $r->successful()) {
                @unlink($file);
                $this->error('Download failed: HTTP '.$r->status().' '.mb_substr((string) $r->body(), 0, 200));
                return self::FAILURE;
            }
        }
        $this->line('Importing '.$file.' …');
        $n = $this->import($file);
        \App\Erp\Settings::forget('tick_at');
        $this->info("Done: {$n} statements imported. Local logins are now those of the live server.");
        $this->warn('Shopify sync keeps running locally (read from Shopify). Changes you make here that go to Shopify (prices, cancellations, refunds…) affect the real store.');
        return self::SUCCESS;
    }

    /** Run a gzipped SQL dump statement by statement (statements end with ";" at the end of a line). */
    private function import(string $file): int
    {
        $gz = gzopen($file, 'rb');
        if (! $gz) {
            throw new \RuntimeException('Cannot open '.$file);
        }
        $pdo = Db::pdo();
        $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
        $buf = '';
        $n = 0;
        while (($line = gzgets($gz)) !== false) {
            if ($buf === '' && (str_starts_with($line, '--') || trim($line) === '')) {
                continue;
            }
            $buf .= $line;
            if (str_ends_with(rtrim($line), ';')) {
                $pdo->exec($buf);
                $buf = '';
                $n++;
            }
        }
        gzclose($gz);
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
        return $n;
    }
}
