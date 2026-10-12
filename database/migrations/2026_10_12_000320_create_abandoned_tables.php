<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Shopify abandoned checkouts (ported from modules/abandoned.js). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ab_checkouts', function (Blueprint $t) {
            $t->string('id', 64)->primary();               // Shopify checkout id (or demo-N)
            $t->string('token', 191)->nullable()->index();
            $t->string('cart_token', 191)->nullable();
            $t->dateTime('created_at')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->dateTime('completed_at')->nullable();
            $t->string('name', 255)->nullable();
            $t->string('phone', 32)->nullable()->index();
            $t->string('email', 191)->nullable();
            $t->string('city', 120)->nullable();
            $t->mediumText('items')->nullable();            // JSON
            $t->double('total')->nullable()->default(0);
            $t->text('url')->nullable();
            $t->string('status', 16)->nullable()->default('new'); // new, contacted, recovered, completed, lost
            $t->unsignedBigInteger('contacted_by')->nullable();
            $t->dateTime('contacted_at')->nullable();
            $t->integer('contacts')->nullable()->default(0);
            $t->string('last_outcome', 32)->nullable();
            $t->text('note')->nullable();
            $t->string('recovered_order', 64)->nullable();
            $t->string('recovered_name', 64)->nullable();
            $t->double('recovered_value')->nullable();
            $t->dateTime('recovered_at')->nullable();
            $t->unsignedBigInteger('recovered_by')->nullable();
            $t->string('recovered_how', 120)->nullable();
            $t->string('lost_reason', 191)->nullable();
            $t->dateTime('lost_at')->nullable();
            $t->unsignedBigInteger('lost_by')->nullable();
            $t->string('src', 16)->nullable();
            $t->dateTime('ingested_at')->nullable()->useCurrent();
            $t->index(['status', 'updated_at'], 'ix_ab_status');
        });

        Schema::create('ab_events', function (Blueprint $t) {
            $t->id();
            $t->string('checkout_id', 64)->nullable()->index('ix_ab_ev');
            $t->unsignedBigInteger('user_id')->nullable();
            $t->string('kind', 20)->nullable();
            $t->string('outcome', 32)->nullable();
            $t->text('note')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('ab_orders', function (Blueprint $t) {
            $t->string('id', 64)->primary();               // Shopify order GID
            $t->string('name', 64)->nullable();
            $t->string('checkout_token', 191)->nullable()->index('ix_ab_orders_tok');
            $t->string('cart_token', 191)->nullable();
            $t->string('phone', 32)->nullable();
            $t->string('email', 191)->nullable();
            $t->double('total')->nullable();
            $t->dateTime('created_at')->nullable();
        });
    }

    public function down(): void
    {
        foreach (['ab_orders', 'ab_events', 'ab_checkouts'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
