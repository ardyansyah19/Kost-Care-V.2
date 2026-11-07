# Kost Care — manajemen kost 20 kamar (mobile-first)

Satu aplikasi untuk pemilik (admin) dan penghuni (portal HP). Node.js 22.13+ · Express · SQLite (bawaan Node, tanpa instalasi database).

## Menjalankan di Laragon (Windows)
1. **Node.js 22.13+ wajib** (SQLite bawaan Node). Cek di Terminal Laragon: `node -v`. Jika lebih lama, unduh zip "Windows Binary (.zip)" Node 22 LTS dari nodejs.org, ekstrak ke `C:\laragon\bin\nodejs\node-v22`, lalu di Laragon: *Menu -> Tools -> Path -> Add Laragon to Path*, restart Terminal Laragon, dan pastikan `node -v` menampilkan v22.x.
2. Ekstrak zip ke `C:\laragon\www\kost-care`, lalu **klik dua kali `jalankan.bat`**. Pertama kali ia menjalankan `npm install` (perlu internet), membuat admin + kamar K-01..K-20, lalu menyalakan server. Password admin acak tampil di jendela itu (username `pemilik`); catat lalu ganti lewat menu Akun.
3. Buka `http://localhost:3000`. Aplikasi ini tidak memakai Apache/MySQL Laragon, jadi tidak perlu dinyalakan.
4. Akses dari HP (satu Wi-Fi): buka `http://IP-LAPTOP:3000` (cek IP dengan `ipconfig`). Jika tidak terbuka, izinkan Node.js/port 3000 di Windows Firewall.

Cara manual: `npm install`, `npm run seed -- pemilik PasswordAnda123`, `npm start`, `npm test`.

Setelah login: **Kamar** (atur harga) -> **Atur** (jatuh tempo, rekening/QRIS) -> **Penghuni** (buat akun; password sementara tampil sekali) -> **Kontrak** -> **Tagihan**.

## Alur pembayaran
Penghuni kirim bukti transfer/QRIS → status *Menunggu verifikasi* (belum mengurangi tagihan) → admin Terima/Tolak di Beranda. Tunai dicatat admin di detail tagihan. Pembayaran yang sudah diterima tidak dihapus; koreksi lewat **Batalkan** (wajib alasan) dan tercatat di tabel `audit`. Satu tagihan bisa dibayar sebagian/campuran.

## Keputusan bawaan (ubah di menu Atur)
Tagihan dibuat tanggal 1, jatuh tempo tgl 10, masuk tengah bulan = sebulan penuh (bisa prorata / mulai bulan depan). Kelebihan bayar **ditolak** (nominal maks. = sisa tagihan). Denda otomatis tidak ada. Uang disimpan sebagai bilangan bulat rupiah.

## Produksi
- Jalankan di VPS/PaaS yang mendukung Node (bukan shared hosting PHP). Pasang HTTPS (mis. Caddy/Nginx) dan set `NODE_ENV=production`, `TRUST_PROXY=1`.
- Backup: salin folder `data/` (database `kost.db` + `uploads/`) secara berkala dan uji pemulihannya.
- Bukti bayar disimpan di `data/uploads` (privat, hanya bisa dibuka admin / pemiliknya).
- Belum ada di versi ini: pengeluaran & laporan/ekspor, notifikasi, log audit di layar, service worker offline (manifest PWA sudah ada).
