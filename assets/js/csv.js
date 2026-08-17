/* ============================================================================
 * csv.js — CSV の出力と入力（§6・§11.1）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── CSV 出力（§6） ───────────────── */
const BOM = Uint8Array.from([0xEF, 0xBB, 0xBF]);
function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
/** UTF-8 BOM 付きバイト列にする（Excel で文字化けしないこと） */
function csvBytes(text) {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM, 0);
  out.set(body, BOM.length);
  return out;
}
/**
 * 波形の小数 6 桁丸め。Python の round(x, 6) と同じ「偶数丸め」にそろえる
 * （float32 由来の値では x*1e6 が誤差なく求まるため、これで Python 版と完全一致する）。
 */
function round6HalfEven(v) {
  if (!isFinite(v)) return v;
  const s = v * 1e6;
  const f = Math.floor(s);
  const d = s - f;
  const n = d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
  return n / 1e6;
}
/** Python の str(float) と同じ見た目にする（整数値でも小数点を残す） */
function pyFloat(v) {
  const r = round6HalfEven(v);
  if (Object.is(r, -0)) return "-0.0";
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}
function downloadBytes(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────── CSV 入力（§11.1 / 列マッピング・文字コード自動判別） ───────────────── */
const CSV_ROLES = [
  { role: "time",         label: "時間",     unit: "sec",    pats: [/^時間/, /^時刻/, /time/i, /^t$/i] },
  { role: "force",        label: "試験力",   unit: "N",      pats: [/^試験力/, /^荷重/, /force/i, /^load/i] },
  { role: "stress",       label: "応力",     unit: "N/mm2",  pats: [/^応力/, /stress/i] },
  { role: "displacement", label: "変位計1",  unit: "mm",     pats: [/^変位計/, /^伸び計/, /extensometer/i, /^変位/, /^伸び/] },
  { role: "stroke",       label: "ストローク", unit: "mm",   pats: [/^ストローク/, /stroke/i, /クロスヘッド/] },
];
function decodeTextAuto(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), enc: "UTF-8（BOM 検出）" };
  }
  for (const [label, name] of [["utf-8", "UTF-8（strict 判定）"], ["shift_jis", "Shift_JIS"], ["euc-jp", "EUC-JP"]]) {
    try {
      const text = new TextDecoder(label, { fatal: true }).decode(bytes);
      return { text, enc: name };
    } catch (_) { /* 次の候補へ */ }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), enc: "UTF-8（不正バイトは置換）" };
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === "\t") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const toNumber = (s) => {
  if (s == null) return NaN;
  const t = String(s).replace(/[, ]/g, "").trim();
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
  return parseFloat(t);
};
/** CSV テキスト → {headers, headerRow, rows(生行), map(role→列index)} */
function parseInputCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l, i, a) => l.length > 0 || i < a.length - 1);
  const cells = lines.map(splitCsvLine);
  let headerRow = -1, bestScore = 0, bestMap = null;
  const limit = Math.min(cells.length, 40);
  for (let r = 0; r < limit; r++) {
    const hdr = cells[r].map((h) => h.trim());
    if (hdr.filter(Boolean).length < 2) continue;
    const used = new Set();
    const map = {};
    let score = 0;
    for (const spec of CSV_ROLES) {
      let pick = -1, pri = 99;
      hdr.forEach((h, ci) => {
        if (!h || used.has(ci)) return;
        spec.pats.forEach((p, pi) => {
          if (p.test(h) && pi < pri) { pri = pi; pick = ci; }
        });
      });
      if (pick >= 0) { map[spec.role] = pick; used.add(pick); score++; }
    }
    if (score > bestScore) { bestScore = score; headerRow = r; bestMap = map; }
  }
  if (headerRow < 0 || !bestMap || bestMap.force == null) {
    return { ok: false, reason: "ヘッダ行から「試験力」に相当する列を特定できませんでした" };
  }
  const headers = cells[headerRow].map((h) => h.trim());
  const rows = [];
  for (let r = headerRow + 1; r < cells.length; r++) {
    const v = toNumber(cells[r][bestMap.force]);
    if (!isFinite(v)) continue;                       // 単位行・空行などは読み飛ばす
    rows.push(cells[r]);
  }
  return { ok: true, headers, headerRow, rows, map: bestMap };
}
function csvColumns(parsed, map) {
  const n = parsed.rows.length;
  const cols = {};
  for (const spec of CSV_ROLES) {
    const ci = map[spec.role];
    if (ci == null || ci < 0) { cols[spec.role] = null; continue; }
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = toNumber(parsed.rows[i][ci]);
    cols[spec.role] = arr;
  }
  return cols;
}
