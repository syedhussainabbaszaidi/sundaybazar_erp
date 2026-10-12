# Testing — results and known limitations

## Automated tests (`php artisan test`)

**92 tests, all passing** (database `sundaybazar_erp_test`; the Shopify Admin API is **mocked** — no
request reaches the real store from the tests).

| Suite | Covers |
|---|---|
| `TwoWaySyncTest` | payment details & transactions (no duplicates), partial payments & refunds, delivery status from the Shopify fulfilment (in transit / delivered with time / not delivered / attempted), courier API taking priority, ERP courier update posted to the Shopify fulfilment **once** (and a status read from Shopify never sent back), *Fulfil in Shopify* without tracking + permission, *Refund in Shopify*: permission, typed confirmation, at most what was paid, request id against double sends, cash-on-delivery refused, **unknown outcome checked in Shopify before sending again**; minute clock syncs a new order without webhooks and not twice in a minute; webhook mode only for this installation's address; failed webhook retried; *Retry failed*; the removed sync rules |
| `ShopifySyncTest` | order import over pages without duplicates, incremental queries, ERP fields kept on re-sync, older versions ignored, fulfilments/refunds, >50 line items, products/variants/media/collections, sold-out/removed variants, resume after interruption (also when the first import's date filter moved on), customers, location stock, *Sync now* done by the minute clock without a queue worker |
| `ShopifyWebhookTest` | HMAC signature and shop checks, duplicate deliveries processed once, state fetched from the API, cancellation, fulfilment, order deletion flagged (not deleted), product update/delete, stock levels, app uninstalled, failed processing recorded |
| `ShopifyWriteTest` | an emergency-stopped write sends nothing, price update + audit row, per-variant errors, stock only to the chosen location, fulfilment created once & uncertain outcome checked, order cancel (permission + typed CANCEL + switch, real state read back), booked orders not cancellable, local price unchanged when Shopify refuses |
| `ShopifyClientTest` | client-credentials token + encrypted cache, renewal on 401, unknown Client ID explained, bad credentials (secret never shown), THROTTLED/429/5xx retries, scope errors, store identity, REST pagination |
| `DashboardAndDeploymentTest` | monthly money: placed, delivered, paid online, refunds (zero restock refunds excluded), courier owes, in transit, unpaid, each order once, cancelled and last month excluded; profit goal never invented; no secret in `public/`, `database.sql`, `.env*.example`, README or the guide; root `.htaccess` blocks private files; `database.sql` has every table; SPA routes & assets; snapshot needs the token; `erp:pull-production` imports and refuses on production |
| `AccessControlTest` | registration, login, approval, pages, roles, personal grants/revokes, no escalation, last super admin, admin bootstrap |
| `ApiSecurityTest` | setup key, lockout, 401/403, cross-site header, masking, secrets never sent to the browser, persistence, ids with slashes, security headers |

## Live checks on the Shopify store (read-only)

| Check | Result |
|---|---|
| Connection | `shopify:check`: sundaybazar (`sundaybazar-001.myshopify.com`, PKR, Asia/Karachi), 3 locations, no scope missing |
| Root cause "new orders don't appear" | confirmed: nothing ran the sync on this PC (only `php artisan serve` was running; no scheduler, no webhooks) |
| **New orders appear** | after one minute-clock run, Shopify's 5 newest orders (SB85457–SB85461, newest placed 13 minutes earlier) were all in the ERP with the same payment and fulfilment status |
| Order updates | incremental runs updated 39 and 57 changed orders |
| Payments | 6,205 transactions imported; received/outstanding amounts per order |
| Delivery status | read from the Shopify fulfilments (PostEx updates): 3,666 delivered, 571 returning, 522 in transit, 150 attempted, 46 out for delivery (before: all "dispatched") |
| Products / stock / customers | 26,336 products (= Shopify's count), 10,076 in stock (= Shopify's count), 83,717 stock levels, 70,000+ customers importing |
| Background start without a scheduler | the web app started `erp:tick` by itself (sync runs appeared while the ERP was open) |
| Live → local copy | `erp:pull-production --file` imported a 13 MB snapshot of the real data in 40 s, identical counts |
| Screens | all 66 screens rendered with real data (headless DOM), no script errors; Settings shows the new sync section and **no Rules section**; home shows this month's money; order drawer shows payments, transactions and Shopify actions |

## Interface (redesign) — checked in Chrome (headless, real data)

| Check | Result |
|---|---|
| All 55 menu screens at 1440, 1024, 768, 375 and 320 px | no script errors, no failed requests, no page-wide horizontal scroll, no content wider than the screen (two phone issues found and fixed: abandoned-cart items, multi-part table cells) |
| Login / registration at 1440 and 375 px | logo, Poppins, no overflow; empty submit shows the field message without sending anything |
| Phone menu | opens with ☰, closes after choosing a screen; search icon opens the search field |
| Profile menu, order drawer, alerts dialog | open and close with Esc (a bug that left the menu visible after Esc was found and fixed) |
| Collapsed side menu, dark theme | checked by screenshot |

Not checked: Safari/iOS and Firefox, real touch devices, screen readers.

## Not verified (needs the live server or a deliberate test)

- **Webhooks in real time**: need the public https address; registered and tested on the live server (guide §12, §19).
- **ERP → Shopify on the live store** (fulfil, cancel, refund, tags, prices, stock): tested only against the mocked API, because
  testing would change real customer orders. Try each once on a **test order / test product** after deployment (guide §19).
- **Profit "on track"**: needs the books started (opening balances in Accounts → Month close); not entered, as those are real figures.
- **Cron on the actual host**, `exec()` availability for the automatic start, and the hosting's PHP version: to check on the server.
- Visual check in real browsers (desktop and phone).

## Known limitations

- Orders older than 60 days need the `read_all_orders` scope.
- COD payouts are only known with the PostEx API connected or when marked in Finance → COD; until then the dashboard says
  "COD not marked received" instead of "Courier owes".
- The ERP does not create/delete Shopify products, collections or customers (managed in Shopify, synced to the ERP).
- The app must run at the root of its (sub)domain (guide §9).
