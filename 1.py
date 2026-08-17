#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
trapezium_parser.py  (v5)
島津 TrapeziumX / TrapeziumX-V 試験ファイル解析ツール

対応フォーマット（自動判別）:
  - .xtux : 旧コンテナ。文字列 UTF-16LE、[0x3E][長さ(byte)] 前置。波形レコード 58 byte。
  - .vtav : "TXVFileVersion" コンテナ。文字列 UTF-8、[1byte長さ] 前置。波形レコード 139 byte。

出力（各データファイルの隣に <name>_out フォルダ）:
  1) <name>_report.csv     … レポート用の主要項目（引張強さ・伸び・耐力 等）★v5新規
  2) <name>_results.csv    … 試験結果サマリー全項目（ラベル/値/単位）
  3) <name>_conditions.csv … 試験条件（品名・ロット・寸法・速度・日付など）
  4) <name>_waveform.csv   … 生波形（時間・ストローク・試験力・変位計1）
  5) <name>_audit.csv      … 変更履歴（.vtav、--audit 時）
  6) <name>_meta.json / <name>_image*.png / <name>_tokens.csv（--dump-strings 時）

結果値の抽出方式:
  - .xtux : 「名前→単位→値」の順序構造から抽出（力の最大値が波形と一致することを実測確認済み）。
  - .vtav : ★バイト位置で確定。各結果値は
              <1byte長さ><値ASCII> 00 [01|02] 00 00 00 <float32 下限> <float32 上限>
            という不変パターンで格納される。この「値アンカー」を検出し直前ラベルへ対応づける。
            未算出項目は "-.-" プレースホルダで格納されるため、レポートでは N/A と明示する。

使い方:
  python trapezium_parser.py <入力ファイル> [-o 出力フォルダ] [--audit] [--dump-strings]
