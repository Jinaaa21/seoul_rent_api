"use strict";

// 화면 단계: 서울시 전체 → 자치구(지도에서 선택) → 법정동(조회)
// - 서울시·자치구: scripts/build_summary.py 가 미리 집계한 /data/summary.json
// - 법정동: 조회할 때 2022·2023년은 /data/archive/, 2024년 이후는 /api/rent 프록시(API 키는 서버에만 있음)
const YEARS = [2022, 2023, 2024, 2025, 2026];
const ARCHIVE_YEARS = [2022, 2023]; // OpenAPI는 최근 3년 접수분만 제공
const API_YEARS = YEARS.filter((y) => !ARCHIVE_YEARS.includes(y));
const USAGES = ["아파트", "오피스텔", "연립다세대", "단독다가구"];
const USAGE_KEYS = ["all", "0", "1", "2", "3"];
const CONCURRENCY = 3;
const MIN_DEALS_PER_MONTH = 3;  // 이보다 적은 달은 월별 선에서 뺀다
const MIN_MONTHS_FOR_BASE = 6;  // 변화율 기준 연도로 쓰려면 최소 이만큼의 계약월이 있어야 한다
const MIN_DEALS_FOR_MAP = 30;   // 지도 색칠: 기준·최근 연도 모두 이 건수 이상일 때만
// ColorBrewer PiYG (11단계): 분홍 = 하락, 가운데 = 0%, 초록 = 상승
const PIYG = ["#8e0152", "#c51b7d", "#de77ae", "#f1b6da", "#fde0ef", "#f7f7f7", "#e6f5d0", "#b8e186", "#7fbc41", "#4d9221", "#276419"];

// 동별 행 배열 인덱스 (src/rent.js 의 slim() 과 같은 순서)
const DAY = 0, SE = 1, USG = 2, AREA = 3, DEP = 4, RENT = 5, FLR = 6, ARCH = 7, NEW = 8, NAME = 9;

const $ = (id) => document.getElementById(id);
const state = {
  summary: null, geo: null, districts: [],
  gu: null,            // 선택한 자치구 {code, name, dongs}
  dong: null,          // 조회한 법정동 {code, name}
  dongData: null,      // 동 집계 (summary 와 같은 모양)
  dongRows: [],
  usage: "all", metric: "deposit", controller: null,
};

init();

async function init() {
  try {
    const [districts, summary, geo] = await Promise.all(
      ["/data/dongs.json", "/data/summary.json", "/data/seoul_gu.geojson"].map((u) => fetch(u).then((r) => {
        if (!r.ok) throw new Error(u);
        return r.json();
      })),
    );
    Object.assign(state, { districts, summary, geo });
  } catch {
    showError("기본 자료를 불러오지 못했습니다. 새로고침해 주세요.");
    return;
  }
  $("updated").textContent = state.summary.updated;

  // ?gu=11620&dong=10200&usage=3&metric=perM2 공유 링크
  const params = new URLSearchParams(location.search);
  if (USAGE_KEYS.includes(params.get("usage"))) state.usage = params.get("usage");
  if (params.get("metric") === "perM2") state.metric = "perM2";
  setSeg("usage", state.usage);
  setSeg("metric", state.metric);

  bindSeg("usage", (v) => { state.usage = v; setUrl(); render(); });
  bindSeg("metric", (v) => { state.metric = v; setUrl(); render(); });
  $("reset").addEventListener("click", () => selectGu(null));
  $("dong").addEventListener("change", () => { $("run").disabled = !$("dong").value; });
  $("dong-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const dn = state.gu?.dongs.find((x) => x.code === $("dong").value);
    if (dn) loadDong(state.gu, dn);
  });
  $("download").addEventListener("click", downloadCsv);
  window.addEventListener("resize", debounce(() => { drawMap(); drawChart(); }, 150));

  const gu = state.districts.find((x) => x.code === params.get("gu"));
  selectGu(gu ? gu.code : null, { keepUrl: true });
  const dn = gu?.dongs.find((x) => x.code === params.get("dong"));
  if (dn) {
    $("dong").value = dn.code;
    loadDong(gu, dn);
  }
}

// ---------- 선택 ----------

function selectGu(code, { keepUrl = false } = {}) {
  state.controller?.abort();
  state.gu = state.districts.find((x) => x.code === code) ?? null;
  Object.assign(state, { dong: null, dongData: null, dongRows: [] });
  $("status").hidden = true;
  $("error").hidden = true;

  const sel = $("dong");
  sel.replaceChildren(option("", "동 선택"), ...(state.gu?.dongs ?? []).map((d) => option(d.code, d.name)));
  $("run").disabled = true;
  if (!keepUrl) setUrl();
  render();
}

function setUrl() {
  const q = new URLSearchParams();
  if (state.gu) q.set("gu", state.gu.code);
  if (state.gu && state.dong) q.set("dong", state.dong.code);
  if (state.usage !== "all") q.set("usage", state.usage);
  if (state.metric !== "deposit") q.set("metric", state.metric);
  history.replaceState(null, "", q.size ? `?${q}` : location.pathname);
}

