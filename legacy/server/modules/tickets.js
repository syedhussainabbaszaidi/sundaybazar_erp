    // tickets module — CS tickets, exchanges, refunds & store credit, delivery follow-ups
    'use strict';
    const TYPES = ['Wrong item', 'Damaged / not as described', 'Size exchange', 'Return request', 'Refund', 'Delivery issue', 'Order inquiry', 'Complaint about staff', 'Other'];
    const CHANNELS = ['WhatsApp', 'Call', 'Instagram', 'Facebook', 'Email', 'Walk-in/outlet', 'Google Form'];
    const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    const STATUSES = { open: 'Open', waiting: 'Waiting for customer', progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
    const OPEN = "('open','waiting','progress')";
    const RESOLUTIONS = ['Exchanged', 'Refunded', 'Store credit given', 'Re-delivery arranged', 'Replacement sent', 'Information given', 'Customer cancelled', 'No action needed', 'Other'];
    const NOFIX = 'Closed without fix';
    const NOFIX_REASONS = ['Spam', 'Duplicate ticket', 'Customer not responding', 'Opened by mistake', 'Other'];
    // "whose mistake" — department responsible for a customer problem (internal ones count against a person's performance)
    const FAULT_DEPTS = [
        { k: 'listing', l: 'Listing', internal: true, hint: 'wrong size / condition / photo / price listed', reasons: ['Wrong size listed', 'Wrong condition listed', 'Wrong or misleading photo', 'Wrong price', 'Wrong brand / model', 'Defect not mentioned'] },
        { k: 'sorting', l: 'Sorting & QC', internal: true, hint: 'damaged pair passed QC', reasons: ['Damaged pair passed QC', 'Pair mismatch (left / right)', 'Not cleaned', 'Wrong grade'] },
        { k: 'warehouse', l: 'Warehouse', internal: true, hint: 'wrong location / missing pair', reasons: ['Wrong rack location', 'Pair missing', 'Damaged in storage', 'Wrong pair put away'] },
        { k: 'dispatch', l: 'Dispatch', internal: true, hint: 'wrong item packed, wrong courier / address, late', reasons: ['Wrong item packed', 'Missing item in parcel', 'Wrong address / city', 'Wrong courier', 'Late dispatch', 'Poor packing'] },
        { k: 'cs', l: 'CS', internal: true, hint: 'wrong confirmation / promise', reasons: ['Wrong order confirmation', 'Wrong promise to customer', 'Wrong address taken', 'Late or rude reply'] },
        { k: 'courier', l: 'Courier', internal: false, hint: 'PostEx / TCS / rider', reasons: ['Late delivery', 'Rider did not attempt', 'Parcel damaged or lost', 'Rider misbehaved'] },
        { k: 'supplier', l: 'Supplier', internal: false, hint: 'lot quality', reasons: ['Lot quality issue', 'Hidden defect from supplier'] },
        { k: 'customer', l: 'Customer', internal: false, hint: 'changed mind / no fault of ours', reasons: ['Changed mind', 'Ordered wrong size', 'Refused without reason', 'No fault of ours'] },
        { k: 'unknown', l: 'Unknown', internal: false, hint: 'could not find out', reasons: ['Could not find out'] },
    ];
    const FD = Object.fromEntries(FAULT_DEPTS.map(d => [d.k, d]));
    const INTERNAL = FAULT_DEPTS.filter(d => d.internal).map(d => d.k);
    const FAULT_TYPES = ['Wrong item', 'Damaged / not as described', 'Size exchange', 'Delivery issue', 'Complaint about staff'];
    const FAULT_GUESS = { 'Wrong item': 'dispatch', 'Damaged / not as described': 'sorting', 'Size exchange': 'listing', 'Delivery issue': 'courier', 'Complaint about staff': 'cs' };
    const STEPS = ['requested', 'approved', 'received', 'dispatched', 'completed'];
    const STEP_L = { requested: 'Requested', approved: 'Approved', received: 'Old item received', dispatched: 'New item dispatched', completed: 'Completed', cancelled: 'Cancelled' };
    const METHODS = ['Bank transfer', 'JazzCash', 'EasyPaisa', 'Store credit'];
    const DEF_SLA = { urgent: 2, high: 8, normal: 24, low: 72 };
    const DEF_TEMPLATES = [
        { name: 'Greeting', text: 'Assalam o Alaikum {name}! SundayBazar customer care se baat ho rahi hai. Aap ke order {order} ke baare mein aap ka message mila hai, hum abhi check kar rahe hain.' },
        { name: 'Ask for photos', text: 'Assalam o Alaikum {name}! Order {order} ka masla samajhne ke liye please shoes ki 2-3 clear pictures (label aur sole ke saath) yahan bhej dein. Shukriya!' },
        { name: 'Exchange approved', text: 'Assalam o Alaikum {name}! Aap ka exchange approve ho gaya hai (order {order}). PostEx rider purana pair le jayega aur naya pair bhej diya jayega. Shukriya!' },
        { name: 'Parcel on the way', text: 'Assalam o Alaikum {name}! Aap ka SundayBazar order {order} (PostEx {tracking}) raste mein hai. Rider call kare to please receive kar lijiye ga.' },
        { name: 'Delivery attempted', text: 'Assalam o Alaikum {name}! PostEx rider ne aap ka order {order} (tracking {tracking}) deliver karne ki koshish ki thi. Kya hum dobara bhejwa dein? Konsa time behtar hai?' },
        { name: 'Refund sent', text: 'Assalam o Alaikum {name}! Order {order} ka refund bhej diya gaya hai. Please check kar ke confirm kar dein. Takleef ke liye maazrat.' },
    ];
    const utc = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const parseUtc = s => Date.parse(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
    const J = (s, d) => { try {
        return s ? JSON.parse(s) : d;
    }
    catch (_a) {
        return d;
    } };
    module.exports = {
        name: 'tickets',
        perms: [],
        schema: `
CREATE TABLE IF NOT EXISTS tk_tickets(id INTEGER PRIMARY KEY, type TEXT, channel TEXT, subject TEXT, order_id TEXT, order_name TEXT, phone TEXT, cust_name TEXT, tracking TEXT, sku TEXT,
  priority TEXT DEFAULT 'normal', assignee INTEGER, status TEXT DEFAULT 'open', auto INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  due_at TEXT, first_response_at TEXT, resolved_at TEXT, closed_at TEXT, resolution TEXT, resolution_note TEXT, resolved_by INTEGER, reopened INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_tk_status ON tk_tickets(status);
CREATE INDEX IF NOT EXISTS ix_tk_order ON tk_tickets(order_id);
CREATE INDEX IF NOT EXISTS ix_tk_phone ON tk_tickets(phone);
CREATE INDEX IF NOT EXISTS ix_tk_assignee ON tk_tickets(assignee);
CREATE TABLE IF NOT EXISTS tk_notes(id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, user_id INTEGER, kind TEXT DEFAULT 'note', body TEXT, files TEXT, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_tk_notes ON tk_notes(ticket_id);
CREATE TABLE IF NOT EXISTS tk_exchanges(id INTEGER PRIMARY KEY, ticket_id INTEGER, order_id TEXT, order_name TEXT, phone TEXT, cust_name TEXT, old_total REAL DEFAULT 0, new_total REAL DEFAULT 0, diff REAL DEFAULT 0,
  diff_mode TEXT DEFAULT 'none', refund_method TEXT, reverse_tracking TEXT, out_tracking TEXT, step TEXT DEFAULT 'requested', note TEXT, wms_note TEXT, refund_id INTEGER, created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), requested_at TEXT DEFAULT (datetime('now')), approved_at TEXT, received_at TEXT, dispatched_at TEXT, completed_at TEXT, cancelled_at TEXT);
CREATE INDEX IF NOT EXISTS ix_tk_ex_step ON tk_exchanges(step);
CREATE TABLE IF NOT EXISTS tk_exchange_items(id INTEGER PRIMARY KEY, exchange_id INTEGER NOT NULL, dir TEXT NOT NULL, sku TEXT, title TEXT, price REAL DEFAULT 0, size TEXT);
CREATE INDEX IF NOT EXISTS ix_tk_exi ON tk_exchange_items(exchange_id);
CREATE INDEX IF NOT EXISTS ix_tk_exi_sku ON tk_exchange_items(sku);
CREATE TABLE IF NOT EXISTS tk_exchange_log(id INTEGER PRIMARY KEY, exchange_id INTEGER NOT NULL, step TEXT, user_id INTEGER, note TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tk_refunds(id INTEGER PRIMARY KEY, ticket_id INTEGER, exchange_id INTEGER, order_id TEXT, order_name TEXT, phone TEXT, cust_name TEXT, method TEXT, amount REAL, account_details TEXT, reason TEXT,
  status TEXT DEFAULT 'pending', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), approved_by INTEGER, approved_at TEXT, paid_by INTEGER, paid_at TEXT, paid_ref TEXT,
  rejected_by INTEGER, rejected_at TEXT, reject_reason TEXT, posted INTEGER DEFAULT 0, post_error TEXT, journal_id TEXT);
CREATE INDEX IF NOT EXISTS ix_tk_ref_status ON tk_refunds(status);
CREATE INDEX IF NOT EXISTS ix_tk_ref_phone ON tk_refunds(phone);
`,
        migrate(ctx) {
            const have = new Set(ctx.q.all('PRAGMA table_info(tk_tickets)').map(c => c.name));
            for (const [col, t] of [['fault_dept', 'TEXT'], ['fault_user_id', 'INTEGER'], ['fault_reason', 'TEXT'], ['fault_note', 'TEXT'], ['fault_cost', 'REAL'], ['fault_by', 'INTEGER'], ['fault_at', 'TEXT']])
                if (!have.has(col))
                    ctx.db.exec(`ALTER TABLE tk_tickets ADD COLUMN ${col} ${t}`);
            ctx.db.exec('CREATE INDEX IF NOT EXISTS ix_tk_fault ON tk_tickets(fault_user_id, resolved_at)');
        },
        routes(ctx) {
            const { route, q, need, can, log, setting, setSetting, A, L, pkToday } = ctx;
            const sla = () => (Object.assign(Object.assign({}, DEF_SLA), (setting('tickets.sla', {}) || {})));
            const dueFrom = (fromMs, pr) => utc(fromMs + (+sla()[pr] || 24) * 3600e3);
            const isApprover = u => can(u, 'finance') || u.role === 'admin';
            const isAdminish = u => can(u, 'settings') || u.role === 'admin' || u.role === 'manager';
            const agents = () => q.all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name').filter(x => A.userPerms(x).includes('tickets')).map(x => ({ id: x.id, name: x.name, role: x.role, tracking: A.userPerms(x).includes('tracking') }));
            const sysNote = (tid, uid, body) => q.run("INSERT INTO tk_notes(ticket_id,user_id,kind,body) VALUES(?,?,'system',?)", tid, uid || null, body);
            const touch = id => q.run("UPDATE tk_tickets SET updated_at=datetime('now') WHERE id=?", id);
            const getT = id => { const t = q.get('SELECT * FROM tk_tickets WHERE id=?', +id); need(t, 'Ticket not found', 404); return t; };
            const userName = id => id ? ((q.get('SELECT name FROM users WHERE id=?', id) || {}).name || '#' + id) : 'nobody';
            function orderBrief(o) {
                if (!o)
                    return null;
                const c = q.get('SELECT label, delivered, returned, orders, cancelled FROM customers WHERE phone=?', o.phone) || {};
                const items = q.all('SELECT i.sku, i.title, i.qty, i.price, pr.size, pr.brand, pr.cond FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE i.order_id=?', o.id);
                return { id: o.id, name: o.name, created_at: o.created_at, cust_name: o.cust_name, phone: o.phone, city: o.city, address: o.address, total: o.total, status: o.status, tracking: o.tracking, px_status: o.px_status, px_updated: o.px_updated,
                    delivered_at: o.delivered_at, clabel: c.label || 'New', cdel: c.delivered || 0, cret: c.returned || 0, corders: c.orders || 0, items, wa: L.waNumber(o.phone) };
            }
            function findOrders(term) {
                const t = String(term || '').trim();
                if (!t)
                    return [];
                const up = t.toUpperCase(), nm = /^\d{3,7}$/.test(t) ? 'SB' + t : up, ph = L.normPhone(t);
                const usePh = ph.length >= 10 && /^[\d\s+\-]+$/.test(t);
                return q.all(`SELECT * FROM orders WHERE name=? OR name=? OR tracking=? OR id=? ${usePh ? 'OR phone=?' : ''} ORDER BY created_at DESC LIMIT 15`, t, nm, t, t, ...(usePh ? [ph] : [])).map(orderBrief);
            }
            const findOrder = ref => ref ? q.get('SELECT * FROM orders WHERE id=? OR name=?', String(ref), String(ref).toUpperCase()) : null;
            /* ---------- whose mistake: suggestions from the data ---------- */
            const hasTable = n => !!q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", n);
            const pkDay = s => s ? new Date(parseUtc(s) + 5 * 3600e3).toISOString().slice(0, 10) : '';
            function faultSuggest(t) {
                const out = Object.fromEntries(INTERNAL.map(k => [k, []]));
                const add = (dept, uid, why) => { if (!uid)
                    return; const l = out[dept], x = l.find(c => c.user_id === +uid); if (x) {
                    if (!x.why.includes(why))
                        x.why.push(why);
                    return;
                } l.push({ user_id: +uid, name: userName(+uid), why: [why] }); };
                const o = t.order_id ? q.get('SELECT * FROM orders WHERE id=?', t.order_id) : null;
                const items = o ? q.all('SELECT sku, picked_by, picked_at FROM order_items WHERE order_id=?', o.id) : [];
                const skus = [...new Set((t.sku ? [t.sku] : items.map(i => i.sku)).filter(Boolean).map(s => String(s)))];
                const sl = hasTable('sl_items'), qc = hasTable('sl_qc'), so = hasTable('sl_sort');
                for (const sku of skus) {
                    const li = q.get('SELECT user_id, at, lot FROM listings WHERE UPPER(sku)=UPPER(?)', sku);
                    if (li && li.user_id)
                        add('listing', li.user_id, `listed ${sku}${li.at ? ' on ' + pkDay(li.at) : ''}`);
                    const si = sl ? q.get('SELECT * FROM sl_items WHERE UPPER(sku)=UPPER(?)', sku) : null;
                    if (si && si.listed_by && !(li && li.user_id))
                        add('listing', si.listed_by, `listed ${sku}`);
                    const lot = (li && li.lot) || (si && si.lot) || (q.get('SELECT lot FROM products WHERE UPPER(sku)=UPPER(?)', sku) || {}).lot;
                    if (lot && qc)
                        for (const r of q.all('SELECT user_id, SUM(passed) n, MAX(at) at FROM sl_qc WHERE lot=? AND user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC', lot))
                            add('sorting', r.user_id, `QC of lot ${lot}`);
                    if (lot && so) {
                        const s = q.get('SELECT sorted_by FROM sl_sort WHERE lot=?', lot);
                        if (s && s.sorted_by)
                            add('sorting', s.sorted_by, `sorted lot ${lot}`);
                    }
                    const before = o && (o.picked_at || o.packed_at) ? (o.picked_at || o.packed_at) : null;
                    const mv = q.get(`SELECT user_id, to_loc, at FROM stock_moves WHERE UPPER(sku)=UPPER(?) AND user_id IS NOT NULL ${before ? 'AND at<=?' : ''} ORDER BY at DESC, id DESC LIMIT 1`, sku, ...(before ? [before] : []));
                    if (mv)
                        add('warehouse', mv.user_id, `put ${sku} at ${mv.to_loc || 'a rack'}`);
                    else if (si && si.located_by)
                        add('warehouse', si.located_by, `put ${sku} on rack ${si.location || ''}`.trim());
                    for (const i of items.filter(i => String(i.sku).toUpperCase() === sku.toUpperCase() && i.picked_by))
                        add('dispatch', i.picked_by, `picked ${sku}`);
                }
                if (o) {
                    for (const e of q.all("SELECT DISTINCT user_id FROM events WHERE entity=? AND action='pack' AND user_id IS NOT NULL", 'order:' + o.id))
                        add('dispatch', e.user_id, `packed ${o.name}`);
                    for (const e of q.all("SELECT DISTINCT user_id FROM events WHERE entity=? AND action IN ('couriers.book','book') AND user_id IS NOT NULL", 'order:' + o.id))
                        add('dispatch', e.user_id, `booked courier for ${o.name}`);
                    if (o.cs_by)
                        add('cs', o.cs_by, `confirmed ${o.name}`);
                    for (const c of q.all('SELECT DISTINCT user_id FROM cs_calls WHERE order_id=? AND user_id IS NOT NULL ORDER BY at DESC LIMIT 3', o.id))
                        add('cs', c.user_id, `called about ${o.name}`);
                }
                for (const k of INTERNAL)
                    out[k] = out[k].map(c => (Object.assign(Object.assign({}, c), { why: c.why.join(', ') })));
                const dept = t.fault_dept || FAULT_GUESS[t.type] || null;
                const best = dept ? { dept, user_id: t.fault_user_id || (FD[dept].internal && out[dept][0] ? out[dept][0].user_id : null) } : null;
                return { people: out, best, skus, required: FAULT_TYPES.includes(t.type) };
            }
            // validate + normalise the fault fields sent with resolve / close / fault update
            function faultIn(t, b, { required }) {
                var _a;
                const dept = b.fault_dept || null;
                if (!dept) {
                    need(!required, `Say whose mistake it was ("${t.type}" is a customer problem)`);
                    return null;
                }
                need(FD[dept], 'Unknown department');
                let uid = b.fault_user_id === 'auto' ? ((_a = (faultSuggest(t).people[dept] || [])[0]) === null || _a === void 0 ? void 0 : _a.user_id) || null : (b.fault_user_id ? +b.fault_user_id : null);
                if (FD[dept].internal) {
                    need(uid, `Pick the person in ${FD[dept].l} who made the mistake`);
                    need(q.get('SELECT id FROM users WHERE id=?', uid), 'Unknown staff member');
                }
                else
                    uid = null;
                const cost = b.fault_cost === '' || b.fault_cost == null ? null : +b.fault_cost;
                need(cost == null || (cost >= 0 && cost < 1e7), 'Cost must be a number');
                return { fault_dept: dept, fault_user_id: uid, fault_reason: String(b.fault_reason || '').slice(0, 120) || null, fault_note: String(b.fault_note || '').slice(0, 1000) || null, fault_cost: cost };
            }
            function saveFault(t, f, uid) {
                if (!f)
                    return;
                q.run("UPDATE tk_tickets SET fault_dept=?, fault_user_id=?, fault_reason=?, fault_note=?, fault_cost=?, fault_by=?, fault_at=datetime('now') WHERE id=?", f.fault_dept, f.fault_user_id, f.fault_reason, f.fault_note, f.fault_cost, uid || null, t.id);
                sysNote(t.id, uid, `Whose mistake: ${FD[f.fault_dept].l}${f.fault_user_id ? ' · ' + userName(f.fault_user_id) : ''}${f.fault_reason ? ' · ' + f.fault_reason : ''}`);
                log(uid || null, 'ticket.fault', f.fault_user_id ? 'user:' + f.fault_user_id : 'ticket:' + t.id, { ticket: t.id, dept: f.fault_dept, reason: f.fault_reason, cost: f.fault_cost });
            }
            // resolve (and optionally close) one ticket; b = { resolution, note, close, fault_* }
            function resolveTicket(t, b, u, opts = {}) {
                need(!['resolved', 'closed'].includes(t.status) || (opts.closeResolved && t.status === 'resolved'), 'Ticket is already ' + t.status);
                if (t.status === 'resolved') {
                    setStatus(t, 'closed', u);
                    touch(t.id);
                    return;
                }
                need(RESOLUTIONS.includes(b.resolution), 'Pick how it was resolved');
                const f = faultIn(t, b, { required: !opts.auto && FAULT_TYPES.includes(t.type) && !t.fault_dept });
                const st = b.close ? 'closed' : 'resolved', uid = u ? u.id : null;
                q.run(`UPDATE tk_tickets SET status=?, resolution=?, resolution_note=?, resolved_at=datetime('now'), closed_at=${b.close ? "datetime('now')" : 'NULL'}, resolved_by=?, first_response_at=COALESCE(first_response_at, datetime('now')),
        assignee=COALESCE(assignee, ?), updated_at=datetime('now') WHERE id=?`, st, b.resolution, String(b.note || '').slice(0, 2000), uid, opts.auto ? null : uid, t.id);
                saveFault(t, f, uid);
                sysNote(t.id, uid, (opts.auto ? 'Auto-resolved: ' : b.close ? 'Resolved & closed: ' : 'Resolved: ') + b.resolution + (b.note ? ' · ' + b.note : ''));
                log(uid, opts.auto ? 'ticket.autoresolve' : 'ticket.resolve', 'ticket:' + t.id, { resolution: b.resolution, close: !!b.close, fault: f ? f.fault_dept : null });
            }
            function closeNoFix(t, b, u) {
                need(!['resolved', 'closed'].includes(t.status), 'Ticket is already ' + t.status);
                const reason = NOFIX_REASONS.includes(b.reason) ? b.reason : null;
                need(reason, 'Pick why it is closed without a fix');
                const note = reason + (b.note ? ' · ' + String(b.note).slice(0, 500) : '');
                q.run(`UPDATE tk_tickets SET status='closed', resolution=?, resolution_note=?, resolved_at=datetime('now'), closed_at=datetime('now'), resolved_by=?, updated_at=datetime('now') WHERE id=?`, NOFIX, note, u.id, t.id);
                sysNote(t.id, u.id, 'Closed without fix: ' + note);
                log(u.id, 'ticket.close', 'ticket:' + t.id, { reason });
            }
            // exchange completed / refund paid → resolve the parent ticket if it is still open
            function autoResolveParent(tid, resolution, why, uid, fault) {
                const t = tid ? q.get('SELECT * FROM tk_tickets WHERE id=?', tid) : null;
                if (!t || ['resolved', 'closed'].includes(t.status))
                    return false;
                let f = null;
                try {
                    if (fault && fault.fault_dept)
                        f = faultIn(t, fault, { required: false });
                }
                catch (e) {
                    sysNote(t.id, uid, 'Whose mistake not saved: ' + e.message);
                }
                resolveTicket(t, { resolution, note: 'Auto: ' + why }, uid ? { id: uid } : null, { auto: true });
                if (f)
                    saveFault(t, f, uid);
                return true;
            }
            /* ---------- tickets ---------- */
            function createTicket(b, uid, opts = {}) {
                need(TYPES.includes(b.type), 'Pick a ticket type');
                const channel = CHANNELS.includes(b.channel) ? b.channel : 'WhatsApp';
                const pr = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
                const o = findOrder(b.order_id || b.order_name);
                need(!(b.order_id || b.order_name) || o, 'Order not found');
                const phone = L.normPhone(b.phone || (o && o.phone) || '');
                need(phone || o, 'Add the customer phone number or link an order');
                const assignee = b.assignee ? +b.assignee : null;
                if (assignee)
                    need(q.get('SELECT id FROM users WHERE id=? AND active=1', assignee), 'Unknown staff member');
                let sku = b.sku || null;
                if (!sku && o) {
                    const its = q.all('SELECT sku FROM order_items WHERE order_id=?', o.id);
                    if (its.length === 1)
                        sku = its[0].sku;
                }
                const subject = String(b.subject || '').trim().slice(0, 200) || (b.type + (o ? ' · ' + o.name : ''));
                const id = q.tx(() => {
                    const r = q.run(`INSERT INTO tk_tickets(type,channel,subject,order_id,order_name,phone,cust_name,tracking,sku,priority,assignee,status,auto,created_by,due_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`, b.type, channel, subject, o ? o.id : null, o ? o.name : null, phone, String(b.cust_name || (o && o.cust_name) || '').slice(0, 120), (o && o.tracking) || b.tracking || null, sku, pr, assignee, opts.auto ? 1 : 0, uid || null, dueFrom(Date.now(), pr));
                    const tid = Number(r.lastInsertRowid);
                    if (b.note || (b.files && b.files.length))
                        q.run("INSERT INTO tk_notes(ticket_id,user_id,kind,body,files) VALUES(?,?,'note',?,?)", tid, uid || null, String(b.note || ''), JSON.stringify(b.files || []));
                    return tid;
                });
                log(uid || null, 'ticket.create', 'ticket:' + id, { type: b.type, order: o ? o.name : null, auto: !!opts.auto });
                return id;
            }
            function listWhere(qs, u) {
                const w = [], a = [];
                const v = qs.view || 'mine';
                if (v === 'mine') {
                    w.push(`t.assignee=? AND t.status IN ${OPEN}`);
                    a.push(u.id);
                }
                else if (v === 'unassigned')
                    w.push(`t.assignee IS NULL AND t.status IN ${OPEN}`);
                else if (v === 'overdue')
                    w.push(`t.status IN ('open','progress') AND t.due_at<datetime('now')`);
                else if (v === 'waiting')
                    w.push(`t.status='waiting'`);
                else if (v === 'open')
                    w.push(`t.status IN ${OPEN}`);
                else if (v === 'done')
                    w.push(`t.status IN ('resolved','closed')`);
                else if (v === 'nofault') {
                    w.push(`t.status IN ('resolved','closed') AND t.fault_dept IS NULL AND t.type IN (${FAULT_TYPES.map(() => '?').join(',')}) AND COALESCE(t.resolution,'')<>'${NOFIX}'`);
                    a.push(...FAULT_TYPES);
                }
                if (qs.fault_dept) {
                    w.push('t.fault_dept=?');
                    a.push(qs.fault_dept);
                }
                if (qs.fault_user) {
                    w.push('t.fault_user_id=?');
                    a.push(+qs.fault_user);
                }
                if (qs.month && /^\d{4}-\d{2}$/.test(qs.month)) {
                    w.push("substr(datetime(t.resolved_at,'+5 hours'),1,7)=?");
                    a.push(qs.month);
                }
                for (const k of ['type', 'channel', 'priority', 'status'])
                    if (qs[k]) {
                        w.push(`t.${k}=?`);
                        a.push(qs[k]);
                    }
                if (qs.assignee) {
                    if (qs.assignee === 'none')
                        w.push('t.assignee IS NULL');
                    else {
                        w.push('t.assignee=?');
                        a.push(+qs.assignee);
                    }
                }
                if (qs.q) {
                    const s = String(qs.q).trim(), t = '%' + s + '%', ph = L.normPhone(s), idm = /^t-?(\d+)$/i.exec(s);
                    if (idm) {
                        w.push('t.id=?');
                        a.push(+idm[1]);
                    }
                    else {
                        w.push(`(t.subject LIKE ? OR t.cust_name LIKE ? OR t.order_name LIKE ? OR t.tracking LIKE ? OR t.sku LIKE ?${ph.length >= 7 ? ' OR t.phone LIKE ?' : ''})`);
                        a.push(t, t, t, t, t);
                        if (ph.length >= 7)
                            a.push('%' + ph + '%');
                    }
                }
                return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
            }
            const T_COLS = `t.*, us.name assignee_name, fu.name fault_user_name, c.label clabel, (t.status IN ('open','progress') AND t.due_at<datetime('now')) overdue,
      (SELECT COUNT(*) FROM tk_notes n WHERE n.ticket_id=t.id AND n.kind<>'system') nnotes`;
            route('GET', '/api/tickets/meta', 'tickets', (req, u) => ({ types: TYPES, channels: CHANNELS, priorities: PRIORITIES, statuses: STATUSES, resolutions: RESOLUTIONS, steps: STEP_L, methods: METHODS,
                agents: agents(), sla: sla(), faultDepts: FAULT_DEPTS, faultTypes: FAULT_TYPES, nofixReasons: NOFIX_REASONS,
                staff: q.all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'), templates: setting('tickets.templates', DEF_TEMPLATES), auto: setting('tickets.auto_attempted', true), canApprove: isApprover(u), canSettings: isAdminish(u) }));
            route('GET', '/api/tickets', 'tickets', (req, u, b, res, p, qs) => {
                const f = listWhere(qs, u), pg = ctx.page(qs, 50);
                const order = qs.view === 'all' || qs.view === 'done' ? 't.id DESC' : `overdue DESC, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at`;
                const rows = q.all(`SELECT ${T_COLS} FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee LEFT JOIN users fu ON fu.id=t.fault_user_id LEFT JOIN customers c ON c.phone=t.phone ${f.where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...f.args, pg.limit, pg.offset);
                const total = q.get(`SELECT COUNT(*) n FROM tk_tickets t ${f.where}`, ...f.args).n;
                const counts = q.get(`SELECT SUM(assignee=? AND status IN ${OPEN}) mine, SUM(assignee IS NULL AND status IN ${OPEN}) unassigned, SUM(status IN ('open','progress') AND due_at<datetime('now')) overdue,
        SUM(status='waiting') waiting, SUM(status IN ${OPEN}) open, COUNT(*) total,
        SUM(status IN ('resolved','closed') AND fault_dept IS NULL AND type IN (${FAULT_TYPES.map(() => '?').join(',')}) AND COALESCE(resolution,'')<>'${NOFIX}') nofault FROM tk_tickets`, u.id, ...FAULT_TYPES);
                for (const k in counts)
                    counts[k] = counts[k] || 0;
                return { rows, total, page: pg.page, pages: Math.ceil(total / pg.limit), counts };
            });
            route('GET', '/api/tickets/lookup', 'tickets', (req, u, b, res, p, qs) => ({ orders: findOrders(qs.q) }));
            route('POST', '/api/tickets', 'tickets', (req, u, b) => ({ id: createTicket(b, u.id) }));
            route('POST', '/api/tickets/bulk', 'tickets', (req, u, b) => {
                const ids = (b.ids || []).map(Number).filter(Boolean);
                need(ids.length, 'Select tickets first');
                let assignee;
                if ('assignee' in b) {
                    assignee = b.assignee ? +b.assignee : null;
                    if (assignee)
                        need(q.get('SELECT id FROM users WHERE id=? AND active=1', assignee), 'Unknown staff member');
                }
                if (b.status)
                    need(['open', 'waiting', 'progress', 'closed'].includes(b.status), 'Use Resolve to resolve tickets');
                const skipped = [], errors = [];
                q.tx(() => {
                    for (const id of ids) {
                        const t = q.get('SELECT * FROM tk_tickets WHERE id=?', id);
                        if (!t)
                            continue;
                        if (assignee !== undefined && t.assignee !== assignee) {
                            q.run('UPDATE tk_tickets SET assignee=? WHERE id=?', assignee, id);
                            sysNote(id, u.id, 'Assigned to ' + userName(assignee));
                            log(u.id, 'ticket.assign', 'ticket:' + id, { to: assignee, bulk: true });
                        }
                        if (b.resolve) { // bulk "Resolve & close": same resolution + whose mistake for all (person 'auto' = each ticket's suggested person)
                            if (['resolved', 'closed'].includes(t.status)) {
                                if (t.status === 'resolved' && b.resolve.close)
                                    setStatus(t, 'closed', u);
                            }
                            else {
                                try {
                                    resolveTicket(t, Object.assign({}, b.resolve), u);
                                }
                                catch (e) {
                                    skipped.push(id);
                                    errors.push(`T-${id}: ${e.message}`);
                                    continue;
                                }
                            }
                        }
                        else if (b.nofix) {
                            if (!['resolved', 'closed'].includes(t.status))
                                closeNoFix(t, b.nofix, u);
                        }
                        else if (b.status && t.status !== b.status) {
                            if (['resolved', 'closed'].includes(t.status) && b.status !== 'closed') {
                                skipped.push(id);
                                continue;
                            }
                            if (b.status === 'closed' && t.status !== 'resolved' && FAULT_TYPES.includes(t.type) && !t.fault_dept) {
                                skipped.push(id);
                                continue;
                            }
                            setStatus(t, b.status, u);
                        }
                        touch(id);
                    }
                });
                return { ok: true, n: ids.length - skipped.length, skipped, errors };
            });
            function setStatus(t, st, u) {
                const extra = st === 'closed' ? ", closed_at=datetime('now'), resolved_at=COALESCE(resolved_at, datetime('now')), resolution=COALESCE(resolution, 'No action needed')" : '';
                q.run(`UPDATE tk_tickets SET status=?${extra}, first_response_at=CASE WHEN ?='waiting' THEN COALESCE(first_response_at, datetime('now')) ELSE first_response_at END WHERE id=?`, st, st, t.id);
                sysNote(t.id, u.id, `Status: ${STATUSES[t.status]} → ${STATUSES[st]}`);
                log(u.id, 'ticket.status', 'ticket:' + t.id, { from: t.status, to: st });
            }
            /* customer 360 */
            route('GET', '/api/tickets/customer/:phone', 'tickets', (req, u, b, res, p) => {
                const ph = L.normPhone(decodeURIComponent(p.phone));
                need(ph, 'No phone number');
                const orders = q.all(`SELECT o.id,o.name,o.created_at,o.total,o.status,o.tracking,o.city,(SELECT group_concat(title || ' (' || sku || ')', ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o WHERE o.phone=? ORDER BY o.created_at DESC LIMIT 100`, ph);
                const credit = q.get(`SELECT COALESCE(SUM(amount),0) n FROM tk_refunds WHERE phone=? AND method='Store credit' AND status IN ('approved','paid')`, ph).n;
                return {
                    phone: ph, wa: L.waNumber(ph), customer: q.get('SELECT * FROM customers WHERE phone=?', ph) || null, flag: q.get('SELECT * FROM customer_flags WHERE phone=?', ph) || null, orders,
                    returns: q.all('SELECT r.*, o.name order_name FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.phone=? ORDER BY r.id DESC LIMIT 50', ph),
                    tickets: q.all('SELECT t.id,t.type,t.status,t.subject,t.created_at,t.order_name,t.resolution,us.name assignee_name FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee WHERE t.phone=? ORDER BY t.id DESC LIMIT 50', ph),
                    exchanges: q.all('SELECT id,step,order_name,diff,created_at FROM tk_exchanges WHERE phone=? ORDER BY id DESC LIMIT 50', ph),
                    refunds: q.all('SELECT id,method,amount,status,created_at,order_name FROM tk_refunds WHERE phone=? ORDER BY id DESC LIMIT 50', ph), storeCredit: credit,
                };
            });
            /* settings */
            route('GET', '/api/tickets/settings', 'tickets', () => ({ sla: sla(), templates: setting('tickets.templates', DEF_TEMPLATES), auto: setting('tickets.auto_attempted', true) }));
            route('POST', '/api/tickets/settings', 'tickets', (req, u, b) => {
                need(isAdminish(u), 'Only the owner or a manager can change ticket settings', 403);
                if (b.sla) {
                    const s = {};
                    for (const k of PRIORITIES) {
                        const v = +b.sla[k];
                        need(v > 0 && v <= 720, 'SLA hours must be between 1 and 720');
                        s[k] = v;
                    }
                    setSetting('tickets.sla', s);
                }
                if (Array.isArray(b.templates))
                    setSetting('tickets.templates', b.templates.filter(t => t && t.name && t.text).map(t => ({ name: String(t.name).slice(0, 60), text: String(t.text).slice(0, 1000) })));
                if ('auto' in b)
                    setSetting('tickets.auto_attempted', !!b.auto);
                log(u.id, 'settings.save', 'tickets', Object.keys(b));
                return { ok: true };
            });
            /* delivery follow-ups */
            function autoAttempted() {
                const out = { created: 0, resolved: 0 };
                // auto-resolve auto tickets whose order got delivered / returned
                for (const t of q.all(`SELECT t.id, o.status ost FROM tk_tickets t JOIN orders o ON o.id=t.order_id WHERE t.auto=1 AND t.status IN ${OPEN} AND o.status IN ('delivered','returned','return_received')`)) {
                    const res = t.ost === 'delivered' ? 'Re-delivery arranged' : 'Customer cancelled';
                    q.run(`UPDATE tk_tickets SET status='resolved', resolution=?, resolution_note=?, resolved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, res, 'Auto: order is now ' + t.ost.replace('_', ' '), t.id);
                    sysNote(t.id, null, 'Auto-resolved: order is now ' + t.ost.replace('_', ' '));
                    log(null, 'ticket.autoresolve', 'ticket:' + t.id, t.ost);
                    out.resolved++;
                }
                if (!setting('tickets.auto_attempted', true))
                    return out;
                const orders = q.all(`SELECT o.* FROM orders o WHERE o.status='attempted'
        AND NOT EXISTS (SELECT 1 FROM tk_tickets t WHERE t.order_id=o.id AND t.status IN ${OPEN})
        AND NOT EXISTS (SELECT 1 FROM tk_tickets t WHERE t.order_id=o.id AND t.auto=1 AND t.resolved_at >= replace(substr(COALESCE(o.px_updated,''),1,19),'T',' '))
        ORDER BY o.px_updated`);
                if (!orders.length)
                    return out;
                let pool = agents().filter(a => a.tracking && a.role !== 'admin');
                if (!pool.length)
                    pool = agents().filter(a => a.tracking);
                pool.sort((a, b) => a.id - b.id);
                let last = +setting('tickets.rr_last', 0) || 0;
                for (const o of orders) {
                    let assignee = null;
                    if (pool.length) {
                        const i = pool.findIndex(a => a.id > last);
                        const a = pool[i >= 0 ? i : 0];
                        assignee = a.id;
                        last = a.id;
                    }
                    createTicket({ type: 'Delivery issue', channel: 'Call', order_id: o.id, priority: 'high', assignee, subject: `Delivery attempted · ${o.name}`, note: `PostEx: ${o.px_status || 'attempted'}. Call the customer and arrange re-delivery.` }, null, { auto: true });
                    out.created++;
                }
                setSetting('tickets.rr_last', last);
                return out;
            }
            route('POST', '/api/tickets/auto/run', 'tickets', (req, u) => { const r = autoAttempted(); log(u.id, 'ticket.autorun', 'tickets', r); return r; });
            ctx._tkAuto = autoAttempted;
            /* reports */
            route('GET', '/api/tickets/report', 'tickets', (req, u, b, res, p, qs) => {
                const days = Math.min(365, Math.max(7, +qs.days || 30)), since = `datetime('now','-${days} days')`;
                const W = `created_at>=${since}`;
                const byType = q.all(`SELECT type k, COUNT(*) n, SUM(status IN ('resolved','closed')) done FROM tk_tickets WHERE ${W} GROUP BY type ORDER BY n DESC`);
                const byChannel = q.all(`SELECT channel k, COUNT(*) n FROM tk_tickets WHERE ${W} GROUP BY channel ORDER BY n DESC`);
                const byAgent = q.all(`SELECT COALESCE(us.name,'Unassigned') k, COUNT(*) n, SUM(t.status IN ('resolved','closed')) done, SUM(t.status IN ${OPEN}) open,
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at)-julianday(t.created_at))*24 END),1) avg_res,
        SUM(t.status IN ('open','progress') AND t.due_at<datetime('now')) overdue FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee WHERE t.${W} GROUP BY t.assignee ORDER BY n DESC`);
                const opened = q.all(`SELECT date(created_at,'+5 hours') d, COUNT(*) n FROM tk_tickets WHERE ${W} GROUP BY d`);
                const resolved = q.all(`SELECT date(resolved_at,'+5 hours') d, COUNT(*) n FROM tk_tickets WHERE resolved_at>=${since} GROUP BY d`);
                const perDay = [], om = Object.fromEntries(opened.map(r => [r.d, r.n])), rm = Object.fromEntries(resolved.map(r => [r.d, r.n]));
                for (let i = Math.min(days, 30) - 1; i >= 0; i--) {
                    const d = new Date(Date.now() + 5 * 3600e3 - i * 864e5).toISOString().slice(0, 10);
                    perDay.push({ day: d, opened: om[d] || 0, resolved: rm[d] || 0 });
                }
                const times = q.get(`SELECT ROUND(AVG(CASE WHEN first_response_at IS NOT NULL THEN (julianday(first_response_at)-julianday(created_at))*24 END),1) frt,
        ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at)-julianday(created_at))*24 END),1) res,
        SUM((resolved_at IS NOT NULL AND resolved_at>due_at) OR (resolved_at IS NULL AND status IN ('open','progress') AND due_at<datetime('now'))) breaches, COUNT(*) total,
        SUM(status IN ${OPEN}) open FROM tk_tickets WHERE ${W}`);
                const m = pkToday().slice(0, 7);
                const ex = q.get(`SELECT COUNT(*) n, SUM(step='completed') done, SUM(step NOT IN ('completed','cancelled')) open, COALESCE(SUM(CASE WHEN diff>0 AND step<>'cancelled' THEN diff END),0) extra,
        COALESCE(SUM(CASE WHEN diff<0 AND step<>'cancelled' THEN -diff END),0) back FROM tk_exchanges WHERE substr(datetime(created_at,'+5 hours'),1,7)=?`, m);
                const rf = q.get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status IN ('approved','paid') THEN amount END),0) approved, COALESCE(SUM(CASE WHEN status='paid' AND method<>'Store credit' THEN amount END),0) paid,
        COALESCE(SUM(CASE WHEN status IN ('approved','paid') AND method='Store credit' THEN amount END),0) credit, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending FROM tk_refunds WHERE substr(datetime(created_at,'+5 hours'),1,7)=?`, m);
                // problem SKUs: ticket sku, or every item on the linked order
                const probs = q.all(`SELECT COALESCE(t.sku, i.sku) sku, t.type FROM tk_tickets t LEFT JOIN order_items i ON t.sku IS NULL AND i.order_id=t.order_id
        WHERE t.${W} AND t.type IN ('Wrong item','Damaged / not as described')`).filter(r => r.sku);
                const skuMap = {}, brandMap = {};
                for (const r of probs) {
                    const pr = q.get('SELECT title, brand FROM products WHERE UPPER(sku)=UPPER(?)', r.sku) || {};
                    const s = skuMap[r.sku] || (skuMap[r.sku] = { sku: r.sku, title: pr.title || '', brand: pr.brand || '', wrong: 0, damaged: 0, n: 0 });
                    s.n++;
                    if (r.type === 'Wrong item')
                        s.wrong++;
                    else
                        s.damaged++;
                    const bk = pr.brand || 'Unknown';
                    brandMap[bk] = (brandMap[bk] || 0) + 1;
                }
                const FW = `t.resolved_at>=${since} AND t.status IN ('resolved','closed') AND t.fault_dept IS NOT NULL`;
                const byFault = q.all(`SELECT t.fault_dept k, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost, COUNT(DISTINCT t.fault_user_id) people FROM tk_tickets t WHERE ${FW} GROUP BY t.fault_dept ORDER BY n DESC`)
                    .map(r => (Object.assign(Object.assign({}, r), { label: (FD[r.k] || {}).l || r.k, internal: !!(FD[r.k] || {}).internal, reasons: q.all(`SELECT COALESCE(fault_reason,'(no reason)') k, COUNT(*) n FROM tk_tickets t WHERE ${FW} AND t.fault_dept=? GROUP BY 1 ORDER BY n DESC LIMIT 3`, r.k) })));
                const byFaultPerson = q.all(`SELECT t.fault_user_id id, us.name k, t.fault_dept dept, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost, group_concat(t.id) ids FROM tk_tickets t LEFT JOIN users us ON us.id=t.fault_user_id
        WHERE ${FW} AND t.fault_user_id IS NOT NULL GROUP BY t.fault_user_id, t.fault_dept ORDER BY n DESC LIMIT 30`).map(r => (Object.assign(Object.assign({}, r), { deptLabel: (FD[r.dept] || {}).l || r.dept, ids: String(r.ids || '').split(',').map(Number).slice(-10) })));
                const noFault = q.get(`SELECT COUNT(*) n FROM tk_tickets t WHERE t.resolved_at>=${since} AND t.status IN ('resolved','closed') AND t.fault_dept IS NULL AND t.type IN (${FAULT_TYPES.map(() => '?').join(',')}) AND COALESCE(t.resolution,'')<>'${NOFIX}'`, ...FAULT_TYPES).n;
                return { days, byType, byChannel, byAgent, perDay, byFault, byFaultPerson, noFault, times, exchanges: ex, refunds: rf, month: m,
                    topSkus: Object.values(skuMap).sort((a, b) => b.n - a.n).slice(0, 15), topBrands: Object.entries(brandMap).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 10) };
            });
            route('GET', '/api/tickets/:id', 'tickets', (req, u, b, res, p) => {
                const t = q.get(`SELECT ${T_COLS} FROM tk_tickets t LEFT JOIN users us ON us.id=t.assignee LEFT JOIN users fu ON fu.id=t.fault_user_id LEFT JOIN customers c ON c.phone=t.phone WHERE t.id=?`, +p.id);
                need(t, 'Ticket not found', 404);
                const notes = q.all('SELECT n.*, us.name user FROM tk_notes n LEFT JOIN users us ON us.id=n.user_id WHERE ticket_id=? ORDER BY n.id', t.id).map(n => (Object.assign(Object.assign({}, n), { files: J(n.files, []) })));
                const order = orderBrief(t.order_id ? q.get('SELECT * FROM orders WHERE id=?', t.order_id) : null);
                const flag = t.phone ? q.get('SELECT blacklist, vip, note FROM customer_flags WHERE phone=?', t.phone) : null;
                const prev = t.phone ? q.all(`SELECT id,type,status,created_at,order_name FROM tk_tickets WHERE phone=? AND id<>? ORDER BY id DESC LIMIT 10`, t.phone, t.id) : [];
                const exchanges = q.all('SELECT id, step, diff, created_at FROM tk_exchanges WHERE ticket_id=? ORDER BY id DESC', t.id);
                const refunds = q.all('SELECT id, method, amount, status, created_at FROM tk_refunds WHERE ticket_id=? ORDER BY id DESC', t.id);
                return { ticket: t, notes, order, flag, prev, exchanges, refunds, wa: t.phone ? L.waNumber(t.phone) : '' };
            });
            route('POST', '/api/tickets/:id', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id), ch = [];
                q.tx(() => {
                    if (b.priority && b.priority !== t.priority) {
                        need(PRIORITIES.includes(b.priority), 'Unknown priority');
                        q.run('UPDATE tk_tickets SET priority=?, due_at=? WHERE id=?', b.priority, dueFrom(parseUtc(t.created_at), b.priority), t.id);
                        ch.push(`Priority: ${t.priority} → ${b.priority}`);
                    }
                    if ('assignee' in b) {
                        const a = b.assignee ? +b.assignee : null;
                        if (a !== t.assignee) {
                            if (a)
                                need(q.get('SELECT id FROM users WHERE id=? AND active=1', a), 'Unknown staff member');
                            q.run('UPDATE tk_tickets SET assignee=? WHERE id=?', a, t.id);
                            ch.push('Assigned to ' + userName(a));
                            log(u.id, 'ticket.assign', 'ticket:' + t.id, { to: a });
                        }
                    }
                    if (b.type && b.type !== t.type) {
                        need(TYPES.includes(b.type), 'Unknown type');
                        q.run('UPDATE tk_tickets SET type=? WHERE id=?', b.type, t.id);
                        ch.push('Type: ' + b.type);
                    }
                    if (b.channel && b.channel !== t.channel) {
                        need(CHANNELS.includes(b.channel), 'Unknown channel');
                        q.run('UPDATE tk_tickets SET channel=? WHERE id=?', b.channel, t.id);
                    }
                    if (b.subject != null && b.subject !== t.subject)
                        q.run('UPDATE tk_tickets SET subject=? WHERE id=?', String(b.subject).slice(0, 200), t.id);
                    if (b.sku !== undefined && b.sku !== t.sku)
                        q.run('UPDATE tk_tickets SET sku=? WHERE id=?', b.sku || null, t.id);
                    if (b.cust_name != null && b.cust_name !== t.cust_name)
                        q.run('UPDATE tk_tickets SET cust_name=? WHERE id=?', String(b.cust_name).slice(0, 120), t.id);
                    if (b.order_id !== undefined && b.order_id !== t.order_id) {
                        const o = findOrder(b.order_id);
                        need(!b.order_id || o, 'Order not found');
                        q.run('UPDATE tk_tickets SET order_id=?, order_name=?, tracking=?, phone=COALESCE(NULLIF(phone,\'\'),?), cust_name=COALESCE(NULLIF(cust_name,\'\'),?) WHERE id=?', o ? o.id : null, o ? o.name : null, o ? o.tracking : null, o ? o.phone : null, o ? o.cust_name : null, t.id);
                        ch.push(o ? 'Linked order ' + o.name : 'Order unlinked');
                    }
                    if (b.status && b.status !== t.status) {
                        need(['open', 'waiting', 'progress', 'closed'].includes(b.status), 'Use Resolve or Reopen for that');
                        need(!['resolved', 'closed'].includes(t.status) || b.status === 'closed', 'Reopen the ticket first');
                        need(!(b.status === 'closed' && t.status !== 'resolved' && FAULT_TYPES.includes(t.type) && !t.fault_dept), 'Use "Resolve & close" and say whose mistake it was');
                        setStatus(t, b.status, u);
                    }
                    if (ch.length)
                        sysNote(t.id, u.id, ch.join(' · '));
                    touch(t.id);
                });
                return { ok: true };
            });
            route('POST', '/api/tickets/:id/note', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id), kind = b.kind === 'message' ? 'message' : 'note';
                const files = Array.isArray(b.files) ? b.files.filter(Boolean).map(String).slice(0, 10) : [];
                need(String(b.body || '').trim() || files.length, 'Write something first');
                q.run('INSERT INTO tk_notes(ticket_id,user_id,kind,body,files) VALUES(?,?,?,?,?)', t.id, u.id, kind, String(b.body || '').slice(0, 4000), JSON.stringify(files));
                if (kind === 'message')
                    q.run("UPDATE tk_tickets SET first_response_at=COALESCE(first_response_at, datetime('now')), status=CASE WHEN status='open' AND ?=1 THEN 'waiting' ELSE status END WHERE id=?", b.wait ? 1 : 0, t.id);
                if (kind === 'message' && t.status === 'open' && !b.wait && !t.assignee)
                    q.run('UPDATE tk_tickets SET assignee=? WHERE id=?', u.id, t.id);
                touch(t.id);
                log(u.id, kind === 'message' ? 'ticket.reply' : 'ticket.note', 'ticket:' + t.id, { channel: b.channel || t.channel });
                return { ok: true };
            });
            route('POST', '/api/tickets/:id/resolve', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id);
                need(!['resolved', 'closed'].includes(t.status), 'Ticket is already resolved');
                q.tx(() => resolveTicket(t, b, u));
                return { ok: true };
            });
            route('POST', '/api/tickets/:id/close', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id);
                if (t.status === 'resolved') {
                    q.tx(() => { setStatus(t, 'closed', u); touch(t.id); });
                    return { ok: true };
                }
                q.tx(() => closeNoFix(t, b, u));
                return { ok: true };
            });
            route('GET', '/api/tickets/:id/fault', 'tickets', (req, u, b, res, p) => faultSuggest(getT(p.id)));
            route('POST', '/api/tickets/:id/fault', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id);
                need(['resolved', 'closed'].includes(t.status), 'Resolve the ticket first (whose mistake is asked there)');
                const f = faultIn(t, b, { required: true });
                q.tx(() => { saveFault(t, f, u.id); touch(t.id); });
                return { ok: true };
            });
            route('POST', '/api/tickets/:id/reopen', 'tickets', (req, u, b, res, p) => {
                const t = getT(p.id);
                need(['resolved', 'closed'].includes(t.status), 'Ticket is still open');
                q.run(`UPDATE tk_tickets SET status='open', resolved_at=NULL, closed_at=NULL, resolution=NULL, resolution_note=NULL, reopened=reopened+1, due_at=?, updated_at=datetime('now') WHERE id=?`, dueFrom(Date.now(), t.priority), t.id);
                sysNote(t.id, u.id, 'Reopened' + (b.note ? ': ' + b.note : ''));
                log(u.id, 'ticket.reopen', 'ticket:' + t.id, b.note || '');
                return { ok: true };
            });
            /* ---------- exchanges ---------- */
            const exItems = id => q.all('SELECT * FROM tk_exchange_items WHERE exchange_id=? ORDER BY id', id);
            const reservedElsewhere = (sku, exceptId) => q.get(`SELECT e.id FROM tk_exchange_items i JOIN tk_exchanges e ON e.id=i.exchange_id WHERE i.dir='new' AND UPPER(i.sku)=UPPER(?) AND e.step NOT IN ('completed','cancelled','dispatched') AND e.id<>?`, sku, exceptId || 0);
            function stockCheck(skus, exceptId) {
                const out = [];
                for (const s of skus) {
                    const pr = q.get('SELECT * FROM products WHERE UPPER(sku)=UPPER(?)', String(s).trim());
                    need(pr, `SKU ${s} not found`);
                    need(pr.qty > 0, `${pr.sku} is not in stock`);
                    const r = reservedElsewhere(pr.sku, exceptId);
                    need(!r, `${pr.sku} is already promised in exchange #${r && r.id}`);
                    out.push(pr);
                }
                return out;
            }
            route('GET', '/api/exchanges/products', 'tickets', (req, u, b, res, p, qs) => {
                const s = String(qs.q || '').trim();
                if (s.length < 2)
                    return [];
                const t = '%' + s + '%';
                return q.all(`SELECT p.sku, p.title, p.price, p.size, p.brand, p.cond, p.qty, COALESCE(l.location, p.rack) location FROM products p LEFT JOIN locations l ON l.sku=p.sku WHERE p.qty>0 AND (p.sku LIKE ? OR p.title LIKE ? OR p.brand LIKE ? OR p.size LIKE ?) ORDER BY p.created_at DESC LIMIT 20`, t, t, t, t)
                    .map(r => (Object.assign(Object.assign({}, r), { reserved: !!reservedElsewhere(r.sku) })));
            });
            route('GET', '/api/exchanges', 'tickets', (req, u, b, res, p, qs) => {
                const w = [], a = [];
                if (qs.step) {
                    w.push('e.step=?');
                    a.push(qs.step);
                }
                else if (qs.all !== '1')
                    w.push(`(e.step NOT IN ('completed','cancelled') OR e.updated_at>=datetime('now','-14 days'))`);
                if (qs.q) {
                    const t = '%' + qs.q + '%';
                    w.push('(e.order_name LIKE ? OR e.cust_name LIKE ? OR e.phone LIKE ? OR e.reverse_tracking LIKE ? OR e.out_tracking LIKE ?)');
                    a.push(t, t, t, t, t);
                }
                const rows = q.all(`SELECT e.*, us.name created_by_name FROM tk_exchanges e LEFT JOIN users us ON us.id=e.created_by ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.updated_at DESC LIMIT 400`, ...a);
                for (const r of rows)
                    r.items = exItems(r.id);
                const counts = Object.fromEntries(q.all('SELECT step, COUNT(*) n FROM tk_exchanges GROUP BY step').map(r => [r.step, r.n]));
                return { rows, counts };
            });
            route('GET', '/api/exchanges/:id', 'tickets', (req, u, b, res, p) => {
                const e = q.get('SELECT * FROM tk_exchanges WHERE id=?', +p.id);
                need(e, 'Exchange not found', 404);
                return { exchange: e, items: exItems(e.id), log: q.all('SELECT l.*, us.name user FROM tk_exchange_log l LEFT JOIN users us ON us.id=l.user_id WHERE exchange_id=? ORDER BY l.id', e.id),
                    refund: e.refund_id ? q.get('SELECT * FROM tk_refunds WHERE id=?', e.refund_id) : null };
            });
            function createExchange(b, uid) {
                const t = b.ticket_id ? q.get('SELECT * FROM tk_tickets WHERE id=?', +b.ticket_id) : null;
                need(!b.ticket_id || t, 'Ticket not found');
                const o = findOrder(b.order_id || (t && t.order_id));
                need(!(b.order_id) || o, 'Order not found');
                const oldSkus = (b.old_items || []).map(s => String(s).trim()).filter(Boolean), newSkus = (b.new_items || []).map(s => String(s).trim()).filter(Boolean);
                need(oldSkus.length, 'Pick the item the customer is sending back');
                need(newSkus.length, 'Pick the new item to send');
                const old = oldSkus.map(s => {
                    const it = o ? q.get('SELECT i.sku, i.title, i.price, pr.size FROM order_items i LEFT JOIN products pr ON pr.variant_id=i.variant_id WHERE i.order_id=? AND UPPER(i.sku)=UPPER(?)', o.id, s) : null;
                    if (o)
                        need(it, `${s} is not in order ${o.name}`);
                    if (it)
                        return it;
                    const pr = q.get('SELECT sku, title, price, size FROM products WHERE UPPER(sku)=UPPER(?)', s);
                    return pr || { sku: s.toUpperCase(), title: '', price: +b.old_price || 0, size: '' };
                });
                const nw = stockCheck(newSkus);
                const oldT = old.reduce((s, x) => s + (+x.price || 0), 0), newT = nw.reduce((s, x) => s + (+x.price || 0), 0), diff = Math.round(newT - oldT);
                const mode = diff > 0 ? 'pay_extra' : diff < 0 ? (b.diff_mode === 'refund' ? 'refund' : 'store_credit') : 'none';
                const phone = L.normPhone(b.phone || (o && o.phone) || (t && t.phone) || '');
                const id = q.tx(() => {
                    const r = q.run(`INSERT INTO tk_exchanges(ticket_id,order_id,order_name,phone,cust_name,old_total,new_total,diff,diff_mode,refund_method,reverse_tracking,out_tracking,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t ? t.id : null, o ? o.id : null, o ? o.name : null, phone, String(b.cust_name || (o && o.cust_name) || (t && t.cust_name) || ''), oldT, newT, diff, mode, mode === 'refund' ? (METHODS.includes(b.refund_method) && b.refund_method !== 'Store credit' ? b.refund_method : 'Bank transfer') : mode === 'store_credit' ? 'Store credit' : null, b.reverse_tracking || null, b.out_tracking || null, String(b.note || '').slice(0, 1000), uid);
                    const eid = Number(r.lastInsertRowid);
                    for (const x of old)
                        q.run("INSERT INTO tk_exchange_items(exchange_id,dir,sku,title,price,size) VALUES(?,'old',?,?,?,?)", eid, x.sku, x.title, +x.price || 0, x.size || '');
                    for (const x of nw)
                        q.run("INSERT INTO tk_exchange_items(exchange_id,dir,sku,title,price,size) VALUES(?,'new',?,?,?,?)", eid, x.sku, x.title, +x.price || 0, x.size || '');
                    q.run("INSERT INTO tk_exchange_log(exchange_id,step,user_id,note) VALUES(?,'requested',?,?)", eid, uid, b.note || '');
                    if (t) {
                        sysNote(t.id, uid, `Exchange #${eid} created`);
                        q.run("UPDATE tk_tickets SET status=CASE WHEN status='open' THEN 'progress' ELSE status END, updated_at=datetime('now') WHERE id=?", t.id);
                    }
                    return eid;
                });
                log(uid, 'exchange.create', 'exchange:' + id, { order: o ? o.name : null, diff });
                return id;
            }
            route('POST', '/api/exchanges', 'tickets', (req, u, b) => ({ id: createExchange(b, u.id) }));
            route('POST', '/api/exchanges/:id', 'tickets', (req, u, b, res, p) => {
                var _a, _b, _c;
                const e = q.get('SELECT * FROM tk_exchanges WHERE id=?', +p.id);
                need(e, 'Exchange not found', 404);
                q.run("UPDATE tk_exchanges SET reverse_tracking=?, out_tracking=?, note=?, updated_at=datetime('now') WHERE id=?", (_a = b.reverse_tracking) !== null && _a !== void 0 ? _a : e.reverse_tracking, (_b = b.out_tracking) !== null && _b !== void 0 ? _b : e.out_tracking, (_c = b.note) !== null && _c !== void 0 ? _c : e.note, e.id);
                log(u.id, 'exchange.update', 'exchange:' + e.id, '');
                return { ok: true };
            });
            route('POST', '/api/exchanges/:id/step', 'tickets', (req, u, b, res, p) => {
                const e = q.get('SELECT * FROM tk_exchanges WHERE id=?', +p.id);
                need(e, 'Exchange not found', 404);
                const st = b.step;
                need(st === 'cancelled' || STEPS.includes(st), 'Unknown step');
                need(!['completed', 'cancelled'].includes(e.step), 'This exchange is already ' + STEP_L[e.step].toLowerCase());
                if (st !== 'cancelled')
                    need(STEPS.indexOf(st) === STEPS.indexOf(e.step) + 1, `Next step is "${STEP_L[STEPS[STEPS.indexOf(e.step) + 1]]}"`);
                const items = exItems(e.id);
                if (st === 'approved' || st === 'dispatched')
                    stockCheck(items.filter(i => i.dir === 'new').map(i => i.sku), e.id);
                if (b.reverse_tracking)
                    q.run('UPDATE tk_exchanges SET reverse_tracking=? WHERE id=?', b.reverse_tracking, e.id);
                if (b.out_tracking)
                    q.run('UPDATE tk_exchanges SET out_tracking=? WHERE id=?', b.out_tracking, e.id);
                let note = String(b.note || '');
                if (st === 'received') {
                    const w = ctx.services.wms, fn = w && (w.receiveReturn || w.receive);
                    let wn;
                    if (typeof fn === 'function') {
                        try {
                            for (const i of items.filter(x => x.dir === 'old'))
                                fn.call(w, { sku: i.sku, order_id: e.order_id, reason: 'exchange', ref: 'exchange:' + e.id, cond: b.cond || null, note: note }, u.id);
                            wn = 'Sent to warehouse receiving';
                        }
                        catch (x) {
                            wn = 'Warehouse receive failed: ' + x.message;
                        }
                    }
                    else
                        wn = 'Warehouse module not connected: put the returned pair back on a rack by hand.';
                    q.run('UPDATE tk_exchanges SET wms_note=? WHERE id=?', wn, e.id);
                }
                q.tx(() => {
                    q.run(`UPDATE tk_exchanges SET step=?, ${st}_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, st, e.id);
                    q.run('INSERT INTO tk_exchange_log(exchange_id,step,user_id,note) VALUES(?,?,?,?)', e.id, st, u.id, note);
                    if (st === 'completed' && e.diff < 0 && ['refund', 'store_credit'].includes(e.diff_mode) && !e.refund_id) {
                        const r = q.run(`INSERT INTO tk_refunds(ticket_id,exchange_id,order_id,order_name,phone,cust_name,method,amount,account_details,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, e.ticket_id, e.id, e.order_id, e.order_name, e.phone, e.cust_name, e.refund_method || 'Store credit', -e.diff, '', `Exchange #${e.id} price difference`, u.id);
                        q.run('UPDATE tk_exchanges SET refund_id=? WHERE id=?', Number(r.lastInsertRowid), e.id);
                        log(u.id, 'refund.create', 'refund:' + r.lastInsertRowid, { exchange: e.id, amount: -e.diff });
                    }
                    if (e.ticket_id) {
                        sysNote(e.ticket_id, u.id, `Exchange #${e.id}: ${STEP_L[st]}`);
                        touch(e.ticket_id);
                    }
                    if (st === 'completed' && e.ticket_id)
                        autoResolveParent(e.ticket_id, 'Exchanged', `exchange #${e.id} completed`, u.id, b.fault);
                });
                log(u.id, 'exchange.step', 'exchange:' + e.id, { step: st });
                return { ok: true };
            });
            /* ---------- refunds & store credit ---------- */
            const refAccess = u => need(can(u, 'tickets') || isApprover(u), 'Your account does not have access to this', 403);
            // Accounts for a refund:
            //  approve → Dr Sales Return (or Customer Advances, see below) / Cr Store Credit (store credit) or Cr Accrued Expenses customer:<phone> (money still to send)
            //  paid    → Dr Accrued Expenses customer:<phone> / Cr bank, dated the day it was sent (so the bank ledger matches the statement)
            // A refund on an order whose sale was already reversed by the automatic PostEx return entry (Dr Sales Return / Cr Post Ex) must not hit Sales Return
            // again: the money we give back is the customer's advance, so it debits Customer Advances.
            const RET_ST = ['returning', 'returned', 'return_received'];
            const pkDate = s => new Date(parseUtc(s) + 5 * 3600e3).toISOString().slice(0, 10);
            function refundLines(r) {
                const amt = Math.round(+r.amount * 100) / 100, party = 'customer:' + r.phone;
                const o = r.order_id ? q.get('SELECT status, dispatched_at, cancelled_at FROM orders WHERE id=?', r.order_id) : null;
                const reversed = !!(o && o.dispatched_at && !o.cancelled_at && RET_ST.includes(o.status));
                const dr = reversed ? { account: 'Customer Advances', debit: amt, party } : { account: 'Sales Return', debit: amt };
                return [dr, r.method === 'Store credit' ? { account: 'Store Credit', credit: amt, party } : { account: 'Accrued Expenses', credit: amt, party }];
            }
            function postRefund(r, uid) {
                const acc = ctx.services.accounts;
                if (!acc || typeof acc.post !== 'function') {
                    q.run("UPDATE tk_refunds SET posted=0, post_error='Accounts module not available yet' WHERE id=?", r.id);
                    return false;
                }
                const amt = Math.round(+r.amount * 100) / 100;
                try {
                    const jid = acc.post({ date: r.approved_at ? pkDate(r.approved_at) : pkToday(), memo: `Refund #${r.id} · ${r.method} · ${r.order_name || r.phone || ''}`.trim(), source: 'refund', source_id: String(r.id), lines: refundLines(r) }, uid);
                    if (r.method !== 'Store credit' && r.status === 'paid')
                        acc.post({ date: r.paid_at ? pkDate(r.paid_at) : pkToday(), memo: `Refund #${r.id} sent · ${r.method}${r.paid_ref ? ' · ref ' + r.paid_ref : ''}`, source: 'refund-paid', source_id: String(r.id),
                            lines: [{ account: 'Accrued Expenses', debit: amt, party: 'customer:' + r.phone }, { account: refundBank(), credit: amt }] }, r.paid_by || uid);
                    q.run('UPDATE tk_refunds SET posted=1, post_error=NULL, journal_id=? WHERE id=?', jid == null ? null : String(jid), r.id);
                    return true;
                }
                catch (x) {
                    q.run('UPDATE tk_refunds SET posted=0, post_error=? WHERE id=?', String(x.message).slice(0, 300), r.id);
                    return false;
                }
            }
            const refundBank = () => ctx.setting('tickets_refund_account', 'Meezan (SB)') || 'Meezan (SB)';
            ctx._tkRepost = () => {
                if (!ctx.services.accounts)
                    return 0;
                let n = 0;
                for (const r of q.all("SELECT * FROM tk_refunds WHERE status IN ('approved','paid') AND posted=0"))
                    if (postRefund(r, r.approved_by))
                        n++;
                // order returned after its refund was posted: move the debit from Sales Return to Customer Advances (only while that month is open)
                const L = (ctx.services.accounts.lockDate && ctx.services.accounts.lockDate()) || '';
                for (const r of q.all(`SELECT r.* FROM tk_refunds r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('approved','paid') AND r.posted=1 AND o.dispatched_at IS NOT NULL AND o.cancelled_at IS NULL
          AND o.status IN ('returning','returned','return_received') AND EXISTS (SELECT 1 FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id JOIN acc_accounts a ON a.id=l.account_id
          WHERE j.source='refund' AND j.source_id=CAST(r.id AS TEXT) AND j.voided=0 AND a.name='Sales Return' AND j.date>?)`, L)) {
                    try {
                        if (postRefund(r, r.approved_by))
                            n++;
                    }
                    catch (_a) { }
                }
                return n;
            };
            route('GET', '/api/refunds', 'dashboard', (req, u, b, res, p, qs) => {
                refAccess(u);
                const w = [], a = [];
                if (qs.status) {
                    w.push('r.status=?');
                    a.push(qs.status);
                }
                if (qs.method) {
                    w.push('r.method=?');
                    a.push(qs.method);
                }
                if (qs.from) {
                    w.push("date(r.created_at,'+5 hours')>=?");
                    a.push(qs.from);
                }
                if (qs.to) {
                    w.push("date(r.created_at,'+5 hours')<=?");
                    a.push(qs.to);
                }
                if (qs.q) {
                    const t = '%' + qs.q + '%';
                    w.push('(r.order_name LIKE ? OR r.cust_name LIKE ? OR r.phone LIKE ? OR r.paid_ref LIKE ?)');
                    a.push(t, t, t, t);
                }
                const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
                const rows = q.all(`SELECT r.*, c.name created_by_name, ap.name approved_by_name, pd.name paid_by_name, CAST((julianday('now')-julianday(r.created_at))*24 AS INT) age_h FROM tk_refunds r
        LEFT JOIN users c ON c.id=r.created_by LEFT JOIN users ap ON ap.id=r.approved_by LEFT JOIN users pd ON pd.id=r.paid_by ${where} ORDER BY r.id DESC LIMIT 1000`, ...a);
                const totals = q.get(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COALESCE(SUM(CASE WHEN status='approved' THEN amount END),0) approved,
        COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) paid FROM tk_refunds r ${where}`, ...a);
                const counts = Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM tk_refunds GROUP BY status').map(r => [r.status, r.n]));
                return { rows, totals, counts, canApprove: isApprover(u), canCreate: can(u, 'tickets'), accounts: !!ctx.services.accounts };
            });
            route('POST', '/api/refunds', 'tickets', (req, u, b) => {
                need(METHODS.includes(b.method), 'Pick a refund method');
                const amt = +b.amount;
                need(amt > 0, 'Enter the refund amount');
                const t = b.ticket_id ? q.get('SELECT * FROM tk_tickets WHERE id=?', +b.ticket_id) : null;
                need(!b.ticket_id || t, 'Ticket not found');
                const o = findOrder(b.order_id || (t && t.order_id));
                const phone = L.normPhone(b.phone || (t && t.phone) || (o && o.phone) || '');
                need(phone, 'Customer phone is needed');
                if (b.method !== 'Store credit')
                    need(String(b.account_details || '').trim(), 'Add the customer account details (account / wallet number and name)');
                if (o)
                    need(amt <= (+o.total || 0) + 1, `Refund is more than the order total (${Math.round(o.total)})`);
                const r = q.run(`INSERT INTO tk_refunds(ticket_id,exchange_id,order_id,order_name,phone,cust_name,method,amount,account_details,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, t ? t.id : null, b.exchange_id || null, o ? o.id : null, o ? o.name : null, phone, String(b.cust_name || (t && t.cust_name) || (o && o.cust_name) || ''), b.method, amt, String(b.account_details || '').slice(0, 300), String(b.reason || '').slice(0, 500), u.id);
                const id = Number(r.lastInsertRowid);
                if (t) {
                    sysNote(t.id, u.id, `Refund #${id} requested: ${b.method} Rs ${Math.round(amt)}`);
                    q.run("UPDATE tk_tickets SET status=CASE WHEN status='open' THEN 'progress' ELSE status END, updated_at=datetime('now') WHERE id=?", t.id);
                }
                log(u.id, 'refund.create', 'refund:' + id, { amount: amt, method: b.method });
                return { id };
            });
            const getR = id => { const r = q.get('SELECT * FROM tk_refunds WHERE id=?', +id); need(r, 'Refund not found', 404); return r; };
            route('POST', '/api/refunds/:id/approve', 'dashboard', (req, u, b, res, p) => {
                need(isApprover(u), 'Only finance or the owner can approve refunds', 403);
                const r = getR(p.id);
                need(r.status === 'pending', 'Refund is already ' + r.status);
                const credit = r.method === 'Store credit';
                q.run(`UPDATE tk_refunds SET status=?, approved_by=?, approved_at=datetime('now')${credit ? ", paid_by=?, paid_at=datetime('now'), paid_ref='Store credit'" : ''} WHERE id=?`, credit ? 'paid' : 'approved', u.id, ...(credit ? [u.id] : []), r.id);
                const posted = postRefund(getR(r.id), u.id);
                if (r.ticket_id) {
                    sysNote(r.ticket_id, u.id, `Refund #${r.id} approved` + (credit ? ' (store credit added)' : ''));
                    touch(r.ticket_id);
                    if (credit)
                        autoResolveParent(r.ticket_id, 'Store credit given', `store credit #${r.id} added`, u.id);
                }
                log(u.id, 'refund.approve', 'refund:' + r.id, { amount: r.amount, method: r.method });
                return { ok: true, posted };
            });
            route('POST', '/api/refunds/:id/reject', 'dashboard', (req, u, b, res, p) => {
                need(isApprover(u), 'Only finance or the owner can reject refunds', 403);
                const r = getR(p.id);
                need(r.status === 'pending', 'Refund is already ' + r.status);
                need(String(b.reason || '').trim(), 'Write why it is rejected');
                q.run("UPDATE tk_refunds SET status='rejected', rejected_by=?, rejected_at=datetime('now'), reject_reason=? WHERE id=?", u.id, String(b.reason).slice(0, 500), r.id);
                if (r.ticket_id)
                    sysNote(r.ticket_id, u.id, `Refund #${r.id} rejected: ${b.reason}`);
                log(u.id, 'refund.reject', 'refund:' + r.id, b.reason);
                return { ok: true };
            });
            route('POST', '/api/refunds/:id/paid', 'dashboard', (req, u, b, res, p) => {
                need(isApprover(u), 'Only finance or the owner can mark refunds paid', 403);
                const r = getR(p.id);
                need(r.status === 'approved', r.status === 'pending' ? 'Approve the refund first' : 'Refund is already ' + r.status);
                need(String(b.ref || '').trim(), 'Enter the transfer reference / transaction ID');
                q.run("UPDATE tk_refunds SET status='paid', paid_by=?, paid_at=datetime('now'), paid_ref=? WHERE id=?", u.id, String(b.ref).slice(0, 120), r.id);
                postRefund(getR(r.id), u.id); // books the money leaving the bank (Dr Accrued Expenses / Cr bank)
                if (r.ticket_id) {
                    sysNote(r.ticket_id, u.id, `Refund #${r.id} paid · ref ${b.ref}`);
                    autoResolveParent(r.ticket_id, 'Refunded', `refund #${r.id} paid`, u.id);
                }
                log(u.id, 'refund.paid', 'refund:' + r.id, { ref: b.ref });
                return { ok: true };
            });
            route('POST', '/api/refunds/:id/post', 'dashboard', (req, u, b, res, p) => {
                need(isApprover(u), 'Only finance or the owner can post refunds', 403);
                const r = getR(p.id);
                need(['approved', 'paid'].includes(r.status), 'Approve the refund first');
                const ok = postRefund(r, u.id);
                const x = getR(r.id);
                need(ok, x.post_error || 'Could not post');
                return { ok: true };
            });
            /* ---------- services ---------- */
            ctx.services.tickets = {
                summary() {
                    const t = q.get(`SELECT SUM(status IN ${OPEN}) open, SUM(status IN ('open','progress') AND due_at<datetime('now')) overdue FROM tk_tickets`);
                    return { open: t.open || 0, overdue: t.overdue || 0, exchangesOpen: q.get("SELECT COUNT(*) n FROM tk_exchanges WHERE step NOT IN ('completed','cancelled')").n,
                        refundsPending: q.get("SELECT COUNT(*) n FROM tk_refunds WHERE status='pending'").n };
                },
                create: (data, userId) => createTicket(data || {}, userId),
                runAutoAttempted: () => autoAttempted(),
            };
        },
        jobs: [
            { name: 'attempted', every: 30, offset: 7, run: async (ctx) => { if (ctx._tkAuto)
                    ctx._tkAuto(); } },
            { name: 'repost', every: 60, offset: 13, run: async (ctx) => { if (ctx._tkRepost)
                    ctx._tkRepost(); } },
        ],
        counts(u, ctx) {
            const { q, can } = ctx, c = {};
            if (can(u, 'tickets'))
                c.tickets = q.get(`SELECT COUNT(*) n FROM tk_tickets WHERE status IN ${OPEN} AND (assignee=? OR assignee IS NULL)`, u.id).n;
            if (can(u, 'finance') || u.role === 'admin')
                c.refunds = q.get("SELECT COUNT(*) n FROM tk_refunds WHERE status IN ('pending','approved')").n;
            if (can(u, 'tickets'))
                c.exchanges = q.get("SELECT COUNT(*) n FROM tk_exchanges WHERE step NOT IN ('completed','cancelled')").n;
            return c;
        },
        alerts(u, ctx) {
            const { q, can } = ctx, out = [];
            if (can(u, 'tickets')) {
                const mine = q.get(`SELECT COUNT(*) n FROM tk_tickets WHERE status IN ('open','progress') AND due_at<datetime('now') AND assignee=?`, u.id).n;
                const all = q.get(`SELECT COUNT(*) n FROM tk_tickets WHERE status IN ('open','progress') AND due_at<datetime('now')`).n;
                if (mine)
                    out.push({ level: 'bad', text: `${mine} of your tickets are overdue`, href: '#/tickets/overdue' });
                else if (all && (u.role === 'admin' || u.role === 'manager' || !q.get(`SELECT 1 FROM tk_tickets WHERE assignee=? LIMIT 1`, u.id)))
                    out.push({ level: 'warn', text: `${all} customer tickets are overdue`, href: '#/tickets/overdue' });
            }
            if (can(u, 'finance') || u.role === 'admin') {
                const n = q.get("SELECT COUNT(*) n FROM tk_refunds WHERE status='pending' AND created_at<datetime('now','-1 day')").n;
                if (n)
                    out.push({ level: 'warn', text: `${n} refunds waiting for approval for over a day`, href: '#/refunds/pending' });
            }
            return out;
        },
        activity: {
            'ticket.create': 'Created ticket', 'ticket.reply': 'Replied to customer', 'ticket.note': 'Added ticket note', 'ticket.assign': 'Assigned ticket', 'ticket.status': 'Changed ticket status',
            'ticket.resolve': 'Resolved ticket', 'ticket.close': 'Closed ticket without fix', 'ticket.fault': 'Recorded whose mistake', 'ticket.autoresolve': 'Ticket auto-resolved', 'ticket.reopen': 'Reopened ticket', 'ticket.autorun': 'Ran delivery follow-ups', 'exchange.create': 'Created exchange', 'exchange.step': 'Moved exchange step',
            'exchange.update': 'Updated exchange', 'refund.create': 'Requested refund', 'refund.approve': 'Approved refund', 'refund.reject': 'Rejected refund', 'refund.paid': 'Marked refund paid',
        },
    };
};