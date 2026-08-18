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
 * name      … 表の 1 行目「名前」
 * sub       … 名前の下に小さく添える補足（変換元ファイルでのラベル）
 * srcLabels … 変換元ファイルの結果ラベル候補（合格範囲・値の引き当てに使う）
 * unit      … 表の 2 行目「単位」。単位を持たない項目は "—"
 * range     … 表の 3 行目「合格範囲」の仮の値（ファイル／設定から取れないときに使う）
 * sample    … 表の 4 行目「測定値」の仮の値（次工程で解析結果に差し替える）
 * judge     … 表の 5 行目「合否判定」の仮の判定。null は判定の対象外
 * kind      … measure = 測定値 / spec = 試験片の属性（判定の対象外）
 * d         … ファイルから取れた合格範囲を表示するときの小数桁
 * w         … 表の列幅の重み（桁数の多い列を少し広くする）
 * exp       … 合格範囲を指数表記（1.23×10⁻⁴）で出す
 *
 * name / sub の `|` は「ここでなら改行してよい」印（単語の途中では折り返さない）。
 * `_` の直後も改行してよい。どちらの印も表示には出ない。
 */
const REPORT_COLS = [
  { key: "force",  w: 1,    kind: "measure", name: "試験力",           sub: "最大点_試験力",
    srcLabels: ["最大点_試験力", "最大点_Fm"],
    unit: "N",      d: 0, range: "10,000 以上",        sample: "12,340",    judge: "ok" },
  { key: "stress", w: 1,    kind: "measure", name: "引張強さ",         sub: "最大点_応力",
    srcLabels: ["最大点_応力", "最大点_Rm"],
    unit: "N/mm²",  d: 1, range: "270.0 〜 450.0",     sample: "412.7",     judge: "ok" },
  { key: "elong",  w: 0.95, kind: "measure", name: "伸び",             sub: "破断点_変位|(ひずみ)",
    srcLabels: ["破断点_変位(ひずみ)", "破断点_At"],
    unit: "%",      d: 2, range: "20.00 以上",         sample: "23.45",     judge: "ok" },
  { key: "young",  w: 1.15, kind: "measure", name: "弾性率",           sub: "弾性率_Standard",
    srcLabels: ["弾性率_Standard"],
    unit: "N/mm²",  d: 0, range: "180,000 〜 230,000", sample: "205,000",   judge: "ok" },
  { key: "ramp",   w: 1,    kind: "measure", name: "応力|増加速度",     sub: "応力|増加速度",
    srcLabels: ["応力増加速度"],
    unit: "MPa/s",  d: 1, range: "2.0 〜 20.0",        sample: "9.82",      judge: "ok" },
  { key: "srate",  w: 1.3,  kind: "measure", name: "ひずみ速度",       sub: "歪速度",
    srcLabels: ["歪速度"],
    unit: "s⁻¹",    d: 5, exp: true, range: "2.5×10⁻⁴ 以下", sample: "1.23×10⁻⁴", judge: "warn" },
  { key: "cross",  w: 1.1,  kind: "measure", name: "実績クロス|変位速度", sub: "実績|クロスヘッド|変異速度",
    srcLabels: ["実績クロスヘッド変異速度", "クロスヘッド変異速度"],
    unit: "mm/min", d: 2, range: "2.40 〜 3.60",       sample: "3.00",      judge: "ok" },
  { key: "thick",  w: 0.9,  kind: "spec",    name: "厚さ",             sub: "試験条件", srcLabels: [],
    unit: "mm",     d: 3, range: null,                 sample: "1.600",     judge: null },
  { key: "width",  w: 0.9,  kind: "spec",    name: "幅",               sub: "試験条件", srcLabels: [],
    unit: "mm",     d: 2, range: null,                 sample: "25.00",     judge: null },
];

const JUDGE_TEXT = { ok: "合格", warn: "要確認", ng: "不合格" };

/** 単語の途中では折り返さない。`_` の直後と `|` の位置だけ改行を許す（`|` は表示しない）。 */
function labelHtml(s) {
  return esc(s).split("|").map((part) => part.replace(/_/g, "_<wbr>")).join("<wbr>");
}

/**
 * 合格範囲を決める。出どころは 3 通りあり、画面でも見分けられるようにする。
 *   file   … 変換元ファイル（.vtav の値アンカー直後の 下限/上限）★実ファイルでの裏取りは未了
 *   params … このツールの設定（判定 › 応力増加速度の許容範囲）
 *   sample … 配置確認用の仮の値
 */
