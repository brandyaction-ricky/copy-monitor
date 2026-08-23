const TERMINAL_STATES = new Set(["ENTRY_READY", "INVALIDATED", "EXPIRED", "NO_TRADE", "NO_CHASE"]);

const STATE_LABELS = {
  SCANNING: "시장 탐색",
  LOCATION_FOUND: "유효 위치 확인",
  LIQUIDITY_TARGET_FOUND: "유동성 목표 확인",
  RAID_DETECTED: "유동성 Raid 감지",
  SWEEP_CONFIRMED: "Sweep·Reclaim 확인",
  WAITING_CISD: "CISD 대기",
  CISD_CONFIRMED: "CISD 확인",
  WAITING_DISPLACEMENT: "Displacement 대기",
  DISPLACEMENT_CONFIRMED: "Displacement 확인",
  INTERNAL_BREAK_CONFIRMED: "Internal Break 확인",
  WAITING_MSS: "MSS 대기",
  MSS_CONFIRMED: "MSS 확인",
  WAITING_RETRACE: "FVG Retrace 대기",
  ENTRY_READY: "진입 조건 충족",
  NO_CHASE: "진입 구간 이탈 · 추격 금지",
  INVALIDATED: "셋업 무효",
  EXPIRED: "셋업 만료",
  NO_TRADE: "거래 제외",
};

function transition(history, to, reason) {
  const from = history.at(-1)?.to || "SCANNING";
  if (from === to || TERMINAL_STATES.has(from)) return;
  history.push({ sequence: history.length + 1, from, to, reason });
}

export function deriveSetupState({ htfPassed, locationPassed, liquidityAvailable, sweep, cisd, linkedCisd, displacement, internalBreak, mss, fvg, retestReady, expired, tradePlan, mode = "BALANCED" }) {
  const history = [];
  if (htfPassed || locationPassed) transition(history, "LOCATION_FOUND", `HTF ${htfPassed ? "일치" : "불일치"} · Location ${locationPassed ? "일치" : "불일치"}`);
  if (liquidityAvailable) transition(history, "LIQUIDITY_TARGET_FOUND", "이미 확인된 유동성 레벨 존재");
  if (sweep) {
    transition(history, "RAID_DETECTED", `${sweep.levelType} ${sweep.state}`);
  }
  if (["CONFIRMED", "RECLAIMED"].includes(sweep?.state)) transition(history, "SWEEP_CONFIRMED", "Raid 후 레벨 종가 회복");
  if (cisd) transition(history, "CISD_CONFIRMED", linkedCisd ? "Sweep 연결 CISD" : "독립 CISD");
  if (displacement) transition(history, "DISPLACEMENT_CONFIRMED", "방향성 Displacement 확인");
  if (internalBreak) transition(history, "INTERNAL_BREAK_CONFIRMED", "Internal Swing 몸통 돌파");
  if (mss) transition(history, "MSS_CONFIRMED", "MSS 확인");
  if (!fvg || fvg.invalidated) return finalize(history, "방향성 FVG 또는 OB 타점 대기");
  transition(history, "WAITING_RETRACE", "Entry FVG 확인");
  if (expired) {
    transition(history, "EXPIRED", "첫 Retrace 유효 시간 초과");
    return finalize(history, "새 셋업 대기");
  }
  if (tradePlan?.noChase) {
    transition(history, "NO_CHASE", `${tradePlan.currentRewardR}R 진행 · 추격 금지`);
    return finalize(history, "FVG/OB 재진입 또는 새 셋업 대기");
  }
  if (!retestReady) return finalize(history, "FVG 첫 Retrace 대기");
  transition(history, "ENTRY_READY", "첫 Retrace가 확정 캔들에서 확인됨");
  return finalize(history, "다음 캔들 시가 또는 확인 후 지정가 실행");
}

function finalize(history, nextCondition) {
  const state = history.at(-1)?.to || "SCANNING";
  return { state, stateLabel: STATE_LABELS[state] || state, nextCondition, history };
}

export function pipelineRows({ htfPassed, locationPassed, liquidityAvailable, sweep, cisd, linkedCisd, displacement, internalBreak, mss, fvg, retestReady, mode }) {
  const row = (key, label, status, detail) => ({ key, label, status, detail });
  return [
    row("htf", "HTF", htfPassed ? "PASS" : "FAIL", htfPassed ? "구조 바이어스 정렬" : "바이어스 불일치"),
    row("location", "Location", locationPassed ? "PASS" : "FAIL", locationPassed ? "Premium/Discount 일치" : "Dealing Range 위치 불일치"),
    row("liquidity", "Liquidity", liquidityAvailable ? "PASS" : "WAIT", liquidityAvailable ? "확정 유동성 존재" : "레벨 대기"),
    row("sweep", "Sweep", ["CONFIRMED", "RECLAIMED"].includes(sweep?.state) ? "PASS" : sweep ? "FAIL" : "WAIT", sweep ? `${sweep.levelType} · ${sweep.state}` : "Raid 대기"),
    row("cisd", "CISD", cisd ? "PASS" : "WAIT", cisd ? (linkedCisd ? `${linkedCisd.barsAfterSweep ?? 0}봉 후 Sweep 연결` : "독립 CISD · 가산점") : "Anchor 돌파 대기"),
    row("displacement", "Displacement", displacement ? "PASS" : "WAIT", displacement ? `${displacement.intrinsicScore}/100` : "변위 대기"),
    row("mss", mode === "AGGRESSIVE" ? "Structure" : mode === "BALANCED" ? "Internal Break" : "MSS", mode === "AGGRESSIVE" ? "OPTIONAL" : mode === "BALANCED" ? (internalBreak ? "PASS" : "WAIT") : (mss ? "PASS" : "WAIT"), mode === "AGGRESSIVE" ? "선택 확인" : mode === "BALANCED" ? (internalBreak?.eventType || "몸통 돌파 대기") : (mss?.eventType || "MSS 대기")),
    row("entry", "FVG Retrace", retestReady ? "PASS" : fvg ? "WAIT" : "WAIT", retestReady ? "첫 Retrace 확인" : fvg ? "첫 Retrace 대기" : "Entry Array 대기"),
  ];
}
