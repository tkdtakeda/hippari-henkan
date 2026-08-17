/* ============================================================================
 * binary.js — バイナリ小道具と TLV 文字列トークン抽出（仕様 §4）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────────────── バイナリ小道具 ───────────────────────── */

/* CRC-32（ZIP 用 ＋ 入力ファイルの照合値表示用） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");

/** バイト列 needle の最初の出現位置（見つからなければ -1） */
function findBytes(hay, needle, from = 0) {
  const n = needle.length, end = hay.length - n;
  if (n === 0) return from;
  const first = needle[0];
  outer: for (let i = from; i <= end; i++) {
    if (hay[i] !== first) continue;
    for (let k = 1; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}
/** 非重複で全出現位置（Python の re.finditer 相当） */
function findAllBytes(hay, needle) {
  const out = [];
  let i = 0;
  for (;;) {
    const p = findBytes(hay, needle, i);
    if (p < 0) break;
    out.push(p);
    i = p + needle.length;
  }
  return out;
}
const isDigit = (b) => b >= 0x30 && b <= 0x39;

/** バイト列から `\d{4}/\d{2}/\d{2} \d{1,2}:\d{2}:\d{2}` の最初の位置（無ければ -1） */
function findDateTimeOffset(d) {
  const n = d.length;
  for (let i = 0; i + 17 <= n; i++) {
    if (!(isDigit(d[i]) && isDigit(d[i + 1]) && isDigit(d[i + 2]) && isDigit(d[i + 3]))) continue;
    if (d[i + 4] !== 0x2F || !isDigit(d[i + 5]) || !isDigit(d[i + 6])) continue;
    if (d[i + 7] !== 0x2F || !isDigit(d[i + 8]) || !isDigit(d[i + 9])) continue;
    if (d[i + 10] !== 0x20) continue;
    let j = i + 11;
    if (!isDigit(d[j])) continue;
    j++;
    if (isDigit(d[j])) j++;                       // 時は 1〜2 桁
    if (d[j] !== 0x3A || !isDigit(d[j + 1]) || !isDigit(d[j + 2])) continue;
    j += 3;
    if (d[j] !== 0x3A || !isDigit(d[j + 1]) || !isDigit(d[j + 2])) continue;
    return i;
  }
  return -1;
}

/* ───────────────── TLV 文字列トークン抽出（仕様 §4） ───────────────── */

const DEC_U16LE = new TextDecoder("utf-16le", { fatal: true });
const DEC_U8    = new TextDecoder("utf-8",    { fatal: true });

/* §4.1 許可文字クラス（完全一致） */
const CLEAN_RE = /^[　-ヿ一-鿿＀-￯々ー_A-Za-z0-9\/%.^+\-()\[\] :×]+$/;

/**
 * §4.1 xtux 文字列（UTF-16LE, [0x3E][長さ(byte,偶数)][値]）
 * 高速化のため、TextDecoder を呼ぶ前にコードユニットを直接検査する
 * （不正なものはここで落ちるので例外コストが乗らない。判定結果は Python 版と等価）。
 */
function walkXtuxStrings(data, marker = 0x3E) {
  const out = [];
  const n = data.length;
  let i = 0;
  while (i < n - 1) {
    if (data[i] === marker) {
      const L = data[i + 1];
      if (L >= 2 && L <= 254 && (L & 1) === 0 && i + 2 + L <= n) {
        const start = i + 2;
        let ok = true;
        for (let k = 0; k < L; k += 2) {
          const u = data[start + k] | (data[start + k + 1] << 8);
          // 制御文字（\n \r \t 以外）/ 非文字 / サロゲートは不採用
          if (!(u >= 0x20 || u === 0x0A || u === 0x0D || u === 0x09)) { ok = false; break; }
          if (u === 0xFFFE || u === 0xFFFF || (u >= 0xD800 && u <= 0xDFFF)) { ok = false; break; }
        }
        if (ok) {
          let s = null;
          try { s = DEC_U16LE.decode(data.subarray(start, start + L)); } catch (_) { s = null; }
          if (s !== null) {
            // ★ラベルには表示折返し用の改行/タブが埋まっているので、破棄せず除去する
            const s2 = s.replace(/[\n\r\t]/g, "").trim();
            if (s2 && CLEAN_RE.test(s2)) {
              out.push({ off: i, text: s2 });
              i += 2 + L;
              continue;
            }
          }
        }
      }
    }
    i++;
  }
  return out;
}

/**
 * §4.2 vtav 文字列（UTF-8, [1byte長さ][値]）
 * 事前に UTF-8 構造を手検査して、TextDecoder 呼び出しを候補だけに絞る。
 */
function walkVtavStrings(data) {
  const out = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    const L = data[i];
    if (L >= 1 && L <= 250 && i + 1 + L <= n) {
      const st = i + 1, en = i + 1 + L;
      let p = st, valid = true, hasKey = false;
      while (p < en) {
        const b = data[p];
        let size, cp;
        if (b < 0x80)             { size = 1; cp = b; }
        else if ((b & 0xE0) === 0xC0) { size = 2; cp = b & 0x1F; }
        else if ((b & 0xF0) === 0xE0) { size = 3; cp = b & 0x0F; }
        else if ((b & 0xF8) === 0xF0) { size = 4; cp = b & 0x07; }
        else { valid = false; break; }
        if (p + size > en) { valid = false; break; }
        for (let k = 1; k < size; k++) {
          const c = data[p + k];
          if ((c & 0xC0) !== 0x80) { valid = false; break; }
          cp = (cp << 6) | (c & 0x3F);
        }
        if (!valid) break;
        if ((size === 2 && cp < 0x80) || (size === 3 && cp < 0x800) || (size === 4 && cp < 0x10000)) { valid = false; break; }
        if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { valid = false; break; }
        if (!(cp >= 0x20 || cp === 0x09)) { valid = false; break; }   // 制御文字（タブ以外）は不採用
        if ((cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0xFF00 && cp <= 0xFFEF) ||
            (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39)) hasKey = true;
        p += size;
      }
      if (valid && hasKey) {
        let s = null;
        try { s = DEC_U8.decode(data.subarray(st, en)); } catch (_) { s = null; }
        if (s !== null) {
          out.push({ off: i, text: s.trim() });
          i += 1 + L;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}
