import { loadMarketContext } from "../lib/market-context.js";

const GATE_HOST = "https://api.gateio.ws/api/v4";

const coinUniverse = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "HYPE_USDT"];
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

function completedCandles(rows, intervalSeconds) {
  const now = Date.now() / 1000;
  return rows.filter((candle) => candle.t + intervalSeconds <= now);
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

function trendSnapshot(candles, fastPeriod, slowPeriod, minimumSpread) {
  const closes = candles.map((item) => item.c);
  const last = closes.at(-1);
  const fast = ema(closes, fastPeriod).at(-1);
  const slow = ema(closes, slowPeriod).at(-1);
  const spread = last ? Math.abs(fast - slow) / last : 0;
  const direction = spread < minimumSpread
    ? "WAIT"
    : fast > slow && last > fast
      ? "LONG"
      : fast < slow && last < fast
        ? "SHORT"
        : "WAIT";
  return { direction, fast, slow, spread };
}

function directionLabel(direction) {
  return direction === "LONG" ? "상승" : direction === "SHORT" ? "하락" : "혼조";
}

function buildScenario({ style, direction, candles, last, fvg, score, actionable, trigger }) {
  if (direction === "WAIT") {
    return { style, verdict: "WAIT", candidateDirection: "WAIT", actionable: false, score, entry: null, stop: null, target1: null, target2: null, rr: 0, zone: null, trigger };
  }
  const currentAtr = atr(candles);
  const closes = candles.map((item) => item.c);
  const pullbackEma = ema(closes, 20).at(-1);
  const recent = candles.slice(style === "SWING" ? -42 : -48);
  const swingHigh = Math.max(...recent.map((item) => item.h));
  const swingLow = Math.min(...recent.map((item) => item.l));
  const fallbackEntry = direction === "LONG" ? Math.min(last, pullbackEma) : Math.max(last, pullbackEma);
  const entry = direction === "LONG" ? finite(fvg?.high, fallbackEntry) : finite(fvg?.low, fallbackEntry);
  const stop = direction === "LONG"
    ? Math.min(finite(fvg?.low, entry - currentAtr * 1.2), entry - currentAtr * 1.2)
    : Math.max(finite(fvg?.high, entry + currentAtr * 1.2), entry + currentAtr * 1.2);
  const risk = Math.abs(entry - stop);
  const structuralTarget = direction === "LONG" ? swingHigh : swingLow;
  const structuralReward = direction === "LONG" ? structuralTarget - entry : entry - structuralTarget;
  const target1 = risk && structuralReward >= risk * 1.5 && structuralReward <= risk * 4
    ? structuralTarget
    : direction === "LONG" ? entry + risk * 1.8 : entry - risk * 1.8;
  const target2 = direction === "LONG" ? entry + risk * 3 : entry - risk * 3;
  const rr = risk ? Math.abs(target1 - entry) / risk : 0;
  return {
    style,
    verdict: actionable ? direction : "WAIT",
    candidateDirection: direction,
    actionable,
    score: Math.max(0, Math.min(100, Math.round(score))),
    entry: round(entry, 6),
    stop: round(stop, 6),
    target1: round(target1, 6),
    target2: round(target2, 6),
    rr: round(rr, 2),
    zone: fvg ? { low: round(fvg.low, 6), high: round(fvg.high, 6), type: "FVG" } : null,
    trigger,
  };
}

function analyzeCoin(symbol, candles15, candles1h, candles4h, candles1w, ticker) {
  const closes15 = candles15.map((item) => item.c);
  const last = finite(ticker?.mark_price, closes15.at(-1));
  const weekly = trendSnapshot(candles1w, 10, 20, 0.008);
  const fourHour = trendSnapshot(candles4h, 20, 50, 0.0025);
  const oneHour = trendSnapshot(candles1h, 20, 50, 0.0015);
  const fifteenMinute = trendSnapshot(candles15, 9, 20, 0.0006);
  const currentRsi = rsi(closes15);
  const funding = finite(ticker?.funding_rate) * 100;
  const rsiOkay = (direction) => direction === "LONG" ? currentRsi < 70 : direction === "SHORT" ? currentRsi > 30 : false;
  const fundingOkay = (direction) => direction === "LONG" ? funding < 0.05 : direction === "SHORT" ? funding > -0.05 : false;

  const swingDirection = weekly.direction !== "WAIT" && weekly.direction === fourHour.direction ? weekly.direction : "WAIT";
  const swingOneHourAligned = swingDirection !== "WAIT" && oneHour.direction === swingDirection;
  const swingExecutionAligned = swingDirection !== "WAIT" && fifteenMinute.direction === swingDirection;
  const swingFvg = swingDirection === "WAIT" ? null : findFvg(candles4h, swingDirection, last);
  const swingScore = (weekly.direction !== "WAIT" ? 20 : 0)
    + (swingDirection !== "WAIT" ? 30 : 0)
    + (swingOneHourAligned ? 20 : oneHour.direction === "WAIT" ? 8 : 0)
    + (swingExecutionAligned ? 15 : 0)
    + (swingFvg ? 5 : 0)
    + (rsiOkay(swingDirection) ? 5 : 0)
    + (fundingOkay(swingDirection) ? 5 : 0);
  const swingActionable = swingDirection !== "WAIT" && swingOneHourAligned && swingExecutionAligned
    && rsiOkay(swingDirection) && fundingOkay(swingDirection) && swingScore >= 75;
  const swing = buildScenario({
    style: "SWING",
    direction: swingDirection,
    candles: candles4h,
    last,
    fvg: swingFvg,
    score: swingScore,
    actionable: swingActionable,
    trigger: swingDirection === "WAIT"
      ? "1주봉과 4시간봉 방향이 일치할 때 스윙 셋업 재평가"
      : `1시간봉 ${directionLabel(swingDirection)} 유지 후 15분봉 ${swingDirection === "LONG" ? "상향" : "하향"} 구조 전환 확인`,
  });

  const weeklyOpposesFourHour = weekly.direction !== "WAIT" && fourHour.direction !== "WAIT" && weekly.direction !== fourHour.direction;
  const shortDirection = !weeklyOpposesFourHour && fourHour.direction !== "WAIT" && fourHour.direction === oneHour.direction ? fourHour.direction : "WAIT";
  const shortExecutionAligned = shortDirection !== "WAIT" && fifteenMinute.direction === shortDirection;
  const shortFvg = shortDirection === "WAIT" ? null : findFvg(candles15, shortDirection, last);
  const shortScore = (fourHour.direction !== "WAIT" ? 20 : 0)
    + (shortDirection !== "WAIT" ? 30 : 0)
    + (shortExecutionAligned ? 25 : 0)
    + (weekly.direction === shortDirection ? 10 : weekly.direction === "WAIT" ? 5 : 0)
    + (shortFvg ? 5 : 0)
    + (rsiOkay(shortDirection) ? 5 : 0)
    + (fundingOkay(shortDirection) ? 5 : 0);
  const shortActionable = shortDirection !== "WAIT" && shortExecutionAligned
    && rsiOkay(shortDirection) && fundingOkay(shortDirection) && shortScore >= 75;
  const shortTerm = buildScenario({
    style: "SHORT_TERM",
    direction: shortDirection,
    candles: candles15,
    last,
    fvg: shortFvg,
    score: shortScore,
    actionable: shortActionable,
    trigger: shortDirection === "WAIT"
      ? weeklyOpposesFourHour ? "1주봉과 4시간봉 충돌 해소 대기" : "4시간봉과 1시간봉 방향이 일치할 때 재평가"
      : `15분봉 ${shortDirection === "LONG" ? "상향" : "하향"} 구조 전환과 진입 구간 반응 확인`,
  });

  const actionableScenarios = [swing, shortTerm].filter((scenario) => scenario.actionable).sort((a, b) => b.score - a.score);
  const candidateScenarios = [swing, shortTerm].filter((scenario) => scenario.candidateDirection !== "WAIT").sort((a, b) => b.score - a.score);
  const primary = actionableScenarios[0] || candidateScenarios[0] || null;
  const sweep = findSweep(candles15);
  const reasons = [];
  reasons.push(`1주봉 ${directionLabel(weekly.direction)} · 4시간봉 ${directionLabel(fourHour.direction)}`);
  reasons.push(`1시간봉 ${directionLabel(oneHour.direction)} · 15분봉 ${directionLabel(fifteenMinute.direction)}`);
  if (swingDirection !== "WAIT") reasons.push(`스윙 ${directionLabel(swingDirection)} 셋업 ${swingActionable ? "확인" : "대기"}`);
  if (shortDirection !== "WAIT") reasons.push(`단기 ${directionLabel(shortDirection)} 셋업 ${shortActionable ? "확인" : "대기"}`);
  if (weeklyOpposesFourHour) reasons.push("1주봉·4시간봉 충돌로 단기 진입 차단");
  if (sweep) reasons.push(`${sweep.direction === "LONG" ? "저점" : "고점"} 유동성 스윕 감지`);
  if (primary && !rsiOkay(primary.candidateDirection)) reasons.push(`RSI ${round(currentRsi, 1)} 과열 필터`);
  if (primary && !fundingOkay(primary.candidateDirection)) reasons.push("펀딩 과열 필터");

  return {
    market: "coin",
    symbol: symbol.replace("_", "/"),
    contract: symbol,
    price: round(last, last >= 1000 ? 2 : last >= 1 ? 4 : 6),
    change24h: round(ticker?.change_percentage, 2),
    volume24h: round(ticker?.volume_24h_quote || ticker?.volume_24h_usd, 0),
    fundingRate: round(funding, 4),
    rsi: round(currentRsi, 1),
    bias: weekly.direction,
    verdict: actionableScenarios[0]?.candidateDirection || "WAIT",
    candidateDirection: primary?.candidateDirection || "WAIT",
    positionType: actionableScenarios.length > 1 ? "BOTH" : actionableScenarios[0]?.style || "WAIT",
    score: primary?.score || 0,
    entry: primary?.entry || null,
    stop: primary?.stop || null,
    target1: primary?.target1 || null,
    target2: primary?.target2 || null,
    rr: primary?.rr || 0,
    zone: primary?.zone || null,
    trigger: primary?.trigger || "상위 시간대부터 방향이 정렬될 때 재평가",
    timeframes: {
      week: weekly.direction,
      fourHour: fourHour.direction,
      oneHour: oneHour.direction,
      fifteenMinute: fifteenMinute.direction,
    },
    scenarios: { swing, shortTerm },
    reasons,
    candleClosedAt: new Date(candles15.at(-1).t * 1000).toISOString(),
  };
}

async function loadCoinRecommendations() {
  const tickers = await gatePublic("/futures/usdt/tickers", {});
  const tickerMap = new Map((Array.isArray(tickers) ? tickers : []).map((ticker) => [ticker.contract, ticker]));
  const candidates = await Promise.all(coinUniverse.map(async (symbol) => {
    try {
      const [raw15, raw1h, raw4h, raw1w] = await Promise.all([
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "15m", limit: "240" }),
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "1h", limit: "200" }),
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "4h", limit: "240" }),
        gatePublic("/futures/usdt/candlesticks", { contract: symbol, interval: "1w", limit: "120" }),
      ]);
      const candles15 = completedCandles(normalizeGateCandles(raw15), 15 * 60);
      const candles1h = completedCandles(normalizeGateCandles(raw1h), 60 * 60);
      const candles4h = completedCandles(normalizeGateCandles(raw4h), 4 * 60 * 60);
      const candles1w = completedCandles(normalizeGateCandles(raw1w), 7 * 24 * 60 * 60);
      if (candles15.length < 60 || candles1h.length < 60 || candles4h.length < 60 || candles1w.length < 22) throw new Error("다중 시간대 캔들 데이터 부족");
      return analyzeCoin(symbol, candles15, candles1h, candles4h, candles1w, tickerMap.get(symbol));
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

