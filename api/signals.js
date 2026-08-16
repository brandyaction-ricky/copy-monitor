const DEFAULT_SYMBOLS = ["NVDA","AAPL","MSFT","AMZN","META","TSLA","AMD","AVGO","PLTR","MU","GOOGL","NFLX","SMCI"];

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const unique = (items) => [...new Set(items.filter(Boolean))];

function parseSymbols(value) {
  const symbols = String(value || "")
    .toUpperCase()
    .split(",")
    .map((item) => item.trim().replace(/[^A-Z0-9.\-]/g, ""))
    .filter(Boolean)
    .slice(0, 20);
  return symbols.length ? unique(symbols) : DEFAULT_SYMBOLS;
}

async function yahooJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 (compatible; ToojaSignals/1.0)",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Yahoo Finance ${response.status}`);
  return response.json();
}

async function loadSymbol(symbol) {
  const [search, chart] = await Promise.allSettled([
    yahooJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=10&enableFuzzyQuery=false`),
    yahooJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true&events=div%2Csplits`),
  ]);

  const news = search.status === "fulfilled" ? (search.value?.news || []) : [];
  const quote = search.status === "fulfilled" ? (search.value?.quotes || []).find((item) => item.symbol === symbol) || search.value?.quotes?.[0] : null;
  const result = chart.status === "fulfilled" ? chart.value?.chart?.result?.[0] : null;
  const meta = result?.meta || {};
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  const lastIndex = closes.map((value, index) => value == null ? -1 : index).filter((index) => index >= 0).at(-1);
  const price = lastIndex == null ? finite(meta.regularMarketPrice) : finite(closes[lastIndex], finite(meta.regularMarketPrice));
  const previousClose = finite(meta.chartPreviousClose, finite(meta.previousClose));
  const changePercent = price != null && previousClose ? ((price - previousClose) / previousClose) * 100 : null;
  const priceTime = lastIndex == null ? finite(meta.regularMarketTime) : timestamps[lastIndex];

  return {
    symbol,
    name: quote?.shortname || quote?.longname || meta.longName || meta.shortName || symbol,
    exchange: quote?.exchange || meta.exchangeName || "US",
    price,
    previousClose,
    changePercent,
    priceTime: priceTime ? new Date(priceTime * 1000).toISOString() : null,
    news: news.map((item) => ({
      id: item.uuid || `${symbol}-${item.providerPublishTime}-${item.title}`,
      title: item.title || "제목 없음",
      publisher: item.publisher || "출처 미상",
      link: item.link || item.canonicalUrl?.url || null,
      publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : null,
      relatedTickers: unique([...(item.relatedTickers || []), symbol]),
      thumbnail: item.thumbnail?.resolutions?.at(-1)?.url || item.thumbnail?.resolutions?.[0]?.url || null,
      sourceSymbol: symbol,
    })),
    error: search.status === "rejected" && chart.status === "rejected" ? "시세와 뉴스 조회 실패" : null,
  };
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣 ]/g, " ")
    .replace(/\b(the|a|an|to|of|for|and|on|in|with|as|is|are|at|from)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clusterNews(rows) {
  const now = Date.now();
  const byId = new Map();
  for (const row of rows) {
    const key = row.id || `${row.publisher}:${row.title}`;
    if (!byId.has(key)) byId.set(key, row);
    else {
      const current = byId.get(key);
      current.relatedTickers = unique([...(current.relatedTickers || []), ...(row.relatedTickers || [])]);
    }
  }

  const items = [...byId.values()].map((item) => {
    const ageMinutes = item.publishedAt ? Math.max(0, (now - new Date(item.publishedAt).getTime()) / 60000) : 9999;
    const recency = Math.max(0, 70 - Math.min(70, ageMinutes / 3));
    const tickerBoost = Math.min(18, Math.max(0, (item.relatedTickers?.length || 1) - 1) * 3);
    const trusted = /reuters|bloomberg|associated press|business wire|globe newswire|benzinga|investor's business daily|marketwatch|barron|fortune|cnbc/i.test(item.publisher || "") ? 8 : 2;
    return {
      ...item,
      normalizedTitle: normalizeTitle(item.title),
      score: Math.round(recency + tickerBoost + trusted),
      ageMinutes: Math.round(ageMinutes),
    };
  });

  items.sort((a, b) => b.score - a.score || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return items.slice(0, 60);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=45, stale-while-revalidate=120");
  try {
    const symbols = parseSymbols(req.query?.symbols);
    const settled = await Promise.allSettled(symbols.map(loadSymbol));
    const stocks = settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { symbol: symbols[index], name: symbols[index], price: null, changePercent: null, news: [], error: result.reason?.message || "조회 실패" });
    const news = clusterNews(stocks.flatMap((stock) => stock.news || []));
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      source: "Yahoo Finance public endpoints",
      symbols,
      stocks: stocks.map(({ news: _news, ...stock }) => stock),
      news,
      notes: "MVP는 기사 제목·출처·관련 티커와 시장가격을 실시간 조회합니다. 기사 본문은 저장하지 않습니다.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Signals API error" });
  }
}
