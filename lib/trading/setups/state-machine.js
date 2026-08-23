const TERMINAL_STATES = new Set(["ENTRY_READY", "INVALIDATED", "EXPIRED", "NO_TRADE"]);

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
  INVALIDATED: "셋업 무효",
  EXPIRED: "셋업 만료",
  NO_TRADE: "거래 제외",
};

function transition(history, to, reason) {
  const from = history.at(-1)?.to || "SCANNING";
  if (from === to || TERMINAL_STATES.has(from)) return;
  history.push({ sequence: history.length + 1, from, to, reason });
}

export function deriveSetupState({ htfPassed, locationPassed, liquidityAvailable, sweep, linkedCisd, displacement, internalBreak, mss, fvg, retestReady, expired, mode = "BALANCED" }) {
  const history = [];
  if (!htfPassed || !locationPassed) {
    transition(history, "NO_TRADE", !htfPassed ? "HTF 바이어스 불일치" : "의미 있는 Premium/Discount 위치 아님");
  } else {
    transition(history, "LOCATION_FOUND", "HTF Context와 Dealing Range 위치 일치");
    if (liquidityAvailable) transition(history, "LIQUIDITY_TARGET_FOUND", "이미 확인된 유동성 레벨 존재");
    if (!liquidityAvailable) return finalize(history, "유동성 레벨 형성 대기");
    if (!sweep) return finalize(history, "유동성 Raid 대기");
    transition(history, "RAID_DETECTED", `${sweep.levelType} ${sweep.state}`);
    if (["BREAKOUT", "FAILED"].includes(sweep.state)) {
      transition(history, "INVALIDATED", sweep.state === "BREAKOUT" ? "Sweep가 아니라 Breakout으로 확인" : "Reclaim 실패");
      return finalize(history, "새 유동성 셋업 대기");
    }
    if (!["CONFIRMED", "RECLAIMED"].includes(sweep.state)) return finalize(history, "Reclaim 종가 확인 대기");
    transition(history, "SWEEP_CONFIRMED", "Raid 후 레벨 종가 회복");
    if (!linkedCisd) {
      transition(history, "WAITING_CISD", "Sweep에 연결된 CISD 없음");
      return finalize(history, "CISD Anchor 종가 돌파 대기");
    }
    transition(history, "CISD_CONFIRMED", "가격 전달 상태 변화 확인");
    if (!displacement) {
      transition(history, "WAITING_DISPLACEMENT", "CISD 후 변위 없음");
      return finalize(history, "방향성 Displacement 대기");
    }
    transition(history, "DISPLACEMENT_CONFIRMED", "Intrinsic Displacement 기준 충족");
    if (mode !== "AGGRESSIVE") {
      if (!internalBreak) {
        transition(history, "WAITING_MSS", "Internal Structure Break 없음");
        return finalize(history, "Internal Swing 몸통 돌파 대기");
      }
      transition(history, "INTERNAL_BREAK_CONFIRMED", "Displacement 후 Internal Swing 돌파");
    }
    if (mode === "CONSERVATIVE") {
      if (!mss) {
        transition(history, "WAITING_MSS", "Conservative Mode의 MSS 없음");
        return finalize(history, "Confirmed Internal/External MSS 대기");
      }
      transition(history, "MSS_CONFIRMED", "Conservative MSS 확인");
    }
    if (!fvg || fvg.invalidated) return finalize(history, "Displacement FVG 생성 대기");
    transition(history, "WAITING_RETRACE", "Entry FVG 확인");
    if (expired) {
      transition(history, "EXPIRED", "첫 Retrace 유효 시간 초과");
      return finalize(history, "새 셋업 대기");
    }
    if (!retestReady) return finalize(history, "FVG 첫 Retrace 대기");
    transition(history, "ENTRY_READY", "첫 Retrace가 확정 캔들에서 확인됨");
  }
  return finalize(history, history.at(-1)?.to === "ENTRY_READY" ? "다음 캔들 시가 또는 확인 후 지정가 실행" : "새 셋업 대기");
}

function finalize(history, nextCondition) {
  const state = history.at(-1)?.to || "SCANNING";
  return { state, stateLabel: STATE_LABELS[state] || state, nextCondition, history };
}

export function pipelineRows({ htfPassed, locationPassed, liquidityAvailable, sweep, linkedCisd, displacement, internalBreak, mss, fvg, retestReady, mode }) {
  const row = (key, label, status, detail) => ({ key, label, status, detail });
  return [
    row("htf", "HTF", htfPassed ? "PASS" : "FAIL", htfPassed ? "구조 바이어스 정렬" : "바이어스 불일치"),
    row("location", "Location", locationPassed ? "PASS" : "FAIL", locationPassed ? "Premium/Discount 일치" : "Dealing Range 위치 불일치"),
    row("liquidity", "Liquidity", liquidityAvailable ? "PASS" : "WAIT", liquidityAvailable ? "확정 유동성 존재" : "레벨 대기"),
    row("sweep", "Sweep", ["CONFIRMED", "RECLAIMED"].includes(sweep?.state) ? "PASS" : sweep ? "FAIL" : "WAIT", sweep ? `${sweep.levelType} · ${sweep.state}` : "Raid 대기"),
    row("cisd", "CISD", linkedCisd ? "PASS" : "WAIT", linkedCisd ? `${linkedCisd.barsAfterSweep ?? 0}봉 후 확인` : "Anchor 돌파 대기"),
    row("displacement", "Displacement", displacement ? "PASS" : "WAIT", displacement ? `${displacement.intrinsicScore}/100` : "변위 대기"),
    row("mss", mode === "AGGRESSIVE" ? "Structure" : mode === "BALANCED" ? "Internal Break" : "MSS", mode === "AGGRESSIVE" ? "OPTIONAL" : mode === "BALANCED" ? (internalBreak ? "PASS" : "WAIT") : (mss ? "PASS" : "WAIT"), mode === "AGGRESSIVE" ? "선택 확인" : mode === "BALANCED" ? (internalBreak?.eventType || "몸통 돌파 대기") : (mss?.eventType || "MSS 대기")),
    row("entry", "FVG Retrace", retestReady ? "PASS" : fvg ? "WAIT" : "WAIT", retestReady ? "첫 Retrace 확인" : fvg ? "첫 Retrace 대기" : "Entry Array 대기"),
  ];
}
