"""OpenAPI가 제공하지 않는 과거 연도(최근 3년 이전)를 동별 정적 JSON으로 만든다.

사용법:
    python scripts/build_archive.py raw/seoul_rent_2022.zip raw/seoul_rent_2023.zip

결과: public/data/archive/{자치구코드}_{법정동코드}.json
      {"years": [2022, 2023], "rows": [[...], ...]}   (행 형식은 src/rent.js 의 slim()과 같음)

- 연도는 파일 안의 '접수년도' 기준으로 나눈다. 파일에 다른 연도 접수분이 섞여 있어도 접수년도가 같으면 같은 연도로 묶는다.
- 여러 파일에 같은 접수년도의 같은 거래가 겹치면 한 번만 남긴다.
- 접수년도가 2024년 이후인 행은 OpenAPI에서 받으므로 넣지 않는다.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

from rent_files import read_rows

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "archive"
API_FIRST_YEAR = 2024  # 이 연도부터는 OpenAPI 사용
USAGES = ["아파트", "오피스텔", "연립다세대", "단독다가구"]
KEY_FIELDS = ["RCPT_YR", "CGG_CD", "STDG_CD", "LOTNO_SE", "MNO", "SNO", "FLR", "CTRT_DAY",
              "RENT_SE", "RENT_AREA", "GRFE", "RTFE", "BLDG_NM", "ARCH_YR", "BLDG_USG", "CTRT_PRD",
              "NEW_UPDT_YN", "BFR_GRFE", "BFR_RTFE"]


def num(v):
    v = (v or "").replace(",", "").strip()
    try:
        n = float(v)
    except ValueError:
        return None
    return int(n) if n.is_integer() else n


def norm(v):
    """'6'과 '6.0', '0001'과 '1'처럼 파일마다 다른 숫자 표기를 같게 본다."""
    n = num(v)
    return str(n) if n is not None else (v or "")


def slim(r):
    return [
        r["CTRT_DAY"],
        0 if r["RENT_SE"] == "전세" else 1,
        USAGES.index(r["BLDG_USG"]) if r["BLDG_USG"] in USAGES else -1,
        num(r["RENT_AREA"]), num(r["GRFE"]), num(r["RTFE"]), num(r["FLR"]), num(r["ARCH_YR"]),
        0 if r["NEW_UPDT_YN"] == "신규" else 1 if r["NEW_UPDT_YN"] == "갱신" else -1,
        r["BLDG_NM"],
    ]


def main(paths):
    by_dong = defaultdict(list)
    seen_in_other_files = {}
    years = set()
    stats = defaultdict(lambda: {"read": 0, "kept": 0, "dup": 0, "api": 0})

    for fi, path in enumerate(paths):
        name = Path(path).name
        keys_this_file = set()
        for r in read_rows(path):
            s = stats[name]
            s["read"] += 1
            y = int(r["RCPT_YR"]) if r["RCPT_YR"].isdigit() else 0
            if y >= API_FIRST_YEAR:
                s["api"] += 1
                continue
            key = tuple(norm(r.get(k)) for k in KEY_FIELDS)
            # 같은 파일 안의 동일 행은 실제로 별개 거래(같은 건물·같은 날 다른 호실)일 수 있어 그대로 둔다.
            # 다른 파일에 이미 나온 행만 중복으로 본다.
            if seen_in_other_files.get(key, fi) != fi:
                s["dup"] += 1
                continue
            keys_this_file.add(key)
            years.add(y)
            by_dong[(r["CGG_CD"], r["STDG_CD"])].append(slim(r))
            s["kept"] += 1
        for k in keys_this_file:
            seen_in_other_files.setdefault(k, fi)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    year_list = sorted(y for y in years if y)
    largest = 0
    for (gu, dong), rows in by_dong.items():
        rows.sort(key=lambda r: r[0], reverse=True)
        data = json.dumps({"years": year_list, "rows": rows}, ensure_ascii=False, separators=(",", ":"))
        (OUT / f"{gu}_{dong}.json").write_text(data, encoding="utf-8")
        largest = max(largest, len(data.encode("utf-8")))

    for name, s in stats.items():
        print(f"{name}: 읽음 {s['read']:,} / 저장 {s['kept']:,} / 파일 간 중복 제거 {s['dup']:,} / API 연도라 제외 {s['api']:,}")
    total = sum(len(v) for v in by_dong.values())
    print(f"접수연도 {year_list}, {len(by_dong)}개 동, {total:,}행 -> {OUT}  (가장 큰 파일 {largest / 1e6:.1f}MB)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
