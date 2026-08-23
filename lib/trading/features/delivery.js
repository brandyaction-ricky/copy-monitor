import { mean, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";

export function detectDelivery(candles, endIndex, parameters) {
  const lookback = parameters.delivery.lookbackBars;
  const start = Math.max(0, endIndex - lookback + 1);
  const rows = candles.slice(start, endIndex + 1);
  if (rows.length < Math.min(3, lookback)) return { direction: "MIXED", score: 0, startIndex: start, endIndex };
  const atr = Math.max(atrSeries(candles.slice(0, endIndex + 1), parameters.atr.length).at(-1) || 0, rows.at(-1).c * 0.00001);
  const candleBias = mean(rows.map((candle) => candle.c > candle.o ? 1 : candle.c < candle.o ? -1 : 0));
  const closeBias = mean(rows.slice(1).map((candle, index) => candle.c > rows[index].c ? 1 : candle.c < rows[index].c ? -1 : 0));
  const netMoveAtr = (rows.at(-1).c - rows[0].o) / atr;
  const score = candleBias * 0.35 + closeBias * 0.35 + Math.max(-1, Math.min(1, netMoveAtr)) * 0.3;
  const direction = score > parameters.delivery.mixedThreshold
    ? "BULLISH"
    : score < -parameters.delivery.mixedThreshold ? "BEARISH" : "MIXED";
  return {
    direction,
    score: roundNumber(score, 3),
    candleBias: roundNumber(candleBias, 3),
    closeBias: roundNumber(closeBias, 3),
    netMoveAtr: roundNumber(netMoveAtr, 3),
    startIndex: start,
    endIndex,
  };
}
