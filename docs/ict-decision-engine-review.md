# ICT Trading Decision Engine Architecture / DB 검수

## 결론

**수정 후 승인**한다. 제안된 방향은 ICT 개념을 단일 매수·매도 신호로 뭉개지 않고 `Feature → Setup State → Decision → Risk → Result`로 분리한다는 점에서 타당하다. 다만 현재 사이트에는 DB가 없고, 기존 엔진은 요청 시점의 Gate.io 캔들로 즉시 계산하는 구조이므로 v2를 곧바로 기존 신호와 교체하면 검증되지 않은 규칙이 운영 판단을 바꾸게 된다.

따라서 이번 설계는 독립된 `ict_v2` 스키마와 **shadow run**으로 먼저 도입하고, 재현성·look-ahead 방지·수수료/슬리피지 포함 백테스트가 통과된 뒤 운영 의사결정기로 승격한다.

## 검수 결과

| 구분 | 판정 | 검수 내용 |
|---|---|---|
| Feature Detector / Decision 분리 | 승인 | 탐지기는 방향 Feature만 만들고 LONG·SHORT 판단은 Decision 계층에서만 수행한다. |
| Sweep·CISD·Displacement·MSS 분리 | 승인 | 서로 다른 이벤트와 테이블로 저장한다. `CISD ≠ MSS`를 데이터 모델에서도 강제한다. |
| Closed candle 판정 | 승인 | Phase 1 운영 판단은 닫힌 캔들만 사용한다. Intrabar는 별도 모델/파라미터 세트가 생길 때까지 제외한다. |
| `detectedAt` / `confirmedAt` | 수정 승인 | Candidate는 아직 확정되지 않았으므로 `confirmed_at`은 nullable이다. CONFIRMED 상태에는 반드시 값이 있어야 한다. |
| Fractal swing | 승인 | Pivot 시점과 우측 봉 이후 실제 확인 시점을 분리한다. Break 시점 이전에 확인된 Swing만 사용할 수 있다. |
| ATR 정규화 | 수정 승인 | ATR은 원본 캔들 컬럼이 아니라 버전이 붙은 `candle_indicators`에 저장한다. 파라미터 변경 시 과거 원본을 오염시키지 않는다. |
| Setup state machine | 수정 승인 | 상태는 단조 전진시키고 모든 전이를 append-only history로 기록한다. 허용 전이는 Entry Mode에 따라 달라 DB 고정 규칙보다 애플리케이션 transition map으로 검증한다. |
| `WAIT` / `NO_TRADE` | 수정 승인 | Decision과 Setup State를 분리한다. WAIT·NO_TRADE는 오류가 아니라 정상적인 의사결정 결과다. |
| Setup Score | 수정 승인 | 0~100 점수는 승률이 아니라 설명 가능한 컨플루언스 점수다. 구성 점수와 당시 Feature snapshot을 함께 보존한다. |
| 최소 R:R | 수정 승인 | 명세 기본값은 2.0으로 두되 timeframe/mode별 Parameter Set으로 관리한다. 운영 절대 하한은 1.5이며 DB가 그 미만 계획을 거절한다. |
| 기대값/백테스트 | 승인 | 승률 단독 최적화를 금지하고 Expectancy, PF, Average/Median R, MDD, MFE/MAE, 표본 수를 저장한다. |
| OB | 보류 | 단순 반대색 캔들 탐지를 OB로 확정하지 않는다. Liquidity + Displacement + Structure 연결 검증 후 Phase 2에서 활성화한다. DB 타입만 수용한다. |
| SMT·BPR·Breaker·Session | 보류 | 비교 자산과 시간대 정의, 별도 검증 데이터가 없으므로 운영 필터에는 아직 사용하지 않는다. 스키마는 향후 확장을 막지 않는다. |
| 자동매매 | 보류 | 현재 범위는 분석·의사결정 지원이다. 주문 실행은 walk-forward 및 paper trading 통과 이후 별도 승인 대상이다. |

