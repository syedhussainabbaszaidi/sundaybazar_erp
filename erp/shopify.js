/* SundayBazar ERP — Shopify: connection & automatic sync section (Settings) and the Shopify part of the order drawer.
   Uses the helpers of app.js (h, GET, POST, act, dt, ago, num, rs, table, toast, can, modal, field).
   Shopify credentials live in the server's .env file and are never sent to the browser. */
'use strict';

const SHOP_KIND = { orders: 'Orders', products: 'Products', customers: 'Customers', inventory: 'Stock levels', reconcile: 'Missing-data check', postex: 'PostEx' };
const SHOP_WRITE = { tags: 'Order tag', price: 'Price', inventory: 'Stock change', fulfillment: 'Fulfilment', fulfillment_cancel: 'Cancel fulfilment', fulfillment_event: 'Delivery update', order_cancel: 'Cancel order', refund: 'Refund' };

function shopifyCard(s, save) {
    const box = h('div', { class: 'card grid' }, h('h2', null, 'Shopify connection & automatic sync'), h('div', { class: 'muted small' }, 'Loading…'));
    const pill = (ok, yes, no, warn) => h('span', { class: 'b ' + (ok ? 'ok' : warn ? 'warn' : 'bad') }, ok ? yes : no);
    let timer = null;
    const draw = async () => {
        clearTimeout(timer);
        if (!document.body.contains(box) && box.isConnected === false && timer) return; // left the page
        let st;
        try {
            st = await GET('/api/shopify/status');
        } catch (e) {
            return box.replaceChildren(h('h2', null, 'Shopify connection & automatic sync'), h('div', { class: 'flash bad' }, e.message));
        }
        const res = h('div');
        const auto = (st.sync && st.sync.auto) || {};
        const lastOk = st.lastOk || {};
        const locSel = h('select', null, h('option', { value: '' }, st.counts.locations ? 'Choose the stock location…' : 'Test the connection to load locations'),
            ...(s.shopify.locations || []).filter(l => l.isActive).map(l => h('option', { value: l.id, selected: l.id === s.shopify_location }, l.name)));
        const run = (label, fn) => h('button', { class: 'btn ghost sm', disabled: !st.configured, onclick: async () => { try { await fn(); } catch (e) { res.replaceChildren(h('div', { class: 'flash bad' }, e.message)); } setTimeout(draw, 2500); } }, label);
        const startSync = (kind, msg) => act(() => POST('/api/sync', { kind }), msg);
        const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
        const w = st.writes || {};
        const issues = st.openIssues ? await GET('/api/shopify/issues').catch(() => []) : [];
        const lastHook = st.webhooks.last;
        box.replaceChildren(...[
            h('div', { class: 'row sp' }, h('h2', null, 'Shopify connection & automatic sync'),
                st.configured ? pill(st.connected, 'Connected', st.lastCheck ? 'Not connected' : 'Not tested yet', !st.lastCheck) : h('span', { class: 'b warn' }, 'Not configured')),
            st.configured ? null : h('div', { class: 'note warn' }, 'Shopify is set up on the server: put SHOPIFY_STORE_DOMAIN (the …myshopify.com address), SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the .env file, then press Test connection.'),
            st.uninstalled ? h('div', { class: 'flash bad' }, 'The ERP app was uninstalled from Shopify on ' + dt(st.uninstalled.at) + '. Install it again, then ', h('a', { href: '#', onclick: e => { e.preventDefault(); act(() => POST('/api/shopify/reinstalled'), 'Reconnected').then(draw); } }, 'reconnect'), '.') : null,
            h('dl', { class: 'dl' },
                kv('Store', h('span', { class: 'mono' }, st.shop || '–')),
                kv('Automatic sync', [pill(auto.active, 'running', 'not running'), ' ',
                    h('span', { class: 'small muted' }, auto.mode === 'webhooks'
                        ? 'Shopify sends every change the moment it happens (webhooks); a check every few minutes catches anything missed.'
                        : 'Checking Shopify for changes every minute' + (st.webhooks.registered ? ' (no webhook received recently).' : ' (webhooks need the live https address).')),
                    auto.lastTick ? h('div', { class: 'small muted' }, 'Last run ' + ago(auto.lastTick)) : null]),
                kv('Last successful sync', h('span', { class: 'small' }, ['orders', 'products', 'customers', 'inventory'].map(k => SHOP_KIND[k] + ' ' + ago(lastOk[k] || (st.lastSync || {})[k])).join(' · '))),
                kv('Last webhook', lastHook ? h('span', { class: 'small' }, lastHook.topic + ' · ' + ago(lastHook.received_at) + ' · ' + lastHook.status) : h('span', { class: 'small muted' }, 'none received yet')),
                kv('Waiting / failed', h('span', { class: 'small' + (st.webhooks.failed || st.failedJobs ? ' neg' : '') }, `${st.webhooks.pending} webhook(s) waiting · ${st.webhooks.failed} failed · ${st.failedJobs} failed job(s) · ${st.failedWrites} failed Shopify update(s) in 7 days`)),
                kv('In the ERP', h('span', { class: 'small' }, `${num(st.counts.orders)} orders · ${num(st.counts.products)} products (${num(st.counts.variants)} variants) · ${num(st.counts.customers)} customers · ${num(st.counts.locations)} locations`)),
                kv('Login', h('span', { class: 'small' }, st.auth + ' · API ' + st.apiVersion + ' · last check ' + (st.lastCheck ? ago(st.lastCheck.at) : 'never'))),
                st.missingScopes && st.missingScopes.length ? kv('Permissions missing', h('span', { class: 'neg small' }, st.missingScopes.join(', '))) : null,
                kv('ERP → Shopify', h('span', { class: 'small' }, [['tags', 'order tags'], ['fulfillments', 'fulfilments & delivery updates'], ['inventory', 'stock'], ['prices', 'prices'], ['order_cancel', 'cancellations'], ['refunds', 'refunds']].map(([k, l]) => h('span', { class: 'b ' + (w[k] ? 'ok' : 'bad') }, l + (w[k] ? '' : ' (stopped in .env)')))))),
            st.sync && st.sync.running ? h('div', { class: 'note' }, h('span', { class: 'spin' }), ' ', SHOP_KIND[st.sync.kind] || st.sync.kind || 'Sync', ': ', st.sync.progress) : null,
            h('div', { class: 'row' },
                run('Sync now', () => startSync('all', 'Sync started')),
                (st.webhooks.failed || st.failedJobs || st.recentErrors.length) ? run('Retry failed', async () => { const r = await POST('/api/shopify/retry'); res.replaceChildren(h('div', { class: r.stillFailed ? 'flash bad' : 'flash ok' }, `${r.webhooksRetried} webhook(s) processed again, ${r.stillFailed} still failing; sync started.`)); }) : null,
                run('Check for missing data', () => startSync('reconcile', 'Check started')),
                run('Run the initial import again', async () => { if (confirm('Import all orders (last 60 days), products, customers and stock levels again? Existing records are updated, nothing is duplicated. It can take 20–40 minutes.')) await startSync('full', 'Initial import started'); }),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn ghost sm', onclick: draw }, 'Refresh')),
            res,
            st.recentErrors && st.recentErrors.length ? h('details', null, h('summary', { class: 'small neg' }, `Recent sync errors (${st.recentErrors.length})`),
                table([{ t: 'When', f: x => dt(x.at) }, { t: 'What', f: x => SHOP_KIND[x.kind] || x.kind }, { t: 'Error', f: x => h('span', { class: 'small' }, x.message) }], st.recentErrors)) : null,
            issues.length ? h('details', { open: true }, h('summary', null, h('strong', null, `Needs review (${issues.length})`)), table([
                { t: 'When', f: x => dt(x.at) }, { t: 'What', f: x => h('span', { class: 'b warn' }, x.kind) }, { t: 'Record', f: x => h('span', { class: 'small mono' }, x.entity_id || x.entity || '') },
                { t: 'Details', f: x => h('span', { class: 'small' }, x.message) },
                { t: '', f: x => can('shopify_manage') ? h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/shopify/issues/${x.id}/resolve`), 'Marked as handled').then(draw) }, 'Handled') : null }], issues)) : null,
            st.recentWrites && st.recentWrites.length ? h('details', null, h('summary', { class: 'small muted' }, 'Changes sent from the ERP to Shopify (who, what, accepted?)'), table([
                { t: 'When', f: x => dt(x.at) }, { t: 'Who', f: x => x.user || 'automatic' }, { t: 'What', f: x => SHOP_WRITE[x.kind] || x.kind }, { t: 'On', f: x => x.order_name || h('span', { class: 'small mono' }, String(x.target_id || '').split('/').pop()) },
                { t: 'Result', f: x => [h('span', { class: 'b ' + (x.status === 'ok' ? 'ok' : x.status === 'pending' ? 'info' : 'bad') }, x.status === 'ok' ? 'accepted' : x.status), x.error ? h('div', { class: 'small neg' }, x.error) : null] }], st.recentWrites)) : null,
            can('shopify_manage') ? h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', disabled: !st.configured, onclick: async () => {
                    try {
                        const r = await POST('/api/settings/test-shopify');
                        res.replaceChildren(h('div', { class: 'flash ok' }, `Connected to ${r.shop.name} (${r.shop.myshopifyDomain}).`, r.missingScopes && r.missingScopes.length ? h('div', { class: 'small' }, 'Missing permissions: ' + r.missingScopes.join(', ')) : ''));
                        s = await GET('/api/settings');
                        draw();
                    } catch (e) { res.replaceChildren(h('div', { class: 'flash bad' }, e.message)); }
                } }, 'Test connection'), 'Stock location', locSel,
                h('button', { class: 'btn ghost sm', onclick: () => save({ shopify_location: locSel.value }, 'Stock location saved') }, 'Save location'),
                h('button', { class: 'btn ghost sm', disabled: !st.configured, onclick: async () => { try { const r = await POST('/api/shopify/webhooks'); res.replaceChildren(h('div', { class: 'flash ok' }, `Webhooks: ${r.created.length} created, ${r.existing.length} already there.`, Object.keys(r.failed).length ? h('div', { class: 'small' }, 'Failed: ' + Object.entries(r.failed).map(([t, e]) => t + ' (' + e + ')').join('; ')) : '')); draw(); } catch (e) { res.replaceChildren(h('div', { class: 'flash bad' }, e.message)); } } }, 'Register webhooks')) : null,
            h('div', { class: 'small muted' }, 'Stock changes from the ERP (returns, corrections) go to the stock location only. Webhook address: ', h('span', { class: 'mono' }, st.webhookUrl),
                st.webhooks.registered ? ' · ' + (st.webhooks.registered.topics || []).length + ' topics registered ' + ago(st.webhooks.registered.at) : ' · not registered (needs the live https address)'),
            st.runs && st.runs.length ? h('details', null, h('summary', { class: 'small muted' }, 'Recent imports'), table([
                { t: 'Started', f: x => dt(x.started_at) }, { t: 'What', f: x => (SHOP_KIND[x.kind] || x.kind) + ' · ' + x.mode }, { t: 'Status', f: x => h('span', { class: 'b ' + (x.status === 'done' ? 'ok' : x.status === 'failed' ? 'bad' : 'info') }, x.status) },
                { t: 'Records', n: 1, f: x => num(x.items) }, { t: 'Error', f: x => h('span', { class: 'small neg' }, x.error || '') }], st.runs)) : null,
        ].filter(Boolean)); // native replaceChildren would print null as text
        if (st.sync && st.sync.running && box.isConnected) timer = setTimeout(draw, 5000);
    };
    draw();
    return box;
}

/* Shopify's own state of an order, shown apart from the ERP stage so a stage change is never mistaken for a Shopify change. */
function shopifyOrderCard(d, reload) {
    const o = d.order;
    if (!/^gid:\/\/shopify\/Order\//.test(String(o.id)))
        return h('div');
    const shopNum = String(o.id).split('/').pop();
    const low = v => String(v || '').toLowerCase().replace(/_/g, ' ');
    const fin = low(o.financial), ful = low(o.fulfillment);
    const finCls = /^paid$/.test(fin) ? 'ok' : /refund|void/.test(fin) ? 'bad' : /partially/.test(fin) ? 'warn' : '';
    const done = r => { toast(r.already ? 'Already done in Shopify' : 'Shopify accepted it'); reload(); };
    const typed = (word, note) => { const i = h('input', { placeholder: 'Type ' + word + ' to confirm', autocomplete: 'off' }); return [h('div', { class: 'note warn' }, note), field('Confirm', i), i]; };

    const cancel = () => {
        const reason = h('select', null, [['CUSTOMER', 'Customer changed their mind'], ['INVENTORY', 'Item not available'], ['FRAUD', 'Fraud'], ['DECLINED', 'Payment declined'], ['STAFF', 'Staff error'], ['OTHER', 'Other']].map(([v, l]) => h('option', { value: v }, l)));
        const restock = h('input', { type: 'checkbox', checked: true });
        const [warn, conf, input] = typed('CANCEL', 'This cancels the order in Shopify itself and cannot be undone. No refund is sent from here. Use "Cancel order" under "Move order to" if you only want to stop it in the ERP.');
        const m = modal('Cancel ' + o.name + ' in Shopify', h('div', { class: 'grid' }, warn, field('Reason', reason), h('label', { class: 'row' }, restock, 'Put the items back in stock'), conf),
            [h('button', { class: 'btn bad', onclick: async () => { try { const r = await POST(`/api/orders/${encodeURIComponent(o.id)}/shopify-cancel`, { confirm: input.value.trim(), reason: reason.value, restock: restock.checked }); toast(r.cancelled ? 'Cancelled in Shopify' : 'Shopify accepted the cancellation; it shows here once Shopify finishes it'); m.remove(); reload(); } catch (e) { toast(e.message, true); } } }, 'Cancel in Shopify')]);
    };
    const fulfil = () => {
        const tn = h('input', { value: o.tracking || '', placeholder: 'Tracking number (optional)' }), co = h('input', { value: o.courier || '', placeholder: 'e.g. PostEx, TCS' }), url = h('input', { placeholder: 'https://… (optional)' });
        const m = modal('Mark ' + o.name + ' fulfilled in Shopify', h('div', { class: 'grid' }, h('div', { class: 'small muted' }, 'Marks every open item of the order as fulfilled in Shopify. The customer is not e-mailed. Courier bookings in the ERP do this automatically.'),
            h('div', { class: 'two' }, field('Tracking number', tn), field('Courier', co)), field('Tracking link', url)),
            [h('button', { class: 'btn', onclick: async () => { try { const r = await POST(`/api/orders/${encodeURIComponent(o.id)}/shopify-fulfil`, { tracking: tn.value.trim(), company: co.value.trim(), url: url.value.trim() }); m.remove(); done(r); } catch (e) { toast(e.message, true); } } }, 'Fulfil in Shopify')]);
    };
    const refund = async () => {
        let r;
        try { r = await GET(`/api/orders/${encodeURIComponent(o.id)}/shopify-refundable`); } catch (e) { return toast(e.message, true); }
        if (!(r.available > 0)) return toast('Shopify has no payment on this order that can be refunded' + (/cash/i.test(o.gateway || '') ? ' (cash on delivery: refund it outside Shopify, e.g. under Refunds)' : ''), true);
        const amt = h('input', { type: 'number', min: 1, max: r.available, step: '0.01', value: r.available }), note = h('input', { placeholder: 'Why (kept in Shopify and in the activity log)' }), notify = h('input', { type: 'checkbox' });
        const [warn, conf, input] = typed('REFUND', `Sends money back to the customer's original payment (${r.parent && r.parent.gateway || 'payment'}). Paid ${rs(r.paid)}, already refunded ${rs(r.refunded)}, at most ${rs(r.available)} now. This cannot be undone.`);
        const requestId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // one id per dialog: a double click cannot refund twice
        const m = modal('Refund ' + o.name + ' in Shopify', h('div', { class: 'grid' }, warn, h('div', { class: 'two' }, field('Amount (Rs)', amt), field('Reason', note)), h('label', { class: 'row' }, notify, 'E-mail the customer about the refund'), conf),
            [h('button', { class: 'btn bad', onclick: async (e) => { e.target.disabled = true; try { const x = await POST(`/api/orders/${encodeURIComponent(o.id)}/shopify-refund`, { amount: +amt.value, note: note.value.trim(), notify: notify.checked, confirm: input.value.trim(), request_id: requestId }); m.remove(); done(x); } catch (err) { e.target.disabled = false; toast(err.message, true); } } }, 'Refund in Shopify')]);
    };

    const tx = d.transactions || [], writes = d.shopifyWrites || [];
    const unfulfilled = !/^fulfilled$/.test(ful) && !o.cancelled_at;
    return h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h2', null, 'In Shopify'), h('a', { class: 'small', target: '_blank', rel: 'noopener', href: `https://${d.shop}/admin/orders/${shopNum}` }, 'Open in Shopify ↗')),
        h('dl', { class: 'dl' },
            h('dt', null, 'Payment'), h('dd', null, h('span', { class: 'b ' + finCls }, fin || '–'), ' ',
                h('span', { class: 'small' }, 'received ' + rs(o.received || 0), o.outstanding ? ' · still to pay ' + rs(o.outstanding) : '', o.total_refunded ? ' · refunded ' + rs(o.total_refunded) : ''),
                o.gateway ? h('div', { class: 'small muted' }, o.gateway) : null),
            tx.length ? [h('dt', null, 'Transactions'), h('dd', null, tx.map(t => h('div', { class: 'small' + (t.status !== 'SUCCESS' ? ' muted' : '') }, dt(t.processed_at), ' · ', low(t.kind), ' ', rs(t.amount), ' · ', t.gateway, t.status !== 'SUCCESS' ? ' (' + low(t.status) + ')' : '')))] : null,
            h('dt', null, 'Fulfilment'), h('dd', null, h('span', { class: 'b ' + (ful === 'fulfilled' ? 'ok' : '') }, ful || '–'),
                (d.fulfillments || []).map(f => h('div', { class: 'small muted' }, (f.tracking_company || '') + ' ' + (f.tracking_number || '') + ' · ' + low(f.display_status || f.status) + (f.delivered_at ? ' ' + dt(f.delivered_at) : '')))),
            h('dt', null, 'Cancelled'), h('dd', null, o.cancelled_at ? h('span', { class: 'b bad' }, dt(o.cancelled_at) + (o.cancel_reason ? ' · ' + low(o.cancel_reason) : '')) : 'no'),
            h('dt', null, 'Last update'), h('dd', null, dt(o.updated_at), o.synced_at ? h('span', { class: 'small muted' }, ' · synced ' + ago(o.synced_at)) : '')),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => act(() => POST(`/api/orders/${encodeURIComponent(o.id)}/shopify-refresh`), 'Updated from Shopify').then(reload) }, 'Refresh from Shopify'),
            can('orders_fulfil') && unfulfilled ? h('button', { class: 'btn ghost sm', onclick: fulfil }, 'Fulfil in Shopify…') : null,
            can('orders_refund') && (o.received > 0) ? h('button', { class: 'btn ghost sm', onclick: refund }, 'Refund in Shopify…') : null,
            can('orders_cancel') && !o.cancelled_at && !o.tracking ? h('button', { class: 'btn ghost sm bad', onclick: cancel }, 'Cancel in Shopify…') : null),
        writes.length ? h('details', null, h('summary', { class: 'small muted' }, 'Changes sent to Shopify for this order'), writes.map(x => h('div', { class: 'small' }, dt(x.at), ' · ', x.user || 'automatic', ' · ', SHOP_WRITE[x.kind] || x.kind, ' · ',
            h('span', { class: x.status === 'ok' ? 'pos' : 'neg' }, x.status === 'ok' ? 'accepted' : x.status + (x.error ? ': ' + x.error : ''))))) : null,
        h('div', { class: 'small muted' }, 'The ERP stage above ("Move order to") is for the team only; the buttons here change the order in Shopify and show the result Shopify confirms.'));
}
