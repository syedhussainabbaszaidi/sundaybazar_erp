<?php

namespace Tests\Feature;

use App\Erp\Db;
use Tests\TestCase;

/** Login, sessions, permissions, cross-site write protection, persistence. */
class ApiSecurityTest extends TestCase
{
    public function test_browser_setup_needs_the_setup_key_then_login_and_logout(): void
    {
        $this->getJson('/api/state')->assertOk()->assertJson(['setup' => true, 'user' => null]);
        $this->api('POST', '/api/setup', ['name' => 'Owner', 'email' => 'owner@example.com', 'password' => 'owner1234'])->assertStatus(403);
        config(['erp.setup_key' => 'k3y']);
        $this->api('POST', '/api/setup', ['name' => 'Owner', 'email' => 'owner@example.com', 'password' => 'owner1234', 'key' => 'nope'])->assertStatus(403);
        $this->api('POST', '/api/setup', ['name' => 'Owner', 'username' => 'Owner', 'email' => 'owner@example.com', 'password' => 'owner1234', 'key' => 'k3y'])->assertOk()->assertJson(['redirect' => '/admin']);
        $this->getJson('/api/state')->assertJson(['user' => ['username' => 'owner', 'role' => 'admin'], 'isSuper' => true]);
        $this->api('POST', '/api/setup', ['name' => 'X', 'email' => 'x@example.com', 'password' => 'xxxxxx12', 'key' => 'k3y'])->assertStatus(403);
        $this->api('POST', '/api/logout')->assertOk();
        $this->getJson('/api/state')->assertJson(['user' => null]);
        $this->api('POST', '/api/login', ['username' => 'owner', 'password' => 'owner1234'])->assertOk();
        $this->getJson('/api/dashboard')->assertOk();
    }

    public function test_wrong_password_and_lockout(): void
    {
        $this->user();
        for ($i = 0; $i < 8; $i++) {
            $this->api('POST', '/api/login', ['username' => 'nobody', 'password' => 'bad'])->assertStatus(401);
        }
        $this->api('POST', '/api/login', ['username' => 'nobody', 'password' => 'bad'])->assertStatus(429);
    }

    public function test_not_logged_in_gets_401_and_no_data(): void
    {
        $this->getJson('/api/orders')->assertStatus(401)->assertJson(['error' => 'Please log in']);
    }

    public function test_permissions_are_enforced(): void
    {
        $cs = $this->user('cs');
        $this->actingAs($cs);
        $this->getJson('/api/orders')->assertOk();
        $this->getJson('/api/settings')->assertStatus(403);
        $this->getJson('/api/finance/summary')->assertStatus(403);
        $this->api('POST', '/api/users', ['name' => 'x', 'username' => 'xxx', 'password' => 'xxxxxx12', 'role' => 'admin'])->assertStatus(403);
        $this->api('POST', '/api/sync', ['kind' => 'all'])->assertStatus(403);
        $this->getJson('/api/shopify/status')->assertStatus(403);
    }

    public function test_writes_without_the_app_header_are_refused(): void
    {
        $this->actingAs($this->user());
        $this->postJson('/api/expenses', ['day' => '2026-10-01', 'category' => 'Misc', 'amount' => 5])->assertStatus(403)->assertJson(['error' => 'Bad request origin']);
        $this->assertSame(0, (int) Db::val('SELECT COUNT(*) FROM expenses'));
    }

    public function test_deactivated_user_is_logged_out(): void
    {
        $u = $this->user('cs');
        $u->update(['active' => false]);
        $this->actingAs($u)->getJson('/api/orders')->assertStatus(401);
    }

    public function test_phone_numbers_are_masked_without_customer_access(): void
    {
        Db::run("INSERT INTO orders(id,name,created_at,phone,cust_name,status,stage) VALUES('o1','#1',UTC_TIMESTAMP(),'03001234567','A','new','new')");
        $this->actingAs($this->user('warehouse'));
        $row = $this->getJson('/api/orders')->assertOk()->json('rows.0');
        $this->assertSame('0300•••67', $row['phone']);
    }

    public function test_settings_never_expose_shopify_secrets(): void
    {
        $this->actingAs($this->user());
        $json = $this->getJson('/api/settings')->assertOk()->getContent();
        $this->assertStringNotContainsString('test-client-secret', $json);
        $this->assertStringNotContainsString('test-client-id', $json);
        $this->assertStringContainsString('"hasSecret":true', $json);
        // the browser cannot set Shopify credentials
        $this->api('POST', '/api/settings', ['shopify' => ['clientSecret' => 'evil', 'shop' => 'evil.myshopify.com']])->assertOk();
        $this->assertSame('test-shop.myshopify.com', $this->getJson('/api/settings')->json('shopify.shop'));
    }

    public function test_data_persists_and_numbers_keep_their_type(): void
    {
        $this->actingAs($this->user());
        $this->api('POST', '/api/expenses', ['day' => '2026-10-01', 'category' => 'Misc', 'amount' => 1250.5, 'note' => 'tea'])->assertOk();
        $row = $this->getJson('/api/expenses?month=2026-10')->assertOk()->json('0');
        $this->assertSame(1250.5, $row['amount']);
        $this->assertSame('tea', $row['note']);
        $sum = $this->getJson('/api/finance/summary?month=2026-10')->json();
        $this->assertIsInt($sum['delivered']['n']);
    }

    public function test_shopify_ids_with_slashes_work_in_url_paths(): void
    {
        $id = 'gid://shopify/Order/123';
        Db::run("INSERT INTO orders(id,name,created_at,phone,cust_name,status,stage) VALUES(?,'#123',UTC_TIMESTAMP(),'03001234567','A','new','new')", $id);
        $this->actingAs($this->user());
        $this->getJson('/api/orders/'.rawurlencode($id))->assertOk()->assertJsonPath('order.id', $id);
        $this->api('POST', '/api/orders/'.rawurlencode($id).'/stage', ['stage' => 'hold'])->assertOk();
        $this->assertSame('hold', Db::val('SELECT stage FROM orders WHERE id=?', $id));
        $this->api('POST', '/api/orders/'.rawurlencode($id).'/note', ['note' => 'x'])->assertOk();
        $this->assertSame('order:'.$id, Db::val("SELECT entity FROM events WHERE action='note'"));
    }

    public function test_spa_shell_is_served_with_security_headers(): void
    {
        $this->actingAs($this->user());
        $this->get('/dashboard')->assertOk()->assertSee('erp/app.js')->assertHeader('X-Frame-Options', 'DENY')->assertHeader('Content-Security-Policy');
    }
}