## 설계 충돌과 해소 방법

### 1. 현재 엔진과 v2의 역할

현재 `api/_ict-engine.js`와 `api/bitcoin.js`는 실시간 응답을 만드는 in-memory 엔진이다. v2 DB는 이 코드를 즉시 대체하는 저장소가 아니라, 동일한 닫힌 캔들에 대해 Feature와 상태 변화를 재현하고 비교하기 위한 검증 계층이다.

도입 순서는 다음과 같다.

1. 기존 응답은 그대로 사용자에게 제공한다.
2. 같은 closed candle을 v2 엔진에도 입력하되 결과는 `SHADOW`로 저장한다.
3. Overlay 수동 검수와 단위 테스트로 detector 정확도를 확인한다.
4. 동일 데이터의 in-sample / out-of-sample / walk-forward 결과를 비교한다.
5. 충분한 표본에서 Expectancy·Drawdown 기준을 통과한 Parameter Set만 `ACTIVE`로 전환한다.

### 2. 시간과 look-ahead

모든 Feature와 Setup에는 다음 의미를 고정한다.

- `detected_at`: 패턴 후보가 처음 관찰된 시각
- `confirmed_at`: 규칙상 확정되어 의사결정에 사용할 수 있게 된 시각
- `as_of_time`: 해당 행을 계산할 때 사용한 데이터의 최대 시각
- `pivot_time`: Swing이 실제로 위치한 과거 봉 시각

백테스트와 실시간 엔진은 `confirmed_at <= decision.as_of_time`인 Feature만 읽는다. FVG는 세 번째 봉이 닫힌 뒤, MSS/CISD는 돌파 종가가 닫힌 뒤에만 확정한다. HTF도 진행 중 봉을 사용하지 않는다.

### 3. CISD와 MSS

CISD는 delivery anchor 종가 돌파라는 초기 상태 변화이고, MSS는 이후 확인된 internal swing의 몸통 돌파다. `cisd_events`와 `structure_events(event_type='MSS')`를 분리하고 MSS에서 선행 CISD와 Displacement를 참조한다. 이 구조로 다음 실패도 삭제하지 않고 학습 데이터로 남길 수 있다.

- Sweep → CISD → 만료
- Sweep → CISD → Displacement → MSS 없음
- CISD without valid Sweep
- Sweep → MSS → Win/Fail

### 4. 원본과 파생값

`market_candles`는 거래소 OHLCV 원본으로 취급한다. ATR, Feature, 점수처럼 알고리즘·파라미터에 따라 바뀌는 값은 원본에 덮어쓰지 않고 `algorithm_version + parameter_set_id`와 함께 별도 저장한다. 동일 데이터와 동일 버전의 재실행은 같은 `idempotency_key`를 사용한다.

### 5. 상태와 의사결정

`setup_state`는 현재 진행 단계, `decision`은 지금 사용자가 취할 행동이다. 예를 들어 상태가 `CISD_CONFIRMED`여도 Decision은 `WAIT`일 수 있다. `NO_TRADE`는 Hard Filter 실패나 RR 부족을 나타내며, 단순히 점수가 낮다는 이유만으로 LONG/SHORT를 생성하지 않는다.

## DB 운영 원칙

### Shadow run

- 새 모델과 Parameter Set은 `DRAFT → SHADOW → ACTIVE → RETIRED` 순서로 관리한다.
- 한 모델에는 동시에 하나의 ACTIVE 버전만 허용한다.
- SHADOW 결과는 화면의 운영 타점에 영향을 주지 않는다.
- 운영 승격 조건은 코드 리뷰, detector unit test, overlay 검수, 수수료·슬리피지 포함 walk-forward 성과를 모두 통과하는 것이다.
- 기존/신규 엔진의 불일치는 정상적인 관찰 대상이며 불리한 결과도 삭제하지 않는다.

### Idempotency

