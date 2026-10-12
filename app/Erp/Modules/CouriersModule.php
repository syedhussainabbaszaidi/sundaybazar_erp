<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Db;
use App\Erp\Defer;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Erp\Core\Logic;
use App\Services\Shopify\ShopifyWriter;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;

/**
 * Couriers: TCS (API booking, tracking, payments), PostEx (API booking, airway bills, load sheets, cities),
 * own Karachi rider (runs, rider app, cash handover), courier COD, Shopify fulfilment.
 * Port of legacy/server/modules/couriers.js.
 */
class CouriersModule extends Module
{
    public string $name = 'couriers';

    private const PROD = 'https://ociconnect.tcscourier.com';
    private const SANDBOX = 'https://devconnect.tcscourier.com';
    private const COURIERS = ['PostEx', 'TCS', 'Rider'];
    private const FAIL_REASONS = ['no_answer' => 'Customer not answering', 'refused' => 'Customer refused', 'wrong_address' => 'Wrong address', 'later' => 'Customer asked to come later', 'other' => 'Other'];
    private const BOOKABLE = ['confirmed', 'picked', 'packed'];
    private const CK = "CASE WHEN lower(COALESCE(o.courier,'')) LIKE 'tcs%' THEN 'TCS' WHEN lower(COALESCE(o.courier,''))='rider' THEN 'Rider' ELSE 'PostEx' END";
    private const SECRET_KEYS = ['clientId', 'clientSecret', 'username', 'password'];
    private const ALIAS = ['khi' => 'karachi', 'lhr' => 'lahore', 'isb' => 'islamabad', 'isl' => 'islamabad', 'rwp' => 'rawalpindi', 'pindi' => 'rawalpindi', 'fsd' => 'faisalabad', 'lyallpur' => 'faisalabad', 'mux' => 'multan', 'pew' => 'peshawar', 'hyd' => 'hyderabad', 'grw' => 'gujranwala', 'skt' => 'sialkot', 'qta' => 'quetta'];
    private const PX_TYPES = ['Normal', 'Reversed', 'Replacement'];
    private const LIVE = "o.cancelled_at IS NULL AND o.status NOT IN ('cancelled','cs_cancelled','courier_cancelled')";
    // parcels booked from the ERP in the last 3 days that have not been handed to the courier yet
    private const HAND_WAIT = "(hd.order_id IS NULL AND o.bk_tracking=o.tracking AND o.status IN ('dispatched','out_for_delivery') AND o.dispatched_at >= (UTC_TIMESTAMP() - INTERVAL 3 DAY))";
    private const COMPANY = ['PostEx' => 'PostEx', 'TCS' => 'TCS', 'Rider' => 'SundayBazar Rider'];
    private const NOBODY = "\0nobody";

    /** in-process copy of the TCS token / method cache (also kept in the Laravel cache between requests) */
    private ?array $tok = null;

    /* ================================================================ JS-like helpers */

    private static function PKD(string $col): string
    {
        return "DATE($col + INTERVAL 5 HOUR)";
    }

    /** JS unary plus */
    private static function num($v): float
    {
        if ($v === null) {
            return 0.0;
        }
        if (is_bool($v)) {
            return $v ? 1.0 : 0.0;
        }
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if (is_string($v)) {
            $t = trim($v);
            if ($t === '') {
                return 0.0;
            }
            return is_numeric($t) ? (float) $t : NAN;
        }
        if (is_array($v)) {
            if (! $v) {
                return 0.0;
            }
            return count($v) === 1 && array_is_list($v) ? self::num($v[0]) : NAN;
        }
        return NAN;
    }

    /** integral floats -> int (JSON 1 instead of 1.0 when sent to an API) */
    private static function n($v)
    {
        if (is_float($v) && is_finite($v) && floor($v) == $v && abs($v) < 1e15) {
            return (int) $v;
        }
        return $v;
    }

    /** JS truthiness */
    private static function t($v): bool
    {
        if (is_float($v) && is_nan($v)) {
            return false;
        }
        if (is_array($v)) {
            return true;
        }
        return ! ($v === null || $v === false || $v === 0 || $v === 0.0 || $v === '');
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
        if (is_float($v)) {
            return (string) self::n($v);
        }
        if (is_array($v)) {
            return array_is_list($v) ? implode(',', array_map(fn ($x) => is_array($x) || $x === null ? '' : self::str($x), $v)) : '[object Object]';
        }
        return (string) $v;
    }

    private static function r2($v)
    {
        $x = self::num($v);
        if (is_nan($x)) {
            $x = 0.0;
        }
        return self::n(Logic::jsRound($x * 100) / 100);
    }

    private static function isDate($s): bool
    {
        return is_scalar($s) && (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $s);
    }

    private static function addDays(string $d, int $n): string
    {
        return gmdate('Y-m-d', strtotime($d.'T00:00:00Z') + $n * 86400);
    }

    private static function monthEnd(string $m): string
    {
        return self::addDays(substr(self::addDays($m.'-01', 32), 0, 7).'-01', -1);
    }

    private static function bad(string $msg, int $code = 400): HttpError
    {
        return new HttpError($code, $msg);
    }

    /** read a field whatever its capitalisation / spaces ("delivery charges", "consignmentNo", "accessToken") */
    private static function pick($o, string ...$names)
    {
        if (! is_array($o)) {
            return null;
        }
        $map = [];
        foreach ($o as $k => $v) {
            $map[preg_replace('/[^a-z0-9]/', '', strtolower((string) $k))] = $v;
        }
        foreach ($names as $nm) {
            $v = $map[preg_replace('/[^a-z0-9]/', '', strtolower($nm))] ?? null;
            if ($v !== null && $v !== '') {
                return $v;
            }
        }
        return null;
    }

    private static function arr($v): array
    {
        if (is_array($v) && array_is_list($v)) {
            return $v;
        }
        return self::t($v) ? [$v] : [];
    }

    private static function numOrNull($v)
    {
        if ($v === null || $v === '' || is_array($v)) {
            return null;
        }
        $s = preg_replace('/[^0-9.\-]/', '', self::str($v));
        if ($s === '') {
            return 0;
        }
        return is_numeric($s) ? self::n((float) $s) : null;
    }

