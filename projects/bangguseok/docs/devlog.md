# 방구석 사진관 (PassPro AI) — 개발일지

> 최종 업데이트: 2026-04-11 KST

---

## 프로젝트 개요

- **서비스명**: 방구석 사진관 (PassPro AI)
- **목적**: 스마트폰 사진을 업로드하면 AI가 여권/증명사진 규격(3.5×4.5cm)으로 크롭 및 배경 제거 후 WYSIWYG 에디터를 통한 보정 제공
- **스택**: Next.js 16 + TypeScript + Sharp + Google Gemini API
- **배포**: 호스팅 환경 이관 / Vercel 배포 (진행 준비)

---

## 시스템 파이프라인 (2026-04 개선판)

```
[클라이언트 업로드]
  ↓ (Magic Number + 확장자 검증, Rate Limiter)
[Step 1] Gemini 2.5 Flash: 여권 8개 주요 조항 검증 + 얼굴 위치/비율 확인 
  ↓ (prompt injection 방어)
[Step 2] Gemini 2.5 Flash Image: 원본 사진의 배경 백색화(#FFFFFF) 및 자동 보정
  ↓
[Step 3] 픽셀 스캔 및 Sharp 로직: 백색으로 깨끗해진 이미지 기준으로 머리 최상단 픽셀 추적
  ↓
[Step 4] Sharp 크롭 파이프라인: cm 단위를 활용해 오차 없는 사진 절삭 (3.5cm x 4.5cm 기준)
  ↓
[Step 5] 클라이언트 반환 후 WYSIWYG 에디터 진입 (캔버스 상에서 직접 확대, 색상 보정 후 렌더)
```

---

## 🚀 최신 마일스톤 완료 사항 (2026-04-10 ~ 04-11)

### 1. WYSIWYG 통합 에디터 개편 (`/design-review` 적용)
- 기존에는 크기가 고정된 후 수동으로 가로/세로를 조작하는 불편한 2단계(확정 이전/이후) 폼 형태.
- **해결**: UI 상에서 "위치 조절" 및 "확정"의 개념을 제거하고, 즉시 **"확대(Zoom), 명도, 채도, 대비"**의 4가지 파라미터만 조정해 다운로드할 수 있도록 React Canvas Draw 기반으로 마이그레이션 적용. 위치 이동은 Viewport 드래그 앤 드롭으로 처리.
- **접근성 (A11y)**: Focus Ring (`:focus-visible`) 및 슬라이더 터치 범위 기준점(Touch Target 28px) 확보. 모바일 환경 최적화 완료.

### 2. 보안 인프라 포스쳐 강화 (`/cso` 보안 감사 적용)
- **IP Rate Limit 중복 이슈 해결**: `middleware.ts`(10회)와 `route.ts` 하위의 레이트 리미터(5회)가 중복으로 돌아가 메모리를 낭비하던 로직을 미들웨어로 단일화 처리함.
- **IP Spoofing 및 우회 차단**: `X-Forwarded-For`를 우회할 수 없도록 역방향(`.pop()`) 로직을 통해 실제 클라이언트 IP 추출 구조로 변경.
- **Security Headers 적용**: `next.config.ts`에 클릭재킹 및 MIME Sniffing 방어, referrer 유출 방지를 위한 보안 헤더 추가. OWASP A05 방어 확보.

### 3. 다운로드 버튼 직관성 개선
- Emoji 사용을 자제하고 브랜드 감도에 맞는 모던한 형태의 폰트 및 스타일 적용.

---

## 핵심 파일 아키텍처

| 파일 | 역할 |
|------|------|
| `src/middleware.ts` | Edge 기반 방어 체계 (IP Rate Limiting) |
| `src/app/api/validate/route.ts` | API 엔드포인트 / 전체 AI 오케스트레이션 |
| `src/lib/gemini.ts` | Gemini 연동 / System Prompt 관리 |
| `src/lib/crop.ts` | Sharp 기반 이미지 크롭 역학 및 픽셀 스캔 엔진 |
| `src/lib/photo-specs.ts` | 여권, 이력서, 주석 등 표준 규격 상수 (mm/cm) |
| `src/app/page.tsx` | Main Client 컴포넌트 — WYSIWYG 에디터 및 UI 렌더링 |
| `next.config.ts` | 런타임 헤더 및 보안 설정 |

---

## 다음 단계 (Next Steps)

1. **사용성 트래킹 / 모니터링 연동** (필요시 PostHog / Google Analytics 확장성 검토)
2. **배포 (SHIP)**: Local Host 검증 완료 및 QA 자동화 확인 됨에 따라 운영 환경으로 릴리즈 진행
3. **유료화 / 전환율(Conversion) 설계**: 향후 '무료 서비스'라는 한정성을 활용해 고도화(모바일결제 등) 진행 시 모델 교체 예상.
