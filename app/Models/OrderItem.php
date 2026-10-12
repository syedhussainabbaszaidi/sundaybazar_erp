<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Order line item; picked/picked_by track warehouse picking. */
class OrderItem extends Model
{
    protected $table = 'order_items';

    public $timestamps = false;

    protected $guarded = [];

    public function order() { return $this->belongsTo(Order::class, 'order_id'); }

    public function variant() { return $this->belongsTo(Product::class, 'variant_id', 'variant_id'); }
}