// 지금 보여줄 대상과 비교 대상(한 단계 위)
function currentView() {
  const R = state.summary.regions;
  if (state.dong && state.dongData) {
    return { kind: "dong", name: `${state.gu.name} ${state.dong.name}`, data: state.dongData,
      ref: R[state.gu.code], refName: state.gu.name };
  }
  if (state.gu) {
    return { kind: "gu", name: state.gu.name, data: R[state.gu.code] ?? emptyRegion(), ref: R.seoul, refName: "서울시 전체" };
  }
  return { kind: "seoul", name: "서울시 전체", data: R.seoul, ref: null };
}

function emptyRegion() {
  return Object.fromEntries(USAGE_KEYS.map((k) => [k, { years: {}, monthly: { deposit: [], perM2: [] } }]));
}

// ---------- 지표 계산 ----------

const val = (s) => (s == null ? null : state.metric === "perM2" ? s.perM2 : s.median);

function changeOf(years) {
  const ys = YEARS.map(String).filter((y) => years?.[y] && val(years[y]) != null);
  const latest = ys.at(-1);
  const base = ys.find((y) => y !== latest && years[y].months.length >= MIN_MONTHS_FOR_BASE);
  if (!base || !latest) return null;
  const from = val(years[base]), to = val(years[latest]);
  return { base: Number(base), latest: Number(latest), from, to, pct: (to / from - 1) * 100,
    nBase: years[base].n, nLatest: years[latest].n };
}

// 지도용: 서울 전체와 같은 기간으로 비교한 자치구별 변화율
function guChanges() {
  const R = state.summary.regions;
  const ref = changeOf(R.seoul[state.usage].years);
  const out = new Map();
  if (!ref) return { ref, out };
  for (const f of state.geo.features) {
    const code = f.properties.code;
    const ys = R[code]?.[state.usage]?.years;
    const b = ys?.[ref.base], l = ys?.[ref.latest];
    if (!b || !l || b.n < MIN_DEALS_FOR_MAP || l.n < MIN_DEALS_FOR_MAP || !val(b) || !val(l)) continue;
    out.set(code, { pct: (val(l) / val(b) - 1) * 100, from: val(b), to: val(l), nLatest: l.n });
  }
  return { ref, out };
}

// 동 원자료 → summary 와 같은 모양
function aggregateRows(rows) {
  const out = { allDeals: Object.fromEntries(YEARS.map((y) => [String(y), 0])) };
  for (const r of rows) {
    const y = r[DAY].slice(0, 4);
    if (y in out.allDeals) out.allDeals[y]++;
  }
  const jeonse = rows.filter((r) => r[SE] === 0 && r[DEP] > 0);
  for (const key of USAGE_KEYS) {
    const sub = key === "all" ? jeonse : jeonse.filter((r) => r[USG] === Number(key));
    const years = {};
    for (const [y, g] of groupBy(sub, (r) => r[DAY].slice(0, 4))) {
      if (!YEARS.includes(Number(y))) continue;
      const dep = g.map((r) => r[DEP]);
      years[y] = {
        n: g.length,
        mean: dep.reduce((a, b) => a + b, 0) / g.length,
        median: median(dep),
        perM2: median(g.filter((r) => r[AREA] > 0).map((r) => r[DEP] / r[AREA])),
        months: [...new Set(g.map((r) => Number(r[DAY].slice(4, 6))))].sort((a, b) => a - b),
      };
    }
    const monthly = { deposit: [], perM2: [] };
    for (const [ym, g] of [...groupBy(sub, (r) => r[DAY].slice(0, 6))].sort(([a], [b]) => a.localeCompare(b))) {
      if (g.length >= MIN_DEALS_PER_MONTH) monthly.deposit.push([ym, median(g.map((r) => r[DEP])), g.length]);
      const pm = g.filter((r) => r[AREA] > 0).map((r) => r[DEP] / r[AREA]);
      if (pm.length >= MIN_DEALS_PER_MONTH) monthly.perM2.push([ym, median(pm), pm.length]);
    }
    out[key] = { years, monthly };
  }
  return out;
}

// ---------- 렌더링 ----------

function render() {
  if (!state.summary) return;
  const view = currentView();
  renderCrumbs(view);
  renderPanel(view);
  drawMap();
  drawChart();
  renderYearTable(view);
  renderUsageTable(view);
  renderRaw(view);
}

function renderCrumbs(view) {
  const nav = $("crumbs");
  const items = [];
  const link = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.addEventListener("click", fn); return b; };
  const here = (text) => { const s = document.createElement("span"); s.className = "here"; s.textContent = text; s.setAttribute("aria-current", "page"); return s; };
  const sep = () => { const s = document.createElement("span"); s.className = "sep"; s.textContent = "›"; return s; };
  if (view.kind === "seoul") items.push(here("서울시 전체"));
  else {
    items.push(link("서울시 전체", () => selectGu(null)), sep());
    if (view.kind === "gu") items.push(here(state.gu.name));
    else items.push(link(state.gu.name, () => selectGu(state.gu.code)), sep(), here(state.dong.name));
  }
  nav.replaceChildren(...items);
  $("reset").hidden = view.kind === "seoul";
}

