const GATE_HOST = "https://api.gateio.ws/api/v4";
const CONTRACT = "BTC_USDT";

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 2) => Number(finite(value).toFixed(digits));
const average = (items) => items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

async function gatePublic(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${GATE_HOST}${path}${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Gate.io ${response.status}`);
  return response.json();
}

function normalizeCandles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      t: finite(row.t ?? row[0]),
      v: finite(row.v ?? row[1]),
      c: finite(row.c ?? row[2]),
      h: finite(row.h ?? row[3]),
      l: finite(row.l ?? row[4]),
      o: finite(row.o ?? row[5]),
    }))
    .filter((row) => row.t && row.o && row.h && row.l && row.c)
    .sort((a, b) => a.t - b.t);
}

function completedCandles(rows, intervalSeconds) {
  const now = Date.now() / 1000;
  return rows.filter((candle) => candle.t + intervalSeconds <= now);
}

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
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  const recent = candles.slice(-(period + 1));
  if (recent.length < 2) return 0;
  return average(recent.slice(1).map((candle, index) => {
    const previousClose = recent[index].c;
    return Math.max(
      candle.h - candle.l,
      Math.abs(candle.h - previousClose),
      Math.abs(candle.l - previousClose),
    );
  }));
}

function timeframeSnapshot(candles, minimumSpread = 0.0005) {
  const closes = candles.map((item) => item.c);
  const last = closes.at(-1);
  const ema9 = ema(closes, 9).at(-1);
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const ema200 = closes.length >= 200 ? ema(closes, 200).at(-1) : null;
  const spread = last ? Math.abs(ema20 - ema50) / last : 0;
  let direction = "WAIT";
  if (spread >= minimumSpread && last > ema20 && ema20 > ema50) direction = "LONG";
  if (spread >= minimumSpread && last < ema20 && ema20 < ema50) direction = "SHORT";
  return {
    direction,
    last: round(last, 2),
    ema9: round(ema9, 2),
    ema20: round(ema20, 2),
    ema50: round(ema50, 2),
    ema200: ema200 == null ? null : round(ema200, 2),
    rsi: round(rsi(closes), 1),
    atr: round(atr(candles), 2),
    spread: round(spread * 100, 3),
  };
}

function pivotLevels(candles, left = 2, right = 2, limit = 120) {
  const rows = candles.slice(-limit);
  const highs = [];
  const lows = [];
  for (let index = left; index < rows.length - right; index += 1) {
    const candle = rows[index];
    const before = rows.slice(index - left, index);
    const after = rows.slice(index + 1, index + right + 1);
    if (before.every((item) => candle.h > item.h) && after.every((item) => candle.h >= item.h)) highs.push({ price: candle.h, time: candle.t });
    if (before.every((item) => candle.l < item.l) && after.every((item) => candle.l <= item.l)) lows.push({ price: candle.l, time: candle.t });
  }
  return { highs, lows };
}

function compressLevels(levels, tolerance) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const level of sorted) {
    const group = groups.find((item) => Math.abs(item.price - level.price) <= tolerance);
    if (group) {
      group.price = average([group.price, level.price]);
      group.touches += 1;
      group.time = Math.max(group.time, level.time);
    } else groups.push({ price: level.price, touches: 1, time: level.time });
  }
  return groups;
}

function nearestMarketLevels(candles, price) {
  const currentAtr = atr(candles);
  const pivots = pivotLevels(candles, 2, 2, 180);
  const highs = compressLevels(pivots.highs, Math.max(1, currentAtr * 0.22));
  const lows = compressLevels(pivots.lows, Math.max(1, currentAtr * 0.22));
  const resistance = highs.filter((item) => item.price > price).sort((a, b) => a.price - b.price).slice(0, 4);
  const support = lows.filter((item) => item.price < price).sort((a, b) => b.price - a.price).slice(0, 4);
  return {
    resistance: resistance.map((item) => ({ ...item, price: round(item.price, 2) })),
    support: support.map((item) => ({ ...item, price: round(item.price, 2) })),
    latestHigh: pivots.highs.at(-1) || null,
    latestLow: pivots.lows.at(-1) || null,
  };
}

function findFvg(candles, direction, currentPrice) {
  const candidates = [];
  for (let index = Math.max(2, candles.length - 100); index < candles.length; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];
    if (direction === "LONG" && first.h < third.l) candidates.push({ low: first.h, high: third.l, time: third.t, index });
    if (direction === "SHORT" && first.l > third.h) candidates.push({ low: third.h, high: first.l, time: third.t, index });
  }
  return candidates.reverse().find((zone) => {
    const after = candles.slice(zone.index + 1);
    const fullyFilled = direction === "LONG"
      ? after.some((candle) => candle.l <= zone.low)
      : after.some((candle) => candle.h >= zone.high);
    const relevant = direction === "LONG" ? zone.low < currentPrice : zone.high > currentPrice;
    return !fullyFilled && relevant;
  }) || null;
}

function findSweep(candles) {
  if (candles.length < 60) return null;
  const previous = candles.slice(-60, -12);
  const recent = candles.slice(-12);
  const previousHigh = Math.max(...previous.map((item) => item.h));
  const previousLow = Math.min(...previous.map((item) => item.l));
  const bearish = recent.findLast((item) => item.h > previousHigh && item.c < previousHigh);
  if (bearish) return { direction: "SHORT", level: round(previousHigh, 2), time: new Date(bearish.t * 1000).toISOString() };
  const bullish = recent.findLast((item) => item.l < previousLow && item.c > previousLow);
  if (bullish) return { direction: "LONG", level: round(previousLow, 2), time: new Date(bullish.t * 1000).toISOString() };
  return null;
}

function volumeSnapshot(candles) {
  const volumes = candles.map((item) => item.v);
  const last = volumes.at(-1) || 0;
  const baseline = average(volumes.slice(-21, -1));
  return { current: round(last, 2), average20: round(baseline, 2), ratio: round(baseline ? last / baseline : 0, 2) };
}

function rollingVwap(candles, limit = 288) {
  const rows = candles.slice(-limit);
  let value = 0;
  let volume = 0;
  for (const candle of rows) {
    const typical = (candle.h + candle.l + candle.c) / 3;
    value += typical * candle.v;
    volume += candle.v;
  }
  return volume ? value / volume : rows.at(-1)?.c || 0;
}

function orderBookSnapshot(book) {
  const bids = (book?.bids || []).slice(0, 20).map((row) => ({ price: finite(row.p ?? row[0]), size: Math.abs(finite(row.s ?? row[1])) }));
  const asks = (book?.asks || []).slice(0, 20).map((row) => ({ price: finite(row.p ?? row[0]), size: Math.abs(finite(row.s ?? row[1])) }));
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0);
  const askSize = asks.reduce((sum, row) => sum + row.size, 0);
  const total = bidSize + askSize;
  return {
    bestBid: bids[0]?.price ? round(bids[0].price, 2) : null,
    bestAsk: asks[0]?.price ? round(asks[0].price, 2) : null,
    bidSize: round(bidSize, 3),
    askSize: round(askSize, 3),
    imbalance: round(total ? (bidSize - askSize) / total * 100 : 0, 1),
  };
}

function directionScore(direction, frames, extras) {
  const weights = { week: 8, day: 14, fourHour: 20, oneHour: 20, fifteenMinute: 16, fiveMinute: 10 };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (frames[key].direction === direction) score += weight;
    else if (frames[key].direction !== "WAIT") score -= weight * 0.45;
  }
  if (extras.sweep?.direction === direction) score += 6;
  if (extras.fvg5) score += 3;
  if (extras.fvg15) score += 3;
  if (extras.volume.ratio >= 1.2) score += 4;
  if (direction === "LONG" && extras.orderBook.imbalance >= 8) score += 4;
  if (direction === "SHORT" && extras.orderBook.imbalance <= -8) score += 4;
  if (direction === "LONG" && extras.funding > 0.06) score -= 7;
  if (direction === "SHORT" && extras.funding < -0.06) score -= 7;
  const executionRsi = frames.fiveMinute.rsi;
  if (direction === "LONG" && executionRsi >= 72) score -= 8;
  if (direction === "SHORT" && executionRsi <= 28) score -= 8;
  return Math.round(clamp(score, 0, 100));
}

function selectEntryAnchor(direction, price, frame5, vwap, levels, fvg5) {
  const candidates = [];
  if (fvg5) candidates.push((fvg5.low + fvg5.high) / 2);
  candidates.push(frame5.ema20, frame5.ema50, vwap);
  if (direction === "LONG") candidates.push(...levels.support.map((item) => item.price));
  else candidates.push(...levels.resistance.map((item) => item.price));
  const filtered = candidates.filter((value) => Number.isFinite(value) && value > 0)
    .filter((value) => direction === "LONG" ? value <= price * 1.003 : value >= price * 0.997);
  if (!filtered.length) return price;
  return filtered.sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0];
}

function buildTradePlan(direction, context, score) {
  const { price, frames, levels, fvg5, fvg15, vwap, candles5, volume, orderBook } = context;
  const currentAtr = Math.max(frames.fiveMinute.atr, price * 0.0008);
  const anchor = selectEntryAnchor(direction, price, frames.fiveMinute, vwap, levels, fvg5);
  const zoneHalf = currentAtr * 0.22;
  const zoneLow = anchor - zoneHalf;
  const zoneHigh = anchor + zoneHalf;
  const structure = direction === "LONG"
    ? levels.support.find((item) => item.price < zoneLow)?.price || Math.min(...candles5.slice(-24).map((item) => item.l))
    : levels.resistance.find((item) => item.price > zoneHigh)?.price || Math.max(...candles5.slice(-24).map((item) => item.h));
  let stop = direction === "LONG"
    ? Math.min(zoneLow - currentAtr * 0.75, structure - currentAtr * 0.15)
    : Math.max(zoneHigh + currentAtr * 0.75, structure + currentAtr * 0.15);
  const entry = (zoneLow + zoneHigh) / 2;
  let risk = Math.abs(entry - stop);
  if (risk > currentAtr * 2.8) {
    stop = direction === "LONG" ? entry - currentAtr * 2.8 : entry + currentAtr * 2.8;
    risk = Math.abs(entry - stop);
  }
  if (risk < currentAtr * 0.85) {
    stop = direction === "LONG" ? entry - currentAtr * 0.85 : entry + currentAtr * 0.85;
    risk = Math.abs(entry - stop);
  }
  const nearbyTarget = direction === "LONG" ? levels.resistance[0]?.price : levels.support[0]?.price;
  const target1Base = direction === "LONG" ? entry + risk * 1.5 : entry - risk * 1.5;
  const target1 = nearbyTarget && (direction === "LONG" ? nearbyTarget > entry + risk * 0.9 : nearbyTarget < entry - risk * 0.9)
    ? nearbyTarget
    : target1Base;
  const target2 = direction === "LONG" ? entry + risk * 2.5 : entry - risk * 2.5;
  const target3 = direction === "LONG" ? entry + risk * 4 : entry - risk * 4;
  const recentHigh = Math.max(...candles5.slice(-12).map((item) => item.h));
  const recentLow = Math.min(...candles5.slice(-12).map((item) => item.l));
  const trigger = direction === "LONG" ? Math.max(zoneHigh, recentHigh) : Math.min(zoneLow, recentLow);
  const inZone = price >= zoneLow && price <= zoneHigh;
  const chased = direction === "LONG" ? price > trigger + currentAtr * 0.55 : price < trigger - currentAtr * 0.55;
  const status = inZone ? "ENTRY_ZONE" : chased ? "NO_CHASE" : "WAIT_TRIGGER";
  const fvgText = fvg5
    ? `5분 FVG ${round(fvg5.low, 2)}–${round(fvg5.high, 2)}`
    : fvg15
      ? `15분 FVG ${round(fvg15.low, 2)}–${round(fvg15.high, 2)}`
      : "가까운 FVG 없음";
  const confirmations = direction === "LONG" ? [
    `5분봉이 ${round(trigger, 2)} 위에서 종가 마감`,
    "돌파 후 재테스트에서 저점이 높아지는지 확인",
    `5분 거래량이 20봉 평균 1.20배 이상인지 확인 (현재 ${volume.ratio}배)`,
    `호가 불균형이 매수 우위인지 확인 (현재 ${orderBook.imbalance}%)`,
  ] : [
    `5분봉이 ${round(trigger, 2)} 아래에서 종가 마감`,
    "이탈 후 재테스트에서 고점이 낮아지는지 확인",
    `5분 거래량이 20봉 평균 1.20배 이상인지 확인 (현재 ${volume.ratio}배)`,
    `호가 불균형이 매도 우위인지 확인 (현재 ${orderBook.imbalance}%)`,
  ];
  return {
    direction,
    score,
    status,
    entry: round(entry, 2),
    zone: { low: round(zoneLow, 2), high: round(zoneHigh, 2) },
    trigger: round(trigger, 2),
    stop: round(stop, 2),
    targets: [
      { label: "1차", price: round(target1, 2), rr: round(Math.abs(target1 - entry) / risk, 2), action: "30~40% 청산 · 손절가를 진입가로 이동" },
      { label: "2차", price: round(target2, 2), rr: 2.5, action: "추가 30~40% 청산 · 5분 EMA20 추적" },
      { label: "3차", price: round(target3, 2), rr: 4, action: "잔여 물량 추세 추적" },
    ],
    riskDistance: round(risk, 2),
    riskPercent: round(risk / entry * 100, 3),
    invalidation: direction === "LONG"
      ? `5분봉이 ${round(stop, 2)} 아래에서 종가 마감하면 시나리오 폐기`
      : `5분봉이 ${round(stop, 2)} 위에서 종가 마감하면 시나리오 폐기`,
    noChase: direction === "LONG"
      ? `${round(trigger + currentAtr * 0.55, 2)} 이상에서는 추격 매수 금지`
      : `${round(trigger - currentAtr * 0.55, 2)} 이하에서는 추격 매도 금지`,
    basis: [fvgText, `5분 EMA20 ${frames.fiveMinute.ema20}`, `24시간 VWAP ${round(vwap, 2)}`, `구조 레벨 ${round(structure, 2)}`],
    confirmations,
  };
}

function checklistFor(direction, frames, extras, plan) {
  if (direction === "WAIT") return [
    { label: "4시간·1시간 방향 정렬", pass: frames.fourHour.direction !== "WAIT" && frames.fourHour.direction === frames.oneHour.direction },
    { label: "15분 방향 확인", pass: frames.fifteenMinute.direction !== "WAIT" },
    { label: "5분 구조 전환", pass: frames.fiveMinute.direction !== "WAIT" },
    { label: "거래량 1.2배 이상", pass: extras.volume.ratio >= 1.2 },
  ];
  return [
    { label: "1일·4시간 방향 일치", pass: frames.day.direction === direction && frames.fourHour.direction === direction },
    { label: "1시간 추세 일치", pass: frames.oneHour.direction === direction },
    { label: "15분 실행 방향 일치", pass: frames.fifteenMinute.direction === direction },
    { label: "5분 트리거 방향 확인", pass: frames.fiveMinute.direction === direction },
    { label: "5분 거래량 1.2배 이상", pass: extras.volume.ratio >= 1.2 },
    { label: "RSI 과열 아님", pass: direction === "LONG" ? frames.fiveMinute.rsi < 72 : frames.fiveMinute.rsi > 28 },
    { label: "펀딩 과열 아님", pass: direction === "LONG" ? extras.funding < 0.06 : extras.funding > -0.06 },
    { label: "추격 진입 구간 아님", pass: plan.status !== "NO_CHASE" },
  ];
}

async function loadBitcoinAnalysis() {
  const [tickers, raw5, raw15, raw1h, raw4h, raw1d, raw1w, orderBookRaw] = await Promise.all([
    gatePublic("/futures/usdt/tickers"),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "5m", limit: "500" }),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "15m", limit: "400" }),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "1h", limit: "300" }),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "4h", limit: "300" }),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "1d", limit: "260" }),
    gatePublic("/futures/usdt/candlesticks", { contract: CONTRACT, interval: "1w", limit: "160" }),
    gatePublic("/futures/usdt/order_book", { contract: CONTRACT, limit: "20", with_id: "true" }),
  ]);
  const ticker = (Array.isArray(tickers) ? tickers : []).find((item) => item.contract === CONTRACT) || {};
  const candles5 = completedCandles(normalizeCandles(raw5), 5 * 60);
  const candles15 = completedCandles(normalizeCandles(raw15), 15 * 60);
  const candles1h = completedCandles(normalizeCandles(raw1h), 60 * 60);
  const candles4h = completedCandles(normalizeCandles(raw4h), 4 * 60 * 60);
  const candles1d = completedCandles(normalizeCandles(raw1d), 24 * 60 * 60);
  const candles1w = completedCandles(normalizeCandles(raw1w), 7 * 24 * 60 * 60);
  if ([candles5, candles15, candles1h, candles4h, candles1d].some((rows) => rows.length < 60) || candles1w.length < 22) {
    throw new Error("비트코인 다중 시간대 캔들 데이터가 부족합니다.");
  }
  const price = finite(ticker.mark_price, candles5.at(-1).c);
  const frames = {
    week: timeframeSnapshot(candles1w, 0.006),
    day: timeframeSnapshot(candles1d, 0.003),
    fourHour: timeframeSnapshot(candles4h, 0.0018),
    oneHour: timeframeSnapshot(candles1h, 0.001),
    fifteenMinute: timeframeSnapshot(candles15, 0.00045),
    fiveMinute: timeframeSnapshot(candles5, 0.00022),
  };
  const levels = nearestMarketLevels(candles15, price);
  const fvg5Long = findFvg(candles5, "LONG", price);
  const fvg5Short = findFvg(candles5, "SHORT", price);
  const fvg15Long = findFvg(candles15, "LONG", price);
  const fvg15Short = findFvg(candles15, "SHORT", price);
  const sweep = findSweep(candles5) || findSweep(candles15);
  const volume = volumeSnapshot(candles5);
  const orderBook = orderBookSnapshot(orderBookRaw);
  const vwap = rollingVwap(candles5, 288);
  const funding = finite(ticker.funding_rate) * 100;
  const longScore = directionScore("LONG", frames, { sweep, fvg5: fvg5Long, fvg15: fvg15Long, volume, orderBook, funding });
  const shortScore = directionScore("SHORT", frames, { sweep, fvg5: fvg5Short, fvg15: fvg15Short, volume, orderBook, funding });
  const direction = Math.max(longScore, shortScore) >= 62 && Math.abs(longScore - shortScore) >= 8
    ? longScore > shortScore ? "LONG" : "SHORT"
    : "WAIT";
  const contextBase = { price, frames, levels, vwap, candles5, volume, orderBook };
  const longPlan = buildTradePlan("LONG", { ...contextBase, fvg5: fvg5Long, fvg15: fvg15Long }, longScore);
  const shortPlan = buildTradePlan("SHORT", { ...contextBase, fvg5: fvg5Short, fvg15: fvg15Short }, shortScore);
  const primaryPlan = direction === "LONG" ? longPlan : direction === "SHORT" ? shortPlan : longScore >= shortScore ? longPlan : shortPlan;
  const checklist = checklistFor(direction, frames, { volume, funding }, primaryPlan);
  const passed = checklist.filter((item) => item.pass).length;
  const status = direction === "WAIT"
    ? "상위 시간대와 실행 시간대가 충분히 정렬되지 않아 대기"
    : primaryPlan.status === "ENTRY_ZONE"
      ? `${direction} 진입 구간 도달 · 5분봉 확인 필요`
      : primaryPlan.status === "NO_CHASE"
        ? `${direction} 방향 우세지만 추격 금지 구간`
        : `${direction} 우세 · 5분 트리거 대기`;
  return {
    market: "coin",
    asset: "BTC/USDT",
    contract: CONTRACT,
    price: round(price, 2),
    change24h: round(ticker.change_percentage, 2),
    fundingRate: round(funding, 4),
    volume24h: round(ticker.volume_24h_quote || ticker.volume_24h_usd, 0),
    updatedAt: new Date().toISOString(),
    candleClosedAt: new Date(candles5.at(-1).t * 1000).toISOString(),
    direction,
    status,
    confidence: direction === "WAIT" ? Math.max(longScore, shortScore) : direction === "LONG" ? longScore : shortScore,
    scores: { long: longScore, short: shortScore },
    timeframes: frames,
    marketStructure: {
      vwap24h: round(vwap, 2),
      support: levels.support,
      resistance: levels.resistance,
      sweep,
      fvg5: {
        long: fvg5Long ? { low: round(fvg5Long.low, 2), high: round(fvg5Long.high, 2) } : null,
        short: fvg5Short ? { low: round(fvg5Short.low, 2), high: round(fvg5Short.high, 2) } : null,
      },
      fvg15: {
        long: fvg15Long ? { low: round(fvg15Long.low, 2), high: round(fvg15Long.high, 2) } : null,
        short: fvg15Short ? { low: round(fvg15Short.low, 2), high: round(fvg15Short.high, 2) } : null,
      },
      orderBook,
      volume5m: volume,
    },
    plans: { long: longPlan, short: shortPlan },
    primaryPlan: primaryPlan.direction,
    checklist,
    checklistScore: { passed, total: checklist.length },
    executionRule: "진입가는 지정가 후보입니다. 반드시 5분봉 종가 확정과 재테스트를 확인한 뒤 진입하며, 신호 발생 전 시장가 진입은 차단합니다.",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await loadBitcoinAnalysis();
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json({ source: "Gate.io API v4", ...result });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Bitcoin analysis unavailable" });
  }
}
