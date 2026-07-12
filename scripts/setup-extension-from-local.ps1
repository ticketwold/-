# arb_v294 로컬 확장 + 저장소 BTI 수정본 병합
# 사용법 (PowerShell):
#   cd C:\Users\user\Documents\arbitrage-betting
#   git pull origin cursor/arbitrage-betting-00df
#   .\scripts\setup-extension-from-local.ps1

param(
  [string]$SourceDir = "C:\Users\user\Downloads\arb_v297\arb_v294",
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"
$PatchDir = Join-Path $RepoRoot "extension"
$TargetDir = Join-Path $RepoRoot "extension-installed"
$BackupDir = Join-Path $RepoRoot "extension-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "=== 양방 확장 설치 ===" -ForegroundColor Cyan
Write-Host "로컬 확장: $SourceDir"
Write-Host "패치 소스: $PatchDir"
Write-Host "설치 위치: $TargetDir"

if (-not (Test-Path $SourceDir)) {
  Write-Host "[오류] 로컬 확장 폴더가 없습니다: $SourceDir" -ForegroundColor Red
  Write-Host "경로를 확인하거나 -SourceDir 매개변수로 지정하세요."
  exit 1
}

if (-not (Test-Path $PatchDir)) {
  Write-Host "[오류] 저장소 extension 폴더 없음. git pull 먼저 실행하세요." -ForegroundColor Red
  exit 1
}

# 1) 로컬 확장 전체 복사
if (Test-Path $TargetDir) {
  Copy-Item $TargetDir $BackupDir -Recurse -Force
  Write-Host "기존 설치 백업: $BackupDir" -ForegroundColor Yellow
  Remove-Item $TargetDir -Recurse -Force
}
Copy-Item $SourceDir $TargetDir -Recurse -Force
Write-Host "[1/4] 로컬 확장 복사 완료" -ForegroundColor Green

# 2) BTI 배당 검색 수정본 덮어쓰기 (v2.21)
$btiPatch = Join-Path $PatchDir "bti_content.js"
if (Test-Path $btiPatch) {
  Copy-Item $btiPatch (Join-Path $TargetDir "bti_content.js") -Force
  Write-Host "[2/4] bti_content.js → v2.21 (배당판 검색 추가)" -ForegroundColor Green
}

# 3) manifest all_frames 확인/패치
$manifestPath = Join-Path $TargetDir "manifest.json"
if (Test-Path $manifestPath) {
  $json = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false

  if (-not $json.permissions) { $json | Add-Member -NotePropertyName permissions -NotePropertyValue @() }
  if ($json.permissions -notcontains "webNavigation") {
    $json.permissions += "webNavigation"
    $changed = $true
  }

  foreach ($cs in $json.content_scripts) {
    if ($cs.js -contains "bti_content.js") {
      if (-not $cs.all_frames) {
        $cs | Add-Member -NotePropertyName all_frames -NotePropertyValue $true -Force
        $changed = $true
      }
    }
  }

  if ($changed) {
    $json | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding UTF8
    Write-Host "[3/4] manifest.json 패치 (all_frames + webNavigation)" -ForegroundColor Green
  } else {
    Write-Host "[3/4] manifest.json OK" -ForegroundColor Green
  }
} else {
  Write-Host "[3/4] manifest.json 없음 — 저장소 버전 사용" -ForegroundColor Yellow
  Copy-Item (Join-Path $PatchDir "manifest.json") $manifestPath -Force
}

# 4) 선택: popup이 없거나 작으면 저장소 UI 사용
$localPopup = Join-Path $TargetDir "popup.js"
$useRepoPopup = $false
if (-not (Test-Path $localPopup)) {
  $useRepoPopup = $true
} else {
  $size = (Get-Item $localPopup).Length
  if ($size -lt 5000) { $useRepoPopup = $true }
}

if ($useRepoPopup) {
  Copy-Item (Join-Path $PatchDir "popup.html") (Join-Path $TargetDir "popup.html") -Force
  Copy-Item (Join-Path $PatchDir "popup.js") (Join-Path $TargetDir "popup.js") -Force
  Copy-Item (Join-Path $PatchDir "styles.css") (Join-Path $TargetDir "styles.css") -Force
  Copy-Item (Join-Path $PatchDir "background.js") (Join-Path $TargetDir "background.js") -Force
  Copy-Item (Join-Path $PatchDir "arb_calculator.js") (Join-Path $TargetDir "arb_calculator.js") -Force
  Copy-Item (Join-Path $PatchDir "match_matcher.js") (Join-Path $TargetDir "match_matcher.js") -Force
  Copy-Item (Join-Path $PatchDir "pinnacle_api.js") (Join-Path $TargetDir "pinnacle_api.js") -Force
  Write-Host "[4/4] popup/background — 저장소 UI 사용" -ForegroundColor Green
} else {
  # 기존 popup 유지 — background에 scan-arb 핸들러만 병합 안내
  $bgHelper = Join-Path $PatchDir "background.js"
  Copy-Item $bgHelper (Join-Path $TargetDir "background-scan-arb.js") -Force
  Write-Host "[4/4] 기존 popup.js 유지 (189KB)" -ForegroundColor Green
  Write-Host "      → background.js에 scan-arb 연동이 필요하면 background-scan-arb.js 참고" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 설치 완료 ===" -ForegroundColor Cyan
Write-Host "Edge: edge://extensions → 압축해제된 확장 로드"
Write-Host "폴더: $TargetDir"
Write-Host ""
Write-Host "테스트:"
Write-Host "  1) pbc00 열기 + 로그인"
Write-Host "  2) BTI 경기 상세 (배당 버튼 보이는 화면)"
Write-Host "  3) 확장에서 팀명 검색 / 양방 스캔"
