const $b = (id) => document.getElementById(id);
const money = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const numberText = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
const escapeBtc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
const directionLabel = (value) => value === "LONG" ? "상승" : value === "SHORT" ? "하락" : "혼조";
const statusLabel = (value) => ({
  ENTRY_READY: "실행 후보",
  WAIT_STRUCTURE: "구조 변화 대기",
  WAIT_RETEST: "첫 리테스트 대기",
  NO_CHASE: "추격 금지",
  RISK_TOO_WIDE: "손절 폭 과다",
  INVALID: "셋업 무효",
}[value] || "조건 확인 중");
let bitcoinData = null;
let selectedPlan = "long";
let selectedStrategy = "shortTerm";

function strategies() {
  if (bitcoinData?.strategies) return bitcoinData.strategies;
  return {
    shortTerm: {
      label: "단기",
      timeframe: "15분 구조 · 5분 실행",
      holdingPeriod: "수분~1일",
      direction: bitcoinData.direction,
      status: bitcoinData.status,
      scores: bitcoinData.scores,
      plans: bitcoinData.plans,
      primaryPlan: bitcoinData.primaryPlan,
      checklist: bitcoinData.checklist,
      checklistScore: bitcoinData.checklistScore,
      executionRule: bitcoinData.executionRule,
    },
  };
}

function currentStrategy() {
  return strategies()[selectedStrategy] || strategies().shortTerm;
}

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
    const focusFrames = selectedStrategy === "swing" ? ["week", "day", "fourHour", "oneHour"] : ["oneHour", "fifteenMinute", "fiveMinute"];
    const focus = focusFrames.includes(key) ? "focus" : "context";
    return `<article class="btc-timeframe ${tone} ${focus}"><small>${label} · ${role}</small><strong>${directionLabel(frame.direction)}</strong><div><span>RSI ${numberText(frame.rsi, 1)}</span><span>EMA20 ${money(frame.ema20)}</span></div></article>`;
  }).join("");
}

function verdictTone(direction) {
  return direction === "LONG" ? "long" : direction === "SHORT" ? "short" : "wait";
}

