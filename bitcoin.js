const $b = (id) => document.getElementById(id);
const money = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const numberText = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
const escapeBtc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
const directionLabel = (value) => value === "LONG" ? "상승" : value === "SHORT" ? "하락" : "혼조";
const statusLabel = (value) => value === "ENTRY_ZONE" ? "진입 구간" : value === "NO_CHASE" ? "추격 금지" : "트리거 대기";
let bitcoinData = null;
let selectedPlan = "long";

function timeText(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false, timeZone:"Asia/Seoul" });
}

function toast(message) {
  const target = $b("toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(window.bitcoinToastTimer);
  window.bitcoinToastTimer = setTimeout(() => target.classList.remove("show"), 2600);
}

function renderTimeframes() {
  const labels = [
    ["week", "1W", "큰 방향"], ["day", "1D", "중기 방향"], ["fourHour", "4H", "스윙 구조"],
    ["oneHour", "1H", "단기 추세"], ["fifteenMinute", "15m", "실행 구조"], ["fiveMinute", "5m", "진입 트리거"],
  ];
  $b("btcTimeframes").innerHTML = labels.map(([key, label, role]) => {
    const frame = bitcoinData.timeframes[key];
    const tone = frame.direction === "LONG" ? "long" : frame.direction === "SHORT" ? "short" : "wait";
    return `<article class="btc-timeframe ${tone}"><small>${label} · ${role}</small><strong>${directionLabel(frame.direction)}</strong><div><span>RSI ${numberText(frame.rsi, 1)}</span><span>EMA20 ${money(frame.ema20)}</span></div></article>`;
  }).join("");
}

function renderPlan() {
  const plan = bitcoinData.plans[selectedPlan];
  const tone = plan.direction === "LONG" ? "long" : "short";
  const targetRows = plan.targets.map((target) => `<article><div><small>${escapeBtc(target.label)} 익절</small><strong>${money(target.price)}</strong></div><b>R:R ${numberText(target.rr, 2)}</b><p>${escapeBtc(target.action)}</p></article>`).join("");
  $b("btcPlanCard").className = `panel btc-plan-card ${tone}`;
  $b("btcPlanCard").innerHTML = `
    <div class="btc-plan-hero">
      <div><span class="btc-plan-direction ${tone}">${plan.direction}</span><h3>${statusLabel(plan.status)}</h3><p>방향 점수 ${plan.score}/100 · 손절 거리 ${numberText(plan.riskPercent, 3)}%</p></div>
      <strong>${money(plan.zone.low)}<i>—</i>${money(plan.zone.high)}</strong>
    </div>
    <div class="btc-plan-level-grid">
      <article><small>지정가 중심</small><strong>${money(plan.entry)}</strong></article>
      <article><small>5분봉 확정 트리거</small><strong>${money(plan.trigger)}</strong></article>
      <article><small>손절가</small><strong class="negative">${money(plan.stop)}</strong></article>
      <article><small>가격 리스크</small><strong>${money(plan.riskDistance)}</strong></article>
    </div>
    <section class="btc-confirm-section"><h4>진입 확인 순서</h4><ol>${plan.confirmations.map((item) => `<li>${escapeBtc(item)}</li>`).join("")}</ol></section>
    <section class="btc-plan-basis"><h4>진입 구간 산출 근거</h4><div>${plan.basis.map((item) => `<span>${escapeBtc(item)}</span>`).join("")}</div></section>
    <section class="btc-targets"><h4>분할 익절 계획</h4><div>${targetRows}</div></section>
    <div class="btc-invalidation"><div><small>시나리오 무효화</small><p>${escapeBtc(plan.invalidation)}</p></div><div><small>추격 금지 기준</small><p>${escapeBtc(plan.noChase)}</p></div></div>`;
  calculateRisk();
}

function renderChecklist() {
  const rows = bitcoinData.checklist || [];
  $b("btcChecklistScore").textContent = `${bitcoinData.checklistScore.passed}/${bitcoinData.checklistScore.total}`;
  $b("btcChecklist").innerHTML = rows.map((item) => `<div class="${item.pass ? "pass" : "fail"}"><i>${item.pass ? "✓" : "—"}</i><span>${escapeBtc(item.label)}</span></div>`).join("");
}

function calculateRisk() {
  if (!bitcoinData) return;
  const plan = bitcoinData.plans[selectedPlan];
  const account = Math.max(0, Number($b("btcAccountSize").value || 0));
  const riskPercent = Math.max(0, Number($b("btcRiskPercent").value || 0));
  const leverage = Math.max(1, Number($b("btcLeverage").value || 1));
  const riskAmount = account * riskPercent / 100;
  const entry = Number(plan.entry);
  const stopDistancePercent = Math.abs(entry - Number(plan.stop)) / entry;
  const notional = stopDistancePercent ? riskAmount / stopDistancePercent : 0;
  const quantity = entry ? notional / entry : 0;
  const margin = notional / leverage;
  const excessive = margin > account;
  $b("btcRiskResult").innerHTML = `
    <div><dt>허용 손실</dt><dd>${money(riskAmount)}</dd></div>
    <div><dt>권장 포지션 규모</dt><dd>${money(notional)}</dd></div>
    <div><dt>BTC 수량</dt><dd>${numberText(quantity, 5)} BTC</dd></div>
    <div><dt>필요 증거금</dt><dd class="${excessive ? "negative" : ""}">${money(margin)}</dd></div>
    <div><dt>손절 거리</dt><dd>${numberText(plan.riskPercent, 3)}%</dd></div>
    ${excessive ? `<p>현재 설정에서는 필요 증거금이 계좌 자산을 초과합니다. 위험률 또는 포지션 규모를 낮추세요.</p>` : ""}`;
}

function renderStructure() {
  const structure = bitcoinData.marketStructure;
  const supports = structure.support.slice(0, 3).map((item, index) => `<div><span>S${index + 1}</span><strong>${money(item.price)}</strong><small>${item.touches}회 반응</small></div>`).join("");
  const resistance = structure.resistance.slice(0, 3).map((item, index) => `<div><span>R${index + 1}</span><strong>${money(item.price)}</strong><small>${item.touches}회 반응</small></div>`).join("");
  $b("btcLevels").innerHTML = `<section><h3>저항</h3>${resistance || "<p>가까운 저항 미확인</p>"}</section><section><h3>지지</h3>${supports || "<p>가까운 지지 미확인</p>"}</section>`;
  const sweep = structure.sweep ? `${structure.sweep.direction === "LONG" ? "저점" : "고점"} 유동성 스윕 · ${money(structure.sweep.level)}` : "최근 유동성 스윕 없음";
  const fvg5Long = structure.fvg5.long ? `${money(structure.fvg5.long.low)}–${money(structure.fvg5.long.high)}` : "없음";
  const fvg5Short = structure.fvg5.short ? `${money(structure.fvg5.short.low)}–${money(structure.fvg5.short.high)}` : "없음";
  $b("btcMicroData").innerHTML = `
    <div><span>24H VWAP</span><strong>${money(structure.vwap24h)}</strong></div>
    <div><span>5분 거래량</span><strong>${numberText(structure.volume5m.ratio, 2)}×</strong></div>
    <div><span>호가 불균형</span><strong class="${structure.orderBook.imbalance >= 0 ? "positive" : "negative"}">${structure.orderBook.imbalance >= 0 ? "+" : ""}${numberText(structure.orderBook.imbalance, 1)}%</strong></div>
    <div><span>펀딩</span><strong>${bitcoinData.fundingRate >= 0 ? "+" : ""}${numberText(bitcoinData.fundingRate, 4)}%</strong></div>
    <div><span>LONG 5m FVG</span><strong>${fvg5Long}</strong></div>
    <div><span>SHORT 5m FVG</span><strong>${fvg5Short}</strong></div>
    <div class="wide"><span>유동성</span><strong>${escapeBtc(sweep)}</strong></div>`;
}

function renderBitcoin() {
  $b("bitcoinLoading").hidden = true;
  $b("bitcoinDashboard").hidden = false;
  const direction = bitcoinData.direction;
  const tone = direction === "LONG" ? "long" : direction === "SHORT" ? "short" : "wait";
  $b("btcPrice").textContent = money(bitcoinData.price);
  $b("btcChange").textContent = `${bitcoinData.change24h >= 0 ? "+" : ""}${numberText(bitcoinData.change24h, 2)}% 24H`;
  $b("btcChange").className = bitcoinData.change24h >= 0 ? "positive" : "negative";
  $b("btcUpdated").textContent = `${timeText(bitcoinData.updatedAt)} KST`;
  $b("btcMarketStatus").textContent = `${bitcoinData.source} · LIVE`;
  $b("btcVerdictBadge").textContent = direction === "WAIT" ? "WAIT" : direction;
  $b("btcVerdictBadge").className = tone;
  $b("btcStatus").textContent = bitcoinData.status;
  $b("btcExecutionRule").textContent = bitcoinData.executionRule;
  $b("btcLongScore").textContent = bitcoinData.scores.long;
  $b("btcShortScore").textContent = bitcoinData.scores.short;
  $b("btcCandleTime").textContent = `최근 확정 5분봉 ${timeText(bitcoinData.candleClosedAt)} KST`;
  selectedPlan = bitcoinData.primaryPlan === "SHORT" ? "short" : "long";
  document.querySelectorAll("[data-plan]").forEach((button) => button.classList.toggle("active", button.dataset.plan === selectedPlan));
  renderTimeframes();
  renderPlan();
  renderChecklist();
  renderStructure();
}

async function loadBitcoin(showToast = false) {
  const button = $b("bitcoinRefresh");
  button.disabled = true;
  try {
    const response = await fetch("/api/bitcoin", { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "비트코인 분석 조회 실패");
    bitcoinData = await response.json();
    renderBitcoin();
    if (showToast) toast("비트코인 데이터를 갱신했습니다.");
  } catch (error) {
    $b("bitcoinLoading").innerHTML = `<article class="panel btc-error"><strong>실시간 분석을 불러오지 못했습니다.</strong><p>${escapeBtc(error.message)}</p><button type="button" id="btcRetry">다시 시도</button></article>`;
    $b("btcRetry")?.addEventListener("click", () => loadBitcoin());
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-plan]").forEach((button) => button.addEventListener("click", () => {
  selectedPlan = button.dataset.plan;
  document.querySelectorAll("[data-plan]").forEach((item) => item.classList.toggle("active", item === button));
  renderPlan();
}));
["btcAccountSize", "btcRiskPercent", "btcLeverage"].forEach((id) => $b(id).addEventListener("input", calculateRisk));
$b("bitcoinRefresh").addEventListener("click", () => loadBitcoin(true));
setInterval(() => {
  $b("bitcoinClock").textContent = new Date().toLocaleString("ko-KR", { hour12:false, timeZone:"Asia/Seoul" }) + " KST";
}, 1000);
loadBitcoin();
setInterval(() => loadBitcoin(false), 30_000);
