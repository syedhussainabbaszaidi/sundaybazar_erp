<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Shopify customer record (needs protected customer data access). */
class ShopifyCustomer extends Model
{
    protected $table = 'shopify_customers';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';
}
