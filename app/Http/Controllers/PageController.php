<?php

namespace App\Http\Controllers;

use App\Erp\Access;
use App\Erp\Modules\AccessModule;
use App\Erp\Settings;
use Illuminate\Support\Facades\Auth;

/** HTML pages: login, registration and the ERP single-page app (/admin, /dashboard). */
class PageController extends Controller
{
    private function version(string ...$files): string
    {
        return substr(md5(implode('', array_map(fn ($f) => (string) @filemtime(public_path('erp/'.$f)), $files))), 0, 8);
    }

    /** Where a logged-in person belongs */
    private function home(): string
    {
        $u = Auth::user();
        if (! $u || ! $u->active) {
            return '/login';
        }
        return AccessModule::homeFor(Access::userPerms(['id' => $u->id, 'role' => $u->role]), $u->role);
    }

    public function root()
    {
        return redirect($this->home());
    }

    public function login()
    {
        return $this->authPage('login');
    }

    public function register()
    {
        return $this->authPage('register');
    }

    private function authPage(string $mode)
    {
        if (Auth::check() && Auth::user()->active) {
            return redirect($this->home());
        }
        return response()->view('auth', [
            'mode' => $mode,
            'store' => Settings::get('store_name', 'SundayBazar') ?: 'SundayBazar',
            'registration' => config('erp.registration', 'approval'),
            'noAdmin' => Access::activeSupers() === 0,
            'v' => $this->version('auth.js', 'auth.css', 'app.css'),
        ])->header('Cache-Control', 'no-store');
    }

    /** The ERP app (same page for /admin and /dashboard; the menu shows what the person may use). */
    public function app()
    {
        app()->terminating(fn () => \App\Erp\AutoTick::kick());
        return response()->view('erp', ['v' => $this->version('pre.js', 'app.js', 'shopify.js', 'access.js', 'post.js', 'app.css')])->header('Cache-Control', 'no-store');
    }
}
