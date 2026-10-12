<?php

namespace App\Erp;

/** Key/value settings stored as JSON in the `settings` table. */
class Settings
{
    public static function get(string $key, $default = null)
    {
        $r = Db::get('SELECT `value` FROM settings WHERE `key`=?', $key);
        if (! $r) {
            return $default;
        }
        $v = json_decode((string) $r['value'], true);
        return json_last_error() === JSON_ERROR_NONE ? $v : $r['value'];
    }

    public static function set(string $key, $value): void
    {
        Db::run('INSERT INTO settings(`key`,`value`) VALUES(?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)', $key, json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    public static function forget(string $key): void
    {
        Db::run('DELETE FROM settings WHERE `key`=?', $key);
    }
}
