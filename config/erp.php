<?php

return [
    // Browser setup of the first owner account is OFF unless this key is set (then the setup call needs it).
    // Recommended instead: `php artisan erp:admin` or ERP_ADMIN_EMAIL / ERP_ADMIN_PASSWORD + `php artisan erp:install`.
    'setup_key' => env('ERP_SETUP_KEY', ''),

    // One-time bootstrap of the first super administrator by `php artisan erp:install`
    // (only when no active super administrator exists). Remove the password from .env afterwards.
    'admin_email' => env('ERP_ADMIN_EMAIL', ''),
    'admin_password' => env('ERP_ADMIN_PASSWORD', ''),
    'admin_name' => env('ERP_ADMIN_NAME', 'Owner'),

    // Public registration at /register: approval (account waits until an administrator activates it),
    // open (can log in straight away) or closed. Never creates administrators.
    'registration' => in_array(env('ERP_REGISTRATION', 'approval'), ['approval', 'open', 'closed'], true) ? env('ERP_REGISTRATION', 'approval') : 'approval',
    'registration_role' => env('ERP_REGISTRATION_ROLE', 'staff'),

    // Start the background minute clock (php artisan erp:tick) from the web app when no scheduler has run it
    // for over a minute. Keeps Shopify sync running even without a cron job; harmless when cron runs it.
    'autotick' => (bool) env('ERP_AUTOTICK', true),
    // PHP command-line binary used for that (auto-detected when empty), e.g. /usr/local/bin/php
    'php_binary' => env('ERP_PHP_BINARY', ''),

    // Live -> local data copy (php artisan erp:pull-production). On the LIVE server set only ERP_SNAPSHOT_TOKEN
    // (32+ random characters); on the developer PC set the same token and ERP_PRODUCTION_URL. Empty = off.
    'snapshot_token' => env('ERP_SNAPSHOT_TOKEN', ''),
    'production_url' => env('ERP_PRODUCTION_URL', ''),

    // daily database backups (default storage/app/private/backups)
    'backup_dir' => env('ERP_BACKUP_DIR', ''),
    'backup_keep_days' => (int) env('ERP_BACKUP_KEEP_DAYS', 30),
];
