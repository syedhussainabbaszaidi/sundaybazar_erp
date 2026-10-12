<?php

namespace App\Erp;

use Illuminate\Support\Facades\Schema;

/**
 * Roles and permissions (stored in the database: roles, permissions, role_permissions, user_permissions).
 *
 * Effective permissions of a person:
 *   - role with is_super  -> every permission (present and future)
 *   - otherwise           -> BASE + the role's permissions + personal grants - personal revokes
 * Every API route names the permission it needs (App\Erp\Router); a missing permission means "no access".
 */
class Access
{
    /** Own-work permissions everybody has (cannot be revoked) */
    public const BASE = ['dashboard', 'me', 'tasks', 'expenses'];

    /** key => [label, module, action] — module/action group the permission grid on the Staff & Roles screens */
    public const CATALOGUE = [
        'dashboard' => ['Home & own work (everyone)', 'Dashboard', 'View'],
        'me' => ['My page: attendance, leave, payslips (everyone)', 'Dashboard', 'My page'],
        'tasks' => ['My tasks & daily report (everyone)', 'Dashboard', 'Tasks'],
        'expenses' => ['Submit office expenses (everyone)', 'Expenses', 'Submit'],
        'orders' => ['Orders: view', 'Orders', 'View'],
        'orders_edit' => ['Orders: change stage, notes', 'Orders', 'Edit'],
        'orders_cancel' => ['Orders: cancel an order in Shopify', 'Orders', 'Cancel'],
        'orders_fulfil' => ['Orders: mark fulfilled in Shopify (with or without tracking)', 'Orders', 'Fulfil'],
        'orders_refund' => ['Orders: refund money in Shopify', 'Orders', 'Refund'],
        'cs' => ['Confirmation calls (CS)', 'Orders', 'Confirmation calls'],
        'abandoned' => ['Shopify abandoned checkouts', 'Orders', 'Abandoned carts'],
        'tickets' => ['CS tickets, exchanges & refunds', 'Customer service', 'Tickets & refunds'],
        'customers' => ['Customers: view (phone numbers)', 'Customers', 'View'],
        'customers_edit' => ['Customers: blacklist / VIP', 'Customers', 'Edit'],
        'tracking' => ['Parcel tracking', 'Delivery', 'Tracking'],
        'couriers' => ['Couriers: book TCS/PostEx, rider runs, courier COD', 'Delivery', 'Courier booking'],
        'rider' => ['Rider app: my deliveries & cash (Karachi rider)', 'Delivery', 'Rider app'],
        'inbox' => ['Messages inbox: WhatsApp, Instagram, forms', 'Messages', 'All channels'],
        'inbox_wa' => ['Messages: WhatsApp & Google Form only', 'Messages', 'WhatsApp only'],
        'inbox_ig' => ['Messages: Instagram DMs & comments only', 'Messages', 'Instagram only'],
        'inbox_admin' => ['Messaging setup: Cequens, Instagram, auto-messages', 'Messages', 'Manage settings'],
        'warehouse' => ['Warehouse: pick, pack, returns', 'Inventory', 'Pick, pack, returns'],
        'inventory' => ['Inventory & rack locations', 'Inventory', 'View & locate'],
        'wms' => ['Warehouse control: receiving, stock counts, damage, transfers', 'Inventory', 'Adjust & manage'],
        'listing' => ['Lots, listing & pricing', 'Products', 'Lots, listing & pricing'],
        'pricing_apply' => ['Push new prices to Shopify', 'Products', 'Update prices in Shopify'],
        'finance' => ['Finance: COD, profit', 'Finance', 'COD & profit'],
        'reports_export' => ['Reports: export order/finance CSV', 'Reports', 'Export'],
        'accounts' => ['Accounts: books, ledgers, statements (view)', 'Accounting', 'View'],
        'accounts_post' => ['Accounts: post journal entries, close month', 'Accounting', 'Post & close'],
        'expenses_approve' => ['Approve expenses & manage petty cash', 'Expenses', 'Approve'],
        'marketing' => ['Marketing: Meta ads spend & results', 'Marketing', 'View & manage'],
        'hr' => ['HR: employees, attendance, leave', 'People', 'HR'],
        'payroll' => ['Payroll: salaries, advances, payslips', 'People', 'Payroll'],
        'team' => ['Team report: who did what, performance', 'People', 'Team report'],
        'reports' => ['Reports & analytics', 'Reports', 'View'],
        'sync_view' => ['Shopify sync: view status, logs and review items', 'Shopify sync', 'View status'],
        'sync_run' => ['Shopify sync: run a sync now', 'Shopify sync', 'Run sync'],
        'shopify_manage' => ['Shopify sync: connection, location, webhooks', 'Shopify sync', 'Manage settings'],
        'settings' => ['Settings & sync', 'System settings', 'Update'],
        'users' => ['Staff accounts & access', 'Staff', 'Manage accounts'],
        'roles' => ['Roles & permissions', 'Roles', 'Manage roles'],
        'audit' => ['Activity log (who changed what)', 'Staff', 'View activity log'],
    ];

