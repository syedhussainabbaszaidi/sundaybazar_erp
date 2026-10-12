<?php

namespace App\Models;

use App\Erp\Access;
use Illuminate\Foundation\Auth\User as Authenticatable;

/**
 * ERP staff login. Access is role based (App\Erp\Access); `perms` holds a JSON list that,
 * when not empty, replaces the role's default permissions.
 */
class User extends Authenticatable
{
    public $timestamps = false;

    protected $fillable = ['name', 'username', 'email', 'password', 'role', 'perms', 'active', 'registered_via'];

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return [
            'password' => 'hashed',
            'active' => 'boolean',
            'created_at' => 'datetime',
            'last_login' => 'datetime',
        ];
    }

    public function permissions(): array
    {
        return Access::userPerms($this->only(['role', 'perms']));
    }

    public function hasPerm(string $perm): bool
    {
        return in_array($perm, $this->permissions(), true);
    }
}
