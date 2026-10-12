<?php

/*
| ERP JSON API (/api/*). Every module registers its own routes, in module order
| (first registration wins, as in the original Node router).
| These routes run in the "web" middleware group (session cookie login).
*/

use App\Erp\Erp;
use App\Erp\Router;

foreach (Erp::modules() as $module) {
    $module->routes(new Router($module));
}
