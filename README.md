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
```

Gate.io 키는 선물 계좌 조회 권한만 허용하고, 출금 권한은 절대 활성화하지 마세요.
대시보드 조회 API는 공개되어 있으므로 배포 주소를 아는 사용자는 잔고·포지션·체결 내역을 볼 수 있습니다.

## 로컬 실행

```bash
npm install
npm run dev
```

## 배포

Vercel에서 이 저장소를 Import한 뒤 위 환경 변수를 설정합니다.