    /** Roles created on install. The super role (admin) gets everything automatically. */
    public static function defaultRoles(): array
    {
        $all = array_keys(self::CATALOGUE);
        $r = fn (string ...$p) => array_values(array_unique(array_merge(self::BASE, $p)));
        return [
            'admin' => ['Owner / Admin', 'Everything, including settings, staff logins, roles and accounts posting.', [], true],
            'manager' => ['Manager', 'Everything except settings, staff logins, roles, payroll and accounts posting.', array_values(array_diff($all, ['users', 'roles', 'settings', 'shopify_manage', 'accounts_post', 'payroll', 'rider', 'inbox_admin', 'inbox_wa', 'inbox_ig', 'orders_refund'])), false],
            'cs' => ['CS / Confirmation', 'Confirmation calls, Messages (all channels), Tickets, Exchanges, Refunds, Orders, Customers.', $r('orders', 'orders_edit', 'cs', 'tickets', 'customers', 'customers_edit', 'inbox'), false],
            'tracking' => ['Tracking', 'Parcel tracking, Tickets, Messages, Exchanges, Orders, Customers, courier booking.', $r('orders', 'orders_edit', 'tracking', 'tickets', 'customers', 'inbox', 'couriers', 'orders_fulfil'), false],
            'warehouse' => ['Warehouse / Inventory', 'Dispatch desk (pick, pack, book, handover), racks, receiving, stock counts, damage, returns.', $r('orders', 'warehouse', 'inventory', 'wms', 'couriers', 'orders_fulfil'), false],
            'rider' => ['Rider (own delivery)', 'Only My deliveries and cash on the phone.', $r('rider'), false],
            'lister' => ['Lister', 'List pairs, photos, upload, handover, racks and inventory (no cost or profit).', $r('inventory', 'listing'), false],
            'finance' => ['Finance / Accounts', 'COD, Accounts, Vouchers, Statements, Month close, Expense approvals, Refunds, Reports.', $r('orders', 'finance', 'accounts', 'accounts_post', 'expenses_approve', 'reports', 'reports_export', 'couriers'), false],
            'marketing' => ['Marketing', 'Meta ad spend, Campaigns, Marketing spend, Messages, Reports.', $r('marketing', 'reports', 'inbox'), false],
            'hr' => ['HR', "Team today (who worked, who didn't), Performance, Attendance, Leave, Employees, Payroll, Reports.", $r('hr', 'payroll', 'team', 'reports'), false],
            'exchange' => ['Exchanges & WhatsApp', 'Tickets, Exchanges, Refunds, Messages (WhatsApp & Google Form only), Orders, Customers.', $r('orders', 'tickets', 'customers', 'inbox', 'inbox_wa'), false],
            'social' => ['Instagram & abandoned carts', 'Abandoned carts, Messages (Instagram DMs & comments only), Tickets, Orders, Customers.', $r('orders', 'customers', 'inbox', 'inbox_ig', 'abandoned', 'tickets'), false],
            'staff' => ['General staff', 'Only My day: own tasks, attendance and expenses.', $r(), false],
        ];
    }

    /* ------------------------------------------------------------------ seeding */

    /**
     * Create/refresh the permission catalogue and the default roles (idempotent: roles that already
     * exist keep the permissions the owner gave them).
     */
    public static function seed(): void
    {
        $i = 0;
        foreach (self::catalogue() as $key => [$label, $module, $action]) {
            Db::run('INSERT INTO permissions(`key`,module,action,label,sort) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE module=VALUES(module), action=VALUES(action), label=VALUES(label), sort=VALUES(sort)',
                $key, $module, $action, $label, $i++);
        }
        foreach (self::defaultRoles() as $key => [$name, $desc, $perms, $super]) {
            $new = Db::run('INSERT IGNORE INTO roles(`key`,name,description,is_system,is_super,created_at) VALUES(?,?,?,1,?,UTC_TIMESTAMP())', $key, $name, $desc, $super ? 1 : 0)->changes;
            if ($new) {
                foreach ($perms as $p) {
                    Db::run('INSERT IGNORE INTO role_permissions(role_key,permission_key) VALUES(?,?)', $key, $p);
                }
            }
        }
        // permissions added in later versions: give them once to existing roles that already do the related work
        $done = Settings::get('perm_upgrades', []) ?: [];
        foreach (self::UPGRADES as $perm => $fromAny) {
            if (in_array($perm, $done, true)) {
                continue;
            }
            if ($fromAny) {
                Db::run('INSERT IGNORE INTO role_permissions(role_key,permission_key) SELECT DISTINCT role_key, ? FROM role_permissions WHERE permission_key IN ('.Db::marks($fromAny).')', $perm, ...$fromAny);
            }
            $done[] = $perm;
        }
        Settings::set('perm_upgrades', $done);
        self::flush();
    }

    /** new permission => given to existing roles holding any of these ([] = only super administrators) */
    private const UPGRADES = ['orders_fulfil' => ['couriers'], 'orders_refund' => []];

