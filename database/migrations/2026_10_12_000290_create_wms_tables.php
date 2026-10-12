<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * WMS — warehouse control (port of modules/wms.js schema):
 * rack slots, receiving (GRN), stock counts, missing list, damage register, transfers.
 * Note: `row` is a reserved word in MySQL 8 — always backtick it in SQL.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('wms_slots', function (Blueprint $t) {
            $t->string('code', 64)->primary();
            $t->string('zone', 191)->nullable();
            $t->string('rack', 60)->nullable()->index('ix_wms_slots_rack');
            $t->integer('row')->nullable();
            $t->integer('col')->nullable();
            $t->integer('level')->nullable();
            $t->integer('capacity')->nullable()->default(12);
            $t->boolean('active')->nullable()->default(true);
            $t->dateTime('created_at')->nullable()->useCurrent();
        });

        Schema::create('wms_grn', function (Blueprint $t) {
            $t->string('lot', 120)->primary();
            $t->integer('expected')->nullable();
            $t->integer('good')->nullable();
            $t->integer('damaged')->nullable();
            $t->integer('diff')->nullable();
            $t->text('notes')->nullable();
            $t->text('photos')->nullable();               // JSON list of file ids
            $t->double('per_piece')->nullable();
            $t->double('value')->nullable();
            $t->unsignedBigInteger('received_by')->nullable();
            $t->dateTime('received_at')->nullable();
            $t->boolean('posted')->nullable()->default(false);
            $t->text('post_error')->nullable();
        });

        Schema::create('wms_counts', function (Blueprint $t) {
            $t->id();
            $t->string('name', 191)->nullable();
            $t->string('rack', 60)->nullable();
            $t->mediumText('slots')->nullable();          // JSON list of slot codes
            $t->unsignedBigInteger('assigned_to')->nullable();
            $t->string('due', 10)->nullable();            // 'YYYY-MM-DD' (Pakistan day)
            $t->string('status', 20)->nullable()->default('open');
            $t->unsignedBigInteger('created_by')->nullable();
            $t->dateTime('created_at')->nullable()->useCurrent();
            $t->dateTime('started_at')->nullable();
            $t->dateTime('finished_at')->nullable();
            $t->unsignedBigInteger('approved_by')->nullable();
            $t->dateTime('approved_at')->nullable();
            $t->mediumText('summary')->nullable();        // JSON
        });

        Schema::create('wms_count_scans', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('count_id')->nullable();
            $t->string('slot', 64)->nullable();
            $t->string('sku', 120)->nullable();
            $t->string('result', 20)->nullable();         // found / extra / unknown
            $t->string('recorded_loc', 60)->nullable();
            $t->boolean('sold')->nullable()->default(false);
            $t->boolean('moved')->nullable()->default(false);
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
            $t->unique(['count_id', 'sku']);
        });

        Schema::create('wms_count_slots', function (Blueprint $t) {
            $t->unsignedBigInteger('count_id');
            $t->string('slot', 64);
            $t->dateTime('done_at')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->primary(['count_id', 'slot']);
        });

        Schema::create('wms_missing', function (Blueprint $t) {
            $t->id();
            $t->string('sku', 120)->nullable()->index('ix_wms_missing_sku');
            $t->string('title', 500)->nullable();
            $t->unsignedBigInteger('count_id')->nullable();
            $t->string('last_loc', 60)->nullable();
            $t->double('cost')->nullable();
            $t->string('status', 20)->nullable()->default('open');
            $t->text('note')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
            $t->unsignedBigInteger('resolved_by')->nullable();
            $t->dateTime('resolved_at')->nullable();
        });

        Schema::create('wms_damage', function (Blueprint $t) {
            $t->id();
            $t->string('sku', 120)->nullable();
            $t->string('title', 500)->nullable();
            $t->string('reason', 60)->nullable();
            $t->text('photo')->nullable();                // file id
            $t->string('found_at', 191)->nullable();      // where it was found (a location, free text)
            $t->text('note')->nullable();
            $t->double('cost')->nullable();
            $t->string('status', 20)->nullable()->default('reported');
            $t->unsignedBigInteger('reported_by')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
            $t->unsignedBigInteger('approved_by')->nullable();
            $t->dateTime('approved_at')->nullable();
            $t->text('post_error')->nullable();
        });

        Schema::create('wms_transfers', function (Blueprint $t) {
            $t->id();
            $t->string('dest', 20)->nullable();
            $t->text('note')->nullable();
            $t->string('status', 20)->nullable()->default('sent');
            $t->unsignedBigInteger('created_by')->nullable();
            $t->dateTime('sent_at')->nullable()->useCurrent();
            $t->unsignedBigInteger('received_by')->nullable();
            $t->dateTime('received_at')->nullable();
            $t->text('discrepancy')->nullable();          // JSON {short, extra, note}
        });

        Schema::create('wms_transfer_items', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('transfer_id')->nullable()->index('ix_wms_ti');
            $t->string('sku', 120)->nullable();
            $t->string('from_loc', 60)->nullable();
            $t->boolean('received')->nullable()->default(false);
            $t->boolean('extra')->nullable()->default(false);
        });
    }

    public function down(): void
    {
        foreach (['wms_transfer_items', 'wms_transfers', 'wms_damage', 'wms_missing', 'wms_count_slots', 'wms_count_scans', 'wms_counts', 'wms_grn', 'wms_slots'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
