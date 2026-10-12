    // inbox module — one Messages inbox for WhatsApp (CEQUENS), Instagram DMs + comments (Meta Graph API) and Google Form exchange requests,
    // plus automatic WhatsApp messages (order confirmation with YES/NO buttons, dispatched, delivery attempted, delivered, exchange & refund updates).
    'use strict';
    const crypto = require('crypto');
    const J = (s, d) => { try {
        return s ? JSON.parse(s) : d;
    }
    catch (_a) {
        return d;
    } };
    const rnd = n => crypto.randomBytes(n).toString('hex');
    const utc = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const parseUtc = s => Date.parse(String(s).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
    const commas = v => String(Math.round(+v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const CHANNEL_L = { wa: 'WhatsApp', ig: 'Instagram DM', igc: 'Instagram comment', form: 'Google Form' };
    const TICKET_CH = { wa: 'WhatsApp', ig: 'Instagram', igc: 'Instagram', form: 'Google Form' };
    const TICKET_TYPES = ['Size exchange', 'Order inquiry', 'Wrong item', 'Damaged / not as described', 'Return request', 'Refund', 'Delivery issue', 'Complaint about staff', 'Other'];
    const ST_RANK = { pending: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
    const CEQUENS_URL = 'https://apis.cequens.com/conversation/wab/v1/messages';
    // Templates the owner must get approved in the CEQUENS / Meta console. {{n}} = parameter n.
    const DEF_TEMPLATES = [
        { name: 'order_confirmation', lang: 'en', category: 'Utility', params: ['{name}', '{order}', '{items}', '{total}'], buttons: ['Yes, confirm', 'No, cancel'],
            text: 'Assalam o Alaikum {{1}}! SundayBazar se aap ka order {{2}} mila hai: {{3}}. Total Rs {{4}} (cash on delivery). Kya hum ye order bhej dein? Neeche button dabayein.' },
        { name: 'order_dispatched', lang: 'en', category: 'Utility', params: ['{name}', '{order}', '{courier}', '{tracking}'],
            text: '{{1}}, aap ka SundayBazar order {{2}} {{3}} ke zariye bhej diya gaya hai. Tracking number: {{4}}. Rider call kare to please receive kar lijiye ga.' },
        { name: 'delivery_attempted', lang: 'en', category: 'Utility', params: ['{name}', '{order}', '{courier}', '{tracking}'],
            text: '{{1}}, {{3}} rider aap ka order {{2}} deliver karne aaya tha lekin aap se rabta nahi ho saka (tracking {{4}}). Kya hum dobara bhejwa dein? Please reply karein.' },
        { name: 'order_delivered', lang: 'en', category: 'Utility', params: ['{name}', '{order}'],
            text: 'Shukriya {{1}}! Aap ka order {{2}} deliver ho gaya hai. Shoes kaise lage? Apna review zaroor share karein.' },
        { name: 'exchange_update', lang: 'en', category: 'Utility', params: ['{name}', '{order}', '{step}'],
            text: '{{1}}, aap ke order {{2}} ke exchange ka status: {{3}}. Koi sawal ho to isi number par message karein.' },
        { name: 'refund_paid', lang: 'en', category: 'Utility', params: ['{name}', '{order}', '{amount}'],
            text: '{{1}}, order {{2}} ka refund Rs {{3}} bhej diya gaya hai. Please check kar ke confirm kar dein.' },
        { name: 'exchange_request_received', lang: 'en', category: 'Utility', params: ['{name}', '{order}'],
            text: '{{1}}, aap ki exchange request (order {{2}}) humein mil gayi hai. Hamari team jald aap se rabta karegi.' },
        { name: 'customer_care_followup', lang: 'en', category: 'Utility', params: ['{name}'],
            text: 'Assalam o Alaikum {{1}}! SundayBazar customer care. Aap ke message ka jawab dene ke liye please is message ka reply karein.' },
    ];
    const DEF_QUICK = [
        { title: 'Greeting', body: 'Assalam o Alaikum {name}! SundayBazar customer care. Main aap ki kya madad kar sakti hoon?' },
        { title: 'Order status', body: '{name}, aap ka order {order} raste mein hai. Tracking: {tracking}. Rider call kare to please receive kar lijiye ga.' },
        { title: 'Ask order number', body: 'Please apna order number (jaise SB84561) ya order wala phone number bhej dein.' },
        { title: 'Exchange form', body: 'Size exchange ke liye please ye form fill kar dein, hamari team 24 ghante mein rabta karegi.' },
        { title: 'Thank you', body: 'Shukriya {name}! Koi aur sawal ho to zaroor batayein.' },
    ];
    const RULES = {
        confirm: { label: 'Order confirmation (YES / NO buttons)', on: true, template: 'order_confirmation', params: ['{name}', '{order}', '{items}', '{total}'], payloads: true },
        dispatched: { label: 'Dispatched with tracking', on: true, template: 'order_dispatched', params: ['{name}', '{order}', '{courier}', '{tracking}'] },
        attempted: { label: 'Delivery attempted', on: true, template: 'delivery_attempted', params: ['{name}', '{order}', '{courier}', '{tracking}'] },
        delivered: { label: 'Delivered: thank you / review', on: false, template: 'order_delivered', params: ['{name}', '{order}'] },
        exchange: { label: 'Exchange updates', on: true, template: 'exchange_update', params: ['{name}', '{order}', '{step}'] },
        refund: { label: 'Refund paid', on: true, template: 'refund_paid', params: ['{name}', '{order}', '{amount}'] },
    };
    const EX_STEP = { approved: 'Approved - rider purana pair le jayega', dispatched: 'Naya pair bhej diya gaya hai', completed: 'Exchange mukammal ho gaya' };
    const YES = ['yes', 'y', 'yess', 'yes confirm', 'confirm', 'confirmed', 'haan', 'han', 'haa', 'ha', 'hn', 'ji', 'jee', 'g', 'ok', 'okay', 'theek', 'thik', 'sure', 'done', 'ہاں', 'جی', 'ہان'];
    const NO = ['no', 'n', 'nope', 'cancel', 'cancelled', 'nahi', 'nahin', 'nai', 'na', 'nhi', 'mat', 'نہیں', 'نہ', 'nahi chahiye'];
    const FILLER = ['please', 'plz', 'pls', 'sir', 'madam', 'jee', 'ji', 'kar', 'karo', 'karein', 'karen', 'do', 'den', 'dein', 'bhej', 'bhejo', 'bhejein', 'order', 'it', 'the', 'thanks', 'shukriya', 'hai', 'he', 'hy', 'ye'];
    function parseReply(text) {
        const t = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (!t)
            return null;
        if (YES.includes(t))
            return 'confirmed';
        if (NO.includes(t))
            return 'cancelled';
        const words = t.split(' '), hasNo = words.some(w => NO.includes(w)), hasYes = words.some(w => YES.includes(w));
        const core = words.filter(w => !FILLER.includes(w) && !YES.includes(w) && !NO.includes(w));
        if (words.length > 5 || core.length > 1)
            return null;
        if (hasNo)
            return 'cancelled';
        if (hasYes)
            return 'confirmed';
        return null;
    }
    module.exports = {
        name: 'inbox',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS ib_convs(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, ext_id TEXT NOT NULL, phone TEXT, name TEXT, handle TEXT, media_id TEXT,
  status TEXT DEFAULT 'open', assignee INTEGER, unread INTEGER DEFAULT 0, last_at TEXT, last_in_at TEXT, last_text TEXT, last_dir TEXT, ticket_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(channel, ext_id));
CREATE INDEX IF NOT EXISTS ix_ib_convs_last ON ib_convs(last_at);
CREATE INDEX IF NOT EXISTS ix_ib_convs_phone ON ib_convs(phone);
CREATE TABLE IF NOT EXISTS ib_msgs(id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL, dir TEXT NOT NULL, kind TEXT DEFAULT 'text', body TEXT, media TEXT, ext_id TEXT, ctx_id TEXT,
  status TEXT, error TEXT, user_id INTEGER, auto TEXT, order_id TEXT, payload TEXT, bot TEXT, note TEXT, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_ib_msgs_conv ON ib_msgs(conv_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ib_msgs_ext ON ib_msgs(ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ib_hooks(id INTEGER PRIMARY KEY, src TEXT, ok INTEGER, note TEXT, body TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS ib_auto_log(id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, event TEXT NOT NULL, rule TEXT, phone TEXT, status TEXT, msg_id INTEGER, error TEXT,
  created_at TEXT DEFAULT (datetime('now')), at TEXT DEFAULT (datetime('now')), UNIQUE(order_id, event));
CREATE INDEX IF NOT EXISTS ix_ib_auto_status ON ib_auto_log(status);
CREATE TABLE IF NOT EXISTS ib_forms(id INTEGER PRIMARY KEY, key TEXT UNIQUE, form TEXT, submitted_at TEXT, answers TEXT, phone TEXT, order_id TEXT, ticket_id INTEGER, conv_id INTEGER, error TEXT, at TEXT DEFAULT (datetime('now')));
`,
        migrate(ctx) {
            const { setting, setSetting } = ctx;
            const wa = setting('inbox.wa', null) || {};
            if (!wa.key)
                setSetting('inbox.wa', Object.assign(Object.assign({}, wa), { key: rnd(16) }));
            const ig = setting('inbox.ig', null) || {};
            if (!ig.verifyToken)
                setSetting('inbox.ig', Object.assign(Object.assign({}, ig), { verifyToken: 'sb-' + rnd(10) }));
            const fm = setting('inbox.form', null) || {};
            if (!fm.key)
                setSetting('inbox.form', Object.assign(Object.assign({}, fm), { key: rnd(16) }));
        },
        routes(ctx) {
            const { route, q, need, can, log, setting, setSetting, L, S, A, pkNow, pkToday, HttpError } = ctx;
            /* ---------- settings ---------- */
            const waCfg = () => { const c = setting('inbox.wa', {}) || {}; return Object.assign(Object.assign({ bearer: true }, c), { url: c.url || setting('inbox_cequens_url', '') || process.env.INBOX_CEQUENS_URL || CEQUENS_URL }); };
            const igCfg = () => { const c = setting('inbox.ig', {}) || {}; return Object.assign(Object.assign({ version: 'v21.0' }, c), { graphUrl: (c.graphUrl || setting('inbox_graph_url', '') || process.env.INBOX_GRAPH_URL || 'https://graph.instagram.com').replace(/\/+$/, '') }); };
            const formCfg = () => (Object.assign({ map: {}, ack: false, ackTemplate: 'exchange_request_received' }, (setting('inbox.form', {}) || {})));
            const autoCfg = () => {
                const c = setting('inbox.auto', {}) || {}, rules = {};
                for (const [k, d] of Object.entries(RULES))
                    rules[k] = Object.assign(Object.assign(Object.assign(Object.assign({}, d), { lang: 'en' }), ((c.rules || {})[k] || {})), { label: d.label });
                return Object.assign(Object.assign({ on: false, bot: true, quietFrom: 22, quietTo: 9, dailyLimit: 500, maxAgeHours: 48, confirmReply: 'Shukriya {name}! Aap ka order {order} confirm ho gaya hai. Hum jald parcel bhej denge.', cancelReply: 'Theek hai {name}, aap ka order {order} cancel kar diya gaya hai. Kabhi bhi dobara order karein!' }, c), { rules });
            };
            const templates = () => setting('inbox.templates', null) || DEF_TEMPLATES;
            const quick = () => setting('inbox.quick', null) || DEF_QUICK;
            const waReady = () => !!waCfg().token;
            const igReady = () => !!igCfg().token;
            const isAdmin = u => can(u, 'inbox_admin');
            const scopeOf = u => module.exports.chanScope(u, can);
            /* ---------- conversations & messages ---------- */
            function getConv(channel, ext, d = {}) {
                let c = q.get('SELECT * FROM ib_convs WHERE channel=? AND ext_id=?', channel, String(ext));
                if (!c) {
                    const r = q.run('INSERT INTO ib_convs(channel,ext_id,phone,name,handle,media_id,status,last_at) VALUES(?,?,?,?,?,?,?,datetime(\'now\'))', channel, String(ext), d.phone || null, d.name || null, d.handle || null, d.media_id || null, d.status || 'open');
                    c = q.get('SELECT * FROM ib_convs WHERE id=?', r.lastInsertRowid);
                    c._new = true;
                }
                else {
                    const set = {};
                    if (d.name && d.name !== c.name)
                        set.name = d.name;
                    if (d.handle && d.handle !== c.handle)
                        set.handle = d.handle;
                    if (d.phone && !c.phone)
                        set.phone = d.phone;
                    const ks = Object.keys(set);
                    if (ks.length) {
                        q.run(`UPDATE ib_convs SET ${ks.map(k => k + '=?').join(',')} WHERE id=?`, ...ks.map(k => set[k]), c.id);
                        Object.assign(c, set);
                    }
                }
                return c;
            }
            function addMsg(convId, m) {
                const at = m.at || utc();
                const r = q.run(`INSERT INTO ib_msgs(conv_id,dir,kind,body,media,ext_id,ctx_id,status,error,user_id,auto,order_id,payload,bot,note,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, convId, m.dir, m.kind || 'text', m.body == null ? '' : String(m.body).slice(0, 5000), m.media || null, m.ext_id || null, m.ctx_id || null, m.status || null, m.error || null, m.user_id || null, m.auto || null, m.order_id || null, m.payload ? JSON.stringify(m.payload) : null, m.bot || null, m.note || null, at);
                const preview = String(m.body || ('[' + (m.kind || 'message') + ']')).slice(0, 160);
                if (m.dir === 'in') {
                    q.run(`UPDATE ib_convs SET last_at=?, last_in_at=?, last_text=?, last_dir='in', unread=unread+?, status=CASE WHEN ? THEN status ELSE 'open' END WHERE id=?`, at, at, preview, m.bot ? 0 : 1, m.bot ? 1 : 0, convId);
                }
                else {
                    q.run(`UPDATE ib_convs SET last_at=?, last_text=?, last_dir='out'${m.user_id ? ', unread=0' : ''} WHERE id=?`, at, preview, convId);
                }
                return Number(r.lastInsertRowid);
            }
            const hookLog = (src, ok, note, body) => {
                q.run('INSERT INTO ib_hooks(src,ok,note,body) VALUES(?,?,?,?)', src, ok ? 1 : 0, note || null, String(body == null ? '' : body).slice(0, 20000));
                q.run('DELETE FROM ib_hooks WHERE id <= (SELECT MAX(id) FROM ib_hooks) - 500');
            };
            const phoneFromText = t => { const m = /(?:\+?92|0)\s?3\d{2}[\s-]?\d{7}/.exec(String(t || '')); return m ? L.normPhone(m[0]) : ''; };
            /* ---------- order data for templates ---------- */
            const orderBy = id => id ? q.get('SELECT * FROM orders WHERE id=?', id) : null;
            function vars(o, extra = {}) {
                const items = o ? q.all('SELECT title, sku FROM order_items WHERE order_id=?', o.id).map(i => i.title || i.sku).join(' + ') : '';
                return Object.assign({ name: ((o && o.cust_name) || extra.cust_name || '').split(' ')[0] || 'Customer', fullname: (o && o.cust_name) || '', order: (o && o.name) || '', total: o ? commas(o.total) : '', items, tracking: (o && o.tracking) || '', courier: (o && o.courier) || 'PostEx', city: (o && o.city) || '' }, extra);
            }
            const fill = (s, v) => String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => v[k] != null && v[k] !== '' ? String(v[k]) : (k in v ? '-' : m));
            const tplText = (name, params) => { const t = templates().find(x => x.name === name); return t ? t.text.replace(/\{\{(\d+)\}\}/g, (m, n) => params[n - 1] != null ? params[n - 1] : m) : `[${name}] ${params.join(' · ')}`; };
            /* ---------- CEQUENS (WhatsApp) ---------- */
            async function cequens(body) {
                const c = waCfg();
                if (!c.token)
                    throw new HttpError(400, 'WhatsApp is not connected. Add the CEQUENS API token in Messages → WhatsApp settings.');
                let r, j = null, t = '';
                try {
                    r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: (c.bearer === false ? '' : 'Bearer ') + c.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
                    t = await r.text();
                    j = J(t, null);
                }
                catch (e) {
                    setSetting('inbox.wa_error', { code: 0, msg: e.message, at: utc() });
                    throw new HttpError(502, 'Could not reach CEQUENS: ' + e.message);
                }
                if (!r.ok) {
                    const detail = j ? (j.message || j.error_description || (j.error && (j.error.message || j.error)) || (j.errors && JSON.stringify(j.errors)) || t) : t;
                    const msg = r.status === 402 ? 'CEQUENS refused: daily safe sending limit exceeded (402). Messages will be retried later.'
                        : r.status === 404 ? 'WhatsApp 24-hour window has closed (CEQUENS 404 invalid/expired session). Send an approved template instead.'
                            : r.status === 401 || r.status === 403 ? `CEQUENS rejected the API token (${r.status}). Check the token and the "Bearer" setting.`
                                : `CEQUENS error ${r.status}: ${String(detail).slice(0, 300)}`;
                    setSetting('inbox.wa_error', { code: r.status, msg, at: utc() });
                    throw new HttpError(r.status === 404 || r.status === 402 ? r.status : 502, msg);
                }
                return { id: j && j.messages && j.messages[0] && j.messages[0].id, status: (j && j.messages && j.messages[0] && j.messages[0].message_status) || 'accepted', raw: j };
            }
            // spec: { text } | { template, params, lang, buttons } | { image, caption }.  Returns ib_msgs id; throws (after recording the failure) on error.
            async function sendWhatsApp(phone, spec, userId, extra = {}) {
                const to = L.waNumber(phone);
                need(/^92\d{10}$/.test(to), 'Not a valid Pakistani mobile number: ' + (phone || '(empty)'));
                const c = extra.conv || getConv('wa', to, { phone: L.normPhone(phone), name: extra.name, status: extra.convStatus });
                let body, kind, shown, payload;
                if (spec.template) {
                    const t = templates().find(x => x.name === spec.template) || {};
                    const params = (spec.params || []).map(x => String(x == null || x === '' ? '-' : x));
                    kind = 'template';
                    shown = tplText(spec.template, params);
                    payload = { template: spec.template, params };
                    body = { type: 'template', recipient_type: 'individual', to, clientReferenceID: '', template: { name: spec.template, language: { policy: 'deterministic', code: spec.lang || t.lang || 'en' }, components: [] } };
                    if (params.length)
                        body.template.components.push({ type: 'body', parameters: params.map(x => ({ type: 'text', text: x.slice(0, 1000) })) });
                    (spec.buttons || []).forEach((b, i) => body.template.components.push(b.type === 'url'
                        ? { type: 'button', sub_type: 'url', index: String(b.index != null ? b.index : i), parameters: [{ type: 'text', text: String(b.text) }] }
                        : { type: 'button', sub_type: 'quick_reply', index: String(b.index != null ? b.index : i), parameters: [{ type: 'payload', payload: String(b.payload) }] }));
                }
                else if (spec.image) {
                    kind = 'image';
                    shown = spec.caption || '';
                    body = { to, type: 'image', recipient_type: 'individual', image: Object.assign({ link: String(spec.image) }, (spec.caption ? { caption: String(spec.caption) } : {})) };
                }
                else {
                    const text = String(spec.text || '').trim();
                    need(text, 'Write a message');
                    kind = 'text';
                    shown = text;
                    body = { to, type: 'text', recipient_type: 'individual', preview_url: false, text: { body: text.slice(0, 4096) } };
                }
                const mid = addMsg(c.id, { dir: 'out', kind, body: shown, media: spec.image || null, status: 'pending', user_id: userId, auto: extra.auto, order_id: extra.order_id, payload, note: extra.note });
                if (body.type === 'template')
                    body.clientReferenceID = 'ib' + mid;
                try {
                    const r = await cequens(body);
                    q.run('UPDATE ib_msgs SET ext_id=?, status=? WHERE id=?', r.id || null, r.status === 'accepted' ? 'accepted' : (ST_RANK[r.status] != null ? r.status : 'accepted'), mid);
                }
                catch (e) {
                    q.run("UPDATE ib_msgs SET status='failed', error=? WHERE id=?", e.message, mid);
                    e.msgId = mid;
                    throw e;
                }
                return mid;
            }
            /* ---------- Meta Graph (Instagram) ---------- */
            async function graph(method, path, body) {
                const c = igCfg();
                if (!c.token)
                    throw new HttpError(400, 'Instagram is not connected. Add the access token in Messages → Instagram settings.');
                const url = `${c.graphUrl}/${c.version}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(c.token)}`;
                let r, j = null;
                try {
                    r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
                    j = J(await r.text(), null);
                }
                catch (e) {
                    throw new HttpError(502, 'Could not reach Meta: ' + e.message);
                }
                if (!r.ok || (j && j.error)) {
                    const er = (j && j.error) || {};
                    const win = er.code === 10 || er.error_subcode === 2534022 || /outside of allowed window|24 hour/i.test(er.message || '');
                    const msg = win ? `Instagram only allows replies within 24 hours of the customer's last message. Meta refused: ${er.message || ''}`
                        : er.code === 190 ? 'Instagram access token expired or invalid. Generate a new long-lived token in Settings → Instagram.'
                            : er.code === 200 || er.code === 3 || er.code === 230 ? `Meta refused (permission missing — the app may still need App Review for messaging): ${er.message || ''}`
                                : `Meta error ${er.code || r.status}: ${er.message || 'unknown error'}`;
                    setSetting('inbox.ig_error', { code: er.code || r.status, msg, at: utc() });
                    throw new HttpError(400, msg);
                }
                return j || {};
            }
            async function igProfile(c) {
                try {
                    const p = await graph('GET', `${c.ext_id}?fields=name,username`);
                    if (p && (p.name || p.username))
                        q.run('UPDATE ib_convs SET name=COALESCE(?,name), handle=COALESCE(?,handle) WHERE id=?', p.name || null, p.username || null, c.id);
                }
                catch (_a) { }
            }
            /* ---------- the bot: YES / NO replies to the confirmation template ---------- */
            const pendingOrder = o => o && ['new', 'hold'].includes(o.stage) && ['new', 'hold'].includes(o.status) && !o.tracking && !o.cancelled_at;
            function applyCs(o, outcome, note) {
                const stage = outcome === 'confirmed' ? 'confirmed' : 'cs_cancelled';
                q.run('INSERT INTO cs_calls(order_id,user_id,outcome,note) VALUES(?,?,?,?)', o.id, null, outcome, note);
                q.run("UPDATE orders SET stage=?, cs_attempts=cs_attempts+1, cs_note=?, cs_by=?, cs_at=datetime('now'), cs_next=? WHERE id=?", stage, note, null, null, o.id);
                L.refreshOrder(o.id);
                log(null, 'cs:' + outcome, 'order:' + o.id, note);
                if (S.configured() && setting('tag_shopify', true) && !String(o.id).startsWith('demo'))
                    S.tagOrder(o.id, [outcome === 'confirmed' ? 'ERP-Confirmed' : 'ERP-Cancel']).catch(e => log(null, 'shopify.tag.error', 'order:' + o.id, e.message));
            }
            function botDecide(c, m, text, payload) {
                if (autoCfg().bot === false)
                    return null;
                let outcome = null, order = null;
                const pm = /^(CONFIRM|CANCEL):(.+)$/.exec(String(payload || ''));
                if (pm) {
                    outcome = pm[1] === 'CONFIRM' ? 'confirmed' : 'cancelled';
                    order = orderBy(pm[2]);
                }
                if (!outcome)
                    outcome = parseReply(text) || parseReply(payload);
                if (!outcome)
                    return null;
                if (!order && m.context && m.context.id) {
                    const sent = q.get('SELECT order_id FROM ib_msgs WHERE ext_id=? AND order_id IS NOT NULL', m.context.id);
                    if (sent)
                        order = orderBy(sent.order_id);
                }
                if (!order) { // latest pending order for this phone that we sent a confirmation for
                    const r = q.get(`SELECT o.id FROM orders o JOIN ib_auto_log a ON a.order_id=o.id AND a.event='confirm' AND a.status='sent' WHERE o.phone=? AND o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.tracking IS NULL AND o.cancelled_at IS NULL ORDER BY o.created_at DESC LIMIT 1`, c.phone);
                    if (r)
                        order = orderBy(r.id);
                }
                if (!pendingOrder(order))
                    return null;
                return { outcome, order };
            }
            /* ---------- inbound WhatsApp (CEQUENS webhook) ---------- */
            function waValues(b) {
                const out = [];
                const walk = (x, d) => {
                    if (!x || typeof x !== 'object' || d > 5)
                        return;
                    if (Array.isArray(x))
                        return x.forEach(y => walk(y, d + 1));
                    if (Array.isArray(x.messages) || Array.isArray(x.statuses)) {
                        out.push(x);
                        return;
                    }
                    if (Array.isArray(x.entry))
                        return x.entry.forEach(e => (e.changes || []).forEach(ch => walk(ch.value, d + 1)));
                    for (const k of ['data', 'payload', 'value', 'body'])
                        if (x[k] && typeof x[k] === 'object')
                            walk(x[k], d + 1);
                };
                walk(b, 0);
                return out;
            }
            function msgContent(m) {
                const t = m.type;
                if (t === 'text' || (m.text && !t))
                    return { kind: 'text', body: (m.text && m.text.body) || '' };
                if (t === 'button')
                    return { kind: 'button', body: (m.button && (m.button.text || m.button.payload)) || '', payload: m.button && m.button.payload };
                if (t === 'interactive') {
                    const r = (m.interactive && (m.interactive.button_reply || m.interactive.list_reply)) || {};
                    return { kind: 'button', body: r.title || '', payload: r.id };
                }
                if (['image', 'document', 'audio', 'video', 'sticker', 'voice'].includes(t)) {
                    const x = m[t] || {};
                    return { kind: t, body: x.caption || x.filename || '', media: x.link || x.url || null, mediaId: x.id };
                }
                if (t === 'location') {
                    const x = m.location || {};
                    return { kind: 'location', body: [x.name, x.address].filter(Boolean).join(', ') || `${x.latitude},${x.longitude}`, media: x.latitude != null ? `https://maps.google.com/?q=${x.latitude},${x.longitude}` : null };
                }
                if (t === 'reaction')
                    return { kind: 'reaction', body: (m.reaction && m.reaction.emoji) || '' };
                if (t === 'contacts')
                    return { kind: 'contacts', body: ((m.contacts || []).map(c => (c.name && c.name.formatted_name) + ' ' + ((c.phones || [])[0] || {}).phone)).join(', ') };
                return { kind: t || 'unknown', body: '' };
            }
            function handleCequens(b) {
                var _a;
                const after = [], res = { messages: 0, statuses: 0, bot: 0 };
                for (const v of waValues(b)) {
                    const names = new Map((v.contacts || []).map(c => [String(c.wa_id || ''), c.profile && c.profile.name]));
                    for (const m of v.messages || []) {
                        if (!m || !m.from)
                            continue;
                        if (m.id && q.get('SELECT id FROM ib_msgs WHERE ext_id=?', m.id))
                            continue; // duplicate delivery
                        const from = L.waNumber(m.from), phone = L.normPhone(m.from), x = msgContent(m);
                        const ts = +m.timestamp ? +m.timestamp * 1000 : Date.now(), at = utc(Math.min(Date.now(), ts));
                        const c = getConv('wa', from, { phone, name: names.get(String(m.from)) || names.get(from) || null });
                        const dec = botDecide(c, m, x.body, x.payload);
                        const mid = addMsg(c.id, { dir: 'in', kind: x.kind, body: x.body, media: x.media, ext_id: m.id, ctx_id: m.context && m.context.id, at, bot: dec ? dec.outcome : null,
                            order_id: dec ? dec.order.id : null, payload: x.payload ? { payload: x.payload } : (x.mediaId ? { media_id: x.mediaId } : null), status: 'received' });
                        res.messages++;
                        if (dec) {
                            if (c._new)
                                q.run("UPDATE ib_convs SET status='closed' WHERE id=?", c.id);
                            const note = `WhatsApp bot: customer replied "${String(x.body || x.payload).slice(0, 60)}"`;
                            applyCs(dec.order, dec.outcome, note);
                            log(null, 'inbox.bot', 'inbox:' + c.id, { order: dec.order.name, outcome: dec.outcome, msg: mid });
                            res.bot++;
                            const a = autoCfg(), text = fill(dec.outcome === 'confirmed' ? a.confirmReply : a.cancelReply, vars(orderBy(dec.order.id)));
                            if (text.trim())
                                after.push(() => sendWhatsApp(phone, { text }, null, { conv: c, auto: 'bot', order_id: dec.order.id }).catch(e => log(null, 'inbox.error', 'inbox:' + c.id, e.message)));
                        }
                    }
                    for (const s of v.statuses || []) {
                        if (!s)
                            continue;
                        res.statuses++;
                        let msg = s.id ? q.get('SELECT * FROM ib_msgs WHERE ext_id=?', s.id) : null;
                        const ref = /^ib(\d+)$/.exec(String(s.clientReferenceID || s.client_reference_id || ''));
                        if (!msg && ref) {
                            msg = q.get('SELECT * FROM ib_msgs WHERE id=?', +ref[1]);
                            if (msg && s.id && !msg.ext_id)
                                q.run('UPDATE ib_msgs SET ext_id=? WHERE id=?', s.id, msg.id);
                        }
                        if (!msg)
                            continue;
                        const st = String(s.status || '').toLowerCase();
                        if (st === 'failed' || st === 'deleted') {
                            const er = (s.errors || [])[0] || {};
                            q.run('UPDATE ib_msgs SET status=?, error=? WHERE id=?', st, st === 'failed' ? `${er.code || ''} ${er.title || er.message || 'Failed'}${er.error_data && er.error_data.details ? ': ' + er.error_data.details : ''}`.trim() : msg.error, msg.id);
                            if (st === 'failed')
                                q.run("UPDATE ib_auto_log SET status='failed', error=? WHERE msg_id=?", (er.title || 'Failed').slice(0, 200), msg.id);
                        }
                        else if (ST_RANK[st] != null && (ST_RANK[st] > ((_a = ST_RANK[msg.status]) !== null && _a !== void 0 ? _a : -1) || msg.status === 'failed'))
                            q.run('UPDATE ib_msgs SET status=? WHERE id=?', st, msg.id);
                    }
                }
                return { res, after };
            }
            const runAfter = fns => { if (fns.length)
                setImmediate(async () => { for (const f of fns) {
                    try {
                        await f();
                    }
                    catch (_a) { }
                } }); };
            const hookUrlKey = (qs, key) => { if (!key || !qs.key)
                return false; const a = Buffer.from(String(qs.key)), b = Buffer.from(String(key)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
            route('POST', '/api/hooks/cequens', null, (req, u, b, res, p, qs) => {
                if (!hookUrlKey(qs, waCfg().key)) {
                    hookLog('cequens', 0, 'wrong key', req.rawBody);
                    throw new HttpError(403, 'Wrong key');
                }
                let out;
                try {
                    out = handleCequens(b);
                }
                catch (e) {
                    hookLog('cequens', 0, 'error: ' + e.message, req.rawBody);
                    throw e;
                }
                hookLog('cequens', 1, `${out.res.messages} msg, ${out.res.statuses} status${out.res.bot ? ', bot ' + out.res.bot : ''}`, req.rawBody);
                runAfter(out.after);
                return Object.assign({ ok: true }, out.res);
            });
            route('GET', '/api/hooks/cequens', null, (req, u, b, res, p, qs) => {
                if (!hookUrlKey(qs, waCfg().key))
                    throw new HttpError(403, 'Wrong key');
                return { ok: true, service: 'SundayBazar ERP WhatsApp webhook' };
            });
            /* ---------- Instagram webhook ---------- */
            route('GET', '/api/hooks/instagram', null, (req, u, b, res, p, qs) => {
                const c = igCfg();
                if (qs['hub.mode'] === 'subscribe' && c.verifyToken && qs['hub.verify_token'] === c.verifyToken) {
                    hookLog('instagram', 1, 'verified', JSON.stringify(qs));
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end(String(qs['hub.challenge'] || ''));
                    return undefined;
                }
                hookLog('instagram', 0, 'verify failed', JSON.stringify(qs));
                throw new HttpError(403, 'Verification failed');
            });
            function handleInstagram(b) {
                const c = igCfg(), me = String(c.igId || ''), after = [], res = { dms: 0, comments: 0 };
                for (const e of (b && b.entry) || []) {
                    for (const m of e.messaging || []) {
                        if (!m.message || !m.sender || !m.recipient)
                            continue;
                        const msg = m.message, echo = !!msg.is_echo;
                        if (msg.mid && q.get('SELECT id FROM ib_msgs WHERE ext_id=?', msg.mid))
                            continue; // our own API send (echo) or duplicate
                        const userId = String(echo ? m.recipient.id : m.sender.id);
                        const atts = (msg.attachments || []).map(a => ({ type: a.type || 'file', url: a.payload && a.payload.url }));
                        const text = msg.text || '', cv = getConv('ig', userId, { phone: phoneFromText(text) || null });
                        addMsg(cv.id, { dir: echo ? 'out' : 'in', kind: !text && atts[0] ? (atts[0].type === 'image' ? 'image' : atts[0].type) : 'text', body: text || (atts[0] ? '' : '[message]'), media: atts[0] && atts[0].url,
                            ext_id: msg.mid, at: m.timestamp ? utc(Math.min(Date.now(), +m.timestamp)) : undefined, note: echo ? 'Sent from the Instagram app' : null, status: echo ? 'sent' : 'received' });
                        res.dms++;
                        if (cv._new && !echo && c.token)
                            after.push(() => igProfile(cv));
                    }
                    for (const ch of e.changes || []) {
                        if (!/comments/.test(ch.field || '') || !ch.value || !ch.value.id)
                            continue;
                        const v = ch.value, from = v.from || {};
                        if (me && String(from.id) === me)
                            continue; // our own public reply
                        if (q.get('SELECT id FROM ib_msgs WHERE ext_id=?', String(v.id)))
                            continue;
                        const key = (from.id || from.username || 'unknown') + ':' + ((v.media && v.media.id) || '');
                        const cv = getConv('igc', key, { handle: from.username || null, media_id: v.media && v.media.id, phone: phoneFromText(v.text) || null });
                        addMsg(cv.id, { dir: 'in', kind: 'comment', body: v.text || '', ext_id: String(v.id), payload: { media: v.media || null, parent_id: v.parent_id || null }, status: 'received' });
                        res.comments++;
                    }
                }
                return { res, after };
            }
            route('POST', '/api/hooks/instagram', null, (req, u, b, res) => {
                const c = igCfg(), sig = String(req.headers['x-hub-signature-256'] || '');
                const want = c.appSecret ? 'sha256=' + crypto.createHmac('sha256', c.appSecret).update(req.rawBody || '').digest('hex') : '';
                if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
                    hookLog('instagram', 0, c.appSecret ? 'bad signature' : 'app secret not set', req.rawBody);
                    throw new HttpError(403, 'Bad signature');
                }
                const out = handleInstagram(b);
                hookLog('instagram', 1, `${out.res.dms} DM, ${out.res.comments} comment`, req.rawBody);
                runAfter(out.after);
                return Object.assign({ ok: true }, out.res);
            });
            /* ---------- Google Form exchange requests ---------- */
            const FIELDS = ['order', 'phone', 'name', 'current', 'wanted', 'reason', 'address', 'photos'];
            const FIELD_L = { order: 'Order number', phone: 'Phone', name: 'Customer name', current: 'Current size / SKU', wanted: 'Wanted size', reason: 'Reason', address: 'Address', photos: 'Photos link' };
            const GUESS = [['order', /order|invoice/i], ['phone', /phone|mobile|whats ?app|contact|cell/i], ['photos', /photo|picture|image|pic|upload/i], ['wanted', /want|new size|required size|desired|need|exchange (to|with)|replace/i],
                ['current', /current|received|ordered|old size|sku|purchased/i], ['reason', /reason|why|problem|issue|comment/i], ['address', /address/i], ['name', /name/i]];
            function mapAnswers(answers, map) {
                const out = {}, used = new Set(), keys = Object.keys(answers);
                for (const f of FIELDS)
                    if (map[f] && map[f] in answers) {
                        out[f] = answers[map[f]];
                        used.add(map[f]);
                    }
                for (const [f, re] of GUESS)
                    if (out[f] == null) {
                        const k = keys.find(k => !used.has(k) && re.test(k) && !/timestamp/i.test(k));
                        if (k) {
                            out[f] = answers[k];
                            used.add(k);
                        }
                    }
                if (out.current == null) {
                    const k = keys.find(k => !used.has(k) && /size/i.test(k));
                    if (k) {
                        out.current = answers[k];
                        used.add(k);
                    }
                }
                return out;
            }
            function findOrderRef(ref, phone) {
                const t = String(ref || '').trim().toUpperCase();
                let o = null;
                if (t) {
                    const d = /(\d{4,7})/.exec(t);
                    o = q.get('SELECT * FROM orders WHERE name=? OR id=? OR name=?', t.replace(/\s+/g, ''), String(ref).trim(), d ? 'SB' + d[1] : '__none__');
                }
                if (!o && phone)
                    o = q.get("SELECT * FROM orders WHERE phone=? ORDER BY (status='delivered') DESC, created_at DESC LIMIT 1", phone);
                return o;
            }
            route('POST', '/api/hooks/google-form', null, (req, u, b, res, p, qs) => {
                const cfg = formCfg();
                if (!hookUrlKey(qs, cfg.key)) {
                    hookLog('form', 0, 'wrong key', req.rawBody);
                    throw new HttpError(403, 'Wrong key');
                }
                const answers = {};
                for (const [k, v] of Object.entries((b && b.answers) || {}))
                    answers[String(k).trim()] = (Array.isArray(v) ? v.filter(x => x !== '').join(', ') : String(v == null ? '' : v)).trim().slice(0, 2000);
                if (!Object.keys(answers).length) {
                    hookLog('form', 0, 'no answers', req.rawBody);
                    throw new HttpError(400, 'No answers in the form submission');
                }
                const f = mapAnswers(answers, cfg.map || {});
                const phone = L.normPhone(f.phone || ''), submitted = String(b.submittedAt || answers.Timestamp || '').slice(0, 40);
                const key = (submitted || crypto.createHash('sha1').update(JSON.stringify(answers)).digest('hex')) + '|' + phone;
                const dup = q.get('SELECT * FROM ib_forms WHERE key=?', key);
                if (dup) {
                    hookLog('form', 1, 'duplicate', req.rawBody);
                    return { ok: true, duplicate: true, ticket: dup.ticket_id, conversation: dup.conv_id };
                }
                const o = findOrderRef(f.order, phone);
                const custPhone = phone || (o && o.phone) || '', name = f.name || (o && o.cust_name) || '';
                const lines = Object.entries(answers).map(([k2, v]) => `${k2}: ${v}`);
                const summary = [f.current ? 'Has: ' + f.current : '', f.wanted ? 'Wants: ' + f.wanted : '', f.reason ? 'Reason: ' + f.reason : ''].filter(Boolean).join(' · ');
                const fr = q.run('INSERT INTO ib_forms(key,form,submitted_at,answers,phone,order_id) VALUES(?,?,?,?,?,?)', key, String(b.form || 'Google Form').slice(0, 120), submitted, JSON.stringify(answers), custPhone, o ? o.id : null);
                const fid = Number(fr.lastInsertRowid);
                let ticket = null, err = null;
                if (ctx.services.tickets) {
                    try {
                        ticket = ctx.services.tickets.create({ type: 'Size exchange', channel: 'Google Form', order_id: o ? o.id : null, phone: custPhone, cust_name: name,
                            subject: `Size exchange (form) · ${o ? o.name : (f.order || custPhone)}${f.wanted ? ' → ' + f.wanted : ''}`.slice(0, 200),
                            note: `Google Form "${b.form || 'exchange request'}" submitted ${submitted}\n${summary ? summary + '\n' : ''}\n${lines.join('\n')}` }, null);
                    }
                    catch (e) {
                        err = e.message;
                    }
                }
                else
                    err = 'Tickets module not available';
                const cv = getConv('form', 'form:' + fid, { phone: custPhone || null, name: name || null });
                if (ticket)
                    q.run('UPDATE ib_convs SET ticket_id=? WHERE id=?', ticket, cv.id);
                addMsg(cv.id, { dir: 'in', kind: 'form', body: (summary ? summary + '\n\n' : '') + lines.join('\n'), order_id: o ? o.id : null, media: /^https?:\/\//.test(f.photos || '') ? f.photos.split(/[,\s]+/)[0] : null, payload: { fields: f, ticket, error: err } });
                q.run('UPDATE ib_forms SET ticket_id=?, conv_id=?, error=? WHERE id=?', ticket, cv.id, err, fid);
                log(null, 'inbox.form', 'inbox:' + cv.id, { order: o ? o.name : null, ticket, error: err });
                hookLog('form', 1, `ticket ${ticket || '-'}${err ? ' (' + err + ')' : ''}`, req.rawBody);
                if (cfg.ack && custPhone && waReady()) {
                    const t = templates().find(x => x.name === cfg.ackTemplate) || { params: ['{name}', '{order}'] };
                    const v = vars(o, { cust_name: name, order: o ? o.name : (f.order || '') });
                    runAfter([() => sendWhatsApp(custPhone, { template: cfg.ackTemplate, params: (t.params || []).map(x => fill(x, v)), lang: t.lang }, null, { auto: 'form', order_id: o ? o.id : null, name }).catch(e => log(null, 'inbox.error', 'form:' + fid, e.message))]);
                }
                return { ok: true, ticket, conversation: cv.id, order: o ? o.name : null, error: err };
            });
            /* ---------- automatic WhatsApp messages ---------- */
            const quietNow = a => { const f = +a.quietFrom, t = +a.quietTo; if (!(f >= 0) || !(t >= 0) || f === t)
                return false; const hr = +pkNow().slice(11, 13); return f > t ? (hr >= f || hr < t) : (hr >= f && hr < t); };
            const sentToday = () => q.get("SELECT COUNT(*) n FROM ib_auto_log WHERE status='sent' AND date(at,'+5 hours')=?", pkToday()).n;
            function candidates(a) {
                const out = [], age = `datetime('now','-${Math.max(1, +a.maxAgeHours || 48)} hours')`, R = a.rules;
                const add = (rule, o, event, extra = {}) => { if (o && o.phone)
                    out.push({ rule, order: o, event, key: extra.key || o.id, extra }); };
                const not = ev => `NOT EXISTS (SELECT 1 FROM ib_auto_log l WHERE l.order_id=o.id AND l.event=${ev})`;
                if (R.confirm.on)
                    for (const o of q.all(`SELECT o.* FROM orders o WHERE o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.tracking IS NULL AND o.cancelled_at IS NULL AND o.phone<>'' AND o.created_at>=${age} AND ${not("'confirm'")} ORDER BY o.created_at LIMIT 300`))
                        add('confirm', o, 'confirm');
                if (R.dispatched.on)
                    for (const o of q.all(`SELECT o.* FROM orders o WHERE o.status IN ('dispatched','in_transit') AND o.tracking IS NOT NULL AND o.phone<>'' AND COALESCE(o.dispatched_at, o.px_updated)>=${age} AND ${not("'dispatched'")} LIMIT 300`))
                        add('dispatched', o, 'dispatched');
                if (R.attempted.on)
                    for (const o of q.all(`SELECT o.* FROM orders o WHERE o.status='attempted' AND o.phone<>'' AND COALESCE(o.px_updated, o.dispatched_at)>=${age} AND ${not("'attempted:' || substr(COALESCE(o.px_updated,''),1,10)")} LIMIT 300`))
                        add('attempted', o, 'attempted:' + String(o.px_updated || '').slice(0, 10));
                if (R.delivered.on)
                    for (const o of q.all(`SELECT o.* FROM orders o WHERE o.status='delivered' AND o.phone<>'' AND o.delivered_at>=${age} AND ${not("'delivered'")} LIMIT 300`))
                        add('delivered', o, 'delivered');
                try {
                    if (R.exchange.on)
                        for (const e of q.all(`SELECT * FROM tk_exchanges WHERE step IN ('approved','dispatched','completed') AND updated_at>=${age} LIMIT 300`)) {
                            const ev = `exchange:${e.id}:${e.step}`, oid = e.order_id || 'exchange:' + e.id;
                            if (q.get('SELECT 1 FROM ib_auto_log WHERE order_id=? AND event=?', oid, ev))
                                continue;
                            const o = orderBy(e.order_id) || { id: oid, name: e.order_name, cust_name: e.cust_name, phone: e.phone };
                            add('exchange', Object.assign(Object.assign({}, o), { phone: e.phone || o.phone }), ev, { key: oid, step: EX_STEP[e.step] || e.step });
                        }
                    if (R.refund.on)
                        for (const r of q.all(`SELECT * FROM tk_refunds WHERE status='paid' AND method<>'Store credit' AND paid_at>=${age} LIMIT 300`)) {
                            const ev = 'refund:' + r.id, oid = r.order_id || 'refund:' + r.id;
                            if (q.get('SELECT 1 FROM ib_auto_log WHERE order_id=? AND event=?', oid, ev))
                                continue;
                            const o = orderBy(r.order_id) || { id: oid, name: r.order_name, cust_name: r.cust_name, phone: r.phone };
                            add('refund', Object.assign(Object.assign({}, o), { phone: r.phone || o.phone }), ev, { key: oid, amount: commas(r.amount) });
                        }
                }
                catch ( /* tickets tables missing */_a) { /* tickets tables missing */ }
                return out;
            }
            async function runAuto(force) {
                const a = autoCfg(), out = { sent: 0, queued: 0, failed: 0, skipped: 0, quiet: false, limit: false, off: false };
                if (!a.on && !force) {
                    out.off = true;
                    return out;
                }
                if (!waReady()) {
                    out.off = true;
                    out.error = 'WhatsApp not connected';
                    return out;
                }
                for (const c of candidates(a)) { // record every new event once (idempotency): status 'queued'
                    const valid = /^92\d{10}$/.test(L.waNumber(c.order.phone));
                    q.run('INSERT OR IGNORE INTO ib_auto_log(order_id,event,rule,phone,status,error) VALUES(?,?,?,?,?,?)', c.key, c.event, c.rule, c.order.phone, valid ? 'queued' : 'skipped', valid ? null : 'No valid mobile number');
                    if (!valid)
                        out.skipped++;
                    c._row = q.get('SELECT * FROM ib_auto_log WHERE order_id=? AND event=?', c.key, c.event);
                    c._cand = true;
                    CAND.set(c._row.id, c);
                }
                if (quietNow(a)) {
                    out.quiet = true;
                    out.queued = q.get("SELECT COUNT(*) n FROM ib_auto_log WHERE status='queued'").n;
                    CAND.clear();
                    return out;
                }
                let left = Math.max(0, (+a.dailyLimit || 500) - sentToday());
                for (const row of q.all("SELECT * FROM ib_auto_log WHERE status='queued' ORDER BY id LIMIT 500")) {
                    if (left <= 0) {
                        out.limit = true;
                        break;
                    }
                    const rule = a.rules[row.rule];
                    if (!rule) {
                        q.run("UPDATE ib_auto_log SET status='skipped', error='Unknown rule' WHERE id=?", row.id);
                        continue;
                    }
                    if (!rule.on)
                        continue;
                    if (!q.run("UPDATE ib_auto_log SET status='sending' WHERE id=? AND status='queued'", row.id).changes)
                        continue; // claimed elsewhere
                    const c = CAND.get(row.id);
                    const o = (c && c.order) || orderBy(row.order_id) || { id: row.order_id, phone: row.phone };
                    if (row.rule === 'confirm' && !pendingOrder(orderBy(o.id))) {
                        q.run("UPDATE ib_auto_log SET status='skipped', error='Order no longer waiting for confirmation', at=datetime('now') WHERE id=?", row.id);
                        out.skipped++;
                        continue;
                    }
                    const extra = (c && c.extra) || {};
                    if (row.rule === 'exchange' && !extra.step)
                        extra.step = EX_STEP[String(row.event).split(':')[2]] || '';
                    const v = vars(o.cust_name !== undefined && o.total !== undefined ? o : orderBy(o.id) || o, extra);
                    const tpl = templates().find(x => x.name === rule.template) || {};
                    const params = (rule.params && rule.params.length ? rule.params : tpl.params || []).map(x => fill(x, v));
                    const buttons = row.rule === 'confirm' && rule.payloads !== false ? [{ payload: 'CONFIRM:' + o.id, index: 0 }, { payload: 'CANCEL:' + o.id, index: 1 }] : [];
                    try {
                        const mid = await sendWhatsApp(row.phone || o.phone, { template: rule.template, params, lang: rule.lang || tpl.lang, buttons }, null, { auto: row.rule, order_id: orderBy(o.id) ? o.id : null, name: o.cust_name, convStatus: 'closed' });
                        q.run("UPDATE ib_auto_log SET status='sent', msg_id=?, error=NULL, at=datetime('now') WHERE id=?", mid, row.id);
                        out.sent++;
                        left--;
                    }
                    catch (e) {
                        if (e.code === 402) {
                            q.run("UPDATE ib_auto_log SET status='queued', error=?, msg_id=? WHERE id=?", e.message, e.msgId || null, row.id);
                            out.limit = true;
                            break;
                        }
                        q.run("UPDATE ib_auto_log SET status='failed', error=?, msg_id=?, at=datetime('now') WHERE id=?", String(e.message).slice(0, 300), e.msgId || null, row.id);
                        out.failed++;
                    }
                }
                CAND.clear();
                return out;
            }
            const CAND = new Map();
            ctx._ibAuto = runAuto;
            /* ---------- inbox API (perm inbox) ---------- */
            const agents = () => q.all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name').filter(x => A.userPerms(x).includes('inbox')).map(x => ({ id: x.id, name: x.name }));
            // u given → staff limited to their channels (inbox_wa / inbox_ig) get 404 for other channels' conversations
            const getC = (id, u) => { const c = q.get('SELECT * FROM ib_convs WHERE id=?', +id); need(c, 'Conversation not found', 404); const sc = u ? scopeOf(u) : null; need(!sc || sc.includes(c.channel), 'Conversation not found', 404); return c; };
            const windowOpen = c => !!c.last_in_at && Date.now() - parseUtc(c.last_in_at) < 24 * 3600e3;
            const userName = id => id ? ((q.get('SELECT name FROM users WHERE id=?', id) || {}).name || '#' + id) : 'nobody';
            route('GET', '/api/inbox/meta', 'inbox', (req, u) => ({
                agents: agents(), templates: templates().map(t => ({ name: t.name, lang: t.lang, params: t.params || [], text: t.text, buttons: t.buttons || [] })), quick: quick(),
                channels: { wa: waReady(), ig: igReady(), form: true }, allowed: scopeOf(u), canAdmin: isAdmin(u), ticketTypes: TICKET_TYPES, channelLabels: CHANNEL_L, canOrders: can(u, 'orders'), canTickets: can(u, 'tickets'),
            }));
            route('GET', '/api/inbox', 'inbox', (req, u, b, res, p, qs) => {
                const w = [], a = [], v = qs.view || 'open';
                if (v === 'open')
                    w.push("c.status<>'closed'");
                else if (v === 'mine') {
                    w.push("c.status<>'closed' AND c.assignee=?");
                    a.push(u.id);
                }
                else if (v === 'unassigned')
                    w.push("c.status<>'closed' AND c.assignee IS NULL");
                else if (v === 'pending')
                    w.push("c.status='pending'");
                else if (v === 'closed')
                    w.push("c.status='closed'");
                if (qs.channel) {
                    w.push('c.channel=?');
                    a.push(qs.channel);
                }
                const sc = scopeOf(u), scw = sc ? `channel IN (${sc.map(() => '?').join(',')})` : '1=1';
                if (sc) {
                    w.push('c.' + scw);
                    a.push(...sc);
                }
                if (qs.unread === '1')
                    w.push('c.unread>0');
                if (qs.q) {
                    const s = String(qs.q).trim(), t = '%' + s + '%', ph = L.normPhone(s);
                    w.push(`(c.name LIKE ? OR c.handle LIKE ? OR c.last_text LIKE ?${ph.length >= 6 ? ' OR c.phone LIKE ?' : ''} OR c.id IN (SELECT conv_id FROM ib_msgs WHERE body LIKE ? ORDER BY id DESC LIMIT 500))`);
                    a.push(t, t, t);
                    if (ph.length >= 6)
                        a.push('%' + ph + '%');
                    a.push(t);
                }
                const where = w.length ? 'WHERE ' + w.join(' AND ') : '', pg = ctx.page(qs, 60);
                const rows = q.all(`SELECT c.*, us.name assignee_name, cu.label clabel FROM ib_convs c LEFT JOIN users us ON us.id=c.assignee LEFT JOIN customers cu ON cu.phone=c.phone ${where} ORDER BY c.last_at DESC, c.id DESC LIMIT ? OFFSET ?`, ...a, pg.limit, pg.offset);
                rows.forEach(r => { r.phone = ctx.maskPhone(u, r.phone); r.window = r.channel === 'wa' ? windowOpen(r) : null; r.waiting = r.status !== 'closed' && r.last_dir === 'in' && r.last_in_at && Date.now() - parseUtc(r.last_in_at) > 3600e3; });
                const total = q.get(`SELECT COUNT(*) n FROM ib_convs c ${where}`, ...a).n;
                const counts = q.get(`SELECT SUM(status<>'closed') open, SUM(status<>'closed' AND assignee=?) mine, SUM(status<>'closed' AND assignee IS NULL) unassigned, SUM(status='pending') pending, SUM(status='closed') closed,
        SUM(status<>'closed' AND unread>0) unread FROM ib_convs WHERE ${scw}`, u.id, ...(sc || []));
                for (const k in counts)
                    counts[k] = counts[k] || 0;
                return { rows, total, page: pg.page, pages: Math.ceil(total / pg.limit), counts };
            });
            function customerPanel(c, u) {
                const ph = c.phone;
                if (!ph)
                    return null;
                const orders = q.all(`SELECT o.id,o.name,o.created_at,o.total,o.status,o.stage,o.tracking,o.courier,o.city,o.px_status,(SELECT group_concat(title, ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o WHERE o.phone=? ORDER BY o.created_at DESC LIMIT 30`, ph);
                let tickets = [];
                try {
                    tickets = q.all('SELECT id,type,status,subject,created_at,order_name FROM tk_tickets WHERE phone=? ORDER BY id DESC LIMIT 20', ph);
                }
                catch (_a) { }
                const cust = q.get('SELECT name,label,orders,delivered,returned,cancelled,spent FROM customers WHERE phone=?', ph);
                return { phone: ctx.maskPhone(u, ph), wa: L.waNumber(ph), customer: cust || null, orders, tickets };
            }
            route('GET', '/api/inbox/c/:id', 'inbox', (req, u, b, res, p, qs) => {
                const c = getC(p.id, u);
                if (qs.read !== '0' && c.unread) {
                    q.run('UPDATE ib_convs SET unread=0 WHERE id=?', c.id);
                    c.unread = 0;
                }
                const msgs = q.all('SELECT m.*, us.name user FROM ib_msgs m LEFT JOIN users us ON us.id=m.user_id WHERE m.conv_id=? ORDER BY m.id DESC LIMIT 300', c.id).reverse();
                msgs.forEach(m => { m.payload = J(m.payload, null); });
                const lastOrder = msgs.slice().reverse().find(m => m.order_id);
                const cust = customerPanel(c, u);
                const conv = Object.assign(Object.assign({}, c), { phone: ctx.maskPhone(u, c.phone), assignee_name: c.assignee ? userName(c.assignee) : null, window: c.channel === 'wa' ? windowOpen(c) : c.channel === 'ig' ? windowOpen(c) : null, window_until: c.last_in_at ? utc(parseUtc(c.last_in_at) + 24 * 3600e3) : null, channel_label: CHANNEL_L[c.channel] });
                const wa = c.channel !== 'wa' && c.phone ? q.get("SELECT id FROM ib_convs WHERE channel='wa' AND ext_id=?", L.waNumber(c.phone)) : null;
                return { conv, msgs, customer: cust, order_hint: lastOrder ? lastOrder.order_id : (cust && cust.orders[0] ? cust.orders[0].id : null), wa_conv: wa ? wa.id : null };
            });
            route('POST', '/api/inbox/c/:id/reply', 'inbox', async (req, u, b, res, p) => {
                const c = getC(p.id, u);
                let mid;
                if (c.channel === 'wa') {
                    if (b.template)
                        mid = await sendWhatsApp(c.ext_id, { template: String(b.template), params: Array.isArray(b.params) ? b.params : [], lang: b.lang }, u.id, { conv: c, order_id: b.order_id || null });
                    else {
                        need(windowOpen(c), 'The 24-hour WhatsApp window is closed. The customer has not messaged in the last 24 hours, so pick an approved template.');
                        mid = await sendWhatsApp(c.ext_id, b.image ? { image: b.image, caption: b.text } : { text: b.text }, u.id, { conv: c });
                    }
                }
                else if (c.channel === 'ig' || c.channel === 'igc') {
                    const text = String(b.text || '').trim();
                    need(text, 'Write a message');
                    const cfg = igCfg();
                    if (c.channel === 'ig') {
                        const r = await graph('POST', `${cfg.igId || 'me'}/messages`, { recipient: { id: c.ext_id }, message: { text } });
                        mid = addMsg(c.id, { dir: 'out', body: text, ext_id: r.message_id || null, status: 'sent', user_id: u.id });
                    }
                    else {
                        const last = q.get("SELECT * FROM ib_msgs WHERE conv_id=? AND dir='in' AND ext_id IS NOT NULL ORDER BY id DESC LIMIT 1", c.id);
                        need(last, 'No comment to reply to');
                        if (b.mode === 'private') {
                            const r = await graph('POST', `${cfg.igId || 'me'}/messages`, { recipient: { comment_id: last.ext_id }, message: { text } });
                            mid = addMsg(c.id, { dir: 'out', kind: 'private', body: text, ext_id: r.message_id || null, status: 'sent', user_id: u.id, note: 'Private reply (DM)' });
                        }
                        else {
                            const r = await graph('POST', `${last.ext_id}/replies`, { message: text });
                            mid = addMsg(c.id, { dir: 'out', kind: 'comment', body: text, ext_id: r.id || null, status: 'sent', user_id: u.id, note: 'Public reply' });
                        }
                    }
                }
                else
                    throw new HttpError(400, 'Form requests cannot be answered here. Use "WhatsApp customer" to message them.');
                if (!c.assignee)
                    q.run('UPDATE ib_convs SET assignee=? WHERE id=?', u.id, c.id);
                q.run("UPDATE ib_convs SET unread=0, status=CASE WHEN status='closed' THEN 'open' ELSE status END WHERE id=?", c.id);
                log(u.id, b.template ? 'inbox.template' : 'inbox.reply', 'inbox:' + c.id, { channel: c.channel, template: b.template || undefined });
                return { ok: true, id: mid };
            });
            route('POST', '/api/inbox/c/:id/assign', 'inbox', (req, u, b, res, p) => {
                const c = getC(p.id, u), to = b.user_id ? +b.user_id : null;
                if (to)
                    need(agents().some(a => a.id === to), 'That person has no inbox access');
                q.run('UPDATE ib_convs SET assignee=? WHERE id=?', to, c.id);
                log(u.id, 'inbox.assign', 'inbox:' + c.id, { to: userName(to) });
                return { ok: true };
            });
            route('POST', '/api/inbox/c/:id/status', 'inbox', (req, u, b, res, p) => {
                const c = getC(p.id, u);
                need(['open', 'pending', 'closed'].includes(b.status), 'Unknown status');
                q.run("UPDATE ib_convs SET status=?, unread=CASE WHEN ?='closed' THEN 0 ELSE unread END WHERE id=?", b.status, b.status, c.id);
                log(u.id, b.status === 'closed' ? 'inbox.close' : b.status === 'open' && c.status === 'closed' ? 'inbox.reopen' : 'inbox.status', 'inbox:' + c.id, { from: c.status, to: b.status });
                return { ok: true };
            });
            route('POST', '/api/inbox/c/:id/phone', 'inbox', (req, u, b, res, p) => {
                const c = getC(p.id, u), ph = L.normPhone(b.phone || '');
                need(!b.phone || ph.length === 11, 'Enter a mobile number like 03001234567');
                need(c.channel !== 'wa', 'WhatsApp conversations already have the phone number');
                q.run('UPDATE ib_convs SET phone=? WHERE id=?', ph || null, c.id);
                log(u.id, 'inbox.link', 'inbox:' + c.id, { phone: ph });
                return { ok: true };
            });
            route('POST', '/api/inbox/c/:id/ticket', 'inbox', (req, u, b, res, p) => {
                const c = getC(p.id, u);
                need(ctx.services.tickets, 'Tickets module is not available');
                const msgs = q.all("SELECT body FROM ib_msgs WHERE conv_id=? AND dir='in' ORDER BY id DESC LIMIT 5", c.id).reverse().map(m => m.body).filter(Boolean);
                const id = ctx.services.tickets.create({ type: TICKET_TYPES.includes(b.type) ? b.type : 'Order inquiry', channel: TICKET_CH[c.channel], order_id: b.order_id || null, phone: b.phone || c.phone || '',
                    cust_name: c.name || '', priority: b.priority, subject: b.subject, note: b.note != null ? String(b.note) : msgs.join('\n') }, u.id);
                q.run('UPDATE ib_convs SET ticket_id=? WHERE id=?', id, c.id);
                log(u.id, 'inbox.ticket', 'inbox:' + c.id, { ticket: id });
                return { id };
            });
            route('POST', '/api/inbox/open-wa', 'inbox', (req, u, b) => {
                const ph = L.normPhone(b.phone || '');
                need(/^03\d{9}$/.test(ph), 'Enter a mobile number like 03001234567');
                const sc = scopeOf(u);
                need(!sc || sc.includes('wa'), 'You can only use Instagram messages', 403);
                const c = getConv('wa', L.waNumber(ph), { phone: ph, name: b.name || null });
                return { id: c.id };
            });
            /* ---------- settings (perm inbox_admin) ---------- */
            const baseUrl = req => (setting('inbox.public_url', '') || `${req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`).replace(/\/+$/, '');
            const lastHook = src => (q.get('SELECT at, ok, note FROM ib_hooks WHERE src=? ORDER BY id DESC LIMIT 1', src) || null);
            const lastOk = src => ((q.get('SELECT at FROM ib_hooks WHERE src=? AND ok=1 ORDER BY id DESC LIMIT 1', src) || {}).at || null);
            route('GET', '/api/inbox/settings', 'inbox_admin', req => {
                const w = waCfg(), i = igCfg(), f = formCfg(), base = baseUrl(req);
                return {
                    publicUrl: setting('inbox.public_url', ''), base,
                    wa: { url: w.url, bearer: w.bearer !== false, hasToken: !!w.token, connectedAt: w.connectedAt || null },
                    ig: { appId: i.appId || '', igId: i.igId || '', version: i.version, graphUrl: i.graphUrl, hasSecret: !!i.appSecret, hasToken: !!i.token, verifyToken: i.verifyToken },
                    form: { map: f.map || {}, ack: !!f.ack, ackTemplate: f.ackTemplate, fields: FIELDS.map(k => [k, FIELD_L[k]]), recent: q.all('SELECT id, form, submitted_at, phone, ticket_id, error, at FROM ib_forms ORDER BY id DESC LIMIT 10'),
                        questions: [...new Set(q.all('SELECT answers FROM ib_forms ORDER BY id DESC LIMIT 20').flatMap(r => Object.keys(J(r.answers, {}))))] },
                    auto: autoCfg(), templates: templates(), quick: quick(),
                    urls: { cequens: `${base}/api/hooks/cequens?key=${w.key}`, instagram: `${base}/api/hooks/instagram`, form: `${base}/api/hooks/google-form?key=${f.key}` },
                    last: { cequens: lastHook('cequens'), instagram: lastHook('instagram'), form: lastHook('form') },
                    errors: { wa: setting('inbox.wa_error', null), ig: setting('inbox.ig_error', null) },
                    stats: { sentToday: sentToday(), queued: q.get("SELECT COUNT(*) n FROM ib_auto_log WHERE status='queued'").n, quiet: quietNow(autoCfg()) },
                };
            });
            route('POST', '/api/inbox/settings', 'inbox_admin', (req, u, b) => {
                if ('publicUrl' in b) {
                    const v = String(b.publicUrl || '').trim().replace(/\/+$/, '');
                    need(!v || /^https?:\/\/[^\s]+$/.test(v), 'The ERP address must start with https://');
                    setSetting('inbox.public_url', v);
                }
                if (b.wa) {
                    const cur = setting('inbox.wa', {}) || {}, nx = Object.assign({}, cur);
                    if ('url' in b.wa) {
                        const v = String(b.wa.url || '').trim();
                        need(!v || /^https?:\/\//.test(v), 'API URL must start with https://');
                        nx.url = v;
                    }
                    if ('bearer' in b.wa)
                        nx.bearer = !!b.wa.bearer;
                    if (b.wa.token) {
                        nx.token = String(b.wa.token).trim();
                        nx.connectedAt = utc();
                    }
                    if (b.wa.clearToken) {
                        nx.token = '';
                        nx.connectedAt = null;
                    }
                    if (b.wa.newKey)
                        nx.key = rnd(16);
                    setSetting('inbox.wa', nx);
                }
                if (b.ig) {
                    const cur = setting('inbox.ig', {}) || {}, nx = Object.assign({}, cur);
                    for (const k of ['appId', 'igId', 'version', 'graphUrl'])
                        if (k in b.ig)
                            nx[k] = String(b.ig[k] || '').trim();
                    if (nx.version && !/^v\d+\.\d+$/.test(nx.version))
                        need(false, 'Graph version looks like v21.0');
                    if (b.ig.appSecret)
                        nx.appSecret = String(b.ig.appSecret).trim();
                    if (b.ig.token)
                        nx.token = String(b.ig.token).trim();
                    if (b.ig.clearToken)
                        nx.token = '';
                    if (b.ig.verifyToken)
                        nx.verifyToken = String(b.ig.verifyToken).trim();
                    setSetting('inbox.ig', nx);
                }
                if (b.form) {
                    const cur = setting('inbox.form', {}) || {}, nx = Object.assign({}, cur);
                    if (b.form.map && typeof b.form.map === 'object') {
                        nx.map = {};
                        for (const k of FIELDS)
                            if (b.form.map[k])
                                nx.map[k] = String(b.form.map[k]).trim();
                    }
                    if ('ack' in b.form)
                        nx.ack = !!b.form.ack;
                    if (b.form.ackTemplate)
                        nx.ackTemplate = String(b.form.ackTemplate);
                    if (b.form.newKey)
                        nx.key = rnd(16);
                    setSetting('inbox.form', nx);
                }
                if (b.auto) {
                    const cur = setting('inbox.auto', {}) || {}, nx = Object.assign(Object.assign({}, cur), { rules: Object.assign({}, (cur.rules || {})) });
                    for (const k of ['on', 'bot'])
                        if (k in b.auto)
                            nx[k] = !!b.auto[k];
                    for (const k of ['quietFrom', 'quietTo'])
                        if (k in b.auto) {
                            const v = +b.auto[k];
                            need(v >= 0 && v <= 23, 'Quiet hours must be 0–23');
                            nx[k] = v;
                        }
                    if ('dailyLimit' in b.auto) {
                        const v = +b.auto.dailyLimit;
                        need(v >= 0 && v <= 100000, 'Daily limit must be a number');
                        nx.dailyLimit = v;
                    }
                    if ('maxAgeHours' in b.auto) {
                        const v = +b.auto.maxAgeHours;
                        need(v >= 1 && v <= 720, 'Max age must be 1–720 hours');
                        nx.maxAgeHours = v;
                    }
                    for (const k of ['confirmReply', 'cancelReply'])
                        if (k in b.auto)
                            nx[k] = String(b.auto[k] || '').slice(0, 1000);
                    for (const [k, r] of Object.entries(b.auto.rules || {})) {
                        if (!RULES[k] || !r)
                            continue;
                        const x = Object.assign({}, (nx.rules[k] || {}));
                        if ('on' in r)
                            x.on = !!r.on;
                        if (r.template)
                            x.template = String(r.template).trim();
                        if (r.lang)
                            x.lang = String(r.lang).trim();
                        if (Array.isArray(r.params))
                            x.params = r.params.map(s => String(s).slice(0, 200));
                        if ('payloads' in r)
                            x.payloads = !!r.payloads;
                        nx.rules[k] = x;
                    }
                    setSetting('inbox.auto', nx);
                }
                if (Array.isArray(b.templates))
                    setSetting('inbox.templates', b.templates.filter(t => t && /^[a-z0-9_]+$/.test(t.name || '')).map(t => ({ name: t.name, lang: String(t.lang || 'en'), category: t.category || 'Utility',
                        params: (t.params || []).map(String), text: String(t.text || '').slice(0, 1024), buttons: (t.buttons || []).map(String).slice(0, 3) })));
                if (Array.isArray(b.quick))
                    setSetting('inbox.quick', b.quick.filter(x => x && x.title && x.body).map(x => ({ title: String(x.title).slice(0, 60), body: String(x.body).slice(0, 1000) })));
                log(u.id, 'inbox.settings', 'settings', Object.keys(b));
                return { ok: true };
            });
            route('POST', '/api/inbox/settings/test-wa', 'inbox_admin', async (req, u, b) => {
                need(b.phone, 'Enter your own WhatsApp number to test');
                const id = await sendWhatsApp(b.phone, b.template ? { template: b.template, params: b.params || [], lang: b.lang } : { text: b.text || 'Test message from SundayBazar ERP' }, u.id);
                return { ok: true, id, msg: q.get('SELECT ext_id, status FROM ib_msgs WHERE id=?', id) };
            });
            route('POST', '/api/inbox/settings/test-ig', 'inbox_admin', async () => { const c = igCfg(); const r = await graph('GET', `${c.igId || 'me'}?fields=id,username,name`); return { ok: true, account: r }; });
            route('GET', '/api/inbox/hooks', 'inbox_admin', (req, u, b, res, p, qs) => q.all(`SELECT id, src, ok, note, substr(body,1,4000) body, at FROM ib_hooks ${qs.src ? 'WHERE src=?' : ''} ORDER BY id DESC LIMIT 100`, ...(qs.src ? [qs.src] : [])));
            route('POST', '/api/inbox/auto/run', 'inbox_admin', async (req, u) => { const r = await runAuto(true); log(u.id, 'inbox.autorun', 'inbox', r); return r; });
            route('GET', '/api/inbox/auto/log', 'inbox_admin', (req, u, b, res, p, qs) => ({
                rows: q.all(`SELECT l.*, o.name order_name, o.cust_name, m.status msg_status FROM ib_auto_log l LEFT JOIN orders o ON o.id=l.order_id LEFT JOIN ib_msgs m ON m.id=l.msg_id ${qs.status ? 'WHERE l.status=?' : ''} ORDER BY l.id DESC LIMIT 200`, ...(qs.status ? [qs.status] : [])),
                counts: Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM ib_auto_log GROUP BY status').map(r => [r.status, r.n])),
                bot: q.get("SELECT SUM(outcome='confirmed') confirmed, SUM(outcome='cancelled') cancelled FROM cs_calls WHERE user_id IS NULL AND note LIKE 'WhatsApp bot%' AND date(at,'+5 hours')=?", pkToday()),
            }));
            /* ---------- services ---------- */
            ctx.services.inbox = {
                sendWhatsApp: (phone, spec, userId) => sendWhatsApp(phone, spec || {}, userId || null),
                waReady: () => waReady(),
                summary() {
                    const c = q.get(`SELECT SUM(status<>'closed') open, SUM(status<>'closed' AND unread>0) unread, SUM(status<>'closed' AND last_dir='in' AND last_in_at<datetime('now','-1 hour')) waiting FROM ib_convs`);
                    return { open: c.open || 0, unread: c.unread || 0, waitingOver1h: c.waiting || 0, autoSentToday: sentToday(),
                        confirmedByBot: q.get("SELECT COUNT(*) n FROM cs_calls WHERE user_id IS NULL AND outcome='confirmed' AND note LIKE 'WhatsApp bot%' AND date(at,'+5 hours')=?", pkToday()).n };
                },
                runAuto: () => runAuto(true),
            };
            ctx._ibAlertsInfo = () => ({ waReady: waReady(), igReady: igReady(), wa: waCfg(), lastOkWa: lastOk('cequens'), waErr: setting('inbox.wa_error', null), igErr: setting('inbox.ig_error', null) });
        },
        jobs: [{ name: 'auto-whatsapp', every: 5, offset: 2, run: async (ctx) => { if (ctx._ibAuto)
                    await ctx._ibAuto(false); } }],
        // channel-limited staff: inbox_wa → WhatsApp + Google Form, inbox_ig → Instagram DMs + comments. null = sees every channel
        chanScope(u, can) {
            if (can(u, 'inbox_admin'))
                return null;
            const wa = can(u, 'inbox_wa'), ig = can(u, 'inbox_ig');
            if (wa === ig)
                return null;
            return wa ? ['wa', 'form'] : ['ig', 'igc'];
        },
        counts(u, ctx) {
            if (!ctx.can(u, 'inbox'))
                return {};
            const sc = module.exports.chanScope(u, ctx.can), scw = sc ? ` AND channel IN (${sc.map(() => '?').join(',')})` : '';
            return { inbox: ctx.q.get("SELECT COUNT(*) n FROM ib_convs WHERE status<>'closed' AND unread>0 AND (assignee=? OR assignee IS NULL)" + scw, u.id, ...(sc || [])).n };
        },
        alerts(u, ctx) {
            const { q, can } = ctx, out = [];
            if (!can(u, 'inbox'))
                return out;
            const sc = module.exports.chanScope(u, can), scw = sc ? ` AND channel IN (${sc.map(() => '?').join(',')})` : '';
            const n = q.get("SELECT COUNT(*) n FROM ib_convs WHERE status<>'closed' AND last_dir='in' AND last_in_at<datetime('now','-1 hour') AND (assignee=? OR assignee IS NULL)" + scw, u.id, ...(sc || [])).n;
            if (n)
                out.push({ level: 'warn', text: `${n} customer message${n > 1 ? 's' : ''} waiting more than 1 hour for a reply`, href: '#/inbox' });
            if (can(u, 'inbox_admin') && ctx._ibAlertsInfo) {
                const i = ctx._ibAlertsInfo(), day = Date.now() - 24 * 3600e3;
                if (i.waReady && i.wa.connectedAt && parseUtc(i.wa.connectedAt) < day && (!i.lastOkWa || parseUtc(i.lastOkWa) < day))
                    out.push({ level: 'warn', text: 'WhatsApp: nothing received from CEQUENS for 24+ hours. Check the webhook URL with CEQUENS support.', href: '#/inbox/settings/wa' });
                if (i.waErr && parseUtc(i.waErr.at) > day)
                    out.push({ level: i.waErr.code === 402 ? 'bad' : 'warn', text: 'WhatsApp sending problem: ' + i.waErr.msg, href: '#/inbox/settings/wa' });
                if (i.igErr && parseUtc(i.igErr.at) > day)
                    out.push({ level: 'warn', text: 'Instagram problem: ' + i.igErr.msg, href: '#/inbox/settings/ig' });
            }
            return out;
        },
        activity: {
            'inbox.reply': 'Replied to customer (inbox)', 'inbox.template': 'Sent WhatsApp template', 'inbox.assign': 'Assigned conversation', 'inbox.close': 'Closed conversation',
            'inbox.reopen': 'Reopened conversation', 'inbox.status': 'Changed conversation status', 'inbox.ticket': 'Created ticket from inbox', 'inbox.link': 'Linked phone to conversation',
            'inbox.settings': 'Changed messaging settings', 'inbox.autorun': 'Ran auto WhatsApp messages', 'inbox.bot': 'WhatsApp bot handled a reply', 'inbox.form': 'Form exchange request received',
        },
    };
};