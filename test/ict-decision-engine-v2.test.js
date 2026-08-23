import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveParameters } from "../lib/trading/parameters.js";
import { detectSwings } from "../lib/trading/features/swing.js";
import { detectSweepSequence } from "../lib/trading/features/sweep.js";
import { detectCisd } from "../lib/trading/features/cisd.js";
import { detectDisplacement } from "../lib/trading/features/displacement.js";
import { detectMss, detectStructureBreak } from "../lib/trading/features/market-structure.js";
import { detectFvgAfterDisplacement } from "../lib/trading/features/fvg.js";
import { deriveSetupState } from "../lib/trading/setups/state-machine.js";
import { buildLiquidityTradePlan } from "../lib/trading/risk/trade-plan.js";
import { generateDecision, scoreSetup } from "../lib/trading/decision/decision-engine.js";

const parameters = resolveParameters();
const c = (t, o, h, l, close, v = 1) => ({ t, o, h, l, c: close, v });

test("Swing은 rightBars가 닫히기 전에 노출되지 않고 confirmedAt을 별도 기록한다", () => {
  const candles = [
    c(0, 99, 100, 98, 99), c(300, 100, 102, 99, 101), c(600, 101, 110, 100, 105),
    c(900, 105, 108, 101, 103), c(1200, 103, 106, 99, 101), c(1500, 101, 104, 98, 100),
  ];
  const early = detectSwings({ candles: candles.slice(0, 4), timeframe: "5m", leftBars: 2, rightBars: 2, parameters });
  assert.equal(early.some((swing) => swing.pivotIndex === 2), false);
  const confirmed = detectSwings({ candles: candles.slice(0, 5), timeframe: "5m", leftBars: 2, rightBars: 2, parameters });
  const pivot = confirmed.find((swing) => swing.side === "HIGH" && swing.pivotIndex === 2);
  assert.ok(pivot);
  assert.equal(pivot.confirmedIndex, 4);
  assert.equal(pivot.confirmedAt, new Date((1200 + 300) * 1000).toISOString());
});

test("Sweep은 Raid와 지연 Reclaim을 분리하고 침투 ATR을 저장한다", () => {
  const candles = [
    c(0, 103, 104, 102, 103), c(300, 103, 104, 101, 102), c(600, 102, 103, 98, 99),
    c(900, 99, 102, 98.5, 101), c(1200, 101, 103, 100, 102),
  ];
  const level = { id: "ssl", side: "SELL_SIDE", price: 100, liquidityType: "SSL", confirmedAt: new Date(0).toISOString() };
  const sweep = detectSweepSequence({ candles, liquidityLevels: [level], direction: "LONG", timeframe: "5m", parameters });
  assert.equal(sweep.state, "RECLAIMED");
  assert.equal(sweep.reclaimBars, 1);
  assert.ok(sweep.penetrationAtr > 0);
  assert.ok(sweep.confirmedAt);
});

test("레벨 아래 종가 유지와 변위가 확인되면 Sweep이 아니라 BREAKOUT이다", () => {
  const candles = [
    c(0, 103, 104, 102, 103), c(300, 103, 104, 101, 102), c(600, 102, 102.2, 97, 98),
    c(900, 98, 98.5, 92, 93), c(1200, 93, 94, 91, 92),
  ];
  const level = { id: "ssl", side: "SELL_SIDE", price: 100, liquidityType: "SSL", confirmedAt: new Date(0).toISOString() };
  const sweep = detectSweepSequence({ candles, liquidityLevels: [level], direction: "LONG", timeframe: "5m", parameters });
  assert.equal(sweep.state, "BREAKOUT");
});

