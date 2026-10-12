<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Tickets module (port of legacy/server/modules/tickets.js schema + migrate()):
 * CS tickets, notes, exchanges, exchange items / log, refunds & store credit.
 * The fault_* columns were added with ALTER TABLE in the original migrate().
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('tk_tickets')) {
            Schema::create('tk_tickets', function (Blueprint $t) {
                $t->id();
                $t->string('type', 60)->nullable();
                $t->string('channel', 40)->nullable();
                $t->string('subject', 255)->nullable();
                $t->string('order_id', 64)->nullable()->index('ix_tk_order');
                $t->string('order_name', 64)->nullable();
                $t->string('phone', 32)->nullable()->index('ix_tk_phone');
                $t->string('cust_name', 191)->nullable();
                $t->string('tracking', 120)->nullable();
                $t->string('sku', 120)->nullable();
                $t->string('priority', 16)->nullable()->default('normal');
                $t->unsignedBigInteger('assignee')->nullable()->index('ix_tk_assignee');
                $t->string('status', 20)->nullable()->default('open')->index('ix_tk_status');
                $t->boolean('auto')->nullable()->default(false);
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('updated_at')->nullable()->useCurrent();
                $t->dateTime('due_at')->nullable();
                $t->dateTime('first_response_at')->nullable();
                $t->dateTime('resolved_at')->nullable();
                $t->dateTime('closed_at')->nullable();
                $t->string('resolution', 120)->nullable();
                $t->text('resolution_note')->nullable();
                $t->unsignedBigInteger('resolved_by')->nullable();
                $t->integer('reopened')->nullable()->default(0);
            });
        }
        // columns the original added in migrate()
        Schema::table('tk_tickets', function (Blueprint $t) {
            if (! Schema::hasColumn('tk_tickets', 'fault_dept')) {
                $t->string('fault_dept', 20)->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_user_id')) {
                $t->unsignedBigInteger('fault_user_id')->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_reason')) {
                $t->string('fault_reason', 191)->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_note')) {
                $t->text('fault_note')->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_cost')) {
                $t->double('fault_cost')->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_by')) {
                $t->unsignedBigInteger('fault_by')->nullable();
            }
            if (! Schema::hasColumn('tk_tickets', 'fault_at')) {
                $t->dateTime('fault_at')->nullable();
            }
        });
        if (! Schema::hasIndex('tk_tickets', 'ix_tk_fault')) {
            Schema::table('tk_tickets', function (Blueprint $t) {
                $t->index(['fault_user_id', 'resolved_at'], 'ix_tk_fault');
            });
        }

        if (! Schema::hasTable('tk_notes')) {
            Schema::create('tk_notes', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('ticket_id')->index('ix_tk_notes');
                $t->unsignedBigInteger('user_id')->nullable();
                $t->string('kind', 20)->nullable()->default('note');
                $t->text('body')->nullable();
                $t->text('files')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('tk_exchanges')) {
            Schema::create('tk_exchanges', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('ticket_id')->nullable();
                $t->string('order_id', 64)->nullable();
                $t->string('order_name', 64)->nullable();
                $t->string('phone', 32)->nullable();
                $t->string('cust_name', 191)->nullable();
                $t->double('old_total')->nullable()->default(0);
                $t->double('new_total')->nullable()->default(0);
                $t->double('diff')->nullable()->default(0);
                $t->string('diff_mode', 20)->nullable()->default('none');
                $t->string('refund_method', 40)->nullable();
                $t->string('reverse_tracking', 120)->nullable();
                $t->string('out_tracking', 120)->nullable();
                $t->string('step', 20)->nullable()->default('requested')->index('ix_tk_ex_step');
                $t->text('note')->nullable();
                $t->text('wms_note')->nullable();
                $t->unsignedBigInteger('refund_id')->nullable();
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->dateTime('updated_at')->nullable()->useCurrent();
                $t->dateTime('requested_at')->nullable()->useCurrent();
                $t->dateTime('approved_at')->nullable();
                $t->dateTime('received_at')->nullable();
                $t->dateTime('dispatched_at')->nullable();
                $t->dateTime('completed_at')->nullable();
                $t->dateTime('cancelled_at')->nullable();
            });
        }

        if (! Schema::hasTable('tk_exchange_items')) {
            Schema::create('tk_exchange_items', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('exchange_id')->index('ix_tk_exi');
                $t->string('dir', 8);
                $t->string('sku', 120)->nullable()->index('ix_tk_exi_sku');
                $t->string('title', 500)->nullable();
                $t->double('price')->nullable()->default(0);
                $t->string('size', 60)->nullable();
            });
        }

        if (! Schema::hasTable('tk_exchange_log')) {
            Schema::create('tk_exchange_log', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('exchange_id');
                $t->string('step', 20)->nullable();
                $t->unsignedBigInteger('user_id')->nullable();
                $t->text('note')->nullable();
                $t->dateTime('at')->nullable()->useCurrent();
            });
        }

        if (! Schema::hasTable('tk_refunds')) {
            Schema::create('tk_refunds', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('ticket_id')->nullable();
                $t->unsignedBigInteger('exchange_id')->nullable();
                $t->string('order_id', 64)->nullable();
                $t->string('order_name', 64)->nullable();
                $t->string('phone', 32)->nullable()->index('ix_tk_ref_phone');
                $t->string('cust_name', 191)->nullable();
                $t->string('method', 40)->nullable();
                $t->double('amount')->nullable();
                $t->text('account_details')->nullable();
                $t->text('reason')->nullable();
                $t->string('status', 20)->nullable()->default('pending')->index('ix_tk_ref_status');
                $t->unsignedBigInteger('created_by')->nullable();
                $t->dateTime('created_at')->nullable()->useCurrent();
                $t->unsignedBigInteger('approved_by')->nullable();
                $t->dateTime('approved_at')->nullable();
                $t->unsignedBigInteger('paid_by')->nullable();
                $t->dateTime('paid_at')->nullable();
                $t->string('paid_ref', 191)->nullable();
                $t->unsignedBigInteger('rejected_by')->nullable();
                $t->dateTime('rejected_at')->nullable();
                $t->text('reject_reason')->nullable();
                $t->boolean('posted')->nullable()->default(false);
                $t->text('post_error')->nullable();
                $t->string('journal_id', 64)->nullable();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('tk_refunds');
        Schema::dropIfExists('tk_exchange_log');
        Schema::dropIfExists('tk_exchange_items');
        Schema::dropIfExists('tk_exchanges');
        Schema::dropIfExists('tk_notes');
        Schema::dropIfExists('tk_tickets');
    }
};
