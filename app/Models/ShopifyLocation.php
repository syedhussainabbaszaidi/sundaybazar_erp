<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify location (warehouse / outlet). */
class ShopifyLocation extends Model
{
    protected $table = 'shopify_locations';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';
}
