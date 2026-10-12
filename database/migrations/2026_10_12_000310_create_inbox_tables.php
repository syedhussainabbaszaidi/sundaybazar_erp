<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Messages inbox (ported from modules/inbox.js): WhatsApp (CEQUENS), Instagram DMs + comments,
 * Google Form exchange requests and the automatic WhatsApp messages log.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ib_convs', function (Blueprint $t) {
            $t->id();
            $t->string('channel', 16);                     // wa | ig | igc | form
            $t->string('ext_id', 191);
            $t->string('phone', 32)->nullable()->index();
            $t->string('name', 255)->nullable();
            $t->string('handle', 255)->nullable();
            $t->string('media_id', 120)->nullable();
            $t->string('status', 16)->nullable()->default('open');
            $t->unsignedBigInteger('assignee')->nullable();
            $t->integer('unread')->nullable()->default(0);
            $t->dateTime('last_at')->nullable()->index();
            $t->dateTime('last_in_at')->nullable();
            $t->text('last_text')->nullable();
            $t->string('last_dir', 8)->nullable();
            $t->unsignedBigInteger('ticket_id')->nullable();
            $t->dateTime('created_at')->nullable()->useCurrent();
            $t->unique(['channel', 'ext_id']);
        });

        Schema::create('ib_msgs', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('conv_id')->index();
            $t->string('dir', 8);                           // in | out
            $t->string('kind', 24)->nullable()->default('text');
            $t->text('body')->nullable();
            $t->text('media')->nullable();
            $t->string('ext_id', 191)->nullable()->unique();
            $t->string('ctx_id', 191)->nullable();
            $t->string('status', 20)->nullable();
            $t->text('error')->nullable();
            $t->unsignedBigInteger('user_id')->nullable();
            $t->string('auto', 24)->nullable();
            $t->string('order_id', 64)->nullable();
            $t->mediumText('payload')->nullable();
            $t->string('bot', 16)->nullable();
            $t->text('note')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('ib_hooks', function (Blueprint $t) {
            $t->id();
            $t->string('src', 20)->nullable();
            $t->integer('ok')->nullable();
            $t->text('note')->nullable();
            $t->mediumText('body')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });

        Schema::create('ib_auto_log', function (Blueprint $t) {
            $t->id();
            $t->string('order_id', 100);
            $t->string('event', 120);
            $t->string('rule', 24)->nullable();
            $t->string('phone', 32)->nullable();
            $t->string('status', 16)->nullable()->index();
            $t->unsignedBigInteger('msg_id')->nullable();
            $t->text('error')->nullable();
            $t->dateTime('created_at')->nullable()->useCurrent();
            $t->dateTime('at')->nullable()->useCurrent();
            $t->unique(['order_id', 'event']);
        });

        Schema::create('ib_forms', function (Blueprint $t) {
            $t->id();
            $t->string('key', 191)->nullable()->unique();
            $t->string('form', 191)->nullable();
            $t->string('submitted_at', 40)->nullable();     // as sent by the form (free text)
            $t->mediumText('answers')->nullable();
            $t->string('phone', 32)->nullable();
            $t->string('order_id', 64)->nullable();
            $t->unsignedBigInteger('ticket_id')->nullable();
            $t->unsignedBigInteger('conv_id')->nullable();
            $t->text('error')->nullable();
            $t->dateTime('at')->nullable()->useCurrent();
        });
    }

    public function down(): void
    {
        foreach (['ib_forms', 'ib_auto_log', 'ib_hooks', 'ib_msgs', 'ib_convs'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
