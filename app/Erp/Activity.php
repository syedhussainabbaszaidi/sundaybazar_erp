<?php

namespace App\Erp;

/** Audit trail (`events`) and integration log (`sync_log`). */
class Activity
{
    public static function log($userId, string $action, ?string $entity = null, $detail = null): void
    {
        Db::run(
            'INSERT INTO events(user_id,action,entity,detail,at) VALUES(?,?,?,?,UTC_TIMESTAMP())',
            $userId ?: null,
            mb_substr($action, 0, 120),
            $entity === null ? null : mb_substr($entity, 0, 190),
            is_string($detail) ? $detail : json_encode($detail ?? null, JSON_UNESCAPED_UNICODE)
        );
    }

    public static function sync(string $kind, bool $ok, $message): void
    {
        Db::run('INSERT INTO sync_log(kind,ok,message,at) VALUES(?,?,?,UTC_TIMESTAMP())', mb_substr($kind, 0, 80), $ok ? 1 : 0, mb_substr((string) $message, 0, 1000));
        $cut = Db::val('SELECT id FROM sync_log ORDER BY id DESC LIMIT 1 OFFSET 2000');
        if ($cut) {
            Db::run('DELETE FROM sync_log WHERE id<=?', $cut);
        }
    }
}