function renderPanel(view) {
  $("place-kind").textContent = { seoul: "서울특별시", gu: "자치구", dong: `${state.gu?.name} · 법정동` }[view.kind];
  $("place").textContent = view.kind === "dong" ? state.dong.name : view.name;

  const u = view.data[state.usage];
  const chg = changeOf(u.years);
  const unit = state.metric === "perM2" ? "㎡당 " : "";
  const latestY = YEARS.map(String).filter((y) => u.years[y]).at(-1);
  const latest = latestY ? u.years[latestY] : null;
  const tiles = [];

  if (chg) {
    let extra = "";
    if (view.kind === "gu") {
      const { out } = guChanges();
      const ranked = [...out.entries()].sort((a, b) => b[1].pct - a[1].pct);
      const rank = ranked.findIndex(([c]) => c === state.gu.code);
      if (rank >= 0) extra = ` · 서울 ${ranked.length}개 구 중 ${rank + 1}위`;
    } else if (view.kind === "seoul") {
      const { out } = guChanges();
      const top = [...out.entries()].sort((a, b) => b[1].pct - a[1].pct)[0];
      if (top) extra = ` · 최대 ${state.summary.regions[top[0]].name} ${fmtPct(top[1].pct)}`;
    }
    tiles.push(kpi(`${chg.base} → ${chg.latest} ${unit}전세 중위값 변화`, fmtPct(chg.pct),
      `${fmtMetric(chg.from)} → ${fmtMetric(chg.to)}${extra}`, chg.pct >= 0 ? "up" : "down", true));
  } else {
    tiles.push(kpi("기간 변화", "–", "비교할 연도 자료가 부족합니다", null, true));
  }
  tiles.push(kpi(`${latestY ?? ""}년 ${unit}중위값`, latest ? fmtMetric(val(latest)) : "–",
    latest ? `${fmtInt(latest.n)}건 · ${monthRange(latest.months)}` : "전세 거래 없음"));
  if (state.metric === "perM2") {
    tiles.push(kpi(`${latestY ?? ""}년 보증금 중위값`, latest ? fmtMan(latest.median) : "–", ""));
  } else {
    tiles.push(kpi(`${latestY ?? ""}년 ㎡당 중위값`, latest?.perM2 ? `${fmtNum(latest.perM2, 0)}만원` : "–",
      latest?.perM2 ? `3.3㎡(평)당 ${fmtMan(latest.perM2 * 3.3058)}` : ""));
  }
  const nJ = Object.values(u.years).reduce((a, s) => a + s.n, 0);
  const nAll = Object.values(view.data.allDeals ?? {}).reduce((a, b) => a + b, 0);
  tiles.push(kpi("전세 거래 (5년)", `${fmtInt(nJ)}건`,
    state.usage === "all" && nAll ? `전월세 신고 ${fmtInt(nAll)}건 중 ${fmtNum((nJ / nAll) * 100, 0)}%` : USAGES[state.usage] ?? ""));
  $("kpis").replaceChildren(...tiles);

  $("dong-form").hidden = !state.gu;
  $("panel-note").textContent = {
    seoul: "지도에서 자치구를 누르면 그 구의 결과로 바뀝니다.",
    gu: "동을 고르면 그 동의 신고 자료를 모두 불러와 보여줍니다.",
    dong: "동별 결과는 조회할 때 새로 불러온 자료입니다.",
  }[view.kind];
}

function kpi(label, value, sub, tone, hero) {
  const el = div(hero ? "kpi hero" : "kpi");
  el.append(div("label", label), div("value", value));
  const s = div("sub");
  if (tone) {
    const t = document.createElement("span");
    t.className = tone;
    t.textContent = tone === "up" ? "▲ 상승" : "▼ 하락";
    s.append(t, " · ");
  }
  s.append(sub || "");
  el.append(s);
  return el;
}

// ---------- 지도 ----------

