/* ============================================================================
 * report.js — レポートモード（配置優先版）
 *
 * 用紙 1 枚に「表（上）＋ 応力-変位(伸び) の全体像グラフ（最下部）」を並べる。
 * 表は 名前／単位／測定値／合否判定 の 4 行構成。
 *
 * ★ いまの段階は「見栄えを確定させる」ためのもの。表の測定値と合否判定は
 *   配置確認用の仮の値で、解析結果との結合は次の工程で行う（画面にもそう書く）。
 *   ここを差し替えるときは REPORT_COLS の value / judge を実データから作る。
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── 表の列（左から並ぶ順） ─────────────────
 * name  … 見出し 1 行目「名前」
 * sub   … 見出し 2 行目「元データ名」（変換元ファイルでのラベル）
 * unit  … 「単位」。単位を持たない項目は "—"
 * get   … 「測定値」を解析結果から取り出す関数（無ければ null → 算出不可）
 * d/exp … 測定値と合格範囲の書式（小数桁 / 指数表記）
 * judge … 許容範囲を持つ項目のキー（JUDGE_RANGES）。無い項目は合否判定をしない
 * kind  … measure = 測定値 / spec = 試験片の寸法（合否判定の対象外）
 * na    … 算出できないときに理由を探すためのことば（解析の blocked を引く）
 * w     … 表の列幅の重み（桁数の多い列を少し広くする）
 *
 * name / sub の `|` は「ここでなら改行してよい」印（単語の途中では折り返さない）。
 * `_` の直後も改行してよい。どちらの印も表示には出ない。
 */
const REPORT_COLS = [
  { key: "force", srcLabels: ["最大点_試験力", "最大点_Fm"], why: (e, A) => (A && A.rm ? A.rm.basis : ""),  w: 1,    kind: "measure", name: "試験力",           sub: "最大点_試験力",
    unit: "N",      d: 0, na: "試験力",
    get: (e, A) => (A && A.max && fin(A.max.force) ? A.max.force : null) },
  { key: "stress", srcLabels: ["最大点_応力", "最大点_Rm"], why: (e, A) => (A && A.rm ? A.rm.basis : ""), w: 1,    kind: "measure", name: "引張強さ",         sub: "最大点_応力",
    unit: "N/mm²",  d: 1, na: "応力",
    get: (e, A) => (A && A.rm ? A.rm.value : null) },
  { key: "elong", srcLabels: ["破断点_変位(ひずみ)", "破断点_At"], why: (e, A) => (A && A.elongation ? `${A.elongation.method}／${A.elongation.basis}` : ""),  w: 0.95, kind: "measure", name: "伸び",             sub: "破断点_変位|(ひずみ)",
    unit: "%",      d: 2, na: "伸び",
    get: (e, A) => (A && A.elongation ? A.elongation.value : null) },
  { key: "young", srcLabels: ["弾性率_Standard"], why: (e, A) => (A && A.linear ? `弾性直線域（第 ${A.linear.startIdx + 1}〜${A.linear.cutoffIdx + 1} 点）の勾配 × 100` : ""),  w: 1.15, kind: "measure", name: "弾性率",           sub: "弾性率_Standard",
    unit: "N/mm²",  d: 0, na: "弾性勾配", judge: "young",
    get: (e, A) => (A && A.youngs ? A.youngs.nmm2 : null) },
  { key: "ramp", srcLabels: ["応力増加速度"], why: (e, A) => (A && A.rampRate ? A.rampRate.basis : ""),   w: 1,    kind: "measure", name: "応力|増加速度",     sub: "応力|増加速度",
    unit: "MPa/s",  d: 2, na: "応力増加速度", judge: "ramp",
    get: (e, A) => (A && A.rampRate ? A.rampRate.value : null) },
  { key: "srate", srcLabels: ["歪速度"], why: (e, A) => (A && A.strainRate1 ? A.strainRate1.basis : ""),  w: 1.15, kind: "measure", name: "ひずみ速度",       sub: "歪速度",
    unit: "s⁻¹",    exp: true, na: "ひずみ", judge: "srate",
    get: (e, A) => (A && A.strainRate1 ? A.strainRate1.value : null) },
  { key: "cross", srcLabels: ["実績クロスヘッド変異速度", "クロスヘッド変異速度"], why: (e, A) => (A ? A.vCrossBasis || "" : ""),  w: 1.1,  kind: "measure", name: "実績クロス|変位速度", sub: "実績|クロスヘッド|変異速度",
    unit: "mm/min", d: 2, na: "実績クロス変位速度", judge: "cross",
    get: (e, A) => (A && fin(A.vCross) ? A.vCross : null) },
  { key: "thick",  w: 0.9,  kind: "spec",    name: "厚さ",             sub: "試験条件",
    unit: "mm",     d: 3, get: (e) => dimOf(e, "厚さ"), why: (e) => dimWhy(e, "厚さ") },
  { key: "width",  w: 0.9,  kind: "spec",    name: "幅",               sub: "試験条件",
    unit: "mm",     d: 2, get: (e) => dimOf(e, "幅"), why: (e) => dimWhy(e, "幅") },
];

