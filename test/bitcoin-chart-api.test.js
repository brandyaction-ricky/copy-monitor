import test from "node:test";
import assert from "node:assert/strict";

import handler, {
  buildChartPayload,
  completedCandles,
  normalizeCandles,
  toPublicDecisionSetup,
} from "../api/bitcoin.js";

const INTERVALS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 };

function rawCandle(t, offset = 0) {
  const open = 64000 + offset;
  return {
    t: String(t),
    o: String(open),
    h: String(open + 80),
    l: String(open - 60),
    c: String(open + 25),
    v: String(100 + offset / 100),
  };
}

function timeframeRows(intervalSeconds, count, nowSeconds) {
  const latestClosedOpen = Math.floor(nowSeconds / intervalSeconds) * intervalSeconds - intervalSeconds;
  return Array.from({ length: count }, (_, index) => rawCandle(
    latestClosedOpen - (count - index - 1) * intervalSeconds,
    index,
  ));
}

test("normalizeCandles는 Gate OHLCV를 숫자로 바꾸고 시간 오름차순으로 정렬한다", () => {
  const rows = normalizeCandles([rawCandle(900, 2), rawCandle(300, 1), rawCandle(600, 3)]);
  assert.deepEqual(rows.map((row) => row.t), [300, 600, 900]);
  for (const row of rows) {
    for (const key of ["t", "o", "h", "l", "c", "v"]) assert.equal(typeof row[key], "number");
  }
});

test("completedCandles는 분석 시점에 아직 닫히지 않은 봉과 미래 봉을 제외한다", () => {
  const nowSeconds = 1_800;
  const rows = normalizeCandles([
    rawCandle(1_200),
    rawCandle(1_500),
    rawCandle(1_800),
  ]);
  const completed = completedCandles(rows, 300, nowSeconds);
  assert.deepEqual(completed.map((row) => row.t), [1_200, 1_500]);
  assert.ok(completed.every((row) => row.t + 300 <= nowSeconds));
});

test("chart payload는 허용된 4개 시간대의 닫힌 봉을 최대 240개씩 제공한다", () => {
  const nowSeconds = 2_000_000_000;
  const source = Object.fromEntries(Object.entries(INTERVALS).map(([timeframe, intervalSeconds]) => {
    const rows = timeframeRows(intervalSeconds, 260, nowSeconds);
    rows.reverse();
    rows.push(rawCandle(Math.floor(nowSeconds / intervalSeconds) * intervalSeconds));
    rows.push(rawCandle(Math.floor(nowSeconds / intervalSeconds) * intervalSeconds + intervalSeconds));
    return [timeframe, rows];
  }));

  const chart = buildChartPayload(source, nowSeconds);
  assert.deepEqual(chart.allowedTimeframes, ["5m", "15m", "1h", "4h"]);
  assert.deepEqual(Object.keys(chart.timeframes), chart.allowedTimeframes);
  assert.equal(chart.defaultTimeframe, "5m");
  assert.equal(chart.closedCandlesOnly, true);
  assert.equal(chart.analysisCutoff, chart.timeframes["5m"].analysisCutoff);

  for (const [timeframe, intervalSeconds] of Object.entries(INTERVALS)) {
    const frame = chart.timeframes[timeframe];
    assert.equal(frame.timeframe, timeframe);
    assert.equal(frame.intervalSeconds, intervalSeconds);
    assert.equal(frame.count, 240);
    assert.equal(frame.candles.length, 240);
    assert.equal(frame.analysisCutoff, frame.endAt);
    assert.equal(new Date(frame.analysisCutoff).getTime() / 1000, frame.candles.at(-1).t + intervalSeconds);
    assert.ok(frame.candles.every((row) => row.t + intervalSeconds <= nowSeconds));
    assert.deepEqual(
      frame.candles.map((row) => row.t),
      [...frame.candles].map((row) => row.t).sort((a, b) => a - b),
    );
    for (const row of frame.candles) {
      assert.deepEqual(Object.keys(row), ["t", "o", "h", "l", "c", "v"]);
      for (const value of Object.values(row)) assert.ok(Number.isFinite(value));
    }
  }

  assert.ok(Buffer.byteLength(JSON.stringify(chart)) < 125_000, "chart payload should remain compact");
});

test("빈 시간대도 일관된 메타데이터와 null cutoff를 반환한다", () => {
  const chart = buildChartPayload({}, 1_800);
  assert.equal(chart.timeframes["5m"].count, 0);
  assert.equal(chart.timeframes["5m"].analysisCutoff, null);
  assert.equal(chart.analysisCutoff, null);
});

test("SHADOW는 후보 가격을 분석용으로 유지하되 실행 가격과 tradePlan을 잠근다", () => {
  const plan = {
    entry: 65000,
    entryZone: { low: 64950, high: 65050, ce: 65000 },
    stop: 64700,
    targets: [{ label: "TP1", price: 65600, rr: 2 }],
  };
  const result = {
    decision: "LONG",
    hardFilterPassed: true,
    state: { state: "ENTRY_READY" },
    candidatePlan: plan,
    tradePlan: plan,
  };
  const shadow = toPublicDecisionSetup(result, "SHADOW");
  assert.equal(shadow.candidatePlan.entry, 65000);
  assert.equal(shadow.candidatePlan.analysisCandidateOnly, true);
  assert.equal(shadow.candidatePlan.orderExecutable, false);
  assert.equal(shadow.candidatePlan.lifecycle, "SHADOW");
  assert.equal(shadow.tradePlan, null);
  assert.equal(shadow.execution.eligible, false);
  assert.deepEqual(shadow.execution.referencePrices, {
    entry: null,
    entryZone: null,
    stop: null,
    targets: null,
  });
  assert.equal(shadow.overlayPolicy.candidateLevelsVisible, true);
  assert.equal(shadow.overlayPolicy.executionLevelsVisible, false);
});

