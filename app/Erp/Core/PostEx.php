<?php

namespace App\Erp\Core;

use App\Erp\Activity;
use App\Erp\Db;
use App\Erp\Settings;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/** PostEx merchant API: parcel status, COD amounts, courier charges, settlement. */
class PostEx
{
    public function base(): string
    {
        return rtrim(config('services.postex.base_url') ?: 'https://api.postex.pk/services/integration/api/order', '/');
    }

    /** Token from .env (POSTEX_TOKEN) or, when empty, the one saved in Settings → PostEx. */
    public function token(): string
    {
        return (string) (config('services.postex.token') ?: ((Settings::get('postex', []) ?: [])['token'] ?? ''));
    }

    public function configured(): bool
    {
        return $this->token() !== '';
    }

    /** GET call; returns decoded JSON or throws RuntimeException('PostEx: ...') */
    public function call(string $path): array
    {
        try {
            $r = Http::withHeaders(['token' => $this->token()])->acceptJson()->timeout(30)->get($this->base().$path);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Cannot reach PostEx ('.$e->getMessage().')');
        }
        $j = json_decode($r->body(), true);
        if (! is_array($j)) {
            throw new RuntimeException('PostEx answered '.$r->status().': '.mb_substr($r->body(), 0, 120));
        }
        if (! $r->successful() || (isset($j['statusCode']) && (string) $j['statusCode'] !== '200')) {
            throw new RuntimeException('PostEx: '.($j['statusMessage'] ?? $r->status()));
        }
        return $j;
    }

    /**
     * Any PostEx call with a JSON body. opts: ['pdf' => true] when the answer may be a PDF
     * (airway bills, load sheet) -> ['pdf' => bytes, 'type' => 'application/pdf'] or ['url' => ...]
     */
    public function send(string $method, string $path, $body = null, array $opts = []): array
    {
        if (! $this->configured()) {
            throw new RuntimeException('PostEx is not connected. Add the PostEx token in Settings → PostEx.');
        }
        $headers = ['token' => $this->token(), 'Accept' => ! empty($opts['pdf']) ? 'application/pdf, application/json' : 'application/json'];
        try {
            $req = Http::withHeaders($headers)->timeout((int) (($opts['timeout'] ?? 30000) / 1000));
            $r = $body !== null ? $req->send($method, $this->base().$path, ['json' => $body]) : $req->send($method, $this->base().$path);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Cannot reach PostEx ('.(str_contains($e->getMessage(), 'timed out') ? 'no answer in 30 seconds' : $e->getMessage()).')');
        }
        $buf = $r->body();
        if (! empty($opts['pdf']) && $r->successful() && str_starts_with($buf, '%PDF')) {
            return ['pdf' => $buf, 'type' => 'application/pdf'];
        }
        $j = json_decode($buf, true);
        if (! is_array($j)) {
            throw new RuntimeException('PostEx answered '.$r->status().': '.mb_substr($buf, 0, 160));
        }
        if (! $r->successful() || (isset($j['statusCode']) && (string) $j['statusCode'] !== '200')) {
            throw new RuntimeException('PostEx: '.($j['statusMessage'] ?? $j['message'] ?? $j['error'] ?? ('error '.$r->status())));
        }
        if (! empty($opts['pdf'])) { // some accounts get the PDF as base64 inside JSON
            $dist = $j['dist'] ?? null;
            $d = is_string($dist) ? $dist : (is_array($dist) ? (self::pick($dist, 'pdf', 'file', 'data', 'invoice', 'loadSheet') ?? '') : '');
            if (is_string($d) && str_starts_with($d, 'JVBER')) {
                return ['pdf' => base64_decode($d), 'type' => 'application/pdf'];
            }
            if (is_string($d) && preg_match('#^https?://#', $d)) {
                return ['url' => $d];
            }
            throw new RuntimeException('PostEx did not send a PDF'.(! empty($j['statusMessage']) ? ': '.$j['statusMessage'] : ''));
        }
        return $j;
    }

    /** Read a field whatever its exact capitalisation */
    public static function pick($o, string ...$names)
    {
        if (! is_array($o)) {
            return null;
        }
        $map = [];
        foreach ($o as $k => $v) {
            $map[strtolower((string) $k)] = $v;
        }
        foreach ($names as $n) {
            $v = $map[strtolower($n)] ?? null;
            if ($v !== null && $v !== '') {
                return $v;
            }
        }
        return null;
    }

    private static function num($v): ?float
    {
        return ($v === null || $v === '' || ! is_numeric($v)) ? null : (float) $v;
    }

