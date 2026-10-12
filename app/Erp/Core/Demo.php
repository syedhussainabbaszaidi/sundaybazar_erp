<?php

namespace App\Erp\Core;

use App\Erp\Db;
use App\Erp\Settings;
use Illuminate\Support\Facades\Schema;

/**
 * Practice data (all invented) so staff can learn the ERP before the real store is connected
 * (port of legacy/server/lib/demo.js).
 *
 * Demo rows: orders/order_items/cs_calls/returns with order id 'demo-o…', products with variant 'demo-v…'
 * (product 'demo-p…', handle 'demo-…'), lots named 'DEMO-Lot NN', expenses noted '[demo] …'.
 * Only core tables are touched. load() ends with setting demo=true, clear() with demo=false.
 * Like the original, clear() also empties `locations` and `customer_flags`.
 */
class Demo
{
    private const DAY = 864e5;   // ms

    private const HOUR = 3600e3; // ms

    public static function clear(): void
    {
        Db::tx(function () {
            Db::run("DELETE FROM order_items WHERE order_id LIKE 'demo%'");
            Db::run("DELETE FROM orders WHERE id LIKE 'demo%'");
            Db::run("DELETE FROM products WHERE variant_id LIKE 'demo%'");
            if (Schema::hasTable('cs_calls')) {
                Db::run("DELETE FROM cs_calls WHERE order_id LIKE 'demo%'");
            }
            if (Schema::hasTable('returns')) {
                Db::run("DELETE FROM returns WHERE order_id LIKE 'demo%'");
            }
            Db::run("DELETE FROM lots WHERE name LIKE 'DEMO-%'");
            Db::run("DELETE FROM expenses WHERE note LIKE '[demo]%'");
            Db::run('DELETE FROM locations');
            Db::run('DELETE FROM customer_flags');
        });
        Settings::set('demo', false);
        Logic::recomputeCustomers();
    }

