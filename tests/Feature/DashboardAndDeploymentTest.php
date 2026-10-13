<?php

namespace Tests\Feature;

use App\Erp\Db;
use App\Erp\Settings;
use Tests\TestCase;

/** Monthly money figures, profit goal, deployment safety (secrets, private files, database.sql, live -> local copy). */
class DashboardAndDeploymentTest extends TestCase
{
    private function order(string $id, array $f): void
    {
        $f += ['name' => '#'.$id, 'created_at' => gmdate('Y-m-d H:i:s'), 'total' => 1000, 'status' => 'new', 'stage' => 'new', 'gateway' => 'Cash on Delivery (COD)', 'phone' => '0300'.substr(md5($id), 0, 7)];
        $cols = array_keys($f);
        Db::run('INSERT INTO orders(id,'.implode(',', array_map(fn ($c) => "`$c`", $cols)).') VALUES(?,'.implode(',', array_fill(0, count($cols), '?')).')', $id, ...array_values($f));
    }

    public function test_monthly_money_is_calculated_once_per_order(): void
    {
        $now = gmdate('Y-m-d H:i:s');
        $lastMonth = gmdate('Y-m-d H:i:s', strtotime('first day of last month') + 86400);
        $this->order('o1', ['total' => 2000, 'status' => 'delivered', 'delivered_at' => $now]);                                         // COD delivered, not paid out
        $this->order('o2', ['total' => 3000, 'status' => 'delivered', 'delivered_at' => $now, 'settled' => 1]);                         // COD delivered and paid out
        $this->order('o3', ['total' => 1500, 'status' => 'in_transit']);                                                                // COD on the way
        $this->order('o4', ['total' => 4000, 'status' => 'new', 'gateway' => 'XPay - Credit Card', 'financial' => 'PAID', 'received' => 4000, 'outstanding' => 0]);
        $this->order('o5', ['total' => 2500, 'status' => 'new', 'gateway' => 'Bank Transfer', 'financial' => 'PARTIALLY_PAID', 'received' => 1000, 'outstanding' => 1500]);
        $this->order('o6', ['total' => 9999, 'status' => 'cancelled', 'cancelled_at' => $now]);                                        // cancelled: not counted
        $this->order('o7', ['total' => 7777, 'status' => 'delivered', 'delivered_at' => $lastMonth, 'created_at' => $lastMonth]);       // last month
        Db::run("INSERT INTO order_transactions(id,order_id,kind,status,gateway,amount,processed_at) VALUES('t1','o4','SALE','SUCCESS','xpay',4000,?),('t2','o5','SALE','SUCCESS','bank',1000,?),('t3','o5','SALE','FAILURE','bank',1500,?),('t4','o4','REFUND','SUCCESS','xpay',500,?)", $now, $now, $now, $now);
        Db::run("INSERT INTO order_refunds(id,order_id,amount,created_at) VALUES('r1','o4',500,?),('r0','o6',0,?)", $now, $now);

        $d = $this->actingAs($this->user())->getJson('/api/home')->assertOk()->json();
        $m = $d['money'];
        $this->assertSame(['n' => 5, 'v' => 13000], array_map(fn ($v) => $v + 0, $m['placed']), 'placed: o1..o5, not the cancelled one, not last month');
        $this->assertEquals(2, $m['delivered']['n']);
        $this->assertEquals(5000, $m['delivered']['v']);
        $this->assertEquals(5000, $m['delivered']['cod']);
        $this->assertEquals(5000, $m['online']['v'], 'successful sale transactions only');
        $this->assertEquals(2, $m['online']['n']);
        $this->assertEquals(['n' => 1, 'v' => 500], array_map(fn ($v) => $v + 0, $m['refunds']), 'zero-amount refund records (restocks) are not money');
        $this->assertEquals(2000 + 7777, $m['courierOwes']['v'], 'delivered COD not paid out (all months)');
        $this->assertTrue($m['courierOwes']['tracked'], 'payouts are tracked once any order is marked settled');
        $this->assertEquals(1500, $m['inTransit']['v']);
        $this->assertEquals(['n' => 1, 'v' => 1500], array_map(fn ($v) => $v + 0, $m['unpaid']));
        $this->assertSame('PKR', $m['currency']);
    }

    public function test_profit_goal_is_never_invented(): void
    {
        $this->artisan('erp:install'); // chart of accounts
        $this->actingAs($this->user());
        $d = $this->getJson('/api/home')->json();
        $this->assertNull($d['target'], 'no default goal');
        $this->assertFalse($d['accounts']['started']);
        $this->assertSame(0, $d['accounts']['postedMTD']);
        $this->api('POST', '/api/home/target', ['target' => 750000])->assertOk();
        $this->assertSame(750000, $this->getJson('/api/home')->json('target'));
    }

