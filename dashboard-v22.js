const emptyDashboard = {
  mode: "unconfigured",
  account: { total: 0, available: 0, positionMargin: 0, unrealizedPnl: 0, totalPnl: 0, todayRealizedPnl: 0 },
  performance: { startBalance: 0, endBalance: 0, netRealizedPnl: 0, returnRate: 0 },
  assetAnalysis: { daily: [], symbolRanking: [] },
  positions: [],
  trades: [],
  closeRecords: [],
  history: [],
};

let dashboard = emptyDashboard;
let filter = "all";
let visibleTradeCount = 10;
let tradeFilter = "all";
const DAY_MS = 86_400_000;
const PERFORMANCE_START_UTC = Date.UTC(2026, 6, 1);
const kstDateKey = (value = Date.now()) => new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul",
}).format(new Date(value));
const performancePeriodLabel = (value = Date.now()) => {
  const [year, month, day] = kstDateKey(value).split("-").map(Number);
  const elapsedDays = Math.max(0, Math.floor((Date.UTC(year, month - 1, day) - PERFORMANCE_START_UTC) / DAY_MS));
  return `07.01 ~ ${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")} · ${elapsedDays}일차`;
};
const renderPerformancePeriod = () => {
  const label = document.querySelector(".overview-value-panel .period-label");
  if (label) label.textContent = performancePeriodLabel();
};
let tradeRange = { from: kstDateKey(Date.now() - DAY_MS * 3), to: kstDateKey() };
let analysisMonth = "";
let dashboardLoaded = false;
const $ = (id) => document.getElementById(id);
const getEffectiveTotal = (account = dashboard.account) => {
  const reported = Number(account?.total || 0);
  const available = Number(account?.available || 0);
  const positionMargin = Number(account?.positionMargin || 0);
  return reported || available + positionMargin;
};
const usd = (value, signed = false) => {
  const n = Number(value || 0);
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n)}`;
};
const number = (value, digits = 2) => new Intl.NumberFormat("en-US",{maximumFractionDigits:digits}).format(Number(value || 0));
const toast = (message) => {
  $("toast").textContent = message; $("toast").classList.add("show");
  clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
function resolveView() {
  const hash = window.location.hash;
  $("modeBadge").textContent = dashboardLoaded ? "LIVE" : "연결 확인 중";
  if (!dashboardLoaded) loadDashboard();
  if (hash === "#positions") requestAnimationFrame(() => $("positions")?.scrollIntoView({ block: "start" }));
}

function renderPositions() {
  const items = dashboard.positions.filter((p) => filter === "all" || p.side === filter);
  const totalPositionValue = dashboard.positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  $("positionGrid").innerHTML = items.length ? items.map((p) => {
    const positive = p.unrealizedPnl >= 0;
    const asset = String(p.symbol || "").split("_")[0].replace(/[^a-z0-9]/gi,"");
    const iconUrl = `https://icon.gateimg.com/images/coin_icon/64/${asset.toLowerCase()}.png`;
    const allocation = totalPositionValue > 0 ? Math.abs(Number(p.value || 0)) / totalPositionValue * 100 : 0;
    return `<article class="position-card">
      <div class="coin-row"><div><span class="coin"><i>${asset[0] || "?"}</i><img src="${iconUrl}" alt="${asset} 아이콘" loading="lazy" onerror="this.style.display='none'"></span><span><h3>${p.symbol}</h3><small>무기한 선물</small></span></div><span><b class="side ${p.side}">${p.side.toUpperCase()}</b> <small>${number(p.leverage,1)}×</small></span></div>
      <div class="pnl-row"><div><small>미실현 손익</small><strong class="${positive?"positive":"negative"}">${usd(p.unrealizedPnl,true)}</strong></div><b class="${positive?"positive":"negative"}">${p.roe>0?"+":""}${number(p.roe)}%</b></div>
      <dl><div><dt>진입가</dt><dd>${usd(p.entryPrice)}</dd></div><div><dt>현재가</dt><dd>${usd(p.markPrice)}</dd></div><div><dt>포지션 규모</dt><dd>${usd(p.value)}</dd></div><div><dt>청산가</dt><dd>${usd(p.liquidationPrice)}</dd></div></dl>
      <div class="allocation-head"><span>포지션 진입 비중</span><strong>${number(allocation)}%</strong></div>
      <div class="allocation-bar" role="progressbar" aria-label="${p.symbol} 포지션 진입 비중" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${number(allocation)}"><i style="width:${Math.min(100,allocation)}%"></i></div>
    </article>`;
  }).join("") : `<article class="position-card"><p>해당 방향의 활성 포지션이 없습니다.</p></article>`;
}

