<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Db;
use App\Erp\Erp;
use App\Erp\Module;
use App\Erp\Router;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;

/**
 * Operations: tasks, recurring tasks, end-of-day notes, targets, daily team work report and performance.
 * The work report is built from what the ERP already records: cs_calls, order_items picks, listings, returns and the events log
 * (every module logs its actions with log()). Attendance comes from the HR module service when it is present.
 * (Port of legacy/server/modules/ops.js)
 */
class OpsModule extends Module
{
    public string $name = 'ops';

    /* ---------------- metrics a target can use ---------------- */
    private const METRICS = [
        'calls' => 'CS calls', 'confirmed' => 'Orders confirmed', 'followups' => 'Delivery follow-ups', 'picked' => 'Pairs picked', 'packed' => 'Orders packed',
        'listed' => 'Pairs listed', 'returns' => 'Returns received', 'tasks_done' => 'Tasks done', 'actions' => 'All ERP actions',
    ];

    private const DEFAULT_TARGETS = [['cs', 'calls', 80], ['lister', 'listed', 60], ['warehouse', 'picked', 120], ['warehouse', 'packed', 80], ['tracking', 'followups', 60]];

    // added later (seeded once on upgrade): exchanges & WhatsApp and Instagram & abandoned carts
    private const DEFAULT_TARGETS_2 = [['social', 'action:abandoned.contact', 30], ['social', 'action:inbox.reply', 30], ['exchange', 'action:inbox.reply', 40], ['exchange', 'action:exchange.step', 10]];

    private const DEF = ['shiftStart' => '10:00', 'shiftEnd' => '19:00', 'breakStart' => '14:00', 'breakEnd' => '15:00', 'idleMin' => 90, 'lateGrace' => 15, 'workdays' => [1, 2, 3, 4, 5, 6],
        'noActBy' => '11:00', 'eodRemind' => '18:30', 'snapshotAt' => '21:30', 'lowPct' => 50, 'lowShare' => 60, 'absentLimit' => 3, 'lateLimit' => 5, 'hidden' => [], 'showAdmins' => false,
        'mistakePenalty' => 5, 'mistakeLimit' => 5];

    // "whose mistake" on closed customer tickets (tickets module, table tk_tickets) — internal departments count against a person
    private const DEPTS = ['listing' => 'Listing', 'sorting' => 'Sorting & QC', 'warehouse' => 'Warehouse', 'dispatch' => 'Dispatch', 'cs' => 'CS', 'courier' => 'Courier', 'supplier' => 'Supplier', 'customer' => 'Customer', 'unknown' => 'Unknown'];

    private const INTERNAL = ['listing', 'sorting', 'warehouse', 'dispatch', 'cs'];

    // mistake rate base: mistakes per 100 units of this output
    private const RATE_BASE = ['listing' => ['listed', 'pairs listed'], 'dispatch' => ['packed', 'orders packed'], 'warehouse' => ['picked', 'pairs picked'], 'cs' => ['confirmed', 'orders confirmed'], 'sorting' => ['actions', 'ERP actions']];

    private const PRIOS = ['low', 'normal', 'high', 'urgent'];

    private const STATUSES = ['todo', 'doing', 'blocked', 'done'];

    private array $cache = [];

    private ?array $rolesMemo = null;

    private ?array $labelsMemo = null;

    private ?array $tkMemo = null;

    public function activity(): array
    {
        return [
            'ops.task.create' => 'Created task', 'ops.task.done' => 'Completed task', 'ops.task.status' => 'Updated task status', 'ops.task.edit' => 'Edited task', 'ops.task.comment' => 'Commented on task',
            'ops.task.delete' => 'Deleted task', 'ops.eod' => 'Wrote end-of-day report', 'ops.target' => 'Changed targets', 'ops.template' => 'Saved recurring task', 'ops.snapshot' => 'Rebuilt daily report', 'ops.settings' => 'Changed team report settings',
        ];
    }

    public function install(): void
    {
        if (! $this->setting('ops_seeded')) {
            foreach (self::DEFAULT_TARGETS as [$role, $metric, $target]) {
                Db::run('INSERT IGNORE INTO ops_targets(scope,ref,metric,target,weight) VALUES(?,?,?,?,1)', 'role', $role, $metric, $target);
            }
            $this->setSetting('ops_seeded', true);
        }
        if (! $this->setting('ops_seeded_2')) {
            foreach (self::DEFAULT_TARGETS_2 as [$role, $metric, $target]) {
                Db::run('INSERT IGNORE INTO ops_targets(scope,ref,metric,target,weight) VALUES(?,?,?,?,1)', 'role', $role, $metric, $target);
            }
            $this->setSetting('ops_seeded_2', true);
        }
    }

    /* ======================================================================
     * small helpers (business time = Pakistan, UTC+5) and JS semantics
     * ==================================================================== */

    /** JS truthiness */
    private static function jt($v): bool
    {
        if ($v === null || $v === false || $v === '' || $v === 0) {
            return false;
        }
        if (is_float($v)) {
            return ! ($v == 0.0 || is_nan($v));
        }
        return true;
    }

    /** JS a || b || c */
    private static function orr(...$v)
    {
        foreach ($v as $x) {
            if (self::jt($x)) {
                return $x;
            }
        }
        return end($v);
    }

    /** JS Number(x) / +x */
    private static function num($v)
    {
        if ($v === null) {
            return 0;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_int($v) || is_float($v)) {
            return $v;
        }
        if (is_string($v)) {
            $s = trim($v);
            if ($s === '') {
                return 0;
            }
            if (is_numeric($s)) {
                $n = $s + 0;
                return is_float($n) && floor($n) == $n && abs($n) < PHP_INT_MAX && ! preg_match('/[.eE]/', $s) ? (int) $n : $n;
            }
            return NAN;
        }
        return NAN;
    }

