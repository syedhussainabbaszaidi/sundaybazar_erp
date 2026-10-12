    // Operations: tasks, recurring tasks, end-of-day notes, targets, daily team work report and performance.
    // The work report is built from what the ERP already records: cs_calls, order_items picks, listings, returns and the events log
    // (every module logs its actions with ctx.log). Attendance comes from ctx.services.hr when the HR module is present.
    'use strict';
    /* ---------------- small time helpers (business time = Pakistan, UTC+5) ---------------- */
    const H5 = 5 * 3600e3;
    const toPK = at => { if (!at)
        return null; const s = String(at); const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? null : new Date(d.getTime() + H5).toISOString().replace('T', ' ').slice(0, 19); };
    const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
    const hm2min = s => { const m = /(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
    const min2hm = m => m == null ? null : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
    const fmtDur = m => m >= 60 ? Math.floor(m / 60) + 'h ' + String(Math.round(m % 60)).padStart(2, '0') + 'm' : Math.round(m) + ' min';
    const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const utcStart = day => addDays(day, -1) + ' 19:00:00'; // PK midnight in UTC
    const J = (s, d) => { try {
        return s == null ? d : JSON.parse(s);
    }
    catch (_a) {
        return d;
    } };
    const pretty = a => String(a).replace(/^[a-z]+[.:]/, m => m.slice(0, -1) + ' ').replace(/[._:]/g, ' ').replace(/^\w/, c => c.toUpperCase());
    /* ---------------- metrics a target can use ---------------- */
    const METRICS = {
        calls: 'CS calls', confirmed: 'Orders confirmed', followups: 'Delivery follow-ups', picked: 'Pairs picked', packed: 'Orders packed',
        listed: 'Pairs listed', returns: 'Returns received', tasks_done: 'Tasks done', actions: 'All ERP actions',
    };
    const DEFAULT_TARGETS = [['cs', 'calls', 80], ['lister', 'listed', 60], ['warehouse', 'picked', 120], ['warehouse', 'packed', 80], ['tracking', 'followups', 60]];
    // added later (seeded once on upgrade): exchanges & WhatsApp (Uroosa) and Instagram & abandoned carts (Simra)
    const DEFAULT_TARGETS_2 = [['social', 'action:abandoned.contact', 30], ['social', 'action:inbox.reply', 30], ['exchange', 'action:inbox.reply', 40], ['exchange', 'action:exchange.step', 10]];
    const DEF = { shiftStart: '10:00', shiftEnd: '19:00', breakStart: '14:00', breakEnd: '15:00', idleMin: 90, lateGrace: 15, workdays: [1, 2, 3, 4, 5, 6],
        noActBy: '11:00', eodRemind: '18:30', snapshotAt: '21:30', lowPct: 50, lowShare: 60, absentLimit: 3, lateLimit: 5, hidden: [], showAdmins: false,
        mistakePenalty: 5, mistakeLimit: 5 };
    // "whose mistake" on closed customer tickets (tickets module, table tk_tickets) — internal departments count against a person
    const DEPTS = { listing: 'Listing', sorting: 'Sorting & QC', warehouse: 'Warehouse', dispatch: 'Dispatch', cs: 'CS', courier: 'Courier', supplier: 'Supplier', customer: 'Customer', unknown: 'Unknown' };
    const INTERNAL = ['listing', 'sorting', 'warehouse', 'dispatch', 'cs'];
    // mistake rate base: mistakes per 100 units of this output
    const RATE_BASE = { listing: ['listed', 'pairs listed'], dispatch: ['packed', 'orders packed'], warehouse: ['picked', 'pairs picked'], cs: ['confirmed', 'orders confirmed'], sorting: ['actions', 'ERP actions'] };
    // event actions that only show someone was around (not work) and ones already counted from their own table
    const PRESENCE = a => a === 'login' || a === 'setup' || a === 'logout' || /^hr\.(check|clock|attendance\.self)/.test(a);
    const FROM_TABLE = a => a.startsWith('cs:') || a === 'pick' || a === 'unpick' || a === 'listing.save' || a === 'return.received';
    const PRIOS = ['low', 'normal', 'high', 'urgent'], STATUSES = ['todo', 'doing', 'blocked', 'done'];
    const schema = `
CREATE TABLE IF NOT EXISTS ops_targets(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, ref TEXT NOT NULL, metric TEXT NOT NULL, target REAL NOT NULL, weight REAL NOT NULL DEFAULT 1,
  updated_by INTEGER, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(scope, ref, metric));
CREATE TABLE IF NOT EXISTS ops_tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'todo',
  due_date TEXT, due_time TEXT, link_type TEXT, link_ref TEXT, files TEXT, checklist TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT, last_by INTEGER,
  done_at TEXT, done_by INTEGER, template_id INTEGER, gen_date TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ops_tasks_gen ON ops_tasks(template_id, gen_date);
CREATE INDEX IF NOT EXISTS ix_ops_tasks_due ON ops_tasks(due_date);
CREATE TABLE IF NOT EXISTS ops_task_users(task_id INTEGER NOT NULL, user_id INTEGER NOT NULL, seen_at TEXT, PRIMARY KEY(task_id, user_id));
CREATE INDEX IF NOT EXISTS ix_ops_tu_user ON ops_task_users(user_id);
CREATE TABLE IF NOT EXISTS ops_comments(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, user_id INTEGER, kind TEXT DEFAULT 'comment', text TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS ix_ops_comments_task ON ops_comments(task_id);
CREATE TABLE IF NOT EXISTS ops_templates(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, priority TEXT DEFAULT 'normal', scope TEXT NOT NULL, ref TEXT NOT NULL,
  freq TEXT NOT NULL, weekdays TEXT, month_day INTEGER, due_time TEXT, checklist TEXT, active INTEGER DEFAULT 1, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS ops_eod(user_id INTEGER NOT NULL, day TEXT NOT NULL, did TEXT, problems TEXT, plan TEXT, at TEXT, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS ops_daily(day TEXT NOT NULL, pkey TEXT NOT NULL, user_id INTEGER, name TEXT, role TEXT, score REAL, data TEXT, built_at TEXT, PRIMARY KEY(day, pkey));
`;
    function make(ctx) {
        const { q, setting, setSetting, A } = ctx;
        const S = () => (Object.assign(Object.assign({}, DEF), (setting('ops_settings', {}) || {})));
        const nowPK = () => ctx.pkNow(), todayPK = () => ctx.pkToday();
        const labels = () => ctx.services.activityLabels || {};
        const roleLabel = r => (A.ROLES[r] && A.ROLES[r].label) || r || '';
        const cache = new Map();
        const bust = () => cache.clear();
        const cached = (k, ms, fn) => { const c = cache.get(k); if (c && Date.now() - c.t < ms)
            return c.v; const v = fn(); cache.set(k, { t: Date.now(), v }); return v; };
        /* ---------- mistakes: customer problems traced to a person (closed tickets with an internal "whose mistake") ---------- */
        const hasTk = () => !!q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tk_tickets'") && q.all('PRAGMA table_info(tk_tickets)').some(c => c.name === 'fault_user_id');
        function mistakeRows(from, to, uid) {
            if (!hasTk())
                return [];
            return q.all(`SELECT t.id, t.type, t.subject, t.order_name, t.sku, t.fault_dept dept, t.fault_user_id uid, t.fault_reason reason, t.fault_note note, t.fault_cost cost, t.resolved_at, t.status,
        date(t.resolved_at,'+5 hours') day FROM tk_tickets t WHERE t.status IN ('resolved','closed') AND t.fault_user_id IS NOT NULL AND t.fault_dept IN (${INTERNAL.map(() => '?').join(',')})
        AND t.resolved_at>=? AND t.resolved_at<? ${uid ? 'AND t.fault_user_id=?' : ''} ORDER BY t.resolved_at`, ...INTERNAL, utcStart(from), utcStart(addDays(to, 1)), ...(uid ? [uid] : []))
                .map(r => (Object.assign(Object.assign({}, r), { deptLabel: DEPTS[r.dept] || r.dept })));
        }
        function mistakeMap(from, to) { const m = new Map(); for (const r of mistakeRows(from, to)) {
            const k = r.uid + '|' + r.day;
            if (!m.has(k))
                m.set(k, []);
            m.get(k).push(r);
        } return m; }
        const tkStamp = () => { if (!hasTk())
            return ''; const r = q.get('SELECT COUNT(*) n, MAX(fault_at) a, MAX(resolved_at) b FROM tk_tickets WHERE fault_user_id IS NOT NULL'); return r.n + '|' + r.a + '|' + r.b; };
        // penalty: −N points per mistake on that day's score (floor 0). Idempotent: works from baseScore so snapshots can be re-applied.
        function applyMistakes(row, list, st) {
            list = list || [];
            if (row.baseScore === undefined)
                row.baseScore = row.score;
            const pen = Math.max(0, +st.mistakePenalty || 0) * list.length;
            row.mistakes = list.map(m => ({ id: m.id, type: m.type, order_name: m.order_name, sku: m.sku, dept: m.dept, deptLabel: m.deptLabel, reason: m.reason, cost: m.cost }));
            row.penalty = row.baseScore != null && list.length ? Math.min(row.baseScore, pen) : 0;
            row.score = row.baseScore == null ? null : Math.max(0, row.baseScore - pen);
            row.flags = (row.flags || []).filter(f => f.k !== 'mistake');
            if (list.length)
                row.flags.unshift({ k: 'mistake', t: `${list.length} mistake${list.length > 1 ? 's' : ''} (customer problem${list.length > 1 ? 's' : ''})`, lv: 'bad' });
            return row;
        }
        /* ---------- HR adapter (HR module is optional; tolerate any reasonable shape) ---------- */
        const hrSvc = () => ctx.services.hr;
        function hrList(fn, ...args) {
            const hr = hrSvc();
            if (!hr || typeof hr[fn] !== 'function')
                return null;
            try {
                let r = hr[fn](...args);
                if (!r || typeof r.then === 'function')
                    return null;
                if (!Array.isArray(r))
                    r = r.rows || r.employees || r.list || Object.values(r);
                return Array.isArray(r) ? r : null;
            }
            catch (e) {
                return null;
            }
        }
        const tm = v => { if (!v)
            return null; const s = String(v); if (s.includes('T') && /Z|[+-]\d\d:?\d\d$/.test(s))
            return (toPK(s) || '').slice(11, 16) || null; const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(s) || /(\d{1,2}):(\d{2})/.exec(s); return m ? m[1].padStart(2, '0') + ':' + m[2] : null; };
        function hrDay(day) {
            const rows = hrList('attendance', day);
            if (!rows)
                return null;
            return rows.map(r => {
                var _a, _b, _c, _d, _e;
                let st = String(r.status || r.state || (r.present === false ? 'absent' : r.present ? 'present' : '') || '').toLowerCase().replace(/[\s-]+/g, '_');
                if (/leave/.test(st))
                    st = 'leave';
                else if (/holiday/.test(st))
                    st = 'holiday';
                else if (/^(off|weekly_off|rest|day_off)$/.test(st))
                    st = 'off';
                else if (/half/.test(st))
                    st = 'half_day';
                const late = !!(r.late || r.is_late || st === 'late' || +r.late_min > 0 || +r.lateMinutes > 0);
                return { user_id: (_b = (_a = r.user_id) !== null && _a !== void 0 ? _a : r.userId) !== null && _b !== void 0 ? _b : null, emp_id: (_e = (_d = (_c = r.employee_id) !== null && _c !== void 0 ? _c : r.emp_id) !== null && _d !== void 0 ? _d : r.employeeId) !== null && _e !== void 0 ? _e : (r.user_id == null ? r.id : null), name: r.name || r.employee || r.employee_name,
                    role: r.role || r.designation || r.department || '', status: st || (r.in || r.check_in ? 'present' : ''), in: tm(r.in || r.check_in || r.checkin || r.time_in || r.in_at),
                    out: tm(r.out || r.check_out || r.checkout || r.time_out || r.out_at), late, lateMin: +(r.late_min || r.lateMinutes || 0) || null,
                    shiftStart: tm(r.shift_start || r.shiftStart), shiftEnd: tm(r.shift_end || r.shiftEnd) };
            });
        }
        function hrEmployees() {
            const rows = hrList('employees') || hrList('list');
            if (!rows)
                return [];
            return rows.filter(e => e && e.active !== 0 && e.active !== false && !/left|terminated|resigned|inactive/i.test(e.status || ''))
                .map(e => { var _a, _b, _c; return ({ emp_id: (_a = e.id) !== null && _a !== void 0 ? _a : e.employee_id, user_id: (_c = (_b = e.user_id) !== null && _b !== void 0 ? _b : e.userId) !== null && _c !== void 0 ? _c : null, name: e.name, role: e.role || e.designation || e.department || '' }); });
        }
        function hrWarnings(person, from, to) {
            const hr = hrSvc();
            if (!hr)
                return null;
            try {
                if (typeof hr.warnings === 'function') {
                    const r = hr.warnings({ user_id: person.user_id, employee_id: person.emp_id, from, to });
                    if (typeof r === 'number')
                        return r;
                    if (Array.isArray(r))
                        return r.length;
                    if (r && typeof r.count === 'number')
                        return r.count;
                }
                if (typeof hr.warningCount === 'function') {
                    const n = hr.warningCount(person.user_id, from, to);
                    if (typeof n === 'number')
                        return n;
                }
                // HR module has no warnings service: read its warnings table if it exists (read-only)
                if (person.emp_id != null)
                    return q.get('SELECT COUNT(*) n FROM hr_warnings WHERE emp_id=? AND day>=? AND day<=?', person.emp_id, from, to).n;
            }
            catch (e) { }
            return null;
        }
        const PRESENT = s => ['present', 'late', 'half_day', 'wfh', 'field', 'checked_in', 'in'].includes(s);
        const NOWORK = s => ['leave', 'holiday', 'off'].includes(s);
        /* ---------- who is on the report ---------- */
        function people(day, extraUserIds = []) {
            const st = S(), hidden = new Set((st.hidden || []).map(String));
            const users = q.all('SELECT id,name,role,active,created_at FROM users ORDER BY name');
            const extra = new Set(extraUserIds.map(Number));
            const list = [];
            for (const u of users) {
                if (hidden.has('u:' + u.id))
                    continue;
                if (u.role === 'admin' && !st.showAdmins)
                    continue;
                const createdPK = (toPK(u.created_at) || '').slice(0, 10);
                if (!(u.active && createdPK <= day) && !extra.has(u.id))
                    continue;
                list.push({ key: 'u:' + u.id, user_id: u.id, emp_id: null, name: u.name, role: u.role, roleLabel: roleLabel(u.role), since: createdPK });
            }
            const byUser = new Map(list.map(p => [p.user_id, p]));
            for (const e of hrEmployees()) {
                if (e.user_id != null && byUser.has(+e.user_id)) {
                    byUser.get(+e.user_id).emp_id = e.emp_id;
                    continue;
                }
                if (e.user_id != null)
                    continue; // linked to a hidden / inactive login
                if (hidden.has('e:' + e.emp_id))
                    continue;
                list.push({ key: 'e:' + e.emp_id, user_id: null, emp_id: e.emp_id, name: e.name, role: '', roleLabel: e.role || 'No login', since: null, noLogin: true });
            }
            return list;
        }
        /* ---------- targets ---------- */
        const allTargets = () => q.all('SELECT * FROM ops_targets ORDER BY scope, ref, metric');
        function targetsFor(p, all = allTargets()) {
            const m = new Map();
            for (const t of all)
                if (t.scope === 'role' && p.role && t.ref === p.role)
                    m.set(t.metric, { metric: t.metric, target: t.target, weight: t.weight, src: 'role' });
            for (const t of all)
                if (t.scope === 'person' && t.ref === p.key) {
                    if (+t.target > 0)
                        m.set(t.metric, { metric: t.metric, target: t.target, weight: t.weight, src: 'person' });
                    else
                        m.delete(t.metric);
                }
            return [...m.values()].filter(t => t.target > 0);
        }
        const metricLabel = k => METRICS[k] || (k.startsWith('action:') ? (labels()[k.slice(7)] || pretty(k.slice(7).replace(/\*$/, ' (all)'))) : k);
        function metricValue(counts, k) {
            if (k.startsWith('action:') && k.endsWith('*')) {
                const pre = k.slice(0, -1);
                let n = 0;
                for (const [c, v] of Object.entries(counts))
                    if (c.startsWith(pre))
                        n += v;
                return n;
            }
            return counts[k] || 0;
        }
        function scoreOf(counts, targets) {
            if (!targets.length)
                return { score: null, parts: [] };
            let sw = 0, s = 0;
            const parts = [];
            for (const t of targets) {
                const actual = metricValue(counts, t.metric), pct = Math.min(1.5, actual / t.target), w = +t.weight > 0 ? +t.weight : 1;
                sw += w;
                s += w * pct;
                parts.push({ metric: t.metric, label: metricLabel(t.metric), actual, target: t.target, weight: w, pct: Math.round(pct * 100) });
            }
            return { score: Math.round(Math.min(150, 100 * s / sw)), parts };
        }
        /* ---------- collect activity for PK days [from, to] from every source ---------- */
        function collect(from, to, opts = {}) {
            const a = utcStart(from), b = utcStart(addDays(to, 1));
            const L = labels(), out = new Map();
            const rec = (uid, pk) => { const k = uid + '|' + pk.slice(0, 10); let r = out.get(k); if (!r)
                out.set(k, r = { uid, day: pk.slice(0, 10), counts: {}, labels: {}, times: [], seen: [], items: [] }); return r; };
            const add = (uid, at, metrics, label, n = 1, detail, kind) => {
                const pk = toPK(at);
                if (!pk || !uid)
                    return;
                const r = rec(uid, pk);
                for (const m of metrics)
                    r.counts[m] = (r.counts[m] || 0) + n;
                r.labels[label] = (r.labels[label] || 0) + n;
                r.counts.actions = (r.counts.actions || 0) + 1;
                r.times.push(pk.slice(11));
                r.seen.push(pk.slice(11));
                if (opts.items)
                    r.items.push({ at: pk.slice(11), label, detail: detail || '', kind: kind || 'work', n });
            };
            for (const c of q.all('SELECT c.user_id, c.at, c.outcome, o.name FROM cs_calls c LEFT JOIN orders o ON o.id=c.order_id WHERE c.at>=? AND c.at<? AND c.user_id IS NOT NULL', a, b)) {
                const fu = /^delivery_/.test(c.outcome || '');
                add(c.user_id, c.at, fu ? ['followups'] : (c.outcome === 'confirmed' ? ['calls', 'confirmed'] : ['calls']), fu ? 'Delivery follow-up call' : 'CS call', 1, `${c.name || ''} · ${String(c.outcome || '').replace(/_/g, ' ')}`, 'call');
            }
            for (const p of q.all('SELECT i.picked_by uid, i.picked_at at, COALESCE(i.qty,1) qty, i.sku, o.name FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE i.picked=1 AND i.picked_by IS NOT NULL AND i.picked_at>=? AND i.picked_at<?', a, b))
                add(p.uid, p.at, ['picked'], 'Picked pair', p.qty, `${p.sku || ''} · ${p.name || ''}`, 'pick');
            for (const l of q.all('SELECT user_id, at, sku FROM listings WHERE at>=? AND at<? AND user_id IS NOT NULL', a, b))
                add(l.user_id, l.at, ['listed'], 'Listed pair', 1, l.sku, 'list');
            for (const r of q.all('SELECT r.user_id, r.at, r.sku, o.name FROM returns r LEFT JOIN orders o ON o.id=r.order_id WHERE r.at>=? AND r.at<? AND r.user_id IS NOT NULL', a, b))
                add(r.user_id, r.at, ['returns'], 'Received return (pair)', 1, `${r.sku || ''} · ${r.name || ''}`, 'return');
            const orderName = new Map();
            for (const e of q.all('SELECT user_id, at, action, entity, detail FROM events WHERE at>=? AND at<? AND user_id IS NOT NULL', a, b)) {
                const act = String(e.action || '');
                const pk = toPK(e.at);
                if (!pk)
                    continue;
                const r0 = rec(e.user_id, pk);
                r0.counts['action:' + act] = (r0.counts['action:' + act] || 0) + 1;
                if (PRESENCE(act)) {
                    r0.seen.push(pk.slice(11));
                    if (opts.items)
                        r0.items.push({ at: pk.slice(11), label: L[act] || pretty(act), detail: '', kind: 'presence' });
                    continue;
                }
                if (FROM_TABLE(act))
                    continue;
                let detail = '';
                if (opts.items) {
                    const ent = String(e.entity || '');
                    if (ent.startsWith('order:')) {
                        const id = ent.slice(6);
                        if (!orderName.has(id))
                            orderName.set(id, (q.get('SELECT name FROM orders WHERE id=?', id) || {}).name || id);
                        detail = orderName.get(id);
                    }
                    else if (ent && !/^(settings|user|finance|products|listings)$/.test(ent))
                        detail = ent.replace(/^[a-z_]+:/, '');
                    const d = String(e.detail || '');
                    if (d && d !== 'null' && d !== '""' && !d.startsWith('{') && !d.startsWith('['))
                        detail += (detail ? ' · ' : '') + d.slice(0, 80);
                }
                const metrics = [];
                if (act === 'pack')
                    metrics.push('packed');
                else if (act === 'note')
                    metrics.push('followups');
                else if (act === 'ops.task.done')
                    metrics.push('tasks_done');
                add(e.user_id, e.at, metrics, act === 'pack' ? 'Packed order' : act === 'note' ? 'Order note' : (L[act] || pretty(act)), 1, detail);
            }
            for (const r of out.values()) {
                r.times.sort();
                r.seen.sort();
                if (opts.items)
                    r.items.sort((x, y) => x.at < y.at ? -1 : x.at > y.at ? 1 : 0);
            }
            return out;
        }
        /* ---------- idle gap inside working hours ---------- */
        function idleGap(times, att, st, isToday) {
            const s0 = hm2min(st.shiftStart), s1 = hm2min(st.shiftEnd), b0 = hm2min(st.breakStart), b1 = hm2min(st.breakEnd);
            const pts = times.map(t => hm2min(t)).filter(m => m != null && m >= s0 && m <= s1);
            if (att && att.source === 'hr') {
                const i = hm2min(att.in), o = hm2min(att.out);
                if (i != null)
                    pts.push(Math.max(i, s0));
                if (o != null)
                    pts.push(Math.min(o, s1));
                else if (i != null && isToday) {
                    const n = hm2min(nowPK().slice(11));
                    if (n > s0)
                        pts.push(Math.min(n, s1));
                }
            }
            const p = [...new Set(pts)].sort((x, y) => x - y);
            let best = null;
            for (let k = 1; k < p.length; k++) {
                let g = p[k] - p[k - 1];
                if (b0 != null && b1 != null && b1 > b0)
                    g -= Math.max(0, Math.min(p[k], b1) - Math.max(p[k - 1], b0));
                if (!best || g > best.min)
                    best = { min: g, from: min2hm(p[k - 1]), to: min2hm(p[k]) };
            }
            return best && best.min > 0 ? best : null;
        }
        /* ---------- overdue / open tasks per user as of a moment ---------- */
        function taskStats(day, isToday) {
            const cut = isToday ? nowPK() : day + ' 23:59:59';
            const due = "(t.due_date || ' ' || COALESCE(t.due_time,'23:59') || ':00')";
            const rows = q.all(`SELECT a.user_id, SUM(CASE WHEN t.due_date IS NOT NULL AND ${due} < ? AND (t.done_at IS NULL OR t.done_at > ?) THEN 1 ELSE 0 END) overdue,
       SUM(CASE WHEN t.done_at IS NULL OR t.done_at > ? THEN 1 ELSE 0 END) open
       FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE t.created_at <= ? GROUP BY a.user_id`, cut, cut, cut, cut);
            return new Map(rows.map(r => [r.user_id, r]));
        }
        /* ---------- one person-day row ---------- */
        function buildRow(p, day, r, hrRow, tgAll, ctxDay) {
            const isToday = ctxDay.isToday, nowMin = ctxDay.nowMin;
            const st = hrRow && hrRow.shiftStart && hrRow.shiftEnd && hm2min(hrRow.shiftEnd) > hm2min(hrRow.shiftStart) ? Object.assign(Object.assign({}, ctxDay.st), { shiftStart: hrRow.shiftStart, shiftEnd: hrRow.shiftEnd }) : ctxDay.st;
            const counts = (r && r.counts) || {}, actions = counts.actions || 0;
            const first = r && r.times.length ? r.times[0].slice(0, 5) : null, last = r && r.times.length ? r.times[r.times.length - 1].slice(0, 5) : null;
            let att;
            if (hrRow)
                att = { source: 'hr', status: hrRow.status || 'unknown', in: hrRow.in, out: hrRow.out, late: hrRow.late, lateMin: hrRow.lateMin };
            else {
                const seen = r && r.seen.length ? r.seen : null;
                att = { source: 'activity', status: seen ? 'active' : 'none', in: seen ? seen[0].slice(0, 5) : null, out: seen ? seen[seen.length - 1].slice(0, 5) : null };
            }
            const targets = p.user_id || p.emp_id != null ? targetsFor(p, tgAll) : [];
            const sc = scoreOf(counts, targets), tracked = targets.length > 0;
            const workday = (st.workdays || []).includes(weekday(day)) && !NOWORK(att.status);
            const absent = att.status === 'absent' && !actions;
            const present = att.source === 'hr' ? PRESENT(att.status) || actions > 0 : att.status === 'active';
            const idle = actions ? idleGap(r.times, att, st, isToday) : null;
            const dayDone = !isToday || nowMin >= hm2min(st.shiftEnd);
            const ts = (p.user_id && ctxDay.tasks.get(p.user_id)) || { overdue: 0, open: 0 };
            const eod = p.user_id ? ctxDay.eod.get(p.user_id) || null : null;
            const flags = [];
            if (absent)
                flags.push({ k: 'absent', t: 'Absent', lv: 'bad' });
            if (att.status === 'absent' && actions)
                flags.push({ k: 'nocheckin', t: 'Worked but not checked in (HR)', lv: 'warn' });
            if (!actions && workday && !absent && !p.noLogin && (!isToday || nowMin >= hm2min(st.noActBy))) {
                const t = att.source === 'hr' && att.in ? `No work recorded (checked in ${att.in})` : 'No work recorded';
                flags.push(tracked ? { k: 'noact', t, lv: 'bad' } : { k: 'noact', t, lv: 'info' });
            }
            else if (!actions && workday && !absent && !p.noLogin && isToday)
                flags.push({ k: 'noact', t: 'No work recorded yet', lv: 'info' });
            if (idle && idle.min > st.idleMin && workday && !absent)
                flags.push({ k: 'idle', t: `Idle ${fmtDur(idle.min)} (${idle.from}–${idle.to})`, lv: tracked ? 'warn' : 'info' });
            if (tracked && sc.score != null && dayDone && workday && !absent && present && sc.score < st.lowPct)
                flags.push({ k: 'low', t: `Below ${st.lowPct}% of target (${sc.score}%)`, lv: 'bad' });
            if (att.source === 'hr' && att.late)
                flags.push({ k: 'late', t: 'Late' + (att.in ? ` (in ${att.in})` : ''), lv: 'warn' });
            else if (att.source !== 'hr' && tracked && workday && att.in && hm2min(att.in) > hm2min(st.shiftStart) + (+st.lateGrace || 0))
                flags.push({ k: 'late', t: `Late start: first seen ${att.in}`, lv: 'warn' });
            if (ts.overdue)
                flags.push({ k: 'overdue', t: `${ts.overdue} overdue task${ts.overdue > 1 ? 's' : ''}`, lv: 'warn' });
            if (p.user_id && !eod && workday && present && (dayDone || nowMin >= hm2min(st.eodRemind)))
                flags.push({ k: 'noeod', t: 'No end-of-day note', lv: 'info' });
            const lab = Object.entries((r && r.labels) || {}).map(([l, n]) => ({ l, n })).sort((x, y) => y.n - x.n);
            return { key: p.key, user_id: p.user_id, emp_id: p.emp_id, name: p.name, role: p.role, roleLabel: p.roleLabel, noLogin: !!p.noLogin, att, first, last, actions, counts, labels: lab,
                targets: sc.parts, score: sc.score, tracked, workday, present, idle, shift: st.shiftStart + '–' + st.shiftEnd, tasks: { done: counts.tasks_done || 0, overdue: ts.overdue || 0, open: ts.open || 0 }, eod, flags };
        }
        function dayCtx(day) {
            const st = S(), today = todayPK(), isToday = day === today;
            const eod = new Map(q.all('SELECT * FROM ops_eod WHERE day=?', day).map(e => [e.user_id, e]));
            return { st, isToday, nowMin: isToday ? hm2min(nowPK().slice(11)) : 24 * 60, tasks: taskStats(day, isToday), eod };
        }
        function liveDay(day, opts = {}) {
            const recs = collect(day, day, { items: !!opts.items });
            const ids = [...new Set([...recs.values()].map(r => r.uid))];
            const ppl = people(day, ids);
            const hr = hrDay(day), hrBy = new Map(), hrByEmp = new Map();
            for (const x of hr || []) {
                if (x.user_id != null)
                    hrBy.set(+x.user_id, x);
                if (x.emp_id != null)
                    hrByEmp.set(String(x.emp_id), x);
            }
            if (hr)
                for (const x of hr)
                    if (x.user_id == null && x.emp_id != null && !ppl.find(p => p.key === 'e:' + x.emp_id) && !(S().hidden || []).includes('e:' + x.emp_id))
                        ppl.push({ key: 'e:' + x.emp_id, user_id: null, emp_id: x.emp_id, name: x.name || 'Employee ' + x.emp_id, role: '', roleLabel: x.role || 'No login', noLogin: true });
            const c = dayCtx(day), tg = allTargets(), mm = mistakeMap(day, day);
            for (const k of mm.keys()) {
                const uid = +k.split('|')[0];
                if (!ppl.some(p => p.user_id === uid) && !(S().hidden || []).includes('u:' + uid)) {
                    const u = q.get('SELECT id,name,role,created_at FROM users WHERE id=?', uid);
                    if (u && (u.role !== 'admin' || S().showAdmins))
                        ppl.push({ key: 'u:' + u.id, user_id: u.id, emp_id: null, name: u.name, role: u.role, roleLabel: roleLabel(u.role), since: null });
                }
            }
            const rows = ppl.map(p => {
                const r = p.user_id ? recs.get(p.user_id + '|' + day) : null;
                const hrow = p.user_id ? (hrBy.get(p.user_id) || (p.emp_id != null ? hrByEmp.get(String(p.emp_id)) : null)) : hrByEmp.get(String(p.emp_id));
                const row = applyMistakes(buildRow(p, day, r, hrow || null, tg, c), p.user_id ? mm.get(p.user_id + '|' + day) : null, c.st);
                if (opts.items)
                    row.items = r ? r.items : [];
                return row;
            });
            return { rows, hr: !!hr };
        }
        const sortRows = rows => rows.sort((a, b) => a.name.localeCompare(b.name));
        function dayReport(day, opts = {}) {
            day = isDay(day) ? day : todayPK();
            const isToday = day === todayPK();
            const build = () => {
                let rows, hr, snap = null;
                const saved = !isToday && !opts.live ? q.all('SELECT * FROM ops_daily WHERE day=?', day) : [];
                if (saved.length) {
                    const eod = new Map(q.all('SELECT * FROM ops_eod WHERE day=?', day).map(e => [e.user_id, e]));
                    const mm = mistakeMap(day, day), st0 = S();
                    rows = saved.map(s => { const d = J(s.data, {}); if (d.user_id)
                        d.eod = eod.get(d.user_id) || d.eod || null; return applyMistakes(d, d.user_id ? mm.get(d.user_id + '|' + day) : null, st0); });
                    hr = rows.some(r => r.att && r.att.source === 'hr');
                    snap = saved.reduce((m, s) => s.built_at > m ? s.built_at : m, '');
                }
                else
                    ({ rows, hr } = liveDay(day));
                sortRows(rows);
                const t = { staff: rows.length, present: rows.filter(r => r.present).length, active: rows.filter(r => r.actions > 0).length,
                    noActivity: rows.filter(r => r.flags.some(f => f.k === 'noact')).length, idle: rows.filter(r => r.flags.some(f => f.k === 'idle')).length,
                    low: rows.filter(r => r.flags.some(f => f.k === 'low')).length, late: rows.filter(r => r.flags.some(f => f.k === 'late')).length,
                    absent: rows.filter(r => r.flags.some(f => f.k === 'absent')).length, eod: rows.filter(r => r.eod).length, eodDue: rows.filter(r => r.user_id && r.present).length,
                    overdue: rows.reduce((s, r) => s + (r.tasks.overdue || 0), 0), actions: rows.reduce((s, r) => s + (r.actions || 0), 0),
                    mistakes: rows.reduce((s, r) => s + ((r.mistakes || []).length), 0), mistakePeople: rows.filter(r => (r.mistakes || []).length).length };
                const sc = rows.filter(r => r.score != null && r.present);
                t.avgScore = sc.length ? Math.round(sc.reduce((s, r) => s + r.score, 0) / sc.length) : null;
                return { date: day, today: isToday, now: nowPK().slice(11, 16), hr, snapshot: snap, settings: S(), totals: t, rows };
            };
            return opts.live || !isToday ? build() : cached('day:' + day + ':' + tkStamp(), 20000, build);
        }
        /* ---------- person detail ---------- */
        function personDay(key, day) {
            day = isDay(day) ? day : todayPK();
            const { rows } = liveDay(day, { items: true });
            let row = rows.find(r => r.key === key);
            if (!row)
                return null;
            const uid = row.user_id;
            const tasks = uid ? q.all(`SELECT t.id,t.title,t.status,t.priority,t.due_date,t.due_time,t.done_at FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=?
      AND (t.due_date=? OR substr(COALESCE(t.done_at,''),1,10)=? OR (t.done_at IS NULL AND t.due_date<?)) ORDER BY t.due_date, t.due_time`, uid, day, day, day) : [];
            const trend = personTrend(row, addDays(day, -29), day);
            return { date: day, row, tasks, trend, settings: S() };
        }
        function personTrend(p, from, to) {
            const per = rangeRows(from, to, [p.key]);
            return per.get(p.key) || [];
        }
        /* ---------- rows for a range of days (snapshots where saved, otherwise rebuilt from source data) ---------- */
        function rangeRows(from, to, onlyKeys) {
            const today = todayPK(), out = new Map();
            const snaps = new Map(q.all('SELECT day, pkey, data FROM ops_daily WHERE day>=? AND day<=?', from, to).map(s => [s.day + '|' + s.pkey, s]));
            const recs = collect(from, to);
            const ppl = people(to).filter(p => !onlyKeys || onlyKeys.includes(p.key));
            const tg = allTargets(), mm = mistakeMap(from, to), st0 = S();
            for (let d = from; d <= to; d = addDays(d, 1)) {
                if (d > today)
                    break;
                let hr = null, c = null;
                for (const p of ppl) {
                    let row;
                    const s = d !== today && snaps.get(d + '|' + p.key);
                    if (s)
                        row = J(s.data, null);
                    if (!row) {
                        const r = p.user_id ? recs.get(p.user_id + '|' + d) : null;
                        if (p.since && d < p.since && !r)
                            continue; // not employed yet
                        if (hr === null) {
                            const h = hrDay(d);
                            hr = { list: h || [], by: new Map((h || []).filter(x => x.user_id != null).map(x => [+x.user_id, x])), byEmp: new Map((h || []).filter(x => x.emp_id != null).map(x => [String(x.emp_id), x])) };
                        }
                        if (!c)
                            c = dayCtx(d);
                        const hrow = p.user_id ? (hr.by.get(p.user_id) || (p.emp_id != null ? hr.byEmp.get(String(p.emp_id)) : null)) : hr.byEmp.get(String(p.emp_id));
                        row = buildRow(p, d, r, hrow || null, tg, c);
                    }
                    applyMistakes(row, p.user_id ? mm.get(p.user_id + '|' + d) : null, st0);
                    if (!out.has(p.key))
                        out.set(p.key, []);
                    out.get(p.key).push({ day: d, score: row.score, mistakes: (row.mistakes || []).length, present: row.present, workday: row.workday, actions: row.actions, counts: row.counts, targets: row.targets,
                        flags: (row.flags || []).map(f => f.k), att: row.att && row.att.status, source: row.att && row.att.source, tracked: row.tracked });
                }
            }
            return out;
        }
        /* ---------- performance ---------- */
        function performance(days) {
            days = [7, 30, 90].includes(+days) ? +days : 30;
            return cached('perf:' + days + ':' + todayPK() + ':' + tkStamp(), 5 * 60e3, () => {
                const st = S(), to = addDays(todayPK(), -1), from = addDays(to, -(days - 1)), from30 = addDays(to, -29);
                const today = todayPK(), mFrom = addDays(today, -(days - 1)), m30From = addDays(today, -29);
                const mAll = mistakeRows(days >= 30 ? mFrom : m30From, today), todayRecs = collect(today, today);
                const span = rangeRows(days >= 30 ? from : from30, to);
                const ppl = people(todayPK()), tg = allTargets();
                const nowS = nowPK();
                const out = [];
                for (const p of ppl) {
                    const all = span.get(p.key) || [];
                    const sum = list => {
                        const work = list.filter(x => x.workday);
                        const pres = work.filter(x => x.present), scored = pres.filter(x => x.score != null);
                        const low = scored.filter(x => x.score < st.lowPct);
                        const absent = work.filter(x => x.att === 'absent' && !x.present).length;
                        const noAct = work.filter(x => x.source !== 'hr' && !x.present).length;
                        const late = list.filter(x => x.flags.includes('late')).length, lateHr = list.filter(x => x.flags.includes('late') && x.source === 'hr').length;
                        const tgts = targetsFor(p, tg);
                        const output = tgts.map(t => ({ metric: t.metric, label: metricLabel(t.metric), target: t.target, avg: pres.length ? Math.round(10 * pres.reduce((s, x) => s + metricValue(x.counts || {}, t.metric), 0) / pres.length) / 10 : null }));
                        return { workDays: work.length, present: pres.length, absent, noActivityDays: noAct, late, lateHr, scoredDays: scored.length, lowDays: low.length,
                            avgScore: scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : null,
                            avgActions: pres.length ? Math.round(pres.reduce((s, x) => s + (x.actions || 0), 0) / pres.length) : 0, output };
                    };
                    const inP = all.filter(x => x.day >= from), last30 = all.filter(x => x.day >= from30);
                    const s = sum(inP), s30 = sum(last30);
                    let tasksDue = 0, onTime = 0;
                    if (p.user_id) {
                        const r = q.get(`SELECT COUNT(*) n, SUM(CASE WHEN t.done_at IS NOT NULL AND t.done_at <= (t.due_date || ' ' || COALESCE(t.due_time,'23:59') || ':59') THEN 1 ELSE 0 END) ok
            FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.due_date>=? AND t.due_date<=? AND (t.due_date || ' ' || COALESCE(t.due_time,'23:59')) < ?`, p.user_id, from, to, nowS);
                        tasksDue = r.n || 0;
                        onTime = r.ok || 0;
                    }
                    const warnings = hrWarnings(p, from, to);
                    const tracked = targetsFor(p, tg).length > 0;
                    // mistakes (window includes today, so a ticket closed today shows straight away)
                    const myM = p.user_id ? mAll.filter(m => m.uid === p.user_id) : [];
                    const mInP = myM.filter(m => m.day >= mFrom), m30 = myM.filter(m => m.day >= m30From);
                    const byDept = {};
                    for (const m of mInP)
                        byDept[m.dept] = (byDept[m.dept] || 0) + 1;
                    const mainDept = Object.entries(byDept).sort((a, b) => b[1] - a[1])[0];
                    let rate = null, rateBase = null, outputN = null;
                    if (mainDept) {
                        const [metric, lbl] = RATE_BASE[mainDept[0]] || ['actions', 'ERP actions'];
                        const tr = p.user_id ? todayRecs.get(p.user_id + '|' + today) : null;
                        outputN = inP.reduce((s0, x) => s0 + ((x.counts || {})[metric] || 0), 0) + ((tr && tr.counts[metric]) || 0);
                        rateBase = lbl;
                        rate = outputN ? Math.round(1000 * mInP.length / outputN) / 10 : null;
                    }
                    const mistakes = { n: mInP.length, n30: m30.length, cost: mInP.reduce((s0, m) => s0 + (+m.cost || 0), 0), rate, rateBase, output: outputN,
                        byDept: Object.entries(byDept).map(([k, n]) => ({ k, l: DEPTS[k] || k, n })), list: mInP.slice(-50).reverse().map(m => ({ id: m.id, day: m.day, type: m.type, order_name: m.order_name, dept: m.dept, deptLabel: m.deptLabel, reason: m.reason, cost: m.cost })) };
                    const reasons = [];
                    if (tracked && s30.scoredDays >= 5 && s30.lowDays / s30.scoredDays >= st.lowShare / 100)
                        reasons.push(`Below ${st.lowPct}% of target on ${s30.lowDays} of ${s30.scoredDays} working days (average score ${s30.avgScore}%)`);
                    if (s30.absent >= st.absentLimit)
                        reasons.push(`Absent ${s30.absent} days in the last 30 days`);
                    if (tracked && s30.noActivityDays >= st.absentLimit)
                        reasons.push(`No ERP activity on ${s30.noActivityDays} working days (no attendance record to say if absent)`);
                    if (s30.late >= st.lateLimit)
                        reasons.push(s30.lateHr === s30.late ? `Late ${s30.late} times in the last 30 days (HR check-in)` : s30.lateHr ? `Late ${s30.late} times in the last 30 days (${s30.lateHr} by HR check-in, ${s30.late - s30.lateHr} by first ERP activity)` : `Started late ${s30.late} times in the last 30 days (first seen in the ERP after shift start + grace; no HR check-in)`);
                    const w30 = hrWarnings(p, from30, to);
                    if (w30 >= 2)
                        reasons.push(`${w30} HR warnings in the last 30 days`);
                    if (+st.mistakeLimit > 0 && m30.length >= +st.mistakeLimit) {
                        const g = {};
                        for (const m of m30) {
                            const k = (m.reason || m.deptLabel + ' mistake').toLowerCase();
                            g[k] = (g[k] || 0) + 1;
                        }
                        const parts = Object.entries(g).sort((a, b) => b[1] - a[1]);
                        reasons.push(parts.length === 1 ? `${m30.length} customer problems traced to ${parts[0][0]} in the last 30 days` : `${m30.length} customer problems traced to their work in the last 30 days: ${parts.map(([k, n]) => `${n} × ${k}`).join(', ')}`);
                    }
                    // abandoned carts recovered after this person contacted them (abandoned module), same window as mistakes (includes today)
                    let recovered = null;
                    try {
                        if (p.user_id && ctx.services.abandoned) {
                            const rc = ctx.services.abandoned.recoveredBy(p.user_id, mFrom, today);
                            if (rc.n || p.role === 'social')
                                recovered = rc;
                        }
                    }
                    catch (e) { }
                    out.push(Object.assign(Object.assign({ key: p.key, user_id: p.user_id, name: p.name, role: p.role, roleLabel: p.roleLabel, tracked }, s), { recovered, tasksDue, tasksOnTime: onTime, onTimePct: tasksDue ? Math.round(100 * onTime / tasksDue) : null, warnings, mistakes, trend: inP.map(x => ({ day: x.day, score: x.workday && x.present ? x.score : null, present: x.present, workday: x.workday })), needsReview: reasons, enoughData: s30.scoredDays >= 5 }));
                }
                out.sort((a, b) => (b.avgScore != null) - (a.avgScore != null) || (b.avgScore || 0) - (a.avgScore || 0) || a.name.localeCompare(b.name));
                let rank = 0;
                for (const r of out)
                    r.rank = r.avgScore != null ? ++rank : null;
                // team score per day
                const teamDays = [];
                for (let d = from; d <= to; d = addDays(d, 1)) {
                    const sc = out.map(r => (r.trend.find(x => x.day === d) || {}).score).filter(v => v != null);
                    teamDays.push({ day: d, score: sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null, people: sc.length });
                }
                const deptMonth = mistakesByDept(today.slice(0, 7));
                return { days, from, to, mFrom, hr: !!hrSvc() && typeof hrSvc().attendance === 'function', settings: st, people: out, deptMonth, tickets: hasTk(), team: teamDays, needsReview: out.filter(r => r.needsReview.length).map(r => ({ key: r.key, name: r.name, roleLabel: r.roleLabel, reasons: r.needsReview })) };
            });
        }
        /* ---------- mistakes by department for a month (all departments, incl. courier / customer) ---------- */
        function mistakesByDept(month) {
            if (!hasTk() || !/^\d{4}-\d{2}$/.test(month || ''))
                return { month, depts: [], people: [], total: 0 };
            const W = "t.status IN ('resolved','closed') AND t.fault_dept IS NOT NULL AND substr(datetime(t.resolved_at,'+5 hours'),1,7)=?";
            const depts = q.all(`SELECT t.fault_dept k, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost FROM tk_tickets t WHERE ${W} GROUP BY t.fault_dept ORDER BY n DESC`, month)
                .map(r => (Object.assign(Object.assign({}, r), { l: DEPTS[r.k] || r.k, internal: INTERNAL.includes(r.k), top: (q.get(`SELECT fault_reason k, COUNT(*) n FROM tk_tickets t WHERE ${W} AND t.fault_dept=? AND fault_reason IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 1`, month, r.k) || {}).k || null })));
            const people = q.all(`SELECT t.fault_user_id id, us.name, us.role, t.fault_dept dept, COUNT(*) n FROM tk_tickets t LEFT JOIN users us ON us.id=t.fault_user_id WHERE ${W} AND t.fault_user_id IS NOT NULL GROUP BY 1, 4 ORDER BY n DESC LIMIT 20`, month)
                .map(r => (Object.assign(Object.assign({}, r), { key: 'u:' + r.id, deptLabel: DEPTS[r.dept] || r.dept })));
            return { month, depts, people, total: depts.reduce((s, r) => s + r.n, 0), internal: depts.filter(r => r.internal).reduce((s, r) => s + r.n, 0) };
        }
        /* ---------- snapshot ---------- */
        function snapshot(day, userId) {
            const { rows } = liveDay(day);
            const at = nowPK();
            q.tx(() => {
                q.run('DELETE FROM ops_daily WHERE day=?', day);
                for (const r of rows)
                    q.run('INSERT INTO ops_daily(day,pkey,user_id,name,role,score,data,built_at) VALUES(?,?,?,?,?,?,?,?)', day, r.key, r.user_id, r.name, r.role, r.score, JSON.stringify(r), at);
            });
            if (userId)
                ctx.log(userId, 'ops.snapshot', 'ops:' + day, { people: rows.length });
            bust();
            return { ok: true, day, people: rows.length, built_at: at };
        }
        /* ---------- tasks ---------- */
        const dueKey = t => t.due_date ? t.due_date + ' ' + (t.due_time || '23:59') : null;
        function taskOut(t, u) {
            const users = q.all('SELECT a.user_id id, us.name, a.seen_at FROM ops_task_users a LEFT JOIN users us ON us.id=a.user_id WHERE a.task_id=?', t.id);
            const now = nowPK(), dk = dueKey(t), me = users.find(x => x.id === u.id);
            return Object.assign(Object.assign({}, t), { files: J(t.files, []), checklist: J(t.checklist, []), assignees: users.map(x => ({ id: x.id, name: x.name })), creator: (q.get('SELECT name FROM users WHERE id=?', t.created_by) || {}).name, overdue: t.status !== 'done' && dk && dk < now.slice(0, 16), unread: !!(me && t.last_by !== u.id && (!me.seen_at || me.seen_at < t.updated_at)) });
        }
        const canSeeTask = (t, u) => ctx.can(u, 'team') || t.created_by === u.id || !!q.get('SELECT 1 FROM ops_task_users WHERE task_id=? AND user_id=?', t.id, u.id);
        const canEditTask = (t, u) => ctx.can(u, 'team') || t.created_by === u.id;
        function cleanTask(b, u, old) {
            const v = {};
            if (!old || b.title !== undefined) {
                v.title = String(b.title || '').trim().slice(0, 200);
                ctx.need(v.title, 'Write a title');
            }
            if (b.description !== undefined)
                v.description = String(b.description || '').slice(0, 4000);
            if (b.priority !== undefined)
                v.priority = PRIOS.includes(b.priority) ? b.priority : 'normal';
            if (b.due_date !== undefined) {
                v.due_date = b.due_date ? String(b.due_date).slice(0, 10) : null;
                ctx.need(!v.due_date || isDay(v.due_date), 'Due date must be YYYY-MM-DD');
            }
            if (b.due_time !== undefined) {
                v.due_time = b.due_time ? min2hm(hm2min(b.due_time)) : null;
            }
            if (b.link_type !== undefined)
                v.link_type = ['order', 'sku', 'ticket'].includes(b.link_type) ? b.link_type : null;
            if (b.link_ref !== undefined)
                v.link_ref = b.link_ref ? String(b.link_ref).trim().slice(0, 60) : null;
            if (b.files !== undefined)
                v.files = JSON.stringify((Array.isArray(b.files) ? b.files : []).filter(x => /^[a-f0-9]{8,40}$/.test(String(x))).slice(0, 10));
            if (b.checklist !== undefined)
                v.checklist = JSON.stringify((Array.isArray(b.checklist) ? b.checklist : []).map(c => typeof c === 'string' ? { t: c, done: false } : { t: String(c.t || c.text || ''), done: !!c.done }).filter(c => c.t.trim()).slice(0, 50).map(c => ({ t: c.t.trim().slice(0, 200), done: c.done })));
            return v;
        }
        function assigneesFor(b, u) {
            let ids = Array.isArray(b.assignees) ? b.assignees.map(Number).filter(Boolean) : [];
            if (!ids.length)
                ids = [u.id];
            ids = [...new Set(ids)];
            if (!ctx.can(u, 'team'))
                ctx.need(ids.length === 1 && ids[0] === u.id, 'You can only create tasks for yourself. Ask a manager to assign tasks to others.', 403);
            for (const id of ids)
                ctx.need(q.get('SELECT 1 FROM users WHERE id=? AND active=1', id), 'Unknown person');
            return ids;
        }
        function comment(taskId, uid, kind, text) { q.run('INSERT INTO ops_comments(task_id,user_id,kind,text,at) VALUES(?,?,?,?,?)', taskId, uid, kind, text, nowPK()); }
        function createTask(b, u, extra = {}) {
            const v = cleanTask(b, u), ids = extra.assignees || assigneesFor(b, u), now = nowPK();
            const r = q.run(`INSERT ${extra.template_id ? 'OR IGNORE ' : ''}INTO ops_tasks(title,description,priority,status,due_date,due_time,link_type,link_ref,files,checklist,created_by,created_at,updated_at,last_by,template_id,gen_date)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, v.title, v.description || null, v.priority || 'normal', 'todo', v.due_date || null, v.due_time || null, v.link_type || null, v.link_ref || null, v.files || '[]', v.checklist || '[]', u ? u.id : null, now, now, u ? u.id : null, extra.template_id || null, extra.gen_date || null);
            if (!r.changes)
                return null;
            const id = Number(r.lastInsertRowid);
            for (const a of ids)
                q.run('INSERT OR IGNORE INTO ops_task_users(task_id,user_id) VALUES(?,?)', id, a);
            comment(id, u ? u.id : null, 'system', extra.template_id ? 'Created from a recurring task' : 'Created the task');
            if (u)
                ctx.log(u.id, 'ops.task.create', 'task:' + id, v.title);
            bust();
            return id;
        }
        /* ---------- recurring templates ---------- */
        function templateDue(t, day) {
            if (!t.active)
                return false;
            if (t.freq === 'daily')
                return (S().workdays || []).includes(weekday(day));
            if (t.freq === 'weekdays')
                return (J(t.weekdays, []) || []).map(Number).includes(weekday(day));
            if (t.freq === 'monthly') {
                const d = +day.slice(8, 10), last = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
                return d === Math.min(+t.month_day || 1, last);
            }
            return false;
        }
        function generate(day) {
            day = day || todayPK();
            let made = 0;
            for (const t of q.all('SELECT * FROM ops_templates WHERE active=1')) {
                if (!templateDue(t, day))
                    continue;
                if (q.get('SELECT 1 FROM ops_tasks WHERE template_id=? AND gen_date=?', t.id, day))
                    continue;
                const ids = t.scope === 'user' ? q.all('SELECT id FROM users WHERE id=? AND active=1', +t.ref).map(x => x.id) : q.all('SELECT id FROM users WHERE role=? AND active=1', t.ref).map(x => x.id);
                if (!ids.length)
                    continue;
                const id = createTask({ title: t.title, description: t.description, priority: t.priority, due_date: day, due_time: t.due_time, checklist: J(t.checklist, []) }, null, { template_id: t.id, gen_date: day, assignees: ids });
                if (id) {
                    q.run('UPDATE ops_tasks SET created_by=? WHERE id=?', t.created_by, id);
                    made++;
                }
            }
            setSetting('ops_gen_day', day);
            return made;
        }
        const ensureGenerated = () => { const d = todayPK(); if (setting('ops_gen_day') !== d)
            generate(d); };
        /* ---------- my tasks ---------- */
        function myTasks(userId, opts = {}) {
            const u = q.get('SELECT id FROM users WHERE id=?', userId);
            if (!u)
                return null;
            ensureGenerated();
            const rows = q.all(`SELECT DISTINCT t.* FROM ops_tasks t LEFT JOIN ops_task_users a ON a.task_id=t.id
      WHERE (a.user_id=? OR (t.created_by=? AND NOT EXISTS(SELECT 1 FROM ops_task_users x WHERE x.task_id=t.id)))
      AND (t.status<>'done' OR t.done_at >= ?) ORDER BY COALESCE(t.due_date,'9999'), COALESCE(t.due_time,'23:59'), t.id`, userId, userId, addDays(todayPK(), -7));
            const me = { id: userId }, today = todayPK();
            const list = rows.map(t => taskOut(t, me));
            const g = { overdue: [], today: [], upcoming: [], nodate: [], done: [] };
            for (const t of list) {
                if (t.status === 'done')
                    g.done.push(t);
                else if (t.overdue)
                    g.overdue.push(t);
                else if (t.due_date === today)
                    g.today.push(t);
                else if (t.due_date)
                    g.upcoming.push(t);
                else
                    g.nodate.push(t);
            }
            g.done.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
            return Object.assign(Object.assign({}, g), { counts: { overdue: g.overdue.length, today: g.today.length, upcoming: g.upcoming.length, open: g.overdue.length + g.today.length + g.upcoming.length + g.nodate.length } });
        }
        /* ---------- my output today ---------- */
        function myOutput(userId) {
            const u = q.get('SELECT id,name,role FROM users WHERE id=?', userId);
            if (!u)
                return null;
            const day = todayPK(), r = collect(day, day).get(userId + '|' + day);
            const p = { key: 'u:' + u.id, user_id: u.id, role: u.role };
            const sc = scoreOf((r && r.counts) || {}, targetsFor(p));
            return { day, score: sc.score, parts: sc.parts, actions: (r && r.counts.actions) || 0, first: r && r.times[0] ? r.times[0].slice(0, 5) : null, last: r && r.times.length ? r.times[r.times.length - 1].slice(0, 5) : null,
                labels: Object.entries((r && r.labels) || {}).map(([l, n]) => ({ l, n })).sort((a, b) => b.n - a.n) };
        }
        function summary() {
            const d = dayReport(todayPK());
            const open = q.get(`SELECT COUNT(*) n, SUM(CASE WHEN due_date IS NOT NULL AND (due_date || ' ' || COALESCE(due_time,'23:59')) < ? THEN 1 ELSE 0 END) od FROM ops_tasks WHERE status<>'done'`, nowPK().slice(0, 16));
            let needsReview = null;
            try {
                needsReview = performance(30).needsReview.length;
            }
            catch (e) { }
            return { checkedIn: d.totals.present, staff: d.totals.staff, idle: d.totals.idle, noActivity: d.totals.noActivity, low: d.totals.low, avgScore: d.totals.avgScore,
                tasksOpen: open.n || 0, overdue: open.od || 0, needsReview, eodMissing: Math.max(0, d.totals.eodDue - d.totals.eod) };
        }
        /* ---------- jobs ---------- */
        function tick(now) {
            now = now || nowPK();
            const day = now.slice(0, 10), hm = now.slice(11, 16), st = S(), out = {};
            if (setting('ops_gen_day') !== day && hm >= '00:05')
                out.generated = generate(day);
            if (hm >= st.snapshotAt && setting('ops_snap_day') !== day) {
                out.snapshot = snapshot(day).people;
                setSetting('ops_snap_day', day);
            }
            const y = addDays(day, -1);
            if (setting('ops_snap_check') !== day) { // server was off at snapshot time yesterday? keep the history anyway
                if (!q.get('SELECT 1 FROM ops_daily WHERE day=? LIMIT 1', y) && q.get('SELECT 1 FROM users WHERE role<>? LIMIT 1', 'admin'))
                    out.backfill = snapshot(y).people;
                setSetting('ops_snap_check', day);
            }
            return out;
        }
        return { mistakesByDept, mistakeRows, S, people, targetsFor, allTargets, scoreOf, metricLabel, collect, dayReport, personDay, performance, snapshot, taskOut, canSeeTask, canEditTask, cleanTask, assigneesFor,
            comment, createTask, generate, ensureGenerated, myTasks, myOutput, summary, tick, bust, hrDay, labels, roleLabel, todayPK, nowPK, templateDue };
    }
    let OPS = null;
    module.exports = {
        name: 'ops',
        perms: [],
        schema,
        activity: {
            'ops.task.create': 'Created task', 'ops.task.done': 'Completed task', 'ops.task.status': 'Updated task status', 'ops.task.edit': 'Edited task', 'ops.task.comment': 'Commented on task',
            'ops.task.delete': 'Deleted task', 'ops.eod': 'Wrote end-of-day report', 'ops.target': 'Changed targets', 'ops.template': 'Saved recurring task', 'ops.snapshot': 'Rebuilt daily report', 'ops.settings': 'Changed team report settings',
        },
        migrate(ctx) {
            if (!ctx.setting('ops_seeded')) {
                for (const [role, metric, target] of DEFAULT_TARGETS)
                    ctx.q.run('INSERT OR IGNORE INTO ops_targets(scope,ref,metric,target,weight) VALUES(?,?,?,?,1)', 'role', role, metric, target);
                ctx.setSetting('ops_seeded', true);
            }
            if (!ctx.setting('ops_seeded_2')) {
                for (const [role, metric, target] of DEFAULT_TARGETS_2)
                    ctx.q.run('INSERT OR IGNORE INTO ops_targets(scope,ref,metric,target,weight) VALUES(?,?,?,?,1)', 'role', role, metric, target);
                ctx.setSetting('ops_seeded_2', true);
            }
        },
        routes(ctx) {
            const { route, q, need, can, log } = ctx;
            const O = OPS = make(ctx);
            ctx.services.ops = { summary: () => O.summary(), myTasks: uid => O.myTasks(uid), dayReport: (d, o) => O.dayReport(d, o), myOutput: uid => O.myOutput(uid) };
            /* --- daily report --- */
            route('GET', '/api/ops/day', 'team', (req, u, b, res, p, qs) => O.dayReport(qs.date, { live: qs.live === '1' }));
            route('GET', '/api/ops/person/:key', 'tasks', (req, u, b, res, p, qs) => {
                const key = decodeURIComponent(p.key);
                need(can(u, 'team') || key === 'u:' + u.id, 'Only managers can see other people\'s day', 403);
                const d = O.personDay(key, qs.date);
                need(d, 'Person not found', 404);
                return d;
            });
            route('POST', '/api/ops/snapshot', 'team', (req, u, b) => { const d = isDay(b.date) ? b.date : O.todayPK(); need(d <= O.todayPK(), 'Cannot build a future day'); return O.snapshot(d, u.id); });
            /* --- targets & settings --- */
            route('GET', '/api/ops/targets', 'team', () => {
                const L = O.labels();
                const actions = q.all("SELECT action, COUNT(*) n FROM events WHERE at>=datetime('now','-60 days') AND user_id IS NOT NULL GROUP BY action ORDER BY n DESC LIMIT 80").map(r => r.action)
                    .filter(a => a && !a.startsWith('cs:') && a !== 'login');
                const acts = [...new Set([...Object.keys(L).filter(a => a !== 'login'), ...actions])].map(a => ({ k: 'action:' + a, l: L[a] || pretty(a) }));
                const users = q.all('SELECT id,name,role,active FROM users WHERE active=1 ORDER BY name').map(x => (Object.assign(Object.assign({}, x), { key: 'u:' + x.id, roleLabel: O.roleLabel(x.role) })));
                const ppl = O.people(O.todayPK()).map(x => x.key);
                const S0 = O.S();
                return { metrics: Object.entries(METRICS).map(([k, l]) => ({ k, l })), actions: acts, roles: Object.entries(ctx.A.ROLES).filter(([k]) => k !== 'admin').map(([k, v]) => ({ k, l: v.label })),
                    targets: O.allTargets().map(t => (Object.assign(Object.assign({}, t), { label: O.metricLabel(t.metric) }))), users: users.map(x => (Object.assign(Object.assign({}, x), { onReport: ppl.includes(x.key), targets: O.targetsFor(x).map(t => (Object.assign(Object.assign({}, t), { label: O.metricLabel(t.metric) }))) }))),
                    hrOnly: O.people(O.todayPK()).filter(x => x.noLogin), settings: S0 };
            });
            route('POST', '/api/ops/targets', 'team', (req, u, b) => {
                need(['role', 'person'].includes(b.scope), 'Choose role or person');
                need(b.ref, 'Choose who this target is for');
                const metric = String(b.metric || '');
                need(METRICS[metric] || /^action:[\w.:*-]+$/.test(metric), 'Choose what to count');
                need(b.target !== undefined && +b.target >= 0 && +b.target < 100000, 'Target must be a number');
                const ref = String(b.ref);
                if (b.scope === 'role')
                    need(ctx.A.ROLES[ref], 'Unknown role');
                else
                    need(/^(u|e):\w+$/.test(ref), 'Unknown person');
                if (b.scope === 'role' && !(+b.target > 0))
                    q.run('DELETE FROM ops_targets WHERE scope=? AND ref=? AND metric=?', 'role', ref, metric);
                else
                    q.run(`INSERT INTO ops_targets(scope,ref,metric,target,weight,updated_by,updated_at) VALUES(?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(scope,ref,metric) DO UPDATE SET target=excluded.target, weight=excluded.weight, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, b.scope, ref, metric, +b.target, +b.weight > 0 ? +b.weight : 1, u.id);
                log(u.id, 'ops.target', 'target:' + b.scope + ':' + ref, { metric, target: +b.target, weight: +b.weight || 1 });
                O.bust();
                return { ok: true };
            });
            route('DELETE', '/api/ops/targets/:id', 'team', (req, u, b, res, p) => { const t = q.get('SELECT * FROM ops_targets WHERE id=?', +p.id); need(t, 'Not found', 404); q.run('DELETE FROM ops_targets WHERE id=?', t.id); log(u.id, 'ops.target', 'target:' + t.scope + ':' + t.ref, { metric: t.metric, removed: true }); O.bust(); return { ok: true }; });
            route('POST', '/api/ops/settings', 'team', (req, u, b) => {
                const cur = O.S(), v = Object.assign({}, cur);
                for (const k of ['shiftStart', 'shiftEnd', 'breakStart', 'breakEnd', 'noActBy', 'eodRemind', 'snapshotAt'])
                    if (b[k] !== undefined) {
                        const m = hm2min(b[k]);
                        need(m != null && m < 24 * 60, k + ' must be a time like 10:00');
                        v[k] = min2hm(m);
                    }
                for (const k of ['idleMin', 'lateGrace', 'lowPct', 'lowShare', 'absentLimit', 'lateLimit', 'mistakePenalty', 'mistakeLimit'])
                    if (b[k] !== undefined) {
                        need(+b[k] >= 0 && +b[k] <= 1000, k + ' must be a number');
                        v[k] = +b[k];
                    }
                if (b.workdays !== undefined)
                    v.workdays = (Array.isArray(b.workdays) ? b.workdays : []).map(Number).filter(d => d >= 0 && d <= 6);
                if (b.hidden !== undefined)
                    v.hidden = (Array.isArray(b.hidden) ? b.hidden : []).map(String).filter(x => /^(u|e):\w+$/.test(x));
                if (b.showAdmins !== undefined)
                    v.showAdmins = !!b.showAdmins;
                need(hm2min(v.shiftEnd) > hm2min(v.shiftStart), 'Shift must end after it starts');
                ctx.setSetting('ops_settings', v);
                log(u.id, 'ops.settings', 'settings', b);
                O.bust();
                return v;
            });
            /* --- performance --- */
            route('GET', '/api/ops/performance', 'team', (req, u, b, res, p, qs) => O.performance(qs.days));
            route('GET', '/api/ops/mistakes', 'team', (req, u, b, res, p, qs) => O.mistakesByDept(/^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : O.todayPK().slice(0, 7)));
            /* --- tasks --- */
            route('GET', '/api/ops/people', 'tasks', (req, u) => ({
                users: can(u, 'team') ? q.all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name').map(x => (Object.assign(Object.assign({}, x), { roleLabel: O.roleLabel(x.role) }))) : [{ id: u.id, name: u.name, role: u.role, roleLabel: O.roleLabel(u.role) }],
                roles: Object.entries(ctx.A.ROLES).map(([k, v]) => ({ k, l: v.label })), team: can(u, 'team'),
            }));
            route('GET', '/api/ops/tasks', 'tasks', (req, u, b, res, p, qs) => {
                if (qs.view !== 'board')
                    return O.myTasks(u.id);
                need(can(u, 'team'), 'Only managers can see the team board', 403);
                O.ensureGenerated();
                const w = ["(t.status<>'done' OR t.done_at >= ?)"], a = [addDays(O.todayPK(), -(+qs.doneDays || 7))];
                if (qs.user) {
                    w.push('t.id IN (SELECT task_id FROM ops_task_users WHERE user_id=?)');
                    a.push(+qs.user);
                }
                if (qs.q) {
                    w.push('(t.title LIKE ? OR t.link_ref LIKE ?)');
                    a.push('%' + qs.q + '%', '%' + qs.q + '%');
                }
                const rows = q.all(`SELECT t.* FROM ops_tasks t WHERE ${w.join(' AND ')} ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, COALESCE(t.due_date,'9999'), t.id LIMIT 500`, ...a).map(t => O.taskOut(t, u));
                return { rows };
            });
            route('GET', '/api/ops/tasks/:id', 'tasks', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM ops_tasks WHERE id=?', +p.id);
                need(t, 'Task not found', 404);
                need(O.canSeeTask(t, u), 'This task is not yours', 403);
                const out = O.taskOut(t, u);
                q.run('UPDATE ops_task_users SET seen_at=? WHERE task_id=? AND user_id=?', O.nowPK(), t.id, u.id);
                out.comments = q.all('SELECT c.*, us.name user FROM ops_comments c LEFT JOIN users us ON us.id=c.user_id WHERE task_id=? ORDER BY c.id', t.id);
                out.canEdit = O.canEditTask(t, u);
                out.template = t.template_id ? q.get('SELECT id,title,freq FROM ops_templates WHERE id=?', t.template_id) : null;
                return out;
            });
            route('POST', '/api/ops/tasks', 'tasks', (req, u, b) => { const id = O.createTask(b, u); return O.taskOut(q.get('SELECT * FROM ops_tasks WHERE id=?', id), u); });
            route('POST', '/api/ops/tasks/:id', 'tasks', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM ops_tasks WHERE id=?', +p.id);
                need(t, 'Task not found', 404);
                need(O.canSeeTask(t, u), 'This task is not yours', 403);
                const now = O.nowPK(), sets = {};
                const editing = ['title', 'description', 'priority', 'due_date', 'due_time', 'link_type', 'link_ref', 'files', 'assignees'].some(k => b[k] !== undefined);
                if (editing) {
                    need(O.canEditTask(t, u), 'Only the person who made this task or a manager can change it', 403);
                    Object.assign(sets, O.cleanTask(b, u, t));
                    if (b.assignees !== undefined) {
                        const ids = O.assigneesFor(b, u);
                        q.run(`DELETE FROM ops_task_users WHERE task_id=? AND user_id NOT IN (${ids.map(() => '?').join(',')})`, t.id, ...ids);
                        for (const a of ids)
                            q.run('INSERT OR IGNORE INTO ops_task_users(task_id,user_id) VALUES(?,?)', t.id, a);
                    }
                    O.comment(t.id, u.id, 'system', 'Edited the task');
                    log(u.id, 'ops.task.edit', 'task:' + t.id, t.title);
                }
                if (b.checklist !== undefined) {
                    const cl = O.cleanTask({ checklist: b.checklist }, u, t).checklist;
                    const before = JSON.parse(t.checklist || '[]');
                    if (!O.canEditTask(t, u))
                        need(JSON.stringify(JSON.parse(cl).map(c => c.t)) === JSON.stringify(before.map(c => c.t)), 'You can tick items but only the creator or a manager can change the list', 403);
                    sets.checklist = cl;
                }
                if (b.status !== undefined && b.status !== t.status) {
                    need(STATUSES.includes(b.status), 'Unknown status');
                    if (b.status === 'blocked')
                        need(String(b.note || '').trim(), 'Say what is blocking this task');
                    sets.status = b.status;
                    if (b.status === 'done') {
                        sets.done_at = now;
                        sets.done_by = u.id;
                    }
                    else if (t.status === 'done') {
                        sets.done_at = null;
                        sets.done_by = null;
                    }
                    O.comment(t.id, u.id, 'status', `${({ todo: 'To do', doing: 'Doing', blocked: 'Blocked', done: 'Done' })[b.status]}${b.note ? ': ' + String(b.note).slice(0, 500) : ''}`);
                    log(u.id, b.status === 'done' ? 'ops.task.done' : 'ops.task.status', 'task:' + t.id, b.status === 'done' ? t.title : b.status);
                }
                if (!Object.keys(sets).length && !editing)
                    return O.taskOut(t, u);
                sets.updated_at = now;
                sets.last_by = u.id;
                q.run(`UPDATE ops_tasks SET ${Object.keys(sets).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(sets), t.id);
                O.bust();
                return O.taskOut(q.get('SELECT * FROM ops_tasks WHERE id=?', t.id), u);
            });
            route('POST', '/api/ops/tasks/:id/comment', 'tasks', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM ops_tasks WHERE id=?', +p.id);
                need(t, 'Task not found', 404);
                need(O.canSeeTask(t, u), 'This task is not yours', 403);
                const text = String(b.text || '').trim();
                need(text, 'Write a comment');
                O.comment(t.id, u.id, 'comment', text.slice(0, 2000));
                q.run('UPDATE ops_tasks SET updated_at=?, last_by=? WHERE id=?', O.nowPK(), u.id, t.id);
                log(u.id, 'ops.task.comment', 'task:' + t.id, text.slice(0, 80));
                return { ok: true };
            });
            route('DELETE', '/api/ops/tasks/:id', 'tasks', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM ops_tasks WHERE id=?', +p.id);
                need(t, 'Task not found', 404);
                need(O.canEditTask(t, u), 'Only the person who made this task or a manager can delete it', 403);
                q.tx(() => { q.run('DELETE FROM ops_task_users WHERE task_id=?', t.id); q.run('DELETE FROM ops_comments WHERE task_id=?', t.id); q.run('DELETE FROM ops_tasks WHERE id=?', t.id); });
                log(u.id, 'ops.task.delete', 'task:' + t.id, t.title);
                O.bust();
                return { ok: true };
            });
            /* --- recurring templates --- */
            const tplIn = b => {
                const v = { title: String(b.title || '').trim().slice(0, 200), description: String(b.description || '').slice(0, 2000), priority: PRIOS.includes(b.priority) ? b.priority : 'normal' };
                need(v.title, 'Write a title');
                need(['user', 'role'].includes(b.scope), 'Choose a person or a role');
                v.scope = b.scope;
                v.ref = String(b.ref || '');
                if (v.scope === 'user')
                    need(q.get('SELECT 1 FROM users WHERE id=?', +v.ref), 'Choose a person');
                else
                    need(ctx.A.ROLES[v.ref], 'Choose a role');
                need(['daily', 'weekdays', 'monthly'].includes(b.freq), 'Choose how often');
                v.freq = b.freq;
                v.weekdays = JSON.stringify((Array.isArray(b.weekdays) ? b.weekdays : []).map(Number).filter(d => d >= 0 && d <= 6));
                if (v.freq === 'weekdays')
                    need(JSON.parse(v.weekdays).length, 'Pick at least one weekday');
                v.month_day = v.freq === 'monthly' ? Math.max(1, Math.min(31, +b.month_day || 1)) : null;
                v.due_time = b.due_time ? min2hm(hm2min(b.due_time)) : null;
                v.checklist = JSON.stringify((Array.isArray(b.checklist) ? b.checklist : []).map(c => String(typeof c === 'string' ? c : c.t || '').trim()).filter(Boolean).slice(0, 50));
                v.active = b.active === false ? 0 : 1;
                return v;
            };
            route('GET', '/api/ops/templates', 'team', () => q.all('SELECT t.*, us.name created_name FROM ops_templates t LEFT JOIN users us ON us.id=t.created_by ORDER BY t.active DESC, t.title').map(t => (Object.assign(Object.assign({}, t), { weekdays: J(t.weekdays, []), checklist: J(t.checklist, []), forName: t.scope === 'user' ? (q.get('SELECT name FROM users WHERE id=?', +t.ref) || {}).name : O.roleLabel(t.ref) + ' (everyone)', lastMade: (q.get('SELECT MAX(gen_date) d FROM ops_tasks WHERE template_id=?', t.id) || {}).d }))));
            route('POST', '/api/ops/templates', 'team', (req, u, b) => {
                const v = tplIn(b);
                const r = q.run('INSERT INTO ops_templates(title,description,priority,scope,ref,freq,weekdays,month_day,due_time,checklist,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', v.title, v.description, v.priority, v.scope, v.ref, v.freq, v.weekdays, v.month_day, v.due_time, v.checklist, v.active, u.id, O.nowPK());
                log(u.id, 'ops.template', 'template:' + r.lastInsertRowid, v.title);
                let made = 0;
                if (b.startToday !== false) {
                    const id = Number(r.lastInsertRowid), t = q.get('SELECT * FROM ops_templates WHERE id=?', id);
                    if (O.templateDue(t, O.todayPK()))
                        made = O.generate(O.todayPK());
                }
                return { ok: true, id: Number(r.lastInsertRowid), made };
            });
            route('POST', '/api/ops/templates/:id', 'team', (req, u, b, res, p) => {
                const t = q.get('SELECT * FROM ops_templates WHERE id=?', +p.id);
                need(t, 'Not found', 404);
                const v = b.active !== undefined && Object.keys(b).length === 1 ? Object.assign(Object.assign({}, t), { active: b.active ? 1 : 0 }) : tplIn(Object.assign(Object.assign(Object.assign({}, t), { weekdays: J(t.weekdays, []), checklist: J(t.checklist, []) }), b));
                q.run('UPDATE ops_templates SET title=?,description=?,priority=?,scope=?,ref=?,freq=?,weekdays=?,month_day=?,due_time=?,checklist=?,active=? WHERE id=?', v.title, v.description, v.priority, v.scope, v.ref, v.freq, v.weekdays, v.month_day, v.due_time, v.checklist, v.active, t.id);
                log(u.id, 'ops.template', 'template:' + t.id, v.title);
                return { ok: true };
            });
            route('DELETE', '/api/ops/templates/:id', 'team', (req, u, b, res, p) => { const t = q.get('SELECT * FROM ops_templates WHERE id=?', +p.id); need(t, 'Not found', 404); q.run('DELETE FROM ops_templates WHERE id=?', t.id); log(u.id, 'ops.template', 'template:' + t.id, { deleted: t.title }); return { ok: true }; });
            route('POST', '/api/ops/templates-run', 'team', (req, u, b) => ({ made: O.generate(isDay(b.date) ? b.date : O.todayPK()) }));
            // run the background job now (owner tool + tests); 'now' lets you pretend it is a given Pakistan time
            route('POST', '/api/ops/run-jobs', 'settings', (req, u, b) => O.tick(b.now && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(b.now) ? String(b.now).slice(0, 19) : null));
            /* --- end-of-day notes --- */
            route('GET', '/api/ops/eod', 'tasks', (req, u, b, res, p, qs) => {
                const d = isDay(qs.date) ? qs.date : O.todayPK();
                return { date: d, note: q.get('SELECT * FROM ops_eod WHERE user_id=? AND day=?', u.id, d) || null, remindAt: O.S().eodRemind, onReport: O.people(O.todayPK()).some(p => p.user_id === u.id) };
            });
            route('POST', '/api/ops/eod', 'tasks', (req, u, b) => {
                const d = isDay(b.date) ? b.date : O.todayPK();
                need(d === O.todayPK() || d === addDays(O.todayPK(), -1), 'You can only write today\'s or yesterday\'s report');
                const did = String(b.did || '').trim();
                need(did.length >= 3, 'Write what you did today');
                q.run(`INSERT INTO ops_eod(user_id,day,did,problems,plan,at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET did=excluded.did, problems=excluded.problems, plan=excluded.plan, at=excluded.at`, u.id, d, did.slice(0, 3000), String(b.problems || '').trim().slice(0, 2000), String(b.plan || '').trim().slice(0, 2000), O.nowPK());
                log(u.id, 'ops.eod', 'eod:' + d, did.slice(0, 80));
                O.bust();
                return { ok: true };
            });
            route('GET', '/api/ops/me', 'tasks', (req, u) => ({ tasks: O.myTasks(u.id), eod: q.get('SELECT * FROM ops_eod WHERE user_id=? AND day=?', u.id, O.todayPK()) || null, output: O.myOutput(u.id), settings: { eodRemind: O.S().eodRemind }, onReport: O.people(O.todayPK()).some(p => p.user_id === u.id) }));
        },
        jobs: [{ name: 'daily', every: 5, offset: 2, run: () => { if (OPS)
                    OPS.tick(); } }],
        counts(u, ctx) {
            if (!OPS || !ctx.can(u, 'tasks'))
                return {};
            const now = OPS.nowPK(), today = now.slice(0, 10);
            const r = ctx.q.get(`SELECT COUNT(DISTINCT t.id) n FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<=?`, u.id, today);
            return { tasks: r.n || 0 };
        },
        alerts(u, ctx) {
            if (!OPS)
                return [];
            const out = [], st = OPS.S(), now = OPS.nowPK(), today = now.slice(0, 10), hm = now.slice(11, 16);
            const workday = (st.workdays || []).includes(weekday(today));
            if (ctx.can(u, 'tasks')) {
                const od = ctx.q.get(`SELECT COUNT(DISTINCT t.id) n FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.status<>'done' AND t.due_date IS NOT NULL AND (t.due_date || ' ' || COALESCE(t.due_time,'23:59')) < ?`, u.id, now.slice(0, 16)).n;
                if (od)
                    out.push({ level: 'warn', text: `You have ${od} overdue task${od > 1 ? 's' : ''}`, href: '#/tasks' });
                const onReport = OPS.people(today).some(p => p.user_id === u.id);
                if (onReport && workday && hm >= st.eodRemind && !ctx.q.get('SELECT 1 FROM ops_eod WHERE user_id=? AND day=?', u.id, today))
                    out.push({ level: 'warn', text: 'Write your end-of-day report before you leave', href: '#/tasks/eod' });
            }
            if (ctx.can(u, 'team') && workday) {
                const d = OPS.dayReport(today);
                const na = d.rows.filter(r => r.flags.some(f => f.k === 'noact' && f.lv === 'bad'));
                if (na.length && hm >= st.noActBy)
                    out.push({ level: 'bad', text: `${na.length} staff with no work recorded yet today: ${na.slice(0, 4).map(r => r.name).join(', ')}${na.length > 4 ? '…' : ''}`, href: '#/team' });
                const od = ctx.q.get(`SELECT COUNT(*) n FROM ops_tasks WHERE status<>'done' AND due_date IS NOT NULL AND (due_date || ' ' || COALESCE(due_time,'23:59')) < ?`, now.slice(0, 16)).n;
                if (od)
                    out.push({ level: 'warn', text: `${od} team task${od > 1 ? 's are' : ' is'} overdue`, href: '#/tasks/board' });
                if (hm >= st.eodRemind) {
                    const miss = d.rows.filter(r => r.user_id && r.present && !r.eod);
                    if (miss.length)
                        out.push({ level: 'info', text: `${miss.length} of ${d.totals.eodDue} people have not written today's end-of-day note`, href: '#/team' });
                }
            }
            return out;
        },
    };
};