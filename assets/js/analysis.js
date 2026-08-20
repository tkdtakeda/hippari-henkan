/* ============================================================================
 * analysis.js — 解析エンジン（§12〜§16）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── 解析パラメータ既定値（§15） ───────────────── */
const DEFAULT_PARAMS = {
  gaugeLength: 50,            // mm   ひずみ算出のゲージ長
  velocityThreshold: 5.0,     // mm/min 速度法耐力の初期閾値
  linearStart_pct: 5,         // %    耐力探索の下限荷重（maxForce 比）
  linearityLo: 0.2,           // −    直線域フィットの応力バンド下限（耐力応力比）
  linearityHi: 0.5,           // −    同上限
  linearityR2Ok: 0.995,       // −    直線性の合格 R²
  linearityR2Warn: 0.990,     // −    直線性の要確認 R²
  fracture_k1: 5,             // −    式① 急落倍率
  fracture_k2: 0.02,          // −    式② 低荷重比
  shimadzuPctOfMaxForce: 30,  // %    島津法の 1 秒あたり荷重低下率
  smoothingWindow: 5,         // 点   速度の移動平均窓
  smoothing: true,
  /* 合格範囲は変換元ファイルから読む（別紙仕様）。下の 3 つは、ファイルから読めない
     入力（CSV 等）のときだけ使う応力増加速度の控え。ほかの項目に控えは置かない。 */
  rampCheck: true,            // ファイルに範囲が無いとき、下の値で応力増加速度を判定するか
  rampMin: 1.5,               // MPa/s
  rampMax: 20.49,             // MPa/s
  auditOut: false,            // 変更履歴 (audit) も出力（vtav のみ）
};
const PARAM_META = [
  { key: "gaugeLength", label: "ゲージ長", unit: "mm", step: "0.1", min: 0.1, group: "ひずみ・速度" },
  { key: "smoothingWindow", label: "速度の移動平均窓", unit: "点", step: "1", min: 1, group: "ひずみ・速度" },
  { key: "velocityThreshold", label: "速度法の初期閾値", unit: "mm/min", step: "0.1", min: 0, group: "耐力（速度法）" },
  { key: "linearStart_pct", label: "耐力探索の下限荷重", unit: "% of Fmax", step: "0.5", min: 0, group: "耐力（速度法）" },
  { key: "linearityLo", label: "直線域バンド下限", unit: "× 耐力応力", step: "0.05", min: 0, group: "直線域・0.2%耐力" },
  { key: "linearityHi", label: "直線域バンド上限", unit: "× 耐力応力", step: "0.05", min: 0, group: "直線域・0.2%耐力" },
  { key: "linearityR2Ok", label: "直線性 合格 R²", unit: "−", step: "0.001", min: 0, max: 1, group: "直線域・0.2%耐力" },
  { key: "linearityR2Warn", label: "直線性 要確認 R²", unit: "−", step: "0.001", min: 0, max: 1, group: "直線域・0.2%耐力" },
  { key: "fracture_k1", label: "式① 急落倍率 k1", unit: "−", step: "0.5", min: 0, group: "破断・伸び" },
  { key: "fracture_k2", label: "式② 低荷重比 k2", unit: "× Fmax", step: "0.005", min: 0, group: "破断・伸び" },
  { key: "shimadzuPctOfMaxForce", label: "島津法 1 秒低下率", unit: "% of Fmax", step: "1", min: 0, group: "破断・伸び" },
  { key: "rampMin", label: "応力増加速度 下限（控え）", unit: "MPa/s", step: "0.01", min: 0, group: "判定" },
  { key: "rampMax", label: "応力増加速度 上限（控え）", unit: "MPa/s", step: "0.01", min: 0, group: "判定" },
];

/* ───────────────── 合否判定の対象と許容範囲 ─────────────────
 * 許容範囲は変換元ファイルの合格範囲レコードから取る（別紙仕様）。
 * scale はファイルの単位を画面の単位に合わせる係数（ヤング率は GPa → N/mm²）。
 */