function renderTrades() {
  const allTrades = (dashboard.trades || []).slice(0,5000);
  const trades = tradeFilter === "all" ? allTrades : allTrades.filter((trade) => trade.side === tradeFilter);
  $("tradeTimeline").innerHTML = trades.length ? trades.slice(0,visibleTradeCount).map((t) => {
    const isBuy = t.side === "buy";
    const symbol = escapeHtml(t.symbol || "미확인");
    const time = new Date(t.time).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false, timeZone:"Asia/Seoul" }).replace(/\.\s/g, ".").replace(/\.$/, "");
    const contracts = number(Math.abs(Number(t.size || 0)), 4);
    const fee = Number(t.fee || 0);
    return `<article class="trade-timeline-item">
      <time>${time}</time>
      <i class="trade-timeline-dot" aria-hidden="true"></i>
      <div class="trade-record">
        <span class="trade-side ${isBuy ? "buy" : "sell"}">${isBuy ? "매수" : "매도"}</span>
        <p><strong>${symbol}</strong> 무기한을 <b>${t.price ? usd(t.price) : "가격 미확인"}</b>에 ${isBuy ? "매수" : "매도"} · <b>${contracts} 계약</b> 체결${fee ? ` <small>수수료 ${usd(fee)}</small>` : ""}</p>
      </div>
    </article>`;
  }).join("") : `<div class="trade-empty">선택한 기간에 해당 방향의 체결 기록이 없습니다.</div>`;
  const button = $("loadMoreTrades");
  const remaining = trades.length - visibleTradeCount;
  button.hidden = remaining <= 0;
  button.textContent = remaining > 0
    ? `더 보기 (${Math.min(10,remaining)}개 · ${Math.min(visibleTradeCount,trades.length)}/${trades.length})`
    : "모두 표시됨";
}

