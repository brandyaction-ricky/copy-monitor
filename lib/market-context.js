const FMP_HOST = "https://financialmodelingprep.com/stable";
const BLS_API = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const BLS_CALENDAR = "https://www.bls.gov/schedule/news_release/bls.ics";
const TREASURY_FEED = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

const FOMC_DECISIONS = [
  [2026, 1, 28], [2026, 3, 18], [2026, 4, 29], [2026, 6, 17],
  [2026, 7, 29], [2026, 9, 16], [2026, 10, 28], [2026, 12, 9],
  [2027, 1, 27], [2027, 3, 17], [2027, 4, 28], [2027, 6, 9],
  [2027, 7, 28], [2027, 9, 15], [2027, 10, 27], [2027, 12, 8],
];

const BLS_RELEASES_2026 = [
  ["CPI", 8, 12], ["CPI", 9, 11], ["CPI", 10, 14], ["CPI", 11, 10], ["CPI", 12, 10],
  ["PPI", 8, 13], ["PPI", 9, 10], ["PPI", 10, 15], ["PPI", 11, 13], ["PPI", 12, 15],
  ["JOBS", 9, 4], ["JOBS", 10, 2], ["JOBS", 11, 6], ["JOBS", 12, 4],
];

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[%,$]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);
const compactDate = (date) => isoDay(date).replaceAll("-", "");
const fmpDate = (date) => isoDay(date);

async function fetchText(url, options = {}, timeout = 8_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  return response.text();
}

async function fetchJson(url, options = {}, timeout = 8_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  const payload = await response.json();
  if (payload?.Error || payload?.error) throw new Error(payload.Error || payload.error);
  return payload;
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone = "America/New_York") {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute));
  return new Date(guess - (represented - guess));
}

function parseCalendarDate(line) {
  const value = line.slice(line.indexOf(":") + 1).trim();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return null;
  const [, year, month, day, hour = "12", minute = "00", , utc] = match;
  if (utc) return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  const rawZone = line.match(/TZID=([^;:]+)/)?.[1] || "America/New_York";
  const zone = rawZone === "US-Eastern" ? "America/New_York" : rawZone;
  return zonedTimeToUtc(Number(year), Number(month), Number(day), Number(hour), Number(minute), zone);
}

function eventCategory(name = "") {
  if (/consumer price|\bcpi\b/i.test(name)) return "CPI";
  if (/producer price|\bppi\b/i.test(name)) return "PPI";
  if (/employment situation|nonfarm|payroll|unemployment/i.test(name)) return "JOBS";
  if (/fomc|fed interest rate|federal funds|interest rate decision/i.test(name)) return "FOMC";
  if (/personal consumption|\bpce\b/i.test(name)) return "PCE";
  if (/gross domestic|\bgdp\b/i.test(name)) return "GDP";
  return null;
}

