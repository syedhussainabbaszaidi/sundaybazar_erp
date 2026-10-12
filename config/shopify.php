<?php

return [
    // Admin API host: the *.myshopify.com domain (the storefront www.sundaybazar.com.pk is NOT the API host)
    'shop' => env('SHOPIFY_STORE_DOMAIN', ''),
    'client_id' => env('SHOPIFY_CLIENT_ID', ''),
    'client_secret' => env('SHOPIFY_CLIENT_SECRET', ''),
    // optional fixed token (legacy custom app "shpat_..."); when empty the client-credentials grant is used
    'access_token' => env('SHOPIFY_ACCESS_TOKEN', ''),
    'webhook_secret' => env('SHOPIFY_WEBHOOK_SECRET', ''),
    // public https address Shopify sends webhooks to (default: APP_URL)
    'webhook_url' => env('SHOPIFY_WEBHOOK_URL', ''),
    'api_version' => env('SHOPIFY_API_VERSION', '2025-10'),
    // for tests / a local mock server
    'base_url' => env('SHOPIFY_BASE_URL', ''),
    'timeout' => (int) env('SHOPIFY_TIMEOUT', 30),

    // ERP -> Shopify updates (two-way sync). On by default, as in the original ERP; each can be switched off in .env
    // as an emergency stop without touching code. Staff still need the matching permission for each action.
    'write' => [
        'prices' => (bool) env('SHOPIFY_WRITE_PRICES', true),
        'inventory' => (bool) env('SHOPIFY_WRITE_INVENTORY', true),
        'fulfillments' => (bool) env('SHOPIFY_WRITE_FULFILLMENTS', true),
        'tags' => (bool) env('SHOPIFY_WRITE_TAGS', true),
        'order_cancel' => (bool) env('SHOPIFY_WRITE_ORDER_CANCEL', true),
        'refunds' => (bool) env('SHOPIFY_WRITE_REFUNDS', true),
    ],

    // webhook topics this ERP subscribes to (GraphQL WebhookSubscriptionTopic enum values)
    'webhook_topics' => [
        'ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'ORDERS_FULFILLED', 'ORDERS_PARTIALLY_FULFILLED', 'ORDERS_PAID', 'ORDERS_DELETE',
        'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'REFUNDS_CREATE',
        'PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE',
        'INVENTORY_LEVELS_UPDATE', 'INVENTORY_ITEMS_UPDATE',
        'CUSTOMERS_CREATE', 'CUSTOMERS_UPDATE',
        'LOCATIONS_CREATE', 'LOCATIONS_UPDATE',
        'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE',
        'APP_UNINSTALLED',
    ],

    // scopes the full feature set needs (checked against the installed app's grants)
    'scopes' => [
        'read_products', 'write_products', 'read_orders', 'write_orders', 'read_inventory', 'write_inventory', 'read_locations',
        'read_customers', 'read_fulfillments', 'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders',
        'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
    ],
];