function drawMap() {
  const host = $("map");
  const W = host.clientWidth, H = host.clientHeight;
  if (!W || !state.geo) return;
  const { ref, out } = guChanges();
  const max = Math.max(5, ...[...out.values()].map((c) => Math.abs(c.pct)));
  const M = Math.ceil(max / 5) * 5; // 0을 가운데 둔 대칭 범위

  $("map-title").textContent = `자치구별 전세 ${state.metric === "perM2" ? "㎡당 보증금" : "보증금"} 변화율`;
  $("map-note").textContent = ref
    ? `${ref.base}년 → ${ref.latest}년 중위값 기준 · ${state.usage === "all" ? "전체 유형" : USAGES[state.usage]} · 자치구를 누르면 상세 결과`
    : "비교할 자료가 없습니다.";

  // 위도 37.55°에서의 경도 축척으로 단순 투영
  const k = Math.cos((37.55 * Math.PI) / 180);
  const pts = state.geo.features.flatMap((f) => rings(f.geometry).flat());
  const xs = pts.map((p) => p[0] * k), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 8;
  const s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  const P = ([lon, lat]) => [ox + (lon * k - x0) * s, oy + (y1 - lat) * s];

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "group" });
  const labels = el("g");
  const tip = $("tip");
  host.classList.toggle("has-sel", !!state.gu);

  for (const f of state.geo.features) {
    const { code, name } = f.properties;
    const c = out.get(code);
    const fill = c ? piyg((c.pct + M) / (2 * M)) : "#e9edee"; // = --nodata (SVG 속성에는 CSS 변수를 못 씀)
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const d = polys.map((poly) => poly.map((ring) => ring.map((p, i) => `${i ? "L" : "M"}${P(p).map((v) => v.toFixed(1)).join(",")}`).join("") + "Z").join("")).join("");
    const path = el("path", { d, fill, tabindex: "0", role: "button",
      "aria-label": `${name} ${c ? fmtPct(c.pct) : "자료 부족"}`, "aria-pressed": String(state.gu?.code === code) });
    if (state.gu?.code === code) path.classList.add("sel");

    const show = (ev) => {
      tip.replaceChildren(bold(name), document.createElement("br"),
        ...(c ? [`${ref.base} → ${ref.latest}: ${fmtPct(c.pct)}`, document.createElement("br"),
          `${fmtMetric(c.from)} → ${fmtMetric(c.to)}`, document.createElement("br"),
          `${ref.latest}년 전세 ${fmtInt(c.nLatest)}건`] : ["거래가 적어 비교하지 않음"]));
      placeTip(ev.clientX, ev.clientY);
    };
    path.addEventListener("pointermove", show);
    path.addEventListener("pointerleave", () => { tip.hidden = true; });
    path.addEventListener("click", () => { tip.hidden = true; selectGu(state.gu?.code === code ? null : code); });
    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectGu(state.gu?.code === code ? null : code); }
    });
    svg.append(path);

    // 라벨: 가장 큰 조각의 무게중심
    const [cx, cy] = centroid(largestRing(polys).map(P));
    const t = el("text", { x: cx, y: cy, class: `label ${c && luminance(fill) < 0.4 ? "light" : "dark"}` });
    t.append(el("tspan", { x: cx, dy: c ? "-0.2em" : "0.35em" }, name));
    if (c) t.append(el("tspan", { x: cx, dy: "1.15em", class: "v" }, fmtPct(c.pct)));
    labels.append(t);
  }
  // 선택한 구를 맨 위로 올려 테두리가 가려지지 않게
  const selPath = svg.querySelector("path.sel");
  if (selPath) svg.append(selPath);
  svg.append(labels);
  host.replaceChildren(svg);
  drawLegend(M, out.size < state.geo.features.length);
}

function drawLegend(M, hasNoData) {
  const lg = $("legend");
  const ramp = div("ramp");
  ramp.style.background = `linear-gradient(to right, ${PIYG.join(", ")})`;
  const ticks = div("ticks");
  for (const v of [-M, -M / 2, 0, M / 2, M]) {
    const s = document.createElement("span");
    s.textContent = v === 0 ? "0%" : fmtPct(v).replace(".0", "");
    ticks.append(s);
  }
  const poles = div("poles");
  poles.append(Object.assign(document.createElement("span"), { textContent: "◀ 하락" }),
    Object.assign(document.createElement("span"), { textContent: "상승 ▶" }));
  const items = [div("label", "중위값 변화율"), ramp, ticks, poles];
  if (hasNoData) {
    const nd = div("nodata");
    nd.append(document.createElement("i"), `거래 ${MIN_DEALS_FOR_MAP}건 미만 (비교 안 함)`);
    items.push(nd);
  }
  lg.replaceChildren(...items);
}

function piyg(t) {
  const x = Math.min(1, Math.max(0, t)) * (PIYG.length - 1);
  const i = Math.min(PIYG.length - 2, Math.floor(x)), f = x - i;
  const a = hexRgb(PIYG[i]), b = hexRgb(PIYG[i + 1]);
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
}
function hexRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function luminance(rgb) {
  const c = rgb.startsWith("#") ? hexRgb(rgb) : rgb.match(/\d+/g).map(Number);
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function rings(g) { return g.type === "Polygon" ? g.coordinates : g.coordinates.flat(); }
function largestRing(polys) {
  return polys.map((p) => p[0]).reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
}
function area(r) { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; }
function centroid(r) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const c = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a += c; x += (r[i][0] + r[i + 1][0]) * c; y += (r[i][1] + r[i + 1][1]) * c;
  }
  return [x / (3 * a), y / (3 * a)];
}

