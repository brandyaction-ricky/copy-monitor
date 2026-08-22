import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("공통 Bitwhale 테마가 모든 사용자 화면에서 마지막에 로드된다", () => {
  for (const file of ["index.html", "bitcoin.html", "signals.html"]) {
    const html = read(file);
    assert.match(html, /<link rel="stylesheet" href="\/bitwhale-theme\.css" \/>/);
    assert.ok(html.lastIndexOf("/bitwhale-theme.css") > html.lastIndexOf("mobile-polish.css"));
    assert.ok(html.lastIndexOf("/bitwhale-theme.css") > html.lastIndexOf("bitcoin-polish.css"));
    assert.match(html, /<meta name="theme-color" content="#0a0a0a" \/>/);
  }
});

test("테마는 제공된 모노크롬 토큰과 공통 컴포넌트 규칙을 사용한다", () => {
  const css = read("bitwhale-theme.css");
  assert.match(css, /--bg: #0a0a0a/);
  assert.match(css, /--surface-1: #111111/);
  assert.match(css, /--border: #262626/);
  assert.match(css, /--green: #32d583/);
  assert.match(css, /--red: #f04438/);
  assert.match(css, /\.panel,[\s\S]*?background: var\(--surface-1\)/);
  assert.match(css, /\.trade-date-range button,[\s\S]*?background: #f5f5f5/);
});

test("기존 모바일 의사결정 레이아웃을 보존한다", () => {
  const css = read("bitwhale-theme.css");
  assert.match(css, /\.account-summary,[\s\S]*?\.position-grid[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.watch-stock-list[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.signal-layout > aside[\s\S]*?order: 1 !important/);
});
