    // Expenses & petty cash: staff claims with receipts, approvals (posted to accounts), petty cash boxes, cash counts, recurring bills, reports.
    'use strict';
    const PAY = { petty: 'Petty cash', own: 'My own money (to be reimbursed)', bank: 'Bank (Meezan)', card: 'Company card', accrued: 'Pay later (accrued bill)' };
    const CATS = [
        ['Grocery & pantry', 'Grocery & Pantry'], ['Staff food', 'Food Allowance'], ['Conveyance (rickshaw, fuel)', 'Conveyance'], ['Electricity, gas & water', 'Utility Expenses'],
        ['Internet & mobile package', 'Internet & Mobile Package'], ['Repair & maintenance', 'Repair & Maintenance'], ['Packaging material', 'Packaging'], ['Office rent', 'Office Rent'],
        ['Outlet rent', 'Outlet Rent'], ['Outlet expenses', 'Outlet Expenses'], ['IT & computer', 'I.T Expenses'], ['Apps & subscriptions', 'Apps & Subscription Charges'],
        ['Shopify charges', 'Shopify Charges'], ['Other marketing', 'Other Marketing'], ['Guests & entertainment', 'Entertainment'], ['Donation', 'Donation'],
        ['Bank charges', 'Bank Charges'], ['QC expenses', 'QC Expenses'], ['Courier (not PostEx)', 'Shipping Exp'], ['Staff gifts', 'Incentives/Gifts'], ['Stationery & other', 'Miscellenious Exp'],
    ];
    const ACCOUNTS = ['Grocery & Pantry', 'Food Allowance', 'Conveyance', 'Utility Expenses', 'Internet & Mobile Package', 'Repair & Maintenance', 'Packaging', 'Office Rent', 'Outlet Rent',
        'Outlet Expenses', 'I.T Expenses', 'Apps & Subscription Charges', 'Shopify Charges', 'Other Marketing', 'Entertainment', 'Donation', 'Bank Charges', 'QC Expenses',
        'Shipping Exp', 'Incentives/Gifts', 'Commission', 'Legal Fees', 'Miscellenious Exp', 'Office Equipments', 'Outlet Equipments', 'Office Furniture', 'Outlet Furniture',
        'Employees Advance', 'Prepaid Rent'];
    const r2 = v => Math.round((+v || 0) * 100) / 100;
    const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const monthsBack = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 - n, 1)); return d.toISOString().slice(0, 7); };
    const lastDom = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
    module.exports = {
        name: 'expenses',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS exp_categories(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, account TEXT NOT NULL, budget REAL, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS exp_claims(id INTEGER PRIMARY KEY, day TEXT NOT NULL, category_id INTEGER, category TEXT, account TEXT, amount REAL NOT NULL,
  paid_from TEXT NOT NULL, box_id INTEGER, vendor TEXT, note TEXT, receipt TEXT, user_id INTEGER, status TEXT DEFAULT 'pending', reason TEXT,
  approved_by INTEGER, approved_at TEXT, reimbursed INTEGER DEFAULT 0, reimbursed_at TEXT, reimbursed_by INTEGER, reimb_from TEXT,
  recurring_id INTEGER, period TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_exp_claims_status ON exp_claims(status);
CREATE INDEX IF NOT EXISTS ix_exp_claims_day ON exp_claims(day);
CREATE INDEX IF NOT EXISTS ix_exp_claims_user ON exp_claims(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_exp_claims_rec ON exp_claims(recurring_id, period) WHERE recurring_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS exp_boxes(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, custodian INTEGER, low REAL DEFAULT 5000, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS exp_box_moves(id INTEGER PRIMARY KEY, box_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, ref TEXT, note TEXT, src TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_exp_moves_box ON exp_box_moves(box_id, day);
CREATE TABLE IF NOT EXISTS exp_counts(id INTEGER PRIMARY KEY, box_id INTEGER NOT NULL, day TEXT, counted REAL, book REAL, pending REAL, variance REAL, note TEXT, user_id INTEGER,
  status TEXT DEFAULT 'ok', approved_by INTEGER, approved_at TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS exp_recurring(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER, amount REAL DEFAULT 0, dom INTEGER DEFAULT 1, paid_from TEXT DEFAULT 'bank',
  vendor TEXT, note TEXT, active INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS exp_postings(id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, entry TEXT, status TEXT DEFAULT 'pending', error TEXT, journal_id TEXT,
  tries INTEGER DEFAULT 0, user_id INTEGER, at TEXT DEFAULT (datetime('now')), UNIQUE(source, source_id));`,
        migrate(ctx) {
            const { q } = ctx;
            if (!q.get('SELECT id FROM exp_categories LIMIT 1'))
                CATS.forEach(([n, a], i) => q.run('INSERT INTO exp_categories(name,account,sort) VALUES(?,?,?)', n, a, i));
            if (!q.get('SELECT id FROM exp_boxes LIMIT 1')) {
                q.run("INSERT INTO exp_boxes(name,low) VALUES('Office',5000)");
                q.run("INSERT INTO exp_boxes(name,low) VALUES('Outlet',3000)");
            }
            if (!q.get('SELECT id FROM exp_recurring LIMIT 1')) {
                const cat = a => (q.get('SELECT id FROM exp_categories WHERE account=? ORDER BY sort LIMIT 1', a) || {}).id || null;
                for (const [n, a, pf, dom] of [['Office rent', 'Office Rent', 'bank', 1], ['Outlet rent', 'Outlet Rent', 'bank', 1], ['Internet', 'Internet & Mobile Package', 'bank', 5],
                    ['Electricity (estimate)', 'Utility Expenses', 'accrued', 25], ['Shopify subscription', 'Shopify Charges', 'card', 10]])
                    q.run('INSERT INTO exp_recurring(name,category_id,amount,dom,paid_from,active) VALUES(?,?,?,?,?,0)', n, cat(a), 0, dom, pf);
            }
        },
        routes(ctx) {
            const { route, q, need, can, log, setting, setSetting, pkToday } = ctx;
            const S = ctx._exp = {};
            const limit = () => +setting('expenses_receipt_limit', 2000);
            const cardAcc = () => setting('expenses_card_account', 'Meezan (SB)');
            const waitDays = () => +setting('expenses_wait_days', 2);
            const isApprover = u => can(u, 'expenses_approve');
            const myBoxes = u => q.all('SELECT id FROM exp_boxes WHERE custodian=? AND active=1', u.id).map(b => b.id);
            const boxBal = id => r2((q.get('SELECT COALESCE(SUM(amount),0) s FROM exp_box_moves WHERE box_id=?', id) || {}).s);
            const boxPending = id => r2(q.get("SELECT COALESCE(SUM(amount),0) s FROM exp_claims WHERE box_id=? AND paid_from='petty' AND status='pending'", id).s);
            const canBox = (u, id) => isApprover(u) || myBoxes(u).includes(+id);
            const CLAIM_SQL = `SELECT c.*, us.name user, ap.name approver, b.name box, p.status post_status, p.error post_error FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id
      LEFT JOIN users ap ON ap.id=c.approved_by LEFT JOIN exp_boxes b ON b.id=c.box_id LEFT JOIN exp_postings p ON p.source='expense' AND p.source_id=CAST(c.id AS TEXT)`;
            const claim = id => q.get(CLAIM_SQL + ' WHERE c.id=?', +id);
            /* ---------- posting to accounts (or queue it when the accounts module is not there yet) ---------- */
            async function post(source, sid, entry, uid) {
                sid = String(sid);
                q.run(`INSERT INTO exp_postings(source,source_id,entry,status,user_id) VALUES(?,?,?,'pending',?) ON CONFLICT(source,source_id) DO UPDATE SET entry=excluded.entry, status='pending', error=NULL, user_id=excluded.user_id`, source, sid, JSON.stringify(entry), uid || null);
                return tryPost(q.get('SELECT * FROM exp_postings WHERE source=? AND source_id=?', source, sid));
            }
            async function tryPost(row) {
                const A = ctx.services.accounts;
                if (!A || typeof A.post !== 'function')
                    return 'pending';
                try {
                    const e = JSON.parse(row.entry), L = (A.lockDate && A.lockDate()) || '';
                    // a claim dated in a month that is already closed is booked on the first open day (the narration keeps the real date)
                    if (L && e.date <= L) {
                        const d = new Date(Date.parse(L + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
                        e.memo = `${e.memo} (dated ${e.date}, booked after month close)`;
                        e.date = d > pkToday() ? pkToday() : d;
                    }
                    const jid = await A.post(Object.assign(Object.assign({}, e), { source: row.source, source_id: row.source_id }), row.user_id);
                    q.run("UPDATE exp_postings SET status='posted', error=NULL, journal_id=?, tries=tries+1 WHERE id=?", jid == null ? null : String(jid), row.id);
                    return 'posted';
                }
                catch (e) {
                    q.run("UPDATE exp_postings SET status='error', error=?, tries=tries+1 WHERE id=?", String(e.message || e).slice(0, 300), row.id);
                    return 'error';
                }
            }
            async function unpost(source, sid, uid) {
                sid = String(sid);
                const row = q.get('SELECT * FROM exp_postings WHERE source=? AND source_id=?', source, sid);
                if (!row)
                    return;
                const A = ctx.services.accounts;
                if (row.status === 'posted' && A && A.void)
                    await A.void(source, sid, uid); // throws e.g. for a closed month → caller shows the error
                q.run('DELETE FROM exp_postings WHERE id=?', row.id);
            }
            async function retryAll() { let n = 0; for (const row of q.all("SELECT * FROM exp_postings WHERE status IN ('pending','error') ORDER BY id LIMIT 500"))
                if (await tryPost(row) === 'posted')
                    n++; return n; }
            S.retryAll = retryAll;
            // staff sub-ledger party, same convention as HR/payroll: employee:<hr employee id>; staff not set up in HR yet: employee:u<user id>
            const staffParty = uid => { let e = null; try {
                e = q.get("SELECT id FROM hr_employees WHERE user_id=? ORDER BY (status='active') DESC, id DESC LIMIT 1", uid);
            }
            catch (_a) { } return 'employee:' + (e ? e.id : 'u' + uid); };
            // the party the claim was booked to (so the reimbursement clears the same sub-ledger even if HR was set up in between)
            const claimParty = c => { const row = q.get("SELECT entry FROM exp_postings WHERE source='expense' AND source_id=?", String(c.id)); try {
                const l = JSON.parse(row.entry).lines.find(x => x.account === 'Accrued Expenses' && x.party);
                if (l)
                    return l.party;
            }
            catch (_a) { } return staffParty(c.user_id); };
            const crFor = c => c.paid_from === 'petty' ? { account: 'Petty Cash' } : c.paid_from === 'own' ? { account: 'Accrued Expenses', party: staffParty(c.user_id) }
                : c.paid_from === 'card' ? { account: cardAcc() } : c.paid_from === 'accrued' ? { account: 'Accrued Expenses', party: c.vendor ? 'vendor:' + c.vendor : undefined } : { account: 'Meezan (SB)' };
            const claimEntry = c => {
                const cr = crFor(c);
                const memo = [c.category, c.vendor, c.user || (c.recurring_id ? 'recurring' : '')].filter(Boolean).join(' · ');
                return { date: c.day, memo: 'Expense #' + c.id + ': ' + memo + (c.note ? ' — ' + c.note : ''), lines: [{ account: c.account, debit: c.amount }, Object.assign(Object.assign({}, cr), { credit: c.amount })] };
            };
            /* ---------- meta ---------- */
            route('GET', '/api/exp/meta', 'expenses', (req, u) => ({
                categories: q.all('SELECT id,name,account FROM exp_categories WHERE active=1 ORDER BY sort,name'),
                boxes: q.all('SELECT b.id,b.name,b.custodian,us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian WHERE b.active=1 ORDER BY b.id'),
                pay: Object.fromEntries(Object.entries(PAY).filter(([k]) => k !== 'accrued')), payAll: PAY, accounts: ACCOUNTS, limit: limit(), today: pkToday(),
                approver: isApprover(u), myBoxes: myBoxes(u), accountsLive: !!(ctx.services.accounts && ctx.services.accounts.post),
            }));
            /* ---------- staff: submit + my claims ---------- */
            const validate = (b, u, old) => {
                need(isDay(b.day), 'Pick a date');
                need(b.day <= pkToday(), 'Date cannot be in the future');
                const amt = r2(b.amount);
                need(amt > 0, 'Enter the amount');
                need(amt < 1e7, 'Amount looks too big');
                const cat = q.get('SELECT * FROM exp_categories WHERE id=?', +b.category_id);
                need(cat, 'Pick a category');
                need(PAY[b.paid_from] && b.paid_from !== 'accrued', 'Choose how it was paid');
                const receipt = b.receipt || (old && old.receipt) || null;
                need(receipt || amt <= limit(), `Please attach a photo of the receipt (needed above Rs ${limit().toLocaleString('en-PK')})`);
                let box = null;
                if (b.paid_from === 'petty') {
                    const boxes = q.all('SELECT id FROM exp_boxes WHERE active=1 ORDER BY id').map(x => x.id);
                    box = +b.box_id || myBoxes(u)[0] || boxes[0];
                    need(boxes.includes(box), 'Pick the cash box');
                }
                return { day: b.day, category_id: cat.id, category: cat.name, account: cat.account, amount: amt, paid_from: b.paid_from, box_id: box, vendor: String(b.vendor || '').trim().slice(0, 80), note: String(b.note || '').trim().slice(0, 300), receipt };
            };
            route('POST', '/api/exp/claims', 'expenses', (req, u, b) => {
                const v = validate(b, u);
                const r = q.run('INSERT INTO exp_claims(day,category_id,category,account,amount,paid_from,box_id,vendor,note,receipt,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', v.day, v.category_id, v.category, v.account, v.amount, v.paid_from, v.box_id, v.vendor, v.note, v.receipt, u.id);
                log(u.id, 'exp.submit', 'expense:' + r.lastInsertRowid, { amount: v.amount, category: v.category, paid_from: v.paid_from });
                return claim(r.lastInsertRowid);
            });
            route('POST', '/api/exp/claims/:id', 'expenses', (req, u, b, res, p) => {
                const c = claim(p.id);
                need(c, 'Not found', 404);
                need(c.user_id === u.id || isApprover(u), 'Not your claim', 403);
                need(c.status !== 'approved', 'Already approved — ask an approver to reopen it');
                const v = validate(b, u, c);
                q.run("UPDATE exp_claims SET day=?,category_id=?,category=?,account=?,amount=?,paid_from=?,box_id=?,vendor=?,note=?,receipt=?,status='pending',reason=NULL WHERE id=?", v.day, v.category_id, v.category, v.account, v.amount, v.paid_from, v.box_id, v.vendor, v.note, v.receipt, c.id);
                log(u.id, 'exp.edit', 'expense:' + c.id, { amount: v.amount });
                return claim(c.id);
            });
            route('DELETE', '/api/exp/claims/:id', 'expenses', (req, u, b, res, p) => {
                const c = claim(p.id);
                need(c, 'Not found', 404);
                need(c.user_id === u.id || isApprover(u), 'Not your claim', 403);
                need(c.status !== 'approved', 'Approved claims cannot be deleted');
                q.run('DELETE FROM exp_claims WHERE id=?', c.id);
                log(u.id, 'exp.delete', 'expense:' + c.id, { amount: c.amount, category: c.category });
                return { ok: true };
            });
            route('GET', '/api/exp/claims/:id', 'expenses', (req, u, b, res, p) => { const c = claim(p.id); need(c, 'Not found', 404); need(c.user_id === u.id || isApprover(u), 'Not your claim', 403); return c; });
            route('GET', '/api/exp/mine', 'expenses', (req, u, b, res, p, qs) => {
                const rows = q.all(CLAIM_SQL + ' WHERE c.user_id=? ORDER BY c.day DESC, c.id DESC LIMIT ?', u.id, Math.min(500, +qs.limit || 100));
                const t = q.get(`SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COALESCE(SUM(CASE WHEN status='approved' AND paid_from='own' AND reimbursed=0 THEN amount END),0) owed,
        COALESCE(SUM(CASE WHEN status!='rejected' AND substr(day,1,7)=? THEN amount END),0) month FROM exp_claims WHERE user_id=?`, pkToday().slice(0, 7), u.id);
                return { rows, totals: t, limit: limit() };
            });
            /* ---------- approvals ---------- */
            route('GET', '/api/exp/claims', 'expenses_approve', (req, u, b, res, p, qs) => {
                const w = [], a = [];
                if (qs.status === 'owed')
                    w.push("c.status='approved' AND c.paid_from='own' AND c.reimbursed=0");
                else if (qs.status) {
                    w.push('c.status=?');
                    a.push(qs.status);
                }
                if (qs.month) {
                    w.push('substr(c.day,1,7)=?');
                    a.push(qs.month);
                }
                if (qs.user) {
                    w.push('c.user_id=?');
                    a.push(+qs.user);
                }
                if (qs.category) {
                    w.push('c.category=?');
                    a.push(qs.category);
                }
                if (qs.q) {
                    w.push('(c.vendor LIKE ? OR c.note LIKE ? OR c.category LIKE ?)');
                    a.push(...Array(3).fill('%' + qs.q + '%'));
                }
                const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
                const pg = ctx.page(qs, 100);
                const rows = q.all(CLAIM_SQL + where + ` ORDER BY ${qs.status === 'pending' ? 'c.day, c.id' : 'c.day DESC, c.id DESC'} LIMIT ? OFFSET ?`, ...a, pg.limit, pg.offset);
                const t = q.get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims c' + where, ...a);
                return { rows, total: t.n, amount: r2(t.s), page: pg.page, pages: Math.ceil(t.n / pg.limit) };
            });
            route('POST', '/api/exp/approve', 'expenses_approve', async (req, u, b) => {
                const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(Boolean);
                need(ids.length, 'Nothing selected');
                const out = { approved: 0, posted: 0, pending: 0, errors: [], skipped: [] };
                for (const id of ids) {
                    const c = claim(id);
                    if (!c || c.status === 'approved') {
                        out.skipped.push(id);
                        continue;
                    }
                    if (c.user_id === u.id && u.role !== 'admin') {
                        out.skipped.push(id);
                        out.errors.push(`#${id}: you cannot approve your own claim`);
                        continue;
                    }
                    q.tx(() => {
                        q.run("UPDATE exp_claims SET status='approved', reason=NULL, approved_by=?, approved_at=datetime('now') WHERE id=?", u.id, id);
                        if (c.paid_from === 'petty' && c.box_id) {
                            q.run("DELETE FROM exp_box_moves WHERE src='claim' AND ref=?", String(id));
                            q.run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'expense',?,?,?,'claim',?)", c.box_id, c.day, -c.amount, String(id), [c.category, c.vendor].filter(Boolean).join(' · '), c.user_id);
                        }
                    });
                    out.approved++;
                    log(u.id, 'exp.approve', 'expense:' + id, { amount: c.amount, category: c.category });
                    const st = await post('expense', id, claimEntry(claim(id)), u.id);
                    if (st === 'posted')
                        out.posted++;
                    else {
                        out.pending++;
                        if (st === 'error')
                            out.errors.push(`#${id}: ${q.get("SELECT error FROM exp_postings WHERE source='expense' AND source_id=?", String(id)).error}`);
                    }
                }
                return out;
            });
            route('POST', '/api/exp/reject', 'expenses_approve', (req, u, b) => {
                const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(Boolean);
                need(ids.length, 'Nothing selected');
                const reason = String(b.reason || '').trim();
                need(reason, 'Write a reason so the staff member knows what to fix');
                let n = 0;
                for (const id of ids) {
                    const c = claim(id);
                    if (!c || c.status !== 'pending')
                        continue;
                    q.run("UPDATE exp_claims SET status='rejected', reason=?, approved_by=?, approved_at=datetime('now') WHERE id=?", reason.slice(0, 300), u.id, id);
                    n++;
                    log(u.id, 'exp.reject', 'expense:' + id, { amount: c.amount, reason });
                }
                return { rejected: n };
            });
            route('POST', '/api/exp/reopen', 'expenses_approve', async (req, u, b) => {
                const c = claim(b.id);
                need(c, 'Not found', 404);
                need(c.status !== 'pending', 'Already waiting');
                need(!c.reimbursed, 'Already reimbursed — cannot reopen');
                if (c.status === 'approved')
                    await unpost('expense', c.id, u.id);
                q.run("DELETE FROM exp_box_moves WHERE src='claim' AND ref=?", String(c.id));
                q.run("UPDATE exp_claims SET status='pending', reason=NULL, approved_by=NULL, approved_at=NULL WHERE id=?", c.id);
                log(u.id, 'exp.reopen', 'expense:' + c.id, { amount: c.amount });
                return claim(c.id);
            });
            // reimburse own-money claims: Dr Accrued Expenses (employee) / Cr Cash, Meezan or a petty box
            route('GET', '/api/exp/owed', 'expenses_approve', () => q.all(`SELECT c.user_id, us.name user, COUNT(*) n, SUM(c.amount) amount, GROUP_CONCAT(c.id) ids FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id
      WHERE c.status='approved' AND c.paid_from='own' AND c.reimbursed=0 GROUP BY c.user_id ORDER BY amount DESC`).map(r => (Object.assign(Object.assign({}, r), { ids: String(r.ids).split(',').map(Number) }))));
            route('POST', '/api/exp/reimburse', 'expenses_approve', async (req, u, b) => {
                const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(Boolean);
                need(ids.length, 'Nothing selected');
                const from = String(b.from || 'Cash');
                let box = null, acc = from;
                if (from.startsWith('petty:')) {
                    box = q.get('SELECT * FROM exp_boxes WHERE id=?', +from.slice(6));
                    need(box, 'Unknown cash box');
                    acc = 'Petty Cash';
                }
                else
                    need(['Cash', 'Meezan (SB)'].includes(from), 'Pay from Cash, Meezan or a petty cash box');
                const dayv = isDay(b.day) ? b.day : pkToday();
                const out = { reimbursed: 0, amount: 0, posted: 0, pending: 0 };
                for (const id of ids) {
                    const c = claim(id);
                    if (!c || c.status !== 'approved' || c.paid_from !== 'own' || c.reimbursed)
                        continue;
                    q.run("UPDATE exp_claims SET reimbursed=1, reimbursed_at=?, reimbursed_by=?, reimb_from=? WHERE id=?", dayv, u.id, from, id);
                    if (box)
                        q.run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'reimburse',?,?,?,'reimb',?)", box.id, dayv, -c.amount, String(id), 'Paid back to ' + (c.user || 'staff'), u.id);
                    const st = await post('expense_reimb', id, { date: dayv, memo: `Reimbursed expense #${id} to ${c.user || 'staff'}`, lines: [{ account: 'Accrued Expenses', debit: c.amount, party: claimParty(c) }, { account: acc, credit: c.amount }] }, u.id);
                    out.reimbursed++;
                    out.amount = r2(out.amount + c.amount);
                    st === 'posted' ? out.posted++ : out.pending++;
                    log(u.id, 'exp.reimburse', 'expense:' + id, { amount: c.amount, to: c.user, from });
                }
                return out;
            });
            /* ---------- categories ---------- */
            route('GET', '/api/exp/categories', 'expenses_approve', (req, u, b, res, p, qs) => {
                const m = qs.month || pkToday().slice(0, 7);
                return q.all(`SELECT k.*, COALESCE((SELECT SUM(amount) FROM exp_claims c WHERE c.category_id=k.id AND c.status!='rejected' AND substr(c.day,1,7)=?),0) spent FROM exp_categories k ORDER BY k.active DESC, k.sort, k.name`, m);
            });
            route('POST', '/api/exp/categories', 'expenses_approve', (req, u, b) => {
                const name = String(b.name || '').trim();
                need(name, 'Name is needed');
                need(ACCOUNTS.includes(b.account) || String(b.account || '').trim(), 'Pick an account');
                need(!['Salary Exp', 'Social Media Marketing', 'Cost of Goods Sold', 'Purchases', 'Accounts Payable'].includes(String(b.account).trim()), `${String(b.account).trim()} is booked by its own screen (payroll, marketing, lots) — an expense category on it would count the cost twice`);
                if (ctx.services.accounts && ctx.services.accounts.accountId)
                    need(ctx.services.accounts.accountId(String(b.account).trim()), `There is no account "${String(b.account).trim()}" in the chart of accounts`);
                const dup = q.get('SELECT id FROM exp_categories WHERE name=? AND id!=?', name, +b.id || 0);
                need(!dup, 'A category with this name exists');
                const budget = b.budget === '' || b.budget == null ? null : r2(b.budget);
                let id = +b.id;
                if (id)
                    q.run('UPDATE exp_categories SET name=?, account=?, budget=?, active=? WHERE id=?', name, String(b.account).trim(), budget, b.active === false || b.active === 0 ? 0 : 1, id);
                else
                    id = q.run('INSERT INTO exp_categories(name,account,budget,sort) VALUES(?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM exp_categories))', name, String(b.account).trim(), budget).lastInsertRowid;
                log(u.id, 'exp.category_save', 'exp_category:' + id, { name, account: b.account, budget });
                return q.get('SELECT * FROM exp_categories WHERE id=?', id);
            });
            /* ---------- petty cash boxes ---------- */
            const boxRow = b => { const bal = boxBal(b.id), pend = boxPending(b.id); const last = q.get('SELECT * FROM exp_counts WHERE box_id=? ORDER BY id DESC LIMIT 1', b.id); return Object.assign(Object.assign({}, b), { balance: bal, pending: pend, expected: r2(bal - pend), low_now: bal < (b.low || 0), lastCount: last || null }); };
            route('GET', '/api/exp/boxes', 'expenses', (req, u) => {
                const all = q.all('SELECT b.*, us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian ORDER BY b.active DESC, b.id');
                const mine = myBoxes(u);
                return all.filter(b => isApprover(u) || mine.includes(b.id)).map(boxRow);
            });
            route('POST', '/api/exp/boxes', 'expenses_approve', (req, u, b) => {
                const name = String(b.name || '').trim();
                need(name, 'Name is needed');
                need(!q.get('SELECT id FROM exp_boxes WHERE name=? AND id!=?', name, +b.id || 0), 'A box with this name exists');
                const cust = b.custodian ? +b.custodian : null;
                if (cust)
                    need(q.get('SELECT id FROM users WHERE id=?', cust), 'Unknown user');
                let id = +b.id;
                if (id)
                    q.run('UPDATE exp_boxes SET name=?, custodian=?, low=?, active=? WHERE id=?', name, cust, r2(b.low), b.active === false ? 0 : 1, id);
                else
                    id = q.run('INSERT INTO exp_boxes(name,custodian,low) VALUES(?,?,?)', name, cust, r2(b.low || 5000)).lastInsertRowid;
                log(u.id, 'exp.box_save', 'exp_box:' + id, { name, custodian: cust, low: b.low });
                return boxRow(q.get('SELECT * FROM exp_boxes WHERE id=?', id));
            });
            route('GET', '/api/exp/users', 'expenses_approve', () => q.all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'));
            route('GET', '/api/exp/boxes/:id/register', 'expenses', (req, u, b, res, p, qs) => {
                const box = q.get('SELECT b.*, us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian WHERE b.id=?', +p.id);
                need(box, 'Not found', 404);
                need(canBox(u, box.id), 'Not your cash box', 403);
                const from = isDay(qs.from) ? qs.from : '0000-00-00', to = isDay(qs.to) ? qs.to : '9999-12-31';
                const opening = r2(q.get('SELECT COALESCE(SUM(amount),0) s FROM exp_box_moves WHERE box_id=? AND day<?', box.id, from).s);
                let run = opening;
                const rows = q.all(`SELECT m.*, us.name user, p.status post_status FROM exp_box_moves m LEFT JOIN users us ON us.id=m.user_id
        LEFT JOIN exp_postings p ON p.source=(CASE m.src WHEN 'topup' THEN 'petty_topup' WHEN 'count' THEN 'petty_count' WHEN 'reimb' THEN 'expense_reimb' ELSE 'expense' END) AND p.source_id=m.ref
        WHERE m.box_id=? AND m.day BETWEEN ? AND ? ORDER BY m.day, m.id`, box.id, from, to).map(m => { run = r2(run + m.amount); return Object.assign(Object.assign({}, m), { balance: run }); });
                const pending = q.all(CLAIM_SQL + " WHERE c.box_id=? AND c.paid_from='petty' AND c.status='pending' ORDER BY c.day", box.id);
                return { box: boxRow(box), opening, closing: run, rows: rows.reverse(), pending, counts: q.all('SELECT k.*, us.name user, ap.name approver FROM exp_counts k LEFT JOIN users us ON us.id=k.user_id LEFT JOIN users ap ON ap.id=k.approved_by WHERE box_id=? ORDER BY k.id DESC LIMIT 30', box.id) };
            });
            route('POST', '/api/exp/boxes/:id/topup', 'expenses_approve', async (req, u, b, res, p) => {
                const box = q.get('SELECT * FROM exp_boxes WHERE id=?', +p.id);
                need(box, 'Not found', 404);
                const amt = r2(b.amount);
                need(amt > 0, 'Enter the amount');
                const from = b.from || 'Meezan (SB)';
                need(['Meezan (SB)', 'Cash'].includes(from), 'Top up from Meezan or Cash');
                const dayv = isDay(b.day) ? b.day : pkToday();
                const id = q.run("INSERT INTO exp_box_moves(box_id,day,kind,amount,note,src,user_id) VALUES(?,?,'topup',?,?,'topup',?)", box.id, dayv, amt, String(b.note || 'Top-up from ' + from).slice(0, 200), u.id).lastInsertRowid;
                q.run('UPDATE exp_box_moves SET ref=? WHERE id=?', String(id), id);
                const st = await post('petty_topup', id, { date: dayv, memo: `Petty cash top-up · ${box.name} box`, lines: [{ account: 'Petty Cash', debit: amt }, { account: from, credit: amt }] }, u.id);
                log(u.id, 'exp.topup', 'exp_box:' + box.id, { amount: amt, from });
                return { id, posting: st, balance: boxBal(box.id) };
            });
            route('POST', '/api/exp/boxes/:id/count', 'expenses', (req, u, b, res, p) => {
                const box = q.get('SELECT * FROM exp_boxes WHERE id=?', +p.id);
                need(box, 'Not found', 404);
                need(canBox(u, box.id), 'Only the custodian or an approver can count this box', 403);
                need(b.counted !== '' && b.counted != null && +b.counted >= 0, 'Enter the cash you counted');
                const counted = r2(b.counted), book = boxBal(box.id), pend = boxPending(box.id), variance = r2(counted - (book - pend));
                const id = q.run('INSERT INTO exp_counts(box_id,day,counted,book,pending,variance,note,user_id,status) VALUES(?,?,?,?,?,?,?,?,?)', box.id, pkToday(), counted, book, pend, variance, String(b.note || '').slice(0, 300), u.id, Math.abs(variance) < 1 ? 'ok' : 'pending').lastInsertRowid;
                log(u.id, 'exp.count', 'exp_box:' + box.id, { counted, book, variance });
                return q.get('SELECT * FROM exp_counts WHERE id=?', id);
            });
            route('POST', '/api/exp/counts/:id/:act', 'expenses_approve', async (req, u, b, res, p) => {
                const k = q.get('SELECT k.*, b.name box FROM exp_counts k JOIN exp_boxes b ON b.id=k.box_id WHERE k.id=?', +p.id);
                need(k, 'Not found', 404);
                need(k.status === 'pending', 'This count is already settled');
                need(['approve', 'reject'].includes(p.act), 'Unknown action', 404);
                if (p.act === 'reject') {
                    q.run("UPDATE exp_counts SET status='rejected', approved_by=?, approved_at=datetime('now'), note=COALESCE(note,'')||? WHERE id=?", u.id, b.reason ? ' · Rejected: ' + b.reason : '', k.id);
                    log(u.id, 'exp.count_reject', 'exp_box:' + k.box_id, { variance: k.variance });
                    return { ok: true };
                }
                q.run("UPDATE exp_counts SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?", u.id, k.id);
                q.run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'adjust',?,?,?,'count',?)", k.box_id, pkToday(), k.variance, String(k.id), (k.variance < 0 ? 'Cash short' : 'Cash over') + ' in count #' + k.id, u.id);
                const v = Math.abs(k.variance);
                const lines = k.variance < 0 ? [{ account: 'Miscellenious Exp', debit: v }, { account: 'Petty Cash', credit: v }] : [{ account: 'Petty Cash', debit: v }, { account: 'Miscellenious Exp', credit: v }];
                const st = await post('petty_count', k.id, { date: pkToday(), memo: `Petty cash count difference · ${k.box} box (count #${k.id})`, lines }, u.id);
                log(u.id, 'exp.count_approve', 'exp_box:' + k.box_id, { variance: k.variance });
                return { ok: true, posting: st };
            });
            /* ---------- recurring ---------- */
            async function runRecurring(today) {
                today = isDay(today) ? today : pkToday();
                const m = today.slice(0, 7), d = +today.slice(8, 10);
                let made = 0;
                for (const t of q.all('SELECT r.*, k.name cat, k.account FROM exp_recurring r LEFT JOIN exp_categories k ON k.id=r.category_id WHERE r.active=1 AND r.amount>0')) {
                    if (!t.account)
                        continue;
                    const dom = Math.min(Math.max(1, +t.dom || 1), lastDom(m));
                    if (d < dom)
                        continue;
                    const dayv = m + '-' + String(dom).padStart(2, '0');
                    const box = t.paid_from === 'petty' ? (q.get('SELECT id FROM exp_boxes WHERE active=1 ORDER BY id LIMIT 1') || {}).id : null;
                    const r = q.run(`INSERT OR IGNORE INTO exp_claims(day,category_id,category,account,amount,paid_from,box_id,vendor,note,recurring_id,period) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, dayv, t.category_id, t.cat, t.account, t.amount, t.paid_from, box, t.vendor || '', (t.name + (t.note ? ' — ' + t.note : '')).slice(0, 300), t.id, m);
                    if (r.changes) {
                        made++;
                        log(null, 'exp.recurring_created', 'expense:' + r.lastInsertRowid, { template: t.name, amount: t.amount, period: m });
                    }
                }
                return made;
            }
            S.runRecurring = runRecurring;
            route('GET', '/api/exp/recurring', 'expenses_approve', () => q.all(`SELECT r.*, k.name category, k.account, (SELECT MAX(period) FROM exp_claims c WHERE c.recurring_id=r.id) last_period FROM exp_recurring r LEFT JOIN exp_categories k ON k.id=r.category_id ORDER BY r.active DESC, r.dom, r.id`));
            route('POST', '/api/exp/recurring', 'expenses_approve', (req, u, b) => {
                const name = String(b.name || '').trim();
                need(name, 'Name is needed');
                need(q.get('SELECT id FROM exp_categories WHERE id=?', +b.category_id), 'Pick a category');
                need(PAY[b.paid_from] && b.paid_from !== 'own', 'Choose how it is paid');
                const dom = Math.round(+b.dom);
                need(dom >= 1 && dom <= 31, 'Day of month must be 1–31');
                const amt = r2(b.amount), active = b.active ? 1 : 0;
                need(!active || amt > 0, 'Enter the amount before turning it on');
                let id = +b.id;
                if (id)
                    q.run('UPDATE exp_recurring SET name=?,category_id=?,amount=?,dom=?,paid_from=?,vendor=?,note=?,active=? WHERE id=?', name, +b.category_id, amt, dom, b.paid_from, String(b.vendor || ''), String(b.note || ''), active, id);
                else
                    id = q.run('INSERT INTO exp_recurring(name,category_id,amount,dom,paid_from,vendor,note,active) VALUES(?,?,?,?,?,?,?,?)', name, +b.category_id, amt, dom, b.paid_from, String(b.vendor || ''), String(b.note || ''), active).lastInsertRowid;
                log(u.id, 'exp.recurring_save', 'exp_recurring:' + id, { name, amount: amt, active });
                return q.get('SELECT * FROM exp_recurring WHERE id=?', id);
            });
            route('DELETE', '/api/exp/recurring/:id', 'expenses_approve', (req, u, b, res, p) => { q.run('DELETE FROM exp_recurring WHERE id=?', +p.id); log(u.id, 'exp.recurring_delete', 'exp_recurring:' + p.id, ''); return { ok: true }; });
            route('POST', '/api/exp/recurring/run', 'expenses_approve', async (req, u, b) => ({ created: await runRecurring(b.day), retried: await retryAll() }));
            /* ---------- postings queue ---------- */
            route('GET', '/api/exp/postings', 'expenses_approve', (req, u, b, res, p, qs) => q.all('SELECT * FROM exp_postings WHERE (? = \'\' OR status=?) ORDER BY id DESC LIMIT 200', qs.status || '', qs.status || ''));
            route('POST', '/api/exp/postings/retry', 'expenses_approve', async () => ({ posted: await retryAll(), left: q.get("SELECT COUNT(*) n FROM exp_postings WHERE status IN ('pending','error')").n }));
            /* ---------- reports ---------- */
            route('GET', '/api/exp/report', 'expenses_approve', (req, u, b, res, p, qs) => {
                const m = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : pkToday().slice(0, 7);
                const W = "c.status!='rejected' AND substr(c.day,1,7)=?";
                const byCategory = q.all(`SELECT k.id, k.name category, k.account, k.budget, COALESCE(SUM(c.amount),0) amount, COUNT(c.id) n FROM exp_categories k LEFT JOIN exp_claims c ON c.category_id=k.id AND ${W}
        GROUP BY k.id HAVING amount>0 OR k.budget>0 ORDER BY amount DESC`, m);
                const byPerson = q.all(`SELECT COALESCE(us.name, CASE WHEN c.recurring_id IS NOT NULL THEN 'Recurring bills' ELSE '—' END) person, COUNT(*) n, SUM(c.amount) amount FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id WHERE ${W} GROUP BY person ORDER BY amount DESC`, m);
                const byVendor = q.all(`SELECT COALESCE(NULLIF(TRIM(c.vendor),''),'(not written)') vendor, COUNT(*) n, SUM(c.amount) amount FROM exp_claims c WHERE ${W} GROUP BY vendor ORDER BY amount DESC LIMIT 30`, m);
                const byPay = q.all(`SELECT paid_from, SUM(amount) amount FROM exp_claims c WHERE ${W} GROUP BY paid_from`, m);
                const trend = [];
                for (let i = 5; i >= 0; i--) {
                    const mm = monthsBack(m, i);
                    const t = q.get(`SELECT COALESCE(SUM(CASE WHEN status='approved' THEN amount END),0) approved, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending FROM exp_claims c WHERE substr(day,1,7)=?`, mm);
                    const old = q.get('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE substr(day,1,7)=?', mm).s;
                    trend.push({ month: mm, approved: r2(t.approved), pending: r2(t.pending), older: r2(old) });
                }
                const top = q.all(CLAIM_SQL + ` WHERE ${W} ORDER BY c.amount DESC LIMIT 10`, m);
                const tot = q.get(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COUNT(*) n FROM exp_claims c WHERE ${W}`, m);
                const budget = q.get('SELECT COALESCE(SUM(budget),0) b FROM exp_categories WHERE active=1').b;
                const budgetSpent = byCategory.filter(c => c.budget > 0).reduce((t, c) => t + c.amount, 0);
                return { month: m, total: r2(tot.total), pending: r2(tot.pending), n: tot.n, budget: r2(budget), budgetSpent: r2(budgetSpent), byCategory, byPerson, byVendor, byPay, trend, top };
            });
            route('GET', '/api/exp/export', 'expenses_approve', (req, u, b, res, p, qs) => {
                const m = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : pkToday().slice(0, 7);
                return q.all(CLAIM_SQL + ' WHERE substr(c.day,1,7)=? ORDER BY c.day, c.id', m).map(c => ({ id: c.id, date: c.day, category: c.category, account: c.account, amount: c.amount, paid_from: PAY[c.paid_from] || c.paid_from,
                    box: c.box || '', shop_vendor: c.vendor, note: c.note, by: c.user || (c.recurring_id ? 'Recurring' : ''), status: c.status, reason: c.reason || '', approved_by: c.approver || '',
                    reimbursed: c.paid_from === 'own' ? (c.reimbursed ? 'yes ' + c.reimbursed_at : 'no') : '', posted: c.post_status || '', receipt: c.receipt ? 'yes' : '' }));
            });
            route('GET', '/api/exp/older', 'expenses_approve', (req, u, b, res, p, qs) => {
                const pg = ctx.page(qs, 100);
                const rows = q.all('SELECT e.*, us.name user FROM expenses e LEFT JOIN users us ON us.id=e.user_id ORDER BY e.day DESC, e.id DESC LIMIT ? OFFSET ?', pg.limit, pg.offset);
                const t = q.get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expenses');
                return { rows, total: t.n, amount: r2(t.s), page: pg.page, pages: Math.ceil(t.n / pg.limit) };
            });
            route('GET', '/api/exp/settings', 'expenses_approve', () => ({ receipt_limit: limit(), card_account: cardAcc(), wait_days: waitDays() }));
            route('POST', '/api/exp/settings', 'expenses_approve', (req, u, b) => {
                if (b.receipt_limit != null) {
                    need(+b.receipt_limit >= 0, 'Receipt limit must be 0 or more');
                    setSetting('expenses_receipt_limit', +b.receipt_limit);
                }
                if (b.card_account) {
                    need(['Meezan (SB)', 'Cash', 'Meta Ads Payable', 'Accrued Expenses'].includes(b.card_account), 'Unknown account');
                    setSetting('expenses_card_account', b.card_account);
                }
                if (b.wait_days != null)
                    setSetting('expenses_wait_days', Math.max(1, +b.wait_days || 2));
                log(u.id, 'settings.save', 'expenses', b);
                return { receipt_limit: limit(), card_account: cardAcc(), wait_days: waitDays() };
            });
            /* ---------- service for the owner home + other modules ---------- */
            S.boxes = () => q.all('SELECT * FROM exp_boxes WHERE active=1').map(boxRow);
            ctx.services.expenses = {
                summary() {
                    const p = q.get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims WHERE status='pending'");
                    const pet = q.get('SELECT COALESCE(SUM(m.amount),0) s FROM exp_box_moves m JOIN exp_boxes b ON b.id=m.box_id WHERE b.active=1').s;
                    const mt = q.get("SELECT COALESCE(SUM(amount),0) s FROM exp_claims WHERE status!='rejected' AND substr(day,1,7)=?", pkToday().slice(0, 7)).s;
                    return { pending: p.n, pendingAmount: r2(p.s), pettyBalance: r2(pet), monthTotal: r2(mt) };
                },
                runRecurring, retryPostings: retryAll,
                monthByAccount: m => q.all("SELECT account, SUM(amount) amount FROM exp_claims WHERE status='approved' AND substr(day,1,7)=? GROUP BY account", m || pkToday().slice(0, 7)),
            };
        },
        jobs: [{ name: 'daily', every: 60, offset: 7, run: async (ctx) => { if (!ctx._exp)
                    return; await ctx._exp.runRecurring(); await ctx._exp.retryAll(); } }],
        counts(u, ctx) {
            if (!ctx.can(u, 'expenses_approve'))
                return {};
            return { approvals: ctx.q.get("SELECT COUNT(*) n FROM exp_claims WHERE status='pending'").n };
        },
        alerts(u, ctx) {
            const { q, can, setting } = ctx, out = [], appr = can(u, 'expenses_approve');
            if (appr) {
                const d = Math.max(1, +setting('expenses_wait_days', 2));
                const w = q.get(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims WHERE status='pending' AND created_at < datetime('now', ?)`, `-${d} days`);
                if (w.n)
                    out.push({ level: 'warn', text: `${w.n} expense claim${w.n > 1 ? 's' : ''} (Rs ${Math.round(w.s).toLocaleString('en-PK')}) waiting more than ${d} days for approval`, href: '#/approvals' });
                const c = q.all("SELECT k.*, b.name box FROM exp_counts k JOIN exp_boxes b ON b.id=k.box_id WHERE k.status='pending'");
                for (const k of c)
                    out.push({ level: Math.abs(k.variance) >= 1000 ? 'bad' : 'warn', text: `${k.box} petty cash count is ${k.variance < 0 ? 'short' : 'over'} by Rs ${Math.abs(Math.round(k.variance)).toLocaleString('en-PK')}`, href: '#/pettycash/' + k.box_id });
                if (ctx.services.accounts && ctx.services.accounts.post) {
                    const e = q.get("SELECT COUNT(*) n FROM exp_postings WHERE status='error'").n;
                    if (e)
                        out.push({ level: 'info', text: `${e} expense entr${e > 1 ? 'ies' : 'y'} could not be posted to accounts`, href: '#/approvals/setup' });
                }
            }
            const mine = q.all('SELECT id FROM exp_boxes WHERE custodian=? AND active=1', u.id).map(b => b.id);
            if (ctx._exp && (appr || mine.length))
                for (const b of ctx._exp.boxes())
                    if ((appr || mine.includes(b.id)) && b.low_now && q.get('SELECT 1 FROM exp_box_moves WHERE box_id=? LIMIT 1', b.id))
                        out.push({ level: 'warn', text: `${b.name} petty cash is low: Rs ${Math.round(b.balance).toLocaleString('en-PK')} left`, href: appr ? '#/pettycash/' + b.id : '#/pettybox/' + b.id });
            const rej = q.get("SELECT COUNT(*) n FROM exp_claims WHERE user_id=? AND status='rejected' AND approved_at > datetime('now','-3 days')", u.id).n;
            if (rej)
                out.push({ level: 'info', text: `${rej} of your expense claims ${rej > 1 ? 'were' : 'was'} rejected — see the reason`, href: '#/expenses' });
            return out;
        },
        activity: {
            'exp.submit': 'Submitted expense', 'exp.edit': 'Edited expense', 'exp.delete': 'Deleted expense', 'exp.approve': 'Approved expense', 'exp.reject': 'Rejected expense',
            'exp.reopen': 'Reopened expense', 'exp.reimburse': 'Reimbursed expense', 'exp.topup': 'Topped up petty cash', 'exp.count': 'Counted petty cash',
            'exp.count_approve': 'Approved cash count difference', 'exp.count_reject': 'Rejected cash count', 'exp.category_save': 'Saved expense category', 'exp.box_save': 'Saved cash box',
            'exp.recurring_save': 'Saved recurring expense', 'exp.recurring_delete': 'Deleted recurring expense', 'exp.recurring_created': 'Recurring expense created',
        },
    };
};