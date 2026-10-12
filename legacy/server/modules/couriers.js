    // Couriers: TCS (API booking, tracking, payments), PostEx (booked in Shopify, tracking entered/synced), own Karachi rider (runs, rider app, cash handover)
    'use strict';
    const http = require('http'), https = require('https');
    let ctx, q, setting, L;
    const PROD = 'https://ociconnect.tcscourier.com', SANDBOX = 'https://devconnect.tcscourier.com';
    const COURIERS = ['PostEx', 'TCS', 'Rider'];
    const FAIL_REASONS = { no_answer: 'Customer not answering', refused: 'Customer refused', wrong_address: 'Wrong address', later: 'Customer asked to come later', other: 'Other' };
    const BOOKABLE = ['confirmed', 'picked', 'packed'];
    const r2 = v => Math.round((+v || 0) * 100) / 100;
    const PKD = col => `date(${col},'+5 hours')`;
    const nowIso = () => new Date().toISOString();
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const monthEnd = m => addDays(addDays(m + '-01', 32).slice(0, 7) + '-01', -1);
    const bad = (msg, code = 400) => new ctx.HttpError(code, msg);
    const CK = `CASE WHEN lower(COALESCE(o.courier,'')) LIKE 'tcs%' THEN 'TCS' WHEN lower(COALESCE(o.courier,''))='rider' THEN 'Rider' ELSE 'PostEx' END`;
    /* ---------------- settings ---------------- */
    const tcsCfg = () => (Object.assign({ serviceCode: 'O', weight: 1 }, (setting('couriers_tcs', {}) || {})));
    const riderCfg = () => (Object.assign({ fee: 0, cashAccount: 'Cash', karachi: '' }, (setting('couriers_rider', {}) || {})));
    const tcsFee = () => +setting('couriers_tcs_fee', 250) || 0;
    const tcsConfigured = () => { const c = tcsCfg(); return !!((c.clientId && c.clientSecret) || (c.username && c.password)); };
    const baseUrl = () => String(process.env.TCS_BASE_URL || setting('tcs_base_url', '') || tcsCfg().baseUrl || (tcsCfg().sandbox ? SANDBOX : PROD)).replace(/\/+$/, '');
    const SECRET_KEYS = ['clientId', 'clientSecret', 'username', 'password'];
    const mask = (k, v) => !v ? '' : (k === 'clientSecret' || k === 'password') ? '••••••••' : '••••' + String(v).slice(-2);
    /* ---------------- small helpers ---------------- */
    // read a field whatever its capitalisation / spaces ("delivery charges", "consignmentNo", "accessToken")
    function pick(o, ...names) {
        if (!o || typeof o !== 'object')
            return undefined;
        const map = {};
        for (const k of Object.keys(o))
            map[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = o[k];
        for (const n of names) {
            const v = map[n.toLowerCase().replace(/[^a-z0-9]/g, '')];
            if (v !== undefined && v !== null && v !== '')
                return v;
        }
        return undefined;
    }
    const arr = v => Array.isArray(v) ? v : v ? [v] : [];
    const numOrNull = v => { if (v === undefined || v === null || v === '')
        return null; const n = +String(v).replace(/[^0-9.\-]/g, ''); return isNaN(n) ? null : n; };
    // TCS dates: ISO (with or without zone) or dd/MM/yyyy HH:mm(:ss) / dd-MM-yyyy; no zone = Pakistan time
    function parseTcsDate(s) {
        if (!s)
            return NaN;
        const t = String(s).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
            if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t))
                return Date.parse(t);
            return Date.parse(t.replace(' ', 'T').slice(0, 19) + (t.length <= 10 ? 'T00:00:00' : '') + '+05:00');
        }
        const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(t);
        if (m) {
            let hh = +(m[4] || 0);
            if (m[7] && /pm/i.test(m[7]) && hh < 12)
                hh += 12;
            if (m[7] && /am/i.test(m[7]) && hh === 12)
                hh = 0;
            return Date.parse(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${String(hh).padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}+05:00`);
        }
        return Date.parse(t);
    }
    const pkYmd = ms => new Date(ms + 5 * 3600e3).toISOString().slice(0, 10);
    const toYmd = s => { const ms = parseTcsDate(s); return isNaN(ms) ? null : pkYmd(ms); };
    const normCity = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const ALIAS = { khi: 'karachi', lhr: 'lahore', isb: 'islamabad', isl: 'islamabad', rwp: 'rawalpindi', pindi: 'rawalpindi', fsd: 'faisalabad', lyallpur: 'faisalabad', mux: 'multan', pew: 'peshawar', hyd: 'hyderabad', grw: 'gujranwala', skt: 'sialkot', qta: 'quetta' };
    function lev(a, b) { const m = a.length, n = b.length; if (!m || !n)
        return m + n; let p = Array.from({ length: n + 1 }, (_, i) => i); for (let i = 1; i <= m; i++) {
        const c = [i];
        for (let j = 1; j <= n; j++)
            c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        p = c;
    } return p[n]; }
    function isKarachi(city) {
        const n = normCity(city);
        if (!n)
            return false;
        const extra = String(riderCfg().karachi || '').split(',').map(normCity).filter(Boolean);
        return n.includes('karachi') || n === 'khi' || extra.some(x => n === x || n.includes(x));
    }
    const orderName = o => String(o.name || o.id).replace(/^#/, '');
    const riderTracking = o => 'RIDER-' + orderName(o);
    function employeeParty(userId) {
        try {
            const e = q.get('SELECT id FROM hr_employees WHERE user_id=? ORDER BY id LIMIT 1', userId);
            if (e)
                return 'employee:' + e.id;
        }
        catch (_a) { }
        return 'employee:u' + userId;
    }
    /* ---------------- TCS API ---------------- */
    // TCS documents several calls as GET with a JSON body. Node's fetch cannot send that, so a small https.request does; POST is tried when TCS refuses.
    function rawReq(method, url, body, headers = {}) {
        return new Promise((resolve, reject) => {
            const u = new URL(url), lib = u.protocol === 'http:' ? http : https;
            const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const req = lib.request(u, { method, timeout: 30000, headers: Object.assign(Object.assign({ Accept: 'application/json' }, (data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})), headers) }, res => {
                const ch = [];
                res.on('data', c => ch.push(c));
                res.on('end', () => { const text = Buffer.concat(ch).toString(); let json = null; try {
                    json = text ? JSON.parse(text) : null;
                }
                catch (_a) { } resolve({ status: res.statusCode, text, json }); });
            });
            req.on('timeout', () => req.destroy(new Error('TCS did not answer within 30 seconds')));
            req.on('error', e => reject(new Error('Cannot reach TCS (' + (e.code || e.message) + ')')));
            if (data)
                req.write(data);
            req.end();
        });
    }
    const tok = { sig: '', b: null, bExp: 0, a: null, aExp: 0 };
    const methodFor = {};
    function tcsError(j, status) {
        if (!j)
            return status ? 'TCS answered ' + status : 'TCS sent an empty answer';
        const e = arr(pick(j, 'error', 'errors')).map(x => typeof x === 'object' ? (pick(x, 'errorname', 'message', 'error') || JSON.stringify(x)) : x).filter(Boolean);
        const msg = pick(j, 'message', 'shipmentsummary', 'statusMessage');
        return [e.join('; '), typeof msg === 'string' ? msg : ''].filter(Boolean).join(' · ') || ('TCS answered ' + (status || '?'));
    }
    async function getish(path, body, headers) {
        let r = await rawReq(methodFor[path] || 'GET', baseUrl() + path, body, headers);
        if ((methodFor[path] || 'GET') === 'GET' && (r.status === 404 || r.status === 405 || r.status === 411 || r.status === 415 || (r.status >= 400 && r.status !== 401 && !r.json))) {
            const p = await rawReq('POST', baseUrl() + path, body, headers);
            if (p.status < 400 || p.json) {
                methodFor[path] = 'POST';
                r = p;
            }
        }
        return r;
    }
    function resetTokens() { const c = tcsCfg(), sig = [c.clientId, c.clientSecret, c.username, c.password, baseUrl()].join('|'); if (sig !== tok.sig)
        Object.assign(tok, { sig, b: null, bExp: 0, a: null, aExp: 0 }); }
    async function bearer() {
        resetTokens();
        const c = tcsCfg();
        if (!(c.clientId && c.clientSecret))
            return null;
        if (tok.b && Date.now() < tok.bExp - 60e3)
            return tok.b;
        const r = await getish('/auth/api/auth', { clientid: String(c.clientId), clientsecret: String(c.clientSecret) });
        const res = (r.json && (pick(r.json, 'result') || r.json)) || {};
        const t = pick(res, 'accessToken', 'access_token', 'token');
        if (!t)
            throw new Error('TCS login failed (client ID / secret): ' + tcsError(r.json, r.status));
        tok.b = t;
        tok.bExp = parseTcsDate(pick(res, 'expiry', 'expires')) || (Date.now() + 3600e3);
        if (isNaN(tok.bExp))
            tok.bExp = Date.now() + 3600e3;
        return t;
    }
    async function accessToken() {
        resetTokens();
        const c = tcsCfg();
        if (!(c.username && c.password))
            throw new Error('Add the TCS username and password in Couriers → Settings');
        if (tok.a && Date.now() < tok.aExp - 60e3)
            return tok.a;
        const r = await getish('/ecom/api/authentication/token', { username: String(c.username), password: String(c.password) });
        const j = r.json || {}, res = pick(j, 'result') && typeof pick(j, 'result') === 'object' ? pick(j, 'result') : j;
        const t = pick(res, 'accesstoken', 'accessToken', 'token');
        if (!t)
            throw new Error('TCS login failed (username / password): ' + tcsError(r.json, r.status));
        tok.a = t;
        tok.aExp = parseTcsDate(pick(res, 'expiry', 'expires'));
        if (isNaN(tok.aExp))
            tok.aExp = Date.now() + 3600e3;
        return t;
    }
    // one TCS call; body may be an async function (so a retry after 401 gets a fresh access token)
    async function tcsCall(method, path, body, retried) {
        if (!tcsConfigured())
            throw new Error('TCS is not connected. Add the TCS login in Couriers → Settings.');
        const b = typeof body === 'function' ? await body() : body;
        const bt = await bearer(), headers = bt ? { Authorization: 'Bearer ' + bt } : {};
        const r = method === 'GET' ? await getish(path, b, headers) : await rawReq(method, baseUrl() + path, b, headers);
        const unauth = r.status === 401 || (r.json && (String(pick(r.json, 'code')) === '401' || /unauthori[sz]ed/i.test(String(pick(r.json, 'status') || ''))));
        if (unauth && !retried) {
            tok.b = null;
            tok.a = null;
            return tcsCall(method, path, body, true);
        }
        if (unauth)
            throw new Error('TCS refused the login (401). Check the TCS settings.');
        if (r.status >= 500 || (r.status >= 400 && !r.json))
            throw new Error(tcsError(r.json, r.status));
        return r.json || {};
    }
    function shipDate() { const s = ctx.pkNow(); return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 19)}`; }
    const mobile11 = p => { const n = L.normPhone(p); return n.length === 11 ? n : n.slice(-11); };
    async function tcsBook(o, code, opts = {}) {
        const c = tcsCfg();
        for (const [k, l] of [['account', 'TCS account number'], ['costCenter', 'cost centre code'], ['shipperName', 'shipper name'], ['shipperAddress', 'shipper address'], ['shipperCity', 'shipper city'], ['shipperMobile', 'shipper mobile']])
            if (!c[k])
                throw new Error(`Add the ${l} in Couriers → Settings`);
        const city = q.get('SELECT code, name FROM cr_tcs_cities WHERE code=?', code) || { code, name: o.city };
        const sc = matchCity(c.shipperCity);
        const items = q.all('SELECT title, qty, price, sku FROM order_items WHERE order_id=?', o.id);
        const weight = Math.max(0.5, +opts.weight || +c.weight || 1), pieces = Math.max(1, Math.round(+opts.pieces || 1));
        const cod = Math.max(0, Math.round(opts.cod != null ? +opts.cod : +o.total || 0));
        const name = String(o.cust_name || 'Customer').trim().split(/\s+/);
        const nItems = Math.max(1, items.reduce((s, i) => s + (i.qty || 1), 0));
        const body = async () => ({
            accesstoken: await accessToken(), consignmentno: '',
            shipperinfo: { tcsaccount: String(c.account), shippername: c.shipperName, address1: c.shipperAddress, address2: '', address3: '', zip: '', countrycode: 'PK', countryname: 'Pakistan', cityname: sc.name || c.shipperCity, citycode: c.shipperCityCode || sc.code || '', mobile: mobile11(c.shipperMobile) },
            consigneeinfo: { consigneecode: '', firstname: name[0], middlename: '', lastname: name.slice(1).join(' ') || '.', address1: String(o.address || o.city || '').slice(0, 250) || o.city, address2: '', address3: '', zip: '', countrycode: 'PK', countryname: 'Pakistan', citycode: city.code, cityname: city.name, email: '', mobile: mobile11(o.phone) },
            vendorinfo: { name: '', address1: '', address2: '', address3: '', citycode: '', cityname: '', mobile: '' },
            shipmentinfo: { costcentercode: String(c.costCenter), referenceno: orderName(o), contentdesc: 'Shoes', servicecode: c.serviceCode || 'O', parametertype: '', shipmentdate: shipDate(), shippingtype: '', currency: 'PKR', codamount: cod,
                declaredvalue: cod, insuredvalue: 0, weightinkg: weight, pieces, fragile: false, remarks: String(opts.remarks || 'Handle with care. Call before delivery.').slice(0, 200), skus: (items.length ? items : [{ title: 'Shoes', qty: 1, price: cod }]).map(i => ({ description: String(i.title || i.sku || 'Shoes').slice(0, 100), quantity: i.qty || 1, weight: Math.max(0.5, r2(weight / nItems)), uom: 'KG', unitprice: Math.max(1, Math.round(i.price || 1)), declaredvalue: Math.max(1, Math.round(i.price || 1)), insuredvalue: 0 })) },
        });
        const j = await tcsCall('POST', '/ecom/api/booking/create', body);
        const cn = pick(j, 'consignmentNo', 'consignmentnumber', 'cn', 'cnno');
        if (!cn)
            throw new Error('TCS booking failed: ' + tcsError(j));
        return String(cn);
    }
    async function tcsCancel(cn) {
        const j = await tcsCall('POST', '/ecom/api/booking/cancel', async () => ({ consignmentNumber: /^\d+$/.test(cn) ? +cn : cn, accesstoken: await accessToken() }));
        const m = String(pick(j, 'message') || '');
        if (!/success/i.test(m))
            throw new Error('TCS did not cancel: ' + tcsError(j));
        return true;
    }
    // latest checkpoint wins (by time; ties: delivery info over checkpoints)
    function parseTrack(j, cn) {
        const ev = [];
        const mine = x => { const c = pick(x, 'consignmentno', 'consignmentNumber', 'cn'); return !c || String(c) === String(cn); };
        for (const d of arr(pick(j, 'deliveryinfo')))
            if (mine(d))
                ev.push({ at: pick(d, 'datetime', 'dateTime', 'date'), status: String(pick(d, 'status') || ''), code: pick(d, 'code') || '', place: pick(d, 'station') || '', by: pick(d, 'recievedby', 'receivedby') || '', k: 1 });
        for (const c of arr(pick(j, 'checkpoints')))
            if (mine(c))
                ev.push({ at: pick(c, 'datetime', 'dateTime', 'date'), status: String(pick(c, 'status') || ''), code: '', place: pick(c, 'recievedby', 'receivedby', 'station') || '', k: 0 });
        const t = e => { const v = parseTcsDate(e.at); return isNaN(v) ? 0 : v; };
        return ev.filter(e => e.status).sort((a, b) => t(a) - t(b) || a.k - b.k).map(e => (Object.assign(Object.assign({}, e), { ms: t(e) })));
    }
    async function tcsTrack(o) {
        const j = await tcsCall('GET', '/tracking/api/Tracking/GetDynamicTrackDetail', { consignee: [String(o.tracking)] });
        const ev = parseTrack(j, o.tracking);
        if (!ev.length) {
            if (pick(j, 'message') === 'FAIL')
                throw new Error(`${o.tracking}: ${tcsError(j)}`);
            return false;
        }
        const last = ev[ev.length - 1];
        let text = last.status;
        if (String(last.code).toUpperCase() === 'OK' && !/deliver/i.test(text))
            text = 'Delivered (' + text + ')';
        q.run('UPDATE orders SET courier_status=?, courier_updated=?, courier_history=? WHERE id=?', text, last.ms ? new Date(last.ms).toISOString() : nowIso(), JSON.stringify(ev.slice(-20).map(e => ({ at: e.at, status: e.status, code: e.code || undefined, place: e.place || undefined }))), o.id);
        L.refreshOrder(o.id);
        return true;
    }
    function applyPayment(row) {
        const cn = String(pick(row, 'cnbycourier', 'consignmentno', 'consignmentnumber', 'cn', 'cnno') || '').trim();
        if (!cn)
            return false;
        const o = q.get(`SELECT * FROM orders o WHERE tracking=? AND ${CK}='TCS'`, cn);
        if (!o)
            return false;
        const fee = numOrNull(pick(row, 'deliverycharges', 'charges')), paid = numOrNull(pick(row, 'amountpaid', 'paidamount')), pdate = toYmd(pick(row, 'paymentdate'));
        const pst = String(pick(row, 'paymentstatus') || ''), cst = String(pick(row, 'cnstatus') || '');
        const isPaid = (/paid|settled|transfer|processed|cleared/i.test(pst) && !/un ?paid|not|pending|due/i.test(pst)) || (!pst && paid > 0 && !!pdate);
        if (cst && !o.courier_status)
            q.run('UPDATE orders SET courier_status=? WHERE id=?', cst, o.id);
        q.run('UPDATE orders SET courier_fee=COALESCE(?,courier_fee) WHERE id=?', fee, o.id);
        L.refreshOrder(o.id);
        const st = q.get('SELECT status FROM orders WHERE id=?', o.id).status;
        if (isPaid && st === 'delivered')
            q.run(`UPDATE orders SET courier_paid=COALESCE(?,courier_paid), settled=1, settled_at=COALESCE(?,settled_at,?), courier_settled_at=COALESCE(?,courier_settled_at,?), settle_ref=COALESCE(settle_ref,?) WHERE id=?`, paid, pdate, ctx.pkToday(), pdate, ctx.pkToday(), 'TCS' + (pdate ? ' ' + pdate : ''), o.id);
        return true;
    }
    async function tcsPaymentStatus(o) {
        const c = tcsCfg();
        const j = await tcsCall('GET', '/ecom/api/Payment/status', async () => ({ accesstoken: await accessToken(), customerno: /^\d+$/.test(String(c.customerNo)) ? +c.customerNo : c.customerNo, consignmentno: /^\d+$/.test(o.tracking) ? +o.tracking : o.tracking }));
        let n = 0;
        for (const d of arr(pick(j, 'detail')))
            if (applyPayment(Object.assign({ cn: o.tracking }, d)))
                n++;
        return n;
    }
    async function syncCities() {
        const j = await tcsCall('GET', '/ecom/api/setup/citylistbycountry', { countrycode: ['PK'] });
        const list = arr(pick(j, 'data', 'result', 'cities', 'citylist'));
        if (!list.length)
            throw new Error('TCS city list is empty: ' + tcsError(j));
        q.tx(() => { q.run('DELETE FROM cr_tcs_cities'); for (const c of list) {
            const code = String(pick(c, 'citycode', 'code') || ''), name = String(pick(c, 'cityname', 'name') || '');
            if (code && name)
                q.run('INSERT OR REPLACE INTO cr_tcs_cities(code,name,norm) VALUES(?,?,?)', code, name, normCity(name));
        } });
        ctx.setSetting('couriers_tcs_cities_at', ctx.pkNow());
        return q.get('SELECT COUNT(*) n FROM cr_tcs_cities').n;
    }
    function matchCity(city) {
        let n = normCity(city);
        n = ALIAS[n] || n;
        if (!n)
            return { code: null, name: null, sure: false, options: [] };
        const al = q.get('SELECT a.code, c.name FROM cr_city_alias a LEFT JOIN cr_tcs_cities c ON c.code=a.code WHERE a.city=?', n);
        if (al)
            return { code: al.code, name: al.name || city, sure: true, options: [] };
        const all = q.all('SELECT code, name, norm FROM cr_tcs_cities');
        const ex = all.find(c => c.norm === n);
        if (ex)
            return { code: ex.code, name: ex.name, sure: true, options: [] };
        const cand = all.map(c => (Object.assign(Object.assign({}, c), { d: lev(n, c.norm), part: c.norm.startsWith(n) || n.startsWith(c.norm) || (n.length >= 4 && c.norm.includes(n)) })))
            .filter(c => c.part || (n.length >= 4 && c.d <= 2)).sort((a, b) => (b.part - a.part) || a.d - b.d).slice(0, 6);
        return { code: cand[0] ? cand[0].code : null, name: cand[0] ? cand[0].name : null, sure: false, options: cand.map(c => ({ code: c.code, name: c.name })) };
    }
    /* ---------------- sync jobs ---------------- */
    async function syncTrack(limit = 300) {
        const open = q.all(`SELECT * FROM orders o WHERE ${CK}='TCS' AND tracking IS NOT NULL AND cancelled_at IS NULL AND status IN (${L.OPEN_SHIP.map(() => '?').join(',')}) ORDER BY dispatched_at DESC LIMIT ?`, ...L.OPEN_SHIP, limit);
        let n = 0;
        const errors = [];
        for (let i = 0; i < open.length; i += 4)
            await Promise.all(open.slice(i, i + 4).map(o => tcsTrack(o).then(x => { if (x)
                n++; }).catch(e => errors.push(e.message))));
        const uniq = [...new Set(errors)].slice(0, 3), ok = !uniq.length || n > 0;
        ctx.syncLog('tcs', ok && !(uniq.length && !n), `tracking: ${n} of ${open.length} parcels updated` + (uniq.length ? ' · errors: ' + uniq.join(' | ') : ''));
        ctx.setSetting('couriers_tcs_track_at', ctx.pkNow());
        return { checked: open.length, updated: n, errors: uniq };
    }
    async function syncPayments(days = 60) {
        const c = tcsCfg();
        if (!c.customerNo)
            throw new Error('Add the TCS customer number in Couriers → Settings');
        const to = ctx.pkToday(), from = addDays(to, -days);
        const j = await tcsCall('GET', '/ecom/api/Payment/detail', async () => ({ accesstoken: await accessToken(), customerno: /^\d+$/.test(String(c.customerNo)) ? +c.customerNo : c.customerNo, fromdate: from, todate: to }));
        const rows = arr(pick(j, 'detail', 'data'));
        let n = 0;
        q.tx(() => { for (const r of rows)
            if (applyPayment(r))
                n++; });
        // delivered parcels the report did not cover: ask one by one (capped)
        const errors = [];
        const left = q.all(`SELECT * FROM orders o WHERE ${CK}='TCS' AND status='delivered' AND settled=0 AND tracking IS NOT NULL ORDER BY delivered_at LIMIT 40`);
        for (const o of left) {
            try {
                n += await tcsPaymentStatus(o);
            }
            catch (e) {
                errors.push(e.message);
            }
        }
        const uniq = [...new Set(errors)].slice(0, 2);
        ctx.syncLog('tcs', true, `payments: ${rows.length} rows from TCS, ${n} parcels updated` + (uniq.length ? ' · ' + uniq.join(' | ') : ''));
        ctx.setSetting('couriers_tcs_pay_at', ctx.pkNow());
        return { rows: rows.length, updated: n, errors: uniq };
    }
    /* ---------------- booking ---------------- */
    function setBooked(o, courier, tracking, extra = {}) {
        var _a, _b;
        const now = nowIso(), keepPx = courier === 'PostEx';
        q.run(`UPDATE orders SET courier=?, tracking=?, bk_courier=?, bk_tracking=?, bk_via=?, courier_status=?, courier_updated=?, courier_history=NULL, courier_cod=?, cod=COALESCE(?,cod), city_code=COALESCE(?,city_code),
      rider_id=?, rider_run_id=?, dispatched_at=COALESCE(dispatched_at,?), px_status=CASE WHEN ? THEN px_status ELSE NULL END, px_updated=CASE WHEN ? THEN px_updated ELSE NULL END WHERE id=?`, courier, tracking, courier, tracking, extra.via || null, extra.status || null, extra.status ? now : null, (_a = extra.cod) !== null && _a !== void 0 ? _a : null, (_b = extra.setCod) !== null && _b !== void 0 ? _b : null, extra.city_code || null, extra.rider_id || null, extra.run_id || null, now, keepPx ? 1 : 0, keepPx ? 1 : 0, o.id);
        L.refreshOrder(o.id);
    }
    function clearBooking(o) {
        q.run(`UPDATE orders SET courier=NULL, tracking=NULL, bk_courier=NULL, bk_tracking=NULL, bk_via=NULL, courier_status=NULL, courier_updated=NULL, courier_history=NULL, courier_cod=NULL, rider_id=NULL, rider_run_id=NULL, dispatched_at=NULL, delivered_at=NULL,
      px_status=NULL, px_updated=NULL, px_history=NULL WHERE id=?`, o.id);
        L.refreshOrder(o.id);
    }
    const getOrder = code => { const c = String(code || '').trim(); return c ? q.get('SELECT * FROM orders WHERE id=? OR name=? OR name=? OR name=? OR tracking=?', c, c, c.toUpperCase(), '#' + c.replace(/^#/, ''), c) : null; };
    /* ---------------- rider runs ---------------- */
    const runRow = id => q.get('SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.id=?', id);
    function openItem(orderId) { return q.get(`SELECT i.*, r.status run_status FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.order_id=? AND r.status<>'closed' ORDER BY i.id DESC LIMIT 1`, orderId); }
    function addToRun(run, o, u, force, codOverride) {
        if (!o)
            return { error: 'Order not found' };
        const nm = o.name || o.id;
        if (run.status === 'closed')
            return { error: 'This run is closed' };
        if (o.cancelled_at || ['cancelled', 'cs_cancelled', 'courier_cancelled'].includes(o.status))
            return { error: `${nm} is cancelled` };
        const ex = openItem(o.id);
        if (ex)
            return { error: ex.run_id === run.id ? `${nm} is already in this run` : `${nm} is already in rider run #${ex.run_id}` };
        const rider = L.courierKey(o.courier) === 'Rider' && o.tracking;
        if (o.tracking && !rider)
            return { error: `${nm} is already booked with ${o.courier || 'a courier'} (${o.tracking})` };
        if (rider ? o.status !== 'attempted' : !BOOKABLE.includes(o.status))
            return { error: `${nm} is "${L.STATUS[o.status] || o.status}" — only confirmed / packed orders (or rider parcels kept for another try) can go on a run` };
        if (!rider && packGate(o))
            return { error: packGate(o), notPacked: true };
        if (!isKarachi(o.city) && !force)
            return { warn: `${nm} is for ${o.city || 'an unknown city'}, not Karachi. Add anyway?`, order: nm };
        const cod = codOverride != null && codOverride >= 0 ? Math.round(+codOverride) : rider && o.courier_cod != null ? o.courier_cod : (o.total || 0);
        const seq = (q.get('SELECT MAX(seq) m FROM cr_run_items WHERE run_id=?', run.id).m || 0) + 1;
        q.run('INSERT INTO cr_run_items(run_id,order_id,seq,cod) VALUES(?,?,?,?)', run.id, o.id, seq, cod);
        setBooked(o, 'Rider', riderTracking(o), { status: run.status === 'out' ? 'Out for delivery' : 'Assigned to rider', cod, setCod: codOverride != null && codOverride >= 0 ? cod : null, rider_id: run.rider_id, run_id: run.id });
        ctx.log(u.id, 'couriers.run.add', 'order:' + o.id, { run: run.id, rider: run.rider_id });
        return { ok: true, order: nm };
    }
    function createRun(riderId, dayStr, u, note) {
        const r = q.get('SELECT id, name, role, perms, active FROM users WHERE id=?', +riderId);
        if (!r || !r.active || !ctx.A.userPerms(r).includes('rider'))
            throw bad('Choose a rider (a staff login with the Rider role)');
        const d = isDate(dayStr) ? dayStr : ctx.pkToday();
        const id = Number(q.run('INSERT INTO cr_runs(day,rider_id,status,note,created_by) VALUES(?,?,?,?,?)', d, r.id, 'open', note || null, u.id).lastInsertRowid);
        ctx.log(u.id, 'couriers.run', 'rider_run:' + id, { rider: r.id, day: d });
        return runRow(id);
    }
    const riderStatusText = (res, b) => res === 'delivered' ? 'Delivered' : res === 'failed' ? 'Failed: ' + (FAIL_REASONS[b.reason] || 'Other') : res === 'rescheduled' ? 'Rescheduled to ' + b.date : null;
    function setResult(item, u, b) {
        const run = runRow(item.run_id);
        if (run.status === 'closed' || q.get('SELECT id FROM cr_handovers WHERE run_id=?', run.id))
            throw bad('Cash for this run is already handed over — ask the office to change it');
        const o = q.get('SELECT * FROM orders WHERE id=?', item.order_id);
        const res = b.result, now = nowIso();
        if (res === 'undo') {
            q.run('UPDATE cr_run_items SET result=NULL, collected=NULL, reason=NULL, note=NULL, resched_to=NULL, at=NULL, by_user=NULL WHERE id=?', item.id);
            q.run('UPDATE orders SET courier_status=?, courier_updated=?, delivered_at=NULL, cod=? WHERE id=?', run.status === 'out' ? 'Out for delivery' : 'Assigned to rider', now, item.cod, o.id);
            L.refreshOrder(o.id);
            ctx.log(u.id, 'rider.undo', 'order:' + o.id, { run: run.id });
            return { ok: true };
        }
        if (!['delivered', 'failed', 'rescheduled'].includes(res))
            throw bad('Choose Delivered, Failed or Rescheduled');
        let collected = null;
        if (res === 'delivered') {
            collected = b.collected === undefined || b.collected === null || b.collected === '' ? item.cod : +b.collected;
            if (!(collected >= 0))
                throw bad('Enter the cash collected');
        }
        if (res === 'failed' && !FAIL_REASONS[b.reason])
            throw bad('Choose why the delivery failed');
        if (res === 'failed' && b.reason === 'other' && !String(b.note || '').trim())
            throw bad('Write what happened');
        if (res === 'rescheduled' && !isDate(b.date))
            throw bad('Choose the new delivery date');
        q.tx(() => {
            q.run('UPDATE cr_run_items SET result=?, collected=?, reason=?, note=?, resched_to=?, at=?, by_user=? WHERE id=?', res, collected, res === 'failed' ? b.reason : null, String(b.note || '').slice(0, 300) || null, res === 'rescheduled' ? b.date : null, ctx.pkNow(), u.id, item.id);
            if (run.status === 'open') {
                q.run("UPDATE cr_runs SET status='out', out_at=COALESCE(out_at,?) WHERE id=?", ctx.pkNow(), run.id);
                q.run(`UPDATE orders SET courier_status='Out for delivery' WHERE rider_run_id=? AND courier_status='Assigned to rider'`, run.id);
            }
            q.run('UPDATE orders SET courier_status=?, courier_updated=?, delivered_at=CASE WHEN ?=\'delivered\' THEN delivered_at ELSE NULL END, cod=? WHERE id=?', riderStatusText(res, b), now, res, res === 'delivered' ? collected : item.cod, o.id);
            L.refreshOrder(o.id);
        });
        ctx.log(u.id, 'rider.' + res, 'order:' + o.id, { run: run.id, collected, reason: b.reason || null, date: b.date || null, note: b.note || null });
        return { ok: true };
    }
    function runItems(runId) {
        return q.all(`SELECT i.*, o.name, o.cust_name, o.phone, o.address, o.city, o.total, o.status, o.items, o.tracking,
      (SELECT group_concat(title, ' + ') FROM order_items WHERE order_id=o.id) items_text, u.name by_name FROM cr_run_items i JOIN orders o ON o.id=i.order_id LEFT JOIN users u ON u.id=i.by_user WHERE i.run_id=? ORDER BY i.seq`, runId);
    }
    function runSummary(items) {
        const s = { parcels: items.length, delivered: 0, failed: 0, rescheduled: 0, pending: 0, cod: 0, collected: 0, deliveredValue: 0 };
        for (const i of items) {
            s.cod += i.cod || 0;
            if (!i.result)
                s.pending++;
            else
                s[i.result]++;
            if (i.result === 'delivered') {
                s.collected += i.collected || 0;
                s.deliveredValue += i.total || 0;
            }
        }
        s.cod = r2(s.cod);
        s.collected = r2(s.collected);
        s.deliveredValue = r2(s.deliveredValue);
        return s;
    }
    function handover(run, u, b) {
        if (run.status === 'closed' || q.get('SELECT id FROM cr_handovers WHERE run_id=?', run.id))
            throw bad('Cash for this run was already received');
        const items = runItems(run.id), s = runSummary(items);
        if (!items.length)
            throw bad('This run has no parcels');
        const counted = +b.counted;
        if (b.counted === '' || b.counted == null || !(counted >= 0))
            throw bad('Enter the cash you counted');
        const diff = r2(counted - s.collected);
        if (diff && !String(b.note || '').trim())
            throw bad(diff < 0 ? 'Cash is short: write a note (what the rider said)' : 'Cash is more than expected: write a note');
        const treat = b.treat === 'recover' ? 'recover' : 'expense';
        const back = b.back || {};
        const today = ctx.pkToday(), cfgR = riderCfg();
        const A = ctx.services.accounts;
        return q.tx(() => {
            const hid = Number(q.run('INSERT INTO cr_handovers(run_id,rider_id,day,expected,counted,diff,treat,note,user_id) VALUES(?,?,?,?,?,?,?,?,?)', run.id, run.rider_id, today, s.collected, counted, diff, diff < 0 ? treat : null, String(b.note || '').slice(0, 300) || null, u.id).lastInsertRowid);
            let posted = null;
            if (A && (counted || s.deliveredValue)) {
                const disc = r2(s.deliveredValue - s.collected), short = diff < 0 ? -diff : 0, excess = diff > 0 ? diff : 0;
                const lines = [{ account: cfgR.cashAccount || 'Cash', debit: counted, memo: 'Cash counted' }, { account: 'Rider Cash', credit: s.deliveredValue, party: 'courier:Rider', memo: `${s.delivered} parcels delivered` }];
                if (disc > 0)
                    lines.push({ account: 'Discount Allowed', debit: disc, memo: 'Customers paid less than the order total' });
                if (disc < 0)
                    lines.push({ account: 'Other Income', credit: -disc, memo: 'Customers paid more than the order total' });
                if (short)
                    lines.push(treat === 'recover' ? { account: 'Employees Advance', debit: short, party: employeeParty(run.rider_id), memo: 'Rider cash short — to recover' } : { account: 'Miscellenious Exp', debit: short, memo: 'Rider cash short' });
                if (excess)
                    lines.push({ account: 'Other Income', credit: excess, memo: 'Rider cash excess' });
                posted = A.post({ date: today, memo: `Rider cash handover — run #${run.id} (${run.rider || 'rider'}, ${run.day})`, source: 'rider-handover', source_id: String(run.id), lines }, u.id);
                q.run('UPDATE cr_handovers SET journal_id=? WHERE id=?', posted, hid);
            }
            for (const i of items) {
                if (i.result === 'delivered') {
                    q.run(`UPDATE orders SET settled=1, settled_at=?, courier_settled_at=?, settle_ref=? WHERE id=?`, today, today, 'RIDER-H' + hid, i.order_id);
                    continue;
                }
                const how = back[i.id] || (i.result === 'rescheduled' ? 'kept' : 'returned');
                if (!i.result)
                    q.run("UPDATE cr_run_items SET result='failed', reason='other', note=COALESCE(note,'Not attempted'), at=? WHERE id=?", ctx.pkNow(), i.id);
                q.run('UPDATE cr_run_items SET back=?, back_at=?, back_by=? WHERE id=?', how === 'kept' ? 'kept' : 'returned', ctx.pkNow(), u.id, i.id);
                if (how === 'kept') {
                    if (!i.result)
                        q.run("UPDATE orders SET courier_status='Failed: Not attempted', courier_updated=? WHERE id=?", nowIso(), i.order_id);
                }
                else
                    q.run("UPDATE orders SET courier_status='Returned to office', courier_updated=? WHERE id=?", nowIso(), i.order_id);
                L.refreshOrder(i.order_id);
            }
            q.run("UPDATE cr_runs SET status='closed', closed_at=? WHERE id=?", ctx.pkNow(), run.id);
            ctx.log(u.id, 'couriers.handover', 'rider_run:' + run.id, { expected: s.collected, counted, diff, treat: diff < 0 ? treat : null, journal: posted });
            return { ok: true, id: hid, expected: s.collected, counted, diff, journal: posted };
        });
    }
    function riderLedger(riderId) {
        const w = riderId ? 'WHERE r.rider_id=?' : '', a = riderId ? [+riderId] : [];
        return q.all(`SELECT r.rider_id, u.name rider, COUNT(DISTINCT r.id) runs,
      COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected,
      COALESCE(SUM(CASE WHEN i.result='delivered' AND NOT EXISTS (SELECT 1 FROM cr_handovers h WHERE h.run_id=r.id) THEN i.collected END),0) outstanding,
      SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed
    FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id ${w} GROUP BY r.rider_id ORDER BY u.name`, ...a).map(x => {
            const h = q.get('SELECT COALESCE(SUM(counted),0) handed, COALESCE(SUM(CASE WHEN diff<0 THEN -diff END),0) short, COALESCE(SUM(CASE WHEN diff>0 THEN diff END),0) excess FROM cr_handovers WHERE rider_id=?', x.rider_id);
            return Object.assign(Object.assign(Object.assign({}, x), h), { collected: r2(x.collected), outstanding: r2(x.outstanding) });
        });
    }
    function riderFees(month) {
        var _a;
        const rate = +riderCfg().fee || 0;
        const rows = q.all(`SELECT r.rider_id, u.name rider, COUNT(*) deliveries FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id JOIN users u ON u.id=r.rider_id WHERE i.result='delivered' AND substr(i.at,1,7)=? GROUP BY r.rider_id ORDER BY u.name`, month);
        const done = new Map(q.all('SELECT f.*, u.name approved_name FROM cr_rider_fees f LEFT JOIN users u ON u.id=f.approved_by WHERE month=?', month).map(f => [f.rider_id, f]));
        const out = rows.map(r => (Object.assign(Object.assign({}, r), { rate, amount: r2(r.deliveries * rate), approved: done.get(r.rider_id) || null })));
        for (const [rid, f] of done)
            if (!out.some(x => x.rider_id === rid))
                out.push({ rider_id: rid, rider: (_a = q.get('SELECT name FROM users WHERE id=?', rid)) === null || _a === void 0 ? void 0 : _a.name, deliveries: 0, rate, amount: 0, approved: f });
        return { month, rate, rows: out };
    }
    /* ---------------- dashboard ---------------- */
    function dashboard(from, to) {
        var _a;
        const fee = +setting('courier_fee', 250), rfee = +setting('return_fee', 150), tfee = tcsFee(), rate = +riderCfg().fee || 0;
        const live = `o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','cs_cancelled','courier_cancelled')`;
        const per = Object.fromEntries(q.all(`SELECT ${CK} k, COUNT(*) dispatched, SUM(o.status='delivered') delivered, SUM(o.status IN ('returning','returned','return_received')) returned,
      SUM(o.status IN ('dispatched','in_transit','out_for_delivery','attempted')) in_transit, SUM(o.status='attempted') attempted,
      AVG(CASE WHEN o.status='delivered' AND o.delivered_at IS NOT NULL THEN julianday(o.delivered_at)-julianday(o.dispatched_at) END) avg_days,
      SUM(CASE WHEN k0='PostEx' THEN COALESCE(o.px_fee,?)+COALESCE(o.px_tax,0) + CASE WHEN o.status IN ('returning','returned','return_received') THEN COALESCE(o.px_rev_fee,?)+COALESCE(o.px_rev_tax,0) ELSE 0 END
               WHEN k0='TCS' THEN COALESCE(o.courier_fee,?) ELSE 0 END) charges
    FROM (SELECT *, ${CK} k0 FROM orders o) o WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND ${live} AND ${PKD('o.dispatched_at')} BETWEEN ? AND ? GROUP BY k`, fee, rfee, tfee, from, to).map(r => [r.k, r]));
        const unpaid = Object.fromEntries(q.all(`SELECT ${CK} k, COUNT(*) n, COALESCE(SUM(COALESCE(o.cod,o.total)),0) v FROM orders o WHERE o.status='delivered' AND o.settled=0 GROUP BY k`).map(r => [r.k, r]));
        const riderDel = q.get(`SELECT COUNT(*) n FROM cr_run_items i WHERE i.result='delivered' AND substr(i.at,1,10) BETWEEN ? AND ?`, from, to).n;
        const couriers = COURIERS.map(k => {
            const p = per[k] || { dispatched: 0, delivered: 0, returned: 0, in_transit: 0, attempted: 0, avg_days: null, charges: 0 };
            return { courier: k, dispatched: p.dispatched || 0, delivered: p.delivered || 0, returned: p.returned || 0, in_transit: p.in_transit || 0, attempted: p.attempted || 0,
                rate: (p.delivered + p.returned) ? Math.round(100 * p.delivered / (p.delivered + p.returned)) : null, avg_days: p.avg_days != null ? Math.round(p.avg_days * 10) / 10 : null,
                cod_unpaid: r2((unpaid[k] || {}).v || 0), cod_unpaid_n: (unpaid[k] || {}).n || 0, charges: r2(k === 'Rider' ? riderDel * rate : p.charges || 0) };
        });
        const cityRows = q.all(`SELECT lower(trim(o.city)) c, MAX(o.city) city, ${CK} k, COUNT(*) n, SUM(o.status='delivered') del, SUM(o.status IN ('returning','returned','return_received')) ret
    FROM orders o WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND ${live} AND COALESCE(o.city,'')<>'' AND ${PKD('o.dispatched_at')} BETWEEN ? AND ? GROUP BY c, k`, from, to);
        const cities = {};
        for (const r of cityRows) {
            const key = ALIAS[normCity(r.city)] || normCity(r.city) || r.c, c = cities[key] || (cities[key] = { city: r.city, total: 0 });
            if (ALIAS[normCity(r.city)])
                c.city = ALIAS[normCity(r.city)].replace(/^./, x => x.toUpperCase());
            c.total += r.n;
            const x = c[_a = r.k] || (c[_a] = { n: 0, del: 0, ret: 0 });
            x.n += r.n;
            x.del += r.del;
            x.ret += r.ret;
            x.rate = (x.del + x.ret) ? Math.round(100 * x.del / (x.del + x.ret)) : null;
        }
        const cityList = Object.values(cities).sort((a, b) => b.total - a.total).slice(0, 40).map(c => {
            const best = COURIERS.filter(k => c[k] && c[k].rate != null && (c[k].del + c[k].ret) >= 5).sort((a, b) => c[b].rate - c[a].rate)[0] || null;
            return Object.assign(Object.assign({}, c), { best });
        });
        const riders = q.all(`SELECT r.rider_id, u.name rider, COUNT(DISTINCT r.day) days, SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed, COUNT(i.id) parcels
    FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id WHERE r.day BETWEEN ? AND ? GROUP BY r.rider_id ORDER BY u.name`, from, to).map(x => {
            const led = riderLedger(x.rider_id)[0] || {};
            return Object.assign(Object.assign({}, x), { per_day: x.days ? Math.round(10 * (x.delivered || 0) / x.days) / 10 : 0, success: (x.delivered + x.failed) ? Math.round(100 * x.delivered / (x.delivered + x.failed)) : null, outstanding: led.outstanding || 0, short: led.short || 0 });
        });
        const unknown = q.all(`SELECT courier_status text, COUNT(*) n FROM orders o WHERE ${CK}='TCS' AND courier_status IS NOT NULL AND tracking IS NOT NULL GROUP BY courier_status ORDER BY n DESC LIMIT 200`).filter(r => !L.mapTcs(r.text)).slice(0, 15);
        return { from, to, couriers, cities: cityList, riders, unknown, tcs: tcsState() };
    }
    function tcsState() {
        const last = q.get("SELECT at, ok, message FROM sync_log WHERE kind='tcs' ORDER BY id DESC LIMIT 1");
        const lastOk = q.get("SELECT at FROM sync_log WHERE kind='tcs' AND ok=1 ORDER BY id DESC LIMIT 1");
        return { configured: tcsConfigured(), last: last || null, lastOk: lastOk ? lastOk.at : null, failing: !!(last && !last.ok), trackAt: setting('couriers_tcs_track_at', null), payAt: setting('couriers_tcs_pay_at', null),
            cities: q.get('SELECT COUNT(*) n FROM cr_tcs_cities').n, citiesAt: setting('couriers_tcs_cities_at', null), base: baseUrl() };
    }
    function riders() {
        return q.all("SELECT id, name, username, role, perms, active FROM users WHERE active=1 AND role<>'admin' ORDER BY name").filter(u => ctx.A.userPerms(u).includes('rider')).map(u => ({ id: u.id, name: u.name }));
    }
    const riderCashOut = () => r2(q.get(`SELECT COALESCE(SUM(i.collected),0) v FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.result='delivered' AND NOT EXISTS (SELECT 1 FROM cr_handovers h WHERE h.run_id=r.id)`).v);
    /* ---------------- dispatch: one screen to book confirmed orders on PostEx, TCS or the own rider ---------------- */
    const pxCfg = () => (Object.assign({ pickupCode: '', pickupAddress: '', weight: 0.5, notes: '', orderType: 'Normal' }, (setting('couriers_postex', {}) || {})));
    const dispCfg = () => (Object.assign({ defaultCourier: 'PostEx', karachiCourier: 'Rider', minParcels: 20, days: 90, shopifyFulfil: false, packFirst: true }, (setting('couriers_dispatch', {}) || {})));
    // 'book only after packing' (Dispatch rules, default on): pick → pack → book. Returns an error text or null.
    const packGate = o => dispCfg().packFirst && o.status !== 'packed' ? `${o.name} is not packed yet — pick and pack it first (Dispatch desk → Pack)` : null;
    const PX_TYPES = ['Normal', 'Reversed', 'Replacement'];
    const LIVE = `o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','cs_cancelled','courier_cancelled')`;
    const cityKey = c => { const n = normCity(c); return ALIAS[n] || n; };
    const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, x => x.toUpperCase());
    const batches = (list, n = 10) => { const out = []; for (let i = 0; i < list.length; i += n)
        out.push(list.slice(i, i + n)); return out; };
    async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
    } })); return out; }
    // PostEx operational cities (cached), matched to the order's city like TCS cities; staff choices are remembered
    async function syncPxCities() {
        const j = await ctx.P.call('/v2/get-operational-city');
        const list = arr(pick(j, 'dist', 'data'));
        if (!list.length)
            throw new Error('PostEx sent an empty city list');
        q.tx(() => {
            q.run('DELETE FROM cr_px_cities');
            for (const c of list) {
                const name = String(typeof c === 'string' ? c : pick(c, 'operationalCityName', 'cityName', 'name') || '').trim();
                if (!name)
                    continue;
                const yes = v => v === undefined || v === null ? 1 : (v === true || /^(true|yes|1|y)$/i.test(String(v))) ? 1 : 0;
                q.run('INSERT OR REPLACE INTO cr_px_cities(name,norm,delivery,pickup) VALUES(?,?,?,?)', name, normCity(name), yes(pick(c, 'isDeliveryCity')), yes(pick(c, 'isPickupCity')));
            }
        });
        ctx.setSetting('couriers_px_cities_at', ctx.pkNow());
        return q.get('SELECT COUNT(*) n FROM cr_px_cities').n;
    }
    let pxCityTry = 0;
    async function ensurePxCities(throwIt) {
        if (q.get('SELECT name FROM cr_px_cities LIMIT 1') || !ctx.P.configured())
            return;
        if (!throwIt && Date.now() - pxCityTry < 10 * 60e3)
            return;
        pxCityTry = Date.now();
        try {
            await syncPxCities();
        }
        catch (e) {
            ctx.syncLog('postex', false, 'cities: ' + e.message);
            if (throwIt)
                throw bad('Could not load the PostEx city list: ' + e.message);
        }
    }
    let tcsCityTry = 0;
    async function ensureTcsCitiesSoft() {
        if (!tcsConfigured() || q.get('SELECT code FROM cr_tcs_cities LIMIT 1') || Date.now() - tcsCityTry < 10 * 60e3)
            return;
        tcsCityTry = Date.now();
        try {
            await syncCities();
        }
        catch (e) {
            ctx.syncLog('tcs', false, 'cities: ' + e.message);
        }
    }
    async function ensureTcsCities() { if (!q.get('SELECT code FROM cr_tcs_cities LIMIT 1')) {
        try {
            await syncCities();
        }
        catch (e) {
            throw bad('Could not load the TCS city list: ' + e.message);
        }
    } }
    function matchPxCity(city) {
        const n = cityKey(city);
        if (!n)
            return { name: null, sure: false, options: [] };
        const al = q.get('SELECT name FROM cr_px_alias WHERE city=?', n);
        if (al)
            return { name: al.name, sure: true, options: [] };
        const all = q.all('SELECT name, norm FROM cr_px_cities WHERE delivery=1');
        const ex = all.find(c => c.norm === n);
        if (ex)
            return { name: ex.name, sure: true, options: [] };
        const cand = all.map(c => (Object.assign(Object.assign({}, c), { d: lev(n, c.norm), part: c.norm.startsWith(n) || n.startsWith(c.norm) || (n.length >= 4 && c.norm.includes(n)) })))
            .filter(c => c.part || (n.length >= 4 && c.d <= 2)).sort((a, b) => (b.part - a.part) || a.d - b.d).slice(0, 6);
        return { name: cand[0] ? cand[0].name : null, sure: false, options: cand.map(c => ({ name: c.name })) };
    }
    // delivery rate per city and courier over the last N days: { cityKey: { PostEx: {n, del, ret, rate}, TCS: {...} } }
    function cityRates(days) {
        var _a, _b;
        const from = addDays(ctx.pkToday(), -days), out = {};
        for (const r of q.all(`SELECT o.city, ${CK} k, SUM(o.status='delivered') del, SUM(o.status IN ('returning','returned','return_received')) ret FROM orders o
      WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND ${LIVE} AND COALESCE(o.city,'')<>'' AND ${PKD('o.dispatched_at')}>=? GROUP BY o.city, k`, from)) {
            const key = cityKey(r.city);
            if (!key)
                continue;
            const x = ((_a = (out[key] || (out[key] = {})))[_b = r.k] || (_a[_b] = { del: 0, ret: 0 }));
            x.del += r.del || 0;
            x.ret += r.ret || 0;
        }
        for (const c of Object.values(out))
            for (const x of Object.values(c)) {
                x.n = x.del + x.ret;
                x.rate = x.n ? Math.round(100 * x.del / x.n) : null;
            }
        return out;
    }
    // which courier a row starts with, and why
    function suggest(city, rates, cfg, usable) {
        const okC = k => usable[k] !== false;
        const def = okC(cfg.defaultCourier) ? cfg.defaultCourier : (['PostEx', 'TCS'].find(okC) || cfg.defaultCourier);
        const defWhy = def === cfg.defaultCourier ? 'default courier' : `${cfg.defaultCourier} is not connected`;
        if (isKarachi(city)) {
            const k = okC(cfg.karachiCourier) ? cfg.karachiCourier : def;
            return { courier: k, why: k === cfg.karachiCourier ? `Karachi → ${k === 'Rider' ? 'own rider' : k} (setting)` : `Karachi: ${cfg.karachiCourier === 'Rider' ? 'no rider login yet' : cfg.karachiCourier + ' not connected'} → ${k}` };
        }
        const nm = titleCase(ALIAS[normCity(city)] || city || '') || 'this city', st = rates[cityKey(city)] || {};
        const min = Math.max(1, +cfg.minParcels || 20);
        const enough = ['PostEx', 'TCS'].filter(k => okC(k) && st[k] && st[k].n >= min).sort((a, b) => st[b].rate - st[a].rate || st[b].n - st[a].n);
        const line = k => st[k] && st[k].n ? `${k} ${st[k].rate}% (${st[k].n})` : `${k} no parcels`;
        if (enough.length >= 2) {
            const [a, b] = enough;
            return { courier: a, why: `${a}: ${st[a].rate}% delivered in ${nm} vs ${b} ${st[b].rate}%`, rate: true };
        }
        return { courier: def, why: `${def}: ${defWhy} — too few results in ${nm}`, detail: `Not enough delivered/returned parcels in ${nm} in the last ${cfg.days || 90} days to compare (${line('PostEx')}, ${line('TCS')}; need ${min} each), so the ${defWhy} is used.` };
    }
    const usableCouriers = () => ({ PostEx: ctx.P.configured(), TCS: tcsConfigured(), Rider: riders().length > 0 });
    function dispatchRows(u) {
        var _a, _b, _c, _d;
        const rows = q.all(`SELECT o.id, o.name, o.created_at, o.packed_at, o.picked_at, o.cust_name, o.phone, o.city, o.city_code, o.address, o.total, o.items, o.status, o.gateway, o.financial, o.tags
    FROM orders o WHERE o.tracking IS NULL AND o.cancelled_at IS NULL AND o.status IN ('confirmed','picked','packed') ORDER BY o.created_at DESC LIMIT 1500`);
        const items = {};
        if (rows.length)
            for (const it of q.all(`SELECT order_id, title, sku, qty FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tracking IS NULL AND cancelled_at IS NULL AND status IN ('confirmed','picked','packed'))`))
                (items[_a = it.order_id] || (items[_a] = [])).push({ title: it.title, sku: it.sku, qty: it.qty || 1 });
        const cfg = dispCfg(), rates = cityRates(+cfg.days || 90), usable = usableCouriers(), perPair = +pxCfg().weight || +tcsCfg().weight || 0.5;
        const tcsNames = new Map(q.all('SELECT code, name FROM cr_tcs_cities').map(c => [c.code, c.name]));
        const cT = {}, cP = {}, cS = {};
        const showPhone = can(u, 'customers') || can(u, 'tracking') || can(u, 'cs');
        for (const r of rows) {
            r.lines = items[r.id] || [];
            r.pairs = r.lines.reduce((s, i) => s + i.qty, 0) || r.items || 1;
            r.weight = Math.max(0.5, Math.round(r.pairs * perPair * 10) / 10);
            r.karachi = isKarachi(r.city);
            r.tcs = r.city_code ? { code: r.city_code, name: tcsNames.get(r.city_code) || r.city, sure: true, options: [] } : (cT[_b = r.city] || (cT[_b] = matchCity(r.city)));
            r.px = cP[_c = r.city] || (cP[_c] = matchPxCity(r.city));
            r.pick = cS[_d = r.city] || (cS[_d] = suggest(r.city, rates, cfg, usable));
            r.phone = ctx.maskPhone(u, r.phone);
            if (!showPhone)
                r.address = '';
        }
        return { rows, cfg, usable };
    }
    const can = (u, p) => ctx.can(u, p);
    async function pxBook(o, opts) {
        const c = pxCfg();
        let pickup = c.pickupCode;
        if (!pickup)
            throw new Error('Choose the PostEx pickup address in Couriers → Settings');
        const city = opts.city;
        const phone = mobile11(o.phone);
        if (!/^03\d{9}$/.test(phone))
            throw new Error(`Phone "${o.phone || ''}" is not a mobile number PostEx accepts (03xxxxxxxxx)`);
        const items = q.all('SELECT title, sku, qty FROM order_items WHERE order_id=?', o.id);
        const pieces = Math.max(1, items.reduce((s, i) => s + (i.qty || 1), 0) || +o.items || 1);
        const body = {
            orderRefNumber: orderName(o), invoicePayment: Math.max(0, Math.round(+opts.cod || 0)),
            orderDetail: (items.length ? items.map(i => `${i.qty > 1 ? i.qty + ' x ' : ''}${i.title || 'Shoes'}${i.sku ? ' (' + i.sku + ')' : ''}`).join(', ') : 'Shoes').slice(0, 250),
            customerName: String(o.cust_name || 'Customer').trim().slice(0, 100), customerPhone: phone,
            deliveryAddress: String(o.address || o.city || '').trim().slice(0, 250) || city, cityName: city,
            invoiceDivision: 1, items: pieces, orderType: PX_TYPES.includes(c.orderType) ? c.orderType : 'Normal',
            transactionNotes: String(opts.notes || c.notes || '').slice(0, 250), pickupAddressCode: String(pickup),
        };
        const j = await ctx.P.send('POST', '/v3/create-order', body);
        const d = Array.isArray(j.dist) ? j.dist[0] : (j.dist || {});
        const tn = pick(d, 'trackingNumber', 'trackingNo', 'cn') || pick(j, 'trackingNumber', 'trackingNo');
        if (!tn)
            throw new Error('PostEx booking failed: ' + (j.statusMessage || 'no tracking number in the answer'));
        return String(tn);
    }
    async function pxCancel(tn) { await ctx.P.send('PUT', '/v1/cancel-order', { trackingNumber: String(tn) }); return true; }
    async function bookTcsOne(id, u, opts = {}) {
        const o = getOrder(id);
        if (!o)
            return { id, error: 'Order not found' };
        if (o.tracking)
            return { id, order: o.name, error: `${o.name} is already booked (${o.courier || ''} ${o.tracking})` };
        if (o.cancelled_at || !BOOKABLE.includes(o.status))
            return { id, order: o.name, error: `${o.name} is "${L.STATUS[o.status] || o.status}", not ready to book` };
        if (packGate(o))
            return { id, order: o.name, notPacked: true, error: packGate(o) };
        const codes = opts.codes || {};
        const chosen = opts.code || codes[o.id] || codes[id];
        let code = chosen || o.city_code;
        if (chosen) {
            const n = normCity(o.city);
            if (n && q.get('SELECT code FROM cr_tcs_cities WHERE code=?', code))
                q.run('INSERT OR REPLACE INTO cr_city_alias(city,code,user_id) VALUES(?,?,?)', ALIAS[n] || n, code, u.id);
        }
        if (!code) {
            const m = matchCity(o.city);
            if (m.sure)
                code = m.code;
        }
        if (!code)
            return { id, order: o.name, needCity: true, error: `Choose the TCS city for ${o.name} (${o.city || 'no city'})`, options: matchCity(o.city).options };
        const cod = opts.cod != null && opts.cod !== '' && +opts.cod >= 0 ? Math.round(+opts.cod) : Math.round(+o.total || 0);
        try {
            const cn = await tcsBook(o, code, { weight: opts.weight, pieces: opts.pieces, cod });
            setBooked(o, 'TCS', cn, { status: 'Booked', cod, setCod: cod, city_code: code, via: 'api' });
            ctx.log(u.id, 'couriers.book', 'order:' + o.id, { courier: 'TCS', cn, cod });
            return { id, order: o.name, ok: true, tracking: cn, courier: 'TCS' };
        }
        catch (e) {
            return { id, order: o.name, error: e.message };
        }
    }
    async function bookPxOne(id, u, opts = {}) {
        const o = getOrder(id);
        if (!o)
            return { id, error: 'Order not found' };
        if (o.tracking)
            return { id, order: o.name, error: `${o.name} is already booked (${o.courier || ''} ${o.tracking})` };
        if (o.cancelled_at || !BOOKABLE.includes(o.status))
            return { id, order: o.name, error: `${o.name} is "${L.STATUS[o.status] || o.status}", not ready to book` };
        if (packGate(o))
            return { id, order: o.name, notPacked: true, error: packGate(o) };
        let city = null;
        if (opts.city) {
            const hit = q.get('SELECT name FROM cr_px_cities WHERE name=? OR norm=?', String(opts.city), normCity(opts.city));
            if (!hit)
                return { id, order: o.name, needCity: true, error: `"${opts.city}" is not a PostEx city`, options: matchPxCity(o.city).options };
            city = hit.name;
            const n = cityKey(o.city);
            if (n)
                q.run('INSERT OR REPLACE INTO cr_px_alias(city,name,user_id) VALUES(?,?,?)', n, city, u.id);
        }
        else {
            const m = matchPxCity(o.city);
            if (m.sure)
                city = m.name;
            else
                return { id, order: o.name, needCity: true, error: `Choose the PostEx city for ${o.name} (${o.city || 'no city'})`, options: m.options };
        }
        const cod = opts.cod != null && opts.cod !== '' && +opts.cod >= 0 ? Math.round(+opts.cod) : Math.round(+o.total || 0);
        try {
            const tn = await pxBook(o, { city, cod, notes: opts.notes });
            if (q.get('SELECT id FROM orders WHERE tracking=? AND id<>?', tn, o.id))
                throw new Error(`PostEx sent tracking ${tn}, which is already on another order`);
            setBooked(o, 'PostEx', tn, { cod, setCod: cod, via: 'api' });
            ctx.log(u.id, 'couriers.book', 'order:' + o.id, { courier: 'PostEx', cn: tn, cod, city });
            return { id, order: o.name, ok: true, tracking: tn, courier: 'PostEx' };
        }
        catch (e) {
            return { id, order: o.name, error: e.message };
        }
    }
    // Shopify: mark the order fulfilled with the tracking number (optional; failures never undo the booking)
    const COMPANY = { PostEx: 'PostEx', TCS: 'TCS', Rider: 'SundayBazar Rider' };
    const trackUrl = (k, tn) => k === 'PostEx' ? 'https://postex.pk/tracking?cn=' + encodeURIComponent(tn) : k === 'TCS' ? 'https://www.tcsexpress.com/track/' + encodeURIComponent(tn) : null;
    async function shopifyFulfil(orderId) {
        const o = q.get('SELECT id, name, courier, tracking FROM orders WHERE id=?', orderId);
        if (!o || !o.tracking)
            return null;
        const k = L.courierKey(o.courier), rec = (ok, error, fid) => q.run(`INSERT INTO cr_fulfil(order_id,tracking,courier,ok,error,fulfillment_id,at) VALUES(?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET tracking=excluded.tracking, courier=excluded.courier, ok=excluded.ok, error=excluded.error, fulfillment_id=COALESCE(excluded.fulfillment_id,fulfillment_id), at=excluded.at`, o.id, o.tracking, k, ok ? 1 : 0, error || null, fid || null);
        try {
            if (!/^gid:\/\/shopify\/Order\//.test(o.id))
                throw new Error('Not a Shopify order');
            if (!ctx.S.configured())
                throw new Error('Shopify is not connected');
            const d = await ctx.S.gql(`query($id:ID!){ order(id:$id){ id fulfillmentOrders(first:10){ nodes{ id status lineItems(first:50){ nodes{ id remainingQuantity } } } } } }`, { id: o.id });
            const fos = ((d.order && d.order.fulfillmentOrders && d.order.fulfillmentOrders.nodes) || []).filter(f => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
            if (!fos.length)
                throw new Error('No open fulfillment order in Shopify (already fulfilled, on hold or cancelled)');
            const trackingInfo = { number: o.tracking, company: COMPANY[k] || o.courier };
            const url = trackUrl(k, o.tracking);
            if (url)
                trackingInfo.url = url;
            const m = await ctx.S.gql(`mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }`, { f: { lineItemsByFulfillmentOrder: fos.map(f => ({ fulfillmentOrderId: f.id })), trackingInfo, notifyCustomer: false } });
            const r = m.fulfillmentCreate || {}, errs = r.userErrors || [];
            if (errs.length)
                throw new Error(errs.map(e => e.message).join('; '));
            rec(true, null, r.fulfillment && r.fulfillment.id);
            return { ok: true };
        }
        catch (e) {
            rec(false, e.message);
            return { ok: false, error: e.message };
        }
    }
    async function shopifyUnfulfil(o) {
        const f = q.get('SELECT * FROM cr_fulfil WHERE order_id=? AND ok=1 AND fulfillment_id IS NOT NULL', o.id);
        if (!f)
            return null;
        try {
            const m = await ctx.S.gql(`mutation($id:ID!){ fulfillmentCancel(id:$id){ fulfillment{ id status } userErrors{ field message } } }`, { id: f.fulfillment_id });
            const errs = (m.fulfillmentCancel && m.fulfillmentCancel.userErrors) || [];
            if (errs.length)
                throw new Error(errs.map(e => e.message).join('; '));
            q.run('DELETE FROM cr_fulfil WHERE order_id=?', o.id);
            return { ok: true };
        }
        catch (e) {
            q.run('UPDATE cr_fulfil SET error=? WHERE order_id=?', 'Booking cancelled in the ERP, but Shopify fulfilment could not be cancelled: ' + e.message, o.id);
            return { ok: false, error: e.message };
        }
    }
    const fulfilQueue = [];
    let fulfilBusy = false;
    function queueFulfil(ids) {
        if (!dispCfg().shopifyFulfil || !ids.length)
            return false;
        ids = ids.filter(id => /^gid:\/\/shopify\/Order\//.test(id));
        if (!ids.length)
            return false; // demo / manual orders are not in Shopify
        fulfilQueue.push(...ids);
        if (!fulfilBusy) {
            fulfilBusy = true;
            (async () => { try {
                while (fulfilQueue.length) {
                    const batch = fulfilQueue.splice(0, 3);
                    await Promise.all(batch.map(id => shopifyFulfil(id)));
                }
            }
            finally {
                fulfilBusy = false;
            } })();
        }
        return true;
    }
    // parcels booked from the ERP in the last 3 days that have not been handed to the courier yet
    const HAND_WAIT = `(hd.order_id IS NULL AND o.bk_tracking=o.tracking AND o.status IN ('dispatched','out_for_delivery') AND o.dispatched_at >= datetime('now','-3 days'))`;
    function stepCounts() {
        const n = sql => q.get(sql).n;
        const open = `tracking IS NULL AND cancelled_at IS NULL`;
        const packFirst = !!dispCfg().packFirst;
        return { packFirst,
            pick: n(`SELECT COUNT(*) n FROM orders WHERE ${open} AND status='confirmed'`),
            pack: n(`SELECT COUNT(*) n FROM orders WHERE ${open} AND status='picked'`),
            book: n(`SELECT COUNT(*) n FROM orders WHERE ${open} AND status IN (${packFirst ? "'packed'" : "'confirmed','picked','packed'"})`),
            handover: n(`SELECT COUNT(*) n FROM orders o LEFT JOIN cr_handed hd ON hd.order_id=o.id WHERE o.tracking IS NOT NULL AND ${LIVE} AND o.dispatched_at IS NOT NULL AND ${HAND_WAIT}`),
            today: n(`SELECT COUNT(*) n FROM orders o WHERE o.tracking IS NOT NULL AND ${LIVE} AND o.dispatched_at IS NOT NULL AND ${PKD('o.dispatched_at')}='${ctx.pkToday()}'`) };
    }
    /* ---------------- module ---------------- */
    module.exports = {
        name: 'couriers',
        schema: `
CREATE TABLE IF NOT EXISTS cr_tcs_cities(code TEXT PRIMARY KEY, name TEXT, norm TEXT);
CREATE INDEX IF NOT EXISTS ix_cr_cities_norm ON cr_tcs_cities(norm);
CREATE TABLE IF NOT EXISTS cr_city_alias(city TEXT PRIMARY KEY, code TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cr_runs(id INTEGER PRIMARY KEY, day TEXT NOT NULL, rider_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), out_at TEXT, closed_at TEXT);
CREATE INDEX IF NOT EXISTS ix_cr_runs_rider ON cr_runs(rider_id, day);
CREATE TABLE IF NOT EXISTS cr_run_items(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES cr_runs(id) ON DELETE CASCADE, order_id TEXT NOT NULL, seq INTEGER, cod REAL DEFAULT 0,
  result TEXT, collected REAL, reason TEXT, note TEXT, resched_to TEXT, at TEXT, by_user INTEGER, back TEXT, back_at TEXT, back_by INTEGER, UNIQUE(run_id, order_id));
CREATE INDEX IF NOT EXISTS ix_cr_items_order ON cr_run_items(order_id);
CREATE TABLE IF NOT EXISTS cr_handovers(id INTEGER PRIMARY KEY, run_id INTEGER UNIQUE, rider_id INTEGER, day TEXT, expected REAL, counted REAL, diff REAL, treat TEXT, note TEXT, journal_id INTEGER, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cr_px_cities(name TEXT PRIMARY KEY, norm TEXT, delivery INTEGER DEFAULT 1, pickup INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS ix_cr_px_norm ON cr_px_cities(norm);
CREATE TABLE IF NOT EXISTS cr_px_alias(city TEXT PRIMARY KEY, name TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cr_handed(order_id TEXT PRIMARY KEY, courier TEXT, tracking TEXT, at TEXT DEFAULT (datetime('now')), user_id INTEGER);
CREATE TABLE IF NOT EXISTS cr_fulfil(order_id TEXT PRIMARY KEY, tracking TEXT, courier TEXT, ok INTEGER, error TEXT, fulfillment_id TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS cr_rider_fees(month TEXT, rider_id INTEGER, deliveries INTEGER, rate REAL, amount REAL, journal_id INTEGER, approved_by INTEGER, approved_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(month, rider_id));`,
        migrate(c) {
            ctx = c;
            q = c.q;
            setting = c.setting;
            L = c.L || require('../lib/logic');
            const have = new Set(q.all('PRAGMA table_info(orders)').map(x => x.name));
            for (const [col, t] of [['courier_status', 'TEXT'], ['courier_updated', 'TEXT'], ['courier_history', 'TEXT'], ['courier_cod', 'REAL'], ['courier_fee', 'REAL'], ['courier_paid', 'REAL'], ['courier_settled_at', 'TEXT'],
                ['rider_id', 'INTEGER'], ['rider_run_id', 'INTEGER'], ['bk_courier', 'TEXT'], ['bk_tracking', 'TEXT'], ['bk_via', 'TEXT'], ['city_code', 'TEXT']])
                if (!have.has(col))
                    c.db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${t}`);
            c.db.exec('CREATE INDEX IF NOT EXISTS ix_orders_rider_run ON orders(rider_run_id)');
            // one spelling for courier names that came from Shopify ('TCS Express' -> 'TCS', 'Post Ex' -> 'PostEx')
            for (const r of q.all('SELECT DISTINCT courier FROM orders WHERE courier IS NOT NULL')) {
                const n = L.normCourier(r.courier);
                if (n !== r.courier)
                    q.run('UPDATE orders SET courier=? WHERE courier=?', n, r.courier);
            }
            c.services.couriers = {
                summary: () => ({ inTransit: q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted')`).n,
                    codPending: r2(q.get(`SELECT COALESCE(SUM(COALESCE(cod,total)),0) v FROM orders WHERE status='delivered' AND settled=0`).v), riderCashOut: riderCashOut(), tcsConnected: tcsConfigured() && !tcsState().failing }),
                normCourier: L.normCourier, matchCity, isKarachi,
            };
        },
        routes(c) {
            const { route, need, log, can } = c;
            const isAdm = u => u.role === 'admin';
            /* ---- settings ---- */
            route('GET', '/api/couriers/settings', 'settings', () => {
                const t = tcsCfg(), out = Object.assign({}, t);
                for (const k of SECRET_KEYS)
                    out[k] = mask(k, t[k]);
                return { tcs: out, has: Object.fromEntries(SECRET_KEYS.map(k => [k, !!t[k]])), tcsFee: tcsFee(), rider: riderCfg(), state: tcsState(),
                    postex: pxCfg(), dispatch: dispCfg(), pxState: { configured: c.P.configured(), cities: q.get('SELECT COUNT(*) n FROM cr_px_cities WHERE delivery=1').n, citiesAt: setting('couriers_px_cities_at', null) }, shopify: c.S.configured() };
            });
            route('POST', '/api/couriers/settings', 'settings', (req, u, b) => {
                var _a;
                if (b.tcs) {
                    const cur = tcsCfg(), nx = Object.assign({}, cur);
                    for (const k of ['account', 'customerNo', 'costCenter', 'shipperName', 'shipperAddress', 'shipperCity', 'shipperCityCode', 'shipperMobile', 'serviceCode', 'baseUrl'])
                        if (k in b.tcs)
                            nx[k] = String((_a = b.tcs[k]) !== null && _a !== void 0 ? _a : '').trim();
                    if ('weight' in b.tcs) {
                        need(+b.tcs.weight >= 0.5, 'Default weight must be at least 0.5 kg');
                        nx.weight = +b.tcs.weight;
                    }
                    if ('sandbox' in b.tcs)
                        nx.sandbox = !!b.tcs.sandbox;
                    for (const k of SECRET_KEYS) {
                        const v = b.tcs[k];
                        if (v === null)
                            delete nx[k];
                        else if (typeof v === 'string' && v.trim() && !v.includes('•'))
                            nx[k] = v.trim();
                    }
                    c.setSetting('couriers_tcs', nx);
                    resetTokens();
                }
                if ('tcsFee' in b) {
                    need(+b.tcsFee >= 0, 'TCS charge must be 0 or more');
                    c.setSetting('couriers_tcs_fee', +b.tcsFee);
                }
                if (b.rider) {
                    const nx = Object.assign({}, riderCfg());
                    if ('fee' in b.rider) {
                        need(+b.rider.fee >= 0, 'Rider fee must be 0 or more');
                        nx.fee = +b.rider.fee || 0;
                    }
                    if ('karachi' in b.rider)
                        nx.karachi = String(b.rider.karachi || '');
                    if ('cashAccount' in b.rider && b.rider.cashAccount) {
                        need(!c.services.accounts || c.services.accounts.accountId(b.rider.cashAccount), 'Unknown account');
                        nx.cashAccount = b.rider.cashAccount;
                    }
                    c.setSetting('couriers_rider', nx);
                }
                if (b.postex) {
                    const nx = Object.assign({}, pxCfg());
                    if ('pickupCode' in b.postex) {
                        nx.pickupCode = String(b.postex.pickupCode || '').trim();
                        nx.pickupAddress = String(b.postex.pickupAddress || '').slice(0, 250);
                    }
                    if ('weight' in b.postex) {
                        need(+b.postex.weight > 0, 'Weight per pair must be more than 0');
                        nx.weight = +b.postex.weight;
                    }
                    if ('notes' in b.postex)
                        nx.notes = String(b.postex.notes || '').slice(0, 250);
                    if ('orderType' in b.postex) {
                        need(PX_TYPES.includes(b.postex.orderType), 'Order type must be ' + PX_TYPES.join(' / '));
                        nx.orderType = b.postex.orderType;
                    }
                    c.setSetting('couriers_postex', nx);
                }
                if (b.dispatch) {
                    const nx = Object.assign({}, dispCfg()), d = b.dispatch;
                    if ('defaultCourier' in d) {
                        need(['PostEx', 'TCS'].includes(d.defaultCourier), 'Default courier must be PostEx or TCS');
                        nx.defaultCourier = d.defaultCourier;
                    }
                    if ('karachiCourier' in d) {
                        need(COURIERS.includes(d.karachiCourier), 'Karachi courier must be Rider, TCS or PostEx');
                        nx.karachiCourier = d.karachiCourier;
                    }
                    if ('minParcels' in d) {
                        need(+d.minParcels >= 1, 'Minimum parcels must be 1 or more');
                        nx.minParcels = Math.round(+d.minParcels);
                    }
                    if ('shopifyFulfil' in d)
                        nx.shopifyFulfil = !!d.shopifyFulfil;
                    if ('packFirst' in d)
                        nx.packFirst = !!d.packFirst;
                    c.setSetting('couriers_dispatch', nx);
                }
                log(u.id, 'couriers.settings', 'settings', { tcs: !!b.tcs, rider: !!b.rider, postex: !!b.postex, dispatch: !!b.dispatch });
                return { ok: true };
            });
            route('POST', '/api/couriers/tcs/test', 'settings', async () => {
                const out = { base: baseUrl() };
                out.bearer = !!(await bearer());
                const t = tcsCfg();
                if (t.username && t.password)
                    out.access = !!(await accessToken());
                out.cities = await syncCities();
                c.syncLog('tcs', true, 'connection test ok · ' + out.cities + ' cities');
                return Object.assign({ ok: true }, out);
            });
            route('POST', '/api/couriers/tcs/sync', 'couriers', async (req, u, b) => {
                need(tcsConfigured(), 'TCS is not connected yet (Couriers → Settings)');
                const kind = b.kind || 'track';
                let r;
                try {
                    r = kind === 'payments' ? await syncPayments() : kind === 'cities' ? { cities: await syncCities() } : await syncTrack();
                }
                catch (e) {
                    c.syncLog('tcs', false, kind + ': ' + e.message);
                    throw bad(e.message);
                }
                log(u.id, 'couriers.sync', 'tcs', { kind });
                return r;
            });
            route('GET', '/api/couriers/tcs/cities', 'couriers', (req, u, b, res, p, qs) => {
                const t = '%' + normCity(qs.q || '') + '%';
                return q.all('SELECT code, name FROM cr_tcs_cities WHERE norm LIKE ? ORDER BY name LIMIT 50', t);
            });
            /* ---- booking ---- */
            route('GET', '/api/couriers/riders', 'couriers', () => riders());
            route('GET', '/api/couriers/book', 'couriers', (req, u, b, res, p, qs) => {
                var _a;
                const st = qs.show === 'all' ? BOOKABLE : ['packed'];
                const rows = q.all(`SELECT o.id, o.name, o.created_at, o.packed_at, o.cust_name, o.phone, o.city, o.city_code, o.address, o.total, o.items, o.status, o.gateway,
          (SELECT group_concat(title, ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o
        WHERE o.tracking IS NULL AND o.cancelled_at IS NULL AND o.status IN (${st.map(() => '?').join(',')}) ORDER BY COALESCE(o.packed_at,o.created_at) LIMIT 500`, ...st);
                const cache = {};
                for (const r of rows) {
                    r.karachi = isKarachi(r.city);
                    const m = r.city_code ? { code: r.city_code, sure: true, name: (q.get('SELECT name FROM cr_tcs_cities WHERE code=?', r.city_code) || {}).name || r.city, options: [] } : (cache[_a = r.city] || (cache[_a] = matchCity(r.city)));
                    r.tcs = m;
                    r.phone = c.maskPhone(u, r.phone);
                    if (!can(u, 'customers') && !can(u, 'tracking'))
                        r.address = '';
                }
                const counts = q.get(`SELECT SUM(status='packed') packed, COUNT(*) all_ FROM orders WHERE tracking IS NULL AND cancelled_at IS NULL AND status IN ('confirmed','picked','packed')`);
                const runs = q.all(`SELECT r.id, r.day, r.status, r.rider_id, u.name rider, (SELECT COUNT(*) FROM cr_run_items WHERE run_id=r.id) parcels FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.status<>'closed' ORDER BY r.day DESC, r.id DESC`);
                return { rows, counts: { packed: counts.packed || 0, all: counts.all_ || 0 }, riders: riders(), runs, tcs: { configured: tcsConfigured(), cities: q.get('SELECT COUNT(*) n FROM cr_tcs_cities').n } };
            });
            route('POST', '/api/couriers/book', 'couriers', async (req, u, b) => {
                const ids = (b.ids || []).map(String);
                need(ids.length, 'Select orders first');
                const courier = L.normCourier(b.courier || '');
                need(courier, 'Choose a courier');
                const results = [];
                if (courier === 'Rider') {
                    let run = b.run_id ? runRow(+b.run_id) : null;
                    if (!run) {
                        need(b.rider_id, 'Choose the rider');
                        const d = isDate(b.day) ? b.day : c.pkToday();
                        run = q.get("SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.rider_id=? AND r.day=? AND r.status<>'closed' ORDER BY r.id DESC LIMIT 1", +b.rider_id, d) || createRun(b.rider_id, d, u);
                    }
                    need(run && run.status !== 'closed', 'That run is closed');
                    for (const id of ids)
                        results.push(Object.assign({ id }, addToRun(run, getOrder(id), u, !!b.force)));
                    queueFulfil(results.filter(r => r.ok).map(r => (getOrder(r.id) || {}).id).filter(Boolean));
                    return { run: run.id, results };
                }
                if (b.tracking !== undefined || courier !== 'TCS' || b.manual) {
                    // tracking entered by hand (PostEx booked in Shopify, or any other courier)
                    need(ids.length === 1, 'Enter tracking one order at a time');
                    const tn = String(b.tracking || '').trim();
                    need(tn.length >= 4, 'Enter the tracking number');
                    const o = getOrder(ids[0]);
                    need(o, 'Order not found', 404);
                    need(!o.cancelled_at, 'This order is cancelled');
                    need(!o.tracking || b.replace, `${o.name} already has tracking ${o.tracking} (${o.courier || 'courier'})`);
                    const dup = q.get('SELECT name FROM orders WHERE tracking=? AND id<>?', tn, o.id);
                    need(!dup, `Tracking ${tn} is already on order ${dup && dup.name}`);
                    if (o.tracking && L.courierKey(o.courier) === 'Rider')
                        need(!openItem(o.id), 'This order is on a rider run — remove it from the run first');
                    setBooked(o, courier, tn, { status: courier === 'TCS' ? 'Booked' : null, cod: o.total });
                    log(u.id, 'couriers.tracking', 'order:' + o.id, { courier, tracking: tn });
                    queueFulfil([o.id]);
                    return { results: [{ id: o.id, ok: true, tracking: tn, courier }] };
                }
                // TCS API booking (one by one; each order reports its own result)
                need(tcsConfigured(), 'TCS is not connected yet. Add the TCS login in Couriers → Settings.');
                await ensureTcsCities();
                const codes = b.city_codes || {};
                for (const id of ids)
                    results.push(await bookTcsOne(id, u, { codes, weight: b.weight, pieces: b.pieces }));
                queueFulfil(results.filter(r => r.ok).map(r => (getOrder(r.id) || {}).id).filter(Boolean));
                return { results };
            });
            route('POST', '/api/couriers/orders/:id/cancel', 'couriers', async (req, u, b, res, p) => {
                const o = getOrder(decodeURIComponent(p.id));
                need(o && o.tracking, 'This order is not booked', 404);
                const k = L.courierKey(o.courier);
                if (k === 'Rider') {
                    const it = openItem(o.id);
                    need(!it || !it.result, 'The rider already marked this parcel — undo it in the rider run first');
                    if (it)
                        q.run('DELETE FROM cr_run_items WHERE id=?', it.id);
                }
                else {
                    need(['dispatched'].includes(o.status) || isAdm(u), `${o.name} is already "${L.STATUS[o.status]}" with the courier — it cannot be cancelled now`);
                    if (k === 'TCS' && o.bk_tracking === o.tracking && tcsConfigured() && b.api !== false)
                        await tcsCancel(o.tracking);
                    if (k === 'PostEx' && o.bk_via === 'api' && o.bk_tracking === o.tracking && b.api !== false) {
                        try {
                            await pxCancel(o.tracking);
                        }
                        catch (e) {
                            throw bad(e.message);
                        }
                    }
                }
                const shop = await shopifyUnfulfil(o);
                q.run('DELETE FROM cr_handed WHERE order_id=?', o.id);
                clearBooking(o);
                log(u.id, 'couriers.cancel', 'order:' + o.id, { courier: o.courier, tracking: o.tracking });
                return { ok: true, shopify: shop };
            });
            /* ---- dispatch screen ---- */
            route('GET', '/api/couriers/dispatch', 'couriers', async (req, u) => {
                await Promise.all([ensurePxCities(false), ensureTcsCitiesSoft()]);
                const d = dispatchRows(u);
                const today = c.pkToday();
                const booked = q.get(`SELECT COUNT(*) n FROM orders o WHERE o.tracking IS NOT NULL AND ${LIVE} AND o.dispatched_at IS NOT NULL AND ${PKD('o.dispatched_at')}=?`, today).n;
                return Object.assign(Object.assign({}, d), { today, bookedToday: booked, packFirst: !!d.cfg.packFirst, riders: riders(), pickup: { code: pxCfg().pickupCode, address: pxCfg().pickupAddress }, cities: { px: q.get('SELECT COUNT(*) n FROM cr_px_cities WHERE delivery=1').n, tcs: q.get('SELECT COUNT(*) n FROM cr_tcs_cities').n } });
            });
            route('POST', '/api/couriers/dispatch/book', 'couriers', async (req, u, b) => {
                const rows = (Array.isArray(b.rows) ? b.rows : []).filter(r => r && r.id != null).slice(0, 300);
                need(rows.length, 'Select orders first');
                const seen = new Set();
                for (const r of rows) {
                    need(!seen.has(String(r.id)), 'An order is listed twice');
                    seen.add(String(r.id));
                }
                const results = new Array(rows.length);
                const kind = r => r.courier === 'Rider' ? 'Rider' : L.normCourier(r.courier || '');
                rows.forEach((r, i) => { const k = kind(r); if (!['PostEx', 'TCS', 'Rider'].includes(k))
                    results[i] = { id: r.id, error: 'Choose PostEx, TCS or Rider' }; });
                // rider: one run for the chosen rider today (made if none)
                const rIdx = rows.map((r, i) => i).filter(i => !results[i] && kind(rows[i]) === 'Rider');
                let run = null;
                if (rIdx.length) {
                    const rl = riders();
                    let rid = +b.rider_id || (rl.length === 1 ? rl[0].id : 0);
                    if (!rid)
                        rIdx.forEach(i => { results[i] = { id: rows[i].id, error: rl.length ? 'Choose the rider for Karachi parcels' : 'No rider login yet — add a staff login with the Rider role' }; });
                    else {
                        try {
                            run = b.run_id ? runRow(+b.run_id) : null;
                            if (run && (run.status === 'closed' || run.rider_id !== rid))
                                run = null;
                            run || (run = q.get("SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.rider_id=? AND r.day=? AND r.status<>'closed' ORDER BY r.id DESC LIMIT 1", rid, c.pkToday()) || createRun(rid, c.pkToday(), u));
                            for (const i of rIdx) {
                                const r = rows[i], o = getOrder(r.id);
                                const x = addToRun(run, o, u, true, r.cod != null && r.cod !== '' ? +r.cod : null);
                                results[i] = x.ok ? { id: r.id, order: o.name, ok: true, courier: 'Rider', tracking: riderTracking(o), run: run.id } : { id: r.id, order: o && o.name, error: x.error || x.warn, notPacked: x.notPacked || undefined };
                            }
                        }
                        catch (e) {
                            rIdx.forEach(i => { results[i] || (results[i] = { id: rows[i].id, error: e.message }); });
                        }
                    }
                }
                const pIdx = rows.map((r, i) => i).filter(i => !results[i] && kind(rows[i]) === 'PostEx'), tIdx = rows.map((r, i) => i).filter(i => !results[i] && kind(rows[i]) === 'TCS');
                if (pIdx.length) {
                    let err = !c.P.configured() ? 'PostEx is not connected. Add the PostEx token in Settings → PostEx.' : !pxCfg().pickupCode ? 'Choose the PostEx pickup address in Couriers → Settings' : null;
                    if (!err) {
                        try {
                            await ensurePxCities(true);
                        }
                        catch (e) {
                            err = e.message;
                        }
                    }
                    if (err)
                        pIdx.forEach(i => { results[i] = { id: rows[i].id, error: err }; });
                    else
                        await pool(pIdx, 4, async (i) => { const r = rows[i]; results[i] = await bookPxOne(r.id, u, { city: r.city, cod: r.cod }); });
                }
                if (tIdx.length) {
                    let err = !tcsConfigured() ? 'TCS is not connected yet. Add the TCS login in Couriers → Settings.' : null;
                    if (!err) {
                        try {
                            await ensureTcsCities();
                        }
                        catch (e) {
                            err = e.message;
                        }
                    }
                    if (err)
                        tIdx.forEach(i => { results[i] = { id: rows[i].id, error: err }; });
                    else
                        await pool(tIdx, 3, async (i) => {
                            const r = rows[i];
                            const o = getOrder(r.id);
                            const pairs = o ? (q.get('SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE order_id=?', o.id).n || 1) : 1;
                            results[i] = await bookTcsOne(r.id, u, { code: r.city, cod: r.cod, weight: Math.max(+tcsCfg().weight || 1, Math.round(pairs * (+pxCfg().weight || 0.5) * 10) / 10) });
                        });
                }
                const okIds = results.filter(r => r && r.ok).map(r => (getOrder(r.id) || {}).id).filter(Boolean);
                const shopify = queueFulfil(okIds);
                return { results, run: run ? run.id : null, shopify };
            });
            route('GET', '/api/couriers/dispatch/today', 'couriers', (req, u, b, res, p, qs) => {
                const d = isDate(qs.day) ? qs.day : c.pkToday();
                const rows = q.all(`SELECT o.id, o.name, o.cust_name, o.phone, o.city, o.total, o.cod, o.courier_cod, o.courier, o.tracking, o.status, o.courier_status, o.dispatched_at, o.rider_run_id, o.bk_via,
          (SELECT group_concat(title, ' + ') FROM order_items WHERE order_id=o.id) items_text, f.ok shop_ok, f.error shop_error, ${CK} k, hd.at handed_at, hu.name handed_by
        FROM orders o LEFT JOIN cr_fulfil f ON f.order_id=o.id LEFT JOIN cr_handed hd ON hd.order_id=o.id LEFT JOIN users hu ON hu.id=hd.user_id WHERE o.tracking IS NOT NULL AND ${LIVE} AND o.dispatched_at IS NOT NULL AND ${PKD('o.dispatched_at')}=? ORDER BY o.dispatched_at DESC LIMIT 1000`, d);
                for (const r of rows)
                    r.phone = c.maskPhone(u, r.phone);
                return { day: d, rows, shopifyFulfil: !!dispCfg().shopifyFulfil };
            });
            route('POST', '/api/couriers/dispatch/shopify/:id', 'couriers', async (req, u, b, res, p) => {
                const o = getOrder(decodeURIComponent(p.id));
                need(o && o.tracking, 'This order is not booked', 404);
                return await shopifyFulfil(o.id);
            });
            /* ---- dispatch desk: step counts, handover to the courier ---- */
            route('GET', '/api/couriers/dispatch/steps', 'couriers', () => stepCounts());
            route('GET', '/api/couriers/dispatch/handover', 'couriers', (req, u) => {
                const rows = q.all(`SELECT o.id, o.name, o.cust_name, o.phone, o.city, o.address, o.total, o.cod, o.courier_cod, o.courier, o.tracking, o.status, o.dispatched_at, o.rider_run_id, o.items,
          (SELECT group_concat(COALESCE(sku,title), ', ') FROM order_items WHERE order_id=o.id) skus, ${CK} k, hd.at handed_at, hu.name handed_by
        FROM orders o LEFT JOIN cr_handed hd ON hd.order_id=o.id LEFT JOIN users hu ON hu.id=hd.user_id
        WHERE o.tracking IS NOT NULL AND ${LIVE} AND o.dispatched_at IS NOT NULL AND (${HAND_WAIT} OR ${PKD('hd.at')}=?) ORDER BY k, o.dispatched_at`, c.pkToday());
                for (const r of rows)
                    r.phone = c.maskPhone(u, r.phone);
                return { today: c.pkToday(), rows, pickup: pxCfg().pickupAddress || '', store: c.setting('store_name', 'SundayBazar') };
            });
            route('POST', '/api/couriers/dispatch/handover', 'couriers', (req, u, b) => {
                const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 1000);
                need(ids.length, 'Select parcels first');
                let n = 0;
                const bad = [];
                q.tx(() => {
                    for (const id of ids) {
                        const o = getOrder(id);
                        if (!o || !o.tracking || o.cancelled_at) {
                            bad.push(o ? o.name : id);
                            continue;
                        }
                        if (b.undo) {
                            n += q.run('DELETE FROM cr_handed WHERE order_id=?', o.id).changes;
                            continue;
                        }
                        if (q.get('SELECT order_id FROM cr_handed WHERE order_id=?', o.id))
                            continue;
                        q.run('INSERT INTO cr_handed(order_id,courier,tracking,user_id) VALUES(?,?,?,?)', o.id, L.courierKey(o.courier), o.tracking, u.id);
                        n++;
                    }
                });
                if (n)
                    log(u.id, b.undo ? 'couriers.handed.undo' : 'couriers.handed', 'orders', { parcels: n, courier: b.courier || null });
                return { ok: true, n, skipped: bad };
            });
            route('GET', '/api/couriers/postex/cities', 'couriers', (req, u, b, res, p, qs) => q.all('SELECT name FROM cr_px_cities WHERE delivery=1 AND norm LIKE ? ORDER BY name LIMIT 50', '%' + normCity(qs.q || '') + '%'));
            route('POST', '/api/couriers/postex/cities', 'couriers', async (req, u) => {
                need(c.P.configured(), 'PostEx is not connected. Add the PostEx token in Settings → PostEx.');
                let n;
                try {
                    n = await syncPxCities();
                }
                catch (e) {
                    throw bad(e.message);
                }
                log(u.id, 'couriers.sync', 'postex', { kind: 'cities', n });
                return { cities: n };
            });
            route('GET', '/api/couriers/postex/addresses', 'settings', async () => {
                need(c.P.configured(), 'PostEx is not connected. Add the PostEx token in Settings → PostEx first.');
                let j;
                try {
                    j = await c.P.call('/v1/get-merchant-address');
                }
                catch (e) {
                    throw bad(e.message);
                }
                return arr(pick(j, 'dist', 'data')).map(a => ({ code: String(pick(a, 'addressCode', 'code') || ''), address: String(pick(a, 'address') || ''), city: String(pick(a, 'cityName', 'city') || ''), type: String(pick(a, 'addressType') || '') })).filter(a => a.code);
            });
            const pdfOut = (res, f, name) => {
                if (f.url) {
                    res.writeHead(302, { Location: f.url });
                    return res.end();
                }
                res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(f.pdf);
            };
            const pxTns = list => [...new Set(String(list || '').split(',').map(x => x.trim()).filter(Boolean))];
            // airway bills: PostEx prints at most 10 per call -> ?tns=a,b,...&part=N gives batch N (header X-Parts = number of batches)
            route('GET', '/api/couriers/postex/awb', 'couriers', async (req, u, b, res, p, qs) => {
                const tns = pxTns(qs.tns || '');
                need(tns.length, 'No tracking numbers');
                const parts = batches(tns, 10), n = Math.max(0, Math.min(parts.length - 1, +qs.part || 0));
                let f;
                try {
                    f = await c.P.send('GET', '/v1/get-invoice?trackingNumbers=' + parts[n].map(encodeURIComponent).join(','), undefined, { pdf: true });
                }
                catch (e) {
                    throw bad(e.message);
                }
                res.setHeader('X-Parts', String(parts.length));
                pdfOut(res, f, `postex-airway-bills-${n + 1}.pdf`);
            });
            route('POST', '/api/couriers/postex/loadsheet', 'couriers', async (req, u, b, res) => {
                const tns = pxTns((b.tns || []).join(','));
                need(tns.length, 'No PostEx parcels selected');
                const pc = pxCfg().pickupCode;
                need(pc, 'Choose the PostEx pickup address in Couriers → Settings');
                let f;
                try {
                    f = await c.P.send('POST', '/v2/generate-load-sheet', { trackingNumbers: tns, pickupAddress: pc }, { pdf: true });
                }
                catch (e) {
                    throw bad(e.message);
                }
                log(u.id, 'couriers.loadsheet', 'postex', { parcels: tns.length });
                if (f.url)
                    return { url: f.url };
                pdfOut(res, f, 'postex-load-sheet.pdf');
            });
            route('POST', '/api/couriers/orders/:id/track', 'couriers', async (req, u, b, res, p) => {
                const o = getOrder(decodeURIComponent(p.id));
                need(o && o.tracking, 'No tracking number');
                need(L.courierKey(o.courier) === 'TCS', 'Only TCS parcels are tracked here');
                try {
                    await tcsTrack(o);
                }
                catch (e) {
                    throw bad(e.message);
                }
                return q.get('SELECT status, courier_status, courier_updated, courier_history FROM orders WHERE id=?', o.id);
            });
            route('GET', '/api/couriers/parcels', 'couriers', (req, u, b, res, p, qs) => {
                const k = COURIERS.includes(qs.courier) ? qs.courier : 'TCS';
                const where = qs.bucket === 'open' ? `AND o.status IN ('dispatched','in_transit','out_for_delivery','attempted','returning')` : qs.bucket === 'unpaid' ? `AND o.status='delivered' AND o.settled=0` : '';
                const rows = q.all(`SELECT o.id, o.name, o.cust_name, o.city, o.total, o.tracking, o.status, o.courier_status, o.courier_updated, o.courier_fee, o.courier_paid, o.settled, o.settled_at, o.dispatched_at, o.delivered_at,
          CAST(julianday('now')-julianday(o.dispatched_at) AS INT) days FROM orders o WHERE ${CK}=? AND o.tracking IS NOT NULL ${where} ORDER BY o.dispatched_at DESC LIMIT 300`, k);
                return { rows };
            });
            route('GET', '/api/couriers/label/:id', 'couriers', (req, u, b, res, p) => {
                var _a;
                const o = getOrder(decodeURIComponent(p.id));
                need(o && o.tracking, 'Not booked', 404);
                const t = tcsCfg(), city = o.city_code ? q.get('SELECT name FROM cr_tcs_cities WHERE code=?', o.city_code) : null;
                return { order: { id: o.id, name: o.name, cust_name: o.cust_name, phone: o.phone, address: o.address, city: city ? city.name : o.city, total: o.total, cod: (_a = o.courier_cod) !== null && _a !== void 0 ? _a : o.total, tracking: o.tracking, courier: o.courier, dispatched_at: o.dispatched_at, items: o.items },
                    items: q.all('SELECT title, sku, qty FROM order_items WHERE order_id=?', o.id), shipper: { name: t.shipperName || c.setting('store_name', 'SundayBazar'), address: t.shipperAddress || '', city: t.shipperCity || '', mobile: t.shipperMobile || '', account: t.account || '' },
                    service: t.serviceCode || 'O', weight: +t.weight || 1 };
            });
            /* ---- rider runs (office) ---- */
            route('GET', '/api/couriers/runs', 'couriers', (req, u, b, res, p, qs) => {
                const w = [], a = [];
                if (isDate(qs.from)) {
                    w.push('r.day>=?');
                    a.push(qs.from);
                }
                if (isDate(qs.to)) {
                    w.push('r.day<=?');
                    a.push(qs.to);
                }
                if (qs.rider) {
                    w.push('r.rider_id=?');
                    a.push(+qs.rider);
                }
                if (qs.open === '1')
                    w.push("r.status<>'closed'");
                return q.all(`SELECT r.*, u.name rider, h.counted, h.diff, h.expected, COUNT(i.id) parcels, SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed, SUM(i.result IS NULL) pending,
          COALESCE(SUM(i.cod),0) cod, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected
        FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id LEFT JOIN cr_handovers h ON h.run_id=r.id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} GROUP BY r.id ORDER BY r.day DESC, r.id DESC LIMIT 200`, ...a);
            });
            route('POST', '/api/couriers/runs', 'couriers', (req, u, b) => { const r = createRun(b.rider_id, b.day, u, b.note); return r; });
            route('GET', '/api/couriers/runs/:id', 'couriers', (req, u, b, res, p) => {
                const run = runRow(+p.id);
                need(run, 'Run not found', 404);
                const items = runItems(run.id);
                items.forEach(i => { i.wa = L.waNumber(i.phone); i.reason_text = FAIL_REASONS[i.reason] || null; });
                const ho = q.get('SELECT h.*, us.name user FROM cr_handovers h LEFT JOIN users us ON us.id=h.user_id WHERE run_id=?', run.id);
                return { run, items, summary: runSummary(items), handover: ho || null, reasons: FAIL_REASONS, canCash: can(u, 'couriers') || can(u, 'finance') };
            });
            route('POST', '/api/couriers/runs/:id/add', 'couriers', (req, u, b, res, p) => {
                const run = runRow(+p.id);
                need(run, 'Run not found', 404);
                const codes = (b.codes || (b.code ? [b.code] : [])).map(x => String(x).trim()).filter(Boolean);
                need(codes.length, 'Scan or type an order number');
                const results = codes.map(code => (Object.assign({ code }, addToRun(run, getOrder(code), u, !!b.force))));
                return { results };
            });
            route('POST', '/api/couriers/runs/:id/remove', 'couriers', (req, u, b, res, p) => {
                const it = q.get('SELECT * FROM cr_run_items WHERE id=? AND run_id=?', +b.item_id, +p.id);
                need(it, 'Not in this run', 404);
                const run = runRow(it.run_id);
                need(run.status !== 'closed', 'This run is closed');
                need(!it.result, 'The rider already marked this parcel — undo that first');
                q.run('DELETE FROM cr_run_items WHERE id=?', it.id);
                const o = q.get('SELECT * FROM orders WHERE id=?', it.order_id);
                const earlier = q.get("SELECT i.* FROM cr_run_items i WHERE i.order_id=? AND i.back='kept' ORDER BY i.id DESC LIMIT 1", o.id);
                if (earlier) {
                    q.run('UPDATE orders SET rider_run_id=?, courier_status=? WHERE id=?', earlier.run_id, earlier.result === 'rescheduled' ? 'Rescheduled to ' + earlier.resched_to : 'Failed: ' + (FAIL_REASONS[earlier.reason] || 'Other'), o.id);
                    L.refreshOrder(o.id);
                }
                else
                    clearBooking(o);
                log(u.id, 'couriers.run.remove', 'order:' + o.id, { run: run.id });
                return { ok: true };
            });
            route('POST', '/api/couriers/runs/:id/out', 'couriers', (req, u, b, res, p) => {
                const run = runRow(+p.id);
                need(run && run.status === 'open', 'This run is not waiting to leave');
                q.run("UPDATE cr_runs SET status='out', out_at=? WHERE id=?", c.pkNow(), run.id);
                for (const i of q.all('SELECT order_id FROM cr_run_items WHERE run_id=? AND result IS NULL', run.id)) {
                    q.run("UPDATE orders SET courier_status='Out for delivery', courier_updated=? WHERE id=?", nowIso(), i.order_id);
                    L.refreshOrder(i.order_id);
                }
                log(u.id, 'couriers.run.out', 'rider_run:' + run.id, '');
                return { ok: true };
            });
            route('POST', '/api/couriers/runs/:id/delete', 'couriers', (req, u, b, res, p) => {
                const run = runRow(+p.id);
                need(run && run.status === 'open', 'Only a run that has not left can be deleted');
                need(!q.get('SELECT id FROM cr_run_items WHERE run_id=?', run.id), 'Remove the parcels first');
                q.run('DELETE FROM cr_runs WHERE id=?', run.id);
                log(u.id, 'couriers.run.delete', 'rider_run:' + run.id, '');
                return { ok: true };
            });
            route('POST', '/api/couriers/items/:id/result', 'couriers', (req, u, b, res, p) => {
                const it = q.get('SELECT * FROM cr_run_items WHERE id=?', +p.id);
                need(it, 'Not found', 404);
                return setResult(it, u, b);
            });
            route('POST', '/api/couriers/runs/:id/handover', 'dashboard', (req, u, b, res, p) => {
                need(can(u, 'couriers') || can(u, 'finance'), 'Your account does not have access to this', 403);
                const run = runRow(+p.id);
                need(run, 'Run not found', 404);
                return handover(run, u, b);
            });
            route('GET', '/api/couriers/ledger', 'dashboard', (req, u, b, res, p, qs) => {
                need(can(u, 'couriers') || can(u, 'finance'), 'Your account does not have access to this', 403);
                const hos = q.all(`SELECT h.*, u.name rider, us.name user, r.day run_day FROM cr_handovers h LEFT JOIN users u ON u.id=h.rider_id LEFT JOIN users us ON us.id=h.user_id LEFT JOIN cr_runs r ON r.id=h.run_id
        ${qs.rider ? 'WHERE h.rider_id=?' : ''} ORDER BY h.id DESC LIMIT 200`, ...(qs.rider ? [+qs.rider] : []));
                const waiting = q.all(`SELECT r.id, r.day, u.name rider, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected, SUM(i.result IS NULL) pending FROM cr_runs r JOIN users u ON u.id=r.rider_id
        LEFT JOIN cr_run_items i ON i.run_id=r.id WHERE r.status<>'closed' GROUP BY r.id ORDER BY r.day`);
                return { riders: riderLedger(qs.rider), handovers: hos, waiting };
            });
            route('GET', '/api/couriers/rider-fees', 'couriers', (req, u, b, res, p, qs) => riderFees(/^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : c.pkToday().slice(0, 7)));
            route('POST', '/api/couriers/rider-fees/approve', 'couriers', (req, u, b) => {
                need(can(u, 'finance') || can(u, 'accounts_post') || isAdm(u), 'Only the owner or finance can approve rider pay', 403);
                need(/^\d{4}-\d{2}$/.test(b.month || ''), 'Choose the month');
                const f = riderFees(b.month), row = f.rows.find(r => r.rider_id === +b.rider_id);
                need(row, 'No deliveries for this rider in ' + b.month);
                need(row.amount > 0, f.rate ? 'Nothing to pay' : 'Set the per-delivery fee in Couriers → Settings first');
                const A = c.services.accounts;
                need(A, 'Accounts module not available');
                const date = monthEnd(b.month) < c.pkToday() ? monthEnd(b.month) : c.pkToday();
                const jid = A.post({ date, memo: `Rider delivery pay ${b.month} — ${row.rider} (${row.deliveries} × Rs ${row.rate})`, source: 'rider-fees', source_id: `${b.month}:${row.rider_id}`,
                    lines: [{ account: 'Shipping Exp', debit: row.amount }, { account: 'Accrued Expenses', credit: row.amount, party: employeeParty(row.rider_id) }] }, u.id);
                q.run(`INSERT INTO cr_rider_fees(month,rider_id,deliveries,rate,amount,journal_id,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(month,rider_id) DO UPDATE SET deliveries=excluded.deliveries, rate=excluded.rate, amount=excluded.amount, journal_id=excluded.journal_id, approved_by=excluded.approved_by, approved_at=excluded.approved_at`, b.month, row.rider_id, row.deliveries, row.rate, row.amount, jid, u.id);
                log(u.id, 'couriers.fees.approve', 'rider:' + row.rider_id, { month: b.month, amount: row.amount, deliveries: row.deliveries });
                return { ok: true, journal: jid, amount: row.amount };
            });
            route('GET', '/api/couriers/dashboard', 'couriers', (req, u, b, res, p, qs) => {
                const to = isDate(qs.to) ? qs.to : c.pkToday(), from = isDate(qs.from) ? qs.from : addDays(to, -29);
                need(from <= to, 'From date is after To date');
                return Object.assign(Object.assign({}, dashboard(from, to)), { alerts: module.exports.alerts(u, c) });
            });
            /* ---- rider app (the rider sees only his own parcels) ---- */
            const myItem = (u, id) => {
                const it = q.get('SELECT i.*, r.rider_id FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.id=?', +id);
                need(it, 'Parcel not found', 404);
                need(it.rider_id === u.id, 'This parcel is not on your run', 403);
                return it;
            };
            route('GET', '/api/rider/today', 'rider', (req, u) => {
                var _a;
                const today = c.pkToday();
                const runs = q.all(`SELECT id, day, status, out_at FROM cr_runs WHERE rider_id=? AND (day=? OR status<>'closed') ORDER BY day, id`, u.id, today);
                for (const r of runs) {
                    r.items = q.all(`SELECT i.id, i.seq, i.cod, i.result, i.collected, i.reason, i.note, i.resched_to, o.name, o.cust_name, o.phone, o.address, o.city, o.items,
            (SELECT group_concat(title, ' + ') FROM order_items WHERE order_id=o.id) items_text FROM cr_run_items i JOIN orders o ON o.id=i.order_id WHERE i.run_id=? ORDER BY i.seq`, r.id);
                    r.items.forEach(i => { i.wa = L.waNumber(i.phone); });
                    r.summary = runSummary(r.items);
                    r.handed = !!q.get('SELECT id FROM cr_handovers WHERE run_id=?', r.id);
                }
                const week = q.get(`SELECT SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.day>=?`, u.id, addDays(today, -6));
                return { today, runs, reasons: FAIL_REASONS, week, cashWithMe: r2(((_a = riderLedger(u.id)[0]) === null || _a === void 0 ? void 0 : _a.outstanding) || 0) };
            });
            route('POST', '/api/rider/items/:id', 'rider', (req, u, b, res, p) => setResult(myItem(u, p.id), u, b));
            route('POST', '/api/rider/runs/:id/start', 'rider', (req, u, b, res, p) => {
                const run = runRow(+p.id);
                need(run, 'Run not found', 404);
                need(run.rider_id === u.id, 'This is not your run', 403);
                if (run.status === 'open') {
                    q.run("UPDATE cr_runs SET status='out', out_at=? WHERE id=?", c.pkNow(), run.id);
                    for (const i of q.all('SELECT order_id FROM cr_run_items WHERE run_id=? AND result IS NULL', run.id)) {
                        q.run("UPDATE orders SET courier_status='Out for delivery', courier_updated=? WHERE id=?", nowIso(), i.order_id);
                        L.refreshOrder(i.order_id);
                    }
                    log(u.id, 'rider.start', 'rider_run:' + run.id, '');
                }
                return { ok: true };
            });
        },
        jobs: [
            { name: 'tcs-track', every: 60, offset: 20, run: async () => { if (tcsConfigured()) {
                    try {
                        await syncTrack();
                    }
                    catch (e) {
                        ctx.syncLog('tcs', false, 'tracking: ' + e.message);
                    }
                } } },
            { name: 'tcs-payments', every: 60, offset: 40, run: async () => {
                    if (!tcsConfigured() || !tcsCfg().customerNo)
                        return;
                    if (String(setting('couriers_tcs_pay_at', '') || '').slice(0, 10) === ctx.pkToday() || ctx.pkNow().slice(11, 13) < '06')
                        return;
                    try {
                        await syncPayments();
                    }
                    catch (e) {
                        ctx.syncLog('tcs', false, 'payments: ' + e.message);
                        ctx.setSetting('couriers_tcs_pay_at', ctx.pkNow());
                    }
                } },
        ],
        counts(u, c) {
            const out = {};
            if (c.can(u, 'couriers')) {
                out.dispatch = q.get(`SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked','packed') AND tracking IS NULL AND cancelled_at IS NULL`).n;
                out['rider-runs'] = q.get(`SELECT COUNT(*) n FROM cr_runs WHERE status<>'closed' AND day<?`, c.pkToday()).n;
            }
            // the warehouse menu item is the Returns screen now (pick & pack live on the Dispatch desk): badge = returned parcels to receive
            if (c.can(u, 'warehouse'))
                out.warehouse = q.get(`SELECT COUNT(*) n FROM orders WHERE status='returned'`).n;
            if (c.can(u, 'rider'))
                out.rider = q.get(`SELECT COUNT(*) n FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.status<>'closed' AND i.result IS NULL`, u.id).n;
            return out;
        },
        alerts(u, c) {
            const out = [];
            if (c.can(u, 'rider') && !c.can(u, 'couriers')) {
                const n = q.get(`SELECT COUNT(*) n FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.status<>'closed' AND i.result IS NULL`, u.id).n;
                if (n)
                    out.push({ level: 'info', text: `You have ${n} parcel${n > 1 ? 's' : ''} to deliver`, href: '#/rider' });
                return out;
            }
            if (!c.can(u, 'couriers') && !c.can(u, 'finance'))
                return out;
            const today = c.pkToday();
            const st = tcsState();
            if (st.configured && st.failing)
                out.push({ level: 'bad', text: `TCS sync is failing: ${String(st.last.message).slice(0, 120)}`, href: '#/couriers/settings' });
            const late = q.all(`SELECT r.id, r.day, u.name rider, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) cash FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id
      WHERE r.status<>'closed' AND r.day<? GROUP BY r.id`, today);
            for (const r of late.slice(0, 3))
                out.push({ level: 'warn', text: `${r.rider}: cash of ${r.day} run not handed over yet (Rs ${Math.round(r.cash).toLocaleString('en-PK')})`, href: '#/rider-runs/run/' + r.id });
            const sh = q.get(`SELECT COUNT(*) n, COALESCE(SUM(-diff),0) v FROM cr_handovers WHERE diff<0 AND day>=?`, addDays(today, -7));
            if (sh.n)
                out.push({ level: 'warn', text: `Rider cash short ${sh.n} time${sh.n > 1 ? 's' : ''} this week (Rs ${Math.round(sh.v).toLocaleString('en-PK')})`, href: '#/rider-runs/ledger' });
            const stuck = q.get(`SELECT COUNT(*) n FROM orders o WHERE ${CK}='TCS' AND status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < datetime('now','-6 days')`).n;
            if (stuck)
                out.push({ level: 'warn', text: `${stuck} TCS parcel${stuck > 1 ? 's have' : ' has'} not been delivered in 6+ days`, href: '#/couriers/parcels/open' });
            return out;
        },
        activity: {
            'couriers.book': 'Booked parcel (PostEx / TCS)', 'couriers.loadsheet': 'Made PostEx load sheet', 'couriers.handed': 'Handed parcels to courier', 'couriers.handed.undo': 'Undid courier handover', 'couriers.tracking': 'Entered tracking', 'couriers.cancel': 'Cancelled booking', 'couriers.run': 'Created rider run', 'couriers.run.add': 'Put parcel on rider run',
            'couriers.run.remove': 'Took parcel off rider run', 'couriers.run.out': 'Sent rider out', 'couriers.handover': 'Received rider cash', 'couriers.fees.approve': 'Approved rider pay', 'couriers.settings': 'Changed courier settings',
            'couriers.sync': 'Synced courier data', 'rider.delivered': 'Delivered parcel (rider)', 'rider.failed': 'Delivery failed (rider)', 'rider.rescheduled': 'Delivery rescheduled (rider)', 'rider.undo': 'Undid delivery result', 'rider.start': 'Started deliveries',
        },
        _test: { batches, suggest, parseTcsDate, parseTrack, matchCity: (...a) => matchCity(...a), isKarachi: (...a) => isKarachi(...a) },
    };
};