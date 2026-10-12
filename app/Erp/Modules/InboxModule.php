<?php

namespace App\Erp\Modules;

use App\Erp\Access;
use App\Erp\Db;
use App\Erp\Defer;
use App\Erp\HttpError;
use App\Erp\Module;
use App\Erp\Router;
use App\Erp\Core\Logic;
use Illuminate\Database\QueryException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

/**
 * Messages inbox (port of modules/inbox.js): WhatsApp (CEQUENS), Instagram DMs + comments (Meta Graph API),
 * Google Form exchange requests, automatic WhatsApp messages (order confirmation with YES/NO buttons,
 * dispatched, delivery attempted, delivered, exchange & refund updates) and the YES/NO confirmation bot.
 */
class InboxModule extends Module
{
    public string $name = 'inbox';

    private const CHANNEL_L = ['wa' => 'WhatsApp', 'ig' => 'Instagram DM', 'igc' => 'Instagram comment', 'form' => 'Google Form'];
    private const TICKET_CH = ['wa' => 'WhatsApp', 'ig' => 'Instagram', 'igc' => 'Instagram', 'form' => 'Google Form'];
    private const TICKET_TYPES = ['Size exchange', 'Order inquiry', 'Wrong item', 'Damaged / not as described', 'Return request', 'Refund', 'Delivery issue', 'Complaint about staff', 'Other'];
    private const ST_RANK = ['pending' => 0, 'accepted' => 1, 'sent' => 2, 'delivered' => 3, 'read' => 4];
    private const CEQUENS_URL = 'https://apis.cequens.com/conversation/wab/v1/messages';

