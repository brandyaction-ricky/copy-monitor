import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../bitcoin.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../bitcoin.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../trading-execution.css", import.meta.url), "utf8");
const vendor = readFileSync(new URL("../vendor/lightweight-charts/lightweight-charts.standalone.production.js", import.meta.url), "utf8");
const notice = readFileSync(new URL("../vendor/lightweight-charts/NOTICE", import.meta.url), "utf8");

test("트레이딩 페이지는 로컬 Lightweight Charts와 4개 실행 시간대를 제공한다", () => {
  assert.match(html, /\/vendor\/lightweight-charts\/lightweight-charts\.standalone\.production\.js/);
  assert.deepEqual(
    [...html.matchAll(/data-chart-tf="([^"]+)"/g)].map((match) => match[1]),
    ["5m", "15m", "1h", "4h"],
  );
  assert.match(html, /id="btcTradingChart"/);
  assert.match(html, /실시간 캔들은 관찰용이며 엔진 판단은 확정된 캔들에서만 갱신됩니다/);
});

test("차트는 Gate 공개 WebSocket만 사용하고 실시간 봉과 확정봉 판단을 분리한다", () => {
  assert.match(script, /wss:\/\/fx-ws\.gateio\.ws\/v4\/ws\/usdt/);
  assert.match(script, /channel:\s*"futures\.candlesticks"/);
  assert.match(script, /bitcoinData\?\.chart\?\.timeframes/);
  assert.match(script, /candle\.time <= latestClosed/);
  assert.doesNotMatch(script, /futures\/usdt\/orders|event:\s*"order"/);
});

test("엔진 오버레이는 해당 실행 시간대에서만 후보 점선과 ACTIVE 실선을 분리한다", () => {
  assert.match(script, /engine\?\.executionTimeframe === selectedChartTimeframe/);
  assert.match(script, /currentChartPlanExecutable\(\)/);
  assert.match(script, /visiblePlan = executable \? engine\?\.tradePlan : engine\?\.candidatePlan/);
  assert.match(script, /candidate \? dotted : solid/);
  assert.match(script, /title: `\$\{prefix\} 진입/);
  assert.match(script, /candidate \? " · 주문 불가"/);
  assert.match(script, /ACTIVE 실행 플랜 표시/);
  assert.doesNotMatch(script, /createPriceLine/);
});

test("마커 원본 봉과 오버레이 가용 봉을 분리해 과거 구간에 소급 표시하지 않는다", () => {
  assert.match(script, /function sourceBarTime[\s\S]*if \(candle\.time >= target\) break/);
  assert.match(script, /function availabilityBarTime[\s\S]*if \(candle\.time >= target\) return candle\.time/);
  assert.match(script, /availabilityBarTime\(fvg\.confirmedAt, candles\)/);
  assert.match(script, /price: fvg\.consequentEncroachment, startTime, candles[\s\S]*title: "FVG CE · 근거", axisLabelVisible: false/);
  assert.match(script, /availabilityBarTime\(visiblePlan\.validFrom \|\| engine\.generatedAt, candles\)/);
  assert.match(script, /library\.LineSeries/);
  assert.match(script, /series\.setData\(\[\{ time: startTime, value: numericPrice \}, \{ time: visibleEndTime, value: numericPrice \}\]\)/);
  assert.match(script, /autoscaleInfoProvider: \(\) => null/);
});

test("WebSocket 구독 ACK 이후에만 LIVE로 전환하고 숨김 탭에서는 연결과 폴링을 멈춘다", () => {
  assert.match(script, /if \(document\.hidden\) return;[\s\S]*new WebSocket/);
  assert.match(script, /message\.event === "subscribe"/);
  assert.match(script, /acknowledged = true;[\s\S]*setChartStreamStatus\("live", "LIVE · 연결됨"\)/);
  assert.match(script, /if \(!acknowledged \|\| message\.channel/);
  assert.match(script, /setTimeout\(timeoutToRest, 8_000\)/);
  assert.match(script, /rejectToRest = \(\) => closeToRest\(\{ retry: false \}\)/);
  assert.match(script, /timeoutToRest = \(\) => closeToRest\(\{ retry: true \}\)/);
  assert.match(script, /2 \*\* Math\.min\(tradingChartRuntime\.socketRetryCount, 5\)/);
  assert.match(script, /if \(!document\.hidden\) loadBitcoin\(false\)/);
});

test("차트 시각은 KST로 통일하고 좁은 화면 실제 너비를 사용한다", () => {
  assert.match(script, /timeZone: "Asia\/Seoul"/);
  assert.match(script, /tickMarkFormatter: formatChartTickKst/);
  assert.match(script, /timeFormatter: formatChartTimeKst/);
  assert.match(script, /width: Math\.max\(1, Math\.floor\(container\.clientWidth\)\)/);
  assert.doesNotMatch(script, /Math\.max\(container\.clientWidth, 320\)/);
});

test("반복 OHLC는 live region이 아니며 상태와 동적 lifecycle만 정중하게 알린다", () => {
  assert.doesNotMatch(html, /class="btc-chart-quote" aria-live/);
  assert.match(html, /id="btcChartStream"[^>]*aria-live="polite"/);
  assert.match(script, /target\.dataset\.state === state && target\.dataset\.label === label/);
  assert.match(html, /id="btcEngineLifecycle"/);
  assert.match(script, /btcEngineLifecycle/);
  assert.doesNotMatch(html, /ICT DECISION ENGINE · V2 SHADOW/);
});

test("시간대는 단순 토글 접근성을 사용하고 차트 attribution 링크를 노출한다", () => {
  assert.doesNotMatch(html, /role="tab(list)?"|aria-selected=/);
  assert.match(html, /aria-pressed="true"[^>]*data-chart-tf="5m"/);
  assert.doesNotMatch(html, /id="btcTradingChart"[^>]*role="img"/);
  assert.match(html, /id="btcTradingChart"[^>]*role="region"[^>]*aria-label=/);
  assert.match(html, /https:\/\/www\.tradingview\.com\/lightweight-charts\//);
  assert.match(css, /btc-chart-timeframes button:focus-visible/);
  assert.doesNotMatch(css, /btc-chart-layers button:not\(\.active\) \{ opacity:/);
});

test("Lightweight Charts 버전·표시 의무와 모바일 차트 레이아웃을 고정한다", () => {
  assert.match(vendor.slice(0, 240), /Lightweight Charts™ v5\.2\.1/);
  assert.match(notice, /TradingView Lightweight Charts™/);
  assert.match(script, /attributionLogo:\s*true/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.btc-chart-stage \{ height: 390px; \}/);
});
