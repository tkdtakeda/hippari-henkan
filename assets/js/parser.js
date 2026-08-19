/* ============================================================================
 * parser.js — TrapeziumX / TrapeziumX-V の解析（仕様 §3・§5・§6 / 1.py v5 の移植）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── 定数（仕様 §5.0） ───────────────── */

const UNITS = new Set(["N", "N/mm2", "mm", "sec", "%", "MPa/s", "/sec", "mm/min", "GPa", "kN", "MPa"]);
const NUM_RE = /^-?\d+(\.\d+)?$/;
const CJK_RE = /[぀-ヿ一-鿿]/;

const COND_KEYS = ["品名", "試験片名", "厚さ", "幅", "直径", "平行部長さ", "つかみ具間距離",
  "ロードセル容量", "試験機種類", "作成者", "検討者", "承認者",
  "作成日", "試験日", "試験モード", "試験種類", "速度", "試験片形状",
  "バッチ数", "サブバッチ数"];
const COND_KEY_SET = new Set(COND_KEYS);

const NONVALUE = new Set([
  ...COND_KEYS, ...UNITS,
  "タイトル", "キーワード", "オペレータ", "コメント", "結果ファイル名", "条件ファイル名",
  "温度", "湿度", "機体番号", "伸び原点", "名前", "パラメータ", "合否判定", "単位",
  "変位計1標点距離", "変位計1リミット", "変位計1フルスケール", "変位計2フルスケール",
  "幅計標点距離", "幅計フルスケール",
]);

/* §5.3 レポート項目マッピング */
const REPORT_FIELDS = [
  ["引張強さ Rm",          "N/mm2",  ["最大点_応力", "最大点_Rm"]],
  ["耐力 Rp0.2",           "N/mm2",  ["耐力点1_応力", "耐力点1Rp"]],
  ["伸び",                 "%",      ["破断点_変位(ひずみ)", "破断点_At"]],
  ["応力増加速度",          "MPa/s",  ["応力増加速度"]],
  ["ひずみ速度",            "/sec",   ["歪速度"]],
  ["クロスヘッド変位速度",   "mm/min", ["実績クロスヘッド変異速度", "クロスヘッド変異速度"]],
  ["弾性率",               "N/mm2",  ["弾性率_Standard"]],
  ["ヤング率",             "GPa",    ["ヤング率"]],
  ["最大試験力 Fm",         "N",      ["最大点_試験力", "最大点_Fm"]],
  ["耐力点試験力",          "N",      ["耐力点1_試験力"]],
];

const MARKER = Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01]);
const CHANNELS = [["Time_sec", -8], ["Stroke_mm", -4], ["Force_N", 29], ["Extensometer_mm", 37]];
const BYTES_試験条件 = Uint8Array.from([0xE8, 0xA9, 0xA6, 0xE9, 0xA8, 0x93, 0xE6, 0x9D, 0xA1, 0xE4, 0xBB, 0xB6]);
const BYTES_TXVFileVersion = Uint8Array.from([...("TXVFileVersion")].map((c) => c.charCodeAt(0)));

/* ───────────────── フォーマット判別（§3） ───────────────── */
function detectFormat(data, filename) {
  const head = data.subarray(0, Math.min(64, data.length));
  if (findBytes(head, BYTES_TXVFileVersion) >= 0) {
    return { fmt: "vtav", basis: 'マジック "TXVFileVersion" を先頭 64 バイト内で検出' };
  }
  const ext = (filename.match(/\.[^.]*$/) || [""])[0].toLowerCase();
  if (ext === ".vtav") return { fmt: "vtav", basis: "拡張子 .vtav による判定（マジック未検出）" };
  return { fmt: "xtux", basis: `拡張子 ${ext || "(なし)"} による判定（マジック未検出）` };
}

