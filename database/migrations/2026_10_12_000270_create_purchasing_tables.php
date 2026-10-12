<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Purchasing (legacy/server/modules/purchasing.js): suppliers, POs, bills, instalments, payments, debit notes. */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('pur_suppliers')) {
            Schema::create('pur_suppliers', function (Blueprint $t) {
                $t->id();
                $t->string('name', 191)->unique();
                $t->string('type', 20)->nullable()->default('lots');
                $t->string('phone', 60)->nullable();
                $t->string('whatsapp', 40)->nullable();
                $t->string('city', 120)->nullable();
                $t->text('address')->nullable();
                $t->text('bank')->nullable();
                $t->string('terms', 20)->nullable()->default('cash');
                $t->integer('credit_days')->nullable();
                $t->integer('instalments')->nullable();
                $t->string('prefix', 20)->nullable();
                $t->text('note')->nullable();
                $t->boolean('active')->nullable()->default(true);
                $t->string('source', 20)->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('updated_at')->nullable();
            });
        }

        if (! Schema::hasTable('pur_pos')) {
            Schema::create('pur_pos', function (Blueprint $t) {
                $t->id();
                $t->string('kind', 20);
                $t->string('supplier', 191);
                $t->string('status', 20)->nullable()->default('draft')->index('ix_pur_pos_status');
                $t->string('lot_name', 120)->nullable()->index('ix_pur_pos_lot');
                $t->string('lot_kind', 20)->nullable();
                $t->integer('pieces')->nullable();
                $t->string('pricing', 20)->nullable();
                $t->double('rate')->nullable();
                $t->double('lump')->nullable();
                $t->mediumText('mix')->nullable();
                $t->integer('bad_est')->nullable()->default(0);
                $t->text('extras')->nullable();
                $t->double('extra_total')->nullable()->default(0);
                $t->string('expected_date', 10)->nullable();
                $t->double('advance_plan')->nullable()->default(0);
                $t->string('terms', 20)->nullable();
                $t->integer('credit_days')->nullable();
                $t->integer('instalments')->nullable();
                $t->text('notes')->nullable();
                $t->text('files')->nullable();
                $t->mediumText('plan')->nullable();
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('updated_at')->nullable();
                $t->dateTime('submitted_at')->nullable();
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable();
                $t->dateTime('sent_at')->nullable();
                $t->string('received_on', 10)->nullable();
                $t->dateTime('billed_at')->nullable();
                $t->dateTime('closed_at')->nullable();
                $t->dateTime('cancelled_at')->nullable();
                $t->unsignedBigInteger('cancelled_by')->nullable();
                $t->text('cancel_reason')->nullable();
                $t->text('settlement')->nullable();
                $t->text('post_error')->nullable();
            });
        }

        if (! Schema::hasTable('pur_po_lines')) {
            Schema::create('pur_po_lines', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('po_id')->index('ix_pur_lines_po');
                $t->string('item', 191)->nullable();
                $t->double('qty')->nullable();
                $t->string('unit', 40)->nullable();
                $t->double('rate')->nullable();
                $t->double('received')->nullable()->default(0);
            });
        }

        if (! Schema::hasTable('pur_bills')) {
            Schema::create('pur_bills', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('po_id')->nullable()->index('ix_pur_bills_po');
                $t->string('supplier', 191);
                $t->string('bill_no', 60)->nullable();
                $t->string('bill_date', 10)->nullable();
                $t->string('due_date', 10)->nullable();
                $t->double('goods')->nullable();
                $t->text('extras')->nullable();
                $t->double('extra_total')->nullable()->default(0);
                $t->string('account', 120)->nullable();
                $t->text('match')->nullable();
                $t->string('file_id', 64)->nullable();
                $t->string('status', 20)->nullable()->default('posted');
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->text('post_error')->nullable();
            });
        }

        if (! Schema::hasTable('pur_instalments')) {
            Schema::create('pur_instalments', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('bill_id')->index();
                $t->string('due', 10)->nullable();
                $t->double('amount')->nullable();
            });
        }

        if (! Schema::hasTable('pur_payments')) {
            Schema::create('pur_payments', function (Blueprint $t) {
                $t->id();
                $t->string('supplier', 191)->index('ix_pur_pay_sup');
                $t->unsignedBigInteger('po_id')->nullable()->index();
                $t->unsignedBigInteger('bill_id')->nullable()->index();
                $t->string('kind', 20)->nullable()->default('payment');
                $t->string('date', 10)->nullable();
                $t->double('amount')->nullable();
                $t->string('account', 120)->nullable();
                $t->string('ref', 60)->nullable();
                $t->text('note')->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->text('post_error')->nullable();
            });
        }

        if (! Schema::hasTable('pur_debit_notes')) {
            Schema::create('pur_debit_notes', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('po_id')->nullable()->index();
                $t->string('supplier', 191)->nullable();
                $t->string('date', 10)->nullable();
                $t->string('kind', 20)->nullable();
                $t->integer('short_pcs')->nullable()->default(0);
                $t->integer('damaged_pcs')->nullable()->default(0);
                $t->double('amount')->nullable();
                $t->text('reason')->nullable();
                $t->unsignedBigInteger('transfer_id')->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->text('post_error')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['pur_debit_notes', 'pur_payments', 'pur_instalments', 'pur_bills', 'pur_po_lines', 'pur_pos', 'pur_suppliers'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