export function parseIcsEvents(ics, now = new Date()) {
  const unfolded = String(ics).replace(/\r?\n[ \t]/g, "");
  const start = now.getTime() - 24 * 60 * 60 * 1000;
  const end = now.getTime() + 120 * 24 * 60 * 60 * 1000;
  return [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((match) => {
    const body = match[1];
    const summary = body.match(/\nSUMMARY[^:]*:([^\r\n]+)/)?.[1]?.replace(/\\,/g, ",").replace(/\\n/g, " ").trim();
    const dateLine = body.match(/\nDTSTART[^\r\n]+/)?.[0]?.trim();
    const date = dateLine ? parseCalendarDate(dateLine) : null;
    const category = eventCategory(summary);
    if (category === "JOBS" && !/^Employment Situation/i.test(summary)) return null;
    if (!summary || !date || !category || date.getTime() < start || date.getTime() > end) return null;
    return {
      id: `bls-${category}-${compactDate(date)}`,
      category,
      name: category === "CPI" ? "미국 소비자물가지수(CPI)" : category === "PPI" ? "미국 생산자물가지수(PPI)" : "미국 고용보고서",
      date: date.toISOString(),
      country: "US",
      impact: "HIGH",
      actual: null,
      estimate: null,
      previous: null,
      source: "U.S. Bureau of Labor Statistics",
      sourceUrl: "https://www.bls.gov/schedule/",
      official: true,
    };
  }).filter(Boolean);
}

function officialFomcEvents(now = new Date()) {
  const start = now.getTime() - 24 * 60 * 60 * 1000;
  const end = now.getTime() + 180 * 24 * 60 * 60 * 1000;
  return FOMC_DECISIONS.map(([year, month, day]) => {
    const date = zonedTimeToUtc(year, month, day, 14, 0);
    return {
      id: `fed-FOMC-${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
      category: "FOMC",
      name: "FOMC 금리 결정",
      date: date.toISOString(),
      country: "US",
      impact: "HIGH",
      actual: null,
      estimate: null,
      previous: null,
      source: "Federal Reserve",
      sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      official: true,
    };
  }).filter((event) => new Date(event.date).getTime() >= start && new Date(event.date).getTime() <= end);
}

function fallbackBlsEvents(now = new Date()) {
  const start = now.getTime() - 24 * 60 * 60 * 1000;
  const end = now.getTime() + 180 * 24 * 60 * 60 * 1000;
  return BLS_RELEASES_2026.map(([category, month, day]) => {
    const date = zonedTimeToUtc(2026, month, day, 8, 30);
    const name = category === "CPI" ? "미국 소비자물가지수(CPI)" : category === "PPI" ? "미국 생산자물가지수(PPI)" : "미국 고용보고서";
    return {
      id: `bls-${category}-2026${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
      category,
      name,
      date: date.toISOString(),
      country: "US",
      impact: "HIGH",
      actual: null,
      estimate: null,
      previous: null,
      source: "U.S. Bureau of Labor Statistics",
      sourceUrl: "https://www.bls.gov/schedule/2026/home.htm",
      official: true,
      fallback: true,
    };
  }).filter((event) => new Date(event.date).getTime() >= start && new Date(event.date).getTime() <= end);
}

export function parseBlsSeries(payload) {
  const series = new Map((payload?.Results?.series || []).map((item) => [item.seriesID, item.data || []]));
  const value = (row) => finiteOrNull(row?.value);
  const cpi = series.get("CUUR0000SA0") || [];
  const unemployment = series.get("LNS14000000") || [];
  const payrolls = series.get("CES0000000001") || [];
  const latestCpi = cpi.find((item) => item.period !== "M13");
  const priorCpi = cpi.find((item) => item.period === latestCpi?.period && Number(item.year) === Number(latestCpi?.year) - 1);
  const latestUnemployment = unemployment.find((item) => item.period !== "M13");
  const payrollRows = payrolls.filter((item) => item.period !== "M13");
  const latestPayroll = payrollRows[0];
  const priorPayroll = payrollRows[1];
  return {
    cpiYoY: value(latestCpi) !== null && value(priorCpi) ? (value(latestCpi) / value(priorCpi) - 1) * 100 : null,
    cpiReference: latestCpi ? `${latestCpi.year}-${latestCpi.period.replace("M", "")}` : null,
    unemploymentRate: value(latestUnemployment),
    unemploymentReference: latestUnemployment ? `${latestUnemployment.year}-${latestUnemployment.period.replace("M", "")}` : null,
    payrollChange: value(latestPayroll) !== null && value(priorPayroll) !== null ? value(latestPayroll) - value(priorPayroll) : null,
    payrollReference: latestPayroll ? `${latestPayroll.year}-${latestPayroll.period.replace("M", "")}` : null,
    source: "U.S. Bureau of Labor Statistics",
    sourceUrl: "https://www.bls.gov/developers/",
  };
}

async function loadBlsSnapshot(now = new Date()) {
  const payload = await fetchJson(BLS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seriesid: ["CUUR0000SA0", "LNS14000000", "CES0000000001"],
      startyear: String(now.getUTCFullYear() - 2),
      endyear: String(now.getUTCFullYear()),
    }),
  });
  if (payload?.status !== "REQUEST_SUCCEEDED") throw new Error(payload?.message?.join(" ") || "BLS request failed");
  return parseBlsSeries(payload);
}

