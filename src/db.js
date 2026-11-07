'use strict';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`\nNode.js ${process.versions.node} terlalu lama. Aplikasi ini butuh Node.js 22.13 atau lebih baru (lihat README bagian Laragon).\n`);
  process.exit(1);
}
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'kost.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','tenant')), active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'Standar',
  price INTEGER NOT NULL CHECK(price>0), status TEXT NOT NULL DEFAULT 'vacant' CHECK(status IN('vacant','occupied','reserved','maintenance')), description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tenants(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id), name TEXT NOT NULL, nim TEXT, university TEXT, phone TEXT, emergency TEXT);
CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), room_id INTEGER NOT NULL REFERENCES rooms(id),
  start TEXT NOT NULL, end TEXT, price INTEGER NOT NULL CHECK(price>0), deposit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed')));
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), period TEXT NOT NULL, due TEXT NOT NULL,
  total INTEGER NOT NULL CHECK(total>0), status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN('unpaid','partially_paid','paid')), UNIQUE(contract_id,period));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount INTEGER NOT NULL CHECK(amount>0),
  method TEXT NOT NULL CHECK(method IN('cash','bank_transfer','qris')), status TEXT NOT NULL CHECK(status IN('pending_review','confirmed','rejected','reversed')),
  proof TEXT, note TEXT, created_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, verified_at TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS complaints(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','in_progress','resolved','rejected')), note TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
`);
const defaults = { kost_name: 'Kost Saya', due_day: '10', invoice_day: '1', proration: 'full', bank_info: 'Isi info rekening/QRIS di menu Atur.' };
for (const [k, v] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, v);
const setting = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const TZ = process.env.APP_TZ || 'Asia/Jakarta';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const now = () => new Date().toLocaleString('sv-SE', { timeZone: TZ });
const audit = (uid, action, detail) => db.prepare('INSERT INTO audit(user_id,action,detail,at) VALUES(?,?,?,?)').run(uid ?? null, action, detail ?? null, now());
module.exports = { db, DATA, setting, tx, today, now, audit };
