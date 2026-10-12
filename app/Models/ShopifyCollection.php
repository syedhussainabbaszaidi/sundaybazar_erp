<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify collection. */
class ShopifyCollection extends Model
{
    protected $table = 'shopify_collections';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';

    public function products() { return $this->belongsToMany(ShopifyProduct::class, 'collection_product', 'collection_id', 'product_id'); }
}
