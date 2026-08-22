import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSwingTradePlan, swingDirectionScore, swingChecklistFor } from "../api/bitcoin.js";

const frame = (direction, overrides = {}) => ({
  direction,
  ema20: 64000,
  ema50: 62000,
  rsi: 55,
  atr: 900,
  ...overrides,
});

function fixtures(direction = "LONG") {
  const frames = {
    week: frame(direction),
    day: frame(direction, { ema20: 63500 }),
    fourHour: frame(direction, { atr: 850 }),
    oneHour: frame(direction),
    fifteenMinute: frame("WAIT"),
    fiveMinute: frame("WAIT"),
  };
  const candles4h = Array.from({ length: 24 }, (_, index) => ({
    o: 63000 + index * 40,
    h: 63800 + index * 40,
    l: 62500 + index * 40,
    c: 63400 + index * 40,
  }));
  const candles1h = Array.from({ length: 16 }, (_, index) => ({
    o: 64300 + index * 20,
    h: 64500 + index * 20,
    l: 64100 + index * 20,
    c: 64400 + index * 20,
  }));
  return {
    price: 65000,
    frames,
    levels: {
      support: [{ price: 63000, touches: 3 }],
      resistance: [{ price: 68000, touches: 2 }],
    },
    fvg4h: { low: 63800, high: 64200 },
    candles4h,
    candles1h,
    funding: 0.012,
  };
}

test("스윙 점수는 주봉·일봉·4시간 정렬을 우선 반영한다", () => {
  const aligned = fixtures("LONG");
  const opposed = fixtures("SHORT");
  const alignedScore = swingDirectionScore("LONG", aligned.frames, { fvg4h: aligned.fvg4h, funding: 0.01 });
  const opposedScore = swingDirectionScore("LONG", opposed.frames, { fvg4h: null, funding: 0.01 });
  assert.ok(alignedScore >= 90);
  assert.ok(opposedScore <= 10);
});

test("스윙 계획은 별도 보유기간과 4시간봉 무효화 기준을 제공한다", () => {
  const context = fixtures("LONG");
  const plan = buildSwingTradePlan("LONG", context, 84);
  assert.equal(plan.mode, "SWING");
  assert.equal(plan.holdingPeriod, "2~14일");
  assert.equal(plan.triggerLabel, "1시간봉 확정 트리거");
  assert.match(plan.invalidation, /4시간봉/);
  assert.ok(plan.stop < plan.entry);
  assert.equal(plan.targets.length, 3);
  assert.ok(plan.targets[2].price > plan.targets[1].price);
});

test("스윙 체크리스트는 상위 시간대와 추격 여부를 분리 확인한다", () => {
  const context = fixtures("LONG");
  const plan = buildSwingTradePlan("LONG", context, 84);
  const checklist = swingChecklistFor("LONG", context.frames, { funding: context.funding }, plan);
  assert.equal(checklist.length, 7);
  assert.ok(checklist.some((item) => item.label.includes("주봉")));
  assert.ok(checklist.some((item) => item.label.includes("추격")));
});

test("페이지는 트레이딩 명칭과 두 전략을 표시하고 빈 3칸 로더를 제거한다", async () => {
  const html = await readFile(new URL("../bitcoin.html", import.meta.url), "utf8");
  assert.match(html, />트레이딩<\/a>/);
  assert.match(html, /data-strategy="shortTerm"/);
  assert.match(html, /data-strategy="swing"/);
  assert.doesNotMatch(html, /id="bitcoinLoading"/);
});


