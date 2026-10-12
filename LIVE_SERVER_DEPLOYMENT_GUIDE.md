# SundayBazar ERP — Live Server Deployment Guide

This guide takes the ERP from this PC to a live server, step by step. It is written for the person who will
create the database in **phpMyAdmin** and **upload the files**. Values you must supply are written like
`<THIS>`. Nothing in this guide is a password: real passwords and secrets only ever go into the server's `.env` file.

---

## 1. What this project is

| Part | Technology (verified in the code) |
|---|---|
| Backend | **PHP 8.2+** with **Laravel 12** (`composer.json`, `artisan`) |
| Database | **MySQL 8** or **MariaDB 10.4+** (developed on MariaDB 10.4.32 / XAMPP) |
| Frontend | Plain JavaScript single-page app in `public/erp/` — **no Node.js, no build step** |
| Entry point | `public/index.php` (the only folder that must be reachable from the web is `public/`) |
| Shopify | Admin GraphQL API **2025-10**, Dev Dashboard app with the client-credentials grant, webhooks |
| Background work | `php artisan erp:tick` every minute (cron); started automatically by the web app if cron is missing |

Pages: `/login`, `/register`, `/admin` (owners & staff managers), `/dashboard` (everyone else). Inside the app the
address after `#` selects the screen (e.g. `/admin#/settings`); refreshing such a page works because the server
only sees `/admin`.

The original single-file ERP is kept in `legacy/` for reference only (it is not served).

---

## 2. Local development (this PC)

