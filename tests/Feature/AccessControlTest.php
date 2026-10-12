<?php

namespace Tests\Feature;

use App\Erp\Access;
use App\Erp\Db;
use App\Models\User;
use Tests\TestCase;

/** Registration, login, pages and role-based access control (roles, personal grants/revokes, no escalation). */
class AccessControlTest extends TestCase
{
    private function register(array $over = [])
    {
        return $this->api('POST', '/api/register', array_merge(['name' => 'Sana Khan', 'email' => 'Sana@Example.com', 'password' => 'abcd1234', 'password_confirmation' => 'abcd1234'], $over));
    }

    /* ------------------------------------------------------------ registration */

    public function test_registration_validates_every_field(): void
    {
        $this->register(['name' => ''])->assertStatus(422)->assertJson(['field' => 'name']);
        $this->register(['email' => 'not-an-email'])->assertStatus(422)->assertJson(['field' => 'email']);
        $this->register(['password' => 'short1', 'password_confirmation' => 'short1'])->assertStatus(422)->assertJson(['field' => 'password', 'error' => 'Password needs at least 8 characters']);
        $this->register(['password' => 'onlyletters', 'password_confirmation' => 'onlyletters'])->assertStatus(422)->assertJson(['field' => 'password']);
        $this->register(['password_confirmation' => 'different1'])->assertStatus(422)->assertJson(['field' => 'password_confirmation']);
        $this->assertSame(0, User::count());
    }

    public function test_registration_waits_for_approval_and_never_creates_admins(): void
    {
        config(['erp.registration_role' => 'admin']); // even a misconfiguration cannot create an administrator
        $this->register()->assertOk()->assertJson(['pending' => true]);
        $u = User::first();
        $this->assertSame('sana@example.com', $u->email, 'e-mail stored lower-case');
        $this->assertSame('staff', $u->role);
        $this->assertFalse($u->active);
        $this->assertNotSame('abcd1234', $u->password, 'password is hashed');
        $this->assertTrue(password_verify('abcd1234', $u->password));
        // duplicate e-mail (any case)
        $this->register(['email' => 'SANA@example.com'])->assertStatus(409)->assertJson(['field' => 'email']);
        // cannot log in before approval; the message says why (only after the right password)
        $this->api('POST', '/api/login', ['username' => 'sana@example.com', 'password' => 'abcd1234'])->assertStatus(403)->assertJson(['error' => 'Your account is waiting for approval by the administrator.']);
        $this->api('POST', '/api/login', ['username' => 'sana@example.com', 'password' => 'wrong123'])->assertStatus(401);
    }

    public function test_open_registration_logs_in_straight_away_and_closed_refuses(): void
    {
        config(['erp.registration' => 'open']);
        $this->register()->assertOk()->assertJson(['pending' => false, 'redirect' => '/dashboard']);
        $this->getJson('/api/state')->assertJson(['user' => ['email' => 'sana@example.com', 'role' => 'staff']]);
        config(['erp.registration' => 'closed']);
        $this->api('POST', '/api/logout');
        $this->register(['email' => 'other@example.com'])->assertStatus(403);
    }

    public function test_approving_a_registration(): void
    {
        $this->register()->assertOk();
        $new = User::first();
        $admin = $this->user();
        $row = collect($this->actingAs($admin)->getJson('/api/users')->json())->firstWhere('id', $new->id);
        $this->assertTrue($row['pending']);
        $this->api('POST', '/api/users/'.$new->id, ['active' => true, 'role' => 'cs'])->assertOk();
        $this->api('POST', '/api/logout');
        $this->api('POST', '/api/login', ['username' => 'sana@example.com', 'password' => 'abcd1234'])->assertOk()->assertJson(['redirect' => '/dashboard']);
        $this->assertContains('cs', $this->getJson('/api/state')->json('user.perms'));
    }

    /* ------------------------------------------------------------------ login */

    public function test_login_by_email_or_username_and_redirect_by_role(): void
    {
        $admin = $this->user('admin');
        $cs = $this->user('cs');
        $this->api('POST', '/api/login', ['username' => strtoupper($admin->email), 'password' => 'secret123'])->assertOk()->assertJson(['redirect' => '/admin']);
        $this->api('POST', '/api/logout')->assertOk()->assertJson(['redirect' => '/login']);
        $this->api('POST', '/api/login', ['username' => $cs->username, 'password' => 'secret123'])->assertOk()->assertJson(['redirect' => '/dashboard']);
        $this->api('POST', '/api/login', ['username' => '', 'password' => 'x'])->assertStatus(422)->assertJson(['field' => 'username']);
    }

