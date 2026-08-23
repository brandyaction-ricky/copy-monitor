import { candleCloseTime, isoFromSeconds, roundNumber } from "./core.js";
import { ENGINE_VERSION, PARAMETER_SET_VERSION, resolveParameters } from "./parameters.js";
import { detectSwings, deriveStructureBias } from "./features/swing.js";
import { buildLiquidityLevels } from "./features/liquidity.js";
import { detectSweepSequence } from "./features/sweep.js";
import { detectCisd } from "./features/cisd.js";
import { detectDisplacement } from "./features/displacement.js";
import { detectMss, detectStructureBreak } from "./features/market-structure.js";
import { detectFvgAfterDisplacement } from "./features/fvg.js";
import { deriveSetupState, pipelineRows } from "./setups/state-machine.js";
import { buildLiquidityTradePlan } from "./risk/trade-plan.js";
import { generateDecision, scoreSetup } from "./decision/decision-engine.js";

function dealingRange(candles, swings) {
  const external = swings.filter((swing) => swing.hierarchy === "EXTERNAL");
  const high = external.filter((swing) => swing.side === "HIGH").at(-1);
  const low = external.filter((swing) => swing.side === "LOW").at(-1);
  if (!high || !low) return null;
  const top = Math.max(high.price, low.price);
  const bottom = Math.min(high.price, low.price);
  const current = candles.at(-1)?.c;
  const position = top === bottom ? 0.5 : (current - bottom) / (top - bottom);
  return {
    high: roundNumber(top),
    low: roundNumber(bottom),
    equilibrium: roundNumber((top + bottom) / 2),
    positionPercent: roundNumber(position * 100, 1),
    zone: position > 0.52 ? "PREMIUM" : position < 0.48 ? "DISCOUNT" : "EQUILIBRIUM",
    highSwingId: high.id,
    lowSwingId: low.id,
  };
}

function directionName(direction) {
  return direction === "LONG" ? "BULLISH" : "BEARISH";
}

function latestDisplacement({ candles, direction, afterIndex, symbol, timeframe, parameters, liquidityContext }) {
  const start = Math.max(0, afterIndex ?? candles.length - 24);
  let latest = null;
  for (let index = start; index < candles.length; index += 1) {
    const found = detectDisplacement({ candles, direction, afterIndex: index, liquidityContext, symbol, timeframe, parameters });
    if (!found) continue;
    if (!latest || found.index > latest.index) latest = found;
    index = Math.max(index, found.index);
  }
  return latest;
}

function latestDisplacementFvgPair({ candles, direction, afterIndex, symbol, timeframe, parameters, liquidityContext }) {
  const start = Math.max(0, afterIndex ?? candles.length - 24);
  let latest = null;
  for (let index = start; index < candles.length; index += 1) {
    const displacement = detectDisplacement({ candles, direction, afterIndex: index, liquidityContext, symbol, timeframe, parameters });
    if (!displacement) continue;
    const fvg = detectFvgAfterDisplacement({ candles, direction, displacement, symbol, timeframe, parameters });
    if (fvg && !fvg.invalidated && (!latest || fvg.createdIndex > latest.fvg.createdIndex)) latest = { displacement, fvg };
    index = Math.max(index, displacement.index);
  }
  return latest;
}

function latestDirectionalFvg({ candles, direction, symbol, timeframe, parameters }) {
  let latest = null;
  const start = Math.max(0, candles.length - 28);
  for (let index = start; index < candles.length; index += 1) {
    const anchor = { id: null, index };
    const fvg = detectFvgAfterDisplacement({ candles, direction, displacement: anchor, symbol, timeframe, parameters });
    if (fvg && !fvg.invalidated && (!latest || fvg.createdIndex > latest.createdIndex)) latest = { ...fvg, displacementId: null };
  }
  return latest;
}

