    // Shopify Admin GraphQL: token (Dev Dashboard client credentials OR old shpat_ token), sync, write-backs
    'use strict';
    const { q, db, setting, setSetting, syncLog } = require('./db');
    const L = require('./logic');
    const API_VERSION = '2025-10';
    let tok = null, tokExp = 0;
    function cfg() {
        const s = setting('shopify', {}) || {};
        let shop = String(s.shop || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (shop && !shop.includes('.'))
            shop += '.myshopify.com';
        return { shop, token: s.token || '', clientId: s.clientId || '', clientSecret: s.clientSecret || '' };
    }
    const configured = () => { const c = cfg(); return !!(c.shop && (c.token || (c.clientId && c.clientSecret))); };
    async function getToken() {
        const c = cfg();
        if (c.token)
            return c.token;
        if (tok && Date.now() < tokExp - 60000)
            return tok;
        const r = await fetch(`${process.env.SB_SHOPIFY_BASE || 'https://' + c.shop}/admin/oauth/access_token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }),
        });
        if (!r.ok)
            throw new Error('Shopify login failed (' + r.status + '). Check Client ID / Secret and that the app is installed.');
        const j = await r.json();
        tok = j.access_token;
        tokExp = Date.now() + (j.expires_in || 86399) * 1000;
        return tok;
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function gql(query, variables = {}, tries = 0) {
        const c = cfg();
        const r = await fetch(`${process.env.SB_SHOPIFY_BASE || 'https://' + c.shop}/admin/api/${API_VERSION}/graphql.json`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
            body: JSON.stringify({ query, variables }),
        });
        if (r.status === 401) {
            tok = null;
            if (tries < 1)
                return gql(query, variables, tries + 1);
            throw new Error('Shopify rejected the token (401)');
        }
        if (r.status === 429 || r.status >= 500) {
            if (tries < 5) {
                await sleep(2000 * (tries + 1));
                return gql(query, variables, tries + 1);
            }
            throw new Error('Shopify busy (' + r.status + ')');
        }
        const j = await r.json();
        if (j.errors && j.errors.length) {
            if (j.errors.some(e => e.extensions && e.extensions.code === 'THROTTLED') && tries < 8) {
                await sleep(3000);
                return gql(query, variables, tries + 1);
            }
            throw new Error(j.errors.map(e => e.message).join('; '));
        }
        // stay under the cost bucket
        const t = j.extensions && j.extensions.cost && j.extensions.cost.throttleStatus;
        if (t && t.currentlyAvailable < 300)
            await sleep(Math.ceil((400 - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000);
        return j.data;
    }
    const ORDER_FIELDS = `id name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus tags note phone
  paymentGatewayNames sourceName totalPriceSet{shopMoney{amount}} totalShippingPriceSet{shopMoney{amount}} totalDiscountsSet{shopMoney{amount}}
  shippingAddress{name phone address1 address2 city province} customer{id displayName defaultPhoneNumber{phoneNumber}}
  lineItems(first:15){nodes{title quantity sku variant{id} product{id} originalUnitPriceSet{shopMoney{amount}} discountedUnitPriceSet{shopMoney{amount}}}}
  fulfillments(first:3){status createdAt trackingInfo{number company}}`;
    function upsertOrder(n) {
        const a = n.shippingAddress || {};
        const phone = L.normPhone(a.phone || n.phone || (n.customer && n.customer.defaultPhoneNumber && n.customer.defaultPhoneNumber.phoneNumber));
        const ful = (n.fulfillments || []).find(f => (f.trackingInfo || []).some(t => t.number));
        const tr = ful ? ful.trackingInfo.find(t => t.number) : {};
        const items = (n.lineItems && n.lineItems.nodes) || [];
        const old = q.get('SELECT id FROM orders WHERE id=?', n.id);
        const vals = {
            name: n.name, created_at: n.createdAt, updated_at: n.updatedAt, customer_id: n.customer && n.customer.id, phone,
            cust_name: a.name || (n.customer && n.customer.displayName) || '', city: a.city || '', address: [a.address1, a.address2].filter(Boolean).join(', '),
            total: +(n.totalPriceSet && n.totalPriceSet.shopMoney.amount || 0), shipping: +(n.totalShippingPriceSet && n.totalShippingPriceSet.shopMoney.amount || 0),
            discount: +(n.totalDiscountsSet && n.totalDiscountsSet.shopMoney.amount || 0), items: items.reduce((s, i) => s + (i.quantity || 0), 0),
            gateway: (n.paymentGatewayNames || []).join(', '), financial: n.displayFinancialStatus, fulfillment: n.displayFulfillmentStatus,
            tags: (n.tags || []).join(', '), note: n.note || '', cancelled_at: n.cancelledAt, source: n.sourceName,
            tracking: tr.number || null, courier: tr.company || null,
        };
        const keys = Object.keys(vals);
        if (old)
            q.run(`UPDATE orders SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => vals[k]), n.id);
        else
            q.run(`INSERT INTO orders(id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, n.id, ...keys.map(k => vals[k]));
        // items: keep pick progress when the order is re-synced
        const picked = new Map(q.all('SELECT sku,picked,picked_by,picked_at FROM order_items WHERE order_id=?', n.id).map(r => [r.sku, r]));
        q.run('DELETE FROM order_items WHERE order_id=?', n.id);
        for (const i of items) {
            const p = picked.get(i.sku) || {};
            q.run('INSERT INTO order_items(order_id,sku,title,qty,price,variant_id,product_id,picked,picked_by,picked_at) VALUES(?,?,?,?,?,?,?,?,?,?)', n.id, i.sku || '', i.title, i.quantity, +((i.discountedUnitPriceSet || i.originalUnitPriceSet || { shopMoney: { amount: 0 } }).shopMoney.amount), i.variant && i.variant.id, i.product && i.product.id, p.picked || 0, p.picked_by || null, p.picked_at || null);
        }
        if (ful && ful.createdAt)
            q.run('UPDATE orders SET dispatched_at=COALESCE(dispatched_at,?) WHERE id=?', ful.createdAt, n.id);
        L.refreshOrder(n.id);
    }
    async function syncOrders(onProgress) {
        const first = !setting('orders_synced_at');
        const since = setting('orders_synced_at') || new Date(Date.now() - (setting('history_days', 60)) * 864e5).toISOString();
        const started = new Date().toISOString();
        const query = `updated_at:>='${new Date(Date.parse(since) - 10 * 60000).toISOString()}'`;
        let after = null, n = 0;
        do {
            const d = await gql(`query($q:String,$after:String){ orders(first:25, after:$after, query:$q, sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ ${ORDER_FIELDS} } } }`, { q: query, after });
            q.tx(() => { for (const o of d.orders.nodes)
                upsertOrder(o); });
            n += d.orders.nodes.length;
            onProgress && onProgress(n);
            after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
        } while (after);
        setSetting('orders_synced_at', started);
        if (n || first)
            L.recomputeCustomers();
        syncLog('shopify-orders', true, n + ' orders updated');
        return n;
    }
    const PRODUCT_FIELDS = `id title handle status createdAt updatedAt vendor productType tags featuredMedia{preview{image{url(transform:{maxWidth:200})}}}
  variants(first:5){nodes{ id sku price compareAtPrice inventoryQuantity selectedOptions{name value} inventoryItem{ id unitCost{amount} } }}`;
    function upsertProduct(p) {
        const tags = p.tags || [];
        const lot = tags.find(t => /lot/i.test(t)) || '';
        for (const v of (p.variants && p.variants.nodes) || []) {
            const opt = Object.fromEntries((v.selectedOptions || []).map(o => [o.name.toLowerCase(), o.value]));
            const sk = L.parseSku(v.sku);
            const prev = q.get('SELECT qty, sold_at FROM products WHERE variant_id=?', v.id);
            let sold_at = prev ? prev.sold_at : null;
            if (prev && prev.qty > 0 && v.inventoryQuantity <= 0 && !sold_at)
                sold_at = new Date().toISOString();
            if (v.inventoryQuantity > 0)
                sold_at = null;
            q.run(`INSERT INTO products(variant_id,product_id,title,sku,rack,category,price,compare_at,cost,qty,status,created_at,updated_at,tags,lot,brand,ptype,size,cond,image,handle,inventory_item,sold_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(variant_id) DO UPDATE SET product_id=excluded.product_id,title=excluded.title,sku=excluded.sku,rack=excluded.rack,
      category=excluded.category,price=excluded.price,compare_at=excluded.compare_at,cost=excluded.cost,qty=excluded.qty,status=excluded.status,created_at=excluded.created_at,
      updated_at=excluded.updated_at,tags=excluded.tags,lot=excluded.lot,brand=excluded.brand,ptype=excluded.ptype,size=excluded.size,cond=excluded.cond,image=excluded.image,
      handle=excluded.handle,inventory_item=excluded.inventory_item,sold_at=excluded.sold_at`, v.id, p.id, p.title, v.sku || '', sk.rack, sk.category, +v.price || 0, v.compareAtPrice ? +v.compareAtPrice : null, v.inventoryItem && v.inventoryItem.unitCost ? +v.inventoryItem.unitCost.amount : null, v.inventoryQuantity || 0, p.status, p.createdAt, p.updatedAt, tags.join(', '), lot, p.vendor || '', p.productType || '', opt.size || '', opt.condition || '', p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image ? p.featuredMedia.preview.image.url : '', p.handle, v.inventoryItem && v.inventoryItem.id, sold_at);
        }
    }
    async function syncProducts(onProgress) {
        const since = setting('products_synced_at');
        const started = new Date().toISOString();
        // first run: products listed in the last year (older stock is long sold); later runs: only what changed
        const query = since ? `updated_at:>='${new Date(Date.parse(since) - 10 * 60000).toISOString()}'` : `created_at:>='${new Date(Date.now() - setting('product_history_days', 365) * 864e5).toISOString()}' OR inventory_total:>0`;
        let after = null, n = 0;
        do {
            const d = await gql(`query($q:String,$after:String){ products(first:50, after:$after, query:$q, sortKey:UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ ${PRODUCT_FIELDS} } } }`, { q: query, after });
            q.tx(() => { for (const p of d.products.nodes)
                upsertProduct(p); });
            n += d.products.nodes.length;
            onProgress && onProgress(n);
            after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
        } while (after);
        setSetting('products_synced_at', started);
        syncLog('shopify-products', true, n + ' products updated');
        return n;
    }
    async function shopInfo() { return (await gql('{ shop{ name myshopifyDomain currencyCode } locations(first:10){ nodes{ id name isActive } } }')); }
    async function tagOrder(id, tags) {
        const d = await gql('mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }', { id, tags });
        const e = d.tagsAdd.userErrors;
        if (e.length)
            throw new Error(e.map(x => x.message).join('; '));
    }
    async function updatePrices(changes) {
        // changes: [{product_id, variant_id, price, compare_at}] grouped per product
        const byProduct = new Map();
        for (const c of changes) {
            if (!byProduct.has(c.product_id))
                byProduct.set(c.product_id, []);
            byProduct.get(c.product_id).push(c);
        }
        const results = [];
        for (const [pid, list] of byProduct) {
            try {
                const d = await gql(`mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid, variants:$v){ userErrors{ field message } } }`, { pid, v: list.map(c => ({ id: c.variant_id, price: String(c.price), compareAtPrice: c.compare_at ? String(c.compare_at) : null })) });
                const e = d.productVariantsBulkUpdate.userErrors;
                for (const c of list)
                    results.push({ variant_id: c.variant_id, ok: !e.length, error: e.map(x => x.message).join('; ') });
            }
            catch (err) {
                for (const c of list)
                    results.push({ variant_id: c.variant_id, ok: false, error: err.message });
            }
        }
        return results;
    }
    async function adjustInventory(inventoryItemId, delta, reason) {
        const locId = setting('shopify_location');
        if (!locId)
            throw new Error('Choose the Shopify location in Settings first');
        const d = await gql(`mutation($input:InventoryAdjustQuantitiesInput!){ inventoryAdjustQuantities(input:$input){ userErrors{ message } } }`, { input: { reason: reason || 'restock', name: 'available', changes: [{ delta, inventoryItemId, locationId: locId, changeFromQuantity: null }] } });
        const e = d.inventoryAdjustQuantities.userErrors;
        if (e.length)
            throw new Error(e.map(x => x.message).join('; '));
    }
    module.exports = { cfg, configured, getToken, gql, syncOrders, syncProducts, shopInfo, tagOrder, updatePrices, adjustInventory, upsertOrder, upsertProduct };
};