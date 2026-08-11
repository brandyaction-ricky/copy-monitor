import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeTrades,
  normalizeTrade,
  parseTradeRange,
  splitTradeRange,
  tradeIdentity,
} from "../api/dashboard.js";

const NOW = Date.parse("2026-08-11T12:00:00+09:00");

test("trade date range uses full KST calendar days", () => {
  const range = parseTradeRange({ tradeFrom: "2026-08-08", tradeTo: "2026-08-11" }, NOW);
  assert.equal(range.from, Date.parse("2026-08-08T00:00:00+09:00") / 1000);
  assert.equal(range.to, Math.floor(Date.parse("2026-08-11T23:59:59.999+09:00") / 1000));
  assert.equal(range.fromDate, "2026-08-08");
  assert.equal(range.toDate, "2026-08-11");
});

test("trade date range rejects reversed and future ranges", () => {
  assert.throws(() => parseTradeRange({ tradeFrom: "2026-08-11", tradeTo: "2026-08-08" }, NOW), RangeError);
  assert.throws(() => parseTradeRange({ tradeFrom: "2026-08-11", tradeTo: "2026-08-12" }, NOW), RangeError);
});

test("trade date range is capped at 31 calendar days", () => {
  assert.throws(() => parseTradeRange({ tradeFrom: "2026-07-01", tradeTo: "2026-08-11" }, NOW), RangeError);
});

test("long ranges are split into Gate-compatible seven-day requests", () => {
  const range = parseTradeRange({ tradeFrom: "2026-07-20", tradeTo: "2026-08-11" }, NOW);
  const chunks = splitTradeRange(range);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].from, range.from);
  assert.equal(chunks.at(-1).to, range.to);
  chunks.forEach((chunk) => assert.ok(chunk.to - chunk.from < 7 * 24 * 60 * 60));
});

test("timerange trades use Gate trade_id instead of collapsing on missing id", () => {
  const first = {
    trade_id: "991", order_id: "501", contract: "BTC_USDT", create_time: 1786116800.1,
    size: "2", price: "120000", fee: "-0.1",
  };
  const second = {
    trade_id: "992", order_id: "502", contract: "ETH_USDT", create_time: 1786116900.2,
    size: "-3", price: "4300", fee: "-0.02",
  };
  const merged = mergeTrades([[first, second], [first]]);

  assert.equal(merged.length, 2);
  assert.equal(tradeIdentity(first), "trade:991");
  assert.equal(normalizeTrade(first).id, "991");
  assert.equal(normalizeTrade(second).side, "sell");
});

test("legacy timerange trades without an id retain distinct fills", () => {
  const shared = { order_id: "700", contract: "SOL_USDT", size: "5", price: "180", fee: "-0.01" };
  const merged = mergeTrades([[
    { ...shared, create_time: 1786116800.1 },
    { ...shared, create_time: 1786116800.2 },
  ]]);

  assert.equal(merged.length, 2);
  assert.notEqual(tradeIdentity(merged[0]), tradeIdentity(merged[1]));
});
