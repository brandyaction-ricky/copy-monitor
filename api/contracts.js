const GATE_TICKERS = "https://api.gateio.ws/api/v4/futures/usdt/tickers";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const response = await fetch(GATE_TICKERS, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Gate.io ${response.status}`);
    const tickers = await response.json();
    const contracts = (Array.isArray(tickers) ? tickers : [])
      .filter((item) => /^[A-Z0-9]{2,20}_USDT$/.test(String(item.contract || "")))
      .map((item) => ({
        contract: item.contract,
        symbol: item.contract.replace(/_USDT$/, ""),
        price: Number(item.mark_price || item.last || 0),
        change24h: Number(item.change_percentage || 0),
        volume24h: Number(item.volume_24h_quote || item.volume_24h_usd || 0),
      }))
      .sort((a, b) => b.volume24h - a.volume24h);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ source: "Gate.io API v4", contracts });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Contract list unavailable" });
  }
}
