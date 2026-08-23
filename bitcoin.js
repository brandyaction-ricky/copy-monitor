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

function currentDecisionPlan() {
  const scope = bitcoinData?.decisionEngine?.[selectedStrategy];
  return scope?.plans?.[selectedPlan] || currentStrategy()?.decisionEngine || null;
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
  return direction === "LONG" ? "long" : direction === "SHORT" ? "short" : direction === "NO_TRADE" ? "blocked" : "wait";
}

function renderStrategyOverview() {
  const map = strategies();
  const bind = (key, prefix) => {
    const strategy = map[key];
    if (!strategy) return;
    const badge = $b(`${prefix}Badge`);
    const decision = strategy.decision || strategy.direction;
    badge.textContent = decision === "WAIT" ? "관망" : decision === "NO_TRADE" ? "거래 제외" : decision;
    badge.className = verdictTone(decision);
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

function renderDecisionEngine() {
  const engine = currentDecisionPlan();
  if (!engine) return;
  const decisionTone = engine.decision === "LONG" ? "long" : engine.decision === "SHORT" ? "short" : engine.decision === "NO_TRADE" ? "blocked" : "wait";
  $b("btcEngineModel").textContent = engine.model || "MODEL_1_SWEEP_REVERSAL";
  const executionEnabled = Boolean(bitcoinData?.decisionEngine?.executionEnabled);
  $b("btcEngineMode").textContent = `${engine.mode || "BALANCED"} · ${executionEnabled ? "ACTIVE" : "SHADOW"}`;
  $b("btcEngineDecision").textContent = engine.decision;
  $b("btcEngineDecision").className = decisionTone;
  $b("btcEngineState").textContent = engine.state?.stateLabel || engine.state?.state || "—";
  $b("btcEngineNext").textContent = engine.state?.nextCondition || "—";
  const stats = engine.historicalStats || {};
  $b("btcEngineEdge").textContent = `${stats.status || "N/A"} · 표본 ${stats.sampleSize ?? 0} · ${stats.confidence || "INSUFFICIENT"}`;
  $b("btcEnginePipeline").innerHTML = (engine.pipeline || []).map((item, index) => `
    <article class="${String(item.status || "WAIT").toLowerCase()}">
      <i>${item.status === "PASS" ? "✓" : item.status === "FAIL" ? "×" : item.status === "OPTIONAL" ? "·" : index + 1}</i>
      <div><small>${escapeBtc(item.label)}</small><strong>${escapeBtc(item.detail)}</strong></div>
    </article>`).join("");
  const sweep = engine.sweep;
  const cisd = engine.cisd;
  const displacement = engine.displacement;
  const structure = engine.internalBreak;
  const fvg = engine.fvg;
  const missing = engine.missingConditions?.length ? engine.missingConditions.join(" · ") : "없음";
  $b("btcEngineEvidence").innerHTML = `
    <div><span>HTF / Location</span><strong>${escapeBtc(engine.htf?.bias || "N/A")} · ${escapeBtc(engine.location?.zone || "N/A")}</strong></div>
    <div><span>Sweep</span><strong>${sweep ? `${escapeBtc(sweep.levelType)} · ${escapeBtc(sweep.state)} · ${numberText(sweep.penetrationAtr, 3)} ATR` : "N/A"}</strong></div>
    <div><span>CISD</span><strong>${cisd ? `${cisd.sweepId ? "Sweep 연결" : "독립 감지"} · ${numberText(cisd.closeBeyondAnchorAtr, 3)} ATR` : "N/A"}</strong></div>
    <div><span>Displacement</span><strong>${displacement ? `${displacement.intrinsicScore}/100 · Range ${numberText(displacement.rangeAtr, 2)} ATR` : "N/A"}</strong></div>
    <div><span>Structure / MSS</span><strong>${structure ? escapeBtc(structure.eventType) : "N/A"} / ${engine.mss ? escapeBtc(engine.mss.eventType) : "N/A"}</strong></div>
    <div><span>Entry FVG</span><strong>${fvg ? `${money(fvg.low)}–${money(fvg.high)} · CE ${money(fvg.consequentEncroachment)}` : "N/A"}</strong></div>
    <div class="wide"><span>미충족 Hard Filter</span><strong>${escapeBtc(missing)}</strong></div>
    <div class="wide version"><span>검증 버전</span><strong>${escapeBtc(engine.engineVersion)} · ${escapeBtc(engine.parameterSetVersion)} · 점수는 승률 아님</strong></div>`;
}

function renderPlan() {
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const engine = currentDecisionPlan();
  const tone = plan.direction === "LONG" ? "long" : "short";
  const executionEnabled = Boolean(bitcoinData?.decisionEngine?.executionEnabled);
  const executable = Boolean(executionEnabled && engine?.hardFilterPassed && engine?.state?.state === "ENTRY_READY" && engine?.decision === plan.direction && engine?.tradePlan);
  if (!executable) {
    const missing = !executionEnabled
      ? "SHADOW 검증 중 · Walk-forward 통과 전 운영 실행 비활성"
      : engine?.missingConditions?.length ? engine.missingConditions.join(" · ") : engine?.state?.nextCondition || "검증 조건 대기";
    $b("btcPlanCard").className = `panel btc-plan-card ${tone} locked`;
    $b("btcPlanCard").innerHTML = `
      <div class="btc-plan-hero">
        <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>${escapeBtc(strategy.label)} · MODEL 1 후보</span></div><h3>실행 잠금</h3><p>현재 ${escapeBtc(engine?.decision || "WAIT")} · ${escapeBtc(engine?.state?.stateLabel || "조건 확인 중")} · Setup Score ${engine?.score ?? 0}/100</p></div>
        <strong class="btc-locked-value">조건 충족 전 비활성</strong>
      </div>
      <div class="btc-plan-lock"><b>진입·손절·익절 미표시</b><p>Sweep → CISD → Displacement → ${engine?.mode === "CONSERVATIVE" ? "MSS" : "Internal Break"} → FVG 첫 Retrace → 기존 유동성 TP 2R 이상이 모두 확인된 뒤에만 가격을 활성화합니다.</p></div>
      <section class="btc-confirm-section"><h4>다음 확인 조건</h4><p>${escapeBtc(engine?.state?.nextCondition || "새 셋업 대기")}</p></section>
      <section class="btc-plan-basis"><h4>미충족 Hard Filter</h4><div>${escapeBtc(missing).split(" · ").map((item) => `<span>${item}</span>`).join("")}</div></section>
      <div class="btc-invalidation"><div><small>Historical Edge</small><p>N/A · 표본 0 · Walk-forward 미보정</p></div><div><small>실행 정책</small><p>확정 신호 이후 다음 캔들 시가 또는 확인 후 지정가</p></div></div>`;
    renderExecutionStrip();
    return;
  }
  const modelPlan = engine.tradePlan;
  const targetRows = modelPlan.targets.map((target) => `<article><div><small>${escapeBtc(target.label)} · ${escapeBtc(target.source)}</small><strong>${money(target.price)}</strong></div><b>R:R ${numberText(target.rr, 2)}</b><p>이미 존재하고 확인 가능한 유동성 레벨</p></article>`).join("");
  $b("btcPlanCard").className = `panel btc-plan-card ${tone}`;
  $b("btcPlanCard").innerHTML = `
    <div class="btc-plan-hero">
      <div><div class="btc-plan-labels"><span class="btc-plan-direction ${tone}">${plan.direction}</span><span>${escapeBtc(strategy.label)} · ${escapeBtc(engine.mode)}</span></div><h3>진입 조건 충족</h3><p>Setup Confluence ${engine.score}/100 · Hard Filter 통과 · 승률 아님</p></div>
      <strong>${money(modelPlan.entryZone.low)}<i>—</i>${money(modelPlan.entryZone.high)}</strong>
    </div>
    <div class="btc-plan-level-grid">
      <article><small>FVG CE 지정가</small><strong>${money(modelPlan.entry)}</strong></article>
      <article><small>신호 확정</small><strong>${timeText(engine.generatedAt)}</strong></article>
      <article><small>구조 하드 스탑</small><strong class="negative">${money(modelPlan.stop)}</strong></article>
      <article><small>1차 유동성 목표 · R:R ${numberText(modelPlan.targets[0]?.rr, 2)}</small><strong>${money(modelPlan.targets[0]?.price)}</strong></article>
    </div>
    <section class="btc-confirm-section"><h4>진입 확인 순서</h4><ol>${engine.pipeline.filter((item) => item.status === "PASS").map((item) => `<li>${escapeBtc(item.label)} · ${escapeBtc(item.detail)}</li>`).join("")}</ol></section>
    <section class="btc-plan-basis"><h4>진입 구간 산출 근거</h4><div><span>FVG CE</span><span>Sweep-linked CISD</span><span>Intrinsic Displacement</span><span>기존 유동성 TP</span></div></section>
    <section class="btc-targets"><h4>분할 익절 계획</h4><div>${targetRows}</div></section>
    <div class="btc-invalidation"><div><small>Entry Invalidation</small><p>${money(modelPlan.entryInvalidation)}</p></div><div><small>Model Invalidation</small><p>${money(modelPlan.modelInvalidation)} · 하드 스탑 ${money(modelPlan.stop)}</p></div></div>`;
  renderExecutionStrip();
}

function renderChecklist() {
  const engine = currentDecisionPlan();
  const rows = engine?.pipeline || [];
  const passed = rows.filter((item) => item.status === "PASS").length;
  $b("btcChecklistScore").textContent = `${passed}/${rows.length}`;
  $b("btcChecklist").innerHTML = rows.map((item) => `<div class="${item.status === "PASS" ? "pass" : "fail"}"><i>${item.status === "PASS" ? "✓" : item.status === "FAIL" ? "×" : "—"}</i><span>${escapeBtc(item.label)} · ${escapeBtc(item.detail)}</span></div>`).join("");
}

function renderExecutionStrip() {
  const strategy = currentStrategy();
  const plan = strategy.plans[selectedPlan];
  const engine = currentDecisionPlan();
  const executable = Boolean(bitcoinData?.decisionEngine?.executionEnabled && engine?.hardFilterPassed && engine?.state?.state === "ENTRY_READY" && engine?.decision === plan.direction && engine?.tradePlan);
  const tone = verdictTone(engine?.decision);
  const direction = executable ? `${engine.decision} · 실행 조건 충족` : `${engine?.decision || "WAIT"} · 실행 잠금`;
  $b("btcFlowStrategy").textContent = `${strategy.label} · ${plan.direction}`;
  $b("btcFlowDirection").textContent = direction;
  $b("btcFlowDirection").className = tone;
  $b("btcFlowEntry").textContent = executable ? `${money(engine.tradePlan.entryZone.low)} – ${money(engine.tradePlan.entryZone.high)}` : "— · 잠금";
  $b("btcFlowStop").textContent = executable ? money(engine.tradePlan.stop) : "— · 잠금";
  $b("btcFlowStop").className = "negative";
  $b("btcFlowTarget").textContent = executable ? money(engine.tradePlan.targets[0]?.price) : "— · 잠금";
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
  const decision = strategy.decision || strategy.direction;
  const tone = verdictTone(decision);
  $b("btcStrategyName").textContent = strategy.label;
  $b("btcVerdictBadge").textContent = decision;
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
  $b("btcChecklistHeading").textContent = selectedStrategy === "swing" ? "스윙 의사결정 단계" : "단기 의사결정 단계";
  $b("btcChecklistGuide").textContent = "PASS 단계만 순서대로 인정";
  $b("btcDataGuide").textContent = selectedStrategy === "swing" ? "4시간·일봉·펀딩" : "5분봉·호가·펀딩";
  $b("btcExecutionPrinciple").textContent = selectedStrategy === "swing"
    ? "4H Context와 1H 실행을 분리하고, Sweep·CISD·Displacement·Internal Break·FVG Retrace가 순서대로 확인될 때만 실행합니다. 유동성 TP 기준 최소 2R 미만이면 NO_TRADE입니다."
    : "1H Context와 5m 실행을 분리하고, Sweep·CISD·Displacement·Internal Break·FVG Retrace가 순서대로 확인될 때만 실행합니다. 유동성 TP 기준 최소 2R 미만이면 NO_TRADE입니다.";
  renderStrategyOverview();
  renderTimeframes();
  renderDecisionEngine();
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
  renderDecisionEngine();
  renderPlan();
  renderChecklist();
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
