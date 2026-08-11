import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccountMargin, normalizePosition } from "../api/dashboard.js";

test("position uses Gate's current lever and initial_margin fields", () => {
  const position = normalizePosition({
    contract: "BTC_USDT",
    size: "100",
    value: "5000",
    lever: "5",
    leverage: "0",
    cross_leverage_limit: "10",
    initial_margin: "1000",
    unrealised_pnl: "125",
    mark_price: "64000",
  });

  assert.equal(position.leverage, 5);
  assert.equal(position.initialMargin, 1000);
  assert.equal(position.roe, 12.5);
});

test("cross leverage falls back when legacy leverage is the string zero", () => {
  const position = normalizePosition({
    contract: "ETH_USDT",
    size: "-20",
    value: "3000",
    leverage: "0",
    cross_leverage_limit: "3",
    unrealised_pnl: "-30",
  });

  assert.equal(position.leverage, 3);
  assert.equal(position.initialMargin, 1000);
  assert.equal(position.roe, -3);
});

test("unified account uses available and position_initial_margin", () => {
  const margin = normalizeAccountMargin({
    margin_mode: 3,
    available: "9500.25",
    cross_available: "9100.50",
    position_initial_margin: "2800.75",
    position_margin: "0",
  });

  assert.equal(margin.available, 9500.25);
  assert.equal(margin.positionMargin, 2800.75);
  assert.equal(margin.availableSource, "available");
});

test("new classic cross account uses cross_available and cross initial margin", () => {
  const margin = normalizeAccountMargin({
    margin_mode: 0,
    available: "9500.25",
    cross_available: "8700.50",
    cross_initial_margin: "2500",
    isolated_position_margin: "300",
    position_margin: "0",
  });

  assert.equal(margin.available, 8700.5);
  assert.equal(margin.positionMargin, 2800);
  assert.equal(margin.availableSource, "cross_available");
});
