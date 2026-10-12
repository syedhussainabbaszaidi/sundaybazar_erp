<?php

namespace Tests\Feature;

use Tests\TestCase;

/** POST /deploy-hook: off without ERP_DEPLOY_TOKEN, refuses a wrong token, runs migrate + erp:install with the right one. */
class DeployHookTest extends TestCase
{
    public function test_hook_is_off_without_a_token(): void
    {
        config(['erp.deploy_token' => '']);
        $this->post('/deploy-hook', [], ['X-Deploy-Token' => ''])->assertNotFound();
    }

    public function test_hook_refuses_a_wrong_or_missing_token(): void
    {
        config(['erp.deploy_token' => str_repeat('a', 40)]);
        $this->post('/deploy-hook')->assertForbidden();
        $this->post('/deploy-hook', [], ['X-Deploy-Token' => str_repeat('b', 40)])->assertForbidden();
    }

    public function test_hook_is_post_only(): void
    {
        config(['erp.deploy_token' => str_repeat('a', 40)]);
        $this->get('/deploy-hook', ['X-Deploy-Token' => str_repeat('a', 40)])->assertStatus(405);
    }

    public function test_hook_runs_with_the_right_token(): void
    {
        config(['erp.deploy_token' => str_repeat('a', 40)]);
        $this->post('/deploy-hook', [], ['X-Deploy-Token' => str_repeat('a', 40)])
            ->assertOk()->assertJson(['ok' => true]);
    }
}
