    // Practice data (all invented) so staff can learn the ERP before the real store is connected
    'use strict';
    const { q, setSetting } = require('./db');
    const L = require('./logic');
    function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
    function clear() {
        q.tx(() => {
            q.run("DELETE FROM order_items WHERE order_id LIKE 'demo%'");
            q.run("DELETE FROM orders WHERE id LIKE 'demo%'");
            q.run("DELETE FROM products WHERE variant_id LIKE 'demo%'");
            q.run("DELETE FROM cs_calls WHERE order_id LIKE 'demo%'");
            q.run("DELETE FROM returns WHERE order_id LIKE 'demo%'");
            q.run("DELETE FROM lots WHERE name LIKE 'DEMO-%'");
            q.run("DELETE FROM expenses WHERE note LIKE '[demo]%'");
            q.run('DELETE FROM locations');
            q.run('DELETE FROM customer_flags');
        });
        setSetting('demo', false);
        L.recomputeCustomers();
    }
    function load() {
        clear();
        const r = rng(42), pick = a => a[Math.floor(r() * a.length)], int = (a, b) => a + Math.floor(r() * (b - a + 1));
        const brands = ['Zara', 'Bershka', 'Pull & Bear', 'Nike', 'Adidas', 'Skechers', 'Clarks', 'Mango', 'Stradivarius', 'Puma', 'Lefties', 'Oysho'];
        const types = [['B', 'Ankle Boots', 'Boots'], ['S', 'Sneakers', 'Shoes'], ['S', 'Loafers', 'Shoes'], ['H', 'Block Heels', 'Heels'], ['F', 'Flats', 'Flats'], ['D', 'Sandals', 'Sandals']];
        const conds = ['Excellent', 'Good', 'Fair'], cities = ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Gujranwala', 'Sialkot', 'Hyderabad', 'Quetta', 'Bahawalpur'];
        const first = ['Ayesha', 'Fatima', 'Hira', 'Sana', 'Zainab', 'Maryam', 'Ali', 'Usman', 'Hamza', 'Bilal', 'Sara', 'Iqra', 'Nimra', 'Ahmed', 'Hassan', 'Mahnoor', 'Areeba', 'Saad'];
        const last = ['Khan', 'Malik', 'Butt', 'Sheikh', 'Qureshi', 'Raza', 'Iqbal', 'Hussain', 'Chaudhry', 'Mirza', 'Ansari', 'Siddiqui'];
        const racks = ['EA', 'EB', 'EC', 'ED', 'EE', 'EF', 'EG', 'EH'];
        const now = Date.now(), iso = ms => new Date(ms).toISOString();
        let serial = 90000;
        const products = [];
        q.tx(() => {
            // 6 lots, bought over the last ~4 months
            for (let li = 1; li <= 8; li++) {
                const lot = 'DEMO-Lot ' + String(li).padStart(2, '0'), listedAt = now - (150 - li * 18) * 864e5, pieces = int(110, 140), unit = int(1200, 1900);
                q.run('INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,updated_at) VALUES(?,?,?,?,?,?,datetime(\'now\'))', lot, pick(['Vendor A', 'Vendor B', 'Vendor C']), iso(listedAt - 6 * 864e5).slice(0, 10), pieces * unit, pieces, '[demo]');
                const listed = pieces - (li === 8 ? int(15, 30) : 0);
                for (let k = 0; k < listed; k++) {
                    const t = pick(types), brand = pick(brands), rack = pick(racks), sku = `${rack}-${t[0]}-${++serial}`;
                    const full = int(30, 140) * 100 - 1, price = Math.round(full * 0.7 / 100) * 100 - 1;
                    const p = { variant_id: 'demo-v' + serial, product_id: 'demo-p' + serial, title: `${brand} ${t[1].replace(/s$/, '')}`, sku, rack, category: t[0], price, compare_at: full, cost: unit,
                        qty: 1, created_at: iso(listedAt + k * 3600e3), lot, brand, ptype: t[1], size: 'Euro ' + int(36, 44), cond: pick(conds) };
                    products.push(p);
                    q.run(`INSERT INTO products(variant_id,product_id,title,sku,rack,category,price,compare_at,cost,qty,status,created_at,updated_at,tags,lot,brand,ptype,size,cond,image,handle)
          VALUES(?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,?,?,'',?)`, p.variant_id, p.product_id, p.title, p.sku, p.rack, p.category, p.price, p.compare_at, p.cost, 1, p.created_at, p.created_at, [t[2], brand, lot, p.cond].join(', '), lot, brand, p.ptype, p.size, p.cond, 'demo-' + serial);
                }
            }
            // customers: some loyal, some risky, many new
            const custs = Array.from({ length: 260 }, (_, i) => ({ phone: '03' + String(int(0, 4)) + String(10000000 + int(0, 89999999)).slice(0, 8).padStart(8, '0'), name: pick(first) + ' ' + pick(last), city: pick(cities),
                kind: i < 40 ? 'loyal' : i < 70 ? 'risky' : 'normal' }));
            const avail = products.filter(() => true);
            let num = 84000;
            for (let d = 59; d >= 0; d--) {
                const n = d === 0 ? 14 : int(6, 12);
                for (let k = 0; k < n && avail.length; k++) {
                    const c = r() < 0.35 ? pick(custs.slice(0, 70)) : pick(custs);
                    const created = now - d * 864e5 - int(0, 20) * 3600e3;
                    if (created > now)
                        continue;
                    const nItems = r() < 0.85 ? 1 : 2, items = [];
                    for (let x = 0; x < nItems && avail.length; x++) {
                        const el = [];
                        for (let z = 0; z < avail.length; z++)
                            if (Date.parse(avail[z].created_at) < created)
                                el.push(z);
                        if (!el.length)
                            break;
                        const idx = el[Math.floor(Math.pow(r(), 1.6) * el.length)];
                        items.push(avail.splice(idx, 1)[0]);
                    }
                    if (!items.length)
                        continue;
                    const id = 'demo-o' + (++num), total = items.reduce((s, p) => s + p.price, 0) + 199;
                    const age = (now - created) / 864e5;
                    let stage = 'new', tracking = null, px = null, cancelled = null, rdy = null;
                    const pDel = c.kind === 'loyal' ? 0.95 : c.kind === 'risky' ? 0.35 : 0.72;
                    if (age > 1.2) {
                        if (r() < 0.06)
                            cancelled = iso(created + 3600e3);
                        else {
                            stage = 'packed';
                            tracking = String(27000000000000 + num);
                            if (age > 6)
                                px = r() < pDel ? 'Delivered' : (age > 12 ? 'Returned' : 'Out For Return');
                            else if (age > 4)
                                px = r() < 0.15 ? 'Attempted' : (r() < pDel ? 'Delivered' : 'Out For Delivery');
                            else
                                px = age > 2 ? 'PostEx WareHouse' : 'Booked';
                            rdy = iso(created + int(10, 30) * 3600e3);
                        }
                    }
                    else if (age > 0.4)
                        stage = r() < 0.5 ? 'confirmed' : (r() < 0.5 ? 'hold' : 'new');
                    const pxAt = px ? iso(Math.min(now, created + (px === 'Delivered' ? int(3, 5) : px === 'Returned' ? int(9, 12) : 2) * 864e5)) : null;
                    q.run(`INSERT INTO orders(id,name,created_at,updated_at,phone,cust_name,city,address,total,shipping,discount,items,gateway,financial,fulfillment,tags,cancelled_at,source,tracking,courier,stage,px_status,px_updated,
            px_fee,px_tax,px_rev_fee,dispatched_at,settled,cs_attempts) VALUES(?,?,?,?,?,?,?,?,?,199,0,?,?,?,?,?,?,'web',?,?,?,?,?,?,?,?,?,?,?)`, id, 'SB' + num, iso(created), iso(created), c.phone, c.name, c.city, 'House ' + int(1, 400) + ', Street ' + int(1, 40), total, items.length, 'Cash on Delivery (COD)', 'PENDING', tracking ? 'FULFILLED' : 'UNFULFILLED', c.kind === 'loyal' ? 'courier: Trusted' : 'courier: New', cancelled, tracking, tracking ? 'PostEx' : null, stage, px, pxAt, px ? 250 : null, px ? 15 : null, px && /return/i.test(px) ? 150 : null, rdy, px === 'Delivered' && age > 12 ? 1 : 0, stage === 'hold' ? int(1, 3) : 0);
                    const received = px === 'Returned' && age > 18 ? iso(created + 14 * 864e5) : null;
                    if (received)
                        q.run('UPDATE orders SET return_received_at=? WHERE id=?', received, id);
                    for (const p of items) {
                        q.run('INSERT INTO order_items(order_id,sku,title,qty,price,variant_id,product_id) VALUES(?,?,?,?,?,?,?)', id, p.sku, p.title, 1, p.price, p.variant_id, p.product_id);
                        if (!cancelled && !received)
                            q.run('UPDATE products SET qty=0, sold_at=? WHERE variant_id=?', iso(created), p.variant_id);
                    }
                }
            }
            // expenses for this and last month
            for (const m of [0, 1]) {
                const dt = new Date(now - m * 30 * 864e5), ym = dt.toISOString().slice(0, 7);
                [['Salaries', 420000], ['Rent', 120000], ['Ads (Meta)', 380000], ['Electricity & internet', 45000], ['Packaging', 30000]].forEach(([cat, amt]) => q.run("INSERT INTO expenses(day,category,amount,note) VALUES(?,?,?,?)", ym + '-05', cat, amt, '[demo] sample'));
            }
        });
        for (const o of q.all("SELECT id FROM orders WHERE id LIKE 'demo%'"))
            L.refreshOrder(o.id);
        L.recomputeCustomers();
        for (const o of q.all("SELECT id FROM orders WHERE id LIKE 'demo%' AND stage='new'"))
            L.refreshOrder(o.id);
        setSetting('demo', true);
    }
    module.exports = { load, clear };
};