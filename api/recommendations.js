const GATE_HOST = "https://api.gateio.ws/api/v4";

const coinUniverse = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT", "BNB_USDT", "SUI_USDT", "LINK_USDT"];
const stockUniverse = [
  { symbol: "NVDA", name: "엔비디아", sector: "반도체" },
  { symbol: "AMD", name: "AMD", sector: "반도체" },
  { symbol: "MSFT", name: "마이크로소프트", sector: "소프트웨어" },
  { symbol: "AAPL", name: "애플", sector: "IT 하드웨어" },
  { symbol: "META", name: "메타", sector: "커뮤니케이션" },
  { symbol: "AMZN", name: "아마존", sector: "소비·클라우드" },
  { symbol: "TSLA", name: "테슬라", sector: "자동차" },
  { symbol: "QQQ", name: "나스닥100 ETF", sector: "지수" },
];

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const average = (items) => items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0;
const round = (value, digits = 4) => Number(finite(value).toFixed(digits));

function ema(values, period) {
  if (!values.length) return [];
  const factor = 2 / (period + 1);
  let current = values[0];
  return values.map((value, index) => {
    current = index ? value * factor + current * (1 - factor) : value;
    return current;
  });
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (!losses) return 100;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - (100 / (1 + relativeStrength));
}

function atr(candles, period = 14) {
  const recent = candles.slice(-(period + 1));
  if (recent.length < 2) return 0;
  const ranges = recent.slice(1).map((candle, index) => {
    const previousClose = recent[index].c;
    return Math.max(candle.h - candle.l, Math.abs(candle.h - previousClose), Math.abs(candle.l - previousClose));
  });
  return average(ranges);
}

function normalizeGateCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ t: finite(row.t), o: finite(row.o), h: finite(row.h), l: finite(row.l), c: finite(row.c), v: finite(row.v) }))
    .filter((row) => row.t && row.o && row.h && row.l && row.c)
    .sort((a, b) => a.t - b.t);
}

