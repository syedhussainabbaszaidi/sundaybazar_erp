<?php

use App\Http\Controllers\DeployHookController;
use App\Http\Controllers\PageController;
use App\Http\Middleware\ErpPage;
use Illuminate\Support\Facades\Route;

/*
| Pages. The ERP itself is a single-page app (public/erp/*.js) that talks to /api/* (routes/erp.php).
|   /login, /register  — sign in / sign up
|   /admin             — the ERP for super administrators and staff managers
|   /dashboard         — the ERP for everybody else
*/

Route::get('/', [PageController::class, 'root']);
Route::get('/login', [PageController::class, 'login'])->name('login');
Route::get('/register', [PageController::class, 'register'])->name('register');
Route::get('/dashboard', [PageController::class, 'app'])->middleware(ErpPage::class.':dashboard')->name('dashboard');
Route::get('/admin', [PageController::class, 'app'])->middleware(ErpPage::class.':admin')->name('admin');

// GitHub FTP deploy: migrate + erp:install + fresh caches (off unless ERP_DEPLOY_TOKEN is set)
Route::post('/deploy-hook', DeployHookController::class)->middleware('throttle:5,1');
