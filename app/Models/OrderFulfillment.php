<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify fulfillment of an order with tracking. */
class OrderFulfillment extends Model
{
    protected $table = 'order_fulfillments';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';
}
