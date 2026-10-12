<?php

namespace App\Services\Shopify;

use RuntimeException;

/** A Shopify API failure. $kind: auth, scope, throttled, network, graphql, user_errors, config */
class ShopifyException extends RuntimeException
{
    public function __construct(string $message, public string $kind = 'graphql', public ?int $httpStatus = null, public array $details = [])
    {
        parent::__construct($message);
    }

    /** True when retrying later may succeed (network blips, throttling, Shopify 5xx). */
    public function retryable(): bool
    {
        return in_array($this->kind, ['throttled', 'network'], true) || ($this->httpStatus !== null && $this->httpStatus >= 500);
    }
}
