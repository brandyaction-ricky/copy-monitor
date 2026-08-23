import { clampNumber } from "../core.js";

const LABELS = {
  htf: "HTF Context",
  location: "Meaningful Location",
  liquidity: "Liquidity Event",
  cisd: "Sweep-linked CISD",
  displacement: "Displacement",
  internalBreak: "Internal Structure Break",
  mss: "MSS",
  invalidation: "Structural Invalidation",
  target: "Existing Liquidity Target",
  rr: "Minimum R:R",
};

export function scoreSetup(context, parameters) {
  const weights = parameters.score;
  const checks = {
    htfContext: context.htfPassed,
    location: context.locationPassed,
    liquidity: context.liquidityAvailable,
    sweep: ["CONFIRMED", "RECLAIMED"].includes(context.sweep?.state),
    cisd: Boolean(context.linkedCisd),
    displacement: Boolean(context.displacement),
    mss: Boolean(context.mss),
    entryArray: Boolean(context.fvg && !context.fvg.invalidated),
    rr: Boolean(context.tradePlan?.rrPassed),
  };
  const breakdown = Object.entries(weights).map(([key, weight]) => ({ key, weight, pass: Boolean(checks[key]), earned: checks[key] ? weight : 0 }));
  return { score: clampNumber(breakdown.reduce((sum, item) => sum + item.earned, 0), 0, 100), breakdown };
}

export function generateDecision({ direction, mode, setupState, context, tradePlan, score }) {
  const required = {
    htf: context.htfPassed,
    location: context.locationPassed,
    liquidity: ["CONFIRMED", "RECLAIMED"].includes(context.sweep?.state),
    cisd: Boolean(context.linkedCisd),
    displacement: Boolean(context.displacement),
    invalidation: Boolean(tradePlan && tradePlan.stopDistance > 0 && tradePlan.riskViable),
    target: Boolean(tradePlan?.liquidityTargetAvailable),
    rr: Boolean(tradePlan?.rrPassed),
  };
  if (mode === "BALANCED") required.internalBreak = Boolean(context.internalBreak);
  if (mode === "CONSERVATIVE") required.mss = Boolean(context.mss);
  const missingConditions = Object.entries(required).filter(([, pass]) => !pass).map(([key]) => LABELS[key] || key);
  const hardFilterPassed = missingConditions.length === 0;
  const invalid = ["INVALIDATED", "EXPIRED", "NO_TRADE"].includes(setupState.state);
  const decision = setupState.state === "ENTRY_READY" && hardFilterPassed
    ? direction
    : invalid || (tradePlan && (!tradePlan.riskViable || !tradePlan.liquidityTargetAvailable)) ? "NO_TRADE" : "WAIT";
  return {
    decision,
    mode,
    score: score.score,
    scoreLabel: "Setup Confluence Score · 승률 아님",
    scoreBreakdown: score.breakdown,
    hardFilterPassed,
    missingConditions,
    tradePlan: hardFilterPassed && setupState.state === "ENTRY_READY" ? tradePlan : null,
    candidatePlan: tradePlan,
    historicalStats: {
      status: "N/A",
      sampleSize: 0,
      confidence: "INSUFFICIENT",
      expectancy: null,
      reason: "Walk-forward 백테스트 미실행",
    },
  };
}
