<?php

namespace App\Erp\Modules;

use App\Erp\Core\Logic;
use App\Erp\Db;
use App\Erp\Erp;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;

/**
 * HR & Payroll (port of legacy/server/modules/hr.js): employees, attendance (self check-in), leave, advances, payroll,
 * warnings, "My page" data. All business dates are Pakistan 'YYYY-MM-DD'.
 */
class HrModule extends Module
{
    public string $name = 'hr';

    private const DEPTS = ['CS', 'Listing', 'Warehouse', 'Finance', 'Marketing', 'Outlet', 'Management', 'Other'];

    private const DEFAULTS = [
        'allowed_ips' => [], // office network prefixes, e.g. ['192.168.1.'] ; empty = check-in from anywhere
        'leave_types' => [['key' => 'casual', 'name' => 'Casual', 'quota' => 10, 'paid' => true], ['key' => 'sick', 'name' => 'Sick', 'quota' => 8, 'paid' => true],
            ['key' => 'annual', 'name' => 'Annual', 'quota' => 14, 'paid' => true], ['key' => 'unpaid', 'name' => 'Unpaid', 'quota' => null, 'paid' => false]],
        'late_rule' => ['per' => 3, 'days' => 0.5], // every 3 lates = ½ day salary cut
        'absent_alert_min' => 60, // alert for absentees this many minutes after shift start
        'company' => '',
    ];

    private const SENSITIVE = ['cnic', 'basic', 'allowances', 'bank_account', 'pay_method', 'address', 'emergency'];

    private const CODE = ['present' => 'P', 'late' => 'L', 'half' => '½', 'leave' => 'LV', 'halfleave' => '½LV', 'off' => 'OFF', 'holiday' => 'H', 'absent' => 'A', 'not_yet' => '', 'future' => '', 'na' => '–'];

    private const FIELDS = ['name', 'user_id', 'phone', 'cnic', 'address', 'emergency', 'department', 'designation', 'join_date', 'status', 'leave_date', 'leave_reason',
        'basic', 'allowances', 'pay_method', 'bank_account', 'shift_start', 'shift_end', 'grace_min', 'off_days', 'photo', 'docs', 'notes'];

    private const LINE_COLS = ['month', 'emp_id', 'name', 'department', 'designation', 'days_month', 'emp_days', 'present', 'late', 'absent', 'leave_paid', 'unpaid', 'off', 'holiday', 'basic', 'allowances', 'day_rate', 'gross',
        'absence_ded', 'late_ded', 'earned', 'incentive', 'incentive_note', 'other_ded', 'other_note', 'recovery', 'recovery_manual', 'adv_balance', 'net'];

    public function activity(): array
    {
        return [
            'hr.checkin' => 'Checked in', 'hr.checkout' => 'Checked out', 'hr.attendance.edit' => 'Edited attendance', 'hr.leave.request' => 'Requested leave', 'hr.leave.approve' => 'Approved leave',
            'hr.leave.reject' => 'Rejected leave', 'hr.leave.cancel' => 'Cancelled leave', 'hr.employee.add' => 'Added employee', 'hr.employee.save' => 'Updated employee', 'hr.employee.left' => 'Marked employee as left',
            'hr.warning' => 'Gave warning / note', 'hr.warning.delete' => 'Deleted warning', 'hr.holiday' => 'Added holiday', 'hr.holiday.delete' => 'Removed holiday', 'hr.settings' => 'Changed HR settings',
            'hr.advance' => 'Gave salary advance', 'hr.advance.delete' => 'Deleted advance', 'hr.payroll.run' => 'Ran payroll', 'hr.payroll.edit' => 'Edited payroll line', 'hr.payroll.approve' => 'Approved payroll',
            'hr.payroll.paid' => 'Paid salaries', 'hr.payroll.unpay' => 'Undid salary payment', 'hr.payroll.reopen' => 'Reopened payroll', 'hr.payroll.discard' => 'Discarded payroll draft',
        ];
    }

    /* ======================================================== small date/time helpers */

