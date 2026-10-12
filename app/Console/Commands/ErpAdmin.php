<?php

namespace App\Console\Commands;

use App\Erp\Access;
use App\Erp\Modules\AccessModule;
use App\Models\User;
use Illuminate\Console\Command;

/** Create the first super administrator (or reset an account's password) from the server terminal. */
class ErpAdmin extends Command
{
    protected $signature = 'erp:admin {username : login name, e.g. owner} {--email= : e-mail for login} {--name=Owner} {--password= : leave out to be asked (not stored in shell history)}';

    protected $description = 'Create a super administrator login, or reset the password of an existing account';

    public function handle(): int
    {
        Access::seed();
        $username = mb_strtolower(trim($this->argument('username')));
        $email = mb_strtolower(trim((string) $this->option('email')));
        if (! preg_match('/^[a-z0-9._-]{3,64}$/', $username)) {
            $this->error('Username: 3-64 letters, numbers, dots, dashes');
            return self::FAILURE;
        }
        if ($email !== '' && ! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->error('Not a valid e-mail address');
            return self::FAILURE;
        }
        $pw = $this->option('password') ?: $this->secret('Password (8+ characters, a letter and a number)');
        if ($e = AccessModule::passwordProblem($pw)) {
            $this->error($e);
            return self::FAILURE;
        }
        $u = User::where('username', $username)->first();
        if ($u) {
            $u->update(array_filter(['password' => $pw, 'active' => true, 'email' => $email ?: null], fn ($v) => $v !== null));
            $this->info("Password reset for {$username}".($u->role === 'admin' ? ' (super administrator)' : ''));
        } else {
            if ($email !== '' && User::where('email', $email)->exists()) {
                $this->error('An account with this e-mail already exists');
                return self::FAILURE;
            }
            User::create(['name' => $this->option('name'), 'username' => $username, 'email' => $email ?: null, 'password' => $pw, 'role' => 'admin', 'perms' => '[]', 'active' => true, 'registered_via' => 'admin']);
            $this->info("Super administrator {$username} created. Log in at ".rtrim((string) config('app.url'), '/').'/login');
        }
        \App\Erp\Activity::log(null, 'user.cli', 'user', $username);
        return self::SUCCESS;
    }
}
