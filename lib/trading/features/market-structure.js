import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

function candidateSwings(swings, direction, maximumIndex, minimumHierarchy) {
  const side = direction === "LONG" ? "HIGH" : "LOW";
  const rank = { MICRO: 0, INTERNAL: 1, EXTERNAL: 2 };
  const minimum = rank[minimumHierarchy] ?? 0;
  return swings.filter((swing) => swing.side === side && swing.confirmedIndex < maximumIndex && rank[swing.hierarchy] >= minimum);
}

export function detectStructureBreak({ candles, swings, direction, afterIndex, minimumHierarchy = "MICRO", symbol = "BTC_USDT", timeframe, parameters, type = "STRUCTURE_BREAK" }) {
  const atrValues = atrSeries(candles, parameters.atr.length);
  for (let index = Math.max(1, afterIndex); index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const known = candidateSwings(swings, direction, index, minimumHierarchy).filter((swing) => Date.parse(swing.confirmedAt) / 1000 <= candle.t);
    const swing = known.at(-1);
    if (!swing) continue;
    const atr = Math.max(atrValues[index - 1] || 0, candle.c * 0.00001);
    const buffer = atr * parameters.structure.breakBufferAtr;
    const crossed = direction === "LONG"
      ? previous.c <= swing.price + buffer && candle.c > swing.price + buffer
      : previous.c >= swing.price - buffer && candle.c < swing.price - buffer;
    if (!crossed) continue;
    const closeBeyondSwingAtr = direction === "LONG" ? (candle.c - swing.price) / atr : (swing.price - candle.c) / atr;
    return {
      ...baseFeature({ type, symbol, timeframe, direction: direction === "LONG" ? "BULLISH" : "BEARISH", detectedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), confirmedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), qualityScore: Math.min(100, 55 + closeBeyondSwingAtr * 80), suffix: `${swing.id}:${candle.t}` }),
      tradingDirection: direction,
      eventType: swing.hierarchy === "EXTERNAL" ? "EXTERNAL_SHIFT" : swing.hierarchy === "INTERNAL" ? "INTERNAL_MSS" : "MICRO_BOS",
      brokenSwingId: swing.id,
      brokenSwingPrice: swing.price,
      brokenSwingHierarchy: swing.hierarchy,
      breakIndex: index,
      breakPrice: roundNumber(candle.c),
      closeBeyondSwingAtr: roundNumber(closeBeyondSwingAtr, 3),
    };
  }
  return null;
}

export function detectMss(args) {
  return detectStructureBreak({ ...args, minimumHierarchy: "INTERNAL", type: "MSS" });
}
