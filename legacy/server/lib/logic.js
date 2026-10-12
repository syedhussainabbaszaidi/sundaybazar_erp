    // Business rules: phone numbers, order status, customer score, SKU parsing, pricing suggestions
    'use strict';
    const { q, setting } = require('./db');
    function normPhone(p) {
        if (!p)
            return '';
        let d = String(p).replace(/\D/g, '');
        if (d.startsWith('0092'))
            d = d.slice(4);
        else if (d.startsWith('92') && d.length === 12)
            d = d.slice(2);
        if (d.length === 10 && d.startsWith('3'))
            d = '0' + d;
        return d;
    }
    const waNumber = p => { const n = normPhone(p); return n.startsWith('0') ? '92' + n.slice(1) : n; };
    // SKU: Rack-Category-Serial (EO-B-89582) or Rack-Serial (DT-56274)
    function parseSku(sku) {
        const parts = String(sku || '').trim().toUpperCase().split('-').filter(Boolean);
        if (parts.length >= 3)
            return { rack: parts[0], category: parts[1], serial: parts.slice(2).join('-') };
        if (parts.length === 2)
            return { rack: parts[0], category: '', serial: parts[1] };
        return { rack: '', category: '', serial: parts[0] || '' };
    }
    // PostEx status text -> ERP status
    function mapPostex(text) {
        const t = String(text || '').toLowerCase();
        if (!t)
            return null;
        if (t.includes('undeliver'))
            return 'attempted';
        if (t.includes('delivered') && !t.includes('return'))
            return 'delivered';
        if (t === 'returned' || t.includes('returned to') || t.includes('return delivered') || t.includes('returned to shipper'))
            return 'returned';
        if (t.includes('return'))
            return 'returning';
        if (t.includes('attempt') || t.includes('refused') || t.includes('review'))
            return 'attempted';
        if (t.includes('out for delivery'))
            return 'out_for_delivery';
        if (t.includes('expire') || t.includes('cancel'))
            return 'courier_cancelled';
        if (t.includes('unbooked') || t.includes('booked'))
            return 'dispatched';
        return 'in_transit';
    }
    const STATUS = {
        new: 'New', hold: 'No answer / hold', confirmed: 'Confirmed', cs_cancelled: 'Cancelled by CS', picked: 'Picked', packed: 'Packed',
        dispatched: 'Booked / dispatched', in_transit: 'In transit', out_for_delivery: 'Out for delivery', attempted: 'Delivery attempted',
        delivered: 'Delivered', returning: 'Returning', returned: 'Returned (RTO)', return_received: 'Return received', cancelled: 'Cancelled',
        courier_cancelled: 'Courier cancelled',
    };
    const OPEN_SHIP = ['dispatched', 'in_transit', 'out_for_delivery', 'attempted', 'returning'];
    // Courier names as staff/Shopify type them -> one spelling ('TCS Express', 'tcs courier' -> 'TCS'; 'Post Ex' -> 'PostEx'; own Karachi rider -> 'Rider')
    function normCourier(name) {
        const s = String(name == null ? '' : name).trim();
        if (!s)
            return null;
        const t = s.toLowerCase().replace(/[^a-z]/g, '');
        if (t.startsWith('tcs'))
            return 'TCS';
        if (t.startsWith('postex'))
            return 'PostEx';
        if (t === 'rider' || t === 'ownrider' || t === 'sbrider' || t === 'sundaybazarrider')
            return 'Rider';
        return s;
    }
    // which receivable / status rules an order follows: 'TCS', 'Rider' or 'PostEx' (PostEx = PostEx and anything else, as before)
    const courierKey = c => { const n = normCourier(c); return n === 'TCS' || n === 'Rider' ? n : 'PostEx'; };
    // TCS checkpoint / delivery status text (and delivery code) -> ERP status; null = text not recognised (shown as-is, treated as in transit)
    function mapTcs(text, code) {
        const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim(), c = String(code || '').toUpperCase();
        if (!t && !c)
            return null;
        if (/cancel|void/.test(t))
            return 'courier_cancelled';
        if (/returned to (shipper|origin|consignor|client)|(return|rts|rto)[a-z ]*(delivered|received by shipper|complete)|delivered to (shipper|origin|consignor)|^returned$/.test(t))
            return 'returned';
        if (/return|rts|rto|being sent back|send back/.test(t))
            return 'returning';
        if (/undeliver|not deliver|refus|not available|not responding|not answer|consignee (not|absent|moved|shifted)|address (closed|not found|incomplete|incorrect|wrong)|incomplete address|wrong address|closed|attempt|unable|rescheduled|future delivery|awaiting receiver|hold/.test(t))
            return 'attempted';
        if (/out for delivery|on route|en route|with courier|on delivery|for delivery/.test(t))
            return 'out_for_delivery';
        if (/deliver/.test(t) || c === 'OK')
            return 'delivered';
        if (/booked|booking|picked|pick up|pickup|data received|shipment received|received at origin|created/.test(t))
            return 'dispatched';
        if (/arriv|depart|transit|hub|facility|manifest|dispatch|forward|station|sorting|load|connected|received at|bagged|delay/.test(t))
            return 'in_transit';
        return null;
    }
    // Own rider: status text written by the rider app
    function mapRider(text) {
        const t = String(text || '').toLowerCase();
        if (!t)
            return null;
        if (t.startsWith('returned'))
            return 'returned';
        if (t.startsWith('delivered'))
            return 'delivered';
        if (t.startsWith('failed') || t.startsWith('rescheduled'))
            return 'attempted';
        if (t.startsWith('out'))
            return 'out_for_delivery';
        if (t.startsWith('assigned'))
            return 'dispatched';
        if (t.startsWith('cancel'))
            return 'courier_cancelled';
        return null;
    }
    function deriveStatus(o) {
        if (o.cancelled_at)
            return 'cancelled';
        if (o.return_received_at)
            return 'return_received';
        const ck = o.courier ? courierKey(o.courier) : 'PostEx';
        if (ck !== 'PostEx' && o.courier_status)
            return (ck === 'TCS' ? mapTcs(o.courier_status) : mapRider(o.courier_status)) || 'in_transit';
        const px = mapPostex(o.px_status);
        if (px)
            return px;
        if (o.tracking)
            return 'dispatched';
        return o.stage || 'new';
    }
    // Customer score from history: Trusted / Good / New / Risky / Blacklisted
    function scoreCustomer(c, flag) {
        if (flag && flag.blacklist)
            return { score: 0, label: 'Blacklisted' };
        const done = (c.delivered || 0) + (c.returned || 0);
        if (!done)
            return { score: 50, label: c.cancelled >= 2 ? 'Risky' : 'New' };
        const rate = c.delivered / done;
        let score = Math.round(rate * 80 + Math.min(20, c.delivered * 4));
        let label = 'Good';
        if (c.delivered >= 2 && rate >= 0.8)
            label = 'Trusted';
        if (rate < 0.5 || c.returned >= 2 && rate < 0.67)
            label = 'Risky';
        if (flag && flag.vip)
            label = 'Trusted';
        return { score, label };
    }
    function recomputeCustomers() {
        const flags = new Map(q.all('SELECT * FROM customer_flags').map(f => [f.phone, f]));
        const rows = q.all(`SELECT phone, MAX(cust_name) name, MAX(city) city, COUNT(*) orders,
      SUM(status='delivered') delivered, SUM(status IN ('returned','return_received','returning')) returned,
      SUM(status IN ('cancelled','cs_cancelled','courier_cancelled')) cancelled,
      SUM(status NOT IN ('delivered','returned','return_received','returning','cancelled','cs_cancelled','courier_cancelled')) open,
      SUM(CASE WHEN status='delivered' THEN total ELSE 0 END) spent, MIN(created_at) first_order, MAX(created_at) last_order
    FROM orders WHERE phone<>'' GROUP BY phone`);
        q.tx(() => {
            q.run('DELETE FROM customers');
            const ins = require('./db').db.prepare('INSERT INTO customers(phone,name,city,orders,delivered,returned,cancelled,open,spent,first_order,last_order,score,label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const r of rows) {
                const s = scoreCustomer(r, flags.get(r.phone));
                ins.run(r.phone, r.name, r.city, r.orders, r.delivered, r.returned, r.cancelled, r.open, r.spent || 0, r.first_order, r.last_order, s.score, s.label);
            }
        });
        return rows.length;
    }
    // Recompute status for one order and apply auto-confirm rule
    function refreshOrder(id) {
        const o = q.get('SELECT * FROM orders WHERE id=?', id);
        if (!o)
            return;
        const fix = {};
        // a parcel booked in the ERP (TCS / own rider) keeps its tracking when a Shopify re-sync brings the order back without a fulfillment
        if (!o.tracking && o.bk_tracking && !o.cancelled_at) {
            o.tracking = fix.tracking = o.bk_tracking;
            o.courier = fix.courier = o.bk_courier;
        }
        if (o.courier) {
            const nc = normCourier(o.courier);
            if (nc !== o.courier)
                o.courier = fix.courier = nc;
        }
        const mode = setting('confirm_mode', 'risky'); // off | risky | all
        if (o.stage === 'new' && !o.tracking && !o.cancelled_at) {
            let auto = mode === 'off';
            if (mode === 'risky') {
                const c = q.get('SELECT label FROM customers WHERE phone=?', o.phone);
                auto = !!c && c.label === 'Trusted';
            }
            if (auto) {
                q.run("UPDATE orders SET stage='confirmed', cs_note=COALESCE(cs_note,'Auto-confirmed') WHERE id=?", id);
                o.stage = 'confirmed';
            }
        }
        const st = deriveStatus(o);
        const now = new Date().toISOString();
        const set = Object.assign(Object.assign({}, fix), { status: st });
        const when = o.px_updated || o.courier_updated || now;
        if (st === 'delivered' && !o.delivered_at)
            set.delivered_at = when;
        if ((st === 'returned' || st === 'returning') && !o.returned_at)
            set.returned_at = when;
        if (o.tracking && !o.dispatched_at)
            set.dispatched_at = now;
        const keys = Object.keys(set);
        q.run(`UPDATE orders SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => set[k]), id);
    }
    // Pricing: markdown by age on site + lot sell-through, never below cost floor
    function priceSuggestion(p, rules, lotStats) {
        const r = rules || setting('pricing_rules', DEFAULT_RULES);
        const age = p.created_at ? Math.floor((Date.now() - Date.parse(p.created_at)) / 864e5) : 0;
        let step = null;
        for (const s of r.steps)
            if (age >= s.days)
                step = s;
        if (!step || !(p.qty > 0) || !(p.price > 0))
            return null;
        const ls = lotStats && lotStats[p.lot];
        let pct = step.off;
        if (ls && ls.sellThrough >= r.fastLot)
            pct = Math.max(0, pct - r.fastLotRelief);
        const floor = (p.cost || 0) * (1 + r.minMargin / 100);
        // markdown is measured from the original (compare-at) price when set, else the current price
        const base = p.compare_at && p.compare_at > p.price ? p.compare_at : p.price;
        let target = Math.round((base * (1 - pct / 100)) / r.roundTo) * r.roundTo - (r.endWith99 ? 1 : 0);
        if (target < floor)
            target = Math.ceil(floor / r.roundTo) * r.roundTo - (r.endWith99 ? 1 : 0);
        if (target >= p.price - r.roundTo / 2)
            return null;
        return { age, pct, target, floor: Math.round(floor), base };
    }
    const DEFAULT_RULES = {
        steps: [{ days: 30, off: 15 }, { days: 60, off: 30 }, { days: 90, off: 40 }, { days: 120, off: 50 }],
        minMargin: 20, roundTo: 100, endWith99: true, fastLot: 60, fastLotRelief: 10,
    };
    module.exports = { normPhone, waNumber, parseSku, mapPostex, mapTcs, mapRider, normCourier, courierKey, deriveStatus, STATUS, OPEN_SHIP, scoreCustomer, recomputeCustomers, refreshOrder, priceSuggestion, DEFAULT_RULES };
};