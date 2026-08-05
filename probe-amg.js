// SMART Mataram — Periksa data yang bisa dibaca dari AMG
//
// HANYA MEMBACA. Satu-satunya POST adalah login (perlu untuk dapat sesi).
// Tidak ada save_ukur, tidak ada perubahan data apa pun di AMG.
//
// Tujuan: mencari dari mana kita bisa membaca `daya_trafo` versi AMG untuk
// sebuah gardu, supaya persentase beban yang kita kirim tidak lagi dihitung
// memakai kVA yang berbeda dengan milik AMG.
//
// Jalankan di PC yang ada di jaringan PLN (yang sama dengan smart-agent):
//   node probe-amg.js <NO_GARDU> [ULP]
//   contoh: node probe-amg.js GS201 AMPENAN
//
// Kalau alamat halaman yang benar sudah ketahuan dari browser, langsung tunjuk:
//   node probe-amg.js GS201 AMPENAN --url "/index.php/cUkur/input/44150GS201"
//
// Keluaran: probe-amg-hasil.txt (ringkasan) + probe-amg-*.html (halaman mentah).
// Kirim balik kedua-duanya.

require("dotenv").config();
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AMG_URL = "http://10.33.1.77/gardu" } = process.env;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const argv = process.argv.slice(2);
const iUrl = argv.indexOf("--url");
const urlManual = iUrl >= 0 ? argv[iUrl + 1] : null;
const bebas = argv.filter((a, i) => a !== "--url" && i !== iUrl + 1);
const noGardu = bebas[0];
const ulpArg = (bebas[1] || "").toUpperCase();

if (!noGardu) {
  console.error("Pakai: node probe-amg.js <NO_GARDU> [ULP]\ncontoh: node probe-amg.js 0123 AMPENAN");
  process.exit(1);
}

const baris = [];
const cetak = (s = "") => { console.log(s); baris.push(s); };

const originOf = (base) => base.replace(/\/gardu.*$/, "");

async function login(base, username, password) {
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
  if (!m.length) throw new Error("Login gagal — cek username/password di tabel amg_config");
  return `ci_session=${m[m.length - 1][1]}`;
}

/** Semua <input>/<select> beserta value-nya — ini yang memberi tahu field apa
 *  yang AMG kenal dan berapa nilai yang sudah diisikannya dari master. */
