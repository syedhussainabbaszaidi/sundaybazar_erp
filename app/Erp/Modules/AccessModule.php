<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;

/**
 * Login, logout, public registration, first owner setup, staff accounts, roles & permissions, activity log.
 *
 * Rules enforced here (not only in the screens):
 *  - nobody can give a permission or a role with permissions they do not have themselves;
 *  - only a super administrator can create, edit or assign super administrators;
 *  - nobody can change their own role, permissions or active state;
 *  - the last active super administrator cannot be blocked or moved to another role;
 *  - public registration never creates administrators (configurable default role, approval by default).
 */
class AccessModule extends Module
{
    public string $name = 'access';

    public function install(): void
    {
        Access::seed();
    }

    public function routes(Router $r): void
    {
        $r->post('/api/setup', null, 'setup');
        $r->post('/api/login', null, 'login');
        $r->post('/api/register', null, 'register');
        $r->get('/api/register', null, 'registerInfo');
        $r->post('/api/logout', null, 'logout');
        $r->post('/api/password', 'dashboard', 'password');
        $r->get('/api/users', 'users', 'usersList');
        $r->post('/api/users', 'users', 'userCreate');
        $r->post('/api/users/:id', 'users', 'userUpdate');
        $r->get('/api/roles', 'users', 'rolesList');
        $r->post('/api/roles', 'roles', 'roleCreate');
        $r->post('/api/roles/:key', 'roles', 'roleUpdate');
        $r->delete('/api/roles/:key', 'roles', 'roleDelete');
        $r->get('/api/events', 'audit', 'events');
    }

    public function activity(): array
    {
        return ['user.create' => 'Added staff account', 'user.update' => 'Changed staff account', 'user.register' => 'Registered', 'role.create' => 'Created role', 'role.update' => 'Changed role', 'role.delete' => 'Deleted role'];
    }

    public function counts(array $u): array
    {
        if (! $this->can($u, 'users')) {
            return [];
        }
        $n = (int) Db::val("SELECT COUNT(*) FROM users WHERE active=0 AND registered_via='self' AND last_login IS NULL");
        return $n ? ['staff' => $n] : [];
    }

    public function alerts(array $u): array
    {
        if (! $this->can($u, 'users')) {
            return [];
        }
        $n = (int) Db::val("SELECT COUNT(*) FROM users WHERE active=0 AND registered_via='self' AND last_login IS NULL");
        return $n ? [['level' => 'info', 'text' => "{$n} new registration(s) waiting for approval", 'href' => '#/staff/users']] : [];
    }

    /* ------------------------------------------------------------- helpers */

    /** Password rule shared by registration, staff accounts and password change. */
    public static function passwordProblem(?string $pw): ?string
    {
        $pw = (string) $pw;
        if (mb_strlen($pw) < 8) {
            return 'Password needs at least 8 characters';
        }
        if (! preg_match('/[A-Za-z]/', $pw) || ! preg_match('/\d/', $pw)) {
            return 'Password needs at least one letter and one number';
        }
        if (mb_strlen($pw) > 200) {
            return 'Password is too long';
        }
        return null;
    }

    private function fieldError(string $field, string $msg, int $code = 422): never
    {
        throw new HttpError($code, $msg, ['field' => $field]);
    }

    private function normEmail(?string $e): string
    {
        return mb_strtolower(trim((string) $e));
    }

    private function validEmail(string $e): bool
    {
        return (bool) filter_var($e, FILTER_VALIDATE_EMAIL) && mb_strlen($e) <= 191;
    }

    /** A free username made from a name or e-mail */
    private function makeUsername(string $from): string
    {
        $base = Str::slug(Str::before($from, '@'), '.') ?: 'user';
        $base = mb_substr($base, 0, 50);
        $u = $base;
        for ($i = 2; Db::get('SELECT id FROM users WHERE username=?', $u); $i++) {
            $u = $base.$i;
        }
        return $u;
    }

    private function isSuper(?array $u): bool
    {
        return $u && Access::isSuperRole($u['role'] ?? null);
    }

    /** Where to go after login */
    public static function homeFor(array $perms, string $role): string
    {
        return Access::isSuperRole($role) || in_array('users', $perms, true) ? '/admin' : '/dashboard';
    }

    /** Permissions $actor may hand out */
    private function grantable(array $actor): array
    {
        return $this->isSuper($actor) ? Access::all() : $actor['perms'];
    }

