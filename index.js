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
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi di .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const INTERVAL = Math.max(15, parseInt(POLL_INTERVAL_SEC, 10) || 60) * 1000;
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
    keterangan: String(row.petugas_nama ?? ""),
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

// cfg = { username, password, kode_prefixes, amg_url }
async function sendOne(row, cfg) {
  const base = cfg.amg_url || AMG_URL;
  const prefixes = String(cfg.kode_prefixes || "44150,44151").split(",").map((p) => p.trim()).filter(Boolean);
  const cookie = await loginAmg(base, cfg.username, cfg.password);
  for (const prefix of prefixes) {
    const res = await fetch(`${base}/index.php/cUkur/save_ukur`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA, Cookie: cookie, Referer: `${base}/index.php/cUkur/save_ukur`,
      },
      body: buildBody(row, prefix),
      redirect: "manual",
    });
    try { await res.text(); } catch (_) { /* drain */ }
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────────
async function tick() {
  const { data, error } = await supabase
    .from("pengukuran_gardu")
    .select("*")
    .not("amg_queued_at", "is", null)
    .is("amg_sent_at", null)
    .limit(25);

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
      await supabase.from("pengukuran_gardu")
        .update({ amg_error: `Kredensial AMG ULP ${row.petugas_unit || "?"} belum diatur` })
        .eq("id", row.id);
      console.error("  ✗ kredensial ULP belum diatur:", row.petugas_unit, "-", row.no_gardu);
      continue;
    }
    try {
      await sendOne(row, cfg);
      await supabase.from("pengukuran_gardu").update({ amg_sent_at: new Date().toISOString(), amg_error: null }).eq("id", row.id);
      console.log(`  ✓ terkirim: ${row.no_gardu} (${row.petugas_unit})`);
    } catch (e) {
      await supabase.from("pengukuran_gardu").update({ amg_error: String(e).slice(0, 300) }).eq("id", row.id);
      console.error("  ✗ gagal:", row.no_gardu, "-", String(e).slice(0, 120));
    }
  }
}

console.log(`SMART AMG agent aktif · AMG default=${AMG_URL} · kredensial per-ULP dari tabel amg_config · interval ${INTERVAL / 1000}s`);
tick();
setInterval(tick, INTERVAL);
