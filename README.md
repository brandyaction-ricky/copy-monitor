# maetajak Master Monitor

마스터 계정의 현재 Gate.io 무기한 선물 포지션만 보여주는 공개 읽기 전용 사이트입니다.

- 주문·포지션 변경·카피 설정·회원 관리 기능 없음
- Supabase `get_public_master_positions` RPC만 호출
- 10초 자동 갱신 및 수동 새로고침

## Vercel 환경 변수

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## 배포 전 데이터 함수

`supabase/202609020004_public_master_positions.sql`을 매타작 운영 Supabase에 적용합니다.
