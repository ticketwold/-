# 양방 확장 v4.0 — x10x10s + Polymarket

**x10x10s.com** (10벳 스포츠) + **polymarket.com** 양방 서치 및 슬립 비교.

## Edge/Chrome 설치

1. `edge://extensions` → **개발자 모드**
2. **압축해제된 확장 프로그램 로드** → `extension-legacy` 폴더
3. 업데이트:
```powershell
git fetch origin cursor/x10-polymarket-00df
git reset --hard origin/cursor/x10-polymarket-00df
```
4. 확장 **새로고침** → 버전 **4.0.0** 확인

## 사용 순서

1. **www.x10x10s.com** 로그인
2. **10벳 스포츠** 화면 열기 (BTI 배당이 보이는 상태, `gamecode=19` 등)
3. **polymarket.com** 탭 열기 (베팅할 마켓 선택)
4. 확장 팝업 → 서치 모드 **「10x10 + Polymarket」** → **서치 시작**

## 서치 모드

| 모드 | 설명 |
|------|------|
| **10x10 + Polymarket** (기본) | x10x10s BTI 배당 vs Polymarket Gamma API |
| 피나클 + BTI (레거시) | 기존 pbc00/피나클 방식 |

## 슬립 비교

- **10벳(BTI)**: x10x10s iframe 슬립
- **Polymarket**: polymarket.com 거래 패널 슬립

## 문제 해결

| 증상 | 확인 |
|------|------|
| BTI 0건 | x10x10s 로그인 + 스포츠 배당 화면 |
| Polymarket 0건 | 인터넷 연결 / Gamma API 차단 여부 |
| 매칭 0건 | 팀명이 다른 경우 수동 매칭(프리매치 탭) |

## 주요 파일

- `sites_config.js` — x10x10s / polymarket 도메인 설정
- `polymarket_content.js` — Polymarket 슬립/베팅
- `bti_content.js` — 10벳(BTI) 슬립/베팅
- `background.js` — 양방 서치 (Polymarket Gamma API)
