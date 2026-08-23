import { baseFeature, candleCloseTime, isoFromSeconds, roundNumber } from "../core.js";
import { atrSeries } from "./atr.js";
import { detectDelivery } from "./delivery.js";

function findAnchor(candles, direction, endIndex, lookbackBars) {
  for (let index = endIndex; index >= Math.max(0, endIndex - lookbackBars + 1); index -= 1) {
    const candle = candles[index];
    const isAnchor = direction === "LONG" ? candle.c < candle.o : candle.c > candle.o;
    if (isAnchor) return { candle, index };
  }
  return null;
}

function independentSeed(candles, direction, parameters) {
  const end = candles.length - 2;
  for (let index = end; index >= Math.max(2, candles.length - 20); index -= 1) {
    const delivery = detectDelivery(candles, index, parameters);
    const expected = direction === "LONG" ? "BEARISH" : "BULLISH";
    if (delivery.direction === expected) return { startIndex: index + 1, anchorEndIndex: index, delivery };
  }
  return null;
}

export function detectCisd({ candles, direction, sweep = null, symbol = "BTC_USDT", timeframe, parameters }) {
  const linkedSweep = sweep && ["CONFIRMED", "RECLAIMED"].includes(sweep.state) && sweep.tradingDirection === direction;
  const seed = linkedSweep
    ? {
        startIndex: sweep.reclaimIndex ?? sweep.raidIndex,
        anchorEndIndex: sweep.raidIndex,
        delivery: detectDelivery(candles, Math.max(0, sweep.raidIndex - 1), parameters),
      }
    : independentSeed(candles, direction, parameters);
  if (!seed) return null;
  const expectedDelivery = direction === "LONG" ? "BEARISH" : "BULLISH";
  if (seed.delivery.direction !== expectedDelivery) return null;
  const anchor = findAnchor(candles, direction, seed.anchorEndIndex, parameters.delivery.lookbackBars);
  if (!anchor) return null;
  const atrValues = atrSeries(candles, parameters.atr.length);
  const lastConfirmationIndex = Math.min(candles.length - 1, seed.startIndex + parameters.cisd.confirmationWindowBars - 1);
  for (let index = seed.startIndex; index <= lastConfirmationIndex; index += 1) {
    const candle = candles[index];
    const atr = Math.max(atrValues[index - 1] || atrValues[index] || 0, candle.c * 0.00001);
    const buffer = atr * parameters.cisd.breakBufferAtr;
    const confirmed = direction === "LONG" ? candle.c > anchor.candle.o + buffer : candle.c < anchor.candle.o - buffer;
    if (!confirmed) continue;
    const closeBeyondAnchorAtr = direction === "LONG"
      ? (candle.c - anchor.candle.o) / atr
      : (anchor.candle.o - candle.c) / atr;
    const delayBars = linkedSweep ? index - (sweep.reclaimIndex ?? sweep.raidIndex) : index - seed.startIndex;
    return {
      ...baseFeature({ type: "CISD", symbol, timeframe, direction: direction === "LONG" ? "BULLISH" : "BEARISH", detectedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), confirmedAt: isoFromSeconds(candleCloseTime(candle, timeframe)), qualityScore: Math.max(35, 90 - delayBars * 10 + Math.min(20, closeBeyondAnchorAtr * 10)), suffix: `${anchor.candle.t}:${linkedSweep ? sweep.id : "NO_SWEEP"}` }),
      tradingDirection: direction,
      sweepId: linkedSweep ? sweep.id : null,
      liquidityContext: Boolean(linkedSweep),
      deliveryDirectionBefore: seed.delivery.direction,
      anchorCandleTime: isoFromSeconds(anchor.candle.t),
      anchorIndex: anchor.index,
      anchorOpen: roundNumber(anchor.candle.o),
      confirmationPrice: roundNumber(candle.c),
      confirmationIndex: index,
      barsAfterSweep: linkedSweep ? delayBars : null,
      closeBeyondAnchorAtr: roundNumber(closeBeyondAnchorAtr, 3),
    };
  }
  return null;
}
