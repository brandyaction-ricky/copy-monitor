const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const roundNumber = (value, digits = 2) => Number(finiteNumber(value).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

function candleAtr(candles, period = 14) {
  const rows = candles.slice(-(period + 1));
  if (rows.length < 2) return 0;
  return mean(rows.slice(1).map((candle, index) => {
    const previousClose = rows[index].c;
    return Math.max(candle.h - candle.l, Math.abs(candle.h - previousClose), Math.abs(candle.l - previousClose));
  }));
}

function pivotPoints(candles, left = 2, right = 2, limit = 180) {
  const offset = Math.max(0, candles.length - limit);
  const rows = candles.slice(offset);
  const highs = [];
  const lows = [];
  for (let index = left; index < rows.length - right; index += 1) {
    const candle = rows[index];
    const before = rows.slice(index - left, index);
    const after = rows.slice(index + 1, index + right + 1);
    if (before.every((item) => candle.h > item.h) && after.every((item) => candle.h >= item.h)) {
      highs.push({ price: candle.h, time: candle.t, index: offset + index });
    }
    if (before.every((item) => candle.l < item.l) && after.every((item) => candle.l <= item.l)) {
      lows.push({ price: candle.l, time: candle.t, index: offset + index });
    }
  }
  return { highs, lows, left, right };
}

function pivotTrend(pivots) {
  const highs = pivots.highs.slice(-2);
  const lows = pivots.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return "WAIT";
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return "LONG";
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return "SHORT";
  return "WAIT";
}

function detectMarketStructure(candles, options = {}) {
  const left = options.left ?? 2;
  const right = options.right ?? 2;
  const pivots = pivotPoints(candles, left, right, options.limit ?? 180);
  const events = [];
  const brokenHighs = new Set();
  const brokenLows = new Set();
  let trend = "WAIT";
  const start = Math.max(1, candles.length - (options.eventLookback ?? 90));
  for (let index = start; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const localAtr = Math.max(candleAtr(candles.slice(0, index + 1)), current.c * 0.0002);
    const breakBuffer = Math.max(current.c * 0.0005, localAtr * 0.1);
    const confirmedHighs = pivots.highs.filter((pivot) => pivot.index + right < index && !brokenHighs.has(pivot.index));
    const confirmedLows = pivots.lows.filter((pivot) => pivot.index + right < index && !brokenLows.has(pivot.index));
    const swingHigh = confirmedHighs.at(-1);
    const swingLow = confirmedLows.at(-1);
    if (swingHigh && previous.c <= swingHigh.price + breakBuffer && current.c > swingHigh.price + breakBuffer) {
      const type = trend === "SHORT" ? "CHOCH" : "BOS";
      events.push({ type, direction: "LONG", level: roundNumber(swingHigh.price), time: current.t, index, displacement: roundNumber(Math.abs(current.c - current.o) / localAtr, 2) });
      trend = "LONG";
      brokenHighs.add(swingHigh.index);
      continue;
    }
    if (swingLow && previous.c >= swingLow.price - breakBuffer && current.c < swingLow.price - breakBuffer) {
      const type = trend === "LONG" ? "CHOCH" : "BOS";
      events.push({ type, direction: "SHORT", level: roundNumber(swingLow.price), time: current.t, index, displacement: roundNumber(Math.abs(current.c - current.o) / localAtr, 2) });
      trend = "SHORT";
      brokenLows.add(swingLow.index);
    }
  }
  const latestEvent = events.at(-1) || null;
  const inferredTrend = latestEvent?.direction || pivotTrend(pivots);
  const latestHigh = pivots.highs.at(-1) || null;
  const latestLow = pivots.lows.at(-1) || null;
  return {
    direction: inferredTrend,
    latestEvent: latestEvent ? { ...latestEvent, time: new Date(latestEvent.time * 1000).toISOString() } : null,
    latestHigh: latestHigh ? { price: roundNumber(latestHigh.price), time: new Date(latestHigh.time * 1000).toISOString(), index: latestHigh.index } : null,
    latestLow: latestLow ? { price: roundNumber(latestLow.price), time: new Date(latestLow.time * 1000).toISOString(), index: latestLow.index } : null,
    eventCount: events.length,
    pivots,
  };
}

function detectOrderBlock(candles, direction, structure) {
  const event = structure?.latestEvent;
  if (!event || event.direction !== direction || event.displacement < 0.6) return null;
  let sourceIndex = -1;
  for (let index = event.index - 1; index >= Math.max(0, event.index - 10); index -= 1) {
    const candle = candles[index];
    const opposite = direction === "LONG" ? candle.c < candle.o : candle.c > candle.o;
    if (opposite) {
      sourceIndex = index;
      break;
    }
  }
  if (sourceIndex < 0) return null;
  const source = candles[sourceIndex];
  const low = direction === "LONG" ? source.l : Math.min(source.o, source.c);
  const high = direction === "LONG" ? Math.max(source.o, source.c) : source.h;
  const afterBreak = candles.slice(event.index + 1);
  const touches = afterBreak.filter((candle) => candle.l <= high && candle.h >= low).length;
  const invalidated = afterBreak.some((candle) => direction === "LONG" ? candle.c < low : candle.c > high);
  const state = invalidated ? "소진" : touches === 0 ? "미터치" : touches === 1 ? "1회 미티게이션" : "반복 터치로 약화";
  return {
    direction,
    low: roundNumber(low),
    high: roundNumber(high),
    midpoint: roundNumber((low + high) / 2),
    time: new Date(source.t * 1000).toISOString(),
    sourceIndex,
    breakType: event.type,
    breakLevel: event.level,
    touches,
    invalidated,
    state,
  };
}

function detectFvgZones(candles, direction, currentPrice, options = {}) {
  const rows = [];
  const start = Math.max(2, candles.length - (options.limit ?? 120));
  for (let index = start; index < candles.length; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];
    let low = null;
    let high = null;
    if (direction === "LONG" && first.h < third.l) {
      low = first.h;
      high = third.l;
    }
    if (direction === "SHORT" && first.l > third.h) {
      low = third.h;
      high = first.l;
    }
    if (low == null || high == null) continue;
    const localAtr = Math.max(candleAtr(candles.slice(0, index + 1)), currentPrice * 0.0002);
    const displacementBody = Math.abs(candles[index - 1].c - candles[index - 1].o);
    if (high - low < localAtr * (options.minimumAtrSize ?? 0.1) || displacementBody < localAtr * (options.minimumDisplacement ?? 0.6)) continue;
    const after = candles.slice(index + 1);
    const fullyFilled = direction === "LONG"
      ? after.some((candle) => candle.l <= low)
      : after.some((candle) => candle.h >= high);
    const partiallyFilled = !fullyFilled && (direction === "LONG"
      ? after.some((candle) => candle.l < high)
      : after.some((candle) => candle.h > low));
    const midpoint = (low + high) / 2;
    rows.push({
      direction,
      low: roundNumber(low),
      high: roundNumber(high),
      midpoint: roundNumber(midpoint),
      time: new Date(third.t * 1000).toISOString(),
      index,
      state: fullyFilled ? "완전 메움" : partiallyFilled ? "부분 메움" : "미메움",
      consequentEncroachment: roundNumber(midpoint),
      sizeAtr: roundNumber((high - low) / localAtr, 2),
      filled: fullyFilled,
      distancePercent: roundNumber(Math.abs(midpoint - currentPrice) / currentPrice * 100, 3),
    });
  }
  return rows.filter((zone) => !zone.filled)
    .sort((a, b) => a.distancePercent - b.distancePercent)
    .slice(0, options.maxResults ?? 2);
}