/* ───────────────── 結果サマリー（§5.1 xtux：順序構造） ───────────────── */
function parseResultsXtux(tokens) {
  const toks = tokens.map((t) => t.text);
  const res = [];
  let i = 0;
  while (i < toks.length) {
    if (toks[i] === "名前") {
      let j = i;
      while (j < toks.length && toks[j] !== "単位") j++;
      let k = j + 1;
      const rows = [];
      let cur = [];
      while (k < toks.length) {
        const t = toks[k];
        if (NUM_RE.test(t) || t === "名前") break;
        cur.push(t);
        if (UNITS.has(t)) {
          rows.push([cur[0], t, cur.slice(1, -1).join(" ").trim()]);
          cur = [];
        }
        k++;
      }
      const vals = [];
      while (k < toks.length && NUM_RE.test(toks[k])) { vals.push(toks[k]); k++; }
      rows.forEach((r, idx) => res.push({
        label: r[0], unit: r[1], value: idx < vals.length ? vals[idx] : "", param: r[2],
      }));
      i = k;
      continue;
    }
    i++;
  }
  for (const r of res) if (r.label === "" && r.unit === "mm/min") r.label = "実績クロスヘッド変異速度";
  return res;
}

/* ───────────────── 結果サマリー（§5.2 vtav：バイトアンカー） ───────────────── */
function isResultLabel(s) {
  if (!CJK_RE.test(s)) return false;
  if (s === "全エリアで計算" || s.startsWith("計算式") || s.startsWith("速度センサー")) return false;
  if (s.includes("Arial") || s.startsWith("[") || s.startsWith("<<") || s.includes("->") ||
      s.startsWith("(") || s.includes("]") || s.includes("@")) return false;
  return s.includes("_") || s.includes("×") || s.includes("点") || s.endsWith("率") ||
         s.includes("速度") || s.includes("ヤング");
}
function nearestUnit(unitsSorted, voff) {
  let unit = "";
  for (const u of unitsSorted) {
    if (u.off >= voff) break;
    if (voff - u.off < 200) unit = u.text;
  }
  return unit;
}
/**
 * 値アンカー ([\x01-\x0f])(-?[0-9][0-9.\-]{0,14})\x00[\x01\x02]\x00\x00\x00 を
 * バイト列上で直接走査する（group1 の長さ整合チェック込み ＝ Python 版と等価）。
 */
function scanVtavAnchors(d) {
  const hits = [];
  const n = d.length;
  for (let i = 0; i + 6 < n; i++) {
    const L = d[i];
    if (L < 0x01 || L > 0x0F) continue;
    const end = i + 1 + L;
    if (end + 5 > n) continue;
    // 末尾 \x00 [\x01|\x02] \x00 \x00 \x00
    if (d[end] !== 0x00 || (d[end + 1] !== 0x01 && d[end + 1] !== 0x02) ||
        d[end + 2] !== 0x00 || d[end + 3] !== 0x00 || d[end + 4] !== 0x00) continue;
    // 値本体 -?[0-9][0-9.\-]{0,14}
    let p = i + 1;
    if (d[p] === 0x2D) p++;                                  // 先頭の '-'
    if (p >= end || !isDigit(d[p])) continue;                // 続く 1 文字は数字
    p++;
    let ok = true;
    for (; p < end; p++) {
      const b = d[p];
      if (!(isDigit(b) || b === 0x2E || b === 0x2D)) { ok = false; break; }
    }
    if (!ok) continue;
    let s = "";
    for (let q = i + 1; q < end; q++) s += String.fromCharCode(d[q]);
    hits.push({ off: i, val: s, na: false });
  }
  // 未算出 (N/A) アンカー \x03 "-.-" \x00 [\x01\x02] \x00\x00\x00
  for (let i = 0; i + 8 < n; i++) {
    if (d[i] !== 0x03 || d[i + 1] !== 0x2D || d[i + 2] !== 0x2E || d[i + 3] !== 0x2D) continue;
    if (d[i + 4] !== 0x00 || (d[i + 5] !== 0x01 && d[i + 5] !== 0x02) ||
        d[i + 6] !== 0x00 || d[i + 7] !== 0x00 || d[i + 8] !== 0x00) continue;
    hits.push({ off: i, val: "N/A", na: true });
  }
  hits.sort((a, b) => a.off - b.off);
  return hits;
}
function parseResultsVtav(data, tokens) {
  let auditStart = findBytes(data, BYTES_試験条件);
  if (auditStart < 0) auditStart = data.length;
  const dt = findDateTimeOffset(data);
  const resultsStart = dt >= 0 ? dt : 0;

  const labels = tokens.filter((t) => isResultLabel(t.text));
  const units  = tokens.filter((t) => UNITS.has(t.text));

  const res = [];
  const seen = new Set();
  let li = 0;                                   // labels は offset 昇順なのでポインタで追える
  for (const h of scanVtavAnchors(data)) {
    if (!(resultsStart <= h.off && h.off < auditStart)) continue;
    if (h.val === "0") continue;
    // 値アンカーより前で最も近いラベル（200 バイト以内）を採る。使い回しはしない。
    while (li < labels.length && labels[li].off < h.off) li++;
    const pick = li > 0 && h.off - labels[li - 1].off < 200 ? labels[li - 1] : null;
    if (!pick) continue;
    if (seen.has(pick.off)) continue;
    seen.add(pick.off);
    res.push({ label: pick.text, unit: nearestUnit(units, h.off), value: h.val, param: "" });
  }
  return res;
}