    /** Catalogue including permissions added by modules (perms()). */
    public static function catalogue(): array
    {
        $c = self::CATALOGUE;
        foreach (Erp::modules() as $m) {
            foreach ($m->perms() as $p) {
                $c[$p[0]] ??= [$p[1], $p[2] ?? 'Other', $p[3] ?? $p[1]];
            }
        }
        return $c;
    }

    /* ------------------------------------------------------------------ queries */

    private static ?\WeakMap $cache = null;

    private static function memo(string $k, callable $fn)
    {
        self::$cache ??= new \WeakMap;
        $app = app();
        $box = self::$cache[$app] ?? [];
        if (! array_key_exists($k, $box)) {
            $box[$k] = $fn();
            self::$cache[$app] = $box;
        }
        return $box[$k];
    }

    /** Forget cached roles (after a role is changed). */
    public static function flush(): void
    {
        if (self::$cache) {
            unset(self::$cache[app()]);
        }
    }

    private static function ready(): bool
    {
        return self::memo('ready', fn () => Schema::hasTable('roles') && Schema::hasTable('permissions'));
    }

    /** [[key, label, module, action], ...] in catalogue order (the old [key, label] pairs, extended) */
    public static function perms(): array
    {
        return self::memo('perms', function () {
            $rows = self::ready() ? Db::all('SELECT `key`,label,module,action FROM permissions ORDER BY sort, `key`') : [];
            if (! $rows) {
                return array_map(fn ($k, $v) => [$k, $v[0], $v[1], $v[2]], array_keys(self::catalogue()), self::catalogue());
            }
            return array_map(fn ($r) => [$r['key'], $r['label'], $r['module'], $r['action']], $rows);
        });
    }

    public static function all(): array
    {
        return array_column(self::perms(), 0);
    }

    /** key => ['label','desc','perms','super','system','users'] */
    public static function roles(): array
    {
        return self::memo('roles', function () {
            if (! self::ready() || ! Db::get('SELECT id FROM roles LIMIT 1')) {
                $out = [];
                foreach (self::defaultRoles() as $k => [$name, $desc, $perms, $super]) {
                    $out[$k] = ['label' => $name, 'desc' => $desc, 'perms' => $super ? self::all() : $perms, 'super' => $super, 'system' => true, 'users' => 0];
                }
                return $out;
            }
            $links = [];
            foreach (Db::all('SELECT role_key, permission_key FROM role_permissions') as $r) {
                $links[$r['role_key']][] = $r['permission_key'];
            }
            $users = [];
            foreach (Db::all('SELECT role, COUNT(*) n FROM users GROUP BY role') as $r) {
                $users[$r['role']] = $r['n'];
            }
            $out = [];
            foreach (Db::all('SELECT * FROM roles ORDER BY is_super DESC, is_system DESC, name') as $r) {
                $out[$r['key']] = ['label' => $r['name'], 'desc' => (string) $r['description'], 'perms' => $r['is_super'] ? self::all() : array_values(array_unique(array_merge(self::BASE, $links[$r['key']] ?? []))),
                    'super' => (bool) $r['is_super'], 'system' => (bool) $r['is_system'], 'users' => $users[$r['key']] ?? 0];
            }
            return $out;
        });
    }

    public static function isSuperRole(?string $role): bool
    {
        return (bool) (self::roles()[$role ?? '']['super'] ?? false);
    }

    /** ['grant' => [...], 'revoke' => [...]] for one user */
    public static function overrides(int $userId): array
    {
        $o = ['grant' => [], 'revoke' => []];
        if ($userId && self::ready()) {
            foreach (Db::all('SELECT permission_key, effect FROM user_permissions WHERE user_id=?', $userId) as $r) {
                $o[$r['effect']][] = $r['permission_key'];
            }
        }
        return $o;
    }

    /** Effective permissions of a user row (needs id and role). */
    public static function userPerms(array $u): array
    {
        $all = self::all();
        $role = self::roles()[$u['role'] ?? ''] ?? null;
        if (! $role) {
            return self::BASE; // unknown role: only own work
        }
        if ($role['super']) {
            return $all;
        }
        $o = self::overrides((int) ($u['id'] ?? 0));
        $p = array_merge($role['perms'], $o['grant']);
        $p = array_diff($p, array_diff($o['revoke'], self::BASE));
        return array_values(array_filter(array_unique(array_merge(self::BASE, $p)), fn ($x) => in_array($x, $all, true)));
    }

    /** Number of active super administrators (optionally not counting one user). */
    public static function activeSupers(?int $exceptUserId = null): int
    {
        $supers = array_keys(array_filter(self::roles(), fn ($r) => $r['super']));
        if (! $supers) {
            return 0;
        }
        return (int) Db::val('SELECT COUNT(*) FROM users WHERE active=1 AND role IN ('.Db::marks($supers).') AND id<>?', ...array_merge($supers, [(int) $exceptUserId]));
    }
}
