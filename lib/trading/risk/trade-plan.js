import { isoFromSeconds, roundNumber } from "../core.js";
import { latestAtr } from "../features/atr.js";

function rrFor(direction, entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!risk) return 0;
  return direction === "LONG" ? (target - entry) / risk : (entry - target) / risk;
}

export function buildLiquidityTradePlan({ candles, direction, fvg, sweep, liquidityLevels, timeframe, generatedAt, parameters }) {
  if (!fvg || fvg.invalidated) return null;
  const entry = fvg.consequentEncroachment;
  const atr = Math.max(latestAtr(candles, parameters.atr.length), entry * 0.00001);
  const stopBuffer = atr * parameters.risk.stopBufferAtr;
  const structuralWindow = candles.slice(Math.max(0, (fvg.createdIndex || candles.length - 1) - 12), (fvg.createdIndex || candles.length - 1) + 1);
  const structuralExtreme = direction === "LONG"
    ? Math.min(...structuralWindow.map((candle) => candle.l))
    : Math.max(...structuralWindow.map((candle) => candle.h));
  const modelBase = Number.isFinite(sweep?.extreme) ? sweep.extreme : structuralExtreme;
  const modelInvalidation = direction === "LONG" ? modelBase - stopBuffer : modelBase + stopBuffer;
  const entryInvalidation = direction === "LONG" ? fvg.low : fvg.high;
  const stop = direction === "LONG" ? Math.min(modelInvalidation, entryInvalidation - stopBuffer) : Math.max(modelInvalidation, entryInvalidation + stopBuffer);
  const stopDistance = Math.abs(entry - stop);
  const riskViable = stopDistance > 0 && stopDistance / atr <= parameters.risk.maximumStopAtr;
  const decisionTime = Date.parse(generatedAt);
  const candidates = liquidityLevels
    .filter((level) => Date.parse(level.confirmedAt || 0) <= decisionTime)
    .filter((level) => direction === "LONG" ? level.side === "BUY_SIDE" && level.price > entry : level.side === "SELL_SIDE" && level.price < entry)
    .map((level) => ({ ...level, rr: rrFor(direction, entry, stop, level.price) }))
    .filter((level) => level.rr > 0)
    .sort((a, b) => a.rr - b.rr);
  const qualifying = candidates.filter((level) => level.rr >= parameters.risk.minimumRR);
  const target = qualifying[0] || null;
  const targets = qualifying.slice(0, 3).map((level, index) => ({
    label: `TP${index + 1}`,
    price: roundNumber(level.price),
    rr: roundNumber(level.rr, 2),
    source: level.liquidityType,
    levelId: level.id,
  }));
  const current = candles.at(-1)?.c || entry;
  const favorableMove = direction === "LONG" ? current - entry : entry - current;
  const currentRewardR = stopDistance > 0 ? favorableMove / stopDistance : 0;
  const noChase = currentRewardR > parameters.risk.noChaseRewardR;
  return {
    direction,
    entry: roundNumber(entry),
    entryZone: { low: fvg.low, high: fvg.high, ce: fvg.consequentEncroachment },
    entryInvalidation: roundNumber(entryInvalidation),
    modelInvalidation: roundNumber(modelInvalidation),
    stop: roundNumber(stop),
    stopDistance: roundNumber(stopDistance),
    stopDistanceAtr: roundNumber(stopDistance / atr, 2),
    riskViable,
    targets,
    liquidityTargetAvailable: Boolean(target),
    minimumRR: parameters.risk.minimumRR,
    rrPassed: Boolean(target),
    currentRewardR: roundNumber(currentRewardR, 2),
    noChase,
    executionPolicy: "CLOSED_SIGNAL_THEN_NEXT_OPEN_OR_CONFIRMED_LIMIT",
    validFrom: generatedAt,
    validUntil: isoFromSeconds((candles.at(-1)?.t || 0) + Math.max(1, parameters.retrace.expiryBars) * (candles.length > 1 ? candles.at(-1).t - candles.at(-2).t : 0)),
    positionSizeFormula: "riskAmount / stopDistance (레버리지는 riskAmount를 늘리지 않음)",
  };
}
