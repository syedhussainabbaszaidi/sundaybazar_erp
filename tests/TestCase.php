<?php

namespace Tests;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Sleep;

abstract class TestCase extends BaseTestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Sleep::fake(); // retries / throttling back-off without real waiting
        \App\Erp\Access::seed(); // roles & permissions, as erp:install does
    }

    protected function user(string $role = 'admin', ?array $perms = null): User
    {
        static $n = 0;
        $n++;
        $u = User::create(['name' => "User {$n}", 'username' => "user{$n}", 'email' => "user{$n}@example.com", 'password' => 'secret123', 'role' => $role, 'perms' => '[]', 'active' => true]);
        foreach ($perms ?? [] as $p) {
            \App\Erp\Db::run('INSERT INTO user_permissions(user_id,permission_key,effect) VALUES(?,?,?)', $u->id, $p, 'grant');
        }
        return $u;
    }

    /** JSON call to the ERP API as the browser app makes it (with the X-SB header). */
    protected function api(string $method, string $uri, array $body = [], ?User $as = null)
    {
        if ($as) {
            $this->actingAs($as);
        }
        return $this->json($method, $uri, $body, ['X-SB' => '1']);
    }
}
