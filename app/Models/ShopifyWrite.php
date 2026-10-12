<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Audit of one ERP -> Shopify change. */
class ShopifyWrite extends Model
{
    protected $table = 'shopify_writes';

    public $timestamps = false;

    protected $guarded = [];

}