/* ============================================================================
 * 合否判定の「合格範囲」抽出（別紙: vtav/xtux 合格範囲抽出ルール仕様）
 *
 * 構造（全ファイル共通・20 バイト）:
 *   +0  00 00 00 00      uint32 = 0   ┐ MARK
 *   +4  01 00 00 00      uint32 = 1   ┘（判定有効フラグと推定）
 *   +8  [下限] float32(LE)
 *   +12 00 00 00 00      float32 = 0.0（区切り／中間値。判定には使わない）
 *   +16 [上限] float32(LE)
 *
 * MARK は汎用のバイト列なので単独では誤検出が非常に多い。§3 のフィルタを必ず通す。
 * 項目との対応づけは、ラベル文字列を「生の UTF-8 部分一致」で探して起点にする
 * （長さプレフィックスは vtav では一致するが xtux では一致しないため使わない）。
 * 値は試験方法ごとに違うので、必ずファイルから読む（ハードコードしない）。
 * ==========================================================================*/
const RANGE_MARK = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
const RANGE_WINDOW = 800;                 // ラベル位置から前方に見る窓（バイト）
const PASS_RANGE_ITEMS = [
  { key: "ramp",  labels: ["応力増加速度"],         unit: "MPa/s"  },
  { key: "srate", labels: ["歪速度"],               unit: "/sec"   },
  { key: "young", labels: ["ヤング率", "弾性率"],   unit: "GPa"    },  // vtav=ヤング率 / xtux=弾性率
  { key: "cross", labels: ["クロスヘッド変異速度"], unit: "mm/min" },
];

/** §3 有効判定フィルタ。1 つでも外れたら「合格範囲ではない」として捨てる。 */
function validPassRange(d, i) {
  if (i + 12 > d.length) return null;
  const dv = new DataView(d.buffer, d.byteOffset + i, 12);
  const lo = dv.getFloat32(0, true), mid = dv.getFloat32(4, true), hi = dv.getFloat32(8, true);
  if (mid !== 0) return null;                                   // 1. 中間 == 0.0
  if (!isFinite(lo) || !isFinite(hi)) return null;              // 3. 有限
  if (!(lo < hi)) return null;                                  // 2. 下限 < 上限
  if (!(lo > -1e5 && lo < 1e6 && hi < 1e6)) return null;        // 4. 桁が妥当
  if (lo === 0 && hi === 0) return null;                        // 5. (0,0) は未設定
  return { lo, hi, mid };
}

