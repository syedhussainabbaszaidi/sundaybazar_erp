<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;

/**
 * Port of legacy/server/modules/expenses.js — Expenses & petty cash: staff claims with receipts, approvals (posted to accounts),
 * petty cash boxes, cash counts, recurring bills, reports.
 */
class ExpensesModule extends Module
{
    public string $name = 'expenses';

    private const PAY = ['petty' => 'Petty cash', 'own' => 'My own money (to be reimbursed)', 'bank' => 'Bank (Meezan)', 'card' => 'Company card', 'accrued' => 'Pay later (accrued bill)'];
    private const CATS = [
        ['Grocery & pantry', 'Grocery & Pantry'], ['Staff food', 'Food Allowance'], ['Conveyance (rickshaw, fuel)', 'Conveyance'], ['Electricity, gas & water', 'Utility Expenses'],
        ['Internet & mobile package', 'Internet & Mobile Package'], ['Repair & maintenance', 'Repair & Maintenance'], ['Packaging material', 'Packaging'], ['Office rent', 'Office Rent'],
        ['Outlet rent', 'Outlet Rent'], ['Outlet expenses', 'Outlet Expenses'], ['IT & computer', 'I.T Expenses'], ['Apps & subscriptions', 'Apps & Subscription Charges'],
        ['Shopify charges', 'Shopify Charges'], ['Other marketing', 'Other Marketing'], ['Guests & entertainment', 'Entertainment'], ['Donation', 'Donation'],
        ['Bank charges', 'Bank Charges'], ['QC expenses', 'QC Expenses'], ['Courier (not PostEx)', 'Shipping Exp'], ['Staff gifts', 'Incentives/Gifts'], ['Stationery & other', 'Miscellenious Exp'],
    ];
    private const ACCOUNTS = ['Grocery & Pantry', 'Food Allowance', 'Conveyance', 'Utility Expenses', 'Internet & Mobile Package', 'Repair & Maintenance', 'Packaging', 'Office Rent', 'Outlet Rent',
        'Outlet Expenses', 'I.T Expenses', 'Apps & Subscription Charges', 'Shopify Charges', 'Other Marketing', 'Entertainment', 'Donation', 'Bank Charges', 'QC Expenses',
        'Shipping Exp', 'Incentives/Gifts', 'Commission', 'Legal Fees', 'Miscellenious Exp', 'Office Equipments', 'Outlet Equipments', 'Office Furniture', 'Outlet Furniture',
        'Employees Advance', 'Prepaid Rent'];

    private const CLAIM_SQL = "SELECT c.*, us.name `user`, ap.name approver, b.name box, p.status post_status, p.error post_error FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id
      LEFT JOIN users ap ON ap.id=c.approved_by LEFT JOIN exp_boxes b ON b.id=c.box_id LEFT JOIN exp_postings p ON p.source='expense' AND p.source_id=CAST(c.id AS CHAR)";

    public function perms(): array
    {
        return [];
    }

    /** migrate(ctx) seeding: default categories, two petty cash boxes, inactive recurring bill templates (idempotent). */
    public function install(): void
    {
        if (! Db::get('SELECT id FROM exp_categories LIMIT 1')) {
            foreach (self::CATS as $i => [$n, $a]) {
                Db::run('INSERT INTO exp_categories(name,account,sort) VALUES(?,?,?)', $n, $a, $i);
            }
        }
        if (! Db::get('SELECT id FROM exp_boxes LIMIT 1')) {
            Db::run("INSERT INTO exp_boxes(name,low) VALUES('Office',5000)");
            Db::run("INSERT INTO exp_boxes(name,low) VALUES('Outlet',3000)");
        }
        if (! Db::get('SELECT id FROM exp_recurring LIMIT 1')) {
            $cat = fn ($a) => Db::val('SELECT id FROM exp_categories WHERE account=? ORDER BY sort LIMIT 1', $a) ?: null;
            foreach ([['Office rent', 'Office Rent', 'bank', 1], ['Outlet rent', 'Outlet Rent', 'bank', 1], ['Internet', 'Internet & Mobile Package', 'bank', 5],
                ['Electricity (estimate)', 'Utility Expenses', 'accrued', 25], ['Shopify subscription', 'Shopify Charges', 'card', 10]] as [$n, $a, $pf, $dom]) {
                Db::run('INSERT INTO exp_recurring(name,category_id,amount,dom,paid_from,active) VALUES(?,?,?,?,?,0)', $n, $cat($a), 0, $dom, $pf);
            }
        }
    }

    public function routes(Router $r): void
    {
        $r->get('/api/exp/meta', 'expenses', 'meta');
        $r->post('/api/exp/claims', 'expenses', 'claimSubmit');
        $r->post('/api/exp/claims/:id', 'expenses', 'claimEdit');
        $r->delete('/api/exp/claims/:id', 'expenses', 'claimDelete');
        $r->get('/api/exp/claims/:id', 'expenses', 'claimGet');
        $r->get('/api/exp/mine', 'expenses', 'mine');
        $r->get('/api/exp/claims', 'expenses_approve', 'claimsList');
        $r->post('/api/exp/approve', 'expenses_approve', 'approve');
        $r->post('/api/exp/reject', 'expenses_approve', 'reject');
        $r->post('/api/exp/reopen', 'expenses_approve', 'reopen');
        $r->get('/api/exp/owed', 'expenses_approve', 'owed');
        $r->post('/api/exp/reimburse', 'expenses_approve', 'reimburse');
        $r->get('/api/exp/categories', 'expenses_approve', 'categories');
        $r->post('/api/exp/categories', 'expenses_approve', 'categorySave');
        $r->get('/api/exp/boxes', 'expenses', 'boxes');
        $r->post('/api/exp/boxes', 'expenses_approve', 'boxSave');
        $r->get('/api/exp/users', 'expenses_approve', 'users');
        $r->get('/api/exp/boxes/:id/register', 'expenses', 'register');
        $r->post('/api/exp/boxes/:id/topup', 'expenses_approve', 'topup');
        $r->post('/api/exp/boxes/:id/count', 'expenses', 'count');
        $r->post('/api/exp/counts/:id/:act', 'expenses_approve', 'countSettle');
        $r->get('/api/exp/recurring', 'expenses_approve', 'recurringList');
        $r->post('/api/exp/recurring', 'expenses_approve', 'recurringSave');
        $r->delete('/api/exp/recurring/:id', 'expenses_approve', 'recurringDelete');
        $r->post('/api/exp/recurring/run', 'expenses_approve', 'recurringRun');
        $r->get('/api/exp/postings', 'expenses_approve', 'postings');
        $r->post('/api/exp/postings/retry', 'expenses_approve', 'postingsRetry');
        $r->get('/api/exp/report', 'expenses_approve', 'report');
        $r->get('/api/exp/export', 'expenses_approve', 'export');
        $r->get('/api/exp/older', 'expenses_approve', 'older');
        $r->get('/api/exp/settings', 'expenses_approve', 'settingsGet');
        $r->post('/api/exp/settings', 'expenses_approve', 'settingsSave');
    }

    /* ------------------------------------------------------------ JS-like helpers */

    private static function tr($v): bool
    {
        return ! ($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0 || (is_float($v) && is_nan($v)));
    }

    /** JS unary plus / Number() */
    private static function num($v): int|float
    {
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if ($v === null || $v === false) {
            return 0;
        }
        if ($v === true) {
            return 1;
        }
        if (is_string($v)) {
            $s = trim($v);
            if ($s === '') {
                return 0;
            }
            return is_numeric($s) ? $s + 0 : NAN;
        }
        if (is_array($v) && ! $v) {
            return 0;
        }
        return NAN;
    }

