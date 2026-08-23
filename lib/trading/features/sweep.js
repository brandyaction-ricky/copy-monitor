import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

function isBeyond(candle, level, direction, buffer) {
  return direction === "LONG" ? candle.l < level.price - buffer : candle.h > level.price + buffer;
}

function reclaimed(candle, level, direction) {
  return direction === "LONG" ? candle.c > level.price : candle.c < level.price;
}

function breakoutConfirmed(candles, raidIndex, level, direction, atr, parameters) {
  const opposite = direction === "LONG" ? "SHORT" : "LONG";
  const buffer = atr * parameters.breakoutBufferAtr;
  const rows = candles.slice(raidIndex, raidIndex + parameters.breakoutHoldBars);
  if (rows.length < parameters.breakoutHoldBars) return null;
  const held = rows.every((candle) => opposite === "LONG" ? candle.c > level.price + buffer : candle.c < level.price - buffer);
  if (!held) return null;
  const last = rows.at(-1);
  const range = Math.max(last.h - last.l, 1e-9);
  const bodyRatio = Math.abs(last.c - last.o) / range;
  if (range / atr < 0.8 || bodyRatio < 0.6) return null;
  return raidIndex + rows.length - 1;
}

export function detectSweepSequence({ candles, liquidityLevels, direction, symbol = "BTC_USDT", timeframe, parameters }) {
  const requiredSide = direction === "LONG" ? "SELL_SIDE" : "BUY_SIDE";
  const atrValues = atrSeries(candles, parameters.atr.length);
  const events = [];
  for (const level of liquidityLevels.filter((item) => item.side === requiredSide)) {
    const knownAt = Date.parse(level.confirmedAt || 0) / 1000;
    for (let index = 1; index < candles.length; index += 1) {
      const candle = candles[index];
      const candleKnownAt = candleCloseTime(candle, timeframe);
      if (knownAt && candleKnownAt < knownAt) continue;
      const atr = Math.max(atrValues[index] || 0, candle.c * 0.00001);
      const buffer = atr * parameters.sweep.penetrationBufferAtr;
      if (!isBeyond(candle, level, direction, buffer)) continue;
      const penetrationAtr = direction === "LONG" ? (level.price - candle.l) / atr : (candle.h - level.price) / atr;
      let state = "RAID";
      let reclaimIndex = null;
      for (let offset = 0; offset <= parameters.sweep.reclaimWindowBars; offset += 1) {
        const candidateIndex = index + offset;
        const candidate = candles[candidateIndex];
        if (!candidate) break;
        if (reclaimed(candidate, level, direction)) {
          state = offset === 0 ? "CONFIRMED" : "RECLAIMED";
          reclaimIndex = candidateIndex;
          break;
        }
      }
      const breakoutIndex = breakoutConfirmed(candles, index, level, direction, atr, parameters.sweep);
      if (breakoutIndex != null && reclaimIndex == null) state = "BREAKOUT";
      if (reclaimIndex == null && breakoutIndex == null && candles.length - 1 > index + parameters.sweep.reclaimWindowBars) state = "FAILED";
      const terminalIndex = reclaimIndex ?? breakoutIndex ?? index;
      const confirmedAt = ["CONFIRMED", "RECLAIMED", "BREAKOUT", "FAILED"].includes(state)
        ? isoFromSeconds(candleCloseTime(candles[terminalIndex], timeframe))
        : null;
      events.push({
        ...baseFeature({ type: "SWEEP", symbol, timeframe, direction: direction === "LONG" ? "BULLISH" : "BEARISH", detectedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), confirmedAt, qualityScore: Math.min(100, 35 + penetrationAtr * 100 + (reclaimIndex != null ? 25 : 0)), status: confirmedAt ? "CONFIRMED" : "CANDIDATE", suffix: `${level.id}:${candle.t}` }),
        tradingDirection: direction,
        sweepSide: requiredSide,
        state,
        levelId: level.id,
        levelType: level.liquidityType,
        levelPrice: level.price,
        raidIndex: index,
        raidAt: isoFromSeconds(candleCloseTime(candle, timeframe)),
        reclaimIndex,
        reclaimAt: reclaimIndex == null ? null : isoFromSeconds(candleCloseTime(candles[reclaimIndex], timeframe)),
        reclaimBars: reclaimIndex == null ? null : reclaimIndex - index,
        penetrationAtr: roundNumber(penetrationAtr, 3),
        extreme: roundNumber(direction === "LONG" ? candle.l : candle.h),
      });
      break;
    }
  }
  return events.sort((a, b) => a.raidIndex - b.raidIndex).at(-1) || null;
}
