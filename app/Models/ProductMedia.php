<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Product image reference. */
class ProductMedia extends Model
{
    protected $table = 'product_media';

    public $timestamps = false;

    protected $guarded = [];

    public $incrementing = false;

    protected $keyType = 'string';
}
