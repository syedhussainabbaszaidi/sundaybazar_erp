<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** ERP customer view per phone number (rebuilt from orders). */
class Customer extends Model
{
    protected $table = 'customers';

    public $timestamps = false;

    protected $guarded = [];

    protected $primaryKey = 'phone';

    public $incrementing = false;

    protected $keyType = 'string';

    public function orders() { return $this->hasMany(Order::class, 'phone', 'phone'); }
}
