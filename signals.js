const DEFAULT_US_WATCHLIST = ["NVDA","AAPL","MSFT","AMZN","META","TSLA","AMD","AVGO"];
const KR_STOCKS = {
  "005930.KS":"삼성전자", "000660.KS":"SK하이닉스", "005380.KS":"현대차",
  "066570.KS":"LG전자", "035420.KS":"NAVER", "042700.KS":"한미반도체",
};
const DEFAULT_KR_WATCHLIST = Object.keys(KR_STOCKS);
const STORE_KEY = "tooja-watchlist-v2";
const $s = (id) => document.getElementById(id);
const escapeSignalHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(saved) && saved.length ? saved : [...DEFAULT_US_WATCHLIST, ...DEFAULT_KR_WATCHLIST];
  } catch {
    return [...DEFAULT_US_WATCHLIST, ...DEFAULT_KR_WATCHLIST];
  }
}

let watchlist = loadWatchlist();
let signalPayload = null;
let signalTab = "market";
let signalRegion = "US";

const marketOf = (symbol) => /\.(KS|KQ)$/.test(String(symbol || "")) ? "KR" : "US";
const displaySymbol = (symbol) => KR_STOCKS[symbol] || symbol;
const saveWatchlist = () => localStorage.setItem(STORE_KEY, JSON.stringify(watchlist));

function patchNavigation() {
  document.querySelectorAll('a[href="#coin-recommendations"],a[href="/#coin-recommendations"]').forEach((anchor) => {
    anchor.href = "/bitcoin.html";
    anchor.textContent = "트레이딩";
  });
}

function signalTime(value) {
  if (!value) return "시간 미확인";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
  return new Date(value).toLocaleDateString("ko-KR", { month:"numeric", day:"numeric", timeZone:"Asia/Seoul" });
}

function renderWatchlistChips() {
  const target = $s("watchlistChips");
  if (!target) return;
  const items = watchlist.filter((symbol) => marketOf(symbol) === signalRegion);
  target.innerHTML = items.map((symbol) => `<span class="watchlist-chip">★ ${escapeSignalHtml(displaySymbol(symbol))}<button type="button" data-remove-watch="${escapeSignalHtml(symbol)}" aria-label="${escapeSignalHtml(displaySymbol(symbol))} 삭제">×</button></span>`).join("");
}

function marketItems() {
  const items = (signalPayload?.news || []).filter((item) => item.market === signalRegion || marketOf(item.sourceSymbol || "") === signalRegion);
  return signalTab === "watch"
    ? items.filter((item) => (item.relatedTickers || []).some((ticker) => watchlist.includes(ticker)))
    : items;
}

function issueCard(item, rank, hot = false) {
  const related = (item.relatedTickers || []).filter((ticker) => marketOf(ticker) === signalRegion).slice(0, 6);
  const safeLink = item.link && /^https?:\/\//i.test(item.link) ? item.link : "#";
  const tag = hot ? "당일 핵심" : item.ageMinutes <= 15 ? "새 이슈" : item.score >= 70 ? "주목" : "업데이트";
  return `<article class="issue-card ${hot ? "hot" : ""}">
    <div class="issue-rank">${hot ? "🔥" : rank}</div>
    <div class="issue-body">
      ${hot ? `<div class="hot-label">TODAY · ISSUE SCORE 80+</div>` : ""}
      <h3><a href="${escapeSignalHtml(safeLink)}" target="_blank" rel="noopener noreferrer">${escapeSignalHtml(item.title)}</a></h3>
      <div class="issue-meta"><span>${escapeSignalHtml(item.publisher)}</span><span>${signalTime(item.publishedAt)}</span><span>${tag}</span><span>${item.sourceCount || 1}개 출처</span></div>
      <div class="issue-tickers">${related.map((ticker) => `<span>${escapeSignalHtml(displaySymbol(ticker))}${watchlist.includes(ticker) ? " ★" : ""}</span>`).join("")}</div>
    </div>
    <div class="issue-score"><b>${item.score}</b><small>이슈점수</small></div>
  </article>`;
}

