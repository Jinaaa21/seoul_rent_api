"""OpenAPI(최근 3년 접수분) 전체를 받아 raw/api_{연도}.csv.gz 로 저장한다. 서울 전체 집계(build_summary.py)의 입력.

사용법:
    python scripts/fetch_api.py 2024 2025 2026

API 키는 환경변수 SEOUL_API_KEY 또는 프로젝트의 .dev.vars 에서 읽고, 화면에 출력하지 않는다.
결과 파일은 raw/ 에 저장되며 git에서 제외된다.
"""
import csv
import gzip
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
SERVICE = "tbLnOpendataRentV"
PAGE = 1000
WORKERS = 6
FIELDS = ["RCPT_YR", "CGG_CD", "CGG_NM", "STDG_CD", "STDG_NM", "CTRT_DAY", "RENT_SE",
          "BLDG_USG", "RENT_AREA", "GRFE", "RTFE", "FLR", "ARCH_YR", "NEW_UPDT_YN", "BLDG_NM"]


def api_key():
    key = os.environ.get("SEOUL_API_KEY")
    if not key:
        for line in (ROOT / ".dev.vars").read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("SEOUL_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("SEOUL_API_KEY 를 찾지 못했습니다 (.dev.vars 확인).")
    return key


def fetch(key, year, start):
    url = f"http://openapi.seoul.go.kr:8088/{key}/json/{SERVICE}/{start}/{start + PAGE - 1}/{year}/"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            body = data.get(SERVICE)
            if body:
                return body["list_total_count"], body["row"]
            if data.get("RESULT", {}).get("CODE") == "INFO-200":
                return 0, []
            raise RuntimeError(data.get("RESULT", {}).get("CODE", "UNKNOWN"))
        except Exception as e:  # 키가 들어 있는 URL은 출력하지 않는다
            err = type(e).__name__ if not isinstance(e, RuntimeError) else str(e)
            time.sleep(2 * (attempt + 1))
    raise SystemExit(f"{year}년 {start}번째 행부터 받지 못했습니다 ({err}).")


def main(years):
    key = api_key()
    RAW.mkdir(exist_ok=True)
    for year in years:
        total, first = fetch(key, year, 1)
        starts = list(range(1 + PAGE, total + 1, PAGE))
        print(f"{year}년: {total:,}건, {len(starts) + 1}페이지", flush=True)
        out = RAW / f"api_{year}.csv.gz"
        tmp = out.with_suffix(".tmp")
        t0 = time.time()
        with gzip.open(tmp, "wt", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(FIELDS)
            n = 0
            for r in first:
                w.writerow([r.get(k, "") for k in FIELDS]); n += 1
            with ThreadPoolExecutor(WORKERS) as pool:
                for i, (_, rows) in enumerate(pool.map(lambda s: fetch(key, year, s), starts), 1):
                    for r in rows:
                        w.writerow([r.get(k, "") for k in FIELDS]); n += 1
                    if i % 100 == 0:
                        print(f"  {year}: {n:,}/{total:,} ({time.time() - t0:.0f}s)", flush=True)
        tmp.replace(out)
        print(f"{year}년 완료: {n:,}건 -> {out.name} ({time.time() - t0:.0f}s)", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main([int(y) for y in sys.argv[1:]])
