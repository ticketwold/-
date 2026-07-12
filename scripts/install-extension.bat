@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo === 양방 확장 설치 (bat) ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-extension-from-local.ps1" %*
set ERR=%ERRORLEVEL%

echo.
if %ERR% NEQ 0 (
  echo [실패] 오류 코드: %ERR%
) else (
  echo [완료] extension-installed 폴더를 Edge에 로드하세요.
  echo   edge://extensions  ^>  개발자 모드  ^>  압축해제된 확장 로드
  echo   폴더: %CD%\extension-installed
)

echo.
pause
