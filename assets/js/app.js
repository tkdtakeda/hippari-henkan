/* ============================================================================
 * app.js — アプリケーション（状態・描画・イベント）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ============================================================================
 * アプリケーション状態
 * ==========================================================================*/
const LS_KEY = "trapezium-html-tool/params/v1";
const state = {
  entries: [],
  selectedId: null,
  view: "single",              // 'single' | 'report'（レポートモード）| 'summary'
  tab: "charts",               // 単票のタブ。ドロップ直後は線図を開く
  chartMax: null,              // null | 'main' | 'sub'（線図の最大化ウィンドウ）
  busy: false,
  progress: null,
  params: { ...DEFAULT_PARAMS },
  sort: { key: "name", dir: 1 },
  reportZoom: "fit",           // レポートの用紙: 'fit'（器に合わせる）| 'actual'（原寸）
  chart: {
    x: "strain", y: "stress", markers: true, fit: true,
    side: false,           // 時間-応力線図を並べて表示するか
    ovCollapsed: false,    // 全体図（ミニマップ）をたたむか
    view: null,            // 主図の表示範囲（null = 全体表示）
    viewSub: null,         // 副図の表示範囲
  },
  filter: "",
  undo: null,
};
let seq = 0;
const charts = [];                 // 破棄・再描画のための一覧
const chartRefs = { main: null, ov: null, sub: null, report: null };

function loadParams() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(state.params, JSON.parse(raw));
  } catch (_) { /* file:// で localStorage が使えない環境もある。既定値で続行する。 */ }
}
function saveParams() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.params)); } catch (_) {}
}

const selected = () => state.entries.find((e) => e.id === state.selectedId) || null;
const doneEntries = () => state.entries.filter((e) => e.status === "done");
const queuedEntries = () => state.entries.filter((e) => e.status === "queued");
const allOutputs = () => doneEntries().reduce((a, e) => a + e.outputs.length, 0);
const outputBytes = () => doneEntries().reduce((a, e) => a + e.outputs.reduce((s, o) => s + o.bytes.length, 0), 0);

/* ───────────────── 入力の受け取り ───────────────── */
function addFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  for (const f of files) {
    const base = f.name.replace(/\.[^.]*$/, "");
    const ext = (f.name.match(/\.[^.]*$/) || [""])[0].toLowerCase();
    state.entries.push({
      id: ++seq, file: f, name: f.name, base, ext, size: f.size,
      kind: ext === ".csv" ? "csv" : "dat",
      status: "queued", error: null, outputs: [], analysis: null, reportTitle: null,
      areaOverride: { mode: "auto", t: null, w: null, d: null, A: null },
    });
  }
  if (!state.selectedId) state.selectedId = state.entries[0].id;
  renderAll();
  /* 読み込んだデータは変換する以外に使い道が無いので、確認を挟まず変換〜作図まで進める。
     変換中に追加された分も runConversion() の中で拾う。 */
  runConversion();
}

/* ───────────────── 変換パイプライン（§2） ───────────────── */
async function processEntry(entry) {
  entry.status = "running";
  renderRail(); renderCta();
  await sleep(0);                                     // 画面に「変換中」を出してから重い処理へ
  try {
    const buf = await entry.file.arrayBuffer();
    const data = new Uint8Array(buf);
    entry.crc = crc32(data);
    entry.size = data.length;

    if (entry.kind === "csv") {
      const { text, enc } = decodeTextAuto(data);
      const parsed = parseInputCsv(text);
      if (!parsed.ok) throw new Error(parsed.reason);
      entry.csv = { enc, ...parsed, map: { ...parsed.map } };
      entry.fmt = "csv";
      entry.fmtBasis = `CSV 入力（文字コード: ${enc}）`;
      entry.results = []; entry.report = []; entry.cond = {}; entry.audit = [];
      entry.wave = null; entry.tokenCount = 0;
      entry.passRanges = {};              // CSV 入力には合格範囲が入っていない
    } else {
      const det = detectFormat(data, entry.name);
      entry.fmt = det.fmt;
      entry.fmtBasis = det.basis;

      const tokens = det.fmt === "vtav" ? walkVtavStrings(data) : walkXtuxStrings(data);
      entry.tokenCount = tokens.length;

      if (det.fmt === "vtav") {
        entry.results = parseResultsVtav(data, tokens);
        entry.conf = "high(byte-anchor)";
      } else {
        entry.results = parseResultsXtux(tokens);
        entry.conf = "high(order)";
      }
      entry.report = buildReport(entry.results);

      const cond = extractConditions(tokens);
      entry.condFilled = [];
      if (det.fmt === "xtux") {
        // §5.4.2 xtux の寸法は UTF-8 TLV 側にあるため、同じ data を UTF-8 ウォーカーで再走査して補完
        entry.condFilled = supplementXtuxDims(cond, walkVtavStrings(data));
      }
      entry.cond = cond;

      /* 合否判定の合格範囲は生バイトから拾う（別紙仕様・xtux / vtav 共通） */
      entry.passRanges = extractPassRanges(data);
      entry.wave = extractWaveform(data);
      entry.audit = det.fmt === "vtav" ? parseAudit(tokens) : [];
      entry._waveCsv = null;
    }
    runAnalysis(entry);
    buildOutputs(entry);
    entry.status = "done";
  } catch (err) {
    entry.status = "error";
    entry.error = (err && err.message) ? err.message : String(err);
  }
}

async function runConversion() {
  if (state.busy || !queuedEntries().length) return;
  state.busy = true;
  const first = queuedEntries()[0];        // 今回投入した先頭。終わったらこれを開く
  let done = 0;
  for (;;) {
    const q = queuedEntries();                       // 変換中に追加されたファイルもここで拾う
    if (!q.length) break;
    const e = q[0];
    state.progress = { done, total: done + q.length, name: e.name };
    renderCta();
    await processEntry(e);
    done++;
    if (!state.selectedId || !state.entries.some((x) => x.id === state.selectedId)) state.selectedId = e.id;
  }
  state.progress = null;
  state.busy = false;
  /* 「いま入れたもの」を見せる。失敗していたら、変換できた最初のものへ落とす。 */
  if (first && first.status === "done") state.selectedId = first.id;
  else if (!selected() || selected().status !== "done") {
    const firstDone = doneEntries()[0];
    if (firstDone) state.selectedId = firstDone.id;
  }
  openChartsForSelected();
  renderAll();
}

/** 変換が終わったら線図を開く（ドロップ → 変換 → 作図 まで一息で進める） */
function openChartsForSelected() {
  const e = selected();
  if (!e || e.status !== "done") return;
  /* 一覧のままでは線図が見えないので単票へ。レポートモードのときは
     そちらにも全体像グラフがあるので、そのまま留まる。 */
  if (state.view === "summary") state.view = "single";
  const { a } = tabAvailability(e);
  state.tab = a.charts ? "charts" : (a.report ? "report" : "analysis");
  state.chart.view = null;
  state.chart.viewSub = null;
}

/* ───────────────── 断面積の決定（§11.2） ───────────────── */
const condNum = (cond, key) => {
  const v = cond ? cond[key] : null;
  const f = v == null ? NaN : parseFloat(v);
  return isFinite(f) ? f : NaN;
};
function resolveArea(entry) {
  const o = entry.areaOverride || {};
  if (o.mode === "direct" && fin(o.A) && o.A > 0) return { area: o.A, basis: "断面積 A を直接入力" };
  if (o.mode === "plate" && fin(o.t) && fin(o.w) && o.t > 0 && o.w > 0) {
    return { area: o.t * o.w, basis: `手入力の平板寸法 A = 厚さ ${fmtNum(o.t, 3)} mm × 幅 ${fmtNum(o.w, 3)} mm` };
  }
  if (o.mode === "round" && fin(o.d) && o.d > 0) {
    return { area: (Math.PI / 4) * o.d * o.d, basis: `手入力の丸棒寸法 A = π/4 × (直径 ${fmtNum(o.d, 3)} mm)²` };
  }
  const t = condNum(entry.cond, "厚さ"), w = condNum(entry.cond, "幅"), d = condNum(entry.cond, "直径");
  if (fin(t) && fin(w) && t > 0 && w > 0) {
    return { area: t * w, basis: `試験条件（平板）A = 厚さ ${fmtNum(t, 3)} mm × 幅 ${fmtNum(w, 3)} mm` };
  }
  if (fin(d) && d > 0) {
    return { area: (Math.PI / 4) * d * d, basis: `試験条件（丸棒）A = π/4 × (直径 ${fmtNum(d, 3)} mm)²` };
  }
  return { area: null, basis: "" };
}

/* ───────────────── 解析の実行 ───────────────── */
function runAnalysis(entry) {
  entry.analysis = null;
  entry.analysisBlock = null;
  const P = state.params;

  if (entry.kind === "csv") {
    if (!entry.csv || !entry.csv.ok) { entry.analysisBlock = "CSV を読み取れませんでした"; return; }
    const cols = csvColumns(entry.csv, entry.csv.map);
    if (!cols.force) { entry.analysisBlock = "試験力の列が割り当てられていません"; return; }
    const area = resolveArea(entry);
    entry.area = cols.stress ? null : area.area;
    entry.areaBasis = area.basis;
    entry.analysis = analyze({
      time: cols.time, force: cols.force, stress: cols.stress,
      displacement: cols.displacement, stroke: cols.stroke,
      area: area.area, areaBasis: area.basis,
      stressSource: cols.stress ? "CSV の応力列をそのまま使用（換算なし・§11.2 A）" : null,
      ranges: entry.passRanges || null,
    }, P);
    return;
  }

  const w = entry.wave;
  if (!w || !w.ok) {
    entry.analysisBlock = `波形データが無いため解析できません（${w ? w.reason : "波形未抽出"}）`;
    return;
  }
  const c = w.columns;
  if (!c.Force_N) { entry.analysisBlock = "波形に試験力（Force_N）列が無いため解析できません"; return; }
  const area = resolveArea(entry);
  entry.area = area.area;
  entry.areaBasis = area.basis;
  entry.analysis = analyze({
    time: c.Time_sec || null, force: c.Force_N, stress: null,
    displacement: c.Extensometer_mm || null, stroke: c.Stroke_mm || null,
    area: area.area, areaBasis: area.basis,
    stressSource: null,                       // DAT は全点 SS 応力を force ÷ A で復元（§11.2 B）
    ranges: entry.passRanges || null,
  }, P);
}
function reanalyzeAll() {
  for (const e of state.entries) {
    if (e.status !== "done") continue;
    runAnalysis(e);
    buildOutputs(e);
  }
}