export function parseTreasuryXml(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const body = match[1];
    const read = (name) => body.match(new RegExp(`<d:${name}[^>]*>([^<]+)<\\/d:${name}>`))?.[1];
    return {
      date: read("NEW_DATE"),
      twoYear: finiteOrNull(read("BC_2YEAR")),
      tenYear: finiteOrNull(read("BC_10YEAR")),
    };
  }).filter((row) => row.date && row.twoYear !== null && row.tenYear !== null)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function loadTreasurySnapshot(now = new Date()) {
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const months = [now, previousMonth].map((date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  const pages = await Promise.all(months.map((month) => fetchText(`${TREASURY_FEED}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${month}`)));
  const rows = pages.flatMap(parseTreasuryXml).sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = rows[0];
  const previous = rows[1];
  if (!latest) throw new Error("Treasury yield data unavailable");
  return {
    date: latest.date,
    twoYear: latest.twoYear,
    tenYear: latest.tenYear,
    curve10y2y: latest.tenYear - latest.twoYear,
    twoYearDailyChange: previous ? latest.twoYear - previous.twoYear : null,
    tenYearDailyChange: previous ? latest.tenYear - previous.tenYear : null,
    source: "U.S. Department of the Treasury",
    sourceUrl: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
  };
}

function parseFmpDate(value, timing) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const hour = /bmo|before/i.test(timing || "") ? 8 : /amc|after/i.test(timing || "") ? 16 : 12;
    return zonedTimeToUtc(year, month, day, hour, 0);
  }
  const normalized = String(value).replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function surprise(actual, estimate) {
  const a = finiteOrNull(actual);
  const e = finiteOrNull(estimate);
  if (a === null || e === null) return null;
  return e === 0 ? a - e : (a - e) / Math.abs(e) * 100;
}

export function normalizeFmpEarnings(rows, symbols, now = new Date()) {
  const accepted = new Set(symbols);
  const grouped = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!accepted.has(row.symbol)) return;
    const date = parseFmpDate(row.date, row.time || row.when);
    if (!date) return;
    grouped[row.symbol].push({
      date: date.toISOString(),
      timing: row.time || row.when || null,
      fiscalDateEnding: row.fiscalDateEnding || row.fiscalDate || null,
      epsActual: finiteOrNull(row.epsActual ?? row.eps),
      epsEstimated: finiteOrNull(row.epsEstimated ?? row.epsEstimate),
      revenueActual: finiteOrNull(row.revenueActual ?? row.revenue),
      revenueEstimated: finiteOrNull(row.revenueEstimated ?? row.revenueEstimate),
      source: "Financial Modeling Prep",
      sourceUrl: "https://site.financialmodelingprep.com/developer/docs/stable/earnings-calendar",
    });
  });
  return Object.fromEntries(Object.entries(grouped).map(([symbol, items]) => {
    const ordered = items.sort((a, b) => new Date(a.date) - new Date(b.date));
    const next = ordered.find((item) => new Date(item.date) >= now) || null;
    const latest = [...ordered].reverse().find((item) => new Date(item.date) < now && (item.epsActual !== null || item.revenueActual !== null)) || null;
    return [symbol, {
      next,
      latest: latest ? {
        ...latest,
        epsSurprise: surprise(latest.epsActual, latest.epsEstimated),
        revenueSurprise: surprise(latest.revenueActual, latest.revenueEstimated),
      } : null,
    }];
  }));
}

function normalizeFmpEvents(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const category = eventCategory(row.event || row.name);
    const date = parseFmpDate(row.date);
    const country = String(row.country || row.currency || "").toUpperCase();
    if (!category || !date || !(/US|UNITED STATES|USD/.test(country))) return null;
    return {
      id: `fmp-${category}-${compactDate(date)}-${index}`,
      category,
      name: row.event || row.name,
      date: date.toISOString(),
      country: "US",
      impact: String(row.impact || "HIGH").toUpperCase(),
      actual: finiteOrNull(row.actual),
      estimate: finiteOrNull(row.estimate ?? row.consensus),
      previous: finiteOrNull(row.previous),
      unit: row.unit || null,
      source: "Financial Modeling Prep",
      sourceUrl: "https://site.financialmodelingprep.com/developer/docs/stable/economics-calendar",
      official: false,
    };
  }).filter(Boolean);
}

