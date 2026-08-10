import { json } from "../lib/gate.js";

const assets = [
  { name: "나스닥", symbol: "^IXIC", digits: 2 },
  { name: "코스피", symbol: "^KS11", digits: 2 },
  { name: "비트코인", symbol: "BTC-USD", digits: 0 },
  { name: "환율 (달러/원)", symbol: "KRW=X", digits: 2 },
  { name: "WTI 원유", symbol: "CL=F", digits: 2 },
  { name: "EWY", symbol: "EWY", digits: 2 },
  { name: "SK하이닉스", symbol: "000660.KS", digits: 0 },
];

async function loadQuote(asset) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=5d&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Quote request failed: ${asset.symbol}`);
  const result = (await response.json())?.chart?.result?.[0];
  const meta = result?.meta || {};
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(Number.isFinite);
  const price = Number(meta.regularMarketPrice ?? closes.at(-1));
  const previous = Number(meta.chartPreviousClose ?? closes.at(-2));
  const changePercent = Number.isFinite(price) && previous
    ? (price - previous) / previous * 100
    : 0;
  return { ...asset, price, changePercent };
}

const sentiment = (name, score, source) => ({
  name,
  score: Math.max(0, Math.min(100, Math.round(score))),
  label: score < 25 ? "극단적 공포" : score < 45 ? "공포" : score < 56 ? "중립" : score < 75 ? "탐욕" : "극단적 탐욕",
  source,
});

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const indicators = await Promise.all(assets.map(async (asset) => {
    try { return await loadQuote(asset); }
    catch { return { ...asset, price: null, changePercent: 0 }; }
  }));

  const byName = Object.fromEntries(indicators.map((item) => [item.name, item]));
  const momentumScore = (item) => 50 + Number(item?.changePercent || 0) * 6;

  return json(res, 200, {
    updatedAt: new Date().toISOString(),
    indicators,
    sentiments: [
      sentiment("비트코인", momentumScore(byName["비트코인"]), "5일 가격 모멘텀"),
      sentiment("나스닥", momentumScore(byName["나스닥"]), "5일 가격 모멘텀"),
      sentiment("코스피", momentumScore(byName["코스피"]), "5일 가격 모멘텀"),
    ],
  });
}
