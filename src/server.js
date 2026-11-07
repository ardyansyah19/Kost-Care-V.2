'use strict';
const express = require('express'), cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), multer = require('multer');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { db, DATA, setting, tx, today, now, audit } = require('./db');
const S = require('./services');
const { U, UErr, int } = S;
const { html, raw, R, badge, period, dt, layout, LBL, LOGO } = require('./view');

const PROD = process.env.NODE_ENV === 'production';
const s = v => String(v ?? '').trim();
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const same = (a, b) => { a = Buffer.from(String(a ?? '')); b = Buffer.from(String(b ?? '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const DUMMY = bcrypt.hashSync('dummy-password', 10);
const temp = () => Array.from(crypto.randomBytes(8), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const home = u => (u.role === 'admin' ? '/admin' : '/app');
const go = (res, url, m, e) => { if (m || e) res.cookie('f', JSON.stringify({ m, e }), { httpOnly: true, sameSite: 'lax', maxAge: 60000 }); res.redirect(url); };
const back = req => { try { const u = new URL(req.get('referer')); if (u.host === req.get('host')) return u.pathname + u.search; } catch {} return req.user ? home(req.user) : '/login'; };
const W = fn => (req, res, next) => { try { fn(req, res); } catch (e) { if (e instanceof UErr) return go(res, back(req), null, e.message); next(e); } };
const F = (res, action, inner, mp) => html`<form method="post" action="${action}"${mp ? raw(' enctype="multipart/form-data"') : ''}><input type="hidden" name="_csrf" value="${res.locals.csrf}">${inner}</form>`;
const page = (req, res, title, body) => res.send(layout(req, res, title, body).s);
const opts = (list, sel) => list.map(([v, t]) => html`<option value="${v}"${String(v) === String(sel) ? raw(' selected') : ''}>${t}</option>`);
const INV = `SELECT i.*,r.number room,t.name tenant,t.id tid,COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id AND status='confirmed'),0) paid
 FROM invoices i JOIN contracts c ON c.id=i.contract_id JOIN rooms r ON r.id=c.room_id JOIN tenants t ON t.id=c.tenant_id`;
const ist = i => (i.status !== 'paid' && i.due < today() ? 'overdue' : i.status);
const invoiceCard = (i, href) => html`<a class="card lnk" href="${href}"><div class="row"><b>${period(i.period)}</b>${badge(ist(i))}</div>
 <p class="amt">${R(i.total)}</p><p class="muted">Kamar ${i.room} · ${i.tenant}</p><p class="muted">Terbayar ${R(i.paid)} · jatuh tempo ${dt(i.due)}</p></a>`;

// ---- upload (private storage, magic-byte check)
const up = multer({ storage: multer.diskStorage({ destination: path.join(DATA, 'uploads'), filename: (q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
function sniff(p) {
  const b = Buffer.alloc(12), fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  if (b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
  if (b.subarray(0, 4).toString('latin1') === '\x89PNG') return '.png';
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return '.pdf';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}
const rm = p => { try { fs.unlinkSync(p); } catch {} };

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" }); n(); });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }), cookieParser());
  app.use((req, res, next) => {
    req.user = null;
    const t = req.cookies.sid;
    if (t) { const u = db.prepare('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.exp>? AND u.active=1').get(hash(t), Date.now()); if (u) { req.user = u; res.locals.csrf = u.csrf; } }
    if (!req.user) { let c = req.cookies.lc; if (!c) { c = crypto.randomBytes(16).toString('hex'); res.cookie('lc', c, { httpOnly: true, sameSite: 'lax', secure: PROD }); } res.locals.csrf = c; }
    try { res.locals.flash = req.cookies.f ? JSON.parse(req.cookies.f) : null; } catch { res.locals.flash = null; }
    if (req.cookies.f) res.clearCookie('f');
    if (req.user?.must_change && !['/password', '/logout'].includes(req.path)) return res.redirect('/password');
    next();
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (req.is('multipart/form-data') && /^\/app\/invoices\/\d+\/pay$/.test(req.path)) return next(); // checked after multer
    if (!same(req.body?._csrf, res.locals.csrf)) return res.status(403).send('Sesi tidak valid. Muat ulang halaman lalu coba lagi.');
    next();
  });
  const need = role => (req, res, next) => !req.user ? res.redirect('/login') : req.user.role !== role ? res.status(403).send('Tidak diizinkan') : next();

  // ---------- auth
  const fails = new Map();
  app.get('/', (req, res) => res.redirect(req.user ? home(req.user) : '/login'));
  app.get('/login', (req, res) => req.user ? res.redirect(home(req.user)) : page(req, res, 'Masuk', html`<div class="auth"><div class="logo">${raw(LOGO)}</div><h1>${setting('kost_name')}</h1><p>Masuk untuk melihat tagihan & info kost</p></div>${F(res, '/login', html`
    <label>Username (nomor HP / email)</label><input name="login" autocomplete="username" required><label>Password</label><input type="password" name="password" autocomplete="current-password" required>
    <button>Masuk</button>`)}`));
  app.post('/login', W((req, res) => {
    const login = s(req.body.login).toLowerCase(), pw = String(req.body.password ?? ''), k = req.ip + '|' + login, f = fails.get(k) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 9e5) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) throw U('Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
    const u = db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(login);
    if (!bcrypt.compareSync(pw, u ? u.hash : DUMMY) || !u) { f.n++; fails.set(k, f); audit(null, 'login.fail', login); throw U('Username atau password salah'); }
    fails.delete(k);
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE exp<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(tok), u.id, crypto.randomBytes(16).toString('hex'), Date.now() + 7 * 864e5);
    res.cookie('sid', tok, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
    audit(u.id, 'login', login); res.redirect(home(u));
  }));
  app.post('/logout', (req, res) => { if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(req.cookies.sid)); res.clearCookie('sid'); res.redirect('/login'); });
  app.get('/password', ((req, res) => !req.user ? res.redirect('/login') : page(req, res, 'Ganti password', html`${req.user.must_change ? html`<p class="err">Demi keamanan, ganti password sementara Anda dulu.</p>` : ''}
    ${F(res, '/password', html`<label>Password saat ini</label><input type="password" name="old" required autocomplete="current-password"><label>Password baru (min. 8 karakter)</label>
    <input type="password" name="new" minlength="8" required autocomplete="new-password"><label>Ulangi password baru</label><input type="password" name="again" required autocomplete="new-password"><button>Simpan</button>`)}`)));
  app.post('/password', W((req, res) => {
    if (!req.user) return res.redirect('/login');
    const b = req.body;
    if (!bcrypt.compareSync(String(b.old ?? ''), req.user.hash)) throw U('Password saat ini salah');
    if (String(b.new ?? '').length < 8) throw U('Password baru minimal 8 karakter');
    if (b.new !== b.again) throw U('Konfirmasi password tidak sama');
    db.prepare('UPDATE users SET hash=?, must_change=0 WHERE id=?').run(bcrypt.hashSync(b.new, 10), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND csrf!=?').run(req.user.id, req.user.csrf);
    audit(req.user.id, 'password.change'); go(res, home(req.user), 'Password diperbarui');
  }));

  // ---------- admin
  const A = express.Router(); A.use(need('admin')); app.use('/admin', A);
  A.get('/', (req, res) => {
    S.housekeeping();
    const t = today(), mo = t.slice(0, 7), rs = Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM rooms GROUP BY status').all().map(r => [r.status, r.n]));
    const open = db.prepare(INV + " WHERE i.status!='paid'").all(), owed = open.reduce((a, i) => a + i.total - i.paid, 0), late = open.filter(i => i.due < t).length;
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='confirmed' AND substr(verified_at,1,7)=?").get(mo).s;
    const pend = db.prepare(`SELECT p.*,i.period,r.number room,t.name tenant FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN contracts c ON c.id=i.contract_id
      JOIN rooms r ON r.id=c.room_id JOIN tenants t ON t.id=c.tenant_id WHERE p.status='pending_review' ORDER BY p.id`).all();
    const cmp = db.prepare("SELECT COUNT(*) n FROM complaints WHERE status IN('submitted','in_progress')").get().n;
    page(req, res, 'Beranda admin', html`<div class="grid">
      <div class="stat"><b>${rs.occupied || 0}/${db.prepare('SELECT COUNT(*) n FROM rooms').get().n}</b><small>Kamar terisi</small></div>
      <div class="stat"><b>${rs.vacant || 0}</b><small>Kosong · ${rs.reserved || 0} dipesan · ${rs.maintenance || 0} perbaikan</small></div>
      <div class="stat"><b>${R(inc)}</b><small>Kas masuk bulan ini</small></div><div class="stat"><b>${R(owed)}</b><small>Tagihan belum lunas (${late} terlambat)</small></div></div>
      <h2>Perlu verifikasi (${pend.length})</h2>${pend.length ? pend.map(p => html`<div class="card"><div class="row"><b>Kamar ${p.room} · ${p.tenant}</b>${badge(p.method)}</div>
        <p>${R(p.amount)} untuk ${period(p.period)} · <a href="/files/${p.id}" target="_blank" rel="noopener">Lihat bukti</a></p>
        ${F(res, `/admin/payments/${p.id}/review`, html`<input type="hidden" name="ok" value="1"><button>Terima</button>`)}
        ${F(res, `/admin/payments/${p.id}/review`, html`<input name="note" placeholder="Alasan penolakan" required><button class="bad">Tolak</button>`)}</div>`) : html`<p class="empty">Tidak ada.</p>`}
      <h2>Aduan aktif</h2><p><a href="/admin/complaints">${cmp} aduan belum selesai</a></p>`);
  });
  A.post('/payments/:id/review', W((req, res) => { S.reviewPayment(req.params.id, req.user.id, req.body.ok === '1', s(req.body.note)); go(res, back(req), req.body.ok === '1' ? 'Pembayaran diterima' : 'Pembayaran ditolak'); }));
  A.post('/payments/:id/reverse', W((req, res) => { S.reversePayment(req.params.id, req.user.id, s(req.body.note)); go(res, back(req), 'Pembayaran dibatalkan'); }));

  A.get('/rooms', (req, res) => {
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY number').all();
    page(req, res, 'Kamar', html`${rooms.map(r => html`<div class="card"><div class="row"><b>${r.number}</b>${badge(r.status)}</div>${F(res, `/admin/rooms/${r.id}`, html`<div class="inline">
      <div><label>Tipe</label><input name="type" value="${r.type}"></div><div><label>Harga/bulan</label><input name="price" inputmode="numeric" value="${r.price}"></div>
      <div><label>Kondisi</label><select name="maint">${opts([['0', 'Normal (otomatis)'], ['1', 'Perbaikan']], r.status === 'maintenance' ? '1' : '0')}</select></div></div><button class="sec">Simpan</button>`)}</div>`)}
      <h2>Tambah kamar</h2>${F(res, '/admin/rooms', html`<label>Nomor</label><input name="number" required><label>Tipe</label><input name="type" value="Standar"><label>Harga/bulan (Rp)</label><input name="price" inputmode="numeric" required><button>Tambah</button>`)}`);
  });
  A.post('/rooms', W((req, res) => {
    const n = s(req.body.number), p = int(req.body.price);
    if (!n || !(p > 0)) throw U('Nomor dan harga wajib valid');
    if (db.prepare('SELECT 1 FROM rooms WHERE number=?').get(n)) throw U('Nomor kamar sudah ada');
    db.prepare('INSERT INTO rooms(number,type,price) VALUES(?,?,?)').run(n, s(req.body.type) || 'Standar', p); audit(req.user.id, 'room.create', n); go(res, '/admin/rooms', 'Kamar ditambahkan');
  }));
  A.post('/rooms/:id', W((req, res) => {
    const p = int(req.body.price), id = int(req.params.id), t = today();
    if (!(p > 0)) throw U('Harga tidak valid');
    if (req.body.maint === '1' && db.prepare("SELECT 1 FROM contracts WHERE room_id=? AND status='active' AND start<=? AND (end IS NULL OR end>=?)").get(id, t, t)) throw U('Kamar sedang dihuni; akhiri kontrak dulu sebelum menandai perbaikan');
    tx(() => { db.prepare('UPDATE rooms SET type=?, price=?, status=? WHERE id=?').run(s(req.body.type) || 'Standar', p, req.body.maint === '1' ? 'maintenance' : 'vacant', id); S.syncRoom(id); });
    audit(req.user.id, 'room.update', `#${id} ${p}`); go(res, '/admin/rooms', 'Kamar diperbarui (harga baru tidak mengubah kontrak/tagihan lama)');
  }));

  A.get('/tenants', (req, res) => {
    const t = today(), list = db.prepare(`SELECT t.*,u.login,u.active,(SELECT r.number FROM contracts c JOIN rooms r ON r.id=c.room_id WHERE c.tenant_id=t.id AND c.status='active' AND c.start<=? AND (c.end IS NULL OR c.end>=?)) room FROM tenants t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.name`).all(t, t);
    page(req, res, 'Penghuni', html`${list.map(x => html`<div class="card"><div class="row"><b>${x.name}</b><span class="b ${x.room ? 'occupied' : ''}">${x.room ? 'Kamar ' + x.room : 'Tanpa kamar'}</span></div>
      <p class="muted">${x.university || '-'} · NIM ${x.nim || '-'} · HP ${x.phone || '-'}</p><p class="muted">Login: ${x.login} ${x.active ? '' : '(nonaktif)'}</p>
      ${F(res, `/admin/tenants/${x.id}/reset`, html`<button class="sec">Reset password</button>`)}</div>`)}
      <h2>Tambah penghuni</h2>${F(res, '/admin/tenants', html`<label>Nama lengkap</label><input name="name" required><label>Username login (disarankan nomor HP)</label><input name="login" required>
      <label>No. HP</label><input name="phone" inputmode="tel"><label>NIM (opsional)</label><input name="nim"><label>Kampus</label><input name="university"><label>Kontak darurat</label><input name="emergency"><button>Buat akun</button>`)}`);
  });
  A.post('/tenants', W((req, res) => {
    const b = req.body, login = s(b.login).toLowerCase(), pw = temp();
    if (!s(b.name)) throw U('Nama wajib diisi');
    if (!/^[a-z0-9._@+-]{3,40}$/.test(login)) throw U('Username 3-40 karakter (huruf kecil, angka, . _ @ + -)');
    if (db.prepare('SELECT 1 FROM users WHERE login=?').get(login)) throw U('Username sudah dipakai');
    tx(() => {
      const uid = db.prepare("INSERT INTO users(login,name,hash,role,must_change) VALUES(?,?,?,'tenant',1)").run(login, s(b.name), bcrypt.hashSync(pw, 10)).lastInsertRowid;
      db.prepare('INSERT INTO tenants(user_id,name,nim,university,phone,emergency) VALUES(?,?,?,?,?,?)').run(uid, s(b.name), s(b.nim), s(b.university), s(b.phone), s(b.emergency));
    });
    audit(req.user.id, 'tenant.create', login); go(res, '/admin/tenants', `Akun dibuat. Username: ${login} · Password sementara: ${pw} (catat & berikan ke penghuni; hanya tampil sekali)`);
  }));
  A.post('/tenants/:id/reset', W((req, res) => {
    const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(int(req.params.id)); if (!t?.user_id) throw U('Penghuni tidak ditemukan');
    const pw = temp(); db.prepare('UPDATE users SET hash=?, must_change=1 WHERE id=?').run(bcrypt.hashSync(pw, 10), t.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.user_id);
    audit(req.user.id, 'tenant.reset', String(t.id)); go(res, '/admin/tenants', `Password sementara ${t.name}: ${pw} (hanya tampil sekali)`);
  }));

  A.get('/contracts', (req, res) => {
    const list = db.prepare("SELECT c.*,r.number room,t.name tenant FROM contracts c JOIN rooms r ON r.id=c.room_id JOIN tenants t ON t.id=c.tenant_id ORDER BY c.status,c.start DESC").all();
    page(req, res, 'Kontrak', html`${list.map(c => html`<div class="card"><div class="row"><b>Kamar ${c.room} · ${c.tenant}</b><span class="b ${c.status === 'active' ? 'occupied' : ''}">${c.status === 'active' ? 'Aktif' : 'Selesai'}</span></div>
      <p>${dt(c.start)} – ${c.end ? dt(c.end) : 'tanpa batas'} · ${R(c.price)}/bln · deposit ${R(c.deposit)}</p>
      ${c.status === 'active' ? F(res, `/admin/contracts/${c.id}/end`, html`<div class="inline"><input type="date" name="date" value="${today()}" required><button class="bad">Check-out / akhiri</button></div>`) : ''}</div>`)}
      <h2>Kontrak baru</h2>${F(res, '/admin/contracts', html`<label>Penghuni</label><select name="tenant_id">${opts(db.prepare('SELECT id,name FROM tenants ORDER BY name').all().map(t => [t.id, t.name]))}</select>
      <label>Kamar</label><select name="room_id">${opts(db.prepare("SELECT id,number,price FROM rooms WHERE status!='maintenance' ORDER BY number").all().map(r => [r.id, `${r.number} (${R(r.price)})`]))}</select>
      <label>Tanggal mulai</label><input type="date" name="start" value="${today()}" required><label>Tanggal akhir (kosongkan jika perpanjangan bulanan terus)</label><input type="date" name="end">
      <label>Harga/bulan (kosong = harga kamar)</label><input name="price" inputmode="numeric"><label>Deposit (opsional)</label><input name="deposit" inputmode="numeric"><button>Buat kontrak</button>`)}`);
  });
  A.post('/contracts', W((req, res) => { S.newContract(req.body, req.user.id); go(res, '/admin/contracts', 'Kontrak dibuat'); }));
  A.post('/contracts/:id/end', W((req, res) => { S.endContract(req.params.id, s(req.body.date), req.user.id); go(res, '/admin/contracts', 'Kontrak diakhiri'); }));

  A.get('/invoices', (req, res) => {
    const p = /^\d{4}-\d\d$/.test(req.query.period || '') ? req.query.period : today().slice(0, 7), list = db.prepare(INV + ' WHERE i.period=? ORDER BY r.number').all(p);
    page(req, res, 'Tagihan', html`<form method="get" class="inline"><input type="month" name="period" value="${p}"><button class="sec">Lihat</button></form>
      ${F(res, '/admin/invoices/generate', html`<input type="hidden" name="period" value="${p}"><button>Buat tagihan ${period(p)}</button>`)}
      <p class="muted">Tagihan juga dibuat otomatis tiap bulan; membuat ulang tidak menggandakan.</p>${list.length ? list.map(i => invoiceCard(i, `/admin/invoices/${i.id}`)) : html`<p class="empty">Belum ada tagihan.</p>`}`);
  });
  A.post('/invoices/generate', W((req, res) => { const n = S.generateInvoices(s(req.body.period)); audit(req.user.id, 'invoice.generate', `${req.body.period} +${n}`); go(res, `/admin/invoices?period=${encodeURIComponent(s(req.body.period))}`, `${n} tagihan baru dibuat`); }));
  A.get('/invoices/:id', (req, res) => {
    const i = db.prepare(INV + ' WHERE i.id=?').get(int(req.params.id)); if (!i) return res.status(404).send('Tidak ditemukan');
    const ps = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(i.id);
    page(req, res, `Tagihan ${period(i.period)}`, html`${invoiceCard(i, '#')}<h2>Pembayaran</h2>${ps.length ? ps.map(p => html`<div class="card"><div class="row"><b>${R(p.amount)} · ${LBL[p.method]}</b>${badge(p.status)}</div>
      <p class="muted">${p.created_at}${p.note ? ' · ' + p.note : ''}${p.proof ? html` · <a href="/files/${p.id}" target="_blank" rel="noopener">bukti</a>` : ''}</p>
      ${p.status === 'confirmed' ? F(res, `/admin/payments/${p.id}/reverse`, html`<div class="inline"><input name="note" placeholder="Alasan pembatalan" required><button class="bad">Batalkan</button></div>`) : ''}</div>`) : html`<p class="empty">Belum ada.</p>`}
      ${i.total - i.paid > 0 ? html`<h2>Catat pembayaran (sudah diterima)</h2>${F(res, `/admin/invoices/${i.id}/pay`, html`<label>Metode</label><select name="method">${opts([['cash', 'Tunai'], ['bank_transfer', 'Transfer'], ['qris', 'QRIS']])}</select>
      <label>Nominal (maks. ${R(i.total - i.paid)})</label><input name="amount" inputmode="numeric" value="${i.total - i.paid}" required><label>Catatan</label><input name="note"><button>Simpan</button>`)}` : ''}`);
  });
  A.post('/invoices/:id/pay', W((req, res) => { S.addPayment({ invoice: int(req.params.id), amount: req.body.amount, method: req.body.method, by: req.user.id, confirmed: true, note: s(req.body.note) }); go(res, back(req), 'Pembayaran dicatat'); }));

  A.get('/news', (req, res) => page(req, res, 'Pengumuman', html`${db.prepare('SELECT * FROM announcements WHERE archived=0 ORDER BY id DESC').all().map(a => html`<div class="card"><b>${a.title}</b><p class="muted">${dt(a.at)}</p><p>${a.body}</p>${F(res, `/admin/news/${a.id}/archive`, html`<button class="sec">Arsipkan</button>`)}</div>`)}
    <h2>Pengumuman baru</h2>${F(res, '/admin/news', html`<label>Judul</label><input name="title" required><label>Isi</label><textarea name="body" rows="4" required></textarea><button>Terbitkan</button>`)}`));
  A.post('/news', W((req, res) => { if (!s(req.body.title) || !s(req.body.body)) throw U('Judul dan isi wajib'); db.prepare('INSERT INTO announcements(title,body,at) VALUES(?,?,?)').run(s(req.body.title), s(req.body.body), now()); go(res, '/admin/news', 'Terbit'); }));
  A.post('/news/:id/archive', W((req, res) => { db.prepare('UPDATE announcements SET archived=1 WHERE id=?').run(int(req.params.id)); go(res, '/admin/news', 'Diarsipkan'); }));

  A.get('/complaints', (req, res) => page(req, res, 'Aduan', html`${db.prepare('SELECT c.*,t.name tenant FROM complaints c JOIN tenants t ON t.id=c.tenant_id ORDER BY (c.status IN(\'resolved\',\'rejected\')),c.id DESC').all().map(c => html`<div class="card"><div class="row"><b>${c.title}</b>${badge(c.status)}</div>
    <p class="muted">${c.tenant} · ${dt(c.at)}</p><p>${c.body}</p>${F(res, `/admin/complaints/${c.id}`, html`<select name="status">${opts(['submitted', 'in_progress', 'resolved', 'rejected'].map(x => [x, LBL[x]]), c.status)}</select><input name="note" placeholder="Catatan untuk penghuni" value="${c.note || ''}"><button class="sec">Simpan</button>`)}</div>`)}`));
  A.post('/complaints/:id', W((req, res) => { if (!['submitted', 'in_progress', 'resolved', 'rejected'].includes(req.body.status)) throw U('Status tidak valid'); db.prepare('UPDATE complaints SET status=?, note=? WHERE id=?').run(req.body.status, s(req.body.note), int(req.params.id)); go(res, '/admin/complaints', 'Diperbarui'); }));

  A.get('/settings', (req, res) => page(req, res, 'Pengaturan', F(res, '/admin/settings', html`<label>Nama kost</label><input name="kost_name" value="${setting('kost_name')}"><label>Tanggal tagihan dibuat (1-28)</label><input name="invoice_day" value="${setting('invoice_day')}">
    <label>Tanggal jatuh tempo (1-28)</label><input name="due_day" value="${setting('due_day')}"><label>Penghuni masuk tengah bulan</label><select name="proration">${opts([['full', 'Tagih sebulan penuh'], ['prorata', 'Prorata per hari'], ['next', 'Mulai tagihan bulan berikutnya']], setting('proration'))}</select>
    <label>Info rekening / QRIS (tampil ke penghuni)</label><textarea name="bank_info" rows="3">${setting('bank_info')}</textarea><button>Simpan</button>`)));
  A.post('/settings', W((req, res) => {
    const b = req.body, d = x => Number.isInteger(+x) && +x >= 1 && +x <= 28;
    if (!d(b.invoice_day) || !d(b.due_day) || !['full', 'prorata', 'next'].includes(b.proration)) throw U('Pengaturan tidak valid');
    for (const k of ['kost_name', 'invoice_day', 'due_day', 'proration', 'bank_info']) db.prepare('UPDATE settings SET v=? WHERE k=?').run(s(b[k]), k);
    audit(req.user.id, 'settings.update'); go(res, '/admin/settings', 'Tersimpan');
  }));

  // ---------- tenant
  const T = express.Router(); T.use(need('tenant'));
  T.use((req, res, next) => { req.tenant = db.prepare('SELECT * FROM tenants WHERE user_id=?').get(req.user.id); req.tenant ? next() : res.status(403).send('Profil penghuni tidak ditemukan'); });
  app.use('/app', T);
  const own = (req, id) => db.prepare(INV + ' WHERE i.id=? AND t.id=?').get(int(id), req.tenant.id);
  T.get('/', (req, res) => {
    const t = today(), c = db.prepare("SELECT c.*,r.number room,r.type FROM contracts c JOIN rooms r ON r.id=c.room_id WHERE c.tenant_id=? AND c.status='active' AND c.start<=? AND (c.end IS NULL OR c.end>=?)").get(req.tenant.id, t, t);
    const open = db.prepare(INV + " WHERE t.id=? AND i.status!='paid' ORDER BY i.due").all(req.tenant.id);
    page(req, res, `Halo, ${req.tenant.name.split(' ')[0]}`, html`<div class="hero">${c ? html`<small>Kamar Anda</small><div class="big">${c.room}</div><span class="pill">${c.type}</span><span class="pill">${R(c.price)}/bulan</span><span class="pill">sejak ${dt(c.start)}</span>` : html`<small>Belum ada kontrak aktif</small><div class="big">-</div>`}
        <p>${open.length ? html`Sisa tagihan: <b>${R(open.reduce((a, i) => a + i.total - i.paid, 0))}</b>` : 'Semua tagihan lunas 🎉'}</p></div>
      <h2>Tagihan belum lunas</h2>${open.length ? open.map(i => invoiceCard(i, `/app/invoices/${i.id}`)) : html`<p class="empty">Tidak ada tagihan. 🎉</p>`}
      <h2>Pengumuman terbaru</h2>${db.prepare('SELECT * FROM announcements WHERE archived=0 ORDER BY id DESC LIMIT 3').all().map(a => html`<div class="card"><b>${a.title}</b><p>${a.body}</p></div>`)}`);
  });
  T.get('/invoices', (req, res) => page(req, res, 'Tagihan & riwayat', db.prepare(INV + ' WHERE t.id=? ORDER BY i.period DESC').all(req.tenant.id).map(i => invoiceCard(i, `/app/invoices/${i.id}`))));
  T.get('/invoices/:id', (req, res) => {
    const i = own(req, req.params.id); if (!i) return res.status(404).send('Tidak ditemukan');
    const ps = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(i.id), left = i.total - i.paid;
    page(req, res, `Tagihan ${period(i.period)}`, html`${invoiceCard(i, '#')}<h2>Riwayat pembayaran</h2>${ps.length ? ps.map(p => html`<div class="card"><div class="row"><b>${R(p.amount)} · ${LBL[p.method]}</b>${badge(p.status)}</div><p class="muted">${p.created_at}${p.status === 'rejected' && p.note ? ' · Alasan: ' + p.note : ''}</p></div>`) : html`<p class="empty">Belum ada.</p>`}
      ${left > 0 ? html`<h2>Bayar / kirim bukti</h2><div class="card"><p>${setting('bank_info')}</p></div>${F(res, `/app/invoices/${i.id}/pay`, html`<label>Metode</label><select name="method">${opts([['bank_transfer', 'Transfer bank'], ['qris', 'QRIS']])}</select>
      <label>Nominal (sisa ${R(left)})</label><input name="amount" inputmode="numeric" value="${left}" required><label>Foto/PDF bukti (maks. 5 MB)</label><input type="file" name="proof" accept="image/*,application/pdf" required>
      <label>Catatan</label><input name="note"><button>Kirim bukti</button><p class="muted">Lunas setelah pemilik memverifikasi. Untuk bayar tunai, serahkan ke pemilik.</p>`, true)}` : ''}`);
  });
  const csrfAfter = (req, res, next) => same(req.body?._csrf, res.locals.csrf) ? next() : (req.file && rm(req.file.path), res.status(403).send('Sesi tidak valid. Muat ulang halaman.'));
  T.post('/invoices/:id/pay', up.single('proof'), csrfAfter, W((req, res) => {
    const f = req.file; let ok = false;
    try {
      if (!f) throw U('Bukti pembayaran wajib diunggah');
      const ext = sniff(f.path); if (!ext) throw U('File harus JPG, PNG, WebP, atau PDF');
      const i = own(req, req.params.id); if (!i) throw U('Tagihan tidak ditemukan');
      if (!['bank_transfer', 'qris'].includes(req.body.method)) throw U('Metode tidak valid');
      fs.renameSync(f.path, f.path + ext); f.path += ext;
      S.addPayment({ invoice: i.id, amount: req.body.amount, method: req.body.method, proof: path.basename(f.path), by: req.user.id, confirmed: false, note: s(req.body.note) }); ok = true;
      go(res, `/app/invoices/${i.id}`, 'Bukti terkirim, menunggu verifikasi pemilik');
    } finally { if (!ok && f) rm(f.path); }
  }));
  T.get('/news', (req, res) => page(req, res, 'Pengumuman', db.prepare('SELECT * FROM announcements WHERE archived=0 ORDER BY id DESC').all().map(a => html`<div class="card"><b>${a.title}</b><p class="muted">${dt(a.at)}</p><p>${a.body}</p></div>`)));
  T.get('/complaints', (req, res) => page(req, res, 'Aduan', html`${db.prepare('SELECT * FROM complaints WHERE tenant_id=? ORDER BY id DESC').all(req.tenant.id).map(c => html`<div class="card"><div class="row"><b>${c.title}</b>${badge(c.status)}</div><p>${c.body}</p>${c.note ? html`<p class="muted">Catatan pemilik: ${c.note}</p>` : ''}</div>`)}
    <h2>Buat aduan</h2>${F(res, '/app/complaints', html`<label>Judul</label><input name="title" required><label>Penjelasan</label><textarea name="body" rows="4" required></textarea><button>Kirim</button>`)}`));
  T.post('/complaints', W((req, res) => { if (!s(req.body.title) || !s(req.body.body)) throw U('Judul dan penjelasan wajib'); db.prepare('INSERT INTO complaints(tenant_id,title,body,at) VALUES(?,?,?,?)').run(req.tenant.id, s(req.body.title), s(req.body.body), now()); go(res, '/app/complaints', 'Aduan terkirim'); }));

  // ---------- private files
  app.get('/files/:id', (req, res) => {
    if (!req.user) return res.redirect('/login');
    const p = db.prepare('SELECT p.proof,t.user_id FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN contracts c ON c.id=i.contract_id JOIN tenants t ON t.id=c.tenant_id WHERE p.id=?').get(int(req.params.id));
    if (!p?.proof || (req.user.role !== 'admin' && p.user_id !== req.user.id)) return res.status(404).send('Tidak ditemukan');
    res.sendFile(path.join(DATA, 'uploads', path.basename(p.proof)));
  });
  app.use((req, res) => res.status(404).send('Halaman tidak ditemukan'));
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return go(res, back(req), null, 'Ukuran file maksimal 5 MB');
    console.error(err); res.status(500).send('Terjadi kesalahan pada server');
  });
  return app;
}

function startScheduler() {
  const tick = () => { try { const t = today(); S.housekeeping(); if (+t.slice(8) >= +setting('invoice_day')) S.generateInvoices(t.slice(0, 7)); } catch (e) { console.error('scheduler', e); } };
  tick(); return setInterval(tick, 36e5);
}
if (require.main === module) {
  const port = process.env.PORT || 3000; startScheduler();
  createApp().listen(port, '0.0.0.0', () => console.log(`Kost Care berjalan di http://localhost:${port}`));
}
module.exports = { createApp };
