<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Stock line — listing pipeline board (port of modules/stockline.js schema):
 * per-pair stages (sl_items), scan batches, lot sorting sheets, QC batches, handovers to the warehouse.
 * Note: `rows` is a reserved word in MySQL — always backtick sl_sort.`rows` in SQL.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sl_items', function (Blueprint $t) {
            $t->string('sku', 120)->primary();
            $t->string('lot', 120)->nullable()->index('ix_sl_items_lot');
            $t->string('title', 500)->nullable();
            $t->string('stage', 20)->nullable()->default('listed')->index('ix_sl_items_stage');
            $t->string('grade', 60)->nullable();
            $t->text('notes')->nullable();
            $t->string('pref_loc', 60)->nullable();
            $t->string('location', 60)->nullable();
            $t->dateTime('listed_at')->nullable();
            $t->unsignedBigInteger('listed_by')->nullable();
            $t->dateTime('photo_at')->nullable();
            $t->unsignedBigInteger('photo_by')->nullable();
            $t->unsignedBigInteger('photo_batch')->nullable();
            $t->dateTime('edited_at')->nullable();
            $t->unsignedBigInteger('edited_by')->nullable();
            $t->unsignedBigInteger('edit_batch')->nullable();
            $t->dateTime('uploaded_at')->nullable();
            $t->unsignedBigInteger('uploaded_by')->nullable();
            $t->unsignedBigInteger('upload_batch')->nullable();
            $t->string('upload_src', 20)->nullable();     // shopify / manual
            $t->dateTime('handed_at')->nullable();
            $t->unsignedBigInteger('handed_by')->nullable();
            $t->unsignedBigInteger('handover_id')->nullable();
            $t->dateTime('received_at')->nullable();
            $t->unsignedBigInteger('received_by')->nullable();
            $t->dateTime('located_at')->nullable();
            $t->unsignedBigInteger('located_by')->nullable();
            $t->dateTime('updated_at')->nullable()->useCurrent();
        });

        Schema::create('sl_batches', function (Blueprint $t) {
            $t->id();
            $t->string('kind', 20)->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->integer('n')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('sl_sort', function (Blueprint $t) {
            $t->string('lot', 120)->primary();
            $t->mediumText('rows')->nullable();           // JSON [{t,g,c,n,b}]
            $t->integer('good')->nullable();
            $t->integer('damaged')->nullable()->default(0);
            $t->integer('unmatched')->nullable()->default(0);
            $t->integer('total')->nullable();
            $t->text('notes')->nullable();
            $t->unsignedBigInteger('sorted_by')->nullable();
            $t->dateTime('sorted_at')->nullable();
            $t->unsignedBigInteger('updated_by')->nullable();
            $t->dateTime('updated_at')->nullable();
        });

        Schema::create('sl_qc', function (Blueprint $t) {
            $t->id();
            $t->string('lot', 120)->nullable()->index('ix_sl_qc_lot');
            $t->integer('passed')->nullable()->default(0);
            $t->integer('rejected')->nullable()->default(0);
            $t->text('reasons')->nullable();              // JSON {reason: n}
            $t->text('notes')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('sl_handovers', function (Blueprint $t) {
            $t->id();
            $t->string('status', 20)->nullable()->default('sent');
            $t->text('note')->nullable();
            $t->unsignedBigInteger('created_by')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
            $t->integer('warnings')->nullable()->default(0);
            $t->unsignedBigInteger('received_by')->nullable();
            $t->dateTime('received_at')->nullable();
            $t->text('diff')->nullable();                 // JSON {missing, extra, note}
        });

        Schema::create('sl_handover_items', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('handover_id')->nullable()->index('ix_sl_hi');
            $t->string('sku', 120)->nullable();
            $t->string('suggested', 60)->nullable();
            $t->string('src', 20)->nullable();            // lister / auto / none
            $t->string('confirmed_loc', 60)->nullable();
            $t->boolean('received')->nullable()->default(false);
            $t->boolean('extra')->nullable()->default(false);
            $t->boolean('located')->nullable()->default(false);
            $t->string('warn', 255)->nullable();
            $t->dateTime('received_at')->nullable();
            $t->dateTime('located_at')->nullable();
        });
    }

    public function down(): void
    {
        foreach (['sl_handover_items', 'sl_handovers', 'sl_qc', 'sl_sort', 'sl_batches', 'sl_items'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