function bacaField(html) {
  const out = [];
  for (const m of html.matchAll(/<(input|select)\b[^>]*>/gi)) {
    const tag = m[0];
    const nama = (tag.match(/name\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!nama) continue;
    const nilai = (tag.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1] ?? "";
    out.push({ nama, nilai });
  }
  return out;
}

const judul = (html) => (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "-";

/** Potongan HTML di sekitar kata kunci — untuk melihat nilai yang tampil
 *  sebagai teks (bukan input), mis. di tabel detail. */
function sekitar(html, kata, lebar = 220) {
  const i = html.toLowerCase().indexOf(kata.toLowerCase());
  if (i < 0) return null;
  return html.slice(Math.max(0, i - lebar), i + lebar).replace(/\s+/g, " ");
}

async function ambil(base, cookie, path) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": UA, Cookie: cookie, Referer: `${base}/index.php` },
      redirect: "manual",
    });
    const html = await res.text().catch(() => "");
    return { status: res.status, lokasi: res.headers.get("location"), html };
  } catch (e) {
    return { status: 0, err: String(e).slice(0, 160), html: "" };
  }
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi di .env");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: cfgs, error } = await supabase.from("amg_config").select("*");
  if (error) { console.error("Gagal baca amg_config:", error.message); process.exit(1); }

  const cfg = ulpArg ? (cfgs || []).find((c) => c.ulp === ulpArg) : (cfgs || [])[0];
  if (!cfg) { console.error(`Kredensial AMG untuk ULP ${ulpArg || "(pertama)"} tidak ada di amg_config`); process.exit(1); }

  const base = cfg.amg_url || AMG_URL;
  const prefixes = String(cfg.kode_prefixes || "44150,44151").split(",").map((s) => s.trim()).filter(Boolean);

  cetak(`=== PERIKSA AMG (baca saja) ===`);
  cetak(`ULP      : ${cfg.ulp}`);
  cetak(`AMG      : ${base}`);
  cetak(`No gardu : ${noGardu}`);
  cetak(`Prefix   : ${prefixes.join(", ")}`);
  cetak(`Waktu    : ${new Date().toISOString()}`);
  cetak();

  // Nilai pembanding dari SMART
  const { data: smart } = await supabase
    .from("pengukuran_gardu")
    .select("no_gardu,kva_trafo,beban_kva,persen_beban,tanggal_pengukuran,petugas_unit")
    .eq("no_gardu", noGardu)
    .order("tanggal_pengukuran", { ascending: false })
    .limit(1);

  if (smart && smart[0]) {
    const s = smart[0];
    cetak(`-- Nilai di SMART (pengukuran terakhir ${s.tanggal_pengukuran}) --`);
    cetak(`   kva_trafo    : ${s.kva_trafo}`);
    cetak(`   beban_kva    : ${s.beban_kva}   <- hasil ukur, TIDAK bergantung kVA trafo`);
    cetak(`   persen_beban : ${s.persen_beban}   <- = beban_kva / kva_trafo x 100`);
    cetak();
  } else {
    cetak(`-- Belum ada pengukuran di SMART untuk gardu ${noGardu} --`);
    cetak();
  }

  let cookie;
  try {
    cookie = await login(base, cfg.username, cfg.password);
    cetak(`Login AMG: BERHASIL`);
  } catch (e) {
    cetak(`Login AMG: GAGAL — ${e.message}`);
    fs.writeFileSync("probe-amg-hasil.txt", baris.join("\n"));
    process.exit(1);
  }
  cetak();

  // Tebakan alamat halaman. AMG memakai CodeIgniter, jadi polanya
  // /index.php/<controller>/<method>/<argumen>. Yang kena akan terlihat dari
  // munculnya field daya_trafo.
  const kandidat = [];
  if (urlManual) {
    kandidat.push(urlManual);
  } else {
    for (const p of prefixes) {
      const kode = p + noGardu;
      for (const m of ["input", "ukur", "detail", "edit", "form", "save_ukur", "view"]) {
        kandidat.push(`/index.php/cUkur/${m}/${kode}`);
      }
      kandidat.push(
        `/index.php/cUkur?kode=${kode}`,
        `/index.php/cUkur/index/${kode}`,
        `/index.php/cGardu/detail/${kode}`,
        `/index.php/cGardu/edit/${kode}`,
        `/index.php/cGardu?kode=${kode}`,
      );
    }
    kandidat.push("/index.php/cUkur", "/index.php/cGardu", "/index.php");
  }

  const menarik = [];
  let n = 0;

  for (const path of kandidat) {
    const r = await ambil(base, cookie, path);
    // `daya_trafo` = nama field yang dipakai saat kirim. `kva`/`daya` ikut
    // dijaring kalau AMG menampilkannya sebagai teks, bukan input.
    const punyaDaya = /daya_trafo|i_nominal/i.test(r.html);
    const mungkin = !punyaDaya && r.status === 200 && /\bkva\b|daya\s*trafo/i.test(r.html);
    const tanda = punyaDaya ? "  *** ADA daya_trafo/i_nominal ***" : mungkin ? "  (menyebut kVA/daya trafo)" : "";
    cetak(`[${String(r.status).padStart(3)}] ${path}${r.lokasi ? ` -> ${r.lokasi}` : ""}${r.err ? ` (${r.err})` : ""}${tanda}`);

    if (punyaDaya || mungkin) {
      // Simpan halaman mentah — parser yang tepat baru bisa ditulis setelah
      // bentuk HTML-nya terlihat.
      const nama = `probe-amg-${String(++n).padStart(2, "0")}.html`;
      fs.writeFileSync(nama, `<!-- ${base}${path} -->\n${r.html}`);
      cetak(`      halaman disimpan: ${nama} (${r.html.length} karakter)`);
      if (punyaDaya) menarik.push({ path, html: r.html });
    }
  }

  cetak();
  if (!menarik.length) {
    cetak("KESIMPULAN: tidak ada alamat tebakan yang memuat daya_trafo.");
    cetak("Belum berarti AMG tidak punya — kemungkinan besar alamatnya beda.");
    cetak("Langkah manual (1 menit):");
    cetak("  1. Buka AMG di browser, masuk ke halaman input pengukuran satu gardu.");
    cetak("  2. Salin URL-nya dari address bar.");
    cetak("  3. Jalankan ulang dengan alamat itu, contoh:");
    cetak(`     node probe-amg.js ${noGardu} ${cfg.ulp} --url "/index.php/cUkur/input/44150${noGardu}"`);
    cetak("  4. Kirim probe-amg-hasil.txt + semua probe-amg-*.html.");
  } else {
    for (const m of menarik) {
      cetak(`===== ${m.path} =====`);
      cetak(`judul: ${judul(m.html)}`);
      const fields = bacaField(m.html);
      cetak(`jumlah field form: ${fields.length}`);
      for (const f of fields) {
        const penting = /daya_trafo|i_nominal|kode|beban|kva/i.test(f.nama);
        cetak(`   ${penting ? ">>" : "  "} ${f.nama} = ${JSON.stringify(f.nilai)}`);
      }
      const konteks = sekitar(m.html, "daya_trafo");
      if (konteks) { cetak(`   konteks daya_trafo: ...${konteks}...`); }
      cetak();
    }
  }

  fs.writeFileSync("probe-amg-hasil.txt", baris.join("\n"));
  cetak("Hasil lengkap tersimpan di probe-amg-hasil.txt");
})();