// ---------- 동 조회 ----------

async function loadDong(gu, dong) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  $("error").hidden = true;
  $("status").hidden = false;
  $("run").disabled = true;
  const label = `${gu.name} ${dong.name} 자료를 불러오는 중…`;
  setStatus(label, 0, 0);

  const totals = new Map();
  const byYear = new Map(API_YEARS.map((y) => [y, []]));
  let archive = [], received = 0;
  const progress = () => {
    const total = [...totals.values()].reduce((a, b) => a + b, 0) + archive.length;
    setStatus(label, received + archive.length, total);
  };

  try {
    const [arch, ...firsts] = await Promise.all([
      fetchArchive(gu.code, dong.code, controller.signal),
      ...API_YEARS.map((y) => fetchChunk(gu.code, dong.code, y, 0, controller.signal)),
    ]);
    archive = arch;
    const rest = [];
    for (const r of firsts) {
      totals.set(r.year, r.total);
      byYear.get(r.year).push(...r.rows);
      received += r.rows.length;
      for (let c = 1; c < Math.ceil(r.total / r.chunkSize); c++) rest.push([r.year, c]);
    }
    progress();
    await pool(rest, CONCURRENCY, async ([y, c]) => {
      const r = await fetchChunk(gu.code, dong.code, y, c, controller.signal);
      byYear.get(y).push(...r.rows);
      received += r.rows.length;
      progress();
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    $("status").hidden = true;
    $("run").disabled = false;
    showError(err.message || "자료를 불러오지 못했습니다.");
    return;
  }
  if (state.controller !== controller) return;

  state.dongRows = archive.concat(API_YEARS.flatMap((y) => byYear.get(y)));
  state.dongData = aggregateRows(state.dongRows);
  state.dong = dong;
  $("status").hidden = true;
  $("run").disabled = false;
  setUrl();
  render();
}

// 과거 연도 정적 파일. 해당 연도에 신고가 한 건도 없던 동은 파일이 없다(404 → 빈 배열).
async function fetchArchive(gu, dong, signal) {
  const res = await fetch(`/data/archive/${gu}_${dong}.json`, { signal });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`과거 연도 자료를 불러오지 못했습니다 (${res.status})`);
  return (await res.json()).rows;
}