function compressLiquidity(points, tolerance) {
  const groups = [];
  for (const point of [...points].sort((a, b) => a.price - b.price)) {
    const group = groups.find((item) => Math.abs(item.price - point.price) <= tolerance);
    if (group) {
      group.points.push(point);
      group.price = mean(group.points.map((item) => item.price));
    } else groups.push({ price: point.price, points: [point] });
  }
  return groups.filter((group) => group.points.length >= 2).map((group) => ({
    price: roundNumber(group.price),
    touches: group.points.length,
    firstTime: new Date(group.points[0].time * 1000).toISOString(),
    lastTime: new Date(group.points.at(-1).time * 1000).toISOString(),
  }));
}

function detectLiquidityPools(candles, currentPrice, options = {}) {
  const pivots = pivotPoints(candles, options.left ?? 2, options.right ?? 2, options.limit ?? 180);
  const currentAtr = Math.max(candleAtr(candles), currentPrice * 0.00025);
  const tolerance = Math.max(currentPrice * 0.0002, currentAtr * 0.18);
  const equalHighs = compressLiquidity(pivots.highs, tolerance).map((item) => ({ ...item, type: "EQH" }));
  const equalLows = compressLiquidity(pivots.lows, tolerance).map((item) => ({ ...item, type: "EQL" }));
  const above = equalHighs.filter((item) => item.price > currentPrice).sort((a, b) => a.price - b.price)[0] || null;
  const below = equalLows.filter((item) => item.price < currentPrice).sort((a, b) => b.price - a.price)[0] || null;
  const thousand = Math.round(currentPrice / 1000) * 1000;
  const fiveHundred = Math.round(currentPrice / 500) * 500;
  const roundNumbers = [...new Set([thousand, fiveHundred])].sort((a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice));
  return { above, below, equalHighs, equalLows, roundNumbers };
}

