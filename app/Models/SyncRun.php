<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** One import/sync run with its resumable cursor. */
class SyncRun extends Model
{
    protected $table = 'sync_runs';

    public $timestamps = false;

    protected $guarded = [];

}