/** 単語の途中では折り返さない。`_` の直後と `|` の位置だけ改行を許す（`|` は表示しない）。 */
function labelHtml(s) {
  return esc(s).split("|").map((part) => part.replace(/_/g, "_<wbr>")).join("<wbr>");
}

/** 列の書式（測定値）。指数表記の列は仮数 2 桁。 */
const colFmt = (col, v) => (col.exp ? fmtExp(v, 2) : fmtNum(v, col.d != null ? col.d : 2));
/** 合格範囲は 2 つ並ぶので、指数表記の列だけ仮数を 1 桁に詰めて 1 行に近づける */
const colFmtR = (col, v) => (col.exp ? fmtExp(v, 1) : colFmt(col, v));

/** 試験片の寸法。手入力があればそちらを、無ければ試験条件から。 */
function dimOf(e, key) {
  const o = e.areaOverride || {};
  if (o.mode === "plate") {
    if (key === "厚さ" && fin(o.t)) return o.t;
    if (key === "幅" && fin(o.w)) return o.w;
  }
  const v = parseFloat((e.cond || {})[key]);
  return isFinite(v) ? v : null;
}

/** 寸法の出どころ */
function dimWhy(e, key) {
  const o = e.areaOverride || {};
  const manual = o.mode === "plate" && ((key === "厚さ" && fin(o.t)) || (key === "幅" && fin(o.w)));
  return manual ? "解析タブの「断面積 A とゲージ長」で手入力した値" : "変換元ファイルの試験条件から";
}

/** 算出できなかった理由を解析結果から拾う */
function naWhy(A, word) {
  if (!A) return "解析できていないため算出していません";
  const b = (A.blocked || []).find((x) => x.what.includes(word));
  return b ? `${b.what}: ${b.why}` : "この項目は算出できませんでした（解析タブに内訳があります）";
}

/** 変換元ファイルが持っている、その項目の値（装置が出した答え） */
function fileValue(e, col) {
  if (!col.srcLabels || !e.results) return null;
  for (const lb of col.srcLabels) {
    const r = e.results.find((x) => x.label === lb);
    if (!r) continue;
    const v = parseFloat(String(r.value).replace(/,/g, ""));
    if (isFinite(v)) return { value: v, label: lb, unit: r.unit || "" };
  }
  return null;
}

/**
 * 測定値は**変換元ファイルから出てくる値だけ**を出す。
 * このツールの解析値はレポートには入れない（破断点の決定などはまだ試験段階のため）。
 * 試験片の寸法は試験条件から取るので、これもファイル由来。
 */
function reportValue(e, col) {
  if (col.kind === "spec") {
    const v = col.get(e, e.analysis);
    return { value: fin(v) ? v : null, src: fin(v) ? "cond" : "none", label: null };
  }
  const f = fileValue(e, col);
  return f ? { value: f.value, src: "file", label: f.label } : { value: null, src: "none", label: null };
}

/**
 * 合格範囲。解析が決めた A.judge をそのまま読む（判定バナーと同じ範囲）。
 *   file   … 変換元ファイルの合格範囲レコードから抽出（別紙仕様）
 *   params … ファイルに無いときの控え（応力増加速度だけ・設定 › 判定）
 * どちらも無い項目は空欄にして、合否判定もしない。
 */