    public function test_pages_are_protected(): void
    {
        $this->get('/dashboard')->assertRedirect('/login?next=%2Fdashboard');
        $this->get('/admin')->assertRedirect('/login?next=%2Fadmin');
        $this->get('/')->assertRedirect('/login');
        $this->get('/login')->assertOk()->assertSee('Welcome back')->assertSee('erp/auth.js');
        $this->get('/register')->assertOk()->assertSee('Create your account');

        $cs = $this->user('cs');
        $this->actingAs($cs)->get('/admin')->assertRedirect('/dashboard');
        $this->get('/dashboard')->assertOk()->assertSee('erp/access.js');
        $this->get('/login')->assertRedirect('/dashboard');

        $admin = $this->user('admin');
        $this->actingAs($admin)->get('/admin')->assertOk();
        $this->get('/')->assertRedirect('/admin');

        $cs->update(['active' => false]);
        $this->actingAs($cs)->get('/dashboard')->assertRedirect('/login?next=%2Fdashboard');
    }

    public function test_login_page_explains_when_there_is_no_administrator(): void
    {
        $this->get('/login')->assertSee('php artisan erp:admin');
        $this->user('admin');
        $this->get('/login')->assertDontSee('php artisan erp:admin');
    }

    /* ------------------------------------------------------------------- RBAC */

    public function test_permissions_come_from_role_plus_grants_minus_revokes(): void
    {
        $cs = $this->user('cs');
        $admin = $this->user('admin');
        $this->actingAs($admin);
        $this->api('POST', '/api/users/'.$cs->id, ['grant' => ['reports'], 'revoke' => ['customers_edit', 'dashboard']])->assertOk();
        $perms = Access::userPerms(['id' => $cs->id, 'role' => 'cs']);
        $this->assertContains('reports', $perms);
        $this->assertNotContains('customers_edit', $perms);
        $this->assertContains('dashboard', $perms, 'everyone-permissions cannot be revoked');
        $this->actingAs($cs)->getJson('/api/reports')->assertOk();
        $this->api('POST', '/api/customers/03001234567/flag', ['vip' => true])->assertStatus(403);
    }

    public function test_new_permissions_are_enforced_on_the_api(): void
    {
        $manager = $this->user('manager');
        $this->actingAs($manager);
        $this->getJson('/api/shopify/status')->assertOk();                         // sync_view
        $this->api('POST', '/api/shopify/webhooks')->assertStatus(403);             // shopify_manage
        $this->api('POST', '/api/settings/test-shopify')->assertStatus(403);
        $this->getJson('/api/events')->assertOk();                                  // audit
        $this->api('POST', '/api/roles', ['name' => 'X'])->assertStatus(403);       // roles
        $finance = $this->user('finance');
        $this->actingAs($finance)->get('/api/finance/export?month=2026-10')->assertOk(); // reports_export
        $this->actingAs($this->user('cs'))->get('/api/finance/export?month=2026-10')->assertStatus(403);
    }

    public function test_staff_managers_cannot_escalate(): void
    {
        // a manager with staff management, but not super
        $mgr = $this->user('manager', ['users']);
        $cs = $this->user('cs');
        $this->actingAs($mgr);
        // cannot create or promote to the super role
        $this->api('POST', '/api/users', ['name' => 'X', 'username' => 'xavier', 'password' => 'abcd1234', 'role' => 'admin'])->assertStatus(403);
        $this->api('POST', '/api/users/'.$cs->id, ['role' => 'admin'])->assertStatus(403);
        // cannot hand out a permission they do not have (settings, payroll)
        $this->api('POST', '/api/users/'.$cs->id, ['grant' => ['settings']])->assertStatus(403);
        // cannot change their own access
        $this->api('POST', '/api/users/'.$mgr->id, ['grant' => ['payroll']])->assertStatus(403);
        $this->api('POST', '/api/users/'.$mgr->id, ['role' => 'finance'])->assertStatus(403);
        // but can edit their own name
        $this->api('POST', '/api/users/'.$mgr->id, ['name' => 'Manager Renamed'])->assertOk();
        // cannot touch a super administrator
        $owner = $this->user('admin');
        $this->api('POST', '/api/users/'.$owner->id, ['active' => false])->assertStatus(403);
        $this->assertTrue($owner->fresh()->active);
        // can give what they have
        $this->api('POST', '/api/users/'.$cs->id, ['grant' => ['reports']])->assertOk();
    }

