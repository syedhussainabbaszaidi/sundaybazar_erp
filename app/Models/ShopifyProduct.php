<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify product (product level). */
class ShopifyProduct extends Model
{
    protected $table = 'shopify_products';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';

    public function variants() { return $this->hasMany(Product::class, 'product_id'); }

    public function media() { return $this->hasMany(ProductMedia::class, 'product_id'); }

    public function collections() { return $this->belongsToMany(ShopifyCollection::class, 'collection_product', 'product_id', 'collection_id'); }
}
