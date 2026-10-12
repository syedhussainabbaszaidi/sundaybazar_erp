<?php

namespace App\Erp;

use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\DB as LaravelDB;
use PDO;
use PDOStatement;

/**
 * Raw-SQL helper used by the ERP modules (the PHP twin of the old `q` object).
 *
 *   Db::all($sql, ...$args)  -> list of rows (assoc arrays)
 *   Db::get($sql, ...$args)  -> first row or null
 *   Db::val($sql, ...$args)  -> first column of the first row or null
 *   Db::run($sql, ...$args)  -> object { changes, lastInsertRowid }
 *   Db::tx(fn)               -> runs fn inside a transaction (nested = savepoint)
 *
 * Numbers come back as PHP int/float (MySQL DECIMAL aggregates such as SUM() are
 * converted), so the JSON the browser receives keeps numeric types.
 * ISO-8601 timestamps passed as parameters ("2025-01-02T03:04:05Z") are stored as
 * UTC "Y-m-d H:i:s" so they fit DATETIME columns.
 */
class Db
{
    private const ISO = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/';

    public static function pdo(): PDO
    {
        return LaravelDB::connection()->getPdo();
    }

    public static function all(string $sql, ...$args): array
    {
        $st = self::exec($sql, $args);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        return self::fix($st, $rows);
    }

    public static function get(string $sql, ...$args): ?array
    {
        $st = self::exec($sql, $args);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            $st->closeCursor();
            return null;
        }
        $row = self::fix($st, [$row])[0]; // reads column metadata: before closing the cursor
        $st->closeCursor();
        return $row;
    }

    public static function val(string $sql, ...$args)
    {
        $r = self::get($sql, ...$args);
        return $r ? reset($r) : null;
    }

    public static function run(string $sql, ...$args): object
    {
        $st = self::exec($sql, $args);
        $n = $st->rowCount();
        $st->closeCursor();
        return (object) ['changes' => $n, 'lastInsertRowid' => (int) self::pdo()->lastInsertId()];
    }

    /** Several statements without parameters (DDL, maintenance). */
    public static function script(string $sql): void
    {
        LaravelDB::unprepared($sql);
    }

    public static function tx(callable $fn)
    {
        return LaravelDB::transaction(fn () => $fn());
    }

    /** "?,?,?" for an IN (...) list */
    public static function marks(array $list): string
    {
        return implode(',', array_fill(0, max(1, count($list)), '?'));
    }

    public static function normalize($v)
    {
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_string($v) && strlen($v) <= 40 && preg_match(self::ISO, $v)) {
            try {
                return (new DateTimeImmutable($v))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
            } catch (\Throwable) {
                return $v;
            }
        }
        if (is_array($v) || is_object($v)) {
            return json_encode($v, JSON_UNESCAPED_UNICODE);
        }
        return $v;
    }

    private static function exec(string $sql, array $args): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $i = 1;
        foreach ($args as $v) {
            $v = self::normalize($v);
            $type = is_int($v) ? PDO::PARAM_INT : ($v === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            if (is_float($v)) {
                $v = self::floatStr($v);
            }
            $st->bindValue($i++, $v, $type);
        }
        $st->execute();
        return $st;
    }

    private static function floatStr(float $f): string
    {
        if (is_nan($f) || is_infinite($f)) {
            return '0';
        }
        return json_encode($f); // shortest exact form, e.g. 0.5322102219368607 (MySQL accepts 1.0e-7 too)
    }

    /** DECIMAL columns (SUM/AVG results) come back from PDO as strings: turn them into numbers. */
    private static function fix(PDOStatement $st, array $rows): array
    {
        if (! $rows) {
            return $rows;
        }
        $dec = [];
        $n = $st->columnCount();
        for ($i = 0; $i < $n; $i++) {
            $m = @$st->getColumnMeta($i);
            if ($m && in_array(strtoupper($m['native_type'] ?? ''), ['NEWDECIMAL', 'DECIMAL'], true)) {
                $dec[] = $m['name'];
            }
        }
        if (! $dec) {
            return $rows;
        }
        foreach ($rows as &$r) {
            foreach ($dec as $c) {
                if (isset($r[$c]) && is_string($r[$c]) && is_numeric($r[$c])) {
                    $f = (float) $r[$c];
                    $r[$c] = (floor($f) == $f && abs($f) < PHP_INT_MAX && ! str_contains($r[$c], 'e')) ? (int) $f : $f;
                }
            }
        }
        return $rows;
    }
}
