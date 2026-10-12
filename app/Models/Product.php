<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** One sellable variant (key = Shopify variant GID) with ERP rack/lot data. */
class Product extends Model
{
    protected $table = 'products';

    public $timestamps = false;

    protected $guarded = [];

    protected $primaryKey = 'variant_id';

    public $incrementing = false;

    protected $keyType = 'string';

    public function product() { return $this->belongsTo(ShopifyProduct::class, 'product_id'); }

    public function levels() { return $this->hasMany(InventoryLevel::class, 'inventory_item_id', 'inventory_item'); }
}