function renderSignals() {
  renderWatchlistChips();
  if (!signalPayload) return;
  const items = marketItems();
  const hotItems = items.filter((item) => item.hot && item.isToday);
  const regularItems = items.filter((item) => !(item.hot && item.isToday));
  const updated = new Date(signalPayload.updatedAt).toLocaleString("ko-KR", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Seoul" });
  $s("signalUpdatedAt").textContent = `${updated} KST`;
  $s("signalIssueCount").textContent = `${items.length}개 이슈`;
  const list = $s("signalIssueList");
  if (!items.length) {
    list.innerHTML = `<div class="panel signal-empty">${signalTab === "watch" ? "현재 관심종목과 연결된 최신 이슈가 없습니다." : `${signalRegion === "US" ? "미국" : "한국"} 핵심 이슈를 찾지 못했습니다.`}</div>`;
  } else {
    const hotMarkup = hotItems.length ? `<section class="hot-issue-group"><div class="hot-issue-head"><div><strong>당일 핵심 이슈</strong><span>이슈점수 80점 이상 · 최상단 고정</span></div><b>${hotItems.length}</b></div>${hotItems.slice(0, 8).map((item, index) => issueCard(item, index + 1, true)).join("")}</section>` : "";
    const regularMarkup = regularItems.length ? `<section class="regular-issue-group">${regularItems.slice(0, 30).map((item, index) => issueCard(item, index + 1, false)).join("")}</section>` : "";
    list.innerHTML = hotMarkup + regularMarkup;
  }

  const stocks = (signalPayload.stocks || []).filter((stock) => marketOf(stock.symbol) === signalRegion && watchlist.includes(stock.symbol));
  $s("watchStockList").innerHTML = stocks.length ? stocks.map((stock) => {
    const change = Number(stock.changePercent);
    const hasChange = Number.isFinite(change);
    const currency = signalRegion === "KR" ? "₩" : "$";
    const price = stock.price == null ? "가격 미확인" : `${currency}${Number(stock.price).toLocaleString(signalRegion === "KR" ? "ko-KR" : "en-US", { maximumFractionDigits: signalRegion === "KR" ? 0 : 2 })}`;
    return `<article class="watch-stock"><div class="watch-stock-top"><strong>${escapeSignalHtml(displaySymbol(stock.symbol))}</strong><em class="${change >= 0 ? "up" : "down"}">${hasChange ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—"}</em></div><p>${escapeSignalHtml(stock.name || displaySymbol(stock.symbol))} · ${price}</p></article>`;
  }).join("") : `<div class="signal-empty">관심종목 시세를 불러오는 중입니다.</div>`;

  const note = $s("signalSourceNote");
  if (note) note.innerHTML = `<b>MVP 데이터 기준</b><br>미국 뉴스: ${escapeSignalHtml(signalPayload.providers?.US || "Yahoo Finance")}<br>한국 뉴스: ${escapeSignalHtml(signalPayload.providers?.KR || "국내 실시간 뉴스 검색")}<br>기사 전문은 저장하지 않으며, 당일 이슈점수 80점 이상은 상단 HOT 영역에 고정합니다.`;
}

async function loadSignals(showToast = false) {
  const refresh = $s("signalRefresh");
  if (refresh) refresh.disabled = true;
  const list = $s("signalIssueList");
  if (!list) return;
  list.innerHTML = Array.from({ length: 5 }, () => `<div class="signal-loading"></div>`).join("");
  try {
    const symbols = [...new Set([...DEFAULT_US_WATCHLIST, ...DEFAULT_KR_WATCHLIST, ...watchlist])].slice(0, 30);
    const response = await fetch(`/api/signals?symbols=${encodeURIComponent(symbols.join(","))}`, { cache:"no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "실시간 이슈 조회 실패");
    signalPayload = await response.json();
    renderSignals();
    if (showToast && $s("toast")) {
      $s("toast").textContent = "실시간 이슈를 갱신했습니다.";
      $s("toast").classList.add("show");
      setTimeout(() => $s("toast").classList.remove("show"), 2500);
    }
  } catch (error) {
    list.innerHTML = `<div class="panel signal-empty"><strong>실시간 이슈를 불러오지 못했습니다.</strong><br>${escapeSignalHtml(error.message)}</div>`;
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function initSignals() {
  patchNavigation();
  renderWatchlistChips();
  document.querySelectorAll("[data-signal-tab]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-signal-tab]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    signalTab = button.dataset.signalTab;
    renderSignals();
  }));
  document.querySelectorAll("[data-signal-region]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-signal-region]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    signalRegion = button.dataset.signalRegion;
    const input = $s("watchlistInput");
    if (input) input.placeholder = signalRegion === "US" ? "티커 추가 · 예: PLTR" : "종목코드 추가 · 예: 005930";
    renderSignals();
  }));
  $s("watchlistForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $s("watchlistInput");
    let symbol = input.value.toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, "");
    if (signalRegion === "KR" && /^\d{6}$/.test(symbol)) symbol += ".KS";
    if (!symbol || watchlist.includes(symbol)) {
      input.value = "";
      return;
    }
    watchlist = [...watchlist, symbol].slice(-30);
    saveWatchlist();
    input.value = "";
    await loadSignals();
  });
  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-watch]");
    if (!remove) return;
    watchlist = watchlist.filter((symbol) => symbol !== remove.dataset.removeWatch);
    saveWatchlist();
    renderSignals();
  });
  $s("signalRefresh")?.addEventListener("click", () => loadSignals(true));
}

window.tooJaSignals = { init: initSignals, load: loadSignals, refresh: () => loadSignals(true) };
patchNavigation();
if (location.hash === "#signals") location.replace("/signals.html");
if (location.hash === "#coin-recommendations") location.replace("/bitcoin.html");
window.addEventListener("hashchange", () => {
  if (location.hash === "#signals") location.replace("/signals.html");
  if (location.hash === "#coin-recommendations") location.replace("/bitcoin.html");
});
