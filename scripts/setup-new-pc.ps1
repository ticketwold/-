# 새 PC 원클릭 설치 — Git clone + x10/polymarket 브랜치 + extension-legacy 경로 안내
# 사용: powershell -ExecutionPolicy Bypass -File scripts\setup-new-pc.ps1

param(
  [string]$InstallDir = "C:\Users\user\Documents\arbitrage-betting",
  [string]$Branch = "cursor/x10-polymarket-00df",
  [string]$RepoUrl = "https://github.com/ticketwold/-.git"
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Msg, [string]$Color = "Cyan") {
  Write-Host ""
  Write-Host ">> $Msg" -ForegroundColor $Color
}

try {
  Write-Host "========================================" -ForegroundColor Green
  Write-Host "  양방 확장 — 새 PC 설치" -ForegroundColor Green
  Write-Host "  (x10x10s + Polymarket v4.0)" -ForegroundColor Green
  Write-Host "========================================" -ForegroundColor Green

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "[오류] Git이 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "  https://git-scm.com/download/win 에서 설치 후 PowerShell을 다시 열어주세요." -ForegroundColor Yellow
    exit 1
  }

  $parent = Split-Path $InstallDir -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "기존 폴더 발견 — 업데이트만 진행: $InstallDir"
    Set-Location $InstallDir
    git fetch origin $Branch
    git checkout $Branch 2>$null
    if ($LASTEXITCODE -ne 0) { git checkout -b $Branch "origin/$Branch" }
    git reset --hard "origin/$Branch"
  } elseif (Test-Path $InstallDir) {
    Write-Step "폴더는 있으나 git 저장소 아님 — clone을 다른 경로로 시도" "Yellow"
    $InstallDir = $InstallDir + "-git"
    git clone $RepoUrl $InstallDir
    Set-Location $InstallDir
    git fetch origin $Branch
    git checkout $Branch
  } else {
    Write-Step "프로젝트 다운로드: $InstallDir"
    git clone $RepoUrl $InstallDir
    Set-Location $InstallDir
    git fetch origin $Branch
    git checkout $Branch
  }

  $extDir = Join-Path $InstallDir "extension-legacy"
  $manifest = Join-Path $extDir "manifest.json"

  if (-not (Test-Path $manifest)) {
    Write-Host "[오류] extension-legacy 폴더를 찾을 수 없습니다." -ForegroundColor Red
    exit 1
  }

  $version = "?"
  try {
    $mj = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = $mj.version
  } catch { }

  Write-Host ""
  Write-Host "========================================" -ForegroundColor Green
  Write-Host "  설치 완료" -ForegroundColor Green
  Write-Host "========================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  프로젝트 폴더:" -ForegroundColor White
  Write-Host "    $InstallDir" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Edge에 로드할 폴더 (이 경로 선택!):" -ForegroundColor White
  Write-Host "    $extDir" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  확장 버전: $version" -ForegroundColor Gray
  Write-Host ""
  Write-Host "  다음 단계:" -ForegroundColor Cyan
  Write-Host "    1. Edge 주소창: edge://extensions"
  Write-Host "    2. 개발자 모드 ON"
  Write-Host "    3. '압축해제된 확장 로드' → 위 extension-legacy 폴더 선택"
  Write-Host "    4. x10x10s.com 로그인 + 스포츠 화면"
  Write-Host "    5. polymarket.com 탭 열기"
  Write-Host "    6. 확장 팝업 → 서치 시작"
  Write-Host ""

  $open = Read-Host "Edge 확장 페이지(edge://extensions)를 열까요? (Y/n)"
  if ($open -ne "n" -and $open -ne "N") {
    Start-Process "microsoft-edge:edge://extensions"
  }

  exit 0
} catch {
  Write-Host ""
  Write-Host "[오류] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
