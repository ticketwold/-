# 양방 배팅 시스템

## 현재 개발 방향: 데스크톱 앱 (`arb-desktop/`)

Chrome 확장프로그램 대신 **Python 데스크톱 전용 프로그램**으로 재설계 중입니다.

- **WebSocket/Network API** → **Playwright DOM** → **OCR** 다중 감지 파이프라인
- 목표: 배당 변화 감지 ~ 계산 완료 **50ms 이하**
- PyQt6 대시보드 + Playwright 브라우저 세션

```bash
cd arb-desktop
pip install -e .
playwright install chromium
python main.py
```

자세한 내용: [arb-desktop/README.md](arb-desktop/README.md)

## 레거시 (참고용)

| 디렉터리 | 설명 |
|----------|------|
| `extension-legacy/` | Chrome 확장 v5.9.x (유지보수 중단 예정) |
| `arb-scanner/` | TypeScript MV3 리빌드 프로토타입 |
