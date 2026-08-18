import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("모든 화면의 비트코인 메뉴는 트레이딩으로 표시된다", () => {
  const index = read("index.html");
  const signals = read("signals.html");
  const signalScript = read("signals.js");

  assert.match(index, /href="\/bitcoin\.html">트레이딩<\/a>/);
  assert.match(signals, /href="\/bitcoin\.html">트레이딩<\/a>/);
  assert.match(signalScript, /anchor\.textContent = "트레이딩"/);
  assert.doesNotMatch(`${index}${signals}${signalScript}`, />비트코인 트레이딩</);
});

test("모바일 핵심 레이아웃은 이슈 우선·관심종목 3열·포지션과 요약 2열이다", () => {
  const css = read("mobile-polish.css");

  assert.match(css, /\.signal-layout > aside[\s\S]*?order: 1 !important/);
  assert.match(css, /\.watch-stock-list[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.account-summary[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.position-grid[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
});

test("포지션 성과 기간 배지는 모바일에 노출되고 날짜와 일차를 자동 계산한다", () => {
  const index = read("index.html");
  const css = read("mobile-polish.css");
  const script = read("dashboard-v22.js");

  assert.match(index, /class="period-label performance-day-pill"/);
  assert.match(css, /\.overview-value-panel \.performance-day-pill[\s\S]*?display: inline-flex/);
  assert.match(script, /07\.01 ~ \$\{String\(month\)[\s\S]*?\$\{elapsedDays\}일차/);
});
