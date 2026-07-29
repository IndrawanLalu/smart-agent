# SMART AMG Agent

Agen kecil yang jalan di **PC dalam jaringan PLN** untuk mengirim pengukuran gardu ke **AMG** (`10.33.1.77`) — sistem yang hanya bisa diakses dari intranet.

## Cara kerja
```
User klik "Kirim ke AMG" di web SMART  →  amg_queued_at diisi (antre)
Agen ini (di LAN PLN):
  1. tiap N detik, tarik dari Supabase yang amg_queued_at terisi & amg_sent_at kosong
  2. login ke AMG + POST data (di dalam LAN)
  3. isi amg_sent_at  (atau amg_error kalau gagal)
Web menampilkan "Terkirim ✓".
```
Hanya koneksi **keluar** (Supabase + AMG) — tak perlu VPN / buka port.

## Pasang (sekali)
```bash
# di PC lokal (Node 18+):
cd smart-agent
npm install
copy .env.example .env      # lalu isi .env
npm start                   # uji manual dulu
```

## Jalan otomatis (auto-start saat PC nyala) — PM2
```bash
npm install -g pm2
pm2 start index.js --name smart-amg-agent
pm2 save
pm2 startup            # ikuti instruksi yang muncul agar auto-start saat boot
```
Cek log: `pm2 logs smart-amg-agent`

## Prasyarat
- PC ini bisa membuka `http://10.33.1.77/gardu` (di jaringan PLN).
- Kolom DB sudah ada: jalankan `scripts/add-pengukuran-amg-queue.sql` di Supabase.
- `AMG_USERNAME` / `AMG_PASSWORD` valid.
