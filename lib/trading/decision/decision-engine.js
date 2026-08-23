import { clampNumber } from "../core.js";

const LABELS = {
  invalidation: "Structural Invalidation",
  target: "Existing Liquidity Target",
  rr: "Minimum R:R",
};

const BONUS_LABELS = {
  htfContext: "HTF Context",
  location: "Premium/Discount Location",
  liquidity: "Liquidity Pool",
  sweep: "Liquidity Sweep",
  cisd: "CISD",
  displacement: "Displacement",
  internalBreak: "Internal Structure Break",
  mss: "MSS",
  entryArray: "FVG Entry Array",
  rr: "Minimum R:R 1.2",
};

function scoreBand(score) {
  if (score >= 80) return { grade: "A", label: "강한 타점" };
  if (score >= 65) return { grade: "B", label: "유효 타점" };
  if (score >= 50) return { grade: "C", label: "주의 타점" };
  return { grade: "D", label: "낮은 품질" };
}

export function scoreSetup(context, parameters) {
  const weights = parameters.score;
  const checks = {
    htfContext: context.htfPassed,
    location: context.locationPassed,
    liquidity: context.liquidityAvailable,
    sweep: ["CONFIRMED", "RECLAIMED"].includes(context.sweep?.state),
    cisd: Boolean(context.cisd),
    displacement: Boolean(context.displacement),
    internalBreak: Boolean(context.internalBreak),
    mss: Boolean(context.mss),
    entryArray: Boolean(context.fvg && !context.fvg.invalidated),
    rr: Boolean(context.tradePlan?.rrPassed),
  };
  const breakdown = Object.entries(weights).map(([key, weight]) => ({ key, weight, pass: Boolean(checks[key]), earned: checks[key] ? weight : 0 }));
  return { score: clampNumber(breakdown.reduce((sum, item) => sum + item.earned, 0), 0, 100), breakdown };
}

export function generateDecision({ direction, mode, setupState, context, tradePlan, score }) {
  const required = {
    invalidation: Boolean(tradePlan && tradePlan.stopDistance > 0 && tradePlan.riskViable),
    target: Boolean(tradePlan?.liquidityTargetAvailable),
    rr: Boolean(tradePlan?.rrPassed),
  };
  const missingConditions = Object.entries(required).filter(([, pass]) => !pass).map(([key]) => LABELS[key] || key);
  const hardFilterPassed = missingConditions.length === 0;
  const bonusMissing = score.breakdown.filter((item) => !item.pass && item.key !== "rr").map((item) => BONUS_LABELS[item.key] || item.key);
  const invalid = ["INVALIDATED", "EXPIRED", "NO_TRADE"].includes(setupState.state);
  const decision = setupState.state === "ENTRY_READY" && hardFilterPassed
    ? direction
    : invalid || (tradePlan && (!tradePlan.riskViable || !tradePlan.liquidityTargetAvailable)) ? "NO_TRADE" : "WAIT";
  const band = scoreBand(score.score);
  const candidatePlan = hardFilterPassed ? tradePlan : null;
  return {
    decision,
    mode,
    score: score.score,
    scoreLabel: `${band.grade} · ${band.label} · 승률 아님`,
    scoreBand: band,
    scoreBreakdown: score.breakdown,
    hardFilterPassed,
    missingConditions,
    bonusMissing,
    shareEligible: Boolean(candidatePlan),
    tradePlan: hardFilterPassed && setupState.state === "ENTRY_READY" ? tradePlan : null,
    candidatePlan,
    historicalStats: {
      status: "N/A",
      sampleSize: 0,
      confidence: "INSUFFICIENT",
      expectancy: null,
      reason: "Walk-forward 백테스트 미실행",
    },
  };
}