const JUDGE_SPECS = [
  { key: "ramp",  label: "応力増加速度",       unit: "MPa/s",  scale: 1,
    value: (A) => (A.rampRate ? A.rampRate.value : NaN),      fmt: (v) => fmtNum(v, 2),
    fb: { on: "rampCheck", lo: "rampMin", hi: "rampMax" } },
  { key: "srate", label: "ひずみ速度",         unit: "s⁻¹",    scale: 1,
    value: (A) => (A.strainRate1 ? A.strainRate1.value : NaN), fmt: (v) => fmtExp(v, 2) },
  { key: "cross", label: "実績クロス変位速度", unit: "mm/min", scale: 1,
    value: (A) => A.vCross,                                    fmt: (v) => fmtNum(v, 2) },
  { key: "young", label: "弾性率",             unit: "N/mm²",  scale: 1000,
    value: (A) => (A.youngs ? A.youngs.nmm2 : NaN),             fmt: (v) => fmtNum(v, 0) },
];

/**
 * 合否判定に使う許容範囲を決める。変換元ファイルの合格範囲を最優先し、
 * ファイルに無いときだけ控え（設定値・いまは応力増加速度のみ）を使う。
 * 解析ができなかったファイルでもレポートから呼べるよう、関数として切り出している。
 */
function resolveJudgeRanges(fileRanges, P) {
  const R = fileRanges || {};
  const out = {};
  for (const spec of JUDGE_SPECS) {
    const f = R[spec.key];
    if (f && fin(f.lo) && fin(f.hi)) {
      out[spec.key] = {
        lo: f.lo * spec.scale, hi: f.hi * spec.scale, src: "file",
        label: f.label, fileLo: f.lo, fileHi: f.hi, fileUnit: f.unit,
      };
    } else if (spec.fb && P[spec.fb.on] && fin(P[spec.fb.lo]) && fin(P[spec.fb.hi])) {
      out[spec.key] = { lo: P[spec.fb.lo], hi: P[spec.fb.hi], src: "params" };
    } else {
      out[spec.key] = null;
    }
  }
  return out;
}

/**
 * 値を許容範囲と突き合わせる（レポートの合否判定と判定バナーで共用）。
 * 範囲が設定されていない・値が算出できていないときは「判定なし」を返す。
 */
function rangeCheck(value, lo, hi) {
  if (!fin(lo) || !fin(hi) || !(hi > lo)) return { level: "na", label: "範囲未設定" };
  if (!fin(value)) return { level: "na", label: "判定不可" };
  return (value >= lo && value <= hi)
    ? { level: "ok", label: "合格" }
    : { level: "ng", label: "不合格" };
}

