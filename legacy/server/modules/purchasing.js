    // Purchasing: suppliers, purchase orders (shoe lots & supplies) → approval → GRN (WMS) → supplier bill → payments, supplier scorecards.
    //
    // Accounting (one entry per lot, never two):
    //  • A lot bought on a PO is NOT posted by the accounts 'lot' auto-entry (accounts skips lots linked to a live PO).
    //  • When the lot is received in WMS (GRN), purchasing posts 'pur-lot' / <lot name>: Dr Purchases (lot cost + extra costs) / Cr Accounts Payable
    //    (party vendor:<supplier>) / Cr Accrued Expenses (party lot:<name>) — the same day WMS moves it Purchases → Unlisted Inventory (source 'grn').
    //  • The supplier bill finalises that SAME entry (re-posted with the billed amount and extra-cost lines); if the billed cost differs, the lot cost,
    //    per-pair cost and the GRN entry follow it. Supplies bills post 'pur-bill' / <bill id>: Dr Packaging (or chosen account) / Cr Accounts Payable.
    //  • Debit notes ('pur-dn'): Dr Accounts Payable / Cr Inventory Damage (damaged pairs) / Cr Discount Received (short or other). Payments and
    //    advances ('pur-pay'): Dr Accounts Payable (vendor) / Cr Cash, Meezan (SB), JazzCash… (an advance leaves a debit balance on the vendor).
    'use strict';
    const STATUSES = ['draft', 'submitted', 'approved', 'sent', 'partial', 'received', 'billed', 'closed', 'cancelled'];
    const OPEN = ['draft', 'submitted', 'approved', 'sent', 'partial', 'received', 'billed'];
    const TYPES = { lots: 'Shoe lots', packaging: 'Packaging & supplies', services: 'Services', other: 'Other' };
    const J = (s, d) => { try {
        return s ? JSON.parse(s) : d;
    }
    catch (_a) {
        return d;
    } };
    const r2 = v => Math.round((+v || 0) * 100) / 100;
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
    const poNo = id => 'PO-' + String(id).padStart(4, '0');
    const fmt = v => 'Rs ' + Math.round(+v || 0).toLocaleString('en-PK');
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let ctx, q;
    const pkDate = utc => utc ? new Date(Date.parse(String(utc).replace(' ', 'T') + (String(utc).includes('Z') ? '' : 'Z')) + 5 * 3600e3).toISOString().slice(0, 10) : null;
    const isAdmin = u => u.role === 'admin';
    const P = {
        view: u => ['listing', 'wms', 'finance', 'accounts_post', 'accounts', 'pricing_apply'].some(p => ctx.can(u, p)),
        create: u => ctx.can(u, 'listing') || ctx.can(u, 'wms'),
        approve: u => isAdmin(u) || ctx.can(u, 'pricing_apply'),
        money: u => ctx.can(u, 'accounts_post') || ctx.can(u, 'finance'),
        supplier: u => isAdmin(u) || ctx.can(u, 'finance'),
        owner: u => isAdmin(u) || ctx.can(u, 'pricing_apply') || ctx.can(u, 'finance'),
    };
    const acc = () => ctx.services.accounts && typeof ctx.services.accounts.post === 'function' ? ctx.services.accounts : null;
    function post(entry, uid) { const a = acc(); if (!a)
        return { posted: false, error: 'Accounts module not available' }; try {
        return { posted: true, id: a.post(entry, uid), error: null };
    }
    catch (e) {
        return { posted: false, error: e.message };
    } }
    function voidPost(source, id, uid, why) { const a = acc(); if (!a)
        return; try {
        a.void(source, id, uid, why);
    }
    catch (_a) { } }
    const vendorBal = name => { const a = acc(); if (!a)
        return 0; try {
        return a.balance('Accounts Payable', null, 'vendor:' + name);
    }
    catch (_a) {
        return 0;
    } };
    /* ---------------- pricing engine (same numbers as the lister) ---------------- */
    const eng = () => ctx.PR.engine(Object.assign({}, ctx.PR.ECON_DEFAULTS, ctx.setting('list_econ', {}) || {}));
    const cleanComp = comp => (Array.isArray(comp) ? comp : []).filter(r => r && +r.n > 0 && r.t && r.c).map(r => ({ t: String(r.t), g: ['Woman', 'Men', 'Kids'].includes(r.g) ? r.g : 'Woman', c: String(r.c), n: Math.round(+r.n), b: String(r.b || '') }));
    // Buy / Think twice / Don't buy, from the store's own lot planner (prices customers pay, ads, courier, overheads, sale plan)
    function verdict(x) {
        const E = eng(), cost = +x.cost || 0, extra = +x.extra || 0, pieces = Math.round(+x.pieces || 0), bad = Math.round(+x.bad || 0), comp = cleanComp(x.comp), total = cost + extra, good = pieces - bad;
        const out = { cost, extra, total, pieces, bad, good, perPair: good > 0 ? Math.round(total / good) : 0, perPiece: pieces ? Math.round(cost / pieces) : 0, verdict: null, perPairCosts: { ads: Math.round(E.E.adsPP), overheads: Math.round(E.E.ohBE) } };
        if (!(cost > 0) || !(pieces > 0))
            return Object.assign(Object.assign({}, out), { why: 'Enter the price and the number of pieces.' });
        if (good <= 0)
            return Object.assign(Object.assign({}, out), { why: 'Bad pairs cannot be equal to or more than the pieces.' });
        if (!comp.length)
            return Object.assign(Object.assign({}, out), { why: 'Add the expected mix (types and condition) to see if this lot will make money.' });
        const plan = c => E.lotPlan({ name: x.name || '', kind: x.kind === 'leftover' ? 'leftover' : 'used', cost: c, extra, pieces, bad, comp });
        const p = plan(cost);
        const fx = good * 0.9 * E.E.ohBE, contrib = p.profit + total + fx, sales = Math.round(p.listed * E.E.mix * 0.9);
        const roi = total ? p.profit / total : 0, slowPct = p.pairs ? p.slow / p.pairs : 0, perPairProfit = Math.round(p.profit / good);
        // highest lot price that still breaks even (bisection on the lot price: profit falls as the price rises)
        let lo = 0, hi = Math.max(cost * 4, 100000);
        if (plan(lo).profit < 0)
            hi = 0;
        else
            for (let i = 0; i < 22; i++) {
                const m = (lo + hi) / 2;
                if (plan(m).profit >= 0)
                    lo = m;
                else
                    hi = m;
            }
        const breakEven = Math.round(lo / 100) * 100;
        const v = roi < 0 ? 'dont' : (roi < 0.15 || slowPct >= 0.4) ? 'think' : 'buy';
        const why = v === 'dont' ? `Loses about ${fmt(-perPairProfit)} per pair after ads, courier and overheads. Pay at most ${fmt(breakEven)} (${fmt(breakEven / pieces)} a piece) to break even.`
            : v === 'think' ? (roi < 0.15 ? `Thin: about ${fmt(perPairProfit)} profit per pair (${Math.round(roi * 100)}% on the money). Try to bring the price down; break-even is ${fmt(breakEven)}.`
                : `Profitable on paper (${fmt(perPairProfit)} a pair) but ${p.slow} pairs (${Math.round(slowPct * 100)}%) are kinds customers usually pay less for than they cost to sell: they will sell slowly.`)
                : `About ${fmt(perPairProfit)} profit per pair after ads, courier and overheads (${Math.round(roi * 100)}% on the money). Pays back after about ${p.payback || '–'} pairs sold.`;
        return Object.assign(Object.assign({}, out), { verdict: v, why, profit: p.profit, perPairProfit, roi: Math.round(roi * 1000) / 10, sales, listed: p.listed, variable: Math.round(sales - contrib), overheads: Math.round(fx), slow: p.slow, slowPct: Math.round(slowPct * 100), payback: p.payback, breakEven, breakEvenPiece: Math.round(breakEven / pieces), per_piece: p.per_piece, cpv: p.cpv, rows: p.rows.map(r => ({ t: r.t, g: r.g, c: r.c, n: r.n, b: r.b, cost: r.cost, price: r.price, min: r.min, slow: r.slow })) });
    }
    /* ---------------- lots table (same rules as POST /api/list/lots) ---------------- */
    function saveLot(name, f) {
        const comp = cleanComp(f.comp), kind = f.kind === 'leftover' ? 'leftover' : 'used';
        const plan = eng().lotPlan({ name, kind, cost: +f.cost, extra: +f.extra || 0, pieces: +f.pieces, bad: +f.bad || 0, comp });
        q.run(`INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,kind,extra,bad,per_piece,cpv,comp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(name) DO UPDATE SET vendor=excluded.vendor,bought_on=excluded.bought_on,cost=excluded.cost,pieces=excluded.pieces,note=excluded.note,kind=excluded.kind,extra=excluded.extra,bad=excluded.bad,per_piece=excluded.per_piece,cpv=excluded.cpv,comp=excluded.comp,updated_at=excluded.updated_at`, name, String(f.vendor || ''), String(f.bought_on || ctx.pkToday()), +f.cost, +f.pieces, String(f.note || ''), kind, +f.extra || 0, +f.bad || 0, plan.per_piece, plan.cpv || null, JSON.stringify(comp));
        return plan;
    }
    const lotRow = name => q.get('SELECT * FROM lots WHERE name=?', name);
    const grnRow = name => { try {
        return q.get('SELECT * FROM wms_grn WHERE lot=?', name);
    }
    catch (_a) {
        return null;
    } };
    function updateLotCost(name, cost, extra) {
        const l = lotRow(name);
        if (!l)
            return false;
        if (Math.abs((+l.cost || 0) - cost) < 0.01 && Math.abs((+l.extra || 0) - extra) < 0.01)
            return false;
        saveLot(name, Object.assign(Object.assign({}, l), { comp: J(l.comp, []), cost, extra }));
        return true;
    }
    /* ---------------- suppliers ---------------- */
    function importVendors() {
        const ins = ctx.db.prepare("INSERT OR IGNORE INTO pur_suppliers(name,type,source) VALUES(?,?,?)");
        let n = 0;
        for (const r of q.all("SELECT DISTINCT TRIM(vendor) v FROM lots WHERE TRIM(COALESCE(vendor,''))<>''"))
            n += ins.run(r.v, 'lots', 'lots').changes;
        for (const v of ['Shamsullah', 'Jabbar', 'Lal Muhammad'])
            n += ins.run(v, 'lots', 'seed').changes; // the owner's shoe-lot suppliers
        try {
            for (const r of q.all("SELECT DISTINCT substr(party,8) v FROM acc_lines WHERE party LIKE 'vendor:%'"))
                if (r.v && r.v.trim() && r.v !== 'Unknown')
                    n += ins.run(r.v.trim(), 'other', 'accounts').changes;
        }
        catch (_a) { }
        return n;
    }
    const supRow = id => q.get('SELECT * FROM pur_suppliers WHERE id=?', +id);
    const supByName = name => q.get('SELECT * FROM pur_suppliers WHERE name=?', String(name || '').trim());
    const termsText = s => !s ? '' : s.terms === 'credit' ? `Credit ${s.credit_days || 30} days` : s.terms === 'instalments' ? `${s.instalments || 3} instalments` : 'Cash on delivery';
    /* ---------------- purchase orders ---------------- */
    const poRow = id => { const p = q.get('SELECT * FROM pur_pos WHERE id=?', +id); if (!p)
        throw new ctx.HttpError(404, 'Purchase order not found'); return p; };
    const linesOf = id => q.all('SELECT * FROM pur_po_lines WHERE po_id=? ORDER BY id', id);
    const billOf = poId => q.get("SELECT * FROM pur_bills WHERE po_id=? AND status<>'void' ORDER BY id DESC LIMIT 1", poId);
    const lotPO = name => q.get("SELECT * FROM pur_pos WHERE kind='lot' AND lot_name=? AND status<>'cancelled' ORDER BY id DESC LIMIT 1", name);
    const rateEff = po => po.pricing === 'lump' ? (po.pieces ? (+po.lump || 0) / po.pieces : 0) : (+po.rate || 0);
    const poAmount = (po, lines) => po.kind === 'lot' ? (po.pricing === 'lump' ? +po.lump || 0 : (+po.rate || 0) * (+po.pieces || 0)) : (lines || linesOf(po.id)).reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
    function nextLotName(supplier) {
        const s = supByName(supplier);
        const taken = new Set(q.all('SELECT name FROM lots UNION SELECT lot_name FROM pur_pos WHERE lot_name IS NOT NULL').map(r => r.name));
        let best = null;
        for (const r of q.all("SELECT name, COALESCE(bought_on,updated_at) d FROM lots WHERE vendor=? UNION ALL SELECT lot_name, created_at FROM pur_pos WHERE supplier=? AND lot_name IS NOT NULL AND status<>'cancelled'", supplier, supplier)) {
            const m = /^(.*?)(\d+)\s*$/.exec(r.name || '');
            if (!m)
                continue;
            const n = +m[2];
            if (!best || n > best.n)
                best = { pre: m[1], n, w: m[2].length };
        }
        let pre, n, w;
        if (best)
            ({ pre, n, w } = best);
        else {
            const words = String(supplier || 'Lot').trim().split(/\s+/).filter(Boolean);
            const p = s && s.prefix ? s.prefix : words.length === 1 ? words[0].slice(0, 2).toUpperCase() : words[0].length <= 3 ? words[0].toUpperCase() : words.map(x => x[0]).join('').slice(0, 3).toUpperCase();
            pre = p + '-Lot ';
            n = 0;
            w = 2;
        }
        let name;
        do {
            n++;
            name = pre + String(n).padStart(w, '0');
        } while (taken.has(name));
        return name;
    }
    // money on a PO / bill: advances (paid before the bill), bill payments, debit notes
    function money(po) {
        const adv = q.get("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", po.id).v;
        const bill = billOf(po.id);
        const paid = bill ? q.get("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE bill_id=?", bill.id).v : 0;
        const dn = q.get('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', po.id).v;
        const net = bill ? r2(bill.goods - dn) : null;
        return { advance: r2(adv), paidOnBill: r2(paid), debitNotes: r2(dn), billed: bill ? r2(bill.goods) : null, net, due: bill ? r2(net - adv - paid) : null };
    }
    function grnDiff(po) {
        if (po.kind !== 'lot' || !po.lot_name)
            return null;
        const g = grnRow(po.lot_name);
        if (!g)
            return null;
        const received = (+g.good || 0) + (+g.damaged || 0), expected = +po.pieces || 0, rate = rateEff(po);
        // pairs rejected later at sorting / QC (Stock line) count as damaged for the supplier claim
        const sl = ctx.services.stockline, qcBad = sl && sl.extraBad ? (+sl.extraBad(po.lot_name) || 0) : 0, damaged = (+g.damaged || 0) + qcBad;
        const short = Math.max(0, expected - received), extra = Math.max(0, received - expected), expBad = +po.bad_est || 0, extraDamaged = Math.max(0, damaged - expBad);
        const claim = Math.round(po.pricing === 'lump' ? (short + extraDamaged) * rate : extraDamaged * rate);
        return { expected, received, good: +g.good || 0, damaged, qcRejected: qcBad, short, extra, expBad, extraDamaged, rate: Math.round(rate), claim,
            billFor: Math.round(po.pricing === 'lump' ? +po.lump || 0 : rate * received), received_at: g.received_at, ok: !short && !extra && !extraDamaged };
    }
    // three-way match: PO (agreed rate) × GRN (received) vs bill
    function matchFor(po, goods) {
        let expected;
        if (po.kind === 'lot') {
            const d = grnDiff(po);
            expected = d ? d.billFor : poAmount(po);
        }
        else
            expected = linesOf(po.id).reduce((s, l) => s + (+l.received || 0) * (+l.rate || 0), 0);
        expected = Math.round(expected);
        return { po: Math.round(poAmount(po)), expected, billed: Math.round(goods), warn: goods > expected + 1, diff: Math.round(goods - expected) };
    }
    // the one purchase entry of a lot bought on a PO
    function postLot(po, uid) {
        if (!po.lot_name || !po.received_on)
            return { posted: false, error: null };
        const l = lotRow(po.lot_name);
        if (!l || !(+l.cost > 0))
            return { posted: false, error: 'Lot has no cost' };
        const bill = billOf(po.id), sup = 'vendor:' + po.supplier;
        const extras = bill ? J(bill.extras, []) : (+l.extra > 0 ? [{ label: 'Extra costs (transport, cleaning)', amount: +l.extra, paid_from: 'accrued' }] : []);
        const ex = r2(extras.reduce((s, e) => s + (+e.amount || 0), 0));
        const lines = [{ account: 'Purchases', debit: r2(+l.cost + ex) }, { account: 'Accounts Payable', credit: r2(+l.cost), party: sup }];
        for (const e of extras)
            if (+e.amount > 0)
                lines.push(e.paid_from && e.paid_from !== 'accrued' ? { account: e.paid_from, credit: r2(e.amount), memo: e.label } : { account: 'Accrued Expenses', credit: r2(e.amount), party: 'lot:' + po.lot_name, memo: e.label });
        const memo = `Lot ${po.lot_name} bought from ${po.supplier} (${poNo(po.id)}${bill ? ', bill ' + (bill.bill_no || '#' + bill.id) : ''})` + (l.pieces ? ` — ${l.pieces} pairs` : '') + (ex ? ` + ${fmt(ex)} extra costs` : '');
        const r = post({ date: po.received_on, memo, source: 'pur-lot', source_id: po.lot_name, lines, meta: { po: po.id, bill: bill ? bill.id : null } }, uid);
        q.run('UPDATE pur_pos SET post_error=? WHERE id=?', r.error, po.id);
        return r;
    }
    function setStatus(po, status, extra = {}) {
        const cols = Object.keys(extra);
        q.run(`UPDATE pur_pos SET status=?, updated_at=datetime('now')${cols.map(c => `, ${c}=?`).join('')} WHERE id=?`, status, ...cols.map(c => extra[c]), po.id);
    }
    function maybeClose(po, uid) {
        po = poRow(po.id);
        const m = money(po);
        if (po.status === 'billed' && m.due != null && m.due <= 0.5) {
            setStatus(po, 'closed', { closed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
            q.run("UPDATE pur_bills SET status='paid' WHERE po_id=? AND status='posted'", po.id);
            ctx.log(uid, 'pur.po.close', 'po:' + po.id, { auto: true });
        }
    }
    // instalments: what is paid goes to the earliest due first
    function schedule(bill, paidTotal) {
        let left = paidTotal;
        return q.all('SELECT * FROM pur_instalments WHERE bill_id=? ORDER BY due, id', bill.id).map(i => { const p = Math.min(i.amount, Math.max(0, left)); left -= p; return Object.assign(Object.assign({}, i), { paid: r2(p), open: r2(i.amount - p) }); });
    }
    function billState(b) {
        const po = b.po_id ? q.get('SELECT * FROM pur_pos WHERE id=?', b.po_id) : null;
        const adv = po ? q.get("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", po.id).v : 0;
        const paid = q.get('SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE bill_id=?', b.id).v;
        const dn = po ? q.get('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', po.id).v : 0;
        const net = r2(b.goods - dn), due = r2(net - adv - paid), inst = schedule(b, paid); // instalments cover what is left after the advance
        const next = inst.find(i => i.open > 0.5);
        return Object.assign(Object.assign({}, b), { extras: J(b.extras, []), match: J(b.match, null), po_no: po ? poNo(po.id) : '', lot_name: po ? po.lot_name : null, kind: po ? po.kind : 'supplies', advance: r2(adv), paid: r2(paid), debitNotes: r2(dn), net, due, instalments: inst, nextDue: next ? next.due : b.due_date, nextAmount: next ? next.open : due });
    }
    const openBills = () => q.all("SELECT * FROM pur_bills WHERE status='posted' ORDER BY due_date").map(billState).filter(b => b.due > 0.5);
    function payables() {
        const today = ctx.pkToday(), wk = addDays(today, 7), rows = openBills().map(b => (Object.assign(Object.assign({}, b), { bucket: b.nextDue < today ? 'overdue' : b.nextDue <= wk ? 'week' : 'later', late: b.nextDue < today ? daysBetween(b.nextDue, today) : 0 })));
        const t = k => r2(rows.filter(r => r.bucket === k).reduce((s, r) => s + (k === 'later' ? r.due : r.nextAmount), 0));
        return { rows, totals: { overdue: t('overdue'), week: t('week'), later: r2(rows.reduce((s, r) => s + r.due, 0)) }, counts: { overdue: rows.filter(r => r.bucket === 'overdue').length, week: rows.filter(r => r.bucket === 'week').length, later: rows.filter(r => r.bucket === 'later').length } };
    }
    /* ---------------- lot P&L and supplier scorecard ---------------- */
    function lotPnl(name) {
        const l = lotRow(name);
        if (!l)
            return null;
        const E = eng(), total = (+l.cost || 0) + (+l.extra || 0), g = grnRow(name), po = lotPO(name);
        const good = g ? +g.good || 0 : Math.max(0, (+l.pieces || 0) - (+l.bad || 0));
        const prods = q.all('SELECT sku, price, cost, qty, created_at, sold_at, ptype FROM products WHERE lot=?', name);
        const lister = q.get('SELECT COUNT(*) n FROM listings WHERE lot=? AND sku NOT IN (SELECT sku FROM products WHERE lot=? AND sku IS NOT NULL)', name, name).n;
        const listed = prods.length + lister;
        const age = p => p.sold_at ? (Date.parse(p.sold_at) - Date.parse(p.created_at)) / 864e5 : null;
        const sold = prods.filter(p => p.qty <= 0 && p.sold_at), sold60 = sold.filter(p => age(p) <= 60).length, sold120 = sold.filter(p => age(p) <= 120).length;
        const del = q.all(`SELECT i.price, i.qty, p.cost, p.ptype FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.variant_id=i.variant_id WHERE p.lot=? AND o.status='delivered'`, name);
        const pp = (+l.per_piece > 0 ? +l.per_piece : (good ? total / good : 0));
        let revenue = 0, contrib = 0, soldCost = 0, n = 0;
        for (const d of del) {
            const q1 = +d.qty || 1;
            n += q1;
            revenue += d.price * q1;
            contrib += E.breakdown(d.price, 0, d.ptype).own * q1;
            soldCost += (+d.cost > 0 ? +d.cost : pp) * q1;
        }
        const stock = prods.filter(p => p.qty > 0), unlisted = Math.max(0, good - listed);
        const profit = Math.round(contrib - total);
        return { name, vendor: l.vendor || '', bought_on: l.bought_on || '', po: po ? { id: po.id, no: poNo(po.id), status: po.status } : null, pieces: +l.pieces || 0, good, cost: +l.cost || 0, extra: +l.extra || 0, total: Math.round(total), perPair: Math.round(pp),
            received: !!g, started: !!g || listed > 0, damaged: g ? +g.damaged || 0 : null, listed, listedPct: good ? Math.min(100, Math.round(100 * listed / good)) : 0, sold: sold.length, delivered: n, revenue: Math.round(revenue), avgPrice: n ? Math.round(revenue / n) : null,
            afterCosts: Math.round(contrib), profit, profitPerPair: n ? Math.round((contrib - soldCost) / n) : null, roi: total ? Math.round(1000 * profit / total) / 10 : null,
            sellThrough60: listed ? Math.round(100 * sold60 / listed) : null, sellThrough120: listed ? Math.round(100 * sold120 / listed) : null,
            unsold: { pairs: stock.length, price: Math.round(stock.reduce((s, p) => s + (+p.price || 0), 0)), cost: Math.round(stock.reduce((s, p) => s + (+p.cost || pp), 0)), unlisted, unlistedCost: Math.round(unlisted * pp) },
            paidBack: total ? Math.round(100 * contrib / total) : null };
    }
    function scorecard(vendor, months) {
        const from = addDays(ctx.pkToday(), -Math.round(months * 30.4));
        const lots = q.all("SELECT name FROM lots WHERE vendor=? AND COALESCE(bought_on,'')>=? ORDER BY bought_on DESC", vendor, from).map(r => lotPnl(r.name)).filter(Boolean);
        const s = { supplier: vendor, months, lots: lots.length, pieces: 0, total: 0, expected: 0, received: 0, short: 0, damaged: 0, listed: 0, s60: 0, s120: 0, delivered: 0, revenue: 0, profit: 0, afterCosts: 0, soldCostAdj: 0, lateDays: [], onTime: 0, withDate: 0 };
        for (const l of lots) {
            s.pieces += l.pieces;
            s.spent = (s.spent || 0) + l.total;
            s.listed += l.listed;
            s.delivered += l.delivered;
            s.revenue += l.revenue;
            if (l.started) {
                s.total += l.total;
                s.profit += l.profit;
                s.afterCosts += l.afterCosts;
            }
            if (l.profitPerPair != null)
                s.soldCostAdj += l.profitPerPair * l.delivered;
            if (l.listed) {
                s.s60 += (l.sellThrough60 || 0) * l.listed / 100;
                s.s120 += (l.sellThrough120 || 0) * l.listed / 100;
            }
            const g = grnRow(l.name);
            if (g) {
                const po = lotPO(l.name);
                const exp = po ? +po.pieces || 0 : (+g.expected || l.pieces);
                s.expected += exp;
                s.received += (+g.good || 0) + (+g.damaged || 0);
                s.short += Math.max(0, exp - (+g.good || 0) - (+g.damaged || 0));
                s.damaged += +g.damaged || 0;
                if (po && po.expected_date && po.received_on) {
                    const late = daysBetween(po.expected_date, po.received_on);
                    s.lateDays.push(late);
                    s.withDate++;
                    if (late <= 0)
                        s.onTime++;
                }
            }
        }
        const avgLate = s.lateDays.length ? Math.round(10 * s.lateDays.reduce((a, b) => a + b, 0) / s.lateDays.length) / 10 : null;
        return { supplier: vendor, months, lots: s.lots, pieces: s.pieces, spent: Math.round(s.spent || 0), avgCost: s.pieces ? Math.round((s.spent || 0) / s.pieces) : null, started: lots.filter(l => l.started).length,
            shortPct: s.expected ? Math.round(1000 * s.short / s.expected) / 10 : null, damagePct: s.received ? Math.round(1000 * s.damaged / s.received) / 10 : null,
            avgLateDays: avgLate, onTimePct: s.withDate ? Math.round(100 * s.onTime / s.withDate) : null,
            sellThrough60: s.listed ? Math.round(100 * s.s60 / s.listed) : null, sellThrough120: s.listed ? Math.round(100 * s.s120 / s.listed) : null,
            delivered: s.delivered, avgPrice: s.delivered ? Math.round(s.revenue / s.delivered) : null, profitPerPair: s.delivered ? Math.round(s.soldCostAdj / s.delivered) : null,
            profit: Math.round(s.profit), roi: s.total ? Math.round(1000 * s.profit / s.total) / 10 : null, lotList: lots };
    }
    function allScores(months) {
        importVendors();
        return q.all("SELECT name FROM pur_suppliers WHERE active=1 AND type IN ('lots','other') ORDER BY name").map(r => scorecard(r.name, months)).filter(s => s.lots > 0).map(s => { const { lotList } = s, rest = __rest(s, ["lotList"]); return Object.assign(Object.assign({}, rest), { lotsRoi: lotList.map(l => ({ name: l.name, roi: l.roi })) }); });
    }
    /* ---------------- summary for home / badges ---------------- */
    function summary() {
        const today = ctx.pkToday(), wk = addDays(today, 7);
        const awaiting = q.get("SELECT COUNT(*) n FROM pur_pos WHERE status='submitted'").n;
        const open = q.get(`SELECT COUNT(*) n FROM pur_pos WHERE status IN ('submitted','approved','sent','partial','received','billed')`).n;
        const arriving = q.get("SELECT COUNT(*) n FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<=?", wk).n;
        const late = q.get("SELECT COUNT(*) n FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<?", today).n;
        const notBilled = q.get("SELECT COUNT(*) n FROM pur_pos WHERE status='received'").n;
        const pay = payables();
        return { awaitingApproval: awaiting, openPOs: open, arrivingThisWeek: arriving, late, receivedNotBilled: notBilled, payablesDue: r2(pay.totals.overdue + pay.totals.week), overdue: pay.totals.overdue, overdueBills: pay.counts.overdue, payablesTotal: pay.totals.later };
    }
    module.exports = {
        name: 'purchasing',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS pur_suppliers(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT DEFAULT 'lots', phone TEXT, whatsapp TEXT, city TEXT, address TEXT, bank TEXT,
  terms TEXT DEFAULT 'cash', credit_days INTEGER, instalments INTEGER, prefix TEXT, note TEXT, active INTEGER DEFAULT 1, source TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
CREATE TABLE IF NOT EXISTS pur_pos(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, supplier TEXT NOT NULL, status TEXT DEFAULT 'draft', lot_name TEXT, lot_kind TEXT, pieces INTEGER, pricing TEXT, rate REAL, lump REAL,
  mix TEXT, bad_est INTEGER DEFAULT 0, extras TEXT, extra_total REAL DEFAULT 0, expected_date TEXT, advance_plan REAL DEFAULT 0, terms TEXT, credit_days INTEGER, instalments INTEGER, notes TEXT, files TEXT, plan TEXT,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT, submitted_at TEXT, approved_by INTEGER, approved_at TEXT, sent_at TEXT, received_on TEXT, billed_at TEXT, closed_at TEXT,
  cancelled_at TEXT, cancelled_by INTEGER, cancel_reason TEXT, settlement TEXT, post_error TEXT);
CREATE INDEX IF NOT EXISTS ix_pur_pos_status ON pur_pos(status);
CREATE INDEX IF NOT EXISTS ix_pur_pos_lot ON pur_pos(lot_name);
CREATE TABLE IF NOT EXISTS pur_po_lines(id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, item TEXT, qty REAL, unit TEXT, rate REAL, received REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_pur_lines_po ON pur_po_lines(po_id);
CREATE TABLE IF NOT EXISTS pur_bills(id INTEGER PRIMARY KEY, po_id INTEGER, supplier TEXT NOT NULL, bill_no TEXT, bill_date TEXT, due_date TEXT, goods REAL, extras TEXT, extra_total REAL DEFAULT 0, account TEXT,
  match TEXT, file_id TEXT, status TEXT DEFAULT 'posted', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), post_error TEXT);
CREATE INDEX IF NOT EXISTS ix_pur_bills_po ON pur_bills(po_id);
CREATE TABLE IF NOT EXISTS pur_instalments(id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL, due TEXT, amount REAL);
CREATE TABLE IF NOT EXISTS pur_payments(id INTEGER PRIMARY KEY, supplier TEXT NOT NULL, po_id INTEGER, bill_id INTEGER, kind TEXT DEFAULT 'payment', date TEXT, amount REAL, account TEXT, ref TEXT, note TEXT,
  user_id INTEGER, at TEXT DEFAULT (datetime('now')), post_error TEXT);
CREATE INDEX IF NOT EXISTS ix_pur_pay_sup ON pur_payments(supplier);
CREATE TABLE IF NOT EXISTS pur_debit_notes(id INTEGER PRIMARY KEY, po_id INTEGER, supplier TEXT, date TEXT, kind TEXT, short_pcs INTEGER DEFAULT 0, damaged_pcs INTEGER DEFAULT 0, amount REAL, reason TEXT,
  transfer_id INTEGER, user_id INTEGER, at TEXT DEFAULT (datetime('now')), post_error TEXT);`,
        activity: {
            'pur.supplier.save': 'Saved supplier', 'pur.po.create': 'Created purchase order', 'pur.po.edit': 'Edited purchase order', 'pur.po.submit': 'Sent PO for approval', 'pur.po.approve': 'Approved purchase order',
            'pur.po.send': 'Sent PO to supplier', 'pur.po.cancel': 'Cancelled purchase order', 'pur.po.close': 'Closed purchase order', 'pur.po.receive': 'Received supplies', 'pur.advance': 'Paid supplier advance',
            'pur.bill': 'Entered supplier bill', 'pur.pay': 'Paid supplier', 'pur.settle': 'Settled lot difference with supplier',
        },
        migrate(c) { ctx = c; q = c.q; },
        routes(c) {
            const { route, need, log } = c;
            const view = u => need(P.view(u), 'Your account does not have access to purchasing', 403);
            const today = () => c.pkToday();
            // cash & bank accounts to pay from; JazzCash (wallet many suppliers are paid from) is offered too and added to the chart the first time it is used
            const cashAccounts = () => { let l; try {
                l = q.all("SELECT name FROM acc_accounts WHERE grp='cash' AND type='asset' AND active=1 ORDER BY code").map(r => r.name);
            }
            catch (_a) {
                l = ['Cash', 'Meezan (SB)'];
            } return l.some(n => n.toLowerCase() === 'jazzcash') ? l : l.concat('JazzCash'); };
            const ensureJazz = a => { if (a !== 'JazzCash')
                return; try {
                if (!q.get("SELECT id FROM acc_accounts WHERE lower(name)='jazzcash'"))
                    q.run("INSERT INTO acc_accounts(code,name,type,statement,grp,system) VALUES(?, 'JazzCash', 'asset', 'BS', 'cash', 0)", q.get("SELECT 1 FROM acc_accounts WHERE code='1030'") ? null : '1030');
            }
            catch (_a) { } };
            const expenseAccounts = () => { try {
                return q.all("SELECT name FROM acc_accounts WHERE type='expense' AND active=1 ORDER BY code").map(r => r.name).filter(n => !['Cost of Goods Sold', 'Salary Exp', 'Social Media Marketing', 'Inventory Damage'].includes(n));
            }
            catch (_a) {
                return ['Packaging'];
            } };
            const checkAcct = a => { need(cashAccounts().includes(a), 'Choose where the money was paid from'); ensureJazz(a); };
            route('GET', '/api/pur/meta', 'dashboard', (req, u) => {
                view(u);
                importVendors();
                return { types: c.PR.types(), conds: c.PR.CONDS, statuses: STATUSES, supTypes: TYPES, store: c.setting('store_name', 'SundayBazar'),
                    suppliers: q.all('SELECT id,name,type,phone,whatsapp,terms,credit_days,instalments,active FROM pur_suppliers ORDER BY active DESC, name'),
                    cashAccounts: cashAccounts(), expenseAccounts: expenseAccounts(), can: { create: P.create(u), approve: P.approve(u), money: P.money(u), supplier: P.supplier(u), owner: P.owner(u) } };
            });
            /* ---------- suppliers ---------- */
            route('GET', '/api/pur/suppliers', 'dashboard', (req, u, b, res, p, qs) => {
                view(u);
                importVendors();
                const months = +qs.months === 12 ? 12 : 6;
                const scores = P.owner(u) ? new Map(allScores(months).map(s => [s.supplier, s])) : new Map();
                return q.all('SELECT * FROM pur_suppliers ORDER BY active DESC, name').map(s => (Object.assign(Object.assign({}, s), { termsText: termsText(s), openPOs: q.get(`SELECT COUNT(*) n FROM pur_pos WHERE supplier=? AND status IN ('draft','submitted','approved','sent','partial','received','billed')`, s.name).n, lots: q.get('SELECT COUNT(*) n FROM lots WHERE vendor=?', s.name).n, payable: P.money(u) || P.owner(u) ? r2(-vendorBal(s.name)) : null, score: scores.get(s.name) || null })));
            });
            route('POST', '/api/pur/suppliers/import', 'dashboard', (req, u) => { need(P.supplier(u), 'Only the owner or finance can edit suppliers', 403); const n = importVendors(); log(u.id, 'pur.supplier.save', 'suppliers', { imported: n }); return { ok: true, imported: n }; });
            route('POST', '/api/pur/suppliers', 'dashboard', (req, u, b) => {
                need(P.supplier(u), 'Only the owner or finance can edit suppliers', 403);
                const name = String(b.name || '').trim().replace(/\s+/g, ' ');
                need(name, 'Enter the supplier name');
                need(name.length <= 60, 'Name is too long');
                let ex = b.id ? supRow(b.id) : null;
                if (b.id)
                    need(ex, 'Supplier not found', 404);
                const dup = supByName(name);
                if (!ex && dup) {
                    const full = q.get('SELECT * FROM pur_suppliers WHERE id=?', dup.id);
                    if (full && full.source === 'seed') {
                        ex = full;
                        q.run("UPDATE pur_suppliers SET source='manual' WHERE id=?", full.id);
                    }
                } // pre-filled name only: adding it again fills in its details
                need(!dup || (ex && dup.id === ex.id), 'A supplier with this name already exists');
                need(!dup || (ex && dup.id === ex.id), 'A supplier with this name already exists');
                if (ex && ex.name !== name)
                    need(!q.get('SELECT 1 FROM lots WHERE vendor=? LIMIT 1', ex.name) && !q.get('SELECT 1 FROM pur_pos WHERE supplier=? LIMIT 1', ex.name) && !(acc() && Math.abs(vendorBal(ex.name)) > 0.009) && !q.get('SELECT 1 FROM pur_payments WHERE supplier=? LIMIT 1', ex.name), 'This supplier already has lots, POs or a balance in the accounts under its name, so the name cannot change (it links them).');
                const terms = ['cash', 'credit', 'instalments'].includes(b.terms) ? b.terms : 'cash';
                const v = [name, TYPES[b.type] ? b.type : 'lots', String(b.phone || '').trim(), String(b.whatsapp || '').replace(/[^\d]/g, ''), String(b.city || '').trim(), String(b.address || '').trim(), String(b.bank || '').trim(),
                    terms, terms === 'credit' ? Math.max(1, +b.credit_days || 30) : null, terms === 'instalments' ? Math.max(2, +b.instalments || 3) : null, String(b.prefix || '').trim().toUpperCase().slice(0, 6) || null, String(b.note || '').trim(), b.active === false ? 0 : 1];
                let id;
                if (ex) {
                    q.run("UPDATE pur_suppliers SET name=?,type=?,phone=?,whatsapp=?,city=?,address=?,bank=?,terms=?,credit_days=?,instalments=?,prefix=?,note=?,active=?,updated_at=datetime('now') WHERE id=?", ...v, ex.id);
                    id = ex.id;
                }
                else
                    id = Number(q.run("INSERT INTO pur_suppliers(name,type,phone,whatsapp,city,address,bank,terms,credit_days,instalments,prefix,note,active,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'manual')", ...v).lastInsertRowid);
                log(u.id, 'pur.supplier.save', 'supplier:' + id, { name });
                return { ok: true, id };
            });
            route('GET', '/api/pur/suppliers/:id', 'dashboard', (req, u, b, res, p, qs) => {
                view(u);
                const s = supRow(p.id);
                need(s, 'Supplier not found', 404);
                const owner = P.owner(u), fin = P.money(u) || owner;
                const months = +qs.months === 12 ? 12 : 6, bal = vendorBal(s.name);
                const pos = q.all('SELECT * FROM pur_pos WHERE supplier=? ORDER BY id DESC LIMIT 200', s.name).map(po => poBrief(po, fin));
                const pays = fin ? q.all('SELECT py.*, us.name by_name FROM pur_payments py LEFT JOIN users us ON us.id=py.user_id WHERE supplier=? ORDER BY date DESC, id DESC LIMIT 200', s.name) : [];
                const sc = owner ? scorecard(s.name, months) : null;
                const lots = q.all('SELECT name, bought_on, pieces, cost, extra FROM lots WHERE vendor=? ORDER BY COALESCE(bought_on,updated_at) DESC LIMIT 100', s.name).map(l => { const x = owner ? lotPnl(l.name) : null; return owner ? x : { name: l.name, bought_on: l.bought_on, pieces: l.pieces }; });
                const openAdv = fin ? r2(q.get(`SELECT COALESCE(SUM(py.amount),0) v FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.supplier=? AND py.kind='advance' AND po.status IN ('approved','sent','partial','received')`, s.name).v) : null;
                return { supplier: Object.assign(Object.assign({}, s), { termsText: termsText(s) }), balance: fin ? r2(bal) : null, payable: fin ? r2(Math.max(0, -bal)) : null, advance: fin ? r2(Math.max(0, bal)) : null, openAdvances: openAdv,
                    pos, payments: pays, bills: fin ? q.all('SELECT * FROM pur_bills WHERE supplier=? ORDER BY id DESC LIMIT 100', s.name).map(billState) : [], lots, scorecard: sc ? ((_a) => {
                        var { lotList } = _a, r = __rest(_a, ["lotList"]);
                        return r;
                    })(sc) : null };
            });
            // a payment not tied to a bill (old balance, e.g. lots bought before purchasing was used)
            route('POST', '/api/pur/suppliers/:id/pay', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u), 'Only finance can record payments', 403);
                const s = supRow(p.id);
                need(s, 'Supplier not found', 404);
                return recordPayment(Object.assign({ supplier: s.name, kind: 'payment' }, b), u);
            });
            /* ---------- planner & lot names ---------- */
            route('GET', '/api/pur/next-lot', 'dashboard', (req, u, b, res, p, qs) => { view(u); return { name: nextLotName(String(qs.supplier || '')) }; });
            route('POST', '/api/pur/plan', 'dashboard', (req, u, b) => {
                view(u);
                const pieces = +b.pieces || 0, cost = b.pricing === 'lump' ? +b.lump || 0 : (+b.rate || 0) * pieces;
                const extra = Array.isArray(b.extras) ? b.extras.reduce((s, e) => s + (+e.amount || 0), 0) : +b.extra || 0;
                const v = verdict({ name: b.lot_name, kind: b.lot_kind, cost, extra, pieces, bad: +b.bad_est || 0, comp: b.mix });
                if (!P.owner(u))
                    delete v.rows;
                return v;
            });
            /* ---------- purchase orders ---------- */
            function poBrief(po, fin) {
                const lines = po.kind === 'supplies' ? linesOf(po.id) : null, m = fin ? money(po) : null, plan = J(po.plan, null);
                return { id: po.id, no: poNo(po.id), kind: po.kind, supplier: po.supplier, status: po.status, lot_name: po.lot_name, pieces: po.pieces, amount: Math.round(poAmount(po, lines)), expected_date: po.expected_date,
                    created_at: po.created_at, submitted_at: po.submitted_at, approved_at: po.approved_at, received_on: po.received_on, items: lines ? lines.length : null, verdict: plan ? plan.verdict : null, money: m,
                    late: ['approved', 'sent', 'partial'].includes(po.status) && po.expected_date && po.expected_date < today() ? daysBetween(po.expected_date, today()) : 0 };
            }
            route('GET', '/api/pur/pos', 'dashboard', (req, u, b, res, p, qs) => {
                view(u);
                const w = [], a = [];
                if (qs.status === 'open')
                    w.push(`status IN ('draft','submitted','approved','sent','partial','received','billed')`);
                else if (qs.status === 'mine') {
                    w.push("status='draft' AND created_by=?");
                    a.push(u.id);
                }
                else if (STATUSES.includes(qs.status)) {
                    w.push('status=?');
                    a.push(qs.status);
                }
                if (qs.supplier) {
                    w.push('supplier=?');
                    a.push(qs.supplier);
                }
                if (qs.kind) {
                    w.push('kind=?');
                    a.push(qs.kind);
                }
                const fin = P.money(u) || P.owner(u);
                const rows = q.all(`SELECT * FROM pur_pos ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, ...a).map(po => poBrief(po, fin));
                const counts = Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM pur_pos GROUP BY status').map(r => [r.status, r.n]));
                counts.mine = q.get("SELECT COUNT(*) n FROM pur_pos WHERE status='draft' AND created_by=?", u.id).n;
                return { rows, counts };
            });
            function poFull(po, u) {
                const fin = P.money(u) || P.owner(u), lines = linesOf(po.id), bill = billOf(po.id);
                const us = id => id ? (q.get('SELECT name FROM users WHERE id=?', id) || {}).name || '' : '';
                const sup = supByName(po.supplier);
                const plan = J(po.plan, null);
                if (plan && !P.owner(u))
                    delete plan.rows;
                return { po: Object.assign(Object.assign({}, po), { no: poNo(po.id), mix: J(po.mix, []), extras: J(po.extras, []), files: J(po.files, []), settlement: J(po.settlement, null), plan, amount: Math.round(poAmount(po, lines)), created_name: us(po.created_by), approved_name: us(po.approved_by), cancelled_name: us(po.cancelled_by) }),
                    supplier: sup ? Object.assign(Object.assign({}, sup), { termsText: termsText(sup) }) : { name: po.supplier }, lines, grn: grnDiff(po), lot: po.lot_name && fin ? lotRow(po.lot_name) : null,
                    money: fin ? money(po) : null, bill: bill && fin ? billState(bill) : null,
                    payments: fin ? q.all('SELECT py.*, us.name by_name FROM pur_payments py LEFT JOIN users us ON us.id=py.user_id WHERE py.po_id=? OR py.bill_id IN (SELECT id FROM pur_bills WHERE po_id=?) ORDER BY py.date, py.id', po.id, po.id) : [],
                    debitNotes: q.all('SELECT * FROM pur_debit_notes WHERE po_id=? ORDER BY id', po.id),
                    history: q.all("SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.entity=? ORDER BY e.id", 'po:' + po.id),
                    can: { edit: ['draft', 'submitted'].includes(po.status) && (P.create(u) && (po.created_by === u.id || P.approve(u))), submit: po.status === 'draft' && P.create(u), approve: po.status === 'submitted' && P.approve(u),
                        send: po.status === 'approved' && (P.create(u) || P.approve(u)), cancel: ['draft', 'submitted', 'approved', 'sent'].includes(po.status) && (P.approve(u) || (po.status === 'draft' && po.created_by === u.id)),
                        advance: ['approved', 'sent', 'partial', 'received'].includes(po.status) && P.money(u), receive: po.kind === 'supplies' && ['approved', 'sent', 'partial'].includes(po.status) && P.create(u),
                        receiveLot: po.kind === 'lot' && ['approved', 'sent', 'partial', 'received'].includes(po.status) && c.can(u, 'wms'),
                        bill: ['received', 'partial', 'billed'].includes(po.status) && P.money(u) && !(bill && bill.status === 'paid'), settle: po.kind === 'lot' && !!grnDiff(po) && (P.money(u) || P.approve(u)) && po.status !== 'closed',
                        close: po.status === 'billed' && P.money(u) } };
            }
            route('GET', '/api/pur/pos/:id', 'dashboard', (req, u, b, res, p) => { view(u); return poFull(poRow(p.id), u); });
            route('GET', '/api/pur/by-lot/:name', 'dashboard', (req, u, b, res, p) => {
                need(c.can(u, 'wms') || P.view(u), 'No access', 403);
                const po = lotPO(decodeURIComponent(p.name));
                if (!po)
                    return { po: null };
                const owner = P.owner(u) || P.money(u);
                return { po: { id: po.id, no: poNo(po.id), supplier: po.supplier, status: po.status, pieces: po.pieces, pricing: po.pricing, rate: owner ? po.rate : null, lump: owner ? po.lump : null, bad_est: po.bad_est || 0, expected_date: po.expected_date,
                        settlement: J(po.settlement, null) }, grn: grnDiff(po) && owner ? grnDiff(po) : (grnDiff(po) ? ((_a) => {
                        var { rate, claim, billFor } = _a, r = __rest(_a, ["rate", "claim", "billFor"]);
                        return r;
                    })(grnDiff(po)) : null), canSettle: !!grnDiff(po) && (P.money(u) || P.approve(u)) && po.status !== 'closed' };
            });
            function readPO(b, ex) {
                const kind = ex ? ex.kind : (b.kind === 'supplies' ? 'supplies' : 'lot');
                const supplier = String(b.supplier || '').trim();
                need(supplier, 'Choose the supplier');
                const sup = supByName(supplier);
                need(sup, 'Add this supplier first (Suppliers screen) — the name must match the one used on lots and in the accounts');
                need(!(kind === 'supplies' && sup.type === 'lots'), `${sup.name} sells shoe lots. Make a Lot PO instead, so the pairs go into stock and listing (a supplies PO would book them as an expense).`);
                const terms = ['cash', 'credit', 'instalments'].includes(b.terms) ? b.terms : (sup.terms || 'cash');
                const v = { kind, supplier: sup.name, expected_date: isDate(b.expected_date) ? b.expected_date : null, terms, credit_days: terms === 'credit' ? Math.max(1, +b.credit_days || sup.credit_days || 30) : null,
                    instalments: terms === 'instalments' ? Math.max(2, +b.instalments || sup.instalments || 3) : null, notes: String(b.notes || '').trim().slice(0, 1000), files: JSON.stringify((Array.isArray(b.files) ? b.files : []).filter(Boolean).slice(0, 20)),
                    advance_plan: Math.max(0, +b.advance_plan || 0) };
                if (kind === 'lot') {
                    const name = String(b.lot_name || '').trim();
                    need(name, 'Enter the lot name (e.g. SH-Lot 25)');
                    const other = q.get("SELECT id FROM pur_pos WHERE lot_name=? AND status<>'cancelled' AND id<>?", name, ex ? ex.id : 0);
                    need(!other, `${name} already has purchase order ${other ? poNo(other.id) : ''}`);
                    const l = lotRow(name);
                    if (l)
                        need(!grnRow(name) && !q.get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', name) && !q.get('SELECT 1 FROM products WHERE lot=? LIMIT 1', name), `${name} is already received or listed. Pick a new lot name.`);
                    const pieces = Math.round(+b.pieces || 0);
                    need(pieces > 0, 'Enter the expected number of pieces');
                    const pricing = b.pricing === 'lump' ? 'lump' : 'per_piece';
                    if (pricing === 'lump')
                        need(+b.lump > 0, 'Enter the lump-sum price');
                    else
                        need(+b.rate > 0, 'Enter the price per piece');
                    const bad = Math.max(0, Math.round(+b.bad_est || 0));
                    need(bad < pieces, "Expected bad pairs can't be equal to or more than the pieces");
                    const extras = (Array.isArray(b.extras) ? b.extras : []).filter(e => e && +e.amount > 0).map(e => ({ label: String(e.label || 'Extra cost').trim().slice(0, 60), amount: r2(e.amount) }));
                    Object.assign(v, { lot_name: name, lot_kind: b.lot_kind === 'leftover' ? 'leftover' : 'used', pieces, pricing, rate: pricing === 'per_piece' ? r2(b.rate) : null, lump: pricing === 'lump' ? r2(b.lump) : null,
                        mix: JSON.stringify(cleanComp(b.mix)), bad_est: bad, extras: JSON.stringify(extras), extra_total: r2(extras.reduce((s, e) => s + e.amount, 0)) });
                    const plan = verdict({ name, kind: v.lot_kind, cost: pricing === 'lump' ? v.lump : v.rate * pieces, extra: v.extra_total, pieces, bad, comp: cleanComp(b.mix) });
                    v.plan = JSON.stringify(plan);
                }
                else {
                    const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && String(l.item || '').trim() && +l.qty > 0).map(l => ({ item: String(l.item).trim().slice(0, 100), qty: +l.qty, unit: String(l.unit || 'pcs').trim().slice(0, 20), rate: r2(l.rate) }));
                    need(lines.length, 'Add at least one item with a quantity');
                    need(lines.every(l => l.rate >= 0), 'Rates cannot be negative');
                    v.lines = lines;
                    v.lot_name = null;
                }
                return v;
            }
            const COLS = ['supplier', 'expected_date', 'terms', 'credit_days', 'instalments', 'notes', 'files', 'advance_plan', 'lot_name', 'lot_kind', 'pieces', 'pricing', 'rate', 'lump', 'mix', 'bad_est', 'extras', 'extra_total', 'plan'];
            route('POST', '/api/pur/pos', 'dashboard', (req, u, b) => {
                need(P.create(u), 'Only listing or warehouse staff can create purchase orders', 403);
                const ex = b.id ? poRow(b.id) : null;
                if (ex) {
                    need(['draft', 'submitted'].includes(ex.status), 'Only a draft or a PO waiting for approval can be edited');
                    need(ex.created_by === u.id || P.approve(u), 'Only the person who made it or an approver can edit it', 403);
                }
                const v = readPO(b, ex), cols = COLS.filter(k => k in v);
                const id = q.tx(() => {
                    let id;
                    if (ex) {
                        q.run(`UPDATE pur_pos SET ${cols.map(k => k + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`, ...cols.map(k => { var _a; return (_a = v[k]) !== null && _a !== void 0 ? _a : null; }), ex.id);
                        id = ex.id;
                    }
                    else
                        id = Number(q.run(`INSERT INTO pur_pos(kind,${cols.join(',')},created_by) VALUES(?,${cols.map(() => '?').join(',')},?)`, v.kind, ...cols.map(k => { var _a; return (_a = v[k]) !== null && _a !== void 0 ? _a : null; }), u.id).lastInsertRowid);
                    if (v.lines) {
                        q.run('DELETE FROM pur_po_lines WHERE po_id=?', id);
                        for (const l of v.lines)
                            q.run('INSERT INTO pur_po_lines(po_id,item,qty,unit,rate) VALUES(?,?,?,?,?)', id, l.item, l.qty, l.unit, l.rate);
                    }
                    return id;
                });
                log(u.id, ex ? 'pur.po.edit' : 'pur.po.create', 'po:' + id, { no: poNo(id), kind: v.kind, supplier: v.supplier, lot: v.lot_name || undefined });
                if (b.submit && !ex) {
                    setStatus(poRow(id), 'submitted', { submitted_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
                    log(u.id, 'pur.po.submit', 'po:' + id, { no: poNo(id) });
                }
                return { ok: true, id, no: poNo(id) };
            });
            const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
            route('POST', '/api/pur/pos/:id/submit', 'dashboard', (req, u, b, res, p) => {
                need(P.create(u), 'No access', 403);
                const po = poRow(p.id);
                need(po.status === 'draft', 'Only a draft can be sent for approval');
                setStatus(po, 'submitted', { submitted_at: nowUtc() });
                log(u.id, 'pur.po.submit', 'po:' + po.id, { no: poNo(po.id) });
                return { ok: true, status: 'submitted' };
            });
            route('POST', '/api/pur/pos/:id/approve', 'dashboard', (req, u, b, res, p) => {
                need(P.approve(u), 'Only the owner (or someone allowed to set prices) can approve purchase orders', 403);
                const po = poRow(p.id);
                need(['submitted', 'draft'].includes(po.status), 'This PO is not waiting for approval');
                q.tx(() => {
                    if (po.kind === 'lot') {
                        const l = lotRow(po.lot_name);
                        if (l)
                            need(!grnRow(po.lot_name), `${po.lot_name} is already received`);
                        saveLot(po.lot_name, { vendor: po.supplier, bought_on: po.expected_date || today(), cost: poAmount(po), extra: po.extra_total || 0, pieces: po.pieces, bad: po.bad_est || 0, kind: po.lot_kind, comp: J(po.mix, []), note: poNo(po.id) + (po.notes ? ' · ' + po.notes.slice(0, 120) : '') });
                    }
                    setStatus(po, 'approved', { approved_by: u.id, approved_at: nowUtc(), submitted_at: po.submitted_at || nowUtc() });
                });
                log(u.id, 'pur.po.approve', 'po:' + po.id, { no: poNo(po.id), amount: Math.round(poAmount(po)), lot: po.lot_name || undefined });
                if (po.kind === 'lot')
                    log(u.id, 'lot.save', 'lot:' + po.lot_name, { cost: poAmount(po), pieces: po.pieces, po: poNo(po.id) });
                return { ok: true, status: 'approved' };
            });
            route('POST', '/api/pur/pos/:id/send', 'dashboard', (req, u, b, res, p) => {
                need(P.create(u) || P.approve(u), 'No access', 403);
                const po = poRow(p.id);
                need(po.status === 'approved', 'Approve the PO before sending it to the supplier');
                setStatus(po, 'sent', { sent_at: nowUtc() });
                log(u.id, 'pur.po.send', 'po:' + po.id, { no: poNo(po.id), via: b.via || 'print' });
                return { ok: true, status: 'sent' };
            });
            route('POST', '/api/pur/pos/:id/cancel', 'dashboard', (req, u, b, res, p) => {
                const po = poRow(p.id);
                need(['draft', 'submitted', 'approved', 'sent'].concat(po.kind === 'supplies' ? ['partial', 'received'] : []).includes(po.status), 'A PO that is already received or billed cannot be cancelled');
                need(P.approve(u) || (po.status === 'draft' && po.created_by === u.id), 'Only an approver can cancel this PO', 403);
                const reason = String(b.reason || '').trim();
                need(reason, 'Write why it is cancelled');
                need(!q.get("SELECT 1 FROM pur_payments WHERE po_id=? LIMIT 1", po.id), 'An advance was paid on this PO. Record the refund / adjust it with the supplier first.');
                q.tx(() => {
                    if (po.kind === 'lot' && po.lot_name && ['approved', 'sent'].includes(po.status)) {
                        const l = lotRow(po.lot_name);
                        if (l && !grnRow(po.lot_name) && !q.get('SELECT 1 FROM listings WHERE lot=? LIMIT 1', po.lot_name) && !q.get('SELECT 1 FROM products WHERE lot=? LIMIT 1', po.lot_name))
                            q.run('DELETE FROM lots WHERE name=?', po.lot_name);
                    }
                    setStatus(po, 'cancelled', { cancelled_at: nowUtc(), cancelled_by: u.id, cancel_reason: reason });
                });
                log(u.id, 'pur.po.cancel', 'po:' + po.id, { no: poNo(po.id), reason });
                return { ok: true, status: 'cancelled' };
            });
            route('POST', '/api/pur/pos/:id/close', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u), 'Only finance can close a PO', 403);
                const po = poRow(p.id);
                need(po.status === 'billed', 'Only a billed PO can be closed');
                setStatus(po, 'closed', { closed_at: nowUtc() });
                log(u.id, 'pur.po.close', 'po:' + po.id, { no: poNo(po.id), due: money(po).due });
                return { ok: true };
            });
            /* ---------- payments & advances ---------- */
            function recordPayment(x, u) {
                const amount = r2(x.amount);
                need(amount > 0, 'Enter the amount');
                const date = isDate(x.date) ? x.date : today();
                checkAcct(x.account);
                const r = q.run('INSERT INTO pur_payments(supplier,po_id,bill_id,kind,date,amount,account,ref,note,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)', x.supplier, x.po_id || null, x.bill_id || null, x.kind, date, amount, x.account, String(x.ref || '').slice(0, 60), String(x.note || '').slice(0, 300), u.id);
                const id = Number(r.lastInsertRowid);
                const what = x.kind === 'advance' ? `Advance to ${x.supplier} against ${poNo(x.po_id)}` : `Payment to ${x.supplier}` + (x.bill_id ? ` — bill ${x.billNo || '#' + x.bill_id}` : '');
                const ps = post({ date, memo: what + (x.ref ? ` (ref ${x.ref})` : ''), source: 'pur-pay', source_id: String(id), kind: 'PV', lines: [{ account: 'Accounts Payable', debit: amount, party: 'vendor:' + x.supplier }, { account: x.account, credit: amount }] }, u.id);
                if (!ps.posted) {
                    q.run('DELETE FROM pur_payments WHERE id=?', id);
                    need(!acc(), 'Not posted to accounts: ' + ps.error);
                }
                log(u.id, x.kind === 'advance' ? 'pur.advance' : 'pur.pay', x.po_id ? 'po:' + x.po_id : 'supplier:' + x.supplier, { amount, account: x.account, bill: x.bill_id || undefined, supplier: x.supplier });
                return { ok: true, id, posted: ps.posted };
            }
            route('POST', '/api/pur/pos/:id/advance', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u), 'Only finance can record payments', 403);
                const po = poRow(p.id);
                need(['approved', 'sent', 'partial', 'received'].includes(po.status), 'Advances can be paid on an approved PO that is not billed yet');
                return recordPayment(Object.assign(Object.assign({}, b), { supplier: po.supplier, po_id: po.id, kind: 'advance' }), u);
            });
            route('POST', '/api/pur/bills/:id/pay', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u), 'Only finance can record payments', 403);
                const bill = q.get('SELECT * FROM pur_bills WHERE id=?', +p.id);
                need(bill && bill.status !== 'void', 'Bill not found', 404);
                const st = billState(bill);
                need(st.due > 0.5, 'This bill is fully paid');
                need(r2(b.amount) <= st.due + 0.5, `More than what is due (${fmt(st.due)})`);
                const r = recordPayment(Object.assign(Object.assign({}, b), { supplier: bill.supplier, bill_id: bill.id, billNo: bill.bill_no, kind: 'payment' }), u);
                if (bill.po_id)
                    maybeClose(poRow(bill.po_id), u.id);
                else if (billState(bill).due <= 0.5)
                    q.run("UPDATE pur_bills SET status='paid' WHERE id=?", bill.id);
                return r;
            });
            /* ---------- receiving ---------- */
            route('POST', '/api/pur/pos/:id/receive', 'dashboard', (req, u, b, res, p) => {
                need(P.create(u), 'No access', 403);
                const po = poRow(p.id);
                need(po.kind === 'supplies', 'Lots are received in Warehouse → Receiving (GRN)');
                need(['approved', 'sent', 'partial'].includes(po.status), 'Approve the PO first');
                const lines = linesOf(po.id), got = new Map((b.lines || []).map(l => [+l.id, Math.max(0, +l.received || 0)]));
                need([...got.values()].some(v => v > 0) || lines.some(l => l.received > 0), 'Enter the quantity received');
                q.tx(() => { for (const l of lines)
                    if (got.has(l.id))
                        q.run('UPDATE pur_po_lines SET received=? WHERE id=?', got.get(l.id), l.id); });
                const nl = linesOf(po.id), full = nl.every(l => l.received >= l.qty);
                setStatus(po, full ? 'received' : 'partial', { received_on: isDate(b.date) ? b.date : today() });
                log(u.id, 'pur.po.receive', 'po:' + po.id, { no: poNo(po.id), lines: nl.map(l => [l.item, l.received, l.qty]) });
                return { ok: true, status: full ? 'received' : 'partial', short: nl.filter(l => l.received < l.qty).map(l => ({ item: l.item, short: l.qty - l.received })), extra: nl.filter(l => l.received > l.qty).map(l => ({ item: l.item, extra: l.received - l.qty })) };
            });
            // PO vs GRN difference settled with the supplier: discount (debit note) · return the pairs · accept as loss
            route('POST', '/api/pur/pos/:id/settle', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u) || P.approve(u), 'Only the owner or finance can settle with the supplier', 403);
                const po = poRow(p.id), d = grnDiff(po);
                need(d, 'Receive the lot first');
                need(po.status !== 'closed', 'This PO is closed');
                const choice = ['discount', 'return', 'loss'].includes(b.choice) ? b.choice : null;
                need(choice, 'Choose how it is settled');
                const note = String(b.note || '').trim().slice(0, 300), date = isDate(b.date) ? b.date : today();
                let dn = null, transfer = null;
                if (choice !== 'loss') {
                    const amount = r2(b.amount != null && b.amount !== '' ? b.amount : d.claim);
                    need(amount > 0, 'Enter the amount the supplier gives back');
                    const dmgPcs = Math.max(0, Math.round(b.damaged_pcs != null ? +b.damaged_pcs : d.extraDamaged)), shortPcs = Math.max(0, Math.round(b.short_pcs != null ? +b.short_pcs : (po.pricing === 'lump' ? d.short : 0)));
                    const skus = (Array.isArray(b.skus) ? b.skus : String(b.skus || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean);
                    if (choice === 'return' && skus.length && c.services.wms && c.services.wms.transfer)
                        transfer = c.services.wms.transfer('SUPPLIER', skus, `Return to ${po.supplier} (${poNo(po.id)})`, u.id);
                    const id = Number(q.run('INSERT INTO pur_debit_notes(po_id,supplier,date,kind,short_pcs,damaged_pcs,amount,reason,transfer_id,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)', po.id, po.supplier, date, choice, shortPcs, dmgPcs, amount, note, transfer, u.id).lastInsertRowid);
                    const dmgPart = Math.min(amount, Math.round(dmgPcs * d.rate)), rest = r2(amount - dmgPart);
                    const lines = [{ account: 'Accounts Payable', debit: amount, party: 'vendor:' + po.supplier }];
                    if (dmgPart > 0)
                        lines.push({ account: 'Inventory Damage', credit: dmgPart, memo: `${dmgPcs} damaged pairs` });
                    if (rest > 0)
                        lines.push({ account: 'Discount Received', credit: rest, memo: shortPcs ? `${shortPcs} pairs short` : 'Supplier discount' });
                    const ps = post({ date, memo: `Debit note DN-${String(id).padStart(4, '0')} — ${po.supplier}, ${po.lot_name} (${choice === 'return' ? 'pairs returned' : 'discount'}: ${[shortPcs && shortPcs + ' short', dmgPcs && dmgPcs + ' damaged'].filter(Boolean).join(', ') || 'difference'})`, source: 'pur-dn', source_id: String(id), lines }, u.id);
                    q.run('UPDATE pur_debit_notes SET post_error=? WHERE id=?', ps.error, id);
                    dn = { id, no: 'DN-' + String(id).padStart(4, '0'), amount, posted: ps.posted, error: ps.error };
                }
                const st = { choice, at: nowUtc(), by: u.id, dn: dn ? dn.id : null, transfer, note, short: d.short, extraDamaged: d.extraDamaged, extra: d.extra };
                q.run("UPDATE pur_pos SET settlement=?, updated_at=datetime('now') WHERE id=?", JSON.stringify(st), po.id);
                log(u.id, 'pur.settle', 'po:' + po.id, { choice, amount: dn ? dn.amount : 0, transfer });
                return { ok: true, debitNote: dn, transfer, money: money(poRow(po.id)) };
            });
            /* ---------- supplier bill ---------- */
            route('POST', '/api/pur/pos/:id/bill', 'dashboard', (req, u, b, res, p) => {
                need(P.money(u), 'Only finance can enter supplier bills', 403);
                const po = poRow(p.id);
                need(['received', 'partial', 'billed'].includes(po.status), 'The PO must be received before it is billed');
                const ex = billOf(po.id);
                if (ex)
                    need(ex.status !== 'paid' && !q.get('SELECT 1 FROM pur_payments WHERE bill_id=? LIMIT 1', ex.id), 'This bill already has payments. Make a debit note instead of changing it.');
                const goods = r2(b.goods);
                need(goods > 0, 'Enter the bill amount');
                const bill_date = isDate(b.bill_date) ? b.bill_date : today();
                const extras = (Array.isArray(b.extras) ? b.extras : []).filter(e => e && +e.amount > 0).map(e => ({ label: String(e.label || 'Extra cost').trim().slice(0, 60), amount: r2(e.amount), paid_from: e.paid_from && e.paid_from !== 'accrued' ? String(e.paid_from) : 'accrued' }));
                for (const e of extras)
                    if (e.paid_from !== 'accrued')
                        checkAcct(e.paid_from);
                const extraTotal = r2(extras.reduce((s, e) => s + e.amount, 0));
                {
                    const sp = supByName(po.supplier);
                    need(!(po.kind === 'supplies' && sp && sp.type === 'lots'), `${po.supplier} sells shoe lots: this PO was made as a supplies PO by mistake. Cancel it and make a Lot PO, so the bill goes to ${po.supplier}'s account and the pairs into stock.`);
                }
                const account = po.kind === 'supplies' ? String(b.account || 'Packaging') : 'Purchases';
                if (po.kind === 'supplies')
                    need(expenseAccounts().includes(account) || ['Office Equipments', 'Outlet Equipments', 'Office Furniture', 'Outlet Furniture'].includes(account), 'Choose the expense account');
                const sup = supByName(po.supplier) || {}, terms = po.terms || sup.terms || 'cash';
                const dn = q.get('SELECT COALESCE(SUM(amount),0) v FROM pur_debit_notes WHERE po_id=?', po.id).v, adv = q.get("SELECT COALESCE(SUM(amount),0) v FROM pur_payments WHERE po_id=? AND kind='advance'", po.id).v;
                let inst = (Array.isArray(b.instalments) ? b.instalments : []).filter(i => i && isDate(i.due) && +i.amount > 0).map(i => ({ due: i.due, amount: r2(i.amount) }));
                const netAfter = r2(goods - dn - adv);
                if (!inst.length && terms === 'instalments' && netAfter > 0) {
                    const n = po.instalments || sup.instalments || 3, each = Math.floor(netAfter / n);
                    inst = Array.from({ length: n }, (_, i) => ({ due: addDays(bill_date, 30 * (i + 1)), amount: i === n - 1 ? r2(netAfter - each * (n - 1)) : each }));
                }
                if (inst.length)
                    need(Math.abs(inst.reduce((s, i) => s + i.amount, 0) - netAfter) < 1, `Instalments must add up to what is left to pay (${fmt(netAfter)})`);
                const due_date = isDate(b.due_date) ? b.due_date : inst.length ? inst[inst.length - 1].due : terms === 'credit' ? addDays(bill_date, po.credit_days || sup.credit_days || 30) : bill_date;
                const match = matchFor(po, goods);
                let id, posting;
                q.tx(() => {
                    const vals = [po.supplier, String(b.bill_no || '').trim().slice(0, 40), bill_date, due_date, goods, JSON.stringify(extras), extraTotal, account, JSON.stringify(match), b.file_id || null];
                    if (ex) {
                        q.run("UPDATE pur_bills SET supplier=?,bill_no=?,bill_date=?,due_date=?,goods=?,extras=?,extra_total=?,account=?,match=?,file_id=?,status='posted' WHERE id=?", ...vals, ex.id);
                        id = ex.id;
                    }
                    else
                        id = Number(q.run('INSERT INTO pur_bills(supplier,bill_no,bill_date,due_date,goods,extras,extra_total,account,match,file_id,po_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, po.id, u.id).lastInsertRowid);
                    q.run('DELETE FROM pur_instalments WHERE bill_id=?', id);
                    for (const i of inst)
                        q.run('INSERT INTO pur_instalments(bill_id,due,amount) VALUES(?,?,?)', id, i.due, i.amount);
                    setStatus(po, 'billed', { billed_at: nowUtc() });
                });
                if (po.kind === 'lot') {
                    // the bill fixes the lot cost: lot row (per-pair cost for listing), the lot's one purchase entry, and the GRN entry follow it
                    const changed = updateLotCost(po.lot_name, goods, extraTotal);
                    posting = postLot(poRow(po.id), u.id);
                    if (changed && c.services.wms && c.services.wms.postGrn && grnRow(po.lot_name))
                        c.services.wms.postGrn(po.lot_name, u.id);
                }
                else {
                    const lines = [{ account, debit: r2(goods + extraTotal) }, { account: 'Accounts Payable', credit: goods, party: 'vendor:' + po.supplier }];
                    for (const e of extras)
                        lines.push(e.paid_from !== 'accrued' ? { account: e.paid_from, credit: e.amount, memo: e.label } : { account: 'Accrued Expenses', credit: e.amount, party: 'vendor:' + po.supplier, memo: e.label });
                    posting = post({ date: bill_date, memo: `Bill ${b.bill_no || '#' + id} — ${po.supplier} (${poNo(po.id)}: ${linesOf(po.id).map(l => l.item).slice(0, 3).join(', ')})`, source: 'pur-bill', source_id: String(id), lines }, u.id);
                }
                q.run('UPDATE pur_bills SET post_error=? WHERE id=?', posting.error, id);
                log(u.id, 'pur.bill', 'po:' + po.id, { bill: id, bill_no: b.bill_no || '', goods, extras: extraTotal, warn: match.warn || undefined });
                maybeClose(poRow(po.id), u.id);
                return { ok: true, id, match, posted: posting.posted, error: posting.error, bill: billState(q.get('SELECT * FROM pur_bills WHERE id=?', id)) };
            });
            route('GET', '/api/pur/bills/:id', 'dashboard', (req, u, b, res, p) => { need(P.money(u) || P.owner(u), 'No access', 403); const bill = q.get('SELECT * FROM pur_bills WHERE id=?', +p.id); need(bill, 'Not found', 404); return billState(bill); });
            route('GET', '/api/pur/payables', 'dashboard', (req, u) => {
                need(P.money(u) || P.owner(u), 'Only finance can see payables', 403);
                const pay = payables(), today0 = today();
                const balances = q.all('SELECT name FROM pur_suppliers ORDER BY name').map(s => ({ name: s.name, id: (supByName(s.name) || {}).id, balance: r2(vendorBal(s.name)) })).filter(s => Math.abs(s.balance) > 0.5);
                const advances = q.all(`SELECT py.supplier, py.po_id, SUM(py.amount) amount, MIN(py.date) date, po.lot_name, po.expected_date, po.status FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.kind='advance' AND po.status IN ('approved','sent','partial') GROUP BY py.po_id ORDER BY date`)
                    .map(a => (Object.assign(Object.assign({}, a), { no: poNo(a.po_id), late: a.expected_date && a.expected_date < today0 ? daysBetween(a.expected_date, today0) : 0 })));
                return Object.assign(Object.assign({}, pay), { balances, advances, totalPayable: r2(-balances.filter(b => b.balance < 0).reduce((s, b) => s + b.balance, 0)), totalAdvance: r2(balances.filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0)) });
            });
            /* ---------- overview, lot P&L, scorecards ---------- */
            route('GET', '/api/pur/overview', 'dashboard', (req, u) => {
                view(u);
                const fin = P.money(u) || P.owner(u), t = today(), wk = addDays(t, 7);
                const sm = summary();
                const counts = Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM pur_pos GROUP BY status').map(r => [r.status, r.n]));
                const list = (w, ...a) => q.all(`SELECT * FROM pur_pos WHERE ${w} ORDER BY COALESCE(expected_date,'9999'), id LIMIT 30`, ...a).map(po => poBrief(po, fin));
                const out = { summary: fin ? sm : Object.assign(Object.assign({}, sm), { payablesDue: null, overdue: null, payablesTotal: null }), counts, awaiting: list("status='submitted'"), arriving: list("status IN ('approved','sent','partial') AND expected_date<=?", wk),
                    notBilled: list("status='received'"), mine: list("status='draft' AND created_by=?", u.id), can: { approve: P.approve(u), create: P.create(u), money: P.money(u) } };
                if (fin) {
                    // purchases per month by supplier (lots by date bought + supplies bills), last 6 months
                    const from = addDays(t.slice(0, 7) + '-01', -150).slice(0, 7) + '-01';
                    const rows = q.all(`SELECT substr(bought_on,1,7) m, vendor s, SUM(cost+COALESCE(extra,0)) v FROM lots WHERE bought_on>=? GROUP BY m, s
          UNION ALL SELECT substr(b.bill_date,1,7) m, b.supplier s, SUM(b.goods+b.extra_total) v FROM pur_bills b JOIN pur_pos po ON po.id=b.po_id WHERE po.kind='supplies' AND b.status<>'void' AND b.bill_date>=? GROUP BY m, s`, from, from);
                    const tot = {};
                    for (const r of rows)
                        tot[r.s || '?'] = (tot[r.s || '?'] || 0) + r.v;
                    const top = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
                    const months = [];
                    for (let i = 5; i >= 0; i--) {
                        const d = addDays(t.slice(0, 7) + '-15', -30.4 * i).slice(0, 7);
                        if (!months.includes(d))
                            months.push(d);
                    }
                    out.chart = months.map(m => {
                        const o = { m: m.slice(0, 4) + '-' + MON[+m.slice(5, 7) - 1] };
                        top.forEach((s, i) => o['s' + i] = 0);
                        o.other = 0;
                        for (const r of rows.filter(r => r.m === m)) {
                            const i = top.indexOf(r.s || '?');
                            if (i >= 0)
                                o['s' + i] += Math.round(r.v);
                            else
                                o.other += Math.round(r.v);
                        }
                        return o;
                    });
                    out.chartSeries = top.map((s, i) => ({ k: 's' + i, l: s })).concat([{ k: 'other', l: 'Others' }]);
                    out.payables = payables().rows.slice(0, 8);
                }
                if (P.owner(u)) {
                    const sc = allScores(12).filter(s => s.roi != null && s.started).sort((a, b) => b.roi - a.roi);
                    out.top = sc.slice(0, 3);
                    out.bottom = sc.slice(Math.max(3, sc.length - 3)).reverse();
                }
                return out;
            });
            route('GET', '/api/pur/lots/:name', 'dashboard', (req, u, b, res, p) => { need(P.owner(u), 'Only the owner or finance can see lot profit', 403); const x = lotPnl(decodeURIComponent(p.name)); need(x, 'Lot not found', 404); return x; });
            route('GET', '/api/pur/scorecard', 'dashboard', (req, u, b, res, p, qs) => { need(P.owner(u), 'Only the owner or finance can see scorecards', 403); return allScores(+qs.months === 12 ? 12 : 6); });
            c.services.purchasing = {
                summary,
                // WMS hooks (called from POST /api/wms/lots/:name/receive)
                afterGrn(name, x, uid) {
                    let po = lotPO(name);
                    if (!po)
                        return null;
                    const on = pkDate(x.at) || today(), received = (+x.good || 0) + (+x.damaged || 0), l = lotRow(name);
                    // the lot's cost is spread over the pieces that actually came; a per-piece lot is paid only for those pieces (until the bill says otherwise)
                    if (l && received > 0 && !billOf(po.id)) {
                        const cost = po.pricing === 'per_piece' ? r2((+po.rate || 0) * received) : +l.cost;
                        if (received !== +l.pieces || Math.abs(cost - (+l.cost || 0)) > 0.009)
                            saveLot(name, Object.assign(Object.assign({}, l), { comp: J(l.comp, []), cost, pieces: received }));
                    }
                    if (['approved', 'sent', 'partial', 'received'].includes(po.status))
                        setStatus(po, 'received', { received_on: on });
                    else
                        q.run('UPDATE pur_pos SET received_on=? WHERE id=?', on, po.id);
                    po = poRow(po.id);
                    const ps = postLot(po, uid);
                    log(uid, 'pur.po.receive', 'po:' + po.id, { no: poNo(po.id), lot: name, good: x.good, damaged: x.damaged });
                    return { id: po.id, no: poNo(po.id), diff: grnDiff(po), posted: ps.posted, error: ps.error };
                },
                lotPnl, scorecard, verdict,
                // expected mix of a lot bought on a PO (Stock line sorting compares the real mix with it)
                poForLot(name) { const po = lotPO(name); return po ? { id: po.id, no: poNo(po.id), supplier: po.supplier, status: po.status, pieces: +po.pieces || 0, bad_est: +po.bad_est || 0, mix: J(po.mix, []) } : null; },
            };
        },
        ready(c) { try {
            importVendors();
        }
        catch (_a) { } },
        counts(u, c) {
            if (!P.view(u))
                return {};
            const out = { purchasing: P.approve(u) ? q.get("SELECT COUNT(*) n FROM pur_pos WHERE status='submitted'").n : q.get("SELECT COUNT(*) n FROM pur_pos WHERE status='draft' AND created_by=?", u.id).n };
            if (P.money(u))
                out.payables = payables().counts.overdue;
            return out;
        },
        alerts(u, c) {
            if (!P.view(u))
                return [];
            const out = [], t = c.pkToday();
            if (P.approve(u)) {
                const n = q.get("SELECT COUNT(*) n, MIN(id) id FROM pur_pos WHERE status='submitted' AND submitted_at < datetime('now','-1 day')");
                if (n.n)
                    out.push({ level: 'warn', text: `${n.n} purchase order${n.n > 1 ? 's have' : ' has'} been waiting for your approval over a day`, href: n.n === 1 ? '#/purchasing/po/' + n.id : '#/purchasing/list/submitted' });
            }
            const late = q.all("SELECT id, supplier, lot_name, expected_date FROM pur_pos WHERE status IN ('approved','sent','partial') AND expected_date<? ORDER BY expected_date", t);
            if (late.length)
                out.push({ level: 'warn', text: `${late.length} order${late.length > 1 ? 's' : ''} past the promised delivery date: ${late.slice(0, 3).map(p => `${p.lot_name || poNo(p.id)} (${p.supplier}, ${daysBetween(p.expected_date, t)} days)`).join(', ')}`, href: late.length === 1 ? '#/purchasing/po/' + late[0].id : '#/purchasing/list/open' });
            if (P.money(u)) {
                const pay = payables();
                if (pay.counts.overdue)
                    out.push({ level: 'bad', text: `${pay.counts.overdue} supplier payment${pay.counts.overdue > 1 ? 's are' : ' is'} overdue (${fmt(pay.totals.overdue)})`, href: '#/payables' });
                const hi = q.all("SELECT b.id, b.po_id, b.supplier, b.match FROM pur_bills b JOIN pur_pos po ON po.id=b.po_id WHERE b.status='posted' AND po.status<>'closed'").filter(b => (J(b.match, {}) || {}).warn);
                for (const b of hi.slice(0, 3)) {
                    const m = J(b.match, {});
                    out.push({ level: 'warn', text: `Bill from ${b.supplier} (${poNo(b.po_id)}) is ${fmt(m.diff)} more than the PO rate × pieces received`, href: '#/purchasing/po/' + b.po_id });
                }
                const adv = q.all("SELECT po.id, po.supplier, po.lot_name, SUM(py.amount) v FROM pur_payments py JOIN pur_pos po ON po.id=py.po_id WHERE py.kind='advance' AND po.status IN ('approved','sent','partial') AND po.expected_date<? GROUP BY po.id", t);
                if (adv.length)
                    out.push({ level: 'warn', text: `Advance paid but goods not received: ${adv.slice(0, 3).map(a => `${fmt(a.v)} to ${a.supplier} (${a.lot_name || poNo(a.id)})`).join(', ')}`, href: '#/payables' });
            }
            return out;
        },
    };
};