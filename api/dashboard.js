import { gateGet, json, verifyDashboardAccess } from "../lib/gate.js";

const n = (value) => Number(value || 0);
const kstStartOfDay = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return Date.parse(`${parts}T00:00:00+09:00`) / 1000;
};

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const access = verifyDashboardAccess(req);
  if (!access.ok) return json(res, access.status, { error: access.error });

  try {
    const [account, rawPositions, rawTrades, accountBook] = await Promise.all([
      gateGet("/futures/usdt/accounts"),
      gateGet("/futures/usdt/positions", "holding=true"),
      gateGet("/futures/usdt/my_trades", "limit=100"),
      gateGet("/futures/usdt/account_book", "limit=1000"),
    ]);

    const positions = (rawPositions || [])
      .filter((p) => n(p.size) !== 0)
      .map((p) => {
        const size = n(p.size);
        const value = Math.abs(n(p.value || p.position_value || size * n(p.mark_price)));
        const liquidationPrice = n(p.liq_price);
        const markPrice = n(p.mark_price);
        return {
          symbol: p.contract,
          side: size > 0 ? "long" : "short",
          leverage: n(p.leverage || p.cross_leverage_limit),
          size,
          value,
          entryPrice: n(p.entry_price),
          markPrice,
          liquidationPrice,
          unrealizedPnl: n(p.unrealised_pnl),
          roe: n(p.margin) ? n(p.unrealised_pnl) / Math.abs(n(p.margin)) * 100 : 0,
          marginRate: n(p.maintenance_rate) * 100,
          liquidationDistance: markPrice && liquidationPrice
            ? Math.abs(markPrice - liquidationPrice) / markPrice * 100
            : 0,
        };
      });

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
      .filter((row) => n(row.time) >= start && row.type === "pnl")
      .reduce((sum, row) => sum + n(row.change), 0);

    const history = book
      .filter((row) => n(row.balance) > 0)
      .sort((a, b) => n(a.time) - n(b.time))
      .map((row) => ({ time: n(row.time) * 1000, value: n(row.balance) }));

    const unrealizedPnl = n(account.unrealised_pnl);
    const total = n(account.total);
    return json(res, 200, {
      mode: "live",
      updatedAt: new Date().toISOString(),
      account: {
        total,
        analysisTotal: total + unrealizedPnl,
        available: n(account.available),
        positionMargin: n(account.position_margin),
        unrealizedPnl,
        totalPnl: n(account.pnl),
        todayRealizedPnl,
      },
      positions,
      trades,
      closeRecords: [],
      history,
    });
  } catch (error) {
    return json(res, 502, { error: error instanceof Error ? error.message : "Dashboard request failed" });
  }
}
