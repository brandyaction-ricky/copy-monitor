import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("주식 추천과 실시간 시그널 메뉴·프런트 기능을 제거한다", () => {
  const index = read("index.html");
  const bitcoin = read("bitcoin.html");
  const dashboard = read("dashboard-v22.js");
  assert.doesNotMatch(`${index}${bitcoin}`, /주식 추천|실시간 시그널|view-stock|view-signals|signals\.js/);
  assert.doesNotMatch(dashboard, /api\/recommendations|loadRecommendations|stockScan|coinFilter/);
});

test("트레이딩은 실행 요약을 우선 노출하고 계산기와 가격 레벨을 제거한다", () => {
  const html = read("bitcoin.html");
  const script = read("bitcoin.js");
  for (const id of ["btcFlowStrategy", "btcFlowDirection", "btcFlowEntry", "btcFlowStop", "btcFlowTarget"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function renderExecutionStrip\(\)/);
  assert.match(script, /function renderMarketData\(\)/);
  assert.doesNotMatch(`${html}${script}`, /리스크 계산기|핵심 가격 레벨|btcRisk|btcLevels|calculateRisk|renderStructure/);
});