/* ───────────────── 数値ユーティリティ ───────────────── */
function median(arr) {
  const a = arr.filter(fin).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/** 最小二乗フィット（idxs で指定した点のみ） */
function lsqFit(xs, ys, idxs) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const i of idxs) {
    const x = xs[i], y = ys[i];
    if (!fin(x) || !fin(y)) continue;
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  if (n < 2) return null;
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  const r2 = den > 0 ? (num / den) ** 2 : NaN;
  return { slope, intercept, r2, n };
}
function movingAverage(src, win) {
  const n = src.length;
  if (!(win > 1) || n === 0) return src;
  const half = Math.floor(win / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k < 0 || k >= n) continue;
      const v = src[k];
      if (!fin(v)) continue;
      s += v; c++;
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/* ───────────────── 解析エンジン（§12〜§14） ───────────────── */
/**
 * @param inp {time,force,stress,displacement,stroke: Float64Array|null, area, areaBasis, stressSource}
 * @param P   解析パラメータ
 */
function analyze(inp, P) {
  const force = inp.force;
  const n = force ? force.length : 0;
  const A = {
    ok: false, n, blocked: [], series: {}, basis: {},
  };
  if (!force || n < 5) {
    A.reason = "試験力の点数が 5 点未満のため、解析できません";
    return A;
  }

  /* --- 12.1 ひずみ ε [%] --- */
  let strain = null;
  if (inp.displacement) {
    strain = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = inp.displacement[i];
      strain[i] = fin(d) ? (d / P.gaugeLength) * 100 : NaN;
    }
    A.basis.strain = `ε = 変位計 ÷ ゲージ長 ${fmtNum(P.gaugeLength, 1)} mm × 100`;
  } else {
    A.blocked.push({ what: "ひずみ ε", why: "変位（伸び計）データが無いため算出できません" });
  }

  /* --- 応力 σ（§11.2：入力経路で取得方法が変わる） --- */
  let stress = null;
  if (inp.stress) {
    stress = inp.stress;
    A.basis.stress = inp.stressSource || "入力の応力列をそのまま使用（換算なし）";
  } else if (fin(inp.area) && inp.area > 0) {
    stress = new Float64Array(n);
    for (let i = 0; i < n; i++) stress[i] = fin(force[i]) ? force[i] / inp.area : NaN;
    A.basis.stress = `σ = 試験力 ÷ 断面積 A（A = ${fmtNum(inp.area, 3)} mm²）／${inp.areaBasis || "断面積は手入力"}`;
  } else {
    A.blocked.push({ what: "応力 σ", why: "断面積 A が未確定です（試験条件に寸法が無いため、解析タブで A または 厚さ・幅・直径 を入力してください）" });
  }

  /* --- 12.2 速度 v [mm/min] --- */
  let velocity = null;
  if (inp.time && inp.stroke) {
    const raw = new Float64Array(n);
    raw.fill(NaN);
    for (let i = 1; i < n; i++) {
      const dt = inp.time[i] - inp.time[i - 1];
      if (!(dt > 0) || !fin(inp.stroke[i]) || !fin(inp.stroke[i - 1])) continue;
      raw[i] = ((inp.stroke[i] - inp.stroke[i - 1]) / dt) * 60;
    }
    if (n > 1) raw[0] = raw[1];
    velocity = P.smoothing ? movingAverage(raw, P.smoothingWindow) : raw;
    A.basis.velocity = `v = Δストローク ÷ Δ時間 × 60` +
      (P.smoothing ? `／移動平均 ${P.smoothingWindow} 点で平滑化` : "／平滑化なし");
  } else {
    A.blocked.push({
      what: "速度 v",
      why: `${!inp.time ? "時間" : "ストローク"}データが無いため算出できません`,
    });
  }

  /* ストローク基準のひずみ。伸び計が破断で止まったときでも試験の最後まで追える。
     機械のたわみを含むので、規格上のひずみ（伸び計基準）とは別物として扱う。 */
  let strainStroke = null;
  if (inp.stroke) {
    strainStroke = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = inp.stroke[i];
      strainStroke[i] = fin(v) ? (v / P.gaugeLength) * 100 : NaN;
    }
    A.basis.strainStroke = `εst = ストローク ÷ ゲージ長 ${fmtNum(P.gaugeLength, 1)} mm × 100（機械のたわみを含む参考値）`;
  }

  A.series = { time: inp.time, force, stroke: inp.stroke, displacement: inp.displacement,
               strain, strainStroke, stress, velocity };

  /* --- 14.1 引張強さ Rm（最大試験力に対応する応力） --- */
  let maxIndex = 0, maxForce = -Infinity;
  for (let i = 0; i < n; i++) if (fin(force[i]) && force[i] > maxForce) { maxForce = force[i]; maxIndex = i; }
  A.max = { index: maxIndex, force: maxForce };
  if (stress) {
    A.rm = {
      value: stress[maxIndex], index: maxIndex, force: maxForce,
      strain: strain ? strain[maxIndex] : NaN,
      basis: `最大試験力 ${fmtNum(maxForce, 1)} N（第 ${maxIndex + 1} 点）に対応する応力`,
    };
  } else {
    A.rm = null;
  }

  /* --- 14.2 耐力①: 速度法（降伏点検出） --- */
  if (velocity && fin(maxForce)) {
    const band = [];
    for (let i = 0; i < n; i++) {
      if (!fin(force[i]) || !fin(velocity[i])) continue;
      if (force[i] >= 0.05 * maxForce && force[i] <= 0.30 * maxForce) band.push(velocity[i]);
    }
    const vBase = median(band);
    /* 弾性域の基準速度。実績クロスヘッド変位速度として報告・判定に使う */
    A.vBase = fin(vBase) ? vBase : NaN;
    A.vBaseBasis = fin(vBase)
      ? `試験力が Fmax の 5〜30% にある区間の速度の中央値（${A.basis.velocity || "速度から算出"}）`
      : "";
    let thr = P.velocityThreshold, thrWhy = `設定値 ${fmtNum(P.velocityThreshold, 1)} mm/min`;
    if (vBase >= 2.7 && vBase <= 3.3) { thr = 3.3; thrWhy = `弾性域の基準速度 ${fmtNum(vBase, 2)} mm/min → 試験速度 3 mm/min と判定`; }
    else if (vBase >= 5.4 && vBase <= 6.6) { thr = 6.6; thrWhy = `弾性域の基準速度 ${fmtNum(vBase, 2)} mm/min → 試験速度 6 mm/min と判定`; }
    const forceFloor = maxForce * (P.linearStart_pct / 100);
    let idx = -1;
    for (let i = 0; i < n; i++) {
      if (!fin(force[i]) || !fin(velocity[i])) continue;
      if (force[i] >= forceFloor && velocity[i] > thr) { idx = i; break; }
    }
    if (idx >= 0) {
      A.yieldV = {
        index: idx, force: force[idx], velocity: velocity[idx], threshold: thr, vBase,
        strain: strain ? strain[idx] : NaN,
        stress: stress ? stress[idx] : NaN,
        basis: `速度が閾値 ${fmtNum(thr, 2)} mm/min を最初に超えた第 ${idx + 1} 点（${thrWhy}／下限荷重 ${fmtNum(forceFloor, 0)} N ＝ Fmax の ${fmtNum(P.linearStart_pct, 0)}%）`,
      };
    } else {
      A.yieldV = null;
      A.blocked.push({ what: "耐力（速度法）", why: `速度が閾値 ${fmtNum(thr, 2)} mm/min を超える点が見つかりません（基準速度 ${fin(vBase) ? fmtNum(vBase, 2) + " mm/min" : "算出不可"}）` });
    }
  } else {
    A.yieldV = null;
    A.vBase = NaN;
    A.vBaseBasis = "";
    A.blocked.push({ what: "耐力（速度法）", why: "速度（時間・ストローク）が無いため検出できません" });
  }

  /* --- 14.3 前提: 弾性直線域と勾配 slope --- */
  A.linear = null;
  if (stress && strain) {
    let base, baseWhy;
    if (A.yieldV && fin(A.yieldV.stress)) {
      base = A.yieldV.stress;
      baseWhy = `耐力（速度法）の応力 ${fmtNum(base, 1)} N/mm² を基準`;
    } else if (A.rm && fin(A.rm.value)) {
      base = A.rm.value * 0.8;
      baseWhy = `耐力（速度法）が無いため 引張強さ Rm × 0.8 = ${fmtNum(base, 1)} N/mm² を代替基準に使用`;
    } else {
      base = NaN; baseWhy = "";
    }
    if (fin(base)) {
      const lo = base * P.linearityLo, hi = base * P.linearityHi;
      const cand = [];
      const limit = A.yieldV ? A.yieldV.index : maxIndex;
      for (let i = 0; i <= limit && i < n; i++) {
        if (!fin(strain[i]) || !fin(stress[i])) continue;
        if (stress[i] >= lo && stress[i] <= hi) cand.push(i);
      }
      if (cand.length >= 5) {
        // 降伏開始側（高応力側）の非直線点を、R² が合格域に入るまで切り落として cutoff を決める
        let use = cand.slice();
        let fit = lsqFit(strain, stress, use);
        const minKeep = Math.max(5, Math.floor(cand.length * 0.5));
        let trimmed = 0;
        while (fit && fit.r2 < P.linearityR2Ok && use.length > minKeep) {
          use = use.slice(0, use.length - 1);
          trimmed++;
          fit = lsqFit(strain, stress, use);
        }
        if (fit) {
          const s0 = use[0], s1 = use[use.length - 1];
          A.linear = {
            startIdx: s0, cutoffIdx: s1, slope: fit.slope, intercept: fit.intercept, r2: fit.r2,
            nPoints: fit.n, trimmed,
            strainFrom: strain[s0], strainTo: strain[s1],
            basis: `${baseWhy}／応力バンド ${fmtNum(lo, 1)}〜${fmtNum(hi, 1)} N/mm²（× ${P.linearityLo}〜${P.linearityHi}）内の ${fit.n} 点で最小二乗フィット` +
                   (trimmed ? `／非直線の ${trimmed} 点を高応力側から除外` : ""),
            fallback: !(A.yieldV && fin(A.yieldV.stress)),
          };
          A.youngs = { nmm2: fit.slope * 100, gpa: (fit.slope * 100) / 1000 };
        }
      } else {
        A.blocked.push({ what: "弾性勾配・0.2%耐力", why: `直線域バンド内の点が ${cand.length} 点しかありません（5 点以上必要）` });
      }
    } else {
      A.blocked.push({ what: "弾性勾配・0.2%耐力", why: "基準となる耐力応力・引張強さのいずれも算出できません" });
    }
  } else if (!A.blocked.some((b) => b.what === "応力 σ" || b.what === "ひずみ ε")) {
    A.blocked.push({ what: "弾性勾配・0.2%耐力", why: "ひずみ・応力が揃っていません" });
  }

  /* --- 14.3 0.2% オフセット耐力 --- */
  A.offset02 = null;
  if (A.linear && strain && stress) {
    const { slope } = A.linear;
    const line = (e) => slope * (e - 0.2);
    let found = null, bestAbs = Infinity, bestIdx = -1;
    let prevIdx = -1;
    for (let i = 0; i <= maxIndex; i++) {
      if (!fin(strain[i]) || !fin(stress[i])) continue;
      if (strain[i] <= 0.2) { prevIdx = i; continue; }
      const diff = stress[i] - line(strain[i]);
      if (Math.abs(diff) < bestAbs) { bestAbs = Math.abs(diff); bestIdx = i; }
      if (prevIdx >= 0) {
        const dPrev = stress[prevIdx] - line(strain[prevIdx]);
        if (dPrev > 0 && diff <= 0) {                      // 正 → 0 以下 に変わった点が交点
          const pick = Math.abs(dPrev) <= Math.abs(diff) ? prevIdx : i;
          found = { index: pick, strain: strain[pick], stress: stress[pick], approx: false };
          break;
        }
      }
      prevIdx = i;
    }
    if (!found && bestIdx >= 0) {
      found = { index: bestIdx, strain: strain[bestIdx], stress: stress[bestIdx], approx: true };
    }
    if (found) {
      found.basis = `オフセット線 σ = ${fmtNum(A.linear.slope, 1)} × (ε − 0.2) との` +
        (found.approx ? "差が最小の点（交差が見つからないため近似採用）" : `交点（第 ${found.index + 1} 点）`);
      A.offset02 = found;
    }
  }

  /* --- 14.4 伸び（破断ひずみ）方式A: 式①→② --- */
  A.fractureA = null;
  {
    const k1 = P.fracture_k1, k2 = P.fracture_k2;
    let dropStart = -1;
    for (let i = maxIndex + 1; i < n - 1; i++) {
      const d1 = Math.abs(force[i] - force[i - 1]);
      const d2 = Math.abs(force[i + 1] - force[i]);
      if (d1 > maxForce * 0.0005 && d2 > k1 * d1) { dropStart = i; break; }
    }
    const searchStart = dropStart >= 0 ? dropStart : maxIndex;
    let fr = -1;
    for (let i = searchStart; i < n - 1; i++) {
      if (force[i + 1] < k2 * maxForce) { fr = i; break; }
    }
    if (fr >= 0) {
      A.fractureA = {
        index: fr, strain: strain ? strain[fr] : NaN, stress: stress ? stress[fr] : NaN,
        dropStart,
        basis: `式①（急落開始）${dropStart >= 0 ? `第 ${dropStart + 1} 点` : "検出なし → 最大点から探索"}` +
               `／式②（試験力が Fmax の ${fmtNum(k2 * 100, 1)}% 未満）第 ${fr + 1} 点`,
      };
    } else {
      A.blocked.push({ what: "伸び（式①→②法）", why: `試験力が Fmax の ${fmtNum(k2 * 100, 1)}% 未満に下がる点がありません（破断まで記録されていない可能性）` });
    }
  }

  /* --- 14.4 方式B: 島津法（1 秒間の荷重低下率） --- */
  A.fractureB = null;
  if (inp.time) {
    const dts = [];
    for (let i = 1; i < n; i++) {
      const d = inp.time[i] - inp.time[i - 1];
      if (d > 0) dts.push(d);
    }
    let dt = median(dts);
    if (!fin(dt) || dt <= 0) dt = 0.05;
    const steps = Math.max(1, Math.round(1 / dt));
    const threshold = maxForce * (P.shimadzuPctOfMaxForce / 100);
    let fr = -1;
    for (let i = maxIndex; i + steps < n; i++) {
      if (force[i] - force[i + steps] >= threshold) { fr = i; break; }
    }
    if (fr >= 0) {
      A.fractureB = {
        index: fr, strain: strain ? strain[fr] : NaN, stress: stress ? stress[fr] : NaN,
        steps, dt, threshold,
        basis: `サンプリング周期 ${fmtNum(dt, 4)} s（${steps} 点＝1 秒）で試験力が ${fmtNum(threshold, 0)} N（Fmax の ${fmtNum(P.shimadzuPctOfMaxForce, 0)}%）以上低下した第 ${fr + 1} 点`,
      };
    } else {
      A.blocked.push({ what: "伸び（島津法）", why: `1 秒間に Fmax の ${fmtNum(P.shimadzuPctOfMaxForce, 0)}% 以上低下する区間がありません` });
    }
  } else {
    A.blocked.push({ what: "伸び（島津法）", why: "時間データが無いため 1 秒間の低下率を評価できません" });
  }

  /* 伸び ＝ 変換元ファイルに記録された 破断点_変位(ひずみ) を真値として採る。
     波形からの計算値（式①→②法／島津法）は参考で、破断記録の有無や丸めで数 pt ずれるため、
     ファイル記録値がある限りそちらを使う（レポートの表と解析カードを一致させる）。
     ファイルに値が無いときだけ、検出した破断点のひずみへ落とす（方式A 優先）。 */
  A.elongation = null;
  const frMain = A.fractureA || A.fractureB;
  if (inp.fileElong && fin(inp.fileElong.value)) {
    A.elongation = {
      value: inp.fileElong.value, src: "file",
      method: "変換元ファイルの記録値",
      index: frMain ? frMain.index : null,
      basis: `「${inp.fileElong.label}」（装置が出した答え）`,
    };
  } else if (frMain && strain && fin(frMain.strain)) {
    A.elongation = {
      value: frMain.strain, src: "calc",
      method: A.fractureA ? "式①→②法" : "島津法",
      index: frMain.index, basis: frMain.basis,
    };
  } else if (frMain && !strain) {
    A.blocked.push({ what: "伸び", why: "破断点は検出できましたが、ひずみが無いため伸びを算出できません" });
  }

  /* --- 14.5 応力増加速度 [MPa/s] --- */
  A.rampRate = null;
  if (A.linear && inp.time && stress) {
    const idxs = [];
    for (let i = A.linear.startIdx; i <= A.linear.cutoffIdx; i++) idxs.push(i);
    const fit = lsqFit(inp.time, stress, idxs);
    if (fit) {
      A.rampRate = {
        value: fit.slope, r2: fit.r2, nPoints: fit.n,
        basis: `直線域（第 ${A.linear.startIdx + 1}〜${A.linear.cutoffIdx + 1} 点・${fit.n} 点）の 時間 vs 応力 最小二乗傾き`,
      };
    }
  } else if (!inp.time) {
    A.blocked.push({ what: "応力増加速度", why: "時間データが無いため算出できません" });
  }

  /* --- 14.6 参考: ひずみ速度①（弾性）②（塑性） --- */
  A.strainRate1 = null;
  A.strainRate2 = null;
  if (inp.time && strain) {
    if (A.linear) {
      const idxs = [];
      for (let i = A.linear.startIdx; i <= A.linear.cutoffIdx; i++) idxs.push(i);
      const f = lsqFit(inp.time, strain, idxs);
      if (f) A.strainRate1 = { value: f.slope / 100, nPoints: f.n, basis: `直線域 ${f.n} 点の 時間 vs ひずみ(%) 傾き ÷ 100` };
    }
    const yi = A.yieldV ? A.yieldV.index : null;
    const fi = frMain ? frMain.index : null;
    if (yi != null && fi != null && fi > yi + 2) {
      const idxs = [];
      for (let i = yi; i <= fi; i++) idxs.push(i);
      const f = lsqFit(inp.time, strain, idxs);
      if (f) A.strainRate2 = { value: f.slope / 100, nPoints: f.n, basis: `耐力点〜破断点 ${f.n} 点の 時間 vs ひずみ(%) 傾き ÷ 100` };
    }
  }

  /* --- 実績クロスヘッド変位速度 ---
     弾性域内に取った中間点 2 点の間の平均クロスヘッド速度。
       (中間点1_クロスヘッド − 中間点2_クロスヘッド) ÷ (中間点1_時間 − 中間点2_時間) × 60
     中間点は降伏前の応力レベルで決める（＝直線域の両端。応力バンド linearityLo〜Hi × 耐力応力）。
     塑性域・破断後は含めない。弾性負荷速度の適合確認に使う値で、試験全体の平均速度ではない。 */
  A.vCross = NaN;
  A.vCrossBasis = "";
  if (A.linear && inp.time && inp.stroke) {
    const i1 = A.linear.startIdx, i2 = A.linear.cutoffIdx;
    const dt = inp.time[i2] - inp.time[i1];
    const ds = inp.stroke[i2] - inp.stroke[i1];
    if (fin(dt) && dt > 0 && fin(ds)) {
      A.vCross = (ds / dt) * 60;
      A.vCrossBasis = `弾性域の中間点 2 点（第 ${i1 + 1} 点・第 ${i2 + 1} 点` +
        (stress ? `／応力 ${fmtNum(stress[i1], 1)} → ${fmtNum(stress[i2], 1)} N/mm²` : "") +
        `）の (Δクロスヘッド ${fmtNum(ds, 4)} mm ÷ Δ時間 ${fmtNum(dt, 3)} s) × 60`;
    }
  }
  if (!fin(A.vCross)) {
    A.blocked.push({
      what: "実績クロス変位速度",
      why: !inp.stroke ? "ストロークデータが無いため算出できません"
        : !inp.time ? "時間データが無いため算出できません"
        : "弾性域（直線域）が決まらないため中間点 2 点を取れません",
    });
  }

  /* --- 合否判定に使う許容範囲を決める（ファイル優先・控えは応力増加速度のみ） --- */
  A.judge = resolveJudgeRanges(inp.ranges, P);

  A.ok = !!(A.rm || A.elongation);

  /* --- 判定（§16.1）：色だけでなく必ず理由を文字で持たせる --- */
  const checks = [];
  if (A.linear) {
    const r2 = A.linear.r2;
    const lv = r2 >= P.linearityR2Ok ? "ok" : (r2 >= P.linearityR2Warn ? "warn" : "ng");
    checks.push({
      level: lv, label: "弾性直線域の直線性",
      detail: `R² = ${r2.toFixed(5)}（合格 ≥ ${P.linearityR2Ok} / 要確認 ≥ ${P.linearityR2Warn}）・${A.linear.nPoints} 点`,
    });
  } else {
    checks.push({ level: "na", label: "弾性直線域の直線性", detail: "直線域を決定できないため未評価" });
  }
  /* 合格範囲を持つ項目は、その範囲との突き合わせで合否を出す（レポートの合否判定と同じ）。
   *
   * 判定に使う測定値は、変換元ファイルが記録している値（inp.judgeValues＝レポートの表と
   * 同じ値）。装置側で設定していない項目はファイルに値が無いので、**判定しない**。
   * ここで計算値へ落とすと、設定していない項目を勝手に見て「不合格」にしてしまう。
   * 記録値を持たない CSV 入力だけは、解析の計算値で判定する（それしか測定値が無いため）。
   */
  const useFileValues = !!inp.judgeValues;
  for (const spec of JUDGE_SPECS) {
    const jr = A.judge[spec.key];
    if (!jr) continue;
    const v = useFileValues ? inp.judgeValues[spec.key] : spec.value(A);
    const where = jr.src === "file" ? `変換元ファイルの「${jr.label}」` : "設定値（控え）";
    const band = `許容範囲 ${spec.fmt(jr.lo)}〜${spec.fmt(jr.hi)} ${spec.unit}／${where}`;
    if (!fin(v)) {
      /* 判定しない。skip を立てて、全体の合否にも効かせない。 */
      checks.push({
        level: "na", skip: true, label: spec.label,
        detail: `${useFileValues ? "変換元ファイルに測定値が無いため" : "測定値を算出できないため"}判定しません（${band}）`,
      });
      continue;
    }
    const r = rangeCheck(v, jr.lo, jr.hi);
    checks.push({
      level: r.level, label: spec.label,
      detail: `${spec.fmt(v)} ${spec.unit}（${band}）`,
    });
  }
  const missing = [];
  if (!A.rm) missing.push("引張強さ Rm");
  if (!A.yieldV) missing.push("耐力（速度法）");
  if (!A.offset02) missing.push("0.2% 耐力");
  if (!A.elongation) missing.push("伸び");
  checks.push({
    level: missing.length === 0 ? "ok" : (missing.length >= 3 ? "ng" : "warn"),
    label: "主要値の算出",
    detail: missing.length === 0 ? "引張強さ・耐力・0.2%耐力・伸びをすべて算出" : `未算出: ${missing.join(" / ")}`,
  });
  const rank = { ok: 0, warn: 1, ng: 2, na: 1 };
  let worst = "ok";
  /* skip = 判定していない項目。合否を左右させない（未設定の項目で落とさないため） */
  for (const c of checks) if (!c.skip && rank[c.level] > rank[worst]) worst = c.level === "na" ? "warn" : c.level;
  A.verdict = {
    level: A.ok ? worst : "na",
    label: !A.ok ? "解析なし" : worst === "ok" ? "合格" : worst === "warn" ? "要確認" : "不合格",
    checks,
  };
  return A;
}

