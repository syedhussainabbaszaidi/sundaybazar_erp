# SundayBazar ERP (Laravel + MySQL + Shopify)

The SundayBazar staff ERP — orders & confirmation calls, dispatch (PostEx / TCS / own rider), warehouse & WMS, listing &
pricing, purchasing, accounts, expenses, HR & payroll, tickets, WhatsApp/Instagram inbox, marketing — on Laravel 12 with
MySQL/MariaDB, connected to the Shopify store `sundaybazar-001.myshopify.com` (www.sundaybazar.com.pk).

**Going live: [LIVE_SERVER_DEPLOYMENT_GUIDE.md](LIVE_SERVER_DEPLOYMENT_GUIDE.md).** More detail: [docs/SETUP.md](docs/SETUP.md) (setup) · [docs/SHOPIFY_INTEGRATION.md](docs/SHOPIFY_INTEGRATION.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/PORTING_GUIDE.md](docs/PORTING_GUIDE.md).

---

## URLs

Local development (`php artisan serve`, the way this copy is run on this PC — verified):

| Page | URL |
|---|---|
| Login | http://127.0.0.1:8000/login |
| Registration | http://127.0.0.1:8000/register |
| Admin (super administrators and staff managers) | http://127.0.0.1:8000/admin |
| Staff dashboard (everybody else) | http://127.0.0.1:8000/dashboard |
| Home | http://127.0.0.1:8000/ → sends you to `/login`, `/admin` or `/dashboard` |

`/admin` and `/dashboard` open the same ERP; the menu shows only what the person's role allows, and every API call is
checked on the server. People without staff-management rights who open `/admin` are sent to `/dashboard`.
The app must run at the root of a host/port (it is **not** reachable as `http://localhost/sundaybazaarErp/public`);
for Apache see [docs/SETUP.md §1.4](docs/SETUP.md).

---

## Database setup (phpMyAdmin)

1. phpMyAdmin → **Databases** → name `sundaybazar_erp`, collation `utf8mb4_unicode_ci` → **Create**.
2. Choose **one** way to create the tables:
   - **Import** (no command line): select the database → **Import** → choose [`database.sql`](database.sql) → **Go**.
     It creates all 119 tables (InnoDB, utf8mb4, keys, indexes, foreign keys) and the default data: 13 roles, 43 permissions,
     chart of accounts, expense categories, cash boxes. It contains **no user accounts and no passwords**. Importing it again is
     safe (tables are created only if missing, default rows only if missing).
   - **Migrations**: `php artisan migrate` then `php artisan erp:install`.
3. Either way, then run once: `php artisan erp:install` (adds per-install webhook keys and anything newer than the SQL file —
   safe to repeat after every update).
4. Settings in `.env`: `DB_DATABASE=sundaybazar_erp`, `DB_USERNAME=root`, `DB_PASSWORD=` (XAMPP default).

`database.sql` is generated from the migrations: after changing migrations run `php artisan erp:export-sql` against a freshly
migrated and installed database to rebuild it.

---

## First administrator

There is no default account or password. Create the first super administrator on the server, **one** of:

- `php artisan erp:admin owner --email=you@example.com` (asks for the password; 8+ characters with a letter and a number), or
- put `ERP_ADMIN_EMAIL` and `ERP_ADMIN_PASSWORD` in `.env`, run `php artisan erp:install`, then **delete `ERP_ADMIN_PASSWORD` from `.env`**.

The browser setup screen is off unless `ERP_SETUP_KEY` is set. `php artisan erp:admin <username>` also resets a forgotten password.

---

## Login, registration and sessions

- **Login** (`/login`): e-mail **or** username + password. Wrong passwords: 8 tries per 15 minutes per person and connection.
  "Keep me signed in" uses a remember-me cookie; otherwise the session ends after `SESSION_LIFETIME` minutes of inactivity
  (480 = 8 hours). Session cookies are HttpOnly and SameSite=strict (set `SESSION_SECURE_COOKIE=true` with HTTPS).
