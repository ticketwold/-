@echo off
chcp 65001 >nul
cd /d "%~dp0.."

set SRC=C:\Users\user\Downloads\arb_v297\arb_v294
set DST=%CD%\extension-legacy

echo.
echo === Upload local extension to repo ===
echo Source: %SRC%
echo Target: %DST%
echo.

if not exist "%SRC%" (
  echo [ERROR] Folder not found:
  echo   %SRC%
  echo.
  echo Edit SRC path in this bat file if your folder is elsewhere.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

echo Copying all files...
xcopy "%SRC%\*" "%DST%\" /E /I /Y

echo.
echo Done. Next run:
echo   cd %CD%
echo   git add extension-legacy
echo   git commit -m "add full local extension"
echo   git push origin cursor/arbitrage-betting-00df
echo.
echo Then tell the agent: push complete
echo.
pause
