'use strict';
process.env.DB_FILE = ':memory:'; process.env.DATA_DIR = require('os').tmpdir() + '/kost-test-' + process.pid;
const test = require('node:test'), assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { db, today } = require('../src/db');
const S = require('../src/services');
const { createApp } = require('../src/server');

const mkTenant = (login, name) => {
  const u = db.prepare("INSERT INTO users(login,name,hash,role) VALUES(?,?,?,'tenant')").run(login, name, bcrypt.hashSync('rahasia123', 4)).lastInsertRowid;
  return db.prepare('INSERT INTO tenants(user_id,name) VALUES(?,?)').run(u, name).lastInsertRowid;
};
db.prepare("INSERT INTO users(login,name,hash,role) VALUES('admin','Admin',?,'admin')").run(bcrypt.hashSync('adminpass1', 4));
const r1 = db.prepare("INSERT INTO rooms(number,price) VALUES('K-01',850000)").run().lastInsertRowid;
const t1 = mkTenant('budi', 'Budi'), t2 = mkTenant('sari', 'Sari');
const month = today().slice(0, 7), first = month + '-01';

test('kontrak bertabrakan ditolak, kamar menjadi terisi', () => {
  const c = S.newContract({ tenant_id: t1, room_id: r1, start: first }, 1);
  assert.ok(c);
  assert.throws(() => S.newContract({ tenant_id: t2, room_id: r1, start: first }, 1), /rentang tanggal/);
  assert.equal(db.prepare('SELECT status FROM rooms WHERE id=?').get(r1).status, 'occupied');
});
test('tagihan idempotent dan pembayaran campuran/sebagian', () => {
  assert.equal(S.generateInvoices(month), 1); assert.equal(S.generateInvoices(month), 0);
  const inv = db.prepare('SELECT * FROM invoices').get();
  const p1 = S.addPayment({ invoice: inv.id, amount: 500000, method: 'bank_transfer', proof: 'x.jpg', by: 2, confirmed: false });
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status, 'unpaid'); // pending tidak mengurangi saldo
  S.reviewPayment(p1, 1, true);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status, 'partially_paid');
  assert.throws(() => S.addPayment({ invoice: inv.id, amount: 400000, method: 'cash', by: 1, confirmed: true }), /melebihi/);
  S.addPayment({ invoice: inv.id, amount: 350000, method: 'cash', by: 1, confirmed: true });
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status, 'paid');
  S.reversePayment(p1, 1, 'salah input');
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status, 'partially_paid');
  const p2 = S.addPayment({ invoice: inv.id, amount: 100000, method: 'qris', proof: 'y.jpg', by: 2, confirmed: false });
  S.reviewPayment(p2, 1, false, 'buram'); assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(p2).status, 'rejected');
});

async function client(app) {
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); }), base = 'http://127.0.0.1:' + srv.address().port;
  let jar = {};
  const req = async (path, opt = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return res;
  };
  const csrf = async p => (await (await req(p)).text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const login = async (u, p) => { const t = await csrf('/login'); return req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: t, login: u, password: p }) }); };
  return { req, csrf, login, close: () => srv.close() };
}
test('login, pembatasan role, dan isolasi data antar penghuni', async () => {
  const c = await client(createApp());
  assert.equal((await c.req('/admin')).status, 302); // belum login
  assert.equal((await c.login('budi', 'salah')).headers.get('location'), '/login');
  const ok = await c.login('budi', 'rahasia123'); assert.equal(ok.headers.get('location'), '/app');
  assert.equal((await c.req('/admin')).status, 403); // tenant tidak boleh ke admin
  const inv = db.prepare('SELECT id FROM invoices').get().id;
  assert.equal((await c.req('/app/invoices/' + inv)).status, 200);
  const c2 = await client(createApp()); await c2.login('sari', 'rahasia123');
  assert.equal((await c2.req('/app/invoices/' + inv)).status, 404); // Sari tidak bisa lihat tagihan Budi
  assert.equal((await c2.req('/files/1')).status, 404);
  const bad = await c.req('/app/complaints', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=a&body=b' });
  assert.equal(bad.status, 403); // tanpa CSRF
  c.close(); c2.close();
});
test('admin membuka dashboard & akhiri kontrak membebaskan kamar', async () => {
  const c = await client(createApp()); await c.login('admin', 'adminpass1');
  assert.equal((await c.req('/admin')).status, 200); assert.equal((await c.req('/admin/invoices')).status, 200);
  const cid = db.prepare('SELECT id FROM contracts').get().id;
  S.endContract(cid, today(), 1);
  assert.equal(db.prepare('SELECT status FROM rooms WHERE id=?').get(r1).status, 'vacant');
  c.close();
});

test('semua halaman admin & penghuni dapat dibuka, tanggal tak valid ditolak, housekeeping', async () => {
  const room2 = db.prepare("INSERT INTO rooms(number,price) VALUES('K-02',700000)").run().lastInsertRowid;
  assert.throws(() => S.newContract({ tenant_id: t2, room_id: room2, start: '2026-02-31' }, 1), /tanggal/i);
  S.newContract({ tenant_id: t2, room_id: room2, start: first, end: first }, 1); // berakhir di masa lalu/hari pertama
  S.housekeeping();
  const a = await client(createApp()); await a.login('admin', 'adminpass1');
  for (const p of ['/admin', '/admin/rooms', '/admin/tenants', '/admin/contracts', '/admin/invoices', '/admin/news', '/admin/complaints', '/admin/settings', '/admin/invoices/1'])
    assert.equal((await a.req(p)).status, 200, p);
  const sari = await client(createApp()); await sari.login('sari', 'rahasia123');
  for (const p of ['/app', '/app/invoices', '/app/news', '/app/complaints', '/password']) assert.equal((await sari.req(p)).status, 200, p);
  const css = await (await sari.req('/app')).text(); assert.ok(!/style="/.test(css), 'tidak boleh ada inline style (diblokir CSP)');
  a.close(); sari.close();
});

test('unggah bukti bayar: file valid -> pending & privat, file palsu ditolak', async () => {
  const b = await client(createApp()); await b.login('budi', 'rahasia123');
  const inv = db.prepare('SELECT id FROM invoices').get().id, token = await b.csrf('/app/invoices/' + inv);
  assert.ok(token);
  const send = (bytes, name, amount = '100000') => { const f = new FormData(); f.set('_csrf', token); f.set('method', 'bank_transfer'); f.set('amount', amount); f.set('proof', new Blob([bytes]), name); return b.req(`/app/invoices/${inv}/pay`, { method: 'POST', body: f }); };
  const before = db.prepare('SELECT COUNT(*) n FROM payments').get().n;
  await send(Buffer.from('<script>alert(1)</script>'), 'bukti.png'); // isi bukan gambar
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, before);
  await send(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]), 'bukti.png');
  const p = db.prepare("SELECT * FROM payments WHERE status='pending_review'").get();
  assert.ok(p && p.proof.endsWith('.png') && p.amount === 100000);
  const sari = await client(createApp()); await sari.login('sari', 'rahasia123');
  assert.equal((await sari.req('/files/' + p.id)).status, 404);
  assert.equal((await b.req('/files/' + p.id)).status, 200);
  const a = await client(createApp()); await a.login('admin', 'adminpass1');
  assert.equal((await a.req('/files/' + p.id)).status, 200);
  const tk = await a.csrf('/admin');
  const r = await a.req(`/admin/payments/${p.id}/review`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: tk, ok: '1' }) });
  assert.equal(r.status, 302); assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(p.id).status, 'confirmed');
  b.close(); sari.close(); a.close();
});