function reportRange(e, col) {
  const A = e.analysis;
  /* 解析できなかったファイルでも、ファイルに入っている合格範囲は出す */
  const judge = (A && A.judge) || resolveJudgeRanges(e.passRanges, state.params);
  const jr = col.judge ? judge[col.judge] : null;
  if (!jr) {
    return {
      text: "—", src: "none",
      why: col.judge
        ? "この項目の合格範囲が変換元ファイルから見つかりませんでした"
        : "この項目に合格範囲はありません（変換元ファイルにも試験条件にも入っていません）",
    };
  }
  const where = jr.src === "file"
    ? `変換元ファイルの「${jr.label}」に入っている判定範囲` +
      (jr.fileUnit && Math.abs(jr.lo - jr.fileLo) > 1e-9
        ? `（ファイルでは ${fmtNum(jr.fileLo, 2)}〜${fmtNum(jr.fileHi, 2)} ${jr.fileUnit}。${col.unit} に換算）`
        : "")
    : "設定 › 判定 の控えの値（変換元ファイルに範囲が無いため）";
  return {
    text: `${colFmtR(col, jr.lo)} 〜 ${colFmtR(col, jr.hi)}`, src: jr.src, lo: jr.lo, hi: jr.hi,
    why: `${where}。単票の判定バナーでも同じ値を使います`,
  };
}

/** 合否判定。合格範囲があり、測定値も出ているときだけ出す。 */
function reportJudge(e, col) {
  if (col.kind === "spec") return { level: "na", label: "対象外", why: "試験片の寸法のため判定の対象外です" };
  const r = reportRange(e, col);
  if (r.src === "none") return { level: null, why: "合格範囲が無いため判定していません" };
  const v = reportValue(e, col);
  const res = rangeCheck(fin(v.value) ? v.value : NaN, r.lo, r.hi);
  return {
    level: res.level, label: res.label,
    why: res.level === "na"
      ? `変換元ファイルに「${(col.srcLabels || []).join("」「")}」の値が無いため判定できません`
      : `変換元ファイルの測定値 ${colFmt(col, v.value)} ${col.unit} と`
        + ` 合格範囲 ${colFmt(col, r.lo)}〜${colFmt(col, r.hi)} ${col.unit} の比較（どちらもファイルの値）`,
  };
}

/* ───────────────── ファイル名の読み解き ─────────────────
 * 構造:  年月日_連番_ロットNo._[採取位置]試験方向 . 拡張子
 *   - 区切りは `_`。ロット No. までで 3 個なので、必ず 4 フィールドになる。
 *   - 第 4 フィールドにはハイフンや数字が入り得るが `_` は入らない。
 *
 * 第 4 フィールドの分解（末尾から試験方向を切り出し、残りが採取位置）:
 *   1. 末尾が LT か → 試験方向 = LT      ★必ず LT を L より先に見る
 *   2. そうでなく末尾が L か → 試験方向 = L
 *   3. 残りが採取位置。末尾のハイフンだけ取り除く（BOT- → BOT）。
 *      内側のハイフンは残す（1-10D はそのまま）。残りが空なら採取位置なし。
 *
 * 例: LT → 方向 LT・位置なし ／ L → 方向 L・位置なし
 *     BOT-L → 方向 L・位置 BOT ／ 1-10DL → 方向 L・位置 1-10D
 */
const TEST_DIRECTIONS = ["LT", "L"];     // 長い方から見る（LT を L より先に）
function splitPosDir(field) {
  const raw = String(field || "").trim();
  if (!raw) return { pos: null, dir: null, ok: false };
  for (const d of TEST_DIRECTIONS) {
    if (raw.toUpperCase().endsWith(d)) {
      const rest = raw.slice(0, raw.length - d.length).replace(/-+$/, "");
      return { pos: rest || null, dir: d, ok: true };
    }
  }
  /* L / LT で終わらない＝仕様外。捨てずに採取位置として出し、方向は不明とする。 */
  return { pos: raw.replace(/-+$/, "") || null, dir: null, ok: false };
}
function parseFileTitle(e) {
  const seg = String(e && e.base ? e.base : "").split("_");
  /* 第 4 フィールドに `_` は入らない決まりだが、万一多く割れても捨てずに繋ぎ直す */
  const field4 = seg.length > 3 ? seg.slice(3).join("_") : "";
  const { pos, dir, ok } = splitPosDir(field4);
  return {
    segments: seg,
    date: seg[0] || null,
    seq: seg[1] || null,
    lot: seg[2] || null,
    field4: field4 || null,
    pos, dir,
    dirOk: ok,
    shape: seg.length === 4,          // 想定どおり 4 フィールドに割れたか
  };
}
/** ロット No. はファイル名から。取れなければ試験条件、それも無ければファイル名全体。 */
function reportLot(e) {
  const t = parseFileTitle(e);
  if (t.lot) return t.lot;
  const c = (e && e.cond && (e.cond["ロット/製造番号"] || e.cond["品名"])) || "";
  return String(c).trim() || (e ? e.base : "") || "ロットNo.";
}