/* ───────────────── 出力 CSV の生成（§6 / §16） ───────────────── */
function buildOutputs(entry) {
  const outs = [];
  const push = (name, kind, text, rows) => outs.push({ name, kind, bytes: csvBytes(text), rows });

  if (entry.kind === "dat") {
    push(`${entry.base}_report.csv`, "report", toCsv([
      ["item", "value", "unit", "source_label"],
      ...entry.report.map((r) => [r.item, r.value, r.unit, r.source_label]),
    ]), entry.report.length);

    push(`${entry.base}_results.csv`, "results", toCsv([
      ["label", "value", "unit", "param", "confidence"],
      ...entry.results.map((r) => [r.label, r.value, r.unit, r.param || "", entry.conf]),
    ]), entry.results.length);

    const condRows = Object.entries(entry.cond);
    push(`${entry.base}_conditions.csv`, "conditions", toCsv([["key", "value"], ...condRows]), condRows.length);

    if (entry.wave && entry.wave.ok) {
      if (!entry._waveCsv) {
        const names = Object.keys(entry.wave.columns);
        const rows = [["#", ...names]];
        const cols = names.map((n) => entry.wave.columns[n]);
        for (let i = 0; i < entry.wave.points; i++) {
          rows.push([i, ...cols.map((c) => pyFloat(c[i]))]);
        }
        entry._waveCsv = toCsv(rows);
      }
      push(`${entry.base}_waveform.csv`, "waveform", entry._waveCsv, entry.wave.points);
    }
    if (entry.fmt === "vtav" && state.params.auditOut && entry.audit && entry.audit.length) {
      push(`${entry.base}_audit.csv`, "audit", toCsv([
        ["item", "change", "datetime", "user"],
        ...entry.audit.map((r) => [r.item, r.change, r.datetime, r.user]),
      ]), entry.audit.length);
    }
  }

  if (entry.analysis && entry.analysis.ok) {
    const rows = analysisRows(entry.analysis);
    push(`${entry.base}_analysis.csv`, "analysis", toCsv([
      ["item", "value", "unit", "basis"],
      ...rows.map((r) => [r.item, r.value, r.unit, r.basis]),
    ]), rows.length);
  }
  entry.outputs = outs;
}

/* 一覧（§16.2） */
const SUMMARY_COLS = [
  { key: "date",   label: "試験日",            unit: "",       num: false },
  { key: "name",   label: "ファイル名",         unit: "",       num: false },
  { key: "yieldV", label: "耐力(速度法)",       unit: "N/mm²",  num: true, d: 1 },
  { key: "rp02",   label: "0.2%耐力",          unit: "N/mm²",  num: true, d: 1 },
  { key: "rm",     label: "引張強さ",           unit: "N/mm²",  num: true, d: 1 },
  { key: "elong",  label: "破断伸び",           unit: "%",      num: true, d: 2 },
  { key: "elongS", label: "島津伸び",           unit: "%",      num: true, d: 2 },
  { key: "young",  label: "ヤング率",           unit: "N/mm²",  num: true, d: 0 },
  { key: "ramp",   label: "応力増加速度",       unit: "MPa/s",  num: true, d: 2 },
  { key: "sr1",    label: "ひずみ速度①",        unit: "s⁻¹",    num: true, exp: true },
  { key: "sr2",    label: "ひずみ速度②",        unit: "s⁻¹",    num: true, exp: true },
  { key: "verdict",label: "判定",               unit: "",       num: false },
];
function summaryRow(e) {
  const A = e.analysis;
  return {
    id: e.id,
    date: (e.cond && (e.cond["試験日"] || e.cond["作成日"])) || "",
    name: e.name,
    yieldV: A && A.yieldV ? A.yieldV.stress : NaN,
    rp02: A && A.offset02 ? A.offset02.stress : NaN,
    rm: A && A.rm ? A.rm.value : NaN,
    elong: A && A.elongation ? A.elongation.value : NaN,
    elongS: A && A.fractureB ? A.fractureB.strain : NaN,
    young: A && A.youngs ? A.youngs.nmm2 : NaN,
    ramp: A && A.rampRate ? A.rampRate.value : NaN,
    sr1: A && A.strainRate1 ? A.strainRate1.value : NaN,
    sr2: A && A.strainRate2 ? A.strainRate2.value : NaN,
    verdict: A && A.verdict ? A.verdict.label : (e.status === "error" ? "変換失敗" : "解析なし"),
    level: A && A.verdict ? A.verdict.level : "na",
  };
}
function summaryRows() { return doneEntries().map(summaryRow); }
function summaryCsvText() {
  const head = SUMMARY_COLS.map((c) => c.unit ? `${c.label}[${c.unit}]` : c.label);
  const body = summaryRows().map((r) => SUMMARY_COLS.map((c) => {
    const v = r[c.key];
    if (!c.num) return v;
    if (!fin(v)) return "";
    return c.exp ? v.toExponential(3) : v.toFixed(c.d);
  }));
  return toCsv([head, ...body]);
}

/* ───────────────── ダウンロード（§7） ───────────────── */
function downloadOutput(entry, name) {
  const o = entry.outputs.find((x) => x.name === name);
  if (!o) return;
  downloadBytes(o.bytes, name, "text/csv");
}
function downloadZip() {
  const list = doneEntries();
  if (!list.length) return;
  const files = [];
  const used = new Map();
  for (const e of list) {
    let folder = e.base;
    const c = (used.get(folder) || 0) + 1;
    used.set(folder, c);
    if (c > 1) folder = `${folder}(${c})`;            // 同名ファイル対策
    for (const o of e.outputs) files.push({ path: `${folder}/${o.name}`, data: o.bytes });
  }
  if (summaryRows().length) files.push({ path: "summary.csv", data: csvBytes(summaryCsvText()) });
  const zip = zipStore(files);
  downloadBytes(zip, `trapezium_csv_${nowStamp()}.zip`, "application/zip");
  toast(`${files.length} ファイルを ZIP にまとめました`);
}
/* ============================================================================
 * 描画
 * ==========================================================================*/
const elStage = $("#stage");
const elLayout = $("#layout");
const elRail = $("#fileList");
const elRailFoot = $("#railFoot");
const elCta = $("#cta");
const elCtaNote = $("#ctaNote");

function renderAll() { renderCta(); renderRail(); renderStage(); }

/**
 * 入力イベントの最中に innerHTML を差し替えると、フォーカス中の要素が
 * 取り除かれて DOM 例外になることがある。描画は必ず次フレームへまとめる。
 */
let _renderReq = 0, _renderScheduled = false;
function scheduleRender(all) {
  _renderReq = Math.max(_renderReq, all ? 2 : 1);
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => {
    _renderScheduled = false;
    const req = _renderReq;
    _renderReq = 0;
    if (req === 2) renderAll(); else renderStage();
  });
}

/* ---- 主要動作（CTA）: 常に 1 つ・位置固定・ラベルだけが状態で変わる ---- */
function ctaState() {
  const q = queuedEntries();
  const d = doneEntries();
  if (state.busy) {
    const p = state.progress || { done: 0, total: 0, name: "" };
    return { label: `変換中… ${Math.min(p.done + 1, p.total)} / ${p.total} 件`, note: `現在: ${p.name}`, disabled: true, act: "" };
  }
  if (q.length) {
    /* 通常は addFiles() から自動で流れるので、ここに来るのは自動変換が止まったとき（再開用） */
    const bytes = q.reduce((a, e) => a + e.size, 0);
    const csvN = q.filter((e) => e.kind === "csv").length;
    return {
      label: `${q.length} 件を変換する`,
      note: `自動変換が完了していません。合計 ${fmtBytes(bytes)}${csvN ? `／うち CSV ${csvN} 件は解析のみ` : ""}`,
      disabled: false, act: "convert",
    };
  }
  if (d.length) {
    const hasSummary = summaryRows().length > 0;
    const files = allOutputs() + (hasSummary ? 1 : 0);
    return {
      label: `${files} ファイルを ZIP でダウンロード`,
      note: `${d.length} 件分・CSV ${allOutputs()} 件${hasSummary ? " ＋ summary.csv" : ""}・${fmtBytes(outputBytes())}・UTF-8 BOM 付き`,
      disabled: false, act: "zip",
    };
  }
  if (state.entries.length) {
    return { label: "ZIP でダウンロード", note: "変換に成功したファイルが 1 件もありません（各ファイルのエラー内容を確認してください）", disabled: true, act: "" };
  }
  return { label: "ZIP でダウンロード", note: "ファイルをドロップすると、確認なしで変換して線図まで表示します", disabled: true, act: "" };
}
function renderCta() {
  const s = ctaState();
  elCta.textContent = s.label;
  elCta.disabled = s.disabled;
  elCta.dataset.act = s.act;
  elCta.setAttribute("aria-busy", state.busy ? "true" : "false");
  elCtaNote.textContent = s.note;
  $("#miClearAll").disabled = state.entries.length === 0 || state.busy;
  $("#miClearResults").disabled = doneEntries().length === 0 || state.busy;
}

/* ---- 左レール ---- */
function entryStatusChip(e) {
  if (e.status === "queued") return statusChip("na", "未変換");
  if (e.status === "running") return statusChip("busy", "変換中");
  if (e.status === "error") return statusChip("err", "失敗");
  const v = e.analysis && e.analysis.verdict;
  if (!v || v.level === "na") return statusChip("warn", "変換済・解析なし");
  if (v.level === "ok") return statusChip("ok", "変換済・合格");
  if (v.level === "warn") return statusChip("warn", "変換済・要確認");
  return statusChip("err", "変換済・不合格");
}
function renderRail() {
  elLayout.dataset.empty = state.entries.length ? "false" : "true";
  elRail.innerHTML = state.entries.map((e) => {
    const meta = e.status === "done"
      ? `${e.fmt.toUpperCase()}・${fmtBytes(e.size)}・結果 ${e.kind === "csv" ? `${e.csv ? e.csv.rows.length : 0} 行` : `${e.results.length} 件`}`
      : `${e.kind === "csv" ? "CSV" : e.ext.replace(".", "").toUpperCase() || "?"}・${fmtBytes(e.size)}`;
    return `<button class="fileitem" role="option" data-id="${e.id}" aria-selected="${e.id === state.selectedId}">
      <span class="fileitem__name truncate">${esc(e.name)}</span>
      <span class="fileitem__meta">${esc(meta)}</span>
      <span class="fileitem__st">${entryStatusChip(e)}</span>
    </button>`;
  }).join("");
  const outs = allOutputs();
  elRailFoot.textContent = state.entries.length
    ? `合計 ${state.entries.length} 件・変換済 ${doneEntries().length} 件・出力 ${outs} ファイル（${fmtBytes(outputBytes())}）`
    : "";
}

/* ---- ステージ ---- */
function renderStage() {
  const act = document.activeElement;
  const keepId = act && act.id && elStage.contains(act) ? act.id : null;
  const keepSel = keepId && "selectionStart" in act ? [act.selectionStart, act.selectionEnd] : null;

  for (const c of charts.splice(0)) c.destroy();
  chartRefs.main = chartRefs.ov = chartRefs.sub = chartRefs.report = null;

  if (!state.entries.length) {
    elStage.innerHTML = emptyHtml();
    renderChartMax();
    return;
  }
  elStage.innerHTML = state.view === "summary" ? summaryHtml()
    : state.view === "report" ? reportHtml(selected())
    : singleHtml(selected());
  /* 最大化中は本体側に線図を作らない（同じ id が 2 つできるのを避ける） */
  if (state.view === "single" && state.tab === "charts" && !state.chartMax) mountCharts(selected());
  if (state.view === "report") mountReport(selected());
  renderChartMax();

  if (keepId) {
    const el = document.getElementById(keepId);
    if (el) { el.focus(); if (keepSel && "setSelectionRange" in el) try { el.setSelectionRange(keepSel[0], keepSel[1]); } catch (_) {} }
  }
}

