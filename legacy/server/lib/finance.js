    // Profit & loss, COD and business reports
    'use strict';
    const { q, setting } = require('./db');
    const DONE_RET = `('returned','return_received','returning')`;
    function summary(month) {
        const fee = +setting('courier_fee', 250), retFee = +setting('return_fee', 150), pack = +setting('packaging_cost', 40), costPct = +setting('cost_pct', 35);
        const del = q.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) revenue, COALESCE(SUM(shipping),0) shipping_charged, COALESCE(SUM(COALESCE(cod,total)),0) cod,
      COALESCE(SUM(COALESCE(px_fee,?)+COALESCE(px_tax,0)),0) courier, SUM(px_fee IS NULL) est_fee FROM orders WHERE status='delivered' AND substr(delivered_at,1,7)=?`, fee, month);
        const ret = q.get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(px_fee,?)+COALESCE(px_tax,0)+COALESCE(px_rev_fee,?)+COALESCE(px_rev_tax,0)),0) cost, COALESCE(SUM(total),0) value
      FROM orders WHERE status IN ${DONE_RET} AND substr(returned_at,1,7)=?`, fee, retFee, month);
        const cogs = q.get(`SELECT COALESCE(SUM(COALESCE(p.cost, i.price*?/100.0)*i.qty),0) cogs, SUM(p.cost IS NULL) est FROM order_items i JOIN orders o ON o.id=i.order_id
      LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.status='delivered' AND substr(o.delivered_at,1,7)=?`, costPct, month);
        const exp = q.all(`SELECT category, ROUND(SUM(amount)) amount, COUNT(*) n FROM expenses WHERE substr(day,1,7)=? GROUP BY category ORDER BY amount DESC`, month);
        const expTotal = exp.reduce((s, e) => s + e.amount, 0);
        const packaging = (del.n + ret.n) * pack;
        const gross = del.revenue - cogs.cogs - del.courier;
        const net = gross - ret.cost - packaging - expTotal;
        const placed = q.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) value, SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled FROM orders WHERE substr(datetime(created_at,'+5 hours'),1,7)=?`, month);
        const daily = q.all(`SELECT substr(delivered_at,1,10) day, COUNT(*) n, ROUND(SUM(total)) revenue FROM orders WHERE status='delivered' AND substr(delivered_at,1,7)=? GROUP BY day ORDER BY day`, month);
        const codPending = q.get(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total) - COALESCE(px_fee,?) - COALESCE(px_tax,0)),0) net FROM orders WHERE status='delivered' AND settled=0`, fee);
        const rate = del.n + ret.n ? Math.round(100 * del.n / (del.n + ret.n)) : null;
        const notes = [];
        if (del.est_fee)
            notes.push(`${del.est_fee} delivered parcels have no PostEx charge yet, Rs ${fee} each was used.`);
        if (cogs.est)
            notes.push(`${cogs.est} sold items have no cost in Shopify, ${costPct}% of price was used.`);
        if (!exp.length)
            notes.push('No expenses entered for this month yet (salaries, rent, ads…). Profit will look higher than it is.');
        return { month, delivered: del, returned: ret, cogs: Math.round(cogs.cogs), packaging, expenses: exp, expTotal, gross: Math.round(gross), net: Math.round(net), placed, daily, codPending, deliveryRate: rate, notes,
            assumptions: { fee, retFee, pack, costPct } };
    }
    function reports(days) {
        const since = `datetime('now','-${days} days')`;
        const daily = q.all(`SELECT date(created_at,'+5 hours') day, COUNT(*) orders, ROUND(SUM(total)) value, SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled,
      SUM(status='delivered') delivered, SUM(status IN ${DONE_RET}) returned FROM orders WHERE created_at>=${since} GROUP BY day ORDER BY day`);
        const status = q.all(`SELECT status, COUNT(*) n, ROUND(SUM(total)) value FROM orders WHERE created_at>=${since} GROUP BY status ORDER BY n DESC`);
        const city = q.all(`SELECT COALESCE(NULLIF(TRIM(city),''),'(blank)') city, COUNT(*) orders, SUM(status='delivered') delivered, SUM(status IN ${DONE_RET}) returned, ROUND(SUM(total)) value
      FROM orders WHERE created_at>=${since} GROUP BY 1 ORDER BY orders DESC LIMIT 25`);
        const brand = q.all(`SELECT COALESCE(NULLIF(p.brand,''),'(unknown)') name, COUNT(*) units, ROUND(SUM(i.price*i.qty)) revenue, SUM(o.status='delivered') delivered, SUM(o.status IN ${DONE_RET}) returned
      FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.created_at>=${since} AND o.cancelled_at IS NULL GROUP BY 1 ORDER BY units DESC LIMIT 20`);
        const ptype = q.all(`SELECT COALESCE(NULLIF(p.ptype,''),'(unknown)') name, COUNT(*) units, ROUND(SUM(i.price*i.qty)) revenue, SUM(o.status='delivered') delivered, SUM(o.status IN ${DONE_RET}) returned
      FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.variant_id=i.variant_id WHERE o.created_at>=${since} AND o.cancelled_at IS NULL GROUP BY 1 ORDER BY units DESC LIMIT 20`);
        const labels = q.all(`SELECT COALESCE(c.label,'New') label, COUNT(*) orders, SUM(o.status='delivered') delivered, SUM(o.status IN ${DONE_RET}) returned
      FROM orders o LEFT JOIN customers c ON c.phone=o.phone WHERE o.created_at>=${since} GROUP BY 1`);
        const hours = q.all(`SELECT CAST(strftime('%H', created_at, '+5 hours') AS INT) hour, COUNT(*) orders FROM orders WHERE created_at>=${since} GROUP BY hour ORDER BY hour`);
        const kpi = q.get(`SELECT COUNT(*) orders, ROUND(AVG(total)) aov, ROUND(SUM(total)) value, SUM(status='delivered') delivered, SUM(status IN ${DONE_RET}) returned,
      SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled, COUNT(DISTINCT phone) customers FROM orders WHERE created_at>=${since}`);
        const repeat = q.get(`SELECT COUNT(*) n FROM (SELECT phone FROM orders WHERE created_at>=${since} AND phone<>'' GROUP BY phone HAVING COUNT(*)>1)`).n;
        const aging = q.all(`SELECT CASE WHEN julianday('now')-julianday(created_at)<30 THEN '0-30 days' WHEN julianday('now')-julianday(created_at)<60 THEN '30-60 days'
      WHEN julianday('now')-julianday(created_at)<90 THEN '60-90 days' ELSE '90+ days' END bucket, COUNT(*) items, ROUND(SUM(price)) value, ROUND(SUM(COALESCE(cost,0))) cost FROM products WHERE qty>0 GROUP BY 1 ORDER BY 1`);
        return { days, daily, status, city, brand, ptype, labels, hours, kpi, repeat, aging };
    }
    module.exports = { summary, reports };
};