/* ───────────────── タイトル ───────────────── */
/** 既定のタイトルはファイル名のロット No. から作る。 */
const defaultReportTitle = (e) => `${reportLot(e)}_引張試験結果`;
const reportTitle = (e) => (e && e.reportTitle) || defaultReportTitle(e);

/** ファイル名をどう読み解いたかを画面に出す（読み違いにすぐ気づけるように） */
function fileTitleParts(e) {
  const t = parseFileTitle(e);
  const item = (label, v) => `<span class="badge${v ? "" : " is-missing"}">${esc(label)} <b>${v ? esc(v) : "（なし）"}</b></span>`;
  const warn = !t.shape
    ? statusChip("warn", `${t.segments.length} 個に割れました（_ は 3 個の想定）`)
    : (!t.dirOk ? statusChip("warn", "末尾が L / LT ではありません") : "");
  return `<div class="reportbar__parts">
    <span class="field__label">ファイル名の読み解き</span>
    ${item("年月日", t.date)}${item("連番", t.seq)}${item("ロットNo.", t.lot)}${item("採取位置", t.pos)}${item("試験方向", t.dir)}
    ${warn}
    <span class="reportbar__hint"><b class="mono">年月日_連番_ロットNo._[採取位置]試験方向</b>
      （試験方向は末尾の <b class="mono">LT</b> / <b class="mono">L</b>。残りが採取位置で、末尾のハイフンだけ落とします）</span>
  </div>`;
}

/* ───────────────── 用紙の見出しに出す試験条件 ───────────────── */
function reportMeta(e) {
  const c = e.cond || {};
  const pick = (k) => (c[k] != null && String(c[k]).trim() !== "" ? String(c[k]) : null);
  const dim = (k) => (pick(k) ? `${pick(k)} mm` : null);
  const A = e.analysis;

  /* 耐力点も変換元ファイルの値。無いときは（なし）とし、参考としてこのツールの解析値を title に添える */
  const yf = fileValue(e, { srcLabels: ["耐力点1_応力", "耐力点1Rp"] });
  const y = A && A.yieldV && fin(A.yieldV.stress) ? A.yieldV : null;
  const yieldText = yf ? `${fmtNum(yf.value, 1)} N/mm²` : null;
  const yieldWhy = yf
    ? `変換元ファイルの「${yf.label}」の値` + (y ? `／このツールの解析値（速度法）は ${fmtNum(y.stress, 1)} N/mm²` : "")
    : `変換元ファイルに耐力点の値がありません` +
      (y ? `／このツールの解析値（速度法・試験段階）は ${fmtNum(y.stress, 1)} N/mm²` : "");

  const t = parseFileTitle(e);
  const fromName = "ファイル名（年月日_連番_ロットNo._[採取位置]試験方向）から読み取り";
  /* 採取位置は「あるときだけ」出す（第 4 フィールドが L / LT だけなら項目ごと出さない） */
  return [
    ["ロットNo.", reportLot(e), t.lot ? fromName : "ファイル名から読み取れないため試験条件／ファイル名で代用"],
    ["試験方向", t.dir, t.dir
      ? `${fromName}／第 4 フィールド「${t.field4}」の末尾`
      : `第 4 フィールド${t.field4 ? `「${t.field4}」` : ""}が L / LT で終わらないため不明`],
    ...(t.pos ? [["採取位置", t.pos, `${fromName}／第 4 フィールド「${t.field4}」から試験方向を除いた残り`]] : []),
    ["試験日", pick("試験日") || pick("作成日")],
    ["試験片形状", pick("試験片形状")],
    ["厚さ × 幅", dim("厚さ") && dim("幅") ? `${dim("厚さ")} × ${dim("幅")}` : dim("直径") ? `φ ${dim("直径")}` : null],
    ["ゲージ長", `${fmtNum(state.params.gaugeLength, 1)} mm`],
    ["耐力点", yieldText, `速度法で求めた耐力点。${yieldWhy}`],
    ["入力ファイル", e.name],
  ];
}

