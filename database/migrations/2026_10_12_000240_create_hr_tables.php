<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** HR & payroll (legacy/server/modules/hr.js). */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('hr_employees')) {
            Schema::create('hr_employees', function (Blueprint $t) {
                $t->id();
                $t->string('name', 191);
                $t->unsignedBigInteger('user_id')->nullable()->index('ix_hr_emp_user');
                $t->string('phone', 60)->nullable();
                $t->string('cnic', 60)->nullable();
                $t->text('address')->nullable();
                $t->text('emergency')->nullable();
                $t->string('department', 60)->nullable();
                $t->string('designation', 120)->nullable();
                $t->string('join_date', 10)->nullable();
                $t->string('status', 20)->nullable()->default('active');
                $t->string('leave_date', 10)->nullable();
                $t->text('leave_reason')->nullable();
                $t->double('basic')->nullable()->default(0);
                $t->double('allowances')->nullable()->default(0);
                $t->string('pay_method', 40)->nullable()->default('Bank');
                $t->string('bank_account', 191)->nullable();
                $t->string('shift_start', 10)->nullable()->default('09:00');
                $t->string('shift_end', 10)->nullable()->default('18:00');
                $t->integer('grace_min')->nullable()->default(15);
                $t->string('off_days', 60)->nullable()->default('[0]');
                $t->string('photo', 191)->nullable();
                $t->text('docs')->nullable(); // JSON list, '[]' written by the app (TEXT defaults are not portable)
                $t->text('notes')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('updated_at')->nullable();
            });
        }

        if (! Schema::hasTable('hr_attendance')) {
            Schema::create('hr_attendance', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('emp_id');
                $t->string('day', 10);
                $t->dateTime('in_at')->nullable();   // Pakistan local time 'YYYY-MM-DD HH:MM:SS'
                $t->dateTime('out_at')->nullable();
                $t->string('in_ip', 64)->nullable();
                $t->string('out_ip', 64)->nullable();
                $t->integer('late_min')->nullable()->default(0);
                $t->integer('early_min')->nullable()->default(0);
                $t->integer('minutes')->nullable();
                $t->boolean('half')->nullable()->default(false);
                $t->string('source', 20)->nullable()->default('self');
                $t->text('note')->nullable();
                $t->unsignedBigInteger('edited_by')->nullable();
                $t->dateTime('edited_at')->nullable();
                $t->unique(['emp_id', 'day']);
                $t->index('day', 'ix_hr_att_day');
            });
        }

        if (! Schema::hasTable('hr_holidays')) {
            Schema::create('hr_holidays', function (Blueprint $t) {
                $t->string('day', 10)->primary();
                $t->string('name', 191)->nullable();
            });
        }

        if (! Schema::hasTable('hr_leave')) {
            Schema::create('hr_leave', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('emp_id');
                $t->string('type', 40)->nullable();
                $t->string('from_day', 10)->nullable();
                $t->string('to_day', 10)->nullable();
                $t->boolean('half')->nullable()->default(false);
                $t->double('days')->nullable();
                $t->text('reason')->nullable();
                $t->string('status', 20)->nullable()->default('pending');
                $t->unsignedBigInteger('decided_by')->nullable();
                $t->dateTime('decided_at')->nullable();
                $t->text('decision_note')->nullable();
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
                $t->index(['emp_id', 'from_day'], 'ix_hr_leave_emp');
            });
        }

        if (! Schema::hasTable('hr_advances')) {
            Schema::create('hr_advances', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('emp_id')->index();
                $t->string('day', 10)->nullable();
                $t->double('amount')->nullable();
                $t->string('method', 40)->nullable();
                $t->double('monthly')->nullable()->default(0);
                $t->text('note')->nullable();
                $t->boolean('posted')->nullable()->default(false);
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('hr_payroll')) {
            Schema::create('hr_payroll', function (Blueprint $t) {
                $t->string('month', 7)->primary();
                $t->string('status', 20)->nullable()->default('draft');
                $t->boolean('posted')->nullable()->default(false);
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable();
            });
        }

        if (! Schema::hasTable('hr_payslips')) {
            Schema::create('hr_payslips', function (Blueprint $t) {
                $t->id();
                $t->string('month', 7);
                $t->unsignedBigInteger('emp_id');
                $t->string('name', 191)->nullable();
                $t->string('department', 60)->nullable();
                $t->string('designation', 120)->nullable();
                $t->integer('days_month')->nullable();
                $t->integer('emp_days')->nullable();
                $t->double('present')->nullable();
                $t->integer('late')->nullable();
                $t->double('absent')->nullable();
                $t->double('leave_paid')->nullable();
                $t->double('unpaid')->nullable();
                $t->integer('off')->nullable();
                $t->integer('holiday')->nullable();
                $t->double('basic')->nullable();
                $t->double('allowances')->nullable();
                $t->double('day_rate')->nullable();
                $t->double('gross')->nullable();
                $t->double('absence_ded')->nullable();
                $t->double('late_ded')->nullable();
                $t->double('earned')->nullable();
                $t->double('incentive')->nullable()->default(0);
                $t->text('incentive_note')->nullable();
                $t->double('other_ded')->nullable()->default(0);
                $t->text('other_note')->nullable();
                $t->double('recovery')->nullable()->default(0);
                $t->boolean('recovery_manual')->nullable()->default(false);
                $t->double('adv_balance')->nullable();
                $t->double('net')->nullable();
                $t->boolean('paid')->nullable()->default(false);
                $t->string('paid_at', 10)->nullable();
                $t->string('paid_from', 60)->nullable();
                $t->unique(['month', 'emp_id']);
                $t->index('emp_id');
            });
        }

        if (! Schema::hasTable('hr_warnings')) {
            Schema::create('hr_warnings', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('emp_id')->index();
                $t->string('day', 10)->nullable();
                $t->string('type', 20)->nullable();
                $t->text('note')->nullable();
                $t->string('file', 64)->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }
    }

    public function down(): void
    {
        foreach (['hr_warnings', 'hr_payslips', 'hr_payroll', 'hr_advances', 'hr_leave', 'hr_holidays', 'hr_attendance', 'hr_employees'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
