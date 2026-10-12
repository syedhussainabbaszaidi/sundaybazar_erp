<?php

namespace App\Erp;

use RuntimeException;

/** An error the API answers with { error: message, ...extra } and the given HTTP status. */
class HttpError extends RuntimeException
{
    public function __construct(public int $status, string $message, public array $extra = [])
    {
        parent::__construct($message);
    }
}