async function fetchChunk(gu, dong, year, chunk, signal) {
  const qs = new URLSearchParams({ gu, dong, year: String(year), chunk: String(chunk) });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/rent?${qs}`, { signal });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      lastErr = new Error(body.error || `요청 실패 (${res.status})`);
      if (res.status < 500) break;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastErr = new Error("네트워크 오류로 자료를 받지 못했습니다.");
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw lastErr;
}

async function pool(items, size, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) await worker(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

function setStatus(text, done, total) {
  $("status-text").textContent = text;
  $("status-count").textContent = total ? `${fmtInt(done)} / ${fmtInt(total)}건` : "";
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("bar-fill").style.width = `${pct}%`;
  document.querySelector(".bar").setAttribute("aria-valuenow", String(pct));
}

// ---------- 표 ----------

function renderYearTable(view) {
  const ys = view.data[state.usage].years;
  const head = ["연도", "계약월", "전세 건수", "평균 보증금", "중위 보증금", "㎡당 중위값", "전년 대비"];
  let prev = null;
  const body = YEARS.map((y) => {
    const s = ys[String(y)];
    if (!s) { prev = null; return [String(y), { text: "전세 거래 없음", cls: "na left", span: 6 }]; }
    const chg = prev && val(prev) && val(s) ? (val(s) / val(prev) - 1) * 100 : null;
    prev = s;
    return [
      String(y), monthRange(s.months), fmtInt(s.n), fmtMan(s.mean), fmtMan(s.median),
      s.perM2 ? `${fmtNum(s.perM2, 0)}만원` : "–",
      chg == null ? { text: "–", cls: "na" } : { text: fmtPct(chg), cls: chg >= 0 ? "chg-up" : "chg-down" },
    ];
  });
  fillTable($("year-table"), head, body);
  $("coverage-note").textContent =
    `${ARCHIVE_YEARS.join("·")}년 접수분은 열린데이터광장 연도별 파일, ${API_YEARS[0]}~${API_YEARS.at(-1)}년 접수분은 OpenAPI에서 가져옵니다. ` +
    `전년 대비는 ${state.metric === "perM2" ? "㎡당 중위값" : "중위 보증금"} 기준이며, 계약월이 ${MIN_MONTHS_FOR_BASE}개월 미만인 연도는 기간 변화율 기준에서 제외합니다.`;
}

function renderUsageTable(view) {
  $("usage-title").textContent = `주택 유형별 중위 전세 ${state.metric === "perM2" ? "㎡당 보증금" : "보증금"}`;
  const present = YEARS.filter((y) => view.data.all.years[String(y)]);
  const lines = USAGES.map((name, i) => {
    const ys = view.data[String(i)].years;
    return { name, ys, n: Object.values(ys).reduce((a, s) => a + s.n, 0), chg: changeOf(ys) };
  }).filter((l) => l.n > 0);
  const max = Math.max(1, ...lines.flatMap((l) => present.map((y) => val(l.ys[String(y)]) ?? 0)));
  const head = ["유형", ...present.map((y) => `${y}`), "기간 변화", "건수"];
  const body = lines.map((l) => [
    l.name,
    ...present.map((y) => {
      const v = val(l.ys[String(y)]);
      return v ? { text: fmtMetricShort(v), bar: v / max } : { text: "–", cls: "na" };
    }),
    l.chg ? { text: fmtPct(l.chg.pct), cls: l.chg.pct >= 0 ? "chg-up" : "chg-down" } : { text: "–", cls: "na" },
    fmtInt(l.n),
  ]);
  fillTable($("usage-table"), head, body.length ? body : [[{ text: "전세 거래가 없습니다.", cls: "na left", span: head.length }]]);
}

function renderRaw(view) {
  $("raw-card").hidden = view.kind !== "dong";
  if (view.kind !== "dong") return;
  const rows = state.dongRows.filter((r) => r[SE] === 0 && r[DEP] > 0 &&
    (state.usage === "all" || r[USG] === Number(state.usage)));
  const recent = [...rows].sort((a, b) => b[DAY].localeCompare(a[DAY])).slice(0, 20);
  $("raw-count").textContent = `(전체 ${fmtInt(rows.length)}건 중 최근 ${recent.length}건)`;
  const head = ["계약일", "유형", "건물명", "면적(㎡)", "층", "보증금", "구분"];
  const body = recent.map((r) => [
    fmtDay(r[DAY]), USAGES[r[USG]] ?? "–", r[NAME] || "–",
    fmtNum(r[AREA], 1), r[FLR] ?? "–", fmtMan(r[DEP]), r[NEW] === 0 ? "신규" : r[NEW] === 1 ? "갱신" : "–",
  ]);
  fillTable($("raw-table"), head, body.length ? body : [[{ text: "전세 거래가 없습니다.", cls: "na left", span: head.length }]]);
}

// ---------- 월별 추이 차트 (SVG) ----------

const MAX_BRIDGE_GAP = 3;     // 빠진 달이 이 이하로 연속이면 점선으로 잇는다
const SPARSE_COVERAGE = 0.5;  // 그릴 수 있는 달이 기간의 이 비율 미만이면 연도별로 바꾼다
const MIN_MONTHLY_POINTS = 6; // 그릴 수 있는 달이 이보다 적어도 연도별로 바꾼다

function drawChart() {
  if (!state.summary) return;
  const view = currentView();
  const host = $("chart");
  const metricName = state.metric === "perM2" ? "㎡당 보증금" : "보증금";
  const usageName = state.usage === "all" ? "전체 유형" : USAGES[state.usage];

  const toMonthly = (data) => (data?.[state.usage]?.monthly[state.metric] ?? [])
    .map(([ym, y, n]) => ({ key: ym, t: monthIndex(ym), y, n }));
  const toYearly = (data) => YEARS.map(String).flatMap((yr) => {
    const s = data?.[state.usage]?.years[yr];
    return s && s.n >= MIN_DEALS_PER_MONTH && val(s) != null
      ? [{ key: yr, t: Number(yr) * 12 + 5.5, y: val(s), n: s.n, months: s.months }] : [];
  });

  // 거래가 드문 경우 월별 점을 잇지 않고 연도별 중위값으로 보여준다
  const monthly = toMonthly(view.data);
  const span = monthly.length ? monthly.at(-1).t - monthly[0].t + 1 : 0;
  const yearly = monthly.length < MIN_MONTHLY_POINTS || monthly.length / span < SPARSE_COVERAGE;
  const pts = yearly ? toYearly(view.data) : monthly;
  const ref = view.ref ? (yearly ? toYearly(view.ref) : toMonthly(view.ref)) : [];
  const step = yearly ? 12 : 1;

  $("chart-title").textContent = `${yearly ? "연도별" : "월별"} 전세 ${metricName} 중위값 — ${view.name}`;
  $("chart-note").textContent = yearly
    ? `월별 거래가 적어 연도별로 표시합니다 (거래 ${MIN_DEALS_PER_MONTH}건 이상인 달 ${monthly.length}개월${span ? ` / ${span}개월` : ""}) · 계약일 기준 · ${usageName}`
    : `계약월 기준 · ` +
      (span - monthly.length
        ? `거래 ${MIN_DEALS_PER_MONTH}건 미만 ${span - monthly.length}개월 제외 (${MAX_BRIDGE_GAP}개월 이하 공백은 점선으로 연결)`
        : `매달 거래 ${MIN_DEALS_PER_MONTH}건 이상`) + ` · ${usageName}`;

  if (!pts.length) {
    $("chart-legend").replaceChildren();
    host.replaceChildren(div("empty", "추이를 그릴 만큼 거래가 없습니다."));
    return;
  }

  const W = host.clientWidth, H = host.clientHeight;
  const m = { t: 12, r: 16, b: 28, l: 60 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const t0 = yearly ? Math.floor(pts[0].t / 12) * 12 : pts[0].t;
  const t1 = yearly ? Math.floor(pts.at(-1).t / 12) * 12 + 11 : pts.at(-1).t;
  const inRange = ref.filter((p) => p.t >= t0 && p.t <= t1);
  const all = pts.concat(inRange);
  const [lo, hi] = niceRange(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)));
  const x = (t) => m.l + ((t - t0) / Math.max(t1 - t0, 1)) * iw;
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": $("chart-title").textContent });
  const grid = el("g", { class: "grid" }), axis = el("g", { class: "axis" });
  for (const v of ticks(lo, hi, 5)) {
    grid.append(el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    axis.append(el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, fmtAxis(v)));
  }
  for (let yr = Math.floor(t0 / 12); yr <= Math.floor(t1 / 12); yr++) {
    const tj = yr * 12;
    if (tj > t0) grid.append(el("line", { class: "year-sep", x1: x(tj), x2: x(tj), y1: m.t, y2: m.t + ih }));
    const mid = Math.min(Math.max((Math.max(tj, t0) + Math.min(tj + 11, t1)) / 2, t0), t1);
    axis.append(el("text", { x: x(mid), y: H - 6, "text-anchor": "middle" }, `${yr}년`));
  }
  svg.append(grid, el("line", { class: "baseline", x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }), axis);

  // 비교선(한 단계 위 지역)을 먼저, 대상 지역을 위에
  for (const s of segments(inRange, step)) if (s.length > 1) svg.append(el("path", { class: "series ref", d: linePath(s, x, y) }));

  const segs = segments(pts, step);
  let bridged = false;
  for (let i = 1; i < segs.length && !yearly; i++) {
    const a = segs[i - 1].at(-1), b = segs[i][0];
    if (b.t - a.t - 1 <= MAX_BRIDGE_GAP) {
      svg.append(el("path", { class: "series bridge", d: linePath([a, b], x, y) }));
      bridged = true;
    }
  }
  for (const s of segs) {
    if (s.length > 1) {
      const d = linePath(s, x, y);
      // 채움 면은 끊김 없는 선일 때만 (공백마다 면이 끊기면 기둥처럼 보여 산만하다)
      if (!yearly && segs.length === 1) svg.append(el("path", { class: "area", d: `${d}L${x(s.at(-1).t)},${m.t + ih}L${x(s[0].t)},${m.t + ih}Z` }));
      svg.append(el("path", { class: "series", d }));
    }
  }
  // 연도별: 모든 점 + 거래 건수 / 월별: 외따로 떨어진 달과 마지막 달만 점
  for (const p of pts) {
    const lonely = segs.some((s) => s.length === 1 && s[0] === p);
    if (yearly || lonely || p === pts.at(-1)) {
      svg.append(el("circle", { class: "dot", cx: x(p.t), cy: y(p.y), r: yearly ? 5 : 4 }));
    }
    if (yearly) svg.append(el("text", { class: "count", x: x(p.t), y: y(p.y) + 20 }, `${fmtInt(p.n)}건`));
  }

  renderChartLegend(view, ref.length > 0, bridged);

  const cross = el("line", { class: "cross", y1: m.t, y2: m.t + ih, visibility: "hidden" });
  const focus = el("circle", { class: "dot", r: 5, visibility: "hidden" });
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
  svg.append(cross, focus, hit);
  const tip = $("tip");
  const refBy = new Map(inRange.map((p) => [p.t, p]));
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const p = pts.reduce((a, b) => (Math.abs(x(b.t) - px) < Math.abs(x(a.t) - px) ? b : a));
    cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t));
    focus.setAttribute("cx", x(p.t)); focus.setAttribute("cy", y(p.y));
    cross.setAttribute("visibility", "visible"); focus.setAttribute("visibility", "visible");
    const r = refBy.get(p.t);
    const head = yearly ? `${p.key}년 (${monthRange(p.months)})` : `${p.key.slice(0, 4)}년 ${Number(p.key.slice(4))}월`;
    tip.replaceChildren(bold(head), document.createElement("br"),
      `${view.name} ${fmtMetric(p.y)} (${fmtInt(p.n)}건)`,
      ...(r ? [document.createElement("br"), `${view.refName} ${fmtMetric(r.y)}`] : []));
    placeTip(ev.clientX, ev.clientY);
  };
  const leave = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden"); focus.setAttribute("visibility", "hidden");
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
  host.replaceChildren(svg);
}

function renderChartLegend(view, hasRef, bridged) {
  const item = (cls, text) => {
    const s = document.createElement("span"), i = document.createElement("i");
    if (cls) i.className = cls;
    s.append(i, text);
    return s;
  };
  const items = [];
  if (hasRef || bridged) items.push(item("", view.name));
  if (bridged) items.push(item("bridge", `거래 ${MIN_DEALS_PER_MONTH}건 미만인 달 (건너뜀)`));
  if (hasRef) items.push(item("ref", `${view.refName} (비교)`));
  $("chart-legend").replaceChildren(...items);
}

function segments(pts, step = 1) {
  const segs = [];
  for (const p of pts) {
    const last = segs.at(-1);
    if (last && p.t - last.at(-1).t === step) last.push(p); else segs.push([p]);
  }
  return segs;
}
function linePath(s, x, y) { return s.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.y)}`).join(""); }

