    // SundayBazar ERP — database (built-in node:sqlite, no install needed)
    'use strict';
    const path = require('path');
    const fs = require('fs');
    const { DatabaseSync } = require('node:sqlite');
    const DATA_DIR = process.env.SB_DATA || path.join(__dirname, '..', 'data');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = new DatabaseSync(path.join(DATA_DIR, 'sundaybazar.db'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT,
  customer_id TEXT, phone TEXT, cust_name TEXT, city TEXT, address TEXT,
  total REAL DEFAULT 0, shipping REAL DEFAULT 0, discount REAL DEFAULT 0, items INTEGER DEFAULT 0,
  gateway TEXT, financial TEXT, fulfillment TEXT, tags TEXT, note TEXT, cancelled_at TEXT, source TEXT,
  tracking TEXT, courier TEXT,
  stage TEXT DEFAULT 'new',            -- manual stage: new, hold, confirmed, cs_cancelled, picked, packed
  status TEXT DEFAULT 'new',           -- derived status shown everywhere
  cs_attempts INTEGER DEFAULT 0, cs_note TEXT, cs_by INTEGER, cs_at TEXT, cs_next TEXT,
  picked_at TEXT, packed_at TEXT, dispatched_at TEXT, delivered_at TEXT, returned_at TEXT, return_received_at TEXT,
  px_status TEXT, px_updated TEXT, px_history TEXT,
  cod REAL, px_fee REAL, px_tax REAL, px_rev_fee REAL, px_rev_tax REAL,
  settled INTEGER DEFAULT 0, settled_at TEXT, settle_ref TEXT,
  missing INTEGER DEFAULT 0, assigned_to INTEGER);
CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS ix_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS ix_orders_tracking ON orders(tracking);
CREATE INDEX IF NOT EXISTS ix_orders_name ON orders(name);

CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, sku TEXT, title TEXT, qty INTEGER, price REAL,
  variant_id TEXT, product_id TEXT, picked INTEGER DEFAULT 0, picked_by INTEGER, picked_at TEXT,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS ix_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS ix_items_sku ON order_items(sku);

CREATE TABLE IF NOT EXISTS customer_flags(phone TEXT PRIMARY KEY, blacklist INTEGER DEFAULT 0, vip INTEGER DEFAULT 0, note TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS customers(
  phone TEXT PRIMARY KEY, name TEXT, city TEXT, orders INTEGER, delivered INTEGER, returned INTEGER,
  cancelled INTEGER, open INTEGER, spent REAL, first_order TEXT, last_order TEXT, score INTEGER, label TEXT);

CREATE TABLE IF NOT EXISTS products(
  variant_id TEXT PRIMARY KEY, product_id TEXT, title TEXT, sku TEXT, rack TEXT, category TEXT,
  price REAL, compare_at REAL, cost REAL, qty INTEGER, status TEXT, created_at TEXT, updated_at TEXT,
  tags TEXT, lot TEXT, brand TEXT, ptype TEXT, size TEXT, cond TEXT, image TEXT, handle TEXT,
  inventory_item TEXT, location TEXT, sold_at TEXT);
CREATE INDEX IF NOT EXISTS ix_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS ix_products_lot ON products(lot);
CREATE INDEX IF NOT EXISTS ix_products_rack ON products(rack);

CREATE TABLE IF NOT EXISTS locations(sku TEXT PRIMARY KEY, location TEXT, updated_at TEXT, updated_by INTEGER);
CREATE TABLE IF NOT EXISTS stock_moves(id INTEGER PRIMARY KEY, sku TEXT, from_loc TEXT, to_loc TEXT, reason TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS lots(name TEXT PRIMARY KEY, vendor TEXT, bought_on TEXT, cost REAL, pieces INTEGER, note TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS listings(sku TEXT PRIMARY KEY, serial INTEGER, letter TEXT, grp TEXT, lot TEXT, gender TEXT, type TEXT, brand TEXT, size TEXT, color TEXT,
  cond TEXT, material TEXT, note TEXT, title TEXT, price REAL, market REAL, floor REAL, cost REAL, user_id INTEGER, at TEXT DEFAULT (datetime('now')), exported INTEGER DEFAULT 0, exported_at TEXT);
CREATE INDEX IF NOT EXISTS ix_listings_lot ON listings(lot);
CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY, order_id TEXT, sku TEXT, cond TEXT, restocked INTEGER DEFAULT 0, location TEXT, note TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cs_calls(id INTEGER PRIMARY KEY, order_id TEXT, user_id INTEGER, outcome TEXT, note TEXT, at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_calls_order ON cs_calls(order_id);
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, day TEXT, category TEXT, amount REAL, note TEXT, user_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS price_changes(id INTEGER PRIMARY KEY, variant_id TEXT, sku TEXT, old_price REAL, new_price REAL, compare_at REAL, reason TEXT, user_id INTEGER, pushed INTEGER DEFAULT 0, error TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT DEFAULT (datetime('now')), user_id INTEGER, action TEXT, entity TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS ix_events_entity ON events(entity);
CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY, at TEXT DEFAULT (datetime('now')), kind TEXT, ok INTEGER, message TEXT);
`;
    db.exec(SCHEMA);
    // Lots: columns added for the listing module (new lot planner)
    {
        const have = new Set(db.prepare('PRAGMA table_info(lots)').all().map(c => c.name));
        for (const [c, t] of [['kind', 'TEXT'], ['extra', 'REAL'], ['bad', 'INTEGER'], ['per_piece', 'REAL'], ['cpv', 'REAL'], ['comp', 'TEXT']])
            if (!have.has(c))
                db.exec(`ALTER TABLE lots ADD COLUMN ${c} ${t}`);
    }
    const q = {
        all: (sql, ...p) => db.prepare(sql).all(...p),
        get: (sql, ...p) => db.prepare(sql).get(...p),
        run: (sql, ...p) => db.prepare(sql).run(...p),
        tx(fn) { db.exec('BEGIN'); try {
            const r = fn();
            db.exec('COMMIT');
            return r;
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        } },
    };
    function setting(key, def = null) { const r = q.get('SELECT value FROM settings WHERE key=?', key); if (!r)
        return def; try {
        return JSON.parse(r.value);
    }
    catch (_a) {
        return r.value;
    } }
    function setSetting(key, value) { q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
    function log(user_id, action, entity, detail) { q.run('INSERT INTO events(user_id,action,entity,detail) VALUES(?,?,?,?)', user_id || null, action, entity || null, typeof detail === 'string' ? detail : JSON.stringify(detail || null)); }
    function syncLog(kind, ok, message) { q.run('INSERT INTO sync_log(kind,ok,message) VALUES(?,?,?)', kind, ok ? 1 : 0, String(message).slice(0, 1000)); q.run("DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 500)"); }
    module.exports = { db, q, setting, setSetting, log, syncLog, DATA_DIR };
};