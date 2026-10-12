    // HR & Payroll: employees, attendance (self check-in), leave, advances, payroll, warnings, "My page" data.
    'use strict';
    let C = null; // ctx, set in migrate()
    /* ---------- small date/time helpers (all business dates are Pakistan 'YYYY-MM-DD') ---------- */
    const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const wd = d => new Date(d + 'T00:00:00Z').getUTCDay();
    const range = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1))
        out.push(d); return out; };
    const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
    const prevMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
    const minDiff = (a, b) => Math.round((Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z')) / 60000);
    const r0 = v => Math.round(+v || 0);
    const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const isMonth = s => /^\d{4}-\d{2}$/.test(s || '');
    const DEPTS = ['CS', 'Listing', 'Warehouse', 'Finance', 'Marketing', 'Outlet', 'Management', 'Other'];
    const DEFAULTS = {
        allowed_ips: [], // office network prefixes, e.g. ['192.168.1.'] ; empty = check-in from anywhere
        leave_types: [{ key: 'casual', name: 'Casual', quota: 10, paid: true }, { key: 'sick', name: 'Sick', quota: 8, paid: true },
            { key: 'annual', name: 'Annual', quota: 14, paid: true }, { key: 'unpaid', name: 'Unpaid', quota: null, paid: false }],
        late_rule: { per: 3, days: 0.5 }, // every 3 lates = ½ day salary cut
        absent_alert_min: 60, // alert for absentees this many minutes after shift start
        company: '',
    };
    const S = () => (Object.assign(Object.assign({}, DEFAULTS), (C.setting('hr.settings', {}) || {})));
    const ltypes = () => S().leave_types;
    const ltype = k => ltypes().find(t => t.key === k);
    /* ---------- employees ---------- */
    const offs = e => { try {
        const a = JSON.parse(e.off_days || '[]');
        return Array.isArray(a) ? a.map(Number) : [];
    }
    catch (_a) {
        return [];
    } };
    const getEmp = id => C.q.get('SELECT * FROM hr_employees WHERE id=?', +id);
    const empForUser = uid => uid ? C.q.get("SELECT * FROM hr_employees WHERE user_id=? ORDER BY status='left', id DESC LIMIT 1", uid) : null;
    const SENSITIVE = ['cnic', 'basic', 'allowances', 'bank_account', 'pay_method', 'address', 'emergency'];
    const canSee = u => C.can(u, 'hr') || C.can(u, 'payroll');
    function pub(e, u) {
        const o = Object.assign(Object.assign({}, e), { off_days: offs(e), docs: (() => { try {
                return JSON.parse(e.docs || '[]');
            }
            catch (_a) {
                return [];
            } })() });
        if (!canSee(u))
            for (const k of SENSITIVE)
                delete o[k];
        return o;
    }
    const employedOn = (e, d) => d >= (e.join_date || '0000') && (!e.leave_date || d <= e.leave_date);
    /* ---------- attendance status engine ---------- */
    function load(from, to) {
        const { q } = C, att = new Map(), lv = new Map();
        for (const r of q.all('SELECT * FROM hr_attendance WHERE day BETWEEN ? AND ?', from, to))
            att.set(r.emp_id + '|' + r.day, r);
        for (const r of q.all("SELECT * FROM hr_leave WHERE status='approved' AND from_day<=? AND to_day>=?", to, from))
            for (const d of range(r.from_day < from ? from : r.from_day, r.to_day > to ? to : r.to_day))
                lv.set(r.emp_id + '|' + d, r);
        const hol = new Map(q.all('SELECT day,name FROM hr_holidays WHERE day BETWEEN ? AND ?', from, to).map(r => [r.day, r.name]));
        const now = C.pkNow();
        return { att, lv, hol, today: now.slice(0, 10), nowMin: toMin(now.slice(11, 16)) };
    }
    // status of one employee on one day: present | late | half | leave | halfleave | off | holiday | absent | not_yet | future | na
    function dayStatus(e, d, L) {
        var _a;
        if (!employedOn(e, d))
            return { s: 'na' };
        const a = L.att.get(e.id + '|' + d), l = L.lv.get(e.id + '|' + d);
        if (a && a.in_at)
            return { s: a.half ? 'half' : a.late_min > 0 ? 'late' : 'present', a, l };
        if (offs(e).includes(wd(d)))
            return { s: 'off' };
        if (L.hol.has(d))
            return { s: 'holiday', name: L.hol.get(d) };
        if (l)
            return { s: l.half ? 'halfleave' : 'leave', l };
        if (d > L.today)
            return { s: 'future' };
        if (d === L.today && L.nowMin < ((_a = toMin(e.shift_start)) !== null && _a !== void 0 ? _a : 540) + (+e.grace_min || 0))
            return { s: 'not_yet' };
        return { s: 'absent' };
    }
    const CODE = { present: 'P', late: 'L', half: '½', leave: 'LV', halfleave: '½LV', off: 'OFF', holiday: 'H', absent: 'A', not_yet: '', future: '', na: '–' };
    // month (or any range) tally for one employee
    function tally(e, days, L) {
        const t = { present: 0, late: 0, absent: 0, leave: 0, unpaid: 0, off: 0, holiday: 0, workdays: 0, cells: [] };
        for (const d of days) {
            const st = dayStatus(e, d, L);
            t.cells.push({ d, s: st.s, c: CODE[st.s], in_at: st.a && st.a.in_at, out_at: st.a && st.a.out_at, late_min: st.a && st.a.late_min, leave: st.l && st.l.type });
            const unpaid = st.l && ltype(st.l.type) && ltype(st.l.type).paid === false;
            const lvAdd = n => { if (unpaid)
                t.unpaid += n;
            else
                t.leave += n; };
            switch (st.s) {
                case 'present':
                case 'late':
                    t.present++;
                    if (st.s === 'late')
                        t.late++;
                    if (st.l && st.l.half)
                        lvAdd(0.5);
                    break;
                case 'half':
                    t.present += 0.5;
                    if (st.l && st.l.half)
                        lvAdd(0.5);
                    else
                        t.absent += 0.5;
                    break;
                case 'leave':
                    lvAdd(1);
                    break;
                case 'halfleave':
                    lvAdd(0.5);
                    if (d < L.today)
                        t.absent += 0.5;
                    break;
                case 'off':
                    t.off++;
                    break;
                case 'holiday':
                    t.holiday++;
                    break;
                case 'absent':
                    t.absent++;
                    break;
            }
            if (!['na', 'off', 'holiday'].includes(st.s))
                t.workdays++;
        }
        return t;
    }
    function attendanceOn(date) {
        const { q } = C, L = load(date, date);
        const emps = q.all("SELECT * FROM hr_employees WHERE status!='left' OR leave_date>=? ORDER BY name", date).filter(e => employedOn(e, date));
        return emps.map(e => {
            const st = dayStatus(e, date, L), a = st.a;
            let mins = a && a.minutes;
            if (a && a.in_at && !a.out_at && date === L.today)
                mins = Math.max(0, minDiff(a.in_at, C.pkNow()));
            return { employee_id: e.id, user_id: e.user_id, name: e.name, department: e.department, designation: e.designation, shift_start: e.shift_start, shift_end: e.shift_end,
                status: st.s === 'half' ? 'present' : st.s === 'halfleave' ? 'leave' : st.s, detail: st.s, half: st.s === 'half' || st.s === 'halfleave',
                in_at: a ? a.in_at : null, out_at: a ? a.out_at : null, late_min: a ? a.late_min || 0 : 0, early_min: a ? a.early_min || 0 : 0,
                hours: mins == null ? null : Math.round(mins / 6) / 10, att_id: a ? a.id : null, leave_type: st.l ? st.l.type : null, holiday: st.name || null, ip: a ? a.in_ip : null, note: a ? a.note : null };
        });
    }
    function summary() {
        const rows = attendanceOn(C.pkToday()), n = s => rows.filter(r => r.status === s).length;
        return { staff: rows.length, present: n('present') + n('late'), late: n('late'), absent: n('absent'), onLeave: n('leave'), off: n('off') + n('holiday'), notYet: n('not_yet') };
    }
    /* ---------- leave ---------- */
    function leaveDays(e, from, to, half) {
        const L = { hol: new Map(C.q.all('SELECT day,name FROM hr_holidays WHERE day BETWEEN ? AND ?', from, to).map(r => [r.day, r.name])) };
        const n = range(from, to).filter(d => !offs(e).includes(wd(d)) && !L.hol.has(d)).length;
        return half && from === to ? Math.min(n, 0.5) : n;
    }
    function balances(empId, year) {
        const used = {}, pend = {};
        for (const r of C.q.all("SELECT type,status,SUM(days) n FROM hr_leave WHERE emp_id=? AND substr(from_day,1,4)=? AND status IN ('approved','pending') GROUP BY type,status", empId, String(year)))
            (r.status === 'approved' ? used : pend)[r.type] = r.n;
        return ltypes().map(t => (Object.assign(Object.assign({}, t), { used: used[t.key] || 0, pending: pend[t.key] || 0, left: t.quota == null ? null : t.quota - (used[t.key] || 0) })));
    }
    function checkLeave(e, b, excludeId) {
        const { need, q } = C;
        need(ltype(b.type), 'Choose a leave type');
        need(isDay(b.from_day) && isDay(b.to_day || b.from_day), 'Choose the dates');
        const to = b.to_day || b.from_day;
        need(to >= b.from_day, 'End date is before start date');
        const half = !!b.half && b.from_day === to;
        const days = leaveDays(e, b.from_day, to, half);
        need(days > 0, 'Those dates are all off days or holidays');
        need(!q.get("SELECT id FROM hr_leave WHERE emp_id=? AND status IN ('pending','approved') AND from_day<=? AND to_day>=? AND id!=?", e.id, to, b.from_day, excludeId || 0), 'There is already a leave request on these dates');
        const t = ltype(b.type);
        if (t.quota != null) {
            const bal = balances(e.id, b.from_day.slice(0, 4)).find(x => x.key === t.key);
            need(bal.left >= days, `Not enough ${t.name} leave left (${bal.left} of ${t.quota} days left, asking for ${days})`);
        }
        return { from_day: b.from_day, to_day: to, half: half ? 1 : 0, days };
    }
    const lockedMonth = d => { const r = C.q.get("SELECT status FROM hr_payroll WHERE month=?", String(d).slice(0, 7)); return r && r.status === 'approved'; };
    /* ---------- advances ---------- */
    function advInfo(empId, upTo) {
        const { q } = C;
        const advs = q.all('SELECT * FROM hr_advances WHERE emp_id=? AND day<=? ORDER BY day, id', empId, upTo || '9999-12-31');
        const recovered = q.get("SELECT COALESCE(SUM(l.recovery),0) n FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? AND p.status='approved'", empId).n;
        const given = advs.reduce((s, a) => s + a.amount, 0), balance = Math.max(0, r0(given - recovered));
        let left = recovered, plan = 0;
        for (const a of advs) {
            const rem = Math.max(0, a.amount - left);
            left = Math.max(0, left - a.amount);
            a.remaining = r0(rem);
            if (rem > 0 && a.monthly > 0)
                plan += Math.min(a.monthly, rem);
        }
        return { advances: advs, given: r0(given), recovered: r0(recovered), balance, plan: r0(Math.min(plan, balance)) };
    }
    /* ---------- payroll ---------- */
    function eligible(month) {
        const from = month + '-01', to = monthEnd(month);
        return C.q.all('SELECT * FROM hr_employees WHERE join_date<=? AND (leave_date IS NULL OR leave_date>=?) ORDER BY department, name', to, from);
    }
    function calcLine(l) {
        const full = (+l.basic || 0) + (+l.allowances || 0);
        l.day_rate = full / 30;
        l.gross = l.emp_days < l.days_month ? r0(full * l.emp_days / l.days_month) : r0(full);
        l.absence_ded = Math.min(l.gross, r0(l.day_rate * ((+l.absent || 0) + (+l.unpaid || 0))));
        const rule = S().late_rule || DEFAULTS.late_rule;
        l.late_ded = Math.min(l.gross - l.absence_ded, r0(Math.floor((+l.late || 0) / Math.max(1, +rule.per || 3)) * (+rule.days || 0) * l.day_rate));
        l.earned = l.gross - l.absence_ded - l.late_ded;
        l.net = r0(l.earned + (+l.incentive || 0) - (+l.other_ded || 0) - (+l.recovery || 0));
        return l;
    }
    function computeMonth(month) {
        const from = month + '-01', to = monthEnd(month), cut = to < C.pkToday() ? to : C.pkToday();
        const L = load(from, to), days = range(from, cut), dm = range(from, to).length;
        return eligible(month).map(e => {
            const t = tally(e, days, L), a = advInfo(e.id, to);
            const s = e.join_date > from ? e.join_date : from, en = e.leave_date && e.leave_date < to ? e.leave_date : to;
            const l = { month, emp_id: e.id, name: e.name, department: e.department, designation: e.designation, days_month: dm, emp_days: range(s, en).length,
                present: t.present, late: t.late, absent: t.absent, leave_paid: t.leave, unpaid: t.unpaid, off: t.off, holiday: t.holiday,
                basic: +e.basic || 0, allowances: +e.allowances || 0, incentive: 0, incentive_note: '', other_ded: 0, other_note: '', recovery: 0, recovery_manual: 0, adv_balance: a.balance, adv_plan: a.plan };
            calcLine(l);
            l.recovery = Math.max(0, Math.min(a.plan, l.earned));
            return calcLine(l);
        });
    }
    const LINE_COLS = ['month', 'emp_id', 'name', 'department', 'designation', 'days_month', 'emp_days', 'present', 'late', 'absent', 'leave_paid', 'unpaid', 'off', 'holiday', 'basic', 'allowances', 'day_rate', 'gross',
        'absence_ded', 'late_ded', 'earned', 'incentive', 'incentive_note', 'other_ded', 'other_note', 'recovery', 'recovery_manual', 'adv_balance', 'net'];
    function saveLine(l) {
        C.q.run(`INSERT INTO hr_payslips(${LINE_COLS.join(',')}) VALUES(${LINE_COLS.map(() => '?').join(',')})
    ON CONFLICT(month,emp_id) DO UPDATE SET ${LINE_COLS.slice(2).map(c => c + '=excluded.' + c).join(',')}`, ...LINE_COLS.map(c => { var _a; return (_a = l[c]) !== null && _a !== void 0 ? _a : null; }));
    }
    const lines = month => C.q.all('SELECT * FROM hr_payslips WHERE month=? ORDER BY department, name', month);
    const runRow = month => C.q.get('SELECT * FROM hr_payroll WHERE month=?', month);
    const totals = ls => { const t = {}; for (const k of ['gross', 'absence_ded', 'late_ded', 'earned', 'incentive', 'other_ded', 'recovery', 'net'])
        t[k] = ls.reduce((s, l) => s + (+l[k] || 0), 0); t.paid = ls.filter(l => l.paid).reduce((s, l) => s + l.net, 0); t.staff = ls.length; return t; };
    const monthName = m => new Date(m + '-15T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    function payslip(month, empId) {
        const l = C.q.get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=?', month, empId);
        if (!l)
            return null;
        const e = getEmp(empId) || {}, run = runRow(month);
        return { company: S().company || C.setting('store_name', 'SundayBazar'), month, month_name: monthName(month), status: run && run.status, line: l,
            employee: { id: e.id, name: e.name, department: e.department, designation: e.designation, join_date: e.join_date, pay_method: e.pay_method, bank_account: e.bank_account, cnic: e.cnic },
            adv_balance_after: advInfo(empId).balance };
    }
    function clientIp(req) {
        const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        return (xf || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    }
    module.exports = {
        name: 'hr',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS hr_employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER, phone TEXT, cnic TEXT, address TEXT, emergency TEXT,
  department TEXT, designation TEXT, join_date TEXT, status TEXT DEFAULT 'active', leave_date TEXT, leave_reason TEXT,
  basic REAL DEFAULT 0, allowances REAL DEFAULT 0, pay_method TEXT DEFAULT 'Bank', bank_account TEXT,
  shift_start TEXT DEFAULT '09:00', shift_end TEXT DEFAULT '18:00', grace_min INTEGER DEFAULT 15, off_days TEXT DEFAULT '[0]',
  photo TEXT, docs TEXT DEFAULT '[]', notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_hr_emp_user ON hr_employees(user_id);
CREATE TABLE IF NOT EXISTS hr_attendance(id INTEGER PRIMARY KEY, emp_id INTEGER NOT NULL, day TEXT NOT NULL, in_at TEXT, out_at TEXT, in_ip TEXT, out_ip TEXT,
  late_min INTEGER DEFAULT 0, early_min INTEGER DEFAULT 0, minutes INTEGER, half INTEGER DEFAULT 0, source TEXT DEFAULT 'self', note TEXT, edited_by INTEGER, edited_at TEXT,
  UNIQUE(emp_id, day));
CREATE INDEX IF NOT EXISTS ix_hr_att_day ON hr_attendance(day);
CREATE TABLE IF NOT EXISTS hr_holidays(day TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS hr_leave(id INTEGER PRIMARY KEY, emp_id INTEGER NOT NULL, type TEXT, from_day TEXT, to_day TEXT, half INTEGER DEFAULT 0, days REAL, reason TEXT,
  status TEXT DEFAULT 'pending', decided_by INTEGER, decided_at TEXT, decision_note TEXT, created_by INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_hr_leave_emp ON hr_leave(emp_id, from_day);
CREATE TABLE IF NOT EXISTS hr_advances(id INTEGER PRIMARY KEY, emp_id INTEGER NOT NULL, day TEXT, amount REAL, method TEXT, monthly REAL DEFAULT 0, note TEXT, posted INTEGER DEFAULT 0, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS hr_payroll(month TEXT PRIMARY KEY, status TEXT DEFAULT 'draft', posted INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), approved_by INTEGER, approved_at TEXT);
CREATE TABLE IF NOT EXISTS hr_payslips(id INTEGER PRIMARY KEY, month TEXT NOT NULL, emp_id INTEGER NOT NULL, name TEXT, department TEXT, designation TEXT, days_month INTEGER, emp_days INTEGER,
  present REAL, late INTEGER, absent REAL, leave_paid REAL, unpaid REAL, off INTEGER, holiday INTEGER, basic REAL, allowances REAL, day_rate REAL, gross REAL,
  absence_ded REAL, late_ded REAL, earned REAL, incentive REAL DEFAULT 0, incentive_note TEXT, other_ded REAL DEFAULT 0, other_note TEXT, recovery REAL DEFAULT 0, recovery_manual INTEGER DEFAULT 0,
  adv_balance REAL, net REAL, paid INTEGER DEFAULT 0, paid_at TEXT, paid_from TEXT, UNIQUE(month, emp_id));
CREATE TABLE IF NOT EXISTS hr_warnings(id INTEGER PRIMARY KEY, emp_id INTEGER NOT NULL, day TEXT, type TEXT, note TEXT, file TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
`,
        migrate(ctx) { C = ctx; },
        routes(ctx) {
            const { route, q, need, can, log } = ctx;
            const acc = () => ctx.services.accounts && typeof ctx.services.accounts.post === 'function' ? ctx.services.accounts : null;
            const accPost = (entry, uid) => { const a = acc(); if (!a)
                return null; return a.post(entry, uid); };
            const accVoid = (src, id, uid) => { const a = acc(); if (a && a.void)
                a.void(src, id, uid); };
            const myEmp = u => { const e = empForUser(u.id); need(e, 'Your login is not linked to an employee record yet. Ask HR.', 404); return e; };
            const isOwner = u => u.role === 'admin';
            ctx.services.hr = {
                list: () => q.all("SELECT id,user_id,name,department,designation,status,join_date,leave_date,shift_start,shift_end,phone FROM hr_employees WHERE status!='left' ORDER BY name"),
                attendance: date => attendanceOn(isDay(date) ? date : ctx.pkToday()),
                employeeForUser: uid => { const e = empForUser(uid); return e ? { id: e.id, name: e.name, department: e.department, designation: e.designation, status: e.status, shift_start: e.shift_start, shift_end: e.shift_end } : null; },
                summary,
                monthStats: (month, empId) => { const e = getEmp(empId); if (!e)
                    return null; const to = monthEnd(month), t = tally(e, range(month + '-01', to < ctx.pkToday() ? to : ctx.pkToday()), load(month + '-01', to)); delete t.cells; return t; },
            };
            /* ----- employees ----- */
            route('GET', '/api/hr/meta', 'dashboard', () => ({ departments: DEPTS, leave_types: ltypes(), today: ctx.pkToday(), now: ctx.pkNow() }));
            route('GET', '/api/hr/users', 'hr', () => q.all("SELECT id,name,username,role FROM users WHERE active=1 ORDER BY name"));
            route('GET', '/api/hr/employees', 'dashboard', (req, u, b, res, p, qs) => {
                need(can(u, 'hr') || can(u, 'payroll') || can(u, 'team'), 'Your account does not have access to this', 403);
                const today = attendanceOn(ctx.pkToday()), st = new Map(today.map(r => [r.employee_id, r]));
                let rows = q.all(`SELECT e.*, us.username FROM hr_employees e LEFT JOIN users us ON us.id=e.user_id ORDER BY e.status='left', e.name`);
                if (qs.status)
                    rows = rows.filter(e => e.status === qs.status);
                if (qs.department)
                    rows = rows.filter(e => e.department === qs.department);
                if (qs.q) {
                    const s = qs.q.toLowerCase();
                    rows = rows.filter(e => [e.name, e.phone, e.designation, e.department, e.username].some(x => String(x || '').toLowerCase().includes(s)));
                }
                return rows.map(e => (Object.assign(Object.assign({}, pub(e, u)), { today: st.get(e.id) ? { status: st.get(e.id).detail, in_at: st.get(e.id).in_at, late_min: st.get(e.id).late_min } : null })));
            });
            route('GET', '/api/hr/employees/:id', 'dashboard', (req, u, b, res, p, qs) => {
                need(can(u, 'hr') || can(u, 'payroll'), 'Your account does not have access to this', 403);
                const e = getEmp(p.id);
                need(e, 'Not found', 404);
                const month = isMonth(qs.month) ? qs.month : ctx.pkToday().slice(0, 7), to = monthEnd(month);
                const t = tally(e, range(month + '-01', to), load(month + '-01', to));
                return { employee: pub(e, u), user: e.user_id ? q.get('SELECT id,name,username,role,active FROM users WHERE id=?', e.user_id) : null, month, attendance: t,
                    leaves: q.all('SELECT * FROM hr_leave WHERE emp_id=? ORDER BY from_day DESC LIMIT 100', e.id), balances: balances(e.id, ctx.pkToday().slice(0, 4)),
                    advances: advInfo(e.id), payslips: q.all("SELECT l.month,l.gross,l.net,l.paid,p.status FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? ORDER BY l.month DESC", e.id),
                    warnings: can(u, 'hr') ? q.all('SELECT w.*, us.name by_name FROM hr_warnings w LEFT JOIN users us ON us.id=w.user_id WHERE emp_id=? ORDER BY day DESC, id DESC', e.id) : [],
                    history: q.all("SELECT ev.at, ev.action, ev.detail, us.name user FROM events ev LEFT JOIN users us ON us.id=ev.user_id WHERE ev.entity=? ORDER BY ev.id DESC LIMIT 40", 'employee:' + e.id).map(x => (Object.assign(Object.assign({}, x), { label: (ctx.services.activityLabels || {})[x.action] || x.action }))) };
            });
            const FIELDS = ['name', 'user_id', 'phone', 'cnic', 'address', 'emergency', 'department', 'designation', 'join_date', 'status', 'leave_date', 'leave_reason',
                'basic', 'allowances', 'pay_method', 'bank_account', 'shift_start', 'shift_end', 'grace_min', 'off_days', 'photo', 'docs', 'notes'];
            const saveEmp = (u, b, id) => {
                const cur = id ? getEmp(id) : null;
                if (id)
                    need(cur, 'Not found', 404);
                const v = Object.assign({}, (cur || { status: 'active', shift_start: '09:00', shift_end: '18:00', grace_min: 15, off_days: '[0]', pay_method: 'Bank', docs: '[]', join_date: ctx.pkToday() }));
                for (const k of FIELDS)
                    if (b[k] !== undefined)
                        v[k] = b[k];
                v.name = String(v.name || '').trim();
                need(v.name, 'Name is required');
                need(['active', 'notice', 'left'].includes(v.status), 'Bad status');
                need(isDay(v.join_date), 'Join date is required');
                for (const k of ['shift_start', 'shift_end'])
                    need(toMin(v[k]) != null, 'Shift times look wrong (use HH:MM)');
                v.user_id = v.user_id ? +v.user_id : null;
                if (v.user_id) {
                    need(q.get('SELECT id FROM users WHERE id=?', v.user_id), 'That login does not exist');
                    need(!q.get('SELECT id FROM hr_employees WHERE user_id=? AND id!=?', v.user_id, id || 0), 'That login is already linked to another employee');
                }
                if (v.status === 'left') {
                    v.leave_date = v.leave_date || ctx.pkToday();
                    need(isDay(v.leave_date), 'Leaving date is wrong');
                }
                else if (v.status === 'active') {
                    v.leave_date = null;
                }
                if (Array.isArray(v.off_days))
                    v.off_days = JSON.stringify(v.off_days.map(Number).filter(n => n >= 0 && n <= 6));
                if (Array.isArray(v.docs))
                    v.docs = JSON.stringify(v.docs.filter(d => d && d.id).map(d => ({ id: String(d.id), name: String(d.name || 'Document').slice(0, 80) })));
                for (const k of ['basic', 'allowances', 'grace_min'])
                    v[k] = Math.max(0, +v[k] || 0);
                const cols = FIELDS;
                if (cur)
                    q.run(`UPDATE hr_employees SET ${cols.map(c => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`, ...cols.map(c => { var _a; return (_a = v[c]) !== null && _a !== void 0 ? _a : null; }), id);
                else
                    id = q.run(`INSERT INTO hr_employees(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map(c => { var _a; return (_a = v[c]) !== null && _a !== void 0 ? _a : null; })).lastInsertRowid;
                const changed = cur ? Object.fromEntries(cols.filter(c => { var _a, _b; return String((_a = cur[c]) !== null && _a !== void 0 ? _a : '') !== String((_b = v[c]) !== null && _b !== void 0 ? _b : ''); }).map(c => [c, SENSITIVE.includes(c) ? '(changed)' : v[c]])) : { name: v.name };
                log(u.id, cur ? (v.status === 'left' && cur.status !== 'left' ? 'hr.employee.left' : 'hr.employee.save') : 'hr.employee.add', 'employee:' + id, v.status === 'left' && cur && cur.status !== 'left' ? { date: v.leave_date, reason: v.leave_reason } : changed);
                return { ok: true, id: +id };
            };
            route('POST', '/api/hr/employees', 'hr', (req, u, b) => saveEmp(u, b, null));
            route('POST', '/api/hr/employees/:id', 'hr', (req, u, b, res, p) => saveEmp(u, b, +p.id));
            /* ----- warnings ----- */
            route('POST', '/api/hr/employees/:id/warnings', 'hr', (req, u, b, res, p) => {
                const e = getEmp(p.id);
                need(e, 'Not found', 404);
                need(['verbal', 'written', 'final', 'note', 'praise'].includes(b.type), 'Choose a type');
                need(String(b.note || '').trim(), 'Write what happened');
                const r = q.run('INSERT INTO hr_warnings(emp_id,day,type,note,file,user_id) VALUES(?,?,?,?,?,?)', e.id, isDay(b.day) ? b.day : ctx.pkToday(), b.type, String(b.note).trim(), b.file || null, u.id);
                log(u.id, 'hr.warning', 'employee:' + e.id, { type: b.type, note: String(b.note).slice(0, 200) });
                return { ok: true, id: r.lastInsertRowid };
            });
            route('DELETE', '/api/hr/warnings/:id', 'hr', (req, u, b, res, p) => { const w = q.get('SELECT * FROM hr_warnings WHERE id=?', +p.id); need(w, 'Not found', 404); q.run('DELETE FROM hr_warnings WHERE id=?', w.id); log(u.id, 'hr.warning.delete', 'employee:' + w.emp_id, w.type); return { ok: true }; });
            /* ----- settings & holidays ----- */
            route('GET', '/api/hr/settings', 'hr', (req, u) => (Object.assign(Object.assign({}, S()), { time_override: !!ctx.setting('hr.time_override', false), your_ip: clientIp(req) })));
            route('POST', '/api/hr/settings', 'hr', (req, u, b) => {
                const cur = S(), v = Object.assign({}, (ctx.setting('hr.settings', {}) || {}));
                if (b.allowed_ips !== undefined)
                    v.allowed_ips = (Array.isArray(b.allowed_ips) ? b.allowed_ips : String(b.allowed_ips).split(/[,\s]+/)).map(s => String(s).trim()).filter(Boolean);
                if (b.late_rule) {
                    need(+b.late_rule.per >= 1 && +b.late_rule.days >= 0, 'Late rule looks wrong');
                    v.late_rule = { per: Math.round(+b.late_rule.per), days: +b.late_rule.days };
                }
                if (b.leave_types) {
                    need(Array.isArray(b.leave_types) && b.leave_types.every(t => t.key && t.name), 'Leave types look wrong');
                    v.leave_types = b.leave_types.map(t => ({ key: String(t.key), name: String(t.name), quota: t.quota == null || t.quota === '' ? null : +t.quota, paid: t.paid !== false }));
                }
                if (b.absent_alert_min != null)
                    v.absent_alert_min = Math.max(0, +b.absent_alert_min || 0);
                if (b.company != null)
                    v.company = String(b.company).slice(0, 80);
                if (b.time_override !== undefined) {
                    need(isOwner(u), 'Only the owner can change this', 403);
                    ctx.setSetting('hr.time_override', !!b.time_override);
                }
                ctx.setSetting('hr.settings', v);
                log(u.id, 'hr.settings', 'hr', { before: { ips: cur.allowed_ips, late: cur.late_rule }, after: { ips: v.allowed_ips, late: v.late_rule } });
                return { ok: true };
            });
            route('GET', '/api/hr/holidays', 'dashboard', (req, u, b, res, p, qs) => q.all('SELECT * FROM hr_holidays WHERE substr(day,1,4)=? ORDER BY day', String(qs.year || ctx.pkToday().slice(0, 4))));
            route('POST', '/api/hr/holidays', 'hr', (req, u, b) => {
                need(isDay(b.day), 'Pick a date');
                need(String(b.name || '').trim(), 'Name the holiday');
                need(!lockedMonth(b.day), 'Payroll for that month is approved; ask the owner to reopen it first');
                q.run('INSERT INTO hr_holidays(day,name) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET name=excluded.name', b.day, String(b.name).trim());
                log(u.id, 'hr.holiday', 'holiday:' + b.day, b.name);
                return { ok: true };
            });
            route('DELETE', '/api/hr/holidays/:day', 'hr', (req, u, b, res, p) => { need(!lockedMonth(p.day), 'Payroll for that month is approved'); q.run('DELETE FROM hr_holidays WHERE day=?', p.day); log(u.id, 'hr.holiday.delete', 'holiday:' + p.day, ''); return { ok: true }; });
            /* ----- attendance (HR) ----- */
            route('GET', '/api/hr/attendance', 'hr', (req, u, b, res, p, qs) => { const d = isDay(qs.date) ? qs.date : ctx.pkToday(); const rows = attendanceOn(d); const L = load(d, d); return { date: d, today: ctx.pkToday(), holiday: L.hol.get(d) || null, rows, summary: ['present', 'late', 'absent', 'leave', 'off', 'holiday', 'not_yet'].reduce((o, s) => (o[s] = rows.filter(r => r.status === s).length, o), {}) }; });
            route('GET', '/api/hr/register', 'hr', (req, u, b, res, p, qs) => {
                const month = isMonth(qs.month) ? qs.month : ctx.pkToday().slice(0, 7), to = monthEnd(month), days = range(month + '-01', to), L = load(month + '-01', to);
                const emps = q.all("SELECT * FROM hr_employees WHERE join_date<=? AND (leave_date IS NULL OR leave_date>=?) ORDER BY department, name", to, month + '-01');
                return { month, days: days.map(d => ({ d, wd: wd(d), hol: L.hol.get(d) || null })), rows: emps.map(e => { const t = tally(e, days, L); return Object.assign(Object.assign({ id: e.id, name: e.name, department: e.department }, t), { cells: t.cells.map(c => c.c) }); }) };
            });
            const fixAtt = (e, row) => {
                var _a, _b;
                const ss = (_a = toMin(e.shift_start)) !== null && _a !== void 0 ? _a : 540, se = (_b = toMin(e.shift_end)) !== null && _b !== void 0 ? _b : 1080;
                const inM = row.in_at ? toMin(row.in_at.slice(11, 16)) : null, outM = row.out_at ? toMin(row.out_at.slice(11, 16)) : null;
                row.late_min = inM != null && inM > ss + (+e.grace_min || 0) ? inM - ss : 0;
                row.early_min = row.out_at && outM < se && row.out_at.slice(0, 10) === row.day ? se - outM : 0;
                row.minutes = row.in_at && row.out_at ? Math.max(0, minDiff(row.in_at, row.out_at)) : null;
                return row;
            };
            route('POST', '/api/hr/attendance', 'hr', (req, u, b) => {
                const e = getEmp(b.emp_id);
                need(e, 'Choose an employee');
                need(isDay(b.day), 'Choose a date');
                need(b.day <= ctx.pkToday(), 'Cannot mark attendance for a future date');
                need(String(b.reason || '').trim(), 'Write a reason for this change (it is recorded)');
                need(!lockedMonth(b.day), 'Payroll for that month is approved; ask the owner to reopen it first');
                const old = q.get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', e.id, b.day);
                if (b.clear) {
                    if (old)
                        q.run('DELETE FROM hr_attendance WHERE id=?', old.id);
                    log(u.id, 'hr.attendance.edit', 'employee:' + e.id, { day: b.day, before: old && { in: old.in_at, out: old.out_at }, after: 'absent', reason: b.reason });
                    return { ok: true };
                }
                need(toMin(b.in_time) != null, 'Enter the check-in time (HH:MM)');
                const row = fixAtt(e, { day: b.day, in_at: b.day + ' ' + b.in_time.slice(0, 5) + ':00', out_at: toMin(b.out_time) != null ? b.day + ' ' + b.out_time.slice(0, 5) + ':00' : null });
                if (row.out_at)
                    need(row.out_at > row.in_at, 'Check-out must be after check-in');
                const half = b.half ? 1 : 0, note = String(b.reason).trim().slice(0, 300);
                if (old)
                    q.run("UPDATE hr_attendance SET in_at=?, out_at=?, late_min=?, early_min=?, minutes=?, half=?, source='hr', note=?, edited_by=?, edited_at=datetime('now') WHERE id=?", row.in_at, row.out_at, row.late_min, row.early_min, row.minutes, half, note, u.id, old.id);
                else
                    q.run("INSERT INTO hr_attendance(emp_id,day,in_at,out_at,late_min,early_min,minutes,half,source,note,edited_by,edited_at) VALUES(?,?,?,?,?,?,?,?,'hr',?,?,datetime('now'))", e.id, b.day, row.in_at, row.out_at, row.late_min, row.early_min, row.minutes, half, note, u.id);
                log(u.id, 'hr.attendance.edit', 'employee:' + e.id, { day: b.day, before: old ? { in: old.in_at, out: old.out_at, half: old.half } : null, after: { in: row.in_at, out: row.out_at, half }, reason: note });
                return { ok: true, late_min: row.late_min, early_min: row.early_min, minutes: row.minutes };
            });
            /* ----- self check-in / check-out ----- */
            const stamp = (u, b) => {
                if (b.at) {
                    need(isOwner(u) || ctx.setting('hr.time_override', false) === true, 'Time override is not allowed', 403);
                    need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(b.at), 'Bad time');
                    return b.at.length === 16 ? b.at + ':00' : b.at;
                }
                return ctx.pkNow();
            };
            const ipCheck = req => { const ip = clientIp(req), allow = S().allowed_ips || []; need(!allow.length || allow.some(p => ip.startsWith(p)), `Check-in only works on the office WiFi/network. Your device (${ip || 'unknown'}) is not on it.`, 403); return ip; };
            route('GET', '/api/hr/me/today', 'me', (req, u) => {
                const e = empForUser(u.id);
                if (!e || e.status === 'left')
                    return { linked: false };
                const d = ctx.pkToday(), a = q.get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', e.id, d);
                const open = q.get('SELECT * FROM hr_attendance WHERE emp_id=? AND out_at IS NULL AND in_at IS NOT NULL AND day>=? ORDER BY day DESC LIMIT 1', e.id, addDays(d, -1));
                return { linked: true, name: e.name, shift_start: e.shift_start, shift_end: e.shift_end, today: a || null, open: open && minDiff(open.in_at, ctx.pkNow()) < 20 * 60 ? open : null };
            });
            route('POST', '/api/hr/me/checkin', 'me', (req, u, b) => {
                const e = myEmp(u);
                need(e.status !== 'left', 'Your employee record is marked as left', 403);
                const ip = ipCheck(req), at = stamp(u, b), d = at.slice(0, 10);
                const old = q.get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', e.id, d);
                need(!old || !old.in_at, `You already checked in today at ${old && old.in_at ? old.in_at.slice(11, 16) : ''}`);
                const row = fixAtt(e, { day: d, in_at: at, out_at: null });
                if (old)
                    q.run("UPDATE hr_attendance SET in_at=?, in_ip=?, late_min=?, source='self' WHERE id=?", at, ip, row.late_min, old.id);
                else
                    q.run("INSERT INTO hr_attendance(emp_id,day,in_at,in_ip,late_min,source) VALUES(?,?,?,?,?,'self')", e.id, d, at, ip, row.late_min);
                log(u.id, 'hr.checkin', 'employee:' + e.id, { at, ip, late_min: row.late_min });
                return { ok: true, in_at: at, late_min: row.late_min, ip };
            });
            route('POST', '/api/hr/me/checkout', 'me', (req, u, b) => {
                const e = myEmp(u);
                const ip = ipCheck(req), at = stamp(u, b);
                const a = q.get('SELECT * FROM hr_attendance WHERE emp_id=? AND in_at IS NOT NULL AND out_at IS NULL AND day>=? AND day<=? ORDER BY day DESC LIMIT 1', e.id, addDays(at.slice(0, 10), -1), at.slice(0, 10));
                need(a && minDiff(a.in_at, at) < 20 * 60, 'You have not checked in yet');
                need(at > a.in_at, 'Check-out time is before check-in');
                const row = fixAtt(e, Object.assign(Object.assign({}, a), { out_at: at }));
                q.run('UPDATE hr_attendance SET out_at=?, out_ip=?, early_min=?, minutes=? WHERE id=?', at, ip, row.early_min, row.minutes, a.id);
                log(u.id, 'hr.checkout', 'employee:' + e.id, { at, ip, minutes: row.minutes, early_min: row.early_min });
                return { ok: true, out_at: at, minutes: row.minutes, hours: Math.round(row.minutes / 6) / 10, early_min: row.early_min };
            });
            /* ----- leave ----- */
            route('GET', '/api/hr/leave', 'hr', (req, u, b, res, p, qs) => {
                const st = ['pending', 'approved', 'rejected', 'cancelled'].includes(qs.status) ? qs.status : null;
                const rows = q.all(`SELECT l.*, e.name, e.department, us.name decided_name FROM hr_leave l JOIN hr_employees e ON e.id=l.emp_id LEFT JOIN users us ON us.id=l.decided_by ${st ? 'WHERE l.status=?' : ''} ORDER BY ${st === 'pending' ? 'l.from_day' : 'l.id DESC'} LIMIT 300`, ...(st ? [st] : []));
                const yr = ctx.pkToday().slice(0, 4);
                return { rows: rows.map(r => (Object.assign(Object.assign({}, r), { balance: r.status === 'pending' ? (balances(r.emp_id, r.from_day.slice(0, 4)).find(x => x.key === r.type) || {}).left : undefined }))), types: ltypes(),
                    pending: q.get("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'").n,
                    balances: q.all("SELECT id,name,department FROM hr_employees WHERE status!='left' ORDER BY name").map(e => (Object.assign(Object.assign({}, e), { balances: balances(e.id, yr) }))) };
            });
            route('POST', '/api/hr/leave', 'hr', (req, u, b) => {
                const e = getEmp(b.emp_id);
                need(e, 'Choose an employee');
                const v = checkLeave(e, b);
                const status = b.pending ? 'pending' : 'approved';
                if (status === 'approved')
                    need(!lockedMonth(v.from_day) && !lockedMonth(v.to_day), 'Payroll for that month is approved');
                const r = q.run("INSERT INTO hr_leave(emp_id,type,from_day,to_day,half,days,reason,status,decided_by,decided_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)", e.id, b.type, v.from_day, v.to_day, v.half, v.days, String(b.reason || '').slice(0, 300), status, status === 'approved' ? u.id : null, status === 'approved' ? ctx.pkNow() : null, u.id);
                log(u.id, status === 'approved' ? 'hr.leave.approve' : 'hr.leave.request', 'employee:' + e.id, { type: b.type, from: v.from_day, to: v.to_day, days: v.days });
                return { ok: true, id: r.lastInsertRowid, days: v.days };
            });
            route('POST', '/api/hr/leave/:id/decide', 'hr', (req, u, b, res, p) => {
                const l = q.get('SELECT * FROM hr_leave WHERE id=?', +p.id);
                need(l, 'Not found', 404);
                need(l.status === 'pending' || (b.status === 'cancelled' && l.status === 'approved'), 'This request is already ' + l.status);
                need(['approved', 'rejected', 'cancelled'].includes(b.status), 'Approve or reject');
                need(!lockedMonth(l.from_day) && !lockedMonth(l.to_day), 'Payroll for that month is approved; ask the owner to reopen it first');
                if (b.status === 'approved') {
                    const e = getEmp(l.emp_id);
                    checkLeave(e, { type: l.type, from_day: l.from_day, to_day: l.to_day, half: l.half }, l.id);
                }
                q.run('UPDATE hr_leave SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?', b.status, u.id, ctx.pkNow(), String(b.note || '').slice(0, 300), l.id);
                log(u.id, 'hr.leave.' + ({ approved: 'approve', rejected: 'reject', cancelled: 'cancel' })[b.status], 'employee:' + l.emp_id, { type: l.type, from: l.from_day, to: l.to_day, days: l.days, note: b.note || '' });
                return { ok: true };
            });
            /* ----- my page (self only) ----- */
            route('GET', '/api/hr/me', 'me', (req, u, b, res, p, qs) => {
                const e = empForUser(u.id);
                if (!e)
                    return { employee: null };
                const today = ctx.pkToday(), month = isMonth(qs.month) ? qs.month : today.slice(0, 7), to = monthEnd(month);
                const L = load(month + '-01', to), t = tally(e, range(month + '-01', to), L), st = dayStatus(e, today, load(today, today));
                const a = advInfo(e.id);
                return { employee: { id: e.id, name: e.name, department: e.department, designation: e.designation, status: e.status, shift_start: e.shift_start, shift_end: e.shift_end, grace_min: e.grace_min, join_date: e.join_date, off_days: offs(e) },
                    today: { status: st.s, in_at: st.a && st.a.in_at, out_at: st.a && st.a.out_at, late_min: st.a ? st.a.late_min : 0, minutes: st.a && st.a.minutes },
                    month, attendance: t, balances: balances(e.id, today.slice(0, 4)), types: ltypes(),
                    leaves: q.all('SELECT id,type,from_day,to_day,half,days,reason,status,decision_note FROM hr_leave WHERE emp_id=? ORDER BY id DESC LIMIT 20', e.id),
                    advance: { balance: a.balance, given: a.given, recovered: a.recovered, advances: a.advances.map(x => ({ day: x.day, amount: x.amount, monthly: x.monthly, remaining: x.remaining })) },
                    payslips: q.all("SELECT l.month,l.net,l.paid,l.paid_at FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? AND p.status='approved' ORDER BY l.month DESC LIMIT 24", e.id) };
            });
            route('POST', '/api/hr/me/leave', 'me', (req, u, b) => {
                const e = myEmp(u);
                need(e.status !== 'left', 'Your employee record is marked as left', 403);
                const v = checkLeave(e, b);
                need(v.from_day >= addDays(ctx.pkToday(), -7), 'For leave older than a week, ask HR to record it');
                const r = q.run("INSERT INTO hr_leave(emp_id,type,from_day,to_day,half,days,reason,status,created_by) VALUES(?,?,?,?,?,?,?,'pending',?)", e.id, b.type, v.from_day, v.to_day, v.half, v.days, String(b.reason || '').slice(0, 300), u.id);
                log(u.id, 'hr.leave.request', 'employee:' + e.id, { type: b.type, from: v.from_day, to: v.to_day, days: v.days });
                return { ok: true, id: r.lastInsertRowid, days: v.days };
            });
            route('POST', '/api/hr/me/leave/:id/cancel', 'me', (req, u, b, res, p) => {
                const e = myEmp(u), l = q.get('SELECT * FROM hr_leave WHERE id=? AND emp_id=?', +p.id, e.id);
                need(l, 'Not found', 404);
                need(l.status === 'pending', 'Only pending requests can be cancelled');
                q.run("UPDATE hr_leave SET status='cancelled', decided_by=?, decided_at=? WHERE id=?", u.id, ctx.pkNow(), l.id);
                log(u.id, 'hr.leave.cancel', 'employee:' + e.id, { from: l.from_day });
                return { ok: true };
            });
            route('GET', '/api/hr/me/payslips/:month', 'me', (req, u, b, res, p) => {
                const e = myEmp(u), run = runRow(p.month);
                need(run && run.status === 'approved', 'Payslip not ready yet', 404);
                const s = payslip(p.month, e.id);
                need(s, 'No payslip for this month', 404);
                return s;
            });
            /* ----- advances ----- */
            route('GET', '/api/hr/advances', 'payroll', () => {
                const emps = q.all("SELECT id,name,department,status FROM hr_employees ORDER BY name");
                const list = q.all('SELECT a.*, e.name, us.name by_name FROM hr_advances a JOIN hr_employees e ON e.id=a.emp_id LEFT JOIN users us ON us.id=a.user_id ORDER BY a.day DESC, a.id DESC LIMIT 300');
                return { list, balances: emps.map(e => (Object.assign(Object.assign(Object.assign({}, e), advInfo(e.id)), { advances: undefined }))).filter(x => x.given > 0), accounts: !!acc() };
            });
            route('POST', '/api/hr/advances', 'payroll', (req, u, b) => {
                const e = getEmp(b.emp_id);
                need(e, 'Choose an employee');
                need(+b.amount > 0, 'Enter the amount');
                need(['Cash', 'Meezan (SB)'].includes(b.method), 'Paid from Cash or Meezan (SB)?');
                const day = isDay(b.day) ? b.day : ctx.pkToday(), monthly = Math.max(0, +b.monthly || 0);
                // no q.tx around accounts calls (the accounts module may open its own transaction); undo by hand on failure
                const id = q.run('INSERT INTO hr_advances(emp_id,day,amount,method,monthly,note,user_id) VALUES(?,?,?,?,?,?,?)', e.id, day, +b.amount, b.method, monthly, String(b.note || '').slice(0, 200), u.id).lastInsertRowid;
                let j = null;
                try {
                    j = accPost({ date: day, memo: `Advance to ${e.name}${b.note ? ' · ' + b.note : ''}`, source: 'hr-advance', source_id: String(id),
                        lines: [{ account: 'Employees Advance', debit: +b.amount, party: 'employee:' + e.id }, { account: b.method, credit: +b.amount }] }, u.id);
                }
                catch (x) {
                    q.run('DELETE FROM hr_advances WHERE id=?', id);
                    throw new ctx.HttpError(400, 'Could not post to accounts: ' + x.message);
                }
                if (j != null)
                    q.run('UPDATE hr_advances SET posted=1 WHERE id=?', id);
                log(u.id, 'hr.advance', 'employee:' + e.id, { amount: +b.amount, method: b.method, monthly });
                return { ok: true, id: +id, posted: j != null, journal: j !== null && j !== void 0 ? j : null, balance: advInfo(e.id).balance };
            });
            route('POST', '/api/hr/advances/:id/delete', 'payroll', (req, u, b, res, p) => {
                const a = q.get('SELECT * FROM hr_advances WHERE id=?', +p.id);
                need(a, 'Not found', 404);
                const info = advInfo(a.emp_id);
                need(info.balance >= a.amount, 'Part of this advance was already recovered in payroll; it cannot be deleted');
                if (a.posted)
                    accVoid('hr-advance', String(a.id), u.id);
                q.run('DELETE FROM hr_advances WHERE id=?', a.id);
                log(u.id, 'hr.advance.delete', 'employee:' + a.emp_id, { amount: a.amount });
                return { ok: true };
            });
            /* ----- payroll ----- */
            route('GET', '/api/hr/payroll', 'payroll', () => q.all('SELECT * FROM hr_payroll ORDER BY month DESC').map(r => (Object.assign(Object.assign({}, r), totals(lines(r.month))))));
            route('GET', '/api/hr/payroll/:month', 'payroll', (req, u, b, res, p) => {
                need(isMonth(p.month), 'Bad month');
                const run = runRow(p.month);
                const ls = run ? lines(p.month) : computeMonth(p.month);
                return { month: p.month, month_name: monthName(p.month), run: run || null, lines: ls, totals: totals(ls), rule: S().late_rule, accounts: !!acc(), owner: isOwner(u), current: p.month >= ctx.pkToday().slice(0, 7) };
            });
            route('POST', '/api/hr/payroll/:month/run', 'payroll', (req, u, b, res, p) => {
                need(isMonth(p.month), 'Bad month');
                need(p.month <= ctx.pkToday().slice(0, 7), 'That month has not started yet');
                const run = runRow(p.month);
                need(!run || run.status === 'draft', 'Payroll for this month is approved and locked');
                const old = new Map(lines(p.month).map(l => [l.emp_id, l]));
                q.tx(() => {
                    if (!run)
                        q.run('INSERT INTO hr_payroll(month,status,created_by) VALUES(?,?,?)', p.month, 'draft', u.id);
                    q.run('DELETE FROM hr_payslips WHERE month=?', p.month);
                    for (const l of computeMonth(p.month)) {
                        const o = old.get(l.emp_id);
                        if (o) {
                            Object.assign(l, { incentive: o.incentive, incentive_note: o.incentive_note, other_ded: o.other_ded, other_note: o.other_note });
                            if (o.recovery_manual)
                                Object.assign(l, { recovery: Math.min(o.recovery, l.adv_balance), recovery_manual: 1 });
                        }
                        saveLine(calcLine(l));
                    }
                });
                log(u.id, 'hr.payroll.run', 'payroll:' + p.month, totals(lines(p.month)));
                return { ok: true, lines: lines(p.month).length };
            });
            route('POST', '/api/hr/payroll/:month/line/:emp', 'payroll', (req, u, b, res, p) => {
                const run = runRow(p.month);
                need(run, 'Run the payroll first');
                need(run.status === 'draft', 'Payroll for this month is approved and locked');
                const l = q.get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=?', p.month, +p.emp);
                need(l, 'Not found', 404);
                for (const k of ['incentive', 'other_ded'])
                    if (b[k] != null) {
                        need(+b[k] >= 0, 'Amounts cannot be negative');
                        l[k] = r0(b[k]);
                    }
                for (const k of ['incentive_note', 'other_note'])
                    if (b[k] != null)
                        l[k] = String(b[k]).slice(0, 200);
                if (b.recovery != null) {
                    const bal = advInfo(l.emp_id, monthEnd(p.month)).balance;
                    need(+b.recovery >= 0 && +b.recovery <= bal, `Recovery must be between 0 and the advance balance (${bal})`);
                    l.recovery = r0(b.recovery);
                    l.recovery_manual = 1;
                }
                calcLine(l);
                need(l.net >= 0, 'Net pay would be negative; lower the deductions or recovery');
                saveLine(l);
                log(u.id, 'hr.payroll.edit', 'employee:' + l.emp_id, { month: p.month, incentive: l.incentive, other_ded: l.other_ded, recovery: l.recovery, note: [l.incentive_note, l.other_note].filter(Boolean).join(' / ') });
                return { ok: true, line: l };
            });
            route('POST', '/api/hr/payroll/:month/approve', 'payroll', (req, u, b, res, p) => {
                const run = runRow(p.month);
                need(run && run.status === 'draft', run ? 'Already approved' : 'Run the payroll first');
                const ls = lines(p.month);
                need(ls.length, 'No employees in this payroll');
                need(ls.every(l => l.net >= 0), 'Some lines have negative net pay');
                const t = totals(ls), date = monthEnd(p.month);
                const jl = [{ account: 'Salary Exp', debit: r0(t.earned + t.incentive) }];
                if (t.other_ded > 0)
                    jl.push({ account: 'Other Income', credit: r0(t.other_ded) });
                for (const l of ls) {
                    if (l.recovery > 0)
                        jl.push({ account: 'Employees Advance', credit: r0(l.recovery), party: 'employee:' + l.emp_id });
                    if (l.net > 0)
                        jl.push({ account: 'Salaries Payable', credit: r0(l.net), party: 'employee:' + l.emp_id });
                }
                let j = null;
                if (jl[0].debit > 0) {
                    try {
                        j = accPost({ date, memo: 'Salaries ' + monthName(p.month), source: 'payroll', source_id: p.month, lines: jl.filter(x => (x.debit || x.credit) > 0) }, u.id);
                    }
                    catch (x) {
                        throw new ctx.HttpError(400, 'Could not post to accounts: ' + x.message);
                    }
                }
                q.run("UPDATE hr_payroll SET status='approved', posted=?, approved_by=?, approved_at=? WHERE month=?", j != null ? 1 : 0, u.id, ctx.pkNow(), p.month);
                log(u.id, 'hr.payroll.approve', 'payroll:' + p.month, { net: t.net, staff: t.staff, posted: j != null });
                return { ok: true, posted: j != null, journal: j, totals: t, warning: acc() ? null : 'Accounts module is not available, so nothing was posted to the books.' };
            });
            route('POST', '/api/hr/payroll/:month/pay', 'payroll', (req, u, b, res, p) => {
                const run = runRow(p.month);
                need(run && run.status === 'approved', 'Approve the payroll first');
                need(['Cash', 'Meezan (SB)', 'Petty Cash'].includes(b.account), 'Paid from which account?');
                const date = isDay(b.date) ? b.date : ctx.pkToday();
                const ls = lines(p.month).filter(l => !l.paid && (!b.emp_ids || b.emp_ids.map(Number).includes(l.emp_id)));
                need(ls.length, 'Nothing left to pay');
                let posted = 0;
                for (const l of ls) {
                    if (l.net > 0 && run.posted) {
                        let j;
                        try {
                            j = accPost({ date, memo: `Salary ${monthName(p.month)} paid · ${l.name}`, source: 'payroll-pay', source_id: p.month + ':' + l.emp_id,
                                lines: [{ account: 'Salaries Payable', debit: r0(l.net), party: 'employee:' + l.emp_id }, { account: b.account, credit: r0(l.net) }] }, u.id);
                        }
                        catch (x) {
                            throw new ctx.HttpError(400, `Could not post ${l.name}'s payment: ` + x.message);
                        }
                        if (j != null)
                            posted++;
                    }
                    q.run('UPDATE hr_payslips SET paid=1, paid_at=?, paid_from=? WHERE id=?', date, b.account, l.id);
                }
                log(u.id, 'hr.payroll.paid', 'payroll:' + p.month, { staff: ls.length, amount: ls.reduce((s, l) => s + l.net, 0), account: b.account });
                return { ok: true, paid: ls.length, posted };
            });
            route('POST', '/api/hr/payroll/:month/unpay', 'payroll', (req, u, b, res, p) => {
                need(isOwner(u), 'Only the owner can undo a payment', 403);
                const l = q.get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=? AND paid=1', p.month, +b.emp_id);
                need(l, 'Not paid');
                accVoid('payroll-pay', p.month + ':' + l.emp_id, u.id);
                q.run('UPDATE hr_payslips SET paid=0, paid_at=NULL, paid_from=NULL WHERE id=?', l.id);
                log(u.id, 'hr.payroll.unpay', 'employee:' + l.emp_id, { month: p.month });
                return { ok: true };
            });
            route('POST', '/api/hr/payroll/:month/reopen', 'payroll', (req, u, b, res, p) => {
                need(isOwner(u), 'Only the owner can reopen an approved payroll', 403);
                const run = runRow(p.month);
                need(run && run.status === 'approved', 'Not approved');
                need(!q.get('SELECT id FROM hr_payslips WHERE month=? AND paid=1', p.month), 'Some salaries are already marked paid. Undo those payments first.');
                if (run.posted)
                    accVoid('payroll', p.month, u.id);
                q.run("UPDATE hr_payroll SET status='draft', posted=0, approved_by=NULL, approved_at=NULL WHERE month=?", p.month);
                log(u.id, 'hr.payroll.reopen', 'payroll:' + p.month, String(b.reason || ''));
                return { ok: true };
            });
            route('POST', '/api/hr/payroll/:month/discard', 'payroll', (req, u, b, res, p) => {
                const run = runRow(p.month);
                need(run && run.status === 'draft', 'Only a draft can be discarded');
                q.tx(() => { q.run('DELETE FROM hr_payslips WHERE month=?', p.month); q.run('DELETE FROM hr_payroll WHERE month=?', p.month); });
                log(u.id, 'hr.payroll.discard', 'payroll:' + p.month, '');
                return { ok: true };
            });
            route('GET', '/api/hr/payroll/:month/payslip/:emp', 'payroll', (req, u, b, res, p) => { const s = payslip(p.month, +p.emp); need(s, 'No payslip', 404); return s; });
        },
        counts(u) { return C.can(u, 'hr') ? { leave: C.q.get("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'").n } : {}; },
        alerts(u) {
            const out = [], { q, can } = C;
            if (can(u, 'hr')) {
                if (q.get('SELECT id FROM hr_employees LIMIT 1')) {
                    const L = load(C.pkToday(), C.pkToday()), lim = +S().absent_alert_min || 60;
                    const abs = attendanceOn(C.pkToday()).filter(r => { var _a; return r.status === 'absent' && L.nowMin >= ((_a = toMin(r.shift_start)) !== null && _a !== void 0 ? _a : 540) + lim; });
                    if (abs.length)
                        out.push({ level: 'warn', text: `${abs.length} ${abs.length === 1 ? 'person has' : 'people have'} not come today and have no leave: ${abs.slice(0, 5).map(r => r.name).join(', ')}${abs.length > 5 ? '…' : ''}`, href: '#/attendance' });
                }
                const n = q.get("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'").n;
                if (n)
                    out.push({ level: 'info', text: `${n} leave request${n > 1 ? 's' : ''} waiting for approval`, href: '#/leave' });
            }
            if (can(u, 'payroll')) {
                const today = C.pkToday(), lm = prevMonth(today.slice(0, 7)), r = q.get('SELECT status FROM hr_payroll WHERE month=?', lm);
                if (+today.slice(8) >= 7 && (!r || r.status !== 'approved') && eligible(lm).length)
                    out.push({ level: 'warn', text: `Payroll for ${monthName(lm)} has not been ${r ? 'approved' : 'run'} yet`, href: '#/payroll/run/' + lm });
            }
            return out;
        },
        activity: {
            'hr.checkin': 'Checked in', 'hr.checkout': 'Checked out', 'hr.attendance.edit': 'Edited attendance', 'hr.leave.request': 'Requested leave', 'hr.leave.approve': 'Approved leave',
            'hr.leave.reject': 'Rejected leave', 'hr.leave.cancel': 'Cancelled leave', 'hr.employee.add': 'Added employee', 'hr.employee.save': 'Updated employee', 'hr.employee.left': 'Marked employee as left',
            'hr.warning': 'Gave warning / note', 'hr.warning.delete': 'Deleted warning', 'hr.holiday': 'Added holiday', 'hr.holiday.delete': 'Removed holiday', 'hr.settings': 'Changed HR settings',
            'hr.advance': 'Gave salary advance', 'hr.advance.delete': 'Deleted advance', 'hr.payroll.run': 'Ran payroll', 'hr.payroll.edit': 'Edited payroll line', 'hr.payroll.approve': 'Approved payroll',
            'hr.payroll.paid': 'Paid salaries', 'hr.payroll.unpay': 'Undid salary payment', 'hr.payroll.reopen': 'Reopened payroll', 'hr.payroll.discard': 'Discarded payroll draft',
        },
    };
};