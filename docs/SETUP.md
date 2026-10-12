# SundayBazar ERP — setup guide

Laravel 12 · PHP 8.2+ (tested on 8.3) · MySQL 8 or MariaDB 10.4+ · Shopify Admin GraphQL API 2025-10.

The browser app is the SundayBazar ERP interface (`public/erp/app.js`) with the design system in `public/erp/app.css`
(Poppins, self-hosted in `public/erp/fonts/`; colours, spacing and components as CSS variables). The original single-file
version is kept in `legacy/` for reference.

---

## 1. Local installation (XAMPP on Windows)

1. **Database (phpMyAdmin)**
   - Open http://localhost/phpmyadmin → *Databases* → *Create database*.
   - Name: `sundaybazar_erp`, collation: `utf8mb4_unicode_ci` → *Create*.
   - (The same in SQL: `CREATE DATABASE sundaybazar_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)
   - Do not create tables by hand: the migrations do it.

2. **Configuration**
   ```bash
   cd C:\xampp2\htdocs\sundaybazaarErp
   composer install
   copy .env.example .env        # only if .env does not exist yet
   php artisan key:generate      # only for a new .env
   ```
   Edit `.env`: `DB_DATABASE=sundaybazar_erp`, `DB_USERNAME=root`, `DB_PASSWORD=` (XAMPP default), and the Shopify
   values (section 3). `.env` is in `.gitignore` — never commit it.

3. **Tables and default data** — either import `database.sql` in phpMyAdmin (Import tab), or:
   ```bash
   php artisan migrate            # creates all ERP tables (119)
   ```
   then, in both cases:
   ```bash
   php artisan erp:install        # roles & permissions, chart of accounts, expense categories, webhook keys … (safe to re-run)
   php artisan erp:admin owner --email=you@example.com   # first super administrator (asks for the password)
   ```
   Instead of `erp:admin` you can set `ERP_ADMIN_EMAIL` / `ERP_ADMIN_PASSWORD` in `.env` and run `erp:install`
   (then remove the password from `.env`). There is no default account. The browser setup screen only works when
   `ERP_SETUP_KEY` is set. Log in at `/login`; staff can sign up at `/register` (see README → Login, registration).

4. **Serving the app** — the browser app calls `/api/...` with absolute paths, so the ERP must be served at the
   **root of a host/port**, not under `http://localhost/sundaybazaarErp/public`.
   - Quick: `php artisan serve` → http://127.0.0.1:8000 (set `APP_URL=http://127.0.0.1:8000`).
   - XAMPP Apache (for office LAN use): add to `C:\xampp2\apache\conf\extra\httpd-vhosts.conf` and restart Apache:
     ```apache
     Listen 8080
     <VirtualHost *:8080>
         DocumentRoot "C:/xampp2/htdocs/sundaybazaarErp/public"
         <Directory "C:/xampp2/htdocs/sundaybazaarErp/public">
             AllowOverride All
             Require all granted
         </Directory>
     </VirtualHost>
     ```
     Then open http://localhost:8080 (staff on the office WiFi: `http://<this-pc-ip>:8080`) and set `APP_URL` to it.
     `mod_rewrite` must be enabled (it is in XAMPP by default).

5. **Background sync** — `start-erp.bat` opens the web server and `php artisan schedule:work` (the minute clock).
   No queue worker is needed. If the clock is not running, the web app starts `php artisan erp:tick` by itself while the
   ERP is in use (`ERP_AUTOTICK=true`).

---

## 2. What runs when

`php artisan erp:tick` runs every minute (cron / `schedule:work` / started by the web app):

| When | What |
|---|---|
| immediately | Shopify webhooks (live server): the change is applied right after Shopify's request |
| every minute (every 10 min once webhooks arrive) | Shopify orders changed since the last sync |
| every 5 min (30 with webhooks) | Shopify products changed since the last sync |
| every 15 min (60 with webhooks) | Shopify customers changed since the last sync |
| every minute | webhook events not applied yet / failed (retried after 1, 4, 9 … minutes) |
| every 2 h | PostEx parcels, COD and settlement status (when the PostEx token is set) |
| once a day | stock levels per location; missing-data check (reconcile); database backup after 02:00 PKT |
| module jobs | accounts auto-posting, expenses recurring bills, HR, tickets follow-ups, TCS tracking, WhatsApp auto-messages, abandoned carts, Meta ad spend … |

Manual: Settings → *Shopify connection & automatic sync* (*Sync now*, *Retry failed*, *Check for missing data*, *Run the initial
import again*) or `php artisan shopify:sync orders|products|customers|inventory|postex|reconcile|all|full`.

---

## 3. Shopify connection

### 3.1 Store domain
The Admin API host is the **myshopify.com domain**, not the storefront domain. For this store it was verified as:

```
SHOPIFY_STORE_DOMAIN=sundaybazar-001.myshopify.com      # storefront: www.sundaybazar.com.pk
```

`Test connection` / `php artisan shopify:check` refuse to continue if the connected store is a different one.

### 3.2 The app (Shopify Dev Dashboard)
The ERP uses the **client-credentials grant**: the Client ID and Client secret of an app created in the Shopify
**Dev Dashboard** (Shopify admin → Settings → Apps → Develop apps → *Build apps in Dev Dashboard*) are exchanged
for an Admin API access token valid ~24 h. The ERP caches it (encrypted with `APP_KEY`), renews it 5 minutes
before expiry and immediately on a 401. This grant only works when the app and the store belong to the **same
organization** and the app is **installed** on the store. The ID and secret are not a token themselves.

In the app's configuration (Dev Dashboard → app → Versions → new version):

1. **Access scopes** (Admin API):
   - Required: `read_products, write_products, read_orders, write_orders, read_inventory, write_inventory, read_locations`
   - Fulfilment from the ERP (courier booking → Shopify fulfilment): `read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders` (and the `assigned_` pair if a fulfilment service is used)
   - Customers: `read_customers`
   - Orders older than 60 days: `read_all_orders` — Shopify only grants this to apps after requesting it in the app setup; without it the API returns only the last 60 days. The ERP's first import uses `history_days` (default 60), so it works without it.
2. **Protected customer data**: customer name, phone, email and address on orders are *protected customer data*.
   In the app's *API access / Protected customer data* section, select the reasons (order fulfilment, customer
   service) and the fields **Name, Email, Phone, Address**. Without it Shopify returns those fields empty/denied:
   the ERP still imports orders, flags "Data access" in Settings, and phone-based features (confirmation calls,
   customer scores, WhatsApp) have nothing to work with.
