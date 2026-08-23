import {
  assessIctConfluence,
  detectChannel,
  detectFvgZones,
  detectLiquidityPools,
  detectLiquiditySweep,
  detectMarketStructure,
  detectOrderBlock,
  rangePosition,
  sessionReferenceLevels,
} from "./_ict-engine.js";
import { chooseModelDecision, evaluateSweepReversal } from "../lib/trading/model-1-sweep-reversal.js";

const GATE_HOST = "https://api.gateio.ws/api/v4";
const CONTRACT = "BTC_USDT";
const ICT_V2_LIFECYCLE = process.env.ICT_V2_LIFECYCLE === "ACTIVE" ? "ACTIVE" : "SHADOW";
const CHART_CANDLE_LIMIT = 240;
const CHART_TIMEFRAMES = Object.freeze({
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
});

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

function completedCandles(rows, intervalSeconds, nowSeconds = Date.now() / 1000) {
  return rows.filter((candle) => candle.t + intervalSeconds <= nowSeconds);
}

function chartTimeframe(candles, timeframe, intervalSeconds, nowSeconds) {
  const rows = completedCandles(normalizeCandles(candles), intervalSeconds, nowSeconds)
    .slice(-CHART_CANDLE_LIMIT)
    .map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const first = rows[0];
  const last = rows.at(-1);
  const analysisCutoffSeconds = last ? last.t + intervalSeconds : null;
  return {
    timeframe,
    intervalSeconds,
    count: rows.length,
    startAt: first ? new Date(first.t * 1000).toISOString() : null,
    endAt: analysisCutoffSeconds ? new Date(analysisCutoffSeconds * 1000).toISOString() : null,
    analysisCutoff: analysisCutoffSeconds ? new Date(analysisCutoffSeconds * 1000).toISOString() : null,
    candles: rows,
  };
}

function buildChartPayload(candlesByTimeframe, nowSeconds = Date.now() / 1000, contract = CONTRACT) {
  const timeframes = Object.fromEntries(Object.entries(CHART_TIMEFRAMES).map(([timeframe, intervalSeconds]) => [
    timeframe,
    chartTimeframe(candlesByTimeframe[timeframe] || [], timeframe, intervalSeconds, nowSeconds),
  ]));
  return {
    version: "1.0",
    symbol: contract,
    exchange: "Gate.io",
    market: "USDT Perpetual Futures",
    defaultTimeframe: "5m",
    allowedTimeframes: Object.keys(CHART_TIMEFRAMES),
    closedCandlesOnly: true,
    timeUnit: "unix_seconds",
    candleTime: "OPEN_TIME",
    analysisCutoff: timeframes["5m"].analysisCutoff,
    alignment: {
      candleTimestamp: "t is candle open time",
      candleClose: "t + intervalSeconds",
      eventTimestamp: "decisionEngine feature confirmedAt (ISO-8601)",
      invariant: "confirmedAt <= timeframe.analysisCutoff",
    },
    timeframes,
  };
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
  if (extras.ict) score += extras.ict.score * 0.22;
  return Math.round(clamp(score, 0, 100));
}

function swingDirectionScore(direction, frames, extras) {
  const weights = { week: 22, day: 28, fourHour: 30, oneHour: 12 };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (frames[key].direction === direction) score += weight;
    else if (frames[key].direction !== "WAIT") score -= weight * 0.5;
  }
  if (frames.day.direction === direction && frames.fourHour.direction === direction) score += 8;
  if (extras.fvg4h) score += 4;
  if (direction === "LONG" && extras.funding > 0.08) score -= 8;
  if (direction === "SHORT" && extras.funding < -0.08) score -= 8;
  const swingRsi = frames.fourHour.rsi;
  if (direction === "LONG" && swingRsi >= 75) score -= 10;
  if (direction === "SHORT" && swingRsi <= 25) score -= 10;
  if (extras.ict) score += extras.ict.score * 0.2;
  return Math.round(clamp(score, 0, 100));
}

function selectEntryAnchor(direction, price, currentAtr, candidates) {
  const rows = candidates.filter((candidate) => Number.isFinite(candidate?.price) && candidate.price > 0)
    .filter((candidate) => direction === "LONG" ? candidate.price <= price : candidate.price >= price);
  if (!rows.length) return { price, score: 0, sources: ["현재가 대체값"] };
  const tolerance = Math.max(10, currentAtr * 0.35);
  const groups = [];
  for (const candidate of rows.sort((a, b) => a.price - b.price)) {
    const group = groups.find((item) => Math.abs(item.price - candidate.price) <= tolerance);
    if (group) {
      group.items.push(candidate);
      group.price = average(group.items.map((item) => item.price));
    } else groups.push({ price: candidate.price, items: [candidate] });
  }
  return groups.map((group) => ({
    price: group.price,
    score: group.items.reduce((sum, item) => sum + (item.weight || 1), 0),
    sources: [...new Set(group.items.map((item) => item.label))],
    distance: Math.abs(group.price - price),
  })).sort((a, b) => b.score - a.score || a.distance - b.distance)[0];
}

