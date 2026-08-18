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
 * name    … 表の 1 行目「名前」
 * sub     … 名前の下に小さく添える補足（元ラベル）
 * unit    … 表の 2 行目「単位」。単位を持たない項目は "—"
 * sample  … 表の 3 行目「測定値」の仮の値（次工程で解析結果に差し替える）
 * judge   … 表の 4 行目「合否判定」の仮の判定。null は判定の対象外
 * kind    … measure = 測定値 / spec = 試験片の属性（判定の対象外）
 */
const REPORT_COLS = [
  { key: "force",  kind: "measure", name: "試験力",       sub: "最大点_試験力",       unit: "N",      sample: "12,340",   judge: "ok" },
  { key: "stress", kind: "measure", name: "応力",         sub: "最大点_応力",         unit: "N/mm²",  sample: "412.7",    judge: "ok" },
  { key: "elong",  kind: "measure", name: "伸び",         sub: "破断点_変位(ひずみ)", unit: "%",      sample: "23.45",    judge: "ok" },
  { key: "young",  kind: "measure", name: "弾性率",       sub: "弾性率_Standard",     unit: "N/mm²",  sample: "205,000",  judge: "ok" },
  { key: "ramp",   kind: "measure", name: "応力増加速度", sub: "応力増加速度",        unit: "MPa/s",  sample: "9.82",     judge: "ok" },
  { key: "srate",  kind: "measure", name: "ひずみ速度",   sub: "歪速度",              unit: "s⁻¹",    sample: "1.23×10⁻⁴", judge: "warn" },
  { key: "cross",  kind: "measure", name: "実績クロス変位速度", sub: "実績クロスヘッド変異速度", unit: "mm/min", sample: "3.00", judge: "ok" },
  { key: "spec",   kind: "spec",    name: "試験片名",     sub: "試験条件",            unit: "—",      sample: "SPCC-1",   judge: null },
  { key: "thick",  kind: "spec",    name: "厚さ",         sub: "試験条件",            unit: "mm",     sample: "1.600",    judge: null },
  { key: "width",  kind: "spec",    name: "幅",           sub: "試験条件",            unit: "mm",     sample: "25.00",    judge: null },
];

const JUDGE_TEXT = { ok: "合格", warn: "要確認", ng: "不合格" };

/* ───────────────── タイトル ───────────────── */
/** 既定のタイトル。ロット No. が取れないときはファイル名で代用する。 */
function defaultReportTitle(e) {
  const lot = (e && e.cond && (e.cond["ロット/製造番号"] || e.cond["品名"])) || "";
  return `${String(lot || (e ? e.base : "")).trim() || "ロットNo."}_引張試験結果`;
}
const reportTitle = (e) => (e && e.reportTitle) || defaultReportTitle(e);

/* ───────────────── 用紙の見出しに出す試験条件 ───────────────── */
function reportMeta(e) {
  const c = e.cond || {};
  const pick = (k) => (c[k] != null && String(c[k]).trim() !== "" ? String(c[k]) : null);
  const dim = (k) => (pick(k) ? `${pick(k)} mm` : null);
  return [
    ["ロット/製造番号", pick("ロット/製造番号")],
    ["試験片名", pick("試験片名")],
    ["試験日", pick("試験日") || pick("作成日")],
    ["試験片形状", pick("試験片形状")],
    ["厚さ × 幅", dim("厚さ") && dim("幅") ? `${dim("厚さ")} × ${dim("幅")}` : dim("直径") ? `φ ${dim("直径")}` : null],
    ["ゲージ長", `${fmtNum(state.params.gaugeLength, 1)} mm`],
    ["入力ファイル", e.name],
  ];
}

/* ───────────────── 用紙 ───────────────── */
function reportSheetHtml(e) {
  const head = REPORT_COLS.map((c) =>
    `<th scope="col"><span class="rp__name">${esc(c.name)}</span><span class="rp__sub">${esc(c.sub)}</span></th>`).join("");
  const units = REPORT_COLS.map((c) => `<td class="rp__unit">${esc(c.unit)}</td>`).join("");
  const vals = REPORT_COLS.map((c) =>
    `<td class="rp__val${c.kind === "spec" ? " rp__val--text" : ""}"><span class="rp__sample" title="配置確認用の仮の値">${esc(c.sample)}</span></td>`).join("");
  const judges = REPORT_COLS.map((c) => `<td class="rp__judge">${
    c.judge ? statusChip(c.judge === "ng" ? "err" : c.judge, JUDGE_TEXT[c.judge]) : statusChip("na", "対象外")
  }</td>`).join("");

  const meta = reportMeta(e).map(([k, v]) =>
    `<div class="rp__metaitem"><dt>${esc(k)}</dt><dd>${v ? esc(v) : '<span class="rp__none">（なし）</span>'}</dd></div>`).join("");

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
        <thead><tr><th scope="row" class="rp__rowhead">名前</th>${head}</tr></thead>
        <tbody>
          <tr><th scope="row" class="rp__rowhead">単位</th>${units}</tr>
          <tr class="rp__row--val"><th scope="row" class="rp__rowhead">測定値</th>${vals}</tr>
          <tr><th scope="row" class="rp__rowhead">合否判定</th>${judges}</tr>
        </tbody>
      </table>
      <p class="sheet__note">測定値と合否判定は<b>配置確認用の仮の値</b>です（実データとの結合は次の工程）。
        単位は各列の 2 行目に、判定はアイコン＋文字で示します。</p>
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
  const bar = `<div class="reportbar">
    <label class="field reportbar__title">
      <span class="field__label">タイトル（任意に変えられます）</span>
      <input class="input" id="rpTitle" type="text" data-act="rp-title" value="${esc(reportTitle(e))}"
        placeholder="${esc(defaultReportTitle(e))}" spellcheck="false">
    </label>
    <button class="chip" data-act="rp-title-reset" ${custom ? "" : `disabled title="いま既定のタイトルです"`}>${ICON.reset}<span>既定に戻す</span></button>
    <span class="reportbar__hint">既定は <b class="mono">ロットNo._引張試験結果</b>（ロット No. は変換元の試験条件から取ります）</span>
    <span class="spacer"></span>
    <button class="chip" data-act="rp-print">${ICON.print}<span>印刷 / PDF 保存</span></button>
  </div>`;

  const meta = `<span class="badge">対象 <b>${esc(e.name)}</b></span>
    <span class="badge">用紙 <b>A4 横</b></span>
    ${statusChip("warn", "配置確認中（値は仮）")}`;

  return shell(bar + reportSheetHtml(e), meta);
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