const hoursUntil = (date, now = Date.now()) => date ? (new Date(date).getTime() - now) / (60 * 60 * 1000) : null;
const percentText = (value) => value == null ? "미확인" : `${value >= 0 ? "+" : ""}${round(value, 1)}%`;

function analyzeStock(stock, data, context) {
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
  const baseScore = 45 + (trend === "UP" ? 25 : trend === "DOWN" ? -15 : 0) + (currentRsi >= 45 && currentRsi <= 68 ? 15 : 0) + (volumeRatio >= 1.1 ? 10 : 0) - (volatility > 4 ? 8 : 0);
  const earnings = context.earningsBySymbol?.[stock.symbol] || { next: null, latest: null };
  const latestAge = earnings.latest ? (Date.now() - new Date(earnings.latest.date).getTime()) / (24 * 60 * 60 * 1000) : null;
  const earningsAdjustment = latestAge !== null && latestAge >= 0 && latestAge <= 14
    ? earnings.latest.epsSurprise > 0 && earnings.latest.revenueSurprise > 0
      ? 8
      : earnings.latest.epsSurprise < 0 && earnings.latest.revenueSurprise < 0
        ? -10
        : -2
    : 0;
  const yieldMove = finite(context.treasury?.twoYearDailyChange, 0);
  const rateAdjustment = yieldMove >= 0.05 ? -4 : yieldMove <= -0.05 ? 3 : 0;
  let score = Math.max(0, Math.min(100, baseScore + earningsAdjustment + rateAdjustment));
  const earningsHours = hoursUntil(earnings.next?.date);
  const macroEvent = context.nextHighImpact || null;
  const macroHours = hoursUntil(macroEvent?.date);
  const earningsRisk = earningsHours !== null && earningsHours >= 0 && earningsHours <= 72;
  const macroRisk = macroHours !== null && macroHours >= 0 && macroHours <= 24;
  const consensusReady = context.providers?.consensus === "live";
  const decisionBlocked = earningsRisk || macroRisk || !consensusReady;
  if (earningsRisk || macroRisk) score = Math.min(score, 55);
  else if (macroHours !== null && macroHours >= 0 && macroHours <= 72) score = Math.min(score, 65);
  else if (!consensusReady) score = Math.min(score, 60);
  const verdict = trend === "DOWN" ? "AVOID" : !decisionBlocked && trend === "UP" && score >= 70 ? "WATCH" : "WAIT";
  const previous = closes.at(-2);
  const reasons = [
    trend === "UP" ? "20일·50일 추세 상승 배열" : trend === "DOWN" ? "20일·50일 추세 하락 배열" : "이동평균 혼조",
    `RSI ${round(currentRsi, 1)}`,
    `거래량 ${round(volumeRatio, 2)}×`,
    `20일 평균 변동폭 ${round(volatility, 2)}%`,
  ];
  if (earnings.latest && latestAge <= 14) reasons.push(`최근 실적 EPS ${percentText(earnings.latest.epsSurprise)} · 매출 ${percentText(earnings.latest.revenueSurprise)}`);
  if (Math.abs(yieldMove) >= 0.05) reasons.push(`미 2년물 일간 ${yieldMove >= 0 ? "+" : ""}${round(yieldMove * 100, 0)}bp`);
  const eventStatus = earningsRisk
    ? `실적 발표 ${Math.max(0, Math.ceil(earningsHours))}시간 전 · 신규 진입 제한`
    : macroRisk
      ? `${macroEvent.name} ${Math.max(0, Math.ceil(macroHours))}시간 전 · 신규 진입 제한`
      : !consensusReady
        ? "공식 매크로는 연결됨 · 실적/컨센서스 공급자 연결 필요"
        : macroHours !== null && macroHours >= 0 && macroHours <= 72
          ? `${macroEvent.name} ${Math.ceil(macroHours)}시간 전 · 비중 축소 구간`
          : "현재 24시간 내 중요 이벤트 없음";
  return {
    market: "stock", symbol: stock.symbol, name: stock.name, sector: stock.sector,
    price: round(data.meta.regularMarketPrice ?? last, 2),
    change: round(previous ? (last - previous) / previous * 100 : 0, 2),
    trend, rsi: round(currentRsi, 1), volatility: round(volatility, 2), volumeRatio: round(volumeRatio, 2), score: round(score, 0),
    verdict,
    reasons,
    eventStatus,
    decisionBlocked,
    dataStatus: consensusReady ? "FULL" : "OFFICIAL_ONLY",
    earnings,
    macroEvent,
    priceTime: data.meta.regularMarketTime ? new Date(data.meta.regularMarketTime * 1000).toISOString() : null,
  };
}