    public function applyTracking(array $t): bool
    {
        $tn = (string) (self::pick($t, 'trackingNumber') ?? '');
        if ($tn === '') {
            return false;
        }
        $ref = trim((string) (self::pick($t, 'orderRefNumber') ?? ''));
        $o = Db::get('SELECT id, px_status FROM orders WHERE tracking=?', $tn);
        // a booking cancelled in the ERP must not come back through its order number
        $cancelled = (bool) preg_match('/cancel/i', (string) (self::pick($t, 'transactionStatus', 'orderStatus', 'status') ?? ''));
        if (! $o && $ref !== '' && ! $cancelled) {
            $bare = ltrim($ref, '#');
            $o = Db::get('SELECT id, px_status FROM orders WHERE name=? OR name=? OR name=?', $ref, '#'.$bare, $bare);
            if ($o) {
                Db::run('UPDATE orders SET tracking=?, courier=COALESCE(courier,?) WHERE id=?', $tn, 'PostEx', $o['id']);
            }
        }
        if (! $o) {
            return false;
        }
        $hist = self::pick($t, 'transactionStatusHistory') ?? [];
        $last = is_array($hist) && $hist ? $hist[count($hist) - 1] : null;
        $status = self::pick($t, 'transactionStatus', 'orderStatus', 'status') ?? ($last ? self::pick($last, 'transactionStatusMessage', 'status') : null);
        $when = ($last ? self::pick($last, 'modifiedDatetime', 'updatedAt', 'dateTime') : null) ?? self::pick($t, 'transactionDate');
        Db::run('UPDATE orders SET px_status=COALESCE(?,px_status), px_updated=COALESCE(?,px_updated), px_history=COALESCE(?,px_history),
      cod=COALESCE(?,cod), px_fee=COALESCE(?,px_fee), px_tax=COALESCE(?,px_tax), px_rev_fee=COALESCE(?,px_rev_fee), px_rev_tax=COALESCE(?,px_rev_tax) WHERE id=?',
            $status === null ? null : mb_substr((string) $status, 0, 160), $when === null ? null : mb_substr((string) $when, 0, 40),
            is_array($hist) && $hist ? json_encode(array_slice($hist, -15), JSON_UNESCAPED_UNICODE) : null,
            self::num(self::pick($t, 'invoicePayment', 'codAmount')), self::num(self::pick($t, 'transactionFee')), self::num(self::pick($t, 'transactionTax')),
            self::num(self::pick($t, 'reversalFee')), self::num(self::pick($t, 'reversalTax')), $o['id']);
        Logic::refreshOrder($o['id']);
        return true;
    }

    /** All parcels booked in a date window, in one call per window */
    public function syncWindow(int $fromTs, int $toTs): int
    {
        $j = $this->call('/v1/get-all-order?orderStatusId=0&startDate='.gmdate('Y-m-d', $fromTs).'&endDate='.gmdate('Y-m-d', $toTs));
        $dist = $j['dist'] ?? null;
        $list = is_array($dist) && array_is_list($dist) ? $dist : ($dist ? [$dist] : []);
        $n = 0;
        Db::tx(function () use ($list, &$n) {
            foreach ($list as $row) {
                if (is_array($row) && $this->applyTracking(self::pick($row, 'trackingResponse') ?? $row)) {
                    $n++;
                }
            }
        });
        return $n;
    }

    public function trackOne(string $tn): bool
    {
        $j = $this->call('/v1/track-order/'.rawurlencode($tn));
        $d = $j['dist'] ?? null;
        $t = is_array($d) && array_is_list($d) ? ($d[0] ?? []) : ($d ?: []);
        return $this->applyTracking(array_merge(['trackingNumber' => $tn], is_array($t) ? $t : []));
    }

    public function paymentStatus(string $tn): array
    {
        $j = $this->call('/v1/payment-status/'.rawurlencode($tn));
        $dd = $j['dist'] ?? [];
        $d = is_array($dd) && array_is_list($dd) ? ($dd[0] ?? []) : ($dd ?: []);
        $sv = self::pick($d, 'settle', 'settled', 'isSettled', 'settlementStatus', 'paymentStatus');
        $settled = $sv === true || preg_match('/^(true|yes|settled|paid)$/i', (string) ($sv ?? ''));
        $date = self::pick($d, 'settlementDate', 'settledDate', 'paymentDate');
        $ref = self::pick($d, 'cprNumber', 'cprNumber_1', 'cpr', 'paymentReference');
        Db::run('UPDATE orders SET settled=?, settled_at=COALESCE(?,settled_at), settle_ref=COALESCE(?,settle_ref) WHERE tracking=?', $settled ? 1 : 0, $date ? mb_substr((string) $date, 0, 40) : null, $ref ? (string) $ref : null, $tn);
        return ['settled' => (bool) $settled, 'date' => $date, 'ref' => $ref, 'raw' => $d];
    }

    public function syncAll(?callable $onProgress = null): array
    {
        $days = (int) Settings::get('postex_days', 45);
        $n = 0;
        $errors = [];
        for ($back = 0; $back < $days; $back += 7) { // windows of 7 days
            $to = time() - $back * 86400;
            $from = time() - min($days, $back + 6) * 86400;
            try {
                $n += $this->syncWindow($from, $to);
            } catch (\Throwable $e) {
                $errors[] = $e->getMessage();
            }
            $onProgress && $onProgress($n);
        }
        // parcels still open that the window call did not cover: track one by one
        $open = Db::all('SELECT tracking FROM orders WHERE tracking IS NOT NULL AND status IN ('.Db::marks(Logic::OPEN_SHIP).")
      AND (px_updated IS NULL OR px_updated < DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL 6 HOUR, '%Y-%m-%d %H:%i:%s')) ORDER BY created_at DESC LIMIT 400", ...Logic::OPEN_SHIP);
        foreach ($open as $o) {
            try {
                if ($this->trackOne($o['tracking'])) {
                    $n++;
                }
            } catch (\Throwable $e) {
                $errors[] = $e->getMessage();
            }
        }
        if (Settings::get('postex_check_payments', true)) {
            foreach (Db::all("SELECT tracking FROM orders WHERE status='delivered' AND settled=0 AND tracking IS NOT NULL ORDER BY delivered_at DESC LIMIT 150") as $o) {
                try {
                    $this->paymentStatus($o['tracking']);
                } catch (\Throwable $e) {
                    $errors[] = $e->getMessage();
                }
            }
        }
        Logic::recomputeCustomers();
        $uniq = array_slice(array_values(array_unique($errors)), 0, 3);
        Activity::sync('postex', ! $uniq, $n.' parcels updated'.($uniq ? ' · errors: '.implode(' | ', $uniq) : ''));
        return ['n' => $n, 'errors' => $uniq];
    }
}