    /** @param int|null $nowMs fixed "now" in ms (tests); default: current time */
    public static function load(?int $nowMs = null): void
    {
        self::clear();
        $s = 42; // same Park-Miller generator and seed as the original
        $r = function () use (&$s): float {
            $s = ($s * 16807) % 2147483647;
            return $s / 2147483647;
        };
        $pick = fn (array $a) => $a[(int) floor($r() * count($a))];
        $int = fn (int $a, int $b): int => $a + (int) floor($r() * ($b - $a + 1));
        $brands = ['Zara', 'Bershka', 'Pull & Bear', 'Nike', 'Adidas', 'Skechers', 'Clarks', 'Mango', 'Stradivarius', 'Puma', 'Lefties', 'Oysho'];
        $types = [['B', 'Ankle Boots', 'Boots'], ['S', 'Sneakers', 'Shoes'], ['S', 'Loafers', 'Shoes'], ['H', 'Block Heels', 'Heels'], ['F', 'Flats', 'Flats'], ['D', 'Sandals', 'Sandals']];
        $conds = ['Excellent', 'Good', 'Fair'];
        $cities = ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Gujranwala', 'Sialkot', 'Hyderabad', 'Quetta', 'Bahawalpur'];
        $first = ['Ayesha', 'Fatima', 'Hira', 'Sana', 'Zainab', 'Maryam', 'Ali', 'Usman', 'Hamza', 'Bilal', 'Sara', 'Iqra', 'Nimra', 'Ahmed', 'Hassan', 'Mahnoor', 'Areeba', 'Saad'];
        $last = ['Khan', 'Malik', 'Butt', 'Sheikh', 'Qureshi', 'Raza', 'Iqbal', 'Hussain', 'Chaudhry', 'Mirza', 'Ansari', 'Siddiqui'];
        $racks = ['EA', 'EB', 'EC', 'ED', 'EE', 'EF', 'EG', 'EH'];
        $now = $nowMs ?? (int) floor(microtime(true) * 1000);
        $iso = fn ($ms) => gmdate('Y-m-d\TH:i:s', (int) floor($ms / 1000)).sprintf('.%03dZ', ((int) $ms) % 1000);

        Db::tx(function () use ($r, $pick, $int, $brands, $types, $conds, $cities, $first, $last, $racks, $now, $iso) {
            $serial = 90000;
            $products = [];
            // 8 lots, bought over the last ~4 months
            for ($li = 1; $li <= 8; $li++) {
                $lot = 'DEMO-Lot '.str_pad((string) $li, 2, '0', STR_PAD_LEFT);
                $listedAt = $now - (150 - $li * 18) * self::DAY;
                $pieces = $int(110, 140);
                $unit = $int(1200, 1900);
                Db::run('INSERT INTO lots(name,vendor,bought_on,cost,pieces,note,updated_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())',
                    $lot, $pick(['Vendor A', 'Vendor B', 'Vendor C']), substr($iso($listedAt - 6 * self::DAY), 0, 10), $pieces * $unit, $pieces, '[demo]');
                $listed = $pieces - ($li === 8 ? $int(15, 30) : 0);
                for ($k = 0; $k < $listed; $k++) {
                    $t = $pick($types);
                    $brand = $pick($brands);
                    $rack = $pick($racks);
                    $serial++;
                    $sku = "{$rack}-{$t[0]}-{$serial}";
                    $full = $int(30, 140) * 100 - 1;
                    $price = Logic::jsRound($full * 0.7 / 100) * 100 - 1;
                    $createdMs = $listedAt + $k * self::HOUR;
                    $p = ['variant_id' => 'demo-v'.$serial, 'product_id' => 'demo-p'.$serial, 'title' => $brand.' '.preg_replace('/s$/', '', $t[1]), 'sku' => $sku, 'rack' => $rack,
                        'category' => $t[0], 'price' => $price, 'compare_at' => $full, 'cost' => $unit, 'qty' => 1, 'created_at' => $iso($createdMs), 'created_ms' => $createdMs,
                        'lot' => $lot, 'brand' => $brand, 'ptype' => $t[1], 'size' => 'Euro '.$int(36, 44), 'cond' => $pick($conds)];
                    $products[] = $p;
                    Db::run("INSERT INTO products(variant_id,product_id,title,sku,rack,category,price,compare_at,cost,qty,status,created_at,updated_at,tags,lot,brand,ptype,size,cond,image,handle)
          VALUES(?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,?,?,'',?)", $p['variant_id'], $p['product_id'], $p['title'], $p['sku'], $p['rack'], $p['category'], $p['price'],
                        $p['compare_at'], $p['cost'], 1, $p['created_at'], $p['created_at'], implode(', ', [$t[2], $brand, $lot, $p['cond']]), $lot, $brand, $p['ptype'], $p['size'],
                        $p['cond'], 'demo-'.$serial);
                }
            }
            // customers: some loyal, some risky, many new
            $custs = [];
            for ($i = 0; $i < 260; $i++) {
                $a = $int(0, 4);
                $b = $int(0, 89999999);
                $custs[] = ['phone' => '03'.$a.str_pad(substr((string) (10000000 + $b), 0, 8), 8, '0', STR_PAD_LEFT), 'name' => $pick($first).' '.$pick($last),
                    'city' => $pick($cities), 'kind' => $i < 40 ? 'loyal' : ($i < 70 ? 'risky' : 'normal')];
            }
            $avail = $products;
            $num = 84000;
            for ($d = 59; $d >= 0; $d--) {
                $n = $d === 0 ? 14 : $int(6, 12);
                for ($k = 0; $k < $n && count($avail); $k++) {
                    $c = $r() < 0.35 ? $pick(array_slice($custs, 0, 70)) : $pick($custs);
                    $created = $now - $d * self::DAY - $int(0, 20) * self::HOUR;
                    if ($created > $now) {
                        continue;
                    }
                    $nItems = $r() < 0.85 ? 1 : 2;
                    $items = [];
                    for ($x = 0; $x < $nItems && count($avail); $x++) {
                        $el = [];
                        foreach ($avail as $z => $ap) {
                            if ($ap['created_ms'] < $created) {
                                $el[] = $z;
                            }
                        }
                        if (! $el) {
                            break;
                        }
                        $idx = $el[(int) floor(pow($r(), 1.6) * count($el))];
                        $items[] = array_splice($avail, $idx, 1)[0];
                    }
                    if (! $items) {
                        continue;
                    }
                    $id = 'demo-o'.(++$num);
                    $total = array_reduce($items, fn ($s, $p) => $s + $p['price'], 0) + 199;
                    $age = ($now - $created) / self::DAY;
                    $stage = 'new';
                    $tracking = null;
                    $px = null;
                    $cancelled = null;
                    $rdy = null;
                    $pDel = $c['kind'] === 'loyal' ? 0.95 : ($c['kind'] === 'risky' ? 0.35 : 0.72);
                    if ($age > 1.2) {
                        if ($r() < 0.06) {
                            $cancelled = $iso($created + self::HOUR);
                        } else {
                            $stage = 'packed';
                            $tracking = (string) (27000000000000 + $num);
                            if ($age > 6) {
                                $px = $r() < $pDel ? 'Delivered' : ($age > 12 ? 'Returned' : 'Out For Return');
                            } elseif ($age > 4) {
                                $px = $r() < 0.15 ? 'Attempted' : ($r() < $pDel ? 'Delivered' : 'Out For Delivery');
                            } else {
                                $px = $age > 2 ? 'PostEx WareHouse' : 'Booked';
                            }
                            $rdy = $iso($created + $int(10, 30) * self::HOUR);
                        }
                    } elseif ($age > 0.4) {
                        $stage = $r() < 0.5 ? 'confirmed' : ($r() < 0.5 ? 'hold' : 'new');
                    }
                    $pxAt = $px ? $iso(min($now, $created + ($px === 'Delivered' ? $int(3, 5) : ($px === 'Returned' ? $int(9, 12) : 2)) * self::DAY)) : null;
                    $address = 'House '.$int(1, 400).', Street '.$int(1, 40);
                    Db::run("INSERT INTO orders(id,name,created_at,updated_at,phone,cust_name,city,address,total,shipping,discount,items,gateway,financial,fulfillment,tags,cancelled_at,source,tracking,courier,stage,px_status,px_updated,
            px_fee,px_tax,px_rev_fee,dispatched_at,settled,cs_attempts) VALUES(?,?,?,?,?,?,?,?,?,199,0,?,?,?,?,?,?,'web',?,?,?,?,?,?,?,?,?,?,?)",
                        $id, 'SB'.$num, $iso($created), $iso($created), $c['phone'], $c['name'], $c['city'], $address, $total, count($items), 'Cash on Delivery (COD)', 'PENDING',
                        $tracking ? 'FULFILLED' : 'UNFULFILLED', $c['kind'] === 'loyal' ? 'courier: Trusted' : 'courier: New', $cancelled, $tracking, $tracking ? 'PostEx' : null, $stage,
                        $px, $pxAt, $px ? 250 : null, $px ? 15 : null, ($px && preg_match('/return/i', $px)) ? 150 : null, $rdy, ($px === 'Delivered' && $age > 12) ? 1 : 0,
                        $stage === 'hold' ? $int(1, 3) : 0);
                    $received = ($px === 'Returned' && $age > 18) ? $iso($created + 14 * self::DAY) : null;
                    if ($received) {
                        Db::run('UPDATE orders SET return_received_at=? WHERE id=?', $received, $id);
                    }
                    foreach ($items as $p) {
                        Db::run('INSERT INTO order_items(order_id,sku,title,qty,price,variant_id,product_id) VALUES(?,?,?,?,?,?,?)', $id, $p['sku'], $p['title'], 1, $p['price'], $p['variant_id'], $p['product_id']);
                        if (! $cancelled && ! $received) {
                            Db::run('UPDATE products SET qty=0, sold_at=? WHERE variant_id=?', $iso($created), $p['variant_id']);
                        }
                    }
                }
            }
            // expenses for this and last month
            foreach ([0, 1] as $m) {
                $ym = substr($iso($now - $m * 30 * self::DAY), 0, 7);
                foreach ([['Salaries', 420000], ['Rent', 120000], ['Ads (Meta)', 380000], ['Electricity & internet', 45000], ['Packaging', 30000]] as [$cat, $amt]) {
                    Db::run('INSERT INTO expenses(day,category,amount,note) VALUES(?,?,?,?)', $ym.'-05', $cat, $amt, '[demo] sample');
                }
            }
        });
        foreach (Db::all("SELECT id FROM orders WHERE id LIKE 'demo%'") as $o) {
            Logic::refreshOrder($o['id']);
        }
        Logic::recomputeCustomers();
        foreach (Db::all("SELECT id FROM orders WHERE id LIKE 'demo%' AND stage='new'") as $o) {
            Logic::refreshOrder($o['id']);
        }
        Settings::set('demo', true);
    }
}
