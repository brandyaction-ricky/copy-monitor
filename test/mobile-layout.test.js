import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("포지션과 트레이딩 화면은 각자의 기존 브랜드를 유지한다", () => {
  const index = read("index.html");
  const bitcoin = read("bitcoin.html");
  assert.match(index, /<title>GateScope — 포지션 대시보드<\/title>/);
  assert.match(bitcoin, /<title>Tooja — 트레이딩<\/title>/);
  assert.match(index, /href="\/bitcoin\.html">트레이딩<\/a>/);
});

test("모바일 포지션과 계좌 요약은 2열이다", () => {
  const css = read("mobile-polish.css");
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

