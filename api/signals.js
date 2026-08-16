const DEFAULT_US_SYMBOLS = ["NVDA","AAPL","MSFT","AMZN","META","TSLA","AMD","AVGO","PLTR","MU","GOOGL","NFLX","SMCI"];
const KR_COMPANIES = [
  { symbol: "005930.KS", name: "삼성전자", query: "삼성전자 주식", aliases: ["삼성전자", "005930"] },
  { symbol: "000660.KS", name: "SK하이닉스", query: "SK하이닉스 주식", aliases: ["SK하이닉스", "에스케이하이닉스", "하이닉스", "000660"] },
  { symbol: "005380.KS", name: "현대차", query: "현대차 주식", aliases: ["현대차", "현대자동차", "005380"] },
  { symbol: "066570.KS", name: "LG전자", query: "LG전자 주식", aliases: ["LG전자", "엘지전자", "066570"] },
  { symbol: "035420.KS", name: "NAVER", query: "네이버 주식", aliases: ["NAVER", "네이버", "035420"] },
  { symbol: "042700.KS", name: "한미반도체", query: "한미반도체 주식", aliases: ["한미반도체", "042700"] },
];
const KR_BY_SYMBOL = new Map(KR_COMPANIES.map((item) => [item.symbol, item]));

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const unique = (items) => [...new Set(items.filter(Boolean))];
const stripHtml = (value) => decodeEntities(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSymbols(value) {
  const requested = String(value || "")
    .toUpperCase()
    .split(",")
    .map((item) => item.trim().replace(/[^A-Z0-9.\-]/g, ""))
    .filter(Boolean)
    .slice(0, 30);
  return requested.length ? unique(requested) : [...DEFAULT_US_SYMBOLS, ...KR_COMPANIES.map((item) => item.symbol)];
}

function marketOf(symbol) {
  return /\.(KS|KQ)$/.test(String(symbol || "")) ? "KR" : "US";
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json,text/xml,application/rss+xml,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 (compatible; ToojaSignals/2.0)",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  return response.text();
}

async function yahooJson(url) {
  return JSON.parse(await fetchText(url));
}

async function loadYahooSymbol(symbol, includeNews) {
  const requests = [
    yahooJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true&events=div%2Csplits`),
  ];
  if (includeNews) requests.push(yahooJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=12&enableFuzzyQuery=false`));
  const settled = await Promise.allSettled(requests);
  const chart = settled[0].status === "fulfilled" ? settled[0].value : null;
  const search = includeNews && settled[1]?.status === "fulfilled" ? settled[1].value : null;
  const quote = search?.quotes?.find((item) => item.symbol === symbol) || search?.quotes?.[0] || null;
  const result = chart?.chart?.result?.[0];
  const meta = result?.meta || {};
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  const validIndexes = closes.map((value, index) => value == null ? -1 : index).filter((index) => index >= 0);
  const lastIndex = validIndexes.at(-1);
  const price = lastIndex == null ? finite(meta.regularMarketPrice) : finite(closes[lastIndex], finite(meta.regularMarketPrice));
  const previousClose = finite(meta.chartPreviousClose, finite(meta.previousClose));
  const changePercent = price != null && previousClose ? (price - previousClose) / previousClose * 100 : null;
  const priceTime = lastIndex == null ? finite(meta.regularMarketTime) : timestamps[lastIndex];
  const company = KR_BY_SYMBOL.get(symbol);
  const news = includeNews ? (search?.news || []).map((item) => ({
    id: item.uuid || `${symbol}-${item.providerPublishTime}-${item.title}`,
    title: stripHtml(item.title || "제목 없음"),
    description: "",
    publisher: item.publisher || "출처 미상",
    link: item.link || item.canonicalUrl?.url || null,
    publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : null,
    relatedTickers: unique([...(item.relatedTickers || []), symbol]),
    sourceSymbol: symbol,
    market: "US",
    provider: "Yahoo Finance",
  })) : [];
  return {
    symbol,
    name: company?.name || quote?.shortname || quote?.longname || meta.longName || meta.shortName || symbol,
    exchange: quote?.exchange || meta.exchangeName || (company ? "KSE" : "US"),
    market: marketOf(symbol),
    price,
    previousClose,
    changePercent,
    priceTime: priceTime ? new Date(priceTime * 1000).toISOString() : null,
    news,
    error: settled[0].status === "rejected" ? "시세 조회 실패" : null,
  };
}

function xmlTag(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeEntities(match[1].trim()) : "";
}