    /** JS String(x) */
    private static function str($v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v) && floor($v) == $v && abs($v) < 1e15) {
            return (string) (int) $v;
        }
        if (is_array($v)) {
            return json_encode($v, JSON_UNESCAPED_UNICODE);
        }
        return (string) $v;
    }

    /** JS String(x || '') */
    private static function sOr($v): string
    {
        return self::jt($v) ? self::str($v) : '';
    }

    private static function jsRound($v)
    {
        $r = floor((float) $v + 0.5);
        return abs($r) < PHP_INT_MAX ? (int) $r : $r;
    }

    private static function toPK($at): ?string
    {
        if (! self::jt($at)) {
            return null;
        }
        $s = (string) $at;
        $ts = str_contains($s, 'T') ? strtotime($s) : strtotime(str_replace(' ', 'T', $s).'Z');
        if ($ts === false) {
            return null;
        }
        return gmdate('Y-m-d H:i:s', $ts + 5 * 3600);
    }

    private static function addDays(string $day, int $n): string
    {
        return gmdate('Y-m-d', strtotime($day.' 00:00:00 UTC') + $n * 86400);
    }

    private static function weekday(string $day): int
    {
        return (int) gmdate('w', strtotime($day.' 00:00:00 UTC'));
    }

    private static function hm2min($s): ?int
    {
        return preg_match('/(\d{1,2}):(\d{2})/', self::sOr($s), $m) ? ((int) $m[1]) * 60 + (int) $m[2] : null;
    }

    private static function min2hm($m): ?string
    {
        if ($m === null) {
            return null;
        }
        return str_pad((string) (int) floor($m / 60), 2, '0', STR_PAD_LEFT).':'.str_pad((string) self::jsRound(fmod($m, 60)), 2, '0', STR_PAD_LEFT);
    }

    private static function fmtDur($m): string
    {
        return $m >= 60 ? ((int) floor($m / 60)).'h '.str_pad((string) self::jsRound(fmod($m, 60)), 2, '0', STR_PAD_LEFT).'m' : self::jsRound($m).' min';
    }

    private static function isDay($s): bool
    {
        return (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', self::sOr($s));
    }

    /** PK midnight in UTC */
    private static function utcStart(string $day): string
    {
        return self::addDays($day, -1).' 19:00:00';
    }

    private static function pretty($a): string
    {
        $s = preg_replace_callback('/^[a-z]+[.:]/', fn ($m) => substr($m[0], 0, -1).' ', self::str($a));
        $s = preg_replace('/[._:]/', ' ', $s);
        return preg_replace_callback('/^\w/', fn ($m) => strtoupper($m[0]), $s);
    }

    private static function PRESENCE(string $a): bool
    {
        return $a === 'login' || $a === 'setup' || $a === 'logout' || preg_match('/^hr\.(check|clock|attendance\.self)/', $a);
    }

    private static function FROM_TABLE(string $a): bool
    {
        return str_starts_with($a, 'cs:') || $a === 'pick' || $a === 'unpick' || $a === 'listing.save' || $a === 'return.received';
    }

    private static function PRESENT($s): bool
    {
        return in_array($s, ['present', 'late', 'half_day', 'wfh', 'field', 'checked_in', 'in'], true);
    }

    private static function NOWORK($s): bool
    {
        return in_array($s, ['leave', 'holiday', 'off'], true);
    }

    /** JS localeCompare (ICU) */
    private static function localeCmp($a, $b): int
    {
        static $coll = null;
        if ($coll === null) {
            $coll = class_exists(\Collator::class) ? new \Collator('en') : false;
        }
        $a = (string) $a;
        $b = (string) $b;
        if ($coll) {
            return (int) $coll->compare($a, $b);
        }
        return strcmp(mb_strtolower($a), mb_strtolower($b)) ?: strcmp($a, $b);
    }

    /** objects that may be empty are read as objects by the client */
    private static function obj($a)
    {
        return is_array($a) && ! $a ? new \stdClass : $a;
    }

    private function outRow(array $r): array
    {
        if (array_key_exists('counts', $r)) {
            $r['counts'] = self::obj($r['counts'] ?? []);
        }
        return $r;
    }

    private function S(): array
    {
        $s = $this->setting('ops_settings', []);
        return array_merge(self::DEF, is_array($s) ? $s : []);
    }

    private function nowPK(): string
    {
        return $this->pkNow();
    }

    private function todayPK(): string
    {
        return $this->pkToday();
    }

    private function labels(): array
    {
        return $this->labelsMemo ??= Erp::activityLabels();
    }

    private function roles(): array
    {
        return $this->rolesMemo ??= Access::roles();
    }

    private function roleLabel($r): string
    {
        $R = $this->roles();
        if ($r !== null && isset($R[$r]) && self::jt($R[$r]['label'] ?? null)) {
            return $R[$r]['label'];
        }
        return self::sOr($r);
    }

    private function bust(): void
    {
        $this->cache = [];
    }

    private function cached(string $k, int $ms, callable $fn)
    {
        $now = microtime(true) * 1000;
        $c = $this->cache[$k] ?? null;
        if ($c && $now - $c['t'] < $ms) {
            return $c['v'];
        }
        $v = $fn();
        $this->cache[$k] = ['t' => $now, 'v' => $v];
        return $v;
    }

    /* ---------- mistakes: customer problems traced to a person (closed tickets with an internal "whose mistake") ---------- */
    private function hasTk(): bool
    {
        $now = time();
        if ($this->tkMemo && $now - $this->tkMemo['t'] < 60) {
            return $this->tkMemo['v'];
        }
        $v = false;
        try {
            $v = Schema::hasTable('tk_tickets') && Schema::hasColumn('tk_tickets', 'fault_user_id');
        } catch (\Throwable) {
        }
        $this->tkMemo = ['t' => $now, 'v' => $v];
        return $v;
    }

    private function mistakeRows(string $from, string $to, $uid = null): array
    {
        if (! $this->hasTk()) {
            return [];
        }
        $rows = Db::all('SELECT t.id, t.type, t.subject, t.order_name, t.sku, t.fault_dept dept, t.fault_user_id uid, t.fault_reason reason, t.fault_note note, t.fault_cost cost, t.resolved_at, t.status,
        DATE(t.resolved_at + INTERVAL 5 HOUR) day FROM tk_tickets t WHERE t.status IN (\'resolved\',\'closed\') AND t.fault_user_id IS NOT NULL AND t.fault_dept IN ('.Db::marks(self::INTERNAL).')
        AND t.resolved_at>=? AND t.resolved_at<? '.($uid ? 'AND t.fault_user_id=?' : '').' ORDER BY t.resolved_at', ...array_merge(self::INTERNAL, [self::utcStart($from), self::utcStart(self::addDays($to, 1))], $uid ? [$uid] : []));
        return array_map(fn ($r) => $r + ['deptLabel' => self::DEPTS[$r['dept']] ?? $r['dept']], $rows);
    }

    private function mistakeMap(string $from, string $to): array
    {
        $m = [];
        foreach ($this->mistakeRows($from, $to) as $r) {
            $m[$r['uid'].'|'.$r['day']][] = $r;
        }
        return $m;
    }

    private function tkStamp(): string
    {
        if (! $this->hasTk()) {
            return '';
        }
        $r = Db::get('SELECT COUNT(*) n, MAX(fault_at) a, MAX(resolved_at) b FROM tk_tickets WHERE fault_user_id IS NOT NULL');
        return $r['n'].'|'.self::str($r['a']).'|'.self::str($r['b']);
    }

    // penalty: −N points per mistake on that day's score (floor 0). Idempotent: works from baseScore so snapshots can be re-applied.
    private function applyMistakes(array $row, ?array $list, array $st): array
    {
        $list = $list ?: [];
        if (! array_key_exists('baseScore', $row)) {
            $row['baseScore'] = $row['score'] ?? null;
        }
        $pen = max(0, self::jt(self::num($st['mistakePenalty'] ?? null)) ? self::num($st['mistakePenalty']) : 0) * count($list);
        $row['mistakes'] = array_map(fn ($m) => ['id' => $m['id'], 'type' => $m['type'], 'order_name' => $m['order_name'], 'sku' => $m['sku'], 'dept' => $m['dept'], 'deptLabel' => $m['deptLabel'], 'reason' => $m['reason'], 'cost' => $m['cost']], $list);
        $row['penalty'] = $row['baseScore'] !== null && count($list) ? min($row['baseScore'], $pen) : 0;
        $row['score'] = $row['baseScore'] === null ? null : max(0, $row['baseScore'] - $pen);
        $row['flags'] = array_values(array_filter($row['flags'] ?? [], fn ($f) => ($f['k'] ?? null) !== 'mistake'));
        $n = count($list);
        if ($n) {
            array_unshift($row['flags'], ['k' => 'mistake', 't' => $n.' mistake'.($n > 1 ? 's' : '').' (customer problem'.($n > 1 ? 's' : '').')', 'lv' => 'bad']);
        }
        return $row;
    }

    /* ---------- HR adapter (HR module is optional; tolerate any reasonable shape) ---------- */
    private function hrSvc(): ?Module
    {
        return $this->svc('hr');
    }

    private static function toArr($v)
    {
        if (is_object($v)) {
            $v = (array) $v;
        }
        return $v;
    }

    private function hrList(string $fn, ...$args): ?array
    {
        $hr = $this->hrSvc();
        if (! $hr || ! method_exists($hr, $fn)) {
            return null;
        }
        try {
            $r = self::toArr($hr->{$fn}(...$args));
            if ($r === null || $r === false || ! is_array($r)) {
                return null;
            }
            if (! array_is_list($r)) {
                $r = self::toArr($r['rows'] ?? $r['employees'] ?? $r['list'] ?? array_values($r));
            }
            return is_array($r) ? array_map(fn ($x) => self::toArr($x), $r) : null;
        } catch (\Throwable) {
            return null;
        }
    }

    private static function tm($v): ?string
    {
        if (! self::jt($v)) {
            return null;
        }
        $s = self::str($v);
        if (str_contains($s, 'T') && preg_match('/Z|[+-]\d\d:?\d\d$/', $s)) {
            $x = substr(self::toPK($s) ?? '', 11, 5);
            return $x !== '' ? $x : null;
        }
        if (preg_match('/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/', $s, $m) || preg_match('/(\d{1,2}):(\d{2})/', $s, $m)) {
            return str_pad($m[1], 2, '0', STR_PAD_LEFT).':'.$m[2];
        }
        return null;
    }

    private function hrDay(string $day): ?array
    {
        $rows = $this->hrList('attendance', $day);
        if ($rows === null) {
            return null;
        }
        return array_map(function ($r) {
            $r = is_array($r) ? $r : [];
            $g = fn ($k) => $r[$k] ?? null;
            $present = $g('present');
            $st = strtolower(self::sOr(self::orr($g('status'), $g('state'), $present === false ? 'absent' : (self::jt($present) ? 'present' : ''), '')));
            $st = preg_replace('/[\s-]+/', '_', $st);
            if (preg_match('/leave/', $st)) {
                $st = 'leave';
            } elseif (preg_match('/holiday/', $st)) {
                $st = 'holiday';
            } elseif (preg_match('/^(off|weekly_off|rest|day_off)$/', $st)) {
                $st = 'off';
            } elseif (preg_match('/half/', $st)) {
                $st = 'half_day';
            }
            $late = self::jt($g('late')) || self::jt($g('is_late')) || $st === 'late' || (array_key_exists('late_min', $r) && self::num($r['late_min']) > 0) || (array_key_exists('lateMinutes', $r) && self::num($r['lateMinutes']) > 0);
            $lm = self::num(self::orr($g('late_min'), $g('lateMinutes'), 0));
            return [
                'user_id' => $g('user_id') ?? $g('userId') ?? null,
                'emp_id' => $g('employee_id') ?? $g('emp_id') ?? $g('employeeId') ?? ($g('user_id') === null ? $g('id') : null),
                'name' => self::orr($g('name'), $g('employee'), $g('employee_name')),
                'role' => self::orr($g('role'), $g('designation'), $g('department'), ''),
                'status' => $st !== '' ? $st : (self::jt($g('in')) || self::jt($g('check_in')) ? 'present' : ''),
                'in' => self::tm(self::orr($g('in'), $g('check_in'), $g('checkin'), $g('time_in'), $g('in_at'))),
                'out' => self::tm(self::orr($g('out'), $g('check_out'), $g('checkout'), $g('time_out'), $g('out_at'))),
                'late' => $late,
                'lateMin' => self::jt($lm) ? $lm : null,
                'shiftStart' => self::tm(self::orr($g('shift_start'), $g('shiftStart'))),
                'shiftEnd' => self::tm(self::orr($g('shift_end'), $g('shiftEnd'))),
            ];
        }, $rows);
    }

    private function hrEmployees(): array
    {
        $rows = $this->hrList('employees') ?? $this->hrList('list');
        if (! $rows) {
            return [];
        }
        $out = [];
        foreach ($rows as $e) {
            if (! $e || ! is_array($e)) {
                continue;
            }
            $active = $e['active'] ?? null;
            if ($active === 0 || $active === false || preg_match('/left|terminated|resigned|inactive/i', self::sOr($e['status'] ?? null))) {
                continue;
            }
            $out[] = ['emp_id' => $e['id'] ?? $e['employee_id'] ?? null, 'user_id' => $e['user_id'] ?? $e['userId'] ?? null, 'name' => $e['name'] ?? null,
                'role' => self::orr($e['role'] ?? null, $e['designation'] ?? null, $e['department'] ?? null, '')];
        }
        return $out;
    }

    private function hrWarnings(array $person, string $from, string $to)
    {
        $hr = $this->hrSvc();
        if (! $hr) {
            return null;
        }
        try {
            if (method_exists($hr, 'warnings')) {
                $r = self::toArr($hr->warnings(['user_id' => $person['user_id'] ?? null, 'employee_id' => $person['emp_id'] ?? null, 'from' => $from, 'to' => $to]));
                if (is_int($r) || is_float($r)) {
                    return $r;
                }
                if (is_array($r) && array_is_list($r)) {
                    return count($r);
                }
                if (is_array($r) && isset($r['count']) && (is_int($r['count']) || is_float($r['count']))) {
                    return $r['count'];
                }
            }
            if (method_exists($hr, 'warningCount')) {
                $n = $hr->warningCount($person['user_id'] ?? null, $from, $to);
                if (is_int($n) || is_float($n)) {
                    return $n;
                }
            }
            // HR module has no warnings service: read its warnings table if it exists (read-only)
            if (($person['emp_id'] ?? null) !== null && Schema::hasTable('hr_warnings')) {
                return Db::val('SELECT COUNT(*) n FROM hr_warnings WHERE emp_id=? AND day>=? AND day<=?', $person['emp_id'], $from, $to);
            }
        } catch (\Throwable) {
        }
        return null;
    }

    /* ---------- who is on the report ---------- */
    private function people(string $day, array $extraUserIds = []): array
    {
        $st = $this->S();
        $hidden = array_map('strval', $st['hidden'] ?? []);
        $users = Db::all('SELECT id,name,role,active,created_at FROM users ORDER BY name');
        $extra = array_map(fn ($x) => (int) $x, $extraUserIds);
        $list = [];
        foreach ($users as $u) {
            if (in_array('u:'.$u['id'], $hidden, true)) {
                continue;
            }
            if ($u['role'] === 'admin' && ! self::jt($st['showAdmins'] ?? false)) {
                continue;
            }
            $createdPK = substr(self::toPK($u['created_at']) ?? '', 0, 10);
            if (! (self::jt($u['active']) && $createdPK <= $day) && ! in_array((int) $u['id'], $extra, true)) {
                continue;
            }
            $list[] = ['key' => 'u:'.$u['id'], 'user_id' => $u['id'], 'emp_id' => null, 'name' => $u['name'], 'role' => $u['role'], 'roleLabel' => $this->roleLabel($u['role']), 'since' => $createdPK];
        }
        $byUser = [];
        foreach ($list as $i => $p) {
            $byUser[$p['user_id']] = $i;
        }
        foreach ($this->hrEmployees() as $e) {
            if ($e['user_id'] !== null && isset($byUser[(int) $e['user_id']])) {
                $list[$byUser[(int) $e['user_id']]]['emp_id'] = $e['emp_id'];
                continue;
            }
            if ($e['user_id'] !== null) {
                continue; // linked to a hidden / inactive login
            }
            if (in_array('e:'.self::str($e['emp_id']), $hidden, true)) {
                continue;
            }
            $list[] = ['key' => 'e:'.self::str($e['emp_id']), 'user_id' => null, 'emp_id' => $e['emp_id'], 'name' => $e['name'], 'role' => '', 'roleLabel' => self::orr($e['role'], 'No login'), 'since' => null, 'noLogin' => true];
        }
        return $list;
    }

    /* ---------- targets ---------- */
    private function allTargets(): array
    {
        return Db::all('SELECT * FROM ops_targets ORDER BY scope, ref, metric');
    }

    private function targetsFor(array $p, ?array $all = null): array
    {
        $all ??= $this->allTargets();
        $m = [];
        foreach ($all as $t) {
            if ($t['scope'] === 'role' && self::jt($p['role'] ?? null) && $t['ref'] === $p['role']) {
                $m[$t['metric']] = ['metric' => $t['metric'], 'target' => $t['target'], 'weight' => $t['weight'], 'src' => 'role'];
            }
        }
        foreach ($all as $t) {
            if ($t['scope'] === 'person' && $t['ref'] === ($p['key'] ?? null)) {
                if (self::num($t['target']) > 0) {
                    $m[$t['metric']] = ['metric' => $t['metric'], 'target' => $t['target'], 'weight' => $t['weight'], 'src' => 'person'];
                } else {
                    unset($m[$t['metric']]);
                }
            }
        }
        return array_values(array_filter($m, fn ($t) => $t['target'] > 0));
    }

    private function metricLabel(string $k): string
    {
        if (isset(self::METRICS[$k])) {
            return self::METRICS[$k];
        }
        if (str_starts_with($k, 'action:')) {
            $a = substr($k, 7);
            $L = $this->labels();
            return self::jt($L[$a] ?? null) ? $L[$a] : self::pretty(preg_replace('/\*$/', ' (all)', $a));
        }
        return $k;
    }

    private static function metricValue(array $counts, string $k)
    {
        if (str_starts_with($k, 'action:') && str_ends_with($k, '*')) {
            $pre = substr($k, 0, -1);
            $n = 0;
            foreach ($counts as $c => $v) {
                if (str_starts_with((string) $c, $pre)) {
                    $n += $v;
                }
            }
            return $n;
        }
        return self::jt($counts[$k] ?? null) ? $counts[$k] : 0;
    }

    private function scoreOf(array $counts, array $targets): array
    {
        if (! $targets) {
            return ['score' => null, 'parts' => []];
        }
        $sw = 0;
        $s = 0;
        $parts = [];
        foreach ($targets as $t) {
            $actual = self::metricValue($counts, $t['metric']);
            $pct = min(1.5, $actual / $t['target']);
            $w = self::num($t['weight']) > 0 ? self::num($t['weight']) : 1;
            $sw += $w;
            $s += $w * $pct;
            $parts[] = ['metric' => $t['metric'], 'label' => $this->metricLabel($t['metric']), 'actual' => $actual, 'target' => $t['target'], 'weight' => $w, 'pct' => self::jsRound($pct * 100)];
        }
        return ['score' => self::jsRound(min(150, 100 * $s / $sw)), 'parts' => $parts];
    }

    /* ---------- collect activity for PK days [from, to] from every source ---------- */
    private function collect(string $from, string $to, array $opts = []): array
    {
        $a = self::utcStart($from);
        $b = self::utcStart(self::addDays($to, 1));
        $L = $this->labels();
        $items = ! empty($opts['items']);
        $out = [];
        $rec = function ($uid, string $pk) use (&$out): string {
            $k = $uid.'|'.substr($pk, 0, 10);
            if (! isset($out[$k])) {
                $out[$k] = ['uid' => $uid, 'day' => substr($pk, 0, 10), 'counts' => [], 'labels' => [], 'times' => [], 'seen' => [], 'items' => []];
            }
            return $k;
        };
        $add = function ($uid, $at, array $metrics, string $label, $n = 1, $detail = null, $kind = null) use (&$out, $rec, $items) {
            $pk = self::toPK($at);
            if (! $pk || ! self::jt($uid)) {
                return;
            }
            $k = $rec($uid, $pk);
            foreach ($metrics as $m) {
                $out[$k]['counts'][$m] = ($out[$k]['counts'][$m] ?? 0) + $n;
            }
            $out[$k]['labels'][$label] = ($out[$k]['labels'][$label] ?? 0) + $n;
            $out[$k]['counts']['actions'] = ($out[$k]['counts']['actions'] ?? 0) + 1;
            $out[$k]['times'][] = substr($pk, 11);
            $out[$k]['seen'][] = substr($pk, 11);
            if ($items) {
                $out[$k]['items'][] = ['at' => substr($pk, 11), 'label' => $label, 'detail' => self::jt($detail) ? $detail : '', 'kind' => self::jt($kind) ? $kind : 'work', 'n' => $n];
            }
        };
        foreach (Db::all('SELECT c.user_id, c.at, c.outcome, o.name FROM cs_calls c LEFT JOIN orders o ON o.id=c.order_id WHERE c.at>=? AND c.at<? AND c.user_id IS NOT NULL', $a, $b) as $c) {
            $fu = (bool) preg_match('/^delivery_/', self::sOr($c['outcome']));
            $add($c['user_id'], $c['at'], $fu ? ['followups'] : ($c['outcome'] === 'confirmed' ? ['calls', 'confirmed'] : ['calls']), $fu ? 'Delivery follow-up call' : 'CS call', 1,
                self::sOr($c['name']).' · '.str_replace('_', ' ', self::sOr($c['outcome'])), 'call');
        }
        foreach (Db::all('SELECT i.picked_by uid, i.picked_at at, COALESCE(i.qty,1) qty, i.sku, o.name FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE i.picked=1 AND i.picked_by IS NOT NULL AND i.picked_at>=? AND i.picked_at<?', $a, $b) as $p) {
            $add($p['uid'], $p['at'], ['picked'], 'Picked pair', $p['qty'], self::sOr($p['sku']).' · '.self::sOr($p['name']), 'pick');
        }
        foreach (Db::all('SELECT user_id, at, sku FROM listings WHERE at>=? AND at<? AND user_id IS NOT NULL', $a, $b) as $l) {
            $add($l['user_id'], $l['at'], ['listed'], 'Listed pair', 1, $l['sku'], 'list');
        }
        foreach (Db::all('SELECT r.user_id, r.at, r.sku, o.name FROM returns r LEFT JOIN orders o ON o.id=r.order_id WHERE r.at>=? AND r.at<? AND r.user_id IS NOT NULL', $a, $b) as $r) {
            $add($r['user_id'], $r['at'], ['returns'], 'Received return (pair)', 1, self::sOr($r['sku']).' · '.self::sOr($r['name']), 'return');
        }
        $orderName = [];
        foreach (Db::all('SELECT user_id, at, action, entity, detail FROM events WHERE at>=? AND at<? AND user_id IS NOT NULL', $a, $b) as $e) {
            $act = self::sOr($e['action']);
            $pk = self::toPK($e['at']);
            if (! $pk) {
                continue;
            }
            $k0 = $rec($e['user_id'], $pk);
            $out[$k0]['counts']['action:'.$act] = ($out[$k0]['counts']['action:'.$act] ?? 0) + 1;
            if (self::PRESENCE($act)) {
                $out[$k0]['seen'][] = substr($pk, 11);
                if ($items) {
                    $out[$k0]['items'][] = ['at' => substr($pk, 11), 'label' => self::jt($L[$act] ?? null) ? $L[$act] : self::pretty($act), 'detail' => '', 'kind' => 'presence'];
                }
                continue;
            }
            if (self::FROM_TABLE($act)) {
                continue;
            }
            $detail = '';
            if ($items) {
                $ent = self::sOr($e['entity']);
                if (str_starts_with($ent, 'order:')) {
                    $id = substr($ent, 6);
                    if (! array_key_exists($id, $orderName)) {
                        $nm = Db::val('SELECT name FROM orders WHERE id=?', $id);
                        $orderName[$id] = self::jt($nm) ? $nm : $id;
                    }
                    $detail = (string) $orderName[$id];
                } elseif ($ent !== '' && ! preg_match('/^(settings|user|finance|products|listings)$/', $ent)) {
                    $detail = preg_replace('/^[a-z_]+:/', '', $ent);
                }
                $d = self::sOr($e['detail']);
                if ($d !== '' && $d !== 'null' && $d !== '""' && ! str_starts_with($d, '{') && ! str_starts_with($d, '[')) {
                    $detail .= ($detail !== '' ? ' · ' : '').mb_substr($d, 0, 80);
                }
            }
            $metrics = [];
            if ($act === 'pack') {
                $metrics[] = 'packed';
            } elseif ($act === 'note') {
                $metrics[] = 'followups';
            } elseif ($act === 'ops.task.done') {
                $metrics[] = 'tasks_done';
            }
            $add($e['user_id'], $e['at'], $metrics, $act === 'pack' ? 'Packed order' : ($act === 'note' ? 'Order note' : (self::jt($L[$act] ?? null) ? $L[$act] : self::pretty($act))), 1, $detail);
        }
        foreach ($out as &$r) {
            sort($r['times'], SORT_STRING);
            sort($r['seen'], SORT_STRING);
            if ($items) {
                usort($r['items'], fn ($x, $y) => strcmp($x['at'], $y['at']));
            }
        }
        unset($r);
        return $out;
    }

    /* ---------- idle gap inside working hours ---------- */
    private function idleGap(array $times, array $att, array $st, bool $isToday): ?array
    {
        $s0 = self::hm2min($st['shiftStart']);
        $s1 = self::hm2min($st['shiftEnd']);
        $b0 = self::hm2min($st['breakStart'] ?? null);
        $b1 = self::hm2min($st['breakEnd'] ?? null);
        $pts = [];
        foreach ($times as $t) {
            $m = self::hm2min($t);
            if ($m !== null && $m >= (int) $s0 && $m <= (int) $s1) {
                $pts[] = $m;
            }
        }
        if (($att['source'] ?? null) === 'hr') {
            $i = self::hm2min($att['in']);
            $o = self::hm2min($att['out']);
            if ($i !== null) {
                $pts[] = max($i, (int) $s0);
            }
            if ($o !== null) {
                $pts[] = min($o, (int) $s1);
            } elseif ($i !== null && $isToday) {
                $n = self::hm2min(substr($this->nowPK(), 11));
                if ($n > $s0) {
                    $pts[] = min($n, (int) $s1);
                }
            }
        }
        $p = array_values(array_unique($pts));
        sort($p, SORT_NUMERIC);
        $best = null;
        for ($k = 1; $k < count($p); $k++) {
            $g = $p[$k] - $p[$k - 1];
            if ($b0 !== null && $b1 !== null && $b1 > $b0) {
                $g -= max(0, min($p[$k], $b1) - max($p[$k - 1], $b0));
            }
            if (! $best || $g > $best['min']) {
                $best = ['min' => $g, 'from' => self::min2hm($p[$k - 1]), 'to' => self::min2hm($p[$k])];
            }
        }
        return $best && $best['min'] > 0 ? $best : null;
    }

    /* ---------- overdue / open tasks per user as of a moment ---------- */
    private function taskStats(string $day, bool $isToday): array
    {
        $cut = $isToday ? $this->nowPK() : $day.' 23:59:59';
        $due = "CONCAT(t.due_date, ' ', COALESCE(t.due_time,'23:59'), ':00')";
        $rows = Db::all("SELECT a.user_id, SUM(CASE WHEN t.due_date IS NOT NULL AND $due < ? AND (t.done_at IS NULL OR t.done_at > ?) THEN 1 ELSE 0 END) overdue,
       SUM(CASE WHEN t.done_at IS NULL OR t.done_at > ? THEN 1 ELSE 0 END) `open`
       FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE t.created_at <= ? GROUP BY a.user_id", $cut, $cut, $cut, $cut);
        $m = [];
        foreach ($rows as $r) {
            $m[$r['user_id']] = $r;
        }
        return $m;
    }

    /* ---------- one person-day row ---------- */
    private function buildRow(array $p, string $day, ?array $r, ?array $hrRow, array $tgAll, array $ctxDay): array
    {
        $isToday = $ctxDay['isToday'];
        $nowMin = $ctxDay['nowMin'];
        $st = $hrRow && self::jt($hrRow['shiftStart'] ?? null) && self::jt($hrRow['shiftEnd'] ?? null) && self::hm2min($hrRow['shiftEnd']) > self::hm2min($hrRow['shiftStart'])
            ? array_merge($ctxDay['st'], ['shiftStart' => $hrRow['shiftStart'], 'shiftEnd' => $hrRow['shiftEnd']]) : $ctxDay['st'];
        $counts = $r ? $r['counts'] : [];
        $actions = $counts['actions'] ?? 0;
        $first = $r && $r['times'] ? substr($r['times'][0], 0, 5) : null;
        $last = $r && $r['times'] ? substr($r['times'][count($r['times']) - 1], 0, 5) : null;
        if ($hrRow) {
            $att = ['source' => 'hr', 'status' => self::orr($hrRow['status'] ?? null, 'unknown'), 'in' => $hrRow['in'] ?? null, 'out' => $hrRow['out'] ?? null, 'late' => $hrRow['late'] ?? false, 'lateMin' => $hrRow['lateMin'] ?? null];
        } else {
            $seen = $r && $r['seen'] ? $r['seen'] : null;
            $att = ['source' => 'activity', 'status' => $seen ? 'active' : 'none', 'in' => $seen ? substr($seen[0], 0, 5) : null, 'out' => $seen ? substr($seen[count($seen) - 1], 0, 5) : null];
        }
        $targets = self::jt($p['user_id'] ?? null) || ($p['emp_id'] ?? null) !== null ? $this->targetsFor($p, $tgAll) : [];
        $sc = $this->scoreOf($counts, $targets);
        $tracked = count($targets) > 0;
        $workday = in_array(self::weekday($day), $st['workdays'] ?? [], true) && ! self::NOWORK($att['status']);
        $absent = $att['status'] === 'absent' && ! $actions;
        $present = $att['source'] === 'hr' ? self::PRESENT($att['status']) || $actions > 0 : $att['status'] === 'active';
        $idle = $actions ? $this->idleGap($r['times'], $att, $st, $isToday) : null;
        $dayDone = ! $isToday || $nowMin >= self::hm2min($st['shiftEnd']);
        $ts = (self::jt($p['user_id'] ?? null) ? ($ctxDay['tasks'][$p['user_id']] ?? null) : null) ?: ['overdue' => 0, 'open' => 0];
        $eod = self::jt($p['user_id'] ?? null) ? ($ctxDay['eod'][$p['user_id']] ?? null) : null;
        $noLogin = ! empty($p['noLogin']);
        $flags = [];
        if ($absent) {
            $flags[] = ['k' => 'absent', 't' => 'Absent', 'lv' => 'bad'];
        }
        if ($att['status'] === 'absent' && $actions) {
            $flags[] = ['k' => 'nocheckin', 't' => 'Worked but not checked in (HR)', 'lv' => 'warn'];
        }
        if (! $actions && $workday && ! $absent && ! $noLogin && (! $isToday || $nowMin >= self::hm2min($st['noActBy']))) {
            $t = $att['source'] === 'hr' && self::jt($att['in']) ? 'No work recorded (checked in '.$att['in'].')' : 'No work recorded';
            $flags[] = $tracked ? ['k' => 'noact', 't' => $t, 'lv' => 'bad'] : ['k' => 'noact', 't' => $t, 'lv' => 'info'];
        } elseif (! $actions && $workday && ! $absent && ! $noLogin && $isToday) {
            $flags[] = ['k' => 'noact', 't' => 'No work recorded yet', 'lv' => 'info'];
        }
        if ($idle && $idle['min'] > $st['idleMin'] && $workday && ! $absent) {
            $flags[] = ['k' => 'idle', 't' => 'Idle '.self::fmtDur($idle['min']).' ('.$idle['from'].'–'.$idle['to'].')', 'lv' => $tracked ? 'warn' : 'info'];
        }
        if ($tracked && $sc['score'] !== null && $dayDone && $workday && ! $absent && $present && $sc['score'] < $st['lowPct']) {
            $flags[] = ['k' => 'low', 't' => 'Below '.self::str($st['lowPct']).'% of target ('.$sc['score'].'%)', 'lv' => 'bad'];
        }
        if ($att['source'] === 'hr' && self::jt($att['late'])) {
            $flags[] = ['k' => 'late', 't' => 'Late'.(self::jt($att['in']) ? ' (in '.$att['in'].')' : ''), 'lv' => 'warn'];
        } elseif ($att['source'] !== 'hr' && $tracked && $workday && self::jt($att['in']) && self::hm2min($att['in']) > self::hm2min($st['shiftStart']) + (self::jt(self::num($st['lateGrace'] ?? null)) ? self::num($st['lateGrace']) : 0)) {
            $flags[] = ['k' => 'late', 't' => 'Late start: first seen '.$att['in'], 'lv' => 'warn'];
        }
        if (self::jt($ts['overdue'] ?? null)) {
            $flags[] = ['k' => 'overdue', 't' => $ts['overdue'].' overdue task'.($ts['overdue'] > 1 ? 's' : ''), 'lv' => 'warn'];
        }
        if (self::jt($p['user_id'] ?? null) && ! $eod && $workday && $present && ($dayDone || $nowMin >= self::hm2min($st['eodRemind']))) {
            $flags[] = ['k' => 'noeod', 't' => 'No end-of-day note', 'lv' => 'info'];
        }
        $lab = [];
        foreach (($r ? $r['labels'] : []) as $l => $n) {
            $lab[] = ['l' => (string) $l, 'n' => $n];
        }
        usort($lab, fn ($x, $y) => $y['n'] <=> $x['n']);
        return ['key' => $p['key'], 'user_id' => $p['user_id'] ?? null, 'emp_id' => $p['emp_id'] ?? null, 'name' => $p['name'], 'role' => $p['role'], 'roleLabel' => $p['roleLabel'], 'noLogin' => $noLogin, 'att' => $att,
            'first' => $first, 'last' => $last, 'actions' => $actions, 'counts' => $counts, 'labels' => $lab,
            'targets' => $sc['parts'], 'score' => $sc['score'], 'tracked' => $tracked, 'workday' => $workday, 'present' => $present, 'idle' => $idle, 'shift' => $st['shiftStart'].'–'.$st['shiftEnd'],
            'tasks' => ['done' => self::jt($counts['tasks_done'] ?? null) ? $counts['tasks_done'] : 0, 'overdue' => self::jt($ts['overdue'] ?? null) ? $ts['overdue'] : 0, 'open' => self::jt($ts['open'] ?? null) ? $ts['open'] : 0], 'eod' => $eod, 'flags' => $flags];
    }

    private function eodMap(string $day): array
    {
        $m = [];
        foreach (Db::all('SELECT * FROM ops_eod WHERE day=?', $day) as $e) {
            $m[$e['user_id']] = $e;
        }
        return $m;
    }

    private function dayCtx(string $day): array
    {
        $st = $this->S();
        $isToday = $day === $this->todayPK();
        return ['st' => $st, 'isToday' => $isToday, 'nowMin' => $isToday ? self::hm2min(substr($this->nowPK(), 11)) : 24 * 60, 'tasks' => $this->taskStats($day, $isToday), 'eod' => $this->eodMap($day)];
    }

    private function hrIndex(?array $hr): array
    {
        $by = [];
        $byEmp = [];
        foreach ($hr ?: [] as $x) {
            if ($x['user_id'] !== null) {
                $by[(int) $x['user_id']] = $x;
            }
            if ($x['emp_id'] !== null) {
                $byEmp[self::str($x['emp_id'])] = $x;
            }
        }
        return [$by, $byEmp];
    }

    private function hrRowFor(array $p, array $by, array $byEmp): ?array
    {
        if (self::jt($p['user_id'] ?? null)) {
            return $by[(int) $p['user_id']] ?? (($p['emp_id'] ?? null) !== null ? ($byEmp[self::str($p['emp_id'])] ?? null) : null);
        }
        return $byEmp[self::str($p['emp_id'] ?? null)] ?? null;
    }

    private function liveDay(string $day, array $opts = []): array
    {
        $recs = $this->collect($day, $day, ['items' => ! empty($opts['items'])]);
        $ids = array_values(array_unique(array_map(fn ($r) => $r['uid'], $recs)));
        $ppl = $this->people($day, $ids);
        $hr = $this->hrDay($day);
        [$hrBy, $hrByEmp] = $this->hrIndex($hr);
        $hidden = $this->S()['hidden'] ?? [];
        if ($hr !== null) {
            foreach ($hr as $x) {
                if ($x['user_id'] === null && $x['emp_id'] !== null) {
                    $key = 'e:'.self::str($x['emp_id']);
                    $found = false;
                    foreach ($ppl as $p) {
                        if ($p['key'] === $key) {
                            $found = true;
                            break;
                        }
                    }
                    if (! $found && ! in_array($key, $hidden, true)) {
                        $ppl[] = ['key' => $key, 'user_id' => null, 'emp_id' => $x['emp_id'], 'name' => self::orr($x['name'], 'Employee '.self::str($x['emp_id'])), 'role' => '', 'roleLabel' => self::orr($x['role'], 'No login'), 'noLogin' => true];
                    }
                }
            }
        }
        $c = $this->dayCtx($day);
        $tg = $this->allTargets();
        $mm = $this->mistakeMap($day, $day);
        $st0 = $this->S();
        foreach (array_keys($mm) as $k) {
            $uid = (int) explode('|', (string) $k)[0];
            $has = false;
            foreach ($ppl as $p) {
                if (($p['user_id'] ?? null) === $uid) {
                    $has = true;
                    break;
                }
            }
            if (! $has && ! in_array('u:'.$uid, $hidden, true)) {
                $u = Db::get('SELECT id,name,role,created_at FROM users WHERE id=?', $uid);
                if ($u && ($u['role'] !== 'admin' || self::jt($st0['showAdmins'] ?? false))) {
                    $ppl[] = ['key' => 'u:'.$u['id'], 'user_id' => $u['id'], 'emp_id' => null, 'name' => $u['name'], 'role' => $u['role'], 'roleLabel' => $this->roleLabel($u['role']), 'since' => null];
                }
            }
        }
        $rows = [];
        foreach ($ppl as $p) {
            $uid = $p['user_id'] ?? null;
            $r = self::jt($uid) ? ($recs[$uid.'|'.$day] ?? null) : null;
            $hrow = $this->hrRowFor($p, $hrBy, $hrByEmp);
            $row = $this->applyMistakes($this->buildRow($p, $day, $r, $hrow, $tg, $c), self::jt($uid) ? ($mm[$uid.'|'.$day] ?? null) : null, $c['st']);
            if (! empty($opts['items'])) {
                $row['items'] = $r ? $r['items'] : [];
            }
            $rows[] = $row;
        }
        return ['rows' => $rows, 'hr' => $hr !== null];
    }

    private function sortRows(array $rows): array
    {
        usort($rows, fn ($a, $b) => self::localeCmp($a['name'] ?? '', $b['name'] ?? ''));
        return $rows;
    }

    /** service + GET /api/ops/day */
    public function dayReport($day = null, $opts = null): array
    {
        $opts = is_array($opts) ? $opts : [];
        $day = self::isDay($day) ? $day : $this->todayPK();
        $isToday = $day === $this->todayPK();
        $build = function () use ($day, $isToday, $opts) {
            $snap = null;
            $saved = ! $isToday && empty($opts['live']) ? Db::all('SELECT * FROM ops_daily WHERE day=?', $day) : [];
            if ($saved) {
                $eod = $this->eodMap($day);
                $mm = $this->mistakeMap($day, $day);
                $st0 = $this->S();
                $rows = array_map(function ($s) use ($eod, $mm, $st0, $day) {
                    $d = $this->J($s['data'], []);
                    $d = is_array($d) ? $d : [];
                    if (self::jt($d['user_id'] ?? null)) {
                        $d['eod'] = $eod[$d['user_id']] ?? (self::jt($d['eod'] ?? null) ? $d['eod'] : null);
                    }
                    return $this->applyMistakes($d, self::jt($d['user_id'] ?? null) ? ($mm[$d['user_id'].'|'.$day] ?? null) : null, $st0);
                }, $saved);
                $hr = false;
                foreach ($rows as $r) {
                    if (($r['att']['source'] ?? null) === 'hr') {
                        $hr = true;
                        break;
                    }
                }
                $snap = array_reduce($saved, fn ($m, $s) => (string) $s['built_at'] > $m ? (string) $s['built_at'] : $m, '');
            } else {
                ['rows' => $rows, 'hr' => $hr] = $this->liveDay($day);
            }
            $rows = $this->sortRows($rows);
            $hasFlag = fn ($r, $k) => (bool) array_filter($r['flags'] ?? [], fn ($f) => ($f['k'] ?? null) === $k);
            $cnt = fn (callable $f) => count(array_filter($rows, $f));
            $t = ['staff' => count($rows), 'present' => $cnt(fn ($r) => self::jt($r['present'] ?? null)), 'active' => $cnt(fn ($r) => ($r['actions'] ?? 0) > 0),
                'noActivity' => $cnt(fn ($r) => $hasFlag($r, 'noact')), 'idle' => $cnt(fn ($r) => $hasFlag($r, 'idle')),
                'low' => $cnt(fn ($r) => $hasFlag($r, 'low')), 'late' => $cnt(fn ($r) => $hasFlag($r, 'late')),
                'absent' => $cnt(fn ($r) => $hasFlag($r, 'absent')), 'eod' => $cnt(fn ($r) => self::jt($r['eod'] ?? null)), 'eodDue' => $cnt(fn ($r) => self::jt($r['user_id'] ?? null) && self::jt($r['present'] ?? null)),
                'overdue' => array_sum(array_map(fn ($r) => self::jt($r['tasks']['overdue'] ?? null) ? $r['tasks']['overdue'] : 0, $rows)), 'actions' => array_sum(array_map(fn ($r) => self::jt($r['actions'] ?? null) ? $r['actions'] : 0, $rows)),
                'mistakes' => array_sum(array_map(fn ($r) => count($r['mistakes'] ?? []), $rows)), 'mistakePeople' => $cnt(fn ($r) => count($r['mistakes'] ?? []) > 0)];
            $sc = array_values(array_filter($rows, fn ($r) => ($r['score'] ?? null) !== null && self::jt($r['present'] ?? null)));
            $t['avgScore'] = $sc ? self::jsRound(array_sum(array_map(fn ($r) => $r['score'], $sc)) / count($sc)) : null;
            return ['date' => $day, 'today' => $isToday, 'now' => substr($this->nowPK(), 11, 5), 'hr' => $hr, 'snapshot' => $snap, 'settings' => $this->S(), 'totals' => $t, 'rows' => array_map(fn ($r) => $this->outRow($r), $rows)];
        };
        return ! empty($opts['live']) || ! $isToday ? $build() : $this->cached('day:'.$day.':'.$this->tkStamp(), 20000, $build);
    }

    /* ---------- person detail ---------- */
    private function personDay(string $key, $day): ?array
    {
        $day = self::isDay($day) ? $day : $this->todayPK();
        $rows = $this->liveDay($day, ['items' => true])['rows'];
        $row = null;
        foreach ($rows as $r) {
            if ($r['key'] === $key) {
                $row = $r;
                break;
            }
        }
        if (! $row) {
            return null;
        }
        $uid = $row['user_id'];
        $tasks = self::jt($uid) ? Db::all("SELECT t.id,t.title,t.status,t.priority,t.due_date,t.due_time,t.done_at FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=?
      AND (t.due_date=? OR SUBSTR(COALESCE(t.done_at,''),1,10)=? OR (t.done_at IS NULL AND t.due_date<?)) ORDER BY t.due_date, t.due_time", $uid, $day, $day, $day) : [];
        $trend = $this->personTrend($row, self::addDays($day, -29), $day);
        return ['date' => $day, 'row' => $this->outRow($row), 'tasks' => $tasks, 'trend' => $trend, 'settings' => $this->S()];
    }

    private function personTrend(array $p, string $from, string $to): array
    {
        $per = $this->rangeRows($from, $to, [$p['key']]);
        return array_map(fn ($x) => $this->outRow($x), $per[$p['key']] ?? []);
    }

    /* ---------- rows for a range of days (snapshots where saved, otherwise rebuilt from source data) ---------- */
    private function rangeRows(string $from, string $to, ?array $onlyKeys = null): array
    {
        $today = $this->todayPK();
        $out = [];
        $snaps = [];
        foreach (Db::all('SELECT day, pkey, data FROM ops_daily WHERE day>=? AND day<=?', $from, $to) as $s) {
            $snaps[$s['day'].'|'.$s['pkey']] = $s;
        }
        $recs = $this->collect($from, $to);
        $ppl = array_values(array_filter($this->people($to), fn ($p) => ! $onlyKeys || in_array($p['key'], $onlyKeys, true)));
        $tg = $this->allTargets();
        $mm = $this->mistakeMap($from, $to);
        $st0 = $this->S();
        for ($d = $from; $d <= $to; $d = self::addDays($d, 1)) {
            if ($d > $today) {
                break;
            }
            $hr = null;
            $c = null;
            foreach ($ppl as $p) {
                $row = null;
                $s = $d !== $today ? ($snaps[$d.'|'.$p['key']] ?? null) : null;
                if ($s) {
                    $row = $this->J($s['data'], null);
                    if (! is_array($row)) {
                        $row = null;
                    }
                }
                $uid = $p['user_id'] ?? null;
                if (! $row) {
                    $r = self::jt($uid) ? ($recs[$uid.'|'.$d] ?? null) : null;
                    if (self::jt($p['since'] ?? null) && $d < $p['since'] && ! $r) {
                        continue; // not employed yet
                    }
                    if ($hr === null) {
                        $h = $this->hrDay($d);
                        [$by, $byEmp] = $this->hrIndex($h);
                        $hr = ['by' => $by, 'byEmp' => $byEmp];
                    }
                    $c ??= $this->dayCtx($d);
                    $row = $this->buildRow($p, $d, $r, $this->hrRowFor($p, $hr['by'], $hr['byEmp']), $tg, $c);
                }
                $row = $this->applyMistakes($row, self::jt($uid) ? ($mm[$uid.'|'.$d] ?? null) : null, $st0);
                $out[$p['key']][] = ['day' => $d, 'score' => $row['score'] ?? null, 'mistakes' => count($row['mistakes'] ?? []), 'present' => $row['present'] ?? null, 'workday' => $row['workday'] ?? null,
                    'actions' => $row['actions'] ?? null, 'counts' => $row['counts'] ?? [], 'targets' => $row['targets'] ?? null,
                    'flags' => array_map(fn ($f) => $f['k'] ?? null, $row['flags'] ?? []), 'att' => $row['att']['status'] ?? null, 'source' => $row['att']['source'] ?? null, 'tracked' => $row['tracked'] ?? null];
            }
        }
        return $out;
    }

    /* ---------- performance ---------- */
    private function performance($days): array
    {
        $dn = self::num($days);
        $days = in_array($dn, [7, 30, 90]) ? (int) $dn : 30;
        return $this->cached('perf:'.$days.':'.$this->todayPK().':'.$this->tkStamp(), 5 * 60000, function () use ($days) {
            $st = $this->S();
            $to = self::addDays($this->todayPK(), -1);
            $from = self::addDays($to, -($days - 1));
            $from30 = self::addDays($to, -29);
            $today = $this->todayPK();
            $mFrom = self::addDays($today, -($days - 1));
            $m30From = self::addDays($today, -29);
            $mAll = $this->mistakeRows($days >= 30 ? $mFrom : $m30From, $today);
            $todayRecs = $this->collect($today, $today);
            $span = $this->rangeRows($days >= 30 ? $from : $from30, $to);
            $ppl = $this->people($this->todayPK());
            $tg = $this->allTargets();
            $nowS = $this->nowPK();
            $out = [];
            foreach ($ppl as $p) {
                $all = $span[$p['key']] ?? [];
                $sum = function (array $list) use ($st, $p, $tg) {
                    $work = array_values(array_filter($list, fn ($x) => self::jt($x['workday'])));
                    $pres = array_values(array_filter($work, fn ($x) => self::jt($x['present'])));
                    $scored = array_values(array_filter($pres, fn ($x) => $x['score'] !== null));
                    $low = array_filter($scored, fn ($x) => $x['score'] < $st['lowPct']);
                    $absent = count(array_filter($work, fn ($x) => $x['att'] === 'absent' && ! self::jt($x['present'])));
                    $noAct = count(array_filter($work, fn ($x) => $x['source'] !== 'hr' && ! self::jt($x['present'])));
                    $late = count(array_filter($list, fn ($x) => in_array('late', $x['flags'], true)));
                    $lateHr = count(array_filter($list, fn ($x) => in_array('late', $x['flags'], true) && $x['source'] === 'hr'));
                    $tgts = $this->targetsFor($p, $tg);
                    $output = array_map(fn ($t) => ['metric' => $t['metric'], 'label' => $this->metricLabel($t['metric']), 'target' => $t['target'],
                        'avg' => $pres ? self::jsRound(10 * array_sum(array_map(fn ($x) => self::metricValue(is_array($x['counts']) ? $x['counts'] : [], $t['metric']), $pres)) / count($pres)) / 10 : null], $tgts);
                    return ['workDays' => count($work), 'present' => count($pres), 'absent' => $absent, 'noActivityDays' => $noAct, 'late' => $late, 'lateHr' => $lateHr, 'scoredDays' => count($scored), 'lowDays' => count($low),
                        'avgScore' => $scored ? self::jsRound(array_sum(array_map(fn ($x) => $x['score'], $scored)) / count($scored)) : null,
                        'avgActions' => $pres ? self::jsRound(array_sum(array_map(fn ($x) => self::jt($x['actions']) ? $x['actions'] : 0, $pres)) / count($pres)) : 0, 'output' => $output];
                };
                $inP = array_values(array_filter($all, fn ($x) => $x['day'] >= $from));
                $last30 = array_values(array_filter($all, fn ($x) => $x['day'] >= $from30));
                $s = $sum($inP);
                $s30 = $sum($last30);
                $tasksDue = 0;
                $onTime = 0;
                if (self::jt($p['user_id'])) {
                    $r = Db::get("SELECT COUNT(*) n, SUM(CASE WHEN t.done_at IS NOT NULL AND t.done_at <= CONCAT(t.due_date, ' ', COALESCE(t.due_time,'23:59'), ':59') THEN 1 ELSE 0 END) ok
            FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.due_date>=? AND t.due_date<=? AND CONCAT(t.due_date, ' ', COALESCE(t.due_time,'23:59')) < ?", $p['user_id'], $from, $to, $nowS);
                    $tasksDue = $r['n'] ?: 0;
                    $onTime = $r['ok'] ?: 0;
                }
                $warnings = $this->hrWarnings($p, $from, $to);
                $tracked = count($this->targetsFor($p, $tg)) > 0;
                // mistakes (window includes today, so a ticket closed today shows straight away)
                $myM = self::jt($p['user_id']) ? array_values(array_filter($mAll, fn ($m) => (int) $m['uid'] === (int) $p['user_id'])) : [];
                $mInP = array_values(array_filter($myM, fn ($m) => $m['day'] >= $mFrom));
                $m30 = array_values(array_filter($myM, fn ($m) => $m['day'] >= $m30From));
                $byDept = [];
                foreach ($mInP as $m) {
                    $byDept[$m['dept']] = ($byDept[$m['dept']] ?? 0) + 1;
                }
                $mainDept = null;
                foreach ($byDept as $k => $n) {
                    if ($mainDept === null || $n > $mainDept[1]) {
                        $mainDept = [(string) $k, $n];
                    }
                }
                $rate = null;
                $rateBase = null;
                $outputN = null;
                if ($mainDept) {
                    [$metric, $lbl] = self::RATE_BASE[$mainDept[0]] ?? ['actions', 'ERP actions'];
                    $tr = self::jt($p['user_id']) ? ($todayRecs[$p['user_id'].'|'.$today] ?? null) : null;
                    $outputN = array_sum(array_map(fn ($x) => self::jt($x['counts'][$metric] ?? null) ? $x['counts'][$metric] : 0, $inP)) + ($tr && self::jt($tr['counts'][$metric] ?? null) ? $tr['counts'][$metric] : 0);
                    $rateBase = $lbl;
                    $rate = $outputN ? self::jsRound(1000 * count($mInP) / $outputN) / 10 : null;
                }
                $byDeptList = [];
                foreach ($byDept as $k => $n) {
                    $byDeptList[] = ['k' => (string) $k, 'l' => self::DEPTS[$k] ?? (string) $k, 'n' => $n];
                }
                $mistakes = ['n' => count($mInP), 'n30' => count($m30), 'cost' => array_sum(array_map(fn ($m) => self::jt(self::num($m['cost'])) ? self::num($m['cost']) : 0, $mInP)), 'rate' => $rate, 'rateBase' => $rateBase, 'output' => $outputN,
                    'byDept' => $byDeptList, 'list' => array_map(fn ($m) => ['id' => $m['id'], 'day' => $m['day'], 'type' => $m['type'], 'order_name' => $m['order_name'], 'dept' => $m['dept'], 'deptLabel' => $m['deptLabel'], 'reason' => $m['reason'], 'cost' => $m['cost']], array_reverse(array_slice($mInP, -50)))];
                $reasons = [];
                if ($tracked && $s30['scoredDays'] >= 5 && $s30['lowDays'] / $s30['scoredDays'] >= $st['lowShare'] / 100) {
                    $reasons[] = 'Below '.self::str($st['lowPct']).'% of target on '.$s30['lowDays'].' of '.$s30['scoredDays'].' working days (average score '.self::str($s30['avgScore']).'%)';
                }
                if ($s30['absent'] >= $st['absentLimit']) {
                    $reasons[] = 'Absent '.$s30['absent'].' days in the last 30 days';
                }
                if ($tracked && $s30['noActivityDays'] >= $st['absentLimit']) {
                    $reasons[] = 'No ERP activity on '.$s30['noActivityDays'].' working days (no attendance record to say if absent)';
                }
                if ($s30['late'] >= $st['lateLimit']) {
                    $reasons[] = $s30['lateHr'] === $s30['late'] ? 'Late '.$s30['late'].' times in the last 30 days (HR check-in)'
                        : ($s30['lateHr'] ? 'Late '.$s30['late'].' times in the last 30 days ('.$s30['lateHr'].' by HR check-in, '.($s30['late'] - $s30['lateHr']).' by first ERP activity)'
                        : 'Started late '.$s30['late'].' times in the last 30 days (first seen in the ERP after shift start + grace; no HR check-in)');
                }
                $w30 = $this->hrWarnings($p, $from30, $to);
                if ($w30 !== null && $w30 >= 2) {
                    $reasons[] = self::str($w30).' HR warnings in the last 30 days';
                }
                if (self::num($st['mistakeLimit']) > 0 && count($m30) >= self::num($st['mistakeLimit'])) {
                    $g = [];
                    foreach ($m30 as $m) {
                        $k = mb_strtolower(self::jt($m['reason']) ? (string) $m['reason'] : $m['deptLabel'].' mistake');
                        $g[$k] = ($g[$k] ?? 0) + 1;
                    }
                    $parts = [];
                    foreach ($g as $k => $n) {
                        $parts[] = [(string) $k, $n];
                    }
                    usort($parts, fn ($a, $b) => $b[1] <=> $a[1]);
                    $reasons[] = count($parts) === 1 ? count($m30).' customer problems traced to '.$parts[0][0].' in the last 30 days'
                        : count($m30).' customer problems traced to their work in the last 30 days: '.implode(', ', array_map(fn ($x) => $x[1].' × '.$x[0], $parts));
                }
                // abandoned carts recovered after this person contacted them (abandoned module), same window as mistakes (includes today)
                $recovered = null;
                try {
                    $ab = $this->svc('abandoned');
                    if (self::jt($p['user_id']) && $ab) {
                        $rc = self::toArr($ab->recoveredBy($p['user_id'], $mFrom, $today));
                        if (self::jt($rc['n'] ?? null) || $p['role'] === 'social') {
                            $recovered = $rc;
                        }
                    }
                } catch (\Throwable) {
                }
                $out[] = array_merge(['key' => $p['key'], 'user_id' => $p['user_id'], 'name' => $p['name'], 'role' => $p['role'], 'roleLabel' => $p['roleLabel'], 'tracked' => $tracked], $s, [
                    'recovered' => $recovered, 'tasksDue' => $tasksDue, 'tasksOnTime' => $onTime, 'onTimePct' => $tasksDue ? self::jsRound(100 * $onTime / $tasksDue) : null, 'warnings' => $warnings, 'mistakes' => $mistakes,
                    'trend' => array_map(fn ($x) => ['day' => $x['day'], 'score' => self::jt($x['workday']) && self::jt($x['present']) ? $x['score'] : null, 'present' => $x['present'], 'workday' => $x['workday']], $inP),
                    'needsReview' => $reasons, 'enoughData' => $s30['scoredDays'] >= 5]);
            }
            usort($out, fn ($a, $b) => (((int) ($b['avgScore'] !== null)) - ((int) ($a['avgScore'] !== null))) ?: (($b['avgScore'] ?: 0) <=> ($a['avgScore'] ?: 0)) ?: self::localeCmp($a['name'], $b['name']));
            $rank = 0;
            foreach ($out as &$r) {
                $r['rank'] = $r['avgScore'] !== null ? ++$rank : null;
            }
            unset($r);
            // team score per day
            $teamDays = [];
            for ($d = $from; $d <= $to; $d = self::addDays($d, 1)) {
                $sc = [];
                foreach ($out as $r) {
                    foreach ($r['trend'] as $x) {
                        if ($x['day'] === $d) {
                            if ($x['score'] !== null) {
                                $sc[] = $x['score'];
                            }
                            break;
                        }
                    }
                }
                $teamDays[] = ['day' => $d, 'score' => $sc ? self::jsRound(array_sum($sc) / count($sc)) : null, 'people' => count($sc)];
            }
            $deptMonth = $this->mistakesByDept(substr($today, 0, 7));
            $hr = $this->hrSvc();
            return ['days' => $days, 'from' => $from, 'to' => $to, 'mFrom' => $mFrom, 'hr' => $hr !== null && method_exists($hr, 'attendance'), 'settings' => $st, 'people' => $out, 'deptMonth' => $deptMonth, 'tickets' => $this->hasTk(), 'team' => $teamDays,
                'needsReview' => array_values(array_map(fn ($r) => ['key' => $r['key'], 'name' => $r['name'], 'roleLabel' => $r['roleLabel'], 'reasons' => $r['needsReview']], array_filter($out, fn ($r) => count($r['needsReview']) > 0)))];
        });
    }

    /* ---------- mistakes by department for a month (all departments, incl. courier / customer) ---------- */
    private function mistakesByDept($month): array
    {
        if (! $this->hasTk() || ! preg_match('/^\d{4}-\d{2}$/', self::sOr($month))) {
            return ['month' => $month, 'depts' => [], 'people' => [], 'total' => 0];
        }
        $W = "t.status IN ('resolved','closed') AND t.fault_dept IS NOT NULL AND DATE_FORMAT(t.resolved_at + INTERVAL 5 HOUR,'%Y-%m')=?";
        $depts = array_map(function ($r) use ($W, $month) {
            $top = Db::get("SELECT fault_reason k, COUNT(*) n FROM tk_tickets t WHERE $W AND t.fault_dept=? AND fault_reason IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 1", $month, $r['k']);
            return $r + ['l' => self::DEPTS[$r['k']] ?? $r['k'], 'internal' => in_array($r['k'], self::INTERNAL, true), 'top' => $top && self::jt($top['k']) ? $top['k'] : null];
        }, Db::all("SELECT t.fault_dept k, COUNT(*) n, COALESCE(SUM(t.fault_cost),0) cost FROM tk_tickets t WHERE $W GROUP BY t.fault_dept ORDER BY n DESC", $month));
        $people = array_map(fn ($r) => $r + ['key' => 'u:'.$r['id'], 'deptLabel' => self::DEPTS[$r['dept']] ?? $r['dept']],
            Db::all("SELECT t.fault_user_id id, us.name, us.role, t.fault_dept dept, COUNT(*) n FROM tk_tickets t LEFT JOIN users us ON us.id=t.fault_user_id WHERE $W AND t.fault_user_id IS NOT NULL GROUP BY 1, 4 ORDER BY n DESC LIMIT 20", $month));
        return ['month' => $month, 'depts' => $depts, 'people' => $people, 'total' => array_sum(array_column($depts, 'n')),
            'internal' => array_sum(array_column(array_filter($depts, fn ($r) => $r['internal']), 'n'))];
    }

    /* ---------- snapshot ---------- */
    private function snapshot(string $day, $userId = null): array
    {
        $rows = $this->liveDay($day)['rows'];
        $at = $this->nowPK();
        Db::tx(function () use ($rows, $day, $at) {
            Db::run('DELETE FROM ops_daily WHERE day=?', $day);
            foreach ($rows as $r) {
                Db::run('INSERT INTO ops_daily(day,pkey,user_id,name,role,score,data,built_at) VALUES(?,?,?,?,?,?,?,?)', $day, $r['key'], $r['user_id'], $r['name'], $r['role'], $r['score'],
                    json_encode($this->outRow($r), JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE), $at);
            }
        });
        if ($userId) {
            $this->log($userId, 'ops.snapshot', 'ops:'.$day, ['people' => count($rows)]);
        }
        $this->bust();
        return ['ok' => true, 'day' => $day, 'people' => count($rows), 'built_at' => $at];
    }

    /* ---------- tasks ---------- */
    private static function dueKey(array $t): ?string
    {
        return self::jt($t['due_date']) ? $t['due_date'].' '.(self::jt($t['due_time']) ? $t['due_time'] : '23:59') : null;
    }

    private function taskOut(array $t, array $u): array
    {
        $users = Db::all('SELECT a.user_id id, us.name, a.seen_at FROM ops_task_users a LEFT JOIN users us ON us.id=a.user_id WHERE a.task_id=?', $t['id']);
        $now = $this->nowPK();
        $dk = self::dueKey($t);
        $me = null;
        foreach ($users as $x) {
            if ((int) $x['id'] === (int) $u['id']) {
                $me = $x;
                break;
            }
        }
        $overdue = $t['status'] !== 'done' ? ($dk === null ? null : $dk < substr($now, 0, 16)) : false;
        $unread = (bool) ($me && $t['last_by'] !== $u['id'] && (! self::jt($me['seen_at']) || (string) $me['seen_at'] < (string) $t['updated_at']));
        return array_merge($t, ['files' => $this->J($t['files'], []), 'checklist' => $this->J($t['checklist'], []), 'assignees' => array_map(fn ($x) => ['id' => $x['id'], 'name' => $x['name']], $users),
            'creator' => $t['created_by'] !== null ? Db::val('SELECT name FROM users WHERE id=?', $t['created_by']) : null, 'overdue' => $overdue, 'unread' => $unread]);
    }

    private function canSeeTask(array $t, array $u): bool
    {
        return $this->can($u, 'team') || $t['created_by'] === $u['id'] || (bool) Db::get('SELECT 1 FROM ops_task_users WHERE task_id=? AND user_id=?', $t['id'], $u['id']);
    }

    private function canEditTask(array $t, array $u): bool
    {
        return $this->can($u, 'team') || $t['created_by'] === $u['id'];
    }

    private function cleanTask(array $b, ?array $u, ?array $old = null): array
    {
        $v = [];
        if (! $old || array_key_exists('title', $b)) {
            $v['title'] = mb_substr(trim(self::sOr($b['title'] ?? null)), 0, 200);
            $this->need($v['title'] !== '', 'Write a title');
        }
        if (array_key_exists('description', $b)) {
            $v['description'] = mb_substr(self::sOr($b['description']), 0, 4000);
        }
        if (array_key_exists('priority', $b)) {
            $v['priority'] = in_array($b['priority'], self::PRIOS, true) ? $b['priority'] : 'normal';
        }
        if (array_key_exists('due_date', $b)) {
            $v['due_date'] = self::jt($b['due_date']) ? mb_substr(self::str($b['due_date']), 0, 10) : null;
            $this->need($v['due_date'] === null || self::isDay($v['due_date']), 'Due date must be YYYY-MM-DD');
        }
        if (array_key_exists('due_time', $b)) {
            $v['due_time'] = self::jt($b['due_time']) ? self::min2hm(self::hm2min($b['due_time'])) : null;
        }
        if (array_key_exists('link_type', $b)) {
            $v['link_type'] = in_array($b['link_type'], ['order', 'sku', 'ticket'], true) ? $b['link_type'] : null;
        }
        if (array_key_exists('link_ref', $b)) {
            $v['link_ref'] = self::jt($b['link_ref']) ? mb_substr(trim(self::str($b['link_ref'])), 0, 60) : null;
        }
        if (array_key_exists('files', $b)) {
            $f = is_array($b['files']) && array_is_list($b['files']) ? $b['files'] : [];
            $v['files'] = json_encode(array_slice(array_values(array_filter($f, fn ($x) => (bool) preg_match('/^[a-f0-9]{8,40}$/', self::str($x)))), 0, 10), JSON_UNESCAPED_UNICODE);
        }
        if (array_key_exists('checklist', $b)) {
            $cl = is_array($b['checklist']) && array_is_list($b['checklist']) ? $b['checklist'] : [];
            $cl = array_map(function ($c) {
                if (is_string($c)) {
                    return ['t' => $c, 'done' => false];
                }
                $c = is_array($c) ? $c : [];
                return ['t' => self::sOr(self::orr($c['t'] ?? null, $c['text'] ?? null, '')), 'done' => self::jt($c['done'] ?? null)];
            }, $cl);
            $cl = array_slice(array_values(array_filter($cl, fn ($c) => trim($c['t']) !== '')), 0, 50);
            $v['checklist'] = json_encode(array_map(fn ($c) => ['t' => mb_substr(trim($c['t']), 0, 200), 'done' => $c['done']], $cl), JSON_UNESCAPED_UNICODE);
        }
        return $v;
    }

    private function assigneesFor(array $b, array $u): array
    {
        $ids = [];
        if (isset($b['assignees']) && is_array($b['assignees']) && array_is_list($b['assignees'])) {
            foreach ($b['assignees'] as $x) {
                $n = self::num($x);
                if (self::jt($n)) {
                    $ids[] = is_float($n) && floor($n) == $n ? (int) $n : $n;
                }
            }
        }
        if (! $ids) {
            $ids = [$u['id']];
        }
        $ids = array_values(array_unique($ids, SORT_REGULAR));
        if (! $this->can($u, 'team')) {
            $this->need(count($ids) === 1 && $ids[0] === $u['id'], 'You can only create tasks for yourself. Ask a manager to assign tasks to others.', 403);
        }
        foreach ($ids as $id) {
            $this->need(Db::get('SELECT 1 FROM users WHERE id=? AND active=1', $id), 'Unknown person');
        }
        return $ids;
    }

    private function comment($taskId, $uid, string $kind, string $text): void
    {
        Db::run('INSERT INTO ops_comments(task_id,user_id,kind,text,at) VALUES(?,?,?,?,?)', $taskId, $uid, $kind, $text, $this->nowPK());
    }

    private function createTask(array $b, ?array $u, array $extra = []): ?int
    {
        $v = $this->cleanTask($b, $u);
        $ids = $extra['assignees'] ?? $this->assigneesFor($b, $u);
        $now = $this->nowPK();
        $tpl = ! empty($extra['template_id']);
        $r = Db::run('INSERT '.($tpl ? 'IGNORE ' : '').'INTO ops_tasks(title,description,priority,status,due_date,due_time,link_type,link_ref,files,checklist,created_by,created_at,updated_at,last_by,template_id,gen_date)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', $v['title'], self::jt($v['description'] ?? null) ? $v['description'] : null, self::jt($v['priority'] ?? null) ? $v['priority'] : 'normal', 'todo',
            self::jt($v['due_date'] ?? null) ? $v['due_date'] : null, self::jt($v['due_time'] ?? null) ? $v['due_time'] : null, self::jt($v['link_type'] ?? null) ? $v['link_type'] : null,
            self::jt($v['link_ref'] ?? null) ? $v['link_ref'] : null, self::jt($v['files'] ?? null) ? $v['files'] : '[]', self::jt($v['checklist'] ?? null) ? $v['checklist'] : '[]',
            $u ? $u['id'] : null, $now, $now, $u ? $u['id'] : null, $extra['template_id'] ?? null, $extra['gen_date'] ?? null);
        if (! $r->changes) {
            return null;
        }
        $id = (int) $r->lastInsertRowid;
        foreach ($ids as $a) {
            Db::run('INSERT IGNORE INTO ops_task_users(task_id,user_id) VALUES(?,?)', $id, $a);
        }
        $this->comment($id, $u ? $u['id'] : null, 'system', $tpl ? 'Created from a recurring task' : 'Created the task');
        if ($u) {
            $this->log($u['id'], 'ops.task.create', 'task:'.$id, $v['title']);
        }
        $this->bust();
        return $id;
    }

    /* ---------- recurring templates ---------- */
    private function templateDue(array $t, string $day): bool
    {
        if (! self::jt($t['active'])) {
            return false;
        }
        if ($t['freq'] === 'daily') {
            return in_array(self::weekday($day), $this->S()['workdays'] ?? [], true);
        }
        if ($t['freq'] === 'weekdays') {
            $w = $this->J($t['weekdays'], []);
            return in_array(self::weekday($day), array_map(fn ($x) => self::num($x), is_array($w) ? $w : []), false);
        }
        if ($t['freq'] === 'monthly') {
            $d = (int) substr($day, 8, 2);
            $last = (int) gmdate('t', strtotime(substr($day, 0, 7).'-01 00:00:00 UTC'));
            $md = self::num($t['month_day']);
            return $d === min(self::jt($md) ? $md : 1, $last);
        }
        return false;
    }

    private function generate($day = null): int
    {
        $day = self::jt($day) ? $day : $this->todayPK();
        $made = 0;
        foreach (Db::all('SELECT * FROM ops_templates WHERE active=1') as $t) {
            if (! $this->templateDue($t, $day)) {
                continue;
            }
            if (Db::get('SELECT 1 FROM ops_tasks WHERE template_id=? AND gen_date=?', $t['id'], $day)) {
                continue;
            }
            $ids = $t['scope'] === 'user'
                ? array_column(Db::all('SELECT id FROM users WHERE id=? AND active=1', self::num($t['ref'])), 'id')
                : array_column(Db::all('SELECT id FROM users WHERE role=? AND active=1', $t['ref']), 'id');
            if (! $ids) {
                continue;
            }
            $id = $this->createTask(['title' => $t['title'], 'description' => $t['description'], 'priority' => $t['priority'], 'due_date' => $day, 'due_time' => $t['due_time'], 'checklist' => $this->J($t['checklist'], [])],
                null, ['template_id' => $t['id'], 'gen_date' => $day, 'assignees' => $ids]);
            if ($id) {
                Db::run('UPDATE ops_tasks SET created_by=? WHERE id=?', $t['created_by'], $id);
                $made++;
            }
        }
        $this->setSetting('ops_gen_day', $day);
        return $made;
    }

    private function ensureGenerated(): void
    {
        $d = $this->todayPK();
        if ($this->setting('ops_gen_day') !== $d) {
            $this->generate($d);
        }
    }

    /* ---------- my tasks (service) ---------- */
    public function myTasks($userId): ?array
    {
        $u = Db::get('SELECT id FROM users WHERE id=?', $userId);
        if (! $u) {
            return null;
        }
        $this->ensureGenerated();
        $rows = Db::all("SELECT DISTINCT t.* FROM ops_tasks t LEFT JOIN ops_task_users a ON a.task_id=t.id
      WHERE (a.user_id=? OR (t.created_by=? AND NOT EXISTS(SELECT 1 FROM ops_task_users x WHERE x.task_id=t.id)))
      AND (t.status<>'done' OR t.done_at >= ?) ORDER BY COALESCE(t.due_date,'9999'), COALESCE(t.due_time,'23:59'), t.id", $userId, $userId, self::addDays($this->todayPK(), -7));
        $me = ['id' => $u['id']];
        $today = $this->todayPK();
        $g = ['overdue' => [], 'today' => [], 'upcoming' => [], 'nodate' => [], 'done' => []];
        foreach ($rows as $row) {
            $t = $this->taskOut($row, $me);
            if ($t['status'] === 'done') {
                $g['done'][] = $t;
            } elseif (self::jt($t['overdue'])) {
                $g['overdue'][] = $t;
            } elseif ($t['due_date'] === $today) {
                $g['today'][] = $t;
            } elseif (self::jt($t['due_date'])) {
                $g['upcoming'][] = $t;
            } else {
                $g['nodate'][] = $t;
            }
        }
        usort($g['done'], fn ($a, $b) => strcmp((string) ($b['done_at'] ?? ''), (string) ($a['done_at'] ?? '')));
        return $g + ['counts' => ['overdue' => count($g['overdue']), 'today' => count($g['today']), 'upcoming' => count($g['upcoming']),
            'open' => count($g['overdue']) + count($g['today']) + count($g['upcoming']) + count($g['nodate'])]];
    }

    /* ---------- my output today (service) ---------- */
    public function myOutput($userId): ?array
    {
        $u = Db::get('SELECT id,name,role FROM users WHERE id=?', $userId);
        if (! $u) {
            return null;
        }
        $day = $this->todayPK();
        $r = $this->collect($day, $day)[$u['id'].'|'.$day] ?? null;
        $p = ['key' => 'u:'.$u['id'], 'user_id' => $u['id'], 'role' => $u['role']];
        $sc = $this->scoreOf($r ? $r['counts'] : [], $this->targetsFor($p));
        $lab = [];
        foreach (($r ? $r['labels'] : []) as $l => $n) {
            $lab[] = ['l' => (string) $l, 'n' => $n];
        }
        usort($lab, fn ($a, $b) => $b['n'] <=> $a['n']);
        return ['day' => $day, 'score' => $sc['score'], 'parts' => $sc['parts'], 'actions' => $r && self::jt($r['counts']['actions'] ?? null) ? $r['counts']['actions'] : 0,
            'first' => $r && $r['times'] ? substr($r['times'][0], 0, 5) : null, 'last' => $r && $r['times'] ? substr($r['times'][count($r['times']) - 1], 0, 5) : null, 'labels' => $lab];
    }

    /** service: home page numbers */
    public function summary(): array
    {
        $d = $this->dayReport($this->todayPK());
        $open = Db::get("SELECT COUNT(*) n, SUM(CASE WHEN due_date IS NOT NULL AND CONCAT(due_date, ' ', COALESCE(due_time,'23:59')) < ? THEN 1 ELSE 0 END) od FROM ops_tasks WHERE status<>'done'", substr($this->nowPK(), 0, 16));
        $needsReview = null;
        try {
            $needsReview = count($this->performance(30)['needsReview']);
        } catch (\Throwable) {
        }
        $t = $d['totals'];
        return ['checkedIn' => $t['present'], 'staff' => $t['staff'], 'idle' => $t['idle'], 'noActivity' => $t['noActivity'], 'low' => $t['low'], 'avgScore' => $t['avgScore'],
            'tasksOpen' => $open['n'] ?: 0, 'overdue' => $open['od'] ?: 0, 'needsReview' => $needsReview, 'eodMissing' => max(0, $t['eodDue'] - $t['eod'])];
    }

    /* ---------- jobs ---------- */
    private function tick($now = null): array
    {
        $now = self::jt($now) ? $now : $this->nowPK();
        $day = substr($now, 0, 10);
        $hm = substr($now, 11, 5);
        $st = $this->S();
        $out = [];
        if ($this->setting('ops_gen_day') !== $day && $hm >= '00:05') {
            $out['generated'] = $this->generate($day);
        }
        if ($hm >= $st['snapshotAt'] && $this->setting('ops_snap_day') !== $day) {
            $out['snapshot'] = $this->snapshot($day)['people'];
            $this->setSetting('ops_snap_day', $day);
        }
        $y = self::addDays($day, -1);
        if ($this->setting('ops_snap_check') !== $day) { // server was off at snapshot time yesterday? keep the history anyway
            if (! Db::get('SELECT 1 FROM ops_daily WHERE day=? LIMIT 1', $y) && Db::get('SELECT 1 FROM users WHERE role<>? LIMIT 1', 'admin')) {
                $out['backfill'] = $this->snapshot($y)['people'];
            }
            $this->setSetting('ops_snap_check', $day);
        }
        return $out;
    }

    public function jobs(): array
    {
        return [['name' => 'daily', 'every' => 5, 'offset' => 2, 'run' => fn () => $this->tick()]];
    }

    public function counts(array $u): array
    {
        if (! $this->can($u, 'tasks')) {
            return [];
        }
        $today = substr($this->nowPK(), 0, 10);
        $n = Db::val("SELECT COUNT(DISTINCT t.id) n FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<=?", $u['id'], $today);
        return ['tasks' => $n ?: 0];
    }

    public function alerts(array $u): array
    {
        $out = [];
        $st = $this->S();
        $now = $this->nowPK();
        $today = substr($now, 0, 10);
        $hm = substr($now, 11, 5);
        $workday = in_array(self::weekday($today), $st['workdays'] ?? [], true);
        if ($this->can($u, 'tasks')) {
            $od = Db::val("SELECT COUNT(DISTINCT t.id) n FROM ops_tasks t JOIN ops_task_users a ON a.task_id=t.id WHERE a.user_id=? AND t.status<>'done' AND t.due_date IS NOT NULL AND CONCAT(t.due_date, ' ', COALESCE(t.due_time,'23:59')) < ?", $u['id'], substr($now, 0, 16));
            if ($od) {
                $out[] = ['level' => 'warn', 'text' => 'You have '.$od.' overdue task'.($od > 1 ? 's' : ''), 'href' => '#/tasks'];
            }
            $onReport = (bool) array_filter($this->people($today), fn ($p) => ($p['user_id'] ?? null) === $u['id']);
            if ($onReport && $workday && $hm >= $st['eodRemind'] && ! Db::get('SELECT 1 FROM ops_eod WHERE user_id=? AND day=?', $u['id'], $today)) {
                $out[] = ['level' => 'warn', 'text' => 'Write your end-of-day report before you leave', 'href' => '#/tasks/eod'];
            }
        }
        if ($this->can($u, 'team') && $workday) {
            $d = $this->dayReport($today);
            $na = array_values(array_filter($d['rows'], fn ($r) => (bool) array_filter($r['flags'], fn ($f) => $f['k'] === 'noact' && $f['lv'] === 'bad')));
            if ($na && $hm >= $st['noActBy']) {
                $out[] = ['level' => 'bad', 'text' => count($na).' staff with no work recorded yet today: '.implode(', ', array_map(fn ($r) => $r['name'], array_slice($na, 0, 4))).(count($na) > 4 ? '…' : ''), 'href' => '#/team'];
            }
            $od = Db::val("SELECT COUNT(*) n FROM ops_tasks WHERE status<>'done' AND due_date IS NOT NULL AND CONCAT(due_date, ' ', COALESCE(due_time,'23:59')) < ?", substr($now, 0, 16));
            if ($od) {
                $out[] = ['level' => 'warn', 'text' => $od.' team task'.($od > 1 ? 's are' : ' is').' overdue', 'href' => '#/tasks/board'];
            }
            if ($hm >= $st['eodRemind']) {
                $miss = array_filter($d['rows'], fn ($r) => self::jt($r['user_id']) && self::jt($r['present']) && ! self::jt($r['eod']));
                if ($miss) {
                    $out[] = ['level' => 'info', 'text' => count($miss).' of '.$d['totals']['eodDue']." people have not written today's end-of-day note", 'href' => '#/team'];
                }
            }
        }
        return $out;
    }

    /* ======================================================================
     * routes
     * ==================================================================== */

    public function routes(Router $r): void
    {
        /* --- daily report --- */
        $r->get('/api/ops/day', 'team', 'dayRoute');
        $r->get('/api/ops/person/:key', 'tasks', 'personRoute');
        $r->post('/api/ops/snapshot', 'team', 'snapshotRoute');
        /* --- targets & settings --- */
        $r->get('/api/ops/targets', 'team', 'targetsGet');
        $r->post('/api/ops/targets', 'team', 'targetsSave');
        $r->delete('/api/ops/targets/:id', 'team', 'targetsDelete');
        $r->post('/api/ops/settings', 'team', 'settingsSave');
        /* --- performance --- */
        $r->get('/api/ops/performance', 'team', 'performanceRoute');
        $r->get('/api/ops/mistakes', 'team', 'mistakesRoute');
        /* --- tasks --- */
        $r->get('/api/ops/people', 'tasks', 'peopleRoute');
        $r->get('/api/ops/tasks', 'tasks', 'tasksList');
        $r->get('/api/ops/tasks/:id', 'tasks', 'taskGet');
        $r->post('/api/ops/tasks', 'tasks', 'taskCreate');
        $r->post('/api/ops/tasks/:id', 'tasks', 'taskUpdate');
        $r->post('/api/ops/tasks/:id/comment', 'tasks', 'taskComment');
        $r->delete('/api/ops/tasks/:id', 'tasks', 'taskDelete');
        /* --- recurring templates --- */
        $r->get('/api/ops/templates', 'team', 'templatesList');
        $r->post('/api/ops/templates', 'team', 'templateCreate');
        $r->post('/api/ops/templates/:id', 'team', 'templateUpdate');
        $r->delete('/api/ops/templates/:id', 'team', 'templateDelete');
        $r->post('/api/ops/templates-run', 'team', 'templatesRun');
        // run the background job now (owner tool + tests); 'now' lets you pretend it is a given Pakistan time
        $r->post('/api/ops/run-jobs', 'settings', 'runJobs');
        /* --- end-of-day notes --- */
        $r->get('/api/ops/eod', 'tasks', 'eodGet');
        $r->post('/api/ops/eod', 'tasks', 'eodSave');
        $r->get('/api/ops/me', 'tasks', 'meRoute');
    }

    public function dayRoute(?array $u, array $b, array $p, array $qs): array
    {
        return $this->dayReport($qs['date'] ?? null, ['live' => ($qs['live'] ?? null) === '1']);
    }

    public function personRoute(?array $u, array $b, array $p, array $qs): array
    {
        $key = (string) $p['key'];
        $this->need($this->can($u, 'team') || $key === 'u:'.$u['id'], 'Only managers can see other people\'s day', 403);
        $d = $this->personDay($key, $qs['date'] ?? null);
        $this->need($d, 'Person not found', 404);
        return $d;
    }

    public function snapshotRoute(?array $u, array $b): array
    {
        $d = self::isDay($b['date'] ?? null) ? $b['date'] : $this->todayPK();
        $this->need($d <= $this->todayPK(), 'Cannot build a future day');
        return $this->snapshot($d, $u['id']);
    }

    public function targetsGet(?array $u): array
    {
        $L = $this->labels();
        $actions = array_values(array_filter(array_column(Db::all('SELECT action, COUNT(*) n FROM events WHERE at>=(UTC_TIMESTAMP() - INTERVAL 60 DAY) AND user_id IS NOT NULL GROUP BY action ORDER BY n DESC LIMIT 80'), 'action'),
            fn ($a) => self::jt($a) && ! str_starts_with($a, 'cs:') && $a !== 'login'));
        $keys = array_values(array_filter(array_map('strval', array_keys($L)), fn ($a) => $a !== 'login'));
        $acts = array_map(fn ($a) => ['k' => 'action:'.$a, 'l' => self::jt($L[$a] ?? null) ? $L[$a] : self::pretty($a)], array_values(array_unique(array_merge($keys, $actions))));
        $ppl = $this->people($this->todayPK());
        $pkeys = array_column($ppl, 'key');
        $users = array_map(function ($x) use ($pkeys) {
            $x['key'] = 'u:'.$x['id'];
            $x['roleLabel'] = $this->roleLabel($x['role']);
            $x['onReport'] = in_array($x['key'], $pkeys, true);
            $x['targets'] = array_map(fn ($t) => $t + ['label' => $this->metricLabel($t['metric'])], $this->targetsFor($x));
            return $x;
        }, Db::all('SELECT id,name,role,active FROM users WHERE active=1 ORDER BY name'));
        $roles = [];
        foreach ($this->roles() as $k => $v) {
            if ($k !== 'admin') {
                $roles[] = ['k' => $k, 'l' => $v['label']];
            }
        }
        $metrics = [];
        foreach (self::METRICS as $k => $l) {
            $metrics[] = ['k' => $k, 'l' => $l];
        }
        return ['metrics' => $metrics, 'actions' => $acts, 'roles' => $roles,
            'targets' => array_map(fn ($t) => $t + ['label' => $this->metricLabel($t['metric'])], $this->allTargets()), 'users' => $users,
            'hrOnly' => array_values(array_filter($ppl, fn ($x) => ! empty($x['noLogin']))), 'settings' => $this->S()];
    }

    public function targetsSave(?array $u, array $b): array
    {
        $this->need(in_array($b['scope'] ?? null, ['role', 'person'], true), 'Choose role or person');
        $this->need(self::jt($b['ref'] ?? null), 'Choose who this target is for');
        $metric = self::sOr($b['metric'] ?? null);
        $this->need(isset(self::METRICS[$metric]) || preg_match('/^action:[\w.:*-]+$/', $metric), 'Choose what to count');
        $target = self::num($b['target'] ?? null);
        $this->need(array_key_exists('target', $b) && $target >= 0 && $target < 100000, 'Target must be a number');
        $ref = self::str($b['ref']);
        if ($b['scope'] === 'role') {
            $this->need(isset($this->roles()[$ref]), 'Unknown role');
        } else {
            $this->need(preg_match('/^(u|e):\w+$/', $ref), 'Unknown person');
        }
        $weight = self::num($b['weight'] ?? null);
        if ($b['scope'] === 'role' && ! ($target > 0)) {
            Db::run('DELETE FROM ops_targets WHERE scope=? AND ref=? AND metric=?', 'role', $ref, $metric);
        } else {
            Db::run('INSERT INTO ops_targets(scope,ref,metric,target,weight,updated_by,updated_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE target=VALUES(target), weight=VALUES(weight), updated_by=VALUES(updated_by), updated_at=VALUES(updated_at)', $b['scope'], $ref, $metric, $target, $weight > 0 ? $weight : 1, $u['id']);
        }
        $this->log($u['id'], 'ops.target', 'target:'.$b['scope'].':'.$ref, ['metric' => $metric, 'target' => $target, 'weight' => self::jt($weight) ? $weight : 1]);
        $this->bust();
        return ['ok' => true];
    }

    public function targetsDelete(?array $u, array $b, array $p): array
    {
        $t = Db::get('SELECT * FROM ops_targets WHERE id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        Db::run('DELETE FROM ops_targets WHERE id=?', $t['id']);
        $this->log($u['id'], 'ops.target', 'target:'.$t['scope'].':'.$t['ref'], ['metric' => $t['metric'], 'removed' => true]);
        $this->bust();
        return ['ok' => true];
    }

    public function settingsSave(?array $u, array $b): array
    {
        $v = $this->S();
        foreach (['shiftStart', 'shiftEnd', 'breakStart', 'breakEnd', 'noActBy', 'eodRemind', 'snapshotAt'] as $k) {
            if (array_key_exists($k, $b)) {
                $m = self::hm2min($b[$k]);
                $this->need($m !== null && $m < 24 * 60, $k.' must be a time like 10:00');
                $v[$k] = self::min2hm($m);
            }
        }
        foreach (['idleMin', 'lateGrace', 'lowPct', 'lowShare', 'absentLimit', 'lateLimit', 'mistakePenalty', 'mistakeLimit'] as $k) {
            if (array_key_exists($k, $b)) {
                $n = self::num($b[$k]);
                $this->need($n >= 0 && $n <= 1000, $k.' must be a number');
                $v[$k] = $n;
            }
        }
        if (array_key_exists('workdays', $b)) {
            $w = is_array($b['workdays']) && array_is_list($b['workdays']) ? $b['workdays'] : [];
            $v['workdays'] = array_values(array_filter(array_map(fn ($d) => self::num($d), $w), fn ($d) => $d >= 0 && $d <= 6));
        }
        if (array_key_exists('hidden', $b)) {
            $h = is_array($b['hidden']) && array_is_list($b['hidden']) ? $b['hidden'] : [];
            $v['hidden'] = array_values(array_filter(array_map(fn ($x) => self::str($x), $h), fn ($x) => (bool) preg_match('/^(u|e):\w+$/', $x)));
        }
        if (array_key_exists('showAdmins', $b)) {
            $v['showAdmins'] = self::jt($b['showAdmins']);
        }
        $this->need(self::hm2min($v['shiftEnd']) > self::hm2min($v['shiftStart']), 'Shift must end after it starts');
        $this->setSetting('ops_settings', $v);
        $this->log($u['id'], 'ops.settings', 'settings', $b ?: new \stdClass);
        $this->bust();
        return $v;
    }

    public function performanceRoute(?array $u, array $b, array $p, array $qs): array
    {
        return $this->performance($qs['days'] ?? null);
    }

    public function mistakesRoute(?array $u, array $b, array $p, array $qs): array
    {
        $m = $qs['month'] ?? '';
        return $this->mistakesByDept(is_string($m) && preg_match('/^\d{4}-\d{2}$/', $m) ? $m : substr($this->todayPK(), 0, 7));
    }

    public function peopleRoute(?array $u): array
    {
        $roles = [];
        foreach ($this->roles() as $k => $v) {
            $roles[] = ['k' => $k, 'l' => $v['label']];
        }
        return [
            'users' => $this->can($u, 'team') ? array_map(fn ($x) => $x + ['roleLabel' => $this->roleLabel($x['role'])], Db::all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'))
                : [['id' => $u['id'], 'name' => $u['name'], 'role' => $u['role'], 'roleLabel' => $this->roleLabel($u['role'])]],
            'roles' => $roles, 'team' => $this->can($u, 'team'),
        ];
    }

    public function tasksList(?array $u, array $b, array $p, array $qs): ?array
    {
        if (($qs['view'] ?? null) !== 'board') {
            return $this->myTasks($u['id']);
        }
        $this->need($this->can($u, 'team'), 'Only managers can see the team board', 403);
        $this->ensureGenerated();
        $dd = self::num($qs['doneDays'] ?? null);
        $w = ["(t.status<>'done' OR t.done_at >= ?)"];
        $a = [self::addDays($this->todayPK(), -(int) (self::jt($dd) ? $dd : 7))];
        if (self::jt($qs['user'] ?? null)) {
            $w[] = 't.id IN (SELECT task_id FROM ops_task_users WHERE user_id=?)';
            $un = self::num($qs['user']);
            $a[] = is_nan((float) $un) ? -1 : $un;
        }
        if (self::jt($qs['q'] ?? null)) {
            $w[] = '(t.title LIKE ? OR t.link_ref LIKE ?)';
            $a[] = '%'.$qs['q'].'%';
            $a[] = '%'.$qs['q'].'%';
        }
        $rows = array_map(fn ($t) => $this->taskOut($t, $u), Db::all('SELECT t.* FROM ops_tasks t WHERE '.implode(' AND ', $w)." ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, COALESCE(t.due_date,'9999'), t.id LIMIT 500", ...$a));
        return ['rows' => $rows];
    }

    private function taskRow($id): ?array
    {
        return Db::get('SELECT * FROM ops_tasks WHERE id=?', (int) $id);
    }

    public function taskGet(?array $u, array $b, array $p): array
    {
        $t = $this->taskRow($p['id']);
        $this->need($t, 'Task not found', 404);
        $this->need($this->canSeeTask($t, $u), 'This task is not yours', 403);
        $out = $this->taskOut($t, $u);
        Db::run('UPDATE ops_task_users SET seen_at=? WHERE task_id=? AND user_id=?', $this->nowPK(), $t['id'], $u['id']);
        $out['comments'] = Db::all('SELECT c.*, us.name `user` FROM ops_comments c LEFT JOIN users us ON us.id=c.user_id WHERE task_id=? ORDER BY c.id', $t['id']);
        $out['canEdit'] = $this->canEditTask($t, $u);
        $out['template'] = $t['template_id'] ? Db::get('SELECT id,title,freq FROM ops_templates WHERE id=?', $t['template_id']) : null;
        return $out;
    }

    public function taskCreate(?array $u, array $b): array
    {
        $id = $this->createTask($b, $u);
        return $this->taskOut($this->taskRow($id), $u);
    }

    public function taskUpdate(?array $u, array $b, array $p): array
    {
        $t = $this->taskRow($p['id']);
        $this->need($t, 'Task not found', 404);
        $this->need($this->canSeeTask($t, $u), 'This task is not yours', 403);
        $now = $this->nowPK();
        $sets = [];
        $editing = false;
        foreach (['title', 'description', 'priority', 'due_date', 'due_time', 'link_type', 'link_ref', 'files', 'assignees'] as $k) {
            if (array_key_exists($k, $b)) {
                $editing = true;
            }
        }
        if ($editing) {
            $this->need($this->canEditTask($t, $u), 'Only the person who made this task or a manager can change it', 403);
            $sets = array_merge($sets, $this->cleanTask($b, $u, $t));
            if (array_key_exists('assignees', $b)) {
                $ids = $this->assigneesFor($b, $u);
                Db::run('DELETE FROM ops_task_users WHERE task_id=? AND user_id NOT IN ('.Db::marks($ids).')', $t['id'], ...$ids);
                foreach ($ids as $a) {
                    Db::run('INSERT IGNORE INTO ops_task_users(task_id,user_id) VALUES(?,?)', $t['id'], $a);
                }
            }
            $this->comment($t['id'], $u['id'], 'system', 'Edited the task');
            $this->log($u['id'], 'ops.task.edit', 'task:'.$t['id'], $t['title']);
        }
        if (array_key_exists('checklist', $b)) {
            $cl = $this->cleanTask(['checklist' => $b['checklist']], $u, $t)['checklist'];
            $before = json_decode((string) (self::jt($t['checklist']) ? $t['checklist'] : '[]'), true) ?: [];
            if (! $this->canEditTask($t, $u)) {
                $this->need(json_encode(array_map(fn ($c) => $c['t'], json_decode($cl, true)), JSON_UNESCAPED_UNICODE) === json_encode(array_map(fn ($c) => is_array($c) ? ($c['t'] ?? null) : null, $before), JSON_UNESCAPED_UNICODE),
                    'You can tick items but only the creator or a manager can change the list', 403);
            }
            $sets['checklist'] = $cl;
        }
        if (array_key_exists('status', $b) && $b['status'] !== $t['status']) {
            $this->need(in_array($b['status'], self::STATUSES, true), 'Unknown status');
            if ($b['status'] === 'blocked') {
                $this->need(trim(self::sOr($b['note'] ?? null)) !== '', 'Say what is blocking this task');
            }
            $sets['status'] = $b['status'];
            if ($b['status'] === 'done') {
                $sets['done_at'] = $now;
                $sets['done_by'] = $u['id'];
            } elseif ($t['status'] === 'done') {
                $sets['done_at'] = null;
                $sets['done_by'] = null;
            }
            $lbl = ['todo' => 'To do', 'doing' => 'Doing', 'blocked' => 'Blocked', 'done' => 'Done'][$b['status']];
            $this->comment($t['id'], $u['id'], 'status', $lbl.(self::jt($b['note'] ?? null) ? ': '.mb_substr(self::str($b['note']), 0, 500) : ''));
            $this->log($u['id'], $b['status'] === 'done' ? 'ops.task.done' : 'ops.task.status', 'task:'.$t['id'], $b['status'] === 'done' ? $t['title'] : $b['status']);
        }
        if (! $sets && ! $editing) {
            return $this->taskOut($t, $u);
        }
        $sets['updated_at'] = $now;
        $sets['last_by'] = $u['id'];
        Db::run('UPDATE ops_tasks SET '.implode(',', array_map(fn ($k) => "`$k`=?", array_keys($sets))).' WHERE id=?', ...array_merge(array_values($sets), [$t['id']]));
        $this->bust();
        return $this->taskOut($this->taskRow($t['id']), $u);
    }

    public function taskComment(?array $u, array $b, array $p): array
    {
        $t = $this->taskRow($p['id']);
        $this->need($t, 'Task not found', 404);
        $this->need($this->canSeeTask($t, $u), 'This task is not yours', 403);
        $text = trim(self::sOr($b['text'] ?? null));
        $this->need($text !== '', 'Write a comment');
        $this->comment($t['id'], $u['id'], 'comment', mb_substr($text, 0, 2000));
        Db::run('UPDATE ops_tasks SET updated_at=?, last_by=? WHERE id=?', $this->nowPK(), $u['id'], $t['id']);
        $this->log($u['id'], 'ops.task.comment', 'task:'.$t['id'], mb_substr($text, 0, 80));
        return ['ok' => true];
    }

    public function taskDelete(?array $u, array $b, array $p): array
    {
        $t = $this->taskRow($p['id']);
        $this->need($t, 'Task not found', 404);
        $this->need($this->canEditTask($t, $u), 'Only the person who made this task or a manager can delete it', 403);
        Db::tx(function () use ($t) {
            Db::run('DELETE FROM ops_task_users WHERE task_id=?', $t['id']);
            Db::run('DELETE FROM ops_comments WHERE task_id=?', $t['id']);
            Db::run('DELETE FROM ops_tasks WHERE id=?', $t['id']);
        });
        $this->log($u['id'], 'ops.task.delete', 'task:'.$t['id'], $t['title']);
        $this->bust();
        return ['ok' => true];
    }

    /* --- recurring templates --- */
    private function tplIn(array $b): array
    {
        $v = ['title' => mb_substr(trim(self::sOr($b['title'] ?? null)), 0, 200), 'description' => mb_substr(self::sOr($b['description'] ?? null), 0, 2000),
            'priority' => in_array($b['priority'] ?? null, self::PRIOS, true) ? $b['priority'] : 'normal'];
        $this->need($v['title'] !== '', 'Write a title');
        $this->need(in_array($b['scope'] ?? null, ['user', 'role'], true), 'Choose a person or a role');
        $v['scope'] = $b['scope'];
        $v['ref'] = self::sOr($b['ref'] ?? null);
        if ($v['scope'] === 'user') {
            $rid = self::num($v['ref']);
            $this->need(! is_nan((float) $rid) && Db::get('SELECT 1 FROM users WHERE id=?', $rid), 'Choose a person');
        } else {
            $this->need(isset($this->roles()[$v['ref']]), 'Choose a role');
        }
        $this->need(in_array($b['freq'] ?? null, ['daily', 'weekdays', 'monthly'], true), 'Choose how often');
        $v['freq'] = $b['freq'];
        $wd = isset($b['weekdays']) && is_array($b['weekdays']) && array_is_list($b['weekdays']) ? $b['weekdays'] : [];
        $v['weekdays'] = json_encode(array_values(array_filter(array_map(fn ($d) => self::num($d), $wd), fn ($d) => $d >= 0 && $d <= 6)));
        if ($v['freq'] === 'weekdays') {
            $this->need(count(json_decode($v['weekdays'], true)) > 0, 'Pick at least one weekday');
        }
        $md = self::num($b['month_day'] ?? null);
        $v['month_day'] = $v['freq'] === 'monthly' ? max(1, min(31, self::jt($md) ? $md : 1)) : null;
        $v['due_time'] = self::jt($b['due_time'] ?? null) ? self::min2hm(self::hm2min($b['due_time'])) : null;
        $cl = isset($b['checklist']) && is_array($b['checklist']) && array_is_list($b['checklist']) ? $b['checklist'] : [];
        $v['checklist'] = json_encode(array_slice(array_values(array_filter(array_map(fn ($c) => trim(is_string($c) ? $c : self::sOr(is_array($c) ? ($c['t'] ?? null) : null)), $cl), fn ($x) => $x !== '')), 0, 50), JSON_UNESCAPED_UNICODE);
        $v['active'] = ($b['active'] ?? null) === false ? 0 : 1;
        return $v;
    }

    public function templatesList(?array $u): array
    {
        return array_map(fn ($t) => array_merge($t, ['weekdays' => $this->J($t['weekdays'], []), 'checklist' => $this->J($t['checklist'], []),
            'forName' => $t['scope'] === 'user' ? Db::val('SELECT name FROM users WHERE id=?', self::num($t['ref'])) : $this->roleLabel($t['ref']).' (everyone)',
            'lastMade' => Db::val('SELECT MAX(gen_date) d FROM ops_tasks WHERE template_id=?', $t['id'])]),
            Db::all('SELECT t.*, us.name created_name FROM ops_templates t LEFT JOIN users us ON us.id=t.created_by ORDER BY t.active DESC, t.title'));
    }

    public function templateCreate(?array $u, array $b): array
    {
        $v = $this->tplIn($b);
        $r = Db::run('INSERT INTO ops_templates(title,description,priority,scope,ref,freq,weekdays,month_day,due_time,checklist,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
            $v['title'], $v['description'], $v['priority'], $v['scope'], $v['ref'], $v['freq'], $v['weekdays'], $v['month_day'], $v['due_time'], $v['checklist'], $v['active'], $u['id'], $this->nowPK());
        $id = (int) $r->lastInsertRowid;
        $this->log($u['id'], 'ops.template', 'template:'.$id, $v['title']);
        $made = 0;
        if (($b['startToday'] ?? null) !== false) {
            $t = Db::get('SELECT * FROM ops_templates WHERE id=?', $id);
            if ($this->templateDue($t, $this->todayPK())) {
                $made = $this->generate($this->todayPK());
            }
        }
        return ['ok' => true, 'id' => $id, 'made' => $made];
    }

    public function templateUpdate(?array $u, array $b, array $p): array
    {
        $t = Db::get('SELECT * FROM ops_templates WHERE id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        $v = array_key_exists('active', $b) && count($b) === 1 ? array_merge($t, ['active' => self::jt($b['active']) ? 1 : 0])
            : $this->tplIn(array_merge($t, ['weekdays' => $this->J($t['weekdays'], []), 'checklist' => $this->J($t['checklist'], [])], $b));
        Db::run('UPDATE ops_templates SET title=?,description=?,priority=?,scope=?,ref=?,freq=?,weekdays=?,month_day=?,due_time=?,checklist=?,active=? WHERE id=?',
            $v['title'], $v['description'], $v['priority'], $v['scope'], $v['ref'], $v['freq'], $v['weekdays'], $v['month_day'], $v['due_time'], $v['checklist'], $v['active'], $t['id']);
        $this->log($u['id'], 'ops.template', 'template:'.$t['id'], $v['title']);
        return ['ok' => true];
    }

    public function templateDelete(?array $u, array $b, array $p): array
    {
        $t = Db::get('SELECT * FROM ops_templates WHERE id=?', (int) $p['id']);
        $this->need($t, 'Not found', 404);
        Db::run('DELETE FROM ops_templates WHERE id=?', $t['id']);
        $this->log($u['id'], 'ops.template', 'template:'.$t['id'], ['deleted' => $t['title']]);
        return ['ok' => true];
    }

    public function templatesRun(?array $u, array $b): array
    {
        return ['made' => $this->generate(self::isDay($b['date'] ?? null) ? $b['date'] : $this->todayPK())];
    }

    public function runJobs(?array $u, array $b)
    {
        $now = $b['now'] ?? null;
        $out = $this->tick(self::jt($now) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/', self::str($now)) ? substr(self::str($now), 0, 19) : null);
        return $out ?: new \stdClass;
    }

    public function eodGet(?array $u, array $b, array $p, array $qs): array
    {
        $d = self::isDay($qs['date'] ?? null) ? $qs['date'] : $this->todayPK();
        return ['date' => $d, 'note' => Db::get('SELECT * FROM ops_eod WHERE user_id=? AND day=?', $u['id'], $d), 'remindAt' => $this->S()['eodRemind'],
            'onReport' => (bool) array_filter($this->people($this->todayPK()), fn ($p) => ($p['user_id'] ?? null) === $u['id'])];
    }

    public function eodSave(?array $u, array $b): array
    {
        $d = self::isDay($b['date'] ?? null) ? $b['date'] : $this->todayPK();
        $this->need($d === $this->todayPK() || $d === self::addDays($this->todayPK(), -1), 'You can only write today\'s or yesterday\'s report');
        $did = trim(self::sOr($b['did'] ?? null));
        $this->need(mb_strlen($did) >= 3, 'Write what you did today');
        Db::run('INSERT INTO ops_eod(user_id,day,did,problems,plan,at) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE did=VALUES(did), problems=VALUES(problems), plan=VALUES(plan), at=VALUES(at)',
            $u['id'], $d, mb_substr($did, 0, 3000), mb_substr(trim(self::sOr($b['problems'] ?? null)), 0, 2000), mb_substr(trim(self::sOr($b['plan'] ?? null)), 0, 2000), $this->nowPK());
        $this->log($u['id'], 'ops.eod', 'eod:'.$d, mb_substr($did, 0, 80));
        $this->bust();
        return ['ok' => true];
    }

    public function meRoute(?array $u): array
    {
        return ['tasks' => $this->myTasks($u['id']), 'eod' => Db::get('SELECT * FROM ops_eod WHERE user_id=? AND day=?', $u['id'], $this->todayPK()), 'output' => $this->myOutput($u['id']),
            'settings' => ['eodRemind' => $this->S()['eodRemind']], 'onReport' => (bool) array_filter($this->people($this->todayPK()), fn ($p) => ($p['user_id'] ?? null) === $u['id'])];
    }
}
