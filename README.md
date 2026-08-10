# tooja

GateScope 기반 Gate.io 무기한 선물 포지션 대시보드입니다.

## 현재 상태

- Vercel 배포본의 프런트엔드 복구
- Gate.io 읽기 전용 API 구조 준비
- API 키와 계좌 데이터는 저장소에 포함하지 않음
- 실제 주문 실행 기능은 포함하지 않음

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