export function evaluateSweepReversal({ executionCandles, contextCandles, direction, symbol = "BTC_USDT", executionTimeframe = "5m", contextTimeframe = "1h", namedLiquidity = [], mode = "BALANCED", parameterOverrides = {} }) {
  const parameters = resolveParameters(parameterOverrides);
  const ltfSwings = detectSwings({ candles: executionCandles, symbol, timeframe: executionTimeframe, leftBars: parameters.swing.ltfLeftBars, rightBars: parameters.swing.ltfRightBars, parameters });
  const htfSwings = detectSwings({ candles: contextCandles, symbol, timeframe: contextTimeframe, leftBars: parameters.swing.htfLeftBars, rightBars: parameters.swing.htfRightBars, parameters });
  const htfBias = deriveStructureBias(htfSwings);
  const range = dealingRange(contextCandles, htfSwings);
  const htfPassed = htfBias === directionName(direction);
  const locationPassed = Boolean(range && (direction === "LONG" ? range.zone === "DISCOUNT" : range.zone === "PREMIUM"));
  const liquidityLevels = buildLiquidityLevels({ candles: executionCandles, swings: ltfSwings, symbol, timeframe: executionTimeframe, namedLevels: namedLiquidity, parameters });
  const relevantSide = direction === "LONG" ? "SELL_SIDE" : "BUY_SIDE";
  const liquidityAvailable = liquidityLevels.some((level) => level.side === relevantSide);
  const sweep = detectSweepSequence({ candles: executionCandles, liquidityLevels, direction, symbol, timeframe: executionTimeframe, parameters });
  const cisd = detectCisd({ candles: executionCandles, direction, sweep, symbol, timeframe: executionTimeframe, parameters });
  const linkedCisd = cisd?.sweepId === sweep?.id ? cisd : null;
  const pairSearchStart = linkedCisd?.confirmationIndex ?? executionCandles.length - 24;
  const displacementFvgPair = latestDisplacementFvgPair({
    candles: executionCandles,
    direction,
    afterIndex: pairSearchStart,
    liquidityContext: Boolean(linkedCisd),
    symbol,
    timeframe: executionTimeframe,
    parameters,
  });
  const displacement = displacementFvgPair?.displacement || latestDisplacement({
    candles: executionCandles,
    direction,
    afterIndex: cisd?.confirmationIndex ?? executionCandles.length - 24,
    liquidityContext: Boolean(linkedCisd),
    symbol,
    timeframe: executionTimeframe,
    parameters,
  });
  const internalBreak = displacement ? detectStructureBreak({ candles: executionCandles, swings: ltfSwings, direction, afterIndex: displacement.index, minimumHierarchy: "MICRO", symbol, timeframe: executionTimeframe, parameters }) : null;
  const mss = displacement ? detectMss({ candles: executionCandles, swings: ltfSwings, direction, afterIndex: displacement.index, symbol, timeframe: executionTimeframe, parameters }) : null;
  const fvg = displacementFvgPair?.fvg
    || latestDirectionalFvg({ candles: executionCandles, direction, symbol, timeframe: executionTimeframe, parameters });
  const latestIndex = executionCandles.length - 1;
  const retestReady = Boolean(fvg?.retestIndex != null && latestIndex - fvg.retestIndex <= 1 && !fvg.invalidated);
  const expired = Boolean(fvg && fvg.retestIndex == null && latestIndex - fvg.createdIndex > parameters.retrace.expiryBars);
  const generatedAt = isoFromSeconds(candleCloseTime(executionCandles.at(-1), executionTimeframe));
  const tradePlan = buildLiquidityTradePlan({ candles: executionCandles, direction, fvg, sweep, liquidityLevels, timeframe: executionTimeframe, generatedAt, parameters });
  const context = { htfPassed, locationPassed, liquidityAvailable, sweep, cisd, linkedCisd, displacement, internalBreak, mss, fvg };
  const state = deriveSetupState({ ...context, retestReady, expired, tradePlan, mode });
  const score = scoreSetup({ ...context, tradePlan }, parameters);
  const decision = generateDecision({ direction, mode, setupState: state, context, tradePlan, score });
  const pipeline = pipelineRows({ ...context, retestReady, mode });
  const features = [sweep, cisd, displacement, internalBreak, mss, fvg].filter(Boolean);
  const currentPrice = executionCandles.at(-1)?.c || 0;
  const publicLiquidityLevels = [...liquidityLevels]
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))
    .slice(0, 16)
    .map(({ id, liquidityType, side, price, touches, hierarchy, confirmedAt, qualityScore }) => ({ id, liquidityType, side, price, touches, hierarchy, confirmedAt, qualityScore }));
  return {
    model: "MODEL_1_SWEEP_REVERSAL",
    engineVersion: ENGINE_VERSION,
    parameterSetVersion: PARAMETER_SET_VERSION,
    symbol,
    executionTimeframe,
    contextTimeframe,
    direction,
    mode,
    generatedAt,
    htf: { bias: htfBias, passed: htfPassed, dealingRange: range },
    location: { passed: locationPassed, zone: range?.zone || "N/A" },
    liquidity: { available: liquidityAvailable, relevantSide, levels: publicLiquidityLevels },
    sweep,
    cisd,
    linkedCisd,
    displacement,
    internalBreak,
    mss,
    fvg,
    retestReady,
    state,
    pipeline,
    ...decision,
    featureRelations: features.slice(1).map((feature, index) => ({ fromFeatureId: features[index]?.id || null, toFeatureId: feature.id, relation: "PRECEDES" })),
    dataPolicy: {
      closedCandlesOnly: true,
      fillPolicy: "확정 신호 이후 다음 캔들 시가 또는 확인 후 지정가",
      featureAvailabilityInvariant: "feature.confirmedAt <= generatedAt",
    },
  };
}

export function chooseModelDecision(longSetup, shortSetup) {
  const rows = [longSetup, shortSetup];
  const executable = rows.find((row) => ["LONG", "SHORT"].includes(row.decision));
  if (executable) return executable;
  const waiting = rows.filter((row) => row.decision === "WAIT").sort((a, b) => b.score - a.score)[0];
  return waiting || rows.sort((a, b) => b.score - a.score)[0];
}
