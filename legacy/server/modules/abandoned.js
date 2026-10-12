    // abandoned module — Shopify abandoned checkouts: customers who started checkout but did not order.
    // Data comes from the Shopify webhooks checkouts/create + checkouts/update (and orders/create for exact matching)
    // at /api/hooks/shopify/checkouts, plus a sync every 30 min (REST checkouts.json). Staff (role social) WhatsApp / call them;
    // when an order arrives with the same checkout token, or the same phone / email within 7 days, the cart is marked Recovered
    // and credited to the person who last contacted it.
    'use strict';
    const crypto = require('crypto');
    const MIN_AGE = 30; // minutes: Shopify itself treats a checkout as abandoned after a while; don't chase people still paying
    const MATCH_DAYS = 7;
    const OUTCOMES = { will_order: 'Will order', no_answer: 'No answer', not_interested: 'Not interested', wrong_number: 'Wrong number' };
    const LOST_REASONS = ['Not interested', 'Wrong number', 'No answer after 3 tries', 'Ordered on another number', 'Item sold out', 'Price too high', 'Other'];
    const DEF_MSG = 'Assalam o Alaikum {name}! SundayBazar se baat kar rahi hoon. Aap ne {items} cart mein chhor diya tha. Pair abhi available hai, order sirf ek click door hai: {link}\nKoi sawal ho (size, delivery, COD) to isi number par message karein. Shukriya!';
    const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const toUtc = v => { if (!v)
        return null; const d = new Date(String(v).includes('T') || /Z|[+-]\d\d:?\d\d$/.test(String(v)) ? v : String(v).replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d.toISOString().replace('T', ' ').slice(0, 19); };
    const ms = v => { const s = toUtc(v); return s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN; };
    const J = (s, d) => { try {
        return s == null ? d : JSON.parse(s);
    }
    catch (_a) {
        return d;
    } };
    const schema = `
CREATE TABLE IF NOT EXISTS ab_checkouts(id TEXT PRIMARY KEY, token TEXT, cart_token TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT,
  name TEXT, phone TEXT, email TEXT, city TEXT, items TEXT, total REAL DEFAULT 0, url TEXT, status TEXT DEFAULT 'new',
  contacted_by INTEGER, contacted_at TEXT, contacts INTEGER DEFAULT 0, last_outcome TEXT, note TEXT,
  recovered_order TEXT, recovered_name TEXT, recovered_value REAL, recovered_at TEXT, recovered_by INTEGER, recovered_how TEXT,
  lost_reason TEXT, lost_at TEXT, lost_by INTEGER, src TEXT, ingested_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_ab_status ON ab_checkouts(status, updated_at);
CREATE INDEX IF NOT EXISTS ix_ab_token ON ab_checkouts(token);
CREATE INDEX IF NOT EXISTS ix_ab_phone ON ab_checkouts(phone);
CREATE TABLE IF NOT EXISTS ab_events(id INTEGER PRIMARY KEY, checkout_id TEXT, user_id INTEGER, kind TEXT, outcome TEXT, note TEXT, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_ab_ev ON ab_events(checkout_id);
CREATE TABLE IF NOT EXISTS ab_orders(id TEXT PRIMARY KEY, name TEXT, checkout_token TEXT, cart_token TEXT, phone TEXT, email TEXT, total REAL, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_ab_orders_tok ON ab_orders(checkout_token);
`;
    module.exports = {
        name: 'abandoned',
        perms: [], // 'abandoned' is defined in lib/auth.js
        schema,
        activity: {
            'abandoned.contact': 'Abandoned carts contacted', 'abandoned.note': 'Abandoned cart note', 'abandoned.lost': 'Marked abandoned cart lost',
            'abandoned.reopen': 'Reopened abandoned cart', 'abandoned.sync': 'Synced abandoned checkouts', 'abandoned.settings': 'Changed abandoned cart settings',
        },
        routes(ctx) {
            const { route, q, need, can, log, setting, setSetting, S, L } = ctx;
            const cfg = () => (Object.assign({ waTemplate: '', waMessage: DEF_MSG, webhookSecret: '' }, (setting('abandoned.cfg', {}) || {})));
            const ageCut = () => new Date(Date.now() - MIN_AGE * 60e3).toISOString().replace('T', ' ').slice(0, 19);
            const userName = id => id ? ((q.get('SELECT name FROM users WHERE id=?', id) || {}).name || '#' + id) : null;
            /* ---------- ingest one Shopify checkout (webhook or REST sync) ---------- */
            function itemsOf(co) {
                return (co.line_items || []).slice(0, 20).map(i => {
                    const sku = String(i.sku || '').trim(), p = sku ? q.get('SELECT title,size,image FROM products WHERE sku=? LIMIT 1', sku) : null;
                    const vt = String(i.variant_title || '').split('/')[0].trim();
                    return { title: i.title || i.presentment_title || (p && p.title) || sku || 'Item', sku, size: (p && p.size) || vt || '', price: +i.price || 0, qty: +i.quantity || 1,
                        image: i.image_url || (i.image && (i.image.src || i.image)) || (p && p.image) || null };
                });
            }
            function ingest(co, src) {
                if (!co || co.id == null)
                    return null;
                const id = String(co.id), a = co.shipping_address || co.billing_address || {}, cu = co.customer || {};
                const name = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || [cu.first_name, cu.last_name].filter(Boolean).join(' ') || '';
                const phone = L.normPhone(co.phone || a.phone || cu.phone || (co.sms_marketing_phone) || '') || null;
                const v = { token: co.token || null, cart_token: co.cart_token || null, created_at: toUtc(co.created_at) || utcNow(), updated_at: toUtc(co.updated_at) || toUtc(co.created_at) || utcNow(),
                    completed_at: toUtc(co.completed_at), name, phone: phone && phone.length >= 10 ? phone : null, email: String(co.email || cu.email || '').trim().toLowerCase() || null, city: a.city || '',
                    items: JSON.stringify(itemsOf(co)), total: +(co.total_price || co.subtotal_price || 0), url: co.abandoned_checkout_url || null };
                const old = q.get('SELECT * FROM ab_checkouts WHERE id=?', id), ks = Object.keys(v);
                if (old)
                    q.run(`UPDATE ab_checkouts SET ${ks.map(k => k + '=?').join(',')} WHERE id=?`, ...ks.map(k => v[k]), id);
                else
                    q.run(`INSERT INTO ab_checkouts(id,${ks.join(',')},src) VALUES(?,${ks.map(() => '?').join(',')},?)`, id, ...ks.map(k => v[k]), src || 'hook');
                if (v.completed_at) {
                    const c = q.get('SELECT * FROM ab_checkouts WHERE id=?', id);
                    if (['new', 'contacted'].includes(c.status))
                        markDone(c, null, 'Checkout completed in Shopify');
                }
                return id;
            }
            /* ---------- recovered: an order came from this cart ---------- */
            function markDone(c, o, how) {
                const by = c.contacted_by || null, at = (o && toUtc(o.created_at)) || c.completed_at || utcNow();
                // nobody chased it → the customer finished on their own (kept out of the tabs, not credited)
                q.run(`UPDATE ab_checkouts SET status=?, recovered_order=?, recovered_name=?, recovered_value=?, recovered_at=?, recovered_by=?, recovered_how=? WHERE id=?`, by ? 'recovered' : 'completed', o ? String(o.id) : null, o ? o.name || null : null, o ? +o.total || c.total : c.total, at, by, how, c.id);
                q.run('INSERT INTO ab_events(checkout_id,user_id,kind,note) VALUES(?,?,?,?)', c.id, by, by ? 'recovered' : 'completed', (o && o.name ? o.name + ' · ' : '') + how);
            }
            function matchOrders() {
                const open = q.all("SELECT * FROM ab_checkouts WHERE status IN ('new','contacted')");
                let n = 0;
                for (const c of open) {
                    let o = null, how = '';
                    if (c.token) {
                        o = q.get('SELECT * FROM ab_orders WHERE checkout_token=? LIMIT 1', c.token);
                        how = 'Same checkout';
                    }
                    if (!o && c.cart_token) {
                        o = q.get('SELECT * FROM ab_orders WHERE cart_token=? LIMIT 1', c.cart_token);
                        how = 'Same cart';
                    }
                    if (!o && (c.phone || c.email)) {
                        const t0 = ms(c.created_at) - 10 * 60e3, t1 = ms(c.created_at) + MATCH_DAYS * 864e5;
                        const cand = [];
                        if (c.phone)
                            cand.push(...q.all('SELECT id,name,total,created_at FROM orders WHERE phone=? AND cancelled_at IS NULL', c.phone).map(x => (Object.assign(Object.assign({}, x), { how: 'Same phone' }))));
                        cand.push(...q.all('SELECT id,name,total,created_at FROM ab_orders WHERE (phone=? AND phone IS NOT NULL) OR (email=? AND email IS NOT NULL)', c.phone || '', c.email || '').map(x => (Object.assign(Object.assign({}, x), { how: c.email ? 'Same phone / email' : 'Same phone' }))));
                        const hit = cand.filter(x => { const t = ms(x.created_at); return t >= t0 && t <= t1; }).sort((x, y) => ms(x.created_at) - ms(y.created_at))[0];
                        if (hit) {
                            o = hit;
                            how = hit.how + ' within ' + MATCH_DAYS + ' days';
                        }
                    }
                    if (o) {
                        if (!o.total) {
                            const ord = q.get('SELECT name,total FROM orders WHERE id=?', o.id);
                            if (ord)
                                Object.assign(o, { name: o.name || ord.name, total: ord.total });
                        }
                        markDone(c, o, how);
                        n++;
                    }
                }
                return n;
            }
            function rememberOrder(o) {
                if (!o || o.id == null)
                    return;
                const id = o.admin_graphql_api_id || 'gid://shopify/Order/' + o.id, a = o.shipping_address || o.billing_address || {}, cu = o.customer || {};
                q.run(`INSERT INTO ab_orders(id,name,checkout_token,cart_token,phone,email,total,created_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET checkout_token=excluded.checkout_token, cart_token=excluded.cart_token, phone=excluded.phone, email=excluded.email, total=excluded.total`, id, o.name || null, o.checkout_token || null, o.cart_token || null, L.normPhone(o.phone || a.phone || cu.phone || '') || null, String(o.email || cu.email || '').toLowerCase() || null, +(o.total_price || 0), toUtc(o.created_at) || utcNow());
            }
            /* ---------- practice data (demo mode): a few carts so the screen is not empty ---------- */
            let demoState = null;
            function demoSync() {
                const demo = !!setting('demo');
                if (demo === demoState)
                    return;
                demoState = demo;
                if (!demo) {
                    q.run("DELETE FROM ab_events WHERE checkout_id LIKE 'demo-%'");
                    q.run("DELETE FROM ab_checkouts WHERE id LIKE 'demo-%'");
                    return;
                }
                if (q.get("SELECT 1 FROM ab_checkouts WHERE id LIKE 'demo-%' LIMIT 1"))
                    return;
                const prods = q.all("SELECT sku,title,size,price,image,qty FROM products WHERE variant_id LIKE 'demo%' AND qty>0 ORDER BY variant_id LIMIT 20");
                const sold = q.get("SELECT sku,title,size,price FROM products WHERE variant_id LIKE 'demo%' AND COALESCE(qty,0)<=0 LIMIT 1");
                if (!prods.length)
                    return;
                const names = ['Ayesha Khan', 'Bilal Ahmed', 'Hira Siddiqui', 'Usman Tariq', 'Mahnoor Ali', 'Fahad Iqbal', 'Sana Javed', 'Hamza Raza', 'Zainab Noor', 'Ali Haider', 'Areeba Shah', 'Saad Malik'];
                const cities = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Hyderabad', 'Peshawar'];
                const plan = [[0.6, 'new'], [0.9, 'new'], [2, 'new'], [3.5, 'new'], [5, 'new'], [9, 'new'], [26, 'new'], [0.2, 'new'], [6, 'contacted', 'no_answer'], [20, 'contacted', 'will_order'], [30, 'recovered'], [52, 'recovered'], [40, 'lost']];
                const owner = q.get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
                plan.forEach(([hrs, st, oc], i) => {
                    const its = [prods[i % prods.length]];
                    if (i % 3 === 1)
                        its.push(prods[(i + 5) % prods.length]);
                    if (i === 2 && sold)
                        its.unshift(sold);
                    const at = new Date(Date.now() - hrs * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
                    const items = its.map(p => ({ title: p.title, sku: p.sku, size: p.size || '', price: +p.price || 0, qty: 1, image: p.image || null }));
                    const total = items.reduce((s, x) => s + x.price, 0) + 199, id = 'demo-' + (i + 1);
                    q.run(`INSERT OR IGNORE INTO ab_checkouts(id,token,created_at,updated_at,name,phone,email,city,items,total,url,status,src) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, 'demotok' + (i + 1), at, at, names[i % names.length], '0399' + String(1000000 + i * 73517).slice(-7), names[i % names.length].split(' ')[0].toLowerCase() + '@example.com', cities[i % cities.length], JSON.stringify(items), total, 'https://sundaybazar.pk/checkouts/demo' + (i + 1) + '/recover', 'new', 'demo');
                    const by = owner ? owner.id : null, cAt = new Date(Date.now() - (hrs - 0.3) * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
                    if (st === 'contacted')
                        q.run('UPDATE ab_checkouts SET status=?, contacted_by=?, contacted_at=?, contacts=1, last_outcome=? WHERE id=?', 'contacted', by, cAt, oc, id);
                    if (st === 'recovered')
                        q.run(`UPDATE ab_checkouts SET status='recovered', contacted_by=?, contacted_at=?, contacts=1, last_outcome='will_order', recovered_value=?, recovered_at=?, recovered_by=?, recovered_how='Same phone within 7 days', recovered_name=? WHERE id=?`, by, cAt, total, cAt, by, 'SB' + (84000 + i), id);
                    if (st === 'lost')
                        q.run(`UPDATE ab_checkouts SET status='lost', contacted_by=?, contacted_at=?, contacts=2, last_outcome='not_interested', lost_reason='Not interested', lost_at=?, lost_by=? WHERE id=?`, by, cAt, cAt, by, id);
                });
            }
            /* ---------- Shopify REST sync (every 30 min + "Sync now") ---------- */
            async function syncNow() {
                need(S.configured(), 'Shopify is not connected (Settings → Shopify)');
                const c = S.cfg(), base = process.env.SB_SHOPIFY_BASE || 'https://' + c.shop;
                const since = setting('abandoned.sync_at', null) || new Date(Date.now() - 7 * 864e5).toISOString();
                const min = new Date(Date.parse(since) - 3600e3).toISOString();
                let url = `${base}/admin/api/2024-10/checkouts.json?status=open&limit=250&updated_at_min=${encodeURIComponent(min)}`, n = 0, newest = since;
                for (let page = 0; url && page < 20; page++) {
                    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': await S.getToken(), Accept: 'application/json' } });
                    if (!r.ok) {
                        const t = await r.text().catch(() => '');
                        throw new Error('Shopify checkouts: ' + r.status + (r.status === 403 ? ' (the app needs the read_orders scope)' : '') + ' ' + t.slice(0, 120));
                    }
                    const j = await r.json();
                    for (const co of j.checkouts || []) {
                        ingest(co, 'sync');
                        n++;
                        if (co.updated_at && Date.parse(co.updated_at) > Date.parse(newest))
                            newest = new Date(Date.parse(co.updated_at)).toISOString();
                    }
                    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '');
                    url = m ? m[1] : null;
                }
                setSetting('abandoned.sync_at', newest);
                setSetting('abandoned.last_sync', { at: utcNow(), n, ok: true });
                const rec = matchOrders();
                return { fetched: n, recovered: rec };
            }
            function expireOld() { q.run("UPDATE ab_checkouts SET status='lost', lost_reason='Expired (no contact in 14 days)', lost_at=datetime('now') WHERE status='new' AND updated_at < datetime('now','-14 days')"); }
            ctx._abJob = async () => {
                demoSync();
                expireOld();
                if (S.configured() && !setting('demo')) {
                    try {
                        await syncNow();
                    }
                    catch (e) {
                        setSetting('abandoned.last_sync', { at: utcNow(), ok: false, error: e.message });
                        ctx.syncLog && ctx.syncLog('abandoned', false, e.message);
                    }
                }
                else
                    matchOrders();
            };
            ctx._abDemo = demoSync;
            /* ---------- webhook ---------- */
            route('POST', '/api/hooks/shopify/checkouts', null, (req, u, b, res) => {
                const secret = cfg().webhookSecret || S.cfg().clientSecret || '';
                const sent = String(req.headers['x-shopify-hmac-sha256'] || '');
                const want = secret ? crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('base64') : '';
                const okSig = !!want && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
                need(okSig, secret ? 'Bad signature' : 'Webhook secret not set', 401);
                const topic = String(req.headers['x-shopify-topic'] || '');
                if (/^orders\//.test(topic))
                    rememberOrder(b);
                else if (/^checkouts\/(create|update)$/.test(topic) || (!topic && b && b.line_items))
                    ingest(b, 'hook');
                setSetting('abandoned.last_hook', { at: utcNow(), topic });
                matchOrders();
                return { ok: true };
            });
            /* ---------- screen API ---------- */
            const baseUrl = req => (setting('inbox.public_url', '') || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`).replace(/\/+$/, '');
            function soldOut(skus) {
                const out = new Set();
                const list = [...new Set(skus.filter(Boolean))];
                if (!list.length)
                    return out;
                for (const r of q.all(`SELECT sku, SUM(COALESCE(qty,0)) n FROM products WHERE sku IN (${list.map(() => '?').join(',')}) GROUP BY sku`, ...list))
                    if (r.n <= 0)
                        out.add(r.sku);
                return out;
            }
            function shape(r, u, so) {
                const items = J(r.items, []);
                for (const it of items)
                    it.soldOut = so.has(it.sku);
                return Object.assign(Object.assign({}, r), { phone: ctx.maskPhone(u, r.phone), wa: r.phone ? L.waNumber(r.phone) : null, items, allSoldOut: items.length > 0 && items.every(i => i.soldOut), anySoldOut: items.some(i => i.soldOut), contacted_name: userName(r.contacted_by), recovered_name_by: userName(r.recovered_by), lost_by_name: userName(r.lost_by), outcome_label: OUTCOMES[r.last_outcome] || null });
            }
            const TABS = { new: "status='new'", contacted: "status='contacted'", recovered: "status='recovered'", lost: "status='lost'" };
            function tabCounts() {
                const cut = ageCut();
                const r = q.get(`SELECT SUM(status='new' AND updated_at<=?) new, SUM(status='contacted') contacted, SUM(status='recovered') recovered, SUM(status='lost') lost FROM ab_checkouts`, cut);
                for (const k in r)
                    r[k] = r[k] || 0;
                return r;
            }
            route('GET', '/api/abandoned', 'abandoned', (req, u, b, res, p, qs) => {
                demoSync();
                matchOrders();
                const tab = TABS[qs.tab] ? qs.tab : 'new', w = [TABS[tab]], a = [];
                if (tab === 'new') {
                    w.push('updated_at<=?');
                    a.push(ageCut());
                }
                if (qs.q) {
                    const t = '%' + String(qs.q).trim() + '%', ph = L.normPhone(qs.q);
                    w.push(`(name LIKE ? OR email LIKE ? OR items LIKE ? OR city LIKE ?${ph.length >= 6 ? ' OR phone LIKE ?' : ''})`);
                    a.push(t, t, t, t);
                    if (ph.length >= 6)
                        a.push('%' + ph + '%');
                }
                const order = tab === 'new' ? 'updated_at ASC' : tab === 'contacted' ? 'contacted_at DESC' : tab === 'recovered' ? 'recovered_at DESC' : 'COALESCE(lost_at,updated_at) DESC';
                const rows = q.all(`SELECT * FROM ab_checkouts WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT 200`, ...a);
                const so = soldOut(rows.flatMap(r => J(r.items, []).map(i => i.sku)));
                const month = ctx.pkToday().slice(0, 7), today = ctx.pkToday();
                const rec = q.get(`SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND substr(datetime(recovered_at,'+5 hours'),1,7)=?`, month);
                const mine = q.get(`SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND recovered_by=? AND substr(datetime(recovered_at,'+5 hours'),1,7)=?`, u.id, month);
                const chased = q.get(`SELECT COUNT(*) n FROM ab_checkouts WHERE contacted_by IS NOT NULL AND substr(datetime(contacted_at,'+5 hours'),1,7)=?`, month).n;
                const myToday = q.get(`SELECT COUNT(*) n FROM events WHERE user_id=? AND action='abandoned.contact' AND date(at,'+5 hours')=?`, u.id, today).n;
                const late = q.get(`SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=datetime('now','-3 hours')`).n;
                const c = cfg(), wa = !!(ctx.services.inbox && ctx.services.inbox.waReady && ctx.services.inbox.waReady());
                return { tab, rows: rows.map(r => shape(r, u, so)), counts: tabCounts(),
                    stats: { recoveredMonth: rec.n, recoveredValue: rec.v, mineMonth: mine.n, mineValue: mine.v, chasedMonth: chased, myToday, late },
                    setup: { shopify: S.configured(), demo: !!setting('demo'), lastSync: setting('abandoned.last_sync', null), lastHook: setting('abandoned.last_hook', null), cequens: wa, waTemplate: c.waTemplate,
                        canSetup: can(u, 'settings') || can(u, 'inbox_admin'), hookUrl: baseUrl(req) + '/api/hooks/shopify/checkouts' },
                    outcomes: OUTCOMES, lostReasons: LOST_REASONS };
            });
            const getC = id => { const c = q.get('SELECT * FROM ab_checkouts WHERE id=?', String(id)); need(c, 'Cart not found', 404); return c; };
            route('GET', '/api/abandoned/c/:id', 'abandoned', (req, u, b, res, p) => {
                const c = getC(p.id), so = soldOut(J(c.items, []).map(i => i.sku));
                const ev = q.all('SELECT e.*, us.name user FROM ab_events e LEFT JOIN users us ON us.id=e.user_id WHERE e.checkout_id=? ORDER BY e.id DESC LIMIT 50', c.id);
                return { cart: shape(c, u, so), events: ev.map(e => (Object.assign(Object.assign({}, e), { outcome_label: OUTCOMES[e.outcome] || null }))) };
            });
            function touch(c, u, via, outcome, note) {
                q.run(`UPDATE ab_checkouts SET status=CASE WHEN status IN ('new','contacted') THEN 'contacted' ELSE status END, contacted_by=?, contacted_at=datetime('now'), contacts=contacts+1, last_outcome=COALESCE(?,last_outcome) WHERE id=?`, u.id, outcome || null, c.id);
                q.run('INSERT INTO ab_events(checkout_id,user_id,kind,outcome,note) VALUES(?,?,?,?,?)', c.id, u.id, via, outcome || null, note || null);
                log(u.id, 'abandoned.contact', 'abandoned:' + c.id, { via, outcome: outcome || undefined, name: c.name });
            }
            function message(c) {
                const items = J(c.items, []).map(i => i.title + (i.size ? ' (size ' + i.size + ')' : '')).join(', ') || 'apna pair';
                const first = String(c.name || '').trim().split(/\s+/)[0] || 'Sir/Madam';
                return String(cfg().waMessage || DEF_MSG).replace(/\{name\}/g, first).replace(/\{items\}/g, items).replace(/\{link\}/g, c.url || '').replace(/\{total\}/g, 'Rs ' + Math.round(c.total || 0).toLocaleString('en-PK'));
            }
            route('POST', '/api/abandoned/c/:id/whatsapp', 'abandoned', async (req, u, b, res, p) => {
                const c = getC(p.id);
                need(c.phone, 'This cart has no phone number');
                need(['new', 'contacted'].includes(c.status), 'This cart is already closed');
                const s = cfg(), inbox = ctx.services.inbox;
                if (s.waTemplate && inbox && inbox.waReady && inbox.waReady() && !String(c.id).startsWith('demo-')) {
                    const first = String(c.name || '').trim().split(/\s+/)[0] || 'Customer';
                    const items = J(c.items, []).map(i => i.title).join(', ').slice(0, 200);
                    await inbox.sendWhatsApp(c.phone, { template: s.waTemplate, params: [first, items, c.url || ''] }, u.id);
                    touch(c, u, 'whatsapp', null, 'Template ' + s.waTemplate + ' sent');
                    return { sent: true };
                }
                touch(c, u, 'whatsapp', null, 'WhatsApp opened (wa.me)');
                return { link: 'https://wa.me/' + L.waNumber(c.phone) + '?text=' + encodeURIComponent(message(c)), text: message(c) };
            });
            route('POST', '/api/abandoned/c/:id/call', 'abandoned', (req, u, b, res, p) => {
                const c = getC(p.id);
                need(OUTCOMES[b.outcome], 'Choose what the customer said');
                need(['new', 'contacted'].includes(c.status), 'This cart is already closed');
                touch(c, u, 'call', b.outcome, b.note ? String(b.note).slice(0, 500) : null);
                if (b.note)
                    q.run('UPDATE ab_checkouts SET note=? WHERE id=?', String(b.note).slice(0, 500), c.id);
                let lost = false;
                if (b.outcome === 'not_interested' || b.outcome === 'wrong_number') {
                    q.run("UPDATE ab_checkouts SET status='lost', lost_reason=?, lost_at=datetime('now'), lost_by=? WHERE id=?", OUTCOMES[b.outcome], u.id, c.id);
                    lost = true;
                }
                return { ok: true, lost };
            });
            route('POST', '/api/abandoned/c/:id/note', 'abandoned', (req, u, b, res, p) => {
                const c = getC(p.id), note = String(b.note || '').trim().slice(0, 500);
                need(note, 'Write a note');
                q.run('UPDATE ab_checkouts SET note=? WHERE id=?', note, c.id);
                q.run('INSERT INTO ab_events(checkout_id,user_id,kind,note) VALUES(?,?,?,?)', c.id, u.id, 'note', note);
                log(u.id, 'abandoned.note', 'abandoned:' + c.id, note.slice(0, 80));
                return { ok: true };
            });
            route('POST', '/api/abandoned/c/:id/lost', 'abandoned', (req, u, b, res, p) => {
                const c = getC(p.id);
                need(['new', 'contacted'].includes(c.status), 'This cart is already closed');
                const reason = String(b.reason || 'Other').slice(0, 120);
                q.run("UPDATE ab_checkouts SET status='lost', lost_reason=?, lost_at=datetime('now'), lost_by=? WHERE id=?", reason, u.id, c.id);
                q.run('INSERT INTO ab_events(checkout_id,user_id,kind,note) VALUES(?,?,?,?)', c.id, u.id, 'lost', reason);
                log(u.id, 'abandoned.lost', 'abandoned:' + c.id, reason);
                return { ok: true };
            });
            route('POST', '/api/abandoned/c/:id/reopen', 'abandoned', (req, u, b, res, p) => {
                const c = getC(p.id);
                need(c.status === 'lost', 'Only lost carts can be reopened');
                q.run("UPDATE ab_checkouts SET status=CASE WHEN contacted_by IS NULL THEN 'new' ELSE 'contacted' END, lost_reason=NULL, lost_at=NULL, lost_by=NULL WHERE id=?", c.id);
                q.run('INSERT INTO ab_events(checkout_id,user_id,kind) VALUES(?,?,?)', c.id, u.id, 'reopen');
                log(u.id, 'abandoned.reopen', 'abandoned:' + c.id, '');
                return { ok: true };
            });
            route('POST', '/api/abandoned/sync', 'abandoned', async (req, u) => {
                if (setting('demo')) {
                    demoSync();
                    return { fetched: 0, recovered: matchOrders(), demo: true };
                }
                try {
                    const r = await syncNow();
                    log(u.id, 'abandoned.sync', 'abandoned', r);
                    return r;
                }
                catch (e) {
                    setSetting('abandoned.last_sync', { at: utcNow(), ok: false, error: e.message });
                    throw e;
                }
            });
            route('GET', '/api/abandoned/settings', 'abandoned', () => { const c = cfg(); return { waTemplate: c.waTemplate, waMessage: c.waMessage, hasSecret: !!c.webhookSecret, defaultMessage: DEF_MSG }; });
            route('POST', '/api/abandoned/settings', 'abandoned', (req, u, b) => {
                need(can(u, 'settings') || can(u, 'inbox_admin'), 'Only the owner can change this', 403);
                const c = cfg();
                if (b.waTemplate !== undefined)
                    c.waTemplate = String(b.waTemplate || '').trim().slice(0, 80);
                if (b.waMessage !== undefined)
                    c.waMessage = String(b.waMessage || '').trim().slice(0, 1000) || DEF_MSG;
                if (b.webhookSecret)
                    c.webhookSecret = String(b.webhookSecret).trim();
                if (b.clearSecret)
                    c.webhookSecret = '';
                setSetting('abandoned.cfg', c);
                log(u.id, 'abandoned.settings', 'settings', { waTemplate: c.waTemplate });
                return { ok: true };
            });
            ctx.services.abandoned = {
                ingest: (co, src) => ingest(co, src), matchOrders,
                // recovered carts credited to a user between PK days [from, to]
                recoveredBy(userId, from, to) {
                    const r = q.get(`SELECT COUNT(*) n, COALESCE(SUM(recovered_value),0) v FROM ab_checkouts WHERE status='recovered' AND recovered_by=? AND date(recovered_at,'+5 hours')>=? AND date(recovered_at,'+5 hours')<=?`, userId, from, to);
                    return { n: r.n || 0, value: r.v || 0 };
                },
                summary() { const c = tabCounts(); return { new: c.new, contacted: c.contacted, recoveredMonth: q.get(`SELECT COUNT(*) n FROM ab_checkouts WHERE status='recovered' AND substr(datetime(recovered_at,'+5 hours'),1,7)=?`, ctx.pkToday().slice(0, 7)).n }; },
            };
        },
        jobs: [{ name: 'abandoned-sync', every: 30, offset: 11, run: async (ctx) => { if (ctx._abJob)
                    await ctx._abJob(); } }],
        counts(u, ctx) {
            if (!ctx.can(u, 'abandoned'))
                return {};
            if (ctx._abDemo)
                ctx._abDemo();
            const cut = new Date(Date.now() - MIN_AGE * 60e3).toISOString().replace('T', ' ').slice(0, 19);
            return { abandoned: ctx.q.get("SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=?", cut).n };
        },
        alerts(u, ctx) {
            if (!ctx.can(u, 'abandoned'))
                return [];
            const n = ctx.q.get("SELECT COUNT(*) n FROM ab_checkouts WHERE status='new' AND updated_at<=datetime('now','-3 hours')").n;
            return n > 20 ? [{ level: 'warn', text: `${n} abandoned carts not contacted for 3+ hours`, href: '#/abandoned' }] : [];
        },
    };
};