function buildTradePlan(direction, context, score) {
  const { price, frames, levels, fvg5, fvg15, vwap, candles5, volume, orderBook, ict = {}, session = {} } = context;
  const currentAtr = Math.max(frames.fiveMinute.atr, price * 0.0008);
  const candidates = [
    ict.orderBlock ? { price: ict.orderBlock.midpoint, label: "5분 OB", weight: 4 } : null,
    ict.fvg ? { price: ict.fvg.consequentEncroachment || ict.fvg.midpoint, label: "5분 FVG 50%", weight: 4 } : null,
    fvg5 ? { price: (fvg5.low + fvg5.high) / 2, label: "5분 FVG", weight: 3 } : null,
    { price: frames.fiveMinute.ema20, label: "5분 EMA20", weight: 1 },
    { price: frames.fiveMinute.ema50, label: "5분 EMA50", weight: 1 },
    { price: vwap, label: "24시간 VWAP", weight: 2 },
    ...(direction === "LONG" ? levels.support : levels.resistance).map((item) => ({ price: item.price, label: "15분 구조 레벨", weight: item.touches >= 2 ? 3 : 2 })),
    direction === "LONG" && session.asiaLow ? { price: session.asiaLow, label: "Asia Low", weight: 2 } : null,
    direction === "SHORT" && session.asiaHigh ? { price: session.asiaHigh, label: "Asia High", weight: 2 } : null,
    direction === "LONG" && session.previousDayLow ? { price: session.previousDayLow, label: "PDL", weight: 2 } : null,
    direction === "SHORT" && session.previousDayHigh ? { price: session.previousDayHigh, label: "PDH", weight: 2 } : null,
    ict.liquidity?.[direction === "LONG" ? "below" : "above"] ? {
      price: ict.liquidity[direction === "LONG" ? "below" : "above"].price,
      label: direction === "LONG" ? "EQL" : "EQH",
      weight: 3,
    } : null,
    ...(ict.liquidity?.roundNumbers || []).map((value) => ({ price: value, label: "라운드 넘버", weight: 1 })),
  ].filter(Boolean);
  const anchor = selectEntryAnchor(direction, price, currentAtr, candidates);
  const zoneHalf = currentAtr * 0.18;
  const zoneLow = anchor.price - zoneHalf;
  const zoneHigh = anchor.price + zoneHalf;
  const structuralCandidates = [
    direction === "LONG" ? ict.structure?.latestLow?.price : ict.structure?.latestHigh?.price,
    direction === "LONG" ? ict.orderBlock?.low : ict.orderBlock?.high,
    ...(direction === "LONG" ? levels.support : levels.resistance).map((item) => item.price),
  ].filter((value) => Number.isFinite(value))
    .filter((value) => direction === "LONG" ? value < zoneLow : value > zoneHigh);
  const fallbackStructure = direction === "LONG"
    ? Math.min(...candles5.slice(-24).map((item) => item.l))
    : Math.max(...candles5.slice(-24).map((item) => item.h));
  const structure = structuralCandidates.length
    ? direction === "LONG" ? Math.max(...structuralCandidates) : Math.min(...structuralCandidates)
    : fallbackStructure;
  const buffer = clamp(currentAtr * 0.12, 10, 30);
  const entry = anchor.price;
  let stop = direction === "LONG" ? structure - buffer : structure + buffer;
  let risk = Math.abs(entry - stop);
  if (risk < currentAtr * 0.65) {
    stop = direction === "LONG" ? entry - currentAtr * 0.65 : entry + currentAtr * 0.65;
    risk = Math.abs(entry - stop);
  }
  const riskPercent = risk / entry * 100;
  const riskViable = risk <= currentAtr * 2.4 && riskPercent <= 1.2;
  const liquidityTargets = [
    ...(direction === "LONG" ? levels.resistance : levels.support).map((item) => ({ price: item.price, label: "15분 스윙 유동성" })),
    direction === "LONG" && session.asiaHigh ? { price: session.asiaHigh, label: "Asia High" } : null,
    direction === "SHORT" && session.asiaLow ? { price: session.asiaLow, label: "Asia Low" } : null,
    direction === "LONG" && session.previousDayHigh ? { price: session.previousDayHigh, label: "PDH" } : null,
    direction === "SHORT" && session.previousDayLow ? { price: session.previousDayLow, label: "PDL" } : null,
    ict.liquidity?.[direction === "LONG" ? "above" : "below"] ? {
      price: ict.liquidity[direction === "LONG" ? "above" : "below"].price,
      label: direction === "LONG" ? "EQH" : "EQL",
    } : null,
    ...(ict.liquidity?.roundNumbers || []).map((value) => ({ price: value, label: "라운드 넘버" })),
  ].filter(Boolean).filter((item) => direction === "LONG" ? item.price > entry : item.price < entry);
  const rewardFor = (target) => direction === "LONG" ? target - entry : entry - target;
  const eligibleTarget = (minimumRr) => liquidityTargets
    .filter((item) => rewardFor(item.price) / risk >= minimumRr)
    .sort((a, b) => rewardFor(a.price) - rewardFor(b.price))[0];
  const firstLiquidity = eligibleTarget(1.2);
  const target1 = firstLiquidity?.price ?? (direction === "LONG" ? entry + risk * 1.2 : entry - risk * 1.2);
  const secondLiquidity = liquidityTargets
    .filter((item) => rewardFor(item.price) / risk >= 2.5 && rewardFor(item.price) > rewardFor(target1))
    .sort((a, b) => rewardFor(a.price) - rewardFor(b.price))[0];
  const target1Rr = Math.abs(target1 - entry) / risk;
  const target2Rr = Math.max(2.5, target1Rr + 1);
  const target2 = secondLiquidity?.price ?? (direction === "LONG" ? entry + risk * target2Rr : entry - risk * target2Rr);
  const target3Rr = Math.max(4, Math.abs(target2 - entry) / risk + 1.5);
  const target3 = direction === "LONG" ? entry + risk * target3Rr : entry - risk * target3Rr;
  const event = ict.structure?.latestEvent;
  const structureConfirmed = event?.direction === direction && event.displacement >= 0.6;
  const recentHigh = Math.max(...candles5.slice(-12).map((item) => item.h));
  const recentLow = Math.min(...candles5.slice(-12).map((item) => item.l));
  const trigger = structureConfirmed ? event.level : direction === "LONG" ? recentHigh : recentLow;
  const retestStart = structureConfirmed ? Math.max(event.index, ict.fvg?.index ?? -1) + 1 : candles5.length;
  const postBreak = structureConfirmed ? candles5.slice(retestStart) : [];
  const retestConfirmed = postBreak.some((candle) => candle.l <= zoneHigh && candle.h >= zoneLow
    && (direction === "LONG" ? candle.c > anchor.price : candle.c < anchor.price));
  const lastClose = candles5.at(-1).c;
  const invalidated = direction === "LONG" ? lastClose <= stop : lastClose >= stop;
  const chased = direction === "LONG" ? price > trigger + currentAtr * 0.55 : price < trigger - currentAtr * 0.55;
  const inExecutionZone = price >= zoneLow - currentAtr * 0.08 && price <= zoneHigh + currentAtr * 0.08;
  const status = invalidated ? "INVALID"
    : !riskViable ? "RISK_TOO_WIDE"
      : !structureConfirmed ? "WAIT_STRUCTURE"
        : chased ? "NO_CHASE"
          : retestConfirmed && inExecutionZone ? "ENTRY_READY"
            : "WAIT_RETEST";
  const confluence = ict.confluence || { count: 0, total: 7, score: 0, reasons: [], executionQualified: false };
  const fvgText = ict.fvg
    ? `5분 FVG ${round(ict.fvg.low, 2)}–${round(ict.fvg.high, 2)} · ${ict.fvg.state}`
    : fvg15
      ? `15분 FVG ${round(fvg15.low, 2)}–${round(fvg15.high, 2)}`
      : "가까운 유효 FVG 없음";
  const obText = ict.orderBlock
    ? `5분 ${direction} OB ${round(ict.orderBlock.low, 2)}–${round(ict.orderBlock.high, 2)} · ${ict.orderBlock.state}`
    : "구조 변화와 연결된 유효 OB 없음";
  const pdText = ict.range ? `15분 레인지 ${ict.range.zone} · EQ ${round(ict.range.equilibrium, 2)}` : "프리미엄/디스카운트 N/A";
  const confirmations = [
    structureConfirmed
      ? `5분 ${event.type} 확정: 종가가 ${round(trigger, 2)} ${direction === "LONG" ? "위" : "아래"}에서 마감`
      : `5분봉 몸통 기준 ${round(trigger, 2)} ${direction === "LONG" ? "상향" : "하향"} BOS/CHoCH 대기`,
    `${moneyText(zoneLow)}–${moneyText(zoneHigh)} OB/FVG 구간 첫 리테스트 후 ${direction === "LONG" ? "저점 상승" : "고점 하락"} 확인`,
    `5분 거래량이 20봉 평균 1.20배 이상인지 확인 (현재 ${volume.ratio}배)`,
    `호가 불균형은 보조 확인만 사용 (현재 ${orderBook.imbalance}%)`,
  ];
  const actionable = confluence.executionQualified && riskViable && retestConfirmed && inExecutionZone && !chased && !invalidated;
  return {
    direction,
    score,
    status,
    actionable,
    setupQuality: confluence.score,
    confluence: { count: confluence.count, total: confluence.total, reasons: confluence.reasons },
    entry: round(entry, 2),
    zone: { low: round(zoneLow, 2), high: round(zoneHigh, 2) },
    trigger: round(trigger, 2),
    triggerLabel: "5분봉 BOS/CHoCH 확정",
    hardStop: round(stop, 2),
    stop: round(stop, 2),
    targets: [
      { label: "1차", price: round(target1, 2), rr: round(Math.abs(target1 - entry) / risk, 2), action: `50% 청산 · BE 이동${firstLiquidity ? ` · ${firstLiquidity.label}` : ""}` },
      { label: "2차", price: round(target2, 2), rr: round(Math.abs(target2 - entry) / risk, 2), action: `30% 청산 · 5분 EMA20 추적${secondLiquidity ? ` · ${secondLiquidity.label}` : ""}` },
      { label: "3차", price: round(target3, 2), rr: round(target3Rr, 2), action: "잔여 20% · 구조 추적" },
    ],
    riskDistance: round(risk, 2),
    riskPercent: round(riskPercent, 3),
    riskViable,
    minimumRrMet: Math.abs(target1 - entry) / risk >= 1.2,
    invalidation: `하드 스탑 ${round(stop, 2)} 즉시 실행 · 5분봉 종가가 구조 밖에서 마감하면 셋업 재사용 금지`,
    noChase: direction === "LONG"
      ? `${round(trigger + currentAtr * 0.55, 2)} 이상에서는 추격 매수 금지`
      : `${round(trigger - currentAtr * 0.55, 2)} 이하에서는 추격 매도 금지`,
    basis: [obText, fvgText, pdText, ...anchor.sources.slice(0, 3), ...confluence.reasons.slice(0, 3)],
    confirmations,
  };
}

