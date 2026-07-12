# arb_v294 로컬 확장 + 저장소 BTI 수정본 병합

param(
  [string]$SourceDir = "C:\Users\user\Downloads\arb_v297\arb_v294",
  [string]$RepoRoot = ""
)

if (-not $RepoRoot) {
  $RepoRoot = Split-Path $PSScriptRoot -Parent
}

$PatchDir = Join-Path $RepoRoot "extension"
$TargetDir = Join-Path $RepoRoot "extension-installed"
$LogFile = Join-Path $RepoRoot "extension-install.log"

function Log($msg, $color = "White") {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

try {
  Log "=== 양방 확장 설치 시작 ===" "Cyan"
  Log "로컬 확장: $SourceDir"
  Log "패치 소스: $PatchDir"
  Log "설치 위치: $TargetDir"
  Log "로그 파일: $LogFile"

  if (-not (Test-Path $SourceDir)) {
    Log "[오류] 로컬 폴더 없음: $SourceDir" "Red"
    Log "Downloads 경로 확인 후:" "Yellow"
    Log '  .\scripts\setup-extension-from-local.ps1 -SourceDir "실제경로"' "Yellow"
    exit 1
  }

  if (-not (Test-Path $PatchDir)) {
    Log "[오류] extension 폴더 없음. git pull 실행하세요." "Red"
    exit 1
  }

  # 1) 복사
  if (Test-Path $TargetDir) {
    $BackupDir = Join-Path $RepoRoot "extension-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $TargetDir $BackupDir -Recurse -Force
    Log "기존 백업: $BackupDir" "Yellow"
    Remove-Item $TargetDir -Recurse -Force
  }

  Log "복사 중... (잠시 대기)" "Yellow"
  Copy-Item $SourceDir $TargetDir -Recurse -Force
  Log "[1/4] 로컬 확장 복사 완료" "Green"

  # 2) bti_content.js 패치
  $btiPatch = Join-Path $PatchDir "bti_content.js"
  if (Test-Path $btiPatch) {
    Copy-Item $btiPatch (Join-Path $TargetDir "bti_content.js") -Force
    Log "[2/4] bti_content.js v2.21 적용" "Green"
  } else {
    Log "[2/4] bti_content.js 패치 파일 없음 — 스킵" "Yellow"
  }

  # 3) manifest 패치
  $manifestPath = Join-Path $TargetDir "manifest.json"
  if (-not (Test-Path $manifestPath)) {
    Copy-Item (Join-Path $PatchDir "manifest.json") $manifestPath -Force
    Log "[3/4] manifest.json — 저장소 버전 복사" "Yellow"
  } else {
    $patched = $false
    try {
      $json = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $json.permissions) {
        $json | Add-Member -NotePropertyName permissions -NotePropertyValue @()
      }
      if ($json.permissions -notcontains "webNavigation") {
        $json.permissions = @($json.permissions) + @("webNavigation")
        $patched = $true
      }
      foreach ($cs in $json.content_scripts) {
        $hasBti = $false
        if ($cs.js) { $hasBti = ($cs.js | Where-Object { $_ -match "bti_content" }).Count -gt 0 }
        if ($hasBti -and -not $cs.all_frames) {
          $cs | Add-Member -NotePropertyName all_frames -NotePropertyValue $true -Force
          $patched = $true
        }
      }
      if ($patched) {
        $json | ConvertTo-Json -Depth 20 | Set-Content $manifestPath -Encoding UTF8
        Log "[3/4] manifest.json JSON 패치 완료" "Green"
      } else {
        Log "[3/4] manifest.json OK" "Green"
      }
    } catch {
      Log "[3/4] manifest JSON 파싱 실패 — 저장소 manifest로 교체" "Yellow"
      Log "  이유: $($_.Exception.Message)" "Yellow"
      Copy-Item (Join-Path $PatchDir "manifest.json") $manifestPath -Force
      Log "  (기존 popup.js 등은 유지됨)" "Yellow"
    }
  }

  # 4) popup
  $localPopup = Join-Path $TargetDir "popup.js"
  $useRepoPopup = $false
  if (-not (Test-Path $localPopup)) {
    $useRepoPopup = $true
  } else {
    $size = (Get-Item $localPopup).Length
    Log "popup.js 크기: $size bytes"
    if ($size -lt 5000) { $useRepoPopup = $true }
  }

  if ($useRepoPopup) {
    @("popup.html", "popup.js", "styles.css", "background.js", "arb_calculator.js", "match_matcher.js", "pinnacle_api.js") | ForEach-Object {
      $src = Join-Path $PatchDir $_
      if (Test-Path $src) { Copy-Item $src (Join-Path $TargetDir $_) -Force }
    }
    Log "[4/4] 저장소 popup/background 사용" "Green"
  } else {
    $bgHelper = Join-Path $PatchDir "background.js"
    if (Test-Path $bgHelper) {
      Copy-Item $bgHelper (Join-Path $TargetDir "background-scan-arb.js") -Force
    }
    Log "[4/4] 기존 popup.js 유지" "Green"
  }

  # 결과 확인
  $fileCount = (Get-ChildItem $TargetDir -File -Recurse).Count
  Log "설치된 파일 수: $fileCount" "Cyan"

  if (-not (Test-Path (Join-Path $TargetDir "manifest.json"))) {
    Log "[오류] manifest.json 없음 — 설치 실패" "Red"
    exit 1
  }

  Log "" "White"
  Log "=== 설치 완료 ===" "Green"
  Log "Edge: edge://extensions" "Cyan"
  Log "로드 폴더: $TargetDir" "Cyan"
  Log "1) pbc00 로그인  2) BTI 경기 화면  3) 확장에서 검색" "White"
  exit 0

} catch {
  Log "예외 발생: $($_.Exception.Message)" "Red"
  Log $_.ScriptStackTrace "Red"
  exit 1
}