test("CISD는 MSS와 별개이며 Sweep 연결 여부를 명시한다", () => {
  const candles = [
    c(0, 108, 109, 106, 107), c(300, 107, 108, 104, 105), c(600, 105, 106, 101, 102),
    c(900, 102, 103, 98, 99), c(1200, 99, 103, 98.5, 101), c(1500, 101, 106, 100, 105),
  ];
  const sweep = { id: "sweep-1", state: "RECLAIMED", tradingDirection: "LONG", raidIndex: 3, reclaimIndex: 4 };
  const linked = detectCisd({ candles, direction: "LONG", sweep, timeframe: "5m", parameters });
  assert.ok(linked);
  assert.equal(linked.sweepId, "sweep-1");
  assert.equal(linked.type, "CISD");
  assert.equal(linked.barsAfterSweep, 1);
  assert.equal("brokenSwingId" in linked, false);

  const independent = detectCisd({ candles, direction: "LONG", sweep: null, timeframe: "5m", parameters });
  assert.ok(independent);
  assert.equal(independent.sweepId, null);
  assert.equal(independent.liquidityContext, false);
});

test("Displacement는 구조나 FVG 점수 없이 캔들 고유 특성으로 확정한다", () => {
  const candles = [c(0, 100, 101, 99, 100), c(300, 100, 101, 99, 100), c(600, 100, 110, 99.5, 109)];
  const displacement = detectDisplacement({ candles, direction: "LONG", afterIndex: 2, liquidityContext: true, timeframe: "5m", parameters });
  assert.ok(displacement);
  assert.ok(displacement.rangeAtr >= parameters.displacement.minRangeAtr);
  assert.ok(displacement.bodyRatio >= parameters.displacement.minBodyRatio);
  assert.equal(displacement.context.liquidityContext, true);
});

test("Internal Break와 MSS는 Swing hierarchy 기준으로 분리된다", () => {
  const candles = [c(0, 98, 99, 97, 98), c(300, 98, 100, 97, 99), c(600, 99, 102, 98, 101), c(900, 101, 106, 100, 105)];
  const swings = [
    { id: "micro", side: "HIGH", price: 100, hierarchy: "MICRO", confirmedIndex: 1, confirmedAt: new Date(600 * 1000).toISOString() },
    { id: "internal", side: "HIGH", price: 104, hierarchy: "INTERNAL", confirmedIndex: 2, confirmedAt: new Date(900 * 1000).toISOString() },
  ];
  const internalBreak = detectStructureBreak({ candles, swings, direction: "LONG", afterIndex: 2, minimumHierarchy: "MICRO", timeframe: "5m", parameters });
  const mss = detectMss({ candles, swings, direction: "LONG", afterIndex: 2, timeframe: "5m", parameters });
  assert.equal(internalBreak.brokenSwingHierarchy, "MICRO");
  assert.equal(mss.brokenSwingHierarchy, "INTERNAL");
  assert.equal(mss.type, "MSS");
});

test("FVG는 세 번째 캔들 종가 이후에만 생성된다", () => {
  const displacement = { id: "d1", index: 1 };
  const firstTwo = [c(0, 100, 101, 99, 100), c(300, 100, 108, 100, 107)];
  assert.equal(detectFvgAfterDisplacement({ candles: firstTwo, direction: "LONG", displacement, timeframe: "5m", parameters }), null);
  const withThird = [...firstTwo, c(600, 107, 110, 103, 109)];
  const fvg = detectFvgAfterDisplacement({ candles: withThird, direction: "LONG", displacement, timeframe: "5m", parameters });
  assert.ok(fvg);
  assert.equal(fvg.low, 101);
  assert.equal(fvg.high, 103);
  assert.equal(fvg.confirmedAt, new Date((600 + 300) * 1000).toISOString());
});