/* ───────────────── 用紙 ───────────────── */
function reportSheetHtml(e) {
  /* table-layout:fixed なので、桁の多い列に幅を寄せておく（w は列ごとの重み） */
  const wSum = REPORT_COLS.reduce((a, c) => a + (c.w || 1), 0);
  const cols = `<colgroup><col style="width:9%">${
    REPORT_COLS.map((c) => `<col style="width:${(91 * (c.w || 1) / wSum).toFixed(2)}%">`).join("")
  }</colgroup>`;
  /* 見出しは「名前」と「元データ名」の 2 行に分ける。1 つのセルに 2 段を詰めると
     行数の違いで文字の高さが揃わず、横並びがガタガタに見えるため。 */
  const names = REPORT_COLS.map((c) => `<th scope="col" class="rp__name">${labelHtml(c.name)}</th>`).join("");
  const subs = REPORT_COLS.map((c) => `<td class="rp__sub">${labelHtml(c.sub)}</td>`).join("");
  const units = REPORT_COLS.map((c) => `<td class="rp__unit">${esc(c.unit)}</td>`).join("");
  const ranges = REPORT_COLS.map((c) => {
    const r = reportRange(e, c);
    return `<td class="rp__range rp__range--${r.src}"><span title="${esc(r.why)}">${esc(r.text)}</span></td>`;
  }).join("");
  const vals = REPORT_COLS.map((c) => {
    const v = reportValue(e, c);
    if (fin(v.value)) {
      const why = v.src === "file"
        ? `変換元ファイルの「${v.label}」の値`
        : "変換元ファイルの試験条件から";
      return `<td class="rp__val"><span title="${esc(why)}">${esc(colFmt(c, v.value))}</span></td>`;
    }
    const na = c.kind === "spec"
      ? { text: "未取得", why: "変換元ファイルの試験条件に寸法がありません" }
      : { text: "取得できず", why: `変換元ファイルに「${(c.srcLabels || []).join("」「")}」の値が見つかりませんでした` };
    return `<td class="rp__val"><span class="rp__na" title="${esc(na.why)}">${na.text}</span></td>`;
  }).join("");
  const judges = REPORT_COLS.map((c) => {
    const j = reportJudge(e, c);
    return `<td class="rp__judge">${j.level
      ? statusChip(j.level === "ng" ? "err" : j.level, j.label)
      : `<span title="${esc(j.why)}">—</span>`}</td>`;
  }).join("");

  const meta = reportMeta(e).map(([k, v, why]) =>
    `<div class="rp__metaitem"${why ? ` title="${esc(why)}"` : ""}><dt>${esc(k)}</dt>
      <dd>${v ? esc(v) : '<span class="rp__none">（なし）</span>'}</dd></div>`).join("");

  const A = e.analysis;
  const canPlot = !!(A && A.series && A.series.stress && A.series.displacement);
  const plot = canPlot
    ? `<div class="rp__chart" id="reportChart" role="img" aria-label="変位（伸び）と応力の全体像グラフ"></div>`
    : `<div class="rp__chart rp__chart--na">${ICON.warn}<div><b>グラフを描けません</b>
        ${esc(A && A.series && !A.series.displacement ? "変位（伸び計）データが無いため、応力-変位の線図を描けません。"
          : (e.analysisBlock || "応力が確定していないため作図できません。"))}</div></div>`;

  return `<div class="sheet" id="reportSheet">
    <header class="sheet__head">
      <h2 class="sheet__title">${esc(reportTitle(e))}</h2>
      <dl class="sheet__meta">${meta}</dl>
    </header>

    <section class="sheet__block">
      <h3 class="sheet__h">試験結果</h3>
      <table class="rp">
        ${cols}
        <thead>
          <tr><th scope="row" class="rp__rowhead">名前</th>${names}</tr>
          <tr class="rp__row--sub"><th scope="row" class="rp__rowhead">元データ名</th>${subs}</tr>
        </thead>
        <tbody>
          <tr><th scope="row" class="rp__rowhead">単位</th>${units}</tr>
          <tr><th scope="row" class="rp__rowhead">合格範囲</th>${ranges}</tr>
          <tr class="rp__row--val"><th scope="row" class="rp__rowhead">測定値</th>${vals}</tr>
          <tr><th scope="row" class="rp__rowhead">合否判定</th>${judges}</tr>
        </tbody>
      </table>
      <p class="sheet__note"><b>測定値も合格範囲も、変換元ファイルから出てくる値をそのまま出しています</b>
        （このツールの解析値はレポートには入れていません。解析値と見比べるときは 単票 › 解析 タブを使ってください）。
        寸法は試験条件から取ります。ファイルに値が無い項目は「取得できず」と書き、判定もしません。
        <b>合格範囲は変換元ファイルに入っている判定範囲</b>をそのまま読み出したもので、
        応力増加速度・歪速度・弾性率（ヤング率）・クロスヘッド変異速度 の 4 項目が対象です
        （単票の判定バナーと同じ範囲）。範囲が見つからない項目は空欄にし、合否判定もしません。
        マウスを重ねると、その欄の出どころや算出できない理由が出ます。</p>
    </section>

    <section class="sheet__block sheet__block--chart">
      <h3 class="sheet__h">応力 － 変位（伸び）　全体像</h3>
      ${plot}
      <p class="sheet__note">全体像のため常に全範囲を表示します（拡大して見るときは「単票 › 線図」タブ、または線図の「最大化」を使います）。${extStallNote(e)}</p>
    </section>
  </div>`;
}