    public function test_last_super_administrator_is_protected(): void
    {
        $owner = $this->user('admin');
        $this->actingAs($owner);
        $this->api('POST', '/api/users/'.$owner->id, ['active' => false])->assertStatus(403); // own account
        $second = $this->user('admin');
        $this->actingAs($second);
        $this->api('POST', '/api/users/'.$owner->id, ['active' => false])->assertOk();         // another super remains
        $this->actingAs($owner->fresh()); // blocked accounts are logged out
        $this->getJson('/api/state')->assertJson(['user' => null]);
        $this->actingAs($second);
        $third = $this->user('cs');
        $this->api('POST', '/api/users/'.$third->id, ['role' => 'admin'])->assertOk();
        $this->actingAs($third->fresh());
        $this->api('POST', '/api/users/'.$second->id, ['role' => 'cs'])->assertOk();
        $this->actingAs($second->fresh());
        $this->getJson('/api/users')->assertStatus(403);
        $this->actingAs($third->fresh());
        $this->assertSame(1, Access::activeSupers());
        $this->api('POST', '/api/users/'.$third->id, ['role' => 'cs'])->assertStatus(403); // own role
    }

    public function test_cannot_block_or_demote_the_only_super_admin_from_another_super_account_path(): void
    {
        $a = $this->user('admin');
        $b = $this->user('admin');
        $this->actingAs($a);
        $this->api('POST', '/api/users/'.$b->id, ['active' => false])->assertOk();
        // $a is now the last active super: $b cannot be used to remove it, and nobody can demote it
        Db::run('UPDATE users SET active=1 WHERE id=?', $b->id);
        Db::run("UPDATE users SET role='cs' WHERE id=?", $b->id);
        $c = $this->user('admin');
        Db::run('UPDATE users SET active=0 WHERE id=?', $c->id);
        $this->assertSame(1, Access::activeSupers());
        $this->actingAs($c->fresh()); // blocked: cannot act
        $this->api('POST', '/api/users/'.$a->id, ['role' => 'cs'])->assertStatus(401);
    }

    public function test_roles_can_be_created_changed_and_deleted(): void
    {
        $owner = $this->user('admin');
        $this->actingAs($owner);
        $this->api('POST', '/api/roles', ['name' => 'Packer', 'description' => 'Packs parcels', 'perms' => ['warehouse', 'orders', 'bogus']])->assertOk()->assertJson(['key' => 'packer']);
        $this->api('POST', '/api/roles', ['name' => 'Packer'])->assertStatus(409);
        $roles = collect($this->getJson('/api/roles')->json('roles'))->keyBy('key');
        $this->assertEqualsCanonicalizing(array_merge(Access::BASE, ['warehouse', 'orders']), $roles['packer']['perms']);
        $u = $this->user('packer');
        $this->actingAs($u)->getJson('/api/pick')->assertOk();
        $this->getJson('/api/inventory')->assertStatus(403);
        $this->actingAs($owner);
        $this->api('POST', '/api/roles/packer', ['perms' => ['warehouse', 'orders', 'inventory']])->assertOk();
        $this->actingAs($u)->getJson('/api/inventory')->assertOk();
        $this->actingAs($owner);
        $this->api('DELETE', '/api/roles/packer')->assertStatus(409); // still used
        $this->api('POST', '/api/users/'.$u->id, ['role' => 'staff'])->assertOk();
        $this->api('DELETE', '/api/roles/packer')->assertOk();
        $this->api('DELETE', '/api/roles/cs')->assertStatus(400);     // built-in
        $this->api('POST', '/api/roles/admin', ['perms' => []])->assertStatus(400); // super role always has everything
        $this->assertGreaterThan(0, (int) Db::val("SELECT COUNT(*) FROM events WHERE action IN ('role.create','role.update','role.delete')"));
    }

    public function test_role_editors_cannot_give_roles_more_than_they_have(): void
    {
        $editor = $this->user('manager', ['roles']);
        $this->actingAs($editor);
        $this->api('POST', '/api/roles', ['name' => 'Sneaky', 'perms' => ['settings']])->assertStatus(403);
        $this->api('POST', '/api/roles/cs', ['perms' => ['orders', 'payroll']])->assertStatus(403);
        $this->api('POST', '/api/roles/cs', ['perms' => ['orders', 'cs', 'reports']])->assertOk();
    }

    public function test_admin_bootstrap_from_env_runs_once(): void
    {
        config(['erp.admin_email' => 'boss@example.com', 'erp.admin_password' => 'weak']);
        $this->artisan('erp:install')->expectsOutputToContain('not valid')->assertSuccessful();
        $this->assertSame(0, User::count());
        config(['erp.admin_password' => 'Str0ngPass']);
        $this->artisan('erp:install')->expectsOutputToContain('remove ERP_ADMIN_PASSWORD')->assertSuccessful();
        $this->assertSame('admin', User::where('email', 'boss@example.com')->value('role'));
        $this->artisan('erp:install')->doesntExpectOutputToContain('created from .env')->assertSuccessful();
        $this->assertSame(1, User::count());
    }
}