3. **Release** the version and **install / update** it on the store (Dev Dashboard → Install app → choose sundaybazar).
4. Copy **Client ID** and **Client secret** (Dev Dashboard → app → Settings) into `.env`:
   ```
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   ```
   Never put them in browser code or commit them. If the secret was ever shared, **rotate** it in the Dev Dashboard and update `.env`.
5. Run `php artisan config:clear` (and `config:cache` in production), then:
   ```bash
   php artisan shopify:check
   ```
   It obtains a token, prints the store, currency, time zone, locations and the granted scopes, and lists missing scopes.
   The same check is the **Test connection** button in Settings → Shopify.

### 3.3 Stock location
The store has several active locations (E-Commerce, Warehouse, Zamzama outlet). Stock changes made by the ERP
(e.g. a returned parcel put back in stock) go to **one** location chosen in **Settings → Shopify → Stock location**.
Nothing is sent to Shopify until it is chosen.

### 3.4 ERP → Shopify (two-way)
Changes made in the ERP are sent to Shopify automatically and the ERP shows the result Shopify confirms:
order tags after confirmation calls, fulfilments with tracking when a courier is booked (and delivery updates from the ERP's
own courier data), stock back at the stock location for good returns, markdown prices, and the order drawer's *Fulfil*, *Cancel*
and *Refund in Shopify* (with typed confirmation and their own permissions). Each one is logged in `shopify_writes`.
In an emergency set `SHOPIFY_WRITE_TAGS|FULFILLMENTS|INVENTORY|PRICES|ORDER_CANCEL|REFUNDS=false` in `.env` and run
`php artisan config:clear`.