/**
 * ラベル候補の順に探し、最初に見つかった合格範囲を返す（§4）。
 *
 * 窓の中に「別項目のラベル」が現れたらそこで窓を打ち切る。仕様書どおり窓を固定長で
 * 取ると、項目が近接して並んでいるときに隣の項目の範囲を拾ってしまう（実測で確認）。
 * 打ち切ったときは、その出現位置は諦めて次の出現位置を見る。
 */
function findPassRange(data, labels, others) {
  const enc = new TextEncoder();
  const otherNeedles = (others || []).map((x) => enc.encode(x));
  for (const label of labels) {
    const needle = enc.encode(label);
    let idx = 0;
    for (;;) {
      const j = findBytes(data, needle, idx);                   // 生の部分一致
      if (j < 0) break;
      const win = data.subarray(j, Math.min(data.length, j + RANGE_WINDOW));
      let limit = win.length;
      for (const o of otherNeedles) {
        const at = findBytes(win, o, needle.length);            // ラベル自身の先は飛ばす
        if (at >= 0 && at < limit) limit = at;
      }
      let k = 0;
      for (;;) {
        const m = findBytes(win, RANGE_MARK, k);
        if (m < 0 || m >= limit) break;
        const r = validPassRange(data, j + m + 8);
        if (r) return { ...r, label, at: j + m };
        k = m + 1;
      }
      idx = j + 1;
    }
  }
  return null;
}

/** ファイル全体から各項目の合格範囲を拾う。見つからない項目は入れない。 */
function extractPassRanges(data) {
  const out = {};
  for (const it of PASS_RANGE_ITEMS) {
    /* 自分以外の項目名は「窓の打ち切り」に使う（隣の項目の範囲を拾わないため） */
    const others = PASS_RANGE_ITEMS.filter((x) => x !== it).flatMap((x) => x.labels);
    const r = findPassRange(data, it.labels, others);
    if (r) out[it.key] = { lo: r.lo, hi: r.hi, label: r.label, unit: it.unit, at: r.at };
  }
  return out;
}

/* ───────────────── 試験条件（§5.4） ───────────────── */
const DATE_RE = /^\d{4}\/\d{2}\/\d{2}( \d{1,2}:\d{2}:\d{2})?$/;
const DIM_RE = /^-?\d+\.\d+$/;
const LOADCELL_RE = /^\d+\s?kN$/;
const LOT_RE = /^[A-Z][0-9A-Z]{6,}$/;
const DIM_KEYS = new Set(["厚さ", "幅", "直径", "平行部長さ", "つかみ具間距離"]);

function validateCond(key, cand) {
  if (DIM_KEYS.has(key)) return DIM_RE.test(cand) ? cand : null;
  if (key === "作成日" || key === "試験日") return DATE_RE.test(cand) ? cand : null;
  if (key === "ロードセル容量") return LOADCELL_RE.test(cand) ? cand : null;
  if (key === "バッチ数" || key === "サブバッチ数") return /^\d+$/.test(cand) ? cand : null;
  return NONVALUE.has(cand) ? null : cand;
}
function extractConditions(tokens) {
  const vals = tokens.map((t) => t.text);
  const cond = {};
  for (let idx = 0; idx < vals.length; idx++) {
    const s = vals[idx];
    if (!COND_KEY_SET.has(s) || s in cond) continue;
    for (let j = idx + 1; j < Math.min(idx + 6, vals.length); j++) {
      const cand = vals[j];
      if (!cand || cand === s) continue;
      if (COND_KEY_SET.has(cand)) break;
      const ok = validateCond(s, cand);
      if (ok !== null) { cond[s] = ok; break; }
    }
  }
  for (const t of tokens) {
    if (LOT_RE.test(t.text)) { cond["ロット/製造番号"] = t.text; break; }
  }
  return cond;
}
/** §5.4.2 xtux の寸法補完（UTF-8 TLV 側の寸法セクションから拾う） */
function supplementXtuxDims(cond, u8tokens) {
  const vals = u8tokens.map((t) => t.text);
  const stop = new Set(["試験片名", "名前", "パラメータ", "合否判定", "単位"]);
  const filled = [];
  for (let idx = 0; idx < vals.length; idx++) {
    const s = vals[idx];
    if (!DIM_KEYS.has(s) || s in cond) continue;
    for (let j = idx + 1; j < Math.min(idx + 6, vals.length); j++) {
      const c = vals[j];
      if (DIM_KEYS.has(c) || stop.has(c)) break;
      if (DIM_RE.test(c)) { cond[s] = c; filled.push(s); break; }   // 小数のみ（フラグ "1" を除外）
    }
  }
  return filled;
}