test("상태 머신은 ICT 컨플루언스를 가산점으로 기록하고 FVG 전까지 대기한다", () => {
  const state = deriveSetupState({
    htfPassed: true, locationPassed: true, liquidityAvailable: true,
    sweep: { state: "RECLAIMED", levelType: "SSL" }, linkedCisd: { id: "c" },
    displacement: { id: "d" }, internalBreak: null, mss: null, fvg: null,
    retestReady: false, expired: false, mode: "BALANCED",
  });
  assert.equal(state.state, "DISPLACEMENT_CONFIRMED");
  assert.equal(state.nextCondition, "방향성 FVG 또는 OB 타점 대기");
  assert.deepEqual(state.history.map((row) => row.sequence), state.history.map((_, index) => index + 1));
  assert.equal(state.history.some((row, index) => index > 0 && row.to === state.history[index - 1].from), false);
});

test("기존 유동성 TP가 1.2R을 못 만들면 합성 목표를 만들지 않고 NO_TRADE 처리한다", () => {
  const candles = [c(0, 100, 101, 99, 100), c(300, 100, 101, 99, 100), c(600, 100, 101, 99, 100)];
  const fvg = { low: 99.5, high: 100.5, consequentEncroachment: 100 };
  const sweep = { extreme: 98 };
  const levels = [{ id: "near", side: "BUY_SIDE", price: 102, liquidityType: "BSL", confirmedAt: new Date(0).toISOString() }];
  const generatedAt = new Date((600 + 300) * 1000).toISOString();
  const plan = buildLiquidityTradePlan({ candles, direction: "LONG", fvg, sweep, liquidityLevels: levels, timeframe: "5m", generatedAt, parameters });
  assert.equal(plan.rrPassed, false);
  assert.deepEqual(plan.targets, []);
  const context = { htfPassed: true, locationPassed: true, liquidityAvailable: true, sweep: { state: "RECLAIMED" }, linkedCisd: {}, displacement: {}, internalBreak: {}, mss: null, fvg };
  const score = scoreSetup({ ...context, tradePlan: plan }, parameters);
  const decision = generateDecision({ direction: "LONG", mode: "BALANCED", setupState: { state: "ENTRY_READY" }, context, tradePlan: plan, score });
  assert.equal(decision.decision, "NO_TRADE");
  assert.ok(decision.missingConditions.includes("Minimum R:R"));
});

test("HTF·위치·스윕은 가산점이며 구조 손절과 기존 유동성 1.2R이 있으면 후보를 공유한다", () => {
  const context = { htfPassed: false, locationPassed: false, liquidityAvailable: true, sweep: null, cisd: null, linkedCisd: null, displacement: {}, internalBreak: {}, mss: null, fvg: {} };
  const tradePlan = { stopDistance: 100, riskViable: true, liquidityTargetAvailable: true, rrPassed: true, noChase: false, minimumRR: 1.2 };
  const score = scoreSetup({ ...context, tradePlan }, parameters);
  const decision = generateDecision({ direction: "SHORT", mode: "BALANCED", setupState: { state: "ENTRY_READY" }, context, tradePlan, score });
  assert.equal(decision.decision, "SHORT");
  assert.equal(decision.hardFilterPassed, true);
  assert.equal(decision.shareEligible, true);
  assert.ok(decision.score < 100);
});

test("점수 가중치는 100점 만점이다", () => {
  assert.equal(Object.values(parameters.score).reduce((sum, value) => sum + value, 0), 100);
});

test("트레이딩 UI는 Hard Filter 통과 전 주문 실행 가격을 잠그고 분석 후보를 분리한다", () => {
  const html = fs.readFileSync(new URL("../bitcoin.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../bitcoin.js", import.meta.url), "utf8");
  assert.match(html, /현재 셋업 진행 상태/);
  assert.match(script, /실행 가격 잠금 · 차트 점선은 주문 불가 후보/);
  assert.match(script, /차트의 점선 진입·SL·TP는 분석용 candidatePlan/);
  assert.match(script, /visiblePlan = executable \? engine\?\.tradePlan : engine\?\.candidatePlan/);
  assert.match(script, /candidate \? dotted : solid/);
  assert.match(script, /Historical Edge/);
  assert.match(script, /engine\?\.hardFilterPassed/);
});
