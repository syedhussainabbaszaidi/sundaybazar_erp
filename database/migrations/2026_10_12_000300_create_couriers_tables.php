<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Couriers module (legacy/server/modules/couriers.js): TCS cities, rider runs, cash handovers, PostEx cities, handover to courier, Shopify fulfilment log. */
return new class extends Migration
{
    /** Columns couriers.js added to the core `orders` table in migrate() */
    private function orderColumns(): array
    {
        return [
            'courier_status' => fn (Blueprint $t) => $t->string('courier_status', 255)->nullable(),
            'courier_updated' => fn (Blueprint $t) => $t->dateTime('courier_updated')->nullable(),
            'courier_history' => fn (Blueprint $t) => $t->mediumText('courier_history')->nullable(),
            'courier_cod' => fn (Blueprint $t) => $t->double('courier_cod')->nullable(),
            'courier_fee' => fn (Blueprint $t) => $t->double('courier_fee')->nullable(),
            'courier_paid' => fn (Blueprint $t) => $t->double('courier_paid')->nullable(),
            'courier_settled_at' => fn (Blueprint $t) => $t->string('courier_settled_at', 40)->nullable(),
            'rider_id' => fn (Blueprint $t) => $t->unsignedBigInteger('rider_id')->nullable(),
            'rider_run_id' => fn (Blueprint $t) => $t->unsignedBigInteger('rider_run_id')->nullable()->index('ix_orders_rider_run'),
            'bk_courier' => fn (Blueprint $t) => $t->string('bk_courier', 60)->nullable(),
            'bk_tracking' => fn (Blueprint $t) => $t->string('bk_tracking', 64)->nullable(),
            'bk_via' => fn (Blueprint $t) => $t->string('bk_via', 20)->nullable(),
            'city_code' => fn (Blueprint $t) => $t->string('city_code', 32)->nullable(),
        ];
    }

    public function up(): void
    {
        foreach ($this->orderColumns() as $col => $def) {
            if (! Schema::hasColumn('orders', $col)) {
                Schema::table('orders', function (Blueprint $t) use ($def) {
                    $def($t);
                });
            }
        }

        if (! Schema::hasTable('cr_tcs_cities')) {
            Schema::create('cr_tcs_cities', function (Blueprint $t) {
                $t->string('code', 32)->primary();
                $t->string('name', 191)->nullable();
                $t->string('norm', 191)->nullable()->index('ix_cr_cities_norm');
            });
        }

        if (! Schema::hasTable('cr_city_alias')) {
            Schema::create('cr_city_alias', function (Blueprint $t) {
                $t->string('city', 191)->primary();
                $t->string('code', 32)->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('cr_runs')) {
            Schema::create('cr_runs', function (Blueprint $t) {
                $t->id();
                $t->string('day', 10);
                $t->unsignedBigInteger('rider_id');
                $t->string('status', 16)->default('open');
                $t->text('note')->nullable();
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('out_at')->nullable();
                $t->dateTime('closed_at')->nullable();
                $t->index(['rider_id', 'day'], 'ix_cr_runs_rider');
            });
        }

        if (! Schema::hasTable('cr_run_items')) {
            Schema::create('cr_run_items', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('run_id');
                $t->string('order_id', 64);
                $t->integer('seq')->nullable();
                $t->double('cod')->nullable()->default(0);
                $t->string('result', 16)->nullable();
                $t->double('collected')->nullable();
                $t->string('reason', 32)->nullable();
                $t->text('note')->nullable();
                $t->string('resched_to', 10)->nullable();
                $t->dateTime('at')->nullable();
                $t->unsignedBigInteger('by_user')->nullable();
                $t->string('back', 16)->nullable();
                $t->dateTime('back_at')->nullable();
                $t->unsignedBigInteger('back_by')->nullable();
                $t->unique(['run_id', 'order_id']);
                $t->index('order_id', 'ix_cr_items_order');
                $t->foreign('run_id')->references('id')->on('cr_runs')->cascadeOnDelete();
            });
        }

        if (! Schema::hasTable('cr_handovers')) {
            Schema::create('cr_handovers', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('run_id')->nullable()->unique();
                $t->unsignedBigInteger('rider_id')->nullable();
                $t->string('day', 10)->nullable();
                $t->double('expected')->nullable();
                $t->double('counted')->nullable();
                $t->double('diff')->nullable();
                $t->string('treat', 16)->nullable();
                $t->text('note')->nullable();
                $t->unsignedBigInteger('journal_id')->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('cr_px_cities')) {
            Schema::create('cr_px_cities', function (Blueprint $t) {
                $t->string('name', 191)->primary();
                $t->string('norm', 191)->nullable()->index('ix_cr_px_norm');
                $t->boolean('delivery')->nullable()->default(true);
                $t->boolean('pickup')->nullable()->default(true);
            });
        }

        if (! Schema::hasTable('cr_px_alias')) {
            Schema::create('cr_px_alias', function (Blueprint $t) {
                $t->string('city', 191)->primary();
                $t->string('name', 191)->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('cr_handed')) {
            Schema::create('cr_handed', function (Blueprint $t) {
                $t->string('order_id', 64)->primary();
                $t->string('courier', 60)->nullable();
                $t->string('tracking', 64)->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->unsignedBigInteger('user_id')->nullable();
            });
        }

        if (! Schema::hasTable('cr_fulfil')) {
            Schema::create('cr_fulfil', function (Blueprint $t) {
                $t->string('order_id', 64)->primary();
                $t->string('tracking', 64)->nullable();
                $t->string('courier', 60)->nullable();
                $t->boolean('ok')->nullable();
                $t->text('error')->nullable();
                $t->string('fulfillment_id', 191)->nullable();
                $t->dateTime('at')->nullable();
            });
        }

        if (! Schema::hasTable('cr_rider_fees')) {
            Schema::create('cr_rider_fees', function (Blueprint $t) {
                $t->string('month', 7);
                $t->unsignedBigInteger('rider_id');
                $t->integer('deliveries')->nullable();
                $t->double('rate')->nullable();
                $t->double('amount')->nullable();
                $t->unsignedBigInteger('journal_id')->nullable();
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable()->useCurrent();
                $t->primary(['month', 'rider_id']);
            });
        }
    }

    public function down(): void
    {
        foreach (['cr_rider_fees', 'cr_fulfil', 'cr_handed', 'cr_px_alias', 'cr_px_cities', 'cr_handovers', 'cr_run_items', 'cr_runs', 'cr_city_alias', 'cr_tcs_cities'] as $t) {
            Schema::dropIfExists($t);
        }
        if (Schema::hasColumn('orders', 'rider_run_id')) {
            Schema::table('orders', fn (Blueprint $t) => $t->dropIndex('ix_orders_rider_run'));
        }
        $cols = array_values(array_filter(array_keys($this->orderColumns()), fn ($c) => Schema::hasColumn('orders', $c)));
        if ($cols) {
            Schema::table('orders', fn (Blueprint $t) => $t->dropColumn($cols));
        }
    }
};
