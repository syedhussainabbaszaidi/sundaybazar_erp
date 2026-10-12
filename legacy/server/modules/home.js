    // Home: the owner's command centre (whole business on one page) and every staff member's "My day".
    'use strict';
    module.exports = {
        name: 'home',
        routes(ctx) {
            const { route, q, can, setting, setSetting, need, log } = ctx;
            const S = ctx.services;
            const safe = (fn, def = null) => { try {
                return fn();
            }
            catch (e) {
                console.error('home', e.message);
                return def;
            } };
            const pkDay = col => `date(${col},'+5 hours')`;
            function sales(from, to) {
                return q.get(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) value, COALESCE(SUM(items),0) pairs FROM orders WHERE ${pkDay('created_at')} BETWEEN ? AND ? AND cancelled_at IS NULL AND status NOT IN ('cancelled','cs_cancelled')`, from, to);
            }
            const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
            route('GET', '/api/home', 'dashboard', (req, u) => {
                const today = ctx.pkToday(), month = today.slice(0, 7), ms = month + '-01', yday = addDays(today, -1);
                const lastMs = addDays(ms, -1).slice(0, 7) + '-01', lastSame = addDays(lastMs, +today.slice(8, 10) - 1);
                const out = { today, name: u.name, sections: [] };
                const target = +setting('home_profit_target', 1000000) || 1000000;
                out.target = target;
                if (can(u, 'orders') || can(u, 'reports') || can(u, 'finance')) {
                    out.sales = { today: sales(today, today), yesterday: sales(yday, yday), mtd: sales(ms, today), lastMtd: sales(lastMs, lastSame) };
                    out.daily = q.all(`SELECT ${pkDay('created_at')} day, COUNT(*) orders, ROUND(SUM(total)) value FROM orders WHERE ${pkDay('created_at')} >= ? AND cancelled_at IS NULL AND status NOT IN ('cancelled','cs_cancelled') GROUP BY day ORDER BY day`, addDays(today, -29));
                    const dr = q.get(`SELECT SUM(status='delivered') del, SUM(status IN ('returned','return_received','returning')) ret FROM orders WHERE dispatched_at>=datetime('now','-30 days')`);
                    out.deliveryRate = dr.del + dr.ret ? Math.round(100 * dr.del / (dr.del + dr.ret)) : null;
                    out.pipeline = q.get(`SELECT SUM(status IN ('new','hold')) confirm, SUM(status IN ('confirmed','picked','packed')) warehouse, SUM(status IN ('dispatched','in_transit','out_for_delivery')) courier, SUM(status='attempted') attempted, SUM(status IN ('returning','returned')) coming_back FROM orders WHERE created_at>=datetime('now','-60 days')`);
                }
                if (can(u, 'accounts') && S.accounts) {
                    out.accounts = safe(() => S.accounts.summary());
                    if (out.accounts) {
                        const dayN = +today.slice(8, 10), dim = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
                        out.accounts.projected = Math.round(out.accounts.profitMTD / Math.max(1, dayN) * dim);
                    }
                }
                if (can(u, 'marketing') && S.marketing)
                    out.marketing = safe(() => S.marketing.summary());
                if ((can(u, 'hr') || can(u, 'team')) && S.hr)
                    out.hr = safe(() => S.hr.summary());
                if (can(u, 'team') && S.ops)
                    out.ops = safe(() => S.ops.summary());
                if (can(u, 'tickets') && S.tickets)
                    out.tickets = safe(() => S.tickets.summary());
                if ((can(u, 'wms') || can(u, 'warehouse')) && S.wms)
                    out.wms = safe(() => S.wms.summary());
                if ((can(u, 'listing') || can(u, 'wms') || can(u, 'team')) && S.stockline)
                    out.stockline = safe(() => S.stockline.summary());
                if (can(u, 'couriers') && S.couriers)
                    out.couriers = safe(() => S.couriers.summary());
                if (can(u, 'inbox') && S.inbox)
                    out.inbox = safe(() => S.inbox.summary());
                if (can(u, 'expenses_approve') && S.expenses)
                    out.expenses = safe(() => S.expenses.summary());
                if (S.purchasing && ['listing', 'wms', 'finance', 'accounts_post', 'pricing_apply'].some(p => can(u, p)))
                    out.purchasing = safe(() => {
                        const x = S.purchasing.summary();
                        if (!(can(u, 'finance') || can(u, 'accounts_post') || can(u, 'pricing_apply'))) {
                            x.payablesDue = null;
                            x.overdue = null;
                            x.payablesTotal = null;
                        }
                        return x;
                    });
                if (can(u, 'finance'))
                    out.cod = q.get(`SELECT COALESCE(SUM(COALESCE(cod,total)),0) v, COUNT(*) n FROM orders WHERE status='delivered' AND settled=0`);
                out.alerts = safe(() => ctx.collectAlerts(u), []);
                return out;
            });
            route('POST', '/api/home/target', 'settings', (req, u, b) => {
                need(+b.target > 0, 'Enter a monthly profit target');
                setSetting('home_profit_target', Math.round(+b.target));
                log(u.id, 'home.target', 'settings', { target: +b.target });
                return { ok: true };
            });
            // "My day": what this person did today (from the activity log), for everyone
            route('GET', '/api/home/me', 'dashboard', (req, u) => {
                const today = ctx.pkToday();
                const acts = q.all(`SELECT action, COUNT(*) n FROM events WHERE user_id=? AND date(at,'+5 hours')=? AND action NOT IN ('login','setup') GROUP BY action ORDER BY n DESC`, u.id, today);
                const calls = q.get(`SELECT COUNT(*) n FROM cs_calls WHERE user_id=? AND date(at,'+5 hours')=?`, u.id, today).n;
                const picks = q.get(`SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE picked_by=? AND date(picked_at,'+5 hours')=?`, u.id, today).n;
                const listed = q.get(`SELECT COUNT(*) n FROM listings WHERE user_id=? AND date(at,'+5 hours')=?`, u.id, today).n;
                const labels = S.activityLabels || {};
                const work = [];
                if (calls)
                    work.push({ label: 'Customer calls', n: calls });
                if (picks)
                    work.push({ label: 'Pairs picked', n: picks });
                if (listed)
                    work.push({ label: 'Pairs listed', n: listed });
                for (const a of acts)
                    if (!/^(cs:|pick|listing\.save|hr\.check)/.test(a.action))
                        work.push({ label: labels[a.action] || a.action, n: a.n });
                return { today, work };
            });
        },
    };
};