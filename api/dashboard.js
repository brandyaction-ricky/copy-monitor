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
const TRADE_RANGE_DAYS = 31;
const TRADE_CHUNK_SECONDS = 7 * 24 * 60 * 60;
const RANGE_SECONDS = 14 * 24 * 60 * 60;

const kstStartOfDay = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return Date.parse(`${parts}T00:00:00+09:00`) / 1000;
};

export function parseTradeRange(query = {}, now = Date.now()) {
  const fromDate = String(query.tradeFrom || "");
  const toDate = String(query.tradeTo || "");
  if (!fromDate && !toDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new RangeError("체결 조회 날짜 형식이 올바르지 않습니다.");
  }
  const fromMs = Date.parse(`${fromDate}T00:00:00+09:00`);
  const toMs = Date.parse(`${toDate}T23:59:59.999+09:00`);
  const todayEnd = Date.parse(`${new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul" }).format(new Date(now))}T23:59:59.999+09:00`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new RangeError("체결 조회 시작일과 종료일을 확인해 주세요.");
  }
  if (toMs > todayEnd) throw new RangeError("미래 날짜는 조회할 수 없습니다.");
  const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (days > TRADE_RANGE_DAYS) throw new RangeError(`체결 내역은 한 번에 최대 ${TRADE_RANGE_DAYS}일까지 조회할 수 있습니다.`);
  return { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000), fromDate, toDate };
}

export function splitTradeRange(range) {
  if (!range) return [];
  const chunks = [];
  for (let from = range.from; from <= range.to; from += TRADE_CHUNK_SECONDS) {
    chunks.push({ from, to: Math.min(range.to, from + TRADE_CHUNK_SECONDS - 1) });
  }
  return chunks;
}

async function loadTrades(range) {
  if (!range) return gateGet("/futures/usdt/my_trades", "limit=100");
  const pages = await Promise.all(splitTradeRange(range).map(async ({ from, to }) => {
    const rows = [];
    for (let offset = 0; ; offset += ACCOUNT_BOOK_LIMIT) {
      const query = new URLSearchParams({
        from: String(from), to: String(to), limit: String(ACCOUNT_BOOK_LIMIT), offset: String(offset),
      }).toString();
      const page = await gateGet("/futures/usdt/my_trades_timerange", query);
      const values = Array.isArray(page) ? page : [];
      rows.push(...values);
      if (values.length < ACCOUNT_BOOK_LIMIT) break;
    }
    return rows;
  }));
  const unique = new Map();
  pages.flat().forEach((trade) => unique.set(String(trade.id), trade));
  return [...unique.values()].sort((a, b) => {
    const timeOf = (trade) => n(trade.create_time_ms) || n(trade.create_time) * 1000;
    return timeOf(b) - timeOf(a);
  });
}

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

export function calculateAssetAnalysis(book) {
  const settlements = book.filter((row) => row.type === "pnl");
  const profits = settlements.map((row) => n(row.change)).filter((value) => value > 0);
  const losses = settlements.map((row) => n(row.change)).filter((value) => value < 0);
  const totalProfit = profits.reduce((sum, value) => sum + value, 0);
  const totalLoss = losses.reduce((sum, value) => sum + value, 0);
  const settledCount = profits.length + losses.length;
  const daily = new Map();
  const symbols = new Map();

  book.forEach((row) => {
    if (!PERFORMANCE_TYPES.has(row.type)) return;
    const change = n(row.change);
    const date = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul",
    }).format(new Date(n(row.time) * 1000));
    const day = daily.get(date) || { date, netPnl: 0, settlementPnl: 0, fees: 0, funding: 0 };
    day.netPnl += change;
    if (row.type === "pnl") day.settlementPnl += change;
    if (row.type === "fee") day.fees += change;
    if (row.type === "fund") day.funding += change;
    daily.set(date, day);

    if (row.type === "pnl" && row.contract) {
      const symbol = String(row.contract);
      const item = symbols.get(symbol) || { symbol, realizedPnl: 0, settlements: 0 };
      item.realizedPnl += change;
      item.settlements += 1;
      symbols.set(symbol, item);
    }
  });

  return {
    startAt: PERFORMANCE_START * 1000,
    totalProfit,
    totalLoss,
    netSettlementPnl: totalProfit + totalLoss,
    netRealizedPnl: totalProfit + totalLoss
      + book.filter((row) => row.type === "fee" || row.type === "fund").reduce((sum, row) => sum + n(row.change), 0),
    profitCount: profits.length,
    lossCount: losses.length,
    settledCount,
    winRate: settledCount ? profits.length / settledCount * 100 : 0,
    averageProfit: profits.length ? totalProfit / profits.length : 0,
    averageLoss: losses.length ? totalLoss / losses.length : 0,
    profitFactor: totalLoss ? totalProfit / Math.abs(totalLoss) : null,
    fees: book.filter((row) => row.type === "fee").reduce((sum, row) => sum + n(row.change), 0),
    funding: book.filter((row) => row.type === "fund").reduce((sum, row) => sum + n(row.change), 0),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    symbolRanking: [...symbols.values()].sort((a, b) => b.realizedPnl - a.realizedPnl),
    basis: "Gate futures account book: pnl, fee and fund rows since 2026-07-01 KST",
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
    const tradeRange = parseTradeRange(req.query || {});
    const [account, rawPositions, rawTrades, accountBook] = await Promise.all([
      gateGet("/futures/usdt/accounts"),
      gateGet("/futures/usdt/positions", "holding=true"),
      loadTrades(tradeRange),
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
    const assetAnalysis = calculateAssetAnalysis(book);
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
      assetAnalysis,
      positions,
      trades,
      tradeRange: tradeRange ? { from: tradeRange.fromDate, to: tradeRange.toDate } : null,
      closeRecords: [],
      history: performance.history,
    });
  } catch (error) {
    const status = error instanceof RangeError ? 400 : 502;
    return json(res, status, { error: error instanceof Error ? error.message : "Dashboard request failed" });
  }
}