/* ───────────────── 生波形（§5.5） ───────────────── */
function extractWaveform(data) {
  const pos = findAllBytes(data, MARKER);
  if (pos.length < 20) {
    return { ok: false, reason: `波形マーカー（01 00 00 00 00 01 01）の検出数が ${pos.length} 個（20 個未満）`, points: 0 };
  }
  const counts = new Map();
  for (let i = 0; i < pos.length - 1; i++) {
    const d = pos[i + 1] - pos[i];
    if (d > 0 && d < 4096) counts.set(d, (counts.get(d) || 0) + 1);
  }
  if (!counts.size) return { ok: false, reason: "マーカー間隔が全て 4096 バイト以上で、レコード周期を決められない", points: 0 };
  let stride = 0, best = -1;
  for (const [d, c] of counts) if (c > best) { best = c; stride = d; }   // 同数なら先に現れた方（Counter 相当）

  const good = [];
  for (let i = 0; i < pos.length - 1; i++) if (pos[i + 1] - pos[i] === stride) good.push(pos[i]);
  if (good.length && pos[pos.length - 1] - good[good.length - 1] === stride) good.push(pos[pos.length - 1]);
  if (good.length < 20) {
    return { ok: false, reason: `レコード周期 ${stride} バイトに一致する点が ${good.length} 個（20 個未満）`, points: 0, stride };
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const columns = {};
  const dropped = [];
  for (const [name, off] of CHANNELS) {
    const arr = new Float64Array(good.length);
    let ok = true;
    for (let i = 0; i < good.length; i++) {
      const p = good[i] + off;
      if (p < 0 || p + 4 > data.length) { ok = false; break; }
      const v = dv.getFloat32(p, true);
      if (Number.isNaN(v)) { ok = false; break; }               // NaN を含む列は採用しない
      arr[i] = v;
    }
    if (ok) columns[name] = arr; else dropped.push(name);
  }
  return { ok: Object.keys(columns).length > 0, stride, points: good.length, columns, dropped,
           reason: Object.keys(columns).length ? "" : "全チャネルが範囲外または NaN を含み、採用できる列がない" };
}

/* ───────────────── 変更履歴（§5.6, vtav のみ） ───────────────── */
function parseAudit(tokens) {
  const vals = tokens.map((t) => t.text);
  const dtRe = /^\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2}$/;
  const rows = [];
  for (let i = 0; i < vals.length; i++) {
    const s = vals[i];
    if (!(s.includes("試験条件") && s.startsWith("<<"))) continue;
    let change = i + 1 < vals.length ? vals[i + 1] : "";
    let when = "", user = "";
    for (let j = i + 1; j < Math.min(i + 4, vals.length); j++) {
      if (dtRe.test(vals[j])) {
        when = vals[j];
        user = j + 1 < vals.length ? vals[j + 1] : "";
        if (j === i + 1) change = "";
        break;
      }
    }
    rows.push({ item: s, change, datetime: when, user });
  }
  return rows;
}

/* ───────────────── レポート項目（§5.3） ───────────────── */
function buildReport(results) {
  const byLabel = new Map();
  for (const r of results) if (!byLabel.has(r.label)) byLabel.set(r.label, r);   // 先勝ち
  return REPORT_FIELDS.map(([item, unit, cands]) => {
    for (const c of cands) {
      if (byLabel.has(c)) return { item, value: byLabel.get(c).value, unit, source_label: c };
    }
    return { item, value: "", unit, source_label: "" };
  });
}
