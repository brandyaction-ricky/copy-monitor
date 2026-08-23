import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

export function detectDisplacement({ candles, direction, afterIndex = 0, liquidityContext = false, symbol = "BTC_USDT", timeframe, parameters }) {
  const atrValues = atrSeries(candles, parameters.atr.length);
  const lastIndex = Math.min(candles.length - 1, afterIndex + parameters.displacement.confirmationWindowBars);
  for (let index = Math.max(0, afterIndex); index <= lastIndex; index += 1) {
    const candle = candles[index];
    const atr = Math.max(atrValues[index - 1] || atrValues[index] || 0, candle.c * 0.00001);
    const range = Math.max(candle.h - candle.l, 1e-9);
    const body = Math.abs(candle.c - candle.o);
    const rangeAtr = range / atr;
    const bodyRatio = body / range;
    const correctDirection = direction === "LONG" ? candle.c > candle.o : candle.c < candle.o;
    if (!correctDirection || rangeAtr < parameters.displacement.minRangeAtr || bodyRatio < parameters.displacement.minBodyRatio) continue;
    const closeLocation = direction === "LONG" ? (candle.c - candle.l) / range : (candle.h - candle.c) / range;
    const strong = rangeAtr >= parameters.displacement.strongRangeAtr && bodyRatio >= parameters.displacement.strongBodyRatio;
    const rangeScore = Math.min(35, rangeAtr / parameters.displacement.strongRangeAtr * 35);
    const bodyScore = Math.min(25, bodyRatio / parameters.displacement.strongBodyRatio * 25);
    const closeScore = Math.min(20, closeLocation * 20);
    const liquidityScore = liquidityContext ? 20 : 0;
    const intrinsicScore = Math.round(rangeScore + bodyScore + closeScore + liquidityScore);
    return {
      ...baseFeature({ type: "DISPLACEMENT", symbol, timeframe, direction: direction === "LONG" ? "BULLISH" : "BEARISH", detectedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), confirmedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), qualityScore: intrinsicScore, suffix: String(candle.t) }),
      tradingDirection: direction,
      index,
      candleTime: isoFromSeconds(candle.t),
      rangeAtr: roundNumber(rangeAtr, 3),
      bodyRatio: roundNumber(bodyRatio, 3),
      closeLocation: roundNumber(closeLocation, 3),
      intrinsicScore,
      strong,
      context: { liquidityContext },
    };
  }
  return null;
}
