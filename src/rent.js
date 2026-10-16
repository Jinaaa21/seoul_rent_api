// GET /api/rent?gu=11620&dong=10200&year=2024&chunk=0  (src/index.js 에서 호출)
//
// 서울 열린데이터광장 tbLnOpendataRentV 프록시.
// API 키는 Cloudflare 환경변수(SEOUL_API_KEY)에서만 읽고, 응답·에러 메시지·로그 어디에도 넣지 않는다.
// 한 번의 호출은 최대 CHUNK_SIZE 건(= PAGE_SIZE x PAGES_PER_CHUNK)을 돌려주고,
// 나머지는 브라우저가 chunk 번호를 올려 가며 이어서 요청한다 (Workers 서브요청 한도 대응).

const SERVICE = "tbLnOpendataRentV";
const PAGE_SIZE = 1000; // 열린데이터광장 1회 최대 건수
const PAGES_PER_CHUNK = 5;
const CHUNK_SIZE = PAGE_SIZE * PAGES_PER_CHUNK;
const MAX_CHUNK = 40; // 동 하나·연도 하나에 20만 건을 넘을 일은 없다
// OpenAPI는 최근 3년 접수분만 제공한다. 그 이전 연도는 정적 파일(/data/archive/)로 제공하므로 여기서 받지 않는다.
// 범위가 밀리면 public/app.js 의 ARCHIVE_YEARS 와 함께 바꾼다.
const YEARS = ["2024", "2025", "2026"];
const GU_CODES = new Set([
  "11110", "11140", "11170", "11200", "11215", "11230", "11260", "11290", "11305",
  "11320", "11350", "11380", "11410", "11440", "11470", "11500", "11530", "11545",
  "11560", "11590", "11620", "11650", "11680", "11710", "11740",
]);
const USAGES = ["아파트", "오피스텔", "연립다세대", "단독다가구"];

export async function handleRent(request, env, ctx) {
  const url = new URL(request.url);

  // 다른 사이트에서 브라우저로 이 프록시를 호출하지 못하게 막는다.
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return json({ error: "허용되지 않은 요청입니다." }, 403);
  }

  const gu = url.searchParams.get("gu") ?? "";
  const dong = url.searchParams.get("dong") ?? "";
  const year = url.searchParams.get("year") ?? "";
  const chunk = Number(url.searchParams.get("chunk") ?? "0");
  if (!GU_CODES.has(gu) || !/^\d{5}$/.test(dong) || !YEARS.includes(year) ||
      !Number.isInteger(chunk) || chunk < 0 || chunk > MAX_CHUNK) {
    return json({ error: "잘못된 조회 조건입니다." }, 400);
  }

  const key = env.SEOUL_API_KEY;
  if (!key) {
    return json({ error: "서버에 API 키가 설정되지 않았습니다." }, 500);
  }

  // 정규화한 URL을 캐시 키로 쓴다 (키는 포함되지 않음).
  const cacheKey = new Request(`${url.origin}/api/rent?gu=${gu}&dong=${dong}&year=${year}&chunk=${chunk}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const first = chunk * CHUNK_SIZE + 1;
    const pages = await Promise.all(
      Array.from({ length: PAGES_PER_CHUNK }, (_, i) => {
        const start = first + i * PAGE_SIZE;
        return fetchPage(key, year, gu, dong, start, start + PAGE_SIZE - 1);
      }),
    );

    const total = Math.max(...pages.map((p) => p.total));
    const rows = pages.flatMap((p) => p.rows).map(slim);
    const response = json({ year: Number(year), chunk, chunkSize: CHUNK_SIZE, total, rows }, 200, {
      // 확정된 과거 연도는 길게, 올해는 짧게 캐시
      "Cache-Control": `public, max-age=${year === YEARS.at(-1) ? 3600 : 86400}`,
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    // err.message에는 upstream URL(=키)이 들어갈 수 있으므로 내보내지도, 로그로 남기지도 않는다.
    console.error("upstream failure", err instanceof UpstreamError ? err.code : err?.name);
    return json({ error: "서울 열린데이터광장 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  }
}

class UpstreamError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function fetchPage(key, year, gu, dong, start, end) {
  // 경로 순서: KEY/TYPE/SERVICE/START/END/RCPT_YR/CGG_CD/CGG_NM/STDG_CD
  const upstream = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/${SERVICE}/${start}/${end}/${year}/${gu}/%20/${dong}/`;
  let res;
  try {
    res = await fetch(upstream, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new UpstreamError("NETWORK");
  }
  if (!res.ok) throw new UpstreamError(`HTTP_${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new UpstreamError("BAD_JSON");
  }

  const body = data[SERVICE];
  if (body) {
    if (body.RESULT && body.RESULT.CODE !== "INFO-000") throw new UpstreamError(body.RESULT.CODE);
    return { total: body.list_total_count ?? 0, rows: body.row ?? [] };
  }
  // INFO-200: 해당 조건의 데이터 없음 (또는 페이지가 전체 건수를 넘어섬)
  if (data.RESULT?.CODE === "INFO-200") return { total: 0, rows: [] };
  throw new UpstreamError(data.RESULT?.CODE ?? "UNKNOWN");
}

// 브라우저로 보내는 행은 분석에 필요한 필드만 배열로 줄인다.
// [계약일, 전월세(0=전세,1=월세), 용도 index, 면적㎡, 보증금(만원), 월세(만원), 층, 건축년도, 신규갱신(0=신규,1=갱신,-1=미상), 건물명]
function slim(r) {
  return [
    r.CTRT_DAY,
    r.RENT_SE === "전세" ? 0 : 1,
    USAGES.indexOf(r.BLDG_USG),
    num(r.RENT_AREA),
    num(r.GRFE),
    num(r.RTFE),
    num(r.FLR),
    num(r.ARCH_YR),
    r.NEW_UPDT_YN === "신규" ? 0 : r.NEW_UPDT_YN === "갱신" ? 1 : -1,
    r.BLDG_NM ?? "",
  ];
}

function num(v) {
  const n = Number(String(v ?? "").replaceAll(",", ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
