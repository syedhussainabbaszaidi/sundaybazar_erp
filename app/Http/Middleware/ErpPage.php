<?php

namespace App\Http\Middleware;

use App\Erp\Access;
use App\Erp\Modules\AccessModule;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Guards the ERP pages: not logged in (or blocked) -> /login?next=..., and /admin only for people who
 * manage staff (super administrators or the "users" permission); others are sent to /dashboard.
 */
class ErpPage
{
    public function handle(Request $request, Closure $next, string $area = 'dashboard'): Response
    {
        $user = Auth::user();
        if ($user && ! $user->active) {
            Auth::logout();
            $request->session()->invalidate();
            $user = null;
        }
        if (! $user) {
            return redirect('/login?next='.rawurlencode('/'.$request->path()));
        }
        if ($area === 'admin') {
            $perms = Access::userPerms(['id' => $user->id, 'role' => $user->role]);
            if (AccessModule::homeFor($perms, $user->role) !== '/admin') {
                return redirect('/dashboard');
            }
        }
        return $next($request);
    }
}
