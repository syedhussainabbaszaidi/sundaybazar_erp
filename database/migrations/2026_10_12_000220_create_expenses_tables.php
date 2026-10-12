<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Expenses & petty cash module (port of legacy/server/modules/expenses.js schema):
 * categories, staff claims, petty cash boxes + moves, cash counts, recurring bills, accounts posting queue.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('exp_categories')) {
            Schema::create('exp_categories', function (Blueprint $t) {
                $t->id();
                $t->string('name', 191)->unique();
                $t->string('account', 191);
                $t->double('budget')->nullable();
                $t->boolean('active')->nullable()->default(true);
                $t->integer('sort')->nullable()->default(0);
            });
        }

        if (! Schema::hasTable('exp_claims')) {
            Schema::create('exp_claims', function (Blueprint $t) {
                $t->id();
                $t->string('day', 10)->index('ix_exp_claims_day');
                $t->unsignedBigInteger('category_id')->nullable();
                $t->string('category', 191)->nullable();
                $t->string('account', 191)->nullable();
                $t->double('amount');
                $t->string('paid_from', 20);
                $t->unsignedBigInteger('box_id')->nullable();
                $t->string('vendor', 191)->nullable();
                $t->text('note')->nullable();
                $t->text('receipt')->nullable();               // file id(s) from /api/files
                $t->unsignedBigInteger('user_id')->nullable()->index('ix_exp_claims_user');
                $t->string('status', 20)->nullable()->default('pending')->index('ix_exp_claims_status');
                $t->text('reason')->nullable();
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable();
                $t->boolean('reimbursed')->nullable()->default(false);
                $t->string('reimbursed_at', 20)->nullable();   // day 'YYYY-MM-DD'
                $t->unsignedBigInteger('reimbursed_by')->nullable();
                $t->string('reimb_from', 60)->nullable();
                $t->unsignedBigInteger('recurring_id')->nullable();
                $t->string('period', 7)->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                // original: partial unique index WHERE recurring_id IS NOT NULL (MySQL allows many NULLs in a unique index)
                $t->unique(['recurring_id', 'period'], 'ux_exp_claims_rec');
            });
        }

        if (! Schema::hasTable('exp_boxes')) {
            Schema::create('exp_boxes', function (Blueprint $t) {
                $t->id();
                $t->string('name', 191)->unique();
                $t->unsignedBigInteger('custodian')->nullable();
                $t->double('low')->nullable()->default(5000);
                $t->boolean('active')->nullable()->default(true);
            });
        }

        if (! Schema::hasTable('exp_box_moves')) {
            Schema::create('exp_box_moves', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('box_id');
                $t->string('day', 10);
                $t->string('kind', 20);
                $t->double('amount');
                $t->string('ref', 64)->nullable();
                $t->text('note')->nullable();
                $t->string('src', 20)->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->index(['box_id', 'day'], 'ix_exp_moves_box');
            });
        }

        if (! Schema::hasTable('exp_counts')) {
            Schema::create('exp_counts', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('box_id');
                $t->string('day', 10)->nullable();
                $t->double('counted')->nullable();
                $t->double('book')->nullable();
                $t->double('pending')->nullable();
                $t->double('variance')->nullable();
                $t->text('note')->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->string('status', 20)->nullable()->default('ok');
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('exp_recurring')) {
            Schema::create('exp_recurring', function (Blueprint $t) {
                $t->id();
                $t->string('name', 191);
                $t->unsignedBigInteger('category_id')->nullable();
                $t->double('amount')->nullable()->default(0);
                $t->integer('dom')->nullable()->default(1);
                $t->string('paid_from', 20)->nullable()->default('bank');
                $t->string('vendor', 191)->nullable();
                $t->text('note')->nullable();
                $t->boolean('active')->nullable()->default(false);
            });
        }

        if (! Schema::hasTable('exp_postings')) {
            Schema::create('exp_postings', function (Blueprint $t) {
                $t->id();
                $t->string('source', 40);
                $t->string('source_id', 64);
                $t->mediumText('entry')->nullable();
                $t->string('status', 20)->nullable()->default('pending');
                $t->text('error')->nullable();
                $t->string('journal_id', 64)->nullable();
                $t->integer('tries')->nullable()->default(0);
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->unique(['source', 'source_id']);
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('exp_postings');
        Schema::dropIfExists('exp_recurring');
        Schema::dropIfExists('exp_counts');
        Schema::dropIfExists('exp_box_moves');
        Schema::dropIfExists('exp_boxes');
        Schema::dropIfExists('exp_claims');
        Schema::dropIfExists('exp_categories');
    }
};
