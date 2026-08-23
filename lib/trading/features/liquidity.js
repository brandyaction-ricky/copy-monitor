import { baseFeature, isoFromSeconds, mean, roundNumber } from "../core.js";
import { latestAtr } from "./atr.js";

function groupEqualLevels(rows, tolerance, type, side, context) {
  const groups = [];
  for (const row of [...rows].sort((a, b) => a.price - b.price)) {
    const group = groups.find((item) => Math.abs(item.price - row.price) <= tolerance);
    if (group) {
      group.members.push(row);
      group.price = mean(group.members.map((item) => item.price));
    } else groups.push({ price: row.price, members: [row] });
  }
  return groups.filter((group) => group.members.length >= 2).map((group) => {
    const last = group.members.at(-1);
    return {
      ...baseFeature({ type: "LIQUIDITY", symbol: context.symbol, timeframe: context.timeframe, direction: side === "BUY_SIDE" ? "BEARISH" : "BULLISH", detectedAt: last.confirmedAt, confirmedAt: last.confirmedAt, qualityScore: Math.min(100, 45 + group.members.length * 12), suffix: `${type}:${roundNumber(group.price)}` }),
      liquidityType: type,
      side,
      price: roundNumber(group.price),
      touches: group.members.length,
      sourceSwingIds: group.members.map((item) => item.id),
    };
  });
}

export function buildLiquidityLevels({ candles, swings, symbol = "BTC_USDT", timeframe, namedLevels = [], parameters }) {
  const atr = Math.max(latestAtr(candles, parameters.atr.length), candles.at(-1)?.c * 0.00001 || 1);
  const meaningful = swings.filter((swing) => swing.hierarchy !== "MICRO");
  const highs = meaningful.filter((swing) => swing.side === "HIGH");
  const lows = meaningful.filter((swing) => swing.side === "LOW");
  const context = { symbol, timeframe };
  const equalityTolerance = atr * parameters.liquidity.equalityToleranceAtr;
  const structural = meaningful.map((swing) => ({
    ...baseFeature({ type: "LIQUIDITY", symbol, timeframe, direction: swing.side === "HIGH" ? "BEARISH" : "BULLISH", detectedAt: swing.confirmedAt, confirmedAt: swing.confirmedAt, qualityScore: swing.hierarchy === "EXTERNAL" ? 78 : 58, suffix: `${swing.side}:${swing.price}` }),
    liquidityType: swing.side === "HIGH" ? "BSL" : "SSL",
    side: swing.side === "HIGH" ? "BUY_SIDE" : "SELL_SIDE",
    price: swing.price,
    touches: 1,
    sourceSwingIds: [swing.id],
    hierarchy: swing.hierarchy,
  }));
  const equal = [
    ...groupEqualLevels(highs, equalityTolerance, "EQH", "BUY_SIDE", context),
    ...groupEqualLevels(lows, equalityTolerance, "EQL", "SELL_SIDE", context),
  ];
  const named = namedLevels.filter((item) => Number.isFinite(Number(item.price))).map((item) => ({
    ...baseFeature({ type: "LIQUIDITY", symbol, timeframe, direction: item.side === "BUY_SIDE" ? "BEARISH" : "BULLISH", detectedAt: item.confirmedAt || isoFromSeconds(candles[0]?.t), confirmedAt: item.confirmedAt || isoFromSeconds(candles[0]?.t), qualityScore: item.qualityScore || 80, suffix: `${item.label}:${item.price}` }),
    liquidityType: item.label,
    side: item.side,
    price: roundNumber(item.price),
    touches: item.touches || 1,
    sourceSwingIds: [],
  }));
  return [...structural, ...equal, ...named].sort((a, b) => a.price - b.price);
}