    /** JS `+v || 0` */
    private static function n($v): int|float
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_float($v)) {
            return is_nan($v) || is_infinite($v) ? 0 : $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_string($v)) {
            $t = trim($v);
            return $t !== '' && is_numeric($t) ? $t + 0 : 0;
        }
        return 0;
    }

    /** JS unary plus: NaN for text that is not a number */
    private static function jsNum($v): int|float
    {
        if ($v === null || $v === false) {
            return 0;
        }
        if ($v === true) {
            return 1;
        }
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if (is_string($v)) {
            $t = trim($v);
            return $t === '' ? 0 : (is_numeric($t) ? $t + 0 : NAN);
        }
        if (is_array($v) && count($v) <= 1) {
            return $v ? self::jsNum(reset($v)) : 0;
        }
        return NAN;
    }

    /** whole floats -> int (JSON like the JS numbers) */
    private static function num($v)
    {
        return is_float($v) && floor($v) == $v && abs($v) < 1e15 ? (int) $v : $v;
    }

    private static function str($v): string
    {
        if ($v === null) {
            return '';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_array($v)) {
            return implode(',', array_map(fn ($x) => is_array($x) ? '' : self::str($x), $v));
        }
        if (is_float($v)) {
            return (string) self::num($v);
        }
        return (string) $v;
    }

    private static function toMin($t): ?int
    {
        return is_scalar($t) && preg_match('/^(\d{1,2}):(\d{2})/', (string) $t, $m) ? (int) $m[1] * 60 + (int) $m[2] : null;
    }

    private static function ts(string $d): int
    {
        return (int) strtotime($d.' 00:00:00 UTC');
    }

    private static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', self::ts($d) + $n * 86400);
    }

    private static function wd(string $d): int
    {
        return (int) gmdate('w', self::ts($d));
    }

    private static function range(string $a, string $b): array
    {
        $out = [];
        for ($d = $a; $d <= $b; $d = self::addDays($d, 1)) {
            $out[] = $d;
        }
        return $out;
    }

    private static function monthEnd(string $m): string
    {
        return gmdate('Y-m-t', self::ts($m.'-01'));
    }

    private static function prevMonth(string $m): string
    {
        [$y, $mo] = array_map('intval', explode('-', $m));
        return gmdate('Y-m', gmmktime(0, 0, 0, $mo - 1, 1, $y));
    }

    private static function minDiff(string $a, string $b): int
    {
        return (int) Logic::jsRound((strtotime($b.' UTC') - strtotime($a.' UTC')) / 60);
    }

    private static function r0($v): int|float
    {
        return Logic::jsRound(self::n($v));
    }

    private static function isDay($s): bool
    {
        return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) === 1;
    }

    private static function isMonth($s): bool
    {
        return is_string($s) && preg_match('/^\d{4}-\d{2}$/', $s) === 1;
    }

    private static function monthName(string $m): string
    {
        return gmdate('F Y', self::ts($m.'-15'));
    }

    private function S(): array
    {
        $s = $this->setting('hr.settings', []);
        return array_merge(self::DEFAULTS, is_array($s) ? $s : []);
    }

    private function ltypes(): array
    {
        return $this->S()['leave_types'] ?? [];
    }

    private function ltype($k): ?array
    {
        foreach ($this->ltypes() as $t) {
            if (($t['key'] ?? null) === $k) {
                return $t;
            }
        }
        return null;
    }

    /* ======================================================== employees */

    private static function offs(array $e): array
    {
        $a = json_decode((string) (($e['off_days'] ?? '') ?: '[]'), true);
        return is_array($a) && array_is_list($a) ? array_map(fn ($x) => self::n($x), $a) : [];
    }

    private function getEmp($id): ?array
    {
        return Db::get('SELECT * FROM hr_employees WHERE id=?', (int) self::n($id));
    }

    private function empForUser($uid): ?array
    {
        return $uid ? Db::get("SELECT * FROM hr_employees WHERE user_id=? ORDER BY status='left', id DESC LIMIT 1", $uid) : null;
    }

    private function canSee(?array $u): bool
    {
        return $this->can($u, 'hr') || $this->can($u, 'payroll');
    }

    private function pub(array $e, ?array $u): array
    {
        $docs = json_decode((string) (($e['docs'] ?? '') ?: '[]'), true);
        $o = array_merge($e, ['off_days' => self::offs($e), 'docs' => json_last_error() === JSON_ERROR_NONE ? $docs : []]);
        if (! $this->canSee($u)) {
            foreach (self::SENSITIVE as $k) {
                unset($o[$k]);
            }
        }
        return $o;
    }

    private static function employedOn(array $e, string $d): bool
    {
        return $d >= (($e['join_date'] ?? '') ?: '0000') && (! $e['leave_date'] || $d <= $e['leave_date']);
    }

    /* ======================================================== attendance status engine */

    private function load(string $from, string $to): array
    {
        $att = [];
        $lv = [];
        foreach (Db::all('SELECT * FROM hr_attendance WHERE day BETWEEN ? AND ?', $from, $to) as $r) {
            $att[$r['emp_id'].'|'.$r['day']] = $r;
        }
        foreach (Db::all("SELECT * FROM hr_leave WHERE status='approved' AND from_day<=? AND to_day>=?", $to, $from) as $r) {
            foreach (self::range($r['from_day'] < $from ? $from : $r['from_day'], $r['to_day'] > $to ? $to : $r['to_day']) as $d) {
                $lv[$r['emp_id'].'|'.$d] = $r;
            }
        }
        $hol = [];
        foreach (Db::all('SELECT day,name FROM hr_holidays WHERE day BETWEEN ? AND ?', $from, $to) as $r) {
            $hol[$r['day']] = $r['name'];
        }
        $now = $this->pkNow();
        return ['att' => $att, 'lv' => $lv, 'hol' => $hol, 'today' => substr($now, 0, 10), 'nowMin' => self::toMin(substr($now, 11, 5))];
    }

    /** status of one employee on one day: present | late | half | leave | halfleave | off | holiday | absent | not_yet | future | na */
    private function dayStatus(array $e, string $d, array $L): array
    {
        if (! self::employedOn($e, $d)) {
            return ['s' => 'na'];
        }
        $a = $L['att'][$e['id'].'|'.$d] ?? null;
        $l = $L['lv'][$e['id'].'|'.$d] ?? null;
        if ($a && $a['in_at']) {
            return ['s' => $a['half'] ? 'half' : ($a['late_min'] > 0 ? 'late' : 'present'), 'a' => $a, 'l' => $l];
        }
        if (in_array(self::wd($d), self::offs($e))) {
            return ['s' => 'off'];
        }
        if (array_key_exists($d, $L['hol'])) {
            return ['s' => 'holiday', 'name' => $L['hol'][$d]];
        }
        if ($l) {
            return ['s' => $l['half'] ? 'halfleave' : 'leave', 'l' => $l];
        }
        if ($d > $L['today']) {
            return ['s' => 'future'];
        }
        if ($d === $L['today'] && $L['nowMin'] < (self::toMin($e['shift_start']) ?? 540) + self::n($e['grace_min'])) {
            return ['s' => 'not_yet'];
        }
        return ['s' => 'absent'];
    }

    /** month (or any range) tally for one employee */
    private function tally(array $e, array $days, array $L): array
    {
        $t = ['present' => 0, 'late' => 0, 'absent' => 0, 'leave' => 0, 'unpaid' => 0, 'off' => 0, 'holiday' => 0, 'workdays' => 0, 'cells' => []];
        foreach ($days as $d) {
            $st = $this->dayStatus($e, $d, $L);
            $a = $st['a'] ?? null;
            $l = $st['l'] ?? null;
            $cell = ['d' => $d, 's' => $st['s'], 'c' => self::CODE[$st['s']]];
            if ($a) { // JS `st.a && st.a.x`: undefined (left out) without an attendance row
                $cell += ['in_at' => $a['in_at'], 'out_at' => $a['out_at'], 'late_min' => $a['late_min']];
            }
            if ($l) {
                $cell['leave'] = $l['type'];
            }
            $t['cells'][] = $cell;
            $lt = $l ? $this->ltype($l['type']) : null;
            $unpaid = $lt && ($lt['paid'] ?? null) === false;
            $lvAdd = function ($n) use (&$t, $unpaid) {
                if ($unpaid) {
                    $t['unpaid'] += $n;
                } else {
                    $t['leave'] += $n;
                }
            };
            switch ($st['s']) {
                case 'present':
                case 'late':
                    $t['present']++;
                    if ($st['s'] === 'late') {
                        $t['late']++;
                    }
                    if ($l && $l['half']) {
                        $lvAdd(0.5);
                    }
                    break;
                case 'half':
                    $t['present'] += 0.5;
                    if ($l && $l['half']) {
                        $lvAdd(0.5);
                    } else {
                        $t['absent'] += 0.5;
                    }
                    break;
                case 'leave':
                    $lvAdd(1);
                    break;
                case 'halfleave':
                    $lvAdd(0.5);
                    if ($d < $L['today']) {
                        $t['absent'] += 0.5;
                    }
                    break;
                case 'off':
                    $t['off']++;
                    break;
                case 'holiday':
                    $t['holiday']++;
                    break;
                case 'absent':
                    $t['absent']++;
                    break;
            }
            if (! in_array($st['s'], ['na', 'off', 'holiday'], true)) {
                $t['workdays']++;
            }
        }
        return $t;
    }

    private function attendanceOn(string $date): array
    {
        $L = $this->load($date, $date);
        $emps = array_values(array_filter(Db::all("SELECT * FROM hr_employees WHERE status!='left' OR leave_date>=? ORDER BY name", $date), fn ($e) => self::employedOn($e, $date)));
        return array_map(function ($e) use ($date, $L) {
            $st = $this->dayStatus($e, $date, $L);
            $a = $st['a'] ?? null;
            $mins = $a ? $a['minutes'] : null;
            if ($a && $a['in_at'] && ! $a['out_at'] && $date === $L['today']) {
                $mins = max(0, self::minDiff($a['in_at'], $this->pkNow()));
            }
            return ['employee_id' => $e['id'], 'user_id' => $e['user_id'], 'name' => $e['name'], 'department' => $e['department'], 'designation' => $e['designation'],
                'shift_start' => $e['shift_start'], 'shift_end' => $e['shift_end'],
                'status' => $st['s'] === 'half' ? 'present' : ($st['s'] === 'halfleave' ? 'leave' : $st['s']), 'detail' => $st['s'], 'half' => $st['s'] === 'half' || $st['s'] === 'halfleave',
                'in_at' => $a ? $a['in_at'] : null, 'out_at' => $a ? $a['out_at'] : null, 'late_min' => $a ? ($a['late_min'] ?: 0) : 0, 'early_min' => $a ? ($a['early_min'] ?: 0) : 0,
                'hours' => $mins === null ? null : self::num(Logic::jsRound($mins / 6) / 10), 'att_id' => $a ? $a['id'] : null, 'leave_type' => ($st['l'] ?? null) ? $st['l']['type'] : null,
                'holiday' => ($st['name'] ?? null) ?: null, 'ip' => $a ? $a['in_ip'] : null, 'note' => $a ? $a['note'] : null];
        }, $emps);
    }

    /* ======================================================== services (ctx.services.hr) */

    public function list(): array
    {
        return Db::all("SELECT id,user_id,name,department,designation,status,join_date,leave_date,shift_start,shift_end,phone FROM hr_employees WHERE status!='left' ORDER BY name");
    }

    public function attendance($date = null): array
    {
        return $this->attendanceOn(self::isDay($date) ? $date : $this->pkToday());
    }

    public function employeeForUser($uid): ?array
    {
        $e = $this->empForUser($uid);
        return $e ? ['id' => $e['id'], 'name' => $e['name'], 'department' => $e['department'], 'designation' => $e['designation'], 'status' => $e['status'],
            'shift_start' => $e['shift_start'], 'shift_end' => $e['shift_end']] : null;
    }

    public function summary(): array
    {
        $rows = $this->attendanceOn($this->pkToday());
        $n = fn ($s) => count(array_filter($rows, fn ($r) => $r['status'] === $s));
        return ['staff' => count($rows), 'present' => $n('present') + $n('late'), 'late' => $n('late'), 'absent' => $n('absent'), 'onLeave' => $n('leave'), 'off' => $n('off') + $n('holiday'), 'notYet' => $n('not_yet')];
    }

    public function monthStats($month, $empId): ?array
    {
        $e = $this->getEmp($empId);
        if (! $e) {
            return null;
        }
        $to = self::monthEnd($month);
        $t = $this->tally($e, self::range($month.'-01', $to < $this->pkToday() ? $to : $this->pkToday()), $this->load($month.'-01', $to));
        unset($t['cells']);
        return $t;
    }

    /* ======================================================== leave */

    private function leaveDays(array $e, string $from, string $to, bool $half): int|float
    {
        $hol = [];
        foreach (Db::all('SELECT day,name FROM hr_holidays WHERE day BETWEEN ? AND ?', $from, $to) as $r) {
            $hol[$r['day']] = $r['name'];
        }
        $offs = self::offs($e);
        $n = count(array_filter(self::range($from, $to), fn ($d) => ! in_array(self::wd($d), $offs) && ! array_key_exists($d, $hol)));
        return $half && $from === $to ? min($n, 0.5) : $n;
    }

    private function balances($empId, $year): array
    {
        $used = [];
        $pend = [];
        foreach (Db::all("SELECT type,status,SUM(days) n FROM hr_leave WHERE emp_id=? AND SUBSTR(from_day,1,4)=? AND status IN ('approved','pending') GROUP BY type,status", $empId, (string) $year) as $r) {
            if ($r['status'] === 'approved') {
                $used[$r['type']] = self::num($r['n']);
            } else {
                $pend[$r['type']] = self::num($r['n']);
            }
        }
        return array_map(fn ($t) => array_merge($t, ['used' => ($used[$t['key']] ?? 0) ?: 0, 'pending' => ($pend[$t['key']] ?? 0) ?: 0,
            'left' => ($t['quota'] ?? null) === null ? null : self::num($t['quota'] - (($used[$t['key']] ?? 0) ?: 0))]), $this->ltypes());
    }

    private function checkLeave(array $e, array $b, $excludeId = null): array
    {
        $this->need($this->ltype($b['type'] ?? null), 'Choose a leave type');
        $from = $b['from_day'] ?? null;
        $to = ($b['to_day'] ?? null) ?: $from;
        $this->need(self::isDay($from) && self::isDay($to), 'Choose the dates');
        $this->need($to >= $from, 'End date is before start date');
        $half = ! empty($b['half']) && $from === $to;
        $days = $this->leaveDays($e, $from, $to, $half);
        $this->need($days > 0, 'Those dates are all off days or holidays');
        $this->need(! Db::get("SELECT id FROM hr_leave WHERE emp_id=? AND status IN ('pending','approved') AND from_day<=? AND to_day>=? AND id!=?", $e['id'], $to, $from, $excludeId ?: 0),
            'There is already a leave request on these dates');
        $t = $this->ltype($b['type']);
        if (($t['quota'] ?? null) !== null) {
            $bal = null;
            foreach ($this->balances($e['id'], substr($from, 0, 4)) as $x) {
                if ($x['key'] === $t['key']) {
                    $bal = $x;
                    break;
                }
            }
            $this->need($bal['left'] >= $days, 'Not enough '.$t['name'].' leave left ('.self::str($bal['left']).' of '.self::str($t['quota']).' days left, asking for '.self::str($days).')');
        }
        return ['from_day' => $from, 'to_day' => $to, 'half' => $half ? 1 : 0, 'days' => $days];
    }

    private function lockedMonth($d): bool
    {
        $r = Db::get('SELECT status FROM hr_payroll WHERE month=?', substr(self::str($d), 0, 7));
        return $r && $r['status'] === 'approved';
    }

    /* ======================================================== advances */

    private function advInfo($empId, $upTo = null): array
    {
        $advs = Db::all('SELECT * FROM hr_advances WHERE emp_id=? AND day<=? ORDER BY day, id', $empId, $upTo ?: '9999-12-31');
        $recovered = Db::val("SELECT COALESCE(SUM(l.recovery),0) n FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? AND p.status='approved'", $empId);
        $given = array_sum(array_map(fn ($a) => self::n($a['amount']), $advs));
        $balance = max(0, self::r0($given - $recovered));
        $left = $recovered;
        $plan = 0;
        foreach ($advs as &$a) {
            $rem = max(0, $a['amount'] - $left);
            $left = max(0, $left - $a['amount']);
            $a['remaining'] = self::r0($rem);
            if ($rem > 0 && $a['monthly'] > 0) {
                $plan += min($a['monthly'], $rem);
            }
        }
        unset($a);
        return ['advances' => $advs, 'given' => self::r0($given), 'recovered' => self::r0($recovered), 'balance' => $balance, 'plan' => self::r0(min($plan, $balance))];
    }

    /* ======================================================== payroll */

    private function eligible(string $month): array
    {
        return Db::all('SELECT * FROM hr_employees WHERE join_date<=? AND (leave_date IS NULL OR leave_date>=?) ORDER BY department, name', self::monthEnd($month), $month.'-01');
    }

    private function calcLine(array $l): array
    {
        $full = self::n($l['basic'] ?? 0) + self::n($l['allowances'] ?? 0);
        $l['day_rate'] = self::num($full / 30);
        $l['gross'] = $l['emp_days'] < $l['days_month'] ? self::r0($full * $l['emp_days'] / $l['days_month']) : self::r0($full);
        $l['absence_ded'] = min($l['gross'], self::r0($l['day_rate'] * (self::n($l['absent'] ?? 0) + self::n($l['unpaid'] ?? 0))));
        $rule = $this->S()['late_rule'] ?? self::DEFAULTS['late_rule'];
        $rule = is_array($rule) ? $rule : self::DEFAULTS['late_rule'];
        $l['late_ded'] = min($l['gross'] - $l['absence_ded'], self::r0(floor(self::n($l['late'] ?? 0) / max(1, self::n($rule['per'] ?? null) ?: 3)) * self::n($rule['days'] ?? null) * $l['day_rate']));
        $l['earned'] = $l['gross'] - $l['absence_ded'] - $l['late_ded'];
        $l['net'] = self::r0($l['earned'] + self::n($l['incentive'] ?? 0) - self::n($l['other_ded'] ?? 0) - self::n($l['recovery'] ?? 0));
        return $l;
    }

    private function computeMonth(string $month): array
    {
        $from = $month.'-01';
        $to = self::monthEnd($month);
        $today = $this->pkToday();
        $cut = $to < $today ? $to : $today;
        $L = $this->load($from, $to);
        $days = self::range($from, $cut);
        $dm = count(self::range($from, $to));
        return array_map(function ($e) use ($month, $from, $to, $L, $days, $dm) {
            $t = $this->tally($e, $days, $L);
            $a = $this->advInfo($e['id'], $to);
            $s = $e['join_date'] > $from ? $e['join_date'] : $from;
            $en = $e['leave_date'] && $e['leave_date'] < $to ? $e['leave_date'] : $to;
            $l = ['month' => $month, 'emp_id' => $e['id'], 'name' => $e['name'], 'department' => $e['department'], 'designation' => $e['designation'], 'days_month' => $dm,
                'emp_days' => count(self::range($s, $en)), 'present' => $t['present'], 'late' => $t['late'], 'absent' => $t['absent'], 'leave_paid' => $t['leave'], 'unpaid' => $t['unpaid'],
                'off' => $t['off'], 'holiday' => $t['holiday'], 'basic' => self::n($e['basic']), 'allowances' => self::n($e['allowances']), 'incentive' => 0, 'incentive_note' => '',
                'other_ded' => 0, 'other_note' => '', 'recovery' => 0, 'recovery_manual' => 0, 'adv_balance' => $a['balance'], 'adv_plan' => $a['plan']];
            $l = $this->calcLine($l);
            $l['recovery'] = max(0, min($a['plan'], $l['earned']));
            return $this->calcLine($l);
        }, $this->eligible($month));
    }

    private function saveLine(array $l): void
    {
        $cols = self::LINE_COLS;
        Db::run('INSERT INTO hr_payslips('.implode(',', array_map(fn ($c) => "`$c`", $cols)).') VALUES('.implode(',', array_fill(0, count($cols), '?')).')
            ON DUPLICATE KEY UPDATE '.implode(',', array_map(fn ($c) => "`$c`=VALUES(`$c`)", array_slice($cols, 2))), ...array_map(fn ($c) => $l[$c] ?? null, $cols));
    }

    private function lines(string $month): array
    {
        return Db::all('SELECT * FROM hr_payslips WHERE month=? ORDER BY department, name', $month);
    }

    private function runRow($month): ?array
    {
        return Db::get('SELECT * FROM hr_payroll WHERE month=?', $month);
    }

    private static function totals(array $ls): array
    {
        $t = [];
        foreach (['gross', 'absence_ded', 'late_ded', 'earned', 'incentive', 'other_ded', 'recovery', 'net'] as $k) {
            $t[$k] = self::num(array_sum(array_map(fn ($l) => self::n($l[$k] ?? 0), $ls)));
        }
        $t['paid'] = self::num(array_sum(array_map(fn ($l) => $l['net'], array_filter($ls, fn ($l) => ! empty($l['paid'])))));
        $t['staff'] = count($ls);
        return $t;
    }

    private function payslip($month, $empId): ?array
    {
        $l = Db::get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=?', $month, $empId);
        if (! $l) {
            return null;
        }
        $e = $this->getEmp($empId) ?: [];
        $run = $this->runRow($month);
        return ['company' => ($this->S()['company'] ?? '') ?: $this->setting('store_name', 'SundayBazar'), 'month' => $month, 'month_name' => self::monthName($month), 'status' => $run ? $run['status'] : null,
            'line' => $l, 'employee' => ['id' => $e['id'] ?? null, 'name' => $e['name'] ?? null, 'department' => $e['department'] ?? null, 'designation' => $e['designation'] ?? null,
                'join_date' => $e['join_date'] ?? null, 'pay_method' => $e['pay_method'] ?? null, 'bank_account' => $e['bank_account'] ?? null, 'cnic' => $e['cnic'] ?? null],
            'adv_balance_after' => $this->advInfo($empId)['balance']];
    }

    private static function clientIp(Request $req): string
    {
        $xf = trim(explode(',', (string) $req->header('x-forwarded-for', ''))[0]);
        return preg_replace('/^::ffff:/', '', $xf ?: (string) ($req->server('REMOTE_ADDR') ?? ''));
    }

    /* ======================================================== accounts bridge */

    private function acc(): ?Module
    {
        $a = $this->svc('accounts');
        return $a && method_exists($a, 'post') ? $a : null;
    }

    private function accPost(array $entry, $uid)
    {
        $a = $this->acc();
        if (! $a) {
            return null;
        }
        return $a->post($entry, $uid);
    }

    private function accVoid(string $src, string $id, $uid): void
    {
        $a = $this->acc();
        if ($a && method_exists($a, 'void')) {
            $a->void($src, $id, $uid);
        }
    }

    private function myEmp(array $u): array
    {
        $e = $this->empForUser($u['id']);
        $this->need($e, 'Your login is not linked to an employee record yet. Ask HR.', 404);
        return $e;
    }

    private function isOwner(?array $u): bool
    {
        return ($u['role'] ?? null) === 'admin';
    }

    /* ======================================================== routes */

    public function routes(Router $r): void
    {
        $r->get('/api/hr/meta', 'dashboard', 'meta');
        $r->get('/api/hr/users', 'hr', 'users');
        $r->get('/api/hr/employees', 'dashboard', 'employees');
        $r->get('/api/hr/employees/:id', 'dashboard', 'employeeShow');
        $r->post('/api/hr/employees', 'hr', 'employeeAdd');
        $r->post('/api/hr/employees/:id', 'hr', 'employeeEdit');
        $r->post('/api/hr/employees/:id/warnings', 'hr', 'warningAdd');
        $r->delete('/api/hr/warnings/:id', 'hr', 'warningDelete');
        $r->get('/api/hr/settings', 'hr', 'settingsGet');
        $r->post('/api/hr/settings', 'hr', 'settingsSave');
        $r->get('/api/hr/holidays', 'dashboard', 'holidays');
        $r->post('/api/hr/holidays', 'hr', 'holidaySave');
        $r->delete('/api/hr/holidays/:day', 'hr', 'holidayDelete');
        $r->get('/api/hr/attendance', 'hr', 'attendanceDay');
        $r->get('/api/hr/register', 'hr', 'register');
        $r->post('/api/hr/attendance', 'hr', 'attendanceEdit');
        $r->get('/api/hr/me/today', 'me', 'meToday');
        $r->post('/api/hr/me/checkin', 'me', 'checkin');
        $r->post('/api/hr/me/checkout', 'me', 'checkout');
        $r->get('/api/hr/leave', 'hr', 'leaveList');
        $r->post('/api/hr/leave', 'hr', 'leaveAdd');
        $r->post('/api/hr/leave/:id/decide', 'hr', 'leaveDecide');
        $r->get('/api/hr/me', 'me', 'me');
        $r->post('/api/hr/me/leave', 'me', 'meLeave');
        $r->post('/api/hr/me/leave/:id/cancel', 'me', 'meLeaveCancel');
        $r->get('/api/hr/me/payslips/:month', 'me', 'mePayslip');
        $r->get('/api/hr/advances', 'payroll', 'advances');
        $r->post('/api/hr/advances', 'payroll', 'advanceAdd');
        $r->post('/api/hr/advances/:id/delete', 'payroll', 'advanceDelete');
        $r->get('/api/hr/payroll', 'payroll', 'payrollList');
        $r->get('/api/hr/payroll/:month', 'payroll', 'payrollShow');
        $r->post('/api/hr/payroll/:month/run', 'payroll', 'payrollRun');
        $r->post('/api/hr/payroll/:month/line/:emp', 'payroll', 'payrollLine');
        $r->post('/api/hr/payroll/:month/approve', 'payroll', 'payrollApprove');
        $r->post('/api/hr/payroll/:month/pay', 'payroll', 'payrollPay');
        $r->post('/api/hr/payroll/:month/unpay', 'payroll', 'payrollUnpay');
        $r->post('/api/hr/payroll/:month/reopen', 'payroll', 'payrollReopen');
        $r->post('/api/hr/payroll/:month/discard', 'payroll', 'payrollDiscard');
        $r->get('/api/hr/payroll/:month/payslip/:emp', 'payroll', 'payrollPayslip');
    }

    /* ----- employees ----- */

    public function meta(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return ['departments' => self::DEPTS, 'leave_types' => $this->ltypes(), 'today' => $this->pkToday(), 'now' => $this->pkNow()];
    }

    public function users(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT id,name,username,role FROM users WHERE active=1 ORDER BY name');
    }

    public function employees(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'hr') || $this->can($u, 'payroll') || $this->can($u, 'team'), 'Your account does not have access to this', 403);
        $st = [];
        foreach ($this->attendanceOn($this->pkToday()) as $r) {
            $st[$r['employee_id']] = $r;
        }
        $rows = Db::all("SELECT e.*, us.username FROM hr_employees e LEFT JOIN users us ON us.id=e.user_id ORDER BY e.status='left', e.name");
        if (! empty($qs['status'])) {
            $rows = array_filter($rows, fn ($e) => $e['status'] === $qs['status']);
        }
        if (! empty($qs['department'])) {
            $rows = array_filter($rows, fn ($e) => $e['department'] === $qs['department']);
        }
        if (! empty($qs['q'])) {
            $s = mb_strtolower(self::str($qs['q']));
            $rows = array_filter($rows, function ($e) use ($s) {
                foreach (['name', 'phone', 'designation', 'department', 'username'] as $k) {
                    if (str_contains(mb_strtolower(self::str($e[$k] ?? '')), $s)) {
                        return true;
                    }
                }
                return false;
            });
        }
        return array_values(array_map(fn ($e) => $this->pub($e, $u) + ['today' => isset($st[$e['id']]) ? ['status' => $st[$e['id']]['detail'], 'in_at' => $st[$e['id']]['in_at'], 'late_min' => $st[$e['id']]['late_min']] : null], $rows));
    }

    public function employeeShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'hr') || $this->can($u, 'payroll'), 'Your account does not have access to this', 403);
        $e = $this->getEmp($p['id']);
        $this->need($e, 'Not found', 404);
        $month = self::isMonth($qs['month'] ?? null) ? $qs['month'] : substr($this->pkToday(), 0, 7);
        $to = self::monthEnd($month);
        $t = $this->tally($e, self::range($month.'-01', $to), $this->load($month.'-01', $to));
        $labels = Erp::activityLabels();
        return ['employee' => $this->pub($e, $u), 'user' => $e['user_id'] ? Db::get('SELECT id,name,username,role,active FROM users WHERE id=?', $e['user_id']) : null, 'month' => $month, 'attendance' => $t,
            'leaves' => Db::all('SELECT * FROM hr_leave WHERE emp_id=? ORDER BY from_day DESC LIMIT 100', $e['id']), 'balances' => $this->balances($e['id'], substr($this->pkToday(), 0, 4)),
            'advances' => $this->advInfo($e['id']),
            'payslips' => Db::all('SELECT l.month,l.gross,l.net,l.paid,p.status FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? ORDER BY l.month DESC', $e['id']),
            'warnings' => $this->can($u, 'hr') ? Db::all('SELECT w.*, us.name by_name FROM hr_warnings w LEFT JOIN users us ON us.id=w.user_id WHERE emp_id=? ORDER BY day DESC, id DESC', $e['id']) : [],
            'history' => array_map(fn ($x) => $x + ['label' => ($labels[$x['action']] ?? null) ?: $x['action']],
                Db::all('SELECT ev.at, ev.action, ev.detail, us.name user FROM events ev LEFT JOIN users us ON us.id=ev.user_id WHERE ev.entity=? ORDER BY ev.id DESC LIMIT 40', 'employee:'.$e['id']))];
    }

    private function saveEmp(array $u, array $b, ?int $id): array
    {
        $cur = $id ? $this->getEmp($id) : null;
        if ($id) {
            $this->need($cur, 'Not found', 404);
        }
        $v = $cur ?: ['status' => 'active', 'shift_start' => '09:00', 'shift_end' => '18:00', 'grace_min' => 15, 'off_days' => '[0]', 'pay_method' => 'Bank', 'docs' => '[]', 'join_date' => $this->pkToday()];
        foreach (self::FIELDS as $k) {
            if (array_key_exists($k, $b)) {
                $v[$k] = $b[$k];
            }
        }
        $v['name'] = trim(self::str(($v['name'] ?? '') ?: ''));
        $this->need($v['name'] !== '', 'Name is required');
        $this->need(in_array($v['status'] ?? null, ['active', 'notice', 'left'], true), 'Bad status');
        $this->need(self::isDay($v['join_date'] ?? null), 'Join date is required');
        foreach (['shift_start', 'shift_end'] as $k) {
            $this->need(self::toMin($v[$k] ?? null) !== null, 'Shift times look wrong (use HH:MM)');
        }
        $v['user_id'] = ! empty($v['user_id']) ? (int) self::n($v['user_id']) : null;
        if ($v['user_id']) {
            $this->need(Db::get('SELECT id FROM users WHERE id=?', $v['user_id']), 'That login does not exist');
            $this->need(! Db::get('SELECT id FROM hr_employees WHERE user_id=? AND id!=?', $v['user_id'], $id ?: 0), 'That login is already linked to another employee');
        }
        if ($v['status'] === 'left') {
            $v['leave_date'] = ($v['leave_date'] ?? null) ?: $this->pkToday();
            $this->need(self::isDay($v['leave_date']), 'Leaving date is wrong');
        } elseif ($v['status'] === 'active') {
            $v['leave_date'] = null;
        }
        if (isset($v['off_days']) && is_array($v['off_days'])) {
            $v['off_days'] = json_encode(array_values(array_filter(array_map(fn ($x) => self::n($x), $v['off_days']), fn ($n) => $n >= 0 && $n <= 6)));
        }
        if (isset($v['docs']) && is_array($v['docs'])) {
            $v['docs'] = json_encode(array_values(array_map(fn ($d) => ['id' => self::str($d['id']), 'name' => mb_substr(self::str(($d['name'] ?? '') ?: 'Document'), 0, 80)],
                array_filter($v['docs'], fn ($d) => is_array($d) && ! empty($d['id'])))), JSON_UNESCAPED_UNICODE);
        }
        foreach (['basic', 'allowances', 'grace_min'] as $k) {
            $v[$k] = max(0, self::n($v[$k] ?? null));
        }
        $cols = self::FIELDS;
        $vals = array_map(fn ($c) => $v[$c] ?? null, $cols);
        if ($cur) {
            Db::run('UPDATE hr_employees SET '.implode(',', array_map(fn ($c) => "`$c`=?", $cols)).', updated_at=UTC_TIMESTAMP() WHERE id=?', ...[...$vals, $id]);
        } else {
            $id = Db::run('INSERT INTO hr_employees('.implode(',', array_map(fn ($c) => "`$c`", $cols)).') VALUES('.implode(',', array_fill(0, count($cols), '?')).')', ...$vals)->lastInsertRowid;
        }
        if ($cur) {
            $changed = [];
            foreach ($cols as $c) {
                if (self::str($cur[$c] ?? null) !== self::str($v[$c] ?? null)) {
                    $changed[$c] = in_array($c, self::SENSITIVE, true) ? '(changed)' : $v[$c];
                }
            }
            $changed = (object) $changed;
        } else {
            $changed = ['name' => $v['name']];
        }
        $left = $v['status'] === 'left' && $cur && $cur['status'] !== 'left';
        $this->log($u['id'], $cur ? ($left ? 'hr.employee.left' : 'hr.employee.save') : 'hr.employee.add', 'employee:'.$id,
            $left ? ['date' => $v['leave_date'], 'reason' => $v['leave_reason'] ?? null] : $changed);
        return ['ok' => true, 'id' => (int) $id];
    }

    public function employeeAdd(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->saveEmp($u, $b, null);
    }

    public function employeeEdit(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->saveEmp($u, $b, (int) $p['id']);
    }

    /* ----- warnings ----- */

    public function warningAdd(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->getEmp($p['id']);
        $this->need($e, 'Not found', 404);
        $this->need(in_array($b['type'] ?? null, ['verbal', 'written', 'final', 'note', 'praise'], true), 'Choose a type');
        $this->need(trim(self::str(($b['note'] ?? '') ?: '')) !== '', 'Write what happened');
        $id = Db::run('INSERT INTO hr_warnings(emp_id,day,type,note,file,user_id) VALUES(?,?,?,?,?,?)', $e['id'], self::isDay($b['day'] ?? null) ? $b['day'] : $this->pkToday(), $b['type'],
            trim(self::str($b['note'])), ($b['file'] ?? null) ?: null, $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'hr.warning', 'employee:'.$e['id'], ['type' => $b['type'], 'note' => mb_substr(self::str($b['note']), 0, 200)]);
        return ['ok' => true, 'id' => $id];
    }

    public function warningDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = Db::get('SELECT * FROM hr_warnings WHERE id=?', (int) $p['id']);
        $this->need($w, 'Not found', 404);
        Db::run('DELETE FROM hr_warnings WHERE id=?', $w['id']);
        $this->log($u['id'], 'hr.warning.delete', 'employee:'.$w['emp_id'], $w['type']);
        return ['ok' => true];
    }

    /* ----- settings & holidays ----- */

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->S() + ['time_override' => (bool) $this->setting('hr.time_override', false), 'your_ip' => self::clientIp($req)];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $cur = $this->S();
        $v = $this->setting('hr.settings', []);
        $v = is_array($v) ? $v : [];
        if (array_key_exists('allowed_ips', $b)) {
            $ips = $b['allowed_ips'];
            $list = is_array($ips) ? $ips : preg_split('/[,\s]+/u', $ips === null ? 'null' : self::str($ips));
            $v['allowed_ips'] = array_values(array_filter(array_map(fn ($s) => trim(self::str($s)), $list), fn ($s) => $s !== ''));
        }
        if (! empty($b['late_rule'])) {
            $lr = is_array($b['late_rule']) ? $b['late_rule'] : [];
            $per = array_key_exists('per', $lr) ? self::jsNum($lr['per']) : NAN;
            $days = array_key_exists('days', $lr) ? self::jsNum($lr['days']) : NAN;
            $this->need($per >= 1 && $days >= 0, 'Late rule looks wrong');
            $v['late_rule'] = ['per' => Logic::jsRound($per), 'days' => $days];
        }
        if (! empty($b['leave_types'])) {
            $lt = $b['leave_types'];
            $this->need(is_array($lt) && array_is_list($lt) && ! array_filter($lt, fn ($t) => ! is_array($t) || empty($t['key']) || empty($t['name'])), 'Leave types look wrong');
            $v['leave_types'] = array_map(fn ($t) => ['key' => self::str($t['key']), 'name' => self::str($t['name']),
                'quota' => ! isset($t['quota']) || $t['quota'] === '' ? null : self::n($t['quota']), 'paid' => ($t['paid'] ?? null) !== false], $lt);
        }
        if (isset($b['absent_alert_min'])) {
            $v['absent_alert_min'] = max(0, self::n($b['absent_alert_min']));
        }
        if (isset($b['company'])) {
            $v['company'] = mb_substr(self::str($b['company']), 0, 80);
        }
        if (array_key_exists('time_override', $b)) {
            $this->need($this->isOwner($u), 'Only the owner can change this', 403);
            $this->setSetting('hr.time_override', (bool) $b['time_override']);
        }
        $this->setSetting('hr.settings', $v ?: (object) []);
        $this->log($u['id'], 'hr.settings', 'hr', ['before' => ['ips' => $cur['allowed_ips'] ?? null, 'late' => $cur['late_rule'] ?? null],
            'after' => ['ips' => $v['allowed_ips'] ?? null, 'late' => $v['late_rule'] ?? null]]);
        return ['ok' => true];
    }

    public function holidays(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT * FROM hr_holidays WHERE SUBSTR(day,1,4)=? ORDER BY day', self::str(($qs['year'] ?? null) ?: substr($this->pkToday(), 0, 4)));
    }

    public function holidaySave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(self::isDay($b['day'] ?? null), 'Pick a date');
        $this->need(trim(self::str(($b['name'] ?? '') ?: '')) !== '', 'Name the holiday');
        $this->need(! $this->lockedMonth($b['day']), 'Payroll for that month is approved; ask the owner to reopen it first');
        Db::run('INSERT INTO hr_holidays(day,name) VALUES(?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', $b['day'], trim(self::str($b['name'])));
        $this->log($u['id'], 'hr.holiday', 'holiday:'.$b['day'], $b['name']);
        return ['ok' => true];
    }

    public function holidayDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(! $this->lockedMonth($p['day']), 'Payroll for that month is approved');
        Db::run('DELETE FROM hr_holidays WHERE day=?', $p['day']);
        $this->log($u['id'], 'hr.holiday.delete', 'holiday:'.$p['day'], '');
        return ['ok' => true];
    }

    /* ----- attendance (HR) ----- */

    public function attendanceDay(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $d = self::isDay($qs['date'] ?? null) ? $qs['date'] : $this->pkToday();
        $rows = $this->attendanceOn($d);
        $L = $this->load($d, $d);
        $sum = [];
        foreach (['present', 'late', 'absent', 'leave', 'off', 'holiday', 'not_yet'] as $s) {
            $sum[$s] = count(array_filter($rows, fn ($r) => $r['status'] === $s));
        }
        return ['date' => $d, 'today' => $this->pkToday(), 'holiday' => $L['hol'][$d] ?? null, 'rows' => $rows, 'summary' => $sum];
    }

    public function register(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $month = self::isMonth($qs['month'] ?? null) ? $qs['month'] : substr($this->pkToday(), 0, 7);
        $to = self::monthEnd($month);
        $days = self::range($month.'-01', $to);
        $L = $this->load($month.'-01', $to);
        $emps = Db::all('SELECT * FROM hr_employees WHERE join_date<=? AND (leave_date IS NULL OR leave_date>=?) ORDER BY department, name', $to, $month.'-01');
        return ['month' => $month, 'days' => array_map(fn ($d) => ['d' => $d, 'wd' => self::wd($d), 'hol' => $L['hol'][$d] ?? null], $days),
            'rows' => array_map(function ($e) use ($days, $L) {
                $t = $this->tally($e, $days, $L);
                return array_merge(['id' => $e['id'], 'name' => $e['name'], 'department' => $e['department']], $t, ['cells' => array_column($t['cells'], 'c')]);
            }, $emps)];
    }

    private function fixAtt(array $e, array $row): array
    {
        $ss = self::toMin($e['shift_start']) ?? 540;
        $se = self::toMin($e['shift_end']) ?? 1080;
        $inM = ! empty($row['in_at']) ? self::toMin(substr($row['in_at'], 11, 5)) : null;
        $outM = ! empty($row['out_at']) ? self::toMin(substr($row['out_at'], 11, 5)) : null;
        $row['late_min'] = $inM !== null && $inM > $ss + self::n($e['grace_min']) ? $inM - $ss : 0;
        $row['early_min'] = ! empty($row['out_at']) && ($outM ?? 0) < $se && substr($row['out_at'], 0, 10) === $row['day'] ? $se - ($outM ?? 0) : 0;
        $row['minutes'] = ! empty($row['in_at']) && ! empty($row['out_at']) ? max(0, self::minDiff($row['in_at'], $row['out_at'])) : null;
        return $row;
    }

    public function attendanceEdit(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->getEmp($b['emp_id'] ?? null);
        $this->need($e, 'Choose an employee');
        $day = $b['day'] ?? null;
        $this->need(self::isDay($day), 'Choose a date');
        $this->need($day <= $this->pkToday(), 'Cannot mark attendance for a future date');
        $this->need(trim(self::str(($b['reason'] ?? '') ?: '')) !== '', 'Write a reason for this change (it is recorded)');
        $this->need(! $this->lockedMonth($day), 'Payroll for that month is approved; ask the owner to reopen it first');
        $old = Db::get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', $e['id'], $day);
        if (! empty($b['clear'])) {
            if ($old) {
                Db::run('DELETE FROM hr_attendance WHERE id=?', $old['id']);
            }
            $this->log($u['id'], 'hr.attendance.edit', 'employee:'.$e['id'], ['day' => $day, 'before' => $old ? ['in' => $old['in_at'], 'out' => $old['out_at']] : null, 'after' => 'absent', 'reason' => $b['reason']]);
            return ['ok' => true];
        }
        $this->need(self::toMin($b['in_time'] ?? null) !== null, 'Enter the check-in time (HH:MM)');
        $row = $this->fixAtt($e, ['day' => $day, 'in_at' => $day.' '.substr(self::str($b['in_time']), 0, 5).':00',
            'out_at' => self::toMin($b['out_time'] ?? null) !== null ? $day.' '.substr(self::str($b['out_time']), 0, 5).':00' : null]);
        if ($row['out_at']) {
            $this->need(strcmp($row['out_at'], $row['in_at']) > 0, 'Check-out must be after check-in');
        }
        $half = ! empty($b['half']) ? 1 : 0;
        $note = mb_substr(trim(self::str($b['reason'])), 0, 300);
        if ($old) {
            Db::run("UPDATE hr_attendance SET in_at=?, out_at=?, late_min=?, early_min=?, minutes=?, half=?, source='hr', note=?, edited_by=?, edited_at=UTC_TIMESTAMP() WHERE id=?",
                $row['in_at'], $row['out_at'], $row['late_min'], $row['early_min'], $row['minutes'], $half, $note, $u['id'], $old['id']);
        } else {
            Db::run("INSERT INTO hr_attendance(emp_id,day,in_at,out_at,late_min,early_min,minutes,half,source,note,edited_by,edited_at) VALUES(?,?,?,?,?,?,?,?,'hr',?,?,UTC_TIMESTAMP())",
                $e['id'], $day, $row['in_at'], $row['out_at'], $row['late_min'], $row['early_min'], $row['minutes'], $half, $note, $u['id']);
        }
        $this->log($u['id'], 'hr.attendance.edit', 'employee:'.$e['id'], ['day' => $day, 'before' => $old ? ['in' => $old['in_at'], 'out' => $old['out_at'], 'half' => $old['half']] : null,
            'after' => ['in' => $row['in_at'], 'out' => $row['out_at'], 'half' => $half], 'reason' => $note]);
        return ['ok' => true, 'late_min' => $row['late_min'], 'early_min' => $row['early_min'], 'minutes' => $row['minutes']];
    }

    /* ----- self check-in / check-out ----- */

    private function stamp(array $u, array $b): string
    {
        if (! empty($b['at'])) {
            $this->need($this->isOwner($u) || $this->setting('hr.time_override', false) === true, 'Time override is not allowed', 403);
            $this->need(is_string($b['at']) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/', $b['at']) === 1, 'Bad time');
            return strlen($b['at']) === 16 ? $b['at'].':00' : $b['at'];
        }
        return $this->pkNow();
    }

    private function ipCheck(Request $req): string
    {
        $ip = self::clientIp($req);
        $allow = $this->S()['allowed_ips'] ?? [];
        $allow = is_array($allow) ? $allow : [];
        $ok = ! $allow;
        foreach ($allow as $pre) {
            if (str_starts_with($ip, self::str($pre))) {
                $ok = true;
                break;
            }
        }
        $this->need($ok, 'Check-in only works on the office WiFi/network. Your device ('.($ip ?: 'unknown').') is not on it.', 403);
        return $ip;
    }

    public function meToday(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->empForUser($u['id']);
        if (! $e || $e['status'] === 'left') {
            return ['linked' => false];
        }
        $d = $this->pkToday();
        $a = Db::get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', $e['id'], $d);
        $open = Db::get('SELECT * FROM hr_attendance WHERE emp_id=? AND out_at IS NULL AND in_at IS NOT NULL AND day>=? ORDER BY day DESC LIMIT 1', $e['id'], self::addDays($d, -1));
        return ['linked' => true, 'name' => $e['name'], 'shift_start' => $e['shift_start'], 'shift_end' => $e['shift_end'], 'today' => $a ?: null,
            'open' => $open && self::minDiff($open['in_at'], $this->pkNow()) < 20 * 60 ? $open : null];
    }

    public function checkin(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->myEmp($u);
        $this->need($e['status'] !== 'left', 'Your employee record is marked as left', 403);
        $ip = $this->ipCheck($req);
        $at = $this->stamp($u, $b);
        $d = substr($at, 0, 10);
        $old = Db::get('SELECT * FROM hr_attendance WHERE emp_id=? AND day=?', $e['id'], $d);
        $this->need(! $old || ! $old['in_at'], 'You already checked in today at '.($old && $old['in_at'] ? substr($old['in_at'], 11, 5) : ''));
        $row = $this->fixAtt($e, ['day' => $d, 'in_at' => $at, 'out_at' => null]);
        if ($old) {
            Db::run("UPDATE hr_attendance SET in_at=?, in_ip=?, late_min=?, source='self' WHERE id=?", $at, $ip, $row['late_min'], $old['id']);
        } else {
            Db::run("INSERT INTO hr_attendance(emp_id,day,in_at,in_ip,late_min,source) VALUES(?,?,?,?,?,'self')", $e['id'], $d, $at, $ip, $row['late_min']);
        }
        $this->log($u['id'], 'hr.checkin', 'employee:'.$e['id'], ['at' => $at, 'ip' => $ip, 'late_min' => $row['late_min']]);
        return ['ok' => true, 'in_at' => $at, 'late_min' => $row['late_min'], 'ip' => $ip];
    }

    public function checkout(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->myEmp($u);
        $ip = $this->ipCheck($req);
        $at = $this->stamp($u, $b);
        $a = Db::get('SELECT * FROM hr_attendance WHERE emp_id=? AND in_at IS NOT NULL AND out_at IS NULL AND day>=? AND day<=? ORDER BY day DESC LIMIT 1', $e['id'], self::addDays(substr($at, 0, 10), -1), substr($at, 0, 10));
        $this->need($a && self::minDiff($a['in_at'], $at) < 20 * 60, 'You have not checked in yet');
        $this->need(strcmp($at, $a['in_at']) > 0, 'Check-out time is before check-in');
        $row = $this->fixAtt($e, array_merge($a, ['out_at' => $at]));
        Db::run('UPDATE hr_attendance SET out_at=?, out_ip=?, early_min=?, minutes=? WHERE id=?', $at, $ip, $row['early_min'], $row['minutes'], $a['id']);
        $this->log($u['id'], 'hr.checkout', 'employee:'.$e['id'], ['at' => $at, 'ip' => $ip, 'minutes' => $row['minutes'], 'early_min' => $row['early_min']]);
        return ['ok' => true, 'out_at' => $at, 'minutes' => $row['minutes'], 'hours' => self::num(Logic::jsRound($row['minutes'] / 6) / 10), 'early_min' => $row['early_min']];
    }

    /* ----- leave ----- */

    public function leaveList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $st = in_array($qs['status'] ?? null, ['pending', 'approved', 'rejected', 'cancelled'], true) ? $qs['status'] : null;
        $rows = Db::all('SELECT l.*, e.name, e.department, us.name decided_name FROM hr_leave l JOIN hr_employees e ON e.id=l.emp_id LEFT JOIN users us ON us.id=l.decided_by '
            .($st ? 'WHERE l.status=? ' : '').'ORDER BY '.($st === 'pending' ? 'l.from_day' : 'l.id DESC').' LIMIT 300', ...($st ? [$st] : []));
        $yr = substr($this->pkToday(), 0, 4);
        $rows = array_map(function ($r) {
            if ($r['status'] === 'pending') {
                foreach ($this->balances($r['emp_id'], substr((string) $r['from_day'], 0, 4)) as $x) {
                    if ($x['key'] === $r['type']) {
                        $r['balance'] = $x['left'];
                        break;
                    }
                }
            }
            return $r;
        }, $rows);
        return ['rows' => $rows, 'types' => $this->ltypes(), 'pending' => (int) Db::val("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'"),
            'balances' => array_map(fn ($e) => $e + ['balances' => $this->balances($e['id'], $yr)], Db::all("SELECT id,name,department FROM hr_employees WHERE status!='left' ORDER BY name"))];
    }

    public function leaveAdd(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->getEmp($b['emp_id'] ?? null);
        $this->need($e, 'Choose an employee');
        $v = $this->checkLeave($e, $b);
        $status = ! empty($b['pending']) ? 'pending' : 'approved';
        if ($status === 'approved') {
            $this->need(! $this->lockedMonth($v['from_day']) && ! $this->lockedMonth($v['to_day']), 'Payroll for that month is approved');
        }
        $id = Db::run('INSERT INTO hr_leave(emp_id,type,from_day,to_day,half,days,reason,status,decided_by,decided_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', $e['id'], $b['type'], $v['from_day'], $v['to_day'],
            $v['half'], $v['days'], mb_substr(self::str(($b['reason'] ?? '') ?: ''), 0, 300), $status, $status === 'approved' ? $u['id'] : null, $status === 'approved' ? $this->pkNow() : null, $u['id'])->lastInsertRowid;
        $this->log($u['id'], $status === 'approved' ? 'hr.leave.approve' : 'hr.leave.request', 'employee:'.$e['id'], ['type' => $b['type'], 'from' => $v['from_day'], 'to' => $v['to_day'], 'days' => $v['days']]);
        return ['ok' => true, 'id' => $id, 'days' => $v['days']];
    }

    public function leaveDecide(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $l = Db::get('SELECT * FROM hr_leave WHERE id=?', (int) $p['id']);
        $this->need($l, 'Not found', 404);
        $status = $b['status'] ?? null;
        $this->need($l['status'] === 'pending' || ($status === 'cancelled' && $l['status'] === 'approved'), 'This request is already '.$l['status']);
        $this->need(in_array($status, ['approved', 'rejected', 'cancelled'], true), 'Approve or reject');
        $this->need(! $this->lockedMonth($l['from_day']) && ! $this->lockedMonth($l['to_day']), 'Payroll for that month is approved; ask the owner to reopen it first');
        if ($status === 'approved') {
            $e = $this->getEmp($l['emp_id']);
            $this->checkLeave($e, ['type' => $l['type'], 'from_day' => $l['from_day'], 'to_day' => $l['to_day'], 'half' => $l['half']], $l['id']);
        }
        Db::run('UPDATE hr_leave SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?', $status, $u['id'], $this->pkNow(), mb_substr(self::str(($b['note'] ?? '') ?: ''), 0, 300), $l['id']);
        $this->log($u['id'], 'hr.leave.'.['approved' => 'approve', 'rejected' => 'reject', 'cancelled' => 'cancel'][$status], 'employee:'.$l['emp_id'],
            ['type' => $l['type'], 'from' => $l['from_day'], 'to' => $l['to_day'], 'days' => $l['days'], 'note' => ($b['note'] ?? null) ?: '']);
        return ['ok' => true];
    }

    /* ----- my page (self only) ----- */

    public function me(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->empForUser($u['id']);
        if (! $e) {
            return ['employee' => null];
        }
        $today = $this->pkToday();
        $month = self::isMonth($qs['month'] ?? null) ? $qs['month'] : substr($today, 0, 7);
        $to = self::monthEnd($month);
        $L = $this->load($month.'-01', $to);
        $t = $this->tally($e, self::range($month.'-01', $to), $L);
        $st = $this->dayStatus($e, $today, $this->load($today, $today));
        $a = $this->advInfo($e['id']);
        $sa = $st['a'] ?? null;
        $tod = ['status' => $st['s']];
        if ($sa) {
            $tod += ['in_at' => $sa['in_at'], 'out_at' => $sa['out_at']];
        }
        $tod['late_min'] = $sa ? $sa['late_min'] : 0;
        if ($sa) {
            $tod['minutes'] = $sa['minutes'];
        }
        return ['employee' => ['id' => $e['id'], 'name' => $e['name'], 'department' => $e['department'], 'designation' => $e['designation'], 'status' => $e['status'], 'shift_start' => $e['shift_start'],
            'shift_end' => $e['shift_end'], 'grace_min' => $e['grace_min'], 'join_date' => $e['join_date'], 'off_days' => self::offs($e)],
            'today' => $tod, 'month' => $month, 'attendance' => $t, 'balances' => $this->balances($e['id'], substr($today, 0, 4)), 'types' => $this->ltypes(),
            'leaves' => Db::all('SELECT id,type,from_day,to_day,half,days,reason,status,decision_note FROM hr_leave WHERE emp_id=? ORDER BY id DESC LIMIT 20', $e['id']),
            'advance' => ['balance' => $a['balance'], 'given' => $a['given'], 'recovered' => $a['recovered'],
                'advances' => array_map(fn ($x) => ['day' => $x['day'], 'amount' => $x['amount'], 'monthly' => $x['monthly'], 'remaining' => $x['remaining']], $a['advances'])],
            'payslips' => Db::all("SELECT l.month,l.net,l.paid,l.paid_at FROM hr_payslips l JOIN hr_payroll p ON p.month=l.month WHERE l.emp_id=? AND p.status='approved' ORDER BY l.month DESC LIMIT 24", $e['id'])];
    }

    public function meLeave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->myEmp($u);
        $this->need($e['status'] !== 'left', 'Your employee record is marked as left', 403);
        $v = $this->checkLeave($e, $b);
        $this->need($v['from_day'] >= self::addDays($this->pkToday(), -7), 'For leave older than a week, ask HR to record it');
        $id = Db::run("INSERT INTO hr_leave(emp_id,type,from_day,to_day,half,days,reason,status,created_by) VALUES(?,?,?,?,?,?,?,'pending',?)", $e['id'], $b['type'], $v['from_day'], $v['to_day'], $v['half'], $v['days'],
            mb_substr(self::str(($b['reason'] ?? '') ?: ''), 0, 300), $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'hr.leave.request', 'employee:'.$e['id'], ['type' => $b['type'], 'from' => $v['from_day'], 'to' => $v['to_day'], 'days' => $v['days']]);
        return ['ok' => true, 'id' => $id, 'days' => $v['days']];
    }

    public function meLeaveCancel(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->myEmp($u);
        $l = Db::get('SELECT * FROM hr_leave WHERE id=? AND emp_id=?', (int) $p['id'], $e['id']);
        $this->need($l, 'Not found', 404);
        $this->need($l['status'] === 'pending', 'Only pending requests can be cancelled');
        Db::run("UPDATE hr_leave SET status='cancelled', decided_by=?, decided_at=? WHERE id=?", $u['id'], $this->pkNow(), $l['id']);
        $this->log($u['id'], 'hr.leave.cancel', 'employee:'.$e['id'], ['from' => $l['from_day']]);
        return ['ok' => true];
    }

    public function mePayslip(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->myEmp($u);
        $run = $this->runRow($p['month']);
        $this->need($run && $run['status'] === 'approved', 'Payslip not ready yet', 404);
        $s = $this->payslip($p['month'], $e['id']);
        $this->need($s, 'No payslip for this month', 404);
        return $s;
    }

    /* ----- advances ----- */

    public function advances(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $emps = Db::all('SELECT id,name,department,status FROM hr_employees ORDER BY name');
        $list = Db::all('SELECT a.*, e.name, us.name by_name FROM hr_advances a JOIN hr_employees e ON e.id=a.emp_id LEFT JOIN users us ON us.id=a.user_id ORDER BY a.day DESC, a.id DESC LIMIT 300');
        $bal = [];
        foreach ($emps as $e) {
            $x = array_merge($e, $this->advInfo($e['id']));
            unset($x['advances']);
            if ($x['given'] > 0) {
                $bal[] = $x;
            }
        }
        return ['list' => $list, 'balances' => $bal, 'accounts' => (bool) $this->acc()];
    }

    public function advanceAdd(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $e = $this->getEmp($b['emp_id'] ?? null);
        $this->need($e, 'Choose an employee');
        $amount = self::n($b['amount'] ?? null);
        $this->need($amount > 0, 'Enter the amount');
        $this->need(in_array($b['method'] ?? null, ['Cash', 'Meezan (SB)'], true), 'Paid from Cash or Meezan (SB)?');
        $day = self::isDay($b['day'] ?? null) ? $b['day'] : $this->pkToday();
        $monthly = max(0, self::n($b['monthly'] ?? null));
        // no Db::tx around accounts calls (the accounts module may open its own transaction); undo by hand on failure
        $id = Db::run('INSERT INTO hr_advances(emp_id,day,amount,method,monthly,note,user_id) VALUES(?,?,?,?,?,?,?)', $e['id'], $day, $amount, $b['method'], $monthly,
            mb_substr(self::str(($b['note'] ?? '') ?: ''), 0, 200), $u['id'])->lastInsertRowid;
        $j = null;
        try {
            $j = $this->accPost(['date' => $day, 'memo' => 'Advance to '.$e['name'].(! empty($b['note']) ? ' · '.self::str($b['note']) : ''), 'source' => 'hr-advance', 'source_id' => (string) $id,
                'lines' => [['account' => 'Employees Advance', 'debit' => $amount, 'party' => 'employee:'.$e['id']], ['account' => $b['method'], 'credit' => $amount]]], $u['id']);
        } catch (\Throwable $x) {
            Db::run('DELETE FROM hr_advances WHERE id=?', $id);
            throw new HttpError(400, 'Could not post to accounts: '.$x->getMessage());
        }
        if ($j !== null) {
            Db::run('UPDATE hr_advances SET posted=1 WHERE id=?', $id);
        }
        $this->log($u['id'], 'hr.advance', 'employee:'.$e['id'], ['amount' => $amount, 'method' => $b['method'], 'monthly' => $monthly]);
        return ['ok' => true, 'id' => (int) $id, 'posted' => $j !== null, 'journal' => $j, 'balance' => $this->advInfo($e['id'])['balance']];
    }

    public function advanceDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $a = Db::get('SELECT * FROM hr_advances WHERE id=?', (int) $p['id']);
        $this->need($a, 'Not found', 404);
        $info = $this->advInfo($a['emp_id']);
        $this->need($info['balance'] >= $a['amount'], 'Part of this advance was already recovered in payroll; it cannot be deleted');
        if ($a['posted']) {
            $this->accVoid('hr-advance', (string) $a['id'], $u['id']);
        }
        Db::run('DELETE FROM hr_advances WHERE id=?', $a['id']);
        $this->log($u['id'], 'hr.advance.delete', 'employee:'.$a['emp_id'], ['amount' => $a['amount']]);
        return ['ok' => true];
    }

    /* ----- payroll ----- */

    public function payrollList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return array_map(fn ($r) => array_merge($r, self::totals($this->lines($r['month']))), Db::all('SELECT * FROM hr_payroll ORDER BY month DESC'));
    }

    public function payrollShow(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need(self::isMonth($p['month']), 'Bad month');
        $run = $this->runRow($p['month']);
        $ls = $run ? $this->lines($p['month']) : $this->computeMonth($p['month']);
        return ['month' => $p['month'], 'month_name' => self::monthName($p['month']), 'run' => $run ?: null, 'lines' => $ls, 'totals' => self::totals($ls), 'rule' => $this->S()['late_rule'] ?? null,
            'accounts' => (bool) $this->acc(), 'owner' => $this->isOwner($u), 'current' => $p['month'] >= substr($this->pkToday(), 0, 7)];
    }

    public function payrollRun(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $month = $p['month'];
        $this->need(self::isMonth($month), 'Bad month');
        $this->need($month <= substr($this->pkToday(), 0, 7), 'That month has not started yet');
        $run = $this->runRow($month);
        $this->need(! $run || $run['status'] === 'draft', 'Payroll for this month is approved and locked');
        $old = [];
        foreach ($this->lines($month) as $l) {
            $old[$l['emp_id']] = $l;
        }
        Db::tx(function () use ($run, $month, $u, $old) {
            if (! $run) {
                Db::run('INSERT INTO hr_payroll(month,status,created_by) VALUES(?,?,?)', $month, 'draft', $u['id']);
            }
            Db::run('DELETE FROM hr_payslips WHERE month=?', $month);
            foreach ($this->computeMonth($month) as $l) {
                $o = $old[$l['emp_id']] ?? null;
                if ($o) {
                    $l = array_merge($l, ['incentive' => $o['incentive'], 'incentive_note' => $o['incentive_note'], 'other_ded' => $o['other_ded'], 'other_note' => $o['other_note']]);
                    if ($o['recovery_manual']) {
                        $l = array_merge($l, ['recovery' => min($o['recovery'], $l['adv_balance']), 'recovery_manual' => 1]);
                    }
                }
                $this->saveLine($this->calcLine($l));
            }
        });
        $this->log($u['id'], 'hr.payroll.run', 'payroll:'.$month, self::totals($this->lines($month)));
        return ['ok' => true, 'lines' => count($this->lines($month))];
    }

    public function payrollLine(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow($p['month']);
        $this->need($run, 'Run the payroll first');
        $this->need($run['status'] === 'draft', 'Payroll for this month is approved and locked');
        $l = Db::get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=?', $p['month'], (int) $p['emp']);
        $this->need($l, 'Not found', 404);
        foreach (['incentive', 'other_ded'] as $k) {
            if (isset($b[$k])) {
                $this->need(self::jsNum($b[$k]) >= 0, 'Amounts cannot be negative');
                $l[$k] = self::r0($b[$k]);
            }
        }
        foreach (['incentive_note', 'other_note'] as $k) {
            if (isset($b[$k])) {
                $l[$k] = mb_substr(self::str($b[$k]), 0, 200);
            }
        }
        if (isset($b['recovery'])) {
            $bal = $this->advInfo($l['emp_id'], self::monthEnd($p['month']))['balance'];
            $rv = self::jsNum($b['recovery']);
            $this->need($rv >= 0 && $rv <= $bal, 'Recovery must be between 0 and the advance balance ('.$bal.')');
            $l['recovery'] = self::r0($b['recovery']);
            $l['recovery_manual'] = 1;
        }
        $l = $this->calcLine($l);
        $this->need($l['net'] >= 0, 'Net pay would be negative; lower the deductions or recovery');
        $this->saveLine($l);
        $this->log($u['id'], 'hr.payroll.edit', 'employee:'.$l['emp_id'], ['month' => $p['month'], 'incentive' => $l['incentive'], 'other_ded' => $l['other_ded'], 'recovery' => $l['recovery'],
            'note' => implode(' / ', array_filter([$l['incentive_note'], $l['other_note']]))]);
        return ['ok' => true, 'line' => $l];
    }

    public function payrollApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow($p['month']);
        $this->need($run && $run['status'] === 'draft', $run ? 'Already approved' : 'Run the payroll first');
        $ls = $this->lines($p['month']);
        $this->need(count($ls), 'No employees in this payroll');
        $this->need(! array_filter($ls, fn ($l) => ! ($l['net'] >= 0)), 'Some lines have negative net pay');
        $t = self::totals($ls);
        $date = self::monthEnd($p['month']);
        $jl = [['account' => 'Salary Exp', 'debit' => self::r0($t['earned'] + $t['incentive'])]];
        if ($t['other_ded'] > 0) {
            $jl[] = ['account' => 'Other Income', 'credit' => self::r0($t['other_ded'])];
        }
        foreach ($ls as $l) {
            if ($l['recovery'] > 0) {
                $jl[] = ['account' => 'Employees Advance', 'credit' => self::r0($l['recovery']), 'party' => 'employee:'.$l['emp_id']];
            }
            if ($l['net'] > 0) {
                $jl[] = ['account' => 'Salaries Payable', 'credit' => self::r0($l['net']), 'party' => 'employee:'.$l['emp_id']];
            }
        }
        $j = null;
        if ($jl[0]['debit'] > 0) {
            try {
                $j = $this->accPost(['date' => $date, 'memo' => 'Salaries '.self::monthName($p['month']), 'source' => 'payroll', 'source_id' => $p['month'],
                    'lines' => array_values(array_filter($jl, fn ($x) => (($x['debit'] ?? 0) ?: ($x['credit'] ?? 0)) > 0))], $u['id']);
            } catch (\Throwable $x) {
                throw new HttpError(400, 'Could not post to accounts: '.$x->getMessage());
            }
        }
        Db::run("UPDATE hr_payroll SET status='approved', posted=?, approved_by=?, approved_at=? WHERE month=?", $j !== null ? 1 : 0, $u['id'], $this->pkNow(), $p['month']);
        $this->log($u['id'], 'hr.payroll.approve', 'payroll:'.$p['month'], ['net' => $t['net'], 'staff' => $t['staff'], 'posted' => $j !== null]);
        return ['ok' => true, 'posted' => $j !== null, 'journal' => $j, 'totals' => $t, 'warning' => $this->acc() ? null : 'Accounts module is not available, so nothing was posted to the books.'];
    }

    public function payrollPay(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow($p['month']);
        $this->need($run && $run['status'] === 'approved', 'Approve the payroll first');
        $this->need(in_array($b['account'] ?? null, ['Cash', 'Meezan (SB)', 'Petty Cash'], true), 'Paid from which account?');
        $date = self::isDay($b['date'] ?? null) ? $b['date'] : $this->pkToday();
        $ids = isset($b['emp_ids']) && is_array($b['emp_ids']) ? array_map(fn ($x) => self::n($x), $b['emp_ids']) : null;
        $ls = array_values(array_filter($this->lines($p['month']), fn ($l) => ! $l['paid'] && ($ids === null || in_array($l['emp_id'], $ids))));
        $this->need(count($ls), 'Nothing left to pay');
        $posted = 0;
        foreach ($ls as $l) {
            if ($l['net'] > 0 && $run['posted']) {
                try {
                    $j = $this->accPost(['date' => $date, 'memo' => 'Salary '.self::monthName($p['month']).' paid · '.$l['name'], 'source' => 'payroll-pay', 'source_id' => $p['month'].':'.$l['emp_id'],
                        'lines' => [['account' => 'Salaries Payable', 'debit' => self::r0($l['net']), 'party' => 'employee:'.$l['emp_id']], ['account' => $b['account'], 'credit' => self::r0($l['net'])]]], $u['id']);
                } catch (\Throwable $x) {
                    throw new HttpError(400, 'Could not post '.$l['name']."'s payment: ".$x->getMessage());
                }
                if ($j !== null) {
                    $posted++;
                }
            }
            Db::run('UPDATE hr_payslips SET paid=1, paid_at=?, paid_from=? WHERE id=?', $date, $b['account'], $l['id']);
        }
        $this->log($u['id'], 'hr.payroll.paid', 'payroll:'.$p['month'], ['staff' => count($ls), 'amount' => self::num(array_sum(array_column($ls, 'net'))), 'account' => $b['account']]);
        return ['ok' => true, 'paid' => count($ls), 'posted' => $posted];
    }

    public function payrollUnpay(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isOwner($u), 'Only the owner can undo a payment', 403);
        $l = Db::get('SELECT * FROM hr_payslips WHERE month=? AND emp_id=? AND paid=1', $p['month'], (int) self::n($b['emp_id'] ?? null));
        $this->need($l, 'Not paid');
        $this->accVoid('payroll-pay', $p['month'].':'.$l['emp_id'], $u['id']);
        Db::run('UPDATE hr_payslips SET paid=0, paid_at=NULL, paid_from=NULL WHERE id=?', $l['id']);
        $this->log($u['id'], 'hr.payroll.unpay', 'employee:'.$l['emp_id'], ['month' => $p['month']]);
        return ['ok' => true];
    }

    public function payrollReopen(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->isOwner($u), 'Only the owner can reopen an approved payroll', 403);
        $run = $this->runRow($p['month']);
        $this->need($run && $run['status'] === 'approved', 'Not approved');
        $this->need(! Db::get('SELECT id FROM hr_payslips WHERE month=? AND paid=1', $p['month']), 'Some salaries are already marked paid. Undo those payments first.');
        if ($run['posted']) {
            $this->accVoid('payroll', $p['month'], $u['id']);
        }
        Db::run("UPDATE hr_payroll SET status='draft', posted=0, approved_by=NULL, approved_at=NULL WHERE month=?", $p['month']);
        $this->log($u['id'], 'hr.payroll.reopen', 'payroll:'.$p['month'], self::str(($b['reason'] ?? '') ?: ''));
        return ['ok' => true];
    }

    public function payrollDiscard(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow($p['month']);
        $this->need($run && $run['status'] === 'draft', 'Only a draft can be discarded');
        Db::tx(function () use ($p) {
            Db::run('DELETE FROM hr_payslips WHERE month=?', $p['month']);
            Db::run('DELETE FROM hr_payroll WHERE month=?', $p['month']);
        });
        $this->log($u['id'], 'hr.payroll.discard', 'payroll:'.$p['month'], '');
        return ['ok' => true];
    }

    public function payrollPayslip(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $s = $this->payslip($p['month'], (int) $p['emp']);
        $this->need($s, 'No payslip', 404);
        return $s;
    }

    /* ======================================================== badges & alerts */

    public function counts(array $u): array
    {
        return $this->can($u, 'hr') ? ['leave' => (int) Db::val("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'")] : [];
    }

    public function alerts(array $u): array
    {
        $out = [];
        if ($this->can($u, 'hr')) {
            if (Db::get('SELECT id FROM hr_employees LIMIT 1')) {
                $today = $this->pkToday();
                $L = $this->load($today, $today);
                $lim = self::n($this->S()['absent_alert_min'] ?? null) ?: 60;
                $abs = array_values(array_filter($this->attendanceOn($today), fn ($r) => $r['status'] === 'absent' && $L['nowMin'] >= (self::toMin($r['shift_start']) ?? 540) + $lim));
                if ($abs) {
                    $c = count($abs);
                    $out[] = ['level' => 'warn', 'text' => $c.' '.($c === 1 ? 'person has' : 'people have').' not come today and have no leave: '.implode(', ', array_column(array_slice($abs, 0, 5), 'name')).($c > 5 ? '…' : ''),
                        'href' => '#/attendance'];
                }
            }
            $n = (int) Db::val("SELECT COUNT(*) n FROM hr_leave WHERE status='pending'");
            if ($n) {
                $out[] = ['level' => 'info', 'text' => $n.' leave request'.($n > 1 ? 's' : '').' waiting for approval', 'href' => '#/leave'];
            }
        }
        if ($this->can($u, 'payroll')) {
            $today = $this->pkToday();
            $lm = self::prevMonth(substr($today, 0, 7));
            $r = Db::get('SELECT status FROM hr_payroll WHERE month=?', $lm);
            if ((int) substr($today, 8) >= 7 && (! $r || $r['status'] !== 'approved') && $this->eligible($lm)) {
                $out[] = ['level' => 'warn', 'text' => 'Payroll for '.self::monthName($lm).' has not been '.($r ? 'approved' : 'run').' yet', 'href' => '#/payroll/run/'.$lm];
            }
        }
        return $out;
    }
}