function reportRange(e, col) {
  if (col.range === null && !col.srcLabels.length) return { text: "—", src: "none" };
  const row = (e.results || []).find((r) => col.srcLabels.includes(r.label) && fin(r.lo) && fin(r.hi));
  if (row) {
    const f = (v) => (col.exp ? fmtExp(v, 2) : fmtNum(v, col.d));
    return { text: `${f(row.lo)} 〜 ${f(row.hi)}`, src: "file" };
  }
  if (col.key === "ramp") {
    const P = state.params;
    return P.rampCheck
      ? { text: `${fmtNum(P.rampMin, 1)} 〜 ${fmtNum(P.rampMax, 1)}`, src: "params" }
      : { text: "判定しない", src: "params" };
  }
  return { text: col.range, src: "sample" };
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

  /* 耐力点（速度法）だけは解析の実値。取れないときは理由を title で追えるようにする */
  const y = A && A.yieldV && fin(A.yieldV.stress) ? A.yieldV : null;
  const yieldWhy = y ? y.basis
    : (A && (A.blocked.find((b) => b.what === "耐力（速度法）") || {}).why) || "解析していないため算出していません";
  const yieldText = y
    ? `${fmtNum(y.stress, 1)} N/mm²${fin(y.strain) ? `（ε ${fmtNum(y.strain, 3)} %）` : ""}`
    : null;

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
  const head = REPORT_COLS.map((c) =>
    `<th scope="col"><span class="rp__name">${labelHtml(c.name)}</span><span class="rp__sub">${labelHtml(c.sub)}</span></th>`).join("");
  const units = REPORT_COLS.map((c) => `<td class="rp__unit">${esc(c.unit)}</td>`).join("");
  const ranges = REPORT_COLS.map((c) => {
    const r = reportRange(e, c);
    const title = { file: "変換元ファイルから取得（未検証）", params: "設定 › 判定 の許容範囲", sample: "配置確認用の仮の値", none: "判定の対象外" }[r.src];
    return `<td class="rp__range rp__range--${r.src}">${
      r.src === "sample" ? `<span class="rp__sample" title="${esc(title)}">${esc(r.text)}</span>`
                         : `<span title="${esc(title)}">${esc(r.text)}</span>`}</td>`;
  }).join("");
  const vals = REPORT_COLS.map((c) =>
    `<td class="rp__val${c.kind === "spec" ? " rp__val--text" : ""}"><span class="rp__sample" title="配置確認用の仮の値">${esc(c.sample)}</span></td>`).join("");
  const judges = REPORT_COLS.map((c) => `<td class="rp__judge">${
    c.judge ? statusChip(c.judge === "ng" ? "err" : c.judge, JUDGE_TEXT[c.judge]) : statusChip("na", "対象外")
  }</td>`).join("");

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
        <thead><tr><th scope="row" class="rp__rowhead">名前</th>${head}</tr></thead>
        <tbody>
          <tr><th scope="row" class="rp__rowhead">単位</th>${units}</tr>
          <tr><th scope="row" class="rp__rowhead">合格範囲</th>${ranges}</tr>
          <tr class="rp__row--val"><th scope="row" class="rp__rowhead">測定値<small>（仮）</small></th>${vals}</tr>
          <tr><th scope="row" class="rp__rowhead">合否判定<small>（仮）</small></th>${judges}</tr>
        </tbody>
      </table>
      <p class="sheet__note"><b>「（仮）」の行と破線の下線が付いた値は配置確認用の仮の値</b>です（実データとの結合は次の工程。
        合否判定はまだ何とも比べていません）。
        合格範囲は ①変換元ファイル（.vtav の下限・上限／未検証）→ ②このツールの設定（応力増加速度）→ ③仮の値 の順に決めます。
        マウスを重ねるとその値の出どころが出ます。</p>
    </section>

    <section class="sheet__block sheet__block--chart">
      <h3 class="sheet__h">応力 － 変位（伸び）　全体像</h3>
      ${plot}
      <p class="sheet__note">全体像のため常に全範囲を表示します（拡大して見るときは「単票 › 線図」タブ、または線図の「最大化」を使います）。</p>
    </section>
  </div>`;
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

  const meta = `<span class="badge">対象 <b>${esc(e.name)}</b></span>
    <span class="badge">用紙 <b>A4 縦</b></span>
    ${statusChip("warn", "配置確認中（値は仮）")}`;

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
  /* 全体像なので注釈は破断点と最大点だけに絞る */
  const fr = A.fractureA || A.fractureB;
  const at = (i) => (i != null && A.series.displacement ? A.series.displacement[i] : NaN);
  if (fr && fin(at(fr.index)) && fin(fr.stress)) {
    spec.markers.push({ x: at(fr.index), y: fr.stress, shape: "x", color: cssVar("--chart-fracture"), label: "破断" });
  }
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