    private function checkRoleAssignable(array $actor, string $roleKey): void
    {
        $roles = Access::roles();
        $this->need(isset($roles[$roleKey]), 'Choose a role');
        $role = $roles[$roleKey];
        if ($role['super']) {
            $this->need($this->isSuper($actor), 'Only a super administrator can give the '.$role['label'].' role', 403);
        }
        $missing = array_diff($role['perms'], $this->grantable($actor));
        $this->need(! $missing, 'You cannot give a role with access you do not have yourself ('.implode(', ', array_slice($missing, 0, 5)).')', 403);
    }

    /** Clean grant/revoke lists from the request; grants limited to what the actor may hand out. */
    private function overridesFrom(array $b, array $actor, string $roleKey): array
    {
        $all = Access::all();
        $rolePerms = Access::roles()[$roleKey]['perms'] ?? [];
        if (isset($b['perms']) && is_array($b['perms']) && ! isset($b['grant']) && ! isset($b['revoke'])) {
            // the old screen sends the full ticked list: turn it into exceptions to the role
            $want = array_values(array_intersect($b['perms'], $all));
            $grant = array_values(array_diff($want, $rolePerms));
            $revoke = array_values(array_diff($rolePerms, $want, Access::BASE));
        } else {
            $grant = array_values(array_intersect((array) ($b['grant'] ?? []), $all));
            $revoke = array_values(array_intersect((array) ($b['revoke'] ?? []), $all));
        }
        $grant = array_values(array_diff($grant, $rolePerms));
        $revoke = array_values(array_intersect(array_diff($revoke, Access::BASE), $rolePerms));
        $bad = array_diff($grant, $this->grantable($actor));
        $this->need(! $bad, 'You cannot give access you do not have yourself ('.implode(', ', array_slice($bad, 0, 5)).')', 403);
        return ['grant' => $grant, 'revoke' => $revoke];
    }

    private function saveOverrides(int $userId, array $o): void
    {
        Db::run('DELETE FROM user_permissions WHERE user_id=?', $userId);
        foreach (['grant', 'revoke'] as $eff) {
            foreach ($o[$eff] as $p) {
                Db::run('INSERT INTO user_permissions(user_id,permission_key,effect) VALUES(?,?,?)', $userId, $p, $eff);
            }
        }
    }

    /** Environment bootstrap: ERP_ADMIN_EMAIL + ERP_ADMIN_PASSWORD create the first super admin once. */
    public function bootstrapAdminFromEnv(): ?string
    {
        $email = $this->normEmail(config('erp.admin_email'));
        $pw = (string) config('erp.admin_password');
        if ($email === '' || $pw === '' || Access::activeSupers() > 0) {
            return null;
        }
        if (! $this->validEmail($email) || self::passwordProblem($pw)) {
            return 'ERP_ADMIN_EMAIL / ERP_ADMIN_PASSWORD are not valid (password: 8+ characters with a letter and a number)';
        }
        $existing = User::where('email', $email)->first();
        if ($existing) {
            $existing->update(['role' => 'admin', 'active' => true]);
        } else {
            User::create(['name' => (string) (config('erp.admin_name') ?: 'Owner'), 'username' => $this->makeUsername($email), 'email' => $email, 'password' => $pw, 'role' => 'admin', 'perms' => '[]', 'active' => true, 'registered_via' => 'admin']);
        }
        $this->log(null, 'user.bootstrap', 'user', $email);
        return 'Administrator '.$email.' created from .env — remove ERP_ADMIN_PASSWORD from .env now.';
    }

    /* =========================================================== login & co */

    /** First owner account from the browser — only when ERP_SETUP_KEY is set (otherwise use php artisan erp:admin). */
    public function setup(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(! Db::get('SELECT id FROM users LIMIT 1'), 'Already set up', 403);
        $key = (string) config('erp.setup_key');
        $this->need($key !== '', 'Create the first administrator on the server: php artisan erp:admin', 403);
        $this->need(hash_equals($key, (string) ($b['key'] ?? '')), 'Wrong setup key. It is the ERP_SETUP_KEY value set on the server.', 403);
        $email = $this->normEmail($b['email'] ?? '');
        $this->need(trim((string) ($b['name'] ?? '')) !== '', 'Enter your name');
        $this->need($this->validEmail($email), 'Enter a valid e-mail address');
        if ($e = self::passwordProblem($b['password'] ?? '')) {
            $this->fieldError('password', $e);
        }
        $user = User::create(['name' => trim($b['name']), 'username' => trim((string) ($b['username'] ?? '')) !== '' ? mb_strtolower(trim($b['username'])) : $this->makeUsername($email),
            'email' => $email, 'password' => $b['password'], 'role' => 'admin', 'perms' => '[]', 'active' => true]);
        Auth::login($user);
        $req->session()->regenerate();
        $this->log($user->id, 'setup', 'user', $user->username);
        return ['ok' => true, 'redirect' => '/admin'];
    }