function moneyText(value) {
  return `$${round(value, 2).toLocaleString("en-US")}`;
}

function buildSwingTradePlan(direction, context, score) {
  const { price, frames, levels, fvg4h, candles4h, candles1h, funding, ict = {}, session = {} } = context;
  const currentAtr = Math.max(frames.fourHour.atr, price * 0.006);
  const candidates = [
    ict.orderBlock ? { price: ict.orderBlock.midpoint, label: "4시간 OB", weight: 4 } : null,
    ict.fvg ? { price: ict.fvg.consequentEncroachment || ict.fvg.midpoint, label: "4시간 FVG 50%", weight: 4 } : null,
    fvg4h ? { price: (fvg4h.low + fvg4h.high) / 2, label: "4시간 FVG", weight: 3 } : null,
    { price: frames.fourHour.ema20, label: "4시간 EMA20", weight: 1 },
    { price: frames.fourHour.ema50, label: "4시간 EMA50", weight: 1 },
    { price: frames.day.ema20, label: "일봉 EMA20", weight: 2 },
    ...(direction === "LONG" ? levels.support : levels.resistance).map((item) => ({ price: item.price, label: "4시간 구조 레벨", weight: item.touches >= 2 ? 3 : 2 })),
    direction === "LONG" && session.previousWeekLow ? { price: session.previousWeekLow, label: "PWL", weight: 3 } : null,
    direction === "SHORT" && session.previousWeekHigh ? { price: session.previousWeekHigh, label: "PWH", weight: 3 } : null,
  ].filter(Boolean);
  const anchor = selectEntryAnchor(direction, price, currentAtr, candidates);
  const zoneHalf = currentAtr * 0.22;
  const zoneLow = anchor.price - zoneHalf;
  const zoneHigh = anchor.price + zoneHalf;
  const structuralCandidates = [
    direction === "LONG" ? ict.structure?.latestLow?.price : ict.structure?.latestHigh?.price,
    direction === "LONG" ? ict.orderBlock?.low : ict.orderBlock?.high,
    ...(direction === "LONG" ? levels.support : levels.resistance).map((item) => item.price),
  ].filter((value) => Number.isFinite(value))
    .filter((value) => direction === "LONG" ? value < zoneLow : value > zoneHigh);
  const fallbackStructure = direction === "LONG"
    ? Math.min(...candles4h.slice(-18).map((item) => item.l))
    : Math.max(...candles4h.slice(-18).map((item) => item.h));
  const structure = structuralCandidates.length
    ? direction === "LONG" ? Math.max(...structuralCandidates) : Math.min(...structuralCandidates)
    : fallbackStructure;
  const buffer = Math.max(30, currentAtr * 0.18);
  const entry = anchor.price;
  let stop = direction === "LONG" ? structure - buffer : structure + buffer;
  let risk = Math.abs(entry - stop);
  if (risk < currentAtr * 1.1) {
    stop = direction === "LONG" ? entry - currentAtr * 1.1 : entry + currentAtr * 1.1;
    risk = Math.abs(entry - stop);
  }
  const riskPercent = risk / entry * 100;
  const riskViable = risk <= currentAtr * 3.2 && riskPercent <= 4;
  const liquidityTargets = [
    ...(direction === "LONG" ? levels.resistance : levels.support).map((item) => ({ price: item.price, label: "4시간 스윙 유동성" })),
    direction === "LONG" && session.previousWeekHigh ? { price: session.previousWeekHigh, label: "PWH" } : null,
    direction === "SHORT" && session.previousWeekLow ? { price: session.previousWeekLow, label: "PWL" } : null,
    ict.liquidity?.[direction === "LONG" ? "above" : "below"] ? {
      price: ict.liquidity[direction === "LONG" ? "above" : "below"].price,
      label: direction === "LONG" ? "4H EQH" : "4H EQL",
    } : null,
  ].filter(Boolean).filter((item) => direction === "LONG" ? item.price > entry : item.price < entry);
  const rewardFor = (target) => direction === "LONG" ? target - entry : entry - target;
  const eligibleTarget = (minimumRr) => liquidityTargets
    .filter((item) => rewardFor(item.price) / risk >= minimumRr)
    .sort((a, b) => rewardFor(a.price) - rewardFor(b.price))[0];
  const firstLiquidity = eligibleTarget(1.2);
  const target1 = firstLiquidity?.price ?? (direction === "LONG" ? entry + risk * 1.2 : entry - risk * 1.2);
  const secondLiquidity = liquidityTargets
    .filter((item) => rewardFor(item.price) / risk >= 2.5 && rewardFor(item.price) > rewardFor(target1))
    .sort((a, b) => rewardFor(a.price) - rewardFor(b.price))[0];
  const target1Rr = Math.abs(target1 - entry) / risk;
  const target2Rr = Math.max(2.5, target1Rr + 1);
  const target2 = secondLiquidity?.price ?? (direction === "LONG" ? entry + risk * target2Rr : entry - risk * target2Rr);
  const target3Rr = Math.max(4, Math.abs(target2 - entry) / risk + 1.5);
  const target3 = direction === "LONG" ? entry + risk * target3Rr : entry - risk * target3Rr;
  const event = ict.structure?.latestEvent;
  const structureConfirmed = event ? event.direction === direction && event.displacement >= 0.6 : frames.oneHour.direction === direction;
  const recentHigh = Math.max(...candles1h.slice(-12).map((item) => item.h));
  const recentLow = Math.min(...candles1h.slice(-12).map((item) => item.l));
  const trigger = event?.direction === direction ? event.level : direction === "LONG" ? recentHigh : recentLow;
  const retestStart = event?.direction === direction ? Math.max(event.index, ict.fvg?.index ?? -1) + 1 : candles1h.length;
  const postBreak = event?.direction === direction ? candles1h.slice(retestStart) : [];
  const retestConfirmed = postBreak.length
    ? postBreak.some((candle) => candle.l <= zoneHigh && candle.h >= zoneLow && (direction === "LONG" ? candle.c > anchor.price : candle.c < anchor.price))
    : false;
  const lastClose = candles1h.at(-1).c;
  const invalidated = direction === "LONG" ? lastClose <= stop : lastClose >= stop;
  const chased = direction === "LONG" ? price > trigger + currentAtr * 0.7 : price < trigger - currentAtr * 0.7;
  const inExecutionZone = price >= zoneLow - currentAtr * 0.08 && price <= zoneHigh + currentAtr * 0.08;
  const status = invalidated ? "INVALID"
    : !riskViable ? "RISK_TOO_WIDE"
      : !structureConfirmed ? "WAIT_STRUCTURE"
        : chased ? "NO_CHASE"
          : retestConfirmed && inExecutionZone ? "ENTRY_READY"
            : "WAIT_RETEST";
  const confluence = ict.confluence || { count: 0, total: 7, score: 0, reasons: [], executionQualified: false };
  const obText = ict.orderBlock
    ? `4시간 ${direction} OB ${round(ict.orderBlock.low, 2)}–${round(ict.orderBlock.high, 2)} · ${ict.orderBlock.state}`
    : "구조 변화와 연결된 유효 4시간 OB 없음";
  const fvgText = ict.fvg
    ? `4시간 FVG ${round(ict.fvg.low, 2)}–${round(ict.fvg.high, 2)} · ${ict.fvg.state}`
    : fvg4h
      ? `4시간 FVG ${round(fvg4h.low, 2)}–${round(fvg4h.high, 2)}`
      : "가까운 유효 4시간 FVG 없음";
  const pdText = ict.range ? `4시간 레인지 ${ict.range.zone} · EQ ${round(ict.range.equilibrium, 2)}` : "프리미엄/디스카운트 N/A";
  const confirmations = [
    `일봉·4시간 ${direction} 바이어스 유지`,
    structureConfirmed
      ? `1시간 ${event?.type || "구조"} 확정: ${round(trigger, 2)} ${direction === "LONG" ? "상향" : "하향"} 종가 마감`
      : `1시간봉 몸통 기준 ${round(trigger, 2)} 구조 변화 대기`,
    `${moneyText(zoneLow)}–${moneyText(zoneHigh)} 4시간 OB/FVG 첫 리테스트 확인`,
    `4시간 RSI 과열 여부 확인 (현재 ${frames.fourHour.rsi}) · 펀딩 ${round(funding, 4)}%`,
  ];
  const actionable = confluence.executionQualified && riskViable && retestConfirmed && inExecutionZone && !chased && !invalidated;
  return {
    mode: "SWING",
    direction,
    score,
    status,
    actionable,
    setupQuality: confluence.score,
    confluence: { count: confluence.count, total: confluence.total, reasons: confluence.reasons },
    holdingPeriod: "2~14일",
    entry: round(entry, 2),
    zone: { low: round(zoneLow, 2), high: round(zoneHigh, 2) },
    trigger: round(trigger, 2),
    triggerLabel: "1시간봉 BOS/CHoCH 확정",
    hardStop: round(stop, 2),
    stop: round(stop, 2),
    targets: [
      { label: "1차", price: round(target1, 2), rr: round(Math.abs(target1 - entry) / risk, 2), action: `40% 청산 · BE 이동${firstLiquidity ? ` · ${firstLiquidity.label}` : ""}` },
      { label: "2차", price: round(target2, 2), rr: round(Math.abs(target2 - entry) / risk, 2), action: `30% 청산 · 4시간 EMA20 추적${secondLiquidity ? ` · ${secondLiquidity.label}` : ""}` },
      { label: "3차", price: round(target3, 2), rr: round(target3Rr, 2), action: "잔여 30% · 일봉 구조 추적" },
    ],
    riskDistance: round(risk, 2),
    riskPercent: round(riskPercent, 3),
    riskViable,
    minimumRrMet: Math.abs(target1 - entry) / risk >= 1.2,
    invalidation: `하드 스탑 ${round(stop, 2)} 즉시 실행 · 4시간봉이 구조 밖에서 종가 마감하면 스윙 시나리오 폐기`,
    noChase: direction === "LONG"
      ? `${round(trigger + currentAtr * 0.7, 2)} 이상에서는 신규 스윙 추격 매수 금지`
      : `${round(trigger - currentAtr * 0.7, 2)} 이하에서는 신규 스윙 추격 매도 금지`,
    basis: [obText, fvgText, pdText, ...anchor.sources.slice(0, 3), ...confluence.reasons.slice(0, 3)],
    confirmations,
    funding: round(funding, 4),
  };
}

