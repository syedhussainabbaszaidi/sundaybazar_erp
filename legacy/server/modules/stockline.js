    // Stock line — every pair from the lot to the rack: GRN → sorting → QC → listed → photo → edited → uploaded → handed over → received in warehouse → located.
    // Lot-level steps (sorting, QC) are counts per lot; from listing on, each pair (SKU) has its own row in sl_items with a timestamp + user per step.
    // Stage rules: listed = a listings row exists (since trackFrom) · uploaded = SKU appears in core products (Shopify sync) or marked by hand ·
    // located = core locations has a real slot for it (written by the warehouse receive through the WMS put-away, or any WMS put-away after listing).
    // Marking a later step fills earlier missing ones (user unknown), so a pair never waits in two queues.
    'use strict';
    const PAIR = [['listed', 'listed_at', 'Listed', 'photo'], ['photo', 'photo_at', 'Photo done', 'editing'], ['edited', 'edited_at', 'Edited', 'upload'], ['uploaded', 'uploaded_at', 'Uploaded', 'handover to warehouse'],
        ['handed', 'handed_at', 'Handed over', 'warehouse to receive'], ['inwh', 'received_at', 'Received in warehouse', 'a location'], ['located', 'located_at', 'Located', null]];
    const LOTST = [['grn', 'Received (GRN)', 'sorting'], ['sorted', 'Sorted', 'QC check'], ['qc', 'QC passed', 'listing']];
    const REJECT = ['torn', 'sole', 'stain', 'mismatched', 'fake'];
    const NOT_SLOT = "('DAMAGED','OUTLET','REPAIR','SUPPLIER','STUDIO','MISSING','RETURNS','')";
    const up = s => String(s == null ? '' : s).trim().toUpperCase();
    const J = (s, d) => { try {
        return s ? JSON.parse(s) : d;
    }
    catch (_a) {
        return d;
    } };
    const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const ageDays = at => at ? (Date.now() - Date.parse(String(at).replace(' ', 'T') + (String(at).includes('Z') ? '' : 'Z'))) / 864e5 : null;
    const STAGE_SQL = `CASE WHEN located_at IS NOT NULL THEN 'located' WHEN received_at IS NOT NULL THEN 'inwh' WHEN handed_at IS NOT NULL THEN 'handed' WHEN uploaded_at IS NOT NULL THEN 'uploaded'
  WHEN edited_at IS NOT NULL THEN 'edited' WHEN photo_at IS NOT NULL THEN 'photo' ELSE 'listed' END`;
    const QUEUE = {
        photo: ['photo_at IS NULL AND uploaded_at IS NULL AND located_at IS NULL', 'i.listed_at'],
        edit: ['photo_at IS NOT NULL AND edited_at IS NULL AND uploaded_at IS NULL AND located_at IS NULL', 'i.photo_at'],
        upload: ['edited_at IS NOT NULL AND uploaded_at IS NULL', 'i.edited_at'],
        handover: ['handed_at IS NULL AND located_at IS NULL', 'COALESCE(i.uploaded_at, i.listed_at)'],
    };
    let ctx, q, lastSync = 0;
    const tx = fn => (ctx.db.isTransaction ? fn() : q.tx(fn)); // nested calls join the open transaction
    module.exports = {
        name: 'stockline',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS sl_items(sku TEXT PRIMARY KEY, lot TEXT, title TEXT, stage TEXT DEFAULT 'listed', grade TEXT, notes TEXT, pref_loc TEXT, location TEXT,
  listed_at TEXT, listed_by INTEGER, photo_at TEXT, photo_by INTEGER, photo_batch INTEGER, edited_at TEXT, edited_by INTEGER, edit_batch INTEGER,
  uploaded_at TEXT, uploaded_by INTEGER, upload_batch INTEGER, upload_src TEXT, handed_at TEXT, handed_by INTEGER, handover_id INTEGER,
  received_at TEXT, received_by INTEGER, located_at TEXT, located_by INTEGER, updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_sl_items_stage ON sl_items(stage);
CREATE INDEX IF NOT EXISTS ix_sl_items_lot ON sl_items(lot);
CREATE TABLE IF NOT EXISTS sl_batches(id INTEGER PRIMARY KEY, kind TEXT, user_id INTEGER, n INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sl_sort(lot TEXT PRIMARY KEY, rows TEXT, good INTEGER, damaged INTEGER DEFAULT 0, unmatched INTEGER DEFAULT 0, total INTEGER, notes TEXT,
  sorted_by INTEGER, sorted_at TEXT, updated_by INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sl_qc(id INTEGER PRIMARY KEY, lot TEXT, passed INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0, reasons TEXT, notes TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_sl_qc_lot ON sl_qc(lot);
CREATE TABLE IF NOT EXISTS sl_handovers(id INTEGER PRIMARY KEY, status TEXT DEFAULT 'sent', note TEXT, created_by INTEGER, at TEXT DEFAULT (datetime('now')), warnings INTEGER DEFAULT 0,
  received_by INTEGER, received_at TEXT, diff TEXT);
CREATE TABLE IF NOT EXISTS sl_handover_items(id INTEGER PRIMARY KEY, handover_id INTEGER, sku TEXT, suggested TEXT, src TEXT, confirmed_loc TEXT, received INTEGER DEFAULT 0, extra INTEGER DEFAULT 0,
  located INTEGER DEFAULT 0, warn TEXT, received_at TEXT, located_at TEXT);
CREATE INDEX IF NOT EXISTS ix_sl_hi ON sl_handover_items(handover_id);`,
        activity: { 'sl.sorted': 'Sorted lot', 'sl.qc': 'QC checked pairs', 'sl.photo': 'Photo done', 'sl.edited': 'Edited pictures', 'sl.uploaded': 'Uploaded to Shopify',
            'sl.handover': 'Handed over pair', 'sl.received': 'Received pair from listing', 'sl.located': 'Put pair on location', 'sl.handover.close': 'Finished handover receive' },
        migrate(c) {
            ctx = c;
            q = c.q;
            // pairs listed up to two weeks before this module was installed are still followed; older listings are history
            if (!c.setting('stockline.trackFrom', ''))
                c.setSetting('stockline.trackFrom', new Date(Date.now() - 14 * 864e5).toISOString().replace('T', ' ').slice(0, 19));
        },
        routes(c) {
            const { route, need, can, log, setting, setSetting, services } = c;
            const S = () => (Object.assign({ stuckDays: 2, unsortedDays: 1, blockHandover: false, trackFrom: setting('stockline.trackFrom', '') }, (setting('stockline.settings', {}) || {})));
            const anyOf = (u, ...p) => p.some(x => can(u, x));
            const gate = (u, ...p) => need(anyOf(u, ...p), 'Your account does not have access to this', 403);
            const wms = () => services.wms;
            const eng = () => c.PR.engine(Object.assign({}, c.PR.ECON_DEFAULTS, setting('list_econ', {}) || {}));
            const grnRow = name => { try {
                return q.get('SELECT * FROM wms_grn WHERE lot=?', name);
            }
            catch (_a) {
                return null;
            } };
            const uname = id => id ? ((q.get('SELECT name FROM users WHERE id=?', id) || {}).name || '') : '';
            /* ---------- keep the per-pair stages in step with listings, Shopify products and locations ---------- */
            function restage(where = '1=1', ...a) { q.run(`UPDATE sl_items SET stage=${STAGE_SQL}, updated_at=datetime('now') WHERE ${where}`, ...a); }
            function sync(force) {
                if (!force && Date.now() - lastSync < 5000)
                    return;
                lastSync = Date.now();
                tx(() => {
                    q.run(`INSERT OR IGNORE INTO sl_items(sku,lot,title,grade,listed_at,listed_by) SELECT sku, lot, title, cond, at, user_id FROM listings WHERE at>=?`, S().trackFrom);
                    q.run('DELETE FROM sl_items WHERE handed_at IS NULL AND located_at IS NULL AND sku NOT IN (SELECT sku FROM listings)');
                    // live on Shopify (core products, synced by SKU) → uploaded
                    q.run(`UPDATE sl_items SET upload_src='shopify', uploaded_at=MAX(listed_at, COALESCE((SELECT datetime(MIN(p.created_at)) FROM products p WHERE p.sku=sl_items.sku), datetime('now')))
          WHERE uploaded_at IS NULL AND EXISTS(SELECT 1 FROM products p WHERE p.sku=sl_items.sku)`);
                    q.run('UPDATE sl_items SET photo_at=COALESCE(photo_at,uploaded_at), edited_at=COALESCE(edited_at,uploaded_at) WHERE uploaded_at IS NOT NULL AND (photo_at IS NULL OR edited_at IS NULL)');
                    // a real slot in core locations, set after the pair was listed → located
                    q.run(`UPDATE sl_items SET located_at=(SELECT COALESCE(l.updated_at,datetime('now')) FROM locations l WHERE l.sku=sl_items.sku), location=(SELECT l.location FROM locations l WHERE l.sku=sl_items.sku)
          WHERE located_at IS NULL AND EXISTS(SELECT 1 FROM locations l WHERE l.sku=sl_items.sku AND UPPER(COALESCE(l.location,'')) NOT IN ${NOT_SLOT} AND l.location NOT LIKE 'TRANSIT-%' AND COALESCE(l.updated_at,'9') >= sl_items.listed_at)`);
                    restage(`stage <> ${STAGE_SQL}`);
                });
            }
            // a pair listed before trackFrom is followed as soon as someone scans it
            function track(sku) {
                sku = up(sku);
                let it = q.get('SELECT * FROM sl_items WHERE UPPER(sku)=?', sku);
                if (it)
                    return it;
                const l = q.get('SELECT sku, lot, title, cond, at, user_id FROM listings WHERE UPPER(sku)=?', sku);
                if (!l)
                    return null;
                q.run('INSERT OR IGNORE INTO sl_items(sku,lot,title,grade,listed_at,listed_by) VALUES(?,?,?,?,?,?)', l.sku, l.lot, l.title, l.cond, l.at, l.user_id);
                lastSync = 0;
                sync(true);
                return q.get('SELECT * FROM sl_items WHERE sku=?', l.sku);
            }
            const nextOf = st => (PAIR.find(p => p[0] === st) || [])[3] || null;
            function stageOf(sku) {
                sync();
                const it = track(sku);
                if (!it)
                    return null;
                const p = q.get('SELECT title, status, image, qty FROM products WHERE sku=? LIMIT 1', it.sku), loc = q.get('SELECT location FROM locations WHERE sku=?', it.sku);
                const h = it.handover_id ? q.get('SELECT id, status FROM sl_handovers WHERE id=?', it.handover_id) : null;
                const steps = PAIR.map(([k, col, l]) => ({ k, l, at: it[col] || null, by: uname(it[col.replace('_at', '_by')]) }));
                return Object.assign(Object.assign({}, it), { next: nextOf(it.stage), steps, product: p || null, inShopify: !!p, coreLoc: loc ? loc.location : null, handover: h });
            }
            /* ---------- lots: sorting sheet + QC → the lot's real mix ---------- */
            const cleanRows = rows => (Array.isArray(rows) ? rows : []).filter(r => r && +r.n > 0).map(r => ({ t: String(r.t || ''), g: ['Woman', 'Men', 'Kids'].includes(r.g) ? r.g : 'Woman', c: String(r.c || ''), n: Math.round(+r.n), b: String(r.b || '') }));
            const qcOf = lot => q.get('SELECT COALESCE(SUM(passed),0) passed, COALESCE(SUM(rejected),0) rejected, COUNT(*) batches, MAX(at) last FROM sl_qc WHERE lot=?', lot);
            const sortOf = lot => { const s = q.get('SELECT * FROM sl_sort WHERE lot=?', lot); if (s)
                s.rows = J(s.rows, []); return s; };
            // pairs found bad after the GRN count (sorting + QC): for the supplier claim on the PO
            function extraBad(lot) { const s = sortOf(lot); if (!s)
                return 0; const g = grnRow(lot) || {}; return (qcOf(lot).rejected || 0) + Math.max(0, (s.damaged || 0) + (s.unmatched || 0) - (+g.damaged || 0)); }
            // same lot planner as Lots (server /api/list/lots): comp → cost per unit of value, so listing prices follow the real mix
            function applyMix(name) {
                const l = q.get('SELECT * FROM lots WHERE name=?', name), s = sortOf(name);
                if (!l || !s)
                    return null;
                const qc = qcOf(name), pieces = +l.pieces || s.total || 0, good = Math.max(1, (s.good || 0) - (qc.rejected || 0));
                const bad = Math.max(0, Math.min(pieces - 1, pieces - good));
                const plan = eng().lotPlan({ name, kind: l.kind === 'leftover' ? 'leftover' : 'used', cost: +l.cost || 0, extra: +l.extra || 0, pieces, bad, comp: s.rows });
                q.run("UPDATE lots SET bad=?, comp=?, per_piece=?, cpv=?, updated_at=datetime('now') WHERE name=?", bad, JSON.stringify(s.rows), plan.per_piece || l.per_piece || null, plan.cpv || null, name);
                return { pieces, bad, good, per_piece: plan.per_piece, cpv: plan.cpv };
            }
            function compare(name, s) {
                const po = services.purchasing && services.purchasing.poForLot ? services.purchasing.poForLot(name) : null;
                if (!po)
                    return { po: null, rows: [] };
                const key = r => `${r.g}|${r.t}|${r.c}`, m = new Map();
                for (const r of po.mix || []) {
                    const k = key(r);
                    const x = m.get(k) || { g: r.g, t: r.t, c: r.c, expected: 0, actual: 0 };
                    x.expected += +r.n || 0;
                    m.set(k, x);
                }
                for (const r of (s && s.rows) || []) {
                    const k = key(r);
                    const x = m.get(k) || { g: r.g, t: r.t, c: r.c, expected: 0, actual: 0 };
                    x.actual += +r.n || 0;
                    m.set(k, x);
                }
                const rows = [...m.values()].map(x => (Object.assign(Object.assign({}, x), { diff: x.actual - x.expected }))).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
                const qc = qcOf(name), bad = s ? (s.damaged || 0) + (s.unmatched || 0) + (qc.rejected || 0) : null;
                return { po, rows, totals: { expected: po.pieces, sorted: s ? s.total : null, expBad: po.bad_est, bad, diff: s ? s.total - po.pieces : null } };
            }
            function lotCard(l) {
                const g = grnRow(l.name), s = sortOf(l.name), qc = qcOf(l.name);
                const st = q.get(`SELECT COUNT(*) listed, SUM(located_at IS NOT NULL) located, SUM(uploaded_at IS NOT NULL) uploaded FROM sl_items WHERE lot=?`, l.name);
                const grnPairs = g ? (+g.good || 0) + (+g.damaged || 0) : 0, sortedGood = s ? s.good || 0 : 0, checked = (qc.passed || 0) + (qc.rejected || 0), listed = st.listed || 0;
                const target = s ? Math.max(0, sortedGood - (qc.rejected || 0)) : (g ? +g.good || 0 : 0);
                const counts = { grn: g && !s ? grnPairs : 0, sorted: s ? Math.max(0, sortedGood - checked - Math.max(0, listed - (qc.passed || 0))) : 0, qc: Math.max(0, (qc.passed || 0) - listed) };
                const status = !g ? 'not_received' : !s ? 'to_sort' : checked < sortedGood && listed < target ? 'qc' : listed < target ? 'listing' : (st.located || 0) >= target ? 'done' : 'in_line';
                return { name: l.name, vendor: l.vendor || '', kind: l.kind || '', received_at: g ? g.received_at : null, grn: g ? { good: +g.good || 0, damaged: +g.damaged || 0, expected: g.expected } : null,
                    sorted: s ? { total: s.total, good: s.good, damaged: s.damaged, unmatched: s.unmatched, at: s.sorted_at, by: uname(s.sorted_by) } : null,
                    qc: { passed: qc.passed || 0, rejected: qc.rejected || 0, batches: qc.batches, last: qc.last }, listed, uploaded: st.uploaded || 0, located: st.located || 0, target,
                    pct: target ? Math.min(100, Math.round(100 * (st.located || 0) / target)) : 0, days: g ? Math.floor(ageDays(g.received_at)) : null, counts, status };
            }
            // lots in the line: received since trackFrom (or with sorting / tracked pairs), newest first
            function lineLots(all) {
                const from = S().trackFrom;
                let names;
                try {
                    names = q.all(`SELECT l.* FROM lots l LEFT JOIN wms_grn g ON g.lot=l.name WHERE g.received_at>=? OR l.name IN (SELECT lot FROM sl_sort) OR l.name IN (SELECT DISTINCT lot FROM sl_items) ORDER BY COALESCE(g.received_at, l.updated_at) DESC LIMIT 300`, from);
                }
                catch (_a) {
                    names = q.all('SELECT l.* FROM lots l WHERE l.name IN (SELECT lot FROM sl_sort) OR l.name IN (SELECT DISTINCT lot FROM sl_items) ORDER BY l.updated_at DESC LIMIT 300');
                }
                const out = names.map(lotCard);
                return all ? out : out.filter(x => x.status !== 'done' || (x.days != null && x.days <= 3));
            }
            route('GET', '/api/sl/lots', 'dashboard', (req, u, b, res, p, qs) => { gate(u, 'wms', 'listing'); sync(); return { lots: lineLots(qs.all === '1'), settings: S() }; });
            route('GET', '/api/sl/lots/:name', 'dashboard', (req, u, b, res, p) => {
                gate(u, 'wms', 'listing');
                const name = decodeURIComponent(p.name), l = q.get('SELECT * FROM lots WHERE name=?', name);
                need(l, 'Lot not found', 404);
                const s = sortOf(name);
                return { lot: lotCard(l), sort: s, qcBatches: q.all('SELECT x.*, us.name by_name FROM sl_qc x LEFT JOIN users us ON us.id=x.user_id WHERE lot=? ORDER BY id DESC', name).map(x => (Object.assign(Object.assign({}, x), { reasons: J(x.reasons, {}) }))),
                    compare: compare(name, s), types: c.PR.types(), conds: c.PR.CONDS, reasons: REJECT, perPair: can(u, 'pricing_apply') || can(u, 'finance') ? { per_piece: l.per_piece, cpv: l.cpv } : null };
            });
            route('POST', '/api/sl/lots/:name/sort', 'dashboard', (req, u, b, res, p) => {
                gate(u, 'wms', 'listing');
                const name = decodeURIComponent(p.name);
                need(q.get('SELECT 1 FROM lots WHERE name=?', name), 'Lot not found', 404);
                need(grnRow(name), 'Receive this lot first (Receiving / GRN)');
                const rows = cleanRows(b.rows), types = c.PR.types();
                need(rows.every(r => types.includes(r.t) && c.PR.CONDS.includes(r.c)), 'Choose a type and condition for every row');
                const damaged = Math.max(0, Math.round(+b.damaged || 0)), unmatched = Math.max(0, Math.round(+b.unmatched || 0)), good = rows.reduce((t, r) => t + r.n, 0), total = good + damaged + unmatched;
                need(good > 0, 'Count the pairs by type first');
                const ex = sortOf(name), at = nowUtc();
                if (ex)
                    q.run('UPDATE sl_sort SET rows=?, good=?, damaged=?, unmatched=?, total=?, notes=?, updated_by=?, updated_at=? WHERE lot=?', JSON.stringify(rows), good, damaged, unmatched, total, String(b.notes || '').slice(0, 500), u.id, at, name);
                else
                    q.run('INSERT INTO sl_sort(lot,rows,good,damaged,unmatched,total,notes,sorted_by,sorted_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', name, JSON.stringify(rows), good, damaged, unmatched, total, String(b.notes || '').slice(0, 500), u.id, at, u.id, at);
                const mix = applyMix(name), g = grnRow(name), grnPairs = (+g.good || 0) + (+g.damaged || 0);
                log(u.id, 'sl.sorted', 'lot:' + name, { n: total, good, damaged, unmatched, again: !!ex });
                return { ok: true, total, good, damaged, unmatched, mix, grnPairs, countDiff: total - grnPairs, compare: compare(name, sortOf(name)) };
            });
            route('POST', '/api/sl/lots/:name/qc', 'dashboard', (req, u, b, res, p) => {
                gate(u, 'wms', 'listing');
                const name = decodeURIComponent(p.name), s = sortOf(name);
                need(s, 'Save the sorting sheet first');
                const reasons = {};
                for (const r of REJECT) {
                    const n = Math.max(0, Math.round(+((b.rejected || {})[r]) || 0));
                    if (n)
                        reasons[r] = n;
                }
                const rejected = Object.values(reasons).reduce((t, n) => t + n, 0), passed = Math.max(0, Math.round(+b.passed || 0));
                need(passed + rejected > 0, 'Enter the pairs checked');
                const qc = qcOf(name);
                need((qc.passed || 0) + (qc.rejected || 0) + passed + rejected <= (s.good || 0), `More than the ${s.good} good pairs counted at sorting`);
                const id = Number(q.run('INSERT INTO sl_qc(lot,passed,rejected,reasons,notes,user_id) VALUES(?,?,?,?,?,?)', name, passed, rejected, JSON.stringify(reasons), String(b.notes || '').slice(0, 500), u.id).lastInsertRowid);
                const mix = applyMix(name), po = services.purchasing && services.purchasing.poForLot ? services.purchasing.poForLot(name) : null;
                log(u.id, 'sl.qc', 'lot:' + name, { n: passed + rejected, passed, rejected, reasons });
                return { ok: true, id, passed, rejected, reasons, mix, claim: po && rejected ? { po: po.id, no: po.no, supplier: po.supplier, pairs: rejected } : null, writtenOff: !po && rejected ? rejected : 0 };
            });
            /* ---------- queues & scan marks (photo / editing / upload) ---------- */
            const itemCols = `i.sku, i.lot, i.title, i.stage, i.grade, i.pref_loc, i.listed_at, i.photo_at, i.edited_at, i.uploaded_at, i.upload_src, i.handed_at, i.handover_id, us.name lister,
      (SELECT p.status FROM products p WHERE p.sku=i.sku LIMIT 1) shop_status`;
            function queue(kind, lim = 500) {
                const [w, since] = QUEUE[kind];
                return q.all(`SELECT ${itemCols}, ${since} since FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by WHERE ${w} ORDER BY ${since}, i.sku LIMIT ?`, lim)
                    .map(r => (Object.assign(Object.assign({}, r), { waitDays: Math.floor(ageDays(r.since) || 0) })));
            }
            const qn = kind => q.get(`SELECT COUNT(*) n FROM sl_items WHERE ${QUEUE[kind][0]}`).n;
            route('GET', '/api/sl/queue/:kind', 'dashboard', (req, u, b, res, p) => {
                const kind = p.kind;
                need(QUEUE[kind], 'Unknown queue', 404);
                gate(u, 'listing');
                sync(true);
                const rows = queue(kind), out = { kind, rows, total: qn(kind), settings: S() };
                if (kind === 'handover')
                    for (const r of rows) {
                        r.ready = !!r.uploaded_at;
                        r.warn = !r.photo_at ? 'Photo not done' : !r.uploaded_at ? 'Not uploaded yet' : null;
                    }
                if (kind === 'photo' || kind === 'edit')
                    out.counts = { photo: qn('photo'), edit: qn('edit') };
                return out;
            });
            const MARK = { photo: ['photo_at', 'photo_by', 'photo_batch', 'sl.photo', []], edit: ['edited_at', 'edited_by', 'edit_batch', 'sl.edited', ['photo_at']], upload: ['uploaded_at', 'uploaded_by', 'upload_batch', 'sl.uploaded', ['photo_at', 'edited_at']] };
            route('POST', '/api/sl/mark', 'dashboard', (req, u, b) => {
                gate(u, 'listing');
                const m = MARK[b.stage];
                need(m, 'Unknown step');
                const [col, by, bcol, act, before] = m, skus = [...new Set((Array.isArray(b.skus) ? b.skus : [b.sku]).map(up).filter(Boolean))];
                need(skus.length, 'Scan a SKU');
                sync();
                const done = [], skipped = [], at = nowUtc();
                if (b.undo) {
                    for (const s of skus) {
                        const it = q.get('SELECT * FROM sl_items WHERE UPPER(sku)=?', s);
                        if (!it || !it[col]) {
                            skipped.push({ sku: s, why: 'not marked' });
                            continue;
                        }
                        if (b.stage === 'upload' && it.upload_src === 'shopify') {
                            skipped.push({ sku: s, why: 'it is live on Shopify' });
                            continue;
                        }
                        q.run(`UPDATE sl_items SET ${col}=NULL, ${by}=NULL, ${bcol}=NULL${b.stage === 'upload' ? ', upload_src=NULL' : ''} WHERE sku=?`, it.sku);
                        restage('sku=?', it.sku);
                        done.push(it.sku);
                    }
                    return { ok: true, done, skipped };
                }
                const batch = Number(q.run('INSERT INTO sl_batches(kind,user_id,n) VALUES(?,?,0)', b.stage, u.id).lastInsertRowid);
                tx(() => {
                    for (const s of skus) {
                        const it = track(s);
                        if (!it) {
                            skipped.push({ sku: s, why: c.services.wms && c.services.wms.SLOT_RE && c.services.wms.SLOT_RE.test(s) ? 'that is a slot label' : 'not listed in the ERP' });
                            continue;
                        }
                        if (it[col]) {
                            skipped.push({ sku: it.sku, why: 'already done ' + (it.upload_src === 'shopify' && b.stage === 'upload' ? '(live on Shopify)' : '') });
                            continue;
                        }
                        q.run(`UPDATE sl_items SET ${col}=?, ${by}=?, ${bcol}=?${b.stage === 'upload' ? ", upload_src='manual'" : ''}${before.map(x => `, ${x}=COALESCE(${x}, ?)`).join('')} WHERE sku=?`, at, u.id, batch, ...before.map(() => at), it.sku);
                        restage('sku=?', it.sku);
                        log(u.id, act, 'sku:' + it.sku, { batch, lot: it.lot });
                        done.push(it.sku);
                    }
                    q.run('UPDATE sl_batches SET n=? WHERE id=?', done.length, batch);
                });
                return { ok: true, batch, done, skipped };
            });
            route('GET', '/api/sl/upload/check', 'dashboard', (req, u) => {
                gate(u, 'listing');
                sync(true);
                const cols = `i.sku, i.lot, i.title, i.uploaded_at, i.upload_src, us.name lister`;
                return {
                    autoDetected: q.all(`SELECT ${cols}, p.status shop_status FROM sl_items i JOIN products p ON p.sku=i.sku LEFT JOIN users us ON us.id=i.listed_by WHERE i.upload_src='shopify' AND i.uploaded_at>=datetime('now','-14 days') ORDER BY i.uploaded_at DESC LIMIT 300`),
                    notFound: q.all(`SELECT ${cols}, ub.name marked_by FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by LEFT JOIN users ub ON ub.id=i.uploaded_by WHERE i.upload_src='manual' AND NOT EXISTS(SELECT 1 FROM products p WHERE p.sku=i.sku) ORDER BY i.uploaded_at LIMIT 300`),
                    drafts: q.all(`SELECT ${cols}, p.status shop_status FROM sl_items i JOIN products p ON p.sku=i.sku LEFT JOIN users us ON us.id=i.listed_by WHERE UPPER(COALESCE(p.status,''))='DRAFT' AND i.located_at IS NULL ORDER BY i.uploaded_at LIMIT 300`),
                };
            });
            /* ---------- one pair ---------- */
            route('GET', '/api/sl/pair/:sku', 'dashboard', (req, u, b, res, p) => { gate(u, 'listing', 'wms', 'warehouse', 'team'); const x = stageOf(decodeURIComponent(p.sku)); need(x, 'Not listed in the ERP', 404); return x; });
            route('POST', '/api/sl/pair/:sku/location', 'dashboard', (req, u, b, res, p) => {
                gate(u, 'listing');
                const it = track(decodeURIComponent(p.sku));
                need(it, 'Not listed in the ERP', 404);
                const loc = up(b.location);
                need(!loc || /^[A-Z0-9][A-Z0-9-]{0,24}$/.test(loc), 'Location looks wrong (e.g. A-R2-C2-L1)');
                q.run('UPDATE sl_items SET pref_loc=? WHERE sku=?', loc || null, it.sku);
                return { ok: true, sku: it.sku, location: loc || null };
            });
            /* ---------- handover to the warehouse ---------- */
            // pairs per location: stock in Shopify + pairs not synced yet + places promised in open handovers
            function occupancy() {
                const m = new Map(), add = (k, n) => { if (k)
                    m.set(k, (m.get(k) || 0) + n); };
                for (const r of q.all("SELECT UPPER(COALESCE(l.location,p.rack,'')) loc, COUNT(*) n FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 GROUP BY 1"))
                    add(r.loc, r.n);
                for (const r of q.all('SELECT UPPER(l.location) loc, COUNT(*) n FROM locations l WHERE NOT EXISTS(SELECT 1 FROM products p WHERE p.sku=l.sku) GROUP BY 1'))
                    add(r.loc, r.n);
                for (const r of q.all("SELECT UPPER(COALESCE(i.confirmed_loc,i.suggested)) loc, COUNT(*) n FROM sl_handover_items i JOIN sl_handovers h ON h.id=i.handover_id WHERE h.status='sent' AND i.located=0 GROUP BY 1"))
                    add(r.loc, r.n);
                return m;
            }
            // lister's own location first; the rest go to the next slots with room, as few slots as possible
            function suggest(items) {
                const out = new Map(), auto = [], W = wms();
                for (const it of items) {
                    const pref = up(it.pref_loc);
                    if (pref) {
                        if (W && W.ensureSlot && W.SLOT_RE.test(pref))
                            W.ensureSlot(pref);
                        out.set(it.sku, { loc: pref, src: 'lister' });
                    }
                    else
                        auto.push(it.sku);
                }
                if (!auto.length)
                    return out;
                let slots = [];
                try {
                    slots = q.all('SELECT code, capacity FROM wms_slots WHERE active=1 ORDER BY rack, row, col, level');
                }
                catch (_a) { }
                const occ = occupancy();
                for (const v of out.values())
                    occ.set(v.loc, (occ.get(v.loc) || 0) + 1);
                const free = slots.map(s => ({ code: s.code, free: Math.max(0, (s.capacity || 0) - (occ.get(s.code) || 0)) })).filter(s => s.free > 0);
                let rest = auto.slice();
                while (rest.length) {
                    const fit = free.find(s => s.free >= rest.length) || free.slice().sort((a, b) => b.free - a.free)[0];
                    if (!fit || !fit.free)
                        break;
                    const take = rest.splice(0, Math.min(fit.free, rest.length));
                    fit.free -= take.length;
                    for (const s of take)
                        out.set(s, { loc: fit.code, src: 'auto' });
                }
                for (const s of rest)
                    out.set(s, { loc: '', src: 'none' });
                return out;
            }
            function checkForHandover(sku) {
                const it = track(sku);
                if (!it)
                    return { sku: up(sku), error: 'Not listed in the ERP' };
                if (it.located_at)
                    return { sku: it.sku, error: `Already on a location (${it.location || 'warehouse'})` };
                if (it.handed_at)
                    return { sku: it.sku, error: `Already handed over (handover #${it.handover_id})` };
                const warn = [!it.photo_at && 'photo not done', !it.uploaded_at && 'not uploaded to Shopify'].filter(Boolean);
                if (S().blockHandover && !it.uploaded_at)
                    return { sku: it.sku, error: 'Upload it first (photo, editing and upload must be done before handover)' };
                return { sku: it.sku, it, title: it.title, lot: it.lot, warn: warn.length ? 'Warning: ' + warn.join(', ') : null, pref_loc: it.pref_loc };
            }
            route('POST', '/api/sl/handovers/check', 'dashboard', (req, u, b) => {
                gate(u, 'listing');
                sync();
                const skus = [...new Set((b.skus || []).map(up).filter(Boolean))];
                const rows = skus.map(checkForHandover), okRows = rows.filter(r => !r.error), sg = suggest(okRows.map(r => r.it));
                return { rows: rows.map((_a) => {
                        var { it } = _a, r = __rest(_a, ["it"]);
                        return (Object.assign(Object.assign({}, r), { suggested: sg.get(r.sku) ? sg.get(r.sku).loc : null, src: sg.get(r.sku) ? sg.get(r.sku).src : null }));
                    }), blocking: S().blockHandover };
            });
            route('POST', '/api/sl/handovers', 'dashboard', (req, u, b) => {
                gate(u, 'listing');
                sync(true);
                const skus = [...new Set((b.skus || []).map(up).filter(Boolean))];
                need(skus.length, 'Scan the pairs you are handing over');
                const rows = skus.map(checkForHandover), good = rows.filter(r => !r.error), skipped = rows.filter(r => r.error).map(r => ({ sku: r.sku, why: r.error }));
                need(good.length, skipped.map(s => `${s.sku}: ${s.why}`).join(' · ') || 'Nothing to hand over');
                const id = tx(() => {
                    const sg = suggest(good.map(r => r.it));
                    const hid = Number(q.run('INSERT INTO sl_handovers(note,created_by,warnings) VALUES(?,?,?)', String(b.note || '').slice(0, 300), u.id, good.filter(r => r.warn).length).lastInsertRowid);
                    for (const r of good) {
                        const s = sg.get(r.sku) || { loc: '', src: 'none' };
                        q.run('INSERT INTO sl_handover_items(handover_id,sku,suggested,src,warn) VALUES(?,?,?,?,?)', hid, r.sku, s.loc || null, s.src, r.warn);
                        q.run("UPDATE sl_items SET handed_at=datetime('now'), handed_by=?, handover_id=? WHERE sku=?", u.id, hid, r.sku);
                        restage('sku=?', r.sku);
                        log(u.id, 'sl.handover', 'sku:' + r.sku, { handover: hid });
                    }
                    return hid;
                });
                return { ok: true, id, n: good.length, skipped, handover: handoverFull(id) };
            });
            function handoverFull(id) {
                const h = q.get('SELECT h.*, c.name created_name, r.name received_name FROM sl_handovers h LEFT JOIN users c ON c.id=h.created_by LEFT JOIN users r ON r.id=h.received_by WHERE h.id=?', +id);
                need(h, 'Handover not found', 404);
                const items = q.all(`SELECT x.*, COALESCE(i.title, (SELECT title FROM listings WHERE sku=x.sku)) title, i.lot, i.photo_at, i.uploaded_at FROM sl_handover_items x LEFT JOIN sl_items i ON i.sku=x.sku WHERE x.handover_id=? ORDER BY x.extra, COALESCE(x.confirmed_loc,x.suggested), x.sku`, h.id);
                const sent = items.filter(i => !i.extra);
                return Object.assign(Object.assign({}, h), { diff: J(h.diff, null), items, totals: { sent: sent.length, received: sent.filter(i => i.received).length, extra: items.filter(i => i.extra).length, located: items.filter(i => i.located).length, missing: sent.filter(i => !i.received).length } });
            }
            route('GET', '/api/sl/handovers', 'dashboard', (req, u, b, res, p, qs) => {
                gate(u, 'listing', 'warehouse', 'wms');
                const w = qs.status === 'sent' ? "h.status='sent'" : qs.status === 'received' ? "h.status='received'" : '1=1', mine = qs.mine === '1' ? ' AND h.created_by=' + (+u.id) : '';
                return q.all(`SELECT h.*, c.name created_name, r.name received_name, (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.extra=0) n,
        (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.received=1 AND x.extra=0) got, (SELECT COUNT(*) FROM sl_handover_items x WHERE x.handover_id=h.id AND x.located=1) located
        FROM sl_handovers h LEFT JOIN users c ON c.id=h.created_by LEFT JOIN users r ON r.id=h.received_by WHERE ${w}${mine} ORDER BY CASE h.status WHEN 'sent' THEN 0 ELSE 1 END, h.id DESC LIMIT 200`).map(h => (Object.assign(Object.assign({}, h), { diff: J(h.diff, null) })));
            });
            route('GET', '/api/sl/handovers/:id', 'dashboard', (req, u, b, res, p) => { gate(u, 'listing', 'warehouse', 'wms'); return handoverFull(p.id); });
            /* ---------- warehouse receive & put-away ---------- */
            const whGate = u => gate(u, 'warehouse', 'wms');
            const openH = id => { const h = q.get('SELECT * FROM sl_handovers WHERE id=?', +id); need(h, 'Handover not found', 404); need(h.status === 'sent', 'This handover is already received'); return h; };
            function receiveOne(h, sku, uid) {
                sku = up(sku);
                need(sku, 'Scan a SKU');
                const W = wms();
                need(!(W && W.SLOT_RE && W.SLOT_RE.test(sku)), sku + ' is a slot label, not a pair');
                let x = q.get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', h.id, sku), warn = null;
                if (x && x.received)
                    return { sku: x.sku, again: true, item: x };
                if (!x) {
                    const it = track(sku);
                    warn = !it ? 'Not listed in the ERP' : it.handover_id && it.handover_id !== h.id && it.handed_at ? `Belongs to handover #${it.handover_id}` : 'Not on this handover sheet';
                    const sg = it ? suggest([it]).get(it.sku) : null;
                    q.run('INSERT INTO sl_handover_items(handover_id,sku,suggested,src,extra,warn) VALUES(?,?,?,?,1,?)', h.id, it ? it.sku : sku, sg ? sg.loc || null : null, sg ? sg.src : 'none', warn);
                    x = q.get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', h.id, sku);
                }
                q.run("UPDATE sl_handover_items SET received=1, received_at=datetime('now') WHERE id=?", x.id);
                if (q.get('SELECT 1 FROM sl_items WHERE sku=?', x.sku)) {
                    q.run("UPDATE sl_items SET received_at=COALESCE(received_at,datetime('now')), received_by=COALESCE(received_by,?), handed_at=COALESCE(handed_at,datetime('now')), handover_id=? WHERE sku=?", uid, h.id, x.sku);
                    restage('sku=?', x.sku);
                }
                log(uid, 'sl.received', 'sku:' + x.sku, { handover: h.id, extra: !!x.extra });
                return { sku: x.sku, extra: !!x.extra, warn, item: q.get('SELECT * FROM sl_handover_items WHERE id=?', x.id) };
            }
            function locateOne(h, sku, slot, uid) {
                const W = wms();
                need(W && W.putaway, 'Warehouse module is not available');
                let x = q.get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', h.id, up(sku));
                if (!x || !x.received) {
                    receiveOne(h, sku, uid);
                    x = q.get('SELECT * FROM sl_handover_items WHERE handover_id=? AND UPPER(sku)=?', h.id, up(sku));
                }
                slot = up(slot || x.confirmed_loc || x.suggested);
                need(slot, 'Scan the slot for ' + x.sku);
                if (W.SLOT_RE.test(slot))
                    W.ensureSlot(slot);
                const r = W.putaway(uid, { sku: x.sku, slot, reason: 'putaway' }, { silent: true });
                q.run("UPDATE sl_handover_items SET confirmed_loc=?, located=1, located_at=datetime('now') WHERE id=?", slot, x.id);
                q.run("UPDATE sl_items SET located_at=datetime('now'), located_by=?, location=? WHERE sku=?", uid, slot, x.sku);
                restage('sku=?', x.sku);
                log(uid, 'sl.located', 'sku:' + x.sku, { slot, handover: h.id, changed: slot !== up(x.suggested || '') });
                return { sku: x.sku, slot, warnings: r.warnings || [], changed: slot !== up(x.suggested || ''), inSlot: r.inSlot, capacity: r.capacity };
            }
            route('POST', '/api/sl/handovers/:id/scan', 'dashboard', (req, u, b, res, p) => { whGate(u); const h = openH(p.id); const r = receiveOne(h, b.sku, u.id); return Object.assign(Object.assign({ ok: true }, r), { totals: handoverFull(h.id).totals }); });
            route('POST', '/api/sl/handovers/:id/locate', 'dashboard', (req, u, b, res, p) => { whGate(u); const h = openH(p.id); const r = tx(() => locateOne(h, b.sku, b.slot, u.id)); return Object.assign(Object.assign({ ok: true }, r), { totals: handoverFull(h.id).totals }); });
            route('POST', '/api/sl/handovers/:id/locate-all', 'dashboard', (req, u, b, res, p) => {
                whGate(u);
                const h = openH(p.id), done = [], skipped = [];
                for (const x of q.all('SELECT * FROM sl_handover_items WHERE handover_id=? AND received=1 AND located=0', h.id)) {
                    if (!x.suggested && !x.confirmed_loc) {
                        skipped.push({ sku: x.sku, why: 'no location suggested' });
                        continue;
                    }
                    try {
                        done.push(tx(() => locateOne(h, x.sku, null, u.id)));
                    }
                    catch (e) {
                        skipped.push({ sku: x.sku, why: e.message });
                    }
                }
                return { ok: true, done, skipped, totals: handoverFull(h.id).totals };
            });
            route('POST', '/api/sl/handovers/:id/close', 'dashboard', (req, u, b, res, p) => {
                whGate(u);
                const h = openH(p.id), full = handoverFull(h.id);
                const missing = full.items.filter(i => !i.extra && !i.received).map(i => i.sku), extra = full.items.filter(i => i.extra).map(i => i.sku), unlocated = full.items.filter(i => i.received && !i.located).map(i => i.sku);
                need(!unlocated.length || b.force, `${unlocated.length} received pair${unlocated.length > 1 ? 's have' : ' has'} no location yet`);
                const diff = missing.length || extra.length ? { missing, extra, note: String(b.note || '').slice(0, 300) } : null;
                tx(() => {
                    for (const s of missing) {
                        q.run('UPDATE sl_items SET handed_at=NULL, handed_by=NULL, handover_id=NULL WHERE sku=? AND received_at IS NULL', s);
                        restage('sku=?', s);
                    }
                    q.run("UPDATE sl_handovers SET status='received', received_by=?, received_at=datetime('now'), diff=? WHERE id=?", u.id, diff ? JSON.stringify(diff) : null, h.id);
                });
                log(u.id, 'sl.handover.close', 'handover:' + h.id, { n: full.totals.received, missing: missing.length, extra: extra.length });
                return { ok: true, missing, extra, unlocated, handover: handoverFull(h.id) };
            });
            /* ---------- board ---------- */
            const pkDay = col => `substr(datetime(${col},'+5 hours'),1,10)`;
            function pairCounts(lot) {
                const w = lot ? 'WHERE lot=?' : '', a = lot ? [lot] : [];
                const m = new Map(q.all(`SELECT stage, COUNT(*) n FROM sl_items ${w} GROUP BY stage`, ...a).map(r => [r.stage, r.n]));
                const oldest = {};
                for (const [k, col] of PAIR)
                    if (k !== 'located')
                        oldest[k] = (q.get(`SELECT MIN(${col}) at FROM sl_items WHERE stage=? ${lot ? 'AND lot=?' : ''}`, k, ...a) || {}).at || null;
                return { m, oldest };
            }
            function stuckList(lot) {
                const d = S().stuckDays, out = [];
                for (const [k, col, l, nx] of PAIR) {
                    if (k === 'located')
                        continue;
                    const r = q.get(`SELECT COUNT(*) n, MIN(${col}) at FROM sl_items WHERE stage=? AND ${col} < datetime('now', ?) ${lot ? 'AND lot=?' : ''}`, k, `-${d} days`, ...(lot ? [lot] : []));
                    if (r.n)
                        out.push({ stage: k, label: l, next: nx, n: r.n, oldest: r.at, days: Math.floor(ageDays(r.at)) });
                }
                return out;
            }
            function lotStuck(lots) {
                const st = S(), out = [];
                for (const l of lots) {
                    if (l.status === 'to_sort' && l.days != null && l.days >= st.unsortedDays)
                        out.push({ lot: l.name, stage: 'grn', label: 'Received, not sorted', n: l.counts.grn, days: l.days });
                    if (l.counts.sorted && l.sorted && ageDays(l.qc.last || l.sorted.at) > st.stuckDays)
                        out.push({ lot: l.name, stage: 'sorted', label: 'Sorted, QC not finished', n: l.counts.sorted, days: Math.floor(ageDays(l.qc.last || l.sorted.at)) });
                    if (l.counts.qc && l.qc.last && ageDays(l.qc.last) > st.stuckDays)
                        out.push({ lot: l.name, stage: 'qc', label: 'QC passed, not listed', n: l.counts.qc, days: Math.floor(ageDays(l.qc.last)) });
                }
                return out;
            }
            function board(lot) {
                sync(true);
                const lots = lineLots(false), pc = pairCounts(lot), scope = lot ? lots.filter(l => l.name === lot) : lots;
                const lc = { grn: 0, sorted: 0, qc: 0 }, lo = { grn: null, sorted: null, qc: null };
                const minAt = (a, b) => !a ? b : !b ? a : a < b ? a : b;
                for (const l of scope) {
                    for (const k of Object.keys(lc))
                        lc[k] += l.counts[k] || 0;
                    if (l.counts.grn)
                        lo.grn = minAt(lo.grn, l.received_at);
                    if (l.counts.sorted)
                        lo.sorted = minAt(lo.sorted, l.sorted && l.sorted.at);
                    if (l.counts.qc)
                        lo.qc = minAt(lo.qc, l.qc.last);
                }
                const stages = [...LOTST.map(([k, l, nx]) => ({ k, l, next: nx, lot: true, n: lc[k], oldest: lo[k] })), ...PAIR.map(([k, col, l, nx]) => ({ k, l, next: nx, n: pc.m.get(k) || 0, oldest: pc.oldest[k] || null }))]
                    .map(s => (Object.assign(Object.assign({}, s), { oldestDays: s.oldest ? Math.floor(ageDays(s.oldest)) : null })));
                // daily throughput (last 7 days, Pakistan days) per step and per person
                const days = [];
                for (let i = 6; i >= 0; i--)
                    days.push(new Date(Date.now() + 5 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
                const from = days[0], lw = lot ? ' AND lot=?' : '', la = lot ? [lot] : [];
                const daily = days.map(d => ({ day: d })), byDay = new Map(daily.map(r => [r.day, r])), people = new Map();
                const addP = (uid, k, n) => { if (!uid)
                    return; const p = people.get(uid) || { id: uid, name: uname(uid), total: 0 }; p[k] = (p[k] || 0) + n; p.total += n; people.set(uid, p); };
                const tally = (k, rows) => { for (const r of rows) {
                    const x = byDay.get(r.day);
                    if (x)
                        x[k] = (x[k] || 0) + r.n;
                    addP(r.uid, k, r.n);
                } };
                tally('sorted', q.all(`SELECT ${pkDay('sorted_at')} day, sorted_by uid, SUM(total) n FROM sl_sort WHERE ${pkDay('sorted_at')}>=?${lw} GROUP BY 1,2`, from, ...la));
                tally('qc', q.all(`SELECT ${pkDay('at')} day, user_id uid, SUM(passed+rejected) n FROM sl_qc WHERE ${pkDay('at')}>=?${lw} GROUP BY 1,2`, from, ...la));
                for (const [k, col] of PAIR)
                    tally(k, q.all(`SELECT ${pkDay(col)} day, ${col.replace('_at', '_by')} uid, COUNT(*) n FROM sl_items WHERE ${col} IS NOT NULL AND ${pkDay(col)}>=?${lw} GROUP BY 1,2`, from, ...la));
                const stuck = stuckList(lot), lstuck = lotStuck(scope);
                return { stages, lots, daily, people: [...people.values()].sort((a, b) => b.total - a.total), stuck, lotStuck: lstuck, settings: S(), lot: lot || null,
                    totals: { inLine: stages.filter(s => s.k !== 'located').reduce((t, s) => t + s.n, 0), stuckPairs: stuck.reduce((t, s) => t + s.n, 0) } };
            }
            route('GET', '/api/sl/board', 'dashboard', (req, u, b, res, p, qs) => { gate(u, 'listing', 'wms', 'team'); return board(qs.lot || ''); });
            route('GET', '/api/sl/stage/:k', 'dashboard', (req, u, b, res, p, qs) => {
                gate(u, 'listing', 'wms', 'team');
                sync(true);
                const k = p.k, lot = qs.lot || '';
                if (LOTST.some(x => x[0] === k))
                    return { k, lots: lineLots(false).filter(l => l.counts[k] > 0 && (!lot || l.name === lot)) };
                const st = PAIR.find(x => x[0] === k);
                need(st, 'Unknown stage', 404);
                const rows = q.all(`SELECT ${itemCols}, i.location, i.received_at, i.located_at, i.${st[1]} since FROM sl_items i LEFT JOIN users us ON us.id=i.listed_by WHERE i.stage=? ${lot ? 'AND i.lot=?' : ''} ORDER BY i.${st[1]} ${k === 'located' ? 'DESC' : ''} LIMIT 1000`, k, ...(lot ? [lot] : []))
                    .map(r => (Object.assign(Object.assign({}, r), { waitDays: Math.floor(ageDays(r.since) || 0) })));
                return { k, label: st[2], next: st[3], rows, stuckDays: S().stuckDays };
            });
            route('GET', '/api/sl/settings', 'dashboard', (req, u) => { gate(u, 'listing', 'wms', 'team'); return S(); });
            route('POST', '/api/sl/settings', 'dashboard', (req, u, b) => {
                need(can(u, 'settings') || can(u, 'team') || u.role === 'admin', 'Only the owner or a manager can change these', 403);
                const cur = Object.assign({}, (setting('stockline.settings', {}) || {}));
                if (b.stuckDays != null && b.stuckDays !== '')
                    cur.stuckDays = Math.max(1, Math.round(+b.stuckDays) || 2);
                if (b.unsortedDays != null && b.unsortedDays !== '')
                    cur.unsortedDays = Math.max(1, Math.round(+b.unsortedDays) || 1);
                if (b.blockHandover != null)
                    cur.blockHandover = !!b.blockHandover;
                setSetting('stockline.settings', cur);
                log(u.id, 'settings.save', 'stockline:settings', cur);
                return S();
            });
            function summary() {
                sync();
                const m = new Map(q.all('SELECT stage, COUNT(*) n FROM sl_items GROUP BY stage').map(r => [r.stage, r.n]));
                return { waiting: { listed: m.get('listed') || 0, photo: m.get('photo') || 0, edited: m.get('edited') || 0, uploaded: m.get('uploaded') || 0, handover: m.get('handed') || 0, receive: m.get('inwh') || 0 },
                    stuck: stuckList('').reduce((t, s) => t + s.n, 0) };
            }
            services.stockline = { summary, stage: stageOf, extraBad, sync: () => sync(true), board };
            ctx._sl = { sync, qn, S, stuckList, lineLots, lotStuck };
        },
        jobs: [{ name: 'sync', every: 5, offset: 2, run: c => { if (c._sl)
                    c._sl.sync(true); } }],
        counts(u, c) {
            if (!c._sl)
                return {};
            const can = p => c.can(u, p), out = {}, sl = c._sl;
            if (!['listing', 'wms', 'warehouse', 'team'].some(can))
                return out;
            sl.sync();
            if (can('listing')) {
                out.photos = sl.qn('photo') + sl.qn('edit');
                out.upload = sl.qn('upload');
                out.handover = c.q.get('SELECT COUNT(*) n FROM sl_items WHERE handed_at IS NULL AND located_at IS NULL AND uploaded_at IS NOT NULL').n;
            }
            if (can('warehouse') || can('wms'))
                out['put-away-in'] = c.q.get("SELECT COUNT(*) n FROM sl_handover_items x JOIN sl_handovers h ON h.id=x.handover_id WHERE h.status='sent' AND x.located=0 AND x.extra=0").n;
            if (can('wms') || can('listing'))
                out.sorting = sl.lineLots(false).filter(l => l.status === 'to_sort' || (l.status === 'qc' && l.counts.sorted > 0)).length;
            if (['listing', 'wms', 'team'].some(can))
                out.stockline = sl.stuckList('').reduce((t, s) => t + s.n, 0);
            return out;
        },
        alerts(u, c) {
            if (!c._sl)
                return [];
            const can = p => c.can(u, p), sl = c._sl, out = [], st = sl.S();
            const boss = can('team') || u.role === 'admin';
            if (['listing', 'wms', 'team'].some(can)) {
                sl.sync();
                const lots = sl.lineLots(false), ls = sl.lotStuck(lots);
                const uns = ls.filter(x => x.stage === 'grn');
                if (uns.length && (can('wms') || can('listing') || boss))
                    out.push({ level: 'warn', text: `${uns.length} lot${uns.length > 1 ? 's' : ''} received but not sorted after ${st.unsortedDays} day${st.unsortedDays > 1 ? 's' : ''}: ${uns.slice(0, 3).map(x => x.lot).join(', ')}`, href: '#/sorting' });
                for (const x of ls.filter(x => x.stage !== 'grn').slice(0, 3))
                    out.push({ level: 'warn', text: `${x.lot}: ${x.n} pairs ${x.label.toLowerCase()} for ${x.days} days`, href: '#/sorting/lot/' + encodeURIComponent(x.lot) });
                for (const s of sl.stuckList(''))
                    out.push({ level: s.days >= st.stuckDays * 2 ? 'bad' : 'warn', text: `${s.n} pair${s.n > 1 ? 's' : ''} waiting for ${s.next} over ${st.stuckDays} days (oldest ${s.days} days)`, href: '#/stockline/stage/' + s.stage });
            }
            // handover differences: the lister who sent it and the owner / managers
            for (const h of c.q.all("SELECT id, created_by, diff FROM sl_handovers WHERE status='received' AND diff IS NOT NULL AND received_at>=datetime('now','-3 days')")) {
                if (!(boss || h.created_by === u.id))
                    continue;
                const d = J(h.diff, {});
                out.push({ level: 'bad', text: `Handover #${h.id}: warehouse ${[d.missing && d.missing.length && `did not get ${d.missing.length} pair${d.missing.length > 1 ? 's' : ''} (${d.missing.slice(0, 3).join(', ')})`, d.extra && d.extra.length && `got ${d.extra.length} extra`].filter(Boolean).join(' and ')}`, href: '#/handover/h/' + h.id });
            }
            return out;
        },
    };
};