<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** A Shopify order (key = Shopify order GID) with ERP stage/status and courier data. */
class Order extends Model
{
    protected $table = 'orders';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';

    public function items() { return $this->hasMany(OrderItem::class, 'order_id'); }

    public function fulfillments() { return $this->hasMany(OrderFulfillment::class, 'order_id'); }

    public function refunds() { return $this->hasMany(OrderRefund::class, 'order_id'); }

    public function customer() { return $this->belongsTo(Customer::class, 'phone', 'phone'); }
}