    public function test_no_secret_is_in_public_files_or_shipped_files(): void
    {
        $secrets = array_filter([(string) env('SHOPIFY_CLIENT_SECRET'), (string) env('DB_PASSWORD'), (string) env('APP_KEY'), (string) config('shopify.client_secret')], fn ($s) => strlen($s) >= 8);
        $files = array_merge(glob(public_path('erp/*')), [public_path('index.php'), base_path('database.sql'), base_path('.env.example'), base_path('.env.production.example'), base_path('README.md'), base_path('LIVE_SERVER_DEPLOYMENT_GUIDE.md')]);
        foreach ($files as $f) {
            if (! is_file($f)) {
                continue;
            }
            $c = file_get_contents($f);
            $this->assertDoesNotMatchRegularExpression('/shpss_[0-9a-f]{20,}|shpat_[0-9a-f]{20,}/', $c, basename($f).' contains a Shopify secret/token');
            foreach ($secrets as $s) {
                $this->assertStringNotContainsString($s, $c, basename($f).' contains a configured secret');
            }
        }
        $this->assertDoesNotMatchRegularExpression('/INSERT IGNORE INTO `users`|INSERT IGNORE INTO `settings`|INSERT IGNORE INTO `sessions`/', file_get_contents(base_path('database.sql')));
    }

    public function test_root_htaccess_blocks_private_files(): void
    {
        $h = file_get_contents(base_path('.htaccess'));
        $this->assertStringContainsString('Require all denied', $h);
        foreach (['env', 'sql', 'log'] as $ext) {
            $this->assertMatchesRegularExpression('/FilesMatch "[^"]*\b'.$ext.'\b/', $h);
        }
        $this->assertMatchesRegularExpression('#RewriteRule \^\((app\|bootstrap\|config\|database[^)]*storage[^)]*vendor[^)]*)\)#', $h);
        // the folder rule comes before the front controller, so /app/... can never reach index.php
        $this->assertLessThan(strpos($h, 'RewriteRule ^ index.php'), strpos($h, 'RewriteRule ^(app|'));
        // the deploy workflow writes the root index.php the rewrite points to
        $this->assertStringContainsString("__DIR__.'/vendor/autoload.php'", str_replace("__DIR__.'/../", "__DIR__.'/", file_get_contents(public_path('index.php'))));
    }

    public function test_database_sql_has_every_table_of_the_migrations(): void
    {
        $sql = file_get_contents(base_path('database.sql'));
        $tables = array_map(fn ($r) => array_values($r)[0], Db::all("SHOW FULL TABLES WHERE Table_type='BASE TABLE'"));
        $this->assertGreaterThan(100, count($tables));
        foreach ($tables as $t) {
            $this->assertStringContainsString("CREATE TABLE IF NOT EXISTS `{$t}`", $sql, "database.sql misses table {$t} (run php artisan erp:export-sql on a fresh database)");
        }
    }

    public function test_spa_routes_and_assets_work(): void
    {
        $this->actingAs($this->user());
        $html = $this->get('/admin')->assertOk()->getContent();
        foreach (['erp/pre.js', 'erp/app.js', 'erp/shopify.js', 'erp/access.js', 'erp/post.js', 'erp/app.css'] as $a) {
            $this->assertStringContainsString($a, $html);
            $this->assertFileExists(public_path($a));
        }
        $this->get('/dashboard')->assertOk();
        $this->getJson('/api/nope')->assertStatus(404)->assertJson(['error' => 'Not found']);
    }

    public function test_branding_fonts_and_store_size(): void
    {
        foreach (['sundaybazarlogo.png', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'site.webmanifest', 'erp/fonts/poppins-latin-400.woff2', 'erp/fonts/OFL.txt'] as $f) {
            $this->assertFileExists(public_path($f));
        }
        $this->assertGreaterThan(1000, filesize(public_path('favicon.ico')));
        $this->assertStringContainsString('font-family:"Poppins"', file_get_contents(public_path('erp/app.css')));
        foreach (['/login', '/register'] as $p) {
            $this->get($p)->assertOk()->assertSee('sundaybazarlogo.png')->assertSee('favicon.ico');
        }
        $this->actingAs($this->user());
        $this->get('/admin')->assertOk()->assertSee('favicon.ico')->assertSee('erp/fonts/poppins-latin-400.woff2');
        // store size on the home screen comes from the database (no invented figures)
        Db::run("INSERT INTO shopify_products(id,title,status) VALUES('gid://shopify/Product/1','A','ACTIVE'),('gid://shopify/Product/2','B','DRAFT')");
        $c = $this->getJson('/api/home')->assertOk()->json('catalog');
        $this->assertSame(1, $c['products']);
        $this->assertSame(0, $c['customers']);
    }

    public function test_snapshot_needs_the_token(): void
    {
        $this->get('/api/snapshot')->assertStatus(404); // off when no token is configured
        config(['erp.snapshot_token' => str_repeat('a', 40)]);
        $this->get('/api/snapshot', ['Authorization' => 'Bearer wrong'])->assertStatus(401);
        $r = $this->get('/api/snapshot', ['Authorization' => 'Bearer '.str_repeat('a', 40)]);
        $r->assertOk();
        $this->assertSame('application/gzip', $r->headers->get('Content-Type'));
    }

    public function test_pull_production_imports_a_snapshot_and_refuses_on_production(): void
    {
        $this->user();
        Settings::set('marker', 'from-live');
        $file = \App\Erp\Core\Backup::run();
        Settings::set('marker', 'local-change');
        $this->artisan('erp:pull-production', ['--yes' => true, '--file' => $file])->assertSuccessful();
        $this->assertSame('from-live', Settings::get('marker'));
        $this->app['env'] = 'production';
        $this->artisan('erp:pull-production', ['--yes' => true, '--file' => $file])->assertFailed();
    }
}
