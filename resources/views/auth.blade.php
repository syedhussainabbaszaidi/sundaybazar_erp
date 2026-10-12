<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#10291f">
<title>{{ $mode === 'register' ? 'Create account' : 'Log in' }} · {{ $store }}</title>
@include('partials.icons')
<link rel="preload" href="{{ asset('erp/fonts/poppins-latin-400.woff2') }}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="{{ asset('erp/fonts/poppins-latin-600.woff2') }}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{{ asset('erp/app.css') }}?v={{ $v }}">
<link rel="stylesheet" href="{{ asset('erp/auth.css') }}?v={{ $v }}">
</head>
<body class="auth-body">
@php
    $check = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg>';
    $eye = '<svg class="i-show" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="i-hide" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17.6 17.6 0 01-3.2 4.1M6.6 6.6A17.4 17.4 0 002 12s3.6 7 10 7a9.7 9.7 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2M3 3l18 18"/></svg>';
@endphp
<main class="auth" data-mode="{{ $mode }}" data-registration="{{ $registration }}">
    <section class="auth-brand" aria-label="{{ $store }} ERP">
        <div class="auth-brand-in">
            <img class="auth-logo" src="{{ asset('sundaybazarlogo.png') }}" alt="Sunday Bazar" width="356" height="262">
            <p class="auth-kicker">ERP · Business OS</p>
            <h2>Orders, warehouse, listing, accounts and your team — in one place.</h2>
            <ul class="auth-points">
                <li><span>{!! $check !!}</span> Live Shopify orders, products and stock</li>
                <li><span>{!! $check !!}</span> Confirmation calls, dispatch and courier tracking</li>
                <li><span>{!! $check !!}</span> Accounts, expenses, HR and payroll</li>
                <li><span>{!! $check !!}</span> Every person sees only what their role allows</li>
            </ul>
        </div>
        <p class="auth-brand-foot">Secure staff access · {{ $store }}</p>
    </section>

    <section class="auth-panel">
        <div class="auth-mobile-logo"><img src="{{ asset('sundaybazarlogo.png') }}" alt="Sunday Bazar" width="356" height="262"></div>
        <div class="auth-card">
            @if ($mode === 'register')
                <h1>Create your account</h1>
                <p class="auth-sub">
                    @if ($registration === 'approval') After you sign up, an administrator approves your account and gives you access.
                    @else Sign up to start using the ERP. @endif
                </p>
            @else
                <h1>Welcome back</h1>
                <p class="auth-sub">Log in with your e-mail or username to continue.</p>
            @endif

            <div class="auth-alert" id="alert" role="alert" aria-live="assertive" hidden></div>

            @if ($mode === 'login' && $noAdmin)
                <div class="auth-alert info" role="status">
                    No administrator account exists yet. On the server, run<br><code>php artisan erp:admin owner --email=you@example.com</code>
                </div>
            @endif

            @if ($mode === 'register' && $registration === 'closed')
                <div class="auth-alert info" role="status">Registration is closed. Ask the administrator to create an account for you.</div>
                <p class="auth-switch"><a href="{{ url('/login') }}">Back to log in</a></p>
            @else
            <form id="auth-form" novalidate autocomplete="on">
                @if ($mode === 'register')
                    <div class="auth-field">
                        <label for="name">Full name <span class="req" aria-hidden="true">*</span></label>
                        <input id="name" name="name" type="text" autocomplete="name" required maxlength="120" placeholder="e.g. Ayesha Khan" aria-describedby="name-err">
                        <div class="auth-err" id="name-err"></div>
                    </div>
                    <div class="auth-field">
                        <label for="email">E-mail <span class="req" aria-hidden="true">*</span></label>
                        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="191" placeholder="you@example.com" aria-describedby="email-err">
                        <div class="auth-err" id="email-err"></div>
                    </div>
                @else
                    <div class="auth-field">
                        <label for="username">E-mail or username</label>
                        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="you@example.com" aria-describedby="username-err">
                        <div class="auth-err" id="username-err"></div>
                    </div>
                @endif

                <div class="auth-field">
                    <label for="password">Password @if ($mode === 'register')<span class="req" aria-hidden="true">*</span>@endif</label>
                    <div class="auth-pw">
                        <input id="password" name="password" type="password" autocomplete="{{ $mode === 'register' ? 'new-password' : 'current-password' }}" required placeholder="{{ $mode === 'register' ? 'At least 8 characters' : 'Your password' }}" aria-describedby="password-err{{ $mode === 'register' ? ' password-hint' : '' }}">
                        <button type="button" class="auth-eye" data-for="password" aria-label="Show password" aria-pressed="false">{!! $eye !!}</button>
                    </div>
                    @if ($mode === 'register')<div class="auth-hint" id="password-hint">At least 8 characters, with a letter and a number.</div>@endif
                    <div class="auth-err" id="password-err"></div>
                </div>

                @if ($mode === 'register')
                    <div class="auth-field">
                        <label for="password_confirmation">Confirm password <span class="req" aria-hidden="true">*</span></label>
                        <div class="auth-pw">
                            <input id="password_confirmation" name="password_confirmation" type="password" autocomplete="new-password" required placeholder="Repeat the password" aria-describedby="password_confirmation-err">
                            <button type="button" class="auth-eye" data-for="password_confirmation" aria-label="Show password" aria-pressed="false">{!! $eye !!}</button>
                        </div>
                        <div class="auth-err" id="password_confirmation-err"></div>
                    </div>
                @else
                    <div class="auth-row">
                        <label class="auth-check"><input type="checkbox" name="remember" id="remember"> Keep me signed in</label>
                        <span class="auth-forgot">Forgot it? Ask an administrator to reset it.</span>
                    </div>
                @endif

                <button type="submit" class="auth-submit" id="submit">
                    <span class="auth-spin" aria-hidden="true"></span>
                    <span class="auth-label">{{ $mode === 'register' ? 'Create account' : 'Log in' }}</span>
                </button>
            </form>

            @if ($mode === 'register')
                <p class="auth-switch">Already have an account? <a href="{{ url('/login') }}">Log in</a></p>
            @elseif ($registration !== 'closed')
                <p class="auth-switch">New staff member? <a href="{{ url('/register') }}">Create an account</a></p>
            @endif
            @endif
        </div>
        <p class="auth-foot">© {{ date('Y') }} {{ $store }} · ERP</p>
    </section>
</main>
<script src="{{ asset('erp/auth.js') }}?v={{ $v }}"></script>
</body>
</html>
