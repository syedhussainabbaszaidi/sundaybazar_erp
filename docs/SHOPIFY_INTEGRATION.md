# Shopify integration — how it works

## How changes travel

- **Shopify → ERP**: webhooks (live server) apply a change seconds after Shopify sends it; the minute clock (`erp:tick`) also
  asks Shopify for anything changed since the last sync — every minute without webhooks, every 10–60 minutes as a safety net with
  them — and a daily reconcile compares Shopify with the ERP.
- **ERP → Shopify**: every action calls the Admin API, waits for Shopify's answer, records it in `shopify_writes` (who, what,
  request, answer, accepted?) and then re-reads the order so the screen shows Shopify's confirmed state.
- **No background programs to keep alive**: one cron entry runs the clock; if it is missing the web app starts the clock itself.

## Components

| File | Role |
|---|---|
| `app/Services/Shopify/ShopifyClient.php` | token (client credentials, cached encrypted, renewed), GraphQL with retries, throttling, scope detection; REST GET for abandoned checkouts |
| `app/Services/Shopify/ShopifySync.php` | Shopify → ERP import: orders (+ line items, fulfilments, refunds), products (+ variants, media, collections), customers, locations, location-level stock; resumable pagination |
| `app/Services/Shopify/ShopifyWriter.php` | every ERP → Shopify change: tags, prices, inventory, fulfilments, order cancel; switches, audit, idempotency |
| `app/Services/Shopify/WebhookVerifier.php` / `WebhookProcessor.php` | HMAC check; applying stored webhook events |
| `app/Services/Shopify/Reconciler.php` | nightly safety net: missing/stale records, count comparison, failed webhooks |
| `app/Services/Shopify/SyncRunner.php`, `app/Jobs/RunSync.php` | "Sync now" and scheduled runs, one at a time (lock), progress for every browser |
| `app/Services/Shopify/ShopifyStatus.php` | connection status, alerts, review queue (`sync_issues`) |
| `app/Erp/Modules/ShopifyModule.php` | API: webhook intake, status, register webhooks, issues, write log, refresh / cancel order |

## Data model

- `orders` — key = Shopify order GID (`gid://shopify/Order/…`). Shopify fields and ERP fields side by side.
- `order_items` (line items), `order_fulfillments` (tracking), `order_refunds`.
- `shopify_products` (product level) and `products` (one row per **variant**, key = variant GID, with the ERP's rack/lot/condition).
- `product_media`, `shopify_collections`, `collection_product`.
- `shopify_locations`, `inventory_levels` (stock per inventory item **per location** — `products.qty` is Shopify's total `inventoryQuantity` and is never used as a per-location number).
- `shopify_customers` (Shopify customer records) and `customers` (ERP view per phone number, rebuilt from orders).
- `webhook_events`, `sync_runs`, `shopify_writes`, `sync_issues`, `sync_log`, `events` (audit).

Upserts are keyed on Shopify GIDs (`INSERT … ON DUPLICATE KEY UPDATE`), so imports, webhooks and reconciliation
can all touch the same record any number of times without duplicates.

## Field ownership

| Data | Owner | Notes |
|---|---|---|
| Order totals, discounts, tax, shipping, currency, payment (financial) status, amounts received/outstanding, payment transactions, fulfilment status, cancellation, tags, note, customer & address, line items, fulfilments, refunds | **Shopify** | ERP copies them; never edited locally. Payment status is never set from the ERP |
| Delivery status (in transit / out for delivery / attempted / delivered / not delivered) | **Courier**: PostEx API, TCS or own rider when connected in the ERP; otherwise the courier updates on the Shopify fulfilment (PostEx's Shopify integration) | changes that come from the ERP's own courier data are posted to the Shopify fulfilment as events; changes read from Shopify are never sent back |
| Refunds of online payments | **Shopify**, can be *requested* from the ERP | *Refund in Shopify* (typed REFUND, `orders_refund` permission, at most what Shopify received, request id against double sends) |
| Order stage (new/hold/confirmed/picked/packed/cs_cancelled), confirmation calls, pick/pack progress | **ERP** | never sent to Shopify, never overwritten by imports. The "Cancel order" stage is ERP-only; the drawer says so and shows Shopify's state separately |
| Courier booking (`bk_*`), PostEx/TCS/rider status, COD, settlement | **ERP** (from the couriers) | a Shopify re-sync without a fulfilment keeps the ERP booking |
| Shopify order cancellation | **Shopify**, can be *requested* from the ERP | "Cancel in Shopify…" (switch + typed confirmation); the ERP then reads the real state back |
| Fulfilment in Shopify | ERP **creates** it when a courier booking is made (switch) | idempotent per order+tracking |
| Product title, status (active/draft/archived/deleted), price, compare-at, cost, SKU, media | **Shopify** | |
| Markdown prices | ERP **proposes**, owner applies (`pricing_apply` permission + switch) | local price changes only after Shopify accepted |
| Stock quantities | **Shopify** | ERP sends only adjustments (+1 for a good return) to the chosen location (switch) |
| Rack locations, lots, listings, WMS slots | **ERP** | not in Shopify |

## Conflicts and loops

- Every Shopify record carries `updatedAt`. An import/webhook with an **older** `updatedAt` than the stored one is ignored (late or out-of-order delivery).
- Webhook bodies are only a signal: the processor **fetches the current record** from the Admin API, so duplicates and re-orders are harmless.
- Incoming processing **never writes to Shopify**, so an ERP change → Shopify webhook → ERP update cannot loop.
- A deleted Shopify order is **not** deleted from the ERP (it may carry calls, picking, courier, COD): it is flagged in **Settings → Shopify → Needs review**.
- Counts that differ between Shopify and the ERP after reconciliation are flagged, not "fixed" by guessing.

## Irreversible operations

- Fulfilment creation: idempotency key `fulfill:<order>:<tracking>`. A network timeout leaves status `unknown`; the next attempt first **looks in Shopify** for a fulfilment with that tracking number and only sends again if there is none.
- Order cancellation: one per order; the current Shopify state is checked first; asks for typed `CANCEL`; no refund is issued (refunds are done in Shopify); orders with a courier booking cannot be cancelled from the ERP.
- Nothing irreversible is retried automatically by queue retries (fulfilment/cancel requests are not queued jobs).

## Rate limits and failures

- GraphQL cost: after each call the client waits when fewer than 300 points are left (restore rate from the response).
- `THROTTLED`, HTTP 429 (honours `Retry-After`) and 5xx are retried with back-off; network errors are retried.
- 401: token renewed once. 403 / `ACCESS_DENIED`: reported as a missing permission (e.g. customers without protected-data access: skipped with a review note, the rest keeps working).
- A failed import keeps its cursor; the next run resumes. Failed webhook events are retried by the queue (5 tries) and again by the nightly reconcile.
