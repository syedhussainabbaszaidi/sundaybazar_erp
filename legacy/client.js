<script>/* SundayBazar ERP — staff app (runs in any browser on the office WiFi) */
'use strict';
const $ = s => document.querySelector(s);
/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs)
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false)
                continue;
            if (k.startsWith('on') && typeof v === 'function')
                el.addEventListener(k.slice(2), v);
            else if (k === 'class')
                el.className = v;
            else if (k === 'style' && typeof v === 'object')
                Object.assign(el.style, v);
            else if (k === 'value')
                el.value = v;
            else if (k === 'checked' || k === 'disabled' || k === 'selected')
                el[k] = !!v;
            else
                el.setAttribute(k, v === true ? '' : v);
        }
    for (const k of kids.flat(Infinity))
        if (k != null && k !== false)
            el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
}
async function api(method, path, body) {
    let r;
    try {
        r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'x-sb': '1' }, body: body ? JSON.stringify(body) : undefined });
    }
    catch (_a) {
        throw new Error('Server se rabta nahi hua — WiFi/internet check karein aur dobara try karein.');
    }
    let j = null;
    try {
        j = await r.json();
    }
    catch (_b) { }
    if (r.status === 401 && !path.startsWith('/api/login')) {
        location.hash = '';
        boot();
        throw new Error('Please log in');
    }
    if (!r.ok)
        throw new Error(apiErrText(r.status, j && j.error, path));
    return j;
}
// friendlier error texts for staff (403 = no access, 5xx = server problem)
function apiErrText(status, msg, path) {
    const NOACCESS = 'Aap ke paas is ka access nahi — owner se kahein';
    if (status === 403 && !/^\/api\/(login|setup)/.test(path || ''))
        return !msg || /does not have access/i.test(msg) ? NOACCESS : msg + ' — owner se kahein';
    if (status >= 500)
        return (msg ? msg + ' — ' : '') + 'Server mein masla aaya. Dobara try karein; phir bhi na chale to owner ko batayein.';
    return msg || ('Error ' + status);
}
const GET = p => api('GET', p), POST = (p, b) => api('POST', p, b || {});
const rs = v => v == null || isNaN(v) ? '–' : (v < 0 ? '−Rs ' : 'Rs ') + Math.abs(Math.round(+v)).toLocaleString('en-PK');
const num = v => v == null ? '–' : (+v).toLocaleString('en-PK');
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
const dt = s => { if (!s)
    return ''; const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const day = s => { if (!s)
    return ''; const d = new Date(s.length <= 10 ? s + 'T00:00:00' : s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
const ago = s => { if (!s)
    return 'never'; const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z'); const m = Math.round((Date.now() - d) / 60000); if (m < 1)
    return 'just now'; if (m < 60)
    return m + ' min ago'; const hh = Math.round(m / 60); if (hh < 48)
    return hh + ' h ago'; return Math.round(hh / 24) + ' days ago'; };
const qs = o => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
function toast(msg, bad) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.body.append(t); setTimeout(() => t.remove(), bad ? 7000 : 3500); }
async function act(fn, okMsg) { try {
    const r = await fn();
    if (okMsg)
        toast(okMsg);
    return r;
}
catch (e) {
    toast(e.message, true);
    throw e;
} }
const can = p => ME && ME.perms.includes(p);
const STATUS_CLS = { delivered: 'ok', return_received: 'muted', returned: 'bad', returning: 'bad', cancelled: 'bad', cs_cancelled: 'bad', courier_cancelled: 'bad', attempted: 'warn', hold: 'warn', new: 'info', confirmed: 'info' };
const statusB = s => h('span', { class: 'b ' + (STATUS_CLS[s] || '') }, (META.statuses || {})[s] || s);
const LABEL_CLS = { Trusted: 'ok', Good: 'info', New: '', Risky: 'warn', Blacklisted: 'bad' };
const labelB = l => h('span', { class: 'b ' + (LABEL_CLS[l || 'New'] || '') }, l || 'New');
const hist = (d, r) => (d || r) ? `${d || 0} delivered · ${r || 0} returned` : 'first order';
function modal(title, body, actions) {
    const m = h('div', { class: 'modal', onclick: e => { if (e.target === m)
            m.remove(); } }, h('div', { class: 'in' }, h('div', { class: 'row sp' }, h('strong', { class: 'big', style: { fontSize: '17px' } }, title), h('button', { class: 'btn ghost sm', onclick: () => m.remove() }, 'Close')), body, actions ? h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, actions) : null));
    document.body.append(m);
    const f = m.querySelector('input,select,textarea');
    if (f)
        f.focus();
    return m;
}
function drawer(content) {
    const d = h('div', { class: 'drawer', onclick: e => { if (e.target === d)
            d.remove(); } }, h('div', { class: 'in' }, content));
    document.body.append(d);
    return d;
}
const EMPTY_TEXT = 'Nothing to do here right now ✓';
function table(cols, rows, onRow) {
    if (!rows.length)
        return h('div', { class: 'empty' }, EMPTY_TEXT);
    return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.n ? 'n' : '' }, c.t)))), h('tbody', null, rows.map(r => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? (e => { if (!e.target.closest('button,input,a,select'))
            onRow(r); }) : null }, cols.map(c => h('td', { class: (c.n ? 'n ' : '') + (c.cls || '') }, c.f ? c.f(r) : r[c.k])))))));
}
function pager(d, go) {
    if (!d.pages || d.pages <= 1)
        return h('div', { class: 'pager muted' }, num(d.total) + ' total');
    return h('div', { class: 'pager' }, h('span', { class: 'muted' }, `${num(d.total)} total · page ${d.page} of ${d.pages}`), h('button', { class: 'btn ghost sm', disabled: d.page <= 1, onclick: () => go(d.page - 1) }, '‹ Prev'), h('button', { class: 'btn ghost sm', disabled: d.page >= d.pages, onclick: () => go(d.page + 1) }, 'Next ›'));
}
function tabs(list, cur, go) { return h('div', { class: 'tabs' }, list.map(([k, l, n]) => h('a', { class: k === cur ? 'on' : '', onclick: () => go(k) }, l, n != null ? h('span', { class: 'n' }, n) : null))); }
function kpi(l, v, s, cls, href) { return h(href ? 'a' : 'div', { class: 'kpi ' + (cls || ''), href }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null); }
function bar(p) { return h('div', { class: 'bar', title: Math.round(p) + '%' }, h('i', { style: { width: Math.max(0, Math.min(100, p)) + '%' } })); }
const field = (label, input) => h('label', { class: 'f' }, label, input);
const waLink = (n, text) => 'https://wa.me/' + n + (text ? '?text=' + encodeURIComponent(text) : '');
/* simple bar chart (stacked) */
function chart(data, xKey, series, height = 180) {
    if (!data.length)
        return h('div', { class: 'empty' }, 'No data yet — numbers will show here once there is work.');
    const W = 720, H = height, pad = 26, bw = (W - pad) / data.length;
    const max = Math.max(1, ...data.map(d => series.reduce((s, se) => s + (+d[se.k] || 0), 0)));
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 20}`);
    svg.setAttribute('class', 'chart');
    const mk = (t, a) => { const e = document.createElementNS(ns, t); for (const k in a)
        e.setAttribute(k, a[k]); return e; };
    for (let g = 0; g <= 2; g++) {
        const y = H - (H - 10) * g / 2;
        svg.append(mk('line', { x1: pad, x2: W, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': .1 }));
        const t = mk('text', { x: 0, y: y + 4 });
        t.textContent = Math.round(max * g / 2).toLocaleString();
        svg.append(t);
    }
    data.forEach((d, i) => {
        let y = H;
        const x = pad + i * bw + bw * 0.15, w = bw * 0.7;
        for (const se of series) {
            const v = +d[se.k] || 0;
            const hh = (H - 10) * v / max;
            y -= hh;
            const r = mk('rect', { x, y, width: w, height: Math.max(0, hh), fill: se.c, rx: 2 });
            const tt = mk('title', {});
            tt.textContent = `${d[xKey]} · ${se.l}: ${v.toLocaleString()}`;
            r.append(tt);
            svg.append(r);
        }
        if (data.length <= 16 || i % Math.ceil(data.length / 12) === 0) {
            const t = mk('text', { x: x + w / 2, y: H + 15, 'text-anchor': 'middle' });
            t.textContent = String(d[xKey]).slice(5);
            svg.append(t);
        }
    });
    return h('div', null, svg, h('div', { class: 'legend' }, series.map(se => h('span', null, h('i', { style: { background: se.c } }), se.l))));
}
const C1 = '#1d3b2f', C2 = '#c8572a', C3 = '#7fa58f', C4 = '#d9a441';
/* ---------- icons ---------- */
const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z', pipeline: 'M4 6h16M4 12h10M4 18h6', cart: 'M3 4h2l2.4 11h11l2-8H6.2M9 20a1 1 0 100-2 1 1 0 000 2zm9 0a1 1 0 100-2 1 1 0 000 2z',
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z', people: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6zm13 9v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8',
    truck: 'M2 6h11v9H2zM13 9h4l4 4v2h-8zM6 19a2 2 0 100-4 2 2 0 000 4zm11 0a2 2 0 100-4 2 2 0 000 4z', box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01', layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
    wallet: 'M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H3zM3 7l13-3v3M17 14h.01', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    key: 'M15 7a4 4 0 11-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0115 7z', book: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3zM4 17a3 3 0 013-3h11', receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4',
    cash: 'M2 6h20v12H2zM12 15a3 3 0 100-6 3 3 0 000 6zM6 12h.01M18 12h.01', megaphone: 'M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1zM15 9a3 3 0 010 6M18 6a7 7 0 010 12',
    user: 'M20 21v-1a5 5 0 00-5-5H9a5 5 0 00-5 5v1M12 11a4 4 0 100-8 4 4 0 000 8z', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2', check: 'M4 12l5 5L20 6',
    ticket: 'M3 7a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4zM13 5v14', swap: 'M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
    scan: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M11 8v8M15 8v8M18 8v8', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0',
    team: 'M17 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M10 11a4 4 0 100-8 4 4 0 000 8zM21 20v-1a4 4 0 00-3-3.9', alert: 'M12 3l10 18H2zM12 10v4M12 18h.01', bank: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18',
    doc: 'M6 2h9l5 5v15H6zM14 2v6h6', moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z', logout: 'M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 17l5-5-5-5M15 12H3', menu: 'M3 6h18M3 12h18M3 18h18', chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5', help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17h.01', search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
};
function icon(name, size = 18) {
    const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('class', 'ic');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.list);
    s.append(p);
    return s;
}
/* ---------- view registry ----------
   Each screen file calls registerView({ key, title, group, perm, icon, order }, async (args) => { ... render(...) })   */
const VIEWS = {}, NAVREG = [], TOPWIDGETS = [];
// menu follows the business: buy lots → stock line (GRN, sort, list, photos, upload) → warehouse → orders & CS → dispatch → tracking → money
const GROUPS = ['Overview', 'Buying', 'Stock line', 'Warehouse', 'Orders & CS', 'Dispatch', 'Tracking', 'Finance', 'Marketing', 'People', 'Admin'];
// screen each role lands on after login (when allowed): owner/manager → Home, rider → his deliveries app,
// every other staff member → My day (their work launcher with big tiles for their own screens)
const ROLE_HOME = { admin: 'home', manager: 'home', rider: 'rider' };
const isBoss = () => !!ME && (ME.role === 'admin' || ME.role === 'manager');
function registerView(meta, fn) { VIEWS[meta.key] = fn; const i = NAVREG.findIndex(n => n.key === meta.key); if (i >= 0)
    NAVREG.splice(i, 1); if (!meta.hidden)
    NAVREG.push(meta);
else
    VIEWS['__hidden_' + meta.key] = meta; }
function registerTopWidget(fn) { TOPWIDGETS.push(fn); }
/* cards on the 'My day' page (every staff member): registerMeCard({ key, order, perm }, async () => node|null) */
const MECARDS = [];
function registerMeCard(meta, fn) { MECARDS.push(Object.assign(Object.assign({}, meta), { fn })); }
const permOk = p => !p || (Array.isArray(p) ? p.some(x => can(x)) : can(p));
const viewAllowed = k => { const m = NAVREG.find(n => n.key === k) || VIEWS['__hidden_' + k]; return m && VIEWS[k] && permOk(m.perm); };
const viewMeta = k => NAVREG.find(n => n.key === k) || VIEWS['__hidden_' + k];
// in the side menu: allowed by permission, and (meta.roles) only for those roles — e.g. the rider app is not in the owner's menu (still opens by URL)
const inMenu = n => permOk(n.perm) && (!n.roles || n.roles.includes(ME.role));
/* ---------- boot, login, shell ---------- */
let META = null, ME = null;
const store = { get(k, d) { try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
    }
    catch (_a) {
        return d;
    } }, set(k, v) { try {
        localStorage.setItem(k, JSON.stringify(v));
    }
    catch (_a) { } } };
function applyTheme() { const t = store.get('sb_theme', 'auto'); if (t === 'auto')
    document.documentElement.removeAttribute('data-theme');
else
    document.documentElement.setAttribute('data-theme', t); }
applyTheme();
async function boot() {
    META = await GET('/api/state');
    ME = META.user;
    const root = $('#root');
    root.replaceChildren();
    if (META.setup)
        return setupView(root);
    if (!ME)
        return loginView(root);
    shell(root);
    route();
}
function authCard(title, sub, form) {
    return h('div', { class: 'login' }, h('div', { class: 'login-art' }, h('div', { class: 'brandmark' }, 'SB'), h('h2', null, META.store || 'SundayBazar'), h('p', null, 'Orders, warehouse, listing, accounts, marketing and your team — in one place.')), h('div', { class: 'login-form' }, h('form', { class: 'card', onsubmit: form.onsubmit }, h('h1', null, title), h('div', { class: 'muted' }, sub), ...form.kids)));
}
function loginView(root) {
    const u = h('input', { placeholder: 'Username', autocomplete: 'username' }), p = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const err = h('div', { class: 'flash bad', hidden: true });
    const go = async (e) => { e.preventDefault(); try {
        await POST('/api/login', { username: u.value, password: p.value });
        boot();
    }
    catch (x) {
        err.hidden = false;
        err.textContent = x.message;
    } };
    root.append(authCard('Log in', 'Use the username the owner gave you.', { onsubmit: go, kids: [window.SB_OFFLINE ? h('div', { class: 'note' }, 'Offline copy: username owner, password owner123') : null, err, field('Username', u), field('Password', p), h('button', { class: 'btn big' }, 'Log in')] }));
    u.focus();
}
function setupView(root) {
    const n = h('input', { placeholder: 'Your name' }), u = h('input', { placeholder: 'e.g. owner' }), p = h('input', { type: 'password', placeholder: '6+ characters' }), k = h('input', { placeholder: 'SB_SETUP_KEY from the server settings' });
    const err = h('div', { class: 'flash bad', hidden: true });
    const go = async (e) => { e.preventDefault(); try {
        await POST('/api/setup', { name: n.value, username: u.value, password: p.value, key: k.value });
        location.hash = '#/settings';
        boot();
    }
    catch (x) {
        err.hidden = false;
        err.textContent = x.message;
    } };
    root.append(authCard('Welcome', 'Create the owner account. You can add staff after this.', { onsubmit: go, kids: [err, META.setupKey ? field('Setup key', k) : null, field('Your name', n), field('Username', u), field('Password', p), h('button', { class: 'btn big' }, 'Create owner account')] }));
    n.focus();
}
let content, titleEl, crumbEl, syncEl, sideEl, bellEl, helpBarEl, counts = {};
function navTree() {
    const collapsed = store.get('sb_nav_collapsed', {});
    const items = NAVREG.filter(inMenu).sort((a, b) => (a.order || 50) - (b.order || 50));
    return GROUPS.concat([...new Set(items.map(i => i.group))].filter(g => !GROUPS.includes(g))).map(g => {
        const list = items.filter(i => (i.group || 'Overview') === g);
        if (!list.length)
            return null;
        const sec = h('div', { class: 'navgrp' + (collapsed[g] ? ' shut' : ''), 'data-g': g }, h('button', { class: 'navhd', onclick: () => { sec.classList.toggle('shut'); const c = store.get('sb_nav_collapsed', {}); c[g] = sec.classList.contains('shut'); store.set('sb_nav_collapsed', c); } }, g, h('span', { class: 'chev' }, '▾')), h('div', { class: 'navitems' }, list.map(n => h('a', { href: '#/' + n.key, 'data-k': n.key }, icon(n.icon || 'list'), h('span', { class: 'lbl-t' }, n.title), h('span', { class: 'cnt', hidden: true })))));
        return sec;
    });
}
// phone menu: a long menu (owner/manager) opens only the groups that have work waiting (a badge) or hold the open screen;
// the rest fold up. Groups the user opened/closed by hand keep their choice. Short staff menus stay fully open.
const PHONE = () => matchMedia('(max-width:980px)').matches;
function navAuto() {
    if (!sideEl)
        return;
    const secs = [...sideEl.querySelectorAll('.navgrp')], links = sideEl.querySelectorAll('.nav a[data-k]').length;
    const manual = store.get('sb_nav_collapsed', {});
    for (const sec of secs) {
        const g = sec.dataset.g;
        if (g in manual)
            continue;
        const flow = typeof STAFF_FLOW !== 'undefined' && STAFF_FLOW[ME.role] ? STAFF_FLOW[ME.role].main.concat(STAFF_FLOW[ME.role].more).map(x => x.split('/')[0]) : [];
        const busy = g === 'Overview' || [...sec.querySelectorAll('.cnt')].some(c => !c.hidden) || !!sec.querySelector('a.on') || [...sec.querySelectorAll('a[data-k]')].some(a => flow.includes(a.dataset.k));
        sec.classList.toggle('shut', PHONE() && links > 12 && !busy);
    }
}
function shell(root) {
    CURRENT = null;
    const initials = (ME.name || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
    sideEl = h('nav', { class: 'side' }, h('a', { class: 'logo', href: '#/' }, h('span', { class: 'brandmark sm' }, 'SB'), h('span', null, META.store || 'SundayBazar', h('small', null, 'Business OS'))), h('div', { class: 'nav' }, navTree()), ME.role !== 'admin' ? h('div', { class: 'navhelp' }, h('button', { class: 'linkbtn', onclick: () => { sideEl.classList.remove('open'); showHelp(); } }, icon('help', 15), 'How to use this screen'), h('div', null, 'Need help? Ask the owner.'), h('div', { class: 'rl' }, 'Your role: ', (META.roles || {})[ME.role] || ME.role)) : null, h('div', { class: 'me' }, h('span', { class: 'avatar' }, initials), h('div', { class: 'grow' }, h('div', { class: 'nm' }, ME.name), h('div', { class: 'rl' }, (META.roles || {})[ME.role] || ME.role)), h('button', { class: 'iconbtn', title: 'Theme', onclick: () => { const t = store.get('sb_theme', 'auto'); store.set('sb_theme', t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'); applyTheme(); toast('Theme: ' + store.get('sb_theme', 'auto')); } }, icon('moon', 16)), h('button', { class: 'iconbtn', title: 'Change password', onclick: changePassword }, icon('key', 16)), h('button', { class: 'iconbtn', title: 'Log out', onclick: async () => { await POST('/api/logout'); location.hash = ''; boot(); } }, icon('logout', 16))));
    titleEl = h('h1');
    crumbEl = h('div', { class: 'crumb' });
    syncEl = h('div', { class: 'syncdot' });
    const s = h('input', { type: 'search', enterkeyhint: 'search', 'aria-label': 'Search', placeholder: PHONE() ? 'Search order no., phone, SKU…' : 'Search order no., phone, SKU, tracking…' });
    const find = async () => { const c = s.value.trim(); if (!c)
        return; try {
        const r = await GET('/api/lookup?code=' + encodeURIComponent(c));
        if (r.order && can('orders'))
            openOrder(r.order.id);
        else if (r.product)
            productModal(r);
        else
            location.hash = '#/orders/' + encodeURIComponent(c);
        s.select();
    }
    catch (e) {
        toast(e.message, true);
    } };
    s.addEventListener('keydown', e => { if (e.key === 'Enter')
        find(); });
    document.addEventListener('keydown', e => { if (e.key === '/' && !e.target.closest('input,textarea,select')) {
        e.preventDefault();
        s.focus();
    } });
    bellEl = h('button', { class: 'iconbtn bell', title: 'Alerts', onclick: showAlerts }, icon('bell'), h('span', { class: 'dot', hidden: true }));
    const widgets = h('div', { class: 'topw' }, TOPWIDGETS.map(fn => { try {
        return fn();
    }
    catch (_a) {
        return null;
    } }));
    content = h('main', { class: 'content' });
    helpBarEl = h('div', { class: 'helpbar', hidden: true });
    const helpBtn = h('button', { class: 'iconbtn helpbtn', title: 'Help: how to use this screen', 'aria-label': 'Help', onclick: () => showHelp() }, h('span', { class: 'q' }, '?'), h('span', { class: 'lbl' }, 'Help'));
    root.append(h('div', { class: 'app' }, sideEl, h('div', { class: 'scrim', onclick: () => sideEl.classList.remove('open') }), h('div', { class: 'main' }, h('header', { class: 'top' }, h('button', { class: 'iconbtn burger', 'aria-label': 'Menu', onclick: () => sideEl.classList.toggle('open') }, icon('menu')), h('div', { class: 'ttl' }, crumbEl, titleEl), h('div', { class: 'search' }, icon('search', 16), s), widgets, syncEl, helpBtn, bellEl), helpBarEl, content)));
    sideEl.addEventListener('click', e => { if (e.target.closest('a'))
        sideEl.classList.remove('open'); });
    pollSync();
    setInterval(pollSync, 30000);
}
let ALERTS = [];
async function pollSync() {
    try {
        const d = can('settings') || can('orders') ? await GET('/api/sync') : null;
        if (d) {
            syncEl.classList.toggle('run', d.running);
            syncEl.replaceChildren(h('i'), META.demo ? 'Practice data' : d.running ? d.progress : (META.shopify ? 'Synced ' + ago(d.last.orders) : 'Shopify not connected'));
        }
        const c = await GET('/api/counts');
        for (const [k, n] of Object.entries(c))
            setCount(k, n);
        navAuto();
        ALERTS = await GET('/api/alerts');
        const dot = bellEl.querySelector('.dot');
        dot.hidden = !ALERTS.length;
        dot.textContent = ALERTS.length;
    }
    catch (_a) { }
}
function showAlerts() {
    modal('Alerts', ALERTS.length ? h('div', { class: 'alist' }, ALERTS.map(a => h('a', { class: 'alrt ' + (a.level || 'info'), href: a.href || null, onclick: () => { var _a; return (_a = document.querySelector('.modal')) === null || _a === void 0 ? void 0 : _a.remove(); } }, icon(a.level === 'bad' ? 'alert' : 'bell', 16), h('span', null, a.text)))) : h('div', { class: 'empty' }, 'All clear. Nothing needs attention.'));
}
// badge numbers: side menu (.cnt) and any [data-cnt="key"] element (My day tiles). The server's 'warehouse' count is
// orders waiting to be picked, but that screen is now Returns (picking moved to the Dispatch desk), so it gets no badge.
const COUNT_HIDE = { warehouse: 1 };
function setCount(k, n) {
    if (COUNT_HIDE[k])
        n = 0;
    counts[k] = n;
    const a = sideEl && sideEl.querySelector(`a[data-k="${k}"] .cnt`);
    if (a) {
        a.hidden = !n;
        a.textContent = n;
    }
    document.querySelectorAll(`[data-cnt="${k}"]`).forEach(b => { b.hidden = !n; b.textContent = n; });
}
function changePassword() {
    const o = h('input', { type: 'password', placeholder: 'Current password' }), n = h('input', { type: 'password', placeholder: 'New password (6+)' });
    const m = modal('Change password', h('div', { class: 'grid' }, o, n), [h('button', { class: 'btn', onclick: () => act(() => POST('/api/password', { old: o.value, new: n.value }), 'Password changed').then(() => m.remove()) }, 'Save')]);
}
window.addEventListener('hashchange', route);
let CURRENT = null;
function route() {
    if (!ME)
        return;
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    let k = parts[0] || homeKey();
    if (!viewAllowed(k))
        k = homeKey();
    if (!k) {
        content.replaceChildren(h('div', { class: 'card' }, 'Your account has no access yet. Ask the owner.'));
        return;
    }
    const fresh = CURRENT !== k;
    CURRENT = k;
    document.querySelectorAll('.modal,.drawer').forEach(x => x.remove());
    sideEl.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.k === k));
    navAuto();
    helpBar(k, parts[1] || '', fresh);
    const m = viewMeta(k);
    titleEl.textContent = m.title;
    crumbEl.textContent = m.group || '';
    document.title = m.title + ' · ' + (META.store || 'SundayBazar');
    content.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Loading…'));
    VIEWS[k](parts.slice(1).map(decodeURIComponent)).catch(e => content.replaceChildren(h('div', { class: 'flash bad' }, e.message)));
}
/* one-line "what to do here" banner: shown the first 3 times a user opens a screen (per user + screen), "Got it" hides it for good */
const HELP_SHOWS = 3;
function helpBar(k, sub, fresh) {
    if (!helpBarEl)
        return;
    const x = typeof helpFor === 'function' ? helpFor(k, sub) : null;
    if (!x) {
        helpBarEl.hidden = true;
        return;
    }
    const id = (ME.id || ME.username) + ':' + k, seen = store.get('sb_help_seen', {}) || {};
    if (fresh) {
        seen[id] = (+seen[id] || 0) + 1;
        store.set('sb_help_seen', seen);
    }
    if (fresh ? seen[id] > HELP_SHOWS : helpBarEl.hidden || helpBarEl.dataset.k !== k) {
        helpBarEl.hidden = true;
        return;
    }
    helpBarEl.dataset.k = k;
    helpBarEl.replaceChildren(h('span', { class: 'hi' }, icon('help', 18)), h('span', { class: 'tx' }, x.line), h('button', { class: 'btn ghost sm', onclick: () => showHelp(k) }, 'How?'), h('button', { class: 'btn sm', onclick: () => { const s = store.get('sb_help_seen', {}) || {}; s[id] = 99; store.set('sb_help_seen', s); helpBarEl.hidden = true; } }, 'Got it'));
    helpBarEl.hidden = false;
}
function homeKey() {
    const r = ROLE_HOME[ME.role];
    if (r && viewAllowed(r))
        return r;
    if (!isBoss() && viewAllowed('me'))
        return 'me';
    const biz = typeof BUSINESS_PERMS === 'undefined' || BUSINESS_PERMS.some(p => can(p));
    if (viewAllowed('home') && biz)
        return 'home';
    if (viewAllowed('me'))
        return 'me';
    const first = NAVREG.filter(inMenu).sort((a, b) => (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || ((a.order || 50) - (b.order || 50)))[0];
    return first ? first.key : (viewAllowed('home') ? 'home' : null);
}
const render = (...kids) => content.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== true));
/* small shared helpers for module screens */
const pageHead = (title, sub, ...actions) => h('div', { class: 'phead' }, h('div', null, h('h2', null, title), sub ? h('div', { class: 'muted' }, sub) : null), h('div', { class: 'row' }, actions));
const money = rs;
const todayStr = () => { const d = new Date(Date.now() + 5 * 3600e3); return d.toISOString().slice(0, 10); };
const monthStr = () => todayStr().slice(0, 7);
function formModal(title, fields, onSave, saveLabel = 'Save') {
    // fields: [{ k, label, type: 'text'|'number'|'date'|'select'|'textarea'|'checkbox'|'file', options:[[v,l]]|[v], value, required, placeholder, full }]
    const inputs = {};
    const body = h('div', { class: 'fgrid' }, fields.map(f => {
        var _a;
        let el;
        if (f.type === 'select')
            el = h('select', null, (f.options || []).map(o => { var _a; const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String((_a = f.value) !== null && _a !== void 0 ? _a : '') }, l); }));
        else if (f.type === 'textarea')
            el = h('textarea', { placeholder: f.placeholder || '' }, f.value || '');
        else if (f.type === 'checkbox')
            el = h('input', { type: 'checkbox', checked: !!f.value });
        else if (f.type === 'file')
            el = h('input', { type: 'file', accept: f.accept || 'image/*,application/pdf' });
        else
            el = h('input', { type: f.type || 'text', value: (_a = f.value) !== null && _a !== void 0 ? _a : '', placeholder: f.placeholder || '', step: f.type === 'number' ? 'any' : null });
        inputs[f.k] = el;
        return h('label', { class: 'f' + (f.full || f.type === 'textarea' ? ' full' : '') }, f.label + (f.required ? ' *' : ''), el);
    }));
    const err = h('div', { class: 'flash bad', hidden: true });
    const m = modal(title, h('div', { class: 'grid' }, err, body), [h('button', { class: 'btn', onclick: async () => {
                const v = {};
                for (const f of fields) {
                    const el = inputs[f.k];
                    if (f.type === 'checkbox')
                        v[f.k] = el.checked;
                    else if (f.type === 'file')
                        v[f.k] = el.files[0] ? await uploadFile(el.files[0]) : (f.value || null);
                    else if (f.type === 'number')
                        v[f.k] = el.value === '' ? null : +el.value;
                    else
                        v[f.k] = el.value;
                    if (f.required && (v[f.k] == null || v[f.k] === '')) {
                        err.hidden = false;
                        err.textContent = f.label + ' is required';
                        return;
                    }
                }
                try {
                    await onSave(v);
                    m.remove();
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, saveLabel)]);
    return m;
}
async function uploadFile(file) {
    if (file.size > 4e6)
        throw new Error('File is too big (max 4 MB)');
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
    const j = await POST('/api/files', { name: file.name, type: file.type, data });
    return j.id;
}
/* tracking link for any courier */
const trackUrl = (tn, courier) => !tn ? null : /^RIDER-/.test(tn) || /rider/i.test(courier || '') ? null : /tcs/i.test(courier || '') ? 'https://www.tcsexpress.com/track/' + encodeURIComponent(tn) : 'https://postex.pk/tracking?cn=' + encodeURIComponent(tn);
const trackLink = (tn, courier, cls) => { const u = trackUrl(tn, courier); return u ? h('a', { target: '_blank', href: u, class: cls || null }, tn) : h('span', { class: cls || null }, tn || '–'); };
const fileLink = id => id ? h('a', { href: '/api/files/' + id, target: '_blank', class: 'small' }, 'View file') : null;
const csvDownload = (name, rows) => { if (!rows.length)
    return toast('Nothing to export', true); const cols = Object.keys(rows[0]); const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; saveText(name, [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n')); };
function saveText(name, text, type) { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/csv' })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
/* ---------- Home: owner command centre + My day ---------- */
const greet = () => { const hr = new Date(Date.now() + 5 * 3600e3).getUTCHours(); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };
const longDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const lakh = v => v == null || isNaN(v) ? '–' : (v < 0 ? '−' : '') + 'Rs ' + (Math.abs(v) >= 1e5 ? (Math.abs(v) / 1e5).toFixed(Math.abs(v) >= 1e7 ? 0 : 1) + ' lakh' : Math.abs(Math.round(v)).toLocaleString('en-PK'));
const chg = (a, b) => { if (!b)
    return ''; const p = Math.round(100 * (a - b) / b); return (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%'; };
const BUSINESS_PERMS = ['orders', 'accounts', 'finance', 'marketing', 'team', 'hr', 'wms', 'warehouse', 'tickets', 'reports'];
function homeSection(title, href, rows, foot) {
    return h('div', { class: 'card hsec' }, h('h2', null, title, href ? h('a', { class: 'spacer small muted', href }, 'Open →') : null), h('div', { class: 'hrows' }, rows.filter(Boolean).map(([l, v, cls, link]) => h(link ? 'a' : 'div', { class: 'hrow', href: link || null }, h('span', { class: 'muted' }, l), h('strong', { class: cls || '' }, v)))), foot || null);
}
registerView({ key: 'home', title: 'Home', group: 'Overview', perm: 'dashboard', icon: 'home', order: 1, roles: ['admin', 'manager'] }, async () => {
    if (!BUSINESS_PERMS.some(p => can(p)))
        return VIEWS.me();
    const d = await GET('/api/home');
    const s = d.sales, a = d.accounts, m = d.marketing, hr = d.hr, op = d.ops, tk = d.tickets, w = d.wms, ex = d.expenses;
    const head = h('div', { class: 'hhead' }, h('div', null, h('div', { class: 'muted small' }, longDate(d.today)), h('h2', null, greet() + ', ' + (ME.name || '').split(' ')[0])), h('div', { class: 'row' }, h('a', { class: 'btn ghost sm', href: '#/me' }, icon('user', 15), 'My day'), can('team') ? h('a', { class: 'btn ghost sm', href: '#/team' }, icon('team', 15), 'Team today') : null));
    // profit goal
    let goal = null;
    if (a) {
        const p = Math.max(0, Math.min(100, 100 * a.projected / d.target));
        goal = h('div', { class: 'card goal' }, h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'muted small' }, 'Monthly profit goal'), h('div', { class: 'big' }, lakh(d.target))), h('div', { style: { textAlign: 'right' } }, h('div', { class: 'muted small' }, 'On track for this month'), h('div', { class: 'big ' + (a.projected >= d.target ? 'pos' : a.projected < 0 ? 'neg' : '') }, lakh(a.projected)))), h('div', { class: 'bar ' + (a.projected >= d.target ? 'ok' : a.projected < 0 ? 'bad' : 'warn'), style: { height: '10px', margin: '10px 0 6px' } }, h('i', { style: { width: p + '%' } })), h('div', { class: 'row sp small muted' }, h('span', null, 'Profit so far this month: ', h('strong', { class: a.profitMTD < 0 ? 'neg' : '' }, rs(a.profitMTD)), ' · Sales ', rs(a.salesMTD)), can('settings') ? h('a', { href: '#', onclick: e => { e.preventDefault(); formModal('Monthly profit goal', [{ k: 'target', label: 'Target (Rs)', type: 'number', value: d.target, required: true }], v => POST('/api/home/target', v).then(() => route())); } }, 'Change goal') : null), h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'From the accounts: sales, cost of pairs, courier, ads, salaries, rent and every posted expense. "On track" = profit so far ÷ days passed × days in the month.'));
    }
    const kp = h('div', { class: 'kpis' }, s && kpi('Orders today', num(s.today.orders), rs(s.today.value) + (s.yesterday.orders ? ' · yesterday ' + num(s.yesterday.orders) : ''), null, '#/orders'), s && kpi('Sales this month', lakh(s.mtd.value), num(s.mtd.orders) + ' orders ' + chg(s.mtd.value, s.lastMtd.value) + ' vs last month', s.lastMtd.value && s.mtd.value < s.lastMtd.value ? 'warn' : '', can('reports') ? '#/reports' : null), m && kpi('Ad spend today', rs(m.spendToday), 'this month ' + lakh(m.spendMTD) + (m.cpo ? ' · ' + rs(m.cpo) + '/order' : ''), null, '#/marketing'), m && m.roas != null && kpi('Return on ads', (+m.roas).toFixed(2) + '×', 'delivered sales ÷ ad spend', m.roas < 3 ? 'alert' : 'good', '#/marketing'), a && kpi('Cash & bank', lakh(a.cash + a.bank), 'cash ' + lakh(a.cash) + ' · bank ' + lakh(a.bank), null, '#/statements/cash'), d.cod && kpi('PostEx still owes', lakh(d.cod.v), num(d.cod.n) + ' delivered parcels', null, '#/finance/cod'), s && d.deliveryRate != null && kpi('Delivery rate', d.deliveryRate + '%', 'last 30 days', d.deliveryRate < 75 ? 'alert' : 'good', can('reports') ? '#/reports' : null), hr && kpi('Staff in today', num(hr.present) + ' / ' + num(hr.staff), (hr.late ? hr.late + ' late · ' : '') + (hr.absent ? hr.absent + ' absent' : 'nobody absent'), hr.absent ? 'warn' : 'good', can('hr') ? '#/attendance' : '#/team'));
    const alerts = d.alerts || [];
    const attention = h('div', { class: 'card' }, h('h2', null, 'Needs attention', h('small', null, alerts.length ? alerts.length + ' items' : '')), alerts.length ? h('div', { class: 'alist' }, alerts.slice(0, 9).map(x => h('a', { class: 'alrt ' + (x.level || 'info'), href: x.href || null }, icon(x.level === 'bad' ? 'alert' : 'bell', 16), h('span', null, x.text)))) : h('div', { class: 'empty' }, icon('check'), ' All clear.'), alerts.length > 9 ? h('a', { class: 'small muted', href: '#', onclick: e => { e.preventDefault(); showAlerts(); } }, 'See all ' + alerts.length + ' →') : null);
    const P = d.pipeline || {};
    const sections = h('div', { class: 'three' }, s && homeSection('Orders right now', '#/ops', [['To confirm', num(P.confirm), P.confirm ? 'warn' : '', can('cs') ? '#/cs' : null], ['In warehouse', num(P.warehouse), '', can('couriers') ? '#/dispatch' : null], ['With courier', num(P.courier)],
        ['Delivery attempted', num(P.attempted), P.attempted ? 'neg' : '', can('tracking') ? '#/tracking/attempted' : null], ['Coming back', num(P.coming_back)]]), (op || hr) && homeSection('Team', can('team') ? '#/team' : '#/attendance', [
        hr && ['Present / staff', num(hr.present) + ' / ' + num(hr.staff)], hr && ['Late', num(hr.late), hr.late ? 'warn' : ''], hr && ['Absent', num(hr.absent), hr.absent ? 'neg' : ''], hr && hr.onLeave ? ['On leave', num(hr.onLeave)] : null,
        op && ['No work recorded yet', num(op.noActivity), op.noActivity ? 'warn' : ''], op && ['Idle 90+ min', num(op.idle), op.idle ? 'warn' : ''], op && op.avgScore != null ? ['Team score today', op.avgScore + '%'] : null,
        op && ['Overdue tasks', num(op.overdue), op.overdue ? 'neg' : '', '#/tasks'], op && op.needsReview ? ['Needs review (30 days)', num(op.needsReview), 'neg', '#/performance/30'] : null
    ]), a && homeSection('Money', '#/accounts', [['Cash', rs(a.cash)], ['Bank', rs(a.bank)], ['PostEx receivable', rs(a.postexReceivable)], ['Owed to suppliers', rs(a.payables)], ['Profit this month', rs(a.profitMTD), a.profitMTD < 0 ? 'neg' : 'pos', '#/statements'],
        ex && ['Expenses waiting approval', ex.pending ? num(ex.pending) + ' · ' + rs(ex.pendingAmount) : '0', ex.pending ? 'warn' : '', '#/approvals'], ex && ['Petty cash', rs(ex.pettyBalance), '', '#/pettycash']]), !a && ex && homeSection('Office expenses', '#/approvals', [['Waiting approval', num(ex.pending) + ' · ' + rs(ex.pendingAmount)], ['Petty cash', rs(ex.pettyBalance)], ['This month', rs(ex.monthTotal)]]), m && homeSection('Marketing', '#/marketing', [['Spend this month', rs(m.spendMTD)], ['Orders this month', num(m.ordersMTD)], ['Cost per order', m.cpo ? rs(m.cpo) : '–'], ['Return on ads', m.roas != null ? (+m.roas).toFixed(2) + '×' : '–', m.roas != null && m.roas < 3 ? 'neg' : ''],
        !m.connected ? ['Meta', 'Not connected', 'warn', '#/marketing'] : null]), w && homeSection('Warehouse', '#/wms', [['Pairs on hand', num(w.onHand)], ['Stock value (cost)', rs(w.stockValue)], ['Lots to receive', num(w.lotsToReceive), w.lotsToReceive ? 'warn' : '', '#/receiving'], ['Stock counts due', num(w.countsDue), w.countsDue ? 'warn' : '', '#/counts'],
        ['Damage this month', rs(w.damageMTD), w.damageMTD ? 'neg' : '', '#/damage'], ['Empty slots', num(w.emptySlots)]]), d.purchasing && homeSection('Purchasing', '#/purchasing', [['Waiting for approval', num(d.purchasing.awaitingApproval), d.purchasing.awaitingApproval ? 'warn' : '', '#/purchasing/list/submitted'], ['Open orders', num(d.purchasing.openPOs), '', '#/purchasing/list/open'],
        ['Arriving this week', num(d.purchasing.arrivingThisWeek) + (d.purchasing.late ? ` · ${d.purchasing.late} late` : ''), d.purchasing.late ? 'neg' : ''], ['Received, not billed', num(d.purchasing.receivedNotBilled), d.purchasing.receivedNotBilled ? 'warn' : '', '#/purchasing/list/received'],
        d.purchasing.payablesDue != null ? ['Supplier payments due (7 days)', rs(d.purchasing.payablesDue), d.purchasing.overdue ? 'neg' : '', '#/payables'] : null, d.purchasing.overdue ? ['Overdue', rs(d.purchasing.overdue), 'neg', '#/payables'] : null]), d.stockline && homeSection('Stock line', '#/stockline', [['Listed, waiting for photo', num(d.stockline.waiting.listed)], ['Waiting for editing', num(d.stockline.waiting.photo)], ['Waiting for upload', num(d.stockline.waiting.edited)], ['Uploaded, not handed to warehouse', num(d.stockline.waiting.uploaded)], ['Handed over, warehouse to receive', num(d.stockline.waiting.handover), d.stockline.waiting.handover ? 'warn' : '', '#/put-away-in'], ['Stuck 2+ days', num(d.stockline.stuck), d.stockline.stuck ? 'neg' : '']]), d.inbox && homeSection('Messages', '#/inbox', [['Open conversations', num(d.inbox.open)], ['Unread', num(d.inbox.unread), d.inbox.unread ? 'warn' : ''], ['Waiting 1h+ for reply', num(d.inbox.waitingOver1h), d.inbox.waitingOver1h ? 'neg' : ''], ['WhatsApp sent automatically today', num(d.inbox.autoSentToday)], ['Orders confirmed by WhatsApp today', num(d.inbox.confirmedByBot), 'pos']]), d.couriers && homeSection('Couriers & rider', '#/couriers', [['Parcels on the way', num(d.couriers.inTransit)], d.couriers.codPending != null ? ['COD delivered, not yet paid', rs(d.couriers.codPending)] : null, d.couriers.riderCashOut != null ? ['Cash still with riders', rs(d.couriers.riderCashOut), d.couriers.riderCashOut ? 'warn' : '', '#/rider-runs'] : null, ['TCS', d.couriers.tcsConnected ? 'Connected' : 'Not connected', d.couriers.tcsConnected ? 'pos' : 'warn']]), tk && homeSection('Customer service', '#/tickets', [['Open tickets', num(tk.open)], ['Overdue', num(tk.overdue), tk.overdue ? 'neg' : ''], ['Exchanges in progress', num(tk.exchangesOpen), '', '#/exchanges'], ['Refunds waiting', num(tk.refundsPending), tk.refundsPending ? 'warn' : '', '#/refunds']]));
    render(head, goal, kp, h('div', { class: 'split' }, s ? h('div', { class: 'card' }, h('h2', null, 'Orders per day', h('small', null, 'last 30 days')), chart(d.daily || [], 'day', [{ k: 'orders', l: 'Orders', c: C1 }])) : h('div'), attention), sections);
});
/* ---------- My day: staff work launcher ----------
   Staff (everyone except owner/manager) land here. Big tiles = their own screens in the order the work really flows,
   each with a live number of jobs waiting; then check-in, tasks and expenses cards; then what they did today. */
// main = big tiles in work order (step numbers shown when seq); everything else they can open goes under "More screens"
const STAFF_FLOW = {
    cs: { main: ['cs', 'inbox', 'tickets', 'exchanges', 'refunds'], more: ['orders', 'customers'] },
    tracking: { main: ['tracking', 'tickets', 'inbox', 'exchanges'], more: ['orders', 'customers', 'dispatch', 'rider-runs', 'couriers'] },
    warehouse: { seq: true, main: ['dispatch/pick', 'dispatch/pack', 'dispatch/book', 'dispatch/handover'], more: ['warehouse', 'put-away-in', 'racks', 'receiving', 'sorting', 'counts', 'damage', 'inventory', 'rider-runs', 'dispatch/today'] },
    lister: { seq: true, main: ['list', 'photos', 'upload', 'handover'], more: ['sorting', 'listing', 'racks', 'inventory', 'damage'] },
    finance: { main: ['finance', 'refunds', 'approvals', 'payables', 'vouchers'], more: ['rider-runs', 'accounts', 'ledgers', 'statements', 'close', 'pettycash', 'purchasing', 'suppliers', 'reports'] },
    marketing: { main: ['marketing', 'campaigns', 'mkt-spend', 'inbox'], more: ['reports'] },
    hr: { main: ['team', 'performance', 'attendance', 'leave', 'hr', 'payroll'], more: ['reports'] },
    exchange: { main: ['inbox', 'exchanges', 'tickets', 'refunds'], more: ['orders', 'customers'] },
    social: { main: ['abandoned', 'inbox', 'tickets'], more: ['exchanges', 'refunds', 'orders', 'customers'] },
    rider: { main: ['rider'], more: [] },
};
// dispatch desk steps open straight on their tab; their numbers come from /api/couriers/dispatch/steps
const SUB_TILES = {
    'dispatch/pick': { title: 'Pick list', icon: 'list', step: 'pick' }, 'dispatch/pack': { title: 'Pack', icon: 'box', step: 'pack' },
    'dispatch/book': { title: 'Book & print', icon: 'doc', step: 'book' }, 'dispatch/handover': { title: 'Load sheet & handover', icon: 'truck', step: 'handover' },
    'dispatch/today': { title: 'Dispatched today', icon: 'check' },
};
function meTiles() {
    const all = NAVREG.filter(n => inMenu(n) && !['home', 'me'].includes(n.key))
        .sort((a, b) => (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || ((a.order || 50) - (b.order || 50))).map(n => n.key);
    const ok = id => { const [k] = id.split('/'); return all.includes(k) || (SUB_TILES[id] && viewAllowed(k)); };
    const flow = STAFF_FLOW[ME.role] || { main: [], more: [] };
    const main = flow.main.filter(ok), used = new Set(main);
    // a screen opened through its step tiles (dispatch) does not need its own tile again
    for (const id of main)
        if (id.includes('/'))
            used.add(id.split('/')[0]);
    const more = flow.more.filter(ok).concat(all).filter(id => !used.has(id) && (used.add(id), true));
    if (!main.length)
        main.push(...more.splice(0, Math.min(6, more.length))); // custom access: first screens become the big tiles
    return { main, more, seq: !!flow.seq && main.length > 1 };
}
function meTile(id, big, n) {
    const [k] = id.split('/'), sub = SUB_TILES[id], m = viewMeta(k) || {}, hp = HELP[id] || HELP[k] || {};
    const title = (sub && sub.title) || m.title || hp.title || k;
    return h('a', { class: 'mtile' + (big ? ' big' : ''), href: '#/' + id }, h('span', { class: 'mt-ic' }, icon((sub && sub.icon) || m.icon || 'list', big ? 26 : 20), n ? h('span', { class: 'mt-no' }, n) : null), h('span', { class: 'mt-tx' }, h('strong', null, title), big && hp.line ? h('span', { class: 'mt-d' }, hp.line) : null), h('span', { class: 'mt-cnt', 'data-cnt': id, hidden: true }), big ? h('span', { class: 'mt-go' }, '›') : null);
}
registerView({ key: 'me', title: 'My day', group: 'Overview', perm: 'dashboard', icon: 'user', order: 2 }, async () => {
    const today = todayStr();
    const box = h('div', { class: 'mecards' });
    const [work, cnt] = await Promise.all([GET('/api/home/me').catch(() => ({ work: [] })), GET('/api/counts').catch(() => counts)]);
    const roleName = (META.roles || {})[ME.role] || ME.role;
    const head = h('div', { class: 'hhead' }, h('div', null, h('div', { class: 'muted small' }, longDate(today)), h('h2', null, greet() + ', ' + (ME.name || '').split(' ')[0])), isBoss() ? h('a', { class: 'btn ghost sm', href: '#/home' }, icon('home', 15), 'Home') : h('span', { class: 'b' }, roleName));
    const did = h('div', { class: 'card' }, h('h2', null, 'What I did today', h('small', null, 'recorded automatically when you work in the ERP')), work.work.length ? h('div', { class: 'chips' }, work.work.map(x => h('span', { class: 'chip' }, h('strong', null, num(x.n)), ' ', x.label)))
        : h('div', { class: 'muted' }, 'Abhi tak kuch record nahi hua. Jo kaam aap ERP mein karte hain (calls, picking, listing, tickets…) woh khud yahan aur owner ki daily report mein aa jata hai.'));
    if (isBoss()) {
        const links = NAVREG.filter(n => inMenu(n) && !['home', 'me'].includes(n.key)).sort((a, b) => (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || ((a.order || 50) - (b.order || 50))).slice(0, 12);
        render(head, did, box, links.length ? h('div', { class: 'card' }, h('h2', null, 'My screens'), h('div', { class: 'quick' }, links.map(n => h('a', { class: 'qlink', href: '#/' + n.key }, icon(n.icon || 'list'), h('span', null, n.title))))) : null);
    }
    else {
        const t = meTiles();
        const work1 = t.main.length ? h('section', { class: 'mework' }, h('h3', { class: 'mesec' }, 'My work', h('small', null, t.seq ? 'baen se daen, step by step' : 'tile dabayein aur kaam shuru karein')), h('div', { class: 'mtiles' + (t.seq ? ' seq' : '') }, t.main.map((id, i) => meTile(id, true, t.seq ? i + 1 : 0)))) : null;
        const more = t.more.length ? h('section', null, h('h3', { class: 'mesec' }, 'More screens'), h('div', { class: 'mtiles sm' }, t.more.map(id => meTile(id, false)))) : null;
        render(head, work1 || h('div', { class: 'card empty' }, 'Abhi aap ko koi screen nahi di gayi. Owner se kahein.'), box, more, did);
        for (const [k, n] of Object.entries(cnt || {}))
            setCount(k, n);
        if ([...t.main, ...t.more].some(id => SUB_TILES[id] && SUB_TILES[id].step)) {
            GET('/api/couriers/dispatch/steps').then(st => { for (const [id, s] of Object.entries(SUB_TILES))
                if (s.step)
                    setCount(id, +st[s.step] || 0); }).catch(() => { });
        }
    }
    const cards = MECARDS.filter(c => permOk(c.perm || 'dashboard')).sort((a, b) => (a.order || 50) - (b.order || 50));
    for (const c of cards) {
        const slot = h('div');
        box.append(slot);
        c.fn().then(n => { if (n)
            slot.replaceWith(n);
        else
            slot.remove(); }).catch(e => { slot.replaceWith(h('div', { class: 'note bad' }, e.message)); });
    }
});
/* ---------- Help for every screen (Roman Urdu, simple words) ----------
   HELP[viewKey] = { title, line, steps: [...], tip }
   line  = one-line "what to do here" (banner at the top of the screen + My day tile text)
   steps = 3–6 short steps shown when the user taps the "?" Help button
   Sub-screens can have their own entry as 'key/sub' (e.g. 'dispatch/pack'); the "?" button uses it when that tab is open. */
const HELP = {
    /* Overview */
    home: { title: 'Home', line: 'Business ka poora haal ek nazar mein: sales, profit, cash, team aur alerts.',
        steps: ['Upar monthly profit goal aur "On track" dekhein.', 'Boxes (KPI) par click karein — us ki detail khul jayegi.', '"Needs attention" mein laal/peeli lines pehle dekhein.', 'Neeche har department ka khulasa hai — "Open →" se screen kholein.'],
        tip: 'Har subah pehle "Needs attention" check karein.' },
    me: { title: 'My day', line: 'Yahan se apna kaam shuru karein: tile dabayein, check-in karein, apne tasks dekhein.',
        steps: ['Office pohanch kar pehle Check in karein.', 'Upar wali bari tiles aap ke kaam ki screens hain — number batata hai kitna kaam baqi hai.', 'Tile par tap karein aur kaam shuru karein.', '"My tasks" mein owner ka diya hua kaam dekhein aur Done karein.', 'Jo kaam aap ERP mein karte hain woh khud "What I did today" mein aa jata hai.'],
        tip: 'Number wali tile pehle karein — wahan kaam ruka hua hai.' },
    tasks: { title: 'Tasks', line: 'Owner/manager ka diya hua kaam. Kaam khatam ho to Done karein.',
        steps: ['Apne tasks list mein dekhein — due date wale pehle.', 'Kaam karne ke baad Done dabayein.', 'Agar kaam samajh na aaye to owner se poochein.', 'Manager "New task" se kisi ko bhi kaam de sakta hai.'],
        tip: 'Laal (overdue) task sab se pehle karein.' },
    reports: { title: 'Sales reports', line: 'Sales, orders aur delivery rate ki reports.',
        steps: ['Upar se dates ya month chunein.', 'Chart aur table mein sales dekhein.', 'CSV se Excel mein download karein.'], tip: 'Delivery rate 75% se kam ho to tracking team se baat karein.' },
    /* Buying */
    purchasing: { title: 'Purchasing', line: 'Lot khareedne ke orders (PO): banayein, approve karwayein, receive aur bill karein.',
        steps: ['"New PO" dabayein aur supplier, pairs aur rate likhein.', 'Submit karein — owner approve karega.', 'Maal aane par warehouse GRN karega.', 'Supplier ka bill aaye to PO par bill darj karein.'], tip: 'PO ka status dekh kar pata chalta hai maal kahan hai.' },
    suppliers: { title: 'Suppliers', line: 'Suppliers ki list, un ke lots aur hisaab.',
        steps: ['Supplier par click karke us ki history dekhein.', '"Add supplier" se naya supplier banayein.', 'Phone aur address sahi likhein.'], tip: '' },
    /* Stock line */
    stockline: { title: 'Stock line', line: 'Har lot line mein kahan hai: GRN → sorting → listing → photo → upload → warehouse.',
        steps: ['Har column ek step hai, number batata hai kitne pairs wahan ruke hain.', 'Lot par click karke us ki detail dekhein.', 'Laal "stuck" pairs 2+ din se ruke hain — un ko aage barhayein.'], tip: '' },
    receiving: { title: 'Lot receiving (GRN)', line: 'Naya lot aaye to ginti karke PO se milayein aur GRN save karein.',
        steps: ['"To do" mein aaya hua lot chunein.', 'Bags/pairs ginein aur number likhein.', 'Kam ya zyada ho to note likhein.', '"Save GRN" dabayein — lot sorting mein chala jayega.'], tip: 'Ginti do baar karein, phir save karein.' },
    sorting: { title: 'Sorting & QC', line: 'Lot ke pairs check karein: achay, kharab aur grade alag karein.',
        steps: ['Lot chunein.', 'Har pair check karein aur grade/type chunein.', 'Kharab pairs alag likhein.', '"Save QC batch" dabayein.'], tip: 'Kharab pair ko listing mein na bhejein.' },
    list: { title: 'List pairs', line: 'Har pair ka SKU banayein, size/brand/price likhein aur barcode print karein.',
        steps: ['Lot chunein.', 'Pair ki details bharein: brand, size, condition.', 'ERP price batata hai — "List at" check karein.', '"Save pair" dabayein — barcode print hoga.', 'Barcode pair par lagayein aur photo ke liye bhejein.'], tip: 'Size aur brand ghalat na ho — customer isi par order karta hai.' },
    photos: { title: 'Photos & editing', line: 'Photo khinchne ke baad pair scan karein. Editing ke baad "Picture editing" tab mein scan karein.',
        steps: ['"Photography" tab: pair ki photos lein.', 'Pair ka barcode scan karein — "photo done" ho jayega.', '"Picture editing" tab: photos edit karke pair scan karein.', 'Ghalti ho to "Undo" dabayein.'], tip: 'Scanner na ho to list mein tick karke bara button dabayein.' },
    'photos/edit': { title: 'Picture editing', line: 'Pictures edit ho jayein to pair scan karein ya tick karke "Editing done" dabayein.',
        steps: ['List mein sab se purane pairs pehle hain.', 'Photos edit karein.', 'Pair ka SKU scan karein ya tick karein.', '"Editing done" dabayein.'], tip: '' },
    upload: { title: 'Upload', line: 'Pairs Shopify par live karein, phir scan karke "uploaded" mark karein.',
        steps: ['"Upload" tab mein waiting pairs dekhein.', 'Shopify par product upload karein.', 'Pair ka SKU scan karein ya tick karke mark karein.', '"Shopify check" tab mein dekhein sab sahi upload hua.'], tip: '' },
    handover: { title: 'Handover to warehouse', line: 'Uploaded pairs scan karke warehouse ko bhejein.',
        steps: ['"New handover" tab kholein.', 'Har pair ka barcode scan karein.', 'List check karein.', '"Send to warehouse" dabayein aur pairs warehouse ko dein.'], tip: 'Warehouse wala ERP mein receive karega — ginti dono taraf same honi chahiye.' },
    listing: { title: 'Lots & pricing', line: 'Lot ki qeemat, har pair ki cost aur prices ek saath badalna.',
        steps: ['Lot chunein aur cost/pieces check karein.', 'Per-pair cost khud nikalti hai.', 'Bulk price change karke Shopify par bhejein (sirf permission walay).'], tip: '' },
    /* Warehouse */
    'put-away-in': { title: 'Receive from listing', line: 'Listing se aaye pairs scan karein, phir rack par rakhein.',
        steps: ['Handover chunein.', 'Har pair scan karein.', 'Kam ho to "Missing", zyada ho to "Extra".', '"Handover received" dabayein.', 'Suggested slot par pair rakhein aur "On rack" karein.'], tip: '' },
    racks: { title: 'Racks & put-away', line: 'Pairs ko rack slot mein rakhein ya ek slot se doosre mein le jayein.',
        steps: ['Slot ka label scan karein ya map se chunein.', 'Pair scan karein — "Put away here".', 'Pair hilana ho to "Change slot".', 'Khaali slots "Show empty slots" se dekhein.'], tip: 'Har pair ka slot ERP mein sahi ho — warna picking mein nahi milega.' },
    inventory: { title: 'Inventory', line: 'Saara stock: SKU, size, rack aur kitne din se para hai.',
        steps: ['Upar search mein SKU, brand ya size likhein.', 'Pair par click karke detail dekhein.', 'Purana stock (ageing) dekh kar sale plan karein.'], tip: '' },
    counts: { title: 'Stock counts', line: 'Rack ki ginti: slot scan karein, phir us ke har pair ko scan karein.',
        steps: ['"Counts" mein khuli ginti chunein.', 'Pehle slot ka label scan karein.', 'Slot ke saare pairs scan karein.', '"Finish count" dabayein — manager approve karega.'], tip: 'Na milay pairs "Missing list" mein jaate hain.' },
    damage: { title: 'Damage', line: 'Kharab pair ki report karein; owner/manager write-off approve karta hai.',
        steps: ['"Report" dabayein.', 'Pair ka SKU aur wajah (reason) likhein.', 'Photo lagayein agar ho sake.', 'Save karein — approval ka intezar karein.'], tip: '' },
    warehouse: { title: 'Returns', line: 'Wapas aaye parcel scan karein, phir pair restock ya damage karein.',
        steps: ['Return parcel ka tracking ya order number scan karein.', 'Pair check karein.', 'Theek ho to Restock, kharab ho to Damage.', 'Restock pair ko rack par rakhein.'], tip: 'Picking aur packing ab "Dispatch desk" par hoti hai.' },
    wms: { title: 'Warehouse overview', line: 'Warehouse ke number: kitne pairs, stock value, khaali slots.',
        steps: ['Upar ke boxes par click karke detail kholein.', 'Laal number pehle dekhein.'], tip: '' },
    /* Orders & CS */
    abandoned: { title: 'Abandoned carts', line: 'Checkout chhor dene wale customers ko WhatsApp ya call karke order complete karwayein.',
        steps: ['"New" tab mein sab se purani cart upar hai — pehle woh karein.', '"Sold out" wala item mat chase karein, woh bik chuka hai.', '"WhatsApp" dabayein — message mein checkout ka link khud aa jata hai.', 'Call kiya to "Called" dabayein aur jawab chunein (order karega / phone nahi uthaya / nahi chahiye / ghalat number).', 'Customer na maane to "Lost" dabayein.', 'Order aa jaye to cart khud "Recovered" mein chali jati hai aur aap ke naam likhi jati hai.'],
        tip: 'Cart 30 minute purani ho to hi yahan aati hai. Pehle 3 ghante mein rabta karein — order ka chance sab se zyada hota hai.' },
    inbox: { title: 'Messages', line: 'WhatsApp, Instagram aur form ke messages. Customer ko jaldi jawab dein.',
        steps: ['Baen taraf conversation chunein — bold wale unread hain.', 'Neeche message likhein ya quick reply chunein.', 'Order ki baat ho to order number check karein.', 'Kaam khatam ho to conversation Close karein.'], tip: '1 ghante se zyada kisi ko intezar na karwayein.' },
    cs: { title: 'Confirmation', line: 'Yahan naye orders aate hain. Customer ko call karein aur Confirm ya Cancel dabayein.',
        steps: ['"To call now" mein sab se upar wala order lein.', 'Call dabayein aur customer se order confirm karein.', 'Haan → Confirm. Nahi → Cancel (wajah chunein).', 'Phone na uthaye → "No answer". Baad mein → "Call later".', 'WhatsApp button se message bhi bhej sakte hain.'], tip: 'Laal (Risky/Blacklisted) customer ka order dhyan se confirm karein.' },
    orders: { title: 'Orders', line: 'Koi bhi order dhoondhein, dekhein aur theek karein.',
        steps: ['Upar search mein order number, phone ya naam likhein.', 'Order par click karein — poori detail khulegi.', 'Address/phone ghalat ho to Edit karein.', 'Note likh kar save karein.'], tip: '' },
    tickets: { title: 'Tickets', line: 'Customer ki shikayat aur follow-up. Har masla ek ticket.',
        steps: ['"My open" mein apne tickets dekhein.', 'Ticket kholein, customer se baat karein, note likhein.', 'Exchange ya refund chahiye to ticket se hi banayein.', 'Masla hal ho jaye to Resolve karein.'], tip: 'Overdue tickets pehle karein.' },
    exchanges: { title: 'Exchanges', line: 'Size ya article badalna: purana pair wapas, naya pair bhejna.',
        steps: ['Exchange chunein.', 'Purana pair aaya ya nahi check karein.', 'Naya pair book karein.', 'Status update karte rahein.'], tip: '' },
    refunds: { title: 'Refunds', line: 'Refund ki requests: finance approve karta hai aur paise bhejta hai.',
        steps: ['Request mein raqam aur account likhein.', 'Finance approve karega.', 'Paise bhejne ke baad transfer reference likhein.'], tip: '' },
    customers: { title: 'Customers', line: 'Customer ki history: kitne order delivered, kitne return.',
        steps: ['Phone ya naam se search karein.', 'Customer par click karke history dekhein.', 'Bar bar return kare to Risky/Blacklist label lagayein.'], tip: '' },
    ops: { title: 'Order pipeline', line: 'Har stage par kitne orders hain: confirm, warehouse, courier, return.',
        steps: ['Har box ek stage hai.', 'Number par click karke wo orders dekhein.', 'Ruke hue orders wali team ko batayein.'], tip: '' },
    /* Dispatch */
    dispatch: { title: 'Dispatch desk', line: 'Baen se daen kaam karein: Pick → Pack → Book & print → Load sheet.',
        steps: ['1. Pick list: rack se pairs nikalein aur scan karein.', '2. Pack: packing slip ka order number scan karke pack karein.', '3. Book & print: courier book karein aur airway bill print karein.', '4. Load sheet: courier/rider ko parcel dein aur "Mark handed" dabayein.', '5. Dispatched today: dobara print ya cancel.'], tip: 'Number wale step par kaam baqi hai.' },
    'dispatch/pick': { title: 'Pick list', line: 'Rack se pair nikalein aur us ka barcode scan karein.',
        steps: ['List rack slot ke hisaab se lagi hai — upar se shuru karein.', 'Slot par jaa kar pair nikalein.', 'Barcode scan karein — order ke saath jur jayega.', 'Pair na milay to "Missing" dabayein.'], tip: 'Order ke saare pairs ho jayein to woh Pack mein chala jata hai.' },
    'dispatch/pack': { title: 'Pack', line: 'Packing slip ka order number scan karein aur parcel pack karein.',
        steps: ['Order ke pairs ikathay karein.', 'Packing slip ka order number scan karein.', 'Parcel pack karein.', 'Packed orders "Book & print" mein chale jaate hain.'], tip: '' },
    'dispatch/book': { title: 'Book & print', line: 'Courier chunein, book karein aur airway bill print karein.',
        steps: ['Orders chunein (tick).', 'Courier, city aur COD check karein.', 'Book dabayein.', 'Airway bill print karke parcel par lagayein.'], tip: 'City ghalat ho to parcel wapas aa sakta hai — dhyan se check karein.' },
    'dispatch/handover': { title: 'Load sheet & handover', line: 'Courier/rider ko parcel dein aur "Mark handed" dabayein.',
        steps: ['Courier chunein (PostEx, TCS, Rider).', 'Load sheet print karein.', 'Parcel gin kar courier ko dein.', '"Mark handed" dabayein.'], tip: '' },
    'dispatch/today': { title: 'Dispatched today', line: 'Aaj bhejay gaye parcel: dobara print ya cancel.',
        steps: ['Parcel dhoondhein.', 'Airway bill dobara print karna ho to Print.', 'Ghalat booking ho to Cancel.'], tip: '' },
    'rider-runs': { title: 'Rider runs & cash', line: 'Rider ke parcel aur wapas laaya hua cash.',
        steps: ['Rider ko parcels ka run dein.', 'Wapas aane par delivered/return mark karein.', 'Rider se cash gin kar lein aur darj karein.'], tip: 'Cash usi din ginein.' },
    couriers: { title: 'Couriers', line: 'Courier ke parcel, unpaid COD aur courier settings.',
        steps: ['Upar courier chunein: TCS, PostEx, Rider.', '"On the way" aur "Delivered, not paid" dekhein.', 'Settings sirf owner badle.'], tip: '' },
    rider: { title: 'My deliveries', line: 'Aaj ke parcel. Deliver ho to Done dabayein, cash ka hisaab rakhein.',
        steps: ['List mein parcel aur customer ka address dekhein.', 'Call ya WhatsApp se customer ko batayein.', 'Deliver karke "Done" dabayein.', 'Na liya to wajah chunein.', 'Shaam ko cash office mein jama karein.'], tip: '' },
    /* Tracking */
    tracking: { title: 'Tracking', line: 'Raaste mein parcel follow karein: attempted, stuck, returning.',
        steps: ['"Attempted" pehle: customer ko call/WhatsApp karein.', 'Customer se naya waqt/address lein aur note likhein.', '"Stuck 6+ days" wale courier se poochein.', '"Returning" wale CS ko batayein.'], tip: 'Attempted order ko jaldi call karein — warna return ho jata hai.' },
    /* Finance */
    finance: { title: 'COD & payments', line: 'Courier par kitna COD baqi hai, aur jo paisa aa gaya usay mark karein.',
        steps: ['Courier chunein.', 'Delivered parcels jin ka paisa nahi aaya dekhein.', 'Payment aaye to select karke "Mark selected as paid".'], tip: '' },
    payables: { title: 'Payables', line: 'Suppliers ko kitna dena hai aur kab.',
        steps: ['Due date wale pehle dekhein.', 'Payment karke darj karein.'], tip: '' },
    accounts: { title: 'Accounts', line: 'Chart of accounts aur har account ka balance.', steps: ['Account par click karke ledger dekhein.', 'Naya account sirf zaroorat par banayein.'], tip: '' },
    vouchers: { title: 'Vouchers', line: 'Journal, payment aur receipt vouchers.', steps: ['"New voucher" dabayein.', 'Debit aur credit barabar hone chahiye.', 'Save karein.'], tip: '' },
    ledgers: { title: 'Ledgers', line: 'Account ya party ka poora hisaab.', steps: ['Account ya party chunein.', 'Dates chunein.', 'Print ya CSV karein.'], tip: '' },
    statements: { title: 'Statements', line: 'P&L, balance sheet, trial balance, cash aur bank book.', steps: ['Upar se statement chunein.', 'Month/dates chunein.', 'Print karein.'], tip: '' },
    close: { title: 'Month close', line: 'Mahine ke checks karke month lock karein.', steps: ['Har check green karein.', 'Sab theek ho to "Close month".', 'Close ke baad us month mein entry nahi hogi.'], tip: '' },
    expenses: { title: 'My expenses', line: 'Office ke liye jo kharcha kiya, receipt ki photo ke saath yahan likhein.',
        steps: ['"Add expense" dabayein.', 'Raqam, category aur note likhein.', 'Receipt ki photo lagayein.', 'Save karein — owner/finance approve karega.'], tip: 'Har kharcha usi din likhein.' },
    approvals: { title: 'Expense approvals', line: 'Staff ke kharche approve ya reject karein.', steps: ['Receipt dekhein.', 'Theek ho to Approve, warna Reject (wajah likhein).'], tip: '' },
    pettycash: { title: 'Petty cash', line: 'Petty cash box ka balance aur top-up.', steps: ['Box chunein.', 'Top-up darj karein.', 'Balance ginti se milayein.'], tip: '' },
    pettybox: { title: 'My cash box', line: 'Aap ke paas office ka cash: kitna mila, kitna kharch hua.', steps: ['Balance dekhein.', 'Har kharcha "My expenses" mein darj karein.'], tip: '' },
    /* Marketing */
    marketing: { title: 'Marketing', line: 'Meta ads ka kharcha, cost per order aur ROAS.', steps: ['Aaj aur is mahine ka spend dekhein.', 'ROAS 3 se kam ho to ads check karein.'], tip: '' },
    campaigns: { title: 'Campaigns', line: 'Har campaign ka result.', steps: ['Campaign chunein.', 'Spend aur orders dekhein.', 'Kharab campaign band karne ka faisla karein.'], tip: '' },
    'mkt-spend': { title: 'Marketing spend', line: 'Mahine ka ad spend accounts ke liye.', steps: ['Month chunein.', 'Spend check karein.', 'Accounts mein post karein.'], tip: '' },
    /* People */
    team: { title: 'Team today', line: 'Aaj kis ne kya kaam kiya, aur kis ne kaam nahi kiya (absent / "No work recorded").',
        steps: ['Upar "Didn\'t work" box dabayein — sirf woh log dikhenge jo absent hain ya jinka ERP mein koi kaam record nahi hua.', 'Har line mein: kab aaya, kitna kaam (calls, picks, tickets, carts…) aur target ke muqable %.', 'Naam par click karein — us ka poore din ka timeline khulega.', 'Laal flag (Absent, No work recorded, Idle) walon se usi din baat karein.', 'Purana din dekhna ho to upar date badlein.'],
        tip: '11 baje ke baad bhi "No work recorded" ho to banday se poochein.' },
    performance: { title: 'Performance', line: 'Har employee ka 7/30/90 din ka score, ranking aur "Needs review" list.',
        steps: ['Upar 7, 30 ya 90 din chunein.', 'Ranking mein score, absent, late aur mistakes dekhein.', '"Needs review" mein wajah likhi hoti hai — us par employee se baat karein.', 'Naam par click karke us ka din ya mistakes dekhein.', 'Export CSV se Excel mein le jayein.'],
        tip: 'Score sirf unka banta hai jinka target set hai (Team today → Targets & settings).' },
    hr: { title: 'Employees', line: 'Staff ka record: salary, joining, documents.', steps: ['Employee par click karein.', '"Add employee" se naya banda.', 'Salary aur documents update rakhein.'], tip: '' },
    attendance: { title: 'Attendance', line: 'Kaun aaya, kaun late, kaun absent.', steps: ['Date chunein.', 'Ghalat entry ho to Edit karein.', 'CSV download karein.'], tip: '' },
    leave: { title: 'Leave', line: 'Chutti ki requests.', steps: ['Request dekhein.', 'Approve ya Reject karein.'], tip: '' },
    payroll: { title: 'Payroll', line: 'Mahine ki salaries.', steps: ['Month chunein.', 'Salaries check karein.', 'Approve karke post karein.'], tip: '' },
    myhr: { title: 'My attendance', line: 'Aap ki haazri aur chuttiyan.', steps: ['Mahine ki haazri dekhein.', 'Chutti chahiye to "Request leave".'], tip: '' },
    payslip: { title: 'Payslip', line: 'Aap ki salary slip.', steps: ['Month chunein.', 'Print ya save karein.'], tip: '' },
    /* Admin */
    staff: { title: 'Staff & access', line: 'Staff ke login, role aur permissions.', steps: ['"Add user" se naya login.', 'Role chunein — role ke hisaab se screens milti hain.', 'Chhod jaye to user band karein.'], tip: '' },
    settings: { title: 'Settings', line: 'Shopify, PostEx, backup aur store ki settings.', steps: ['Sirf owner badle.', 'Save ke baad sync check karein.'], tip: '' },
};
/* help for the screen + sub-tab currently open (e.g. #/dispatch/pack → 'dispatch/pack', else 'dispatch') */
function helpKey(k, sub) { return sub && HELP[k + '/' + sub] ? k + '/' + sub : k; }
function helpFor(k, sub) { return HELP[helpKey(k, sub)] || null; }
function showHelp(k, sub) {
    k = k || CURRENT;
    if (sub == null)
        sub = (location.hash.replace(/^#\/?/, '').split('/')[1] || '');
    const x = helpFor(k, sub), m = viewMeta(k) || {};
    const body = x ? h('div', { class: 'grid helpbody' }, h('div', { class: 'helpline' }, x.line), h('ol', { class: 'helpsteps' }, x.steps.map(s => h('li', null, s.replace(/^\d+\.\s*/, '')))), x.tip ? h('div', { class: 'note ok' }, h('strong', null, 'Tip: '), x.tip) : null, h('div', { class: 'small muted' }, 'Phir bhi samajh na aaye? Owner ya manager se poochein.'))
        : h('div', { class: 'grid' }, h('div', null, 'Is screen ki help abhi nahi likhi gayi. Owner ya manager se poochein.'));
    modal('Help: ' + ((x && x.title) || m.title || 'this screen'), body, [h('button', { class: 'btn', onclick: e => e.target.closest('.modal').remove() }, 'OK, samajh gaya')]);
}
/* ---------- dashboard ---------- */
VIEWS.dashboard = async () => {
    const d = await GET('/api/dashboard');
    const P = d.pipeline || {}, sum = (...k) => k.reduce((s, x) => s + (P[x] || 0), 0);
    const tips = [];
    if (META.demo)
        tips.push(h('div', { class: 'note warn' }, 'You are looking at practice data (invented orders). Connect Shopify and PostEx in Settings, then clear the practice data.'));
    else if (!META.shopify && can('settings'))
        tips.push(h('div', { class: 'note row sp' }, h('span', null, 'Shopify is not connected yet. Load practice data (invented orders and shoes) to see how every screen works.'), h('button', { class: 'btn sm', onclick: async () => { await act(() => POST('/api/demo/load'), 'Practice data loaded'); location.reload(); } }, 'Load practice data')));
    render(tips, h('div', { class: 'kpis' }, kpi('Orders today', num(d.today.orders), rs(d.today.value), null, can('orders') ? '#/orders' : null), kpi('Last 7 days', num(d.week.orders), rs(d.week.value)), kpi('Delivery rate (30 days)', d.deliveryRate == null ? '–' : d.deliveryRate + '%', 'delivered vs returned', d.deliveryRate != null && d.deliveryRate < 75 ? 'alert' : 'good'), can('cs') && kpi('Waiting for confirmation', num(d.toConfirm), 'call these customers', d.toConfirm ? 'alert' : '', '#/cs'), can('warehouse') && kpi('To pick & pack', num(d.toPick), 'confirmed orders', null, can('couriers') ? '#/dispatch' : '#/warehouse/pick'), can('tracking') && kpi('Delivery attempted', num(d.attempted), 'call before it returns', d.attempted ? 'alert' : '', '#/tracking/attempted'), can('tracking') && kpi('Stuck parcels', num(d.stuck), 'no delivery in 6+ days', d.stuck ? 'alert' : '', '#/tracking/stuck'), can('warehouse') && kpi('Returns to receive', num(d.returnsPending), 'returning to office', null, '#/warehouse/returns'), d.codPending && kpi('COD not yet paid by PostEx', rs(d.codPending.v), num(d.codPending.n) + ' delivered parcels', null, '#/finance/cod'), can('inventory') && kpi('Stock on site', num(d.stock.items), rs(d.stock.value) + ' · ' + num(d.stock.aged) + ' older than 60 days', null, '#/inventory')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Orders per day', h('small', null, 'last 14 days')), chart(d.daily, 'day', [{ k: 'orders', l: 'Orders', c: C1 }])), h('div', { class: 'card' }, h('h2', null, 'Where orders are now', h('small', null, 'last 60 days')), table([{ t: 'Stage', f: r => r[0] }, { t: 'Orders', n: 1, f: r => num(r[1]) }], [
        ['New / to confirm', sum('new', 'hold')], ['Confirmed, in warehouse', sum('confirmed', 'picked', 'packed')], ['With PostEx', sum('dispatched', 'in_transit', 'out_for_delivery')],
        ['Delivery attempted', sum('attempted')], ['Delivered', sum('delivered')], ['Returning / returned', sum('returning', 'returned', 'return_received')], ['Cancelled', sum('cancelled', 'cs_cancelled', 'courier_cancelled')]
    ]))));
};
registerView({ key: 'ops', title: 'Order pipeline', group: 'Orders & CS', perm: 'orders', icon: 'pipeline', order: 80 }, VIEWS.dashboard);
/* ---------- orders ---------- */
const STATUS_GROUPS = [['', 'All statuses'], ['new,hold', 'To confirm'], ['confirmed,picked,packed', 'In warehouse'], ['dispatched,in_transit,out_for_delivery', 'With PostEx'], ['attempted', 'Delivery attempted'],
    ['delivered', 'Delivered'], ['returning,returned', 'Returning'], ['return_received', 'Return received'], ['cancelled,cs_cancelled,courier_cancelled', 'Cancelled']];
VIEWS.orders = async (args) => {
    const f = { q: args[0] || '', status: '', from: '', to: '', label: '', page: 1 };
    const box = h('div');
    const qi = h('input', { placeholder: 'Search order, name, phone, SKU, tracking, city', value: f.q, class: 'grow' });
    const st = h('select', null, STATUS_GROUPS.map(([v, l]) => h('option', { value: v }, l)));
    const fr = h('input', { type: 'date' }), to = h('input', { type: 'date' });
    const lb = h('select', null, ['', 'Trusted', 'Good', 'New', 'Risky', 'Blacklisted'].map(v => h('option', { value: v }, v || 'Any customer')));
    const load = async () => {
        Object.assign(f, { q: qi.value, status: st.value, from: fr.value, to: to.value, label: lb.value });
        const d = await GET('/api/orders?' + qs(f));
        box.replaceChildren(table([
            { t: 'Order', f: r => h('strong', null, r.name) }, { t: 'Date', f: r => dt(r.created_at) }, { t: 'Customer', f: r => [r.cust_name, h('div', { class: 'small muted' }, r.phone, ' · ', r.city)] },
            { t: 'Items', f: r => h('div', { class: 'small', style: { maxWidth: '260px' } }, r.items_text || r.items) },
            { t: 'History', f: r => [labelB(r.clabel), h('div', { class: 'small muted' }, hist(r.cdel, r.cret))] },
            { t: 'Total', n: 1, f: r => rs(r.total) }, { t: 'Status', f: r => [statusB(r.status), r.missing ? h('div', null, h('span', { class: 'b bad' }, 'item missing')) : null] },
        ], d.rows, r => openOrder(r.id)), pager(d, p => { f.page = p; load(); }));
    };
    [st, fr, to, lb].forEach(x => x.addEventListener('change', () => { f.page = 1; load(); }));
    qi.addEventListener('keydown', e => { if (e.key === 'Enter') {
        f.page = 1;
        load();
    } });
    render(h('div', { class: 'card' }, h('div', { class: 'row' }, qi, st, lb, h('span', { class: 'small muted' }, 'From'), fr, h('span', { class: 'small muted' }, 'to'), to), h('div', { style: { marginTop: '10px' } }, box)));
    await load();
};
async function openOrder(id) {
    let d;
    try {
        d = await GET('/api/orders/' + encodeURIComponent(id));
    }
    catch (e) {
        return toast(e.message, true);
    }
    const o = d.order, c = d.customer;
    const dr = drawer([]);
    const reload = () => { dr.remove(); openOrder(o.id); };
    const stage = (s, label, cls) => h('button', { class: 'btn sm ' + (cls || 'ghost'), onclick: () => act(() => POST(`/api/orders/${encodeURIComponent(o.id)}/stage`, { stage: s }), 'Saved').then(reload) }, label);
    const shopNum = String(o.id).split('/').pop();
    const timeline = [
        ...d.events.map(e => ({ at: e.at, t: `${e.user || 'System'}: ${e.action}${e.detail && e.detail !== '""' && e.detail !== 'null' ? ' · ' + e.detail.replace(/^"|"$/g, '') : ''}` })),
        ...d.calls.map(c2 => ({ at: c2.at, t: `${c2.user || ''} called: ${c2.outcome.replace('_', ' ')}${c2.note ? ' · ' + c2.note : ''}` })),
        ...(o.px_history || []).map(x => ({ at: x.modifiedDatetime || x.updatedAt || '', t: 'PostEx: ' + (x.transactionStatusMessage || x.status || JSON.stringify(x)) })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const note = h('input', { placeholder: 'Add a note for the team…', class: 'grow' });
    dr.firstChild.append(h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'big' }, o.name, ' ', statusB(o.status)), h('div', { class: 'muted small' }, dt(o.created_at), ' · ', o.gateway || '', ' · ', o.source || '')), h('button', { class: 'btn ghost sm', onclick: () => dr.remove() }, 'Close')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Customer'), h('div', { class: 'big', style: { fontSize: '16px' } }, o.cust_name), h('div', null, o.phone, ' · ', o.city), o.address ? h('div', { class: 'small muted' }, o.address) : null, h('div', { class: 'row', style: { marginTop: '8px' } }, labelB(c && c.label), h('span', { class: 'small muted' }, c ? `${c.orders} orders · ${hist(c.delivered, c.returned)} · ${c.cancelled} cancelled` : 'first order')), d.wa ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('a', { class: 'btn sm ghost', href: 'tel:' + o.phone }, 'Call'), h('a', { class: 'btn sm ghost', target: '_blank', href: waLink(d.wa) }, 'WhatsApp')) : null), h('div', { class: 'card' }, h('h2', null, 'Order'), h('dl', { class: 'dl' }, h('dt', null, 'Total'), h('dd', null, rs(o.total), o.discount ? h('span', { class: 'muted small' }, ` (discount ${rs(o.discount)})`) : ''), h('dt', null, 'Shopify tags'), h('dd', { class: 'small' }, o.tags || '–'), h('dt', null, 'Tracking'), h('dd', null, o.tracking ? [trackLink(o.tracking, o.courier), o.courier ? h('span', { class: 'muted small' }, ' · ' + o.courier) : null] : '–', o.px_status ? h('div', { class: 'small muted' }, o.px_status, ' · ', dt(o.px_updated)) : ''), o.cod != null && h('dt', null, 'COD / charges'), o.cod != null && h('dd', null, rs(o.cod), ' · fee ', rs((o.px_fee || 0) + (o.px_tax || 0)), o.settled ? h('span', { class: 'b ok' }, ' paid') : ''), o.cs_note && h('dt', null, 'CS note'), o.cs_note && h('dd', null, o.cs_note)), d.shop && !String(o.id).startsWith('demo') ? h('a', { class: 'small', target: '_blank', href: `https://${d.shop}/admin/orders/${shopNum}` }, 'Open in Shopify ↗') : null)), h('div', { class: 'card' }, h('h2', null, 'Items'), table([
        { t: '', f: r => r.image ? h('img', { class: 'thumb', src: r.image, alt: '' }) : h('div', { class: 'thumb' }) },
        { t: 'Item', f: r => [r.title, h('div', { class: 'small muted mono' }, r.sku, r.size ? ' · ' + r.size : '', r.cond ? ' · ' + r.cond : '')] },
        { t: 'Rack', f: r => h('span', { class: 'mono' }, r.location || '–') }, { t: 'Price', n: 1, f: r => rs(r.price) }, { t: 'Picked', f: r => r.picked ? h('span', { class: 'b ok' }, 'yes') : h('span', { class: 'b' }, 'no') }
    ], d.items)), can('orders_edit') ? h('div', { class: 'card' }, h('h2', null, 'Move order to'), h('div', { class: 'row' }, stage('confirmed', 'Confirmed', 'ok'), stage('hold', 'On hold'), stage('cs_cancelled', 'Cancel order', 'bad'), stage('picked', 'Picked'), stage('packed', 'Packed'), stage('new', 'Back to new')), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Booking, delivery and returns update by themselves from Shopify and PostEx.')) : null, h('div', { class: 'card' }, h('h2', null, 'History & notes'), h('div', { class: 'row' }, note, h('button', { class: 'btn sm', onclick: () => act(() => POST(`/api/orders/${encodeURIComponent(o.id)}/note`, { note: note.value }), 'Note added').then(reload) }, 'Add note')), h('div', { style: { marginTop: '10px' } }, timeline.length ? timeline.map(t => h('div', { class: 'small', style: { padding: '5px 0', borderBottom: '1px solid var(--line)' } }, h('span', { class: 'muted' }, dt(t.at), ' · '), t.t)) : h('div', { class: 'muted small' }, 'No history yet.'))), d.others.length ? h('div', { class: 'card' }, h('h2', null, 'Other orders from this customer'), table([{ t: 'Order', k: 'name' }, { t: 'Date', f: r => dt(r.created_at) }, { t: 'Total', n: 1, f: r => rs(r.total) }, { t: 'Status', f: r => statusB(r.status) }], d.others, r => { dr.remove(); openOrder(r.id); })) : null);
}
function productModal(r) {
    const p = r.product;
    modal(p.sku, h('div', { class: 'grid' }, h('div', { class: 'row' }, p.image ? h('img', { class: 'thumb', src: p.image, style: { width: '80px', height: '80px' } }) : null, h('div', null, h('strong', null, p.title), h('div', { class: 'small muted' }, [p.brand, p.size, p.cond, p.lot].filter(Boolean).join(' · ')))), h('dl', { class: 'dl' }, h('dt', null, 'Price'), h('dd', null, rs(p.price), p.compare_at ? h('span', { class: 'muted' }, ' (was ' + rs(p.compare_at) + ')') : ''), h('dt', null, 'Cost'), h('dd', null, rs(p.cost)), h('dt', null, 'Stock'), h('dd', null, p.qty > 0 ? 'In stock' : 'Sold'), h('dt', null, 'Location'), h('dd', { class: 'mono' }, p.loc || p.rack || '–'), h('dt', null, 'Listed'), h('dd', null, day(p.created_at))), r.inOrders.length ? table([{ t: 'Order', k: 'name' }, { t: 'Date', f: x => dt(x.created_at) }, { t: 'Status', f: x => statusB(x.status) }], r.inOrders, x => openOrder(x.id)) : null));
}
registerView({ key: 'orders', title: 'Orders', group: 'Orders & CS', perm: 'orders', icon: 'cart', order: 30 }, VIEWS.orders);
/* ---------- CS / confirmation ---------- */
VIEWS.cs = async (args) => {
    let view = args[0] || 'todo';
    const load = async () => {
        const d = await GET('/api/cs/queue?view=' + view);
        const MODE = { off: 'Confirmation is OFF: every order goes straight to the warehouse.', risky: 'Only new and risky customers need a call. Trusted customers are confirmed automatically.', all: 'Every order needs a call before it goes to the warehouse.' };
        const fill = r => d.template.replace('{name}', (r.cust_name || '').split(' ')[0]).replace('{order}', r.name).replace('{items}', r.items_text || '').replace('{total}', Math.round(r.total).toLocaleString());
        const call = (r, outcome, extra) => act(() => POST(`/api/cs/${encodeURIComponent(r.id)}/call`, Object.assign({ outcome }, extra)), 'Saved').then(load);
        const card = r => h('div', { class: 'cs-card' }, h('div', null, h('div', { class: 'row' }, h('strong', { style: { cursor: 'pointer' }, onclick: () => openOrder(r.id) }, r.name), labelB(r.clabel), h('span', { class: 'small muted' }, r.corders > 1 ? `${r.corders} orders · ${hist(r.cdel, r.cret)}` : 'first order'), r.cs_attempts ? h('span', { class: 'b warn' }, r.cs_attempts + ' calls') : null, /incomplete|partial/i.test(r.tags || '') ? h('span', { class: 'b warn' }, 'address?') : null), h('div', null, r.cust_name, ' · ', h('a', { href: 'tel:' + r.phone }, r.phone), ' · ', r.city), r.address ? h('div', { class: 'small muted' }, r.address) : null, h('div', { class: 'small', style: { marginTop: '4px' } }, r.items_text, ' · ', h('strong', null, rs(r.total))), r.cs_note ? h('div', { class: 'small muted' }, 'Note: ', r.cs_note) : null, r.cs_next ? h('div', { class: 'small muted' }, 'Call again: ', dt(r.cs_next)) : null, view === 'attempted' && r.px_status ? h('div', { class: 'small' }, 'PostEx: ', r.px_status) : null), h('div', { class: 'acts' }, h('a', { class: 'btn sm ghost', href: 'tel:' + r.phone }, 'Call'), h('a', { class: 'btn sm ghost', target: '_blank', href: waLink(r.wa, view === 'attempted' ? `Assalam o Alaikum! Aap ka SundayBazar order ${r.name} PostEx rider ne deliver karne ki koshish ki thi. Kya hum dobara bhejwa dein?` : fill(r)) }, 'WhatsApp'), view === 'attempted' ? [h('button', { class: 'btn sm ok', onclick: () => call(r, 'delivery_retry', { note: prompt('Note for PostEx / team (optional)') || '' }) }, 'Wants delivery'), h('button', { class: 'btn sm bad', onclick: () => call(r, 'delivery_cancel', { note: prompt('Reason') || '' }) }, 'Refuses')] : [
            h('button', { class: 'btn sm ok', onclick: () => call(r, 'confirmed') }, 'Confirm'),
            h('button', { class: 'btn sm warn', onclick: () => call(r, 'no_answer') }, 'No answer'),
            h('button', { class: 'btn sm ghost', onclick: () => { const t = prompt('Call back when? (e.g. 2026-10-08 18:00)'); if (t)
                    call(r, 'callback', { next: t }); } }, 'Call later'),
            h('button', { class: 'btn sm ghost', onclick: () => call(r, 'wrong_number', { note: 'Wrong / switched off number' }) }, 'Wrong no.'),
            h('button', { class: 'btn sm bad', onclick: () => { const why = prompt('Why is the customer cancelling?'); if (why != null)
                    call(r, 'cancelled', { note: why }); } }, 'Cancel')
        ]));
        render(h('div', { class: 'note' }, MODE[d.mode] || '', can('settings') ? [' ', h('a', { href: '#/settings' }, 'Change')] : ''), tabs([['todo', 'To call now', d.counts.todo || 0], ['later', 'Call later', d.counts.later || 0], ['attempted', 'Delivery attempted', d.counts.attempted || 0]], view, v => { view = v; load(); }), d.rows.length ? h('div', { class: 'grid' }, d.rows.map(card)) : h('div', { class: 'card empty' }, view === 'attempted' ? 'No failed delivery attempts right now.' : 'All done. No orders waiting for a call.'));
    };
    await load();
};
registerView({ key: 'cs', title: 'Confirmation', group: 'Orders & CS', perm: 'cs', icon: 'phone', order: 20 }, VIEWS.cs);
/* ---------- customers ---------- */
VIEWS.customers = async () => {
    const f = { q: '', label: '', sort: 'recent', page: 1 };
    const box = h('div'), chips = h('div', { class: 'row' });
    const qi = h('input', { placeholder: 'Search name, phone, city', class: 'grow' });
    const so = h('select', null, [['recent', 'Recent'], ['spent', 'Top spenders'], ['orders', 'Most orders'], ['risky', 'Most returns']].map(([v, l]) => h('option', { value: v }, l)));
    const load = async () => {
        Object.assign(f, { q: qi.value, sort: so.value });
        const d = await GET('/api/customers?' + qs(f));
        chips.replaceChildren(...[['', 'All']].concat(d.labels.map(l => [l.label, l.label + ' ' + num(l.n)])).map(([v, l]) => h('button', { class: 'btn sm ' + (f.label === v ? '' : 'ghost'), onclick: () => { f.label = v; f.page = 1; load(); } }, l)));
        box.replaceChildren(table([
            { t: 'Customer', f: r => [h('strong', null, r.name), h('div', { class: 'small muted' }, r.phone, ' · ', r.city)] }, { t: 'Label', f: r => [labelB(r.label), r.fnote ? h('div', { class: 'small muted' }, r.fnote) : null] },
            { t: 'Orders', n: 1, k: 'orders' }, { t: 'Delivered', n: 1, k: 'delivered' }, { t: 'Returned', n: 1, k: 'returned' }, { t: 'Cancelled', n: 1, k: 'cancelled' },
            { t: 'Success', n: 1, f: r => pct(r.delivered, r.delivered + r.returned) }, { t: 'Spent', n: 1, f: r => rs(r.spent) }, { t: 'Last order', f: r => day(r.last_order) }
        ], d.rows, r => customerModal(r.phone, load)), pager(d, p => { f.page = p; load(); }));
    };
    so.addEventListener('change', load);
    qi.addEventListener('keydown', e => { if (e.key === 'Enter') {
        f.page = 1;
        load();
    } });
    render(h('div', { class: 'card' }, h('div', { class: 'row' }, qi, so), h('div', { style: { margin: '10px 0' } }, chips), box), h('div', { class: 'small muted' }, 'Labels: Trusted = 2+ delivered and 80%+ success. Risky = under 50% success or repeated returns. Blacklisted = marked by staff. Labels update after every sync.'));
    await load();
};
async function customerModal(phone, after) {
    const d = await GET('/api/customers/' + encodeURIComponent(phone));
    const c = d.customer || {}, fl = d.flag || {};
    const bl = h('input', { type: 'checkbox', checked: fl.blacklist }), vip = h('input', { type: 'checkbox', checked: fl.vip }), note = h('input', { value: fl.note || '', placeholder: 'Note (e.g. refuses parcels)', class: 'grow' });
    const m = modal(c.name || phone, h('div', { class: 'grid' }, h('div', null, phone, ' · ', c.city, ' ', labelB(c.label), ' ', h('a', { target: '_blank', href: waLink(d.wa) }, 'WhatsApp')), h('div', { class: 'small muted' }, `${c.orders || 0} orders · ${hist(c.delivered, c.returned)} · spent ${rs(c.spent)}`), can('customers_edit') ? h('div', { class: 'row' }, h('label', { class: 'row' }, bl, 'Blacklist'), h('label', { class: 'row' }, vip, 'Always trusted (VIP)'), note) : null, table([{ t: 'Order', k: 'name' }, { t: 'Date', f: r => dt(r.created_at) }, { t: 'Total', n: 1, f: r => rs(r.total) }, { t: 'Status', f: r => statusB(r.status) }], d.orders, r => { m.remove(); openOrder(r.id); })), can('customers_edit') ? [h('button', { class: 'btn', onclick: () => act(() => POST('/api/customers/' + encodeURIComponent(phone) + '/flag', { blacklist: bl.checked, vip: vip.checked, note: note.value }), 'Saved').then(() => { m.remove(); after && after(); }) }, 'Save')] : null);
}
registerView({ key: 'customers', title: 'Customers', group: 'Orders & CS', perm: 'customers', icon: 'people', order: 70 }, VIEWS.customers);
/* ---------- tracking ---------- */
VIEWS.tracking = async (args) => {
    let b = args[0] || 'active';
    const load = async () => {
        const d = await GET('/api/tracking?bucket=' + b);
        render(tabs([['active', 'On the way', d.counts.active], ['attempted', 'Attempted', d.counts.attempted], ['stuck', 'Stuck 6+ days', d.counts.stuck], ['returning', 'Returning', d.counts.returning], ['delivered', 'Delivered (7 days)', d.counts.delivered]], b, x => { b = x; load(); }), h('div', { class: 'small muted' }, META.postex ? `PostEx last checked ${d.lastSync ? ago(d.lastSync.at) + ' · ' + d.lastSync.message : 'never'}` : 'PostEx is not connected: statuses come only from Shopify. Add the PostEx token in Settings.'), h('div', { class: 'card' }, table([
            { t: 'Order', f: r => h('strong', null, r.name) }, { t: 'Customer', f: r => [r.cust_name, ' ', labelB(r.clabel), h('div', { class: 'small muted' }, r.phone, ' · ', r.city)] },
            { t: 'Tracking', f: r => h('div', null, trackLink(r.tracking, r.courier, 'mono'), r.courier ? h('div', { class: 'small muted' }, r.courier) : null) },
            { t: 'Status', f: r => [statusB(r.status), h('div', { class: 'small muted' }, r.px_status || '')] }, { t: 'Days', n: 1, f: r => { var _a; return h('span', { class: r.days > 6 ? 'b bad' : '' }, (_a = r.days) !== null && _a !== void 0 ? _a : '–'); } },
            { t: 'Updated', f: r => r.px_updated ? dt(r.px_updated) : '–' }, { t: 'COD', n: 1, f: r => rs(r.total) },
            { t: '', f: r => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('a', { class: 'btn ghost sm', target: '_blank', href: waLink(r.wa, `Assalam o Alaikum! Aap ka SundayBazar order ${r.name} (PostEx ${r.tracking}) raste mein hai. Rider call kare to please receive kar lijiye ga. Shukriya!`) }, 'WhatsApp'), META.postex ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/tracking/${encodeURIComponent(r.id)}/refresh`), 'Updated').then(load) }, 'Refresh') : null) }
        ], d.rows, r => openOrder(r.id))));
    };
    await load();
};
registerView({ key: 'tracking', title: 'Tracking', group: 'Tracking', perm: 'tracking', icon: 'truck', order: 10 }, VIEWS.tracking);
/* ---------- exchanges & refunds (part of the tickets module) ---------- */
const TK_STEPS = ['requested', 'approved', 'received', 'dispatched', 'completed'];
const TK_NEXT_L = { approved: 'Approve exchange', received: 'Old item received', dispatched: 'New item dispatched', completed: 'Mark completed' };
const TK_REF_CLS = { pending: 'warn', approved: 'info', paid: 'ok', rejected: 'bad' };
const tkRefSt = s => h('span', { class: 'b ' + (TK_REF_CLS[s] || '') }, s === 'approved' ? 'approved · to pay' : s);
const tkDiffTxt = x => x.diff > 0 ? `Customer pays ${rs(x.diff)} extra` : x.diff < 0 ? `${x.diff_mode === 'refund' ? 'Refund' : 'Store credit'} ${rs(-x.diff)}` : 'Same price';
/* ---------- exchanges board ---------- */
VIEWS.exchanges = async (args) => {
    const m = await tkMeta();
    let showAll = args[0] === 'all';
    const qi = h('input', { placeholder: 'Search order, name, phone, tracking', class: 'grow' });
    const box = h('div', { style: { minWidth: 0 } });
    const load = async () => {
        const d = await GET('/api/exchanges?' + qs({ q: qi.value, all: showAll ? 1 : '' }));
        const cols = TK_STEPS.concat(showAll ? ['cancelled'] : []);
        box.replaceChildren(h('div', { class: 'kanban', style: { gridAutoColumns: 'minmax(230px,1fr)' } }, cols.map(st => {
            const rows = d.rows.filter(r => r.step === st);
            return h('div', { class: 'col' }, h('h3', null, m.steps[st], h('span', null, rows.length)), rows.length ? rows.map(r => h('div', { class: 'tile', onclick: () => tkOpenExchange(r.id, load) }, h('div', { class: 'row sp' }, h('strong', null, '#' + r.id + (r.order_name ? ' · ' + r.order_name : '')), h('span', { class: 'small muted' }, ago(r.updated_at))), h('div', { class: 'small' }, r.cust_name || r.phone), h('div', { class: 'small muted mono', style: { marginTop: '4px' } }, r.items.filter(i => i.dir === 'old').map(i => i.sku).join(', '), ' → ', r.items.filter(i => i.dir === 'new').map(i => i.sku).join(', ')), h('div', { class: 'row', style: { marginTop: '6px' } }, r.diff ? h('span', { class: 'b ' + (r.diff > 0 ? 'info' : 'accent') }, tkDiffTxt(r)) : null, r.reverse_tracking ? h('span', { class: 'b', title: 'Reverse pickup' }, '↩ ' + r.reverse_tracking) : null, r.out_tracking ? h('span', { class: 'b', title: 'Outbound' }, '→ ' + r.out_tracking) : null)))
                : h('div', { class: 'small muted', style: { padding: '6px 2px' } }, 'Nothing here'));
        })));
    };
    qi.addEventListener('keydown', e => { if (e.key === 'Enter')
        load(); });
    render(pageHead('Exchanges', 'Size swaps and wrong-item replacements, from request to completed.', h('button', { class: 'btn primary', onclick: () => tkNewExchange({}, load) }, '+ New exchange')), h('div', { class: 'toolbar' }, qi, h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: showAll, onchange: e => { showAll = e.target.checked; load(); } }), 'Show cancelled & older')), box);
    await load();
};
async function tkOpenExchange(id, after) {
    const m = await tkMeta();
    let d;
    try {
        d = await GET('/api/exchanges/' + id);
    }
    catch (e) {
        return toast(e.message, true);
    }
    document.querySelectorAll('.drawer.tk-ex').forEach(x => x.remove());
    const e = d.exchange, live = !['completed', 'cancelled'].includes(e.step), next = TK_STEPS[TK_STEPS.indexOf(e.step) + 1];
    const dr = drawer([]);
    dr.classList.add('tk-ex');
    const reload = () => { tkOpenExchange(e.id, after); after && after(); };
    const rev = h('input', { value: e.reverse_tracking || '', placeholder: 'Reverse pickup tracking no.' }), out = h('input', { value: e.out_tracking || '', placeholder: 'Outbound tracking no.' });
    const note = h('input', { placeholder: 'Note for this step (optional)', class: 'grow' });
    const step = (st, extra) => act(() => POST(`/api/exchanges/${e.id}/step`, Object.assign({ step: st, note: note.value, reverse_tracking: rev.value.trim() || undefined, out_tracking: out.value.trim() || undefined }, (extra || {}))), m.steps[st]).then(reload);
    // completing the exchange also resolves its ticket: ask "whose mistake" here so the ticket is closed properly
    const complete = async () => {
        let tt = null;
        try {
            tt = e.ticket_id ? (await GET('/api/tickets/' + e.ticket_id)).ticket : null;
        }
        catch (x) { }
        if (!tt || tkDone(tt) || tt.fault_dept || !m.faultTypes.includes(tt.type))
            return step('completed');
        let sug = null;
        try {
            sug = await GET(`/api/tickets/${tt.id}/fault`);
        }
        catch (x) { }
        const fp = tkFaultPicker(m, { sug, required: false });
        const md = tkModal('Complete exchange #' + e.id, h('div', { class: 'grid' }, h('div', { class: 'note' }, 'This also resolves ticket ', h('strong', null, tkNum(tt.id)), ' (', tt.type, '). Whose mistake caused it?'), fp.el), [h('button', { class: 'btn ghost', onclick: () => { md.remove(); step('completed'); } }, 'Skip, decide later'), h('button', { class: 'btn primary', onclick: () => { md.remove(); step('completed', { fault: fp.get() }); } }, 'Complete exchange')]);
        md.querySelector('.in').style.width = 'min(720px,100%)';
    };
    const items = dir => d.items.filter(i => i.dir === dir);
    const itemList = (list) => h('div', { class: 'tk-items' }, list.map(i => h('div', null, h('span', null, i.title || '—', ' ', h('span', { class: 'mono muted' }, i.sku), i.size ? h('span', { class: 'muted' }, ' · ' + i.size) : ''), h('span', null, rs(i.price)))));
    tkPut(dr.firstChild, h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'small muted' }, 'Exchange #' + e.id, ' · created ', dt(e.created_at)), h('div', { class: 'big', style: { fontSize: '19px' } }, (e.order_name || 'No order') + ' · ' + (e.cust_name || e.phone))), h('button', { class: 'btn ghost sm', onclick: () => dr.remove() }, 'Close')), h('div', { class: 'steps' }, TK_STEPS.map((s, i) => h('span', { class: TK_STEPS.indexOf(e.step) >= i ? 'on' : '' }, m.steps[s])), e.step === 'cancelled' ? h('span', { class: 'b bad' }, 'Cancelled') : null), live ? h('div', { class: 'card' }, h('h2', null, 'Next step'), h('div', { class: 'fgrid' }, field('Reverse pickup tracking', rev), field('Outbound tracking', out)), h('div', { class: 'row', style: { marginTop: '10px' } }, note), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary big', onclick: () => next === 'completed' ? complete() : step(next) }, TK_NEXT_L[next] + ' →'), h('button', { class: 'btn ghost', onclick: () => act(() => POST('/api/exchanges/' + e.id, { reverse_tracking: rev.value.trim(), out_tracking: out.value.trim() }), 'Saved').then(reload) }, 'Save tracking only'), h('button', { class: 'btn bad sm', onclick: () => { if (confirm('Cancel this exchange?'))
            step('cancelled'); } }, 'Cancel exchange'))) : null, e.wms_note ? h('div', { class: 'note' + (/not connected|failed/.test(e.wms_note) ? ' warn' : ' ok') }, e.wms_note) : null, h('div', { class: 'tk-two' }, h('div', { class: 'card' }, h('h2', null, 'Coming back (old)'), itemList(items('old')), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Total ', rs(e.old_total))), h('div', { class: 'card' }, h('h2', null, 'Going out (new)'), itemList(items('new')), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Total ', rs(e.new_total)))), h('div', { class: 'card' }, h('dl', { class: 'dl' }, h('dt', null, 'Price difference'), h('dd', null, h('strong', null, tkDiffTxt(e))), h('dt', null, 'Reverse pickup'), h('dd', { class: 'mono' }, e.reverse_tracking || '–'), h('dt', null, 'Outbound'), h('dd', { class: 'mono' }, e.out_tracking || '–'), e.ticket_id ? h('dt', null, 'Ticket') : null, e.ticket_id ? h('dd', null, h('a', { href: '#', onclick: ev => { ev.preventDefault(); tkOpen(e.ticket_id); } }, tkNum(e.ticket_id))) : null, d.refund ? h('dt', null, 'Refund') : null, d.refund ? h('dd', null, '#' + d.refund.id, ' · ', d.refund.method, ' · ', rs(d.refund.amount), ' ', tkRefSt(d.refund.status)) : null, e.note ? h('dt', null, 'Note') : null, e.note ? h('dd', null, e.note) : null)), h('div', { class: 'card' }, h('h2', null, 'History'), h('div', { class: 'timeline' }, d.log.slice().reverse().map(l => h('div', null, h('div', null, h('strong', null, m.steps[l.step]), l.note ? ' · ' + l.note : ''), h('div', { class: 't' }, dt(l.at), ' · ', l.user || 'System'))))));
}
async function tkNewExchange(pre = {}, after) {
    const m = await tkMeta();
    let order = pre.order || null;
    const picked = [];
    const oldBox = h('div', { class: 'grid', style: { gap: '6px' } }), newBox = h('div', { class: 'tk-items' }), diffBox = h('div'), res = h('div', { class: 'tk-res' });
    const oldManual = h('input', { placeholder: 'SKU of the pair coming back', class: 'grow' });
    const mode = h('select', null, h('option', { value: 'store_credit' }, 'Give store credit'), h('option', { value: 'refund' }, 'Refund the difference'));
    const rmethod = h('select', null, m.methods.filter(x => x !== 'Store credit').map(x => h('option', { value: x }, x)));
    const rev = h('input', { placeholder: 'Reverse pickup tracking (optional)' }), out = h('input', { placeholder: 'Outbound tracking (optional)' }), note = h('textarea', { placeholder: 'Note (size wanted, reason…)' });
    const phone = h('input', { placeholder: '03xx xxxxxxx', value: (pre.ticket && pre.ticket.phone) || '' });
    const oldChecks = [];
    const drawOld = () => {
        oldChecks.length = 0;
        if (order)
            oldBox.replaceChildren(...order.items.map(i => { const c = h('input', { type: 'checkbox', checked: order.items.length === 1 || (pre.ticket && pre.ticket.sku === i.sku), onchange: drawDiff }); c.dataset.sku = i.sku; c.dataset.price = i.price; oldChecks.push(c); return h('label', { class: 'row small' }, c, i.title, ' ', h('span', { class: 'mono muted' }, i.sku), ' · ', rs(i.price)); }));
        else
            oldBox.replaceChildren(h('div', { class: 'row' }, oldManual));
        drawDiff();
    };
    const oldSel = () => order ? oldChecks.filter(c => c.checked).map(c => ({ sku: c.dataset.sku, price: +c.dataset.price })) : (oldManual.value.trim() ? [{ sku: oldManual.value.trim(), price: 0 }] : []);
    const drawDiff = () => {
        newBox.replaceChildren(...picked.map((p, i) => h('div', null, h('span', null, p.title, ' ', h('span', { class: 'mono muted' }, p.sku), p.size ? ' · ' + p.size : ''), h('span', null, rs(p.price), ' ', h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { picked.splice(i, 1); drawDiff(); } }, '×')))));
        if (!picked.length)
            newBox.append(h('div', { class: 'muted small', style: { background: 'none' } }, 'No new pair picked yet.'));
        const diff = Math.round(picked.reduce((s, p) => s + p.price, 0) - oldSel().reduce((s, p) => s + p.price, 0));
        diffBox.replaceChildren(!picked.length || !oldSel().length ? h('span') : diff > 0 ? h('div', { class: 'note' }, `New pair costs ${rs(diff)} more: collect it as COD on the outbound parcel.`)
            : diff < 0 ? h('div', { class: 'grid', style: { gap: '6px' } }, h('div', { class: 'note ok' }, `New pair is ${rs(-diff)} cheaper.`), h('div', { class: 'row' }, mode, mode.value === 'refund' ? rmethod : null)) : h('div', { class: 'note' }, 'Same price: no money changes hands.'));
    };
    mode.addEventListener('change', drawDiff);
    const sq = h('input', { placeholder: 'Find new pair: SKU, brand, size (e.g. Nike 40)', class: 'grow' });
    const search = async () => {
        if (sq.value.trim().length < 2)
            return;
        const rows = await act(() => GET('/api/exchanges/products?q=' + encodeURIComponent(sq.value.trim())));
        res.replaceChildren(...(rows.length ? rows.map(p => h('div', { class: 'tile', style: { opacity: p.reserved ? .55 : 1 }, onclick: () => { if (p.reserved)
                return toast('Already promised in another exchange', true); if (!picked.some(x => x.sku === p.sku))
                picked.push(p); res.replaceChildren(); sq.value = ''; drawDiff(); } }, h('div', { class: 'row sp' }, h('strong', null, p.title), h('span', null, rs(p.price))), h('div', { class: 'small muted' }, h('span', { class: 'mono' }, p.sku), ' · ', [p.size, p.cond, p.location].filter(Boolean).join(' · '), p.reserved ? ' · reserved' : ' · in stock'))) : [h('div', { class: 'muted small' }, 'No in-stock pair found.')]));
    };
    sq.addEventListener('keydown', e => { if (e.key === 'Enter') {
        e.preventDefault();
        search();
    } });
    const finder = pre.order ? null : tkOrderFinder(o => { order = o; if (o)
        phone.value = o.phone; drawOld(); });
    const err = h('div', { class: 'flash bad', hidden: true });
    const save = async () => {
        try {
            const r = await POST('/api/exchanges', { ticket_id: pre.ticket ? pre.ticket.id : null, order_id: order ? order.id : null, phone: phone.value, old_items: oldSel().map(x => x.sku), new_items: picked.map(p => p.sku),
                diff_mode: mode.value, refund_method: rmethod.value, reverse_tracking: rev.value.trim(), out_tracking: out.value.trim(), note: note.value });
            md.remove();
            toast('Exchange #' + r.id + ' created');
            after && after();
            tkOpenExchange(r.id, after);
        }
        catch (x) {
            err.hidden = false;
            err.textContent = x.message;
        }
    };
    const md = modal('New exchange' + (pre.ticket ? ' · ' + tkNum(pre.ticket.id) : ''), h('div', { class: 'grid' }, err, finder ? h('label', { class: 'f' }, 'Order', finder.el) : (order ? tkOrderCard(order) : null), !order && !finder ? field('Customer phone', phone) : null, h('label', { class: 'f' }, 'Old pair (coming back)', oldBox), h('label', { class: 'f' }, 'New pair (going out)', h('div', { class: 'grid', style: { gap: '8px' } }, h('div', { class: 'row' }, sq, h('button', { class: 'btn ghost', type: 'button', onclick: search }, 'Find')), res, newBox)), diffBox, h('div', { class: 'fgrid' }, field('Reverse pickup tracking', rev), field('Outbound tracking', out)), field('Note', note)), [h('button', { class: 'btn primary', onclick: save }, 'Create exchange')]);
    md.querySelector('.in').style.width = 'min(720px,100%)';
    drawOld();
}
/* ---------- refunds register ---------- */
VIEWS.refunds = async (args) => {
    const m = can('tickets') ? await tkMeta() : { methods: ['Bank transfer', 'JazzCash', 'EasyPaisa', 'Store credit'] };
    let st = args[0] || 'pending';
    const F = { method: '', from: '', to: '', q: '' };
    const meth = h('select', null, h('option', { value: '' }, 'Any method'), m.methods.map(x => h('option', { value: x }, x)));
    const fr = h('input', { type: 'date' }), to = h('input', { type: 'date' }), qi = h('input', { placeholder: 'Search order, name, phone, reference', class: 'grow' });
    const tabBox = h('div', { style: { minWidth: 0 } }), box = h('div', { class: 'grid', style: { minWidth: 0, gap: '16px' } }), headBox = h('div', { style: { minWidth: 0 } });
    let last = null;
    const load = async () => {
        Object.assign(F, { method: meth.value, from: fr.value, to: to.value, q: qi.value });
        const d = last = await GET('/api/refunds?' + qs(Object.assign(Object.assign({}, F), { status: st === 'all' ? '' : st })));
        const c = d.counts;
        tabBox.replaceChildren(tabs([['pending', 'Waiting approval', c.pending || 0], ['approved', 'To pay', c.approved || 0], ['paid', 'Paid / credited', c.paid || 0], ['rejected', 'Rejected', c.rejected || 0], ['all', 'All']], st, v => { st = v; load(); }));
        headBox.replaceChildren(pageHead('Refunds & store credit', d.canApprove ? 'Approve refunds, send the money, and record the transfer reference.' : 'Refund requests go to finance for approval.', h('button', { class: 'btn ghost', onclick: () => csvDownload(`refunds-${todayStr()}.csv`, d.rows.map(r => ({ id: r.id, date: r.created_at, order: r.order_name, customer: r.cust_name, phone: r.phone, method: r.method, amount: r.amount, account: r.account_details, reason: r.reason, status: r.status, requested_by: r.created_by_name, approved_by: r.approved_by_name, paid_ref: r.paid_ref, posted: r.posted }))) }, 'CSV'), d.canCreate ? h('button', { class: 'btn primary', onclick: () => tkNewRefund({}, load) }, '+ New refund') : null));
        const acts = r => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, d.canApprove && r.status === 'pending' ? [h('button', { class: 'btn ok sm', onclick: () => act(() => POST(`/api/refunds/${r.id}/approve`), null).then(x => { toast(x.posted ? 'Approved and posted to accounts' : 'Approved (not posted to accounts yet)'); load(); }) }, 'Approve'),
            h('button', { class: 'btn ghost sm', onclick: () => formModal('Reject refund #' + r.id, [{ k: 'reason', label: 'Reason', type: 'textarea', required: true }], v => POST(`/api/refunds/${r.id}/reject`, v).then(load), 'Reject') }, 'Reject')] : null, d.canApprove && r.status === 'approved' ? h('button', { class: 'btn sm', onclick: () => formModal(`Mark refund #${r.id} paid`, [{ k: 'ref', label: 'Transfer reference / transaction ID', required: true, full: true }], v => POST(`/api/refunds/${r.id}/paid`, v).then(load), 'Mark paid') }, 'Mark paid') : null, d.canApprove && ['approved', 'paid'].includes(r.status) && !r.posted && d.accounts ? h('button', { class: 'btn ghost sm', title: r.post_error || '', onclick: () => act(() => POST(`/api/refunds/${r.id}/post`), 'Posted').then(load) }, 'Post') : null);
        box.replaceChildren(h('div', { class: 'kpis' }, kpi('Refunds', num(d.totals.n), rs(d.totals.amount)), kpi('Waiting approval', rs(d.totals.pending), null, d.totals.pending ? 'warn' : ''), kpi('Approved, not paid', rs(d.totals.approved), null, d.totals.approved ? 'warn' : ''), kpi('Paid / credited', rs(d.totals.paid), null, 'good')), h('div', { class: 'card' }, table([
            { t: '#', f: r => h('span', { class: 'mono' }, r.id) }, { t: 'Date', f: r => [dt(r.created_at), r.status === 'pending' && r.age_h >= 24 ? h('div', null, h('span', { class: 'b warn' }, Math.floor(r.age_h / 24) + 'd waiting')) : null] },
            { t: 'Customer', f: r => [r.cust_name || '—', h('div', { class: 'small muted' }, r.phone, r.order_name ? ' · ' + r.order_name : '')] },
            { t: 'Method', f: r => [r.method, r.account_details ? h('div', { class: 'small muted', style: { maxWidth: '180px' } }, r.account_details) : null] }, { t: 'Amount', n: 1, f: r => h('strong', null, rs(r.amount)) },
            { t: 'Reason', f: r => h('div', { class: 'small', style: { maxWidth: '200px' } }, r.reason || '', r.reject_reason ? h('div', { class: 'neg' }, 'Rejected: ' + r.reject_reason) : null) },
            { t: 'Status', f: r => [tkRefSt(r.status), r.paid_ref && r.paid_ref !== 'Store credit' ? h('div', { class: 'small muted mono' }, r.paid_ref) : null, ['approved', 'paid'].includes(r.status) ? h('div', null, h('span', { class: 'b ' + (r.posted ? 'ok' : ''), title: r.post_error || '' }, r.posted ? 'in books' : 'not in books')) : null] },
            { t: 'By', f: r => h('div', { class: 'small' }, r.created_by_name || '', r.approved_by_name ? h('div', { class: 'muted' }, '✓ ' + r.approved_by_name) : null) },
            { t: '', f: acts }
        ], d.rows, r => r.ticket_id && typeof tkOpen === 'function' && can('tickets') ? tkOpen(r.ticket_id) : null)));
    };
    [meth, fr, to].forEach(x => x.addEventListener('change', load));
    qi.addEventListener('keydown', e => { if (e.key === 'Enter')
        load(); });
    render(headBox, tabBox, h('div', { class: 'toolbar' }, qi, meth, h('span', { class: 'small muted' }, 'From'), fr, h('span', { class: 'small muted' }, 'to'), to), box);
    await load();
};
async function tkNewRefund(pre = {}, after) {
    const m = await tkMeta();
    const t = pre.ticket, o = pre.order;
    const fields = [
        { k: 'method', label: 'Method', type: 'select', options: m.methods, value: 'Bank transfer', required: true },
        { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true, value: o && o.items && t && t.sku ? (o.items.find(i => i.sku === t.sku) || {}).price : '' },
        ...(t ? [] : [{ k: 'order', label: 'Order no. (optional)', placeholder: 'SB84561' }, { k: 'phone', label: 'Customer phone', placeholder: '03xx xxxxxxx' }, { k: 'cust_name', label: 'Customer name' }]),
        { k: 'account_details', label: 'Customer account (bank + account no. + name, or wallet no.)', full: true, placeholder: 'Not needed for store credit' },
        { k: 'reason', label: 'Reason', type: 'textarea' }
    ];
    formModal('New refund / store credit' + (t ? ' · ' + tkNum(t.id) : ''), fields, async (v) => {
        const r = await POST('/api/refunds', Object.assign(Object.assign({}, v), { ticket_id: t ? t.id : null, order_id: t ? null : (v.order || null) }));
        toast('Refund #' + r.id + ' sent for approval');
        after && after();
    }, 'Send for approval');
}
registerView({ key: 'exchanges', title: 'Exchanges', group: 'Orders & CS', perm: 'tickets', icon: 'swap', order: 50 }, VIEWS.exchanges);
registerView({ key: 'refunds', title: 'Refunds', group: 'Orders & CS', icon: 'cash', order: 60,
    get perm() { return typeof ME !== 'undefined' && ME && !ME.perms.includes('tickets') && (ME.perms.includes('finance') || ME.role === 'admin') ? 'finance' : 'tickets'; } }, VIEWS.refunds);
/* ---------- CS tickets (list, ticket drawer, customer 360, reports, settings) ---------- */
document.head.append(h('style', { id: 'tk-style' }, `
.tk-list{display:grid}
.tk-row{display:grid;grid-template-columns:22px minmax(0,1fr) 170px 120px 120px;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.tk-row:last-child{border-bottom:0}
.tk-row:hover{background:var(--hover)} .tk-row.cur{background:var(--hover);box-shadow:inset 3px 0 0 var(--accent)}
.tk-row .tt{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk-row .sb{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk-row .mt{display:flex;gap:4px;flex-wrap:wrap}
.tk-row .who{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk-row .due{font-size:12px;text-align:right;white-space:nowrap}
.tk-hd{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;cursor:default}
.tk-hd:hover{background:none}
.tk-bulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--accent-soft);border-radius:var(--r-sm)}
.tk-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px}
.tk-tl{display:grid;gap:8px}
.tk-n{padding:9px 12px;border-radius:10px;background:var(--soft);font-size:13.5px;white-space:pre-wrap;word-break:break-word}
.tk-n.message{background:var(--info-bg)} .tk-n .hd{font-size:11.5px;color:var(--muted);margin-bottom:3px;white-space:normal}
.tk-n.system{background:none;padding:2px 12px;font-size:12px;color:var(--muted)}
.tk-res{display:grid;gap:6px;max-height:260px;overflow:auto}
.tk-res .tile{display:grid;gap:2px}
.tk-seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}
.tk-seg button{border:0;background:transparent;padding:6px 12px;cursor:pointer;color:var(--muted);font-weight:600;font-size:12.5px}
.tk-seg button.on{background:var(--ink);color:var(--panel)}
.tk-items{display:grid;gap:4px;font-size:13px}
.tk-items > div{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;background:var(--soft);border-radius:8px}
.tk-kbd{font-size:11.5px;color:var(--muted)} .tk-kbd b{font-family:var(--mono);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-weight:600}
.tk-tpl{display:grid;grid-template-columns:160px 1fr auto;gap:8px;align-items:start}
.tk-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;background:var(--panel)}
.tk-flow button{border:0;border-right:1px solid var(--line);background:transparent;padding:9px 6px;font-weight:600;font-size:12.5px;color:var(--muted);cursor:pointer;line-height:1.2;position:relative}
.tk-flow button:last-child{border-right:0}
.tk-flow button:hover:not(:disabled){background:var(--hover);color:var(--ink)}
.tk-flow button.past{color:var(--ink)} .tk-flow button.past::before{content:'✓ ';color:var(--ok)}
.tk-flow button.on{background:var(--ink);color:var(--panel)}
.tk-flow button:disabled{cursor:default}
.tk-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tk-hdr{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.tk-x{font-size:20px;line-height:1;padding:4px 10px}
.tk-depts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.tk-depts button{text-align:left;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:10px;padding:8px 10px;cursor:pointer;display:grid;gap:1px}
.tk-depts button b{font-size:13.5px} .tk-depts button span{font-size:11.5px;color:var(--muted);line-height:1.25}
.tk-depts button.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft)}
.tk-depts button i{font-style:normal;font-size:11px;font-weight:600;color:var(--bad)}
.tk-sug{display:flex;flex-wrap:wrap;gap:6px}
.tk-sug button{border:1px solid var(--line);background:var(--soft);color:var(--ink);border-radius:999px;padding:4px 10px;font-size:12.5px;cursor:pointer;text-align:left}
.tk-sug button.on{border-color:var(--accent);background:var(--accent-soft)}
.tk-fault{display:grid;gap:10px;border-top:1px solid var(--line);padding-top:12px}
.tk-fault h3{margin:0;font-size:14.5px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
@media (max-width:760px){
  .tk-flow{grid-template-columns:repeat(3,minmax(0,1fr))}
  .tk-flow button{border-bottom:1px solid var(--line)}
  .tk-depts{grid-template-columns:1fr 1fr}
  .tk-row{grid-template-columns:22px minmax(0,1fr);gap:4px 10px;padding:10px}
  .tk-row > .mt,.tk-row > .who,.tk-row > .due{grid-column:2;text-align:left}
  .tk-row > .who:empty{display:none}
  .tk-hd{display:none}
  .tk-tpl{grid-template-columns:1fr}
}`));
const tkPut = (el, ...kids) => el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
const TK = { meta: null, sel: new Set(), cur: -1, rows: [], reload: null };
async function tkMeta(force) { if (!TK.meta || force)
    TK.meta = await GET('/api/tickets/meta'); return TK.meta; }
const TK_ST_CLS = { open: 'info', waiting: 'warn', progress: 'accent', resolved: 'ok', closed: '' };
const TK_PR_CLS = { urgent: 'bad', high: 'warn', normal: '', low: '' };
const tkSt = s => h('span', { class: 'b ' + (TK_ST_CLS[s] || '') }, (TK.meta && TK.meta.statuses[s]) || s);
const tkPr = p => h('span', { class: 'b ' + (TK_PR_CLS[p] || '') }, p === 'urgent' ? '⚑ urgent' : p);
const tkUtc = s => s ? new Date(String(s).replace(' ', 'T') + 'Z') : null;
function tkDur(ms) { const m = Math.round(Math.abs(ms) / 60000); if (m < 60)
    return m + ' min'; const hh = Math.round(m / 6) / 10; if (hh < 48)
    return (hh % 1 ? hh.toFixed(1) : hh) + ' h'; return Math.round(hh / 24) + ' days'; }
function tkDue(t) {
    if (t.status === 'resolved' || t.status === 'closed')
        return h('span', { class: 'muted' }, 'Done ' + ago(t.resolved_at || t.closed_at || t.updated_at));
    if (t.status === 'waiting')
        return h('span', { class: 'muted' }, 'Waiting · ' + ago(t.updated_at));
    const ms = tkUtc(t.due_at) - Date.now();
    if (ms < 0)
        return h('span', { class: 'b bad' }, 'Overdue ' + tkDur(ms));
    return h('span', { class: ms < 2 * 3600e3 ? 'b warn' : 'muted' }, 'Due in ' + tkDur(ms));
}
const tkFill = (text, x) => String(text || '').replace(/\{name\}/g, (x.name || '').split(' ')[0] || 'Sir/Madam').replace(/\{order\}/g, x.order || '').replace(/\{tracking\}/g, x.tracking || '').replace(/\{agent\}/g, ME.name || '');
const tkNum = id => 'T-' + id;
const tkDept = k => ((TK.meta && TK.meta.faultDepts) || []).find(d => d.k === k) || { k, l: k || '', reasons: [] };
const tkDone = t => t.status === 'resolved' || t.status === 'closed';
// modal whose header button says "Cancel" (its "Close" label is confusing next to "Resolve & close")
function tkModal(title, body, actions) { const md = modal(title, body, actions); const x = md.querySelector('.in > .row button'); if (x) {
    x.textContent = 'Cancel';
    x.title = 'Cancel, nothing is saved';
} md.querySelector('.in').style.width = 'min(720px,100%)'; return md; }
const tkHours = v => v == null ? '–' : v < 1 ? Math.round(v * 60) + ' min' : v + ' h';
/* ---------- list ---------- */
VIEWS.tickets = async (args) => {
    const m = await tkMeta(true);
    let view = args[0] || store.get('tk_view', 'mine');
    if (['mine', 'unassigned', 'overdue', 'waiting', 'open', 'all', 'nofault'].includes(view))
        store.set('tk_view', view);
    let drill = null;
    if (view === 'fault') {
        drill = { fault_dept: args[1] || '', month: /^\d{4}-\d{2}$/.test(args[2] || '') ? args[2] : '' };
        view = 'done';
    }
    if (view === 'open' && args[1]) {
        const id = args[1];
        view = 'mine';
        setTimeout(() => tkOpen(+id), 50);
    }
    if (view === 'report')
        return tkReport();
    if (view === 'settings')
        return tkSettings();
    const f = store.get('tk_filters', {}) || {};
    const F = Object.assign({ q: '', type: f.type || '', channel: f.channel || '', priority: f.priority || '', assignee: f.assignee || '', page: 1 }, (drill || {}));
    const sel = (k, opts, ph) => { const s = h('select', { title: ph }, h('option', { value: '' }, ph), opts.map(([v, l]) => h('option', { value: v, selected: String(F[k]) === String(v) }, l))); s.addEventListener('change', () => { F[k] = s.value; F.page = 1; saveF(); load(); }); return s; };
    const saveF = () => store.set('tk_filters', { type: F.type, channel: F.channel, priority: F.priority, assignee: F.assignee });
    const qi = h('input', { placeholder: 'Search name, phone, order, tracking, SKU, T-12', class: 'grow', style: { minWidth: '200px' } });
    qi.addEventListener('keydown', e => { if (e.key === 'Enter') {
        F.q = qi.value;
        F.page = 1;
        load();
    } if (e.key === 'Escape')
        qi.blur(); });
    const agentOpts = [['none', 'Unassigned']].concat(m.agents.map(a => [a.id, a.name]));
    const filters = h('div', { class: 'toolbar' }, qi, sel('type', m.types.map(t => [t, t]), 'Any type'), sel('channel', m.channels.map(t => [t, t]), 'Any channel'), sel('priority', m.priorities.map(p => [p, p]), 'Any priority'), sel('assignee', agentOpts, 'Anyone'), h('button', { class: 'btn ghost sm', onclick: () => { store.set('tk_filters', {}); route(); } }, 'Clear'));
    const tabBox = h('div', { style: { minWidth: 0 } }), bulkBox = h('div', { style: { minWidth: 0 } }), listBox = h('div', { class: 'card pad0' }), pagerBox = h('div');
    const load = async () => {
        const d = await GET('/api/tickets?' + qs(Object.assign({ view }, F)));
        TK.rows = d.rows;
        TK.cur = Math.min(TK.cur, d.rows.length - 1);
        for (const id of [...TK.sel])
            if (!d.rows.some(r => r.id === id))
                TK.sel.delete(id);
        tabBox.replaceChildren(...[tabs([['mine', 'My open', d.counts.mine], ['unassigned', 'Unassigned', d.counts.unassigned], ['overdue', 'Overdue', d.counts.overdue], ['waiting', 'Waiting', d.counts.waiting],
                ['open', 'All open', d.counts.open], ['all', 'All', d.counts.total], d.counts.nofault || view === 'nofault' ? ['nofault', 'Whose mistake missing', d.counts.nofault] : null, ['report', 'Reports'], m.canSettings ? ['settings', 'Settings'] : null].filter(Boolean), drill ? '' : view, v => { location.hash = '#/tickets/' + v; }),
            drill ? h('div', { class: 'note', style: { marginTop: '8px' } }, 'Showing closed tickets where the mistake was: ', h('strong', null, (m.faultDepts.find(x => x.k === drill.fault_dept) || {}).l || drill.fault_dept), drill.month ? ' · ' + drill.month : '', ' ', h('a', { href: '#/tickets/all' }, 'Show all tickets')) : view === 'nofault' ? h('div', { class: 'note warn', style: { marginTop: '8px' } }, 'These customer problems were closed without saying whose mistake it was, so nobody\'s performance shows them. Open each one and press "Set whose mistake".') : null].filter(Boolean));
        drawRows();
        pagerBox.replaceChildren(pager(d, p => { F.page = p; load(); }));
    };
    const drawBulk = () => {
        if (!TK.sel.size)
            return bulkBox.replaceChildren();
        const as = h('select', null, h('option', { value: '' }, 'Assign to…'), h('option', { value: 'none' }, 'Nobody'), m.agents.map(a => h('option', { value: a.id }, a.name)));
        const ids = [...TK.sel];
        bulkBox.replaceChildren(h('div', { class: 'tk-bulk' }, h('strong', null, ids.length + ' selected'), as, h('button', { class: 'btn sm', onclick: () => { if (!as.value)
                return toast('Pick a person', true); act(() => POST('/api/tickets/bulk', { ids, assignee: as.value === 'none' ? null : +as.value }), 'Assigned').then(() => { TK.sel.clear(); load(); }); } }, 'Assign'), h('button', { class: 'btn sm ghost', onclick: () => act(() => POST('/api/tickets/bulk', { ids, status: 'waiting' }), 'Updated').then(() => { TK.sel.clear(); load(); }) }, 'Mark waiting'), h('button', { class: 'btn sm ok', onclick: () => tkBulkResolve(ids, () => { TK.sel.clear(); load(); }) }, icon('check', 14), 'Resolve & close…'), h('button', { class: 'btn sm ghost', onclick: () => tkCloseNoFix(ids, () => { TK.sel.clear(); load(); }) }, 'Close without fix…'), h('button', { class: 'btn sm ghost', onclick: () => { TK.sel.clear(); drawRows(); } }, 'Clear')));
    };
    const drawRows = () => {
        drawBulk();
        if (!TK.rows.length)
            return listBox.replaceChildren(h('div', { class: 'empty' }, view === 'mine' ? 'Nothing assigned to you. Check Unassigned.' : view === 'overdue' ? 'No overdue tickets. 👍' : 'No tickets here.'));
        const all = h('input', { type: 'checkbox', checked: TK.rows.every(r => TK.sel.has(r.id)), onchange: e => { TK.rows.forEach(r => e.target.checked ? TK.sel.add(r.id) : TK.sel.delete(r.id)); drawRows(); } });
        listBox.replaceChildren(h('div', { class: 'tk-list' }, h('div', { class: 'tk-row tk-hd' }, all, h('div', null, 'Ticket'), h('div', null, 'Priority · status'), h('div', null, 'Assigned'), h('div', { style: { textAlign: 'right' } }, 'SLA')), TK.rows.map((t, i) => h('div', { class: 'tk-row' + (i === TK.cur ? ' cur' : ''), 'data-i': i, onclick: e => { if (e.target.closest('input'))
                return; TK.cur = i; tkOpen(t.id); } }, h('input', { type: 'checkbox', checked: TK.sel.has(t.id), onchange: e => { e.target.checked ? TK.sel.add(t.id) : TK.sel.delete(t.id); drawBulk(); } }), h('div', { style: { minWidth: 0 } }, h('div', { class: 'tt' }, h('span', { class: 'muted mono', style: { fontWeight: 500 } }, tkNum(t.id) + ' '), t.subject || t.type), h('div', { class: 'sb' }, [t.cust_name || t.phone, t.order_name, t.type, t.channel].filter(Boolean).join(' · '), ' ', t.clabel && t.clabel !== 'New' ? labelB(t.clabel) : null, t.auto ? h('span', { class: 'b' }, 'auto') : null, t.fault_dept ? h('span', { class: 'b ' + (tkDept(t.fault_dept).internal ? 'bad' : ''), title: 'Whose mistake' }, tkDept(t.fault_dept).l + (t.fault_user_name ? ' · ' + t.fault_user_name : '')) : null)), h('div', { class: 'mt' }, tkPr(t.priority), tkSt(t.status)), h('div', { class: 'who' }, t.assignee_name || h('span', { class: 'muted' }, 'Unassigned')), h('div', { class: 'due' }, tkDue(t))))));
    };
    TK.reload = load;
    TK.drawRows = drawRows;
    render(pageHead('Customer tickets', 'Every customer problem in one place: wrong item, damage, exchanges, refunds, delivery issues.', h('button', { class: 'btn ghost', title: 'Create tickets for parcels PostEx could not deliver', onclick: () => act(() => POST('/api/tickets/auto/run'), null).then(r => { toast(`Delivery follow-ups: ${r.created} new, ${r.resolved} auto-resolved`); load(); }) }, icon('truck', 16), 'Delivery follow-ups'), h('button', { class: 'btn primary', onclick: () => tkNew() }, '+ New ticket')), tabBox, filters, bulkBox, listBox, pagerBox, h('div', { class: 'tk-kbd' }, 'Keys: ', h('b', null, 'N'), ' new · ', h('b', null, 'J'), '/', h('b', null, 'K'), ' move · ', h('b', null, 'Enter'), ' open · ', h('b', null, 'X'), ' select · ', h('b', null, '/'), ' search'));
    await load();
};
document.addEventListener('keydown', e => {
    if (CURRENT !== 'tickets' || e.target.closest('input,textarea,select') || document.querySelector('.modal,.drawer') || e.ctrlKey || e.metaKey || e.altKey)
        return;
    const k = e.key.toLowerCase();
    if (k === 'n') {
        e.preventDefault();
        tkNew();
        return;
    }
    if (!TK.rows.length)
        return;
    if (k === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        TK.cur = Math.min(TK.rows.length - 1, TK.cur + 1);
    }
    else if (k === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        TK.cur = Math.max(0, TK.cur - 1);
    }
    else if (e.key === 'Enter' && TK.cur >= 0) {
        tkOpen(TK.rows[TK.cur].id);
        return;
    }
    else if (k === 'x' && TK.cur >= 0) {
        const id = TK.rows[TK.cur].id;
        TK.sel.has(id) ? TK.sel.delete(id) : TK.sel.add(id);
    }
    else
        return;
    TK.drawRows && TK.drawRows();
    const r = document.querySelector(`.tk-row[data-i="${TK.cur}"]`);
    if (r)
        r.scrollIntoView({ block: 'nearest' });
});
/* order finder used by new ticket / exchange / refund */
function tkOrderFinder(onPick, initial) {
    const inp = h('input', { placeholder: 'Order no. (SB84561), phone or tracking', class: 'grow', value: initial || '' });
    const res = h('div', { class: 'tk-res' });
    const go = async () => {
        const v = inp.value.trim();
        if (!v)
            return;
        res.replaceChildren(h('div', { class: 'muted small' }, h('span', { class: 'spin' }), 'Searching…'));
        const d = await act(() => GET('/api/tickets/lookup?q=' + encodeURIComponent(v)));
        if (!d.orders.length)
            return res.replaceChildren(h('div', { class: 'note warn' }, 'No order found. You can still save the ticket with the customer phone.'));
        const pick = o => { res.replaceChildren(tkOrderCard(o, () => { res.replaceChildren(); onPick(null); })); onPick(o); };
        if (d.orders.length === 1)
            return pick(d.orders[0]);
        res.replaceChildren(...d.orders.map(o => h('div', { class: 'tile', onclick: () => pick(o) }, h('div', { class: 'row sp' }, h('strong', null, o.name), statusB(o.status)), h('div', { class: 'small muted' }, dt(o.created_at), ' · ', o.cust_name, ' · ', rs(o.total), ' · ', o.items.map(i => i.title).join(' + ')))));
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') {
        e.preventDefault();
        go();
    } });
    if (initial)
        setTimeout(go, 0);
    return { el: h('div', { class: 'grid', style: { gap: '8px' } }, h('div', { class: 'row' }, inp, h('button', { class: 'btn ghost', type: 'button', onclick: go }, 'Find')), res), input: inp };
}
function tkOrderCard(o, onClear) {
    return h('div', { class: 'tile', style: { cursor: 'default' } }, h('div', { class: 'row sp' }, h('div', { class: 'row' }, h('strong', null, o.name), statusB(o.status), labelB(o.clabel)), onClear ? h('button', { class: 'btn ghost sm', type: 'button', onclick: onClear }, 'Change') : null), h('div', { class: 'small' }, o.cust_name, ' · ', o.phone, ' · ', o.city, ' · ', rs(o.total)), h('div', { class: 'small muted' }, dt(o.created_at), ' · ', o.corders > 1 ? `${o.corders} orders · ${hist(o.cdel, o.cret)}` : (o.cdel || o.cret ? hist(o.cdel, o.cret) : 'first order'), o.tracking ? [' · PostEx ', h('span', { class: 'mono' }, o.tracking)] : '', o.px_status ? ' · ' + o.px_status : ''), h('div', { class: 'tk-items', style: { marginTop: '6px' } }, o.items.map(i => h('div', null, h('span', null, i.title, ' ', h('span', { class: 'mono muted' }, i.sku), i.size ? h('span', { class: 'muted' }, ' · ' + i.size) : ''), h('span', null, rs(i.price))))));
}
/* ---------- new ticket ---------- */
async function tkNew(pre = {}) {
    const m = await tkMeta();
    let order = null;
    const S = (opts, val) => h('select', null, opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(val !== null && val !== void 0 ? val : '') }, l); }));
    const type = S(m.types, pre.type || 'Order inquiry'), channel = S(m.channels, pre.channel || 'WhatsApp'), pr = S(m.priorities.map(p => [p, p[0].toUpperCase() + p.slice(1) + ` (${m.sla[p]} h)`]), pre.priority || 'normal');
    const as = S([['', 'Unassigned']].concat(m.agents.map(a => [a.id, a.name])), m.agents.some(a => a.id === ME.id) ? ME.id : '');
    const name = h('input', { placeholder: 'Customer name', value: pre.cust_name || '' }), phone = h('input', { placeholder: '03xx xxxxxxx', value: pre.phone || '', inputmode: 'tel' });
    const subject = h('input', { placeholder: 'Short summary (optional)' }), note = h('textarea', { placeholder: 'What did the customer say? Paste the WhatsApp message here.' });
    const sku = h('select', null, h('option', { value: '' }, '—')), skuWrap = h('label', { class: 'f', hidden: true }, 'Problem item', sku);
    const file = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true });
    const finder = tkOrderFinder(o => {
        order = o;
        if (o) {
            name.value = o.cust_name || '';
            phone.value = o.phone || '';
            sku.replaceChildren(h('option', { value: '' }, 'Whole order'), o.items.map(i => h('option', { value: i.sku }, i.sku + ' · ' + i.title)));
            if (o.items.length === 1)
                sku.value = o.items[0].sku;
            skuWrap.hidden = false;
        }
        else
            skuWrap.hidden = true;
    }, pre.order);
    const err = h('div', { class: 'flash bad', hidden: true });
    const save = async () => {
        try {
            const files = [];
            for (const f of file.files)
                files.push(await uploadFile(f));
            const r = await POST('/api/tickets', { type: type.value, channel: channel.value, priority: pr.value, assignee: as.value ? +as.value : null, order_id: order ? order.id : null, cust_name: name.value, phone: phone.value, subject: subject.value, note: note.value, sku: sku.value || null, files });
            md.remove();
            toast('Ticket ' + tkNum(r.id) + ' created');
            TK.reload && CURRENT === 'tickets' && TK.reload();
            tkOpen(r.id);
        }
        catch (e) {
            err.hidden = false;
            err.textContent = e.message;
        }
    };
    const md = modal('New ticket', h('div', { class: 'grid' }, err, h('label', { class: 'f' }, 'Find the order', finder.el), skuWrap, h('div', { class: 'fgrid' }, field('Type *', type), field('Channel', channel), field('Priority', pr), field('Assign to', as), field('Customer name', name), field('Phone', phone)), field('Subject', subject), field('Customer message / note', note), field('Photos / files', file)), [h('button', { class: 'btn primary', onclick: save }, 'Create ticket')]);
    md.querySelector('.in').style.width = 'min(720px,100%)';
    finder.input.focus();
}
/* ---------- ticket drawer ---------- */
async function tkOpen(id) {
    const m = await tkMeta();
    let d;
    try {
        d = await GET('/api/tickets/' + id);
    }
    catch (e) {
        return toast(e.message, true);
    }
    document.querySelectorAll('.drawer.tk-dr').forEach(x => x.remove());
    const t = d.ticket, o = d.order, done = t.status === 'resolved' || t.status === 'closed';
    const dr = drawer([]);
    dr.classList.add('tk-dr');
    const reload = () => { tkOpen(t.id); TK.reload && CURRENT === 'tickets' && TK.reload(); };
    const upd = body => act(() => POST('/api/tickets/' + t.id, body), 'Saved').then(reload);
    const sel = (opts, val, onch) => { const s = h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val !== null && val !== void 0 ? val : '') }, l))); s.addEventListener('change', () => onch(s.value)); return s; };
    // status flow: Open → In progress → Waiting for customer → Resolved → Closed (Resolved / Closed ask how it was fixed + whose mistake)
    const FLOW = ['open', 'progress', 'waiting', 'resolved', 'closed'], curI = FLOW.indexOf(t.status);
    const goStatus = k => {
        if (k === t.status)
            return;
        if (k === 'resolved')
            return tkResolve(t, reload, { close: false });
        if (k === 'closed')
            return t.status === 'resolved' ? act(() => POST(`/api/tickets/${t.id}/close`, {}), 'Closed').then(reload) : tkResolve(t, reload, { close: true });
        if (done)
            return toast('Press Reopen first', true);
        upd({ status: k });
    };
    const flow = h('div', { class: 'tk-flow', role: 'group', 'aria-label': 'Ticket status' }, FLOW.map((k, i) => h('button', { type: 'button', class: k === t.status ? 'on' : i < curI && (k === 'open' || k === 'resolved') ? 'past' : '',
        disabled: k === t.status || (done && k !== 'closed'), title: k === 'resolved' || k === 'closed' ? 'Asks how it was fixed and whose mistake it was' : 'Set status: ' + m.statuses[k], onclick: () => goStatus(k) }, m.statuses[k])));
    const fd = t.fault_dept ? tkDept(t.fault_dept) : null, needFault = m.faultTypes.includes(t.type);
    const prSel = sel(m.priorities.map(p => [p, p[0].toUpperCase() + p.slice(1)]), t.priority, v => upd({ priority: v }));
    const asSel = sel([['', 'Unassigned']].concat(m.agents.map(a => [a.id, a.name])), t.assignee || '', v => upd({ assignee: v ? +v : null }));
    const typeSel = sel(m.types.map(x => [x, x]), t.type, v => upd({ type: v }));
    const vars = { name: t.cust_name || (o && o.cust_name), order: t.order_name || '', tracking: t.tracking || (o && o.tracking) || '' };
    // WhatsApp
    const tpls = m.templates || [];
    const waText = h('textarea', { style: { minHeight: '90px' } }, tkFill(tpls[0] && tpls[0].text, vars));
    const tplSel = h('select', null, tpls.map((x, i) => h('option', { value: i }, x.name)));
    tplSel.addEventListener('change', () => { waText.value = tkFill(tpls[+tplSel.value].text, vars); });
    const waBtn = h('a', { class: 'btn ok', target: '_blank', href: '#', onclick: () => {
            waBtn.href = waLink(d.wa, waText.value);
            POST(`/api/tickets/${t.id}/note`, { kind: 'message', body: waText.value, channel: 'WhatsApp' }).then(reload).catch(e => toast(e.message, true));
        } }, 'Open WhatsApp');
    // composer
    let kind = 'message';
    const seg = h('div', { class: 'tk-seg' }), body = h('textarea', { placeholder: 'What did you tell the customer?' });
    const drawSeg = () => { seg.replaceChildren(...[['message', 'Message sent to customer'], ['note', 'Internal note']].map(([k, l]) => h('button', { type: 'button', class: kind === k ? 'on' : '', onclick: () => { kind = k; body.placeholder = k === 'note' ? 'Note for the team (customer does not see this)' : 'What did you tell the customer?'; drawSeg(); } }, l))); };
    drawSeg();
    const wait = h('input', { type: 'checkbox' }), files = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true });
    const addNote = async () => {
        const ids = [];
        for (const f of files.files)
            ids.push(await act(() => uploadFile(f)));
        await act(() => POST(`/api/tickets/${t.id}/note`, { kind, body: body.value, files: ids, wait: kind === 'message' && wait.checked }), 'Saved');
        reload();
    };
    const fl = d.flag || {};
    const notes = d.notes.slice().reverse();
    const nofix = t.resolution === 'Closed without fix';
    tkPut(dr.firstChild, h('div', { class: 'tk-hdr' }, h('div', { style: { minWidth: 0 } }, h('div', { class: 'small muted mono' }, tkNum(t.id), ' · ', t.channel, ' · opened ', dt(t.created_at), t.auto ? ' · auto' : '', t.reopened ? ` · reopened ${t.reopened}×` : ''), h('div', { class: 'big', style: { fontSize: '19px' } }, t.subject || t.type), h('div', { class: 'row', style: { marginTop: '4px' } }, tkSt(t.status), tkPr(t.priority), tkDue(t))), h('button', { class: 'btn ghost tk-x', title: 'Close this panel (the ticket stays as it is)', 'aria-label': 'Close panel', onclick: () => dr.remove() }, '×')), h('div', { class: 'card', style: { display: 'grid', gap: '12px' } }, h('div', { class: 'tk-acts' }, done
        ? [h('button', { class: 'btn big', onclick: () => tkReopen(t, reload) }, '↺ Reopen ticket'), t.status === 'resolved' ? h('button', { class: 'btn ghost', onclick: () => act(() => POST(`/api/tickets/${t.id}/close`, {}), 'Closed').then(reload) }, 'Close ticket') : null]
        : [h('button', { class: 'btn ok big', onclick: () => tkResolve(t, reload, { close: true }) }, icon('check', 16), 'Resolve & close'),
            h('button', { class: 'btn ghost', title: 'For spam, duplicate or tickets opened by mistake', onclick: () => tkCloseNoFix([t.id], reload) }, 'Close without fix'),
            t.assignee !== ME.id ? h('button', { class: 'btn ghost', onclick: () => upd({ assignee: ME.id }) }, 'Assign to me') : null]), h('div', { class: 'tk-acts small' }, h('span', { class: 'muted' }, 'Fix it with:'), h('button', { class: 'btn ghost sm', onclick: () => tkNewExchange({ ticket: t, order: o }, reload) }, icon('swap', 14), 'Exchange'), h('button', { class: 'btn ghost sm', onclick: () => tkNewRefund({ ticket: t, order: o }, reload) }, icon('cash', 14), 'Refund / store credit'), done ? null : h('span', { class: 'muted' }, 'the ticket resolves itself when the exchange is completed or the refund is paid')), h('div', null, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, 'Status'), flow), h('div', { class: 'fgrid' }, field('Priority', prSel), field('Assigned to', asSel), field('Type', typeSel))), t.resolution ? h('div', { class: 'note ' + (nofix ? '' : 'ok') }, h('strong', null, nofix ? 'Closed without fix' : 'Resolved: ' + t.resolution), t.resolution_note ? ' · ' + t.resolution_note : '', ' · ', dt(t.resolved_at)) : null, fd ? h('div', { class: 'note ' + (fd.internal ? 'bad' : '') }, h('div', { class: 'row sp' }, h('div', null, h('strong', null, 'Whose mistake: ', fd.l), t.fault_user_name ? ' · ' + t.fault_user_name : '', t.fault_reason ? ' — ' + t.fault_reason : '', t.fault_cost ? ' · cost ' + rs(t.fault_cost) : '', t.fault_note ? h('div', { class: 'small' }, t.fault_note) : null, fd.internal && done ? h('div', { class: 'small muted' }, 'Counted as a mistake in ' + (t.fault_user_name || 'their') + '\'s performance on ' + day(t.resolved_at)) : null), h('button', { class: 'btn ghost sm', onclick: () => tkSetFault(t, reload) }, 'Change'))) :
        done && needFault && !nofix ? h('div', { class: 'note warn' }, h('div', { class: 'row sp' }, h('span', null, h('strong', null, 'Whose mistake is not recorded. '), 'Say which department caused this problem so it shows in their performance.'), h('button', { class: 'btn sm', onclick: () => tkSetFault(t, reload) }, 'Set whose mistake'))) : null, h('div', { class: 'tk-two' }, h('div', { class: 'card' }, h('h2', null, 'Customer', h('span', { class: 'spacer' }), t.phone ? h('button', { class: 'btn ghost sm', onclick: () => tkCustomer(t.phone) }, 'Customer 360') : null), h('div', { style: { fontWeight: 650, fontSize: '15px' } }, t.cust_name || '—'), h('div', null, t.phone || ''), h('div', { class: 'row', style: { marginTop: '6px' } }, labelB(t.clabel), fl.blacklist ? h('span', { class: 'b bad' }, 'Blacklisted') : null, fl.vip ? h('span', { class: 'b ok' }, 'VIP') : null, o ? h('span', { class: 'small muted' }, o.corders > 1 ? `${o.corders} orders · ${hist(o.cdel, o.cret)}` : (o.cdel || o.cret ? hist(o.cdel, o.cret) : 'first order')) : null), fl.note ? h('div', { class: 'small muted' }, 'Note: ', fl.note) : null, d.prev.length ? h('div', { class: 'small', style: { marginTop: '8px' } }, h('span', { class: 'muted' }, 'Earlier tickets: '), d.prev.slice(0, 5).map(p => h('a', { href: '#', style: { marginRight: '8px' }, onclick: e => { e.preventDefault(); tkOpen(p.id); } }, tkNum(p.id) + ' ' + p.type.split(' ')[0]))) : null, t.phone ? h('div', { class: 'row', style: { marginTop: '10px' } }, h('a', { class: 'btn sm ghost', href: 'tel:' + t.phone }, icon('phone', 14), 'Call')) : null), h('div', { class: 'card' }, h('h2', null, 'Order', h('span', { class: 'spacer' }), o && can('orders') ? h('button', { class: 'btn ghost sm', onclick: () => openOrder(o.id) }, 'Open order') : null), o ? [h('div', { class: 'row' }, h('strong', null, o.name), statusB(o.status), h('span', { class: 'small muted' }, rs(o.total))),
        h('div', { class: 'small muted' }, dt(o.created_at), ' · ', o.city, o.tracking ? [' · ', trackLink(o.tracking, o.courier, 'mono')] : ''),
        o.px_status ? h('div', { class: 'small muted' }, 'PostEx: ', o.px_status, o.px_updated ? ' · ' + dt(o.px_updated) : '') : null,
        h('div', { class: 'tk-items', style: { marginTop: '8px' } }, o.items.map(i => h('div', null, h('span', null, i.title, ' ', h('span', { class: 'mono muted' }, i.sku), t.sku === i.sku ? h('span', { class: 'b warn', style: { marginLeft: '4px' } }, 'problem') : ''), h('span', null, rs(i.price))))),
        o.items.length > 1 && !done ? h('label', { class: 'f', style: { marginTop: '8px' } }, 'Problem item', sel([['', 'Whole order']].concat(o.items.map(i => [i.sku, i.sku + ' · ' + i.title])), t.sku || '', v => upd({ sku: v || null }))) : null]
        : tkLinkOrder(t, upd))), d.wa ? h('div', { class: 'card' }, h('h2', null, 'WhatsApp the customer', h('small', null, 'pick a template, edit, then open WhatsApp — it is saved in the timeline')), h('div', { class: 'grid', style: { gap: '8px' } }, h('div', { class: 'row' }, tplSel), waText, h('div', { class: 'row' }, waBtn))) : null, h('div', { class: 'card' }, h('h2', null, 'Reply / note'), h('div', { class: 'grid', style: { gap: '8px' } }, seg, body, h('div', { class: 'row sp' }, h('div', { class: 'row' }, files, kind === 'message' ? h('label', { class: 'row small' }, wait, 'Now waiting for customer') : null), h('button', { class: 'btn', onclick: addNote }, 'Save'))), h('div', { class: 'tk-tl', style: { marginTop: '14px' } }, notes.map(n => n.kind === 'system'
        ? h('div', { class: 'tk-n system' }, dt(n.at), ' · ', n.user || 'System', ': ', n.body)
        : h('div', { class: 'tk-n ' + n.kind }, h('div', { class: 'hd' }, h('strong', null, n.user || 'System'), ' · ', dt(n.at), ' · ', n.kind === 'message' ? h('span', { class: 'b info' }, 'sent to customer') : h('span', { class: 'b' }, 'internal')), n.body, n.files && n.files.length ? h('div', { class: 'row', style: { marginTop: '4px' } }, n.files.map(fileLink)) : null)))), d.exchanges.length || d.refunds.length ? h('div', { class: 'card' }, h('h2', null, 'Exchanges & refunds'), h('div', { class: 'grid', style: { gap: '6px' } }, d.exchanges.map(x => h('div', { class: 'tile', onclick: () => tkOpenExchange(x.id, reload) }, h('div', { class: 'row sp' }, h('strong', null, 'Exchange #' + x.id), h('span', { class: 'b ' + (x.step === 'completed' ? 'ok' : x.step === 'cancelled' ? 'bad' : 'info') }, m.steps[x.step])), x.diff ? h('div', { class: 'small muted' }, 'Difference ', rs(x.diff)) : null)), d.refunds.map(r => h('div', { class: 'tile', onclick: () => { dr.remove(); location.hash = '#/refunds/all'; } }, h('div', { class: 'row sp' }, h('strong', null, 'Refund #' + r.id + ' · ' + r.method), h('span', null, rs(r.amount), ' ', tkRefSt(r.status))))))) : null);
}
function tkLinkOrder(t, upd) {
    let picked = null;
    const f = tkOrderFinder(o => { picked = o; btn.disabled = !o; });
    const btn = h('button', { class: 'btn sm', disabled: true, onclick: () => picked && upd({ order_id: picked.id }) }, 'Link this order');
    return h('div', { class: 'grid', style: { gap: '8px' } }, h('div', { class: 'muted small' }, 'No order linked yet.'), f.el, h('div', null, btn));
}
/* "whose mistake" picker: department → person (pre-suggested from the order's data) → reason → cost */
function tkFaultPicker(m, opts = {}) {
    var _a;
    const sug = opts.sug || null, req = !!opts.required;
    let dept = opts.dept || (sug && sug.best && sug.best.dept) || '';
    let pick = opts.user_id || (sug && sug.best && sug.best.user_id) || (opts.bulk ? 'auto' : '');
    const reason = h('select'), person = h('select'), note = h('input', { placeholder: 'What exactly went wrong? (optional)' }), cost = h('input', { type: 'number', min: 0, placeholder: 'Rs (optional)', value: (_a = opts.cost) !== null && _a !== void 0 ? _a : '' });
    const grid = h('div', { class: 'tk-depts' }), detail = h('div', { class: 'grid', style: { gap: '10px' } });
    const drawGrid = () => grid.replaceChildren(...m.faultDepts.map(d => h('button', { type: 'button', class: d.k === dept ? 'on' : '', 'aria-pressed': String(d.k === dept), onclick: () => {
            dept = dept === d.k && !req ? '' : d.k;
            const c = sug && sug.people[dept];
            pick = dept && dept === opts.dept && opts.user_id ? opts.user_id : c && c[0] ? c[0].user_id : (opts.bulk ? 'auto' : '');
            draw();
        } }, h('b', null, d.l), h('span', null, d.hint), d.internal ? h('i', null, '● staff mistake') : null)));
    const draw = () => {
        drawGrid();
        if (!dept)
            return detail.replaceChildren(h('div', { class: 'small muted' }, req ? 'Pick the department above.' : 'Optional for this ticket type. Pick one if a department caused it.'));
        const d = m.faultDepts.find(x => x.k === dept);
        reason.replaceChildren(...[h('option', { value: '' }, 'Pick a reason…')].concat(d.reasons.concat(['Other']).map(r => h('option', { value: r, selected: r === opts.reason }, r))));
        if (d.reasons.length === 1 && !opts.reason)
            reason.value = d.reasons[0];
        const cands = (sug && sug.people[dept]) || [];
        person.replaceChildren(...[h('option', { value: '' }, 'Pick the person…')].concat(opts.bulk ? [h('option', { value: 'auto' }, 'Suggested person for each ticket')] : [], (m.staff || []).map(u => h('option', { value: u.id }, u.name + (cands.some(c => c.user_id === u.id) ? ' (suggested)' : '')))));
        person.value = String(pick || '');
        const sugBox = h('div', { class: 'tk-sug' });
        const drawSug = () => sugBox.replaceChildren(...(cands.length ? cands.map(c => h('button', { type: 'button', class: String(c.user_id) === String(pick) ? 'on' : '', onclick: () => { pick = c.user_id; person.value = String(c.user_id); drawSug(); } }, h('strong', null, c.name), ' · ', c.why))
            : [h('span', { class: 'small muted' }, opts.bulk ? 'Each ticket gets the person found in its own order records. Or pick one person for all.' : 'No record found in this order\'s data for this department. Pick the person yourself.')]));
        person.onchange = () => { pick = person.value; drawSug(); };
        drawSug();
        detail.replaceChildren(d.internal ? h('label', { class: 'f' }, 'Who made the mistake *', h('div', { class: 'grid', style: { gap: '6px' } }, cands.length ? h('div', { class: 'small muted' }, 'Found in the records (tap to pick):') : null, sugBox, person))
            : h('div', { class: 'small muted' }, 'Outside the team: not counted against anyone\'s performance.'), h('div', { class: 'fgrid' }, field('Reason', reason), field('Cost to us (Rs)', cost)), field('Note', note));
    };
    draw();
    const el = h('div', { class: 'tk-fault' }, h('h3', null, 'Whose mistake?', h('span', { class: 'small ' + (req ? 'neg' : 'muted'), style: { fontWeight: 500 } }, req ? 'required for customer problems' : 'optional')), grid, detail);
    return { el, get: () => dept ? { fault_dept: dept, fault_user_id: m.faultDepts.find(x => x.k === dept).internal ? (person.value === 'auto' ? 'auto' : +person.value || null) : null, fault_reason: reason.value, fault_note: note.value, fault_cost: cost.value === '' ? null : +cost.value } : {} };
}
async function tkResolve(t, after, opts = {}) {
    const m = await tkMeta();
    let sug = null;
    try {
        sug = await GET(`/api/tickets/${t.id}/fault`);
    }
    catch (e) { }
    const guess = { 'Size exchange': 'Exchanged', 'Wrong item': 'Exchanged', Refund: 'Refunded', 'Delivery issue': 'Re-delivery arranged', 'Order inquiry': 'Information given', 'Return request': 'Refunded' }[t.type] || '';
    const res = h('select', null, [h('option', { value: '' }, 'Pick one…')].concat(m.resolutions.map(r => h('option', { value: r, selected: r === guess }, r))));
    const note = h('textarea', { placeholder: 'e.g. New size sent, PostEx 2700…', style: { minHeight: '60px' } });
    const fp = tkFaultPicker(m, { sug, required: m.faultTypes.includes(t.type) && !t.fault_dept, dept: t.fault_dept, user_id: t.fault_user_id, reason: t.fault_reason, cost: t.fault_cost });
    const err = h('div', { class: 'flash bad', hidden: true });
    const save = close => POST(`/api/tickets/${t.id}/resolve`, Object.assign({ resolution: res.value, note: note.value, close }, fp.get()))
        .then(() => { md.remove(); toast(close ? 'Resolved & closed' : 'Resolved'); after(); }).catch(e => { err.hidden = false; err.textContent = e.message; err.scrollIntoView({ block: 'nearest' }); });
    const md = tkModal((opts.close === false ? 'Resolve ' : 'Resolve & close ') + tkNum(t.id), h('div', { class: 'grid' }, err, h('div', { class: 'small muted' }, t.type, t.order_name ? ' · ' + t.order_name : '', t.cust_name ? ' · ' + t.cust_name : ''), field('How was it fixed? *', res), field('Note', note), fp.el), [h('button', { class: 'btn ghost', onclick: () => save(false) }, 'Resolve only'), h('button', { class: 'btn ok', onclick: () => save(true) }, icon('check', 16), 'Resolve & close')]);
    md.querySelector('.in').style.width = 'min(720px,100%)';
}
async function tkSetFault(t, after) {
    const m = await tkMeta();
    let sug = null;
    try {
        sug = await GET(`/api/tickets/${t.id}/fault`);
    }
    catch (e) { }
    const fp = tkFaultPicker(m, { sug, required: true, dept: t.fault_dept, user_id: t.fault_user_id, reason: t.fault_reason, cost: t.fault_cost });
    const err = h('div', { class: 'flash bad', hidden: true });
    const md = tkModal('Whose mistake · ' + tkNum(t.id), h('div', { class: 'grid' }, err, h('div', { class: 'small muted' }, t.type, t.order_name ? ' · ' + t.order_name : ''), fp.el), [h('button', { class: 'btn primary', onclick: () => POST(`/api/tickets/${t.id}/fault`, fp.get()).then(() => { md.remove(); toast('Saved'); after(); }).catch(e => { err.hidden = false; err.textContent = e.message; }) }, 'Save')]);
    md.querySelector('.in').style.width = 'min(720px,100%)';
}
async function tkCloseNoFix(ids, after) {
    const m = await tkMeta();
    formModal(ids.length > 1 ? `Close ${ids.length} tickets without fix` : 'Close ' + tkNum(ids[0]) + ' without fix', [
        { k: 'reason', label: 'Why is there nothing to fix?', type: 'select', options: [['', 'Pick one…']].concat(m.nofixReasons), required: true, full: true },
        { k: 'note', label: 'Note (optional)', full: true }
    ], async (v) => {
        if (ids.length === 1)
            await POST(`/api/tickets/${ids[0]}/close`, v);
        else
            await POST('/api/tickets/bulk', { ids, nofix: v });
        toast(ids.length > 1 ? 'Closed' : 'Ticket closed');
        after();
    }, 'Close without fix');
}
async function tkBulkResolve(ids, after) {
    const m = await tkMeta();
    const res = h('select', null, [h('option', { value: '' }, 'Pick one…')].concat(m.resolutions.map(r => h('option', { value: r }, r))));
    const note = h('input', { placeholder: 'Note for all (optional)' });
    const fp = tkFaultPicker(m, { bulk: true });
    const err = h('div', { class: 'flash bad', hidden: true });
    const md = tkModal(`Resolve & close ${ids.length} tickets`, h('div', { class: 'grid' }, err, h('div', { class: 'small muted' }, 'Same answer for every selected ticket. Customer problems need "whose mistake"; any ticket that cannot be closed is listed after saving.'), field('How was it fixed? *', res), field('Note', note), fp.el), [h('button', { class: 'btn ok', onclick: async () => {
                try {
                    const r = await POST('/api/tickets/bulk', { ids, resolve: Object.assign({ resolution: res.value, note: note.value, close: true }, fp.get()) });
                    md.remove();
                    toast(`${r.n} closed` + (r.skipped.length ? ` · ${r.skipped.length} not closed` : ''), !!r.skipped.length);
                    if (r.errors && r.errors.length)
                        modal('Not closed', h('div', { class: 'grid' }, r.errors.map(x => h('div', { class: 'note warn' }, x))));
                    after();
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, icon('check', 16), 'Resolve & close all')]);
    md.querySelector('.in').style.width = 'min(720px,100%)';
}
function tkReopen(t, after) {
    formModal('Reopen ' + tkNum(t.id), [{ k: 'note', label: 'Why reopen?', type: 'textarea' }], v => POST(`/api/tickets/${t.id}/reopen`, v).then(() => { toast('Reopened'); after(); }), 'Reopen');
}
/* ---------- customer 360 ---------- */
async function tkCustomer(phone) {
    let d;
    try {
        d = await GET('/api/tickets/customer/' + encodeURIComponent(phone));
    }
    catch (e) {
        return toast(e.message, true);
    }
    const c = d.customer || {}, fl = d.flag || {}, m = await tkMeta();
    const dr = drawer([]);
    const sec = (title, rows, cols, onRow) => h('div', { class: 'card' }, h('h2', null, title, h('small', null, rows.length)), rows.length ? table(cols, rows, onRow) : h('div', { class: 'muted small' }, 'None.'));
    tkPut(dr.firstChild, h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'big', style: { fontSize: '19px' } }, c.name || phone), h('div', { class: 'row', style: { marginTop: '4px' } }, h('span', null, phone), c.city ? h('span', { class: 'muted' }, c.city) : null, labelB(c.label), fl.blacklist ? h('span', { class: 'b bad' }, 'Blacklisted') : null, fl.vip ? h('span', { class: 'b ok' }, 'VIP') : null)), h('button', { class: 'btn ghost sm', onclick: () => dr.remove() }, 'Close')), fl.note ? h('div', { class: 'note warn' }, fl.note) : null, h('div', { class: 'kpis' }, kpi('Orders', num(c.orders || 0)), kpi('Delivered', num(c.delivered || 0), pct(c.delivered, (c.delivered || 0) + (c.returned || 0)) + ' success', 'good'), kpi('Returned', num(c.returned || 0), null, c.returned ? 'warn' : ''), kpi('Spent', rs(c.spent || 0)), kpi('Store credit', rs(d.storeCredit), 'approved credit', d.storeCredit ? 'good' : '')), h('div', { class: 'row' }, h('a', { class: 'btn sm ghost', href: 'tel:' + phone }, 'Call'), h('a', { class: 'btn sm ok', target: '_blank', href: waLink(d.wa) }, 'WhatsApp'), h('button', { class: 'btn sm', onclick: () => { dr.remove(); tkNew({ phone, cust_name: c.name }); } }, '+ New ticket'), can('customers') ? h('button', { class: 'btn sm ghost', onclick: () => customerModal(phone) }, 'Blacklist / VIP') : null), sec('Tickets', d.tickets, [{ t: '#', f: r => h('span', { class: 'mono' }, tkNum(r.id)) }, { t: 'Type', f: r => [r.type, h('div', { class: 'small muted' }, r.order_name || '')] }, { t: 'Status', f: r => [tkSt(r.status), r.resolution ? h('div', { class: 'small muted' }, r.resolution) : null] }, { t: 'Opened', f: r => dt(r.created_at) }], r => { dr.remove(); tkOpen(r.id); }), sec('Orders', d.orders, [{ t: 'Order', f: r => h('strong', null, r.name) }, { t: 'Date', f: r => day(r.created_at) }, { t: 'Items', f: r => h('div', { class: 'small', style: { maxWidth: '240px' } }, r.items_text || '') }, { t: 'Total', n: 1, f: r => rs(r.total) }, { t: 'Status', f: r => statusB(r.status) }], can('orders') ? r => openOrder(r.id) : null), sec('Returns received', d.returns, [{ t: 'Order', k: 'order_name' }, { t: 'SKU', f: r => h('span', { class: 'mono' }, r.sku) }, { t: 'Condition', k: 'cond' }, { t: 'Date', f: r => dt(r.at) }]), sec('Exchanges', d.exchanges, [{ t: '#', k: 'id' }, { t: 'Order', k: 'order_name' }, { t: 'Step', f: r => m.steps[r.step] }, { t: 'Difference', n: 1, f: r => rs(r.diff) }, { t: 'Date', f: r => dt(r.created_at) }], r => tkOpenExchange(r.id)), sec('Refunds & store credit', d.refunds, [{ t: '#', k: 'id' }, { t: 'Method', k: 'method' }, { t: 'Amount', n: 1, f: r => rs(r.amount) }, { t: 'Status', f: r => tkRefSt(r.status) }, { t: 'Date', f: r => dt(r.created_at) }]));
}
/* ---------- reports ---------- */
async function tkReport() {
    const days = +(store.get('tk_rep_days', 30)) || 30;
    const d = await GET('/api/tickets/report?days=' + days);
    const T = d.times || {}, ex = d.exchanges, rf = d.refunds;
    const daySel = h('select', null, [7, 30, 90, 180].map(n => h('option', { value: n, selected: n === days }, 'Last ' + n + ' days')));
    daySel.addEventListener('change', () => { store.set('tk_rep_days', +daySel.value); tkReport(); });
    const m = TK.meta || await tkMeta();
    render(pageHead('Customer tickets', 'How fast problems get solved, and where they come from.', daySel), tabs([['mine', 'My open'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue'], ['waiting', 'Waiting'], ['open', 'All open'], ['all', 'All'], ['report', 'Reports'], m.canSettings ? ['settings', 'Settings'] : null].filter(Boolean), 'report', v => { location.hash = '#/tickets/' + v; }), h('div', { class: 'kpis' }, kpi('Tickets', num(T.total || 0), `${num(T.open || 0)} still open`), kpi('First reply (avg)', tkHours(T.frt), 'from ticket opened'), kpi('Resolution (avg)', tkHours(T.res), 'open → resolved'), kpi('SLA breaches', num(T.breaches || 0), pct(T.breaches, T.total) + ' of tickets', T.breaches ? 'alert' : 'good'), kpi('Exchanges this month', num(ex.n || 0), `${ex.done || 0} completed · ${ex.open || 0} open`), kpi('Refunds this month', rs(rf.approved), `${rs(rf.credit)} as store credit · ${rs(rf.pending)} pending`, rf.pending ? 'warn' : '')), h('div', { class: 'card' }, h('h2', null, 'Opened vs resolved per day'), chart(d.perDay, 'day', [{ k: 'opened', l: 'Opened', c: C2 }, { k: 'resolved', l: 'Resolved', c: C3 }])), h('div', { class: 'tk-two' }, h('div', { class: 'card' }, h('h2', null, 'By type'), table([{ t: 'Type', k: 'k' }, { t: 'Tickets', n: 1, k: 'n' }, { t: 'Resolved', n: 1, f: r => pct(r.done, r.n) }, { t: '', f: r => bar(100 * r.n / Math.max(1, d.byType[0].n)) }], d.byType)), h('div', { class: 'card' }, h('h2', null, 'By channel'), table([{ t: 'Channel', k: 'k' }, { t: 'Tickets', n: 1, k: 'n' }, { t: '', f: r => bar(100 * r.n / Math.max(1, d.byChannel[0].n)) }], d.byChannel))), d.noFault ? h('div', { class: 'note warn' }, `${d.noFault} customer problem${d.noFault > 1 ? 's were' : ' was'} closed without saying whose mistake. `, h('a', { href: '#/tickets/nofault' }, 'Fix them')) : null, h('div', { class: 'tk-two' }, h('div', { class: 'card' }, h('h2', null, 'Whose mistake · by department', h('small', null, 'closed in this period')), table([
        { t: 'Department', f: r => [h('a', { href: '#/tickets/fault/' + r.k }, r.label), r.internal ? null : h('span', { class: 'small muted' }, ' · outside')] }, { t: 'Problems', n: 1, k: 'n' },
        { t: 'Top reasons', f: r => h('div', { class: 'small muted' }, r.reasons.map(x => `${x.n} × ${x.k}`).join(', ')) }, { t: 'Cost', n: 1, f: r => r.cost ? rs(r.cost) : '–' },
        { t: '', f: r => bar(100 * r.n / Math.max(1, d.byFault[0].n)) }
    ], d.byFault)), h('div', { class: 'card' }, h('h2', null, 'Whose mistake · by person', h('small', null, 'staff mistakes closed in this period')), table([
        { t: 'Person', f: r => h('strong', null, r.k || '#' + r.id) }, { t: 'Department', k: 'deptLabel' }, { t: 'Mistakes', n: 1, k: 'n' }, { t: 'Cost', n: 1, f: r => r.cost ? rs(r.cost) : '–' },
        { t: 'Tickets', f: r => h('div', { class: 'small' }, r.ids.map(id => h('a', { href: '#', style: { marginRight: '6px' }, onclick: e => { e.preventDefault(); tkOpen(id); } }, tkNum(id)))) }
    ], d.byFaultPerson))), h('div', { class: 'card' }, h('h2', null, 'By person'), table([{ t: 'Agent', k: 'k' }, { t: 'Tickets', n: 1, k: 'n' }, { t: 'Resolved', n: 1, f: r => num(r.done || 0) }, { t: 'Open', n: 1, f: r => num(r.open || 0) },
        { t: 'Overdue', n: 1, f: r => r.overdue ? h('span', { class: 'b bad' }, r.overdue) : '0' }, { t: 'Avg resolution', n: 1, f: r => tkHours(r.avg_res) }], d.byAgent)), h('div', { class: 'tk-two' }, h('div', { class: 'card' }, h('h2', null, 'Problem items', h('small', null, 'wrong / damaged')), table([{ t: 'SKU', f: r => [h('span', { class: 'mono' }, r.sku), h('div', { class: 'small muted' }, r.title)] }, { t: 'Wrong', n: 1, k: 'wrong' }, { t: 'Damaged', n: 1, k: 'damaged' }], d.topSkus)), h('div', { class: 'card' }, h('h2', null, 'Problem brands'), table([{ t: 'Brand', k: 'k' }, { t: 'Tickets', n: 1, k: 'n' }, { t: '', f: r => bar(100 * r.n / Math.max(1, d.topBrands[0].n)) }], d.topBrands))));
}
/* ---------- settings ---------- */
async function tkSettings() {
    const s = await GET('/api/tickets/settings'), m = TK.meta || await tkMeta();
    const sla = Object.fromEntries(m.priorities.map(p => [p, h('input', { type: 'number', min: 1, value: s.sla[p] })]));
    const auto = h('input', { type: 'checkbox', checked: s.auto });
    const list = h('div', { class: 'grid' });
    let tpls = s.templates.slice();
    const drawT = () => list.replaceChildren(...tpls.map((t, i) => {
        const n = h('input', { value: t.name, oninput: e => { tpls[i].name = e.target.value; } }), x = h('textarea', { oninput: e => { tpls[i].text = e.target.value; } }, t.text);
        return h('div', { class: 'tk-tpl' }, n, x, h('button', { class: 'btn ghost sm', onclick: () => { tpls.splice(i, 1); drawT(); } }, 'Remove'));
    }));
    drawT();
    render(pageHead('Customer tickets', 'Ticket settings'), tabs([['mine', 'My open'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue'], ['waiting', 'Waiting'], ['open', 'All open'], ['all', 'All'], ['report', 'Reports'], ['settings', 'Settings']], 'settings', v => { location.hash = '#/tickets/' + v; }), h('div', { class: 'card' }, h('h2', null, 'Reply time (SLA) in hours'), h('div', { class: 'fgrid' }, m.priorities.map(p => field(p[0].toUpperCase() + p.slice(1), sla[p]))), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'A ticket is overdue when it is still Open or In progress after this many hours. "Waiting for customer" does not count.')), h('div', { class: 'card' }, h('h2', null, 'Delivery follow-ups'), h('label', { class: 'row' }, auto, 'Auto-create a "Delivery issue" ticket for every parcel PostEx marks as attempted (checked every 30 minutes)'), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Tickets go turn by turn to staff who have both Tickets and Tracking access, and close by themselves when the parcel is delivered or returned.')), h('div', { class: 'card' }, h('h2', null, 'WhatsApp templates', h('small', null, 'use {name} {order} {tracking} {agent}')), list, h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn ghost sm', onclick: () => { tpls.push({ name: 'New template', text: 'Assalam o Alaikum {name}! ' }); drawT(); } }, '+ Add template'))), h('div', null, h('button', { class: 'btn primary', onclick: () => act(() => POST('/api/tickets/settings', { sla: Object.fromEntries(m.priorities.map(p => [p, +sla[p].value])), auto: auto.checked, templates: tpls }), 'Settings saved').then(() => tkMeta(true)) }, 'Save settings')));
}
registerView({ key: 'tickets', title: 'Tickets', group: 'Orders & CS', perm: 'tickets', icon: 'ticket', order: 40 }, VIEWS.tickets);
/* ---------- couriers: shared helpers (styles, printing, small widgets) ---------- */
const CR = {
    css: `
.cr-cour{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.cr-cour .card{margin:0}.cr-cour .big{font-size:28px;font-weight:800;line-height:1.1}
.cr-rows{display:grid;gap:2px;margin-top:8px}.cr-rows div{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed var(--line)}.cr-rows div:last-child{border:0}
.cr-sel{width:auto;min-width:130px;max-width:190px;padding:4px 6px}
.cr-bar{position:sticky;bottom:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;box-shadow:var(--shadow-lg);margin-top:10px}
.cr-app{max-width:560px;margin:0 auto;display:grid;gap:12px}
.cr-hello{display:flex;justify-content:space-between;align-items:flex-end;gap:8px}.cr-hello h2{margin:0;font-size:22px}
.cr-chips{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.cr-chip{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px;text-align:center}.cr-chip b{display:block;font-size:22px;line-height:1.2;white-space:nowrap}.cr-chip span{font-size:12px;color:var(--muted)}
.cr-p{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px;display:grid;gap:10px;box-shadow:var(--shadow)}
.cr-p.done{opacity:.72}.cr-p.ok{border-left:6px solid var(--ok)}.cr-p.bad{border-left:6px solid var(--bad)}.cr-p.warn{border-left:6px solid var(--warn)}
.cr-p .cr-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.cr-p .cr-nm{font-size:18px;font-weight:700;line-height:1.25}.cr-p .addr{font-size:15px;line-height:1.4}
.cr-p .cod{font-size:20px;font-weight:800;white-space:nowrap;text-align:right}.cr-p .cod small{display:block;font-size:11px;font-weight:500;color:var(--muted)}
.cr-3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.cr-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:54px;border-radius:12px;border:1px solid var(--line);background:var(--soft);color:var(--ink);font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;padding:6px}
.cr-btn small{font-weight:500;font-size:11px;opacity:.8}.cr-btn .ic{margin-bottom:1px}
.cr-btn.ok{background:var(--ok);border-color:var(--ok);color:var(--panel)}.cr-btn.bad{background:var(--bad);border-color:var(--bad);color:var(--panel)}.cr-btn.warn{background:var(--warn-bg);border-color:var(--warn);color:var(--warn)}
.cr-btn.main{background:var(--brand2);border-color:var(--brand2);color:#fff;min-height:60px;font-size:17px}
.cr-reasons{display:grid;gap:8px}.cr-reasons label{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:12px;font-size:15px;cursor:pointer}
.cr-reasons input{width:22px;height:22px}
.cr-bigin{font-size:24px!important;font-weight:700;padding:10px!important;text-align:center}
#crPrint{display:none}
@media print{body.crprint > *:not(#crPrint){display:none!important}body.crprint{background:#fff;margin:0}body.crprint #crPrint{display:block;color:#000}}
.cr-awb{width:100mm;height:148mm;border:1.5px solid #000;padding:3mm;font:11px/1.3 Arial,sans-serif;color:#000;display:flex;flex-direction:column;gap:2mm;page-break-after:always;break-after:page;overflow:hidden;background:#fff}
.cr-awb:last-child{page-break-after:auto;break-after:auto}
.cr-awb .hd{display:flex;justify-content:space-between;align-items:center;border-bottom:1.5px solid #000;padding-bottom:2mm}.cr-awb .hd b{font-size:18px}
.cr-awb .cn{text-align:center}.cr-awb .cn svg{width:88mm;height:18mm}.cr-awb .cn div{font:700 16px monospace;letter-spacing:1px}
.cr-awb .box{border:1px solid #000;padding:2mm}.cr-awb .cr-l{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#333}
.cr-awb .to{font-size:13px}.cr-awb .to b{font-size:15px}.cr-awb .cod{font-size:22px;font-weight:800;text-align:center;border:2px solid #000;padding:1.5mm}
.cr-awb .two{display:grid;grid-template-columns:1fr 1fr;gap:2mm}
.cr-sheet{font:12px/1.35 Arial,sans-serif;color:#000;background:#fff;padding:8mm}.cr-sheet h1{font-size:18px;margin:0 0 2mm}.cr-sheet table{width:100%;border-collapse:collapse;margin-top:4mm}
.cr-sheet th,.cr-sheet td{border:1px solid #000;padding:2mm;text-align:left;vertical-align:top}.cr-sheet td.n,.cr-sheet th.n{text-align:right}.cr-sheet .sig{width:28mm}
@media (max-width:800px){.cr-cour{grid-template-columns:1fr}}
@media (max-width:420px){.cr-p .cr-nm{font-size:17px}.cr-btn{font-size:14px}}`,
    styled: false,
    style() { if (!CR.styled) {
        document.head.append(h('style', null, CR.css));
        CR.styled = true;
    } },
    COURIERS: ['PostEx', 'TCS', 'Leopards', 'M&P', 'Trax', 'Blue Ex', 'Call Courier', 'Other'],
    cls: { delivered: 'ok', failed: 'bad', rescheduled: 'warn' },
    label: { delivered: 'Delivered', failed: 'Failed', rescheduled: 'Rescheduled' },
    // print any nodes on their own page(s), then put the page back
    print(nodes, pageCss) {
        CR.style();
        let area = document.getElementById('crPrint');
        if (!area) {
            area = h('div', { id: 'crPrint' });
            document.body.append(area);
        }
        let pg = document.getElementById('crPage');
        if (!pg) {
            pg = h('style', { id: 'crPage' });
            document.head.append(pg);
        }
        area.replaceChildren(...nodes);
        pg.textContent = `@media print{@page{${pageCss || 'size:A4;margin:8mm'}}}`;
        document.body.classList.add('crprint');
        const done = () => { document.body.classList.remove('crprint'); area.replaceChildren(); pg.textContent = ''; window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(() => { if (document.body.classList.contains('crprint') && !matchMedia('print').matches)
            done(); }, 1500); }, 80);
    },
    awb(d) {
        let bc;
        try {
            bc = barcodeSvg(String(d.order.tracking));
        }
        catch (_a) {
            bc = h('div');
        }
        const o = d.order, s = d.shipper;
        return h('div', { class: 'cr-awb' }, h('div', { class: 'hd' }, h('b', null, o.courier || 'TCS'), h('span', null, 'Service ', d.service, ' · ', day(o.dispatched_at) || todayStr())), h('div', { class: 'cn' }, bc, h('div', null, o.tracking)), h('div', { class: 'cod' }, 'COD ', rs(o.cod)), h('div', { class: 'box to' }, h('div', { class: 'cr-l' }, 'Deliver to'), h('b', null, o.cust_name), h('div', null, o.phone), h('div', null, o.address), h('b', null, o.city)), h('div', { class: 'two' }, h('div', { class: 'box' }, h('div', { class: 'cr-l' }, 'From'), h('div', null, s.name), h('div', null, s.city), h('div', null, s.mobile), s.account ? h('div', null, 'Acc ', s.account) : null), h('div', { class: 'box' }, h('div', { class: 'cr-l' }, 'Order'), h('b', { style: { fontSize: '14px' } }, o.name), h('div', null, 'Pieces 1 · ', d.weight, ' kg'), h('div', null, (d.items || []).length, ' item(s)'))), h('div', { class: 'box', style: { flex: 1, overflow: 'hidden' } }, h('div', { class: 'cr-l' }, 'Contents'), (d.items || []).map(i => h('div', null, (i.qty > 1 ? i.qty + ' × ' : '') + i.title + (i.sku ? ' (' + i.sku + ')' : '')))), h('div', { style: { textAlign: 'center', fontSize: '9px' } }, 'Please call the customer before delivery · Thank you'));
    },
    async printLabels(ids) {
        ids = ids.filter(Boolean);
        if (!ids.length)
            return toast('Nothing to print', true);
        try {
            const ds = await Promise.all(ids.map(id => GET('/api/couriers/label/' + encodeURIComponent(id))));
            CR.print(ds.map(CR.awb), 'size:100mm 150mm;margin:1mm');
        }
        catch (e) {
            toast(e.message, true);
        }
    },
    sheet(d) {
        const tot = d.items.reduce((s, i) => s + (i.cod || 0), 0);
        return h('div', { class: 'cr-sheet' }, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('div', null, h('h1', null, (META.store || 'SundayBazar') + ' — Rider run sheet'), h('div', null, `Run #${d.run.id} · ${d.run.rider || ''} · ${day(d.run.day)} ${d.run.day.slice(0, 4)}`)), h('div', { style: { textAlign: 'right' } }, h('div', null, `${d.items.length} parcels`), h('b', { style: { fontSize: '16px' } }, 'COD ' + rs(tot)))), h('table', null, h('thead', null, h('tr', null, ['#', 'Order', 'Customer / phone', 'Address', 'COD', 'Cash received', 'Signature'].map((t, i) => h('th', { class: i === 4 || i === 5 ? 'n' : i === 6 ? 'sig' : '' }, t)))), h('tbody', null, d.items.map(i => h('tr', null, h('td', null, i.seq), h('td', null, h('b', null, i.name)), h('td', null, i.cust_name, h('br'), i.phone), h('td', null, i.address, ', ', i.city), h('td', { class: 'n' }, rs(i.cod)), h('td', { class: 'n' }, i.result === 'delivered' ? rs(i.collected) : ''), h('td', { class: 'sig' }, i.result && i.result !== 'delivered' ? CR.label[i.result] : '')))), h('tfoot', null, h('tr', null, h('td', { colspan: 4 }, h('b', null, 'Total')), h('td', { class: 'n' }, h('b', null, rs(tot))), h('td'), h('td')))), h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '14mm' } }, h('div', null, '______________________', h('br'), 'Rider signature'), h('div', null, '______________________', h('br'), 'Cash received by (office)')));
    },
    resultB(i) { return i.result ? h('span', { class: 'b ' + (CR.cls[i.result] || '') }, CR.label[i.result] || i.result) : h('span', { class: 'b info' }, 'To deliver'); },
    resultNote(i) { return i.result === 'delivered' ? 'Cash ' + rs(i.collected) : i.result === 'failed' ? (i.reason_text || i.reason || '') + (i.note ? ' · ' + i.note : '') : i.result === 'rescheduled' ? 'New date ' + day(i.resched_to) + (i.note ? ' · ' + i.note : '') : ''; },
    mapLink: i => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([i.address, i.city, 'Pakistan'].filter(Boolean).join(', ')),
    waText: i => `Assalam o Alaikum ${String(i.cust_name || '').split(' ')[0]}! Main SundayBazar ka rider hoon, aap ka order ${i.name} le kar aa raha hoon. COD ${rs(i.cod)}. Location bhej dein please. Shukriya!`,
    // result form shared by the rider app and the office (rider without phone)
    resultModal(item, reasons, kind, save) {
        CR.style();
        if (kind === 'delivered') {
            const amt = h('input', { type: 'number', class: 'cr-bigin', value: item.cod, inputmode: 'numeric' });
            const m = modal('Delivered · ' + item.name, h('div', { class: 'grid' }, h('div', null, 'Cash collected (Rs). Change it only if the customer paid less.'), amt, h('button', { class: 'cr-btn ok', onclick: () => save({ result: 'delivered', collected: amt.value === '' ? item.cod : +amt.value }).then(() => m.remove()).catch(e => toast(e.message, true)) }, icon('check', 20), 'Confirm delivered', h('small', null, 'Paisay mil gaye'))));
            return m;
        }
        if (kind === 'failed') {
            const note = h('textarea', { placeholder: 'Note (what happened)', rows: 2 });
            const opts = Object.entries(reasons).map(([k, l], n) => h('label', null, h('input', { type: 'radio', name: 'crr', value: k, checked: n === 0 }), l));
            const m = modal('Not delivered · ' + item.name, h('div', { class: 'grid' }, h('div', { class: 'cr-reasons' }, opts), note, h('button', { class: 'cr-btn bad', onclick: () => { const r = (m.querySelector('input[name=crr]:checked') || {}).value; save({ result: 'failed', reason: r, note: note.value }).then(() => m.remove()).catch(e => toast(e.message, true)); } }, 'Save: not delivered', h('small', null, 'Delivery nahi hui'))));
            return m;
        }
        const tm = new Date(Date.now() + 5 * 3600e3 + 864e5).toISOString().slice(0, 10);
        const d = h('input', { type: 'date', class: 'cr-bigin', value: tm }), note = h('textarea', { placeholder: 'Note (e.g. call after 5 pm)', rows: 2 });
        const m = modal('Deliver later · ' + item.name, h('div', { class: 'grid' }, h('div', null, 'New delivery date the customer asked for'), d, note, h('button', { class: 'cr-btn warn', onclick: () => save({ result: 'rescheduled', date: d.value, note: note.value }).then(() => m.remove()).catch(e => toast(e.message, true)) }, 'Save new date', h('small', null, 'Baad mein deliver'))));
        return m;
    },
};
/* ---------- couriers: Dispatch desk — pick list → pack → book & print → load sheet & handover → dispatched today ---------- */
const DP = {
    css: `
.dp-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.dp-tools input[type=search]{flex:1 1 200px;min-width:0;max-width:340px}
.dp-tools select{width:auto;max-width:200px}
.dp-chips{display:flex;flex-wrap:wrap;gap:6px}
.dp-chip{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:5px 12px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.dp-chip.on{background:var(--brand2);border-color:var(--brand2);color:#fff}.dp-chip .n{opacity:.7;font-weight:500;margin-left:4px}
.dp-list{border:1px solid var(--line);border-radius:var(--r);background:var(--panel);box-shadow:var(--shadow)}
.dp-row{display:grid;grid-template-columns:26px minmax(112px,.8fr) minmax(130px,1fr) minmax(150px,1.15fr) minmax(170px,1.4fr) 104px minmax(232px,1.2fr);
  grid-template-areas:"ck ord cus city items cod cour";gap:6px 12px;align-items:start;padding:10px 12px;border-top:1px solid var(--line);font-size:13.5px}
.dp-row:first-child{border-top:0}
.dp-row.hd{font-size:11.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:var(--soft);border-radius:var(--r) var(--r) 0 0;align-items:center}
.dp-row.sel{background:var(--hover)}.dp-row.ok{box-shadow:inset 4px 0 var(--ok)}.dp-row.err{box-shadow:inset 4px 0 var(--bad)}
.dp-row .c-ck{grid-area:ck;padding-top:2px}.dp-row .c-ord{grid-area:ord;min-width:0}.dp-row .c-cus{grid-area:cus;min-width:0}.dp-row .c-city{grid-area:city;min-width:0}
.dp-row .c-items{grid-area:items;min-width:0}.dp-row .c-cod{grid-area:cod;text-align:right}.dp-row .c-cour{grid-area:cour;min-width:0}
.dp-row input[type=checkbox]{width:18px;height:18px}
.dp-nm{font-weight:700;font-size:14px}.dp-sub{font-size:12px;color:var(--muted);line-height:1.35;overflow-wrap:anywhere}
.dp-it{font-size:12.5px;line-height:1.35}.dp-it .mono{font-size:11.5px;color:var(--muted)}
.dp-cod{width:100%;max-width:100px;text-align:right;padding:5px 7px!important;font-weight:700}
.dp-codnote{font-size:11px;color:var(--warn)}
.dp-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.dp-seg button{border:0;background:transparent;padding:6px 11px;font:600 13px var(--font);color:var(--ink);cursor:pointer;white-space:nowrap}
.dp-seg button+button{border-left:1px solid var(--line)}.dp-seg button.on{background:var(--brand2);color:#fff}.dp-seg button.off:not(.on){color:var(--muted);text-decoration:line-through}
.dp-why{font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.3;cursor:help}.dp-why.best{color:var(--ok)}
.dp-m{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;margin-top:3px}.dp-m.ok{color:var(--ok)}.dp-m.warn{color:var(--warn)}.dp-m.bad{color:var(--bad)}
.dp-m .ic{flex:none}
.dp-csel{width:100%;max-width:220px;padding:4px 6px!important;margin-top:4px;font-size:12.5px}
.dp-res{margin-top:6px;font-size:12.5px;line-height:1.35;overflow-wrap:anywhere}.dp-res.ok{color:var(--ok);font-weight:700}.dp-res.bad{color:var(--bad)}
.dp-res .mono{font-size:13px}
.dp-link{background:none;border:0;padding:0;color:var(--muted);font-size:11.5px;text-decoration:underline;cursor:pointer;margin-top:4px}
.dp-bar{flex-wrap:wrap}.dp-bar .sum{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;font-size:13px}
.dp-bar select{width:auto}
.dp-empty{padding:40px 16px;text-align:center;color:var(--muted)}
.dp-trow{grid-template-columns:26px minmax(120px,.9fr) minmax(140px,1.1fr) minmax(170px,1.2fr) 96px minmax(110px,.8fr) minmax(160px,auto);grid-template-areas:"ck ord cus cour cod shop act"}
.dp-trow .c-shop{grid-area:shop;min-width:0}.dp-trow .c-act{grid-area:act;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dp-stepbar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:4px 0 14px}
.dp-step{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);color:var(--ink);text-decoration:none;cursor:pointer;min-width:0;position:relative}
.dp-step:hover{background:var(--hover)}
.dp-step .no{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--muted);font-weight:700;font-size:12.5px}
.dp-step .lb{font-weight:600;font-size:13px;line-height:1.2;min-width:0}.dp-step .lb small{display:block;font-weight:500;font-size:11.5px;color:var(--muted)}
.dp-step .ct{margin-left:auto;flex:none;font-weight:800;font-size:17px;color:var(--muted)}.dp-step .ct.has{color:var(--accent)}
.dp-step.on{border-color:var(--accent);box-shadow:inset 0 -3px 0 var(--accent)}.dp-step.on .no{background:var(--accent);color:#fff}
.dp-step.off{opacity:.55}
.dp-scan{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.dp-scan input{flex:1 1 260px;min-width:0;font-size:17px;padding:11px 12px}
.dp-pk{grid-template-columns:30px 92px minmax(120px,.9fr) minmax(180px,2fr) minmax(100px,.8fr) 160px;grid-template-areas:"ck slot sku item ord act";align-items:center}
.dp-pk .c-item{grid-area:item;min-width:0}.dp-pk .c-slot{grid-area:slot;font:700 15px var(--mono,monospace)}.dp-pk.hd .c-slot{font:inherit}.dp-pk .c-sku{grid-area:sku;min-width:0;overflow-wrap:anywhere}.dp-pk .c-act{grid-area:act;display:flex;gap:6px;justify-content:flex-end}
.dp-pk.done{opacity:.6}.dp-pk.done .c-item{text-decoration:line-through}.dp-pk.miss{box-shadow:inset 4px 0 var(--bad)}
.dp-slot{padding:7px 12px;background:var(--soft);font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;border-top:1px solid var(--line)}
.dp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px}
.dp-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;display:grid;gap:8px;box-shadow:var(--shadow)}
.dp-card .dp-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.dp-card .acts{display:flex;gap:6px;flex-wrap:wrap}
.dp-grp{margin-bottom:14px}.dp-grp .gh{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}.dp-grp .gh h3{margin:0;font-size:16px}
.dp-hrow{grid-template-columns:26px minmax(110px,.9fr) minmax(130px,1fr) minmax(150px,1.2fr) 96px minmax(150px,1fr);grid-template-areas:"ck ord trk cus cod st";align-items:center}
.dp-hrow .c-trk{grid-area:trk;min-width:0;overflow-wrap:anywhere}.dp-hrow .c-st{grid-area:st;min-width:0}
.dp-hand{color:var(--ok);font-weight:700;font-size:12.5px;display:flex;align-items:center;gap:3px}.dp-hand .ic{flex:none}
.dp-slip{width:100mm;min-height:140mm;border:1.5px solid #000;padding:4mm;font:11.5px/1.35 Arial,sans-serif;color:#000;background:#fff;display:flex;flex-direction:column;gap:3mm;page-break-after:always;break-after:page}
.dp-slip:last-child{page-break-after:auto;break-after:auto}
.dp-slip .hd{display:flex;justify-content:space-between;align-items:center;border-bottom:1.5px solid #000;padding-bottom:2mm}.dp-slip .hd b{font-size:17px}
.dp-slip svg{width:70mm;height:13mm}.dp-slip table{width:100%;border-collapse:collapse}.dp-slip td,.dp-slip th{border-bottom:1px solid #000;padding:1.5mm 1mm;text-align:left;vertical-align:top}
.dp-slip .cod{font-size:18px;font-weight:800;text-align:center;border:2px solid #000;padding:1.5mm}
.cr-sheet .bc svg{width:42mm;height:9mm;display:block}.cr-sheet .box{width:6mm;height:6mm;border:1.5px solid #000}
.cr-sheet .sigs{display:grid;grid-template-columns:1fr 1fr;gap:10mm;margin-top:12mm}.cr-sheet .sigs div{border-top:1px solid #000;padding-top:1.5mm}
@media (max-width:1100px){
  .dp-row.hd{display:none}
  .dp-row.dp-pk{grid-template-columns:30px 76px minmax(0,1fr);grid-template-areas:"ck slot sku" "ck item item" "ck ord act";gap:4px 10px}
  .dp-row.dp-hrow{grid-template-columns:28px minmax(0,1fr) auto;grid-template-areas:"ck ord cod" "ck trk trk" "ck cus cus" "ck st st"}
  .dp-row{grid-template-columns:28px minmax(0,1fr) auto;grid-template-areas:"ck ord cod" "ck cus cus" "ck city city" "ck items items" "ck cour cour";padding:12px;gap:6px 10px}
  .dp-row .c-cod{display:flex;flex-direction:column;align-items:flex-end}
  .dp-trow{grid-template-areas:"ck ord cod" "ck cus cus" "ck cour cour" "ck shop shop" "ck act act"}
  .dp-trow .c-act{justify-content:flex-start}
  .dp-seg button{padding:8px 13px;font-size:14px}
}
@media (max-width:900px){
  .dp-stepbar{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(136px,1fr);overflow-x:auto;scrollbar-width:none;padding:2px 0}
  .dp-step .lb small{display:none}
}`,
    styled: false,
    style() { if (!DP.styled) {
        document.head.append(h('style', null, DP.css));
        DP.styled = true;
    } },
    STAGE: { confirmed: ['Confirmed', 'info'], picked: ['Picked', 'warn'], packed: ['Packed', 'ok'] },
    KEYS: ['PostEx', 'TCS', 'Rider'],
    LBL: { PostEx: 'PostEx', TCS: 'TCS', Rider: 'Rider' },
    stageB: s => { const x = DP.STAGE[s] || [s, '']; return h('span', { class: 'b ' + x[1] }, x[0]); },
    // open a PDF from the API in a new tab (pre-opened so popup blockers allow it); errors come back as a toast
    async pdf(method, path, body) {
        const w = window.open('', '_blank');
        if (w) {
            try {
                w.document.write('<p style="font:16px system-ui;padding:20px">Loading PDF from the courier…</p>');
            }
            catch (_a) { }
        }
        try {
            const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'x-sb': '1' }, body: body ? JSON.stringify(body) : undefined });
            const ct = r.headers.get('content-type') || '';
            if (!r.ok || ct.includes('json')) {
                const j = await r.json().catch(() => ({}));
                if (r.ok && j.url) {
                    if (w)
                        w.location = j.url;
                    else
                        window.open(j.url);
                    return;
                }
                throw new Error(j.error || ('Error ' + r.status));
            }
            const url = URL.createObjectURL(await r.blob());
            if (w)
                w.location = url;
            else
                window.open(url);
        }
        catch (e) {
            if (w)
                w.close();
            toast(e.message, true);
        }
    },
    awbParts: tns => { const p = []; for (let i = 0; i < tns.length; i += 10)
        p.push(tns.slice(i, i + 10)); return p; },
    printPostex(tns) {
        tns = [...new Set(tns.filter(Boolean))];
        if (!tns.length)
            return toast('No PostEx parcels', true);
        const parts = DP.awbParts(tns), url = i => '/api/couriers/postex/awb?' + qs({ tns: tns.join(','), part: i });
        if (parts.length === 1)
            return DP.pdf('GET', url(0));
        modal(`PostEx airway bills · ${tns.length} parcels`, h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'PostEx prints up to 10 airway bills per PDF. Open each part and print it.'), h('div', { class: 'row' }, parts.map((p, i) => h('button', { class: 'btn ghost', onclick: () => DP.pdf('GET', url(i)) }, icon('doc', 16), `Part ${i + 1} · ${i * 10 + 1}–${i * 10 + p.length}`)))));
    },
    loadSheet(tns) { tns = [...new Set(tns.filter(Boolean))]; if (!tns.length)
        return toast('No PostEx parcels', true); return DP.pdf('POST', '/api/couriers/postex/loadsheet', { tns }); },
    async runSheet(id) { try {
        const d = await GET('/api/couriers/runs/' + id);
        CR.print([CR.sheet(d)]);
    }
    catch (e) {
        toast(e.message, true);
    } },
    // one "print" button for a mix of couriers: PostEx PDF, TCS labels, rider run sheet
    printMix(list) {
        const px = list.filter(x => x.courier === 'PostEx').map(x => x.tracking), tc = list.filter(x => x.courier === 'TCS').map(x => x.id), runs = [...new Set(list.filter(x => x.courier === 'Rider' && x.run).map(x => x.run))];
        const jobs = [];
        if (px.length)
            jobs.push([`PostEx airway bills (${px.length})`, () => DP.printPostex(px)]);
        if (tc.length)
            jobs.push([`TCS labels (${tc.length})`, () => CR.printLabels(tc)]);
        runs.forEach(r => jobs.push([`Rider run sheet #${r}`, () => DP.runSheet(r)]));
        if (!jobs.length)
            return toast('Nothing booked to print', true);
        if (jobs.length === 1)
            return jobs[0][1]();
        const m = modal('Print airway bills', h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'Each courier prints separately. Click one, print it, then the next.'), jobs.map(([l, fn]) => h('button', { class: 'btn ghost', style: { justifyContent: 'flex-start' }, onclick: () => { fn(); } }, icon('doc', 16), l))));
        return m;
    },
};
const DP_TABS = [['pick', 'Pick list', 'bring pairs from racks'], ['pack', 'Pack', 'scan & pack'], ['book', 'Book & print', 'courier + CN slip'], ['handover', 'Load sheet & handover', 'give to courier'], ['today', 'Dispatched today', 'reprint / cancel']];
VIEWS.dispatch = async (args) => {
    CR.style();
    DP.style();
    const steps = await GET('/api/couriers/dispatch/steps').catch(() => ({}));
    const wh = can('warehouse');
    let tab = args[0] === 'todo' ? 'book' : args[0];
    if (!DP_TABS.some(t => t[0] === tab))
        tab = (wh ? ['pick', 'pack', 'book', 'handover'] : ['book', 'handover']).find(k => steps[k]) || (wh ? 'pick' : 'book');
    DP.steps = steps;
    if (tab === 'pick')
        return dpPick(steps);
    if (tab === 'pack')
        return dpPack(steps);
    if (tab === 'handover')
        return dpHand(steps);
    if (tab === 'today')
        return dpToday(args, steps);
    return dpTodo(steps);
};
function dpHead(tab, s) {
    s = s || {};
    const bar = h('div', { class: 'dp-stepbar', role: 'tablist' }, DP_TABS.map(([k, l, sub], i) => {
        const n = s[k], el = h('a', { class: 'dp-step' + (k === tab ? ' on' : '') + ((k === 'pick' || k === 'pack') && !can('warehouse') ? ' off' : ''), role: 'tab', href: '#/dispatch/' + k, 'aria-selected': k === tab ? 'true' : 'false' }, h('span', { class: 'no' }, i + 1), h('span', { class: 'lb' }, l, h('small', null, sub)), n != null ? h('span', { class: 'ct' + (n && k !== 'today' ? ' has' : '') }, n) : null);
        return el;
    }));
    setTimeout(() => { const on = bar.querySelector('.on'); if (on && bar.scrollWidth > bar.clientWidth)
        bar.scrollLeft = on.offsetLeft - 8; }, 0);
    return [pageHead('Dispatch desk', 'Pick → pack → book the courier → hand over. Work left to right.', can('settings') ? h('a', { class: 'btn ghost sm', href: '#/couriers/settings' }, icon('gear', 16), 'Courier settings') : null, h('a', { class: 'btn ghost sm', href: '#/rider-runs' }, icon('list', 16), 'Rider runs')), bar];
}
// scanner input: Enter submits, keeps focus for the next scan
function dpScan(ph, onCode) {
    const i = h('input', { placeholder: ph, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go' });
    i.addEventListener('keydown', e => { if (e.key === 'Enter' && i.value.trim()) {
        const v = i.value.trim();
        i.value = '';
        onCode(v);
    } });
    setTimeout(() => { if (matchMedia('(min-width:900px)').matches)
        i.focus(); }, 60);
    return i;
}
const dpNoWh = (tab, s, what) => render(...dpHead(tab, s), h('div', { class: 'card dp-empty' }, `${what} is done by the warehouse team (needs warehouse access).`, ' ', h('a', { href: '#/dispatch/book' }, 'Go to Book & print →')));
/* ---- 1. Pick list: confirmed orders, sorted by rack slot ---- */
async function dpPick(steps) {
    if (!can('warehouse'))
        return dpNoWh('pick', steps, 'Picking');
    const d = await GET('/api/pick');
    const items = d.items.filter(i => i.status === 'confirmed').map(i => (Object.assign(Object.assign({}, i), { loc: String(i.location || '').trim() })));
    items.sort((a, b) => (!a.loc - !b.loc) || a.loc.localeCompare(b.loc, 'en', { numeric: true }) || String(a.sku).localeCompare(String(b.sku)));
    const orders = d.orders.filter(o => o.status === 'confirmed'), byOrder = Object.fromEntries(orders.map(o => [o.id, o]));
    const left = items.filter(i => !i.picked).length;
    const flash = h('div', { class: 'small', style: { minHeight: '20px', marginTop: '8px' } });
    const say = (msg, cls) => flash.replaceChildren(h('div', { class: 'flash ' + cls }, msg));
    const scan = dpScan('Scan the shoe barcode (SKU), then Enter', async (code) => {
        try {
            const r = await POST('/api/pick/scan', { code });
            say(`✓ ${r.item.sku} → ${r.order.name}` + (r.left ? ` · ${r.left} more pair${r.left > 1 ? 's' : ''} for this order` : ' · order complete, goes to Pack'), 'ok');
            setTimeout(() => route(), 700);
        }
        catch (e) {
            say('✗ ' + e.message, 'bad');
        }
    });
    const missing = (it, on) => {
        const note = on ? prompt(`${it.sku} not found${it.loc ? ' at ' + it.loc : ''}. Note (optional):`, '') : '';
        if (note === null)
            return;
        act(() => POST(`/api/orders/${encodeURIComponent(it.order_id)}/missing`, { missing: on, note: on ? `${it.sku} missing${it.loc ? ' at ' + it.loc : ''}${note ? ': ' + note : ''}` : '' }), on ? 'Marked missing — the owner sees it' : 'Marked found').then(() => route()).catch(() => { });
    };
    const row = it => {
        const o = byOrder[it.order_id] || {};
        return h('div', { class: 'dp-row dp-pk' + (it.picked ? ' done' : '') + (it.missing ? ' miss' : '') }, h('div', { class: 'c-ck' }, h('input', { type: 'checkbox', checked: !!it.picked, 'aria-label': 'Picked ' + it.sku, onchange: e => act(() => POST('/api/pick/item/' + it.id, { picked: e.target.checked ? 1 : 0 })).then(() => route()).catch(() => { }) })), h('div', { class: 'c-slot' }, it.loc || h('span', { class: 'muted small' }, 'no slot')), h('div', { class: 'c-sku mono', style: { fontWeight: 700 } }, it.sku || '–'), h('div', { class: 'c-item' }, h('div', { class: 'dp-it' }, (it.qty > 1 ? it.qty + ' × ' : '') + (it.title || ''), it.size ? h('span', { class: 'muted' }, ' · size ' + it.size) : null)), h('div', { class: 'c-ord' }, h('a', { class: 'dp-nm', role: 'button', style: { cursor: 'pointer', fontSize: '13.5px' }, onclick: () => typeof openOrder === 'function' && openOrder(it.order_id) }, it.name), o.items > 1 ? h('div', { class: 'dp-sub' }, `${o.picked || 0}/${o.items} picked`) : null), h('div', { class: 'c-act' }, it.missing ? [h('span', { class: 'b bad' }, 'Missing'), h('button', { class: 'btn ghost sm', onclick: () => missing(it, false) }, 'Found')]
            : !it.picked ? h('button', { class: 'btn ghost sm', onclick: () => missing(it, true) }, 'Missing') : null));
    };
    const groups = [];
    let cur = null;
    for (const it of items) {
        const g = it.loc ? it.loc.split(/[-\s]/)[0] : '';
        if (!cur || cur.g !== g)
            groups.push(cur = { g, list: [] });
        cur.list.push(it);
    }
    const printList = () => {
        const sel = items.filter(i => !i.picked);
        if (!sel.length)
            return toast('Everything is picked', true);
        const bc = t => { try {
            const s = barcodeSvg(String(t));
            return s;
        }
        catch (_a) {
            return h('span');
        } };
        CR.print([h('div', { class: 'cr-sheet' }, h('h1', null, 'Pick list · ' + day(todayStr())), h('div', null, `${sel.length} pair${sel.length > 1 ? 's' : ''} · ${new Set(sel.map(i => i.order_id)).size} orders · sorted by rack slot · printed ${dt(new Date().toISOString())} by ${ME.name}`), h('table', null, h('thead', null, h('tr', null, h('th', { style: { width: '9mm' } }, '✓'), h('th', null, 'Slot'), h('th', null, 'SKU / barcode'), h('th', null, 'Item'), h('th', null, 'Size'), h('th', null, 'Order'))), h('tbody', null, sel.map(i => h('tr', null, h('td', null, h('div', { class: 'box' })), h('td', { style: { fontWeight: 700, fontSize: '14px' } }, i.loc || '–'), h('td', null, h('div', { class: 'bc' }, bc(i.sku)), h('div', { style: { fontFamily: 'monospace', fontWeight: 700 } }, i.sku)), h('td', null, (i.qty > 1 ? i.qty + ' × ' : '') + (i.title || '')), h('td', null, i.size || ''), h('td', { style: { fontWeight: 700 } }, i.name))))))]);
    };
    const missN = orders.filter(o => o.missing).length;
    render(...dpHead('pick', steps), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Bring each pair from its slot and scan it', h('small', null, `${left} of ${items.length} pairs left · ${orders.length} orders`)), h('button', { class: 'btn', onclick: printList, disabled: !left }, icon('doc', 16), 'Print pick list')), h('div', { class: 'dp-scan', style: { marginTop: '10px' } }, scan), flash, missN ? h('div', { class: 'note warn', style: { marginTop: '6px' } }, `${missN} order${missN > 1 ? 's have' : ' has'} a missing pair — find it or tell CS to call the customer.`) : null), items.length ? h('div', { class: 'dp-list' }, h('div', { class: 'dp-row dp-pk hd' }, h('div', { class: 'c-ck' }, '✓'), h('div', { class: 'c-slot' }, 'Slot'), h('div', { class: 'c-sku' }, 'SKU'), h('div', { class: 'c-item' }, 'Item · size'), h('div', { class: 'c-ord' }, 'Order'), h('div', { class: 'c-act' }, '')), groups.map(g => [groups.length > 1 ? h('div', { class: 'dp-slot' }, g.g ? 'Rack ' + g.g : 'No slot saved') : null, g.list.map(row)]))
        : h('div', { class: 'card dp-empty' }, h('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--ink)' } }, 'Nothing to pick'), 'Orders show up here as soon as CS confirms them.', steps.pack ? h('div', { style: { marginTop: '10px' } }, h('a', { href: '#/dispatch/pack' }, `${steps.pack} picked, waiting to be packed →`)) : null));
}
/* ---- 2. Pack: picked orders → scan to mark packed, packing slips ---- */
function dpSlip(r) {
    let bc;
    try {
        bc = barcodeSvg(String(r.name).replace('#', ''));
    }
    catch (_a) {
        bc = h('span');
    }
    return h('div', { class: 'dp-slip' }, h('div', { class: 'hd' }, h('b', null, META.store || 'SundayBazar'), h('span', null, 'Packing slip · ' + day(todayStr()))), h('div', { style: { textAlign: 'center' } }, bc, h('div', { style: { font: '700 16px monospace' } }, r.name)), h('div', null, h('div', { style: { fontSize: '9px', textTransform: 'uppercase', letterSpacing: '.06em' } }, 'Deliver to'), h('div', { style: { fontSize: '14px', fontWeight: 700 } }, r.cust_name || ''), h('div', null, [r.address, r.city].filter(Boolean).join(', ')), r.phone ? h('div', null, r.phone) : null), h('table', null, h('thead', null, h('tr', null, h('th', null, 'Qty'), h('th', null, 'Item'), h('th', null, 'SKU'))), h('tbody', null, (r.lines.length ? r.lines : [{ qty: r.items, title: 'Shoes', sku: '' }]).map(l => h('tr', null, h('td', null, l.qty || 1), h('td', null, l.title || ''), h('td', { style: { fontFamily: 'monospace' } }, l.sku || ''))))), h('div', { class: 'cod' }, 'COD ' + rs(r.total)), h('div', { style: { fontSize: '10px', textAlign: 'center', marginTop: 'auto' } }, 'Thank you for shopping with ' + (META.store || 'SundayBazar') + '. Check the pair before paying the rider.'));
}
async function dpPack(steps) {
    if (!can('warehouse'))
        return dpNoWh('pack', steps, 'Packing');
    const d = await GET('/api/couriers/dispatch');
    const rows = d.rows.filter(r => r.status === 'picked').sort((a, b) => String(a.picked_at || a.created_at).localeCompare(String(b.picked_at || b.created_at)));
    const flash = h('div', { class: 'small', style: { minHeight: '20px', marginTop: '8px' } });
    const say = (msg, cls) => flash.replaceChildren(h('div', { class: 'flash ' + cls }, msg));
    const pack = async (code, label) => {
        try {
            const r = await POST('/api/pack/scan', { code });
            say('✓ ' + r.order.name + ' packed · next step: Book & print', 'ok');
            setTimeout(() => route(), 700);
        }
        catch (e) {
            if (/not picked/.test(e.message) && confirm(e.message + '. Pack anyway?')) {
                await act(() => POST('/api/pack/scan', { code, force: true }), (label || code) + ' packed').catch(() => { });
                route();
            }
            else
                say('✗ ' + e.message, 'bad');
        }
    };
    const scan = dpScan('Scan the order number or a shoe SKU, then Enter', code => {
        const up = code.toUpperCase().replace(/^#/, '');
        if (rows.some(r => String(r.name).toUpperCase().replace(/^#/, '') === up))
            return pack(code);
        const hits = rows.filter(r => r.lines.some(l => String(l.sku || '').toUpperCase() === up));
        if (hits.length === 1)
            return pack(hits[0].name, hits[0].name);
        if (hits.length > 1)
            return say(`${code} is in ${hits.length} orders (${hits.map(r => r.name).join(', ')}) — scan the order number`, 'warn');
        return pack(code);
    });
    const slips = list => { if (!list.length)
        return toast('Nothing to print', true); CR.print(list.map(dpSlip), 'size:105mm 148mm;margin:2mm'); };
    const card = r => h('div', { class: 'dp-card' }, h('div', { class: 'dp-top' }, h('div', null, h('a', { class: 'dp-nm', role: 'button', style: { cursor: 'pointer', fontSize: '16px' }, onclick: () => typeof openOrder === 'function' && openOrder(r.id) }, r.name), h('div', { class: 'dp-sub' }, [r.cust_name, r.city].filter(Boolean).join(' · '))), h('div', { style: { textAlign: 'right' } }, h('div', { style: { fontWeight: 800 } }, rs(r.total)), h('div', { class: 'dp-sub' }, `${r.pairs} pair${r.pairs > 1 ? 's' : ''}`))), h('div', null, r.lines.map(i => h('div', { class: 'dp-it' }, (i.qty > 1 ? i.qty + ' × ' : '') + i.title, i.sku ? h('span', { class: 'mono' }, ' ' + i.sku) : null))), h('div', { class: 'acts' }, h('button', { class: 'btn ok sm', onclick: () => pack(r.name, r.name) }, icon('check', 15), 'Packed'), h('button', { class: 'btn ghost sm', onclick: () => slips([r]) }, icon('doc', 15), 'Packing slip')));
    render(...dpHead('pack', steps), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Pack the picked orders', h('small', null, `${rows.length} waiting`)), h('button', { class: 'btn', disabled: !rows.length, onclick: () => slips(rows) }, icon('doc', 16), `Print packing slips (${rows.length})`)), h('div', { class: 'dp-scan', style: { marginTop: '10px' } }, scan), flash), rows.length ? h('div', { class: 'dp-cards' }, rows.map(card))
        : h('div', { class: 'card dp-empty' }, h('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--ink)' } }, 'Nothing to pack'), 'Orders come here when every pair is picked.', h('div', { style: { marginTop: '10px' } }, steps.pick ? h('a', { href: '#/dispatch/pick' }, `${steps.pick} still to pick →`) : null, steps.pick && steps.book ? ' · ' : null, steps.book ? h('a', { href: '#/dispatch/book' }, `${steps.book} packed, ready to book →`) : null)));
}
/* ---- 4. Load sheet & handover: booked parcels grouped by courier → mark handed (the dispatch moment) ---- */
function dpHandSheet(k, list, d) {
    const cod = list.reduce((a, r) => { var _a, _b; return a + (+((_b = (_a = r.courier_cod) !== null && _a !== void 0 ? _a : r.cod) !== null && _b !== void 0 ? _b : r.total) || 0); }, 0);
    return h('div', { class: 'cr-sheet' }, h('h1', null, `${k === 'Rider' ? 'Own rider' : k} handover list · ${day(todayStr())}`), h('div', null, `${d.store} · ${list.length} parcel${list.length > 1 ? 's' : ''} · COD ${rs(cod)}` + (d.pickup && k === 'PostEx' ? ' · pickup: ' + d.pickup : '')), h('table', null, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Order'), h('th', null, k === 'TCS' ? 'CN' : 'Tracking'), h('th', null, 'Customer'), h('th', null, 'City'), h('th', { class: 'n' }, 'Pcs'), h('th', { class: 'n' }, 'COD'), h('th', { class: 'sig' }, 'Received'))), h('tbody', null, list.map((r, i) => {
        var _a, _b;
        return h('tr', null, h('td', null, i + 1), h('td', null, r.name), h('td', { style: { fontFamily: 'monospace' } }, r.tracking), h('td', null, r.cust_name || ''), h('td', null, r.city || ''), h('td', { class: 'n' }, r.items || 1), h('td', { class: 'n' }, rs((_b = (_a = r.courier_cod) !== null && _a !== void 0 ? _a : r.cod) !== null && _b !== void 0 ? _b : r.total)), h('td', null, ''));
    })), h('tfoot', null, h('tr', null, h('td', { colspan: 6 }, h('b', null, 'Total')), h('td', { class: 'n' }, h('b', null, rs(cod))), h('td', null, '')))), h('div', { class: 'sigs' }, h('div', null, 'Handed over by (name, time)'), h('div', null, 'Courier rider name & signature')));
}
async function dpHand(steps) {
    const d = await GET('/api/couriers/dispatch/handover');
    const order = ['PostEx', 'TCS', 'Rider'], ks = [...new Set(d.rows.map(r => r.k))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const sel = new Set();
    const mark = async (list, k) => {
        const ids = list.filter(r => !r.handed_at).map(r => r.id);
        if (!ids.length)
            return toast('These parcels are already handed over', true);
        if (!confirm(`Hand ${ids.length} ${k} parcel${ids.length > 1 ? 's' : ''} to the courier now?\nTime and your name are saved.`))
            return;
        await act(() => POST('/api/couriers/dispatch/handover', { ids, courier: k }), `${ids.length} handed to ${k}`).catch(() => { });
        route();
    };
    const undo = r => act(() => POST('/api/couriers/dispatch/handover', { ids: [r.id], undo: true }), 'Handover undone').then(() => route()).catch(() => { });
    const group = k => {
        const all = d.rows.filter(r => r.k === k), wait = all.filter(r => !r.handed_at);
        const pickL = () => { const s = all.filter(r => sel.has(r.id)); return s.length ? s : (wait.length ? wait : all); };
        const cod = all.reduce((a, r) => { var _a, _b; return a + (+((_b = (_a = r.courier_cod) !== null && _a !== void 0 ? _a : r.cod) !== null && _b !== void 0 ? _b : r.total) || 0); }, 0);
        const btns = h('div', { class: 'row' });
        const paint = () => {
            const p = pickL(), n = p.filter(r => !r.handed_at).length, tag = all.some(r => sel.has(r.id)) ? ' selected' : '';
            btns.replaceChildren(...[
                k === 'PostEx' ? h('button', { class: 'btn ghost sm', onclick: () => DP.loadSheet(p.map(r => r.tracking)) }, icon('list', 16), `PostEx load sheet (${p.length}${tag})`) : null,
                h('button', { class: 'btn ghost sm', onclick: () => CR.print([dpHandSheet(k, p, d)]) }, icon('doc', 16), `${k === 'Rider' ? 'Rider' : k} list (${p.length}${tag})`),
                h('button', { class: 'btn ok sm', disabled: !n, onclick: () => mark(p, k) }, icon('check', 16), n ? `Mark handed (${n})` : 'All handed')
            ].filter(Boolean));
        };
        const row = r => {
            var _a, _b;
            return h('div', { class: 'dp-row dp-hrow' + (r.handed_at ? ' ok' : '') }, h('div', { class: 'c-ck' }, h('input', { type: 'checkbox', 'aria-label': 'Select ' + r.name, onchange: e => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); paint(); } })), h('div', { class: 'c-ord' }, h('div', { class: 'dp-nm' }, r.name), h('div', { class: 'dp-sub' }, 'Booked ' + dt(r.dispatched_at))), h('div', { class: 'c-trk mono', style: { fontWeight: 600 } }, r.tracking), h('div', { class: 'c-cus' }, h('div', { style: { fontWeight: 600 } }, r.cust_name || '–'), h('div', { class: 'dp-sub' }, r.city || '')), h('div', { class: 'c-cod', style: { fontWeight: 700 } }, rs((_b = (_a = r.courier_cod) !== null && _a !== void 0 ? _a : r.cod) !== null && _b !== void 0 ? _b : r.total)), h('div', { class: 'c-st' }, r.handed_at ? [h('div', { class: 'dp-hand' }, icon('check', 14), ' Handed ' + dt(r.handed_at)), h('div', { class: 'dp-sub' }, 'by ' + (r.handed_by || '–'), ' · ', h('button', { class: 'dp-link', style: { marginTop: 0 }, onclick: () => undo(r) }, 'undo'))]
                : h('span', { class: 'b warn' }, 'Waiting for courier')));
        };
        paint();
        return h('div', { class: 'dp-grp' }, h('div', { class: 'gh' }, h('h3', null, k === 'Rider' ? 'Own rider' : k), h('span', { class: 'b' }, `${all.length} parcel${all.length > 1 ? 's' : ''}`), h('span', { class: 'small muted' }, 'COD ' + rs(cod)), wait.length ? h('span', { class: 'b warn' }, wait.length + ' waiting') : h('span', { class: 'b ok' }, 'all handed'), h('span', { class: 'spacer' }), btns), h('div', { class: 'dp-list' }, h('div', { class: 'dp-row dp-hrow hd' }, h('div', { class: 'c-ck' }, ''), h('div', { class: 'c-ord' }, 'Order'), h('div', { class: 'c-trk' }, 'Tracking / CN'), h('div', { class: 'c-cus' }, 'Customer'), h('div', { class: 'c-cod' }, 'COD'), h('div', { class: 'c-st' }, 'Handover')), all.map(row)));
    };
    render(...dpHead('handover', steps), h('div', { class: 'note', style: { marginBottom: '12px' } }, 'When the courier picks up: print the PostEx load sheet (or the TCS / rider list), get it signed, then press ', h('b', null, 'Mark handed'), '. That is the dispatch moment — time and your name are saved.'), ks.length ? ks.map(group) : h('div', { class: 'card dp-empty' }, h('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--ink)' } }, 'Nothing waiting for the courier'), 'Parcels show up here after Book & print.', steps.book ? h('div', { style: { marginTop: '10px' } }, h('a', { href: '#/dispatch/book' }, `${steps.book} packed, ready to book →`)) : null));
}
/* ---- 3. Book & print: packed orders → courier, city, COD, bulk book, airway bills ---- */
async function dpTodo(steps) {
    const d = await GET('/api/couriers/dispatch');
    const notPacked = d.packFirst ? d.rows.filter(r => r.status !== 'packed').length : 0;
    if (d.packFirst)
        d.rows = d.rows.filter(r => r.status === 'packed');
    const F = { f: store.get('dp_filter', 'all'), city: '', q: '' };
    if (d.packFirst && F.f === 'packed')
        F.f = 'all';
    const X = d.rows.map(r => ({ r, id: r.id, courier: r.pick.courier, cod: r.total, pxCity: '', tcsCode: '', sel: false, res: null, el: null,
        text: [r.name, r.cust_name, r.phone, r.city, r.address, ...r.lines.map(i => i.title + ' ' + i.sku)].join(' ').toLowerCase() }));
    const riderSel = h('select', null, d.riders.length > 1 ? h('option', { value: '' }, 'Choose rider…') : null, d.riders.map(r => h('option', { value: r.id }, r.name)));
    const riderWrap = h('label', { class: 'row small', hidden: true }, 'Rider', riderSel);
    /* ---- one row ---- */
    const cityCell = x => {
        const r = x.r, k = x.courier, out = [h('div', { class: 'dp-nm', style: { fontSize: '13.5px' } }, r.city || h('span', { class: 'muted' }, 'no city'))];
        const mk = (cls, ic, txt, title) => h('div', { class: 'dp-m ' + cls, title: title || '' }, icon(ic, 14), txt);
        if (k === 'Rider')
            out.push(r.karachi ? mk('ok', 'check', 'Karachi') : mk('warn', 'alert', 'Not Karachi — rider only delivers in Karachi'));
        else {
            const m = k === 'PostEx' ? r.px : r.tcs, chosen = k === 'PostEx' ? x.pxCity : x.tcsCode, loaded = k === 'PostEx' ? d.cities.px : d.cities.tcs;
            if (m.sure && !chosen)
                out.push(mk('ok', 'check', `${k}: ${m.name}${k === 'TCS' && m.code ? ' (' + m.code + ')' : ''}`, `${k} city list has this city`));
            else if (!loaded)
                out.push(mk('warn', 'alert', `${k} cities not loaded`, 'They load automatically on the first booking'));
            else {
                const s = h('select', { class: 'dp-csel', onchange: () => {
                        if (s.value === '__find') {
                            s.value = chosen || '';
                            return dpFindCity(x, k, v => { if (k === 'PostEx')
                                x.pxCity = v;
                            else
                                x.tcsCode = v; paint(x); });
                        }
                        if (k === 'PostEx')
                            x.pxCity = s.value;
                        else
                            x.tcsCode = s.value;
                        paint(x);
                    } }, h('option', { value: '' }, m.options.length ? `Choose ${k} city…` : `No ${k} match — search…`), (m.options || []).map(o => h('option', { value: k === 'PostEx' ? o.name : o.code, selected: (k === 'PostEx' ? o.name : o.code) === chosen }, o.name)), chosen && !(m.options || []).some(o => (k === 'PostEx' ? o.name : o.code) === chosen) ? h('option', { value: chosen, selected: true }, x.chosenName || chosen) : null, h('option', { value: '__find' }, 'Search all cities…'));
                out.push(chosen ? mk('ok', 'check', 'City chosen') : mk('warn', 'alert', `Check ${k} city`), s);
            }
        }
        if (r.address)
            out.push(h('div', { class: 'dp-sub', style: { marginTop: '3px' } }, r.address));
        return out;
    };
    const courCell = x => {
        const r = x.r;
        if (x.res && x.res.ok)
            return [h('div', { class: 'dp-res ok' }, icon('check', 15), ' ', x.res.courier, ' · ', h('span', { class: 'mono' }, x.res.tracking)),
                x.res.run ? h('div', { class: 'dp-sub' }, 'Rider run #' + x.res.run) : null];
        const seg = h('div', { class: 'dp-seg', role: 'group' }, DP.KEYS.map(k => h('button', { type: 'button', class: (k === x.courier ? 'on ' : '') + (d.usable[k] === false ? 'off' : ''),
            title: d.usable[k] === false ? (k === 'Rider' ? 'No rider login yet' : k + ' is not connected') : (k === 'Rider' ? 'Own rider (Karachi)' : 'Book on ' + k),
            onclick: () => { x.courier = k; paint(x); bar.upd(); } }, DP.LBL[k])));
        const why = x.courier === r.pick.courier ? r.pick.why : `Changed by you (suggested: ${r.pick.courier})`;
        return [seg, h('div', { class: 'dp-why' + (r.pick.rate && x.courier === r.pick.courier ? ' best' : ''), title: r.pick.detail || r.pick.why }, why),
            x.res && x.res.error ? h('div', { class: 'dp-res bad' }, x.res.error) : null,
            h('button', { class: 'dp-link', onclick: () => dpManual(r) }, 'Enter tracking by hand')];
    };
    const paint = x => {
        const el = x.el;
        if (!el)
            return;
        el.className = 'dp-row' + (x.sel ? ' sel' : '') + (x.res ? (x.res.ok ? ' ok' : ' err') : '');
        el._city.replaceChildren(...cityCell(x).flat().filter(Boolean));
        el._cour.replaceChildren(...courCell(x).flat().filter(Boolean));
        el._ck.disabled = !!(x.res && x.res.ok);
        el._ck.checked = x.sel;
        el._codI.disabled = !!(x.res && x.res.ok);
    };
    const rowEl = x => {
        const r = x.r;
        const ck = h('input', { type: 'checkbox', 'aria-label': 'Select ' + r.name, onchange: e => { x.sel = e.target.checked; el.classList.toggle('sel', x.sel); bar.upd(); } });
        const note = h('div', { class: 'dp-codnote' });
        const codI = h('input', { type: 'number', class: 'dp-cod', value: r.total, min: 0, inputmode: 'numeric', title: 'COD to collect. Lower it if the customer paid an advance.',
            oninput: () => { x.cod = codI.value === '' ? r.total : Math.max(0, +codI.value); note.textContent = x.cod !== r.total ? 'order ' + rs(r.total) : ''; bar.upd(); } });
        const city = h('div', { class: 'c-city' }), cour = h('div', { class: 'c-cour' });
        const el = h('div', { class: 'dp-row' }, h('div', { class: 'c-ck' }, ck), h('div', { class: 'c-ord' }, h('a', { class: 'dp-nm', role: 'button', style: { cursor: 'pointer' }, onclick: () => typeof openOrder === 'function' && openOrder(r.id) }, r.name), h('div', { class: 'dp-sub' }, dt(r.created_at)), h('div', { style: { marginTop: '3px' } }, DP.stageB(r.status))), h('div', { class: 'c-cus' }, h('div', { style: { fontWeight: 600 } }, r.cust_name || '–'), h('div', { class: 'dp-sub mono' }, r.phone || '')), city, h('div', { class: 'c-items' }, r.lines.length ? r.lines.map(i => h('div', { class: 'dp-it' }, (i.qty > 1 ? i.qty + ' × ' : '') + i.title, i.sku ? h('span', { class: 'mono' }, ' ' + i.sku) : null)) : h('div', { class: 'dp-it' }, r.items + ' item(s)'), h('div', { class: 'dp-sub' }, `${r.pairs} pair${r.pairs > 1 ? 's' : ''} · ${r.weight} kg`)), h('div', { class: 'c-cod' }, codI, note, /paid|partially/i.test(r.financial || '') && !/pending/i.test(r.financial || '') ? h('span', { class: 'b info', style: { marginTop: '3px' } }, r.financial) : null), cour);
        el._city = city;
        el._cour = cour;
        el._ck = ck;
        el._codI = codI;
        x.el = el;
        paint(x);
        return el;
    };
    /* ---- filters ---- */
    const isShown = x => {
        const r = x.r;
        if (F.f === 'packed' && r.status !== 'packed')
            return false;
        if (F.f === 'khi' && !r.karachi)
            return false;
        if (F.f === 'out' && r.karachi)
            return false;
        if (F.city && (r.city || '').trim().toLowerCase() !== F.city)
            return false;
        if (F.q && !F.q.split(/\s+/).every(w => x.text.includes(w)))
            return false;
        return true;
    };
    const shown = () => X.filter(x => !x.el.hidden);
    const applyF = () => { let n = 0; for (const x of X) {
        const v = isShown(x);
        x.el.hidden = !v;
        if (v)
            n++;
    } emptyF.hidden = !!n || !X.length; allCk.checked = false; bar.upd(); };
    const cnt = { all: X.length, packed: X.filter(x => x.r.status === 'packed').length, khi: X.filter(x => x.r.karachi).length };
    cnt.out = X.length - cnt.khi;
    const chips = h('div', { class: 'dp-chips' }, [['all', 'All'], d.packFirst ? null : ['packed', 'Packed only'], ['khi', 'Karachi'], ['out', 'Not Karachi']].filter(Boolean).map(([k, l]) => h('button', { class: 'dp-chip' + (F.f === k ? ' on' : ''), onclick: e => { F.f = k; store.set('dp_filter', k); chips.querySelectorAll('.dp-chip').forEach(c => c.classList.remove('on')); e.currentTarget.classList.add('on'); applyF(); } }, l, h('span', { class: 'n' }, cnt[k]))));
    const cities = {};
    X.forEach(x => { const c = (x.r.city || '').trim(); if (!c)
        return; const key = c.toLowerCase(); (cities[key] || (cities[key] = { name: c, n: 0 })).n++; });
    const citySel = h('select', { 'aria-label': 'City', onchange: () => { F.city = citySel.value; applyF(); } }, h('option', { value: '' }, 'All cities'), Object.entries(cities).sort((a, b) => b[1].n - a[1].n).map(([k, c]) => h('option', { value: k }, `${c.name} (${c.n})`)));
    let tq;
    const search = h('input', { type: 'search', placeholder: 'Search order, name, phone, SKU…', oninput: () => { clearTimeout(tq); tq = setTimeout(() => { F.q = search.value.trim().toLowerCase(); applyF(); }, 120); } });
    const setAll = h('select', { 'aria-label': 'Set courier for selected', onchange: () => { const k = setAll.value; setAll.value = ''; if (!k)
            return; const s = X.filter(x => x.sel && !(x.res && x.res.ok)); if (!s.length)
            return toast('Select orders first', true); s.forEach(x => { x.courier = k; paint(x); }); bar.upd(); } }, h('option', { value: '' }, 'Set selected to…'), DP.KEYS.map(k => h('option', { value: k }, k === 'Rider' ? 'Rider (Karachi)' : k)));
    /* ---- select all ---- */
    const allCk = h('input', { type: 'checkbox', 'aria-label': 'Select all shown', onchange: e => { for (const x of shown())
            if (!(x.res && x.res.ok)) {
                x.sel = e.target.checked;
                x.el._ck.checked = x.sel;
                x.el.classList.toggle('sel', x.sel);
            } bar.upd(); } });
    const selAllBtn = h('button', { class: 'btn ghost sm', onclick: () => { const s = shown().filter(x => !(x.res && x.res.ok)); const on = !s.every(x => x.sel); s.forEach(x => { x.sel = on; x.el._ck.checked = on; x.el.classList.toggle('sel', on); }); allCk.checked = on; bar.upd(); } }, 'Select all shown');
    /* ---- bottom bar ---- */
    const sumEl = h('div', { class: 'sum' }), bookBtn = h('button', { class: 'btn primary', onclick: () => book() }, icon('truck', 16), 'Book & dispatch');
    const after = h('div', { class: 'row', hidden: true });
    const barEl = h('div', { class: 'cr-bar dp-bar', hidden: true }, sumEl, h('span', { class: 'spacer' }), riderWrap, after, bookBtn);
    const bar = { upd() {
            const s = X.filter(x => x.sel && !(x.res && x.res.ok)), by = { PostEx: 0, TCS: 0, Rider: 0 };
            s.forEach(x => by[x.courier]++);
            const cod = s.reduce((a, x) => a + (+x.cod || 0), 0);
            sumEl.replaceChildren(h('strong', null, `${s.length} selected`), h('span', null, 'COD ', h('strong', null, rs(cod))), ...DP.KEYS.filter(k => by[k]).map(k => h('span', { class: 'b' }, `${k} ${by[k]}`)));
            riderWrap.hidden = !(by.Rider && d.riders.length > 1);
            bookBtn.disabled = !s.length;
            bookBtn.hidden = !s.length && !!X.some(x => x.res);
            barEl.hidden = !s.length && after.hidden;
        } };
    const list = h('div', { class: 'dp-list' }, h('div', { class: 'dp-row hd' }, h('div', { class: 'c-ck' }, allCk), h('div', { class: 'c-ord' }, 'Order'), h('div', { class: 'c-cus' }, 'Customer'), h('div', { class: 'c-city' }, 'City / address'), h('div', { class: 'c-items' }, 'Items'), h('div', { class: 'c-cod' }, 'COD'), h('div', { class: 'c-cour' }, 'Courier')), X.map(rowEl));
    const emptyF = h('div', { class: 'dp-empty', hidden: true }, 'No orders match this filter.');
    /* ---- book ---- */
    async function book() {
        const s = X.filter(x => x.sel && !(x.res && x.res.ok));
        if (!s.length)
            return;
        if (s.some(x => x.courier === 'Rider') && d.riders.length > 1 && !riderSel.value)
            return toast('Choose the rider for the Karachi parcels', true);
        const by = {};
        s.forEach(x => { by[x.courier] = (by[x.courier] || 0) + 1; });
        if (!confirm(`Book ${s.length} order${s.length > 1 ? 's' : ''} now?\n` + Object.entries(by).map(([k, n]) => `${k}: ${n}`).join('\n')))
            return;
        bookBtn.disabled = true;
        const label = bookBtn.lastChild.textContent;
        let done = 0, okN = 0, bad = 0, runId = null;
        try {
            for (let i = 0; i < s.length; i += 40) {
                const chunk = s.slice(i, i + 40);
                bookBtn.lastChild.textContent = `Booking ${done + 1}–${done + chunk.length} of ${s.length}…`;
                const b = await POST('/api/couriers/dispatch/book', { rider_id: riderSel.value ? +riderSel.value : null, run_id: runId,
                    rows: chunk.map(x => ({ id: x.id, courier: x.courier, cod: x.cod, city: x.courier === 'PostEx' ? (x.pxCity || null) : x.courier === 'TCS' ? (x.tcsCode || null) : null })) });
                runId = b.run || runId;
                b.results.forEach((res, j) => {
                    const x = chunk[j];
                    x.res = res;
                    if (res.ok) {
                        okN++;
                        x.sel = false;
                    }
                    else
                        bad++;
                    if (res.needCity && res.options) {
                        const m = x.courier === 'PostEx' ? x.r.px : x.r.tcs;
                        m.sure = false;
                        m.options = res.options;
                    }
                    paint(x);
                });
                done += chunk.length;
            }
        }
        catch (e) {
            toast(e.message, true);
        }
        bookBtn.lastChild.textContent = label;
        toast(`${okN} booked` + (bad ? ` · ${bad} not booked — see the red lines` : ''), !!bad && !okN);
        showAfter();
        const first = X.find(x => x.res && !x.res.ok);
        if (first)
            first.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        bar.upd();
    }
    const booked = () => X.filter(x => x.res && x.res.ok).map(x => ({ id: x.id, courier: x.res.courier, tracking: x.res.tracking, run: x.res.run }));
    function showAfter() {
        const b = booked();
        if (!b.length)
            return;
        const px = b.filter(x => x.courier === 'PostEx').map(x => x.tracking);
        after.replaceChildren(h('span', { class: 'b ok' }, `${b.length} booked`), h('button', { class: 'btn ok', onclick: () => DP.printMix(booked()) }, icon('doc', 16), 'Print airway bills'), px.length ? h('button', { class: 'btn ghost', onclick: () => DP.loadSheet(px) }, icon('list', 16), `PostEx load sheet (${px.length})`) : null, h('a', { class: 'btn ghost', href: '#/dispatch/handover' }, 'Next: load sheet & handover →'));
        after.hidden = false;
    }
    const warn = [];
    if (!d.usable.PostEx)
        warn.push('PostEx is not connected (Settings → PostEx token).');
    else if (!d.pickup.code)
        warn.push(can('settings') ? h('span', null, 'Choose the PostEx pickup address in ', h('a', { href: '#/couriers/settings' }, 'Courier settings'), ' before booking PostEx.') : 'PostEx pickup address is not set — ask the owner (Courier settings).');
    if (!d.usable.TCS)
        warn.push('TCS is not connected (Courier settings).');
    if (!d.usable.Rider)
        warn.push('No rider login yet — Karachi parcels can go on TCS or PostEx.');
    render(...dpHead('book', steps), notPacked ? h('div', { class: 'note', style: { marginBottom: '10px' } }, `Only packed orders are booked here. ${notPacked} confirmed order${notPacked > 1 ? 's are' : ' is'} still in `, h('a', { href: '#/dispatch/pick' }, 'Pick'), ' / ', h('a', { href: '#/dispatch/pack' }, 'Pack'), '.', can('settings') ? [' Change this in ', h('a', { href: '#/couriers/settings' }, 'Courier settings'), '.'] : null) : null, warn.length ? h('div', { class: 'note warn', style: { marginBottom: '10px' } }, warn.map(w => h('div', null, w))) : null, h('div', { class: 'dp-tools' }, chips, citySel, search, h('span', { class: 'spacer' }), selAllBtn, setAll), X.length ? list : h('div', { class: 'card dp-empty' }, h('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--ink)' } }, 'Nothing to book right now'), d.packFirst ? 'Orders show up here once they are packed.' : 'Orders show up here as soon as CS confirms them.', d.bookedToday ? h('div', { style: { marginTop: '10px' } }, h('a', { href: '#/dispatch/today' }, `${d.bookedToday} booked today →`)) : null), emptyF, barEl);
    applyF();
}
function dpFindCity(x, k, done) {
    const inp = h('input', { placeholder: 'Type city name' }), out = h('div', { class: 'grid', style: { gap: '4px', maxHeight: '300px', overflow: 'auto' } });
    const look = async () => {
        const l = await GET((k === 'PostEx' ? '/api/couriers/postex/cities?q=' : '/api/couriers/tcs/cities?q=') + encodeURIComponent(inp.value)).catch(e => { toast(e.message, true); return []; });
        out.replaceChildren(...(l.length ? l.map(c => h('button', { class: 'btn ghost sm', style: { justifyContent: 'flex-start' }, onclick: () => { x.chosenName = c.name; done(k === 'PostEx' ? c.name : c.code); m.remove(); } }, c.name, c.code ? h('span', { class: 'muted mono' }, ' ' + c.code) : null)) : [h('div', { class: 'muted small' }, 'No city found')]));
    };
    inp.addEventListener('input', look);
    const m = modal(`${k} city for ${x.r.name} (${x.r.city || 'no city'})`, h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'Your choice is remembered for this city next time.'), inp, out));
    inp.value = String(x.r.city || '').replace(/[^a-z ]/gi, ' ').trim().split(/\s+/)[0] || '';
    look();
}
function dpManual(r) {
    formModal('Enter tracking · ' + r.name, [
        { k: 'courier', label: 'Courier', type: 'select', options: CR.COURIERS, value: 'PostEx' }, { k: 'other', label: 'Courier name (if Other)' },
        { k: 'tracking', label: 'Tracking / CN number', required: true, full: true }
    ], async (v) => { await POST('/api/couriers/book', { ids: [r.id], courier: v.courier === 'Other' ? (v.other || 'Other') : v.courier, tracking: v.tracking }); toast('Tracking saved'); route(); }, 'Save tracking');
}
/* ---- 5. Dispatched today ---- */
async function dpToday(args, steps) {
    const d = await GET('/api/couriers/dispatch/today' + (args[1] ? '?day=' + encodeURIComponent(args[1]) : ''));
    const k = ['PostEx', 'TCS', 'Rider'].includes(args[2]) ? args[2] : 'all';
    const rows = d.rows.filter(r => k === 'all' || r.k === k);
    const sel = new Set();
    const dayI = h('input', { type: 'date', value: d.day, onchange: () => { location.hash = `#/dispatch/today/${dayI.value}/${k}`; } });
    const by = { all: d.rows.length };
    d.rows.forEach(r => { by[r.k] = (by[r.k] || 0) + 1; });
    const chips = h('div', { class: 'dp-chips' }, [['all', 'All'], ['PostEx', 'PostEx'], ['TCS', 'TCS'], ['Rider', 'Rider']].map(([c, l]) => h('button', { class: 'dp-chip' + (k === c ? ' on' : ''), onclick: () => { location.hash = `#/dispatch/today/${d.day}/${c}`; } }, l, h('span', { class: 'n' }, by[c] || 0))));
    const pickRows = () => { const s = rows.filter(r => sel.has(r.id)); return s.length ? s : rows; };
    const tag = () => sel.size ? ` (${sel.size} selected)` : '';
    const btns = h('div', { class: 'row' });
    const paintBtns = () => {
        const p = pickRows(), px = p.filter(r => r.k === 'PostEx'), tc = p.filter(r => r.k === 'TCS'), runs = [...new Set(p.filter(r => r.k === 'Rider' && r.rider_run_id).map(r => r.rider_run_id))];
        btns.replaceChildren(...[
            px.length ? h('button', { class: 'btn ghost sm', onclick: () => DP.printPostex(px.map(r => r.tracking)) }, icon('doc', 16), `PostEx airway bills (${px.length})`) : null,
            px.length ? h('button', { class: 'btn ghost sm', onclick: () => DP.loadSheet(px.map(r => r.tracking)) }, icon('list', 16), `PostEx load sheet (${px.length})`) : null,
            tc.length ? h('button', { class: 'btn ghost sm', onclick: () => CR.printLabels(tc.map(r => r.id)) }, icon('doc', 16), `TCS labels (${tc.length})`) : null,
            runs.map(id => h('button', { class: 'btn ghost sm', onclick: () => DP.runSheet(id) }, icon('doc', 16), `Run sheet #${id}`)),
            sel.size ? h('span', { class: 'small muted' }, tag().trim()) : null
        ].flat().filter(Boolean));
    };
    const shopCell = r => !d.shopifyFulfil && r.shop_ok == null ? null : r.shop_ok === 1 ? h('span', { class: 'b ok', title: 'Shopify shows the tracking number' }, 'Shopify ✓')
        : r.shop_ok === 0 ? [h('span', { class: 'b bad', title: r.shop_error || '' }, 'Shopify failed'), h('div', { class: 'dp-sub' }, r.shop_error || ''),
            h('button', { class: 'dp-link', onclick: () => act(() => POST('/api/couriers/dispatch/shopify/' + encodeURIComponent(r.id)), 'Sent to Shopify').then(() => route()) }, 'Try again')]
            : !/^gid:\/\/shopify\/Order\//.test(r.id) ? null
                : Date.now() - new Date(r.dispatched_at).getTime() < 3 * 60e3 ? h('span', { class: 'b' }, 'Shopify: sending…')
                    : [h('span', { class: 'b' }, 'Not in Shopify yet'), h('button', { class: 'dp-link', onclick: () => act(() => POST('/api/couriers/dispatch/shopify/' + encodeURIComponent(r.id)), 'Sent to Shopify').then(() => route()) }, 'Send now')];
    const cancel = r => {
        if (!confirm(`Cancel the ${r.k} booking of ${r.name} (${r.tracking})?` + (r.k === 'PostEx' && r.bk_via === 'api' ? '\nPostEx is told to cancel it.' : r.k === 'TCS' ? '\nTCS is told to cancel it.' : '') + '\nThe order goes back to the Dispatch list.'))
            return;
        act(() => POST(`/api/couriers/orders/${encodeURIComponent(r.id)}/cancel`), 'Booking cancelled — order is back on the Dispatch list').then(res => { if (res && res.shopify && !res.shopify.ok)
            toast('Shopify: ' + res.shopify.error, true); route(); }).catch(() => { });
    };
    const print = r => r.k === 'PostEx' ? DP.printPostex([r.tracking]) : r.k === 'TCS' ? CR.printLabels([r.id]) : r.rider_run_id ? DP.runSheet(r.rider_run_id) : CR.printLabels([r.id]);
    const allCk = h('input', { type: 'checkbox', 'aria-label': 'Select all', onchange: e => { rows.forEach(r => e.target.checked ? sel.add(r.id) : sel.delete(r.id)); document.querySelectorAll('.dp-tck').forEach(c => { c.checked = e.target.checked; }); paintBtns(); } });
    const row = r => {
        var _a, _b;
        return h('div', { class: 'dp-row dp-trow' }, h('div', { class: 'c-ck' }, h('input', { type: 'checkbox', class: 'dp-tck', 'aria-label': 'Select ' + r.name, onchange: e => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); paintBtns(); } })), h('div', { class: 'c-ord' }, h('div', { class: 'dp-nm' }, r.name), h('div', { class: 'dp-sub' }, 'Booked ' + dt(r.dispatched_at))), h('div', { class: 'c-cus' }, h('div', { style: { fontWeight: 600 } }, r.cust_name || '–'), h('div', { class: 'dp-sub' }, [r.city, r.phone].filter(Boolean).join(' · '))), h('div', { class: 'c-cour' }, h('span', { class: 'b ' + (r.k === 'PostEx' ? 'info' : r.k === 'TCS' ? 'accent' : 'ok') }, r.k === 'Rider' ? 'Rider' : r.k), ' ', h('span', { class: 'mono', style: { fontWeight: 600 } }, r.tracking), h('div', { class: 'dp-sub' }, statusB(r.status), r.courier_status ? ' ' + r.courier_status : ''), r.handed_at ? h('div', { class: 'dp-hand', title: 'Handed to courier by ' + (r.handed_by || '') }, icon('check', 13), ' Handed ' + dt(r.handed_at)) : null), h('div', { class: 'c-cod', style: { fontWeight: 700 } }, rs((_b = (_a = r.courier_cod) !== null && _a !== void 0 ? _a : r.cod) !== null && _b !== void 0 ? _b : r.total)), h('div', { class: 'c-shop' }, shopCell(r)), h('div', { class: 'c-act' }, h('button', { class: 'btn ghost sm', onclick: () => print(r) }, icon('doc', 15), 'Print'), r.status === 'dispatched' || (r.k === 'Rider' && ['dispatched', 'out_for_delivery'].includes(r.status)) ? h('button', { class: 'btn ghost sm', onclick: () => cancel(r) }, 'Cancel booking') : null));
    };
    paintBtns();
    render(...dpHead('today', steps), h('div', { class: 'dp-tools' }, chips, field('Day', dayI), h('span', { class: 'spacer' }), btns), rows.length ? h('div', { class: 'dp-list' }, h('div', { class: 'dp-row dp-trow hd' }, h('div', { class: 'c-ck' }, allCk), h('div', { class: 'c-ord' }, 'Order'), h('div', { class: 'c-cus' }, 'Customer'), h('div', { class: 'c-cour' }, 'Courier · tracking'), h('div', { class: 'c-cod' }, 'COD'), h('div', { class: 'c-shop' }, d.shopifyFulfil ? 'Shopify' : ''), h('div', { class: 'c-act' }, '')), rows.map(row))
        : h('div', { class: 'card dp-empty' }, d.day === todayStr() ? 'Nothing booked yet today.' : 'Nothing was booked on this day.', ' ', h('a', { href: '#/dispatch/book' }, 'Go to Book & print →')));
}
registerView({ key: 'dispatch', title: 'Dispatch desk', group: 'Dispatch', perm: 'couriers', icon: 'truck', order: 10 }, VIEWS.dispatch);
/* ---------- Rider app (phone first): my parcels today, call / WhatsApp / map, delivered / failed / later ---------- */
VIEWS.rider = async () => {
    CR.style();
    const d = await GET('/api/rider/today');
    const save = (i, b) => POST('/api/rider/items/' + i.id, b).then(() => { toast(b.result === 'delivered' ? 'Delivered ✓' : 'Saved'); VIEWS.rider(); });
    const all = d.runs.flatMap(r => r.items.map(i => (Object.assign(Object.assign({}, i), { run: r }))));
    const left = all.filter(i => !i.result).length, delivered = all.filter(i => i.result === 'delivered');
    const cash = delivered.filter(i => !i.run.handed).reduce((s, i) => s + (i.collected || 0), 0);
    const card = (i, run) => {
        const locked = run.handed || run.status === 'closed', st = i.result;
        return h('div', { class: 'cr-p' + (st ? ' done ' + (CR.cls[st] || '') : '') }, h('div', { class: 'cr-top' }, h('div', null, h('div', { class: 'small muted' }, `#${i.seq} · ${i.name}`), h('div', { class: 'cr-nm' }, i.cust_name || 'Customer')), h('div', { class: 'cod' }, st === 'delivered' ? rs(i.collected) : rs(i.cod), h('small', null, st === 'delivered' ? 'collected' : st ? 'COD' : 'collect (COD)'))), h('div', { class: 'addr' }, i.address, i.address ? ', ' : '', h('strong', null, i.city)), i.items_text ? h('div', { class: 'small muted' }, i.items_text) : null, st ? h('div', { class: 'row sp' }, h('div', null, CR.resultB(i), ' ', h('span', { class: 'small muted' }, CR.resultNote(Object.assign(Object.assign({}, i), { reason_text: d.reasons[i.reason] })))), !locked ? h('button', { class: 'btn ghost sm', onclick: () => act(() => save(i, { result: 'undo' })) }, 'Change') : h('span', { class: 'small muted' }, 'cash handed over')) : null, !st ? h('div', { class: 'cr-3' }, h('a', { class: 'cr-btn', href: 'tel:' + i.phone }, icon('phone', 20), 'Call'), h('a', { class: 'cr-btn', href: waLink(i.wa, CR.waText(i)), target: '_blank', rel: 'noopener' }, icon('megaphone', 20), 'WhatsApp'), h('a', { class: 'cr-btn', href: CR.mapLink(i), target: '_blank', rel: 'noopener' }, icon('search', 20), 'Map')) : null, !st && !locked ? h('div', { class: 'cr-3' }, h('button', { class: 'cr-btn ok', onclick: () => CR.resultModal(i, d.reasons, 'delivered', b => save(i, b)) }, 'Delivered', h('small', null, 'De diya')), h('button', { class: 'cr-btn bad', onclick: () => CR.resultModal(i, d.reasons, 'failed', b => save(i, b)) }, 'Failed', h('small', null, 'Nahi hua')), h('button', { class: 'cr-btn warn', onclick: () => CR.resultModal(i, d.reasons, 'rescheduled', b => save(i, b)) }, 'Later', h('small', null, 'Baad mein'))) : null);
    };
    const runBlock = r => {
        const todo = r.items.filter(i => !i.result), done = r.items.filter(i => i.result);
        return h('div', { class: 'grid', style: { gap: '10px' } }, h('div', { class: 'row sp' }, h('strong', null, `Run #${r.id} · ${day(r.day)}`), h('span', { class: 'small muted' }, `${r.summary.delivered} delivered · ${r.summary.failed + r.summary.rescheduled} not · ${r.summary.pending} left`)), r.status === 'open' && r.items.length ? h('button', { class: 'cr-btn main', onclick: () => act(() => POST(`/api/rider/runs/${r.id}/start`), 'Deliveries started').then(() => VIEWS.rider()) }, icon('truck', 22), 'Start deliveries', h('small', null, 'Nikalne se pehle dabayein')) : null, todo.map(i => card(i, r)), done.length ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'Done') : null, done.map(i => card(i, r)), !todo.length && r.items.length && !r.handed ? h('div', { class: 'note ok' }, 'All parcels marked. Hand over ', h('strong', null, rs(r.summary.collected)), ' cash and the parcels you brought back at the office.') : null, r.handed ? h('div', { class: 'note ok' }, '✓ Cash for this run was handed over.') : null);
    };
    render(h('div', { class: 'cr-app' }, h('div', { class: 'cr-hello' }, h('div', null, h('div', { class: 'small muted' }, new Date(d.today + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })), h('h2', null, 'Assalam o Alaikum, ' + String(ME.name || '').split(' ')[0])), h('button', { class: 'btn ghost sm', onclick: () => VIEWS.rider() }, 'Refresh')), h('div', { class: 'cr-chips' }, h('div', { class: 'cr-chip' }, h('b', null, left), h('span', null, 'to deliver')), h('div', { class: 'cr-chip' }, h('b', null, delivered.length), h('span', null, 'delivered')), h('div', { class: 'cr-chip' }, h('b', { style: { fontSize: cash >= 100000 ? '15px' : cash >= 1000 ? '18px' : '22px' } }, rs(cash)), h('span', null, 'cash with me'))), d.runs.length ? d.runs.slice().sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || (a.day > b.day) - (a.day < b.day)).map(runBlock) : h('div', { class: 'card' }, h('div', { class: 'empty' }, 'No parcels for you today. The office will give you a run.')), h('div', { class: 'small muted', style: { textAlign: 'center' } }, `Last 7 days: ${d.week.delivered || 0} delivered · ${d.week.failed || 0} not delivered`)));
};
registerView({ key: 'rider', title: 'My deliveries', group: 'Dispatch', perm: 'rider', roles: ['rider'], icon: 'truck', order: 40 }, VIEWS.rider);
registerMeCard({ key: 'rider', order: 5, perm: 'rider' }, async () => {
    const d = await GET('/api/rider/today');
    if (!d.runs.length && ME.role !== 'rider')
        return null;
    const items = d.runs.flatMap(r => r.items), left = items.filter(i => !i.result).length, del = items.filter(i => i.result === 'delivered');
    return h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'My deliveries today'), h('a', { class: 'btn primary', href: '#/rider' }, icon('truck', 16), 'Open')), h('div', { class: 'small muted', style: { marginTop: '6px' } }, items.length ? `${left} to deliver · ${del.length} delivered · cash with me ${rs(d.cashWithMe)}` : 'No run for you yet today.'));
});
/* ---------- rider runs: make runs, run sheet, cash handover, rider ledger, rider pay ---------- */
VIEWS['rider-runs'] = async (args) => {
    CR.style();
    const tab = args[0] || 'runs';
    if (tab === 'run' && args[1])
        return crRun(+args[1]);
    const head = tabs([['runs', 'Runs'], ['ledger', 'Rider cash'], ['pay', 'Rider pay']], tab, t => { location.hash = '#/rider-runs/' + t; });
    if (tab === 'ledger')
        return crLedger(head);
    if (tab === 'pay')
        return crPay(head, args[1]);
    const from = args[1] || new Date(Date.parse(todayStr()) - 13 * 864e5).toISOString().slice(0, 10);
    const [runs, riders] = await Promise.all([GET('/api/couriers/runs?' + qs({ from })), GET('/api/couriers/riders').catch(() => [])]);
    const newRun = () => {
        if (!riders.length)
            return modal('No rider login yet', h('div', null, 'Add a staff login with the role "Rider (own delivery)" in Staff & access first.'));
        formModal('New rider run', [{ k: 'rider_id', label: 'Rider', type: 'select', options: riders.map(r => [r.id, r.name]) }, { k: 'day', label: 'Date', type: 'date', value: todayStr() }, { k: 'note', label: 'Note', full: true }], async (v) => { const r = await POST('/api/couriers/runs', Object.assign(Object.assign({}, v), { rider_id: +v.rider_id })); location.hash = '#/rider-runs/run/' + r.id; }, 'Create run');
    };
    const stB = r => r.status === 'closed' ? h('span', { class: 'b ok' }, 'Cash received') : r.status === 'out' ? h('span', { class: 'b ' + (r.day < todayStr() ? 'bad' : 'warn') }, r.day < todayStr() ? 'Cash not handed over' : 'Out delivering') : h('span', { class: 'b info' }, 'Getting ready');
    render(head, pageHead('Rider runs', 'Each run = one rider, one day, a list of Karachi parcels. At the end of the day the office counts the cash and takes back the parcels that were not delivered.', h('button', { class: 'btn', onclick: newRun }, '+ New run'), h('a', { class: 'btn ghost', href: '#/dispatch/book' }, 'Book packed orders')), h('div', { class: 'card' }, table([
        { t: 'Date', f: r => h('strong', null, day(r.day)) }, { t: 'Run', f: r => '#' + r.id }, { t: 'Rider', k: 'rider' }, { t: 'Status', f: stB },
        { t: 'Parcels', n: 1, k: 'parcels' }, { t: 'Delivered', n: 1, f: r => num(r.delivered || 0) }, { t: 'Failed', n: 1, f: r => num(r.failed || 0) }, { t: 'Left', n: 1, f: r => r.pending ? h('span', { class: 'b warn' }, r.pending) : '0' },
        { t: 'Cash collected', n: 1, f: r => rs(r.collected) }, { t: 'Counted', n: 1, f: r => r.counted == null ? '–' : [rs(r.counted), r.diff ? h('div', { class: 'small ' + (r.diff < 0 ? 'neg' : 'pos') }, (r.diff < 0 ? 'short ' : 'extra ') + rs(Math.abs(r.diff))) : null] }
    ], runs, r => { location.hash = '#/rider-runs/run/' + r.id; }), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Showing runs since ', day(from), '. ', h('a', { href: '#/rider-runs/runs/' + new Date(Date.parse(from) - 60 * 864e5).toISOString().slice(0, 10) }, 'Show older'))));
};
async function crRun(id) {
    const d = await GET('/api/couriers/runs/' + id), r = d.run, s = d.summary, closed = r.status === 'closed';
    const reload = () => crRun(id);
    const flash = h('div');
    const scan = h('input', { placeholder: 'Order number + Enter', autocomplete: 'off' });
    const add = async (codes, force) => {
        try {
            const x = await POST(`/api/couriers/runs/${id}/add`, { codes, force });
            const warns = x.results.filter(z => z.warn), errs = x.results.filter(z => z.error), oks = x.results.filter(z => z.ok);
            if (warns.length && confirm(warns.map(w => w.warn).join('\n')))
                return add(warns.map(w => w.code), true);
            flash.replaceChildren(h('div', { class: 'flash ' + (errs.length ? 'bad' : 'ok') }, oks.length ? `✓ ${oks.map(o => o.order).join(', ')} added` : '', errs.length ? (oks.length ? ' · ' : '') + '✗ ' + errs.map(e => e.error).join(' · ') : ''));
            if (oks.length)
                setTimeout(reload, 700);
        }
        catch (e) {
            flash.replaceChildren(h('div', { class: 'flash bad' }, '✗ ' + e.message));
        }
    };
    scan.addEventListener('keydown', e => { if (e.key === 'Enter' && scan.value.trim()) {
        const v = scan.value.trim().split(/[\s,]+/);
        scan.value = '';
        add(v, false);
    } });
    const officeResult = (i, kind) => CR.resultModal(i, d.reasons, kind, b => POST(`/api/couriers/items/${i.id}/result`, b).then(() => { toast('Saved'); reload(); }));
    const acts = i => closed ? null : h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, i.result ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/couriers/items/${i.id}/result`, { result: 'undo' }), 'Undone').then(reload) }, 'Undo') :
        [h('button', { class: 'btn ok sm', title: 'Record for the rider', onclick: () => officeResult(i, 'delivered') }, 'Delivered'), h('button', { class: 'btn ghost sm', onclick: () => officeResult(i, 'failed') }, 'Failed'),
            h('button', { class: 'btn ghost sm', onclick: () => officeResult(i, 'rescheduled') }, 'Later'),
            h('button', { class: 'btn ghost sm', title: 'Take off this run', onclick: () => { if (confirm(`Take ${i.name} off this run?`))
                    act(() => POST(`/api/couriers/runs/${id}/remove`, { item_id: i.id }), 'Removed').then(reload); } }, '✕')]);
    // cash handover
    let hand = null;
    if (d.handover) {
        const ho = d.handover;
        hand = h('div', { class: 'card' }, h('h2', null, 'Cash handed over', h('small', null, `${dt(ho.at)} · received by ${ho.user || ''}`)), h('div', { class: 'kpis' }, kpi('Expected', rs(ho.expected)), kpi('Counted', rs(ho.counted), null, ho.diff < 0 ? 'alert' : 'good'), kpi(ho.diff < 0 ? 'Short' : ho.diff > 0 ? 'Extra' : 'Difference', rs(Math.abs(ho.diff)), ho.diff < 0 ? (ho.treat === 'recover' ? 'to recover from the rider' : 'written off as expense') : null, ho.diff < 0 ? 'alert' : '')), ho.note ? h('div', { class: 'small muted' }, 'Note: ', ho.note) : null, ho.journal_id && can('accounts') && typeof accJournal === 'function' ? h('a', { class: 'small', href: '#', onclick: e => { e.preventDefault(); accJournal(ho.journal_id, () => { }); } }, 'Accounts entry →') : null);
    }
    else if (d.canCash && r.status !== 'open') {
        const counted = h('input', { type: 'number', class: 'cr-bigin', placeholder: '0', inputmode: 'numeric', style: { width: '100%', marginTop: '4px' } }), note = h('input', { placeholder: 'Needed if cash is short or extra', style: { width: '100%' } });
        const treat = h('select', { style: { width: '100%' } }, h('option', { value: 'expense' }, 'Shortage: write off as office expense'), h('option', { value: 'recover' }, 'Shortage: recover from the rider (advance)'));
        const diffEl = h('div', { class: 'big' }, '–');
        counted.addEventListener('input', () => { const df = (+counted.value || 0) - s.collected; diffEl.textContent = counted.value === '' ? '–' : df === 0 ? 'Matches ✓' : (df < 0 ? 'Short ' : 'Extra ') + rs(Math.abs(df)); diffEl.className = 'big ' + (counted.value === '' ? '' : df < 0 ? 'neg' : df > 0 ? 'pos' : 'pos'); });
        const back = {}, notDone = d.items.filter(i => i.result !== 'delivered');
        hand = h('div', { class: 'card' }, h('h2', null, 'Receive cash and parcels from the rider'), h('div', { class: 'kpis' }, kpi('Cash expected', rs(s.collected), `${s.delivered} delivered parcels`), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Cash counted'), counted), h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Difference'), diffEl)), h('div', { class: 'two', style: { marginTop: '10px', gap: '12px' } }, field('Note', note), field('If cash is short', treat)), notDone.length ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'small' }, h('strong', null, 'Parcels coming back'), ' — returned parcels go to the Returns screen to be put back on the rack.'), table([{ t: 'Order', f: i => h('strong', null, i.name) }, { t: 'Result', f: i => [CR.resultB(i), h('div', { class: 'small muted' }, CR.resultNote(i) || (i.result ? '' : 'not marked by the rider'))] },
            { t: 'What now', f: i => { const sl = h('select', { onchange: () => { back[i.id] = sl.value; } }, h('option', { value: 'returned', selected: i.result !== 'rescheduled' }, 'Back to office → return to stock'), h('option', { value: 'kept', selected: i.result === 'rescheduled' }, 'Keep for the next run')); back[i.id] = sl.value; return sl; } }], notDone)) : null, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn primary big', onclick: () => {
                if (counted.value === '')
                    return toast('Enter the cash you counted', true);
                act(() => POST(`/api/couriers/runs/${id}/handover`, { counted: +counted.value, note: note.value, treat: treat.value, back }), 'Handover recorded').then(reload);
            } }, 'Record handover')));
    }
    else if (r.status === 'open')
        hand = h('div', { class: 'note' }, 'When the rider leaves, press "Send out". The rider can also press "Start deliveries" in the Rider app.');
    const stTxt = closed ? h('span', { class: 'b ok' }, 'Cash received') : r.status === 'out' ? h('span', { class: 'b warn' }, 'Out delivering') : h('span', { class: 'b info' }, 'Getting ready');
    render(h('div', { class: 'row', style: { marginBottom: '6px' } }, h('a', { class: 'small', href: '#/rider-runs' }, '← All runs')), pageHead(`Run #${r.id} · ${r.rider || ''}`, [day(r.day), ' ', r.day.slice(0, 4), ' · ', stTxt, r.note ? ' · ' + r.note : ''], h('button', { class: 'btn ghost', onclick: () => CR.print([CR.sheet(d)]) }, icon('doc', 16), 'Print run sheet'), r.status === 'open' && d.items.length ? h('button', { class: 'btn', onclick: () => act(() => POST(`/api/couriers/runs/${id}/out`), 'Rider is out').then(reload) }, 'Send out') : null, r.status === 'open' && !d.items.length ? h('button', { class: 'btn ghost', onclick: () => act(() => POST(`/api/couriers/runs/${id}/delete`), 'Run deleted').then(() => { location.hash = '#/rider-runs'; }) }, 'Delete run') : null), h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } }, kpi('Parcels', num(s.parcels), 'COD ' + rs(s.cod)), kpi('Delivered', num(s.delivered), rs(s.collected) + ' cash', s.delivered ? 'good' : ''), kpi('Not delivered', num(s.failed + s.rescheduled), s.rescheduled ? s.rescheduled + ' rescheduled' : null, s.failed ? 'warn' : ''), kpi('Left to deliver', num(s.pending), null, s.pending && r.day < todayStr() ? 'alert' : '')), !closed ? h('div', { class: 'card' }, h('h2', null, 'Add parcels', h('small', null, 'Karachi orders that are packed, or rider parcels kept for another try')), h('div', { class: 'scanbox' }, scan), flash) : null, h('div', { class: 'card' }, h('h2', null, 'Parcels'), table([
        { t: '#', k: 'seq' }, { t: 'Order', f: i => [h('strong', null, i.name), h('div', { class: 'small muted' }, statusB(i.status))] },
        { t: 'Customer', f: i => [i.cust_name, h('div', { class: 'small muted' }, i.phone)] }, { t: 'Address', f: i => h('span', { class: 'small' }, i.address, ', ', i.city) },
        { t: 'COD', n: 1, f: i => rs(i.cod) }, { t: 'Result', f: i => [CR.resultB(i), h('div', { class: 'small muted' }, CR.resultNote(i)), i.back ? h('div', { class: 'small' }, i.back === 'kept' ? 'kept for next run' : 'returned to office') : null] },
        { t: '', f: acts }
    ], d.items, i => openOrder(i.order_id))), hand);
    setTimeout(() => { if (!closed)
        scan.focus(); }, 50);
}
async function crLedger(head) {
    const d = await GET('/api/couriers/ledger');
    render(head, h('div', { class: 'card' }, h('h2', null, 'Cash per rider', h('small', null, 'collected from customers vs handed to the office')), table([{ t: 'Rider', f: r => h('strong', null, r.rider) }, { t: 'Runs', n: 1, k: 'runs' }, { t: 'Delivered', n: 1, f: r => num(r.delivered || 0) }, { t: 'Collected', n: 1, f: r => rs(r.collected) },
        { t: 'Handed over', n: 1, f: r => rs(r.handed) }, { t: 'Short', n: 1, f: r => r.short ? h('span', { class: 'neg' }, rs(r.short)) : '–' }, { t: 'Extra', n: 1, f: r => r.excess ? rs(r.excess) : '–' },
        { t: 'Still with rider', n: 1, f: r => h('strong', { class: r.outstanding ? 'neg' : '' }, rs(r.outstanding)) }], d.riders)), d.waiting.length ? h('div', { class: 'card' }, h('h2', null, 'Runs waiting for cash handover'), table([{ t: 'Date', f: r => day(r.day) }, { t: 'Run', f: r => '#' + r.id }, { t: 'Rider', k: 'rider' }, { t: 'Cash collected', n: 1, f: r => rs(r.collected) }, { t: 'Not marked yet', n: 1, k: 'pending' }], d.waiting, r => { location.hash = '#/rider-runs/run/' + r.id; })) : null, h('div', { class: 'card' }, h('h2', null, 'Handovers'), table([{ t: 'Date', f: r => day(r.day) }, { t: 'Rider', k: 'rider' }, { t: 'Run', f: r => '#' + r.run_id + ' · ' + day(r.run_day) }, { t: 'Expected', n: 1, f: r => rs(r.expected) }, { t: 'Counted', n: 1, f: r => rs(r.counted) },
        { t: 'Difference', n: 1, f: r => r.diff ? h('span', { class: r.diff < 0 ? 'neg' : 'pos' }, rs(r.diff)) : '–' }, { t: 'By', k: 'user' }, { t: 'Note', f: r => h('span', { class: 'small' }, r.note || '') }], d.handovers, r => { location.hash = '#/rider-runs/run/' + r.run_id; })));
}
async function crPay(head, month) {
    const m = /^\d{4}-\d{2}$/.test(month || '') ? month : monthStr();
    const d = await GET('/api/couriers/rider-fees?month=' + m);
    const mi = h('input', { type: 'month', value: m, onchange: () => { location.hash = '#/rider-runs/pay/' + mi.value; } });
    const canApprove = can('finance') || can('accounts_post') || ME.role === 'admin';
    render(head, h('div', { class: 'toolbar row' }, field('Month', mi), h('span', { class: 'small muted' }, d.rate ? `Rs ${num(d.rate)} per delivered parcel` : 'No per-delivery pay set (Couriers → Settings).')), h('div', { class: 'card' }, h('h2', null, 'Rider delivery pay', h('small', null, 'fixed salary is in HR payroll')), table([{ t: 'Rider', f: r => h('strong', null, r.rider) }, { t: 'Delivered parcels', n: 1, k: 'deliveries' }, { t: 'Rate', n: 1, f: r => rs(r.rate) }, { t: 'Amount', n: 1, f: r => h('strong', null, rs(r.amount)) },
        { t: 'Approved', f: r => r.approved ? h('span', null, h('span', { class: 'b ok' }, rs(r.approved.amount)), h('div', { class: 'small muted' }, `${r.approved.approved_name || ''} · ${r.approved.deliveries} parcels`), r.approved.deliveries !== r.deliveries ? h('div', { class: 'small neg' }, 'Changed since — approve again') : null) : '–' },
        { t: '', f: r => canApprove && r.amount > 0 && (!r.approved || r.approved.deliveries !== r.deliveries || r.approved.amount !== r.amount) ? h('button', { class: 'btn sm', onclick: () => act(() => POST('/api/couriers/rider-fees/approve', { month: m, rider_id: r.rider_id }), 'Approved and posted to accounts').then(() => route()) }, 'Approve') : null }], d.rows), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Approving posts Dr Shipping Exp / Cr Accrued Expenses for the rider. Pay it with a payment voucher (Dr Accrued Expenses, party = the rider) or together with the salary.')));
}
registerView({ key: 'rider-runs', title: 'Rider runs & cash', group: 'Dispatch', perm: 'couriers', icon: 'list', order: 20 }, VIEWS['rider-runs']);
/* ---------- couriers: dashboard, booking, parcels, settings ---------- */
VIEWS.couriers = async (args) => {
    CR.style();
    const tab = args[0] || 'dash';
    if (tab === 'book') {
        location.replace('#/dispatch/book');
        return;
    } // booking lives on the Dispatch desk now
    const list = [['dash', 'Dashboard'], ['dispatch', 'Dispatch desk →'], ['parcels', 'Booked parcels']];
    if (can('settings'))
        list.push(['settings', 'Settings']);
    const head = tabs(list, tab, t => { location.hash = t === 'dispatch' ? '#/dispatch' : '#/couriers/' + t; });
    if (tab === 'parcels')
        return crParcels(head, args);
    if (tab === 'settings' && can('settings'))
        return crSettings(head);
    return crDash(head, args);
};
async function crDash(head, args) {
    const saved = store.get('cr_period', null);
    const to = args[1] || (saved && saved.to) || todayStr(), from = args[2] || (saved && saved.from) || new Date(Date.parse(to) - 29 * 864e5).toISOString().slice(0, 10);
    const d = await GET('/api/couriers/dashboard?' + qs({ from, to }));
    const fI = h('input', { type: 'date', value: d.from }), tI = h('input', { type: 'date', value: d.to });
    const go = (f, t) => { store.set('cr_period', { from: f, to: t }); location.hash = `#/couriers/dash/${t}/${f}`; };
    const quick = (l, days) => h('button', { class: 'btn ghost sm', onclick: () => { const t = todayStr(); go(new Date(Date.parse(t) - (days - 1) * 864e5).toISOString().slice(0, 10), t); } }, l);
    const cc = c => {
        const rows = [['Parcels sent', num(c.dispatched)], ['Delivered', num(c.delivered)], ['Returned', num(c.returned)], ['Still on the way', num(c.in_transit) + (c.attempted ? ` (${c.attempted} attempted)` : '')],
            ['Average days to deliver', c.avg_days != null ? c.avg_days + ' days' : '–'], ['COD delivered, not paid yet', rs(c.cod_unpaid) + (c.cod_unpaid_n ? ` (${c.cod_unpaid_n})` : '')], [c.courier === 'Rider' ? 'Rider delivery pay' : 'Courier charges', rs(c.charges)]];
        return h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, c.courier === 'Rider' ? 'Own rider (Karachi)' : c.courier), h('span', { class: 'b ' + (c.rate == null ? '' : c.rate >= 80 ? 'ok' : c.rate >= 65 ? 'warn' : 'bad') }, c.rate == null ? 'no results yet' : c.rate + '% delivered')), h('div', { class: 'big', style: { marginTop: '6px' } }, c.rate == null ? '–' : c.rate + '%', h('span', { class: 'small muted', style: { fontSize: '12px', fontWeight: 400 } }, ' delivery rate')), h('div', { class: 'cr-rows' }, rows.map(([l, v]) => h('div', null, h('span', { class: 'muted' }, l), h('strong', null, v)))));
    };
    const rateCell = x => x ? h('span', { style: { whiteSpace: 'nowrap' } }, h('span', { class: 'b ' + (x.rate == null ? '' : x.rate >= 80 ? 'ok' : x.rate >= 65 ? 'warn' : 'bad') }, x.rate == null ? '–' : x.rate + '%'), h('span', { class: 'small muted' }, ` ${x.n}`)) : h('span', { class: 'muted' }, '–');
    render(head, h('div', { class: 'toolbar row' }, field('From', fI), field('To', tI), h('button', { class: 'btn sm', onclick: () => go(fI.value, tI.value) }, 'Show'), quick('7 days', 7), quick('30 days', 30), quick('90 days', 90), d.tcs.configured ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST('/api/couriers/tcs/sync', { kind: 'track' }), 'TCS tracking updated').then(() => route()) }, 'Update TCS now') : null), d.alerts.length ? h('div', { class: 'grid', style: { gap: '6px' } }, d.alerts.map(a => h('a', { class: 'note ' + (a.level === 'bad' ? 'bad' : a.level === 'warn' ? 'warn' : ''), href: a.href || null }, a.text))) : null, !d.tcs.configured ? h('div', { class: 'note' }, 'TCS is not connected yet. ', can('settings') ? h('a', { href: '#/couriers/settings' }, 'Add the TCS login in Settings') : 'Ask the owner to add the TCS login', ' to book TCS parcels from the ERP.') : null, h('div', { class: 'small muted' }, `Parcels sent ${day(d.from)} – ${day(d.to)}. Delivery rate = delivered ÷ (delivered + returned).`), h('div', { class: 'cr-cour' }, d.couriers.map(cc)), h('div', { class: 'card' }, h('h2', null, 'Delivery rate by city', h('small', null, 'which courier delivers best where (number = parcels sent)')), table([{ t: 'City', f: r => h('strong', null, r.city) }, { t: 'Parcels', n: 1, k: 'total' }, { t: 'PostEx', f: r => rateCell(r.PostEx) }, { t: 'TCS', f: r => rateCell(r.TCS) }, { t: 'Rider', f: r => rateCell(r.Rider) },
        { t: 'Best so far', f: r => r.best ? h('span', { class: 'b accent' }, r.best) : h('span', { class: 'small muted' }, 'not enough parcels') }], d.cities)), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Riders', h('a', { class: 'spacer small muted', href: '#/rider-runs' }, 'Runs & cash →')), table([{ t: 'Rider', f: r => h('strong', null, r.rider) }, { t: 'Days', n: 1, k: 'days' }, { t: 'Delivered', n: 1, f: r => num(r.delivered || 0) }, { t: 'Per day', n: 1, k: 'per_day' },
        { t: 'Success', n: 1, f: r => r.success == null ? '–' : h('span', { class: 'b ' + (r.success >= 85 ? 'ok' : r.success >= 70 ? 'warn' : 'bad') }, r.success + '%') },
        { t: 'Cash with rider', n: 1, f: r => h('span', { class: r.outstanding ? 'neg' : '' }, rs(r.outstanding)) }], d.riders)), h('div', { class: 'card' }, h('h2', null, 'TCS connection'), h('div', { class: 'cr-rows' }, [['Status', d.tcs.configured ? (d.tcs.failing ? h('span', { class: 'b bad' }, 'sync failing') : h('span', { class: 'b ok' }, 'connected')) : h('span', { class: 'b' }, 'not connected')],
        ['Tracking checked', d.tcs.trackAt ? dt(d.tcs.trackAt.replace(' ', 'T') + '+05:00') : 'never'], ['Payments checked', d.tcs.payAt ? dt(d.tcs.payAt.replace(' ', 'T') + '+05:00') : 'never'], ['TCS cities loaded', num(d.tcs.cities)]].map(([l, v]) => h('div', null, h('span', { class: 'muted' }, l), h('strong', null, v)))), d.tcs.last ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Last: ', d.tcs.last.message) : null, d.unknown.length ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'small' }, h('strong', null, 'TCS status texts the ERP does not know'), ' (counted as in transit):'), d.unknown.map(u => h('div', { class: 'small' }, h('span', { class: 'b warn' }, u.text), ' ', u.n, ' parcel(s)'))) : null)));
}
async function crParcels(head, args) {
    const k = ['TCS', 'PostEx', 'Rider'].includes(args[2]) ? args[2] : 'TCS', bucket = ['open', 'unpaid', 'all'].includes(args[1]) ? args[1] : 'open';
    const d = await GET('/api/couriers/parcels?' + qs({ courier: k, bucket }));
    const go = (b, c) => { location.hash = `#/couriers/parcels/${b}/${c}`; };
    const histM = async (r) => {
        const o = await GET('/api/orders/' + encodeURIComponent(r.id)).catch(() => null);
        const hs = o && o.order.courier_history ? JSON.parse(o.order.courier_history) : [];
        modal(`${r.name} · ${k} ${r.tracking}`, h('div', { class: 'grid' }, h('div', null, statusB(r.status), ' ', r.courier_status || ''), hs.length ? h('div', { class: 'timeline' }, hs.slice().reverse().map(x => h('div', null, h('div', { class: 't' }, x.at || ''), x.status, x.place ? h('span', { class: 'muted' }, ' · ' + x.place) : ''))) : h('div', { class: 'muted small' }, 'No checkpoints yet.')), [k === 'TCS' ? h('button', { class: 'btn ghost', onclick: () => act(() => POST(`/api/couriers/orders/${encodeURIComponent(r.id)}/track`), 'Updated').then(() => { var _a; (_a = document.querySelector('.modal')) === null || _a === void 0 ? void 0 : _a.remove(); route(); }) }, 'Track now') : null]);
    };
    render(head, h('div', { class: 'row sp' }, tabs([['TCS', 'TCS'], ['PostEx', 'PostEx'], ['Rider', 'Rider']], k, c => go(bucket, c)), tabs([['open', 'On the way'], ['unpaid', 'Delivered, not paid'], ['all', 'All recent']], bucket, b => go(b, k))), h('div', { class: 'card' }, table([
        { t: 'Order', f: r => h('strong', null, r.name) }, { t: 'Customer', f: r => [r.cust_name, h('div', { class: 'small muted' }, r.city)] },
        { t: k === 'TCS' ? 'CN' : 'Tracking', f: r => h('span', { class: 'mono' }, r.tracking) },
        { t: 'Status', f: r => [statusB(r.status), r.courier_status ? h('div', { class: 'small muted' }, r.courier_status) : null] },
        { t: 'Days', n: 1, f: r => { var _a; return h('span', { class: r.days > 6 && ['dispatched', 'in_transit', 'out_for_delivery', 'attempted'].includes(r.status) ? 'b bad' : '' }, (_a = r.days) !== null && _a !== void 0 ? _a : '–'); } },
        { t: 'COD', n: 1, f: r => rs(r.total) }, k === 'TCS' ? { t: 'Charges', n: 1, f: r => r.courier_fee != null ? rs(r.courier_fee) : h('span', { class: 'muted small' }, 'est.') } : null,
        { t: 'Paid', f: r => r.settled ? h('span', { class: 'b ok' }, day(r.settled_at) || 'yes') : '–' },
        { t: '', f: r => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, k === 'TCS' ? h('button', { class: 'btn ghost sm', onclick: () => CR.printLabels([r.id]) }, 'Label') : null, r.status === 'dispatched' && k !== 'Rider' ? h('button', { class: 'btn ghost sm', onclick: () => { if (confirm(`Cancel the ${k} booking of ${r.name}? The order goes back to Packed.`))
                    act(() => POST(`/api/couriers/orders/${encodeURIComponent(r.id)}/cancel`), 'Booking cancelled').then(() => route()); } }, 'Cancel') : null) }
    ].filter(Boolean), d.rows, histM)));
}
async function crSettings(head) {
    const d = await GET('/api/couriers/settings'), t = d.tcs;
    const inp = (k, ph, type) => { var _a; return h('input', { value: d.has[k] !== undefined ? '' : ((_a = t[k]) !== null && _a !== void 0 ? _a : ''), placeholder: d.has[k] ? 'saved ' + (t[k] || '') : (ph || ''), type: type || 'text', autocomplete: 'off', 'data-k': k }); };
    const F = {};
    const f = (label, k, ph, type) => { F[k] = inp(k, ph, type); return field(label, F[k]); };
    const sandbox = h('input', { type: 'checkbox', checked: !!t.sandbox });
    const fee = h('input', { type: 'number', value: d.tcsFee });
    const rFee = h('input', { type: 'number', value: d.rider.fee }), rK = h('input', { value: d.rider.karachi || '', placeholder: 'e.g. Clifton, DHA, Gulshan' }), rCash = h('input', { value: d.rider.cashAccount || 'Cash' });
    const px = d.postex, dc = d.dispatch, pxs = d.pxState;
    const pxPick = h('select', null, h('option', { value: px.pickupCode || '' }, px.pickupCode ? `${px.pickupAddress || 'Saved address'} (${px.pickupCode})` : 'Load addresses from PostEx…'));
    const pxAddrs = {};
    const loadAddr = async () => {
        try {
            const l = await GET('/api/couriers/postex/addresses');
            l.forEach(a => { pxAddrs[a.code] = a; });
            pxPick.replaceChildren(h('option', { value: '' }, l.length ? 'Choose pickup address…' : 'No pickup address in your PostEx account'), l.map(a => h('option', { value: a.code, selected: a.code === px.pickupCode }, `${a.address}${a.city ? ', ' + a.city : ''} (${a.code})`)));
        }
        catch (e) {
            toast(e.message, true);
        }
    };
    const pxW = h('input', { type: 'number', step: '0.1', min: '0.1', value: px.weight }), pxNotes = h('input', { value: px.notes || '', placeholder: 'e.g. Call before delivery. Allow open parcel.' });
    const pxType = h('select', null, ['Normal', 'Reversed', 'Replacement'].map(t => h('option', { value: t, selected: t === px.orderType }, t)));
    const dDef = h('select', null, ['PostEx', 'TCS'].map(t => h('option', { value: t, selected: t === dc.defaultCourier }, t)));
    const dKhi = h('select', null, [['Rider', 'Own rider'], ['TCS', 'TCS'], ['PostEx', 'PostEx']].map(([v, l]) => h('option', { value: v, selected: v === dc.karachiCourier }, l)));
    const dMin = h('input', { type: 'number', min: 1, value: dc.minParcels });
    const dShop = h('input', { type: 'checkbox', checked: !!dc.shopifyFulfil, style: { width: '18px', height: '18px', flex: 'none', marginTop: '2px' } });
    const dPack = h('input', { type: 'checkbox', checked: dc.packFirst !== false, style: { width: '18px', height: '18px', flex: 'none', marginTop: '2px' } });
    const save = async () => {
        const tcs = { sandbox: sandbox.checked };
        for (const [k, el] of Object.entries(F))
            tcs[k] = el.value;
        const pa = pxAddrs[pxPick.value];
        const postex = { weight: +pxW.value || 0.5, notes: pxNotes.value, orderType: pxType.value };
        if (pxPick.value !== (px.pickupCode || '') || pa)
            Object.assign(postex, { pickupCode: pxPick.value, pickupAddress: pa ? `${pa.address}${pa.city ? ', ' + pa.city : ''}` : px.pickupAddress });
        await act(() => POST('/api/couriers/settings', { tcs, tcsFee: +fee.value || 0, rider: { fee: +rFee.value || 0, karachi: rK.value, cashAccount: rCash.value }, postex,
            dispatch: { defaultCourier: dDef.value, karachiCourier: dKhi.value, minParcels: +dMin.value || 20, shopifyFulfil: dShop.checked, packFirst: dPack.checked } }), 'Saved');
        route();
    };
    const st = d.state;
    render(head, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'TCS login', h('small', null, 'from your TCS account manager')), h('div', { class: 'fgrid' }, f('Client ID', 'clientId'), f('Client secret', 'clientSecret', '', 'password'), f('Username', 'username'), f('Password', 'password', '', 'password'), f('TCS account no.', 'account', 'e.g. 123456'), f('Customer no. (payments)', 'customerNo'), f('Cost centre code', 'costCenter', 'e.g. 01'), f('Service code', 'serviceCode', 'O = Overnight')), h('label', { class: 'row small', style: { marginTop: '8px' } }, sandbox, 'Use the TCS test system (sandbox)'), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Secrets are never shown again after saving. Leave a box empty to keep what is saved.')), h('div', { class: 'card' }, h('h2', null, 'Shipper (printed on every TCS parcel)'), h('div', { class: 'fgrid' }, f('Shipper name', 'shipperName', 'SundayBazar'), f('Mobile', 'shipperMobile', '03xx xxxxxxx'), h('label', { class: 'f full' }, 'Pickup address', (F.shipperAddress = inp('shipperAddress'))), f('City', 'shipperCity', 'Karachi'), f('TCS city code (optional)', 'shipperCityCode', 'e.g. KHI'), f('Default weight (kg)', 'weight', '1', 'number'), field('Est. TCS charge / parcel (Rs)', fee)))), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Connection'), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: save }, 'Save'), h('button', { class: 'btn ghost', onclick: () => act(() => POST('/api/couriers/tcs/test')).then(r => { toast(`TCS connected · ${r.cities} cities`); route(); }) }, 'Test connection'), h('button', { class: 'btn ghost', disabled: !st.configured, onclick: () => act(() => POST('/api/couriers/tcs/sync', { kind: 'track' })).then(r => { toast(`Tracking: ${r.updated} of ${r.checked} updated`); route(); }) }, 'Sync tracking'), h('button', { class: 'btn ghost', disabled: !st.configured, onclick: () => act(() => POST('/api/couriers/tcs/sync', { kind: 'payments' })).then(r => { toast(`Payments: ${r.updated} parcels updated`); route(); }) }, 'Sync payments'))), h('div', { class: 'cr-rows' }, [['Server', st.base], ['Status', st.configured ? (st.failing ? h('span', { class: 'b bad' }, 'last sync failed') : h('span', { class: 'b ok' }, 'connected')) : 'not connected'],
        ['Last message', st.last ? `${ago(st.last.at)} · ${st.last.message}` : '–'], ['TCS cities', `${num(st.cities)}` + (st.citiesAt ? ' · loaded ' + st.citiesAt.slice(0, 16) : '')]].map(([l, v]) => h('div', null, h('span', { class: 'muted' }, l), h('strong', { style: { textAlign: 'right', wordBreak: 'break-word' } }, v)))), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Tracking updates every hour, payments once a day. Bookings go to Shopify only when "Mark orders fulfilled in Shopify" is on (Dispatch rules) — otherwise the order keeps its CN in the ERP.')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'PostEx booking', h('small', null, pxs.configured ? 'token saved in Settings → PostEx' : 'add the PostEx token in Settings → PostEx first')), h('div', { class: 'fgrid' }, h('label', { class: 'f full' }, 'Pickup address (where PostEx collects)', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pxPick, h('button', { class: 'btn ghost sm', disabled: !pxs.configured, onclick: loadAddr }, 'Load from PostEx'))), field('Weight per pair (kg)', pxW), field('Order type', pxType), h('label', { class: 'f full' }, 'Notes for the rider (every parcel)', pxNotes)), h('div', { class: 'cr-rows' }, [['PostEx cities', num(pxs.cities) + (pxs.citiesAt ? ' · loaded ' + pxs.citiesAt.slice(0, 16) : '')]].map(([l, v]) => h('div', null, h('span', { class: 'muted' }, l), h('strong', null, v)))), h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: save }, 'Save'), h('button', { class: 'btn ghost', disabled: !pxs.configured, onclick: () => act(() => POST('/api/couriers/postex/cities')).then(r => { toast(`PostEx cities: ${r.cities}`); route(); }) }, 'Load PostEx cities'))), h('div', { class: 'card' }, h('h2', null, 'Dispatch rules', h('small', null, 'which courier each order starts with')), h('div', { class: 'fgrid' }, field('Default courier', dDef), field('Karachi orders go to', dKhi), field('Use delivery rates after (parcels per courier, 90 days)', dMin)), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Other cities: when PostEx and TCS both have enough delivered/returned parcels in a city in the last 90 days, the one with the better delivery rate is picked. Staff can always change it.'), h('label', { class: 'row', style: { marginTop: '12px', alignItems: 'flex-start', flexWrap: 'nowrap' } }, dPack, h('span', null, h('strong', null, 'Book only after packing'), h('div', { class: 'small muted' }, 'On (recommended): the Dispatch desk books only packed orders — pick list → pack → book. Off: confirmed and picked orders can be booked too.'))), h('label', { class: 'row', style: { marginTop: '12px', alignItems: 'flex-start', flexWrap: 'nowrap' } }, dShop, h('span', null, h('strong', null, 'Mark orders fulfilled in Shopify with the tracking number'), h('div', { class: 'small muted' }, 'Off by default. Needs the Shopify app scopes ', h('span', { class: 'mono' }, 'read_merchant_managed_fulfillment_orders'), ' and ', h('span', { class: 'mono' }, 'write_merchant_managed_fulfillment_orders'), ' (Settings → Shopify app → Versions). The customer is not notified. If Shopify refuses, the booking stays and the error shows on Dispatch → Booked today.', d.shopify ? '' : ' Shopify is not connected yet.'))), h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: save }, 'Save')))), h('div', { class: 'card' }, h('h2', null, 'Own rider (Karachi)'), h('div', { class: 'fgrid' }, field('Pay per delivery (Rs)', rFee), field('Other names for Karachi', rK), field('Cash account', rCash)), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Pay per delivery: 0 = none. A fixed rider salary is paid through HR payroll, not here. Per-delivery pay is summed per month under Rider runs → Rider pay.'), h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: save }, 'Save'))));
}
registerView({ key: 'couriers', title: 'Couriers', group: 'Dispatch', perm: 'couriers', icon: 'truck', order: 30 }, VIEWS.couriers);
/* ---------- Messages inbox: setup screens for the owner (perm inbox_admin) ---------- */
document.head.append(h('style', { id: 'ibs-style' }, `
.ibs{display:grid;gap:14px}
.ibs-url{display:flex;gap:8px;align-items:center;background:var(--soft);border-radius:8px;padding:8px 10px;font-family:var(--mono);font-size:12.5px;word-break:break-all}
.ibs-url span{flex:1;min-width:0}
.ibs-steps{margin:0;padding-left:20px;display:grid;gap:6px;font-size:13.5px}
.ibs-code{background:var(--soft);border-radius:8px;padding:12px;font-family:var(--mono);font-size:12px;white-space:pre;overflow:auto;max-height:360px;margin:0}
.ibs-rule{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:10px}
.ibs-rule.off{opacity:.65}
.ibs-rg{display:grid;grid-template-columns:220px 100px minmax(0,1fr);gap:8px}
@media (max-width:760px){.ibs-rg{grid-template-columns:1fr 90px}.ibs-rg > :last-child{grid-column:1/-1}}
.ibs-tpl{display:grid;gap:4px;padding:10px 12px;border-radius:10px;background:var(--soft);font-size:13px}
.ibs-q{display:grid;grid-template-columns:180px minmax(0,1fr) auto;gap:8px;align-items:start}
.ibs-hook{font-size:12px;border-bottom:1px solid var(--line);padding:6px 0}
.ibs-hook pre{white-space:pre-wrap;word-break:break-all;font-size:11.5px;background:var(--soft);padding:8px;border-radius:6px;margin:6px 0 0;max-height:200px;overflow:auto}
@media (max-width:760px){.ibs-q{grid-template-columns:1fr}}
`));
const ibsChk = (label, on, sub) => { const i = h('input', { type: 'checkbox', checked: !!on }); return { el: h('label', { class: 'row', style: { gap: '8px', alignItems: 'flex-start', flexWrap: 'nowrap' } }, i, h('span', { style: { minWidth: 0 } }, label, sub ? h('div', { class: 'small muted' }, sub) : null)), get v() { return i.checked; } }; };
const ibsUrl = u => h('div', { class: 'ibs-url' }, h('span', null, u), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ibCopy(u) }, 'Copy'));
const ibsLast = (l, what) => l ? h('span', { class: 'b ' + (l.ok ? 'ok' : 'bad') }, `${what} ${ago(l.at)}${l.ok ? '' : ' (' + (l.note || 'rejected') + ')'}`) : h('span', { class: 'b warn' }, 'nothing received yet');
async function ibSettings(tab) {
    const s = await GET('/api/inbox/settings');
    const save = (body, msg = 'Saved') => act(() => POST('/api/inbox/settings', body), msg).then(() => route());
    const hooks = async (src, box) => {
        const rows = await GET('/api/inbox/hooks?src=' + src);
        box.replaceChildren(...(rows.length ? rows.slice(0, 25).map(r => {
            const pre = h('pre', { hidden: true }, r.body);
            return h('div', { class: 'ibs-hook' }, h('div', { class: 'row sp' }, h('span', null, h('span', { class: 'b ' + (r.ok ? 'ok' : 'bad') }, r.ok ? 'ok' : 'rejected'), ' ', dt(r.at), ' · ', r.note || ''), h('button', { class: 'btn sm ghost', onclick: () => { pre.hidden = !pre.hidden; } }, 'Body')), pre);
        }) : [h('div', { class: 'muted small' }, 'Nothing received yet.')]));
    };
    const pubUrl = h('input', { value: s.publicUrl, placeholder: 'https://erp.sundaybazar.pk' });
    const pubCard = h('div', { class: 'card' }, h('h2', null, 'ERP internet address', h('small', null, 'used in the webhook links below')), h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'CEQUENS, Meta and Google can only reach the ERP over the internet with https. Enter the address you open the ERP with from outside the office (now detected as ', h('span', { class: 'mono' }, s.base), ').'), /^https:\/\//.test(s.base) ? null : h('div', { class: 'note warn', style: { marginBottom: '8px' } }, 'The links below use ', h('span', { class: 'mono' }, s.base), ', which outside services cannot reach. Put the ERP on an https internet address (see README → deploy) and enter it here.'), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pubUrl, h('button', { class: 'btn', onclick: () => save({ publicUrl: pubUrl.value }) }, 'Save')));
    let body;
    if (tab === 'wa') {
        const url = h('input', { value: s.wa.url }), tok = h('input', { type: 'password', placeholder: s.wa.hasToken ? '•••••••• saved — type to replace' : 'Paste the CEQUENS API token', autocomplete: 'off' });
        const bearer = ibsChk('Send the token as "Bearer <token>"', s.wa.bearer, 'CEQUENS documents a Bearer API key. Untick only if CEQUENS says your account expects the raw token.');
        const tPhone = h('input', { placeholder: 'Your WhatsApp number 03xx…' }), tTpl = h('select', null, h('option', { value: '' }, 'Plain text (only if you messaged the business number in the last 24 h)'), s.templates.filter(t => !t.params.length).map(t => h('option', { value: t.name }, t.name)), s.templates.filter(t => t.params.length).map(t => h('option', { value: t.name }, t.name + ' (sample values)')));
        const hookBox = h('div');
        const err = s.errors.wa;
        body = [
            h('div', { class: 'card' }, h('h2', null, 'WhatsApp Business via CEQUENS', h('span', { class: 'spacer' }), s.wa.hasToken ? h('span', { class: 'b ok' }, 'connected') : h('span', { class: 'b warn' }, 'not connected')), err ? h('div', { class: 'note ' + (err.code === 402 ? 'bad' : 'warn'), style: { marginBottom: '10px' } }, 'Last error ', ago(err.at), ': ', err.msg) : null, h('div', { class: 'fgrid' }, h('label', { class: 'f full' }, 'CEQUENS API token', tok), h('label', { class: 'f full' }, 'Send API URL', url), h('div', { class: 'full' }, bearer.el)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => save({ wa: { url: url.value, token: tok.value, bearer: bearer.v } }) }, 'Save'), s.wa.hasToken ? h('button', { class: 'btn ghost', onclick: () => confirm('Disconnect WhatsApp? Messages will stop sending.') && save({ wa: { clearToken: true } }) }, 'Disconnect') : null), h('div', { class: 'small muted', style: { marginTop: '10px' } }, 'Get the token in the CEQUENS console (Settings → API token / Developers). Messages are sent with POST ', h('span', { class: 'mono' }, '/conversation/wab/v1/messages'), '.')),
            h('div', { class: 'card' }, h('h2', null, 'Incoming messages (webhook)', h('span', { class: 'spacer' }), ibsLast(s.last.cequens, 'last received')), h('ol', { class: 'ibs-steps' }, h('li', null, 'Send this link to CEQUENS support (or paste it in the console under Webhooks / Callback URL) for ', h('b', null, 'incoming messages and message status notifications'), ':'), ibsUrl(s.urls.cequens), h('li', null, 'Send yourself a WhatsApp message to the business number. It should appear under Conversations, and "last received" above turns green.'), h('li', null, 'Keep the link secret: the key in it is what proves a message really comes from CEQUENS.')), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm ghost', onclick: () => confirm('Make a new key? The old link stops working until CEQUENS gets the new one.') && save({ wa: { newKey: true } }, 'New key made') }, 'Make a new key'), h('button', { class: 'btn sm ghost', onclick: () => hooks('cequens', hookBox) }, 'Show last webhooks')), hookBox),
            h('div', { class: 'card' }, h('h2', null, 'Send a test'), h('div', { class: 'fgrid' }, field('To', tPhone), field('Message', tTpl)), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => { const t = s.templates.find(x => x.name === tTpl.value); act(() => POST('/api/inbox/settings/test-wa', { phone: tPhone.value, template: tTpl.value || undefined, lang: t && t.lang, params: t ? t.params.map(p => p.replace(/[{}]/g, '').replace(/^name$/, ME.name.split(' ')[0]).replace(/^order$/, 'SB00000')) : undefined }), 'Sent — check your phone'); } }, 'Send test'))),
            ibsTemplates(s, save),
            pubCard,
        ];
    }
    else if (tab === 'ig') {
        const i = s.ig;
        const appId = h('input', { value: i.appId, placeholder: 'e.g. 1234567890' }), sec = h('input', { type: 'password', autocomplete: 'off', placeholder: i.hasSecret ? '•••••••• saved — type to replace' : 'App secret' });
        const igId = h('input', { value: i.igId, placeholder: 'Instagram business account ID (178414…)' }), tok = h('input', { type: 'password', autocomplete: 'off', placeholder: i.hasToken ? '•••••••• saved — type to replace' : 'Long-lived access token' });
        const vt = h('input', { value: i.verifyToken }), ver = h('input', { value: i.version }), gurl = h('select', null, [['https://graph.instagram.com', 'graph.instagram.com — Instagram API with Instagram Login'], ['https://graph.facebook.com', 'graph.facebook.com — via the Facebook Page (Messenger API for Instagram)']].map(([v, l]) => h('option', { value: v, selected: i.graphUrl === v }, l)));
        if (![...gurl.options].some(o => o.value === i.graphUrl))
            gurl.append(h('option', { value: i.graphUrl, selected: true }, i.graphUrl));
        const hookBox = h('div'), err = s.errors.ig;
        body = [
            h('div', { class: 'card' }, h('h2', null, 'Instagram DMs and comments', h('span', { class: 'spacer' }), i.hasToken ? h('span', { class: 'b ok' }, 'token saved') : h('span', { class: 'b warn' }, 'not connected')), h('div', { class: 'note', style: { marginBottom: '12px' } }, 'CEQUENS shows Instagram only inside its own chat console (no API), so the ERP connects to Instagram directly through Meta.'), err ? h('div', { class: 'note warn', style: { marginBottom: '10px' } }, 'Last error ', ago(err.at), ': ', err.msg) : null, h('ol', { class: 'ibs-steps' }, h('li', null, 'Open ', h('b', null, 'developers.facebook.com'), ' → My Apps → Create app → type "Business". Use the Meta account that manages the SundayBazar Facebook Page.'), h('li', null, 'In the app, add the ', h('b', null, 'Instagram'), ' product → "API setup with Instagram login". Connect the SundayBazar Instagram ', h('b', null, 'professional (business)'), ' account.'), h('li', null, 'Generate an access token for the account (it is long-lived, ~60 days; generate again before it expires). Copy the Instagram account ID shown next to it.'), h('li', null, 'Under Webhooks, set Callback URL and Verify token to the values below, press Verify and save, then ', h('b', null, 'subscribe to the "messages" and "comments" fields'), '.'), h('li', null, 'Permissions needed: ', h('span', { class: 'mono' }, 'instagram_business_basic, instagram_business_manage_messages, instagram_business_manage_comments'), '.'), h('li', null, h('b', null, 'Meta App Review: '), 'while the app is in development mode only people with a role on the app (admins/testers) can message it. To get real customers\' DMs and reply to them, Meta usually requires App Review (and business verification) for these permissions. This can take days and Meta may ask for a screen recording.'), h('li', null, 'Copy the App ID and App secret (App settings → Basic) into the fields below and save. Then press "Test connection".'))),
            h('div', { class: 'card' }, h('h2', null, 'Webhook for Meta', h('span', { class: 'spacer' }), ibsLast(s.last.instagram, 'last received')), h('div', { class: 'grid', style: { gap: '8px' } }, h('div', { class: 'small muted' }, 'Callback URL'), ibsUrl(s.urls.instagram), h('div', { class: 'small muted' }, 'Verify token'), ibsUrl(i.verifyToken)), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm ghost', onclick: () => hooks('instagram', hookBox) }, 'Show last webhooks')), hookBox),
            h('div', { class: 'card' }, h('h2', null, 'Connection'), h('div', { class: 'fgrid' }, field('Meta App ID', appId), field('App secret', sec), field('Instagram account ID', igId), field('Access token', tok), field('Webhook verify token', vt), field('Graph API version', ver), h('label', { class: 'f full' }, 'API', gurl)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => save({ ig: { appId: appId.value, appSecret: sec.value, igId: igId.value, token: tok.value, verifyToken: vt.value, version: ver.value, graphUrl: gurl.value } }) }, 'Save'), h('button', { class: 'btn ghost', disabled: !i.hasToken, onclick: () => act(() => POST('/api/inbox/settings/test-ig')).then(r => toast('Connected: @' + (r.account.username || r.account.name || r.account.id))) }, 'Test connection'))),
            pubCard,
        ];
    }
    else if (tab === 'form') {
        const f = s.form, maps = {};
        const qList = h('datalist', { id: 'ibs-qs' }, f.questions.map(x => h('option', { value: x })));
        const rows = f.fields.map(([k, l]) => { maps[k] = h('input', { value: f.map[k] || '', placeholder: 'Question title in the form (blank = guess)', list: 'ibs-qs' }); return field(l, maps[k]); });
        const ack = ibsChk('Send a WhatsApp acknowledgement to the customer', f.ack, 'Uses the approved template below (needs WhatsApp connected).');
        const ackT = h('select', null, s.templates.map(t => h('option', { value: t.name, selected: t.name === f.ackTemplate }, t.name)));
        const script = `// SundayBazar ERP: send every exchange-form answer to the ERP
function onFormSubmit(e) {
  var url = '${s.urls.form}';
  var answers = {};
  for (var q in e.namedValues) answers[q] = e.namedValues[q].join(', ');
  var payload = {
    form: SpreadsheetApp.getActiveSpreadsheet().getName(),
    submittedAt: answers['Timestamp'] || new Date().toISOString(),
    answers: answers
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}`;
        const hookBox = h('div');
        body = [
            h('div', { class: 'card' }, h('h2', null, 'Google Form exchange requests', h('span', { class: 'spacer' }), ibsLast(s.last.form, 'last received')), h('div', { class: 'small muted', style: { marginBottom: '10px' } }, 'Each form answer becomes a "Size exchange" ticket linked to the order (found by order number like SB84561 or 84561, otherwise by phone), and shows in the inbox as a Form conversation. Sending the same answer twice is ignored.'), h('ol', { class: 'ibs-steps' }, h('li', null, 'Open the form → Responses → ', h('b', null, 'Link to Sheets'), ' (if not done yet), then open that Google Sheet.'), h('li', null, 'In the sheet: ', h('b', null, 'Extensions → Apps Script'), '. Delete what is there and paste the script below. Press Save.'), h('li', null, 'Left menu ', h('b', null, 'Triggers'), ' (clock icon) → ', h('b', null, '+ Add trigger'), ': function ', h('span', { class: 'mono' }, 'onFormSubmit'), ', event source ', h('b', null, 'From spreadsheet'), ', event type ', h('b', null, 'On form submit'), '. Save.'), h('li', null, 'Google asks you to ', h('b', null, 'authorise'), ': choose your account → Advanced → Go to project → Allow.'), h('li', null, 'Fill the form once yourself. A ticket and a Form conversation should appear, and "last received" turns green.')), h('div', { class: 'row sp', style: { margin: '12px 0 6px' } }, h('strong', null, 'Apps Script'), h('button', { class: 'btn sm', onclick: () => ibCopy(script) }, 'Copy script')), h('pre', { class: 'ibs-code' }, script), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm ghost', onclick: () => confirm('Make a new key? You must paste the script again.') && save({ form: { newKey: true } }, 'New key made') }, 'Make a new key'), h('button', { class: 'btn sm ghost', onclick: () => hooks('form', hookBox) }, 'Show last submissions (raw)')), hookBox),
            h('div', { class: 'card' }, h('h2', null, 'Which question is which', h('small', null, 'leave blank to let the ERP guess from the question wording')), qList, h('div', { class: 'fgrid' }, rows, h('div', { class: 'full' }, ack.el), field('Acknowledgement template', ackT)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => { const map = {}; for (const k in maps)
                    map[k] = maps[k].value; save({ form: { map, ack: ack.v, ackTemplate: ackT.value } }); } }, 'Save'))),
            f.recent.length ? h('div', { class: 'card' }, h('h2', null, 'Recent submissions'), table([{ t: 'Received', f: r => dt(r.at) }, { t: 'Phone', k: 'phone' }, { t: 'Ticket', f: r => r.ticket_id ? h('a', { href: '#/tickets/open/' + r.ticket_id }, 'T-' + r.ticket_id) : h('span', { class: 'b bad', title: r.error || '' }, 'no ticket') }, { t: 'Problem', f: r => r.error || '' }], f.recent)) : null,
            pubCard,
        ];
    }
    else if (tab === 'auto') {
        const a = s.auto;
        const on = ibsChk(h('b', null, 'Send automatic WhatsApp messages'), a.on, 'Checked every 5 minutes. Each message goes only once per order and event.');
        const bot = ibsChk('Let the bot confirm / cancel orders from YES / NO replies', a.bot, 'Replies like "Yes", "Haan", "Ji" confirm; "No", "Nahi", "Cancel" cancel — exactly like pressing Confirm / Cancel on the Confirmation screen. Anything else waits in the inbox for a person.');
        const qf = h('input', { type: 'number', min: 0, max: 23, value: a.quietFrom }), qt = h('input', { type: 'number', min: 0, max: 23, value: a.quietTo });
        const lim = h('input', { type: 'number', min: 0, value: a.dailyLimit }), age = h('input', { type: 'number', min: 1, value: a.maxAgeHours });
        const cr = h('textarea', null, a.confirmReply), xr = h('textarea', null, a.cancelReply);
        const tplNames = s.templates.map(t => t.name);
        const R = {};
        const ruleCards = Object.entries(a.rules).map(([k, r]) => {
            const c = ibsChk(h('b', null, r.label), r.on), tpl = h('input', { value: r.template, list: 'ibs-tpls' }), lang = h('input', { value: r.lang || 'en', style: { maxWidth: '90px' } });
            const params = h('input', { value: (r.params || []).join(', '), placeholder: '{name}, {order}' });
            R[k] = { c, tpl, lang, params };
            return h('div', { class: 'ibs-rule' + (r.on ? '' : ' off') }, c.el, h('div', { class: 'ibs-rg' }, field('Template name', tpl), field('Language', lang), field('Parameters {{1}}, {{2}}… in order', params)));
        });
        const logBox = h('div');
        const loadLog = async () => {
            const d = await GET('/api/inbox/auto/log');
            logBox.replaceChildren(h('div', { class: 'kpis', style: { marginBottom: '10px' } }, kpi('Sent today', num(s.stats.sentToday)), kpi('Queued', num(d.counts.queued || 0), s.stats.quiet ? 'quiet hours now' : 'waiting to send', d.counts.queued ? 'warn' : ''), kpi('Failed', num(d.counts.failed || 0), '', d.counts.failed ? 'alert' : ''), kpi('Bot confirmed today', num((d.bot && d.bot.confirmed) || 0), ((d.bot && d.bot.cancelled) || 0) + ' cancelled', 'good')), table([{ t: 'When', f: r => dt(r.at) }, { t: 'Order', f: r => r.order_name || r.order_id }, { t: 'Message', f: r => r.event.replace(/:.*/, '') }, { t: 'Phone', k: 'phone' },
                { t: 'Status', f: r => h('span', { class: 'b ' + ({ sent: 'ok', queued: 'warn', failed: 'bad', skipped: '' }[r.status] || '') }, r.status === 'sent' && r.msg_status && r.msg_status !== 'accepted' ? r.msg_status : r.status) }, { t: 'Note', f: r => h('span', { class: 'small muted' }, r.error || '') }], d.rows.slice(0, 60)));
        };
        body = [
            h('div', { class: 'card' }, h('h2', null, 'Automatic WhatsApp messages', h('span', { class: 'spacer' }), s.wa.hasToken ? null : h('span', { class: 'b warn' }, 'connect WhatsApp first')), h('datalist', { id: 'ibs-tpls' }, tplNames.map(n => h('option', { value: n }))), h('div', { class: 'grid', style: { gap: '10px' } }, on.el, bot.el), h('div', { class: 'fgrid', style: { marginTop: '12px' } }, field('Quiet from (hour, PK time)', qf), field('Quiet until (hour)', qt), field('Daily limit (auto messages)', lim), field('Only orders from the last … hours', age)), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'No automatic messages between these hours (default 22:00–09:00); they are queued and sent in the morning. Same number in both = no quiet hours.'), h('div', { class: 'small muted', style: { marginTop: '10px' } }, 'Parameters can use: ', h('span', { class: 'mono' }, '{name} {order} {total} {items} {tracking} {courier} {city}'), ', and ', h('span', { class: 'mono' }, '{step}'), ' (exchange) / ', h('span', { class: 'mono' }, '{amount}'), ' (refund).'), h('div', { class: 'grid', style: { gap: '10px', marginTop: '12px' } }, ruleCards), h('div', { class: 'fgrid', style: { marginTop: '12px' } }, field('Bot reply after YES (free text)', cr), field('Bot reply after NO (free text)', xr)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => {
                    const rules = {};
                    for (const [k, x] of Object.entries(R))
                        rules[k] = { on: x.c.v, template: x.tpl.value.trim(), lang: x.lang.value.trim(), params: x.params.value.split(',').map(p => p.trim()).filter(Boolean) };
                    save({ auto: { on: on.v, bot: bot.v, quietFrom: +qf.value, quietTo: +qt.value, dailyLimit: +lim.value, maxAgeHours: +age.value, confirmReply: cr.value, cancelReply: xr.value, rules } });
                } }, 'Save'), h('button', { class: 'btn ghost', disabled: !s.wa.hasToken, onclick: () => act(() => POST('/api/inbox/auto/run')).then(r => { toast(r.quiet ? `Quiet hours: ${r.queued} queued` : `Sent ${r.sent}, failed ${r.failed}${r.limit ? ' (limit reached)' : ''}`); loadLog(); }) }, 'Run now'))),
            h('div', { class: 'card' }, h('h2', null, 'Recent automatic messages'), logBox),
            ibsTemplates(s, save),
        ];
        loadLog().catch(e => logBox.replaceChildren(h('div', { class: 'flash bad' }, e.message)));
    }
    else {
        let list = s.quick.map(x => (Object.assign({}, x)));
        const box = h('div', { class: 'grid', style: { gap: '8px' } });
        const draw = () => box.replaceChildren(...list.map((x, i) => h('div', { class: 'ibs-q' }, h('input', { value: x.title, placeholder: 'Title', oninput: e => { x.title = e.target.value; } }), h('textarea', { placeholder: 'Message', style: { minHeight: '60px' }, oninput: e => { x.body = e.target.value; } }, x.body), h('button', { class: 'btn sm ghost', onclick: () => { list.splice(i, 1); draw(); } }, 'Remove'))));
        draw();
        body = [h('div', { class: 'card' }, h('h2', null, 'Quick replies', h('small', null, 'saved answers for the team; pick them in any chat')), h('div', { class: 'small muted', style: { marginBottom: '10px' } }, 'Placeholders: ', h('span', { class: 'mono' }, '{name} {order} {tracking} {courier} {total} {agent}'), ' are filled from the customer\'s latest order.'), box, h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn ghost', onclick: () => { list.push({ title: '', body: '' }); draw(); } }, '+ Add'), h('button', { class: 'btn primary', onclick: () => save({ quick: list.filter(x => x.title.trim() && x.body.trim()) }) }, 'Save')))];
    }
    if (!/^https:\/\//.test(s.base) && ['wa', 'ig', 'form'].includes(tab)) {
        body = body.filter(x => x !== pubCard);
        body.unshift(pubCard);
    }
    render(ibTabs(tab), h('div', { class: 'ibs' }, body));
}
function ibsTemplates(s, save) {
    return h('div', { class: 'card' }, h('h2', null, 'Templates to get approved', h('small', null, 'submit these in the CEQUENS console (WhatsApp → Templates), category Utility')), h('div', { class: 'small muted', style: { marginBottom: '10px' } }, 'WhatsApp only lets a business start a chat (or write after 24 hours of silence) with a template Meta has approved. Use exactly these names; you can change the wording. Language: pick English (en) for Roman Urdu text, or change the language code here if you submit it as Urdu.'), h('div', { class: 'grid', style: { gap: '8px' } }, s.templates.map(t => h('div', { class: 'ibs-tpl' }, h('div', { class: 'row sp' }, h('strong', { class: 'mono' }, t.name), h('span', { class: 'row' }, h('span', { class: 'b' }, t.lang), h('button', { class: 'btn sm ghost', onclick: () => ibCopy(t.text) }, 'Copy text'))), h('div', null, t.text), t.buttons && t.buttons.length ? h('div', { class: 'small' }, 'Quick-reply buttons: ', t.buttons.map(b => h('span', { class: 'b info', style: { marginRight: '4px' } }, b))) : null, h('div', { class: 'small muted' }, 'Parameters: ', t.params.map((p, i) => `{{${i + 1}}} = ${p}`).join(', ') || 'none')))));
}
/* ---------- Messages inbox: WhatsApp (CEQUENS), Instagram DMs + comments, Google Form exchange requests ---------- */
ICONS.chat = 'M21 12a8 8 0 01-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1121 12zM8.5 10.5h7M8.5 13.5h4.5';
document.head.append(h('style', { id: 'ib-style' }, `
.ib{display:grid;grid-template-columns:330px minmax(0,1fr) 290px;height:calc(100vh - 168px);min-height:460px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)}
.ib.noside{grid-template-columns:330px minmax(0,1fr)}
.ib-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.ib-col + .ib-col{border-left:1px solid var(--line)}
.ib-tools{padding:10px;display:grid;gap:8px;border-bottom:1px solid var(--line)}
.ib-tools input,.ib-tools select{width:100%;min-width:0}
.ib-tools .row{flex-wrap:nowrap}
.ib-seg{display:flex;gap:4px;flex-wrap:wrap}
.ib-seg a{padding:4px 10px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap;background:var(--soft)}
.ib-seg a.on{background:var(--ink);color:var(--panel)}
.ib-seg a .n{margin-left:5px;opacity:.75}
.ib-list{overflow:auto;flex:1}
.ib-item{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;align-items:start}
.ib-item:hover{background:var(--hover)} .ib-item.on{background:var(--hover);box-shadow:inset 3px 0 0 var(--accent)}
.ib-item .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ib-item.unread .nm{font-weight:800}
.ib-item .lt{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ib-item.unread .lt{color:var(--ink)}
.ib-item .rt{display:grid;justify-items:end;gap:4px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.ib-item .tags{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.ib-ch{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;letter-spacing:.02em}
.ib-ch.wa{background:var(--ok-bg);color:var(--ok)} .ib-ch.ig{background:var(--accent-soft);color:var(--accent)} .ib-ch.igc{background:var(--warn-bg);color:var(--warn)} .ib-ch.form{background:var(--info-bg);color:var(--info)}
.ib-unr{background:var(--accent);color:#fff;border-radius:999px;min-width:20px;padding:0 6px;line-height:20px;text-align:center;font-weight:700}
.ib-head{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.ib-head .who{flex:1;min-width:160px}
.ib-head .who b{font-size:15px}
.ib-head select{max-width:150px}
.ib-thread{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}
.ib-day{align-self:center;font-size:11.5px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:1px 10px;margin:6px 0}
.ib-m{max-width:min(78%,560px);padding:7px 11px 5px;border-radius:12px;font-size:13.5px;white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);align-self:flex-start}
.ib-m.out{align-self:flex-end;background:var(--ok-bg);border-color:transparent}
.ib-m.out.auto{background:var(--info-bg)}
.ib-m.failed{border:1px solid var(--bad)}
.ib-m .mt{display:flex;gap:6px;justify-content:flex-end;align-items:center;font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap;flex-wrap:wrap}
.ib-m .tk{font-weight:700;letter-spacing:-2px;padding-right:2px} .ib-m .tk.read{color:var(--info)} .ib-m .tk.failed{color:var(--bad);letter-spacing:0}
.ib-m .er{color:var(--bad);font-size:12px;margin-top:3px;white-space:normal}
.ib-m .lb{font-size:11px;font-weight:700;color:var(--muted);margin-bottom:2px;white-space:normal}
.ib-m a{color:var(--info)}
.ib-comp{border-top:1px solid var(--line);padding:10px 12px;display:grid;gap:8px;background:var(--panel)}
.ib-comp textarea{min-height:64px;max-height:200px;resize:vertical;width:100%}
.ib-comp .row{flex-wrap:wrap}
.ib-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}
.ib-prev{font-size:12.5px;background:var(--soft);border-radius:8px;padding:8px 10px;white-space:pre-wrap}
.ib-side{overflow:auto;padding:14px;display:grid;gap:12px;align-content:start}
.ib-side h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.ib-o{padding:8px 10px;border-radius:8px;background:var(--soft);display:grid;gap:2px;font-size:12.5px;cursor:pointer}
.ib-o:hover{background:var(--hover)}
.ib-empty{display:grid;place-items:center;flex:1;color:var(--muted);text-align:center;padding:30px}
.ib-back{display:none}
@media (max-width:1250px){.ib{grid-template-columns:300px minmax(0,1fr)} .ib > .ib-side{display:none} .ib-custbtn{display:inline-flex!important}}
@media (max-width:760px){
  .ib,.ib.noside{grid-template-columns:1fr;height:calc(100vh - 150px)}
  .ib.open > .ib-lcol{display:none} .ib:not(.open) > .ib-ccol{display:none}
  .ib-col + .ib-col{border-left:0}
  .ib-back{display:inline-flex}
  .ib-top.conv{display:none}
  .ib-m{max-width:88%}
  .ib-head{padding:8px 10px;gap:6px} .ib-head .who{min-width:0;flex-basis:calc(100% - 60px)}
}`));
const IB = { meta: null, F: { view: 'open', channel: '', unread: '', q: '' }, cur: null, data: null, timer: null, sig: '', listSig: '' };
const IB_CH = { wa: 'WA', ig: 'IG', igc: 'IG', form: 'F' };
const IB_CHL = { wa: 'WhatsApp', ig: 'Instagram DM', igc: 'Instagram comment', form: 'Google Form' };
async function ibMeta(force) { if (!IB.meta || force)
    IB.meta = await GET('/api/inbox/meta'); return IB.meta; }
const ibName = c => c.name || (c.handle ? '@' + c.handle : '') || c.phone || (c.channel === 'wa' ? '+' + c.ext_id : c.channel === 'form' ? 'Form request' : 'Instagram user');
const ibTime = s => { if (!s)
    return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
const ibClock = s => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const ibDay = s => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
const ibFill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => v[k] != null && v[k] !== '' ? v[k] : m);
function ibVars() {
    const d = IB.data || {}, c = d.conv || {}, cu = d.customer || {}, o = (cu.orders || []).find(x => x.id === d.order_hint) || (cu.orders || [])[0] || {};
    return { name: ((cu.customer && cu.customer.name) || c.name || '').replace(/^@/, '').split(' ')[0] || 'Sir/Madam', order: o.name || '', tracking: o.tracking || '', courier: o.courier || 'PostEx',
        total: o.total ? Math.round(o.total).toLocaleString('en-PK') : '', items: o.items_text || '', city: o.city || '', agent: ME.name, step: '', amount: '' };
}
function ibCopy(text) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => { const t = h('textarea', null, text); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copied'); }); }
function ibTabs(cur) {
    const m = IB.meta || {};
    if (!m.canAdmin)
        return null;
    return tabs([['inbox', 'Conversations'], ['wa', 'WhatsApp'], ['ig', 'Instagram'], ['form', 'Google Form'], ['auto', 'Auto messages'], ['quick', 'Quick replies']], cur, k => { location.hash = k === 'inbox' ? '#/inbox' : '#/inbox/settings/' + k; });
}
VIEWS.inbox = async (args) => {
    clearInterval(IB.timer);
    IB.sig = '';
    IB.listSig = '';
    const m = await ibMeta(true);
    if (args[0] === 'settings') {
        if (!m.canAdmin) {
            location.hash = '#/inbox';
            return;
        }
        return ibSettings(args[1] || 'wa');
    }
    IB.cur = args[0] === 'c' && args[1] ? +args[1] : null;
    IB.data = null;
    const box = h('div', { class: 'ib' + (IB.cur ? ' open' : '') });
    const q = h('input', { placeholder: 'Search name, phone, @handle, message…', value: IB.F.q, type: 'search' });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') {
        IB.F.q = q.value.trim();
        loadList();
    } });
    q.addEventListener('search', () => { if (!q.value) {
        IB.F.q = '';
        loadList();
    } });
    if (m.allowed && IB.F.channel && !m.allowed.includes(IB.F.channel))
        IB.F.channel = '';
    const chSel = h('select', { title: 'Channel' }, h('option', { value: '' }, m.allowed ? 'All my channels' : 'All channels'), Object.entries(IB_CHL).filter(([k]) => !m.allowed || m.allowed.includes(k)).map(([k, l]) => h('option', { value: k, selected: IB.F.channel === k }, l)));
    chSel.addEventListener('change', () => { IB.F.channel = chSel.value; loadList(); });
    const unr = h('label', { class: 'row small', style: { whiteSpace: 'nowrap', gap: '4px' } }, h('input', { type: 'checkbox', checked: IB.F.unread === '1', onchange: e => { IB.F.unread = e.target.checked ? '1' : ''; loadList(); } }), 'Unread');
    const seg = h('div', { class: 'ib-seg' }), listEl = h('div', { class: 'ib-list' });
    const left = h('div', { class: 'ib-col ib-lcol' }, h('div', { class: 'ib-tools' }, q, h('div', { class: 'row' }, chSel, unr), seg), listEl);
    const center = h('div', { class: 'ib-col ib-ccol' }), side = h('div', { class: 'ib-col ib-side' });
    box.append(left, center, side);
    async function loadList() {
        const d = await GET('/api/inbox?' + qs(IB.F));
        const sig = JSON.stringify([d.counts, d.rows.map(r => [r.id, r.last_at, r.unread, r.status, r.assignee])]);
        if (sig === IB.listSig)
            return;
        IB.listSig = sig;
        seg.replaceChildren(...[['open', 'Open', d.counts.open], ['mine', 'Mine', d.counts.mine], ['unassigned', 'Unassigned', d.counts.unassigned], ['pending', 'Pending', d.counts.pending], ['closed', 'Closed']].map(([k, l, n]) => h('a', { class: IB.F.view === k ? 'on' : '', onclick: () => { IB.F.view = k; loadList(); } }, l, n ? h('span', { class: 'n' }, n) : null)));
        listEl.replaceChildren(...(d.rows.length ? d.rows.map(r => h('div', { class: 'ib-item' + (r.id === IB.cur ? ' on' : '') + (r.unread ? ' unread' : ''), onclick: () => { location.hash = '#/inbox/c/' + r.id; } }, h('div', { class: 'ib-ch ' + r.channel, title: IB_CHL[r.channel] }, IB_CH[r.channel]), h('div', { style: { minWidth: 0 } }, h('div', { class: 'nm' }, ibName(r)), h('div', { class: 'lt' }, r.last_dir === 'out' ? 'You: ' : '', r.last_text || ''), h('div', { class: 'tags' }, r.channel === 'igc' ? h('span', { class: 'b warn' }, 'comment') : null, r.channel === 'form' ? h('span', { class: 'b info' }, 'exchange form') : null, r.status === 'pending' ? h('span', { class: 'b' }, 'pending') : null, r.status === 'closed' ? h('span', { class: 'b' }, 'closed') : null, r.waiting ? h('span', { class: 'b bad' }, 'waiting 1h+') : null, r.assignee_name ? h('span', { class: 'b' }, r.assignee_name) : null)), h('div', { class: 'rt' }, ibTime(r.last_at), r.unread ? h('span', { class: 'ib-unr' }, r.unread) : null)))
            : [h('div', { class: 'empty' }, IB.F.view === 'mine' ? 'Nothing assigned to you.' : IB.F.q ? 'No match.' : 'No conversations here yet.')]));
    }
    render(h('div', { class: 'ib-top' + (IB.cur ? ' conv' : '') }, ibTabs('inbox'), h('div', { class: 'row sp', style: { margin: '0 0 10px' } }, (() => {
        const al = m.allowed, useWa = !al || al.includes('wa'), useIg = !al || al.includes('ig'), miss = [useWa && !m.channels.wa ? 'WhatsApp not connected. ' : null, useIg && !m.channels.ig ? 'Instagram not connected. ' : null].filter(Boolean);
        return h('div', { class: 'small muted' }, miss.join(''), miss.length ? (m.canAdmin ? h('a', { href: '#/inbox/settings/' + (m.channels.wa ? 'ig' : 'wa') }, 'Set up') : 'Ask the owner to connect it.')
            : al ? (useWa ? 'Your messages: WhatsApp and Google Form exchange requests.' : 'Your messages: Instagram DMs and comments.') : 'Replies, Instagram comments and exchange forms in one place.');
    })(), !m.allowed || m.allowed.includes('wa') ? h('button', { class: 'btn sm', onclick: ibNewChat, disabled: !m.channels.wa }, '+ New WhatsApp') : null)), box);
    if (window.innerWidth > 1250 && !IB.cur)
        box.classList.add('noside');
    await loadList();
    const fit = () => { if (document.body.contains(box))
        box.style.height = Math.max(window.innerWidth > 760 ? 460 : 380, window.innerHeight - box.getBoundingClientRect().top - window.scrollY - (window.innerWidth > 760 ? 18 : 8)) + 'px'; };
    fit();
    window.onresize = fit;
    if (IB.cur) {
        await ibOpen(center, side, box);
        IB.listSig = '';
        await loadList();
    }
    else
        center.append(h('div', { class: 'ib-empty' }, h('div', null, icon('chat', 34), h('div', { style: { marginTop: '8px' } }, 'Pick a conversation on the left.'))));
    IB.timer = setInterval(async () => {
        if (CURRENT !== 'inbox' || !document.body.contains(box))
            return clearInterval(IB.timer);
        try {
            await loadList();
            if (IB.cur)
                await ibRefresh();
        }
        catch (_a) { }
    }, 10000);
};
async function ibOpen(center, side, box) {
    const d = await GET('/api/inbox/c/' + IB.cur);
    IB.data = d;
    IB.sig = ibSig(d);
    const c = d.conv, m = IB.meta;
    const thread = h('div', { class: 'ib-thread' }), comp = h('div', { class: 'ib-comp' });
    IB.thread = thread;
    IB.center = center;
    IB.side = side;
    IB.comp = comp;
    const reload = () => route();
    const post = (path, body, msg) => act(() => POST(`/api/inbox/c/${c.id}/${path}`, body), msg).then(reload);
    const asSel = h('select', { title: 'Assigned to' }, h('option', { value: '' }, 'Unassigned'), m.agents.map(a => h('option', { value: a.id, selected: a.id === c.assignee }, a.name)));
    asSel.addEventListener('change', () => post('assign', { user_id: asSel.value ? +asSel.value : null }, 'Assigned'));
    const stB = c.status === 'closed' ? h('button', { class: 'btn sm ghost', onclick: () => post('status', { status: 'open' }, 'Reopened') }, 'Reopen')
        : [c.status === 'pending' ? h('button', { class: 'btn sm ghost', onclick: () => post('status', { status: 'open' }) }, 'Mark open') : h('button', { class: 'btn sm ghost', title: 'Waiting for the customer', onclick: () => post('status', { status: 'pending' }, 'Marked pending') }, 'Pending'),
            h('button', { class: 'btn sm ok', onclick: () => post('status', { status: 'closed' }, 'Closed') }, icon('check', 14), 'Close')];
    const orderId = d.order_hint;
    center.replaceChildren(h('div', { class: 'ib-head' }, h('a', { class: 'btn sm ghost ib-back', href: '#/inbox' }, '‹'), h('div', { class: 'who' }, h('b', null, ibName(c)), ' ', c.status !== 'open' ? h('span', { class: 'b' }, c.status) : null, h('div', { class: 'small muted' }, IB_CHL[c.channel], c.phone ? ' · ' + c.phone : '', c.handle && c.name && c.channel !== 'wa' ? ' · @' + c.handle : '', c.channel === 'wa' ? [' · ', c.window ? h('span', { class: 'b ok' }, 'reply window open') : h('span', { class: 'b warn' }, 'template only')] : '')), asSel, stB, h('button', { class: 'btn sm ghost', onclick: () => ibTicket(c, d) }, icon('ticket', 14), c.ticket_id ? 'Ticket T-' + c.ticket_id : 'Create ticket'), orderId && m.canOrders ? h('button', { class: 'btn sm ghost', onclick: () => openOrder(orderId) }, 'Open order') : null, h('button', { class: 'btn sm ghost ib-custbtn', style: { display: 'none' }, onclick: () => { const dr = drawer([]); ibSide(dr.firstChild, d, true); } }, icon('user', 14), 'Customer')), thread, comp);
    ibThread(thread, d.msgs);
    ibComposer(comp, d);
    ibSide(side, d);
    box.classList.remove('noside');
    thread.scrollTop = thread.scrollHeight;
}
const ibSig = d => JSON.stringify([d.msgs.length, d.msgs.map(x => x.id + x.status).slice(-30), d.conv.status, d.conv.assignee, d.conv.window]);
async function ibRefresh() {
    const d = await GET('/api/inbox/c/' + IB.cur);
    const s = ibSig(d);
    if (s === IB.sig)
        return;
    const winChanged = !IB.data || IB.data.conv.window !== d.conv.window;
    IB.sig = s;
    IB.data = d;
    const t = IB.thread, atEnd = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
    ibThread(t, d.msgs);
    if (atEnd)
        t.scrollTop = t.scrollHeight;
    if (winChanged)
        ibComposer(IB.comp, d);
}
function ibTick(m) {
    if (m.dir !== 'out' || !m.status || m.status === 'received')
        return null;
    const T = { pending: ['🕓', 'Sending…'], accepted: ['✓', 'Accepted by CEQUENS'], sent: ['✓', 'Sent'], delivered: ['✓✓', 'Delivered'], read: ['✓✓', 'Read'], failed: ['✕', 'Failed'], deleted: ['⊘', 'Deleted'] };
    const [g, t] = T[m.status] || ['', m.status];
    return h('span', { class: 'tk ' + m.status, title: t }, g);
}
function ibThread(el, msgs) {
    let lastDay = '';
    const AUTO = { confirm: 'Auto: order confirmation', dispatched: 'Auto: dispatched', attempted: 'Auto: delivery attempted', delivered: 'Auto: delivered', exchange: 'Auto: exchange update', refund: 'Auto: refund', bot: 'Bot reply', form: 'Auto: form received' };
    el.replaceChildren(...(msgs.length ? [] : [h('div', { class: 'ib-empty' }, 'No messages yet.')]), ...msgs.flatMap(m => {
        const dd = ibDay(m.at), out = [];
        if (dd !== lastDay) {
            out.push(h('div', { class: 'ib-day' }, dd));
            lastDay = dd;
        }
        const lab = m.auto ? AUTO[m.auto] || 'Auto' : m.bot ? (m.bot === 'confirmed' ? '✓ Bot confirmed the order' : '✕ Bot cancelled the order') : m.kind === 'template' ? 'Template' : m.kind === 'comment' && m.dir === 'in' ? 'Comment' : m.kind === 'form' ? 'Exchange form' : m.note || null;
        const media = m.media ? h('div', null, h('a', { href: m.media, target: '_blank', rel: 'noopener' }, m.kind === 'image' ? '📷 View image' : m.kind === 'location' ? '📍 Open map' : m.kind === 'form' ? '📎 Photos link' : '📎 Open ' + m.kind)) : (['image', 'audio', 'video', 'document', 'sticker'].includes(m.kind) && !m.media ? h('div', { class: 'small muted' }, `[${m.kind} — open WhatsApp to view]`) : null);
        out.push(h('div', { class: 'ib-m ' + m.dir + (m.auto || m.bot ? ' auto' : '') + (m.status === 'failed' ? ' failed' : '') }, lab ? h('div', { class: 'lb' }, lab) : null, m.body || null, media, m.error ? h('div', { class: 'er' }, m.error) : null, h('div', { class: 'mt' }, m.dir === 'out' && (m.user || m.auto || !m.note) ? h('span', null, m.user || 'System') : null, h('span', null, ibClock(m.at)), ibTick(m))));
        return out;
    }));
}
function ibComposer(el, d) {
    const c = d.conv, m = IB.meta, v = ibVars();
    const quickSel = h('select', { title: 'Quick replies' }, h('option', { value: '' }, 'Quick reply…'), m.quick.map((x, i) => h('option', { value: i }, x.title)));
    const text = h('textarea', { placeholder: c.channel === 'igc' ? 'Write a reply to the comment…' : 'Type a message…  (Ctrl+Enter to send)' });
    quickSel.addEventListener('change', () => { if (quickSel.value !== '') {
        text.value = ibFill(m.quick[+quickSel.value].body, ibVars());
        text.focus();
        quickSel.value = '';
    } });
    const send = async (body, btn) => { if (btn)
        btn.disabled = true; try {
        await act(() => POST(`/api/inbox/c/${c.id}/reply`, body), 'Sent');
        text.value = '';
        IB.sig = '';
        await ibRefresh();
        IB.thread.scrollTop = IB.thread.scrollHeight;
    }
    catch (_a) { }
    finally {
        if (btn)
            btn.disabled = false;
    } };
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        el.querySelector('.ib-send') && el.querySelector('.ib-send').click();
    } });
    if (c.channel === 'form') {
        el.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'This came from the Google Form. A ticket was created for it.'), c.phone ? h('button', { class: 'btn sm ok', onclick: () => ibWa(d) }, 'WhatsApp customer') : null, c.ticket_id && m.canTickets ? h('a', { class: 'btn sm', href: '#/tickets/open/' + c.ticket_id }, 'Open ticket T-' + c.ticket_id) : null));
        return;
    }
    if (c.channel === 'wa') {
        let tplMode = !c.window;
        const draw = () => {
            if (!tplMode) {
                el.replaceChildren(text, h('div', { class: 'row' }, quickSel, h('button', { class: 'btn sm ghost', onclick: () => { tplMode = true; draw(); } }, 'Send template'), h('span', { class: 'grow' }), h('button', { class: 'btn primary ib-send', onclick: e => send({ text: text.value }, e.currentTarget) }, 'Send')));
                return;
            }
            const tSel = h('select', null, m.templates.map((t, i) => h('option', { value: i, selected: t.name === 'customer_care_followup' }, t.name)));
            const pBox = h('div', { class: 'ib-params' }), prev = h('div', { class: 'ib-prev' });
            let inputs = [];
            const drawT = () => {
                const t = m.templates[+tSel.value] || { params: [] }, vv = ibVars();
                inputs = t.params.map((p, i) => h('input', { value: ibFill(p, vv).replace(/\{\w+\}/g, ''), placeholder: p.replace(/[{}]/g, ''), oninput: upd }));
                pBox.replaceChildren(...inputs.map((inp, i) => field(`{{${i + 1}}} ${t.params[i].replace(/[{}]/g, '')}`, inp)));
                upd();
            };
            function upd() { const t = m.templates[+tSel.value] || {}; prev.textContent = String(t.text || '').replace(/\{\{(\d+)\}\}/g, (x, n) => (inputs[n - 1] && inputs[n - 1].value) || x) + (t.buttons && t.buttons.length ? '\n[ ' + t.buttons.join(' ]  [ ') + ' ]' : ''); }
            tSel.addEventListener('change', drawT);
            el.replaceChildren(c.window ? null : h('div', { class: 'note warn' }, 'The 24-hour reply window is closed (the customer has not written in the last 24 hours). WhatsApp only allows an approved template now. When they reply, you can type freely again.'), h('div', { class: 'row' }, field('Template', tSel)), pBox, prev, h('div', { class: 'row' }, c.window ? h('button', { class: 'btn sm ghost', onclick: () => { tplMode = false; draw(); } }, 'Back to text') : null, h('span', { class: 'grow' }), h('button', { class: 'btn primary ib-send', onclick: e => { const t = m.templates[+tSel.value]; if (inputs.some(i => !i.value.trim()))
                    return toast('Fill every template field', true); send({ template: t.name, lang: t.lang, params: inputs.map(i => i.value.trim()), order_id: d.order_hint }, e.currentTarget); } }, 'Send template')));
            drawT();
        };
        draw();
        return;
    }
    if (c.channel === 'ig') {
        el.replaceChildren(text, h('div', { class: 'row' }, quickSel, h('span', { class: 'small muted grow' }, 'Instagram allows replies within 24 hours of the customer\'s last message.'), h('button', { class: 'btn primary ib-send', onclick: e => send({ text: text.value }, e.currentTarget) }, 'Send')));
        return;
    }
    el.replaceChildren(text, h('div', { class: 'row' }, quickSel, h('span', { class: 'grow' }), h('button', { class: 'btn ghost', title: 'Sends a direct message to this person about their comment', onclick: e => send({ text: text.value, mode: 'private' }, e.currentTarget) }, 'Reply privately (DM)'), h('button', { class: 'btn primary ib-send', title: 'Everyone can see a public reply', onclick: e => send({ text: text.value, mode: 'public' }, e.currentTarget) }, 'Reply publicly')));
}
function ibSide(el, d, inDrawer) {
    const c = d.conv, cu = d.customer, m = IB.meta;
    const kids = [];
    if (inDrawer)
        kids.push(h('div', { class: 'row sp' }, h('strong', null, 'Customer'), h('button', { class: 'btn ghost sm', onclick: () => el.closest('.drawer').remove() }, 'Close')));
    kids.push(h('div', null, h('div', { style: { fontWeight: 700, fontSize: '15px' } }, (cu && cu.customer && cu.customer.name) || ibName(c)), h('div', { class: 'small muted' }, c.phone || (c.handle ? '@' + c.handle : IB_CHL[c.channel])), cu && cu.customer ? h('div', { class: 'row', style: { marginTop: '6px' } }, labelB(cu.customer.label), h('span', { class: 'small muted' }, `${cu.customer.orders} orders · ${hist(cu.customer.delivered, cu.customer.returned)}`)) : null));
    if (c.channel !== 'wa' && c.phone && !inDrawer && (!IB.meta.allowed || IB.meta.allowed.includes('wa')))
        kids.push(h('div', { class: 'row' }, h('button', { class: 'btn sm ok', onclick: () => ibWa(d) }, d.wa_conv ? 'Open WhatsApp chat' : 'WhatsApp customer')));
    if (c.channel === 'ig' || c.channel === 'igc') {
        const ph = h('input', { placeholder: '03xx xxxxxxx', value: c.phone && !/•/.test(c.phone) ? c.phone : '', inputmode: 'tel' });
        kids.push(h('div', { class: 'grid', style: { gap: '6px' } }, h('h3', null, 'Phone number'), h('div', { class: 'small muted' }, 'Link the customer\'s phone to see their orders.'), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, ph, h('button', { class: 'btn sm', onclick: () => act(() => POST(`/api/inbox/c/${c.id}/phone`, { phone: ph.value }), 'Linked').then(() => route()) }, 'Link'))));
    }
    if (cu) {
        kids.push(h('h3', null, 'Orders', cu.orders.length ? ` (${cu.orders.length})` : ''));
        kids.push(cu.orders.length ? h('div', { class: 'grid', style: { gap: '6px' } }, cu.orders.slice(0, 12).map(o => h('div', { class: 'ib-o', onclick: () => m.canOrders ? openOrder(o.id) : null, title: m.canOrders ? 'Open order' : '' }, h('div', { class: 'row sp' }, h('strong', null, o.name), statusB(o.status)), h('div', { class: 'muted' }, day(o.created_at), ' · ', rs(o.total), o.city ? ' · ' + o.city : ''), o.items_text ? h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, o.items_text) : null, o.tracking ? h('div', { class: 'muted' }, (o.courier || 'PostEx') + ' ', h('span', { class: 'mono' }, o.tracking), o.px_status ? ' · ' + o.px_status : '') : null))) : h('div', { class: 'small muted' }, 'No orders with this number.'));
        if (cu.tickets.length)
            kids.push(h('h3', null, 'Tickets'), h('div', { class: 'grid', style: { gap: '6px' } }, cu.tickets.slice(0, 8).map(t => h(m.canTickets ? 'a' : 'div', { class: 'ib-o', href: m.canTickets ? '#/tickets/open/' + t.id : null, style: { textDecoration: 'none' } }, h('div', { class: 'row sp' }, h('strong', null, 'T-' + t.id + ' · ' + t.type), h('span', { class: 'b ' + (['resolved', 'closed'].includes(t.status) ? 'ok' : 'info') }, t.status)), h('div', { class: 'muted' }, day(t.created_at), t.order_name ? ' · ' + t.order_name : '')))));
    }
    else if (c.channel === 'wa')
        kids.push(h('div', { class: 'small muted' }, 'No customer data.'));
    el.replaceChildren(...kids);
}
async function ibWa(d) {
    if (d.wa_conv) {
        location.hash = '#/inbox/c/' + d.wa_conv;
        return;
    }
    const r = await act(() => POST('/api/inbox/open-wa', { phone: (d.customer && d.customer.phone) || d.conv.phone, name: d.conv.name }));
    location.hash = '#/inbox/c/' + r.id;
}
function ibNewChat() {
    formModal('New WhatsApp conversation', [{ k: 'phone', label: 'Mobile number', placeholder: '03xx xxxxxxx', required: true }, { k: 'name', label: 'Name (optional)' }], async (v) => { const r = await POST('/api/inbox/open-wa', v); location.hash = '#/inbox/c/' + r.id; }, 'Start');
}
function ibTicket(c, d) {
    if (c.ticket_id && IB.meta.canTickets) {
        location.hash = '#/tickets/open/' + c.ticket_id;
        return;
    }
    const orders = (d.customer && d.customer.orders) || [];
    const last = d.msgs.filter(x => x.dir === 'in').slice(-5).map(x => x.body).filter(Boolean).join('\n');
    formModal('Create ticket', [
        { k: 'type', label: 'Type', type: 'select', options: IB.meta.ticketTypes, value: c.channel === 'form' ? 'Size exchange' : 'Order inquiry' },
        { k: 'order_id', label: 'Order', type: 'select', options: [['', 'No order']].concat(orders.map(o => [o.id, `${o.name} · ${(META.statuses || {})[o.status] || o.status}`])), value: d.order_hint || '' },
        { k: 'priority', label: 'Priority', type: 'select', options: [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent'], ['low', 'Low']], value: 'normal' },
        { k: 'note', label: 'Customer message / note', type: 'textarea', value: last },
    ], async (v) => { const r = await POST(`/api/inbox/c/${c.id}/ticket`, v); toast('Ticket T-' + r.id + ' created'); route(); }, 'Create ticket');
}
registerView({ key: 'inbox', title: 'Messages', group: 'Orders & CS', perm: 'inbox', icon: 'chat', order: 10 }, VIEWS.inbox);
/* ---------- Abandoned carts: Shopify checkouts that did not become orders (Simra: WhatsApp / call them) ---------- */
document.head.append(h('style', { id: 'ab-style' }, `
.ab-list{display:grid;gap:10px}
.ab-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:8px 14px}
.ab-card.late{border-left:4px solid var(--warn)}
.ab-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.ab-top strong{font-size:15px}
.ab-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;color:var(--muted)}
.ab-meta a{color:inherit}
.ab-items{grid-column:1/-1;display:grid;gap:6px}
.ab-it{display:flex;gap:10px;align-items:center;font-size:13px}
.ab-it img,.ab-it .ph{width:40px;height:40px;border-radius:8px;object-fit:cover;background:var(--soft);flex:none;border:1px solid var(--line)}
.ab-it .t{flex:1;min-width:0}
.ab-it .t div:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.ab-it.so .t div:first-child{text-decoration:line-through;color:var(--muted)}
.ab-val{text-align:right}
.ab-val .v{font-size:17px;font-weight:700}
.ab-act{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-top:1px dashed var(--line);padding-top:8px}
.ab-act .spacer{flex:1}
.ab-status{grid-column:1/-1;font-size:13px}
.ab-setup{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px}
@media (max-width:640px){.ab-kpis{grid-template-columns:1fr 1fr;gap:8px}.ab-kpis .kpi{padding:10px 12px}.ab-kpis .kpi .v{font-size:20px}.ab-card{padding:11px 12px}.ab-act .btn{flex:1 1 auto;justify-content:center}.ab-act .spacer{display:none}}
`));
const AB = { q: '' };
VIEWS.abandoned = async (args) => {
    const tab = ['new', 'contacted', 'recovered', 'lost'].includes(args[0]) ? args[0] : 'new';
    const d = await GET('/api/abandoned?' + qs({ tab, q: AB.q }));
    const C = d.counts, st = d.stats, su = d.setup;
    const go = t => { location.hash = '#/abandoned/' + t; };
    const reload = () => VIEWS.abandoned([tab]);
    const head = tabs([['new', 'New', C.new], ['contacted', 'Contacted', C.contacted], ['recovered', 'Recovered', C.recovered], ['lost', 'Lost', C.lost]], tab, go);
    const kp = h('div', { class: 'kpis ab-kpis' }, kpi('Waiting for contact', num(C.new), st.late ? `${st.late} waiting 3+ hours` : 'older than 30 min', st.late ? 'warn' : ''), kpi('I contacted today', num(st.myToday), 'WhatsApp + calls'), kpi('Recovered this month', num(st.recoveredMonth), rs(st.recoveredValue) + (st.chasedMonth ? ` · ${Math.round(100 * st.recoveredMonth / st.chasedMonth)}% of carts chased` : ''), st.recoveredMonth ? 'good' : ''), kpi('Recovered by me', num(st.mineMonth), rs(st.mineValue) + ' this month', st.mineMonth ? 'good' : ''));
    const search = h('input', { type: 'search', placeholder: 'Search name, phone, item, SKU, city…', value: AB.q, style: { flex: '1', minWidth: '160px' } });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') {
        AB.q = search.value.trim();
        reload();
    } });
    search.addEventListener('search', () => { if (!search.value) {
        AB.q = '';
        reload();
    } });
    const ls = su.lastSync;
    const syncTxt = su.demo ? 'Practice data' : !su.shopify ? 'Shopify not connected' : ls ? (ls.ok ? 'Synced ' + ago(ls.at) : 'Sync failed: ' + ls.error) : 'Not synced yet';
    const bar = h('div', { class: 'ab-setup' }, h('div', { class: 'row', style: { flex: '1', minWidth: '220px' } }, search), h('div', { class: 'row' }, h('span', { class: 'small ' + (ls && !ls.ok ? 'neg' : 'muted') }, syncTxt), h('button', { class: 'btn ghost sm', disabled: !su.shopify && !su.demo, onclick: async (e) => { e.target.disabled = true; try {
            const r = await act(() => POST('/api/abandoned/sync'), null);
            toast(r.demo ? 'Practice data: nothing to fetch' : `Fetched ${r.fetched} checkouts${r.recovered ? ' · ' + r.recovered + ' recovered' : ''}`);
            reload();
        }
        catch (_a) {
            e.target.disabled = false;
        } } }, icon('swap', 14), 'Sync now'), su.canSetup ? h('button', { class: 'btn ghost sm', onclick: () => abSetup(su) }, icon('gear', 14), 'Setup') : null));
    const list = h('div', { class: 'ab-list' }, d.rows.length ? d.rows.map(r => abCard(r, tab, d, reload)) : h('div', { class: 'card empty' }, tab === 'new' ? (AB.q ? 'No match.' : 'No abandoned carts waiting. New ones appear 30 minutes after the customer leaves checkout.') : tab === 'contacted' ? 'Nobody contacted yet.' : tab === 'recovered' ? 'No recovered carts yet.' : 'No lost carts.'));
    render(kp, bar, head, tab === 'new' && d.rows.length ? h('div', { class: 'small muted', style: { margin: '-4px 0 8px' } }, 'Oldest first. Carts with a sold-out pair are marked: don\'t chase those.') : null, list);
};
function abCard(r, tab, d, reload) {
    const lateMin = (Date.now() - new Date(r.updated_at.replace(' ', 'T') + 'Z')) / 60000;
    const items = h('div', { class: 'ab-items' }, r.items.map(it => h('div', { class: 'ab-it' + (it.soldOut ? ' so' : '') }, it.image ? h('img', { src: it.image, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(h('span', { class: 'ph' })) }) : h('span', { class: 'ph' }), h('div', { class: 't' }, h('div', null, it.title), h('div', { class: 'small muted' }, [it.sku ? h('span', { class: 'mono' }, it.sku) : null, it.size ? ' · Size ' + it.size : '', it.qty > 1 ? ' · ×' + it.qty : '', ' · ', rs(it.price)])), it.soldOut ? h('span', { class: 'b bad' }, 'Sold out') : null)));
    const statusLine = [];
    if (r.contacted_name)
        statusLine.push(h('span', null, 'Last contact: ', h('strong', null, r.contacted_name), ' · ', ago(r.contacted_at), r.contacts > 1 ? ` · ${r.contacts} times` : '', r.outcome_label ? [' · ', h('span', { class: 'b ' + (r.last_outcome === 'will_order' ? 'ok' : 'warn') }, r.outcome_label)] : ''));
    if (r.note)
        statusLine.push(h('div', { class: 'muted' }, '“', r.note, '”'));
    if (tab === 'recovered')
        statusLine.push(h('div', null, h('span', { class: 'b ok' }, 'Recovered'), ' ', r.recovered_name ? h('strong', null, r.recovered_name) : 'Order placed', ' · ', rs(r.recovered_value), ' · ', ago(r.recovered_at), r.recovered_name_by ? [' · credited to ', h('strong', null, r.recovered_name_by)] : '', r.recovered_how ? h('span', { class: 'muted' }, ' (' + r.recovered_how + ')') : ''));
    if (tab === 'lost')
        statusLine.push(h('div', null, h('span', { class: 'b' }, 'Lost'), ' ', r.lost_reason || '', r.lost_by_name ? ' · by ' + r.lost_by_name : '', r.lost_at ? ' · ' + ago(r.lost_at) : ''));
    const open = tab === 'new' || tab === 'contacted';
    const acts = h('div', { class: 'ab-act' }, open ? h('button', { class: 'btn ok sm', disabled: !r.phone, title: r.phone ? 'Send WhatsApp with the checkout link' : 'No phone number', onclick: () => abWhatsApp(r, reload) }, icon('phone', 14), 'WhatsApp') : null, open && r.phone ? h('a', { class: 'btn ghost sm', href: 'tel:' + r.phone }, 'Call') : null, open ? h('button', { class: 'btn sm', onclick: () => abCalled(r, d, reload) }, 'Called') : null, h('button', { class: 'btn ghost sm', onclick: () => abNote(r, reload) }, 'Note'), h('span', { class: 'spacer' }), r.url && open ? h('a', { class: 'btn ghost sm', href: r.url, target: '_blank', rel: 'noopener' }, 'Checkout link') : null, open ? h('button', { class: 'btn ghost sm', style: { color: 'var(--bad)' }, onclick: () => abLost(r, d, reload) }, 'Lost') : null, tab === 'lost' ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/abandoned/c/${encodeURIComponent(r.id)}/reopen`), 'Reopened').then(reload) }, 'Reopen') : null);
    return h('div', { class: 'ab-card' + (tab === 'new' && lateMin > 180 ? ' late' : '') }, h('div', null, h('div', { class: 'ab-top' }, h('strong', null, r.name || r.email || 'No name'), h('span', { class: 'small muted' }, ago(r.updated_at)), r.allSoldOut ? h('span', { class: 'b bad' }, 'All items sold out') : r.anySoldOut ? h('span', { class: 'b warn' }, 'Some items sold out') : null), h('div', { class: 'ab-meta' }, r.phone ? h('a', { href: 'tel:' + r.phone, class: 'mono' }, r.phone) : h('span', null, 'no phone'), r.city ? h('span', null, r.city) : null, r.email ? h('span', null, r.email) : null)), h('div', { class: 'ab-val' }, h('div', { class: 'v' }, rs(r.total)), h('div', { class: 'small muted' }, num(r.items.reduce((s, i) => s + (i.qty || 1), 0)) + ' item' + (r.items.length > 1 ? 's' : ''))), items, statusLine.length ? h('div', { class: 'ab-status' }, statusLine) : null, acts);
}
async function abWhatsApp(r, reload) {
    if (r.allSoldOut && !confirm('Every pair in this cart is already sold out. Message the customer anyway?'))
        return;
    const win = window.open('', '_blank'); // open now (popup blockers allow it only straight after the tap)
    try {
        const x = await POST(`/api/abandoned/c/${encodeURIComponent(r.id)}/whatsapp`);
        if (x.sent) {
            if (win)
                win.close();
            toast('WhatsApp template sent');
        }
        else if (win)
            win.location = x.link;
        else
            location.href = x.link;
        reload();
    }
    catch (e) {
        if (win)
            win.close();
        toast(e.message, true);
    }
}
function abCalled(r, d, reload) {
    formModal('Called ' + (r.name || r.phone), [
        { k: 'outcome', label: 'What did the customer say?', type: 'select', options: Object.entries(d.outcomes), value: 'will_order', required: true },
        { k: 'note', label: 'Note (optional)', type: 'textarea', placeholder: 'e.g. will order tonight, wants size 42' }
    ], async (v) => { const x = await POST(`/api/abandoned/c/${encodeURIComponent(r.id)}/call`, v); toast(x.lost ? 'Saved · moved to Lost' : 'Saved'); reload(); }, 'Save');
}
function abNote(r, reload) {
    formModal('Note', [{ k: 'note', label: 'Note', type: 'textarea', value: r.note || '', required: true }], async (v) => { await POST(`/api/abandoned/c/${encodeURIComponent(r.id)}/note`, v); toast('Saved'); reload(); });
}
function abLost(r, d, reload) {
    formModal('Mark as lost', [{ k: 'reason', label: 'Why?', type: 'select', options: r.allSoldOut ? ['Item sold out', ...d.lostReasons.filter(x => x !== 'Item sold out')] : d.lostReasons, required: true }], async (v) => { await POST(`/api/abandoned/c/${encodeURIComponent(r.id)}/lost`, v); toast('Moved to Lost'); reload(); }, 'Mark lost');
}
async function abSetup(su) {
    const s = await GET('/api/abandoned/settings');
    const m = formModal('Abandoned carts setup', [
        { k: 'waMessage', label: 'WhatsApp message (wa.me). {name} {items} {link} {total} are filled in', type: 'textarea', value: s.waMessage },
        { k: 'waTemplate', label: su.cequens ? 'CEQUENS template name (optional: sends from the business number with {name}, {items}, {link})' : 'CEQUENS template name (WhatsApp not connected yet: wa.me link is used)', value: s.waTemplate, placeholder: 'e.g. abandoned_cart', full: true },
        { k: 'webhookSecret', label: s.hasSecret ? 'Webhook signing secret (saved; type to replace)' : 'Webhook signing secret (only if made in Shopify → Notifications → Webhooks; app webhooks use the client secret)', placeholder: s.hasSecret ? '••••••••' : '', full: true }
    ], async (v) => { await POST('/api/abandoned/settings', v); toast('Saved'); }, 'Save');
    m.querySelector('.fgrid').append(h('div', { class: 'note full small' }, h('strong', null, 'Shopify webhooks: '), 'Shopify Admin → Settings → Notifications → Webhooks → Create webhook. Event ', h('span', { class: 'mono' }, 'Checkout creation'), ' and ', h('span', { class: 'mono' }, 'Checkout update'), ' (and ', h('span', { class: 'mono' }, 'Order creation'), ' for exact matching), format JSON, URL:', h('div', { class: 'mono', style: { wordBreak: 'break-all', marginTop: '4px' } }, su.hookUrl), su.lastHook ? h('div', { class: 'muted', style: { marginTop: '4px' } }, 'Last webhook: ', su.lastHook.topic || '', ' · ', ago(su.lastHook.at)) : h('div', { class: 'muted', style: { marginTop: '4px' } }, 'No webhook received yet. The 30-minute sync still works without it.')));
}
registerView({ key: 'abandoned', title: 'Abandoned carts', group: 'Orders & CS', perm: 'abandoned', icon: 'cart', order: 35 }, VIEWS.abandoned);
/* ---------- warehouse: Returns (receive returned parcels). Pick & pack moved to the Dispatch desk; the old tabs stay reachable by URL. ---------- */
VIEWS.warehouse = async (args) => {
    let tab = args[0] || 'returns';
    const go = t => { tab = t; location.hash = '#/warehouse/' + t; };
    const tabsEl = tabs([['returns', 'Returns'], ['putaway', 'Put away / move'], ['pick', 'Pick (old)'], ['pack', 'Pack (old)']], tab, go);
    const toDesk = can('couriers') ? h('div', { class: 'note', style: { margin: '10px 0' } }, 'Picking, packing and booking now happen on one screen: ', h('a', { href: '#/dispatch/' + (tab === 'pack' ? 'pack' : 'pick') }, 'Dispatch desk →')) : null;
    const head = tab === 'pick' || tab === 'pack' ? [tabsEl, toDesk] : tabsEl;
    const flash = h('div');
    const say = (msg, cls) => { flash.replaceChildren(h('div', { class: 'flash ' + cls }, msg)); };
    const scan = (ph, onCode) => { const i = h('input', { placeholder: ph, autocomplete: 'off' }); i.addEventListener('keydown', e => { if (e.key === 'Enter' && i.value.trim()) {
        const v = i.value.trim();
        i.value = '';
        onCode(v);
    } }); setTimeout(() => i.focus(), 50); return h('div', { class: 'scanbox' }, i); };
    if (tab === 'pick') {
        const d = await GET('/api/pick');
        const byLoc = {};
        d.items.forEach(i => { var _a; (byLoc[_a = i.location || '–'] || (byLoc[_a] = [])).push(i); });
        const done = d.items.filter(i => i.picked).length;
        render(head, h('div', { class: 'card noprint' }, h('h2', null, 'Scan each shoe as you take it from the rack'), scan('Scan or type SKU, then Enter', async (code) => {
            try {
                const r = await POST('/api/pick/scan', { code });
                say(`✓ ${r.item.sku} → ${r.order.name}` + (r.left ? ` (${r.left} more item${r.left > 1 ? 's' : ''} in this order)` : ' · order complete, ready to pack'), 'ok');
                setTimeout(() => VIEWS.warehouse(['pick']).then(() => { }), 900);
            }
            catch (e) {
                say('✗ ' + e.message, 'bad');
            }
        }), flash), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Pick list', h('small', null, `${done} of ${d.items.length} picked · ${d.orders.length} orders · sorted by rack`)), h('button', { class: 'btn ghost sm noprint', onclick: () => print() }, 'Print')), Object.keys(byLoc).length ? Object.entries(byLoc).map(([loc, items]) => h('div', { style: { marginBottom: '12px' } }, h('div', { class: 'mono', style: { fontWeight: 700, margin: '6px 0' } }, 'Rack ' + loc), table([{ t: '✓', f: r => h('input', { type: 'checkbox', checked: !!r.picked, onchange: e => act(() => POST('/api/pick/item/' + r.id, { picked: e.target.checked ? 1 : 0 })) }) },
            { t: 'SKU', f: r => h('span', { class: 'mono' }, r.sku) }, { t: 'Item', f: r => [r.title, r.size ? h('span', { class: 'muted small' }, ' · ' + r.size) : ''] }, { t: 'Order', f: r => [r.name, r.missing ? h('span', { class: 'b bad' }, ' missing') : ''] }], items))) : h('div', { class: 'empty' }, 'Nothing to pick. Confirmed orders show up here.')), d.orders.length ? h('div', { class: 'card noprint' }, h('h2', null, 'Orders being picked'), table([{ t: 'Order', k: 'name' }, { t: 'Placed', f: r => dt(r.created_at) }, { t: 'Picked', f: r => `${r.picked || 0} / ${r.items}` },
            { t: '', f: r => h('button', { class: 'btn sm ' + (r.missing ? 'ok' : 'bad'), onclick: () => act(() => POST(`/api/orders/${encodeURIComponent(r.id)}/missing`, { missing: !r.missing, note: r.missing ? '' : prompt('What is missing?') || '' }), 'Saved').then(() => VIEWS.warehouse(['pick'])) }, r.missing ? 'Found it' : 'Item missing') }], d.orders, r => openOrder(r.id))) : null);
    }
    else if (tab === 'pack') {
        const d = await GET('/api/pick');
        render(head, h('div', { class: 'card' }, h('h2', null, 'Scan the order number on the packing slip'), scan('Order number (e.g. SB85006)', async (code) => {
            try {
                const r = await POST('/api/pack/scan', { code });
                say('✓ ' + r.order.name + ' packed. Book it on the Dispatch desk.', 'ok');
                setTimeout(() => VIEWS.warehouse(['pack']), 900);
            }
            catch (e) {
                if (/not picked/.test(e.message) && confirm(e.message + '. Pack anyway?')) {
                    await act(() => POST('/api/pack/scan', { code, force: true }), 'Packed');
                    VIEWS.warehouse(['pack']);
                }
                else
                    say('✗ ' + e.message, 'bad');
            }
        }), flash), h('div', { class: 'card' }, h('h2', null, 'Packed, waiting for courier booking', h('small', null, d.packQueue.length + ' orders')), table([{ t: 'Order', k: 'name' }, { t: 'Placed', f: r => dt(r.created_at) }, { t: 'Items', n: 1, k: 'items' }, { t: 'City', k: 'city' }], d.packQueue, r => openOrder(r.id)), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Book packed orders on the Dispatch desk (Book & print). Once booked, the order moves to Tracking.')));
    }
    else if (tab === 'returns') {
        const d = await GET('/api/returns');
        const cond = h('select', null, [['good', 'Good: back on sale'], ['damaged', 'Damaged: do not restock']].map(([v, l]) => h('option', { value: v }, l)));
        const loc = h('input', { placeholder: 'Rack / slot for restock (optional)' });
        render(head, h('div', { class: 'card' }, h('h2', null, 'Receive a returned parcel'), h('div', { class: 'row', style: { marginBottom: '8px' } }, cond, loc), scan('Scan tracking number or order number', async (code) => {
            try {
                const r = await POST('/api/returns/receive', { code, cond: cond.value, location: loc.value });
                const errs = r.results.filter(x => x.error);
                say(`✓ ${r.order.name} received · ${r.results.length} item(s) ${cond.value === 'good' ? 'restocked' : 'marked damaged'}` + (errs.length ? ' · Shopify stock not updated: ' + errs[0].error : ''), errs.length ? 'warn' : 'ok');
                setTimeout(() => VIEWS.warehouse(['returns']), 1200);
            }
            catch (e) {
                say('✗ ' + e.message, 'bad');
            }
        }), flash), h('div', { class: 'card' }, h('h2', null, 'Coming back', h('small', null, d.pending.length + ' parcels')), table([{ t: 'Order', k: 'name' }, { t: 'Customer', f: r => [r.cust_name, h('div', { class: 'small muted' }, r.city)] }, { t: 'Tracking', f: r => h('span', { class: 'mono' }, r.tracking) }, { t: 'Status', f: r => statusB(r.status) }, { t: 'Since', f: r => day(r.returned_at) }, { t: 'Value', n: 1, f: r => rs(r.total) }], d.pending, r => openOrder(r.order_id || r.id))), h('div', { class: 'card' }, h('h2', null, 'Recently received'), table([{ t: 'When', f: r => dt(r.at) }, { t: 'Order', k: 'name' }, { t: 'SKU', f: r => h('span', { class: 'mono' }, r.sku) }, { t: 'Condition', k: 'cond' }, { t: 'Restocked', f: r => r.restocked ? 'yes' : 'no' }, { t: 'By', k: 'user' }, { t: 'Note', k: 'note' }], d.recent)));
    }
    else {
        let sku = null;
        const log = h('div');
        const st = h('div', { class: 'flash warn' }, 'Step 1: scan the shoe (SKU)');
        render(head, h('div', { class: 'card' }, h('h2', null, 'Put a shoe in a rack slot'), st, h('div', { style: { margin: '10px 0' } }, scan('Scan SKU, then scan the rack slot label', async (code) => {
            if (!sku) {
                sku = code.toUpperCase();
                st.className = 'flash info';
                st.textContent = `Step 2: scan the rack slot for ${sku}`;
                return;
            }
            try {
                const r = await POST('/api/locations', { sku, location: code });
                log.prepend(h('div', { class: 'small', style: { padding: '4px 0' } }, `✓ ${r.sku} → ${r.location}`, r.product ? h('span', { class: 'muted' }, ' · ' + r.product.title) : h('span', { class: 'b warn' }, ' not found in Shopify')));
            }
            catch (e) {
                toast(e.message, true);
            }
            sku = null;
            st.className = 'flash warn';
            st.textContent = 'Step 1: scan the shoe (SKU)';
        })), log), h('div', { class: 'small muted' }, 'Without a slot, the rack letters at the start of the SKU are used (e.g. EO-B-89582 → rack EO). Use this when a shoe is moved to a different slot.'));
    }
};
registerView({ key: 'warehouse', title: 'Returns', group: 'Warehouse', perm: 'warehouse', icon: 'swap', order: 60 }, VIEWS.warehouse);
/* ---------- inventory ---------- */
VIEWS.inventory = async (args) => {
    let tab = args[0] || 'items';
    const head = tabs([['items', 'Items'], ['racks', 'Racks']], tab, t => { location.hash = '#/inventory/' + t; });
    if (tab === 'racks') {
        const r = await GET('/api/racks');
        return render(head, h('div', { class: 'card' }, table([{ t: 'Rack / slot', f: x => h('strong', { class: 'mono' }, x.rack) }, { t: 'Items', n: 1, f: x => num(x.items) }, { t: 'Value', n: 1, f: x => rs(x.value) }, { t: 'Oldest item', f: x => day(x.oldest) }], r, x => { location.hash = '#/inventory/items'; setTimeout(() => { const i = document.querySelector('#rackf'); if (i) {
            i.value = x.rack;
            i.dispatchEvent(new Event('change'));
        } }, 300); })));
    }
    const f = { q: '', rack: '', lot: '', age: '', noloc: '', instock: '1', page: 1 };
    const box = h('div'), sumEl = h('div', { class: 'small muted' });
    const qi = h('input', { placeholder: 'Search SKU, title, brand, tag', class: 'grow' }), rk = h('input', { id: 'rackf', placeholder: 'Rack', style: { width: '90px' } });
    const ag = h('select', null, [['', 'Any age'], ['30', 'Older than 30 days'], ['60', 'Older than 60 days'], ['90', 'Older than 90 days']].map(([v, l]) => h('option', { value: v }, l)));
    const nl = h('select', null, [['', 'All'], ['1', 'No slot recorded']].map(([v, l]) => h('option', { value: v }, l)));
    const sk = h('select', null, [['1', 'In stock'], ['0', 'Include sold']].map(([v, l]) => h('option', { value: v }, l)));
    const load = async () => {
        Object.assign(f, { q: qi.value, rack: rk.value, age: ag.value, noloc: nl.value, instock: sk.value });
        const d = await GET('/api/inventory?' + qs(f));
        sumEl.textContent = `${num(d.total)} items · price value ${rs(d.value)} · cost ${rs(d.cost)}`;
        box.replaceChildren(table([
            { t: '', f: r => r.image ? h('img', { class: 'thumb', src: r.image, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb' }) },
            { t: 'SKU', f: r => h('span', { class: 'mono' }, r.sku) }, { t: 'Item', f: r => [r.title, h('div', { class: 'small muted' }, [r.size, r.cond, r.lot].filter(Boolean).join(' · '))] },
            { t: 'Price', n: 1, f: r => [rs(r.price), r.compare_at ? h('div', { class: 'small muted' }, 'was ' + rs(r.compare_at)) : ''] }, { t: 'Cost', n: 1, f: r => rs(r.cost) },
            { t: 'Age', n: 1, f: r => h('span', { class: r.age > 90 ? 'b bad' : r.age > 60 ? 'b warn' : '' }, r.age + 'd') },
            { t: 'Slot', f: r => can('inventory') ? h('button', { class: 'btn ghost sm mono', onclick: async () => { const v = prompt('Rack / slot for ' + r.sku, r.loc || r.rack || ''); if (v) {
                        await act(() => POST('/api/locations', { sku: r.sku, location: v, reason: 'move' }), 'Saved');
                        load();
                    } } }, r.loc || (r.rack ? r.rack + ' (SKU)' : 'set')) : (r.loc || r.rack) },
            { t: 'Stock', f: r => r.qty > 0 ? h('span', { class: 'b ok' }, 'in stock') : h('span', { class: 'b' }, 'sold') }
        ], d.rows), pager(d, p => { f.page = p; load(); }));
    };
    [rk, ag, nl, sk].forEach(x => x.addEventListener('change', () => { f.page = 1; load(); }));
    qi.addEventListener('keydown', e => { if (e.key === 'Enter') {
        f.page = 1;
        load();
    } });
    render(head, h('div', { class: 'card' }, h('div', { class: 'row' }, qi, rk, ag, nl, sk), h('div', { style: { margin: '8px 0' } }, sumEl), box));
    await load();
};
registerView({ key: 'inventory', title: 'Inventory', group: 'Warehouse', perm: 'inventory', icon: 'grid', order: 30 }, VIEWS.inventory);
/* ---------- WMS shared helpers (racks, receiving, counts, damage, overview) ---------- */
const WMS_SLOT_RE = /^([A-Z0-9]+)-R(\d+)-C(\d+)-L(\d+)$/;
const WMS_DEST = { OUTLET: 'Outlet', REPAIR: 'Repair', SUPPLIER: 'Return to supplier', STUDIO: 'Photo studio' };
(function wmsCss() {
    if (document.getElementById('wms-css'))
        return;
    const s = document.createElement('style');
    s.id = 'wms-css';
    s.textContent = `
.wms-quick{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.wms-quick a{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:var(--r);background:var(--panel);border:1px solid var(--line);font-weight:600;text-decoration:none;box-shadow:var(--shadow)}
.wms-quick a:hover{background:var(--hover)} .wms-quick a .ic{color:var(--accent)}
.wms-scan input{font-size:20px;padding:14px 16px;min-width:0;width:100%} .wms-top{flex-wrap:wrap;gap:8px}
.wms-now{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:var(--r);background:var(--soft);border:1px solid var(--line);flex-wrap:wrap}
.wms-now .code{font-family:var(--mono);font-size:24px;font-weight:800;letter-spacing:.02em}
.wms-now.set{background:var(--ok-bg);border-color:transparent} .wms-now.set .code{color:var(--ok)}
.wms-log{max-height:52vh;overflow:auto} .wms-log>div{padding:8px 2px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.wms-log .w{color:var(--warn);font-size:12.5px;font-weight:600} .wms-log .e{color:var(--bad);font-size:12.5px;font-weight:600}
.wms-chips{display:flex;gap:6px;flex-wrap:wrap}
.wms-chip{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 12px;cursor:pointer;font-weight:600;font-size:13px;display:inline-flex;gap:6px;align-items:center}
.wms-chip.on{background:var(--brand2);color:#fff;border-color:transparent} .wms-chip .m{font-weight:500;opacity:.7;font-size:11.5px}
.wms-chip.done{background:var(--ok-bg);color:var(--ok);border-color:transparent}
.wms-map{border-collapse:separate;border-spacing:6px}
.wms-map th{font-size:11px;color:var(--muted);font-weight:600;text-align:center;padding:0 2px}
.wms-cell{display:flex;flex-direction:column;gap:3px;min-width:70px}
.wms-lv{border-radius:6px;padding:4px 7px;font-size:12px;border:1px solid var(--line);background:var(--soft);cursor:pointer;display:flex;justify-content:space-between;gap:6px;user-select:none;font-variant-numeric:tabular-nums}
.wms-lv.part{background:var(--ok-bg);color:var(--ok);border-color:transparent}
.wms-lv.full{background:var(--warn-bg);color:var(--warn);border-color:transparent}
.wms-lv.over{background:var(--bad-bg);color:var(--bad);border-color:transparent}
.wms-lv.off{opacity:.45;border-style:dashed}
.wms-lv.sel{outline:2px solid var(--accent);outline-offset:1px}
.wms-lv.dim{opacity:.25}
.wms-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)} .wms-legend span{display:inline-flex;gap:5px;align-items:center}
.wms-legend i{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid var(--line)}
.wms-dest{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.wms-dest button{padding:14px;border-radius:var(--r);border:1px solid var(--line);background:var(--panel);font-weight:700;cursor:pointer}
.wms-dest button.on{background:var(--brand2);color:#fff;border-color:transparent}
.wms-hbar{display:grid;grid-template-columns:110px 1fr 70px;gap:8px;align-items:center;font-size:13px;margin:6px 0}
.wms-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px} .wms-kv dt{color:var(--muted)} .wms-kv dd{margin:0;font-weight:600}
@media (max-width:600px){.wms-k.kpis{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px} .wms-k .kpi .s{white-space:normal} .wms-k .kpi{padding:10px 12px} .wms-k .kpi .v{font-size:20px} .wms-now .code{font-size:20px} .wms-quick{grid-template-columns:1fr 1fr} .wms-hbar{grid-template-columns:90px 1fr 56px}}
`;
    document.head.append(s);
})();
let WMS_AC = null;
function wmsBeep(ok) { try {
    WMS_AC = WMS_AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = WMS_AC.createOscillator(), g = WMS_AC.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = .08;
    o.connect(g);
    g.connect(WMS_AC.destination);
    o.start();
    o.stop(WMS_AC.currentTime + (ok ? .08 : .3));
}
catch (_a) { } }
// Big scan box: USB scanners type the code + Enter. Keeps focus so the next scan goes in.
function wmsScan(ph, onCode) {
    const i = h('input', { placeholder: ph, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go' });
    let busy = false;
    const go = async () => { const v = i.value.trim(); if (!v || busy)
        return; i.value = ''; busy = true; try {
        await onCode(v.toUpperCase());
    }
    finally {
        busy = false;
        i.focus();
    } };
    i.addEventListener('keydown', e => { if (e.key === 'Enter') {
        e.preventDefault();
        go();
    } });
    setTimeout(() => i.focus(), 60);
    const box = h('div', { class: 'scanbox wms-scan' }, i, h('button', { class: 'btn', onclick: go }, 'OK'));
    box.input = i;
    return box;
}
const wmsIsSlot = c => WMS_SLOT_RE.test(String(c || '').toUpperCase());
const wmsSku = s => h('span', { class: 'mono' }, s);
const wmsLvCls = (n, cap, active) => (!active ? 'off ' : '') + (!n ? '' : n > cap ? 'over' : n >= cap ? 'full' : 'part');
const wmsBack = (href, label) => h('a', { class: 'btn ghost sm', href }, '‹ ' + (label || 'Back'));
const wmsStatusB = { not_received: ['Not received', 'bad'], received: ['Received', 'info'], listing: ['Listing in progress', 'warn'], fully_listed: ['Fully listed', 'ok'] };
function wmsPeopleSelect(list, cur, blank) { return h('select', null, blank ? h('option', { value: '' }, blank) : null, list.map(p => h('option', { value: p.id, selected: String(p.id) === String(cur || '') }, p.name))); }
const wmsFill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false).map(k => k instanceof Node ? k : document.createTextNode(String(k))));
// marker so the WMS-only rule below can stop wide tables from stretching the page on phones
const wmsRender = (...kids) => render(h('i', { class: 'wms-page', hidden: true }), ...kids.flat(Infinity).filter(k => k != null && k !== false));
document.getElementById('wms-css').textContent += '.content:has(>.wms-page)>*{min-width:0} .wms-page~* td .mono{white-space:nowrap}';
/* ---------- Stock counts (cycle counts), missing list, count schedule ---------- */
VIEWS.counts = async (args) => {
    const tab = args[0] || 'list';
    if (tab === 'c')
        return wmsCount(args[1]);
    const d = await GET('/api/wms/counts');
    const due = d.due.filter(r => r.due);
    const head = tabs([['list', 'Counts', d.counts.filter(c => ['open', 'counting', 'review'].includes(c.status)).length], ['due', 'Counts due', due.length], ['missing', 'Missing list', d.missingOpen], ['schedule', 'Schedule']], tab, k => { location.hash = '#/counts/' + k; });
    const newBtn = h('button', { class: 'btn', onclick: () => wmsNewCount(d) }, '+ New count');
    if (tab === 'due')
        return wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Racks to count', h('small', null, `every rack is counted every ${d.settings.countEvery} days`)), newBtn), table([{ t: 'Rack', f: r => h('strong', { class: 'mono' }, r.rack) }, { t: 'Last counted', f: r => r.last ? day(r.last) : h('span', { class: 'muted' }, 'never') }, { t: 'Days', n: 1, f: r => { var _a; return (_a = r.days) !== null && _a !== void 0 ? _a : '–'; } },
            { t: 'Status', f: r => r.open ? h('span', { class: 'b info' }, 'count in progress') : r.due ? h('span', { class: 'b warn' }, 'due') : h('span', { class: 'b ok' }, 'ok') },
            { t: '', f: r => r.due ? h('button', { class: 'btn sm', onclick: () => wmsNewCount(d, r.rack) }, 'Create count') : '' }], d.due)));
    if (tab === 'missing')
        return wmsMissing(head);
    if (tab === 'schedule') {
        const inp = { countEvery: h('input', { type: 'number', value: d.settings.countEvery }), stuckDays: h('input', { type: 'number', value: d.settings.stuckDays }), stuckPct: h('input', { type: 'number', value: d.settings.stuckPct }), varianceAlert: h('input', { type: 'number', value: d.settings.varianceAlert }), defaultCapacity: h('input', { type: 'number', value: d.settings.defaultCapacity }) };
        return wmsRender(head, h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h2', null, 'Warehouse settings'), h('div', { class: 'fgrid' }, field('Count every rack every N days', inp.countEvery), field('Alert when count has N+ missing pairs', inp.varianceAlert), field('Lot stuck after N days…', inp.stuckDays), field('…with less than % listed', inp.stuckPct), field('Default slot capacity (pairs)', inp.defaultCapacity)), h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => act(() => POST('/api/wms/settings', Object.fromEntries(Object.entries(inp).map(([k, i]) => [k, i.value]))), 'Saved') }, 'Save'))));
    }
    const SB = { open: ['Not started', 'info'], counting: ['Counting', 'warn'], review: ['To approve', 'accent'], done: ['Approved', 'ok'], cancelled: ['Cancelled', ''] };
    wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Stock counts', h('small', null, 'scan every pair in a rack and compare with the system')), newBtn), table([{ t: 'Count', f: c => [h('strong', null, c.name), h('div', { class: 'small muted' }, c.slots + ' slots')] }, { t: 'Assigned', f: c => c.assigned_name || h('span', { class: 'muted' }, 'anyone') },
        { t: 'Due', f: c => h('span', { class: c.overdue ? 'b bad' : '' }, day(c.due)) }, { t: 'Status', f: c => h('span', { class: 'b ' + SB[c.status][1] }, SB[c.status][0]) },
        { t: 'Scanned', n: 1, f: c => num(c.scanned) }, { t: 'Result', f: c => c.summary ? h('span', { class: 'small' }, `${c.summary.found} found · ${c.summary.missing.length} missing · ${c.summary.extra.length} extra`) : '' }], d.counts, c => { location.hash = '#/counts/c/' + c.id; })));
};
async function wmsNewCount(d, rack) {
    const people = await GET('/api/wms/people');
    const racks = d.due.map(r => r.rack);
    formModal('New stock count', [{ k: 'rack', label: 'Rack', type: 'select', options: [['', '— or list slots below —']].concat(racks.map(r => [r, 'Rack ' + r])), value: rack || '' },
        { k: 'slots', label: 'Slots (only if no rack chosen)', type: 'textarea', placeholder: 'A-R1-C1-L1, A-R1-C1-L2 …' },
        { k: 'assigned_to', label: 'Who counts', type: 'select', options: [['', 'Anyone']].concat(people.map(p => [p.id, p.name])) }, { k: 'due', label: 'Due date', type: 'date', value: todayStr() }], async (v) => { const r = await POST('/api/wms/counts', v); toast(`Count created · ${r.slots} slots`); location.hash = '#/counts/c/' + r.id; }, 'Create count');
}
async function wmsCount(id) {
    const d = await GET('/api/wms/counts/' + id), c = d.count;
    const back = wmsBack('#/counts', 'All counts');
    if (['review', 'done', 'cancelled'].includes(c.status))
        return wmsCountReport(d, back);
    let slot = store.get('wms_cslot_' + c.id, null);
    if (slot && !c.slots.includes(slot))
        slot = null;
    const live = h('div'), now = h('div', { class: 'wms-now' }), chips = h('div', { class: 'wms-chips' }), lastEl = h('div', { style: { minHeight: '24px' } });
    let st = d;
    const refresh = async () => { st = await GET('/api/wms/counts/' + id); draw(); };
    const draw = () => {
        const ss = st.slots.find(s => s.slot === slot);
        now.className = 'wms-now' + (slot ? ' set' : '');
        wmsFill(now, h('div', null, h('div', { class: 'small muted' }, slot ? 'Counting slot' : 'Step 1'), h('div', { class: 'code' }, slot || 'Scan a slot label')), slot ? h('div', { class: 'row' }, h('span', { class: 'b' }, `${ss ? ss.scanned : 0} scanned · ${ss && ss.expected || 0} expected`), ss && ss.done ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/wms/counts/${id}/slot-done`, { slot, undo: true })).then(refresh) }, 'Reopen slot')
            : h('button', { class: 'btn ok sm', onclick: () => act(() => POST(`/api/wms/counts/${id}/slot-done`, { slot }), 'Slot done').then(() => { const nx = st.slots.find(s => !s.done && s.slot !== slot); slot = nx ? nx.slot : null; store.set('wms_cslot_' + c.id, slot); return refresh(); }) }, 'Slot done ✓')) : null);
        wmsFill(chips, ...st.slots.map(s => h('button', { class: 'wms-chip' + (s.slot === slot ? ' on' : s.done ? ' done' : ''), onclick: () => { slot = s.slot; store.set('wms_cslot_' + c.id, slot); draw(); box.input.focus(); } }, s.slot, h('span', { class: 'm' }, s.scanned + '/' + (s.expected || 0)))));
        const T = st.totals;
        wmsFill(live, h('div', { class: 'kpis wms-k' }, kpi('Found', num(T.found), rs(T.foundValue), 'good'), kpi('Missing', num(T.missing), rs(T.missingValue) + ' · in slots marked done', T.missing ? 'alert' : ''), kpi('Extra', num(T.extra), 'recorded in another place', T.extra ? 'warn' : ''), kpi('Unknown', num(T.unknown), 'not in products', T.unknown ? 'warn' : ''), kpi('Slots done', `${st.slotsDone} / ${c.slots.length}`, 'accuracy ' + T.accuracy + '%')), st.extra.length ? h('div', { class: 'card' }, h('h2', null, 'Extra', h('small', null, 'found here but recorded somewhere else')), table([{ t: 'SKU', f: x => wmsSku(x.sku) }, { t: 'Item', f: x => x.title || '' }, { t: 'Found in', f: x => h('strong', { class: 'mono small' }, x.slot) }, { t: 'System says', f: x => [h('span', { class: 'mono small' }, x.recorded_loc || '–'), x.sold ? h('span', { class: 'b bad' }, ' sold') : ''] },
            { t: '', f: x => x.moved ? h('span', { class: 'b ok' }, 'moved') : x.sold ? '' : h('button', { class: 'btn sm', onclick: () => act(() => POST(`/api/wms/counts/${id}/move`, { sku: x.sku }), 'Moved here').then(refresh) }, 'Move here') }], st.extra)) : null, st.missing.length ? h('div', { class: 'card' }, h('h2', null, 'Missing', h('small', null, 'should be in a finished slot but not scanned')), table([{ t: 'SKU', f: x => wmsSku(x.sku) }, { t: 'Item', f: x => x.title }, { t: 'Slot', f: x => h('span', { class: 'mono small' }, x.loc) }, { t: 'Cost', n: 1, f: x => rs(x.cost) }], st.missing)) : null, h('div', { class: 'card' }, h('h2', null, 'Scanned', h('small', null, st.scans.length + ' pairs')), table([{ t: 'SKU', f: x => wmsSku(x.sku) }, { t: 'Slot', f: x => h('span', { class: 'mono small' }, x.slot) },
            { t: 'Result', f: x => h('span', { class: 'b ' + ({ found: 'ok', extra: 'warn', unknown: 'bad' })[x.result] }, x.result) }, { t: '', f: x => h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/wms/counts/${id}/unscan`, { sku: x.sku })).then(refresh) }, 'Undo') }], st.scans.slice(0, 200))));
    };
    const box = wmsScan('Scan slot label, then every pair in it', async (code) => {
        if (c.slots.includes(code)) {
            slot = code;
            store.set('wms_cslot_' + c.id, slot);
            wmsBeep(true);
            draw();
            return;
        }
        if (wmsIsSlot(code)) {
            wmsBeep(false);
            wmsFill(lastEl, h('div', { class: 'flash bad' }, `${code} is not part of this count`));
            return;
        }
        if (!slot) {
            wmsBeep(false);
            wmsFill(lastEl, h('div', { class: 'flash warn' }, 'Scan the slot label first'));
            return;
        }
        try {
            const r = await POST(`/api/wms/counts/${id}/scan`, { slot, sku: code });
            const msg = { found: ['ok', '✓ Found'], extra: ['warn', '! Extra: system says ' + (r.recorded || '–') + (r.sold ? ' (sold)' : '')], unknown: ['bad', '? Unknown SKU'] }[r.result];
            wmsBeep(r.result === 'found');
            wmsFill(lastEl, h('div', { class: 'flash ' + msg[0] }, msg[1] + ' · ' + r.sku + (r.again && r.again !== slot ? ` (was scanned in ${r.again})` : '')));
            await refresh();
        }
        catch (e) {
            wmsBeep(false);
            wmsFill(lastEl, h('div', { class: 'flash bad' }, e.message));
        }
    });
    const finish = h('button', { class: 'btn primary', onclick: async () => {
            const left = st.slots.filter(s => !s.done).length;
            if (!confirm(left ? `${left} slot(s) are not marked done. Everything expected there will count as missing. Finish anyway?` : 'Finish the count and see the variance report?'))
                return;
            await act(() => POST(`/api/wms/counts/${id}/finish`), 'Count finished');
            VIEWS.counts(['c', id]);
        } }, 'Finish count');
    draw();
    wmsRender(h('div', { class: 'row sp wms-top' }, back, h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: async () => { if (confirm('Cancel this count?')) {
            await act(() => POST(`/api/wms/counts/${id}/cancel`), 'Cancelled');
            location.hash = '#/counts';
        } } }, 'Cancel count'), finish)), h('div', { class: 'card' }, h('h2', null, c.name, h('small', null, [c.assigned_name, c.due && 'due ' + day(c.due)].filter(Boolean).join(' · '))), now, h('div', { style: { margin: '10px 0' } }, box), lastEl, h('div', { style: { marginTop: '10px' } }, chips)), live);
}
function wmsCountReport(d, back) {
    var _a, _b, _c;
    const c = d.count, s = c.summary || { found: 0, missing: [], extra: [], unknown: [] };
    const mv = h('input', { type: 'checkbox', checked: true });
    const approve = c.status === 'review' ? h('div', { class: 'card' }, h('h2', null, 'Approve adjustments'), h('div', { class: 'small muted' }, 'Extras are moved to the slot where they were found. Missing pairs go on the Missing list for follow-up. Shopify stock is not changed.'), h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'row', style: { gap: '6px' } }, mv, 'Move extras to where they were found'), h('button', { class: 'btn ok', onclick: async () => { const r = await act(() => POST(`/api/wms/counts/${c.id}/approve`, { moveExtras: mv.checked })); toast(`Approved · ${r.moved} moved · ${r.missing} on Missing list`); VIEWS.counts(['c', c.id]); } }, 'Approve'))) : null;
    const exp = () => csvDownload(`count-${c.id}.csv`, [].concat(s.missing.map(x => ({ result: 'missing', sku: x.sku, title: x.title, slot: x.loc, recorded: x.loc, cost: x.cost })), s.extra.map(x => ({ result: 'extra', sku: x.sku, title: x.title, slot: x.slot, recorded: x.recorded, cost: x.cost })), s.unknown.map(x => ({ result: 'unknown', sku: x.sku, title: '', slot: x.slot, recorded: '', cost: '' }))));
    wmsRender(h('div', { class: 'row sp wms-top' }, back, h('button', { class: 'btn ghost sm', onclick: exp }, 'Export CSV')), h('div', { class: 'card' }, h('h2', null, 'Variance report · ' + c.name, h('small', null, { review: 'waiting for approval', done: 'approved ' + dt(c.approved_at), cancelled: 'cancelled' }[c.status])), h('div', { class: 'small muted' }, `${(_a = s.slotsDone) !== null && _a !== void 0 ? _a : '–'} of ${(_b = s.slots) !== null && _b !== void 0 ? _b : c.slots.length} slots counted · finished ${dt(c.finished_at)}`)), h('div', { class: 'kpis wms-k' }, kpi('Found', num(s.found), rs(s.foundValue), 'good'), kpi('Missing', num(s.missing.length), rs(s.missingValue) + ' at cost', s.missing.length ? 'alert' : ''), kpi('Extra', num(s.extra.length), rs(s.extraValue) + ' at cost', s.extra.length ? 'warn' : ''), kpi('Unknown', num(s.unknown.length), 'not in products'), kpi('Accuracy', ((_c = s.accuracy) !== null && _c !== void 0 ? _c : 100) + '%', 'found ÷ (found + missing)')), approve, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Missing'), table([{ t: 'SKU', f: x => wmsSku(x.sku) }, { t: 'Item', f: x => x.title }, { t: 'Slot', f: x => h('span', { class: 'mono small' }, x.loc) }, { t: 'Cost', n: 1, f: x => rs(x.cost) }], s.missing)), h('div', { class: 'card' }, h('h2', null, 'Extra & unknown'), table([{ t: 'SKU', f: x => wmsSku(x.sku) }, { t: 'Found in', f: x => h('span', { class: 'mono small' }, x.slot) }, { t: 'System said', f: x => x.recorded ? h('span', { class: 'mono small' }, x.recorded) : h('span', { class: 'b bad' }, 'unknown') },
        { t: '', f: x => x.moved ? h('span', { class: 'b ok' }, 'moved') : x.sold ? h('span', { class: 'b bad' }, 'sold') : '' }], s.extra.concat(s.unknown)))));
}
async function wmsMissing(head) {
    const rows = await GET('/api/wms/missing');
    wmsRender(head, h('div', { class: 'card' }, h('h2', null, 'Missing pairs', h('small', null, 'expected in a counted slot but not found · search for them, or write off')), table([{ t: 'SKU', f: m => wmsSku(m.sku) }, { t: 'Item', f: m => m.title }, { t: 'Last slot', f: m => h('span', { class: 'mono small' }, m.last_loc) }, { t: 'Cost', n: 1, f: m => rs(m.cost) }, { t: 'Since', f: m => day(m.at) },
        { t: '', f: m => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('button', { class: 'btn ok sm', onclick: () => formModal('Found ' + m.sku, [{ k: 'slot', label: 'Where is it now? (slot)', placeholder: m.last_loc }, { k: 'note', label: 'Note' }], async (v) => { await POST(`/api/wms/missing/${m.id}/resolve`, Object.assign({ action: 'found' }, v)); toast('Marked found'); VIEWS.counts(['missing']); }, 'Mark found') }, 'Found'), h('button', { class: 'btn bad sm', onclick: async () => { if (!confirm(`Write off ${m.sku} (${rs(m.cost)})?`))
                    return; const r = await act(() => POST(`/api/wms/missing/${m.id}/resolve`, { action: 'writeoff' })); toast('Written off' + (r.posted ? ' · posted to accounts' : r.error ? ' · ' + r.error : ''), !!r.error); VIEWS.counts(['missing']); } }, 'Write off')) }], rows)));
}
registerView({ key: 'counts', title: 'Stock counts', group: 'Warehouse', perm: 'wms', icon: 'scan', order: 40 }, VIEWS.counts);
/* ---------- Damage register ---------- */
VIEWS.damage = async (args) => {
    const d = await GET('/api/wms/damage'), ok = can('wms');
    const pend = d.rows.filter(r => r.status === 'reported');
    const max = Math.max(1, ...d.reasons.map(r => r.n));
    const SB = { reported: ['Waiting approval', 'warn'], approved: ['Written off', 'bad'], rejected: ['Rejected', ''] };
    const act1 = r => r.status !== 'reported' || !ok ? (r.post_error ? h('span', { class: 'small muted', title: r.post_error }, 'not posted') : '') : h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('button', { class: 'btn sm', onclick: () => formModal('Write off ' + r.sku, [{ k: 'cost', label: 'Cost to write off (Rs)', type: 'number', value: r.cost }], async (v) => { const x = await POST(`/api/wms/damage/${r.id}/approve`, { cost: v.cost }); toast('Written off' + (x.posted ? ' · posted to accounts' : x.error ? ' · accounts: ' + x.error : ''), !!x.error); VIEWS.damage([]); }, 'Approve write-off') }, 'Approve'), h('button', { class: 'btn ghost sm', onclick: async () => { const n = prompt('Why reject? (optional)'); if (n === null)
            return; await act(() => POST(`/api/wms/damage/${r.id}/approve`, { approve: false, note: n }), 'Rejected'); VIEWS.damage([]); } }, 'Reject'));
    wmsRender(pageHead('Damage register', 'Report damaged pairs; the owner/manager approves the write-off', h('button', { class: 'btn', onclick: () => wmsReportDamage(d.REASONS) }, '+ Report damage')), h('div', { class: 'kpis wms-k', style: { margin: '12px 0' } }, kpi('Damage this month', rs(d.mtd.value), `${d.mtd.n} pairs written off`, d.mtd.value ? 'alert' : ''), kpi('% of stock value', d.mtd.pct + '%', 'stock at cost ' + rs(d.stockValue), d.mtd.pct > 1 ? 'warn' : ''), kpi('Waiting approval', num(pend.length), rs(pend.reduce((t, r) => t + (r.cost || 0), 0)) + ' at cost', pend.length ? 'warn' : '')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Reasons', h('small', null, 'last 90 days')), d.reasons.map((r, i) => h('div', { class: 'wms-hbar' }, h('span', { style: { textTransform: 'capitalize' } }, r.reason), h('div', { class: 'bar' }, h('i', { style: { width: (100 * r.n / max) + '%', background: [C2, C1, C4, C3, C2, C1][i] } })), h('span', { class: 'small', style: { textAlign: 'right' }, title: rs(r.v) + ' at cost' }, r.n + (r.n === 1 ? ' pair' : ' pairs'))))), h('div', { class: 'card' }, h('h2', null, 'By month', h('small', null, 'pairs reported')), chart(d.months, 'month', [{ k: 'n', l: 'Pairs', c: C2 }], 140))), h('div', { class: 'card' }, h('h2', null, 'Reports'), table([{ t: 'When', f: r => [day(r.at), h('div', { class: 'small muted' }, r.reported_name || '')] }, { t: 'SKU', f: r => [wmsSku(r.sku), h('div', { class: 'small muted' }, r.title || '')] },
        { t: 'Reason', f: r => [h('span', { style: { textTransform: 'capitalize' } }, r.reason), r.note ? h('div', { class: 'small muted' }, r.note) : null] }, { t: 'Found at', f: r => h('span', { class: 'mono small' }, r.found_at || '') }, { t: 'Photo', f: r => fileLink(r.photo) || '' },
        { t: 'Cost', n: 1, f: r => rs(r.cost) }, { t: 'Status', f: r => [h('span', { class: 'b ' + SB[r.status][1] }, SB[r.status][0]), r.approved_name ? h('div', { class: 'small muted' }, r.approved_name) : null] }, { t: '', f: act1 }], d.rows)));
    if (args[0] === 'new')
        wmsReportDamage(d.REASONS);
};
function wmsReportDamage(reasons) {
    let reason = null;
    const sku = h('input', { placeholder: 'Scan or type SKU', autocomplete: 'off', class: 'mono', style: { fontSize: '18px' } }), info = h('div', { class: 'small muted' });
    const where = h('input', { placeholder: 'Slot / place (auto from system)' }), note = h('textarea', { placeholder: 'What is wrong?' }), photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const rb = h('div', { class: 'wms-dest' });
    const drawR = () => wmsFill(rb, ...reasons.map(r => h('button', { class: reason === r ? 'on' : '', style: { textTransform: 'capitalize' }, onclick: () => { reason = r; drawR(); } }, r)));
    drawR();
    const look = async () => { const c = sku.value.trim(); if (!c)
        return; try {
        const r = await GET('/api/lookup?code=' + encodeURIComponent(c));
        if (r.product) {
            info.textContent = `${r.product.title} · ${r.product.size || ''} · cost ${rs(r.product.cost)}`;
            if (!where.value)
                where.value = r.product.loc || r.product.rack || '';
        }
        else
            info.textContent = 'Not found in products';
    }
    catch (e) {
        info.textContent = e.message;
    } };
    sku.addEventListener('keydown', e => { if (e.key === 'Enter') {
        e.preventDefault();
        look();
    } });
    sku.addEventListener('change', look);
    const err = h('div', { class: 'flash bad', hidden: true });
    const m = modal('Report a damaged pair', h('div', { class: 'grid' }, err, field('SKU', sku), info, h('div', null, h('div', { class: 'small', style: { fontWeight: 600, marginBottom: '6px' } }, 'Reason'), rb), h('div', { class: 'fgrid' }, field('Photo', photo), field('Found where', where), h('label', { class: 'f full' }, 'Note', note))), [h('button', { class: 'btn', onclick: async () => {
                try {
                    if (!reason)
                        throw new Error('Pick a reason');
                    const ph = photo.files[0] ? await uploadFile(photo.files[0]) : null;
                    const r = await POST('/api/wms/damage', { sku: sku.value, reason, photo: ph, found_at: where.value, note: note.value });
                    m.remove();
                    toast('Damage reported' + (r.warning ? ' · ' + r.warning : ''), !!r.warning);
                    if (CURRENT === 'damage')
                        VIEWS.damage([]);
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, 'Report')]);
}
registerView({ key: 'damage', title: 'Damage', group: 'Warehouse', perm: 'inventory', icon: 'alert', order: 50 }, VIEWS.damage);
/* ---------- Racks & slots: map, put-away scanner, setup, moves ---------- */
VIEWS.racks = async (args) => {
    const tab = args[0] || 'map', edit = can('wms');
    const t = [['map', 'Rack map']];
    if (edit)
        t.push(['putaway', 'Put away / move'], ['setup', 'Set up slots']);
    t.push(['moves', 'Stock moves']);
    const head = tabs(t, tab, k => { location.hash = '#/racks/' + k; });
    if (tab === 'putaway' && edit)
        return wmsPutaway(head);
    if (tab === 'setup' && edit)
        return wmsSetup(head, args[1]);
    if (tab === 'moves')
        return wmsMoves(head);
    return wmsMap(head, args[1]);
};
async function wmsMap(head, rackArg) {
    const d = await GET('/api/wms/racks');
    if (!d.racks.length)
        return wmsRender(head, h('div', { class: 'card empty' }, 'No racks yet.', can('wms') ? h('div', null, h('a', { class: 'btn', href: '#/racks/setup', style: { marginTop: '10px' } }, 'Set up rack slots')) : null));
    const withSlots = d.racks.filter(r => r.slots);
    const rack = rackArg || store.get('wms_rack', (withSlots[0] || d.racks[0]).rack);
    store.set('wms_rack', rack);
    const chips = h('div', { class: 'wms-chips' }, d.racks.map(r => h('button', { class: 'wms-chip' + (r.rack === rack ? ' on' : ''), onclick: () => { location.hash = '#/racks/map/' + encodeURIComponent(r.rack); } }, r.rack, h('span', { class: 'm' }, r.fill != null ? r.fill + '%' : num(r.items)))));
    const rd = await GET('/api/wms/racks/' + encodeURIComponent(rack)), info = d.racks.find(r => r.rack === rack) || {};
    const sel = new Set();
    let mode = 'view', onlyEmpty = false;
    const selInfo = h('span', { class: 'small muted' });
    const mapBox = h('div', { class: 'scroll' });
    const draw = () => {
        if (!rd.slots.length) {
            wmsFill(mapBox, h('div', { class: 'empty' }, `Rack ${rack} has no slots set up. Its pairs are recorded by rack letters only.`));
            return;
        }
        const rows = [...new Set(rd.slots.map(s => s.row))], cols = [...new Set(rd.slots.map(s => s.col))].sort((a, b) => a - b);
        wmsFill(mapBox, h('table', { class: 'wms-map' }, h('thead', null, h('tr', null, h('th'), cols.map(c => h('th', null, 'C' + c)))), h('tbody', null, rows.map(r => h('tr', null, h('th', null, 'R' + r), cols.map(c => {
            const lv = rd.slots.filter(s => s.row === r && s.col === c).sort((a, b) => b.level - a.level);
            return h('td', null, h('div', { class: 'wms-cell' }, lv.map(s => h('div', {
                class: 'wms-lv ' + wmsLvCls(s.items, s.capacity, s.active) + (sel.has(s.code) ? ' sel' : '') + (onlyEmpty && s.items ? ' dim' : ''), title: `${s.code} · ${s.items}/${s.capacity}${s.active ? '' : ' (off)'}`,
                onclick: () => { if (mode === 'select') {
                    sel.has(s.code) ? sel.delete(s.code) : sel.add(s.code);
                    selInfo.textContent = sel.size + ' selected';
                    draw();
                }
                else
                    slotDrawer(s.code); },
            }, h('span', null, 'L' + s.level), h('b', null, s.items + '/' + s.capacity)))));
        }))))));
    };
    const modeBtn = h('button', { class: 'btn ghost sm', onclick: () => { mode = mode === 'view' ? 'select' : 'view'; modeBtn.textContent = mode === 'select' ? 'Done selecting' : 'Select slots'; selBar.hidden = mode !== 'select'; draw(); } }, 'Select slots');
    const selBar = h('div', { class: 'row', hidden: true }, h('button', { class: 'btn ghost sm', onclick: () => { rd.slots.forEach(s => s.active && sel.add(s.code)); selInfo.textContent = sel.size + ' selected'; draw(); } }, 'All'), h('button', { class: 'btn ghost sm', onclick: () => { rd.slots.forEach(s => !s.items && s.active && sel.add(s.code)); selInfo.textContent = sel.size + ' selected'; draw(); } }, 'Empty ones'), h('button', { class: 'btn ghost sm', onclick: () => { sel.clear(); selInfo.textContent = ''; draw(); } }, 'Clear'), h('button', { class: 'btn sm', onclick: () => printLabels([...sel].sort(), 50, 25) }, 'Print bin labels'), can('wms') ? h('button', { class: 'btn ghost sm', onclick: () => sel.size ? formModal(`Edit ${sel.size} slots`, [{ k: 'capacity', label: 'Capacity (pairs)', type: 'number' }, { k: 'active', label: 'Status', type: 'select', options: [['', 'No change'], ['1', 'Active'], ['0', 'Switched off']] }], async (v) => { await POST('/api/wms/slots/update', { codes: [...sel], capacity: v.capacity, active: v.active === '' ? null : v.active === '1' }); toast('Saved'); VIEWS.racks(['map', rack]); }) : toast('Select slots first', true) }, 'Edit') : null, selInfo);
    const emptyBtn = h('button', { class: 'btn ghost sm', onclick: () => { onlyEmpty = !onlyEmpty; emptyBtn.classList.toggle('primary', onlyEmpty); draw(); } }, 'Show empty slots');
    draw();
    const legend = h('div', { class: 'wms-legend' }, [['', 'Empty'], ['part', 'Has space'], ['full', 'Full'], ['over', 'Over capacity'], ['off', 'Switched off']].map(([c, l]) => h('span', null, h('i', { class: 'wms-lv ' + c, style: { padding: 0 } }), l)));
    wmsRender(head, h('div', { class: 'card' }, chips), h('div', { class: 'kpis wms-k' }, kpi('Rack ' + rack, num(info.items || 0) + ' pairs', rs(info.value || 0) + ' at cost'), kpi('Slots', num(info.slots || 0), info.slots ? `${info.empty} empty · ${info.full} full` : 'not set up'), kpi('Fill', info.fill == null ? '–' : info.fill + '%', info.capacity ? `${num(info.slotted)} of ${num(info.capacity)} places` : '', info.fill > 95 ? 'warn' : '')), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Occupancy map', h('small', null, 'tap a slot to see what is in it')), h('div', { class: 'row' }, emptyBtn, modeBtn)), selBar, h('div', { style: { margin: '8px 0' } }, legend), mapBox, rd.unslotted.length ? h('div', { class: 'note warn', style: { marginTop: '10px' } }, `${num(rd.unslotted.reduce((t, x) => t + x.n, 0))} pairs in rack ${rack} have no slot yet (${rd.unslotted.slice(0, 6).map(x => x.loc + ': ' + x.n).join(', ')}). `, can('wms') ? h('a', { href: '#/racks/putaway' }, 'Put them away') : null) : null));
}
async function slotDrawer(code) {
    var _a;
    const d = await GET('/api/wms/slot/' + encodeURIComponent(code));
    drawer(h('div', { class: 'grid' }, h('div', { class: 'row sp' }, h('h2', { class: 'mono', style: { margin: 0 } }, code), h('button', { class: 'btn ghost sm', onclick: () => printLabels([code], 50, 25) }, 'Print label')), h('div', { class: 'muted' }, `${d.items.length} pairs · capacity ${(_a = d.capacity) !== null && _a !== void 0 ? _a : '–'}${d.slot && !d.slot.active ? ' · switched off' : ''}${d.slot && d.slot.zone ? ' · ' + d.slot.zone : ''}`), table([{ t: 'SKU', f: i => wmsSku(i.sku) }, { t: 'Item', f: i => [i.title, h('div', { class: 'small muted' }, i.size || '')] }, { t: 'Cost', n: 1, f: i => rs(i.cost) }], d.items), can('wms') ? h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/racks/putaway/' + encodeURIComponent(code), onclick: () => { var _a; return (_a = document.querySelector('.drawer')) === null || _a === void 0 ? void 0 : _a.remove(); } }, 'Put away here'), h('button', { class: 'btn ghost', onclick: async () => { await act(() => POST('/api/wms/counts', { slots: [code] }), 'Count created').then(r => { var _a; (_a = document.querySelector('.drawer')) === null || _a === void 0 ? void 0 : _a.remove(); location.hash = '#/counts/c/' + r.id; }); } }, 'Count this slot')) : null));
}
async function wmsPutaway(head) {
    const pre = (location.hash.split('/')[3] || '');
    let slot = null, slotInfo = null, n = 0;
    const now = h('div', { class: 'wms-now' }), logEl = h('div', { class: 'wms-log' }, h('div', { class: 'muted small wms-ph' }, 'Scanned pairs show here.')), cnt = h('span', { class: 'small muted' });
    const show = () => {
        now.className = 'wms-now' + (slot ? ' set' : '');
        wmsFill(now, h('div', null, h('div', { class: 'small muted' }, slot ? 'Putting pairs into' : 'Step 1'), h('div', { class: 'code' }, slot || 'Scan a slot label')), slot ? h('div', { class: 'row' }, h('span', { class: 'b ' + (slotInfo && slotInfo.capacity && slotInfo.items.length > slotInfo.capacity ? 'bad' : 'ok') }, `${slotInfo ? slotInfo.items.length : 0}${slotInfo && slotInfo.capacity ? ' / ' + slotInfo.capacity : ''} pairs`), h('button', { class: 'btn ghost sm', onclick: () => { slot = null; show(); box.input.focus(); } }, 'Change slot')) : null);
    };
    const line = (main, sub, cls) => { var _a; (_a = logEl.querySelector('.wms-ph')) === null || _a === void 0 ? void 0 : _a.remove(); logEl.prepend(h('div', null, h('div', null, main, sub ? h('div', { class: cls || 'w' }, sub) : null), h('span', { class: 'small muted' }, new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })))); };
    const setSlot = async (code) => {
        const d = await GET('/api/wms/slot/' + encodeURIComponent(code));
        if (!d.known && !d.looksLikeSlot && !confirm(`${code} does not look like a slot code. Use it as a location anyway?`))
            return;
        slot = code;
        slotInfo = d;
        show();
        wmsBeep(true);
        if (!d.known)
            line(h('strong', null, 'Slot ' + code), 'Not in the rack setup: pairs will still be recorded here');
    };
    const box = wmsScan('Scan slot label, then each shoe', async (code) => {
        if (wmsIsSlot(code) || !slot)
            return setSlot(code).catch(e => { wmsBeep(false); toast(e.message, true); });
        try {
            const r = await POST('/api/wms/putaway', { slot, sku: code });
            slotInfo.items.length = r.inSlot;
            if (r.capacity != null)
                slotInfo.capacity = r.capacity;
            n++;
            cnt.textContent = n + ' scanned';
            wmsBeep(!r.warnings.length);
            line(h('span', null, '✓ ', wmsSku(r.sku), ' → ', h('strong', { class: 'mono' }, r.slot), r.product ? h('span', { class: 'muted small' }, ' · ' + r.product.title) : '', r.same ? h('span', { class: 'b' }, ' already here') : r.from ? h('span', { class: 'muted small' }, ' (was ' + r.from + ')') : ''), r.warnings.join(' · '));
            show();
        }
        catch (e) {
            wmsBeep(false);
            line(h('span', null, '✗ ', wmsSku(code)), e.message, 'e');
        }
    });
    show();
    wmsRender(head, h('div', { class: 'card' }, h('h2', null, 'Put away & move', h('small', null, 'works with a USB / Bluetooth barcode scanner')), now, h('div', { style: { margin: '10px 0' } }, box), h('div', { class: 'small muted' }, 'Scan a slot label (e.g. A-R2-C2-L1) once, then scan every shoe you place in it. Scan another slot label to switch. Returns and moved pairs work the same way.')), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'This session'), cnt), logEl));
    if (pre && wmsIsSlot(pre))
        setSlot(pre.toUpperCase());
}
async function wmsSetup(head, rackArg) {
    const d = await GET('/api/wms/racks');
    const f = { zone: h('input', { placeholder: 'e.g. Ground floor' }), racks: h('input', { placeholder: 'A-D  or  A, B, C' }), rows: h('input', { type: 'number', value: 4, min: 1 }), cols: h('input', { type: 'number', value: 6, min: 1 }),
        levels: h('input', { type: 'number', value: 4, min: 1 }), capacity: h('input', { type: 'number', value: d.settings.defaultCapacity, min: 1 }), overwrite: h('input', { type: 'checkbox' }) };
    const prev = h('div', { class: 'note' });
    const upd = () => {
        const rk = f.racks.value.toUpperCase().split(/[\s,]+/).filter(Boolean).flatMap(t => { const m = /^([A-Z])-([A-Z])$/.exec(t); if (!m)
            return [t]; const o = []; for (let c = m[1].charCodeAt(0); c <= m[2].charCodeAt(0); c++)
            o.push(String.fromCharCode(c)); return o; });
        const n = rk.length * (+f.rows.value || 0) * (+f.cols.value || 0) * (+f.levels.value || 0);
        prev.textContent = rk.length ? `${num(n)} slots · ${rk[0]}-R1-C1-L1 … ${rk[rk.length - 1]}-R${f.rows.value}-C${f.cols.value}-L${f.levels.value} · ${num(n * (+f.capacity.value || 0))} pairs capacity` : 'Type rack letters to see the slot codes.';
    };
    Object.values(f).forEach(i => i.addEventListener('input', upd));
    upd();
    const withSlots = d.racks.filter(r => r.slots);
    const rack = rackArg || (withSlots[0] || {}).rack;
    let list = h('div');
    if (rack) {
        const sl = await GET('/api/wms/slots?active=all&rack=' + encodeURIComponent(rack));
        list = h('div', null, h('div', { class: 'wms-chips', style: { marginBottom: '10px' } }, withSlots.map(r => h('button', { class: 'wms-chip' + (r.rack === rack ? ' on' : ''), onclick: () => { location.hash = '#/racks/setup/' + r.rack; } }, r.rack, h('span', { class: 'm' }, r.slots)))), table([{ t: 'Slot', f: s => h('strong', { class: 'mono' }, s.code) }, { t: 'Zone', k: 'zone' }, { t: 'Pairs', n: 1, f: s => num(s.items) }, { t: 'Capacity', n: 1, f: s => num(s.capacity) }, { t: 'Status', f: s => s.active ? h('span', { class: 'b ok' }, 'active') : h('span', { class: 'b' }, 'off') },
            { t: '', f: s => h('button', { class: 'btn ghost sm', onclick: () => formModal('Slot ' + s.code, [{ k: 'capacity', label: 'Capacity', type: 'number', value: s.capacity }, { k: 'zone', label: 'Zone', value: s.zone }, { k: 'active', label: 'Active', type: 'checkbox', value: !!s.active }], async (v) => { await POST('/api/wms/slots/update', Object.assign({ codes: [s.code] }, v)); toast('Saved'); VIEWS.racks(['setup', rack]); }) }, 'Edit') }], sl));
    }
    wmsRender(head, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Create slots'), h('div', { class: 'fgrid' }, field('Racks', f.racks), field('Zone', f.zone), field('Rows', f.rows), field('Columns', f.cols), field('Levels', f.levels), field('Capacity per slot (pairs)', f.capacity), h('label', { class: 'f full row', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, f.overwrite, 'Also update capacity / zone of slots that already exist')), h('div', { style: { margin: '10px 0' } }, prev), h('button', { class: 'btn', onclick: () => act(() => POST('/api/wms/slots/generate', { zone: f.zone.value, racks: f.racks.value, rows: f.rows.value, cols: f.cols.value, levels: f.levels.value, capacity: f.capacity.value, overwrite: f.overwrite.checked }))
            .then(r => { toast(`${r.made} slots created` + (r.updated ? `, ${r.updated} updated` : '')); VIEWS.racks(['setup', r.racks[0]]); }) }, 'Create slots')), h('div', { class: 'card' }, h('h2', null, 'Slot codes'), h('dl', { class: 'wms-kv' }, h('dt', null, 'A-R2-C3-L1'), h('dd', null, 'Rack A, row 2, column 3, level 1 (bottom)')), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Existing slots are never deleted: switch them off instead. Print bin labels from the rack map (Select slots → Print bin labels).'))), rack ? h('div', { class: 'card' }, h('h2', null, 'Slots in rack ' + rack), list) : null);
}
async function wmsMoves(head) {
    const box = h('div');
    const qi = h('input', { placeholder: 'SKU (blank = latest moves)', class: 'grow' });
    const load = async () => {
        const r = await GET('/api/wms/moves?' + qs({ sku: qi.value.trim(), limit: 200 }));
        wmsFill(box, table([{ t: 'When', f: m => dt(m.at) }, { t: 'SKU', f: m => wmsSku(m.sku) }, { t: 'From', f: m => h('span', { class: 'mono small' }, m.from_loc || '–') }, { t: 'To', f: m => h('strong', { class: 'mono small' }, m.to_loc) }, { t: 'Why', f: m => h('span', { class: 'b' }, m.reason) }, { t: 'By', k: 'user' }], r));
    };
    qi.addEventListener('keydown', e => { if (e.key === 'Enter')
        load(); });
    wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row' }, qi, h('button', { class: 'btn ghost', onclick: load }, 'Search')), h('div', { style: { marginTop: '10px' } }, box)));
    await load();
}
registerView({ key: 'racks', title: 'Racks & put-away', group: 'Warehouse', perm: 'inventory', icon: 'layers', order: 20 }, VIEWS.racks);
/* ---------- Receiving (GRN) & transfers ---------- */
VIEWS.receiving = async (args) => {
    const tab = args[0] || 'lots';
    const head = tabs([['lots', 'Receive lots'], ['transfers', 'Transfers'], ['new', 'New transfer']], ['transfer'].includes(tab) ? 'transfers' : tab, k => { location.hash = '#/receiving/' + k; });
    if (tab === 'transfers')
        return wmsTransfers(head);
    if (tab === 'transfer')
        return wmsTransfer(head, args[1]);
    if (tab === 'new')
        return wmsNewTransfer(head);
    return wmsLots(head, args[1]);
};
async function wmsLots(head, filt) {
    const d = await GET('/api/wms/lots');
    const f = filt || 'open';
    const groups = { open: l => l.status !== 'fully_listed', not_received: l => l.status === 'not_received', listing: l => ['received', 'listing'].includes(l.status), stuck: l => l.stuck, fully_listed: l => l.status === 'fully_listed', all: () => true };
    const rows = d.lots.filter(groups[f] || groups.open);
    const tb = tabs([['open', 'To do', d.lots.filter(groups.open).length], ['not_received', 'Not received', d.lots.filter(groups.not_received).length], ['listing', 'Being listed', d.lots.filter(groups.listing).length],
        ['stuck', 'Stuck', d.lots.filter(groups.stuck).length], ['fully_listed', 'Fully listed'], ['all', 'All']], f, k => { location.hash = '#/receiving/lots/' + k; });
    wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Lots', h('small', null, `Count the pieces when a lot arrives. Lots received over ${d.settings.stuckDays} days ago with less than ${d.settings.stuckPct}% listed are flagged.`))), tb, table([{ t: 'Lot', f: l => [h('strong', null, l.name), h('div', { class: 'small muted' }, [l.vendor, l.bought_on && 'bought ' + day(l.bought_on)].filter(Boolean).join(' · '))] },
        { t: 'Pieces', n: 1, f: l => l.grn ? [num(l.grn.good), h('div', { class: 'small muted' }, `of ${num(l.grn.expected)}` + (l.grn.damaged ? ` · ${l.grn.damaged} bad` : ''))] : num(l.pieces) },
        { t: 'Status', f: l => { const [t, c] = wmsStatusB[l.status]; return [h('span', { class: 'b ' + c }, t), l.stuck ? h('span', { class: 'b bad', style: { marginLeft: '4px' } }, 'stuck') : null, !l.received && l.listed ? h('div', { class: 'small muted' }, 'no GRN') : null]; } },
        { t: 'Listed', f: l => h('div', { style: { minWidth: '120px' } }, h('div', { class: 'small' }, `${num(l.listed)} · ${l.pctListed}%`), bar(l.pctListed)) },
        { t: 'Received', f: l => l.grn ? [day(l.grn.received_at), h('div', { class: 'small muted' }, `${l.days} days ago${l.grn.received_name ? ' · ' + l.grn.received_name : ''}`)] : '' },
        { t: '', f: l => h('button', { class: 'btn sm ' + (l.received ? 'ghost' : ''), onclick: () => wmsReceive(l, d.accounts) }, l.received ? 'Edit GRN' : 'Receive') }], rows, l => wmsReceive(l, d.accounts))));
}
async function wmsReceive(l, hasAcc) {
    var _a, _b, _c, _e;
    const people = await GET('/api/wms/people');
    const g = l.grn || {}, photos = [...(g.photos || [])];
    const exp = h('input', { type: 'number', value: (_b = (_a = g.expected) !== null && _a !== void 0 ? _a : l.pieces) !== null && _b !== void 0 ? _b : '' }), good = h('input', { type: 'number', value: (_c = g.good) !== null && _c !== void 0 ? _c : '', placeholder: 'good pairs' }), bad = h('input', { type: 'number', value: (_e = g.damaged) !== null && _e !== void 0 ? _e : 0 });
    const notes = h('textarea', { placeholder: 'e.g. 2 bags wet, 5 single shoes' }, g.notes || ''), by = wmsPeopleSelect(people, g.received_by || ME.id);
    const at = h('input', { type: 'datetime-local', value: (g.received_at ? new Date(g.received_at.replace(' ', 'T') + 'Z') : new Date()).toLocaleString('sv').slice(0, 16).replace(' ', 'T') });
    const ph = h('input', { type: 'file', accept: 'image/*', multiple: true }), phList = h('div', { class: 'row small' });
    const drawPh = () => wmsFill(phList, ...photos.map((id, i) => h('span', null, fileLink(id), ' ', h('a', { href: '#', onclick: e => { e.preventDefault(); photos.splice(i, 1); drawPh(); } }, '×'))));
    ph.addEventListener('change', async () => { for (const f of ph.files) {
        try {
            photos.push(await uploadFile(f));
        }
        catch (e) {
            toast(e.message, true);
        }
    } ph.value = ''; drawPh(); });
    drawPh();
    const sum = h('div', { class: 'note' });
    const upd = () => {
        const e = +exp.value || 0, gd = +good.value || 0, b = +bad.value || 0, diff = gd + b - e, pp = l.per_piece || 0;
        wmsFill(sum, h('div', null, h('strong', null, diff === 0 ? 'Matches expected' : diff < 0 ? `${-diff} short` : `${diff} extra`), ` · ${gd + b} counted of ${e} expected`), pp ? h('div', { class: 'small' }, `Per pair ${rs(pp)} → Unlisted Inventory ${rs(gd * pp)}` + (b ? ` + Inventory Damage ${rs(b * pp)}` : '') + ` · from Purchases ${rs((gd + b) * pp)}` + (hasAcc ? '' : ' (accounts not set up: not posted)')) : h('div', { class: 'small' }, 'This lot has no cost yet, so nothing is posted to accounts.'));
    };
    [exp, good, bad].forEach(i => i.addEventListener('input', upd));
    upd();
    const err = h('div', { class: 'flash bad', hidden: true }), poBox = h('div', { hidden: true });
    exp.addEventListener('input', () => { exp.dataset.touched = '1'; });
    const m = modal('Receive ' + l.name, h('div', { class: 'grid' }, err, poBox, h('div', { class: 'fgrid' }, field('Expected pieces', exp), field('Counted good *', good), field('Damaged', bad), field('Received by', by), field('Received at', at), h('label', { class: 'f full' }, 'Photos', ph, phList), h('label', { class: 'f full' }, 'Notes', notes)), sum), [h('button', { class: 'btn', onclick: async () => {
                try {
                    const r = await POST('/api/wms/lots/' + encodeURIComponent(l.name) + '/receive', { expected: exp.value, good: good.value, damaged: bad.value, notes: notes.value, photos, received_by: by.value, received_at: at.value ? new Date(at.value).toISOString() : null });
                    m.remove();
                    toast(`${l.name} received` + (r.posted ? ' · posted to accounts' : r.error ? ' · accounts: ' + r.error : ''), !!r.error);
                    VIEWS.receiving(['lots']);
                    if (r.po && typeof purGrnResult === 'function')
                        purGrnResult(l.name, r.po);
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, 'Save GRN')]);
    // lot bought on a purchase order: show what was ordered (Purchasing)
    if (typeof purGrnInfo === 'function')
        purGrnInfo(l.name, exp).then(n => { if (n) {
            poBox.replaceWith(n);
            upd();
        } }).catch(() => { });
}
async function wmsTransfers(head) {
    const d = await GET('/api/wms/transfers');
    wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Transfer notes', h('small', null, 'pairs sent to the outlet, repair, supplier or photo studio')), h('a', { class: 'btn', href: '#/receiving/new' }, '+ New transfer')), table([{ t: '#', f: t => 'T-' + t.id }, { t: 'To', f: t => h('strong', null, t.destName) }, { t: 'Pairs', n: 1, f: t => t.status === 'received' ? `${t.got} / ${t.items}` : num(t.items) },
        { t: 'Status', f: t => [h('span', { class: 'b ' + (t.status === 'received' ? (t.discrepancy ? 'warn' : 'ok') : 'info') }, t.status === 'received' ? 'Received' : 'Sent'), t.discrepancy ? h('div', { class: 'small muted' }, `${t.discrepancy.short.length} short · ${t.discrepancy.extra.length} extra`) : null] },
        { t: 'Sent', f: t => [dt(t.sent_at), h('div', { class: 'small muted' }, t.sent_name || '')] }, { t: 'Received', f: t => t.received_at ? [dt(t.received_at), h('div', { class: 'small muted' }, t.received_name || '')] : '' }, { t: 'Note', k: 'note' }], d.rows, t => { location.hash = '#/receiving/transfer/' + t.id; })));
}
function wmsNewTransfer(head) {
    let dest = null;
    const skus = [];
    const destBox = h('div', { class: 'wms-dest' }), list = h('div', { class: 'wms-log' }), cnt = h('span', { class: 'b info' }, '0 pairs'), note = h('input', { placeholder: 'Note (optional)', class: 'grow' });
    const drawDest = () => wmsFill(destBox, ...Object.entries(WMS_DEST).map(([k, l]) => h('button', { class: dest === k ? 'on' : '', onclick: () => { dest = k; drawDest(); box.input.focus(); } }, l)));
    const drawList = () => {
        cnt.textContent = skus.length + ' pairs';
        wmsFill(list, ...skus.map((s, i) => h('div', null, h('span', null, wmsSku(s.sku), h('span', { class: 'muted small' }, s.title ? ' · ' + s.title : ''), s.warn ? h('div', { class: 'w' }, s.warn) : null), h('button', { class: 'btn ghost sm', onclick: () => { skus.splice(i, 1); drawList(); } }, 'Remove'))));
    };
    const box = wmsScan('Scan each pair going out', async (code) => {
        if (skus.some(s => s.sku === code)) {
            wmsBeep(false);
            return toast(code + ' already scanned', true);
        }
        let warn = null, title = '';
        try {
            const r = await GET('/api/lookup?code=' + encodeURIComponent(code));
            if (!r.product)
                warn = 'Unknown SKU';
            else {
                title = r.product.title;
                if (r.product.qty <= 0)
                    warn = 'Marked sold';
            }
        }
        catch (_a) {
            warn = 'Unknown SKU';
        }
        skus.unshift({ sku: code, title, warn });
        wmsBeep(!warn);
        drawList();
    });
    drawDest();
    drawList();
    wmsRender(head, h('div', { class: 'card' }, h('h2', null, '1. Where is it going?'), destBox), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, '2. Scan the pairs'), cnt), box, h('div', { style: { marginTop: '8px' } }, list)), h('div', { class: 'card' }, h('div', { class: 'row' }, note, h('button', { class: 'btn big', onclick: async () => {
            if (!dest)
                return toast('Pick where it is going', true);
            if (!skus.length)
                return toast('Scan at least one pair', true);
            const r = await act(() => POST('/api/wms/transfers', { dest, skus: skus.map(s => s.sku), note: note.value }), 'Transfer sent');
            location.hash = '#/receiving/transfer/' + r.id;
        } }, 'Send transfer'))));
}
async function wmsTransfer(head, id) {
    const d = await GET('/api/wms/transfers/' + id), t = d.transfer;
    const got = new Set();
    const info = h('div', { class: 'small muted' });
    const recv = t.status === 'sent' ? (() => {
        const lst = h('div', { class: 'wms-log' });
        const draw = () => { info.textContent = `${got.size} scanned of ${d.items.length}`; wmsFill(lst, ...[...got].map(s => h('div', null, wmsSku(s), d.items.some(i => i.sku === s) ? h('span', { class: 'b ok' }, 'on note') : h('span', { class: 'b warn' }, 'not on note')))); };
        const box = wmsScan('Scan pairs as they arrive', async (code) => { got.add(code); wmsBeep(d.items.some(i => i.sku === code)); draw(); });
        draw();
        return h('div', { class: 'card' }, h('h2', null, 'Receive at ' + t.destName, h('small', null, 'scan each pair, or tap "All arrived"')), box, info, lst, h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: async () => { if (!got.size)
                return toast('Scan the pairs first', true); const r = await act(() => POST(`/api/wms/transfers/${t.id}/receive`, { skus: [...got] })); toast(`Received ${r.received}` + (r.short.length ? ` · ${r.short.length} short` : '') + (r.extra.length ? ` · ${r.extra.length} extra` : ''), !!(r.short.length || r.extra.length)); VIEWS.receiving(['transfer', t.id]); } }, 'Receive scanned'), h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Mark all pairs as arrived?'))
                return; await act(() => POST(`/api/wms/transfers/${t.id}/receive`, { all: true }), 'Received'); VIEWS.receiving(['transfer', t.id]); } }, 'All arrived')));
    })() : null;
    const disc = t.discrepancy;
    wmsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, `Transfer T-${t.id} → ${t.destName}`), wmsBack('#/receiving/transfers')), h('dl', { class: 'wms-kv' }, h('dt', null, 'Status'), h('dd', null, t.status === 'received' ? 'Received' : 'Sent, on the way'), h('dt', null, 'Sent'), h('dd', null, `${dt(t.sent_at)} · ${t.sent_name || ''}`), t.received_at ? [h('dt', null, 'Received'), h('dd', null, `${dt(t.received_at)} · ${t.received_name || ''}`)] : null, t.note ? [h('dt', null, 'Note'), h('dd', null, t.note)] : null), disc ? h('div', { class: 'note warn', style: { marginTop: '10px' } }, disc.short.length ? `Did not arrive: ${disc.short.join(', ')}. ` : '', disc.extra.length ? `Arrived but not on the note: ${disc.extra.join(', ')}.` : '') : null), recv, h('div', { class: 'card' }, h('h2', null, 'Pairs', h('small', null, d.items.filter(i => !i.extra).length + ' on the note')), table([{ t: 'SKU', f: i => wmsSku(i.sku) }, { t: 'Item', f: i => [i.title || h('span', { class: 'muted' }, 'unknown'), h('div', { class: 'small muted' }, i.size || '')] }, { t: 'From', f: i => h('span', { class: 'mono small' }, i.from_loc || '') },
        { t: 'Arrived', f: i => i.extra ? h('span', { class: 'b warn' }, 'extra') : t.status === 'received' ? (i.received ? h('span', { class: 'b ok' }, 'yes') : h('span', { class: 'b bad' }, 'no')) : h('span', { class: 'b' }, 'on the way') }], d.items)));
}
registerView({ key: 'receiving', title: 'Lot receiving (GRN)', group: 'Stock line', perm: 'wms', icon: 'truck', order: 10 }, VIEWS.receiving);
/* ---------- Warehouse overview (WMS KPIs) ---------- */
VIEWS.wms = async () => {
    const d = await GET('/api/wms/overview');
    const quick = h('div', { class: 'wms-quick' }, [['#/racks/putaway', 'scan', 'Put away / move'], ['#/counts', 'check', 'Stock count'], ['#/receiving', 'truck', 'Receive a lot'], ['#/damage/new', 'alert', 'Report damage'], ['#/receiving/new', 'swap', 'Transfer out'], ['#/racks', 'layers', 'Rack map']]
        .map(([href, ic, l]) => h('a', { href }, icon(ic, 20), l)));
    const sp = d.speed, mins = v => v == null ? '–' : v < 90 ? v + ' min' : (v / 60).toFixed(1) + ' h';
    const kp = h('div', { class: 'kpis wms-k' }, kpi('Pairs on hand', num(d.onHand), rs(d.stockValue) + ' at cost'), kpi('Slot fill', d.slotFill == null ? '–' : d.slotFill + '%', d.capacity ? `${num(d.slotted)} of ${num(d.capacity)} places · ${num(d.emptySlots)} empty slots` : 'No slots set up yet', d.slotFill > 95 ? 'warn' : '', '#/racks'), kpi('Lots to receive', num(d.lotsToReceive), d.stuckLots.length ? d.stuckLots.length + ' stuck in listing' : 'none stuck', d.stuckLots.length ? 'alert' : '', '#/receiving'), kpi('Listing backlog', num(d.backlog), 'received pairs not listed yet', d.backlog > 500 ? 'warn' : '', '#/receiving'), kpi('Counts due', num(d.countsDue), d.openVariances.length ? d.openVariances.length + ' count(s) to approve' : 'racks to count', d.countsDue ? 'warn' : '', '#/counts/due'), kpi('Missing pairs', num(d.missingOpen), 'from stock counts', d.missingOpen ? 'alert' : '', '#/counts/missing'), kpi('Damage this month', rs(d.damageMTD), d.damagePending ? d.damagePending + ' waiting approval' : 'written off at cost', d.damagePending ? 'warn' : '', '#/damage'), kpi('Pick / pack today', mins(sp.pick) + ' / ' + mins(sp.pack), `${sp.picked} picked · ${sp.packed} packed (avg time)`), kpi('Returns to put away', num(d.returnsWaiting.length), 'restocked without a slot', d.returnsWaiting.length ? 'warn' : '', '#/racks/putaway'));
    const maxAge = Math.max(1, ...d.aging.map(a => a.n));
    const aging = h('div', { class: 'card' }, h('h2', null, 'Stock age', h('small', null, 'days since listed')), d.aging.map((a, i) => h('div', { class: 'wms-hbar' }, h('span', null, a.bucket), h('div', { class: 'bar' + (i >= 2 ? ' warn' : '') }, h('i', { style: { width: (100 * a.n / maxAge) + '%', background: [C3, C1, C4, C2][i] } })), h('span', { class: 'small', style: { textAlign: 'right' } }, num(a.n)))), table([{ t: 'Age', k: 'bucket' }, { t: 'Pairs', n: 1, f: a => num(a.n) }, { t: 'Value at cost', n: 1, f: a => rs(a.value) }, { t: 'Share', n: 1, f: a => pct(a.n, d.onHand) }], d.aging));
    const racks = h('div', { class: 'card' }, h('h2', null, 'Racks', h('small', null, 'fill vs capacity')), table([{ t: 'Rack', f: r => h('strong', { class: 'mono' }, r.rack) }, { t: 'Pairs', n: 1, f: r => num(r.items) },
        { t: 'Fill', f: r => r.fill == null ? h('span', { class: 'muted small' }, 'no slots') : h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, bar(r.fill), h('span', { class: 'small' }, r.fill + '%')) },
        { t: 'Empty', n: 1, f: r => r.slots ? num(r.empty) : '' }], d.racks, r => { location.hash = '#/racks/map/' + encodeURIComponent(r.rack); }));
    const slow = h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Slow movers', h('small', null, `${num(d.slowTotal)} pairs in stock over 120 days · by rack, for clearance`)), h('button', { class: 'btn ghost sm', onclick: () => csvDownload('slow-movers.csv', d.slow.flatMap(r => r.items.map(i => ({ rack: r.rack, sku: i.sku, title: i.title, size: i.size, location: i.loc, days: i.age, price: i.price, cost: i.cost, lot: i.lot })))) }, 'Export CSV')), table([{ t: 'Rack', f: r => h('strong', { class: 'mono' }, r.rack) }, { t: 'Pairs', n: 1, f: r => num(r.n) }, { t: 'Cost', n: 1, f: r => rs(r.value) }, { t: 'Price value', n: 1, f: r => rs(r.price) }], d.slow, r => drawer(h('div', null, h('h2', null, 'Slow movers · rack ' + r.rack), h('div', { class: 'muted small' }, r.n > r.items.length ? `Showing oldest ${r.items.length} of ${r.n}` : r.n + ' pairs'), table([{ t: 'SKU', f: i => wmsSku(i.sku) }, { t: 'Item', f: i => [i.title, h('div', { class: 'small muted' }, [i.size, i.loc].filter(Boolean).join(' · '))] }, { t: 'Days', n: 1, f: i => h('span', { class: 'b ' + (i.age > 365 ? 'bad' : 'warn') }, i.age) }, { t: 'Price', n: 1, f: i => rs(i.price) }], r.items)))));
    const attention = [];
    if (d.stuckLots.length)
        attention.push(h('div', { class: 'card' }, h('h2', null, 'Lots stuck in listing'), table([{ t: 'Lot', k: 'name' }, { t: 'Received', f: l => l.days + ' days ago' }, { t: 'Listed', f: l => `${l.listed} / ${l.grn.good} (${l.pctListed}%)` }], d.stuckLots, () => { location.hash = '#/receiving'; })));
    if (d.openVariances.length)
        attention.push(h('div', { class: 'card' }, h('h2', null, 'Counts waiting for approval'), table([{ t: 'Count', k: 'name' }, { t: 'Missing', n: 1, f: v => num(v.missing) }, { t: 'Extra', n: 1, f: v => num(v.extra) }, { t: 'Missing value', n: 1, f: v => rs(v.missingValue) }], d.openVariances, v => { location.hash = '#/counts/c/' + v.id; })));
    if (d.returnsWaiting.length)
        attention.push(h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Returns waiting put-away'), h('a', { class: 'btn sm', href: '#/racks/putaway' }, 'Put away')), table([{ t: 'SKU', f: r => wmsSku(r.sku) }, { t: 'Order', f: r => r.name || h('span', { class: 'muted' }, 'returns bin') }, { t: 'Since', f: r => ago(r.at) }], d.returnsWaiting.slice(0, 20))));
    wmsRender(pageHead('Warehouse', 'Stock, racks, receiving and counts at a glance'), h('div', { class: 'grid' }, quick, kp, attention.length ? h('div', { class: 'two' }, attention) : null, h('div', { class: 'two' }, aging, racks), slow));
};
registerView({ key: 'wms', title: 'Warehouse overview', group: 'Warehouse', perm: ['wms', 'warehouse'], icon: 'grid', order: 90 }, VIEWS.wms);
/* ---------- lots & pricing ---------- */
/* ---------- list pairs (Lister) + barcode printing ---------- */
// Code 128 (set B), drawn as SVG: prints straight from the browser, no downloads.
const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
function barcodeSvg(text) {
    const codes = [104];
    for (const ch of String(text)) {
        const v = ch.charCodeAt(0) - 32;
        if (v < 0 || v > 94)
            throw new Error('Unsupported character in SKU: ' + ch);
        codes.push(v);
    }
    let sum = 104;
    for (let i = 1; i < codes.length; i++)
        sum += i * codes[i];
    codes.push(sum % 103, 106);
    let x = 10, r = '', black = true;
    for (const d of codes.map(c => C128[c]).join('')) {
        const n = +d;
        if (black)
            r += `<rect x="${x}" y="0" width="${n}" height="60"/>`;
        x += n;
        black = !black;
    }
    const box = h('div');
    box.innerHTML = `<svg viewBox="0 0 ${x + 10} 60" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${r}</svg>`;
    return box.firstChild;
}
const labelEl = (sku, w, hh) => h('div', { class: 'lbl', style: { width: w + 'mm', height: hh + 'mm' } }, (() => { const s = barcodeSvg(sku); s.style.width = (w - 4) + 'mm'; s.style.height = (hh * 0.62) + 'mm'; return s; })(), h('div', { class: 't' }, sku));
// Prints barcode labels (SKU only, no price) on the label printer: the print window opens, Print, and it closes by itself.
function printLabels(skus, w, hh) {
    skus = skus.filter(Boolean);
    if (!skus.length)
        return toast('Nothing to print', true);
    w = +w || (LIST_META === null || LIST_META === void 0 ? void 0 : LIST_META.labelW) || 50;
    hh = +hh || (LIST_META === null || LIST_META === void 0 ? void 0 : LIST_META.labelH) || 25;
    let area = document.getElementById('printArea');
    if (!area) {
        area = h('div', { id: 'printArea' });
        document.body.append(area);
    }
    let pg = document.getElementById('pageSize');
    if (!pg) {
        pg = h('style', { id: 'pageSize' });
        document.head.append(pg);
    }
    try {
        area.replaceChildren(...skus.map(s => labelEl(s, w, hh)));
    }
    catch (e) {
        return toast(e.message, true);
    }
    pg.textContent = `@media print{@page{size:${w}mm ${hh}mm;margin:0}}`;
    document.body.classList.add('plabels');
    const done = () => { document.body.classList.remove('plabels'); area.replaceChildren(); pg.textContent = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(() => { if (document.body.classList.contains('plabels') && !matchMedia('print').matches)
        done(); }, 1500); }, 60);
}
let LIST_META = null, LIST_FORM = null;
const sel = (vals, cur, ph) => h('select', null, ph ? h('option', { value: '' }, ph) : null, vals.map(v => { const o = typeof v === 'object' ? v : { v, t: v }; return h('option', { value: o.v, selected: o.v === cur }, o.t); }));
VIEWS.list = async (args) => {
    const tab = args[0] || 'new';
    LIST_META = await GET('/api/list/meta');
    const M = LIST_META, owner = M.owner;
    const t = [['new', 'List a pair'], ['listed', 'Listed pairs']];
    if (owner)
        t.push(['lots', 'Lots'], ['costs', 'Costs & labels']);
    const head = tabs(t, tab, k => { location.hash = '#/list/' + k; });
    if (tab === 'listed')
        return listedTab(head);
    if (tab === 'lots' && owner)
        return lotsTab(head);
    if (tab === 'costs' && owner)
        return costsTab(head);
    const F = LIST_FORM = LIST_FORM || store.get('sbListForm', { lot: '', gender: 'Woman', type: 'Stilettos', brand: '', size: 'Euro 38', color: 'Black', cond: 'Excellent', material: '' });
    const lotOpts = M.lots.map(l => ({ v: l.name, t: l.name + (l.kind ? ` · ${l.kind === 'leftover' ? 'Left-over' : 'Used'}` : '') + (l.ready ? '' : ' · no cost yet') }));
    const f = {
        lot: sel(lotOpts, F.lot, 'Choose lot…'), gender: sel(M.lists.gender, F.gender), type: sel(M.types, F.type), brand: h('input', { value: F.brand, list: 'brandList', placeholder: 'e.g. Zara', autocomplete: 'off' }),
        size: sel(M.lists.size, F.size), color: sel(M.lists.color, F.color), cond: sel(M.conds, F.cond), material: sel(M.lists.material, F.material, '—'),
        note: h('input', { placeholder: 'Marks, scratches, missing insole…' }), title: h('input', { placeholder: 'Auto' }), override: owner ? h('input', { type: 'number', placeholder: 'Leave empty for the automatic price' }) : null,
    };
    let titleAuto = true;
    f.title.addEventListener('input', () => { titleAuto = !f.title.value; });
    const auto = h('input', { type: 'checkbox', checked: store.get('sbAutoPrint', false), onchange: e => store.set('sbAutoPrint', e.target.checked) });
    const price = h('div', { class: 'bigprice' }, '—'), why = h('div', { class: 'small muted' }), verdict = h('div'), msg = h('div', { class: 'small', style: { color: 'var(--warn,#a86a00)' } });
    const sale = h('dl', { class: 'kv' }), brk = h('dl', { class: 'kv' }), skuNext = h('span', { class: 'mono' });
    const saveBtn = h('button', { class: 'btn', type: 'submit' }, 'Save pair');
    const locIn = h('input', { placeholder: 'Only if it already has one, e.g. A-R2-C2-L1', autocapitalize: 'characters' }); // Stock line: used for the handover
    const after = h('div');
    const vals = () => Object.fromEntries(Object.entries(f).filter(([, el]) => el).map(([k, el]) => [k, el.value]));
    const dd = (l, v, st) => [h('dt', { style: st }, l), h('dd', { style: st }, v)];
    let tq = null, seq = 0;
    const refresh = () => { clearTimeout(tq); tq = setTimeout(quote, 150); };
    async function quote() {
        const v = vals();
        Object.assign(F, { lot: v.lot, gender: v.gender, type: v.type, brand: v.brand, size: v.size, color: v.color, cond: v.cond, material: v.material });
        store.set('sbListForm', F);
        const my = ++seq;
        let r;
        try {
            r = await POST('/api/list/quote', v);
        }
        catch (e) {
            return;
        }
        if (my !== seq)
            return;
        if (titleAuto)
            f.title.value = r.title;
        skuNext.textContent = r.letter + '-' + r.next;
        msg.replaceChildren(...(r.block || []).map(m => h('div', { style: { color: 'var(--bad,#b3261e)' } }, '✖ ' + m)), ...(r.warn || []).map(m => h('div', null, '⚠ ' + m)));
        const x = r.quote;
        if (!x) {
            price.textContent = '—';
            sale.replaceChildren();
            brk.replaceChildren();
            return;
        }
        price.textContent = rs(x.final);
        why.textContent = x.why + (x.estCost ? ' · estimated cost (no lot chosen)' : '');
        sale.replaceChildren(...x.sales.flatMap((s, i) => dd(`Sale ${i + 1}: ${Math.round(s.off * 100)}% off (after ${s.day} days unsold)`, rs(s.price))), ...dd('Sale never below (break-even)', rs(x.floor)), h('div', { class: 'sep' }), ...x.all.flatMap(a => dd(a.cond, rs(a.final), a.cond === v.cond ? { fontWeight: 700 } : null)));
        const ok = !(r.block || []).length;
        saveBtn.disabled = !ok || (x.owner && x.final < x.floor);
        if (!x.owner) {
            verdict.className = 'flash ' + (!ok ? 'bad' : x.status === 'loss' ? 'bad' : x.status === 'thin' ? 'warn' : 'ok');
            verdict.textContent = !ok ? 'Fix the red items below before saving.' : x.status === 'loss' ? `Customers usually pay about ${rs(x.market)} for this kind of pair, less than it costs to sell. The price is held at break-even (${rs(x.final)}), so it will sell slowly. Tell the owner about this lot.` : x.status === 'thin' ? 'Price is what customers pay for this kind of pair. Small profit after every cost.' : 'Price is what customers pay for this kind of pair, profit included. List at this price.';
            return;
        }
        const b = x.bk, net = b.net;
        verdict.className = 'flash ' + (x.final < x.floor ? 'bad' : net >= x.target - 1 ? 'ok' : net >= 0 ? 'warn' : 'bad');
        verdict.textContent = x.final < x.floor ? `This price LOSES money on this pair. Break-even is ${rs(x.floor)}.` : net >= x.target - 1 ? `Good: after every cost this pair leaves ${rs(net)} profit (its share of the monthly target is ${rs(x.target)}).` : net >= 0 ? `Small profit: ${rs(net)} after every cost, below its ${rs(x.target)} share of the target.` : `This pair loses ${rs(-net)} after rent and salaries.`;
        const st = { fontWeight: 700 };
        brk.replaceChildren(...dd(`One delivered pair at ${rs(b.p)}`, '', st), ...dd('Coupon / discount (avg 7%)', '− ' + rs(b.coupon)), ...dd('Delivery charge from customer (per pair)', '+ ' + rs(b.credit)), ...dd('COD tax', '− ' + rs(b.cod)), ...dd('In hand', rs(b.inHand), st), h('div', { class: 'sep' }), ...dd('Pair cost' + (x.estCost ? ' (estimate)' : ''), '− ' + rs(b.cost)), ...dd('Meta ads (incl. cancelled & returned orders)', '− ' + rs(b.ads)), ...dd(`Courier (${Math.round(b.r * 100)}% of parcels come back)`, '− ' + rs(b.courier)), ...dd('Packing', '− ' + rs(b.pack)), ...(b.back > 0.5 ? dd('Return courier and handling', '− ' + rs(b.back)) : []), ...dd("Left after this pair's own costs", rs(b.own), st), ...dd('Rent, salaries and other fixed', '− ' + rs(b.fixed)), h('div', { class: 'sep' }), ...dd('End profit on this pair', rs(net), { fontWeight: 700, color: net >= 0 ? 'var(--ok,#2f7d32)' : 'var(--bad,#b3261e)' }), ...x.sales.flatMap((s, i) => dd(`Sale ${i + 1}: ${Math.round(s.off * 100)}% off → ${rs(s.price)}${s.held ? ' (held at break-even)' : ''}`, rs(s.net), { color: s.net >= 0 ? 'var(--ok,#2f7d32)' : 'var(--bad,#b3261e)' })), h('div', { class: 'sep' }), ...dd('Customers usually paid', rs(x.market)), ...dd('Break-even (all costs, no profit)', rs(x.floor)));
    }
    function showSaved(it) {
        const go = () => printLabels([it.sku]);
        after.replaceChildren(h('div', { class: 'card saved' }, h('div', { class: 'row sp' }, h('h2', null, 'Saved ', h('span', { class: 'mono' }, it.sku), h('small', null, `${it.brand} · ${it.type} · ${it.size} · ${rs(it.price)}`))), h('div', { class: 'lblprev' }, labelEl(it.sku, M.labelW, M.labelH)), h('div', { class: 'row' }, h('button', { class: 'btn big', type: 'button', onclick: go }, '🖨 Print barcode'), h('button', { class: 'btn ghost', type: 'button', onclick: () => { var _a; (_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(it.sku).then(() => toast('SKU copied: ' + it.sku), () => toast(it.sku)); } }, 'Copy SKU')), VIEWS.handover ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Next for this pair: ', h('a', { href: '#/photos' }, 'photo'), ' → ', h('a', { href: '#/photos/edit' }, 'editing'), ' → ', h('a', { href: '#/upload' }, 'upload'), ' → ', h('a', { href: '#/handover' }, 'hand over to warehouse'), it._loc ? [' (location ', h('strong', { class: 'mono' }, it._loc), ')'] : null) : null));
        if (auto.checked)
            go();
    }
    const form = h('form', { class: 'grid', onsubmit: async (e) => {
            e.preventDefault();
            saveBtn.disabled = true;
            const send = extra => POST('/api/list/save', Object.assign(Object.assign({}, vals()), (extra || {})));
            try {
                let it;
                try {
                    it = await send();
                }
                catch (x) {
                    if (/save again to confirm/.test(x.message) && confirm(x.message + '\n\nSave this as a second pair?'))
                        it = await send({ confirmDup: true });
                    else
                        throw x;
                }
                toast('Saved ' + it.sku);
                f.note.value = '';
                const loc = locIn.value.trim().toUpperCase();
                if (loc && VIEWS.handover) {
                    try {
                        await POST('/api/sl/pair/' + encodeURIComponent(it.sku) + '/location', { location: loc });
                        it._loc = loc;
                    }
                    catch (x) {
                        toast(x.message, true);
                    }
                }
                locIn.value = '';
                if (f.override)
                    f.override.value = '';
                titleAuto = true;
                showSaved(it);
                quote();
            }
            catch (x) {
                toast(x.message, true);
                saveBtn.disabled = false;
            }
        } }, h('div', { class: 'fgrid' }, field('Lot', f.lot), field('Gender', f.gender), field('Type', f.type), field('Brand', f.brand), field('Size', f.size), field('Color', f.color), field('Condition', f.cond), field('Material', f.material)), field('Note (needed for Good condition)', f.note), field('Title', f.title), VIEWS.handover ? field('Location (optional)', locIn) : null, owner ? field('Owner: set a price yourself', f.override) : null, msg, h('div', { class: 'row' }, saveBtn, h('label', { class: 'row small' }, auto, 'Print the barcode right after saving')));
    Object.values(f).forEach(el => el && el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', refresh));
    const recent = h('div');
    const loadRecent = async () => { const r = await GET('/api/list/recent?mine=1&limit=15'); recent.replaceChildren(table([{ t: 'SKU', f: x => h('strong', { class: 'mono' }, x.sku) }, { t: 'Pair', f: x => `${x.brand} ${x.type} · ${x.size} · ${x.cond}` }, { t: 'Price', n: 1, f: x => rs(x.price) }, { t: 'When', f: x => dt(x.at) }, { t: '', f: x => h('button', { class: 'btn ghost sm', type: 'button', onclick: () => printLabels([x.sku]) }, 'Barcode') }], r)); };
    const ticket = h('div', { class: 'card ticket' }, h('div', { class: 'small muted' }, 'Next SKU ', skuNext), h('div', { class: 'muted small' }, 'List at'), price, why, verdict, h('h2', { style: { marginTop: '12px' } }, 'Sale plan'), sale, owner ? [h('h2', { style: { marginTop: '12px' } }, 'Profit on this pair'), brk] : null);
    render(head, h('datalist', { id: 'brandList' }, M.brands.map(b => h('option', { value: b }))), h('div', { class: 'listgrid' }, h('div', { class: 'grid' }, h('div', { class: 'card' }, form), after, h('div', { class: 'card' }, h('h2', null, 'My recent pairs'), recent)), ticket));
    quote();
    loadRecent();
    const orig = showSaved;
    showSaved = it => { orig(it); loadRecent(); };
};
async function listedTab(head) {
    const st = { q: '', pending: store.get('sbPending', '1'), lot: '' };
    const picked = new Set();
    const box = h('div'), qi = h('input', { placeholder: 'Search SKU, brand, title…' }), pend = h('input', { type: 'checkbox', checked: st.pending === '1' });
    const lotSel = sel(LIST_META.lots.map(l => l.name), '', 'All lots');
    let rows = [];
    const load = async () => { rows = await GET('/api/list/recent?' + qs({ q: qi.value.trim(), pending: pend.checked ? '1' : '', lot: lotSel.value, limit: 1000 })); picked.clear(); draw(); };
    const chosen = () => picked.size ? rows.filter(r => picked.has(r.sku)) : rows;
    const draw = () => {
        const all = h('input', { type: 'checkbox', onchange: e => { rows.forEach(r => e.target.checked ? picked.add(r.sku) : picked.delete(r.sku)); draw(); }, checked: rows.length && picked.size === rows.length });
        box.replaceChildren(h('div', { class: 'row', style: { margin: '6px 0 10px' } }, h('button', { class: 'btn', onclick: () => printLabels(chosen().map(r => r.sku)) }, `🖨 Print barcodes (${chosen().length})`), h('button', { class: 'btn ghost', onclick: () => act(async () => { const r = await POST('/api/list/export', { skus: chosen().map(x => x.sku) }); saveText(r.filename, r.csv); await load(); return r; }, 'Shopify file ready') }, `Shopify CSV (${chosen().length})`), h('span', { class: 'small muted' }, picked.size ? `${picked.size} selected` : 'No pair selected: buttons use every pair shown')), table([{ t: h('span', null, all), f: r => h('input', { type: 'checkbox', checked: picked.has(r.sku), onchange: e => { e.target.checked ? picked.add(r.sku) : picked.delete(r.sku); draw(); } }) },
            { t: 'SKU', f: r => h('strong', { class: 'mono' }, r.sku) }, { t: 'Pair', f: r => [r.title, h('div', { class: 'small muted' }, `${r.gender} · ${r.size} · ${r.color} · ${r.cond} · ${r.lot}`)] },
            { t: 'Price', n: 1, f: r => rs(r.price) }, LIST_META.owner ? { t: 'Min', n: 1, f: r => rs(r.floor) } : null, { t: 'By', f: r => [r.by_name || '', h('div', { class: 'small muted' }, dt(r.at))] },
            { t: 'Shopify', f: r => r.exported ? h('span', { class: 'b ok' }, 'Exported') : h('span', { class: 'b warn' }, 'Not yet') },
            { t: '', f: r => h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => printLabels([r.sku]) }, 'Barcode'), (LIST_META.owner || (!r.exported && r.user_id === ME.id)) ? h('button', { class: 'btn ghost sm', onclick: e => { if (e.target.dataset.arm !== '1') {
                        e.target.dataset.arm = '1';
                        e.target.textContent = 'Sure?';
                        return;
                    } act(() => POST('/api/list/delete/' + encodeURIComponent(r.sku)), 'Removed').then(load); } }, 'Remove') : null) }].filter(Boolean), rows));
    };
    qi.addEventListener('keydown', e => { if (e.key === 'Enter')
        load(); });
    pend.addEventListener('change', () => { store.set('sbPending', pend.checked ? '1' : ''); load(); });
    lotSel.addEventListener('change', load);
    render(head, h('div', { class: 'card' }, h('div', { class: 'row' }, qi, lotSel, h('label', { class: 'row small' }, pend, 'Only pairs not yet sent to Shopify')), box));
    await load();
}
async function lotsTab(head) {
    const lots = await GET('/api/list/lots');
    const M = LIST_META;
    const v = { name: h('input', { placeholder: 'e.g. LAL-Lot 06' }), vendor: h('input'), bought_on: h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }),
        kind: sel([{ v: 'used', t: 'Used' }, { v: 'leftover', t: 'Left-over' }], 'used'), cost: h('input', { type: 'number', placeholder: 'e.g. 2200000' }), extra: h('input', { type: 'number', value: 0 }),
        pieces: h('input', { type: 'number', placeholder: 'Total pairs' }), bad: h('input', { type: 'number', value: 0 }), note: h('input') };
    let comp = [{ t: 'Stilettos', g: 'Woman', c: 'Excellent', n: 0, b: '' }];
    const compBox = h('div'), sum = h('div');
    const body = () => (Object.assign(Object.assign({}, Object.fromEntries(Object.entries(v).map(([k, el]) => [k, el.value]))), { comp }));
    let tq;
    const preview = () => { clearTimeout(tq); tq = setTimeout(async () => { if (!(+v.pieces.value > 0) || !(+v.cost.value > 0)) {
        sum.replaceChildren();
        drawComp(null);
        return;
    } try {
        const p = await POST('/api/list/lot-plan', body());
        drawComp(p);
    }
    catch (e) { } }, 200); };
    const drawComp = p => {
        const byIx = p ? p.rows : [];
        let k = 0;
        compBox.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Type', 'Gender', 'Brand', 'Condition', 'Pairs', 'Cost / pair', 'List at', 'Min (sale)', ''].map(x => h('th', null, x)))), h('tbody', null, comp.map((r, i) => {
            const o = r.n > 0 && p ? byIx[k++] : null;
            const upd = key => e => { r[key] = key === 'n' ? (+e.target.value || 0) : e.target.value; preview(); };
            return h('tr', null, h('td', null, (() => { const s = sel(M.types, r.t); s.onchange = upd('t'); return s; })()), h('td', null, (() => { const s = sel(M.lists.gender, r.g); s.onchange = upd('g'); return s; })()), h('td', null, h('input', { value: r.b, list: 'brandList', placeholder: 'any', oninput: upd('b'), style: { width: '120px' } })), h('td', null, (() => { const s = sel(M.conds, r.c); s.onchange = upd('c'); return s; })()), h('td', null, h('input', { type: 'number', value: r.n || '', oninput: upd('n'), style: { width: '80px' } })), h('td', { class: 'n' }, o ? num(o.cost) : ''), h('td', { class: 'n' }, o ? num(o.price) : ''), h('td', { class: 'n' }, o ? num(o.min) : ''), h('td', null, o ? (o.slow ? h('span', { class: 'b warn' }, 'Raised for profit: may sell slower') : h('span', { class: 'b ok' }, 'Profit at market price')) : null, h('button', { class: 'btn ghost sm', onclick: () => { comp.splice(i, 1); if (!comp.length)
                    comp.push({ t: 'Stilettos', g: 'Woman', c: 'Excellent', n: 0, b: '' }); preview(); drawComp(p); } }, '×')));
        })))), h('button', { class: 'btn ghost sm', onclick: () => { comp.push({ t: 'Block Heels', g: 'Woman', c: v.kind.value === 'leftover' ? 'Premium' : 'Excellent', n: 0, b: '' }); drawComp(p); } }, '+ Add a row'));
        sum.replaceChildren(...[p ? h('div', { class: 'kpis' }, kpi('Sellable pairs', num(p.ok), 'average cost ' + rs(p.per_piece)), kpi('Sales if all sell at list price', rs(p.listed)), kpi('Pairs to sell to get the lot cost back', p.payback ? `${num(p.payback)} (${Math.round(p.payback / p.ok * 100)}%)` : 'never'), kpi('Lot profit after every cost', rs(p.profit), '90% sold with the sale plan', p.profit >= 0 ? 'ok' : 'bad')) : null, p && p.slow ? h('div', { class: 'flash warn' }, `${p.slow} pairs are priced above what customers usually pay, to keep the profit. Bargain the lot price down to sell them faster.`) : null,
            p && p.pairs && Math.abs(p.pairs - p.ok) / p.ok > 0.1 ? h('div', { class: 'small muted' }, `Type counts add up to ${p.pairs}, sellable pairs are ${p.ok}. The cost split still works, but check the counts.`) : null].filter(Boolean));
    };
    Object.values(v).forEach(el => el.addEventListener('input', preview));
    const edit = l => { v.name.value = l.name; v.vendor.value = l.vendor; v.bought_on.value = l.bought_on; v.kind.value = l.kind || 'used'; v.cost.value = l.cost || ''; v.extra.value = l.extra || 0; v.pieces.value = l.pieces || ''; v.bad.value = l.bad || 0; v.note.value = l.note; comp = l.comp && l.comp.length ? l.comp.map(r => (Object.assign({ b: '' }, r))) : comp; preview(); window.scrollTo(0, 0); };
    render(head, h('datalist', { id: 'brandList' }, M.brands.map(b => h('option', { value: b }))), h('div', { class: 'card' }, h('h2', null, 'New lot', h('small', null, 'enter what it cost and roughly what is in it; prices for every pair follow from this')), h('div', { class: 'fgrid' }, field('Lot name', v.name), field('Vendor', v.vendor), field('Date', v.bought_on), field('Lot kind', v.kind), field('Lot price (Rs)', v.cost), field('Extra costs: transport, customs (Rs)', v.extra), field('Total pairs', v.pieces), field('Damaged / unsellable', v.bad)), field('Note', v.note), h('h2', { style: { marginTop: '14px' } }, 'Pairs by type', h('small', null, 'rough counts are fine: they split the lot cost so a men\'s sneaker carries more than a kids\' sandal')), compBox, sum, h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => act(() => POST('/api/list/lots', body()), 'Lot saved').then(() => VIEWS.list(['lots'])) }, 'Save lot'))), h('div', { class: 'card' }, h('h2', null, 'Lots', h('small', null, 'click a lot to change it')), table([{ t: 'Lot', f: l => [h('strong', null, l.name), h('div', { class: 'small muted' }, [l.kind === 'leftover' ? 'Left-over' : l.kind ? 'Used' : '', l.vendor, l.bought_on].filter(Boolean).join(' · '))] },
        { t: 'Cost', n: 1, f: l => l.cost ? rs((l.cost || 0) + (l.extra || 0)) : h('span', { class: 'b warn' }, 'No cost') }, { t: 'Sellable', n: 1, f: l => num(l.sellable) }, { t: 'Avg / pair', n: 1, f: l => l.per_piece ? rs(l.per_piece) : '–' },
        { t: 'Listed', n: 1, f: l => `${num(l.listed)} / ${num(l.sellable)}` }, { t: 'Listed value', n: 1, f: l => rs(l.listed_value) },
        { t: '', f: l => l.listed ? null : h('button', { class: 'btn ghost sm', onclick: e => { if (e.target.dataset.arm !== '1') {
                    e.target.dataset.arm = '1';
                    e.target.textContent = 'Sure?';
                    return;
                } act(() => POST('/api/list/lots/' + encodeURIComponent(l.name) + '/delete'), 'Removed').then(() => VIEWS.list(['lots'])); } }, 'Remove') }], lots, edit)));
    drawComp(null);
}
async function costsTab(head) {
    const d = await GET('/api/list/econ');
    const e = d.econ;
    const F = [['adsMonthly', 'Meta ads spend / month (Rs)'], ['ordersMonthly', 'Orders / month'], ['soldMonthly', 'Pairs delivered / month (after cancels and returns)'], ['fixedMonthly', 'Fixed costs / month: rent, salaries… (Rs)'],
        ['targetProfit', 'Profit target / month (Rs)'], ['courierFwd', 'Courier per parcel (Rs)'], ['courierReturn', 'Return courier per returned parcel (Rs)'], ['returnHandling', 'Return clean-up / repack (Rs)'], ['packing', 'Packing per parcel (Rs)'],
        ['shipCharge', 'Delivery charge the customer pays (Rs)'], ['codPct', 'COD tax (%)'], ['ladderPct', 'Gap between conditions (0.05 = 5%)'], ['labelW', 'Barcode label width (mm)'], ['labelH', 'Barcode label height (mm)'], ['grams', 'Shopify weight (grams)']];
    const ins = Object.fromEntries(F.map(([k]) => [k, h('input', { type: 'number', step: 'any', value: e[k] })]));
    const status = sel(['draft', 'active'], e.status);
    const next = h('input', { type: 'number', value: d.next });
    const letters = Object.fromEntries(Object.entries(e.letters).map(([k, x]) => [k, h('input', { value: x, style: { width: '70px' } })]));
    const save = () => act(() => POST('/api/list/econ', Object.assign(Object.assign({}, Object.fromEntries(Object.entries(ins).map(([k, el]) => [k, el.value]))), { status: status.value, next: next.value, letters: Object.fromEntries(Object.entries(letters).map(([k, el]) => [k, el.value.trim().toUpperCase()])) })), 'Saved').then(() => VIEWS.list(['costs']));
    render(head, h('div', { class: 'kpis' }, kpi('Ads per sold pair', rs(d.perPair.ads)), kpi('Rent & salaries per pair', rs(d.perPair.fixed)), kpi('Profit target per pair', rs(d.perPair.profit)), kpi('Kept after coupons & COD', Math.round(d.perPair.keep * 1000) / 10 + '%')), h('div', { class: 'card' }, h('h2', null, 'Costs used for every price', h('small', null, 'change them when your monthly numbers change; prices follow at once')), h('div', { class: 'fgrid' }, F.map(([k, l]) => field(l, ins[k])), field('New pairs go to Shopify as', status)), h('h2', { style: { marginTop: '14px' } }, 'SKU numbers'), h('div', { class: 'fgrid' }, field('Next SKU number', next), Object.entries(letters).map(([k, el]) => field(k + ' letter', el))), h('div', { class: 'small muted' }, 'If you also listed pairs in the old Lister, set the next number above the last SKU used there so no number repeats.'), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: save }, 'Save'), h('button', { class: 'btn ghost', onclick: () => printLabels(['H-12345'], ins.labelW.value, ins.labelH.value) }, 'Test print a label'))));
}
registerView({ key: 'list', title: 'List pairs', group: 'Stock line', perm: 'listing', icon: 'tag', order: 20 }, VIEWS.list);
VIEWS.listing = async (args) => {
    let tab = args[0] || 'lots';
    const head = tabs([['lots', 'Lots'], ['markdown', 'Price suggestions'], ['history', 'Price changes'], ['rules', 'Pricing rules']], tab, t => { location.hash = '#/listing/' + t; });
    if (tab === 'lots') {
        const lots = await GET('/api/lots');
        const edit = l => {
            const v = h('input', { value: l.vendor }), b = h('input', { type: 'date', value: l.bought_on }), c = h('input', { type: 'number', value: l.cost || '' }), p = h('input', { type: 'number', value: l.pieces || '' }), n = h('input', { value: l.note });
            const m = modal(l.lot, h('div', { class: 'grid' }, field('Vendor', v), field('Bought on', b), field('Total lot cost (Rs)', c), field('Pieces in the lot', p), field('Note', n), h('div', { class: 'small muted' }, 'Without a total cost, the sum of item costs from Shopify is used.')), [h('button', { class: 'btn', onclick: () => act(() => POST('/api/lots/' + encodeURIComponent(l.lot), { vendor: v.value, bought_on: b.value, cost: c.value, pieces: p.value, note: n.value }), 'Saved').then(() => { m.remove(); VIEWS.listing(['lots']); }) }, 'Save')]);
        };
        const tot = lots.reduce((a, l) => ({ cost: a.cost + l.cost, rev: a.rev + l.revenue, stock: a.stock + (l.stock_value || 0) }), { cost: 0, rev: 0, stock: 0 });
        return render(head, h('div', { class: 'kpis' }, kpi('Lots', num(lots.length)), kpi('Money spent on lots', rs(tot.cost)), kpi('Delivered sales from lots', rs(tot.rev)), kpi('Unsold stock (at price)', rs(tot.stock))), h('div', { class: 'card' }, h('h2', null, 'Every lot: is it paying back?', h('small', null, 'lots come from the "Lot" tag on Shopify products · click to add vendor & cost')), table([{ t: 'Lot', f: l => [h('strong', null, l.lot), h('div', { class: 'small muted' }, [l.vendor, l.bought_on && day(l.bought_on)].filter(Boolean).join(' · '))] },
            { t: 'Listed', n: 1, f: l => [num(l.listed), l.unlisted ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, l.unlisted + ' not listed') : ''] },
            { t: 'Sold', n: 1, f: l => num(l.sold) }, { t: 'Sell-through', f: l => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, bar(l.sellThrough), h('span', { class: 'small' }, l.sellThrough + '%')) },
            { t: 'Returns', n: 1, f: l => num(l.returns) }, { t: 'Cost', n: 1, f: l => rs(l.cost) }, { t: 'Delivered sales', n: 1, f: l => rs(l.revenue) },
            { t: 'Paid back', n: 1, f: l => h('span', { style: { color: l.profit >= 0 ? 'var(--ok)' : 'var(--bad)', fontWeight: 600 } }, l.cost ? pct(l.revenue, l.cost) : '–') },
            { t: 'Unsold stock', n: 1, f: l => rs(l.stock_value) }], lots, can('listing') ? edit : null)));
    }
    if (tab === 'rules') {
        const r = await GET('/api/pricing/rules');
        const rows = h('div', { class: 'grid' });
        const addStep = (s = { days: '', off: '' }) => rows.append(h('div', { class: 'row step' }, 'After', h('input', { type: 'number', value: s.days, style: { width: '80px' }, class: 'd' }), 'days on site, mark down', h('input', { type: 'number', value: s.off, style: { width: '70px' }, class: 'o' }), '% from the original price', h('button', { class: 'btn ghost sm', onclick: e => e.target.closest('.step').remove() }, 'Remove')));
        r.steps.forEach(addStep);
        const mm = h('input', { type: 'number', value: r.minMargin, style: { width: '80px' } }), rt = h('input', { type: 'number', value: r.roundTo, style: { width: '80px' } }), e99 = h('input', { type: 'checkbox', checked: r.endWith99 });
        const fl = h('input', { type: 'number', value: r.fastLot, style: { width: '70px' } }), fr = h('input', { type: 'number', value: r.fastLotRelief, style: { width: '70px' } });
        return render(head, h('div', { class: 'card grid' }, h('h2', null, 'Markdown steps'), rows, h('div', null, h('button', { class: 'btn ghost sm', onclick: () => addStep() }, '+ Add step')), h('div', { class: 'row' }, 'Never go below cost +', mm, '% margin'), h('div', { class: 'row' }, 'Round prices to', rt, h('label', { class: 'row' }, e99, 'end with 99 (e.g. 2,999)')), h('div', { class: 'row' }, 'If a lot has already sold', fl, '% of its pieces, mark down', fr, '% less (it is selling fine)'), h('div', null, h('button', { class: 'btn', onclick: () => act(() => POST('/api/pricing/rules', { steps: [...rows.querySelectorAll('.step')].map(s => ({ days: +s.querySelector('.d').value, off: +s.querySelector('.o').value })).filter(s => s.days || s.off), minMargin: +mm.value, roundTo: +rt.value || 100, endWith99: e99.checked, fastLot: +fl.value, fastLotRelief: +fr.value }), 'Rules saved') }, 'Save rules'))));
    }
    if (tab === 'history') {
        const r = await GET('/api/pricing/history');
        return render(head, h('div', { class: 'card' }, table([{ t: 'When', f: x => dt(x.at) }, { t: 'SKU', f: x => h('span', { class: 'mono' }, x.sku) }, { t: 'Old', n: 1, f: x => rs(x.old_price) }, { t: 'New', n: 1, f: x => rs(x.new_price) }, { t: 'Was (shown crossed out)', n: 1, f: x => rs(x.compare_at) }, { t: 'By', k: 'user' }, { t: 'Shopify', f: x => x.pushed ? h('span', { class: 'b ok' }, 'updated') : h('span', { class: 'b bad', title: x.error || '' }, 'failed') }, { t: 'Note', k: 'error' }], r)));
    }
    // markdown suggestions
    const lots = await GET('/api/lots');
    const lotSel = h('select', null, h('option', { value: '' }, 'All lots'), lots.map(l => h('option', { value: l.lot }, l.lot)));
    const box = h('div');
    const load = async () => {
        const d = await GET('/api/pricing/suggestions?' + qs({ lot: lotSel.value }));
        const sel = new Set(), inputs = {};
        const applyBtn = h('button', { class: 'btn', disabled: true }, 'Apply selected');
        const upd = () => { applyBtn.disabled = !sel.size; applyBtn.textContent = sel.size ? `Apply ${sel.size} new price${sel.size > 1 ? 's' : ''} to Shopify` : 'Apply selected'; };
        applyBtn.onclick = async () => {
            if (!confirm(`Change ${sel.size} prices on the live Shopify store? The old price is kept as the crossed-out price.`))
                return;
            const items = [...sel].map(id => ({ variant_id: id, price: +inputs[id].value }));
            const r = await act(() => POST('/api/pricing/apply', { items }));
            toast(`${r.ok} prices updated` + (r.failed.length ? ` · ${r.failed.length} failed` : ''));
            load();
        };
        const all = h('input', { type: 'checkbox', onchange: e => { box.querySelectorAll('input.pick').forEach(c => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); } });
        box.replaceChildren(h('div', { class: 'row sp', style: { marginBottom: '8px' } }, h('span', { class: 'muted small' }, `${num(d.total)} items are due for a markdown by your rules`), can('pricing_apply') ? applyBtn : h('span', { class: 'small muted' }, 'Ask the owner to push prices')), table([{ t: h('span', null, all), f: r => h('input', { type: 'checkbox', class: 'pick', onchange: e => { e.target.checked ? sel.add(r.variant_id) : sel.delete(r.variant_id); upd(); } }) },
            { t: 'Item', f: r => [h('span', { class: 'mono small' }, r.sku), ' ', r.title, h('div', { class: 'small muted' }, [r.size, r.cond, r.lot].filter(Boolean).join(' · '))] },
            { t: 'On site', n: 1, f: r => r.age + ' days' }, { t: 'Original', n: 1, f: r => rs(r.base) }, { t: 'Now', n: 1, f: r => rs(r.price) },
            { t: 'New price', n: 1, f: r => (inputs[r.variant_id] = h('input', { type: 'number', value: r.target, style: { width: '96px', textAlign: 'right' } })) },
            { t: 'Off', n: 1, f: r => r.pct + '%' }, { t: 'Lowest allowed', n: 1, f: r => rs(r.floor) }], d.rows));
    };
    lotSel.addEventListener('change', load);
    render(head, h('div', { class: 'card' }, h('div', { class: 'row' }, lotSel, h('span', { class: 'small muted' }, 'Older stock gets cheaper step by step. Edit any price before applying.')), h('div', { style: { marginTop: '10px' } }, box)));
    await load();
};
registerView({ key: 'listing', title: 'Lots & pricing', group: 'Stock line', perm: 'listing', icon: 'layers', order: 90 }, VIEWS.listing);
/* ---------- Purchasing: PO forms (lot with the planner verdict, supplies), PO page, print / WhatsApp, receive, settle, bill, pay; GRN hooks for WMS Receiving ---------- */
function purSel(opts, val, attrs) { return h('select', attrs || null, opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(val !== null && val !== void 0 ? val : '') }, l); })); }
const purNum = (v, ph, w) => h('input', { type: 'number', step: 'any', min: 0, value: v !== null && v !== void 0 ? v : '', placeholder: ph || '', style: w ? { width: w } : null });
function purTermsInputs(t) {
    const terms = purSel([['cash', 'Cash on delivery'], ['credit', 'Credit (pay later)'], ['instalments', 'Instalments']], t.terms || 'cash');
    const days = purNum(t.credit_days || 30, 'days'), inst = purNum(t.instalments || 3, 'how many');
    const fDays = field('Credit days', days), fInst = field('Number of instalments', inst);
    const upd = () => { fDays.hidden = terms.value !== 'credit'; fInst.hidden = terms.value !== 'instalments'; };
    terms.addEventListener('change', upd);
    upd();
    return { terms, days, inst, nodes: [field('Payment terms', terms), fDays, fInst], set(s) { terms.value = s.terms || 'cash'; if (s.credit_days)
            days.value = s.credit_days; if (s.instalments)
            inst.value = s.instalments; upd(); },
        val: () => ({ terms: terms.value, credit_days: +days.value || null, instalments: +inst.value || null }) };
}
function purFiles(ids) {
    const files = [...(ids || [])], inp = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true }), list = h('div', { class: 'row small' });
    const draw = () => purFill(list, files.map((id, i) => h('span', null, fileLink(id), ' ', h('a', { href: '#', onclick: e => { e.preventDefault(); files.splice(i, 1); draw(); } }, '×'))));
    inp.addEventListener('change', async () => { for (const f of inp.files) {
        try {
            files.push(await uploadFile(f));
        }
        catch (e) {
            toast(e.message, true);
        }
    } inp.value = ''; draw(); });
    draw();
    return { node: h('div', { class: 'stack' }, inp, list), files };
}
// small editable rows (mix, extra costs, supply lines)
function purRows(make, initial, addLabel, onChange) {
    const box = h('div', { class: 'stack' }), rows = [];
    const add = (v = {}) => { const r = make(v, () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); onChange && onChange(); }); r.el.addEventListener('input', () => onChange && onChange()); r.el.addEventListener('change', () => onChange && onChange()); rows.push(r); box.append(r.el); onChange && onChange(); return r; };
    (initial || []).forEach(v => add(v));
    return { node: h('div', { class: 'stack' }, box, h('div', null, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => add() }, addLabel))), rows, add, val: () => rows.map(r => r.val()) };
}
const purX = del => h('button', { class: 'btn ghost sm', type: 'button', title: 'Remove', onclick: del }, '×');
async function purPoForm(kind, id, preSupplier) {
    const m = await purMeta();
    let po = null;
    if (id) {
        const d = await GET('/api/pur/pos/' + id);
        po = d.po;
        kind = po.kind;
        if (!d.can.edit) {
            location.hash = '#/purchasing/po/' + id;
            return;
        }
    }
    if (!m.can.create)
        return render(h('div', { class: 'note warn' }, 'Only listing or warehouse staff can create purchase orders.'));
    const sups = m.suppliers.filter(s => s.active || (po && s.name === po.supplier));
    const wanted = kind === 'lot' ? s => s.type === 'lots' || s.type === 'other' : s => s.type !== 'lots';
    const supSel = h('select', null, h('option', { value: '' }, 'Choose supplier…'), sups.filter(wanted).map(s => h('option', { value: s.name, selected: s.name === (po ? po.supplier : preSupplier) }, s.name)), sups.filter(s => !wanted(s)).length ? h('optgroup', { label: 'Other suppliers' }, sups.filter(s => !wanted(s)).map(s => h('option', { value: s.name, selected: s.name === (po ? po.supplier : preSupplier) }, s.name))) : null);
    const addSup = m.can.supplier ? h('a', { href: '#', class: 'small', style: { fontWeight: 600 }, onclick: e => { e.preventDefault(); purSupplierForm(null, async (r) => { await purMeta(true); location.hash = `#/purchasing/new/${kind}/${encodeURIComponent(r.name)}`; VIEWS.purchasing(['new', kind, r.name]); }); } }, '+ New supplier') : null;
    const supField = h('label', { class: 'f' }, h('span', { class: 'row sp', style: { color: 'var(--muted)', fontSize: '12px', fontWeight: 500 } }, h('span', null, 'Supplier *'), addSup), supSel);
    const terms = purTermsInputs(po || {});
    const exp = h('input', { type: 'date', value: po ? po.expected_date || '' : '' }), notes = h('textarea', { placeholder: kind === 'lot' ? 'e.g. mostly Nike/Adidas sneakers, sample photos attached' : 'e.g. print the new logo on the boxes' }, po ? po.notes || '' : '');
    const files = purFiles(po ? po.files : []), adv = purNum(po ? po.advance_plan || '' : '', 'Rs');
    const err = h('div', { class: 'flash bad', hidden: true });
    const fillTerms = () => { const s = m.suppliers.find(x => x.name === supSel.value); if (s && !po)
        terms.set(s); };
    let body, collect, side = null;
    if (kind === 'lot') {
        const lotName = h('input', { value: po ? po.lot_name : '', placeholder: 'e.g. SH-Lot 25' }), lotKind = purSel([['used', 'Used (pre-owned)'], ['leftover', 'Left-over / new']], po ? po.lot_kind : 'used');
        const pieces = purNum(po ? po.pieces : '', 'pairs'), pricing = purSel([['per_piece', 'Price per piece'], ['lump', 'Lump sum for the lot']], po ? po.pricing : 'per_piece');
        const rate = purNum(po ? po.rate : '', 'Rs per piece'), lump = purNum(po ? po.lump : '', 'Rs for the whole lot'), bad = purNum(po ? po.bad_est : '', 'pairs');
        const fRate = field('Price per piece (Rs)', rate), fLump = field('Lump sum (Rs)', lump), total = h('div', { class: 'small muted' });
        const mixInfo = h('div', { class: 'small muted' });
        const verdictBox = h('div'), kvBox = h('div'), rowsBox = h('div');
        let timer = null, ready = false;
        const costNote = h('div', { class: 'small muted', style: { marginTop: '10px' } });
        const recalc = () => {
            if (!ready)
                return;
            fRate.hidden = pricing.value !== 'per_piece';
            fLump.hidden = pricing.value !== 'lump';
            const pc = +pieces.value || 0, cost = pricing.value === 'lump' ? +lump.value || 0 : (+rate.value || 0) * pc;
            total.textContent = cost ? `Lot price ${rs(cost)}` + (pc && pricing.value === 'lump' ? ` · ${rs(cost / pc)} a piece` : '') : '';
            const mn = mix.val().reduce((s, r) => s + (+r.n || 0), 0);
            mixInfo.textContent = mn ? `Mix covers ${num(mn)} of ${num(pc)} pairs` + (pc && mn !== pc ? ' (the rest is assumed to be like the mix)' : '') : 'Tell the planner what is in the lot: types, men/women and condition.';
            clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    const p = await POST('/api/pur/plan', collect(true));
                    purFill(verdictBox, purVerdict(p, true));
                    purFill(kvBox, purPlanKv(p));
                    purFill(rowsBox, purPlanRows(p));
                    costNote.textContent = `Uses what customers paid for each type and condition, the sale plan (40% at full price, then 10–40% off), and per sold pair: ads ${rs(p.perPairCosts.ads)}, courier, COD, packing and ${rs(p.perPairCosts.overheads)} share of rent & salaries.`;
                }
                catch (e) {
                    purFill(verdictBox, h('div', { class: 'note bad' }, e.message));
                }
            }, 300);
        };
        const mix = purRows((v, del) => {
            const t = purSel(m.types, v.t || 'Running'), g = purSel(['Woman', 'Men', 'Kids'], v.g || 'Woman'), c = purSel(m.conds, v.c || 'Excellent'), n = purNum(v.n, 'pairs', '84px'), b = h('input', { value: v.b || '', placeholder: 'brand (optional)', style: { width: '130px' } });
            return { el: h('div', { class: 'row', style: { flexWrap: 'wrap' } }, n, t, g, c, b, purX(del)), val: () => ({ t: t.value, g: g.value, c: c.value, n: +n.value || 0, b: b.value.trim() }) };
        }, po && po.mix.length ? po.mix : [{ t: 'Running', g: 'Men', c: 'Excellent' }], '+ Add type', recalc);
        const extras = purRows((v, del) => {
            const l = h('input', { value: v.label || '', placeholder: 'e.g. Transport', style: { flex: '1 1 0', minWidth: '0', width: '100%' } }), a = purNum(v.amount, 'Rs', '96px');
            a.style.flex = '0 0 96px';
            return { el: h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, l, a, purX(del)), val: () => ({ label: l.value.trim(), amount: +a.value || 0 }) };
        }, po ? po.extras : [{ label: 'Transport / cartage' }, { label: 'Cleaning & repair' }], '+ Add cost', recalc);
        [pieces, pricing, rate, lump, bad, lotKind].forEach(e => { e.addEventListener('input', recalc); e.addEventListener('change', recalc); });
        supSel.addEventListener('change', async () => { fillTerms(); if (supSel.value && !po) {
            lotName.value = (await GET('/api/pur/next-lot?supplier=' + encodeURIComponent(supSel.value))).name;
            recalc();
        } });
        if (!po && supSel.value)
            GET('/api/pur/next-lot?supplier=' + encodeURIComponent(supSel.value)).then(r => { if (!lotName.value)
                lotName.value = r.name; });
        fillTerms();
        collect = quiet => (Object.assign({ id: po ? po.id : undefined, kind: 'lot', supplier: supSel.value, lot_name: lotName.value.trim(), lot_kind: lotKind.value, pieces: +pieces.value || 0, pricing: pricing.value, rate: +rate.value || null, lump: +lump.value || null, bad_est: +bad.value || 0, mix: mix.val().filter(r => r.n > 0), extras: extras.val().filter(e => e.amount > 0), expected_date: exp.value, advance_plan: +adv.value || 0, notes: notes.value, files: files.files }, terms.val()));
        body = [h('div', { class: 'card' }, h('h2', null, 'Supplier & lot'), h('div', { class: 'fgrid' }, supField, field('Lot name *', lotName), field('Kind', lotKind), field('Expected pieces *', pieces), field('Pricing', pricing), fRate, fLump, field('Expected bad pairs', bad)), total),
            h('div', { class: 'card' }, h('h2', null, 'Expected mix', h('small', null, 'what you saw in the bale / sample')), mix.node, mixInfo),
            h('div', { class: 'card' }, h('h2', null, 'Extra costs', h('small', null, 'added to the cost of the pairs')), extras.node),
            h('div', { class: 'card' }, h('h2', null, 'Delivery & payment'), h('div', { class: 'fgrid' }, field('Expected delivery', exp), field('Advance to pay (Rs)', adv), ...terms.nodes, h('label', { class: 'f full' }, 'Photos / samples', files.node), h('label', { class: 'f full' }, 'Notes', notes)))];
        side = h('div', { class: 'card ticket' }, h('h2', null, 'Should we buy it?', h('small', null, "the store's own prices & costs")), verdictBox, kvBox, rowsBox, costNote);
        ready = true;
        recalc();
    }
    else {
        const tot = h('strong');
        let ready = false;
        const recalc = () => { if (!ready)
            return; tot.textContent = rs(lines.val().reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0)); };
        const lines = purRows((v, del) => {
            const it = h('input', { value: v.item || '', placeholder: 'e.g. Shoe box (medium)', class: 'grow', style: { minWidth: '160px' } }), qn = purNum(v.qty, 'qty', '80px'), un = h('input', { value: v.unit || 'pcs', style: { width: '64px' } }), rt = purNum(v.rate, 'rate', '90px');
            const amt = h('span', { class: 'small muted', style: { minWidth: '80px', textAlign: 'right' } }), sh = () => { amt.textContent = (+qn.value || 0) * (+rt.value || 0) ? rs((+qn.value || 0) * (+rt.value || 0)) : ''; };
            qn.addEventListener('input', sh);
            rt.addEventListener('input', sh);
            sh();
            return { el: h('div', { class: 'row' }, it, qn, un, rt, amt, purX(del)), val: () => ({ item: it.value.trim(), qty: +qn.value || 0, unit: un.value.trim(), rate: +rt.value || 0 }) };
        }, po ? (await GET('/api/pur/pos/' + po.id)).lines : [{}], '+ Add item', recalc);
        supSel.addEventListener('change', fillTerms);
        fillTerms();
        collect = () => (Object.assign({ id: po ? po.id : undefined, kind: 'supplies', supplier: supSel.value, lines: lines.val().filter(l => l.item && l.qty > 0), expected_date: exp.value, notes: notes.value, files: files.files, advance_plan: +adv.value || 0 }, terms.val()));
        ready = true;
        body = [h('div', { class: 'card' }, h('h2', null, 'Supplier'), h('div', { class: 'fgrid' }, supField, field('Expected delivery', exp), ...terms.nodes)),
            h('div', { class: 'card' }, h('h2', null, 'Items', h('small', null, 'item · quantity · unit · rate')), lines.node, h('div', { class: 'row sp', style: { marginTop: '10px' } }, h('span', { class: 'muted' }, 'Total'), tot)),
            h('div', { class: 'card' }, h('div', { class: 'fgrid' }, field('Advance to pay (Rs)', adv), h('label', { class: 'f full' }, 'Files (quotation, sample)', files.node), h('label', { class: 'f full' }, 'Notes', notes)))];
        recalc();
    }
    const save = async (submit) => {
        err.hidden = true;
        try {
            const r = await POST('/api/pur/pos', Object.assign(Object.assign({}, collect()), { submit: submit && !po }));
            if (submit && po && po.status === 'draft')
                await POST(`/api/pur/pos/${r.id}/submit`);
            toast(submit ? `${r.no} sent for approval` : `${r.no} saved`);
            location.hash = '#/purchasing/po/' + r.id;
        }
        catch (e) {
            err.hidden = false;
            err.textContent = e.message;
            window.scrollTo(0, 0);
        }
    };
    const acts = h('div', { class: 'card' }, h('div', { class: 'row' }, h('button', { class: 'btn big', onclick: () => save(true) }, po && po.status === 'submitted' ? 'Save changes' : 'Send for approval'), !po || po.status === 'draft' ? h('button', { class: 'btn ghost', onclick: () => save(false) }, 'Save draft') : null, h('a', { class: 'btn ghost', href: po ? '#/purchasing/po/' + po.id : '#/purchasing' }, 'Cancel')));
    const title = (po ? 'Edit ' + po.no : kind === 'lot' ? 'New lot purchase order' : 'New supplies purchase order');
    const head = pageHead(title, kind === 'lot' ? 'A bale of pairs from a lot supplier. The owner approves it before it is confirmed.' : 'Boxes, flyers, labels, cleaning material…', purBack('#/purchasing'));
    if (side)
        render(head, err, h('div', { class: 'listgrid' }, h('div', { class: 'stack', style: { gap: '16px' } }, body, acts), side));
    else
        render(head, err, body, acts);
}
function purWaText(d) {
    const p = d.po, store = (PUR_META && PUR_META.store) || META.store || 'SundayBazar';
    const L = [`*Purchase order ${p.no}* — ${store}`];
    if (p.kind === 'lot') {
        L.push(`Lot: ${p.lot_name} · ${num(p.pieces)} pairs`);
        L.push(p.pricing === 'lump' ? `Price: ${rs(p.lump)} for the lot` : `Price: ${rs(p.rate)} per piece = ${rs(p.amount)}`);
        if (p.mix.length)
            L.push('Mix: ' + p.mix.map(r => `${r.n} ${r.t} (${r.g}, ${r.c})`).join(', '));
    }
    else {
        for (const l of d.lines)
            L.push(`• ${l.item}: ${num(l.qty)} ${l.unit} × ${rs(l.rate)} = ${rs(l.qty * l.rate)}`);
        L.push(`Total: ${rs(p.amount)}`);
    }
    if (p.expected_date)
        L.push(`Delivery by: ${day(p.expected_date)}`);
    L.push(`Terms: ${p.terms === 'credit' ? `credit ${p.credit_days} days` : p.terms === 'instalments' ? `${p.instalments} instalments` : 'cash on delivery'}` + (p.advance_plan ? ` · advance ${rs(p.advance_plan)}` : ''));
    if (p.notes)
        L.push(p.notes);
    return L.join('\n');
}
const purWaHref = d => waLink(String((d.supplier && d.supplier.whatsapp) || '').replace(/\D/g, ''), purWaText(d));
async function purPoPage(id) {
    const d = await GET('/api/pur/pos/' + id), p = d.po, cn = d.can, mo = d.money, m = await purMeta();
    const go = () => VIEWS.purchasing(['po', id]);
    const doPost = (path, body, msg) => act(() => POST(`/api/pur/pos/${p.id}/${path}`, body || {}), msg).then(go);
    const btns = [
        cn.edit ? h('a', { class: 'btn ghost', href: '#/purchasing/edit/' + p.id }, 'Edit') : null,
        cn.submit ? h('button', { class: 'btn', onclick: () => doPost('submit', null, 'Sent for approval') }, 'Send for approval') : null,
        cn.approve ? h('button', { class: 'btn ok', onclick: () => { if (confirm(`Approve ${p.no} for ${rs(p.amount)}?` + (p.kind === 'lot' && p.plan && p.plan.verdict === 'dont' ? "\n\nThe planner says DON'T BUY at this price." : '')))
                doPost('approve', null, 'Approved'); } }, 'Approve') : null,
        cn.send ? h('a', { class: 'btn', href: purWaHref(d), target: '_blank', onclick: () => POST(`/api/pur/pos/${p.id}/send`, { via: 'whatsapp' }).then(() => setTimeout(go, 400)) }, 'Send on WhatsApp') : null,
        ['approved', 'sent', 'partial', 'received', 'billed', 'closed'].includes(p.status) ? h('a', { class: 'btn ghost', href: '#/purchasing/print/' + p.id }, 'Print PO') : null,
        cn.receive ? h('button', { class: 'btn', onclick: () => purReceiveSupplies(d, go) }, 'Receive') : null,
        cn.receiveLot && !d.grn ? h('button', { class: 'btn', onclick: () => purOpenGrn(p.lot_name) }, 'Receive lot (GRN)') : null,
        cn.advance ? h('button', { class: 'btn ghost', onclick: () => purPayModal(`Advance to ${p.supplier}`, `/api/pur/pos/${p.id}/advance`, { amount: p.advance_plan || '' }, go) }, 'Pay advance') : null,
        cn.settle && !p.settlement ? h('button', { class: 'btn warn', onclick: () => purSettleModal(d, go) }, 'Settle difference') : null,
        cn.bill ? h('button', { class: 'btn', onclick: () => purBillModal(d, go) }, d.bill ? 'Edit bill' : 'Enter bill') : null,
        d.bill && d.bill.due > 0.5 && m.can.money ? h('button', { class: 'btn ok', onclick: () => purPayModal(`Pay ${p.supplier}`, `/api/pur/bills/${d.bill.id}/pay`, { amount: d.bill.nextAmount, max: d.bill.due }, go) }, 'Pay bill') : null,
        cn.close ? h('button', { class: 'btn ghost', onclick: () => { if (confirm('Close this PO? Use it when the supplier will not be paid the rest (settled outside).'))
                doPost('close', null, 'Closed'); } }, 'Close') : null,
        cn.cancel ? h('button', { class: 'btn ghost', onclick: () => formModal('Cancel ' + p.no, [{ k: 'reason', label: 'Why is it cancelled?', required: true, full: true }], v => POST(`/api/pur/pos/${p.id}/cancel`, v).then(() => { toast('Cancelled'); go(); }), 'Cancel PO') }, 'Cancel PO') : null
    ];
    const flow = ['draft', 'submitted', 'approved', 'sent', p.kind === 'supplies' ? 'partial' : null, 'received', 'billed', 'closed'].filter(Boolean), at = flow.indexOf(p.status);
    const steps = p.status === 'cancelled' ? h('div', { class: 'note bad' }, `Cancelled ${dt(p.cancelled_at)}${p.cancelled_name ? ' by ' + p.cancelled_name : ''}: ${p.cancel_reason || ''}`)
        : h('div', { class: 'steps' }, flow.map((s, i) => h('span', { class: i <= at ? 'on' : '' }, (PUR_ST[s] || [s])[0])));
    const kv = (l, v) => v == null || v === '' || v === false ? null : [h('dt', null, l), h('dd', null, v)];
    const details = h('div', { class: 'card' }, h('h2', null, 'Order'), h('dl', { class: 'dl' }, kv('Supplier', d.supplier.id ? h('a', { href: '#/suppliers/s/' + d.supplier.id }, p.supplier) : p.supplier), p.kind === 'lot' ? [kv('Lot', [h('strong', null, p.lot_name), ' ', h('span', { class: 'muted small' }, p.lot_kind === 'leftover' ? 'left-over' : 'used'), m.can.owner && d.lot ? [' · ', h('a', { href: '#/purchasing/lot/' + encodeURIComponent(p.lot_name) }, 'lot profit')] : null]),
        kv('Pieces', `${num(p.pieces)} pairs` + (p.bad_est ? ` (${num(p.bad_est)} expected bad)` : '')), kv('Price', p.pricing === 'lump' ? `${rs(p.lump)} lump sum (${rs(p.lump / p.pieces)} a piece)` : `${rs(p.rate)} per piece`),
        kv('Expected mix', p.mix.length ? p.mix.map(r => `${r.n} ${r.t} (${r.g}, ${r.c}${r.b ? ', ' + r.b : ''})`).join(' · ') : null), kv('Extra costs', p.extras.length ? p.extras.map(e => `${e.label} ${rs(e.amount)}`).join(' · ') : null)] : null, kv('Amount', h('strong', null, rs(p.amount))), kv('Expected delivery', p.expected_date ? day(p.expected_date) : null), kv('Payment terms', p.terms === 'credit' ? `Credit ${p.credit_days} days` : p.terms === 'instalments' ? `${p.instalments} instalments` : 'Cash on delivery'), kv('Advance to pay', p.advance_plan ? rs(p.advance_plan) : null), kv('Created', `${dt(p.created_at)} · ${p.created_name}`), kv('Approved', p.approved_at ? `${dt(p.approved_at)} · ${p.approved_name}` : null), kv('Sent', p.sent_at ? dt(p.sent_at) : null), kv('Received', p.received_on ? day(p.received_on) : null), kv('Notes', p.notes), kv('Files', p.files.length ? h('span', { class: 'row' }, p.files.map(fileLink)) : null)), p.post_error ? h('div', { class: 'note bad', style: { marginTop: '8px' } }, 'Accounts: ' + p.post_error) : null);
    const verdict = p.kind === 'lot' && p.plan ? h('div', { class: 'card' }, h('h2', null, 'Planner verdict', h('small', null, 'when the PO was saved')), purVerdict(p.plan), purPlanKv(p.plan), purPlanRows(p.plan)) : null;
    const lines = p.kind === 'supplies' ? h('div', { class: 'card' }, h('h2', null, 'Items'), table([{ t: 'Item', k: 'item' }, { t: 'Ordered', n: 1, f: l => `${num(l.qty)} ${l.unit}` }, { t: 'Received', n: 1, f: l => h('span', { class: l.received < l.qty && ['partial', 'received', 'billed', 'closed'].includes(p.status) ? 'neg' : '' }, num(l.received)) },
        { t: 'Rate', n: 1, f: l => rs(l.rate) }, { t: 'Amount', n: 1, f: l => rs(l.qty * l.rate) }], d.lines)) : null;
    const g = d.grn;
    const grn = g ? h('div', { class: 'card' }, h('h2', null, 'PO vs GRN', h('small', null, 'what was ordered vs what arrived')), purDiffTable(g), p.settlement ? h('div', { class: 'note ok', style: { marginTop: '10px' } }, purSettleText(p.settlement, d.debitNotes)) : !g.ok ? h('div', { class: 'note warn', style: { marginTop: '10px' } }, 'Difference not settled with the supplier yet.' + (g.claim ? ` Suggested claim ${rs(g.claim)}.` : '')) : null) : null;
    const money = mo ? h('div', { class: 'card' }, h('h2', null, 'Money'), h('dl', { class: 'kv' }, h('dt', null, 'PO amount'), h('dd', null, rs(p.amount)), mo.billed != null ? [h('dt', null, 'Bill'), h('dd', null, rs(mo.billed))] : null, mo.debitNotes ? [h('dt', null, 'Debit notes'), h('dd', null, '− ' + rs(mo.debitNotes))] : null, mo.net != null ? [h('dt', null, 'Net payable'), h('dd', null, h('strong', null, rs(mo.net)))] : null, h('dt', null, 'Advance paid'), h('dd', null, rs(mo.advance)), mo.billed != null ? [h('dt', null, 'Paid on the bill'), h('dd', null, rs(mo.paidOnBill)), h('div', { class: 'sep' }), h('dt', null, 'Still to pay'), h('dd', { class: mo.due > 0.5 ? 'neg' : 'pos' }, h('strong', null, rs(mo.due)))] : null), d.bill ? purBillBox(d.bill) : null, d.payments.length ? h('div', { style: { marginTop: '10px' } }, table([{ t: 'Date', f: x => day(x.date) }, { t: 'What', f: x => x.kind === 'advance' ? 'Advance' : 'Payment' }, { t: 'From', k: 'account' }, { t: 'Ref', k: 'ref' }, { t: 'Amount', n: 1, f: x => rs(x.amount) }], d.payments)) : null) : null;
    const hist = d.history.length ? h('div', { class: 'card' }, h('h2', null, 'History'), h('div', { class: 'timeline' }, d.history.map(e => h('div', null, h('div', null, purActLabel(e.action), e.user ? ' · ' + e.user : ''), h('div', { class: 't' }, dt(e.at)))))) : null;
    render(pageHead(`${p.no} · ${p.kind === 'lot' ? p.lot_name : 'Supplies'}`, p.supplier, purBack('#/purchasing/list/open', 'Orders')), steps, h('div', { class: 'row' }, btns), !d.supplier.whatsapp && cn.send ? h('div', { class: 'small muted' }, 'No WhatsApp number saved for this supplier: WhatsApp will ask who to send it to.') : null, h('div', { class: 'two' }, h('div', { class: 'stack', style: { gap: '16px' } }, details, lines, grn), h('div', { class: 'stack', style: { gap: '16px' } }, money, verdict, hist)));
}
const PUR_ACT = { 'pur.po.create': 'Created', 'pur.po.edit': 'Edited', 'pur.po.submit': 'Sent for approval', 'pur.po.approve': 'Approved', 'pur.po.send': 'Sent to supplier', 'pur.po.cancel': 'Cancelled', 'pur.po.close': 'Closed',
    'pur.po.receive': 'Received', 'pur.advance': 'Advance paid', 'pur.bill': 'Bill entered', 'pur.pay': 'Payment', 'pur.settle': 'Difference settled' };
const purActLabel = a => PUR_ACT[a] || a;
function purDiffTable(g) {
    const r = (l, a, b, cls) => h('tr', null, h('td', null, l), h('td', { class: 'n' }, a), h('td', { class: 'n ' + (cls || '') }, b));
    return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'n' }, 'PO'), h('th', { class: 'n' }, 'Arrived'))), h('tbody', null, r('Pieces', num(g.expected), num(g.received), g.short ? 'neg' : g.extra ? 'pos' : ''), r('Damaged', num(g.expBad) + ' expected', num(g.damaged), g.extraDamaged ? 'neg' : ''), r('Good pairs', num(g.expected - g.expBad), num(g.good)), g.short ? r('Short', '', num(g.short), 'neg') : null, g.extra ? r('Extra pieces', '', num(g.extra), 'pos') : null, g.extraDamaged ? r('Damaged beyond expected', '', num(g.extraDamaged), 'neg') : null, g.billFor != null ? r('To be billed', '', rs(g.billFor)) : null, g.claim ? r('Suggested claim', '', rs(g.claim), 'neg') : null)));
}
function purSettleText(s, dns) {
    const dn = (dns || []).find(x => x.id === s.dn);
    return s.choice === 'loss' ? `Accepted as loss on ${dt(s.at)}.` + (s.note ? ' ' + s.note : '')
        : `${s.choice === 'return' ? 'Damaged pairs returned to the supplier' : 'Supplier gave a discount'}: debit note DN-${String(s.dn).padStart(4, '0')}${dn ? ' for ' + rs(dn.amount) : ''}` + (s.transfer ? ` · transfer T-${s.transfer}` : '') + (s.note ? ' · ' + s.note : '');
}
function purBillBox(b) {
    return h('div', { style: { marginTop: '12px' } }, h('div', { class: 'row sp' }, h('strong', null, 'Bill ' + (b.bill_no || '#' + b.id)), h('span', { class: 'small muted' }, `${day(b.bill_date)} · due ${day(b.due_date)}`)), b.match && b.match.warn ? h('div', { class: 'note warn', style: { marginTop: '6px' } }, `Bill is ${rs(b.match.diff)} more than PO rate × pieces received (${rs(b.match.expected)}).`) : null, b.extras.length ? h('div', { class: 'small muted' }, 'Extra costs: ' + b.extras.map(e => `${e.label} ${rs(e.amount)} (${e.paid_from === 'accrued' ? 'to pay' : 'paid from ' + e.paid_from})`).join(' · ')) : null, b.instalments.length ? table([{ t: 'Instalment', f: i => day(i.due) }, { t: 'Amount', n: 1, f: i => rs(i.amount) }, { t: 'Paid', n: 1, f: i => rs(i.paid) },
        { t: '', f: i => i.open <= 0.5 ? h('span', { class: 'b ok' }, 'paid') : i.due < todayStr() ? h('span', { class: 'b bad' }, 'overdue') : h('span', { class: 'b' }, 'open') }], b.instalments) : null, b.post_error ? h('div', { class: 'note bad' }, 'Accounts: ' + b.post_error) : null, b.file_id ? fileLink(b.file_id) : null);
}
function purPayModal(title, path, def, done) {
    purMeta().then(m => formModal(title, [{ k: 'amount', label: 'Amount (Rs)' + (def.max ? ` — due ${rs(def.max)}` : ''), type: 'number', value: def.amount, required: true },
        { k: 'account', label: 'Paid from', type: 'select', options: m.cashAccounts, value: 'Meezan (SB)' }, { k: 'date', label: 'Date', type: 'date', value: todayStr() },
        { k: 'ref', label: 'Reference (cheque / IBFT / TID)' }, { k: 'note', label: 'Note', full: true }], v => POST(path, v).then(() => { toast('Payment saved and posted'); done && done(); }), 'Save payment'));
}
function purReceiveSupplies(d, done) {
    const ins = d.lines.map(l => ({ l, i: purNum(l.received || l.qty, '', '90px') })), date = h('input', { type: 'date', value: todayStr() });
    const m = modal('Receive ' + d.po.no, h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'Count what arrived. Enter the total received so far for each item.'), table([{ t: 'Item', f: x => x.l.item }, { t: 'Ordered', n: 1, f: x => `${num(x.l.qty)} ${x.l.unit}` }, { t: 'Received', n: 1, f: x => x.i }], ins), field('Date', date)), [h('button', { class: 'btn', onclick: async () => {
                const r = await act(() => POST(`/api/pur/pos/${d.po.id}/receive`, { date: date.value, lines: ins.map(x => ({ id: x.l.id, received: +x.i.value || 0 })) }));
                m.remove();
                toast(r.status === 'received' ? 'All received' : 'Partly received: ' + r.short.map(s => `${s.short} ${s.item}`).join(', ') + ' short', r.status !== 'received');
                done();
            } }, 'Save')]);
}
async function purOpenGrn(lot) {
    const d = await GET('/api/wms/lots');
    const l = d.lots.find(x => x.name === lot);
    if (!l)
        return toast('Lot not found in Receiving', true);
    if (typeof wmsReceive === 'function')
        wmsReceive(l, d.accounts);
    else
        location.hash = '#/receiving';
}
function purSettleModal(d, done) {
    const g = d.grn, p = d.po;
    let choice = 'discount';
    const amount = purNum(g.claim || '', 'Rs'), shortP = purNum(p.pricing === 'lump' ? g.short : 0), dmg = purNum(g.extraDamaged), skus = h('textarea', { placeholder: 'SKUs of the pairs going back (optional, one per line) — makes a transfer to "Return to supplier"' }), note = h('input', { placeholder: 'e.g. Shamsullah agreed on phone' });
    const fAmt = field('Amount the supplier gives back (Rs)', amount), fSkus = h('label', { class: 'f full' }, 'Pairs going back', skus), fs = [fAmt, field('Short pieces', shortP), field('Damaged pairs', dmg)];
    const opts = h('div', { class: 'stack' });
    const draw = () => {
        purFill(opts, [['discount', 'Supplier gives a discount', 'A debit note reduces the bill.'], ['return', 'Return damaged pairs', 'Debit note + pairs sent back to the supplier.'], ['loss', 'Accept as loss', 'Nothing claimed. Damage is already written off by the GRN.']]
            .map(([k, t, s]) => h('label', { class: 'row', style: { cursor: 'pointer', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: '10px', background: choice === k ? 'var(--soft)' : 'transparent' } }, h('input', { type: 'radio', name: 'purset', checked: choice === k, onchange: () => { choice = k; draw(); } }), h('div', null, h('strong', null, t), h('div', { class: 'small muted' }, s)))));
        fs.forEach(f => f.hidden = choice === 'loss');
        fSkus.hidden = choice !== 'return';
    };
    draw();
    const err = h('div', { class: 'flash bad', hidden: true });
    const m = modal('Settle with ' + p.supplier, h('div', { class: 'grid' }, err, purDiffTable(g), opts, h('div', { class: 'fgrid' }, ...fs, fSkus, h('label', { class: 'f full' }, 'Note', note))), [h('button', { class: 'btn', onclick: async () => {
                try {
                    const r = await POST(`/api/pur/pos/${p.id}/settle`, { choice, amount: +amount.value || null, short_pcs: +shortP.value || 0, damaged_pcs: +dmg.value || 0, skus: skus.value, note: note.value });
                    m.remove();
                    toast(r.debitNote ? `Debit note ${r.debitNote.no} for ${rs(r.debitNote.amount)}` + (r.transfer ? ` · transfer T-${r.transfer}` : '') : 'Accepted as loss');
                    done && done();
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, 'Save')]);
}
async function purBillModal(d, done) {
    const m = await purMeta(), p = d.po, b = d.bill, mo = d.money || {};
    const prefill = b ? b.goods : p.kind === 'lot' ? (d.grn ? d.grn.billFor : p.amount) : d.lines.reduce((s, l) => s + (l.received || 0) * l.rate, 0);
    const expected = p.kind === 'lot' ? (d.grn ? d.grn.billFor : p.amount) : d.lines.reduce((s, l) => s + (l.received || 0) * l.rate, 0);
    const no = h('input', { value: b ? b.bill_no : '', placeholder: "supplier's bill number" }), date = h('input', { type: 'date', value: b ? b.bill_date : todayStr() }), goods = purNum(prefill), due = h('input', { type: 'date', value: b ? b.due_date : '' });
    const accSel = p.kind === 'supplies' ? purSel(m.expenseAccounts.concat(['Office Equipments', 'Outlet Equipments']), b ? b.account : 'Packaging') : null;
    const file = purFiles(b && b.file_id ? [b.file_id] : []), info = h('div'), instBox = h('div');
    let billReady = false;
    const payFrom = [['accrued', 'Pay later (Accrued)']].concat(m.cashAccounts.map(a => [a, 'Paid from ' + a]));
    const extras = purRows((v, del) => {
        const l = h('input', { value: v.label || '', placeholder: 'e.g. Transport', class: 'grow' }), a = purNum(v.amount, 'Rs', '100px'), f = purSel(payFrom, v.paid_from || 'accrued');
        return { el: h('div', { class: 'row' }, l, a, f, purX(del)), val: () => ({ label: l.value.trim(), amount: +a.value || 0, paid_from: f.value }) };
    }, b ? b.extras : p.kind === 'lot' ? p.extras.map(e => (Object.assign(Object.assign({}, e), { paid_from: 'accrued' }))) : [], '+ Extra cost', () => billReady && upd());
    let inst = null;
    if (p.terms === 'instalments') {
        const left = () => Math.round((+goods.value || 0) - (mo.debitNotes || 0) - (mo.advance || 0));
        const mk = () => { const n = p.instalments || 3, L = left(), each = Math.floor(L / n); return Array.from({ length: n }, (_, i) => { const dd = new Date(Date.parse((date.value || todayStr()) + 'T00:00:00Z') + 30 * (i + 1) * 864e5).toISOString().slice(0, 10); return { due: dd, amount: i === n - 1 ? L - each * (n - 1) : each }; }); };
        inst = purRows((v, del) => { const dd = h('input', { type: 'date', value: v.due || '' }), a = purNum(v.amount, 'Rs', '110px'); return { el: h('div', { class: 'row' }, dd, a, purX(del)), val: () => ({ due: dd.value, amount: +a.value || 0 }) }; }, b && b.instalments.length ? b.instalments : mk(), '+ Instalment', () => billReady && upd());
        purFill(instBox, h('div', { class: 'row sp' }, h('strong', { class: 'small' }, 'Instalments', h('span', { class: 'muted' }, ' (what is left after the advance)')), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { inst.rows.slice().forEach(r => r.el.querySelector('button').click()); mk().forEach(v => inst.add(v)); } }, 'Split evenly')), inst.node);
    }
    const upd = () => {
        const gv = +goods.value || 0, ex = extras.val().reduce((s, e) => s + e.amount, 0), net = gv - (mo.debitNotes || 0), left = net - (mo.advance || 0);
        const iv = inst ? inst.val().reduce((s, i) => s + i.amount, 0) : null;
        purFill(info, h('dl', { class: 'kv' }, h('dt', null, p.kind === 'lot' ? 'PO rate × pieces received' : 'PO rate × qty received'), h('dd', null, rs(expected)), h('dt', null, 'Bill amount'), h('dd', null, rs(gv)), mo.debitNotes ? [h('dt', null, 'Less debit notes'), h('dd', null, '− ' + rs(mo.debitNotes))] : null, h('dt', null, 'Net payable to supplier'), h('dd', null, h('strong', null, rs(net))), mo.advance ? [h('dt', null, 'Advance already paid'), h('dd', null, '− ' + rs(mo.advance)), h('dt', null, 'Left to pay'), h('dd', null, h('strong', null, rs(left)))] : null, ex ? [h('dt', null, 'Extra costs (part of the pairs\' cost)'), h('dd', null, rs(ex))] : null), gv > expected + 1 ? h('div', { class: 'note warn', style: { marginTop: '8px' } }, `Three-way match: the bill is ${rs(gv - expected)} more than the PO rate × what was received. Check with the supplier before posting.`) : gv ? h('div', { class: 'note ok', style: { marginTop: '8px' } }, 'Matches the PO and what was received.') : null, inst && Math.abs(iv - left) >= 1 ? h('div', { class: 'note bad', style: { marginTop: '8px' } }, `Instalments add up to ${rs(iv)}, should be ${rs(left)}.`) : null);
    };
    billReady = true;
    goods.addEventListener('input', upd);
    upd();
    const err = h('div', { class: 'flash bad', hidden: true });
    const supT = ((m.suppliers || []).find(x => x.name === p.supplier) || {}).type;
    const flow = h('div', { class: 'note' }, p.kind === 'lot'
        ? ['This bill goes to ', h('strong', null, p.supplier + "'s account"), ' (what you owe him) and the pairs go into stock. It is not an expense — the cost becomes an expense only when each pair is sold.']
        : ['This bill goes to ', h('strong', null, p.supplier + "'s account"), ' (what you owe). The account below is ', h('strong', null, 'what you bought'), ' (e.g. boxes → Packaging).']);
    const wrongKind = p.kind === 'supplies' && supT === 'lots' ? h('div', { class: 'note bad' }, `${p.supplier} sells shoe lots, but this PO was made as a supplies PO, so it would book the shoes as an expense. Make it a Lot PO instead: the bill then goes to ${p.supplier}'s account and the pairs into stock.`, h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try {
            await POST(`/api/pur/pos/${p.id}/cancel`, { reason: 'Made as supplies PO by mistake — redone as Lot PO' });
            document.querySelectorAll('.modal').forEach(x => x.remove());
            toast('Cancelled. Now fill in the Lot PO.');
            location.hash = '#/purchasing/new/lot/' + encodeURIComponent(p.supplier);
        }
        catch (e) {
            toast(e.message, true);
        } } }, 'Cancel this and make a Lot PO'))) : null;
    const mm = modal((b ? 'Edit bill — ' : 'Supplier bill — ') + p.no, h('div', { class: 'grid' }, err, flow, wrongKind, h('div', { class: 'fgrid' }, field('Bill number', no), field('Bill date', date), field('Bill amount (Rs) *', goods), accSel ? field('What was bought (expense account)', accSel) : null, inst ? null : field('Due date (blank = by terms)', due), h('label', { class: 'f full' }, 'Bill photo', file.node)), p.kind === 'lot' ? h('div', null, h('strong', { class: 'small' }, 'Extra costs on this lot'), extras.node) : null, instBox, info), [h('button', { class: 'btn', onclick: async () => {
                try {
                    const r = await POST(`/api/pur/pos/${p.id}/bill`, { bill_no: no.value, bill_date: date.value, goods: +goods.value || 0, due_date: due.value, account: accSel ? accSel.value : undefined,
                        extras: extras.val().filter(e => e.amount > 0), instalments: inst ? inst.val() : undefined, file_id: file.files[file.files.length - 1] || null });
                    mm.remove();
                    toast(r.match.warn ? `Bill saved — ${rs(r.match.diff)} above PO × received` : 'Bill saved and posted', !!r.match.warn || !!r.error);
                    done && done();
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, b ? 'Save bill' : 'Post bill')]);
}
// print-friendly purchase order (the side menu and buttons are hidden when printing)
async function purPrint(id) {
    const d = await GET('/api/pur/pos/' + id), p = d.po, s = d.supplier, m = await purMeta();
    const cell = (t, st) => h('td', { style: st || null }, t);
    const rows = p.kind === 'lot' ? [[`Lot ${p.lot_name}: mixed pre-owned shoes` + (p.mix.length ? ' — ' + p.mix.map(r => `${r.n} ${r.t} (${r.g}, ${r.c})`).join(', ') : ''), `${num(p.pieces)} pairs`, p.pricing === 'lump' ? 'lump sum' : rs(p.rate), rs(p.amount)]]
        : d.lines.map(l => [l.item, `${num(l.qty)} ${l.unit}`, rs(l.rate), rs(l.qty * l.rate)]);
    render(h('div', { class: 'row noprint' }, purBack('#/purchasing/po/' + p.id, p.no), h('button', { class: 'btn', onclick: () => window.print() }, 'Print'), h('a', { class: 'btn ghost', href: purWaHref(d), target: '_blank' }, 'WhatsApp')), h('div', { class: 'card', style: { maxWidth: '820px', width: '100%', padding: '28px' } }, h('div', { class: 'row sp', style: { alignItems: 'flex-start' } }, h('div', null, h('div', { style: { fontSize: '22px', fontWeight: 800 } }, m.store || 'SundayBazar'), h('div', { class: 'small muted' }, 'Pre-owned branded shoes · Karachi')), h('div', { style: { textAlign: 'right' } }, h('div', { style: { fontSize: '18px', fontWeight: 700, letterSpacing: '.06em' } }, 'PURCHASE ORDER'), h('div', { class: 'mono', style: { fontSize: '16px' } }, p.no), h('div', { class: 'small muted' }, 'Date ' + day(String(p.approved_at || p.created_at).slice(0, 10))))), h('div', { class: 'two', style: { margin: '20px 0' } }, h('div', null, h('div', { class: 'small muted' }, 'Supplier'), h('strong', null, s.name), s.city ? h('div', null, s.city) : null, s.address ? h('div', { class: 'small' }, s.address) : null, s.phone ? h('div', { class: 'small' }, s.phone) : null), h('div', null, h('div', { class: 'small muted' }, 'Delivery'), h('div', null, p.expected_date ? 'By ' + day(p.expected_date) : 'As agreed'), h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Payment terms'), h('div', null, p.terms === 'credit' ? `Credit ${p.credit_days} days` : p.terms === 'instalments' ? `${p.instalments} instalments` : 'Cash on delivery', p.advance_plan ? ` · advance ${rs(p.advance_plan)}` : ''))), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', { class: 'n' }, 'Qty'), h('th', { class: 'n' }, 'Rate'), h('th', { class: 'n' }, 'Amount'))), h('tbody', null, rows.map(r => h('tr', null, cell(r[0]), h('td', { class: 'n' }, r[1]), h('td', { class: 'n' }, r[2]), h('td', { class: 'n' }, r[3])))), h('tfoot', null, h('tr', null, h('td', { colspan: 3 }, 'Total'), h('td', { class: 'n' }, rs(p.amount)))))), p.kind === 'lot' ? h('div', { class: 'small', style: { marginTop: '12px' } }, `Pieces are counted on arrival. Short, damaged or mismatched pairs beyond ${num(p.bad_est || 0)} are adjusted with the supplier (discount, return or credit).`) : null, p.notes ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'small muted' }, 'Notes'), p.notes) : null, h('div', { class: 'row sp', style: { marginTop: '48px' } }, h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '4px', minWidth: '180px' } }, 'Approved by' + (p.approved_name ? ': ' + p.approved_name : '')), h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '4px', minWidth: '180px' } }, 'Supplier signature'))));
}
/* ---------- hooks used by Warehouse → Receiving (32-wms-receiving.js) ---------- */
// PO details shown on the receive form
async function purGrnInfo(lot, expInput) {
    let r;
    try {
        r = await GET('/api/pur/by-lot/' + encodeURIComponent(lot));
    }
    catch (_a) {
        return null;
    }
    if (!r || !r.po)
        return null;
    const p = r.po;
    if (expInput && !expInput.dataset.touched && !r.grn)
        expInput.value = p.pieces;
    return h('div', { class: 'note' }, h('strong', null, `${p.no} · ${p.supplier}`), ` — ordered ${num(p.pieces)} pairs` + (p.bad_est ? ` (${num(p.bad_est)} expected bad)` : '') +
        (p.rate ? ` at ${rs(p.rate)} a piece` : p.lump ? ` for ${rs(p.lump)} (lump sum)` : '') + (p.expected_date ? ` · promised ${day(p.expected_date)}` : ''));
}
// after saving the GRN: PO vs GRN differences and how to settle them
function purGrnResult(lot, po) {
    if (!po || !po.diff)
        return;
    const g = po.diff;
    if (g.ok)
        return toast(`${lot}: matches ${po.no}`);
    modal(`${lot}: PO vs GRN`, h('div', { class: 'grid' }, h('div', { class: 'small muted' }, `${po.no} — the difference has to be settled with the supplier (discount, return the pairs, or accept as loss).`), purDiffTable(g)), [h('a', { class: 'btn', href: '#/purchasing/po/' + po.id, onclick: () => { var _a; return (_a = document.querySelector('.modal')) === null || _a === void 0 ? void 0 : _a.remove(); } }, 'Open PO to settle')]);
}
/* ---------- Purchasing: suppliers (list, page, scorecard) and payables ---------- */
async function purSupplierForm(s, done) {
    const m = await purMeta();
    s = s || { type: 'lots', terms: 'cash', active: 1 };
    formModal(s.id ? 'Edit ' + s.name : 'New supplier', [
        { k: 'name', label: 'Name (as written on lots and in the accounts)', value: s.name, required: true, full: true },
        { k: 'type', label: 'Supplies', type: 'select', options: Object.entries(m.supTypes), value: s.type },
        { k: 'prefix', label: 'Lot name prefix (e.g. SH)', value: s.prefix || '' },
        { k: 'phone', label: 'Phone', value: s.phone || '' }, { k: 'whatsapp', label: 'WhatsApp (e.g. 923001234567)', value: s.whatsapp || '' },
        { k: 'city', label: 'City', value: s.city || '' }, { k: 'address', label: 'Address', value: s.address || '' },
        { k: 'bank', label: 'Bank / JazzCash details', value: s.bank || '', full: true },
        { k: 'terms', label: 'Payment terms', type: 'select', options: [['cash', 'Cash on delivery'], ['credit', 'Credit (pay later)'], ['instalments', 'Instalments']], value: s.terms },
        { k: 'credit_days', label: 'Credit days', type: 'number', value: s.credit_days || 30 }, { k: 'instalments', label: 'Instalments', type: 'number', value: s.instalments || 3 },
        { k: 'active', label: 'Active', type: 'checkbox', value: s.active !== 0 }, { k: 'note', label: 'Notes', type: 'textarea', value: s.note || '' },
    ], async (v) => { const r = await POST('/api/pur/suppliers', Object.assign(Object.assign({}, v), { id: s.id })); await purMeta(true); toast('Supplier saved'); done && done(Object.assign(Object.assign({}, r), { name: v.name })); });
}
VIEWS.suppliers = async (args) => {
    if (args[0] === 's')
        return purSupplierPage(args[1], args[2]);
    const m = await purMeta(), months = args[0] === '12' ? 12 : 6;
    const rows = await GET('/api/pur/suppliers?months=' + months);
    const showType = store.get('pur_sup_type', 'all');
    const list = rows.filter(s => showType === 'all' || (showType === 'lots' ? s.type === 'lots' : s.type !== 'lots'));
    const own = m.can.owner, fin = rows.some(s => s.payable != null);
    const totPay = rows.reduce((t, s) => t + Math.max(0, s.payable || 0), 0);
    render(pageHead('Suppliers', 'Lot suppliers, packaging and services — and whose lots actually make money', m.can.supplier ? h('button', { class: 'btn ghost', onclick: () => act(() => POST('/api/pur/suppliers/import'), 'Checked lots and accounts for new suppliers').then(() => VIEWS.suppliers(args)) }, 'Import from lots & accounts') : null, m.can.supplier ? h('button', { class: 'btn', onclick: () => purSupplierForm(null, r => { location.hash = '#/suppliers/s/' + r.id; }) }, '+ Add supplier') : null), h('div', { class: 'kpis' }, kpi('Suppliers', num(rows.filter(s => s.active).length), `${rows.filter(s => s.type === 'lots').length} shoe-lot suppliers`), fin ? kpi('Owed to suppliers', rs(totPay), 'from the accounts (party ledger)', totPay ? 'warn' : '', m.can.money ? '#/payables' : null) : null, kpi('Open orders', num(rows.reduce((t, s) => t + s.openPOs, 0)), null, null, '#/purchasing/list/open')), h('div', { class: 'card' }, h('div', { class: 'row sp' }, tabs([['all', 'All'], ['lots', 'Shoe lots'], ['other', 'Packaging & services']], showType, k => { store.set('pur_sup_type', k); VIEWS.suppliers(args); }), own ? tabs([['6', 'Last 6 months'], ['12', 'Last 12 months']], String(months), k => { location.hash = '#/suppliers/' + k; }) : null), h('div', { style: { marginTop: '8px' } }, table([
        { t: 'Supplier', f: s => [h('strong', null, s.name), s.active ? null : h('span', { class: 'b', style: { marginLeft: '6px' } }, 'inactive'), h('div', { class: 'small muted' }, [m.supTypes[s.type], s.city, s.termsText].filter(Boolean).join(' · '))] },
        { t: 'Lots', n: 1, f: s => num(s.lots) }, { t: 'Open POs', n: 1, f: s => s.openPOs ? num(s.openPOs) : '' },
        fin ? { t: 'Payable', n: 1, f: s => s.payable == null || Math.abs(s.payable) < 1 ? h('span', { class: 'muted' }, '–') : h('span', { class: s.payable < 0 ? 'pos' : '' }, s.payable < 0 ? rs(-s.payable) + ' advance' : rs(s.payable)) } : null,
        own ? { t: 'Cost / pair', n: 1, f: s => s.score ? rs(s.score.avgCost) : '' } : null,
        own ? { t: 'Short · damaged', n: 1, f: s => s.score && s.score.shortPct != null ? `${purPct(s.score.shortPct)} · ${purPct(s.score.damagePct)}` : '' } : null,
        own ? { t: 'Sold in 60 days', n: 1, f: s => s.score ? purPct(s.score.sellThrough60) : '' } : null,
        own ? { t: 'Profit / pair', n: 1, f: s => s.score && s.score.profitPerPair != null ? h('span', { class: s.score.profitPerPair < 0 ? 'neg' : '' }, rs(s.score.profitPerPair)) : '' } : null,
        own ? { t: 'ROI so far', n: 1, f: s => s.score && s.score.roi != null ? h('strong', { class: purRoiCls(s.score.roi) }, purPct(s.score.roi)) : '' } : null
    ].filter(Boolean), list, s => { location.hash = '#/suppliers/s/' + s.id; })), own ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Scorecard for lots bought in the last ${months} months. Profit per pair = delivered price − coupon, COD, ads, courier, packing and the pair's cost. ROI so far = (sales after those costs − lot cost) ÷ lot cost, so new lots start negative.`) : null));
};
async function purSupplierPage(id, mo) {
    const months = mo === '12' ? 12 : 6;
    const [d, m] = await Promise.all([GET(`/api/pur/suppliers/${id}?months=${months}`), purMeta()]), s = d.supplier, sc = d.scorecard;
    const go = () => purSupplierPage(id, mo);
    const wa = s.whatsapp ? h('a', { class: 'btn ghost', href: waLink(s.whatsapp, ''), target: '_blank' }, 'WhatsApp') : null;
    const isLots = s.type === 'lots' || s.type === 'other';
    render(pageHead(s.name, [m.supTypes[s.type], s.city, s.termsText].filter(Boolean).join(' · '), purBack('#/suppliers', 'Suppliers'), m.can.create ? h('a', { class: 'btn', href: `#/purchasing/new/${isLots ? 'lot' : 'supplies'}/${encodeURIComponent(s.name)}` }, isLots ? '+ Lot PO' : '+ Supplies PO') : null, m.can.money ? h('button', { class: 'btn ghost', onclick: () => purPayModal('Pay ' + s.name, `/api/pur/suppliers/${s.id}/pay`, { amount: d.payable || '' }, go) }, 'Record payment') : null, wa, m.can.supplier ? h('button', { class: 'btn ghost', onclick: () => purSupplierForm(s, go) }, 'Edit') : null), h('div', { class: 'kpis' }, d.balance != null ? kpi(d.balance > 0 ? 'Advance with supplier' : 'We owe', rs(Math.abs(d.balance)), 'Accounts Payable · vendor:' + s.name, d.balance < 0 ? 'warn' : d.balance > 0 ? 'good' : '', m.can.money ? '#/payables' : null) : null, d.openAdvances ? kpi('Advances on open POs', rs(d.openAdvances), 'goods not billed yet') : null, kpi('Lots bought', num(d.lots.length), d.lots.length ? 'last ' + day(d.lots[0].bought_on) : ''), kpi('Open POs', num(d.pos.filter(p => !['closed', 'cancelled'].includes(p.status)).length))), sc ? h('div', { class: 'card' }, h('h2', null, 'Scorecard', h('small', null, `lots bought in the last ${months} months`), h('span', { class: 'spacer' }, tabs([['6', '6 months'], ['12', '12 months']], String(months), k => { location.hash = `#/suppliers/s/${id}/${k}`; }))), sc.lots ? h('div', { class: 'kpis' }, kpi('Lots · pairs', `${num(sc.lots)} · ${num(sc.pieces)}`, rs(sc.spent) + ' spent'), kpi('Average cost / pair', rs(sc.avgCost)), kpi('Short on arrival', purPct(sc.shortPct), 'pieces missing vs ordered', sc.shortPct > 3 ? 'warn' : ''), kpi('Damaged on arrival', purPct(sc.damagePct), 'of pieces received', sc.damagePct > 5 ? 'warn' : ''), kpi('Delivery', sc.avgLateDays == null ? '–' : sc.avgLateDays > 0 ? purDays(sc.avgLateDays) + ' late' : sc.avgLateDays < 0 ? purDays(-sc.avgLateDays) + ' early' : 'on time', sc.onTimePct != null ? sc.onTimePct + '% of orders on time' : 'no PO dates yet', sc.avgLateDays > 2 ? 'warn' : ''), kpi('Sold within 60 days', purPct(sc.sellThrough60), '120 days: ' + purPct(sc.sellThrough120)), kpi('Average price sold', sc.avgPrice ? rs(sc.avgPrice) : '–', num(sc.delivered) + ' pairs delivered'), kpi('Profit per pair', sc.profitPerPair == null ? '–' : rs(sc.profitPerPair), 'after ads, courier, COD & pair cost', sc.profitPerPair == null ? '' : sc.profitPerPair > 0 ? 'good' : 'alert'), kpi('ROI so far', purPct(sc.roi), sc.started ? `${rs(sc.profit)} on ${sc.started} received lot${sc.started === 1 ? '' : 's'}` : 'no lot received yet', sc.roi == null ? '' : sc.roi >= 0 ? 'good' : 'warn')) : h('div', { class: 'empty' }, 'No lots bought from this supplier in this period.')) : null, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Purchase orders'), purPoTable(d.pos, { money: d.balance != null, noSupplier: true })), h('div', { class: 'card' }, h('h2', null, 'Details'), h('dl', { class: 'dl' }, [['Phone', s.phone ? h('a', { href: 'tel:' + s.phone }, s.phone) : null], ['WhatsApp', s.whatsapp], ['City', s.city], ['Address', s.address], ['Bank / JazzCash', s.bank], ['Terms', s.termsText], ['Lot prefix', s.prefix], ['Notes', s.note]]
        .filter(x => x[1]).map(([l, v]) => [h('dt', null, l), h('dd', null, v)])))), isLots && d.lots.length ? h('div', { class: 'card' }, h('h2', null, 'Lots bought', h('small', null, sc ? 'tap a lot for its profit' : '')), table(sc ? [{ t: 'Lot', f: l => [h('strong', null, l.name), h('div', { class: 'small muted' }, day(l.bought_on))] }, { t: 'Cost', n: 1, f: l => [rs(l.total), h('div', { class: 'small muted' }, rs(l.perPair) + '/pair')] },
        { t: 'Listed', f: l => h('div', { style: { minWidth: '90px' } }, h('div', { class: 'small' }, `${num(l.listed)} · ${l.listedPct}%`), bar(l.listedPct)) }, { t: 'Sold', n: 1, f: l => num(l.delivered) },
        { t: 'Revenue', n: 1, f: l => rs(l.revenue) }, { t: 'Profit so far', n: 1, f: l => l.started ? h('span', { class: l.profit < 0 ? 'neg' : 'pos' }, rs(l.profit)) : h('span', { class: 'b' }, 'not received') },
        { t: 'ROI', n: 1, f: l => l.started ? h('strong', { class: purRoiCls(l.roi) }, purPct(l.roi)) : '' }]
        : [{ t: 'Lot', k: 'name' }, { t: 'Bought', f: l => day(l.bought_on) }, { t: 'Pieces', n: 1, f: l => num(l.pieces) }], d.lots, sc ? (l => { location.hash = '#/purchasing/lot/' + encodeURIComponent(l.name); }) : null)) : null, d.payments.length || d.bills.length ? h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Payments'), table([{ t: 'Date', f: x => day(x.date) }, { t: 'What', f: x => [x.kind === 'advance' ? 'Advance' : 'Payment', x.ref ? h('div', { class: 'small muted' }, x.ref) : null] }, { t: 'From', k: 'account' }, { t: 'Amount', n: 1, f: x => rs(x.amount) }], d.payments)), h('div', { class: 'card' }, h('h2', null, 'Bills'), table([{ t: 'Bill', f: b => [h('strong', null, b.bill_no || '#' + b.id), h('div', { class: 'small muted' }, [b.po_no, b.lot_name].filter(Boolean).join(' · '))] }, { t: 'Date', f: b => day(b.bill_date) },
        { t: 'Net', n: 1, f: b => rs(b.net) }, { t: 'Due', n: 1, f: b => b.due > 0.5 ? h('span', { class: b.nextDue < todayStr() ? 'neg' : '' }, rs(b.due)) : h('span', { class: 'b ok' }, 'paid') }], d.bills, b => { if (b.po_id)
        location.hash = '#/purchasing/po/' + b.po_id; }))) : null);
}
VIEWS.payables = async (args) => {
    const tab = args[0] || 'due';
    const d = await GET('/api/pur/payables');
    const go = () => VIEWS.payables(args);
    const head = [pageHead('Payables', 'What we owe suppliers and when'),
        h('div', { class: 'kpis' }, kpi('Overdue', rs(d.totals.overdue), `${d.counts.overdue} bill${d.counts.overdue === 1 ? '' : 's'}`, d.totals.overdue ? 'alert' : 'good'), kpi('Due this week', rs(d.totals.week), `${d.counts.week} bill${d.counts.week === 1 ? '' : 's'}`, d.totals.week ? 'warn' : ''), kpi('Open bills', rs(d.totals.later), `${d.rows.length} bills not fully paid`), kpi('Owed to suppliers', rs(d.totalPayable), 'all suppliers, from the accounts', null, '#/payables/balances'), d.totalAdvance ? kpi('Advances with suppliers', rs(d.totalAdvance), d.advances.length ? `${d.advances.length} on orders not received yet` : '', d.advances.some(a => a.late) ? 'warn' : '', '#/payables/advances') : null),
        tabs([['due', 'Bills due', d.rows.length], ['balances', 'Supplier balances', d.balances.length], ['advances', 'Advances', d.advances.length || null]], tab, k => { location.hash = '#/payables/' + k; })];
    const pay = b => purPayModal(`Pay ${b.supplier}`, `/api/pur/bills/${b.id}/pay`, { amount: b.nextAmount, max: b.due }, go);
    if (tab === 'balances')
        return render(head, h('div', { class: 'card' }, h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Every supplier with a balance in Accounts Payable — lots bought before purchase orders were used are here too.'), table([{ t: 'Supplier', f: s => h('strong', null, s.name) }, { t: 'We owe', n: 1, f: s => s.balance < 0 ? rs(-s.balance) : '' }, { t: 'Advance', n: 1, f: s => s.balance > 0 ? h('span', { class: 'pos' }, rs(s.balance)) : '' },
            { t: '', f: s => s.balance < 0 && s.id ? h('button', { class: 'btn sm', onclick: () => purPayModal('Pay ' + s.name, `/api/pur/suppliers/${s.id}/pay`, { amount: -s.balance }, go) }, 'Pay') : '' }], d.balances, s => { if (s.id)
            location.hash = '#/suppliers/s/' + s.id; })));
    if (tab === 'advances')
        return render(head, h('div', { class: 'card' }, h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Advances paid on orders that have not arrived yet. Chase the supplier when the date has passed.'), table([{ t: 'Supplier', f: a => [h('strong', null, a.supplier), h('div', { class: 'small muted' }, [a.no, a.lot_name].filter(Boolean).join(' · '))] }, { t: 'Paid', f: a => day(a.date) }, { t: 'Amount', n: 1, f: a => rs(a.amount) },
            { t: 'Expected', f: a => a.expected_date ? [day(a.expected_date), a.late ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, purDays(a.late) + ' late') : null] : '–' }, { t: 'Status', f: a => purStatusB(a.status) }], d.advances, a => { location.hash = '#/purchasing/po/' + a.po_id; })));
    const groups = [['overdue', 'Overdue', 'bad'], ['week', 'Due this week', 'warn'], ['later', 'Later', '']];
    render(head, groups.map(([k, t, cls]) => {
        const rows = d.rows.filter(r => r.bucket === k);
        if (!rows.length)
            return null;
        return h('div', { class: 'card' }, h('h2', null, t, h('small', null, `${rows.length} · ${rs(rows.reduce((s, r) => s + (k === 'later' ? r.due : r.nextAmount), 0))}`)), table([{ t: 'Supplier', f: b => [h('strong', null, b.supplier), h('div', { class: 'small muted' }, [b.po_no, b.lot_name, b.bill_no && 'bill ' + b.bill_no].filter(Boolean).join(' · '))] },
            { t: 'Due', f: b => [day(b.nextDue), b.late ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, purDays(b.late) + ' late') : null, b.instalments.length ? h('div', { class: 'small muted' }, `instalment ${b.instalments.filter(i => i.open <= 0.5).length + 1} of ${b.instalments.length}`) : null] },
            { t: 'Now', n: 1, f: b => h('strong', { class: cls === 'bad' ? 'neg' : '' }, rs(b.nextAmount)) }, { t: 'Total due', n: 1, f: b => rs(b.due) },
            { t: '', f: b => h('button', { class: 'btn sm ' + (cls === 'bad' ? '' : 'ghost'), onclick: () => pay(b) }, 'Pay') }], rows, b => { location.hash = '#/purchasing/po/' + b.po_id; }));
    }), d.rows.length ? null : h('div', { class: 'card' }, h('div', { class: 'empty' }, icon('check'), ' No supplier bills waiting for payment.')));
};
registerView({ key: 'suppliers', title: 'Suppliers', group: 'Buying', perm: ['listing', 'wms', 'finance', 'accounts_post', 'accounts', 'pricing_apply'], icon: 'people', order: 20 }, VIEWS.suppliers);
registerView({ key: 'payables', title: 'Payables', group: 'Finance', perm: ['finance', 'accounts_post'], icon: 'cash', order: 20 }, VIEWS.payables);
/* ---------- Purchasing: overview, purchase orders list, lot profit page (forms & PO page: 42-purchasing-po.js, suppliers & payables: 42-purchasing-sup.js) ---------- */
const PUR_ST = { draft: ['Draft', ''], submitted: ['Awaiting approval', 'warn'], approved: ['Approved', 'info'], sent: ['Sent to supplier', 'info'], partial: ['Partly received', 'warn'],
    received: ['Received', 'accent'], billed: ['Billed', 'info'], closed: ['Closed', 'ok'], cancelled: ['Cancelled', 'bad'] };
const PUR_VIEW = ['listing', 'wms', 'finance', 'accounts_post', 'accounts', 'pricing_apply'];
const purStatusB = s => { const [t, c] = PUR_ST[s] || [s, '']; return h('span', { class: 'b ' + c }, t); };
const purVerdictB = v => v ? h('span', { class: 'b ' + ({ buy: 'ok', think: 'warn', dont: 'bad' }[v]) }, { buy: 'Buy', think: 'Think twice', dont: "Don't buy" }[v]) : null;
const purPct = v => v == null ? '–' : (+v).toLocaleString('en-PK', { maximumFractionDigits: 1 }) + '%';
const purDays = n => n + (Math.abs(n) === 1 ? ' day' : ' days');
const purRoiCls = v => v == null ? '' : v >= 15 ? 'pos' : v < 0 ? 'neg' : '';
let PUR_META = null;
async function purMeta(force) { if (!PUR_META || force || PUR_META._me !== ME.id) {
    PUR_META = await GET('/api/pur/meta');
    PUR_META._me = ME.id;
} return PUR_META; }
function purFill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false)); return el; }
function purBack(href, label) { return h('a', { class: 'btn ghost sm noprint', href }, '‹ ' + (label || 'Back')); }
// the lot planner's answer: Buy / Think twice / Don't buy with the numbers behind it
function purVerdict(p, big) {
    if (!p || !p.verdict)
        return h('div', { class: 'note' }, (p && p.why) || 'Add the expected mix (types and condition) to see if this lot will make money.');
    const [t, c] = { buy: ['Buy', 'ok'], think: ['Think twice', 'warn'], dont: ["Don't buy", 'bad'] }[p.verdict];
    return h('div', { class: 'note ' + c }, h('div', { style: { fontSize: big ? '24px' : '17px', fontWeight: 800, letterSpacing: '-.02em' } }, t), h('div', { style: { marginTop: '2px' } }, p.why));
}
function purPlanKv(p) {
    if (!p || !p.pieces)
        return null;
    const row = (l, v, cls) => [h('dt', null, l), h('dd', { class: cls || '' }, v)], sep = () => h('div', { class: 'sep' });
    return h('dl', { class: 'kv', style: { marginTop: '10px' } }, row('Lot price', rs(p.cost)), p.extra ? row('Extra costs', rs(p.extra)) : null, row('Pieces · good pairs', `${num(p.pieces)} · ${num(p.good)}`), row('Cost per good pair', rs(p.perPair)), p.verdict ? [sep(), row('Expected sales (after sale discounts)', rs(p.sales)), row('Ads, courier, COD, packing', '− ' + rs(p.variable)), row('Rent & salaries share', '− ' + rs(p.overheads)),
        row('Expected profit', rs(p.profit), p.profit < 0 ? 'neg' : 'pos'), row('Profit per pair', rs(p.perPairProfit), p.perPairProfit < 0 ? 'neg' : 'pos'), row('Return on the money', purPct(p.roi), purRoiCls(p.roi)),
        sep(), row('Break-even lot price', p.breakEven ? `${rs(p.breakEven)} (${rs(p.breakEvenPiece)}/piece)` : '–'), p.slow ? row('Slow-selling pairs', `${num(p.slow)} (${p.slowPct}%)`, 'neg') : null] : null);
}
function purPlanRows(p) {
    if (!p || !p.rows || !p.rows.length)
        return null;
    return h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Price and cost per type'), table([{ t: 'Pairs', f: r => [h('strong', null, `${r.n} ${r.t}`), h('div', { class: 'small muted' }, `${r.g} · ${r.c}${r.b ? ' · ' + r.b : ''}`)] }, { t: 'Cost', n: 1, f: r => rs(r.cost) },
        { t: 'List at', n: 1, f: r => [rs(r.price), r.slow ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, 'slow') : null] }], p.rows));
}
const purWhat = p => p.kind === 'lot' ? `${p.lot_name} · ${num(p.pieces)} pairs` : `${p.items} item${p.items === 1 ? '' : 's'} (supplies)`;
function purPoTable(rows, opts = {}) {
    return table([{ t: 'PO', f: p => [h('strong', { class: 'mono', style: { whiteSpace: 'nowrap' } }, p.no), h('div', { class: 'small muted', style: { whiteSpace: 'nowrap' } }, day(String(p.created_at || '').slice(0, 10)))] },
        opts.noSupplier ? { t: 'What', f: p => purWhat(p) } : { t: 'Supplier', f: p => [p.supplier, h('div', { class: 'small muted' }, purWhat(p))] },
        { t: 'Amount', n: 1, f: p => rs(p.amount) },
        { t: 'Expected', f: p => p.expected_date ? [h('span', { style: { whiteSpace: 'nowrap' } }, day(p.expected_date)), p.late ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, purDays(p.late) + ' late') : null] : h('span', { class: 'muted' }, '–') },
        { t: 'Status', f: p => [purStatusB(p.status), p.verdict && ['draft', 'submitted'].includes(p.status) ? h('div', { style: { marginTop: '3px' } }, purVerdictB(p.verdict)) : null] },
        opts.money ? { t: 'Due', n: 1, f: p => p.money && p.money.due != null ? rs(p.money.due) : p.money && p.money.advance ? h('span', { class: 'small muted' }, 'adv ' + rs(p.money.advance)) : '' } : null].filter(Boolean), rows, p => { location.hash = '#/purchasing/po/' + p.id; });
}
// compact list for narrow cards
function purPoMini(rows) {
    return h('div', { class: 'hrows' }, rows.map(p => h('a', { class: 'hrow', href: '#/purchasing/po/' + p.id, style: { alignItems: 'flex-start' } }, h('span', null, h('strong', null, p.supplier), h('div', { class: 'small muted' }, `${p.no} · ${purWhat(p)}`)), h('span', { style: { textAlign: 'right' } }, h('strong', null, rs(p.amount)), p.verdict ? h('div', { style: { marginTop: '2px' } }, purVerdictB(p.verdict)) : null))));
}
VIEWS.purchasing = async (args) => {
    const [sub, a1] = args;
    if (sub === 'po')
        return purPoPage(a1);
    if (sub === 'new')
        return purPoForm(a1 === 'supplies' ? 'supplies' : 'lot', null, args[2]);
    if (sub === 'edit')
        return purPoForm(null, a1);
    if (sub === 'print')
        return purPrint(a1);
    if (sub === 'lot')
        return purLotPage(a1);
    const m = await purMeta();
    const tab = sub === 'list' ? 'list' : 'overview';
    const newBtns = m.can.create ? [h('a', { class: 'btn', href: '#/purchasing/new/lot' }, '+ Lot PO'), h('a', { class: 'btn ghost', href: '#/purchasing/new/supplies' }, '+ Supplies PO')] : [];
    const head = [pageHead('Purchasing', 'Buy lots and supplies: order → approval → receive → bill → pay', ...newBtns),
        tabs([['overview', 'Overview'], ['list', 'Purchase orders']], tab, k => { location.hash = '#/purchasing/' + k; })];
    if (tab === 'list')
        return purList(head, a1 || 'open', m);
    const d = await GET('/api/pur/overview'), s = d.summary;
    const awaitList = d.awaiting.length ? purPoMini(d.awaiting) : h('div', { class: 'empty' }, icon('check'), ' Nothing waiting for approval.');
    render(head, h('div', { class: 'kpis' }, kpi('Awaiting approval', num(s.awaitingApproval), d.can.approve ? 'needs your OK' : 'with the owner', s.awaitingApproval ? 'warn' : '', '#/purchasing/list/submitted'), kpi('Open orders', num(s.openPOs), 'not closed yet', null, '#/purchasing/list/open'), kpi('Arriving this week', num(s.arrivingThisWeek), s.late ? s.late + ' late' : 'none late', s.late ? 'alert' : '', '#/purchasing/list/open'), kpi('Received, not billed', num(s.receivedNotBilled), 'enter the supplier bill', s.receivedNotBilled ? 'warn' : '', '#/purchasing/list/received'), s.payablesDue != null ? kpi('Payables due', rs(s.payablesDue), s.overdue ? rs(s.overdue) + ' overdue' : 'nothing overdue', s.overdue ? 'alert' : '', '#/payables') : null), h('div', { class: 'split' }, d.chart ? h('div', { class: 'card' }, h('h2', null, 'Purchases by supplier', h('small', null, 'last 6 months · lots by date bought + supplies bills')), chart(d.chart, 'm', d.chartSeries.map((x, i) => ({ k: x.k, l: x.l, c: [C1, C2, C3, C4][i] })))) : h('div', { class: 'card' }, h('h2', null, 'Arriving this week'), d.arriving.length ? purPoTable(d.arriving) : h('div', { class: 'empty' }, 'Nothing expected this week.')), h('div', { class: 'card' }, h('h2', null, 'Awaiting approval', h('small', null, d.awaiting.length ? d.awaiting.length + (d.awaiting.length === 1 ? ' order' : ' orders') : '')), awaitList)), h('div', { class: 'two' }, d.chart ? h('div', { class: 'card' }, h('h2', null, 'Arriving this week', h('small', null, 'and late')), d.arriving.length ? purPoTable(d.arriving) : h('div', { class: 'empty' }, 'Nothing expected this week.')) : null, h('div', { class: 'card' }, h('h2', null, 'Received, not billed', h('small', null, 'enter the supplier bill so the payable is right')), d.notBilled.length ? purPoTable(d.notBilled) : h('div', { class: 'empty' }, 'All received orders are billed.')), d.mine.length ? h('div', { class: 'card' }, h('h2', null, 'My drafts', h('small', null, 'send them for approval')), purPoTable(d.mine)) : null), d.payables && d.payables.length ? h('div', { class: 'card' }, h('h2', null, 'Payables due', h('a', { class: 'spacer small muted', href: '#/payables' }, 'All payables →')), table([{ t: 'Supplier', f: b => [h('strong', null, b.supplier), h('div', { class: 'small muted' }, [b.po_no, b.lot_name, b.bill_no && 'bill ' + b.bill_no].filter(Boolean).join(' · '))] },
        { t: 'Next due', f: b => [day(b.nextDue), b.nextDue < todayStr() ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, 'overdue') : null] }, { t: 'Amount', n: 1, f: b => rs(b.nextAmount) }, { t: 'Total due', n: 1, f: b => rs(b.due) }], d.payables, b => { location.hash = '#/purchasing/po/' + b.po_id; })) : null, d.top && d.top.length ? h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Best suppliers', h('small', null, 'return on lots bought in the last 12 months')), purRoiList(d.top)), d.bottom.length ? h('div', { class: 'card' }, h('h2', null, 'Weakest suppliers', h('small', null, 'lots that make the least')), purRoiList(d.bottom)) : null) : null);
};
function purRoiList(rows) {
    return table([{ t: 'Supplier', f: s => [h('strong', null, s.supplier), h('div', { class: 'small muted' }, `${s.lots} lots · ${num(s.pieces)} pairs · ${rs(s.avgCost)}/pair`)] },
        { t: 'Sold in 60 days', n: 1, f: s => purPct(s.sellThrough60) }, { t: 'Profit / pair', n: 1, f: s => s.profitPerPair == null ? '–' : h('span', { class: purRoiCls(s.profitPerPair > 0 ? 20 : -1) }, rs(s.profitPerPair)) },
        { t: 'ROI so far', n: 1, f: s => h('strong', { class: purRoiCls(s.roi) }, purPct(s.roi)) }], rows, s => { const x = (PUR_META && PUR_META.suppliers || []).find(y => y.name === s.supplier); if (x)
        location.hash = '#/suppliers/s/' + x.id; });
}
async function purList(head, f, m) {
    const d = await GET('/api/pur/pos?' + qs({ status: f === 'all' ? '' : f }));
    const c = d.counts, open = ['draft', 'submitted', 'approved', 'sent', 'partial', 'received', 'billed'].reduce((s, k) => s + (c[k] || 0), 0);
    const tb = tabs([['open', 'Open', open], ['mine', 'My drafts', c.mine || null], ['submitted', 'Awaiting approval', c.submitted || null], ['approved', 'Approved', c.approved || null], ['sent', 'Sent', c.sent || null],
        ['received', 'Received', c.received || null], ['billed', 'Billed', c.billed || null], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'All']], f, k => { location.hash = '#/purchasing/list/' + k; });
    render(head, h('div', { class: 'card' }, tb, h('div', { style: { marginTop: '8px' } }, purPoTable(d.rows, { money: m.can.money || m.can.owner }))));
}
// one lot: what it cost, how far it is listed and sold, what it made so far
async function purLotPage(name) {
    const l = await GET('/api/pur/lots/' + encodeURIComponent(name));
    const back = l.po ? purBack('#/purchasing/po/' + l.po.id, l.po.no) : purBack('#/suppliers', 'Suppliers');
    render(pageHead('Lot ' + l.name, [l.vendor, l.bought_on && 'bought ' + day(l.bought_on), l.po && l.po.no].filter(Boolean).join(' · '), back, h('a', { class: 'btn ghost sm', href: '#/receiving' }, 'Receiving')), h('div', { class: 'kpis' }, kpi('Lot cost', rs(l.total), `${rs(l.cost)} + ${rs(l.extra)} extras · ${rs(l.perPair)}/pair`), kpi('Listed', l.listedPct + '%', `${num(l.listed)} of ${num(l.good)} good pairs`, l.listedPct < 50 && l.received ? 'warn' : ''), kpi('Sold', num(l.delivered), `delivered · ${num(l.sold)} marked sold`), kpi('Revenue', rs(l.revenue), l.avgPrice ? 'avg ' + rs(l.avgPrice) + ' a pair' : 'no deliveries yet'), kpi('Profit so far', rs(l.profit), 'sales after ads, courier & COD − lot cost', l.profit >= 0 ? 'good' : 'alert'), kpi('ROI so far', purPct(l.roi), l.profitPerPair != null ? rs(l.profitPerPair) + ' profit per sold pair' : '', l.roi == null ? '' : l.roi >= 0 ? 'good' : 'warn')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Paid back', h('small', null, 'money back from sales vs lot cost')), h('div', { class: 'bar ' + (l.paidBack >= 100 ? 'ok' : l.paidBack >= 60 ? 'warn' : 'bad'), style: { height: '12px', margin: '6px 0' } }, h('i', { style: { width: Math.min(100, l.paidBack || 0) + '%' } })), h('div', { class: 'small muted' }, `${l.paidBack || 0}% of ${rs(l.total)} back after ads, courier, COD and packing.`), h('dl', { class: 'kv', style: { marginTop: '12px' } }, h('dt', null, 'Sold within 60 days of listing'), h('dd', null, purPct(l.sellThrough60)), h('dt', null, 'Sold within 120 days'), h('dd', null, purPct(l.sellThrough120)), h('dt', null, 'Damaged on arrival'), h('dd', null, l.damaged == null ? 'not received' : num(l.damaged)), h('dt', null, 'Sales after variable costs'), h('dd', null, rs(l.afterCosts)))), h('div', { class: 'card' }, h('h2', null, 'Still to sell'), h('dl', { class: 'kv' }, h('dt', null, 'Listed, unsold pairs'), h('dd', null, num(l.unsold.pairs)), h('dt', null, 'Their list price'), h('dd', null, rs(l.unsold.price)), h('dt', null, 'Their cost'), h('dd', null, rs(l.unsold.cost)), h('div', { class: 'sep' }), h('dt', null, 'Good pairs not listed yet'), h('dd', { class: l.unsold.unlisted ? 'neg' : '' }, num(l.unsold.unlisted)), h('dt', null, 'Their cost'), h('dd', null, rs(l.unsold.unlistedCost))), l.unsold.unlisted ? h('div', { class: 'note warn', style: { marginTop: '10px' } }, `${num(l.unsold.unlisted)} pairs are still waiting to be listed: money sitting on the floor.`) : null)));
}
registerView({ key: 'purchasing', title: 'Purchasing', group: 'Buying', perm: PUR_VIEW, icon: 'doc', order: 10 }, VIEWS.purchasing);
/* ---------- Stock line: lister hands pairs to the warehouse · warehouse receives and puts them on racks ---------- */
const SL_HSTAT = { sent: ['Sent', 'warn'], received: ['Received', 'ok'] };
const slHB = h0 => { const x = SL_HSTAT[h0.status] || [h0.status, '']; return h('span', { class: 'b ' + x[1] }, x[0]); };
const slDiff = d => d ? h('span', { class: 'b bad' }, [d.missing && d.missing.length ? d.missing.length + ' missing' : null, d.extra && d.extra.length ? d.extra.length + ' extra' : null].filter(Boolean).join(' · ')) : null;
// A4 handover sheet with barcodes (SKU + suggested location), printed from a new window
function slPrintSheet(H) {
    const w = window.open('', '_blank');
    if (!w)
        return toast('Allow pop-ups to print the sheet', true);
    const bc = t => { try {
        const s = barcodeSvg(t);
        s.setAttribute('style', 'width:46mm;height:11mm');
        return s.outerHTML;
    }
    catch (_a) {
        return '';
    } };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = H.items.filter(i => !i.extra).map((i, n) => `<tr><td>${n + 1}</td><td>${bc(i.sku)}<div class="m">${esc(i.sku)}</div></td><td>${esc(i.title)}<div class="s">${esc(i.lot)}</div></td><td>${i.suggested ? bc(i.suggested) + '<div class="m">' + esc(i.suggested) + '</div>' : '<i>no slot</i>'}</td><td class="ck"></td></tr>`).join('');
    w.document.write(`${'<'}!doctype html>${'<'}html>${'<'}head><meta charset="utf-8"><title>Handover #${H.id}</title><style>body{font:12px Arial,sans-serif;margin:12mm;color:#000}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:10px}td,th{border:1px solid #999;padding:5px;vertical-align:middle;text-align:left}.m{font:bold 11px "Courier New",monospace}.s{color:#555;font-size:11px}.ck{width:16mm}tr{page-break-inside:avoid}.sig{margin-top:18px;display:flex;gap:40px}</style></\u0068ead>${'<'}body>
<h1>Handover to warehouse #${H.id}</h1><div>${esc(H.created_name || '')} · ${esc(dt(H.at))} · ${H.totals.sent} pairs${H.note ? ' · ' + esc(H.note) : ''}</div>
<table><thead><tr><th>#</th><th>SKU</th><th>Pair</th><th>Put on location</th><th>Got ✓</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sig"><div>Handed over by: ____________________</div><div>Received by: ____________________</div></div><script>setTimeout(()=>print(),300)<\/script>${'<'}/body>${'<'}/html>`);
    w.document.close();
}
function slHandoverTable(H, onRow) {
    return table([{ t: 'SKU', f: i => slSku(i.sku) }, { t: 'Pair', f: i => [i.title || '', h('div', { class: 'small muted' }, i.lot || '')] },
        { t: 'Location', f: i => i.confirmed_loc || i.suggested ? [h('strong', { class: 'mono' }, i.confirmed_loc || i.suggested), i.src === 'lister' && !i.confirmed_loc ? h('div', { class: 'small muted' }, 'from lister') : null] : h('span', { class: 'b warn' }, 'no slot') },
        { t: 'Status', f: i => i.located ? h('span', { class: 'b ok' }, 'On rack') : i.received ? h('span', { class: 'b info' }, 'Received') : H.status === 'received' && !i.extra ? h('span', { class: 'b bad' }, 'Missing') : h('span', { class: 'b' }, 'Sent') },
        { t: '', f: i => [i.extra ? h('span', { class: 'b bad' }, 'Extra') : null, i.warn ? h('div', { class: 'small muted' }, i.warn) : null] }], H.items, onRow);
}
/* ---------- lister: handover ---------- */
VIEWS.handover = async (args) => {
    const tab = args[0] === 'h' ? 'sent' : args[0] === 'sent' ? 'sent' : 'new';
    const head = tabs([['new', 'New handover'], ['sent', 'Handovers']], tab, k => { location.hash = '#/handover' + (k === 'sent' ? '/sent' : ''); });
    if (args[0] === 'h' && args[1])
        return slHandoverView(head, args[1]);
    if (tab === 'sent') {
        const list = await GET('/api/sl/handovers');
        return slRender(head, h('div', { class: 'card' }, table([{ t: '#', f: x => h('strong', null, '#' + x.id) }, { t: 'Sent', f: x => [dt(x.at), h('div', { class: 'small muted' }, x.created_name || '')] }, { t: 'Pairs', n: 1, f: x => num(x.n) },
            { t: 'Received', n: 1, f: x => x.status === 'received' ? num(x.got) : '–' }, { t: 'Status', f: x => [slHB(x), ' ', slDiff(x.diff)] }], list, x => { location.hash = '#/handover/h/' + x.id; })));
    }
    const q = await GET('/api/sl/queue/handover'), cart = new Map(), log = h('div', { class: 'sl-log' }), listBox = h('div'), sumEl = h('span');
    const note = h('input', { placeholder: 'Note for the warehouse (optional)', style: { flex: '1', minWidth: '160px' } });
    const refresh = async () => {
        const skus = [...cart.keys()];
        if (!skus.length) {
            cart.clear();
            return draw();
        }
        const r = await POST('/api/sl/handovers/check', { skus });
        cart.clear();
        for (const x of r.rows)
            cart.set(x.sku, x);
        draw();
    };
    const add = async (code) => {
        if (cart.has(code)) {
            slBeep(false);
            return toast(code + ' is already on this handover', true);
        }
        cart.set(code, { sku: code });
        await refresh();
        const x = cart.get(code) || {};
        slBeep(!x.error);
        if (x.error) {
            cart.delete(code);
            log.prepend(h('div', null, h('span', null, slSku(code), ' ', h('span', { class: 'e' }, x.error))));
            draw();
        }
    };
    const scan = slScan('Scan pairs…', c => add(c).catch(e => toast(e.message, true)));
    const draw = () => {
        const rows = [...cart.values()].filter(x => !x.error), warn = rows.filter(x => x.warn).length;
        sumEl.textContent = rows.length ? `${rows.length} pairs${warn ? ` · ${warn} with warnings` : ''}` : '';
        slFill(listBox, rows.length ? table([{ t: 'SKU', f: x => slSku(x.sku) }, { t: 'Pair', f: x => [x.title || '', h('div', { class: 'small muted' }, x.lot || '')] },
            { t: 'Goes to', f: x => x.suggested ? [h('strong', { class: 'mono' }, x.suggested), x.src === 'lister' ? h('div', { class: 'small muted' }, 'your location') : null] : h('span', { class: 'b warn' }, 'no free slot') },
            { t: '', f: x => [x.warn ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, x.warn) : null, h('button', { class: 'btn ghost sm', onclick: () => { cart.delete(x.sku); refresh(); } }, 'Remove')] }], rows)
            : h('div', { class: 'empty' }, 'Scan pairs or add them from the list of listed pairs.'));
    };
    draw();
    const create = () => act(async () => { const r = await POST('/api/sl/handovers', { skus: [...cart.keys()], note: note.value }); cart.clear(); location.hash = '#/handover/h/' + r.id; return r; }, 'Handover sent to the warehouse');
    const ready = q.rows.filter(r => r.ready), notReady = q.rows.length - ready.length;
    slRender(head, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Hand over to warehouse', h('small', null, sumEl)), scan, h('div', { class: 'small muted', style: { margin: '8px 0' } }, q.settings.blockHandover ? 'Only uploaded pairs can be handed over.' : 'Pairs without photos or upload can be handed over, with a warning.'), log, listBox, h('div', { class: 'row sp', style: { marginTop: '10px' } }, note, h('button', { class: 'btn primary big', onclick: () => cart.size ? create() : toast('Scan the pairs first', true) }, 'Send to warehouse'))), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Listed, not handed over', h('small', null, `${ready.length} uploaded · ${notReady} not uploaded`)), ready.length ? h('button', { class: 'btn ghost sm', onclick: async () => { for (const r of ready.slice(0, 60))
            cart.set(r.sku, { sku: r.sku }); await refresh(); } }, `Add all uploaded (${Math.min(60, ready.length)})`) : null), table([{ t: 'SKU', f: r => slSku(r.sku) }, { t: 'Pair', f: r => [r.title || '', h('div', { class: 'small muted' }, r.lot || '')] }, { t: 'Ready', f: r => r.ready ? h('span', { class: 'b ok' }, 'Uploaded') : h('span', { class: 'b warn' }, r.warn) },
        { t: '', f: r => h('button', { class: 'btn ghost sm', onclick: () => add(r.sku) }, 'Add') }], q.rows.slice(0, 200)))));
};
async function slHandoverView(head, id) {
    const H = await GET('/api/sl/handovers/' + id);
    slRender(head, pageHead('Handover #' + H.id, `${H.created_name || ''} · ${dt(H.at)}${H.note ? ' · ' + H.note : ''}`, h('a', { class: 'btn ghost sm', href: '#/handover/sent' }, '‹ Handovers'), h('button', { class: 'btn', onclick: () => slPrintSheet(H) }, '🖨 Print sheet')), h('div', { class: 'kpis sl-k' }, kpi('Status', H.status === 'sent' ? 'Sent' : 'Received', H.received_name ? 'by ' + H.received_name : 'waiting for the warehouse', H.status === 'sent' ? 'warn' : 'good'), kpi('Pairs', num(H.totals.sent), H.warnings ? H.warnings + ' with warnings' : ''), kpi('On racks', num(H.totals.located), H.status === 'received' ? '' : 'so far'), H.diff ? kpi('Differences', [H.diff.missing.length && H.diff.missing.length + ' missing', H.diff.extra.length && H.diff.extra.length + ' extra'].filter(Boolean).join(' · '), H.diff.note || '', 'alert') : null), H.diff && H.diff.missing.length ? h('div', { class: 'note bad' }, 'The warehouse did not get: ', H.diff.missing.join(', '), '. These pairs are back in your handover list — find them and hand them over again.') : null, h('div', { class: 'card' }, slHandoverTable(H, i => slPairDrawer(i.sku))));
}
/* ---------- warehouse: receive from listing & put away ---------- */
VIEWS['put-away-in'] = async (args) => {
    if (args[0])
        return slReceive(args[0]);
    const [open, done] = await Promise.all([GET('/api/sl/handovers?status=sent'), GET('/api/sl/handovers?status=received')]);
    const cols = [{ t: '#', f: x => h('strong', null, '#' + x.id) }, { t: 'From', f: x => [x.created_name || '', h('div', { class: 'small muted' }, dt(x.at))] }, { t: 'Pairs', n: 1, f: x => num(x.n) }];
    slRender(pageHead('Receive from listing', 'Pairs the listers handed over: scan each pair, then put it on its location'), h('div', { class: 'card' }, h('h2', null, 'Waiting to be received', h('small', null, open.length + ' handovers')), table([...cols, { t: 'Scanned', n: 1, f: x => num(x.got) }, { t: '', f: x => h('a', { class: 'btn sm', href: '#/put-away-in/' + x.id }, 'Receive') }], open, x => { location.hash = '#/put-away-in/' + x.id; })), h('div', { class: 'card' }, h('h2', null, 'Received'), table([...cols, { t: 'Received', f: x => [x.received_name || '', h('div', { class: 'small muted' }, dt(x.received_at))] }, { t: '', f: x => slDiff(x.diff) || h('span', { class: 'b ok' }, 'All correct') }], done.slice(0, 50), x => { location.hash = '#/put-away-in/' + x.id; })));
};
async function slReceive(id) {
    let H = await GET('/api/sl/handovers/' + id);
    const back = h('a', { class: 'btn ghost sm', href: '#/put-away-in' }, '‹ Handovers');
    if (H.status !== 'sent')
        return slRender(pageHead('Handover #' + H.id, `Received by ${H.received_name || ''} · ${dt(H.received_at)}`, back), H.diff ? h('div', { class: 'note bad' }, 'Missing: ', H.diff.missing.join(', ') || 'none', ' · Extra: ', H.diff.extra.join(', ') || 'none') : null, h('div', { class: 'card' }, slHandoverTable(H)));
    let cur = null;
    const now = h('div'), log = h('div', { class: 'sl-log' }), listBox = h('div'), kp = h('div');
    const slotRe = /^([A-Z0-9]+)-R(\d+)-C(\d+)-L(\d+)$/;
    const reload = async () => { H = await GET('/api/sl/handovers/' + id); drawAll(); };
    const locate = async (sku, slot) => {
        const r = await POST(`/api/sl/handovers/${id}/locate`, { sku, slot });
        log.prepend(h('div', null, h('span', null, slSku(r.sku), ' → ', h('strong', { class: 'mono' }, r.slot), r.changed ? h('span', { class: 'w' }, ' changed') : null, r.warnings.length ? h('div', { class: 'w' }, r.warnings.join(' · ')) : null)));
        slBeep(true);
        cur = null;
        await reload();
    };
    const onCode = async (code) => {
        try {
            if (slotRe.test(code) || (cur && /^[A-Z]{1,3}\d{0,2}$/.test(code))) {
                if (!cur) {
                    slBeep(false);
                    return toast('Scan the pair first, then its slot', true);
                }
                return await locate(cur.sku, code);
            }
            const r = await POST(`/api/sl/handovers/${id}/scan`, { sku: code });
            cur = r.item;
            slBeep(!r.extra);
            log.prepend(h('div', null, h('span', null, slSku(r.sku), ' ', r.again ? h('span', { class: 'w' }, 'already scanned') : r.extra ? h('span', { class: 'e' }, 'EXTRA · ' + (r.warn || '')) : h('span', { class: 'b ok' }, 'received'))));
            if (cur.located) {
                cur = null;
                toast(r.sku + ' is already on its rack');
            }
            await reload();
        }
        catch (e) {
            slBeep(false);
            toast(e.message, true);
        }
    };
    const scan = slScan('Scan pair or slot…', onCode);
    const drawAll = () => {
        const T = H.totals;
        slFill(kp, h('div', { class: 'kpis sl-k' }, kpi('Sent', num(T.sent), H.created_name || ''), kpi('Scanned', `${num(T.received)} / ${num(T.sent)}`, T.missing ? T.missing + ' not scanned yet' : 'all here', T.missing ? 'warn' : 'good'), kpi('On racks', num(T.located), ''), kpi('Extra', num(T.extra), 'not on the sheet', T.extra ? 'alert' : '')));
        const target = cur ? (cur.confirmed_loc || cur.suggested) : null;
        slFill(now, cur ? h('div', { class: 'sl-now' + (target ? ' ok' : '') }, h('div', null, h('div', { class: 'small muted' }, slSku(cur.sku), ' goes to'), h('div', { class: 'code' }, target || 'no slot: scan one')), target ? h('button', { class: 'btn ok big', onclick: () => act(() => locate(cur.sku, target)) }, 'Confirm ' + target) : null)
            : h('div', { class: 'sl-now' }, h('div', null, h('div', { class: 'small muted' }, 'Next'), h('div', { class: 'code', style: { fontSize: '18px' } }, 'Scan a pair'))));
        slFill(listBox, slHandoverTable(H, i => { if (!i.located) {
            cur = i;
            drawAll();
        } }));
    };
    drawAll();
    const waiting = () => H.items.filter(i => i.received && !i.located).length;
    slRender(pageHead('Handover #' + H.id, `From ${H.created_name || ''} · ${dt(H.at)}${H.note ? ' · ' + H.note : ''}`, back), kp, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Scan'), scan, h('div', { class: 'small muted', style: { margin: '8px 0' } }, 'Scan the pair, check the location shown, then scan the slot label (or press Confirm). A different slot changes the location.'), now, log), h('div', { class: 'card' }, h('div', { class: 'row sp', style: { marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, 'Pairs on this handover'), h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => waiting() ? act(async () => { const r = await POST(`/api/sl/handovers/${id}/locate-all`); cur = null; await reload(); return r; }, 'Put away at the suggested locations') : toast('Scan the pairs first', true) }, 'Confirm all suggested'), h('button', { class: 'btn primary sm', onclick: () => {
            const T = H.totals, un = waiting();
            const msg = [T.missing && `${T.missing} pair${T.missing > 1 ? 's were' : ' was'} not scanned (missing).`, T.extra && `${T.extra} extra pair${T.extra > 1 ? 's' : ''}.`, un && `${un} received pair${un > 1 ? 's have' : ' has'} no location yet.`].filter(Boolean).join(' ');
            if (msg && !confirm(msg + '\n\nFinish this handover anyway? The lister and the owner will be told.'))
                return;
            act(async () => { await POST(`/api/sl/handovers/${id}/close`, { force: true }); location.hash = '#/put-away-in'; }, 'Handover received');
        } }, 'Finish'))), listBox)));
}
registerView({ key: 'handover', title: 'Handover to warehouse', group: 'Stock line', perm: 'listing', icon: 'swap', order: 50 }, VIEWS.handover);
registerView({ key: 'put-away-in', title: 'Receive from listing', group: 'Warehouse', perm: ['warehouse', 'wms'], icon: 'truck', order: 3 }, VIEWS['put-away-in']);
/* ---------- Stock line: photo, editing and upload queues (scan or tick → done) ---------- */
// One scan screen for each step. Scanner types the SKU + Enter; or tick pairs in the queue and mark them together.
async function slQueue(o) {
    const d = await GET('/api/sl/queue/' + o.kind), picked = new Set(), log = h('div', { class: 'sl-log' }), qbox = h('div'), cnt = h('span');
    let rows = d.rows;
    const lim = d.settings.stuckDays;
    const mark = async (skus, undo) => {
        const r = await POST('/api/sl/mark', { stage: o.stage, skus, undo: !!undo });
        for (const s of r.done)
            log.prepend(h('div', null, h('span', null, slSku(s), ' ', undo ? h('span', { class: 'muted' }, 'undone') : h('span', { class: 'b ok' }, o.doneShort)), undo ? null : h('button', { class: 'btn ghost sm', onclick: e => { e.target.disabled = true; mark([s], true); } }, 'Undo')));
        for (const x of r.skipped)
            log.prepend(h('div', null, h('span', null, slSku(x.sku), ' ', h('span', { class: /already/.test(x.why) ? 'w' : 'e' }, x.why))));
        slBeep(r.done.length > 0);
        const fresh = await GET('/api/sl/queue/' + o.kind);
        rows = fresh.rows;
        d.total = fresh.total;
        d.counts = fresh.counts;
        picked.clear();
        draw();
        return r;
    };
    const scan = slScan('Scan SKU barcode…', code => mark([code]).catch(e => { slBeep(false); toast(e.message, true); }));
    const draw = () => {
        cnt.textContent = num(d.total);
        const all = h('input', { type: 'checkbox', checked: rows.length && picked.size === rows.length, onchange: e => { rows.forEach(r => e.target.checked ? picked.add(r.sku) : picked.delete(r.sku)); draw(); } });
        slFill(qbox, h('div', { class: 'row sp', style: { marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, o.queueTitle, h('small', null, 'oldest first')), h('button', { class: 'btn ok', disabled: !picked.size, onclick: () => act(() => mark([...picked]), null) }, `${o.doneLabel} (${picked.size})`)), table([{ t: all, f: r => h('input', { type: 'checkbox', checked: picked.has(r.sku), onchange: e => { e.target.checked ? picked.add(r.sku) : picked.delete(r.sku); draw(); } }) },
            { t: 'SKU', f: r => slSku(r.sku) }, { t: 'Pair', f: r => [r.title || '', h('div', { class: 'small muted' }, r.lot || '')] }, { t: 'Lister', f: r => r.lister || '' },
            { t: 'Waiting', f: r => slWait(r.waitDays, lim) }], rows));
    };
    draw();
    return { d, node: h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, o.scanTitle, h('small', null, cnt, ' waiting')), scan, h('div', { class: 'small muted', style: { margin: '8px 0' } }, o.help), log), h('div', { class: 'card' }, qbox)) };
}
VIEWS.photos = async (args) => {
    const tab = args[0] === 'edit' ? 'edit' : 'photo';
    const o = tab === 'photo' ? { kind: 'photo', stage: 'photo', scanTitle: 'Photo done', queueTitle: 'Waiting for photos', doneLabel: 'Photo done', doneShort: 'photo done', help: 'Scan each pair after its photos are taken.' }
        : { kind: 'edit', stage: 'edit', scanTitle: 'Editing done', queueTitle: 'Waiting for editing', doneLabel: 'Editing done', doneShort: 'edited', help: 'Scan (or tick) each pair once its pictures are edited.' };
    const q = await slQueue(o), c = q.d.counts || {};
    slRender(tabs([['photo', 'Photography', c.photo], ['edit', 'Picture editing', c.edit]], tab, k => { location.hash = '#/photos' + (k === 'edit' ? '/edit' : ''); }), q.node);
};
VIEWS.upload = async (args) => {
    const tab = args[0] === 'check' ? 'check' : 'queue';
    const head = tabs([['queue', 'Upload'], ['check', 'Shopify check']], tab, k => { location.hash = '#/upload' + (k === 'check' ? '/check' : ''); });
    if (tab === 'queue') {
        const q = await slQueue({ kind: 'upload', stage: 'upload', scanTitle: 'Uploaded', queueTitle: 'Waiting for upload', doneLabel: 'Mark uploaded', doneShort: 'uploaded',
            help: 'Pairs that appear in Shopify are marked uploaded by themselves at the next sync. Mark here only if you uploaded them just now.' });
        return slRender(head, q.node);
    }
    const d = await GET('/api/sl/upload/check');
    const cols = extra => [{ t: 'SKU', f: r => slSku(r.sku) }, { t: 'Pair', f: r => [r.title || '', h('div', { class: 'small muted' }, r.lot || '')] }, { t: 'Lister', f: r => r.lister || '' }, ...extra];
    slRender(head, pageHead('Shopify check', 'The ERP compares what was marked uploaded with what the Shopify sync brought in'), h('div', { class: 'kpis sl-k' }, kpi('Marked but not in Shopify', num(d.notFound.length), 'check the upload', d.notFound.length ? 'alert' : 'good'), kpi('Found in Shopify', num(d.autoDetected.length), 'marked by the sync (14 days)'), kpi('Still Draft in Shopify', num(d.drafts.length), 'not visible to customers', d.drafts.length ? 'warn' : '')), h('div', { class: 'card' }, h('h2', null, 'Marked uploaded, not found in Shopify'), table(cols([{ t: 'Marked by', f: r => r.marked_by || '' }, { t: 'When', f: r => dt(r.uploaded_at) }]), d.notFound)), h('div', { class: 'card' }, h('h2', null, 'In Shopify, nobody marked it', h('small', null, 'marked uploaded automatically')), table(cols([{ t: 'Shopify', f: r => h('span', { class: 'b ' + (r.shop_status === 'ACTIVE' ? 'ok' : 'warn') }, r.shop_status || '–') }, { t: 'Found', f: r => dt(r.uploaded_at) }]), d.autoDetected)), d.drafts.length ? h('div', { class: 'card' }, h('h2', null, 'Still Draft in Shopify'), table(cols([{ t: 'Since', f: r => dt(r.uploaded_at) }]), d.drafts)) : null);
};
registerView({ key: 'photos', title: 'Photos & editing', group: 'Stock line', perm: 'listing', icon: 'tag', order: 30 }, VIEWS.photos);
registerView({ key: 'upload', title: 'Upload', group: 'Stock line', perm: 'listing', icon: 'box', order: 40 }, VIEWS.upload);
/* ---------- Stock line: sorting sheet + QC per lot ---------- */
VIEWS.sorting = async (args) => {
    if (args[0] === 'lot' && args[1])
        return slLot(args[1]);
    const all = args[0] === 'all', d = await GET('/api/sl/lots' + (all ? '?all=1' : ''));
    const head = tabs([['open', 'In the line', d.lots.length], ['all', 'All lots']], all ? 'all' : 'open', k => { location.hash = k === 'all' ? '#/sorting/all' : '#/sorting'; });
    const todo = d.lots.filter(l => l.status === 'to_sort');
    slRender(head, pageHead('Sorting & QC', 'Count what came in each lot, then check every pair', can('wms') ? h('a', { class: 'btn ghost', href: '#/receiving' }, 'Receiving (GRN)') : null), todo.length ? h('div', { class: 'note warn' }, `${todo.length} lot${todo.length > 1 ? 's are' : ' is'} waiting to be sorted: `, todo.slice(0, 4).map((l, i) => [i ? ', ' : '', h('a', { href: '#/sorting/lot/' + encodeURIComponent(l.name) }, l.name)])) : null, h('div', { class: 'card' }, d.lots.length ? table([{ t: 'Lot', f: l => [h('strong', null, l.name), h('div', { class: 'small muted' }, l.vendor)] }, { t: 'Status', f: l => slLotB(l.status) },
        { t: 'Received', f: l => l.received_at ? [day(l.received_at), h('div', { class: 'small muted' }, l.days + ' days ago')] : '–' }, { t: 'GRN', n: 1, f: l => l.grn ? num(l.grn.good + l.grn.damaged) : '–' },
        { t: 'Sorted', n: 1, f: l => l.sorted ? num(l.sorted.total) : h('span', { class: 'b warn' }, 'to do') }, { t: 'QC passed', n: 1, f: l => l.qc.batches ? num(l.qc.passed) : '–' },
        { t: 'Rejected', n: 1, f: l => l.qc.rejected ? h('span', { class: 'neg' }, num(l.qc.rejected)) : '–' }, { t: 'Listed', n: 1, f: l => num(l.listed) }], d.lots, l => { location.hash = '#/sorting/lot/' + encodeURIComponent(l.name); }) : h('div', { class: 'empty' }, 'No lots in the line. Receive a lot first (Receiving / GRN).')));
};
async function slLot(name) {
    const d = await GET('/api/sl/lots/' + encodeURIComponent(name)), L = d.lot, s = d.sort;
    const back = h('a', { class: 'btn ghost sm', href: '#/sorting' }, '‹ All lots');
    const grnN = L.grn ? L.grn.good + L.grn.damaged : 0;
    /* sorting sheet */
    const start = s ? s.rows : (d.compare.po && d.compare.po.mix.length ? d.compare.po.mix.map(r => (Object.assign(Object.assign({}, r), { n: '' }))) : [{ g: 'Woman', t: d.types[0], c: 'Excellent', n: '' }]);
    const rows = start.map(r => (Object.assign({}, r))), rowBox = h('div'), total = h('div', { class: 'sl-big' });
    const dmg = h('input', { type: 'number', min: 0, value: s ? s.damaged : '', placeholder: '0', oninput: () => sum() }), unm = h('input', { type: 'number', min: 0, value: s ? s.unmatched : '', placeholder: '0', oninput: () => sum() });
    const notes = h('input', { value: s ? s.notes || '' : '', placeholder: 'Anything unusual in this lot' });
    const sum = () => {
        const good = rows.reduce((t, r) => t + (+r.n || 0), 0), all = good + (+dmg.value || 0) + (+unm.value || 0);
        slFill(total, h('strong', null, num(all) + ' pairs counted'), ` = ${num(good)} good + ${num(+dmg.value || 0)} damaged + ${num(+unm.value || 0)} unmatched`, L.grn ? h('div', { class: all === grnN ? 'small pos' : 'small neg' }, all === grnN ? `Same as the ${grnN} received at GRN` : `GRN counted ${grnN}: ${all > grnN ? all - grnN + ' more' : grnN - all + ' fewer'}`) : null);
    };
    const drawRows = () => {
        slFill(rowBox, h('div', { class: 'sl-row small muted' }, h('span', null, 'Gender'), h('span', { class: 'ty' }, 'Type'), h('span', null, 'Condition'), h('span', null, 'Pairs'), h('span')), rows.map((r, i) => h('div', { class: 'sl-row' }, h('select', { onchange: e => { r.g = e.target.value; } }, ['Woman', 'Men', 'Kids'].map(g => h('option', { selected: r.g === g }, g))), h('select', { class: 'ty', onchange: e => { r.t = e.target.value; } }, d.types.map(t => h('option', { selected: r.t === t }, t))), h('select', { onchange: e => { r.c = e.target.value; } }, d.conds.map(c => h('option', { selected: r.c === c }, c))), h('input', { type: 'number', min: 0, value: r.n, placeholder: '0', oninput: e => { r.n = e.target.value; sum(); } }), h('button', { class: 'btn ghost sm', title: 'Remove', onclick: () => { rows.splice(i, 1); drawRows(); sum(); } }, '×'))));
    };
    drawRows();
    sum();
    const saveSort = () => act(async () => { const r = await POST('/api/sl/lots/' + encodeURIComponent(name) + '/sort', { rows, damaged: +dmg.value || 0, unmatched: +unm.value || 0, notes: notes.value }); slLot(name); return r; }, 'Sorting saved: lot mix updated');
    const sortCard = h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, '1 · Sorting sheet', h('small', null, 'count the pairs by type and condition')), s ? h('span', { class: 'small muted' }, [(L.sorted || {}).by, dt(s.updated_at)].filter(Boolean).join(' · ')) : null), L.grn ? null : h('div', { class: 'note warn' }, 'Receive this lot at GRN before sorting.'), rowBox, h('button', { class: 'btn ghost sm', onclick: () => { const lr = rows[rows.length - 1] || { g: 'Woman', t: d.types[0], c: 'Excellent' }; rows.push({ g: lr.g, t: lr.t, c: lr.c, n: '' }); drawRows(); } }, '+ Add row'), h('div', { class: 'fgrid', style: { marginTop: '12px' } }, field('Damaged pairs', dmg), field('Unmatched (odd shoes, wrong pairs)', unm), h('label', { class: 'f full' }, 'Note', notes)), h('div', { class: 'row sp', style: { marginTop: '10px' } }, total, h('button', { class: 'btn primary', disabled: !L.grn, onclick: saveSort }, s ? 'Update sorting' : 'Save sorting')));
    /* PO compare */
    const C = d.compare;
    const cmpCard = C.po ? h('div', { class: 'card' }, h('h2', null, 'Ordered vs found', h('small', null, `${C.po.no} · ${C.po.supplier}`)), h('div', { class: 'sl-kv' }, h('span', null, 'Ordered ', h('b', null, num(C.totals.expected))), h('span', null, 'Counted ', h('b', null, C.totals.sorted == null ? '–' : num(C.totals.sorted)), C.totals.diff ? h('span', { class: 'neg' }, ` (${C.totals.diff > 0 ? '+' : ''}${C.totals.diff})`) : null), h('span', null, 'Bad pairs ', h('b', { class: C.totals.bad > C.totals.expBad ? 'neg' : '' }, C.totals.bad == null ? '–' : num(C.totals.bad)), h('span', { class: 'muted' }, ` (expected ${C.totals.expBad})`))), table([{ t: 'Pairs', f: r => `${r.g} ${r.t}` }, { t: 'Condition', k: 'c' }, { t: 'Ordered', n: 1, f: r => num(r.expected) }, { t: 'Found', n: 1, f: r => s ? num(r.actual) : '–' },
        { t: 'Difference', n: 1, f: r => !s ? '–' : r.diff ? h('strong', { class: r.diff < 0 ? 'neg' : 'pos' }, (r.diff > 0 ? '+' : '') + r.diff) : h('span', { class: 'muted' }, '0') }], C.rows)) : null;
    /* QC */
    const passed = h('input', { type: 'number', min: 0, placeholder: '0' }), rej = Object.fromEntries(d.reasons.map(r => [r, h('input', { type: 'number', min: 0, placeholder: '0' })]));
    const qn = h('input', { placeholder: 'Optional' });
    const left = s ? Math.max(0, s.good - L.qc.passed - L.qc.rejected) : 0;
    const saveQc = () => act(async () => {
        const r = await POST('/api/sl/lots/' + encodeURIComponent(name) + '/qc', { passed: +passed.value || 0, rejected: Object.fromEntries(Object.entries(rej).map(([k, el]) => [k, +el.value || 0])), notes: qn.value });
        if (r.claim)
            toast(`${r.rejected} rejected pairs added to the claim on ${r.claim.no}`);
        slLot(name);
        return r;
    }, 'QC batch saved');
    const RL = { torn: 'Torn', sole: 'Sole broken', stain: 'Stain', mismatched: 'Mismatched', fake: 'Fake' };
    const qcCard = h('div', { class: 'card' }, h('h2', null, '2 · QC check', h('small', null, s ? `${num(left)} of ${num(s.good)} good pairs still to check` : 'save the sorting sheet first')), s ? [h('div', { class: 'fgrid' }, field('Pairs passed', passed), field('Note', qn)), h('div', { class: 'small muted', style: { margin: '8px 0 4px' } }, 'Pairs rejected, by reason'),
        h('div', { class: 'sl-rej' }, d.reasons.map(r => field(RL[r] || r, rej[r]))),
        h('div', { class: 'row sp', style: { marginTop: '10px' } }, h('span', { class: 'small muted' }, C.po ? `Rejected pairs go on the supplier claim for ${C.po.no} (settle it on the purchase order).` : 'Rejected pairs are taken out of the lot (cost spread over the good pairs).'), h('button', { class: 'btn primary', onclick: saveQc }, 'Save QC batch'))] : null, d.qcBatches.length ? h('div', { style: { marginTop: '12px' } }, table([{ t: 'When', f: x => dt(x.at) }, { t: 'By', k: 'by_name' }, { t: 'Passed', n: 1, f: x => num(x.passed) }, { t: 'Rejected', n: 1, f: x => x.rejected ? h('span', { class: 'neg' }, num(x.rejected)) : '0' },
        { t: 'Reasons', f: x => Object.entries(x.reasons).map(([k, n]) => `${RL[k] || k} ${n}`).join(', ') }], d.qcBatches)) : null);
    slRender(pageHead(name, [L.vendor, L.received_at ? 'received ' + day(L.received_at) + ` (${L.days} days ago)` : 'not received'].filter(Boolean).join(' · '), back, h('a', { class: 'btn ghost', href: '#/stockline/lot/' + encodeURIComponent(name) }, 'Stock line')), h('div', { class: 'kpis sl-k' }, kpi('Received (GRN)', L.grn ? num(grnN) : '–', L.grn ? `${L.grn.good} good · ${L.grn.damaged} damaged` : 'not yet'), kpi('Sorted', L.sorted ? num(L.sorted.total) : '–', L.sorted ? `${L.sorted.good} good` : 'to do', L.sorted ? '' : 'warn'), kpi('QC passed', L.qc.batches ? num(L.qc.passed) : '–', L.qc.batches ? (L.qc.rejected ? L.qc.rejected + ' rejected' : 'none rejected') : 'to do'), kpi('Listed', num(L.listed), `${L.pct}% on racks`)), d.perPair && d.perPair.per_piece ? h('div', { class: 'note' }, `Owner: cost per good pair now ${rs(d.perPair.per_piece)} (listing prices use this lot's real mix).`) : null, h('div', { class: 'two' }, sortCard, h('div', { class: 'grid' }, cmpCard, qcCard)));
}
registerView({ key: 'sorting', title: 'Sorting & QC', group: 'Stock line', perm: ['wms', 'listing'], icon: 'check', order: 15 }, VIEWS.sorting);
/* ---------- Stock line: lot → sorting → QC → listed → photo → edited → uploaded → handed over → received → located ---------- */
const SL_NEXT = { grn: 'sorting', sorted: 'QC', qc: 'listing', listed: 'photo', photo: 'editing', edited: 'upload', uploaded: 'handover', handed: 'warehouse', inwh: 'location' };
const SL_LOT_ST = { not_received: ['Not received', 'bad'], to_sort: ['To sort', 'warn'], qc: ['QC', 'info'], listing: ['Listing', 'info'], in_line: ['In line', 'accent'], done: ['Done', 'ok'] };
const SL_HREF = { grn: '#/sorting', sorted: '#/sorting', qc: '#/list', listed: '#/photos', photo: '#/photos/edit', edited: '#/upload', uploaded: '#/handover', handed: '#/put-away-in', inwh: '#/put-away-in' };
(function slCss() {
    if (document.getElementById('sl-css'))
        return;
    const s = document.createElement('style');
    s.id = 'sl-css';
    s.textContent = `
.sl-flow{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px}
.sl-st{position:relative;display:flex;flex-direction:column;gap:2px;padding:12px 12px 10px;border-radius:var(--r);background:var(--panel);border:1px solid var(--line);cursor:pointer;text-decoration:none;color:inherit;box-shadow:var(--shadow);min-width:0}
.sl-st:hover{background:var(--hover)} .sl-st .l{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-st .v{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1} .sl-st .s{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-st.lot{background:var(--soft)} .sl-st.late{border-color:var(--warn);background:var(--warn-bg)} .sl-st.late .o{color:var(--warn);font-weight:600}
.sl-st.done{background:var(--ok-bg);border-color:transparent} .sl-st.done .v{color:var(--ok)} .sl-st.zero .v{opacity:.35}
.sl-st .n{position:absolute;top:8px;right:10px;font-size:10.5px;color:var(--muted);font-weight:700}
.sl-chips{display:flex;gap:6px;flex-wrap:wrap}
.sl-chip{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 12px;cursor:pointer;font-weight:600;font-size:13px}
.sl-chip.on{background:var(--brand2);color:#fff;border-color:transparent}
.sl-alerts>div{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px} .sl-alerts>div:last-child{border:0}
.sl-big{font-size:15px} .sl-now{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px;border-radius:var(--r);background:var(--soft);border:1px solid var(--line);flex-wrap:wrap}
.sl-now .code{font-family:var(--mono);font-size:26px;font-weight:800} .sl-now.ok{background:var(--ok-bg);border-color:transparent} .sl-now.ok .code{color:var(--ok)}
.sl-log{max-height:46vh;overflow:auto} .sl-log>div{display:flex;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px solid var(--line);font-size:13.5px;align-items:center}
.sl-log .w{color:var(--warn);font-size:12.5px;font-weight:600} .sl-log .e{color:var(--bad);font-size:12.5px;font-weight:600}
.sl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.sl-row{display:grid;grid-template-columns:96px minmax(0,1.6fr) minmax(0,1fr) 78px 34px;gap:6px;align-items:center;margin-bottom:6px}
.sl-row select,.sl-row input{min-width:0;width:100%}
.sl-rej{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}
.content:has(>.sl-page)>*{min-width:0} .sl-page~* td .mono{white-space:nowrap}
.sl-pp>div{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)} .sl-pp>div:last-child{border:0} .sl-pp strong{min-width:90px}
.sl-kv{display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:10px;font-size:13.5px} .sl-kv b{font-variant-numeric:tabular-nums}
@media (max-width:600px){.sl-flow{grid-template-columns:1fr 1fr}.sl-st .v{font-size:22px}.sl-row{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) 60px 30px;padding-bottom:6px;border-bottom:1px dashed var(--line)}.sl-row .ty{grid-column:1/-1;order:-1}.sl-row.small{display:none}.sl-now .code{font-size:21px}
  .sl-k.kpis{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.sl-k .kpi{padding:10px 12px}.sl-k .kpi .v{font-size:20px}}
`;
    document.head.append(s);
})();
const slRender = (...kids) => render(h('i', { class: 'sl-page', hidden: true }), ...kids);
const slSku = s => h('strong', { class: 'mono' }, s);
const slWait = (d, lim) => h('span', { class: 'b ' + (d > lim ? (d > 2 * lim ? 'bad' : 'warn') : '') }, d < 1 ? 'today' : d + (d === 1 ? ' day' : ' days'));
const slLotB = st => { const x = SL_LOT_ST[st] || [st, '']; return h('span', { class: 'b ' + x[1] }, x[0]); };
function slFill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false).map(k => k instanceof Node ? k : document.createTextNode(String(k)))); }
function slScan(ph, onCode) {
    if (typeof wmsScan === 'function')
        return wmsScan(ph, onCode);
    const i = h('input', { placeholder: ph, autocomplete: 'off' });
    i.addEventListener('keydown', async (e) => { if (e.key === 'Enter') {
        const v = i.value.trim().toUpperCase();
        i.value = '';
        if (v)
            await onCode(v);
        i.focus();
    } });
    const box = h('div', { class: 'scanbox' }, i);
    box.input = i;
    return box;
}
const slBeep = ok => { if (typeof wmsBeep === 'function')
    wmsBeep(ok); };
function slPairDrawer(sku) {
    GET('/api/sl/pair/' + encodeURIComponent(sku)).then(p => drawer(h('div', { class: 'grid' }, h('div', { class: 'row sp' }, h('h2', { class: 'mono', style: { margin: 0 } }, p.sku), h('span', { class: 'b info' }, p.steps.find(s => s.k === p.stage).l)), h('div', { class: 'muted' }, [p.title, p.lot, p.grade].filter(Boolean).join(' · ')), h('div', { class: 'timeline' }, p.steps.map(s => h('div', { class: s.at ? '' : 'muted' }, h('div', { class: 't' }, s.at ? dt(s.at) + (s.by ? ' · ' + s.by : '') : 'not yet'), s.l))), p.coreLoc ? h('div', null, 'Location: ', h('strong', { class: 'mono' }, p.coreLoc)) : p.pref_loc ? h('div', { class: 'muted' }, 'Lister location: ', h('span', { class: 'mono' }, p.pref_loc)) : null, p.next ? h('div', { class: 'note' }, 'Next: ' + p.next) : h('div', { class: 'note ok' }, 'On its rack location.')))).catch(e => toast(e.message, true));
}
/* ---------- board ---------- */
VIEWS.stockline = async (args) => {
    if (args[0] === 'stage')
        return slStage(args[1], args[2] || '');
    const lot = args[0] === 'lot' ? args[1] || '' : '';
    const B = await GET('/api/sl/board' + (lot ? '?lot=' + encodeURIComponent(lot) : ''));
    const lim = B.settings.stuckDays, last = B.stages.length - 1;
    const lotSel = h('select', { onchange: e => { location.hash = e.target.value ? '#/stockline/lot/' + encodeURIComponent(e.target.value) : '#/stockline'; } }, h('option', { value: '' }, 'All lots'), B.lots.map(l => h('option', { value: l.name, selected: l.name === lot }, l.name)));
    const flow = h('div', { class: 'sl-flow' }, B.stages.map((s, i) => h('a', { class: 'sl-st' + (s.lot ? ' lot' : '') + (i === last ? ' done' : s.oldestDays > lim ? ' late' : '') + (!s.n ? ' zero' : ''), href: '#/stockline/stage/' + s.k + (lot ? '/' + encodeURIComponent(lot) : '') }, h('span', { class: 'n' }, i + 1), h('span', { class: 'l' }, s.l), h('span', { class: 'v' }, num(s.n)), h('span', { class: 's' }, i === last ? 'on the rack' : 'next: ' + SL_NEXT[s.k]), i !== last && s.n && s.oldest ? h('span', { class: 's o' }, s.oldestDays ? `oldest ${s.oldestDays} day${s.oldestDays > 1 ? 's' : ''}` : 'oldest: today') : null)));
    const al = [...B.lotStuck.map(x => ({ t: `${x.lot}: ${num(x.n)} pairs ${x.label.toLowerCase()} for ${x.days} days`, href: '#/sorting/lot/' + encodeURIComponent(x.lot), bad: x.days > 2 * lim })),
        ...B.stuck.map(x => ({ t: `${num(x.n)} pair${x.n > 1 ? 's' : ''} waiting for ${x.next} over ${lim} days (oldest ${x.days} days)`, href: '#/stockline/stage/' + x.stage, bad: x.days > 2 * lim }))];
    // throughput chart: one step at a time
    const steps = [['listed', 'Listed'], ['photo', 'Photo'], ['edited', 'Edited'], ['uploaded', 'Uploaded'], ['handed', 'Handed over'], ['inwh', 'Received'], ['located', 'Located'], ['sorted', 'Sorted'], ['qc', 'QC']];
    let cur = store.get('sl_step', 'listed');
    const chartBox = h('div'), chips = h('div', { class: 'sl-chips' });
    const drawChart = () => {
        slFill(chips, steps.map(([k, l]) => h('button', { class: 'sl-chip' + (k === cur ? ' on' : ''), onclick: () => { cur = k; store.set('sl_step', k); drawChart(); } }, l)));
        slFill(chartBox, chart(B.daily.map(d => ({ day: d.day, v: d[cur] || 0 })), 'day', [{ k: 'v', l: (steps.find(s => s[0] === cur) || [])[1] + ' (pairs)', c: C2 }], 160));
    };
    drawChart();
    const pcols = [['sorted', 'Sorted'], ['qc', 'QC'], ['listed', 'Listed'], ['photo', 'Photo'], ['edited', 'Edited'], ['uploaded', 'Upload'], ['handed', 'Handed'], ['inwh', 'Received'], ['located', 'Located']].filter(([k]) => B.people.some(p => p[k]));
    const locatedToday = (B.daily[B.daily.length - 1] || {}).located || 0;
    slRender(pageHead('Stock line', lot ? 'Lot ' + lot : 'Every pair from the lot to the rack', lotSel, can('team') || ME.role === 'admin' ? h('button', { class: 'btn ghost', onclick: () => formModal('Stock line settings', [{ k: 'stuckDays', label: 'Alert when a pair waits at a step more than (days)', type: 'number', value: B.settings.stuckDays },
            { k: 'unsortedDays', label: 'Alert when a received lot is not sorted after (days)', type: 'number', value: B.settings.unsortedDays }, { k: 'blockHandover', label: 'Block handover until the pair is uploaded', type: 'checkbox', value: B.settings.blockHandover }], async (v) => { await POST('/api/sl/settings', v); toast('Saved'); VIEWS.stockline(args); }) }, icon('gear', 16), ' Settings') : null), h('div', { class: 'kpis sl-k' }, kpi('In the line', num(B.totals.inLine), 'pairs not on a rack yet'), kpi('Stuck', num(B.totals.stuckPairs), `waiting over ${lim} days`, B.totals.stuckPairs ? 'alert' : 'good'), kpi('Located today', num(locatedToday), 'pairs put on racks'), kpi('Lots in line', num(B.lots.length), B.lots.filter(l => l.status === 'to_sort').length + ' waiting to be sorted')), h('div', { class: 'card' }, h('h2', null, 'Where the pairs are', h('small', null, 'tap a step to see its pairs')), flow), al.length ? h('div', { class: 'card' }, h('h2', null, 'Bottlenecks'), h('div', { class: 'sl-alerts' }, al.map(a => h('div', null, h('span', null, h('span', { class: 'b ' + (a.bad ? 'bad' : 'warn') }, a.bad ? 'Late' : 'Slow'), ' ', a.t), h('a', { class: 'btn ghost sm', href: a.href }, 'Open'))))) : null, h('div', { class: 'card' }, h('h2', null, 'Lots', h('small', null, 'completion = good pairs on a rack')), table([{ t: 'Lot', f: l => [h('strong', null, l.name), h('div', { class: 'small muted' }, l.vendor)] }, { t: 'Status', f: l => slLotB(l.status) },
        { t: 'Since GRN', f: l => l.days == null ? '–' : l.days + ' d' }, { t: 'Sorted', n: 1, f: l => l.sorted ? num(l.sorted.total) : '–' }, { t: 'QC ok / bad', n: 1, f: l => l.qc.batches ? `${l.qc.passed} / ${l.qc.rejected}` : '–' },
        { t: 'Listed', n: 1, f: l => num(l.listed) }, { t: 'Located', n: 1, f: l => num(l.located) }, { t: 'Done', f: l => h('div', { style: { minWidth: '90px' } }, bar(l.pct), h('div', { class: 'small muted' }, l.pct + '% of ' + num(l.target))) }], B.lots, l => { location.hash = '#/stockline/lot/' + encodeURIComponent(l.name); })), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Daily output', h('small', null, 'last 7 days')), chips, h('div', { style: { marginTop: '8px' } }, chartBox)), h('div', { class: 'card' }, h('h2', null, 'Who did what', h('small', null, 'pairs, last 7 days')), B.people.length ? h('div', { class: 'sl-pp' }, B.people.map(p => h('div', null, h('strong', null, p.name), pcols.filter(([k]) => p[k]).map(([k, l]) => h('span', { class: 'b' }, `${l} ${num(p[k])}`))))) : h('div', { class: 'empty' }, 'No work recorded yet.'))));
};
async function slStage(k, lot) {
    const d = await GET('/api/sl/stage/' + k + (lot ? '?lot=' + encodeURIComponent(lot) : ''));
    const back = h('a', { class: 'btn ghost sm', href: lot ? '#/stockline/lot/' + encodeURIComponent(lot) : '#/stockline' }, '‹ Stock line');
    const go = SL_HREF[k] ? h('a', { class: 'btn', href: SL_HREF[k] }, 'Open ' + SL_NEXT[k] + ' screen') : null;
    if (d.lots)
        return slRender(pageHead({ grn: 'Received, waiting for sorting', sorted: 'Sorted, waiting for QC', qc: 'QC passed, waiting to be listed' }[k] || k, lot || 'All lots', back, go), h('div', { class: 'card' }, table([{ t: 'Lot', f: l => h('strong', null, l.name) }, { t: 'Pairs here', n: 1, f: l => num(l.counts[k]) }, { t: 'Since GRN', f: l => l.days == null ? '–' : l.days + ' d' }, { t: 'Status', f: l => slLotB(l.status) }], d.lots, l => { location.hash = '#/sorting/lot/' + encodeURIComponent(l.name); })));
    slRender(pageHead(d.label + (d.next ? ' · waiting for ' + d.next : ''), `${num(d.rows.length)} pairs${lot ? ' · ' + lot : ''}`, back, go, h('button', { class: 'btn ghost', onclick: () => csvDownload(`stock-line-${k}.csv`, d.rows.map(r => ({ sku: r.sku, title: r.title, lot: r.lot, lister: r.lister, since: r.since, days: r.waitDays, location: r.location || r.pref_loc || '' }))) }, 'CSV')), h('div', { class: 'card' }, table([{ t: 'SKU', f: r => slSku(r.sku) }, { t: 'Pair', f: r => [r.title || '', h('div', { class: 'small muted' }, r.lot || '')] }, { t: 'Lister', k: 'lister' },
        { t: k === 'located' ? 'Located' : 'Waiting', f: r => k === 'located' ? dt(r.since) : slWait(r.waitDays, d.stuckDays) }, { t: 'Location', f: r => r.location || r.pref_loc ? h('span', { class: 'mono' }, r.location || r.pref_loc) : '' }], d.rows, r => slPairDrawer(r.sku))));
}
registerView({ key: 'stockline', title: 'Stock line', group: 'Stock line', perm: ['listing', 'wms', 'team'], icon: 'layers', order: 5 }, VIEWS.stockline);
/* ---------- finance: COD & payments (courier COD settlement). Profit & loss lives in Accounts → Statements; office expenses in My expenses / Expense approvals. ---------- */
VIEWS.finance = async (args) => {
    if (args[0] === 'pnl') {
        location.replace('#/statements/pnl');
        return;
    }
    if (args[0] === 'expenses') {
        location.replace(can('expenses_approve') ? '#/approvals' : '#/expenses');
        return;
    }
    const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7), 'aria-label': 'Month' });
    const csv = async () => { try {
        const r = await fetch('/api/finance/export?month=' + month.value);
        if (!r.ok)
            throw new Error('Export failed');
        const b = await r.blob();
        const a = h('a', { href: URL.createObjectURL(b), download: 'sundaybazar-orders-' + month.value + '.csv' });
        document.body.append(a);
        a.click();
        a.remove();
    }
    catch (x) {
        toast(x.message, true);
    } };
    const head = h('div', null, pageHead('COD & payments', 'Cash on delivery the couriers still owe, and what has been paid', can('accounts') ? h('a', { class: 'btn ghost sm', href: '#/statements/pnl' }, icon('bank', 16), 'Profit & loss') : null), h('div', { class: 'row small muted', style: { margin: '-4px 0 10px' } }, 'Orders CSV for', month, h('button', { class: 'btn ghost sm', onclick: csv }, 'Download')));
    let settled = '0';
    const load = async () => {
        const d = await GET('/api/finance/cod?settled=' + settled);
        const sel = new Set();
        const mark = h('button', { class: 'btn', disabled: true, onclick: async () => { const ref = prompt('PostEx payment reference (CPR) — optional'); await act(() => POST('/api/finance/settle', { ids: [...sel], ref }), 'Marked as paid'); load(); } }, 'Mark selected as paid');
        render(head, tabs([['0', 'Not paid yet'], ['1', 'Paid']], settled, v => { settled = v; load(); }), h('div', { class: 'kpis' }, kpi(settled === '0' ? 'COD waiting from PostEx' : 'COD received', rs(d.cod), num(d.n) + ' parcels'), kpi('PostEx charges on these', rs(d.fees))), h('div', { class: 'card' }, settled === '0' ? h('div', { class: 'row sp', style: { marginBottom: '8px' } }, h('span', { class: 'small muted' }, META.postex ? 'Payment status is checked with PostEx automatically. Mark by hand only if needed.' : 'Mark parcels paid when the PostEx payment arrives.'), mark) : null, table([settled === '0' && { t: '', f: r => h('input', { type: 'checkbox', onchange: e => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); mark.disabled = !sel.size; } }) },
            { t: 'Order', k: 'name' }, { t: 'Customer', f: r => [r.cust_name, h('div', { class: 'small muted' }, r.city)] }, { t: 'Tracking', f: r => h('span', { class: 'mono' }, r.tracking) },
            { t: 'Delivered', f: r => day(r.delivered_at) }, { t: 'COD', n: 1, f: r => { var _a; return rs((_a = r.cod) !== null && _a !== void 0 ? _a : r.total); } }, { t: 'Charges', n: 1, f: r => rs((r.px_fee || 0) + (r.px_tax || 0)) },
            settled === '1' && { t: 'Paid on', f: r => day(r.settled_at) }, settled === '1' && { t: 'Reference', k: 'settle_ref' }].filter(Boolean), d.rows)));
    };
    return load();
};
registerView({ key: 'finance', title: 'COD & payments', group: 'Finance', perm: 'finance', icon: 'wallet', order: 10 }, VIEWS.finance);
/* ---------- accounts: month close, automatic postings, opening balances, settings ---------- */
const ACC_ST = { pass: ['ok', 'Pass'], warn: ['warn', 'Check'], fail: ['bad', 'Fail'] };
registerView({ key: 'close', title: 'Month close', group: 'Finance', perm: 'accounts', icon: 'check', order: 70 }, async (args) => {
    const tab = ['checks', 'auto', 'opening', 'settings'].includes(args[0]) ? args[0] : 'checks', P = can('accounts_post');
    const head = tabs([['checks', 'Checks & close'], ['auto', 'Automatic postings'], ['opening', 'Opening balances'], ['settings', 'Settings']], tab, k => { location.hash = '#/close/' + k; });
    const postNow = () => P ? h('button', { class: 'btn ghost', onclick: async () => { const r = await act(() => POST('/api/accounts/auto')); toast(r.off || `Posted ${r.posted.length} entries` + (r.removed ? `, removed ${r.removed}` : '') + (r.unchanged ? `, ${r.unchanged} already up to date` : '')); route(); } }, 'Post now') : null;
    if (tab === 'checks') {
        const month = h('input', { type: 'month', value: /^\d{4}-\d{2}$/.test(args[1] || '') ? args[1] : accPrevMonth(), max: todayStr().slice(0, 7) });
        const box = h('div', { class: 'grid' });
        const load = async () => {
            accFill(box, h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Running checks…'));
            const d = await GET('/api/accounts/close?month=' + month.value), ended = d.to < todayStr();
            const close = async () => {
                let force = false, note = null;
                if (d.fails) {
                    note = prompt(`${d.fails} check(s) failed. Closing anyway needs a reason (kept in the log):`);
                    if (!note)
                        return;
                    force = true;
                }
                else if (!confirm(`Close ${month.value}? Nobody can post or change entries dated on or before ${d.to} after this.` + (d.warns ? `\n\n${d.warns} warning(s) are still open.` : '')))
                    return;
                await act(() => POST('/api/accounts/close', { month: month.value, force, note }), month.value + ' closed');
                load();
            };
            const reopen = async () => { const reason = prompt(`Reopen ${month.value}? Write the reason (kept in the log):`); if (!reason)
                return; await act(() => POST('/api/accounts/reopen', { month: month.value, reason }), 'Reopened'); load(); };
            accFill(box, h('div', { class: 'kpis' }, kpi('Status', d.locked ? 'Closed' : 'Open', d.lock ? 'books closed up to ' + accLong(d.lock) : 'no month closed yet', d.locked ? 'good' : ''), kpi('Passed', num(d.checks.filter(c => c.status === 'pass').length), 'of ' + d.checks.length + ' checks', 'good'), kpi('To check', num(d.warns), 'warnings', d.warns ? 'warn' : ''), kpi('Failed', num(d.fails), 'must be fixed', d.fails ? 'alert' : '')), h('div', { class: 'card' }, h('h2', null, 'Checks for ' + new Date(d.from + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), h('small', null, accLong(d.from) + ' – ' + accLong(d.to))), d.checks.map(c => h('div', { class: 'acc-check' }, h('span', null, h('span', { class: 'b ' + ACC_ST[c.status][0] }, ACC_ST[c.status][1])), h('div', null, h('div', { class: 't' }, c.title), h('div', { class: 'small muted' }, c.detail)), c.fix ? h('div', { class: 'note ' + (c.status === 'fail' ? 'bad' : 'warn') + ' fix' }, c.fix) : null))), h('div', { class: 'card row sp' }, h('div', { class: 'small muted', style: { maxWidth: '560px' } }, d.locked ? 'This month is closed: entries dated in it cannot be posted, edited or voided.' : ended ? 'Closing posts the automatic entries one last time, then locks the month so nothing dated in it can change.' : 'This month has not ended yet — you can run the checks, but close it after the last day.'), h('div', { class: 'row' }, !d.locked ? postNow() : null, P && !d.locked ? h('button', { class: 'btn primary', disabled: !ended, onclick: close }, 'Close ' + month.value) : null, d.locked && d.canReopen ? h('button', { class: 'btn warn', onclick: reopen }, 'Reopen ' + month.value) : null, d.locked && !d.canReopen ? h('span', { class: 'small muted' }, 'Only the owner can reopen.') : null)), d.history.length ? h('div', { class: 'card' }, h('h2', null, 'Close history'), h('div', { class: 'timeline' }, d.history.map(e => {
                let x = {};
                try {
                    x = JSON.parse(e.detail) || {};
                }
                catch (_a) { }
                return h('div', null, h('div', { class: 't' }, dt(e.at) + ' · ' + (e.user || '')), e.action === 'accounts.close' ? `Closed ${x.month}` + (x.fails ? ` with ${x.fails} failed check(s): ${x.note || ''}` : '') : `Reopened ${x.month} — ${x.reason || ''}`);
            }))) : null);
        };
        month.addEventListener('change', load);
        accRender(head, h('div', { class: 'toolbar' }, h('span', { class: 'small muted' }, 'Month'), month, h('button', { class: 'btn ghost sm', onclick: load }, 'Run checks again'), h('span', { class: 'grow' }), accPrintBtn()), box);
        return load();
    }
    if (tab === 'auto') {
        const d = await GET('/api/accounts/auto?limit=' + (accSmall() ? 30 : 120)), c = d.cfg;
        const how = [['Sales', `When an order is ${c.recognise}: Dr ${c.courier_ar} (order total) + Dr ${c.discount} (discount) / Cr ${c.sales}. Cancelled orders are left out.`],
            ['Cost of sales', `Same orders: Dr ${c.cogs} / Cr ${c.inventory} at product cost (or a % of price when the cost is missing, flagged as estimated).`],
            ['Returns', `When PostEx returns a parcel: Dr ${c.returns} / Cr ${c.discount} / Cr ${c.courier_ar}; the pairs go back to ${c.inventory} at cost.`],
            ['PostEx charges', `Accrued the day a parcel is dispatched (and returned) — not when PostEx pays: Dr ${c.shipping} + Dr ${c.courier_tax} (tax) / Cr ${c.courier_ar}.`],
            ['COD payments', `When PostEx marks a parcel paid: Dr ${c.bank} / Cr ${c.courier_ar} (COD less charges).`],
            ['Lots bought', `Each lot with a cost: Dr ${c.purchases} / Cr ${c.payable} (party vendor:<name>); extra lot costs Cr Accrued Expenses (party lot:<name>) until paid.`],
            ['Lot received', `WMS receiving (GRN) moves the whole lot from ${c.purchases} to ${c.unlisted || 'Unlisted Inventory'}; pairs damaged beyond the lot plan go to Inventory Damage.`],
            ['Pairs listed', `Each day's newly listed pairs: Dr ${c.inventory} / Cr ${c.unlisted || 'Unlisted Inventory'} at the pair's cost. When every good pair of a lot is listed, what is left of that lot (rounding, short count) is cleared to ${c.cogs}.`]];
        accRender(head, h('div', { class: 'phead' }, h('div', null, h('h2', null, 'Automatic postings'), h('div', { class: 'muted' }, d.start ? `One entry per day per type, from ${accLong(d.start)}${d.lock ? ', after the closed period (' + accLong(d.lock) + ')' : ''}. Recalculated every hour, so late PostEx data fixes itself until the month is closed.` : '')), h('div', { class: 'row' }, postNow())), d.off ? h('div', { class: 'note warn row sp' }, h('span', null, d.off), h('a', { class: 'btn sm', href: '#/close/opening' }, 'Opening balances')) : null, d.pending.length ? h('div', { class: 'card' }, h('h2', null, 'Waiting to be posted', h('small', null, d.pending.length + ' entries')), accTable([{ t: 'Date', f: r => day(r.date) }, { t: 'Type', f: r => accSrcB(r.source) }, { t: 'What', k: 'memo' }], d.pending.slice(0, 60))) :
            d.start ? h('div', { class: 'note ok' }, 'Everything is posted.' + (d.last ? ` Last run ${d.last.at.slice(0, 16)}.` : '')) : null, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Recent automatic entries'), accTable([{ t: 'Date', f: r => h('span', { style: { whiteSpace: 'nowrap' } }, day(r.date)) }, { t: 'Type', f: r => accSrcB(r.source) },
            { t: 'Details', f: r => h('span', { class: 'small' }, r.memo) }, { t: 'Amount', n: 1, f: r => rs(r.amount) }], d.recent, r => accJournal(r.id))), h('div', { class: 'card' }, h('h2', null, 'How orders become entries'), h('dl', { class: 'dl' }, how.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'small' }, v)])), h('div', { class: 'small muted', style: { marginTop: '10px' } }, 'Change the accounts used in Settings. Courier fee, return fee and cost % estimates come from the main Settings page.'))));
        return;
    }
    if (tab === 'opening') {
        const [d, chart] = await Promise.all([GET('/api/accounts/opening'), accChart(true)]);
        const j = d.journal && !d.journal.voided ? d.journal : null;
        const defDate = j ? j.date : new Date(Date.parse(todayStr().slice(0, 7) + '-01T00:00:00Z') - 864e5).toISOString().slice(0, 10);
        const date = h('input', { type: 'date', value: defDate }), toCap = h('input', { type: 'checkbox' }), diffNote = h('span', { class: 'small muted' });
        const save = h('button', { class: 'btn primary', disabled: !P || !!(d.lock && j && j.date <= d.lock) }, j ? 'Save opening balances' : 'Save & start the books');
        const ed = accLinesEditor(chart, d.lines.length ? d.lines : accCash.map(a => ({ account: a })).concat([{ account: 'Post Ex' }, { account: 'Listed Inventory' }, { account: 'Accounts Payable', party: 'vendor:' }, { account: 'Capital' }]), { noMemo: true, onChange: diff => { diffNote.textContent = diff ? `Not balanced by ${rs(Math.abs(diff))}. Tick the box to put the difference in Capital.` : ''; } });
        const csv = h('textarea', { placeholder: 'Paste from Excel / CSV: Account, Debit, Credit, Party (optional)\nCash,50000,0\nMeezan (SB),400000,0\nAccounts Payable,0,500000,vendor:Vendor A' });
        const readCsv = () => {
            const lines = csv.value.split(/\r?\n/).map(l => l.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.replace(/^"|"$/g, '').trim())).filter(p => p[0] && !/^account$/i.test(p[0]));
            const names = new Map(chart.accounts.flatMap(a => [[a.name.toLowerCase(), a.name], [String(a.code), a.name]])), bad = [];
            const rows = lines.map(p => { const n = names.get(p[0].toLowerCase()); if (!n)
                bad.push(p[0]); return { account: n, debit: +String(p[1] || '').replace(/[^\d.-]/g, '') || 0, credit: +String(p[2] || '').replace(/[^\d.-]/g, '') || 0, party: p[3] || '' }; }).filter(r => r.account);
            if (bad.length)
                toast('Unknown accounts: ' + bad.join(', '), true);
            if (rows.length) {
                ed.clear();
                rows.forEach(ed.add);
                toast(rows.length + ' lines read');
            }
        };
        save.onclick = async () => { const r = await act(() => POST('/api/accounts/opening', { date: date.value, lines: ed.lines().map(l => (Object.assign(Object.assign({}, l), { party: l.party && /:$/.test(l.party) ? null : l.party }))), balance_to: toCap.checked ? 'Capital' : null }), 'Opening balances saved'); toast('Automatic postings start ' + r.start); route(); };
        accRender(head, h('div', { class: 'note' }, 'Enter what the business had and owed at the end of the day before the ERP takes over (from Minhaj\'s last balance sheet). Automatic postings start the next day, so older orders are not counted twice.'), d.lock && j && j.date <= d.lock ? h('div', { class: 'note warn' }, 'The opening date is inside a closed month, so it cannot be changed.') : null, h('div', { class: 'card grid' }, h('div', { class: 'row' }, field('Balances as of (end of day)', date), h('span', { class: 'small muted' }, d.start ? 'Automatic postings start ' + accLong(d.start) : 'Automatic postings will start the next day')), ed.node, h('div', { class: 'row sp' }, h('label', { class: 'row small' }, toCap, 'Put any difference in Capital'), diffNote, save)), h('div', { class: 'card grid' }, h('h2', null, 'Paste from Excel', h('small', null, 'columns: Account, Debit, Credit, Party')), csv, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: readCsv }, 'Read pasted lines'))));
        return;
    }
    // settings
    const [s, chart] = await Promise.all([GET('/api/accounts/settings'), accChart(true)]), c = s.cfg;
    const sel = (k, only) => { const e = accSelect(chart.accounts, c[k], { only }); e.dataset.k = k; return e; };
    const start = h('input', { type: 'date', value: s.start || '' }), rec = h('select', null, [['dispatched', 'On dispatch (like Minhaj)'], ['delivered', 'On delivery']].map(([v, l]) => h('option', { value: v, selected: c.recognise === v }, l)));
    const fy = h('select', null, ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => h('option', { value: i + 1, selected: +c.fy_month === i + 1 }, m)));
    const auto = h('input', { type: 'checkbox', checked: c.auto !== false });
    const cashOnly = a => a.grp === 'cash' && a.type === 'asset';
    const maps = [['bank', 'PostEx COD is paid into', cashOnly], ['courier_ar', 'PostEx receivable'], ['sales', 'Sales'], ['discount', 'Discounts given'], ['returns', 'Sales returns'], ['cogs', 'Cost of goods sold'], ['inventory', 'Stock on site (inventory)'],
        ['shipping', 'PostEx delivery charges'], ['courier_tax', 'Tax on PostEx charges'], ['purchases', 'Lots bought'], ['payable', 'Suppliers owed']].map(([k, l, o]) => field(l, sel(k, o)));
    const box = h('div', { class: 'grid' }, h('div', { class: 'card' }, h('h2', null, 'Automatic postings'), h('div', { class: 'fgrid' }, field('Start posting from', start), field('Count a sale', rec), field('Financial year starts in', fy), h('label', { class: 'row small', style: { alignSelf: 'end' } }, auto, 'Post every hour automatically')), h('div', { class: 'small muted', style: { marginTop: '10px' } }, `Estimates when PostEx data is missing: delivery charge ${rs(s.courier_fee)}, return charge ${rs(s.return_fee)}, cost ${s.cost_pct}% of price — `, can('settings') ? h('a', { href: '#/settings' }, 'change in main Settings') : 'set in main Settings', '.')), h('div', { class: 'card' }, h('h2', null, 'Which account each automatic entry uses'), h('div', { class: 'fgrid' }, maps)), P ? h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: async () => {
            const cfg = { recognise: rec.value, fy_month: +fy.value, auto: auto.checked };
            box.querySelectorAll('select[data-k]').forEach(e => cfg[e.dataset.k] = e.value);
            await act(() => POST('/api/accounts/settings', { cfg, start: start.value }), 'Saved');
        } }, 'Save settings')) : null);
    accRender(head, s.lock ? h('div', { class: 'note' }, 'Books are closed up to ' + accLong(s.lock) + '. Changes here only affect later days.') : null, box);
});
/* ---------- accounts: ledgers (general ledger, party ledgers, chart of accounts) ---------- */
function accLedgerTable(d, onRow) {
    if (accSmall())
        return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Narration'), h('th', { class: 'n' }, 'Amount'), h('th', { class: 'n' }, 'Balance'))), h('tbody', null, h('tr', { class: 'sub' }, h('td', { colspan: 3 }, 'Opening'), h('td', { class: 'n' }, accDrCr(d.opening))), d.rows.map(r => h('tr', { class: 'click', onclick: () => onRow(r) }, h('td', { style: { whiteSpace: 'nowrap' } }, day(r.date)), h('td', null, r.memo, h('div', { class: 'small muted' }, [r.ref, r.party].filter(Boolean).join(' · '))), h('td', { class: 'n' }, r.debit ? rs(r.debit) : '−' + rs(r.credit)), h('td', { class: 'n' }, rs(r.balance))))), h('tfoot', null, h('tr', null, h('td', { colspan: 3 }, 'Closing'), h('td', { class: 'n' }, accDrCr(d.closing))))));
    return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Date', 'No.', 'Narration', 'Against', 'Party', 'Debit', 'Credit', 'Balance'].map((t, i) => h('th', { class: (i >= 5 ? 'n' : '') + (i === 3 || i === 4 ? ' acc-hide-sm' : '') }, t)))), h('tbody', null, h('tr', { class: 'sub' }, h('td', { colspan: 5 }, 'Opening balance' + (d.from ? ' on ' + day(d.from) : '')), h('td'), h('td'), h('td', { class: 'n' }, accDrCr(d.opening))), d.rows.map(r => h('tr', { class: 'click', onclick: () => onRow(r) }, h('td', { style: { whiteSpace: 'nowrap' } }, day(r.date)), h('td', { class: 'mono' }, r.ref || '#' + r.journal_id), h('td', null, r.memo, r.lmemo ? h('div', { class: 'small muted' }, r.lmemo) : null), h('td', { class: 'small muted acc-hide-sm' }, r.other), h('td', { class: 'small acc-hide-sm' }, r.party || ''), h('td', { class: 'n' }, r.debit ? rs(r.debit) : ''), h('td', { class: 'n' }, r.credit ? rs(r.credit) : ''), h('td', { class: 'n' }, accDrCr(r.balance))))), h('tfoot', null, h('tr', null, h('td', { colspan: 5 }, 'Closing balance'), h('td', { class: 'n' }, rs(d.debit)), h('td', { class: 'n' }, rs(d.credit)), h('td', { class: 'n' }, accDrCr(d.closing))))));
}
registerView({ key: 'ledgers', title: 'Ledgers', group: 'Finance', perm: 'accounts', icon: 'doc', order: 50 }, async (args) => {
    const tab = ['gl', 'parties', 'chart'].includes(args[0]) ? args[0] : 'gl';
    const head = tabs([['gl', 'General ledger'], ['parties', 'Suppliers, staff & PostEx'], ['chart', 'Chart of accounts']], tab, t => { location.hash = '#/ledgers/' + t; });
    const chart = await accChart(true);
    if (tab === 'gl') {
        const t = todayStr(), sv = store.get('acc_gl', {});
        const accI = accSelect(chart.accounts, args[1] || sv.account || 'Cash'), party = h('input', { value: args[2] || '', placeholder: 'Party filter (optional)', list: 'acc-gl-parties' });
        const from = h('input', { type: 'date', value: args[3] || sv.from || t.slice(0, 7) + '-01' }), to = h('input', { type: 'date', value: args[4] || t }), box = h('div'), dl = h('datalist', { id: 'acc-gl-parties' });
        const load = async () => {
            store.set('acc_gl', { account: accI.value, from: from.value });
            const d = await GET('/api/accounts/ledger?' + qs({ account: accI.value, party: party.value.trim(), from: from.value, to: to.value }));
            const ps = await GET('/api/accounts/parties?' + qs({ account: accI.value }));
            accFill(dl, ...[...new Set(ps.map(p => p.party))].map(p => h('option', { value: p })));
            accFill(box, h('div', { class: 'card statement', style: { maxWidth: 'none' } }, h('h2', null, d.account.code + ' · ' + d.account.name, d.party ? h('span', { class: 'b info' }, d.party) : null, h('small', null, `${day(d.from)} – ${day(d.to)} ${String(d.to).slice(0, 4)}`), h('span', { class: 'spacer' }), h('span', { class: 'b' }, ACC_TYPES[d.account.type])), d.rows.length >= 5000 ? h('div', { class: 'note warn' }, 'Showing the first 5,000 lines — narrow the dates.') : null, accLedgerTable(d, r => accJournal(r.journal_id, load))));
            box._d = d;
        };
        [accI, from, to].forEach(e => e.addEventListener('change', load));
        party.addEventListener('change', load);
        accRender(head, h('div', { class: 'toolbar acc-noprint' }, accI, party, dl, h('span', { class: 'small muted' }, 'from'), from, h('span', { class: 'small muted' }, 'to'), to, h('span', { class: 'grow' }), accPrintBtn(), h('button', { class: 'btn ghost sm', onclick: () => { const d = box._d; csvDownload(`ledger-${d.account.name}.csv`, [{ date: d.from, ref: '', memo: 'Opening balance', party: '', debit: '', credit: '', balance: d.opening }].concat(d.rows.map(r => ({ date: r.date, ref: r.ref || r.journal_id, memo: r.memo, party: r.party || '', debit: r.debit, credit: r.credit, balance: r.balance })))); } }, 'CSV')), box);
        return load();
    }
    if (tab === 'parties') {
        const kinds = { vendor: ['vendor:', 'Accounts Payable', 'Suppliers', 'What we owe each supplier (credit = we owe).'], employee: ['employee:', '', 'Staff', 'Advances given to staff and salaries payable, per employee.'],
            courier: ['courier:', '', 'PostEx', 'COD PostEx holds for us, after its charges (debit = PostEx owes us).'], customer: ['customer:', '', 'Customers', 'Customer advances and store credit.'], all: ['', '', 'All parties', 'Every party sub-ledger.'] };
        const k = kinds[args[1]] ? args[1] : 'vendor', [prefix, account, , help] = kinds[k];
        const rows = await GET('/api/accounts/parties?' + qs({ prefix, account }));
        const total = rows.reduce((s, r) => s + r.balance, 0);
        const empMap = {}; // employee ids → names when HR is available
        try {
            if (k === 'employee' || k === 'all') {
                const e = await GET('/api/hr/employees');
                (e.rows || e || []).forEach(x => empMap['employee:' + x.id] = x.name);
            }
        }
        catch (_a) { }
        accRender(head, tabs(Object.entries(kinds).map(([kk, v]) => [kk, v[2]]), k, v => { location.hash = '#/ledgers/parties/' + v; }), h('div', { class: 'card' }, h('h2', null, kinds[k][2], h('small', null, help), h('span', { class: 'spacer' }), h('span', { class: 'b' }, 'Net ' + accDrCr(total)), h('button', { class: 'btn ghost sm acc-noprint', onclick: () => csvDownload(`parties-${k}.csv`, rows.map(r => ({ party: r.party, account: r.account, debit: r.dr, credit: r.cr, balance: r.balance, last: r.last }))) }, 'CSV')), accTable([{ t: 'Party', f: r => [h('div', null, r.name || empMap[r.party] || r.party.replace(/^\w+:/, '')), h('div', { class: 'small muted mono' }, r.party)] }, { t: 'Account', k: 'account' },
            { t: 'Debit', n: 1, cls: 'acc-hide-sm', f: r => rs(r.dr) }, { t: 'Credit', n: 1, cls: 'acc-hide-sm', f: r => rs(r.cr) }, { t: 'Balance', n: 1, f: r => h('strong', null, accDrCr(r.balance)) }, { t: 'Last entry', cls: 'acc-hide-sm', f: r => day(r.last) }], rows, r => { location.hash = '#/ledgers/gl/' + encodeURIComponent(r.account) + '/' + encodeURIComponent(r.party) + '/2000-01-01'; })));
        return;
    }
    // chart of accounts
    const P = can('accounts_post');
    const edit = a => {
        const t = a ? a.type : 'expense', groups = g => (chart.groups[g] || []).map(([v, l]) => [v, l]);
        const fields = [{ k: 'name', label: 'Name', value: a ? a.name : '', required: true }, { k: 'code', label: 'Code', value: a ? a.code : '', placeholder: 'e.g. 7190' }];
        if (!a)
            fields.push({ k: 'tg', label: 'Type & group', type: 'select', options: Object.entries(chart.groups).flatMap(([ty, gs]) => gs.map(([g, l]) => [ty + '|' + g, (ACC_TYPES[ty] || ty) + ' — ' + l])), value: 'expense|admin' });
        else
            fields.push({ k: 'grp', label: 'Group', type: 'select', options: groups(a.type), value: a.grp });
        if (a)
            fields.push({ k: 'active', label: 'Active (can be posted to)', type: 'checkbox', value: !!a.active });
        fields.push({ k: 'note', label: 'Note', value: a ? a.note || '' : '', full: true });
        const m = formModal(a ? 'Edit account' : 'New account', fields, async (v) => { if (v.tg) {
            [v.type, v.grp] = v.tg.split('|');
            delete v.tg;
        } await POST('/api/accounts/chart', Object.assign({ id: a ? a.id : undefined }, v)); toast('Saved'); ACC.chart = null; route(); });
        if (a && a.system)
            m.querySelector('.fgrid').prepend(h('div', { class: 'note full' }, 'Built-in account: other screens post to it by name, so it cannot be renamed or deactivated.'));
        if (a && !a.system && !a.used)
            m.querySelector('.in > .row:last-child').prepend(h('button', { class: 'btn bad', onclick: async () => { if (!confirm('Delete ' + a.name + '?'))
                    return; await act(() => api('DELETE', '/api/accounts/chart/' + a.id), 'Deleted'); m.remove(); ACC.chart = null; route(); } }, 'Delete'));
    };
    const show = h('select', null, [['active', 'Active accounts'], ['used', 'With entries'], ['all', 'All, incl. inactive']].map(([v, l]) => h('option', { value: v }, l))), box = h('div');
    const draw = () => {
        const xs = chart.accounts.filter(a => show.value === 'all' || (show.value === 'used' ? a.used : a.active));
        accFill(box, ...Object.entries(ACC_TYPES).map(([t, l]) => {
            const list = xs.filter(a => a.type === t);
            return list.length ? h('div', { class: 'card' }, h('h2', null, l, h('small', null, list.length + ' accounts')), accTable([{ t: 'Code', cls: 'acc-hide-sm', f: a => h('span', { class: 'mono' }, a.code) }, { t: 'Account', f: a => [accSmall() ? h('span', { class: 'mono small muted' }, a.code + ' ') : null, a.name, a.active ? null : h('span', { class: 'b', style: { marginLeft: '6px' } }, 'inactive'), a.note ? h('div', { class: 'small muted' }, a.note) : null] },
                { t: 'Group', cls: 'acc-hide-sm', f: a => h('span', { class: 'small muted' }, ((chart.groups[a.type] || []).find(g => g[0] === a.grp) || [, a.grp])[1]) }, { t: 'Balance', n: 1, f: a => accDrCr(a.bal) },
                { t: '', f: a => h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } }, h('a', { class: 'btn ghost sm', href: '#/ledgers/gl/' + encodeURIComponent(a.name) }, 'Ledger'), P && !accSmall() ? h('button', { class: 'btn ghost sm', onclick: () => edit(a) }, 'Edit') : null) }], list, P && accSmall() ? edit : null)) : null;
        }));
    };
    show.addEventListener('change', draw);
    accRender(head, h('div', { class: 'toolbar' }, show, h('span', { class: 'small muted grow acc-hide-sm' }, 'Balances as of today. Debit balance = Dr, credit balance = Cr.'), h('span', { class: 'grow' }), P ? h('button', { class: 'btn primary sm', onclick: () => edit(null) }, '+ Add account') : null, h('button', { class: 'btn ghost sm', onclick: () => csvDownload('chart-of-accounts.csv', chart.accounts.map(a => ({ code: a.code, name: a.name, type: a.type, statement: a.statement, group: a.grp, active: a.active, balance: a.bal }))) }, 'CSV')), box);
    draw();
});
/* ---------- accounts: statements (P&L, balance sheet, trial balance, cash & bank book, sales register) ---------- */
const accGl = (name, from, to) => '#/ledgers/gl/' + encodeURIComponent(name) + '//' + (from || '') + '/' + (to || '');
const accLong = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
function accPnlTable(c, p) {
    const ns = c.netSales, pns = p.netSales, pc = (v, base) => base ? (100 * v / base).toFixed(1) + '%' : '–';
    const prevMap = {};
    for (const k of ['sales', 'less', 'cogs', 'selling', 'admin', 'other', 'tax'])
        for (const r of p[k].rows)
            prevMap[r.name] = r.amount;
    const names = k => [...new Set(c[k].rows.map(r => r.name).concat(p[k].rows.map(r => r.name)))];
    const cur = k => Object.fromEntries(c[k].rows.map(r => [r.name, r.amount]));
    const cells = (v, pv, cls) => [h('td', { class: cls }, rs(v)), h('td', { class: 'acc-pctl' }, pc(v, ns)), h('td', { class: 'acc-hide-sm ' + (cls || '') }, rs(pv)), h('td', { class: 'acc-pctl acc-hide-sm' }, pc(pv, pns))];
    // deductions (returns, costs, expenses, tax) are shown as positive amounts under their heading
    const sec = (k, title) => {
        const cm = cur(k), ns_ = names(k), sg = ['sales', 'other'].includes(k) ? 1 : -1;
        return ns_.length ? [h('tr', { class: 'h' }, h('td', { colspan: 5 }, title)),
            ns_.map(n => h('tr', null, h('td', { class: 'ind' }, h('a', { href: accGl(n, c.from, c.to) }, n)), cells(sg * (cm[n] || 0), sg * (prevMap[n] || 0))))] : [];
    };
    const tot = (l, v, pv, cls = 't') => h('tr', { class: cls }, h('td', null, l), cells(v, pv, v < 0 ? 'neg' : ''));
    return h('div', { class: 'scroll' }, h('table', { class: 'tbl acc-pl' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'n' }, 'This period'), h('th', { class: 'n' }, '% of sales'), h('th', { class: 'n acc-hide-sm' }, 'Previous'), h('th', { class: 'n acc-hide-sm' }, '%'))), h('tbody', null, sec('sales', 'Sales'), sec('less', 'Less: returns & discounts'), tot('Net sales', ns, pns), sec('cogs', 'Cost of sales'), tot('Gross profit', c.gross, p.gross), sec('selling', 'Selling & delivery'), sec('admin', 'Admin & general'), tot('Total operating expenses', c.opex, p.opex), tot('Operating profit', c.operating, p.operating), sec('other', 'Other income'), tot('Profit before tax', c.beforeTax, p.beforeTax), sec('tax', 'Tax'), tot('Net profit', c.net, p.net, 'gt'))));
}
registerView({ key: 'statements', title: 'Statements', group: 'Finance', perm: 'accounts', icon: 'bank', order: 60 }, async (args) => {
    const tab = ['pnl', 'bs', 'tb', 'cash', 'sales'].includes(args[0]) ? args[0] : 'pnl', t = todayStr();
    const head = h('div', { class: 'acc-noprint' }, tabs([['pnl', 'Profit & loss'], ['bs', 'Balance sheet'], ['tb', 'Trial balance'], ['cash', 'Cash & bank book'], ['sales', 'Sales register']], tab, k => { location.hash = '#/statements/' + k; }));
    const box = h('div', { class: 'grid' });
    const bar = (...kids) => h('div', { class: 'toolbar acc-noprint' }, ...kids, h('span', { class: 'grow' }), accPrintBtn());
    const title = (main, sub) => h('div', { style: { textAlign: 'center', marginBottom: '6px' } }, h('div', { style: { fontWeight: 800, fontSize: '17px' } }, (META.store || 'SundayBazar') + ' — ' + main), h('div', { class: 'muted small' }, sub));
    if (tab === 'pnl') {
        const mode = h('select', null, [['month', 'Month'], ['range', 'Date range']].map(([v, l]) => h('option', { value: v }, l)));
        const month = h('input', { type: 'month', value: /^\d{4}-\d{2}$/.test(args[1] || '') ? args[1] : t.slice(0, 7) }), from = h('input', { type: 'date', value: t.slice(0, 7) + '-01', hidden: true }), to = h('input', { type: 'date', value: t, hidden: true });
        let last;
        const load = async () => {
            const r = mode.value === 'month';
            [month].forEach(e => e.hidden = !r);
            [from, to].forEach(e => e.hidden = r);
            const d = last = await GET('/api/accounts/pnl?' + (r ? 'month=' + month.value : qs({ from: from.value, to: to.value }))), c = d.cur;
            accFill(box, h('div', { class: 'kpis' }, kpi('Net sales', rs(c.netSales), 'previous ' + rs(d.prev.netSales)), kpi('Gross profit', rs(c.gross), pct(c.gross, c.netSales) + ' of sales', c.gross < 0 ? 'alert' : ''), kpi('Operating expenses', rs(c.opex), pct(c.opex, c.netSales) + ' of sales'), kpi('Net profit', rs(c.net), pct(c.net, c.netSales) + ' of sales · previous ' + rs(d.prev.net), c.net < 0 ? 'alert' : 'good')), h('div', { class: 'card statement' }, title('Profit & loss', `${accLong(c.from)} – ${accLong(c.to)} · compared with ${accLong(d.prev.from)} – ${accLong(d.prev.to)}`), accPnlTable(c, d.prev), !c.netSales && !c.net ? h('div', { class: 'empty' }, 'No entries in this period yet.') : null));
        };
        [mode, month, from, to].forEach(e => e.addEventListener('change', load));
        const csv = () => {
            const c = last.cur, rows = [];
            for (const k of ['sales', 'less', 'cogs', 'selling', 'admin', 'other', 'tax'])
                for (const r of c[k].rows)
                    rows.push({ section: c[k].title, account: r.name, amount: r.amount, pct_of_sales: c.netSales ? +(100 * r.amount / c.netSales).toFixed(2) : '' });
            for (const [l, v] of [['Net sales', c.netSales], ['Gross profit', c.gross], ['Operating profit', c.operating], ['Profit before tax', c.beforeTax], ['Net profit', c.net]])
                rows.push({ section: 'Total', account: l, amount: v, pct_of_sales: c.netSales ? +(100 * v / c.netSales).toFixed(2) : '' });
            csvDownload(`pnl-${c.from}-${c.to}.csv`, rows);
        };
        accRender(head, bar(mode, month, from, to, h('button', { class: 'btn ghost sm', onclick: csv }, 'CSV')), box);
        return load();
    }
    if (tab === 'bs') {
        const date = h('input', { type: 'date', value: isFinite(Date.parse(args[1])) ? args[1] : t });
        let last;
        const load = async () => {
            const d = last = await GET('/api/accounts/bs?date=' + date.value);
            const rowsOf = (secs, sign = 1) => secs.map(s => [h('tr', { class: 'h' }, h('td', { colspan: 2 }, s.title)), s.rows.map(r => h('tr', null, h('td', { class: 'ind' }, h('a', { href: accGl(r.name, '2000-01-01', d.date) }, r.name)), h('td', { class: 'n' + (r.amount < 0 ? ' neg' : '') }, rs(sign * r.amount)))),
                h('tr', { class: 't' }, h('td', null, 'Total ' + s.title.toLowerCase()), h('td', { class: 'n' }, rs(s.total)))]);
            accFill(box, d.diff ? h('div', { class: 'flash bad' }, `Out of balance by ${rs(d.diff)} — assets do not equal liabilities + equity. Check the trial balance and the opening balances.`) : null, h('div', { class: 'card statement' }, title('Balance sheet', 'as of ' + accLong(d.date)), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', null, h('tr', { class: 'h' }, h('td', { colspan: 2, style: { color: 'var(--ink)' } }, 'ASSETS')), rowsOf(d.assets), h('tr', { class: 'gt' }, h('td', null, 'Total assets'), h('td', { class: 'n' }, rs(d.totalAssets))), h('tr', { class: 'h' }, h('td', { colspan: 2, style: { color: 'var(--ink)', paddingTop: '26px' } }, 'LIABILITIES & EQUITY')), rowsOf(d.liabilities), h('tr', { class: 't' }, h('td', null, 'Total liabilities'), h('td', { class: 'n' }, rs(d.totalLiabilities))), h('tr', { class: 'h' }, h('td', { colspan: 2 }, 'Equity')), d.equity.flatMap(s => s.rows).map(r => h('tr', null, h('td', { class: 'ind' }, h('a', { href: accGl(r.name, '2000-01-01', d.date) }, r.name)), h('td', { class: 'n' + (r.amount < 0 ? ' neg' : '') }, rs(r.amount)))), h('tr', null, h('td', { class: 'ind' }, 'Retained profit (before ' + accLong(d.fyStart) + ')'), h('td', { class: 'n' + (d.retained < 0 ? ' neg' : '') }, rs(d.retained))), h('tr', null, h('td', { class: 'ind' }, h('a', { href: '#/statements/pnl' }, 'Profit this financial year'), h('div', { class: 'small muted' }, 'from ' + accLong(d.fyStart))), h('td', { class: 'n' + (d.currentProfit < 0 ? ' neg' : '') }, rs(d.currentProfit))), h('tr', { class: 't' }, h('td', null, 'Total equity'), h('td', { class: 'n' }, rs(d.totalEquity))), h('tr', { class: 'gt' }, h('td', null, 'Total liabilities & equity'), h('td', { class: 'n' }, rs(d.totalLiabilities + d.totalEquity)))))), !d.diff ? h('div', { class: 'note ok', style: { marginTop: '10px' } }, 'Balanced: assets = liabilities + equity.') : null));
        };
        date.addEventListener('change', load);
        const csv = () => {
            const d = last, rows = [];
            for (const [part, secs] of [['Assets', d.assets], ['Liabilities', d.liabilities], ['Equity', d.equity]])
                for (const s of secs)
                    for (const r of s.rows)
                        rows.push({ part, group: s.title, account: r.name, amount: r.amount });
            rows.push({ part: 'Equity', group: 'Profit', account: 'Retained profit', amount: d.retained }, { part: 'Equity', group: 'Profit', account: 'Profit this financial year', amount: d.currentProfit });
            csvDownload('balance-sheet-' + d.date + '.csv', rows);
        };
        accRender(head, bar(h('span', { class: 'small muted' }, 'As of'), date, h('button', { class: 'btn ghost sm', onclick: csv }, 'CSV')), box);
        return load();
    }
    if (tab === 'tb') {
        const date = h('input', { type: 'date', value: t });
        let last;
        const load = async () => {
            const d = last = await GET('/api/accounts/trial?date=' + date.value);
            accFill(box, h('div', { class: 'flash ' + (d.diff ? 'bad' : 'ok') + ' acc-noprint' }, d.diff ? `Not balanced — difference ${rs(d.diff)}` : `Balanced: debits ${rs(d.debit)} = credits ${rs(d.credit)}`), h('div', { class: 'card statement' }, title('Trial balance', 'as of ' + accLong(d.date)), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Account'), h('th', { class: 'n' }, 'Debit'), h('th', { class: 'n' }, 'Credit'))), h('tbody', null, d.rows.map(r => h('tr', { class: 'click', onclick: () => { location.hash = accGl(r.name, '2000-01-01', d.date); } }, h('td', { class: 'mono' }, r.code), h('td', null, r.name), h('td', { class: 'n' }, r.debit ? rs(r.debit) : ''), h('td', { class: 'n' }, r.credit ? rs(r.credit) : '')))), h('tfoot', null, h('tr', { class: 'gt' }, h('td'), h('td', null, 'Total'), h('td', { class: 'n' }, rs(d.debit)), h('td', { class: 'n' }, rs(d.credit))))))));
        };
        date.addEventListener('change', load);
        accRender(head, bar(h('span', { class: 'small muted' }, 'As of'), date, h('button', { class: 'btn ghost sm', onclick: () => csvDownload('trial-balance-' + last.date + '.csv', last.rows.map(r => ({ code: r.code, account: r.name, debit: r.debit, credit: r.credit }))) }, 'CSV')), box);
        return load();
    }
    if (tab === 'cash') {
        const chart = await accChart(), cashAccs = chart.accounts.filter(a => a.grp === 'cash' && a.type === 'asset');
        const acc = h('select', null, cashAccs.map(a => h('option', { value: a.name, selected: a.name === (args[1] || 'Cash') }, a.name)));
        const from = h('input', { type: 'date', value: t.slice(0, 7) + '-01' }), to = h('input', { type: 'date', value: t }), detail = h('input', { type: 'checkbox' });
        let last;
        const load = async () => {
            const d = last = await GET('/api/accounts/ledger?' + qs({ account: acc.value, from: from.value, to: to.value }));
            const days = [];
            let run = d.opening;
            for (const r of d.rows) {
                let x = days[days.length - 1];
                if (!x || x.date !== r.date)
                    days.push(x = { date: r.date, in: 0, out: 0, rows: [] });
                x.in += r.debit;
                x.out += r.credit;
                x.rows.push(r);
                run = r.balance;
                x.close = run;
            }
            accFill(box, h('div', { class: 'kpis acc-noprint' }, cashAccs.map(a => kpi(a.name, rs(a.bal), 'today', a.bal < 0 ? 'alert' : '', '#/statements/cash/' + encodeURIComponent(a.name)))), h('div', { class: 'card statement', style: { maxWidth: '980px' } }, title((acc.value.match(/cash/i) ? 'Cash book' : 'Bank book') + ' — ' + acc.value, `${accLong(d.from)} – ${accLong(d.to)}`), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, detail.checked ? 'Narration' : 'Entries'), h('th', { class: 'n' }, 'Money in'), h('th', { class: 'n' }, 'Money out'), h('th', { class: 'n' }, 'Balance'))), h('tbody', null, h('tr', { class: 'sub' }, h('td', { colspan: 4 }, 'Opening balance'), h('td', { class: 'n' }, rs(d.opening))), days.map(x => detail.checked ? [x.rows.map(r => h('tr', { class: 'click', onclick: () => accJournal(r.journal_id, load) }, h('td', null, day(r.date)), h('td', null, h('span', { class: 'mono small' }, (r.ref || '') + ' '), r.memo, h('div', { class: 'small muted' }, r.other)), h('td', { class: 'n' }, r.debit ? rs(r.debit) : ''), h('td', { class: 'n' }, r.credit ? rs(r.credit) : ''), h('td', { class: 'n' }, rs(r.balance)))), h('tr', { class: 'sub' }, h('td', { colspan: 2 }, 'Closing ' + day(x.date)), h('td', { class: 'n' }, rs(x.in)), h('td', { class: 'n' }, rs(x.out)), h('td', { class: 'n' }, rs(x.close)))]
                : h('tr', null, h('td', null, day(x.date)), h('td', { class: 'small muted' }, x.rows.length + (x.rows.length > 1 ? ' entries' : ' entry')), h('td', { class: 'n' }, x.in ? rs(x.in) : ''), h('td', { class: 'n' }, x.out ? rs(x.out) : ''), h('td', { class: 'n' + (x.close < 0 ? ' neg' : '') }, rs(x.close))))), h('tfoot', null, h('tr', null, h('td', { colspan: 2 }, 'Closing balance'), h('td', { class: 'n' }, rs(d.debit)), h('td', { class: 'n' }, rs(d.credit)), h('td', { class: 'n' }, rs(d.closing)))))), !d.rows.length ? h('div', { class: 'empty' }, 'No money in or out in these dates.') : null));
        };
        [acc, from, to, detail].forEach(e => e.addEventListener('change', load));
        accRender(head, bar(acc, h('span', { class: 'small muted' }, 'from'), from, h('span', { class: 'small muted' }, 'to'), to, h('label', { class: 'row small' }, detail, 'Show every entry'), h('button', { class: 'btn ghost sm', onclick: () => csvDownload(`${last.account.name}-book.csv`, last.rows.map(r => ({ date: r.date, ref: r.ref, memo: r.memo, against: r.other, in: r.debit, out: r.credit, balance: r.balance }))) }, 'CSV')), box);
        return load();
    }
    // sales register
    const from = h('input', { type: 'date', value: t.slice(0, 7) + '-01' }), to = h('input', { type: 'date', value: t });
    let last;
    const load = async () => {
        const d = last = await GET('/api/accounts/sales-register?' + qs({ from: from.value, to: to.value })), T = d.total;
        accFill(box, h('div', { class: 'kpis' }, kpi('Orders ' + d.basis, num(T.orders || 0)), kpi('Gross sales', rs(T.gross)), kpi('Returns', rs(T.returns), num(T.returned || 0) + ' parcels', T.returns ? 'warn' : ''), kpi('Net sales', rs(T.net), pct(T.returns, T.gross) + ' returned by value')), h('div', { class: 'card statement', style: { maxWidth: '980px' } }, title('Sales register', `${accLong(d.from)} – ${accLong(d.to)} · sales counted when orders are ${d.basis}`), accTable([{ t: 'Date', f: r => day(r.date) }, { t: 'Orders', n: 1, f: r => num(r.orders) }, { t: 'Returned', n: 1, cls: 'acc-hide-sm', f: r => num(r.returned) }, { t: 'Gross sales', n: 1, f: r => rs(r.gross) },
            { t: 'Discounts', n: 1, cls: 'acc-hide-sm', f: r => r.discount ? rs(r.discount) : '–' }, { t: 'Returns', n: 1, f: r => r.returns ? rs(r.returns) : '–' }, { t: 'Net sales', n: 1, f: r => h('strong', null, rs(r.net)) }], d.rows), d.rows.length ? h('div', { class: 'row sp', style: { marginTop: '10px', fontWeight: 700 } }, h('span', null, 'Total'), h('span', null, `${num(T.orders)} orders · gross ${rs(T.gross)} · discounts ${rs(T.discount)} · returns ${rs(T.returns)} · net ${rs(T.net)}`)) : null));
    };
    [from, to].forEach(e => e.addEventListener('change', load));
    accRender(head, bar(h('span', { class: 'small muted' }, 'from'), from, h('span', { class: 'small muted' }, 'to'), to, h('button', { class: 'btn ghost sm', onclick: () => csvDownload('sales-register.csv', last.rows) }, 'CSV')), box);
    return load();
});
/* ---------- accounts: vouchers (journal list, JV editor, quick payment/receipt/contra/owner forms) ---------- */
const ACC_KINDS = [['', 'All entries'], ['manual', 'Manual vouchers'], ['JV', 'Journal (JV)'], ['PV', 'Payments (PV)'], ['RV', 'Receipts (RV)'], ['CV', 'Contra (CV)'], ['auto', 'Automatic'], ['opening', 'Opening'], ['other', 'From other screens']];
// multi-line voucher editor (also used for opening balances)
function accLinesEditor(chart, lines, opts = {}) {
    const box = h('div', { class: 'acc-lines' }), tot = h('div', { class: 'acc-tot' });
    const rows = [];
    const recalc = () => {
        const dr = rows.reduce((s, r) => s + (+r.dr.value || 0), 0), cr = rows.reduce((s, r) => s + (+r.cr.value || 0), 0), diff = Math.round((dr - cr) * 100) / 100;
        accFill(tot, h('span', null, 'Debit ', rs(dr)), h('span', null, 'Credit ', rs(cr)), h('span', { class: 'b ' + (diff ? 'bad' : dr ? 'ok' : '') }, diff ? `Difference ${rs(Math.abs(diff))} (${diff > 0 ? 'more debit' : 'more credit'})` : dr ? 'Balanced' : 'Enter amounts'));
        opts.onChange && opts.onChange(diff, dr);
    };
    const add = (l = {}) => {
        const r = { acc: accSelect(chart.accounts, l.account || '', { blank: 'Choose account…' }), party: h('input', { value: l.party || '', placeholder: 'Party (optional)', list: 'acc-parties' }),
            dr: h('input', { type: 'number', step: 'any', min: 0, value: l.debit || '', placeholder: 'Debit', class: 'n' }), cr: h('input', { type: 'number', step: 'any', min: 0, value: l.credit || '', placeholder: 'Credit', class: 'n' }),
            memo: h('input', { value: l.memo || '', placeholder: 'Line note', class: 'acc-memo' }) };
        r.dr.addEventListener('input', () => { if (+r.dr.value)
            r.cr.value = ''; recalc(); });
        r.cr.addEventListener('input', () => { if (+r.cr.value)
            r.dr.value = ''; recalc(); });
        [[r.acc, 'a'], [r.party, 'p'], [r.dr, 'd'], [r.cr, 'c'], [r.memo, 'm']].forEach(([e, k]) => e.classList.add('acc-' + k));
        r.el = h('div', { class: 'acc-line' }, r.acc, r.party, r.dr, r.cr, opts.noMemo ? h('span', { class: 'acc-m' }) : r.memo, h('button', { class: 'btn ghost sm acc-x', title: 'Remove line', onclick: () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); recalc(); } }, '×'));
        rows.push(r);
        box.append(r.el);
        recalc();
        return r;
    };
    (lines && lines.length ? lines : [{}, {}]).forEach(add);
    const dl = h('datalist', { id: 'acc-parties' }, (opts.parties || []).map(p => h('option', { value: p })));
    const node = h('div', { class: 'grid' }, h('div', { class: 'acc-line hd' }, h('span', null, 'Account'), h('span', null, 'Party'), h('span', { style: { textAlign: 'right' } }, 'Debit'), h('span', { style: { textAlign: 'right' } }, 'Credit'), h('span', null, opts.noMemo ? '' : 'Note'), h('span')), box, dl, h('div', { class: 'row sp' }, h('button', { class: 'btn ghost sm', onclick: () => add().acc.focus() }, '+ Add line'), tot));
    return { node, add, rows, clear: () => { rows.splice(0).forEach(r => r.el.remove()); recalc(); },
        lines: () => rows.map(r => ({ account: r.acc.value, party: r.party.value.trim() || null, debit: +r.dr.value || 0, credit: +r.cr.value || 0, memo: r.memo.value.trim() || null })).filter(l => l.debit || l.credit) };
}
async function accPartyList() { try {
    return [...new Set((await GET('/api/accounts/parties')).map(p => p.party))].concat(['courier:PostEx']);
}
catch (_a) {
    return [];
} }
async function accVoucherPage(args) {
    const chart = await accChart(true), parties = await accPartyList();
    let j = null;
    if (args[0] === 'edit' && args[1])
        j = await GET('/api/accounts/journals/' + args[1]);
    const kind = j ? j.kind : (['JV', 'PV', 'RV', 'CV'].includes(args[1]) ? args[1] : 'JV');
    const date = h('input', { type: 'date', value: j ? j.date : todayStr() }), memo = h('input', { value: j ? j.memo : '', placeholder: 'What is this for? e.g. Outlet rent October, paid by cheque 1234', class: 'grow', style: { minWidth: '240px' } });
    const kindSel = h('select', { disabled: !!j }, Object.entries({ JV: 'Journal voucher (JV)', PV: 'Payment voucher (PV)', RV: 'Receipt voucher (RV)', CV: 'Contra voucher (CV)' }).map(([k, l]) => h('option', { value: k, selected: k === kind }, l)));
    const file = h('input', { type: 'file', accept: 'image/*,application/pdf' });
    const save = h('button', { class: 'btn primary', disabled: true }, j ? 'Save changes' : 'Post voucher');
    const ed = accLinesEditor(chart, j ? j.lines.map(l => ({ account: l.account, party: l.party, debit: l.debit, credit: l.credit, memo: l.memo })) : null, { parties, onChange: (diff, dr) => { save.disabled = !!diff || !dr; } });
    save.onclick = async () => {
        const fid = file.files[0] ? await act(() => uploadFile(file.files[0])) : (j ? j.file_id : null);
        const r = await act(() => POST('/api/accounts/vouchers', { id: j ? j.id : undefined, kind: kindSel.value, date: date.value, memo: memo.value, file_id: fid, lines: ed.lines() }), j ? 'Saved' : 'Posted');
        ACC.chart = null;
        location.hash = '#/vouchers';
        setTimeout(() => accJournal(r.id), 300);
    };
    accRender(pageHead(j ? 'Edit ' + j.ref : 'New voucher', j ? 'Saving replaces the old lines; the change is logged.' : 'Debits must equal credits. Use the quick forms for simple payments and receipts.', h('a', { class: 'btn ghost', href: '#/vouchers' }, 'Cancel')), h('div', { class: 'card grid' }, h('div', { class: 'row' }, field('Type', kindSel), field('Date', date), h('label', { class: 'f grow' }, 'Narration *', memo)), ed.node, h('div', { class: 'row sp' }, h('label', { class: 'f' }, 'Attach receipt (photo or PDF)', file), j && j.file_id ? fileLink(j.file_id) : null, save)), h('div', { class: 'note' }, 'Tips: money paid out → credit Cash/bank. Money in → debit Cash/bank. Supplier bills → credit Accounts Payable with party "vendor:Name". Advance from a customer → credit Customer Advances, not Sales.'));
    if (!j)
        ed.rows[0].acc.focus();
}
// quick forms build the two lines for you
async function accQuick(type) {
    const chart = await accChart(), names = chart.accounts.filter(a => a.active), cashBank = names.filter(a => a.grp === 'cash' && a.type === 'asset').map(a => a.name);
    const all = names.map(a => [a.name, a.name + ' (' + (ACC_TYPES[a.type] || a.type) + ')']);
    const exp = names.filter(a => ['expense', 'liability', 'asset'].includes(a.type) && a.grp !== 'cash').map(a => [a.name, a.name]);
    const base = [{ k: 'date', label: 'Date', type: 'date', value: todayStr(), required: true }];
    const done = r => { ACC.chart = null; toast(r.ref + ' posted'); route(); };
    const send = (kind, memo, lines, v) => POST('/api/accounts/vouchers', { kind, date: v.date, memo, file_id: v.file || null, lines, form: Object.assign({ type }, v) }).then(done);
    if (type === 'PV')
        return formModal('Payment — money going out', base.concat([{ k: 'from', label: 'Paid from', type: 'select', options: cashBank, value: 'Meezan (SB)' },
            { k: 'to', label: 'Paid for (account)', type: 'select', options: exp, value: 'Accounts Payable' }, { k: 'party', label: 'Paid to (party)', placeholder: 'vendor:Vendor A · employee:12' },
            { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'memo', label: 'Narration', full: true, required: true, placeholder: 'e.g. Lot payment to Vendor A' }, { k: 'file', label: 'Receipt', type: 'file' }]), v => send('PV', v.memo, [{ account: v.to, debit: v.amount, party: v.party || null }, { account: v.from, credit: v.amount }], v), 'Post payment');
    if (type === 'RV')
        return formModal('Receipt — money coming in', base.concat([{ k: 'to', label: 'Received into', type: 'select', options: cashBank, value: 'Meezan (SB)' },
            { k: 'from', label: 'Received for (account)', type: 'select', options: all, value: 'Customer Advances' }, { k: 'party', label: 'Received from (party)', placeholder: 'customer:03001234567 · courier:PostEx' },
            { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'memo', label: 'Narration', full: true, required: true, placeholder: 'e.g. Advance for order SB84561' }, { k: 'file', label: 'Receipt', type: 'file' }]), v => send('RV', v.memo, [{ account: v.to, debit: v.amount }, { account: v.from, credit: v.amount, party: v.party || null }], v), 'Post receipt');
    if (type === 'CV')
        return formModal('Contra — move money between cash and bank', base.concat([{ k: 'from', label: 'From', type: 'select', options: cashBank, value: 'Cash' }, { k: 'to', label: 'To', type: 'select', options: cashBank, value: 'Meezan (SB)' },
            { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'memo', label: 'Narration', full: true, required: true, placeholder: 'e.g. Cash deposited in Meezan' }, { k: 'file', label: 'Deposit slip', type: 'file' }]), v => { if (v.from === v.to)
            throw new Error('From and To must be different'); return send('CV', v.memo, [{ account: v.to, debit: v.amount }, { account: v.from, credit: v.amount }], v); }, 'Post transfer');
    return formModal('Owner — drawing or capital', base.concat([{ k: 'dir', label: 'What happened', type: 'select', options: [['out', 'Owner took money out (drawing)'], ['in', 'Owner put money in (capital)']] },
        { k: 'acc', label: 'Owner account', type: 'select', options: names.filter(a => a.type === 'equity').map(a => a.name), value: 'Drawings 1' }, { k: 'cash', label: 'Cash / bank', type: 'select', options: cashBank, value: 'Meezan (SB)' },
        { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'memo', label: 'Narration', full: true, required: true, placeholder: 'e.g. Owner personal expense' }]), v => v.dir === 'out' ? send('PV', v.memo, [{ account: v.acc, debit: v.amount }, { account: v.cash, credit: v.amount }], v) : send('RV', v.memo, [{ account: v.cash, debit: v.amount }, { account: v.acc, credit: v.amount }], v), 'Post');
}
registerView({ key: 'vouchers', title: 'Vouchers', group: 'Finance', perm: 'accounts', icon: 'receipt', order: 40 }, async (args) => {
    if ((args[0] === 'new' || args[0] === 'edit') && can('accounts_post'))
        return accVoucherPage(args);
    const st = store.get('acc_vfilter', {}), f = { from: st.from || '', to: st.to || '', kind: st.kind || '', q: '', voided: '', page: 1 };
    const from = h('input', { type: 'date', value: f.from }), to = h('input', { type: 'date', value: f.to }), kind = h('select', null, ACC_KINDS.map(([v, l]) => h('option', { value: v, selected: v === f.kind }, l)));
    const qI = h('input', { placeholder: 'Search narration, number, account, party…', class: 'grow', style: { minWidth: '200px' } }), vd = h('input', { type: 'checkbox' }), box = h('div');
    const params = () => qs({ from: from.value, to: to.value, kind: kind.value, q: qI.value.trim(), voided: vd.checked ? '1' : '', page: f.page });
    const load = async () => {
        store.set('acc_vfilter', { from: from.value, to: to.value, kind: kind.value });
        const d = await GET('/api/accounts/journals?' + params());
        accFill(box, h('div', { class: 'small muted', style: { margin: '0 0 8px' } }, `${num(d.total)} entries · ${rs(d.amount)}`), accTable([{ t: 'Date', f: r => h('span', { style: { whiteSpace: 'nowrap' } }, day(r.date)) }, { t: 'No.', f: r => h('span', { class: 'mono', style: { whiteSpace: 'nowrap' } }, r.ref || '#' + r.id) },
            { t: 'Narration', f: r => [h('div', { style: { textDecoration: r.voided ? 'line-through' : '' } }, r.memo || '–'), h('div', { class: 'small muted' }, accSrcB(r.source), ' ', r.voided ? h('span', { class: 'b bad' }, 'VOID') : null, r.file_id ? h('span', { class: 'b info' }, 'receipt') : null)] },
            { t: 'Accounts', cls: 'acc-hide-sm', f: r => h('span', { class: 'small muted' }, r.accounts) }, { t: 'Amount', n: 1, f: r => rs(r.amount) }], d.rows, r => accJournal(r.id, load)), pager(d, p => { f.page = p; load(); }));
    };
    [from, to, kind, vd].forEach(e => e.addEventListener('change', () => { f.page = 1; load(); }));
    let t;
    qI.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.page = 1; load(); }, 300); });
    const P = can('accounts_post');
    accRender(pageHead('Vouchers', 'Every entry in the books — manual vouchers and the ones made automatically.', P ? h('button', { class: 'btn ghost', onclick: () => accQuick('PV') }, 'Payment') : null, P ? h('button', { class: 'btn ghost', onclick: () => accQuick('RV') }, 'Receipt') : null, P ? h('button', { class: 'btn ghost', onclick: () => accQuick('CV') }, 'Cash ↔ bank') : null, P ? h('button', { class: 'btn ghost', onclick: () => accQuick('owner') }, 'Owner') : null, P ? h('a', { class: 'btn primary', href: '#/vouchers/new' }, '+ Journal voucher') : null), h('div', { class: 'toolbar' }, kind, h('span', { class: 'small muted' }, 'from'), from, h('span', { class: 'small muted' }, 'to'), to, qI, h('label', { class: 'row small' }, vd, 'Show voided'), h('button', { class: 'btn ghost sm', onclick: () => accCsv('vouchers.csv', '/api/accounts/journals?csv=1&' + params()) }, 'CSV')), h('div', { class: 'card' }, box));
    await load();
});
/* ---------- accounts: shared helpers + overview ---------- */
document.head.append(h('style', null, `
.acc-lines{display:grid;gap:6px}
.acc-line{display:grid;grid-template-columns:minmax(190px,2.2fr) minmax(130px,1.3fr) 120px 120px minmax(110px,1.3fr) 34px;gap:6px;align-items:center}
.acc-line.hd{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.acc-line input,.acc-line select{width:100%}
.acc-line input.n{text-align:right}
.toolbar > select,.toolbar > input,.toolbar > label{max-width:100%}
.tbl td.mono{white-space:nowrap}
.acc-tot{display:flex;gap:18px;flex-wrap:wrap;align-items:center;justify-content:flex-end;font-variant-numeric:tabular-nums;font-weight:600}
.acc-check{display:grid;grid-template-columns:62px 1fr;gap:4px 12px;padding:12px 2px;border-bottom:1px solid var(--line)}
.acc-check:last-child{border-bottom:0}
.acc-check .t{font-weight:600}
.acc-check .fix{grid-column:2;margin-top:4px}
.acc-pctl{color:var(--muted);font-size:12px}
.statement .tbl td a{text-decoration:none}
.statement .tbl td a:hover{text-decoration:underline}
.acc-pl td:nth-child(n+2){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
@media (max-width:760px){
  .acc-line{grid-template-columns:1fr 1fr auto;grid-template-areas:"a a a" "d c x" "p m m";padding:10px;border:1px solid var(--line);border-radius:10px}
  .acc-line.hd{display:none}
  .acc-line > .acc-a{grid-area:a}.acc-line > .acc-p{grid-area:p}.acc-line > .acc-d{grid-area:d}.acc-line > .acc-c{grid-area:c}.acc-line > .acc-m{grid-area:m}.acc-line > .acc-x{grid-area:x}
  .acc-check{grid-template-columns:1fr}.acc-check .fix{grid-column:1}
  .acc-hide-sm{display:none}
}
@media print{.acc-noprint{display:none!important}.statement{max-width:none}}
`));
const ACC = { chart: null, at: 0 };
const accRender = (...k) => { const ns = k.flat(Infinity).filter(x => x != null && x !== false); ns.forEach(n => { if (n.style)
    n.style.minWidth = '0'; }); return render(...ns); };
const accFill = (el, ...k) => el.replaceChildren(...k.flat(Infinity).filter(x => x != null && x !== false));
const accSmall = () => innerWidth < 760;
// table() with columns marked cls:'acc-hide-sm' dropped on phones
const accTable = (cols, rows, onRow) => table(accSmall() ? cols.filter(c => !/acc-hide-sm/.test(c.cls || '')) : cols, rows, onRow);
async function accChart(force) { if (force || !ACC.chart || Date.now() - ACC.at > 60000) {
    ACC.chart = await GET('/api/accounts/chart');
    ACC.at = Date.now();
} return ACC.chart; }
const ACC_TYPES = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', contra_income: 'Less from sales', expense: 'Expenses' };
const accCash = ['Cash', 'Petty Cash', 'Meezan (SB)', 'PayFast'];
function accSelect(list, value, opts = {}) {
    const s = h('select', { class: opts.cls || '' }, opts.blank ? h('option', { value: '' }, opts.blank) : null, Object.entries(ACC_TYPES).map(([t, l]) => { const xs = list.filter(a => a.type === t && (a.active || a.name === value) && (!opts.only || opts.only(a))); return xs.length ? h('optgroup', { label: l }, xs.map(a => h('option', { value: a.name, selected: a.name === value }, a.name + (a.code ? '  ·  ' + a.code : '')))) : null; }));
    if (value)
        s.value = value;
    return s;
}
const accDrCr = v => !v || Math.abs(v) < 0.5 ? '–' : rs(Math.abs(v)) + (v > 0 ? ' Dr' : ' Cr');
const accSrc = s => ({ manual: 'Manual', opening: 'Opening', 'auto-sales': 'Auto · sales', 'auto-cogs': 'Auto · cost of sales', 'auto-returns': 'Auto · returns', 'auto-courier': 'Auto · PostEx charges', 'auto-settle': 'Auto · COD payment', lot: 'Auto · lot purchase' }[s] || s);
const accSrcB = s => h('span', { class: 'b ' + (s === 'manual' ? 'accent' : s === 'opening' ? 'info' : /^auto|^lot$/.test(s) ? '' : 'ok') }, accSrc(s));
const accMonthEnd = m => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
const accPrevMonth = () => { const t = todayStr(); return new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1)).toISOString().slice(0, 7); };
const accPrintBtn = () => h('button', { class: 'btn ghost sm acc-noprint', onclick: () => window.print() }, 'Print');
async function accCsv(name, path) { const rows = await act(() => GET(path)); csvDownload(name, rows); }
// one journal entry in a side drawer: lines, source info, edit/void
async function accJournal(id, onChange) {
    const j = await GET('/api/accounts/journals/' + id);
    const editable = j.source === 'manual' && !j.voided && !j.locked && can('accounts_post');
    const voidable = ['manual', 'opening'].includes(j.source) && !j.voided && !j.locked && can('accounts_post');
    let d;
    const meta = j.meta ? Object.entries(j.meta).filter(([k, v]) => k !== 'form' && v !== null && typeof v !== 'object') : [];
    d = drawer(h('div', { class: 'grid' }, h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'big' }, j.ref || ('#' + j.id)), h('div', { class: 'muted' }, day(j.date) + ' ' + j.date.slice(0, 4) + ' · ', accSrcB(j.source), j.voided ? h('span', { class: 'b bad', style: { marginLeft: '6px' } }, 'VOID') : null, j.locked ? h('span', { class: 'b', style: { marginLeft: '6px' } }, 'closed month') : null)), h('div', { class: 'row' }, editable ? h('a', { class: 'btn sm', href: '#/vouchers/edit/' + j.id, onclick: () => d.remove() }, 'Edit') : null, voidable ? h('button', { class: 'btn bad sm', onclick: async () => { const r = prompt('Why are you voiding ' + (j.ref || 'this entry') + '? (kept in the log)'); if (!r)
            return; await act(() => POST(`/api/accounts/journals/${j.id}/void`, { reason: r }), 'Voided'); d.remove(); onChange && onChange(); } }, 'Void') : null, h('button', { class: 'btn ghost sm', onclick: () => d.remove() }, 'Close'))), h('div', { class: 'card' }, h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, j.memo || '(no narration)'), j.voided ? h('div', { class: 'note bad', style: { marginBottom: '8px' } }, `Voided ${dt(j.voided_at)} by ${j.voided_by_name || '?'}: ${j.void_reason || ''}`) : null, h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Account'), h('th', null, 'Party / note'), h('th', { class: 'n' }, 'Debit'), h('th', { class: 'n' }, 'Credit'))), h('tbody', null, j.lines.map(l => h('tr', null, h('td', null, h('a', { href: `#/ledgers/gl/${encodeURIComponent(l.account)}`, onclick: () => d.remove() }, l.account), h('div', { class: 'small muted' }, l.code)), h('td', { class: 'small' }, l.party || '', l.memo ? h('div', { class: 'muted' }, l.memo) : null), h('td', { class: 'n' }, l.debit ? rs(l.debit) : ''), h('td', { class: 'n' }, l.credit ? rs(l.credit) : '')))), h('tfoot', null, h('tr', null, h('td', { colspan: 2 }, 'Total'), h('td', { class: 'n' }, rs(j.lines.reduce((s, l) => s + l.debit, 0))), h('td', { class: 'n' }, rs(j.lines.reduce((s, l) => s + l.credit, 0)))))))), h('div', { class: 'card' }, h('dl', { class: 'dl' }, h('dt', null, 'Source'), h('dd', null, accSrc(j.source) + ' · ' + j.source_id), h('dt', null, 'Entered by'), h('dd', null, (j.user || 'system') + ' · ' + dt(j.created_at)), j.updated_at ? [h('dt', null, 'Last changed'), h('dd', null, dt(j.updated_at))] : null, meta.map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]), j.file_id ? [h('dt', null, 'Receipt'), h('dd', null, fileLink(j.file_id))] : null), /^auto|^lot$/.test(j.source) ? h('div', { class: 'note', style: { marginTop: '10px' } }, 'Made automatically from orders/lots. It is recalculated every hour until the month is closed — fix the order data instead of editing it.') : null, j.history.length ? h('div', { class: 'timeline', style: { marginTop: '12px' } }, j.history.map(e => h('div', null, h('div', { class: 't' }, dt(e.at) + ' · ' + (e.user || '')), e.action.replace('accounts.', '').replace('.', ' ')))) : null)));
}
// little grouped bar chart that also shows losses (below the zero line)
function accBars(data, xKey, series, height = 190) {
    if (!data.length)
        return h('div', { class: 'empty' }, 'No data yet.');
    const W = 720, H = height, pad = 46, vals = data.flatMap(d => series.map(s => +d[s.k] || 0));
    const max = Math.max(1, ...vals), min = Math.min(0, ...vals), span = max - min, y = v => 8 + (H - 16) * (max - v) / span, bw = (W - pad) / data.length;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
    svg.setAttribute('class', 'chart');
    const mk = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const k in a)
        e.setAttribute(k, a[k]); if (txt != null)
        e.textContent = txt; svg.append(e); return e; };
    const short = v => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + 'k' : Math.round(v);
    for (const v of [max, (max + min) / 2, min]) {
        mk('line', { x1: pad, x2: W, y1: y(v), y2: y(v), stroke: 'currentColor', 'stroke-opacity': .08 });
        mk('text', { x: 0, y: y(v) + 4 }, short(v));
    }
    mk('line', { x1: pad, x2: W, y1: y(0), y2: y(0), stroke: 'currentColor', 'stroke-opacity': .35 });
    data.forEach((d, i) => {
        const gw = bw * 0.72, w = gw / series.length;
        series.forEach((s, k) => { const v = +d[s.k] || 0, x = pad + i * bw + bw * 0.14 + k * w, top = Math.min(y(v), y(0)); const r = mk('rect', { x, y: top, width: Math.max(1, w - 3), height: Math.max(1, Math.abs(y(v) - y(0))), fill: v < 0 ? 'var(--bad)' : s.c, rx: 2 }); const tt = document.createElementNS(ns, 'title'); tt.textContent = `${d[xKey]} · ${s.l}: Rs ${Math.round(v).toLocaleString()}`; r.append(tt); });
        mk('text', { x: pad + i * bw + bw / 2, y: H + 17, 'text-anchor': 'middle' }, new Date(d[xKey] + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
    });
    return h('div', null, svg, h('div', { class: 'legend' }, series.map(s => h('span', null, h('i', { style: { background: s.c } }), s.l)), h('span', null, h('i', { style: { background: 'var(--bad)' } }), 'Loss')));
}
/* ---------- overview ---------- */
registerView({ key: 'accounts', title: 'Accounts', group: 'Finance', perm: 'accounts', icon: 'book', order: 30 }, async () => {
    const d = await GET('/api/accounts/overview');
    const cashT = d.cash.filter(a => /cash/i.test(a.name)).reduce((s, a) => s + a.balance, 0), bankT = d.cash.filter(a => !/cash/i.test(a.name)).reduce((s, a) => s + a.balance, 0), m = d.mtd;
    const postNow = can('accounts_post') && d.start ? h('button', { class: 'btn ghost', onclick: async () => { const r = await act(() => POST('/api/accounts/auto')); toast(`Posted ${r.posted.length} entries` + (r.removed ? `, removed ${r.removed}` : '')); route(); } }, 'Post now') : null;
    accRender(pageHead('Accounts', 'Books kept from orders, PostEx, lots and vouchers. ' + (d.lock ? 'Closed up to ' + day(d.lock) + ' ' + d.lock.slice(0, 4) + '.' : 'No month closed yet.'), postNow, can('accounts_post') ? h('a', { class: 'btn primary', href: '#/vouchers/new' }, '+ New voucher') : null), !d.start ? h('div', { class: 'note warn row sp' }, h('span', null, 'Start here: enter the opening balances (cash, bank, stock, what suppliers are owed) as of the day before the ERP takes over. Sales, cost, courier charges and COD payments then post themselves.'), h('a', { class: 'btn sm', href: '#/close/opening' }, 'Opening balances')) : null, d.alerts.length ? h('div', { class: 'alist' }, d.alerts.map(a => h('a', { class: 'alrt ' + a.level, href: a.href }, icon(a.level === 'bad' ? 'alert' : 'bell', 16), h('span', null, a.text)))) : null, h('div', { class: 'kpis' }, kpi('Cash in hand', rs(cashT), 'Cash + petty cash', cashT < 0 ? 'alert' : '', '#/statements/cash'), kpi('In the bank', rs(bankT), 'Meezan + PayFast', bankT < 0 ? 'alert' : '', '#/statements/cash'), kpi('PostEx owes us', rs(d.postex), 'COD not yet paid, after charges', '', '#/ledgers/parties/courier'), kpi('We owe suppliers', rs(d.payables), d.suppliers.length + ' suppliers', d.payables > 0 ? 'warn' : '', '#/ledgers/parties/vendor'), kpi('Sales this month', rs(m.netSales), 'after returns & discounts', '', '#/statements/sales'), kpi('Net profit this month', rs(m.net), 'gross profit ' + rs(m.gross) + (m.netSales ? ' (' + Math.round(100 * m.gross / m.netSales) + '%)' : ''), m.net < 0 ? 'alert' : 'good', '#/statements')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Profit by month', h('small', null, 'last 6 months')), accBars(d.months, 'month', [{ k: 'gross', l: 'Gross profit', c: C3 }, { k: 'net', l: 'Net profit', c: C2 }]), accTable([{ t: 'Month', f: r => new Date(r.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) }, { t: 'Net sales', n: 1, f: r => rs(r.sales) }, { t: 'Gross profit', n: 1, f: r => rs(r.gross) },
        { t: 'Net profit', n: 1, f: r => h('span', { class: r.net < 0 ? 'neg' : '' }, rs(r.net)) }, { t: 'Margin', n: 1, f: r => pct(r.net, r.sales) }], d.months.slice().reverse(), r => { location.hash = '#/statements/pnl/' + r.month; })), h('div', { class: 'grid', style: { alignContent: 'start' } }, h('div', { class: 'card' }, h('h2', null, 'Cash & bank'), accTable([{ t: 'Account', f: r => h('a', { href: '#/statements/cash/' + encodeURIComponent(r.name) }, r.name) }, { t: 'Balance', n: 1, f: r => h('span', { class: r.balance < 0 ? 'neg' : '' }, rs(r.balance)) }], d.cash)), h('div', { class: 'card' }, h('h2', null, 'Suppliers we owe', h('a', { class: 'spacer small', href: '#/ledgers/parties/vendor' }, 'All')), d.suppliers.length ? accTable([{ t: 'Supplier', f: r => r.party.replace(/^vendor:/, '') }, { t: 'Owed', n: 1, f: r => rs(r.amount) }, { t: 'Last entry', f: r => day(r.last) }], d.suppliers, r => { location.hash = '#/ledgers/gl/' + encodeURIComponent('Accounts Payable') + '/' + encodeURIComponent(r.party); }) : h('div', { class: 'empty' }, 'Nothing owed.')), h('div', { class: 'card' }, h('h2', null, 'Automatic postings'), h('dl', { class: 'dl' }, h('dt', null, 'Posting from'), h('dd', null, d.start ? day(d.start) + ' ' + d.start.slice(0, 4) : 'not set'), h('dt', null, 'Closed up to'), h('dd', null, d.lock ? day(d.lock) + ' ' + d.lock.slice(0, 4) : '–'), h('dt', null, 'Last run'), h('dd', null, d.last ? `${d.last.at.slice(0, 16)} · ${d.last.posted} posted, ${d.last.unchanged} unchanged` : 'never')), h('div', { class: 'row', style: { marginTop: '10px' } }, h('a', { class: 'btn ghost sm', href: '#/close/auto' }, 'See what was posted'), h('a', { class: 'btn ghost sm', href: '#/close' }, 'Month close'))))));
});
/* ---------- Expenses: approvals, pay-backs, all claims, reports, setup, older entries (perm expenses_approve) ---------- */
registerView({ key: 'approvals', title: 'Expense approvals', group: 'Finance', perm: 'expenses_approve', icon: 'receipt', order: 90 }, async (args) => {
    const tab = args[0] || 'queue', go = t => { location.hash = '#/approvals/' + t; };
    const meta = await EX.getMeta(true);
    const head = [pageHead('Expenses', 'Approve claims, pay staff back, and see where every rupee went.', h('button', { class: 'btn ghost', onclick: () => EX.form(null, route) }, '+ Add expense')),
        tabs([['queue', 'To approve'], ['payback', 'Pay back staff'], ['all', 'All claims'], ['reports', 'Reports'], ['setup', 'Setup'], ['older', 'Older entries']], tab, go)];
    const T = exApprTabs[tab] || exApprTabs.queue;
    await T(head, meta, args.slice(1));
});
const exApprTabs = {
    async queue(head) {
        const d = await GET('/api/exp/claims?status=pending');
        const sel = new Set(), byId = Object.fromEntries(d.rows.map(r => [r.id, r]));
        const info = h('span', { class: 'small muted grow' });
        const ap = h('button', { class: 'btn ok big', disabled: true, onclick: async () => { const r = await act(() => POST('/api/exp/approve', { ids: [...sel] })); EX.approvedToast(r); route(); } }, 'Approve selected');
        const rj = h('button', { class: 'btn bad', disabled: true, onclick: () => EX.rejectAsk([...sel], route) }, 'Reject');
        const upd = () => { const s = [...sel].reduce((t, id) => t + byId[id].amount, 0); info.textContent = sel.size ? `${sel.size} selected · ${rs(s)}` : 'Tick claims to approve several at once'; ap.disabled = rj.disabled = !sel.size; };
        const boxes = d.rows.map(r => { const own = r.user_id === ME.id && ME.role !== 'admin'; return h('input', { type: 'checkbox', disabled: own, title: own ? 'You cannot approve your own claim' : null, onchange: e => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); upd(); } }); });
        const all = h('input', { type: 'checkbox', onchange: e => { boxes.forEach((b, i) => { if (b.disabled)
                return; b.checked = e.target.checked; e.target.checked ? sel.add(d.rows[i].id) : sel.delete(d.rows[i].id); }); upd(); } });
        upd();
        const old = d.rows.filter(r => (Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z')) > 2 * 864e5).length;
        exRender(head, h('div', { class: 'kpis ex-kpis' }, kpi('Waiting', num(d.total), rs(d.amount), d.total ? 'warn' : 'good'), kpi('Older than 2 days', num(old), null, old ? 'alert' : ''), kpi('No receipt', num(d.rows.filter(r => !r.receipt).length), 'check these carefully')), h('div', { class: 'card' }, d.rows.length ? [h('label', { class: 'row small muted', style: { padding: '4px' } }, all, 'Select all'),
            h('div', { class: 'ex-list' }, d.rows.map((r, i) => EX.row(r, { who: 1, check: boxes[i], onOpen: c => EX.open(c, route) }))),
            h('div', { class: 'ex-sticky' }, info, rj, ap)] : h('div', { class: 'empty' }, 'All caught up — no claims waiting.')));
    },
    async payback(head, meta) {
        const [owed, boxes] = await Promise.all([GET('/api/exp/owed'), GET('/api/exp/boxes')]);
        const pay = p => {
            const from = h('select', null, h('option', { value: 'Cash' }, 'Main cash'), h('option', { value: 'Meezan (SB)' }, 'Bank (Meezan)'), boxes.filter(b => b.active).map(b => h('option', { value: 'petty:' + b.id }, b.name + ' petty cash (' + rs(b.balance) + ')')));
            const dI = h('input', { type: 'date', value: todayStr() });
            const m = modal('Pay back ' + p.user, h('div', { class: 'grid' }, h('div', { style: { fontSize: '24px', fontWeight: 800 } }, rs(p.amount)), h('div', { class: 'muted small' }, p.n + ' approved claim(s) paid from their own money.'), field('Paid from', from), field('Date', dI)), [h('button', { class: 'btn ok big', onclick: async () => { const r = await act(() => POST('/api/exp/reimburse', { ids: p.ids, from: from.value, day: dI.value })); toast(`Paid back ${rs(r.amount)}` + (r.pending ? ' · posting pending' : '')); m.remove(); route(); } }, 'Mark as paid')]);
        };
        const total = owed.reduce((s, p) => s + p.amount, 0);
        exRender(head, h('div', { class: 'kpis ex-kpis' }, kpi('Owed to staff', rs(total), owed.length + ' people', total ? 'alert' : 'good')), h('div', { class: 'card' }, h('h2', null, 'Staff who paid from their own pocket'), owed.length ? table([{ t: 'Person', k: 'user' }, { t: 'Claims', n: 1, k: 'n' }, { t: 'Owed', n: 1, f: p => h('strong', null, rs(p.amount)) },
            { t: '', f: p => h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#/approvals/all/owed/' + p.user_id; } }, 'See claims'), h('button', { class: 'btn ok sm', onclick: () => pay(p) }, 'Pay back')) }], owed) : h('div', { class: 'empty' }, 'Nobody is owed money right now.')));
    },
    async all(head, meta, a) {
        let st = a[0] || '', user = a[1] || '', month = store.get('ex_all_month', monthStr()), qq = '', pageN = 1;
        const box = h('div');
        const mI = h('input', { type: 'month', value: month }), sI = h('select', null, [['', 'All statuses'], ['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['owed', 'To pay back']].map(([v, l]) => h('option', { value: v, selected: v === st }, l)));
        const qI = h('input', { type: 'search', placeholder: 'Search shop, note…' });
        const load = async () => {
            const d = await GET('/api/exp/claims?' + qs({ status: st, month: st === 'owed' ? '' : month, user, q: qq, page: pageN }));
            box.replaceChildren(h('div', { class: 'small muted', style: { margin: '6px 0' } }, `${num(d.total)} claims · ${rs(d.amount)}`), d.rows.length ? h('div', { class: 'ex-list' }, d.rows.map(r => EX.row(r, { who: 1, post: 1, onOpen: c => EX.open(c, load) }))) : h('div', { class: 'empty' }, 'Nothing here.'), pager(d, p => { pageN = p; load(); }));
        };
        mI.onchange = () => { month = mI.value; store.set('ex_all_month', month); pageN = 1; load(); };
        sI.onchange = () => { st = sI.value; pageN = 1; load(); };
        let t;
        qI.oninput = () => { clearTimeout(t); t = setTimeout(() => { qq = qI.value; pageN = 1; load(); }, 300); };
        exRender(head, h('div', { class: 'card' }, h('div', { class: 'toolbar row' }, mI, sI, qI, user ? h('button', { class: 'btn ghost sm', onclick: () => { user = ''; load(); } }, 'Showing one person · clear') : null, h('button', { class: 'btn ghost sm', onclick: async () => csvDownload('expenses-' + month + '.csv', await GET('/api/exp/export?month=' + month)) }, 'Download CSV')), box));
        await load();
    },
    async reports(head) {
        const mI = h('input', { type: 'month', value: store.get('ex_rep_month', monthStr()) }), box = h('div', { class: 'grid' });
        const bars = (rows, label, max, budgetKey) => rows.length ? rows.map(r => {
            const b = budgetKey && r[budgetKey];
            const p = b ? 100 * r.amount / b : 100 * r.amount / (max || 1);
            return h('div', { class: 'ex-bar' }, h('span', null, r[label]), h('div', { class: 'bar ' + (b ? (p > 100 ? 'bad' : p > 85 ? 'warn' : 'ok') : '') }, h('i', { style: { width: Math.min(100, p) + '%' } })), h('span', { class: 'v' }, h('strong', null, rs(r.amount)), b ? h('span', { class: 'small muted' }, ' / ' + rs(b)) : r.n ? h('span', { class: 'small muted' }, ' · ' + r.n) : null));
        }) : h('div', { class: 'empty' }, 'No expenses this month.');
        const load = async () => {
            const r = await GET('/api/exp/report?month=' + mI.value), max = k => Math.max(1, ...r[k].map(x => x.amount));
            const over = r.byCategory.filter(c => c.budget && c.amount > c.budget);
            box.replaceChildren(h('div', { class: 'kpis ex-kpis' }, kpi('Spent this month', rs(r.total), r.n + ' entries (approved + waiting)'), kpi('Waiting approval', rs(r.pending), null, r.pending ? 'warn' : ''), kpi('Budget', r.budget ? rs(r.budget) : 'not set', r.budget ? `${rs(r.budgetSpent)} spent in budgeted categories (${pct(r.budgetSpent, r.budget)})` : 'set budgets in Setup', r.budget && r.budgetSpent > r.budget ? 'alert' : ''), kpi('Over budget', num(over.length), over.map(c => c.category).join(', ') || 'none', over.length ? 'alert' : 'good')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'By category vs budget'), bars(r.byCategory.filter(c => c.amount > 0 || c.budget), 'category', max('byCategory'), 'budget')), h('div', { class: 'card' }, h('h2', null, 'Last 6 months'), chart(r.trend.map(t => (Object.assign(Object.assign({}, t), { m: t.month }))), 'm', [{ k: 'approved', l: 'Approved', c: C3 }, { k: 'pending', l: 'Waiting', c: C4 }]))), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'By person'), bars(r.byPerson, 'person', max('byPerson'))), h('div', { class: 'card' }, h('h2', null, 'By shop / vendor'), bars(r.byVendor.slice(0, 12), 'vendor', max('byVendor')))), h('div', { class: 'card' }, h('h2', null, 'Biggest expenses'), r.top.length ? h('div', { class: 'ex-list' }, r.top.map(c => EX.row(c, { who: 1, onOpen: x => EX.open(x, load) }))) : h('div', { class: 'empty' }, 'Nothing yet.')));
        };
        mI.onchange = () => { store.set('ex_rep_month', mI.value); load(); };
        exRender(head, h('div', { class: 'row' }, 'Month', mI, h('button', { class: 'btn ghost sm', onclick: async () => csvDownload('expenses-' + mI.value + '.csv', await GET('/api/exp/export?month=' + mI.value)) }, 'Download CSV')), box);
        await load();
    },
    async setup(head, meta) {
        const [cats, rec, st, posts] = await Promise.all([GET('/api/exp/categories'), GET('/api/exp/recurring'), GET('/api/exp/settings'), GET('/api/exp/postings')]);
        const catForm = c => formModal(c ? 'Edit category' : 'New category', [
            { k: 'name', label: 'Name staff see', value: c && c.name, required: true }, { k: 'account', label: 'Posts to account', type: 'select', options: meta.accounts, value: c ? c.account : 'Miscellenious Exp' },
            { k: 'budget', label: 'Monthly budget (Rs, optional)', type: 'number', value: c && c.budget }, c ? { k: 'active', label: 'In use', type: 'checkbox', value: c.active } : null
        ].filter(Boolean), async (v) => { await POST('/api/exp/categories', Object.assign(Object.assign({}, v), { id: c && c.id })); toast('Saved'); route(); });
        const recForm = t => formModal(t ? 'Edit recurring expense' : 'New recurring expense', [
            { k: 'name', label: 'Name', value: t && t.name, required: true, placeholder: 'e.g. Outlet rent' }, { k: 'category_id', label: 'Category', type: 'select', options: cats.filter(c => c.active).map(c => [c.id, c.name + ' → ' + c.account]), value: t && t.category_id },
            { k: 'amount', label: 'Amount (Rs)', type: 'number', value: t && t.amount }, { k: 'dom', label: 'Day of month', type: 'number', value: t ? t.dom : 1 },
            { k: 'paid_from', label: 'Paid from', type: 'select', options: Object.entries(meta.payAll).filter(([k]) => k !== 'own'), value: t ? t.paid_from : 'bank' },
            { k: 'vendor', label: 'Paid to (landlord, company)', value: t && t.vendor }, { k: 'note', label: 'Note', value: t && t.note, full: 1 }, { k: 'active', label: 'On (create an entry every month)', type: 'checkbox', value: t && t.active }
        ], async (v) => { await POST('/api/exp/recurring', Object.assign(Object.assign({}, v), { id: t && t.id })); toast('Saved'); route(); });
        const pend = posts.filter(p => p.status !== 'posted');
        exRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Recurring expenses'), h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: async () => { const r = await act(() => POST('/api/exp/recurring/run')); toast(r.created ? r.created + ' entries created for approval' : 'Nothing due right now'); route(); } }, 'Run now'), h('button', { class: 'btn sm', onclick: () => recForm() }, '+ New'))), h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Each month on the given day an entry is created in "To approve" — so rent and bills are never forgotten.'), table(exCols([{ t: 'Name', f: t => [h('strong', null, t.name), h('div', { class: 'small muted' }, t.category || '–')] }, { t: 'Amount', n: 1, f: t => t.amount ? rs(t.amount) : h('span', { class: 'muted' }, 'not set') },
            { t: 'Day', n: 1, k: 'dom' }, { t: 'Paid from', sm: 1, f: t => EX.payL(t.paid_from) }, { t: 'Last', sm: 1, f: t => t.last_period || '–' },
            { t: '', f: t => h('span', { class: 'b ' + (t.active ? 'ok' : '') }, t.active ? 'On' : 'Off') }]), rec, recForm)), h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'Categories'), h('button', { class: 'btn sm', onclick: () => catForm() }, '+ New')), table(exCols([{ t: 'Category', f: c => [h('strong', { style: { opacity: c.active ? 1 : .5 } }, c.name), c.active ? null : h('span', { class: 'b', style: { marginLeft: '6px' } }, 'off')] }, { t: 'Account', sm: 1, f: c => h('span', { class: 'small' }, c.account) },
            { t: 'This month', n: 1, f: c => rs(c.spent) }, { t: 'Budget', n: 1, f: c => c.budget ? rs(c.budget) : h('span', { class: 'muted' }, '–') }]), cats, catForm)), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Rules'), h('div', { class: 'fgrid' }, field('Receipt needed above (Rs)', h('input', { type: 'number', id: 'ex-lim', value: st.receipt_limit })), field('Company card posts to', h('select', { id: 'ex-card' }, ['Meezan (SB)', 'Cash', 'Accrued Expenses'].map(a => h('option', { selected: a === st.card_account }, a)))), field('Alert when waiting more than (days)', h('input', { type: 'number', id: 'ex-wait', value: st.wait_days }))), h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: async () => { await act(() => POST('/api/exp/settings', { receipt_limit: +$('#ex-lim').value, card_account: $('#ex-card').value, wait_days: +$('#ex-wait').value }), 'Saved'); } }, 'Save rules')), h('div', { class: 'card' }, h('h2', null, 'Accounts posting'), meta.accountsLive ? null : h('div', { class: 'note warn' }, 'The Accounts module is not switched on yet. Approved entries are kept and will be posted automatically once it is.'), h('div', { class: 'small muted' }, `${posts.filter(p => p.status === 'posted').length} posted · ${pend.length} waiting`), pend.slice(0, 8).map(p => h('div', { class: 'small', style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } }, h('span', { class: 'b ' + (p.status === 'error' ? 'bad' : '') }, p.status), ' ', p.source, ' #', p.source_id, p.error ? h('span', { style: { color: 'var(--bad)' } }, ' — ' + p.error) : '')), pend.length ? h('button', { class: 'btn ghost sm', style: { marginTop: '8px' }, onclick: async () => { const r = await act(() => POST('/api/exp/postings/retry')); toast(`${r.posted} posted, ${r.left} still waiting`); route(); } }, 'Try posting again') : null)));
    },
    async older(head) {
        let pageN = 1;
        const box = h('div');
        const load = async () => {
            const d = await GET('/api/exp/older?page=' + pageN);
            box.replaceChildren(h('div', { class: 'note' }, 'Entries from the old simple expense screen. Shown for reference only — they are not posted to accounts.'), h('div', { class: 'small muted', style: { margin: '8px 0' } }, `${num(d.total)} entries · ${rs(d.amount)}`), table(exCols([{ t: 'Date', f: r => day(r.day) }, { t: 'Category', k: 'category' }, { t: 'Note', sm: 1, k: 'note' }, { t: 'By', sm: 1, k: 'user' }, { t: 'Amount', n: 1, f: r => rs(r.amount) }]), d.rows), pager(d, p => { pageN = p; load(); }));
        };
        exRender(head, h('div', { class: 'card' }, box));
        await load();
    },
};
function exCols(cols) { return cols.filter(c => !(c.sm && innerWidth < 600)); }
/* ---------- Expenses: petty cash boxes (approvers see all; custodians see their own box via #/pettybox) ---------- */
registerView({ key: 'pettycash', title: 'Petty cash', group: 'Finance', perm: 'expenses_approve', icon: 'cash', order: 95 }, async (args) => {
    if (args[0])
        return exBoxView(+args[0], '#/pettycash/');
    const boxes = await GET('/api/exp/boxes');
    const total = boxes.filter(b => b.active).reduce((s, b) => s + b.balance, 0);
    exRender(pageHead('Petty cash', 'Cash kept in the office and outlet. Every rupee in and out, with counts by the person who keeps it.', h('button', { class: 'btn ghost', onclick: () => exBoxForm() }, '+ New cash box')), h('div', { class: 'kpis ex-kpis' }, kpi('Cash in all boxes (book)', rs(total)), kpi('Claims waiting from boxes', rs(boxes.reduce((s, b) => s + b.pending, 0)), 'paid from petty cash, not approved yet'), kpi('Counts to check', num(boxes.filter(b => b.lastCount && b.lastCount.status === 'pending').length), 'short / over', boxes.some(b => b.lastCount && b.lastCount.status === 'pending') ? 'alert' : '')), h('div', { class: 'ex-boxes' }, boxes.map(b => h('a', { class: 'card ex-box', href: '#/pettycash/' + b.id, style: { textDecoration: 'none', opacity: b.active ? 1 : .55 } }, h('div', { class: 'row sp' }, h('strong', null, b.name + ' box'), b.low_now ? h('span', { class: 'b bad' }, 'Low') : h('span', { class: 'b ok' }, 'OK')), h('div', { class: 'big' }, rs(b.balance)), h('div', { class: 'small muted' }, 'Kept by ', b.custodian_name || h('em', null, 'nobody yet'), ' · alert below ', rs(b.low)), h('div', { class: 'small muted' }, b.lastCount ? ['Last count ', day(b.lastCount.day), ': ', b.lastCount.variance ? h('span', { style: { color: 'var(--bad)' } }, (b.lastCount.variance < 0 ? 'short ' : 'over ') + rs(Math.abs(b.lastCount.variance))) : 'matched'] : 'Never counted'), b.pending ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, rs(b.pending) + ' in claims waiting approval') : null))));
});
async function exBoxForm(b) {
    b = b || { low: 5000 };
    const users = await GET('/api/exp/users');
    formModal(b.id ? 'Edit cash box' : 'New cash box', [
        { k: 'name', label: 'Name', value: b.name, required: true, placeholder: 'e.g. Office, Outlet' },
        { k: 'custodian', label: 'Kept by (custodian)', type: 'select', options: [['', '— nobody —']].concat(users.map(u => [u.id, u.name])), value: b.custodian || '' },
        { k: 'low', label: 'Alert when below (Rs)', type: 'number', value: b.low },
        b.id ? { k: 'active', label: 'In use', type: 'checkbox', value: b.active !== 0 } : null,
    ].filter(Boolean), async (v) => { await POST('/api/exp/boxes', Object.assign(Object.assign({}, v), { id: b.id })); toast('Saved'); route(); });
}
function exCountForm(box, after) {
    const notes = [5000, 1000, 500, 100, 50, 20, 10], coins = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'Coins Rs', min: 0 });
    const ins = notes.map(n => h('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '0', style: { width: '100%' } }));
    const total = h('input', { type: 'number', inputmode: 'decimal', class: 'ex-amt', placeholder: 'Rs 0' });
    const diff = h('div', { class: 'note' });
    const show = () => { const v = +total.value || 0, d = Math.round(v - box.expected); diff.className = 'note ' + (total.value === '' ? '' : Math.abs(d) < 1 ? 'ok' : 'bad'); diff.textContent = total.value === '' ? `Expected in the box: ${rs(box.expected)}` : Math.abs(d) < 1 ? 'Matches the book.' : `${d < 0 ? 'Short' : 'Over'} by ${rs(Math.abs(d))} — expected ${rs(box.expected)}. The owner will be alerted.`; };
    const sum = () => { total.value = ins.reduce((s, el, i) => s + (+el.value || 0) * notes[i], 0) + (+coins.value || 0); show(); };
    ins.concat(coins).forEach(el => el.addEventListener('input', sum));
    total.addEventListener('input', show);
    show();
    const note = h('input', { placeholder: 'Note (optional)' });
    const m = modal('Count cash · ' + box.name + ' box', h('div', { class: 'grid' }, h('div', { class: 'small muted' }, `Book balance ${rs(box.balance)}` + (box.pending ? ` − claims waiting ${rs(box.pending)}` : '') + ` = expected ${rs(box.expected)}`), h('details', null, h('summary', { class: 'small', style: { cursor: 'pointer' } }, 'Count by notes (optional)'), h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(88px,1fr))', gap: '8px', marginTop: '8px' } }, notes.map((n, i) => field('Rs ' + n.toLocaleString() + ' ×', ins[i])), field('Coins', coins))), field('Cash counted (Rs) *', total), diff, note), [h('button', { class: 'btn primary big', onclick: async () => { const r = await act(() => POST(`/api/exp/boxes/${box.id}/count`, { counted: total.value, note: note.value })); toast(Math.abs(r.variance) < 1 ? 'Count saved — matches' : 'Count saved — difference sent for review', Math.abs(r.variance) >= 1); m.remove(); after(); } }, 'Save count')]);
}
async function exBoxView(id, base) {
    const meta = await EX.getMeta(true);
    if (!id) {
        if (meta.myBoxes.length)
            id = meta.myBoxes[0];
        else
            return exRender(h('div', { class: 'card empty' }, 'You do not keep a petty cash box.'));
    }
    const d = await GET(`/api/exp/boxes/${id}/register`), b = d.box, appr = meta.approver;
    let tab = store.get('ex_box_tab', 'register');
    const again = () => exBoxView(id, base);
    const pendingCounts = d.counts.filter(k => k.status === 'pending');
    const kindL = { topup: 'Top-up', expense: 'Expense', reimburse: 'Paid back to staff', adjust: 'Count difference' };
    const body = h('div');
    const draw = () => {
        body.replaceChildren(tabs([['register', 'Register'], ['waiting', 'Claims waiting', d.pending.length || null], ['counts', 'Counts', d.counts.length || null]], tab, t => { tab = t; store.set('ex_box_tab', t); draw(); }), tab === 'register' ? (d.rows.length ? table([{ t: 'Date', f: r => day(r.day) }, { t: 'Details', f: r => [h('strong', null, kindL[r.kind] || r.kind), h('div', { class: 'small muted' }, r.note || '', r.user ? ' · ' + r.user : '', r.post_status && r.post_status !== 'posted' ? h('span', { class: 'b', style: { marginLeft: '4px' } }, 'posting pending') : '')] },
            { t: 'In / out', n: 1, f: r => h('span', { class: r.amount < 0 ? 'neg' : 'pos', style: { fontWeight: 600 } }, (r.amount < 0 ? '−' : '+') + rs(Math.abs(r.amount)).replace('Rs ', '')) }, { t: 'Balance', n: 1, f: r => rs(r.balance) }], d.rows, r => { if (r.src === 'claim' && appr)
            GET('/api/exp/claims/' + r.ref).then(c => EX.open(c, again)); }) : h('div', { class: 'empty' }, 'No cash in or out yet.' + (appr ? ' Start with a top-up.' : '')))
            : tab === 'waiting' ? (d.pending.length ? h('div', { class: 'ex-list' }, d.pending.map(c => EX.row(c, { who: 1, onOpen: x => EX.open(x, again) }))) : h('div', { class: 'empty' }, 'No claims waiting.'))
                : (d.counts.length ? table([{ t: 'Date', f: k => day(k.day) }, { t: 'By', f: k => k.user }, { t: 'Counted', n: 1, f: k => rs(k.counted) }, { t: 'Expected', n: 1, f: k => rs(k.book - (k.pending || 0)) },
                    { t: 'Difference', n: 1, f: k => Math.abs(k.variance) < 1 ? h('span', { class: 'b ok' }, 'matched') : h('span', { class: 'neg' }, (k.variance < 0 ? 'short ' : 'over ') + rs(Math.abs(k.variance))) },
                    { t: 'Status', f: k => h('span', { class: 'b ' + ({ ok: 'ok', pending: 'warn', approved: 'info', rejected: 'bad' }[k.status] || '') }, { ok: 'OK', pending: 'To check', approved: 'Written off', rejected: 'Rejected' }[k.status] || k.status) }], d.counts) : h('div', { class: 'empty' }, 'No counts yet.')));
    };
    draw();
    exRender(pageHead(b.name + ' petty cash', 'Kept by ' + (b.custodian_name || 'nobody yet') + (appr ? '' : ' (you)'), appr && base === '#/pettycash/' ? h('a', { class: 'btn ghost', href: '#/pettycash' }, '← All boxes') : null, appr ? h('button', { class: 'btn ghost', onclick: () => exBoxForm(b) }, 'Edit box') : null, appr ? h('button', { class: 'btn', onclick: () => formModal('Top up ' + b.name + ' box', [{ k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'from', label: 'From', type: 'select', options: [['Meezan (SB)', 'Bank (Meezan)'], ['Cash', 'Main cash']] }, { k: 'day', label: 'Date', type: 'date', value: todayStr() }, { k: 'note', label: 'Note', placeholder: 'optional' }], async (v) => { const r = await POST(`/api/exp/boxes/${b.id}/topup`, v); toast('Topped up' + (r.posting !== 'posted' ? ' · posting pending' : '')); again(); }, 'Top up') }, '+ Top up') : null, h('button', { class: 'btn primary', onclick: () => exCountForm(b, again) }, 'Count cash')), h('div', { class: 'kpis ex-kpis' }, kpi('Balance (book)', rs(b.balance), b.low_now ? 'below ' + rs(b.low) + ' — top up' : 'alert below ' + rs(b.low), b.low_now ? 'alert' : 'good'), kpi('Claims waiting', rs(b.pending), 'paid from this box, not approved yet', b.pending ? 'warn' : ''), kpi('Cash that should be in the box', rs(b.expected), 'balance − claims waiting'), kpi('Last count', b.lastCount ? day(b.lastCount.day) : 'never', b.lastCount ? (Math.abs(b.lastCount.variance) < 1 ? 'matched' : (b.lastCount.variance < 0 ? 'short ' : 'over ') + rs(Math.abs(b.lastCount.variance))) : 'count the cash today', b.lastCount && Math.abs(b.lastCount.variance) >= 1 ? 'alert' : '')), pendingCounts.map(k => h('div', { class: 'note warn row sp' }, h('span', null, `Count on ${day(k.day)} by ${k.user}: `, h('strong', null, (k.variance < 0 ? 'short ' : 'over ') + rs(Math.abs(k.variance))), k.note ? ' — ' + k.note : ''), appr ? h('span', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: async () => { const reason = prompt('Why reject this count? (e.g. recount needed)') || ''; await act(() => POST(`/api/exp/counts/${k.id}/reject`, { reason }), 'Rejected'); again(); } }, 'Reject'), h('button', { class: 'btn warn sm', onclick: async () => { if (!confirm(`Accept the difference of ${rs(Math.abs(k.variance))}? It will be posted to Miscellaneous expense and the book balance corrected.`))
            return; await act(() => POST(`/api/exp/counts/${k.id}/approve`), 'Difference written off'); again(); } }, 'Accept difference')) : h('span', { class: 'small muted' }, 'Waiting for owner'))), h('div', { class: 'card' }, body));
}
/* ---------- Expenses: my expenses (everyone), claim form, shared helpers, My day card ---------- */
document.head.append(h('style', null, `
.ex-list{display:grid;gap:0}
.ex-row{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:center;padding:11px 4px;border-bottom:1px solid var(--line);cursor:pointer}
.ex-row:last-child{border-bottom:0}
.ex-row:hover{background:var(--hover)}
.ex-row .amt{font-weight:700;text-align:right;white-space:nowrap}
.ex-row .sub{grid-column:2/4;font-size:12.5px;color:var(--muted)}
.ex-row .sub.bad{color:var(--bad)}
.ex-row .ck{grid-row:1/3}
.ex-row .ck input{width:20px;height:20px}
.ex-row .ck .ex-ic{width:46px;height:46px}
.ex-ic{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--soft);color:var(--muted);grid-row:1/3}
.ex-chips{display:flex;flex-wrap:wrap;gap:6px}
.ex-chips .btn{flex:1 1 140px;justify-content:center;padding:10px 10px;white-space:normal;text-align:center;line-height:1.2}
.ex-amt{font-size:26px!important;font-weight:700;padding:10px 12px!important}
.ex-thumb{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:var(--soft)}
.ex-receipt{max-width:100%;max-height:60vh;border-radius:10px;border:1px solid var(--line);display:block;margin:auto}
.ex-bar{display:grid;grid-template-columns:minmax(90px,170px) 1fr auto;gap:6px 10px;align-items:center;font-size:13px;padding:5px 0}
.ex-bar .bar{height:10px}
.ex-bar .bar:not(.ok):not(.warn):not(.bad) i{background:var(--info)}
.ex-bar .v{white-space:nowrap;text-align:right;min-width:110px}
.ex-sticky{position:sticky;bottom:0;background:var(--panel);border-top:1px solid var(--line);padding:10px 0 2px;margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;z-index:2}
.ex-boxes{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.ex-box{cursor:pointer}
.ex-box .big{font-size:24px;font-weight:800;letter-spacing:-.02em}
@media (max-width:600px){.ex-kpis{grid-template-columns:1fr 1fr;gap:8px}.ex-kpis .kpi{padding:10px 12px}.ex-kpis .kpi .v{font-size:18px}.ex-sticky .grow{flex-basis:100%}.ex-bar{grid-template-columns:1fr auto}.ex-bar .bar{grid-column:1/-1;grid-row:2}.ex-hide-sm{display:none}}
`));
const EX = {
    meta: null,
    async getMeta(force) { if (!EX.meta || force)
        EX.meta = await GET('/api/exp/meta'); return EX.meta; },
    statusB(c) {
        if (c.status === 'pending')
            return h('span', { class: 'b warn' }, 'Waiting');
        if (c.status === 'rejected')
            return h('span', { class: 'b bad' }, 'Rejected');
        if (c.paid_from === 'own')
            return h('span', { class: 'b ' + (c.reimbursed ? 'ok' : 'info') }, c.reimbursed ? 'Paid back' : 'Approved · to pay back');
        return h('span', { class: 'b ok' }, 'Approved');
    },
    postB(c) { if (c.status !== 'approved')
        return null; const s = c.post_status || c.status_post; return s === 'posted' ? h('span', { class: 'b ok', title: 'Posted to accounts' }, 'Posted') : s === 'error' ? h('span', { class: 'b bad', title: c.post_error || '' }, 'Not posted') : h('span', { class: 'b', title: 'Will be posted when Accounts is ready' }, 'Posting pending'); },
    payL: k => (EX.meta && EX.meta.payAll[k]) || k,
    ICON: { petty: 'cash', own: 'user', bank: 'bank', card: 'wallet', accrued: 'clock' },
    // one claim as a phone-friendly row
    row(c, opts = {}) {
        const who = opts.who ? (c.user || (c.recurring_id ? 'Recurring bill' : '—')) : null;
        return h('div', { class: 'ex-row', onclick: e => { if (!e.target.closest('input,button,a'))
                (opts.onOpen || EX.open)(c); } }, opts.check ? h('label', { class: 'ck row', style: { gap: '8px' } }, opts.check, c.receipt ? h('img', { class: 'ex-thumb', style: { width: '46px', height: '46px' }, src: '/api/files/' + c.receipt, alt: '', onerror: e => e.target.replaceWith(h('span', { class: 'ex-ic' }, icon('doc', 18))) }) : h('span', { class: 'ex-ic', title: 'No receipt' }, icon(EX.ICON[c.paid_from] || 'receipt', 18))) : h('div', { class: 'ex-ic' }, icon(EX.ICON[c.paid_from] || 'receipt', 18)), h('div', null, h('strong', null, c.category), c.vendor ? h('span', { class: 'muted' }, ' · ' + c.vendor) : null), h('div', { class: 'amt' }, rs(c.amount)), h('div', { class: 'sub row', style: { gap: '6px' } }, day(c.day), who ? h('span', null, '· ' + who) : null, h('span', null, '· ' + EX.payL(c.paid_from) + (c.box ? ' (' + c.box + ')' : '')), c.receipt ? h('span', { class: 'b info' }, 'Receipt') : null, EX.statusB(c), opts.post ? EX.postB(c) : null), c.status === 'rejected' && c.reason ? h('div', { class: 'sub bad' }, 'Reason: ' + c.reason) : c.note ? h('div', { class: 'sub' }, c.note) : null);
    },
    receiptView(id) {
        if (!id)
            return h('div', { class: 'note' }, 'No receipt attached.');
        const img = h('img', { class: 'ex-receipt', src: '/api/files/' + id, alt: 'Receipt' });
        img.onerror = () => img.replaceWith(h('a', { class: 'btn ghost', href: '/api/files/' + id, target: '_blank' }, icon('doc', 16), 'Open receipt (PDF / file)'));
        return h('a', { href: '/api/files/' + id, target: '_blank' }, img);
    },
    // claim detail: owner can edit/delete while waiting/rejected; approvers get approve/reject/reopen
    async open(c, after) {
        const m = await EX.getMeta();
        const mine = c.user_id === ME.id;
        const reload = () => { mm.remove(); (after || route)(); };
        const acts = [];
        if (mine && c.status !== 'approved') {
            acts.push(h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Delete this expense?'))
                    return; await act(() => api('DELETE', '/api/exp/claims/' + c.id), 'Deleted'); reload(); } }, 'Delete'));
            acts.push(h('button', { class: 'btn', onclick: () => { mm.remove(); EX.form(c, after); } }, c.status === 'rejected' ? 'Fix & send again' : 'Edit'));
        }
        if (m.approver && c.status === 'pending' && (!mine || ME.role === 'admin')) {
            acts.push(h('button', { class: 'btn bad', onclick: () => EX.rejectAsk([c.id], reload) }, 'Reject'));
            acts.push(h('button', { class: 'btn ok', onclick: async () => { const r = await act(() => POST('/api/exp/approve', { ids: [c.id] })); EX.approvedToast(r); reload(); } }, 'Approve'));
        }
        if (m.approver && c.status !== 'pending' && !c.reimbursed)
            acts.push(h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Move this claim back to waiting? Any accounts entry will be removed.'))
                    return; await act(() => POST('/api/exp/reopen', { id: c.id }), 'Reopened'); reload(); } }, 'Reopen'));
        const mm = modal('Expense #' + c.id, h('div', { class: 'grid' }, h('div', { class: 'row sp' }, h('div', { style: { fontSize: '26px', fontWeight: 800 } }, rs(c.amount)), h('div', { class: 'row' }, EX.statusB(c), EX.postB(c))), c.status === 'rejected' ? h('div', { class: 'note bad' }, 'Rejected: ' + (c.reason || '')) : null, h('dl', { class: 'dl' }, h('dt', null, 'Date'), h('dd', null, day(c.day)), h('dt', null, 'Category'), h('dd', null, c.category, h('span', { class: 'muted small' }, ' → ' + c.account)), h('dt', null, 'Paid from'), h('dd', null, EX.payL(c.paid_from), c.box ? ' · ' + c.box + ' box' : ''), h('dt', null, 'Shop / vendor'), h('dd', null, c.vendor || '–'), h('dt', null, 'Note'), h('dd', null, c.note || '–'), h('dt', null, 'By'), h('dd', null, c.user || (c.recurring_id ? 'Recurring bill (' + c.period + ')' : '–')), c.approver ? [h('dt', null, c.status === 'rejected' ? 'Rejected by' : 'Approved by'), h('dd', null, c.approver, ' · ', dt(c.approved_at))] : null, c.paid_from === 'own' && c.reimbursed ? [h('dt', null, 'Paid back'), h('dd', null, day(c.reimbursed_at), ' from ', String(c.reimb_from || '').replace(/^petty:.*/, 'petty cash'))] : null, c.post_error && c.status === 'approved' ? [h('dt', null, 'Accounts'), h('dd', { style: { color: 'var(--bad)' } }, c.post_error)] : null), EX.receiptView(c.receipt)), acts);
    },
    approvedToast(r) { if (!r)
        return; toast(`${r.approved} approved` + (r.pending ? ` · ${r.pending} posting pending` : '') + (r.errors && r.errors.length ? ' · ' + r.errors.join('; ') : ''), !!(r.errors && r.errors.length)); },
    rejectAsk(ids, after) {
        const t = h('textarea', { placeholder: 'e.g. Receipt not clear, please attach again' });
        const quick = ['Receipt missing or not clear', 'Wrong category', 'Amount does not match receipt', 'Not an office expense'].map(s => h('button', { class: 'btn ghost sm', onclick: () => { t.value = s; } }, s));
        const m = modal(`Reject ${ids.length > 1 ? ids.length + ' claims' : 'claim'}`, h('div', { class: 'grid' }, h('div', { class: 'muted small' }, 'The staff member sees this reason and can fix the claim.'), h('div', { class: 'row' }, quick), t), [h('button', { class: 'btn bad', onclick: async () => { await act(() => POST('/api/exp/reject', { ids, reason: t.value }), 'Rejected'); m.remove(); after && after(); } }, 'Reject')]);
    },
    // the claim form (add or edit) — big, simple, phone first
    async form(c, after) {
        var _a;
        const m = await EX.getMeta(true);
        c = c || {};
        let pay = c.paid_from || store.get('ex_last_pay', 'petty'), receipt = c.receipt || null, busy = false;
        const amt = h('input', { type: 'number', inputmode: 'decimal', class: 'ex-amt', placeholder: 'Rs 0', value: (_a = c.amount) !== null && _a !== void 0 ? _a : '', min: 0 });
        const cat = h('select', null, h('option', { value: '' }, '— choose —'), m.categories.map(k => h('option', { value: k.id, selected: +c.category_id === k.id }, k.name)));
        const dayI = h('input', { type: 'date', value: c.day || m.today, max: m.today });
        const vendor = h('input', { placeholder: 'e.g. Imtiaz, Daraz, rickshaw', value: c.vendor || '', list: 'ex-vendors' });
        const note = h('textarea', { placeholder: 'What was it for?', rows: 2 }, c.note || '');
        const boxSel = h('select', null, m.boxes.map(b => h('option', { value: b.id, selected: (c.box_id || m.myBoxes[0]) === b.id }, b.name + ' box' + (b.custodian_name ? ' · ' + b.custodian_name : ''))));
        const boxF = field('Which cash box?', boxSel);
        const chips = h('div', { class: 'ex-chips' });
        const drawChips = () => { chips.replaceChildren(...Object.entries(m.pay).map(([k, l]) => h('button', { type: 'button', class: 'btn ' + (k === pay ? 'primary' : 'ghost'), onclick: () => { pay = k; drawChips(); } }, l))); boxF.hidden = pay !== 'petty' || m.boxes.length < 2; };
        drawChips();
        const file = h('input', { type: 'file', accept: 'image/*,application/pdf', capture: 'environment' });
        const thumb = h('div', { class: 'row' });
        const drawThumb = () => thumb.replaceChildren(...[receipt ? h('a', { href: '/api/files/' + receipt, target: '_blank' }, h('img', { class: 'ex-thumb', src: '/api/files/' + receipt, alt: 'Receipt', onerror: e => e.target.replaceWith(h('span', { class: 'b info' }, 'File attached')) })) : null,
            receipt ? h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { receipt = null; file.value = ''; drawThumb(); } }, 'Remove') : null].filter(Boolean));
        drawThumb();
        file.addEventListener('change', async () => { if (!file.files[0])
            return; try {
            busy = true;
            thumb.replaceChildren(h('span', { class: 'spin' }), ' Uploading…');
            receipt = await uploadFile(file.files[0]);
        }
        catch (e) {
            toast(e.message, true);
        }
        finally {
            busy = false;
            drawThumb();
        } });
        const rHint = h('div', { class: 'small muted' });
        const hint = () => { const need = (+amt.value || 0) > m.limit; rHint.textContent = need ? `Receipt photo is required above ${rs(m.limit)}.` : `Receipt optional up to ${rs(m.limit)} — but please attach if you have one.`; rHint.style.color = need && !receipt ? 'var(--bad)' : ''; };
        amt.addEventListener('input', hint);
        hint();
        const err = h('div', { class: 'flash bad', hidden: true });
        const save = async () => {
            if (busy)
                return toast('Wait for the photo to finish uploading', true);
            const body = { amount: amt.value, category_id: cat.value, day: dayI.value, paid_from: pay, box_id: pay === 'petty' ? +boxSel.value : null, vendor: vendor.value, note: note.value, receipt };
            try {
                await (c.id ? POST('/api/exp/claims/' + c.id, body) : POST('/api/exp/claims', body));
                store.set('ex_last_pay', pay);
                mm.remove();
                toast(c.id ? 'Saved' : 'Expense sent for approval');
                (after || route)();
            }
            catch (e) {
                err.hidden = false;
                err.textContent = e.message;
                err.scrollIntoView({ block: 'nearest' });
            }
        };
        const mm = modal(c.id ? 'Edit expense' : 'Add expense', h('div', { class: 'grid' }, err, field('Amount (Rs) *', amt), field('Category *', cat), field('Paid from *', chips), boxF, h('div', { class: 'fgrid' }, field('Date', dayI), field('Shop / vendor', vendor)), field('Note', note), field('Receipt photo', h('div', { class: 'grid', style: { gap: '6px' } }, file, rHint, thumb)), h('datalist', { id: 'ex-vendors' }, (EX.vendors || []).map(v => h('option', { value: v })))), [h('button', { class: 'btn primary big', onclick: save }, c.id ? 'Save' : 'Submit expense')]);
        if (!c.id)
            setTimeout(() => amt.focus(), 50);
    },
};
/* My expenses — every staff member */
registerView({ key: 'expenses', title: 'My expenses', group: 'Finance', perm: 'expenses', icon: 'receipt', order: 80 }, async (args) => {
    const [d, m, boxes] = await Promise.all([GET('/api/exp/mine'), EX.getMeta(true), GET('/api/exp/boxes')]);
    EX.vendors = [...new Set(d.rows.map(r => r.vendor).filter(Boolean))].slice(0, 30);
    let f = args[0] || 'all';
    const rows = d.rows.filter(r => f === 'all' || (f === 'owed' ? r.status === 'approved' && r.paid_from === 'own' && !r.reimbursed : r.status === f));
    const myBox = boxes.filter(b => m.myBoxes.includes(b.id));
    exRender(pageHead('My expenses', 'Every rupee you spend for the office — add it here with a receipt photo.', h('button', { class: 'btn primary big', onclick: () => EX.form() }, '+ Add expense')), h('div', { class: 'kpis ex-kpis' }, kpi('Waiting for approval', rs(d.totals.pending), null, d.totals.pending ? 'warn' : ''), kpi('Owed to you', rs(d.totals.owed), 'your own money, approved, not paid back yet', d.totals.owed ? 'alert' : ''), kpi('This month', rs(d.totals.month), 'not counting rejected')), myBox.length ? h('div', { class: 'note' }, 'You keep the ', myBox.map(b => b.name).join(' & '), ' petty cash box. ', myBox.map(b => h('a', { href: '#/pettybox/' + b.id, style: { fontWeight: 600 } }, 'Open ' + b.name + ' box (' + rs(b.balance) + ')')), ' ') : null, h('div', { class: 'card' }, tabs([['all', 'All', d.rows.length], ['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected', d.rows.filter(r => r.status === 'rejected').length || null], ['owed', 'To be paid back']], f, k => { location.hash = '#/expenses/' + k; }), rows.length ? h('div', { class: 'ex-list' }, rows.map(r => EX.row(r))) : h('div', { class: 'empty' }, f === 'all' ? 'No expenses yet. Tap "Add expense" when you spend money for the office.' : 'Nothing here.')));
});
/* Custodian's own petty cash box (hidden view: reached from My expenses / My day / alerts) */
registerView({ key: 'pettybox', title: 'My cash box', group: 'Finance', perm: 'expenses', icon: 'cash', hidden: true }, async (args) => exBoxView(+args[0], '#/pettybox/'));
registerMeCard({ key: 'expenses', order: 40, perm: 'expenses' }, async () => {
    const d = await GET('/api/exp/mine?limit=4');
    return h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'My expenses'), h('button', { class: 'btn primary', onclick: () => EX.form(null, () => route()) }, '+ Add expense')), (d.totals.pending || d.totals.owed) ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, d.totals.pending ? 'Waiting ' + rs(d.totals.pending) : '', d.totals.pending && d.totals.owed ? ' · ' : '', d.totals.owed ? 'Owed to you ' + rs(d.totals.owed) : '') : null, d.rows.length ? h('div', { class: 'ex-list' }, d.rows.map(r => EX.row(r, { onOpen: c => EX.open(c, () => route()) }))) : h('div', { class: 'muted small', style: { padding: '10px 0' } }, 'Spent money for the office? Add it here with a photo of the receipt.'), d.rows.length ? h('a', { class: 'small', href: '#/expenses' }, 'See all my expenses →') : null);
});
function exRender(...k) { render(...k.flat(Infinity).filter(x => x != null && x !== false)); }
/* ---------- reports ---------- */
VIEWS.reports = async () => {
    let days = 30;
    const load = async () => {
        const r = await GET('/api/reports?days=' + days);
        const k = r.kpi, rate = (d, x) => d + x ? Math.round(100 * d / (d + x)) : null;
        const rateCell = (d, x) => { const v = rate(d, x); return v == null ? '–' : h('div', { class: 'row', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } }, bar(v), h('span', { class: 'small', style: { width: '36px', textAlign: 'right', color: v < 70 ? 'var(--bad)' : '' } }, v + '%')); };
        const groupTable = (rows, unit) => table([{ t: 'Name', f: x => x.name || x.city || x.label }, { t: unit || 'Orders', n: 1, f: x => { var _a; return num((_a = x.orders) !== null && _a !== void 0 ? _a : x.units); } },
            { t: 'Value', n: 1, f: x => { var _a; return x.value == null && x.revenue == null ? '–' : rs((_a = x.value) !== null && _a !== void 0 ? _a : x.revenue); } }, { t: 'Delivery success', n: 1, f: x => rateCell(x.delivered, x.returned) }], rows);
        r.daily.forEach(d => d.open = Math.max(0, d.orders - d.delivered - d.returned - d.cancelled));
        render(h('div', { class: 'row' }, [7, 30, 90].map(d => h('button', { class: 'btn sm ' + (d === days ? '' : 'ghost'), onclick: () => { days = d; load(); } }, d + ' days'))), h('div', { class: 'kpis' }, kpi('Orders', num(k.orders), rs(k.value)), kpi('Average order', rs(k.aov)), kpi('Delivery rate', rate(k.delivered, k.returned) == null ? '–' : rate(k.delivered, k.returned) + '%', `${num(k.delivered)} delivered · ${num(k.returned)} returned`), kpi('Cancelled', num(k.cancelled), pct(k.cancelled, k.orders) + ' of orders'), kpi('Customers', num(k.customers), num(r.repeat) + ' ordered more than once')), h('div', { class: 'card' }, h('h2', null, 'Orders per day'), chart(r.daily, 'day', [{ k: 'delivered', l: 'Delivered', c: C1 }, { k: 'returned', l: 'Returned', c: C2 }, { k: 'cancelled', l: 'Cancelled', c: C4 }, { k: 'open', l: 'Still open', c: C3 }], 200)), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Cities', h('small', null, 'where parcels come back')), groupTable(r.city)), h('div', { class: 'card' }, h('h2', null, 'Customer type'), groupTable(r.labels.map(x => (Object.assign(Object.assign({}, x), { name: x.label })))), h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'If "New" and "Risky" customers return far more, keep confirmation calls for them.'))), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Brands'), groupTable(r.brand, 'Units')), h('div', { class: 'card' }, h('h2', null, 'Product types'), groupTable(r.ptype, 'Units'))), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Orders by hour', h('small', null, 'Pakistan time')), chart(r.hours.map(x => (Object.assign(Object.assign({}, x), { hour: '0000-' + String(x.hour).padStart(2, '0') }))), 'hour', [{ k: 'orders', l: 'Orders', c: C1 }], 150)), h('div', { class: 'card' }, h('h2', null, 'Stock age'), table([{ t: 'On site for', k: 'bucket' }, { t: 'Items', n: 1, f: x => num(x.items) }, { t: 'Price value', n: 1, f: x => rs(x.value) }, { t: 'Cost', n: 1, f: x => rs(x.cost) }], r.aging))));
        r.daily.forEach(d => d.open = Math.max(0, d.orders - d.delivered - d.returned - d.cancelled));
    };
    await load();
};
registerView({ key: 'reports', title: 'Sales reports', group: 'Overview', perm: 'reports', icon: 'chart', order: 4 }, VIEWS.reports);
/* ---------- Marketing: Meta ad spend, cost per order, ROAS, campaigns, other spend ---------- */
const MK = {
    x: v => v == null ? '–' : (+v).toFixed(2).replace(/\.?0+$/, '') + '×',
    pc: v => v == null ? '–' : v + '%',
    periods: [['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['month', 'This month']],
    explain: (t, ...k) => h('div', { class: 'small muted', style: { marginTop: '4px' } }, t, ...k),
};
// spend bars + orders line, two scales
MK.chart = (data) => {
    if (!data.length)
        return h('div', { class: 'empty' }, 'No data yet.');
    const W = 720, H = 190, L = 44, R = 30, bw = (W - L - R) / data.length, ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
    svg.setAttribute('class', 'chart');
    const mk = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const k in a)
        e.setAttribute(k, a[k]); if (txt != null)
        e.textContent = txt; svg.append(e); return e; };
    const ms = Math.max(1, ...data.map(d => d.spend)), mo = Math.max(1, ...data.map(d => d.orders)), y = (v, m) => H - (H - 12) * v / m;
    const kfmt = v => v >= 1e5 ? (v / 1e5).toFixed(1).replace(/\.0$/, '') + 'L' : v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v);
    for (let g = 0; g <= 2; g++) {
        const yy = y(ms * g / 2, ms);
        mk('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: 'currentColor', 'stroke-opacity': .1 });
        mk('text', { x: L - 6, y: yy + 4, 'text-anchor': 'end' }, kfmt(ms * g / 2));
        mk('text', { x: W - R + 6, y: yy + 4 }, Math.round(mo * g / 2));
    }
    const pts = [];
    data.forEach((d, i) => {
        const x = L + i * bw, hh = H - y(d.spend, ms);
        const r = mk('rect', { x: x + bw * 0.15, y: H - hh, width: bw * 0.7, height: Math.max(0, hh), fill: C3, rx: 2 });
        const tt = document.createElementNS(ns, 'title');
        tt.textContent = `${d.day}: spend ${rs(d.spend)} · ${d.orders} orders · cost/order ${rs(d.cpo)}`;
        r.append(tt);
        pts.push(`${x + bw / 2},${y(d.orders, mo)}`);
        if (i % Math.ceil(data.length / 10) === 0)
            mk('text', { x: x + bw / 2, y: H + 16, 'text-anchor': 'middle' }, day(d.day));
    });
    mk('polyline', { points: pts.join(' '), fill: 'none', stroke: C2, 'stroke-width': 2.2, 'stroke-linejoin': 'round' });
    data.forEach((d, i) => mk('circle', { cx: L + i * bw + bw / 2, cy: y(d.orders, mo), r: 2.6, fill: C2 }));
    return h('div', null, svg, h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: C3 } }), 'Ad spend (left, Rs)'), h('span', null, h('i', { style: { background: C2 } }), 'Orders (right)')));
};
MK.flag = r => h('span', { class: 'b ' + ({ bad: 'bad', warn: 'warn', good: 'ok', muted: '' }[r.flag] || 'info') }, r.why);
MK.status = (d) => {
    const st = d.status || {};
    if (!d.connected)
        return null;
    const bad = st.lastError && (!st.lastOk || st.lastErrorAt > st.lastOk);
    return h('div', { class: 'note ' + (bad ? 'bad' : '') }, bad ? ['Meta sync problem: ', st.lastError] : ['Meta spend synced ', ago(st.lastOk), st.lastMsg ? ' · ' + st.lastMsg : '', '. Updates every 3 hours; the last 3 days are refreshed because Meta finalises numbers late.']);
};
MK.syncBtn = (label, days, after) => h('button', { class: 'btn ' + (days > 3 ? 'ghost' : ''), onclick: async (e) => {
        e.target.disabled = true;
        const old = e.target.textContent;
        e.target.textContent = 'Syncing…';
        try {
            const r = await act(() => POST('/api/marketing/sync', { days }), null);
            toast(`Synced ${r.rows} campaign-days`);
            after && after();
        }
        catch (_a) { }
        finally {
            e.target.disabled = false;
            e.target.textContent = old;
        }
    } }, label);
MK.manualForm = (after, date, amount) => formModal('Daily ad spend', [
    { k: 'date', label: 'Date', type: 'date', value: date || todayStr(), required: true },
    { k: 'amount', label: 'Amount charged (Rs)', type: 'number', value: amount, required: true, placeholder: 'e.g. 75000' },
    { k: 'note', label: 'Note', placeholder: 'e.g. from bank SMS / Ads Manager', full: true },
], v => act(() => POST('/api/marketing/manual', v), 'Saved').then(after));
MK.guide = () => h('ol', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '20px', lineHeight: 1.7 } }, h('li', null, 'Open ', h('b', null, 'business.facebook.com → Business Settings'), ' (Meta Business Suite → Settings).'), h('li', null, 'Go to ', h('b', null, 'Users → System users'), ' and click ', h('b', null, 'Add'), '. Name it "SundayBazar ERP", role ', h('b', null, 'Employee'), ' is enough.'), h('li', null, 'Click ', h('b', null, 'Assign assets → Ad accounts'), ', pick your ad account and give ', h('b', null, 'View performance'), '.'), h('li', null, 'Click ', h('b', null, 'Generate new token'), ', choose your app, expiry ', h('b', null, 'Never'), ', tick ', h('b', null, 'ads_read'), ', and copy the token.'), h('li', null, 'Your ad account id is in Ads Manager (URL shows ', h('span', { class: 'mono' }, 'act=1234567890'), '). Enter it as ', h('span', { class: 'mono' }, 'act_1234567890'), '.'), h('li', null, 'Paste both below, press ', h('b', null, 'Test connection'), ', then ', h('b', null, 'Save'), ' and ', h('b', null, 'Backfill 90 days'), '.'));
registerView({ key: 'marketing', title: 'Marketing', group: 'Marketing', perm: 'marketing', icon: 'megaphone', order: 10 }, async (args) => {
    const tab = args[0] || 'overview';
    const d = await GET('/api/marketing/dashboard');
    const go = k => location.hash = '#/marketing' + (k === 'overview' ? '' : '/' + k);
    const tabList = [['overview', 'Overview'], ['monthly', 'Monthly']];
    if (d.canSettings)
        tabList.push(['settings', 'Settings']);
    const head = pageHead('Marketing', 'What Meta ads cost and what they really bring back', d.connected ? MK.syncBtn('Sync now', 3, () => route()) : h('button', { class: 'btn', onclick: () => MK.manualForm(() => route()) }, 'Enter today\'s spend'));
    const tb = tabs(tabList, tab, go);
    if (tab === 'settings' && d.canSettings)
        return render(head, tb, await MK.settings());
    if (tab === 'monthly') {
        const rows = await GET('/api/marketing/monthly');
        return render(head, tb, h('div', { class: 'card' }, h('h2', null, 'Month by month'), MK.explain('Delivered and sales are for parcels sent in that month. "Other" is influencers, photoshoots, printing etc. "Paid" is money actually paid to Meta (card charges / top-ups).'), table([{ t: 'Month', f: r => h('b', { style: { whiteSpace: 'nowrap' } }, new Date(r.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })) }, { t: 'Ad spend', n: 1, f: r => rs(r.spend) }, { t: 'Other', n: 1, f: r => rs(r.other) }, { t: 'Orders', n: 1, f: r => num(r.orders) }, { t: 'Cost / order', n: 1, f: r => rs(r.cpo) },
            { t: 'Delivered', n: 1, f: r => num(r.delivered) }, { t: 'Delivery rate', n: 1, f: r => MK.pc(r.deliveryRate) }, { t: 'Cost / delivered', n: 1, f: r => rs(r.cpd) },
            { t: 'Net delivered sales', n: 1, f: r => rs(r.netSales) }, { t: 'ROAS', n: 1, f: r => h('b', { class: r.roas != null && r.roas < 1 ? 'neg' : '' }, MK.x(r.roas)) }, { t: 'Paid to Meta', n: 1, f: r => rs(r.paid) }], rows)));
    }
    const per = store.get('mk_period', 'today'), p = d.periods[per] || d.periods.today, avg = d.avg30;
    const out = [head, tb];
    if (!d.connected)
        out.push(h('div', { class: 'card' }, h('h2', null, 'Connect Meta ads', h('small', null, 'one-time setup, 10 minutes')), h('div', { class: 'muted small' }, 'Once connected, the money Meta charges every day comes into the ERP by itself. Until then, enter the daily amount by hand.'), d.canSettings ? MK.guide() : h('div', { class: 'note', style: { marginTop: '8px' } }, 'Ask the owner to connect the Meta ad account in Marketing → Settings.'), h('div', { class: 'row', style: { marginTop: '12px' } }, d.canSettings ? h('a', { class: 'btn', href: '#/marketing/settings' }, 'Open settings') : null, h('button', { class: 'btn ghost', onclick: () => MK.manualForm(() => route()) }, 'Enter daily spend by hand'))));
    else
        out.push(MK.status(d));
    const cpoBad = p.cpo && avg.cpo && p.cpo > avg.cpo * 1.5, roasCls = p.roas == null ? '' : p.roas < 1 ? 'alert' : p.roas >= 3 ? 'good' : '';
    out.push(h('div', { class: 'row' }, MK.periods.map(([k, l]) => h('button', { class: 'btn sm ' + (k === per ? '' : 'ghost'), onclick: () => { store.set('mk_period', k); route(); } }, l)), h('span', { class: 'small muted' }, p.from === p.to ? day(p.from) : day(p.from) + ' – ' + day(p.to))));
    out.push(h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(min(230px,45%),1fr))' } }, kpi('Ad spend', rs(p.spend), 'What Meta charged, in rupees incl. card charges' + (p.manual ? ' · ' + rs(p.manual) + ' entered by hand' : '')), kpi('Orders placed', num(p.orders), 'New store orders, cancelled not counted'), kpi('Cost per order', rs(p.cpo), `Ad spend ÷ orders. 30-day average ${rs(avg.cpo)}`, cpoBad ? 'alert' : ''), kpi('Delivered', num(p.delivered), `Of ${num(p.dispatched)} parcels sent in this period` + (p.deliveryRate != null ? ` · delivery rate ${MK.pc(p.deliveryRate)}` : '') + (p.pending ? ` · ${num(p.pending)} still on the way` : '')), kpi('Cost per delivered order', rs(p.cpd), 'Ad spend ÷ delivered parcels: the real cost of one sale'), kpi('Net delivered sales', rs(p.netSales), 'Money from those delivered parcels, without delivery charge'), kpi('ROAS', MK.x(p.roas), p.roas == null && p.spend ? 'Not known yet: no parcel from this period has been delivered or returned' : 'Net delivered sales ÷ ad spend. 3× = Rs 3 back for every Rs 1', roasCls), kpi('Meta purchases vs real orders', `${num(p.metaPurchases)} vs ${num(p.orders)}`, p.gap > 0 ? `Meta claims ${num(p.gap)} more than really came. Trust real orders.` : 'Meta\'s own count. Real orders are what matter.')));
    const metric = (l, f, hint) => ({ l, f, hint });
    const rowsM = [metric('Ad spend', x => rs(x.spend)), metric('Orders', x => num(x.orders)), metric('Cost per order', x => rs(x.cpo)), metric('Delivered', x => num(x.delivered)),
        metric('Delivery rate', x => MK.pc(x.deliveryRate)), metric('Cost per delivered', x => rs(x.cpd)), metric('Net delivered sales', x => rs(x.netSales)), metric('ROAS', x => MK.x(x.roas)), metric('Meta purchases', x => num(x.metaPurchases))];
    out.push(h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Spend vs orders', h('small', null, 'last 30 days')), MK.chart(d.daily), MK.explain('When the green bars grow but the orange line does not, ads are getting more expensive.')), h('div', { class: 'card' }, h('h2', null, 'Side by side'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, ''), MK.periods.map(([, l]) => h('th', { class: 'n' }, l)))), h('tbody', null, rowsM.map(m => h('tr', null, h('td', { class: 'muted' }, m.l), MK.periods.map(([k]) => h('td', { class: 'n' }, m.f(d.periods[k])))))))), MK.explain('Delivered numbers for today are usually 0: parcels sent today are not delivered yet. Look at last 7 days or the month.'))));
    out.push(h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Campaigns', h('small', null, 'last 7 days')), h('a', { class: 'btn ghost sm', href: '#/campaigns' }, 'All campaigns')), d.top.length ? MK.campTable(d.top) : h('div', { class: 'empty' }, d.connected ? 'No campaign data yet. Press Sync now.' : 'Campaign details appear after Meta is connected.')));
    render(out.filter(Boolean));
});
MK.campTable = rows => table([
    { t: 'Campaign', f: r => h('div', null, h('div', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'small muted' }, r.account_id)) },
    { t: 'Spend', n: 1, f: r => rs(r.spend) }, { t: 'Impressions', n: 1, f: r => num(r.impressions) }, { t: 'CTR', n: 1, f: r => MK.pc(r.ctr) },
    { t: 'Purchases', n: 1, f: r => num(r.purchases) }, { t: 'Cost / purchase', n: 1, f: r => rs(r.cpp) }, { t: 'Meta ROAS', n: 1, f: r => MK.x(r.metaRoas) }, { t: 'Status', f: MK.flag }
], rows);
registerView({ key: 'campaigns', title: 'Campaigns', group: 'Marketing', perm: 'marketing', icon: 'chart', order: 20 }, async () => {
    const rng = store.get('mk_camp', '7');
    const d = await GET('/api/marketing/campaigns?' + (rng === 'mtd' ? 'range=mtd' : 'days=' + rng));
    const t = d.totals;
    render(pageHead('Campaigns', `${day(d.from)} – ${day(d.to)}`, h('button', { class: 'btn ghost', onclick: () => csvDownload(`campaigns-${d.from}-${d.to}.csv`, d.rows.map(r => ({ campaign: r.name, account: r.account_id, spend_pkr: r.spend, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, purchases: r.purchases, cost_per_purchase: r.cpp, meta_roas: r.metaRoas, status: r.why }))) }, 'Download CSV')), h('div', { class: 'row' }, [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['mtd', 'This month']].map(([k, l]) => h('button', { class: 'btn sm ' + (k === rng ? '' : 'ghost'), onclick: () => { store.set('mk_camp', k); route(); } }, l))), h('div', { class: 'kpis' }, kpi('Ad spend', rs(t.spend)), kpi('Meta purchases', num(t.metaPurchases), 'What Meta counted'), kpi('Real orders', num(t.orders), 'From the store, same days'), kpi('Click rate (CTR)', t.impressions ? (Math.round(10000 * t.clicks / t.impressions) / 100) + '%' : '–', 'Of people who saw an ad, how many clicked')), h('div', { class: 'card' }, h('h2', null, 'Each campaign'), MK.explain(`Spend is in rupees incl. card charges. "Cost / purchase" and "Meta ROAS" use Meta's own purchase count, which is often higher than real orders: use them to compare campaigns with each other, not as profit. Red = spent over ${rs(d.threshold)} in 3 days with no purchase; amber = cost per purchase 1.5× the average; green = cheapest sales.`), MK.campTable(d.rows)));
});
registerView({ key: 'mkt-spend', title: 'Marketing spend', group: 'Marketing', perm: 'marketing', icon: 'wallet', order: 30 }, async (args) => {
    const month = args[0] || monthStr();
    const d = await GET('/api/marketing/spend?month=' + month);
    const reload = () => route();
    const bankOpts = d.banks.map(b => [b, b]);
    const payForm = () => formModal('Meta card charge / top-up', [
        { k: 'date', label: 'Date', type: 'date', value: todayStr(), required: true }, { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true },
        { k: 'bank', label: 'Paid from', type: 'select', options: bankOpts, value: 'Meezan (SB)' }, { k: 'file', label: 'Receipt / bank SMS screenshot', type: 'file' },
        { k: 'note', label: 'Note', full: true, placeholder: 'e.g. card charge ending 4411' }
    ], v => act(() => POST('/api/marketing/payment', v), 'Payment recorded').then(reload));
    const otherForm = () => formModal('Other marketing spend', [
        { k: 'date', label: 'Date', type: 'date', value: todayStr(), required: true }, { k: 'category', label: 'What for', type: 'select', options: d.cats },
        { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'bank', label: 'Paid from', type: 'select', options: bankOpts, value: 'Cash' },
        { k: 'file', label: 'Receipt / invoice', type: 'file' }, { k: 'note', label: 'Details', full: true, placeholder: 'e.g. @name Instagram reel, 2 posts' }
    ], v => act(() => POST('/api/marketing/other', v), 'Saved').then(reload));
    const posted = Object.fromEntries(d.posted.map(p => [p.date, p])), manual = Object.fromEntries(d.manual.map(m => [m.date, m])), meta = Object.fromEntries(d.meta.map(m => [m.date, m.spend]));
    const days = [...new Set([...Object.keys(manual), ...Object.keys(meta)])].sort().reverse().map(dd => ({ date: dd, meta: meta[dd] || 0, manual: manual[dd], post: posted[dd] }));
    const postB = (ok, err) => !d.accountsReady && !ok ? h('span', { class: 'b', title: 'Will be posted when the accounts book is switched on' }, 'Waiting') : ok ? h('span', { class: 'b ok' }, 'In accounts') : err ? h('span', { class: 'b warn', title: err }, 'Not posted') : h('span', { class: 'b' }, '–');
    const shift = n => { const [y, m] = month.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1 + n, 1)); return dt.toISOString().slice(0, 7); };
    const totalMeta = days.reduce((s, x) => s + x.meta + (x.manual ? x.manual.amount : 0), 0), other = d.entries.filter(e => e.kind === 'other'), pays = d.entries.filter(e => e.kind === 'payment');
    render(pageHead('Marketing spend', 'Daily ad spend, Meta card payments, and other marketing costs', h('button', { class: 'btn', onclick: () => MK.manualForm(reload) }, 'Daily ad spend'), h('button', { class: 'btn ghost', onclick: payForm }, 'Meta payment'), h('button', { class: 'btn ghost', onclick: otherForm }, 'Other spend')), h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => location.hash = '#/mkt-spend/' + shift(-1) }, '‹'), h('strong', null, new Date(month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })), h('button', { class: 'btn ghost sm', disabled: month >= monthStr(), onclick: () => location.hash = '#/mkt-spend/' + shift(1) }, '›')), !d.accountsReady ? h('div', { class: 'note warn' }, 'The accounts book is not switched on yet. Entries are saved here and will be posted to accounts automatically once it is.') : '', h('div', { class: 'kpis' }, kpi('Ad spend', rs(totalMeta), d.connected ? 'From Meta + any hand entries' : 'Entered by hand'), kpi('Paid to Meta', rs(pays.reduce((s, e) => s + e.amount, 0)), 'Card charges / top-ups'), kpi('Other marketing', rs(other.reduce((s, e) => s + e.amount, 0)), 'Influencers, shoots, printing…'), kpi('Still owed to Meta (this month)', rs(totalMeta - pays.reduce((s, e) => s + e.amount, 0)), 'Spend minus payments')), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Daily ad spend'), MK.explain(d.connected ? 'Comes from Meta automatically. Only add a hand entry for a day Meta could not sync.' : 'Meta is not connected: enter what Meta charged each day (Ads Manager → Billing, or the bank SMS).'), table([{ t: 'Date', f: x => h('span', { style: { whiteSpace: 'nowrap' } }, day(x.date)) }, { t: 'From Meta', n: 1, f: x => x.meta ? rs(x.meta) : '–' }, { t: 'By hand', n: 1, f: x => x.manual ? h('span', { title: x.manual.note || '' }, rs(x.manual.amount)) : '–' },
        { t: 'Accounts', f: x => d.post ? postB(x.post && !x.post.error, x.post && x.post.error) : h('span', { class: 'small muted' }, 'off') },
        { t: '', f: x => x.manual ? h('div', { class: 'row', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } }, h('button', { class: 'btn ghost sm', onclick: () => MK.manualForm(reload, x.date, x.manual.amount) }, 'Edit'), h('button', { class: 'btn ghost sm', onclick: () => confirm('Delete the hand entry for ' + x.date + '?') && act(() => api('DELETE', '/api/marketing/manual/' + x.date), 'Deleted').then(reload) }, 'Delete')) : null }], days)), h('div', { class: 'card' }, h('h2', null, 'Payments & other spend'), MK.explain('Meta payment = money that left the bank for Meta. Other spend = influencers, photoshoots, boosted posts, printing.'), table([{ t: 'Date', f: e => h('span', { style: { whiteSpace: 'nowrap' } }, day(e.date)) }, { t: 'What', f: e => h('div', null, h('span', { class: 'b ' + (e.kind === 'payment' ? 'info' : 'accent') }, e.category), e.note ? h('div', { class: 'small muted' }, e.note) : null) },
        { t: 'From', f: e => h('span', { class: 'small', style: { whiteSpace: 'nowrap' } }, e.bank) }, { t: 'Amount', n: 1, f: e => rs(e.amount) }, { t: 'Accounts', f: e => postB(e.posted, e.error) },
        { t: '', f: e => h('div', { class: 'row', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } }, fileLink(e.file_id), h('button', { class: 'btn ghost sm', onclick: () => confirm('Delete this entry?') && act(() => api('DELETE', '/api/marketing/entry/' + e.id), 'Deleted').then(reload) }, 'Delete')) }], d.entries))));
});
MK.settings = async () => {
    const { settings: s, status: st, banks, accountsReady } = await GET('/api/marketing/settings');
    const log = await GET('/api/marketing/status');
    const tok = h('input', { type: 'password', placeholder: s.hasToken ? `Saved (${s.tokenHint}). Paste a new one to replace` : 'EAAG… system user token', autocomplete: 'off' });
    const accs = h('input', { value: s.accounts.join(', '), placeholder: 'act_1234567890' }), ver = h('input', { value: s.version });
    const fx = h('input', { type: 'number', step: 'any', value: s.fx }), card = h('input', { type: 'number', step: 'any', value: s.cardPct });
    const ovr = {};
    const acctTable = (s.accountInfo || []).length ? table([
        { t: 'Ad account', f: a => h('div', null, h('div', { style: { fontWeight: 600 } }, a.name || 'Not checked yet'), h('div', { class: 'small muted mono' }, a.id)) },
        { t: 'Meta says', f: a => a.currency ? h('span', { class: 'b ' + (a.currency === 'PKR' ? '' : 'info') }, a.currency) : h('span', { class: 'small muted' }, '?') },
        { t: 'Status', f: a => a.status ? h('span', { class: 'b ' + (a.status === 'Active' ? 'ok' : 'warn') }, a.status) : '–' },
        { t: 'Use currency', f: a => { const sel = h('select', { style: { width: 'auto' } }, [['', 'Auto' + (a.currency ? ' (' + a.currency + ')' : '')], ['PKR', 'PKR'], ['USD', 'USD']].map(([v, l]) => h('option', { value: v, selected: (a.override || '') === v }, l))); sel.onchange = () => ovr[a.id] = sel.value; return sel; } },
        { t: 'Rs per 1 unit', n: 1, f: a => a.used === 'PKR' ? '1' : (+a.rate).toFixed(2) }
    ], s.accountInfo) : null;
    const post = h('input', { type: 'checkbox', checked: s.post }), credit = h('input', { value: s.creditAccount }), postFrom = h('input', { type: 'date', value: s.postFrom || '' });
    const budget = h('input', { type: 'number', value: s.dailyBudget || '', placeholder: '0 = no alert' }), thr = h('input', { type: 'number', value: s.zeroThreshold });
    const res = h('div');
    const body = () => ({ token: tok.value.trim() || undefined, accounts: accs.value, version: ver.value.trim(), overrides: ovr, fx: fx.value, cardPct: card.value, post: post.checked, creditAccount: credit.value, postFrom: postFrom.value, dailyBudget: budget.value || 0, zeroThreshold: thr.value });
    const test = async () => {
        res.replaceChildren(h('div', { class: 'note' }, 'Checking…'));
        try {
            const r = await POST('/api/marketing/test', { token: tok.value.trim() || undefined, accounts: accs.value });
            res.replaceChildren(h('div', { class: 'note ok' }, 'Connected: ', r.accounts.map(a => `${a.name} (${a.id}, ${a.currency}, ${a.status})`).join(' · '), h('div', { class: 'small' }, 'Press Save to keep these accounts.')));
        }
        catch (e) {
            res.replaceChildren(h('div', { class: 'note bad' }, e.message));
        }
    };
    const save = () => act(() => POST('/api/marketing/settings', body()), 'Saved').then(() => route());
    const lastBad = st.lastError && (!st.lastOk || st.lastErrorAt > st.lastOk);
    return [
        h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Meta ad account'), MK.guide(), h('div', { class: 'fgrid', style: { marginTop: '14px' } }, h('label', { class: 'f full' }, 'Access token (System User, ads_read)', tok), h('label', { class: 'f full' }, 'Ad account id(s), comma separated', accs), field('Graph API version', ver)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn ghost', onclick: test }, 'Test connection'), h('button', { class: 'btn', onclick: save }, 'Save')), h('div', { style: { marginTop: '10px' } }, res)), h('div', { class: 'card' }, h('h2', null, 'Money & accounts'), h('div', { class: 'fgrid' }, field('1 USD = Rs', fx), field('Extra card charges % (USD accounts)', card)), MK.explain('Each ad account uses its own currency (read from Meta on every sync). PKR accounts are counted as-is. USD accounts are billed on a foreign card, so the bank adds FX and tax: 1 USD = Rs 280 and 5% charges → $10 = Rs 2,940.'), h('label', { class: 'row', style: { marginTop: '14px' } }, post, 'Post daily ad spend to accounts'), h('div', { class: 'fgrid', style: { marginTop: '8px' } }, field('Credit account', credit), field('Post from date', postFrom)), MK.explain('Each day: Dr Social Media Marketing, Cr ' + (s.creditAccount || 'Meta Ads Payable') + '. Record card charges in Marketing spend → Meta payment.', accountsReady ? '' : ' (Accounts book not switched on yet: postings wait until it is.)'), h('div', { class: 'fgrid', style: { marginTop: '14px' } }, field('Daily budget alert (Rs)', budget), field('No-sale alert after (Rs, 3 days)', thr)), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: save }, 'Save')))),
        acctTable ? h('div', { class: 'card' }, h('h2', null, 'Ad accounts', h('small', null, 'currency and status from Meta')), acctTable, MK.explain('Change "Use currency" only if Meta reports it wrongly, then press Save. Past days are recalculated on the next sync or backfill.'), h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: save }, 'Save'))) : null,
        h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', { style: { margin: 0 } }, 'Sync'), h('div', { class: 'row' }, log.connected ? [MK.syncBtn('Sync last 3 days', 3, () => route()), MK.syncBtn('Backfill 90 days', 90, () => route())] : h('span', { class: 'small muted' }, 'Save a token and ad account first'))), h('div', { class: 'dl', style: { margin: '10px 0' } }, h('dt', null, 'Last good sync'), h('dd', null, st.lastOk ? ago(st.lastOk) + (st.lastMsg ? ' · ' + st.lastMsg : '') : 'never'), h('dt', null, 'Newest data'), h('dd', null, log.lastData && log.lastData.d ? day(log.lastData.d) : '–'), h('dt', null, 'Last error'), h('dd', { class: lastBad ? 'neg' : 'muted' }, lastBad ? st.lastError : 'none')), table([{ t: 'When', f: x => dt(x.at) }, { t: 'Result', f: x => h('span', { class: 'b ' + (x.ok ? 'ok' : 'bad') }, x.ok ? 'ok' : 'error') }, { t: 'Details', f: x => h('span', { class: 'small' }, x.message) }], log.log)),
    ].filter(Boolean);
};
/* ---------- HR: attendance (daily view, monthly register, holidays, settings) ---------- */
async function hrSettingsModal() {
    const s = await GET('/api/hr/settings');
    const ips = h('input', { value: (s.allowed_ips || []).join(', '), placeholder: 'empty = check-in allowed from anywhere' });
    const per = h('input', { type: 'number', value: s.late_rule.per, min: 1, style: { width: '70px' } }), days = h('input', { type: 'number', value: s.late_rule.days, step: '0.5', min: 0, style: { width: '70px' } });
    const alertMin = h('input', { type: 'number', value: s.absent_alert_min }), company = h('input', { value: s.company || '', placeholder: META.store || 'SundayBazar' });
    const quotas = s.leave_types.map(t => { var _a; return ({ t, el: h('input', { type: 'number', value: (_a = t.quota) !== null && _a !== void 0 ? _a : '', placeholder: 'no limit' }) }); });
    const tov = h('input', { type: 'checkbox', checked: s.time_override });
    const myNet = s.your_ip && /^\d+\.\d+\.\d+\.\d+$/.test(s.your_ip) ? s.your_ip.split('.').slice(0, 3).join('.') + '.' : s.your_ip;
    const m = modal('Attendance & leave settings', h('div', { class: 'grid' }, h('div', { class: 'card flat' }, h('h2', null, 'Office network for check-in'), field('Allowed IP prefixes (comma separated)', ips), h('div', { class: 'row small muted', style: { marginTop: '6px' } }, 'This device: ', h('span', { class: 'mono' }, s.your_ip || '?'), myNet ? h('button', { class: 'btn ghost sm', onclick: () => { ips.value = [ips.value, myNet].filter(Boolean).join(', '); } }, 'Allow this network') : null), h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'When set, staff can only check in while connected to the office WiFi. Leave empty to allow from anywhere.')), h('div', { class: 'card flat' }, h('h2', null, 'Late rule'), h('div', { class: 'row' }, 'Every', per, 'late days =', days, 'day(s) salary cut')), h('div', { class: 'card flat' }, h('h2', null, 'Leave per year'), h('div', { class: 'fgrid' }, quotas.map(q => field(q.t.name + (q.t.paid === false && !/unpaid/i.test(q.t.name) ? ' (unpaid)' : ''), q.el)))), h('div', { class: 'fgrid' }, field('Absent alert after shift start (minutes)', alertMin), field('Company name on payslips', company)), ME.role === 'admin' ? h('label', { class: 'row small muted' }, tov, 'Allow typing a manual check-in time (testing only — keep off)') : null), [h('button', { class: 'btn', onclick: () => act(() => POST('/api/hr/settings', Object.assign({ allowed_ips: ips.value, late_rule: { per: +per.value, days: +days.value }, absent_alert_min: +alertMin.value, company: company.value, leave_types: quotas.map(q => (Object.assign(Object.assign({}, q.t), { quota: q.el.value === '' ? null : +q.el.value }))) }, (ME.role === 'admin' ? { time_override: tov.checked } : {}))), 'Settings saved').then(() => { m.remove(); hrReload(); }) }, 'Save')]);
}
function hrAttTabs(tab) { return tabs([['day', 'Daily'], ['register', 'Monthly register'], ['holidays', 'Holidays']], tab, t => { location.hash = '#/attendance/' + t; }); }
const HR_ORDER = { absent: 0, late: 1, not_yet: 2, half: 3, present: 4, halfleave: 5, leave: 6, holiday: 7, off: 8 };
registerView({ key: 'attendance', title: 'Attendance', group: 'People', perm: 'hr', icon: 'clock', order: 11 }, async (args) => {
    const tab = args[0] || 'day';
    const head = pageHead('Attendance', 'Who came, who was late, who is absent', h('button', { class: 'btn ghost', onclick: hrSettingsModal }, icon('gear', 15), 'Settings'));
    if (tab === 'register') {
        const month = args[1] || monthStr();
        const d = await GET('/api/hr/register?month=' + month), emps = await hrEmps();
        const today = todayStr();
        const csv = () => csvDownload(`attendance-${month}.csv`, d.rows.map(r => Object.assign({ Employee: r.name, Department: r.department || '' }, Object.fromEntries(d.days.map((x, i) => [x.d.slice(8), r.cells[i]])), { Present: r.present, Late: r.late, Absent: r.absent, Leave: r.leave, Unpaid: r.unpaid, Off: r.off, Holidays: r.holiday })));
        const grid = h('div', { class: 'scroll', style: { maxHeight: '70vh' } }, h('table', { class: 'hr-reg' }, h('thead', null, h('tr', null, h('th', { class: 'nm' }, 'Employee'), d.days.map(x => h('th', { class: x.wd === 0 || x.hol ? 'we' : '', title: x.hol || '' }, +x.d.slice(8), h('br'), HR_WD[x.wd][0])), ['P', 'L', 'A', 'LV', 'Unp'].map(k => h('th', null, k)))), h('tbody', null, d.rows.map(r => h('tr', null, h('td', { class: 'nm', title: r.name }, h('a', { href: '#', onclick: ev => { ev.preventDefault(); hrProfile(r.id, 'attendance', month); } }, r.name)), r.cells.map((c, i) => {
            const x = d.days[i], ok = c && c !== '–' && x.d <= today;
            return h('td', { class: x.wd === 0 || x.hol ? 'we' : '' }, c ? h('span', { class: 'hr-c hr-c-' + c + (ok ? ' click' : ''), title: `${r.name} · ${day(x.d)}`,
                onclick: ok ? () => { const e = emps.find(y => y.id === r.id) || { id: r.id, name: r.name }; hrAttEditModal(e, x.d, null, hrReload); } : null }, c) : '');
        }), h('td', { class: 'tot pos' }, num(r.present)), h('td', { class: 'tot' }, r.late || ''), h('td', { class: 'tot neg' }, r.absent || ''), h('td', { class: 'tot' }, r.leave || ''), h('td', { class: 'tot' }, r.unpaid || ''))))));
        return hrRender(head, hrAttTabs(tab), h('div', { class: 'row sp' }, hrMonthPicker(month, m => { location.hash = '#/attendance/register/' + m; }), h('button', { class: 'btn ghost sm', onclick: csv }, 'Download CSV')), h('div', { class: 'card' }, d.rows.length ? grid : h('div', { class: 'empty' }, 'No employees in this month.'), h('div', { class: 'hr-legend', style: { marginTop: '10px' } }, [['P', 'Present'], ['L', 'Late'], ['A', 'Absent'], ['LV', 'Leave'], ['½', 'Half day'], ['OFF', 'Weekly off'], ['H', 'Holiday']].map(([c, l]) => h('span', null, h('span', { class: 'hr-c hr-c-' + c }, c), ' ', l)), h('span', null, '· tap a cell to correct it'))));
    }
    if (tab === 'holidays') {
        const year = args[1] || todayStr().slice(0, 4);
        const list = await GET('/api/hr/holidays?year=' + year);
        const add = () => formModal('Add holiday', [{ k: 'day', label: 'Date', type: 'date', required: true }, { k: 'name', label: 'Name', required: true, placeholder: 'e.g. Eid ul Adha' }], async (v) => { await POST('/api/hr/holidays', v); hrReload(); });
        return hrRender(head, hrAttTabs(tab), h('div', { class: 'row sp' }, h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#/attendance/holidays/' + (+year - 1); } }, '‹'), h('strong', null, year), h('button', { class: 'btn ghost sm', onclick: () => { location.hash = '#/attendance/holidays/' + (+year + 1); } }, '›')), h('button', { class: 'btn', onclick: add }, '+ Add holiday')), h('div', { class: 'card pad0' }, table([{ t: 'Date', f: x => h('strong', null, day(x.day)) }, { t: 'Day', f: x => HR_WD[new Date(x.day + 'T00:00:00Z').getUTCDay()] }, { t: 'Holiday', k: 'name' },
            { t: '', f: x => h('button', { class: 'btn ghost sm', onclick: () => confirm('Remove ' + x.name + '?') && act(() => api('DELETE', '/api/hr/holidays/' + x.day), 'Removed').then(hrReload) }, 'Remove') }], list)), h('div', { class: 'small muted' }, 'Holidays are not counted as absent and do not use leave.'));
    }
    // daily
    const date = args[1] || todayStr();
    const d = await GET('/api/hr/attendance?date=' + date), s = d.summary, isToday = date === d.today;
    const rows = d.rows.slice().sort((a, b) => { var _a, _b; return ((_a = HR_ORDER[a.detail]) !== null && _a !== void 0 ? _a : 9) - ((_b = HR_ORDER[b.detail]) !== null && _b !== void 0 ? _b : 9) || a.name.localeCompare(b.name); });
    const go = x => { location.hash = '#/attendance/day/' + x; };
    const dateIn = h('input', { type: 'date', value: date, max: d.today, onchange: () => go(dateIn.value) });
    const addEntry = async () => { const emps = (await hrEmps()).filter(e => e.status !== 'left'); formModal('Add attendance entry · ' + day(date), [{ k: 'emp', label: 'Employee', type: 'select', options: hrEmpOptions(emps), required: true }], async (v) => { const e = emps.find(x => x.id === +v.emp); setTimeout(() => hrAttEditModal(e, date, null, hrReload), 50); }, 'Next'); };
    hrRender(head, hrAttTabs('day'), h('div', { class: 'row sp' }, h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => go(hrShiftDay(date, -1)) }, '‹'), dateIn, h('button', { class: 'btn ghost sm', disabled: isToday, onclick: () => go(hrShiftDay(date, 1)) }, '›'), !isToday ? h('button', { class: 'btn ghost sm', onclick: () => go(d.today) }, 'Today') : null, h('strong', null, HR_WD[new Date(date + 'T00:00:00Z').getUTCDay()]), d.holiday ? h('span', { class: 'b accent' }, d.holiday) : null), h('button', { class: 'btn ghost sm', onclick: addEntry }, '+ Add entry')), h('div', { class: 'kpis hr-kpis' }, kpi('Came in', num(s.present + s.late), `of ${rows.length - s.off - s.holiday - s.leave} expected`, 'good'), kpi('Late', num(s.late), 'after shift + grace', s.late ? 'warn' : ''), kpi('Absent', num(s.absent), 'no check-in, no leave', s.absent ? 'alert' : ''), kpi('On leave', num(s.leave)), isToday && s.not_yet ? kpi('Not in yet', num(s.not_yet), 'shift not started / in grace') : kpi('Off / holiday', num(s.off + s.holiday))), h('div', { class: 'card pad0' }, table([
        { t: 'Employee', f: r => h('div', null, h('strong', null, r.name), h('div', { class: 'small muted' }, (r.department || '') + ' · ' + hrHM(r.shift_start) + '–' + hrHM(r.shift_end))) },
        { t: 'Status', f: r => h('div', null, hrB(r.detail), r.leave_type ? h('div', { class: 'small muted' }, r.leave_type) : null) },
        { t: 'In', f: r => r.in_at ? h('div', null, hrT(r.in_at), r.late_min ? h('div', { class: 'small neg' }, r.late_min + ' min late') : null) : '' },
        { t: 'Out', f: r => r.out_at ? h('div', null, hrT(r.out_at), r.early_min ? h('div', { class: 'small neg' }, r.early_min + ' min early') : null) : r.in_at && isToday ? h('span', { class: 'small muted' }, 'still in') : '' },
        { t: 'Hours', n: 1, f: r => r.hours != null ? r.hours + ' h' : '' },
        { t: '', f: r => h('div', { class: 'row' }, r.note ? h('span', { class: 'small muted', title: r.note }, 'edited') : null, ['off', 'holiday'].includes(r.status) && !r.in_at ? null : h('button', { class: 'btn ghost sm', onclick: () => hrAttEditModal({ id: r.employee_id, name: r.name, shift_start: r.shift_start }, date, r, hrReload) }, 'Edit')) },
    ], rows, r => hrProfile(r.employee_id, 'attendance', date.slice(0, 7)))));
});
/* ---------- HR: leave requests, approvals, balances ---------- */
async function hrLeaveAddModal(empId, after) {
    const [emps, meta] = await Promise.all([hrEmps(), GET('/api/hr/meta')]);
    formModal('Record leave', [
        { k: 'emp_id', label: 'Employee', type: 'select', options: hrEmpOptions(emps), value: empId || '', required: true },
        { k: 'type', label: 'Type', type: 'select', options: meta.leave_types.map(t => [t.key, t.name + (t.paid === false ? ' (no pay)' : '')]) },
        { k: 'from_day', label: 'From', type: 'date', value: todayStr(), required: true }, { k: 'to_day', label: 'To (empty = one day)', type: 'date' },
        { k: 'half', label: 'Half day (one date only)', type: 'checkbox' }, { k: 'reason', label: 'Reason', type: 'textarea' },
    ], async (v) => { const r = await POST('/api/hr/leave', Object.assign(Object.assign({}, v), { emp_id: +v.emp_id, to_day: v.to_day || v.from_day })); toast(`Leave recorded and approved (${r.days} day${r.days === 1 ? '' : 's'})`); after && after(); }, 'Save (approved)');
}
function hrDecide(l, status) {
    if (status === 'approved')
        return act(() => POST(`/api/hr/leave/${l.id}/decide`, { status }), 'Approved').then(hrReload);
    formModal((status === 'rejected' ? 'Reject' : 'Cancel') + ' leave · ' + l.name, [{ k: 'note', label: 'Reason (the employee will see this)', type: 'textarea' }], async (v) => { await POST(`/api/hr/leave/${l.id}/decide`, { status, note: v.note }); toast('Saved'); hrReload(); }, status === 'rejected' ? 'Reject' : 'Cancel leave');
}
registerView({ key: 'leave', title: 'Leave', group: 'People', perm: 'hr', icon: 'check', order: 12 }, async (args) => {
    const tab = args[0] || 'pending';
    const d = await GET('/api/hr/leave' + (tab === 'pending' ? '?status=pending' : ''));
    const tname = k => (d.types.find(t => t.key === k) || { name: k }).name;
    const head = [pageHead('Leave', 'Approve requests and see how much leave each person has left', h('button', { class: 'btn primary', onclick: () => hrLeaveAddModal(null, hrReload) }, '+ Record leave')),
        tabs([['pending', 'Waiting for approval', d.pending], ['all', 'All requests'], ['balances', 'Balances ' + todayStr().slice(0, 4)]], tab, t => { location.hash = '#/leave/' + t; })];
    if (tab === 'balances') {
        return hrRender(head, h('div', { class: 'card pad0' }, table([{ t: 'Employee', f: e => h('div', null, h('strong', null, e.name), h('div', { class: 'small muted' }, e.department || '')) },
            ...d.types.map(t => ({ t: t.name + (t.quota != null ? ` (${t.quota})` : ''), n: 1, f: e => { const b = e.balances.find(x => x.key === t.key); return h('div', null, b.left == null ? h('span', null, b.used + ' used') : h('span', { class: b.left <= 0 ? 'neg' : '' }, h('strong', null, num(b.left)), ' left'), b.pending ? h('div', { class: 'small muted' }, b.pending + ' waiting') : null); } }))], d.balances, e => hrProfile(e.id, 'leave'))));
    }
    const cols = [
        { t: 'Employee', f: l => h('div', null, h('strong', null, l.name), h('div', { class: 'small muted' }, l.department || '')) },
        { t: 'Leave', f: l => h('div', null, tname(l.type), h('div', { class: 'small muted' }, hrDates(l.from_day, l.to_day) + (l.half ? ' · half day' : ''))) },
        { t: 'Days', n: 1, f: l => num(l.days) },
        { t: 'Reason', f: l => h('span', { class: 'small' }, l.reason || '—') },
    ];
    if (tab === 'pending')
        cols.push({ t: 'Left after', n: 1, f: l => l.balance == null ? '—' : h('span', { class: l.balance - l.days < 0 ? 'neg' : '' }, num(l.balance - l.days)) }, { t: '', f: l => h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn ok sm', onclick: () => hrDecide(l, 'approved') }, 'Approve'), h('button', { class: 'btn ghost sm', onclick: () => hrDecide(l, 'rejected') }, 'Reject')) });
    else
        cols.push({ t: 'Status', f: l => h('div', null, h('span', { class: 'b ' + ({ approved: 'ok', rejected: 'bad', pending: 'warn' }[l.status] || '') }, l.status), l.decided_name ? h('div', { class: 'small muted' }, 'by ' + l.decided_name) : null, l.decision_note ? h('div', { class: 'small muted' }, l.decision_note) : null) }, { t: '', f: l => l.status === 'approved' && l.to_day >= todayStr() ? h('button', { class: 'btn ghost sm', onclick: () => hrDecide(l, 'cancelled') }, 'Cancel') : l.status === 'pending' ? h('button', { class: 'btn ok sm', onclick: () => hrDecide(l, 'approved') }, 'Approve') : '' });
    hrRender(head, d.rows.length ? h('div', { class: 'card pad0' }, table(cols, d.rows, l => hrProfile(l.emp_id, 'leave'))) : h('div', { class: 'card' }, h('div', { class: 'empty' }, tab === 'pending' ? 'No leave requests waiting. Staff request leave from their My day page.' : 'No leave yet.')));
});
/* ---------- HR: payroll runs, advances, history ---------- */
async function hrAdvanceModal(empId, after) {
    const emps = await hrEmps();
    formModal('Give salary advance', [
        { k: 'emp_id', label: 'Employee', type: 'select', options: hrEmpOptions(emps), value: empId || '', required: true },
        { k: 'amount', label: 'Amount (Rs)', type: 'number', required: true }, { k: 'day', label: 'Date', type: 'date', value: todayStr() },
        { k: 'method', label: 'Paid from', type: 'select', options: ['Cash', 'Meezan (SB)'] }, { k: 'monthly', label: 'Cut from salary each month (Rs)', type: 'number', placeholder: 'e.g. 5000' },
        { k: 'note', label: 'Note', placeholder: 'reason' },
    ], async (v) => { const r = await POST('/api/hr/advances', Object.assign(Object.assign({}, v), { emp_id: +v.emp_id })); toast('Advance saved' + (r.posted ? ' and posted to accounts' : '')); after && after(); }, 'Give advance');
}
function hrPayModal(month, ids, after) {
    formModal(ids ? 'Mark salary paid' : 'Mark all salaries paid', [{ k: 'account', label: 'Paid from', type: 'select', options: ['Meezan (SB)', 'Cash', 'Petty Cash'] }, { k: 'date', label: 'Payment date', type: 'date', value: todayStr() }], async (v) => { const r = await POST(`/api/hr/payroll/${month}/pay`, Object.assign(Object.assign({}, v), { emp_ids: ids || undefined })); toast(`${r.paid} salar${r.paid === 1 ? 'y' : 'ies'} marked paid`); after && after(); }, 'Mark paid');
}
function hrLineModal(month, l, after) {
    formModal(`${l.name} · ${hrMonthName(month)}`, [
        { k: 'incentive', label: 'Incentive / bonus (Rs)', type: 'number', value: l.incentive || 0 }, { k: 'incentive_note', label: 'Why (incentive)', value: l.incentive_note },
        { k: 'other_ded', label: 'Other deduction (Rs)', type: 'number', value: l.other_ded || 0 }, { k: 'other_note', label: 'Why (deduction)', value: l.other_note, placeholder: 'e.g. damaged pair' },
        { k: 'recovery', label: `Advance recovery (balance ${rs(l.adv_balance)})`, type: 'number', value: l.recovery || 0 },
    ], async (v) => { await POST(`/api/hr/payroll/${month}/line/${l.emp_id}`, v); toast('Line updated'); after && after(); });
}
registerView({ key: 'payroll', title: 'Payroll', group: 'People', perm: 'payroll', icon: 'cash', order: 13 }, async (args) => {
    const tab = args[0] || 'run';
    const head = [pageHead('Payroll', 'Salaries, advances and payslips'), tabs([['run', 'Salary run'], ['advances', 'Advances'], ['history', 'History']], tab, t => { location.hash = '#/payroll/' + t; })];
    if (tab === 'advances') {
        const d = await GET('/api/hr/advances');
        return hrRender(head, h('div', { class: 'row sp' }, h('span', { class: 'small muted' }, 'Advances are recovered automatically in payroll (the monthly cut), and can be changed per month.'), h('button', { class: 'btn primary', onclick: () => hrAdvanceModal(null, hrReload) }, '+ Give advance')), !d.accounts ? h('div', { class: 'note warn' }, 'Accounts module is not available: advances are saved here but not posted to the books.') : null, h('div', { class: 'card pad0' }, h('h2', null, 'Balances'), table([{ t: 'Employee', f: x => h('strong', null, x.name) }, { t: 'Given', n: 1, f: x => rs(x.given) }, { t: 'Recovered', n: 1, f: x => rs(x.recovered) },
            { t: 'Balance', n: 1, f: x => h('strong', { class: x.balance ? 'neg' : '' }, rs(x.balance)) }, { t: 'Next cut', n: 1, f: x => x.plan ? rs(x.plan) : '—' }], d.balances, x => hrProfile(x.id, 'advances'))), h('div', { class: 'card pad0' }, h('h2', null, 'All advances'), table([{ t: 'Date', f: x => day(x.day) }, { t: 'Employee', k: 'name' }, { t: 'Amount', n: 1, f: x => rs(x.amount) }, { t: 'From', k: 'method' },
            { t: 'Monthly cut', n: 1, f: x => x.monthly ? rs(x.monthly) : '—' }, { t: 'Note', f: x => h('span', { class: 'small' }, x.note || '') }, { t: 'By', f: x => h('span', { class: 'small muted' }, x.by_name || '') },
            { t: '', f: x => h('button', { class: 'btn ghost sm', onclick: () => confirm(`Delete advance of ${rs(x.amount)} to ${x.name}?`) && act(() => POST(`/api/hr/advances/${x.id}/delete`), 'Deleted').then(hrReload) }, 'Delete') }], d.list)));
    }
    if (tab === 'history') {
        const runs = await GET('/api/hr/payroll');
        return hrRender(head, h('div', { class: 'card pad0' }, table([{ t: 'Month', f: r => h('strong', null, hrMonthName(r.month)) }, { t: 'Status', f: r => h('span', { class: 'b ' + (r.status === 'approved' ? 'ok' : 'warn') }, r.status === 'approved' ? 'approved' : 'draft') },
            { t: 'Staff', n: 1, k: 'staff' }, { t: 'Gross', n: 1, f: r => rs(r.gross) }, { t: 'Net pay', n: 1, f: r => h('strong', null, rs(r.net)) }, { t: 'Paid', n: 1, f: r => r.paid >= r.net && r.net ? h('span', { class: 'b ok' }, 'all paid') : rs(r.paid) }], runs, r => { location.hash = '#/payroll/run/' + r.month; })));
    }
    const month = args[1] || hrShiftMonth(monthStr(), -1);
    const d = await GET('/api/hr/payroll/' + month), run = d.run, t = d.totals, draft = run && run.status === 'draft', approved = run && run.status === 'approved';
    const goM = m => { location.hash = '#/payroll/run/' + m; };
    const actions = [];
    if (!run)
        actions.push(h('button', { class: 'btn primary', onclick: () => act(() => POST(`/api/hr/payroll/${month}/run`), 'Payroll calculated').then(hrReload) }, 'Run payroll'));
    if (draft)
        actions.push(h('button', { class: 'btn ghost', onclick: () => act(() => POST(`/api/hr/payroll/${month}/run`), 'Recalculated from attendance').then(hrReload) }, 'Recalculate'), h('button', { class: 'btn ghost', onclick: () => confirm('Discard this draft?') && act(() => POST(`/api/hr/payroll/${month}/discard`), 'Draft discarded').then(hrReload) }, 'Discard'), h('button', { class: 'btn primary', onclick: () => {
                const m = modal('Approve & post ' + d.month_name + '?', h('div', { class: 'stack' }, h('div', null, `Net pay ${rs(t.net)} for ${t.staff} people.`), h('div', { class: 'small muted' }, d.accounts ? `Posts to accounts: Salary Exp ${rs(t.earned + t.incentive)} · Salaries Payable ${rs(t.net)}${t.recovery ? ' · Employees Advance ' + rs(t.recovery) : ''}${t.other_ded ? ' · Other Income ' + rs(t.other_ded) : ''}.` : 'Accounts module is not available — nothing will be posted to the books.'), h('div', { class: 'small muted' }, 'After approval the month is locked; only the owner can reopen it.')), [h('button', { class: 'btn primary', onclick: () => act(() => POST(`/api/hr/payroll/${month}/approve`), 'Payroll approved').then(r => { m.remove(); if (r.warning)
                            toast(r.warning, true); hrReload(); }) }, 'Approve & post')]);
            } }, 'Approve & post'));
    if (approved) {
        if (t.paid < t.net)
            actions.push(h('button', { class: 'btn primary', onclick: () => hrPayModal(month, null, hrReload) }, 'Mark all paid'));
        if (d.owner)
            actions.push(h('button', { class: 'btn ghost', onclick: () => formModal('Reopen ' + d.month_name, [{ k: 'reason', label: 'Why?', type: 'textarea', required: true }], async (v) => { await POST(`/api/hr/payroll/${month}/reopen`, v); toast('Reopened — the accounts entry was reversed'); hrReload(); }, 'Reopen') }, 'Reopen'));
    }
    const L = d.lines, note = !run ? h('div', { class: 'note' }, 'Preview from attendance — nothing is saved yet. Click "Run payroll" to create the draft, then add incentives or deductions per person.')
        : draft ? h('div', { class: 'note warn' }, 'Draft. Tap a person to add incentive, deductions or change the advance cut. "Recalculate" refreshes attendance and keeps your changes.')
            : h('div', { class: 'note ok' }, `Approved ${run.approved_at ? dt(run.approved_at.replace(' ', 'T') + '+05:00') : ''}${run.posted ? ' and posted to accounts' : ' (not posted — accounts module missing)'}. Locked.`);
    const rule = d.rule || { per: 3, days: 0.5 };
    const cell = (v, cls) => v ? h('span', { class: cls || '' }, rs(v)) : h('span', { class: 'muted' }, '–');
    hrRender(head, h('div', { class: 'row sp' }, h('div', { class: 'row' }, hrMonthPicker(month, goM), run ? h('span', { class: 'b ' + (approved ? 'ok' : 'warn') }, approved ? 'Approved' : 'Draft') : h('span', { class: 'b' }, 'Not run')), h('div', { class: 'row' }, actions)), d.current ? h('div', { class: 'note warn' }, 'This month is not over yet. Days after today are not counted as absent.') : null, note, h('div', { class: 'kpis hr-kpis' }, kpi('People', num(t.staff)), kpi('Gross salaries', rs(t.gross)), kpi('Absent & late cuts', rs(t.absence_ded + t.late_ded), null, t.absence_ded + t.late_ded ? 'warn' : ''), kpi('Advance recovery', rs(t.recovery)), kpi('Net to pay', rs(t.net), approved ? rs(t.paid) + ' paid' : null, approved && t.paid >= t.net ? 'good' : '')), h('div', { class: 'card pad0' }, L.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Employee', 'Attendance', 'Gross', 'Absent cut', 'Late cut', 'Incentive', 'Other cut', 'Advance', 'Net pay', ''].map((x, i) => h('th', { class: i >= 2 && i <= 8 ? 'n' : '' }, x)))), h('tbody', null, L.map(l => h('tr', { class: draft ? 'click' : '', onclick: draft ? (ev => { if (!ev.target.closest('a,button'))
            hrLineModal(month, l, hrReload); }) : null }, h('td', null, h('strong', null, l.name), h('div', { class: 'small muted' }, [l.designation, l.department].filter(Boolean).join(' · '))), h('td', { class: 'small' }, h('div', null, `P ${num(l.present)} · L ${l.late} · A ${num(l.absent)}` + (l.unpaid ? ` · Unpaid ${num(l.unpaid)}` : '')), l.emp_days < l.days_month ? h('div', { class: 'muted' }, `${l.emp_days}/${l.days_month} days (joined/left)`) : null), h('td', { class: 'n' }, rs(l.gross)), h('td', { class: 'n' }, cell(l.absence_ded, 'neg')), h('td', { class: 'n' }, cell(l.late_ded, 'neg')), h('td', { class: 'n', title: l.incentive_note || '' }, cell(l.incentive, 'pos')), h('td', { class: 'n', title: l.other_note || '' }, cell(l.other_ded, 'neg')), h('td', { class: 'n' }, cell(l.recovery, 'neg'), l.adv_balance ? h('div', { class: 'small muted' }, 'of ' + rs(l.adv_balance)) : null), h('td', { class: 'n' }, h('strong', null, rs(l.net))), h('td', null, approved ? h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, l.paid ? h('span', { class: 'b ok', title: l.paid_from || '' }, 'paid') : h('button', { class: 'btn ghost sm', onclick: () => hrPayModal(month, [l.emp_id], hrReload) }, 'Pay'), h('a', { class: 'btn ghost sm', href: `#/payslip/${month}/${l.emp_id}` }, 'Slip'), l.paid && d.owner ? h('button', { class: 'btn ghost sm', title: 'Undo payment', onclick: () => confirm('Undo this payment?') && act(() => POST(`/api/hr/payroll/${month}/unpay`, { emp_id: l.emp_id }), 'Payment undone').then(hrReload) }, '↺') : null) : draft ? h('span', { class: 'small muted' }, 'edit') : '')))), h('tfoot', null, h('tr', null, h('td', null, 'Total'), h('td'), h('td', { class: 'n' }, rs(t.gross)), h('td', { class: 'n' }, rs(t.absence_ded)), h('td', { class: 'n' }, rs(t.late_ded)), h('td', { class: 'n' }, rs(t.incentive)), h('td', { class: 'n' }, rs(t.other_ded)), h('td', { class: 'n' }, rs(t.recovery)), h('td', { class: 'n' }, rs(t.net)), h('td'))))) : h('div', { class: 'empty' }, 'No employees were working in this month.')), h('div', { class: 'small muted' }, `How it is calculated: gross = basic + allowances (only the days worked if the person joined or left this month). One day = monthly salary ÷ 30. Absent days and unpaid leave are cut at one day each. Every ${rule.per} late days = ${rule.days} day cut (change in Attendance → Settings). Net = gross − cuts + incentive − other deductions − advance recovery.`));
});
/* ---------- HR: shared helpers, employees directory & profile, top-bar check-in, My page card ---------- */
const HR_ST = { present: ['ok', 'Present'], late: ['warn', 'Late'], half: ['warn', 'Half day'], absent: ['bad', 'Absent'], leave: ['info', 'On leave'], halfleave: ['info', 'Half leave'],
    off: ['', 'Off day'], holiday: ['accent', 'Holiday'], not_yet: ['', 'Not in yet'], future: ['', ''], na: ['', '–'] };
const HR_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HR_EST = { active: ['ok', 'Active'], notice: ['warn', 'On notice'], left: ['bad', 'Left'] };
const HR_WARN = { verbal: ['warn', 'Verbal warning'], written: ['warn', 'Written warning'], final: ['bad', 'Final warning'], note: ['', 'Note'], praise: ['ok', 'Praise'] };
const HR_DEPTS = ['CS', 'Listing', 'Warehouse', 'Finance', 'Marketing', 'Outlet', 'Management', 'Other'];
const HR_OFFS = [['[0]', 'Sunday'], ['[5]', 'Friday'], ['[6]', 'Saturday'], ['[0,6]', 'Saturday & Sunday'], ['[1]', 'Monday'], ['[2]', 'Tuesday'], ['[3]', 'Wednesday'], ['[4]', 'Thursday'], ['[]', 'No weekly off']];
function hrB(s) { const [c, l] = HR_ST[s] || ['', s]; return l ? h('span', { class: 'b ' + c }, l) : ''; }
function hrEB(s) { const [c, l] = HR_EST[s] || ['', s]; return h('span', { class: 'b ' + c }, l); }
function hrT(s) { if (!s)
    return ''; const [H, M] = s.slice(11, 16).split(':').map(Number); return ((H % 12) || 12) + ':' + String(M).padStart(2, '0') + (H < 12 ? ' am' : ' pm'); }
function hrHM(t) { if (!t)
    return ''; return hrT('0000-00-00 ' + t); }
function hrHrs(min) { if (min == null)
    return ''; return Math.floor(min / 60) + 'h ' + String(Math.round(min % 60)).padStart(2, '0') + 'm'; }
function hrMonthName(m) { return new Date(m + '-15T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function hrShiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); }
function hrShiftDay(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
function hrDates(a, b) { return !b || a === b ? day(a) : day(a) + ' – ' + day(b); }
function hrInitials(n) { return (n || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase(); }
function hrAvatar(e, size) { const s = (size || 34) + 'px'; return e.photo ? h('img', { class: 'hr-ph', src: '/api/files/' + e.photo, style: { width: s, height: s }, alt: '' }) : h('span', { class: 'avatar hr-av', style: { width: s, height: s, fontSize: Math.round((size || 34) / 2.8) + 'px' } }, hrInitials(e.name)); }
function hrPerson(e, sub) { return h('div', { class: 'person' }, hrAvatar(e), h('div', null, h('strong', null, e.name), sub ? h('div', { class: 'small muted' }, sub) : null)); }
function hrMonthPicker(val, onChange) {
    const inp = h('input', { type: 'month', value: val, onchange: () => onChange(inp.value) });
    return h('div', { class: 'row hr-mp' }, h('button', { class: 'btn ghost sm', title: 'Previous month', onclick: () => onChange(hrShiftMonth(inp.value, -1)) }, '‹'), inp, h('button', { class: 'btn ghost sm', title: 'Next month', onclick: () => onChange(hrShiftMonth(inp.value, 1)) }, '›'));
}
let HR_EMPS = null;
async function hrEmps(force) { if (!HR_EMPS || force)
    HR_EMPS = await GET('/api/hr/employees'); return HR_EMPS; }
function hrEmpOptions(list, all) { return (all ? list : list.filter(e => e.status !== 'left')).map(e => [e.id, e.name + (e.department ? ' · ' + e.department : '')]); }
function hrRender(...k) { return render(...k.flat(Infinity).filter(x => x != null && x !== false && x !== '')); }
function hrReload() { if (typeof route === 'function')
    route(); }
/* module styles (CSS variables only, so dark mode works) */
document.head.append(h('style', null, `
.hr-topw .btn{padding:6px 12px;font-size:13px}
.hr-topw .hr-done{font-size:12px;color:var(--muted);white-space:nowrap;display:flex;gap:6px;align-items:center}
.hr-ph{border-radius:50%;object-fit:cover;flex:none;background:var(--soft)}
.hr-av{background:var(--soft)!important;color:var(--ink)}
.hr-mp input{width:175px}
.hr-reg{border-collapse:separate;border-spacing:0;font-size:12px}
.hr-reg th,.hr-reg td{min-width:27px;padding:5px 3px;text-align:center;border-bottom:1px solid var(--line);white-space:nowrap}
.hr-reg th{font-size:10.5px;color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel);z-index:1}
.hr-reg th.we,.hr-reg td.we{background:var(--soft)}
.hr-reg .nm{text-align:left;position:sticky;left:0;background:var(--panel);z-index:2;padding-right:10px;min-width:130px;max-width:170px;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.hr-reg th.nm{z-index:3}
.hr-reg td.tot{font-weight:700;font-variant-numeric:tabular-nums;padding:5px 6px}
.hr-c{display:inline-block;min-width:24px;padding:1px 2px;border-radius:5px;font-weight:700;font-size:10.5px;line-height:18px;cursor:default}
.hr-c.click{cursor:pointer}
.hr-c-P{background:var(--ok-bg);color:var(--ok)} .hr-c-L,.hr-c-½{background:var(--warn-bg);color:var(--warn)} .hr-c-A{background:var(--bad-bg);color:var(--bad)}
.hr-c-LV,.hr-c-½LV{background:var(--info-bg);color:var(--info)} .hr-c-OFF{color:var(--muted)} .hr-c-H{background:var(--accent-soft);color:var(--accent)} .hr-c-–{color:var(--line)}
.hr-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted);align-items:center}
.hr-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.hr-cal .hd{font-size:10.5px;color:var(--muted);text-align:center;font-weight:600}
.hr-cal .d{border:1px solid var(--line);border-radius:8px;padding:4px 5px;min-height:46px;display:grid;align-content:space-between;font-size:11px;background:var(--panel)}
.hr-cal .d .n{color:var(--muted);font-size:10.5px}
.hr-cal .d .hr-c{justify-self:start}
.hr-cal .d.click{cursor:pointer} .hr-cal .d.click:hover{border-color:var(--muted)}
.hr-cal .d.today{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.hr-mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(66px,1fr));gap:8px}
.hr-mini > div{background:var(--soft);border-radius:10px;padding:8px 10px}
.hr-mini b{display:block;font-size:20px;font-variant-numeric:tabular-nums;line-height:1.2}
.hr-mini span{font-size:11.5px;color:var(--muted)}
.hr-mini .bad b{color:var(--bad)} .hr-mini .warn b{color:var(--warn)} .hr-mini .ok b{color:var(--ok)}
.hr-chips{display:flex;flex-wrap:wrap;gap:6px}
.hr-chip{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12.5px;background:var(--panel)}
.hr-chip b{font-variant-numeric:tabular-nums}
.hr-today{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between;padding:12px 14px;border-radius:12px;background:var(--soft)}
.hr-today .big{font-size:18px}
.hr-head{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.hr-head h2{margin:0;font-size:20px}
.hr-strip{display:flex;gap:2px;flex-wrap:wrap}
.hr-strip .hr-c{min-width:16px;font-size:9px;line-height:16px;padding:0 1px}
.hr-num{font-variant-numeric:tabular-nums}
.hr-slip{max-width:800px;margin:0 auto;width:100%}
.hr-slip .co{font-size:22px;font-weight:800;letter-spacing:-.02em}
.hr-slip .net{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums}
.hr-slip .tbl td{padding:6px 8px}
.hr-ed{color:var(--muted);font-size:11px}
@media (max-width:600px){ .hr-topw .lbl2{display:none} .hr-mp input{width:158px} .hr-kpis{grid-template-columns:1fr 1fr;gap:8px} .hr-kpis .kpi{padding:10px 12px} .hr-reg .nm{min-width:96px;max-width:110px} .drawer .in{padding:14px} .hr-cal .d{min-height:40px;padding:3px} .hr-cal{gap:3px} }
@media print{ .hr-slip,.hr-slip *{color:#000!important;background:#fff!important;box-shadow:none!important} .hr-slip .b{border:1px solid #999} .content{padding:0} }
`));
/* ---------- top bar: Check in / Check out ---------- */
async function hrCheck(kind, box) {
    try {
        const r = await POST('/api/hr/me/' + kind, {});
        if (kind === 'checkin')
            toast('Checked in at ' + hrT(r.in_at) + (r.late_min ? ` · ${r.late_min} min late` : ' · on time'));
        else
            toast('Checked out at ' + hrT(r.out_at) + ' · worked ' + hrHrs(r.minutes));
        document.querySelectorAll('.hr-topw').forEach(b => hrTopRefresh(b));
        if (['myhr', 'attendance', 'home', 'me', 'myday'].includes(CURRENT))
            hrReload();
    }
    catch (e) {
        toast(e.message, true);
    }
}
function hrConfirmOut(t) {
    const mins = t.open ? Math.round((Date.now() + 5 * 3600e3 - Date.parse(t.open.in_at.replace(' ', 'T') + 'Z')) / 60000) : 0;
    const m = modal('Check out now?', h('div', { class: 'stack' }, h('div', null, 'You checked in at ', h('strong', null, hrT(t.open.in_at)), '. Worked so far: ', h('strong', null, hrHrs(Math.max(0, mins))), '.'), t.shift_end ? h('div', { class: 'muted small' }, 'Your shift ends at ' + hrHM(t.shift_end) + '.') : null), [h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Not yet'), h('button', { class: 'btn primary', onclick: () => { m.remove(); hrCheck('checkout'); } }, 'Check out')]);
}
async function hrTopRefresh(box) {
    let t;
    try {
        t = await GET('/api/hr/me/today');
    }
    catch (_a) {
        return;
    }
    if (!t.linked)
        return box.replaceChildren();
    if (t.open)
        box.replaceChildren(h('button', { class: 'btn ghost', title: 'Check out', onclick: () => hrConfirmOut(t) }, icon('clock', 15), h('span', { class: 'lbl2' }, 'In ' + hrT(t.open.in_at) + ' ·'), 'Check out'));
    else if (t.today && t.today.in_at)
        box.replaceChildren(h('span', { class: 'hr-done', title: 'Today' }, icon('check', 15), h('span', null, hrT(t.today.in_at) + ' – ' + hrT(t.today.out_at))));
    else
        box.replaceChildren(h('button', { class: 'btn primary', onclick: e => { e.currentTarget.disabled = true; hrCheck('checkin'); } }, icon('clock', 15), 'Check in'));
}
registerTopWidget(() => { if (!can('me'))
    return null; const box = h('span', { class: 'hr-topw' }); hrTopRefresh(box); return box; });
/* ---------- My page (every staff member, own data only) ---------- */
function hrLeaveRequestModal(d, after) {
    const types = (d.types || []).map(t => { const b = (d.balances || []).find(x => x.key === t.key); return [t.key, t.name + (b && b.left != null ? ` (${b.left} left)` : '')]; });
    formModal('Request leave', [
        { k: 'type', label: 'Type of leave', type: 'select', options: types, required: true },
        { k: 'from_day', label: 'From', type: 'date', value: todayStr(), required: true }, { k: 'to_day', label: 'To (leave empty for one day)', type: 'date' },
        { k: 'half', label: 'Half day only (one date)', type: 'checkbox' }, { k: 'reason', label: 'Reason', type: 'textarea', required: true },
    ], async (v) => { const r = await POST('/api/hr/me/leave', Object.assign(Object.assign({}, v), { to_day: v.to_day || v.from_day })); toast(`Leave request sent (${r.days} day${r.days === 1 ? '' : 's'}). HR will approve it.`); after && after(); }, 'Send request');
}
async function hrMeCard() {
    const d = await GET('/api/hr/me');
    if (!d.employee)
        return null;
    const t = d.today, a = d.attendance, e = d.employee;
    const todayBox = h('div', { class: 'hr-today' }, h('div', null, h('div', { class: 'small muted' }, 'Today · shift ' + hrHM(e.shift_start) + ' – ' + hrHM(e.shift_end)), h('div', { class: 'row' }, h('span', { class: 'big' }, t.in_at ? 'In at ' + hrT(t.in_at) : t.status === 'off' ? 'Day off' : t.status === 'holiday' ? 'Holiday' : t.status === 'leave' ? 'On leave' : 'Not checked in'), t.in_at ? hrB(t.status) : null, t.late_min ? h('span', { class: 'small muted' }, t.late_min + ' min late') : null), t.out_at ? h('div', { class: 'small muted' }, 'Out at ' + hrT(t.out_at) + ' · worked ' + hrHrs(t.minutes)) : null), !t.in_at ? h('button', { class: 'btn primary big', onclick: () => hrCheck('checkin') }, icon('clock'), 'Check in')
        : !t.out_at ? h('button', { class: 'btn big', onclick: async () => hrConfirmOut(await GET('/api/hr/me/today')) }, 'Check out') : h('span', { class: 'b ok' }, 'Done for today'));
    const mini = h('div', { class: 'hr-mini' }, h('div', { class: 'ok' }, h('b', null, a.present), h('span', null, 'Present')), h('div', { class: a.late ? 'warn' : '' }, h('b', null, a.late), h('span', null, 'Late')), h('div', { class: a.absent ? 'bad' : '' }, h('b', null, a.absent), h('span', null, 'Absent')), h('div', null, h('b', null, a.leave + a.unpaid), h('span', null, 'Leave')));
    const strip = h('div', { class: 'hr-strip' }, a.cells.map(c => h('span', { class: 'hr-c hr-c-' + (c.c || '–'), title: `${day(c.d)} ${HR_WD[new Date(c.d + 'T00:00:00Z').getUTCDay()]} · ${(HR_ST[c.s] || [, c.s])[1] || 'upcoming'}${c.in_at ? ' · in ' + hrT(c.in_at) : ''}` }, c.c || new Date(c.d + 'T00:00:00Z').getUTCDate())));
    const refresh = () => hrReload();
    const lvList = d.leaves.slice(0, 5).map(l => h('div', { class: 'row sp small' }, h('span', null, (d.types.find(x => x.key === l.type) || { name: l.type }).name, ' · ', hrDates(l.from_day, l.to_day), l.half ? ' (half)' : ''), h('span', { class: 'row' }, h('span', { class: 'b ' + ({ approved: 'ok', rejected: 'bad', pending: 'warn' }[l.status] || '') }, l.status), l.status === 'pending' ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST('/api/hr/me/leave/' + l.id + '/cancel'), 'Request cancelled').then(refresh) }, 'Cancel') : null)));
    return h('div', { class: 'card' }, h('h2', null, icon('clock', 16), 'My attendance', h('small', null, hrMonthName(d.month)), CURRENT !== 'myhr' ? h('a', { class: 'spacer small', href: '#/myhr' }, 'Open') : null), h('div', { class: 'stack', style: { gap: '12px' } }, todayBox, mini, strip, h('div', { class: 'row sp' }, h('strong', null, 'Leave balance ' + d.month.slice(0, 4)), h('button', { class: 'btn ghost sm', onclick: () => hrLeaveRequestModal(d, refresh) }, '+ Request leave')), h('div', { class: 'hr-chips' }, d.balances.map(b => h('span', { class: 'hr-chip' }, b.name + ': ', h('b', null, b.left == null ? b.used + ' used' : b.left + ' left'), b.pending ? h('span', { class: 'muted' }, ` · ${b.pending} waiting`) : null))), lvList.length ? h('div', { class: 'stack' }, lvList) : null, d.advance.balance > 0 ? h('div', { class: 'row sp' }, h('span', null, 'Salary advance to repay'), h('strong', null, rs(d.advance.balance))) : null, h('div', null, h('strong', null, 'My payslips'), d.payslips.length ? h('div', { class: 'stack', style: { marginTop: '6px' } }, d.payslips.slice(0, 6).map(p => h('a', { class: 'row sp', href: '#/payslip/' + p.month, style: { textDecoration: 'none' } }, h('span', null, hrMonthName(p.month)), h('span', { class: 'row' }, h('strong', { class: 'hr-num' }, rs(p.net)), h('span', { class: 'b ' + (p.paid ? 'ok' : 'warn') }, p.paid ? 'paid' : 'not paid yet'))))) : h('div', { class: 'small muted' }, 'No payslips yet.'))));
}
registerMeCard({ key: 'hr', order: 10, perm: 'me' }, hrMeCard);
registerView({ key: 'myhr', title: 'My attendance', group: 'People', perm: 'me', icon: 'clock', order: 1, hidden: true }, async () => {
    const c = await hrMeCard();
    hrRender(c || h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Your login is not linked to an employee record yet. Ask HR to link it.')));
});
/* ---------- payslip (printable) ---------- */
registerView({ key: 'payslip', title: 'Payslip', group: 'People', perm: 'me', icon: 'doc', hidden: true }, async (args) => {
    const [month, emp] = args;
    const s = emp && can('payroll') ? await GET(`/api/hr/payroll/${month}/payslip/${emp}`) : await GET('/api/hr/me/payslips/' + month);
    const l = s.line, E = s.employee, row = (k, v, cls) => h('tr', null, h('td', null, k), h('td', { class: 'n ' + (cls || '') }, v));
    const earn = [row('Basic salary', rs(l.basic)), row('Allowances', rs(l.allowances)), l.emp_days < l.days_month ? row(`Worked ${l.emp_days} of ${l.days_month} days (joined/left this month)`, rs(l.gross)) : null,
        l.incentive ? row('Incentive / bonus' + (l.incentive_note ? ' · ' + l.incentive_note : ''), rs(l.incentive)) : null];
    const ded = [row(`Absent ${num(l.absent)} day(s)` + (l.unpaid ? ` + unpaid leave ${num(l.unpaid)}` : ''), rs(l.absence_ded)), row(`Late ${l.late} time(s)`, rs(l.late_ded)),
        l.recovery ? row('Advance recovery', rs(l.recovery)) : null, l.other_ded ? row('Other' + (l.other_note ? ' · ' + l.other_note : ''), rs(l.other_ded)) : null];
    const earnTot = l.gross + (l.incentive || 0), dedTot = l.absence_ded + l.late_ded + (l.recovery || 0) + (l.other_ded || 0);
    hrRender(h('div', { class: 'row noprint' }, h('button', { class: 'btn', onclick: () => print() }, 'Print'), h('button', { class: 'btn ghost', onclick: () => history.back() }, '‹ Back')), h('div', { class: 'card hr-slip' }, h('div', { class: 'row sp' }, h('div', null, h('div', { class: 'co' }, s.company), h('div', { class: 'muted' }, 'Salary slip · ' + s.month_name)), h('div', { style: { textAlign: 'right' } }, h('div', { class: 'small muted' }, 'Net pay'), h('div', { class: 'net' }, rs(l.net)), h('span', { class: 'b ' + (l.paid ? 'ok' : 'warn') }, l.paid ? 'Paid ' + day(l.paid_at) + (l.paid_from ? ' · ' + l.paid_from : '') : 'Not paid yet'))), h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' } }), h('dl', { class: 'dl' }, h('dt', null, 'Employee'), h('dd', null, h('strong', null, E.name)), h('dt', null, 'Designation'), h('dd', null, [E.designation, E.department].filter(Boolean).join(' · ') || '–'), h('dt', null, 'Joined'), h('dd', null, E.join_date ? day(E.join_date) + ' ' + E.join_date.slice(0, 4) : '–'), E.cnic ? [h('dt', null, 'CNIC'), h('dd', null, E.cnic)] : null, E.pay_method ? [h('dt', null, 'Paid by'), h('dd', null, E.pay_method + (E.bank_account ? ' · ' + E.bank_account : ''))] : null), h('div', { class: 'hr-mini', style: { margin: '14px 0' } }, [['Present', l.present], ['Late', l.late], ['Absent', l.absent], ['Paid leave', l.leave_paid], ['Unpaid leave', l.unpaid], ['Off / holiday', (l.off || 0) + (l.holiday || 0)]].map(([k, v]) => h('div', null, h('b', null, num(v)), h('span', null, k)))), h('div', { class: 'two' }, h('div', null, h('strong', null, 'Earnings'), h('table', { class: 'tbl' }, h('tbody', null, earn), h('tfoot', null, row('Total earnings', rs(earnTot))))), h('div', null, h('strong', null, 'Deductions'), h('table', { class: 'tbl' }, h('tbody', null, ded), h('tfoot', null, row('Total deductions', rs(dedTot)))))), h('div', { class: 'row sp', style: { marginTop: '14px' } }, h('span', { class: 'small muted' }, `One day = monthly salary ÷ 30 = ${rs(l.day_rate)}.` + (s.adv_balance_after ? ` Advance still to repay: ${rs(s.adv_balance_after)}.` : '')), h('strong', null, 'Net pay ' + rs(l.net))), s.status !== 'approved' ? h('div', { class: 'note warn noprint', style: { marginTop: '10px' } }, 'Draft — payroll not approved yet; numbers can still change.') : null));
});
/* ---------- employees ---------- */
function hrEmpForm(e, after) {
    const isNew = !e;
    e = e || { status: 'active', shift_start: '09:00', shift_end: '18:00', grace_min: 15, off_days: [0], join_date: todayStr(), pay_method: 'Bank', department: 'Warehouse' };
    GET('/api/hr/users').then(users => {
        const sens = e.basic !== undefined || isNew;
        const f = [
            { k: 'name', label: 'Full name', value: e.name, required: true }, { k: 'department', label: 'Department', type: 'select', options: HR_DEPTS, value: e.department },
            { k: 'designation', label: 'Designation / job', value: e.designation, placeholder: 'e.g. Picker, CS agent' }, { k: 'phone', label: 'Phone', value: e.phone, placeholder: '03xx xxxxxxx' },
            { k: 'join_date', label: 'Joining date', type: 'date', value: e.join_date, required: true },
            { k: 'user_id', label: 'ERP login (for check-in & My page)', type: 'select', options: [['', '— not linked —']].concat(users.map(u => [u.id, u.name + ' (' + u.username + ')'])), value: e.user_id || '' },
            { k: 'shift_start', label: 'Shift starts', type: 'time', value: e.shift_start }, { k: 'shift_end', label: 'Shift ends', type: 'time', value: e.shift_end },
            { k: 'grace_min', label: 'Grace minutes before "late"', type: 'number', value: e.grace_min }, { k: 'off_days', label: 'Weekly off', type: 'select', options: HR_OFFS, value: JSON.stringify(e.off_days || []) },
        ];
        if (sens)
            f.push({ k: 'basic', label: 'Basic salary (Rs / month)', type: 'number', value: e.basic }, { k: 'allowances', label: 'Allowances (Rs / month)', type: 'number', value: e.allowances }, { k: 'pay_method', label: 'Salary paid by', type: 'select', options: ['Bank', 'Cash', 'JazzCash', 'Easypaisa'], value: e.pay_method }, { k: 'bank_account', label: 'Bank account / IBAN / wallet no.', value: e.bank_account }, { k: 'cnic', label: 'CNIC', value: e.cnic, placeholder: '42101-1234567-1' }, { k: 'emergency', label: 'Emergency contact', value: e.emergency, placeholder: 'Name, relation, phone' }, { k: 'address', label: 'Address', value: e.address, full: true });
        f.push({ k: 'photo', label: 'Photo', type: 'file', value: e.photo, accept: 'image/*' }, { k: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['notice', 'On notice'], ['left', 'Left']], value: e.status });
        if (!isNew)
            f.push({ k: 'leave_date', label: 'Leaving date (if left / on notice)', type: 'date', value: e.leave_date }, { k: 'leave_reason', label: 'Reason for leaving', value: e.leave_reason });
        f.push({ k: 'notes', label: 'Notes', type: 'textarea', value: e.notes });
        formModal(isNew ? 'Add employee' : 'Edit ' + e.name, f, async (v) => {
            v.off_days = JSON.parse(v.off_days || '[]');
            v.user_id = v.user_id ? +v.user_id : null;
            if (!v.leave_date)
                delete v.leave_date;
            const r = await POST(isNew ? '/api/hr/employees' : '/api/hr/employees/' + e.id, v);
            toast('Saved');
            HR_EMPS = null;
            after && after(r.id);
        }, isNew ? 'Add employee' : 'Save');
    }).catch(x => toast(x.message, true));
}
function hrLeftModal(e, after) {
    formModal('Mark ' + e.name + ' as left', [
        { k: 'status', label: 'Status', type: 'select', options: [['left', 'Left / fired'], ['notice', 'On notice (still working)']], value: 'left' },
        { k: 'leave_date', label: 'Last working day', type: 'date', value: todayStr(), required: true }, { k: 'leave_reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'e.g. Absent too often, resigned …' },
    ], async (v) => { await POST('/api/hr/employees/' + e.id, v); toast('Saved. Remember to block their login in Staff & access.'); HR_EMPS = null; after && after(); }, 'Save');
}
function hrWarnModal(e, after) {
    formModal('Warning or note · ' + e.name, [
        { k: 'type', label: 'Type', type: 'select', options: Object.entries(HR_WARN).map(([k, v]) => [k, v[1]]), value: 'verbal' }, { k: 'day', label: 'Date', type: 'date', value: todayStr() },
        { k: 'note', label: 'What happened', type: 'textarea', required: true }, { k: 'file', label: 'Signed letter / file (optional)', type: 'file' },
    ], async (v) => { await POST(`/api/hr/employees/${e.id}/warnings`, v); toast('Saved'); after && after(); });
}
function hrAttEditModal(e, d, cur, after) {
    formModal(`Attendance · ${e.name || e.employee_name} · ${day(d)}`, [
        { k: 'in_time', label: 'Check-in time', type: 'time', value: cur && cur.in_at ? cur.in_at.slice(11, 16) : (e.shift_start || '09:00') },
        { k: 'out_time', label: 'Check-out time', type: 'time', value: cur && cur.out_at ? cur.out_at.slice(11, 16) : '' },
        { k: 'half', label: 'Half day', type: 'checkbox', value: cur && cur.half }, { k: 'clear', label: 'Remove entry (counts as absent)', type: 'checkbox' },
        { k: 'reason', label: 'Reason for change (saved in the log)', type: 'textarea', required: true, placeholder: 'e.g. Phone was off, came at 9:05' },
    ], async (v) => { await POST('/api/hr/attendance', Object.assign({ emp_id: e.id || e.employee_id, day: d }, v)); toast('Attendance saved'); after && after(); });
}
async function hrProfile(id, tab = 'details', month) {
    month = month || monthStr();
    const d = await GET(`/api/hr/employees/${id}?month=${month}`), e = d.employee;
    const dr = document.querySelector('.drawer.hr-prof') || (() => { const x = drawer(h('div')); x.classList.add('hr-prof'); window.addEventListener('hashchange', () => x.remove(), { once: true }); return x; })();
    const again = (t, m) => hrProfile(id, t || tab, m || month);
    const done = () => { again(); if (['hr', 'attendance', 'leave'].includes(CURRENT))
        hrReload(); };
    const sens = e.basic !== undefined;
    const head = h('div', { class: 'stack' }, h('div', { class: 'row sp' }, h('div', { class: 'hr-head' }, hrAvatar(e, 60), h('div', null, h('h2', null, e.name), h('div', { class: 'muted' }, [e.designation, e.department].filter(Boolean).join(' · ') || '—'), h('div', { class: 'row', style: { marginTop: '4px' } }, hrEB(e.status), e.status !== 'active' && e.leave_date ? h('span', { class: 'small muted' }, 'last day ' + day(e.leave_date)) : null, e.phone ? h('a', { class: 'small', href: 'tel:' + e.phone }, e.phone) : null))), h('button', { class: 'btn ghost sm', onclick: () => dr.remove() }, 'Close')), can('hr') ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => hrEmpForm(e, done) }, 'Edit'), h('button', { class: 'btn ghost sm', onclick: () => hrWarnModal(e, () => again('warnings')) }, 'Warning / note'), e.status !== 'left' ? h('button', { class: 'btn ghost sm', onclick: () => hrLeftModal(e, done) }, 'Mark as left') : null) : null);
    const T = [['details', 'Details'], ['attendance', 'Attendance'], ['leave', 'Leave'], ['advances', 'Advances'], ['payslips', 'Payslips']];
    if (can('hr'))
        T.push(['warnings', 'Warnings', d.warnings.length || null]);
    let body;
    if (tab === 'details') {
        const kv = (k, v) => v || v === 0 ? [h('dt', null, k), h('dd', null, v)] : null;
        const docs = e.docs || [];
        body = h('div', { class: 'stack', style: { gap: '14px' } }, h('div', { class: 'card' }, h('dl', { class: 'dl' }, kv('Joined', e.join_date && day(e.join_date) + ' ' + e.join_date.slice(0, 4)), kv('Shift', hrHM(e.shift_start) + ' – ' + hrHM(e.shift_end) + ` (grace ${e.grace_min} min)`), kv('Weekly off', (e.off_days || []).map(x => HR_WD[x]).join(', ') || 'none'), kv('ERP login', d.user ? d.user.name + ' (' + d.user.username + ')' + (d.user.active ? '' : ' · blocked') : 'not linked — cannot self check-in'), sens ? [kv('Basic salary', rs(e.basic)), kv('Allowances', rs(e.allowances)), kv('Gross / month', h('strong', null, rs((e.basic || 0) + (e.allowances || 0)))), kv('Paid by', [e.pay_method, e.bank_account].filter(Boolean).join(' · ')),
            kv('CNIC', e.cnic), kv('Address', e.address), kv('Emergency', e.emergency)] : null, kv('Leaving reason', e.leave_reason), kv('Notes', e.notes))), h('div', { class: 'card' }, h('h2', null, 'Documents', can('hr') ? h('button', { class: 'btn ghost sm spacer', onclick: () => formModal('Add document', [{ k: 'name', label: 'Name', required: true, placeholder: 'CNIC copy, CV, contract…' }, { k: 'file', label: 'File', type: 'file', required: true }], async (v) => { await POST('/api/hr/employees/' + e.id, { docs: docs.concat([{ id: v.file, name: v.name }]) }); again('details'); }) }, '+ Add') : null), docs.length ? h('div', { class: 'stack' }, docs.map(x => h('div', { class: 'row sp' }, h('a', { href: '/api/files/' + x.id, target: '_blank' }, icon('doc', 15), ' ', x.name), can('hr') ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST('/api/hr/employees/' + e.id, { docs: docs.filter(y => y.id !== x.id) })).then(() => again('details')) }, 'Remove') : null))) : h('div', { class: 'small muted' }, 'No documents yet (CNIC copy, CV, contract).')), d.history.length ? h('div', { class: 'card' }, h('h2', null, 'History'), h('div', { class: 'timeline' }, d.history.slice(0, 15).map(x => h('div', null, h('div', null, x.label || x.action, x.user ? ' · ' + x.user : ''), h('div', { class: 't' }, dt(x.at)))))) : null);
    }
    else if (tab === 'attendance') {
        const a = d.attendance, first = new Date(month + '-01T00:00:00Z').getUTCDay();
        body = h('div', { class: 'stack', style: { gap: '12px' } }, h('div', { class: 'row sp' }, hrMonthPicker(month, m => again('attendance', m))), h('div', { class: 'hr-mini' }, [['Present', a.present, 'ok'], ['Late', a.late, a.late ? 'warn' : ''], ['Absent', a.absent, a.absent ? 'bad' : ''], ['Leave', a.leave, ''], ['Unpaid', a.unpaid, ''], ['Working days', a.workdays, '']].map(([k, v, c]) => h('div', { class: c }, h('b', null, num(v)), h('span', null, k)))), h('div', { class: 'card' }, h('div', { class: 'hr-cal' }, HR_WD.map(w => h('div', { class: 'hd' }, w)), Array.from({ length: first }, () => h('div')), a.cells.map(c => h('div', { class: 'd' + (can('hr') && c.s !== 'na' && c.d <= todayStr() ? ' click' : '') + (c.d === todayStr() ? ' today' : ''), title: c.in_at ? `in ${hrT(c.in_at)}${c.out_at ? ' · out ' + hrT(c.out_at) : ''}${c.late_min ? ' · ' + c.late_min + ' min late' : ''}` : (HR_ST[c.s] || [, ''])[1],
            onclick: can('hr') && c.s !== 'na' && c.d <= todayStr() ? () => hrAttEditModal(e, c.d, c, () => again('attendance')) : null }, h('span', { class: 'n' }, +c.d.slice(8)), c.c ? h('span', { class: 'hr-c hr-c-' + c.c }, c.c) : '', c.in_at ? h('span', { class: 'hr-ed' }, hrT(c.in_at).replace(' ', '')) : '')))), can('hr') ? h('div', { class: 'small muted' }, 'Tap a day to correct it. Every change is saved in the log with your reason.') : null);
    }
    else if (tab === 'leave') {
        body = h('div', { class: 'stack', style: { gap: '12px' } }, h('div', { class: 'row sp' }, h('div', { class: 'hr-chips' }, d.balances.map(b => h('span', { class: 'hr-chip' }, b.name + ': ', h('b', null, b.left == null ? b.used + ' used' : `${b.left} of ${b.quota} left`)))), can('hr') ? h('button', { class: 'btn sm', onclick: () => hrLeaveAddModal(e.id, () => again('leave')) }, '+ Record leave') : null), h('div', { class: 'card' }, table([{ t: 'Type', f: l => (d.balances.find(b => b.key === l.type) || { name: l.type }).name }, { t: 'Dates', f: l => hrDates(l.from_day, l.to_day) + (l.half ? ' (half)' : '') }, { t: 'Days', n: 1, k: 'days' },
            { t: 'Reason', f: l => h('span', { class: 'small' }, l.reason || '') }, { t: 'Status', f: l => h('span', { class: 'b ' + ({ approved: 'ok', rejected: 'bad', pending: 'warn' }[l.status] || '') }, l.status) }], d.leaves)));
    }
    else if (tab === 'advances') {
        const A = d.advances;
        body = h('div', { class: 'stack', style: { gap: '12px' } }, h('div', { class: 'kpis hr-kpis' }, kpi('Balance to recover', rs(A.balance), A.plan ? rs(A.plan) + ' / month planned' : null, A.balance ? 'warn' : ''), kpi('Given in total', rs(A.given)), kpi('Recovered in payroll', rs(A.recovered))), can('payroll') ? h('div', null, h('button', { class: 'btn sm', onclick: () => hrAdvanceModal(e.id, () => again('advances')) }, '+ Give advance')) : null, h('div', { class: 'card' }, table([{ t: 'Date', f: x => day(x.day) }, { t: 'Amount', n: 1, f: x => rs(x.amount) }, { t: 'From', k: 'method' }, { t: 'Monthly cut', n: 1, f: x => x.monthly ? rs(x.monthly) : '—' }, { t: 'Still due', n: 1, f: x => rs(x.remaining) }, { t: 'Note', k: 'note' }], A.advances)));
    }
    else if (tab === 'payslips') {
        body = h('div', { class: 'card' }, table([{ t: 'Month', f: p => hrMonthName(p.month) }, { t: 'Gross', n: 1, f: p => rs(p.gross) }, { t: 'Net', n: 1, f: p => h('strong', null, rs(p.net)) },
            { t: 'Status', f: p => p.status !== 'approved' ? h('span', { class: 'b' }, 'draft') : h('span', { class: 'b ' + (p.paid ? 'ok' : 'warn') }, p.paid ? 'paid' : 'unpaid') },
            { t: '', f: p => can('payroll') ? h('a', { class: 'btn ghost sm', href: `#/payslip/${p.month}/${e.id}`, onclick: () => dr.remove() }, 'Payslip') : '' }], d.payslips));
    }
    else {
        body = h('div', { class: 'stack' }, h('div', null, h('button', { class: 'btn sm', onclick: () => hrWarnModal(e, () => again('warnings')) }, '+ Warning / note')), d.warnings.length ? h('div', { class: 'card' }, h('div', { class: 'timeline' }, d.warnings.map(w => h('div', null, h('div', { class: 'row' }, h('span', { class: 'b ' + (HR_WARN[w.type] || [''])[0] }, (HR_WARN[w.type] || [, w.type])[1]), h('strong', null, day(w.day) + ' ' + w.day.slice(0, 4))), h('div', null, w.note), h('div', { class: 't row' }, 'by ' + (w.by_name || '—'), fileLink(w.file), h('a', { href: '#', class: 'small', onclick: ev => { ev.preventDefault(); if (confirm('Delete this record?'))
                act(() => api('DELETE', '/api/hr/warnings/' + w.id)).then(() => again('warnings')); } }, 'Delete')))))) : h('div', { class: 'empty' }, 'No warnings. Good.'));
    }
    dr.querySelector('.in').replaceChildren(head, tabs(T, tab, t => again(t)), body);
}
registerView({ key: 'hr', title: 'Employees', group: 'People', perm: 'hr', icon: 'user', order: 10 }, async (args) => {
    const st = { q: store.get('hr_q', ''), dept: store.get('hr_dept', ''), status: store.get('hr_status', 'current') };
    const [list] = await Promise.all([hrEmps(true)]);
    const box = h('div', { style: { minWidth: '0' } });
    const draw = () => {
        store.set('hr_dept', st.dept);
        store.set('hr_status', st.status);
        const s = st.q.toLowerCase();
        const rows = list.filter(e => (st.status === 'all' || (st.status === 'current' ? e.status !== 'left' : e.status === st.status)) && (!st.dept || e.department === st.dept)
            && (!s || [e.name, e.phone, e.designation, e.department, e.username].some(x => String(x || '').toLowerCase().includes(s))));
        const sens = list.some(e => e.basic !== undefined);
        box.replaceChildren(h('div', { class: 'card pad0' }, table([
            { t: 'Employee', f: e => hrPerson(e, [e.designation, e.department].filter(Boolean).join(' · ')) },
            { t: 'Today', f: e => e.today ? h('div', null, hrB(e.today.status), e.today.in_at ? h('div', { class: 'small muted' }, hrT(e.today.in_at) + (e.today.late_min ? ` · ${e.today.late_min}m late` : '')) : null) : '' },
            { t: 'Phone', f: e => e.phone ? h('a', { href: 'tel:' + e.phone, class: 'mono' }, e.phone) : '' },
            { t: 'Joined', f: e => e.join_date ? day(e.join_date) + ' ' + e.join_date.slice(2, 4) : '' },
            sens ? { t: 'Salary', n: 1, f: e => rs((e.basic || 0) + (e.allowances || 0)) } : null,
            { t: 'Status', f: e => h('div', null, hrEB(e.status), !e.user_id && e.status !== 'left' ? h('div', { class: 'small muted' }, 'no login') : null) },
        ].filter(Boolean), rows, e => hrProfile(e.id))));
    };
    const cur = list.filter(e => e.status !== 'left'), sens = list.some(e => e.basic !== undefined), T = x => cur.filter(e => e.today && e.today.status === x).length;
    const search = h('input', { placeholder: 'Search name, phone, job…', value: st.q, oninput: () => { st.q = search.value; store.set('hr_q', st.q); draw(); }, style: { flex: '1', minWidth: '160px' } });
    hrRender(pageHead('Employees', `${cur.filter(e => e.status === 'active').length} active · ${cur.filter(e => e.status === 'notice').length} on notice`, h('a', { class: 'btn ghost', href: '#/attendance' }, 'Attendance'), h('button', { class: 'btn primary', onclick: () => hrEmpForm(null, id => { hrReload(); setTimeout(() => hrProfile(id), 300); }) }, '+ Add employee')), h('div', { class: 'kpis hr-kpis' }, kpi('Staff', num(cur.length), [...new Set(cur.map(e => e.department).filter(Boolean))].length + ' departments'), kpi('In today', num(T('present') + T('late') + T('half')), T('not_yet') ? T('not_yet') + ' not in yet' : 'checked in', 'good', '#/attendance'), kpi('Late today', num(T('late')), 'after shift + grace', T('late') ? 'warn' : '', '#/attendance'), kpi('Absent today', num(T('absent')), 'no check-in, no leave', T('absent') ? 'alert' : '', '#/attendance'), sens ? kpi('Monthly salaries', rs(cur.reduce((s, e) => s + (e.basic || 0) + (e.allowances || 0), 0)), 'basic + allowances') : null), h('div', { class: 'toolbar' }, search, h('select', { onchange: ev => { st.dept = ev.target.value; draw(); } }, h('option', { value: '' }, 'All departments'), HR_DEPTS.map(d => h('option', { value: d, selected: st.dept === d }, d))), h('select', { onchange: ev => { st.status = ev.target.value; draw(); } }, [['current', 'Working now'], ['active', 'Active'], ['notice', 'On notice'], ['left', 'Left'], ['all', 'Everyone']].map(([v, l]) => h('option', { value: v, selected: st.status === v }, l)))), list.length ? box : h('div', { class: 'card' }, h('div', { class: 'empty' }, 'No employees yet. Click "+ Add employee" to start. Link each person to their ERP login so they can check in from their phone.')));
    if (list.length)
        draw();
    if (args[0] && /^\d+$/.test(args[0]))
        hrProfile(+args[0]);
});
/* ---------- Operations: shared helpers (team report, performance, tasks) ---------- */
(function opsCss() {
    if (document.getElementById('ops-css'))
        return;
    const s = document.createElement('style');
    s.id = 'ops-css';
    s.textContent = `
.ops-list{display:grid;gap:8px}
.ops-row{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(130px,1fr) minmax(120px,.9fr) minmax(170px,1.5fr) 70px minmax(90px,.7fr) minmax(150px,1.4fr);gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px 14px;cursor:pointer;box-shadow:var(--shadow)}
.ops-row:hover{border-color:var(--muted)}
.ops-row.hd{background:transparent;border:0;box-shadow:none;cursor:default;padding:0 14px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
.ops-row.bad{border-left:3px solid var(--bad)} .ops-row.warn{border-left:3px solid var(--warn)}
.ops-row .lbl{display:none}
.ops-nm{font-weight:600;line-height:1.25} .ops-sub{font-size:12px;color:var(--muted)}
.ops-score{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;text-align:right}
.ops-score.ok{color:var(--ok)} .ops-score.warn{color:var(--warn)} .ops-score.bad{color:var(--bad)} .ops-score.none{color:var(--muted);font-weight:500}
.ops-flags{display:flex;flex-wrap:wrap;gap:4px}
.ops-part{display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:12px;align-items:center}
.ops-part .bar{grid-column:1/-1;height:6px}
.ops-parts{display:grid;gap:6px}
.ops-av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--ink);font-weight:700;font-size:11px;flex:none}
.ops-tl > div{display:grid;grid-template-columns:52px 1fr;gap:8px}
.ops-tl .t{font-family:var(--mono)}
.ops-tl .pres::before{border-color:var(--muted)!important}
.ops-gap{color:var(--warn);font-size:12px;font-weight:600}
.ops-task{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);cursor:pointer}
.ops-task:hover{border-color:var(--muted)}
.ops-task.done .ops-tt{text-decoration:line-through;color:var(--muted)}
.ops-tt{font-weight:600}
.ops-chk{width:22px;height:22px;border-radius:6px;border:2px solid var(--line);background:var(--panel);cursor:pointer;display:grid;place-items:center;padding:0;color:var(--ok)}
.ops-chk.on{background:var(--ok);border-color:var(--ok);color:#fff}
.ops-sec{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin:6px 0 2px;display:flex;gap:8px;align-items:center}
.ops-sec.bad{color:var(--bad)}
.ops-cl label{display:flex;gap:8px;align-items:center;padding:4px 0;font-size:14px}
.ops-cmt{background:var(--soft);border-radius:10px;padding:8px 10px;font-size:13px;white-space:pre-wrap}
.ops-eod textarea{min-height:64px;width:100%}
.ops-note{white-space:pre-wrap;font-size:13px}
.ops-kv{display:flex;flex-wrap:wrap;gap:6px}
.ops-kv span{background:var(--soft);border-radius:999px;padding:2px 10px;font-size:12px}
.ops-kv b{font-variant-numeric:tabular-nums}
.ops-spark{width:120px;height:28px;display:block}
.ops-picks{display:flex;flex-wrap:wrap;gap:6px}
.ops-picks label{display:flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:13px;cursor:pointer}
.ops-datebar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ops-tgt td input{width:84px}
.ops-review{display:grid;gap:8px}
.ops-review > div{border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:10px;padding:10px 12px;background:var(--panel);cursor:pointer}
.ops-kpis{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}
.ops-dept{display:grid;gap:2px}
.ops-dbar{display:grid;grid-template-columns:150px minmax(80px,1fr) 36px minmax(0,1.1fr);gap:10px;align-items:center;padding:7px 8px;border-radius:8px;color:inherit;text-decoration:none}
.ops-dbar:hover{background:var(--hover)}
.ops-dt{height:14px;background:var(--soft);border-radius:4px;overflow:hidden;display:block}
.ops-dt i{display:block;height:100%;background:var(--muted);opacity:.55;border-radius:4px} .ops-dt i.in{background:var(--bad);opacity:1}
.ops-dn{text-align:right;font-variant-numeric:tabular-nums}
.ops-dr{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:640px){.ops-dbar{grid-template-columns:minmax(0,1fr) 36px;gap:4px 10px}.ops-dbar .ops-dt{grid-column:1/-1;grid-row:2}.ops-dbar .ops-dr{grid-column:1/-1;white-space:normal}}
@media (max-width:640px){.ops-kpis{grid-template-columns:1fr 1fr!important;gap:8px}.ops-kpis .kpi{padding:10px 12px}.ops-kpis .kpi .v{font-size:20px}.ops-kpis .kpi .s{font-size:11px}}
@media (max-width:1100px){
  .ops-row{grid-template-columns:1fr 1fr;gap:8px 12px}
  .ops-row.hd{display:none}
  .ops-row .lbl{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
  .ops-row:not(.hd){grid-template-areas:"name score" "att act" "out out" "tasks flags"}
  .ops-row > .c-name{grid-area:name} .ops-row > .c-score{grid-area:score;justify-self:end;align-self:start}
  .ops-row > .c-att{grid-area:att} .ops-row > .c-act{grid-area:act} .ops-row > .c-out{grid-area:out} .ops-row > .c-tasks{grid-area:tasks} .ops-row > .c-flags{grid-area:flags;align-self:start}
  .ops-score{text-align:right}
}`;
    document.head.append(s);
})();
const OPS_ST = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', done: 'Done' };
const OPS_PRIO = { urgent: 'bad', high: 'warn', normal: '', low: '' };
const OPS_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const opsInitials = n => String(n || '?').replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const opsScoreCls = s => s == null ? 'none' : s >= 90 ? 'ok' : s >= 50 ? 'warn' : 'bad';
const opsScore = (s, tracked) => h('div', { class: 'ops-score ' + opsScoreCls(s), title: s == null ? (tracked === false ? 'No measurable target for this person — not scored' : 'No score') : 'Score: weighted % of targets met (max 150%)' }, s == null ? '—' : s + '%');
const opsFlag = f => h('span', { class: 'b ' + (f.lv === 'info' ? '' : f.lv), title: f.t }, f.t);
const opsAddDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const opsDayName = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
function opsAtt(a) {
    if (!a)
        return '';
    const M = { present: ['Present', 'ok'], late: ['Late', 'warn'], absent: ['Absent', 'bad'], leave: ['On leave', 'info'], off: ['Off day', ''], holiday: ['Holiday', ''], not_yet: ['Not in yet', ''], half_day: ['Half day', 'warn'], active: ['Active', 'ok'], none: ['No activity', ''] };
    const [l, c] = M[a.status] || [String(a.status || '').replace(/_/g, ' '), ''];
    const times = a.in ? (a.in + (a.out ? '–' + a.out : '')) : '';
    return h('div', null, h('span', { class: 'b ' + c }, l), times ? h('div', { class: 'ops-sub' }, a.source === 'hr' ? 'In ' + times : 'Seen ' + times) : null);
}
function opsPart(p) {
    const pc = Math.round(100 * p.actual / p.target);
    return h('div', { class: 'ops-part' }, h('span', null, p.label), h('strong', null, num(p.actual), h('span', { class: 'muted' }, ' / ' + num(p.target))), h('div', { class: 'bar ' + (pc >= 90 ? 'ok' : pc >= 50 ? 'warn' : 'bad') }, h('i', { style: { width: Math.min(100, pc) + '%' } })));
}
function opsSpark(vals, max = 150) {
    const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 120 28');
    s.setAttribute('class', 'ops-spark');
    const pts = vals.map((v, i) => [vals.length > 1 ? i * 120 / (vals.length - 1) : 60, v == null ? null : 26 - 24 * Math.min(v, max) / max]);
    const ref = document.createElementNS(ns, 'line');
    Object.entries({ x1: 0, x2: 120, y1: 26 - 24 * 50 / max, y2: 26 - 24 * 50 / max, stroke: 'currentColor', 'stroke-opacity': .18, 'stroke-dasharray': '3 3' }).forEach(([k, v]) => ref.setAttribute(k, v));
    s.append(ref);
    let d = '', pen = false;
    for (const [x, y] of pts) {
        if (y == null) {
            pen = false;
            continue;
        }
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        pen = true;
    }
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', C2);
    p.setAttribute('stroke-width', '1.8');
    s.append(p);
    for (const [x, y] of pts)
        if (y != null) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', x);
            c.setAttribute('cy', y);
            c.setAttribute('r', vals.length > 40 ? 0.8 : 1.6);
            c.setAttribute('fill', C2);
            s.append(c);
        }
    return s;
}
const opsDue = t => t.due_date ? (t.due_date === todayStr() ? 'Today' : t.due_date === opsAddDay(todayStr(), 1) ? 'Tomorrow' : day(t.due_date)) + (t.due_time ? ' ' + t.due_time : '') : '';
/* ---------- person's day (drawer) ---------- */
async function opsPersonDrawer(key, date) {
    const d = await GET(`/api/ops/person/${encodeURIComponent(key)}?date=${date || todayStr()}`), r = d.row;
    const tl = [];
    let prev = null;
    for (const it of r.items || []) {
        if (prev && it.kind !== 'presence') {
            const g = (+it.at.slice(0, 2) * 60 + +it.at.slice(3, 5)) - (+prev.slice(0, 2) * 60 + +prev.slice(3, 5));
            if (g >= 45)
                tl.push(h('div', { class: 'pres' }, h('span', { class: 't' }, ''), h('span', { class: 'ops-gap' }, `No activity for ${g >= 60 ? Math.floor(g / 60) + 'h ' + (g % 60) + 'm' : g + ' min'}`)));
        }
        if (it.kind !== 'presence')
            prev = it.at;
        tl.push(h('div', { class: it.kind === 'presence' ? 'pres' : '' }, h('span', { class: 't' }, it.at.slice(0, 5)), h('span', null, h('span', { class: it.kind === 'presence' ? 'muted' : '' }, it.label, it.n > 1 ? ` ×${it.n}` : ''), it.detail ? h('span', { class: 'small muted' }, ' · ' + it.detail) : null)));
    }
    const trend = d.trend.map(x => ({ day: x.day, score: x.workday && x.present ? (x.score || 0) : 0, actions: x.actions || 0 }));
    const scored = d.trend.filter(x => x.workday && x.present && x.score != null);
    const head = h('div', { class: 'row sp' }, h('div', { class: 'person' }, h('span', { class: 'ops-av' }, opsInitials(r.name)), h('div', null, h('div', { class: 'ops-nm', style: { fontSize: '17px' } }, r.name), h('div', { class: 'ops-sub' }, r.roleLabel, ' · ', opsDayName(d.date), ' · shift ', r.shift))), h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => { dr.remove(); opsPersonDrawer(key, opsAddDay(d.date, -1)); } }, '‹ Prev day'), d.date < todayStr() ? h('button', { class: 'btn ghost sm', onclick: () => { dr.remove(); opsPersonDrawer(key, opsAddDay(d.date, 1)); } }, 'Next day ›') : null, h('button', { class: 'btn ghost sm', onclick: () => dr.remove() }, 'Close')));
    const dr = drawer(h('div', { class: 'stack', style: { display: 'grid', gap: '14px' } }, head, h('div', { class: 'kpis ops-kpis' }, kpi('Score', r.score == null ? '—' : r.score + '%', r.penalty ? `${r.baseScore}% − ${r.penalty} for ${r.mistakes.length} mistake${r.mistakes.length > 1 ? 's' : ''}` : r.tracked ? (d.date === todayStr() ? 'so far today' : 'of targets') : 'no measurable target', r.score == null ? '' : r.score >= 90 ? 'good' : r.score >= 50 ? 'warn' : 'alert'), kpi('Attendance', opsAtt(r.att), r.att.source === 'hr' ? 'from HR check-in' : 'from ERP activity (no HR record)'), kpi('First / last action', r.first ? r.first + ' – ' + r.last : '—', num(r.actions) + ' actions'), kpi('Longest idle gap', r.idle ? (r.idle.min >= 60 ? Math.floor(r.idle.min / 60) + 'h ' + Math.round(r.idle.min % 60) + 'm' : Math.round(r.idle.min) + ' min') : '—', r.idle ? `${r.idle.from}–${r.idle.to}, in working hours` : 'in working hours', r.flags.some(f => f.k === 'idle') ? 'warn' : '')), r.flags.length ? h('div', { class: 'ops-flags' }, r.flags.map(opsFlag)) : null, (r.mistakes || []).length ? h('div', { class: 'card' }, h('h2', null, 'Mistakes', h('small', null, ' · customer problems traced to ' + r.name + ', closed on this day')), opsMistakeList(r.mistakes, () => dr.remove())) : null, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Output vs target'), r.targets.length ? h('div', { class: 'ops-parts' }, r.targets.map(opsPart)) : h('div', { class: 'muted small' }, 'No measurable target for this role, so no score. Their actions are still listed.'), h('h2', { style: { marginTop: '14px' } }, 'Actions by type'), r.labels.length ? table([{ t: 'Action', k: 'l' }, { t: 'Count', n: 1, f: x => num(x.n) }], r.labels) : h('div', { class: 'muted small' }, 'Nothing recorded in the ERP.')), h('div', { class: 'card' }, h('h2', null, 'End-of-day note'), r.eod ? opsEodView(r.eod) : h('div', { class: 'muted small' }, 'Not written.'), h('h2', { style: { marginTop: '14px' } }, 'Tasks'), d.tasks.length ? h('div', { class: 'grid' }, d.tasks.map(t => h('div', { class: 'row sp small' }, h('a', { href: '#/tasks/view/' + t.id, onclick: () => dr.remove() }, t.title), h('span', { class: 'b ' + (t.status === 'done' ? 'ok' : t.due_date < d.date ? 'bad' : '') }, t.status === 'done' ? 'Done ' + (t.done_at || '').slice(11, 16) : t.due_date < d.date ? 'Overdue' : OPS_ST[t.status])))) : h('div', { class: 'muted small' }, 'No tasks due.'))), h('div', { class: 'card' }, h('h2', null, 'Last 30 days', h('small', null, scored.length ? ` · average score ${Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length)}% over ${scored.length} working days` : r.tracked ? '' : ' · actions per day (no target)')), r.tracked ? chart(trend, 'day', [{ k: 'score', l: 'Score %', c: C2 }], 140) : chart(trend, 'day', [{ k: 'actions', l: 'ERP actions', c: C3 }], 140)), h('div', { class: 'card' }, h('h2', null, 'Timeline', h('small', null, ' · every action recorded, Pakistan time')), tl.length ? h('div', { class: 'timeline ops-tl' }, tl) : h('div', { class: 'empty' }, 'No activity recorded on this day.'))));
    const off = () => { dr.remove(); window.removeEventListener('hashchange', off); };
    window.addEventListener('hashchange', off);
}
function opsMistakeList(list, onGo) {
    return h('div', { class: 'grid', style: { gap: '6px' } }, list.map(x => h('div', { class: 'row sp', style: { borderTop: '1px solid var(--line)', paddingTop: '6px' } }, h('div', { style: { minWidth: 0 } }, can('tickets') ? h('a', { href: '#/tickets/open/' + x.id, onclick: () => onGo && onGo() }, 'T-' + x.id) : h('span', { class: 'mono' }, 'T-' + x.id), ' · ', h('strong', null, x.reason || x.deptLabel + ' mistake'), h('div', { class: 'small muted' }, [x.day ? day(x.day) : null, x.deptLabel, x.type, x.order_name].filter(Boolean).join(' · '))), x.cost ? h('span', { class: 'small' }, rs(x.cost)) : null)));
}
function opsEodView(e) {
    return h('div', { class: 'grid', style: { gap: '6px' } }, h('div', null, h('div', { class: 'small muted' }, 'What I did'), h('div', { class: 'ops-note' }, e.did)), e.problems ? h('div', null, h('div', { class: 'small muted' }, 'Problems'), h('div', { class: 'ops-note' }, e.problems)) : null, e.plan ? h('div', null, h('div', { class: 'small muted' }, 'Plan for tomorrow'), h('div', { class: 'ops-note' }, e.plan)) : null, h('div', { class: 'small muted' }, 'Written ', (e.at || '').slice(11, 16)));
}
/* ---------- end-of-day form ---------- */
function opsEodForm(note, onSaved, opts = {}) {
    const did = h('textarea', { placeholder: 'e.g. Called 85 customers, confirmed 52 orders, cleared WhatsApp inbox' }, note ? note.did : '');
    const prob = h('textarea', { placeholder: 'Anything that stopped you or slowed you down (optional)' }, note ? note.problems : '');
    const plan = h('textarea', { placeholder: 'What you will do first tomorrow (optional)' }, note ? note.plan : '');
    const msg = note ? h('div', { class: 'note ok' }, 'Saved at ', (note.at || '').slice(11, 16), '. You can still change it today.') : (opts.remind ? h('div', { class: 'note warn' }, `Please write this before you leave (reminder at ${opts.remind}).`) : null);
    return h('div', { class: 'ops-eod grid' }, msg, field('What I did today *', did), opts.compact ? null : field('Problems', prob), opts.compact ? null : field('Plan for tomorrow', plan), h('div', null, h('button', { class: 'btn primary', onclick: () => act(() => POST('/api/ops/eod', { did: did.value, problems: prob.value, plan: plan.value }), 'End-of-day report saved').then(onSaved) }, note ? 'Update report' : 'Submit report')));
}
/* ---------- task create / edit form ---------- */
async function opsTaskForm(t, onSaved, preset) {
    const pp = await GET('/api/ops/people');
    t = t || Object.assign({ title: '', description: '', priority: 'normal', due_date: todayStr(), due_time: '', assignees: [{ id: ME.id }], checklist: [], files: [], link_type: '', link_ref: '' }, (preset || {}));
    const title = h('input', { value: t.title, placeholder: 'e.g. Count rack A' });
    const desc = h('textarea', { placeholder: 'Details (optional)' }, t.description || '');
    const prio = h('select', null, ['low', 'normal', 'high', 'urgent'].map(p => h('option', { value: p, selected: p === t.priority }, p[0].toUpperCase() + p.slice(1))));
    const dd = h('input', { type: 'date', value: t.due_date || '' }), dtm = h('input', { type: 'time', value: t.due_time || '' });
    const sel = new Set((t.assignees || []).map(a => a.id));
    const who = pp.team ? h('div', { class: 'ops-picks' }, pp.users.map(u => h('label', null, h('input', { type: 'checkbox', checked: sel.has(u.id), onchange: e => e.target.checked ? sel.add(u.id) : sel.delete(u.id) }), u.name, h('span', { class: 'small muted' }, u.roleLabel)))) : h('div', { class: 'small muted' }, 'This task is for you. (Managers can assign tasks to others.)');
    const cl = h('textarea', { placeholder: 'One item per line (optional)' }, (t.checklist || []).map(c => c.t).join('\n'));
    const lt = h('select', null, [['', 'No link'], ['order', 'Order number'], ['sku', 'SKU'], ['ticket', 'Ticket']].map(([v, l]) => h('option', { value: v, selected: v === (t.link_type || '') }, l)));
    const lr = h('input', { value: t.link_ref || '', placeholder: 'e.g. SB84561' });
    const files = [...(t.files || [])];
    const fl = h('div', { class: 'row small' });
    const drawFiles = () => fl.replaceChildren(...files.map((id, i) => h('span', { class: 'b' }, h('a', { href: '/api/files/' + id, target: '_blank' }, 'File ' + (i + 1)), h('a', { style: { cursor: 'pointer' }, onclick: () => { files.splice(i, 1); drawFiles(); } }, ' ×'))));
    drawFiles();
    const up = h('input', { type: 'file', accept: 'image/*,application/pdf', onchange: async (e) => { for (const f of e.target.files) {
            try {
                files.push(await uploadFile(f));
            }
            catch (x) {
                toast(x.message, true);
            }
        } e.target.value = ''; drawFiles(); } });
    const err = h('div', { class: 'flash bad', hidden: true });
    const m = modal(t.id ? 'Edit task' : 'New task', h('div', { class: 'grid' }, err, field('Title *', title), field('Details', desc), h('div', { class: 'three' }, field('Due date', dd), field('Due time', dtm), field('Priority', prio)), field(pp.team ? 'Assign to (tick one or more)' : 'Assigned to', who), field('Checklist', cl), h('div', { class: 'two' }, field('Link to', lt), field('Number / SKU', lr)), field('Attachments (photo / PDF)', h('div', { class: 'grid' }, up, fl))), [h('button', { class: 'btn primary', onclick: async () => {
                const body = { title: title.value, description: desc.value, priority: prio.value, due_date: dd.value || null, due_time: dtm.value || null, assignees: pp.team ? [...sel] : [ME.id],
                    checklist: cl.value.split('\n').map(x => x.trim()).filter(Boolean).map(x => ({ t: x, done: !!(t.checklist || []).find(c => c.t === x && c.done) })), link_type: lt.value || null, link_ref: lr.value || null, files };
                try {
                    const r = t.id ? await POST('/api/ops/tasks/' + t.id, body) : await POST('/api/ops/tasks', body);
                    m.remove();
                    toast(t.id ? 'Task saved' : 'Task created');
                    onSaved && onSaved(r);
                }
                catch (e) {
                    err.hidden = false;
                    err.textContent = e.message;
                }
            } }, t.id ? 'Save' : 'Create task')]);
}
/* ---------- task detail ---------- */
async function opsTaskModal(id, onChange) {
    const t = await GET('/api/ops/tasks/' + id);
    const setStatus = async (s) => { let note = ''; if (s === 'blocked') {
        note = prompt('What is blocking this task?');
        if (!note)
            return;
    } await act(() => POST('/api/ops/tasks/' + id, { status: s, note }), s === 'done' ? 'Marked done' : 'Status changed'); m.remove(); onChange && onChange(); opsTaskModal(id, onChange); };
    const tick = async (i) => { const cl = t.checklist.map((c, k) => k === i ? Object.assign(Object.assign({}, c), { done: !c.done }) : c); await act(() => POST('/api/ops/tasks/' + id, { checklist: cl })); m.remove(); onChange && onChange(); opsTaskModal(id, onChange); };
    const cm = h('textarea', { placeholder: 'Write a comment or update…', style: { minHeight: '56px' } });
    const link = t.link_ref ? (t.link_type === 'order' && can('orders') ? h('a', { href: '#', onclick: e => { e.preventDefault(); m.remove(); openOrder(t.link_ref); } }, 'Order ' + t.link_ref) : t.link_type === 'ticket' ? h('a', { href: '#/tickets/' + encodeURIComponent(t.link_ref), onclick: () => m.remove() }, 'Ticket ' + t.link_ref) : h('span', null, (t.link_type === 'sku' ? 'SKU ' : '') + t.link_ref)) : null;
    const m = modal(t.title, h('div', { class: 'grid' }, h('div', { class: 'row' }, h('span', { class: 'b ' + (t.status === 'done' ? 'ok' : t.status === 'blocked' ? 'bad' : t.status === 'doing' ? 'info' : '') }, OPS_ST[t.status]), t.priority !== 'normal' ? h('span', { class: 'b ' + OPS_PRIO[t.priority] }, t.priority) : null, t.overdue ? h('span', { class: 'b bad' }, 'Overdue') : null, t.template ? h('span', { class: 'b' }, 'Recurring') : null), h('dl', { class: 'dl' }, h('dt', null, 'Due'), h('dd', null, opsDue(t) || 'No due date'), h('dt', null, 'Assigned to'), h('dd', null, t.assignees.map(a => a.name).join(', ') || '—'), h('dt', null, 'Created by'), h('dd', null, (t.creator || 'Recurring task'), ' · ', (t.created_at || '').slice(0, 16)), link ? [h('dt', null, 'Linked'), h('dd', null, link)] : null, t.done_at ? [h('dt', null, 'Done'), h('dd', null, t.done_at.slice(0, 16))] : null), t.description ? h('div', { class: 'ops-note' }, t.description) : null, t.checklist.length ? h('div', { class: 'ops-cl' }, h('div', { class: 'small muted' }, `Checklist ${t.checklist.filter(c => c.done).length}/${t.checklist.length}`), t.checklist.map((c, i) => h('label', null, h('input', { type: 'checkbox', checked: c.done, onchange: () => tick(i) }), h('span', { style: c.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : null }, c.t)))) : null, t.files.length ? h('div', { class: 'row' }, t.files.map((f, i) => h('a', { class: 'btn ghost sm', href: '/api/files/' + f, target: '_blank' }, icon('doc', 14), 'Attachment ' + (i + 1)))) : null, h('div', { class: 'row' }, ['todo', 'doing', 'blocked', 'done'].filter(s => s !== t.status).map(s => h('button', { class: 'btn sm ' + (s === 'done' ? 'ok' : s === 'blocked' ? 'warn' : 'ghost'), onclick: () => setStatus(s) }, s === 'done' ? '✓ Mark done' : s === 'todo' ? 'Back to To do' : s === 'doing' ? 'Start (Doing)' : 'Blocked…'))), h('div', null, h('div', { class: 'small muted', style: { marginBottom: '6px' } }, 'Updates'), h('div', { class: 'timeline' }, t.comments.map(c => h('div', null, h('div', { class: 't' }, (c.user || 'System'), ' · ', (c.at || '').slice(5, 16)), c.kind === 'comment' ? h('div', { class: 'ops-cmt' }, c.text) : h('div', { class: 'muted' }, c.text))))), h('div', { class: 'grid' }, cm, h('div', null, h('button', { class: 'btn sm', onclick: async () => { if (!cm.value.trim())
            return; await act(() => POST(`/api/ops/tasks/${id}/comment`, { text: cm.value })); m.remove(); onChange && onChange(); opsTaskModal(id, onChange); } }, 'Add comment')))), t.canEdit ? [h('button', { class: 'btn ghost bad', onclick: async () => { if (!confirm('Delete this task?'))
                return; await act(() => api('DELETE', '/api/ops/tasks/' + id), 'Deleted'); m.remove(); onChange && onChange(); } }, 'Delete'), h('button', { class: 'btn ghost', onclick: () => { m.remove(); opsTaskForm(t, () => { onChange && onChange(); opsTaskModal(id, onChange); }); } }, 'Edit')] : null);
}
function opsTaskRow(t, reload, showWho) {
    const done = t.status === 'done';
    const chk = h('button', { class: 'ops-chk' + (done ? ' on' : ''), title: done ? 'Mark not done' : 'Mark done', onclick: async (e) => { e.stopPropagation(); await act(() => POST('/api/ops/tasks/' + t.id, { status: done ? 'todo' : 'done' }), done ? 'Reopened' : 'Done'); reload(); } }, done ? '✓' : '');
    const cl = t.checklist.length ? `${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : null;
    return h('div', { class: 'ops-task' + (done ? ' done' : ''), onclick: () => opsTaskModal(t.id, reload) }, chk, h('div', null, h('div', { class: 'ops-tt' }, t.title, t.unread ? h('span', { class: 'b accent', style: { marginLeft: '6px' } }, 'new') : null), h('div', { class: 'ops-sub row', style: { gap: '6px' } }, t.due_date ? h('span', { class: t.overdue ? 'neg' : '' }, opsDue(t)) : null, t.status !== 'todo' && !done ? h('span', { class: 'b ' + (t.status === 'blocked' ? 'bad' : 'info') }, OPS_ST[t.status]) : null, cl ? h('span', null, '☑ ' + cl) : null, t.link_ref ? h('span', null, t.link_ref) : null, t.template_id ? h('span', null, '↻ recurring') : null, showWho ? h('span', null, t.assignees.map(a => a.name).join(', ')) : null)), t.priority === 'urgent' || t.priority === 'high' ? h('span', { class: 'b ' + OPS_PRIO[t.priority] }, t.priority) : h('span'));
}
const opsRender = (...kids) => render(...kids.flat(Infinity).filter(x => x != null && x !== false && x !== ''));
/* ---------- Team today: daily work report (who did what), targets & settings ---------- */
VIEWS.team = async (args) => {
    const tab = args[0] === 'targets' ? 'targets' : 'today';
    const head = tabs([['today', 'Daily report'], ['targets', 'Targets & settings']], tab, t => { location.hash = '#/team/' + t; });
    if (tab === 'targets')
        return opsTargets(head);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(args[1] || '') ? args[1] : todayStr();
    const d = await GET('/api/ops/day?date=' + date);
    const T = d.totals, isToday = d.today;
    let sortBy = store.get('ops_sort', 'problems'), filter = 'all';
    const go = dd => { location.hash = '#/team/today/' + dd; };
    const dateIn = h('input', { type: 'date', value: date, max: todayStr(), onchange: e => e.target.value && go(e.target.value) });
    const bar = h('div', { class: 'toolbar' }, h('div', { class: 'ops-datebar' }, h('button', { class: 'btn ghost sm', onclick: () => go(opsAddDay(date, -1)) }, '‹'), dateIn, h('button', { class: 'btn ghost sm', disabled: isToday, onclick: () => go(opsAddDay(date, 1)) }, '›'), !isToday ? h('button', { class: 'btn ghost sm', onclick: () => go(todayStr()) }, 'Today') : null, h('strong', { style: { marginLeft: '6px' } }, opsDayName(date)), isToday ? h('span', { class: 'small muted' }, ' · as of ', d.now) : null), h('div', { class: 'row', style: { marginLeft: 'auto' } }, h('select', { onchange: e => { sortBy = e.target.value; store.set('ops_sort', sortBy); draw(); } }, [['problems', 'Problems first'], ['score', 'Highest score'], ['low', 'Lowest score'], ['name', 'Name']].map(([v, l]) => h('option', { value: v, selected: v === sortBy }, l))), !isToday ? h('button', { class: 'btn ghost sm', title: 'Recalculate this day from the activity records with today\'s targets', onclick: async () => { if (!confirm('Rebuild this day with the current targets? The saved report for this day will be replaced.'))
            return; await act(() => POST('/api/ops/snapshot', { date }), 'Day rebuilt'); VIEWS.team(['today', date]); } }, 'Rebuild day') : null, h('button', { class: 'btn ghost sm', onclick: () => csvDownload(`team-report-${date}.csv`, d.rows.map(r => ({ name: r.name, role: r.roleLabel, attendance: r.att.status, in: r.att.in || '', out: r.att.out || '', attendance_source: r.att.source, first_action: r.first || '', last_action: r.last || '', actions: r.actions,
            output: r.targets.map(p => `${p.label} ${p.actual}/${p.target}`).join('; '), score: r.score == null ? '' : r.score, idle_max_min: r.idle ? Math.round(r.idle.min) : '', tasks_done: r.tasks.done, tasks_overdue: r.tasks.overdue, mistakes: (r.mistakes || []).length, mistake_tickets: (r.mistakes || []).map(x => 'T-' + x.id + ' ' + (x.reason || x.deptLabel)).join('; '), flags: r.flags.map(f => f.t).join('; '), eod: r.eod ? r.eod.did : '' }))) }, 'Export CSV')));
    const src = [];
    const nHr = d.rows.filter(r => r.att.source === 'hr').length;
    src.push(nHr === d.rows.length && nHr ? 'Attendance from HR check-in.' : nHr ? `Attendance from HR check-in for ${nHr} ${nHr === 1 ? 'person' : 'people'} with an HR record; for the others "Seen" times come from their first/last ERP activity.` : 'No HR attendance records: "Seen" times come from first/last ERP activity.');
    if (d.snapshot)
        src.push(`Saved report (built ${d.snapshot.slice(5, 16)}, with the targets at that time). Use "Rebuild day" to recalculate.`);
    if (isToday)
        src.push(`Today is still running: scores are so far, "Below target" is only judged after ${d.settings.shiftEnd}.`);
    const k = (l, v, s, cls, f) => { const e = kpi(l, v, s, cls); if (f) {
        e.style.cursor = 'pointer';
        e.onclick = () => { filter = filter === f ? 'all' : f; draw(); };
        e.title = 'Click to show only these people';
    } return e; };
    const kp = h('div', { class: 'kpis ops-kpis' }, k('Staff on report', num(T.staff), `${T.present} ${d.hr ? 'present' : 'active'}${T.absent ? ' · ' + T.absent + ' absent' : ''}`, '', 'all'), k("Didn't work", num(T.noActivity + T.absent), (T.absent ? T.absent + ' absent · ' : '') + num(T.noActivity) + (isToday && d.now < d.settings.noActBy ? ' no work recorded yet' : ' no work recorded'), T.noActivity + T.absent ? 'alert' : 'good', 'nowork'), k(`Idle > ${d.settings.idleMin} min`, num(T.idle), 'gap in working hours', T.idle ? 'warn' : '', 'idle'), k(`Below ${d.settings.lowPct}% of target`, num(T.low), isToday && d.now < d.settings.shiftEnd ? 'judged after ' + d.settings.shiftEnd : 'people with targets', T.low ? 'alert' : '', 'low'), k('Late', num(T.late), nHr === d.rows.length && nHr ? 'from HR check-in' : nHr ? 'HR check-in, or first action' : 'first action after shift start', T.late ? 'warn' : '', 'late'), k('Team score', T.avgScore == null ? '—' : T.avgScore + '%', isToday ? 'so far today (people with targets)' : 'average of people with targets', T.avgScore == null ? '' : T.avgScore >= 90 ? 'good' : T.avgScore >= 50 ? 'warn' : 'alert'), k('End-of-day notes', `${T.eod}/${T.eodDue}`, 'written / people who worked', T.eod < T.eodDue && (!isToday || d.now >= d.settings.eodRemind) ? 'warn' : '', 'noeod'), k('Overdue tasks', num(T.overdue), 'assigned to these people', T.overdue ? 'warn' : '', 'overdue'), k('Mistakes', num(T.mistakes || 0), T.mistakes ? `customer problems traced to ${T.mistakePeople} ${T.mistakePeople === 1 ? 'person' : 'people'}` : 'no customer problems traced to staff', T.mistakes ? 'alert' : 'good', 'mistake'));
    const list = h('div', { class: 'ops-list' });
    const sev = r => r.flags.reduce((s, f) => s + (f.lv === 'bad' ? 10 : f.lv === 'warn' ? 3 : 0), 0);
    const draw = () => {
        let rows = d.rows.slice();
        if (filter !== 'all')
            rows = rows.filter(r => r.flags.some(f => filter === 'nowork' ? ['noact', 'absent'].includes(f.k) : f.k === filter));
        const sc = r => r.score == null ? -1 : r.score;
        if (sortBy === 'problems')
            rows.sort((a, b) => sev(b) - sev(a) || (b.tracked - a.tracked) || sc(a) - sc(b) || a.name.localeCompare(b.name));
        if (sortBy === 'score')
            rows.sort((a, b) => sc(b) - sc(a) || a.name.localeCompare(b.name));
        if (sortBy === 'low')
            rows.sort((a, b) => (b.tracked - a.tracked) || sc(a) - sc(b) || a.name.localeCompare(b.name));
        if (sortBy === 'name')
            rows.sort((a, b) => a.name.localeCompare(b.name));
        kp.querySelectorAll('.kpi').forEach((e, i) => e.style.outline = filter !== 'all' && ['all', 'nowork', 'idle', 'low', 'late', null, 'noeod', 'overdue', 'mistake'][i] === filter ? '2px solid var(--accent)' : '');
        list.replaceChildren(...[h('div', { class: 'ops-row hd' }, h('span', null, 'Person'), h('span', null, 'Attendance'), h('span', null, 'Activity'), h('span', null, 'Output vs target'), h('span', { style: { textAlign: 'right' } }, 'Score'), h('span', null, 'Tasks'), h('span', null, 'Flags')),
            rows.length ? rows.map(r => {
                const worst = r.flags.some(f => f.lv === 'bad') ? ' bad' : r.flags.some(f => f.lv === 'warn') ? ' warn' : '';
                const out = r.targets.length ? h('div', { class: 'ops-parts' }, r.targets.map(opsPart)) : h('div', null, h('div', { class: 'ops-kv' }, r.labels.slice(0, 3).map(x => h('span', null, x.l, ' ', h('b', null, num(x.n))))), h('div', { class: 'ops-sub' }, r.labels.length ? 'No target set' : 'No target · nothing recorded'));
                return h('div', { class: 'ops-row' + worst, onclick: () => opsPersonDrawer(r.key, date) }, h('div', { class: 'c-name person' }, h('span', { class: 'ops-av' }, opsInitials(r.name)), h('div', null, h('div', { class: 'ops-nm' }, r.name, r.eod ? h('span', { title: 'End-of-day note written', class: 'b ok', style: { marginLeft: '6px' } }, 'EOD') : null), h('div', { class: 'ops-sub' }, r.roleLabel))), h('div', { class: 'c-att' }, h('span', { class: 'lbl' }, 'Attendance'), opsAtt(r.att)), h('div', { class: 'c-act' }, h('span', { class: 'lbl' }, 'Activity'), r.first ? h('div', null, h('strong', null, num(r.actions)), r.actions === 1 ? ' action' : ' actions', h('div', { class: 'ops-sub' }, r.first, ' – ', r.last)) : h('span', { class: 'muted' }, r.noLogin ? 'No ERP login' : 'None')), h('div', { class: 'c-out' }, h('span', { class: 'lbl' }, 'Output vs target'), out), h('div', { class: 'c-score' }, opsScore(r.score, r.tracked), r.penalty ? h('div', { class: 'ops-sub neg', style: { textAlign: 'right' }, title: `Score before mistakes: ${r.baseScore}%` }, `−${r.penalty} mistakes`) : null), h('div', { class: 'c-tasks small' }, h('span', { class: 'lbl' }, 'Tasks'), h('div', null, num(r.tasks.done), ' done'), r.tasks.overdue ? h('div', { class: 'neg' }, num(r.tasks.overdue), ' overdue') : r.tasks.open ? h('div', { class: 'muted' }, num(r.tasks.open), ' open') : null), h('div', { class: 'c-flags ops-flags' }, r.flags.length ? r.flags.map(opsFlag) : h('span', { class: 'b ok' }, 'OK')));
            }) : h('div', { class: 'card empty' }, filter === 'all' ? 'No staff on the report yet. Add staff logins in Staff & access (or employees in HR).' : 'Nobody in this group.')].flat());
    };
    draw();
    const notes = d.rows.filter(r => r.eod);
    const missing = d.rows.filter(r => r.user_id && r.present && !r.eod);
    opsRender(head, bar, h('div', { class: 'small muted' }, src.join(' ')), kp, list, h('div', { class: 'card' }, h('h2', null, 'End-of-day notes', h('small', null, ` · ${notes.length} written`, missing.length ? ` · missing: ${missing.map(r => r.name).join(', ')}` : '')), notes.length ? h('div', { class: 'grid' }, notes.map(r => h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '10px' } }, h('div', { class: 'row sp' }, h('strong', null, r.name), h('span', { class: 'small muted' }, r.roleLabel)), opsEodView(r.eod)))) : h('div', { class: 'muted small' }, 'Nobody has written an end-of-day note for this day yet.')));
};
/* ---------- targets & settings ---------- */
async function opsTargets(head) {
    const d = await GET('/api/ops/targets');
    const metricOpts = () => [h('optgroup', { label: 'Built-in' }, d.metrics.map(m => h('option', { value: m.k }, m.l))), h('optgroup', { label: 'Count of a logged action' }, d.actions.map(a => h('option', { value: a.k }, a.l)))];
    const save = (body, msg) => act(() => POST('/api/ops/targets', body), msg || 'Target saved').then(() => VIEWS.team(['targets']));
    const byRole = {};
    for (const t of d.targets.filter(t => t.scope === 'role'))
        (byRole[t.ref] = byRole[t.ref] || []).push(t);
    const tgRow = t => h('tr', null, h('td', null, t.label), h('td', { class: 'n' }, h('input', { type: 'number', min: 0, value: t.target, onchange: e => save({ scope: t.scope, ref: t.ref, metric: t.metric, target: +e.target.value, weight: t.weight }) })), h('td', { class: 'n' }, h('input', { type: 'number', min: 0.1, step: 0.5, value: t.weight, onchange: e => save({ scope: t.scope, ref: t.ref, metric: t.metric, target: t.target, weight: +e.target.value }) })), h('td', null, h('button', { class: 'btn ghost sm', onclick: () => act(() => api('DELETE', '/api/ops/targets/' + t.id), 'Removed').then(() => VIEWS.team(['targets'])) }, 'Remove')));
    const tgTable = list => h('div', { class: 'scroll' }, h('table', { class: 'tbl ops-tgt' }, h('thead', null, h('tr', null, h('th', null, 'Counts'), h('th', { class: 'n' }, 'Per day'), h('th', { class: 'n' }, 'Weight'), h('th'))), h('tbody', null, list.map(tgRow))));
    const addForm = (scope) => {
        const ref = h('select', null, scope === 'role' ? d.roles.map(r => h('option', { value: r.k }, r.l)) : [...d.users.map(u => h('option', { value: u.key }, u.name + ' · ' + u.roleLabel)), ...d.hrOnly.map(p => h('option', { value: p.key }, p.name + ' · no login'))]);
        const met = h('select', null, metricOpts()), tg = h('input', { type: 'number', min: 0, placeholder: scope === 'role' ? 'e.g. 80' : '0 = not measured' }), w = h('input', { type: 'number', min: 0.1, step: 0.5, value: 1 });
        return h('div', { class: 'fgrid' }, field(scope === 'role' ? 'Role' : 'Person', ref), field('What to count', met), field('Target per day', tg), field('Weight', w), h('div', { class: 'full' }, h('button', { class: 'btn', onclick: () => { if (tg.value === '')
                return toast('Enter a target', true); save({ scope, ref: ref.value, metric: met.value, target: +tg.value, weight: +w.value || 1 }); } }, scope === 'role' ? 'Add role target' : 'Set for this person')));
    };
    const persons = d.targets.filter(t => t.scope === 'person');
    const nameOf = key => (d.users.find(u => u.key === key) || d.hrOnly.find(p => p.key === key) || { name: key }).name;
    const st = d.settings;
    const inp = (k, type = 'time') => h('input', { type, value: st[k], 'data-k': k, min: type === 'number' ? 0 : null });
    const setCard = h('div', { class: 'card' }, h('h2', null, 'Report settings'), h('div', { class: 'fgrid' }, field('Shift starts', inp('shiftStart')), field('Shift ends', inp('shiftEnd')), field('Break from', inp('breakStart')), field('Break to', inp('breakEnd')), field('Idle flag after (minutes without any action)', inp('idleMin', 'number')), field('Late after shift start + (minutes)', inp('lateGrace', 'number')), field('Check "no activity" from', inp('noActBy')), field('Remind end-of-day note at', inp('eodRemind')), field('Save daily snapshot at', inp('snapshotAt')), field('"Below target" means score under (%)', inp('lowPct', 'number')), field('Needs review: low on this % of working days', inp('lowShare', 'number')), field('Needs review: absences in 30 days', inp('absentLimit', 'number')), field('Needs review: lates in 30 days', inp('lateLimit', 'number')), field('Score penalty per mistake (points off that day)', inp('mistakePenalty', 'number')), field('Needs review: mistakes in 30 days', inp('mistakeLimit', 'number')), h('div', { class: 'full small muted' }, 'A mistake = a customer ticket closed with "whose mistake" pointing to this person (wrong size listed, wrong item packed …). It counts on the day the ticket is closed.'), h('div', { class: 'full' }, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, 'Working days'), h('div', { class: 'ops-picks', id: 'ops-wd' }, OPS_DAYS.map((n, i) => h('label', null, h('input', { type: 'checkbox', value: i, checked: (st.workdays || []).includes(i) }), n)))), h('div', { class: 'full small muted' }, 'If HR attendance is set up, each employee\'s own shift from HR is used instead of the shift above.'), h('div', { class: 'full' }, h('button', { class: 'btn', onclick: () => {
            const body = {};
            setCard.querySelectorAll('input[data-k]').forEach(i => body[i.dataset.k] = i.type === 'number' ? +i.value : i.value);
            body.workdays = [...setCard.querySelectorAll('#ops-wd input:checked')].map(i => +i.value);
            act(() => POST('/api/ops/settings', body), 'Settings saved');
        } }, 'Save settings'))));
    const hidden = new Set(st.hidden || []);
    const who = h('div', { class: 'card' }, h('h2', null, 'Who is on the report'), h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Untick people who should not appear (for example a partner or driver). The owner account is never shown.'), h('div', { class: 'ops-picks' }, [...d.users.filter(u => u.role !== 'admin'), ...d.hrOnly].map(u => h('label', null, h('input', { type: 'checkbox', checked: !hidden.has(u.key), onchange: e => { e.target.checked ? hidden.delete(u.key) : hidden.add(u.key); act(() => POST('/api/ops/settings', { hidden: [...hidden] }), 'Saved'); } }), u.name, h('span', { class: 'small muted' }, u.roleLabel || 'no login')))));
    opsRender(head, h('div', { class: 'note' }, h('strong', null, 'How the score works: '), 'for each target, output ÷ target (capped at 150%), then the weighted average. A person with no target (finance, management…) shows "—" and is never scored or ranked, so nobody is judged on data the ERP does not record. Person targets replace the role target for the same item; a person target of 0 removes that item for them.'), h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'Targets by role'), d.roles.filter(r => byRole[r.k]).map(r => h('div', { style: { marginBottom: '12px' } }, h('div', { class: 'ops-sec' }, r.l), tgTable(byRole[r.k]))), !Object.keys(byRole).length ? h('div', { class: 'muted small' }, 'No role targets yet.') : null, h('h2', { style: { marginTop: '10px' } }, 'Add a role target'), addForm('role')), h('div', { class: 'card' }, h('h2', null, 'Targets for one person'), persons.length ? [...new Set(persons.map(t => t.ref))].map(k => h('div', { style: { marginBottom: '12px' } }, h('div', { class: 'ops-sec' }, nameOf(k)), tgTable(persons.filter(t => t.ref === k)))) : h('div', { class: 'muted small' }, 'Nobody has a personal target. Role targets apply.'), h('h2', { style: { marginTop: '10px' } }, 'Set a personal target'), addForm('person'), h('h2', { style: { marginTop: '14px' } }, 'What each person is measured on'), table([{ t: 'Person', f: u => h('strong', null, u.name) }, { t: 'Role', k: 'roleLabel' }, { t: 'Targets', f: u => u.targets.length ? u.targets.map(t => `${t.label} ${t.target}${t.weight !== 1 ? ' ×' + t.weight : ''}`).join(' · ') : h('span', { class: 'muted' }, '— not scored') }], d.users.filter(u => u.onReport)))), h('div', { class: 'two' }, setCard, who));
}
registerView({ key: 'team', title: 'Team today', group: 'People', perm: 'team', icon: 'team', order: 5 }, VIEWS.team);
/* ---------- Performance: 7 / 30 / 90 days per person, ranking, needs review ---------- */
VIEWS.performance = async (args) => {
    const days = ['7', '30', '90'].includes(args[0]) ? +args[0] : 30;
    const d = await GET('/api/ops/performance?days=' + days);
    const head = h('div', { class: 'row sp' }, tabs([['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']], String(days), k => { location.hash = '#/performance/' + k; }), h('button', { class: 'btn ghost sm', onclick: () => csvDownload(`performance-${d.from}-to-${d.to}.csv`, d.people.map(r => {
            var _a, _b, _c;
            return ({ rank: r.rank || '', name: r.name, role: r.roleLabel, avg_score: (_a = r.avgScore) !== null && _a !== void 0 ? _a : '', scored_days: r.scoredDays, days_below_target: r.lowDays,
                working_days: r.workDays, present: r.present, absent: r.absent, no_activity_days: r.noActivityDays, late: r.late, avg_actions_per_day: r.avgActions,
                avg_output: r.output.map(o => { var _a; return `${o.label} ${(_a = o.avg) !== null && _a !== void 0 ? _a : '-'}/${o.target}`; }).join('; '), tasks_due: r.tasksDue, tasks_on_time_pct: (_b = r.onTimePct) !== null && _b !== void 0 ? _b : '', warnings: (_c = r.warnings) !== null && _c !== void 0 ? _c : '', mistakes: r.mistakes ? r.mistakes.n : '', mistakes_per_100: r.mistakes && r.mistakes.rate != null ? r.mistakes.rate : '', mistake_rate_per: r.mistakes ? r.mistakes.rateBase || '' : '', carts_recovered: r.recovered ? r.recovered.n : '', carts_recovered_value: r.recovered ? r.recovered.value : '', needs_review: r.needsReview.join(' | ') });
        })) }, 'Export CSV'));
    const scored = d.people.filter(r => r.avgScore != null);
    const team = d.team.map(x => ({ day: x.day, score: x.score || 0 }));
    const avg = scored.length ? Math.round(scored.reduce((s, r) => s + r.avgScore, 0) / scored.length) : null;
    const review = h('div', { class: 'card' }, h('h2', null, 'Needs review', h('small', null, ' · last 30 days, reasons spelled out')), d.needsReview.length ? h('div', { class: 'ops-review' }, d.needsReview.map(r => h('div', { onclick: () => opsPersonDrawer(r.key, d.to) }, h('div', { class: 'row sp' }, h('strong', null, r.name), h('span', { class: 'small muted' }, r.roleLabel)), h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, r.reasons.map(x => h('li', { class: 'small' }, x))))))
        : h('div', { class: 'note ok' }, 'Nobody meets the review rules right now.'), h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Rules: score under ${d.settings.lowPct}% on ${d.settings.lowShare}%+ of working days (needs at least 5 scored days), ${d.settings.absentLimit}+ absences, ${d.settings.lateLimit}+ lates, or ${d.settings.mistakeLimit}+ mistakes (customer problems) in 30 days. People without a target are only checked for absences and lateness.`));
    const cols = [
        { t: '#', f: r => r.rank ? h('strong', null, r.rank) : h('span', { class: 'muted' }, '—') },
        { t: 'Person', f: r => h('div', null, h('div', { class: 'ops-nm' }, r.name, r.needsReview.length ? h('span', { class: 'b bad', style: { marginLeft: '6px' } }, 'review') : null), h('div', { class: 'ops-sub' }, r.roleLabel)) },
        { t: 'Avg score', n: 1, f: r => opsScore(r.avgScore, r.tracked) },
        { t: 'Trend', f: r => r.tracked ? opsSpark(r.trend.map(x => x.score)) : h('span', { class: 'small muted' }, 'not scored') },
        { t: 'Avg output / day', f: r => h('div', null, r.output.length ? h('div', { class: 'small' }, r.output.map(o => { var _a; return h('div', null, o.label, ': ', h('strong', null, (_a = o.avg) !== null && _a !== void 0 ? _a : '–'), h('span', { class: 'muted' }, ' / ' + o.target)); })) : h('span', { class: 'small muted' }, num(r.avgActions) + ' actions'), r.recovered ? h('div', { class: 'small', style: { marginTop: '3px' }, title: 'Abandoned carts that ordered after this person contacted them' }, 'Recovered: ', h('strong', { class: r.recovered.n ? 'pos' : '' }, `${num(r.recovered.n)} cart${r.recovered.n === 1 ? '' : 's'}, ${rs(r.recovered.value)}`)) : null) },
        { t: 'Mistakes', n: 1, f: r => !r.mistakes || !r.mistakes.n ? h('span', { class: 'muted' }, '0') : h('div', { title: r.mistakes.byDept.map(x => `${x.l}: ${x.n}`).join(', ') }, h('strong', { class: r.mistakes.n30 >= d.settings.mistakeLimit ? 'neg' : '' }, r.mistakes.n), r.mistakes.rate != null ? h('div', { class: 'ops-sub' }, `${r.mistakes.rate} per 100 ${r.mistakes.rateBase}`) : null) },
        { t: 'Below target', n: 1, f: r => r.scoredDays ? h('span', { class: r.lowDays / r.scoredDays >= d.settings.lowShare / 100 ? 'neg' : '' }, `${r.lowDays} of ${r.scoredDays} days`) : '–' },
        { t: 'Present', n: 1, f: r => `${r.present}/${r.workDays}` },
        { t: d.hr ? 'Absent' : 'Absent / no activity', n: 1, f: r => h('span', { class: r.absent + r.noActivityDays >= d.settings.absentLimit ? 'neg' : '' }, r.absent, r.noActivityDays ? h('span', { class: 'muted', title: 'Working days with no ERP activity and no HR record' }, ' / ' + r.noActivityDays) : null) },
        { t: 'Late', n: 1, f: r => h('span', { class: r.late >= d.settings.lateLimit ? 'neg' : '' }, r.late) },
        { t: 'Tasks on time', n: 1, f: r => r.tasksDue ? `${r.onTimePct}% (${r.tasksOnTime}/${r.tasksDue})` : '–' },
        { t: 'Warnings', n: 1, f: r => r.warnings == null ? '–' : h('span', { class: r.warnings ? 'neg' : '' }, r.warnings) },
    ];
    opsRender(head, h('div', { class: 'small muted' }, `${day(d.from)} – ${day(d.to)} (up to yesterday; today is still running). `, d.hr ? 'Present / absent / late from HR where an employee record exists, otherwise from ERP activity.' : 'No HR attendance: "present" means the person did something in the ERP that day.', ' Past days use the saved daily snapshot (targets at that time).'), h('div', { class: 'kpis ops-kpis' }, kpi('Team average score', avg == null ? '—' : avg + '%', `${scored.length} people with targets`, avg == null ? '' : avg >= 90 ? 'good' : avg >= 50 ? 'warn' : 'alert'), kpi('Needs review', num(d.needsReview.length), 'see reasons below', d.needsReview.length ? 'alert' : 'good'), kpi('Top performer', scored[0] ? scored[0].name : '—', scored[0] ? scored[0].avgScore + '% average' : ''), kpi('Not scored', num(d.people.length - scored.length), 'no target or no working days')), h('div', { class: 'card' }, h('h2', null, 'Team score per day', h('small', null, ' · average of people with targets who worked')), chart(team, 'day', [{ k: 'score', l: 'Team score %', c: C2 }], 110)), review, d.tickets ? opsDeptCard(d.deptMonth) : null, h('div', { class: 'card' }, h('h2', null, 'Ranking', h('small', null, ` · mistakes counted ${day(d.mFrom)} – today; score already includes −${d.settings.mistakePenalty} per mistake`)), table(cols, d.people, r => opsMistakesOrDay(r, d))));
};
// clicking a person: show their mistakes list when they have any, else their last day
function opsMistakesOrDay(r, d) {
    if (!r.mistakes || !r.mistakes.n)
        return opsPersonDrawer(r.key, d.to);
    const md = modal(r.name + ' · mistakes', h('div', { class: 'grid' }, h('div', { class: 'kpis ops-kpis' }, kpi('Mistakes', num(r.mistakes.n), `${day(d.mFrom)} – today`, 'alert'), kpi('Rate', r.mistakes.rate == null ? '—' : r.mistakes.rate, r.mistakes.rateBase ? 'per 100 ' + r.mistakes.rateBase : ''), kpi('Cost', rs(r.mistakes.cost || 0), 'refund / courier / exchange')), h('div', { class: 'ops-kv' }, r.mistakes.byDept.map(x => h('span', null, x.l, ' ', h('b', null, x.n)))), opsMistakeList(r.mistakes.list, () => md.remove()), h('div', null, h('button', { class: 'btn ghost sm', onclick: () => { md.remove(); opsPersonDrawer(r.key, d.to); } }, 'Open their day report'))));
}
// department view: which department causes the most customer problems (this month, with month picker)
function opsDeptCard(dm0) {
    const box = h('div', { class: 'card' });
    const draw = dm => {
        const max = Math.max(1, ...dm.depts.map(x => x.n)), mOf = (m, n) => { const [y, mo] = m.split('-').map(Number); const dd = new Date(Date.UTC(y, mo - 1 + n, 1)); return dd.toISOString().slice(0, 7); };
        const go = n => GET('/api/ops/mistakes?month=' + mOf(dm.month, n)).then(draw).catch(e => toast(e.message, true));
        const label = new Date(dm.month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        box.replaceChildren(...[h('h2', null, 'Mistakes by department', h('small', null, ` · ${label} · ${dm.total} customer problem${dm.total === 1 ? '' : 's'} with "whose mistake"`), h('span', { class: 'spacer', style: { flex: 1 } }), h('button', { class: 'btn ghost sm', onclick: () => go(-1) }, '‹'), h('button', { class: 'btn ghost sm', disabled: dm.month >= todayStr().slice(0, 7), onclick: () => go(1) }, '›')),
            dm.depts.length ? h('div', { class: 'ops-dept' }, dm.depts.map(x => h('a', { class: 'ops-dbar', href: '#/tickets/fault/' + x.k + '/' + dm.month, title: 'Open these tickets' }, h('span', { class: 'ops-dl' }, x.l, x.internal ? null : h('span', { class: 'muted small' }, ' · outside')), h('span', { class: 'ops-dt' }, h('i', { class: x.internal ? 'in' : '', style: { width: Math.max(3, 100 * x.n / max) + '%' } })), h('strong', { class: 'ops-dn' }, x.n), h('span', { class: 'ops-dr small muted' }, x.top ? 'mostly: ' + x.top.toLowerCase() : '', x.cost ? ' · ' + rs(x.cost) : ''))))
                : h('div', { class: 'muted small' }, 'No closed tickets with "whose mistake" in this month yet. CS records it when they resolve a customer problem.'),
            dm.people.length ? h('div', { class: 'ops-kv', style: { marginTop: '12px' } }, h('span', { class: 'muted', style: { background: 'none', paddingLeft: 0 } }, 'Most mistakes:'), dm.people.slice(0, 8).map(p => h('span', null, p.name, ' · ', p.deptLabel, ' ', h('b', null, p.n)))) : null].filter(Boolean));
    };
    draw(dm0);
    return box;
}
registerView({ key: 'performance', title: 'Performance', group: 'People', perm: 'team', icon: 'chart', order: 6 }, VIEWS.performance);
/* ---------- Tasks: my tasks, team board, recurring tasks, end-of-day report ---------- */
VIEWS.tasks = async (args) => {
    const team = can('team');
    if (args[0] === 'view' && args[1]) {
        const vid = +args[1];
        args = ['mine'];
        setTimeout(() => opsTaskModal(vid, () => VIEWS.tasks(['mine'])).catch(e => toast(e.message, true)), 0);
    }
    const tab = ['mine', 'board', 'recurring', 'eod'].includes(args[0]) && (team || !['board', 'recurring'].includes(args[0])) ? args[0] : 'mine';
    const reload = () => VIEWS.tasks([tab, ...args.slice(1)]);
    const newBtn = h('button', { class: 'btn primary', onclick: () => opsTaskForm(null, reload) }, '+ New task');
    const head = h('div', { class: 'row sp' }, tabs([['mine', 'My tasks'], ...(team ? [['board', 'Team board'], ['recurring', 'Recurring']] : []), ['eod', 'End-of-day report']], tab, k => { location.hash = '#/tasks/' + k; }), newBtn);
    if (tab === 'eod') {
        const e = await GET('/api/ops/eod');
        const out = await GET('/api/ops/me');
        return opsRender(head, h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', null, 'End-of-day report', h('small', null, ' · ' + opsDayName(e.date))), opsEodForm(e.note, reload, { remind: e.onReport ? e.remindAt : null })), opsMyOutputCard(out.output)));
    }
    if (tab === 'mine') {
        const d = await GET('/api/ops/tasks');
        const eod = await GET('/api/ops/eod');
        const sec = (title, list, cls, empty) => list.length || empty ? [h('div', { class: 'ops-sec ' + (cls || '') }, title, h('span', { class: 'b' }, list.length)), list.length ? h('div', { class: 'grid', style: { gap: '6px' } }, list.map(t => opsTaskRow(t, reload, t.assignees.length > 1))) : h('div', { class: 'small muted' }, empty)] : null;
        const nowHM = new Date(Date.now() + 5 * 3600e3).toISOString().slice(11, 16);
        return opsRender(head, eod.onReport && !eod.note && nowHM >= eod.remindAt ? h('a', { class: 'note warn', href: '#/tasks/eod', style: { display: 'block', textDecoration: 'none' } }, 'You have not written today\'s end-of-day report yet. Tap here to write it.') : null, h('div', { class: eod.onReport ? 'split' : '', style: eod.onReport ? { gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' } : null }, h('div', { class: 'card grid' }, sec('Overdue', d.overdue, 'bad'), sec('Today', d.today, '', 'Nothing due today.'), sec('Upcoming', d.upcoming), sec('No due date', d.nodate), !d.counts.open ? h('div', { class: 'empty' }, 'No open tasks. Use "+ New task" to note something you need to do.') : null, d.done.length ? h('details', null, h('summary', { class: 'ops-sec', style: { cursor: 'pointer' } }, 'Done in the last 7 days ', h('span', { class: 'b ok' }, d.done.length)), h('div', { class: 'grid', style: { gap: '6px', marginTop: '6px' } }, d.done.map(t => opsTaskRow(t, reload)))) : null), eod.onReport ? h('div', { class: 'card' }, h('h2', null, 'End-of-day report'), opsEodForm(eod.note, reload, { compact: !!eod.note, remind: eod.remindAt }), h('div', { class: 'small', style: { marginTop: '8px' } }, h('a', { href: '#/tasks/eod' }, 'Open full report form'))) : null));
    }
    if (tab === 'board') {
        const pp = await GET('/api/ops/people');
        const user = args[1] || '';
        const d = await GET('/api/ops/tasks?view=board' + (user ? '&user=' + user : ''));
        const who = h('select', { onchange: e => { location.hash = '#/tasks/board/' + e.target.value; } }, h('option', { value: '' }, 'Everyone'), pp.users.map(u => h('option', { value: u.id, selected: String(u.id) === user }, u.name)));
        const moveTo = async (t, s) => { let note = ''; if (s === 'blocked') {
            note = prompt('What is blocking this task?');
            if (!note)
                return;
        } await act(() => POST('/api/ops/tasks/' + t.id, { status: s, note })); reload(); };
        const tile = t => h('div', { class: 'tile', draggable: 'true', ondragstart: e => e.dataTransfer.setData('text', t.id), onclick: () => opsTaskModal(t.id, reload) }, h('div', { class: 'row sp', style: { alignItems: 'flex-start' } }, h('strong', null, t.title), t.priority === 'urgent' || t.priority === 'high' ? h('span', { class: 'b ' + OPS_PRIO[t.priority] }, t.priority) : null), h('div', { class: 'ops-sub' }, t.assignees.map(a => a.name).join(', ') || '—'), h('div', { class: 'row small', style: { gap: '6px', marginTop: '4px' } }, t.due_date ? h('span', { class: t.overdue ? 'b bad' : 'b' }, (t.overdue ? 'Overdue · ' : '') + opsDue(t)) : null, t.checklist.length ? h('span', { class: 'b' }, `☑ ${t.checklist.filter(c => c.done).length}/${t.checklist.length}`) : null, t.template_id ? h('span', { class: 'b' }, '↻') : null), h('div', { class: 'row', style: { gap: '4px', marginTop: '6px' } }, ['todo', 'doing', 'blocked', 'done'].filter(s => s !== t.status).map(s => h('button', { class: 'btn ghost sm', style: { padding: '2px 8px', fontSize: '12px' }, onclick: e => { e.stopPropagation(); moveTo(t, s); } }, '→ ' + OPS_ST[s]))));
        const col = s => { const list = d.rows.filter(t => t.status === s); return h('div', { class: 'col', ondragover: e => e.preventDefault(), ondrop: e => { e.preventDefault(); const t = d.rows.find(x => x.id === +e.dataTransfer.getData('text')); if (t && t.status !== s)
                moveTo(t, s); } }, h('h3', null, OPS_ST[s], h('span', null, list.length)), list.map(tile), !list.length ? h('div', { class: 'small muted' }, 'Empty') : null); };
        const od = d.rows.filter(t => t.overdue).length;
        return opsRender(head, h('div', { class: 'toolbar' }, h('span', { class: 'small muted' }, 'Show tasks of'), who, h('span', { class: 'small muted' }, `${d.rows.filter(t => t.status !== 'done').length} open`, od ? ` · ${od} overdue` : '', ' · done tasks from the last 7 days')), h('div', { class: 'kanban' }, ['todo', 'doing', 'blocked', 'done'].map(col)));
    }
    // recurring templates
    const [tpls, pp] = await Promise.all([GET('/api/ops/templates'), GET('/api/ops/people')]);
    const freqTxt = t => t.freq === 'daily' ? 'Every working day' : t.freq === 'weekdays' ? 'Every ' + t.weekdays.map(i => OPS_DAYS[i]).join(', ') : `Monthly on day ${t.month_day}`;
    const form = (t) => {
        t = t || { title: '', description: '', priority: 'normal', scope: 'user', ref: '', freq: 'daily', weekdays: [], month_day: 1, due_time: '', checklist: [], active: 1 };
        const title = h('input', { value: t.title, placeholder: 'e.g. Clear WhatsApp inbox' }), desc = h('textarea', null, t.description || '');
        const scope = h('select', null, h('option', { value: 'user', selected: t.scope === 'user' }, 'One person'), h('option', { value: 'role', selected: t.scope === 'role' }, 'Everyone with a role'));
        const ref = h('select');
        const fillRef = () => ref.replaceChildren(...(scope.value === 'user' ? pp.users.map(u => h('option', { value: u.id, selected: String(u.id) === String(t.ref) }, u.name)) : pp.roles.filter(r => r.k !== 'admin').map(r => h('option', { value: r.k, selected: r.k === t.ref }, r.l))));
        fillRef();
        scope.onchange = fillRef;
        const freq = h('select', null, [['daily', 'Every working day'], ['weekdays', 'Specific weekdays'], ['monthly', 'Once a month']].map(([v, l]) => h('option', { value: v, selected: v === t.freq }, l)));
        const wd = h('div', { class: 'ops-picks' }, OPS_DAYS.map((n, i) => h('label', null, h('input', { type: 'checkbox', value: i, checked: t.weekdays.includes(i) }), n)));
        const md = h('input', { type: 'number', min: 1, max: 31, value: t.month_day || 1 });
        const wdF = field('Weekdays', wd), mdF = field('Day of month', md);
        const sync = () => { wdF.hidden = freq.value !== 'weekdays'; mdF.hidden = freq.value !== 'monthly'; };
        freq.onchange = sync;
        sync();
        const tm = h('input', { type: 'time', value: t.due_time || '' }), prio = h('select', null, ['low', 'normal', 'high', 'urgent'].map(p => h('option', { value: p, selected: p === t.priority }, p)));
        const cl = h('textarea', { placeholder: 'One item per line (optional)' }, (t.checklist || []).join('\n'));
        const err = h('div', { class: 'flash bad', hidden: true });
        const m = modal(t.id ? 'Edit recurring task' : 'New recurring task', h('div', { class: 'grid' }, err, field('Title *', title), field('Details', desc), h('div', { class: 'two' }, field('For', scope), field('Who', ref)), h('div', { class: 'two' }, field('How often', freq), field('Due by (time)', tm)), wdF, mdF, field('Priority', prio), field('Checklist', cl), h('div', { class: 'small muted' }, 'A task is created each morning (one per day). For a role, one shared task is assigned to everyone with that role.')), [h('button', { class: 'btn primary', onclick: async () => {
                    const body = { title: title.value, description: desc.value, scope: scope.value, ref: ref.value, freq: freq.value, weekdays: [...wd.querySelectorAll('input:checked')].map(i => +i.value), month_day: +md.value, due_time: tm.value, priority: prio.value, checklist: cl.value.split('\n').map(x => x.trim()).filter(Boolean) };
                    try {
                        const r = t.id ? await POST('/api/ops/templates/' + t.id, body) : await POST('/api/ops/templates', body);
                        m.remove();
                        toast(r.made ? 'Saved · today\'s task created' : 'Saved');
                        reload();
                    }
                    catch (e) {
                        err.hidden = false;
                        err.textContent = e.message;
                    }
                } }, 'Save')]);
    };
    opsRender(head, h('div', { class: 'card' }, h('div', { class: 'row sp', style: { marginBottom: '10px' } }, h('span', { class: 'small muted' }, 'Routine jobs that repeat, e.g. "Count rack A" every Monday or "Clear WhatsApp inbox by 6pm" every day. Tasks are created automatically each morning.'), h('button', { class: 'btn', onclick: () => form() }, '+ New recurring task')), table([{ t: 'Task', f: t => h('div', null, h('strong', null, t.title), t.checklist.length ? h('div', { class: 'ops-sub' }, t.checklist.length + ' checklist items') : null) }, { t: 'For', k: 'forName' }, { t: 'When', f: t => freqTxt(t) + (t.due_time ? ' · by ' + t.due_time : '') },
        { t: 'Last created', f: t => t.lastMade ? day(t.lastMade) : h('span', { class: 'muted' }, 'not yet') },
        { t: '', f: t => h('div', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } }, h('button', { class: 'btn sm ' + (t.active ? 'ghost' : 'ok'), onclick: () => act(() => POST('/api/ops/templates/' + t.id, { active: !t.active }), t.active ? 'Paused' : 'Resumed').then(reload) }, t.active ? 'Pause' : 'Resume'), h('button', { class: 'btn sm ghost', onclick: () => { if (confirm('Delete this recurring task? Tasks already created stay.'))
                    act(() => api('DELETE', '/api/ops/templates/' + t.id), 'Deleted').then(reload); } }, 'Delete')) }], tpls, form)));
};
function opsMyOutputCard(o) {
    if (!o)
        return null;
    return h('div', { class: 'card' }, h('h2', null, 'My work today', h('small', null, o.first ? ` · ${o.first} – ${o.last}` : '')), o.parts.length ? h('div', { class: 'grid' }, h('div', { class: 'row sp' }, h('span', { class: 'muted small' }, 'Score so far'), opsScore(o.score, true)), h('div', { class: 'ops-parts' }, o.parts.map(opsPart))) : h('div', { class: 'small muted' }, 'No daily target is set for your role.'), o.labels.length ? h('div', { class: 'ops-kv', style: { marginTop: '10px' } }, o.labels.map(x => h('span', null, x.l, ' ', h('b', null, num(x.n))))) : h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Nothing recorded yet today.'));
}
/* My day page card: my tasks today + output vs target + end-of-day note */
registerMeCard({ key: 'ops', order: 20, perm: 'tasks' }, async () => {
    const d = await GET('/api/ops/me');
    const reload = () => { if (typeof VIEWS[CURRENT] === 'function')
        VIEWS[CURRENT]([]); };
    const t = d.tasks, list = [...t.overdue, ...t.today].slice(0, 8);
    return h('div', { class: 'grid' }, h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'My tasks today', t.overdue.length ? h('small', { class: 'neg' }, ` · ${t.overdue.length} overdue`) : null), h('a', { class: 'small', href: '#/tasks' }, 'All tasks')), list.length ? h('div', { class: 'grid', style: { gap: '6px' } }, list.map(x => opsTaskRow(x, reload))) : h('div', { class: 'small muted' }, 'Nothing due today.'), h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn ghost sm', onclick: () => opsTaskForm(null, reload) }, '+ Add a task for myself'))), opsMyOutputCard(d.output), d.onReport ? h('div', { class: 'card' }, h('h2', null, 'End-of-day report'), opsEodForm(d.eod, reload, { compact: true, remind: d.settings.eodRemind })) : null);
});
registerView({ key: 'tasks', title: 'Tasks', group: 'Overview', perm: 'tasks', icon: 'check', order: 3 }, VIEWS.tasks);
/* ---------- settings ---------- */
VIEWS.settings = async () => {
    const s = await GET('/api/settings');
    const save = (b, msg) => act(() => POST('/api/settings', b), msg || 'Saved');
    const shop = h('input', { value: s.shopify.shop || 'sundaybazar-001.myshopify.com' }), cid = h('input', { value: s.shopify.clientId || '', placeholder: 'Client ID' }), csec = h('input', { type: 'password', placeholder: s.shopify.hasSecret ? '•••••• saved (type to replace)' : 'Client secret' });
    const stok = h('input', { type: 'password', placeholder: s.shopify.hasToken ? '•••••• saved (type to replace)' : 'shpat_… (only for old custom apps)' });
    const locSel = h('select', null, h('option', { value: s.shopify_location || '' }, s.shopify_location ? 'Saved location' : 'Test the connection to choose'));
    const ptok = h('input', { type: 'password', placeholder: s.postex.hasToken ? '•••••• saved (type to replace)' : 'PostEx API token' });
    const shRes = h('div'), pxRes = h('div');
    const syncBox = h('div');
    const showLog = async () => { const l = await GET('/api/sync/log'); syncBox.replaceChildren(table([{ t: 'When', f: x => dt(x.at) }, { t: 'What', k: 'kind' }, { t: 'Result', f: x => h('span', { class: 'b ' + (x.ok ? 'ok' : 'bad') }, x.ok ? 'ok' : 'error') }, { t: 'Details', f: x => h('span', { class: 'small' }, x.message) }], l.slice(0, 20))); };
    const num_ = (k, w = 90) => { const i = h('input', { type: 'number', value: s[k], style: { width: w + 'px' } }); i.dataset.k = k; return i; };
    const chk = k => { const i = h('input', { type: 'checkbox', checked: s[k] }); i.dataset.k = k; return i; };
    const mode = h('select', null, [['off', 'Off: send every order straight to the warehouse'], ['risky', 'Call only new & risky customers (recommended)'], ['all', 'Call every customer']].map(([v, l]) => h('option', { value: v, selected: s.confirm_mode === v }, l)));
    const wa = h('textarea', null);
    wa.value = s.wa_template || s.defaults.wa_template;
    const cats = h('input', { value: (s.expense_categories || []).join(', '), class: 'grow' });
    const store = h('input', { value: s.store_name });
    const gather = el => Object.fromEntries([...el.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.type === 'checkbox' ? i.checked : +i.value]));
    const rules = h('div', { class: 'grid' }, h('div', { class: 'row' }, 'Confirmation calls', mode), h('div', { class: 'row' }, 'Call again after', num_('retry_hours', 70), 'hours when there is no answer · give up after', num_('max_attempts', 70), 'calls', h('label', { class: 'row' }, chk('auto_cancel_unreachable'), 'then cancel automatically')), h('label', { class: 'row' }, chk('tag_shopify'), 'Tag confirmed / cancelled orders in Shopify (ERP-Confirmed, ERP-Cancel)'), h('label', { class: 'row' }, chk('restock_shopify'), 'When a return is received in good condition, add it back to Shopify stock'), h('div', { class: 'row' }, 'A parcel is "stuck" after', num_('stuck_days', 70), 'days without delivery'), field('WhatsApp confirmation message ({name} {order} {items} {total})', wa));
    const fin = h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'Used only when PostEx or Shopify does not give the real number.'), h('div', { class: 'row' }, 'PostEx charge per parcel Rs', num_('courier_fee'), 'extra charge on a return Rs', num_('return_fee'), 'packaging per parcel Rs', num_('packaging_cost')), h('div', { class: 'row' }, 'If an item has no cost in Shopify, assume cost is', num_('cost_pct', 70), '% of price'), h('div', { class: 'row' }, 'Expense categories', cats));
    const syncS = h('div', { class: 'grid' }, h('div', { class: 'row' }, 'Check Shopify for new orders every', num_('sync_minutes', 70), 'minutes · on first connect, bring orders from the last', num_('history_days', 70), 'days'), h('div', { class: 'row' }, 'Check PostEx parcels from the last', num_('postex_days', 70), 'days', h('label', { class: 'row' }, chk('postex_check_payments'), 'also check COD payment status')));
    render(window.SB_OFFLINE ? h('div', { class: 'note warn' }, 'This is the offline copy, for trying the ERP on one computer. Shopify and PostEx connect only in the office version (start.bat on the office computer).') : null, h('div', { class: 'card grid' }, h('h2', null, 'Shopify'), h('div', { class: 'note' }, 'In Shopify: Settings → Apps → Develop apps → "Build apps in Dev Dashboard". Create an app, give it access (orders, products, customers, inventory, locations: read; orders, products, inventory: write), release a version, install it on your store, then copy the Client ID and Client secret here.'), field('Store address', shop), h('div', { class: 'two' }, field('Client ID', cid), field('Client secret', csec)), h('details', null, h('summary', { class: 'small muted' }, 'I have an old admin API token instead'), field('Admin API access token', stok)), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await save({ shopify: { shop: shop.value, clientId: cid.value, clientSecret: csec.value, token: stok.value } }); try {
            const r = await POST('/api/settings/test-shopify');
            META.shopify = true;
            locSel.replaceChildren(...r.locations.filter(l => l.isActive).map(l => h('option', { value: l.id, selected: l.id === s.shopify_location }, l.name)));
            shRes.replaceChildren(h('div', { class: 'flash ok' }, `Connected to ${r.shop.name}. Choose the stock location and save.`));
        }
        catch (e) {
            shRes.replaceChildren(h('div', { class: 'flash bad' }, e.message));
        } } }, 'Save & test'), 'Stock location', locSel, h('button', { class: 'btn ghost', onclick: () => save({ shopify_location: locSel.value }) }, 'Save location')), shRes), h('div', { class: 'card grid' }, h('h2', null, 'PostEx'), h('div', { class: 'note' }, 'Get the API token from your PostEx merchant portal (Settings / Integration) or from your PostEx account manager.'), field('API token', ptok), h('div', null, h('button', { class: 'btn', onclick: async () => { if (ptok.value)
            await save({ postex: { token: ptok.value } }); try {
            await POST('/api/settings/test-postex');
            META.postex = true;
            pxRes.replaceChildren(h('div', { class: 'flash ok' }, 'PostEx connected.'));
        }
        catch (e) {
            pxRes.replaceChildren(h('div', { class: 'flash bad' }, e.message));
        } } }, 'Save & test')), pxRes), h('div', { class: 'card grid' }, h('h2', null, 'Sync'), syncS, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => save(gather(syncS)) }, 'Save'), ...[['all', 'Sync everything now'], ['orders', 'Orders'], ['products', 'Products'], ['postex', 'PostEx']].map(([k, l]) => h('button', { class: 'btn ghost sm', onclick: async () => { await act(() => POST('/api/sync', { kind: k }), 'Sync started'); setTimeout(showLog, 4000); } }, l))), h('div', { class: 'small muted' }, 'The first product sync can take several minutes for a big store. You can keep working while it runs.'), syncBox), h('div', { class: 'card grid' }, h('h2', null, 'Rules'), rules, h('div', null, h('button', { class: 'btn', onclick: () => save(Object.assign(Object.assign({}, gather(rules)), { confirm_mode: mode.value, wa_template: wa.value })) }, 'Save rules'))), h('div', { class: 'card grid' }, h('h2', null, 'Finance assumptions'), fin, h('div', null, h('button', { class: 'btn', onclick: () => save(Object.assign(Object.assign({}, gather(fin)), { expense_categories: cats.value.split(',').map(x => x.trim()).filter(Boolean) })) }, 'Save'))), h('div', { class: 'card grid' }, h('h2', null, 'Office network'), h('div', null, 'Staff open the ERP on the office WiFi at: ', s.lan.map(u => h('div', { class: 'mono' }, u))), h('div', { class: 'small muted' }, 'Data is saved on this computer in: ', h('span', { class: 'mono' }, s.data_dir), '. Copy that folder to a USB drive every week as a backup.'), h('div', { class: 'row' }, 'Store name', store, h('button', { class: 'btn ghost sm', onclick: () => save({ store_name: store.value }) }, 'Save'))), window.SB_OFFLINE ? null : h('div', { class: 'card grid' }, h('h2', null, 'Backups'), h('div', { class: 'small muted' }, 'A full copy of the database is saved automatically every night (kept 30 days) in the data/backups folder on the server. Also download a copy now and then and keep it off the server (Google Drive / USB).'), h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => act(() => POST('/api/backup'), 'Backup saved on the server') }, 'Backup now'), can('users') ? h('a', { class: 'btn ghost', href: '/api/backup' }, 'Download a copy') : null)), h('div', { class: 'card grid' }, h('h2', null, 'Practice data'), h('div', { class: 'small muted' }, 'Invented orders and products so staff can learn the screens before the real store is connected.'), h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: META.shopify && !META.demo, onclick: async () => { await act(() => POST('/api/demo/load'), 'Practice data loaded'); location.reload(); } }, 'Load practice data'), h('button', { class: 'btn ghost', onclick: async () => { if (confirm('Remove all practice data?')) {
            await act(() => POST('/api/demo/clear'), 'Practice data removed');
            location.reload();
        } } }, 'Remove practice data'))));
    showLog();
};
registerView({ key: 'settings', title: 'Settings', group: 'Admin', perm: 'settings', icon: 'gear', order: 90 }, VIEWS.settings);
/* ---------- staff & access ---------- */
if (!document.getElementById('role-pick-css'))
    document.head.append(h('style', { id: 'role-pick-css' }, `.role-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;max-height:300px;overflow:auto}
.role-opt{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}.role-opt input{margin-top:3px;width:16px;height:16px;flex:none;accent-color:var(--accent)}
.role-opt span{display:flex;flex-direction:column;gap:2px}.role-opt.on{border-color:var(--accent);background:var(--accent-soft, var(--bg))}`));
VIEWS.staff = async (args) => {
    let tab = args[0] || 'users';
    const head = tabs([['users', 'Staff accounts'], ['log', 'Activity log']], tab, t => { location.hash = '#/staff/' + t; });
    if (tab === 'log') {
        const ev = await GET('/api/events');
        return render(head, h('div', { class: 'card' }, table([{ t: 'When', f: e => dt(e.at) }, { t: 'Who', k: 'user' }, { t: 'Action', k: 'action' }, { t: 'On', k: 'entity' }, { t: 'Details', f: e => h('span', { class: 'small muted' }, String(e.detail || '').slice(0, 140)) }], ev)));
    }
    const users = await GET('/api/users');
    const form = (u) => {
        const isNew = !u;
        u = u || { name: '', username: '', role: 'cs', perms: null, active: 1 };
        const name = h('input', { value: u.name }), user = h('input', { value: u.username, disabled: !isNew }), pw = h('input', { type: 'password', placeholder: isNew ? 'Password (6+)' : 'New password (leave empty to keep)' });
        const RI = META.roleInfo || {};
        const roleKeys = Object.keys(META.roles);
        let roleVal = roleKeys.includes(u.role) ? u.role : 'staff';
        const role = { get value() { return roleVal; } };
        const active = h('input', { type: 'checkbox', checked: !!u.active });
        const grid = h('div', { class: 'perm-grid' });
        const drawPerms = list => grid.replaceChildren(...META.perms.map(([k, l]) => h('label', null, h('input', { type: 'checkbox', value: k, checked: list.includes(k) }), l)));
        drawPerms(u.perms || []);
        const rolePerms = k => (RI[k] && RI[k].perms) || (k === 'admin' ? META.perms.map(p => p[0]) : []);
        if (isNew)
            drawPerms(rolePerms(roleVal));
        // one card per role with a line saying which screens it gets; picking one fills the access ticks below
        const rolePick = h('div', { class: 'role-pick' }, roleKeys.map(k => h('label', { class: 'role-opt' + (k === roleVal ? ' on' : '') }, h('input', { type: 'radio', name: 'role', value: k, checked: k === roleVal, onchange: () => { roleVal = k; rolePick.querySelectorAll('.role-opt').forEach(x => x.classList.toggle('on', x.querySelector('input').checked)); drawPerms(rolePerms(k)); } }), h('span', null, h('strong', null, META.roles[k]), RI[k] && RI[k].desc ? h('span', { class: 'small muted' }, RI[k].desc) : null))));
        const m = modal(isNew ? 'Add staff member' : 'Edit ' + u.name, h('div', { class: 'grid' }, h('div', { class: 'two' }, field('Name', name), field('Username (for login)', user)), field('Password', pw), field('Role (fills the access below)', rolePick), h('div', { class: 'small muted' }, 'Tick exactly what this person may see and do:'), grid, !isNew ? h('label', { class: 'row' }, active, 'Account active (untick to block login)') : null), [h('button', { class: 'btn', onclick: () => {
                    const perms = [...grid.querySelectorAll('input:checked')].map(i => i.value);
                    const body = { name: name.value, username: user.value, password: pw.value, role: role.value, perms, active: active.checked };
                    act(() => isNew ? POST('/api/users', body) : POST('/api/users/' + u.id, body), 'Saved').then(() => { m.remove(); VIEWS.staff(['users']); });
                } }, isNew ? 'Create account' : 'Save')]);
    };
    render(head, h('div', { class: 'card' }, h('div', { class: 'row sp', style: { marginBottom: '10px' } }, h('span', { class: 'small muted' }, 'Each person logs in with their own username. Everything they change is recorded in the activity log.'), h('button', { class: 'btn', onclick: () => form() }, '+ Add staff')), table([{ t: 'Name', f: u => h('strong', null, u.name) }, { t: 'Username', f: u => h('span', { class: 'mono' }, u.username) }, { t: 'Role', f: u => META.roles[u.role] || u.role },
        { t: 'Access', f: u => h('span', { class: 'small muted' }, u.perms.map(p => (META.perms.find(x => x[0] === p) || [, p])[1].split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')) },
        { t: 'Last login', f: u => u.last_login ? dt(u.last_login) : 'never' }, { t: '', f: u => u.active ? h('span', { class: 'b ok' }, 'active') : h('span', { class: 'b bad' }, 'blocked') }], users, form)));
};
registerView({ key: 'staff', title: 'Staff & access', group: 'Admin', perm: 'users', icon: 'key', order: 80 }, VIEWS.staff);
/* start the app once every screen file has registered itself */
(window.__sbReady || Promise.resolve()).then(boot).catch(e => { document.body.textContent = 'Could not start: ' + e.message; });
</script>