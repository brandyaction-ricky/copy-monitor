import { gateGet, json } from "../lib/gate.js";

const n = (value) => Number(value || 0);
const numeric = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const PERFORMANCE_START = Math.floor(Date.parse("2026-07-01T00:00:00+09:00") / 1000);
const PERFORMANCE_START_BALANCE = 10_000;
const PERFORMANCE_TYPES = new Set(["pnl", "fee", "fund"]);
const ACCOUNT_BOOK_LIMIT = 1000;
const RANGE_SECONDS = 14 * 24 * 60 * 60;

const kstStartOfDay = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return Date.parse(`${parts}T00:00:00+09:00`) / 1000;
};

async function loadAccountBook(from, to) {
  const ranges = [];
  for (let cursor = from; cursor <= to; cursor += RANGE_SECONDS) {
    ranges.push([cursor, Math.min(to, cursor + RANGE_SECONDS - 1)]);
  }

  const pages = await Promise.all(ranges.map(async ([rangeStart, rangeEnd]) => {
    const rows = [];
    for (let offset = 0; ; offset += ACCOUNT_BOOK_LIMIT) {
      const query = new URLSearchParams({
        from: String(rangeStart),
        to: String(rangeEnd),
        limit: String(ACCOUNT_BOOK_LIMIT),
        offset: String(offset),
      }).toString();
      const page = await gateGet("/futures/usdt/account_book", query);
      const values = Array.isArray(page) ? page : [];
      rows.push(...values);
      if (values.length < ACCOUNT_BOOK_LIMIT) break;
    }
    return rows;
  }));

  const unique = new Map();
  pages.flat().forEach((row) => {
    const key = row.id == null
      ? [row.time, row.type, row.change, row.balance, row.contract, row.trade_id].join(":")
      : String(row.id);
    unique.set(key, row);
  });
  return [...unique.values()].sort((a, b) => n(a.time) - n(b.time));
}

export function calculatePerformance(book, endAt = Date.now()) {
  const startBalance = PERFORMANCE_START_BALANCE;
  let netRealizedPnl = 0;
  let settlementPnl = 0;
  let fees = 0;
  let funding = 0;
  const dailyHistory = new Map();

  book.forEach((row) => {
    if (!PERFORMANCE_TYPES.has(row.type)) return;
    const change = n(row.change);
    netRealizedPnl += change;
    if (row.type === "pnl") settlementPnl += change;
    if (row.type === "fee") fees += change;
    if (row.type === "fund") funding += change;
    const time = n(row.time) * 1000;
    const kstDay = Math.floor((n(row.time) + 9 * 60 * 60) / (24 * 60 * 60));
    dailyHistory.set(kstDay, { time, value: startBalance + netRealizedPnl });
  });

  const endBalance = startBalance + netRealizedPnl;
  const history = [
    { time: PERFORMANCE_START * 1000, value: startBalance },
    ...dailyHistory.values(),
  ];
  if (history[history.length - 1].time < endAt) history.push({ time: endAt, value: endBalance });
  return {
    startAt: PERFORMANCE_START * 1000,
    startBalance,
    endBalance,
    netRealizedPnl,
    settlementPnl,
    fees,
    funding,
    returnRate: startBalance ? netRealizedPnl / startBalance * 100 : 0,
    basis: "pnl+fee+fund; deposits, withdrawals and unrealized PNL excluded",
    history,
  };
}