function emptyHtml() {
  return `<div class="empty">
    <div class="dropzone dropzone--hero" id="dzHero" tabindex="0" role="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
      <span class="dropzone__title">試験ファイルをここにドロップ</span>
      <span>ドロップした時点で変換を始め、線図まで表示します（確認は出ません）　／　複数ファイル同時可</span>
      <span class="mono">.xtux　.vtav　（変換＋解析）　.csv　（解析のみ）</span>
    </div>
    <div class="empty__points">
      <div class="empty__point"><b>ドロップしたら作図まで自動</b>変換の確認は出しません。終わった時点で線図タブを開きます。</div>
      <div class="empty__point"><b>通信は一切しません</b>読み込み・変換・作図はすべてこのブラウザ内で完結します。</div>
      <div class="empty__point"><b>出力は UTF-8 BOM 付き CSV</b>report / results / conditions / waveform（＋audit・analysis）。ファイル単位の個別ダウンロードと ZIP 一括のどちらも使えます。</div>
      <div class="empty__point"><b>線図・レポートまで</b>SS 曲線／時間-応力線図（最大化あり）と、A4 横 1 枚のレポートを作れます。</div>
    </div>
  </div>`;
}

/* ---- 表示モードの切替（単票 / レポート / 一覧）: 位置は固定して押し先だけ変える ---- */
function viewSeg() {
  return `<div class="seg" role="group" aria-label="表示切替">
    <button data-view="single" aria-pressed="${state.view === "single"}">単票</button>
    <button data-view="report" aria-pressed="${state.view === "report"}">レポート</button>
    <button data-view="summary" aria-pressed="${state.view === "summary"}">一覧 ${doneEntries().length} 件</button>
  </div>`;
}

/* ---- 単票 ---- */
/* 内側だけをスクロールさせるタブ（ページ自体はスクロールさせない方針） */
const FIXED_TABS = new Set(["charts", "results", "waveform", "audit"]);
const TABS = [
  { key: "report",  label: "レポート項目" },
  { key: "charts",  label: "線図" },
  { key: "analysis", label: "解析" },
  { key: "results", label: "結果全項目" },
  { key: "waveform", label: "波形" },
  { key: "audit",   label: "変更履歴" },
];
function tabAvailability(e) {
  const a = {};
  const reasons = [];
  if (e.kind === "csv") {
    a.report = false; a.results = false; a.waveform = false; a.audit = false;
    reasons.push("CSV 入力のため レポート／結果全項目／波形／変更履歴はありません（変換部の対象は .xtux / .vtav です）");
  } else {
    a.report = true;
    a.results = e.results.length > 0;
    if (!a.results) reasons.push("結果サマリーを 1 件も抽出できませんでした");
    a.waveform = !!(e.wave && e.wave.ok);
    if (!a.waveform) reasons.push(`波形なし: ${e.wave ? e.wave.reason : "未抽出"}`);
    a.audit = e.fmt === "vtav" && e.audit.length > 0;
    if (!a.audit) reasons.push(e.fmt === "vtav" ? "変更履歴の行が見つかりませんでした" : "変更履歴は .vtav のみが対象です");
  }
  a.charts = !!(e.analysis && e.analysis.series && e.analysis.series.stress);
  a.analysis = true;
  if (!a.charts) reasons.push(`線図なし: ${e.analysisBlock || "応力が確定していないため作図できません"}`);
  return { a, reasons };
}
function tabCount(e, key) {
  switch (key) {
    case "results": return e.results ? e.results.length : 0;
    case "waveform": return e.wave && e.wave.ok ? e.wave.points : 0;
    case "audit": return e.audit ? e.audit.length : 0;
    default: return null;
  }
}
function singleHtml(e) {
  if (!e) return `<div class="empty"><p class="muted">左の一覧からファイルを選択してください。</p></div>`;
  const badges = [];
  badges.push(`<span class="badge badge--fmt">${esc((e.fmt || e.ext.replace(".", "") || "?").toUpperCase())}</span>`);
  badges.push(`<span class="badge">サイズ <b>${fmtBytes(e.size)}</b></span>`);
  if (e.status === "done") {
    if (e.kind === "dat") {
      badges.push(`<span class="badge">検出結果 <b>${e.results.length}</b> 件</span>`);
      badges.push(`<span class="badge">波形 <b>${e.wave && e.wave.ok ? e.wave.points.toLocaleString("ja-JP") : 0}</b> 点</span>`);
      badges.push(`<span class="badge">文字列 <b>${e.tokenCount.toLocaleString("ja-JP")}</b> トークン</span>`);
    } else {
      badges.push(`<span class="badge">データ <b>${e.csv.rows.length.toLocaleString("ja-JP")}</b> 行</span>`);
      badges.push(`<span class="badge">文字コード <b>${esc(e.csv.enc)}</b></span>`);
    }
    badges.push(`<span class="badge">CRC-32 <b class="mono">${hex8(e.crc)}</b></span>`);
  }

  const seg = viewSeg();

  if (e.status !== "done") {
    const body = e.status === "error"
      ? `<div class="reason reason--err">${ICON.err}<div><b>変換できませんでした</b>${esc(e.error || "")}</div></div>`
      : e.status === "running"
        ? `<div class="reason">${ICON.busy}<div><b>変換中です</b>解析が終わるとここに結果が表示されます。</div></div>`
        : `<div class="reason">${ICON.wait}<div><b>まだ変換していません</b>右上の主要ボタン「${esc(ctaState().label)}」を押すと、このファイルを含めてまとめて変換します。</div></div>`;
    return `<div class="ws">
      <div class="ws__head"><div class="ws__id"><div class="ws__name truncate">${esc(e.name)}</div>
        <div class="ws__meta">${badges.join("")}</div></div>${seg}</div>
      <div></div><div></div>
      <div class="panel">${body}</div>
    </div>`;
  }

  const { a, reasons } = tabAvailability(e);
  if (!a[state.tab]) state.tab = "report" in a && a.report ? "report" : "analysis";

  const tabsHtml = TABS.map((t) => {
    const c = tabCount(e, t.key);
    const label = c == null ? t.label : `${t.label} <span class="count">${c.toLocaleString("ja-JP")}</span>`;
    return `<button class="tab" id="tab_${t.key}" role="tab" data-tab="${t.key}" tabindex="${state.tab === t.key ? 0 : -1}"
      aria-selected="${state.tab === t.key}" ${a[t.key] ? "" : "disabled"}>${label}</button>`;
  }).join("");

  const v = e.analysis && e.analysis.verdict ? e.analysis.verdict : { level: "na", label: "解析なし", checks: [] };
  const why = v.level === "na"
    ? esc(e.analysisBlock || "解析に必要なデータが揃っていません")
    : esc(v.checks.map((c) => `${c.label}: ${c.detail}`).join("　／　"));
  const vIcon = { ok: ICON.ok, warn: ICON.warn, ng: ICON.err, na: ICON.na }[v.level];

  return `<div class="ws">
    <div class="ws__head">
      <div class="ws__id">
        <div class="ws__name truncate" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="ws__meta">${badges.join("")}</div>
      </div>${seg}
    </div>
    <div class="verdict verdict--${v.level}">
      <span class="verdict__icon">${vIcon}</span>
      <span class="verdict__label">判定: ${esc(v.label)}</span>
      <span class="verdict__why truncate" title="${why}">${why}</span>
    </div>
    <div>
      <div class="tabs" role="tablist">${tabsHtml}</div>
      ${reasons.length ? `<p class="tabs__note">使えないタブの理由: ${esc(reasons.join("／"))}</p>` : ""}
    </div>
    <div class="panel${FIXED_TABS.has(state.tab) ? " panel--fixed" : ""}">${panelHtml(e)}</div>
  </div>`;
}

/* ---- パネル ---- */
function panelHtml(e) {
  switch (state.tab) {
    case "report": return reportPanel(e);
    case "charts": return chartsPanel(e);
    case "analysis": return analysisPanel(e);
    case "results": return resultsPanel(e);
    case "waveform": return waveformPanel(e);
    case "audit": return auditPanel(e);
    default: return "";
  }
}
function dlChips(e) {
  if (!e.outputs.length) return `<p class="muted">出力できる CSV がありません。</p>`;
  return `<div class="chips">${e.outputs.map((o) => `
    <button class="chip" data-act="dl" data-name="${esc(o.name)}">${ICON.dl}<span>${esc(o.name)}</span>
      <span class="chip__size">${o.rows} 行 / ${fmtBytes(o.bytes.length)}</span></button>`).join("")}</div>`;
}
function reportPanel(e) {
  const rep = e.report.map((r) => `<tr>
      <td>${esc(r.item)}</td>
      <td class="n">${r.value === "" ? '<span class="empty-val">(なし)</span>' : esc(r.value)}</td>
      <td class="k">${esc(r.unit)}</td>
      <td class="src">${r.source_label ? esc(r.source_label) : "—"}</td>
    </tr>`).join("");
  const mainKeys = ["ロット/製造番号", "厚さ", "幅", "直径", "平行部長さ", "試験片形状", "試験片名", "品名", "試験日", "速度", "ロードセル容量"];
  const condRows = mainKeys.filter((k) => e.cond[k] != null).map((k) => {
    const unit = DIM_KEYS.has(k) ? " mm" : "";
    const filled = (e.condFilled || []).includes(k);
    return `<tr><td class="k">${esc(k)}</td><td class="n">${esc(e.cond[k])}${unit}</td>
      <td class="src">${filled ? "UTF-8 寸法セクションから補完" : "本体トークンから抽出"}</td></tr>`;
  }).join("");
  const nOther = Object.keys(e.cond).length - mainKeys.filter((k) => e.cond[k] != null).length;

  return `<div class="cols cols--2">
    <div>
      <div class="card">
        <div class="card__head"><span class="card__title">レポート項目</span>
          <span class="badge">抽出方式 <b>${esc(e.conf)}</b></span></div>
        <div class="card__body card__body--flush"><div class="table-wrap">
          <table class="tbl"><thead><tr><th>項目</th><th class="n">値</th><th>単位</th><th>出どころ（元ラベル）</th></tr></thead>
          <tbody>${rep}</tbody></table></div></div>
        <p class="card__note">値は変換元ファイルに格納された算出済みの数値です。「(なし)」は該当ラベルが見つからなかったことを、「N/A」は元ファイルが未算出（"-.-"）で保持していることを表します。</p>
      </div>
    </div>
    <div>
      <div class="card">
        <div class="card__head"><span class="card__title">主要な試験条件</span>
          ${nOther > 0 ? `<span class="badge">ほかに <b>${nOther}</b> 件（conditions.csv に全件）</span>` : ""}</div>
        <div class="card__body card__body--flush"><div class="table-wrap">
          <table class="tbl"><tbody>${condRows || `<tr><td class="muted">条件を抽出できませんでした</td></tr>`}</tbody></table></div></div>
      </div>
      <div class="card">
        <div class="card__head"><span class="card__title">このファイルの出力（分割ダウンロード）</span></div>
        <div class="card__body">${dlChips(e)}</div>
        <p class="card__note">すべてまとめて保存するときは、右上の主要ボタン（ZIP 一括ダウンロード）を使います。</p>
      </div>
      <div class="card">
        <div class="card__head"><span class="card__title">読み取りの根拠</span></div>
        <div class="card__body"><dl class="kv">
          <dt>形式の判定</dt><dd>${esc(e.fmtBasis)}</dd>
          <dt>文字列の文字コード</dt><dd>${e.fmt === "vtav" ? "UTF-8（1 バイト長 + 本体）" : "UTF-16LE（0x3E + 長さ + 本体）"}</dd>
          <dt>結果値の確度</dt><dd>${esc(e.conf)}${e.fmt === "vtav" ? "（値をバイト位置で確定）" : "（名前→単位→値の順序構造）"}</dd>
          <dt>入力の CRC-32</dt><dd class="mono">${hex8(e.crc)}</dd>
          <dt>出力の文字コード</dt><dd>UTF-8（BOM 付き）・改行 CRLF・区切り カンマ</dd>
        </dl></div>
      </div>
    </div>
  </div>`;
}