function checklistFor(direction, frames, extras, plan) {
  const targetDirection = direction === "WAIT" ? plan.direction : direction;
  return [
    { label: "4시간·1시간 HTF 정렬", pass: frames.fourHour.direction === targetDirection && frames.oneHour.direction === targetDirection },
    { label: "5분 몸통 BOS/CHoCH 확정", pass: !["WAIT_STRUCTURE", "INVALID"].includes(plan.status) },
    { label: "OB/FVG·유동성 3개 이상 겹침", pass: plan.confluence?.count >= 3 },
    { label: "첫 리테스트 확인", pass: plan.status === "ENTRY_READY" },
    { label: "5분 거래량 1.2배 이상", pass: extras.volume.ratio >= 1.2 },
    { label: "RSI 과열 아님", pass: targetDirection === "LONG" ? frames.fiveMinute.rsi < 72 : frames.fiveMinute.rsi > 28 },
    { label: "펀딩 과열 아님", pass: targetDirection === "LONG" ? extras.funding < 0.06 : extras.funding > -0.06 },
    { label: "구조 손절 폭 적정", pass: plan.riskViable },
    { label: "1차 목표 최소 R:R 1.2", pass: plan.minimumRrMet },
    { label: "추격 진입 구간 아님", pass: plan.status !== "NO_CHASE" },
  ];
}

