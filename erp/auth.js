/* SundayBazar ERP — login & registration pages. Talks to /api/login and /api/register (same session login as the ERP). */
'use strict';
(function () {
    // same light/dark choice as the ERP (stored by app.js)
    try {
        const t = JSON.parse(localStorage.getItem('sb_theme') || '"auto"');
        if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    } catch (_) { /* storage blocked: follow the system */ }

    const root = document.querySelector('.auth');
    const form = document.getElementById('auth-form');
    if (!root || !form) return;
    const mode = root.dataset.mode;
    const alertBox = document.getElementById('alert');
    const submit = document.getElementById('submit');
    const label = submit.querySelector('.auth-label');
    const idle = label.textContent;

    // password show/hide
    document.querySelectorAll('.auth-eye').forEach(btn => btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.for);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', String(show)); // swaps the eye icon (auth.css)
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        input.focus();
    }));

    const field = name => form.elements[name];
    const setErr = (name, msg) => {
        const input = field(name), box = document.getElementById(name + '-err');
        if (!input || !box) return false;
        box.textContent = msg || '';
        input.closest('.auth-field').classList.toggle('invalid', !!msg);
        input.setAttribute('aria-invalid', msg ? 'true' : 'false');
        return !!msg;
    };
    const showAlert = (msg, kind) => {
        alertBox.className = 'auth-alert' + (kind ? ' ' + kind : '');
        alertBox.textContent = msg;
        alertBox.hidden = !msg;
    };
    const busy = on => {
        submit.disabled = on;
        submit.classList.toggle('loading', on);
        submit.setAttribute('aria-busy', String(on));
        label.textContent = on ? (mode === 'register' ? 'Creating account…' : 'Logging in…') : idle;
    };

    const rules = {
        name: v => v.trim() ? '' : 'Enter your full name',
        email: v => !v.trim() ? 'Enter your e-mail' : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? '' : 'Enter a valid e-mail address'),
        username: v => v.trim() ? '' : 'Enter your e-mail or username',
        password: v => {
            if (!v) return 'Enter your password';
            if (mode !== 'register') return '';
            if (v.length < 8) return 'At least 8 characters';
            if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return 'Use at least one letter and one number';
            return '';
        },
        password_confirmation: v => !v ? 'Repeat the password' : (v === field('password').value ? '' : 'The two passwords are not the same'),
    };
    const validate = name => setErr(name, rules[name](field(name).value));
    Object.keys(rules).forEach(name => {
        const input = field(name);
        if (!input) return;
        input.addEventListener('blur', () => { if (input.value) validate(name); });
        input.addEventListener('input', () => { if (input.closest('.auth-field').classList.contains('invalid')) validate(name); });
    });

    const next = () => {
        const p = new URLSearchParams(location.search).get('next') || '';
        return /^\/(dashboard|admin)(#.*)?$/.test(p) ? p : null; // only our own pages
    };

    form.addEventListener('submit', async e => {
        e.preventDefault();
        showAlert('');
        const names = Object.keys(rules).filter(n => field(n));
        const bad = names.filter(validate);
        if (bad.length) { field(bad[0]).focus(); return; }
        const body = {};
        names.forEach(n => { body[n] = field(n).value; });
        if (mode !== 'register') body.remember = !!(field('remember') && field('remember').checked);
        busy(true);
        let res, data = {};
        try {
            res = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-sb': '1' },
                body: JSON.stringify(body),
            });
            try { data = await res.json(); } catch (_) { data = {}; }
        } catch (_) {
            busy(false);
            return showAlert('Cannot reach the server. Check the connection and try again.');
        }
        if (res.ok) {
            if (data.pending) {
                busy(false);
                form.reset();
                form.hidden = true;
                return showAlert(data.message || 'Account created. Wait for the administrator to approve it.', 'ok');
            }
            label.textContent = 'Opening the ERP…';
            location.href = next() || data.redirect || '/dashboard';
            return;
        }
        busy(false);
        const msg = data.error || (res.status >= 500 ? 'Something went wrong on the server. Try again.' : 'Error ' + res.status);
        if (data.field && field(data.field)) {
            setErr(data.field, msg);
            field(data.field).focus();
        } else {
            showAlert(msg, res.status === 403 ? 'info' : '');
            if (res.status === 401) { field('password').value = ''; field('password').focus(); }
        }
    });

    (field('name') || field('username')).focus();
})();
