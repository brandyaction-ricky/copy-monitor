const emptyDashboard = {
  mode: "unconfigured",
  account: { total: 0, available: 0, positionMargin: 0, unrealizedPnl: 0, totalPnl: 0, todayRealizedPnl: 0 },
  positions: [],
  trades: [],
  closeRecords: [],
  history: [],
};

let dashboard = emptyDashboard;
let filter = "all";
let visibleTradeCount = 10;
let tradeFilter = "all";
const $ = (id) => document.getElementById(id);
const getEffectiveTotal = (account = dashboard.account) => {
  const analysisTotal = Number(account?.analysisTotal || 0);
  const reported = Number(account?.total || 0);
  const available = Number(account?.available || 0);
  const positionMargin = Number(account?.positionMargin || 0);
  return analysisTotal || (reported > 0 ? reported : available + positionMargin);
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

async function loadMarketIndicators() {
  const grid = $("marketGrid");
  const names = ["나스닥","코스피","비트코인","환율 (달러/원)","WTI 원유","EWY","SK하이닉스"];
  grid.innerHTML = names.map((name) => `<article class="market-card loading"><span>${name}</span><strong>—</strong><em>조회 중</em></article>`).join("");
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    if (!response.ok) throw new Error("시장 지표 조회 실패");
    const data = await response.json();
    grid.innerHTML = data.indicators.map((item) => {
      const available = Number.isFinite(item.price);
      const change = Number(item.changePercent || 0);
      const tone = !available ? "muted" : change >= 0 ? "positive" : "negative";
      const price = available ? new Intl.NumberFormat("en-US", { minimumFractionDigits:item.digits, maximumFractionDigits:item.digits }).format(item.price) : "—";
      return `<article class="market-card"><span><i class="market-dot ${tone}"></i>${item.name}</span><strong>${price}</strong><em class="${tone}">${available ? `${change>=0?"+":""}${change.toFixed(2)}%` : "조회 불가"}</em></article>`;
    }).join("");
    renderSentiments(data.sentiments || []);
    $("marketUpdated").textContent = `${new Date(data.updatedAt).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Seoul"})} KST`;
  } catch {
    grid.innerHTML = names.map((name) => `<article class="market-card"><span><i class="market-dot muted"></i>${name}</span><strong>—</strong><em class="muted">조회 불가</em></article>`).join("");
    $("marketUpdated").textContent = "연결 확인 필요";
    renderSentiments([]);
  }
}

function renderSentiments(items) {
  const defaults = ["비트코인","나스닥","코스피"];
  const values = defaults.map((name) => items.find((item) => item.name === name) || { name, score:null, label:"조회 불가", source:"" });
  $("sentimentGrid").innerHTML = values.map((item) => {
    const score = Number.isFinite(item.score) ? item.score : 50;
    const tone = item.score == null ? "muted" : score < 45 ? "negative" : score < 56 ? "neutral" : "positive";
    return `<article class="sentiment-card">
      <div class="sentiment-name"><span>${item.name}</span><small>${item.source || ""}</small></div>
      <div class="gauge"><div class="gauge-arc"><i style="transform:rotate(${score*1.8-90}deg)"></i></div></div>
      <div class="sentiment-value ${tone}"><strong>${item.score == null ? "—" : item.score}</strong><span>${item.label}</span></div>
    </article>`;
  }).join("");
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
  const trades = tradeFilter === "all"
    ? (dashboard.trades || []).slice(0,100)
    : (dashboard.closeRecords || []).filter((record) => record.status === tradeFilter).slice(0,100);
  $("tradesBody").innerHTML = trades.length ? trades.slice(0,visibleTradeCount).map((t) => `<tr>
    <td data-label="시간">${new Date(t.time).toLocaleString("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})}</td>
    <td data-label="종목"><strong>${t.symbol}</strong></td>
    <td data-label="상태">${t.status ? `<span class="close-status ${t.status}">${t.status==="closed"?"청산 완료":"부분 청산"}</span>` : `<span class="trade-side ${t.side}">${t.side==="buy"?"매수":"매도"}</span>`}</td>
    <td data-label="체결가">${t.price ? usd(t.price) : "—"}</td>
    <td data-label="실현손익" class="${t.realizedPnl == null ? "" : t.realizedPnl >= 0 ? "positive" : "negative"}">${t.realizedPnl == null ? "—" : usd(t.realizedPnl,true)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty-row">해당 상태의 기록이 없습니다.</td></tr>`;
  const button = $("loadMoreTrades");
  const remaining = trades.length - visibleTradeCount;
  button.hidden = remaining <= 0;
  button.textContent = remaining > 0
    ? `더 보기 (${Math.min(10,remaining)}개 · ${Math.min(visibleTradeCount,trades.length)}/${trades.length})`
    : "모두 표시됨";
}

function renderHistory() {
  const rawPoints = dashboard.history || [];
  const currentTotal = getEffectiveTotal();
  const historyEnd = rawPoints.length ? Number(rawPoints[rawPoints.length-1].value || 0) : 0;
  const correction = currentTotal - historyEnd;
  const points = rawPoints.map((point) => ({
    ...point,
    value: Number(point.value || 0) + correction,
  }));
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
  const start = values[0], end = values[values.length-1], change = end-start;
  const rate = start ? change/start*100 : 0;
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
  $("historyDescription").textContent="7월 1일부터 현재까지의 선물 자산 분석 데이터입니다.";
}

function render() {
  const a = dashboard.account, positions = dashboard.positions;
  const effectiveTotal = getEffectiveTotal(a);
  a.total = effectiveTotal;
  $("chartEnd").textContent = usd(effectiveTotal);
  const totalPnl = Number(a.totalPnl ?? a.unrealizedPnl ?? 0);
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
  renderPositions(); renderTrades(); renderHistory();
}

async function loadDashboard(showToast = false) {
  $("refreshButton").disabled = true;
  try {
    const response = await fetch("/api/dashboard", {cache:"no-store"});
    if (!response.ok) throw new Error((await response.json()).error);
    dashboard = await response.json();
    dashboard.account.total = getEffectiveTotal(dashboard.account);
    $("modeBadge").textContent = "LIVE";
    if (showToast) toast("Gate.io 데이터를 새로 불러왔습니다.");
  } catch (error) {
    dashboard = emptyDashboard;
    $("modeBadge").textContent = "API OFFLINE";
    if (showToast) toast("API 연결을 확인해 주세요.");
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
$("refreshButton").addEventListener("click",()=>loadDashboard(true));
$("loadMoreTrades").addEventListener("click",()=>{
  visibleTradeCount=Math.min(100,visibleTradeCount+10);
  renderTrades();
});
document.querySelectorAll("[data-trade-filter]").forEach((button)=>button.addEventListener("click",()=>{
  document.querySelectorAll("[data-trade-filter]").forEach((item)=>item.classList.remove("active"));
  button.classList.add("active");
  tradeFilter=button.dataset.tradeFilter;
  visibleTradeCount=10;
  renderTrades();
}));
setInterval(() => { $("clock").textContent = new Date().toLocaleString("ko-KR",{hour12:false,timeZone:"Asia/Seoul"})+" KST"; },1000);
await Promise.all([checkHealth(), loadDashboard(), loadMarketIndicators()]);
setInterval(()=>loadDashboard(false),30_000);
setInterval(()=>loadMarketIndicators(),60_000);
