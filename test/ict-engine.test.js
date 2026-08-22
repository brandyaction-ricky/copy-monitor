import test from "node:test";
import assert from "node:assert/strict";
import {
  assessIctConfluence,
  detectFvgZones,
  detectLiquidityPools,
  detectMarketStructure,
  detectOrderBlock,
  rangePosition,
  sessionReferenceLevels,
} from "../api/_ict-engine.js";
import { buildTradePlan } from "../api/bitcoin.js";

const candle = (index, o, h, l, c, v = 100) => ({ t: 1_700_000_000 + index * 300, o, h, l, c, v });

test("확정 피벗을 몸통과 버퍼로 돌파해야 BOS가 발생한다", () => {
  const rows = [
    candle(0, 100, 102, 99, 101),
    candle(1, 101, 104, 100, 103),
    candle(2, 103, 105, 101, 102),
    candle(3, 102, 103, 100, 101),
    candle(4, 101, 102, 99, 100),
    candle(5, 100, 102, 99, 101),
    candle(6, 101, 108, 100, 107),
  ];
  const structure = detectMarketStructure(rows, { eventLookback: 20 });
  assert.equal(structure.latestEvent.direction, "LONG");
  assert.equal(structure.latestEvent.type, "BOS");
  assert.equal(structure.latestEvent.level, 105);
  assert.ok(structure.latestEvent.displacement >= 0.6);
});

test("OB는 실제 구조 돌파 전 마지막 반대 캔들과 연결되고 반복 터치를 추적한다", () => {
  const rows = [
    candle(0, 100, 102, 99, 101), candle(1, 101, 104, 100, 103), candle(2, 103, 105, 101, 102),
    candle(3, 102, 103, 100, 101), candle(4, 101, 102, 99, 100), candle(5, 100, 102, 99, 101),
    candle(6, 101, 108, 100, 107),
  ];
  const structure = detectMarketStructure(rows, { eventLookback: 20 });
  const block = detectOrderBlock(rows, "LONG", structure);
  assert.equal(block.low, 99);
  assert.equal(block.high, 101);
  assert.equal(block.breakType, "BOS");
  assert.equal(block.state, "미터치");
  assert.equal(block.invalidated, false);
});

test("FVG는 변위와 최소 ATR 크기를 통과한 미메움 구간만 반환한다", () => {
  const rows = Array.from({ length: 18 }, (_, index) => candle(index, 100, 102, 98, 101));
  rows.push(candle(18, 100, 101, 99, 100));
  rows.push(candle(19, 100, 108, 100, 107));
  rows.push(candle(20, 106, 110, 103, 109));
  const zones = detectFvgZones(rows, "LONG", 110);
  assert.ok(zones.length >= 1);
  assert.equal(zones[0].state, "미메움");
  assert.ok(zones[0].consequentEncroachment > zones[0].low);
  assert.ok(zones[0].sizeAtr >= 0.1);
});

test("EQH/EQL·프리미엄/디스카운트·세션 레벨을 결정론적으로 계산한다", () => {
  const rows = [
    candle(0, 100, 102, 99, 101), candle(1, 101, 105, 100, 103), candle(2, 103, 110, 102, 105),
    candle(3, 105, 106, 101, 102), candle(4, 102, 104, 98, 100), candle(5, 100, 106, 99, 103),
    candle(6, 103, 110.01, 102, 104), candle(7, 104, 106, 100, 101), candle(8, 101, 103, 98.01, 100),
    candle(9, 100, 105, 99, 104), candle(10, 104, 108, 103, 107),
  ];
  const pools = detectLiquidityPools(rows, 104);
  assert.ok(pools.equalHighs.some((item) => item.touches >= 2));
  const range = rangePosition(rows, 109, { lookback: 11 });
  assert.equal(range.zone, "PREMIUM");

  const day = 1_704_067_200;
  const sessionRows = [
    { t: day, o: 100, h: 102, l: 99, c: 101, v: 1 },
    { t: day + 3600, o: 101, h: 105, l: 100, c: 104, v: 1 },
    { t: day + 9 * 3600, o: 104, h: 106, l: 103, c: 105, v: 1 },
  ];
  const session = sessionReferenceLevels(sessionRows, []);
  assert.equal(session.session, "LONDON");
  assert.equal(session.dailyOpen, 100);
  assert.equal(session.asiaHigh, 105);
  assert.equal(session.asiaLow, 99);
});

test("ICT 실행 자격은 HTF·구조·상위 실행 TF와 최소 컨플루언스를 강제한다", () => {
  const structure = { direction: "LONG", latestEvent: { direction: "LONG" } };
  const result = assessIctConfluence("LONG", {
    htfBias: "LONG",
    structure,
    higherExecution: structure,
    orderBlock: { invalidated: false, touches: 0 },
    fvg: { low: 100, high: 101 },
    sweep: null,
    range: { zone: "DISCOUNT" },
    channel: null,
  });
  assert.equal(result.executionQualified, true);
  assert.ok(result.count >= 4);
  assert.equal(assessIctConfluence("SHORT", { htfBias: "LONG", structure, higherExecution: structure }).executionQualified, false);
});

test("단기 실행 계획은 구조 밖 하드 스탑·최소 1.5R·타깃 순서를 보장한다", () => {
  const candles5 = Array.from({ length: 30 }, (_, index) => candle(index, 64700, 64820, 64620, 64700, 120));
  candles5[21] = candle(21, 64800, 64820, 64650, 64720, 160);
  const context = {
    price: 64700,
    frames: { fiveMinute: { atr: 100, ema20: 64680, ema50: 64600 } },
    levels: { support: [{ price: 64500, touches: 2 }], resistance: [{ price: 65500, touches: 2 }] },
    fvg5: { low: 64660, high: 64740 },
    fvg15: null,
    vwap: 64650,
    candles5,
    volume: { ratio: 1.3 },
    orderBook: { imbalance: 10 },
    session: { previousDayHigh: 65500, previousDayLow: 64000, asiaHigh: 65200, asiaLow: 64500 },
    ict: {
      structure: { latestEvent: { direction: "LONG", type: "BOS", level: 64800, index: 20, displacement: 1 }, latestLow: { price: 64400 } },
      orderBlock: { low: 64500, high: 64700, midpoint: 64600, state: "미터치" },
      fvg: { low: 64660, high: 64740, midpoint: 64700, consequentEncroachment: 64700, index: 19, state: "미메움" },
      range: { zone: "DISCOUNT", equilibrium: 65000 },
      liquidity: { above: { price: 65500 }, below: { price: 64500 }, roundNumbers: [65000] },
      confluence: { score: 76, count: 5, total: 8, reasons: ["HTF 바이어스 정렬", "실행 TF BOS/CHoCH", "유효 OB", "FVG", "디스카운트"], executionQualified: true },
    },
  };
  const plan = buildTradePlan("LONG", context, 82);
  assert.ok(plan.hardStop < plan.zone.low);
  assert.ok(plan.targets[0].rr >= 1.5);
  assert.ok(plan.targets[0].price < plan.targets[1].price);
  assert.ok(plan.targets[1].price < plan.targets[2].price);
  assert.equal(plan.minimumRrMet, true);
  assert.equal(plan.actionable, true);
});