async function loadStockRecommendations() {
  const earningsSymbols = stockUniverse.filter((stock) => stock.symbol !== "QQQ").map((stock) => stock.symbol);
  const [context, prices] = await Promise.all([
    loadMarketContext(earningsSymbols),
    Promise.all(stockUniverse.map(async (stock) => {
      try { return { stock, data: await loadYahooChart(stock.symbol) }; }
      catch (error) { return { stock, error }; }
    })),
  ]);
  const candidates = prices.map(({ stock, data, error }) => {
    try {
      if (error) throw error;
      return analyzeStock(stock, data, context);
    } catch (failure) {
      return { market: "stock", ...stock, error: failure.message || "조회 실패" };
    }
  });
  return {
    candidates: candidates.sort((a, b) => finite(b.score, -1) - finite(a.score, -1)),
    context: {
      updatedAt: context.updatedAt,
      providers: context.providers,
      indicators: context.indicators,
      treasury: context.treasury,
      nextHighImpact: context.nextHighImpact,
      upcomingEvents: (context.events || []).filter((event) => new Date(event.date) >= new Date()).slice(0, 6),
      errors: context.errors,
      sources: context.sources,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const market = String(req.query.market || "coin");
  if (!['coin', 'stock'].includes(market)) return res.status(400).json({ error: "Unsupported market" });
  try {
    const result = market === "coin"
      ? { candidates: await loadCoinRecommendations(), context: null }
      : await loadStockRecommendations();
    res.setHeader("Cache-Control", market === "coin" ? "public, s-maxage=60, stale-while-revalidate=120" : "public, s-maxage=300, stale-while-revalidate=600");
    const stockSource = `Yahoo Finance · BLS · U.S. Treasury · Federal Reserve${result.context?.providers?.consensus === "live" ? " · FMP" : ""}`;
    return res.status(200).json({
      market,
      source: market === "coin" ? "Gate.io API v4" : stockSource,
      updatedAt: new Date().toISOString(),
      candidates: result.candidates,
      context: result.context,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Recommendation data unavailable" });
  }
}
