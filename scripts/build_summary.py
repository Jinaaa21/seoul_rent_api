"""서울 전체·자치구별 전세 집계(public/data/summary.json)를 만든다. 첫 화면과 지도가 이 파일을 쓴다.

사용법:
    python scripts/build_summary.py raw/seoul_rent_2022.zip raw/seoul_rent_2023.zip raw/api_2024.csv.gz raw/api_2025.csv.gz raw/api_2026.csv.gz

- zip: 열린데이터광장 FILE 탭의 연도별 파일 (2024년 미만 접수분만 사용)
- csv.gz: scripts/fetch_api.py 로 받은 OpenAPI 전체 (2024년 이상 접수분만 사용)
- 연도·월은 계약일 기준, 전세(보증금 > 0)만 집계한다.
- 파일끼리 같은 접수년도의 같은 행이 겹치면 한 번만 센다 (build_archive.py 와 같은 규칙).
"""
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

from rent_files import COLUMNS, detect_encoding

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "summary.json"
API_FIRST_YEAR = 2024
YEARS = [2022, 2023, 2024, 2025, 2026]
USAGES = ["아파트", "오피스텔", "연립다세대", "단독다가구"]
MIN_DEALS_PER_MONTH = 3
USE = ["RCPT_YR", "CGG_CD", "CGG_NM", "STDG_CD", "LOTNO_SE", "MNO", "SNO", "FLR", "CTRT_DAY", "RENT_SE",
       "RENT_AREA", "GRFE", "RTFE", "BLDG_NM", "ARCH_YR", "BLDG_USG", "CTRT_PRD", "NEW_UPDT_YN",
       "BFR_GRFE", "BFR_RTFE"]


def load(path):
    p = str(path)
    if p.endswith(".zip"):
        df = pd.read_csv(p, encoding=detect_encoding(p), dtype=str, keep_default_na=False)
        df = df.rename(columns={k: v for k, v in COLUMNS.items()})
    else:
        df = pd.read_csv(p, dtype=str, keep_default_na=False)
    df = df[[c for c in USE if c in df.columns]].copy()
    for c in df.columns:
        df[c] = df[c].str.strip()
    yr = pd.to_numeric(df["RCPT_YR"], errors="coerce")
    keep = yr >= API_FIRST_YEAR if p.endswith(".csv.gz") else yr < API_FIRST_YEAR
    keep &= df["CGG_CD"].str.fullmatch(r"11\d{3}")  # 자치구 코드가 비어 있는 행(API에 소수 있음)은 제외
    print(f"{Path(p).name}: {len(df):,}행 중 {int(keep.sum()):,}행 사용", flush=True)
    return df[keep]


def dedupe_across_files(frames):
    """앞선 파일에 이미 있는 행(숫자 표기 차이 무시)은 뒤 파일에서 뺀다. 같은 파일 안의 동일 행은 별개 거래로 둔다."""
    def key(df):
        k = df.copy()
        for c in ("FLR", "MNO", "SNO", "RENT_AREA", "GRFE", "RTFE", "ARCH_YR"):
            if c in k:
                k[c] = pd.to_numeric(k[c], errors="coerce").astype(str)
        return pd.util.hash_pandas_object(k[[c for c in USE if c in k.columns]], index=False)

    seen, out = set(), []
    for df in frames:
        h = key(df)
        dup = h.isin(seen)
        if dup.any():
            print(f"  파일 간 중복 {int(dup.sum()):,}행 제거", flush=True)
        out.append(df[~dup.values])
        seen.update(h[~dup].tolist())
    return pd.concat(out, ignore_index=True)


def stats(g):
    dep = g["dep"]
    return {
        "n": int(len(g)),
        "mean": round(float(dep.mean()), 1),
        "median": round(float(dep.median()), 1),
        "perM2": round(float(g["perM2"].median()), 2) if g["perM2"].notna().any() else None,
        "months": sorted(int(m) for m in g["month"].unique()),
    }


def summarize(df):
    out = {}
    for u_key, sub in [("all", df)] + [(str(i), df[df["usage"] == i]) for i in range(len(USAGES))]:
        years = {str(y): stats(g) for y, g in sub.groupby("year") if y in YEARS}
        monthly = {"deposit": [], "perM2": []}
        for ym, g in sub.groupby("ym"):
            if len(g) < MIN_DEALS_PER_MONTH:
                continue
            monthly["deposit"].append([ym, round(float(g["dep"].median()), 1), int(len(g))])
            pm = g["perM2"].dropna()
            if len(pm) >= MIN_DEALS_PER_MONTH:
                monthly["perM2"].append([ym, round(float(pm.median()), 2), int(len(pm))])
        out[u_key] = {"years": years, "monthly": monthly}
    return out


def main(paths):
    df = dedupe_across_files([load(p) for p in paths])
    total_by_region = df.groupby("CGG_CD").size().to_dict()
    total_by_region_year = df.assign(y=df["CTRT_DAY"].str[:4]).groupby(["CGG_CD", "y"]).size()
    names = df.drop_duplicates("CGG_CD").set_index("CGG_CD")["CGG_NM"].to_dict()

    j = df[df["RENT_SE"] == "전세"].copy()
    j["dep"] = pd.to_numeric(j["GRFE"].str.replace(",", ""), errors="coerce")
    j["area"] = pd.to_numeric(j["RENT_AREA"], errors="coerce")
    j = j[j["dep"] > 0]
    j["perM2"] = (j["dep"] / j["area"]).where(j["area"] > 0)
    j["year"] = pd.to_numeric(j["CTRT_DAY"].str[:4], errors="coerce")
    j["month"] = pd.to_numeric(j["CTRT_DAY"].str[4:6], errors="coerce")
    j["ym"] = j["CTRT_DAY"].str[:6]
    j["usage"] = j["BLDG_USG"].map({u: i for i, u in enumerate(USAGES)}).fillna(-1).astype(int)
    j = j[j["year"].isin(YEARS)]

    def counts(code=None):
        s = total_by_region_year if code is None else total_by_region_year.loc[code]
        if code is None:
            s = s.groupby(level=1).sum()
        return {y: int(s.get(y, 0)) for y in map(str, YEARS)}

    regions = {"seoul": {"name": "서울시 전체", "allDeals": counts(), **summarize(j)}}
    for code, g in j.groupby("CGG_CD"):
        regions[code] = {"name": names[code], "allDeals": counts(code), **summarize(g)}
        print(f"  {names[code]} 전세 {len(g):,}건", flush=True)

    result = {"updated": date.today().isoformat(), "years": YEARS, "usages": USAGES,
              "minDealsPerMonth": MIN_DEALS_PER_MONTH, "regions": regions}
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"서울 전세 {len(j):,}건 집계 -> {OUT} ({OUT.stat().st_size / 1024:.0f}KB)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