function mergeEvents(official, fmp) {
  const merged = [...official];
  fmp.forEach((event) => {
    const matching = merged.find((item) => item.category === event.category && Math.abs(new Date(item.date) - new Date(event.date)) <= 36 * 60 * 60 * 1000);
    if (matching) {
      matching.estimate = event.estimate;
      matching.actual = event.actual;
      matching.previous = event.previous;
      matching.unit = event.unit;
      matching.consensusSource = event.source;
      return;
    }
    merged.push(event);
  });
  return merged.sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function loadFmpContext(symbols, now = new Date()) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return { configured: false, earningsBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, { next: null, latest: null }])), events: [] };
  const from = new Date(now.getTime() - 150 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 150 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: fmpDate(from), to: fmpDate(to), apikey: apiKey });
  const [earnings, economics] = await Promise.all([
    fetchJson(`${FMP_HOST}/earnings-calendar?${params}`),
    fetchJson(`${FMP_HOST}/economic-calendar?${params}`),
  ]);
  if (!Array.isArray(earnings) || !Array.isArray(economics)) throw new Error("FMP response format invalid");
  return {
    configured: true,
    earningsBySymbol: normalizeFmpEarnings(earnings, symbols, now),
    events: normalizeFmpEvents(economics),
  };
}

export async function loadMarketContext(symbols, now = new Date()) {
  const errors = [];
  const [calendarResult, blsResult, treasuryResult, fmpResult] = await Promise.allSettled([
    fetchText(BLS_CALENDAR, { headers: { Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8", "User-Agent": "maetajak/1.0 (+https://maetajak.vercel.app)" } }).then((ics) => parseIcsEvents(ics, now)),
    loadBlsSnapshot(now),
    loadTreasurySnapshot(now),
    loadFmpContext(symbols, now),
  ]);
  const read = (result, label, fallback) => {
    if (result.status === "fulfilled") return result.value;
    errors.push(`${label}: ${result.reason?.message || "unavailable"}`);
    return fallback;
  };
  const fetchedCalendar = read(calendarResult, "BLS calendar", []);
  const officialCalendar = fetchedCalendar.length ? fetchedCalendar : fallbackBlsEvents(now);
  const indicators = read(blsResult, "BLS indicators", null);
  const treasury = read(treasuryResult, "Treasury yields", null);
  const fmp = read(fmpResult, "FMP", {
    configured: Boolean(process.env.FMP_API_KEY),
    earningsBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, { next: null, latest: null }])),
    events: [],
  });
  const events = mergeEvents([...officialCalendar, ...officialFomcEvents(now)], fmp.events || []);
  const upcoming = events.filter((event) => new Date(event.date) >= now);
  return {
    updatedAt: new Date().toISOString(),
    providers: {
      officialCalendar: officialCalendar.length ? "live" : "partial",
      officialIndicators: indicators ? "live" : "error",
      officialTreasury: treasury ? "live" : "error",
      consensus: fmp.configured && fmpResult.status === "fulfilled" ? "live" : fmp.configured ? "error" : "not_configured",
    },
    indicators,
    treasury,
    events,
    nextHighImpact: upcoming[0] || null,
    earningsBySymbol: fmp.earningsBySymbol,
    errors,
    sources: [
      { name: "U.S. Bureau of Labor Statistics", url: "https://www.bls.gov/" },
      { name: "U.S. Department of the Treasury", url: "https://home.treasury.gov/" },
      { name: "Federal Reserve", url: "https://www.federalreserve.gov/" },
      ...(fmp.configured ? [{ name: "Financial Modeling Prep", url: "https://site.financialmodelingprep.com/" }] : []),
    ],
  };
}
