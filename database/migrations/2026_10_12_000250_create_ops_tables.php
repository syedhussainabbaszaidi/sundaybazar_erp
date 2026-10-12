<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Operations module (legacy modules/ops.js): targets, tasks, recurring task templates,
 * end-of-day notes and the daily team report snapshots.
 * Task / comment / eod / snapshot times are Pakistan local time 'YYYY-MM-DD HH:MM:SS' (as in the original).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ops_targets', function (Blueprint $t) {
            $t->id();
            $t->string('scope', 16);
            $t->string('ref', 64);
            $t->string('metric', 120);
            $t->double('target');
            $t->double('weight')->default(1);
            $t->unsignedBigInteger('updated_by')->nullable();
            $t->dateTime('updated_at')->nullable()->useCurrent();
            $t->unique(['scope', 'ref', 'metric']);
        });

        Schema::create('ops_tasks', function (Blueprint $t) {
            $t->id();
            $t->string('title', 255);
            $t->text('description')->nullable();
            $t->string('priority', 16)->nullable()->default('normal');
            $t->string('status', 16)->nullable()->default('todo');
            $t->string('due_date', 10)->nullable()->index('ix_ops_tasks_due');
            $t->string('due_time', 10)->nullable();
            $t->string('link_type', 16)->nullable();
            $t->string('link_ref', 80)->nullable();
            $t->text('files')->nullable();
            $t->mediumText('checklist')->nullable();
            $t->unsignedBigInteger('created_by')->nullable();
            $t->dateTime('created_at')->nullable();
            $t->dateTime('updated_at')->nullable();
            $t->unsignedBigInteger('last_by')->nullable();
            $t->dateTime('done_at')->nullable();
            $t->unsignedBigInteger('done_by')->nullable();
            $t->unsignedBigInteger('template_id')->nullable();
            $t->string('gen_date', 10)->nullable();
            $t->unique(['template_id', 'gen_date'], 'ux_ops_tasks_gen');
        });

        Schema::create('ops_task_users', function (Blueprint $t) {
            $t->unsignedBigInteger('task_id');
            $t->unsignedBigInteger('user_id')->index('ix_ops_tu_user');
            $t->dateTime('seen_at')->nullable();
            $t->primary(['task_id', 'user_id']);
        });

        Schema::create('ops_comments', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('task_id')->index('ix_ops_comments_task');
            $t->unsignedBigInteger('user_id')->nullable();
            $t->string('kind', 16)->nullable()->default('comment');
            $t->text('text')->nullable();
            $t->dateTime('at')->nullable();
        });

        Schema::create('ops_templates', function (Blueprint $t) {
            $t->id();
            $t->string('title', 255);
            $t->text('description')->nullable();
            $t->string('priority', 16)->nullable()->default('normal');
            $t->string('scope', 16);
            $t->string('ref', 64);
            $t->string('freq', 16);
            $t->string('weekdays', 191)->nullable();
            $t->integer('month_day')->nullable();
            $t->string('due_time', 10)->nullable();
            $t->mediumText('checklist')->nullable();
            $t->boolean('active')->nullable()->default(true);
            $t->unsignedBigInteger('created_by')->nullable();
            $t->dateTime('created_at')->nullable();
        });

        Schema::create('ops_eod', function (Blueprint $t) {
            $t->unsignedBigInteger('user_id');
            $t->string('day', 10);
            $t->text('did')->nullable();
            $t->text('problems')->nullable();
            $t->text('plan')->nullable();
            $t->dateTime('at')->nullable();
            $t->primary(['user_id', 'day']);
        });

        Schema::create('ops_daily', function (Blueprint $t) {
            $t->string('day', 10);
            $t->string('pkey', 64);
            $t->unsignedBigInteger('user_id')->nullable();
            $t->string('name', 191)->nullable();
            $t->string('role', 32)->nullable();
            $t->double('score')->nullable();
            $t->mediumText('data')->nullable();
            $t->dateTime('built_at')->nullable();
            $t->primary(['day', 'pkey']);
        });
    }

    public function down(): void
    {
        foreach (['ops_daily', 'ops_eod', 'ops_templates', 'ops_comments', 'ops_task_users', 'ops_tasks', 'ops_targets'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