    public function login(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $login = mb_strtolower(trim((string) ($b['username'] ?? $b['email'] ?? $b['login'] ?? '')));
        $pw = (string) ($b['password'] ?? '');
        if ($login === '') {
            $this->fieldError('username', 'Enter your e-mail or username');
        }
        if ($pw === '') {
            $this->fieldError('password', 'Enter your password');
        }
        $key = 'login|'.$req->ip().'|'.$login;
        if (RateLimiter::tooManyAttempts($key, 8)) {
            $mins = (int) ceil(RateLimiter::availableIn($key) / 60);
            throw new HttpError(429, "Too many wrong passwords. Wait {$mins} minute(s) and try again.");
        }
        $field = str_contains($login, '@') ? 'email' : 'username';
        $row = User::where($field, $login)->first();
        if (! $row || ! Hash::check($pw, $row->password)) {
            RateLimiter::hit($key, 15 * 60);
            throw new HttpError(401, 'Wrong e-mail/username or password');
        }
        if (! $row->active) {
            RateLimiter::clear($key);
            $pending = $row->registered_via === 'self' && ! $row->last_login;
            throw new HttpError(403, $pending ? 'Your account is waiting for approval by the administrator.' : 'This account is blocked. Ask the administrator.');
        }
        RateLimiter::clear($key);
        Auth::login($row, ! empty($b['remember']));
        $req->session()->regenerate();
        Db::run('UPDATE users SET last_login=UTC_TIMESTAMP() WHERE id=?', $row->id);
        $this->log($row->id, 'login', 'user', $row->username);
        $perms = Access::userPerms(['id' => $row->id, 'role' => $row->role]);
        return ['ok' => true, 'redirect' => self::homeFor($perms, $row->role)];
    }

    public function registerInfo(): array
    {
        $mode = config('erp.registration', 'approval');
        return ['mode' => $mode, 'open' => $mode !== 'closed', 'approval' => $mode === 'approval', 'store' => $this->setting('store_name', 'SundayBazar')];
    }

    public function register(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $mode = config('erp.registration', 'approval');
        $this->need($mode !== 'closed', 'Registration is closed. Ask the administrator for an account.', 403);
        $key = 'register|'.$req->ip();
        $this->need(! RateLimiter::tooManyAttempts($key, 5), 'Too many registrations from this connection. Try again later.', 429);
        $name = trim((string) ($b['name'] ?? ''));
        $email = $this->normEmail($b['email'] ?? '');
        $pw = (string) ($b['password'] ?? '');
        if ($name === '' || mb_strlen($name) > 120) {
            $this->fieldError('name', 'Enter your full name');
        }
        if (! $this->validEmail($email)) {
            $this->fieldError('email', 'Enter a valid e-mail address');
        }
        if ($e = self::passwordProblem($pw)) {
            $this->fieldError('password', $e);
        }
        if ($pw !== (string) ($b['password_confirmation'] ?? '')) {
            $this->fieldError('password_confirmation', 'The two passwords are not the same');
        }
        if (User::where('email', $email)->exists()) {
            $this->fieldError('email', 'An account with this e-mail already exists. Log in instead.', 409);
        }
        $role = (string) config('erp.registration_role', 'staff');
        if (! isset(Access::roles()[$role]) || Access::isSuperRole($role)) {
            $role = 'staff'; // public registration never creates administrators
        }
        RateLimiter::hit($key, 3600);
        $active = $mode === 'open';
        $user = User::create(['name' => $name, 'username' => $this->makeUsername($email), 'email' => $email, 'password' => $pw, 'role' => $role, 'perms' => '[]', 'active' => $active, 'registered_via' => 'self']);
        $this->log($user->id, 'user.register', 'user:'.$user->id, ['email' => $email, 'role' => $role, 'active' => $active]);
        if ($active) {
            Auth::login($user);
            $req->session()->regenerate();
            Db::run('UPDATE users SET last_login=UTC_TIMESTAMP() WHERE id=?', $user->id);
            return ['ok' => true, 'pending' => false, 'redirect' => '/dashboard'];
        }
        return ['ok' => true, 'pending' => true, 'message' => 'Account created. The administrator has to approve it before you can log in.'];
    }

