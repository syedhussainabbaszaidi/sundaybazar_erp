/* SundayBazar ERP — Staff & access: staff accounts, roles & permissions, activity log.
   Uses the helpers of app.js (h, GET, POST, api, act, modal, table, tabs, render, dt, toast, can, field, META, ME).
   The server enforces every rule (no self-escalation, last super administrator, roles you may give);
   this screen only shows what is allowed. */
'use strict';

const SBACCESS = {
    /** permission catalogue grouped by module: [[module, [[key,label,action], ...]], ...] */
    groups(perms) {
        const m = new Map();
        for (const [k, label, module, action] of perms) {
            if (!m.has(module || 'Other')) m.set(module || 'Other', []);
            m.get(module || 'Other').push([k, label, action || label]);
        }
        return [...m.entries()];
    },
    /** permissions I may hand out */
    mine() { return META.isSuper ? null : new Set(ME.perms); },
    /** a module-by-module grid of checkboxes. opts: { checked:Set, fromRole:Set, base:Set, locked:fn(key) } -> { el, value(): [keys] } */
    grid(perms, opts) {
        const boxes = [];
        const el = h('div', { class: 'acc-grid' }, SBACCESS.groups(perms).map(([module, list]) => h('fieldset', { class: 'acc-mod' },
            h('legend', null, module),
            list.map(([k, label, action]) => {
                const base = opts.base.has(k), lockedByMe = !base && opts.locked(k);
                const cb = h('input', { type: 'checkbox', value: k, checked: opts.checked.has(k) || base, disabled: base || lockedByMe });
                boxes.push(cb);
                const tag = base ? h('span', { class: 'b' }, 'everyone') : opts.fromRole && opts.fromRole.has(k) ? h('span', { class: 'b info' }, 'role') : null;
                const row = h('label', { class: 'acc-perm' + (lockedByMe ? ' locked' : ''), title: lockedByMe ? 'You do not have this access yourself, so you cannot give it' : label }, cb, h('span', null, h('strong', null, action), h('small', null, label)), tag);
                if (opts.fromRole) cb.addEventListener('change', () => row.classList.toggle('changed', cb.checked !== opts.fromRole.has(k)));
                return row;
            }))));
        return { el, value: () => boxes.filter(b => b.checked).map(b => b.value) };
    },
    badgeFor(u) {
        if (u.pending) return h('span', { class: 'b warn' }, 'waiting for approval');
        return u.active ? h('span', { class: 'b ok' }, 'active') : h('span', { class: 'b bad' }, 'blocked');
    },
};

if (!document.getElementById('acc-css'))
    document.head.append(h('style', { id: 'acc-css' }, `.acc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;max-height:46vh;overflow:auto;padding:2px}
.acc-mod{border:1px solid var(--line);border-radius:10px;padding:8px 10px 6px;margin:0;min-width:0}
.acc-mod legend{font-weight:700;font-size:12.5px;padding:0 4px;color:var(--ink)}
.acc-perm{display:flex;gap:8px;align-items:flex-start;padding:5px 4px;border-radius:7px;cursor:pointer}
.acc-perm:hover{background:var(--hover)}.acc-perm input{margin-top:3px;width:16px;height:16px;flex:none;accent-color:var(--brand2)}
.acc-perm span{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}.acc-perm small{color:var(--muted);font-size:11.5px;line-height:1.3}
.acc-perm.locked{opacity:.55;cursor:not-allowed}.acc-perm.changed{background:var(--accent-soft)}
.acc-perm .b{font-size:10.5px;align-self:center}
.acc-super{padding:12px;border-radius:10px;background:var(--info-bg);color:var(--info);font-size:13px}`));

