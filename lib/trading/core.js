import { ENGINE_VERSION, PARAMETER_SET_VERSION } from "./parameters.js";

export const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const roundNumber = (value, digits = 2) => Number(finiteNumber(value).toFixed(digits));
export const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
export const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

export function timeframeSeconds(timeframe) {
  const value = String(timeframe || "").toLowerCase();
  const unit = value.at(-1);
  const amount = Number(value.slice(0, -1)) || 1;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  if (unit === "d") return amount * 86400;
  if (unit === "w") return amount * 604800;
  return 0;
}

export function candleCloseTime(candle, timeframe) {
  return finiteNumber(candle?.t) + timeframeSeconds(timeframe);
}

export function isoFromSeconds(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

export function featureId(type, symbol, timeframe, direction, confirmedAt, suffix = "") {
  return [type, symbol, timeframe, direction || "NEUTRAL", confirmedAt || "candidate", suffix]
    .map((value) => String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_"))
    .join(":");
}

export function baseFeature({ type, symbol, timeframe, direction, detectedAt, confirmedAt, qualityScore = 0, status = "CONFIRMED", metadata = {}, suffix = "" }) {
  return {
    id: featureId(type, symbol, timeframe, direction, confirmedAt, suffix),
    symbol,
    timeframe,
    type,
    direction,
    detectedAt,
    confirmedAt,
    qualityScore: clampNumber(Math.round(qualityScore), 0, 100),
    status,
    metadata,
    algorithmVersion: ENGINE_VERSION,
    parameterSetVersion: PARAMETER_SET_VERSION,
  };
}
