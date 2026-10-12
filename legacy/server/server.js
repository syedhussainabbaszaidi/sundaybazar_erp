    // SundayBazar ERP — office server. Start: node server.js  (or double-click start.bat)
    'use strict';
    process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice
    { // Node.js too old? Say so clearly instead of crashing
        const [maj, min] = process.versions.node.split('.').map(Number);
        if (maj < 22 || (maj === 22 && min < 5)) {
            console.log(`\n  Node.js ${process.versions.node} is too old for the ERP.`);
            console.log('  Install the latest LTS from https://nodejs.org (version 22 or 24), then start again.');
            console.log('  Node.js purana hai. nodejs.org se naya LTS install karein, phir start.bat dobara chalayein.\n');
            process.exit(1);
        }
    }
    const http = require('http');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { q, setting, setSetting, log, DATA_DIR } = require('./lib/db');
    const A = require('./lib/auth');
    const L = require('./lib/logic');
    const S = require('./lib/shopify');
    const P = require('./lib/postex');
    const F = require('./lib/finance');
    const PR = require('./lib/pricing');
    let PORT = +process.env.PORT || setting('port', 8080);
    const PUB = path.join(__dirname, 'public');
    /* ---------------- tiny router ---------------- */
    const routes = [];
    const route = (method, pattern, perm, fn) => {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
        routes.push({ method, re, keys, perm, fn });
    };
    class HttpError extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
    }
    const need = (cond, msg, code = 400) => { if (!cond)
        throw new HttpError(code, msg); };
    const can = (u, p) => u && u.perms.includes(p);
    const maskPhone = (u, p) => (can(u, 'customers') || can(u, 'cs') || can(u, 'tracking')) ? p : (p ? p.slice(0, 4) + '•••' + p.slice(-2) : '');
    const page = (qs, size = 50) => { const p = Math.max(1, +qs.page || 1); return { limit: size, offset: (p - 1) * size, page: p }; };
    const today = () => new Date().toISOString().slice(0, 10);
    const pkNow = () => new Date(Date.now() + 5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); // Pakistan local time 'YYYY-MM-DD HH:MM:SS'
    const pkToday = () => pkNow().slice(0, 10);
    /* ---------------- auth ---------------- */
    route('GET', '/api/state', null, (req, u) => ({
        setup: !q.get('SELECT id FROM users LIMIT 1'), setupKey: !!process.env.SB_SETUP_KEY, user: u || null,
        perms: A.PERMS, roles: Object.fromEntries(Object.entries(A.ROLES).map(([k, v]) => [k, v.label])), roleInfo: u ? Object.fromEntries(Object.entries(A.ROLES).map(([k, v]) => [k, { desc: v.desc || '', perms: v.perms }])) : undefined,
        store: setting('store_name', 'SundayBazar'), demo: !!setting('demo'), shopify: S.configured(), postex: P.configured(),
        statuses: L.STATUS,
    }));
    route('POST', '/api/setup', null, (req, u, b, res) => {
        need(!q.get('SELECT id FROM users LIMIT 1'), 'Already set up', 403);
        need(!process.env.SB_SETUP_KEY || String(b.key || '') === process.env.SB_SETUP_KEY, 'Wrong setup key. It is the SB_SETUP_KEY value set on the server.', 403);
        need(b.name && b.username && b.password && b.password.length >= 6, 'Name, username and a password of 6+ characters are needed');
        const r = q.run('INSERT INTO users(name,username,pass,role) VALUES(?,?,?,?)', b.name.trim(), b.username.trim().toLowerCase(), A.hash(b.password), 'admin');
        setCookie(res, A.createSession(r.lastInsertRowid), req);
        log(r.lastInsertRowid, 'setup', 'user', b.username);
        return { ok: true };
    });
    const FAILS = new Map(); // ip|username -> {n, until}
    const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    route('POST', '/api/login', null, (req, u, b, res) => {
        const fk = clientIp(req) + '|' + String(b.username || '').trim().toLowerCase(), f = FAILS.get(fk);
        need(!(f && f.n >= 8 && f.until > Date.now()), 'Too many wrong passwords. Wait 15 minutes and try again.', 429);
        const user = q.get('SELECT * FROM users WHERE username=? AND active=1', String(b.username || '').trim().toLowerCase());
        if (!(user && A.verify(b.password || '', user.pass))) {
            const g = FAILS.get(fk) || { n: 0 };
            g.n++;
            g.until = Date.now() + 15 * 60e3;
            FAILS.set(fk, g);
            if (FAILS.size > 5000)
                FAILS.clear();
            need(false, 'Wrong username or password', 401);
        }
        FAILS.delete(fk);
        q.run("UPDATE users SET last_login=datetime('now') WHERE id=?", user.id);
        setCookie(res, A.createSession(user.id), req);
        log(user.id, 'login', 'user', user.username);
        return { ok: true };
    });
    route('POST', '/api/logout', null, (req, u, b, res) => { if (u)
        q.run('DELETE FROM sessions WHERE token=?', u.token); res.setHeader('Set-Cookie', 'sb_sess=; Path=/; Max-Age=0'); return { ok: true }; });
    route('POST', '/api/password', 'dashboard', (req, u, b) => {
        const me = q.get('SELECT * FROM users WHERE id=?', u.id);
        need(A.verify(b.old || '', me.pass), 'Current password is wrong');
        need(b.new && b.new.length >= 6, 'New password needs 6+ characters');
        q.run('UPDATE users SET pass=? WHERE id=?', A.hash(b.new), u.id);
        return { ok: true };
    });
    const isHttps = req => req && (req.headers['x-forwarded-proto'] === 'https' || (req.socket && req.socket.encrypted));
    function setCookie(res, t, req) { res.setHeader('Set-Cookie', `sb_sess=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${14 * 86400}${isHttps(req) ? '; Secure' : ''}`); }
    /* ---------------- users ---------------- */
    route('GET', '/api/users', 'users', () => q.all('SELECT id,name,username,role,perms,active,created_at,last_login FROM users ORDER BY active DESC, name').map(x => (Object.assign(Object.assign({}, x), { perms: A.userPerms(x) }))));
    route('POST', '/api/users', 'users', (req, u, b) => {
        need(b.name && b.username && b.password && b.password.length >= 6, 'Name, username and password (6+ characters) are needed');
        need(A.ROLES[b.role], 'Choose a role');
        need(!q.get('SELECT id FROM users WHERE username=?', b.username.trim().toLowerCase()), 'That username is taken');
        const r = q.run('INSERT INTO users(name,username,pass,role,perms) VALUES(?,?,?,?,?)', b.name.trim(), b.username.trim().toLowerCase(), A.hash(b.password), b.role, JSON.stringify(b.perms || A.ROLES[b.role].perms));
        log(u.id, 'user.create', 'user:' + r.lastInsertRowid, b.username);
        return { ok: true };
    });
    route('POST', '/api/users/:id', 'users', (req, u, b, res, p) => {
        const t = q.get('SELECT * FROM users WHERE id=?', +p.id);
        need(t, 'Not found', 404);
        if (+p.id === u.id)
            need(b.active !== false && (!b.perms || b.perms.includes('users')), 'You cannot lock yourself out');
        const perms = b.perms ? b.perms.filter(x => A.ALL.includes(x)) : A.userPerms(t);
        q.run('UPDATE users SET name=?, role=?, perms=?, active=? WHERE id=?', b.name || t.name, A.ROLES[b.role] ? b.role : t.role, JSON.stringify(perms), b.active === false ? 0 : 1, t.id);
        if (b.password) {
            need(b.password.length >= 6, 'Password needs 6+ characters');
            q.run('UPDATE users SET pass=? WHERE id=?', A.hash(b.password), t.id);
        }
        if (b.active === false || b.password)
            q.run('DELETE FROM sessions WHERE user_id=?', t.id);
        log(u.id, 'user.update', 'user:' + t.id, { role: b.role, active: b.active !== false });
        return { ok: true };
    });
    route('GET', '/api/events', 'users', (req, u, b, res, p, qs) => q.all(`SELECT e.*, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id ${qs.entity ? 'WHERE e.entity=?' : ''} ORDER BY e.id DESC LIMIT 300`, ...(qs.entity ? [qs.entity] : [])));
    /* ---------------- dashboard ---------------- */
    route('GET', '/api/dashboard', 'dashboard', (req, u) => {
        const d = {};
        const t0 = today();
        d.today = q.get(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) value FROM orders WHERE date(created_at,'+5 hours')=? AND cancelled_at IS NULL`, t0);
        d.week = q.get(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) value FROM orders WHERE created_at>=datetime('now','-7 days') AND cancelled_at IS NULL`);
        d.pipeline = Object.fromEntries(q.all(`SELECT status, COUNT(*) n FROM orders WHERE created_at>=datetime('now','-60 days') GROUP BY status`).map(r => [r.status, r.n]));
        const dr = q.get(`SELECT SUM(status='delivered') del, SUM(status IN ('returned','return_received','returning')) ret FROM orders WHERE dispatched_at>=datetime('now','-30 days')`);
        d.deliveryRate = dr.del + dr.ret ? Math.round(100 * dr.del / (dr.del + dr.ret)) : null;
        d.toConfirm = q.get(`SELECT COUNT(*) n FROM orders WHERE stage IN ('new','hold') AND tracking IS NULL AND cancelled_at IS NULL AND status IN ('new','hold')`).n;
        d.toPick = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked')`).n;
        d.stuck = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < datetime('now','-6 days')`).n;
        d.attempted = q.get(`SELECT COUNT(*) n FROM orders WHERE status='attempted'`).n;
        d.returnsPending = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('returned','returning')`).n;
        if (can(u, 'finance'))
            d.codPending = q.get(`SELECT COALESCE(SUM(COALESCE(cod,total)),0) v, COUNT(*) n FROM orders WHERE status='delivered' AND settled=0`);
        d.stock = q.get(`SELECT COUNT(*) items, COALESCE(SUM(price*qty),0) value, SUM(CASE WHEN created_at<datetime('now','-60 days') THEN 1 ELSE 0 END) aged FROM products WHERE qty>0`);
        d.daily = q.all(`SELECT date(created_at,'+5 hours') day, COUNT(*) orders, ROUND(SUM(total)) value FROM orders WHERE created_at>=datetime('now','-14 days') AND cancelled_at IS NULL GROUP BY day ORDER BY day`);
        d.sync = syncState();
        return d;
    });
    /* ---------------- orders ---------------- */
    const ORDER_COLS = `o.id,o.name,o.created_at,o.cust_name,o.phone,o.city,o.total,o.items,o.status,o.stage,o.tracking,o.px_status,o.cs_attempts,o.tags,o.missing,c.label clabel,c.delivered cdel,c.returned cret,c.orders corders,(SELECT group_concat(title || COALESCE(' (' || sku || ')',''), ' + ') FROM order_items WHERE order_id=o.id) items_text`;
    function orderFilter(qs) {
        const w = [], a = [];
        if (qs.status) {
            const s = String(qs.status).split(',');
            w.push(`o.status IN (${s.map(() => '?').join(',')})`);
            a.push(...s);
        }
        if (qs.q) {
            const t = '%' + qs.q.trim() + '%';
            const ph = L.normPhone(qs.q);
            w.push('(o.name LIKE ? OR o.cust_name LIKE ? OR o.tracking LIKE ? OR o.city LIKE ?' + (ph.length >= 7 ? ' OR o.phone LIKE ?' : '') + ' OR o.id IN (SELECT order_id FROM order_items WHERE sku LIKE ?))');
            a.push(t, t, t, t);
            if (ph.length >= 7)
                a.push('%' + ph + '%');
            a.push(t);
        }
        if (qs.from) {
            w.push(`date(o.created_at,'+5 hours')>=?`);
            a.push(qs.from);
        }
        if (qs.to) {
            w.push(`date(o.created_at,'+5 hours')<=?`);
            a.push(qs.to);
        }
        if (qs.city) {
            w.push('o.city LIKE ?');
            a.push(qs.city + '%');
        }
        if (qs.label) {
            w.push('c.label=?');
            a.push(qs.label);
        }
        return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
    }
    route('GET', '/api/orders', 'orders', (req, u, b, res, p, qs) => {
        const f = orderFilter(qs), pg = page(qs);
        const rows = q.all(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN customers c ON c.phone=o.phone ${f.where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, ...f.args, pg.limit, pg.offset);
        const total = q.get(`SELECT COUNT(*) n FROM orders o LEFT JOIN customers c ON c.phone=o.phone ${f.where}`, ...f.args).n;
        rows.forEach(r => r.phone = maskPhone(u, r.phone));
        return { rows, total, page: pg.page, pages: Math.ceil(total / pg.limit) };
    });
    route('GET', '/api/orders/:id', 'orders', (req, u, b, res, p) => {
        const o = q.get('SELECT * FROM orders WHERE id=? OR name=?', decodeURIComponent(p.id), decodeURIComponent(p.id));
        need(o, 'Order not found', 404);
        const items = q.all(`SELECT i.*, pr.image, pr.size, pr.cond, COALESCE(l.location, pr.rack) location FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id LEFT JOIN locations l ON l.sku=i.sku WHERE i.order_id=?`, o.id);
        const calls = q.all('SELECT c.*, us.name user FROM cs_calls c LEFT JOIN users us ON us.id=c.user_id WHERE order_id=? ORDER BY c.id DESC', o.id);
        const events = q.all('SELECT e.*, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE entity=? ORDER BY e.id DESC LIMIT 50', 'order:' + o.id);
        const cust = q.get('SELECT * FROM customers WHERE phone=?', o.phone);
        const others = q.all('SELECT id,name,created_at,total,status FROM orders WHERE phone=? AND id<>? ORDER BY created_at DESC LIMIT 20', o.phone, o.id);
        const showPhone = can(u, 'customers') || can(u, 'cs') || can(u, 'tracking');
        if (!showPhone) {
            o.phone = maskPhone(u, o.phone);
            o.address = '';
        }
        o.px_history = o.px_history ? JSON.parse(o.px_history) : [];
        return { order: o, items, calls, events, customer: cust, others, wa: showPhone ? L.waNumber(o.phone) : '', shop: S.cfg().shop };
    });
    const STAGES = ['new', 'hold', 'confirmed', 'cs_cancelled', 'picked', 'packed'];
    route('POST', '/api/orders/:id/stage', 'orders_edit', (req, u, b, res, p) => {
        need(STAGES.includes(b.stage), 'Unknown stage');
        const o = q.get('SELECT * FROM orders WHERE id=?', decodeURIComponent(p.id));
        need(o, 'Not found', 404);
        q.run('UPDATE orders SET stage=?, picked_at=CASE WHEN ?=\'picked\' THEN datetime(\'now\') ELSE picked_at END, packed_at=CASE WHEN ?=\'packed\' THEN datetime(\'now\') ELSE packed_at END WHERE id=?', b.stage, b.stage, b.stage, o.id);
        L.refreshOrder(o.id);
        log(u.id, 'stage:' + b.stage, 'order:' + o.id, b.note || '');
        return { ok: true };
    });
    route('POST', '/api/orders/:id/note', 'orders', (req, u, b, res, p) => {
        need(b.note, 'Write a note');
        const id = decodeURIComponent(p.id);
        log(u.id, 'note', 'order:' + id, String(b.note).slice(0, 1000));
        return { ok: true };
    });
    /* ---------------- CS / confirmation ---------------- */
    route('GET', '/api/cs/queue', 'cs', (req, u, b, res, p, qs) => {
        const view = qs.view || 'todo';
        let where = `o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.cancelled_at IS NULL`;
        if (view === 'todo')
            where += ` AND (o.cs_next IS NULL OR o.cs_next<=datetime('now'))`;
        if (view === 'later')
            where += ` AND o.cs_next>datetime('now')`;
        if (view === 'attempted')
            where = `o.status='attempted'`;
        const rows = q.all(`SELECT ${ORDER_COLS}, o.cs_next, o.cs_note, o.address, c.cancelled ccan FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE ${where}
     ORDER BY CASE COALESCE(c.label,'New') WHEN 'Blacklisted' THEN 0 WHEN 'Risky' THEN 1 WHEN 'New' THEN 2 ELSE 3 END, o.created_at LIMIT 300`);
        rows.forEach(r => r.wa = L.waNumber(r.phone));
        const counts = q.get(`SELECT SUM(cs_next IS NULL OR cs_next<=datetime('now')) todo, SUM(cs_next>datetime('now')) later FROM orders WHERE stage IN ('new','hold') AND status IN ('new','hold') AND cancelled_at IS NULL`);
        counts.attempted = q.get(`SELECT COUNT(*) n FROM orders WHERE status='attempted'`).n;
        return { rows, counts, mode: setting('confirm_mode', 'risky'), template: setting('wa_template', DEFAULT_WA) };
    });
    const DEFAULT_WA = 'Assalam o Alaikum {name}! SundayBazar se order {order} confirm karna hai: {items} · Total Rs {total}. Kya hum ye order bhej dein? Reply YES ya NO.';
    route('POST', '/api/cs/:id/call', 'cs', (req, u, b, res, p) => {
        const o = q.get('SELECT * FROM orders WHERE id=?', decodeURIComponent(p.id));
        need(o, 'Not found', 404);
        const OUT = { confirmed: 'confirmed', cancelled: 'cs_cancelled', no_answer: 'hold', callback: 'hold', wrong_number: 'hold', delivery_retry: null, delivery_cancel: null };
        need(b.outcome in OUT, 'Unknown outcome');
        q.run('INSERT INTO cs_calls(order_id,user_id,outcome,note) VALUES(?,?,?,?)', o.id, u.id, b.outcome, b.note || '');
        let next = null;
        if (b.outcome === 'no_answer')
            next = new Date(Date.now() + (setting('retry_hours', 3)) * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
        if (b.outcome === 'callback' && b.next)
            next = String(b.next).replace('T', ' ').slice(0, 19);
        const stage = OUT[b.outcome];
        if (stage)
            q.run('UPDATE orders SET stage=?, cs_attempts=cs_attempts+1, cs_note=?, cs_by=?, cs_at=datetime(\'now\'), cs_next=? WHERE id=?', stage, b.note || null, u.id, next, o.id);
        else
            q.run('UPDATE orders SET cs_note=?, cs_by=?, cs_at=datetime(\'now\') WHERE id=?', (b.outcome === 'delivery_retry' ? 'Customer wants re-attempt: ' : 'Customer refuses: ') + (b.note || ''), u.id, o.id);
        // auto-cancel after N unanswered calls
        const maxTries = setting('max_attempts', 4);
        if (b.outcome === 'no_answer' && o.cs_attempts + 1 >= maxTries && setting('auto_cancel_unreachable', false))
            q.run("UPDATE orders SET stage='cs_cancelled', cs_note='No answer after ' || ? || ' calls' WHERE id=?", maxTries, o.id);
        L.refreshOrder(o.id);
        log(u.id, 'cs:' + b.outcome, 'order:' + o.id, b.note || '');
        if (S.configured() && setting('tag_shopify', true) && (b.outcome === 'confirmed' || b.outcome === 'cancelled') && !String(o.id).startsWith('demo'))
            S.tagOrder(o.id, [b.outcome === 'confirmed' ? 'ERP-Confirmed' : 'ERP-Cancel']).catch(e => log(null, 'shopify.tag.error', 'order:' + o.id, e.message));
        return { ok: true };
    });
    /* ---------------- customers ---------------- */
    route('GET', '/api/customers', 'customers', (req, u, b, res, p, qs) => {
        const w = [], a = [];
        if (qs.q) {
            const ph = L.normPhone(qs.q);
            w.push('(c.name LIKE ? OR c.city LIKE ?' + (ph.length >= 5 ? ' OR c.phone LIKE ?' : '') + ')');
            a.push('%' + qs.q + '%', '%' + qs.q + '%');
            if (ph.length >= 5)
                a.push('%' + ph + '%');
        }
        if (qs.label) {
            w.push('c.label=?');
            a.push(qs.label);
        }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const sort = { spent: 'c.spent DESC', orders: 'c.orders DESC', risky: 'c.returned DESC', recent: 'c.last_order DESC' }[qs.sort] || 'c.last_order DESC';
        const pg = page(qs);
        const rows = q.all(`SELECT c.*, f.note fnote FROM customers c LEFT JOIN customer_flags f ON f.phone=c.phone ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...a, pg.limit, pg.offset);
        const total = q.get(`SELECT COUNT(*) n FROM customers c ${where}`, ...a).n;
        const labels = q.all('SELECT label, COUNT(*) n FROM customers GROUP BY label');
        return { rows, total, page: pg.page, pages: Math.ceil(total / pg.limit), labels };
    });
    route('GET', '/api/customers/:phone', 'customers', (req, u, b, res, p) => {
        const ph = L.normPhone(decodeURIComponent(p.phone));
        return { customer: q.get('SELECT * FROM customers WHERE phone=?', ph), flag: q.get('SELECT * FROM customer_flags WHERE phone=?', ph),
            orders: q.all('SELECT id,name,created_at,total,status,city,tracking FROM orders WHERE phone=? ORDER BY created_at DESC', ph), wa: L.waNumber(ph) };
    });
    route('POST', '/api/customers/:phone/flag', 'customers_edit', (req, u, b, res, p) => {
        const ph = L.normPhone(decodeURIComponent(p.phone));
        need(ph, 'No phone');
        q.run(`INSERT INTO customer_flags(phone,blacklist,vip,note,updated_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(phone) DO UPDATE SET blacklist=excluded.blacklist, vip=excluded.vip, note=excluded.note, updated_at=excluded.updated_at`, ph, b.blacklist ? 1 : 0, b.vip ? 1 : 0, b.note || null);
        L.recomputeCustomers();
        log(u.id, 'customer.flag', 'customer:' + ph, b);
        return { ok: true };
    });
    /* ---------------- warehouse: pick, pack, returns ---------------- */
    const PICKABLE = `o.status IN ('confirmed','picked') AND o.cancelled_at IS NULL`;
    route('GET', '/api/pick', 'warehouse', () => {
        const items = q.all(`SELECT i.id, i.order_id, i.sku, i.title, i.qty, i.picked, o.name, o.created_at, o.status, o.missing, COALESCE(l.location, pr.rack, '') location, pr.image, pr.size, pr.qty stock
    FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products pr ON pr.variant_id=i.variant_id LEFT JOIN locations l ON l.sku=i.sku
    WHERE ${PICKABLE} ORDER BY location, i.sku`);
        const orders = q.all(`SELECT o.id, o.name, o.created_at, o.status, o.missing, o.items, (SELECT SUM(picked) FROM order_items WHERE order_id=o.id) picked FROM orders o WHERE ${PICKABLE} ORDER BY o.created_at`);
        const packQueue = q.all(`SELECT id, name, created_at, items, city FROM orders WHERE status='packed' ORDER BY packed_at`);
        return { items, orders, packQueue };
    });
    function pickItem(itemId, u, val = 1) {
        const it = q.get('SELECT * FROM order_items WHERE id=?', itemId);
        need(it, 'Item not found', 404);
        q.run("UPDATE order_items SET picked=?, picked_by=?, picked_at=datetime('now') WHERE id=?", val, u.id, it.id);
        const left = q.get('SELECT COUNT(*) n FROM order_items WHERE order_id=? AND picked=0', it.order_id).n;
        const o = q.get('SELECT stage FROM orders WHERE id=?', it.order_id);
        if (!left && o.stage === 'confirmed')
            q.run("UPDATE orders SET stage='picked', picked_at=datetime('now'), missing=0 WHERE id=?", it.order_id);
        if (left && o.stage === 'picked')
            q.run("UPDATE orders SET stage='confirmed' WHERE id=?", it.order_id);
        L.refreshOrder(it.order_id);
        log(u.id, val ? 'pick' : 'unpick', 'order:' + it.order_id, it.sku);
        return { item: it, left, order: q.get('SELECT id,name,status FROM orders WHERE id=?', it.order_id) };
    }
    route('POST', '/api/pick/scan', 'warehouse', (req, u, b) => {
        const code = String(b.code || '').trim().toUpperCase();
        need(code, 'Scan a SKU');
        const it = q.get(`SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? AND i.picked=0 AND ${PICKABLE} ORDER BY o.created_at LIMIT 1`, code);
        if (!it) {
            const done = q.get(`SELECT o.name FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? ORDER BY o.created_at DESC LIMIT 1`, code);
            throw new HttpError(404, done ? `${code} is not waiting to be picked (last order ${done.name})` : `${code} is not in any confirmed order`);
        }
        return pickItem(it.id, u);
    });
    route('POST', '/api/pick/item/:id', 'warehouse', (req, u, b, res, p) => pickItem(+p.id, u, b.picked === 0 ? 0 : 1));
    route('POST', '/api/orders/:id/missing', 'warehouse', (req, u, b, res, p) => {
        const id = decodeURIComponent(p.id);
        q.run('UPDATE orders SET missing=? WHERE id=?', b.missing ? 1 : 0, id);
        log(u.id, b.missing ? 'item.missing' : 'item.found', 'order:' + id, b.note || '');
        return { ok: true };
    });
    route('POST', '/api/pack/scan', 'warehouse', (req, u, b) => {
        const code = String(b.code || '').trim();
        need(code, 'Scan the order number');
        const o = q.get("SELECT * FROM orders WHERE name=? OR name=? OR tracking=?", code, code.toUpperCase(), code);
        need(o, 'Order ' + code + ' not found', 404);
        need(['picked', 'confirmed'].includes(o.status), `${o.name} is "${L.STATUS[o.status]}", not ready to pack`);
        const left = q.get('SELECT COUNT(*) n FROM order_items WHERE order_id=? AND picked=0', o.id).n;
        need(!left || b.force, `${left} item(s) of ${o.name} are not picked yet`);
        q.run("UPDATE orders SET stage='packed', packed_at=datetime('now') WHERE id=?", o.id);
        L.refreshOrder(o.id);
        log(u.id, 'pack', 'order:' + o.id, '');
        return { ok: true, order: { id: o.id, name: o.name } };
    });
    route('GET', '/api/returns', 'warehouse', () => ({
        pending: q.all(`SELECT id,name,cust_name,city,tracking,status,returned_at,total,items FROM orders WHERE status IN ('returning','returned') ORDER BY returned_at`),
        recent: q.all(`SELECT r.*, o.name, us.name user FROM returns r LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN users us ON us.id=r.user_id ORDER BY r.id DESC LIMIT 50`),
    }));
    route('POST', '/api/returns/receive', 'warehouse', async (req, u, b) => {
        const code = String(b.code || '').trim();
        need(code, 'Scan tracking number or order number');
        const o = q.get('SELECT * FROM orders WHERE tracking=? OR name=? OR name=?', code, code, code.toUpperCase());
        need(o, 'No order with ' + code, 404);
        need(!o.return_received_at, `${o.name} was already received on ${String(o.return_received_at).slice(0, 10)}`);
        const items = q.all('SELECT i.*, pr.inventory_item FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE order_id=?', o.id);
        const restock = b.restock !== false && b.cond !== 'damaged';
        const results = [];
        for (const it of items) {
            let pushed = false, err = null;
            if (restock && S.configured() && setting('restock_shopify', true) && it.inventory_item && !String(o.id).startsWith('demo')) {
                try {
                    await S.adjustInventory(it.inventory_item, it.qty || 1, 'restock');
                    pushed = true;
                }
                catch (e) {
                    err = e.message;
                }
            }
            if (restock && !b.location && services.wms && services.wms.receiveReturn) {
                try {
                    services.wms.receiveReturn(it.sku, 'Return ' + (o.name || o.id), u.id);
                }
                catch (e) {
                    console.error('wms return', e.message);
                }
            }
            if (restock && b.location) {
                q.run(`INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,datetime('now'),?) ON CONFLICT(sku) DO UPDATE SET location=excluded.location, updated_at=excluded.updated_at, updated_by=excluded.updated_by`, it.sku, b.location, u.id);
                q.run('INSERT INTO stock_moves(sku,to_loc,reason,user_id) VALUES(?,?,?,?)', it.sku, b.location, 'return', u.id);
            }
            if (restock && it.variant_id)
                q.run('UPDATE products SET qty=qty+?, sold_at=NULL WHERE variant_id=? AND qty<=0', it.qty || 1, it.variant_id);
            q.run('INSERT INTO returns(order_id,sku,cond,restocked,location,note,user_id) VALUES(?,?,?,?,?,?,?)', o.id, it.sku, b.cond || 'good', restock ? 1 : 0, b.location || null, err ? 'Shopify: ' + err : (b.note || null), u.id);
            results.push({ sku: it.sku, restocked: restock, shopify: pushed, error: err });
        }
        q.run("UPDATE orders SET return_received_at=datetime('now') WHERE id=?", o.id);
        L.refreshOrder(o.id);
        log(u.id, 'return.received', 'order:' + o.id, results);
        return { ok: true, order: { id: o.id, name: o.name }, results };
    });
    /* ---------------- inventory ---------------- */
    route('GET', '/api/inventory', 'inventory', (req, u, b, res, p, qs) => {
        const w = [], a = [];
        if (qs.instock !== '0')
            w.push('p.qty>0');
        if (qs.q) {
            const t = '%' + qs.q.trim() + '%';
            w.push('(p.sku LIKE ? OR p.title LIKE ? OR p.brand LIKE ? OR p.tags LIKE ?)');
            a.push(t, t, t, t);
        }
        if (qs.rack) {
            w.push('COALESCE(l.location,p.rack) LIKE ?');
            a.push(qs.rack + '%');
        }
        if (qs.lot) {
            w.push('p.lot=?');
            a.push(qs.lot);
        }
        if (qs.age) {
            w.push(`p.created_at < datetime('now', ?)`);
            a.push('-' + (+qs.age) + ' days');
        }
        if (qs.noloc === '1')
            w.push('l.location IS NULL');
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const pg = page(qs, 60);
        const rows = q.all(`SELECT p.*, l.location loc, CAST(julianday('now')-julianday(p.created_at) AS INT) age FROM products p LEFT JOIN locations l ON l.sku=p.sku ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, ...a, pg.limit, pg.offset);
        const total = q.get(`SELECT COUNT(*) n, COALESCE(SUM(p.price*p.qty),0) value, COALESCE(SUM(p.cost*p.qty),0) cost FROM products p LEFT JOIN locations l ON l.sku=p.sku ${where}`, ...a);
        return { rows, total: total.n, value: total.value, cost: total.cost, page: pg.page, pages: Math.ceil(total.n / pg.limit) };
    });
    route('GET', '/api/racks', 'inventory', () => q.all(`SELECT COALESCE(l.location, p.rack, '?') rack, COUNT(*) items, ROUND(SUM(p.price)) value, MIN(p.created_at) oldest
  FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 GROUP BY 1 ORDER BY 1`));
    route('POST', '/api/locations', 'inventory', (req, u, b) => {
        const sku = String(b.sku || '').trim().toUpperCase(), loc = String(b.location || '').trim().toUpperCase();
        need(sku && loc, 'SKU and location are needed');
        const prev = q.get('SELECT location FROM locations WHERE sku=?', sku);
        q.run(`INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,datetime('now'),?) ON CONFLICT(sku) DO UPDATE SET location=excluded.location, updated_at=excluded.updated_at, updated_by=excluded.updated_by`, sku, loc, u.id);
        q.run('INSERT INTO stock_moves(sku,from_loc,to_loc,reason,user_id) VALUES(?,?,?,?,?)', sku, prev ? prev.location : null, loc, b.reason || 'putaway', u.id);
        const pr = q.get('SELECT title, qty FROM products WHERE UPPER(sku)=?', sku);
        return { ok: true, sku, location: loc, product: pr || null };
    });
    route('GET', '/api/lookup', 'dashboard', (req, u, b, res, p, qs) => {
        const c = String(qs.code || '').trim();
        need(c, 'Nothing to look up');
        const prod = q.get('SELECT p.*, l.location loc FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE UPPER(p.sku)=?', c.toUpperCase());
        const order = q.get('SELECT id,name,status FROM orders WHERE name=? OR name=? OR tracking=?', c, c.toUpperCase(), c);
        const inOrders = prod ? q.all('SELECT o.id,o.name,o.status,o.created_at FROM order_items i JOIN orders o ON o.id=i.order_id WHERE UPPER(i.sku)=? ORDER BY o.created_at DESC LIMIT 5', c.toUpperCase()) : [];
        return { product: prod || null, order: order || null, inOrders };
    });
    /* ---------------- lots, listing & pricing ---------------- */
    function lotStats() {
        const rows = q.all(`SELECT p.lot, COUNT(*) listed, SUM(p.qty>0) instock, SUM(p.qty<=0) sold, ROUND(SUM(CASE WHEN p.qty>0 THEN p.price END)) stock_value,
      ROUND(SUM(p.cost)) cost_listed, MIN(p.created_at) first_listed, MAX(p.created_at) last_listed FROM products p WHERE p.lot<>'' GROUP BY p.lot`);
        const rev = new Map(q.all(`SELECT pr.lot, ROUND(SUM(i.price*i.qty)) revenue, COUNT(*) delivered FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products pr ON pr.variant_id=i.variant_id
      WHERE o.status='delivered' AND pr.lot<>'' GROUP BY pr.lot`).map(r => [r.lot, r]));
        const ret = new Map(q.all(`SELECT pr.lot, COUNT(*) n FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products pr ON pr.variant_id=i.variant_id WHERE o.status IN ('returned','return_received','returning') AND pr.lot<>'' GROUP BY pr.lot`).map(r => [r.lot, r.n]));
        const meta = new Map(q.all('SELECT * FROM lots').map(r => [r.name, r]));
        return rows.map(r => {
            const m = meta.get(r.lot) || {}, rv = rev.get(r.lot) || { revenue: 0, delivered: 0 };
            const cost = m.cost != null ? m.cost : r.cost_listed;
            const sellThrough = r.listed ? Math.round(100 * r.sold / r.listed) : 0;
            return Object.assign(Object.assign({}, r), { vendor: m.vendor || '', bought_on: m.bought_on || '', pieces: m.pieces || null, note: m.note || '', cost: cost || 0, revenue: rv.revenue || 0, delivered: rv.delivered || 0, returns: ret.get(r.lot) || 0, sellThrough, profit: Math.round((rv.revenue || 0) - (cost || 0)), unlisted: m.pieces ? Math.max(0, m.pieces - r.listed) : null });
        }).sort((a, b) => String(b.last_listed).localeCompare(String(a.last_listed)));
    }
    route('GET', '/api/lots', 'listing', () => lotStats());
    route('POST', '/api/lots/:name', 'listing', (req, u, b, res, p) => {
        const name = decodeURIComponent(p.name);
        q.run(`INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,updated_at) VALUES(?,?,?,?,?,?,datetime('now')) ON CONFLICT(name) DO UPDATE SET vendor=excluded.vendor, bought_on=excluded.bought_on, cost=excluded.cost, pieces=excluded.pieces, note=excluded.note, updated_at=excluded.updated_at`, name, b.vendor || '', b.bought_on || '', b.cost === '' || b.cost == null ? null : +b.cost, b.pieces ? +b.pieces : null, b.note || '');
        log(u.id, 'lot.update', 'lot:' + name, b);
        return { ok: true };
    });
    /* ---------------- list pairs (Lister inside the ERP) ---------------- */
    const isOwner = u => can(u, 'pricing_apply') || can(u, 'finance');
    const listEcon = () => Object.assign({}, PR.ECON_DEFAULTS, setting('list_econ', {}) || {});
    // Lots entered on the old "Lots & pricing" screen have a total cost and pieces but no per-pair cost: work it out
    const perPiece = l => l.per_piece > 0 ? l.per_piece : (l.cost > 0 && l.pieces > (l.bad || 0) ? Math.round(((l.cost || 0) + (l.extra || 0)) / (l.pieces - (l.bad || 0))) : 0);
    const lotRow = name => { const l = q.get('SELECT * FROM lots WHERE name=?', name); if (l) {
        try {
            l.comp = JSON.parse(l.comp || '[]');
        }
        catch (_a) {
            l.comp = [];
        }
        l.per_piece = perPiece(l);
    } return l; };
    function lotAvg(lot) {
        const its = q.all('SELECT type,cond,gender,brand,size FROM listings WHERE lot=? LIMIT 2000', lot.name);
        if (its.length < 20)
            return 0;
        const vs = its.map(i => PR.valueOf(i.type, i.cond, i.gender, i.brand, i.size)).filter(x => x > 0);
        return vs.length >= 20 ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
    }
    const eng = () => PR.engine(listEcon(), { lotAvg });
    function nextSerial() { return Math.max(+setting('sku_next', 0) || 0, (q.get('SELECT MAX(serial) m FROM listings') || {}).m + 1 || 0, +listEcon().startSerial || 92345); }
    function pairIn(b) {
        const v = { lot: String(b.lot || ''), type: String(b.type || ''), gender: String(b.gender || 'Woman'), brand: String(b.brand || '').trim(), size: String(b.size || ''),
            color: String(b.color || ''), cond: String(b.cond || ''), material: String(b.material || ''), note: String(b.note || '').trim(), title: String(b.title || '').trim() };
        v.lotRow = v.lot ? lotRow(v.lot) : null;
        return v;
    }
    function quoteFor(u, v, override) {
        const x = eng().quote(Object.assign(Object.assign({}, v), { lot: v.lotRow, override: isOwner(u) && +override > 0 ? +override : null }));
        if (!x)
            return null;
        const pub = { final: x.final, status: x.status, market: x.market, floor: x.floor, sales: x.sales.map(s => ({ day: s.day, off: s.off, price: s.price })), all: x.all, why: x.why };
        return isOwner(u) ? Object.assign(Object.assign(Object.assign({}, pub), x), { owner: true }) : pub;
    }
    route('GET', '/api/list/meta', 'listing', (req, u) => {
        const e = listEcon();
        return { types: PR.types(), conds: PR.CONDS, lists: PR.P.lists, brands: PR.allBrands(), group: PR.GROUP, letters: e.letters, labelW: +e.labelW || 50, labelH: +e.labelH || 25,
            next: nextSerial(), owner: isOwner(u), plan: PR.PLAN3, lots: q.all('SELECT * FROM lots ORDER BY COALESCE(bought_on,updated_at) DESC').map(l => ({ name: l.name, kind: l.kind || '', bought_on: l.bought_on || '', ready: !!(perPiece(l) || l.cpv) })) };
    });
    // Mistakes listers make that cost profit. block = cannot save; warn = shown in yellow.
    const SNEAKERS = ['Running', 'Sports', 'Casual', 'Loafers', 'Formals'];
    function listChecks(u, v, b) {
        const block = [], warn = [];
        const sz = parseFloat(String(v.size).replace(/[^0-9.]/g, '')) || 0;
        if (!v.lot)
            block.push('Choose a lot.');
        else if (!v.lotRow || !(v.lotRow.per_piece > 0 || v.lotRow.cpv > 0))
            block.push('This lot has no cost yet. Ask the owner to enter it under Lots.');
        if (!PR.types().includes(v.type))
            block.push('Choose a type from the list.');
        if (!PR.CONDS.includes(v.cond))
            block.push('Choose a condition from the list.');
        if (!['Woman', 'Men', 'Kids'].includes(v.gender))
            block.push('Choose Woman, Men or Kids.');
        if (!v.size || !PR.P.lists.size.includes(v.size))
            block.push('Choose a size from the list.');
        if (!v.color)
            block.push('Choose a colour.');
        if (!v.brand)
            block.push('Enter a brand.');
        else if (!PR.knownBrand(v.brand))
            (isOwner(u) ? warn : block).push(`"${v.brand}" is not on the brand list. Pick it from the list (check the spelling)${isOwner(u) ? '' : ', or ask the owner'}.`);
        if (v.cond === 'Good' && !v.note)
            block.push('Good condition: add a note about the marks.');
        if (sz) {
            if (v.gender !== 'Kids' && sz <= 33)
                block.push(`Size ${sz} is a kids' size: choose Kids.`);
            if (v.gender === 'Kids' && sz >= 36)
                block.push(`Size ${sz} is not a kids' size: choose Woman or Men.`);
            if (v.gender === 'Woman' && sz >= 43 && SNEAKERS.includes(v.type))
                block.push(`Size ${sz} ${v.type}: this is a men's pair. Choose Men (men's pairs sell for more).`);
            if (v.gender === 'Men' && sz <= 38)
                warn.push(`Size ${sz} for Men is unusual: check it is not a women's pair.`);
            if (v.gender === 'Woman' && sz >= 42 && /Heels|Stilettos|Pumps|Wedges/.test(v.type))
                warn.push(`Size ${sz} heels are rare: check the size.`);
        }
        // same pair saved twice by mistake
        if (v.lot && v.brand && !b.confirmDup) {
            const d = q.get(`SELECT sku FROM listings WHERE user_id=? AND lot=? AND type=? AND brand=? AND size=? AND color=? AND cond=? AND at > datetime('now','-20 minutes') ORDER BY serial DESC LIMIT 1`, u.id, v.lot, v.type, v.brand, v.size, v.color, v.cond);
            if (d)
                warn.push(`You saved the same pair ${d.sku} a few minutes ago. If this is a second pair, save again to confirm.`), (b._dup = d.sku);
        }
        return { block, warn };
    }
    route('POST', '/api/list/quote', 'listing', (req, u, b) => {
        const v = pairIn(b);
        const x = quoteFor(u, v, b.override);
        const c = listChecks(u, v, Object.assign(Object.assign({}, b), { confirmDup: true }));
        return { quote: x, title: PR.autoTitle(v), next: nextSerial(), letter: (listEcon().letters || {})[PR.groupOf(v.type, v.gender)] || 'X', msg: [...c.block, ...c.warn], block: c.block, warn: c.warn };
    });
    route('POST', '/api/list/save', 'listing', (req, u, b) => {
        const v = pairIn(b);
        const chk = listChecks(u, v, b);
        need(!chk.block.length, chk.block.join(' '));
        if (b._dup)
            throw Object.assign(new HttpError(409, chk.warn.find(w => w.includes(b._dup))), { dup: b._dup });
        const x = eng().quote(Object.assign(Object.assign({}, v), { lot: v.lotRow, override: isOwner(u) && +b.override > 0 ? +b.override : null }));
        need(x, 'This type cannot be priced');
        need(x.final >= (x.floor || 0), `This price loses money. Break-even is Rs ${x.floor}.`);
        const grp = PR.groupOf(v.type, v.gender);
        const letter = (listEcon().letters || {})[grp] || 'X';
        const it = q.tx(() => {
            const serial = nextSerial();
            const sku = `${letter}-${serial}`;
            q.run(`INSERT INTO listings(sku,serial,letter,grp,lot,gender,type,brand,size,color,cond,material,note,title,price,market,floor,cost,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sku, serial, letter, grp, v.lot, v.gender, v.type, v.brand, v.size, v.color, v.cond, v.material, v.note, v.title || PR.autoTitle(v), x.final, x.market, x.floor, x.cost, u.id);
            setSetting('sku_next', serial + 1);
            return q.get('SELECT * FROM listings WHERE sku=?', sku);
        });
        log(u.id, 'listing.save', 'sku:' + it.sku, { price: it.price, lot: it.lot });
        if (!isOwner(u)) {
            delete it.cost;
            delete it.floor;
        }
        return it;
    });
    const listCols = u => isOwner(u) ? 'l.*, us.name by_name' : 'l.sku,l.serial,l.grp,l.lot,l.gender,l.type,l.brand,l.size,l.color,l.cond,l.material,l.note,l.title,l.price,l.at,l.exported,l.exported_at,l.user_id, us.name by_name';
    route('GET', '/api/list/recent', 'listing', (req, u, b, res, p, qs) => {
        const where = [];
        const args = [];
        if (qs.mine === '1') {
            where.push('l.user_id=?');
            args.push(u.id);
        }
        if (qs.pending === '1')
            where.push('l.exported=0');
        if (qs.lot) {
            where.push('l.lot=?');
            args.push(qs.lot);
        }
        if (qs.q) {
            where.push('(l.sku LIKE ? OR l.brand LIKE ? OR l.title LIKE ?)');
            args.push(...Array(3).fill('%' + qs.q + '%'));
        }
        const lim = Math.min(2000, +qs.limit || 200);
        return q.all(`SELECT ${listCols(u)} FROM listings l LEFT JOIN users us ON us.id=l.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.serial DESC LIMIT ${lim}`, ...args);
    });
    route('POST', '/api/list/delete/:sku', 'listing', (req, u, b, res, p) => {
        const it = q.get('SELECT * FROM listings WHERE sku=?', decodeURIComponent(p.sku));
        need(it, 'Not found', 404);
        need(isOwner(u) || (it.user_id === u.id && !it.exported), 'Only the owner can remove a pair that is already exported', 403);
        q.run('DELETE FROM listings WHERE sku=?', it.sku);
        log(u.id, 'listing.delete', 'sku:' + it.sku, it);
        return { ok: true };
    });
    route('POST', '/api/list/export', 'listing', (req, u, b) => {
        const skus = Array.isArray(b.skus) ? b.skus.map(String) : [];
        const items = skus.length ? q.all(`SELECT * FROM listings WHERE sku IN (${skus.map(() => '?').join(',')}) ORDER BY serial`, ...skus) : q.all('SELECT * FROM listings WHERE exported=0 ORDER BY serial');
        need(items.length, 'Nothing to export');
        const csv = PR.shopifyCsv(items, listEcon(), isOwner(u));
        if (b.mark !== false)
            q.run(`UPDATE listings SET exported=1, exported_at=datetime('now') WHERE sku IN (${items.map(() => '?').join(',')})`, ...items.map(i => i.sku));
        log(u.id, 'listing.export', 'listings', { n: items.length });
        return { csv, n: items.length, filename: `shopify-import-${today()}-${items.length}.csv` };
    });
    route('GET', '/api/list/lots', 'listing', (req, u) => {
        const cnt = new Map(q.all('SELECT lot, COUNT(*) n, SUM(price) v FROM listings GROUP BY lot').map(r => [r.lot, r]));
        return q.all('SELECT * FROM lots ORDER BY COALESCE(bought_on,updated_at) DESC').map(l => {
            let comp = [];
            try {
                comp = JSON.parse(l.comp || '[]');
            }
            catch (_a) { }
            const c = cnt.get(l.name) || { n: 0, v: 0 };
            const sell = (l.pieces || 0) - (l.bad || 0);
            const base = { name: l.name, vendor: l.vendor || '', bought_on: l.bought_on || '', kind: l.kind || '', pieces: l.pieces, bad: l.bad || 0, sellable: sell, listed: c.n, listed_value: Math.round(c.v || 0), ready: !!(perPiece(l) || l.cpv), note: l.note || '' };
            return isOwner(u) ? Object.assign(Object.assign({}, base), { cost: l.cost, extra: l.extra || 0, per_piece: perPiece(l), cpv: l.cpv, comp }) : base;
        });
    });
    route('POST', '/api/list/lot-plan', 'listing', (req, u, b) => { need(isOwner(u), 'Owner only', 403); return eng().lotPlan(b); });
    route('POST', '/api/list/lots', 'listing', (req, u, b) => {
        need(isOwner(u), 'Only the owner can enter lot costs', 403);
        const name = String(b.name || '').trim();
        need(name, 'Enter a lot name');
        need(+b.cost > 0, 'Enter the lot price');
        need(+b.pieces > 0, 'Enter the total number of pairs');
        need((+b.bad || 0) < +b.pieces, "Damaged pairs can't be equal to or more than the total");
        const kind = b.kind === 'leftover' ? 'leftover' : 'used';
        const comp = (Array.isArray(b.comp) ? b.comp : []).filter(r => r && +r.n > 0).map(r => ({ t: String(r.t), g: String(r.g || 'Woman'), c: String(r.c), n: +r.n, b: String(r.b || '') }));
        const plan = eng().lotPlan({ name, kind, cost: +b.cost, extra: +b.extra || 0, pieces: +b.pieces, bad: +b.bad || 0, comp });
        q.run(`INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,kind,extra,bad,per_piece,cpv,comp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(name) DO UPDATE SET vendor=excluded.vendor,bought_on=excluded.bought_on,cost=excluded.cost,pieces=excluded.pieces,note=excluded.note,kind=excluded.kind,extra=excluded.extra,bad=excluded.bad,per_piece=excluded.per_piece,cpv=excluded.cpv,comp=excluded.comp,updated_at=excluded.updated_at`, name, String(b.vendor || ''), String(b.bought_on || today()), +b.cost, +b.pieces, String(b.note || ''), kind, +b.extra || 0, +b.bad || 0, plan.per_piece, plan.cpv || null, JSON.stringify(comp));
        log(u.id, 'lot.save', 'lot:' + name, { cost: +b.cost, pieces: +b.pieces, kind });
        return { ok: true, plan };
    });
    route('POST', '/api/list/lots/:name/delete', 'listing', (req, u, b, res, p) => {
        need(isOwner(u), 'Owner only', 403);
        const name = decodeURIComponent(p.name);
        need(!q.get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', name), 'Pairs are already listed from this lot, so it cannot be removed');
        q.run('DELETE FROM lots WHERE name=?', name);
        log(u.id, 'lot.delete', 'lot:' + name, null);
        return { ok: true };
    });
    route('GET', '/api/list/econ', 'listing', (req, u) => { need(isOwner(u), 'Owner only', 403); const e = eng(); return { econ: listEcon(), next: nextSerial(), perPair: { ads: Math.round(e.E.adsPP), fixed: Math.round(e.E.ohBE), profit: Math.round(e.E.ohT - e.E.ohBE), keep: +e.E.keep.toFixed(4) } }; });
    route('POST', '/api/list/econ', 'settings', (req, u, b) => {
        const cur = setting('list_econ', {}) || {};
        const nx = Object.assign({}, cur);
        for (const k of Object.keys(PR.ECON_DEFAULTS))
            if (k in b)
                nx[k] = (k === 'letters' || k === 'body' || k === 'status') ? b[k] : +b[k];
        setSetting('list_econ', nx);
        if (+b.next > 0) {
            need(+b.next >= ((q.get('SELECT MAX(serial) m FROM listings') || {}).m || 0) + 1, 'The next SKU number must be higher than the last one used');
            setSetting('sku_next', +b.next);
        }
        log(u.id, 'listing.econ', 'settings', b);
        return { ok: true };
    });
    route('GET', '/api/pricing/rules', 'listing', () => setting('pricing_rules', L.DEFAULT_RULES));
    route('POST', '/api/pricing/rules', 'listing', (req, u, b) => {
        need(Array.isArray(b.steps) && b.steps.every(s => s.days >= 0 && s.off >= 0 && s.off < 90), 'Check the markdown steps');
        const r = Object.assign(Object.assign(Object.assign({}, L.DEFAULT_RULES), b), { steps: b.steps.map(s => ({ days: +s.days, off: +s.off })).sort((a, c) => a.days - c.days) });
        setSetting('pricing_rules', r);
        log(u.id, 'pricing.rules', 'settings', r);
        return r;
    });
    route('GET', '/api/pricing/suggestions', 'listing', (req, u, b, res, p, qs) => {
        const rules = setting('pricing_rules', L.DEFAULT_RULES);
        const ls = Object.fromEntries(lotStats().map(l => [l.lot, l]));
        const w = ['p.qty>0', "p.status='ACTIVE'"], a = [];
        if (qs.lot) {
            w.push('p.lot=?');
            a.push(qs.lot);
        }
        const rows = q.all(`SELECT p.variant_id,p.product_id,p.sku,p.title,p.price,p.compare_at,p.cost,p.qty,p.created_at,p.lot,p.brand,p.image,p.size,p.cond FROM products p WHERE ${w.join(' AND ')} ORDER BY p.created_at LIMIT 5000`, ...a);
        const out = [];
        for (const r of rows) {
            const s = L.priceSuggestion(r, rules, ls);
            if (s)
                out.push(Object.assign(Object.assign({}, r), s));
        }
        // what similar items actually sold for (brand + type), as a sanity check
        return { rows: out.slice(0, 1000), total: out.length, rules };
    });
    route('POST', '/api/pricing/apply', 'pricing_apply', async (req, u, b) => {
        const items = (b.items || []).slice(0, 250);
        need(items.length, 'Nothing selected');
        const changes = [];
        for (const it of items) {
            const p0 = q.get('SELECT * FROM products WHERE variant_id=?', it.variant_id);
            if (!p0)
                continue;
            const price = Math.round(+it.price);
            need(price > 0, 'Bad price for ' + p0.sku);
            const compare = b.keepCompare !== false ? (p0.compare_at && p0.compare_at > price ? p0.compare_at : (p0.price > price ? p0.price : null)) : null;
            changes.push({ product_id: p0.product_id, variant_id: p0.variant_id, price, compare_at: compare, old: p0.price, sku: p0.sku });
        }
        let results;
        if (S.configured() && !setting('demo'))
            results = await S.updatePrices(changes);
        else
            results = changes.map(c => ({ variant_id: c.variant_id, ok: true, error: setting('demo') ? 'demo: not sent to Shopify' : '' }));
        for (const c of changes) {
            const r = results.find(x => x.variant_id === c.variant_id) || {};
            q.run('INSERT INTO price_changes(variant_id,sku,old_price,new_price,compare_at,reason,user_id,pushed,error) VALUES(?,?,?,?,?,?,?,?,?)', c.variant_id, c.sku, c.old, c.price, c.compare_at, b.reason || 'markdown', u.id, r.ok ? 1 : 0, r.error || null);
            if (r.ok)
                q.run('UPDATE products SET price=?, compare_at=? WHERE variant_id=?', c.price, c.compare_at, c.variant_id);
        }
        log(u.id, 'pricing.apply', 'products', { n: changes.length });
        return { ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok) };
    });
    route('GET', '/api/pricing/history', 'listing', () => q.all('SELECT pc.*, us.name user FROM price_changes pc LEFT JOIN users us ON us.id=pc.user_id ORDER BY pc.id DESC LIMIT 200'));
    /* ---------------- tracking ---------------- */
    route('GET', '/api/tracking', 'tracking', (req, u, b, res, p, qs) => {
        const B = {
            active: `o.status IN ('dispatched','in_transit','out_for_delivery')`,
            attempted: `o.status='attempted'`,
            stuck: `o.status IN ('dispatched','in_transit','out_for_delivery','attempted') AND o.dispatched_at < datetime('now','-' || ${+setting('stuck_days', 6)} || ' days')`,
            returning: `o.status IN ('returning','returned')`,
            delivered: `o.status='delivered' AND o.delivered_at>=datetime('now','-7 days')`,
        };
        const where = B[qs.bucket] || B.active;
        const rows = q.all(`SELECT o.id,o.name,o.cust_name,o.phone,o.city,o.total,o.tracking,o.courier,o.status,o.px_status,o.px_updated,o.dispatched_at,o.cs_note,
      CAST(julianday('now')-julianday(o.dispatched_at) AS INT) days, c.label clabel FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE ${where} ORDER BY o.dispatched_at LIMIT 500`);
        rows.forEach(r => r.wa = L.waNumber(r.phone));
        const counts = Object.fromEntries(Object.entries(B).map(([k, w]) => [k, q.get(`SELECT COUNT(*) n FROM orders o WHERE ${w}`).n]));
        return { rows, counts, lastSync: (q.get("SELECT at, message FROM sync_log WHERE kind='postex' ORDER BY id DESC LIMIT 1") || null) };
    });
    route('POST', '/api/tracking/:id/refresh', 'tracking', async (req, u, b, res, p) => {
        const o = q.get('SELECT * FROM orders WHERE id=?', decodeURIComponent(p.id));
        need(o && o.tracking, 'No tracking number');
        need(P.configured(), 'Add the PostEx token in Settings first');
        await P.trackOne(o.tracking);
        return q.get('SELECT status, px_status, px_updated FROM orders WHERE id=?', o.id);
    });
    /* ---------------- finance ---------------- */
    route('GET', '/api/finance/summary', 'finance', (req, u, b, res, p, qs) => F.summary(qs.month || today().slice(0, 7)));
    route('GET', '/api/finance/cod', 'finance', (req, u, b, res, p, qs) => {
        const settled = qs.settled === '1' ? 1 : 0;
        const rows = q.all(`SELECT id,name,cust_name,city,tracking,total,cod,px_fee,px_tax,delivered_at,settled,settled_at,settle_ref FROM orders WHERE status='delivered' AND settled=? ORDER BY delivered_at DESC LIMIT 1000`, settled);
        const tot = q.get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)),0) cod, COALESCE(SUM(COALESCE(px_fee,0)+COALESCE(px_tax,0)),0) fees FROM orders WHERE status='delivered' AND settled=?`, settled);
        return Object.assign({ rows }, tot);
    });
    route('POST', '/api/finance/settle', 'finance', (req, u, b) => {
        const ids = b.ids || [];
        need(ids.length, 'Select orders');
        for (const id of ids)
            q.run("UPDATE orders SET settled=1, settled_at=COALESCE(?,date('now')), settle_ref=COALESCE(?,settle_ref) WHERE id=? AND status='delivered'", b.date || null, b.ref || null, id);
        log(u.id, 'cod.settled', 'finance', { n: ids.length, ref: b.ref });
        return { ok: true };
    });
    route('GET', '/api/expense-categories', 'finance', () => setting('expense_categories', DEFAULTS.expense_categories));
    route('GET', '/api/expenses', 'finance', (req, u, b, res, p, qs) => q.all(`SELECT e.*, us.name user FROM expenses e LEFT JOIN users us ON us.id=e.user_id WHERE substr(e.day,1,7)=? ORDER BY e.day DESC, e.id DESC`, qs.month || today().slice(0, 7)));
    route('POST', '/api/expenses', 'finance', (req, u, b) => {
        need(b.day && b.category && +b.amount > 0, 'Date, category and amount are needed');
        if (b.id)
            q.run('UPDATE expenses SET day=?, category=?, amount=?, note=? WHERE id=?', b.day, b.category, +b.amount, b.note || '', +b.id);
        else
            q.run('INSERT INTO expenses(day,category,amount,note,user_id) VALUES(?,?,?,?,?)', b.day, b.category, +b.amount, b.note || '', u.id);
        log(u.id, b.id ? 'expense.edit' : 'expense.add', 'finance', b);
        return { ok: true };
    });
    route('DELETE', '/api/expenses/:id', 'finance', (req, u, b, res, p) => { const e = q.get('SELECT * FROM expenses WHERE id=?', +p.id); q.run('DELETE FROM expenses WHERE id=?', +p.id); log(u.id, 'expense.delete', 'finance', e); return { ok: true }; });
    route('GET', '/api/finance/export', 'finance', (req, u, b, res, p, qs) => {
        const m = qs.month || today().slice(0, 7);
        const rows = q.all(`SELECT name, date(created_at,'+5 hours') created, cust_name, city, total, status, tracking, cod, px_fee, px_tax, px_rev_fee, px_rev_tax, delivered_at, returned_at, settled, settle_ref FROM orders
    WHERE substr(COALESCE(delivered_at, returned_at, created_at),1,7)=? ORDER BY created_at`, m);
        const head = Object.keys(rows[0] || { name: '' });
        const csv = [head.join(',')].concat(rows.map(r => head.map(h => { const v = r[h] == null ? '' : String(r[h]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','))).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sundaybazar-orders-${m}.csv"` });
        res.end('﻿' + csv);
        return undefined;
    });
    /* ---------------- reports ---------------- */
    route('GET', '/api/reports', 'reports', (req, u, b, res, p, qs) => F.reports(Math.min(365, Math.max(7, +qs.days || 30))));
    /* ---------------- settings & sync ---------------- */
    const SETTING_KEYS = ['store_name', 'confirm_mode', 'retry_hours', 'max_attempts', 'auto_cancel_unreachable', 'tag_shopify', 'restock_shopify', 'wa_template',
        'stuck_days', 'history_days', 'postex_days', 'postex_check_payments', 'sync_minutes', 'shopify_location', 'courier_fee', 'return_fee', 'packaging_cost', 'cost_pct', 'expense_categories'];
    const DEFAULTS = { store_name: 'SundayBazar', confirm_mode: 'risky', retry_hours: 3, max_attempts: 4, auto_cancel_unreachable: false, tag_shopify: true, restock_shopify: true,
        wa_template: DEFAULT_WA, stuck_days: 6, history_days: 60, postex_days: 45, postex_check_payments: true, sync_minutes: 15, shopify_location: '', courier_fee: 250, return_fee: 150,
        packaging_cost: 40, cost_pct: 35, expense_categories: ['Salaries', 'Rent', 'Ads (Meta)', 'Lot purchase', 'Packaging', 'Electricity & internet', 'Transport', 'Misc'] };
    route('GET', '/api/settings', 'settings', () => {
        const s = Object.fromEntries(SETTING_KEYS.map(k => [k, setting(k, DEFAULTS[k])]));
        const sh = S.cfg();
        s.shopify = { shop: sh.shop, hasToken: !!sh.token, clientId: sh.clientId, hasSecret: !!sh.clientSecret };
        s.postex = { hasToken: P.configured() };
        s.lan = lanUrls();
        s.data_dir = DATA_DIR;
        s.defaults = { wa_template: DEFAULT_WA };
        return s;
    });
    route('POST', '/api/settings', 'settings', (req, u, b) => {
        for (const k of SETTING_KEYS)
            if (k in b)
                setSetting(k, b[k]);
        if (b.shopify) {
            const cur = setting('shopify', {}) || {};
            const nx = { shop: b.shopify.shop != null ? b.shopify.shop : cur.shop, clientId: b.shopify.clientId != null ? b.shopify.clientId : cur.clientId,
                token: b.shopify.token ? b.shopify.token : (b.shopify.clearToken ? '' : cur.token), clientSecret: b.shopify.clientSecret ? b.shopify.clientSecret : cur.clientSecret };
            setSetting('shopify', nx);
        }
        if (b.postex && b.postex.token)
            setSetting('postex', { token: b.postex.token });
        log(u.id, 'settings.save', 'settings', Object.keys(b));
        return { ok: true };
    });
    route('POST', '/api/settings/test-shopify', 'settings', async () => { const d = await S.shopInfo(); return { shop: d.shop, locations: d.locations.nodes }; });
    route('POST', '/api/settings/test-postex', 'settings', async () => { const j = await P.call('/v1/get-order-status'); return { ok: true, statuses: j.dist || j }; });
    route('POST', '/api/sync', 'settings', (req, u, b) => { runSync(b.kind || 'all', u.id); return syncState(); });
    route('GET', '/api/sync', 'dashboard', () => syncState());
    route('GET', '/api/sync/log', 'settings', () => q.all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 100'));
    route('POST', '/api/demo/load', 'settings', () => { need(!S.configured() || setting('demo'), 'Demo data cannot be loaded once Shopify is connected'); require('./lib/demo').load(); return { ok: true }; });
    route('POST', '/api/demo/clear', 'settings', (req, u) => { require('./lib/demo').clear(); log(u.id, 'demo.clear', 'settings', ''); return { ok: true }; });
    /* ---------------- background sync ---------------- */
    const sync = { running: false, kind: null, progress: '', last: {} };
    function syncState() { return Object.assign(Object.assign({}, sync), { last: { orders: setting('orders_synced_at'), products: setting('products_synced_at'), postex: setting('postex_synced_at') } }); }
    async function runSync(kind = 'all', userId) {
        if (sync.running || setting('demo'))
            return;
        sync.running = true;
        sync.kind = kind;
        sync.progress = 'Starting…';
        try {
            if ((kind === 'all' || kind === 'orders') && S.configured())
                await S.syncOrders(n => sync.progress = `Shopify orders: ${n}`);
            if ((kind === 'all' || kind === 'products') && S.configured())
                await S.syncProducts(n => sync.progress = `Shopify products: ${n}`);
            if ((kind === 'all' || kind === 'postex') && P.configured()) {
                await P.syncAll(n => sync.progress = `PostEx parcels: ${n}`);
                setSetting('postex_synced_at', new Date().toISOString());
            }
            sync.progress = 'Done';
        }
        catch (e) {
            sync.progress = 'Error: ' + e.message;
            require('./lib/db').syncLog(kind, false, e.message);
        }
        finally {
            sync.running = false;
            if (userId)
                log(userId, 'sync', 'settings', kind);
        }
    }
    let tick = 0;
    setInterval(() => {
        tick++;
        runJobs(tick);
        if (sync.running || setting('demo'))
            return;
        const mins = Math.max(5, +setting('sync_minutes', 15));
        if (tick % mins === 0)
            runSync('orders');
        if (tick % 60 === 30)
            runSync('products');
        if (tick % 120 === 45)
            runSync('postex');
    }, 60000);
    /* ---------------- files (receipts, photos, documents) ---------------- */
    q.run(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, data TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')))`);
    route('POST', '/api/files', 'dashboard', (req, u, b) => {
        need(b.data && typeof b.data === 'string', 'No file');
        const size = Math.floor(b.data.length * 3 / 4);
        need(size <= 4.2e6, 'File is too big (max 4 MB)');
        const id = require('crypto').randomBytes(10).toString('hex');
        q.run('INSERT INTO files(id,name,type,size,data,user_id) VALUES(?,?,?,?,?,?)', id, String(b.name || 'file').slice(0, 120), String(b.type || 'application/octet-stream').slice(0, 80), size, b.data, u.id);
        return { id };
    });
    route('GET', '/api/files/:id', 'dashboard', (req, u, b, res, p) => {
        const f = q.get('SELECT * FROM files WHERE id=?', p.id);
        need(f, 'Not found', 404);
        const safe = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/.test(f.type) ? f.type : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': safe, 'Content-Disposition': (safe === 'application/octet-stream' ? 'attachment' : 'inline') + '; filename="' + f.name.replace(/[^\w.\- ]/g, '_') + '"', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(Buffer.from(f.data, 'base64'));
    });
    /* ---------------- modules (accounts, HR, marketing, tickets, WMS, operations …) ----------------
       Each file in modules/ exports { name, perms, schema, migrate, routes(ctx), jobs, counts(u), alerts(u) }.
       ctx.services lets modules call each other, e.g. ctx.services.accounts.post({...}). */
    const services = {};
    const ctx = { pkNow, pkToday, route, q, db: require('./lib/db').db, setting, setSetting, log, need, can, today, page, HttpError, A, S, P, L, F, PR, services, maskPhone, runSync: (...a) => runSync(...a), syncLog: require('./lib/db').syncLog, DATA_DIR };
    const MODS = require('./modules');
    const JOBS = [];
    for (const m of MODS) {
        for (const pm of m.perms || [])
            if (!A.PERMS.find(x => x[0] === pm[0])) {
                A.PERMS.push(pm);
                A.ALL.push(pm[0]);
            }
        if (m.schema)
            ctx.db.exec(m.schema);
        if (m.migrate)
            m.migrate(ctx);
    }
    services.activityLabels = { pack: 'Packed order', 'return.received': 'Received return', 'listing.save': 'Listed pair', 'listing.export': 'Exported listings', 'lot.save': 'Saved lot', 'pricing.apply': 'Changed prices', note: 'Order note', 'customer.flag': 'Flagged customer', 'cod.settled': 'Marked COD settled', login: 'Logged in' };
    for (const m of MODS)
        Object.assign(services.activityLabels, m.activity || {});
    for (const m of MODS) {
        if (m.routes)
            m.routes(ctx);
        for (const j of m.jobs || [])
            JOBS.push(Object.assign(Object.assign({}, j), { mod: m.name }));
    }
    for (const m of MODS)
        if (m.ready)
            m.ready(ctx);
    route('GET', '/api/counts', 'dashboard', (req, u) => {
        const c = {};
        if (can(u, 'cs'))
            c.cs = q.get(`SELECT COUNT(*) n FROM orders WHERE stage IN ('new','hold') AND tracking IS NULL AND cancelled_at IS NULL AND status IN ('new','hold')`).n;
        if (can(u, 'warehouse'))
            c.warehouse = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked')`).n;
        if (can(u, 'tracking'))
            c.tracking = q.get(`SELECT COUNT(*) n FROM orders WHERE status='attempted'`).n;
        for (const m of MODS)
            if (m.counts) {
                try {
                    Object.assign(c, m.counts(u, ctx) || {});
                }
                catch (e) {
                    console.error(m.name, 'counts', e.message);
                }
            }
        return c;
    });
    function collectAlerts(u) {
        const out = [];
        if (can(u, 'tracking')) {
            const n = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < datetime('now','-6 days')`).n;
            if (n)
                out.push({ level: 'warn', text: `${n} parcels have not been delivered in 6+ days`, href: '#/tracking/stuck', mod: 'tracking' });
        }
        for (const m of MODS)
            if (m.alerts) {
                try {
                    for (const a of m.alerts(u, ctx) || [])
                        out.push(Object.assign(Object.assign({}, a), { mod: m.name }));
                }
                catch (e) {
                    console.error(m.name, 'alerts', e.message);
                }
            }
        const rank = { bad: 0, warn: 1, info: 2 };
        return out.sort((a, b) => { var _a, _b; return ((_a = rank[a.level]) !== null && _a !== void 0 ? _a : 2) - ((_b = rank[b.level]) !== null && _b !== void 0 ? _b : 2); });
    }
    route('GET', '/api/alerts', 'dashboard', (req, u) => collectAlerts(u));
    /* ---------------- automatic daily backup (safe while running) ---------------- */
    function backupNow() {
        const dir = path.join(DATA_DIR, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `sundaybazar-${pkNow().slice(0, 10)}.db`);
        if (fs.existsSync(f))
            fs.unlinkSync(f);
        require('./lib/db').db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
        const keep = Math.max(3, +setting('backup_keep_days', 30));
        fs.readdirSync(dir).filter(x => /^sundaybazar-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().slice(0, -keep).forEach(x => fs.unlinkSync(path.join(dir, x)));
        setSetting('backup_last', pkNow());
        return f;
    }
    JOBS.push({ name: 'backup', mod: 'core', every: 60, offset: 7, run: () => { if (typeof window !== 'undefined')
            return; if (setting('backup_last', '').slice(0, 10) !== pkToday() && pkNow().slice(11, 13) >= '02')
            backupNow(); } });
    route('POST', '/api/backup', 'settings', (req, u) => { const f = backupNow(); log(u.id, 'backup', 'settings', path.basename(f)); return { ok: true, file: path.basename(f), at: setting('backup_last') }; });
    route('GET', '/api/backup', 'users', (req, u, b, res) => {
        const f = backupNow();
        log(u.id, 'backup.download', 'settings', path.basename(f));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(f)}"` });
        fs.createReadStream(f).pipe(res);
    });
    ctx.collectAlerts = collectAlerts;
    async function runJobs(tick) {
        for (const j of JOBS) {
            const every = Math.max(1, +(typeof j.every === 'function' ? j.every(ctx) : j.every) || 60);
            if (tick % every !== (j.offset || 0) % every)
                continue;
            if (j.running)
                continue;
            j.running = true;
            try {
                await j.run(ctx);
            }
            catch (e) {
                ctx.syncLog(j.mod + ':' + (j.name || 'job'), false, e.message);
            }
            finally {
                j.running = false;
            }
        }
    }
    /* ---------------- http ---------------- */
    const APPDIR = path.join(PUB, 'app');
    function appBundle() { return fs.readdirSync(APPDIR).filter(f => f.endsWith('.js')).sort().map(f => `/* ==== ${f} ==== */\n` + fs.readFileSync(path.join(APPDIR, f), 'utf8')).join('\n'); }
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
    const SEC_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
    const server = http.createServer(async (req, res) => {
        var _a, e_1, _b, _c;
        for (const [k, v] of Object.entries(SEC_HEADERS))
            res.setHeader(k, v);
        if (isHttps(req))
            res.setHeader('Strict-Transport-Security', 'max-age=15552000');
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/app.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
            return res.end(appBundle());
        }
        if (!url.pathname.startsWith('/api/')) {
            let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
            if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory())
                f = path.join(PUB, 'index.html');
            res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            return fs.createReadStream(f).pipe(res);
        }
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
        try {
            // reject cross-site writes: the app always sends this header
            const isHook = url.pathname.startsWith('/api/hooks/'); // webhooks from Cequens, Meta, Google forms, couriers: no browser header, raw body kept for signatures
            if (req.method !== 'GET' && !isHook && req.headers['x-sb'] !== '1')
                throw new HttpError(403, 'Bad request origin');
            const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
            if (!r)
                throw new HttpError(404, 'Not found');
            const m = r.re.exec(url.pathname), params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
            const u = A.fromRequest(req);
            if (r.perm) {
                if (!u)
                    throw new HttpError(401, 'Please log in');
                if (!can(u, r.perm))
                    throw new HttpError(403, 'Your account does not have access to this');
            }
            let body = {};
            if (req.method !== 'GET') {
                const chunks = [];
                try {
                    for (var _d = true, req_1 = __asyncValues(req), req_1_1; req_1_1 = await req_1.next(), _a = req_1_1.done, !_a; _d = true) {
                        _c = req_1_1.value;
                        _d = false;
                        const c = _c;
                        chunks.push(c);
                        if (chunks.reduce((s, x) => s + x.length, 0) > 5e6)
                            throw new HttpError(413, 'Too large');
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (!_d && !_a && (_b = req_1.return)) await _b.call(req_1);
                    }
                    finally { if (e_1) throw e_1.error; }
                }
                const t = Buffer.concat(chunks).toString();
                req.rawBody = t;
                if (isHook) {
                    try {
                        body = t ? JSON.parse(t) : {};
                    }
                    catch (_e) {
                        body = /application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '') ? Object.fromEntries(new URLSearchParams(t)) : { _raw: t };
                    }
                }
                else
                    body = t ? JSON.parse(t) : {};
            }
            const out = await r.fn(req, u, body, res, params, Object.fromEntries(url.searchParams));
            if (out !== undefined && !res.headersSent)
                send(200, out);
        }
        catch (e) {
            const code = e.code && typeof e.code === 'number' ? e.code : 500;
            if (code === 500)
                console.error(e);
            if (!res.headersSent)
                send(code, { error: e.message || 'Error' });
        }
    });
    function lanUrls() { return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`); }
    if (require.main === module) {
        let tries = 0;
        server.on('error', e => {
            if (e.code === 'EADDRINUSE' && tries < 10 && !process.env.PORT) {
                tries++;
                PORT++;
                return server.listen(PORT, process.env.HOST || '0.0.0.0');
            }
            if (e.code === 'EADDRINUSE')
                console.log('\n  The ERP is probably already running in another window. Close the other window, or open http://localhost:' + (PORT - tries) + '\n');
            else
                console.log('\n  Could not start: ' + e.message + '\n');
            process.exit(1);
        });
        server.on('listening', () => {
            console.log('\n  SundayBazar ERP is running');
            console.log(`  On this computer:   http://localhost:${PORT}`);
            for (const u of lanUrls())
                console.log(`  Staff on office WiFi: ${u}`);
            console.log('\n  Keep this window open. Close it to stop the ERP.');
            console.log('  Ye window khuli rakhein. Band karne se ERP band ho jayega.\n');
            if (process.env.SB_OPEN === '1') {
                const url = `http://localhost:${PORT}`, cp = require('child_process');
                if (process.platform === 'win32')
                    cp.exec(`start "" ${url}`);
                else if (process.platform === 'darwin')
                    cp.exec(`open ${url}`);
                else
                    cp.exec(`xdg-open ${url}`, () => { });
            }
            if (S.configured() && !setting('demo'))
                setTimeout(() => runSync('all'), 3000);
        });
        server.listen(PORT, process.env.HOST || '0.0.0.0');
    }
    module.exports = { server, runSync };
};