async function gatePublic(path, params) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${GATE_HOST}${path}?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Gate.io ${response.status}`);
  return response.json();
}

function findFvg(candles, direction, current) {
  const candidates = [];
  for (let index = Math.max(2, candles.length - 90); index < candles.length; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];
    if (direction === "LONG" && first.h < third.l) candidates.push({ low: first.h, high: third.l, index });
    if (direction === "SHORT" && first.l > third.h) candidates.push({ low: third.h, high: first.l, index });
  }
  return candidates.reverse().find((zone) => {
    const after = candles.slice(zone.index + 1);
    const filled = direction === "LONG"
      ? after.some((candle) => candle.l <= zone.low)
      : after.some((candle) => candle.h >= zone.high);
    const located = direction === "LONG" ? zone.high <= current : zone.low >= current;
    return !filled && located;
  }) || null;
}

function findSweep(candles) {
  const recent = candles.slice(-24);
  const previous = candles.slice(-60, -24);
  if (!recent.length || !previous.length) return null;
  const previousHigh = Math.max(...previous.map((item) => item.h));
  const previousLow = Math.min(...previous.map((item) => item.l));
  const bearish = recent.findLast((item) => item.h > previousHigh && item.c < previousHigh);
  if (bearish) return { direction: "SHORT", level: previousHigh };
  const bullish = recent.findLast((item) => item.l < previousLow && item.c > previousLow);
  if (bullish) return { direction: "LONG", level: previousLow };
  return null;
}

function analyzeCoin(symbol, candles15, candles1h, ticker) {
  const closes15 = candles15.map((item) => item.c);
  const closes1h = candles1h.map((item) => item.c);
  const last = finite(ticker?.mark_price, closes15.at(-1));
  const ema20h = ema(closes1h, 20).at(-1);
  const ema50h = ema(closes1h, 50).at(-1);
  const ema9m = ema(closes15, 9).at(-1);
  const ema20m = ema(closes15, 20).at(-1);
  const currentRsi = rsi(closes15);
  const currentAtr = atr(candles15);
  const hourlySpread = Math.abs(ema20h - ema50h) / last;
  const hourlyDirection = hourlySpread < 0.0015 ? "WAIT" : ema20h > ema50h && last > ema20h ? "LONG" : ema20h < ema50h && last < ema20h ? "SHORT" : "WAIT";
  const executionDirection = ema9m > ema20m ? "LONG" : ema9m < ema20m ? "SHORT" : "WAIT";
  const direction = hourlyDirection !== "WAIT" && hourlyDirection === executionDirection ? hourlyDirection : "WAIT";
  const fvg = direction === "WAIT" ? null : findFvg(candles15, direction, last);
  const sweep = findSweep(candles15);
  const recent = candles15.slice(-48);
  const swingHigh = Math.max(...recent.map((item) => item.h));
  const swingLow = Math.min(...recent.map((item) => item.l));
  const entry = direction === "LONG" ? finite(fvg?.high, ema20m) : direction === "SHORT" ? finite(fvg?.low, ema20m) : last;
  const stop = direction === "LONG"
    ? Math.min(finite(fvg?.low, entry - currentAtr), entry - currentAtr * 1.1)
    : direction === "SHORT"
      ? Math.max(finite(fvg?.high, entry + currentAtr), entry + currentAtr * 1.1)
      : null;
  const risk = stop == null ? 0 : Math.abs(entry - stop);
  let target1 = null;
  let target2 = null;
  if (direction === "LONG") {
    target1 = swingHigh > entry + risk * 1.5 ? swingHigh : entry + risk * 1.8;
    target2 = entry + risk * 2.8;
  } else if (direction === "SHORT") {
    target1 = swingLow < entry - risk * 1.5 ? swingLow : entry - risk * 1.8;
    target2 = entry - risk * 2.8;
  }
  const rr = risk && target1 != null ? Math.abs(target1 - entry) / risk : 0;
  const rsiOkay = direction === "LONG" ? currentRsi < 70 : direction === "SHORT" ? currentRsi > 30 : false;
  const funding = finite(ticker?.funding_rate) * 100;
  const fundingOkay = direction === "LONG" ? funding < 0.05 : direction === "SHORT" ? funding > -0.05 : false;
  const actionable = direction !== "WAIT" && rr >= 1.5 && rsiOkay && fundingOkay;
  const reasons = [];
  if (hourlyDirection === "WAIT") reasons.push("1시간봉 방향성 혼조");
  else reasons.push(`1시간봉 ${hourlyDirection === "LONG" ? "상승" : "하락"} 바이어스`);
  if (executionDirection !== hourlyDirection) reasons.push("15분봉과 상위 추세 불일치");
  else if (direction !== "WAIT") reasons.push("15분봉 EMA 방향 일치");
  if (fvg) reasons.push(`${direction === "LONG" ? "강세" : "약세"} FVG 재시험 후보`);
  if (sweep) reasons.push(`${sweep.direction === "LONG" ? "저점" : "고점"} 유동성 스윕 감지`);
  if (!rsiOkay && direction !== "WAIT") reasons.push(`RSI ${round(currentRsi, 1)} 과열 필터`);
  if (!fundingOkay && direction !== "WAIT") reasons.push("펀딩 과열 필터");
  const score = Math.max(0, Math.min(100,
    35 + (hourlyDirection !== "WAIT" ? 20 : 0) + (direction !== "WAIT" ? 20 : 0) + (fvg ? 10 : 0) + (rsiOkay ? 8 : 0) + (fundingOkay ? 7 : 0)
  ));

  return {
    market: "coin",
    symbol: symbol.replace("_", "/"),
    contract: symbol,
    price: round(last, last >= 1000 ? 2 : last >= 1 ? 4 : 6),
    change24h: round(ticker?.change_percentage, 2),
    volume24h: round(ticker?.volume_24h_quote || ticker?.volume_24h_usd, 0),
    fundingRate: round(funding, 4),
    rsi: round(currentRsi, 1),
    bias: hourlyDirection,
    verdict: actionable ? direction : "WAIT",
    candidateDirection: direction,
    score,
    entry: direction === "WAIT" ? null : round(entry, 6),
    stop: stop == null ? null : round(stop, 6),
    target1: target1 == null ? null : round(target1, 6),
    target2: target2 == null ? null : round(target2, 6),
    rr: round(rr, 2),
    zone: fvg ? { low: round(fvg.low, 6), high: round(fvg.high, 6), type: "FVG" } : null,
    trigger: direction === "WAIT" ? "상·하위 시간대 방향이 일치할 때 재평가" : `진입 구간 도달 후 5분봉 ${direction === "LONG" ? "상향" : "하향"} 구조 전환 확인`,
    reasons,
    candleClosedAt: new Date(candles15.at(-1).t * 1000).toISOString(),
  };
}

async function loadCoinRecommendations() {
  const tickers = await gatePublic("/futures/usdt/tickers", {});
  const tickerMap = new Map((Array.isArray(tickers) ? tickers : []).map((ticker) => [ticker.contract, ticker]));
  const candidates = await Promise.all(coinUniverse.map(async (symbol) => {
    try {
      const [raw15, raw1h] = await Promise.all([
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "15m", limit: "240" }),
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "1h", limit: "200" }),
      ]);
      const candles15 = normalizeGateCandles(raw15);
      const candles1h = normalizeGateCandles(raw1h);
      if (candles15.length < 60 || candles1h.length < 60) throw new Error("캔들 데이터 부족");
      return analyzeCoin(symbol, candles15, candles1h, tickerMap.get(symbol));
    } catch (error) {
      return { market: "coin", symbol: symbol.replace("_", "/"), contract: symbol, error: error.message || "조회 실패" };
    }
  }));
  return candidates.sort((a, b) => finite(b.score, -1) - finite(a.score, -1));
}

async function loadYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!response.ok) throw new Error(`시세 조회 실패 (${response.status})`);
  const result = (await response.json())?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] || {};
  const rows = (result?.timestamp || []).map((time, index) => ({
    t: time,
    c: finite(quote.close?.[index], NaN),
    v: finite(quote.volume?.[index], NaN),
  })).filter((row) => Number.isFinite(row.c));
  if (rows.length < 50) throw new Error("일봉 데이터 부족");
  return { rows, meta: result.meta || {} };
}

function analyzeStock(stock, data) {
  const closes = data.rows.map((item) => item.c);
  const volumes = data.rows.map((item) => item.v).filter(Number.isFinite);
  const last = closes.at(-1);
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const currentRsi = rsi(closes);
  const dailyReturns = closes.slice(-21).slice(1).map((value, index) => Math.abs((value - closes.slice(-21)[index]) / closes.slice(-21)[index]));
  const volatility = average(dailyReturns) * 100;
  const latestVolume = volumes.at(-1) || 0;
  const averageVolume = average(volumes.slice(-20));
  const trend = last > ema20 && ema20 > ema50 ? "UP" : last < ema20 && ema20 < ema50 ? "DOWN" : "MIXED";
  const volumeRatio = averageVolume ? latestVolume / averageVolume : 0;
  const score = Math.max(0, Math.min(100, 45 + (trend === "UP" ? 25 : trend === "DOWN" ? -15 : 0) + (currentRsi >= 45 && currentRsi <= 68 ? 15 : 0) + (volumeRatio >= 1.1 ? 10 : 0) - (volatility > 4 ? 8 : 0)));
  const previous = closes.at(-2);
  return {
    market: "stock", symbol: stock.symbol, name: stock.name, sector: stock.sector,
    price: round(data.meta.regularMarketPrice ?? last, 2),
    change: round(previous ? (last - previous) / previous * 100 : 0, 2),
    trend, rsi: round(currentRsi, 1), volatility: round(volatility, 2), volumeRatio: round(volumeRatio, 2), score,
    verdict: trend === "UP" && score >= 70 ? "WATCH" : trend === "DOWN" ? "AVOID" : "WAIT",
    reasons: [
      trend === "UP" ? "20일·50일 추세 상승 배열" : trend === "DOWN" ? "20일·50일 추세 하락 배열" : "이동평균 혼조",
      `RSI ${round(currentRsi, 1)}`,
      `거래량 ${round(volumeRatio, 2)}×`,
      `20일 평균 변동폭 ${round(volatility, 2)}%`,
    ],
    eventStatus: "실적·매크로 일정 미연결",
    priceTime: data.meta.regularMarketTime ? new Date(data.meta.regularMarketTime * 1000).toISOString() : null,
  };
}

async function loadStockRecommendations() {
  const candidates = await Promise.all(stockUniverse.map(async (stock) => {
    try { return analyzeStock(stock, await loadYahooChart(stock.symbol)); }
    catch (error) { return { market: "stock", ...stock, error: error.message || "조회 실패" }; }
  }));
  return candidates.sort((a, b) => finite(b.score, -1) - finite(a.score, -1));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const market = String(req.query.market || "coin");
  if (!['coin', 'stock'].includes(market)) return res.status(400).json({ error: "Unsupported market" });
  try {
    const candidates = market === "coin" ? await loadCoinRecommendations() : await loadStockRecommendations();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ market, source: market === "coin" ? "Gate.io API v4" : "Yahoo Finance chart", updatedAt: new Date().toISOString(), candidates });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Recommendation data unavailable" });
  }
}
