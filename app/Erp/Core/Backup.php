<?php

namespace App\Erp\Core;

use App\Erp\Db;
use App\Erp\Settings;
use PDO;

/**
 * Daily database backup: a gzipped SQL dump of every table in storage/app/private/backups
 * (restore with phpMyAdmin → Import, or `mysql sundaybazar_erp < file.sql`). Keeps ERP_BACKUP_KEEP_DAYS files.
 */
class Backup
{
    public static function dir(): string
    {
        $d = (string) (config('erp.backup_dir') ?: storage_path('app/private/backups'));
        if (! is_dir($d)) {
            mkdir($d, 0775, true);
        }
        return $d;
    }

    /** @param string|null $name file name without .sql.gz (default: the daily sundaybazar-YYYY-MM-DD) */
    public static function run(?string $name = null): string
    {
        $day = gmdate('Y-m-d', time() + 5 * 3600);
        $file = self::dir().'/'.($name ? preg_replace('/[^A-Za-z0-9._-]/', '_', $name) : "sundaybazar-{$day}").'.sql.gz';
        $tmp = $file.'.part';
        $gz = gzopen($tmp, 'wb6');
        $pdo = Db::pdo();
        gzwrite($gz, "-- SundayBazar ERP backup ".gmdate('Y-m-d H:i:s')." UTC\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n");
        $tables = array_map(fn ($r) => array_values($r)[0], Db::all('SHOW TABLES'));
        foreach ($tables as $t) {
            $create = Db::get("SHOW CREATE TABLE `{$t}`");
            gzwrite($gz, "DROP TABLE IF EXISTS `{$t}`;\n".array_values($create)[1].";\n\n");
            if (in_array($t, ['sessions', 'cache', 'cache_locks', 'jobs', 'job_batches'], true)) {
                continue; // transient: the table, not its rows (a restore into an empty database still works)
            }
            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
            try {
                $st = $pdo->query("SELECT * FROM `{$t}`");
                $batch = [];
                while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
                    $batch[] = '('.implode(',', array_map(fn ($v) => $v === null ? 'NULL' : (is_int($v) || is_float($v) ? (string) $v : $pdo->quote((string) $v)), $row)).')';
                    if (count($batch) >= 200) {
                        gzwrite($gz, "INSERT INTO `{$t}` VALUES ".implode(",\n", $batch).";\n");
                        $batch = [];
                    }
                }
                if ($batch) {
                    gzwrite($gz, "INSERT INTO `{$t}` VALUES ".implode(",\n", $batch).";\n");
                }
                $st->closeCursor();
            } finally {
                $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
            }
            gzwrite($gz, "\n");
        }
        gzwrite($gz, "SET FOREIGN_KEY_CHECKS=1;\n");
        gzclose($gz);
        rename($tmp, $file);
        $keep = max(3, (int) config('erp.backup_keep_days', 30));
        $all = glob(self::dir().'/sundaybazar-*.sql.gz') ?: [];
        sort($all);
        foreach (array_slice($all, 0, max(0, count($all) - $keep)) as $old) {
            @unlink($old);
        }
        if (! $name) {
            Settings::set('backup_last', gmdate('Y-m-d H:i:s', time() + 5 * 3600));
        }
        return $file;
    }
}
