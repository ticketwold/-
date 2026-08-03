# 양방 자동배팅 (TypeScript MV3)

## 구조

```
extension-autobet/
├── src/
│   ├── background/          service_worker.ts
│   ├── shared/
│   │   ├── utils/calculator.ts   ← odds.js 계산 로직 (변경 없음)
│   │   ├── config/sites.ts
│   │   ├── types/
│   │   ├── messaging/       chrome.storage / runtime
│   │   └── dom/             MutationObserver · rAF 스케줄러
│   ├── engine/              탭·슬립·배팅 오케스트레이션
│   ├── content/             사이트별 content script
│   └── panel/               React UI
├── public/manifest.json     MV3 manifest (빌드 시 dist로 복사)
├── dist/                    Chrome에 로드할 빌드 결과
└── package.json
```

## 개발

```bash
cd extension-autobet
npm install
npm run build      # dist/ 생성
npm run dev        # watch 빌드
npm run lint
npm run typecheck
```

## 설치

1. `npm run build`
2. Chrome `chrome://extensions` → **개발자 모드**
3. **압축해제된 확장 프로그램 로드** → `extension-autobet/dist` 폴더 선택

## v3.0.0 변경 요약

- **Manifest V3** · `service_worker.ts` (ES module)
- **TypeScript strict** · ESLint · Prettier
- **React 패널** (기존 UI·기능 100% 유지, `panel-controller` 로직 보존)
- **계산 엔진** → `src/shared/utils/calculator.ts`
- **불필요한 16ms setInterval 제거** → MutationObserver + rAF 스케줄러
- **content script** 사이트별 폴더 분리 (`content/bti`, `content/bc`, `content/stake`)

레거시 JS는 `src/**/*.legacy.ts`에 보존되며, 점진적으로 순수 TS 모듈로 이전할 수 있습니다.