function renderStrategyOverview() {
  const map = strategies();
  const bind = (key, prefix) => {
    const strategy = map[key];
    if (!strategy) return;
    const badge = $b(`${prefix}Badge`);
    badge.textContent = strategy.direction === "WAIT" ? "관망" : strategy.direction;
    badge.className = verdictTone(strategy.direction);
    $b(`${prefix}Status`).textContent = strategy.status;
    $b(`${prefix}Meta`).textContent = `보유 ${strategy.holdingPeriod} · 셋업 품질 ${strategy.setupQuality ?? 0}/100 · 승률 아님`;
  };
  bind("shortTerm", "btcShortTerm");
  bind("swing", "btcSwing");
  document.querySelectorAll("[data-strategy]").forEach((button) => {
    const active = button.dataset.strategy === selectedStrategy;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderPlan() {
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const tone = plan.direction === "LONG" ? "long" : "short";
  const targetRows = plan.targets.map((target) => `<article><div><small>${escapeBtc(target.label)} 익절</small><strong>${money(target.price)}</strong></div><b>R:R ${numberText(target.rr, 2)}</b><p>${escapeBtc(target.action)}</p></article>`).join("");
  $b("btcPlanCard").className = `panel btc-plan-card ${tone}`;
  $b("btcPlanCard").innerHTML = `
    <div class="btc-plan-hero">
      <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>${escapeBtc(strategy.label)} · 보유 ${escapeBtc(plan.holdingPeriod || strategy.holdingPeriod)}</span></div><h3>${statusLabel(plan.status)}</h3><p>방향 ${plan.score}/100 · ICT 품질 ${plan.setupQuality ?? 0}/100 · 컨플루언스 ${plan.confluence?.count ?? 0}/${plan.confluence?.total ?? 0} · 승률 아님</p></div>
      <strong>${money(plan.zone.low)}<i>—</i>${money(plan.zone.high)}</strong>
    </div>
    <div class="btc-plan-level-grid">
      <article><small>지정가 중심</small><strong>${money(plan.entry)}</strong></article>
      <article><small>${escapeBtc(plan.triggerLabel || "5분봉 확정 트리거")}</small><strong>${money(plan.trigger)}</strong></article>
      <article><small>하드 스탑</small><strong class="negative">${money(plan.hardStop ?? plan.stop)}</strong></article>
      <article><small>1차 익절 · R:R ${numberText(plan.targets[0]?.rr, 2)}</small><strong>${money(plan.targets[0]?.price)}</strong></article>
    </div>
    <section class="btc-confirm-section"><h4>진입 확인 순서</h4><ol>${plan.confirmations.map((item) => `<li>${escapeBtc(item)}</li>`).join("")}</ol></section>
    <section class="btc-plan-basis"><h4>진입 구간 산출 근거</h4><div>${plan.basis.map((item) => `<span>${escapeBtc(item)}</span>`).join("")}</div></section>
    <section class="btc-targets"><h4>분할 익절 계획</h4><div>${targetRows}</div></section>
    <div class="btc-invalidation"><div><small>시나리오 무효화</small><p>${escapeBtc(plan.invalidation)}</p></div><div><small>추격 금지 기준</small><p>${escapeBtc(plan.noChase)}</p></div></div>`;
  renderExecutionStrip();
}

function renderChecklist() {
  const strategy = currentStrategy();
  const rows = strategy.checklist || [];
  $b("btcChecklistScore").textContent = `${strategy.checklistScore.passed}/${strategy.checklistScore.total}`;
  $b("btcChecklist").innerHTML = rows.map((item) => `<div class="${item.pass ? "pass" : "fail"}"><i>${item.pass ? "✓" : "—"}</i><span>${escapeBtc(item.label)}</span></div>`).join("");
}

function renderExecutionStrip() {
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const tone = verdictTone(strategy.direction);
  const direction = strategy.direction === "WAIT" ? "관망" : `${strategy.direction} · ${statusLabel(plan.status)}`;
  $b("btcFlowStrategy").textContent = `${strategy.label} · ${plan.direction}`;
  $b("btcFlowDirection").textContent = direction;
  $b("btcFlowDirection").className = tone;
  $b("btcFlowEntry").textContent = `${money(plan.zone.low)} – ${money(plan.zone.high)}`;
  $b("btcFlowStop").textContent = money(plan.stop);
  $b("btcFlowStop").className = "negative";
  $b("btcFlowTarget").textContent = money(plan.targets[0]?.price);
  $b("btcFlowTarget").className = "positive";
}

function renderMarketData() {
  const structure = bitcoinData.marketStructure;
  const session = structure.session || {};
  const sessionText = { ASIA: "아시아", LONDON: "런던", NEW_YORK: "뉴욕", OFF_HOURS: "비주요 시간" }[session.session] || "N/A";
  if (selectedStrategy === "swing") {
    const frame4h = bitcoinData.timeframes.fourHour;
    const frame1d = bitcoinData.timeframes.day;
    const fvg = structure.fvg4h?.[selectedPlan];
    const orderBlock = structure.orderBlocks?.swing?.[selectedPlan];
    const range = structure.swingRange;
    const structureEvent = structure.structure1h?.latestEvent;
    const channel = structure.channels?.swing;
    $b("btcMicroData").innerHTML = `
      <div><span>HTF 바이어스</span><strong>${escapeBtc(structure.swingBias || "WAIT")}</strong></div>
      <div><span>4시간 레인지 위치</span><strong>${escapeBtc(range?.zone || "N/A")} · ${numberText(range?.positionPercent, 1)}%</strong></div>
      <div><span>1시간 구조</span><strong>${structureEvent ? `${escapeBtc(structureEvent.type)} ${escapeBtc(structureEvent.direction)}` : "확정 구조 없음"}</strong></div>
      <div><span>PWH / PWL</span><strong>${money(session.previousWeekHigh)} / ${money(session.previousWeekLow)}</strong></div>
      <div><span>4시간 RSI</span><strong>${numberText(frame4h.rsi, 1)}</strong></div>
      <div><span>펀딩</span><strong>${bitcoinData.fundingRate >= 0 ? "+" : ""}${numberText(bitcoinData.fundingRate, 4)}%</strong></div>
      <div><span>${selectedPlan.toUpperCase()} 4H OB</span><strong>${orderBlock ? `${money(orderBlock.low)}–${money(orderBlock.high)} · ${escapeBtc(orderBlock.state)}` : "N/A"}</strong></div>
      <div><span>${selectedPlan.toUpperCase()} 4H FVG</span><strong>${fvg ? `${money(fvg.low)}–${money(fvg.high)} · ${escapeBtc(fvg.state)}` : "N/A"}</strong></div>
      <div><span>4시간 채널</span><strong>${channel?.valid ? `${escapeBtc(channel.direction)} · 상하단 3회+ 터치` : "약함/N/A"}</strong></div>
      <div><span>SMT</span><strong>N/A · 비교 자산 미연결</strong></div>`;
    return;
  }
  const sweep = structure.sweep ? `${structure.sweep.label || (structure.sweep.direction === "LONG" ? "하단" : "상단")} 스윕 · ${money(structure.sweep.level)} · ${structure.sweep.confirmed ? "반전 확인" : "후속 확인 대기"}` : "최근 유동성 스윕 없음";
  const fvg5Long = structure.fvg5.long ? `${money(structure.fvg5.long.low)}–${money(structure.fvg5.long.high)}` : "없음";
  const fvg5Short = structure.fvg5.short ? `${money(structure.fvg5.short.low)}–${money(structure.fvg5.short.high)}` : "없음";
  const range = structure.executionRange;
  const orderBlock = structure.orderBlocks?.shortTerm?.[selectedPlan];
  const structureEvent = structure.structure5?.latestEvent;
  const channel = structure.channels?.shortTerm;
  $b("btcMicroData").innerHTML = `
    <div><span>세션 · HTF</span><strong>${sessionText} · ${escapeBtc(structure.shortTermBias || "WAIT")}</strong></div>
    <div><span>PDH / PDL</span><strong>${money(session.previousDayHigh)} / ${money(session.previousDayLow)}</strong></div>
    <div><span>Asia High / Low</span><strong>${money(session.asiaHigh)} / ${money(session.asiaLow)}</strong></div>
    <div><span>Daily Open</span><strong>${money(session.dailyOpen)}</strong></div>
    <div><span>15분 레인지 위치</span><strong>${escapeBtc(range?.zone || "N/A")} · ${numberText(range?.positionPercent, 1)}%</strong></div>
    <div><span>5분 구조</span><strong>${structureEvent ? `${escapeBtc(structureEvent.type)} ${escapeBtc(structureEvent.direction)}` : "확정 구조 없음"}</strong></div>
    <div><span>${selectedPlan.toUpperCase()} 5m OB</span><strong>${orderBlock ? `${money(orderBlock.low)}–${money(orderBlock.high)} · ${escapeBtc(orderBlock.state)}` : "N/A"}</strong></div>
    <div><span>${selectedPlan.toUpperCase()} 5m FVG</span><strong>${selectedPlan === "long" ? fvg5Long : fvg5Short}</strong></div>
    <div><span>5분 거래량 / 펀딩</span><strong>${numberText(structure.volume5m.ratio, 2)}× · ${bitcoinData.fundingRate >= 0 ? "+" : ""}${numberText(bitcoinData.fundingRate, 4)}%</strong></div>
    <div><span>호가 불균형 · 보조</span><strong class="${structure.orderBook.imbalance >= 0 ? "positive" : "negative"}">${structure.orderBook.imbalance >= 0 ? "+" : ""}${numberText(structure.orderBook.imbalance, 1)}%</strong></div>
    <div><span>15분 채널</span><strong>${channel?.valid ? `${escapeBtc(channel.direction)} · 상하단 3회+ 터치` : "약함/N/A"}</strong></div>
    <div><span>SMT</span><strong>N/A · 비교 자산 미연결</strong></div>
    <div class="wide"><span>유동성 스윕</span><strong>${escapeBtc(sweep)}</strong></div>`;
}

function renderSelectedStrategy() {
  const strategy = currentStrategy();
  const tone = verdictTone(strategy.direction);
  $b("btcStrategyName").textContent = strategy.label;
  $b("btcVerdictBadge").textContent = strategy.direction === "WAIT" ? "WAIT" : strategy.direction;
  $b("btcVerdictBadge").className = tone;
  $b("btcVerdictBadge").closest(".btc-verdict-card").dataset.tone = tone;
  $b("btcStatus").textContent = strategy.status;
  $b("btcExecutionRule").textContent = strategy.executionRule;
  $b("btcLongScore").textContent = strategy.scores.long;
  $b("btcShortScore").textContent = strategy.scores.short;
  $b("btcLongScore").parentElement.classList.toggle("winner", strategy.scores.long > strategy.scores.short);
  $b("btcShortScore").parentElement.classList.toggle("winner", strategy.scores.short > strategy.scores.long);
  $b("btcTimeframeGuide").textContent = selectedStrategy === "swing"
    ? "스윙은 주봉·일봉·4시간 정렬을 우선하고 1시간봉으로 진입을 확인합니다."
    : "단기는 1시간·15분·5분 정렬을 우선하고 5분봉으로 진입을 확인합니다.";
  $b("btcPlanEyebrow").textContent = selectedStrategy === "swing" ? "SWING EXECUTION" : "SHORT-TERM EXECUTION";
  $b("btcPlanHeading").textContent = selectedStrategy === "swing" ? "스윙 진입 시나리오" : "단기 진입 시나리오";
  $b("btcPlanContext").textContent = selectedStrategy === "swing" ? "일봉·4시간 구조와 1시간봉 확정 기준" : "15분 구조와 5분봉 확정 기준";
  $b("btcChecklistHeading").textContent = selectedStrategy === "swing" ? "스윙 진입 체크" : "단기 진입 체크";
  $b("btcChecklistGuide").textContent = selectedStrategy === "swing" ? "보유 전 상위 시간대 필수 확인" : "실행 전 하위 시간대 필수 확인";
  $b("btcDataGuide").textContent = selectedStrategy === "swing" ? "4시간·일봉·펀딩" : "5분봉·호가·펀딩";
  $b("btcExecutionPrinciple").textContent = selectedStrategy === "swing"
    ? "스윙 진입 구간은 조건부 계획입니다. 일봉·4시간 구조, 4시간 OB/FVG, 1시간 BOS/CHoCH와 첫 리테스트 뒤 실행하며 하드 스탑은 즉시 적용합니다. 셋업 점수는 승률이 아니며 아직 백테스트로 보정되지 않았습니다."
    : "단기 진입 구간은 조건부 계획입니다. HTF 정렬, 유동성 스윕, 5분봉 몸통 BOS/CHoCH, 신선한 OB/FVG 첫 리테스트와 최소 1.5R을 모두 확인합니다. 셋업 점수는 승률이 아니며 아직 백테스트로 보정되지 않았습니다.";
  renderStrategyOverview();
  renderTimeframes();
  renderPlan();
  renderChecklist();
  renderMarketData();
}

function renderBitcoin() {
  $b("btcPrice").textContent = money(bitcoinData.price);
  $b("btcChange").textContent = `${bitcoinData.change24h >= 0 ? "+" : ""}${numberText(bitcoinData.change24h, 2)}% 24H`;
  $b("btcChange").className = bitcoinData.change24h >= 0 ? "positive" : "negative";
  $b("btcUpdated").textContent = `${timeText(bitcoinData.updatedAt)} KST`;
  $b("btcMarketStatus").textContent = `${bitcoinData.source} · LIVE`;
  $b("btcCandleTime").textContent = `최근 확정 5분봉 ${timeText(bitcoinData.candleClosedAt)} KST`;
  selectedPlan = currentStrategy().primaryPlan === "SHORT" ? "short" : "long";
  document.querySelectorAll("[data-plan]").forEach((button) => {
    const active = button.dataset.plan === selectedPlan;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderSelectedStrategy();
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
    $b("btcMarketStatus").textContent = "연결 오류";
    $b("btcStatus").textContent = "실시간 분석을 불러오지 못했습니다.";
    $b("btcExecutionRule").textContent = error.message;
    toast("데이터 연결에 실패했습니다. 새로고침으로 다시 시도해 주세요.");
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-plan]").forEach((button) => button.addEventListener("click", () => {
  selectedPlan = button.dataset.plan;
  document.querySelectorAll("[data-plan]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  renderPlan();
  renderMarketData();
}));
document.querySelectorAll("[data-strategy]").forEach((button) => button.addEventListener("click", () => {
  if (!bitcoinData || !strategies()[button.dataset.strategy]) return;
  selectedStrategy = button.dataset.strategy;
  selectedPlan = currentStrategy().primaryPlan === "SHORT" ? "short" : "long";
  document.querySelectorAll("[data-plan]").forEach((item) => {
    const active = item.dataset.plan === selectedPlan;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  renderSelectedStrategy();
}));
$b("bitcoinRefresh").addEventListener("click", () => loadBitcoin(true));
setInterval(() => {
  $b("bitcoinClock").textContent = new Date().toLocaleString("ko-KR", { hour12:false, timeZone:"Asia/Seoul" }) + " KST";
}, 1000);
loadBitcoin();
setInterval(() => loadBitcoin(false), 30_000);