    // Templates the owner must get approved in the CEQUENS / Meta console. {{n}} = parameter n.
    private const DEF_TEMPLATES = [
        ['name' => 'order_confirmation', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}', '{items}', '{total}'], 'buttons' => ['Yes, confirm', 'No, cancel'],
            'text' => 'Assalam o Alaikum {{1}}! SundayBazar se aap ka order {{2}} mila hai: {{3}}. Total Rs {{4}} (cash on delivery). Kya hum ye order bhej dein? Neeche button dabayein.'],
        ['name' => 'order_dispatched', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}', '{courier}', '{tracking}'],
            'text' => '{{1}}, aap ka SundayBazar order {{2}} {{3}} ke zariye bhej diya gaya hai. Tracking number: {{4}}. Rider call kare to please receive kar lijiye ga.'],
        ['name' => 'delivery_attempted', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}', '{courier}', '{tracking}'],
            'text' => '{{1}}, {{3}} rider aap ka order {{2}} deliver karne aaya tha lekin aap se rabta nahi ho saka (tracking {{4}}). Kya hum dobara bhejwa dein? Please reply karein.'],
        ['name' => 'order_delivered', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}'],
            'text' => 'Shukriya {{1}}! Aap ka order {{2}} deliver ho gaya hai. Shoes kaise lage? Apna review zaroor share karein.'],
        ['name' => 'exchange_update', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}', '{step}'],
            'text' => '{{1}}, aap ke order {{2}} ke exchange ka status: {{3}}. Koi sawal ho to isi number par message karein.'],
        ['name' => 'refund_paid', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}', '{amount}'],
            'text' => '{{1}}, order {{2}} ka refund Rs {{3}} bhej diya gaya hai. Please check kar ke confirm kar dein.'],
        ['name' => 'exchange_request_received', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}', '{order}'],
            'text' => '{{1}}, aap ki exchange request (order {{2}}) humein mil gayi hai. Hamari team jald aap se rabta karegi.'],
        ['name' => 'customer_care_followup', 'lang' => 'en', 'category' => 'Utility', 'params' => ['{name}'],
            'text' => 'Assalam o Alaikum {{1}}! SundayBazar customer care. Aap ke message ka jawab dene ke liye please is message ka reply karein.'],
    ];

    private const DEF_QUICK = [
        ['title' => 'Greeting', 'body' => 'Assalam o Alaikum {name}! SundayBazar customer care. Main aap ki kya madad kar sakti hoon?'],
        ['title' => 'Order status', 'body' => '{name}, aap ka order {order} raste mein hai. Tracking: {tracking}. Rider call kare to please receive kar lijiye ga.'],
        ['title' => 'Ask order number', 'body' => 'Please apna order number (jaise SB84561) ya order wala phone number bhej dein.'],
        ['title' => 'Exchange form', 'body' => 'Size exchange ke liye please ye form fill kar dein, hamari team 24 ghante mein rabta karegi.'],
        ['title' => 'Thank you', 'body' => 'Shukriya {name}! Koi aur sawal ho to zaroor batayein.'],
    ];

    private const RULES = [
        'confirm' => ['label' => 'Order confirmation (YES / NO buttons)', 'on' => true, 'template' => 'order_confirmation', 'params' => ['{name}', '{order}', '{items}', '{total}'], 'payloads' => true],
        'dispatched' => ['label' => 'Dispatched with tracking', 'on' => true, 'template' => 'order_dispatched', 'params' => ['{name}', '{order}', '{courier}', '{tracking}']],
        'attempted' => ['label' => 'Delivery attempted', 'on' => true, 'template' => 'delivery_attempted', 'params' => ['{name}', '{order}', '{courier}', '{tracking}']],
        'delivered' => ['label' => 'Delivered: thank you / review', 'on' => false, 'template' => 'order_delivered', 'params' => ['{name}', '{order}']],
        'exchange' => ['label' => 'Exchange updates', 'on' => true, 'template' => 'exchange_update', 'params' => ['{name}', '{order}', '{step}']],
        'refund' => ['label' => 'Refund paid', 'on' => true, 'template' => 'refund_paid', 'params' => ['{name}', '{order}', '{amount}']],
    ];

    private const EX_STEP = ['approved' => 'Approved - rider purana pair le jayega', 'dispatched' => 'Naya pair bhej diya gaya hai', 'completed' => 'Exchange mukammal ho gaya'];
    private const YES = ['yes', 'y', 'yess', 'yes confirm', 'confirm', 'confirmed', 'haan', 'han', 'haa', 'ha', 'hn', 'ji', 'jee', 'g', 'ok', 'okay', 'theek', 'thik', 'sure', 'done', 'ہاں', 'جی', 'ہان'];
    private const NO = ['no', 'n', 'nope', 'cancel', 'cancelled', 'nahi', 'nahin', 'nai', 'na', 'nhi', 'mat', 'نہیں', 'نہ', 'nahi chahiye'];
    private const FILLER = ['please', 'plz', 'pls', 'sir', 'madam', 'jee', 'ji', 'kar', 'karo', 'karein', 'karen', 'do', 'den', 'dein', 'bhej', 'bhejo', 'bhejein', 'order', 'it', 'the', 'thanks', 'shukriya', 'hai', 'he', 'hy', 'ye'];

    private const FIELDS = ['order', 'phone', 'name', 'current', 'wanted', 'reason', 'address', 'photos'];
    private const FIELD_L = ['order' => 'Order number', 'phone' => 'Phone', 'name' => 'Customer name', 'current' => 'Current size / SKU', 'wanted' => 'Wanted size', 'reason' => 'Reason', 'address' => 'Address', 'photos' => 'Photos link'];
    private const GUESS = [['order', '/order|invoice/i'], ['phone', '/phone|mobile|whats ?app|contact|cell/i'], ['photos', '/photo|picture|image|pic|upload/i'], ['wanted', '/want|new size|required size|desired|need|exchange (to|with)|replace/i'],
        ['current', '/current|received|ordered|old size|sku|purchased/i'], ['reason', '/reason|why|problem|issue|comment/i'], ['address', '/address/i'], ['name', '/name/i']];

    /** auto-message candidates of the current run, by ib_auto_log id (JS CAND map) */
    private array $cand = [];

    /** ib_msgs id of the last failed WhatsApp send (JS e.msgId) */
    private ?int $failedMsgId = null;

    public function perms(): array
    {
        return []; // inbox, inbox_wa, inbox_ig, inbox_admin are core permissions
    }

    public function install(): void
    {
        $wa = $this->arr($this->setting('inbox.wa', null));
        if (empty($wa['key'])) {
            $this->setSetting('inbox.wa', array_merge($wa, ['key' => $this->rnd(16)]));
        }
        $ig = $this->arr($this->setting('inbox.ig', null));
        if (empty($ig['verifyToken'])) {
            $this->setSetting('inbox.ig', array_merge($ig, ['verifyToken' => 'sb-'.$this->rnd(10)]));
        }
        $fm = $this->arr($this->setting('inbox.form', null));
        if (empty($fm['key'])) {
            $this->setSetting('inbox.form', array_merge($fm, ['key' => $this->rnd(16)]));
        }
    }

    public function routes(Router $r): void
    {
        $r->post('/api/hooks/cequens', null, 'hookCequens');
        $r->get('/api/hooks/cequens', null, 'hookCequensPing');
        $r->get('/api/hooks/instagram', null, 'hookInstagramVerify');
        $r->post('/api/hooks/instagram', null, 'hookInstagram');
        $r->post('/api/hooks/google-form', null, 'hookGoogleForm');
        $r->get('/api/inbox/meta', 'inbox', 'meta');
        $r->get('/api/inbox', 'inbox', 'listConvs');
        $r->get('/api/inbox/c/:id', 'inbox', 'showConv');
        $r->post('/api/inbox/c/:id/reply', 'inbox', 'reply');
        $r->post('/api/inbox/c/:id/assign', 'inbox', 'assign');
        $r->post('/api/inbox/c/:id/status', 'inbox', 'setStatus');
        $r->post('/api/inbox/c/:id/phone', 'inbox', 'setPhone');
        $r->post('/api/inbox/c/:id/ticket', 'inbox', 'makeTicket');
        $r->post('/api/inbox/open-wa', 'inbox', 'openWa');
        $r->get('/api/inbox/settings', 'inbox_admin', 'settingsGet');
        $r->post('/api/inbox/settings', 'inbox_admin', 'settingsSave');
        $r->post('/api/inbox/settings/test-wa', 'inbox_admin', 'testWa');
        $r->post('/api/inbox/settings/test-ig', 'inbox_admin', 'testIg');
        $r->get('/api/inbox/hooks', 'inbox_admin', 'hooksList');
        $r->post('/api/inbox/auto/run', 'inbox_admin', 'autoRun');
        $r->get('/api/inbox/auto/log', 'inbox_admin', 'autoLog');
    }

    public function jobs(): array
    {
        return [['name' => 'auto-whatsapp', 'every' => 5, 'offset' => 2, 'run' => fn () => $this->runAuto(false)]];
    }

    public function activity(): array
    {
        return [
            'inbox.reply' => 'Replied to customer (inbox)', 'inbox.template' => 'Sent WhatsApp template', 'inbox.assign' => 'Assigned conversation', 'inbox.close' => 'Closed conversation',
            'inbox.reopen' => 'Reopened conversation', 'inbox.status' => 'Changed conversation status', 'inbox.ticket' => 'Created ticket from inbox', 'inbox.link' => 'Linked phone to conversation',
            'inbox.settings' => 'Changed messaging settings', 'inbox.autorun' => 'Ran auto WhatsApp messages', 'inbox.bot' => 'WhatsApp bot handled a reply', 'inbox.form' => 'Form exchange request received',
        ];
    }

    /* ================================================================ JS helpers */

    private function rnd(int $n): string
    {
        return bin2hex(random_bytes($n));
    }

    private function arr($v): array
    {
        return is_array($v) ? $v : [];
    }

    /** new Date(ms).toISOString() as 'Y-m-d H:i:s' (UTC) */
    private function utc(?float $ms = null): string
    {
        return gmdate('Y-m-d H:i:s', (int) floor(($ms ?? microtime(true) * 1000) / 1000));
    }

    private function nowMs(): float
    {
        return floor(microtime(true) * 1000);
    }

    /** Date.parse of a stored UTC timestamp, in ms (null = NaN) */
    private function parseUtc($s): ?float
    {
        if ($s === null || $s === '') {
            return null;
        }
        $s = (string) $s;
        if (! preg_match('/Z|[+-]\d\d:?\d\d$/', $s)) {
            $s = str_replace(' ', 'T', $s).'Z';
        }
        try {
            $d = new \DateTimeImmutable($s);
        } catch (\Throwable) {
            return null;
        }
        return (float) $d->format('U') * 1000 + (int) $d->format('v');
    }

    /** JS truthiness */
    private function truthy($v): bool
    {
        return ! ($v === null || $v === false || $v === 0 || $v === 0.0 || $v === '');
    }

    /** JS String(x) */
    private function jsStr($v): string
    {
        if ($v === null) {
            return '';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_array($v)) {
            return array_is_list($v) ? implode(',', array_map(fn ($x) => $x === null ? '' : $this->jsStr($x), $v)) : '[object Object]';
        }
        if (is_float($v) && floor($v) == $v && abs($v) < 1e15) {
            return (string) (int) $v;
        }
        return (string) $v;
    }

    /** JS template literal of a possibly missing value (undefined -> 'undefined') */
    private function tl($v): string
    {
        return $v === null ? 'undefined' : $this->jsStr($v);
    }

    /** JS +x (Number(x)); NAN when not a number */
    private function jsNum($v): float
    {
        if ($v === null || $v === false) {
            return 0.0;
        }
        if ($v === true) {
            return 1.0;
        }
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if (is_string($v)) {
            $t = trim($v);
            if ($t === '') {
                return 0.0;
            }
            return is_numeric($t) ? (float) $t : NAN;
        }
        return NAN;
    }

    private function numOut(float $v): int|float
    {
        return floor($v) == $v && abs($v) < PHP_INT_MAX ? (int) $v : $v;
    }

    private function commas($v): string
    {
        $n = $this->jsNum($v);
        return number_format(Logic::jsRound(is_nan($n) ? 0 : $n), 0, '.', ',');
    }

    private function json($v): string
    {
        return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /** maskPhone that keeps null for staff allowed to see numbers (JS returned p as is) */
    private function mask(?array $u, $p)
    {
        if ($p === null && ($this->can($u, 'customers') || $this->can($u, 'cs') || $this->can($u, 'tracking'))) {
            return null;
        }
        return $this->maskPhone($u, $p === null ? null : (string) $p);
    }

    /** Query string with the original key names (PHP turns "hub.mode" into "hub_mode") */
    private function rawQs(Request $req, array $qs): array
    {
        $out = [];
        $raw = (string) $req->server->get('QUERY_STRING', '');
        if ($raw === '') {
            return $qs;
        }
        foreach (explode('&', $raw) as $pair) {
            if ($pair === '') {
                continue;
            }
            $kv = explode('=', $pair, 2);
            $out[urldecode($kv[0])] = urldecode($kv[1] ?? '');
        }
        return $out;
    }

    /* ================================================================ settings */

    private function waCfg(): array
    {
        $c = $this->arr($this->setting('inbox.wa', []));
        $url = ($c['url'] ?? '') ?: ($this->setting('inbox_cequens_url', '') ?: (env('INBOX_CEQUENS_URL') ?: self::CEQUENS_URL));
        return array_merge(['bearer' => true], $c, ['url' => $url]);
    }

    private function igCfg(): array
    {
        $c = $this->arr($this->setting('inbox.ig', []));
        $g = ($c['graphUrl'] ?? '') ?: ($this->setting('inbox_graph_url', '') ?: (env('INBOX_GRAPH_URL') ?: 'https://graph.instagram.com'));
        return array_merge(['version' => 'v21.0'], $c, ['graphUrl' => preg_replace('#/+$#', '', (string) $g)]);
    }

    private function formCfg(): array
    {
        return array_merge(['map' => [], 'ack' => false, 'ackTemplate' => 'exchange_request_received'], $this->arr($this->setting('inbox.form', [])));
    }

    private function autoCfg(): array
    {
        $c = $this->arr($this->setting('inbox.auto', []));
        $rules = [];
        $cr = $this->arr($c['rules'] ?? []);
        foreach (self::RULES as $k => $d) {
            $rules[$k] = array_merge($d, ['lang' => 'en'], $this->arr($cr[$k] ?? []), ['label' => $d['label']]);
        }
        return array_merge([
            'on' => false, 'bot' => true, 'quietFrom' => 22, 'quietTo' => 9, 'dailyLimit' => 500, 'maxAgeHours' => 48,
            'confirmReply' => 'Shukriya {name}! Aap ka order {order} confirm ho gaya hai. Hum jald parcel bhej denge.',
            'cancelReply' => 'Theek hai {name}, aap ka order {order} cancel kar diya gaya hai. Kabhi bhi dobara order karein!',
        ], $c, ['rules' => $rules]);
    }

    private function templates(): array
    {
        $t = $this->setting('inbox.templates', null);
        return is_array($t) ? $t : self::DEF_TEMPLATES;
    }

    private function quick(): array
    {
        $t = $this->setting('inbox.quick', null);
        return is_array($t) ? $t : self::DEF_QUICK;
    }

    private function findTemplate($name): ?array
    {
        foreach ($this->templates() as $t) {
            if (is_array($t) && ($t['name'] ?? null) === $name) {
                return $t;
            }
        }
        return null;
    }

    private function igReady(): bool
    {
        return $this->truthy($this->igCfg()['token'] ?? null);
    }

    private function isAdmin(?array $u): bool
    {
        return $this->can($u, 'inbox_admin');
    }

    /** channel-limited staff: inbox_wa -> WhatsApp + Google Form, inbox_ig -> Instagram DMs + comments. null = every channel */
    public function chanScope(?array $u): ?array
    {
        if ($this->can($u, 'inbox_admin')) {
            return null;
        }
        $wa = $this->can($u, 'inbox_wa');
        $ig = $this->can($u, 'inbox_ig');
        if ($wa === $ig) {
            return null;
        }
        return $wa ? ['wa', 'form'] : ['ig', 'igc'];
    }

    /* ================================================================ conversations & messages */

    private function getConv(string $channel, $ext, array $d = []): array
    {
        $ext = $this->jsStr($ext);
        $c = Db::get('SELECT * FROM ib_convs WHERE channel=? AND ext_id=?', $channel, $ext);
        if (! $c) {
            $r = Db::run('INSERT INTO ib_convs(channel,ext_id,phone,name,handle,media_id,status,last_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP())', $channel, $ext,
                ($d['phone'] ?? null) ?: null, ($d['name'] ?? null) ?: null, ($d['handle'] ?? null) ?: null, ($d['media_id'] ?? null) ?: null, ($d['status'] ?? null) ?: 'open');
            $c = Db::get('SELECT * FROM ib_convs WHERE id=?', $r->lastInsertRowid);
            $c['_new'] = true;
        } else {
            $set = [];
            if (! empty($d['name']) && $d['name'] !== $c['name']) {
                $set['name'] = $d['name'];
            }
            if (! empty($d['handle']) && $d['handle'] !== $c['handle']) {
                $set['handle'] = $d['handle'];
            }
            if (! empty($d['phone']) && empty($c['phone'])) {
                $set['phone'] = $d['phone'];
            }
            if ($set) {
                $ks = array_keys($set);
                Db::run('UPDATE ib_convs SET '.implode(',', array_map(fn ($k) => "`$k`=?", $ks)).' WHERE id=?', ...array_merge(array_values($set), [$c['id']]));
                $c = array_merge($c, $set);
            }
        }
        return $c;
    }

    private function addMsg(int $convId, array $m): int
    {
        $at = ($m['at'] ?? null) ?: $this->utc();
        $body = $m['body'] ?? null;
        $r = Db::run('INSERT INTO ib_msgs(conv_id,dir,kind,body,media,ext_id,ctx_id,status,error,user_id,auto,order_id,payload,bot,note,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            $convId, $m['dir'], ($m['kind'] ?? null) ?: 'text', $body === null ? '' : mb_substr($this->jsStr($body), 0, 5000), ($m['media'] ?? null) ?: null,
            ($m['ext_id'] ?? null) ?: null, ($m['ctx_id'] ?? null) ?: null, ($m['status'] ?? null) ?: null, ($m['error'] ?? null) ?: null, ($m['user_id'] ?? null) ?: null,
            ($m['auto'] ?? null) ?: null, ($m['order_id'] ?? null) ?: null, ! empty($m['payload']) ? $this->json($m['payload']) : null, ($m['bot'] ?? null) ?: null, ($m['note'] ?? null) ?: null, $at);
        $preview = mb_substr($this->truthy($body) ? $this->jsStr($body) : '['.(($m['kind'] ?? null) ?: 'message').']', 0, 160);
        $bot = ! empty($m['bot']);
        if ($m['dir'] === 'in') {
            Db::run("UPDATE ib_convs SET last_at=?, last_in_at=?, last_text=?, last_dir='in', unread=unread+?, status=CASE WHEN ? THEN status ELSE 'open' END WHERE id=?",
                $at, $at, $preview, $bot ? 0 : 1, $bot ? 1 : 0, $convId);
        } else {
            Db::run("UPDATE ib_convs SET last_at=?, last_text=?, last_dir='out'".(! empty($m['user_id']) ? ', unread=0' : '').' WHERE id=?', $at, $preview, $convId);
        }
        return $r->lastInsertRowid;
    }

    private function hookLog(string $src, $ok, ?string $note, $body): void
    {
        Db::run('INSERT INTO ib_hooks(src,ok,note,body,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $src, $ok ? 1 : 0, $note ?: null, mb_substr($body === null ? '' : (string) $body, 0, 20000));
        $max = (int) Db::val('SELECT MAX(id) FROM ib_hooks');
        Db::run('DELETE FROM ib_hooks WHERE id <= ?', $max - 500);
    }

    private function phoneFromText($t): string
    {
        return preg_match('/(?:\+?92|0)\s?3\d{2}[\s-]?\d{7}/', $this->jsStr($t), $m) ? Logic::normPhone($m[0]) : '';
    }

    /* ================================================================ order data for templates */

    private function orderBy($id): ?array
    {
        return $this->truthy($id) ? Db::get('SELECT * FROM orders WHERE id=?', (string) $id) : null;
    }

    private function vars(?array $o, array $extra = []): array
    {
        $items = $o ? implode(' + ', array_map(fn ($i) => ($i['title'] ?? null) ?: $i['sku'], Db::all('SELECT title, sku FROM order_items WHERE order_id=?', $o['id'] ?? null))) : '';
        $nm = (string) ((($o['cust_name'] ?? null) ?: ($extra['cust_name'] ?? null)) ?: '');
        return array_merge([
            'name' => explode(' ', $nm)[0] ?: 'Customer',
            'fullname' => ($o['cust_name'] ?? null) ?: '',
            'order' => ($o['name'] ?? null) ?: '',
            'total' => $o ? $this->commas($o['total'] ?? 0) : '',
            'items' => $items,
            'tracking' => ($o['tracking'] ?? null) ?: '',
            'courier' => ($o['courier'] ?? null) ?: 'PostEx',
            'city' => ($o['city'] ?? null) ?: '',
        ], $extra);
    }

    private function fill($s, array $v): string
    {
        return preg_replace_callback('/\{(\w+)\}/', function ($m) use ($v) {
            $k = $m[1];
            if (array_key_exists($k, $v) && $v[$k] !== null && $v[$k] !== '') {
                return $this->jsStr($v[$k]);
            }
            return array_key_exists($k, $v) ? '-' : $m[0];
        }, $s === null ? '' : $this->jsStr($s));
    }

    private function tplText(string $name, array $params): string
    {
        $t = $this->findTemplate($name);
        if (! $t) {
            return "[{$name}] ".implode(' · ', $params);
        }
        return preg_replace_callback('/\{\{(\d+)\}\}/', fn ($m) => isset($params[(int) $m[1] - 1]) ? $params[(int) $m[1] - 1] : $m[0], (string) ($t['text'] ?? ''));
    }

    /* ================================================================ CEQUENS (WhatsApp) */

    private function cequens(array $body): array
    {
        $c = $this->waCfg();
        if (! $this->truthy($c['token'] ?? null)) {
            throw new HttpError(400, 'WhatsApp is not connected. Add the CEQUENS API token in Messages → WhatsApp settings.');
        }
        try {
            $r = Http::withHeaders(['Content-Type' => 'application/json', 'Accept' => 'application/json', 'Authorization' => (($c['bearer'] ?? true) === false ? '' : 'Bearer ').$c['token']])
                ->timeout(20)->withBody($this->json($body), 'application/json')->post($c['url']);
            $t = $r->body();
            $j = $this->J($t, null);
        } catch (ConnectionException $e) {
            $this->setSetting('inbox.wa_error', ['code' => 0, 'msg' => $e->getMessage(), 'at' => $this->utc()]);
            throw new HttpError(502, 'Could not reach CEQUENS: '.$e->getMessage());
        }
        $st = $r->status();
        if (! $r->successful()) {
            $detail = $t;
            if (is_array($j)) {
                $err = $j['error'] ?? null;
                $detail = ($j['message'] ?? null) ?: (($j['error_description'] ?? null) ?: (($err ? (is_array($err) ? (($err['message'] ?? null) ?: $err) : $err) : null) ?: (! empty($j['errors']) ? $this->json($j['errors']) : $t)));
            }
            $msg = $st === 402 ? 'CEQUENS refused: daily safe sending limit exceeded (402). Messages will be retried later.'
                : ($st === 404 ? 'WhatsApp 24-hour window has closed (CEQUENS 404 invalid/expired session). Send an approved template instead.'
                : ($st === 401 || $st === 403 ? "CEQUENS rejected the API token ({$st}). Check the token and the \"Bearer\" setting."
                : "CEQUENS error {$st}: ".mb_substr($this->jsStr($detail), 0, 300)));
            $this->setSetting('inbox.wa_error', ['code' => $st, 'msg' => $msg, 'at' => $this->utc()]);
            throw new HttpError($st === 404 || $st === 402 ? $st : 502, $msg);
        }
        $m0 = is_array($j) && isset($j['messages'][0]) && is_array($j['messages'][0]) ? $j['messages'][0] : [];
        return ['id' => $m0['id'] ?? null, 'status' => ($m0['message_status'] ?? null) ?: 'accepted', 'raw' => $j];
    }

    public function waReady(): bool
    {
        return $this->truthy($this->waCfg()['token'] ?? null);
    }

    /**
     * spec: ['text'] | ['template','params','lang','buttons'] | ['image','caption'].
     * Returns the ib_msgs id; throws (after recording the failure) on error.
     * Service: sendWhatsApp(phone, spec, userId).
     */
    public function sendWhatsApp($phone, $spec = [], $userId = null, array $extra = []): int
    {
        $spec = is_array($spec) ? $spec : [];
        $to = Logic::waNumber($phone);
        $this->need(preg_match('/^92\d{10}$/', $to), 'Not a valid Pakistani mobile number: '.($this->truthy($phone) ? $this->jsStr($phone) : '(empty)'));
        $c = $extra['conv'] ?? $this->getConv('wa', $to, ['phone' => Logic::normPhone($phone), 'name' => $extra['name'] ?? null, 'status' => $extra['convStatus'] ?? null]);
        $payload = null;
        if ($this->truthy($spec['template'] ?? null)) {
            $tname = $this->jsStr($spec['template']);
            $t = $this->findTemplate($tname) ?? [];
            $params = array_map(fn ($x) => $x === null || $x === '' ? '-' : $this->jsStr($x), array_values($this->arr($spec['params'] ?? [])));
            $kind = 'template';
            $shown = $this->tplText($tname, $params);
            $payload = ['template' => $tname, 'params' => $params];
            $body = ['type' => 'template', 'recipient_type' => 'individual', 'to' => $to, 'clientReferenceID' => '',
                'template' => ['name' => $tname, 'language' => ['policy' => 'deterministic', 'code' => ($spec['lang'] ?? null) ?: (($t['lang'] ?? null) ?: 'en')], 'components' => []]];
            if ($params) {
                $body['template']['components'][] = ['type' => 'body', 'parameters' => array_map(fn ($x) => ['type' => 'text', 'text' => mb_substr($x, 0, 1000)], $params)];
            }
            foreach (array_values($this->arr($spec['buttons'] ?? [])) as $i => $b) {
                $b = $this->arr($b);
                $idx = $this->jsStr(isset($b['index']) ? $b['index'] : $i);
                $body['template']['components'][] = ($b['type'] ?? null) === 'url'
                    ? ['type' => 'button', 'sub_type' => 'url', 'index' => $idx, 'parameters' => [['type' => 'text', 'text' => $this->tl($b['text'] ?? null)]]]
                    : ['type' => 'button', 'sub_type' => 'quick_reply', 'index' => $idx, 'parameters' => [['type' => 'payload', 'payload' => $this->tl($b['payload'] ?? null)]]];
            }
        } elseif ($this->truthy($spec['image'] ?? null)) {
            $kind = 'image';
            $shown = ($spec['caption'] ?? null) ?: '';
            $img = ['link' => $this->jsStr($spec['image'])];
            if ($this->truthy($spec['caption'] ?? null)) {
                $img['caption'] = $this->jsStr($spec['caption']);
            }
            $body = ['to' => $to, 'type' => 'image', 'recipient_type' => 'individual', 'image' => $img];
        } else {
            $text = trim($this->jsStr(($spec['text'] ?? null) ?: ''));
            $this->need($text !== '', 'Write a message');
            $kind = 'text';
            $shown = $text;
            $body = ['to' => $to, 'type' => 'text', 'recipient_type' => 'individual', 'preview_url' => false, 'text' => ['body' => mb_substr($text, 0, 4096)]];
        }
        $mid = $this->addMsg((int) $c['id'], ['dir' => 'out', 'kind' => $kind, 'body' => $shown, 'media' => ($spec['image'] ?? null) ?: null, 'status' => 'pending', 'user_id' => $userId,
            'auto' => $extra['auto'] ?? null, 'order_id' => $extra['order_id'] ?? null, 'payload' => $payload, 'note' => $extra['note'] ?? null]);
        if ($body['type'] === 'template') {
            $body['clientReferenceID'] = 'ib'.$mid;
        }
        try {
            $r = $this->cequens($body);
            $st = $r['status'] === 'accepted' ? 'accepted' : (is_string($r['status']) && isset(self::ST_RANK[$r['status']]) ? $r['status'] : 'accepted');
            Db::run('UPDATE ib_msgs SET ext_id=?, status=? WHERE id=?', $r['id'] ? $this->jsStr($r['id']) : null, $st, $mid);
        } catch (\Throwable $e) {
            Db::run("UPDATE ib_msgs SET status='failed', error=? WHERE id=?", $e->getMessage(), $mid);
            $this->failedMsgId = $mid;
            throw $e;
        }
        return $mid;
    }

    /* ================================================================ Meta Graph (Instagram) */

    private function graph(string $method, string $path, ?array $body = null): array
    {
        $c = $this->igCfg();
        if (! $this->truthy($c['token'] ?? null)) {
            throw new HttpError(400, 'Instagram is not connected. Add the access token in Messages → Instagram settings.');
        }
        $url = $c['graphUrl'].'/'.$this->jsStr($c['version']).'/'.$path.(str_contains($path, '?') ? '&' : '?').'access_token='.$this->encodeURIComponent((string) $c['token']);
        try {
            $h = Http::withHeaders(['Content-Type' => 'application/json'])->timeout(20);
            if ($body !== null) {
                $h = $h->withBody($this->json($body), 'application/json');
            }
            $r = $h->send($method, $url);
            $j = $this->J($r->body(), null);
        } catch (ConnectionException $e) {
            throw new HttpError(502, 'Could not reach Meta: '.$e->getMessage());
        }
        if (! $r->successful() || (is_array($j) && ! empty($j['error']))) {
            $er = is_array($j) && is_array($j['error'] ?? null) ? $j['error'] : [];
            $em = (string) ($er['message'] ?? '');
            $code = $er['code'] ?? null;
            $win = $code === 10 || ($er['error_subcode'] ?? null) === 2534022 || preg_match('/outside of allowed window|24 hour/i', $em);
            $msg = $win ? "Instagram only allows replies within 24 hours of the customer's last message. Meta refused: {$em}"
                : ($code === 190 ? 'Instagram access token expired or invalid. Generate a new long-lived token in Settings → Instagram.'
                : ($code === 200 || $code === 3 || $code === 230 ? "Meta refused (permission missing — the app may still need App Review for messaging): {$em}"
                : 'Meta error '.($code ?: $r->status()).': '.($em ?: 'unknown error')));
            $this->setSetting('inbox.ig_error', ['code' => $code ?: $r->status(), 'msg' => $msg, 'at' => $this->utc()]);
            throw new HttpError(400, $msg);
        }
        return is_array($j) ? $j : [];
    }

    private function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    private function igProfile(array $c): void
    {
        try {
            $p = $this->graph('GET', $c['ext_id'].'?fields=name,username');
            if (! empty($p['name']) || ! empty($p['username'])) {
                Db::run('UPDATE ib_convs SET name=COALESCE(?,name), handle=COALESCE(?,handle) WHERE id=?', ($p['name'] ?? null) ?: null, ($p['username'] ?? null) ?: null, $c['id']);
            }
        } catch (\Throwable) {
        }
    }

    /* ================================================================ the bot: YES / NO replies */

    private static function parseReply($text): ?string
    {
        $t = mb_strtolower(is_string($text) ? $text : (is_scalar($text) ? (string) $text : ''));
        $t = trim(preg_replace('/\s+/u', ' ', preg_replace('/[^\p{L}\p{N}\s]/u', ' ', $t)));
        if ($t === '') {
            return null;
        }
        if (in_array($t, self::YES, true)) {
            return 'confirmed';
        }
        if (in_array($t, self::NO, true)) {
            return 'cancelled';
        }
        $words = explode(' ', $t);
        $hasNo = (bool) array_filter($words, fn ($w) => in_array($w, self::NO, true));
        $hasYes = (bool) array_filter($words, fn ($w) => in_array($w, self::YES, true));
        $core = array_filter($words, fn ($w) => ! in_array($w, self::FILLER, true) && ! in_array($w, self::YES, true) && ! in_array($w, self::NO, true));
        if (count($words) > 5 || count($core) > 1) {
            return null;
        }
        if ($hasNo) {
            return 'cancelled';
        }
        if ($hasYes) {
            return 'confirmed';
        }
        return null;
    }

    private function pendingOrder(?array $o): bool
    {
        return $o && in_array($o['stage'], ['new', 'hold'], true) && in_array($o['status'], ['new', 'hold'], true) && empty($o['tracking']) && empty($o['cancelled_at']);
    }

    private function applyCs(array $o, string $outcome, string $note): void
    {
        $stage = $outcome === 'confirmed' ? 'confirmed' : 'cs_cancelled';
        Db::run('INSERT INTO cs_calls(order_id,user_id,outcome,note,at) VALUES(?,?,?,?,UTC_TIMESTAMP())', $o['id'], null, $outcome, $note);
        Db::run('UPDATE orders SET stage=?, cs_attempts=cs_attempts+1, cs_note=?, cs_by=?, cs_at=UTC_TIMESTAMP(), cs_next=? WHERE id=?', $stage, $note, null, null, $o['id']);
        Logic::refreshOrder($o['id']);
        $this->log(null, 'cs:'.$outcome, 'order:'.$o['id'], $note);
        if ($this->shopify()->configured() && ! str_starts_with((string) $o['id'], 'demo')) {
            $oid = (string) $o['id'];
            $tags = [$outcome === 'confirmed' ? 'ERP-Confirmed' : 'ERP-Cancel'];
            Defer::run(function () use ($oid, $tags) {
                try {
                    app(\App\Services\Shopify\ShopifyWriter::class)->tagOrder($oid, $tags, null);
                } catch (\Throwable $e) {
                    $this->log(null, 'shopify.tag.error', 'order:'.$oid, $e->getMessage());
                }
            }, 'inbox');
        }
    }

    private function botDecide(array $c, array $m, $text, $payload): ?array
    {
        if (($this->autoCfg()['bot'] ?? true) === false) {
            return null;
        }
        $outcome = null;
        $order = null;
        if (preg_match('/^(CONFIRM|CANCEL):(.+)$/s', $this->jsStr($payload), $pm)) {
            $outcome = $pm[1] === 'CONFIRM' ? 'confirmed' : 'cancelled';
            $order = $this->orderBy($pm[2]);
        }
        if (! $outcome) {
            $outcome = self::parseReply($text) ?: self::parseReply($payload);
        }
        if (! $outcome) {
            return null;
        }
        $ctxId = is_array($m['context'] ?? null) ? ($m['context']['id'] ?? null) : null;
        if (! $order && $ctxId) {
            $sent = Db::get('SELECT order_id FROM ib_msgs WHERE ext_id=? AND order_id IS NOT NULL', $this->jsStr($ctxId));
            if ($sent) {
                $order = $this->orderBy($sent['order_id']);
            }
        }
        if (! $order) { // latest pending order for this phone that we sent a confirmation for
            $r = Db::get("SELECT o.id FROM orders o JOIN ib_auto_log a ON a.order_id=o.id AND a.event='confirm' AND a.status='sent' WHERE o.phone=? AND o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.tracking IS NULL AND o.cancelled_at IS NULL ORDER BY o.created_at DESC LIMIT 1", $c['phone']);
            if ($r) {
                $order = $this->orderBy($r['id']);
            }
        }
        if (! $this->pendingOrder($order)) {
            return null;
        }
        return ['outcome' => $outcome, 'order' => $order];
    }

    /* ================================================================ inbound WhatsApp (CEQUENS webhook) */

    private function isList($x): bool
    {
        return is_array($x) && array_is_list($x);
    }

    private function waValues($b): array
    {
        $out = [];
        $walk = function ($x, int $d) use (&$walk, &$out) {
            if (! is_array($x) || ! $x || $d > 5) {
                return;
            }
            if (array_is_list($x)) {
                foreach ($x as $y) {
                    $walk($y, $d + 1);
                }
                return;
            }
            if ($this->isList($x['messages'] ?? null) || $this->isList($x['statuses'] ?? null)) {
                $out[] = $x;
                return;
            }
            if ($this->isList($x['entry'] ?? null)) {
                foreach ($x['entry'] as $e) {
                    foreach ($this->arr(is_array($e) ? ($e['changes'] ?? []) : []) as $ch) {
                        $walk(is_array($ch) ? ($ch['value'] ?? null) : null, $d + 1);
                    }
                }
                return;
            }
            foreach (['data', 'payload', 'value', 'body'] as $k) {
                if (! empty($x[$k]) && is_array($x[$k])) {
                    $walk($x[$k], $d + 1);
                }
            }
        };
        $walk($b, 0);
        return $out;
    }

    private function msgContent(array $m): array
    {
        $t = $m['type'] ?? null;
        $g = fn ($k) => is_array($m[$k] ?? null) ? $m[$k] : [];
        if ($t === 'text' || (! empty($m['text']) && ! $t)) {
            return ['kind' => 'text', 'body' => ($g('text')['body'] ?? null) ?: ''];
        }
        if ($t === 'button') {
            $b = $g('button');
            return ['kind' => 'button', 'body' => (($b['text'] ?? null) ?: ($b['payload'] ?? null)) ?: '', 'payload' => $b['payload'] ?? null];
        }
        if ($t === 'interactive') {
            $i = $g('interactive');
            $r = $this->arr(($i['button_reply'] ?? null) ?: ($i['list_reply'] ?? null));
            return ['kind' => 'button', 'body' => ($r['title'] ?? null) ?: '', 'payload' => $r['id'] ?? null];
        }
        if (in_array($t, ['image', 'document', 'audio', 'video', 'sticker', 'voice'], true)) {
            $x = $g($t);
            return ['kind' => $t, 'body' => (($x['caption'] ?? null) ?: ($x['filename'] ?? null)) ?: '', 'media' => (($x['link'] ?? null) ?: ($x['url'] ?? null)) ?: null, 'mediaId' => $x['id'] ?? null];
        }
        if ($t === 'location') {
            $x = $g('location');
            $nm = implode(', ', array_filter([$x['name'] ?? null, $x['address'] ?? null], fn ($v) => $this->truthy($v)));
            return ['kind' => 'location', 'body' => $nm ?: $this->tl($x['latitude'] ?? null).','.$this->tl($x['longitude'] ?? null),
                'media' => isset($x['latitude']) ? 'https://maps.google.com/?q='.$this->jsStr($x['latitude']).','.$this->tl($x['longitude'] ?? null) : null];
        }
        if ($t === 'reaction') {
            return ['kind' => 'reaction', 'body' => ($g('reaction')['emoji'] ?? null) ?: ''];
        }
        if ($t === 'contacts') {
            $parts = [];
            foreach ($this->arr($m['contacts'] ?? []) as $c) {
                $c = $this->arr($c);
                $nm = ! empty($c['name']) ? (is_array($c['name']) ? ($c['name']['formatted_name'] ?? null) : null) : ($c['name'] ?? null);
                $ph = $this->arr($this->arr($c['phones'] ?? [])[0] ?? [])['phone'] ?? null;
                $parts[] = $this->tl($nm).' '.$this->tl($ph);
            }
            return ['kind' => 'contacts', 'body' => implode(', ', $parts)];
        }
        return ['kind' => $t ? $this->jsStr($t) : 'unknown', 'body' => ''];
    }

    private function handleCequens($b): array
    {
        $after = [];
        $res = ['messages' => 0, 'statuses' => 0, 'bot' => 0];
        foreach ($this->waValues($b) as $v) {
            $names = [];
            foreach ($this->arr($v['contacts'] ?? []) as $c) {
                $c = $this->arr($c);
                $names[$this->jsStr(($c['wa_id'] ?? null) ?: '')] = is_array($c['profile'] ?? null) ? ($c['profile']['name'] ?? null) : null;
            }
            foreach ($this->arr($v['messages'] ?? []) as $m) {
                if (! is_array($m) || ! $this->truthy($m['from'] ?? null)) {
                    continue;
                }
                if (! empty($m['id']) && Db::get('SELECT id FROM ib_msgs WHERE ext_id=?', $this->jsStr($m['id']))) {
                    continue; // duplicate delivery
                }
                $from = Logic::waNumber($m['from']);
                $phone = Logic::normPhone($m['from']);
                $x = $this->msgContent($m);
                $tsn = $this->jsNum($m['timestamp'] ?? null);
                $now = $this->nowMs();
                $ts = ! is_nan($tsn) && $tsn != 0 ? $tsn * 1000 : $now;
                $at = $this->utc(min($now, $ts));
                $c = $this->getConv('wa', $from, ['phone' => $phone, 'name' => ($names[$this->jsStr($m['from'])] ?? null) ?: (($names[$from] ?? null) ?: null)]);
                $dec = $this->botDecide($c, $m, $x['body'], $x['payload'] ?? null);
                $ctxId = is_array($m['context'] ?? null) ? ($m['context']['id'] ?? null) : null;
                $mid = $this->addMsg((int) $c['id'], ['dir' => 'in', 'kind' => $x['kind'], 'body' => $x['body'], 'media' => $x['media'] ?? null, 'ext_id' => isset($m['id']) ? $this->jsStr($m['id']) : null,
                    'ctx_id' => $ctxId !== null ? $this->jsStr($ctxId) : null, 'at' => $at, 'bot' => $dec ? $dec['outcome'] : null, 'order_id' => $dec ? $dec['order']['id'] : null,
                    'payload' => $this->truthy($x['payload'] ?? null) ? ['payload' => $x['payload']] : ($this->truthy($x['mediaId'] ?? null) ? ['media_id' => $x['mediaId']] : null), 'status' => 'received']);
                $res['messages']++;
                if ($dec) {
                    if (! empty($c['_new'])) {
                        Db::run("UPDATE ib_convs SET status='closed' WHERE id=?", $c['id']);
                    }
                    $said = $this->truthy($x['body']) ? $x['body'] : ($x['payload'] ?? null);
                    $note = 'WhatsApp bot: customer replied "'.mb_substr($this->tl($said), 0, 60).'"';
                    $this->applyCs($dec['order'], $dec['outcome'], $note);
                    $this->log(null, 'inbox.bot', 'inbox:'.$c['id'], ['order' => $dec['order']['name'], 'outcome' => $dec['outcome'], 'msg' => $mid]);
                    $res['bot']++;
                    $a = $this->autoCfg();
                    $text = $this->fill($dec['outcome'] === 'confirmed' ? $a['confirmReply'] : $a['cancelReply'], $this->vars($this->orderBy($dec['order']['id'])));
                    if (trim($text) !== '') {
                        $oid = $dec['order']['id'];
                        $after[] = function () use ($phone, $text, $c, $oid) {
                            try {
                                $this->sendWhatsApp($phone, ['text' => $text], null, ['conv' => $c, 'auto' => 'bot', 'order_id' => $oid]);
                            } catch (\Throwable $e) {
                                $this->log(null, 'inbox.error', 'inbox:'.$c['id'], $e->getMessage());
                            }
                        };
                    }
                }
            }
            foreach ($this->arr($v['statuses'] ?? []) as $s) {
                if (! is_array($s) || ! $s) {
                    continue;
                }
                $res['statuses']++;
                $msg = ! empty($s['id']) ? Db::get('SELECT * FROM ib_msgs WHERE ext_id=?', $this->jsStr($s['id'])) : null;
                $refStr = $this->jsStr(($s['clientReferenceID'] ?? null) ?: (($s['client_reference_id'] ?? null) ?: ''));
                if (! $msg && preg_match('/^ib(\d+)$/', $refStr, $ref)) {
                    $msg = Db::get('SELECT * FROM ib_msgs WHERE id=?', (int) $ref[1]);
                    if ($msg && ! empty($s['id']) && empty($msg['ext_id'])) {
                        Db::run('UPDATE ib_msgs SET ext_id=? WHERE id=?', $this->jsStr($s['id']), $msg['id']);
                    }
                }
                if (! $msg) {
                    continue;
                }
                $st = strtolower($this->jsStr(($s['status'] ?? null) ?: ''));
                if ($st === 'failed' || $st === 'deleted') {
                    $er = $this->arr($this->arr($s['errors'] ?? [])[0] ?? []);
                    $det = is_array($er['error_data'] ?? null) ? ($er['error_data']['details'] ?? null) : null;
                    $err = $st === 'failed'
                        ? trim($this->jsStr(($er['code'] ?? null) ?: '').' '.$this->jsStr((($er['title'] ?? null) ?: ($er['message'] ?? null)) ?: 'Failed').($this->truthy($det) ? ': '.$this->jsStr($det) : ''))
                        : $msg['error'];
                    Db::run('UPDATE ib_msgs SET status=?, error=? WHERE id=?', $st, $err, $msg['id']);
                    if ($st === 'failed') {
                        Db::run("UPDATE ib_auto_log SET status='failed', error=? WHERE msg_id=?", mb_substr($this->jsStr(($er['title'] ?? null) ?: 'Failed'), 0, 200), $msg['id']);
                    }
                } elseif (isset(self::ST_RANK[$st]) && (self::ST_RANK[$st] > (self::ST_RANK[$msg['status']] ?? -1) || $msg['status'] === 'failed')) {
                    Db::run('UPDATE ib_msgs SET status=? WHERE id=?', $st, $msg['id']);
                }
            }
        }
        return ['res' => $res, 'after' => $after];
    }

    /** setImmediate(async () => { for (f of fns) try { await f() } catch {} }) */
    private function runAfter(array $fns): void
    {
        if (! $fns) {
            return;
        }
        Defer::run(function () use ($fns) {
            foreach ($fns as $f) {
                try {
                    $f();
                } catch (\Throwable) {
                }
            }
        }, 'inbox');
    }

    private function hookUrlKey(array $qs, $key): bool
    {
        if (! $this->truthy($key) || ! $this->truthy($qs['key'] ?? null) || ! is_scalar($qs['key'])) {
            return false;
        }
        return hash_equals((string) $key, (string) $qs['key']);
    }

    public function hookCequens(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $raw = $req->getContent();
        if (! $this->hookUrlKey($qs, $this->waCfg()['key'] ?? null)) {
            $this->hookLog('cequens', 0, 'wrong key', $raw);
            throw new HttpError(403, 'Wrong key');
        }
        try {
            $out = $this->handleCequens($b);
        } catch (\Throwable $e) {
            $this->hookLog('cequens', 0, 'error: '.$e->getMessage(), $raw);
            throw $e;
        }
        $r = $out['res'];
        $this->hookLog('cequens', 1, "{$r['messages']} msg, {$r['statuses']} status".($r['bot'] ? ', bot '.$r['bot'] : ''), $raw);
        $this->runAfter($out['after']);
        return ['ok' => true] + $r;
    }

    public function hookCequensPing(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        if (! $this->hookUrlKey($qs, $this->waCfg()['key'] ?? null)) {
            throw new HttpError(403, 'Wrong key');
        }
        return ['ok' => true, 'service' => 'SundayBazar ERP WhatsApp webhook'];
    }

    /* ================================================================ Instagram webhook */

    public function hookInstagramVerify(?array $u, array $b, array $p, array $qs, Request $req)
    {
        $c = $this->igCfg();
        $q = $this->rawQs($req, $qs);
        $vt = (string) ($c['verifyToken'] ?? '');
        $sent = $q['hub.verify_token'] ?? null;
        if (($q['hub.mode'] ?? null) === 'subscribe' && $vt !== '' && is_string($sent) && hash_equals($vt, $sent)) {
            $this->hookLog('instagram', 1, 'verified', $this->json((object) $q));
            return response((string) ($q['hub.challenge'] ?? ''), 200, ['Content-Type' => 'text/plain']);
        }
        $this->hookLog('instagram', 0, 'verify failed', $this->json((object) $q));
        throw new HttpError(403, 'Verification failed');
    }

    private function handleInstagram($b): array
    {
        $c = $this->igCfg();
        $me = $this->jsStr(($c['igId'] ?? null) ?: '');
        $after = [];
        $res = ['dms' => 0, 'comments' => 0];
        foreach ($this->arr(is_array($b) ? ($b['entry'] ?? []) : []) as $e) {
            $e = $this->arr($e);
            foreach ($this->arr($e['messaging'] ?? []) as $m) {
                $m = $this->arr($m);
                if (empty($m['message']) || empty($m['sender']) || empty($m['recipient']) || ! is_array($m['message'])) {
                    continue;
                }
                $msg = $m['message'];
                $echo = ! empty($msg['is_echo']);
                if (! empty($msg['mid']) && Db::get('SELECT id FROM ib_msgs WHERE ext_id=?', $this->jsStr($msg['mid']))) {
                    continue; // our own API send (echo) or duplicate
                }
                $userId = $this->tl($echo ? ($m['recipient']['id'] ?? null) : ($m['sender']['id'] ?? null));
                $atts = array_map(fn ($a) => ['type' => ($this->arr($a)['type'] ?? null) ?: 'file', 'url' => is_array($this->arr($a)['payload'] ?? null) ? ($a['payload']['url'] ?? null) : null], $this->arr($msg['attachments'] ?? []));
                $text = ($msg['text'] ?? null) ?: '';
                $cv = $this->getConv('ig', $userId, ['phone' => $this->phoneFromText($text) ?: null]);
                $ts = $this->jsNum($m['timestamp'] ?? null);
                $at = $this->truthy($m['timestamp'] ?? null) && ! is_nan($ts) ? $this->utc(min($this->nowMs(), $ts)) : null;
                $a0 = $atts[0] ?? null;
                $this->addMsg((int) $cv['id'], ['dir' => $echo ? 'out' : 'in', 'kind' => ! $this->truthy($text) && $a0 ? ($a0['type'] === 'image' ? 'image' : $a0['type']) : 'text',
                    'body' => $this->truthy($text) ? $text : ($a0 ? '' : '[message]'), 'media' => $a0 ? $a0['url'] : null,
                    'ext_id' => ! empty($msg['mid']) ? $this->jsStr($msg['mid']) : null, 'at' => $at, 'note' => $echo ? 'Sent from the Instagram app' : null, 'status' => $echo ? 'sent' : 'received']);
                $res['dms']++;
                if (! empty($cv['_new']) && ! $echo && $this->truthy($c['token'] ?? null)) {
                    $after[] = fn () => $this->igProfile($cv);
                }
            }
            foreach ($this->arr($e['changes'] ?? []) as $ch) {
                $ch = $this->arr($ch);
                if (! preg_match('/comments/', $this->jsStr(($ch['field'] ?? null) ?: '')) || empty($ch['value']) || ! is_array($ch['value']) || ! $this->truthy($ch['value']['id'] ?? null)) {
                    continue;
                }
                $v = $ch['value'];
                $from = $this->arr($v['from'] ?? []);
                if ($me !== '' && $this->tl($from['id'] ?? null) === $me) {
                    continue; // our own public reply
                }
                if (Db::get('SELECT id FROM ib_msgs WHERE ext_id=?', $this->jsStr($v['id']))) {
                    continue;
                }
                $media = is_array($v['media'] ?? null) ? $v['media'] : null;
                $key = $this->jsStr((($from['id'] ?? null) ?: ($from['username'] ?? null)) ?: 'unknown').':'.$this->jsStr(($media['id'] ?? null) ?: '');
                $cv = $this->getConv('igc', $key, ['handle' => ($from['username'] ?? null) ?: null, 'media_id' => $media['id'] ?? null, 'phone' => $this->phoneFromText($v['text'] ?? null) ?: null]);
                $this->addMsg((int) $cv['id'], ['dir' => 'in', 'kind' => 'comment', 'body' => ($v['text'] ?? null) ?: '', 'ext_id' => $this->jsStr($v['id']),
                    'payload' => ['media' => ($v['media'] ?? null) ?: null, 'parent_id' => ($v['parent_id'] ?? null) ?: null], 'status' => 'received']);
                $res['comments']++;
            }
        }
        return ['res' => $res, 'after' => $after];
    }

    public function hookInstagram(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->igCfg();
        $raw = $req->getContent();
        $sig = (string) $req->header('X-Hub-Signature-256', '');
        $secret = (string) (($c['appSecret'] ?? null) ?: '');
        $want = $secret !== '' ? 'sha256='.hash_hmac('sha256', $raw, $secret) : '';
        if ($want === '' || ! hash_equals($want, $sig)) {
            $this->hookLog('instagram', 0, $secret !== '' ? 'bad signature' : 'app secret not set', $raw);
            throw new HttpError(403, 'Bad signature');
        }
        $out = $this->handleInstagram($b);
        $this->hookLog('instagram', 1, "{$out['res']['dms']} DM, {$out['res']['comments']} comment", $raw);
        $this->runAfter($out['after']);
        return ['ok' => true] + $out['res'];
    }

    /* ================================================================ Google Form exchange requests */

    private function mapAnswers(array $answers, array $map): array
    {
        $out = [];
        $used = [];
        $keys = array_map('strval', array_keys($answers));
        foreach (self::FIELDS as $f) {
            if ($this->truthy($map[$f] ?? null) && array_key_exists((string) $map[$f], $answers)) {
                $out[$f] = $answers[(string) $map[$f]];
                $used[(string) $map[$f]] = true;
            }
        }
        foreach (self::GUESS as [$f, $re]) {
            if (! isset($out[$f])) {
                foreach ($keys as $k) {
                    if (! isset($used[$k]) && preg_match($re, $k) && ! preg_match('/timestamp/i', $k)) {
                        $out[$f] = $answers[$k];
                        $used[$k] = true;
                        break;
                    }
                }
            }
        }
        if (! isset($out['current'])) {
            foreach ($keys as $k) {
                if (! isset($used[$k]) && preg_match('/size/i', $k)) {
                    $out['current'] = $answers[$k];
                    $used[$k] = true;
                    break;
                }
            }
        }
        return $out;
    }

    private function findOrderRef($ref, string $phone): ?array
    {
        $t = mb_strtoupper(trim($this->jsStr($ref)));
        $o = null;
        if ($t !== '') {
            $d = preg_match('/(\d{4,7})/', $t, $mm) ? $mm[1] : null;
            $o = Db::get('SELECT * FROM orders WHERE name=? OR id=? OR name=?', preg_replace('/\s+/', '', $t), trim($this->jsStr($ref)), $d ? 'SB'.$d : '__none__');
        }
        if (! $o && $phone !== '') {
            $o = Db::get("SELECT * FROM orders WHERE phone=? ORDER BY (status='delivered') DESC, created_at DESC LIMIT 1", $phone);
        }
        return $o;
    }

    public function hookGoogleForm(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $cfg = $this->formCfg();
        $raw = $req->getContent();
        if (! $this->hookUrlKey($qs, $cfg['key'] ?? null)) {
            $this->hookLog('form', 0, 'wrong key', $raw);
            throw new HttpError(403, 'Wrong key');
        }
        $answers = [];
        foreach ($this->arr($b['answers'] ?? []) as $k => $v) {
            $val = is_array($v) && array_is_list($v)
                ? implode(', ', array_map(fn ($x) => $this->jsStr($x), array_values(array_filter($v, fn ($x) => $x !== ''))))
                : $this->jsStr($v);
            $answers[trim((string) $k)] = mb_substr(trim($val), 0, 2000);
        }
        if (! $answers) {
            $this->hookLog('form', 0, 'no answers', $raw);
            throw new HttpError(400, 'No answers in the form submission');
        }
        $f = $this->mapAnswers($answers, $this->arr($cfg['map'] ?? []));
        $phone = Logic::normPhone(($f['phone'] ?? null) ?: '');
        $submitted = mb_substr($this->jsStr((($b['submittedAt'] ?? null) ?: ($answers['Timestamp'] ?? null)) ?: ''), 0, 40);
        $key = ($submitted !== '' ? $submitted : sha1($this->json((object) $answers))).'|'.$phone;
        $dup = Db::get('SELECT * FROM ib_forms WHERE `key`=?', $key);
        if ($dup) {
            $this->hookLog('form', 1, 'duplicate', $raw);
            return ['ok' => true, 'duplicate' => true, 'ticket' => $dup['ticket_id'], 'conversation' => $dup['conv_id']];
        }
        $o = $this->findOrderRef($f['order'] ?? null, $phone);
        $custPhone = $phone !== '' ? $phone : (($o['phone'] ?? null) ?: '');
        $name = ($f['name'] ?? null) ?: (($o['cust_name'] ?? null) ?: '');
        $lines = [];
        foreach ($answers as $k2 => $v) {
            $lines[] = "{$k2}: {$v}";
        }
        $summary = implode(' · ', array_filter([
            $this->truthy($f['current'] ?? null) ? 'Has: '.$f['current'] : '',
            $this->truthy($f['wanted'] ?? null) ? 'Wants: '.$f['wanted'] : '',
            $this->truthy($f['reason'] ?? null) ? 'Reason: '.$f['reason'] : '',
        ]));
        $formName = $this->truthy($b['form'] ?? null) ? $this->jsStr($b['form']) : null;
        $fid = Db::run('INSERT INTO ib_forms(`key`,form,submitted_at,answers,phone,order_id,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP())', $key, mb_substr($formName ?? 'Google Form', 0, 120), $submitted,
            $this->json((object) $answers), $custPhone, $o ? $o['id'] : null)->lastInsertRowid;
        $ticket = null;
        $err = null;
        $tickets = $this->svc('tickets');
        if ($tickets) {
            try {
                $subj = 'Size exchange (form) · '.($o ? $o['name'] : ((($f['order'] ?? null) ?: $custPhone))).($this->truthy($f['wanted'] ?? null) ? ' → '.$f['wanted'] : '');
                $ticket = $tickets->create([
                    'type' => 'Size exchange', 'channel' => 'Google Form', 'order_id' => $o ? $o['id'] : null, 'phone' => $custPhone, 'cust_name' => $name,
                    'subject' => mb_substr($subj, 0, 200),
                    'note' => 'Google Form "'.($formName ?? 'exchange request').'" submitted '.$submitted."\n".($summary !== '' ? $summary."\n" : '')."\n".implode("\n", $lines),
                ], null);
            } catch (\Throwable $e) {
                $err = $e->getMessage();
            }
        } else {
            $err = 'Tickets module not available';
        }
        $cv = $this->getConv('form', 'form:'.$fid, ['phone' => $custPhone ?: null, 'name' => $name ?: null]);
        if ($ticket) {
            Db::run('UPDATE ib_convs SET ticket_id=? WHERE id=?', $ticket, $cv['id']);
        }
        $photos = $this->jsStr(($f['photos'] ?? null) ?: '');
        $this->addMsg((int) $cv['id'], ['dir' => 'in', 'kind' => 'form', 'body' => ($summary !== '' ? $summary."\n\n" : '').implode("\n", $lines), 'order_id' => $o ? $o['id'] : null,
            'media' => preg_match('#^https?://#', $photos) ? preg_split('/[,\s]+/', $photos)[0] : null, 'payload' => ['fields' => (object) $f, 'ticket' => $ticket, 'error' => $err]]);
        Db::run('UPDATE ib_forms SET ticket_id=?, conv_id=?, error=? WHERE id=?', $ticket, $cv['id'], $err, $fid);
        $this->log(null, 'inbox.form', 'inbox:'.$cv['id'], ['order' => $o ? $o['name'] : null, 'ticket' => $ticket, 'error' => $err]);
        $this->hookLog('form', 1, 'ticket '.($ticket ?: '-').($err ? ' ('.$err.')' : ''), $raw);
        if ($this->truthy($cfg['ack'] ?? null) && $custPhone !== '' && $this->waReady()) {
            $t = $this->findTemplate($cfg['ackTemplate'] ?? null) ?? ['params' => ['{name}', '{order}']];
            $v = $this->vars($o, ['cust_name' => $name, 'order' => $o ? $o['name'] : (($f['order'] ?? null) ?: '')]);
            $spec = ['template' => $cfg['ackTemplate'], 'params' => array_map(fn ($x) => $this->fill($x, $v), $this->arr($t['params'] ?? [])), 'lang' => $t['lang'] ?? null];
            $oid = $o ? $o['id'] : null;
            $this->runAfter([function () use ($custPhone, $spec, $oid, $name, $fid) {
                try {
                    $this->sendWhatsApp($custPhone, $spec, null, ['auto' => 'form', 'order_id' => $oid, 'name' => $name]);
                } catch (\Throwable $e) {
                    $this->log(null, 'inbox.error', 'form:'.$fid, $e->getMessage());
                }
            }]);
        }
        return ['ok' => true, 'ticket' => $ticket, 'conversation' => $cv['id'], 'order' => $o ? $o['name'] : null, 'error' => $err];
    }

    /* ================================================================ automatic WhatsApp messages */

    private function quietNow(array $a): bool
    {
        $f = $this->jsNum($a['quietFrom'] ?? null);
        $t = $this->jsNum($a['quietTo'] ?? null);
        if (! ($f >= 0) || ! ($t >= 0) || $f == $t) {
            return false;
        }
        $hr = (int) substr($this->pkNow(), 11, 2);
        return $f > $t ? ($hr >= $f || $hr < $t) : ($hr >= $f && $hr < $t);
    }

    private function sentToday(): int
    {
        return (int) Db::val("SELECT COUNT(*) n FROM ib_auto_log WHERE status='sent' AND DATE(at + INTERVAL 5 HOUR)=?", $this->pkToday());
    }

    private function candidates(array $a): array
    {
        $out = [];
        $h = $this->jsNum($a['maxAgeHours'] ?? null);
        $age = '(UTC_TIMESTAMP() - INTERVAL '.(int) max(1, (! is_nan($h) && $h) ? $h : 48).' HOUR)';
        $R = $a['rules'];
        $add = function ($rule, $o, $event, $extra = []) use (&$out) {
            if ($o && ! empty($o['phone'])) {
                $out[] = ['rule' => $rule, 'order' => $o, 'event' => $event, 'key' => ($extra['key'] ?? null) ?: $o['id'], 'extra' => $extra];
            }
        };
        $not = fn ($ev) => "NOT EXISTS (SELECT 1 FROM ib_auto_log l WHERE l.order_id=o.id AND l.event={$ev})";
        if ($this->truthy($R['confirm']['on'] ?? null)) {
            foreach (Db::all("SELECT o.* FROM orders o WHERE o.stage IN ('new','hold') AND o.status IN ('new','hold') AND o.tracking IS NULL AND o.cancelled_at IS NULL AND o.phone<>'' AND o.created_at>={$age} AND ".$not("'confirm'").' ORDER BY o.created_at LIMIT 300') as $o) {
                $add('confirm', $o, 'confirm');
            }
        }
        if ($this->truthy($R['dispatched']['on'] ?? null)) {
            foreach (Db::all("SELECT o.* FROM orders o WHERE o.status IN ('dispatched','in_transit') AND o.tracking IS NOT NULL AND o.phone<>'' AND COALESCE(o.dispatched_at, o.px_updated)>={$age} AND ".$not("'dispatched'").' LIMIT 300') as $o) {
                $add('dispatched', $o, 'dispatched');
            }
        }
        if ($this->truthy($R['attempted']['on'] ?? null)) {
            foreach (Db::all("SELECT o.* FROM orders o WHERE o.status='attempted' AND o.phone<>'' AND COALESCE(o.px_updated, o.dispatched_at)>={$age} AND ".$not("CONCAT('attempted:', SUBSTR(COALESCE(o.px_updated,''),1,10))").' LIMIT 300') as $o) {
                $add('attempted', $o, 'attempted:'.substr((string) ($o['px_updated'] ?? ''), 0, 10));
            }
        }
        if ($this->truthy($R['delivered']['on'] ?? null)) {
            foreach (Db::all("SELECT o.* FROM orders o WHERE o.status='delivered' AND o.phone<>'' AND o.delivered_at>={$age} AND ".$not("'delivered'").' LIMIT 300') as $o) {
                $add('delivered', $o, 'delivered');
            }
        }
        try {
            if ($this->truthy($R['exchange']['on'] ?? null)) {
                foreach (Db::all("SELECT * FROM tk_exchanges WHERE step IN ('approved','dispatched','completed') AND updated_at>={$age} LIMIT 300") as $e) {
                    $ev = "exchange:{$e['id']}:{$e['step']}";
                    $oid = ($e['order_id'] ?? null) ?: 'exchange:'.$e['id'];
                    if (Db::get('SELECT 1 FROM ib_auto_log WHERE order_id=? AND event=?', $oid, $ev)) {
                        continue;
                    }
                    $o = $this->orderBy($e['order_id'] ?? null) ?? ['id' => $oid, 'name' => $e['order_name'] ?? null, 'cust_name' => $e['cust_name'] ?? null, 'phone' => $e['phone'] ?? null];
                    $add('exchange', array_merge($o, ['phone' => ($e['phone'] ?? null) ?: ($o['phone'] ?? null)]), $ev, ['key' => $oid, 'step' => self::EX_STEP[$e['step']] ?? $e['step']]);
                }
            }
            if ($this->truthy($R['refund']['on'] ?? null)) {
                foreach (Db::all("SELECT * FROM tk_refunds WHERE status='paid' AND method<>'Store credit' AND paid_at>={$age} LIMIT 300") as $r) {
                    $ev = 'refund:'.$r['id'];
                    $oid = ($r['order_id'] ?? null) ?: 'refund:'.$r['id'];
                    if (Db::get('SELECT 1 FROM ib_auto_log WHERE order_id=? AND event=?', $oid, $ev)) {
                        continue;
                    }
                    $o = $this->orderBy($r['order_id'] ?? null) ?? ['id' => $oid, 'name' => $r['order_name'] ?? null, 'cust_name' => $r['cust_name'] ?? null, 'phone' => $r['phone'] ?? null];
                    $add('refund', array_merge($o, ['phone' => ($r['phone'] ?? null) ?: ($o['phone'] ?? null)]), $ev, ['key' => $oid, 'amount' => $this->commas($r['amount'] ?? 0)]);
                }
            }
        } catch (QueryException|\PDOException) { /* tickets tables missing */
        }
        return $out;
    }

    /** Send due automatic messages. Service: runAuto() (= forced run). */
    public function runAuto(bool $force = true): array
    {
        $a = $this->autoCfg();
        $out = ['sent' => 0, 'queued' => 0, 'failed' => 0, 'skipped' => 0, 'quiet' => false, 'limit' => false, 'off' => false];
        if (! $this->truthy($a['on']) && ! $force) {
            $out['off'] = true;
            return $out;
        }
        if (! $this->waReady()) {
            $out['off'] = true;
            $out['error'] = 'WhatsApp not connected';
            return $out;
        }
        foreach ($this->candidates($a) as $c) { // record every new event once (idempotency): status 'queued'
            $valid = (bool) preg_match('/^92\d{10}$/', Logic::waNumber($c['order']['phone']));
            Db::run('INSERT IGNORE INTO ib_auto_log(order_id,event,rule,phone,status,error,created_at,at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())', $c['key'], $c['event'], $c['rule'], $c['order']['phone'], $valid ? 'queued' : 'skipped', $valid ? null : 'No valid mobile number');
            if (! $valid) {
                $out['skipped']++;
            }
            $row = Db::get('SELECT * FROM ib_auto_log WHERE order_id=? AND event=?', $c['key'], $c['event']);
            if ($row) {
                $this->cand[$row['id']] = $c;
            }
        }
        if ($this->quietNow($a)) {
            $out['quiet'] = true;
            $out['queued'] = (int) Db::val("SELECT COUNT(*) n FROM ib_auto_log WHERE status='queued'");
            $this->cand = [];
            return $out;
        }
        $dl = $this->jsNum($a['dailyLimit'] ?? null);
        $left = max(0, ((! is_nan($dl) && $dl) ? $dl : 500) - $this->sentToday());
        foreach (Db::all("SELECT * FROM ib_auto_log WHERE status='queued' ORDER BY id LIMIT 500") as $row) {
            if ($left <= 0) {
                $out['limit'] = true;
                break;
            }
            $rule = $a['rules'][$row['rule']] ?? null;
            if (! $rule) {
                Db::run("UPDATE ib_auto_log SET status='skipped', error='Unknown rule' WHERE id=?", $row['id']);
                continue;
            }
            if (! $this->truthy($rule['on'] ?? null)) {
                continue;
            }
            if (! Db::run("UPDATE ib_auto_log SET status='sending' WHERE id=? AND status='queued'", $row['id'])->changes) {
                continue; // claimed elsewhere
            }
            $c = $this->cand[$row['id']] ?? null;
            $o = ($c['order'] ?? null) ?: ($this->orderBy($row['order_id']) ?? ['id' => $row['order_id'], 'phone' => $row['phone']]);
            if ($row['rule'] === 'confirm' && ! $this->pendingOrder($this->orderBy($o['id']))) {
                Db::run("UPDATE ib_auto_log SET status='skipped', error='Order no longer waiting for confirmation', at=UTC_TIMESTAMP() WHERE id=?", $row['id']);
                $out['skipped']++;
                continue;
            }
            $extra = ($c['extra'] ?? null) ?: [];
            if ($row['rule'] === 'exchange' && empty($extra['step'])) {
                $extra['step'] = self::EX_STEP[explode(':', (string) $row['event'])[2] ?? ''] ?? '';
            }
            $full = array_key_exists('cust_name', $o) && array_key_exists('total', $o) ? $o : ($this->orderBy($o['id']) ?? $o);
            $v = $this->vars($full, $extra);
            $tpl = $this->findTemplate($rule['template'] ?? null) ?? [];
            $plist = ! empty($rule['params']) && is_array($rule['params']) ? $rule['params'] : $this->arr($tpl['params'] ?? []);
            $params = array_map(fn ($x) => $this->fill($x, $v), $plist);
            $buttons = $row['rule'] === 'confirm' && ($rule['payloads'] ?? null) !== false ? [['payload' => 'CONFIRM:'.$o['id'], 'index' => 0], ['payload' => 'CANCEL:'.$o['id'], 'index' => 1]] : [];
            try {
                $this->failedMsgId = null;
                $mid = $this->sendWhatsApp(($row['phone'] ?? null) ?: ($o['phone'] ?? null), ['template' => $rule['template'], 'params' => $params, 'lang' => ($rule['lang'] ?? null) ?: ($tpl['lang'] ?? null), 'buttons' => $buttons], null,
                    ['auto' => $row['rule'], 'order_id' => $this->orderBy($o['id']) ? $o['id'] : null, 'name' => $o['cust_name'] ?? null, 'convStatus' => 'closed']);
                Db::run("UPDATE ib_auto_log SET status='sent', msg_id=?, error=NULL, at=UTC_TIMESTAMP() WHERE id=?", $mid, $row['id']);
                $out['sent']++;
                $left--;
            } catch (\Throwable $e) {
                if ($e instanceof HttpError && $e->status === 402) {
                    Db::run("UPDATE ib_auto_log SET status='queued', error=?, msg_id=? WHERE id=?", $e->getMessage(), $this->failedMsgId, $row['id']);
                    $out['limit'] = true;
                    break;
                }
                Db::run("UPDATE ib_auto_log SET status='failed', error=?, msg_id=?, at=UTC_TIMESTAMP() WHERE id=?", mb_substr($e->getMessage(), 0, 300), $this->failedMsgId, $row['id']);
                $out['failed']++;
            }
        }
        $this->cand = [];
        return $out;
    }

    /* ================================================================ inbox API (perm inbox) */

    private function agents(): array
    {
        $out = [];
        foreach (Db::all('SELECT id,name,username,role,perms FROM users WHERE active=1 ORDER BY name') as $x) {
            if (in_array('inbox', Access::userPerms($x), true)) {
                $out[] = ['id' => (int) $x['id'], 'name' => $x['name']];
            }
        }
        return $out;
    }

    /** u given -> staff limited to their channels (inbox_wa / inbox_ig) get 404 for other channels' conversations */
    private function getC($id, ?array $u): array
    {
        $c = Db::get('SELECT * FROM ib_convs WHERE id=?', (int) $id);
        $this->need($c, 'Conversation not found', 404);
        $sc = $u ? $this->chanScope($u) : null;
        $this->need(! $sc || in_array($c['channel'], $sc, true), 'Conversation not found', 404);
        return $c;
    }

    private function windowOpen(array $c): bool
    {
        $t = $this->parseUtc($c['last_in_at'] ?? null);
        return ! empty($c['last_in_at']) && $t !== null && $this->nowMs() - $t < 24 * 3600e3;
    }

    private function userName($id): string
    {
        if (! $id) {
            return 'nobody';
        }
        return (Db::get('SELECT name FROM users WHERE id=?', $id)['name'] ?? null) ?: '#'.$id;
    }

    public function meta(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        return [
            'agents' => $this->agents(),
            'templates' => array_map(fn ($t) => ['name' => $t['name'] ?? null, 'lang' => $t['lang'] ?? null, 'params' => ($t['params'] ?? null) ?: [], 'text' => $t['text'] ?? null, 'buttons' => ($t['buttons'] ?? null) ?: []], $this->templates()),
            'quick' => $this->quick(),
            'channels' => ['wa' => $this->waReady(), 'ig' => $this->igReady(), 'form' => true], 'allowed' => $this->chanScope($u), 'canAdmin' => $this->isAdmin($u),
            'ticketTypes' => self::TICKET_TYPES, 'channelLabels' => self::CHANNEL_L, 'canOrders' => $this->can($u, 'orders'), 'canTickets' => $this->can($u, 'tickets'),
        ];
    }

    public function listConvs(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = [];
        $a = [];
        $v = ($qs['view'] ?? null) ?: 'open';
        if ($v === 'open') {
            $w[] = "c.status<>'closed'";
        } elseif ($v === 'mine') {
            $w[] = "c.status<>'closed' AND c.assignee=?";
            $a[] = $u['id'];
        } elseif ($v === 'unassigned') {
            $w[] = "c.status<>'closed' AND c.assignee IS NULL";
        } elseif ($v === 'pending') {
            $w[] = "c.status='pending'";
        } elseif ($v === 'closed') {
            $w[] = "c.status='closed'";
        }
        if (! empty($qs['channel'])) {
            $w[] = 'c.channel=?';
            $a[] = (string) $qs['channel'];
        }
        $sc = $this->chanScope($u);
        $scw = $sc ? 'channel IN ('.Db::marks($sc).')' : '1=1';
        if ($sc) {
            $w[] = 'c.'.$scw;
            array_push($a, ...$sc);
        }
        if (($qs['unread'] ?? null) === '1') {
            $w[] = 'c.unread>0';
        }
        if (! empty($qs['q']) && is_string($qs['q'])) {
            $s = trim($qs['q']);
            $t = '%'.$s.'%';
            $ph = Logic::normPhone($s);
            $w[] = '(c.name LIKE ? OR c.handle LIKE ? OR c.last_text LIKE ?'.(strlen($ph) >= 6 ? ' OR c.phone LIKE ?' : '').' OR c.id IN (SELECT conv_id FROM (SELECT conv_id FROM ib_msgs WHERE body LIKE ? ORDER BY id DESC LIMIT 500) mq))';
            array_push($a, $t, $t, $t);
            if (strlen($ph) >= 6) {
                $a[] = '%'.$ph.'%';
            }
            $a[] = $t;
        }
        $where = $w ? 'WHERE '.implode(' AND ', $w) : '';
        $pg = $this->page($qs, 60);
        $rows = Db::all("SELECT c.*, us.name assignee_name, cu.label clabel FROM ib_convs c LEFT JOIN users us ON us.id=c.assignee LEFT JOIN customers cu ON cu.phone=c.phone {$where} ORDER BY c.last_at DESC, c.id DESC LIMIT ? OFFSET ?", ...array_merge($a, [$pg['limit'], $pg['offset']]));
        $now = $this->nowMs();
        foreach ($rows as &$r) {
            $r['phone'] = $this->mask($u, $r['phone']);
            $r['window'] = $r['channel'] === 'wa' ? $this->windowOpen($r) : null;
            // JS: status!=='closed' && last_dir==='in' && last_in_at && (now - last_in_at > 1h)
            if ($r['status'] === 'closed' || $r['last_dir'] !== 'in') {
                $r['waiting'] = false;
            } elseif (! $r['last_in_at']) {
                $r['waiting'] = $r['last_in_at'];
            } else {
                $t = $this->parseUtc($r['last_in_at']);
                $r['waiting'] = $t !== null && $now - $t > 3600e3;
            }
        }
        unset($r);
        $total = (int) Db::val("SELECT COUNT(*) n FROM ib_convs c {$where}", ...$a);
        $counts = Db::get("SELECT SUM(status<>'closed') `open`, SUM(status<>'closed' AND assignee=?) mine, SUM(status<>'closed' AND assignee IS NULL) unassigned, SUM(status='pending') pending, SUM(status='closed') closed,
        SUM(status<>'closed' AND unread>0) unread FROM ib_convs WHERE {$scw}", $u['id'], ...($sc ?: []));
        foreach ($counts as $k => $x) {
            $counts[$k] = $x ?: 0;
        }
        return ['rows' => $rows, 'total' => $total, 'page' => $pg['page'], 'pages' => (int) ceil($total / $pg['limit']), 'counts' => $counts];
    }

    private function customerPanel(array $c, ?array $u): ?array
    {
        $ph = $c['phone'];
        if (! $ph) {
            return null;
        }
        $orders = Db::all("SELECT o.id,o.name,o.created_at,o.total,o.status,o.stage,o.tracking,o.courier,o.city,o.px_status,(SELECT GROUP_CONCAT(title SEPARATOR ' + ') FROM order_items WHERE order_id=o.id) items_text FROM orders o WHERE o.phone=? ORDER BY o.created_at DESC LIMIT 30", $ph);
        $tickets = [];
        try {
            $tickets = Db::all('SELECT id,type,status,subject,created_at,order_name FROM tk_tickets WHERE phone=? ORDER BY id DESC LIMIT 20', $ph);
        } catch (QueryException|\PDOException) {
        }
        $cust = Db::get('SELECT name,label,orders,delivered,returned,cancelled,spent FROM customers WHERE phone=?', $ph);
        return ['phone' => $this->mask($u, $ph), 'wa' => Logic::waNumber($ph), 'customer' => $cust ?: null, 'orders' => $orders, 'tickets' => $tickets];
    }

    public function showConv(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        if (($qs['read'] ?? null) !== '0' && $c['unread']) {
            Db::run('UPDATE ib_convs SET unread=0 WHERE id=?', $c['id']);
            $c['unread'] = 0;
        }
        $msgs = array_reverse(Db::all('SELECT m.*, us.name `user` FROM ib_msgs m LEFT JOIN users us ON us.id=m.user_id WHERE m.conv_id=? ORDER BY m.id DESC LIMIT 300', $c['id']));
        foreach ($msgs as &$m) {
            $m['payload'] = $this->J($m['payload'], null);
        }
        unset($m);
        $lastOrder = null;
        foreach (array_reverse($msgs) as $m) {
            if (! empty($m['order_id'])) {
                $lastOrder = $m;
                break;
            }
        }
        $cust = $this->customerPanel($c, $u);
        $lt = $this->parseUtc($c['last_in_at']);
        $conv = array_merge($c, [
            'phone' => $this->mask($u, $c['phone']),
            'assignee_name' => $c['assignee'] ? $this->userName($c['assignee']) : null,
            'window' => $c['channel'] === 'wa' || $c['channel'] === 'ig' ? $this->windowOpen($c) : null,
            'window_until' => $c['last_in_at'] && $lt !== null ? $this->utc($lt + 24 * 3600e3) : null,
            'channel_label' => self::CHANNEL_L[$c['channel']] ?? null,
        ]);
        $wa = $c['channel'] !== 'wa' && $c['phone'] ? Db::get("SELECT id FROM ib_convs WHERE channel='wa' AND ext_id=?", Logic::waNumber($c['phone'])) : null;
        return ['conv' => $conv, 'msgs' => $msgs, 'customer' => $cust,
            'order_hint' => $lastOrder ? $lastOrder['order_id'] : ($cust && ! empty($cust['orders'][0]) ? $cust['orders'][0]['id'] : null), 'wa_conv' => $wa ? $wa['id'] : null];
    }

    public function reply(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        $tplName = $this->truthy($b['template'] ?? null) ? $b['template'] : null;
        if ($c['channel'] === 'wa') {
            if ($tplName !== null) {
                $mid = $this->sendWhatsApp($c['ext_id'], ['template' => $this->jsStr($tplName), 'params' => is_array($b['params'] ?? null) && array_is_list($b['params']) ? $b['params'] : [], 'lang' => $b['lang'] ?? null], $u['id'],
                    ['conv' => $c, 'order_id' => ($b['order_id'] ?? null) ?: null]);
            } else {
                $this->need($this->windowOpen($c), 'The 24-hour WhatsApp window is closed. The customer has not messaged in the last 24 hours, so pick an approved template.');
                $mid = $this->sendWhatsApp($c['ext_id'], $this->truthy($b['image'] ?? null) ? ['image' => $b['image'], 'caption' => $b['text'] ?? null] : ['text' => $b['text'] ?? null], $u['id'], ['conv' => $c]);
            }
        } elseif ($c['channel'] === 'ig' || $c['channel'] === 'igc') {
            $text = trim($this->jsStr(($b['text'] ?? null) ?: ''));
            $this->need($text !== '', 'Write a message');
            $cfg = $this->igCfg();
            $acct = $this->jsStr(($cfg['igId'] ?? null) ?: 'me');
            if ($c['channel'] === 'ig') {
                $r = $this->graph('POST', $acct.'/messages', ['recipient' => ['id' => $c['ext_id']], 'message' => ['text' => $text]]);
                $mid = $this->addMsg((int) $c['id'], ['dir' => 'out', 'body' => $text, 'ext_id' => ! empty($r['message_id']) ? $this->jsStr($r['message_id']) : null, 'status' => 'sent', 'user_id' => $u['id']]);
            } else {
                $last = Db::get("SELECT * FROM ib_msgs WHERE conv_id=? AND dir='in' AND ext_id IS NOT NULL ORDER BY id DESC LIMIT 1", $c['id']);
                $this->need($last, 'No comment to reply to');
                if (($b['mode'] ?? null) === 'private') {
                    $r = $this->graph('POST', $acct.'/messages', ['recipient' => ['comment_id' => $last['ext_id']], 'message' => ['text' => $text]]);
                    $mid = $this->addMsg((int) $c['id'], ['dir' => 'out', 'kind' => 'private', 'body' => $text, 'ext_id' => ! empty($r['message_id']) ? $this->jsStr($r['message_id']) : null, 'status' => 'sent', 'user_id' => $u['id'], 'note' => 'Private reply (DM)']);
                } else {
                    $r = $this->graph('POST', $last['ext_id'].'/replies', ['message' => $text]);
                    $mid = $this->addMsg((int) $c['id'], ['dir' => 'out', 'kind' => 'comment', 'body' => $text, 'ext_id' => ! empty($r['id']) ? $this->jsStr($r['id']) : null, 'status' => 'sent', 'user_id' => $u['id'], 'note' => 'Public reply']);
                }
            }
        } else {
            throw new HttpError(400, 'Form requests cannot be answered here. Use "WhatsApp customer" to message them.');
        }
        if (! $c['assignee']) {
            Db::run('UPDATE ib_convs SET assignee=? WHERE id=?', $u['id'], $c['id']);
        }
        Db::run("UPDATE ib_convs SET unread=0, status=CASE WHEN status='closed' THEN 'open' ELSE status END WHERE id=?", $c['id']);
        $detail = ['channel' => $c['channel']];
        if ($tplName !== null) {
            $detail['template'] = $tplName;
        }
        $this->log($u['id'], $tplName !== null ? 'inbox.template' : 'inbox.reply', 'inbox:'.$c['id'], $detail);
        return ['ok' => true, 'id' => $mid];
    }

    public function assign(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        // JS: to = b.user_id ? +b.user_id : null; if (to) need(agents().some(a => a.id === to))
        $n = $this->truthy($b['user_id'] ?? null) ? $this->jsNum($b['user_id']) : null;
        $to = $n === null || is_nan($n) || $n == 0 ? null : $this->numOut($n);
        if ($to !== null) {
            $this->need(in_array($to, array_column($this->agents(), 'id'), true), 'That person has no inbox access');
        }
        Db::run('UPDATE ib_convs SET assignee=? WHERE id=?', $to, $c['id']);
        $this->log($u['id'], 'inbox.assign', 'inbox:'.$c['id'], ['to' => $this->userName($to)]);
        return ['ok' => true];
    }

    public function setStatus(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        $st = $b['status'] ?? null;
        $this->need(in_array($st, ['open', 'pending', 'closed'], true), 'Unknown status');
        Db::run("UPDATE ib_convs SET status=?, unread=CASE WHEN ?='closed' THEN 0 ELSE unread END WHERE id=?", $st, $st, $c['id']);
        $this->log($u['id'], $st === 'closed' ? 'inbox.close' : ($st === 'open' && $c['status'] === 'closed' ? 'inbox.reopen' : 'inbox.status'), 'inbox:'.$c['id'], ['from' => $c['status'], 'to' => $st]);
        return ['ok' => true];
    }

    public function setPhone(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        $ph = Logic::normPhone(($b['phone'] ?? null) ?: '');
        $this->need(! $this->truthy($b['phone'] ?? null) || strlen($ph) === 11, 'Enter a mobile number like 03001234567');
        $this->need($c['channel'] !== 'wa', 'WhatsApp conversations already have the phone number');
        Db::run('UPDATE ib_convs SET phone=? WHERE id=?', $ph ?: null, $c['id']);
        $this->log($u['id'], 'inbox.link', 'inbox:'.$c['id'], ['phone' => $ph]);
        return ['ok' => true];
    }

    public function makeTicket(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->getC($p['id'], $u);
        $tickets = $this->svc('tickets');
        $this->need($tickets, 'Tickets module is not available');
        $msgs = array_values(array_filter(array_reverse(array_column(Db::all("SELECT body FROM ib_msgs WHERE conv_id=? AND dir='in' ORDER BY id DESC LIMIT 5", $c['id']), 'body')), fn ($x) => $this->truthy($x)));
        $id = $tickets->create([
            'type' => in_array($b['type'] ?? null, self::TICKET_TYPES, true) ? $b['type'] : 'Order inquiry',
            'channel' => self::TICKET_CH[$c['channel']] ?? null,
            'order_id' => ($b['order_id'] ?? null) ?: null,
            'phone' => ($b['phone'] ?? null) ?: (($c['phone'] ?? null) ?: ''),
            'cust_name' => ($c['name'] ?? null) ?: '',
            'priority' => $b['priority'] ?? null,
            'subject' => $b['subject'] ?? null,
            'note' => isset($b['note']) ? $this->jsStr($b['note']) : implode("\n", $msgs),
        ], $u['id']);
        Db::run('UPDATE ib_convs SET ticket_id=? WHERE id=?', $id, $c['id']);
        $this->log($u['id'], 'inbox.ticket', 'inbox:'.$c['id'], ['ticket' => $id]);
        return ['id' => $id];
    }

    public function openWa(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $ph = Logic::normPhone(($b['phone'] ?? null) ?: '');
        $this->need(preg_match('/^03\d{9}$/', $ph), 'Enter a mobile number like 03001234567');
        $sc = $this->chanScope($u);
        $this->need(! $sc || in_array('wa', $sc, true), 'You can only use Instagram messages', 403);
        $c = $this->getConv('wa', Logic::waNumber($ph), ['phone' => $ph, 'name' => ($b['name'] ?? null) ?: null]);
        return ['id' => $c['id']];
    }

    /* ================================================================ settings (perm inbox_admin) */

    private function baseUrl(Request $req): string
    {
        $pub = $this->setting('inbox.public_url', '');
        $proto = $req->header('x-forwarded-proto') ?: ($req->isSecure() ? 'https' : 'http');
        $host = $req->header('x-forwarded-host') ?: ($req->header('host') ?: 'localhost');
        return preg_replace('#/+$#', '', $pub ?: "{$proto}://{$host}");
    }

    private function lastHook(string $src): ?array
    {
        return Db::get('SELECT at, ok, note FROM ib_hooks WHERE src=? ORDER BY id DESC LIMIT 1', $src);
    }

    private function lastOk(string $src)
    {
        return Db::val('SELECT at FROM ib_hooks WHERE src=? AND ok=1 ORDER BY id DESC LIMIT 1', $src);
    }

    public function settingsGet(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $w = $this->waCfg();
        $i = $this->igCfg();
        $f = $this->formCfg();
        $base = $this->baseUrl($req);
        $questions = [];
        foreach (Db::all('SELECT answers FROM ib_forms ORDER BY id DESC LIMIT 20') as $r) {
            foreach (array_keys($this->arr($this->J($r['answers'], []))) as $k) {
                $questions[(string) $k] = true;
            }
        }
        return [
            'publicUrl' => $this->setting('inbox.public_url', ''), 'base' => $base,
            'wa' => ['url' => $w['url'], 'bearer' => ($w['bearer'] ?? true) !== false, 'hasToken' => $this->truthy($w['token'] ?? null), 'connectedAt' => ($w['connectedAt'] ?? null) ?: null],
            'ig' => ['appId' => ($i['appId'] ?? null) ?: '', 'igId' => ($i['igId'] ?? null) ?: '', 'version' => $i['version'], 'graphUrl' => $i['graphUrl'], 'hasSecret' => $this->truthy($i['appSecret'] ?? null),
                'hasToken' => $this->truthy($i['token'] ?? null), 'verifyToken' => $i['verifyToken'] ?? null],
            'form' => ['map' => (object) $this->arr($f['map'] ?? []), 'ack' => $this->truthy($f['ack'] ?? null), 'ackTemplate' => $f['ackTemplate'] ?? null,
                'fields' => array_map(fn ($k) => [$k, self::FIELD_L[$k]], self::FIELDS),
                'recent' => Db::all('SELECT id, form, submitted_at, phone, ticket_id, error, at FROM ib_forms ORDER BY id DESC LIMIT 10'),
                'questions' => array_map('strval', array_keys($questions))],
            'auto' => $this->autoCfg(), 'templates' => $this->templates(), 'quick' => $this->quick(),
            'urls' => ['cequens' => "{$base}/api/hooks/cequens?key=".$this->tl($w['key'] ?? null), 'instagram' => "{$base}/api/hooks/instagram", 'form' => "{$base}/api/hooks/google-form?key=".$this->tl($f['key'] ?? null)],
            'last' => ['cequens' => $this->lastHook('cequens'), 'instagram' => $this->lastHook('instagram'), 'form' => $this->lastHook('form')],
            'errors' => ['wa' => $this->setting('inbox.wa_error', null), 'ig' => $this->setting('inbox.ig_error', null)],
            'stats' => ['sentToday' => $this->sentToday(), 'queued' => (int) Db::val("SELECT COUNT(*) n FROM ib_auto_log WHERE status='queued'"), 'quiet' => $this->quietNow($this->autoCfg())],
        ];
    }

    public function settingsSave(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        if (array_key_exists('publicUrl', $b)) {
            $v = preg_replace('#/+$#', '', trim($this->jsStr(($b['publicUrl'] ?? null) ?: '')));
            $this->need($v === '' || preg_match('#^https?://[^\s]+$#', $v), 'The ERP address must start with https://');
            $this->setSetting('inbox.public_url', $v);
        }
        if ($this->truthy($b['wa'] ?? null) && is_array($b['wa'])) {
            $bw = $b['wa'];
            $nx = $this->arr($this->setting('inbox.wa', []));
            if (array_key_exists('url', $bw)) {
                $v = trim($this->jsStr(($bw['url'] ?? null) ?: ''));
                $this->need($v === '' || preg_match('#^https?://#', $v), 'API URL must start with https://');
                $nx['url'] = $v;
            }
            if (array_key_exists('bearer', $bw)) {
                $nx['bearer'] = $this->truthy($bw['bearer']);
            }
            if ($this->truthy($bw['token'] ?? null)) {
                $nx['token'] = trim($this->jsStr($bw['token']));
                $nx['connectedAt'] = $this->utc();
            }
            if ($this->truthy($bw['clearToken'] ?? null)) {
                $nx['token'] = '';
                $nx['connectedAt'] = null;
            }
            if ($this->truthy($bw['newKey'] ?? null)) {
                $nx['key'] = $this->rnd(16);
            }
            $this->setSetting('inbox.wa', (object) $nx);
        }
        if ($this->truthy($b['ig'] ?? null) && is_array($b['ig'])) {
            $bi = $b['ig'];
            $nx = $this->arr($this->setting('inbox.ig', []));
            foreach (['appId', 'igId', 'version', 'graphUrl'] as $k) {
                if (array_key_exists($k, $bi)) {
                    $nx[$k] = trim($this->jsStr(($bi[$k] ?? null) ?: ''));
                }
            }
            if ($this->truthy($nx['version'] ?? null) && ! preg_match('/^v\d+\.\d+$/', (string) $nx['version'])) {
                $this->need(false, 'Graph version looks like v21.0');
            }
            if ($this->truthy($bi['appSecret'] ?? null)) {
                $nx['appSecret'] = trim($this->jsStr($bi['appSecret']));
            }
            if ($this->truthy($bi['token'] ?? null)) {
                $nx['token'] = trim($this->jsStr($bi['token']));
            }
            if ($this->truthy($bi['clearToken'] ?? null)) {
                $nx['token'] = '';
            }
            if ($this->truthy($bi['verifyToken'] ?? null)) {
                $nx['verifyToken'] = trim($this->jsStr($bi['verifyToken']));
            }
            $this->setSetting('inbox.ig', (object) $nx);
        }
        if ($this->truthy($b['form'] ?? null) && is_array($b['form'])) {
            $bf = $b['form'];
            $nx = $this->arr($this->setting('inbox.form', []));
            if ($this->truthy($bf['map'] ?? null) && is_array($bf['map'])) {
                $map = [];
                foreach (self::FIELDS as $k) {
                    if ($this->truthy($bf['map'][$k] ?? null)) {
                        $map[$k] = trim($this->jsStr($bf['map'][$k]));
                    }
                }
                $nx['map'] = (object) $map;
            }
            if (array_key_exists('ack', $bf)) {
                $nx['ack'] = $this->truthy($bf['ack']);
            }
            if ($this->truthy($bf['ackTemplate'] ?? null)) {
                $nx['ackTemplate'] = $this->jsStr($bf['ackTemplate']);
            }
            if ($this->truthy($bf['newKey'] ?? null)) {
                $nx['key'] = $this->rnd(16);
            }
            $this->setSetting('inbox.form', (object) $nx);
        }
        if ($this->truthy($b['auto'] ?? null) && is_array($b['auto'])) {
            $ba = $b['auto'];
            $cur = $this->arr($this->setting('inbox.auto', []));
            $nx = array_merge($cur, ['rules' => $this->arr($cur['rules'] ?? [])]);
            foreach (['on', 'bot'] as $k) {
                if (array_key_exists($k, $ba)) {
                    $nx[$k] = $this->truthy($ba[$k]);
                }
            }
            foreach (['quietFrom', 'quietTo'] as $k) {
                if (array_key_exists($k, $ba)) {
                    $v = $this->jsNum($ba[$k]);
                    $this->need($v >= 0 && $v <= 23, 'Quiet hours must be 0–23');
                    $nx[$k] = $this->numOut($v);
                }
            }
            if (array_key_exists('dailyLimit', $ba)) {
                $v = $this->jsNum($ba['dailyLimit']);
                $this->need($v >= 0 && $v <= 100000, 'Daily limit must be a number');
                $nx['dailyLimit'] = $this->numOut($v);
            }
            if (array_key_exists('maxAgeHours', $ba)) {
                $v = $this->jsNum($ba['maxAgeHours']);
                $this->need($v >= 1 && $v <= 720, 'Max age must be 1–720 hours');
                $nx['maxAgeHours'] = $this->numOut($v);
            }
            foreach (['confirmReply', 'cancelReply'] as $k) {
                if (array_key_exists($k, $ba)) {
                    $nx[$k] = mb_substr($this->jsStr(($ba[$k] ?? null) ?: ''), 0, 1000);
                }
            }
            foreach ($this->arr($ba['rules'] ?? []) as $k => $r) {
                if (! isset(self::RULES[$k]) || ! $this->truthy($r) || ! is_array($r)) {
                    continue;
                }
                $x = $this->arr($nx['rules'][$k] ?? []);
                if (array_key_exists('on', $r)) {
                    $x['on'] = $this->truthy($r['on']);
                }
                if ($this->truthy($r['template'] ?? null)) {
                    $x['template'] = trim($this->jsStr($r['template']));
                }
                if ($this->truthy($r['lang'] ?? null)) {
                    $x['lang'] = trim($this->jsStr($r['lang']));
                }
                if (is_array($r['params'] ?? null) && array_is_list($r['params'])) {
                    $x['params'] = array_map(fn ($s) => mb_substr($this->jsStr($s), 0, 200), $r['params']);
                }
                if (array_key_exists('payloads', $r)) {
                    $x['payloads'] = $this->truthy($r['payloads']);
                }
                $nx['rules'][$k] = (object) $x;
            }
            $nx['rules'] = (object) $nx['rules'];
            $this->setSetting('inbox.auto', (object) $nx);
        }
        if (is_array($b['templates'] ?? null) && array_is_list($b['templates'])) {
            $list = [];
            foreach ($b['templates'] as $t) {
                if (! is_array($t) || ! preg_match('/^[a-z0-9_]+$/', $this->jsStr(($t['name'] ?? null) ?: ''))) {
                    continue;
                }
                $list[] = ['name' => $t['name'], 'lang' => $this->jsStr(($t['lang'] ?? null) ?: 'en'), 'category' => ($t['category'] ?? null) ?: 'Utility',
                    'params' => array_map(fn ($x) => $this->jsStr($x), array_values($this->arr($t['params'] ?? []))), 'text' => mb_substr($this->jsStr(($t['text'] ?? null) ?: ''), 0, 1024),
                    'buttons' => array_slice(array_map(fn ($x) => $this->jsStr($x), array_values($this->arr($t['buttons'] ?? []))), 0, 3)];
            }
            $this->setSetting('inbox.templates', $list);
        }
        if (is_array($b['quick'] ?? null) && array_is_list($b['quick'])) {
            $list = [];
            foreach ($b['quick'] as $x) {
                if (is_array($x) && $this->truthy($x['title'] ?? null) && $this->truthy($x['body'] ?? null)) {
                    $list[] = ['title' => mb_substr($this->jsStr($x['title']), 0, 60), 'body' => mb_substr($this->jsStr($x['body']), 0, 1000)];
                }
            }
            $this->setSetting('inbox.quick', $list);
        }
        $this->log($u['id'], 'inbox.settings', 'settings', array_map('strval', array_keys($b)));
        return ['ok' => true];
    }

    public function testWa(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $this->need($this->truthy($b['phone'] ?? null), 'Enter your own WhatsApp number to test');
        $spec = $this->truthy($b['template'] ?? null)
            ? ['template' => $b['template'], 'params' => ($b['params'] ?? null) ?: [], 'lang' => $b['lang'] ?? null]
            : ['text' => ($b['text'] ?? null) ?: 'Test message from SundayBazar ERP'];
        $id = $this->sendWhatsApp($b['phone'], $spec, $u['id']);
        return ['ok' => true, 'id' => $id, 'msg' => Db::get('SELECT ext_id, status FROM ib_msgs WHERE id=?', $id)];
    }

    public function testIg(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $c = $this->igCfg();
        $r = $this->graph('GET', $this->jsStr(($c['igId'] ?? null) ?: 'me').'?fields=id,username,name');
        return ['ok' => true, 'account' => (object) $r];
    }

    public function hooksList(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $src = ! empty($qs['src']) ? (string) $qs['src'] : null;
        return Db::all('SELECT id, src, ok, note, SUBSTR(body,1,4000) body, at FROM ib_hooks '.($src !== null ? 'WHERE src=? ' : '').'ORDER BY id DESC LIMIT 100', ...($src !== null ? [$src] : []));
    }

    public function autoRun(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $r = $this->runAuto(true);
        $this->log($u['id'], 'inbox.autorun', 'inbox', $r);
        return $r;
    }

    public function autoLog(?array $u, array $b, array $p, array $qs, Request $req): array
    {
        $st = ! empty($qs['status']) ? (string) $qs['status'] : null;
        $counts = [];
        foreach (Db::all('SELECT status, COUNT(*) n FROM ib_auto_log GROUP BY status') as $r) {
            $counts[(string) $r['status']] = $r['n'];
        }
        return [
            'rows' => Db::all('SELECT l.*, o.name order_name, o.cust_name, m.status msg_status FROM ib_auto_log l LEFT JOIN orders o ON o.id=l.order_id LEFT JOIN ib_msgs m ON m.id=l.msg_id '.($st !== null ? 'WHERE l.status=? ' : '').'ORDER BY l.id DESC LIMIT 200', ...($st !== null ? [$st] : [])),
            'counts' => (object) $counts,
            'bot' => Db::get("SELECT SUM(outcome='confirmed') confirmed, SUM(outcome='cancelled') cancelled FROM cs_calls WHERE user_id IS NULL AND note LIKE 'WhatsApp bot%' AND DATE(at + INTERVAL 5 HOUR)=?", $this->pkToday()),
        ];
    }

    /* ================================================================ services */

    public function summary(): array
    {
        $c = Db::get("SELECT SUM(status<>'closed') `open`, SUM(status<>'closed' AND unread>0) unread, SUM(status<>'closed' AND last_dir='in' AND last_in_at<(UTC_TIMESTAMP() - INTERVAL 1 HOUR)) waiting FROM ib_convs");
        return ['open' => $c['open'] ?: 0, 'unread' => $c['unread'] ?: 0, 'waitingOver1h' => $c['waiting'] ?: 0, 'autoSentToday' => $this->sentToday(),
            'confirmedByBot' => (int) Db::val("SELECT COUNT(*) n FROM cs_calls WHERE user_id IS NULL AND outcome='confirmed' AND note LIKE 'WhatsApp bot%' AND DATE(at + INTERVAL 5 HOUR)=?", $this->pkToday())];
    }

    /* ================================================================ sidebar counts & alerts */

    public function counts(array $u): array
    {
        if (! $this->can($u, 'inbox')) {
            return [];
        }
        $sc = $this->chanScope($u);
        $scw = $sc ? ' AND channel IN ('.Db::marks($sc).')' : '';
        return ['inbox' => (int) Db::val("SELECT COUNT(*) n FROM ib_convs WHERE status<>'closed' AND unread>0 AND (assignee=? OR assignee IS NULL)".$scw, $u['id'], ...($sc ?: []))];
    }

    public function alerts(array $u): array
    {
        $out = [];
        if (! $this->can($u, 'inbox')) {
            return $out;
        }
        $sc = $this->chanScope($u);
        $scw = $sc ? ' AND channel IN ('.Db::marks($sc).')' : '';
        $n = (int) Db::val("SELECT COUNT(*) n FROM ib_convs WHERE status<>'closed' AND last_dir='in' AND last_in_at<(UTC_TIMESTAMP() - INTERVAL 1 HOUR) AND (assignee=? OR assignee IS NULL)".$scw, $u['id'], ...($sc ?: []));
        if ($n) {
            $out[] = ['level' => 'warn', 'text' => "{$n} customer message".($n > 1 ? 's' : '').' waiting more than 1 hour for a reply', 'href' => '#/inbox'];
        }
        if ($this->can($u, 'inbox_admin')) {
            $wa = $this->waCfg();
            $lastOkWa = $this->lastOk('cequens');
            $waErr = $this->setting('inbox.wa_error', null);
            $igErr = $this->setting('inbox.ig_error', null);
            $day = $this->nowMs() - 24 * 3600e3;
            $ca = $this->parseUtc($wa['connectedAt'] ?? null);
            $lo = $this->parseUtc($lastOkWa);
            if ($this->waReady() && ! empty($wa['connectedAt']) && $ca !== null && $ca < $day && (! $lastOkWa || ($lo !== null && $lo < $day))) {
                $out[] = ['level' => 'warn', 'text' => 'WhatsApp: nothing received from CEQUENS for 24+ hours. Check the webhook URL with CEQUENS support.', 'href' => '#/inbox/settings/wa'];
            }
            if (is_array($waErr) && ($t = $this->parseUtc($waErr['at'] ?? null)) !== null && $t > $day) {
                $out[] = ['level' => ($waErr['code'] ?? null) === 402 ? 'bad' : 'warn', 'text' => 'WhatsApp sending problem: '.$this->tl($waErr['msg'] ?? null), 'href' => '#/inbox/settings/wa'];
            }
            if (is_array($igErr) && ($t = $this->parseUtc($igErr['at'] ?? null)) !== null && $t > $day) {
                $out[] = ['level' => 'warn', 'text' => 'Instagram problem: '.$this->tl($igErr['msg'] ?? null), 'href' => '#/inbox/settings/ig'];
            }
        }
        return $out;
    }
}