/* ───────────────── 解析結果の行データ（画面・CSV 共用） ───────────────── */
function analysisRows(A) {
  if (!A) return [];
  const rows = [];
  const add = (item, value, unit, basis) => rows.push({ item, value, unit, basis });
  add("引張強さ Rm", A.rm ? fmtNum(A.rm.value, 1) : "", "N/mm2", A.rm ? A.rm.basis : "算出不可");
  add("最大試験力 Fm", fin(A.max?.force) ? fmtNum(A.max.force, 1) : "", "N", A.max ? `第 ${A.max.index + 1} 点` : "");
  add("耐力（速度法）", A.yieldV && fin(A.yieldV.stress) ? fmtNum(A.yieldV.stress, 1) : "", "N/mm2", A.yieldV ? A.yieldV.basis : "算出不可");
  add("0.2% 耐力", A.offset02 ? fmtNum(A.offset02.stress, 1) : "", "N/mm2", A.offset02 ? A.offset02.basis : "算出不可");
  add("伸び（破断ひずみ）", A.elongation ? fmtNum(A.elongation.value, 2) : "", "%", A.elongation ? `${A.elongation.method}／${A.elongation.basis}` : "算出不可");
  add("伸び（島津法）", A.fractureB && fin(A.fractureB.strain) ? fmtNum(A.fractureB.strain, 2) : "", "%", A.fractureB ? A.fractureB.basis : "算出不可");
  add("応力増加速度", A.rampRate ? fmtNum(A.rampRate.value, 2) : "", "MPa/s", A.rampRate ? A.rampRate.basis : "算出不可");
  add("ヤング率 E", A.youngs ? fmtNum(A.youngs.nmm2, 0) : "", "N/mm2", A.linear ? `弾性勾配 ${fmtNum(A.linear.slope, 2)} (N/mm² per ε%) × 100` : "算出不可");
  add("ヤング率 E", A.youngs ? fmtNum(A.youngs.gpa, 1) : "", "GPa", A.youngs ? "N/mm² を 1/1000 して換算" : "算出不可");
  add("ひずみ速度①（弾性）", A.strainRate1 ? A.strainRate1.value.toExponential(3) : "", "/sec", A.strainRate1 ? A.strainRate1.basis : "算出不可");
  add("ひずみ速度②（塑性）", A.strainRate2 ? A.strainRate2.value.toExponential(3) : "", "/sec", A.strainRate2 ? A.strainRate2.basis : "算出不可");
  add("直線性 R²", A.linear ? A.linear.r2.toFixed(5) : "", "−", A.linear ? A.linear.basis : "算出不可");
  add("判定", A.verdict ? A.verdict.label : "", "−", A.verdict ? A.verdict.checks.map((c) => `${c.label}: ${c.detail}`).join(" / ") : "");
  return rows;
}