function detectLiquiditySweep(candles, levels = [], options = {}) {
  if (!candles.length || !levels.length) return null;
  const currentAtr = Math.max(candleAtr(candles), candles.at(-1).c * 0.00025);
  const buffer = Math.max(5, currentAtr * 0.05);
  const start = Math.max(0, candles.length - (options.lookback ?? 16));
  const events = [];
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    for (const level of levels.filter((item) => Number.isFinite(item?.price))) {
      if (candle.h > level.price + buffer && candle.c < level.price) {
        const follow = candles.slice(index + 1, index + 4);
        const confirmed = follow.some((item) => item.c < candle.l || Math.abs(item.c - item.o) >= currentAtr * 0.5);
        events.push({ direction: "SHORT", level: roundNumber(level.price), label: level.label || level.type || "상단 유동성", time: new Date(candle.t * 1000).toISOString(), index, confirmed });
      }
      if (candle.l < level.price - buffer && candle.c > level.price) {
        const follow = candles.slice(index + 1, index + 4);
        const confirmed = follow.some((item) => item.c > candle.h || Math.abs(item.c - item.o) >= currentAtr * 0.5);
        events.push({ direction: "LONG", level: roundNumber(level.price), label: level.label || level.type || "하단 유동성", time: new Date(candle.t * 1000).toISOString(), index, confirmed });
      }
    }
  }
  return events.sort((a, b) => a.index - b.index).at(-1) || null;
}

function rangePosition(candles, currentPrice, options = {}) {
  const rows = candles.slice(-(options.lookback ?? 72));
  if (!rows.length) return null;
  const high = Math.max(...rows.map((candle) => candle.h));
  const low = Math.min(...rows.map((candle) => candle.l));
  const equilibrium = (high + low) / 2;
  const position = high === low ? 0.5 : (currentPrice - low) / (high - low);
  return {
    high: roundNumber(high),
    low: roundNumber(low),
    equilibrium: roundNumber(equilibrium),
    positionPercent: roundNumber(position * 100, 1),
    zone: position > 0.52 ? "PREMIUM" : position < 0.48 ? "DISCOUNT" : "EQUILIBRIUM",
  };
}

function regressionLine(points) {
  if (points.length < 2) return null;
  const xMean = mean(points.map((point) => point.index));
  const yMean = mean(points.map((point) => point.price));
  const denominator = points.reduce((sum, point) => sum + (point.index - xMean) ** 2, 0);
  if (!denominator) return null;
  const slope = points.reduce((sum, point) => sum + (point.index - xMean) * (point.price - yMean), 0) / denominator;
  const intercept = yMean - slope * xMean;
  return { slope, intercept };
}

function detectChannel(candles, currentPrice, options = {}) {
  const pivots = pivotPoints(candles, 2, 2, options.limit ?? 120);
  const currentAtr = Math.max(candleAtr(candles), currentPrice * 0.00025);
  const tolerance = currentAtr * 0.3;
  const build = (points, side) => {
    const selected = points.slice(-5);
    const line = regressionLine(selected);
    if (!line) return null;
    const touches = selected.filter((point) => Math.abs(point.price - (line.slope * point.index + line.intercept)) <= tolerance).length;
    const currentValue = line.slope * (candles.length - 1) + line.intercept;
    return { side, touches, valid: touches >= 3, slope: roundNumber(line.slope, 3), currentValue: roundNumber(currentValue) };
  };
  const support = build(pivots.lows, "support");
  const resistance = build(pivots.highs, "resistance");
  const slopesAligned = support && resistance && Math.sign(support.slope) === Math.sign(resistance.slope);
  return {
    support,
    resistance,
    valid: Boolean(slopesAligned && support.valid && resistance.valid),
    direction: slopesAligned ? support.slope > 0 ? "LONG" : support.slope < 0 ? "SHORT" : "WAIT" : "WAIT",
  };
}

