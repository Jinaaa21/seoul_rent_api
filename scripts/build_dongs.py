"""서울시 전월세 파일에서 자치구-법정동 목록(public/data/dongs.json)을 만든다.

사용법:
    python scripts/build_dongs.py <csv 또는 zip> [<추가 파일> ...]

열린데이터광장 tbLnOpendataRentV 형식의 csv(영문 헤더)와 FILE 탭의 연도별 zip(한글 헤더)을 모두 받는다.
API 키를 쓰지 않으므로 결과 파일을 그대로 공개 폴더에 둬도 안전하다.
"""
import json
import sys
from pathlib import Path

from rent_files import read_rows

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "dongs.json"


def main(paths):
    gu = {}
    for path in paths:
        for row in read_rows(path):
            g = gu.setdefault(row["CGG_CD"], {"code": row["CGG_CD"], "name": row["CGG_NM"], "dongs": {}})
            g["dongs"][row["STDG_CD"]] = row["STDG_NM"]

    result = []
    for g in sorted(gu.values(), key=lambda x: x["name"]):
        dongs = [{"code": c, "name": n} for c, n in sorted(g["dongs"].items(), key=lambda x: x[1])]
        result.append({"code": g["code"], "name": g["name"], "dongs": dongs})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(result)}개 자치구, {sum(len(g['dongs']) for g in result)}개 법정동 -> {OUT}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
