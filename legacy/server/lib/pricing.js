    // Listing prices: the same model as the SundayBazar Lister.
    // Price = what customers paid for this type and condition (Shopify), × gender × size × brand × lot × winter (boots),
    // never below the pair's cost + ads + delivery + rent/salaries + its share of the profit target.
    'use strict';
    const { P, M3, CEIL } = require('./pricedata');
    const CONDS = ['Like New', 'Premium', 'Excellent', 'Very Good', 'Good'];
    const OLD_CONDS = P.conds;
    // Sale plan: share of a lot expected to sell in each step, discount, day the step starts
    const PLAN3 = [{ share: .40, off: 0, day: 0 }, { share: .20, off: .10, day: 30 }, { share: .15, off: .20, day: 45 }, { share: .15, off: .30, day: 60 }, { share: .10, off: .40, day: 90 }];
    const KIND = { used: { f: 1, t: 'Used' }, leftover: { f: 1.03, t: 'Left-over' } };
    // Kids sell at their own prices (Shopify, last 6 months)
    M3.KIDS = { Shoes: 2650, Flats: 2300, Boots: 2550, Heels: 2400 };
    M3.LAD = { 'Like New': 1.15, 'Premium': 1.06, 'Excellent': 1, 'Very Good': 0.86, 'Good': 0.75 };
    // Boots sell for much more in winter (Oct–Feb vs Apr–Sep average price per pair)
    M3.WINTER = { 'Chelsea Ankle Boots': 1.45, 'Block Ankle Boots': 1.33, 'Combat Ankle Boots': 1.25, 'Long Boots': 1.38, 'Stilettos Ankle Boots': 1.41, 'Boots': 1.36 };
    // Men's boots: Men-Boots 4,393 vs Woman-Boots 3,120 per pair
    for (const t of ['Block Ankle Boots', 'Chelsea Ankle Boots', 'Combat Ankle Boots', 'Long Boots', 'Boots'])
        M3.GENDER[t] = Object.assign({ Woman: 1, Men: 1.35 }, M3.GENDER[t] || {});
    // Luxury brands vs the store average for the same kind of shoe (last 12 months)
    const LUX = { 'Michael Kors': 1.8, 'Tory Burch': 2.0, 'Coach': 1.8, 'Gucci': 2.3, 'Prada': 2.0, 'Christian Louboutin': 2.3, 'Salvatore Ferragamo': 1.9, 'Jimmy Choo': 2.2, 'Stuart Weitzman': 2.0, 'Kate Spade': 1.7, 'Ted Baker': 1.5, 'UGG': 1.6, 'Burberry': 2.2, 'Valentino': 2.3, 'Saint Laurent': 2.3, 'Dior': 2.4, 'Chanel': 2.5, 'Louis Vuitton': 2.5, 'Balenciaga': 2.3, 'Versace': 2.1, 'Fendi': 2.2, 'Marc Jacobs': 1.7, 'Calvin Klein': 1.35, 'Tommy Hilfiger': 1.3 };
    // Owner's numbers (Settings → Listing costs). Defaults = the Lister's settings, Oct 2026.
    const ECON_DEFAULTS = {
        adsMonthly: 2350000, ordersMonthly: 2936, soldMonthly: 2700, fixedMonthly: 2155780, targetProfit: 1000000,
        courierFwd: 190, courierReturn: 0, returnHandling: 0, packing: 120, codPct: 4, shipCharge: 199, maxReturn: 0.8, ladderPct: 0.05,
        labelW: 50, labelH: 25, status: 'draft', grams: 1000,
        letters: { Heels: 'H', Boots: 'B', Shoes: 'S', Flats: 'F', Kids: 'K', Bags: 'BG' },
        body: "<p>Authenticity meets excellence.<br>\nWe don't deal in fakes, copies, or replicas only the real deal.<br>\nOur imported, pre-owned items are meticulously inspected to ensure 100% genuine quality.<br>\nChoose from a variety of colors to match your style.<br>\nEnjoy a 7-day exchange policy for added peace of mind. Shop Sunday Bazar for trusted quality today!</p>",
    };
    const GROUP = { 'Block Heels': 'Heels', 'Kitten Heels': 'Heels', 'Pumps': 'Heels', 'Stilettos': 'Heels', 'Wedges': 'Heels',
        'Block Ankle Boots': 'Boots', 'Boots': 'Boots', 'Chelsea Ankle Boots': 'Boots', 'Combat Ankle Boots': 'Boots', 'Long Boots': 'Boots', 'Stilettos Ankle Boots': 'Boots',
        'Casual': 'Shoes', 'Formals': 'Shoes', 'Loafers': 'Shoes', 'Running': 'Shoes', 'Sports': 'Shoes',
        'Flats': 'Flats', 'Mules': 'Flats', 'Sandals': 'Flats', 'Slides': 'Flats', 'Bags': 'Bags' };
    const TITLE_NOUN = { 'Block Heels': 'Block Heel', 'Kitten Heels': 'Kitten Heel', 'Pumps': 'Pump', 'Stilettos': 'Stiletto', 'Wedges': 'Wedge',
        'Block Ankle Boots': 'Block Ankle Boot', 'Boots': 'Boot', 'Chelsea Ankle Boots': 'Stretchable Ankle Boot', 'Combat Ankle Boots': 'Combat Ankle Boot', 'Long Boots': 'Knee High Boot', 'Stilettos Ankle Boots': 'Stiletto Ankle Boot',
        'Casual': 'Casual Shoes', 'Formals': 'Formal Shoes', 'Loafers': 'Loafers', 'Running': 'Running Shoes', 'Sports': 'Sports Shoes',
        'Flats': 'Flats', 'Mules': 'Mules', 'Sandals': 'Sandals', 'Slides': 'Slides', 'Bags': 'Bag' };
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const STORE_AVG_VALUE = 3650;
    const r99 = x => Math.max(99, Math.ceil(x / 100) * 100 - 1);
    const ci = (obj, key) => Object.keys(obj).find(x => x.toLowerCase() === String(key || '').trim().toLowerCase());
    const seasonF = (type, now) => { const m = (now || new Date()).getMonth() + 1; return (m >= 10 || m <= 2) ? (M3.WINTER[type] || 1) : 1; };
    const brandTier = b => { const k = ci(P.brands, b); return k ? P.brands[k] : 'D'; };
    const tierMult = t => (P.tiers[t] || P.tiers.D)[1];
    const groupOf = (type, gender) => gender === 'Kids' ? 'Kids' : (GROUP[type] || 'Shoes');
    const types = () => Object.keys(P.grid).sort();
    const knownBrand = b => !!(ci(P.brands, b) || ci(P.brandIdx, b) || ci(M3.BRAND, b) || ci(LUX, b));
    const allBrands = () => [...new Set([...Object.keys(P.brands), ...Object.keys(P.brandIdx), ...Object.keys(M3.BRAND), ...Object.keys(LUX)])].sort();
    function autoTitle(v) { const noun = TITLE_NOUN[v.type] || v.type; const b = v.brand || 'Brand'; if (v.material === 'Leather')
        return `${b} ${noun} | 100% Authentic Leather`; if (v.material === 'Suede')
        return `${b} Suede ${noun}`; return `${b} ${noun}`; }
    function baseFor(type, cond, gender, now) {
        if (gender === 'Kids') {
            const g = M3.GROUP[type] || GROUP[type];
            const k = M3.KIDS[g] || 2450;
            return k * (M3.LAD[cond] || 1);
        }
        if (M3.FINAL[type] && M3.FINAL[type][cond])
            return M3.FINAL[type][cond] * seasonF(type, now);
        const g = P.grid[type];
        if (!g)
            return null;
        const v = Number(g[OLD_CONDS.indexOf(cond === 'Like New' ? 'Premium' : cond)]);
        return v * (cond === 'Like New' ? 1.08 : 1);
    }
    const genderF = (type, gender) => gender === 'Kids' ? 1 : ((M3.GENDER[type] || {})[gender] || 1);
    function sizeF(type, size, gender) {
        if (gender === 'Kids')
            return 1;
        const tab = M3.SIZE[M3.GROUP[type] || GROUP[type]];
        if (!tab)
            return 1;
        const m = String(size || '').match(/[\d.]+/);
        if (!m)
            return 1;
        const n = parseFloat(m[0]);
        const lo = Math.floor(n), hi = Math.ceil(n);
        if (n !== lo && lo === 38 && tab['38-39'])
            return tab['38-39'];
        const a = tab[String(lo)], b = tab[String(hi)];
        return a && b ? (a + b) / 2 : (a || b || 1);
    }
    function brandF(brand, type) {
        const g = M3.GROUP[type];
        const k = ci(M3.BRAND, brand);
        const lk = ci(LUX, brand);
        const lux = lk ? LUX[lk] : 0;
        if (k && g && M3.BRAND[k][g])
            return { f: Math.max(M3.BRAND[k][g], lux), src: 'sales' };
        if (lux)
            return { f: lux, src: 'sales' };
        const tg = P.typeGroup[type];
        const bk = ci(P.brandIdx, brand);
        if (bk && tg && P.brandIdx[bk][tg])
            return { f: P.brandIdx[bk][tg], src: 'sales' };
        const tier = brandTier(brand);
        return { f: { A: 1.6, B: 1.1 }[tier] || 1, src: 'tier' };
    }
    function lotF(lot) {
        if (!lot)
            return { f: 1, src: '' };
        const k = ci(M3.HIST, lot.name);
        if (k)
            return { f: M3.HIST[k], src: 'history' };
        const kd = KIND[lot.kind] || KIND.used;
        return { f: kd.f, src: kd.t };
    }
    function valueOf(type, cond, gender, brand, size, now) { const b = baseFor(type, cond, gender, now); return b ? b * genderF(type, gender) * (brand ? brandF(brand, type).f : 1) * (size ? sizeF(type, size, gender) : 1) : 0; }
    // One pricing engine for a given set of owner numbers. lotAvg(lot) → average value of a pair in that lot (for lots saved without "pairs by type").
    function engine(settings, opt) {
        opt = opt || {};
        const s = Object.assign({}, ECON_DEFAULTS, settings || {});
        const now = opt.now || new Date();
        const n = (k, d = 0) => (s[k] === undefined || s[k] === null || s[k] === '') ? d : (Number(s[k]) || 0);
        const adsPP = n('soldMonthly') > 0 ? n('adsMonthly') / n('soldMonthly') : 0;
        const ohBE = n('soldMonthly') > 0 ? n('fixedMonthly') / n('soldMonthly') : 0;
        const ohT = n('soldMonthly') > 0 ? (n('fixedMonthly') + n('targetProfit')) / n('soldMonthly') : 0;
        const cod = n('codPct') / 100, keep = (1 - M3.DISC) * (1 - cod);
        const E = { adsPP, ohBE, ohT, cod, keep, maxR: Math.min(0.95, n('maxReturn') || 0.8), ladder: n('ladderPct', 0.04) || 0.04,
            fwd: (n('courierFwd') + n('packing')) / M3.IPO, back: (n('courierReturn') + n('returnHandling')) / M3.IPO, credit: n('shipCharge', 199) / M3.IPO,
            mix: PLAN3.reduce((a, x) => a + x.share * (1 - x.off), 0) };
        const avgRet = type => M3.RET[type] != null ? M3.RET[type] : 0.2;
        const shipFor = type => { const r = avgRet(type); return (E.fwd + r * E.back) / (1 - r) - E.credit; };
        const add = type => ({ add: E.adsPP + shipFor(type), fixed: E.ohBE, profit: E.ohT - E.ohBE, keep: E.keep });
        // Average value of a pair in this lot. Lots saved with pairs-by-type use cpv instead. Otherwise: pairs already listed from the lot,
        // or, with too few, the value of an Excellent pair of the same type (so a sneaker lot is not costed like a heels lot).
        const lotAvg = (lot, type, gender) => (opt.lotAvg && opt.lotAvg(lot)) || (type && valueOf(type, 'Excellent', gender, null, null, now)) || STORE_AVG_VALUE;
        function pairCost(lot, type, cond, gender, brand, size) {
            if (!lot)
                return null;
            const v = valueOf(type, cond, gender, brand, size, now);
            if (Number(lot.cpv) > 0 && v)
                return lot.cpv * v;
            const pp = Number(lot.per_piece) || 0;
            return v ? pp * v / lotAvg(lot, type, gender) : pp;
        }
        // Average pair cost for a type (12 months of Shopify cost), split across conditions by value
        function avgCost(type, cond, gender) {
            const avg = M3.COST[type] || 1000;
            const vals = CONDS.map(c => baseFor(type, c, undefined, now) || 0).filter(x => x > 0);
            const mv = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            const v = (baseFor(type, cond, gender, now) || 0) * genderF(type, gender);
            return mv && v ? avg * v / mv : avg;
        }
        // Prices for all conditions together, so Like New > Premium > Excellent > Very Good > Good always holds
        function ladderRows(type, brand, costOf, o) {
            o = o || {};
            if (baseFor(type, 'Excellent', undefined, now) == null)
                return null;
            const A = add(type), bf = brandF(brand, type), lf = lotF(o.lot);
            const f = genderF(type, o.gender) * sizeF(type, o.size, o.gender) * bf.f * lf.f;
            const boot = !!M3.WINTER[type], winter = seasonF(type, now) > 1;
            const rows = CONDS.map(cn => {
                const model = r99(baseFor(type, cn, o.gender, now) * f);
                const cost = costOf(cn);
                // Ceiling: what customers actually paid for this gender/type/condition (boots: last winter), for this brand and size.
                // Listing above it makes pairs sell at about half the speed (Shopify, Oct 2026).
                const c = (!boot || winter) ? CEIL[(o.gender || 'Woman') + '|' + type + '|' + cn] : null;
                const ceil = c ? r99(c * bf.f * (o.gender === 'Men' ? 1 : sizeF(type, o.size, o.gender))) : null;
                const market = ceil ? Math.min(model, ceil) : model;
                const floor = cost != null ? r99((cost + A.add + A.fixed) / A.keep) : null; // break-even incl. ads, courier, rent and salaries: never below it
                const listFloor = cost != null ? r99((cost + A.add + A.fixed + A.profit) / A.keep) : null; // break-even + profit-target share
                // List at what customers pay; never below break-even. Profit is not added on top of the customers' price (that stops sales).
                const raw = floor != null ? Math.max(market, floor) : market;
                const status = floor == null ? '' : market >= listFloor ? 'ok' : market >= floor ? 'thin' : 'loss';
                return { cond: cn, market, model, ceil, floor, listFloor, cost, raw, status };
            });
            for (let i = rows.length - 1; i >= 0; i--)
                rows[i].final = i === rows.length - 1 ? rows[i].raw : Math.max(rows[i].raw, rows[i + 1].final, rows[i].market > rows[i + 1].market ? 0 : r99(rows[i + 1].market * (1 + E.ladder)));
            return { rows, bf, lf };
        }
        // One delivered pair, line by line. Cancelled and returned orders are already inside these numbers.
        function breakdown(p, cost, type) {
            const r = avgRet(type);
            const coupon = p * M3.DISC, credit = E.credit, codAmt = (p - coupon + credit) * E.cod;
            const courier = n('courierFwd') / M3.IPO / (1 - r), pack = n('packing') / M3.IPO / (1 - r), back = r * E.back / (1 - r);
            const own = p - coupon + credit - codAmt - cost - E.adsPP - courier - pack - back;
            return { p, coupon, credit, cod: codAmt, inHand: p - coupon + credit - codAmt, cost, ads: E.adsPP, courier, pack, back, own, fixed: E.ohBE, net: own - E.ohBE, r };
        }
        // The price for one pair. v = {type, cond, gender, brand, size, lot, override}
        function quote(v) {
            const ix = CONDS.indexOf(v.cond);
            if (ix < 0)
                return null;
            const costOf = cn => v.lot ? pairCost(v.lot, v.type, cn, v.gender, v.brand, v.size) : avgCost(v.type, cn, v.gender);
            const L = ladderRows(v.type, v.brand, costOf, { gender: v.gender, size: v.size, lot: v.lot });
            if (!L)
                return null;
            const x = L.rows[ix];
            let final = x.final, why = x.final !== x.raw ? 'Raised to stay above the lower condition'
                : x.status === 'ok' ? 'What customers pay for this kind of pair (profit included)'
                    : x.status === 'thin' ? 'What customers pay for this kind of pair: small profit after every cost'
                        : x.status === 'loss' ? 'Customers usually pay less than this pair costs to sell: held at break-even, it will sell slowly'
                            : 'What customers pay for this kind of pair';
            if (v.override) {
                final = Math.round(Number(v.override));
                why = 'Owner override';
            }
            const sales = PLAN3.slice(1).map(st => { const plain = r99(final * (1 - st.off)); const price = Math.max(x.floor || 0, plain); return { day: st.day, off: st.off, price, held: price > plain, net: breakdown(price, x.cost, v.type).net }; });
            return { final, why, status: x.status, ceil: x.ceil, market: x.market, floor: x.floor, listFloor: x.listFloor, cost: x.cost, estCost: !v.lot, brandSrc: L.bf.src, lotSrc: L.lf.src,
                bk: breakdown(final, x.cost, v.type), sales, target: E.ohT - E.ohBE, all: L.rows.map(r => ({ cond: r.cond, final: r.final })) };
        }
        // A new lot: cost per unit of value from the pairs-by-type counts (cpv), so each pair carries its fair share of the lot cost
        function lotPlan(l) {
            const ok = (Number(l.pieces) || 0) - (Number(l.bad) || 0);
            const total = (Number(l.cost) || 0) + (Number(l.extra) || 0);
            const rows = (l.comp || []).filter(r => r.n > 0 && valueOf(r.t, r.c, r.g, r.b, null, now));
            const nn = rows.reduce((a, r) => a + r.n, 0);
            const avgV = nn ? rows.reduce((a, r) => a + r.n * valueOf(r.t, r.c, r.g, r.b, null, now), 0) / nn : 0;
            const cpv = ok > 0 && avgV ? total / (avgV * ok) : 0;
            const per_piece = ok > 0 ? Math.round(total / ok) : 0;
            const fake = { name: l.name, kind: l.kind, cpv, per_piece };
            let contrib = 0, fixed = 0, listed = 0, lossN = 0, pairs = 0;
            const out = rows.map(r => {
                const size = r.g === 'Kids' ? 'Euro 30' : (M3.GROUP[r.t] === 'Shoes' && r.g === 'Men') ? 'Euro 42' : 'Euro 38';
                const L = ladderRows(r.t, r.b || '', cn => pairCost(fake, r.t, cn, r.g, r.b), { gender: r.g, size, lot: fake });
                const x = L.rows[CONDS.indexOf(r.c)];
                const slow = x.listFloor != null && x.market < x.listFloor;
                if (slow)
                    lossN += r.n;
                contrib += r.n * (x.final * E.mix * E.keep - E.adsPP - shipFor(r.t));
                fixed += r.n * E.ohBE;
                listed += r.n * x.final;
                pairs += r.n;
                return Object.assign(Object.assign({}, r), { cost: Math.round(x.cost), price: x.final, min: x.floor, market: x.market, slow });
            });
            const scale = pairs ? ok / pairs : 0;
            const c = contrib * scale * 0.9, fx = fixed * scale * 0.9;
            const per = ok ? c / (ok * 0.9) : 0;
            const payback = per > 0 ? Math.ceil(total / per) : null;
            return { ok, per_piece, cpv, rows: out, pairs, listed: Math.round(listed * scale), payback, profit: Math.round(c - total - fx), slow: lossN };
        }
        return { E, s, quote, pairCost, lotPlan, breakdown, shipFor, avgRet };
    }
    function tagsFor(it) {
        const d = new Date(it.at);
        const dd = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
        const g = it.grp;
        const t = [String(d.getFullYear()), dd, 'All', it.color, g, it.size, it.cond, it.lot, it.type, it.gender, `${it.gender}-${g}`, it.brand, MONTHS[d.getMonth()]];
        if (it.material)
            t.push(it.material);
        if (/Ankle Boots/.test(it.type))
            t.push('Ankle Boots');
        if (it.floor)
            t.push('Min-' + Math.round(it.floor)); // never sell below this (break-even after every cost), also during sales
        return [...new Set(t.filter(Boolean))].join(', ');
    }
    const csvCell = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    function shopifyCsv(items, s, withCost) {
        s = Object.assign({}, ECON_DEFAULTS, s || {});
        const head = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode', 'Image Src', 'Gift Card', 'Cost per item', 'Status'];
        const rows = [head];
        for (const it of items) {
            const handle = (it.brand + '-' + it.sku).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            rows.push([handle, it.title, s.body, it.brand, '', it.type, tagsFor(it), 'TRUE', 'Size', it.size, 'Condition', it.cond, 'Color', it.color, it.sku, s.grams || 1000, 'shopify', 1, 'deny', 'manual', it.price, '', 'TRUE', 'FALSE', it.sku, '', 'FALSE', withCost && it.cost != null ? Math.round(it.cost) : '', String(s.status || 'draft').toLowerCase()]);
        }
        return rows.map(r => r.map(csvCell).join(',')).join('\n');
    }
    module.exports = { engine, ECON_DEFAULTS, CONDS, PLAN3, KIND, GROUP, LUX, P, M3, r99, groupOf, types, allBrands, knownBrand, brandTier, autoTitle, valueOf, shopifyCsv, tagsFor, STORE_AVG_VALUE };
};