function swingChecklistFor(direction, frames, extras, plan) {
  const targetDirection = direction === "WAIT" ? plan.direction : direction;
  return [
    { label: "주봉이 반대 방향이 아님", pass: frames.week.direction === "WAIT" || frames.week.direction === targetDirection },
    { label: "일봉 방향 일치", pass: frames.day.direction === targetDirection },
    { label: "4시간 구조 일치", pass: frames.fourHour.direction === targetDirection },
    { label: "1시간 몸통 BOS/CHoCH 확정", pass: !["WAIT_STRUCTURE", "INVALID"].includes(plan.status) },
    { label: "4시간 OB/FVG 컨플루언스", pass: plan.confluence?.count >= 3 },
    { label: "1시간 첫 리테스트 확인", pass: plan.status === "ENTRY_READY" },
    { label: "4시간 RSI 과열 아님", pass: targetDirection === "LONG" ? frames.fourHour.rsi < 75 : frames.fourHour.rsi > 25 },
    { label: "펀딩 과열 아님", pass: targetDirection === "LONG" ? extras.funding < 0.08 : extras.funding > -0.08 },
    { label: "구조 손절 폭 적정", pass: plan.riskViable },
    { label: "1차 목표 최소 R:R 1.2", pass: plan.minimumRrMet },
    { label: "추격 진입 구간 아님", pass: plan.status !== "NO_CHASE" },
  ];
}

function namedLiquidityReferences(session, candles5, scope = "SHORT_TERM") {
  const latest = candles5.at(-1);
  if (!latest) return [];
  const current = new Date(latest.t * 1000);
  const dayStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()) / 1000;
  const dayOfWeek = current.getUTCDay();
  const weekStart = dayStart - ((dayOfWeek + 6) % 7) * 86400;
  const hour = current.getUTCHours();
  const rows = scope === "SWING" ? [
    session.previousWeekHigh ? { label: "PWH", price: session.previousWeekHigh, side: "BUY_SIDE", confirmedAt: new Date(weekStart * 1000).toISOString(), qualityScore: 92 } : null,
    session.previousWeekLow ? { label: "PWL", price: session.previousWeekLow, side: "SELL_SIDE", confirmedAt: new Date(weekStart * 1000).toISOString(), qualityScore: 92 } : null,
  ] : [
    session.previousDayHigh ? { label: "PDH", price: session.previousDayHigh, side: "BUY_SIDE", confirmedAt: new Date(dayStart * 1000).toISOString(), qualityScore: 88 } : null,
    session.previousDayLow ? { label: "PDL", price: session.previousDayLow, side: "SELL_SIDE", confirmedAt: new Date(dayStart * 1000).toISOString(), qualityScore: 88 } : null,
    hour >= 8 && session.asiaHigh ? { label: "ASIA_HIGH", price: session.asiaHigh, side: "BUY_SIDE", confirmedAt: new Date((dayStart + 8 * 3600) * 1000).toISOString(), qualityScore: 82 } : null,
    hour >= 8 && session.asiaLow ? { label: "ASIA_LOW", price: session.asiaLow, side: "SELL_SIDE", confirmedAt: new Date((dayStart + 8 * 3600) * 1000).toISOString(), qualityScore: 82 } : null,
  ];
  return rows.filter(Boolean);
}

function decisionStatus(result) {
  if (result.decision === "LONG" || result.decision === "SHORT") return `${result.decision} · ${result.state.stateLabel}`;
  if (result.decision === "NO_TRADE") return `NO_TRADE · ${result.state.stateLabel}`;
  return `WAIT · ${result.state.stateLabel} · ${result.state.nextCondition}`;
}

function toPublicDecisionSetup(result, lifecycle = ICT_V2_LIFECYCLE) {
  if (!result) return result;
  const stateReady = result.state?.state === "ENTRY_READY";
  const directionalDecision = ["LONG", "SHORT"].includes(result.decision);
  const engineEligible = Boolean(stateReady && result.hardFilterPassed && directionalDecision && result.tradePlan);
  const executionEligible = lifecycle === "ACTIVE" && engineEligible;
  const executionPlan = executionEligible ? result.tradePlan : null;
  const lockedPrices = { entry: null, entryZone: null, stop: null, targets: null };
  const referencePrices = executionPlan ? {
    entry: executionPlan.entry,
    entryZone: executionPlan.entryZone,
    stop: executionPlan.stop,
    targets: executionPlan.targets,
  } : lockedPrices;
  const candidatePlan = result.candidatePlan ? {
    ...result.candidatePlan,
    classification: "ANALYSIS_CANDIDATE",
    analysisCandidateOnly: true,
    orderExecutable: false,
    lifecycle,
    notice: "분석·차트 근거용 후보 레벨이며 실제 주문 또는 실행 승인이 아닙니다.",
  } : null;
  return {
    ...result,
    candidatePlan,
    tradePlan: executionPlan,
    overlayPolicy: {
      evidenceVisible: true,
      candidateLevelsVisible: true,
      candidateClassification: "ANALYSIS_ONLY",
      executionLevelsVisible: executionEligible,
      executionRule: "ACTIVE + ENTRY_READY + Hard Filter + Directional Decision",
    },
    execution: {
      eligible: executionEligible,
      lifecycle,
      stateReady,
      hardFilterPassed: Boolean(result.hardFilterPassed),
      orderConnection: "NOT_CONNECTED",
      orderStatus: "NO_ACTUAL_ORDER",
      referencePrices,
      lockReason: executionEligible
        ? null
        : lifecycle !== "ACTIVE"
          ? "SHADOW_LIFECYCLE"
          : !stateReady
            ? "ENTRY_NOT_READY"
            : !result.hardFilterPassed
              ? "HARD_FILTER_FAILED"
              : "NO_DIRECTIONAL_DECISION",
    },
  };
}

function normalizeContract(value) {
  const contract = String(value || CONTRACT).trim().toUpperCase().replaceAll("/", "_").replaceAll("-", "_");
  if (!/^[A-Z0-9]{2,20}_USDT$/.test(contract)) throw new Error("지원하지 않는 선물 심볼입니다.");
  return contract;
}

