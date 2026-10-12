    // Marketing: Meta ad spend pulled daily from the Marketing API, real cost per order / delivered order, ROAS, alerts, spend posted to accounts
    'use strict';
    const CANCELLED = `('cancelled','cs_cancelled','courier_cancelled')`;
    const RETURNED = `('returned','return_received','returning')`;
    const DEF = { token: '', accounts: [], version: 'v21.0', currency: 'PKR', fx: 280, cardPct: 0, post: false, creditAccount: 'Meta Ads Payable', postFrom: '', dailyBudget: 0, zeroThreshold: 15000 };
    const BANKS = ['Meezan (SB)', 'Cash', 'Petty Cash', 'PayFast'];
    const OTHER_CATS = ['Influencer', 'Photoshoot', 'Boosted post', 'Printing', 'Other'];
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const r2 = v => Math.round((+v || 0) * 100) / 100;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let ctx = null;
    const cfg = () => (Object.assign(Object.assign({}, DEF), (ctx.setting('marketing', {}) || {})));
    const status = () => ctx.setting('marketing_status', {}) || {};
    const setStatus = p => ctx.setSetting('marketing_status', Object.assign(Object.assign({}, status()), p));
    const connected = c => !!((c || cfg()).token && (c || cfg()).accounts.length);
    const graphBase = () => String(ctx.setting('marketing_graph_url', '') || process.env.MKT_GRAPH_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
    // currency is per ad account (read from Meta, owner can override); PKR as-is, foreign × USD→PKR rate × (1 + card %)
    const acctRow = act => ctx.q.get('SELECT * FROM mkt_accounts WHERE id=?', act);
    const acctCur = (c, act) => { const a = acctRow(act); return String((a && (a.override || a.currency)) || c.currency || 'PKR').toUpperCase(); };
    const rateFor = (c, cur) => cur === 'PKR' ? 1 : (+c.fx || 0) * (1 + (+c.cardPct || 0) / 100);
    const statusTxt = s => ({ 1: 'Active', 2: 'Disabled', 3: 'Unsettled (payment due)', 7: 'Pending review', 8: 'Pending settlement', 9: 'In grace period', 100: 'Pending closure', 101: 'Closed' })[+s] || (s == null ? '' : 'Status ' + s);
    function saveAcct(act, j) {
        ctx.q.run(`INSERT INTO mkt_accounts(id,name,currency,status,checked_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name, currency=excluded.currency, status=excluded.status, checked_at=excluded.checked_at`, act, j.name || null, j.currency ? String(j.currency).toUpperCase() : null, statusTxt(j.account_status));
    }
    const acctInfo = async (c, act) => { const j = await graphFetch(gUrl(c, act, { fields: 'name,currency,account_status,amount_spent' })); saveAcct(act, j); return j; };
    const normAct = a => { a = String(a || '').trim(); if (!a)
        return ''; return a.startsWith('act_') ? a : 'act_' + a.replace(/\D/g, ''); };
    /* ---------- Graph API ---------- */
    function metaError(j, httpStatus) {
        const e = (j && j.error) || {}, code = +e.code, sub = +e.error_subcode;
        let msg;
        if (code === 190)
            msg = 'Meta token expired or was revoked (code 190). Make a new System User token with ads_read and paste it in Marketing → Settings.';
        else if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))
            msg = `Meta rate limit reached (code ${code}). The ERP will try again at the next sync.`;
        else if (code === 10 || code === 200 || code === 294 || (code >= 200 && code < 300))
            msg = `Token has no permission for this ad account (code ${code}). Assign the ad account to the system user and include ads_read.`;
        else if (code === 100)
            msg = `Meta did not accept the request (code 100${sub ? '/' + sub : ''}): ${e.message || ''}. Check the ad account id (act_…) and API version.`;
        else
            msg = `Meta error${code ? ' (code ' + code + ')' : ''}${httpStatus ? ' [HTTP ' + httpStatus + ']' : ''}: ${e.message || 'unknown'}`;
        const err = new Error(msg);
        err.meta = { code, sub };
        err.rateLimit = /rate limit/.test(msg);
        return err;
    }
    async function graphFetch(url, tries = 0) {
        let r;
        try {
            r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
        }
        catch (e) {
            if (tries < 2) {
                await sleep(1500 * (tries + 1));
                return graphFetch(url, tries + 1);
            }
            throw new Error('Could not reach Meta (' + (e.cause && e.cause.code || e.message) + '). Check the internet connection.');
        }
        let j = null;
        try {
            j = await r.json();
        }
        catch (_a) { }
        if (!r.ok || (j && j.error)) {
            const err = metaError(j, r.status);
            if ((err.rateLimit || r.status >= 500) && tries < 2) {
                await sleep((process.env.MKT_RETRY_MS ? +process.env.MKT_RETRY_MS : 20000) * (tries + 1));
                return graphFetch(url, tries + 1);
            }
            throw err;
        }
        return j;
    }
    const gUrl = (c, path, params) => `${graphBase()}/${c.version || 'v21.0'}/${path}?` + new URLSearchParams(Object.assign(Object.assign({}, params), { access_token: c.token }));
    async function testConnection(c) {
        const out = [];
        for (const a of c.accounts) {
            const j = await acctInfo(c, a);
            out.push({ id: a, name: j.name, currency: j.currency, used: acctCur(c, a), status: statusTxt(j.account_status), amount_spent: j.amount_spent });
        }
        return out;
    }
    // Purchases: Meta reports the same purchase under several action types; take the larger of the two, never add them
    const PURCH = ['purchase', 'offsite_conversion.fb_pixel_purchase'];
    const pickPurchase = arr => Math.max(0, ...(arr || []).filter(a => PURCH.includes(a.action_type)).map(a => +a.value || 0));
    async function fetchInsights(c, act, since, until) {
        const rows = [];
        let url = gUrl(c, act + '/insights', { level: 'campaign', time_increment: '1', time_range: JSON.stringify({ since, until }),
            fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpm,actions,action_values', limit: '500' });
        for (let pageN = 0; url && pageN < 200; pageN++) {
            const j = await graphFetch(url);
            for (const d of j.data || [])
                rows.push({ date: d.date_start, campaign_id: String(d.campaign_id), campaign_name: d.campaign_name || '', spend: +d.spend || 0,
                    impressions: +d.impressions || 0, reach: +d.reach || 0, clicks: +d.clicks || 0, purchases: pickPurchase(d.actions), purchase_value: pickPurchase(d.action_values) });
            url = j.paging && j.paging.next;
        }
        return rows;
    }
    let running = false;
    async function sync(days, userId) {
        const c = cfg();
        if (!connected(c))
            throw new Error('Meta is not connected. Add the token and ad account in Marketing → Settings.');
        if (running)
            throw new Error('A Meta sync is already running. Try again in a minute.');
        running = true;
        const until = ctx.pkToday(), since = addDays(until, -(Math.max(1, days) - 1));
        const { q } = ctx;
        let n = 0;
        const need = (ok, m) => { if (!ok)
            throw new Error(m); };
        try {
            setStatus({ lastRun: new Date().toISOString(), running: true });
            const curs = {};
            for (const act of c.accounts) {
                await acctInfo(c, act);
                const cur = curs[act] = acctCur(c, act), fx = rateFor(c, cur);
                need(fx > 0, `Ad account ${act} bills in ${cur}: enter the USD → PKR rate in Marketing → Settings`);
                const rows = await fetchInsights(c, act, since, until);
                const stamp = q.get("SELECT datetime('now') t").t;
                q.tx(() => {
                    for (const r of rows) {
                        q.run(`INSERT INTO mkt_daily(date,account_id,campaign_id,campaign_name,spend,spend_pkr,impressions,reach,clicks,purchases,purchase_value,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(date,account_id,campaign_id) DO UPDATE SET campaign_name=excluded.campaign_name, spend=excluded.spend, spend_pkr=excluded.spend_pkr, impressions=excluded.impressions,
            reach=excluded.reach, clicks=excluded.clicks, purchases=excluded.purchases, purchase_value=excluded.purchase_value, synced_at=excluded.synced_at`, r.date, act, r.campaign_id, r.campaign_name, r.spend, r2(r.spend * fx), r.impressions, r.reach, r.clicks, r.purchases, r.purchase_value, stamp);
                    }
                    // a campaign/day Meta no longer reports in this window (e.g. spend corrected to 0) is removed
                    q.run('DELETE FROM mkt_daily WHERE account_id=? AND date BETWEEN ? AND ? AND synced_at<?', act, since, until, stamp);
                });
                n += rows.length;
            }
            const msg = `${n} campaign-days, ${since} to ${until}` + (c.accounts.length > 1 ? ` · ${c.accounts.length} ad accounts (${Object.values(curs).join('/')})` : '');
            setStatus({ lastOk: new Date().toISOString(), lastError: null, lastErrorAt: null, running: false, lastMsg: msg });
            ctx.syncLog('meta', true, msg);
            if (userId)
                ctx.log(userId, 'marketing.sync', 'meta', { since, until, rows: n });
            postRange(since, until);
            return { rows: n, since, until };
        }
        catch (e) {
            setStatus({ lastError: e.message, lastErrorAt: new Date().toISOString(), running: false });
            ctx.syncLog('meta', false, e.message);
            throw e;
        }
        finally {
            running = false;
        }
    }
    /* ---------- accounts posting ---------- */
    const accSvc = () => ctx.services.accounts && typeof ctx.services.accounts.post === 'function' ? ctx.services.accounts : null;
    function daySpend(date) {
        const a = ctx.q.get('SELECT COALESCE(SUM(spend_pkr),0) s FROM mkt_daily WHERE date=?', date).s;
        const m = ctx.q.get('SELECT COALESCE(SUM(amount),0) s FROM mkt_manual WHERE date=?', date).s;
        return r2(a + m);
    }
    function postDay(date, force) {
        const c = cfg(), acc = accSvc(), { q } = ctx;
        if (!c.post || !acc)
            return null;
        if (c.postFrom && date < c.postFrom)
            return null;
        const amt = daySpend(date), prev = q.get('SELECT * FROM mkt_posted WHERE date=?', date);
        if (!force && prev && !prev.error && Math.abs(prev.amount - amt) < 0.01)
            return prev;
        try {
            if (amt <= 0) {
                if (prev && typeof acc.void === 'function')
                    acc.void('meta', date, null);
                q.run('DELETE FROM mkt_posted WHERE date=?', date);
                return null;
            }
            const jid = acc.post({ date, memo: `Meta ad spend ${date}`, source: 'meta', source_id: date,
                lines: [{ account: 'Social Media Marketing', debit: amt }, { account: c.creditAccount || 'Meta Ads Payable', credit: amt }] }, null);
            q.run(`INSERT INTO mkt_posted(date,amount,journal_id,posted_at,error) VALUES(?,?,?,datetime('now'),NULL) ON CONFLICT(date) DO UPDATE SET amount=excluded.amount, journal_id=excluded.journal_id, posted_at=excluded.posted_at, error=NULL`, date, amt, jid !== null && jid !== void 0 ? jid : null);
        }
        catch (e) {
            q.run(`INSERT INTO mkt_posted(date,amount,posted_at,error) VALUES(?,?,datetime('now'),?) ON CONFLICT(date) DO UPDATE SET amount=excluded.amount, error=excluded.error`, date, amt, e.message);
        }
        return q.get('SELECT * FROM mkt_posted WHERE date=?', date);
    }
    function postRange(from, to) { for (let d = from; d <= to; d = addDays(d, 1))
        postDay(d); }
    function postEntry(id) {
        const { q } = ctx, e = q.get('SELECT * FROM mkt_spend WHERE id=?', id), acc = accSvc();
        if (!e)
            return;
        if (!acc) {
            q.run('UPDATE mkt_spend SET posted=0, error=? WHERE id=?', 'Accounts module not available yet', id);
            return;
        }
        const src = e.kind === 'payment' ? 'meta_pay' : 'mkt_other';
        const lines = e.kind === 'payment'
            ? [{ account: cfg().creditAccount || 'Meta Ads Payable', debit: e.amount }, { account: e.bank, credit: e.amount }]
            : [{ account: 'Other Marketing', debit: e.amount }, { account: e.bank, credit: e.amount }];
        try {
            acc.post({ date: e.date, memo: e.kind === 'payment' ? `Meta card charge / top-up${e.note ? ' — ' + e.note : ''}` : `${e.category}${e.note ? ' — ' + e.note : ''}`, source: src, source_id: String(id), lines }, e.user_id);
            q.run('UPDATE mkt_spend SET posted=1, error=NULL WHERE id=?', id);
        }
        catch (x) {
            q.run('UPDATE mkt_spend SET posted=0, error=? WHERE id=?', x.message, id);
        }
    }
    function postPending() {
        const { q } = ctx;
        for (const e of q.all('SELECT id FROM mkt_spend WHERE posted=0 ORDER BY id LIMIT 200'))
            postEntry(e.id);
        const c = cfg();
        if (!c.post || !accSvc())
            return;
        const from = c.postFrom || ctx.pkToday().slice(0, 8) + '01';
        const dates = q.all(`SELECT date FROM (SELECT DISTINCT date FROM mkt_daily UNION SELECT date FROM mkt_manual UNION SELECT date FROM mkt_posted) WHERE date>=? ORDER BY date`, from).map(r => r.date);
        for (const d of dates)
            postDay(d);
    }
    /* ---------- numbers ---------- */
    function stats(from, to) {
        const { q } = ctx;
        const ad = q.get(`SELECT COALESCE(SUM(spend_pkr),0) spend, COALESCE(SUM(purchases),0) purchases, COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks FROM mkt_daily WHERE date BETWEEN ? AND ?`, from, to);
        const man = q.get('SELECT COALESCE(SUM(amount),0) s FROM mkt_manual WHERE date BETWEEN ? AND ?', from, to).s;
        const o = q.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders WHERE date(created_at,'+5 hours') BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN ${CANCELLED}`, from, to);
        const d = q.get(`SELECT COUNT(*) dispatched, COALESCE(SUM(status='delivered'),0) delivered, COALESCE(SUM(status IN ${RETURNED}),0) returned,
      COALESCE(SUM(CASE WHEN status='delivered' THEN total-COALESCE(shipping,0) ELSE 0 END),0) net
    FROM orders WHERE dispatched_at IS NOT NULL AND date(dispatched_at,'+5 hours') BETWEEN ? AND ?`, from, to);
        const spend = r2(ad.spend + man);
        return { from, to, spend, manual: r2(man), metaPurchases: ad.purchases, impressions: ad.impressions, clicks: ad.clicks, orders: o.n, orderValue: o.v,
            cpo: o.n && spend ? r2(spend / o.n) : null, dispatched: d.dispatched, delivered: d.delivered, returned: d.returned, pending: d.dispatched - d.delivered - d.returned,
            deliveryRate: d.delivered + d.returned ? Math.round(1000 * d.delivered / (d.delivered + d.returned)) / 10 : null,
            cpd: d.delivered && spend ? r2(spend / d.delivered) : null, netSales: r2(d.net), roas: spend && d.delivered + d.returned ? Math.round(100 * d.net / spend) / 100 : null, gap: ad.purchases - o.n };
    }
    function campaigns(from, to) {
        const c = cfg(), avg = ctx.q.get('SELECT SUM(spend_pkr) s, SUM(purchases) p FROM mkt_daily WHERE date BETWEEN ? AND ?', from, to);
        const avgCpp = avg.p ? avg.s / avg.p : null, t = ctx.pkToday(), last3 = addDays(t, -2);
        return ctx.q.all(`SELECT account_id, campaign_id, MAX(campaign_name) name, SUM(spend) spend_raw, SUM(spend_pkr) spend, SUM(impressions) impressions, SUM(reach) reach, SUM(clicks) clicks,
      SUM(purchases) purchases, SUM(purchase_value) value, MAX(date) last_day, SUM(CASE WHEN date>=? THEN spend_pkr ELSE 0 END) spend3, SUM(CASE WHEN date>=? THEN purchases ELSE 0 END) purch3
    FROM mkt_daily WHERE date BETWEEN ? AND ? GROUP BY account_id, campaign_id HAVING SUM(spend)>0 OR SUM(impressions)>0 ORDER BY spend DESC`, last3, last3, from, to).map(r => {
            const cpp = r.purchases ? r2(r.spend / r.purchases) : null;
            let flag = 'ok', why = 'Normal';
            if (r.spend3 > (+c.zeroThreshold || 15000) && !r.purch3) {
                flag = 'bad';
                why = 'No sales in 3 days';
            }
            else if (r.spend > (+c.zeroThreshold || 15000) && !r.purchases) {
                flag = 'bad';
                why = 'No sales';
            }
            else if (cpp && avgCpp && cpp > avgCpp * 1.5) {
                flag = 'warn';
                why = 'Costly';
            }
            else if (cpp && avgCpp && cpp < avgCpp * 0.75) {
                flag = 'good';
                why = 'Best value';
            }
            if (r.last_day < addDays(t, -1)) {
                flag = flag === 'bad' ? 'bad' : 'muted';
                why = flag === 'bad' ? why : 'Not running';
            }
            return Object.assign(Object.assign({}, r), { spend: r2(r.spend), ctr: r.impressions ? Math.round(10000 * r.clicks / r.impressions) / 100 : null, cpp, metaRoas: r.spend_raw ? Math.round(100 * r.value / r.spend_raw) / 100 : null, flag, why });
        });
    }
    function daily(days) {
        const { q } = ctx, to = ctx.pkToday(), from = addDays(to, -(days - 1));
        const sp = Object.fromEntries(q.all('SELECT date, SUM(spend_pkr) s, SUM(purchases) p FROM mkt_daily WHERE date BETWEEN ? AND ? GROUP BY date', from, to).map(r => [r.date, r]));
        const man = Object.fromEntries(q.all('SELECT date, amount FROM mkt_manual WHERE date BETWEEN ? AND ?', from, to).map(r => [r.date, r.amount]));
        const od = Object.fromEntries(q.all(`SELECT date(created_at,'+5 hours') d, COUNT(*) n FROM orders WHERE date(created_at,'+5 hours') BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN ${CANCELLED} GROUP BY d`, from, to).map(r => [r.d, r.n]));
        const out = [];
        for (let d = from; d <= to; d = addDays(d, 1)) {
            const s = r2((sp[d] ? sp[d].s : 0) + (man[d] || 0)), o = od[d] || 0;
            out.push({ day: d, spend: s, orders: o, purchases: sp[d] ? sp[d].p : 0, cpo: o && s ? r2(s / o) : null });
        }
        return out;
    }
    function monthly(months) {
        const { q } = ctx, t = ctx.pkToday(), out = [];
        let y = +t.slice(0, 4), m = +t.slice(5, 7);
        for (let i = 0; i < months; i++) {
            const ym = `${y}-${String(m).padStart(2, '0')}`, from = ym + '-01', last = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
            const s = stats(from, last < t ? last : t);
            const other = q.get("SELECT COALESCE(SUM(amount),0) s FROM mkt_spend WHERE kind='other' AND date BETWEEN ? AND ?", from, last).s;
            const paid = q.get("SELECT COALESCE(SUM(amount),0) s FROM mkt_spend WHERE kind='payment' AND date BETWEEN ? AND ?", from, last).s;
            if (s.spend || s.orders || other)
                out.push(Object.assign(Object.assign({ month: ym }, s), { other, paid }));
            if (--m === 0) {
                m = 12;
                y--;
            }
        }
        return out;
    }
    const canSettings = u => ctx.can(u, 'settings') || (ctx.can(u, 'marketing') && ['admin', 'manager'].includes(u.role));
    const safeCfg = c => (Object.assign(Object.assign({}, c), { token: undefined, hasToken: !!c.token, tokenHint: c.token ? '••••' + c.token.slice(-4) : '', accountInfo: (c.accounts || []).map(a => { const r = acctRow(a) || {}; return { id: a, name: r.name || '', currency: r.currency || '', override: r.override || '', status: r.status || '', checked_at: r.checked_at || null, used: acctCur(c, a), rate: rateFor(c, acctCur(c, a)) }; }) }));
    module.exports = {
        name: 'marketing',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS mkt_daily(date TEXT NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT, spend REAL DEFAULT 0, spend_pkr REAL DEFAULT 0,
  impressions INTEGER DEFAULT 0, reach INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, purchases REAL DEFAULT 0, purchase_value REAL DEFAULT 0, synced_at TEXT, PRIMARY KEY(date, account_id, campaign_id));
CREATE INDEX IF NOT EXISTS ix_mkt_daily_date ON mkt_daily(date);
CREATE TABLE IF NOT EXISTS mkt_manual(date TEXT PRIMARY KEY, amount REAL NOT NULL, note TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS mkt_spend(id INTEGER PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, category TEXT, amount REAL NOT NULL, bank TEXT, note TEXT, file_id TEXT,
  user_id INTEGER, posted INTEGER DEFAULT 0, error TEXT, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_mkt_spend_date ON mkt_spend(date);
CREATE TABLE IF NOT EXISTS mkt_accounts(id TEXT PRIMARY KEY, name TEXT, currency TEXT, status TEXT, override TEXT, checked_at TEXT);
CREATE TABLE IF NOT EXISTS mkt_posted(date TEXT PRIMARY KEY, amount REAL, journal_id INTEGER, posted_at TEXT, error TEXT);`,
        migrate(c) {
            ctx = c;
            // older installs had one global currency: seed each saved account with it until Meta tells us the real one
            const k = cfg();
            for (const a of k.accounts || [])
                c.q.run('INSERT OR IGNORE INTO mkt_accounts(id,currency) VALUES(?,?)', a, k.currency || 'PKR');
        },
        activity: { 'marketing.settings': 'Changed Meta ads settings', 'marketing.sync': 'Synced Meta ad spend', 'marketing.manual': 'Entered daily ad spend', 'marketing.manual.delete': 'Deleted daily ad spend',
            'marketing.payment': 'Recorded Meta card payment', 'marketing.other': 'Recorded other marketing spend', 'marketing.entry.delete': 'Deleted marketing spend entry' },
        routes(c) {
            ctx = c;
            const { route, q, need, log } = c;
            c.services.marketing = {
                summary() {
                    const t = c.pkToday(), m = stats(t.slice(0, 8) + '01', t);
                    return { spendToday: stats(t, t).spend, spendMTD: m.spend, ordersMTD: m.orders, cpo: m.cpo, roas: m.roas, connected: connected() };
                },
                stats, daySpend, sync,
            };
            route('GET', '/api/marketing/settings', 'marketing', (req, u) => {
                need(canSettings(u), 'Only the owner or a manager can see Meta settings', 403);
                return { settings: safeCfg(cfg()), status: status(), banks: BANKS, accountsReady: !!accSvc() };
            });
            route('POST', '/api/marketing/settings', 'marketing', (req, u, b) => {
                need(canSettings(u), 'Only the owner or a manager can change Meta settings', 403);
                const cur = cfg(), n = Object.assign({}, cur);
                if (b.token != null && String(b.token).trim())
                    n.token = String(b.token).trim();
                if (b.clearToken)
                    n.token = '';
                if (b.accounts != null)
                    n.accounts = [...new Set((Array.isArray(b.accounts) ? b.accounts : String(b.accounts).split(/[\s,]+/)).map(normAct).filter(Boolean))];
                if (b.version) {
                    need(/^v\d+\.\d+$/.test(b.version), 'API version looks like v21.0');
                    n.version = b.version;
                }
                if (b.currency) {
                    need(['PKR', 'USD'].includes(b.currency), 'Currency must be PKR or USD');
                    n.currency = b.currency;
                }
                for (const k of ['fx', 'cardPct', 'dailyBudget', 'zeroThreshold'])
                    if (b[k] != null && b[k] !== '') {
                        need(isFinite(+b[k]) && +b[k] >= 0, k + ' must be a number');
                        n[k] = +b[k];
                    }
                if (b.overrides && typeof b.overrides === 'object')
                    for (const [a0, v] of Object.entries(b.overrides)) {
                        const a = normAct(a0), cur2 = String(v || '').toUpperCase();
                        need(!cur2 || /^[A-Z]{3}$/.test(cur2), 'Currency must be like PKR or USD');
                        q.run('INSERT INTO mkt_accounts(id,override) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET override=excluded.override', a, cur2 || null);
                    }
                for (const a of n.accounts)
                    q.run('INSERT OR IGNORE INTO mkt_accounts(id) VALUES(?)', a);
                need(n.accounts.every(a => acctCur(n, a) === 'PKR') || n.fx > 0, 'Enter the USD → PKR exchange rate');
                if (b.post != null)
                    n.post = !!b.post;
                if (b.creditAccount)
                    n.creditAccount = String(b.creditAccount).trim();
                if (b.postFrom != null) {
                    need(!b.postFrom || /^\d{4}-\d{2}-\d{2}$/.test(b.postFrom), 'Bad date');
                    n.postFrom = b.postFrom;
                }
                if (n.post && !cur.post && !n.postFrom)
                    n.postFrom = c.pkToday().slice(0, 8) + '01';
                c.setSetting('marketing', n);
                log(u.id, 'marketing.settings', 'meta', { accounts: n.accounts, currency: n.currency, post: n.post, tokenChanged: n.token !== cur.token });
                if (n.post)
                    try {
                        postPending();
                    }
                    catch (_a) { }
                return { ok: true, settings: safeCfg(n) };
            });
            route('POST', '/api/marketing/test', 'marketing', async (req, u, b) => {
                need(canSettings(u), 'Not allowed', 403);
                const k = cfg();
                if (b.token)
                    k.token = String(b.token).trim();
                if (b.accounts)
                    k.accounts = (Array.isArray(b.accounts) ? b.accounts : String(b.accounts).split(/[\s,]+/)).map(normAct).filter(Boolean);
                need(k.token, 'Paste the access token first');
                need(k.accounts.length, 'Add at least one ad account id (act_…)');
                try {
                    return { ok: true, accounts: await testConnection(k) };
                }
                catch (e) {
                    throw new c.HttpError(400, e.message);
                }
            });
            route('POST', '/api/marketing/sync', 'marketing', async (req, u, b) => {
                need(canSettings(u) || c.can(u, 'marketing'), 'Not allowed', 403);
                const days = Math.min(400, Math.max(1, +b.days || 3));
                try {
                    return await sync(days, u.id);
                }
                catch (e) {
                    throw new c.HttpError(400, e.message);
                }
            });
            route('GET', '/api/marketing/status', 'marketing', () => ({ connected: connected(), status: status(), running,
                log: q.all("SELECT at, ok, message FROM sync_log WHERE kind='meta' ORDER BY id DESC LIMIT 10"), lastData: (q.get('SELECT MAX(date) d, MAX(synced_at) s FROM mkt_daily') || {}) }));
            route('GET', '/api/marketing/dashboard', 'marketing', (req, u) => {
                const t = c.pkToday(), y = addDays(t, -1);
                return {
                    today: t, connected: connected(), status: status(), canSettings: canSettings(u), post: cfg().post,
                    periods: { today: stats(t, t), yesterday: stats(y, y), last7: stats(addDays(t, -6), t), month: stats(t.slice(0, 8) + '01', t) },
                    avg30: stats(addDays(t, -30), addDays(t, -1)), daily: daily(30), top: campaigns(addDays(t, -6), t).slice(0, 6), hasData: !!q.get('SELECT 1 FROM mkt_daily LIMIT 1') || !!q.get('SELECT 1 FROM mkt_manual LIMIT 1'),
                };
            });
            route('GET', '/api/marketing/campaigns', 'marketing', (req, u, b, res, p, qs) => {
                const t = c.pkToday();
                let from = qs.from, to = qs.to || t;
                if (!from)
                    from = qs.range === 'mtd' ? t.slice(0, 8) + '01' : addDays(t, -((+qs.days || 7) - 1));
                return { from, to, rows: campaigns(from, to), totals: stats(from, to), threshold: cfg().zeroThreshold };
            });
            route('GET', '/api/marketing/monthly', 'marketing', (req, u, b, res, p, qs) => monthly(Math.min(24, +qs.months || 12)));
            // manual daily spend (no token) + other marketing spend + Meta card payments
            route('GET', '/api/marketing/spend', 'marketing', (req, u, b, res, p, qs) => {
                const m = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : c.pkToday().slice(0, 7);
                return { month: m, banks: BANKS, cats: OTHER_CATS, connected: connected(), post: cfg().post, accountsReady: !!accSvc(),
                    manual: q.all('SELECT m.*, u.name user FROM mkt_manual m LEFT JOIN users u ON u.id=m.user_id WHERE substr(date,1,7)=? ORDER BY date DESC', m),
                    entries: q.all('SELECT s.*, u.name user FROM mkt_spend s LEFT JOIN users u ON u.id=s.user_id WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC', m),
                    posted: q.all('SELECT * FROM mkt_posted WHERE substr(date,1,7)=? ORDER BY date DESC', m),
                    meta: q.all('SELECT date, SUM(spend_pkr) spend FROM mkt_daily WHERE substr(date,1,7)=? GROUP BY date ORDER BY date DESC', m) };
            });
            const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d <= addDays(c.pkToday(), 1);
            route('POST', '/api/marketing/manual', 'marketing', (req, u, b) => {
                need(okDate(b.date), 'Pick a valid date (not in the future)');
                need(+b.amount > 0, 'Enter the amount in rupees');
                q.run(`INSERT INTO mkt_manual(date,amount,note,user_id) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET amount=excluded.amount, note=excluded.note, user_id=excluded.user_id, at=datetime('now')`, b.date, r2(b.amount), String(b.note || '').slice(0, 300), u.id);
                log(u.id, 'marketing.manual', 'mkt_manual:' + b.date, { amount: +b.amount });
                return { ok: true, posted: postDay(b.date) };
            });
            route('DELETE', '/api/marketing/manual/:date', 'marketing', (req, u, b, res, p) => {
                need(q.run('DELETE FROM mkt_manual WHERE date=?', p.date).changes, 'Not found', 404);
                log(u.id, 'marketing.manual.delete', 'mkt_manual:' + p.date, null);
                postDay(p.date);
                return { ok: true };
            });
            const addEntry = (kind, u, b) => {
                need(okDate(b.date), 'Pick a valid date');
                need(+b.amount > 0, 'Enter the amount in rupees');
                const bank = b.bank || 'Meezan (SB)';
                need(BANKS.includes(bank) || (kind === 'other' && bank === (cfg().creditAccount || 'Meta Ads Payable')), 'Paid from which account? ' + BANKS.join(', '));
                const cat = kind === 'payment' ? 'Meta payment' : (b.category || 'Other');
                const id = q.run('INSERT INTO mkt_spend(date,kind,category,amount,bank,note,file_id,user_id) VALUES(?,?,?,?,?,?,?,?)', b.date, kind, String(cat).slice(0, 60), r2(b.amount), bank, String(b.note || '').slice(0, 300), b.file || null, u.id).lastInsertRowid;
                log(u.id, 'marketing.' + kind, 'mkt_spend:' + id, { amount: +b.amount, category: cat, bank });
                postEntry(id);
                return q.get('SELECT * FROM mkt_spend WHERE id=?', id);
            };
            route('POST', '/api/marketing/payment', 'marketing', (req, u, b) => addEntry('payment', u, b));
            route('POST', '/api/marketing/other', 'marketing', (req, u, b) => addEntry('other', u, b));
            route('DELETE', '/api/marketing/entry/:id', 'marketing', (req, u, b, res, p) => {
                const e = q.get('SELECT * FROM mkt_spend WHERE id=?', +p.id);
                need(e, 'Not found', 404);
                const acc = accSvc();
                if (e.posted && acc && typeof acc.void === 'function') {
                    try {
                        acc.void(e.kind === 'payment' ? 'meta_pay' : 'mkt_other', String(e.id), u.id);
                    }
                    catch (x) {
                        need(false, 'Could not remove it from accounts: ' + x.message);
                    }
                }
                q.run('DELETE FROM mkt_spend WHERE id=?', e.id);
                log(u.id, 'marketing.entry.delete', 'mkt_spend:' + e.id, { amount: e.amount });
                return { ok: true };
            });
            route('POST', '/api/marketing/repost', 'marketing', (req, u) => { need(canSettings(u), 'Not allowed', 403); postPending(); return { ok: true, accountsReady: !!accSvc() }; });
        },
        jobs: [
            { name: 'meta-sync', every: 180, offset: 7, run: async (c) => { ctx = c; if (connected())
                    await sync(3, null).catch(() => { }); postPending(); } },
            { name: 'meta-post', every: 60, offset: 33, run: async (c) => { ctx = c; postPending(); } },
        ],
        alerts(u, c) {
            ctx = c;
            if (!c.can(u, 'marketing'))
                return [];
            const out = [], k = cfg(), st = status(), t = c.pkToday();
            if (connected(k)) {
                const lastOk = st.lastOk ? Date.parse(st.lastOk) : 0;
                if (st.lastError && (!lastOk || Date.parse(st.lastErrorAt) > lastOk))
                    out.push({ level: 'bad', text: 'Meta ad spend sync is failing: ' + st.lastError, href: '#/marketing/settings' });
                else if (!lastOk || Date.now() - lastOk > 24 * 3600e3)
                    out.push({ level: 'warn', text: 'No Meta ad spend received for more than 24 hours', href: '#/marketing/settings' });
            }
            const today = stats(t, t);
            if (+k.dailyBudget > 0 && today.spend > +k.dailyBudget)
                out.push({ level: 'warn', text: `Ad spend today ${Math.round(today.spend).toLocaleString('en-PK')} is above the daily budget of Rs ${(+k.dailyBudget).toLocaleString('en-PK')}`, href: '#/marketing' });
            const thr = +k.zeroThreshold || 15000;
            for (const r of c.q.all('SELECT MAX(campaign_name) name, SUM(spend_pkr) s FROM mkt_daily WHERE date>=? GROUP BY account_id, campaign_id HAVING SUM(spend_pkr)>? AND SUM(purchases)=0 ORDER BY s DESC LIMIT 5', addDays(t, -2), thr))
                out.push({ level: 'warn', text: `Campaign "${r.name}" spent Rs ${Math.round(r.s).toLocaleString('en-PK')} in 3 days with no purchases`, href: '#/campaigns' });
            const avg = stats(addDays(t, -30), addDays(t, -1));
            if (today.cpo && avg.cpo && today.orders >= 3 && today.cpo > 1.5 * avg.cpo)
                out.push({ level: 'warn', text: `Cost per order today Rs ${Math.round(today.cpo).toLocaleString('en-PK')} is more than 1.5× the 30-day average (Rs ${Math.round(avg.cpo).toLocaleString('en-PK')})`, href: '#/marketing' });
            return out;
        },
        _test: { pickPurchase, addDays },
    };
};