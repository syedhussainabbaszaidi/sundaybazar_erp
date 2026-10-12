    // Staff logins, sessions and per-person access
    'use strict';
    const crypto = require('crypto');
    const { q } = require('./db');
    const PERMS = [
        ['dashboard', 'Home & own work (everyone)'],
        ['me', 'My page: attendance, leave, payslips (everyone)'],
        ['tasks', 'My tasks & daily report (everyone)'],
        ['expenses', 'Submit office expenses (everyone)'],
        ['orders', 'Orders: view'],
        ['orders_edit', 'Orders: change stage, notes'],
        ['cs', 'Confirmation calls (CS)'],
        ['tickets', 'CS tickets, exchanges & refunds'],
        ['customers', 'Customers: view (phone numbers)'],
        ['customers_edit', 'Customers: blacklist / VIP'],
        ['tracking', 'Parcel tracking'],
        ['couriers', 'Couriers: book TCS/PostEx, rider runs, courier COD'],
        ['rider', 'Rider app: my deliveries & cash (Karachi rider)'],
        ['inbox', 'Messages inbox: WhatsApp, Instagram, forms'],
        ['inbox_wa', 'Messages: WhatsApp & Google Form only'],
        ['inbox_ig', 'Messages: Instagram DMs & comments only'],
        ['inbox_admin', 'Messaging setup: Cequens, Instagram, auto-messages'],
        ['abandoned', 'Shopify abandoned checkouts'],
        ['warehouse', 'Warehouse: pick, pack, returns'],
        ['inventory', 'Inventory & rack locations'],
        ['wms', 'Warehouse control: receiving, stock counts, damage, transfers'],
        ['listing', 'Lots, listing & pricing'],
        ['pricing_apply', 'Push new prices to Shopify'],
        ['finance', 'Finance: COD, profit'],
        ['accounts', 'Accounts: books, ledgers, statements (view)'],
        ['accounts_post', 'Accounts: post journal entries, close month'],
        ['expenses_approve', 'Approve expenses & manage petty cash'],
        ['marketing', 'Marketing: Meta ads spend & results'],
        ['hr', 'HR: employees, attendance, leave'],
        ['payroll', 'Payroll: salaries, advances, payslips'],
        ['team', 'Team report: who did what, performance'],
        ['reports', 'Reports & analytics'],
        ['settings', 'Settings & sync'],
        ['users', 'Staff accounts & access'],
    ];
    const BASE = ['dashboard', 'me', 'tasks', 'expenses'];
    const ALL = PERMS.map(p => p[0]);
    const R = (...p) => [...new Set(BASE.concat(p))];
    // desc = one line for the Staff & access screen (what screens the role gets)
    const ROLES = {
        admin: { label: 'Owner / Admin', desc: 'Everything, including settings, staff logins and accounts posting.', perms: ALL },
        manager: { label: 'Manager', desc: 'Everything except settings, staff logins, payroll and accounts posting.', perms: ALL.filter(p => !['users', 'settings', 'accounts_post', 'payroll', 'rider', 'inbox_admin', 'inbox_wa', 'inbox_ig'].includes(p)) },
        cs: { label: 'CS / Confirmation', desc: 'Confirmation calls, Messages (all channels), Tickets, Exchanges, Refunds, Orders, Customers.', perms: R('orders', 'orders_edit', 'cs', 'tickets', 'customers', 'customers_edit', 'inbox') },
        tracking: { label: 'Tracking', desc: 'Parcel tracking, Tickets, Messages, Exchanges, Orders, Customers, courier booking.', perms: R('orders', 'orders_edit', 'tracking', 'tickets', 'customers', 'inbox', 'couriers') },
        warehouse: { label: 'Warehouse / Inventory', desc: 'Dispatch desk (pick, pack, book, handover), racks, receiving, stock counts, damage, returns.', perms: R('orders', 'warehouse', 'inventory', 'wms', 'couriers') },
        rider: { label: 'Rider (own delivery)', desc: 'Only My deliveries and cash on the phone.', perms: R('rider') },
        lister: { label: 'Lister', desc: 'List pairs, photos, upload, handover, racks and inventory (no cost or profit).', perms: R('inventory', 'listing') },
        finance: { label: 'Finance / Accounts', desc: 'COD, Accounts, Vouchers, Statements, Month close, Expense approvals, Refunds, Reports.', perms: R('orders', 'finance', 'accounts', 'accounts_post', 'expenses_approve', 'reports', 'couriers') },
        marketing: { label: 'Marketing', desc: 'Meta ad spend, Campaigns, Marketing spend, Messages, Reports.', perms: R('marketing', 'reports', 'inbox') },
        hr: { label: 'HR', desc: 'Team today (who worked, who didn\'t), Performance, Attendance, Leave, Employees, Payroll, Reports.', perms: R('hr', 'payroll', 'team', 'reports') },
        exchange: { label: 'Exchanges & WhatsApp', desc: 'Tickets, Exchanges, Refunds, Messages (WhatsApp & Google Form only), Orders, Customers.', perms: R('orders', 'tickets', 'customers', 'inbox', 'inbox_wa') },
        social: { label: 'Instagram & abandoned carts', desc: 'Abandoned carts, Messages (Instagram DMs & comments only), Tickets, Orders, Customers.', perms: R('orders', 'customers', 'inbox', 'inbox_ig', 'abandoned', 'tickets') },
        staff: { label: 'General staff', desc: 'Only My day: own tasks, attendance and expenses.', perms: R() },
    };
    function hash(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
    function verify(pw, stored) {
        const [salt, h] = String(stored).split(':');
        if (!salt || !h)
            return false;
        const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), salt, 32);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    function userPerms(u) {
        if (u.role === 'admin')
            return ALL.slice();
        let p = [];
        try {
            p = JSON.parse(u.perms || '[]');
        }
        catch (_a) { }
        if (!p.length)
            p = (ROLES[u.role] || { perms: [] }).perms;
        return [...new Set(BASE.concat(p))].filter(x => ALL.includes(x));
    }
    function createSession(userId) {
        const token = crypto.randomBytes(24).toString('hex');
        q.run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', token, userId, Date.now() + 14 * 864e5);
        q.run('DELETE FROM sessions WHERE expires<?', Date.now());
        return token;
    }
    function fromRequest(req) {
        const m = /(?:^|;\s*)sb_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
        if (!m)
            return null;
        const s = q.get('SELECT * FROM sessions WHERE token=? AND expires>?', m[1], Date.now());
        if (!s)
            return null;
        const u = q.get('SELECT * FROM users WHERE id=? AND active=1', s.user_id);
        if (!u)
            return null;
        return { id: u.id, name: u.name, username: u.username, role: u.role, perms: userPerms(u), token: m[1] };
    }
    module.exports = { PERMS, ROLES, ALL, BASE, hash, verify, userPerms, createSession, fromRequest };
};