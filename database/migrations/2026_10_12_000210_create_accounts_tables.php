<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Accounts module (legacy/server/modules/accounts.js): chart of accounts, double-entry journal and its lines.
 * Journal `date` is a 'YYYY-MM-DD' day string; (source, source_id) identifies who posted an entry
 * (other modules re-post the same key to update it).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('acc_accounts', function (Blueprint $t) {
            $t->id();
            $t->string('code', 32)->nullable()->unique();
            $t->string('name', 191)->unique();
            $t->string('type', 20);
            $t->string('statement', 4);
            $t->string('grp', 40)->nullable();
            $t->boolean('active')->default(true);
            $t->boolean('system')->default(false);
            $t->text('note')->nullable();
            $t->dateTime('created_at')->nullable()->useCurrent();
        });
        Schema::create('acc_journals', function (Blueprint $t) {
            $t->id();
            $t->string('date', 10)->index('ix_acc_journals_date');
            $t->text('memo')->nullable();
            $t->string('source', 60);
            $t->string('source_id', 191);
            $t->string('ref', 60)->nullable()->index('ix_acc_journals_ref');
            $t->string('kind', 10)->nullable();
            $t->string('file_id', 64)->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->double('amount')->default(0);
            $t->mediumText('meta')->nullable();
            $t->boolean('voided')->default(false);
            $t->text('void_reason')->nullable();
            $t->unsignedBigInteger('voided_by')->nullable();
            $t->dateTime('voided_at')->nullable();
            $t->dateTime('created_at')->nullable()->useCurrent();
            $t->dateTime('updated_at')->nullable();
            $t->unique(['source', 'source_id'], 'ux_acc_journals_src');
        });
        Schema::create('acc_lines', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('journal_id')->index('ix_acc_lines_j');
            $t->unsignedBigInteger('account_id')->index('ix_acc_lines_a');
            $t->double('debit')->default(0);
            $t->double('credit')->default(0);
            $t->string('party', 191)->nullable()->index('ix_acc_lines_party');
            $t->text('memo')->nullable();
            $t->foreign('journal_id')->references('id')->on('acc_journals')->cascadeOnDelete();
            $t->foreign('account_id')->references('id')->on('acc_accounts');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('acc_lines');
        Schema::dropIfExists('acc_journals');
        Schema::dropIfExists('acc_accounts');
    }
};
