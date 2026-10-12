<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Core ERP tables (ported from the original lib/db.js schema).
 * Timestamps are DATETIME in UTC; "day" values are 'YYYY-MM-DD' strings.
 * Shopify objects keep their GraphQL global IDs (gid://shopify/...) as keys so
 * repeated imports update the same rows instead of creating duplicates.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('settings', function (Blueprint $t) {
            $t->string('key', 191)->primary();
            $t->longText('value')->nullable();
        });

        Schema::create('orders', function (Blueprint $t) {
            $t->string('id', 64)->primary();            // Shopify order GID
            $t->string('name', 64)->nullable()->index(); // #1001
            $t->dateTime('created_at')->nullable()->index();
            $t->dateTime('updated_at')->nullable();      // Shopify updatedAt (used to ignore out-of-order webhooks)
            $t->string('customer_id', 64)->nullable()->index();
            $t->string('phone', 32)->nullable()->index();
            $t->string('cust_name', 191)->nullable();
            $t->string('city', 120)->nullable();
            $t->text('address')->nullable();
            $t->double('total')->default(0);
            $t->double('shipping')->default(0);
            $t->double('discount')->default(0);
            $t->integer('items')->default(0);
            $t->string('gateway', 191)->nullable();
            $t->string('financial', 40)->nullable();     // Shopify displayFinancialStatus
            $t->string('fulfillment', 40)->nullable();   // Shopify displayFulfillmentStatus
            $t->text('tags')->nullable();
            $t->text('note')->nullable();
            $t->dateTime('cancelled_at')->nullable();
            $t->string('source', 60)->nullable();
            $t->string('tracking', 64)->nullable()->index();
            $t->string('courier', 60)->nullable();
            $t->string('stage', 24)->default('new');     // manual ERP stage
            $t->string('status', 24)->default('new')->index(); // derived ERP status shown everywhere
            $t->integer('cs_attempts')->default(0);
            $t->text('cs_note')->nullable();
            $t->unsignedBigInteger('cs_by')->nullable();
            $t->dateTime('cs_at')->nullable();
            $t->dateTime('cs_next')->nullable();
            $t->dateTime('picked_at')->nullable();
            $t->dateTime('packed_at')->nullable();
            $t->dateTime('dispatched_at')->nullable()->index();
            $t->dateTime('delivered_at')->nullable();
            $t->dateTime('returned_at')->nullable();
            $t->dateTime('return_received_at')->nullable();
            $t->string('px_status', 160)->nullable();
            $t->string('px_updated', 40)->nullable();
            $t->mediumText('px_history')->nullable();
            $t->double('cod')->nullable();
            $t->double('px_fee')->nullable();
            $t->double('px_tax')->nullable();
            $t->double('px_rev_fee')->nullable();
            $t->double('px_rev_tax')->nullable();
            $t->boolean('settled')->default(false);
            $t->string('settled_at', 40)->nullable();
            $t->string('settle_ref', 120)->nullable();
            $t->boolean('missing')->default(false);
            $t->unsignedBigInteger('assigned_to')->nullable();
            // Shopify details kept separately from the ERP stage/status
            $t->string('currency', 8)->nullable();
            $t->double('subtotal')->nullable();
            $t->double('total_tax')->nullable();
            $t->double('total_refunded')->nullable();
            $t->string('cancel_reason', 40)->nullable();
            $t->dateTime('closed_at')->nullable();
            $t->string('email', 191)->nullable();
            $t->dateTime('synced_at')->nullable();
        });

        Schema::create('order_items', function (Blueprint $t) {
            $t->id();
            $t->string('order_id', 64)->index();
            $t->string('line_item_id', 64)->nullable();
            $t->string('sku', 120)->nullable()->index();
            $t->string('title', 500)->nullable();
            $t->integer('qty')->nullable();
            $t->double('price')->nullable();
            $t->string('variant_id', 64)->nullable()->index();
            $t->string('product_id', 64)->nullable();
            $t->boolean('picked')->default(false);
            $t->unsignedBigInteger('picked_by')->nullable();
            $t->dateTime('picked_at')->nullable();
            $t->foreign('order_id')->references('id')->on('orders')->cascadeOnDelete();
        });

        Schema::create('order_fulfillments', function (Blueprint $t) {
            $t->string('id', 64)->primary();             // Shopify fulfillment GID
            $t->string('order_id', 64)->index();
            $t->string('status', 30)->nullable();
            $t->string('tracking_number', 120)->nullable()->index();
            $t->string('tracking_company', 120)->nullable();
            $t->text('tracking_url')->nullable();
            $t->string('location_id', 64)->nullable();
            $t->dateTime('created_at')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->foreign('order_id')->references('id')->on('orders')->cascadeOnDelete();
        });

        Schema::create('order_refunds', function (Blueprint $t) {
            $t->string('id', 64)->primary();             // Shopify refund GID
            $t->string('order_id', 64)->index();
            $t->double('amount')->default(0);
            $t->text('note')->nullable();
            $t->dateTime('created_at')->nullable();
            $t->foreign('order_id')->references('id')->on('orders')->cascadeOnDelete();
        });

        Schema::create('customer_flags', function (Blueprint $t) {
            $t->string('phone', 32)->primary();
            $t->boolean('blacklist')->default(false);
            $t->boolean('vip')->default(false);
            $t->text('note')->nullable();
            $t->dateTime('updated_at')->nullable();
        });

        // ERP customer view: one row per phone number, rebuilt from orders (Logic::recomputeCustomers)
        Schema::create('customers', function (Blueprint $t) {
            $t->string('phone', 32)->primary();
            $t->string('name', 191)->nullable();
            $t->string('city', 120)->nullable();
            $t->integer('orders')->default(0);
            $t->integer('delivered')->default(0);
            $t->integer('returned')->default(0);
            $t->integer('cancelled')->default(0);
            $t->integer('open')->default(0);
            $t->double('spent')->default(0);
            $t->dateTime('first_order')->nullable();
            $t->dateTime('last_order')->nullable()->index();
            $t->integer('score')->nullable();
            $t->string('label', 20)->nullable()->index();
        });

        // Shopify customer records (only filled when the app has protected customer data access)
        Schema::create('shopify_customers', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('first_name', 120)->nullable();
            $t->string('last_name', 120)->nullable();
            $t->string('email', 191)->nullable()->index();
            $t->string('phone', 32)->nullable()->index();   // normalised (03xx...)
            $t->integer('orders_count')->default(0);
            $t->double('amount_spent')->default(0);
            $t->string('state', 20)->nullable();
            $t->text('tags')->nullable();
            $t->string('city', 120)->nullable();
            $t->string('province', 120)->nullable();
            $t->dateTime('created_at')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->dateTime('synced_at')->nullable();
        });

        // Shopify products (product level); variants live in `products` (one row per variant, as in the original ERP)
        Schema::create('shopify_products', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('title', 500)->nullable();
            $t->string('handle', 255)->nullable()->index();
            $t->string('status', 20)->nullable()->index();
            $t->string('vendor', 191)->nullable();
            $t->string('product_type', 191)->nullable();
            $t->text('tags')->nullable();
            $t->mediumText('description_html')->nullable();
            $t->text('image')->nullable();
            $t->integer('total_inventory')->nullable();
            $t->integer('variants_count')->default(0);
            $t->dateTime('created_at')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->dateTime('deleted_at')->nullable();      // product deleted in Shopify
            $t->dateTime('synced_at')->nullable();
        });

        Schema::create('products', function (Blueprint $t) {
            $t->string('variant_id', 64)->primary();
            $t->string('product_id', 64)->nullable()->index();
            $t->string('title', 500)->nullable();
            $t->string('variant_title', 255)->nullable();
            $t->string('sku', 120)->nullable()->index();
            $t->string('barcode', 64)->nullable();
            $t->string('rack', 40)->nullable()->index();
            $t->string('category', 40)->nullable();
            $t->double('price')->nullable();
            $t->double('compare_at')->nullable();
            $t->double('cost')->nullable();
            $t->integer('qty')->default(0);              // Shopify inventoryQuantity (all locations)
            $t->string('status', 20)->nullable();        // ACTIVE / DRAFT / ARCHIVED / DELETED
            $t->dateTime('created_at')->nullable()->index();
            $t->dateTime('updated_at')->nullable();
            $t->text('tags')->nullable();
            $t->string('lot', 120)->nullable()->index();
            $t->string('brand', 191)->nullable();
            $t->string('ptype', 191)->nullable();
            $t->string('size', 60)->nullable();
            $t->string('cond', 60)->nullable();
            $t->text('image')->nullable();
            $t->string('handle', 255)->nullable();
            $t->string('inventory_item', 64)->nullable()->index();
            $t->string('location', 64)->nullable();
            $t->text('options')->nullable();             // JSON [{name,value}]
            $t->dateTime('sold_at')->nullable();
            $t->dateTime('synced_at')->nullable();
        });

        Schema::create('product_media', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('product_id', 64)->index();
            $t->text('url')->nullable();
            $t->string('alt', 500)->nullable();
            $t->integer('position')->default(0);
        });

        Schema::create('shopify_collections', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('title', 255)->nullable();
            $t->string('handle', 255)->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->dateTime('synced_at')->nullable();
        });

        Schema::create('collection_product', function (Blueprint $t) {
            $t->string('collection_id', 64);
            $t->string('product_id', 64)->index();
            $t->primary(['collection_id', 'product_id']);
        });

        Schema::create('shopify_locations', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('name', 191);
            $t->boolean('is_active')->default(true);
            $t->boolean('fulfills_online')->default(false);
            $t->string('city', 120)->nullable();
            $t->dateTime('synced_at')->nullable();
        });

        // Location-level stock (Shopify inventory levels). Not the same as products.qty (sum over locations).
        Schema::create('inventory_levels', function (Blueprint $t) {
            $t->string('inventory_item_id', 64);
            $t->string('location_id', 64)->index();
            $t->integer('available')->nullable();
            $t->integer('on_hand')->nullable();
            $t->integer('committed')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->dateTime('synced_at')->nullable();
            $t->primary(['inventory_item_id', 'location_id']);
        });

        // Rack / bin location of a SKU inside the warehouse (ERP-only data)
        Schema::create('locations', function (Blueprint $t) {
            $t->string('sku', 120)->primary();
            $t->string('location', 60)->nullable()->index();
            $t->dateTime('updated_at')->nullable();
            $t->unsignedBigInteger('updated_by')->nullable();
        });

        Schema::create('stock_moves', function (Blueprint $t) {
            $t->id();
            $t->string('sku', 120)->nullable()->index();
            $t->string('from_loc', 60)->nullable();
            $t->string('to_loc', 60)->nullable();
            $t->string('reason', 191)->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->useCurrent()->index();
        });

        Schema::create('lots', function (Blueprint $t) {
            $t->string('name', 120)->primary();
            $t->string('vendor', 191)->nullable();
            $t->string('bought_on', 10)->nullable();
            $t->double('cost')->nullable();
            $t->integer('pieces')->nullable();
            $t->text('note')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->string('kind', 20)->nullable();
            $t->double('extra')->nullable();
            $t->integer('bad')->nullable();
            $t->double('per_piece')->nullable();
            $t->double('cpv')->nullable();
            $t->mediumText('comp')->nullable();
        });

        Schema::create('listings', function (Blueprint $t) {
            $t->string('sku', 120)->primary();
            $t->integer('serial')->nullable()->index();
            $t->string('letter', 8)->nullable();
            $t->string('grp', 40)->nullable();
            $t->string('lot', 120)->nullable()->index();
            $t->string('gender', 20)->nullable();
            $t->string('type', 60)->nullable();
            $t->string('brand', 120)->nullable();
            $t->string('size', 20)->nullable();
            $t->string('color', 40)->nullable();
            $t->string('cond', 40)->nullable();
            $t->string('material', 60)->nullable();
            $t->text('note')->nullable();
            $t->string('title', 500)->nullable();
            $t->double('price')->nullable();
            $t->double('market')->nullable();
            $t->double('floor')->nullable();
            $t->double('cost')->nullable();
            $t->unsignedBigInteger('user_id')->nullable()->index();
            $t->dateTime('at')->useCurrent();
            $t->boolean('exported')->default(false);
            $t->dateTime('exported_at')->nullable();
        });

        Schema::create('returns', function (Blueprint $t) {
            $t->id();
            $t->string('order_id', 64)->nullable()->index();
            $t->string('sku', 120)->nullable();
            $t->string('cond', 40)->nullable();
            $t->boolean('restocked')->default(false);
            $t->string('location', 60)->nullable();
            $t->text('note')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->useCurrent();
        });

        Schema::create('cs_calls', function (Blueprint $t) {
            $t->id();
            $t->string('order_id', 64)->nullable()->index();
            $t->unsignedBigInteger('user_id')->nullable()->index();
            $t->string('outcome', 40)->nullable();
            $t->text('note')->nullable();
            $t->dateTime('at')->useCurrent()->index();
        });

        Schema::create('expenses', function (Blueprint $t) {
            $t->id();
            $t->string('day', 10)->nullable()->index();
            $t->string('category', 120)->nullable();
            $t->double('amount')->nullable();
            $t->text('note')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->useCurrent();
        });

        Schema::create('price_changes', function (Blueprint $t) {
            $t->id();
            $t->string('variant_id', 64)->nullable()->index();
            $t->string('sku', 120)->nullable();
            $t->double('old_price')->nullable();
            $t->double('new_price')->nullable();
            $t->double('compare_at')->nullable();
            $t->string('reason', 191)->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->boolean('pushed')->default(false);
            $t->text('error')->nullable();
            $t->dateTime('at')->useCurrent();
        });

        Schema::create('events', function (Blueprint $t) {
            $t->id();
            $t->dateTime('at')->useCurrent()->index();
            $t->unsignedBigInteger('user_id')->nullable()->index();
            $t->string('action', 120)->nullable()->index();
            $t->string('entity', 191)->nullable()->index();
            $t->mediumText('detail')->nullable();
        });

        Schema::create('sync_log', function (Blueprint $t) {
            $t->id();
            $t->dateTime('at')->useCurrent();
            $t->string('kind', 80)->nullable()->index();
            $t->boolean('ok')->default(true);
            $t->text('message')->nullable();
        });

        // Uploaded receipts / photos / documents. The bytes live on disk (storage/app/private/erp-files).
        Schema::create('files', function (Blueprint $t) {
            $t->string('id', 32)->primary();
            $t->string('name', 191)->nullable();
            $t->string('type', 80)->nullable();
            $t->integer('size')->default(0);
            $t->string('path', 255);
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->useCurrent();
        });

        /* ---------------- Shopify integration bookkeeping ---------------- */

        // Every webhook delivery, keyed by X-Shopify-Webhook-Id so a re-delivery is processed only once
        Schema::create('webhook_events', function (Blueprint $t) {
            $t->id();
            $t->string('webhook_id', 100)->unique();
            $t->string('topic', 80)->index();
            $t->string('shop_domain', 191)->nullable();
            $t->string('resource_id', 64)->nullable()->index();
            $t->string('api_version', 20)->nullable();
            $t->mediumText('payload')->nullable();
            $t->string('status', 20)->default('received')->index(); // received, done, skipped, failed
            $t->unsignedInteger('attempts')->default(0);
            $t->text('error')->nullable();
            $t->dateTime('triggered_at')->nullable();
            $t->dateTime('received_at')->useCurrent();
            $t->dateTime('processed_at')->nullable();
        });

        // Import / sync runs with resumable cursor (checkpoint saved after every page)
        Schema::create('sync_runs', function (Blueprint $t) {
            $t->id();
            $t->string('kind', 40)->index();             // orders, products, customers, inventory, locations, postex, ...
            $t->string('mode', 20)->default('incremental'); // initial, incremental, reconcile
            $t->string('status', 20)->default('running')->index(); // running, done, failed
            $t->text('query')->nullable();
            $t->text('cursor')->nullable();
            $t->unsignedInteger('items')->default(0);
            $t->unsignedInteger('pages')->default(0);
            $t->text('error')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('started_at')->useCurrent();
            $t->dateTime('finished_at')->nullable();
        });

        // Every ERP -> Shopify write with what was sent and what Shopify answered
        Schema::create('shopify_writes', function (Blueprint $t) {
            $t->id();
            $t->string('kind', 40)->index();             // price, inventory, tags, fulfillment, fulfillment_cancel, order_cancel
            $t->string('target_id', 64)->nullable()->index();
            $t->string('idempotency_key', 120)->nullable()->unique();
            $t->mediumText('request')->nullable();
            $t->mediumText('response')->nullable();
            $t->string('status', 20)->default('pending'); // pending, ok, failed, unknown
            $t->text('error')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->useCurrent()->index();
        });

        // Things the sync could not decide safely; shown for review instead of guessing
        Schema::create('sync_issues', function (Blueprint $t) {
            $t->id();
            $t->string('kind', 40)->index();             // conflict, write_failed, missing_scope, mismatch
            $t->string('entity', 40)->nullable();
            $t->string('entity_id', 64)->nullable()->index();
            $t->text('message');
            $t->mediumText('detail')->nullable();
            $t->string('status', 20)->default('open')->index(); // open, resolved
            $t->unsignedBigInteger('resolved_by')->nullable();
            $t->dateTime('resolved_at')->nullable();
            $t->dateTime('at')->useCurrent();
        });
    }

    public function down(): void
    {
        foreach (['sync_issues', 'shopify_writes', 'sync_runs', 'webhook_events', 'files', 'sync_log', 'events', 'price_changes', 'expenses', 'cs_calls', 'returns',
            'listings', 'lots', 'stock_moves', 'locations', 'inventory_levels', 'shopify_locations', 'collection_product', 'shopify_collections', 'product_media',
            'products', 'shopify_products', 'shopify_customers', 'customers', 'customer_flags', 'order_refunds', 'order_fulfillments', 'order_items', 'orders', 'settings'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