/**
 * 伸び計が試験の途中で止まっている（破断で外す装置など）ときに、グラフが途中で
 * 終わって見える理由を用紙にも書く。データが欠けているわけではない。
 */
function extStallNote(e) {
  if (!e.wave || !e.wave.ok || !e.wave.columns.Extensometer_mm) return "";
  const ext = channelEnds(e.wave).find((c) => c.name === "Extensometer_mm");
  if (!ext || !ext.stalled) return "";
  const A = e.analysis;
  let upTo = "";
  if (A && A.series && A.series.strainStroke) {
    let m = -Infinity;
    for (const v of A.series.strainStroke) if (fin(v) && v > m) m = v;
    if (isFinite(m)) upTo = `ストローク基準では ${fmtNum(m, 1)} % まで続きます。`;
  }
  return ` <b>伸び計は第 ${(ext.last + 1).toLocaleString("ja-JP")} 点`
    + `${fin(ext.lastTime) ? `（${fmtNum(ext.lastTime, 1)} sec）` : ""} で止まっています</b>`
    + `（破断で外す装置ではここで値が動かなくなります）。${upTo}波形データは全 ${e.wave.points.toLocaleString("ja-JP")} 点そろっています。`;
}

/* ───────────────── レポートモードの画面 ───────────────── */
function reportHtml(e) {
  const shell = (body, meta) => `<div class="ws">
    <div class="ws__head">
      <div class="ws__id">
        <div class="ws__name">レポート</div>
        <div class="ws__meta">${meta}</div>
      </div>${viewSeg()}
    </div>
    <div></div><div></div>
    <div class="panel panel--report">${body}</div>
  </div>`;

  /* ファイルが 1 件も無いときはステージ全体が空画面になるので、ここは「未変換／失敗」だけを扱う */
  if (!e || e.status !== "done") {
    return shell(`<div class="reason">${ICON.wait}<div><b>変換が終わったファイルを選んでください</b>
      レポートは変換済みのファイル 1 件について作ります（左の一覧から選べます）。</div></div>`,
      `<span class="badge">変換済 <b>${doneEntries().length}</b> 件</span>`);
  }

  const custom = !!e.reportTitle;
  const zoom = state.reportZoom === "actual" ? "actual" : "fit";
  const bar = `<div class="reportbar">
    <label class="field reportbar__title">
      <span class="field__label">タイトル（任意に変えられます）</span>
      <input class="input" id="rpTitle" type="text" data-act="rp-title" value="${esc(reportTitle(e))}"
        placeholder="${esc(defaultReportTitle(e))}" spellcheck="false">
    </label>
    <button class="chip" data-act="rp-title-reset" ${custom ? "" : `disabled title="いま既定のタイトルです"`}>${ICON.reset}<span>既定に戻す</span></button>
    <span class="reportbar__hint">既定は <b class="mono">ロットNo._引張試験結果</b>（ロット No. はファイル名から取ります）</span>
    <span class="spacer"></span>
    <span class="reportbar__zoom">
      <div class="seg" role="group" aria-label="用紙の表示倍率">
        <button data-act="rp-zoom" data-z="fit" aria-pressed="${zoom === "fit"}">全体表示</button>
        <button data-act="rp-zoom" data-z="actual" aria-pressed="${zoom === "actual"}">原寸</button>
      </div>
      <span class="badge">表示 <b id="rpZoom">—</b></span>
    </span>
    <button class="chip" data-act="rp-print">${ICON.print}<span>印刷 / PDF 保存</span></button>
    ${fileTitleParts(e)}
  </div>`;

  const v = e.analysis && e.analysis.verdict ? e.analysis.verdict : { level: "na", label: "解析なし" };
  const meta = `<span class="badge">対象 <b>${esc(e.name)}</b></span>
    <span class="badge">用紙 <b>A4 縦</b></span>
    ${statusChip(v.level === "ng" ? "err" : v.level, `判定: ${v.label}`)}`;

  return shell(`${bar}<div class="sheet-wrap">${reportSheetHtml(e)}</div>`, meta);
}

