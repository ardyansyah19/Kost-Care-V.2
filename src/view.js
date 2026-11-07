'use strict';
class Raw { constructor(s) { this.s = s; } }
const raw = s => new Raw(String(s));
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const out = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(out).join('') : v == null || v === false ? '' : esc(v);
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? out(v[i]) : ''), ''));
const R = n => 'Rp' + Number(n).toLocaleString('id-ID');
const LBL = { unpaid: 'Belum bayar', partially_paid: 'Sebagian', paid: 'Lunas', overdue: 'Terlambat', pending_review: 'Menunggu verifikasi', confirmed: 'Terkonfirmasi',
  rejected: 'Ditolak', reversed: 'Dibatalkan', vacant: 'Kosong', occupied: 'Terisi', reserved: 'Dipesan', maintenance: 'Perbaikan', submitted: 'Dikirim', in_progress: 'Diproses',
  resolved: 'Selesai', cash: 'Tunai', bank_transfer: 'Transfer', qris: 'QRIS' };
const badge = s => html`<span class="b ${s}">${LBL[s] || s}</span>`;
const period = p => { const [y, m] = p.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }); };
const dt = d => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
const NAV = {
  admin: [['/admin', 'Beranda'], ['/admin/rooms', 'Kamar'], ['/admin/tenants', 'Penghuni'], ['/admin/contracts', 'Kontrak'], ['/admin/invoices', 'Tagihan'], ['/admin/news', 'Info'], ['/admin/complaints', 'Aduan'], ['/admin/settings', 'Atur']],
  tenant: [['/app', 'Beranda'], ['/app/invoices', 'Tagihan'], ['/app/news', 'Info'], ['/app/complaints', 'Aduan'], ['/password', 'Akun']],
};
const IC = { Beranda: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>', Kamar: '<path d="M3 18v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8M3 14h18M3 18v2m18-2v2M7 11h4"/>',
  Penghuni: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M17 4.8a3.5 3.5 0 0 1 0 6.4M21.5 20c0-2.6-1.4-4.5-3.5-5.4"/>',
  Kontrak: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>', Tagihan: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  Info: '<path d="M3 11v2a1 1 0 0 0 1 1h3l8 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M19 9a4 4 0 0 1 0 6"/>', Aduan: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  Atur: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', Akun: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>' };
const LOGO = '<svg viewBox="0 0 96 96"><path d="M16 50 48 22l32 28v26H16z" fill="#fff"/><rect x="40" y="56" width="16" height="20" fill="#0d9488"/></svg>';
const layout = (req, res, title, body) => html`<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f766e"><link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg"><title>${title} · Kost Care</title><link rel="stylesheet" href="/app.css"></head>
<body class="${req.user ? '' : 'guest'}"><header><div class="brand">${raw(LOGO.replace('#0d9488', '#0f766e'))}Kost Care</div>${req.user ? html`<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${res.locals.csrf}"><div class="av">${req.user.name.slice(0, 1).toUpperCase()}</div><span class="who">${req.user.name}</span><button class="link">Keluar</button></form>` : ''}</header>
<main>${res.locals.flash?.m ? html`<p class="ok">${res.locals.flash.m}</p>` : ''}${res.locals.flash?.e ? html`<p class="err">${res.locals.flash.e}</p>` : ''}<h1>${title}</h1>${body}</main>
${req.user ? html`<nav>${NAV[req.user.role].map(([h, t]) => html`<a href="${h}" class="${(req.originalUrl.split('?')[0] === h) || (h !== '/admin' && h !== '/app' && req.originalUrl.startsWith(h)) ? 'on' : ''}">${raw('<svg viewBox="0 0 24 24">' + (IC[t] || '') + '</svg>')}<span>${t}</span></a>`)}</nav>` : ''}</body></html>`;
module.exports = { LOGO, Raw, raw, html, R, badge, period, dt, layout, LBL };