function placeTip(cx, cy) {
  const tip = $("tip");
  tip.hidden = false;
  const tx = Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 8);
  const ty = cy - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(8, tx)}px`;
  tip.style.top = `${ty < 8 ? cy + 16 : ty}px`;
}

// ---------- CSV ----------

function downloadCsv() {
  const head = ["계약일", "전월세구분", "건물용도", "임대면적_㎡", "보증금_만원", "임대료_만원", "층", "건축년도", "신규갱신", "건물명"];
  const lines = [head.join(",")];
  for (const r of state.dongRows) {
    lines.push([
      r[DAY], r[SE] === 0 ? "전세" : "월세", USAGES[r[USG]] ?? "", r[AREA] ?? "", r[DEP] ?? "", r[RENT] ?? "",
      r[FLR] ?? "", r[ARCH] ?? "", r[NEW] === 0 ? "신규" : r[NEW] === 1 ? "갱신" : "", r[NAME],
    ].map(csvCell).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `seoul_rent_${state.gu.name}_${state.dong.name}_2022-2026.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s; // 엑셀 수식 주입 방지
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// ---------- 유틸 ----------

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
function monthIndex(yyyymm) { return Number(yyyymm.slice(0, 4)) * 12 + Number(yyyymm.slice(4, 6)) - 1; }
function monthRange(ms) {
  if (!ms?.length) return "–";
  return ms.length === 1 ? `${ms[0]}월` : `${ms[0]}–${ms.at(-1)}월`;
}
function niceRange(min, max) {
  const pad = (max - min) * 0.1 || max * 0.1 || 1;
  const step = niceStep((max - min + 2 * pad) / 5);
  return [Math.max(0, Math.floor((min - pad) / step) * step), Math.ceil((max + pad) / step) * step];
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function ticks(lo, hi, n) {
  const step = niceStep((hi - lo) / n);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

const nf = new Intl.NumberFormat("ko-KR");
function fmtInt(n) { return nf.format(Math.round(n)); }
function fmtNum(n, d) { return n == null ? "–" : n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(p) { return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`; }
function fmtDay(d) { return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`; }
// 만원 → "3억 2,000만원"
function fmtMan(v) {
  if (v == null) return "–";
  const r = Math.round(v);
  const eok = Math.floor(r / 10000), man = r % 10000;
  if (!eok) return `${fmtInt(man)}만원`;
  return man ? `${eok}억 ${fmtInt(man)}만원` : `${eok}억원`;
}
function fmtMetric(v) { return v == null ? "–" : state.metric === "perM2" ? `${fmtNum(v, 0)}만원/㎡` : fmtMan(v); }
// 표 칸용 짧은 표기: "3.9억", "8,500만"
function fmtMetricShort(v) {
  if (state.metric === "perM2") return `${fmtNum(v, 0)}만`;
  return v >= 10000 ? `${fmtNum(v / 10000, 2)}억` : `${fmtInt(v)}만`;
}
function fmtAxis(v) {
  if (v === 0) return "0";
  if (state.metric === "perM2") return fmtInt(v);
  return v >= 10000 ? `${fmtNum(v / 10000, v % 10000 ? 1 : 0)}억` : `${fmtInt(v)}만`;
}

function fillTable(table, head, rows) {
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  const hr = document.createElement("tr");
  for (const h of head) { const th = document.createElement("th"); th.textContent = h; hr.append(th); }
  thead.append(hr);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const c of row) {
      const td = document.createElement("td");
      if (c && typeof c === "object") {
        td.textContent = c.text;
        if (c.cls) td.className = c.cls;
        if (c.span) td.colSpan = c.span;
        if (c.bar) {
          const b = document.createElement("span");
          b.className = "cellbar";
          b.style.width = `${Math.max(4, c.bar * 40)}px`;
          td.append(b);
        }
      } else {
        td.textContent = c;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

function setSeg(id, v) {
  $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
}

function bindSeg(id, onChange) {
  const seg = $(id);
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onChange(b.dataset.v);
  });
}

function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = false; }
function option(v, t) { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }
function div(cls, text) { const d = document.createElement("div"); d.className = cls; if (text != null) d.textContent = text; return d; }
function bold(t) { const b = document.createElement("b"); b.textContent = t; return b; }
function el(tag, attrs = {}, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
