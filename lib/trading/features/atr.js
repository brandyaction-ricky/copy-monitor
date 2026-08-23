import { mean } from "../core.js";

export function trueRange(candle, previousClose) {
  if (previousClose == null) return candle.h - candle.l;
  return Math.max(candle.h - candle.l, Math.abs(candle.h - previousClose), Math.abs(candle.l - previousClose));
}

export function atrSeries(candles, length = 14) {
  const values = [];
  const ranges = [];
  for (let index = 0; index < candles.length; index += 1) {
    ranges.push(trueRange(candles[index], candles[index - 1]?.c));
    const window = ranges.slice(Math.max(0, ranges.length - length));
    values.push(mean(window));
  }
  return values;
}

export function latestAtr(candles, length = 14) {
  return atrSeries(candles, length).at(-1) || 0;
}
