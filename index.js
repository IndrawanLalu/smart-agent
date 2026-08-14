// SMART Mataram — Agen Lokal AMG
// Jalan di PC dalam jaringan PLN. Menarik pengukuran yang "diantre" dari Supabase
// (koneksi keluar) lalu mengirimnya ke AMG (10.33.1.77, di dalam LAN). Set-and-forget.
//
// Pasang: npm install → isi .env → `pm2 start index.js --name smart-amg-agent`
// Node 18+ (butuh global fetch).

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  AMG_URL = "http://10.33.1.77/gardu", // default; bisa dioverride per-ULP di tabel amg_config
  POLL_INTERVAL_SEC = "60",
  AMG_MAX_ATTEMPTS = "3",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi di .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const INTERVAL = Math.max(15, parseInt(POLL_INTERVAL_SEC, 10) || 60) * 1000;
const MAX_ATTEMPTS = Math.max(1, parseInt(AMG_MAX_ATTEMPTS, 10) || 3);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const originOf = (base) => base.replace(/\/gardu.*$/, "");

// ── Perhitungan & body (sama dengan /api/kirim-amg) ──────────────────────────
const toAmgDate = (s) => { const [y, m, d] = String(s).split("-"); return `${d}-${m}-${y}`; };
const calcINominal = (kva) => ((kva * 1000) / (Math.sqrt(3) * 400)).toFixed(2);
function calcUnbalance(r, s, t) {
  const avg = (r + s + t) / 3;
  if (avg === 0) return "0";
  const dev = Math.abs(r - avg) + Math.abs(s - avg) + Math.abs(t - avg);
  return ((dev / (3 * avg)) * 100).toFixed(2);
}

/**
 * Isi kolom keterangan di AMG: nama petugas, ditambah penanda kalau baris ini
 * hasil penyeimbangan beban — mis. "Amnan (Penyeimbangan Beban)".
 *
 * Penandanya `hasil_penyeimbangan_id`, kolom di `pengukuran_gardu` yang merujuk
 * balik ke rekap penyeimbangan. `jenis_pemeliharaan` TIDAK bisa dipakai: itu
 * jenis WO yang menempel pada baris pengukuran ANOMALI-nya, dan pada baris
 * hasilnya nilainya null (diperiksa langsung ke data).
 */
function keteranganUntuk(row) {
  const nama = String(row.petugas_nama ?? "").trim();
  if (!row.hasil_penyeimbangan_id) return nama;
  return nama ? `${nama} (Penyeimbangan Beban)` : "(Penyeimbangan Beban)";
}

function buildBody(row, prefix) {
  const perjurusan = row.perjurusan || {};
  const f = {
    kode: prefix + String(row.no_gardu ?? ""),
    i_nominal: calcINominal(Number(row.kva_trafo ?? 0)),
    daya_trafo: String(row.kva_trafo ?? 0),
    mode: "input",
    tglcatat: toAmgDate(String(row.tanggal_pengukuran ?? "")),
    jam: String(row.jam_pengukuran ?? "00:00:00"),
    arus_r_sekunder: String(row.total_arus_r ?? 0),
    teg_rs_sekunder: String(row.total_teg_rs ?? 0),
    teg_rn_sekunder: String(row.total_teg_rn ?? 0),
    arus_s_sekunder: String(row.total_arus_s ?? 0),
    teg_rt_sekunder: String(row.total_teg_rt ?? 0),
    teg_sn_sekunder: String(row.total_teg_sn ?? 0),
    arus_t_sekunder: String(row.total_arus_t ?? 0),
    teg_st_sekunder: String(row.total_teg_st ?? 0),
    teg_tn_sekunder: String(row.total_teg_tn ?? 0),
    arus_n_sekunder: String(row.total_arus_n ?? 0),
    arus_r_pju: "0", arus_s_pju: "0", arus_t_pju: "0",
    arus_unbalance: calcUnbalance(Number(row.total_arus_r ?? 0), Number(row.total_arus_s ?? 0), Number(row.total_arus_t ?? 0)),
    beban_total: String(row.beban_kva ?? 0),
    beban_total_persen: String(row.persen_beban ?? 0),
    temperatur: String(row.suhu_trafo ?? 0),
    keterangan: keteranganUntuk(row),
    submit: "Simpan",
  };
  for (const [key, suffix] of [["A", "a"], ["B", "b"], ["C", "c"], ["D", "d"], ["K", "k"]]) {
    const jur = perjurusan[key];
    f[`arusphasa_r_${suffix}`] = String(jur?.arus?.R ?? "");
    f[`tegujung_r_${suffix}`] = String(jur?.tegangan?.R ?? "");
    f[`arusphasa_s_${suffix}`] = String(jur?.arus?.S ?? "");
    f[`tegujung_s_${suffix}`] = String(jur?.tegangan?.S ?? "");
    f[`arusphasa_t_${suffix}`] = String(jur?.arus?.T ?? "");
    f[`tegujung_t_${suffix}`] = String(jur?.tegangan?.T ?? "");
    f[`arusphasa_n_${suffix}`] = String(jur?.arus?.N ?? "");
  }
  return new URLSearchParams(f);
}

