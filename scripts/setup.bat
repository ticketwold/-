@echo off
REM 양방배팅 프로그램 초기 설정 (Windows)

cd /d "%~dp0.."

if not exist "config" (
  echo [오류] config 폴더를 찾을 수 없습니다.
  echo 이 스크립트는 프로젝트 폴더에서 실행해야 합니다.
  pause
  exit /b 1
)

if not exist "config\settings.yaml.example" (
  echo [오류] config\settings.yaml.example 파일이 없습니다.
  pause
  exit /b 1
)

if exist "config\settings.yaml" (
  echo config\settings.yaml 파일이 이미 있습니다. 건너뜁니다.
) else (
  copy "config\settings.yaml.example" "config\settings.yaml"
  echo config\settings.yaml 파일을 생성했습니다.
)

echo.
echo 다음 단계:
echo   1. config\settings.yaml 에서 사이트 계정 정보 수정
echo   2. pip install -r requirements.txt
echo   3. playwright install chromium
echo   4. python -m src.main pinnacle --sport football --limit 5
echo.
pause
