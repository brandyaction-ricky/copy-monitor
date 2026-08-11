import test from "node:test";
import assert from "node:assert/strict";
import { calculateAssetAnalysis } from "../api/dashboard.js";

test("asset analysis separates gross profit, loss, costs and symbol ranking", () => {
  const book = [
    { time: Date.parse("2026-07-01T01:00:00+09:00") / 1000, type: "pnl", change: "200", contract: "BTC_USDT" },
    { time: Date.parse("2026-07-01T02:00:00+09:00") / 1000, type: "pnl", change: "-50", contract: "ETH_USDT" },
    { time: Date.parse("2026-07-02T01:00:00+09:00") / 1000, type: "pnl", change: "100", contract: "BTC_USDT" },
    { time: Date.parse("2026-07-02T02:00:00+09:00") / 1000, type: "fee", change: "-12", contract: "BTC_USDT" },
    { time: Date.parse("2026-07-02T03:00:00+09:00") / 1000, type: "fund", change: "3", contract: "BTC_USDT" },
    { time: Date.parse("2026-07-02T04:00:00+09:00") / 1000, type: "dnw", change: "500" },
  ];
  const result = calculateAssetAnalysis(book);
  assert.equal(result.totalProfit, 300);
  assert.equal(result.totalLoss, -50);
  assert.equal(result.netSettlementPnl, 250);
  assert.equal(result.netRealizedPnl, 241);
  assert.equal(result.winRate, 2 / 3 * 100);
  assert.equal(result.averageProfit, 150);
  assert.equal(result.averageLoss, -50);
  assert.equal(result.profitFactor, 6);
  assert.equal(result.fees, -12);
  assert.equal(result.funding, 3);
  assert.equal(result.daily[1].netPnl, 91);
  assert.deepEqual(result.symbolRanking[0], { symbol: "BTC_USDT", realizedPnl: 300, settlements: 2 });
});