function resultsPanel(e) {
  const f = state.filter.trim();
  const rows = e.results.filter((r) => !f || r.label.includes(f) || String(r.value).includes(f) || (r.param || "").includes(f));
  return `<div class="card card--fill">
    <div class="card__head">
      <span class="card__title">結果サマリー全項目 <span class="unit">（${rows.length.toLocaleString("ja-JP")} / ${e.results.length.toLocaleString("ja-JP")} 件）</span></span>
      <div class="card__tools">
        <input class="input input--search" id="resFilter" type="search" placeholder="ラベル・値で絞り込む" value="${esc(state.filter)}">
        <button class="chip" data-act="dl" data-name="${esc(e.base)}_results.csv">${ICON.dl}results.csv</button>
      </div>
    </div>
    <div class="card__body card__body--flush"><div class="table-wrap">
      <table class="tbl"><thead><tr><th>ラベル</th><th class="n">値</th><th>単位</th><th>パラメータ</th><th>確度</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${esc(r.value)}</td>
        <td class="k">${esc(r.unit)}</td><td class="src">${esc(r.param || "—")}</td><td class="src">${esc(e.conf)}</td></tr>`).join("")}
      </tbody></table></div></div>
  </div>`;
}

function waveformPanel(e) {
  const w = e.wave;
  const names = Object.keys(w.columns);
  const limit = Math.min(w.points, 200);
  const rows = [];
  for (let i = 0; i < limit; i++) {
    rows.push(`<tr><td class="n k">${i}</td>${names.map((n) => `<td class="n">${pyFloat(w.columns[n][i])}</td>`).join("")}</tr>`);
  }
  return `<div class="card card--fill">
    <div class="card__head">
      <span class="card__title">生波形 <span class="unit">（先頭 ${limit} 行を表示／全 ${w.points.toLocaleString("ja-JP")} 点）</span></span>
      <div class="card__tools">
        <span class="badge">レコード周期 <b>${w.stride}</b> バイト</span>
        <span class="badge">採用列 <b>${names.length}</b> / 4</span>
        <button class="chip" data-act="dl" data-name="${esc(e.base)}_waveform.csv">${ICON.dl}waveform.csv</button>
      </div>
    </div>
    <div class="card__body card__body--flush"><div class="table-wrap">
      <table class="tbl"><thead><tr><th class="n">#</th>${names.map((n) => `<th class="n">${esc(n)}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody></table></div></div>
    <p class="card__note">マーカー 01 00 00 00 00 01 01 の等間隔出現から ${w.points.toLocaleString("ja-JP")} レコードを復元し、
      各マーカー位置からのオフセット（Time_sec −8 / Stroke_mm −4 / Force_N +29 / Extensometer_mm +37）を float32(LE) として読み出しています。
      数値は小数 6 桁に丸めて出力します。${w.dropped && w.dropped.length ? `　不採用列: ${esc(w.dropped.join(", "))}（範囲外または NaN を含む）` : ""}</p>
  </div>`;
}

function auditPanel(e) {
  return `<div class="card card--fill">
    <div class="card__head"><span class="card__title">変更履歴 <span class="unit">（${e.audit.length} 件）</span></span>
      <div class="card__tools">
        ${state.params.auditOut ? `<button class="chip" data-act="dl" data-name="${esc(e.base)}_audit.csv">${ICON.dl}audit.csv</button>`
          : `<span class="badge">${statusChip("na", "CSV 出力は設定でオフ")}</span>`}
      </div></div>
    <div class="card__body card__body--flush"><div class="table-wrap">
      <table class="tbl"><thead><tr><th>項目</th><th>変更内容</th><th>日時</th><th>ユーザ</th></tr></thead>
      <tbody>${e.audit.map((r) => `<tr><td>${esc(r.item)}</td><td>${esc(r.change)}</td>
        <td class="n">${esc(r.datetime)}</td><td>${esc(r.user)}</td></tr>`).join("")}</tbody></table></div></div>
  </div>`;
}

/* ---- 解析パネル ---- */
function statBlock(label, value, unit, basis, hero) {
  const na = value == null;
  return `<div class="stat${hero ? " stat--hero" : ""}">
    <div class="stat__label">${esc(label)}</div>
    <div class="stat__value${na ? " is-na" : ""}">${na ? "算出不可" : esc(value)}${na ? "" : `<span class="unit">${esc(unit)}</span>`}</div>
    <div class="stat__basis">${esc(basis)}</div>
  </div>`;
}
function analysisPanel(e) {
  const A = e.analysis;
  const areaCard = areaCardHtml(e);
  if (!A) {
    return `<div class="cols cols--2"><div>
      <div class="reason reason--warn">${ICON.warn}<div><b>解析できません</b>${esc(e.analysisBlock || "必要なデータが揃っていません")}</div></div>
    </div><div>${areaCard}</div></div>`;
  }
  const stats = [
    statBlock("引張強さ Rm", A.rm ? fmtNum(A.rm.value, 1) : null, "N/mm²", A.rm ? A.rm.basis : "応力が確定していません", true),
    statBlock("耐力（速度法）", A.yieldV && fin(A.yieldV.stress) ? fmtNum(A.yieldV.stress, 1) : null, "N/mm²",
      A.yieldV ? A.yieldV.basis : (A.blocked.find((b) => b.what === "耐力（速度法）") || {}).why || "算出不可", true),
    statBlock("0.2% 耐力", A.offset02 ? fmtNum(A.offset02.stress, 1) : null, "N/mm²",
      A.offset02 ? A.offset02.basis : (A.blocked.find((b) => b.what.startsWith("弾性勾配")) || {}).why || "算出不可", true),
    statBlock("伸び（破断ひずみ）", A.elongation ? fmtNum(A.elongation.value, 2) : null, "%",
      A.elongation ? `${A.elongation.method}／${A.elongation.basis}` : (A.blocked.find((b) => b.what.startsWith("伸び")) || {}).why || "算出不可", true),
    statBlock("応力増加速度", A.rampRate ? fmtNum(A.rampRate.value, 2) : null, "MPa/s",
      A.rampRate ? A.rampRate.basis : (A.blocked.find((b) => b.what === "応力増加速度") || {}).why || "算出不可"),
    statBlock("ヤング率 E", A.youngs ? fmtNum(A.youngs.nmm2, 0) : null, "N/mm²",
      A.youngs ? `弾性勾配 × 100（= ${fmtNum(A.youngs.gpa, 1)} GPa）` : "直線域が決まらないため算出不可"),
    statBlock("ひずみ速度①（弾性）", A.strainRate1 ? fmtExp(A.strainRate1.value, 2) : null, "s⁻¹",
      A.strainRate1 ? A.strainRate1.basis : "直線域または時間データがありません"),
    statBlock("ひずみ速度②（塑性）", A.strainRate2 ? fmtExp(A.strainRate2.value, 2) : null, "s⁻¹",
      A.strainRate2 ? A.strainRate2.basis : "耐力点〜破断点の区間が決まりません"),
  ].join("");

  /* 判定の根拠になった場所へ、線図を拡大して飛べるようにする */
  const inspectOf = (label) =>
    label.includes("直線") ? "linear" : label.includes("応力増加速度") ? "linear" : label.includes("主要値") ? "all" : null;
  const canChart = !!(A.series && A.series.stress);
  const checks = A.verdict.checks.map((c) => {
    const j = canChart ? inspectOf(c.label) : null;
    return `<div class="check">
      ${statusChip(c.level === "ng" ? "err" : c.level, { ok: "合格", warn: "要確認", ng: "不合格", na: "未評価" }[c.level])}
      <div class="check__body"><b>${esc(c.label)}</b><span class="muted">${esc(c.detail)}</span>
        ${j ? `<button class="chip btn--sm" data-act="inspect" data-j="${j}" style="margin-top:var(--sp-1)">線図で確認</button>` : ""}
      </div>
    </div>`;
  }).join("");

  const blocked = A.blocked.length
    ? A.blocked.map((b) => `<div class="check">${statusChip("na", "算出不可")}
        <div class="check__body"><b>${esc(b.what)}</b><span class="muted">${esc(b.why)}</span></div></div>`).join("")
    : `<p class="muted">すべての量を算出できました。</p>`;

  return `<div class="cols cols--2">
    <div>
      <div class="card">
        <div class="card__head"><span class="card__title">主要な機械的特性</span>
          <div class="card__tools">${A.ok ? `<button class="chip" data-act="dl" data-name="${esc(e.base)}_analysis.csv">${ICON.dl}analysis.csv</button>` : ""}</div>
        </div>
        <div class="card__body"><div class="stats">${stats}</div></div>
        <p class="card__note">応力の取得: ${esc(A.basis.stress || "未確定")}${A.basis.strain ? `　／　ひずみ: ${esc(A.basis.strain)}` : ""}${A.basis.velocity ? `　／　速度: ${esc(A.basis.velocity)}` : ""}</p>
      </div>
      <div class="card">
        <div class="card__head"><span class="card__title">判定の内訳</span></div>
        <div class="card__body"><div class="checks">${checks}</div></div>
      </div>
    </div>
    <div>
      ${areaCard}
      <div class="card">
        <div class="card__head"><span class="card__title">直線域（弾性勾配）の決定</span></div>
        <div class="card__body">${A.linear ? `<dl class="kv">
            <dt>使用区間</dt><dd>第 ${A.linear.startIdx + 1}〜${A.linear.cutoffIdx + 1} 点（${A.linear.nPoints} 点）</dd>
            <dt>ひずみ範囲</dt><dd>${fmtNum(A.linear.strainFrom, 3)} 〜 ${fmtNum(A.linear.strainTo, 3)} %</dd>
            <dt>勾配</dt><dd>${fmtNum(A.linear.slope, 2)} N/mm² per ε%</dd>
            <dt>直線性 R²</dt><dd>${A.linear.r2.toFixed(5)}</dd>
            <dt>根拠</dt><dd>${esc(A.linear.basis)}</dd>
          </dl>${A.linear.fallback ? `<div class="reason reason--warn" style="margin-top:var(--sp-3)">${ICON.warn}<div><b>代替基準を使用しています</b>耐力（速度法）が算出できないため、直線域の基準を Rm から推定しました。0.2% 耐力・ヤング率は参考値として扱ってください。</div></div>` : ""}`
          : `<p class="muted">直線域を決定できませんでした。</p>`}</div>
      </div>
      <div class="card">
        <div class="card__head"><span class="card__title">算出できなかった量とその理由</span></div>
        <div class="card__body"><div class="checks">${blocked}</div></div>
      </div>
    </div>
  </div>`;
}

function areaCardHtml(e) {
  if (e.kind === "csv") {
    const cols = e.csv && e.csv.ok ? e.csv : null;
    const opts = (role, sel) => `<select class="select" data-act="csvmap" data-role="${role}" id="map_${role}">
        <option value="-1">（割り当てなし）</option>
        ${(cols ? cols.headers : []).map((h, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>${esc(h || `列${i + 1}`)}</option>`).join("")}
      </select>`;
    return `<div class="card">
      <div class="card__head"><span class="card__title">CSV の列マッピング</span>
        <span class="badge">文字コード <b>${esc(e.csv ? e.csv.enc : "?")}</b></span></div>
      <div class="card__body">
        <div class="fields">
          ${CSV_ROLES.map((r) => `<div class="field"><span class="field__label">${esc(r.label)}（${esc(r.unit)}）</span>${opts(r.role, e.csv.map[r.role] ?? -1)}</div>`).join("")}
        </div>
        <p class="field__hint" style="margin-top:var(--sp-2)">ヘッダ行は ${e.csv.headerRow + 1} 行目と判定しました。応力列がある場合は換算せずそのまま使用します（§11.2 A）。</p>
      </div>
    </div>`;
  }
  const o = e.areaOverride;
  const auto = resolveArea({ ...e, areaOverride: { mode: "auto" } });
  const cur = resolveArea(e);
  const modes = [["auto", "試験条件から自動"], ["plate", "平板（厚さ×幅）を入力"], ["round", "丸棒（直径）を入力"], ["direct", "断面積 A を直接入力"]];
  return `<div class="card">
    <div class="card__head"><span class="card__title">断面積 A とゲージ長</span>
      <span class="badge">A = <b>${cur.area ? fmtNum(cur.area, 3) : "未確定"}</b> mm²</span></div>
    <div class="card__body">
      <div class="fields">
        <div class="field"><span class="field__label">断面積の決め方</span>
          <select class="select" id="areaMode" data-act="areamode">
            ${modes.map(([v, l]) => `<option value="${v}" ${o.mode === v ? "selected" : ""}>${l}</option>`).join("")}
          </select></div>
        ${o.mode === "plate" ? `
          <div class="field"><span class="field__label">厚さ（mm）</span><input class="input" id="areaT" type="number" step="0.001" min="0" value="${o.t ?? ""}" data-act="areanum" data-k="t"></div>
          <div class="field"><span class="field__label">幅（mm）</span><input class="input" id="areaW" type="number" step="0.001" min="0" value="${o.w ?? ""}" data-act="areanum" data-k="w"></div>` : ""}
        ${o.mode === "round" ? `
          <div class="field"><span class="field__label">直径（mm）</span><input class="input" id="areaD" type="number" step="0.001" min="0" value="${o.d ?? ""}" data-act="areanum" data-k="d"></div>` : ""}
        ${o.mode === "direct" ? `
          <div class="field"><span class="field__label">断面積 A（mm²）</span><input class="input" id="areaA" type="number" step="0.001" min="0" value="${o.A ?? ""}" data-act="areanum" data-k="A"></div>` : ""}
        <div class="field"><span class="field__label">ゲージ長（mm・全ファイル共通）</span>
          <input class="input" id="gauge" type="number" step="0.1" min="0.1" value="${state.params.gaugeLength}" data-act="gauge"></div>
      </div>
      <p class="field__hint" style="margin-top:var(--sp-2)">
        ${cur.area ? `現在の根拠: ${esc(cur.basis)}` : "断面積が決まらないため応力を復元できません。上で寸法または A を入力してください。"}
        ${auto.area ? `　／　試験条件からの自動値: ${fmtNum(auto.area, 3)} mm²` : "　／　試験条件に寸法がありません"}
      </p>
    </div>
    <p class="card__note">DAT 入力の全点 SS 曲線は σ = 試験力 ÷ A で復元します（元ファイル内蔵のサマリー応力と一致する定義）。</p>
  </div>`;
}

/* ---- 線図パネル ---- */
/**
 * 線図の表示コンテキスト。画面内と最大化ウィンドウで同じ組み立て関数を使うため、
 * 「どの軸を・どの表示範囲に記録し・どの操作を出すか」をここ 1 か所で決める。
 */
function chartCtx() {
  const C = state.chart;
  if (state.chartMax === "sub")  return { x: "time", y: "stress", viewKey: "viewSub", axisLock: true,  withSub: false, max: true };
  if (state.chartMax === "main") return { x: C.x, y: C.y, viewKey: "view", axisLock: false, withSub: false, max: true };
  return { x: C.x, y: C.y, viewKey: "view", axisLock: false, withSub: C.side, max: false };
}
/** いま線図が置かれている入れ物（本体 or 最大化ウィンドウ）。id はこの中で一意。 */
const chartHome = () => (state.chartMax ? dlgChart : elStage);
const cq = (sel) => chartHome().querySelector(sel);

/* 注目点ジャンプ（無効なものは理由つきで disabled にする） */
function jumpList(A) {
  return [
    { k: "all",      label: "全体",      ok: true,          why: "" },
    { k: "linear",   label: "直線域",    ok: !!A.linear,    why: "直線域を決定できていません" },
    { k: "yield",    label: "耐力点",    ok: !!A.yieldV,    why: "耐力点（速度法）を検出できていません" },
    { k: "offset",   label: "0.2%耐力",  ok: !!A.offset02,  why: "0.2% 耐力を算出できていません" },
    { k: "fracture", label: "破断点",    ok: !!(A.fractureA || A.fractureB), why: "破断点を検出できていません" },
  ];
}

/** 作図ツールバー（軸・注釈・表示範囲・ジャンプ） */
function chartbarHtml(A, K) {
  const C = state.chart;
  const axisOpts = (sel) => Object.entries(AXES).map(([k, v]) =>
    `<option value="${k}" ${k === sel ? "selected" : ""} ${A.series[k] ? "" : "disabled"}>${esc(v.label)}</option>`).join("");
  const isSS = K.x === "strain" && K.y === "stress";
  const preset = isSS ? "ss" : (K.x === "time" && K.y === "stress" ? "ts" : "custom");
  const annOff = isSS ? "" : ' disabled title="注釈は ひずみ-応力線図のときだけ重ねます"';
  const jumps = jumpList(A);
  const jumpWhy = jumps.filter((j) => !j.ok).map((j) => `${j.label}: ${j.why}`).join("／");

  return `<div class="chartbar">
    <div class="chartbar__row">
      ${K.axisLock
        ? `<span class="badge">軸 <b>時間 － 応力</b>（並べて表示している線図を最大化中）</span>`
        : `<div class="seg" role="group" aria-label="線図の切替">
             <button data-act="preset" data-p="ss" aria-pressed="${preset === "ss"}">ひずみ-応力</button>
             <button data-act="preset" data-p="ts" aria-pressed="${preset === "ts"}">時間-応力</button>
           </div>
           <span class="field__label">X 軸</span>
           <select class="select select--axis" id="axX" data-act="axis" data-k="x">${axisOpts(K.x)}</select>
           <span class="field__label">Y 軸</span>
           <select class="select select--axis" id="axY" data-act="axis" data-k="y">${axisOpts(K.y)}</select>`}
      <label class="check-line"><input type="checkbox" data-act="cmark"${annOff} ${C.markers ? "checked" : ""}>マーカー</label>
      <label class="check-line"><input type="checkbox" data-act="cfit"${annOff} ${C.fit ? "checked" : ""}>回帰直線・0.2% 線</label>
      ${K.max ? "" : `<label class="check-line"><input type="checkbox" data-act="cside" ${C.side ? "checked" : ""}>時間-応力を並べる</label>`}
      <span class="rangebar__hint">
        <span><kbd>ホイール</kbd> 拡大縮小（<kbd>Shift</kbd> X のみ / <kbd>Alt</kbd> Y のみ）</span>
        <span><kbd>左ドラッグ</kbd> 移動</span>
        <span><kbd>右ドラッグ</kbd> 囲って拡大</span>
        <span><kbd>ダブルクリック</kbd> 全体</span>
      </span>
    </div>
    <div class="chartbar__row rangebar">
      <span class="rangebar__group">
        <span class="rangebar__label">X</span>
        <input id="rngXMin" type="number" step="any" data-act="range" data-k="xMin" aria-label="X 軸の下限">
        <span class="rangebar__sep">〜</span>
        <input id="rngXMax" type="number" step="any" data-act="range" data-k="xMax" aria-label="X 軸の上限">
        <button class="nudge" data-act="nudge" data-d="xl" title="X を左へ 15% 動かす">${ICON.arrowL}</button>
        <button class="nudge" data-act="nudge" data-d="xr" title="X を右へ 15% 動かす">${ICON.arrowR}</button>
      </span>
      <span class="rangebar__div"></span>
      <span class="rangebar__group">
        <span class="rangebar__label">Y</span>
        <input id="rngYMin" type="number" step="any" data-act="range" data-k="yMin" aria-label="Y 軸の下限">
        <span class="rangebar__sep">〜</span>
        <input id="rngYMax" type="number" step="any" data-act="range" data-k="yMax" aria-label="Y 軸の上限">
        <button class="nudge" data-act="nudge" data-d="yd" title="Y を下へ 15% 動かす">${ICON.arrowD}</button>
        <button class="nudge" data-act="nudge" data-d="yu" title="Y を上へ 15% 動かす">${ICON.arrowU}</button>
      </span>
      <span class="rangebar__div"></span>
      <span class="jump">
        <span class="jump__label">拡大して確認:</span>
        ${jumps.map((j) => `<button class="chip btn--sm" data-act="jump" data-j="${j.k}" ${j.ok ? "" : `disabled title="${esc(j.why)}"`}>${esc(j.label)}</button>`).join("")}
      </span>
    </div>
    ${jumpWhy ? `<p class="chartbar__note">押せない拡大ボタンの理由: ${esc(jumpWhy)}</p>` : ""}
    ${!isSS ? `<p class="chartbar__note">注釈（耐力点▽・破断点×・0.2%耐力★・回帰直線）は ひずみ-応力線図のときに重ねます。</p>` : ""}
  </div>`;
}

/** 主図カード（本体でも最大化ウィンドウでも同じものを使う） */
function chartCardHtml(A, K) {
  const C = state.chart;
  const title = `${AXES[K.x].label} － ${AXES[K.y].label}`;
  const tool = K.max ? ""      /* 「もとの画面に戻す」はウィンドウの見出しに 1 つだけ置く */
    : `<button class="chip btn--sm" data-act="cmax" data-c="0">${ICON.expand}<span>最大化</span></button>`;
  return `<div class="card chartcard">
    <div class="card__head">
      <span class="card__title" id="c1title">${esc(title)}</span>
      <div class="card__tools">
        <button class="chip btn--sm" data-act="png" data-c="0">${ICON.dl}PNG 保存</button>
        ${tool}
      </div>
    </div>
    <div class="chart-host" id="chart1" tabindex="0" role="img"
         aria-label="${esc(title)} の線図。矢印キーで移動、+ と − で拡大縮小、0 で全体表示。">
      <div class="chart-zoomstate" id="zoomState"></div>
    </div>
    <div class="overview${C.ovCollapsed ? " is-collapsed" : ""}" id="ovWrap">
      <div class="overview__bar">
        <b>全体図</b>
        <span>${C.ovCollapsed ? "たたんでいます" : "枠をドラッグすると表示範囲が動きます"}</span>
        <span style="margin-left:auto"></span>
        <button class="chip btn--sm" data-act="ovtoggle">${C.ovCollapsed ? "開く" : "たたむ"}</button>
      </div>
      <div class="overview__host" id="chartOv"></div>
    </div>
    <div class="legend" id="legend1"></div>
  </div>`;
}

/** 副図カード（時間-応力を並べたとき） */
function chartSubCardHtml() {
  return `<div class="card chartcard">
    <div class="card__head"><span class="card__title">時間 － 応力線図</span>
      <div class="card__tools">
        <button class="chip btn--sm" data-act="png" data-c="1">${ICON.dl}PNG 保存</button>
        <button class="chip btn--sm" data-act="cmax" data-c="1">${ICON.expand}<span>最大化</span></button>
      </div></div>
    <div class="chart-host" id="chart2" tabindex="0" role="img" aria-label="時間と応力の線図"></div>
    <div class="legend" id="legend2"></div>
  </div>`;
}

/** ツールバー＋線図カードひとそろい */
function chartWorkspaceHtml(e, K) {
  const A = e.analysis;
  return `<div class="charts${K.max ? " charts--max" : ""}">
    ${chartbarHtml(A, K)}
    <div class="charts__row${K.withSub ? " is-split" : ""}">
      ${chartCardHtml(A, K)}
      ${K.withSub ? chartSubCardHtml() : ""}
    </div>
  </div>`;
}

function chartsPanel(e) {
  const A = e.analysis;
  if (!A || !A.series.stress) {
    return `<div class="reason reason--warn" style="align-self:start">${ICON.warn}<div><b>線図を描けません</b>${esc(e.analysisBlock || "応力が確定していないため作図できません。解析タブで断面積を入力してください。")}</div></div>`;
  }
  if (state.chartMax) {
    return `<div class="reason" style="align-self:start">${ICON.na}<div><b>いまは最大化ウィンドウで表示しています</b>
      画面いっぱいの別ウィンドウに線図を移しています。<kbd>Esc</kbd> か「もとの画面に戻す」でここへ戻ります（表示範囲はそのまま引き継ぎます）。</div></div>`;
  }
  return chartWorkspaceHtml(e, chartCtx());
}

/* ---- 線図の最大化ウィンドウ ---- */
const dlgChart = $("#dlgChart");
function chartMaxHtml(e) {
  const K = chartCtx();
  const what = state.chartMax === "sub" ? "時間 － 応力線図" : `${AXES[K.x].label} － ${AXES[K.y].label}`;
  return `<div class="dlg dlg--max">
    <div class="dlg__head">
      <span class="dlg__title">線図（最大化）</span>
      <span class="badge">${esc(e.name)}</span>
      <span class="badge">${esc(what)}</span>
      <div class="card__tools">
        <button class="btn btn--plain btn--sm" data-act="cmin">${ICON.shrink}もとの画面に戻す（Esc）</button>
      </div>
    </div>
    <div class="dlg__body dlg__body--flush">${chartWorkspaceHtml(e, K)}</div>
  </div>`;
}
/** 最大化ウィンドウの中身を作り直す。開けない条件になったら閉じる。 */
function renderChartMax() {
  const e = selected();
  const usable = state.chartMax && e && e.status === "done" && e.analysis && e.analysis.series.stress
    && !(state.chartMax === "sub" && !e.analysis.series.time);
  if (!usable) {
    state.chartMax = null;
    dlgChart.innerHTML = "";
    if (dlgChart.open) dlgChart.close();
    return;
  }
  dlgChart.innerHTML = chartMaxHtml(e);
  if (!dlgChart.open) dlgChart.showModal();
  mountCharts(e);
  const host = cq("#chart1");
  if (host && !dlgChart.contains(document.activeElement)) host.focus();
}

function seriesFor(A, xKey, yKey) {
  const sx = A.series[xKey], sy = A.series[yKey];
  if (!sx || !sy) return null;
  const n = Math.min(sx.length, sy.length);
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = sx[i], y = sy[i];
    if (!fin(x) || !fin(y)) continue;
    xs[m] = x; ys[m] = y; m++;
  }
  return { xs: xs.subarray(0, m), ys: ys.subarray(0, m) };
}
const legendItem = (glyph, varName, label, detail) => `<span class="legend-item">
  <svg viewBox="0 0 22 12" style="color:var(${varName})" aria-hidden="true">${glyph}</svg>
  <span><b>${esc(label)}</b>${detail ? ` ${esc(detail)}` : ""}</span></span>`;