export function normalizePosition(position) {
  const size = n(position.size);
  const value = Math.abs(n(
    position.value
    || position.position_value
    || size * n(position.mark_price),
  ));
  const liquidationPrice = n(position.liq_price);
  const markPrice = n(position.mark_price);
  const unrealizedPnl = n(position.unrealised_pnl);
  const declaredLeverage = [position.lever, position.leverage, position.cross_leverage_limit]
    .map(n)
    .find((value) => value > 0) || 0;
  const declaredInitialMargin = [position.initial_margin, position.margin]
    .map((candidate) => Math.abs(n(candidate)))
    .find((candidate) => candidate > 0) || 0;
  const initialMargin = declaredInitialMargin
    || (declaredLeverage > 0 ? value / declaredLeverage : 0);
  const leverage = declaredLeverage
    || (initialMargin > 0 ? value / initialMargin : 0);

  return {
    symbol: position.contract,
    side: size > 0 ? "long" : "short",
    leverage,
    size,
    value,
    initialMargin,
    entryPrice: n(position.entry_price),
    markPrice,
    liquidationPrice,
    unrealizedPnl,
    roe: initialMargin > 0 ? unrealizedPnl / initialMargin * 100 : 0,
    marginRate: n(position.average_maintenance_rate || position.maintenance_rate) * 100,
    liquidationDistance: markPrice && liquidationPrice
      ? Math.abs(markPrice - liquidationPrice) / markPrice * 100
      : 0,
  };
}

export function normalizeAccountMargin(account, positions = []) {
  const marginMode = n(account.margin_mode);
  const crossAvailable = numeric(account.cross_available);
  const available = marginMode === 0 && crossAvailable != null
    ? crossAvailable
    : n(account.available);
  const positionInitialMargin = numeric(account.position_initial_margin);
  const classicInitialMargin = [account.cross_initial_margin, account.isolated_position_margin]
    .map((candidate) => Math.max(0, n(candidate)))
    .reduce((sum, candidate) => sum + candidate, 0);
  const positionMarginSum = positions
    .map((position) => Math.max(0, n(position.initialMargin)))
    .reduce((sum, candidate) => sum + candidate, 0);
  const legacyPositionMargin = Math.max(0, n(account.position_margin));
  const positionMargin = [positionInitialMargin, classicInitialMargin, positionMarginSum, legacyPositionMargin]
    .find((candidate) => candidate != null && candidate > 0) || 0;

  return {
    available,
    positionMargin,
    marginMode,
    availableSource: marginMode === 0 && crossAvailable != null ? "cross_available" : "available",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  try {
    const now = Math.floor(Date.now() / 1000);
    const [account, rawPositions, rawTrades, accountBook] = await Promise.all([
      gateGet("/futures/usdt/accounts"),
      gateGet("/futures/usdt/positions", "holding=true"),
      gateGet("/futures/usdt/my_trades", "limit=100"),
      loadAccountBook(PERFORMANCE_START, now),
    ]);

    const positions = (rawPositions || [])
      .filter((p) => n(p.size) !== 0)
      .map(normalizePosition);

    const trades = (rawTrades || []).map((trade) => {
      const size = n(trade.size);
      return {
        id: String(trade.id),
        time: n(trade.create_time_ms) || n(trade.create_time) * 1000,
        symbol: trade.contract,
        side: size >= 0 ? "buy" : "sell",
        price: n(trade.price),
        size,
        fee: n(trade.fee),
      };
    });

    const start = kstStartOfDay();
    const book = Array.isArray(accountBook) ? accountBook : [];
    const todayRealizedPnl = book
      .filter((row) => n(row.time) >= start && PERFORMANCE_TYPES.has(row.type))
      .reduce((sum, row) => sum + n(row.change), 0);

    const unrealizedPnl = n(account.unrealised_pnl);
    const total = n(account.total);
    const accountMargin = normalizeAccountMargin(account, positions);
    const performance = calculatePerformance(book);
    return json(res, 200, {
      mode: "live",
      updatedAt: new Date().toISOString(),
      account: {
        total,
        available: accountMargin.available,
        positionMargin: accountMargin.positionMargin,
        marginMode: accountMargin.marginMode,
        availableSource: accountMargin.availableSource,
        unrealizedPnl,
        totalPnl: performance.netRealizedPnl,
        todayRealizedPnl,
      },
      performance: {
        startAt: performance.startAt,
        startBalance: performance.startBalance,
        endBalance: performance.endBalance,
        netRealizedPnl: performance.netRealizedPnl,
        settlementPnl: performance.settlementPnl,
        fees: performance.fees,
        funding: performance.funding,
        returnRate: performance.returnRate,
        basis: performance.basis,
      },
      positions,
      trades,
      closeRecords: [],
      history: performance.history,
    });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : "Dashboard request failed" });
  }
}
