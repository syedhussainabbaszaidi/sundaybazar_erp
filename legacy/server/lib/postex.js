    // PostEx merchant API: parcel status, COD amounts, courier charges, settlement
    'use strict';
    const { q, setting, syncLog } = require('./db');
    const L = require('./logic');
    const BASE = process.env.SB_POSTEX_BASE || 'https://api.postex.pk/services/integration/api/order';
    const token = () => (setting('postex', {}) || {}).token || '';
    const configured = () => !!token();
    async function call(path) {
        const r = await fetch(BASE + path, { headers: { token: token() } });
        const txt = await r.text();
        let j;
        try {
            j = JSON.parse(txt);
        }
        catch (_a) {
            throw new Error('PostEx answered ' + r.status + ': ' + txt.slice(0, 120));
        }
        if (!r.ok || (j.statusCode && String(j.statusCode) !== '200'))
            throw new Error('PostEx: ' + (j.statusMessage || r.status));
        return j;
    }
    // any PostEx call (POST/PUT with a JSON body). opts.pdf: the answer may be a PDF (airway bills, load sheet) -> { pdf: Buffer, type }
    async function send(method, path, body, opts = {}) {
        if (!configured())
            throw new Error('PostEx is not connected. Add the PostEx token in Settings → PostEx.');
        let r;
        try {
            r = await fetch(BASE + path, { method, signal: AbortSignal.timeout(opts.timeout || 30000),
                headers: Object.assign({ token: token(), Accept: opts.pdf ? 'application/pdf, application/json' : 'application/json' }, (body !== undefined ? { 'Content-Type': 'application/json' } : {})),
                body: body !== undefined ? JSON.stringify(body) : undefined });
        }
        catch (e) {
            throw new Error('Cannot reach PostEx (' + (e.name === 'TimeoutError' ? 'no answer in 30 seconds' : (e.cause && e.cause.code) || e.message) + ')');
        }
        const buf = Buffer.from(await r.arrayBuffer());
        if (opts.pdf && r.ok && buf.slice(0, 4).toString() === '%PDF')
            return { pdf: buf, type: 'application/pdf' };
        const txt = buf.toString();
        let j;
        try {
            j = JSON.parse(txt);
        }
        catch (_a) {
            throw new Error('PostEx answered ' + r.status + ': ' + txt.slice(0, 160));
        }
        if (!r.ok || (j.statusCode && String(j.statusCode) !== '200'))
            throw new Error('PostEx: ' + (j.statusMessage || j.message || j.error || ('error ' + r.status)));
        if (opts.pdf) { // some accounts get the PDF as base64 inside JSON
            const d = typeof j.dist === 'string' ? j.dist : (j.dist && (pick(j.dist, 'pdf', 'file', 'data', 'invoice', 'loadSheet') || ''));
            if (typeof d === 'string' && /^JVBER/.test(d))
                return { pdf: Buffer.from(d, 'base64'), type: 'application/pdf' };
            if (typeof d === 'string' && /^https?:\/\//.test(d))
                return { url: d };
            throw new Error('PostEx did not send a PDF' + (j.statusMessage ? ': ' + j.statusMessage : ''));
        }
        return j;
    }
    // read a field whatever its exact capitalisation
    function pick(o, ...names) {
        if (!o || typeof o !== 'object')
            return undefined;
        const map = {};
        for (const k of Object.keys(o))
            map[k.toLowerCase()] = o[k];
        for (const n of names) {
            const v = map[n.toLowerCase()];
            if (v !== undefined && v !== null && v !== '')
                return v;
        }
        return undefined;
    }
    const num = v => (v === undefined || v === null || v === '' || isNaN(+v)) ? null : +v;
    function applyTracking(t) {
        const tn = String(pick(t, 'trackingNumber') || '');
        if (!tn)
            return false;
        const ref = String(pick(t, 'orderRefNumber') || '').trim();
        let o = q.get('SELECT id, px_status FROM orders WHERE tracking=?', tn);
        // a booking cancelled in the ERP must not come back through its order number
        const cancelled = /cancel/i.test(String(pick(t, 'transactionStatus', 'orderStatus', 'status') || ''));
        if (!o && ref && !cancelled) {
            o = q.get('SELECT id, px_status FROM orders WHERE name=? OR name=? OR name=?', ref, '#' + ref.replace(/^#/, ''), ref.replace(/^#/, ''));
            if (o)
                q.run('UPDATE orders SET tracking=?, courier=COALESCE(courier,?) WHERE id=?', tn, 'PostEx', o.id);
        }
        if (!o)
            return false;
        const hist = pick(t, 'transactionStatusHistory') || [];
        const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
        const status = pick(t, 'transactionStatus', 'orderStatus', 'status') || (last && pick(last, 'transactionStatusMessage', 'status')) || null;
        const when = (last && pick(last, 'modifiedDatetime', 'updatedAt', 'dateTime')) || pick(t, 'transactionDate') || null;
        q.run(`UPDATE orders SET px_status=COALESCE(?,px_status), px_updated=COALESCE(?,px_updated), px_history=COALESCE(?,px_history),
      cod=COALESCE(?,cod), px_fee=COALESCE(?,px_fee), px_tax=COALESCE(?,px_tax), px_rev_fee=COALESCE(?,px_rev_fee), px_rev_tax=COALESCE(?,px_rev_tax) WHERE id=?`, status, when, Array.isArray(hist) && hist.length ? JSON.stringify(hist.slice(-15)) : null, num(pick(t, 'invoicePayment', 'codAmount')), num(pick(t, 'transactionFee')), num(pick(t, 'transactionTax')), num(pick(t, 'reversalFee')), num(pick(t, 'reversalTax')), o.id);
        L.refreshOrder(o.id);
        return true;
    }
    const ymd = d => d.toISOString().slice(0, 10);
    // all parcels booked in a date window, in one call per window
    async function syncWindow(from, to) {
        const j = await call(`/v1/get-all-order?orderStatusId=0&startDate=${ymd(from)}&endDate=${ymd(to)}`);
        const list = Array.isArray(j.dist) ? j.dist : (j.dist ? [j.dist] : []);
        let n = 0;
        q.tx(() => { for (const row of list)
            if (applyTracking(pick(row, 'trackingResponse') || row))
                n++; });
        return n;
    }
    async function trackOne(tn) {
        const j = await call(`/v1/track-order/${encodeURIComponent(tn)}`);
        const t = Array.isArray(j.dist) ? j.dist[0] : j.dist;
        return applyTracking(Object.assign({ trackingNumber: tn }, t || {}));
    }
    async function paymentStatus(tn) {
        const j = await call(`/v1/payment-status/${encodeURIComponent(tn)}`);
        const d = Array.isArray(j.dist) ? j.dist[0] : (j.dist || {});
        const settledVal = pick(d, 'settle', 'settled', 'isSettled', 'settlementStatus', 'paymentStatus');
        const settled = settledVal === true || /^(true|yes|settled|paid)$/i.test(String(settledVal || ''));
        const date = pick(d, 'settlementDate', 'settledDate', 'paymentDate');
        const ref = pick(d, 'cprNumber', 'cprNumber_1', 'cpr', 'paymentReference');
        q.run('UPDATE orders SET settled=?, settled_at=COALESCE(?,settled_at), settle_ref=COALESCE(?,settle_ref) WHERE tracking=?', settled ? 1 : 0, date || null, ref ? String(ref) : null, tn);
        return { settled, date, ref, raw: d };
    }
    async function syncAll(onProgress) {
        const days = setting('postex_days', 45);
        let n = 0, errors = [];
        // windows of 7 days
        for (let back = 0; back < days; back += 7) {
            const to = new Date(Date.now() - back * 864e5), from = new Date(Date.now() - Math.min(days, back + 6) * 864e5);
            try {
                n += await syncWindow(from, to);
            }
            catch (e) {
                errors.push(e.message);
            }
            onProgress && onProgress(n);
        }
        // parcels still open that the window call did not cover: track one by one
        const open = q.all(`SELECT tracking FROM orders WHERE tracking IS NOT NULL AND status IN (${L.OPEN_SHIP.map(() => '?').join(',')})
    AND (px_updated IS NULL OR px_updated < datetime('now','-6 hours')) ORDER BY created_at DESC LIMIT 400`, ...L.OPEN_SHIP);
        for (let i = 0; i < open.length; i += 5) {
            await Promise.all(open.slice(i, i + 5).map(o => trackOne(o.tracking).then(ok => { if (ok)
                n++; }).catch(e => errors.push(e.message))));
        }
        // settlement check for delivered, unsettled parcels (newest first, capped)
        if (setting('postex_check_payments', true)) {
            const unpaid = q.all("SELECT tracking FROM orders WHERE status='delivered' AND settled=0 AND tracking IS NOT NULL ORDER BY delivered_at DESC LIMIT 150");
            for (let i = 0; i < unpaid.length; i += 5)
                await Promise.all(unpaid.slice(i, i + 5).map(o => paymentStatus(o.tracking).catch(e => errors.push(e.message))));
        }
        L.recomputeCustomers();
        const uniq = [...new Set(errors)].slice(0, 3);
        syncLog('postex', !uniq.length, n + ' parcels updated' + (uniq.length ? ' · errors: ' + uniq.join(' | ') : ''));
        return { n, errors: uniq };
    }
    module.exports = { configured, call, send, syncAll, trackOne, paymentStatus, applyTracking };
};