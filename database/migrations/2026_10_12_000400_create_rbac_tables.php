<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Role-based access control managed in the database:
 *  roles            — named sets of permissions (is_super = every permission, present and future)
 *  permissions      — the catalogue (key used by the API routes, grouped by module/action for the screens)
 *  role_permissions — which permissions a role has
 *  user_permissions — per-person exceptions: 'grant' adds, 'revoke' removes a permission of the role
 * users.role holds the role key; users.email is the login/registration e-mail.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('roles', function (Blueprint $t) {
            $t->id();
            $t->string('key', 32)->unique();
            $t->string('name', 80);
            $t->string('description', 255)->nullable();
            $t->boolean('is_system')->default(false); // shipped roles: cannot be deleted
            $t->boolean('is_super')->default(false);  // full control
            $t->dateTime('created_at')->useCurrent();
            $t->dateTime('updated_at')->nullable();
        });

        Schema::create('permissions', function (Blueprint $t) {
            $t->string('key', 40)->primary();
            $t->string('module', 60);
            $t->string('action', 60);
            $t->string('label', 160);
            $t->integer('sort')->default(0);
        });

        Schema::create('role_permissions', function (Blueprint $t) {
            $t->string('role_key', 32);
            $t->string('permission_key', 40);
            $t->primary(['role_key', 'permission_key']);
            $t->foreign('role_key')->references('key')->on('roles')->cascadeOnDelete()->cascadeOnUpdate();
            $t->foreign('permission_key')->references('key')->on('permissions')->cascadeOnDelete();
        });

        Schema::create('user_permissions', function (Blueprint $t) {
            $t->unsignedBigInteger('user_id');
            $t->string('permission_key', 40);
            $t->enum('effect', ['grant', 'revoke']);
            $t->primary(['user_id', 'permission_key']);
            $t->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
            $t->foreign('permission_key')->references('key')->on('permissions')->cascadeOnDelete();
        });

        Schema::table('users', function (Blueprint $t) {
            $t->string('email', 191)->nullable()->unique()->after('username');
            $t->string('registered_via', 20)->default('admin')->after('active'); // admin | self (public registration)
            $t->dateTime('updated_at')->nullable()->after('created_at');
            $t->index('role');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $t) {
            $t->dropIndex(['role']);
            $t->dropUnique(['email']);
            $t->dropColumn(['email', 'registered_via', 'updated_at']);
        });
        Schema::dropIfExists('user_permissions');
        Schema::dropIfExists('role_permissions');
        Schema::dropIfExists('permissions');
        Schema::dropIfExists('roles');
    }
};
