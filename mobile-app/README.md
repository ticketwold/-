# 양방 베팅 봇 — 모바일 (Android)

Chrome 확장 프로그램(`extension-legacy`)을 **Android 앱**으로 포팅한 버전입니다.

## 기능

- **봇 탭**: 라이브 서치 + 슬립 비교 + 자동 베팅 (PC 확장과 동일 로직)
- **텐텐뱃 탭**: x10x10s WebView (로그인·슬립·베팅)
- **Poly 탭**: Polymarket WebView (outcome 선택·Buy·캐시 잔액 베팅)

## 빌드 방법 (Android Studio)

### 1. 요구사항

- Android Studio Hedgehog 이상
- JDK 17
- Android SDK 34

### 2. 프로젝트 열기

```
mobile-app/android/
```

Android Studio에서 **Open** → `mobile-app/android` 폴더 선택

### 3. APK 빌드

- **Build → Build Bundle(s) / APK(s) → Build APK(s)**
- 또는 터미널:

```bash
cd mobile-app/android
./gradlew assembleDebug
```

APK 위치: `android/app/build/outputs/apk/debug/app-debug.apk`

### 4. 실기기 설치

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

> Google Play 미배포 — **직접 APK 설치** (출처 알 수 없는 앱 허용 필요)

## 사용 방법

1. 앱 실행 → 하단 **텐텐뱃** 탭 → 로그인 → 경기/슬립 선택
2. 하단 **Poly** 탭 → `/event/` 페이지 → outcome 선택 + Buy 탭 + 금액 입력
3. 하단 **봇** 탭 → 슬립 비교 확인 → **봇 시작**

### 라이브 서치

1. 텐텐뱃·Poly 탭에서 각각 로그인
2. 봇 탭 → **서치 시작**
3. Polymarket API + 텐텐뱃 API(로그인 세션)로 양방 기회 검색

## 구조

```
mobile-app/
├── www/                    # 웹 UI (봇 패널)
│   ├── index.html
│   ├── js/app.js           # 봇 로직 (popup.js 포팅)
│   ├── js/bridge.js        # Android WebView 브릿지
│   └── inject/             # 사이트 주입 스크립트
└── android/                # Android Studio 프로젝트
    └── app/src/main/
        ├── assets/www/     # www 복사본
        └── java/.../MainActivity.kt
```

## PC 확장 vs 모바일

| 항목 | PC 확장 | 모바일 |
|------|---------|--------|
| UI | Chrome 패널 | 앱 내 봇 탭 |
| 사이트 | 브라우저 탭 | 앱 내 WebView |
| BTI iframe | 모든 프레임 주입 | 메인 프레임 주입 (iframe 제한 가능) |
| Polymarket 베팅 | MAIN world 클릭 | 동일 (WebView JS 주입) |

## 알려진 제한

- 텐텐뱃 BTI가 **cross-origin iframe** 안에 있으면 PC 확장보다 배당 읽기/베팅이 불안정할 수 있음
- iOS 버전은 미포함 (Android 우선)
- 앱스토어 배포 설정(서명 키 등)은 포함되지 않음

## 버전

- **v1.0.0** — Android WebView 3탭 (봇 / 텐텐뱃 / Poly)