function sourceFromGoogleTitle(title) {
  const parts = String(title || "").split(" - ");
  return parts.length > 1 ? parts.at(-1).trim() : "Google 뉴스";
}

async function loadGoogleNews(company) {
  const query = `"${company.name}" 주식 when:1d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const xml = await fetchText(url);
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return blocks.slice(0, 18).map((block, index) => {
    const rawTitle = stripHtml(xmlTag(block, "title"));
    const publisher = stripHtml(xmlTag(block, "source")) || sourceFromGoogleTitle(rawTitle);
    const title = rawTitle.endsWith(` - ${publisher}`) ? rawTitle.slice(0, -(publisher.length + 3)).trim() : rawTitle;
    const date = xmlTag(block, "pubDate");
    return {
      id: `google-${company.symbol}-${index}-${date}-${title}`,
      title,
      description: stripHtml(xmlTag(block, "description")),
      publisher,
      link: xmlTag(block, "link") || null,
      publishedAt: date && !Number.isNaN(new Date(date).getTime()) ? new Date(date).toISOString() : null,
      relatedTickers: [company.symbol],
      sourceSymbol: company.symbol,
      market: "KR",
      provider: "Google News KR",
    };
  }).filter((item) => item.title);
}

async function loadNaverNews(company) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("NAVER API credentials missing");
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(company.query)}&display=20&start=1&sort=date`;
  const payload = JSON.parse(await fetchText(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  }));
  return (payload.items || []).map((item, index) => ({
    id: `naver-${company.symbol}-${index}-${item.pubDate}-${item.originallink || item.link}`,
    title: stripHtml(item.title),
    description: stripHtml(item.description),
    publisher: publisherFromUrl(item.originallink || item.link),
    link: item.originallink || item.link || null,
    publishedAt: item.pubDate && !Number.isNaN(new Date(item.pubDate).getTime()) ? new Date(item.pubDate).toISOString() : null,
    relatedTickers: [company.symbol],
    sourceSymbol: company.symbol,
    market: "KR",
    provider: "NAVER News Search API",
  }));
}

function publisherFromUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    const known = {
      "yna.co.kr": "연합뉴스", "hankyung.com": "한국경제", "mk.co.kr": "매일경제", "sedaily.com": "서울경제",
      "mt.co.kr": "머니투데이", "edaily.co.kr": "이데일리", "asiae.co.kr": "아시아경제", "biz.chosun.com": "조선비즈",
      "etnews.com": "전자신문", "fnnews.com": "파이낸셜뉴스", "news1.kr": "뉴스1", "newsis.com": "뉴시스",
    };
    return known[host] || host;
  } catch {
    return "국내 언론";
  }
}

async function loadKoreanNews() {
  const naverReady = Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  const rows = await Promise.all(KR_COMPANIES.map(async (company) => {
    try {
      const items = naverReady ? await loadNaverNews(company) : await loadGoogleNews(company);
      return items;
    } catch {
      try {
        return await loadGoogleNews(company);
      } catch {
        return [];
      }
    }
  }));
  return { news: rows.flat(), provider: naverReady ? "NAVER News Search API" : "Google News KR RSS" };
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\[[^\]]+\]|\([^)]*속보[^)]*\)/g, " ")
    .replace(/[^a-z0-9가-힣 ]/g, " ")
    .replace(/\b(the|a|an|to|of|for|and|on|in|with|as|is|are|at|from)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a, b) {
  const left = new Set(normalizeTitle(a).split(" ").filter((token) => token.length > 1));
  const right = new Set(normalizeTitle(b).split(" ").filter((token) => token.length > 1));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.min(left.size, right.size);
}

function enrichKoreanTickers(item) {
  if (item.market !== "KR") return item;
  const text = `${item.title} ${item.description}`.toLowerCase();
  const matched = KR_COMPANIES.filter((company) => company.aliases.some((alias) => text.includes(alias.toLowerCase()))).map((company) => company.symbol);
  return { ...item, relatedTickers: unique([...(item.relatedTickers || []), ...matched]) };
}

function kstDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { year:"numeric", month:"2-digit", day:"2-digit", timeZone:"Asia/Seoul" }).format(new Date(value));
}

