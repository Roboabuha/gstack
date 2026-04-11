# 방구석 사진관 (PassPro AI)

반려 걱정 없는 증명사진/여권사진 규격 검증 및 보정 서비스입니다. AI 기반의 이미지 변환과 직관적인 반응형 WYSIWYG 에디터를 제공합니다.

## 주요 기능 (Features)

1. **AI 규격 검증 및 분석 (Gemini 2.5 Flash)**
   - 여권/이력서/주민등로증 등 규격에 맞춘 인물 얼굴 인식
   - 8개 주요 조항 검증 (배경, 얼굴 비율, 정면 응시 등)
   - 모범 사진 예시(perfect-passport)를 활용한 정확한 기준점 추론

2. **자동 보정 (Gemini 2.5 Flash Image)**
   - 원클릭 배경 투명화 및 완전한 백색(#FFFFFF) 처리
   - 자연스러운 인물 화사함 보정 및 그림자 제거

3. **정밀 크롭 로직 (Sharp + Pixel Scan)**
   - 배경이 제거된 이미지에서 픽셀 스캔 알고리즘으로 머리카락 최상단을 1px 오차 없이 감지
   - 실제 물리적인 치수 (가로 3.5cm, 세로 4.5cm, 머리 길이 3.2cm, 정수리 여백) 적용을 통한 규격 최적화
   
4. **WYSIWYG 캔버스 에디터 (Next.js Client)**
   - 결과물 화면에서 즉시 이미지 확대/축소 및 색상(명도, 채도, 대비) 슬라이더 컨트롤 기능
   - CSS `filter`를 Canvas `ctx.filter`로 맵핑하여 눈에 보이는 100% 그대로 저장
   - 모바일 접근성을 위한 버튼/터치 타겟 최적화 및 `prefers-reduced-motion` 적용

## Technology Stack

- **Framework**: [Next.js 16.2.2](https://nextjs.org/) (App Router, Turbopack)
- **Image Processing**: [Sharp](https://sharp.pixelplumbing.com/) (Server-side), HTML Canvas API (Client-side)
- **AI Models**: Google GenAI (`gemini-2.5-flash`, `gemini-2.5-flash-image`)
- **Language**: TypeScript

## Getting Started

로컬 개발 환경 설정 방법입니다. 본 프로젝트는 Vercel 배포나 Docker 환경에 최적화되어 있습니다.

### Installation

```bash
# 의존성 설치 (npm 권장)
npm install
```

### Environment Variables

`.env.local` 파일을 루트 경로에 생성하고 올바른 값을 기입하세요.

```env
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here
```

### Running Locally

```bash
# 개발 서버 실행
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 로 접속하여 결과를 확인할 수 있습니다.

## Security & Reliability

- **Image Magic Number Validation**: `heic2any` 및 바이너리 서명 확인으로 안전한 이미지 처리 지원.
- **Middleware Rate Limit**: IP당 분 단위 콜수 제한을 인메모리로 처리, 공격 및 과금 폭탄 방어.
- **Security Headers**: `next.config.ts` 단에서 `X-Frame-Options`, `X-Content-Type-Options` 및 `Permissions-Policy` 등 글로벌 방어 적용.

## Documentation Index

원활한 프로젝트 트래킹 및 파악을 위해 주요 문서를 `docs/` 폴더에 분류하여 일원화하였습니다. 상세한 내용은 아래 문서를 참조하세요:

- 📖 **[개발일지 및 히스토리 (devlog.md)](docs/devlog.md)**: 방구석 사진관의 단계별 기술 트러블슈팅 및 현재 이슈 추적
- 🎨 **[디자인 시스템 가이드 (DESIGN.md)](docs/DESIGN.md)**: UI 무드, 컬러 팔레트, Typography 구조, 이모지 금지 정책 명시
- 🎯 **[프로덕트 로드맵 (ROADMAP.md)](docs/ROADMAP.md)**: 스코프 및 단계별 마일스톤 (MVP, B2C 수익화 모델 준비, B2B 확장 비전)

## License

Copyright © 2026. All rights reserved.
