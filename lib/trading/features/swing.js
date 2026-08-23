import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

function hierarchy(prominenceAtr, parameters) {
  if (prominenceAtr < parameters.microMaxProminenceAtr) return "MICRO";
  if (prominenceAtr < parameters.externalMinProminenceAtr) return "INTERNAL";
  return "EXTERNAL";
}

export function detectSwings({ candles, symbol = "BTC_USDT", timeframe, leftBars = 2, rightBars = 2, parameters }) {
  const atrValues = atrSeries(candles, parameters.atr.length);
  const swings = [];
  for (let index = leftBars; index < candles.length - rightBars; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - leftBars, index);
    const right = candles.slice(index + 1, index + rightBars + 1);
    const confirmedIndex = index + rightBars;
    const confirmedAtSeconds = candleCloseTime(candles[confirmedIndex], timeframe);
    const detectedAtSeconds = candleCloseTime(candle, timeframe);
    const localAtr = Math.max(atrValues[index] || 0, candle.c * 0.00001);
    if (left.every((item) => candle.h > item.h) && right.every((item) => candle.h >= item.h)) {
      const reaction = candle.h - Math.min(...right.map((item) => item.l));
      const prominenceAtr = reaction / localAtr;
      swings.push({
        ...baseFeature({ type: "SWING", symbol, timeframe, direction: "BEARISH", detectedAt: isoFromSeconds(detectedAtSeconds), confirmedAt: isoFromSeconds(confirmedAtSeconds), qualityScore: Math.min(100, prominenceAtr * 55), suffix: `H:${candle.t}` }),
        side: "HIGH",
        price: roundNumber(candle.h),
        pivotTime: isoFromSeconds(candle.t),
        pivotIndex: index,
        confirmedIndex,
        prominenceAtr: roundNumber(prominenceAtr, 3),
        hierarchy: hierarchy(prominenceAtr, parameters.swing),
      });
    }
    if (left.every((item) => candle.l < item.l) && right.every((item) => candle.l <= item.l)) {
      const reaction = Math.max(...right.map((item) => item.h)) - candle.l;
      const prominenceAtr = reaction / localAtr;
      swings.push({
        ...baseFeature({ type: "SWING", symbol, timeframe, direction: "BULLISH", detectedAt: isoFromSeconds(detectedAtSeconds), confirmedAt: isoFromSeconds(confirmedAtSeconds), qualityScore: Math.min(100, prominenceAtr * 55), suffix: `L:${candle.t}` }),
        side: "LOW",
        price: roundNumber(candle.l),
        pivotTime: isoFromSeconds(candle.t),
        pivotIndex: index,
        confirmedIndex,
        prominenceAtr: roundNumber(prominenceAtr, 3),
        hierarchy: hierarchy(prominenceAtr, parameters.swing),
      });
    }
  }
  return swings;
}

export function deriveStructureBias(swings) {
  const meaningful = swings.filter((swing) => swing.hierarchy !== "MICRO");
  const highs = meaningful.filter((swing) => swing.side === "HIGH").slice(-2);
  const lows = meaningful.filter((swing) => swing.side === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return "BULLISH";
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return "BEARISH";
  return "NEUTRAL";
}
