# Porting guide: Node ERP module → Laravel module

The original SundayBazar ERP is a Node.js app (bundled into `legacy/SundayBazar ERP Practice.html`).
Its extracted sources are in `legacy/server/` (server.js, lib/*.js, modules/*.js) and the browser app
in `legacy/client.js`. The browser app is reused **unchanged**: it calls `/api/...` and expects
exactly the same JSON as before. So a port must keep, for every route:

- the same method + path, permission, request body fields, query parameters;
- the same response JSON keys, nesting and value types (numbers stay numbers, `null` stays `null`);
- the same error texts and HTTP status codes (`need(...)` messages are shown to staff);
- the same side effects (rows written, `log()` events, settings).

Do not "improve" behaviour, rename things or drop features. Translate faithfully.

## Files

| Original | Port |
|---|---|
| `legacy/server/modules/foo.js` | `app/Erp/Modules/FooModule.php` (class `FooModule extends App\Erp\Module`) |
| its `schema` + columns added in `migrate()` | `database/migrations/2026_10_12_0002NN_create_foo_tables.php` (Schema builder) |
| its `migrate()` data seeding | `public function install(): void` (must be idempotent) |

Kernel (already written, do not edit — report problems instead): `app/Erp/{Db,Module,Router,Settings,Activity,Access,Erp,HttpError}.php`,
`app/Erp/Core/{Logic,Finance,PostEx}.php`, `app/Services/Shopify/*`, `app/Http/Controllers/ErpApiController.php`.

## Module class skeleton

```php
<?php
namespace App\Erp\Modules;

use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Erp\Core\Logic;          // L.normPhone(...) -> Logic::normPhone(...)
use Illuminate\Http\Request;

class FooModule extends Module
{
    public string $name = 'foo';                // same as module.exports.name

    public function perms(): array { return [['foo_x', 'Label']]; }   // module.exports.perms

    public function install(): void { /* migrate(ctx) seeding, idempotent */ }

    public function routes(Router $r): void
    {
        $r->get('/api/foo/:id', 'foo', 'show');     // route('GET', '/api/foo/:id', 'foo', handler)
        $r->post('/api/foo', 'foo', 'save');
        $r->post('/api/hooks/foo', null, 'hook');   // perm null = public (webhooks)
    }

    // (req, u, b, res, p, qs) => ...   becomes:
    public function show(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $row = Db::get('SELECT * FROM foo WHERE id=?', (int) $p['id']);
        $this->need($row, 'Not found', 404);
        return ['row' => $row];
    }

    public function jobs(): array   // module.exports.jobs
    {
        return [['name' => 'daily', 'every' => 60, 'offset' => 7, 'run' => fn () => $this->daily()]];
    }

    public function counts(array $u): array { return []; }   // module.exports.counts(u, ctx)
    public function alerts(array $u): array { return []; }   // module.exports.alerts(u, ctx)
    public function activity(): array { return []; }         // module.exports.activity

    // services: `ctx.services.foo = { summary, bar }`  ->  public methods summary(), bar() on this class
    public function summary(): array { return []; }
}
```

- Route registration order inside `routes()` must follow the JS order (first match wins).
- Handler method names: anything readable and unique within the class (e.g. `claimsList`, `claimApprove`).
- Shared JS closures inside `routes(ctx)` (helpers like `claim(id)`, `boxBal(id)`) become `private`/`protected` methods.
- State the JS kept on `ctx._foo` becomes private properties/methods of the class.
- Route params `$p` are **already URL-decoded** — drop `decodeURIComponent`.
- `+p.id` → `(int) $p['id']`. `qs.x` → `$qs['x'] ?? null`. `b.x` → `$b['x'] ?? null`.

## Context helpers (`ctx.*` → PHP)

| JS | PHP |
|---|---|
| `q.all(sql, ...a)` / `q.get` / `q.run` | `Db::all($sql, ...$a)` / `Db::get` (null when no row) / `Db::run` |
| `q.run(...).lastInsertRowid` / `.changes` | `Db::run(...)->lastInsertRowid` / `->changes` |
| `q.get(...).n` (scalar) | `Db::val(...)` or `Db::get(...)['n']` |
| `q.tx(() => ...)` | `Db::tx(function () use (...) { ... })` |
| `` `IN (${a.map(()=>'?').join(',')})` `` | `'IN ('.Db::marks($a).')'` |
| `setting(k, def)` / `setSetting(k, v)` | `$this->setting($k, $def)` / `$this->setSetting($k, $v)` |
| `log(uid, action, entity, detail)` | `$this->log($uid, $action, $entity, $detail)` |
| `syncLog(kind, ok, msg)` | `$this->syncLog($kind, $ok, $msg)` |
| `need(cond, msg, code)` | `$this->need($cond, $msg, $code)` |
| `throw new HttpError(409, msg)` + extra props | `throw new HttpError(409, $msg, ['dup' => $sku])` |
| `can(u, p)` | `$this->can($u, $p)` |
| `page(qs, n)` | `$this->page($qs, $n)` → `['limit','offset','page']` |
| `today()` (UTC date) / `pkNow()` / `pkToday()` | `$this->today()` / `$this->pkNow()` / `$this->pkToday()` |
| `new Date().toISOString()` | `$this->isoNow()` |
| `maskPhone(u, p)` | `$this->maskPhone($u, $p)` |
| `ctx.services.x.fn(...)` | `$this->svc('x')?->fn(...)` (module `name`); same method name and argument order |
| `ctx.collectAlerts(u)` | `\App\Erp\Erp::alerts($u)` |
| `ctx.S.configured()` / `ctx.S.gql(q, vars)` | `$this->shopify()->configured()` / `$this->shopify()->gql($q, $vars)` (returns `data` array, throws `ShopifyException`) |
| `S.getToken()` + `fetch(base + '/admin/api/…/x.json')` | `$this->shopify()->restGet('x.json', $query)` → `[$json, $nextUrl]` |
| `ctx.P.configured()` / `P.send(...)` / `P.call(path)` / `P.trackOne(tn)` | `$this->postex()->configured()` / `->send($m, $path, $body, $opts)` / `->call($path)` / `->trackOne($tn)` |
| `L.*` (logic.js) | `Logic::*` static: normPhone, waNumber, parseSku, mapPostex, mapTcs, mapRider, normCourier, courierKey, deriveStatus, STATUS, OPEN_SHIP, scoreCustomer, recomputeCustomers, refreshOrder, priceSuggestion, DEFAULT_RULES, jsRound |
| `F.summary / F.reports` | `\App\Erp\Core\Finance::summary/reports` |
| `PR.*` (pricing.js) | `\App\Erp\Core\Pricing::*` (static, same names) |
| `ctx.runSync(kind, uid)` | `\App\Services\Shopify\SyncRunner::start($kind, $uid)` |
| `ctx.A.hash(pw)` / `A.verify` | `Hash::make($pw)` / `Hash::check($pw, $hash)` |
| `ctx.DATA_DIR` | `storage_path('app/private')` |

### Shopify writes (ERP → Shopify)

Never call mutations directly from a module. Use `app(\App\Services\Shopify\ShopifyWriter::class)`:

- `->tagOrder(string $orderGid, array $tags, ?int $uid)`
- `->updatePrices(array $changes, ?int $uid)` — changes `[['product_id','variant_id','price','compare_at'], ...]` → `[['variant_id','ok','error'], ...]`
- `->adjustInventory(string $inventoryItemGid, int $delta, string $reason, ?int $uid, ?string $locationGid = null)`
- `->createFulfillment(string $orderGid, string $tracking, string $company, ?string $url, ?int $uid)` → `['ok' => bool, 'error' => ?string, 'fulfillment_id' => ?string]`
- `->cancelFulfillment(string $fulfillmentGid, ?int $uid)` → `['ok' => bool, 'error' => ?string]`

They check the write switches in `.env`, record the request/response in `shopify_writes`, and throw `ShopifyException` (a RuntimeException) on failure,
except the fulfillment methods, which return `ok=false` with the error.

### Fire-and-forget

JS sometimes starts a promise without awaiting it (`S.tagOrder(...).catch(e => log(...))`, `sendWhatsApp(...)`).
In PHP use `\App\Erp\Defer::run(fn () => ..., 'label')`: it runs after the response is sent / on the queue and logs failures.
Awaited calls (`await x()`) just become normal synchronous calls. `Promise.all([...])` → sequential calls.

## Responses

- Return a PHP array. `null`/no return → `{"ok":true}` (only where JS returned nothing *and* the client does not care).
- JS objects that may be empty (`{}`) and are read as objects by the client: return `(object) $arr` if empty would otherwise become `[]`.
  Lists stay lists: use `array_values()` after `array_filter()`.
- Files / CSV / PDF (`res.writeHead(...); res.end(buf)`): return a Symfony response, e.g.
  `return response($csv, 200, ['Content-Type' => 'text/csv; charset=utf-8', 'Content-Disposition' => 'attachment; filename="x.csv"']);`
- JS `Math.round(x)` → `Logic::jsRound($x)` (PHP `round()` differs for .5 negatives and returns float).
  `Math.floor/ceil` → `(int) floor()` / `(int) ceil()` when the JS value is shown as an integer.
- `x.toFixed(2)` → `number_format($x, 2, '.', '')`; `String(x)` of a number → `(string)` (beware `1.0` → `"1"` vs float formatting).
- `JSON.parse(s)` of DB text → `$this->J($s, $default)` (assoc arrays). `JSON.stringify(x)` → `json_encode($x, JSON_UNESCAPED_UNICODE)`.
- Strings: `.slice(a,b)` → `mb_substr`, `.toUpperCase()` → `mb_strtoupper`, `.includes` → `str_contains`, regex `/x/i.test(s)` → `preg_match('/x/i', $s)`.
- Truthiness: JS `''`, `0`, `null`, `undefined` are falsy — PHP also treats `'0'` as falsy: be careful with strings like `"0"`.
- `a || b` on values → `$a ?: $b`; `a ?? b` → `$a ?? $b`; optional props `o.x` → `$o['x'] ?? null`.
- Dates: `Date.parse(s)` → `strtotime($s.' UTC')` for DB values ('Y-m-d H:i:s' are UTC); `new Date(d).toISOString().slice(0,10)` → `gmdate('Y-m-d', ...)`.
  The server runs in UTC (`date_default_timezone` = UTC, MySQL session time zone `+00:00`).

## SQL: SQLite → MySQL / MariaDB 10.4

The database is MariaDB 10.4 (XAMPP) — must also work on MySQL 8.

| SQLite | MySQL |
|---|---|
| `datetime('now')` | `UTC_TIMESTAMP()` |
| `datetime('now','-7 days')` / `'+3 hours'` | `(UTC_TIMESTAMP() - INTERVAL 7 DAY)` / `(UTC_TIMESTAMP() + INTERVAL 3 HOUR)` |
| `datetime('now','-' \|\| ? \|\| ' days')` | `(UTC_TIMESTAMP() - INTERVAL ? DAY)` with an int param |
| `date('now')` | `UTC_DATE()` |
| `date(col,'+5 hours')` | `DATE(col + INTERVAL 5 HOUR)` |
| `datetime(col,'+5 hours')` | `(col + INTERVAL 5 HOUR)` |
| `substr(datetime(col,'+5 hours'),1,7)` | `DATE_FORMAT(col + INTERVAL 5 HOUR,'%Y-%m')` |
| `substr(col,1,7)` on a DATETIME | `DATE_FORMAT(col,'%Y-%m')` (on a VARCHAR day column `SUBSTR(col,1,7)` is fine) |
| `strftime('%H', col, '+5 hours')` | `HOUR(col + INTERVAL 5 HOUR)` |
| `strftime('%w', d)` | `(DAYOFWEEK(d)-1)` |
| `julianday('now') - julianday(x)` | `TIMESTAMPDIFF(SECOND, x, UTC_TIMESTAMP())/86400.0` |
| `CAST(julianday(a)-julianday(b) AS INT)` | `TIMESTAMPDIFF(DAY, b, a)` |
| `julianday(a) - julianday(b)` on day strings | `DATEDIFF(a, b)` |
| `a \|\| b` | `CONCAT(a, b)` (NULL if any NULL, same as SQLite) |
| `group_concat(x, ', ')` | `GROUP_CONCAT(x SEPARATOR ', ')` |
| `group_concat(DISTINCT x)` | `GROUP_CONCAT(DISTINCT x)` |
| `INSERT ... ON CONFLICT(k) DO UPDATE SET c=excluded.c` | `INSERT ... ON DUPLICATE KEY UPDATE c=VALUES(c)` (needs a UNIQUE/PK on k) |
| `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE` | `INSERT IGNORE` |
| `INSERT OR REPLACE` | `REPLACE INTO` |
| `CAST(x AS TEXT)` / `AS INT` / `AS REAL` | `CAST(x AS CHAR)` / `CAST(x AS SIGNED)` / `(x + 0.0)` |
| `MAX(a, b)` / `MIN(a, b)` (two args) | `GREATEST(a, b)` / `LEAST(a, b)` (careful: NULL if any is NULL — wrap in COALESCE if needed) |
| `IIF(c, a, b)` | `IF(c, a, b)` |
| `ifnull` | `IFNULL` (same) |
| `ltrim(x, '0')` | `TRIM(LEADING '0' FROM x)` |
| `printf('%05d', x)` | `LPAD(x, 5, '0')` |
| `SELECT COUNT(*) FROM (SELECT ...)` | derived table needs an alias: `FROM (SELECT ...) t` |
| `json_extract(c,'$.a')` | `JSON_UNQUOTE(JSON_EXTRACT(c,'$.a'))` |
| `json_each(...)` | not available on MariaDB 10.4 — do it in PHP |
| `sqlite_master` / `PRAGMA table_info` | `Schema::hasTable()` / `Schema::hasColumn()` (columns come from migrations anyway) |
| `RETURNING` | not available — re-select after insert/update |
| `UPDATE t SET ... FROM x` | `UPDATE t JOIN x ON ... SET ...` |
| `DELETE FROM t WHERE id NOT IN (SELECT id FROM t ORDER BY ... LIMIT n)` | find the cut-off id first, then `DELETE ... WHERE id < ?` |
| partial index `CREATE UNIQUE INDEX ... WHERE x IS NOT NULL` | plain unique index (MySQL allows many NULLs in a unique index) |
| `LIKE` | same, but MySQL `=` is case-insensitive too (utf8mb4_unicode_ci) — usually harmless |
| `ORDER BY x NULLS LAST` | `ORDER BY x IS NULL, x` |
| `true`/`false` literals | `1`/`0` |

**Reserved words** — always backtick these when used as column/table names: `` `key` ``, `` `open` ``, `` `range` ``, `` `rank` ``, `` `rows` ``,
`` `lines` ``, `` `group` ``, `` `order` ``, `` `desc` ``, `` `read` ``, `` `release` ``, `` `row` ``, `` `usage` ``, `` `limit` ``, `` `index` ``,
`` `condition` ``, `` `match` ``, `` `return` ``, `` `system` ``, `` `window` ``, `` `values` ``, `` `div` ``, `` `mod` ``, `` `interval` ``, `` `repeat` ``,
`` `leave` ``, `` `left` ``, `` `right` ``, `` `check` ``, `` `default` ``, `` `to` ``, `` `from` ``, `` `when` ``, `` `case` ``. When unsure, backtick.

**GROUP BY**: `ONLY_FULL_GROUP_BY` is off, so bare columns work like SQLite (value from some row of the group).
**Strict mode is off**: `''` stored in a number column becomes 0 (SQLite stored `''`). If the code relies on `''` vs `0`, use a string column.

## Column types (migrations)

Use the Schema builder (`Schema::create`). Map SQLite types:

- `INTEGER PRIMARY KEY` → `$t->id()`; `TEXT PRIMARY KEY` → `$t->string('x', 64..191)->primary()`.
- `INTEGER` → `integer` / `unsignedBigInteger` for user/row ids; flags (0/1) → `boolean` (tinyint) with the same default.
- `REAL` → `double` (never `decimal` — DECIMAL values arrive as strings).
- `TEXT` → `string(n)` when short/indexed (≤191 for unique/primary keys), `text` / `mediumText` for long or JSON.
- Timestamps written as `datetime('now')` / ISO strings → `dateTime` (`->useCurrent()` when the JS default was `datetime('now')`).
  ISO strings like `2025-01-01T10:00:00.000Z` passed as parameters are converted to UTC `Y-m-d H:i:s` automatically by `Db`.
- "Day" values (`'YYYY-MM-DD'`, may also be `''`) and month values → `string('x', 10)` / `string('x', 7)`.
  Any column that may receive `''` or free text must be a string, not `dateTime`.
- Keep every column, default, UNIQUE and index of the original schema (and columns added with `ALTER TABLE` in `migrate`).
- Foreign keys: only where the original had them.
- Table names stay the same (other modules query them).

The core tables (orders, order_items, products, customers, customer_flags, locations, stock_moves, lots, listings, returns, cs_calls,
expenses, price_changes, events, sync_log, settings, users, files) already exist in
`database/migrations/2026_10_12_000100_create_erp_core_tables.php`. Columns your module adds to a core table
(e.g. couriers adds `orders.bk_tracking`) go in your migration with `Schema::table(...)` guarded by `Schema::hasColumn`.

## Files (uploads)

`/api/files` is in the core. Stored files are referenced by id (string) as before.

## Demo / practice data

Keep demo generators (practice data) but they must only run when `$this->setting('demo')` is true, as in the original.
Never mark demo rows as Shopify data.

## Testing your module

The shell is Git Bash on Windows: **always `export MSYS_NO_PATHCONV=1`** before passing `/api/...` paths to PHP.
Use your own database so you do not disturb other people working in parallel:

```bash
cd /c/xampp2/htdocs/sundaybazaarErp
export MSYS_NO_PATHCONV=1 DB_DATABASE=sbtest_foo ERP_MODULES=Foo
/c/xampp2/mysql/bin/mysql -uroot -e "CREATE DATABASE IF NOT EXISTS sbtest_foo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
php artisan migrate:fresh --force \
  --path=database/migrations/0001_01_01_000000_create_users_table.php \
  --path=database/migrations/0001_01_01_000001_create_cache_table.php \
  --path=database/migrations/0001_01_01_000002_create_jobs_table.php \
  --path=database/migrations/2026_10_12_000100_create_erp_core_tables.php \
  --path=database/migrations/2026_10_12_0002NN_create_foo_tables.php
php artisan erp:install          # runs install() of the loaded modules (once it exists; otherwise call it via tools/erp-call.php)
php tools/erp-call.php GET /api/foo
php tools/erp-call.php POST /api/foo '{"a":1}'
php tools/erp-call.php --batch=/path/to/calls.txt    # many calls in one process
```

`ERP_MODULES=Foo,Bar` loads only those modules (+ Core). `--user=ID` calls as another user (create users with SQL; `perms` JSON list).
Exercise **every route** at least once with realistic data, including error paths, and check `storage/logs/laravel.log` for warnings
("Undefined array key", deprecations) — fix them. Run `php -l` on your files.
Do not run `migrate:fresh` on the main `sundaybazar_erp` database. Do not edit files outside your module + migration.
If you need something from the kernel or another module that does not exist yet, call it the documented way
(`$this->svc('accounts')?->post([...])`) and mention it in your final report.
