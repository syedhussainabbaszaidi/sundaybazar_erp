<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Schema;

/**
 * Accounts: chart of accounts, double-entry journal, vouchers, automatic postings from orders, statements and month close.
 * Port of legacy/server/modules/accounts.js.
 *
 * Services for other modules (ctx.services.accounts) are the public methods
 * post, void / voidEntry, balance, summary, accountId, ledger, trial, pnl, bs, partyName, lockDate.
 */
class AccountsModule extends Module
{
    public string $name = 'accounts';

    // [code, name, type, group] — names are the contract other modules post to (do not rename)
    private const SEED = [
        ['1001', 'Cash', 'asset', 'cash'], ['1002', 'Petty Cash', 'asset', 'cash'], ['1010', 'Meezan (SB)', 'asset', 'cash'], ['1020', 'PayFast', 'asset', 'cash'],
        ['1100', 'Post Ex', 'asset', 'receivable'], ['1101', 'Blue ex', 'asset', 'receivable'], ['1102', 'Leopards', 'asset', 'receivable'],
        ['1103', 'TCS', 'asset', 'receivable'], ['1104', 'Rider Cash', 'asset', 'receivable'],
        ['1200', 'Listed Inventory', 'asset', 'inventory'], ['1201', 'Unlisted Inventory', 'asset', 'inventory'], ['1210', 'Purchases', 'asset', 'inventory'],
        ['1300', 'Employees Advance', 'asset', 'current'], ['1310', 'Claims (P)', 'asset', 'current'], ['1320', 'Prepaid Rent', 'asset', 'current'], ['1330', 'Advance Income Tax', 'asset', 'current'],
        ['1500', 'Office Deposit', 'asset', 'non-current'], ['1501', 'Outlet Deposit', 'asset', 'non-current'], ['1510', 'Office Furniture', 'asset', 'non-current'], ['1511', 'Outlet Furniture', 'asset', 'non-current'],
        ['1520', 'Office Equipments', 'asset', 'non-current'], ['1521', 'Outlet Equipments', 'asset', 'non-current'],
        ['2000', 'Accounts Payable', 'liability', 'current'], ['2010', 'Salaries Payable', 'liability', 'current'], ['2020', 'Store Credit', 'liability', 'current'], ['2030', 'Customer Advances', 'liability', 'current'],
        ['2040', 'Meta Ads Payable', 'liability', 'current'], ['2050', 'Accrued Expenses', 'liability', 'current'],
        ['3000', 'Capital', 'equity', 'capital'], ['3010', 'Drawings 1', 'equity', 'drawings'], ['3011', 'Drawings 2', 'equity', 'drawings'],
        ['4000', 'Sales', 'income', 'sales'], ['4100', 'Sales Return', 'contra_income', 'sales'], ['4110', 'Discount Allowed', 'contra_income', 'sales'],
        ['4500', 'Discount Received', 'income', 'other'], ['4510', 'Other Income', 'income', 'other'],
        ['5000', 'Cost of Goods Sold', 'expense', 'cogs'], ['5010', 'Inventory Damage', 'expense', 'cogs'],
        ['6000', 'Shipping Exp', 'expense', 'selling'], ['6010', 'Packaging', 'expense', 'selling'], ['6020', 'Social Media Marketing', 'expense', 'selling'], ['6030', 'Other Marketing', 'expense', 'selling'],
        ['6040', 'Shopify Charges', 'expense', 'selling'], ['6050', 'Commission', 'expense', 'selling'], ['6060', 'Incentives/Gifts', 'expense', 'selling'], ['6070', 'QC Expenses', 'expense', 'selling'],
        ['6080', 'GST', 'expense', 'selling'], ['6090', 'Sales Tax', 'expense', 'selling'],
        ['7000', 'Salary Exp', 'expense', 'admin'], ['7010', 'Office Rent', 'expense', 'admin'], ['7020', 'Outlet Rent', 'expense', 'admin'], ['7030', 'Outlet Expenses', 'expense', 'admin'],
        ['7040', 'Utility Expenses', 'expense', 'admin'], ['7050', 'Internet & Mobile Package', 'expense', 'admin'], ['7060', 'Food Allowance', 'expense', 'admin'], ['7070', 'Grocery & Pantry', 'expense', 'admin'],
        ['7080', 'Conveyance', 'expense', 'admin'], ['7090', 'Repair & Maintenance', 'expense', 'admin'], ['7100', 'I.T Expenses', 'expense', 'admin'], ['7110', 'Apps & Subscription Charges', 'expense', 'admin'],
        ['7120', 'Bad Debts', 'expense', 'admin'], ['7130', 'Bank Charges', 'expense', 'admin'], ['7140', 'Donation', 'expense', 'admin'], ['7150', 'Entertainment', 'expense', 'admin'],
        ['7160', 'Legal Fees', 'expense', 'admin'], ['7170', 'Miscellenious Exp', 'expense', 'admin'], ['7180', 'Depreciation', 'expense', 'admin'],
        ['8000', 'Income Tax', 'expense', 'tax'],
    ];

    private const TYPES = ['asset' => 'BS', 'liability' => 'BS', 'equity' => 'BS', 'income' => 'IS', 'contra_income' => 'IS', 'expense' => 'IS'];

    private const GROUPS = [
        'asset' => [['cash', 'Cash & bank'], ['receivable', 'Courier receivables'], ['inventory', 'Inventory'], ['current', 'Other current assets'], ['non-current', 'Fixed assets & deposits']],
        'liability' => [['current', 'Current liabilities'], ['non-current', 'Long-term liabilities']],
        'equity' => [['capital', 'Capital'], ['drawings', 'Drawings']],
        'income' => [['sales', 'Sales'], ['other', 'Other income']], 'contra_income' => [['sales', 'Less: returns & discounts']],
        'expense' => [['cogs', 'Cost of sales'], ['selling', 'Selling & delivery'], ['admin', 'Admin & general'], ['tax', 'Tax']],
    ];

    private const KINDS = ['JV' => 'Journal voucher', 'PV' => 'Payment voucher', 'RV' => 'Receipt voucher', 'CV' => 'Contra voucher'];

    private const DEF_CFG = ['recognise' => 'dispatched', 'bank' => 'Meezan (SB)', 'courier_ar' => 'Post Ex', 'tcs_ar' => 'TCS', 'rider_ar' => 'Rider Cash', 'sales' => 'Sales', 'discount' => 'Discount Allowed', 'returns' => 'Sales Return', 'cogs' => 'Cost of Goods Sold',
        'inventory' => 'Listed Inventory', 'unlisted' => 'Unlisted Inventory', 'shipping' => 'Shipping Exp', 'courier_tax' => 'GST', 'purchases' => 'Purchases', 'payable' => 'Accounts Payable', 'auto' => true, 'fy_month' => 7];

    private const AUTO_SRC = "(j.source LIKE 'auto-%' OR j.source='lot')";

    // every listed pair with its cost and listing day (PK): ERP lister rows, plus Shopify products that did not come from the lister
    private const LISTED_SQL = "SELECT sku, lot, cost, DATE(at + INTERVAL 5 HOUR) d FROM listings WHERE cost>0 AND at IS NOT NULL
  UNION ALL SELECT p.sku, p.lot, p.cost, DATE(p.created_at + INTERVAL 5 HOUR) d FROM products p WHERE p.cost>0 AND p.created_at IS NOT NULL AND (p.sku IS NULL OR p.sku NOT IN (SELECT sku FROM listings WHERE sku IS NOT NULL))";

    // cost of one sold pair: products.cost from Shopify, else the cost saved when it was listed
    private const PAIR_COST = 'COALESCE(NULLIF(p.cost,0), NULLIF(ls.cost,0))';
    private const PAIR_JOIN = 'LEFT JOIN products p ON p.variant_id=i.variant_id LEFT JOIN listings ls ON ls.sku=i.sku';

    // which courier holds the order's COD: PostEx (and any other / unknown courier), TCS, or the own Karachi rider
    private const CK = "CASE WHEN lower(COALESCE(o.courier,'')) LIKE 'tcs%' THEN 'TCS' WHEN lower(COALESCE(o.courier,''))='rider' THEN 'Rider' ELSE 'PostEx' END";
    private const CK_NAME = ['PostEx' => 'PostEx', 'TCS' => 'TCS', 'Rider' => 'the rider'];

    private const CACHE_PENDING = 'erp.accounts.pending';
    private const CACHE_FAILS = 'erp.accounts.fails';

    private array $schemaCache = [];

    /* ================================================================ helpers */

    /** JS unary plus with `|| 0` */
    private static function n($v): float|int
    {
        if (is_int($v) || is_float($v)) {
            return is_nan((float) $v) ? 0 : $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_string($v) && is_numeric(trim($v))) {
            return 0 + trim($v);
        }
        return 0;
    }

    /** Math.round(v*100)/100 (int when whole, like a JS number) */
    private static function r2($v): int|float
    {
        return Logic::jsRound(self::n($v) * 100) / 100;
    }

    private static function isDate($s): bool
    {
        return is_string($s) && (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $s);
    }