test("ACTIVE도 ENTRY_READY와 Hard Filter가 모두 충족돼야 실행 참고 가격을 노출한다", () => {
  const plan = {
    entry: 65000,
    entryZone: { low: 64950, high: 65050, ce: 65000 },
    stop: 64700,
    targets: [{ label: "TP1", price: 65600, rr: 2 }],
  };
  const waiting = toPublicDecisionSetup({
    decision: "WAIT",
    hardFilterPassed: false,
    state: { state: "WAITING_RETRACE" },
    candidatePlan: plan,
    tradePlan: plan,
  }, "ACTIVE");
  assert.equal(waiting.tradePlan, null);
  assert.equal(waiting.execution.referencePrices.entry, null);
  assert.equal(waiting.execution.lockReason, "ENTRY_NOT_READY");

  const ready = toPublicDecisionSetup({
    decision: "LONG",
    hardFilterPassed: true,
    state: { state: "ENTRY_READY" },
    candidatePlan: plan,
    tradePlan: plan,
  }, "ACTIVE");
  assert.equal(ready.tradePlan.entry, 65000);
  assert.equal(ready.execution.eligible, true);
  assert.equal(ready.execution.referencePrices.stop, 64700);
  assert.equal(ready.execution.orderStatus, "NO_ACTUAL_ORDER");
});

test("GET /api/bitcoin 응답에 분석 엔진과 정렬 가능한 chart payload가 포함된다", async () => {
  const originalFetch = global.fetch;
  const rowsFor = (intervalSeconds, count) => timeframeRows(intervalSeconds, count, Date.now() / 1000)
    .map((row, index) => ({
      ...row,
      o: String(64000 + index * 2 + Math.sin(index / 4) * 30),
      h: String(64100 + index * 2 + Math.sin(index / 4) * 30),
      l: String(63900 + index * 2 + Math.sin(index / 4) * 30),
      c: String(64020 + index * 2 + Math.sin(index / 4) * 30),
      v: String(100 + index % 20),
    }));
  const intervals = {
    "5m": [300, 500],
    "15m": [900, 400],
    "1h": [3600, 300],
    "4h": [14400, 300],
    "1d": [86400, 260],
    "1w": [604800, 160],
  };
  global.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/tickers")) {
      return new Response(JSON.stringify([{
        contract: "BTC_USDT",
        mark_price: "65000",
        change_percentage: "1.2",
        funding_rate: "0.0001",
        volume_24h_quote: "500000000",
      }]), { status: 200 });
    }
    if (url.pathname.endsWith("/candlesticks")) {
      const [intervalSeconds, count] = intervals[url.searchParams.get("interval")];
      return new Response(JSON.stringify(rowsFor(intervalSeconds, count)), { status: 200 });
    }
    if (url.pathname.endsWith("/order_book")) {
      return new Response(JSON.stringify({
        bids: [["64999", "12"], ["64998", "8"]],
        asks: [["65001", "10"], ["65002", "9"]],
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = {
    statusCode: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  try {
    await handler({ method: "GET" }, res);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(res.statusCode, 200, res.body?.error);
  assert.equal(res.body.source, "Gate.io API v4");
  assert.equal(res.body.chart.timeframes["5m"].count, 240);
  assert.equal(res.body.chart.timeframes["4h"].count, 240);
  assert.equal(res.body.chart.alignment.eventTimestamp, "decisionEngine feature confirmedAt (ISO-8601)");
  assert.equal(res.body.candleClosedAt, res.body.chart.timeframes["5m"].analysisCutoff);
  assert.equal(res.body.decisionEngine.pricePolicy.candidatePlan, "ANALYSIS_ONLY_VISIBLE");
  assert.equal(res.body.decisionEngine.pricePolicy.executionPlan, "ACTIVE_ENTRY_READY_ONLY");
  for (const strategy of [res.body.decisionEngine.shortTerm, res.body.decisionEngine.swing]) {
    for (const setup of Object.values(strategy.plans)) {
      assert.equal(setup.tradePlan, null);
      assert.equal(setup.execution.eligible, false);
      assert.equal(setup.execution.referencePrices.entry, null);
      assert.equal(setup.overlayPolicy.executionLevelsVisible, false);
      if (setup.candidatePlan) {
        assert.equal(setup.candidatePlan.analysisCandidateOnly, true);
        assert.equal(setup.candidatePlan.orderExecutable, false);
        assert.equal(setup.candidatePlan.lifecycle, "SHADOW");
      }
    }
  }
  assert.ok(res.body.decisionEngine.shortTerm.selected.generatedAt <= res.body.chart.timeframes["5m"].analysisCutoff);
  assert.ok(res.body.decisionEngine.swing.selected.generatedAt <= res.body.chart.timeframes["1h"].analysisCutoff);
});
