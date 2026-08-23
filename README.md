# tooja

GateScope 기반 Gate.io 무기한 선물 포지션 대시보드입니다.

## 현재 상태

- Vercel 배포본의 프런트엔드 복구
- Gate.io 읽기 전용 API 구조 준비
- API 키와 계좌 데이터는 저장소에 포함하지 않음
- 실제 주문 실행 기능은 포함하지 않음
- ICT Decision Engine v2를 기존 엔진과 병렬 Shadow 판단으로 운영 (`ICT_V2_LIFECYCLE=SHADOW` 기본)
- `MODEL_1_SWEEP_REVERSAL`: HTF → Location → Liquidity → Sweep → CISD → Displacement → Internal Break → FVG Retrace
- Hard Filter 통과 전에는 주문 실행 가격을 잠그고, candidatePlan의 Entry·SL·TP는 주문 불가 분석 후보 점선으로만 표시
- Historical Edge는 Walk-forward 백테스트 전까지 `N/A`로 표시
- `ACTIVE` 승격 전에는 v2 조건이 모두 충족되어도 주문 실행과 실선 실행 가격은 잠금
- TradingView Lightweight Charts 5.2.1로 Gate.io BTC_USDT 5m·15m·1h·4h 캔들을 시각화
- Gate.io Public WebSocket은 진행 중 캔들만 갱신하고, 엔진 판단은 확정봉에서만 갱신

## ICT Decision Engine v2

설계 검수 결론은 `수정 후 승인`입니다. 현재 운영 코드를 즉시 교체하지 않고 v2 판단을 병렬 계산합니다.

- 확정 캔들만 사용하며 Feature마다 `detectedAt`과 `confirmedAt`을 분리합니다.
- CISD, Displacement, Internal Break, MSS는 서로 다른 Feature입니다.
- `WAIT`와 `NO_TRADE`는 정상 출력입니다.
- 유동성 목표로 기본 2R을 만들지 못하면 합성 목표 가격을 생성하지 않습니다.
- Setup Score는 컨플루언스 설명값이며 승률이 아닙니다.
- 운영 DB는 아직 연결하지 않았습니다. 검수된 additive schema는 `db/migrations/001_ict_decision_engine_v2.sql`에 있으며 Supabase Preview Branch 검증 후 별도 승인이 필요합니다.

상세 검수 결과는 `docs/ict-decision-engine-review.md`를 참고하세요.

## 실시간 트레이딩 차트

- 과거·확정 캔들: `/api/bitcoin`의 `chart.timeframes` 스냅샷
- 진행 중 캔들: 브라우저의 Gate.io Public WebSocket 읽기 전용 구독
- 실행 오버레이: 엔진의 `executionTimeframe`과 현재 차트 시간대가 같을 때만 표시
- `SHADOW`: 유동성·Sweep·CISD·Displacement·구조·FVG 근거와 candidatePlan의 Entry·SL·TP를 점선으로 표시. 모두 분석 후보이며 주문 불가
- `ACTIVE`: Hard Filter와 `ENTRY_READY`를 모두 통과한 tradePlan의 Entry·SL·TP만 실선 실행 가격으로 표시

차트 라이브러리는 `vendor/lightweight-charts`에 버전·라이선스·고지와 함께 고정되어 있습니다. 실제 주문을 생성하거나 변경하는 코드는 포함하지 않습니다.

## 환경 변수

```bash
GATE_API_KEY=
GATE_API_SECRET=
FMP_API_KEY=
```

Gate.io 키는 선물 계좌 조회 권한만 허용하고, 출금 권한은 절대 활성화하지 마세요.
대시보드 조회 API는 공개되어 있으므로 배포 주소를 아는 사용자는 잔고·포지션·체결 내역을 볼 수 있습니다.

`FMP_API_KEY`는 종목별 실적 일정, EPS·매출 컨센서스와 실제 발표값을 불러오는 서버 전용 키입니다. 브라우저 응답과 저장소에는 키가 포함되지 않습니다. 키가 없거나 공급자 응답이 실패하면 신규 진입 추천을 판단 보류로 제한합니다.

## 실제 데이터 출처

- 코인 가격·캔들·펀딩: Gate.io API v4
- 미국주식 일봉·거래량: Yahoo Finance chart
- CPI·실업률·비농업 고용: U.S. Bureau of Labor Statistics API
- CPI·PPI·고용 발표 일정: BLS 공식 캘린더
- 2년·10년 국채금리: U.S. Department of the Treasury
- FOMC 일정: Federal Reserve
- 실적 일정·EPS/매출 컨센서스·발표값: Financial Modeling Prep

주식 추천은 실적 72시간 전 또는 중요 매크로 24시간 전이면 차단되며, 중요 매크로 72시간 전부터 점수가 제한됩니다.

## 로컬 실행

```bash
npm install
npm run dev
```

## 배포

Vercel에서 이 저장소를 Import한 뒤 위 환경 변수를 설정합니다.