- Candle 자연키는 `(exchange, symbol, timeframe, open_time)`이다.
- Feature, Setup, State Transition, Snapshot, Trade, Backtest Run에는 producer가 결정론적 `idempotency_key` 또는 `run_key`를 부여한다.
- 권장 키 구성은 `algorithmVersion|parameterChecksum|exchange|symbol|timeframe|eventType|sourceCloseTime|eventIdentity`의 SHA-256이다.
- 재시도는 insert 중복 생성이 아니라 기존 행과 동일한 결과인지 확인해야 한다. 내용이 달라지면 기존 행을 덮어쓰지 말고 새 algorithm/parameter version을 발행한다.

### As-of 규칙

- Feature가 참조하는 Candle은 `is_closed = true`이고 `close_time <= as_of_time`이어야 한다.
- Swing은 `confirmed_at <= as_of_time`일 때만 유효하다.
- Candidate의 `confirmed_at`은 NULL이며 CONFIRMED 상태에서는 NULL일 수 없다.
- State Transition과 Snapshot은 당시의 `as_of_time`으로 append-only 저장한다.
- Backtest 실행 정책, 동일 봉 SL/TP 충돌 처리, execution delay를 각 `backtest_runs`에 고정해 결과 재현성을 보장한다.

### RLS와 접근 경계

- 모든 `ict_v2` 테이블에 RLS를 활성화하고 클라이언트 정책은 만들지 않았다. 기본값은 anon/authenticated 접근 거부다.
- Vercel 백엔드의 신뢰된 서버 경로만 DB 소유자 또는 Supabase service role로 읽고 쓴다. Service key를 브라우저로 전달하지 않는다.
- 사용자별 포트폴리오·계좌 데이터가 추가되기 전까지 분석 시장 데이터는 backend-only다.
- 향후 다중 사용자 기능을 붙일 때 `owner_user_id`/`organization_id`를 도입하고, 그때 사용자 SELECT 정책을 별도 migration으로 추가한다.

## Migration 범위

`db/migrations/001_ict_decision_engine_v2.sql`은 기존 테이블을 수정하지 않고 독립된 `ict_v2` 스키마에 다음을 추가한다.

- 원본: `market_candles`
- 버전 파생값: `candle_indicators`, `market_features`
- Feature: `swings`, `liquidity_levels`, `sweeps`, `cisd_events`, `displacements`, `structure_events`, `pd_arrays`
- 의사결정: `trading_setups`, `setup_state_history`, `setup_feature_snapshots`, `trade_plans`, `trade_plan_targets`
- 버전 관리: `model_versions`, `parameter_sets`
- 검증: `backtest_runs`, `trades`, `backtest_results`

Migration 자체는 additive이고 반복 실행 가능한 DDL로 구성했다. 다만 실제 운영 DB 적용 전에는 Supabase의 별도 preview branch에서 한 번 실행하고, 예상 권한·인덱스·PostgREST schema exposure를 확인해야 한다.

## 승인된 Phase 1 범위

Phase 1은 `MODEL_1_SWEEP_REVERSAL` 하나로 제한한다.

```text
Closed Candle → ATR → Confirmed Swing → Liquidity → Raid/Reclaim
→ Delivery → CISD → Displacement → MSS → FVG → Retrace
→ Structural Invalidation → Liquidity Target → RR → WAIT/NO_TRADE/LONG/SHORT
```

운영 화면에는 타점보다 아래 항목을 우선 표시한다.

- 현재 Decision과 Setup State
- HTF Context / Location / Liquidity
- Sweep 상태와 penetration ATR
- CISD / Displacement / MSS의 독립 상태
- Entry Array와 다음 확인 조건
- 구조적 무효화·유동성 목표·R:R
- 사용 중인 algorithm/parameter version
- Historical edge의 표본 수와 confidence

이 조건을 충족하면 붙여넣은 Architecture와 DB 설계는 구현을 시작해도 된다. 다만 SHADOW 검증 없이 기존 운영 신호를 교체하거나 자동 주문에 연결하는 것은 승인 범위가 아니다.
