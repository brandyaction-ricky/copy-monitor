import test from "node:test";
import assert from "node:assert/strict";
import { calculatePerformance } from "../api/dashboard.js";

test("realized performance excludes deposits, withdrawals and unrealized PNL", () => {
  const book = [
    { id: "1", time: 1782831600, type: "dnw", change: "1000", balance: "11000" },
    { id: "2", time: 1782918000, type: "pnl", change: "200", balance: "11200" },
    { id: "3", time: 1782919000, type: "fee", change: "-10", balance: "11190" },
    { id: "4", time: 1782920000, type: "fund", change: "5", balance: "11195" },
    { id: "5", time: 1783000000, type: "dnw", change: "-500", balance: "10695" },
  ];
  const result = calculatePerformance(book, Date.parse("2026-07-03T00:00:00Z"));
  assert.equal(result.startBalance, 10000);
  assert.equal(result.netRealizedPnl, 195);
  assert.equal(result.endBalance, 10195);
  assert.equal(result.returnRate, 1.95);
});

test("realized performance uses the declared July 1 seed instead of inferring it from the ledger", () => {
  const book = [
    { id: "1", time: 1782831600, type: "dnw", change: "1000", balance: "1038" },
    { id: "2", time: 1782918000, type: "pnl", change: "200", balance: "1238" },
  ];
  const result = calculatePerformance(book, Date.parse("2026-07-03T00:00:00Z"));
  assert.equal(result.startBalance, 10000);
  assert.equal(result.netRealizedPnl, 200);
  assert.equal(result.endBalance, 10200);
  assert.equal(result.returnRate, 2);
});
