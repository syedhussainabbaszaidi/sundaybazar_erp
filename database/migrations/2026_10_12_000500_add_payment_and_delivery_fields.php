<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Payment details and Shopify delivery status:
 *  - orders.received / outstanding / net_payment: Shopify totalReceived / totalOutstanding / netPayment
 *  - orders.sh_ship_status / sh_ship_at: delivery status of the order's shipment as Shopify reports it
 *    (courier apps such as PostEx post DELIVERED / IN_TRANSIT / ATTEMPTED_DELIVERY / NOT_DELIVERED events)
 *  - order_fulfillments.display_status / delivered_at / in_transit_at
 *  - order_transactions: every payment transaction (sale, capture, refund, void …) keyed by Shopify id
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('orders', function (Blueprint $t) {
            if (! Schema::hasColumn('orders', 'received')) {
                $t->double('received')->nullable()->after('total_refunded');
                $t->double('outstanding')->nullable()->after('received');
                $t->double('net_payment')->nullable()->after('outstanding');
                $t->string('sh_ship_status', 30)->nullable()->after('fulfillment');
                $t->dateTime('sh_ship_at')->nullable()->after('sh_ship_status');
                $t->index('financial');
                $t->index('delivered_at');
            }
        });
        Schema::table('order_fulfillments', function (Blueprint $t) {
            if (! Schema::hasColumn('order_fulfillments', 'display_status')) {
                $t->string('display_status', 30)->nullable()->after('status');
                $t->dateTime('delivered_at')->nullable()->after('tracking_url');
                $t->dateTime('in_transit_at')->nullable()->after('delivered_at');
            }
        });
        if (! Schema::hasTable('order_transactions')) {
            Schema::create('order_transactions', function (Blueprint $t) {
                $t->string('id', 64)->primary();           // Shopify transaction GID (no duplicates)
                $t->string('order_id', 64)->index();
                $t->string('kind', 20);                    // SALE, CAPTURE, AUTHORIZATION, REFUND, VOID, CHANGE, EMV_AUTHORIZATION, SUGGESTED_REFUND
                $t->string('status', 20);                  // SUCCESS, PENDING, FAILURE, ERROR, AWAITING_RESPONSE, UNKNOWN
                $t->string('gateway', 120)->nullable();
                $t->double('amount')->default(0);
                $t->string('currency', 8)->nullable();
                $t->dateTime('processed_at')->nullable()->index();
                $t->foreign('order_id')->references('id')->on('orders')->cascadeOnDelete();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('order_transactions');
        Schema::table('order_fulfillments', fn (Blueprint $t) => $t->dropColumn(['display_status', 'delivered_at', 'in_transit_at']));
        Schema::table('orders', function (Blueprint $t) {
            $t->dropIndex(['financial']);
            $t->dropIndex(['delivered_at']);
            $t->dropColumn(['received', 'outstanding', 'net_payment', 'sh_ship_status', 'sh_ship_at']);
        });
    }
};