"""

import sys, os, re, csv, json, struct, argparse

MARKER = bytes.fromhex("01000000000101")
CHANNELS = [("Time_sec", -8), ("Stroke_mm", -4), ("Force_N", 29), ("Extensometer_mm", 37)]

UNITS = {"N", "N/mm2", "mm", "sec", "%", "MPa/s", "/sec", "mm/min", "GPa", "kN", "MPa"}
NUM = re.compile(r"^-?\d+(\.\d+)?$")
_CLEAN = re.compile(r"[\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF々ー_A-Za-z0-9/%\.\^\+\-\(\)\[\] :×]+")

# .vtav 値アンカー（数値）と 未算出プレースホルダ "-.-"
VTAV_VALUE_ANCHOR = re.compile(rb'([\x01-\x0f])(-?[0-9][0-9.\-]{0,14})\x00[\x01\x02]\x00\x00\x00')
VTAV_NA_ANCHOR    = re.compile(rb'\x03(-\.-)\x00[\x01\x02]\x00\x00\x00')
_DT_RE = re.compile(rb'\d{4}/\d{2}/\d{2} \d{1,2}:\d{2}:\d{2}')
_CJK = re.compile(r"[\u3040-\u30FF\u4E00-\u9FFF]")

COND_KEYS = ["品名", "試験片名", "厚さ", "幅", "直径", "平行部長さ", "つかみ具間距離",
             "ロードセル容量", "試験機種類", "作成者", "検討者", "承認者",
             "作成日", "試験日", "試験モード", "試験種類", "速度", "試験片形状",
             "バッチ数", "サブバッチ数"]

# ── レポート項目マッピング（標準名 → (単位, 候補ラベル…優先順)） ──
REPORT_FIELDS = [
    ("引張強さ Rm",         "N/mm2",  ["最大点_応力", "最大点_Rm"]),
    ("耐力 Rp0.2",         "N/mm2",  ["耐力点1_応力", "耐力点1Rp"]),
    ("伸び",               "%",      ["破断点_変位(ひずみ)", "破断点_At"]),
    ("応力増加速度",        "MPa/s",  ["応力増加速度"]),
    ("ひずみ速度",          "/sec",   ["歪速度"]),
    ("クロスヘッド変位速度",  "mm/min", ["実績クロスヘッド変異速度", "クロスヘッド変異速度"]),
    # ── 以下は取得できれば併記する参考項目 ──
    ("弾性率",             "N/mm2",  ["弾性率_Standard"]),
    ("ヤング率",           "GPa",    ["ヤング率"]),
    ("最大試験力 Fm",       "N",      ["最大点_試験力", "最大点_Fm"]),
    ("耐力点試験力",        "N",      ["耐力点1_試験力"]),
]


# ───────── 共通 ─────────
def clean_path(p):
    if p is None:
        return None
    p = p.strip().strip('"').strip("'").strip()
    return p.rstrip('"').rstrip()

def detect_format(data, path):
    if data[:64].find(b"TXVFileVersion") >= 0:
        return "vtav"
    return "vtav" if os.path.splitext(path)[1].lower() == ".vtav" else "xtux"


# ───────── 文字列抽出（TLV） ─────────
def walk_xtux_strings(data, marker=0x3E):
    """[0x3E][長さ(byte,偶数)][UTF-16LE] を抽出。
       ★一部ラベル（例: 破断点_変位(ひず␤み)、実績クロスヘッド変␤異速度）は
         表示折り返し用の改行/タブ(0x0A/0x0D/0x09)がバイト列内に埋め込まれている。
         これらは内部制御文字として許容し、出力時に除去する（丸ごと破棄しない）。"""
    out, i, n = [], 0, len(data)
    while i < n - 1:
        if data[i] == marker:
            L = data[i + 1]
            if 2 <= L <= 254 and L % 2 == 0 and i + 2 + L <= n:
                try:
                    s = data[i + 2:i + 2 + L].decode("utf-16le")
                except Exception:
                    s = None
                if s is not None \
                   and all(ord(c) >= 0x20 or c in "\n\r\t" for c in s) \
                   and all(ord(c) not in (0xFFFE, 0xFFFF) for c in s):
                    s2 = s.replace("\n", "").replace("\r", "").replace("\t", "").strip()
                    if s2 and _CLEAN.fullmatch(s2):
                        out.append((i, s2))
                        i += 2 + L
                        continue
        i += 1
    return out

def walk_vtav_strings(data, minlen=1):
    out, i, n = [], 0, len(data)
    while i < n:
        L = data[i]
        if 1 <= L <= 250 and i + 1 + L <= n:
            try:
                s = data[i + 1:i + 1 + L].decode("utf-8")
            except Exception:
                i += 1
                continue
            if len(s) >= minlen and all(ord(c) >= 0x20 or c == "\t" for c in s) \
               and re.search(r"[\u3000-\u9FFF\uFF00-\uFFEFA-Za-z0-9]", s):
                out.append((i, s.strip()))
                i += 1 + L
                continue
        i += 1
    return out


# ───────── 試験条件 ─────────
_NONVALUE = set(COND_KEYS) | {
    "タイトル", "キーワード", "オペレータ", "コメント", "結果ファイル名", "条件ファイル名",
    "温度", "湿度", "機体番号", "伸び原点", "名前", "パラメータ", "合否判定", "単位",
    "変位計1標点距離", "変位計1リミット", "変位計1フルスケール", "変位計2フルスケール",
    "幅計標点距離", "幅計フルスケール",
} | UNITS
_DATE = re.compile(r"^\d{4}/\d{2}/\d{2}( \d{1,2}:\d{2}:\d{2})?$")
_DIM = re.compile(r"^-?\d+\.\d+$")
_LOADCELL = re.compile(r"^\d+\s?kN$")

def _validate_cond(key, cand):
    if key in {"厚さ", "幅", "直径", "平行部長さ", "つかみ具間距離"}:
        return cand if _DIM.match(cand) else None
    if key in {"作成日", "試験日"}:
        return cand if _DATE.match(cand) else None
    if key == "ロードセル容量":
        return cand if _LOADCELL.match(cand) else None
    if key in {"バッチ数", "サブバッチ数"}:
        return cand if re.match(r"^\d+$", cand) else None
    return cand if cand not in _NONVALUE else None

def extract_conditions(tokens):
    vals = [s for _, s in tokens]
    cond = {}
    for idx, s in enumerate(vals):
        if s not in COND_KEYS or s in cond:
            continue
        for j in range(idx + 1, min(idx + 6, len(vals))):
            cand = vals[j]
            if not cand or cand == s:
                continue
            if cand in COND_KEYS:
                break
            ok = _validate_cond(s, cand)
            if ok is not None:
                cond[s] = ok
                break
    for _, s in tokens:
        if re.fullmatch(r"[A-Z][0-9A-Z]{6,}", s):
            cond["ロット/製造番号"] = s
            break
    return cond


# ───────── 結果サマリー（.xtux） ─────────
def parse_results_xtux(tokens):
    toks = [s for _, s in tokens]
    res, i = [], 0
    while i < len(toks):
        if toks[i] == "名前":
            j = i
            while j < len(toks) and toks[j] != "単位":
                j += 1
            k = j + 1
            rows, cur = [], []
            while k < len(toks):
                t = toks[k]
                if NUM.match(t) or t == "名前":
                    break
                cur.append(t)
                if t in UNITS:
                    rows.append((cur[0], t, " ".join(cur[1:-1]).strip()))
                    cur = []
                k += 1
            vals = []
            while k < len(toks) and NUM.match(toks[k]):
                vals.append(toks[k]); k += 1
            for idx, (label, unit, param) in enumerate(rows):
                res.append({"label": label, "unit": unit,
                            "value": vals[idx] if idx < len(vals) else "", "param": param})
            i = k
            continue
        i += 1
    # 万一ラベルが空で mm/min のときのみ補完（通常は 実績クロスヘッド変異速度 が復元される）。
    for r in res:
        if r["label"] == "" and r["unit"] == "mm/min":
            r["label"] = "実績クロスヘッド変異速度"
    return res


# ───────── 結果サマリー（.vtav：バイトアンカー） ─────────
def _is_result_label(s):
    if not _CJK.search(s):
        return False
    if s in {"全エリアで計算"} or s.startswith("計算式") or s.startswith("速度センサー"):
        return False
    if "Arial" in s or s.startswith("[") or s.startswith("<<") or "->" in s \
       or s.startswith("(") or "]" in s or "@" in s:
        return False
    return ("_" in s) or ("×" in s) or ("点" in s) or s.endswith("率") \
        or ("速度" in s) or ("ヤング" in s)

def _nearest_unit(units_sorted, voff):
    unit = ""
    for o, s in units_sorted:
        if o >= voff:
            break
        if voff - o < 200:
            unit = s
    return unit

def parse_results_vtav(data, tokens):
    audit_start = data.find("試験条件".encode())
    if audit_start < 0:
        audit_start = len(data)
    m = _DT_RE.search(data)
    results_start = m.start() if m else 0

    labels = [(o, s) for o, s in tokens if _is_result_label(s)]
    units = [(o, s) for o, s in tokens if s in UNITS]

    # 数値アンカー + N/A("-.-")アンカーをまとめて位置順に処理
    hits = []
    for m in VTAV_VALUE_ANCHOR.finditer(data):
        if m.group(1)[0] == len(m.group(2)):
            hits.append((m.start(), m.group(2).decode()))
    for m in VTAV_NA_ANCHOR.finditer(data):
        hits.append((m.start(), "N/A"))
    hits.sort()

    res, seen = [], set()
    for voff, val in hits:
        if not (results_start <= voff < audit_start):
            continue
        if val == "0":
            continue
        cand = [(o, s) for o, s in labels if o < voff and voff - o < 200]
        if not cand:
            continue
        loff, label = max(cand, key=lambda x: x[0])
        if loff in seen:
            continue
        seen.add(loff)
        res.append({"label": label, "unit": _nearest_unit(units, voff),
                    "value": val, "param": ""})
    return res


# ───────── レポート項目の組み立て ─────────
def build_report(results):
    """結果リストから、レポート用の標準項目を候補ラベル優先順で拾う。"""
    by_label = {}
    for r in results:
        by_label.setdefault(r["label"], r)  # 先勝ち（最初の出現）
    report = []
    for std_name, unit, cands in REPORT_FIELDS:
        val, src = "", ""
        for c in cands:
            if c in by_label:
                val = by_label[c]["value"]
                src = c
                break
        report.append({"item": std_name, "value": val, "unit": unit, "source_label": src})
    return report


# ───────── 生波形 / PNG / 変更履歴 ─────────
def extract_waveform(data):
    pos = [m.start() for m in re.finditer(re.escape(MARKER), data)]
    if len(pos) < 20:
        return None
    import collections
    diffs = [pos[i + 1] - pos[i] for i in range(len(pos) - 1)]
    stride = collections.Counter(d for d in diffs if 0 < d < 4096).most_common(1)[0][0]
    good = [pos[i] for i in range(len(pos) - 1) if pos[i + 1] - pos[i] == stride]
    if good and pos[-1] - good[-1] == stride:
        good.append(pos[-1])
    if len(good) < 20:
        return None

    def col(off):
        raw = b"".join(data[p + off:p + off + 4] for p in good
                       if 0 <= p + off and p + off + 4 <= len(data))
        return struct.unpack("<%df" % (len(raw) // 4), raw)

    cols = {}
    for name, off in CHANNELS:
        try:
            v = col(off)
            if len(v) == len(good) and all(x == x for x in v):
                cols[name] = v
        except Exception:
            pass
    return {"stride": stride, "points": len(good), "columns": cols}

def extract_pngs(data, out_dir, base):
    sig, end = b"\x89PNG\r\n\x1a\n", b"IEND\xaeB`\x82"
    imgs, start, idx = [], 0, 0
    while True:
        p = data.find(sig, start)
        if p < 0:
            break
        e = data.find(end, p)
        if e < 0:
            break
        e += len(end); idx += 1
        path = os.path.join(out_dir, f"{base}_image{idx}.png")
        with open(path, "wb") as f:
            f.write(data[p:e])
        imgs.append(path); start = e
    return imgs

def parse_audit(tokens):
    vals = [s for _, s in tokens]
    dt = re.compile(r"^\d{4}/\d{2}/\d{2} \d{1,2}:\d{2}:\d{2}$")
    rows = []
    for i, s in enumerate(vals):
        if "試験条件" in s and s.startswith("<<"):
            item = s
            change = vals[i + 1] if i + 1 < len(vals) else ""
            when, user = "", ""
            for j in range(i + 1, min(i + 4, len(vals))):
                if dt.match(vals[j]):
                    when = vals[j]
                    user = vals[j + 1] if j + 1 < len(vals) else ""
                    if j == i + 1:
                        change = ""
                    break
            rows.append({"item": item, "change": change, "datetime": when, "user": user})
    return rows


# ───────── メイン ─────────
def main():
    ap = argparse.ArgumentParser(description="TrapeziumX / TrapeziumX-V 解析 (v5)")
    ap.add_argument("input")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--dump-strings", action="store_true")
    ap.add_argument("--audit", action="store_true")
    args = ap.parse_args()

    in_path = clean_path(args.input)
    if not in_path or not os.path.isfile(in_path):
        print(f"[ERROR] ファイルが見つかりません: {args.input!r}")
        sys.exit(1)

    with open(in_path, "rb") as f:
        data = f.read()
    base = os.path.splitext(os.path.basename(in_path))[0]
    out_dir = clean_path(args.out) or os.path.dirname(os.path.abspath(in_path))
    os.makedirs(out_dir, exist_ok=True)

    fmt = detect_format(data, in_path)
    tokens = walk_vtav_strings(data) if fmt == "vtav" else walk_xtux_strings(data)

    if fmt == "vtav":
        results = parse_results_vtav(data, tokens); conf = "high(byte-anchor)"
    else:
        results = parse_results_xtux(tokens); conf = "high(order)"

    # レポート項目
    report = build_report(results)
    rep_path = os.path.join(out_dir, f"{base}_report.csv")
    with open(rep_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["item", "value", "unit", "source_label"])
        for r in report:
            w.writerow([r["item"], r["value"], r["unit"], r["source_label"]])

    # 結果全項目
    res_path = os.path.join(out_dir, f"{base}_results.csv")
    with open(res_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["label", "value", "unit", "param", "confidence"])
        for r in results:
            w.writerow([r["label"], r["value"], r["unit"], r.get("param", ""), conf])

    # 条件
    cond = extract_conditions(tokens)
    # ★xtux(平板)の寸法(厚さ/幅/試験片名/平行部長さ)は、UTF-16LE本体ではなく
    #   「1byte長さ+UTF-8」形式の寸法セクションに埋め込まれている(vtavと同じ枠)。
    #   xtuxウォーカーはUTF-16LEしか読まないため、寸法はUTF-8ウォーカーで別途拾う。
    if fmt == "xtux":
        # 寸法セクションの並びは [ラベル][mm][フラグ"1"][小数値] 。
        # 例: 厚さ mm 1 11.843 / 幅 mm 1 24.988 / つかみ具間距離 mm 1 99.9998
        # フラグ"1"を誤採用しないよう、数値寸法は「小数(ドット必須)」を要求する。
        u8_tokens = walk_vtav_strings(data)          # UTF-8 TLV を走査
        u8_vals = [s for _, s in u8_tokens]
        num_dims = ("厚さ", "幅", "直径", "平行部長さ", "つかみ具間距離")
        for idx, s in enumerate(u8_vals):
            if s in num_dims and s not in cond:
                for j in range(idx + 1, min(idx + 6, len(u8_vals))):
                    c = u8_vals[j]
                    if c in num_dims or c in ("試験片名", "名前", "パラメータ",
                                              "合否判定", "単位"):
                        break
                    if re.match(r"^-?\d+\.\d+$", c):  # 小数のみ(フラグ"1"は除外)
                        cond[s] = c
                        break
    cond_path = os.path.join(out_dir, f"{base}_conditions.csv")
    with open(cond_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["key", "value"])
        for k, v in cond.items():
            w.writerow([k, v])

    # 波形
    wave = extract_waveform(data)
    wave_path = None
    if wave and wave["columns"]:
        wave_path = os.path.join(out_dir, f"{base}_waveform.csv")
        names = list(wave["columns"].keys())
        with open(wave_path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["#"] + names)
            for i, row in enumerate(zip(*[wave["columns"][n] for n in names])):
                w.writerow([i] + [round(x, 6) for x in row])

    # 変更履歴
    audit_path = None
    if args.audit and fmt == "vtav":
        rows = parse_audit(tokens)
        if rows:
            audit_path = os.path.join(out_dir, f"{base}_audit.csv")
            with open(audit_path, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f)
                w.writerow(["item", "change", "datetime", "user"])
                for r in rows:
                    w.writerow([r["item"], r["change"], r["datetime"], r["user"]])

    # メタ
    meta = {"_format": fmt, "_source_file": os.path.basename(in_path),
            "_size_bytes": len(data), "conditions": cond,
            "n_results": len(results), "waveform_points": wave["points"] if wave else 0}
    with open(os.path.join(out_dir, f"{base}_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    imgs = extract_pngs(data, out_dir, base)

    if args.dump_strings:
        with open(os.path.join(out_dir, f"{base}_tokens.csv"), "w",
                  encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["offset_hex", "text"])
            for off, s in tokens:
                w.writerow([hex(off), s])

    # レポート出力
    print("=" * 64)
    print(f"入力     : {os.path.basename(in_path)} ({len(data):,} bytes)  形式: {fmt}")
    for k in ["ロット/製造番号", "厚さ", "幅", "平行部長さ", "試験片形状", "試験日"]:
        if k in cond:
            print(f"  条件 {k:<10}: {cond[k]}")
    print(f"  --- レポート項目 ({conf}) -> {os.path.basename(rep_path)} ---")
    for r in report:
        v = r["value"] if r["value"] else "(なし)"
        print(f"  {r['item']:<18} {v:>12} {r['unit']}")
    if wave and wave["columns"]:
        print(f"  生波形 : {wave['points']} 点 -> {os.path.basename(wave_path)}")
    print(f"  画像   : {len(imgs)} 枚 / 全結果 {len(results)} 項目 -> {os.path.basename(res_path)}")
    print(f"出力先   : {out_dir}")
    print("=" * 64)


if __name__ == "__main__":
    main()