    public function logout(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        Auth::guard('web')->logout();
        $req->session()->invalidate();
        $req->session()->regenerateToken();
        return ['ok' => true, 'redirect' => '/login'];
    }

    public function password(?array $u, array $b): array
    {
        $me = Db::get('SELECT * FROM users WHERE id=?', $u['id']);
        $this->need(Hash::check((string) ($b['old'] ?? ''), $me['password']), 'Current password is wrong');
        if ($e = self::passwordProblem($b['new'] ?? '')) {
            $this->need(false, $e);
        }
        Db::run('UPDATE users SET password=?, updated_at=UTC_TIMESTAMP() WHERE id=?', Hash::make($b['new']), $u['id']);
        Db::run('DELETE FROM sessions WHERE user_id=? AND id<>?', $u['id'], session()->getId()); // log out other devices
        $this->log($u['id'], 'password.change', 'user:'.$u['id'], '');
        return ['ok' => true];
    }

    /* ========================================================== staff accounts */

    private function userRow(array $x): array
    {
        $o = Access::overrides((int) $x['id']);
        unset($x['password'], $x['remember_token']);
        return array_merge($x, ['perms' => Access::userPerms($x), 'grant' => $o['grant'], 'revoke' => $o['revoke'], 'super' => Access::isSuperRole($x['role']),
            'pending' => ! $x['active'] && $x['registered_via'] === 'self' && ! $x['last_login']]);
    }

    public function usersList(): array
    {
        return array_map(fn ($x) => $this->userRow($x),
            Db::all('SELECT id,name,username,email,role,perms,active,registered_via,created_at,last_login FROM users ORDER BY active DESC, name'));
    }

    public function userCreate(?array $u, array $b): array
    {
        $name = trim((string) ($b['name'] ?? ''));
        $email = $this->normEmail($b['email'] ?? '');
        $username = mb_strtolower(trim((string) ($b['username'] ?? '')));
        if ($name === '') {
            $this->fieldError('name', 'Enter the name');
        }
        if ($email !== '' && ! $this->validEmail($email)) {
            $this->fieldError('email', 'Enter a valid e-mail address');
        }
        if ($username === '' && $email === '') {
            $this->fieldError('username', 'Enter a username or an e-mail address for login');
        }
        if ($username !== '' && ! preg_match('/^[a-z0-9._-]{3,64}$/', $username)) {
            $this->fieldError('username', 'Username: 3-64 letters, numbers, dots, dashes');
        }
        if ($e = self::passwordProblem($b['password'] ?? '')) {
            $this->fieldError('password', $e);
        }
        $role = (string) ($b['role'] ?? '');
        $this->checkRoleAssignable($u, $role);
        if ($username !== '') {
            $this->need(! Db::get('SELECT id FROM users WHERE username=?', $username), 'That username is taken', 409, ['field' => 'username']);
        }
        if ($email !== '') {
            $this->need(! Db::get('SELECT id FROM users WHERE email=?', $email), 'An account with this e-mail already exists', 409, ['field' => 'email']);
        }
        $o = $this->overridesFrom($b, $u, $role);
        $id = Db::tx(function () use ($name, $username, $email, $b, $role, $o) {
            $user = User::create(['name' => $name, 'username' => $username !== '' ? $username : $this->makeUsername($email), 'email' => $email ?: null, 'password' => $b['password'],
                'role' => $role, 'perms' => '[]', 'active' => true, 'registered_via' => 'admin']);
            $this->saveOverrides($user->id, $o);
            return $user->id;
        });
        Access::flush();
        $this->log($u['id'], 'user.create', 'user:'.$id, ['username' => $username ?: $email, 'role' => $role, 'grant' => $o['grant'], 'revoke' => $o['revoke']]);
        return ['ok' => true, 'id' => $id];
    }

