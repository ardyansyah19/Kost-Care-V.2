'use strict';
// Membuat akun admin + 20 kamar. Jalankan: npm run seed -- pemilik PasswordRahasia123  (jika dikosongkan, password acak dibuat)
const bcrypt = require('bcryptjs'), crypto = require('crypto');
const { db, tx } = require('../src/db');
const login = (process.argv[2] || process.env.ADMIN_LOGIN || 'pemilik').toLowerCase();
let pw = process.argv[3] || process.env.ADMIN_PASSWORD, generated = false;
if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
if (pw.length < 8) { console.error('ADMIN_PASSWORD minimal 8 karakter'); process.exit(1); }
const price = parseInt(process.env.DEFAULT_PRICE || '800000', 10);
tx(() => {
  if (!db.prepare('SELECT 1 FROM users WHERE login=?').get(login))
    db.prepare("INSERT INTO users(login,name,hash,role) VALUES(?,?,?,'admin')").run(login, 'Pemilik Kost', bcrypt.hashSync(pw, 10));
  else console.log('Admin sudah ada, password tidak diubah.');
  for (let n = 1; n <= 20; n++) db.prepare('INSERT OR IGNORE INTO rooms(number,price) VALUES(?,?)').run('K-' + String(n).padStart(2, '0'), price);
});
console.log(`Selesai. Admin: ${login}` + (generated ? ` · password sementara: ${pw} (segera ganti)` : ''));
console.log('Harga kamar masih default; atur di menu Kamar.');