const GLYPH = {
  line: '<path d="M1 6h20" stroke="currentColor" stroke-width="2.2" fill="none"/>',
  dash: '<path d="M1 6h20" stroke="currentColor" stroke-width="2.2" stroke-dasharray="4 3" fill="none"/>',
  tri:  '<path d="M5 3h12l-6 7z" fill="none" stroke="currentColor" stroke-width="2"/>',
  x:    '<path d="M6 2l10 8M16 2 6 10" stroke="currentColor" stroke-width="2"/>',
  star: '<path d="m11 1 2.2 4.5 4.8.7-3.5 3.4.8 4.8L11 12l-4.3 2.4.8-4.8L4 6.2l4.8-.7z" fill="currentColor" transform="scale(.8) translate(2.5,0)"/>',
  band: '<rect x="1" y="1" width="20" height="10" fill="currentColor" opacity=".35"/>',
};

/** 主図の系列（注釈込み）を組み立てる */
function buildMainSpec(A, xk, yk) {
  const spec = {
    xLabel: AXES[xk].label, yLabel: AXES[yk].label,
    xUnit: AXES[xk].unit, yUnit: AXES[yk].unit,
    xShort: AXES[xk].short, yShort: AXES[yk].short,
    series: [], markers: [], bands: [],
  };
  const legend = [];
  const base = seriesFor(A, xk, yk);
  if (base && base.xs.length) {
    spec.series.push({ ...base, color: cssVar("--chart-line"), width: 1.8, primary: true });
    legend.push(legendItem(GLYPH.line, "--chart-line", "測定データ", `${base.xs.length.toLocaleString("ja-JP")} 点`));
  }
  const isSS = xk === "strain" && yk === "stress";
  if (isSS && A.linear && state.chart.fit) {
    const { slope, intercept, strainFrom, strainTo } = A.linear;
    let xEnd = strainTo;
    if (A.offset02) xEnd = Math.max(xEnd, A.offset02.strain * 1.08);
    if (A.yieldV && fin(A.yieldV.strain)) xEnd = Math.max(xEnd, A.yieldV.strain * 1.05);
    spec.series.push({ xs: Float64Array.from([strainFrom, strainTo]), ys: Float64Array.from([slope * strainFrom + intercept, slope * strainTo + intercept]),
      color: cssVar("--chart-fit"), width: 2, scale: false });
    spec.series.push({ xs: Float64Array.from([strainTo, xEnd]), ys: Float64Array.from([slope * strainTo + intercept, slope * xEnd + intercept]),
      color: cssVar("--chart-fit"), width: 1.6, dash: [5, 4], scale: false });
    const ox1 = Math.max(0.2, xEnd + 0.2);
    spec.series.push({ xs: Float64Array.from([0.2, ox1]), ys: Float64Array.from([0, slope * (ox1 - 0.2)]),
      color: cssVar("--chart-offset"), width: 1.6, dash: [5, 4], scale: false });
    spec.bands.push({ from: strainFrom, to: strainTo });
    legend.push(legendItem(GLYPH.band, "--chart-line", "直線域", `ε ${fmtNum(strainFrom, 3)}〜${fmtNum(strainTo, 3)} %`));
    legend.push(legendItem(GLYPH.line, "--chart-fit", "回帰直線（弾性勾配）", `R² ${A.linear.r2.toFixed(4)}／破線は外挿`));
    legend.push(legendItem(GLYPH.dash, "--chart-offset", "0.2% オフセット線", `σ = ${fmtNum(slope, 1)} × (ε − 0.2)`));
  }
  if (isSS && state.chart.markers) {
    if (A.yieldV && fin(A.yieldV.strain) && fin(A.yieldV.stress)) {
      spec.markers.push({ x: A.yieldV.strain, y: A.yieldV.stress, shape: "triangle-down", color: cssVar("--chart-yield"), label: "耐力", below: true });
      legend.push(legendItem(GLYPH.tri, "--chart-yield", "耐力点（速度法）", `${fmtNum(A.yieldV.stress, 1)} N/mm²`));
    }
    if (A.offset02) {
      spec.markers.push({ x: A.offset02.strain, y: A.offset02.stress, shape: "star", color: cssVar("--chart-offset"), label: "0.2%" });
      legend.push(legendItem(GLYPH.star, "--chart-offset", "0.2% 耐力", `${fmtNum(A.offset02.stress, 1)} N/mm²`));
    }
    const fr = A.fractureA || A.fractureB;
    if (fr && fin(fr.strain) && fin(fr.stress)) {
      spec.markers.push({ x: fr.strain, y: fr.stress, shape: "x", color: cssVar("--chart-fracture"), label: "破断" });
      legend.push(legendItem(GLYPH.x, "--chart-fracture", "破断点", `伸び ${fmtNum(fr.strain, 2)} %`));
    }
    if (A.rm && fin(A.rm.strain)) {
      spec.markers.push({ x: A.rm.strain, y: A.rm.value, shape: "circle", color: cssVar("--chart-line-2"), label: "Rm" });
      legend.push(legendItem(GLYPH.line, "--chart-line-2", "引張強さ Rm", `${fmtNum(A.rm.value, 1)} N/mm²`));
    }
  }
  if (xk === "time" && yk === "stress" && A.rampRate) {
    legend.push(legendItem(GLYPH.dash, "--chart-fit", "応力増加速度", `${fmtNum(A.rampRate.value, 2)} MPa/s（直線域の傾き）`));
  }
  return { spec, legend };
}

