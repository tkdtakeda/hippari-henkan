/* ============================================================================
 * zip.js — Zip（store 方式・内蔵実装）（§7.2）
 *
 * 単一のグローバルスコープで動く古典スクリプト（file:// で ES Module は
 * CORS で読めないため、あえて module にしない）。読み込み順は index.html を参照。
 * ==========================================================================*/
"use strict";

/* ───────────────── Zip（§7.2 / store・内蔵実装） ───────────────── */
function dosStamp(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}
function zipStore(files) {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034B50, true);
    dv.setUint16(4, 20, true);         // version needed
    dv.setUint16(6, 0x0800, true);     // 汎用フラグ bit11 = ファイル名は UTF-8
    dv.setUint16(8, 0, true);          // method = 0 (store)
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    parts.push(lh, f.data);
    central.push({ name, crc, size: f.data.length, offset });
    offset += lh.length + f.data.length;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const ch = new Uint8Array(46 + c.name.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, 0x02014B50, true);
    dv.setUint16(4, 20, true);         // version made by
    dv.setUint16(6, 20, true);         // version needed
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.name.length, true);
    dv.setUint16(30, 0, true);         // extra
    dv.setUint16(32, 0, true);         // comment
    dv.setUint16(34, 0, true);         // disk
    dv.setUint16(36, 0, true);         // internal attrs
    dv.setUint32(38, 0, true);         // external attrs
    dv.setUint32(42, c.offset, true);
    ch.set(c.name, 46);
    cdParts.push(ch);
    cdSize += ch.length;
  }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054B50, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of parts)   { out.set(b, p); p += b.length; }
  for (const b of cdParts) { out.set(b, p); p += b.length; }
  out.set(eocd, p);
  return out;
}
