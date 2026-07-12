@echo off
chcp 65001 >nul
echo ============================================
echo   양방배팅 프로그램 - Windows 전체 설치
echo ============================================
echo.

cd /d "%~dp0.."
echo [현재 폴더] %CD%
echo.

REM Python 확인
python --version >nul 2>&1
if errorlevel 1 (
  echo [오류] Python이 설치되지 않았습니다.
  echo https://www.python.org/downloads/ 에서 설치하세요.
  echo 설치 시 "Add python.exe to PATH" 를 체크하세요.
  pause
  exit /b 1
)
echo [OK] Python 설치됨
python --version

REM 가상환경
if not exist "venv" (
  echo.
  echo [1/5] 가상환경 생성 중...
  python -m venv venv
)
echo [OK] 가상환경 준비됨

echo.
echo [2/5] 가상환경 활성화...
call venv\Scripts\activate.bat

echo.
echo [3/5] 패키지 설치 중...
python -m pip install --upgrade pip -q
pip install -r requirements.txt -q
pip install -r requirements-dev.txt -q
echo [OK] 패키지 설치 완료

echo.
echo [4/5] Playwright Chromium 설치 중...
playwright install chromium
echo [OK] 브라우저 설치 완료

echo.
echo [5/5] 설정 파일 생성...
if not exist "config\settings.yaml" (
  copy "config\settings.yaml.example" "config\settings.yaml"
  echo [OK] config\settings.yaml 생성됨
) else (
  echo [건너뜀] config\settings.yaml 이미 존재
)

echo.
echo ============================================
echo   설치 완료!
echo ============================================
echo.
echo 다음 단계:
echo   1. config\settings.yaml 에 pbc00 아이디/비밀번호 입력
echo      notepad config\settings.yaml
echo.
echo   2. 연결 테스트
echo      venv\Scripts\activate.bat
echo      python -m src.main pinnacle --sport football --limit 5
echo.
echo   3. 실제 가상배팅
echo      python -m src.main virtual-test-real --scans 3
echo.
echo 자세한 설명: docs\INSTALL_WINDOWS.md
echo.
pause