Requirements: PHP 8.2+ (XAMPP's `C:\xampp2\php`), Composer, MariaDB/MySQL (XAMPP), a browser.

```bat
cd C:\xampp2\htdocs\sundaybazaarErp
composer install
php artisan migrate
php artisan erp:install
php artisan erp:admin <your-username> --email=<you@example.com>
```

Start the ERP: double-click **`start-erp.bat`** (opens the web server and the background sync window, then
`http://127.0.0.1:8000/login`). Or by hand:

```bat
php artisan serve --host=127.0.0.1 --port=8000
php artisan schedule:work
```

Even without the second window, the web app starts the background sync by itself while someone uses the ERP.
Tests: `php artisan test` (uses the separate database `sundaybazar_erp_test`).

---

## 3. What the live server needs

| Requirement | Why |
|---|---|
| PHP **8.2 or newer** (8.3 tested) | Laravel 12 |
| PHP extensions: `pdo_mysql, mbstring, openssl, curl, intl, zip, fileinfo, bcmath, tokenizer, xml, ctype, json, zlib` | Laravel, Shopify API calls, backups (zlib) |
| MySQL 8 / MariaDB 10.4+ database, user with ALL PRIVILEGES on it | data |
| **HTTPS** with a valid certificate (Let's Encrypt / AutoSSL is fine) | Shopify only delivers webhooks to https; secure login cookies |
| **Cron job** every minute (cPanel → Cron Jobs) | background sync, webhook retries, accounts posting, backups |
| ~500 MB disk + room for backups | code (≈60 MB with `vendor/`), database, nightly backups |
| `max_execution_time` ≥ 60 s for the web, no limit for CLI | long imports run in the CLI (cron), not in web requests |
| Optional: SSH + Git + Composer | easier updates (`deploy/deploy.sh`); without them upload a release zip |

Works on: cPanel/DirectAdmin shared hosting with PHP 8.2+ and cron, any VPS (Ubuntu + Nginx/Apache + PHP-FPM).
**Will not work on**: hosting without PHP 8.2 (e.g. PHP-only-7 plans), hosting without cron *and* with
`exec()`/`popen()` disabled *and* without PHP-FPM/LiteSpeed (then background sync only runs while pages load —
ask the host to enable cron).

No Node.js, Python, Redis or queue daemon is required.

---

## 4. Environment variables (`.env`)

Copy `.env.production.example` to `.env` on the server and fill in:

| Name | Value |
|---|---|
| `APP_NAME` | `"SundayBazar ERP"` |
| `APP_ENV` | `production` |
| `APP_KEY` | generate on the server: `php artisan key:generate` (keep it; changing it logs everybody out) |
| `APP_DEBUG` | `false` |
| `APP_URL` | `https://<erp.your-domain.com>` — the exact public address, https |
| `LOG_LEVEL` | `warning` |
| `DB_HOST` / `DB_PORT` | usually `127.0.0.1` / `3306` (cPanel: `localhost`) |
| `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | the database and user you create in step 5 |
| `SESSION_LIFETIME` | `480` (minutes idle before logout) |
| `SESSION_SECURE_COOKIE` | `true` |
| `SHOPIFY_STORE_DOMAIN` | `sundaybazar-001.myshopify.com` (verified store; **not** www.sundaybazar.com.pk) |
| `SHOPIFY_CLIENT_ID` | the app's Client ID (32 characters, 0-9 a-f; no spaces, no quotes, nothing in front) |
| `SHOPIFY_CLIENT_SECRET` | the app's Client secret (`shpss_…`) |
| `SHOPIFY_API_VERSION` | `2025-10` |
| `SHOPIFY_WRITE_*` | `true` (ERP → Shopify two-way sync). Set one to `false` only as an emergency stop |
| `POSTEX_TOKEN` | PostEx API token (optional; without it delivery status comes from the PostEx updates on Shopify) |
| `ERP_REGISTRATION` | `approval` (new sign-ups wait for an admin), `open` or `closed` |
| `ERP_AUTOTICK` | `true` (safety net when cron stops) |
| `ERP_PHP_BINARY` | leave empty; if the safety net cannot find PHP set the CLI path, e.g. `/usr/local/bin/php` or `/opt/cpanel/ea-php83/root/usr/bin/php` |
| `ERP_SNAPSHOT_TOKEN` | 32+ random characters if you want to copy live data to your PC (section 21); empty = off |
| `ERP_ADMIN_EMAIL` / `ERP_ADMIN_PASSWORD` | optional one-time first admin (section 16); delete the password line after use |

Never put these values in any other file, in Git, in the browser, in screenshots or in chat messages.
`.env` is excluded from Git (`.gitignore`) and blocked from the web (`.htaccess`).

---

## 5. Create the live database in phpMyAdmin

1. cPanel → **MySQL® Databases** (or **Database Wizard**):
   - create database `<cpaneluser>_erp`
   - create user `<cpaneluser>_erp` with a long random password
   - add the user to the database with **ALL PRIVILEGES**
2. cPanel → **phpMyAdmin** → select the new database (left column).
3. Collation (Operations tab): `utf8mb4_unicode_ci`.

(On a VPS: `CREATE DATABASE sundaybazar_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` and
`CREATE USER 'erp'@'localhost' IDENTIFIED BY '<password>'; GRANT ALL ON sundaybazar_erp.* TO 'erp'@'localhost';`)

---

## 6. Create the tables: import the SQL file **or** run migrations

**A. phpMyAdmin import (no command line needed)**
1. phpMyAdmin → your database → **Import** → *Choose file* → `database.sql` (in the project folder) → **Go**.
2. It creates all **119 tables** (InnoDB, utf8mb4, keys, indexes, foreign keys) and default data (13 roles,
   43 permissions, chart of accounts, expense categories, cash boxes). It contains **no users and no passwords**.
   Importing it twice is safe.
3. If the import stops because the file is too big for the host's upload limit, use B or upload it zipped (`database.sql.zip`).

**B. Migrations (SSH / cPanel Terminal)**
```bash
php artisan migrate --force
```

**In both cases**, then run once (it is safe to repeat after every update):
```bash
php artisan erp:install
```
Without SSH: cPanel → Cron Jobs → add a one-off job `cd <project path> && php artisan erp:install`, wait a minute, remove it.

---

## 7. Required tables & initial data (overview)

Orders (`orders`, `order_items`, `order_fulfillments`, `order_refunds`, `order_transactions`), products
(`shopify_products`, `products` = variants, `product_media`, `shopify_collections`, `collection_product`), stock
(`shopify_locations`, `inventory_levels`, `locations` = racks), customers (`shopify_customers`, `customers`,
`customer_flags`), access (`users`, `roles`, `permissions`, `role_permissions`, `user_permissions`, `sessions`),
Shopify bookkeeping (`webhook_events`, `sync_runs`, `shopify_writes`, `sync_issues`, `sync_log`), audit (`events`),
`settings`, Laravel (`cache`, `jobs`, `failed_jobs`, `migrations`), and every business module (accounts `acc_*`,
expenses `exp_*`, HR `hr_*`, purchasing `pur_*`, couriers `cr_*`, inbox `ib_*`, tickets `tk_*`, WMS `wms_*`,
stock line `sl_*`, marketing `mkt_*`, operations `ops_*`, abandoned carts `ab_*`).

---

## 8. Upload the files

**Recommended layout (keeps code outside the web folder):**

```
/home/<cpaneluser>/sundaybazar-erp/        <- the whole project (app, vendor, storage, .env …)
/home/<cpaneluser>/sundaybazar-erp/public  <- the domain's document root points HERE
```

Ways to get the files there:

- **Git (best)**: `git clone <your-private-repo-url> ~/sundaybazar-erp` then `composer install --no-dev --optimize-autoloader`.
- **Release zip**: on this PC run `powershell -ExecutionPolicy Bypass -File deploy\make-release.ps1`; it creates
  `..\sundaybazar-erp-release-<date>.zip` with `vendor/` included and **without** `.env`, logs, backups and tests.
  Upload it with cPanel File Manager to `~/sundaybazar-erp/` and **Extract**.

Do **not** upload: `.env` from this PC (it has local settings), `storage/logs/*`, `storage/app/private/*`,
`tests/`, `node_modules/`.

Folder permissions (File Manager → Permissions, or SSH):
```bash
chmod -R 775 storage bootstrap/cache
```

---

## 9. Document root and the public folder

- **cPanel → Domains** (or Subdomains): set the document root of `erp.<your-domain.com>` to
  `sundaybazar-erp/public`.
- **VPS / Nginx**:
  ```nginx
  server {
      server_name erp.<your-domain.com>;
      root /var/www/sundaybazar-erp/public;
      index index.php;
      location / { try_files $uri $uri/ /index.php?$query_string; }
      location ~ \.php$ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name; fastcgi_pass unix:/run/php/php8.3-fpm.sock; }
      location ~ /\.(?!well-known) { deny all; }
  }
  ```
- **If the document root cannot be changed** (e.g. the main domain must stay at `public_html`): upload the
  project into that folder; the root `.htaccess` that ships with the project sends every request to `public/`
  and blocks `.env`, `.sql`, logs, `storage/`, `vendor/`, `app/` and the other private folders.
  Check afterwards that `https://<erp.your-domain.com>/.env` and `/database.sql` show **403/404**.

The ERP must be at the root of its (sub)domain — `https://erp.example.com/`, not `https://example.com/erp/` —
because the app calls `/api/...` with absolute paths.

---

## 10. Frontend assets and routes

There is nothing to build: the browser files are already in `public/erp/` (`app.js`, `app.css`, `shopify.js`,
`access.js`, `auth.js`, `auth.css`, `pre.js`, `post.js`). They are versioned automatically (cache busting by file date).
`public/.htaccess` (Apache/LiteSpeed) sends all other paths to Laravel. After uploading, on the server:

```bash
php artisan config:cache && php artisan route:cache && php artisan view:cache
```

(Run `php artisan config:clear` after every `.env` change, or `config:cache` again.)

---

## 11. Shopify store and API credentials

1. Shopify admin → Settings → Apps → Develop apps → **Build apps in Dev Dashboard** → your ERP app.
2. **Configuration → Access scopes** (already granted on this store, verified):
   `read/write_products, read/write_orders, read/write_inventory, read/write_locations, read/write_customers,
   read/write_fulfillments, read/write_merchant_managed_fulfillment_orders, read/write_assigned_fulfillment_orders`.
   Optional: `read_all_orders` (orders older than 60 days — requested in the app configuration).
3. **Protected customer data**: name, email, phone, address must be enabled (verified working on this store:
   5,813 of 5,815 imported orders have phone numbers).
4. The app must be **installed** on `sundaybazar-001.myshopify.com`.
5. Copy Client ID and Client secret into `.env` (section 4). Check:
   ```bash
   php artisan shopify:check
   ```
   Expected: `Connected to : sundaybazar (sundaybazar-001.myshopify.com, PKR, Asia/Karachi, www.sundaybazar.com.pk)`,
   3 locations, and no "Missing" line. A `400 … application_cannot_be_found` answer means the Client ID is wrong
   (it once had an extra character in front — the check now warns about that).
6. In the ERP: **Settings → Shopify connection & automatic sync → Stock location** → choose where returned stock
   is added (E-Commerce / Warehouse / Zamzama outlet) → *Save location*.

---

## 12. Register the webhooks

Webhooks are how Shopify tells the ERP about a change within seconds (new order, payment, fulfilment,
cancellation, refund, product, stock, customer, app uninstalled).

```bash
php artisan shopify:webhooks register
php artisan shopify:webhooks list
```
or **Settings → Shopify → Register webhooks**. 22 topics are registered for
`https://<erp.your-domain.com>/api/hooks/shopify`. Each delivery is checked with Shopify's HMAC signature
(key = Client secret) and the shop domain, stored once (duplicates ignored), answered at once and applied right
after the answer. Failed ones are retried automatically (1, 4, 9 … minutes) and by the nightly check.

Register webhooks **only on the live server** (one public address). Do not register your PC.

## 13. The public webhook URL

It is always `APP_URL` + `/api/hooks/shopify`. If the ERP is behind a different public address than `APP_URL`,
set `SHOPIFY_WEBHOOK_URL=https://…/api/hooks/shopify` and register again. After moving domains: register again,
then `php artisan shopify:webhooks remove --url=https://<old-address>/api/hooks/shopify`.

---

## 14. Background work: cron, queue, reconciliation

Add **one** cron job (cPanel → Cron Jobs → "Once Per Minute"):

```
* * * * * cd /home/<cpaneluser>/sundaybazar-erp && php artisan schedule:run >> /dev/null 2>&1
```
(Use the full PHP path if `php` is not the right version, e.g. `/opt/cpanel/ea-php83/root/usr/bin/php`.)

Every minute this runs `php artisan erp:tick`, which:
- applies webhook events that are not applied yet;
- syncs changes from Shopify — every minute while no webhooks arrive, every 10 minutes (orders) / 30 (products) /
  60 (customers) as a safety net once webhooks work;
- runs the business jobs (accounts posting, courier tracking, HR, tickets, WhatsApp, backups);
- once a day: stock levels per location, missing-data check (reconcile) and, after 02:00 PKT, the database backup.

No queue worker or Supervisor is needed (jobs are processed inside the minute run). If the host has no cron,
`ERP_AUTOTICK=true` starts the minute run from page visits — keep cron anyway for reliability.

Check: Settings → Shopify connection & automatic sync → "Automatic sync: running · Last run … ago".

---

## 15. HTTPS and permissions

- cPanel → SSL/TLS Status → **Run AutoSSL** (or Let's Encrypt). Always open the ERP with `https://`.
- With `APP_URL=https://…` the ERP builds https links and sends cookies only over HTTPS.
- Files 644, folders 755; `storage/` and `bootstrap/cache/` writable (775) by the PHP user. `.env` 640.

---

## 16. First admin account (securely)

There is **no default account or password**. Create the first super administrator in **one** of these ways:

```bash
php artisan erp:admin <username> --email=<you@example.com>    # asks for the password (8+ chars, letter + number)
```
or put `ERP_ADMIN_EMAIL` and `ERP_ADMIN_PASSWORD` in `.env`, run `php artisan erp:install`, then **delete the
`ERP_ADMIN_PASSWORD` line**. The browser setup screen is disabled unless `ERP_SETUP_KEY` is set.

Forgotten password: `php artisan erp:admin <username>` resets it. Other staff: *Admin → Staff & access*.

## 17. Log in

`https://<erp.your-domain.com>/login` → e-mail or username + password. Owners and staff managers land on
`/admin`, everyone else on `/dashboard`. Staff can request an account at `/register` (approved by an admin in
*Staff & access → Waiting for approval*).

---

## 18. Initial Shopify import

On the live server, after `shopify:check` works (SSH, or run each as a one-off cron job):

```bash
php artisan shopify:sync orders      # orders of the last 60 days (≈6,000; ~10 min)
php artisan shopify:sync products    # products listed in the last year or in stock (≈26,000; ~30 min)
php artisan shopify:sync inventory   # stock per location (~10 min)
php artisan shopify:sync customers   # all Shopify customers (70,000+; may take an hour)
```
Each saves its position after every page; if it stops, running it again continues where it stopped. Or in the
ERP: Settings → Shopify → **Run the initial import again** (runs in the background).

Alternative: move the data from this PC instead of importing again — on this PC: Settings → Backups →
*Download a copy* (or phpMyAdmin → Export), on the server: phpMyAdmin → Import, then `php artisan erp:install`.
After that the minute sync only fetches what changed since.

---

## 19. Verify that synchronization works

| Check | How |
|---|---|
| Connection | `php artisan shopify:check` → "Connected to : sundaybazar" |
| Automatic sync | Settings → Shopify: "Automatic sync: running", last run under 2 minutes |
| New order | place/receive an order in Shopify → it appears in ERP *Orders* within seconds (webhook) or ≤1 minute |
| Order update | add a note/tag to an order in Shopify → *Orders* drawer → "In Shopify" shows the change |
| Payment | an online-paid order shows "paid", the amount received and its transaction in the drawer |
| Fulfilment / delivery | fulfilled orders show the courier, tracking and delivery status from Shopify |
| Products / stock | edit a test product's price in Shopify → ERP Inventory shows the new price |
| Customers | Settings → Shopify → "In the ERP … customers" grows |
| ERP → Shopify | open a **test** order → "Fulfil in Shopify…" → Shopify shows it fulfilled; the drawer shows "accepted" |
| Webhooks | Settings → Shopify: "Last webhook: orders/… · just now · done"; nothing under "failed" |
| Problems | Settings → Shopify: "Recent sync errors", "Needs review", "Changes sent from the ERP to Shopify" |

Use test orders/products for ERP → Shopify checks; never cancel or refund a real customer order to test.

---

## 20. Deploying future code changes (local → live)

The live database is the only real one. **Code** goes from your PC to the server; **data** never goes that way.

1. Change and test on this PC (`php artisan test`).
2. If you changed migrations, rebuild the SQL file on a fresh database: `php artisan erp:export-sql`.
3. Commit and push to your private Git repository.
4. On the server (SSH):
   ```bash
   cd ~/sundaybazar-erp && bash deploy/deploy.sh
   ```
   It puts the site in maintenance mode, `git pull`s, installs dependencies, runs **new** migrations only
   (`migrate --force` never drops data), `erp:install`, rebuilds caches, comes back online and checks Shopify.
5. Without SSH/Git: `deploy\make-release.ps1` → upload & extract the zip over the old files (keep the server's
   `.env` and `storage/`) → run `bash deploy/deploy.sh --no-pull` (or the same commands as one-off cron jobs).

Rollback: `git checkout <previous-commit> && bash deploy/deploy.sh --no-pull` (restore the database backup only
if a migration changed data).

---

## 21. Seeing live data on your PC

- **Shopify data** (orders, products, stock, customers) reaches both: the live server by webhooks, your PC by its
  own minute-by-minute sync from Shopify (read-only). Only the live server has webhooks registered.
- **ERP-only data** (confirmation calls, stages, accounts, HR …) lives in the live database. To copy it to your PC:
  1. Live `.env`: `ERP_SNAPSHOT_TOKEN=<32+ random characters>` (then `php artisan config:cache`).
  2. Local `.env`: the same `ERP_SNAPSHOT_TOKEN` and `ERP_PRODUCTION_URL=https://<erp.your-domain.com>`.
  3. On the PC: `php artisan erp:pull-production` → backs up the local database, downloads a snapshot over HTTPS
     and replaces the local data. Production → local only; it refuses to run on a server with `APP_ENV=production`.
- MySQL is **never** opened to the internet. Staff should work on the live address; the PC copy is for development.
- Changes you make on your PC that go to Shopify (fulfil, cancel, refund, prices) change the real store and reach
  the live ERP through Shopify's webhooks. ERP-only changes on the PC stay on the PC. For pure development set
  `SHOPIFY_WRITE_*=false` in the local `.env`.

---

## 22. Backup and restore

- Automatic: every night a gzipped SQL dump in `storage/app/private/backups/` (30 days kept).
- Now: Settings → Backups → *Backup now* / *Download a copy* (owner), or cPanel → Backup, or phpMyAdmin → Export.
- Keep copies off the server (Google Drive / USB). Also back up `storage/app/private/erp-files/` (receipts, photos).
- Restore: phpMyAdmin → Import the `.sql.gz` (it drops and recreates the tables), or
  `gunzip -c backup.sql.gz | mysql -u <user> -p <database>`, then `php artisan erp:install`.

---

## 23. Troubleshooting

| Problem | Fix |
|---|---|
| White page / "500 Server Error" | `storage/logs/laravel.log`; folder permissions (`storage`, `bootstrap/cache` writable); `php artisan config:clear` |
| "SQLSTATE[HY000] [1045] Access denied" | DB user/password/name in `.env`; user added to the database with ALL PRIVILEGES; cPanel host is often `localhost` |
| "Base table … doesn't exist" | import `database.sql` or `php artisan migrate --force`, then `erp:install` |
| Login works but pages are blank / 404 for `/erp/app.js` | document root must be `public/` (section 9); ERP must be at the domain root |
| Logged out immediately | `APP_URL` must match the address in the browser (https); `SESSION_SECURE_COOKIE=true` needs https |
| "Shopify refused the client credentials (400)" | Client ID/secret of the same app, no extra characters; app installed on sundaybazar-001; `php artisan shopify:check` shows Shopify's reason |
| "Shopify refused access (403) … missing a permission" | add the scope in the Dev Dashboard, release, reinstall/update the app |
| Webhooks not arriving | `APP_URL` is public https; `php artisan shopify:webhooks list`; firewall/WAF must allow POST `/api/hooks/shopify`; Settings shows "Last webhook" |
| Webhooks "failed" | Settings → Shopify → *Retry failed*; the error is shown; the nightly check retries too |
| Sync "not running" | cron line (section 14); `php artisan erp:tick` by hand shows errors; a crashed import: `php artisan shopify:sync <kind> --force` |
| Background sync never starts without cron | host blocks `exec`; set `ERP_PHP_BINARY` or ask for cron |
| Orders older than 60 days missing | needs `read_all_orders` |
| An ERP → Shopify action failed | the order drawer shows Shopify's error; nothing is changed locally until Shopify confirms |

---

## 24. Production security checklist

- [ ] `APP_ENV=production`, `APP_DEBUG=false`, new `APP_KEY`, `LOG_LEVEL=warning`
- [ ] HTTPS everywhere; `APP_URL` https; `SESSION_SECURE_COOKIE=true`
- [ ] Document root = `public/` (or root `.htaccess` in place); `/.env`, `/database.sql`, `/storage/logs/laravel.log` give 403/404
- [ ] `.env` not in Git, not downloadable, permissions 640
- [ ] Database user has rights on this database only; strong password
- [ ] First admin created with `erp:admin`; `ERP_ADMIN_PASSWORD` removed from `.env`; `ERP_SETUP_KEY` empty
- [ ] `ERP_REGISTRATION=approval` (or `closed`)
- [ ] Shopify Client secret only in `.env`; rotate it in the Dev Dashboard if it was ever shared
- [ ] Webhooks registered for the live address only
- [ ] Roles reviewed in *Staff & access*; refunds (`orders_refund`) only for people who may send money
- [ ] Cron running; backups downloaded off the server regularly
- [ ] `ERP_SNAPSHOT_TOKEN` empty unless you use `erp:pull-production` (then 32+ random characters)

## 25. Final deployment checklist

1. [ ] Hosting has PHP 8.2+, the extensions, MySQL/MariaDB, HTTPS, cron (section 3)
2. [ ] Database + user created in cPanel/phpMyAdmin (section 5)
3. [ ] Files uploaded to `~/sundaybazar-erp`; document root → `public/` (sections 8–9)
4. [ ] `.env` created from `.env.production.example` and filled in; `php artisan key:generate` (section 4)
5. [ ] `database.sql` imported **or** `php artisan migrate --force`; then `php artisan erp:install` (section 6)
6. [ ] `chmod -R 775 storage bootstrap/cache`; `php artisan config:cache route:cache view:cache` (sections 8, 10)
7. [ ] `php artisan erp:admin <username> --email=<you@example.com>` (section 16)
8. [ ] `php artisan shopify:check` OK; stock location chosen in Settings (section 11)
9. [ ] Cron job added; Settings shows "Automatic sync: running" (section 14)
10. [ ] `php artisan shopify:webhooks register` → 22 topics (section 12)
11. [ ] Initial import done (section 18)
12. [ ] Verification table in section 19 passes
13. [ ] Security checklist (section 24) done
