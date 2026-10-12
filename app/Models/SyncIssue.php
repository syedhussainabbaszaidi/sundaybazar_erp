<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Something the sync flagged for review. */
class SyncIssue extends Model
{
    protected $table = 'sync_issues';

    public $timestamps = false;

    protected $guarded = [];

}