### 3.5 First import
```bash
php artisan shopify:sync orders      # last `history_days` (60) days of orders
php artisan shopify:sync products    # products listed in the last 365 days or still in stock (setting product_history_days; 0 = all)
php artisan shopify:sync inventory   # stock per location
php artisan shopify:sync customers   # optional
```
Each import saves its position after every page (table `sync_runs`). If it stops (network, closed window), running
it again continues from where it stopped. Afterwards only changes are fetched.

---

## 4. Webhooks (near-real-time updates)

Shopify must reach the ERP over **public HTTPS**: `https://<your-domain>/api/hooks/shopify`.

1. Set `APP_URL=https://erp.example.com` (or `SHOPIFY_WEBHOOK_URL=https://.../api/hooks/shopify` if different).
2. `php artisan shopify:webhooks register` (or **Settings → Shopify → Register webhooks**).
   Topics: orders create/updated/cancelled/fulfilled/partially_fulfilled/paid/delete, fulfillments create/update,
   refunds/create, products create/update/delete, inventory_levels/update, inventory_items/update,
   customers create/update, locations create/update, checkouts create/update, app/uninstalled.
3. `php artisan shopify:webhooks list` shows what is registered.

Each delivery is checked with the HMAC signature (`X-Shopify-Hmac-Sha256`, key = client secret) and the shop
domain; unsigned or foreign requests get 401. Every webhook id is stored once (`webhook_events`), answered at once
and processed by the queue worker, which fetches the current record from the Admin API.

Local development: webhooks cannot reach `127.0.0.1`. Use a tunnel (e.g. `ngrok http 8000`, already installed
under Laragon) and register with `--url=https://<tunnel>/api/hooks/shopify`. Without webhooks the scheduled sync
still keeps everything up to date every 15 minutes.

Other incoming webhooks (unchanged from the original ERP): `/api/hooks/cequens` (WhatsApp), `/api/hooks/instagram`,
`/api/hooks/google-form`, `/api/hooks/shopify/checkouts` — configured in their own Settings screens.

---

## 5. Other integrations
- **PostEx**: `POSTEX_TOKEN` in `.env` (or Settings → PostEx). **TCS**, **Cequens WhatsApp**, **Instagram/Meta**,
  **Meta Ads**: configured in their screens as before (stored in the `settings` table).

---

## 6. Production deployment

See **[LIVE_SERVER_DEPLOYMENT_GUIDE.md](../LIVE_SERVER_DEPLOYMENT_GUIDE.md)** (requirements, phpMyAdmin, upload, document
root, cron, HTTPS, webhooks, updates with `deploy/deploy.sh`, backups, troubleshooting, checklists).

---

## 7. Useful commands

| Command | Purpose |
|---|---|
| `php artisan shopify:check` | test the Shopify connection, show store, locations, scopes |
| `php artisan shopify:sync <kind>` | run a sync now in the terminal |
| `php artisan shopify:webhooks list\|register\|remove` | manage webhook subscriptions |
| `php artisan erp:install` | (re)create default data, idempotent |
| `php artisan erp:admin <user>` | create an owner login or reset its password |
| `php artisan erp:tick` | run due background jobs once (the scheduler does this every minute) |
| `php artisan shopify:sync <kind> --force` | clear the lock of a sync that crashed, then run it |
| `php artisan erp:export-sql` | rebuild `database.sql` from a freshly migrated database |
| `php artisan erp:pull-production` | copy the live database to this PC (production → local only) |
| `php artisan test` | automated tests (uses database `sundaybazar_erp_test`) |
