<?php

namespace App\Services\Shopify;

use Illuminate\Http\Request;

/**
 * Shopify webhook signature check: X-Shopify-Hmac-Sha256 must equal
 * base64(HMAC-SHA256(raw body, app client secret)). Webhooks created by hand in the
 * Shopify admin are signed with a different key (SHOPIFY_WEBHOOK_SECRET), accepted too.
 */
class WebhookVerifier
{
    public function secrets(): array
    {
        return array_values(array_filter([(string) config('shopify.client_secret'), (string) config('shopify.webhook_secret')]));
    }

    public function valid(Request $req): bool
    {
        return $this->validRaw($req->getContent(), (string) $req->header('X-Shopify-Hmac-Sha256'));
    }

    public function validRaw(string $raw, string $sent): bool
    {
        if ($sent === '') {
            return false;
        }
        foreach ($this->secrets() as $secret) {
            if (hash_equals(base64_encode(hash_hmac('sha256', $raw, $secret, true)), $sent)) {
                return true;
            }
        }
        return false;
    }
}
