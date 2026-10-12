<?php

namespace App\Services\Shopify;

use App\Erp\Settings;

/**
 * Creates the webhook subscriptions this ERP needs (shop-specific subscriptions via the Admin API),
 * pointing at {APP_URL}/api/hooks/shopify. The URL must be public HTTPS for Shopify to deliver.
 */
class WebhookRegistrar
{
    public function __construct(private ShopifyClient $shopify) {}

    public function callbackUrl(): string
    {
        return rtrim((string) (config('shopify.webhook_url') ?: config('app.url')), '/').'/api/hooks/shopify';
    }

    public function list(): array
    {
        $out = [];
        $after = null;
        do {
            $d = $this->shopify->gql('query($after:String){ webhookSubscriptions(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id topic uri } } }', ['after' => $after]);
            $c = $d['webhookSubscriptions'] ?? [];
            $out = array_merge($out, $c['nodes'] ?? []);
            $after = ! empty($c['pageInfo']['hasNextPage']) ? $c['pageInfo']['endCursor'] : null;
        } while ($after);
        return $out;
    }

    /** @return array{created: string[], existing: string[], failed: array<string,string>} */
    public function register(?string $url = null): array
    {
        $url = $url ?: $this->callbackUrl();
        if (! preg_match('#^https://#', $url)) {
            throw new ShopifyException("Webhooks need a public HTTPS address; {$url} is not one. Set APP_URL (or SHOPIFY_WEBHOOK_URL) to the https address of this server.", 'config');
        }
        $have = [];
        foreach ($this->list() as $w) {
            if (($w['uri'] ?? '') === $url) {
                $have[$w['topic']] = $w['id'];
            }
        }
        $res = ['created' => [], 'existing' => array_keys($have), 'failed' => []];
        foreach (config('shopify.webhook_topics') as $topic) {
            if (isset($have[$topic])) {
                continue;
            }
            try {
                $d = $this->shopify->gql('mutation($topic:WebhookSubscriptionTopic!,$sub:WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:$topic, webhookSubscription:$sub){ webhookSubscription{ id topic uri } userErrors{ field message } } }',
                    ['topic' => $topic, 'sub' => ['uri' => $url]]);
                ShopifyClient::assertNoUserErrors($d['webhookSubscriptionCreate'] ?? [], $topic);
                $res['created'][] = $topic;
            } catch (ShopifyException $e) {
                $res['failed'][$topic] = $e->getMessage(); // usually a missing scope for that topic
            }
        }
        Settings::set('shopify_webhooks', ['at' => gmdate('Y-m-d H:i:s'), 'url' => $url, 'topics' => array_merge($res['existing'], $res['created']), 'failed' => $res['failed']]);
        return $res;
    }

    public function removeAll(?string $url = null): int
    {
        $n = 0;
        foreach ($this->list() as $w) {
            if ($url === null || ($w['uri'] ?? '') === $url) {
                $d = $this->shopify->gql('mutation($id:ID!){ webhookSubscriptionDelete(id:$id){ deletedWebhookSubscriptionId userErrors{ field message } } }', ['id' => $w['id']]);
                ShopifyClient::assertNoUserErrors($d['webhookSubscriptionDelete'] ?? [], 'delete webhook');
                $n++;
            }
        }
        return $n;
    }
}
