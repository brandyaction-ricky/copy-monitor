export const ENGINE_VERSION = "ict-decision-engine-v2.0.0";
export const PARAMETER_SET_VERSION = "model-1-balanced-2026-08-23";

export const DEFAULT_PARAMETERS = Object.freeze({
  atr: { length: 14 },
  swing: {
    ltfLeftBars: 2,
    ltfRightBars: 2,
    htfLeftBars: 3,
    htfRightBars: 3,
    microMaxProminenceAtr: 0.5,
    externalMinProminenceAtr: 1,
  },
  liquidity: { equalityToleranceAtr: 0.12, maxAgeBars: 180 },
  sweep: {
    penetrationBufferAtr: 0.04,
    reclaimWindowBars: 3,
    breakoutBufferAtr: 0.15,
    breakoutHoldBars: 2,
  },
  delivery: { lookbackBars: 5, mixedThreshold: 0.2 },
  cisd: { confirmationWindowBars: 5, breakBufferAtr: 0.03 },
  displacement: {
    confirmationWindowBars: 5,
    minRangeAtr: 0.8,
    minBodyRatio: 0.6,
    strongRangeAtr: 1.2,
    strongBodyRatio: 0.65,
  },
  structure: { breakBufferAtr: 0.05 },
  retrace: { expiryBars: 8 },
  risk: { minimumRR: 2, stopBufferAtr: 0.08, maximumStopAtr: 3.2 },
  score: {
    htfContext: 15,
    location: 20,
    liquidity: 15,
    sweep: 10,
    cisd: 10,
    displacement: 10,
    mss: 5,
    entryArray: 5,
    rr: 10,
  },
});

function mergeObject(base, override = {}) {
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [
    key,
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...value, ...(override[key] || {}) }
      : override[key] ?? value,
  ]));
}

export function resolveParameters(override = {}) {
  return mergeObject(DEFAULT_PARAMETERS, override);
}
