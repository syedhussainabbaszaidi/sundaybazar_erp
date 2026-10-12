    // WMS — warehouse control: racks & slots, receiving (GRN), put-away, cycle counts, damage register, transfers, KPIs
    'use strict';
    const SLOT_RE = /^([A-Z0-9]+)-R(\d+)-C(\d+)-L(\d+)$/;
    const DESTS = { OUTLET: 'Outlet', REPAIR: 'Repair', SUPPLIER: 'Return to supplier', STUDIO: 'Photo studio' };
    const REASONS = ['torn', 'sole broken', 'stain', 'mold', 'missing pair', 'other'];
    const AWAY_SQL = `COALESCE(l.location,p.rack,'') NOT IN ('DAMAGED','OUTLET','REPAIR','SUPPLIER','STUDIO','MISSING') AND COALESCE(l.location,'') NOT LIKE 'TRANSIT-%'`;
    const LOC = `UPPER(COALESCE(l.location, p.rack, ''))`;
    const FROM = `products p LEFT JOIN locations l ON l.sku=p.sku`;
    const up = s => String(s == null ? '' : s).trim().toUpperCase();
    const rackOf = loc => { loc = up(loc); const m = SLOT_RE.exec(loc); return m ? m[1] : (loc.split('-')[0] || '?'); };
    const J = (s, d) => { try {
        return s ? JSON.parse(s) : d;
    }
    catch (_a) {
        return d;
    } };
    module.exports = {
        name: 'wms',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS wms_slots(code TEXT PRIMARY KEY, zone TEXT, rack TEXT, row INTEGER, col INTEGER, level INTEGER, capacity INTEGER DEFAULT 12, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_wms_slots_rack ON wms_slots(rack);
CREATE TABLE IF NOT EXISTS wms_grn(lot TEXT PRIMARY KEY, expected INTEGER, good INTEGER, damaged INTEGER, diff INTEGER, notes TEXT, photos TEXT, per_piece REAL, value REAL,
  received_by INTEGER, received_at TEXT, posted INTEGER DEFAULT 0, post_error TEXT);
CREATE TABLE IF NOT EXISTS wms_counts(id INTEGER PRIMARY KEY, name TEXT, rack TEXT, slots TEXT, assigned_to INTEGER, due TEXT, status TEXT DEFAULT 'open',
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT, approved_by INTEGER, approved_at TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS wms_count_scans(id INTEGER PRIMARY KEY, count_id INTEGER, slot TEXT, sku TEXT, result TEXT, recorded_loc TEXT, sold INTEGER DEFAULT 0, moved INTEGER DEFAULT 0,
  user_id INTEGER, at TEXT DEFAULT (datetime('now')), UNIQUE(count_id, sku));
CREATE TABLE IF NOT EXISTS wms_count_slots(count_id INTEGER, slot TEXT, done_at TEXT, user_id INTEGER, PRIMARY KEY(count_id, slot));
CREATE TABLE IF NOT EXISTS wms_missing(id INTEGER PRIMARY KEY, sku TEXT, title TEXT, count_id INTEGER, last_loc TEXT, cost REAL, status TEXT DEFAULT 'open', note TEXT,
  at TEXT DEFAULT (datetime('now')), resolved_by INTEGER, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS ix_wms_missing_sku ON wms_missing(sku);
CREATE TABLE IF NOT EXISTS wms_damage(id INTEGER PRIMARY KEY, sku TEXT, title TEXT, reason TEXT, photo TEXT, found_at TEXT, note TEXT, cost REAL, status TEXT DEFAULT 'reported',
  reported_by INTEGER, at TEXT DEFAULT (datetime('now')), approved_by INTEGER, approved_at TEXT, post_error TEXT);
CREATE TABLE IF NOT EXISTS wms_transfers(id INTEGER PRIMARY KEY, dest TEXT, note TEXT, status TEXT DEFAULT 'sent', created_by INTEGER, sent_at TEXT DEFAULT (datetime('now')),
  received_by INTEGER, received_at TEXT, discrepancy TEXT);
CREATE TABLE IF NOT EXISTS wms_transfer_items(id INTEGER PRIMARY KEY, transfer_id INTEGER, sku TEXT, from_loc TEXT, received INTEGER DEFAULT 0, extra INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_wms_ti ON wms_transfer_items(transfer_id);`,
        activity: {
            'wms.putaway': 'Put away pair', 'wms.move': 'Moved pair', 'wms.counted': 'Counted slot', 'wms.count.create': 'Created stock count', 'wms.count.finish': 'Finished stock count',
            'wms.count.approve': 'Approved count adjustments', 'wms.grn': 'Received lot', 'wms.damage.report': 'Reported damage', 'wms.damage.approve': 'Approved damage write-off',
            'wms.transfer.send': 'Sent transfer', 'wms.transfer.receive': 'Received transfer', 'wms.slots.generate': 'Set up rack slots', 'wms.missing.resolve': 'Resolved missing pair',
        },
        routes(ctx) {
            const { route, q, need, can, log, setting, setSetting, pkToday, services } = ctx;
            const S = () => (Object.assign({ countEvery: 30, stuckDays: 7, stuckPct: 50, varianceAlert: 5, defaultCapacity: 12 }, (setting('wms.settings', {}) || {})));
            const acc = () => services.accounts && typeof services.accounts.post === 'function' ? services.accounts : null;
            const post = (entry, uid) => { const a = acc(); if (!a)
                return { posted: false, error: null }; try {
                a.post(entry, uid);
                return { posted: true, error: null };
            }
            catch (e) {
                return { posted: false, error: e.message };
            } };
            const product = sku => q.get(`SELECT p.sku, p.title, p.qty, p.cost, p.price, p.lot, p.size, p.created_at, ${LOC} loc, l.location rawloc FROM ${FROM} WHERE UPPER(p.sku)=? ORDER BY p.qty DESC LIMIT 1`, up(sku));
            const curLoc = sku => { const r = q.get('SELECT location FROM locations WHERE UPPER(sku)=?', up(sku)); if (r)
                return r.location; const p = q.get('SELECT rack FROM products WHERE UPPER(sku)=? LIMIT 1', up(sku)); return p ? p.rack : null; };
            // core location update + stock move (the one place WMS changes where a pair is)
            const setLoc = (sku, to, reason, uid) => {
                sku = up(sku);
                const from = curLoc(sku);
                q.run(`INSERT INTO locations(sku,location,updated_at,updated_by) VALUES(?,?,datetime('now'),?) ON CONFLICT(sku) DO UPDATE SET location=excluded.location, updated_at=excluded.updated_at, updated_by=excluded.updated_by`, sku, to, uid);
                q.run('INSERT INTO stock_moves(sku,from_loc,to_loc,reason,user_id) VALUES(?,?,?,?,?)', sku, from || null, to, reason, uid);
                return from;
            };
            const slotRow = code => q.get('SELECT * FROM wms_slots WHERE code=?', up(code));
            const inSlot = code => q.get(`SELECT COUNT(*) n FROM ${FROM} WHERE p.qty>0 AND ${LOC}=?`, up(code)).n;
            const locCounts = () => { const m = new Map(); for (const r of q.all(`SELECT ${LOC} loc, COUNT(*) n, SUM(p.cost) cost FROM ${FROM} WHERE p.qty>0 GROUP BY 1`))
                m.set(r.loc, r); return m; };
            const isWms = u => can(u, 'wms');
            // per good pair, same rule as the lister: (cost + extra) / (pieces - planned bad)
            const lotPP = l => l.per_piece > 0 ? l.per_piece : (l.cost > 0 && l.pieces > (l.bad || 0) ? Math.round(((+l.cost || 0) + (+l.extra || 0)) / (l.pieces - (l.bad || 0))) : 0);
            /* ---------- racks & slots ---------- */
            function rackSummary() {
                const slots = q.all('SELECT rack, zone, COUNT(*) slots, SUM(active) active, SUM(CASE WHEN active=1 THEN capacity ELSE 0 END) capacity FROM wms_slots GROUP BY rack');
                const by = new Map(slots.map(s => [s.rack, { rack: s.rack, zone: s.zone || '', slots: s.slots, active: s.active, capacity: s.capacity, items: 0, slotted: 0, value: 0, empty: 0, full: 0 }]));
                const known = new Set(q.all('SELECT code FROM wms_slots WHERE active=1').map(r => r.code));
                const cap = new Map(q.all('SELECT code, capacity FROM wms_slots WHERE active=1').map(r => [r.code, r.capacity]));
                const used = new Map();
                for (const r of q.all(`SELECT ${LOC} loc, COUNT(*) n, SUM(p.cost) cost FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL} GROUP BY 1`)) {
                    const rk = rackOf(r.loc || '?');
                    if (!by.has(rk))
                        by.set(rk, { rack: rk, zone: '', slots: 0, active: 0, capacity: 0, items: 0, slotted: 0, value: 0, empty: 0, full: 0 });
                    const x = by.get(rk);
                    x.items += r.n;
                    x.value += r.cost || 0;
                    if (known.has(r.loc)) {
                        x.slotted += r.n;
                        used.set(r.loc, r.n);
                    }
                }
                for (const [code, c] of cap) {
                    const x = by.get(rackOf(code));
                    const n = used.get(code) || 0;
                    if (!n)
                        x.empty++;
                    else if (n >= c)
                        x.full++;
                }
                return [...by.values()].map(x => (Object.assign(Object.assign({}, x), { fill: x.capacity ? Math.round(100 * x.slotted / x.capacity) : null }))).sort((a, b) => a.rack.localeCompare(b.rack));
            }
            route('GET', '/api/wms/racks', 'inventory', () => ({ racks: rackSummary(), settings: S() }));
            route('GET', '/api/wms/racks/:rack', 'inventory', (req, u, b, res, p) => {
                const rack = up(decodeURIComponent(p.rack));
                const lc = locCounts();
                const slots = q.all('SELECT * FROM wms_slots WHERE rack=? ORDER BY row, col, level', rack).map(s => { const c = lc.get(s.code) || { n: 0, cost: 0 }; return Object.assign(Object.assign({}, s), { items: c.n, cost: c.cost || 0 }); });
                const codes = new Set(slots.map(s => s.code));
                const other = q.all(`SELECT ${LOC} loc, COUNT(*) n FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL} GROUP BY 1`).filter(r => rackOf(r.loc) === rack && !codes.has(r.loc));
                return { rack, slots, unslotted: other };
            });
            route('GET', '/api/wms/slots', 'inventory', (req, u, b, res, p, qs) => {
                const lc = locCounts(), w = ['1=1'], a = [];
                if (qs.rack) {
                    w.push('rack=?');
                    a.push(up(qs.rack));
                }
                if (qs.active !== 'all')
                    w.push('active=1');
                let rows = q.all(`SELECT * FROM wms_slots WHERE ${w.join(' AND ')} ORDER BY rack,row,col,level`, ...a).map(s => (Object.assign(Object.assign({}, s), { items: (lc.get(s.code) || {}).n || 0 })));
                if (qs.empty === '1')
                    rows = rows.filter(s => s.items === 0);
                if (qs.free === '1')
                    rows = rows.filter(s => s.items < s.capacity);
                return rows.slice(0, +qs.limit || 2000);
            });
            route('GET', '/api/wms/slot/:code', 'inventory', (req, u, b, res, p) => {
                const code = up(decodeURIComponent(p.code));
                const s = slotRow(code);
                const items = q.all(`SELECT p.sku, p.title, p.size, p.cost, p.price, p.created_at FROM ${FROM} WHERE p.qty>0 AND ${LOC}=? ORDER BY p.sku`, code);
                return { code, slot: s || null, known: !!s, looksLikeSlot: SLOT_RE.test(code), items, capacity: s ? s.capacity : null };
            });
            route('POST', '/api/wms/slots/generate', 'wms', (req, u, b) => {
                const list = String(b.racks || '').toUpperCase().split(/[\s,]+/).filter(Boolean).flatMap(t => {
                    const m = /^([A-Z])-([A-Z])$/.exec(t);
                    if (!m)
                        return [t];
                    const out = [];
                    for (let c = m[1].charCodeAt(0); c <= m[2].charCodeAt(0); c++)
                        out.push(String.fromCharCode(c));
                    return out;
                });
                need(list.length && list.every(r => /^[A-Z0-9]{1,4}$/.test(r)), 'Racks: letters like A, B, C or a range A-D');
                const rows = +b.rows || 0, cols = +b.cols || 0, levels = +b.levels || 0, capv = +b.capacity || S().defaultCapacity;
                need(rows > 0 && cols > 0 && levels > 0 && rows <= 50 && cols <= 50 && levels <= 20, 'Rows, columns and levels must be between 1 and 50');
                need(list.length * rows * cols * levels <= 20000, 'Too many slots at once');
                let made = 0, updated = 0;
                q.tx(() => {
                    for (const rk of list)
                        for (let r = 1; r <= rows; r++)
                            for (let c = 1; c <= cols; c++)
                                for (let l = 1; l <= levels; l++) {
                                    const code = `${rk}-R${r}-C${c}-L${l}`;
                                    if (slotRow(code)) {
                                        if (b.overwrite) {
                                            q.run('UPDATE wms_slots SET capacity=?, zone=?, active=1 WHERE code=?', capv, b.zone || '', code);
                                            updated++;
                                        }
                                    }
                                    else {
                                        q.run('INSERT INTO wms_slots(code,zone,rack,row,col,level,capacity) VALUES(?,?,?,?,?,?,?)', code, b.zone || '', rk, r, c, l, capv);
                                        made++;
                                    }
                                }
                });
                log(u.id, 'wms.slots.generate', 'wms:slots', { racks: list, rows, cols, levels, capacity: capv, made, updated });
                return { ok: true, made, updated, racks: list };
            });
            route('POST', '/api/wms/slots/update', 'wms', (req, u, b) => {
                const codes = (b.codes || []).map(up).filter(Boolean);
                need(codes.length, 'Pick some slots');
                q.tx(() => {
                    for (const c of codes) {
                        if (b.capacity != null && b.capacity !== '')
                            q.run('UPDATE wms_slots SET capacity=? WHERE code=?', Math.max(0, +b.capacity), c);
                        if (b.active != null)
                            q.run('UPDATE wms_slots SET active=? WHERE code=?', b.active ? 1 : 0, c);
                        if (b.zone != null)
                            q.run('UPDATE wms_slots SET zone=? WHERE code=?', b.zone, c);
                    }
                });
                log(u.id, 'wms.slots.update', 'wms:slots', { n: codes.length, capacity: b.capacity, active: b.active });
                return { ok: true, n: codes.length };
            });
            /* ---------- put-away & moves ---------- */
            route('POST', '/api/wms/putaway', 'wms', (req, u, b) => putaway(u.id, b));
            // one pair onto a slot: core locations + stock_moves (also used by the Stock line warehouse receive). o.silent = caller logs its own event
            function putaway(uid, b, o = {}) {
                const u = { id: uid };
                const slot = up(b.slot), sku = up(b.sku);
                need(slot, 'Scan a slot first');
                need(sku, 'Scan a SKU');
                need(!SLOT_RE.test(sku), sku + ' is a slot label, not a shoe');
                const warn = [], s = slotRow(slot), p = product(sku);
                if (!s)
                    warn.push(SLOT_RE.test(slot) ? `Slot ${slot} is not in the rack setup` : `${slot} is not a rack slot code`);
                else if (!s.active)
                    warn.push(`Slot ${slot} is switched off`);
                if (!p)
                    warn.push(`${sku} is unknown (not in products)`);
                else if (p.qty <= 0)
                    warn.push(`${sku} is SOLD / out of stock`);
                if (p && p.loc === slot)
                    return { ok: true, sku, slot, same: true, product: p, warnings: warn, inSlot: inSlot(slot), capacity: s ? s.capacity : null };
                const reason = ['putaway', 'move'].includes(b.reason) ? b.reason : (p && p.rawloc ? 'move' : 'putaway');
                const from = setLoc(sku, slot, reason, u.id);
                const n = inSlot(slot);
                if (s && n > s.capacity)
                    warn.push(`Slot ${slot} is over capacity (${n} / ${s.capacity})`);
                const miss = q.get("SELECT id FROM wms_missing WHERE UPPER(sku)=? AND status='open'", sku);
                if (miss) {
                    q.run("UPDATE wms_missing SET status='found', resolved_by=?, resolved_at=datetime('now'), note=COALESCE(note,'') || ? WHERE id=?", u.id, ' Found at ' + slot, miss.id);
                    warn.push(`${sku} was on the Missing list: marked found`);
                }
                if (!o.silent)
                    log(u.id, reason === 'move' ? 'wms.move' : 'wms.putaway', 'sku:' + sku, { from, to: slot });
                return { ok: true, sku, slot, from, reason, product: p || null, warnings: warn, inSlot: n, capacity: s ? s.capacity : null };
            }
            // a valid slot code that is not in the rack setup yet gets its slot record (default capacity)
            function ensureSlot(code) {
                code = up(code);
                const m = SLOT_RE.exec(code);
                if (!m)
                    return null;
                const s = slotRow(code);
                if (s)
                    return s;
                q.run('INSERT INTO wms_slots(code,zone,rack,row,col,level,capacity) VALUES(?,?,?,?,?,?,?)', code, '', m[1], +m[2], +m[3], +m[4], S().defaultCapacity);
                return slotRow(code);
            }
            route('GET', '/api/wms/moves', 'inventory', (req, u, b, res, p, qs) => {
                const w = qs.sku ? 'WHERE UPPER(m.sku)=?' : '', a = qs.sku ? [up(qs.sku)] : [];
                return q.all(`SELECT m.*, us.name user FROM stock_moves m LEFT JOIN users us ON us.id=m.user_id ${w} ORDER BY m.id DESC LIMIT ?`, ...a, Math.min(500, +qs.limit || 100));
            });
            /* ---------- receiving (GRN) ---------- */
            function lotRows() {
                const listed = new Map();
                for (const r of q.all(`SELECT lot, COUNT(*) n, MAX(at) last FROM (SELECT sku, lot, at FROM listings WHERE lot<>'' UNION SELECT sku, lot, created_at at FROM products WHERE lot<>'' AND sku NOT IN (SELECT sku FROM listings)) GROUP BY lot`))
                    listed.set(r.lot, r);
                const grn = new Map(q.all('SELECT g.*, us.name received_name FROM wms_grn g LEFT JOIN users us ON us.id=g.received_by').map(g => [g.lot, g]));
                const st = S(), now = Date.now();
                return q.all('SELECT * FROM lots ORDER BY COALESCE(bought_on, updated_at) DESC').map(l => {
                    const g = grn.get(l.name), n = (listed.get(l.name) || {}).n || 0, target = g ? (g.good || 0) : (l.pieces || 0);
                    const pctListed = target ? Math.min(100, Math.round(100 * n / target)) : (n ? 100 : 0);
                    const status = !g && !n ? 'not_received' : (target && n >= target) ? 'fully_listed' : n > 0 ? 'listing' : 'received';
                    const days = g && g.received_at ? Math.floor((now - Date.parse(g.received_at.replace(' ', 'T') + 'Z')) / 864e5) : null;
                    const stuck = !!(g && days != null && days > st.stuckDays && pctListed < st.stuckPct);
                    return { name: l.name, vendor: l.vendor || '', bought_on: l.bought_on || '', pieces: l.pieces || 0, cost: l.cost || 0, per_piece: lotPP(l), kind: l.kind || '',
                        received: !!g, grn: g ? Object.assign(Object.assign({}, g), { photos: J(g.photos, []) }) : null, listed: n, pctListed, status, days, stuck, unlisted: Math.max(0, target - n) };
                });
            }
            route('GET', '/api/wms/lots', 'wms', () => ({ lots: lotRows(), settings: S(), accounts: !!acc() }));
            // Accounts: the lot sits in Purchases at its full cost (+ extra costs) from the day it was bought. Receiving moves ALL of it to Unlisted Inventory,
            // so Purchases clears to zero. Pairs the lot plan already expected to be bad are part of the good pairs' cost (that is how per-pair cost is worked out);
            // only damage beyond the plan is written off now. Listing then moves each pair's cost on to Listed Inventory.
            // (Also called by Purchasing when a supplier bill changes the lot cost after it was received, so the GRN entry follows the billed cost.)
            function postGrn(name, uid) {
                const l = q.get('SELECT * FROM lots WHERE name=?', name), g = q.get('SELECT * FROM wms_grn WHERE lot=?', name);
                let posting = { posted: false, error: null };
                if (!l || !g)
                    return posting;
                const pp = lotPP(l), good = +g.good || 0, damaged = +g.damaged || 0, value = Math.round((good + damaged) * pp), at = g.received_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
                if (pp !== g.per_piece || value !== g.value)
                    q.run('UPDATE wms_grn SET per_piece=?, value=? WHERE lot=?', pp, value, name);
                const total = Math.round(((+l.cost || 0) + (+l.extra || 0)) * 100) / 100;
                if (value > 0 && total > 0) {
                    const extraBad = Math.max(0, damaged - (+l.bad || 0)), dmg = Math.min(total, Math.round(extraBad * pp));
                    const lines = [{ account: 'Unlisted Inventory', debit: Math.round((total - dmg) * 100) / 100 }];
                    if (dmg)
                        lines.push({ account: 'Inventory Damage', debit: dmg });
                    lines.push({ account: 'Purchases', credit: total });
                    posting = post({ date: new Date(Date.parse(at.replace(' ', 'T') + 'Z') + 5 * 3600e3).toISOString().slice(0, 10), memo: `Lot received: ${name} (${good} good, ${damaged} damaged)`, source: 'grn', source_id: name, lines: lines.filter(x => x.debit !== 0 || x.credit) }, uid);
                }
                else if (!pp || !total)
                    posting.error = 'Lot has no cost yet: nothing posted';
                q.run('UPDATE wms_grn SET posted=?, post_error=? WHERE lot=?', posting.posted ? 1 : 0, posting.error, name);
                return posting;
            }
            route('POST', '/api/wms/lots/:name/receive', 'wms', (req, u, b, res, p) => {
                const name = decodeURIComponent(p.name);
                const l = q.get('SELECT * FROM lots WHERE name=?', name);
                need(l, 'Lot not found', 404);
                const good = Math.max(0, Math.round(+b.good || 0)), damaged = Math.max(0, Math.round(+b.damaged || 0));
                need(good + damaged > 0, 'Enter the counted pieces');
                const pur = services.purchasing; // lot bought on a purchase order (Purchasing): cost follows the pieces received, PO gets its purchase posting
                const expected = b.expected != null && b.expected !== '' ? +b.expected : (l.pieces || 0);
                const pp = lotPP(l), diff = good + damaged - expected, value = Math.round((good + damaged) * pp);
                const at = b.received_at ? String(b.received_at).replace('T', ' ').slice(0, 19) : new Date().toISOString().replace('T', ' ').slice(0, 19);
                q.run(`INSERT INTO wms_grn(lot,expected,good,damaged,diff,notes,photos,per_piece,value,received_by,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lot) DO UPDATE SET expected=excluded.expected, good=excluded.good, damaged=excluded.damaged, diff=excluded.diff, notes=excluded.notes, photos=excluded.photos,
        per_piece=excluded.per_piece, value=excluded.value, received_by=excluded.received_by, received_at=excluded.received_at`, name, expected, good, damaged, diff, b.notes || '', JSON.stringify((b.photos || []).filter(Boolean)), pp, value, +b.received_by || u.id, at);
                let po = null;
                if (pur && pur.afterGrn) {
                    try {
                        po = pur.afterGrn(name, { good, damaged, expected, at }, u.id);
                    }
                    catch (e) {
                        po = { error: e.message };
                    }
                }
                const posting = postGrn(name, u.id), g2 = q.get('SELECT per_piece, value FROM wms_grn WHERE lot=?', name) || { per_piece: pp, value };
                log(u.id, 'wms.grn', 'lot:' + name, { expected, good, damaged, diff, value: g2.value });
                return Object.assign(Object.assign({ ok: true, lot: name, expected, good, damaged, diff, per_piece: g2.per_piece, value: g2.value }, posting), { po });
            });
            route('GET', '/api/wms/people', 'wms', () => q.all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name')
                .filter(x => { const pm = ctx.A.userPerms(x); return pm.includes('wms') || pm.includes('warehouse') || pm.includes('inventory'); }).map(x => ({ id: x.id, name: x.name, role: x.role })));
            /* ---------- stock counts ---------- */
            const countRow = id => { const c = q.get('SELECT c.*, us.name assigned_name FROM wms_counts c LEFT JOIN users us ON us.id=c.assigned_to WHERE c.id=?', +id); need(c, 'Count not found', 404); c.slots = J(c.slots, []); c.summary = J(c.summary, null); return c; };
            const rackSlots = rack => {
                const s = q.all('SELECT code FROM wms_slots WHERE rack=? AND active=1 ORDER BY row,col,level', rack).map(r => r.code);
                const extra = q.all(`SELECT DISTINCT ${LOC} loc FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL}`).map(r => r.loc).filter(l => l && rackOf(l) === rack && !s.includes(l)).sort();
                return s.concat(extra);
            };
            function countState(c, allSlots) {
                const scans = q.all(`SELECT s.*, p.title, p.cost, p.size FROM wms_count_scans s LEFT JOIN products p ON UPPER(p.sku)=UPPER(s.sku) WHERE s.count_id=? ORDER BY s.id DESC`, c.id);
                const done = q.all('SELECT slot, done_at FROM wms_count_slots WHERE count_id=?', c.id);
                const doneSet = new Set(done.map(d => d.slot)), scanned = new Set(scans.map(s => up(s.sku)));
                const consider = allSlots ? c.slots : c.slots.filter(s => doneSet.has(s));
                const ph = consider.map(() => '?').join(',');
                const expected = consider.length ? q.all(`SELECT p.sku, p.title, p.cost, p.size, ${LOC} loc FROM ${FROM} WHERE p.qty>0 AND ${LOC} IN (${ph})`, ...consider) : [];
                const missing = expected.filter(e => !scanned.has(up(e.sku)));
                const found = scans.filter(s => s.result === 'found'), extra = scans.filter(s => s.result === 'extra'), unknown = scans.filter(s => s.result === 'unknown');
                const v = a => Math.round(a.reduce((t, x) => t + (+x.cost || 0), 0));
                const perSlot = {};
                for (const sl of c.slots)
                    perSlot[sl] = { slot: sl, scanned: 0, done: doneSet.has(sl) };
                for (const s of scans)
                    if (perSlot[s.slot])
                        perSlot[s.slot].scanned++;
                const expAll = c.slots.length ? q.all(`SELECT ${LOC} loc, COUNT(*) n FROM ${FROM} WHERE p.qty>0 AND ${LOC} IN (${c.slots.map(() => '?').join(',')}) GROUP BY 1`, ...c.slots) : [];
                for (const r of expAll)
                    if (perSlot[r.loc])
                        perSlot[r.loc].expected = r.n;
                return { scans, found, extra, unknown, missing, slots: Object.values(perSlot), slotsDone: doneSet.size,
                    totals: { found: found.length, missing: missing.length, extra: extra.length, unknown: unknown.length, foundValue: v(found), missingValue: v(missing), extraValue: v(extra),
                        accuracy: found.length + missing.length ? Math.round(100 * found.length / (found.length + missing.length)) : 100 } };
            }
            function dueRacks() {
                const every = S().countEvery, racks = new Set(q.all('SELECT DISTINCT rack FROM wms_slots WHERE active=1').map(r => r.rack));
                for (const r of q.all(`SELECT DISTINCT ${LOC} loc FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL}`))
                    if (r.loc)
                        racks.add(rackOf(r.loc));
                const last = new Map(q.all("SELECT rack, MAX(COALESCE(approved_at, finished_at)) at FROM wms_counts WHERE status IN ('done','review') AND rack IS NOT NULL GROUP BY rack").map(r => [r.rack, r.at]));
                const open = new Set(q.all("SELECT rack FROM wms_counts WHERE status IN ('open','counting') AND rack IS NOT NULL").map(r => r.rack));
                const now = Date.now();
                return [...racks].sort().map(rk => {
                    const at = last.get(rk);
                    const days = at ? Math.floor((now - Date.parse(at.replace(' ', 'T') + 'Z')) / 864e5) : null;
                    return { rack: rk, last: at || null, days, open: open.has(rk), due: !open.has(rk) && (days == null || days >= every) };
                });
            }
            route('GET', '/api/wms/counts', 'wms', (req, u, b, res, p, qs) => {
                const rows = q.all(`SELECT c.*, us.name assigned_name, (SELECT COUNT(*) FROM wms_count_scans s WHERE s.count_id=c.id) scanned FROM wms_counts c LEFT JOIN users us ON us.id=c.assigned_to
        ${qs.all ? '' : "WHERE c.status<>'cancelled'"} ORDER BY CASE c.status WHEN 'counting' THEN 0 WHEN 'open' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, c.id DESC LIMIT 200`)
                    .map(c => (Object.assign(Object.assign({}, c), { slots: J(c.slots, []).length, summary: J(c.summary, null), overdue: ['open', 'counting'].includes(c.status) && c.due && c.due < pkToday() })));
                return { counts: rows, due: dueRacks(), settings: S(), missingOpen: q.get("SELECT COUNT(*) n FROM wms_missing WHERE status='open'").n };
            });
            route('POST', '/api/wms/counts', 'wms', (req, u, b) => {
                let slots = [], rack = null;
                if (b.rack) {
                    rack = up(b.rack);
                    slots = rackSlots(rack);
                    need(slots.length, `Rack ${rack} has no slots or stock`);
                }
                else {
                    slots = [...new Set(String(Array.isArray(b.slots) ? b.slots.join(',') : b.slots || '').split(/[\s,]+/).map(up).filter(Boolean))];
                    need(slots.length, 'Choose a rack or list some slots');
                }
                const name = b.name || (rack ? 'Rack ' + rack : slots.length + ' slots') + ' · ' + pkToday();
                const r = q.run('INSERT INTO wms_counts(name,rack,slots,assigned_to,due,created_by) VALUES(?,?,?,?,?,?)', name, rack, JSON.stringify(slots), +b.assigned_to || null, b.due || pkToday(), u.id);
                log(u.id, 'wms.count.create', 'count:' + r.lastInsertRowid, { rack, slots: slots.length });
                return { ok: true, id: Number(r.lastInsertRowid), slots: slots.length };
            });
            route('GET', '/api/wms/counts/:id', 'wms', (req, u, b, res, p) => { const c = countRow(p.id); return Object.assign({ count: c }, countState(c, ['review', 'done'].includes(c.status))); });
            const openCount = id => { const c = countRow(id); need(['open', 'counting'].includes(c.status), 'This count is already finished'); return c; };
            route('POST', '/api/wms/counts/:id/scan', 'wms', (req, u, b, res, p) => {
                const c = openCount(p.id), slot = up(b.slot), sku = up(b.sku);
                need(slot && c.slots.includes(slot), `Slot ${slot || '?'} is not part of this count`);
                need(sku, 'Scan a SKU');
                need(!SLOT_RE.test(sku) && !c.slots.includes(sku), 'That is a slot label');
                const pr = product(sku);
                let result = 'unknown', rec = null, sold = 0;
                if (pr) {
                    rec = pr.loc || null;
                    sold = pr.qty > 0 ? 0 : 1;
                    result = pr.qty > 0 && pr.loc === slot ? 'found' : 'extra';
                }
                const prev = q.get('SELECT slot FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=?', c.id, sku);
                q.run(`INSERT INTO wms_count_scans(count_id,slot,sku,result,recorded_loc,sold,user_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(count_id,sku) DO UPDATE SET slot=excluded.slot, result=excluded.result,
        recorded_loc=excluded.recorded_loc, sold=excluded.sold, moved=0, user_id=excluded.user_id, at=datetime('now')`, c.id, slot, sku, result, rec, sold, u.id);
                if (c.status === 'open')
                    q.run("UPDATE wms_counts SET status='counting', started_at=datetime('now') WHERE id=?", c.id);
                return { ok: true, sku, slot, result, recorded: rec, sold: !!sold, product: pr || null, again: prev ? prev.slot : null };
            });
            route('POST', '/api/wms/counts/:id/unscan', 'wms', (req, u, b, res, p) => { const c = openCount(p.id); q.run('DELETE FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=?', c.id, up(b.sku)); return { ok: true }; });
            route('POST', '/api/wms/counts/:id/slot-done', 'wms', (req, u, b, res, p) => {
                const c = openCount(p.id), slot = up(b.slot);
                need(c.slots.includes(slot), 'Slot not in this count');
                if (b.undo) {
                    q.run('DELETE FROM wms_count_slots WHERE count_id=? AND slot=?', c.id, slot);
                    return { ok: true };
                }
                q.run(`INSERT INTO wms_count_slots(count_id,slot,done_at,user_id) VALUES(?,?,datetime('now'),?) ON CONFLICT(count_id,slot) DO UPDATE SET done_at=excluded.done_at, user_id=excluded.user_id`, c.id, slot, u.id);
                if (c.status === 'open')
                    q.run("UPDATE wms_counts SET status='counting', started_at=datetime('now') WHERE id=?", c.id);
                const n = q.get('SELECT COUNT(*) n FROM wms_count_scans WHERE count_id=? AND slot=?', c.id, slot).n;
                log(u.id, 'wms.counted', 'count:' + c.id, { slot, scanned: n });
                return { ok: true, slot, scanned: n };
            });
            route('POST', '/api/wms/counts/:id/move', 'wms', (req, u, b, res, p) => {
                const c = countRow(p.id);
                need(c.status !== 'cancelled', 'Count cancelled');
                const s = q.get("SELECT * FROM wms_count_scans WHERE count_id=? AND UPPER(sku)=? AND result='extra'", c.id, up(b.sku));
                need(s, 'Not an extra in this count');
                setLoc(s.sku, s.slot, 'count', u.id);
                q.run('UPDATE wms_count_scans SET moved=1 WHERE id=?', s.id);
                log(u.id, 'wms.move', 'sku:' + up(s.sku), { from: s.recorded_loc, to: s.slot, count: c.id });
                return { ok: true };
            });
            route('POST', '/api/wms/counts/:id/finish', 'wms', (req, u, b, res, p) => {
                const c = openCount(p.id), st = countState(c, true);
                const summary = Object.assign(Object.assign({}, st.totals), { slots: c.slots.length, slotsDone: st.slotsDone, missing: st.missing.map(m => ({ sku: m.sku, title: m.title, loc: m.loc, cost: m.cost })), extra: st.extra.map(x => ({ sku: x.sku, title: x.title, slot: x.slot, recorded: x.recorded_loc, cost: x.cost, moved: x.moved, sold: x.sold })), unknown: st.unknown.map(x => ({ sku: x.sku, slot: x.slot })) });
                q.run("UPDATE wms_counts SET status='review', finished_at=datetime('now'), summary=? WHERE id=?", JSON.stringify(summary), c.id);
                log(u.id, 'wms.count.finish', 'count:' + c.id, st.totals);
                return { ok: true, summary };
            });
            route('POST', '/api/wms/counts/:id/approve', 'wms', (req, u, b, res, p) => {
                const c = countRow(p.id);
                need(c.status === 'review', 'Finish the count first');
                const sm = c.summary || {};
                let moved = 0, missing = 0;
                q.tx(() => {
                    if (b.moveExtras !== false)
                        for (const x of sm.extra || [])
                            if (!x.moved && !x.sold) {
                                setLoc(x.sku, x.slot, 'count', u.id);
                                x.moved = 1;
                                moved++;
                            }
                    for (const m of sm.missing || [])
                        if (!q.get("SELECT 1 FROM wms_missing WHERE UPPER(sku)=? AND status='open'", up(m.sku))) {
                            q.run('INSERT INTO wms_missing(sku,title,count_id,last_loc,cost) VALUES(?,?,?,?,?)', m.sku, m.title, c.id, m.loc, m.cost || 0);
                            missing++;
                        }
                    q.run("UPDATE wms_counts SET status='done', approved_by=?, approved_at=datetime('now'), summary=? WHERE id=?", u.id, JSON.stringify(sm), c.id);
                });
                log(u.id, 'wms.count.approve', 'count:' + c.id, { moved, missing });
                return { ok: true, moved, missing };
            });
            route('POST', '/api/wms/counts/:id/cancel', 'wms', (req, u, b, res, p) => { const c = countRow(p.id); need(c.status !== 'done', 'Already approved'); q.run("UPDATE wms_counts SET status='cancelled' WHERE id=?", c.id); log(u.id, 'wms.count.cancel', 'count:' + c.id, ''); return { ok: true }; });
            route('GET', '/api/wms/missing', 'wms', (req, u, b, res, p, qs) => q.all(`SELECT m.*, us.name resolved_name FROM wms_missing m LEFT JOIN users us ON us.id=m.resolved_by WHERE ${qs.all ? '1=1' : "m.status='open'"} ORDER BY m.id DESC LIMIT 500`));
            route('POST', '/api/wms/missing/:id/resolve', 'wms', (req, u, b, res, p) => {
                const m = q.get('SELECT * FROM wms_missing WHERE id=?', +p.id);
                need(m && m.status === 'open', 'Not open');
                let posting = { posted: false, error: null };
                if (b.action === 'found') {
                    if (b.slot)
                        setLoc(m.sku, up(b.slot), 'count', u.id);
                    q.run("UPDATE wms_missing SET status='found', note=?, resolved_by=?, resolved_at=datetime('now') WHERE id=?", b.note || (b.slot ? 'Found at ' + up(b.slot) : 'Found'), u.id, m.id);
                }
                else if (b.action === 'writeoff') {
                    need(isWms(u), 'No access', 403);
                    setLoc(m.sku, 'MISSING', 'missing', u.id);
                    if (m.cost > 0)
                        posting = post({ date: pkToday(), memo: `Missing pair written off: ${m.sku}`, source: 'wms-missing', source_id: String(m.id), lines: [{ account: 'Inventory Damage', debit: m.cost }, { account: 'Listed Inventory', credit: m.cost }] }, u.id);
                    q.run("UPDATE wms_missing SET status='written_off', note=?, resolved_by=?, resolved_at=datetime('now') WHERE id=?", b.note || 'Written off', u.id, m.id);
                }
                else
                    need(false, 'Unknown action');
                log(u.id, 'wms.missing.resolve', 'sku:' + m.sku, { action: b.action, slot: b.slot });
                return Object.assign({ ok: true }, posting);
            });
            /* ---------- damage register ---------- */
            route('GET', '/api/wms/damage', 'inventory', (req, u, b, res, p, qs) => {
                const month = qs.month || pkToday().slice(0, 7);
                const rows = q.all(`SELECT d.*, r.name reported_name, a.name approved_name FROM wms_damage d LEFT JOIN users r ON r.id=d.reported_by LEFT JOIN users a ON a.id=d.approved_by
        ORDER BY CASE d.status WHEN 'reported' THEN 0 ELSE 1 END, d.id DESC LIMIT 300`);
                const mtd = q.get(`SELECT COUNT(*) n, COALESCE(SUM(cost),0) v FROM wms_damage WHERE status='approved' AND substr(datetime(approved_at,'+5 hours'),1,7)=?`, month);
                const stock = q.get(`SELECT COALESCE(SUM(p.cost),0) v FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL}`).v;
                const reasons = REASONS.map(r => ({ reason: r, n: 0, v: 0 }));
                for (const r of q.all(`SELECT reason, COUNT(*) n, SUM(cost) v FROM wms_damage WHERE status<>'rejected' AND at>=datetime('now','-90 days') GROUP BY reason`)) {
                    const x = reasons.find(y => y.reason === r.reason) || reasons[5];
                    x.n += r.n;
                    x.v += r.v || 0;
                }
                const months = q.all(`SELECT substr(datetime(at,'+5 hours'),1,7) month, COUNT(*) n, ROUND(SUM(cost)) v FROM wms_damage WHERE status<>'rejected' GROUP BY 1 ORDER BY 1 DESC LIMIT 6`).reverse();
                return { rows, month, mtd: { n: mtd.n, value: mtd.v, pct: stock ? +(100 * mtd.v / stock).toFixed(2) : 0 }, stockValue: stock, reasons, months, REASONS, accounts: !!acc() };
            });
            route('POST', '/api/wms/damage', 'inventory', (req, u, b) => {
                const sku = up(b.sku);
                need(sku, 'Scan or type the SKU');
                need(REASONS.includes(b.reason), 'Pick a reason');
                const pr = product(sku);
                need(!q.get("SELECT 1 FROM wms_damage WHERE UPPER(sku)=? AND status='reported'", sku), sku + ' is already reported and waiting for approval');
                const r = q.run('INSERT INTO wms_damage(sku,title,reason,photo,found_at,note,cost,reported_by) VALUES(?,?,?,?,?,?,?,?)', sku, pr ? pr.title : '', b.reason, b.photo || null, b.found_at || (pr ? pr.loc : ''), b.note || '', pr ? pr.cost || 0 : 0, u.id);
                log(u.id, 'wms.damage.report', 'sku:' + sku, { reason: b.reason, id: Number(r.lastInsertRowid) });
                return { ok: true, id: Number(r.lastInsertRowid), product: pr || null, warning: pr ? null : sku + ' is not in products (cost unknown)' };
            });
            route('POST', '/api/wms/damage/:id/approve', 'wms', (req, u, b, res, p) => {
                const d = q.get('SELECT * FROM wms_damage WHERE id=?', +p.id);
                need(d, 'Not found', 404);
                need(d.status === 'reported', 'Already ' + d.status);
                if (b.approve === false) {
                    q.run("UPDATE wms_damage SET status='rejected', approved_by=?, approved_at=datetime('now'), note=COALESCE(note,'') || ? WHERE id=?", u.id, b.note ? ' · ' + b.note : '', d.id);
                    log(u.id, 'wms.damage.reject', 'sku:' + d.sku, '');
                    return { ok: true, status: 'rejected' };
                }
                const cost = b.cost != null && b.cost !== '' ? +b.cost : d.cost || 0;
                let posting = { posted: false, error: null };
                if (cost > 0)
                    posting = post({ date: pkToday(), memo: `Damaged pair written off: ${d.sku} (${d.reason})`, source: 'wms-damage', source_id: String(d.id), lines: [{ account: 'Inventory Damage', debit: cost }, { account: 'Listed Inventory', credit: cost }] }, u.id);
                setLoc(d.sku, 'DAMAGED', 'damage', u.id);
                q.run("UPDATE wms_damage SET status='approved', cost=?, approved_by=?, approved_at=datetime('now'), post_error=? WHERE id=?", cost, u.id, posting.error, d.id);
                log(u.id, 'wms.damage.approve', 'sku:' + d.sku, { cost, posted: posting.posted });
                return Object.assign({ ok: true, status: 'approved', cost }, posting);
            });
            /* ---------- transfers ---------- */
            route('GET', '/api/wms/transfers', 'wms', () => ({
                rows: q.all(`SELECT t.*, c.name sent_name, r.name received_name, (SELECT COUNT(*) FROM wms_transfer_items i WHERE i.transfer_id=t.id AND i.extra=0) items,
        (SELECT COUNT(*) FROM wms_transfer_items i WHERE i.transfer_id=t.id AND i.received=1) got FROM wms_transfers t LEFT JOIN users c ON c.id=t.created_by LEFT JOIN users r ON r.id=t.received_by ORDER BY t.id DESC LIMIT 200`)
                    .map(t => (Object.assign(Object.assign({}, t), { destName: DESTS[t.dest] || t.dest, discrepancy: J(t.discrepancy, null) }))), DESTS
            }));
            route('GET', '/api/wms/transfers/:id', 'wms', (req, u, b, res, p) => {
                const t = q.get('SELECT t.*, c.name sent_name, r.name received_name FROM wms_transfers t LEFT JOIN users c ON c.id=t.created_by LEFT JOIN users r ON r.id=t.received_by WHERE t.id=?', +p.id);
                need(t, 'Not found', 404);
                return { transfer: Object.assign(Object.assign({}, t), { destName: DESTS[t.dest] || t.dest, discrepancy: J(t.discrepancy, null) }), items: q.all('SELECT i.*, p.title, p.cost, p.size FROM wms_transfer_items i LEFT JOIN products p ON UPPER(p.sku)=UPPER(i.sku) WHERE transfer_id=? ORDER BY i.id', t.id) };
            });
            function createTransfer(dest, skus, note, uid) {
                return q.tx(() => {
                    const r = q.run('INSERT INTO wms_transfers(dest,note,created_by) VALUES(?,?,?)', dest, note || '', uid), tid = Number(r.lastInsertRowid);
                    for (const s of skus) {
                        const from = setLoc(s, 'TRANSIT-' + dest, 'transfer:' + dest.toLowerCase(), uid);
                        q.run('INSERT INTO wms_transfer_items(transfer_id,sku,from_loc) VALUES(?,?,?)', tid, s, from);
                    }
                    return tid;
                });
            }
            route('POST', '/api/wms/transfers', 'wms', (req, u, b) => {
                const dest = up(b.dest);
                need(DESTS[dest], 'Pick where it is going');
                const skus = [...new Set((b.skus || []).map(up).filter(Boolean))];
                need(skus.length, 'Scan at least one pair');
                const warnings = skus.filter(s => !product(s)).map(s => s + ' is unknown');
                const id = createTransfer(dest, skus, b.note, u.id);
                log(u.id, 'wms.transfer.send', 'transfer:' + id, { dest, n: skus.length });
                return { ok: true, id, n: skus.length, warnings };
            });
            route('POST', '/api/wms/transfers/:id/receive', 'wms', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM wms_transfers WHERE id=?', +p.id);
                need(t, 'Not found', 404);
                need(t.status === 'sent', 'Already received');
                const items = q.all('SELECT * FROM wms_transfer_items WHERE transfer_id=? AND extra=0', t.id), sent = new Set(items.map(i => up(i.sku)));
                const got = b.all ? [...sent] : [...new Set((b.skus || []).map(up).filter(Boolean))];
                const short = [...sent].filter(s => !got.includes(s)), extra = got.filter(s => !sent.has(s));
                q.tx(() => {
                    for (const s of got) {
                        setLoc(s, t.dest, 'transfer-in:' + t.dest.toLowerCase(), u.id);
                        if (sent.has(s))
                            q.run('UPDATE wms_transfer_items SET received=1 WHERE transfer_id=? AND UPPER(sku)=?', t.id, s);
                        else
                            q.run('INSERT INTO wms_transfer_items(transfer_id,sku,received,extra) VALUES(?,?,1,1)', t.id, s);
                    }
                    q.run("UPDATE wms_transfers SET status='received', received_by=?, received_at=datetime('now'), discrepancy=? WHERE id=?", +b.received_by || u.id, short.length || extra.length ? JSON.stringify({ short, extra, note: b.note || '' }) : null, t.id);
                });
                log(u.id, 'wms.transfer.receive', 'transfer:' + t.id, { got: got.length, short: short.length, extra: extra.length });
                return { ok: true, received: got.length, short, extra };
            });
            /* ---------- overview & KPIs ---------- */
            function summary() {
                const s = q.get(`SELECT COUNT(*) n, COALESCE(SUM(p.cost),0) v FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL}`);
                const lc = locCounts();
                let empty = 0;
                for (const r of q.all('SELECT code FROM wms_slots WHERE active=1'))
                    if (!(lc.get(r.code) || {}).n)
                        empty++;
                const lots = lotRows();
                return { onHand: s.n, stockValue: Math.round(s.v), emptySlots: empty, lotsToReceive: lots.filter(l => l.status === 'not_received').length, countsDue: dueRacks().filter(r => r.due).length,
                    damageMTD: Math.round(q.get(`SELECT COALESCE(SUM(cost),0) v FROM wms_damage WHERE status='approved' AND substr(datetime(approved_at,'+5 hours'),1,7)=?`, pkToday().slice(0, 7)).v) };
            }
            const returnsWaiting = () => q.all(`SELECT r.sku, r.at, o.name, 'return' src FROM returns r LEFT JOIN orders o ON o.id=r.order_id WHERE r.restocked=1 AND COALESCE(r.location,'')=''
        AND NOT EXISTS(SELECT 1 FROM stock_moves m WHERE m.sku=r.sku AND m.at>=r.at AND m.reason IN ('putaway','move','count'))
      UNION ALL SELECT l.sku, l.updated_at at, NULL name, 'returns-bin' src FROM locations l WHERE l.location='RETURNS' ORDER BY at LIMIT 200`);
            route('GET', '/api/wms/overview', 'dashboard', (req, u) => {
                need(can(u, 'wms') || can(u, 'warehouse'), 'No access', 403);
                const sm = summary(), racks = rackSummary(), lots = lotRows();
                const cap = racks.reduce((t, r) => t + (r.capacity || 0), 0), slotted = racks.reduce((t, r) => t + (r.slotted || 0), 0);
                const ages = q.get(`SELECT SUM(a<=60) b1, SUM(CASE WHEN a<=60 THEN c END) v1, SUM(a>60 AND a<=120) b2, SUM(CASE WHEN a>60 AND a<=120 THEN c END) v2,
        SUM(a>120 AND a<=365) b3, SUM(CASE WHEN a>120 AND a<=365 THEN c END) v3, SUM(a>365) b4, SUM(CASE WHEN a>365 THEN c END) v4
        FROM (SELECT julianday('now')-julianday(p.created_at) a, p.cost c FROM ${FROM} WHERE p.qty>0 AND ${AWAY_SQL})`);
                const aging = [['0-60 days', ages.b1, ages.v1], ['61-120 days', ages.b2, ages.v2], ['121-365 days', ages.b3, ages.v3], ['365+ days', ages.b4, ages.v4]].map(([l, n, v]) => ({ bucket: l, n: n || 0, value: Math.round(v || 0) }));
                const slowRows = q.all(`SELECT p.sku, p.title, p.size, p.price, p.cost, p.lot, ${LOC} loc, CAST(julianday('now')-julianday(p.created_at) AS INT) age FROM ${FROM}
        WHERE p.qty>0 AND ${AWAY_SQL} AND p.created_at < datetime('now','-120 days') ORDER BY p.created_at LIMIT 1000`);
                const slowBy = {};
                for (const r of slowRows) {
                    const k = rackOf(r.loc || '?');
                    (slowBy[k] || (slowBy[k] = { rack: k, n: 0, value: 0, price: 0, items: [] }));
                    const x = slowBy[k];
                    x.n++;
                    x.value += r.cost || 0;
                    x.price += r.price || 0;
                    if (x.items.length < 50)
                        x.items.push(r);
                }
                const today = pkToday();
                const speed = q.get(`SELECT AVG((julianday(picked_at)-julianday(cs_at))*1440) pick, COUNT(*) n FROM orders WHERE picked_at IS NOT NULL AND cs_at IS NOT NULL AND cs_at<=picked_at AND substr(datetime(picked_at,'+5 hours'),1,10)=?`, today);
                const speed2 = q.get(`SELECT AVG((julianday(packed_at)-julianday(picked_at))*1440) pack, COUNT(*) n FROM orders WHERE packed_at IS NOT NULL AND picked_at IS NOT NULL AND picked_at<=packed_at AND substr(datetime(packed_at,'+5 hours'),1,10)=?`, today);
                const openVar = q.all(`SELECT id, name, summary FROM wms_counts WHERE status='review'`).map(c => (Object.assign({ id: c.id, name: c.name }, (J(c.summary, {}) || {}))));
                const moves = q.all(`SELECT m.reason, COUNT(*) n FROM stock_moves m WHERE substr(datetime(m.at,'+5 hours'),1,10)=? GROUP BY m.reason`, today);
                return Object.assign(Object.assign({}, sm), { slotFill: cap ? Math.round(100 * slotted / cap) : null, capacity: cap, slotted, racks, backlog: lots.reduce((t, l) => t + (l.received ? l.unlisted : 0), 0), stuckLots: lots.filter(l => l.stuck), lotsWaiting: lots.filter(l => l.status === 'not_received').slice(0, 10), openVariances: openVar.map(v => ({ id: v.id, name: v.name, missing: v.missing ? v.missing.length : 0, extra: v.extra ? v.extra.length : 0, missingValue: v.missingValue || 0 })), aging, slow: Object.values(slowBy).sort((a, b) => b.n - a.n).map(x => (Object.assign(Object.assign({}, x), { value: Math.round(x.value), price: Math.round(x.price) }))), slowTotal: slowRows.length, speed: { pick: speed.pick != null ? Math.round(speed.pick) : null, picked: speed.n, pack: speed2.pack != null ? Math.round(speed2.pack) : null, packed: speed2.n }, returnsWaiting: returnsWaiting(), movesToday: moves, missingOpen: q.get("SELECT COUNT(*) n FROM wms_missing WHERE status='open'").n, damagePending: q.get("SELECT COUNT(*) n FROM wms_damage WHERE status='reported'").n });
            });
            route('GET', '/api/wms/settings', 'wms', () => S());
            route('POST', '/api/wms/settings', 'wms', (req, u, b) => {
                const cur = S();
                for (const k of ['countEvery', 'stuckDays', 'stuckPct', 'varianceAlert', 'defaultCapacity'])
                    if (b[k] != null && b[k] !== '')
                        cur[k] = Math.max(1, +b[k] || cur[k]);
                setSetting('wms.settings', cur);
                log(u.id, 'settings.save', 'wms:settings', cur);
                return cur;
            });
            services.wms = {
                summary,
                receiveReturn(sku, note, userId) { const s = up(sku); const from = setLoc(s, 'RETURNS', 'return', userId || null); log(userId || null, 'wms.return', 'sku:' + s, { from, note: note || '' }); return { ok: true, sku: s, location: 'RETURNS' }; },
                lots: lotRows, dueRacks, postGrn, putaway, ensureSlot, SLOT_RE, curLoc,
                transfer(dest, skus, note, userId) { dest = up(dest); if (!DESTS[dest])
                    throw new ctx.HttpError(400, 'Unknown destination'); skus = [...new Set((skus || []).map(up).filter(Boolean))]; if (!skus.length)
                    return null; const id = createTransfer(dest, skus, note, userId || null); log(userId || null, 'wms.transfer.send', 'transfer:' + id, { dest, n: skus.length }); return id; },
            };
            ctx._wms = { summary, lotRows, dueRacks, S };
        },
        counts(u, ctx) {
            if (!ctx.can(u, 'wms') || !ctx._wms)
                return {};
            const { q } = ctx;
            const mine = q.get("SELECT COUNT(*) n FROM wms_counts WHERE status IN ('open','counting') AND (assigned_to=? OR assigned_to IS NULL)", u.id).n;
            const dmg = q.get("SELECT COUNT(*) n FROM wms_damage WHERE status='reported'").n;
            const recv = ctx._wms.lotRows().filter(l => l.status === 'not_received').length;
            return { counts: mine, damage: dmg, receiving: recv };
        },
        alerts(u, ctx) {
            if (!ctx.can(u, 'wms') || !ctx._wms)
                return [];
            const { q } = ctx, out = [], st = ctx._wms.S(), today = ctx.pkToday();
            const od = q.get("SELECT COUNT(*) n FROM wms_counts WHERE status IN ('open','counting') AND due<?", today).n;
            if (od)
                out.push({ level: 'bad', text: `${od} stock count${od > 1 ? 's are' : ' is'} overdue`, href: '#/counts' });
            const stuck = ctx._wms.lotRows().filter(l => l.stuck);
            if (stuck.length)
                out.push({ level: 'warn', text: `${stuck.length} lot${stuck.length > 1 ? 's' : ''} received over ${st.stuckDays} days ago but less than ${st.stuckPct}% listed (${stuck.slice(0, 3).map(l => l.name).join(', ')})`, href: '#/receiving' });
            for (const c of q.all("SELECT id, name, summary FROM wms_counts WHERE status='review'")) {
                let s = {};
                try {
                    s = JSON.parse(c.summary || '{}') || {};
                }
                catch (_a) { }
                const n = (s.missing || []).length;
                if (n >= st.varianceAlert)
                    out.push({ level: 'warn', text: `Stock count "${c.name}": ${n} pairs missing (Rs ${Math.round(s.missingValue || 0).toLocaleString('en-PK')} at cost)`, href: '#/counts/c/' + c.id });
            }
            const wk = q.get("SELECT COUNT(*) n FROM wms_damage WHERE status<>'rejected' AND at>=datetime('now','-7 days')").n;
            const prev = q.get("SELECT COUNT(*) n FROM wms_damage WHERE status<>'rejected' AND at>=datetime('now','-63 days') AND at<datetime('now','-7 days')").n / 8;
            if (wk >= 3 && wk >= 2 * prev)
                out.push({ level: 'warn', text: `Damage spike: ${wk} damaged pairs reported this week`, href: '#/damage' });
            return out;
        },
    };
};