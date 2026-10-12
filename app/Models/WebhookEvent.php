<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Received Shopify webhook (deduplicated by webhook_id). */
class WebhookEvent extends Model
{
    protected $table = 'webhook_events';

    public $timestamps = false;

    protected $guarded = [];

}
