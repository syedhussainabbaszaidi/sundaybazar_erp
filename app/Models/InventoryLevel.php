<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Stock of one inventory item at one Shopify location. */
class InventoryLevel extends Model
{
    protected $table = 'inventory_levels';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    public function location() { return $this->belongsTo(ShopifyLocation::class, 'location_id'); }
}