function renderHistory() {
  const rawPoints = dashboard.history || [];
  const performance = dashboard.performance || {};
  const currentTotal = Number(performance.endBalance ?? getEffectiveTotal());
  const points = rawPoints.map((point) => ({ ...point, value: Number(point.value || 0) }));
  if (!points.length) {
    $("chartStart").textContent = "기록 없음";
    $("chartEnd").textContent = usd(currentTotal);
    $("chartChange").textContent = "원장 데이터가 없습니다.";
    $("chartLine").setAttribute("d","");
    $("chartArea").setAttribute("d","");
    $("chartAxis").innerHTML = "";
    return;
  }
  const values = points.map(p=>Number(p.value||0));
  const start = Number(performance.startBalance ?? values[0]);
  const end = Number(performance.endBalance ?? values[values.length-1]);
  const change = Number(performance.netRealizedPnl ?? end-start);
  const rate = Number(performance.returnRate ?? (start ? change/start*100 : 0));
  $("chartStart").textContent = usd(start);
  $("chartEnd").textContent = usd(end);
  $("chartChange").textContent = `${usd(change,true)} · ${rate>=0?"+":""}${number(rate)}%`;
  $("chartChange").className = change>=0 ? "positive" : "negative";
  const min=Math.min(...values), max=Math.max(...values), span=Math.max(max-min,1);
  const coords=values.map((value,index)=>{
    const x=index/(values.length-1)*900;
    const y=190-(value-min)/span*155;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line=`M${coords.join(" L")}`;
  $("chartLine").setAttribute("d",line);
  $("chartArea").setAttribute("d",`${line} L900 220 L0 220 Z`);
  const labelIndexes=[0,.25,.5,.75,1].map(r=>Math.round((points.length-1)*r));
  $("chartAxis").innerHTML=labelIndexes.map(i=>`<span>${new Date(points[i].time).toLocaleDateString("ko-KR",{month:"2-digit",day:"2-digit"})}</span>`).join("");
  $("historyDescription").textContent="7월 1일부터 현재까지 입출금과 미실현손익을 제외하고, 청산손익·수수료·펀딩비를 합산한 순실현 성과입니다.";
}

function renderAssetAnalysis() {
  const analysis = dashboard.assetAnalysis || {};
  const totalProfit = Number(analysis.totalProfit || 0);
  const totalLoss = Number(analysis.totalLoss || 0);
  const gross = totalProfit + Math.abs(totalLoss);
  const profitWidth = gross ? totalProfit / gross * 100 : 50;
  $("analysisTotalProfit").textContent = usd(totalProfit, true);
  $("analysisTotalLoss").textContent = usd(totalLoss, true);
  $("analysisProfitCount").textContent = `이익 정산 ${number(analysis.profitCount, 0)}건`;
  $("analysisLossCount").textContent = `손실 정산 ${number(analysis.lossCount, 0)}건`;
  $("analysisProfitBar").style.width = `${profitWidth}%`;
  $("analysisLossBar").style.width = `${100 - profitWidth}%`;
  const netPnl = Number(analysis.netRealizedPnl || 0);
  $("analysisNetPnl").textContent = usd(netPnl, true);
  $("analysisNetPnl").className = netPnl >= 0 ? "positive" : "negative";
  $("analysisWinRate").textContent = `${number(analysis.winRate, 1)}%`;
  $("analysisAverageProfit").textContent = usd(analysis.averageProfit, true);
  $("analysisAverageProfit").className = "positive";
  $("analysisAverageLoss").textContent = usd(analysis.averageLoss, true);
  $("analysisAverageLoss").className = "negative";
  $("analysisProfitFactor").textContent = analysis.profitFactor == null ? "—" : `${number(analysis.profitFactor, 2)} : 1`;
  const costs = Number(analysis.fees || 0) + Number(analysis.funding || 0);
  $("analysisCosts").textContent = usd(costs, true);
  $("analysisCosts").className = costs >= 0 ? "positive" : "negative";
  const analysisEnd = kstDateKey();
  $("analysisPeriod").textContent = `2026.07.01 — ${analysisEnd.replaceAll("-", ".")}`;

  const daily = analysis.daily || [];
  const months = [...new Set(daily.map((day) => day.date.slice(0, 7)))];
  if (!analysisMonth || !months.includes(analysisMonth)) analysisMonth = months.at(-1) || kstDateKey().slice(0, 7);
  $("analysisMonthTabs").innerHTML = months.map((month) => `<button type="button" data-analysis-month="${month}" class="${month === analysisMonth ? "active" : ""}">${month.replace("-", ".")}</button>`).join("");
  const monthRows = daily.filter((day) => day.date.startsWith(analysisMonth));
  const monthTotal = monthRows.reduce((sum, day) => sum + Number(day.netPnl || 0), 0);
  $("analysisMonthTotal").innerHTML = `<span>${analysisMonth.replace("-", "년 ")}월 순손익</span><strong class="${monthTotal >= 0 ? "positive" : "negative"}">${usd(monthTotal, true)}</strong>`;
  const [year, month] = analysisMonth.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDate = new Map(monthRows.map((day) => [day.date, day]));
  const blanks = Array.from({ length: firstWeekday }, () => `<span class="calendar-day blank"></span>`).join("");
  const cells = Array.from({ length: daysInMonth }, (_, index) => {
    const dayNumber = index + 1;
    const date = `${analysisMonth}-${String(dayNumber).padStart(2, "0")}`;
    const row = byDate.get(date);
    const value = Number(row?.netPnl || 0);
    const future = date > kstDateKey();
    const tone = !row ? "empty" : value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
    return `<article class="calendar-day ${tone}${future ? " future" : ""}" title="${date}${row ? ` · ${usd(value, true)}` : ""}"><span>${dayNumber}</span>${row ? `<strong>${value > 0 ? "+" : ""}${number(value, 2)}</strong>` : ""}</article>`;
  }).join("");
  $("analysisCalendar").innerHTML = blanks + cells;

  const ranking = (analysis.symbolRanking || []).slice(0, 8);
  const maxPnl = Math.max(1, ...ranking.map((item) => Math.abs(Number(item.realizedPnl || 0))));
  $("analysisRanking").innerHTML = ranking.length ? ranking.map((item, index) => {
    const pnl = Number(item.realizedPnl || 0);
    return `<article><div><span><i>${index + 1}</i>${escapeHtml(item.symbol)}</span><strong class="${pnl >= 0 ? "positive" : "negative"}">${usd(pnl, true)}</strong></div><div class="ranking-bar"><i class="${pnl >= 0 ? "positive" : "negative"}" style="width:${Math.max(3, Math.abs(pnl) / maxPnl * 100)}%"></i></div><small>정산 ${number(item.settlements, 0)}건</small></article>`;
  }).join("") : `<div class="trade-empty">7월 1일 이후 종목별 실현손익 기록이 없습니다.</div>`;
}

function render() {
  const a = dashboard.account, positions = dashboard.positions;
  const effectiveTotal = getEffectiveTotal(a);
  a.total = effectiveTotal;
  const performance = dashboard.performance || {};
  $("chartEnd").textContent = usd(performance.endBalance ?? effectiveTotal);
  const totalPnl = Number(performance.netRealizedPnl ?? a.totalPnl ?? 0);
  $("chartTotalPnl").textContent = usd(totalPnl, true);
  $("chartTotalPnl").className = totalPnl >= 0 ? "positive" : "negative";
  $("availableMargin").textContent = usd(a.available);
  $("marginUsed").textContent = `사용 중 ${usd(a.positionMargin)}`;
  const availableMargin = Math.max(0, Number(a.available || 0));
  const usedMargin = Math.max(0, Number(a.positionMargin || 0));
  const marginBase = availableMargin + usedMargin;
  const marginUsedPercent = marginBase > 0 ? Math.min(100, usedMargin / marginBase * 100) : 0;
  $("marginUsedPercent").textContent = `${marginUsedPercent.toFixed(1)}% 사용 중`;
  const marginUsageFill = $("marginUsageFill");
  marginUsageFill.style.width = `${marginUsedPercent}%`;
  marginUsageFill.className = marginUsedPercent >= 75 ? "danger" : marginUsedPercent >= 50 ? "warning" : "";
  marginUsageFill.parentElement.setAttribute("aria-valuenow", marginUsedPercent.toFixed(1));
  const unrealizedPnlTotal = positions.reduce((sum,p)=>sum+Number(p.unrealizedPnl||0),0);
  $("unrealizedPnlTotal").textContent = usd(unrealizedPnlTotal,true);
  $("unrealizedPnlTotal").className = unrealizedPnlTotal >= 0 ? "positive" : "negative";
  const todayRealizedPnl = Number(a.todayRealizedPnl || 0);
  $("todayRealizedPnl").textContent = usd(todayRealizedPnl,true);
  $("todayRealizedPnl").className = todayRealizedPnl >= 0 ? "positive" : "negative";
  $("positionCount").textContent = positions.length;
  $("positionBadge").textContent = positions.length;
  const longs = positions.filter(p=>p.side==="long").length;
  $("longShortCount").textContent = `Long ${longs} · Short ${positions.length-longs}`;
  renderPositions(); renderTrades(); renderHistory(); renderAssetAnalysis();
}

async function fetchDashboard() {
  const query = new URLSearchParams({ tradeFrom: tradeRange.from, tradeTo: tradeRange.to });
  return fetch(`/api/dashboard?${query}`, {
    cache: "no-store",
  });
}

async function loadDashboard(showToast = false) {
  $("refreshButton").disabled = true;
  try {
    const response = await fetchDashboard();
    if (!response.ok) throw new Error((await response.json()).error);
    dashboard = await response.json();
    dashboardLoaded = true;
    if (dashboard.tradeRange?.from && dashboard.tradeRange?.to) {
      tradeRange = { from: dashboard.tradeRange.from, to: dashboard.tradeRange.to };
    }
    dashboard.account.total = getEffectiveTotal(dashboard.account);
    $("modeBadge").textContent = "LIVE";
    if (showToast) toast("Gate.io 데이터를 새로 불러왔습니다.");
    return true;
  } catch (error) {
    dashboard = emptyDashboard;
    dashboardLoaded = false;
    $("modeBadge").textContent = "API OFFLINE";
    if (showToast) toast("API 연결을 확인해 주세요.");
    return false;
  } finally {
    $("refreshButton").disabled = false; render();
  }
}

async function checkHealth() {
  try {
    await fetch("/api/health").then(r=>r.json());
  } catch {}
}

document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-filter]").forEach(b=>b.classList.remove("active"));
  button.classList.add("active"); filter = button.dataset.filter; renderPositions();
}));
$("refreshButton").addEventListener("click", () => loadDashboard(true));
$("loadMoreTrades").addEventListener("click",()=>{
  visibleTradeCount=Math.min(5000,visibleTradeCount+10);
  renderTrades();
});
$("tradeDateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const from = $("tradeDateStart").value;
  const to = $("tradeDateEnd").value;
  const today = kstDateKey();
  if (!from || !to) return toast("시작일과 종료일을 모두 선택해 주세요.");
  if (from > to) return toast("시작일은 종료일보다 늦을 수 없습니다.");
  if (to > today) return toast("미래 날짜는 조회할 수 없습니다.");
  const days = Math.floor((Date.parse(`${to}T00:00:00+09:00`) - Date.parse(`${from}T00:00:00+09:00`)) / DAY_MS) + 1;
  if (days > 31) return toast("한 번에 최대 31일까지 조회할 수 있습니다.");
  tradeRange = { from, to };
  visibleTradeCount = 10;
  const button = $("applyTradeDates");
  button.disabled = true;
  button.textContent = "조회 중";
  const loaded = await loadDashboard(false);
  button.disabled = false;
  button.textContent = "적용";
  toast(loaded ? `${from.replaceAll("-", ".")} — ${to.replaceAll("-", ".")} 체결을 불러왔습니다.` : "체결 내역을 불러오지 못했습니다.");
});
document.querySelectorAll("[data-trade-filter]").forEach((button)=>button.addEventListener("click",()=>{
  document.querySelectorAll("[data-trade-filter]").forEach((item)=>item.classList.remove("active"));
  button.classList.add("active");
  tradeFilter=button.dataset.tradeFilter;
  visibleTradeCount=10;
  renderTrades();
}));

document.addEventListener("click", (event) => {
  const monthButton = event.target.closest("[data-analysis-month]");
  if (monthButton) {
    analysisMonth = monthButton.dataset.analysisMonth;
    renderAssetAnalysis();
    return;
  }
});
window.addEventListener("hashchange", resolveView);
setInterval(() => { $("clock").textContent = new Date().toLocaleString("ko-KR",{hour12:false,timeZone:"Asia/Seoul"})+" KST"; },1000);
await checkHealth();
$("tradeDateStart").max = kstDateKey();
$("tradeDateEnd").max = kstDateKey();
$("tradeDateStart").value = tradeRange.from;
$("tradeDateEnd").value = tradeRange.to;
resolveView();
setInterval(() => loadDashboard(false), 30_000);
renderPerformancePeriod();
setInterval(renderPerformancePeriod, 60_000);


