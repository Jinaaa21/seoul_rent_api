# 서울 전세가 변화 (lec3-seoul-rent)

서울 열린데이터광장 「서울시 부동산 전월세가 정보」(OA-21276)로 2022~2026년 전세 보증금 변화를 보여주는 웹앱입니다.

- **첫 화면**: 서울시 전체 결과와 자치구 지도. 지도의 색은 자치구별 중위 전세가 변화율입니다(PiYG: 분홍 = 하락, 초록 = 상승).
- **자치구**: 지도에서 구를 누르면 그 구의 결과로 바뀝니다. 서울 전체를 비교선으로 함께 그립니다.
- **법정동**: 구를 고른 뒤 동을 조회하면 그 동의 신고 자료를 모두 불러옵니다. 구를 비교선으로 함께 그립니다.

Cloudflare Pages(정적 파일) + Pages Functions(API 프록시) 구조입니다.

## 구조

```
public/                     브라우저로 나가는 정적 파일 (API 키 없음)
  index.html, styles.css, app.js, 404.html
  data/summary.json         서울·자치구 집계 (build_summary.py)
  data/seoul_gu.geojson     자치구 경계 (build_map.py)
  data/dongs.json           자치구-법정동 목록 (build_dongs.py)
  data/archive/*.json       2022·2023년 동별 원자료 (build_archive.py)
  _headers                  CSP 등 보안 헤더
functions/api/rent.js       /api/rent 프록시 — 서버에서만 SEOUL_API_KEY 사용
scripts/                    데이터 준비 스크립트 (아래 참고)
raw/                        원본 zip·API 다운로드 (git 제외)
.dev.vars                   로컬 개발용 키 (git 제외)
```

## API 키 보안

- 키는 브라우저 코드에 없습니다. 브라우저는 `/api/rent`만 호출하고, 서버(Pages Function)가 `env.SEOUL_API_KEY`로 열린데이터광장을 호출합니다.
- 에러 응답과 로그에는 upstream URL(키 포함)을 넣지 않습니다.
- 입력값은 화이트리스트로 검증합니다(자치구 코드 25개, 동 코드 5자리 숫자, API 연도 2024~2026).
- 다른 사이트에서 브라우저로 프록시를 호출하면 `Sec-Fetch-Site: cross-site`로 걸러냅니다.
- `_headers`에서 CSP(`script-src 'self'`), `X-Frame-Options`, `nosniff` 등을 설정합니다.
- `scripts/fetch_api.py`도 키를 `.dev.vars`(또는 환경변수)에서만 읽고 출력하지 않습니다.
- `.env`, `.dev.vars`, `raw/`는 `.gitignore`에 들어 있어 커밋되지 않습니다.
- 서울시 API는 키를 URL 경로에 넣는 방식이라, `npm run dev`를 실행하면 로컬 요청 기록(`.wrangler/state/…/trace-store`)에 키가 포함된 주소가 남습니다.
  `.wrangler/`도 git에서 제외되지만, 폴더를 공유하거나 압축해 보낼 때는 지우세요. 배포 후 Cloudflare 대시보드에서 Workers 트레이싱(observability)을 켜면 같은 이유로 키가 기록될 수 있습니다.

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars   # SEOUL_API_KEY 입력 (이미 만들어져 있으면 생략)
npm run dev                       # http://127.0.0.1:8788
```

`?gu=11620`(자치구) 또는 `?gu=11620&dong=10200`(법정동)을 주소에 붙이면 바로 그 화면이 열립니다.

## 데이터 준비·갱신

열린데이터광장 안내: "데이터의 양이 많아 OpenAPI는 최근3년 데이터부터 출력됩니다." 그래서 두 출처를 합칩니다.

| 접수연도 | 출처 | 서울·자치구 집계 | 동별 조회 |
|---|---|---|---|
| 2022·2023 | [FILE 탭](https://data.seoul.go.kr/dataList/OA-21276/S/1/datasetView.do) 연도별 zip | `summary.json` | `data/archive/` |
| 2024~2026 | OpenAPI | `summary.json` (미리 받아 집계) | `/api/rent` (조회 시 실시간) |

서울·자치구 집계는 정적 파일이라 **자동으로 갱신되지 않습니다.** 최신 자료로 바꾸려면 아래를 다시 실행하세요
(API 전체 약 266만 건을 받는 데 20분 정도 걸립니다).

```bash
# 파이썬: pandas, geopandas 필요 (강의용 .venv 사용)
python scripts/fetch_api.py 2024 2025 2026                       # -> raw/api_YYYY.csv.gz
python scripts/build_summary.py raw/seoul_rent_2022.zip raw/seoul_rent_2023.zip \
       raw/api_2024.csv.gz raw/api_2025.csv.gz raw/api_2026.csv.gz  # -> data/summary.json
```

처음 한 번만 필요한 것:

```bash
python scripts/build_archive.py raw/seoul_rent_2022.zip raw/seoul_rent_2023.zip   # -> data/archive/
python scripts/build_dongs.py <2026 csv> raw/seoul_rent_2022.zip raw/seoul_rent_2023.zip
python scripts/build_map.py <HangJeongDong_ver20250101.geojson>                   # -> data/seoul_gu.geojson
```

- 2022년 파일에 섞인 2023년 접수분 중 2023년 파일과 겹치는 행(6,203건)은 한 번만 셉니다.
- API의 3년 범위는 해마다 밀립니다. 2024년이 API에서 빠지면 2024년 zip을 받아 `build_archive.py`·`build_summary.py`에 넣고,
  `app.js`의 `ARCHIVE_YEARS`와 `fetch_api.py` 인자에서 연도를 옮기세요.

## 집계 기준

- 연도·월은 **계약일** 기준, 전세(보증금 > 0)만 집계합니다. 대표값은 중위값입니다.
- 기간 변화율은 계약월이 6개월 이상인 첫 연도와 마지막 연도를 비교합니다. 마지막 연도(2026)는 1~10월 자료입니다.
- 지도는 서울 전체와 같은 기간으로 비교하며, 기준·최근 연도 중 하나라도 전세 거래가 30건 미만인 구는 회색으로 둡니다.
- 2024년부터 접수 건수가 크게 늘었습니다(2022·2023년 약 55만 건 → 2024·2025년 약 110만 건). 연도 간 건수 비교와 구성 변화에 주의하세요.
- 동은 **법정동**입니다(이 자료에는 행정동 코드가 없음). 지도 경계는 행정동 경계를 자치구로 합친 것입니다.

## Cloudflare 배포 (나중에)

```bash
npx wrangler login
npx wrangler pages project create seoul-rent
npx wrangler pages secret put SEOUL_API_KEY --project-name seoul-rent
npm run deploy
```

GitHub 연동으로 배포할 때는 빌드 명령을 비워 두고, 출력 디렉터리를 `public`으로 설정한 뒤
Settings → Variables and Secrets에서 `SEOUL_API_KEY`를 **Secret**으로 추가합니다.