    private static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', strtotime($d.' 00:00:00 UTC') + $n * 86400);
    }

    private static function monthEnd(string $m): string
    {
        return self::addDays(substr(self::addDays($m.'-01', 32), 0, 7).'-01', -1);
    }

    /** Math.round(v).toLocaleString('en-PK') */
    private static function num($v): string
    {
        return number_format(Logic::jsRound(self::n($v)));
    }

    private static function fmt($v): string
    {
        return 'Rs '.self::num($v);
    }

    private static function bad(string $msg, int $code = 400): HttpError
    {
        return new HttpError($code, $msg);
    }

    private static function pkd(string $col): string
    {
        return "DATE($col + INTERVAL 5 HOUR)";
    }

    private function cfg(): array
    {
        $s = $this->setting('accounts_cfg', []);
        return array_merge(self::DEF_CFG, is_array($s) ? $s : []);
    }

    private function startDate(): string
    {
        return (string) ($this->setting('accounts_start', '') ?: '');
    }

    private static function ckAcct(array $c, string $k): string
    {
        return $k === 'TCS' ? $c['tcs_ar'] : ($k === 'Rider' ? $c['rider_ar'] : $c['courier_ar']);
    }

    private static function ckSid(string $d, string $k): string
    {
        return $k === 'PostEx' ? $d : $d.':'.$k; // PostEx keeps the old per-day source_id
    }

    private function hasTable(string $t): bool
    {
        return $this->schemaCache['t:'.$t] ??= (function () use ($t) {
            try {
                return Schema::hasTable($t);
            } catch (\Throwable) {
                return false;
            }
        })();
    }

    private function hasCol(string $t, string $c): bool
    {
        return $this->schemaCache['c:'.$t.'.'.$c] ??= (function () use ($t, $c) {
            try {
                return Schema::hasColumn($t, $c);
            } catch (\Throwable) {
                return false;
            }
        })();
    }

    // Lots bought on a Purchasing purchase order are posted by the purchasing module instead ('pur-lot'), so the automatic 'lot' entry skips them.
    private function notPO(string $col): string
    {
        return $this->hasTable('pur_pos') ? " AND $col NOT IN (SELECT lot_name FROM pur_pos WHERE lot_name IS NOT NULL AND status NOT IN ('cancelled'))" : '';
    }

    private function resetPending(): void
    {
        Cache::forget(self::CACHE_PENDING);
    }

    /* ================================================================ chart */

    private function acct($n): ?array
    {
        if (is_array($n)) {
            $n = $n['name'] ?? null;
        }
        $s = trim((string) ($n ?? ''));
        if ($s === '') {
            return null;
        }
        return Db::get('SELECT * FROM acc_accounts WHERE name=? OR code=? ORDER BY name=? DESC, id', $s, $s, $s)
            ?: Db::get('SELECT * FROM acc_accounts WHERE lower(name)=lower(?)', $s);
    }

    private function mustAcct($n): array
    {
        $a = $this->acct($n);
        if (! $a) {
            $label = is_array($n) ? '[object Object]' : ($n === null ? 'undefined' : (is_bool($n) ? ($n ? 'true' : 'false') : (string) $n));
            throw self::bad('Unknown account "'.$label.'"');
        }
        return $a;
    }

    private static function natural(array $a, $dr, $cr): int|float
    {
        return in_array($a['type'], ['asset', 'expense', 'contra_income'], true) ? $dr - $cr : $cr - $dr;
    }

    /* ================================================================ journal engine */

    private function checkLock(string $date): void
    {
        $L = $this->lockDate();
        if ($L !== '' && $date <= $L) {
            throw self::bad("The books are closed up to $L. Reopen that month first, or use a later date.");
        }
    }

    private function nextRef(string $kind): string
    {
        $n = Db::val('SELECT MAX(CAST(SUBSTR(ref,4) AS SIGNED)) n FROM acc_journals WHERE ref LIKE ?', $kind.'-%');
        return $kind.'-'.str_pad((string) (((int) $n) + 1), 4, '0', STR_PAD_LEFT);
    }

    private function cleanLines($lines): array
    {
        $out = [];
        foreach (is_array($lines) ? $lines : [] as $l) {
            $l = is_array($l) ? $l : [];
            $debit = self::r2($l['debit'] ?? 0);
            $credit = self::r2($l['credit'] ?? 0);
            if (! $debit && ! $credit) {
                continue;
            }
            if ($debit < 0 || $credit < 0) {
                throw self::bad('Amounts cannot be negative — swap debit and credit instead');
            }
            if ($debit && $credit) {
                throw self::bad('A line can have a debit or a credit, not both');
            }
            $a = $this->mustAcct($l['account'] ?? null);
            if (! $a['active']) {
                throw self::bad('Account "'.$a['name'].'" is deactivated');
            }
            $party = $l['party'] ?? null;
            $memo = $l['memo'] ?? null;
            $out[] = [
                'a' => $a, 'debit' => $debit, 'credit' => $credit,
                'party' => ($party !== null && $party !== '' && $party !== false && $party !== 0) ? ((($ps = mb_substr(trim((string) $party), 0, 80)) === '') ? null : $ps) : null,
                'memo' => ($memo !== null && $memo !== '' && $memo !== false && $memo !== 0) ? mb_substr((string) $memo, 0, 200) : null,
            ];
        }
        if (! $out) {
            throw self::bad('Enter at least one amount');
        }
        $dr = self::r2(array_sum(array_column($out, 'debit')));
        $cr = self::r2(array_sum(array_column($out, 'credit')));
        if (abs($dr - $cr) > 0.009) {
            throw self::bad('Debits ('.self::fmt($dr).') and credits ('.self::fmt($cr).') do not match — difference '.self::fmt(abs($dr - $cr)));
        }
        return ['lines' => $out, 'total' => $dr];
    }

    private function postRaw(array $j, $userId): int
    {
        if (! self::isDate($j['date'] ?? null)) {
            throw self::bad('Date must be YYYY-MM-DD');
        }
        $source = (string) (($j['source'] ?? null) ?: 'manual');
        $sid = (string) ($j['source_id'] ?? '');
        if ($sid === '') {
            throw self::bad('source_id is needed');
        }
        ['lines' => $lines, 'total' => $total] = $this->cleanLines($j['lines'] ?? []);
        $this->checkLock($j['date']);
        $ex = Db::get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', $source, $sid);
        $meta = ! empty($j['meta']) ? json_encode($j['meta'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;
        $memo = ($j['memo'] ?? null) ?: '';
        if ($ex) {
            $this->checkLock($ex['date']);
            Db::run('DELETE FROM acc_lines WHERE journal_id=?', $ex['id']);
            $fileId = array_key_exists('file_id', $j) ? (($j['file_id'] ?? null) ?: null) : $ex['file_id'];
            Db::run('UPDATE acc_journals SET date=?, memo=?, ref=?, kind=?, file_id=?, user_id=?, amount=?, meta=?, voided=0, void_reason=NULL, voided_by=NULL, voided_at=NULL, updated_at=UTC_TIMESTAMP() WHERE id=?',
                $j['date'], $memo, ($j['ref'] ?? null) ?: $ex['ref'], ($j['kind'] ?? null) ?: $ex['kind'], $fileId, $userId ?: $ex['user_id'], $total, $meta, $ex['id']);
            $id = (int) $ex['id'];
        } else {
            $kind = $j['kind'] ?? null;
            $ref = ($j['ref'] ?? null) ?: ((is_string($kind) && isset(self::KINDS[$kind])) ? $this->nextRef($kind) : null);
            $id = Db::run('INSERT INTO acc_journals(date,memo,source,source_id,ref,kind,file_id,user_id,amount,meta) VALUES(?,?,?,?,?,?,?,?,?,?)',
                $j['date'], $memo, $source, $sid, $ref, $kind ?: null, ($j['file_id'] ?? null) ?: null, $userId ?: null, $total, $meta)->lastInsertRowid;
        }
        foreach ($lines as $l) {
            Db::run('INSERT INTO acc_lines(journal_id,account_id,debit,credit,party,memo) VALUES(?,?,?,?,?,?)', $id, $l['a']['id'], $l['debit'], $l['credit'], $l['party'], $l['memo']);
        }
        return (int) $id;
    }

    private function removeJ(int $id): void
    {
        Db::run('DELETE FROM acc_lines WHERE journal_id=?', $id);
        Db::run('DELETE FROM acc_journals WHERE id=?', $id);
    }

    /** every account with debit/credit sums for a date range (+ dr, cr, bal, amt) */
    private function sums(?string $from, ?string $to): array
    {
        $w = ['j.voided=0'];
        $a = [];
        if ($from) {
            $w[] = 'j.date>=?';
            $a[] = $from;
        }
        if ($to) {
            $w[] = 'j.date<=?';
            $a[] = $to;
        }
        $rows = Db::all('SELECT a.*, COALESCE(s.dr,0) dr, COALESCE(s.cr,0) cr FROM acc_accounts a LEFT JOIN (SELECT l.account_id, SUM(l.debit) dr, SUM(l.credit) cr FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id
    WHERE '.implode(' AND ', $w).' GROUP BY l.account_id) s ON s.account_id=a.id ORDER BY a.code', ...$a);
        foreach ($rows as &$x) {
            $dr = self::r2($x['dr']);
            $cr = self::r2($x['cr']);
            $bal = self::r2($x['dr'] - $x['cr']);
            $amt = self::r2(self::natural($x, $x['dr'], $x['cr']));
            $x['dr'] = $dr;
            $x['cr'] = $cr;
            $x['bal'] = $bal;
            $x['amt'] = $amt;
        }
        unset($x);
        return $rows;
    }

    /* ================================================================ statements */

    private function sec(string $title, array $list, int $sign = 1): array
    {
        $rows = [];
        $total = 0;
        foreach ($list as $a) {
            $total += $sign * $a['amt'];
            if ($a['amt'] || $a['dr'] || $a['cr']) {
                $rows[] = ['id' => $a['id'], 'code' => $a['code'], 'name' => $a['name'], 'amount' => self::r2($sign * $a['amt'])];
            }
        }
        return ['title' => $title, 'rows' => $rows, 'total' => self::r2($total)];
    }

    private function prevRange(string $from, string $to): array
    {
        if (substr($from, 8) === '01' && $to === self::monthEnd(substr($from, 0, 7))) {
            $pm = substr(self::addDays($from, -1), 0, 7);
            return [$pm.'-01', self::monthEnd($pm)];
        }
        $n = Logic::jsRound((strtotime($to.' UTC') - strtotime($from.' UTC')) / 86400) + 1;
        return [self::addDays($from, -$n), self::addDays($from, -1)];
    }

    private function fyStart(string $date): string
    {
        $m = (int) (self::n($this->cfg()['fy_month'] ?? null) ?: 7);
        $y = (int) substr($date, 0, 4);
        $mm = (int) substr($date, 5, 2);
        return ($mm >= $m ? $y : $y - 1).'-'.str_pad((string) $m, 2, '0', STR_PAD_LEFT).'-01';
    }

    private function parties(?string $prefix, $accountName, ?string $upTo): array
    {
        $w = ['j.voided=0', 'l.party IS NOT NULL'];
        $a = [];
        if ($prefix) {
            $w[] = 'l.party LIKE ?';
            $a[] = $prefix.'%';
        }
        if ($accountName) {
            $w[] = 'l.account_id=?';
            $a[] = $this->mustAcct($accountName)['id'];
        }
        if ($upTo) {
            $w[] = 'j.date<=?';
            $a[] = $upTo;
        }
        $rows = Db::all('SELECT l.party, ac.name account, ac.type, SUM(l.debit) dr, SUM(l.credit) cr, MAX(j.date) last FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id JOIN acc_accounts ac ON ac.id=l.account_id
    WHERE '.implode(' AND ', $w).' GROUP BY l.party, ac.id ORDER BY l.party', ...$a);
        foreach ($rows as &$r) {
            $r['name'] = $this->partyName($r['party']);
            $r['balance'] = self::r2($r['dr'] - $r['cr']);
            $r['amount'] = self::r2(self::natural($r, $r['dr'], $r['cr']));
        }
        unset($r);
        return $rows;
    }

    /* ================================================================ automatic postings */

    /** automatic entries never carry a negative amount: a negative debit is a credit */
    private static function flip(array $lines): array
    {
        $out = [];
        foreach ($lines as $l) {
            $d = self::r2($l['debit'] ?? 0);
            $cr = self::r2($l['credit'] ?? 0);
            $v = self::r2($d - $cr);
            $l['debit'] = $v > 0 ? $v : 0;
            $l['credit'] = $v < 0 ? -$v : 0;
            if ($l['debit'] || $l['credit']) {
                $out[] = $l;
            }
        }
        return $out;
    }

    private function autoEntries(string $from, string $to): array
    {
        $c = $this->cfg();
        $fee = self::n($this->setting('courier_fee', 250));
        $rfee = self::n($this->setting('return_fee', 150));
        $cpct = self::n($this->setting('cost_pct', 35));
        $deliv = ($c['recognise'] ?? null) === 'delivered';
        $rec = $deliv ? 'o.delivered_at' : 'o.dispatched_at';
        $recWord = $deliv ? 'delivered' : 'dispatched';
        $live = "o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','courier_cancelled','cs_cancelled')";
        $RET = "o.status IN ('returning','returned','return_received')";
        $retAt = 'COALESCE(o.returned_at,o.return_received_at)';
        $CK = self::CK;
        $out = [];
        $byDay = [];
        $add = function ($source, $date, $memo, $lines, $meta, $sid = null) use (&$out) {
            $lines = self::flip($lines);
            if ($lines) {
                $out[] = ['source' => $source, 'source_id' => ($sid !== null && $sid !== '') ? $sid : $date, 'date' => $date, 'memo' => $memo, 'lines' => $lines, 'meta' => $meta];
            }
        };
        $D = fn (string $sql, ...$a) => Db::all($sql, ...array_merge($a, [$from, $to]));
        $AR = $c['courier_ar'];
        $px = 'courier:PostEx';
        $tfee = self::n($this->setting('couriers_tcs_fee', 250));
        $cfee = $this->hasCol('orders', 'courier_fee') ? 'o.courier_fee' : 'NULL';
        $cpaid = $this->hasCol('orders', 'courier_paid') ? 'o.courier_paid' : 'NULL';
        $party = fn ($k) => 'courier:'.$k;
        $PKrec = self::pkd($rec);

        foreach ($D("SELECT $PKrec d, $CK k, COUNT(*) n, SUM(o.total) total, SUM(COALESCE(o.discount,0)) disc FROM orders o WHERE $rec IS NOT NULL AND $live AND $PKrec BETWEEN ? AND ? GROUP BY d, k ORDER BY d, k") as $r) {
            $add('auto-sales', $r['d'], "Sales — {$r['n']} orders $recWord".($r['k'] !== 'PostEx' ? " ({$r['k']})" : ''),
                [['account' => self::ckAcct($c, $r['k']), 'debit' => $r['total'], 'party' => $party($r['k'])], ['account' => $c['discount'], 'debit' => $r['disc']], ['account' => $c['sales'], 'credit' => self::r2($r['total'] + $r['disc'])]],
                ['orders' => $r['n'], 'gross' => self::r2($r['total'] + $r['disc']), 'discount' => self::r2($r['disc']), 'courier' => $r['k']], self::ckSid($r['d'], $r['k']));
        }
        // cost of a sold pair: Shopify cost, else the cost the lister saved, else an estimate
        $costSql = function (string $dateCol, string $where, bool $byK = false) use ($CK, $cpct) {
            $pk = self::pkd($dateCol);
            $k = $byK ? $CK : "'PostEx'";
            $pc = self::PAIR_COST;
            return "SELECT $pk d, $k k, SUM(i.qty) pairs, SUM(COALESCE($pc, i.price*$cpct/100.0)*i.qty) cost, SUM(CASE WHEN $pc IS NULL THEN i.qty ELSE 0 END) est
    FROM order_items i JOIN orders o ON o.id=i.order_id ".self::PAIR_JOIN." WHERE $where AND $pk BETWEEN ? AND ? GROUP BY d, k ORDER BY d, k";
        };
        foreach ($D($costSql($rec, "$rec IS NOT NULL AND $live")) as $r) {
            $add('auto-cogs', $r['d'], "Cost of {$r['pairs']} pairs $recWord".($r['est'] ? " ({$r['est']} estimated at {$cpct}% of price)" : ''),
                [['account' => $c['cogs'], 'debit' => $r['cost']], ['account' => $c['inventory'], 'credit' => $r['cost']]], ['pairs' => $r['pairs'], 'estimated' => $r['est']]);
        }
        $retW = "$retAt IS NOT NULL AND $RET AND $rec IS NOT NULL AND o.cancelled_at IS NULL";
        $restock = [];
        foreach ($D($costSql($retAt, $retW, true)) as $r) {
            $restock[$r['d'].'|'.$r['k']] = $r;
        }
        $PKret = self::pkd($retAt);
        foreach ($D("SELECT $PKret d, $CK k, COUNT(*) n, SUM(o.total) total, SUM(COALESCE(o.discount,0)) disc FROM orders o WHERE $retW AND $PKret BETWEEN ? AND ? GROUP BY d, k ORDER BY d, k") as $r) {
            $rs = $restock[$r['d'].'|'.$r['k']] ?? ['cost' => 0, 'pairs' => 0];
            $add('auto-returns', $r['d'], "Returns — {$r['n']} parcels back from ".self::CK_NAME[$r['k']].', '.(($rs['pairs'] ?? 0) ?: 0).' pairs restocked at cost',
                [['account' => $c['returns'], 'debit' => self::r2($r['total'] + $r['disc'])], ['account' => $c['discount'], 'credit' => $r['disc']], ['account' => self::ckAcct($c, $r['k']), 'credit' => $r['total'], 'party' => $party($r['k'])],
                    ['account' => $c['inventory'], 'debit' => $rs['cost']], ['account' => $c['cogs'], 'credit' => $rs['cost']]],
                ['parcels' => $r['n'], 'pairs' => ($rs['pairs'] ?? 0) ?: 0, 'courier' => $r['k']], self::ckSid($r['d'], $r['k']));
        }
        $shipW = "o.dispatched_at IS NOT NULL AND o.tracking IS NOT NULL AND o.cancelled_at IS NULL AND o.status<>'courier_cancelled'";
        $PKdis = self::pkd('o.dispatched_at');
        foreach ($D("SELECT $PKdis d, COUNT(*) n, SUM(COALESCE(o.px_fee,?)) fee, SUM(COALESCE(o.px_tax,0)) tax, SUM(o.px_fee IS NULL) est FROM orders o WHERE $shipW AND $CK='PostEx' AND $PKdis BETWEEN ? AND ? GROUP BY d ORDER BY d", $fee) as $r) {
            $byDay[$r['d']] ??= ['fwd' => null, 'rev' => null];
            $byDay[$r['d']]['fwd'] = $r;
        }
        foreach ($D("SELECT $PKret d, COUNT(*) n, SUM(COALESCE(o.px_rev_fee,?)) fee, SUM(COALESCE(o.px_rev_tax,0)) tax, SUM(o.px_rev_fee IS NULL) est FROM orders o WHERE $shipW AND $CK='PostEx' AND $retAt IS NOT NULL AND $RET AND $PKret BETWEEN ? AND ? GROUP BY d ORDER BY d", $rfee) as $r) {
            $byDay[$r['d']] ??= ['fwd' => null, 'rev' => null];
            $byDay[$r['d']]['rev'] = $r;
        }
        foreach ($byDay as $d => $x) {
            $d = (string) $d;
            $f = $x['fwd'] ?: ['n' => 0, 'fee' => 0, 'tax' => 0, 'est' => 0];
            $rv = $x['rev'] ?: ['n' => 0, 'fee' => 0, 'tax' => 0, 'est' => 0];
            $est = $f['est'] + $rv['est'];
            $add('auto-courier', $d, "PostEx charges — {$f['n']} dispatched, {$rv['n']} returned".($est ? " ($est estimated: Rs $fee delivery / Rs $rfee return)" : ''),
                [['account' => $c['shipping'], 'debit' => self::r2($f['fee'] + $rv['fee'])], ['account' => $c['courier_tax'], 'debit' => self::r2($f['tax'] + $rv['tax'])], ['account' => $AR, 'credit' => self::r2($f['fee'] + $rv['fee'] + $f['tax'] + $rv['tax']), 'party' => $px]],
                ['dispatched' => $f['n'], 'returned' => $rv['n'], 'estimated' => $est]);
        }
        // TCS delivery charges, accrued the day the parcel is booked: Dr Shipping Exp / Cr TCS
        foreach ($D("SELECT $PKdis d, COUNT(*) n, SUM(COALESCE($cfee,?)) fee, SUM($cfee IS NULL) est FROM orders o WHERE $shipW AND $CK='TCS' AND $PKdis BETWEEN ? AND ? GROUP BY d ORDER BY d", $tfee) as $r) {
            $add('auto-courier', $r['d'], "TCS charges — {$r['n']} parcels booked".($r['est'] ? " ({$r['est']} estimated at Rs $tfee)" : ''),
                [['account' => $c['shipping'], 'debit' => $r['fee']], ['account' => $c['tcs_ar'], 'credit' => $r['fee'], 'party' => $party('TCS')]], ['dispatched' => $r['n'], 'estimated' => $r['est'], 'courier' => 'TCS'], self::ckSid($r['d'], 'TCS'));
        }
        // COD payments: PostEx and TCS pay into the bank (the own rider's cash is posted by the couriers module)
        $setAt = 'COALESCE(o.settled_at,o.delivered_at)';
        $PKset = self::pkd($setAt);
        foreach ($D("SELECT $PKset d, COUNT(*) n, SUM(COALESCE(o.cod,o.total)-COALESCE(o.px_fee,?)-COALESCE(o.px_tax,0)) net, SUM(o.settled_at IS NULL) nodate FROM orders o WHERE o.settled=1 AND $CK='PostEx' AND $setAt IS NOT NULL AND $PKset BETWEEN ? AND ? GROUP BY d ORDER BY d", $fee) as $r) {
            $add('auto-settle', $r['d'], "PostEx COD payment — {$r['n']} parcels".($r['nodate'] ? " ({$r['nodate']} without a payment date, delivery date used)" : ''),
                [['account' => $c['bank'], 'debit' => $r['net']], ['account' => $AR, 'credit' => $r['net'], 'party' => $px]], ['parcels' => $r['n']]);
        }
        foreach ($D("SELECT $PKset d, COUNT(*) n, SUM(COALESCE($cpaid, COALESCE(o.cod,o.total)-COALESCE($cfee,?))) net FROM orders o WHERE o.settled=1 AND $CK='TCS' AND $setAt IS NOT NULL AND $PKset BETWEEN ? AND ? GROUP BY d ORDER BY d", $tfee) as $r) {
            $add('auto-settle', $r['d'], "TCS COD payment — {$r['n']} parcels",
                [['account' => $c['bank'], 'debit' => $r['net']], ['account' => $c['tcs_ar'], 'credit' => $r['net'], 'party' => $party('TCS')]], ['parcels' => $r['n'], 'courier' => 'TCS'], self::ckSid($r['d'], 'TCS'));
        }
        // lots bought on credit: Dr Purchases / Cr Accounts Payable (supplier); extra lot costs wait in Accrued Expenses until paid
        foreach ($D('SELECT name, vendor, bought_on, cost, pieces, COALESCE(extra,0) extra FROM lots WHERE cost>0'.$this->notPO('name').' AND bought_on BETWEEN ? AND ? ORDER BY bought_on, name') as $l) {
            $out[] = ['source' => 'lot', 'source_id' => $l['name'], 'date' => $l['bought_on'],
                'memo' => "Lot {$l['name']} bought from ".(($l['vendor'] ?? '') ?: 'vendor').($l['pieces'] ? " ({$l['pieces']} pairs)" : '').($l['extra'] > 0 ? ' + Rs '.self::num($l['extra']).' extra costs' : ''),
                'lines' => self::flip([['account' => $c['purchases'], 'debit' => self::r2($l['cost'] + $l['extra'])], ['account' => $c['payable'], 'credit' => $l['cost'], 'party' => 'vendor:'.(($l['vendor'] ?? '') ?: 'Unknown')], ['account' => 'Accrued Expenses', 'credit' => $l['extra'], 'party' => 'lot:'.$l['name']]]),
                'meta' => ['pieces' => $l['pieces']]];
        }
        // pairs listed: their cost moves from Unlisted to Listed Inventory (COGS later takes it out of Listed Inventory)
        foreach ($D('SELECT d, COUNT(*) n, SUM(cost) cost FROM ('.self::LISTED_SQL.') x WHERE d BETWEEN ? AND ? GROUP BY d ORDER BY d') as $r) {
            $add('auto-listing', $r['d'], "Pairs listed — {$r['n']} pairs moved to Listed Inventory at cost", [['account' => $c['inventory'], 'debit' => $r['cost']], ['account' => $c['unlisted'], 'credit' => $r['cost']]], ['pairs' => $r['n']]);
        }
        // a lot whose good pairs are all listed: clear what is left of it in Unlisted Inventory into COGS
        foreach ($this->lotClose() as $r) {
            if ($r['date'] >= $from && $r['date'] <= $to && abs($r['diff']) >= 1) {
                $add('auto-lotclose', $r['date'], "Lot {$r['lot']} fully listed — Rs ".self::num(abs($r['diff'])).' cost difference '.($r['diff'] > 0 ? 'left' : 'over-listed').' in Unlisted Inventory cleared to COGS',
                    [['account' => $c['cogs'], 'debit' => $r['diff']], ['account' => $c['unlisted'], 'credit' => $r['diff']]], ['lot' => $r['lot'], 'received' => $r['received'], 'listed' => $r['listed'], 'pairs' => $r['pairs'], 'good' => $r['good']], $r['lot']);
            }
        }
        return $out;
    }

    /** received lots (GRN posted) whose good pairs are all listed, with what the GRN put into Unlisted Inventory vs what listing took out */
    private function lotClose(): array
    {
        $c = $this->cfg();
        $ua = $this->acct($c['unlisted']);
        if (! $ua) {
            return [];
        }
        $good = [];
        if ($this->hasTable('wms_grn')) {
            try {
                foreach (Db::all('SELECT lot, good FROM wms_grn') as $g) {
                    $good[(string) $g['lot']] = (int) self::n($g['good']);
                }
            } catch (\Throwable) {
            }
        }
        $grn = Db::all("SELECT j.source_id lot, j.date, COALESCE(SUM(l.debit-l.credit),0) v FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id WHERE j.source='grn' AND j.voided=0 AND l.account_id=? GROUP BY j.id", $ua['id']);
        $out = [];
        foreach ($grn as $g) {
            $ls = Db::get('SELECT COUNT(*) n, COALESCE(SUM(cost),0) v, MAX(d) last FROM ('.self::LISTED_SQL.') x WHERE lot=?', $g['lot']);
            $need = $good[(string) $g['lot']] ?? 0;
            if (! $need || $ls['n'] < $need) {
                continue;
            }
            $out[] = ['lot' => $g['lot'], 'date' => ($ls['last'] > $g['date'] ? $ls['last'] : $g['date']), 'received' => self::r2($g['v']), 'listed' => self::r2($ls['v']), 'diff' => self::r2($g['v'] - $ls['v']), 'pairs' => $ls['n'], 'good' => $need];
        }
        return $out;
    }

    private function autoRange(?string $from, ?string $to): ?array
    {
        $start = $this->startDate();
        if ($start === '') {
            return null;
        }
        $f = ($from && $from > $start) ? $from : $start;
        $L = $this->lockDate();
        if ($L !== '' && $L >= $f) {
            $f = self::addDays($L, 1);
        }
        $today = $this->pkToday();
        $t = ($to && $to < $today) ? $to : $today;
        return $f > $t ? null : ['from' => $f, 'to' => $t];
    }

    private function sigOf(array $e): string
    {
        $lines = array_map(fn ($l) => [$this->mustAcct($l['account'])['id'], self::r2($l['debit'] ?? 0), self::r2($l['credit'] ?? 0), ($l['party'] ?? null) ?: null], $e['lines']);
        return json_encode([$e['date'], $e['memo'], $lines], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** opts: from, to, dry, userId */
    private function autoPost(array $opts = []): array
    {
        $rg = $this->autoRange($opts['from'] ?? null, $opts['to'] ?? null);
        $res = ['from' => $rg['from'] ?? null, 'to' => $rg['to'] ?? null, 'posted' => [], 'removed' => 0, 'unchanged' => 0, 'pending' => []];
        if ($this->startDate() === '') {
            return $res + ['off' => 'Set the date automatic postings start from (Accounts → Month close → Settings).'];
        }
        $L = $this->lockDate();
        $stale = Db::all('SELECT j.id, j.date, j.source FROM acc_journals j WHERE '.self::AUTO_SRC.' AND j.date<? '.($L !== '' ? 'AND j.date>?' : ''), ...array_merge([$this->startDate()], $L !== '' ? [$L] : []));
        if (! $rg && ! $stale) {
            return $res;
        }
        $want = $rg ? $this->autoEntries($rg['from'], $rg['to']) : [];
        $have = $rg ? Db::all('SELECT j.* FROM acc_journals j WHERE '.self::AUTO_SRC.' AND j.date BETWEEN ? AND ?', $rg['from'], $rg['to']) : [];
        $key = fn ($s, $id) => $s.'|'.$id;
        $haveMap = [];
        foreach ($have as $j) {
            $haveMap[$key($j['source'], $j['source_id'])] = $j;
        }
        $seen = [];
        $todo = [];
        foreach ($want as $e) {
            $k = $key($e['source'], $e['source_id']);
            $seen[$k] = true;
            $sig = $this->sigOf($e);
            $ex = $haveMap[$k] ?? Db::get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', $e['source'], (string) $e['source_id']);
            $exSig = null;
            if ($ex && ! $ex['voided']) {
                $m = json_decode((string) ($ex['meta'] ?: '{}'), true);
                $exSig = is_array($m) ? ($m['sig'] ?? null) : null;
            }
            if ($ex && $L !== '' && $ex['date'] <= $L) {
                continue; // moved out of a closed period: leave it
            }
            if ($exSig === $sig) {
                $res['unchanged']++;
                continue;
            }
            $e['meta'] = array_merge($e['meta'] ?: [], ['sig' => $sig]);
            $todo[] = $e;
        }
        $drop = array_merge(array_values(array_filter($have, fn ($j) => ! isset($seen[$key($j['source'], $j['source_id'])]))), $stale);
        $res['pending'] = array_merge(
            array_map(fn ($e) => ['source' => $e['source'], 'date' => $e['date'], 'memo' => $e['memo']], $todo),
            array_map(fn ($j) => ['source' => $j['source'], 'date' => $j['date'], 'memo' => 'remove (no longer applies)'], $drop)
        );
        if (! empty($opts['dry'])) {
            return $res;
        }
        Db::tx(function () use ($todo, $drop, $opts, &$res) {
            foreach ($todo as $e) {
                $this->postRaw($e + ['kind' => 'AUTO'], ($opts['userId'] ?? null) ?: null);
                $res['posted'][] = ['source' => $e['source'], 'date' => $e['date'], 'memo' => $e['memo'], 'amount' => self::r2(array_sum(array_map(fn ($l) => self::r2($l['debit'] ?? 0), $e['lines'])))];
            }
            foreach ($drop as $j) {
                $this->removeJ((int) $j['id']);
                $res['removed']++;
            }
        });
        $res['pending'] = [];
        $this->setSetting('accounts_autopost_last', ['at' => $this->pkNow(), 'posted' => count($res['posted']), 'removed' => $res['removed'], 'unchanged' => $res['unchanged'], 'by' => ($opts['userId'] ?? null) ?: null]);
        $this->resetPending();
        return $res;
    }

    /** cached dry-run for badges/alerts (polled every 30s by every client) */
    private function pendingCount(): int
    {
        return (int) Cache::remember(self::CACHE_PENDING, 600, function () {
            try {
                return count($this->autoPost(['dry' => true])['pending']);
            } catch (\Throwable) {
                return 0;
            }
        });
    }

    /* ================================================================ month close checks */

    private function checks(string $month): array
    {
        $from = $month.'-01';
        $to = self::monthEnd($month);
        $c = $this->cfg();
        $out = [];
        $fee = self::n($this->setting('courier_fee', 250));
        $add = function ($key, $title, $status, $detail, $fix) use (&$out) {
            $out[] = ['key' => $key, 'title' => $title, 'status' => $status, 'detail' => $detail, 'fix' => $status === 'pass' ? '' : $fix];
        };
        $m = [];
        foreach ($this->sums($from, $to) as $a) {
            $m[$a['name']] = $a;
        }
        $amt = fn ($n) => isset($m[$n]) ? $m[$n]['amt'] : 0;
        $CK = self::CK;
        $tb = $this->trial($to);
        $add('tb', 'Trial balance balances', $tb['diff'] ? 'fail' : 'pass', 'Debits '.self::fmt($tb['debit']).' · credits '.self::fmt($tb['credit']).($tb['diff'] ? ' · difference '.self::fmt($tb['diff']) : ''), 'Find the entry where debits and credits differ (Vouchers → filter this month).');
        $rec = ($c['recognise'] ?? null) === 'delivered' ? 'o.delivered_at' : 'o.dispatched_at';
        $pc = self::PAIR_COST;
        $sold = Db::get("SELECT COALESCE(SUM(i.qty),0) pairs, SUM($pc*i.qty) cost, SUM(CASE WHEN $pc IS NOT NULL THEN i.qty END) costed FROM order_items i JOIN orders o ON o.id=i.order_id
    ".self::PAIR_JOIN." WHERE $rec IS NOT NULL AND o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND ".self::pkd($rec).' BETWEEN ? AND ?', $from, $to);
        $cogsDr = isset($m[$c['cogs']]) ? $m[$c['cogs']]['dr'] : 0;
        if (! $sold['pairs']) {
            $add('cogs', 'Cost per pair sold', 'pass', 'No pairs sold this month.', '');
        } elseif (! $cogsDr) {
            $add('cogs', 'Cost per pair sold', 'fail', self::num($sold['pairs'])." pairs were {$c['recognise']} but no Cost of Goods Sold was posted.", 'Run automatic postings (Post now) or post the cost of goods sold.');
        } else {
            $per = $cogsDr / $sold['pairs'];
            $avg = $sold['costed'] ? $sold['cost'] / $sold['costed'] : 0;
            $diff = $avg ? abs($per - $avg) / $avg : 0;
            $add('cogs', 'Cost per pair sold', $avg && $diff > 0.15 ? 'warn' : 'pass',
                'COGS '.self::fmt($cogsDr).' ÷ '.self::num($sold['pairs']).' pairs = '.self::fmt($per).' per pair · average product cost of those pairs '.($avg ? self::fmt($avg) : 'unknown').($avg ? ' ('.Logic::jsRound($diff * 100).'% apart)' : ''),
                $per < $avg ? 'COGS per pair is lower than what the shoes cost. Check that every sold pair was costed (lot cost ÷ good pairs) and that COGS was not posted only for delivered parcels.' : 'COGS per pair is higher than product cost. Check for double COGS entries or damaged pairs booked as COGS.');
        }
        $par = Db::get("SELECT COUNT(*) n, SUM(px_fee IS NULL) nofee FROM orders WHERE dispatched_at IS NOT NULL AND tracking IS NOT NULL AND cancelled_at IS NULL AND status<>'courier_cancelled' AND ".self::pkd('dispatched_at').' BETWEEN ? AND ?', $from, $to);
        $ship = $amt($c['shipping']);
        if (! $par['n']) {
            $add('courier', 'Courier charges vs parcels', 'pass', 'No parcels dispatched this month.', '');
        } else {
            $st = ! $ship ? 'fail' : (($ship / $par['n'] < $fee * 0.5 || ($par['nofee'] ?? 0) / $par['n'] > 0.2) ? 'warn' : 'pass');
            $add('courier', 'Courier charges vs parcels', $st, self::num($par['n']).' parcels dispatched · Shipping Exp '.self::fmt($ship).' ('.self::fmt($ship / $par['n']).' per parcel) · '.self::num($par['nofee'] ?: 0).' parcels have no PostEx charge yet',
                ! $ship ? 'No courier cost was booked. Charges must be accrued when parcels are dispatched, not when PostEx pays — run Post now.' : 'Many parcels have no PostEx charge yet (estimated at '.self::fmt($fee).'). Sync PostEx, then Post now; or check the courier fee in Settings.');
        }
        $taxes = [];
        foreach ($m as $a) {
            if (preg_match('/tax|gst/i', (string) $a['name']) && ($a['dr'] || $a['cr'])) {
                $v = self::r2($a['dr'] - $a['cr']);
                if ($v) {
                    $taxes[] = ['n' => $a['name'], 'v' => $v];
                }
            }
        }
        $same = [];
        for ($i = 0; $i < count($taxes); $i++) {
            for ($k = $i + 1; $k < count($taxes); $k++) {
                if (abs($taxes[$i]['v'] - $taxes[$k]['v']) < 1) {
                    $same[] = "{$taxes[$i]['n']} and {$taxes[$k]['n']} are both ".self::fmt($taxes[$i]['v']);
                }
            }
        }
        $add('tax', 'Tax lines not doubled', $same ? 'warn' : 'pass', $same ? implode('; ', $same) : ($taxes ? implode(' · ', array_map(fn ($t) => $t['n'].' '.self::fmt($t['v']), $taxes)) : 'No tax posted this month.'), 'Two tax accounts with exactly the same amount usually means one tax was entered twice (e.g. income tax withheld also booked as sales tax). Check the vouchers and void the duplicate.');
        $prepaid = $this->balance('Prepaid Rent', $to);
        foreach (['Office Rent', 'Outlet Rent'] as $r) {
            if ($this->acct($r)) {
                $add('rent-'.$r, $r.' posted', $amt($r) > 0 ? 'pass' : 'warn', $amt($r) > 0 ? self::fmt($amt($r)).' this month' : "No $r expense this month.".($prepaid ? ' Prepaid Rent still holds '.self::fmt($prepaid).'.' : ''),
                    $prepaid ? "If the rent was paid in advance, move one month into expense: JV Dr $r / Cr Prepaid Rent." : "Post this month's $r (Payment voucher, or JV to Accrued Expenses if still unpaid).");
            }
        }
        $adv = Db::all('SELECT DISTINCT j.id, j.ref, j.date, j.memo, l.credit FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.account_id=? AND l.credit>0 AND j.voided=0 AND NOT '.self::AUTO_SRC."
    AND j.date BETWEEN ? AND ? AND (j.memo LIKE '%advance%' OR l.memo LIKE '%advance%' OR j.source='manual')", $this->mustAcct($c['sales'])['id'], $from, $to);
        $nAdv = count($adv);
        $add('advance', 'Customer advances not booked as Sales', $nAdv ? 'warn' : 'pass',
            $nAdv ? "$nAdv manual entr".($nAdv > 1 ? 'ies' : 'y').' credit Sales: '.implode(', ', array_map(fn ($a) => (($a['ref'] ?? '') ?: '#'.$a['id']).' '.self::fmt($a['credit']).' "'.mb_substr((string) ($a['memo'] ?? ''), 0, 40).'"', array_slice($adv, 0, 5))) : 'Only automatic order postings credit Sales.',
            'Money received before an order ships is a Customer Advance (liability), not Sales. Edit these to credit Customer Advances; the sale is recorded automatically when the order is dispatched.');
        $dmg = $amt('Inventory Damage');
        $inv = $this->balance('Listed Inventory', $to) + $this->balance('Unlisted Inventory', $to);
        $invVal = $inv > 0 ? $inv : (Db::val('SELECT COALESCE(SUM(cost*qty),0) v FROM products WHERE qty>0') ?: 0);
        $add('damage', 'Inventory damage reasonable', $invVal && $dmg / $invVal > 0.01 ? 'warn' : 'pass', 'Inventory Damage '.self::fmt($dmg).' vs inventory '.self::fmt($invVal).($invVal ? ' ('.number_format(100 * $dmg / $invVal, 1, '.', '').'%)' : ''), 'Damage above 1% of stock in a month is unusual. Ask for the list of damaged pairs (SKU, reason, photo) and check returns were restocked instead of written off.');
        $pxBal = $this->balance($c['courier_ar'], $to);
        $recBasis = ($c['recognise'] ?? null) === 'delivered';
        $du = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)-COALESCE(px_fee,?)-COALESCE(px_tax,0)),0) v FROM orders o WHERE $CK='PostEx' AND delivered_at IS NOT NULL AND ".self::pkd('delivered_at').'<=? AND status=\'delivered\' AND (settled=0 OR '.self::pkd('COALESCE(settled_at,delivered_at)').'>?)', $fee, $to, $to);
        $it = $recBasis ? ['n' => 0, 'v' => 0] : Db::get("SELECT COUNT(*) n, COALESCE(SUM(total-COALESCE(px_fee,?)-COALESCE(px_tax,0)),0) v FROM orders o WHERE $CK='PostEx' AND dispatched_at IS NOT NULL AND ".self::pkd('dispatched_at')."<=? AND cancelled_at IS NULL
    AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND (delivered_at IS NULL OR ".self::pkd('delivered_at').'>?) AND (COALESCE(returned_at,return_received_at) IS NULL OR '.self::pkd('COALESCE(returned_at,return_received_at)').'>?)', $fee, $to, $to, $to);
        $expd = self::r2($du['v'] + $it['v']);
        $pdiff = self::r2($pxBal - $expd);
        $add('postex', 'PostEx receivable matches orders', abs($pdiff) > max(1000, abs($expd) * 0.02) ? 'warn' : 'pass',
            'Books '.self::fmt($pxBal).' · delivered not yet paid '.self::fmt($du['v'])." ({$du['n']})".($recBasis ? '' : ' · in transit '.self::fmt($it['v'])." ({$it['n']})").' · difference '.self::fmt($pdiff),
            $pdiff < 0 ? 'Books show less than PostEx owes. Usually return charges PostEx already deducted from a payment: post Dr Post Ex / Cr bank for the deducted amount, or check for missing sales days.' : 'Books show more than PostEx owes. Check for payments not yet recorded, or an opening balance that is too high.');
        // TCS and the own rider: same idea as PostEx (only shown once they are used)
        if ($this->hasCol('orders', 'courier_fee')) {
            $tfee = self::n($this->setting('couriers_tcs_fee', 250));
            $live = "cancelled_at IS NULL AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled')";
            $retD = self::pkd('COALESCE(returned_at,return_received_at)');
            $setD = self::pkd('COALESCE(settled_at,delivered_at)');
            $tcsBal = $this->balance($c['tcs_ar'], $to);
            $tdu = Db::get("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(cod,total)-COALESCE(courier_fee,?)),0) v FROM orders o WHERE $CK='TCS' AND delivered_at IS NOT NULL AND ".self::pkd('delivered_at')."<=? AND status='delivered' AND (settled=0 OR $setD>?)", $tfee, $to, $to);
            $tit = $recBasis ? ['n' => 0, 'v' => 0] : Db::get("SELECT COUNT(*) n, COALESCE(SUM(total-COALESCE(courier_fee,?)),0) v FROM orders o WHERE $CK='TCS' AND dispatched_at IS NOT NULL AND tracking IS NOT NULL AND ".self::pkd('dispatched_at')."<=? AND $live
      AND (delivered_at IS NULL OR ".self::pkd('delivered_at').">?) AND (COALESCE(returned_at,return_received_at) IS NULL OR $retD>?)", $tfee, $to, $to, $to);
            if ($tdu['n'] || $tit['n'] || abs($tcsBal) >= 1) {
                $te = self::r2($tdu['v'] + $tit['v']);
                $td = self::r2($tcsBal - $te);
                $add('tcs', 'TCS receivable matches orders', abs($td) > max(1000, abs($te) * 0.02) ? 'warn' : 'pass',
                    'Books '.self::fmt($tcsBal).' · delivered not yet paid '.self::fmt($tdu['v'])." ({$tdu['n']})".($recBasis ? '' : ' · in transit '.self::fmt($tit['v'])." ({$tit['n']})").' · difference '.self::fmt($td),
                    $td < 0 ? 'Books show less than TCS owes: usually return charges TCS deducted (post Dr TCS / Cr bank), or missing sales days. Sync TCS payments, then Post now.' : 'Books show more than TCS owes: a TCS payment not yet synced/recorded, or charges not yet reported. Run the TCS payment sync (Couriers → Settings), then Post now.');
            }
            $rBal = $this->balance($c['rider_ar'], $to);
            $rcol = $recBasis ? 'delivered_at' : 'dispatched_at';
            $rOpen = Db::get("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders o WHERE $CK='Rider' AND $rcol IS NOT NULL AND ".self::pkd($rcol)."<=? AND $live
      AND (settled=0 OR $setD>?) AND (COALESCE(returned_at,return_received_at) IS NULL OR $retD>?)", $to, $to, $to);
            if ($rOpen['n'] || abs($rBal) >= 1) {
                $rd = self::r2($rBal - $rOpen['v']);
                $add('rider', 'Rider cash matches parcels', abs($rd) > 500 ? 'warn' : 'pass', 'Books '.self::fmt($rBal).' · rider parcels not yet handed over or returned '.self::fmt($rOpen['v'])." ({$rOpen['n']}) · difference ".self::fmt($rd),
                    'Every rider parcel is either cash handed over (Rider runs → handover), returned to the office, or still out. Record the missing handovers, receive failed parcels back, then Post now.');
            }
        }
        // inventory chain: Purchases = lots bought but not received yet; Listed / Unlisted Inventory must not go below zero
        $purch = $this->balance($c['purchases'], $to);
        $lis = $this->balance($c['inventory'], $to);
        $unl = $this->balance($c['unlisted'], $to);
        $openLots = null;
        try {
            $openLots = Db::get('SELECT COUNT(*) n, COALESCE(SUM(l.cost + COALESCE(l.extra,0)),0) v FROM lots l WHERE l.cost>0'.$this->notPO('l.name')." AND l.bought_on<=? AND l.bought_on>=? AND NOT EXISTS (SELECT 1 FROM acc_journals j WHERE j.source='grn' AND j.source_id=l.name AND j.voided=0 AND j.date<=?)", $to, $this->startDate() ?: '0000', $to);
        } catch (\Throwable) {
        }
        $invBad = [];
        if ($lis < -1) {
            $invBad[] = 'Listed Inventory is negative ('.self::fmt($lis).'): pairs were sold or written off that were never moved in. Enter the opening Listed Inventory, or check pairs sold without a cost.';
        }
        if ($unl < -1) {
            $invBad[] = 'Unlisted Inventory is negative ('.self::fmt($unl).'): pairs were listed from lots that were never received. Receive the lot in WMS (GRN) or enter the opening Unlisted Inventory.';
        }
        if ($purch < -1) {
            $invBad[] = 'Purchases is negative ('.self::fmt($purch).'): a lot was received for more than it was bought for. Check the lot cost and the GRN.';
        }
        if ($openLots && abs($purch - $openLots['v']) > 1) {
            $invBad[] = 'Purchases '.self::fmt($purch).' but lots bought and not yet received total '.self::fmt($openLots['v'])." ({$openLots['n']}). Receive delivered lots in WMS, or check the opening balance.";
        }
        $add('inventory', 'Inventory accounts make sense', $invBad ? 'warn' : 'pass', $invBad ? implode(' ', $invBad) : 'Purchases (in transit) '.self::fmt($purch).' · Unlisted '.self::fmt($unl).' · Listed '.self::fmt($lis), 'Lot bought → Purchases; received (GRN) → Unlisted; listed → Listed; sold → COGS. Fix the step that is missing.');
        // the same cost booked from two places
        $fam = fn ($s) => $s === 'manual' ? 'vouchers' : ($s === 'expense' || $s === 'petty_count' ? 'expense claims' : ($s === 'payroll' ? 'payroll' : ($s === 'meta' || $s === 'meta_pay' || $s === 'mkt_other' ? 'marketing' : $s)));
        $dbl = [];
        foreach (['Office Rent', 'Outlet Rent', 'Salary Exp', 'Social Media Marketing'] as $n) {
            $a = $this->acct($n);
            if (! $a) {
                continue;
            }
            $fs = array_values(array_unique(array_map(fn ($r) => $fam($r['source']), Db::all('SELECT DISTINCT j.source FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE l.account_id=? AND l.debit>0 AND j.voided=0 AND j.date BETWEEN ? AND ?', $a['id'], $from, $to))));
            if (count($fs) > 1) {
                $dbl[] = "$n comes from ".implode(' and ', $fs);
            }
        }
        $add('doubles', 'Same cost not booked twice', $dbl ? 'warn' : 'pass', $dbl ? implode('; ', $dbl).'.' : 'Rent, salaries and Meta ads each come from one place.', 'Rent: use either the recurring expense or a voucher (or Prepaid Rent JV), not both. Salaries: only payroll. Meta ads: only the Marketing screen. Void the duplicate.');
        $rg = $this->autoRange($from, $to);
        $pend = $rg ? $this->autoPost(['from' => $from, 'to' => $to, 'dry' => true])['pending'] : [];
        $st0 = $this->startDate() === '';
        $days = array_values(array_unique(array_map(fn ($p) => $p['date'], $pend)));
        $add('auto', 'Automatic postings up to date', $st0 ? 'warn' : ($pend ? 'warn' : 'pass'),
            $st0 ? 'Automatic postings are off.' : ($pend ? count($pend).' automatic entries are missing or out of date ('.implode(', ', array_slice($days, 0, 4)).(count($pend) > 4 ? '…' : '').').' : 'All sales, cost, returns, courier and COD entries are posted.'),
            $st0 ? 'Set the start date in Settings so sales, COGS and courier charges post themselves.' : 'Click "Post now" before closing the month.');
        return ['month' => $month, 'from' => $from, 'to' => $to, 'locked' => $this->lockDate() >= $to, 'checks' => $out,
            'fails' => count(array_filter($out, fn ($x) => $x['status'] === 'fail')), 'warns' => count(array_filter($out, fn ($x) => $x['status'] === 'warn'))];
    }

    /* ================================================================ services (ctx.services.accounts) */

    /**
     * Post (or re-post) a journal entry. Same (source, source_id) updates the existing entry (and un-voids it).
     *
     * @param  array  $j  ['date'=>'YYYY-MM-DD', 'memo'=>string, 'source'=>string (default 'manual'), 'source_id'=>string|int (required),
     *                    'ref'=>?string, 'kind'=>?string ('JV','PV','RV','CV' get an automatic ref), 'file_id'=>?string, 'meta'=>?array,
     *                    'lines'=>[['account'=>name|code, 'debit'=>num, 'credit'=>num, 'party'=>?string, 'memo'=>?string], ...]]
     * @param  int|null  $userId
     * @return int journal id
     * @throws HttpError 400 on bad input / unbalanced lines / closed period
     */
    public function post(array $j, $userId = null): int
    {
        return Db::tx(fn () => $this->postRaw($j, $userId));
    }

    /**
     * Void the entry posted under (source, source_id). JS name: void(source, sid, userId, reason).
     *
     * @return bool false when there is no such entry or it is already voided
     * @throws HttpError 400 when the entry is in a closed period
     */
    public function voidEntry($source, $sid, $userId = null, $reason = null): bool
    {
        $ex = Db::get('SELECT * FROM acc_journals WHERE source=? AND source_id=?', (string) $source, (string) $sid);
        if (! $ex || $ex['voided']) {
            return false;
        }
        $this->checkLock($ex['date']);
        Db::run('UPDATE acc_journals SET voided=1, void_reason=?, voided_by=?, voided_at=UTC_TIMESTAMP() WHERE id=?', ($reason ?: null), ($userId ?: null), $ex['id']);
        return true;
    }

    /** Alias of voidEntry() with the original service name: void(source, sid, userId, reason) -> bool */
    public function void($source, $sid, $userId = null, $reason = null): bool
    {
        return $this->voidEntry($source, $sid, $userId, $reason);
    }

    /**
     * Debit-minus-credit balance of an account (name or code), optionally up to a date and for one party.
     *
     * @return int|float  (throws HttpError 400 'Unknown account "x"')
     */
    public function balance($n, ?string $upTo = null, ?string $party = null): int|float
    {
        $a = $this->mustAcct($n);
        $w = ['l.account_id=?', 'j.voided=0'];
        $args = [$a['id']];
        if ($upTo) {
            $w[] = 'j.date<=?';
            $args[] = $upTo;
        }
        if ($party) {
            $w[] = 'l.party=?';
            $args[] = $party;
        }
        return self::r2(Db::val('SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE '.implode(' AND ', $w), ...$args));
    }

    /**
     * Home-page figures.
     *
     * @return array ['cash','bank','postexReceivable','tcsReceivable','riderCash','payables','salesMTD','profitMTD']
     */
    public function summary(): array
    {
        $today = $this->pkToday();
        $ms = substr($today, 0, 7).'-01';
        $cash = array_filter($this->sums(null, $today), fn ($a) => $a['grp'] === 'cash' && $a['type'] === 'asset');
        $isCash = fn ($a) => (bool) preg_match('/cash/i', (string) $a['name']);
        $p = $this->pnl($ms, $today);
        $c = $this->cfg();
        $sumBal = fn ($list) => self::r2(array_sum(array_column($list, 'bal')));
        return ['cash' => $sumBal(array_filter($cash, $isCash)), 'bank' => $sumBal(array_filter($cash, fn ($a) => ! $isCash($a))),
            'postexReceivable' => $this->balance($c['courier_ar'], $today), 'tcsReceivable' => $this->balance($c['tcs_ar'], $today), 'riderCash' => $this->balance($c['rider_ar'], $today),
            'payables' => -$this->balance($c['payable'], $today), 'salesMTD' => $p['netSales'], 'profitMTD' => $p['net']];
    }

    /** Account id for a name or code (case-insensitive name fallback), or null. */
    public function accountId($n): ?int
    {
        $a = $this->acct($n);
        return $a ? (int) $a['id'] : null;
    }

    /**
     * Account ledger: ledger(account, from?, to?, party?)
     *
     * @return array ['account'=>row, 'from','to','party','opening', 'rows'=>[[id,journal_id,date,ref,memo,source,source_id,debit,credit,party,lmemo,other,balance]], 'debit','credit','closing']
     */
    public function ledger($n, ?string $from = null, ?string $to = null, ?string $party = null): array
    {
        $a = $this->mustAcct($n);
        $w = ['l.account_id=?', 'j.voided=0'];
        $args = [$a['id']];
        if ($party) {
            $w[] = 'l.party=?';
            $args[] = $party;
        }
        $opening = self::r2(Db::val('SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE '.implode(' AND ', $w).' AND j.date<?', ...array_merge($args, [$from ?: '0000'])));
        if ($from) {
            $w[] = 'j.date>=?';
            $args[] = $from;
        }
        if ($to) {
            $w[] = 'j.date<=?';
            $args[] = $to;
        }
        $rows = Db::all("SELECT l.id, j.id journal_id, j.date, j.ref, j.memo, j.source, j.source_id, l.debit, l.credit, l.party, l.memo lmemo,
     (SELECT GROUP_CONCAT(a2.name SEPARATOR ', ') FROM acc_lines l2 JOIN acc_accounts a2 ON a2.id=l2.account_id WHERE l2.journal_id=j.id AND l2.account_id<>l.account_id) other
     FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE ".implode(' AND ', $w).' ORDER BY j.date, j.id, l.id LIMIT 5000', ...$args);
        $run = $opening;
        $dr = 0;
        $cr = 0;
        foreach ($rows as &$r) {
            $run = self::r2($run + $r['debit'] - $r['credit']);
            $r['balance'] = $run;
            $dr += $r['debit'];
            $cr += $r['credit'];
        }
        unset($r);
        return ['account' => $a, 'from' => $from, 'to' => $to, 'party' => $party ?: null, 'opening' => $opening, 'rows' => $rows, 'debit' => self::r2($dr), 'credit' => self::r2($cr), 'closing' => $run];
    }

    /**
     * Trial balance up to $date (optionally from $from).
     *
     * @return array ['date','rows'=>[[id,code,name,type,debit,credit]],'debit','credit','diff']
     */
    public function trial(?string $date, ?string $from = null): array
    {
        $rows = [];
        foreach ($this->sums($from ?: null, $date) as $a) {
            if ($a['dr'] || $a['cr']) {
                $rows[] = ['id' => $a['id'], 'code' => $a['code'], 'name' => $a['name'], 'type' => $a['type'], 'debit' => $a['bal'] > 0 ? $a['bal'] : 0, 'credit' => $a['bal'] < 0 ? -$a['bal'] : 0];
            }
        }
        $dr = self::r2(array_sum(array_column($rows, 'debit')));
        $cr = self::r2(array_sum(array_column($rows, 'credit')));
        return ['date' => $date, 'rows' => $rows, 'debit' => $dr, 'credit' => $cr, 'diff' => self::r2($dr - $cr)];
    }

    /**
     * Profit & loss for a date range.
     *
     * @return array ['from','to','sales','less','netSales','cogs','gross','selling','admin','opex','operating','other','beforeTax','tax','net']
     *               (sections are ['title','rows'=>[[id,code,name,amount]],'total'])
     */
    public function pnl(?string $from, ?string $to): array
    {
        $rows = array_values(array_filter($this->sums($from, $to), fn ($a) => $a['statement'] === 'IS'));
        $sales = $this->sec('Sales', array_filter($rows, fn ($a) => $a['type'] === 'income' && $a['grp'] === 'sales'));
        $less = $this->sec('Less: returns & discounts', array_filter($rows, fn ($a) => $a['type'] === 'contra_income'), -1);
        $netSales = self::r2($sales['total'] + $less['total']);
        $exp = fn ($g) => array_filter($rows, fn ($a) => $a['type'] === 'expense' && ($g ? $a['grp'] === $g : ! in_array($a['grp'], ['cogs', 'selling', 'tax'], true)));
        $cogs = $this->sec('Cost of sales', $exp('cogs'), -1);
        $gross = self::r2($netSales + $cogs['total']);
        $selling = $this->sec('Selling & delivery', $exp('selling'), -1);
        $admin = $this->sec('Admin & general', $exp(null), -1);
        $operating = self::r2($gross + $selling['total'] + $admin['total']);
        $other = $this->sec('Other income', array_filter($rows, fn ($a) => $a['type'] === 'income' && $a['grp'] !== 'sales'));
        $beforeTax = self::r2($operating + $other['total']);
        $tax = $this->sec('Tax', $exp('tax'), -1);
        $net = self::r2($beforeTax + $tax['total']);
        return ['from' => $from, 'to' => $to, 'sales' => $sales, 'less' => $less, 'netSales' => $netSales, 'cogs' => $cogs, 'gross' => $gross, 'selling' => $selling, 'admin' => $admin,
            'opex' => self::r2(-($selling['total'] + $admin['total'])), 'operating' => $operating, 'other' => $other, 'beforeTax' => $beforeTax, 'tax' => $tax, 'net' => $net];
    }

    /**
     * Balance sheet as of $date.
     *
     * @return array ['date','fyStart','assets','liabilities','equity','retained','currentProfit','totalAssets','totalLiabilities','totalEquity','diff']
     */
    public function bs(string $date): array
    {
        $rows = $this->sums(null, $date);
        $part = function (string $type) use ($rows) {
            $groups = self::GROUPS[$type] ?? [];
            $known = array_column($groups, 0);
            $out = [];
            foreach ($groups as [$g, $t]) {
                $list = [];
                foreach ($rows as $a) {
                    if ($a['type'] === $type && ($a['grp'] === $g || ($g === $groups[0][0] && ! in_array($a['grp'], $known, true))) && ($a['dr'] || $a['cr'])) {
                        $list[] = ['id' => $a['id'], 'code' => $a['code'], 'name' => $a['name'], 'amount' => $a['amt']];
                    }
                }
                if ($list) {
                    $out[] = ['title' => $t, 'rows' => $list, 'total' => self::r2(array_sum(array_column($list, 'amount')))];
                }
            }
            return $out;
        };
        $assets = $part('asset');
        $liabilities = $part('liability');
        $eq = $part('equity');
        $fy = $this->fyStart($date);
        $cy = $this->pnl($fy, $date)['net'];
        $allIS = 0;
        foreach ($rows as $a) {
            if ($a['statement'] === 'IS') {
                $allIS += $a['cr'] - $a['dr'];
            }
        }
        $allIS = self::r2($allIS);
        $retained = self::r2($allIS - $cy);
        $tA = self::r2(array_sum(array_column($assets, 'total')));
        $tL = self::r2(array_sum(array_column($liabilities, 'total')));
        $tE = self::r2(array_sum(array_column($eq, 'total')) + $retained + $cy);
        return ['date' => $date, 'fyStart' => $fy, 'assets' => $assets, 'liabilities' => $liabilities, 'equity' => $eq, 'retained' => $retained, 'currentProfit' => $cy,
            'totalAssets' => $tA, 'totalLiabilities' => $tL, 'totalEquity' => $tE, 'diff' => self::r2($tA - $tL - $tE)];
    }

    /**
     * Readable name for a party code: employee:<hr employee id>, employee:u<user id>, vendor:<name>, customer:<phone>, courier:<name>, lot:<name>.
     */
    public function partyName($p)
    {
        if (! preg_match('/^(\w+):(.*)$/s', (string) ($p ?? ''), $m)) {
            return $p;
        }
        [, $k, $v] = $m;
        $one = function (string $sql, ...$a) {
            try {
                $r = Db::get($sql, ...$a);
                return $r ? $r['name'] : null;
            } catch (\Throwable) {
                return null;
            }
        };
        if ($k === 'employee') {
            if (preg_match('/^u\d+$/', $v)) {
                return $one('SELECT name FROM users WHERE id=?', (int) substr($v, 1)) ?: $v;
            }
            return ($this->hasTable('hr_employees') ? $one('SELECT name FROM hr_employees WHERE id=?', (int) self::n($v)) : null) ?: $v;
        }
        if ($k === 'customer') {
            return $one('SELECT name FROM customers WHERE phone=?', $v) ?: $v;
        }
        if ($k === 'lot') {
            return 'Lot '.$v;
        }
        return $v;
    }

    /** Books are closed up to this day ('YYYY-MM-DD'), '' when nothing is closed. */
    public function lockDate(): string
    {
        return (string) ($this->setting('accounts_lock_date', '') ?: '');
    }

    /* ================================================================ module */

    public function install(): void
    {
        foreach (self::SEED as [$code, $name, $type, $grp]) {
            if (! Db::get('SELECT id FROM acc_accounts WHERE name=?', $name)) {
                Db::run('INSERT IGNORE INTO acc_accounts(code,name,type,statement,grp,`system`) VALUES(?,?,?,?,?,1)',
                    Db::get('SELECT id FROM acc_accounts WHERE code=?', $code) ? null : $code, $name, $type, self::TYPES[$type], $grp);
            }
        }
    }

    public function routes(Router $r): void
    {
        // chart of accounts
        $r->get('/api/accounts/chart', 'accounts', 'chartList');
        $r->post('/api/accounts/chart', 'accounts_post', 'chartSave');
        $r->delete('/api/accounts/chart/:id', 'accounts_post', 'chartDelete');
        // journals & vouchers
        $r->get('/api/accounts/journals', 'accounts', 'journalsList');
        $r->get('/api/accounts/journals/:id', 'accounts', 'journalShow');
        $r->post('/api/accounts/vouchers', 'accounts_post', 'voucherSave');
        $r->post('/api/accounts/journals/:id/void', 'accounts_post', 'journalVoid');
        // opening balances
        $r->get('/api/accounts/opening', 'accounts', 'openingGet');
        $r->post('/api/accounts/opening', 'accounts_post', 'openingSave');
        // settings
        $r->get('/api/accounts/settings', 'accounts', 'settingsGet');
        $r->post('/api/accounts/settings', 'accounts_post', 'settingsSave');
        // automatic postings
        $r->get('/api/accounts/auto', 'accounts', 'autoGet');
        $r->post('/api/accounts/auto', 'accounts_post', 'autoRun');
        // reports
        $r->get('/api/accounts/ledger', 'accounts', 'ledgerRoute');
        $r->get('/api/accounts/parties', 'accounts', 'partiesRoute');
        $r->get('/api/accounts/trial', 'accounts', 'trialRoute');
        $r->get('/api/accounts/pnl', 'accounts', 'pnlRoute');
        $r->get('/api/accounts/bs', 'accounts', 'bsRoute');
        $r->get('/api/accounts/sales-register', 'accounts', 'salesRegister');
        $r->get('/api/accounts/overview', 'accounts', 'overview');
        // month close
        $r->get('/api/accounts/close', 'accounts', 'closeGet');
        $r->post('/api/accounts/close', 'accounts_post', 'closeMonth');
        $r->post('/api/accounts/reopen', 'accounts_post', 'reopenMonth');
    }

    private static function isAdmin(?array $u): bool
    {
        return ($u['role'] ?? null) === 'admin';
    }

    private static function dOr($v, $d)
    {
        return self::isDate($v) ? $v : $d;
    }

    /* ---------------- chart */

    public function chartList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $used = [];
        foreach (Db::all('SELECT DISTINCT account_id a FROM acc_lines') as $x) {
            $used[$x['a']] = true;
        }
        $accounts = array_map(fn ($a) => $a + ['used' => isset($used[$a['id']])], $this->sums(null, self::dOr($qs['date'] ?? null, $this->pkToday())));
        return ['accounts' => $accounts, 'groups' => self::GROUPS, 'types' => array_keys(self::TYPES)];
    }

    public function chartSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $name = trim(is_scalar($b['name'] ?? null) && ($b['name'] ?? null) !== false ? (string) $b['name'] : '');
        $code = trim(is_scalar($b['code'] ?? null) && ($b['code'] ?? null) !== false && ($b['code'] ?? null) !== 0 ? (string) $b['code'] : '');
        $code = $code === '' ? null : $code;
        $this->need($name !== '', 'Account name is needed');
        $note = ($b['note'] ?? null) ?: null;
        $grpIn = $b['grp'] ?? null;
        if (! empty($b['id'])) {
            $a = Db::get('SELECT * FROM acc_accounts WHERE id=?', (int) $b['id']);
            $this->need($a, 'Not found', 404);
            $this->need(! $a['system'] || $name === $a['name'], 'Built-in accounts cannot be renamed — other screens post to them by name. Add a new account instead.');
            $this->need(! $a['system'] || ($b['active'] ?? null) !== false, 'Built-in accounts cannot be deactivated.');
            $dupe = Db::get('SELECT id FROM acc_accounts WHERE (lower(name)=lower(?) OR code=?) AND id<>?', $name, $code, $a['id']);
            $this->need(! $dupe, 'Another account has that name or code');
            $grp = in_array($grpIn, array_column(self::GROUPS[$a['type']] ?? [], 0), true) ? $grpIn : $a['grp'];
            $active = ($b['active'] ?? null) !== false;
            Db::run('UPDATE acc_accounts SET name=?, code=?, grp=?, active=?, note=? WHERE id=?', $name, $code, $grp, $active ? 1 : 0, $note, $a['id']);
            $this->log($u['id'], 'accounts.account', 'acc_account:'.$a['id'], ['name' => $name, 'code' => $code, 'active' => $active]);
            return ['ok' => true, 'id' => $a['id']];
        }
        $type = $b['type'] ?? null;
        $this->need(is_string($type) && isset(self::TYPES[$type]), 'Choose a type');
        $this->need(! $this->acct($name) && ! ($code && $this->acct($code)), 'An account with that name or code already exists');
        $grp = in_array($grpIn, array_column(self::GROUPS[$type], 0), true) ? $grpIn : self::GROUPS[$type][0][0];
        $id = Db::run('INSERT INTO acc_accounts(code,name,type,statement,grp,note) VALUES(?,?,?,?,?,?)', $code, $name, $type, self::TYPES[$type], $grp, $note)->lastInsertRowid;
        $this->log($u['id'], 'accounts.account', 'acc_account:'.$id, ['name' => $name, 'code' => $code, 'type' => $type]);
        return ['ok' => true, 'id' => (int) $id];
    }

    public function chartDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $a = Db::get('SELECT * FROM acc_accounts WHERE id=?', (int) $p['id']);
        $this->need($a, 'Not found', 404);
        $this->need(! $a['system'], 'Built-in accounts cannot be deleted');
        $this->need(! Db::get('SELECT id FROM acc_lines WHERE account_id=? LIMIT 1', $a['id']), 'This account has entries — deactivate it instead');
        Db::run('DELETE FROM acc_accounts WHERE id=?', $a['id']);
        $this->log($u['id'], 'accounts.account.delete', 'acc_account:'.$a['id'], $a['name']);
        return ['ok' => true];
    }

    /* ---------------- journals & vouchers */

    private function jFilter(array $qs): array
    {
        $w = [];
        $a = [];
        if (self::isDate($qs['from'] ?? null)) {
            $w[] = 'j.date>=?';
            $a[] = $qs['from'];
        }
        if (self::isDate($qs['to'] ?? null)) {
            $w[] = 'j.date<=?';
            $a[] = $qs['to'];
        }
        $kind = $qs['kind'] ?? null;
        if ($kind === 'manual') {
            $w[] = "j.source='manual'";
        } elseif ($kind === 'auto') {
            $w[] = self::AUTO_SRC;
        } elseif ($kind === 'opening') {
            $w[] = "j.source='opening'";
        } elseif ($kind === 'other') {
            $w[] = "j.source NOT IN ('manual','opening') AND NOT ".self::AUTO_SRC;
        } elseif (is_string($kind) && isset(self::KINDS[$kind])) {
            $w[] = 'j.ref LIKE ?';
            $a[] = $kind.'-%';
        }
        if (($qs['source'] ?? '') !== '' && isset($qs['source'])) {
            $w[] = 'j.source=?';
            $a[] = $qs['source'];
        }
        if (($qs['voided'] ?? null) !== '1') {
            $w[] = 'j.voided=0';
        }
        if (($qs['account'] ?? '') !== '' && isset($qs['account'])) {
            $w[] = 'j.id IN (SELECT journal_id FROM acc_lines WHERE account_id=?)';
            $a[] = $this->mustAcct($qs['account'])['id'];
        }
        if (($qs['q'] ?? '') !== '' && isset($qs['q'])) {
            $t = '%'.trim((string) $qs['q']).'%';
            $w[] = '(j.memo LIKE ? OR j.ref LIKE ? OR j.source_id LIKE ? OR j.id IN (SELECT l.journal_id FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE ac.name LIKE ? OR l.party LIKE ? OR l.memo LIKE ?))';
            array_push($a, $t, $t, $t, $t, $t, $t);
        }
        return ['where' => $w ? 'WHERE '.implode(' AND ', $w) : '', 'args' => $a];
    }

    public function journalsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $f = $this->jFilter($qs);
        if (($qs['csv'] ?? null) === '1') {
            return Db::all("SELECT j.date, j.ref, j.source, j.source_id, j.memo, ac.code, ac.name account, l.party, l.debit, l.credit, l.memo line_memo, CASE WHEN j.voided THEN 'VOID' ELSE '' END status
        FROM acc_journals j JOIN acc_lines l ON l.journal_id=j.id JOIN acc_accounts ac ON ac.id=l.account_id {$f['where']} ORDER BY j.date, j.id, l.id LIMIT 50000", ...$f['args']);
        }
        $pg = $this->page($qs, 50);
        $rows = Db::all("SELECT j.id, j.date, j.ref, j.memo, j.source, j.source_id, j.kind, j.amount, j.voided, j.void_reason, j.file_id, us.name user,
        (SELECT GROUP_CONCAT(DISTINCT ac.name SEPARATOR ' · ') FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=j.id) accounts
        FROM acc_journals j LEFT JOIN users us ON us.id=j.user_id {$f['where']} ORDER BY j.date DESC, j.id DESC LIMIT ? OFFSET ?", ...array_merge($f['args'], [$pg['limit'], $pg['offset']]));
        $t = Db::get("SELECT COUNT(*) n, COALESCE(SUM(j.amount),0) amt FROM acc_journals j {$f['where']}", ...$f['args']);
        return ['rows' => $rows, 'total' => $t['n'], 'amount' => self::r2($t['amt']), 'page' => $pg['page'], 'pages' => (int) ceil($t['n'] / $pg['limit'])];
    }

    public function journalShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $j = Db::get('SELECT j.*, us.name user, vb.name voided_by_name FROM acc_journals j LEFT JOIN users us ON us.id=j.user_id LEFT JOIN users vb ON vb.id=j.voided_by WHERE j.id=?', (int) $p['id']);
        $this->need($j, 'Not found', 404);
        // decode as objects so {} stays {}
        $meta = json_decode((string) ($j['meta'] ?: 'null'));
        if (json_last_error() !== JSON_ERROR_NONE) {
            $meta = null;
        }
        if (is_object($meta)) {
            unset($meta->sig);
        }
        $j['meta'] = $meta;
        $j['lines'] = Db::all('SELECT l.*, ac.name account, ac.code FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=? ORDER BY l.id', $j['id']);
        $j['history'] = Db::all('SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.entity=? ORDER BY e.id DESC LIMIT 30', 'acc:'.$j['id']);
        $L = $this->lockDate();
        $j['locked'] = $L !== '' && $j['date'] <= $L;
        return $j;
    }

    public function voucherSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ex = null;
        if (! empty($b['id'])) {
            $ex = Db::get('SELECT * FROM acc_journals WHERE id=?', (int) $b['id']);
            $this->need($ex && $ex['source'] === 'manual', 'Only manual vouchers can be edited here');
            $this->need(! $ex['voided'], 'This voucher was voided — make a new one');
        }
        $bk = $b['kind'] ?? null;
        $kind = $ex ? $ex['kind'] : ((is_string($bk) && isset(self::KINDS[$bk])) ? $bk : 'JV');
        $memo = trim(is_scalar($b['memo'] ?? null) && ($b['memo'] ?? null) !== false ? (string) $b['memo'] : '');
        $this->need($memo !== '', 'Write what this voucher is for (narration)');
        $old = $ex ? Db::all('SELECT ac.name account, l.debit, l.credit, l.party FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=?', $ex['id']) : null;
        $id = Db::tx(function () use ($ex, $kind, $b, $memo, $u) {
            $ref = $ex ? $ex['ref'] : $this->nextRef($kind);
            return $this->postRaw(['date' => $b['date'] ?? null, 'memo' => $memo, 'source' => 'manual', 'source_id' => $ref, 'ref' => $ref, 'kind' => $kind,
                'file_id' => ($b['file_id'] ?? null) ?: null, 'lines' => $b['lines'] ?? [], 'meta' => ! empty($b['form']) ? ['form' => $b['form']] : null], $u['id']);
        });
        $j = Db::get('SELECT ref, amount FROM acc_journals WHERE id=?', $id);
        $this->log($u['id'], $ex ? 'accounts.voucher.edit' : 'accounts.voucher', 'acc:'.$id, $ex ? ['ref' => $j['ref'], 'amount' => $j['amount'], 'before' => $old] : ['ref' => $j['ref'], 'amount' => $j['amount']]);
        return ['ok' => true, 'id' => $id, 'ref' => $j['ref']];
    }

    public function journalVoid(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $j = Db::get('SELECT * FROM acc_journals WHERE id=?', (int) $p['id']);
        $this->need($j, 'Not found', 404);
        $this->need(in_array($j['source'], ['manual', 'opening'], true), 'This entry comes from "'.$j['source'].'". Change it on that screen instead.');
        $reason = trim(is_scalar($b['reason'] ?? null) && ($b['reason'] ?? null) !== false ? (string) $b['reason'] : '');
        $this->need($reason !== '', 'Give a reason for voiding');
        $this->need($this->voidEntry($j['source'], $j['source_id'], $u['id'], $reason), 'Already voided');
        $this->log($u['id'], 'accounts.voucher.void', 'acc:'.$j['id'], ['ref' => $j['ref'], 'reason' => $b['reason'], 'amount' => $j['amount']]);
        return ['ok' => true];
    }

    /* ---------------- opening balances */

    public function openingGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $j = Db::get("SELECT * FROM acc_journals WHERE source='opening' AND source_id='opening'");
        return ['journal' => $j ?: null, 'start' => $this->startDate(), 'lock' => $this->lockDate(),
            'lines' => $j && ! $j['voided'] ? Db::all('SELECT ac.name account, l.debit, l.credit, l.party FROM acc_lines l JOIN acc_accounts ac ON ac.id=l.account_id WHERE l.journal_id=? ORDER BY ac.code', $j['id']) : []];
    }

    public function openingSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(self::isDate($b['date'] ?? null), 'Choose the opening date');
        $lines = [];
        foreach (is_array($b['lines'] ?? null) ? $b['lines'] : [] as $l) {
            $l = is_array($l) ? $l : [];
            if (! self::n($l['debit'] ?? 0) && ! self::n($l['credit'] ?? 0)) {
                continue;
            }
            $lines[] = ['account' => $l['account'] ?? null, 'debit' => self::n($l['debit'] ?? 0), 'credit' => self::n($l['credit'] ?? 0), 'party' => ($l['party'] ?? null) ?: null];
        }
        if (! empty($b['balance_to'])) {
            $d = self::r2(array_sum(array_map(fn ($l) => $l['debit'] - $l['credit'], $lines)));
            if ($d) {
                $lines[] = ['account' => $b['balance_to'], 'debit' => $d < 0 ? -$d : 0, 'credit' => $d > 0 ? $d : 0, 'memo' => 'Difference'];
            }
        }
        $id = Db::tx(function () use ($b, $lines, $u) {
            $r = $this->postRaw(['date' => $b['date'], 'memo' => 'Opening balances as of '.$b['date'], 'source' => 'opening', 'source_id' => 'opening', 'ref' => 'OB', 'kind' => 'OB', 'lines' => $lines], $u['id']);
            $st = $this->startDate();
            if ($st === '' || $st <= $b['date']) {
                $this->setSetting('accounts_start', self::addDays($b['date'], 1));
            }
            return $r;
        });
        $this->log($u['id'], 'accounts.opening', 'acc:'.$id, ['date' => $b['date'], 'lines' => count($lines)]);
        return ['ok' => true, 'id' => $id, 'start' => $this->startDate()];
    }

    /* ---------------- settings */

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['cfg' => $this->cfg(), 'start' => $this->startDate(), 'lock' => $this->lockDate(), 'courier_fee' => $this->setting('courier_fee', 250), 'return_fee' => $this->setting('return_fee', 150), 'cost_pct' => $this->setting('cost_pct', 35),
            'last' => $this->setting('accounts_autopost_last', null), 'defaults' => self::DEF_CFG];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $nx = $this->cfg();
        $in = is_array($b['cfg'] ?? null) ? $b['cfg'] : [];
        foreach (array_keys(self::DEF_CFG) as $k) {
            if (array_key_exists($k, $in)) {
                $nx[$k] = $in[$k];
            }
        }
        foreach (['bank', 'courier_ar', 'tcs_ar', 'rider_ar', 'sales', 'discount', 'returns', 'cogs', 'inventory', 'unlisted', 'shipping', 'courier_tax', 'purchases', 'payable'] as $k) {
            $nx[$k] = $this->mustAcct($nx[$k])['name'];
        }
        $this->need(in_array($nx['recognise'], ['dispatched', 'delivered'], true), 'Recognise sales on dispatched or delivered');
        $nx['auto'] = $nx['auto'] !== false;
        $nx['fy_month'] = (int) min(12, max(1, self::n($nx['fy_month']) ?: 7));
        if (array_key_exists('start', $b) && $b['start'] !== $this->startDate()) {
            $this->need(! $b['start'] || self::isDate($b['start']), 'Start date must be YYYY-MM-DD');
            $this->need(! $b['start'] || $this->lockDate() === '' || $b['start'] > $this->lockDate(), 'Start date must be after the closed period');
            $this->setSetting('accounts_start', $b['start'] ?: '');
        }
        $this->setSetting('accounts_cfg', $nx);
        $this->resetPending();
        $this->log($u['id'], 'accounts.settings', 'accounts', ['cfg' => $nx, 'start' => $this->startDate()]);
        return ['ok' => true];
    }

    /* ---------------- automatic postings */

    public function autoGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $dry = $this->autoPost(['dry' => true]);
        $limit = (int) min(500, self::n($qs['limit'] ?? null) ?: 120);
        $recent = Db::all('SELECT j.id, j.date, j.source, j.source_id, j.memo, j.amount, j.updated_at, j.created_at FROM acc_journals j WHERE '.self::AUTO_SRC.' AND j.voided=0 ORDER BY j.date DESC, j.source LIMIT ?', $limit);
        return ['start' => $this->startDate(), 'lock' => $this->lockDate(), 'last' => $this->setting('accounts_autopost_last', null), 'pending' => $dry['pending'], 'off' => $dry['off'] ?? null, 'recent' => $recent, 'cfg' => $this->cfg()];
    }

    public function autoRun(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $r = $this->autoPost(['userId' => $u['id']]);
        $this->log($u['id'], 'accounts.autopost', 'accounts', ['posted' => count($r['posted']), 'removed' => $r['removed']]);
        return $r;
    }

    /* ---------------- reports */

    public function ledgerRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(($qs['account'] ?? '') !== '' && isset($qs['account']), 'Choose an account');
        return $this->ledger($qs['account'], self::dOr($qs['from'] ?? null, null), self::dOr($qs['to'] ?? null, null), ($qs['party'] ?? null) ?: null);
    }

    public function partiesRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->parties(($qs['prefix'] ?? null) ?: null, ($qs['account'] ?? null) ?: null, self::dOr($qs['date'] ?? null, null));
    }

    public function trialRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->trial(self::dOr($qs['date'] ?? null, $this->pkToday()), self::dOr($qs['from'] ?? null, null));
    }

    public function pnlRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $mq = $qs['month'] ?? '';
        $m = is_string($mq) && preg_match('/^\d{4}-\d{2}$/', $mq) ? $mq : null;
        $from = $m ? $m.'-01' : self::dOr($qs['from'] ?? null, substr($this->pkToday(), 0, 7).'-01');
        $to = $m ? self::monthEnd($m) : self::dOr($qs['to'] ?? null, $this->pkToday());
        $this->need($from <= $to, 'From date is after To date');
        [$pf, $pt] = $this->prevRange($from, $to);
        return ['cur' => $this->pnl($from, $to), 'prev' => $this->pnl($pf, $pt)];
    }

    public function bsRoute(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->bs(self::dOr($qs['date'] ?? null, $this->pkToday()));
    }

    public function salesRegister(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $from = self::dOr($qs['from'] ?? null, substr($this->pkToday(), 0, 7).'-01');
        $to = self::dOr($qs['to'] ?? null, $this->pkToday());
        $cf = $this->cfg();
        $ids = array_map(fn ($n) => $this->mustAcct($n)['id'], [$cf['sales'], $cf['discount'], $cf['returns']]);
        $rows = Db::all('SELECT j.date, SUM(CASE WHEN l.account_id=? THEN l.credit-l.debit ELSE 0 END) gross, SUM(CASE WHEN l.account_id=? THEN l.debit-l.credit ELSE 0 END) discount,
        SUM(CASE WHEN l.account_id=? THEN l.debit-l.credit ELSE 0 END) returns FROM acc_lines l JOIN acc_journals j ON j.id=l.journal_id WHERE j.voided=0 AND j.date BETWEEN ? AND ? AND l.account_id IN (?,?,?) GROUP BY j.date ORDER BY j.date', ...array_merge($ids, [$from, $to], $ids));
        $rec = ($cf['recognise'] ?? null) === 'delivered' ? 'delivered_at' : 'dispatched_at';
        $cnt = [];
        foreach (Db::all('SELECT '.self::pkd($rec)." d, COUNT(*) n FROM orders WHERE $rec IS NOT NULL AND cancelled_at IS NULL AND status NOT IN ('cancelled','courier_cancelled','cs_cancelled') AND ".self::pkd($rec).' BETWEEN ? AND ? GROUP BY d', $from, $to) as $r) {
            $cnt[(string) $r['d']] = $r['n'];
        }
        $retD = self::pkd('COALESCE(returned_at,return_received_at)');
        $rcnt = [];
        foreach (Db::all("SELECT $retD d, COUNT(*) n FROM orders WHERE status IN ('returning','returned','return_received') AND $rec IS NOT NULL AND cancelled_at IS NULL AND $retD BETWEEN ? AND ? GROUP BY d", $from, $to) as $r) {
            $rcnt[(string) $r['d']] = $r['n'];
        }
        $map = [];
        foreach ($rows as $r) {
            $map[(string) $r['date']] = $r;
        }
        $days = array_unique(array_merge(array_keys($map), array_keys($cnt), array_keys($rcnt)));
        $days = array_map('strval', $days);
        sort($days, SORT_STRING);
        $out = [];
        $tot = [];
        foreach ($days as $d) {
            $r = $map[$d] ?? ['gross' => 0, 'discount' => 0, 'returns' => 0];
            $row = ['date' => $d, 'orders' => $cnt[$d] ?? 0, 'returned' => $rcnt[$d] ?? 0, 'gross' => self::r2($r['gross']), 'discount' => self::r2($r['discount']), 'returns' => self::r2($r['returns']), 'net' => self::r2($r['gross'] - $r['discount'] - $r['returns'])];
            $out[] = $row;
            foreach (['orders', 'returned', 'gross', 'discount', 'returns', 'net'] as $k) {
                $tot[$k] = self::r2(($tot[$k] ?? 0) + $row[$k]);
            }
        }
        return ['from' => $from, 'to' => $to, 'basis' => $cf['recognise'], 'rows' => $out, 'total' => $tot ?: (object) []];
    }

    public function overview(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $today = $this->pkToday();
        $cf = $this->cfg();
        $all = $this->sums(null, $today);
        $months = [];
        $y = (int) substr($today, 0, 4);
        $mo = (int) substr($today, 5, 2);
        for ($i = 5; $i >= 0; $i--) {
            $d = gmdate('Y-m', gmmktime(0, 0, 0, $mo - $i, 1, $y));
            $pp = $this->pnl($d.'-01', $d === substr($today, 0, 7) ? $today : self::monthEnd($d));
            $months[] = ['month' => $d, 'sales' => $pp['netSales'], 'gross' => $pp['gross'], 'net' => $pp['net']];
        }
        $sup = array_values(array_filter($this->parties('vendor:', $cf['payable'], $today), fn ($x) => abs($x['amount']) >= 1));
        usort($sup, fn ($a, $b) => $b['amount'] <=> $a['amount']);
        $cash = [];
        foreach ($all as $a) {
            if ($a['grp'] === 'cash' && $a['type'] === 'asset') {
                $cash[] = ['name' => $a['name'], 'balance' => $a['bal']];
            }
        }
        return ['today' => $today, 'start' => $this->startDate(), 'lock' => $this->lockDate(), 'last' => $this->setting('accounts_autopost_last', null), 'cash' => $cash,
            'postex' => $this->balance($cf['courier_ar'], $today), 'payables' => self::r2(array_sum(array_column($sup, 'amount'))), 'suppliers' => array_slice($sup, 0, 6), 'mtd' => $this->pnl(substr($today, 0, 7).'-01', $today), 'months' => $months,
            'alerts' => $this->alerts($u ?? []), 'empty' => ! Db::get('SELECT id FROM acc_journals WHERE voided=0 LIMIT 1')];
    }

    /* ---------------- month close */

    public function closeGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $mq = $qs['month'] ?? '';
        $m = is_string($mq) && preg_match('/^\d{4}-\d{2}$/', $mq) ? $mq : substr(self::addDays(substr($this->pkToday(), 0, 7).'-01', -1), 0, 7);
        $hist = Db::all("SELECT e.at, e.action, e.detail, us.name user FROM events e LEFT JOIN users us ON us.id=e.user_id WHERE e.action IN ('accounts.close','accounts.reopen') ORDER BY e.id DESC LIMIT 20");
        return array_merge($this->checks($m), ['lock' => $this->lockDate(), 'start' => $this->startDate(), 'history' => $hist, 'canReopen' => self::isAdmin($u)]);
    }

    public function closeMonth(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $month = $b['month'] ?? '';
        $this->need(is_string($month) && preg_match('/^\d{4}-\d{2}$/', $month), 'Choose a month');
        $end = self::monthEnd($month);
        $this->need($end < $this->pkToday(), 'You can close a month only after it has ended');
        $this->need($this->lockDate() === '' || $this->lockDate() < $end, "$month is already closed");
        if ($this->startDate() !== '' && $this->cfg()['auto']) {
            $this->autoPost(['to' => $end, 'userId' => $u['id']]);
        }
        $ch = $this->checks($month);
        $this->need(! $ch['fails'] || ! empty($b['force']), "{$ch['fails']} check(s) failed. Fix them, or close anyway with a reason.");
        $this->setSetting('accounts_lock_date', $end);
        $this->resetPending();
        $this->log($u['id'], 'accounts.close', 'accounts:'.$month, ['month' => $month, 'lock' => $end, 'fails' => $ch['fails'], 'warns' => $ch['warns'], 'note' => ($b['note'] ?? null) ?: null]);
        return ['ok' => true, 'lock' => $end];
    }

    public function reopenMonth(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(self::isAdmin($u), 'Only the owner can reopen a closed month', 403);
        $month = $b['month'] ?? '';
        $this->need(is_string($month) && preg_match('/^\d{4}-\d{2}$/', $month), 'Choose a month');
        $reason = trim(is_scalar($b['reason'] ?? null) && ($b['reason'] ?? null) !== false ? (string) $b['reason'] : '');
        $this->need(mb_strlen($reason) >= 4, 'Write the reason for reopening');
        $L = $this->lockDate();
        $start = $month.'-01';
        $this->need($L !== '' && $L >= $start, "$month is not closed");
        $nl = self::addDays($start, -1);
        $this->setSetting('accounts_lock_date', $nl);
        $this->resetPending();
        $this->log($u['id'], 'accounts.reopen', 'accounts:'.$month, ['month' => $month, 'from' => $L, 'to' => $nl, 'reason' => $reason]);
        return ['ok' => true, 'lock' => $nl];
    }

    /* ---------------- jobs / badges / alerts */

    public function jobs(): array
    {
        return [['name' => 'autopost', 'every' => 60, 'offset' => 7, 'run' => function () {
            if ($this->startDate() !== '' && $this->cfg()['auto']) {
                $this->autoPost([]);
            }
        }]];
    }

    public function counts(array $u): array
    {
        return $this->can($u, 'accounts_post') && $this->startDate() !== '' ? ['close' => $this->pendingCount()] : [];
    }

    public function alerts(array $u): array
    {
        if (! $this->can($u, 'accounts')) {
            return [];
        }
        $out = [];
        $today = $this->pkToday();
        $start = $this->startDate();
        if ($start === '') {
            return [['level' => 'info', 'text' => 'Accounts: enter opening balances and a start date so the books fill themselves.', 'href' => '#/close/opening']];
        }
        $n = $this->pendingCount();
        if ($n) {
            $out[] = ['level' => 'warn', 'text' => "Accounts: $n automatic entries are not posted yet", 'href' => '#/close/auto'];
        }
        $prev = self::addDays(substr($today, 0, 7).'-01', -1);
        $pm = substr($prev, 0, 7);
        $L = $this->lockDate();
        if ((int) substr($today, 8) > 10 && $L < $prev && $start <= $prev) {
            $out[] = ['level' => 'warn', 'text' => "Accounts: $pm is not closed yet", 'href' => '#/close/checks/'.$pm];
        }
        $fails = Cache::remember(self::CACHE_FAILS, 1800, function () use ($pm) {
            try {
                $ch = $this->checks($pm);
                return array_values(array_map(fn ($x) => $x['title'], array_filter($ch['checks'], fn ($x) => $x['status'] === 'fail')));
            } catch (\Throwable) {
                return [];
            }
        });
        if ($L < $prev && $fails) {
            $out[] = ['level' => 'bad', 'text' => "Accounts $pm: failing check — ".implode(', ', $fails), 'href' => '#/close/checks/'.$pm];
        }
        return $out;
    }

    public function activity(): array
    {
        return ['accounts.voucher' => 'Posted voucher', 'accounts.voucher.edit' => 'Edited voucher', 'accounts.voucher.void' => 'Voided voucher', 'accounts.opening' => 'Saved opening balances', 'accounts.autopost' => 'Posted automatic entries',
            'accounts.close' => 'Closed accounting month', 'accounts.reopen' => 'Reopened accounting month', 'accounts.settings' => 'Changed accounts settings', 'accounts.account' => 'Saved account', 'accounts.account.delete' => 'Deleted account'];
    }
}
