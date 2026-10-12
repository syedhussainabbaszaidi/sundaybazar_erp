<?php

use Illuminate\Support\Facades\Schedule;

// The ERP's minute clock: module jobs + periodic Shopify/PostEx syncs (App\Console\Commands\ErpTick).
// Production: one cron entry `* * * * * php /path/to/artisan schedule:run`; development: `php artisan schedule:work`.
// No withoutOverlapping(): a long import (e.g. the first customer import) must not stop the next minute's tick;
// every sync kind and module job has its own lock, so nothing runs twice at the same time.
Schedule::command('erp:tick')->everyMinute();

// keep the failed-jobs table tidy (30 days)
Schedule::command('queue:prune-failed --hours=720')->daily();
