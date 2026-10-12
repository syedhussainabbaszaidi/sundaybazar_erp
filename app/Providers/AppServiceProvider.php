<?php

namespace App\Providers;

use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        // behind a proxy / load balancer that ends HTTPS, still build https:// links (and secure cookies) when the
        // configured address is https
        if (str_starts_with((string) config('app.url'), 'https://')) {
            URL::forceScheme('https');
            config(['session.secure' => config('session.secure') ?? true]);
        }
    }
}
