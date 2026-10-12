<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify refund of an order (read-only copy). */
class OrderRefund extends Model
{
    protected $table = 'order_refunds';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';
}