    /** ms since epoch of an ISO string (JS Date.parse), null when invalid */
    private static function parseIso(string $s): ?float
    {
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i', $s, $m)) {
            if (! checkdate((int) $m[2], (int) $m[3], (int) $m[1]) || (int) ($m[4] ?? 0) > 24 || (int) ($m[5] ?? 0) > 59 || (int) ($m[6] ?? 0) > 59) {
                return null;
            }
            $zone = $m[8] ?? '';
            if ($zone === '' || strtoupper($zone) === 'Z') {
                $off = 0;
            } else {
                $z = str_replace(':', '', $zone);
                $off = ($z[0] === '-' ? -1 : 1) * ((int) substr($z, 1, 2) * 3600 + (int) substr($z, 3, 2) * 60);
            }
            $sec = gmmktime((int) ($m[4] ?? 0), (int) ($m[5] ?? 0), (int) ($m[6] ?? 0), (int) $m[2], (int) $m[3], (int) $m[1]) - $off;
            $ms = isset($m[7]) && $m[7] !== '' ? (int) substr(str_pad($m[7], 3, '0'), 0, 3) : 0;
            return $sec * 1000.0 + $ms;
        }
        $ts = strtotime($s);
        return $ts === false ? null : $ts * 1000.0;
    }

    /** TCS dates: ISO (with or without zone) or dd/MM/yyyy HH:mm(:ss) / dd-MM-yyyy; no zone = Pakistan time. null = NaN */
    public static function parseTcsDate($s): ?float
    {
        if (! self::t($s)) {
            return null;
        }
        $t = trim(self::str($s));
        if (preg_match('/^\d{4}-\d{2}-\d{2}/', $t)) {
            if (preg_match('/[zZ]|[+-]\d{2}:?\d{2}$/', $t)) {
                return self::parseIso($t);
            }
            return self::parseIso(substr(preg_replace('/ /', 'T', $t, 1), 0, 19).(strlen($t) <= 10 ? 'T00:00:00' : '').'+05:00');
        }
        if (preg_match('/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i', $t, $m)) {
            $hh = (int) ($m[4] ?? 0);
            $ap = $m[7] ?? '';
            if ($ap !== '' && preg_match('/pm/i', $ap) && $hh < 12) {
                $hh += 12;
            }
            if ($ap !== '' && preg_match('/am/i', $ap) && $hh === 12) {
                $hh = 0;
            }
            $iso = $m[3].'-'.str_pad($m[2], 2, '0', STR_PAD_LEFT).'-'.str_pad($m[1], 2, '0', STR_PAD_LEFT).'T'.str_pad((string) $hh, 2, '0', STR_PAD_LEFT).':'.(($m[5] ?? '') !== '' ? $m[5] : '00').':'.(($m[6] ?? '') !== '' ? $m[6] : '00').'+05:00';
            return self::parseIso($iso);
        }
        return self::parseIso($t);
    }

    private static function pkYmd(float $ms): string
    {
        return gmdate('Y-m-d', (int) floor($ms / 1000) + 5 * 3600);
    }

    private static function toYmd($s): ?string
    {
        $ms = self::parseTcsDate($s);
        return $ms === null ? null : self::pkYmd($ms);
    }

    private static function msIso(float $ms): string
    {
        $sec = (int) floor($ms / 1000);
        return gmdate('Y-m-d\TH:i:s', $sec).sprintf('.%03dZ', (int) ($ms - $sec * 1000));
    }

    private static function nowMs(): float
    {
        return floor(microtime(true) * 1000);
    }

    private static function normCity($s): string
    {
        return preg_replace('/[^a-z]/', '', mb_strtolower(is_scalar($s) ? (string) $s : ''));
    }

    private static function lev(string $a, string $b): int
    {
        $m = strlen($a);
        $n = strlen($b);
        if (! $m || ! $n) {
            return $m + $n;
        }
        $p = range(0, $n);
        for ($i = 1; $i <= $m; $i++) {
            $c = [$i];
            for ($j = 1; $j <= $n; $j++) {
                $c[$j] = min($p[$j] + 1, $c[$j - 1] + 1, $p[$j - 1] + ($a[$i - 1] === $b[$j - 1] ? 0 : 1));
            }
            $p = $c;
        }
        return $p[$n];
    }

    private static function orderName(array $o): string
    {
        return preg_replace('/^#/', '', (string) (self::t($o['name'] ?? null) ? $o['name'] : $o['id']));
    }

    private static function riderTracking(array $o): string
    {
        return 'RIDER-'.self::orderName($o);
    }

    private static function cityKey($c): string
    {
        $n = self::normCity($c);
        return self::ALIAS[$n] ?? $n;
    }

    private static function titleCase($s): string
    {
        return preg_replace_callback('/\b[a-z]/', fn ($m) => strtoupper($m[0]), strtolower((string) $s));
    }

    private static function batches(array $list, int $n = 10): array
    {
        return array_chunk($list, $n);
    }

    private static function mobile11($p): string
    {
        $n = Logic::normPhone($p);
        return strlen($n) === 11 ? $n : substr($n, -11);
    }

    private static function digitsOrRaw($v)
    {
        $s = self::str($v);
        return preg_match('/^\d+$/', $s) ? self::n((float) $s) : $v;
    }

    private static function statusLabel(?string $s)
    {
        return Logic::STATUS[$s ?? ''] ?? null;
    }

    private function employeeParty($userId): string
    {
        try {
            $e = Db::get('SELECT id FROM hr_employees WHERE user_id=? ORDER BY id LIMIT 1', $userId);
            if ($e) {
                return 'employee:'.$e['id'];
            }
        } catch (\Throwable) {
        }
        return 'employee:u'.$userId;
    }

    /* ================================================================ settings */

    private function tcsCfg(): array
    {
        $s = $this->setting('couriers_tcs', []);
        return array_merge(['serviceCode' => 'O', 'weight' => 1], is_array($s) ? $s : []);
    }

    private function riderCfg(): array
    {
        $s = $this->setting('couriers_rider', []);
        return array_merge(['fee' => 0, 'cashAccount' => 'Cash', 'karachi' => ''], is_array($s) ? $s : []);
    }

    private function tcsFee()
    {
        $v = self::num($this->setting('couriers_tcs_fee', 250));
        return is_nan($v) || ! $v ? 0 : self::n($v);
    }

    private function tcsConfigured(): bool
    {
        $c = $this->tcsCfg();
        return (self::t($c['clientId'] ?? null) && self::t($c['clientSecret'] ?? null)) || (self::t($c['username'] ?? null) && self::t($c['password'] ?? null));
    }

    private function baseUrl(): string
    {
        $c = $this->tcsCfg();
        $b = getenv('TCS_BASE_URL') ?: (env('TCS_BASE_URL') ?: ($this->setting('tcs_base_url', '') ?: (($c['baseUrl'] ?? '') ?: (self::t($c['sandbox'] ?? null) ? self::SANDBOX : self::PROD))));
        return preg_replace('/\/+$/', '', self::str($b));
    }

    private static function mask(string $k, $v): string
    {
        if (! self::t($v)) {
            return '';
        }
        return ($k === 'clientSecret' || $k === 'password') ? '••••••••' : '••••'.mb_substr(self::str($v), -2);
    }

    private function pxCfg(): array
    {
        $s = $this->setting('couriers_postex', []);
        return array_merge(['pickupCode' => '', 'pickupAddress' => '', 'weight' => 0.5, 'notes' => '', 'orderType' => 'Normal'], is_array($s) ? $s : []);
    }

    private function dispCfg(): array
    {
        $s = $this->setting('couriers_dispatch', []);
        return array_merge(['defaultCourier' => 'PostEx', 'karachiCourier' => 'Rider', 'minParcels' => 20, 'days' => 90, 'shopifyFulfil' => false, 'packFirst' => true], is_array($s) ? $s : []);
    }

    /** 'book only after packing' (Dispatch rules, default on): pick → pack → book. Returns an error text or null. */
    private function packGate(array $o): ?string
    {
        return self::t($this->dispCfg()['packFirst'] ?? null) && $o['status'] !== 'packed' ? self::str($o['name']).' is not packed yet — pick and pack it first (Dispatch desk → Pack)' : null;
    }

    /* ================================================================ services (ctx.services.couriers) */

    public function summary(): array
    {
        return [
            'inTransit' => (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('dispatched','in_transit','out_for_delivery','attempted')"),
            'codPending' => self::r2(Db::val("SELECT COALESCE(SUM(COALESCE(cod,total)),0) v FROM orders WHERE status='delivered' AND settled=0")),
            'riderCashOut' => $this->riderCashOut(),
            'tcsConnected' => $this->tcsConfigured() && ! $this->tcsState()['failing'],
        ];
    }

    public function normCourier($name): ?string
    {
        return Logic::normCourier($name);
    }

    public function isKarachi($city): bool
    {
        $n = self::normCity($city);
        if ($n === '') {
            return false;
        }
        $extra = array_values(array_filter(array_map([self::class, 'normCity'], explode(',', self::str($this->riderCfg()['karachi'] ?: '')))));
        if (str_contains($n, 'karachi') || $n === 'khi') {
            return true;
        }
        foreach ($extra as $x) {
            if ($n === $x || str_contains($n, $x)) {
                return true;
            }
        }
        return false;
    }

    public function matchCity($city): array
    {
        $n = self::normCity($city);
        $n = self::ALIAS[$n] ?? $n;
        if ($n === '') {
            return ['code' => null, 'name' => null, 'sure' => false, 'options' => []];
        }
        $al = Db::get('SELECT a.code, c.name FROM cr_city_alias a LEFT JOIN cr_tcs_cities c ON c.code=a.code WHERE a.city=?', $n);
        if ($al) {
            return ['code' => $al['code'], 'name' => self::t($al['name']) ? $al['name'] : $city, 'sure' => true, 'options' => []];
        }
        $all = Db::all('SELECT code, name, norm FROM cr_tcs_cities');
        foreach ($all as $c) {
            if ($c['norm'] === $n) {
                return ['code' => $c['code'], 'name' => $c['name'], 'sure' => true, 'options' => []];
            }
        }
        $cand = self::fuzzy($all, $n);
        return ['code' => $cand[0]['code'] ?? null, 'name' => $cand[0]['name'] ?? null, 'sure' => false, 'options' => array_map(fn ($c) => ['code' => $c['code'], 'name' => $c['name']], $cand)];
    }

    /** candidates for a city name: prefix/contains first, then edit distance (max 6) */
    private static function fuzzy(array $all, string $n): array
    {
        $cand = [];
        foreach ($all as $c) {
            $norm = (string) $c['norm'];
            $c['d'] = self::lev($n, $norm);
            $c['part'] = ($norm !== '' && str_starts_with($norm, $n)) || str_starts_with($n, $norm) || (strlen($n) >= 4 && str_contains($norm, $n));
            if ($c['part'] || (strlen($n) >= 4 && $c['d'] <= 2)) {
                $cand[] = $c;
            }
        }
        usort($cand, fn ($a, $b) => ((int) $b['part'] - (int) $a['part']) ?: ($a['d'] - $b['d']));
        return array_slice($cand, 0, 6);
    }

    /* ================================================================ TCS API */

    private function tokState(): array
    {
        if ($this->tok === null) {
            $def = ['sig' => '', 'b' => null, 'bExp' => 0, 'a' => null, 'aExp' => 0, 'methodFor' => []];
            try {
                $this->tok = array_merge($def, (array) Cache::get('couriers.tcs.tok', []));
            } catch (\Throwable) {
                $this->tok = $def;
            }
        }
        return $this->tok;
    }

    private function saveTok(array $t): void
    {
        $this->tok = $t;
        try {
            Cache::put('couriers.tcs.tok', $t, 86400);
        } catch (\Throwable) {
        }
    }

    /** TCS documents several calls as GET with a JSON body; POST is tried when TCS refuses. */
    private function rawReq(string $method, string $url, $body, array $headers = []): array
    {
        $h = ['Accept' => 'application/json'];
        $data = null;
        if ($body !== self::NOBODY) {
            $data = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $h['Content-Type'] = 'application/json';
        }
        $h = array_merge($h, $headers);
        try {
            $req = Http::withHeaders($h)->timeout(30);
            if ($data !== null) {
                $req = $req->withBody($data, 'application/json');
            }
            $r = $req->send($method, $url);
        } catch (ConnectionException $e) {
            $msg = $e->getMessage();
            if (preg_match('/timed out|cURL error 28/i', $msg)) {
                $code = 'TCS did not answer within 30 seconds';
            } elseif (preg_match('/cURL error (\d+)/', $msg, $m)) {
                $code = ['6' => 'ENOTFOUND', '7' => 'ECONNREFUSED', '35' => 'EPROTO', '52' => 'ECONNRESET', '56' => 'ECONNRESET', '60' => 'CERT_HAS_EXPIRED'][$m[1]] ?? $msg;
            } else {
                $code = $msg;
            }
            throw new RuntimeException('Cannot reach TCS ('.$code.')');
        }
        $text = $r->body();
        $json = null;
        if ($text !== '') {
            $d = json_decode($text, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $json = $d;
            }
        }
        return ['status' => $r->status(), 'text' => $text, 'json' => $json];
    }

    private static function tcsError($j, $status = null): string
    {
        if (! self::t($j)) {
            return $status ? 'TCS answered '.$status : 'TCS sent an empty answer';
        }
        $e = [];
        foreach (self::arr(self::pick($j, 'error', 'errors')) as $x) {
            $v = is_array($x) ? (self::pick($x, 'errorname', 'message', 'error') ?? json_encode($x, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) : $x;
            if (self::t($v)) {
                $e[] = self::str($v);
            }
        }
        $msg = self::pick($j, 'message', 'shipmentsummary', 'statusMessage');
        $out = implode(' · ', array_filter([implode('; ', $e), is_string($msg) ? $msg : ''], fn ($x) => $x !== ''));
        return $out !== '' ? $out : 'TCS answered '.($status ?: '?');
    }

    private function getish(string $path, $body, array $headers = []): array
    {
        $st = $this->tokState();
        $m = $st['methodFor'][$path] ?? 'GET';
        $r = $this->rawReq($m, $this->baseUrl().$path, $body, $headers);
        $s = $r['status'];
        if ($m === 'GET' && (in_array($s, [404, 405, 411, 415], true) || ($s >= 400 && $s !== 401 && ! self::t($r['json'])))) {
            $p = $this->rawReq('POST', $this->baseUrl().$path, $body, $headers);
            if ($p['status'] < 400 || self::t($p['json'])) {
                $st = $this->tokState();
                $st['methodFor'][$path] = 'POST';
                $this->saveTok($st);
                $r = $p;
            }
        }
        return $r;
    }

    private function resetTokens(): void
    {
        $c = $this->tcsCfg();
        $sig = implode('|', [self::str($c['clientId'] ?? ''), self::str($c['clientSecret'] ?? ''), self::str($c['username'] ?? ''), self::str($c['password'] ?? ''), $this->baseUrl()]);
        $st = $this->tokState();
        if ($sig !== $st['sig']) {
            $this->saveTok(array_merge($st, ['sig' => $sig, 'b' => null, 'bExp' => 0, 'a' => null, 'aExp' => 0]));
        }
    }

    private function bearer(): ?string
    {
        $this->resetTokens();
        $c = $this->tcsCfg();
        if (! (self::t($c['clientId'] ?? null) && self::t($c['clientSecret'] ?? null))) {
            return null;
        }
        $st = $this->tokState();
        if ($st['b'] && self::nowMs() < $st['bExp'] - 60000) {
            return $st['b'];
        }
        $r = $this->getish('/auth/api/auth', ['clientid' => self::str($c['clientId']), 'clientsecret' => self::str($c['clientSecret'])]);
        $res = [];
        if (self::t($r['json'])) {
            $pr = self::pick($r['json'], 'result');
            $res = self::t($pr) ? $pr : $r['json'];
        }
        $t = self::pick($res, 'accessToken', 'access_token', 'token');
        if (! self::t($t)) {
            throw new RuntimeException('TCS login failed (client ID / secret): '.self::tcsError($r['json'], $r['status']));
        }
        $exp = self::parseTcsDate(self::pick($res, 'expiry', 'expires')) ?: (self::nowMs() + 3600000);
        $st = $this->tokState();
        $st['b'] = self::str($t);
        $st['bExp'] = $exp;
        $this->saveTok($st);
        return $st['b'];
    }

    private function accessToken(): string
    {
        $this->resetTokens();
        $c = $this->tcsCfg();
        if (! (self::t($c['username'] ?? null) && self::t($c['password'] ?? null))) {
            throw new RuntimeException('Add the TCS username and password in Couriers → Settings');
        }
        $st = $this->tokState();
        if ($st['a'] && self::nowMs() < $st['aExp'] - 60000) {
            return $st['a'];
        }
        $r = $this->getish('/ecom/api/authentication/token', ['username' => self::str($c['username']), 'password' => self::str($c['password'])]);
        $j = self::t($r['json']) ? $r['json'] : [];
        $pr = self::pick($j, 'result');
        $res = self::t($pr) && is_array($pr) ? $pr : $j;
        $t = self::pick($res, 'accesstoken', 'accessToken', 'token');
        if (! self::t($t)) {
            throw new RuntimeException('TCS login failed (username / password): '.self::tcsError($r['json'], $r['status']));
        }
        $exp = self::parseTcsDate(self::pick($res, 'expiry', 'expires'));
        $st = $this->tokState();
        $st['a'] = self::str($t);
        $st['aExp'] = $exp ?? (self::nowMs() + 3600000);
        $this->saveTok($st);
        return $st['a'];
    }

    /** one TCS call; body may be a Closure (so a retry after 401 gets a fresh access token) */
    private function tcsCall(string $method, string $path, $body, bool $retried = false): array
    {
        if (! $this->tcsConfigured()) {
            throw new RuntimeException('TCS is not connected. Add the TCS login in Couriers → Settings.');
        }
        $b = $body instanceof \Closure ? $body() : $body;
        $bt = $this->bearer();
        $headers = $bt ? ['Authorization' => 'Bearer '.$bt] : [];
        $r = $method === 'GET' ? $this->getish($path, $b, $headers) : $this->rawReq($method, $this->baseUrl().$path, $b, $headers);
        $j = $r['json'];
        $unauth = $r['status'] === 401 || (self::t($j) && (self::str(self::pick($j, 'code')) === '401' || preg_match('/unauthori[sz]ed/i', self::str(self::pick($j, 'status') ?? ''))));
        if ($unauth && ! $retried) {
            $st = $this->tokState();
            $st['b'] = null;
            $st['a'] = null;
            $this->saveTok($st);
            return $this->tcsCall($method, $path, $body, true);
        }
        if ($unauth) {
            throw new RuntimeException('TCS refused the login (401). Check the TCS settings.');
        }
        if ($r['status'] >= 500 || ($r['status'] >= 400 && ! self::t($j))) {
            throw new RuntimeException(self::tcsError($j, $r['status']));
        }
        return is_array($j) ? $j : [];
    }

    private function shipDate(): string
    {
        $s = $this->pkNow();
        return substr($s, 8, 2).'/'.substr($s, 5, 2).'/'.substr($s, 0, 4).' '.substr($s, 11, 8);
    }

    private function tcsBook(array $o, string $code, array $opts = []): string
    {
        $c = $this->tcsCfg();
        foreach ([['account', 'TCS account number'], ['costCenter', 'cost centre code'], ['shipperName', 'shipper name'], ['shipperAddress', 'shipper address'], ['shipperCity', 'shipper city'], ['shipperMobile', 'shipper mobile']] as [$k, $l]) {
            if (! self::t($c[$k] ?? null)) {
                throw new RuntimeException("Add the {$l} in Couriers → Settings");
            }
        }
        $city = Db::get('SELECT code, name FROM cr_tcs_cities WHERE code=?', $code) ?: ['code' => $code, 'name' => $o['city']];
        $sc = $this->matchCity($c['shipperCity']);
        $items = Db::all('SELECT title, qty, price, sku FROM order_items WHERE order_id=?', $o['id']);
        $w = self::num($opts['weight'] ?? null);
        $cw = self::num($c['weight'] ?? null);
        $weight = self::n(max(0.5, self::t($w) ? $w : (self::t($cw) ? $cw : 1)));
        $pc = self::num($opts['pieces'] ?? null);
        $pieces = max(1, Logic::jsRound(self::t($pc) ? $pc : 1));
        $cod = max(0, Logic::jsRound(isset($opts['cod']) ? self::num($opts['cod']) : (self::num($o['total']) ?: 0)));
        $name = preg_split('/\s+/', trim(self::str(self::t($o['cust_name']) ? $o['cust_name'] : 'Customer')));
        $nItems = max(1, array_reduce($items, fn ($s, $i) => $s + (self::t($i['qty']) ? $i['qty'] : 1), 0));
        $skuList = $items ?: [['title' => 'Shoes', 'qty' => 1, 'price' => $cod, 'sku' => null]];
        $body = function () use ($c, $sc, $o, $city, $name, $cod, $weight, $pieces, $opts, $skuList, $nItems) {
            $addr = mb_substr(self::str(self::t($o['address']) ? $o['address'] : (self::t($o['city']) ? $o['city'] : '')), 0, 250);
            return [
                'accesstoken' => $this->accessToken(), 'consignmentno' => '',
                'shipperinfo' => ['tcsaccount' => self::str($c['account']), 'shippername' => $c['shipperName'], 'address1' => $c['shipperAddress'], 'address2' => '', 'address3' => '', 'zip' => '', 'countrycode' => 'PK', 'countryname' => 'Pakistan',
                    'cityname' => self::t($sc['name']) ? $sc['name'] : $c['shipperCity'], 'citycode' => self::t($c['shipperCityCode'] ?? null) ? $c['shipperCityCode'] : (self::t($sc['code']) ? $sc['code'] : ''), 'mobile' => self::mobile11($c['shipperMobile'])],
                'consigneeinfo' => ['consigneecode' => '', 'firstname' => $name[0], 'middlename' => '', 'lastname' => implode(' ', array_slice($name, 1)) ?: '.', 'address1' => $addr !== '' ? $addr : $o['city'], 'address2' => '', 'address3' => '', 'zip' => '',
                    'countrycode' => 'PK', 'countryname' => 'Pakistan', 'citycode' => $city['code'], 'cityname' => $city['name'], 'email' => '', 'mobile' => self::mobile11($o['phone'])],
                'vendorinfo' => ['name' => '', 'address1' => '', 'address2' => '', 'address3' => '', 'citycode' => '', 'cityname' => '', 'mobile' => ''],
                'shipmentinfo' => ['costcentercode' => self::str($c['costCenter']), 'referenceno' => self::orderName($o), 'contentdesc' => 'Shoes', 'servicecode' => self::t($c['serviceCode'] ?? null) ? $c['serviceCode'] : 'O', 'parametertype' => '', 'shipmentdate' => $this->shipDate(), 'shippingtype' => '', 'currency' => 'PKR', 'codamount' => $cod,
                    'declaredvalue' => $cod, 'insuredvalue' => 0, 'weightinkg' => $weight, 'pieces' => $pieces, 'fragile' => false, 'remarks' => mb_substr(self::str(self::t($opts['remarks'] ?? null) ? $opts['remarks'] : 'Handle with care. Call before delivery.'), 0, 200),
                    'skus' => array_map(function ($i) use ($weight, $nItems) {
                        $pr = max(1, Logic::jsRound(self::t($i['price'] ?? null) ? $i['price'] : 1));
                        return ['description' => mb_substr(self::str(self::t($i['title'] ?? null) ? $i['title'] : (self::t($i['sku'] ?? null) ? $i['sku'] : 'Shoes')), 0, 100), 'quantity' => self::t($i['qty'] ?? null) ? $i['qty'] : 1,
                            'weight' => self::n(max(0.5, self::r2($weight / $nItems))), 'uom' => 'KG', 'unitprice' => $pr, 'declaredvalue' => $pr, 'insuredvalue' => 0];
                    }, $skuList)],
            ];
        };
        $j = $this->tcsCall('POST', '/ecom/api/booking/create', $body);
        $cn = self::pick($j, 'consignmentNo', 'consignmentnumber', 'cn', 'cnno');
        if (! self::t($cn)) {
            throw new RuntimeException('TCS booking failed: '.self::tcsError($j));
        }
        return self::str($cn);
    }

    private function tcsCancel(string $cn): bool
    {
        $j = $this->tcsCall('POST', '/ecom/api/booking/cancel', fn () => ['consignmentNumber' => self::digitsOrRaw($cn), 'accesstoken' => $this->accessToken()]);
        $m = self::str(self::pick($j, 'message') ?? '');
        if (! preg_match('/success/i', $m)) {
            throw new RuntimeException('TCS did not cancel: '.self::tcsError($j));
        }
        return true;
    }

    /** latest checkpoint wins (by time; ties: delivery info over checkpoints) */
    public static function parseTrack($j, $cn): array
    {
        $ev = [];
        $mine = function ($x) use ($cn) {
            $c = self::pick($x, 'consignmentno', 'consignmentNumber', 'cn');
            return ! self::t($c) || self::str($c) === self::str($cn);
        };
        foreach (self::arr(self::pick($j, 'deliveryinfo')) as $d) {
            if ($mine($d)) {
                $ev[] = ['at' => self::pick($d, 'datetime', 'dateTime', 'date'), 'status' => self::str(self::pick($d, 'status') ?? ''), 'code' => self::pick($d, 'code') ?? '', 'place' => self::pick($d, 'station') ?? '', 'by' => self::pick($d, 'recievedby', 'receivedby') ?? '', 'k' => 1];
            }
        }
        foreach (self::arr(self::pick($j, 'checkpoints')) as $c) {
            if ($mine($c)) {
                $ev[] = ['at' => self::pick($c, 'datetime', 'dateTime', 'date'), 'status' => self::str(self::pick($c, 'status') ?? ''), 'code' => '', 'place' => self::pick($c, 'recievedby', 'receivedby', 'station') ?? '', 'k' => 0];
            }
        }
        $t = fn ($e) => self::parseTcsDate($e['at']) ?? 0;
        $ev = array_values(array_filter($ev, fn ($e) => $e['status'] !== ''));
        usort($ev, fn ($a, $b) => ($t($a) <=> $t($b)) ?: ($a['k'] - $b['k']));
        return array_map(fn ($e) => $e + ['ms' => $t($e)], $ev);
    }

    private function tcsTrack(array $o): bool
    {
        $j = $this->tcsCall('GET', '/tracking/api/Tracking/GetDynamicTrackDetail', ['consignee' => [self::str($o['tracking'])]]);
        $ev = self::parseTrack($j, $o['tracking']);
        if (! $ev) {
            if (self::pick($j, 'message') === 'FAIL') {
                throw new RuntimeException($o['tracking'].': '.self::tcsError($j));
            }
            return false;
        }
        $last = $ev[count($ev) - 1];
        $text = $last['status'];
        if (strtoupper(self::str($last['code'])) === 'OK' && ! preg_match('/deliver/i', $text)) {
            $text = 'Delivered ('.$text.')';
        }
        $hist = array_map(function ($e) {
            $x = ['at' => $e['at'], 'status' => $e['status']];
            if (self::t($e['code'])) {
                $x['code'] = $e['code'];
            }
            if (self::t($e['place'])) {
                $x['place'] = $e['place'];
            }
            return $x;
        }, array_slice($ev, -20));
        Db::run('UPDATE orders SET courier_status=?, courier_updated=?, courier_history=? WHERE id=?', $text, $last['ms'] ? self::msIso($last['ms']) : $this->isoNow(), json_encode($hist, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $o['id']);
        Logic::refreshOrder($o['id']);
        return true;
    }

    private function applyPayment(array $row): bool
    {
        $cn = trim(self::str(self::pick($row, 'cnbycourier', 'consignmentno', 'consignmentnumber', 'cn', 'cnno') ?? ''));
        if ($cn === '') {
            return false;
        }
        $o = Db::get('SELECT * FROM orders o WHERE tracking=? AND '.self::CK."='TCS'", $cn);
        if (! $o) {
            return false;
        }
        $fee = self::numOrNull(self::pick($row, 'deliverycharges', 'charges'));
        $paid = self::numOrNull(self::pick($row, 'amountpaid', 'paidamount'));
        $pdate = self::toYmd(self::pick($row, 'paymentdate'));
        $pst = self::str(self::pick($row, 'paymentstatus') ?? '');
        $cst = self::str(self::pick($row, 'cnstatus') ?? '');
        $isPaid = (preg_match('/paid|settled|transfer|processed|cleared/i', $pst) && ! preg_match('/un ?paid|not|pending|due/i', $pst)) || ($pst === '' && $paid !== null && $paid > 0 && $pdate !== null);
        if ($cst !== '' && ! self::t($o['courier_status'])) {
            Db::run('UPDATE orders SET courier_status=? WHERE id=?', $cst, $o['id']);
        }
        Db::run('UPDATE orders SET courier_fee=COALESCE(?,courier_fee) WHERE id=?', $fee, $o['id']);
        Logic::refreshOrder($o['id']);
        $st = Db::val('SELECT status FROM orders WHERE id=?', $o['id']);
        if ($isPaid && $st === 'delivered') {
            Db::run('UPDATE orders SET courier_paid=COALESCE(?,courier_paid), settled=1, settled_at=COALESCE(?,settled_at,?), courier_settled_at=COALESCE(?,courier_settled_at,?), settle_ref=COALESCE(settle_ref,?) WHERE id=?',
                $paid, $pdate, $this->pkToday(), $pdate, $this->pkToday(), 'TCS'.($pdate ? ' '.$pdate : ''), $o['id']);
        }
        return true;
    }

    private function tcsPaymentStatus(array $o): int
    {
        $c = $this->tcsCfg();
        $j = $this->tcsCall('GET', '/ecom/api/Payment/status', fn () => ['accesstoken' => $this->accessToken(), 'customerno' => self::digitsOrRaw($c['customerNo'] ?? null), 'consignmentno' => self::digitsOrRaw($o['tracking'])]);
        $n = 0;
        foreach (self::arr(self::pick($j, 'detail')) as $d) {
            if ($this->applyPayment(array_merge(['cn' => $o['tracking']], is_array($d) ? $d : []))) {
                $n++;
            }
        }
        return $n;
    }

    private function syncCities(): int
    {
        $j = $this->tcsCall('GET', '/ecom/api/setup/citylistbycountry', ['countrycode' => ['PK']]);
        $list = self::arr(self::pick($j, 'data', 'result', 'cities', 'citylist'));
        if (! $list) {
            throw new RuntimeException('TCS city list is empty: '.self::tcsError($j));
        }
        Db::tx(function () use ($list) {
            Db::run('DELETE FROM cr_tcs_cities');
            foreach ($list as $c) {
                $code = self::str(self::pick($c, 'citycode', 'code') ?? '');
                $name = self::str(self::pick($c, 'cityname', 'name') ?? '');
                if ($code !== '' && $name !== '') {
                    Db::run('REPLACE INTO cr_tcs_cities(code,name,norm) VALUES(?,?,?)', $code, $name, self::normCity($name));
                }
            }
        });
        $this->setSetting('couriers_tcs_cities_at', $this->pkNow());
        return (int) Db::val('SELECT COUNT(*) n FROM cr_tcs_cities');
    }

    /* ================================================================ sync jobs */

    private function syncTrack(int $limit = 300): array
    {
        $open = Db::all('SELECT * FROM orders o WHERE '.self::CK."='TCS' AND tracking IS NOT NULL AND cancelled_at IS NULL AND status IN (".Db::marks(Logic::OPEN_SHIP).') ORDER BY dispatched_at DESC LIMIT ?', ...[...Logic::OPEN_SHIP, $limit]);
        $n = 0;
        $errors = [];
        foreach ($open as $o) {
            try {
                if ($this->tcsTrack($o)) {
                    $n++;
                }
            } catch (\Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
        $uniq = array_slice(array_values(array_unique($errors)), 0, 3);
        $ok = ! $uniq || $n > 0;
        $this->syncLog('tcs', $ok && ! ($uniq && ! $n), "tracking: {$n} of ".count($open).' parcels updated'.($uniq ? ' · errors: '.implode(' | ', $uniq) : ''));
        $this->setSetting('couriers_tcs_track_at', $this->pkNow());
        return ['checked' => count($open), 'updated' => $n, 'errors' => $uniq];
    }

    private function syncPayments(int $days = 60): array
    {
        $c = $this->tcsCfg();
        if (! self::t($c['customerNo'] ?? null)) {
            throw new RuntimeException('Add the TCS customer number in Couriers → Settings');
        }
        $to = $this->pkToday();
        $from = self::addDays($to, -$days);
        $j = $this->tcsCall('GET', '/ecom/api/Payment/detail', fn () => ['accesstoken' => $this->accessToken(), 'customerno' => self::digitsOrRaw($c['customerNo']), 'fromdate' => $from, 'todate' => $to]);
        $rows = self::arr(self::pick($j, 'detail', 'data'));
        $n = 0;
        Db::tx(function () use ($rows, &$n) {
            foreach ($rows as $r) {
                if (is_array($r) && $this->applyPayment($r)) {
                    $n++;
                }
            }
        });
        // delivered parcels the report did not cover: ask one by one (capped)
        $errors = [];
        $left = Db::all('SELECT * FROM orders o WHERE '.self::CK."='TCS' AND status='delivered' AND settled=0 AND tracking IS NOT NULL ORDER BY delivered_at LIMIT 40");
        foreach ($left as $o) {
            try {
                $n += $this->tcsPaymentStatus($o);
            } catch (\Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
        $uniq = array_slice(array_values(array_unique($errors)), 0, 2);
        $this->syncLog('tcs', true, 'payments: '.count($rows)." rows from TCS, {$n} parcels updated".($uniq ? ' · '.implode(' | ', $uniq) : ''));
        $this->setSetting('couriers_tcs_pay_at', $this->pkNow());
        return ['rows' => count($rows), 'updated' => $n, 'errors' => $uniq];
    }

    /* ================================================================ booking */

    private function setBooked(array $o, string $courier, string $tracking, array $extra = []): void
    {
        $now = $this->isoNow();
        $keepPx = $courier === 'PostEx' ? 1 : 0;
        $status = self::t($extra['status'] ?? null) ? $extra['status'] : null;
        Db::run('UPDATE orders SET courier=?, tracking=?, bk_courier=?, bk_tracking=?, bk_via=?, courier_status=?, courier_updated=?, courier_history=NULL, courier_cod=?, cod=COALESCE(?,cod), city_code=COALESCE(?,city_code),
      rider_id=?, rider_run_id=?, dispatched_at=COALESCE(dispatched_at,?), px_status=CASE WHEN ? THEN px_status ELSE NULL END, px_updated=CASE WHEN ? THEN px_updated ELSE NULL END WHERE id=?',
            $courier, $tracking, $courier, $tracking, self::t($extra['via'] ?? null) ? $extra['via'] : null, $status, $status ? $now : null, $extra['cod'] ?? null, $extra['setCod'] ?? null,
            self::t($extra['city_code'] ?? null) ? $extra['city_code'] : null, self::t($extra['rider_id'] ?? null) ? $extra['rider_id'] : null, self::t($extra['run_id'] ?? null) ? $extra['run_id'] : null, $now, $keepPx, $keepPx, $o['id']);
        Logic::refreshOrder($o['id']);
    }

    private function clearBooking(array $o): void
    {
        Db::run('UPDATE orders SET courier=NULL, tracking=NULL, bk_courier=NULL, bk_tracking=NULL, bk_via=NULL, courier_status=NULL, courier_updated=NULL, courier_history=NULL, courier_cod=NULL, rider_id=NULL, rider_run_id=NULL, dispatched_at=NULL, delivered_at=NULL,
      px_status=NULL, px_updated=NULL, px_history=NULL WHERE id=?', $o['id']);
        Logic::refreshOrder($o['id']);
    }

    private function getOrder($code): ?array
    {
        $c = trim(is_scalar($code) ? self::str($code) : '');
        if ($c === '') {
            return null;
        }
        return Db::get('SELECT * FROM orders WHERE id=? OR name=? OR name=? OR name=? OR tracking=?', $c, $c, mb_strtoupper($c), '#'.preg_replace('/^#/', '', $c), $c);
    }

    /* ================================================================ rider runs */

    private function runRow($id): ?array
    {
        return Db::get('SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.id=?', $id);
    }

    private function openItem(string $orderId): ?array
    {
        return Db::get("SELECT i.*, r.status run_status FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.order_id=? AND r.status<>'closed' ORDER BY i.id DESC LIMIT 1", $orderId);
    }

    private function addToRun(array $run, ?array $o, array $u, bool $force, $codOverride = null): array
    {
        if (! $o) {
            return ['error' => 'Order not found'];
        }
        $nm = self::t($o['name']) ? $o['name'] : $o['id'];
        if ($run['status'] === 'closed') {
            return ['error' => 'This run is closed'];
        }
        if (self::t($o['cancelled_at']) || in_array($o['status'], ['cancelled', 'cs_cancelled', 'courier_cancelled'], true)) {
            return ['error' => "{$nm} is cancelled"];
        }
        $ex = $this->openItem($o['id']);
        if ($ex) {
            return ['error' => (int) $ex['run_id'] === (int) $run['id'] ? "{$nm} is already in this run" : "{$nm} is already in rider run #{$ex['run_id']}"];
        }
        $rider = Logic::courierKey($o['courier']) === 'Rider' && self::t($o['tracking']);
        if (self::t($o['tracking']) && ! $rider) {
            return ['error' => "{$nm} is already booked with ".(self::t($o['courier']) ? $o['courier'] : 'a courier')." ({$o['tracking']})"];
        }
        if ($rider ? $o['status'] !== 'attempted' : ! in_array($o['status'], self::BOOKABLE, true)) {
            return ['error' => "{$nm} is \"".(self::statusLabel($o['status']) ?: $o['status']).'" — only confirmed / packed orders (or rider parcels kept for another try) can go on a run'];
        }
        if (! $rider && ($g = $this->packGate($o))) {
            return ['error' => $g, 'notPacked' => true];
        }
        if (! $this->isKarachi($o['city']) && ! $force) {
            return ['warn' => "{$nm} is for ".(self::t($o['city']) ? $o['city'] : 'an unknown city').', not Karachi. Add anyway?', 'order' => $nm];
        }
        $validOv = $codOverride !== null && ! (is_float($codOverride) && is_nan($codOverride)) && $codOverride >= 0;
        $cod = $validOv ? Logic::jsRound(self::num($codOverride)) : ($rider && $o['courier_cod'] !== null ? $o['courier_cod'] : (self::t($o['total']) ? $o['total'] : 0));
        $seq = ((int) Db::val('SELECT MAX(seq) m FROM cr_run_items WHERE run_id=?', $run['id'])) + 1;
        Db::run('INSERT INTO cr_run_items(run_id,order_id,seq,cod) VALUES(?,?,?,?)', $run['id'], $o['id'], $seq, $cod);
        $this->setBooked($o, 'Rider', self::riderTracking($o), ['status' => $run['status'] === 'out' ? 'Out for delivery' : 'Assigned to rider', 'cod' => $cod, 'setCod' => $validOv ? $cod : null, 'rider_id' => $run['rider_id'], 'run_id' => $run['id']]);
        $this->log($u['id'], 'couriers.run.add', 'order:'.$o['id'], ['run' => (int) $run['id'], 'rider' => (int) $run['rider_id']]);
        return ['ok' => true, 'order' => $nm];
    }

    private function createRun($riderId, $dayStr, array $u, $note = null): ?array
    {
        $rid = self::num($riderId);
        $r = is_nan($rid) ? null : Db::get('SELECT id, name, role, perms, active FROM users WHERE id=?', (int) $rid);
        if (! $r || ! $r['active'] || ! in_array('rider', Access::userPerms($r), true)) {
            throw self::bad('Choose a rider (a staff login with the Rider role)');
        }
        $d = self::isDate($dayStr) ? $dayStr : $this->pkToday();
        $id = Db::run('INSERT INTO cr_runs(day,rider_id,status,note,created_by) VALUES(?,?,?,?,?)', $d, $r['id'], 'open', self::t($note) ? $note : null, $u['id'])->lastInsertRowid;
        $this->log($u['id'], 'couriers.run', 'rider_run:'.$id, ['rider' => (int) $r['id'], 'day' => $d]);
        return $this->runRow($id);
    }

    private static function riderStatusText($res, array $b): ?string
    {
        if ($res === 'delivered') {
            return 'Delivered';
        }
        if ($res === 'failed') {
            return 'Failed: '.(is_string($b['reason'] ?? null) ? (self::FAIL_REASONS[$b['reason']] ?? 'Other') : 'Other');
        }
        if ($res === 'rescheduled') {
            return 'Rescheduled to '.self::str($b['date'] ?? null);
        }
        return null;
    }

    private function setResult(array $item, array $u, array $b): array
    {
        $run = $this->runRow($item['run_id']);
        if ($run['status'] === 'closed' || Db::get('SELECT id FROM cr_handovers WHERE run_id=?', $run['id'])) {
            throw self::bad('Cash for this run is already handed over — ask the office to change it');
        }
        $o = Db::get('SELECT * FROM orders WHERE id=?', $item['order_id']);
        $res = $b['result'] ?? null;
        $now = $this->isoNow();
        if ($res === 'undo') {
            Db::run('UPDATE cr_run_items SET result=NULL, collected=NULL, reason=NULL, note=NULL, resched_to=NULL, at=NULL, by_user=NULL WHERE id=?', $item['id']);
            Db::run('UPDATE orders SET courier_status=?, courier_updated=?, delivered_at=NULL, cod=? WHERE id=?', $run['status'] === 'out' ? 'Out for delivery' : 'Assigned to rider', $now, $item['cod'], $o['id']);
            Logic::refreshOrder($o['id']);
            $this->log($u['id'], 'rider.undo', 'order:'.$o['id'], ['run' => (int) $run['id']]);
            return ['ok' => true];
        }
        if (! in_array($res, ['delivered', 'failed', 'rescheduled'], true)) {
            throw self::bad('Choose Delivered, Failed or Rescheduled');
        }
        $reason = $b['reason'] ?? null;
        $validReason = is_string($reason) && isset(self::FAIL_REASONS[$reason]);
        $collected = null;
        if ($res === 'delivered') {
            $bc = $b['collected'] ?? null;
            $collected = $bc === null || $bc === '' ? $item['cod'] : self::n(self::num($bc));
            if (! ($collected !== null && ! (is_float($collected) && is_nan($collected)) && $collected >= 0)) {
                throw self::bad('Enter the cash collected');
            }
        }
        if ($res === 'failed' && ! $validReason) {
            throw self::bad('Choose why the delivery failed');
        }
        if ($res === 'failed' && $reason === 'other' && trim(self::str($b['note'] ?? '')) === '') {
            throw self::bad('Write what happened');
        }
        if ($res === 'rescheduled' && ! self::isDate($b['date'] ?? null)) {
            throw self::bad('Choose the new delivery date');
        }
        Db::tx(function () use ($res, $collected, $b, $item, $u, $run, $o, $now) {
            $note = mb_substr(self::str($b['note'] ?? ''), 0, 300);
            Db::run('UPDATE cr_run_items SET result=?, collected=?, reason=?, note=?, resched_to=?, at=?, by_user=? WHERE id=?', $res, $collected, $res === 'failed' ? $b['reason'] : null, $note !== '' ? $note : null, $res === 'rescheduled' ? $b['date'] : null, $this->pkNow(), $u['id'], $item['id']);
            if ($run['status'] === 'open') {
                Db::run("UPDATE cr_runs SET status='out', out_at=COALESCE(out_at,?) WHERE id=?", $this->pkNow(), $run['id']);
                Db::run("UPDATE orders SET courier_status='Out for delivery' WHERE rider_run_id=? AND courier_status='Assigned to rider'", $run['id']);
            }
            Db::run("UPDATE orders SET courier_status=?, courier_updated=?, delivered_at=CASE WHEN ?='delivered' THEN delivered_at ELSE NULL END, cod=? WHERE id=?", self::riderStatusText($res, $b), $now, $res, $res === 'delivered' ? $collected : $item['cod'], $o['id']);
            Logic::refreshOrder($o['id']);
        });
        $this->log($u['id'], 'rider.'.$res, 'order:'.$o['id'], ['run' => (int) $run['id'], 'collected' => $collected, 'reason' => self::t($b['reason'] ?? null) ? $b['reason'] : null, 'date' => self::t($b['date'] ?? null) ? $b['date'] : null, 'note' => self::t($b['note'] ?? null) ? $b['note'] : null]);
        return ['ok' => true];
    }

    private function runItems($runId): array
    {
        return Db::all("SELECT i.*, o.name, o.cust_name, o.phone, o.address, o.city, o.total, o.status, o.items, o.tracking,
      (SELECT GROUP_CONCAT(title SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text, u.name by_name FROM cr_run_items i JOIN orders o ON o.id=i.order_id LEFT JOIN users u ON u.id=i.by_user WHERE i.run_id=? ORDER BY i.seq", $runId);
    }

    private function runSummary(array $items): array
    {
        $s = ['parcels' => count($items), 'delivered' => 0, 'failed' => 0, 'rescheduled' => 0, 'pending' => 0, 'cod' => 0, 'collected' => 0, 'deliveredValue' => 0];
        foreach ($items as $i) {
            $s['cod'] += self::t($i['cod'] ?? null) ? $i['cod'] : 0;
            if (! self::t($i['result'] ?? null)) {
                $s['pending']++;
            } else {
                $s[$i['result']] = ($s[$i['result']] ?? 0) + 1;
            }
            if (($i['result'] ?? null) === 'delivered') {
                $s['collected'] += self::t($i['collected'] ?? null) ? $i['collected'] : 0;
                $s['deliveredValue'] += self::t($i['total'] ?? null) ? $i['total'] : 0;
            }
        }
        $s['cod'] = self::r2($s['cod']);
        $s['collected'] = self::r2($s['collected']);
        $s['deliveredValue'] = self::r2($s['deliveredValue']);
        return $s;
    }

    private function handoverRun(array $run, array $u, array $b): array
    {
        if ($run['status'] === 'closed' || Db::get('SELECT id FROM cr_handovers WHERE run_id=?', $run['id'])) {
            throw self::bad('Cash for this run was already received');
        }
        $items = $this->runItems($run['id']);
        $s = $this->runSummary($items);
        if (! $items) {
            throw self::bad('This run has no parcels');
        }
        $bc = $b['counted'] ?? null;
        $counted = self::num($bc);
        if ($bc === '' || $bc === null || ! (! is_nan($counted) && $counted >= 0)) {
            throw self::bad('Enter the cash you counted');
        }
        $counted = self::n($counted);
        $diff = self::r2($counted - $s['collected']);
        $note = trim(self::str($b['note'] ?? ''));
        if ($diff && $note === '') {
            throw self::bad($diff < 0 ? 'Cash is short: write a note (what the rider said)' : 'Cash is more than expected: write a note');
        }
        $treat = ($b['treat'] ?? null) === 'recover' ? 'recover' : 'expense';
        $back = is_array($b['back'] ?? null) ? $b['back'] : [];
        $today = $this->pkToday();
        $cfgR = $this->riderCfg();
        $A = $this->svc('accounts');
        return Db::tx(function () use ($run, $u, $b, $items, $s, $counted, $diff, $treat, $back, $today, $cfgR, $A) {
            $nt = mb_substr(self::str($b['note'] ?? ''), 0, 300);
            $hid = Db::run('INSERT INTO cr_handovers(run_id,rider_id,day,expected,counted,diff,treat,note,user_id) VALUES(?,?,?,?,?,?,?,?,?)', $run['id'], $run['rider_id'], $today, $s['collected'], $counted, $diff, $diff < 0 ? $treat : null, $nt !== '' ? $nt : null, $u['id'])->lastInsertRowid;
            $posted = null;
            if ($A && ($counted || $s['deliveredValue'])) {
                $disc = self::r2($s['deliveredValue'] - $s['collected']);
                $short = $diff < 0 ? -$diff : 0;
                $excess = $diff > 0 ? $diff : 0;
                $lines = [['account' => self::t($cfgR['cashAccount'] ?? null) ? $cfgR['cashAccount'] : 'Cash', 'debit' => $counted, 'memo' => 'Cash counted'], ['account' => 'Rider Cash', 'credit' => $s['deliveredValue'], 'party' => 'courier:Rider', 'memo' => "{$s['delivered']} parcels delivered"]];
                if ($disc > 0) {
                    $lines[] = ['account' => 'Discount Allowed', 'debit' => $disc, 'memo' => 'Customers paid less than the order total'];
                }
                if ($disc < 0) {
                    $lines[] = ['account' => 'Other Income', 'credit' => -$disc, 'memo' => 'Customers paid more than the order total'];
                }
                if ($short) {
                    $lines[] = $treat === 'recover' ? ['account' => 'Employees Advance', 'debit' => $short, 'party' => $this->employeeParty($run['rider_id']), 'memo' => 'Rider cash short — to recover'] : ['account' => 'Miscellenious Exp', 'debit' => $short, 'memo' => 'Rider cash short'];
                }
                if ($excess) {
                    $lines[] = ['account' => 'Other Income', 'credit' => $excess, 'memo' => 'Rider cash excess'];
                }
                $posted = $A->post(['date' => $today, 'memo' => "Rider cash handover — run #{$run['id']} (".(self::t($run['rider']) ? $run['rider'] : 'rider').", {$run['day']})", 'source' => 'rider-handover', 'source_id' => (string) $run['id'], 'lines' => $lines], $u['id']);
                Db::run('UPDATE cr_handovers SET journal_id=? WHERE id=?', $posted, $hid);
            }
            foreach ($items as $i) {
                if ($i['result'] === 'delivered') {
                    Db::run('UPDATE orders SET settled=1, settled_at=?, courier_settled_at=?, settle_ref=? WHERE id=?', $today, $today, 'RIDER-H'.$hid, $i['order_id']);
                    continue;
                }
                $how = self::t($back[$i['id']] ?? null) ? $back[$i['id']] : ($i['result'] === 'rescheduled' ? 'kept' : 'returned');
                if (! self::t($i['result'])) {
                    Db::run("UPDATE cr_run_items SET result='failed', reason='other', note=COALESCE(note,'Not attempted'), at=? WHERE id=?", $this->pkNow(), $i['id']);
                }
                Db::run('UPDATE cr_run_items SET back=?, back_at=?, back_by=? WHERE id=?', $how === 'kept' ? 'kept' : 'returned', $this->pkNow(), $u['id'], $i['id']);
                if ($how === 'kept') {
                    if (! self::t($i['result'])) {
                        Db::run("UPDATE orders SET courier_status='Failed: Not attempted', courier_updated=? WHERE id=?", $this->isoNow(), $i['order_id']);
                    }
                } else {
                    Db::run("UPDATE orders SET courier_status='Returned to office', courier_updated=? WHERE id=?", $this->isoNow(), $i['order_id']);
                }
                Logic::refreshOrder($i['order_id']);
            }
            Db::run("UPDATE cr_runs SET status='closed', closed_at=? WHERE id=?", $this->pkNow(), $run['id']);
            $this->log($u['id'], 'couriers.handover', 'rider_run:'.$run['id'], ['expected' => $s['collected'], 'counted' => $counted, 'diff' => $diff, 'treat' => $diff < 0 ? $treat : null, 'journal' => $posted]);
            return ['ok' => true, 'id' => $hid, 'expected' => $s['collected'], 'counted' => $counted, 'diff' => $diff, 'journal' => $posted];
        });
    }

    private function riderLedger($riderId = null): array
    {
        $has = self::t($riderId);
        $w = $has ? 'WHERE r.rider_id=?' : '';
        $a = $has ? [(int) self::num($riderId)] : [];
        $rows = Db::all("SELECT r.rider_id, u.name rider, COUNT(DISTINCT r.id) runs,
      COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected,
      COALESCE(SUM(CASE WHEN i.result='delivered' AND NOT EXISTS (SELECT 1 FROM cr_handovers h WHERE h.run_id=r.id) THEN i.collected END),0) outstanding,
      SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed
    FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id {$w} GROUP BY r.rider_id ORDER BY u.name", ...$a);
        return array_map(function ($x) {
            $h = Db::get('SELECT COALESCE(SUM(counted),0) handed, COALESCE(SUM(CASE WHEN diff<0 THEN -diff END),0) `short`, COALESCE(SUM(CASE WHEN diff>0 THEN diff END),0) excess FROM cr_handovers WHERE rider_id=?', $x['rider_id']);
            $h = array_map(fn ($v) => self::n($v), $h);
            return array_merge($x, $h, ['collected' => self::r2($x['collected']), 'outstanding' => self::r2($x['outstanding'])]);
        }, $rows);
    }

    private function riderFees(string $month): array
    {
        $rate = self::num($this->riderCfg()['fee'] ?? 0);
        $rate = is_nan($rate) || ! $rate ? 0 : self::n($rate);
        $rows = Db::all("SELECT r.rider_id, u.name rider, COUNT(*) deliveries FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id JOIN users u ON u.id=r.rider_id WHERE i.result='delivered' AND DATE_FORMAT(i.at,'%Y-%m')=? GROUP BY r.rider_id ORDER BY u.name", $month);
        $done = [];
        foreach (Db::all('SELECT f.*, u.name approved_name FROM cr_rider_fees f LEFT JOIN users u ON u.id=f.approved_by WHERE month=?', $month) as $f) {
            $done[$f['rider_id']] = $f;
        }
        $out = array_map(fn ($r) => $r + ['rate' => $rate, 'amount' => self::r2($r['deliveries'] * $rate), 'approved' => $done[$r['rider_id']] ?? null], $rows);
        $have = array_column($out, 'rider_id');
        foreach ($done as $rid => $f) {
            if (! in_array($rid, $have, true)) {
                $nm = Db::val('SELECT name FROM users WHERE id=?', $rid);
                $row = ['rider_id' => $rid];
                if ($nm !== null) {
                    $row['rider'] = $nm;
                }
                $out[] = $row + ['deliveries' => 0, 'rate' => $rate, 'amount' => 0, 'approved' => $f];
            }
        }
        return ['month' => $month, 'rate' => $rate, 'rows' => $out];
    }

    /* ================================================================ dashboard */

    private function dashboardData(string $from, string $to): array
    {
        $num0 = function ($v, $def) {
            $x = self::num($v);
            return is_nan($x) ? NAN : self::n($x);
        };
        $fee = $num0($this->setting('courier_fee', 250), 250);
        $rfee = $num0($this->setting('return_fee', 150), 150);
        $tfee = $this->tcsFee();
        $rate = self::num($this->riderCfg()['fee'] ?? 0);
        $rate = is_nan($rate) || ! $rate ? 0 : $rate;
        $live = self::LIVE;
        $CK = self::CK;
        $per = [];
        foreach (Db::all("SELECT {$CK} k, COUNT(*) dispatched, SUM(o.status='delivered') delivered, SUM(o.status IN ('returning','returned','return_received')) returned,
      SUM(o.status IN ('dispatched','in_transit','out_for_delivery','attempted')) in_transit, SUM(o.status='attempted') attempted,
      AVG(CASE WHEN o.status='delivered' AND o.delivered_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, o.dispatched_at, o.delivered_at)/86400.0 END) avg_days,
      SUM(CASE WHEN k0='PostEx' THEN COALESCE(o.px_fee,?)+COALESCE(o.px_tax,0) + CASE WHEN o.status IN ('returning','returned','return_received') THEN COALESCE(o.px_rev_fee,?)+COALESCE(o.px_rev_tax,0) ELSE 0 END
               WHEN k0='TCS' THEN COALESCE(o.courier_fee,?) ELSE 0 END) charges
    FROM (SELECT o.*, {$CK} k0 FROM orders o) o WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND {$live} AND ".self::PKD('o.dispatched_at').' BETWEEN ? AND ? GROUP BY k',
            is_float($fee) && is_nan($fee) ? null : $fee, is_float($rfee) && is_nan($rfee) ? null : $rfee, $tfee, $from, $to) as $r) {
            $per[$r['k']] = $r;
        }
        $unpaid = [];
        foreach (Db::all("SELECT {$CK} k, COUNT(*) n, COALESCE(SUM(COALESCE(o.cod,o.total)),0) v FROM orders o WHERE o.status='delivered' AND o.settled=0 GROUP BY k") as $r) {
            $unpaid[$r['k']] = $r;
        }
        $riderDel = (int) Db::val("SELECT COUNT(*) n FROM cr_run_items i WHERE i.result='delivered' AND DATE(i.at) BETWEEN ? AND ?", $from, $to);
        $couriers = array_map(function ($k) use ($per, $unpaid, $riderDel, $rate) {
            $p = $per[$k] ?? ['dispatched' => 0, 'delivered' => 0, 'returned' => 0, 'in_transit' => 0, 'attempted' => 0, 'avg_days' => null, 'charges' => 0];
            $dr = ($p['delivered'] ?? 0) + ($p['returned'] ?? 0);
            return ['courier' => $k, 'dispatched' => $p['dispatched'] ?: 0, 'delivered' => $p['delivered'] ?: 0, 'returned' => $p['returned'] ?: 0, 'in_transit' => $p['in_transit'] ?: 0, 'attempted' => $p['attempted'] ?: 0,
                'rate' => $dr ? Logic::jsRound(100 * $p['delivered'] / $dr) : null, 'avg_days' => $p['avg_days'] !== null ? self::n(Logic::jsRound($p['avg_days'] * 10) / 10) : null,
                'cod_unpaid' => self::r2(($unpaid[$k]['v'] ?? 0) ?: 0), 'cod_unpaid_n' => ($unpaid[$k]['n'] ?? 0) ?: 0, 'charges' => self::r2($k === 'Rider' ? $riderDel * $rate : (($p['charges'] ?? 0) ?: 0))];
        }, self::COURIERS);
        $cityRows = Db::all("SELECT lower(trim(o.city)) c, MAX(o.city) city, {$CK} k, COUNT(*) n, SUM(o.status='delivered') del, SUM(o.status IN ('returning','returned','return_received')) ret
    FROM orders o WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND {$live} AND COALESCE(o.city,'')<>'' AND ".self::PKD('o.dispatched_at').' BETWEEN ? AND ? GROUP BY c, k', $from, $to);
        $cities = [];
        foreach ($cityRows as $r) {
            $nc = self::normCity($r['city']);
            $key = (self::ALIAS[$nc] ?? null) ?: ($nc !== '' ? $nc : $r['c']);
            $key = 'k:'.$key; // keep insertion order even for numeric-looking keys
            $cities[$key] ??= ['city' => $r['city'], 'total' => 0];
            if (isset(self::ALIAS[$nc])) {
                $cities[$key]['city'] = ucfirst(self::ALIAS[$nc]);
            }
            $cities[$key]['total'] += $r['n'];
            $x = $cities[$key][$r['k']] ?? ['n' => 0, 'del' => 0, 'ret' => 0];
            $x['n'] += $r['n'];
            $x['del'] += (int) $r['del'];
            $x['ret'] += (int) $r['ret'];
            $x['rate'] = ($x['del'] + $x['ret']) ? Logic::jsRound(100 * $x['del'] / ($x['del'] + $x['ret'])) : null;
            $cities[$key][$r['k']] = $x;
        }
        $cityList = array_values($cities);
        usort($cityList, fn ($a, $b) => $b['total'] <=> $a['total']);
        $cityList = array_map(function ($c) {
            $cand = array_values(array_filter(self::COURIERS, fn ($k) => isset($c[$k]) && $c[$k]['rate'] !== null && ($c[$k]['del'] + $c[$k]['ret']) >= 5));
            usort($cand, fn ($a, $b) => $c[$b]['rate'] <=> $c[$a]['rate']);
            return $c + ['best' => $cand[0] ?? null];
        }, array_slice($cityList, 0, 40));
        $riders = array_map(function ($x) {
            $led = $this->riderLedger($x['rider_id'])[0] ?? [];
            $df = ($x['delivered'] ?? 0) + ($x['failed'] ?? 0);
            return $x + ['per_day' => $x['days'] ? self::n(Logic::jsRound(10 * ($x['delivered'] ?: 0) / $x['days']) / 10) : 0, 'success' => $df ? Logic::jsRound(100 * $x['delivered'] / $df) : null, 'outstanding' => ($led['outstanding'] ?? 0) ?: 0, 'short' => ($led['short'] ?? 0) ?: 0];
        }, Db::all("SELECT r.rider_id, u.name rider, COUNT(DISTINCT r.day) days, SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed, COUNT(i.id) parcels
    FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id WHERE r.day BETWEEN ? AND ? GROUP BY r.rider_id ORDER BY u.name", $from, $to));
        $unknown = array_slice(array_values(array_filter(Db::all("SELECT courier_status `text`, COUNT(*) n FROM orders o WHERE {$CK}='TCS' AND courier_status IS NOT NULL AND tracking IS NOT NULL GROUP BY courier_status ORDER BY n DESC LIMIT 200"), fn ($r) => ! Logic::mapTcs($r['text']))), 0, 15);
        return ['from' => $from, 'to' => $to, 'couriers' => $couriers, 'cities' => $cityList, 'riders' => $riders, 'unknown' => $unknown, 'tcs' => $this->tcsState()];
    }

    private function tcsState(): array
    {
        $last = Db::get("SELECT at, ok, message FROM sync_log WHERE kind='tcs' ORDER BY id DESC LIMIT 1");
        $lastOk = Db::get("SELECT at FROM sync_log WHERE kind='tcs' AND ok=1 ORDER BY id DESC LIMIT 1");
        return ['configured' => $this->tcsConfigured(), 'last' => $last ?: null, 'lastOk' => $lastOk ? $lastOk['at'] : null, 'failing' => (bool) ($last && ! $last['ok']), 'trackAt' => $this->setting('couriers_tcs_track_at', null), 'payAt' => $this->setting('couriers_tcs_pay_at', null),
            'cities' => (int) Db::val('SELECT COUNT(*) n FROM cr_tcs_cities'), 'citiesAt' => $this->setting('couriers_tcs_cities_at', null), 'base' => $this->baseUrl()];
    }

    private function ridersList(): array
    {
        $out = [];
        foreach (Db::all("SELECT id, name, username, role, perms, active FROM users WHERE active=1 AND role<>'admin' ORDER BY name") as $u) {
            if (in_array('rider', Access::userPerms($u), true)) {
                $out[] = ['id' => $u['id'], 'name' => $u['name']];
            }
        }
        return $out;
    }

    private function riderCashOut()
    {
        return self::r2(Db::val("SELECT COALESCE(SUM(i.collected),0) v FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.result='delivered' AND NOT EXISTS (SELECT 1 FROM cr_handovers h WHERE h.run_id=r.id)"));
    }

    /* ================================================================ dispatch: book confirmed orders on PostEx, TCS or the own rider */

    /** PostEx operational cities (cached), matched to the order's city like TCS cities; staff choices are remembered */
    private function syncPxCities(): int
    {
        $j = $this->postex()->call('/v2/get-operational-city');
        $list = self::arr(self::pick($j, 'dist', 'data'));
        if (! $list) {
            throw new RuntimeException('PostEx sent an empty city list');
        }
        Db::tx(function () use ($list) {
            Db::run('DELETE FROM cr_px_cities');
            $yes = fn ($v) => $v === null ? 1 : (($v === true || preg_match('/^(true|yes|1|y)$/i', self::str($v))) ? 1 : 0);
            foreach ($list as $c) {
                $name = trim(self::str(is_string($c) ? $c : (self::pick($c, 'operationalCityName', 'cityName', 'name') ?? '')));
                if ($name === '') {
                    continue;
                }
                Db::run('REPLACE INTO cr_px_cities(name,norm,delivery,pickup) VALUES(?,?,?,?)', $name, self::normCity($name), $yes(self::pick($c, 'isDeliveryCity')), $yes(self::pick($c, 'isPickupCity')));
            }
        });
        $this->setSetting('couriers_px_cities_at', $this->pkNow());
        return (int) Db::val('SELECT COUNT(*) n FROM cr_px_cities');
    }

    private function cacheTry(string $key, int $minutes): bool
    {
        // true = may try now (and remembers the attempt); keeps the JS 10-minute back-off across requests
        try {
            if (Cache::has($key)) {
                return false;
            }
            Cache::put($key, 1, $minutes * 60);
        } catch (\Throwable) {
        }
        return true;
    }

    private function ensurePxCities(bool $throwIt): void
    {
        if (Db::get('SELECT name FROM cr_px_cities LIMIT 1') || ! $this->postex()->configured()) {
            return;
        }
        if (! $this->cacheTry('couriers.pxCityTry', 10) && ! $throwIt) {
            return;
        }
        try {
            $this->syncPxCities();
        } catch (\Throwable $e) {
            $this->syncLog('postex', false, 'cities: '.$e->getMessage());
            if ($throwIt) {
                throw self::bad('Could not load the PostEx city list: '.$e->getMessage());
            }
        }
    }

    private function ensureTcsCitiesSoft(): void
    {
        if (! $this->tcsConfigured() || Db::get('SELECT code FROM cr_tcs_cities LIMIT 1') || ! $this->cacheTry('couriers.tcsCityTry', 10)) {
            return;
        }
        try {
            $this->syncCities();
        } catch (\Throwable $e) {
            $this->syncLog('tcs', false, 'cities: '.$e->getMessage());
        }
    }

    private function ensureTcsCities(): void
    {
        if (! Db::get('SELECT code FROM cr_tcs_cities LIMIT 1')) {
            try {
                $this->syncCities();
            } catch (\Throwable $e) {
                throw self::bad('Could not load the TCS city list: '.$e->getMessage());
            }
        }
    }

    private function matchPxCity($city): array
    {
        $n = self::cityKey($city);
        if ($n === '') {
            return ['name' => null, 'sure' => false, 'options' => []];
        }
        $al = Db::get('SELECT name FROM cr_px_alias WHERE city=?', $n);
        if ($al) {
            return ['name' => $al['name'], 'sure' => true, 'options' => []];
        }
        $all = Db::all('SELECT name, norm FROM cr_px_cities WHERE delivery=1');
        foreach ($all as $c) {
            if ($c['norm'] === $n) {
                return ['name' => $c['name'], 'sure' => true, 'options' => []];
            }
        }
        $cand = self::fuzzy($all, $n);
        return ['name' => $cand[0]['name'] ?? null, 'sure' => false, 'options' => array_map(fn ($c) => ['name' => $c['name']], $cand)];
    }

    /** delivery rate per city and courier over the last N days: { cityKey: { PostEx: {n, del, ret, rate}, TCS: {...} } } */
    private function cityRates(int $days): array
    {
        $from = self::addDays($this->pkToday(), -$days);
        $out = [];
        foreach (Db::all('SELECT o.city, '.self::CK." k, SUM(o.status='delivered') del, SUM(o.status IN ('returning','returned','return_received')) ret FROM orders o
      WHERE o.tracking IS NOT NULL AND o.dispatched_at IS NOT NULL AND ".self::LIVE." AND COALESCE(o.city,'')<>'' AND ".self::PKD('o.dispatched_at').'>=? GROUP BY o.city, k', $from) as $r) {
            $key = self::cityKey($r['city']);
            if ($key === '') {
                continue;
            }
            $x = $out[$key][$r['k']] ?? ['del' => 0, 'ret' => 0];
            $x['del'] += (int) ($r['del'] ?: 0);
            $x['ret'] += (int) ($r['ret'] ?: 0);
            $out[$key][$r['k']] = $x;
        }
        foreach ($out as &$c) {
            foreach ($c as &$x) {
                $x['n'] = $x['del'] + $x['ret'];
                $x['rate'] = $x['n'] ? Logic::jsRound(100 * $x['del'] / $x['n']) : null;
            }
            unset($x);
        }
        unset($c);
        return $out;
    }

    /** which courier a row starts with, and why */
    public function suggest($city, array $rates, array $cfg, array $usable): array
    {
        $okC = fn ($k) => ($usable[$k] ?? null) !== false;
        $dc = $cfg['defaultCourier'] ?? null;
        $def = $okC($dc) ? $dc : (array_values(array_filter(['PostEx', 'TCS'], $okC))[0] ?? $dc);
        $defWhy = $def === $dc ? 'default courier' : "{$dc} is not connected";
        if ($this->isKarachi($city)) {
            $kc = $cfg['karachiCourier'] ?? null;
            $k = $okC($kc) ? $kc : $def;
            return ['courier' => $k, 'why' => $k === $kc ? 'Karachi → '.($k === 'Rider' ? 'own rider' : $k).' (setting)' : 'Karachi: '.($kc === 'Rider' ? 'no rider login yet' : $kc.' not connected')." → {$k}"];
        }
        $nc = self::normCity($city);
        $nm = self::titleCase((self::ALIAS[$nc] ?? null) ?: (self::t($city) ? $city : '')) ?: 'this city';
        $st = $rates[self::cityKey($city)] ?? [];
        $mp = self::num($cfg['minParcels'] ?? null);
        $min = max(1, self::n(is_nan($mp) || ! $mp ? 20 : $mp));
        $enough = array_values(array_filter(['PostEx', 'TCS'], fn ($k) => $okC($k) && isset($st[$k]) && $st[$k]['n'] >= $min));
        usort($enough, fn ($a, $b) => ($st[$b]['rate'] <=> $st[$a]['rate']) ?: ($st[$b]['n'] <=> $st[$a]['n']));
        $line = fn ($k) => isset($st[$k]) && $st[$k]['n'] ? "{$k} {$st[$k]['rate']}% ({$st[$k]['n']})" : "{$k} no parcels";
        if (count($enough) >= 2) {
            [$a, $b] = $enough;
            return ['courier' => $a, 'why' => "{$a}: {$st[$a]['rate']}% delivered in {$nm} vs {$b} {$st[$b]['rate']}%", 'rate' => true];
        }
        $days = self::t($cfg['days'] ?? null) ? $cfg['days'] : 90;
        return ['courier' => $def, 'why' => "{$def}: {$defWhy} — too few results in {$nm}", 'detail' => "Not enough delivered/returned parcels in {$nm} in the last {$days} days to compare (".$line('PostEx').', '.$line('TCS')."; need {$min} each), so the {$defWhy} is used."];
    }

    private function usableCouriers(): array
    {
        return ['PostEx' => $this->postex()->configured(), 'TCS' => $this->tcsConfigured(), 'Rider' => count($this->ridersList()) > 0];
    }

    private function dispatchRows(?array $u): array
    {
        $rows = Db::all("SELECT o.id, o.name, o.created_at, o.packed_at, o.picked_at, o.cust_name, o.phone, o.city, o.city_code, o.address, o.total, o.items, o.status, o.gateway, o.financial, o.tags
    FROM orders o WHERE o.tracking IS NULL AND o.cancelled_at IS NULL AND o.status IN ('confirmed','picked','packed') ORDER BY o.created_at DESC LIMIT 1500");
        $items = [];
        if ($rows) {
            foreach (Db::all("SELECT order_id, title, sku, qty FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tracking IS NULL AND cancelled_at IS NULL AND status IN ('confirmed','picked','packed'))") as $it) {
                $items[$it['order_id']][] = ['title' => $it['title'], 'sku' => $it['sku'], 'qty' => self::t($it['qty']) ? $it['qty'] : 1];
            }
        }
        $cfg = $this->dispCfg();
        $dd = self::num($cfg['days'] ?? null);
        $rates = $this->cityRates((int) (is_nan($dd) || ! $dd ? 90 : $dd));
        $usable = $this->usableCouriers();
        $pw = self::num($this->pxCfg()['weight'] ?? null);
        $tw = self::num($this->tcsCfg()['weight'] ?? null);
        $perPair = self::t($pw) ? $pw : (self::t($tw) ? $tw : 0.5);
        $tcsNames = [];
        foreach (Db::all('SELECT code, name FROM cr_tcs_cities') as $c) {
            $tcsNames[$c['code']] = $c['name'];
        }
        $cT = $cP = $cS = [];
        $showPhone = $this->can($u, 'customers') || $this->can($u, 'tracking') || $this->can($u, 'cs');
        foreach ($rows as &$r) {
            $ck = (string) $r['city'];
            $r['lines'] = $items[$r['id']] ?? [];
            $r['pairs'] = array_sum(array_column($r['lines'], 'qty')) ?: ($r['items'] ?: 1);
            $r['weight'] = self::n(max(0.5, Logic::jsRound($r['pairs'] * $perPair * 10) / 10));
            $r['karachi'] = $this->isKarachi($r['city']);
            $r['tcs'] = self::t($r['city_code']) ? ['code' => $r['city_code'], 'name' => $tcsNames[$r['city_code']] ?? $r['city'], 'sure' => true, 'options' => []] : ($cT[$ck] ??= $this->matchCity($r['city']));
            $r['px'] = $cP[$ck] ??= $this->matchPxCity($r['city']);
            $r['pick'] = $cS[$ck] ??= $this->suggest($r['city'], $rates, $cfg, $usable);
            $r['phone'] = $this->maskPhone($u, $r['phone']);
            if (! $showPhone) {
                $r['address'] = '';
            }
        }
        unset($r);
        return ['rows' => $rows, 'cfg' => $cfg, 'usable' => $usable];
    }

    private function pxBook(array $o, array $opts): string
    {
        $c = $this->pxCfg();
        $pickup = $c['pickupCode'];
        if (! self::t($pickup)) {
            throw new RuntimeException('Choose the PostEx pickup address in Couriers → Settings');
        }
        $city = $opts['city'];
        $phone = self::mobile11($o['phone']);
        if (! preg_match('/^03\d{9}$/', $phone)) {
            throw new RuntimeException('Phone "'.($o['phone'] ?: '').'" is not a mobile number PostEx accepts (03xxxxxxxxx)');
        }
        $items = Db::all('SELECT title, sku, qty FROM order_items WHERE order_id=?', $o['id']);
        $sum = array_reduce($items, fn ($s, $i) => $s + (self::t($i['qty']) ? $i['qty'] : 1), 0);
        $oi = self::num($o['items']);
        $pieces = max(1, $sum ?: (self::t($oi) ? self::n($oi) : 1));
        $detail = $items ? implode(', ', array_map(fn ($i) => ($i['qty'] > 1 ? $i['qty'].' x ' : '').(self::t($i['title']) ? $i['title'] : 'Shoes').(self::t($i['sku']) ? ' ('.$i['sku'].')' : ''), $items)) : 'Shoes';
        $addr = mb_substr(trim(self::str(self::t($o['address']) ? $o['address'] : (self::t($o['city']) ? $o['city'] : ''))), 0, 250);
        $notes = self::t($opts['notes'] ?? null) ? $opts['notes'] : ($c['notes'] ?? '');
        $body = [
            'orderRefNumber' => self::orderName($o), 'invoicePayment' => max(0, Logic::jsRound(self::num($opts['cod'] ?? 0) ?: 0)),
            'orderDetail' => mb_substr($detail, 0, 250),
            'customerName' => mb_substr(trim(self::str(self::t($o['cust_name']) ? $o['cust_name'] : 'Customer')), 0, 100), 'customerPhone' => $phone,
            'deliveryAddress' => $addr !== '' ? $addr : $city, 'cityName' => $city,
            'invoiceDivision' => 1, 'items' => $pieces, 'orderType' => in_array($c['orderType'] ?? null, self::PX_TYPES, true) ? $c['orderType'] : 'Normal',
            'transactionNotes' => mb_substr(self::str($notes ?: ''), 0, 250), 'pickupAddressCode' => self::str($pickup),
        ];
        $j = $this->postex()->send('POST', '/v3/create-order', $body);
        $dist = $j['dist'] ?? null;
        $d = is_array($dist) && array_is_list($dist) ? ($dist[0] ?? null) : ($dist ?: []);
        $tn = self::pick($d, 'trackingNumber', 'trackingNo', 'cn') ?? self::pick($j, 'trackingNumber', 'trackingNo');
        if (! self::t($tn)) {
            throw new RuntimeException('PostEx booking failed: '.(self::t($j['statusMessage'] ?? null) ? $j['statusMessage'] : 'no tracking number in the answer'));
        }
        return self::str($tn);
    }

    private function pxCancel(string $tn): bool
    {
        $this->postex()->send('PUT', '/v1/cancel-order', ['trackingNumber' => $tn]);
        return true;
    }

    private static function codOpt(array $opts, array $o)
    {
        $c = $opts['cod'] ?? null;
        if ($c !== null && $c !== '') {
            $x = self::num($c);
            if (! is_nan($x) && $x >= 0) {
                return Logic::jsRound($x);
            }
        }
        $t = self::num($o['total']);
        return Logic::jsRound(is_nan($t) ? 0 : $t);
    }

    private function bookTcsOne($id, array $u, array $opts = []): array
    {
        $o = $this->getOrder($id);
        if (! $o) {
            return ['id' => $id, 'error' => 'Order not found'];
        }
        if (self::t($o['tracking'])) {
            return ['id' => $id, 'order' => $o['name'], 'error' => "{$o['name']} is already booked (".($o['courier'] ?: '')." {$o['tracking']})"];
        }
        if (self::t($o['cancelled_at']) || ! in_array($o['status'], self::BOOKABLE, true)) {
            return ['id' => $id, 'order' => $o['name'], 'error' => "{$o['name']} is \"".(self::statusLabel($o['status']) ?: $o['status']).'", not ready to book'];
        }
        if ($g = $this->packGate($o)) {
            return ['id' => $id, 'order' => $o['name'], 'notPacked' => true, 'error' => $g];
        }
        $codes = is_array($opts['codes'] ?? null) ? $opts['codes'] : [];
        $chosen = self::t($opts['code'] ?? null) ? $opts['code'] : (self::t($codes[$o['id']] ?? null) ? $codes[$o['id']] : (self::t($codes[$id] ?? null) ? $codes[$id] : null));
        $code = $chosen ?: $o['city_code'];
        if ($chosen) {
            $n = self::normCity($o['city']);
            if ($n !== '' && Db::get('SELECT code FROM cr_tcs_cities WHERE code=?', $code)) {
                Db::run('REPLACE INTO cr_city_alias(city,code,user_id) VALUES(?,?,?)', self::ALIAS[$n] ?? $n, $code, $u['id']);
            }
        }
        if (! self::t($code)) {
            $m = $this->matchCity($o['city']);
            if ($m['sure']) {
                $code = $m['code'];
            }
        }
        if (! self::t($code)) {
            return ['id' => $id, 'order' => $o['name'], 'needCity' => true, 'error' => "Choose the TCS city for {$o['name']} (".($o['city'] ?: 'no city').')', 'options' => $this->matchCity($o['city'])['options']];
        }
        $cod = self::codOpt($opts, $o);
        try {
            $cn = $this->tcsBook($o, self::str($code), ['weight' => $opts['weight'] ?? null, 'pieces' => $opts['pieces'] ?? null, 'cod' => $cod]);
            $this->setBooked($o, 'TCS', $cn, ['status' => 'Booked', 'cod' => $cod, 'setCod' => $cod, 'city_code' => self::str($code), 'via' => 'api']);
            $this->log($u['id'], 'couriers.book', 'order:'.$o['id'], ['courier' => 'TCS', 'cn' => $cn, 'cod' => $cod]);
            return ['id' => $id, 'order' => $o['name'], 'ok' => true, 'tracking' => $cn, 'courier' => 'TCS'];
        } catch (\Throwable $e) {
            return ['id' => $id, 'order' => $o['name'], 'error' => $e->getMessage()];
        }
    }

    private function bookPxOne($id, array $u, array $opts = []): array
    {
        $o = $this->getOrder($id);
        if (! $o) {
            return ['id' => $id, 'error' => 'Order not found'];
        }
        if (self::t($o['tracking'])) {
            return ['id' => $id, 'order' => $o['name'], 'error' => "{$o['name']} is already booked (".($o['courier'] ?: '')." {$o['tracking']})"];
        }
        if (self::t($o['cancelled_at']) || ! in_array($o['status'], self::BOOKABLE, true)) {
            return ['id' => $id, 'order' => $o['name'], 'error' => "{$o['name']} is \"".(self::statusLabel($o['status']) ?: $o['status']).'", not ready to book'];
        }
        if ($g = $this->packGate($o)) {
            return ['id' => $id, 'order' => $o['name'], 'notPacked' => true, 'error' => $g];
        }
        $city = null;
        if (self::t($opts['city'] ?? null)) {
            $hit = Db::get('SELECT name FROM cr_px_cities WHERE name=? OR norm=?', self::str($opts['city']), self::normCity($opts['city']));
            if (! $hit) {
                return ['id' => $id, 'order' => $o['name'], 'needCity' => true, 'error' => '"'.self::str($opts['city']).'" is not a PostEx city', 'options' => $this->matchPxCity($o['city'])['options']];
            }
            $city = $hit['name'];
            $n = self::cityKey($o['city']);
            if ($n !== '') {
                Db::run('REPLACE INTO cr_px_alias(city,name,user_id) VALUES(?,?,?)', $n, $city, $u['id']);
            }
        } else {
            $m = $this->matchPxCity($o['city']);
            if ($m['sure']) {
                $city = $m['name'];
            } else {
                return ['id' => $id, 'order' => $o['name'], 'needCity' => true, 'error' => "Choose the PostEx city for {$o['name']} (".($o['city'] ?: 'no city').')', 'options' => $m['options']];
            }
        }
        $cod = self::codOpt($opts, $o);
        try {
            $tn = $this->pxBook($o, ['city' => $city, 'cod' => $cod, 'notes' => $opts['notes'] ?? null]);
            if (Db::get('SELECT id FROM orders WHERE tracking=? AND id<>?', $tn, $o['id'])) {
                throw new RuntimeException("PostEx sent tracking {$tn}, which is already on another order");
            }
            $this->setBooked($o, 'PostEx', $tn, ['cod' => $cod, 'setCod' => $cod, 'via' => 'api']);
            $this->log($u['id'], 'couriers.book', 'order:'.$o['id'], ['courier' => 'PostEx', 'cn' => $tn, 'cod' => $cod, 'city' => $city]);
            return ['id' => $id, 'order' => $o['name'], 'ok' => true, 'tracking' => $tn, 'courier' => 'PostEx'];
        } catch (\Throwable $e) {
            return ['id' => $id, 'order' => $o['name'], 'error' => $e->getMessage()];
        }
    }

    /* ---------------- Shopify: mark the order fulfilled with the tracking number (optional; failures never undo the booking) */

    private static function trackUrl(string $k, string $tn): ?string
    {
        return $k === 'PostEx' ? 'https://postex.pk/tracking?cn='.rawurlencode($tn) : ($k === 'TCS' ? 'https://www.tcsexpress.com/track/'.rawurlencode($tn) : null);
    }

    private function shopifyFulfil(string $orderId, ?int $uid = null): ?array
    {
        $o = Db::get('SELECT id, name, courier, tracking FROM orders WHERE id=?', $orderId);
        if (! $o || ! self::t($o['tracking'])) {
            return null;
        }
        $k = Logic::courierKey($o['courier']);
        $rec = fn ($ok, $error, $fid = null) => Db::run('INSERT INTO cr_fulfil(order_id,tracking,courier,ok,error,fulfillment_id,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE tracking=VALUES(tracking), courier=VALUES(courier), ok=VALUES(ok), error=VALUES(error), fulfillment_id=COALESCE(VALUES(fulfillment_id),fulfillment_id), at=VALUES(at)', $o['id'], $o['tracking'], $k, $ok ? 1 : 0, $error ?: null, $fid ?: null);
        try {
            if (! preg_match('#^gid://shopify/Order/#', $o['id'])) {
                throw new RuntimeException('Not a Shopify order');
            }
            if (! $this->shopify()->configured()) {
                throw new RuntimeException('Shopify is not connected');
            }
            $r = app(ShopifyWriter::class)->createFulfillment($o['id'], (string) $o['tracking'], self::COMPANY[$k] ?? (string) $o['courier'], self::trackUrl($k, (string) $o['tracking']), $uid);
            if (! $r['ok']) {
                throw new RuntimeException((string) ($r['error'] ?: 'Fulfilment failed'));
            }
            $rec(true, null, $r['fulfillment_id'] ?? null);
            return ['ok' => true];
        } catch (\Throwable $e) {
            $rec(false, $e->getMessage());
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    private function shopifyUnfulfil(array $o, ?int $uid = null): ?array
    {
        $f = Db::get('SELECT * FROM cr_fulfil WHERE order_id=? AND ok=1 AND fulfillment_id IS NOT NULL', $o['id']);
        if (! $f) {
            return null;
        }
        $r = app(ShopifyWriter::class)->cancelFulfillment((string) $f['fulfillment_id'], $uid);
        if ($r['ok']) {
            Db::run('DELETE FROM cr_fulfil WHERE order_id=?', $o['id']);
            return ['ok' => true];
        }
        $err = (string) ($r['error'] ?? 'Error');
        Db::run('UPDATE cr_fulfil SET error=? WHERE order_id=?', 'Booking cancelled in the ERP, but Shopify fulfilment could not be cancelled: '.$err, $o['id']);
        return ['ok' => false, 'error' => $err];
    }

    private function queueFulfil(array $ids, ?int $uid = null): bool
    {
        if (! self::t($this->dispCfg()['shopifyFulfil'] ?? null) || ! $ids) {
            return false;
        }
        $ids = array_values(array_filter($ids, fn ($id) => (bool) preg_match('#^gid://shopify/Order/#', (string) $id)));
        if (! $ids) {
            return false; // demo / manual orders are not in Shopify
        }
        Defer::run(function () use ($ids, $uid) {
            foreach ($ids as $id) {
                $this->shopifyFulfil($id, $uid);
            }
        }, 'couriers');
        return true;
    }

    private function okIds(array $results): array
    {
        $out = [];
        foreach ($results as $r) {
            if ($r && ! empty($r['ok'])) {
                $o = $this->getOrder($r['id']);
                if ($o) {
                    $out[] = $o['id'];
                }
            }
        }
        return $out;
    }

    private function stepCounts(): array
    {
        $n = fn ($sql, ...$a) => (int) Db::val($sql, ...$a);
        $open = 'tracking IS NULL AND cancelled_at IS NULL';
        $packFirst = self::t($this->dispCfg()['packFirst'] ?? null);
        return ['packFirst' => $packFirst,
            'pick' => $n("SELECT COUNT(*) n FROM orders WHERE {$open} AND status='confirmed'"),
            'pack' => $n("SELECT COUNT(*) n FROM orders WHERE {$open} AND status='picked'"),
            'book' => $n("SELECT COUNT(*) n FROM orders WHERE {$open} AND status IN (".($packFirst ? "'packed'" : "'confirmed','picked','packed'").')'),
            'handover' => $n('SELECT COUNT(*) n FROM orders o LEFT JOIN cr_handed hd ON hd.order_id=o.id WHERE o.tracking IS NOT NULL AND '.self::LIVE.' AND o.dispatched_at IS NOT NULL AND '.self::HAND_WAIT),
            'today' => $n('SELECT COUNT(*) n FROM orders o WHERE o.tracking IS NOT NULL AND '.self::LIVE.' AND o.dispatched_at IS NOT NULL AND '.self::PKD('o.dispatched_at').'=?', $this->pkToday())];
    }

    /* ================================================================ module */

    public function install(): void
    {
        // one spelling for courier names that came from Shopify ('TCS Express' -> 'TCS', 'Post Ex' -> 'PostEx')
        foreach (Db::all('SELECT DISTINCT courier FROM orders WHERE courier IS NOT NULL') as $r) {
            $n = Logic::normCourier($r['courier']);
            if ($n !== $r['courier']) {
                Db::run('UPDATE orders SET courier=? WHERE BINARY courier=?', $n, $r['courier']);
            }
        }
    }

    public function routes(Router $r): void
    {
        /* ---- settings ---- */
        $r->get('/api/couriers/settings', 'settings', 'settingsGet');
        $r->post('/api/couriers/settings', 'settings', 'settingsSave');
        $r->post('/api/couriers/tcs/test', 'settings', 'tcsTest');
        $r->post('/api/couriers/tcs/sync', 'couriers', 'tcsSync');
        $r->get('/api/couriers/tcs/cities', 'couriers', 'tcsCities');
        /* ---- booking ---- */
        $r->get('/api/couriers/riders', 'couriers', 'ridersGet');
        $r->get('/api/couriers/book', 'couriers', 'bookList');
        $r->post('/api/couriers/book', 'couriers', 'book');
        $r->post('/api/couriers/orders/:id/cancel', 'couriers', 'cancelBooking');
        /* ---- dispatch screen ---- */
        $r->get('/api/couriers/dispatch', 'couriers', 'dispatchGet');
        $r->post('/api/couriers/dispatch/book', 'couriers', 'dispatchBook');
        $r->get('/api/couriers/dispatch/today', 'couriers', 'dispatchToday');
        $r->post('/api/couriers/dispatch/shopify/:id', 'couriers', 'dispatchShopify');
        /* ---- dispatch desk: step counts, handover to the courier ---- */
        $r->get('/api/couriers/dispatch/steps', 'couriers', 'dispatchSteps');
        $r->get('/api/couriers/dispatch/handover', 'couriers', 'handedList');
        $r->post('/api/couriers/dispatch/handover', 'couriers', 'handedSave');
        $r->get('/api/couriers/postex/cities', 'couriers', 'pxCities');
        $r->post('/api/couriers/postex/cities', 'couriers', 'pxCitiesSync');
        $r->get('/api/couriers/postex/addresses', 'settings', 'pxAddresses');
        $r->get('/api/couriers/postex/awb', 'couriers', 'pxAwb');
        $r->post('/api/couriers/postex/loadsheet', 'couriers', 'pxLoadsheet');
        $r->post('/api/couriers/orders/:id/track', 'couriers', 'trackOrder');
        $r->get('/api/couriers/parcels', 'couriers', 'parcels');
        $r->get('/api/couriers/label/:id', 'couriers', 'label');
        /* ---- rider runs (office) ---- */
        $r->get('/api/couriers/runs', 'couriers', 'runsList');
        $r->post('/api/couriers/runs', 'couriers', 'runCreate');
        $r->get('/api/couriers/runs/:id', 'couriers', 'runGet');
        $r->post('/api/couriers/runs/:id/add', 'couriers', 'runAdd');
        $r->post('/api/couriers/runs/:id/remove', 'couriers', 'runRemove');
        $r->post('/api/couriers/runs/:id/out', 'couriers', 'runOut');
        $r->post('/api/couriers/runs/:id/delete', 'couriers', 'runDelete');
        $r->post('/api/couriers/items/:id/result', 'couriers', 'itemResult');
        $r->post('/api/couriers/runs/:id/handover', 'dashboard', 'runHandover');
        $r->get('/api/couriers/ledger', 'dashboard', 'ledger');
        $r->get('/api/couriers/rider-fees', 'couriers', 'riderFeesGet');
        $r->post('/api/couriers/rider-fees/approve', 'couriers', 'riderFeesApprove');
        $r->get('/api/couriers/dashboard', 'couriers', 'dashboard');
        /* ---- rider app (the rider sees only his own parcels) ---- */
        $r->get('/api/rider/today', 'rider', 'riderToday');
        $r->post('/api/rider/items/:id', 'rider', 'riderItem');
        $r->post('/api/rider/runs/:id/start', 'rider', 'riderStart');
    }

    private static function isAdm(?array $u): bool
    {
        return ($u['role'] ?? null) === 'admin';
    }

    /* ---- settings ---- */

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = $this->tcsCfg();
        $out = $t;
        $has = [];
        foreach (self::SECRET_KEYS as $k) {
            $out[$k] = self::mask($k, $t[$k] ?? null);
            $has[$k] = self::t($t[$k] ?? null);
        }
        return ['tcs' => $out, 'has' => $has, 'tcsFee' => $this->tcsFee(), 'rider' => $this->riderCfg(), 'state' => $this->tcsState(),
            'postex' => $this->pxCfg(), 'dispatch' => $this->dispCfg(), 'pxState' => ['configured' => $this->postex()->configured(), 'cities' => (int) Db::val('SELECT COUNT(*) n FROM cr_px_cities WHERE delivery=1'), 'citiesAt' => $this->setting('couriers_px_cities_at', null)], 'shopify' => $this->shopify()->configured()];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        if (self::t($b['tcs'] ?? null) && is_array($b['tcs'])) {
            $bt = $b['tcs'];
            $nx = $this->tcsCfg();
            foreach (['account', 'customerNo', 'costCenter', 'shipperName', 'shipperAddress', 'shipperCity', 'shipperCityCode', 'shipperMobile', 'serviceCode', 'baseUrl'] as $k) {
                if (array_key_exists($k, $bt)) {
                    $nx[$k] = trim(self::str($bt[$k] ?? ''));
                }
            }
            if (array_key_exists('weight', $bt)) {
                $w = self::num($bt['weight']);
                $this->need(! is_nan($w) && $w >= 0.5, 'Default weight must be at least 0.5 kg');
                $nx['weight'] = self::n($w);
            }
            if (array_key_exists('sandbox', $bt)) {
                $nx['sandbox'] = self::t($bt['sandbox']);
            }
            foreach (self::SECRET_KEYS as $k) {
                if (! array_key_exists($k, $bt)) {
                    continue;
                }
                $v = $bt[$k];
                if ($v === null) {
                    unset($nx[$k]);
                } elseif (is_string($v) && trim($v) !== '' && ! str_contains($v, '•')) {
                    $nx[$k] = trim($v);
                }
            }
            $this->setSetting('couriers_tcs', $nx);
            $this->resetTokens();
        }
        if (array_key_exists('tcsFee', $b)) {
            $f = self::num($b['tcsFee']);
            $this->need(! is_nan($f) && $f >= 0, 'TCS charge must be 0 or more');
            $this->setSetting('couriers_tcs_fee', self::n($f));
        }
        if (self::t($b['rider'] ?? null) && is_array($b['rider'])) {
            $br = $b['rider'];
            $nx = $this->riderCfg();
            if (array_key_exists('fee', $br)) {
                $f = self::num($br['fee']);
                $this->need(! is_nan($f) && $f >= 0, 'Rider fee must be 0 or more');
                $nx['fee'] = self::n($f) ?: 0;
            }
            if (array_key_exists('karachi', $br)) {
                $nx['karachi'] = self::t($br['karachi']) ? self::str($br['karachi']) : '';
            }
            if (array_key_exists('cashAccount', $br) && self::t($br['cashAccount'])) {
                $A = $this->svc('accounts');
                $this->need(! $A || $A->accountId($br['cashAccount']), 'Unknown account');
                $nx['cashAccount'] = $br['cashAccount'];
            }
            $this->setSetting('couriers_rider', $nx);
        }
        if (self::t($b['postex'] ?? null) && is_array($b['postex'])) {
            $bp = $b['postex'];
            $nx = $this->pxCfg();
            if (array_key_exists('pickupCode', $bp)) {
                $nx['pickupCode'] = trim(self::t($bp['pickupCode']) ? self::str($bp['pickupCode']) : '');
                $nx['pickupAddress'] = mb_substr(self::t($bp['pickupAddress'] ?? null) ? self::str($bp['pickupAddress']) : '', 0, 250);
            }
            if (array_key_exists('weight', $bp)) {
                $w = self::num($bp['weight']);
                $this->need(! is_nan($w) && $w > 0, 'Weight per pair must be more than 0');
                $nx['weight'] = self::n($w);
            }
            if (array_key_exists('notes', $bp)) {
                $nx['notes'] = mb_substr(self::t($bp['notes']) ? self::str($bp['notes']) : '', 0, 250);
            }
            if (array_key_exists('orderType', $bp)) {
                $this->need(in_array($bp['orderType'], self::PX_TYPES, true), 'Order type must be '.implode(' / ', self::PX_TYPES));
                $nx['orderType'] = $bp['orderType'];
            }
            $this->setSetting('couriers_postex', $nx);
        }
        if (self::t($b['dispatch'] ?? null) && is_array($b['dispatch'])) {
            $d = $b['dispatch'];
            $nx = $this->dispCfg();
            if (array_key_exists('defaultCourier', $d)) {
                $this->need(in_array($d['defaultCourier'], ['PostEx', 'TCS'], true), 'Default courier must be PostEx or TCS');
                $nx['defaultCourier'] = $d['defaultCourier'];
            }
            if (array_key_exists('karachiCourier', $d)) {
                $this->need(in_array($d['karachiCourier'], self::COURIERS, true), 'Karachi courier must be Rider, TCS or PostEx');
                $nx['karachiCourier'] = $d['karachiCourier'];
            }
            if (array_key_exists('minParcels', $d)) {
                $mp = self::num($d['minParcels']);
                $this->need(! is_nan($mp) && $mp >= 1, 'Minimum parcels must be 1 or more');
                $nx['minParcels'] = Logic::jsRound($mp);
            }
            if (array_key_exists('shopifyFulfil', $d)) {
                $nx['shopifyFulfil'] = self::t($d['shopifyFulfil']);
            }
            if (array_key_exists('packFirst', $d)) {
                $nx['packFirst'] = self::t($d['packFirst']);
            }
            $this->setSetting('couriers_dispatch', $nx);
        }
        $this->log($u['id'], 'couriers.settings', 'settings', ['tcs' => self::t($b['tcs'] ?? null), 'rider' => self::t($b['rider'] ?? null), 'postex' => self::t($b['postex'] ?? null), 'dispatch' => self::t($b['dispatch'] ?? null)]);
        return ['ok' => true];
    }

    public function tcsTest(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $out = ['base' => $this->baseUrl()];
        $out['bearer'] = (bool) $this->bearer();
        $t = $this->tcsCfg();
        if (self::t($t['username'] ?? null) && self::t($t['password'] ?? null)) {
            $out['access'] = (bool) $this->accessToken();
        }
        $out['cities'] = $this->syncCities();
        $this->syncLog('tcs', true, 'connection test ok · '.$out['cities'].' cities');
        return ['ok' => true] + $out;
    }

    public function tcsSync(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->tcsConfigured(), 'TCS is not connected yet (Couriers → Settings)');
        $kind = self::t($b['kind'] ?? null) ? $b['kind'] : 'track';
        try {
            $r = $kind === 'payments' ? $this->syncPayments() : ($kind === 'cities' ? ['cities' => $this->syncCities()] : $this->syncTrack());
        } catch (\Throwable $e) {
            $this->syncLog('tcs', false, self::str($kind).': '.$e->getMessage());
            throw self::bad($e->getMessage());
        }
        $this->log($u['id'], 'couriers.sync', 'tcs', ['kind' => $kind]);
        return $r;
    }

    public function tcsCities(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $t = '%'.self::normCity($qs['q'] ?? '').'%';
        return Db::all('SELECT code, name FROM cr_tcs_cities WHERE norm LIKE ? ORDER BY name LIMIT 50', $t);
    }

    /* ---- booking ---- */

    public function ridersGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->ridersList();
    }

    public function bookList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $st = ($qs['show'] ?? null) === 'all' ? self::BOOKABLE : ['packed'];
        $rows = Db::all("SELECT o.id, o.name, o.created_at, o.packed_at, o.cust_name, o.phone, o.city, o.city_code, o.address, o.total, o.items, o.status, o.gateway,
          (SELECT GROUP_CONCAT(title SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o
        WHERE o.tracking IS NULL AND o.cancelled_at IS NULL AND o.status IN (".Db::marks($st).') ORDER BY COALESCE(o.packed_at,o.created_at) LIMIT 500', ...$st);
        $cache = [];
        foreach ($rows as &$r) {
            $r['karachi'] = $this->isKarachi($r['city']);
            $r['tcs'] = self::t($r['city_code'])
                ? ['code' => $r['city_code'], 'sure' => true, 'name' => (Db::get('SELECT name FROM cr_tcs_cities WHERE code=?', $r['city_code'])['name'] ?? null) ?: $r['city'], 'options' => []]
                : ($cache[(string) $r['city']] ??= $this->matchCity($r['city']));
            $r['phone'] = $this->maskPhone($u, $r['phone']);
            if (! $this->can($u, 'customers') && ! $this->can($u, 'tracking')) {
                $r['address'] = '';
            }
        }
        unset($r);
        $counts = Db::get("SELECT SUM(status='packed') packed, COUNT(*) all_ FROM orders WHERE tracking IS NULL AND cancelled_at IS NULL AND status IN ('confirmed','picked','packed')");
        $runs = Db::all("SELECT r.id, r.day, r.status, r.rider_id, u.name rider, (SELECT COUNT(*) FROM cr_run_items WHERE run_id=r.id) parcels FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.status<>'closed' ORDER BY r.day DESC, r.id DESC");
        return ['rows' => $rows, 'counts' => ['packed' => $counts['packed'] ?: 0, 'all' => $counts['all_'] ?: 0], 'riders' => $this->ridersList(), 'runs' => $runs, 'tcs' => ['configured' => $this->tcsConfigured(), 'cities' => (int) Db::val('SELECT COUNT(*) n FROM cr_tcs_cities')]];
    }

    public function book(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = array_map(fn ($x) => self::str($x), is_array($b['ids'] ?? null) ? array_values($b['ids']) : []);
        $this->need(count($ids) > 0, 'Select orders first');
        $courier = Logic::normCourier(self::t($b['courier'] ?? null) ? self::str($b['courier']) : '');
        $this->need($courier, 'Choose a courier');
        $results = [];
        if ($courier === 'Rider') {
            $run = self::t($b['run_id'] ?? null) ? $this->runRow((int) self::num($b['run_id'])) : null;
            if (! $run) {
                $this->need(self::t($b['rider_id'] ?? null), 'Choose the rider');
                $d = self::isDate($b['day'] ?? null) ? $b['day'] : $this->pkToday();
                $run = Db::get("SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.rider_id=? AND r.day=? AND r.status<>'closed' ORDER BY r.id DESC LIMIT 1", (int) self::num($b['rider_id']), $d)
                    ?: $this->createRun($b['rider_id'], $d, $u);
            }
            $this->need($run && $run['status'] !== 'closed', 'That run is closed');
            foreach ($ids as $id) {
                $results[] = ['id' => $id] + $this->addToRun($run, $this->getOrder($id), $u, self::t($b['force'] ?? null));
            }
            $this->queueFulfil($this->okIds($results), $u['id']);
            return ['run' => $run['id'], 'results' => $results];
        }
        if (array_key_exists('tracking', $b) || $courier !== 'TCS' || self::t($b['manual'] ?? null)) {
            // tracking entered by hand (PostEx booked in Shopify, or any other courier)
            $this->need(count($ids) === 1, 'Enter tracking one order at a time');
            $tn = trim(self::t($b['tracking'] ?? null) ? self::str($b['tracking']) : '');
            $this->need(mb_strlen($tn) >= 4, 'Enter the tracking number');
            $o = $this->getOrder($ids[0]);
            $this->need($o, 'Order not found', 404);
            $this->need(! self::t($o['cancelled_at']), 'This order is cancelled');
            $this->need(! self::t($o['tracking']) || self::t($b['replace'] ?? null), "{$o['name']} already has tracking {$o['tracking']} (".($o['courier'] ?: 'courier').')');
            $dup = Db::get('SELECT name FROM orders WHERE tracking=? AND id<>?', $tn, $o['id']);
            $this->need(! $dup, "Tracking {$tn} is already on order ".($dup ? $dup['name'] : ''));
            if (self::t($o['tracking']) && Logic::courierKey($o['courier']) === 'Rider') {
                $this->need(! $this->openItem($o['id']), 'This order is on a rider run — remove it from the run first');
            }
            $this->setBooked($o, $courier, $tn, ['status' => $courier === 'TCS' ? 'Booked' : null, 'cod' => $o['total']]);
            $this->log($u['id'], 'couriers.tracking', 'order:'.$o['id'], ['courier' => $courier, 'tracking' => $tn]);
            $this->queueFulfil([$o['id']], $u['id']);
            return ['results' => [['id' => $o['id'], 'ok' => true, 'tracking' => $tn, 'courier' => $courier]]];
        }
        // TCS API booking (one by one; each order reports its own result)
        $this->need($this->tcsConfigured(), 'TCS is not connected yet. Add the TCS login in Couriers → Settings.');
        $this->ensureTcsCities();
        $codes = is_array($b['city_codes'] ?? null) ? $b['city_codes'] : [];
        foreach ($ids as $id) {
            $results[] = $this->bookTcsOne($id, $u, ['codes' => $codes, 'weight' => $b['weight'] ?? null, 'pieces' => $b['pieces'] ?? null]);
        }
        $this->queueFulfil($this->okIds($results), $u['id']);
        return ['results' => $results];
    }

    public function cancelBooking(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $o = $this->getOrder($p['id']);
        $this->need($o && self::t($o['tracking']), 'This order is not booked', 404);
        $k = Logic::courierKey($o['courier']);
        if ($k === 'Rider') {
            $it = $this->openItem($o['id']);
            $this->need(! $it || ! self::t($it['result']), 'The rider already marked this parcel — undo it in the rider run first');
            if ($it) {
                Db::run('DELETE FROM cr_run_items WHERE id=?', $it['id']);
            }
        } else {
            $this->need($o['status'] === 'dispatched' || self::isAdm($u), "{$o['name']} is already \"".(self::statusLabel($o['status']) ?? 'undefined').'" with the courier — it cannot be cancelled now');
            $api = ($b['api'] ?? null) !== false;
            if ($k === 'TCS' && $o['bk_tracking'] === $o['tracking'] && $this->tcsConfigured() && $api) {
                $this->tcsCancel($o['tracking']);
            }
            if ($k === 'PostEx' && $o['bk_via'] === 'api' && $o['bk_tracking'] === $o['tracking'] && $api) {
                try {
                    $this->pxCancel($o['tracking']);
                } catch (\Throwable $e) {
                    throw self::bad($e->getMessage());
                }
            }
        }
        $shop = $this->shopifyUnfulfil($o, $u['id']);
        Db::run('DELETE FROM cr_handed WHERE order_id=?', $o['id']);
        $this->clearBooking($o);
        $this->log($u['id'], 'couriers.cancel', 'order:'.$o['id'], ['courier' => $o['courier'], 'tracking' => $o['tracking']]);
        return ['ok' => true, 'shopify' => $shop];
    }

    /* ---- dispatch screen ---- */

    public function dispatchGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->ensurePxCities(false);
        $this->ensureTcsCitiesSoft();
        $d = $this->dispatchRows($u);
        $today = $this->pkToday();
        $booked = (int) Db::val('SELECT COUNT(*) n FROM orders o WHERE o.tracking IS NOT NULL AND '.self::LIVE.' AND o.dispatched_at IS NOT NULL AND '.self::PKD('o.dispatched_at').'=?', $today);
        $px = $this->pxCfg();
        return $d + ['today' => $today, 'bookedToday' => $booked, 'packFirst' => self::t($d['cfg']['packFirst'] ?? null), 'riders' => $this->ridersList(), 'pickup' => ['code' => $px['pickupCode'], 'address' => $px['pickupAddress']],
            'cities' => ['px' => (int) Db::val('SELECT COUNT(*) n FROM cr_px_cities WHERE delivery=1'), 'tcs' => (int) Db::val('SELECT COUNT(*) n FROM cr_tcs_cities')]];
    }

    public function dispatchBook(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $rows = array_slice(array_values(array_filter(is_array($b['rows'] ?? null) ? array_values($b['rows']) : [], fn ($r) => is_array($r) && ($r['id'] ?? null) !== null)), 0, 300);
        $this->need(count($rows) > 0, 'Select orders first');
        $seen = [];
        foreach ($rows as $r) {
            $this->need(! isset($seen[self::str($r['id'])]), 'An order is listed twice');
            $seen[self::str($r['id'])] = true;
        }
        $results = array_fill(0, count($rows), null);
        $kind = fn ($r) => ($r['courier'] ?? null) === 'Rider' ? 'Rider' : Logic::normCourier(self::t($r['courier'] ?? null) ? self::str($r['courier']) : '');
        foreach ($rows as $i => $r) {
            if (! in_array($kind($r), ['PostEx', 'TCS', 'Rider'], true)) {
                $results[$i] = ['id' => $r['id'], 'error' => 'Choose PostEx, TCS or Rider'];
            }
        }
        $idx = fn ($k) => array_values(array_filter(array_keys($rows), fn ($i) => ! $results[$i] && $kind($rows[$i]) === $k));
        // rider: one run for the chosen rider today (made if none)
        $rIdx = $idx('Rider');
        $run = null;
        if ($rIdx) {
            $rl = $this->ridersList();
            $rid = (int) self::num($b['rider_id'] ?? null) ?: (count($rl) === 1 ? (int) $rl[0]['id'] : 0);
            if (! $rid) {
                foreach ($rIdx as $i) {
                    $results[$i] = ['id' => $rows[$i]['id'], 'error' => $rl ? 'Choose the rider for Karachi parcels' : 'No rider login yet — add a staff login with the Rider role'];
                }
            } else {
                try {
                    $run = self::t($b['run_id'] ?? null) ? $this->runRow((int) self::num($b['run_id'])) : null;
                    if ($run && ($run['status'] === 'closed' || (int) $run['rider_id'] !== $rid)) {
                        $run = null;
                    }
                    $run = $run ?: (Db::get("SELECT r.*, u.name rider FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id WHERE r.rider_id=? AND r.day=? AND r.status<>'closed' ORDER BY r.id DESC LIMIT 1", $rid, $this->pkToday()) ?: $this->createRun($rid, $this->pkToday(), $u));
                    foreach ($rIdx as $i) {
                        $r = $rows[$i];
                        $o = $this->getOrder($r['id']);
                        $cv = $r['cod'] ?? null;
                        $x = $this->addToRun($run, $o, $u, true, $cv !== null && $cv !== '' ? self::num($cv) : null);
                        if (! empty($x['ok'])) {
                            $results[$i] = ['id' => $r['id'], 'order' => $o['name'], 'ok' => true, 'courier' => 'Rider', 'tracking' => self::riderTracking($o), 'run' => $run['id']];
                        } else {
                            $res = ['id' => $r['id']];
                            if ($o || trim(self::str($r['id'])) === '') {
                                $res['order'] = $o['name'] ?? null;
                            }
                            $res['error'] = $x['error'] ?? $x['warn'] ?? null;
                            if (! empty($x['notPacked'])) {
                                $res['notPacked'] = true;
                            }
                            $results[$i] = $res;
                        }
                    }
                } catch (\Throwable $e) {
                    foreach ($rIdx as $i) {
                        $results[$i] ??= ['id' => $rows[$i]['id'], 'error' => $e->getMessage()];
                    }
                }
            }
        }
        $pIdx = $idx('PostEx');
        $tIdx = $idx('TCS');
        if ($pIdx) {
            $err = ! $this->postex()->configured() ? 'PostEx is not connected. Add the PostEx token in Settings → PostEx.' : (! self::t($this->pxCfg()['pickupCode']) ? 'Choose the PostEx pickup address in Couriers → Settings' : null);
            if (! $err) {
                try {
                    $this->ensurePxCities(true);
                } catch (\Throwable $e) {
                    $err = $e->getMessage();
                }
            }
            foreach ($pIdx as $i) {
                $r = $rows[$i];
                $results[$i] = $err ? ['id' => $r['id'], 'error' => $err] : $this->bookPxOne($r['id'], $u, ['city' => $r['city'] ?? null, 'cod' => $r['cod'] ?? null]);
            }
        }
        if ($tIdx) {
            $err = ! $this->tcsConfigured() ? 'TCS is not connected yet. Add the TCS login in Couriers → Settings.' : null;
            if (! $err) {
                try {
                    $this->ensureTcsCities();
                } catch (\Throwable $e) {
                    $err = $e->getMessage();
                }
            }
            foreach ($tIdx as $i) {
                $r = $rows[$i];
                if ($err) {
                    $results[$i] = ['id' => $r['id'], 'error' => $err];
                    continue;
                }
                $o = $this->getOrder($r['id']);
                $pairs = $o ? ((int) Db::val('SELECT COALESCE(SUM(qty),0) n FROM order_items WHERE order_id=?', $o['id']) ?: 1) : 1;
                $tw = self::num($this->tcsCfg()['weight'] ?? null);
                $pw = self::num($this->pxCfg()['weight'] ?? null);
                $w = max(self::t($tw) ? $tw : 1, Logic::jsRound($pairs * (self::t($pw) ? $pw : 0.5) * 10) / 10);
                $results[$i] = $this->bookTcsOne($r['id'], $u, ['code' => $r['city'] ?? null, 'cod' => $r['cod'] ?? null, 'weight' => self::n((float) $w)]);
            }
        }
        $shopify = $this->queueFulfil($this->okIds($results), $u['id']);
        return ['results' => $results, 'run' => $run ? $run['id'] : null, 'shopify' => $shopify];
    }

    public function dispatchToday(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $d = self::isDate($qs['day'] ?? null) ? $qs['day'] : $this->pkToday();
        $rows = Db::all('SELECT o.id, o.name, o.cust_name, o.phone, o.city, o.total, o.cod, o.courier_cod, o.courier, o.tracking, o.status, o.courier_status, o.dispatched_at, o.rider_run_id, o.bk_via,
          (SELECT GROUP_CONCAT(title SEPARATOR \' + \') FROM order_items WHERE order_id=o.id) items_text, f.ok shop_ok, f.error shop_error, '.self::CK.' k, hd.at handed_at, hu.name handed_by
        FROM orders o LEFT JOIN cr_fulfil f ON f.order_id=o.id LEFT JOIN cr_handed hd ON hd.order_id=o.id LEFT JOIN users hu ON hu.id=hd.user_id WHERE o.tracking IS NOT NULL AND '.self::LIVE.' AND o.dispatched_at IS NOT NULL AND '.self::PKD('o.dispatched_at').'=? ORDER BY o.dispatched_at DESC LIMIT 1000', $d);
        foreach ($rows as &$r) {
            $r['phone'] = $this->maskPhone($u, $r['phone']);
        }
        unset($r);
        return ['day' => $d, 'rows' => $rows, 'shopifyFulfil' => self::t($this->dispCfg()['shopifyFulfil'] ?? null)];
    }

    public function dispatchShopify(?array $u, array $b, array $p, array $qs, Request $req): ?array
    {
        $o = $this->getOrder($p['id']);
        $this->need($o && self::t($o['tracking']), 'This order is not booked', 404);
        return $this->shopifyFulfil($o['id'], $u['id']);
    }

    /* ---- dispatch desk: step counts, handover to the courier ---- */

    public function dispatchSteps(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->stepCounts();
    }

    public function handedList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $rows = Db::all("SELECT o.id, o.name, o.cust_name, o.phone, o.city, o.address, o.total, o.cod, o.courier_cod, o.courier, o.tracking, o.status, o.dispatched_at, o.rider_run_id, o.items,
          (SELECT GROUP_CONCAT(COALESCE(sku,title) SEPARATOR ', ') FROM order_items WHERE order_id=o.id) skus, ".self::CK.' k, hd.at handed_at, hu.name handed_by
        FROM orders o LEFT JOIN cr_handed hd ON hd.order_id=o.id LEFT JOIN users hu ON hu.id=hd.user_id
        WHERE o.tracking IS NOT NULL AND '.self::LIVE.' AND o.dispatched_at IS NOT NULL AND ('.self::HAND_WAIT.' OR '.self::PKD('hd.at').'=?) ORDER BY k, o.dispatched_at', $this->pkToday());
        foreach ($rows as &$r) {
            $r['phone'] = $this->maskPhone($u, $r['phone']);
        }
        unset($r);
        return ['today' => $this->pkToday(), 'rows' => $rows, 'pickup' => $this->pxCfg()['pickupAddress'] ?: '', 'store' => $this->setting('store_name', 'SundayBazar')];
    }

    public function handedSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ids = array_slice(array_map(fn ($x) => self::str($x), is_array($b['ids'] ?? null) ? array_values($b['ids']) : []), 0, 1000);
        $this->need(count($ids) > 0, 'Select parcels first');
        $n = 0;
        $bad = [];
        $undo = self::t($b['undo'] ?? null);
        Db::tx(function () use ($ids, $undo, $u, &$n, &$bad) {
            foreach ($ids as $id) {
                $o = $this->getOrder($id);
                if (! $o || ! self::t($o['tracking']) || self::t($o['cancelled_at'])) {
                    $bad[] = $o ? $o['name'] : $id;
                    continue;
                }
                if ($undo) {
                    $n += Db::run('DELETE FROM cr_handed WHERE order_id=?', $o['id'])->changes;
                    continue;
                }
                if (Db::get('SELECT order_id FROM cr_handed WHERE order_id=?', $o['id'])) {
                    continue;
                }
                Db::run('INSERT INTO cr_handed(order_id,courier,tracking,user_id) VALUES(?,?,?,?)', $o['id'], Logic::courierKey($o['courier']), $o['tracking'], $u['id']);
                $n++;
            }
        });
        if ($n) {
            $this->log($u['id'], $undo ? 'couriers.handed.undo' : 'couriers.handed', 'orders', ['parcels' => $n, 'courier' => self::t($b['courier'] ?? null) ? $b['courier'] : null]);
        }
        return ['ok' => true, 'n' => $n, 'skipped' => $bad];
    }

    public function pxCities(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return Db::all('SELECT name FROM cr_px_cities WHERE delivery=1 AND norm LIKE ? ORDER BY name LIMIT 50', '%'.self::normCity($qs['q'] ?? '').'%');
    }

    public function pxCitiesSync(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->postex()->configured(), 'PostEx is not connected. Add the PostEx token in Settings → PostEx.');
        try {
            $n = $this->syncPxCities();
        } catch (\Throwable $e) {
            throw self::bad($e->getMessage());
        }
        $this->log($u['id'], 'couriers.sync', 'postex', ['kind' => 'cities', 'n' => $n]);
        return ['cities' => $n];
    }

    public function pxAddresses(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->postex()->configured(), 'PostEx is not connected. Add the PostEx token in Settings → PostEx first.');
        try {
            $j = $this->postex()->call('/v1/get-merchant-address');
        } catch (\Throwable $e) {
            throw self::bad($e->getMessage());
        }
        $out = [];
        foreach (self::arr(self::pick($j, 'dist', 'data')) as $a) {
            $x = ['code' => self::str(self::pick($a, 'addressCode', 'code') ?? ''), 'address' => self::str(self::pick($a, 'address') ?? ''), 'city' => self::str(self::pick($a, 'cityName', 'city') ?? ''), 'type' => self::str(self::pick($a, 'addressType') ?? '')];
            if ($x['code'] !== '') {
                $out[] = $x;
            }
        }
        return $out;
    }

    private function pdfOut(array $f, string $name, array $extra = []): Response
    {
        if (! empty($f['url'])) {
            return response('', 302, ['Location' => $f['url']] + $extra);
        }
        return response($f['pdf'], 200, ['Content-Type' => 'application/pdf', 'Content-Disposition' => "inline; filename=\"{$name}\"", 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'] + $extra);
    }

    private static function pxTns($list): array
    {
        return array_values(array_unique(array_values(array_filter(array_map('trim', explode(',', self::t($list) ? self::str($list) : ''))))));
    }

    /** airway bills: PostEx prints at most 10 per call -> ?tns=a,b,...&part=N gives batch N (header X-Parts = number of batches) */
    public function pxAwb(?array $u, array $b, array $p, array $qs, Request $req): Response
    {
        $tns = self::pxTns($qs['tns'] ?? '');
        $this->need(count($tns) > 0, 'No tracking numbers');
        $parts = self::batches($tns, 10);
        $pp = self::num($qs['part'] ?? null);
        $n = (int) max(0, min(count($parts) - 1, is_nan($pp) ? 0 : (int) $pp));
        try {
            $f = $this->postex()->send('GET', '/v1/get-invoice?trackingNumbers='.implode(',', array_map('rawurlencode', $parts[$n])), null, ['pdf' => true]);
        } catch (\Throwable $e) {
            throw self::bad($e->getMessage());
        }
        return $this->pdfOut($f, 'postex-airway-bills-'.($n + 1).'.pdf', ['X-Parts' => (string) count($parts)]);
    }

    public function pxLoadsheet(?array $u, array $b, array $p, array $qs, Request $req): array|Response
    {
        $tns = self::pxTns(implode(',', array_map(fn ($x) => is_array($x) || $x === null ? '' : self::str($x), is_array($b['tns'] ?? null) ? $b['tns'] : [])));
        $this->need(count($tns) > 0, 'No PostEx parcels selected');
        $pc = $this->pxCfg()['pickupCode'];
        $this->need(self::t($pc), 'Choose the PostEx pickup address in Couriers → Settings');
        try {
            $f = $this->postex()->send('POST', '/v2/generate-load-sheet', ['trackingNumbers' => $tns, 'pickupAddress' => $pc], ['pdf' => true]);
        } catch (\Throwable $e) {
            throw self::bad($e->getMessage());
        }
        $this->log($u['id'], 'couriers.loadsheet', 'postex', ['parcels' => count($tns)]);
        if (! empty($f['url'])) {
            return ['url' => $f['url']];
        }
        return $this->pdfOut($f, 'postex-load-sheet.pdf');
    }

    public function trackOrder(?array $u, array $b, array $p, array $qs, Request $req): ?array
    {
        $o = $this->getOrder($p['id']);
        $this->need($o && self::t($o['tracking']), 'No tracking number');
        $this->need(Logic::courierKey($o['courier']) === 'TCS', 'Only TCS parcels are tracked here');
        try {
            $this->tcsTrack($o);
        } catch (\Throwable $e) {
            throw self::bad($e->getMessage());
        }
        return Db::get('SELECT status, courier_status, courier_updated, courier_history FROM orders WHERE id=?', $o['id']);
    }

    public function parcels(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $k = in_array($qs['courier'] ?? null, self::COURIERS, true) ? $qs['courier'] : 'TCS';
        $bucket = $qs['bucket'] ?? null;
        $where = $bucket === 'open' ? "AND o.status IN ('dispatched','in_transit','out_for_delivery','attempted','returning')" : ($bucket === 'unpaid' ? "AND o.status='delivered' AND o.settled=0" : '');
        $rows = Db::all('SELECT o.id, o.name, o.cust_name, o.city, o.total, o.tracking, o.status, o.courier_status, o.courier_updated, o.courier_fee, o.courier_paid, o.settled, o.settled_at, o.dispatched_at, o.delivered_at,
          TIMESTAMPDIFF(DAY, o.dispatched_at, UTC_TIMESTAMP()) days FROM orders o WHERE '.self::CK."=? AND o.tracking IS NOT NULL {$where} ORDER BY o.dispatched_at DESC LIMIT 300", $k);
        return ['rows' => $rows];
    }

    public function label(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $o = $this->getOrder($p['id']);
        $this->need($o && self::t($o['tracking']), 'Not booked', 404);
        $t = $this->tcsCfg();
        $city = self::t($o['city_code']) ? Db::get('SELECT name FROM cr_tcs_cities WHERE code=?', $o['city_code']) : null;
        $w = self::num($t['weight'] ?? null);
        return ['order' => ['id' => $o['id'], 'name' => $o['name'], 'cust_name' => $o['cust_name'], 'phone' => $o['phone'], 'address' => $o['address'], 'city' => $city ? $city['name'] : $o['city'], 'total' => $o['total'], 'cod' => $o['courier_cod'] ?? $o['total'], 'tracking' => $o['tracking'], 'courier' => $o['courier'], 'dispatched_at' => $o['dispatched_at'], 'items' => $o['items']],
            'items' => Db::all('SELECT title, sku, qty FROM order_items WHERE order_id=?', $o['id']),
            'shipper' => ['name' => self::t($t['shipperName'] ?? null) ? $t['shipperName'] : $this->setting('store_name', 'SundayBazar'), 'address' => ($t['shipperAddress'] ?? '') ?: '', 'city' => ($t['shipperCity'] ?? '') ?: '', 'mobile' => ($t['shipperMobile'] ?? '') ?: '', 'account' => ($t['account'] ?? '') ?: ''],
            'service' => self::t($t['serviceCode'] ?? null) ? $t['serviceCode'] : 'O', 'weight' => self::t($w) ? self::n($w) : 1];
    }

    /* ---- rider runs (office) ---- */

    public function runsList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = [];
        $a = [];
        if (self::isDate($qs['from'] ?? null)) {
            $w[] = 'r.day>=?';
            $a[] = $qs['from'];
        }
        if (self::isDate($qs['to'] ?? null)) {
            $w[] = 'r.day<=?';
            $a[] = $qs['to'];
        }
        if (self::t($qs['rider'] ?? null)) {
            $w[] = 'r.rider_id=?';
            $a[] = (int) self::num($qs['rider']);
        }
        if (($qs['open'] ?? null) === '1') {
            $w[] = "r.status<>'closed'";
        }
        return Db::all("SELECT r.*, u.name rider, h.counted, h.diff, h.expected, COUNT(i.id) parcels, SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed, SUM(i.result IS NULL) pending,
          COALESCE(SUM(i.cod),0) cod, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected
        FROM cr_runs r LEFT JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id LEFT JOIN cr_handovers h ON h.run_id=r.id
        ".($w ? 'WHERE '.implode(' AND ', $w) : '').' GROUP BY r.id ORDER BY r.day DESC, r.id DESC LIMIT 200', ...$a);
    }

    public function runCreate(?array $u, array $b, array $p, array $qs, Request $req): ?array
    {
        return $this->createRun($b['rider_id'] ?? null, $b['day'] ?? null, $u, $b['note'] ?? null);
    }

    public function runGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow((int) $p['id']);
        $this->need($run, 'Run not found', 404);
        $items = $this->runItems($run['id']);
        foreach ($items as &$i) {
            $i['wa'] = Logic::waNumber($i['phone']);
            $i['reason_text'] = self::FAIL_REASONS[$i['reason'] ?? ''] ?? null;
        }
        unset($i);
        $ho = Db::get('SELECT h.*, us.name `user` FROM cr_handovers h LEFT JOIN users us ON us.id=h.user_id WHERE run_id=?', $run['id']);
        return ['run' => $run, 'items' => $items, 'summary' => $this->runSummary($items), 'handover' => $ho ?: null, 'reasons' => self::FAIL_REASONS, 'canCash' => $this->can($u, 'couriers') || $this->can($u, 'finance')];
    }

    public function runAdd(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow((int) $p['id']);
        $this->need($run, 'Run not found', 404);
        $src = self::t($b['codes'] ?? null) ? (is_array($b['codes']) ? array_values($b['codes']) : [$b['codes']]) : (self::t($b['code'] ?? null) ? [$b['code']] : []);
        $codes = array_values(array_filter(array_map(fn ($x) => trim(self::str($x)), $src), fn ($x) => $x !== ''));
        $this->need(count($codes) > 0, 'Scan or type an order number');
        $results = array_map(fn ($code) => ['code' => $code] + $this->addToRun($run, $this->getOrder($code), $u, self::t($b['force'] ?? null)), $codes);
        return ['results' => $results];
    }

    public function runRemove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $it = Db::get('SELECT * FROM cr_run_items WHERE id=? AND run_id=?', (int) self::num($b['item_id'] ?? null), (int) $p['id']);
        $this->need($it, 'Not in this run', 404);
        $run = $this->runRow($it['run_id']);
        $this->need($run['status'] !== 'closed', 'This run is closed');
        $this->need(! self::t($it['result']), 'The rider already marked this parcel — undo that first');
        Db::run('DELETE FROM cr_run_items WHERE id=?', $it['id']);
        $o = Db::get('SELECT * FROM orders WHERE id=?', $it['order_id']);
        $earlier = Db::get("SELECT i.* FROM cr_run_items i WHERE i.order_id=? AND i.back='kept' ORDER BY i.id DESC LIMIT 1", $o['id']);
        if ($earlier) {
            Db::run('UPDATE orders SET rider_run_id=?, courier_status=? WHERE id=?', $earlier['run_id'], $earlier['result'] === 'rescheduled' ? 'Rescheduled to '.$earlier['resched_to'] : 'Failed: '.(self::FAIL_REASONS[$earlier['reason'] ?? ''] ?? 'Other'), $o['id']);
            Logic::refreshOrder($o['id']);
        } else {
            $this->clearBooking($o);
        }
        $this->log($u['id'], 'couriers.run.remove', 'order:'.$o['id'], ['run' => (int) $run['id']]);
        return ['ok' => true];
    }

    private function sendOut(array $run): void
    {
        Db::run("UPDATE cr_runs SET status='out', out_at=? WHERE id=?", $this->pkNow(), $run['id']);
        foreach (Db::all('SELECT order_id FROM cr_run_items WHERE run_id=? AND result IS NULL', $run['id']) as $i) {
            Db::run("UPDATE orders SET courier_status='Out for delivery', courier_updated=? WHERE id=?", $this->isoNow(), $i['order_id']);
            Logic::refreshOrder($i['order_id']);
        }
    }

    public function runOut(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow((int) $p['id']);
        $this->need($run && $run['status'] === 'open', 'This run is not waiting to leave');
        $this->sendOut($run);
        $this->log($u['id'], 'couriers.run.out', 'rider_run:'.$run['id'], '');
        return ['ok' => true];
    }

    public function runDelete(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow((int) $p['id']);
        $this->need($run && $run['status'] === 'open', 'Only a run that has not left can be deleted');
        $this->need(! Db::get('SELECT id FROM cr_run_items WHERE run_id=?', $run['id']), 'Remove the parcels first');
        Db::run('DELETE FROM cr_runs WHERE id=?', $run['id']);
        $this->log($u['id'], 'couriers.run.delete', 'rider_run:'.$run['id'], '');
        return ['ok' => true];
    }

    public function itemResult(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $it = Db::get('SELECT * FROM cr_run_items WHERE id=?', (int) $p['id']);
        $this->need($it, 'Not found', 404);
        return $this->setResult($it, $u, $b);
    }

    public function runHandover(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'couriers') || $this->can($u, 'finance'), 'Your account does not have access to this', 403);
        $run = $this->runRow((int) $p['id']);
        $this->need($run, 'Run not found', 404);
        return $this->handoverRun($run, $u, $b);
    }

    public function ledger(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'couriers') || $this->can($u, 'finance'), 'Your account does not have access to this', 403);
        $rider = $qs['rider'] ?? null;
        $hos = Db::all('SELECT h.*, u.name rider, us.name `user`, r.day run_day FROM cr_handovers h LEFT JOIN users u ON u.id=h.rider_id LEFT JOIN users us ON us.id=h.user_id LEFT JOIN cr_runs r ON r.id=h.run_id
        '.(self::t($rider) ? 'WHERE h.rider_id=?' : '').' ORDER BY h.id DESC LIMIT 200', ...(self::t($rider) ? [(int) self::num($rider)] : []));
        $waiting = Db::all("SELECT r.id, r.day, u.name rider, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) collected, SUM(i.result IS NULL) pending FROM cr_runs r JOIN users u ON u.id=r.rider_id
        LEFT JOIN cr_run_items i ON i.run_id=r.id WHERE r.status<>'closed' GROUP BY r.id ORDER BY r.day");
        return ['riders' => $this->riderLedger($rider), 'handovers' => $hos, 'waiting' => $waiting];
    }

    public function riderFeesGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $m = $qs['month'] ?? '';
        return $this->riderFees(is_string($m) && preg_match('/^\d{4}-\d{2}$/', $m) ? $m : substr($this->pkToday(), 0, 7));
    }

    public function riderFeesApprove(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->can($u, 'finance') || $this->can($u, 'accounts_post') || self::isAdm($u), 'Only the owner or finance can approve rider pay', 403);
        $month = $b['month'] ?? '';
        $this->need(is_string($month) && preg_match('/^\d{4}-\d{2}$/', $month), 'Choose the month');
        $f = $this->riderFees($month);
        $rid = self::num($b['rider_id'] ?? null);
        $row = null;
        foreach ($f['rows'] as $x) {
            if ((float) $x['rider_id'] === $rid) {
                $row = $x;
                break;
            }
        }
        $this->need($row, 'No deliveries for this rider in '.$month);
        $this->need($row['amount'] > 0, $f['rate'] ? 'Nothing to pay' : 'Set the per-delivery fee in Couriers → Settings first');
        $A = $this->svc('accounts');
        $this->need($A, 'Accounts module not available');
        $date = self::monthEnd($month) < $this->pkToday() ? self::monthEnd($month) : $this->pkToday();
        $jid = $A->post(['date' => $date, 'memo' => "Rider delivery pay {$month} — {$row['rider']} ({$row['deliveries']} × Rs {$row['rate']})", 'source' => 'rider-fees', 'source_id' => "{$month}:{$row['rider_id']}",
            'lines' => [['account' => 'Shipping Exp', 'debit' => $row['amount']], ['account' => 'Accrued Expenses', 'credit' => $row['amount'], 'party' => $this->employeeParty($row['rider_id'])]]], $u['id']);
        Db::run('INSERT INTO cr_rider_fees(month,rider_id,deliveries,rate,amount,journal_id,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE deliveries=VALUES(deliveries), rate=VALUES(rate), amount=VALUES(amount), journal_id=VALUES(journal_id), approved_by=VALUES(approved_by), approved_at=VALUES(approved_at)', $month, $row['rider_id'], $row['deliveries'], $row['rate'], $row['amount'], $jid, $u['id']);
        $this->log($u['id'], 'couriers.fees.approve', 'rider:'.$row['rider_id'], ['month' => $month, 'amount' => $row['amount'], 'deliveries' => $row['deliveries']]);
        return ['ok' => true, 'journal' => $jid, 'amount' => $row['amount']];
    }

    public function dashboard(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $to = self::isDate($qs['to'] ?? null) ? $qs['to'] : $this->pkToday();
        $from = self::isDate($qs['from'] ?? null) ? $qs['from'] : self::addDays($to, -29);
        $this->need($from <= $to, 'From date is after To date');
        return $this->dashboardData($from, $to) + ['alerts' => $this->alerts($u ?? [])];
    }

    /* ---- rider app (the rider sees only his own parcels) ---- */

    private function myItem(array $u, $id): array
    {
        $it = Db::get('SELECT i.*, r.rider_id FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE i.id=?', (int) self::num($id));
        $this->need($it, 'Parcel not found', 404);
        $this->need((int) $it['rider_id'] === (int) $u['id'], 'This parcel is not on your run', 403);
        return $it;
    }

    public function riderToday(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $today = $this->pkToday();
        $runs = Db::all("SELECT id, day, status, out_at FROM cr_runs WHERE rider_id=? AND (day=? OR status<>'closed') ORDER BY day, id", $u['id'], $today);
        foreach ($runs as &$r) {
            $r['items'] = Db::all("SELECT i.id, i.seq, i.cod, i.result, i.collected, i.reason, i.note, i.resched_to, o.name, o.cust_name, o.phone, o.address, o.city, o.items,
            (SELECT GROUP_CONCAT(title SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text FROM cr_run_items i JOIN orders o ON o.id=i.order_id WHERE i.run_id=? ORDER BY i.seq", $r['id']);
            foreach ($r['items'] as &$i) {
                $i['wa'] = Logic::waNumber($i['phone']);
            }
            unset($i);
            $r['summary'] = $this->runSummary($r['items']);
            $r['handed'] = (bool) Db::get('SELECT id FROM cr_handovers WHERE run_id=?', $r['id']);
        }
        unset($r);
        $week = Db::get("SELECT SUM(i.result='delivered') delivered, SUM(i.result IN ('failed','rescheduled')) failed FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.day>=?", $u['id'], self::addDays($today, -6));
        return ['today' => $today, 'runs' => $runs, 'reasons' => self::FAIL_REASONS, 'week' => $week, 'cashWithMe' => self::r2(($this->riderLedger($u['id'])[0]['outstanding'] ?? 0) ?: 0)];
    }

    public function riderItem(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return $this->setResult($this->myItem($u, $p['id']), $u, $b);
    }

    public function riderStart(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $run = $this->runRow((int) $p['id']);
        $this->need($run, 'Run not found', 404);
        $this->need((int) $run['rider_id'] === (int) $u['id'], 'This is not your run', 403);
        if ($run['status'] === 'open') {
            $this->sendOut($run);
            $this->log($u['id'], 'rider.start', 'rider_run:'.$run['id'], '');
        }
        return ['ok' => true];
    }

    /* ================================================================ jobs, counts, alerts, activity */

    public function jobs(): array
    {
        return [
            ['name' => 'tcs-track', 'every' => 60, 'offset' => 20, 'run' => function () {
                if ($this->tcsConfigured()) {
                    try {
                        $this->syncTrack();
                    } catch (\Throwable $e) {
                        $this->syncLog('tcs', false, 'tracking: '.$e->getMessage());
                    }
                }
            }],
            ['name' => 'tcs-payments', 'every' => 60, 'offset' => 40, 'run' => function () {
                if (! $this->tcsConfigured() || ! self::t($this->tcsCfg()['customerNo'] ?? null)) {
                    return;
                }
                if (substr(self::str($this->setting('couriers_tcs_pay_at', '') ?: ''), 0, 10) === $this->pkToday() || substr($this->pkNow(), 11, 2) < '06') {
                    return;
                }
                try {
                    $this->syncPayments();
                } catch (\Throwable $e) {
                    $this->syncLog('tcs', false, 'payments: '.$e->getMessage());
                    $this->setSetting('couriers_tcs_pay_at', $this->pkNow());
                }
            }],
        ];
    }

    public function counts(array $u): array
    {
        $out = [];
        if ($this->can($u, 'couriers')) {
            $out['dispatch'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','picked','packed') AND tracking IS NULL AND cancelled_at IS NULL");
            $out['rider-runs'] = (int) Db::val("SELECT COUNT(*) n FROM cr_runs WHERE status<>'closed' AND day<?", $this->pkToday());
        }
        // the warehouse menu item is the Returns screen now (pick & pack live on the Dispatch desk): badge = returned parcels to receive
        if ($this->can($u, 'warehouse')) {
            $out['warehouse'] = (int) Db::val("SELECT COUNT(*) n FROM orders WHERE status='returned'");
        }
        if ($this->can($u, 'rider')) {
            $out['rider'] = (int) Db::val("SELECT COUNT(*) n FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.status<>'closed' AND i.result IS NULL", $u['id']);
        }
        return $out;
    }

    public function alerts(array $u): array
    {
        $out = [];
        if ($this->can($u, 'rider') && ! $this->can($u, 'couriers')) {
            $n = (int) Db::val("SELECT COUNT(*) n FROM cr_run_items i JOIN cr_runs r ON r.id=i.run_id WHERE r.rider_id=? AND r.status<>'closed' AND i.result IS NULL", $u['id']);
            if ($n) {
                $out[] = ['level' => 'info', 'text' => "You have {$n} parcel".($n > 1 ? 's' : '').' to deliver', 'href' => '#/rider'];
            }
            return $out;
        }
        if (! $this->can($u, 'couriers') && ! $this->can($u, 'finance')) {
            return $out;
        }
        $today = $this->pkToday();
        $st = $this->tcsState();
        if ($st['configured'] && $st['failing']) {
            $out[] = ['level' => 'bad', 'text' => 'TCS sync is failing: '.mb_substr((string) $st['last']['message'], 0, 120), 'href' => '#/couriers/settings'];
        }
        $late = Db::all("SELECT r.id, r.day, u.name rider, COALESCE(SUM(CASE WHEN i.result='delivered' THEN i.collected END),0) cash FROM cr_runs r JOIN users u ON u.id=r.rider_id LEFT JOIN cr_run_items i ON i.run_id=r.id
      WHERE r.status<>'closed' AND r.day<? GROUP BY r.id", $today);
        foreach (array_slice($late, 0, 3) as $r) {
            $out[] = ['level' => 'warn', 'text' => "{$r['rider']}: cash of {$r['day']} run not handed over yet (Rs ".number_format(Logic::jsRound($r['cash'])).')', 'href' => '#/rider-runs/run/'.$r['id']];
        }
        $sh = Db::get('SELECT COUNT(*) n, COALESCE(SUM(-diff),0) v FROM cr_handovers WHERE diff<0 AND day>=?', self::addDays($today, -7));
        if ($sh['n']) {
            $out[] = ['level' => 'warn', 'text' => "Rider cash short {$sh['n']} time".($sh['n'] > 1 ? 's' : '').' this week (Rs '.number_format(Logic::jsRound($sh['v'])).')', 'href' => '#/rider-runs/ledger'];
        }
        $stuck = (int) Db::val('SELECT COUNT(*) n FROM orders o WHERE '.self::CK."='TCS' AND status IN ('dispatched','in_transit','out_for_delivery','attempted') AND dispatched_at < (UTC_TIMESTAMP() - INTERVAL 6 DAY)");
        if ($stuck) {
            $out[] = ['level' => 'warn', 'text' => "{$stuck} TCS parcel".($stuck > 1 ? 's have' : ' has').' not been delivered in 6+ days', 'href' => '#/couriers/parcels/open'];
        }
        return $out;
    }

    public function activity(): array
    {
        return [
            'couriers.book' => 'Booked parcel (PostEx / TCS)', 'couriers.loadsheet' => 'Made PostEx load sheet', 'couriers.handed' => 'Handed parcels to courier', 'couriers.handed.undo' => 'Undid courier handover', 'couriers.tracking' => 'Entered tracking', 'couriers.cancel' => 'Cancelled booking', 'couriers.run' => 'Created rider run', 'couriers.run.add' => 'Put parcel on rider run',
            'couriers.run.remove' => 'Took parcel off rider run', 'couriers.run.out' => 'Sent rider out', 'couriers.handover' => 'Received rider cash', 'couriers.fees.approve' => 'Approved rider pay', 'couriers.settings' => 'Changed courier settings',
            'couriers.sync' => 'Synced courier data', 'rider.delivered' => 'Delivered parcel (rider)', 'rider.failed' => 'Delivery failed (rider)', 'rider.rescheduled' => 'Delivery rescheduled (rider)', 'rider.undo' => 'Undid delivery result', 'rider.start' => 'Started deliveries',
        ];
    }
}
