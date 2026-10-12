    // Accounts: chart of accounts, double-entry journal, vouchers, automatic postings from orders, statements and month close.
    'use strict';
    // [code, name, type, group]  — names are the contract other modules post to (do not rename)
    const SEED = [
        ['1001', 'Cash', 'asset', 'cash'], ['1002', 'Petty Cash', 'asset', 'cash'], ['1010', 'Meezan (SB)', 'asset', 'cash'], ['1020', 'PayFast', 'asset', 'cash'],
        ['1100', 'Post Ex', 'asset', 'receivable'], ['1101', 'Blue ex', 'asset', 'receivable'], ['1102', 'Leopards', 'asset', 'receivable'],
        ['1103', 'TCS', 'asset', 'receivable'], ['1104', 'Rider Cash', 'asset', 'receivable'],
        ['1200', 'Listed Inventory', 'asset', 'inventory'], ['1201', 'Unlisted Inventory', 'asset', 'inventory'], ['1210', 'Purchases', 'asset', 'inventory'],
        ['1300', 'Employees Advance', 'asset', 'current'], ['1310', 'Claims (P)', 'asset', 'current'], ['1320', 'Prepaid Rent', 'asset', 'current'], ['1330', 'Advance Income Tax', 'asset', 'current'],
        ['1500', 'Office Deposit', 'asset', 'non-current'], ['1501', 'Outlet Deposit', 'asset', 'non-current'], ['1510', 'Office Furniture', 'asset', 'non-current'], ['1511', 'Outlet Furniture', 'asset', 'non-current'],
        ['1520', 'Office Equipments', 'asset', 'non-current'], ['1521', 'Outlet Equipments', 'asset', 'non-current'],
        ['2000', 'Accounts Payable', 'liability', 'current'], ['2010', 'Salaries Payable', 'liability', 'current'], ['2020', 'Store Credit', 'liability', 'current'], ['2030', 'Customer Advances', 'liability', 'current'],
        ['2040', 'Meta Ads Payable', 'liability', 'current'], ['2050', 'Accrued Expenses', 'liability', 'current'],
        ['3000', 'Capital', 'equity', 'capital'], ['3010', 'Drawings 1', 'equity', 'drawings'], ['3011', 'Drawings 2', 'equity', 'drawings'],
        ['4000', 'Sales', 'income', 'sales'], ['4100', 'Sales Return', 'contra_income', 'sales'], ['4110', 'Discount Allowed', 'contra_income', 'sales'],
        ['4500', 'Discount Received', 'income', 'other'], ['4510', 'Other Income', 'income', 'other'],
        ['5000', 'Cost of Goods Sold', 'expense', 'cogs'], ['5010', 'Inventory Damage', 'expense', 'cogs'],
        ['6000', 'Shipping Exp', 'expense', 'selling'], ['6010', 'Packaging', 'expense', 'selling'], ['6020', 'Social Media Marketing', 'expense', 'selling'], ['6030', 'Other Marketing', 'expense', 'selling'],
        ['6040', 'Shopify Charges', 'expense', 'selling'], ['6050', 'Commission', 'expense', 'selling'], ['6060', 'Incentives/Gifts', 'expense', 'selling'], ['6070', 'QC Expenses', 'expense', 'selling'],
        ['6080', 'GST', 'expense', 'selling'], ['6090', 'Sales Tax', 'expense', 'selling'],
        ['7000', 'Salary Exp', 'expense', 'admin'], ['7010', 'Office Rent', 'expense', 'admin'], ['7020', 'Outlet Rent', 'expense', 'admin'], ['7030', 'Outlet Expenses', 'expense', 'admin'],
        ['7040', 'Utility Expenses', 'expense', 'admin'], ['7050', 'Internet & Mobile Package', 'expense', 'admin'], ['7060', 'Food Allowance', 'expense', 'admin'], ['7070', 'Grocery & Pantry', 'expense', 'admin'],
        ['7080', 'Conveyance', 'expense', 'admin'], ['7090', 'Repair & Maintenance', 'expense', 'admin'], ['7100', 'I.T Expenses', 'expense', 'admin'], ['7110', 'Apps & Subscription Charges', 'expense', 'admin'],
        ['7120', 'Bad Debts', 'expense', 'admin'], ['7130', 'Bank Charges', 'expense', 'admin'], ['7140', 'Donation', 'expense', 'admin'], ['7150', 'Entertainment', 'expense', 'admin'],
        ['7160', 'Legal Fees', 'expense', 'admin'], ['7170', 'Miscellenious Exp', 'expense', 'admin'], ['7180', 'Depreciation', 'expense', 'admin'],
        ['8000', 'Income Tax', 'expense', 'tax'],
    ];
    const TYPES = { asset: 'BS', liability: 'BS', equity: 'BS', income: 'IS', contra_income: 'IS', expense: 'IS' };
    const GROUPS = {
        asset: [['cash', 'Cash & bank'], ['receivable', 'Courier receivables'], ['inventory', 'Inventory'], ['current', 'Other current assets'], ['non-current', 'Fixed assets & deposits']],
        liability: [['current', 'Current liabilities'], ['non-current', 'Long-term liabilities']],
        equity: [['capital', 'Capital'], ['drawings', 'Drawings']],
        income: [['sales', 'Sales'], ['other', 'Other income']], contra_income: [['sales', 'Less: returns & discounts']],
        expense: [['cogs', 'Cost of sales'], ['selling', 'Selling & delivery'], ['admin', 'Admin & general'], ['tax', 'Tax']],
    };
    const KINDS = { JV: 'Journal voucher', PV: 'Payment voucher', RV: 'Receipt voucher', CV: 'Contra voucher' };
    const DEF_CFG = { recognise: 'dispatched', bank: 'Meezan (SB)', courier_ar: 'Post Ex', tcs_ar: 'TCS', rider_ar: 'Rider Cash', sales: 'Sales', discount: 'Discount Allowed', returns: 'Sales Return', cogs: 'Cost of Goods Sold',
        inventory: 'Listed Inventory', unlisted: 'Unlisted Inventory', shipping: 'Shipping Exp', courier_tax: 'GST', purchases: 'Purchases', payable: 'Accounts Payable', auto: true, fy_month: 7 };
    const AUTO_SRC = `(j.source LIKE 'auto-%' OR j.source='lot')`;
    let ctx, q, setting;
    const r2 = v => Math.round((+v || 0) * 100) / 100;
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const monthEnd = m => addDays(addDays(m + '-01', 32).slice(0, 7) + '-01', -1);
    const fmt = v => 'Rs ' + Math.round(+v || 0).toLocaleString('en-PK');
    const bad = (msg, code = 400) => new ctx.HttpError(code, msg);
    const cfg = () => (Object.assign(Object.assign({}, DEF_CFG), (setting('accounts_cfg', {}) || {})));
    const lockDate = () => setting('accounts_lock_date', '') || '';
    const startDate = () => setting('accounts_start', '') || '';
    const PKD = col => `date(${col},'+5 hours')`;
    // cost of one sold pair (see autoEntries): products.cost from Shopify, else the cost saved when it was listed
    // every listed pair with its cost and listing day (PK): ERP lister rows, plus Shopify products that did not come from the lister
    const LISTED_SQL = `SELECT sku, lot, cost, date(at,'+5 hours') d FROM listings WHERE cost>0 AND at IS NOT NULL
  UNION ALL SELECT p.sku, p.lot, p.cost, date(p.created_at,'+5 hours') d FROM products p WHERE p.cost>0 AND p.created_at IS NOT NULL AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM listings WHERE sku IS NOT NULL))`;
    const PAIR_COST = `COALESCE(NULLIF(p.cost,0), NULLIF(ls.cost,0))`, PAIR_JOIN = `LEFT JOIN products p ON p.variant_id=i.variant_id LEFT JOIN listings ls ON ls.sku=i.sku`;
    // which courier holds the order's COD: PostEx (and any other / unknown courier, as before), TCS, or the own Karachi rider
    const CK = `CASE WHEN lower(COALESCE(o.courier,'')) LIKE 'tcs%' THEN 'TCS' WHEN lower(COALESCE(o.courier,''))='rider' THEN 'Rider' ELSE 'PostEx' END`;
    const CK_NAME = { PostEx: 'PostEx', TCS: 'TCS', Rider: 'the rider' };
    const ckAcct = (c, k) => k === 'TCS' ? c.tcs_ar : k === 'Rider' ? c.rider_ar : c.courier_ar;
    const ckSid = (d, k) => k === 'PostEx' ? d : d + ':' + k; // PostEx keeps the old per-day source_id
    // Lots bought on a Purchasing purchase order are posted by the purchasing module instead ('pur-lot', once, when the lot is received;
    // the supplier bill then finalises that same entry), so the automatic 'lot' entry skips them — one purchase entry per lot.
    const hasTable = t => { try {
        return !!q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
    }
    catch (_a) {
        return false;
    } };
    const notPO = col => hasTable('pur_pos') ? ` AND ${col} NOT IN (SELECT lot_name FROM pur_pos WHERE lot_name IS NOT NULL AND status NOT IN ('cancelled'))` : '';
    const hasCol = (t, c) => { try {
        return q.all(`PRAGMA table_info(${t})`).some(x => x.name === c);
    }
    catch (_a) {
        return false;
    } };
    // savepoints nest safely even when a caller already opened a transaction
    let spN = 0;
    function tx(fn) { const sp = 'acc' + (++spN); ctx.db.exec('SAVEPOINT ' + sp); try {
        const r = fn();
        ctx.db.exec('RELEASE ' + sp);
        return r;
    }
    catch (e) {
        ctx.db.exec('ROLLBACK TO ' + sp);
        ctx.db.exec('RELEASE ' + sp);
        throw e;
    } }
    /* ---------------- chart ---------------- */
    function acct(n) {
        if (n && typeof n === 'object')
            n = n.name;
        const s = String(n == null ? '' : n).trim();
        if (!s)
            return null;
        return q.get('SELECT * FROM acc_accounts WHERE name=? OR code=?', s, s) || q.get('SELECT * FROM acc_accounts WHERE lower(name)=lower(?)', s);
    }
    function mustAcct(n) { const a = acct(n); if (!a)
        throw bad(`Unknown account "${n}"`); return a; }
    const accountId = n => { const a = acct(n); return a ? a.id : null; };
    const natural = (a, dr, cr) => ['asset', 'expense', 'contra_income'].includes(a.type) ? dr - cr : cr - dr;
    /* ---------------- journal engine ---------------- */
    function checkLock(date) { const L = lockDate(); if (L && date <= L)
        throw bad(`The books are closed up to ${L}. Reopen that month first, or use a later date.`); }
    function nextRef(kind) {
        const r = q.get(`SELECT MAX(CAST(substr(ref,4) AS INTEGER)) n FROM acc_journals WHERE ref LIKE ?`, kind + '-%');
        return kind + '-' + String(((r && r.n) || 0) + 1).padStart(4, '0');
    }
    function cleanLines(lines) {
        const out = [];
        for (const l of lines || []) {
            const debit = r2(l.debit), credit = r2(l.credit);
            if (!debit && !credit)
                continue;
            if (debit < 0 || credit < 0)
                throw bad('Amounts cannot be negative — swap debit and credit instead');
            if (debit && credit)
                throw bad('A line can have a debit or a credit, not both');
            const a = mustAcct(l.account);
            if (!a.active)
                throw bad(`Account "${a.name}" is deactivated`);
            out.push({ a, debit, credit, party: l.party ? String(l.party).trim().slice(0, 80) || null : null, memo: l.memo ? String(l.memo).slice(0, 200) : null });
        }
        if (!out.length)
            throw bad('Enter at least one amount');
        const dr = r2(out.reduce((s, l) => s + l.debit, 0)), cr = r2(out.reduce((s, l) => s + l.credit, 0));
        if (Math.abs(dr - cr) > 0.009)
            throw bad(`Debits (${fmt(dr)}) and credits (${fmt(cr)}) do not match — difference ${fmt(Math.abs(dr - cr))}`);
        return { lines: out, total: dr };
    }
    function postRaw(j, userId) {
        if (!isDate(j.date))
            throw bad('Date must be YYYY-MM-DD');
        const source = String(j.source || 'manual'), sid = String(j.source_id == null ? '' : j.source_id);
        if (!sid)
            throw bad('source_id is needed');
        const { lines, total } = cleanLines(j.lines);
        checkLock(j.date);
        const ex = q.get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', source, sid);
        const meta = j.meta ? JSON.stringify(j.meta) : null;
        let id;
        if (ex) {
            checkLock(ex.date);
            q.run('DELETE FROM acc_lines WHERE journal_id=?', ex.id);
            q.run(`UPDATE acc_journals SET date=?, memo=?, ref=?, kind=?, file_id=?, user_id=?, amount=?, meta=?, voided=0, void_reason=NULL, voided_by=NULL, voided_at=NULL, updated_at=datetime('now') WHERE id=?`, j.date, j.memo || '', j.ref || ex.ref, j.kind || ex.kind, j.file_id !== undefined ? j.file_id || null : ex.file_id, userId || ex.user_id, total, meta, ex.id);
            id = ex.id;
        }
        else {
            const ref = j.ref || (KINDS[j.kind] ? nextRef(j.kind) : null);
            id = q.run('INSERT INTO acc_journals(date,memo,source,source_id,ref,kind,file_id,user_id,amount,meta) VALUES(?,?,?,?,?,?,?,?,?,?)', j.date, j.memo || '', source, sid, ref, j.kind || null, j.file_id || null, userId || null, total, meta).lastInsertRowid;
        }
        const ins = ctx.db.prepare('INSERT INTO acc_lines(journal_id,account_id,debit,credit,party,memo) VALUES(?,?,?,?,?,?)');
        for (const l of lines)
            ins.run(id, l.a.id, l.debit, l.credit, l.party, l.memo);
        return Number(id);
    }
    const post = (j, userId) => tx(() => postRaw(j, userId));
    function voidJ(source, sid, userId, reason) {
        const ex = q.get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', String(source), String(sid));
        if (!ex || ex.voided)
            return false;
        checkLock(ex.date);
        q.run(`UPDATE acc_journals SET voided=1, void_reason=?, voided_by=?, voided_at=datetime('now') WHERE id=?`, reason || null, userId || null, ex.id);
        return true;
    }
    function removeJ(id) { q.run('DELETE FROM acc_lines WHERE journal_id=?', id); q.run('DELETE FROM acc_journals WHERE id=?', id); }
    function balance(n, upTo, party) {
        const a = mustAcct(n), w = ['l.account_id=?', 'j.voided=0'], args = [a.id];
        if (upTo) {
            w.push('j.date<=?');
            args.push(upTo);
        }
        if (party) {
            w.push('l.party=?');
            args.push(party);
        }
        return r2(q.get(`SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE ${w.join(' AND ')}`, ...args).b);
    }
    // every account with debit/credit sums for a date range
    function sums(from, to) {
        const w = ['j.voided=0'], a = [];
        if (from) {
            w.push('j.date>=?');
            a.push(from);
        }
        if (to) {
            w.push('j.date<=?');
            a.push(to);
        }
        return q.all(`SELECT a.*, COALESCE(s.dr,0) dr, COALESCE(s.cr,0) cr FROM acc_accounts a LEFT JOIN (SELECT l.account_id, SUM(l.debit) dr, SUM(l.credit) cr FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id
    WHERE ${w.join(' AND ')} GROUP BY l.account_id) s ON s.account_id=a.id ORDER BY a.code`, ...a).map(x => (Object.assign(Object.assign({}, x), { dr: r2(x.dr), cr: r2(x.cr), bal: r2(x.dr - x.cr), amt: r2(natural(x, x.dr, x.cr)) })));
    }
    /* ---------------- statements ---------------- */
    const grpLabel = (type, g) => ((GROUPS[type] || []).find(x => x[0] === g) || [g, g || 'Other'])[1];
    function pnl(from, to) {
        const rows = sums(from, to).filter(a => a.statement === 'IS'), sec = (title, list, sign = 1) => ({ title, rows: list.filter(a => a.amt || a.dr || a.cr).map(a => ({ id: a.id, code: a.code, name: a.name, amount: r2(sign * a.amt) })), total: r2(list.reduce((s, a) => s + sign * a.amt, 0)) });
        const sales = sec('Sales', rows.filter(a => a.type === 'income' && a.grp === 'sales')), less = sec('Less: returns & discounts', rows.filter(a => a.type === 'contra_income'), -1);
        const netSales = r2(sales.total + less.total);
        const exp = g => rows.filter(a => a.type === 'expense' && (g ? a.grp === g : !['cogs', 'selling', 'tax'].includes(a.grp)));
        const cogs = sec('Cost of sales', exp('cogs'), -1), gross = r2(netSales + cogs.total);
        const selling = sec('Selling & delivery', exp('selling'), -1), admin = sec('Admin & general', exp(null), -1);
        const operating = r2(gross + selling.total + admin.total);
        const other = sec('Other income', rows.filter(a => a.type === 'income' && a.grp !== 'sales'));
        const beforeTax = r2(operating + other.total), tax = sec('Tax', exp('tax'), -1), net = r2(beforeTax + tax.total);
        return { from, to, sales, less, netSales, cogs, gross, selling, admin, opex: r2(-(selling.total + admin.total)), operating, other, beforeTax, tax, net };
    }
    function prevRange(from, to) {
        if (from.slice(8) === '01' && to === monthEnd(from.slice(0, 7))) {
            const pm = addDays(from, -1).slice(0, 7);
            return [pm + '-01', monthEnd(pm)];
        }
        const n = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
        return [addDays(from, -n), addDays(from, -1)];
    }
    function fyStart(date) { const m = +cfg().fy_month || 7, y = +date.slice(0, 4), mm = +date.slice(5, 7); return `${mm >= m ? y : y - 1}-${String(m).padStart(2, '0')}-01`; }
    function bs(date) {
        const rows = sums(null, date), show = a => a.dr || a.cr;
        const part = type => (GROUPS[type] || []).map(([g, t]) => ({ title: t, rows: rows.filter(a => a.type === type && (a.grp === g || (g === GROUPS[type][0][0] && !GROUPS[type].some(x => x[0] === a.grp)))).filter(show).map(a => ({ id: a.id, code: a.code, name: a.name, amount: a.amt })) }))
            .map(s => (Object.assign(Object.assign({}, s), { total: r2(s.rows.reduce((x, r) => x + r.amount, 0)) }))).filter(s => s.rows.length);
        const assets = part('asset'), liabilities = part('liability'), eq = part('equity');
        const fy = fyStart(date), cy = pnl(fy, date).net;
        const allIS = r2(rows.filter(a => a.statement === 'IS').reduce((s, a) => s + (a.cr - a.dr), 0));
        const retained = r2(allIS - cy);
        const tA = r2(assets.reduce((s, x) => s + x.total, 0)), tL = r2(liabilities.reduce((s, x) => s + x.total, 0)), tE = r2(eq.reduce((s, x) => s + x.total, 0) + retained + cy);
        return { date, fyStart: fy, assets, liabilities, equity: eq, retained, currentProfit: cy, totalAssets: tA, totalLiabilities: tL, totalEquity: tE, diff: r2(tA - tL - tE) };
    }
    function trial(date, from) {
        const rows = sums(from || null, date).filter(a => a.dr || a.cr).map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, debit: a.bal > 0 ? a.bal : 0, credit: a.bal < 0 ? -a.bal : 0 }));
        const dr = r2(rows.reduce((s, r) => s + r.debit, 0)), cr = r2(rows.reduce((s, r) => s + r.credit, 0));
        return { date, rows, debit: dr, credit: cr, diff: r2(dr - cr) };
    }
    function ledger(n, from, to, party) {
        const a = mustAcct(n), w = ['l.account_id=?', 'j.voided=0'], args = [a.id];
        if (party) {
            w.push('l.party=?');
            args.push(party);
        }
        const opening = r2(q.get(`SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE ${w.join(' AND ')} AND j.date<?`, ...args, from || '0000').b);
        if (from) {
            w.push('j.date>=?');
            args.push(from);
        }
        if (to) {
            w.push('j.date<=?');
            args.push(to);
        }
        const rows = q.all(`SELECT l.id, j.id journal_id, j.date, j.ref, j.memo, j.source, j.source_id, l.debit, l.credit, l.party, l.memo lmemo,
     (SELECT group_concat(a2.name, ', ') FROM acc_lines l2 JOIN acc_accounts a2 ON a2.id=l2.account_id WHERE l2.journal_id=j.id AND l2.account_id<>l.account_id) other
     FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE ${w.join(' AND ')} ORDER BY j.date, j.id, l.id LIMIT 5000`, ...args);
        let run = opening;
        for (const r of rows) {
            run = r2(run + r.debit - r.credit);
            r.balance = run;
        }
        return { account: a, from, to, party: party || null, opening, rows, debit: r2(rows.reduce((s, r) => s + r.debit, 0)), credit: r2(rows.reduce((s, r) => s + r.credit, 0)), closing: run };
    }
    function parties(prefix, accountName, upTo) {
        const w = ['j.voided=0', 'l.party IS NOT NULL'], a = [];
        if (prefix) {
            w.push('l.party LIKE ?');
            a.push(prefix + '%');
        }
        if (accountName) {
            w.push('l.account_id=?');
            a.push(mustAcct(accountName).id);
        }
        if (upTo) {
            w.push('j.date<=?');
            a.push(upTo);
        }
        return q.all(`SELECT l.party, ac.name account, ac.type, SUM(l.debit) dr, SUM(l.credit) cr, MAX(j.date) last FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id JOIN acc_accounts ac ON ac.id=l.account_id
    WHERE ${w.join(' AND ')} GROUP BY l.party, ac.id ORDER BY l.party`, ...a).map(r => (Object.assign(Object.assign({}, r), { name: partyName(r.party), balance: r2(r.dr - r.cr), amount: r2(natural(r, r.dr, r.cr)) })));
    }
    // readable name for a party code: employee:<hr employee id>, employee:u<user id> (staff not set up in HR), vendor:<name>, customer:<phone>, courier:<name>, lot:<name>
    function partyName(p) {
        const m = /^(\w+):(.*)$/.exec(String(p || ''));
        if (!m)
            return p;
        const [, k, v] = m, one = (sql, ...a) => { try {
            const r = q.get(sql, ...a);
            return r && r.name;
        }
        catch (_a) {
            return null;
        } };
        if (k === 'employee')
            return (/^u\d+$/.test(v) ? one('SELECT name FROM users WHERE id=?', +v.slice(1)) : one('SELECT name FROM hr_employees WHERE id=?', +v)) || v;
        if (k === 'customer')
            return one('SELECT name FROM customers WHERE phone=?', v) || v;
        if (k === 'lot')
            return 'Lot ' + v;
        return v;
    }
    /* ---------------- automatic postings ---------------- */
    function autoEntries(from, to) {
        const c = cfg(), fee = +setting('courier_fee', 250), rfee = +setting('return_fee', 150), cpct = +setting('cost_pct', 35);
        const rec = c.recognise === 'delivered' ? 'o.delivered_at' : 'o.dispatched_at', recWord = c.recognise === 'delivered' ? 'delivered' : 'dispatched';
        const live = `o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','courier_cancelled','cs_cancelled')`;
        const RET = `o.status IN ('returning','returned','return_received')`, retAt = `COALESCE(o.returned_at,o.return_received_at)`;
        const out = [], byDay = {}, add = (source, date, memo, lines, meta, sid) => { lines = flip(lines); if (lines.length)
            out.push({ source, source_id: sid || date, date, memo, lines, meta }); };
        const D = (sql, ...a) => q.all(sql, ...a, from, to);
        const AR = c.courier_ar, px = 'courier:PostEx';
        const tfee = +setting('couriers_tcs_fee', 250), cfee = hasCol('orders', 'courier_fee') ? 'o.courier_fee' : 'NULL', cpaid = hasCol('orders', 'courier_paid') ? 'o.courier_paid' : 'NULL';
        const party = k => 'courier:' + k;
        for (const r of D(`SELECT ${PKD(rec)} d, ${CK} k, COUNT(*) n, SUM(o.total) total, SUM(COALESCE(o.discount,0)) disc FROM orders o WHERE ${rec} IS NOT NULL AND ${live} AND ${PKD(rec)} BETWEEN ? AND ? GROUP BY d, k`))
            add('auto-sales', r.d, `Sales — ${r.n} orders ${recWord}` + (r.k !== 'PostEx' ? ` (${r.k})` : ''), [{ account: ckAcct(c, r.k), debit: r.total, party: party(r.k) }, { account: c.discount, debit: r.disc }, { account: c.sales, credit: r2(r.total + r.disc) }], { orders: r.n, gross: r2(r.total + r.disc), discount: r2(r.disc), courier: r.k }, ckSid(r.d, r.k));
        // cost of a sold pair: Shopify cost, else the cost the lister saved (same number the pair moved into Listed Inventory at), else an estimate
        const costSql = (dateCol, where, byK) => `SELECT ${PKD(dateCol)} d, ${byK ? CK : "'PostEx'"} k, SUM(i.qty) pairs, SUM(COALESCE(${PAIR_COST}, i.price*${+cpct}/100.0)*i.qty) cost, SUM(CASE WHEN ${PAIR_COST} IS NULL THEN i.qty ELSE 0 END) est
    FROM order_items i JOIN orders o ON o.id=i.order_id ${PAIR_JOIN} WHERE ${where} AND ${PKD(dateCol)} BETWEEN ? AND ? GROUP BY d, k`;
        for (const r of D(costSql(rec, `${rec} IS NOT NULL AND ${live}`)))
            add('auto-cogs', r.d, `Cost of ${r.pairs} pairs ${recWord}` + (r.est ? ` (${r.est} estimated at ${cpct}% of price)` : ''), [{ account: c.cogs, debit: r.cost }, { account: c.inventory, credit: r.cost }], { pairs: r.pairs, estimated: r.est });
        const retW = `${retAt} IS NOT NULL AND ${RET} AND ${rec} IS NOT NULL AND o.cancelled_at IS NULL`;
        const restock = Object.fromEntries(D(costSql(retAt, retW, true)).map(r => [r.d + '|' + r.k, r]));
        for (const r of D(`SELECT ${PKD(retAt)} d, ${CK} k, COUNT(*) n, SUM(o.total) total, SUM(COALESCE(o.discount,0)) disc FROM orders o WHERE ${retW} AND ${PKD(retAt)} BETWEEN ? AND ? GROUP BY d, k`)) {
            const rs = restock[r.d + '|' + r.k] || { cost: 0, pairs: 0 };
            add('auto-returns', r.d, `Returns — ${r.n} parcels back from ${CK_NAME[r.k]}, ${rs.pairs || 0} pairs restocked at cost`, [{ account: c.returns, debit: r2(r.total + r.disc) }, { account: c.discount, credit: r.disc }, { account: ckAcct(c, r.k), credit: r.total, party: party(r.k) },
                { account: c.inventory, debit: rs.cost }, { account: c.cogs, credit: rs.cost }], { parcels: r.n, pairs: rs.pairs || 0, courier: r.k }, ckSid(r.d, r.k));
        }
        const shipW = `o.dispatched_at IS NOT NULL AND o.tracking IS NOT NULL AND o.cancelled_at IS NULL AND o.status<>'courier_cancelled'`;
        for (const r of D(`SELECT ${PKD('o.dispatched_at')} d, COUNT(*) n, SUM(COALESCE(o.px_fee,?)) fee, SUM(COALESCE(o.px_tax,0)) tax, SUM(o.px_fee IS NULL) est FROM orders o WHERE ${shipW} AND ${CK}='PostEx' AND ${PKD('o.dispatched_at')} BETWEEN ? AND ? GROUP BY d`, fee))
            (byDay[r.d] = byDay[r.d] || { fwd: null, rev: null }).fwd = r;
        for (const r of D(`SELECT ${PKD(retAt)} d, COUNT(*) n, SUM(COALESCE(o.px_rev_fee,?)) fee, SUM(COALESCE(o.px_rev_tax,0)) tax, SUM(o.px_rev_fee IS NULL) est FROM orders o WHERE ${shipW} AND ${CK}='PostEx' AND ${retAt} IS NOT NULL AND ${RET} AND ${PKD(retAt)} BETWEEN ? AND ? GROUP BY d`, rfee))
            (byDay[r.d] = byDay[r.d] || { fwd: null, rev: null }).rev = r;
        for (const [d, x] of Object.entries(byDay)) {
            const f = x.fwd || { n: 0, fee: 0, tax: 0, est: 0 }, rv = x.rev || { n: 0, fee: 0, tax: 0, est: 0 }, est = f.est + rv.est;
            add('auto-courier', d, `PostEx charges — ${f.n} dispatched, ${rv.n} returned` + (est ? ` (${est} estimated: Rs ${fee} delivery / Rs ${rfee} return)` : ''), [{ account: c.shipping, debit: r2(f.fee + rv.fee) }, { account: c.courier_tax, debit: r2(f.tax + rv.tax) }, { account: AR, credit: r2(f.fee + rv.fee + f.tax + rv.tax), party: px }], { dispatched: f.n, returned: rv.n, estimated: est });
        }
        // TCS delivery charges (from TCS payment data; estimated until TCS reports them), accrued the day the parcel is booked: Dr Shipping Exp / Cr TCS
        for (const r of D(`SELECT ${PKD('o.dispatched_at')} d, COUNT(*) n, SUM(COALESCE(${cfee},?)) fee, SUM(${cfee} IS NULL) est FROM orders o WHERE ${shipW} AND ${CK}='TCS' AND ${PKD('o.dispatched_at')} BETWEEN ? AND ? GROUP BY d`, tfee))
            add('auto-courier', r.d, `TCS charges — ${r.n} parcels booked` + (r.est ? ` (${r.est} estimated at Rs ${tfee})` : ''), [{ account: c.shipping, debit: r.fee }, { account: c.tcs_ar, credit: r.fee, party: party('TCS') }], { dispatched: r.n, estimated: r.est, courier: 'TCS' }, ckSid(r.d, 'TCS'));
        // COD payments: PostEx and TCS pay into the bank (the own rider's cash is posted when the office counts it — see the couriers module)
        const setAt = `COALESCE(o.settled_at,o.delivered_at)`;
        for (const r of D(`SELECT ${PKD(setAt)} d, COUNT(*) n, SUM(COALESCE(o.cod,o.total)-COALESCE(o.px_fee,?)-COALESCE(o.px_tax,0)) net, SUM(o.settled_at IS NULL) nodate FROM orders o WHERE o.settled=1 AND ${CK}='PostEx' AND ${setAt} IS NOT NULL AND ${PKD(setAt)} BETWEEN ? AND ? GROUP BY d`, fee))
            add('auto-settle', r.d, `PostEx COD payment — ${r.n} parcels` + (r.nodate ? ` (${r.nodate} without a payment date, delivery date used)` : ''), [{ account: c.bank, debit: r.net }, { account: AR, credit: r.net, party: px }], { parcels: r.n });
        for (const r of D(`SELECT ${PKD(setAt)} d, COUNT(*) n, SUM(COALESCE(${cpaid}, COALESCE(o.cod,o.total)-COALESCE(${cfee},?))) net FROM orders o WHERE o.settled=1 AND ${CK}='TCS' AND ${setAt} IS NOT NULL AND ${PKD(setAt)} BETWEEN ? AND ? GROUP BY d`, tfee))
            add('auto-settle', r.d, `TCS COD payment — ${r.n} parcels`, [{ account: c.bank, debit: r.net }, { account: c.tcs_ar, credit: r.net, party: party('TCS') }], { parcels: r.n, courier: 'TCS' }, ckSid(r.d, 'TCS'));
        // lots bought on credit: Dr Purchases / Cr Accounts Payable (supplier). Extra lot costs (transport, cleaning) are part of the pairs' cost:
        // they go into Purchases too and wait in Accrued Expenses until paid (pay them with a voucher Dr Accrued Expenses, party lot:<name>).
        for (const l of D(`SELECT name, vendor, bought_on, cost, pieces, COALESCE(extra,0) extra FROM lots WHERE cost>0${notPO('name')} AND bought_on BETWEEN ? AND ?`))
            out.push({ source: 'lot', source_id: l.name, date: l.bought_on, memo: `Lot ${l.name} bought from ${l.vendor || 'vendor'}` + (l.pieces ? ` (${l.pieces} pairs)` : '') + (l.extra > 0 ? ` + Rs ${num(l.extra)} extra costs` : ''),
                lines: flip([{ account: c.purchases, debit: r2(l.cost + l.extra) }, { account: c.payable, credit: l.cost, party: 'vendor:' + (l.vendor || 'Unknown') }, { account: 'Accrued Expenses', credit: l.extra, party: 'lot:' + l.name }]), meta: { pieces: l.pieces } });
        // pairs listed: their cost moves from Unlisted to Listed Inventory (COGS later takes it out of Listed Inventory)
        // (pairs listed with the ERP lister: listings.cost on the day saved; pairs put on Shopify directly: products.cost on the day the product was created — one pair per variant)
        for (const r of D(`SELECT d, COUNT(*) n, SUM(cost) cost FROM (${LISTED_SQL}) WHERE d BETWEEN ? AND ? GROUP BY d`))
            add('auto-listing', r.d, `Pairs listed — ${r.n} pairs moved to Listed Inventory at cost`, [{ account: c.inventory, debit: r.cost }, { account: c.unlisted, credit: r.cost }], { pairs: r.n });
        // a lot whose good pairs are all listed: clear what is left of it in Unlisted Inventory (rounding, short count, lot-cost estimate) into COGS
        for (const r of lotClose())
            if (r.date >= from && r.date <= to && Math.abs(r.diff) >= 1)
                add('auto-lotclose', r.date, `Lot ${r.lot} fully listed — Rs ${num(Math.abs(r.diff))} cost difference ${r.diff > 0 ? 'left' : 'over-listed'} in Unlisted Inventory cleared to COGS`, [{ account: c.cogs, debit: r.diff }, { account: c.unlisted, credit: r.diff }], { lot: r.lot, received: r.received, listed: r.listed, pairs: r.pairs, good: r.good }, r.lot);
        return out;
    }
    // received lots (GRN posted) whose good pairs are all listed, with what the GRN put into Unlisted Inventory vs what listing took out
    function lotClose() {
        const c = cfg(), ua = acct(c.unlisted);
        if (!ua)
            return [];
        let good = new Map();
        try {
            good = new Map(q.all('SELECT lot, good FROM wms_grn').map(g => [g.lot, +g.good || 0]));
        }
        catch (_a) { }
        const grn = q.all(`SELECT j.source_id lot, j.date, COALESCE(SUM(l.debit-l.credit),0) v FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id WHERE j.source='grn' AND j.voided=0 AND l.account_id=? GROUP BY j.id`, ua.id);
        const out = [];
        for (const g of grn) {
            const ls = q.get(`SELECT COUNT(*) n, COALESCE(SUM(cost),0) v, MAX(d) last FROM (${LISTED_SQL}) WHERE lot=?`, g.lot), need = good.get(g.lot) || 0;
            if (!need || ls.n < need)
                continue;
            out.push({ lot: g.lot, date: ls.last > g.date ? ls.last : g.date, received: r2(g.v), listed: r2(ls.v), diff: r2(g.v - ls.v), pairs: ls.n, good: need });
        }
        return out;
    }
    // automatic entries never carry a negative amount: a negative debit is a credit (e.g. a COD payment day of prepaid parcels only)
    function flip(lines) {
        return lines.map(l => { const d = r2(l.debit), cr = r2(l.credit), v = r2(d - cr); return Object.assign(Object.assign({}, l), { debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 }); }).filter(l => l.debit || l.credit);
    }
    function autoRange(from, to) {
        const start = startDate();
        if (!start)
            return null;
        let f = from && from > start ? from : start;
        const L = lockDate();
        if (L && L >= f)
            f = addDays(L, 1);
        const t = to && to < ctx.pkToday() ? to : ctx.pkToday();
        return f > t ? null : { from: f, to: t };
    }
    const sigOf = e => JSON.stringify([e.date, e.memo, e.lines.map(l => [mustAcct(l.account).id, r2(l.debit), r2(l.credit), l.party || null])]);
    function autoPost(opts = {}) {
        const rg = autoRange(opts.from, opts.to);
        const res = { from: rg && rg.from, to: rg && rg.to, posted: [], removed: 0, unchanged: 0, pending: [] };
        if (!startDate())
            return Object.assign(Object.assign({}, res), { off: 'Set the date automatic postings start from (Accounts → Month close → Settings).' });
        const L = lockDate();
        const stale = q.all(`SELECT j.id, j.date, j.source FROM acc_journals j WHERE ${AUTO_SRC} AND j.date<? ${L ? 'AND j.date>?' : ''}`, startDate(), ...(L ? [L] : []));
        if (!rg && !stale.length)
            return res;
        const want = rg ? autoEntries(rg.from, rg.to) : [];
        const have = rg ? q.all(`SELECT j.* FROM acc_journals j WHERE ${AUTO_SRC} AND j.date BETWEEN ? AND ?`, rg.from, rg.to) : [];
        const key = (s, id) => s + '|' + id, haveMap = new Map(have.map(j => [key(j.source, j.source_id), j])), seen = new Set();
        const todo = [];
        for (const e of want) {
            const k = key(e.source, e.source_id);
            seen.add(k);
            const sig = sigOf(e), ex = haveMap.get(k) || q.get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', e.source, e.source_id);
            let exSig = null;
            try {
                exSig = ex && !ex.voided ? JSON.parse(ex.meta || '{}').sig : null;
            }
            catch (_a) { }
            if (ex && L && ex.date <= L)
                continue; // moved out of a closed period: leave it
            if (exSig === sig) {
                res.unchanged++;
                continue;
            }
            todo.push(Object.assign(Object.assign({}, e), { meta: Object.assign(Object.assign({}, (e.meta || {})), { sig }) }));
        }
        const drop = have.filter(j => !seen.has(key(j.source, j.source_id))).concat(stale);
        res.pending = todo.map(e => ({ source: e.source, date: e.date, memo: e.memo })).concat(drop.map(j => ({ source: j.source, date: j.date, memo: 'remove (no longer applies)' })));
        if (opts.dry)
            return res;
        tx(() => {
            for (const e of todo) {
                postRaw(Object.assign(Object.assign({}, e), { kind: 'AUTO' }), opts.userId || null);
                res.posted.push({ source: e.source, date: e.date, memo: e.memo, amount: r2(e.lines.reduce((s, l) => s + r2(l.debit), 0)) });
            }
            for (const j of drop) {
                removeJ(j.id);
                res.removed++;
            }
        });
        res.pending = [];
        ctx.setSetting('accounts_autopost_last', { at: ctx.pkNow(), posted: res.posted.length, removed: res.removed, unchanged: res.unchanged, by: opts.userId || null });
        cache.t = 0;
        return res;
    }
    // cached dry-run for badges/alerts (polled every 30s by every client)
    const cache = { t: 0, pending: 0 };
    function pendingCount() { if (Date.now() - cache.t > 10 * 60e3) {
        try {
            cache.pending = autoPost({ dry: true }).pending.length;
        }
        catch (_a) {
            cache.pending = 0;
        }
        cache.t = Date.now();
    } return cache.pending; }
    /* ---------------- month close checks ---------------- */
    function checks(month) {
        const from = month + '-01', to = monthEnd(month), c = cfg(), out = [], fee = +setting('courier_fee', 250);
        const add = (key, title, status, detail, fix) => out.push({ key, title, status, detail, fix: status === 'pass' ? '' : fix });
        const m = Object.fromEntries(sums(from, to).map(a => [a.name, a]));
        const amt = n => (m[n] ? m[n].amt : 0);
        const tb = trial(to);
        add('tb', 'Trial balance balances', tb.diff ? 'fail' : 'pass', `Debits ${fmt(tb.debit)} · credits ${fmt(tb.credit)}` + (tb.diff ? ` · difference ${fmt(tb.diff)}` : ''), 'Find the entry where debits and credits differ (Vouchers → filter this month).');
        const rec = c.recognise === 'delivered' ? 'o.delivered_at' : 'o.dispatched_at';
        const sold = q.get(`SELECT COALESCE(SUM(i.qty),0) pairs, SUM(${PAIR_COST}*i.qty) cost, SUM(CASE WHEN ${PAIR_COST} IS NOT NULL THEN i.qty END) costed FROM order_items i JOIN orders o ON o.id=i.order_id
    ${PAIR_JOIN} WHERE ${rec} IS NOT NULL AND o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND ${PKD(rec)} BETWEEN ? AND ?`, from, to);
        const cogsDr = m[c.cogs] ? m[c.cogs].dr : 0;
        if (!sold.pairs)
            add('cogs', 'Cost per pair sold', 'pass', 'No pairs sold this month.', '');
        else if (!cogsDr)
            add('cogs', 'Cost per pair sold', 'fail', `${num(sold.pairs)} pairs were ${c.recognise} but no Cost of Goods Sold was posted.`, 'Run automatic postings (Post now) or post the cost of goods sold.');
        else {
            const per = cogsDr / sold.pairs, avg = sold.costed ? sold.cost / sold.costed : 0, diff = avg ? Math.abs(per - avg) / avg : 0;
            add('cogs', 'Cost per pair sold', avg && diff > 0.15 ? 'warn' : 'pass', `COGS ${fmt(cogsDr)} ÷ ${num(sold.pairs)} pairs = ${fmt(per)} per pair · average product cost of those pairs ${avg ? fmt(avg) : 'unknown'}` + (avg ? ` (${Math.round(diff * 100)}% apart)` : ''), per < avg ? 'COGS per pair is lower than what the shoes cost. Check that every sold pair was costed (lot cost ÷ good pairs) and that COGS was not posted only for delivered parcels.' : 'COGS per pair is higher than product cost. Check for double COGS entries or damaged pairs booked as COGS.');
        }
        const par = q.get(`SELECT COUNT(*) n, SUM(px_fee IS NULL) nofee FROM orders WHERE dispatched_at IS NOT NULL AND tracking IS NOT NULL AND cancelled_at IS NULL AND status<>'courier_cancelled' AND ${PKD('dispatched_at')} BETWEEN ? AND ?`, from, to);
        const ship = amt(c.shipping);
        if (!par.n)
            add('courier', 'Courier charges vs parcels', 'pass', 'No parcels dispatched this month.', '');
        else {
            const st = !ship ? 'fail' : (ship / par.n < fee * 0.5 || par.nofee / par.n > 0.2) ? 'warn' : 'pass';
            add('courier', 'Courier charges vs parcels', st, `${num(par.n)} parcels dispatched · Shipping Exp ${fmt(ship)} (${fmt(ship / par.n)} per parcel) · ${num(par.nofee || 0)} parcels have no PostEx charge yet`, !ship ? 'No courier cost was booked. Charges must be accrued when parcels are dispatched, not when PostEx pays — run Post now.' : 'Many parcels have no PostEx charge yet (estimated at ' + fmt(fee) + '). Sync PostEx, then Post now; or check the courier fee in Settings.');
        }
        const taxes = Object.values(m).filter(a => /tax|gst/i.test(a.name) && (a.dr || a.cr)).map(a => ({ n: a.name, v: r2(a.dr - a.cr) })).filter(a => a.v);
        const same = [];
        for (let i = 0; i < taxes.length; i++)
            for (let k = i + 1; k < taxes.length; k++)
                if (Math.abs(taxes[i].v - taxes[k].v) < 1)
                    same.push(`${taxes[i].n} and ${taxes[k].n} are both ${fmt(taxes[i].v)}`);
        add('tax', 'Tax lines not doubled', same.length ? 'warn' : 'pass', same.length ? same.join('; ') : (taxes.length ? taxes.map(t => `${t.n} ${fmt(t.v)}`).join(' · ') : 'No tax posted this month.'), 'Two tax accounts with exactly the same amount usually means one tax was entered twice (e.g. income tax withheld also booked as sales tax). Check the vouchers and void the duplicate.');
        const prepaid = balance('Prepaid Rent', to);
        for (const r of ['Office Rent', 'Outlet Rent'])
            if (acct(r))
                add('rent-' + r, r + ' posted', amt(r) > 0 ? 'pass' : 'warn', amt(r) > 0 ? `${fmt(amt(r))} this month` : `No ${r} expense this month.` + (prepaid ? ` Prepaid Rent still holds ${fmt(prepaid)}.` : ''), prepaid ? `If the rent was paid in advance, move one month into expense: JV Dr ${r} / Cr Prepaid Rent.` : `Post this month's ${r} (Payment voucher, or JV to Accrued Expenses if still unpaid).`);
        const adv = q.all(`SELECT DISTINCT j.id, j.ref, j.date, j.memo, l.credit FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.account_id=? AND l.credit>0 AND j.voided=0 AND NOT ${AUTO_SRC}
    AND j.date BETWEEN ? AND ? AND (j.memo LIKE '%advance%' OR l.memo LIKE '%advance%' OR j.source='manual')`, mustAcct(c.sales).id, from, to);
        add('advance', 'Customer advances not booked as Sales', adv.length ? 'warn' : 'pass', adv.length ? `${adv.length} manual entr${adv.length > 1 ? 'ies' : 'y'} credit Sales: ` + adv.slice(0, 5).map(a => `${a.ref || '#' + a.id} ${fmt(a.credit)} "${(a.memo || '').slice(0, 40)}"`).join(', ') : 'Only automatic order postings credit Sales.', 'Money received before an order ships is a Customer Advance (liability), not Sales. Edit these to credit Customer Advances; the sale is recorded automatically when the order is dispatched.');
        const dmg = amt('Inventory Damage'), inv = balance('Listed Inventory', to) + balance('Unlisted Inventory', to);
        const invVal = inv > 0 ? inv : (q.get('SELECT COALESCE(SUM(cost*qty),0) v FROM products WHERE qty>0').v || 0);
        add('damage', 'Inventory damage reasonable', invVal && dmg / invVal > 0.01 ? 'warn' : 'pass', `Inventory Damage ${fmt(dmg)} vs inventory ${fmt(invVal)}` + (invVal ? ` (${(100 * dmg / invVal).toFixed(1)}%)` : ''), 'Damage above 1% of stock in a month is unusual. Ask for the list of damaged pairs (SKU, reason, photo) and check returns were restocked instead of written off.');
        const pxBal = balance(c.courier_ar, to), recBasis = c.recognise === 'delivered';
        const du = q.get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)-COALESCE(px_fee,?)-COALESCE(px_tax,0)),0) v FROM orders o WHERE ${CK}='PostEx' AND delivered_at IS NOT NULL AND ${PKD('delivered_at')}<=? AND status='delivered' AND (settled=0 OR ${PKD('COALESCE(settled_at,delivered_at)')}>?)`, fee, to, to);
        const it = recBasis ? { n: 0, v: 0 } : q.get(`SELECT COUNT(*) n, COALESCE(SUM(total-COALESCE(px_fee,?)-COALESCE(px_tax,0)),0) v FROM orders o WHERE ${CK}='PostEx' AND dispatched_at IS NOT NULL AND ${PKD('dispatched_at')}<=? AND cancelled_at IS NULL
    AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND (delivered_at IS NULL OR ${PKD('delivered_at')}>?) AND (COALESCE(returned_at,return_received_at) IS NULL OR ${PKD('COALESCE(returned_at,return_received_at)')}>?)`, fee, to, to, to);
        const expd = r2(du.v + it.v), pdiff = r2(pxBal - expd);
        add('postex', 'PostEx receivable matches orders', Math.abs(pdiff) > Math.max(1000, Math.abs(expd) * 0.02) ? 'warn' : 'pass', `Books ${fmt(pxBal)} · delivered not yet paid ${fmt(du.v)} (${du.n})` + (recBasis ? '' : ` · in transit ${fmt(it.v)} (${it.n})`) + ` · difference ${fmt(pdiff)}`, pdiff < 0 ? 'Books show less than PostEx owes. Usually return charges PostEx already deducted from a payment: post Dr Post Ex / Cr bank for the deducted amount, or check for missing sales days.' : 'Books show more than PostEx owes. Check for payments not yet recorded, or an opening balance that is too high.');
        // TCS and the own rider: same idea as PostEx (only shown once they are used)
        if (hasCol('orders', 'courier_fee')) {
            const tfee = +setting('couriers_tcs_fee', 250), live = `cancelled_at IS NULL AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled')`, retD = PKD('COALESCE(returned_at,return_received_at)');
            const tcsBal = balance(c.tcs_ar, to);
            const tdu = q.get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)-COALESCE(courier_fee,?)),0) v FROM orders o WHERE ${CK}='TCS' AND delivered_at IS NOT NULL AND ${PKD('delivered_at')}<=? AND status='delivered' AND (settled=0 OR ${PKD('COALESCE(settled_at,delivered_at)')}>?)`, tfee, to, to);
            const tit = recBasis ? { n: 0, v: 0 } : q.get(`SELECT COUNT(*) n, COALESCE(SUM(total-COALESCE(courier_fee,?)),0) v FROM orders o WHERE ${CK}='TCS' AND dispatched_at IS NOT NULL AND tracking IS NOT NULL AND ${PKD('dispatched_at')}<=? AND ${live}
      AND (delivered_at IS NULL OR ${PKD('delivered_at')}>?) AND (COALESCE(returned_at,return_received_at) IS NULL OR ${retD}>?)`, tfee, to, to, to);
            if (tdu.n || tit.n || Math.abs(tcsBal) >= 1) {
                const te = r2(tdu.v + tit.v), td = r2(tcsBal - te);
                add('tcs', 'TCS receivable matches orders', Math.abs(td) > Math.max(1000, Math.abs(te) * 0.02) ? 'warn' : 'pass', `Books ${fmt(tcsBal)} · delivered not yet paid ${fmt(tdu.v)} (${tdu.n})` + (recBasis ? '' : ` · in transit ${fmt(tit.v)} (${tit.n})`) + ` · difference ${fmt(td)}`, td < 0 ? 'Books show less than TCS owes: usually return charges TCS deducted (post Dr TCS / Cr bank), or missing sales days. Sync TCS payments, then Post now.' : 'Books show more than TCS owes: a TCS payment not yet synced/recorded, or charges not yet reported. Run the TCS payment sync (Couriers → Settings), then Post now.');
            }
            const rBal = balance(c.rider_ar, to);
            const rOpen = q.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders o WHERE ${CK}='Rider' AND ${recBasis ? 'delivered_at' : 'dispatched_at'} IS NOT NULL AND ${PKD(recBasis ? 'delivered_at' : 'dispatched_at')}<=? AND ${live}
      AND (settled=0 OR ${PKD('COALESCE(settled_at,delivered_at)')}>?) AND (COALESCE(returned_at,return_received_at) IS NULL OR ${retD}>?)`, to, to, to);
            if (rOpen.n || Math.abs(rBal) >= 1) {
                const rd = r2(rBal - rOpen.v);
                add('rider', 'Rider cash matches parcels', Math.abs(rd) > 500 ? 'warn' : 'pass', `Books ${fmt(rBal)} · rider parcels not yet handed over or returned ${fmt(rOpen.v)} (${rOpen.n}) · difference ${fmt(rd)}`, 'Every rider parcel is either cash handed over (Rider runs → handover), returned to the office, or still out. Record the missing handovers, receive failed parcels back, then Post now.');
            }
        }
        // inventory chain: Purchases = lots bought but not received yet; Listed / Unlisted Inventory must not go below zero
        const purch = balance(c.purchases, to), lis = balance(c.inventory, to), unl = balance(c.unlisted, to);
        let openLots = null;
        try {
            openLots = q.get(`SELECT COUNT(*) n, COALESCE(SUM(l.cost + COALESCE(l.extra,0)),0) v FROM lots l WHERE l.cost>0${notPO('l.name')} AND l.bought_on<=? AND l.bought_on>=? AND NOT EXISTS (SELECT 1 FROM acc_journals j WHERE j.source='grn' AND j.source_id=l.name AND j.voided=0 AND j.date<=?)`, to, startDate() || '0000', to);
        }
        catch (_a) { }
        const invBad = [];
        if (lis < -1)
            invBad.push(`Listed Inventory is negative (${fmt(lis)}): pairs were sold or written off that were never moved in. Enter the opening Listed Inventory, or check pairs sold without a cost.`);
        if (unl < -1)
            invBad.push(`Unlisted Inventory is negative (${fmt(unl)}): pairs were listed from lots that were never received. Receive the lot in WMS (GRN) or enter the opening Unlisted Inventory.`);
        if (purch < -1)
            invBad.push(`Purchases is negative (${fmt(purch)}): a lot was received for more than it was bought for. Check the lot cost and the GRN.`);
        if (openLots && Math.abs(purch - openLots.v) > 1)
            invBad.push(`Purchases ${fmt(purch)} but lots bought and not yet received total ${fmt(openLots.v)} (${openLots.n}). Receive delivered lots in WMS, or check the opening balance.`);
        add('inventory', 'Inventory accounts make sense', invBad.length ? 'warn' : 'pass', invBad.length ? invBad.join(' ') : `Purchases (in transit) ${fmt(purch)} · Unlisted ${fmt(unl)} · Listed ${fmt(lis)}`, 'Lot bought → Purchases; received (GRN) → Unlisted; listed → Listed; sold → COGS. Fix the step that is missing.');
        // the same cost booked from two places (e.g. rent as a recurring expense and again as a voucher, salaries in payroll and as an expense claim, Meta from Marketing and a voucher)
        const fam = s => s === 'manual' ? 'vouchers' : s === 'expense' || s === 'petty_count' ? 'expense claims' : s === 'payroll' ? 'payroll' : s === 'meta' || s === 'meta_pay' || s === 'mkt_other' ? 'marketing' : s;
        const dbl = [];
        for (const n of ['Office Rent', 'Outlet Rent', 'Salary Exp', 'Social Media Marketing']) {
            const a = acct(n);
            if (!a)
                continue;
            const fs = [...new Set(q.all(`SELECT DISTINCT j.source FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.account_id=? AND l.debit>0 AND j.voided=0 AND j.date BETWEEN ? AND ?`, a.id, from, to).map(r => fam(r.source)))];
            if (fs.length > 1)
                dbl.push(`${n} comes from ${fs.join(' and ')}`);
        }
        add('doubles', 'Same cost not booked twice', dbl.length ? 'warn' : 'pass', dbl.length ? dbl.join('; ') + '.' : 'Rent, salaries and Meta ads each come from one place.', 'Rent: use either the recurring expense or a voucher (or Prepaid Rent JV), not both. Salaries: only payroll. Meta ads: only the Marketing screen. Void the duplicate.');
        const rg = autoRange(from, to), pend = rg ? autoPost({ from, to, dry: true }).pending : [];
        add('auto', 'Automatic postings up to date', !startDate() ? 'warn' : pend.length ? 'warn' : 'pass', !startDate() ? 'Automatic postings are off.' : pend.length ? `${pend.length} automatic entries are missing or out of date (${[...new Set(pend.map(p => p.date))].slice(0, 4).join(', ')}${pend.length > 4 ? '…' : ''}).` : 'All sales, cost, returns, courier and COD entries are posted.', !startDate() ? 'Set the start date in Settings so sales, COGS and courier charges post themselves.' : 'Click "Post now" before closing the month.');
        return { month, from, to, locked: lockDate() >= to, checks: out, fails: out.filter(x => x.status === 'fail').length, warns: out.filter(x => x.status === 'warn').length };
    }
    const num = v => Math.round(+v || 0).toLocaleString('en-PK');
    /* ---------------- summary / overview ---------------- */
    function summary() {
        const today = ctx.pkToday(), ms = today.slice(0, 7) + '-01', cash = sums(null, today).filter(a => a.grp === 'cash' && a.type === 'asset');
        const isCash = a => /cash/i.test(a.name), p = pnl(ms, today), c = cfg();
        return { cash: r2(cash.filter(isCash).reduce((s, a) => s + a.bal, 0)), bank: r2(cash.filter(a => !isCash(a)).reduce((s, a) => s + a.bal, 0)), postexReceivable: balance(c.courier_ar, today), tcsReceivable: balance(c.tcs_ar, today), riderCash: balance(c.rider_ar, today),
            payables: -balance(c.payable, today), salesMTD: p.netSales, profitMTD: p.net };
    }
    /* ---------------- module ---------------- */
    module.exports = {
        name: 'accounts',
        schema: `
CREATE TABLE IF NOT EXISTS acc_accounts(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL, statement TEXT NOT NULL, grp TEXT, active INTEGER DEFAULT 1, system INTEGER DEFAULT 0, note TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS acc_journals(id INTEGER PRIMARY KEY, date TEXT NOT NULL, memo TEXT, source TEXT NOT NULL, source_id TEXT NOT NULL, ref TEXT, kind TEXT, file_id TEXT, user_id INTEGER, amount REAL DEFAULT 0, meta TEXT,
  voided INTEGER DEFAULT 0, void_reason TEXT, voided_by INTEGER, voided_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_acc_journals_src ON acc_journals(source, source_id);
CREATE INDEX IF NOT EXISTS ix_acc_journals_date ON acc_journals(date);
CREATE INDEX IF NOT EXISTS ix_acc_journals_ref ON acc_journals(ref);
CREATE TABLE IF NOT EXISTS acc_lines(id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL REFERENCES acc_journals(id) ON DELETE CASCADE, account_id INTEGER NOT NULL REFERENCES acc_accounts(id), debit REAL DEFAULT 0, credit REAL DEFAULT 0, party TEXT, memo TEXT);
CREATE INDEX IF NOT EXISTS ix_acc_lines_j ON acc_lines(journal_id);
CREATE INDEX IF NOT EXISTS ix_acc_lines_a ON acc_lines(account_id);
CREATE INDEX IF NOT EXISTS ix_acc_lines_party ON acc_lines(party);`,
        migrate(c) {
            ctx = c;
            q = c.q;
            setting = c.setting;
            const ins = c.db.prepare('INSERT OR IGNORE INTO acc_accounts(code,name,type,statement,grp,system) VALUES(?,?,?,?,?,1)');
            for (const [code, name, type, grp] of SEED)
                if (!q.get('SELECT id FROM acc_accounts WHERE name=?', name))
                    ins.run(q.get('SELECT id FROM acc_accounts WHERE code=?', code) ? null : code, name, type, TYPES[type], grp);
            c.services.accounts = { post, void: voidJ, balance, summary, accountId, ledger, trial, pnl, bs, partyName, lockDate };
        },
        routes(c) {
            const { route, need, log } = c;
            const isAdmin = u => u.role === 'admin';
            const dOr = (v, d) => isDate(v) ? v : d;
            // chart of accounts
            route('GET', '/api/accounts/chart', 'accounts', (req, u, b, res, p, qs) => {
                const used = new Set(q.all('SELECT DISTINCT account_id a FROM acc_lines').map(r => r.a));
                return { accounts: sums(null, dOr(qs.date, c.pkToday())).map(a => (Object.assign(Object.assign({}, a), { used: used.has(a.id) }))), groups: GROUPS, types: Object.keys(TYPES) };
            });
            route('POST', '/api/accounts/chart', 'accounts_post', (req, u, b) => {
                const name = String(b.name || '').trim(), code = String(b.code || '').trim() || null;
                need(name, 'Account name is needed');
                if (b.id) {
                    const a = q.get('SELECT * FROM acc_accounts WHERE id=?', +b.id);
                    need(a, 'Not found', 404);
                    need(!a.system || name === a.name, 'Built-in accounts cannot be renamed — other screens post to them by name. Add a new account instead.');
                    need(!a.system || b.active !== false, 'Built-in accounts cannot be deactivated.');
                    const dupe = q.get('SELECT id FROM acc_accounts WHERE (lower(name)=lower(?) OR code=?) AND id<>?', name, code, a.id);
                    need(!dupe, 'Another account has that name or code');
                    const grp = (GROUPS[a.type] || []).some(g => g[0] === b.grp) ? b.grp : a.grp;
                    q.run('UPDATE acc_accounts SET name=?, code=?, grp=?, active=?, note=? WHERE id=?', name, code, grp, b.active === false ? 0 : 1, b.note || null, a.id);
                    log(u.id, 'accounts.account', 'acc_account:' + a.id, { name, code, active: b.active !== false });
                    return { ok: true, id: a.id };
                }
                need(TYPES[b.type], 'Choose a type');
                need(!acct(name) && !(code && acct(code)), 'An account with that name or code already exists');
                const grp = (GROUPS[b.type] || []).some(g => g[0] === b.grp) ? b.grp : GROUPS[b.type][0][0];
                const id = q.run('INSERT INTO acc_accounts(code,name,type,statement,grp,note) VALUES(?,?,?,?,?,?)', code, name, b.type, TYPES[b.type], grp, b.note || null).lastInsertRowid;
                log(u.id, 'accounts.account', 'acc_account:' + id, { name, code, type: b.type });
                return { ok: true, id: Number(id) };
            });
            route('DELETE', '/api/accounts/chart/:id', 'accounts_post', (req, u, b, res, p) => {
                const a = q.get('SELECT * FROM acc_accounts WHERE id=?', +p.id);
                need(a, 'Not found', 404);
                need(!a.system, 'Built-in accounts cannot be deleted');
                need(!q.get('SELECT id FROM acc_lines WHERE account_id=? LIMIT 1', a.id), 'This account has entries — deactivate it instead');
                q.run('DELETE FROM acc_accounts WHERE id=?', a.id);
                log(u.id, 'accounts.account.delete', 'acc_account:' + a.id, a.name);
                return { ok: true };
            });
            // journals & vouchers
            const jFilter = qs => {
                const w = [], a = [];
                if (isDate(qs.from)) {
                    w.push('j.date>=?');
                    a.push(qs.from);
                }
                if (isDate(qs.to)) {
                    w.push('j.date<=?');
                    a.push(qs.to);
                }
                if (qs.kind === 'manual')
                    w.push("j.source='manual'");
                else if (qs.kind === 'auto')
                    w.push(AUTO_SRC);
                else if (qs.kind === 'opening')
                    w.push("j.source='opening'");
                else if (qs.kind === 'other')
                    w.push(`j.source NOT IN ('manual','opening') AND NOT ${AUTO_SRC}`);
                else if (KINDS[qs.kind]) {
                    w.push('j.ref LIKE ?');
                    a.push(qs.kind + '-%');
                }
                if (qs.source) {
                    w.push('j.source=?');
                    a.push(qs.source);
                }
                if (qs.voided !== '1')
                    w.push('j.voided=0');
                if (qs.account) {
                    w.push('j.id IN (SELECT journal_id FROM acc_lines WHERE account_id=?)');
                    a.push(mustAcct(qs.account).id);
                }
                if (qs.q) {
                    const t = '%' + String(qs.q).trim() + '%';
                    w.push('(j.memo LIKE ? OR j.ref LIKE ? OR j.source_id LIKE ? OR j.id IN (SELECT l.journal_id FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE ac.name LIKE ? OR l.party LIKE ? OR l.memo LIKE ?))');
                    a.push(t, t, t, t, t, t);
                }
                return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
            };
            route('GET', '/api/accounts/journals', 'accounts', (req, u, b, res, p, qs) => {
                const f = jFilter(qs);
                if (qs.csv === '1')
                    return q.all(`SELECT j.date, j.ref, j.source, j.source_id, j.memo, ac.code, ac.name account, l.party, l.debit, l.credit, l.memo line_memo, CASE WHEN j.voided THEN 'VOID' ELSE '' END status
        FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id JOIN acc_accounts ac ON ac.id=l.account_id ${f.where} ORDER BY j.date, j.id, l.id LIMIT 50000`, ...f.args);
                const pg = c.page(qs, 50);
                const rows = q.all(`SELECT j.id, j.date, j.ref, j.memo, j.source, j.source_id, j.kind, j.amount, j.voided, j.void_reason, j.file_id, us.name user,
        (SELECT group_concat(ac.name, ' · ') FROM (SELECT DISTINCT ac.name FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=j.id) ac) accounts
        FROM acc_journals j LEFT JOIN users us ON us.id=j.user_id ${f.where} ORDER BY j.date DESC, j.id DESC LIMIT ? OFFSET ?`, ...f.args, pg.limit, pg.offset);
                const t = q.get(`SELECT COUNT(*) n, COALESCE(SUM(j.amount),0) amt FROM acc_journals j ${f.where}`, ...f.args);
                return { rows, total: t.n, amount: r2(t.amt), page: pg.page, pages: Math.ceil(t.n / pg.limit) };
            });
            route('GET', '/api/accounts/journals/:id', 'accounts', (req, u, b, res, p) => {
                const j = q.get('SELECT j.*, us.name user, vb.name voided_by_name FROM acc_journals j LEFT JOIN users us ON us.id=j.user_id LEFT JOIN users vb ON vb.id=j.voided_by WHERE j.id=?', +p.id);
                need(j, 'Not found', 404);
                try {
                    j.meta = JSON.parse(j.meta || 'null');
                    if (j.meta)
                        delete j.meta.sig;
                }
                catch (_a) {
                    j.meta = null;
                }
                j.lines = q.all('SELECT l.*, ac.name account, ac.code FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=? ORDER BY l.id', j.id);
                j.history = q.all("SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.entity=? ORDER BY e.id DESC LIMIT 30", 'acc:' + j.id);
                j.locked = !!lockDate() && j.date <= lockDate();
                return j;
            });
            route('POST', '/api/accounts/vouchers', 'accounts_post', (req, u, b) => {
                let ex = null;
                if (b.id) {
                    ex = q.get('SELECT * FROM acc_journals WHERE id=?', +b.id);
                    need(ex && ex.source === 'manual', 'Only manual vouchers can be edited here');
                    need(!ex.voided, 'This voucher was voided — make a new one');
                }
                const kind = ex ? ex.kind : (KINDS[b.kind] ? b.kind : 'JV');
                need(String(b.memo || '').trim(), 'Write what this voucher is for (narration)');
                const old = ex ? q.all('SELECT ac.name account, l.debit, l.credit, l.party FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=?', ex.id) : null;
                const id = tx(() => {
                    const ref = ex ? ex.ref : nextRef(kind);
                    return postRaw({ date: b.date, memo: String(b.memo).trim(), source: 'manual', source_id: ref, ref, kind, file_id: b.file_id || null, lines: b.lines, meta: b.form ? { form: b.form } : null }, u.id);
                });
                const j = q.get('SELECT ref, amount FROM acc_journals WHERE id=?', id);
                log(u.id, ex ? 'accounts.voucher.edit' : 'accounts.voucher', 'acc:' + id, ex ? { ref: j.ref, amount: j.amount, before: old } : { ref: j.ref, amount: j.amount });
                return { ok: true, id, ref: j.ref };
            });
            route('POST', '/api/accounts/journals/:id/void', 'accounts_post', (req, u, b, res, p) => {
                const j = q.get('SELECT * FROM acc_journals WHERE id=?', +p.id);
                need(j, 'Not found', 404);
                need(['manual', 'opening'].includes(j.source), `This entry comes from "${j.source}". Change it on that screen instead.`);
                need(String(b.reason || '').trim(), 'Give a reason for voiding');
                need(voidJ(j.source, j.source_id, u.id, String(b.reason).trim()), 'Already voided');
                log(u.id, 'accounts.voucher.void', 'acc:' + j.id, { ref: j.ref, reason: b.reason, amount: j.amount });
                return { ok: true };
            });
            // opening balances
            route('GET', '/api/accounts/opening', 'accounts', () => {
                const j = q.get("SELECT * FROM acc_journals WHERE source='opening' AND source_id='opening'");
                return { journal: j || null, start: startDate(), lock: lockDate(), lines: j && !j.voided ? q.all('SELECT ac.name account, l.debit, l.credit, l.party FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=? ORDER BY ac.code', j.id) : [] };
            });
            route('POST', '/api/accounts/opening', 'accounts_post', (req, u, b) => {
                need(isDate(b.date), 'Choose the opening date');
                const lines = (b.lines || []).filter(l => +l.debit || +l.credit).map(l => ({ account: l.account, debit: +l.debit || 0, credit: +l.credit || 0, party: l.party || null }));
                if (b.balance_to) {
                    const d = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
                    if (d)
                        lines.push({ account: b.balance_to, debit: d < 0 ? -d : 0, credit: d > 0 ? d : 0, memo: 'Difference' });
                }
                const id = tx(() => {
                    const r = postRaw({ date: b.date, memo: 'Opening balances as of ' + b.date, source: 'opening', source_id: 'opening', ref: 'OB', kind: 'OB', lines }, u.id);
                    const st = startDate();
                    if (!st || st <= b.date)
                        c.setSetting('accounts_start', addDays(b.date, 1));
                    return r;
                });
                log(u.id, 'accounts.opening', 'acc:' + id, { date: b.date, lines: lines.length });
                return { ok: true, id, start: startDate() };
            });
            // settings
            route('GET', '/api/accounts/settings', 'accounts', () => ({ cfg: cfg(), start: startDate(), lock: lockDate(), courier_fee: setting('courier_fee', 250), return_fee: setting('return_fee', 150), cost_pct: setting('cost_pct', 35),
                last: setting('accounts_autopost_last', null), defaults: DEF_CFG }));
            route('POST', '/api/accounts/settings', 'accounts_post', (req, u, b) => {
                const cur = cfg(), nx = Object.assign({}, cur);
                for (const k of Object.keys(DEF_CFG))
                    if (k in (b.cfg || {}))
                        nx[k] = b.cfg[k];
                for (const k of ['bank', 'courier_ar', 'tcs_ar', 'rider_ar', 'sales', 'discount', 'returns', 'cogs', 'inventory', 'unlisted', 'shipping', 'courier_tax', 'purchases', 'payable'])
                    nx[k] = mustAcct(nx[k]).name;
                need(['dispatched', 'delivered'].includes(nx.recognise), 'Recognise sales on dispatched or delivered');
                nx.auto = nx.auto !== false;
                nx.fy_month = Math.min(12, Math.max(1, +nx.fy_month || 7));
                if ('start' in b && b.start !== startDate()) {
                    need(!b.start || isDate(b.start), 'Start date must be YYYY-MM-DD');
                    need(!b.start || !lockDate() || b.start > lockDate(), 'Start date must be after the closed period');
                    c.setSetting('accounts_start', b.start || '');
                }
                c.setSetting('accounts_cfg', nx);
                cache.t = 0;
                log(u.id, 'accounts.settings', 'accounts', { cfg: nx, start: startDate() });
                return { ok: true };
            });
            // automatic postings
            route('GET', '/api/accounts/auto', 'accounts', (req, u, b, res, p, qs) => {
                const dry = autoPost({ dry: true });
                const recent = q.all(`SELECT j.id, j.date, j.source, j.source_id, j.memo, j.amount, j.updated_at, j.created_at FROM acc_journals j WHERE ${AUTO_SRC} AND j.voided=0 ORDER BY j.date DESC, j.source LIMIT ?`, Math.min(500, +qs.limit || 120));
                return { start: startDate(), lock: lockDate(), last: setting('accounts_autopost_last', null), pending: dry.pending, off: dry.off || null, recent, cfg: cfg() };
            });
            route('POST', '/api/accounts/auto', 'accounts_post', (req, u) => { const r = autoPost({ userId: u.id }); log(u.id, 'accounts.autopost', 'accounts', { posted: r.posted.length, removed: r.removed }); return r; });
            // reports
            route('GET', '/api/accounts/ledger', 'accounts', (req, u, b, res, p, qs) => { need(qs.account, 'Choose an account'); return ledger(qs.account, dOr(qs.from, null), dOr(qs.to, null), qs.party || null); });
            route('GET', '/api/accounts/parties', 'accounts', (req, u, b, res, p, qs) => parties(qs.prefix || null, qs.account || null, dOr(qs.date, null)));
            route('GET', '/api/accounts/trial', 'accounts', (req, u, b, res, p, qs) => trial(dOr(qs.date, c.pkToday()), dOr(qs.from, null)));
            route('GET', '/api/accounts/pnl', 'accounts', (req, u, b, res, p, qs) => {
                const m = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : null;
                const from = m ? m + '-01' : dOr(qs.from, c.pkToday().slice(0, 7) + '-01'), to = m ? monthEnd(m) : dOr(qs.to, c.pkToday());
                need(from <= to, 'From date is after To date');
                const [pf, pt] = prevRange(from, to);
                return { cur: pnl(from, to), prev: pnl(pf, pt) };
            });
            route('GET', '/api/accounts/bs', 'accounts', (req, u, b, res, p, qs) => bs(dOr(qs.date, c.pkToday())));
            route('GET', '/api/accounts/sales-register', 'accounts', (req, u, b, res, p, qs) => {
                const from = dOr(qs.from, c.pkToday().slice(0, 7) + '-01'), to = dOr(qs.to, c.pkToday()), cf = cfg();
                const ids = [cf.sales, cf.discount, cf.returns].map(n => mustAcct(n).id);
                const rows = q.all(`SELECT j.date, SUM(CASE WHEN l.account_id=? THEN l.credit-l.debit ELSE 0 END) gross, SUM(CASE WHEN l.account_id=? THEN l.debit-l.credit ELSE 0 END) discount,
        SUM(CASE WHEN l.account_id=? THEN l.debit-l.credit ELSE 0 END) returns FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE j.voided=0 AND j.date BETWEEN ? AND ? AND l.account_id IN (?,?,?) GROUP BY j.date ORDER BY j.date`, ...ids, from, to, ...ids);
                const rec = cf.recognise === 'delivered' ? 'delivered_at' : 'dispatched_at';
                const cnt = Object.fromEntries(q.all(`SELECT ${PKD(rec)} d, COUNT(*) n FROM orders WHERE ${rec} IS NOT NULL AND cancelled_at IS NULL AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND ${PKD(rec)} BETWEEN ? AND ? GROUP BY d`, from, to).map(r => [r.d, r.n]));
                const rcnt = Object.fromEntries(q.all(`SELECT ${PKD('COALESCE(returned_at,return_received_at)')} d, COUNT(*) n FROM orders WHERE status IN ('returning','returned','return_received') AND ${rec} IS NOT NULL AND cancelled_at IS NULL AND ${PKD('COALESCE(returned_at,return_received_at)')} BETWEEN ? AND ? GROUP BY d`, from, to).map(r => [r.d, r.n]));
                const days = new Set([...rows.map(r => r.date), ...Object.keys(cnt), ...Object.keys(rcnt)]);
                const map = Object.fromEntries(rows.map(r => [r.date, r]));
                const out = [...days].sort().map(d => { const r = map[d] || { gross: 0, discount: 0, returns: 0 }; return { date: d, orders: cnt[d] || 0, returned: rcnt[d] || 0, gross: r2(r.gross), discount: r2(r.discount), returns: r2(r.returns), net: r2(r.gross - r.discount - r.returns) }; });
                const tot = out.reduce((s, r) => { for (const k of ['orders', 'returned', 'gross', 'discount', 'returns', 'net'])
                    s[k] = r2((s[k] || 0) + r[k]); return s; }, {});
                return { from, to, basis: cf.recognise, rows: out, total: tot };
            });
            route('GET', '/api/accounts/overview', 'accounts', (req, u) => {
                const today = c.pkToday(), cf = cfg(), all = sums(null, today);
                const months = [];
                for (let i = 5; i >= 0; i--) {
                    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1)).toISOString().slice(0, 7);
                    const pp = pnl(d + '-01', d === today.slice(0, 7) ? today : monthEnd(d));
                    months.push({ month: d, sales: pp.netSales, gross: pp.gross, net: pp.net });
                }
                const sup = parties('vendor:', cf.payable, today).filter(x => Math.abs(x.amount) >= 1).sort((a, b) => b.amount - a.amount);
                return { today, start: startDate(), lock: lockDate(), last: setting('accounts_autopost_last', null), cash: all.filter(a => a.grp === 'cash' && a.type === 'asset').map(a => ({ name: a.name, balance: a.bal })),
                    postex: balance(cf.courier_ar, today), payables: r2(sup.reduce((s, x) => s + x.amount, 0)), suppliers: sup.slice(0, 6), mtd: pnl(today.slice(0, 7) + '-01', today), months,
                    alerts: module.exports.alerts(u, c), empty: !q.get('SELECT id FROM acc_journals WHERE voided=0 LIMIT 1') };
            });
            // month close
            route('GET', '/api/accounts/close', 'accounts', (req, u, b, res, p, qs) => {
                const m = /^\d{4}-\d{2}$/.test(qs.month || '') ? qs.month : addDays(c.pkToday().slice(0, 7) + '-01', -1).slice(0, 7);
                const hist = q.all("SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.action IN ('accounts.close','accounts.reopen') ORDER BY e.id DESC LIMIT 20");
                return Object.assign(Object.assign({}, checks(m)), { lock: lockDate(), start: startDate(), history: hist, canReopen: isAdmin(u) });
            });
            route('POST', '/api/accounts/close', 'accounts_post', (req, u, b) => {
                need(/^\d{4}-\d{2}$/.test(b.month || ''), 'Choose a month');
                const end = monthEnd(b.month);
                need(end < c.pkToday(), 'You can close a month only after it has ended');
                need(!lockDate() || lockDate() < end, `${b.month} is already closed`);
                if (startDate() && cfg().auto)
                    autoPost({ to: end, userId: u.id });
                const ch = checks(b.month);
                need(!ch.fails || b.force, `${ch.fails} check(s) failed. Fix them, or close anyway with a reason.`);
                c.setSetting('accounts_lock_date', end);
                cache.t = 0;
                log(u.id, 'accounts.close', 'accounts:' + b.month, { month: b.month, lock: end, fails: ch.fails, warns: ch.warns, note: b.note || null });
                return { ok: true, lock: end };
            });
            route('POST', '/api/accounts/reopen', 'accounts_post', (req, u, b) => {
                need(isAdmin(u), 'Only the owner can reopen a closed month', 403);
                need(/^\d{4}-\d{2}$/.test(b.month || ''), 'Choose a month');
                need(String(b.reason || '').trim().length >= 4, 'Write the reason for reopening');
                const L = lockDate(), start = b.month + '-01';
                need(L && L >= start, `${b.month} is not closed`);
                const nl = addDays(start, -1);
                c.setSetting('accounts_lock_date', nl);
                cache.t = 0;
                log(u.id, 'accounts.reopen', 'accounts:' + b.month, { month: b.month, from: L, to: nl, reason: String(b.reason).trim() });
                return { ok: true, lock: nl };
            });
        },
        jobs: [{ name: 'autopost', every: 60, offset: 7, run: async (c) => { if (startDate() && cfg().auto)
                    autoPost({}); } }],
        counts(u, c) { return c.can(u, 'accounts_post') && startDate() ? { close: pendingCount() } : {}; },
        alerts(u, c) {
            if (!c.can(u, 'accounts'))
                return [];
            const out = [], today = c.pkToday();
            if (!startDate())
                return [{ level: 'info', text: 'Accounts: enter opening balances and a start date so the books fill themselves.', href: '#/close/opening' }];
            const n = pendingCount();
            if (n)
                out.push({ level: 'warn', text: `Accounts: ${n} automatic entries are not posted yet`, href: '#/close/auto' });
            const prev = addDays(today.slice(0, 7) + '-01', -1);
            if (+today.slice(8) > 10 && lockDate() < prev && startDate() <= prev)
                out.push({ level: 'warn', text: `Accounts: ${prev.slice(0, 7)} is not closed yet`, href: '#/close/checks/' + prev.slice(0, 7) });
            if (!cache.ct || Date.now() - cache.ct > 30 * 60e3) {
                try {
                    const ch = checks(prev.slice(0, 7));
                    cache.fails = ch.checks.filter(x => x.status === 'fail').map(x => x.title);
                }
                catch (_a) {
                    cache.fails = [];
                }
                cache.ct = Date.now();
            }
            if (lockDate() < prev && (cache.fails || []).length)
                out.push({ level: 'bad', text: `Accounts ${prev.slice(0, 7)}: failing check — ${cache.fails.join(', ')}`, href: '#/close/checks/' + prev.slice(0, 7) });
            return out;
        },
        activity: { 'accounts.voucher': 'Posted voucher', 'accounts.voucher.edit': 'Edited voucher', 'accounts.voucher.void': 'Voided voucher', 'accounts.opening': 'Saved opening balances', 'accounts.autopost': 'Posted automatic entries',
            'accounts.close': 'Closed accounting month', 'accounts.reopen': 'Reopened accounting month', 'accounts.settings': 'Changed accounts settings', 'accounts.account': 'Saved account', 'accounts.account.delete': 'Deleted account' },
    };
};