function attachOrderBlock(setup, candles, direction) {
  const structure = detectMarketStructure(candles, { eventLookback: 90 });
  return { ...setup, orderBlock: detectOrderBlock(candles, direction, structure) };
}

async function loadBitcoinAnalysis(requestedContract = CONTRACT) {
  const contract = normalizeContract(requestedContract);
  const [tickers, raw5, raw15, raw1h, raw4h, raw1d, raw1w, orderBookRaw] = await Promise.all([
    gatePublic("/futures/usdt/tickers"),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "5m", limit: "500" }),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "15m", limit: "400" }),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "1h", limit: "300" }),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "4h", limit: "300" }),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "1d", limit: "260" }),
    gatePublic("/futures/usdt/candlesticks", { contract, interval: "1w", limit: "160" }),
    gatePublic("/futures/usdt/order_book", { contract, limit: "20", with_id: "true" }),
  ]);
  const ticker = (Array.isArray(tickers) ? tickers : []).find((item) => item.contract === contract);
  if (!ticker) throw new Error("Gate.io에서 해당 USDT 무기한 선물 종목을 찾을 수 없습니다.");
  const analysisNowSeconds = Date.now() / 1000;
  const candles5 = completedCandles(normalizeCandles(raw5), 5 * 60, analysisNowSeconds);
  const candles15 = completedCandles(normalizeCandles(raw15), 15 * 60, analysisNowSeconds);
  const candles1h = completedCandles(normalizeCandles(raw1h), 60 * 60, analysisNowSeconds);
  const candles4h = completedCandles(normalizeCandles(raw4h), 4 * 60 * 60, analysisNowSeconds);
  const candles1d = completedCandles(normalizeCandles(raw1d), 24 * 60 * 60, analysisNowSeconds);
  const candles1w = completedCandles(normalizeCandles(raw1w), 7 * 24 * 60 * 60, analysisNowSeconds);
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
  const swingLevels = nearestMarketLevels(candles4h, price);
  const fvg5Long = findFvg(candles5, "LONG", price);
  const fvg5Short = findFvg(candles5, "SHORT", price);
  const fvg15Long = findFvg(candles15, "LONG", price);
  const fvg15Short = findFvg(candles15, "SHORT", price);
  const fvg4hLong = findFvg(candles4h, "LONG", price);
  const fvg4hShort = findFvg(candles4h, "SHORT", price);
  const volume = volumeSnapshot(candles5);
  const orderBook = orderBookSnapshot(orderBookRaw);
  const vwap = rollingVwap(candles5, 288);
  const funding = finite(ticker.funding_rate) * 100;
  const session = sessionReferenceLevels(candles5, candles1d) || {};
  const shortModelLiquidity = namedLiquidityReferences(session, candles5, "SHORT_TERM");
  const swingModelLiquidity = namedLiquidityReferences(session, candles5, "SWING");
  const model1ShortLong = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles5,
    contextCandles: candles1h,
    direction: "LONG",
    executionTimeframe: "5m",
    contextTimeframe: "1h",
    namedLiquidity: shortModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles5, "LONG");
  const model1ShortShort = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles5,
    contextCandles: candles1h,
    direction: "SHORT",
    executionTimeframe: "5m",
    contextTimeframe: "1h",
    namedLiquidity: shortModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles5, "SHORT");
  const model1ShortSelected = chooseModelDecision(model1ShortLong, model1ShortShort);
  const model1Short15Long = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles15,
    contextCandles: candles1h,
    direction: "LONG",
    executionTimeframe: "15m",
    contextTimeframe: "1h",
    namedLiquidity: shortModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles15, "LONG");
  const model1Short15Short = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles15,
    contextCandles: candles1h,
    direction: "SHORT",
    executionTimeframe: "15m",
    contextTimeframe: "1h",
    namedLiquidity: shortModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles15, "SHORT");
  const model1Short15Selected = chooseModelDecision(model1Short15Long, model1Short15Short);
  const model1SwingLong = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles1h,
    contextCandles: candles4h,
    direction: "LONG",
    executionTimeframe: "1h",
    contextTimeframe: "4h",
    namedLiquidity: swingModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles1h, "LONG");
  const model1SwingShort = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles1h,
    contextCandles: candles4h,
    direction: "SHORT",
    executionTimeframe: "1h",
    contextTimeframe: "4h",
    namedLiquidity: swingModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles1h, "SHORT");
  const model1SwingSelected = chooseModelDecision(model1SwingLong, model1SwingShort);
  const model1Swing4hLong = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles4h,
    contextCandles: candles1d,
    direction: "LONG",
    executionTimeframe: "4h",
    contextTimeframe: "1d",
    namedLiquidity: swingModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles4h, "LONG");
  const model1Swing4hShort = attachOrderBlock(toPublicDecisionSetup(evaluateSweepReversal({
    executionCandles: candles4h,
    contextCandles: candles1d,
    direction: "SHORT",
    executionTimeframe: "4h",
    contextTimeframe: "1d",
    namedLiquidity: swingModelLiquidity,
    mode: "BALANCED", symbol: contract,
  })), candles4h, "SHORT");
  const model1Swing4hSelected = chooseModelDecision(model1Swing4hLong, model1Swing4hShort);
  const structure5 = detectMarketStructure(candles5, { eventLookback: 80 });
  const structure15 = detectMarketStructure(candles15, { eventLookback: 80 });
  const structure1h = detectMarketStructure(candles1h, { eventLookback: 90 });
  const structure4h = detectMarketStructure(candles4h, { eventLookback: 90 });
  const liquidity15 = detectLiquidityPools(candles15, price);
  const liquidity4h = detectLiquidityPools(candles4h, price);
  const executionRange = rangePosition(candles15, price, { lookback: 72 });
  const swingRange = rangePosition(candles4h, price, { lookback: 60 });
  const channel15 = detectChannel(candles15, price);
  const channel4h = detectChannel(candles4h, price);
  const shortHtfBias = frames.fourHour.direction === frames.oneHour.direction && frames.oneHour.direction !== "WAIT"
    ? frames.oneHour.direction
    : "WAIT";
  const swingHtfBias = frames.day.direction === frames.fourHour.direction && frames.fourHour.direction !== "WAIT"
    ? frames.fourHour.direction
    : "WAIT";
  const shortLiquidityLevels = [
    liquidity15.above ? { ...liquidity15.above, label: "EQH" } : null,
    liquidity15.below ? { ...liquidity15.below, label: "EQL" } : null,
    session.asiaHigh ? { price: session.asiaHigh, label: "Asia High" } : null,
    session.asiaLow ? { price: session.asiaLow, label: "Asia Low" } : null,
    session.previousDayHigh ? { price: session.previousDayHigh, label: "PDH" } : null,
    session.previousDayLow ? { price: session.previousDayLow, label: "PDL" } : null,
  ].filter(Boolean);
  const swingLiquidityLevels = [
    liquidity4h.above ? { ...liquidity4h.above, label: "4H EQH" } : null,
    liquidity4h.below ? { ...liquidity4h.below, label: "4H EQL" } : null,
    session.previousWeekHigh ? { price: session.previousWeekHigh, label: "PWH" } : null,
    session.previousWeekLow ? { price: session.previousWeekLow, label: "PWL" } : null,
  ].filter(Boolean);
  const executionSweep = detectLiquiditySweep(candles5, shortLiquidityLevels);
  const swingSweep = detectLiquiditySweep(candles1h, swingLiquidityLevels, { lookback: 12 });
  const ictShort = {};
  const ictSwing = {};
  for (const directionKey of ["LONG", "SHORT"]) {
    const shortFvg = detectFvgZones(candles5, directionKey, price, { maxResults: 2 })[0] || null;
    const swingFvg = detectFvgZones(candles4h, directionKey, price, { maxResults: 2 })[0] || null;
    const shortContext = {
      htfBias: shortHtfBias,
      structure: structure5,
      higherExecution: structure15,
      orderBlock: detectOrderBlock(candles5, directionKey, structure5),
      fvg: shortFvg,
      sweep: executionSweep,
      range: executionRange,
      liquidity: liquidity15,
      channel: channel15,
    };
    shortContext.confluence = assessIctConfluence(directionKey, shortContext);
    ictShort[directionKey] = shortContext;
    const swingContextIct = {
      htfBias: swingHtfBias,
      structure: structure1h,
      higherExecution: structure4h,
      orderBlock: detectOrderBlock(candles4h, directionKey, structure4h),
      fvg: swingFvg,
      sweep: swingSweep,
      range: swingRange,
      liquidity: liquidity4h,
      channel: channel4h,
    };
    swingContextIct.confluence = assessIctConfluence(directionKey, swingContextIct);
    ictSwing[directionKey] = swingContextIct;
  }
  const longScore = directionScore("LONG", frames, { sweep: executionSweep, fvg5: fvg5Long, fvg15: fvg15Long, volume, orderBook, funding, ict: ictShort.LONG.confluence });
  const shortScore = directionScore("SHORT", frames, { sweep: executionSweep, fvg5: fvg5Short, fvg15: fvg15Short, volume, orderBook, funding, ict: ictShort.SHORT.confluence });
  const swingLongScore = swingDirectionScore("LONG", frames, { fvg4h: fvg4hLong, funding, ict: ictSwing.LONG.confluence });
  const swingShortScore = swingDirectionScore("SHORT", frames, { fvg4h: fvg4hShort, funding, ict: ictSwing.SHORT.confluence });
  const candidateDirection = longScore > shortScore ? "LONG" : "SHORT";
  const candidateIct = ictShort[candidateDirection].confluence;
  const direction = Math.max(longScore, shortScore) >= 68
    && Math.abs(longScore - shortScore) >= 10
    && candidateIct.executionQualified
    ? candidateDirection
    : "WAIT";
  const contextBase = { price, frames, levels, vwap, candles5, volume, orderBook, session };
  const longPlan = buildTradePlan("LONG", { ...contextBase, fvg5: fvg5Long, fvg15: fvg15Long, ict: ictShort.LONG }, longScore);
  const shortPlan = buildTradePlan("SHORT", { ...contextBase, fvg5: fvg5Short, fvg15: fvg15Short, ict: ictShort.SHORT }, shortScore);
  const primaryPlan = direction === "LONG" ? longPlan : direction === "SHORT" ? shortPlan : longScore >= shortScore ? longPlan : shortPlan;
  const checklist = checklistFor(direction, frames, { volume, funding }, primaryPlan);
  const passed = checklist.filter((item) => item.pass).length;
  const candidateSwingDirection = swingLongScore > swingShortScore ? "LONG" : "SHORT";
  const candidateSwingIct = ictSwing[candidateSwingDirection].confluence;
  const swingDirection = Math.max(swingLongScore, swingShortScore) >= 64
    && Math.abs(swingLongScore - swingShortScore) >= 8
    && candidateSwingIct.executionQualified
    ? candidateSwingDirection
    : "WAIT";
  const swingContext = { price, frames, levels: swingLevels, candles4h, candles1h, funding, session };
  const swingLongPlan = buildSwingTradePlan("LONG", { ...swingContext, fvg4h: fvg4hLong, ict: ictSwing.LONG }, swingLongScore);
  const swingShortPlan = buildSwingTradePlan("SHORT", { ...swingContext, fvg4h: fvg4hShort, ict: ictSwing.SHORT }, swingShortScore);
  const primarySwingPlan = swingDirection === "LONG" ? swingLongPlan : swingDirection === "SHORT" ? swingShortPlan : swingLongScore >= swingShortScore ? swingLongPlan : swingShortPlan;
  const swingChecklist = swingChecklistFor(swingDirection, frames, { funding }, primarySwingPlan);
  const swingPassed = swingChecklist.filter((item) => item.pass).length;
  const chart = buildChartPayload({
    "5m": candles5,
    "15m": candles15,
    "1h": candles1h,
    "4h": candles4h,
  }, analysisNowSeconds, contract);
  const status = direction === "WAIT"
    ? "HTF·구조·ICT 컨플루언스가 부족해 관망"
    : primaryPlan.status === "ENTRY_READY"
      ? `${direction} 구조 확정 + 첫 리테스트 완료 · 실행 후보`
      : primaryPlan.status === "NO_CHASE"
        ? `${direction} 바이어스지만 추격 금지 구간`
        : primaryPlan.status === "RISK_TOO_WIDE"
          ? `${direction} 후보지만 구조 손절이 넓어 관망`
          : `${direction} 바이어스 · BOS/CHoCH 및 첫 리테스트 대기`;
  const swingStatus = swingDirection === "WAIT"
    ? "일봉·4시간·1시간 ICT 정렬이 부족해 스윙 관망"
    : primarySwingPlan.status === "ENTRY_READY"
      ? `${swingDirection} 스윙 구조 확정 + 1시간 리테스트 완료`
      : primarySwingPlan.status === "NO_CHASE"
        ? `${swingDirection} 스윙 바이어스지만 추격 금지 구간`
        : primarySwingPlan.status === "RISK_TOO_WIDE"
          ? `${swingDirection} 후보지만 4시간 구조 손절이 넓어 관망`
          : `${swingDirection} 스윙 바이어스 · 1시간 구조/리테스트 대기`;
  return {
    market: "coin",
    asset: "BTC/USDT",
    contract,
    price: round(price, 2),
    change24h: round(ticker.change_percentage, 2),
    fundingRate: round(funding, 4),
    volume24h: round(ticker.volume_24h_quote || ticker.volume_24h_usd, 0),
    updatedAt: new Date().toISOString(),
    candleClosedAt: chart.timeframes["5m"].analysisCutoff,
    chart,
    direction,
    status,
    confidence: direction === "WAIT" ? Math.max(longScore, shortScore) : direction === "LONG" ? longScore : shortScore,
    scoreNotice: "방향·셋업 품질 점수이며 승률 확률이 아닙니다.",
    decisionEngine: {
      model: "MODEL_1_SWEEP_REVERSAL",
      defaultMode: "BALANCED",
      lifecycle: ICT_V2_LIFECYCLE,
      executionEnabled: ICT_V2_LIFECYCLE === "ACTIVE",
      pricePolicy: {
        candidatePlan: "ANALYSIS_ONLY_VISIBLE",
        executionPlan: "ACTIVE_ENTRY_READY_ONLY",
        actualOrderData: "NOT_CONNECTED",
        notice: "후보 레벨은 분석·시각화 근거이며, tradePlan과 execution.referencePrices만 실행 자격 충족 시 노출됩니다.",
      },
      reviewStatus: `수정 후 승인된 v2 Architecture · ${ICT_V2_LIFECYCLE} 판단`,
      persistence: {
        status: "SCHEMA_READY_NOT_CONNECTED",
        reason: "운영 DB 자격증명이 없어 현재 요청에서는 상태를 영속화하지 않음",
      },
      shortTerm: {
        selectedDirection: model1ShortSelected.direction,
        selected: model1ShortSelected,
        plans: { long: model1ShortLong, short: model1ShortShort },
        timeframes: {
          "5m": { selectedDirection: model1ShortSelected.direction, selected: model1ShortSelected, plans: { long: model1ShortLong, short: model1ShortShort } },
          "15m": { selectedDirection: model1Short15Selected.direction, selected: model1Short15Selected, plans: { long: model1Short15Long, short: model1Short15Short } },
        },
      },
      swing: {
        selectedDirection: model1SwingSelected.direction,
        selected: model1SwingSelected,
        plans: { long: model1SwingLong, short: model1SwingShort },
        timeframes: {
          "1h": { selectedDirection: model1SwingSelected.direction, selected: model1SwingSelected, plans: { long: model1SwingLong, short: model1SwingShort } },
          "4h": { selectedDirection: model1Swing4hSelected.direction, selected: model1Swing4hSelected, plans: { long: model1Swing4hLong, short: model1Swing4hShort } },
        },
      },
    },
    scores: { long: longScore, short: shortScore },
    timeframes: frames,
    marketStructure: {
      vwap24h: round(vwap, 2),
      support: levels.support,
      resistance: levels.resistance,
      sweep: executionSweep,
      session,
      shortTermBias: shortHtfBias,
      swingBias: swingHtfBias,
      executionRange,
      swingRange,
      structure5,
      structure15,
      structure1h,
      structure4h,
      fvg5: {
        long: ictShort.LONG.fvg,
        short: ictShort.SHORT.fvg,
      },
      fvg15: {
        long: fvg15Long ? { low: round(fvg15Long.low, 2), high: round(fvg15Long.high, 2) } : null,
        short: fvg15Short ? { low: round(fvg15Short.low, 2), high: round(fvg15Short.high, 2) } : null,
      },
      swingSupport: swingLevels.support,
      swingResistance: swingLevels.resistance,
      fvg4h: {
        long: ictSwing.LONG.fvg,
        short: ictSwing.SHORT.fvg,
      },
      orderBlocks: {
        shortTerm: { long: ictShort.LONG.orderBlock, short: ictShort.SHORT.orderBlock },
        swing: { long: ictSwing.LONG.orderBlock, short: ictSwing.SHORT.orderBlock },
      },
      liquidity: { shortTerm: liquidity15, swing: liquidity4h },
      channels: { shortTerm: channel15, swing: channel4h },
      smt: { status: "N/A", reason: "동기화된 비교 자산 데이터가 없어 계산하지 않음" },
      orderBook,
      volume5m: volume,
    },
    plans: { long: longPlan, short: shortPlan },
    primaryPlan: primaryPlan.direction,
    checklist,
    checklistScore: { passed, total: checklist.length },
    executionRule: "진입가는 지정가 후보입니다. 반드시 5분봉 종가 확정과 재테스트를 확인한 뒤 진입하며, 신호 발생 전 시장가 진입은 차단합니다.",
    strategies: {
      shortTerm: {
        label: "단기",
        timeframe: "15분 구조 · 5분 실행",
        holdingPeriod: "수분~1일",
        direction: ["LONG", "SHORT"].includes(model1ShortSelected.decision) ? model1ShortSelected.decision : "WAIT",
        decision: model1ShortSelected.decision,
        status: decisionStatus(model1ShortSelected),
        htfBias: shortHtfBias,
        setupQuality: model1ShortSelected.score,
        scores: { long: longScore, short: shortScore },
        plans: { long: longPlan, short: shortPlan },
        primaryPlan: model1ShortSelected.direction,
        decisionEngine: model1ShortSelected,
        checklist,
        checklistScore: { passed, total: checklist.length },
        executionRule: "구조 손절과 기존 유동성 목표 R:R 1.2 이상을 필수로 두고, HTF·Location·Sweep·CISD·Displacement·구조·FVG는 100점 가산점으로 평가합니다.",
      },
      swing: {
        label: "스윙",
        timeframe: "일봉·4시간 구조 · 1시간 실행",
        holdingPeriod: "2~14일",
        direction: ["LONG", "SHORT"].includes(model1SwingSelected.decision) ? model1SwingSelected.decision : "WAIT",
        decision: model1SwingSelected.decision,
        status: decisionStatus(model1SwingSelected),
        htfBias: swingHtfBias,
        setupQuality: model1SwingSelected.score,
        scores: { long: swingLongScore, short: swingShortScore },
        plans: { long: swingLongPlan, short: swingShortPlan },
        primaryPlan: model1SwingSelected.direction,
        decisionEngine: model1SwingSelected,
        checklist: swingChecklist,
        checklistScore: { passed: swingPassed, total: swingChecklist.length },
        executionRule: "4H Context와 1H 실행에서 구조 손절과 기존 유동성 목표 R:R 1.2 이상을 필수로 두고, 나머지 ICT 근거는 100점 가산점으로 평가합니다.",
      },
    },
  };
}

export {
  buildChartPayload,
  buildTradePlan,
  buildSwingTradePlan,
  completedCandles,
  normalizeCandles,
  swingDirectionScore,
  swingChecklistFor,
  toPublicDecisionSetup,
};

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await loadBitcoinAnalysis(req.query?.symbol);
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json({ source: "Gate.io API v4", ...result });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Bitcoin analysis unavailable" });
  }
}
