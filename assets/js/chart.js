/* ============================================================================
 * chart.js — 線図（内蔵 Canvas レンダラ／ズーム・パン・矩形拡大・ミニマップ）
 *
 * 外部ライブラリを使わずに、解析に必要な操作をひと通り持たせている。
 *   ホイール      : 拡大縮小（Shift=X のみ / Alt=Y のみ）
 *   左ドラッグ    : パン
 *   右ドラッグ    : 範囲を囲って拡大
 *   ダブルクリック: 全体表示に戻す
 *   キーボード    : ←→↑↓ でパン、+ − で拡大縮小、0 で全体表示
 * ミニマップ（overview モード）は常に全体を描き、いま見ている範囲を枠で示す。
 * 枠はドラッグで動かせ、枠の外を押すとその位置へ移動する。
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── 目盛り ───────────────── */
function niceTicks(min, max, count) {
  if (!(isFinite(min) && isFinite(max))) return [];
  if (min === max) { min -= 0.5; max += 0.5; }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}
function tickLabel(v, step) {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return v.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* 軸定義（§13.1） */
const AXES = {
  strain:       { label: "ひずみ ε (%)",   short: "ε",   unit: "%",      key: "strain" },
  displacement: { label: "変位 (mm)",      short: "変位", unit: "mm",     key: "displacement" },
  time:         { label: "時間 (sec)",     short: "t",   unit: "sec",    key: "time" },
  stress:       { label: "応力 σ (N/mm²)", short: "σ",   unit: "N/mm²",  key: "stress" },
  force:        { label: "試験力 F (N)",   short: "F",   unit: "N",      key: "force" },
  velocity:     { label: "速度 (mm/min)",  short: "v",   unit: "mm/min", key: "velocity" },
};

const MIN_SPAN_RATIO = 1e-5;      // 元の範囲に対して、これ以上は拡大しない
const MAX_SPAN_RATIO = 50;        // これ以上は縮小しない

class LineChart {
  /**
   * @param {HTMLElement} host  position:relative の入れ物
   * @param {object} opts {interactive, overview, onViewChange, onRequestView}
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.overview = !!opts.overview;
    this.interactive = opts.interactive !== false;
    this.onViewChange = opts.onViewChange || null;   // ズーム/パン後（主図）
    this.onRequestView = opts.onRequestView || null; // 枠の移動要求（ミニマップ）

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    host.appendChild(this.canvas);

    if (!this.overview) {
      this.tip = document.createElement("div");
      this.tip.className = "chart__tip";
      this.tip.hidden = true;
      this.sel = document.createElement("div");
      this.sel.className = "chart__sel";
      this.sel.hidden = true;
      host.append(this.tip, this.sel);
    }

    this.spec = null;
    this.view = null;        // 手動範囲 {x0,x1,y0,y1}。null なら自動
    this.highlight = null;   // ミニマップに描く「いま見ている範囲」
    this.hover = null;
    this.map = null;
    this._drag = null;

    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this._bind();
  }

  destroy() {
    this.ro.disconnect();
    for (const [t, fn, tgt] of this._handlers || []) (tgt || this.canvas).removeEventListener(t, fn);
    this.host.innerHTML = "";
  }

  /* ───────────────── データと表示範囲 ───────────────── */

  setData(spec) {
    this.spec = spec;
    this.hover = null;
    if (this.tip) this.tip.hidden = true;
    this.draw();
  }

  /** 実データ（scale:false を除く）の範囲に 4% のマージンを付けたもの */
  autoRange() {
    if (this._auto && this._autoFor === this.spec) return this._auto;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of (this.spec ? this.spec.series : [])) {
      if (s.scale === false || !s.xs.length) continue;
      for (let i = 0; i < s.xs.length; i++) {
        const x = s.xs[i], y = s.ys[i];
        if (!fin(x) || !fin(y)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (!isFinite(x0)) return null;
    const mx = (x1 - x0) * 0.04 || 1, my = (y1 - y0) * 0.04 || 1;
    this._auto = { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my };
    this._autoFor = this.spec;
    return this._auto;
  }

  /** いま描画に使う範囲 */
  range() {
    return this.view || this.autoRange();
  }

  isZoomed() {
    return !!this.view;
  }

  /** 表示範囲を設定する。行き過ぎた拡大・縮小と、データを見失う移動は抑える。 */
  setView(v, silent) {
    const auto = this.autoRange();
    if (!v || !auto) { this.view = null; }
    else {
      let { x0, x1, y0, y1 } = v;
      if (!(fin(x0) && fin(x1) && fin(y0) && fin(y1)) || x1 <= x0 || y1 <= y0) return;
      const ax = auto.x1 - auto.x0, ay = auto.y1 - auto.y0;
      const sx = x1 - x0, sy = y1 - y0;
      if (sx < ax * MIN_SPAN_RATIO || sy < ay * MIN_SPAN_RATIO) return;
      if (sx > ax * MAX_SPAN_RATIO || sy > ay * MAX_SPAN_RATIO) return;
      // データと全く重ならない位置には行かせない（見失うと戻れないため）
      if (x1 < auto.x0) { const d = auto.x0 - x1 + sx * 0.1; x0 += d; x1 += d; }
      if (x0 > auto.x1) { const d = x0 - auto.x1 + sx * 0.1; x0 -= d; x1 -= d; }
      if (y1 < auto.y0) { const d = auto.y0 - y1 + sy * 0.1; y0 += d; y1 += d; }
      if (y0 > auto.y1) { const d = y0 - auto.y1 + sy * 0.1; y0 -= d; y1 -= d; }
      this.view = { x0, x1, y0, y1 };
    }
    this.draw();
    if (!silent && this.onViewChange) this.onViewChange(this.range(), this.isZoomed());
  }

  resetView(silent) {
    this.view = null;
    this.draw();
    if (!silent && this.onViewChange) this.onViewChange(this.range(), false);
  }

  setHighlight(r) {
    this.highlight = r;
    this.draw();
  }

  /* 画面座標 ⇄ データ座標 */
  valueAtX(px) {
    const r = this.range(), m = this.map;
    if (!r || !m) return NaN;
    return r.x0 + ((px - m.padL) / m.pw) * (r.x1 - r.x0);
  }
  valueAtY(py) {
    const r = this.range(), m = this.map;
    if (!r || !m) return NaN;
    return r.y0 + ((m.padT + m.ph - py) / m.ph) * (r.y1 - r.y0);
  }

  /* ───────────────── 操作 ───────────────── */

  zoomAt(px, py, factor, axis) {
    const r = this.range();
    if (!r) return;
    const xv = this.valueAtX(px), yv = this.valueAtY(py);
    let { x0, x1, y0, y1 } = r;
    if (axis !== "y") { x0 = xv - (xv - x0) * factor; x1 = xv + (x1 - xv) * factor; }
    if (axis !== "x") { y0 = yv - (yv - y0) * factor; y1 = yv + (y1 - yv) * factor; }
    this.setView({ x0, x1, y0, y1 });
  }

  panByPixels(dx, dy) {
    const r = this.range(), m = this.map;
    if (!r || !m) return;
    const vx = (dx / m.pw) * (r.x1 - r.x0);
    const vy = (dy / m.ph) * (r.y1 - r.y0);
    this.setView({ x0: r.x0 - vx, x1: r.x1 - vx, y0: r.y0 + vy, y1: r.y1 + vy });
  }

  /** 割合でスクロール（±15% などのボタン用） */
  nudge(fx, fy) {
    const r = this.range();
    if (!r) return;
    const dx = (r.x1 - r.x0) * fx, dy = (r.y1 - r.y0) * fy;
    this.setView({ x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy });
  }

  zoomToPixelRect(ax, ay, bx, by) {
    const x0 = this.valueAtX(Math.min(ax, bx)), x1 = this.valueAtX(Math.max(ax, bx));
    const y0 = this.valueAtY(Math.max(ay, by)), y1 = this.valueAtY(Math.min(ay, by));
    this.setView({ x0, x1, y0, y1 });
  }

  /** データ座標の矩形へ移動（注目点ジャンプ用） */
  zoomToRange(x0, x1, y0, y1) {
    this.setView({ x0, x1, y0, y1 });
  }

  /* ───────────────── 入力 ───────────────── */

  _bind() {
    this._handlers = [];
    const on = (type, fn, target, opts) => {
      const tgt = target || this.canvas;
      tgt.addEventListener(type, fn, opts);
      this._handlers.push([type, fn, tgt]);
    };
    if (!this.interactive) return;

    if (this.overview) {
      on("mousedown", (e) => this._ovDown(e));
      on("mousemove", (e) => this._ovMove(e), window);
      on("mouseup", () => { this._drag = null; }, window);
      on("wheel", (e) => this._ovWheel(e), null, { passive: false });
      return;
    }

    on("contextmenu", (e) => e.preventDefault());
    on("wheel", (e) => {
      e.preventDefault();
      const p = this._pos(e);
      const axis = e.shiftKey ? "x" : (e.altKey ? "y" : "xy");
      const factor = Math.pow(0.88, -Math.sign(e.deltaY));
      this.zoomAt(p.x, p.y, factor, axis);
    }, null, { passive: false });

    on("mousedown", (e) => {
      const p = this._pos(e);
      if (e.button === 2) {
        e.preventDefault();
        this._drag = { mode: "rect", sx: p.x, sy: p.y, cx: p.x, cy: p.y };
        this._paintSel();
      } else if (e.button === 0) {
        this._drag = { mode: "pan", sx: p.x, sy: p.y, moved: false };
        this.canvas.classList.add("is-panning");
      }
      if (this.tip) this.tip.hidden = true;
    });
    on("mousemove", (e) => {
      if (!this._drag) { this._hover(e); return; }
      const p = this._pos(e);
      if (this._drag.mode === "pan") {
        this.panByPixels(p.x - this._drag.sx, p.y - this._drag.sy);
        this._drag.sx = p.x;
        this._drag.sy = p.y;
        this._drag.moved = true;
      } else {
        this._drag.cx = p.x;
        this._drag.cy = p.y;
        this._paintSel();
      }
    }, window);
    on("mouseup", (e) => {
      const d = this._drag;
      this._drag = null;
      this.canvas.classList.remove("is-panning");
      if (!d) return;
      if (d.mode === "rect") {
        this.sel.hidden = true;
        const p = this._pos(e);
        if (Math.abs(p.x - d.sx) > 8 && Math.abs(p.y - d.sy) > 8) {
          this.zoomToPixelRect(d.sx, d.sy, p.x, p.y);
        }
      }
    }, window);
    on("dblclick", () => this.resetView());
    on("mouseleave", () => {
      this.hover = null;
      if (this.tip) this.tip.hidden = true;
      this.draw();
    });

    /* キーボード（マウスが使えなくても操作できるように） */
    on("keydown", (e) => {
      const step = e.shiftKey ? 0.3 : 0.1;
      const m = this.map;
      if (!m) return;
      const c = { x: m.padL + m.pw / 2, y: m.padT + m.ph / 2 };
      const k = e.key;
      if (k === "ArrowLeft") this.nudge(-step, 0);
      else if (k === "ArrowRight") this.nudge(step, 0);
      else if (k === "ArrowUp") this.nudge(0, step);
      else if (k === "ArrowDown") this.nudge(0, -step);
      else if (k === "+" || k === ";" || k === "=") this.zoomAt(c.x, c.y, 0.8, "xy");
      else if (k === "-") this.zoomAt(c.x, c.y, 1.25, "xy");
      else if (k === "0") this.resetView();
      else return;
      e.preventDefault();
    }, this.host);
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _paintSel() {
    const d = this._drag;
    if (!d || d.mode !== "rect") return;
    Object.assign(this.sel.style, {
      left: Math.min(d.sx, d.cx) + "px",
      top: Math.min(d.sy, d.cy) + "px",
      width: Math.abs(d.cx - d.sx) + "px",
      height: Math.abs(d.cy - d.sy) + "px",
    });
    this.sel.hidden = false;
  }

  _hover(ev) {
    if (!this.spec || !this.map || !this.tip) return;
    const main = this.spec.series.find((s) => s.primary);
    if (!main || !main.xs.length) return;
    const p = this._pos(ev);
    const m = this.map;
    if (p.x < m.padL || p.x > m.padL + m.pw || p.y < m.padT || p.y > m.padT + m.ph) {
      this.hover = null; this.tip.hidden = true; this.draw(); return;
    }
    const r = this.range();
    let best = -1, bestD = Infinity;
    for (let i = 0; i < main.xs.length; i++) {
      const x = main.xs[i], y = main.ys[i];
      if (!fin(x) || !fin(y)) continue;
      if (x < r.x0 || x > r.x1) continue;                 // 表示範囲の点だけを拾う
      const d = Math.abs(m.X(x) - p.x);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 40) { this.hover = null; this.tip.hidden = true; this.draw(); return; }
    this.hover = { x: main.xs[best], y: main.ys[best], i: best };
    this.tip.hidden = false;
    this.tip.textContent =
      `#${best + 1}　${this.spec.xShort} ${fmtNum(main.xs[best], 3)} ${this.spec.xUnit}` +
      `　/　${this.spec.yShort} ${fmtNum(main.ys[best], 2)} ${this.spec.yUnit}`;
    this.tip.style.left = `${m.X(this.hover.x)}px`;
    this.tip.style.top = `${m.Y(this.hover.y) - 10}px`;
    this.draw();
  }

  /* ミニマップの操作 */
  _ovDown(e) {
    if (!this.highlight || !this.map) return;
    const p = this._pos(e);
    const h = this.highlight, m = this.map;
    const inside = p.x >= m.X(h.x0) && p.x <= m.X(h.x1) && p.y >= m.Y(h.y1) && p.y <= m.Y(h.y0);
    if (!inside) this._ovCenterAt(p);                  // 枠の外を押したらそこへ移動
    this._drag = { mode: "ov", px: p.x, py: p.y };
    e.preventDefault();
  }
  _ovMove(e) {
    if (!this._drag || this._drag.mode !== "ov" || !this.highlight) return;
    const p = this._pos(e);
    const m = this.map, r = this.range();
    const dx = ((p.x - this._drag.px) / m.pw) * (r.x1 - r.x0);
    const dy = -((p.y - this._drag.py) / m.ph) * (r.y1 - r.y0);
    this._drag.px = p.x;
    this._drag.py = p.y;
    const h = this.highlight;
    this._request({ x0: h.x0 + dx, x1: h.x1 + dx, y0: h.y0 + dy, y1: h.y1 + dy });
  }
  _ovCenterAt(p) {
    const h = this.highlight;
    if (!h) return;
    const cx = this.valueAtX(p.x), cy = this.valueAtY(p.y);
    const sx = (h.x1 - h.x0) / 2, sy = (h.y1 - h.y0) / 2;
    this._request({ x0: cx - sx, x1: cx + sx, y0: cy - sy, y1: cy + sy });
  }
  _ovWheel(e) {
    if (!this.highlight) return;
    e.preventDefault();
    const h = this.highlight;
    const f = Math.pow(0.88, -Math.sign(e.deltaY));
    const cx = (h.x0 + h.x1) / 2, cy = (h.y0 + h.y1) / 2;
    const sx = (h.x1 - h.x0) / 2 * f, sy = (h.y1 - h.y0) / 2 * f;
    this._request({ x0: cx - sx, x1: cx + sx, y0: cy - sy, y1: cy + sy });
  }
  _request(v) {
    if (this.onRequestView) this.onRequestView(v);
  }

  /* ───────────────── 描画 ───────────────── */

  draw() {
    const spec = this.spec;
    if (!spec) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w < 30 || h < 24) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const fs = cssNum("--chart-fs") || 11;
    ctx.font = `${fs}px ${cssVar("--font")}`;
    const padL = this.overview ? cssNum("--chart-ov-pad-l") : cssNum("--chart-pad-l");
    const padR = cssNum("--chart-pad-r");
    const padT = cssNum("--chart-pad-t");
    const padB = this.overview ? cssNum("--chart-ov-pad-b") : cssNum("--chart-pad-b");
    const pw = w - padL - padR, ph = h - padT - padB;
    if (pw < 16 || ph < 12) return;

    const ink = cssVar("--chart-ink"), grid = cssVar("--chart-grid"), axis = cssVar("--chart-axis");
    const r = this.range();
    if (!r) {
      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.fillText("描画できるデータ点がありません", w / 2, h / 2);
      this.map = null;
      return;
    }
    const X = (v) => padL + ((v - r.x0) / (r.x1 - r.x0)) * pw;
    const Y = (v) => padT + ph - ((v - r.y0) / (r.y1 - r.y0)) * ph;
    this.map = { X, Y, padL, padT, pw, ph };

    /* 直線域などの帯 */
    for (const band of spec.bands || []) {
      if (!fin(band.from) || !fin(band.to)) continue;
      const xa = Math.max(padL, X(band.from)), xb = Math.min(padL + pw, X(band.to));
      if (xb <= xa) continue;
      ctx.fillStyle = cssVar("--chart-band");
      ctx.fillRect(xa, padT, xb - xa, ph);
    }

    /* 目盛りとグリッド */
    const nx = Math.max(2, Math.min(9, Math.round(pw / (this.overview ? 120 : 90))));
    const ny = Math.max(2, Math.min(8, Math.round(ph / (this.overview ? 34 : 46))));
    const xt = niceTicks(r.x0, r.x1, nx);
    const yt = niceTicks(r.y0, r.y1, ny);
    const xs = xt.length > 1 ? xt[1] - xt[0] : 1, ys = yt.length > 1 ? yt[1] - yt[0] : 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    for (const t of xt) { const x = Math.round(X(t)) + 0.5; ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); }
    for (const t of yt) { const y = Math.round(Y(t)) + 0.5; ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); }
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of xt) ctx.fillText(tickLabel(t, xs), X(t), padT + ph + 6);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of yt) ctx.fillText(tickLabel(t, ys), padL - 7, Y(t));

    /* 軸線と軸ラベル（単位つき） */
    ctx.strokeStyle = axis;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT);
    ctx.lineTo(padL + 0.5, padT + ph + 0.5);
    ctx.lineTo(padL + pw, padT + ph + 0.5);
    ctx.stroke();
    if (!this.overview) {
      ctx.fillStyle = ink;
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(spec.xLabel, padL + pw, h - 6);
      ctx.save();
      ctx.translate(11, padT);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(spec.yLabel, 0, 0);
      ctx.restore();
    }

    /* 系列・マーカー */
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, pw, ph);
    ctx.clip();
    for (const s of spec.series) {
      if (this.overview && s.scale === false) continue;      // ミニマップは実データだけ
      this._series(s, X, Y, pw);
    }
    if (!this.overview) {
      for (const m of spec.markers || []) {
        if (!fin(m.x) || !fin(m.y)) continue;
        this._marker(X(m.x), Y(m.y), m.shape, m.color, m.label, fs, m.below);
      }
      if (this.hover) {
        ctx.strokeStyle = axis;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(X(this.hover.x), padT);
        ctx.lineTo(X(this.hover.x), padT + ph);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = cssVar("--chart-line");
        ctx.beginPath();
        ctx.arc(X(this.hover.x), Y(this.hover.y), 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    /* ミニマップ: いま見ている範囲の枠（外側を覆って内側を残す） */
    if (this.overview && this.highlight) {
      const hl = this.highlight;
      const hx0 = Math.max(padL, X(hl.x0)), hx1 = Math.min(padL + pw, X(hl.x1));
      const hy0 = Math.max(padT, Y(hl.y1)), hy1 = Math.min(padT + ph, Y(hl.y0));
      ctx.fillStyle = cssVar("--chart-ov-mask");
      ctx.fillRect(padL, padT, pw, Math.max(0, hy0 - padT));
      ctx.fillRect(padL, hy1, pw, Math.max(0, padT + ph - hy1));
      ctx.fillRect(padL, hy0, Math.max(0, hx0 - padL), Math.max(0, hy1 - hy0));
      ctx.fillRect(hx1, hy0, Math.max(0, padL + pw - hx1), Math.max(0, hy1 - hy0));
      ctx.strokeStyle = cssVar("--chart-ov-border");
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hx0 + 0.5, hy0 + 0.5, Math.max(1, hx1 - hx0 - 1), Math.max(1, hy1 - hy0 - 1));
    }
  }

  _series(s, X, Y, pw) {
    const ctx = this.ctx;
    const n = s.xs.length;
    if (!n) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    ctx.setLineDash(s.dash || []);
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (n > pw * 2) {
      /* 画素列ごとに min/max へ間引く（形は保ったまま高速に描く） */
      let col = -1, mn = 0, mx = 0, first = true, lastX = 0;
      for (let i = 0; i < n; i++) {
        const xv = s.xs[i], yv = s.ys[i];
        if (!fin(xv) || !fin(yv)) continue;
        const px = Math.round(X(xv));
        if (px !== col) {
          if (col >= 0) {
            if (first) { ctx.moveTo(lastX, Y(mn)); first = false; } else ctx.lineTo(lastX, Y(mn));
            ctx.lineTo(lastX, Y(mx));
          }
          col = px; mn = yv; mx = yv; lastX = px;
        } else {
          if (yv < mn) mn = yv;
          if (yv > mx) mx = yv;
        }
      }
      if (col >= 0) {
        if (first) ctx.moveTo(lastX, Y(mn)); else ctx.lineTo(lastX, Y(mn));
        ctx.lineTo(lastX, Y(mx));
      }
    } else {
      let started = false;
      for (let i = 0; i < n; i++) {
        const xv = s.xs[i], yv = s.ys[i];
        if (!fin(xv) || !fin(yv)) { started = false; continue; }
        const px = X(xv), py = Y(yv);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _marker(px, py, shape, color, label, fs, below) {
    const ctx = this.ctx;
    const r = 6;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (shape === "triangle-down") {
      ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py - r); ctx.lineTo(px, py + r * 0.9); ctx.closePath();
      ctx.fillStyle = cssVar("--chart-halo"); ctx.fill(); ctx.stroke();
    } else if (shape === "x") {
      ctx.moveTo(px - r, py - r); ctx.lineTo(px + r, py + r);
      ctx.moveTo(px + r, py - r); ctx.lineTo(px - r, py + r);
      ctx.stroke();
    } else if (shape === "star") {
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * 0.45 : r;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = px + Math.cos(a) * rad, y = py + Math.sin(a) * rad;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(px, py, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (label) {
      ctx.font = `${fs}px ${cssVar("--font")}`;
      const m = this.map;
      const tw = ctx.measureText(label).width;
      /* 作図領域からはみ出す側には置かない（切れて読めなくなるため） */
      let lx = px + r + 3, align = "left";
      if (m && lx + tw > m.padL + m.pw) { lx = px - r - 3; align = "right"; }
      let ly = below ? py + r + 3 : py - 3;
      let baseline = below ? "top" : "bottom";
      if (m && !below && py - r - fs < m.padT) { ly = py + r + 3; baseline = "top"; }
      if (m && below && py + r + fs > m.padT + m.ph) { ly = py - 3; baseline = "bottom"; }
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssVar("--chart-halo");
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly);
    }
    ctx.restore();
  }

  /** PNG 保存用 */
  toBlob(cb) { this.canvas.toBlob(cb); }
}