/* ───────────────── 用紙の表示倍率（全体表示 / 原寸） ───────────────── */
let reportRO = null;
/** 器に入る倍率を求めて --sheet-scale に入れる。原寸のときは 1 のまま。 */
function fitReportSheet() {
  const wrap = $(".sheet-wrap", elStage);
  const sheet = wrap && $(".sheet", wrap);
  if (!wrap || !sheet) return;
  /* offsetWidth / offsetHeight は transform の影響を受けない（＝用紙の実寸） */
  const sw = sheet.offsetWidth, sh = sheet.offsetHeight;
  const scale = state.reportZoom === "actual" || !sw || !sh
    ? 1
    : Math.max(0.2, Math.min(1, (wrap.clientHeight - 2) / sh, (wrap.clientWidth - 2) / sw));
  wrap.style.setProperty("--sheet-scale", String(scale));
  const badge = $("#rpZoom", elStage);
  if (badge) badge.textContent = `${Math.round(scale * 100)} %`;
}
function watchReportSheet() {
  if (reportRO) { reportRO.disconnect(); reportRO = null; }
  const wrap = $(".sheet-wrap", elStage);
  if (!wrap) return;
  fitReportSheet();
  reportRO = new ResizeObserver(() => fitReportSheet());
  reportRO.observe(wrap);
}

/* ───────────────── 用紙のグラフ（応力 － 変位の全体像） ───────────────── */
function mountReportChart(e) {
  const host = $("#reportChart", elStage);
  if (!host || !e || !e.analysis) return;
  const A = e.analysis;
  const base = seriesFor(A, "displacement", "stress");
  if (!base || !base.xs.length) return;

  const spec = {
    xLabel: AXES.displacement.label, yLabel: AXES.stress.label,
    xUnit: AXES.displacement.unit, yUnit: AXES.stress.unit,
    xShort: AXES.displacement.short, yShort: AXES.stress.short,
    series: [{ ...base, color: cssVar("--chart-line"), width: 1.6, primary: true }],
    markers: [], bands: [],
  };
  /* 全体像なので注釈は最大点だけ。破断点の決め方はまだ試験段階なので用紙には出さない。 */
  const at = (i) => (i != null && A.series.displacement ? A.series.displacement[i] : NaN);
  if (A.rm && fin(at(A.rm.index))) {
    spec.markers.push({ x: at(A.rm.index), y: A.rm.value, shape: "circle", color: cssVar("--chart-line-2"), label: "Rm" });
  }

  const c = new LineChart(host, { interactive: false });   // 用紙の中は常に全体表示（操作しない）
  c.setData(spec);
  charts.push(c);
  chartRefs.report = c;
}

/** レポートモードの描画あと処理（グラフ＋倍率合わせ） */
function mountReport(e) {
  mountReportChart(e);
  watchReportSheet();
}
