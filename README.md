# 양방배팅 (Arbitrage Betting)

**x10x10s.com** (10벳) + **Polymarket** 배당 비교 양방 프로그램.

## ★ 추천: 브라우저 확장 프로그램

| 폴더 | 용도 |
|------|------|
| **`extension-legacy/`** | x10x10s + Polymarket 양방 (v4.0) — **추천** |
| `extension/` | 간소화 레거시 (Pinnacle + pbc00) |

```powershell
git fetch origin cursor/x10-polymarket-00df
git reset --hard origin/cursor/x10-polymarket-00df
# edge://extensions → extension-legacy 로드
```

## 연동 사이트

| 사이트 | 역할 | 방식 |
|--------|------|------|
| [x10x10s.com](https://www.x10x10s.com) | 10벳 스포츠북 (BTI) | iframe + content script |
| [polymarket.com](https://polymarket.com) | 예측시장 | Gamma API + content script |

자세한 사용법: [extension-legacy/README.md](extension-legacy/README.md)