function sessionReferenceLevels(candles5, candles1d = []) {
  const latest = candles5.at(-1);
  if (!latest) return null;
  const latestDate = new Date(latest.t * 1000);
  const dayStart = Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), latestDate.getUTCDate()) / 1000;
  const previousDayStart = dayStart - 86400;
  const currentDay = candles5.filter((candle) => candle.t >= dayStart);
  const previousDay = candles5.filter((candle) => candle.t >= previousDayStart && candle.t < dayStart);
  const asia = currentDay.filter((candle) => candle.t < dayStart + 8 * 3600);
  const hour = latestDate.getUTCHours();
  const session = hour < 8 ? "ASIA" : hour < 13 ? "LONDON" : hour < 21 ? "NEW_YORK" : "OFF_HOURS";
  const completedDaily = candles1d.filter((candle) => candle.t < dayStart);
  const previousDaily = completedDaily.at(-1);
  const dayOfWeek = latestDate.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const weekStart = dayStart - daysSinceMonday * 86400;
  const previousWeek = candles1d.filter((candle) => candle.t >= weekStart - 7 * 86400 && candle.t < weekStart);
  const monthStart = Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), 1) / 1000;
  const currentMonth = candles1d.filter((candle) => candle.t >= monthStart);
  return {
    session,
    dailyOpen: currentDay[0] ? roundNumber(currentDay[0].o) : null,
    asiaHigh: asia.length ? roundNumber(Math.max(...asia.map((candle) => candle.h))) : null,
    asiaLow: asia.length ? roundNumber(Math.min(...asia.map((candle) => candle.l))) : null,
    previousDayHigh: previousDay.length ? roundNumber(Math.max(...previousDay.map((candle) => candle.h))) : previousDaily ? roundNumber(previousDaily.h) : null,
    previousDayLow: previousDay.length ? roundNumber(Math.min(...previousDay.map((candle) => candle.l))) : previousDaily ? roundNumber(previousDaily.l) : null,
    previousWeekHigh: previousWeek.length ? roundNumber(Math.max(...previousWeek.map((candle) => candle.h))) : null,
    previousWeekLow: previousWeek.length ? roundNumber(Math.min(...previousWeek.map((candle) => candle.l))) : null,
    monthOpen: currentMonth[0] ? roundNumber(currentMonth[0].o) : null,
  };
}

function assessIctConfluence(direction, context) {
  const checks = [];
  const add = (key, pass, weight, label) => checks.push({ key, pass: Boolean(pass), weight, label });
  add("htf", context.htfBias === direction, 20, "HTF 바이어스 정렬");
  add("structure", context.structure?.latestEvent?.direction === direction, 20, "실행 TF BOS/CHoCH");
  add("higherExecution", context.higherExecution?.latestEvent?.direction === direction || context.higherExecution?.direction === direction, 12, "상위 실행 TF 구조 정렬");
  add("ob", context.orderBlock && !context.orderBlock.invalidated && context.orderBlock.touches <= 1, 14, "유효 OB");
  add("fvg", Boolean(context.fvg), 12, "미메움/부분 메움 FVG");
  add("sweep", context.sweep?.direction === direction && context.sweep?.confirmed, 12, "유동성 스윕 후 반전 확인");
  add("pd", direction === "LONG" ? context.range?.zone === "DISCOUNT" : context.range?.zone === "PREMIUM", 7, "프리미엄/디스카운트");
  add("channel", context.channel?.valid && context.channel.direction === direction, 3, "유효 채널 정렬");
  const score = checks.reduce((sum, check) => sum + (check.pass ? check.weight : 0), 0);
  const passed = checks.filter((check) => check.pass);
  return {
    score: clampNumber(Math.round(score), 0, 100),
    count: passed.length,
    total: checks.length,
    checks,
    reasons: passed.map((check) => check.label),
    executionQualified: Boolean(
      context.htfBias === direction
      && context.structure?.latestEvent?.direction === direction
      && context.higherExecution?.direction !== (direction === "LONG" ? "SHORT" : "LONG")
      && passed.length >= 4
    ),
  };
}

export {
  assessIctConfluence,
  candleAtr,
  detectChannel,
  detectFvgZones,
  detectLiquidityPools,
  detectLiquiditySweep,
  detectMarketStructure,
  detectOrderBlock,
  pivotPoints,
  rangePosition,
  sessionReferenceLevels,
};