function scoreIssue(item, sourceCount) {
  const ageMinutes = item.publishedAt ? Math.max(0, (Date.now() - new Date(item.publishedAt).getTime()) / 60000) : 9999;
  const recency = ageMinutes <= 15 ? 62 : ageMinutes <= 60 ? 58 : ageMinutes <= 180 ? 52 : ageMinutes <= 720 ? 42 : ageMinutes <= 1440 ? 30 : 12;
  const sourceBoost = Math.min(14, sourceCount * 4);
  const tickerBoost = Math.min(10, Math.max(1, item.relatedTickers?.length || 1) * 2);
  const trusted = /연합뉴스|한국경제|매일경제|서울경제|머니투데이|이데일리|아시아경제|조선비즈|전자신문|파이낸셜뉴스|뉴스1|뉴시스|reuters|bloomberg|cnbc|marketwatch|barron|business wire/i.test(item.publisher || "") ? 6 : 2;
  const eventBoost = /실적|공시|수주|계약|인수|합병|승인|리콜|파업|증설|투자|목표가|가이던스|출시|제재|관세|배당|자사주|유상증자|감자|분할|급등|급락|surge|plunge|earnings|guidance|acquisition|approval/i.test(`${item.title} ${item.description}`) ? 8 : 0;
  const urgencyBoost = /속보|단독|긴급|급등|급락|사상 최대|최고치|최저치|halt|breaking/i.test(`${item.title} ${item.description}`) ? 6 : 0;
  return {
    score: Math.round(Math.min(100, recency + sourceBoost + tickerBoost + trusted + eventBoost + urgencyBoost)),
    ageMinutes: Math.round(ageMinutes),
  };
}

function clusterNews(rows) {
  const clusters = [];
  const sorted = rows.map(enrichKoreanTickers).sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  for (const item of sorted) {
    const cluster = clusters.find((current) => current.market === item.market && (
      current.link && item.link && current.link === item.link
      || titleSimilarity(current.title, item.title) >= 0.68
    ));
    if (cluster) {
      cluster.relatedTickers = unique([...(cluster.relatedTickers || []), ...(item.relatedTickers || [])]);
      cluster.sources = unique([...(cluster.sources || []), item.publisher]);
      if (new Date(item.publishedAt || 0) > new Date(cluster.publishedAt || 0)) {
        cluster.publishedAt = item.publishedAt;
        cluster.link = item.link || cluster.link;
      }
    } else {
      clusters.push({ ...item, sources: [item.publisher] });
    }
  }
  return clusters.map((item) => {
    const scored = scoreIssue(item, item.sources.length);
    const isToday = item.publishedAt ? kstDateKey(item.publishedAt) === kstDateKey() : false;
    return {
      ...item,
      ...scored,
      sourceCount: item.sources.length,
      isToday,
      hot: isToday && scored.score >= 80,
      normalizedTitle: normalizeTitle(item.title),
    };
  }).sort((a, b) => Number(b.hot) - Number(a.hot) || b.score - a.score || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, 100);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=120");
  try {
    const symbols = parseSymbols(req.query?.symbols);
    const usSymbols = symbols.filter((symbol) => marketOf(symbol) === "US");
    const krSymbols = unique([...symbols.filter((symbol) => marketOf(symbol) === "KR"), ...KR_COMPANIES.map((item) => item.symbol)]);
    const [usSettled, krPriceSettled, krNewsResult] = await Promise.all([
      Promise.allSettled(usSymbols.map((symbol) => loadYahooSymbol(symbol, true))),
      Promise.allSettled(krSymbols.map((symbol) => loadYahooSymbol(symbol, false))),
      loadKoreanNews(),
    ]);
    const mapSettled = (settled, requested) => settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { symbol: requested[index], name: KR_BY_SYMBOL.get(requested[index])?.name || requested[index], market: marketOf(requested[index]), price: null, changePercent: null, news: [], error: result.reason?.message || "조회 실패" });
    const usStocks = mapSettled(usSettled, usSymbols);
    const krStocks = mapSettled(krPriceSettled, krSymbols);
    const allNews = [...usStocks.flatMap((stock) => stock.news || []), ...krNewsResult.news];
    const news = clusterNews(allNews);
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      source: `미국 Yahoo Finance · 한국 ${krNewsResult.provider}`,
      providers: { US: "Yahoo Finance", KR: krNewsResult.provider },
      symbols: [...usSymbols, ...krSymbols],
      stocks: [...usStocks, ...krStocks].map(({ news: _news, ...stock }) => stock),
      news,
      hotCount: news.filter((item) => item.hot).length,
      notes: "한국 뉴스는 국내 실시간 뉴스 검색 결과를 사용하며, 당일 이슈점수 80점 이상은 HOT 이슈로 최상단에 고정합니다.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Signals API error" });
  }
}