    public function userUpdate(?array $u, array $b, array $p): array
    {
        $t = Db::get('SELECT * FROM users WHERE id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        $self = (int) $t['id'] === $u['id'];
        $targetSuper = Access::isSuperRole($t['role']);
        $this->need(! $targetSuper || $this->isSuper($u), 'Only a super administrator can change a super administrator', 403);

        $role = array_key_exists('role', $b) && $b['role'] !== null && $b['role'] !== '' ? (string) $b['role'] : $t['role'];
        $active = array_key_exists('active', $b) ? ($b['active'] !== false && $b['active'] !== 0 && $b['active'] !== '0') : (bool) $t['active'];
        $accessChange = $role !== $t['role'] || $active !== (bool) $t['active'] || isset($b['perms']) || isset($b['grant']) || isset($b['revoke']);
        if ($self && $accessChange) {
            $cur = Access::overrides((int) $t['id']);
            $o = isset($b['perms']) || isset($b['grant']) || isset($b['revoke']) ? $this->overridesFrom($b, $u, $role) : $cur;
            $same = $role === $t['role'] && $active === (bool) $t['active'] && ! array_diff($o['grant'], $cur['grant']) && ! array_diff($cur['grant'], $o['grant'])
                && ! array_diff($o['revoke'], $cur['revoke']) && ! array_diff($cur['revoke'], $o['revoke']);
            $this->need($same, 'You cannot change your own role, access or status. Ask another administrator.', 403);
            $accessChange = false;
        }
        if ($role !== $t['role']) {
            $this->checkRoleAssignable($u, $role);
        }
        // never leave the ERP without an active super administrator
        if ($targetSuper && (! $active || ! Access::isSuperRole($role))) {
            $this->need(Access::activeSupers((int) $t['id']) > 0, 'This is the last active super administrator: it cannot be blocked or moved to another role', 409);
        }
        $name = trim((string) ($b['name'] ?? '')) ?: $t['name'];
        $email = array_key_exists('email', $b) ? $this->normEmail($b['email']) : (string) $t['email'];
        if ($email !== '' && ! $this->validEmail($email)) {
            $this->fieldError('email', 'Enter a valid e-mail address');
        }
        if ($email !== '' && $email !== (string) $t['email']) {
            $this->need(! Db::get('SELECT id FROM users WHERE email=? AND id<>?', $email, $t['id']), 'An account with this e-mail already exists', 409, ['field' => 'email']);
        }
        if (! empty($b['password']) && ($e = self::passwordProblem($b['password']))) {
            $this->fieldError('password', $e);
        }
        Db::tx(function () use ($t, $name, $email, $role, $active, $b, $u, $accessChange) {
            Db::run('UPDATE users SET name=?, email=?, role=?, active=?, updated_at=UTC_TIMESTAMP() WHERE id=?', $name, $email !== '' ? $email : null, $role, $active ? 1 : 0, $t['id']);
            if ($accessChange && (isset($b['perms']) || isset($b['grant']) || isset($b['revoke']) || $role !== $t['role'])) {
                $o = isset($b['perms']) || isset($b['grant']) || isset($b['revoke']) ? $this->overridesFrom($b, $u, $role) : ['grant' => [], 'revoke' => []];
                $this->saveOverrides((int) $t['id'], $o);
            }
            if (! empty($b['password'])) {
                Db::run('UPDATE users SET password=? WHERE id=?', Hash::make($b['password']), $t['id']);
            }
        });
        Access::flush();
        if (! $active || ! empty($b['password']) || $role !== $t['role']) {
            Db::run('DELETE FROM sessions WHERE user_id=?', $t['id']); // log the person out everywhere
            Db::run('UPDATE users SET remember_token=NULL WHERE id=?', $t['id']);
        }
        $this->log($u['id'], 'user.update', 'user:'.$t['id'], ['role' => $role, 'from_role' => $t['role'], 'active' => $active, 'password' => ! empty($b['password']),
            'approved' => ! $t['active'] && $active && $t['registered_via'] === 'self' ? true : null] + (isset($b['grant']) || isset($b['revoke']) || isset($b['perms']) ? Access::overrides((int) $t['id']) : []));
        return ['ok' => true];
    }

    /* =================================================================== roles */

    public function rolesList(): array
    {
        $out = [];
        foreach (Access::roles() as $k => $r) {
            $out[] = ['key' => $k, 'name' => $r['label'], 'description' => $r['desc'], 'perms' => $r['perms'], 'super' => $r['super'], 'system' => $r['system'], 'users' => $r['users']];
        }
        return ['roles' => $out, 'perms' => Access::perms(), 'base' => Access::BASE];
    }

    private function cleanRolePerms(array $b, array $actor): array
    {
        $want = array_values(array_intersect((array) ($b['perms'] ?? []), Access::all()));
        $bad = array_diff($want, $this->grantable($actor));
        $this->need(! $bad, 'You cannot give a role access you do not have yourself ('.implode(', ', array_slice($bad, 0, 5)).')', 403);
        return array_values(array_diff($want, Access::BASE));
    }

    public function roleCreate(?array $u, array $b): array
    {
        $name = trim((string) ($b['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 80) {
            $this->fieldError('name', 'Enter a role name');
        }
        $key = Str::slug((string) (($b['key'] ?? '') ?: $name), '_');
        $key = mb_substr($key, 0, 32);
        $this->need($key !== '' && ! isset(Access::roles()[$key]), 'A role with this name already exists', 409, ['field' => 'name']);
        $perms = $this->cleanRolePerms($b, $u);
        Db::tx(function () use ($key, $name, $b, $perms) {
            Db::run('INSERT INTO roles(`key`,name,description,is_system,is_super,created_at) VALUES(?,?,?,0,0,UTC_TIMESTAMP())', $key, $name, mb_substr(trim((string) ($b['description'] ?? '')), 0, 255));
            foreach ($perms as $pk) {
                Db::run('INSERT INTO role_permissions(role_key,permission_key) VALUES(?,?)', $key, $pk);
            }
        });
        Access::flush();
        $this->log($u['id'], 'role.create', 'role:'.$key, ['name' => $name, 'perms' => $perms]);
        return ['ok' => true, 'key' => $key];
    }

    public function roleUpdate(?array $u, array $b, array $p): array
    {
        $role = Access::roles()[$p['key']] ?? null;
        $this->need($role, 'Not found', 404);
        $this->need(! $role['super'], 'The super administrator role always has every permission', 400);
        $this->need($this->isSuper($u) || $u['role'] !== $p['key'], 'You cannot change your own role. Ask another administrator.', 403);
        $this->need($this->isSuper($u) || ! array_diff($role['perms'], $u['perms']), 'This role has access you do not have; only a super administrator can change it', 403);
        $name = trim((string) ($b['name'] ?? '')) ?: $role['label'];
        $perms = array_key_exists('perms', $b) ? $this->cleanRolePerms($b, $u) : null;
        Db::tx(function () use ($p, $name, $b, $role, $perms) {
            Db::run('UPDATE roles SET name=?, description=?, updated_at=UTC_TIMESTAMP() WHERE `key`=?', $name, mb_substr(trim((string) ($b['description'] ?? $role['desc'])), 0, 255), $p['key']);
            if ($perms !== null) {
                Db::run('DELETE FROM role_permissions WHERE role_key=?', $p['key']);
                foreach ($perms as $pk) {
                    Db::run('INSERT INTO role_permissions(role_key,permission_key) VALUES(?,?)', $p['key'], $pk);
                }
                // personal exceptions that now match the role are no longer exceptions
                Db::run('DELETE up FROM user_permissions up JOIN users us ON us.id=up.user_id WHERE us.role=? AND ((up.effect=\'grant\' AND up.permission_key IN (SELECT permission_key FROM role_permissions WHERE role_key=?))
                    OR (up.effect=\'revoke\' AND up.permission_key NOT IN (SELECT permission_key FROM role_permissions WHERE role_key=?)))', $p['key'], $p['key'], $p['key']);
            }
        });
        Access::flush();
        $this->log($u['id'], 'role.update', 'role:'.$p['key'], ['name' => $name, 'perms' => $perms, 'before' => $role['perms']]);
        return ['ok' => true];
    }

    public function roleDelete(?array $u, array $b, array $p): array
    {
        $role = Access::roles()[$p['key']] ?? null;
        $this->need($role, 'Not found', 404);
        $this->need(! $role['system'], 'Built-in roles cannot be deleted (you can change their permissions)', 400);
        $this->need(! $role['users'], 'Move the '.$role['users'].' person(s) with this role to another role first', 409);
        Db::run('DELETE FROM roles WHERE `key`=?', $p['key']);
        Access::flush();
        $this->log($u['id'], 'role.delete', 'role:'.$p['key'], $role);
        return ['ok' => true];
    }

    /* ============================================================ activity log */

    public function events(?array $u, array $b, array $p, array $qs): array
    {
        $ent = $qs['entity'] ?? '';
        return Db::all('SELECT e.*, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id '.($ent !== '' ? 'WHERE e.entity=? ' : '').'ORDER BY e.id DESC LIMIT 300', ...($ent !== '' ? [$ent] : []));
    }
}