/* 表示範囲バーとズーム状態バッジの同期 */
function setRangeInputs(r) {
  const put = (id, v) => { const el = cq(id); if (el && document.activeElement !== el) el.value = fin(v) ? Number(v.toPrecision(5)) : ""; };
  put("#rngXMin", r.x0); put("#rngXMax", r.x1);
  put("#rngYMin", r.y0); put("#rngYMax", r.y1);
}
function setZoomState(chart, r, zoomed) {
  const el = cq("#zoomState");
  if (!el) return;
  const auto = chart.autoRange();
  const mag = auto && zoomed ? (auto.x1 - auto.x0) / (r.x1 - r.x0) : 1;
  el.innerHTML = zoomed
    ? `<span class="badge">拡大 <b>×${mag >= 10 ? mag.toFixed(0) : mag.toFixed(1)}</b></span>
       <button class="chip btn--sm" data-act="viewreset">${ICON.reset}全体表示に戻す</button>`
    : `<span class="badge">全体表示</span>`;
}

/** 注目点まわりの表示範囲を作る（軸が何であっても index から引く） */
function jumpRange(A, xk, yk, kind) {
  const sx = A.series[xk], sy = A.series[yk];
  if (!sx || !sy) return null;
  let x0, x1;
  const spanOf = (arr) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (!fin(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    return isFinite(lo) ? hi - lo : 1;
  };
  const full = spanOf(sx);
  const at = (i) => (i != null && fin(sx[i]) ? sx[i] : null);
  /* 弾性域まわりは「直線域の幅」を単位にする（全体幅を基準にすると拡大が甘くなる） */
  const la = A.linear ? at(A.linear.startIdx) : null, lb = A.linear ? at(A.linear.cutoffIdx) : null;
  const local = (la != null && lb != null) ? Math.abs(lb - la) : 0;
  const unit = local > 0 ? local * 10 : full * 0.05;
  if (kind === "linear" && A.linear) {
    if (la == null || lb == null) return null;
    const w = local || full * 0.01;
    x0 = Math.min(la, lb) - w * 0.6; x1 = Math.max(la, lb) + w * 3;
  } else if (kind === "yield" && A.yieldV) {
    const v = at(A.yieldV.index);
    if (v == null) return null;
    x0 = v - unit; x1 = v + unit * 1.5;
  } else if (kind === "offset" && A.offset02) {
    const v = at(A.offset02.index);
    if (v == null) return null;
    x0 = v - unit * 1.2; x1 = v + unit * 1.2;
  } else if (kind === "fracture") {
    const fr = A.fractureA || A.fractureB;
    const v = fr ? at(fr.index) : null;
    if (v == null) return null;
    const w = full * 0.06;
    x0 = v - w * 3; x1 = v + w * 1.5;
  } else {
    return null;
  }
  /* データのある範囲からはみ出した分は切り詰める */
  let dx0 = Infinity, dx1 = -Infinity;
  for (let i = 0; i < sx.length; i++) { const v = sx[i]; if (!fin(v)) continue; if (v < dx0) dx0 = v; if (v > dx1) dx1 = v; }
  if (isFinite(dx0)) {
    const pad = (dx1 - dx0) * 0.02 || 1;
    x0 = Math.max(x0, dx0 - pad);
    x1 = Math.min(x1, dx1 + pad);
    if (!(x1 > x0)) return null;
  }
  /* X 窓の中にある実データから Y 範囲を決める */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < sx.length; i++) {
    const x = sx[i], y = sy[i];
    if (!fin(x) || !fin(y) || x < x0 || x > x1) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  if (!isFinite(lo)) return null;
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
  return { x0, x1, y0: lo - pad, y1: hi + pad };
}

function mountCharts(e) {
  const A = e.analysis;
  if (!A || !A.series.stress) return;
  const K = chartCtx();
  const host1 = cq("#chart1"), hostOv = cq("#chartOv");
  if (!host1) return;
  const C = state.chart;

  /* --- 主図 --- */
  const { spec, legend } = buildMainSpec(A, K.x, K.y);
  const c1 = new LineChart(host1, {
    onViewChange: (r, zoomed) => {
      C[K.viewKey] = zoomed ? { ...r } : null;
      setRangeInputs(r);
      setZoomState(c1, r, zoomed);
      if (ov) ov.setHighlight(r);
    },
  });
  c1.setData(spec);
  charts.push(c1);
  chartRefs.main = c1;
  const lg1 = cq("#legend1");
  if (lg1) lg1.innerHTML = legend.join("");

  /* --- ミニマップ（全体図）: 常に全体を描き、いま見ている範囲を枠で示す --- */
  let ov = null;
  if (hostOv && !C.ovCollapsed) {
    ov = new LineChart(hostOv, { overview: true, onRequestView: (v) => c1.setView(v) });
    ov.setData(spec);
    charts.push(ov);
    chartRefs.ov = ov;
  }

  /* 直前の表示範囲を復元してから、バーとバッジを合わせる */
  if (C.pendingJump) {
    const jr = C.pendingJump === "all" ? null : jumpRange(A, K.x, K.y, C.pendingJump);
    C.pendingJump = null;
    C[K.viewKey] = jr || null;
  }
  if (C[K.viewKey]) c1.setView(C[K.viewKey], true);
  const r0 = c1.range();
  if (r0) {
    setRangeInputs(r0);
    setZoomState(c1, r0, c1.isZoomed());
    if (ov) ov.setHighlight(r0);
  }

  /* --- 副図（時間-応力）--- */
  const host2 = cq("#chart2");
  if (host2) {
    const ts = A.series.time ? seriesFor(A, "time", "stress") : null;
    const c2 = new LineChart(host2, {
      onViewChange: (r, zoomed) => { C.viewSub = zoomed ? { ...r } : null; },
    });
    const lg2 = cq("#legend2");
    if (ts && ts.xs.length) {
      c2.setData({
        xLabel: AXES.time.label, yLabel: AXES.stress.label,
        xUnit: AXES.time.unit, yUnit: AXES.stress.unit, xShort: AXES.time.short, yShort: AXES.stress.short,
        series: [{ ...ts, color: cssVar("--chart-line"), width: 1.8, primary: true }],
        markers: [], bands: [],
      });
      if (C.viewSub) c2.setView(C.viewSub, true);
      if (lg2) lg2.innerHTML = legendItem(GLYPH.line, "--chart-line", "時間-応力", `${ts.xs.length.toLocaleString("ja-JP")} 点`) +
        (A.rampRate ? legendItem(GLYPH.dash, "--chart-fit", "応力増加速度", `${fmtNum(A.rampRate.value, 2)} MPa/s（直線域の傾き）`) : "");
    } else {
      c2.setData({ xLabel: AXES.time.label, yLabel: AXES.stress.label, xUnit: "sec", yUnit: "N/mm²", xShort: "t", yShort: "σ", series: [], markers: [], bands: [] });
      if (lg2) lg2.innerHTML = `<span class="legend-item">${statusChip("na", "時間データなし")} 時間列が無いため作図できません</span>`;
    }
    charts.push(c2);
    chartRefs.sub = c2;
  }
}

/* ---- 一覧（§16.2） ---- */
function summaryHtml() {
  const rows = summaryRows();
  const { key, dir } = state.sort;
  const col = SUMMARY_COLS.find((c) => c.key === key) || SUMMARY_COLS[1];
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (col.num) {
      const fa = fin(va) ? va : -Infinity, fb = fin(vb) ? vb : -Infinity;
      return (fa - fb) * dir;
    }
    return String(va).localeCompare(String(vb), "ja") * dir;
  });
  const head = SUMMARY_COLS.map((c) => `<th class="sortable ${c.num ? "n" : ""}" data-sort="${c.key}"
      ${key === c.key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${esc(c.label)}${c.unit ? `<br><span class="muted">${esc(c.unit)}</span>` : ""}
      <span class="arrow">${key === c.key ? (dir > 0 ? "▲" : "▼") : "↕"}</span></th>`).join("");
  const body = rows.map((r) => `<tr class="rowlink" data-open="${r.id}">
      ${SUMMARY_COLS.map((c) => {
        if (c.key === "verdict") {
          const kind = r.level === "ng" ? "err" : r.level === "ok" ? "ok" : r.level === "warn" ? "warn" : "na";
          return `<td>${statusChip(kind, r.verdict)}</td>`;
        }
        const v = r[c.key];
        if (!c.num) return `<td class="${c.key === "name" ? "" : "k"}">${esc(v || "—")}</td>`;
        return `<td class="n">${fin(v) ? (c.exp ? fmtExp(v, 2) : fmtNum(v, c.d)) : '<span class="empty-val">—</span>'}</td>`;
      }).join("")}
    </tr>`).join("");

  return `<div class="ws">
    <div class="ws__head">
      <div class="ws__id">
        <div class="ws__name">解析結果 一覧</div>
        <div class="ws__meta"><span class="badge">変換済 <b>${rows.length}</b> 件</span>
          <span class="badge">列見出しをクリックで並べ替え／行をクリックで単票へ</span></div>
      </div>
      ${viewSeg()}
    </div>
    <div></div><div></div>
    <div class="panel panel--fixed">
      <div class="card card--fill">
        <div class="card__head"><span class="card__title">集計表</span>
          <div class="card__tools">
            <button class="chip" data-act="dl-summary">${ICON.dl}summary.csv を保存</button>
          </div></div>
        <div class="card__body card__body--flush"><div class="table-wrap">
          <table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="muted">変換済みのファイルがありません</td></tr>`}</tbody></table>
        </div></div>
        <p class="card__note">単位は列見出しに表記。空欄（—）は算出できなかった項目です（理由は各ファイルの解析タブに表示します）。ZIP 一括ダウンロードにもこの summary.csv を含めます。</p>
      </div>
    </div>
  </div>`;
}
/* ============================================================================
 * 設定ダイアログ
 * ==========================================================================*/
const dlg = $("#dlgSettings");
function buildSettings() {
  const groups = new Map();
  for (const m of PARAM_META) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const groupHtml = [...groups].map(([g, items]) => `<div class="card">
      <div class="card__head"><span class="card__title">${esc(g)}</span></div>
      <div class="card__body"><div class="fields">
        ${items.map((m) => `<div class="field">
            <span class="field__label">${esc(m.label)}<span class="muted">（${esc(m.unit)}）</span></span>
            <input class="input" type="number" data-param="${m.key}" step="${m.step}"
              ${m.min != null ? `min="${m.min}"` : ""} ${m.max != null ? `max="${m.max}"` : ""}
              value="${state.params[m.key]}">
          </div>`).join("")}
      </div></div>
    </div>`).join("");

  $("#dlgBody").innerHTML = `
    <div class="card">
      <div class="card__head"><span class="card__title">出力と平滑化</span></div>
      <div class="card__body"><div class="fields">
        <label class="check-line"><input type="checkbox" data-param="auditOut" ${state.params.auditOut ? "checked" : ""}>変更履歴（audit）も CSV 出力する（.vtav のみ）</label>
        <label class="check-line"><input type="checkbox" data-param="smoothing" ${state.params.smoothing ? "checked" : ""}>速度を移動平均で平滑化する</label>
        <label class="check-line"><input type="checkbox" data-param="rampCheck" ${state.params.rampCheck ? "checked" : ""}>応力増加速度を許容範囲で判定する</label>
      </div></div>
      <p class="card__note">audit をオフにすると audit.csv は生成されません（ZIP・分割 DL の一覧からも消えます）。</p>
    </div>
    ${groupHtml}
    <div class="card">
      <div class="card__head"><span class="card__title">この設定の扱い</span></div>
      <div class="card__body"><p class="muted">値はこのブラウザ内（localStorage）にのみ保存され、外部へは送信されません。
        JSON での書き出し／読み込みは右上「⋯」メニューから行えます。</p></div>
    </div>`;
}
function syncSettingsInputs() {
  $$("[data-param]", dlg).forEach((el) => {
    const k = el.dataset.param;
    if (el.type === "checkbox") el.checked = !!state.params[k];
    else el.value = state.params[k];
  });
}
dlg.addEventListener("change", (ev) => {
  const el = ev.target.closest("[data-param]");
  if (!el) return;
  const k = el.dataset.param;
  if (el.type === "checkbox") state.params[k] = el.checked;
  else {
    const v = parseFloat(el.value);
    if (!isFinite(v)) { el.value = state.params[k]; return; }
    state.params[k] = v;
  }
  saveParams();
  reanalyzeAll();
  scheduleRender(true);
});
$("#btnResetParams").addEventListener("click", () => {
  const before = { ...state.params };
  state.params = { ...DEFAULT_PARAMS };
  saveParams();
  syncSettingsInputs();
  reanalyzeAll();
  renderAll();
  toast("解析パラメータを既定値に戻しました", "取り消し", () => {
    state.params = before;
    saveParams();
    syncSettingsInputs();
    reanalyzeAll();
    renderAll();
  });
});

/* ============================================================================
 * トースト（危ない操作は確認ではなく「取り消し」を用意する）
 * ==========================================================================*/
function toast(message, actionLabel, action) {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (actionLabel) {
    const b = document.createElement("button");
    b.textContent = actionLabel;
    b.addEventListener("click", () => { action(); el.remove(); });
    el.append(b);
  }
  host.append(el);
  setTimeout(() => el.remove(), actionLabel ? 9000 : 4000);
}

/* ============================================================================
 * イベント
 * ==========================================================================*/
const picker = $("#filePicker");
picker.addEventListener("change", () => { addFiles(picker.files); picker.value = ""; });
$("#dzMini").addEventListener("click", () => picker.click());
$("#dzMini").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });

elCta.addEventListener("click", () => {
  const act = elCta.dataset.act;
  if (act === "convert") runConversion();
  else if (act === "zip") downloadZip();
});

elRail.addEventListener("click", (ev) => {
  const b = ev.target.closest(".fileitem");
  if (!b) return;
  state.selectedId = Number(b.dataset.id);
  if (state.view === "summary") state.view = "single";
  state.chartMax = null;
  state.chart.view = null;                 // 別のファイルには前の拡大範囲を持ち込まない
  state.chart.viewSub = null;
  renderAll();
});

/* ---- ステージ／最大化ウィンドウ内のクリック（同じ操作を同じ動きにする） ---- */
function onWorkspaceClick(ev) {
  const hero = ev.target.closest("#dzHero");
  if (hero) { picker.click(); return; }
  const t = ev.target.closest("[data-act],[data-tab],[data-view],[data-sort],[data-open]");
  if (!t) return;
  const e = selected();

  if (t.dataset.view) {
    state.view = t.dataset.view;
    state.chartMax = null;                 // 表示モードを変えたら最大化ウィンドウは閉じる
    scheduleRender(false);
    return;
  }
  if (t.dataset.tab) { state.tab = t.dataset.tab; state.filter = ""; scheduleRender(false); return; }
  if (t.dataset.open) {
    state.selectedId = Number(t.dataset.open);
    state.view = "single";
    state.tab = "analysis";
    state.chart.view = null;
    state.chart.viewSub = null;
    renderAll();
    return;
  }
  if (t.dataset.sort) {
    const k = t.dataset.sort;
    state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: 1 };
    scheduleRender(false);
    return;
  }
  switch (t.dataset.act) {
    case "dl":
      if (e) downloadOutput(e, t.dataset.name);
      break;
    case "dl-summary":
      downloadBytes(csvBytes(summaryCsvText()), `summary_${nowStamp()}.csv`, "text/csv");
      break;
    case "png": {
      const isMain = t.dataset.c === "0";
      const c = isMain ? chartRefs.main : chartRefs.sub;
      if (!c) break;
      c.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((ab) => {
          const suffix = isMain ? `${state.chart.x}_${state.chart.y}` : "time_stress";
          downloadBytes(new Uint8Array(ab), `${e ? e.base : "chart"}_${suffix}.png`, "image/png");
        });
      });
      break;
    }
    /* ── 線図の表示範囲まわり ── */
    case "viewreset":
      if (chartRefs.main) chartRefs.main.resetView();
      break;
    case "nudge": {
      const c = chartRefs.main;
      if (!c) break;
      const d = t.dataset.d;
      c.nudge(d === "xl" ? -0.15 : d === "xr" ? 0.15 : 0, d === "yd" ? -0.15 : d === "yu" ? 0.15 : 0);
      break;
    }
    case "jump": {
      const c = chartRefs.main;
      if (!c || !e || !e.analysis) break;
      if (t.dataset.j === "all") { c.resetView(); break; }
      const K = chartCtx();
      const r = jumpRange(e.analysis, K.x, K.y, t.dataset.j);
      if (r) c.setView(r);
      break;
    }
    case "preset": {
      const p = t.dataset.p;
      state.chart.x = p === "ts" ? "time" : "strain";
      state.chart.y = "stress";
      state.chart.view = null;
      scheduleRender(false);
      break;
    }
    case "ovtoggle":
      state.chart.ovCollapsed = !state.chart.ovCollapsed;
      scheduleRender(false);
      break;
    case "inspect":
      state.tab = "charts";
      state.chartMax = null;
      state.chart.x = "strain";
      state.chart.y = "stress";
      state.chart.view = null;
      state.chart.pendingJump = t.dataset.j;      // 線図を作ってから拡大する
      scheduleRender(false);
      break;
    /* ── 最大化（別ウィンドウで大きく見る） ── */
    case "cmax":
      state.tab = "charts";
      state.chartMax = t.dataset.c === "1" ? "sub" : "main";
      scheduleRender(false);
      break;
    case "cmin":
      state.chartMax = null;
      scheduleRender(false);
      break;
    /* ── レポートモード ── */
    case "rp-title-reset": {
      if (!e) break;
      e.reportTitle = null;
      scheduleRender(false);
      break;
    }
    case "rp-print":
      window.print();
      break;
    case "rp-zoom":
      state.reportZoom = t.dataset.z === "actual" ? "actual" : "fit";
      scheduleRender(false);
      break;
  }
}
elStage.addEventListener("click", onWorkspaceClick);
dlgChart.addEventListener("click", onWorkspaceClick);
dlgChart.addEventListener("close", () => {
  if (!state.chartMax) return;               // 描画側から閉じたときは何もしない（再帰を避ける）
  state.chartMax = null;
  scheduleRender(false);
});

/* ---- ステージ／最大化ウィンドウ内の入力変更 ---- */
function onWorkspaceChange(ev) {
  const t = ev.target.closest("[data-act]");
  if (!t) return;
  const e = selected();
  switch (t.dataset.act) {
    case "areamode": {
      if (!e) return;
      e.areaOverride.mode = t.value;
      if (t.value === "plate") {
        if (e.areaOverride.t == null) e.areaOverride.t = fin(condNum(e.cond, "厚さ")) ? condNum(e.cond, "厚さ") : null;
        if (e.areaOverride.w == null) e.areaOverride.w = fin(condNum(e.cond, "幅")) ? condNum(e.cond, "幅") : null;
      }
      if (t.value === "round" && e.areaOverride.d == null) {
        e.areaOverride.d = fin(condNum(e.cond, "直径")) ? condNum(e.cond, "直径") : null;
      }
      runAnalysis(e); buildOutputs(e); scheduleRender(true);
      break;
    }
    case "areanum": {
      if (!e) return;
      const v = parseFloat(t.value);
      e.areaOverride[t.dataset.k] = isFinite(v) ? v : null;
      runAnalysis(e); buildOutputs(e); scheduleRender(true);
      break;
    }
    case "gauge": {
      const v = parseFloat(t.value);
      if (!isFinite(v) || v <= 0) return;
      state.params.gaugeLength = v;
      saveParams(); syncSettingsInputs(); reanalyzeAll(); scheduleRender(true);
      break;
    }
    case "csvmap": {
      if (!e || !e.csv) return;
      e.csv.map[t.dataset.role] = Number(t.value) < 0 ? null : Number(t.value);
      runAnalysis(e); buildOutputs(e); scheduleRender(true);
      break;
    }
    case "axis":
      state.chart[t.dataset.k] = t.value;
      state.chart.view = null;              // 軸が変われば表示範囲は作り直す
      scheduleRender(false);
      break;
    case "cmark": state.chart.markers = t.checked; scheduleRender(false); break;
    case "cfit": state.chart.fit = t.checked; scheduleRender(false); break;
    case "cside": state.chart.side = t.checked; scheduleRender(false); break;
    case "range": {
      const c = chartRefs.main;
      if (!c) return;
      const auto = c.autoRange();
      if (!auto) return;
      const num = (id, fallback) => {
        const el = cq(id);
        const v = el && el.value !== "" ? parseFloat(el.value) : NaN;
        return isFinite(v) ? v : fallback;   // 空欄はその辺だけ自動値に戻す
      };
      const r = c.range();
      const v = {
        x0: num("#rngXMin", auto.x0), x1: num("#rngXMax", auto.x1),
        y0: num("#rngYMin", auto.y0), y1: num("#rngYMax", auto.y1),
      };
      if (!(v.x1 > v.x0) || !(v.y1 > v.y0)) { setRangeInputs(r); toast("下限より大きい上限を入れてください"); return; }
      c.setView(v);
      break;
    }
    case "rp-title": {
      if (!e) return;
      const v = t.value.trim();
      e.reportTitle = v && v !== defaultReportTitle(e) ? v : null;
      scheduleRender(false);
      break;
    }
  }
}
elStage.addEventListener("change", onWorkspaceChange);
dlgChart.addEventListener("change", onWorkspaceChange);

elStage.addEventListener("input", (ev) => {
  if (ev.target.id === "resFilter") { state.filter = ev.target.value; scheduleRender(false); }
});
/* タブの矢印キー移動 */
elStage.addEventListener("keydown", (ev) => {
  const tab = ev.target.closest('[role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
  const tabs = $$('[role="tab"]:not(:disabled)', elStage);
  const i = tabs.indexOf(tab);
  const next = tabs[(i + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  /* 先にフォーカスを移してからクリックする。描画は次フレームなので、
     renderStage() が同じ id へフォーカスを戻せる。 */
  if (next) { next.focus(); next.click(); }
  ev.preventDefault();
});

/* ---- オーバーフローメニュー ---- */
const menu = $("#moreMenu"), btnMore = $("#btnMore");
btnMore.addEventListener("click", () => {
  const open = menu.hidden;
  menu.hidden = !open;
  btnMore.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (ev) => {
  if (!menu.hidden && !menu.contains(ev.target) && !btnMore.contains(ev.target)) {
    menu.hidden = true;
    btnMore.setAttribute("aria-expanded", "false");
  }
});
menu.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  menu.hidden = true;
  btnMore.setAttribute("aria-expanded", "false");
  switch (b.dataset.act) {
    case "export-settings":
      downloadBytes(new TextEncoder().encode(JSON.stringify(state.params, null, 2)),
        `trapezium_params_${nowStamp()}.json`, "application/json");
      break;
    case "import-settings":
      $("#settingsPicker").click();
      break;
    case "clear-results": {
      const snapshot = state.entries.map((x) => ({ ...x }));
      let n = 0;
      for (const x of state.entries) {
        if (x.status !== "done") continue;
        n++;
        x.status = "queued"; x.outputs = []; x.analysis = null; x.analysisBlock = null; x._waveCsv = null;
      }
      renderAll();
      toast(`${n} 件の変換結果を消しました（入力ファイルは残っています）`, "取り消し", () => {
        state.entries = snapshot;
        renderAll();
      });
      break;
    }
    case "clear-all": {
      const snapshot = state.entries.slice();
      const sel = state.selectedId;
      const n = snapshot.length;
      state.entries = [];
      state.selectedId = null;
      state.view = "single";
      renderAll();
      toast(`${n} 件をすべて削除しました`, "取り消し", () => {
        state.entries = snapshot;
        state.selectedId = sel;
        renderAll();
      });
      break;
    }
  }
});
$("#settingsPicker").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const before = { ...state.params };
    for (const k of Object.keys(DEFAULT_PARAMS)) if (k in obj) state.params[k] = obj[k];
    saveParams(); syncSettingsInputs(); reanalyzeAll(); renderAll();
    toast(`設定を読み込みました（${f.name}）`, "取り消し", () => {
      state.params = before; saveParams(); syncSettingsInputs(); reanalyzeAll(); renderAll();
    });
  } catch (err) {
    toast(`設定を読み込めませんでした: ${err.message}`);
  }
});
$("#btnSettings").addEventListener("click", () => { syncSettingsInputs(); dlg.showModal(); });

/* ---- ドラッグ＆ドロップ（画面全体で受ける） ---- */
const overlay = $("#dropOverlay");
let dragDepth = 0;
const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth++;
  overlay.hidden = false;
  $("#dzMini").classList.add("is-drag");
  const hero = $("#dzHero"); if (hero) hero.classList.add("is-drag");
});
window.addEventListener("dragover", (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
window.addEventListener("dragleave", (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) endDrag();
});
window.addEventListener("drop", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  endDrag();
  addFiles(ev.dataTransfer.files);
});
function endDrag() {
  overlay.hidden = true;
  $("#dzMini").classList.remove("is-drag");
  const hero = $("#dzHero"); if (hero) hero.classList.remove("is-drag");
}

/* ---- 印刷の直前に線図を描き直す（用紙のレイアウトに合わせる） ---- */
window.addEventListener("beforeprint", () => { for (const c of charts) c.draw(); });

/* ---- 配色（ライト/ダーク）切替に線図を追従させる ---- */
const mq = window.matchMedia("(prefers-color-scheme: dark)");
(mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => {
  for (const c of charts) c.draw();
});

/* ============================================================================
 * 起動
 * ==========================================================================*/
loadParams();
buildSettings();
renderAll();
