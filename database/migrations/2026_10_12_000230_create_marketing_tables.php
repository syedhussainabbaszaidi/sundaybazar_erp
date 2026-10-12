<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Marketing module (legacy modules/marketing.js): Meta ad spend per campaign/day, manual daily spend,
 * other marketing spend / Meta card payments, ad accounts and the daily spend posted to accounts.
 * `date` columns are Pakistan days 'YYYY-MM-DD'.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mkt_daily', function (Blueprint $t) {
            $t->string('date', 10)->index('ix_mkt_daily_date');
            $t->string('account_id', 64);
            $t->string('campaign_id', 64);
            $t->string('campaign_name', 500)->nullable();
            $t->double('spend')->nullable()->default(0);
            $t->double('spend_pkr')->nullable()->default(0);
            $t->bigInteger('impressions')->nullable()->default(0);
            $t->bigInteger('reach')->nullable()->default(0);
            $t->bigInteger('clicks')->nullable()->default(0);
            $t->double('purchases')->nullable()->default(0);
            $t->double('purchase_value')->nullable()->default(0);
            $t->dateTime('synced_at')->nullable();
            $t->primary(['date', 'account_id', 'campaign_id']);
        });

        Schema::create('mkt_manual', function (Blueprint $t) {
            $t->string('date', 10)->primary();
            $t->double('amount');
            $t->text('note')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('mkt_spend', function (Blueprint $t) {
            $t->id();
            $t->string('date', 10)->index('ix_mkt_spend_date');
            $t->string('kind', 16);
            $t->string('category', 60)->nullable();
            $t->double('amount');
            $t->string('bank', 120)->nullable();
            $t->text('note')->nullable();
            $t->string('file_id', 64)->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->boolean('posted')->nullable()->default(false);
            $t->text('error')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('mkt_accounts', function (Blueprint $t) {
            $t->string('id', 64)->primary();
            $t->string('name', 191)->nullable();
            $t->string('currency', 8)->nullable();
            $t->string('status', 64)->nullable();
            $t->string('override', 8)->nullable();
            $t->dateTime('checked_at')->nullable();
        });

        Schema::create('mkt_posted', function (Blueprint $t) {
            $t->string('date', 10)->primary();
            $t->double('amount')->nullable();
            $t->unsignedBigInteger('journal_id')->nullable();
            $t->dateTime('posted_at')->nullable();
            $t->text('error')->nullable();
        });
    }

    public function down(): void
    {
        foreach (['mkt_posted', 'mkt_accounts', 'mkt_spend', 'mkt_manual', 'mkt_daily'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