    private static function str($v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v)) {
            if (is_nan($v)) {
                return 'NaN';
            }
            return floor($v) == $v && abs($v) < 1e15 ? (string) (int) $v : (string) $v;
        }
        if (is_array($v)) {
            return array_is_list($v) ? implode(',', array_map(fn ($x) => is_array($x) ? '[object Object]' : ($x === null ? '' : self::str($x)), $v)) : '[object Object]';
        }
        return (string) $v;
    }

    /** r2 = v => Math.round((+v || 0) * 100) / 100 */
    private static function r2($v): int|float
    {
        $n = self::num($v);
        if (! self::tr($n)) {
            $n = 0;
        }
        return Logic::jsRound($n * 100) / 100;
    }

    private static function isDay($s): bool
    {
        return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) === 1;
    }

    private static function monthsBack(string $m, int $n): string
    {
        [$y, $mo] = array_map('intval', explode('-', $m));
        return gmdate('Y-m', gmmktime(0, 0, 0, $mo - $n, 1, $y));
    }

    private static function lastDom(string $m): int
    {
        [$y, $mo] = array_map('intval', explode('-', $m));
        return (int) gmdate('j', gmmktime(0, 0, 0, $mo + 1, 0, $y));
    }

    /** Number.prototype.toLocaleString('en-PK') */
    private static function loc($n): string
    {
        $n = self::num($n);
        if (is_int($n) || floor($n) == $n) {
            return number_format($n, 0, '.', ',');
        }
        return rtrim(rtrim(number_format($n, 3, '.', ','), '0'), '.');
    }

    /** IDs from b.ids (array) or b.id: (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter(Boolean) */
    private static function ids(array $b): array
    {
        $l = is_array($b['ids'] ?? null) ? $b['ids'] : [array_key_exists('id', $b) ? $b['id'] : NAN];
        return array_values(array_filter(array_map(fn ($x) => self::num($x), $l), fn ($x) => self::tr($x)));
    }

    /* ------------------------------------------------------------ shared helpers */

    private function limit(): int|float
    {
        return self::num($this->setting('expenses_receipt_limit', 2000));
    }

    private function cardAcc()
    {
        return $this->setting('expenses_card_account', 'Meezan (SB)');
    }

    private function waitDays(): int|float
    {
        return self::num($this->setting('expenses_wait_days', 2));
    }

    private function isApprover(?array $u): bool
    {
        return $this->can($u, 'expenses_approve');
    }

    private function myBoxes(array $u): array
    {
        return array_map(fn ($b) => $b['id'], Db::all('SELECT id FROM exp_boxes WHERE custodian=? AND active=1', $u['id']));
    }

    private function boxBal($id): int|float
    {
        return self::r2(Db::val('SELECT COALESCE(SUM(amount),0) s FROM exp_box_moves WHERE box_id=?', $id));
    }

    private function boxPending($id): int|float
    {
        return self::r2(Db::val("SELECT COALESCE(SUM(amount),0) s FROM exp_claims WHERE box_id=? AND paid_from='petty' AND status='pending'", $id));
    }

    private function canBox(array $u, $id): bool
    {
        return $this->isApprover($u) || in_array((int) self::num($id), $this->myBoxes($u), true);
    }

    private function claim($id): ?array
    {
        return Db::get(self::CLAIM_SQL.' WHERE c.id=?', self::num($id));
    }

    private function accounts(): ?Module
    {
        return $this->svc('accounts');
    }

    /* ---------- posting to accounts (or queue it when the accounts module is not there yet) ---------- */
    private function postEntry(string $source, $sid, array $entry, $uid): string
    {
        $sid = self::str($sid);
        Db::run("INSERT INTO exp_postings(source,source_id,entry,status,user_id) VALUES(?,?,?,'pending',?) ON DUPLICATE KEY UPDATE entry=VALUES(entry), status='pending', error=NULL, user_id=VALUES(user_id)",
            $source, $sid, json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $uid ?: null);
        return $this->tryPost(Db::get('SELECT * FROM exp_postings WHERE source=? AND source_id=?', $source, $sid));
    }

    private function tryPost(array $row): string
    {
        $A = $this->accounts();
        if (! $A || ! method_exists($A, 'post')) {
            return 'pending';
        }
        try {
            $e = json_decode((string) $row['entry'], true, 512, JSON_THROW_ON_ERROR);
            $L = (method_exists($A, 'lockDate') ? $A->lockDate() : null) ?: '';
            // a claim dated in a month that is already closed is booked on the first open day (the narration keeps the real date)
            if ($L && strcmp((string) $e['date'], (string) $L) <= 0) {
                $d = gmdate('Y-m-d', strtotime($L.'T00:00:00Z') + 86400);
                $e['memo'] = "{$e['memo']} (dated {$e['date']}, booked after month close)";
                $e['date'] = $d > $this->pkToday() ? $this->pkToday() : $d;
            }
            $jid = $A->post(array_merge($e, ['source' => $row['source'], 'source_id' => $row['source_id']]), $row['user_id']);
            Db::run("UPDATE exp_postings SET status='posted', error=NULL, journal_id=?, tries=tries+1 WHERE id=?", $jid === null ? null : self::str($jid), $row['id']);
            return 'posted';
        } catch (\Throwable $e) {
            Db::run("UPDATE exp_postings SET status='error', error=?, tries=tries+1 WHERE id=?", mb_substr($e->getMessage() ?: get_class($e), 0, 300), $row['id']);
            return 'error';
        }
    }

    private function unpost(string $source, $sid, $uid): void
    {
        $sid = self::str($sid);
        $row = Db::get('SELECT * FROM exp_postings WHERE source=? AND source_id=?', $source, $sid);
        if (! $row) {
            return;
        }
        $A = $this->accounts();
        if ($row['status'] === 'posted' && $A && method_exists($A, 'void')) {
            $A->void($source, $sid, $uid); // throws e.g. for a closed month → caller shows the error
        }
        Db::run('DELETE FROM exp_postings WHERE id=?', $row['id']);
    }

    private function retryAll(): int
    {
        $n = 0;
        foreach (Db::all("SELECT * FROM exp_postings WHERE status IN ('pending','error') ORDER BY id LIMIT 500") as $row) {
            if ($this->tryPost($row) === 'posted') {
                $n++;
            }
        }
        return $n;
    }

    // staff sub-ledger party, same convention as HR/payroll: employee:<hr employee id>; staff not set up in HR yet: employee:u<user id>
    private function staffParty($uid): string
    {
        $e = null;
        try {
            $e = Db::get("SELECT id FROM hr_employees WHERE user_id=? ORDER BY (status='active') DESC, id DESC LIMIT 1", $uid);
        } catch (\Throwable) {
        }
        return 'employee:'.($e ? $e['id'] : 'u'.self::str($uid));
    }

    // the party the claim was booked to (so the reimbursement clears the same sub-ledger even if HR was set up in between)
    private function claimParty(array $c): string
    {
        $row = Db::get("SELECT entry FROM exp_postings WHERE source='expense' AND source_id=?", (string) $c['id']);
        $e = $row ? json_decode((string) $row['entry'], true) : null;
        foreach ((is_array($e) && is_array($e['lines'] ?? null)) ? $e['lines'] : [] as $l) {
            if (($l['account'] ?? null) === 'Accrued Expenses' && self::tr($l['party'] ?? null)) {
                return $l['party'];
            }
        }
        return $this->staffParty($c['user_id']);
    }

    private function crFor(array $c): array
    {
        return match ($c['paid_from']) {
            'petty' => ['account' => 'Petty Cash'],
            'own' => ['account' => 'Accrued Expenses', 'party' => $this->staffParty($c['user_id'])],
            'card' => ['account' => $this->cardAcc()],
            'accrued' => self::tr($c['vendor']) ? ['account' => 'Accrued Expenses', 'party' => 'vendor:'.$c['vendor']] : ['account' => 'Accrued Expenses'],
            default => ['account' => 'Meezan (SB)'],
        };
    }

    private function claimEntry(array $c): array
    {
        $cr = $this->crFor($c);
        $memo = implode(' · ', array_values(array_filter([$c['category'], $c['vendor'], ($c['user'] ?? null) ?: ($c['recurring_id'] ? 'recurring' : '')], fn ($x) => self::tr($x))));
        return ['date' => $c['day'], 'memo' => 'Expense #'.$c['id'].': '.$memo.(self::tr($c['note']) ? ' — '.$c['note'] : ''),
            'lines' => [['account' => $c['account'], 'debit' => $c['amount']], array_merge($cr, ['credit' => $c['amount']])]];
    }

    /* ---------- meta ---------- */
    public function meta(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $A = $this->accounts();
        $pay = self::PAY;
        unset($pay['accrued']);
        return [
            'categories' => Db::all('SELECT id,name,account FROM exp_categories WHERE active=1 ORDER BY sort,name'),
            'boxes' => Db::all('SELECT b.id,b.name,b.custodian,us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian WHERE b.active=1 ORDER BY b.id'),
            'pay' => $pay, 'payAll' => self::PAY, 'accounts' => self::ACCOUNTS, 'limit' => $this->limit(), 'today' => $this->pkToday(),
            'approver' => $this->isApprover($u), 'myBoxes' => $this->myBoxes($u), 'accountsLive' => (bool) ($A && method_exists($A, 'post')),
        ];
    }

    /* ---------- staff: submit + my claims ---------- */
    private function validate(array $b, array $u, ?array $old = null): array
    {
        $this->need(self::isDay($b['day'] ?? null), 'Pick a date');
        $this->need($b['day'] <= $this->pkToday(), 'Date cannot be in the future');
        $amt = self::r2($b['amount'] ?? null);
        $this->need($amt > 0, 'Enter the amount');
        $this->need($amt < 1e7, 'Amount looks too big');
        $cat = Db::get('SELECT * FROM exp_categories WHERE id=?', self::num($b['category_id'] ?? null));
        $this->need($cat, 'Pick a category');
        $pf = $b['paid_from'] ?? null;
        $this->need(is_string($pf) && isset(self::PAY[$pf]) && $pf !== 'accrued', 'Choose how it was paid');
        $receipt = self::tr($b['receipt'] ?? null) ? $b['receipt'] : ((($old['receipt'] ?? null) ?: null));
        $this->need(self::tr($receipt) || $amt <= $this->limit(), 'Please attach a photo of the receipt (needed above Rs '.self::loc($this->limit()).')');
        $box = null;
        if ($pf === 'petty') {
            $boxes = array_map(fn ($x) => $x['id'], Db::all('SELECT id FROM exp_boxes WHERE active=1 ORDER BY id'));
            $bid = self::num($b['box_id'] ?? null);
            $box = self::tr($bid) ? $bid : ($this->myBoxes($u)[0] ?? ($boxes[0] ?? null));
            $this->need($box !== null && in_array($box, $boxes, false) && (float) $box == (int) $box, 'Pick the cash box');
            $box = (int) $box;
        }
        return ['day' => $b['day'], 'category_id' => $cat['id'], 'category' => $cat['name'], 'account' => $cat['account'], 'amount' => $amt, 'paid_from' => $pf, 'box_id' => $box,
            'vendor' => mb_substr(trim(self::tr($b['vendor'] ?? null) ? self::str($b['vendor']) : ''), 0, 80), 'note' => mb_substr(trim(self::tr($b['note'] ?? null) ? self::str($b['note']) : ''), 0, 300),
            'receipt' => is_array($receipt) ? json_encode($receipt) : $receipt];
    }

    public function claimSubmit(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $v = $this->validate($b, $u);
        $r = Db::run('INSERT INTO exp_claims(day,category_id,category,account,amount,paid_from,box_id,vendor,note,receipt,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            $v['day'], $v['category_id'], $v['category'], $v['account'], $v['amount'], $v['paid_from'], $v['box_id'], $v['vendor'], $v['note'], $v['receipt'], $u['id']);
        $this->log($u['id'], 'exp.submit', 'expense:'.$r->lastInsertRowid, ['amount' => $v['amount'], 'category' => $v['category'], 'paid_from' => $v['paid_from']]);
        return $this->claim($r->lastInsertRowid);
    }

    public function claimEdit(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $c = $this->claim($p['id']);
        $this->need($c, 'Not found', 404);
        $this->need($c['user_id'] === $u['id'] || $this->isApprover($u), 'Not your claim', 403);
        $this->need($c['status'] !== 'approved', 'Already approved — ask an approver to reopen it');
        $v = $this->validate($b, $u, $c);
        Db::run("UPDATE exp_claims SET day=?,category_id=?,category=?,account=?,amount=?,paid_from=?,box_id=?,vendor=?,note=?,receipt=?,status='pending',reason=NULL WHERE id=?",
            $v['day'], $v['category_id'], $v['category'], $v['account'], $v['amount'], $v['paid_from'], $v['box_id'], $v['vendor'], $v['note'], $v['receipt'], $c['id']);
        $this->log($u['id'], 'exp.edit', 'expense:'.$c['id'], ['amount' => $v['amount']]);
        return $this->claim($c['id']);
    }

    public function claimDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->claim($p['id']);
        $this->need($c, 'Not found', 404);
        $this->need($c['user_id'] === $u['id'] || $this->isApprover($u), 'Not your claim', 403);
        $this->need($c['status'] !== 'approved', 'Approved claims cannot be deleted');
        Db::run('DELETE FROM exp_claims WHERE id=?', $c['id']);
        $this->log($u['id'], 'exp.delete', 'expense:'.$c['id'], ['amount' => $c['amount'], 'category' => $c['category']]);
        return ['ok' => true];
    }

    public function claimGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->claim($p['id']);
        $this->need($c, 'Not found', 404);
        $this->need($c['user_id'] === $u['id'] || $this->isApprover($u), 'Not your claim', 403);
        return $c;
    }

    public function mine(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $lim = self::num($qs['limit'] ?? null);
        $lim = min(500, self::tr($lim) ? $lim : 100);
        $rows = Db::all(self::CLAIM_SQL.' WHERE c.user_id=? ORDER BY c.day DESC, c.id DESC LIMIT ?', $u['id'], max(0, (int) $lim));
        $t = Db::get("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COALESCE(SUM(CASE WHEN status='approved' AND paid_from='own' AND reimbursed=0 THEN amount END),0) owed,
        COALESCE(SUM(CASE WHEN status!='rejected' AND SUBSTR(day,1,7)=? THEN amount END),0) month FROM exp_claims WHERE user_id=?", substr($this->pkToday(), 0, 7), $u['id']);
        return ['rows' => $rows, 'totals' => $t, 'limit' => $this->limit()];
    }

    /* ---------- approvals ---------- */
    public function claimsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = [];
        $a = [];
        $status = $qs['status'] ?? null;
        if ($status === 'owed') {
            $w[] = "c.status='approved' AND c.paid_from='own' AND c.reimbursed=0";
        } elseif (self::tr($status)) {
            $w[] = 'c.status=?';
            $a[] = $status;
        }
        if (self::tr($qs['month'] ?? null)) {
            $w[] = 'SUBSTR(c.day,1,7)=?';
            $a[] = $qs['month'];
        }
        if (self::tr($qs['user'] ?? null)) {
            $w[] = 'c.user_id=?';
            $a[] = self::num($qs['user']);
        }
        if (self::tr($qs['category'] ?? null)) {
            $w[] = 'c.category=?';
            $a[] = $qs['category'];
        }
        if (self::tr($qs['q'] ?? null)) {
            $w[] = '(c.vendor LIKE ? OR c.note LIKE ? OR c.category LIKE ?)';
            $s = '%'.self::str($qs['q']).'%';
            array_push($a, $s, $s, $s);
        }
        $where = $w ? ' WHERE '.implode(' AND ', $w) : '';
        $pg = $this->page($qs, 100);
        $rows = Db::all(self::CLAIM_SQL.$where.' ORDER BY '.($status === 'pending' ? 'c.day, c.id' : 'c.day DESC, c.id DESC').' LIMIT ? OFFSET ?', ...[...$a, $pg['limit'], $pg['offset']]);
        $t = Db::get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims c'.$where, ...$a);
        return ['rows' => $rows, 'total' => $t['n'], 'amount' => self::r2($t['s']), 'page' => $pg['page'], 'pages' => (int) ceil($t['n'] / $pg['limit'])];
    }

    public function approve(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = self::ids($b);
        $this->need(count($ids), 'Nothing selected');
        $out = ['approved' => 0, 'posted' => 0, 'pending' => 0, 'errors' => [], 'skipped' => []];
        foreach ($ids as $id) {
            $c = $this->claim($id);
            if (! $c || $c['status'] === 'approved') {
                $out['skipped'][] = $id;
                continue;
            }
            if ($c['user_id'] === $u['id'] && $u['role'] !== 'admin') {
                $out['skipped'][] = $id;
                $out['errors'][] = '#'.self::str($id).': you cannot approve your own claim';
                continue;
            }
            Db::tx(function () use ($u, $id, $c) {
                Db::run("UPDATE exp_claims SET status='approved', reason=NULL, approved_by=?, approved_at=UTC_TIMESTAMP() WHERE id=?", $u['id'], $id);
                if ($c['paid_from'] === 'petty' && $c['box_id']) {
                    Db::run("DELETE FROM exp_box_moves WHERE src='claim' AND ref=?", self::str($id));
                    Db::run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'expense',?,?,?,'claim',?)", $c['box_id'], $c['day'], -$c['amount'], self::str($id),
                        implode(' · ', array_values(array_filter([$c['category'], $c['vendor']], fn ($x) => self::tr($x)))), $c['user_id']);
                }
            });
            $out['approved']++;
            $this->log($u['id'], 'exp.approve', 'expense:'.self::str($id), ['amount' => $c['amount'], 'category' => $c['category']]);
            $st = $this->postEntry('expense', $id, $this->claimEntry($this->claim($id)), $u['id']);
            if ($st === 'posted') {
                $out['posted']++;
            } else {
                $out['pending']++;
                if ($st === 'error') {
                    $out['errors'][] = '#'.self::str($id).': '.Db::val("SELECT error FROM exp_postings WHERE source='expense' AND source_id=?", self::str($id));
                }
            }
        }
        return $out;
    }

    public function reject(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = self::ids($b);
        $this->need(count($ids), 'Nothing selected');
        $reason = trim(self::tr($b['reason'] ?? null) ? self::str($b['reason']) : '');
        $this->need($reason !== '', 'Write a reason so the staff member knows what to fix');
        $n = 0;
        foreach ($ids as $id) {
            $c = $this->claim($id);
            if (! $c || $c['status'] !== 'pending') {
                continue;
            }
            Db::run("UPDATE exp_claims SET status='rejected', reason=?, approved_by=?, approved_at=UTC_TIMESTAMP() WHERE id=?", mb_substr($reason, 0, 300), $u['id'], $id);
            $n++;
            $this->log($u['id'], 'exp.reject', 'expense:'.self::str($id), ['amount' => $c['amount'], 'reason' => $reason]);
        }
        return ['rejected' => $n];
    }

    public function reopen(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $c = $this->claim($b['id'] ?? null);
        $this->need($c, 'Not found', 404);
        $this->need($c['status'] !== 'pending', 'Already waiting');
        $this->need(! $c['reimbursed'], 'Already reimbursed — cannot reopen');
        if ($c['status'] === 'approved') {
            $this->unpost('expense', $c['id'], $u['id']);
        }
        Db::run("DELETE FROM exp_box_moves WHERE src='claim' AND ref=?", (string) $c['id']);
        Db::run("UPDATE exp_claims SET status='pending', reason=NULL, approved_by=NULL, approved_at=NULL WHERE id=?", $c['id']);
        $this->log($u['id'], 'exp.reopen', 'expense:'.$c['id'], ['amount' => $c['amount']]);
        return $this->claim($c['id']);
    }

    // reimburse own-money claims: Dr Accrued Expenses (employee) / Cr Cash, Meezan or a petty box
    public function owed(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $rows = Db::all("SELECT c.user_id, us.name `user`, COUNT(*) n, SUM(c.amount) amount, GROUP_CONCAT(c.id) ids FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id
      WHERE c.status='approved' AND c.paid_from='own' AND c.reimbursed=0 GROUP BY c.user_id ORDER BY amount DESC");
        return array_map(fn ($r) => array_merge($r, ['ids' => array_map(fn ($x) => self::num($x), explode(',', self::str($r['ids'])))]), $rows);
    }

    public function reimburse(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = self::ids($b);
        $this->need(count($ids), 'Nothing selected');
        $from = self::tr($b['from'] ?? null) ? self::str($b['from']) : 'Cash';
        $box = null;
        $acc = $from;
        if (str_starts_with($from, 'petty:')) {
            $box = Db::get('SELECT * FROM exp_boxes WHERE id=?', self::num(substr($from, 6)));
            $this->need($box, 'Unknown cash box');
            $acc = 'Petty Cash';
        } else {
            $this->need(in_array($from, ['Cash', 'Meezan (SB)'], true), 'Pay from Cash, Meezan or a petty cash box');
        }
        $dayv = self::isDay($b['day'] ?? null) ? $b['day'] : $this->pkToday();
        $out = ['reimbursed' => 0, 'amount' => 0, 'posted' => 0, 'pending' => 0];
        foreach ($ids as $id) {
            $c = $this->claim($id);
            if (! $c || $c['status'] !== 'approved' || $c['paid_from'] !== 'own' || $c['reimbursed']) {
                continue;
            }
            Db::run('UPDATE exp_claims SET reimbursed=1, reimbursed_at=?, reimbursed_by=?, reimb_from=? WHERE id=?', $dayv, $u['id'], $from, $id);
            if ($box) {
                Db::run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'reimburse',?,?,?,'reimb',?)", $box['id'], $dayv, -$c['amount'], self::str($id), 'Paid back to '.(($c['user'] ?? null) ?: 'staff'), $u['id']);
            }
            $st = $this->postEntry('expense_reimb', $id, ['date' => $dayv, 'memo' => 'Reimbursed expense #'.self::str($id).' to '.(($c['user'] ?? null) ?: 'staff'),
                'lines' => [['account' => 'Accrued Expenses', 'debit' => $c['amount'], 'party' => $this->claimParty($c)], ['account' => $acc, 'credit' => $c['amount']]]], $u['id']);
            $out['reimbursed']++;
            $out['amount'] = self::r2($out['amount'] + $c['amount']);
            $st === 'posted' ? $out['posted']++ : $out['pending']++;
            $this->log($u['id'], 'exp.reimburse', 'expense:'.self::str($id), ['amount' => $c['amount'], 'to' => $c['user'], 'from' => $from]);
        }
        return $out;
    }

    /* ---------- categories ---------- */
    public function categories(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $m = self::tr($qs['month'] ?? null) ? $qs['month'] : substr($this->pkToday(), 0, 7);
        return Db::all("SELECT k.*, COALESCE((SELECT SUM(amount) FROM exp_claims c WHERE c.category_id=k.id AND c.status!='rejected' AND SUBSTR(c.day,1,7)=?),0) spent FROM exp_categories k ORDER BY k.active DESC, k.sort, k.name", $m);
    }

    public function categorySave(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $name = trim(self::tr($b['name'] ?? null) ? self::str($b['name']) : '');
        $this->need($name !== '', 'Name is needed');
        $rawAcc = $b['account'] ?? null;
        $this->need(in_array($rawAcc, self::ACCOUNTS, true) || trim(self::tr($rawAcc) ? self::str($rawAcc) : '') !== '', 'Pick an account');
        $account = trim(array_key_exists('account', $b) ? self::str($rawAcc) : 'undefined');
        $this->need(! in_array($account, ['Salary Exp', 'Social Media Marketing', 'Cost of Goods Sold', 'Purchases', 'Accounts Payable'], true),
            "{$account} is booked by its own screen (payroll, marketing, lots) — an expense category on it would count the cost twice");
        $A = $this->accounts();
        if ($A && method_exists($A, 'accountId')) {
            $this->need($A->accountId($account), "There is no account \"{$account}\" in the chart of accounts");
        }
        $bid = self::num($b['id'] ?? null);
        $bidOr0 = self::tr($bid) ? $bid : 0;
        $dup = Db::get('SELECT id FROM exp_categories WHERE name=? AND id!=?', $name, $bidOr0);
        $this->need(! $dup, 'A category with this name exists');
        $bb = $b['budget'] ?? null;
        $budget = $bb === '' || $bb === null ? null : self::r2($bb);
        $id = $bid;
        if (self::tr($id)) {
            $active = $b['active'] ?? null;
            Db::run('UPDATE exp_categories SET name=?, account=?, budget=?, active=? WHERE id=?', $name, $account, $budget, $active === false || $active === 0 ? 0 : 1, $id);
        } else {
            // MySQL cannot read the target table in a sub-select of the INSERT: compute the next sort first
            $sort = (int) Db::val('SELECT COALESCE(MAX(sort),0)+1 FROM exp_categories');
            $id = Db::run('INSERT INTO exp_categories(name,account,budget,sort) VALUES(?,?,?,?)', $name, $account, $budget, $sort)->lastInsertRowid;
        }
        $this->log($u['id'], 'exp.category_save', 'exp_category:'.self::str($id), ['name' => $name, 'account' => $rawAcc, 'budget' => $budget]);
        return Db::get('SELECT * FROM exp_categories WHERE id=?', $id);
    }

    /* ---------- petty cash boxes ---------- */
    private function boxRow(array $b): array
    {
        $bal = $this->boxBal($b['id']);
        $pend = $this->boxPending($b['id']);
        $last = Db::get('SELECT * FROM exp_counts WHERE box_id=? ORDER BY id DESC LIMIT 1', $b['id']);
        return array_merge($b, ['balance' => $bal, 'pending' => $pend, 'expected' => self::r2($bal - $pend), 'low_now' => $bal < (($b['low'] ?? null) ?: 0), 'lastCount' => $last]);
    }

    public function boxes(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $all = Db::all('SELECT b.*, us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian ORDER BY b.active DESC, b.id');
        $mine = $this->myBoxes($u);
        $appr = $this->isApprover($u);
        return array_values(array_map(fn ($x) => $this->boxRow($x), array_filter($all, fn ($x) => $appr || in_array($x['id'], $mine, true))));
    }

    public function boxSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $name = trim(self::tr($b['name'] ?? null) ? self::str($b['name']) : '');
        $this->need($name !== '', 'Name is needed');
        $bid = self::num($b['id'] ?? null);
        $this->need(! Db::get('SELECT id FROM exp_boxes WHERE name=? AND id!=?', $name, self::tr($bid) ? $bid : 0), 'A box with this name exists');
        $cust = self::tr($b['custodian'] ?? null) ? self::num($b['custodian']) : null;
        if (self::tr($cust)) {
            $this->need(Db::get('SELECT id FROM users WHERE id=?', $cust), 'Unknown user');
        }
        $id = $bid;
        if (self::tr($id)) {
            Db::run('UPDATE exp_boxes SET name=?, custodian=?, low=?, active=? WHERE id=?', $name, $cust, self::r2($b['low'] ?? null), ($b['active'] ?? null) === false ? 0 : 1, $id);
        } else {
            $low = $b['low'] ?? null;
            $id = Db::run('INSERT INTO exp_boxes(name,custodian,low) VALUES(?,?,?)', $name, $cust, self::r2(self::tr($low) ? $low : 5000))->lastInsertRowid;
        }
        $this->log($u['id'], 'exp.box_save', 'exp_box:'.self::str($id), ['name' => $name, 'custodian' => $cust, 'low' => $b['low'] ?? null]);
        $row = Db::get('SELECT * FROM exp_boxes WHERE id=?', $id);
        $this->need($row, 'Not found', 404);
        return $this->boxRow($row);
    }

    public function users(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name');
    }

    public function register(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $box = Db::get('SELECT b.*, us.name custodian_name FROM exp_boxes b LEFT JOIN users us ON us.id=b.custodian WHERE b.id=?', self::num($p['id']));
        $this->need($box, 'Not found', 404);
        $this->need($this->canBox($u, $box['id']), 'Not your cash box', 403);
        $from = self::isDay($qs['from'] ?? null) ? $qs['from'] : '0000-00-00';
        $to = self::isDay($qs['to'] ?? null) ? $qs['to'] : '9999-12-31';
        $opening = self::r2(Db::val('SELECT COALESCE(SUM(amount),0) s FROM exp_box_moves WHERE box_id=? AND day<?', $box['id'], $from));
        $run = $opening;
        $rows = [];
        foreach (Db::all("SELECT m.*, us.name `user`, p.status post_status FROM exp_box_moves m LEFT JOIN users us ON us.id=m.user_id
        LEFT JOIN exp_postings p ON p.source=(CASE m.src WHEN 'topup' THEN 'petty_topup' WHEN 'count' THEN 'petty_count' WHEN 'reimb' THEN 'expense_reimb' ELSE 'expense' END) AND p.source_id=m.ref
        WHERE m.box_id=? AND m.day BETWEEN ? AND ? ORDER BY m.day, m.id", $box['id'], $from, $to) as $m) {
            $run = self::r2($run + $m['amount']);
            $rows[] = array_merge($m, ['balance' => $run]);
        }
        $pending = Db::all(self::CLAIM_SQL." WHERE c.box_id=? AND c.paid_from='petty' AND c.status='pending' ORDER BY c.day", $box['id']);
        return ['box' => $this->boxRow($box), 'opening' => $opening, 'closing' => $run, 'rows' => array_reverse($rows), 'pending' => $pending,
            'counts' => Db::all('SELECT k.*, us.name `user`, ap.name approver FROM exp_counts k LEFT JOIN users us ON us.id=k.user_id LEFT JOIN users ap ON ap.id=k.approved_by WHERE box_id=? ORDER BY k.id DESC LIMIT 30', $box['id'])];
    }

    public function topup(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $box = Db::get('SELECT * FROM exp_boxes WHERE id=?', self::num($p['id']));
        $this->need($box, 'Not found', 404);
        $amt = self::r2($b['amount'] ?? null);
        $this->need($amt > 0, 'Enter the amount');
        $from = self::tr($b['from'] ?? null) ? $b['from'] : 'Meezan (SB)';
        $this->need(in_array($from, ['Meezan (SB)', 'Cash'], true), 'Top up from Meezan or Cash');
        $dayv = self::isDay($b['day'] ?? null) ? $b['day'] : $this->pkToday();
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : 'Top-up from '.$from;
        $id = Db::run("INSERT INTO exp_box_moves(box_id,day,kind,amount,note,src,user_id) VALUES(?,?,'topup',?,?,'topup',?)", $box['id'], $dayv, $amt, mb_substr($note, 0, 200), $u['id'])->lastInsertRowid;
        Db::run('UPDATE exp_box_moves SET ref=? WHERE id=?', (string) $id, $id);
        $st = $this->postEntry('petty_topup', $id, ['date' => $dayv, 'memo' => "Petty cash top-up · {$box['name']} box", 'lines' => [['account' => 'Petty Cash', 'debit' => $amt], ['account' => $from, 'credit' => $amt]]], $u['id']);
        $this->log($u['id'], 'exp.topup', 'exp_box:'.$box['id'], ['amount' => $amt, 'from' => $from]);
        return ['id' => $id, 'posting' => $st, 'balance' => $this->boxBal($box['id'])];
    }

    public function count(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $box = Db::get('SELECT * FROM exp_boxes WHERE id=?', self::num($p['id']));
        $this->need($box, 'Not found', 404);
        $this->need($this->canBox($u, $box['id']), 'Only the custodian or an approver can count this box', 403);
        $bc = $b['counted'] ?? null;
        $this->need($bc !== '' && $bc !== null && self::num($bc) >= 0, 'Enter the cash you counted');
        $counted = self::r2($bc);
        $book = $this->boxBal($box['id']);
        $pend = $this->boxPending($box['id']);
        $variance = self::r2($counted - ($book - $pend));
        $id = Db::run('INSERT INTO exp_counts(box_id,day,counted,book,pending,variance,note,user_id,status) VALUES(?,?,?,?,?,?,?,?,?)', $box['id'], $this->pkToday(), $counted, $book, $pend, $variance,
            mb_substr(self::tr($b['note'] ?? null) ? self::str($b['note']) : '', 0, 300), $u['id'], abs($variance) < 1 ? 'ok' : 'pending')->lastInsertRowid;
        $this->log($u['id'], 'exp.count', 'exp_box:'.$box['id'], ['counted' => $counted, 'book' => $book, 'variance' => $variance]);
        return Db::get('SELECT * FROM exp_counts WHERE id=?', $id);
    }

    public function countSettle(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $k = Db::get('SELECT k.*, b.name box FROM exp_counts k JOIN exp_boxes b ON b.id=k.box_id WHERE k.id=?', self::num($p['id']));
        $this->need($k, 'Not found', 404);
        $this->need($k['status'] === 'pending', 'This count is already settled');
        $this->need(in_array($p['act'], ['approve', 'reject'], true), 'Unknown action', 404);
        if ($p['act'] === 'reject') {
            Db::run("UPDATE exp_counts SET status='rejected', approved_by=?, approved_at=UTC_TIMESTAMP(), note=CONCAT(COALESCE(note,''), ?) WHERE id=?", $u['id'],
                self::tr($b['reason'] ?? null) ? ' · Rejected: '.self::str($b['reason']) : '', $k['id']);
            $this->log($u['id'], 'exp.count_reject', 'exp_box:'.$k['box_id'], ['variance' => $k['variance']]);
            return ['ok' => true];
        }
        Db::run("UPDATE exp_counts SET status='approved', approved_by=?, approved_at=UTC_TIMESTAMP() WHERE id=?", $u['id'], $k['id']);
        Db::run("INSERT INTO exp_box_moves(box_id,day,kind,amount,ref,note,src,user_id) VALUES(?,?,'adjust',?,?,?,'count',?)", $k['box_id'], $this->pkToday(), $k['variance'], (string) $k['id'],
            ($k['variance'] < 0 ? 'Cash short' : 'Cash over').' in count #'.$k['id'], $u['id']);
        $v = abs($k['variance']);
        $lines = $k['variance'] < 0 ? [['account' => 'Miscellenious Exp', 'debit' => $v], ['account' => 'Petty Cash', 'credit' => $v]] : [['account' => 'Petty Cash', 'debit' => $v], ['account' => 'Miscellenious Exp', 'credit' => $v]];
        $st = $this->postEntry('petty_count', $k['id'], ['date' => $this->pkToday(), 'memo' => "Petty cash count difference · {$k['box']} box (count #{$k['id']})", 'lines' => $lines], $u['id']);
        $this->log($u['id'], 'exp.count_approve', 'exp_box:'.$k['box_id'], ['variance' => $k['variance']]);
        return ['ok' => true, 'posting' => $st];
    }

    /* ---------- recurring ---------- */
    private function doRunRecurring($today = null): int
    {
        $today = self::isDay($today) ? $today : $this->pkToday();
        $m = substr($today, 0, 7);
        $d = (int) substr($today, 8, 2);
        $made = 0;
        foreach (Db::all('SELECT r.*, k.name cat, k.account FROM exp_recurring r LEFT JOIN exp_categories k ON k.id=r.category_id WHERE r.active=1 AND r.amount>0') as $t) {
            if (! self::tr($t['account'])) {
                continue;
            }
            $dd = self::num($t['dom']);
            $dom = min(max(1, self::tr($dd) ? $dd : 1), self::lastDom($m));
            if ($d < $dom) {
                continue;
            }
            $dayv = $m.'-'.str_pad(self::str($dom), 2, '0', STR_PAD_LEFT);
            $box = $t['paid_from'] === 'petty' ? Db::val('SELECT id FROM exp_boxes WHERE active=1 ORDER BY id LIMIT 1') : null;
            $r = Db::run('INSERT IGNORE INTO exp_claims(day,category_id,category,account,amount,paid_from,box_id,vendor,note,recurring_id,period) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                $dayv, $t['category_id'], $t['cat'], $t['account'], $t['amount'], $t['paid_from'], $box, $t['vendor'] ?: '', mb_substr($t['name'].(self::tr($t['note']) ? ' — '.$t['note'] : ''), 0, 300), $t['id'], $m);
            if ($r->changes) {
                $made++;
                $this->log(null, 'exp.recurring_created', 'expense:'.$r->lastInsertRowid, ['template' => $t['name'], 'amount' => $t['amount'], 'period' => $m]);
            }
        }
        return $made;
    }

    public function recurringList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT r.*, k.name category, k.account, (SELECT MAX(period) FROM exp_claims c WHERE c.recurring_id=r.id) last_period FROM exp_recurring r LEFT JOIN exp_categories k ON k.id=r.category_id ORDER BY r.active DESC, r.dom, r.id');
    }

    public function recurringSave(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $name = trim(self::tr($b['name'] ?? null) ? self::str($b['name']) : '');
        $this->need($name !== '', 'Name is needed');
        $catId = self::num($b['category_id'] ?? null);
        $this->need(Db::get('SELECT id FROM exp_categories WHERE id=?', $catId), 'Pick a category');
        $pf = $b['paid_from'] ?? null;
        $this->need(is_string($pf) && isset(self::PAY[$pf]) && $pf !== 'own', 'Choose how it is paid');
        $dn = self::num($b['dom'] ?? null);
        $dom = is_nan((float) $dn) ? NAN : Logic::jsRound($dn);
        $this->need($dom >= 1 && $dom <= 31, 'Day of month must be 1–31');
        $amt = self::r2($b['amount'] ?? null);
        $active = self::tr($b['active'] ?? null) ? 1 : 0;
        $this->need(! $active || $amt > 0, 'Enter the amount before turning it on');
        $vendor = self::tr($b['vendor'] ?? null) ? self::str($b['vendor']) : '';
        $note = self::tr($b['note'] ?? null) ? self::str($b['note']) : '';
        $id = self::num($b['id'] ?? null);
        if (self::tr($id)) {
            Db::run('UPDATE exp_recurring SET name=?,category_id=?,amount=?,dom=?,paid_from=?,vendor=?,note=?,active=? WHERE id=?', $name, $catId, $amt, $dom, $pf, $vendor, $note, $active, $id);
        } else {
            $id = Db::run('INSERT INTO exp_recurring(name,category_id,amount,dom,paid_from,vendor,note,active) VALUES(?,?,?,?,?,?,?,?)', $name, $catId, $amt, $dom, $pf, $vendor, $note, $active)->lastInsertRowid;
        }
        $this->log($u['id'], 'exp.recurring_save', 'exp_recurring:'.self::str($id), ['name' => $name, 'amount' => $amt, 'active' => $active]);
        return Db::get('SELECT * FROM exp_recurring WHERE id=?', $id);
    }

    public function recurringDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        Db::run('DELETE FROM exp_recurring WHERE id=?', self::num($p['id']));
        $this->log($u['id'], 'exp.recurring_delete', 'exp_recurring:'.$p['id'], '');
        return ['ok' => true];
    }

    public function recurringRun(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['created' => $this->doRunRecurring($b['day'] ?? null), 'retried' => $this->retryAll()];
    }

    /* ---------- postings queue ---------- */
    public function postings(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $s = self::tr($qs['status'] ?? null) ? $qs['status'] : '';
        return Db::all("SELECT * FROM exp_postings WHERE (? = '' OR status=?) ORDER BY id DESC LIMIT 200", $s, $s);
    }

    public function postingsRetry(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $posted = $this->retryAll();
        return ['posted' => $posted, 'left' => (int) Db::val("SELECT COUNT(*) n FROM exp_postings WHERE status IN ('pending','error')")];
    }

    /* ---------- reports ---------- */
    private function monthQ(array $qs): string
    {
        $m = $qs['month'] ?? '';
        return is_string($m) && preg_match('/^\d{4}-\d{2}$/', $m) ? $m : substr($this->pkToday(), 0, 7);
    }

    public function report(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $m = $this->monthQ($qs);
        $W = "c.status!='rejected' AND SUBSTR(c.day,1,7)=?";
        $byCategory = Db::all("SELECT k.id, k.name category, k.account, k.budget, COALESCE(SUM(c.amount),0) amount, COUNT(c.id) n FROM exp_categories k LEFT JOIN exp_claims c ON c.category_id=k.id AND {$W}
        GROUP BY k.id HAVING COALESCE(SUM(c.amount),0)>0 OR k.budget>0 ORDER BY amount DESC", $m);
        $byPerson = Db::all("SELECT COALESCE(us.name, CASE WHEN c.recurring_id IS NOT NULL THEN 'Recurring bills' ELSE '—' END) person, COUNT(*) n, SUM(c.amount) amount FROM exp_claims c LEFT JOIN users us ON us.id=c.user_id WHERE {$W} GROUP BY 1 ORDER BY amount DESC", $m);
        $byVendor = Db::all("SELECT COALESCE(NULLIF(TRIM(c.vendor),''),'(not written)') vendor, COUNT(*) n, SUM(c.amount) amount FROM exp_claims c WHERE {$W} GROUP BY 1 ORDER BY amount DESC LIMIT 30", $m);
        $byPay = Db::all("SELECT paid_from, SUM(amount) amount FROM exp_claims c WHERE {$W} GROUP BY paid_from", $m);
        $trend = [];
        for ($i = 5; $i >= 0; $i--) {
            $mm = self::monthsBack($m, $i);
            $t = Db::get("SELECT COALESCE(SUM(CASE WHEN status='approved' THEN amount END),0) approved, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending FROM exp_claims c WHERE SUBSTR(day,1,7)=?", $mm);
            $old = Db::val('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE SUBSTR(day,1,7)=?', $mm);
            $trend[] = ['month' => $mm, 'approved' => self::r2($t['approved']), 'pending' => self::r2($t['pending']), 'older' => self::r2($old)];
        }
        $top = Db::all(self::CLAIM_SQL." WHERE {$W} ORDER BY c.amount DESC LIMIT 10", $m);
        $tot = Db::get("SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) pending, COUNT(*) n FROM exp_claims c WHERE {$W}", $m);
        $budget = Db::val('SELECT COALESCE(SUM(budget),0) b FROM exp_categories WHERE active=1');
        $budgetSpent = 0;
        foreach ($byCategory as $c) {
            if ($c['budget'] > 0) {
                $budgetSpent += $c['amount'];
            }
        }
        return ['month' => $m, 'total' => self::r2($tot['total']), 'pending' => self::r2($tot['pending']), 'n' => $tot['n'], 'budget' => self::r2($budget), 'budgetSpent' => self::r2($budgetSpent),
            'byCategory' => $byCategory, 'byPerson' => $byPerson, 'byVendor' => $byVendor, 'byPay' => $byPay, 'trend' => $trend, 'top' => $top];
    }

    public function export(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $m = $this->monthQ($qs);
        return array_map(fn ($c) => ['id' => $c['id'], 'date' => $c['day'], 'category' => $c['category'], 'account' => $c['account'], 'amount' => $c['amount'],
            'paid_from' => self::PAY[$c['paid_from']] ?? $c['paid_from'], 'box' => $c['box'] ?: '', 'shop_vendor' => $c['vendor'], 'note' => $c['note'],
            'by' => ($c['user'] ?: null) ?? ($c['recurring_id'] ? 'Recurring' : ''), 'status' => $c['status'], 'reason' => $c['reason'] ?: '', 'approved_by' => $c['approver'] ?: '',
            'reimbursed' => $c['paid_from'] === 'own' ? ($c['reimbursed'] ? 'yes '.self::str($c['reimbursed_at']) : 'no') : '', 'posted' => $c['post_status'] ?: '', 'receipt' => self::tr($c['receipt']) ? 'yes' : ''],
            Db::all(self::CLAIM_SQL.' WHERE SUBSTR(c.day,1,7)=? ORDER BY c.day, c.id', $m));
    }

    public function older(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $pg = $this->page($qs, 100);
        $rows = Db::all('SELECT e.*, us.name `user` FROM expenses e LEFT JOIN users us ON us.id=e.user_id ORDER BY e.day DESC, e.id DESC LIMIT ? OFFSET ?', $pg['limit'], $pg['offset']);
        $t = Db::get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expenses');
        return ['rows' => $rows, 'total' => $t['n'], 'amount' => self::r2($t['s']), 'page' => $pg['page'], 'pages' => (int) ceil($t['n'] / $pg['limit'])];
    }

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['receipt_limit' => $this->limit(), 'card_account' => $this->cardAcc(), 'wait_days' => $this->waitDays()];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        if (isset($b['receipt_limit'])) {
            $this->need(self::num($b['receipt_limit']) >= 0, 'Receipt limit must be 0 or more');
            $this->setSetting('expenses_receipt_limit', self::num($b['receipt_limit']));
        }
        if (self::tr($b['card_account'] ?? null)) {
            $this->need(in_array($b['card_account'], ['Meezan (SB)', 'Cash', 'Meta Ads Payable', 'Accrued Expenses'], true), 'Unknown account');
            $this->setSetting('expenses_card_account', $b['card_account']);
        }
        if (isset($b['wait_days'])) {
            $wd = self::num($b['wait_days']);
            $this->setSetting('expenses_wait_days', max(1, self::tr($wd) ? $wd : 2));
        }
        $this->log($u['id'], 'settings.save', 'expenses', $b ?: (object) []);
        return ['receipt_limit' => $this->limit(), 'card_account' => $this->cardAcc(), 'wait_days' => $this->waitDays()];
    }

    /* ---------- services (ctx.services.expenses) for the owner home + other modules ---------- */

    public function summary(): array
    {
        $p = Db::get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims WHERE status='pending'");
        $pet = Db::val('SELECT COALESCE(SUM(m.amount),0) s FROM exp_box_moves m JOIN exp_boxes b ON b.id=m.box_id WHERE b.active=1');
        $mt = Db::val("SELECT COALESCE(SUM(amount),0) s FROM exp_claims WHERE status!='rejected' AND SUBSTR(day,1,7)=?", substr($this->pkToday(), 0, 7));
        return ['pending' => $p['n'], 'pendingAmount' => self::r2($p['s']), 'pettyBalance' => self::r2($pet), 'monthTotal' => self::r2($mt)];
    }

    /** runRecurring(today?) -> number of claims created */
    public function runRecurring($today = null): int
    {
        return $this->doRunRecurring($today);
    }

    /** retryPostings() -> number of queued entries posted */
    public function retryPostings(): int
    {
        return $this->retryAll();
    }

    /** monthByAccount('YYYY-MM'?) -> [{account, amount}] approved claims of the month */
    public function monthByAccount($m = null): array
    {
        return Db::all("SELECT account, SUM(amount) amount FROM exp_claims WHERE status='approved' AND SUBSTR(day,1,7)=? GROUP BY account", self::tr($m) ? $m : substr($this->pkToday(), 0, 7));
    }

    /** S.boxes(): active boxes with balances */
    private function activeBoxes(): array
    {
        return array_map(fn ($b) => $this->boxRow($b), Db::all('SELECT * FROM exp_boxes WHERE active=1'));
    }

    /* ---------- jobs / counts / alerts / activity ---------- */

    public function jobs(): array
    {
        return [['name' => 'daily', 'every' => 60, 'offset' => 7, 'run' => function () {
            $this->doRunRecurring();
            $this->retryAll();
        }]];
    }

    public function counts(array $u): array
    {
        if (! $this->can($u, 'expenses_approve')) {
            return [];
        }
        return ['approvals' => (int) Db::val("SELECT COUNT(*) n FROM exp_claims WHERE status='pending'")];
    }

    public function alerts(array $u): array
    {
        $out = [];
        $appr = $this->can($u, 'expenses_approve');
        if ($appr) {
            $d = max(1, self::num($this->setting('expenses_wait_days', 2)));
            $w = Db::get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM exp_claims WHERE status='pending' AND created_at < (UTC_TIMESTAMP() - INTERVAL ? SECOND)", (int) round($d * 86400));
            if ($w['n']) {
                $out[] = ['level' => 'warn', 'text' => "{$w['n']} expense claim".($w['n'] > 1 ? 's' : '').' (Rs '.self::loc(Logic::jsRound($w['s'])).') waiting more than '.self::str($d).' days for approval', 'href' => '#/approvals'];
            }
            foreach (Db::all("SELECT k.*, b.name box FROM exp_counts k JOIN exp_boxes b ON b.id=k.box_id WHERE k.status='pending'") as $k) {
                $out[] = ['level' => abs($k['variance']) >= 1000 ? 'bad' : 'warn', 'text' => "{$k['box']} petty cash count is ".($k['variance'] < 0 ? 'short' : 'over').' by Rs '.self::loc(abs(Logic::jsRound($k['variance']))), 'href' => '#/pettycash/'.$k['box_id']];
            }
            $A = $this->accounts();
            if ($A && method_exists($A, 'post')) {
                $e = (int) Db::val("SELECT COUNT(*) n FROM exp_postings WHERE status='error'");
                if ($e) {
                    $out[] = ['level' => 'info', 'text' => "{$e} expense entr".($e > 1 ? 'ies' : 'y').' could not be posted to accounts', 'href' => '#/approvals/setup'];
                }
            }
        }
        $mine = $this->myBoxes($u);
        if ($appr || $mine) {
            foreach ($this->activeBoxes() as $b) {
                if (($appr || in_array($b['id'], $mine, true)) && $b['low_now'] && Db::get('SELECT 1 FROM exp_box_moves WHERE box_id=? LIMIT 1', $b['id'])) {
                    $out[] = ['level' => 'warn', 'text' => "{$b['name']} petty cash is low: Rs ".self::loc(Logic::jsRound($b['balance'])).' left', 'href' => $appr ? '#/pettycash/'.$b['id'] : '#/pettybox/'.$b['id']];
                }
            }
        }
        $rej = (int) Db::val("SELECT COUNT(*) n FROM exp_claims WHERE user_id=? AND status='rejected' AND approved_at > (UTC_TIMESTAMP() - INTERVAL 3 DAY)", $u['id']);
        if ($rej) {
            $out[] = ['level' => 'info', 'text' => "{$rej} of your expense claims ".($rej > 1 ? 'were' : 'was').' rejected — see the reason', 'href' => '#/expenses'];
        }
        return $out;
    }

    public function activity(): array
    {
        return [
            'exp.submit' => 'Submitted expense', 'exp.edit' => 'Edited expense', 'exp.delete' => 'Deleted expense', 'exp.approve' => 'Approved expense', 'exp.reject' => 'Rejected expense',
            'exp.reopen' => 'Reopened expense', 'exp.reimburse' => 'Reimbursed expense', 'exp.topup' => 'Topped up petty cash', 'exp.count' => 'Counted petty cash',
            'exp.count_approve' => 'Approved cash count difference', 'exp.count_reject' => 'Rejected cash count', 'exp.category_save' => 'Saved expense category', 'exp.box_save' => 'Saved cash box',
            'exp.recurring_save' => 'Saved recurring expense', 'exp.recurring_delete' => 'Deleted recurring expense', 'exp.recurring_created' => 'Recurring expense created',
        ];
    }
}