- **Registration** (`/register`): full name, e-mail, password + confirmation, checked in the browser and again on the server
  (valid e-mail, no duplicates, 8+ characters with a letter and a number). Passwords are stored with bcrypt.
  `ERP_REGISTRATION` decides what happens:
  - `approval` (default): the account is created **blocked**; an administrator approves it under *Admin → Staff & access*
    (it is listed as "waiting for approval", with a badge in the menu).
  - `open`: the person can log in straight away. `closed`: registration is off.
  - New accounts get `ERP_REGISTRATION_ROLE` (default `staff` = only "My day"). Public registration never creates administrators.
- **Logout** ends the session; blocking an account or changing its role/password logs that person out everywhere.

---

## Roles & permissions (RBAC)

*Admin → Staff & access* has three tabs: **Staff accounts**, **Roles & permissions**, **Activity log**.

- A **role** is a set of permissions. Built-in roles: Owner/Admin (super administrator), Manager, CS, Tracking, Warehouse,
  Rider, Lister, Finance, Marketing, HR, Exchanges & WhatsApp, Instagram & abandoned carts, General staff. Custom roles can be
  created, changed and deleted (built-in roles can be changed but not deleted; a role in use cannot be deleted).
- Each person has one role, plus personal exceptions: tick a permission to **grant** it to that person only, untick one of
  the role's permissions to **revoke** it from that person only.
- Permissions are grouped by module (Dashboard, Orders, Customers, Products, Inventory, Delivery, Messages, Finance,
  Accounting, Expenses, People, Reports, Shopify sync, System settings, Staff, Roles). Examples:

  | Module | Permissions |
  |---|---|
  | Orders | View · Edit (stage, notes) · Fulfil, Cancel, Refund (in Shopify) · Confirmation calls · Abandoned carts |
  | Customers | View · Edit (blacklist / VIP) |
  | Products | Lots, listing & pricing · Update prices in Shopify |
  | Inventory | View & locate · Pick, pack, returns · Adjust & manage (receiving, counts, damage, transfers) |
  | Reports | View · Export |
  | Shopify sync | View status · Run sync · Manage settings (connection, stock location, webhooks) |
  | Staff | Manage accounts · View activity log |
  | Roles | Manage roles |
  | System settings | Update |

  The ERP has no screens to create/delete Shopify products, collections or customers (they are managed in Shopify and synced),
  so there are no permissions for those actions.
- **Enforced on the server** for every API call; a missing permission means *no access* (403).
- **No privilege escalation**: nobody can give a role or permission they do not have, change their own role/access/status,
  or create/edit/assign a super administrator unless they are one. The **last active super administrator** cannot be blocked
  or moved to another role.
- Every change (accounts, roles, approvals, logins, settings) is written to the **activity log**.

---

## Shopify (automatic two-way sync)

