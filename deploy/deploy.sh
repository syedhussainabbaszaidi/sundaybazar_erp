#!/usr/bin/env bash
# Deploy the latest code on the LIVE server (run from the project folder, e.g. ~/sundaybazar-erp):
#   bash deploy/deploy.sh            (git pull + update)
#   bash deploy/deploy.sh --no-pull  (files were uploaded another way, e.g. a release zip)
# Safe to run again. Stops at the first error (the site stays in maintenance mode until fixed: php artisan up).
set -euo pipefail
cd "$(dirname "$0")/.."
PHP="${PHP:-php}"

echo "== SundayBazar ERP deploy $(date -u '+%F %T') UTC"
"$PHP" -v | head -1
"$PHP" artisan down --retry=30 || true

if [ "${1:-}" != "--no-pull" ]; then
  git pull --ff-only
fi
if command -v composer >/dev/null 2>&1; then
  composer install --no-dev --optimize-autoloader --no-interaction
else
  echo "composer not found: using the vendor/ folder that was uploaded"
fi

"$PHP" artisan migrate --force          # only adds what is new; never drops data
"$PHP" artisan erp:install              # default rows + new permissions (idempotent)
"$PHP" artisan config:cache
"$PHP" artisan route:cache
"$PHP" artisan view:cache
mkdir -p storage/app/private/backups storage/logs bootstrap/cache
chmod -R ug+rwX storage bootstrap/cache || true

"$PHP" artisan up
"$PHP" artisan shopify:check || echo "WARNING: Shopify connection check failed - see above"
echo "== done"
