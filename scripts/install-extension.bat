@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo === Extension Install ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-extension-from-local.ps1" %*
set ERR=%ERRORLEVEL%

echo.
if %ERR% NEQ 0 (
  echo [FAILED] exit code: %ERR%
  echo Check log: %CD%\extension-install.log
) else (
  echo [OK] Load this folder in Edge:
  echo   %CD%\extension-installed
  echo.
  echo edge://extensions - Developer mode - Load unpacked
)

echo.
pause