async function loginAmg(base, username, password) {
  const res = await fetch(`${base}/index.php/cLogin/login`, {
    method: "POST",
    signal: AbortSignal.timeout(12000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, Origin: originOf(base), Referer: `${base}/index.php/cLogin`,
    },
    body: new URLSearchParams({ username, password, submit: "Log In" }),
    redirect: "manual",
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const m = [...raw.matchAll(/ci_session=([^;]+)/g)];
  if (!m.length) throw new Error("Login AMG gagal — cek username/password ULP");
  return `ci_session=${m[m.length - 1][1]}`;
}

/** Ambil value <input name="daya_trafo"> — urutan atribut bisa terbalik. */
function parseDayaTrafo(html) {
  const m =
    html.match(/name=["']daya_trafo["'][^>]*?value=["']([^"']*)["']/i) ||
    html.match(/value=["']([^"']*)["'][^>]*?name=["']daya_trafo["']/i);
  if (!m) return null;
  const n = Number(String(m[1]).trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Baca kVA versi AMG lewat tahap pencarian gardu.
 *
 * AMG dua tahap: cari gardu (cGardu/list_gardu_pengukuran) → form pengukuran
 * muncul dengan daya_trafo TERISI dari master. Null = gardu tidak ada pada
 * prefix itu.
 */
async function fetchAmgKva(base, cookie, noGardu, prefix) {
  const res = await fetch(`${base}/index.php/cGardu/list_gardu_pengukuran`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, Cookie: cookie, Referer: `${base}/index.php/cUkur`,
    },
    body: new URLSearchParams({
      kodegardu: noGardu,
      kodegarduid: prefix + noGardu,
      mode: "input",
      submit: "Tampilkan",
    }),
    redirect: "manual",
  });
  const html = await res.text().catch(() => "");
  return parseDayaTrafo(html);
}

// cfg = { username, password, kode_prefixes, amg_url }
async function sendOne(row, cfg) {
  const base = cfg.amg_url || AMG_URL;
  const prefixes = String(cfg.kode_prefixes || "44150,44151").split(",").map((p) => p.trim()).filter(Boolean);
  const cookie = await loginAmg(base, cfg.username, cfg.password);
  const noGardu = String(row.no_gardu ?? "");
  const kvaSmart = Number(row.kva_trafo ?? 0);

  // Cari gardunya dulu. Selain memberi kVA versi AMG, ini menentukan prefix mana
  // yang benar — sebelumnya body yang sama ditembakkan ke semua prefix.
  let prefixCocok = null;
  let kvaAmg = null;
  for (const prefix of prefixes) {
    const kva = await fetchAmgKva(base, cookie, noGardu, prefix);
    if (kva !== null) { prefixCocok = prefix; kvaAmg = kva; break; }
  }

  if (prefixCocok === null) {
    throw new Error(`Gardu ${noGardu} tidak ditemukan di AMG (prefix: ${prefixes.join(", ")})`);
  }

  // Gerbang kVA: rating trafo beda = penyebut persentase beban beda. Menanam
  // angka yang bertentangan dengan master AMG lebih buruk daripada tidak kirim.
  if (Math.abs(kvaAmg - kvaSmart) > 0.01) {
    throw new Error(`kVA berbeda — SMART ${kvaSmart} kVA, AMG ${kvaAmg} kVA. Samakan dulu data trafonya.`);
  }

  const res = await fetch(`${base}/index.php/cUkur/save_ukur`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, Cookie: cookie, Referer: `${base}/index.php/cUkur/save_ukur`,
    },
    body: buildBody(row, prefixCocok),
    redirect: "manual",
  });

  // Respons dibaca, bukan dibuang: halaman galat AMG pun berstatus 200, jadi
  // tanpa memeriksa isinya status "terkirim" cuma dugaan.
  const balasan = await res.text().catch(() => "");
  if (res.status >= 400 || /gagal|error|tidak valid/i.test(balasan.slice(0, 2000))) {
    throw new Error(`AMG menolak simpan (HTTP ${res.status})`);
  }
  return { prefix: prefixCocok, kvaAmg };
}

// ── Loop ─────────────────────────────────────────────────────────────────────
async function tick() {
  // Ambil hanya yang belum mentok batas percobaan. Tanpa filter ini, baris yang
  // gagal permanen (mis. URL AMG salah) dicoba ulang tiap siklus selamanya.
  const { data, error } = await supabase
    .from("pengukuran_gardu")
    .select("*")
    .not("amg_queued_at", "is", null)
    .is("amg_sent_at", null)
    .lt("amg_attempts", MAX_ATTEMPTS)
    .limit(100);

  if (error) { console.error(new Date().toISOString(), "query error:", error.message); return; }
  if (!data || data.length === 0) return;

  // Kredensial per-ULP dari tabel amg_config
  const { data: cfgs } = await supabase.from("amg_config").select("*");
  const byUlp = {};
  for (const c of cfgs || []) byUlp[c.ulp] = c;

  console.log(new Date().toISOString(), `${data.length} pengukuran di antrean → kirim ke AMG`);
  for (const row of data) {
    const cfg = byUlp[row.petugas_unit];
    if (!cfg || !cfg.username || !cfg.password) {
      const n = (row.amg_attempts ?? 0) + 1;
      await supabase.from("pengukuran_gardu")
        .update({ amg_error: `Kredensial AMG ULP ${row.petugas_unit || "?"} belum diatur`, amg_attempts: n })
        .eq("id", row.id);
      console.error(`  ✗ kredensial ULP belum diatur: ${row.petugas_unit} - ${row.no_gardu} (percobaan ${n}/${MAX_ATTEMPTS})`);
      continue;
    }
    try {
      const hasil = await sendOne(row, cfg);
      await supabase.from("pengukuran_gardu")
        .update({ amg_sent_at: new Date().toISOString(), amg_error: null, amg_attempts: 0 })
        .eq("id", row.id);
      console.log(`  ✓ terkirim: ${hasil.prefix}${row.no_gardu} (${row.petugas_unit}) · kVA ${hasil.kvaAmg}`);
    } catch (e) {
      const pesan = String(e).replace(/^Error:\s*/, "");
      // Selisih kVA bukan kegagalan sementara — mencoba ulang tidak akan
      // mengubah apa pun sampai datanya dibetulkan manusia. Langsung mentokkan
      // percobaannya supaya tidak menyibukkan antrean tiap siklus.
      const bedaKva = pesan.startsWith("kVA berbeda");
      const n = bedaKva ? MAX_ATTEMPTS : (row.amg_attempts ?? 0) + 1;
      await supabase.from("pengukuran_gardu")
        .update({ amg_error: pesan.slice(0, 300), amg_attempts: n })
        .eq("id", row.id);
      const habis = n >= MAX_ATTEMPTS
        ? (bedaKva ? " — BUTUH PERBAIKAN DATA, tidak dicoba lagi" : " — BERHENTI, antre ulang dari web untuk mencoba lagi")
        : "";
      console.error(`  ✗ gagal (${n}/${MAX_ATTEMPTS}): ${row.no_gardu} - ${pesan.slice(0, 120)}${habis}`);
    }
  }
}

console.log(`SMART AMG agent aktif · AMG default=${AMG_URL} · kredensial per-ULP dari tabel amg_config · interval ${INTERVAL / 1000}s · maks ${MAX_ATTEMPTS} percobaan/baris`);
tick();
setInterval(tick, INTERVAL);