VIEWS.staff = async (args) => {
    const T = [['users', 'Staff accounts']];
    if (can('roles') || can('users')) T.push(['roles', 'Roles & permissions']);
    if (can('audit')) T.push(['log', 'Activity log']);
    let tab = T.some(t => t[0] === args[0]) ? args[0] : 'users';
    const head = tabs(T, tab, t => { location.hash = '#/staff/' + t; });

    if (tab === 'log') {
        const ev = await GET('/api/events');
        return render(head, h('div', { class: 'card' }, table([{ t: 'When', f: e => dt(e.at) }, { t: 'Who', f: e => e.user || 'System' }, { t: 'Action', k: 'action' }, { t: 'On', k: 'entity' },
            { t: 'Details', f: e => h('span', { class: 'small muted' }, String(e.detail || '').slice(0, 160)) }], ev)));
    }

    const R = await GET('/api/roles');
    const roleBy = Object.fromEntries(R.roles.map(r => [r.key, r]));
    const base = new Set(R.base);
    const mine = SBACCESS.mine();
    const locked = k => mine ? !mine.has(k) : false;
    const assignable = r => (!r.super || META.isSuper) && (!mine || r.perms.every(p => mine.has(p)));

    if (tab === 'roles') {
        const roleForm = (r) => {
            const isNew = !r;
            r = r || { key: '', name: '', description: '', perms: [...base], super: false, system: false, users: 0 };
            const name = h('input', { value: r.name, maxlength: 80 }), desc = h('input', { value: r.description || '', maxlength: 255, placeholder: 'What this role is for' });
            const g = r.super ? null : SBACCESS.grid(R.perms, { checked: new Set(r.perms), base, locked });
            const mayEdit = can('roles') && (META.isSuper || (ME.role !== r.key && (!mine || r.perms.every(p => mine.has(p)))));
            const m = modal(isNew ? 'New role' : 'Role: ' + r.name, h('div', { class: 'grid' },
                h('div', { class: 'two' }, field('Role name', name), field('Description', desc)),
                r.super ? h('div', { class: 'acc-super' }, 'Super administrator: always has every permission, including new ones. Only super administrators can give this role.')
                    : [h('div', { class: 'small muted' }, 'Tick what people with this role may see and do. Changes apply to everybody with this role.'), g.el],
                !mayEdit && !isNew ? h('div', { class: 'note warn' }, ME.role === r.key ? 'This is your own role: another administrator has to change it.' : 'You can view this role but not change it.') : null),
                mayEdit || isNew ? [
                    !isNew && !r.system && !r.users ? h('button', { class: 'btn ghost bad', onclick: async () => { if (!confirm('Delete the role "' + r.name + '"?')) return; await act(() => api('DELETE', '/api/roles/' + encodeURIComponent(r.key)), 'Role deleted'); m.remove(); VIEWS.staff(['roles']); } }, 'Delete role') : null,
                    h('button', { class: 'btn', onclick: () => {
                            const body = { name: name.value, description: desc.value };
                            if (g) body.perms = g.value();
                            act(() => isNew ? POST('/api/roles', body) : POST('/api/roles/' + encodeURIComponent(r.key), body), 'Role saved').then(() => { m.remove(); VIEWS.staff(['roles']); });
                        } }, isNew ? 'Create role' : 'Save role')] : null);
        };
        return render(head, h('div', { class: 'card' },
            h('div', { class: 'row sp', style: { marginBottom: '10px' } }, h('span', { class: 'small muted' }, 'A role is a set of permissions. Give each person a role, then add or remove single permissions for that person if needed.'),
                can('roles') ? h('button', { class: 'btn', onclick: () => roleForm() }, '+ New role') : null),
            table([{ t: 'Role', f: r => [h('strong', null, r.name), h('div', { class: 'small muted' }, r.description || '')] },
                { t: 'Type', f: r => r.super ? h('span', { class: 'b info' }, 'super admin') : r.system ? h('span', { class: 'b' }, 'built-in') : h('span', { class: 'b ok' }, 'custom') },
                { t: 'Permissions', n: 1, f: r => r.super ? 'all' : String(r.perms.length) }, { t: 'People', n: 1, k: 'users' }], R.roles, roleForm)));
    }

    // ---- staff accounts
    const users = await GET('/api/users');
    let filter = args[1] === 'pending' ? 'pending' : '';
    const userForm = (u) => {
        const isNew = !u;
        u = u || { name: '', username: '', email: '', role: 'staff', grant: [], revoke: [], active: 1, perms: null, pending: false };
        const self = !isNew && u.id === ME.id;
        const editable = META.isSuper || !u.super;
        const name = h('input', { value: u.name, maxlength: 120 }), email = h('input', { type: 'email', value: u.email || '', maxlength: 191 }),
            user = h('input', { value: u.username, disabled: !isNew, autocapitalize: 'none', placeholder: isNew ? 'made from the e-mail if empty' : '' }),
            pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: isNew ? '8+ characters, a letter and a number' : 'New password (leave empty to keep)' });
        const roleSel = h('select', { disabled: self || !editable }, R.roles.filter(r => assignable(r) || r.key === u.role).map(r => h('option', { value: r.key, selected: r.key === u.role, disabled: !assignable(r) }, r.name)));
        const active = h('input', { type: 'checkbox', checked: !!u.active, disabled: self || !editable });
        const permBox = h('div');
        let g = null;
        const drawGrid = () => {
            const r = roleBy[roleSel.value];
            if (!r) return permBox.replaceChildren();
            if (r.super) { g = null; return permBox.replaceChildren(h('div', { class: 'acc-super' }, 'Super administrator: full control of the ERP (every permission).')); }
            const fromRole = new Set(r.perms);
            const checked = new Set(r.perms);
            if (roleSel.value === u.role) { (u.grant || []).forEach(k => checked.add(k)); (u.revoke || []).forEach(k => checked.delete(k)); }
            g = SBACCESS.grid(R.perms, { checked, fromRole, base, locked: k => self || !editable || (locked(k) && !fromRole.has(k)) });
            permBox.replaceChildren(h('div', { class: 'small muted' }, 'Ticks marked "role" come from the role. Untick one to take it away from this person only; tick another to give it to this person only (highlighted).'), g.el);
        };
        roleSel.addEventListener('change', drawGrid);
        drawGrid();
        const m = modal(isNew ? 'Add staff member' : (u.pending ? 'Approve ' : 'Edit ') + u.name, h('div', { class: 'grid' },
            u.pending ? h('div', { class: 'note warn' }, 'Registered on ' + dt(u.created_at) + '. Check the person, choose the role, tick "Account active" and save to approve.') : null,
            self ? h('div', { class: 'note' }, 'This is your own account: you can change your name, e-mail and password here; another administrator changes your role and access.') : null,
            !editable ? h('div', { class: 'note warn' }, 'Only a super administrator can change this account.') : null,
            h('div', { class: 'two' }, field('Full name', name), field('E-mail (for login)', email)),
            h('div', { class: 'two' }, field('Username', user), field('Password', pw)),
            field('Role', roleSel), permBox,
            !isNew ? h('label', { class: 'row' }, active, u.pending ? 'Account active (approve this registration)' : 'Account active (untick to block login)') : null),
            editable ? [h('button', { class: 'btn', onclick: () => {
                    const body = { name: name.value, email: email.value, role: roleSel.value };
                    if (pw.value) body.password = pw.value;
                    if (isNew) { body.username = user.value; }
                    if (!self) {
                        body.active = isNew ? true : active.checked;
                        const r = roleBy[roleSel.value];
                        if (g && r && !r.super) {
                            const want = new Set(g.value()), fromRole = new Set(r.perms);
                            body.grant = [...want].filter(k => !fromRole.has(k));
                            body.revoke = [...fromRole].filter(k => !want.has(k) && !base.has(k));
                        }
                    }
                    act(() => isNew ? POST('/api/users', body) : POST('/api/users/' + u.id, body), isNew ? 'Account created' : (u.pending && active.checked ? 'Account approved' : 'Saved'))
                        .then(() => { m.remove(); VIEWS.staff(['users']); });
                } }, isNew ? 'Create account' : 'Save')] : null);
    };
    const pending = users.filter(u => u.pending);
    const box = h('div');
    const draw = () => box.replaceChildren(table([
        { t: 'Name', f: u => [h('strong', null, u.name), h('div', { class: 'small muted' }, u.email || '')] },
        { t: 'Username', f: u => h('span', { class: 'mono' }, u.username) },
        { t: 'Role', f: u => [(roleBy[u.role] || {}).name || u.role, u.grant.length || u.revoke.length ? h('div', { class: 'small muted' }, (u.grant.length ? '+' + u.grant.length : '') + (u.grant.length && u.revoke.length ? ' / ' : '') + (u.revoke.length ? '−' + u.revoke.length : '') + ' personal') : null] },
        { t: 'Last login', f: u => u.last_login ? dt(u.last_login) : 'never' },
        { t: '', f: u => SBACCESS.badgeFor(u) }], filter === 'pending' ? pending : users, userForm));
    draw();
    render(head, h('div', { class: 'card' },
        h('div', { class: 'row sp', style: { marginBottom: '10px' } },
            h('div', { class: 'row' }, h('button', { class: 'btn sm ' + (filter ? 'ghost' : ''), onclick: () => { filter = ''; draw(); } }, 'Everyone ' + users.length),
                pending.length ? h('button', { class: 'btn sm ' + (filter ? '' : 'ghost warn'), onclick: () => { filter = 'pending'; draw(); } }, 'Waiting for approval ' + pending.length) : null),
            h('button', { class: 'btn', onclick: () => userForm() }, '+ Add staff')),
        h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Each person logs in with their own e-mail or username. Everything they change is recorded in the activity log.'),
        box));
};
registerView({ key: 'staff', title: 'Staff & access', group: 'Admin', perm: 'users', icon: 'key', order: 80 }, VIEWS.staff);
