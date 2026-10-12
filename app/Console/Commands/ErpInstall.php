<?php

namespace App\Console\Commands;

use App\Erp\Erp;
use Illuminate\Console\Command;

/** Seeds the default rows every module needs (idempotent; safe to run after every deploy). */
class ErpInstall extends Command
{
    protected $signature = 'erp:install';

    protected $description = 'Create default ERP data (chart of accounts, expense categories, ...) for every module';

    public function handle(): int
    {
        foreach (Erp::modules() as $m) {
            $m->install();
            $this->line('  '.$m->name.' ✓');
        }
        if ($msg = app(\App\Erp\Modules\AccessModule::class)->bootstrapAdminFromEnv()) {
            $this->warn($msg);
        }
        if (\App\Erp\Access::activeSupers() === 0) {
            $this->warn('No administrator yet: run  php artisan erp:admin <username> --email=<you@example.com>');
        }
        $this->info('ERP defaults installed.');
        return self::SUCCESS;
    }
}
