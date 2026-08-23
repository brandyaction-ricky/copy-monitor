import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

export function detectFvgAfterDisplacement({ candles, direction, displacement, symbol = "BTC_USDT", timeframe, parameters }) {
  if (!displacement) return null;
  const atrValues = atrSeries(candles, parameters.atr.length);
  const start = Math.max(2, displacement.index + 1);
  const end = Math.min(candles.length - 1, displacement.index + 3);
  for (let index = start; index <= end; index += 1) {
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
    const atr = Math.max(atrValues[index - 1] || 0, third.c * 0.00001);
    const sizeAtr = (high - low) / atr;
    if (sizeAtr < 0.1) continue;
    const after = candles.slice(index + 1);
    const fullMitigationIndex = after.findIndex((candle) => direction === "LONG" ? candle.l <= low : candle.h >= high);
    const touchIndex = after.findIndex((candle) => candle.l <= high && candle.h >= low);
    const mitigationPercent = touchIndex < 0 ? 0 : (() => {
      const candle = after[touchIndex];
      const depth = direction === "LONG" ? high - Math.max(low, candle.l) : Math.min(high, candle.h) - low;
      return Math.max(0, Math.min(100, depth / (high - low) * 100));
    })();
    const retestIndex = touchIndex < 0 ? null : index + 1 + touchIndex;
    const invalidated = fullMitigationIndex >= 0;
    return {
      ...baseFeature({ type: "FVG", symbol, timeframe, direction: direction === "LONG" ? "BULLISH" : "BEARISH", detectedAt: isoFromSeconds(candleCloseTime(third, timeframe)), confirmedAt: isoFromSeconds(candleCloseTime(third, timeframe)), qualityScore: Math.min(100, 45 + sizeAtr * 45), status: invalidated ? "MITIGATED" : "CONFIRMED", suffix: `${direction}:${third.t}` }),
      tradingDirection: direction,
      low: roundNumber(low),
      high: roundNumber(high),
      consequentEncroachment: roundNumber((low + high) / 2),
      sizeAtr: roundNumber(sizeAtr, 3),
      createdIndex: index,
      displacementId: displacement.id,
      mitigationPercent: roundNumber(mitigationPercent, 1),
      retestIndex,
      retestAt: retestIndex == null ? null : isoFromSeconds(candleCloseTime(candles[retestIndex], timeframe)),
      invalidated,
    };
  }
  return null;
}