Credentials live only in `.env` (`SHOPIFY_STORE_DOMAIN=sundaybazar-001.myshopify.com`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`),
never in the browser or the database. Check the connection with `php artisan shopify:check` or *Settings → Shopify → Test connection*.

**Shopify → ERP** — new and changed orders (items, totals, discounts, tax, shipping, currency, payment status, amounts received and
outstanding, transactions, fulfilments with tracking and delivery status, cancellations, refunds), products (variants, SKUs,
barcodes, prices, images, collections, status), stock per location, and customers. On the live server Shopify's **webhooks**
deliver each change within seconds; a check every few minutes catches anything missed. Without webhooks (e.g. this PC) the ERP
asks Shopify for changes **every minute**. Delivery status comes from the courier updates on the Shopify fulfilment (PostEx's
Shopify integration) when the PostEx API is not connected.

**ERP → Shopify** — confirmation calls tag the order, courier bookings create the fulfilment with tracking, the ERP's own courier
updates post delivery events, returns put stock back at the chosen location, markdown prices, and from the order drawer:
*Fulfil in Shopify*, *Cancel in Shopify* (typed CANCEL) and *Refund in Shopify* (typed REFUND, only money Shopify received).
Every change waits for Shopify's answer and is logged with who did it and whether Shopify accepted it. Payment status is never set
from the ERP. `SHOPIFY_WRITE_*=false` in `.env` stops a direction in an emergency.

**Background work without extra programs** — `php artisan erp:tick` runs every minute (cron on the server, `schedule:work` or
`start-erp.bat` here) and, if nothing runs it, the web app starts it itself while the ERP is in use. Settings → *Shopify connection &
automatic sync* shows whether it runs, the last successful syncs, the last webhook, errors, failed items (*Retry failed*), and offers
*Sync now*, *Check for missing data* and *Run the initial import again*. The old "Rules" and "Sync" settings are gone.

**The "Shopify refused the client credentials (400)" error** was caused by the Client ID in `.env` (an extra `x` in front of the
32-character ID; Shopify answered `application_cannot_be_found`). The error message now shows Shopify's reason and `shopify:check`
warns about a malformed Client ID.

---

## Running locally

Double-click **`start-erp.bat`** (web server + background sync, opens `http://127.0.0.1:8000/login`), or:

```bash
composer install
php artisan migrate && php artisan erp:install     # or import database.sql, then erp:install
php artisan erp:admin owner --email=you@example.com
php artisan serve            # http://127.0.0.1:8000/login
php artisan schedule:work    # second window: the minute clock (optional: the web app starts it by itself)
php artisan test             # automated tests (database sundaybazar_erp_test)
```

To see the live server's ERP data here: `php artisan erp:pull-production` (production → local copy only; see the guide §21).

## Interface

One design system for every screen (`public/erp/app.css`): Poppins, the Sunday Bazar green with an orange accent, light and
dark themes (profile menu → Theme). The side menu has the logo, grouped screens with icons and badges, and can be collapsed to
icons on desktop; on tablets and phones it is a drawer (☰), closed by tapping outside, Esc or choosing a screen. The top bar
shows where you are (breadcrumb), search (`/` key; a search icon on phones), check-in, sync status, help, alerts and the
profile menu (help, change password, theme, log out). Dialogs close with Esc and become bottom sheets on phones; tables become
one card per row on phones. Checked in Chrome at 1440, 1024, 768, 375 and 320 px wide (see docs/TESTING.md).

## Live server

Everything about hosting — requirements, phpMyAdmin, upload, document root, `.env`, cron, HTTPS, webhooks, first admin, initial
import, updates, backups, troubleshooting — is in **[LIVE_SERVER_DEPLOYMENT_GUIDE.md](LIVE_SERVER_DEPLOYMENT_GUIDE.md)**.
Updates on the server: `bash deploy/deploy.sh`.

## Layout

| Path | What |
|---|---|
| `public/erp/` | browser app: `app.js` (screens, shell), `app.css` (design system), `fonts/` (Poppins), `shopify.js` (sync section, order drawer), `access.js` (staff & roles), `auth.js`/`auth.css` (login & registration) |
| `public/sundaybazarlogo.png`, `favicon.ico`, `*.png`, `site.webmanifest` | logo (sidebar, login) and browser/phone icons made from it |
| `deploy/`, `start-erp.bat`, `.htaccess` | server update script, release package script, local start, shared-hosting protection |
| `resources/views/` | `auth.blade.php` (login/registration), `erp.blade.php` (app shell) |
| `app/Erp/Modules/` | API modules (Core, Access, Accounts, Couriers, Inbox, …) |
| `app/Erp/Access.php` | permission catalogue, default roles, effective permissions |
| `app/Services/Shopify/` | Shopify client, sync, writer, webhooks, reconcile |
| `database/migrations/`, `database.sql` | schema (migrations) and the phpMyAdmin import file |
| `legacy/` | the original single-file ERP (reference only) |
