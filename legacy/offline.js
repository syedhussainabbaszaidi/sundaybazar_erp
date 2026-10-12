<script>var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
/* Offline mode: runs the ERP server code inside the browser.
   Node built-ins are replaced by small stand-ins, the database is SQLite compiled to WebAssembly,
   and every /api/ request from the app is answered here instead of over the network. */
(function () {
    'use strict';
    window.SB_OFFLINE = true;
    const enc = new TextEncoder(), dec = new TextDecoder();
    /* --- Buffer (only what the server code uses) --- */
    class Buf extends Uint8Array {
        toString(e) { if (e === 'hex')
            return Array.from(this, b => b.toString(16).padStart(2, '0')).join(''); return dec.decode(this); }
        static from(v, e) { if (e === 'base64') {
            const bin = atob(v), a = new Buf(bin.length);
            for (let i = 0; i < bin.length; i++)
                a[i] = bin.charCodeAt(i);
            return a;
        } if (e === 'hex') {
            const a = new Buf(v.length / 2);
            for (let i = 0; i < a.length; i++)
                a[i] = parseInt(v.substr(i * 2, 2), 16);
            return a;
        } if (typeof v === 'string') {
            const u = enc.encode(v);
            const b = new Buf(u.length);
            b.set(u);
            return b;
        } const b = new Buf(v.length); b.set(v); return b; }
        static concat(list) { const n = list.reduce((s, x) => s + x.length, 0), b = new Buf(n); let o = 0; for (const x of list) {
            b.set(x, o);
            o += x.length;
        } return b; }
    }
    window.Buffer = Buf;
    /* --- SHA-256 (sync), used instead of scrypt for local passwords --- */
    function sha256(bytes) {
        const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
        const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
        m.set(bytes);
        m[l] = 0x80;
        const dv = new DataView(m.buffer);
        dv.setUint32(n - 4, l * 8);
        dv.setUint32(n - 8, Math.floor(l / 0x20000000));
        const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
        for (let o = 0; o < n; o += 64) {
            for (let i = 0; i < 16; i++)
                w[i] = dv.getUint32(o + i * 4);
            for (let i = 16; i < 64; i++) {
                const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }
            let [a, b, c, d, e, f, g, h] = H;
            for (let i = 0; i < 64; i++) {
                const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                h = g;
                g = f;
                f = e;
                e = (d + t1) | 0;
                d = c;
                c = b;
                b = a;
                a = (t1 + t2) | 0;
            }
            H[0] += a;
            H[1] += b;
            H[2] += c;
            H[3] += d;
            H[4] += e;
            H[5] += f;
            H[6] += g;
            H[7] += h;
        }
        const out = new Buf(32), ov = new DataView(out.buffer);
        H.forEach((x, i) => ov.setUint32(i * 4, x));
        return out;
    }
    const cryptoShim = {
        randomBytes: n => { const b = new Buf(n); crypto.getRandomValues(b); return b; },
        scryptSync: (pw, salt) => { let b = sha256(enc.encode(salt + ':' + pw)); for (let i = 0; i < 2000; i++)
            b = sha256(Buf.concat([b, enc.encode(salt)])); return b; },
        timingSafeEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
        createHmac: () => { throw new Error('Not available in the offline copy'); },
    };
    /* --- process / path / fs / os --- */
    window.process = { env: {}, versions: {}, platform: 'browser', removeAllListeners() { }, exit() { }, on() { } };
    const pathShim = { join: (...a) => a.join('/').replace(/\/+/g, '/'), normalize: p => p, extname: p => (p.match(/\.[^./]+$/) || [''])[0] };
    const fsShim = { mkdirSync() { }, existsSync: () => false, statSync: () => ({ isDirectory: () => false }), createReadStream() { throw new Error('no files offline'); } };
    const osShim = { networkInterfaces: () => ({}) };
    /* --- http: keep the request handler instead of opening a port --- */
    let handler = null;
    const noNet = () => { throw new Error('Not available in the offline copy'); };
    const httpShim = { createServer: fn => { handler = fn; return { listen() { }, on() { } }; }, request: noNet, get: noNet };
    const httpsShim = { request: noNet, get: noNet };
    const cpShim = { exec() { } };
    /* --- node:sqlite on top of sql.js, saved in the browser after every change --- */
    let SQLDB = null;
    const KEY = 'sundaybazar-erp-db';
    const norm = p => p.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    class DatabaseSync {
        constructor() { this.d = SQLDB; }
        exec(sql) { this.d.exec(sql); }
        prepare(sql) {
            const d = this.d;
            return {
                all: (...p) => { const st = d.prepare(sql); st.bind(norm(p)); const out = []; while (st.step())
                    out.push(st.getAsObject()); st.free(); return out; },
                get: (...p) => { const st = d.prepare(sql); st.bind(norm(p)); const r = st.step() ? st.getAsObject() : undefined; st.free(); return r; },
                run: (...p) => { const st = d.prepare(sql); st.run(norm(p)); st.free(); const id = d.exec('SELECT last_insert_rowid()'); return { changes: d.getRowsModified(), lastInsertRowid: id.length ? id[0].values[0][0] : 0 }; },
            };
        }
    }
    const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('storage timeout')), ms))]);
    function idb() { return new Promise((res, rej) => { const r = indexedDB.open('sundaybazar-erp', 1); r.onupgradeneeded = () => r.result.createObjectStore('db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
    async function loadSaved() {
        try {
            const d = await within(idb(), 2000);
            return await within(new Promise(res => { const g = d.transaction('db').objectStore('db').get(KEY); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }), 2000);
        }
        catch (_a) {
            try {
                const s = localStorage.getItem(KEY);
                if (s)
                    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
            }
            catch (_b) { }
            return null;
        }
    }
    // save right away after every change, so a reload or closed tab never loses work
    let storageDead = false; // browser refuses to store: keep working in memory without waiting each time
    async function saveNow() {
        if (storageDead)
            return;
        const bytes = SQLDB.export();
        try {
            const d = await within(idb(), 2000);
            await within(new Promise((res, rej) => { const t = d.transaction('db', 'readwrite'); t.objectStore('db').put(bytes, KEY); t.oncomplete = res; t.onerror = () => rej(t.error); }), 3000);
        }
        catch (_a) {
            try {
                let s = '';
                for (let i = 0; i < bytes.length; i += 8192)
                    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                localStorage.setItem(KEY, btoa(s));
            }
            catch (_b) {
                storageDead = true;
            }
        }
    }
    /* --- tiny CommonJS loader for the bundled server files --- */
    const MODS = window.__SB_MODULES, cache = {};
    const builtins = { 'node:sqlite': { DatabaseSync }, crypto: cryptoShim, path: pathShim, fs: fsShim, os: osShim, http: httpShim, https: httpsShim, child_process: cpShim };
    function resolve(from, name) {
        if (builtins[name])
            return name;
        const parts = (from.split('/').slice(0, -1).join('/') + '/' + name).split('/'), out = [];
        for (const p of parts) {
            if (p === '..')
                out.pop();
            else if (p && p !== '.')
                out.push(p);
        }
        let id = out.join('/');
        if (!id.endsWith('.js'))
            id = MODS[id + '.js'] ? id + '.js' : id + '/index.js';
        return id;
    }
    function load(id) {
        if (builtins[id])
            return builtins[id];
        if (cache[id])
            return cache[id].exports;
        const module = { exports: {} };
        cache[id] = module;
        const req = n => load(resolve(id, n));
        req.main = null;
        MODS[id](module, module.exports, req, '/' + id.split('/').slice(0, -1).join('/'));
        return module.exports;
    }
    /* --- answer the app's /api/ calls --- */
    let token = null;
    try {
        token = localStorage.getItem('sb_sess');
    }
    catch (_a) { }
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opt = {}) => {
        const u = typeof url === 'string' ? url : url.url;
        if (!u.startsWith('/api/'))
            return realFetch(url, opt);
        await window.__sbReady;
        const method = (opt.method || 'GET').toUpperCase(), body = opt.body ? Buf.from(String(opt.body)) : null;
        const req = { method, url: u, headers: Object.assign({ cookie: token ? 'sb_sess=' + token : '' }, Object.fromEntries(Object.entries(opt.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))),
            [Symbol.asyncIterator]: function () { return __asyncGenerator(this, arguments, function* () { if (body)
                yield yield __await(body); }); } };
        return new Promise(done => {
            let status = 200;
            const headers = {};
            const res = {
                headersSent: false,
                setHeader(k, v) { headers[k.toLowerCase()] = v; },
                writeHead(c, h) { status = c; Object.entries(h || {}).forEach(([k, v]) => headers[k.toLowerCase()] = v); this.headersSent = true; },
                end(data) {
                    const ck = headers['set-cookie'];
                    if (ck) {
                        const m = /sb_sess=([a-f0-9]*)/.exec(ck);
                        token = m && m[1] ? m[1] : null;
                        try {
                            token ? localStorage.setItem('sb_sess', token) : localStorage.removeItem('sb_sess');
                        }
                        catch (_a) { }
                    }
                    delete headers['set-cookie'];
                    const reply = () => done(new Response(data == null ? null : data, { status, headers }));
                    if (method !== 'GET')
                        saveNow().then(reply, reply);
                    else
                        reply();
                },
            };
            handler(req, res);
        });
    };
    /* --- start: database first, then the server code --- */
    window.__sbReady = (async () => {
        const wel = document.getElementById('sqlwasm'); // inline WebAssembly copy, or (hosted mobile copy) the plain-JS sql.js build loaded from a CDN
        const SQL = wel ? await initSqlJs({ wasmBinary: Uint8Array.from(atob(wel.textContent.trim()), c => c.charCodeAt(0)) }) : await initSqlJs({});
        const saved = await loadSaved();
        SQLDB = saved ? new SQL.Database(saved) : new SQL.Database();
        window.process.versions.node = '24.0.0'; // only after sql.js has started, or it thinks it runs in Node
        load('server.js');
        // first time: no account to create, open straight on the dashboard with practice data
        const { q } = load('lib/db.js'), A = load('lib/auth.js');
        if (!q.get('SELECT id FROM users LIMIT 1')) {
            const r = q.run('INSERT INTO users(name,username,pass,role) VALUES(?,?,?,?)', 'Owner', 'owner', A.hash('owner123'), 'admin');
            load('lib/demo.js').load();
            token = A.createSession(Number(r.lastInsertRowid));
            try {
                localStorage.setItem('sb_sess', token);
            }
            catch (_a) { }
            await saveNow().catch(() => { });
        }
        else if (!token || !q.get('SELECT token FROM sessions WHERE token=?', token)) {
            // offline copy on one computer: log straight back in as the owner
            const u = q.get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
            if (u) {
                token = A.createSession(u.id);
                try {
                    localStorage.setItem('sb_sess', token);
                }
                catch (_b) { }
            }
        }
    })();
})();
</script>