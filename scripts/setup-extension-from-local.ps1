# Merge local arb_v294 extension with repo BTI patch
# Run: powershell -ExecutionPolicy Bypass -File scripts\setup-extension-from-local.ps1

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

function Log-Msg {
  param([string]$Text, [string]$Color = "White")
  $line = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $Text
  Write-Host $line -ForegroundColor $Color
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

$ErrorActionPreference = "Stop"

try {
  Log-Msg "=== Extension install start ===" "Cyan"
  Log-Msg ("Source: " + $SourceDir)
  Log-Msg ("Patch:  " + $PatchDir)
  Log-Msg ("Target: " + $TargetDir)
  Log-Msg ("Log:    " + $LogFile)

  if (-not (Test-Path $SourceDir)) {
    Log-Msg ("ERROR: source folder not found: " + $SourceDir) "Red"
    Log-Msg "Fix: -SourceDir `"C:\path\to\arb_v294`"" "Yellow"
    exit 1
  }

  if (-not (Test-Path $PatchDir)) {
    Log-Msg "ERROR: extension folder missing. Run git pull first." "Red"
    exit 1
  }

  if (Test-Path $TargetDir) {
    $backupName = "extension-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    $BackupDir = Join-Path $RepoRoot $backupName
    Copy-Item $TargetDir $BackupDir -Recurse -Force
    Log-Msg ("Backup: " + $BackupDir) "Yellow"
    Remove-Item $TargetDir -Recurse -Force
  }

  Log-Msg "Copying files..." "Yellow"
  Copy-Item $SourceDir $TargetDir -Recurse -Force
  Log-Msg "[1/4] Copy done" "Green"

  $btiPatch = Join-Path $PatchDir "bti_content.js"
  if (Test-Path $btiPatch) {
    Copy-Item $btiPatch (Join-Path $TargetDir "bti_content.js") -Force
    Log-Msg "[2/4] bti_content.js v2.21 applied" "Green"
  } else {
    Log-Msg "[2/4] bti_content.js patch missing - skip" "Yellow"
  }

  $manifestPath = Join-Path $TargetDir "manifest.json"
  if (-not (Test-Path $manifestPath)) {
    Copy-Item (Join-Path $PatchDir "manifest.json") $manifestPath -Force
    Log-Msg "[3/4] manifest.json copied from repo" "Yellow"
  } else {
    $manifestOk = $false
    try {
      $raw = Get-Content $manifestPath -Raw -Encoding UTF8
      $json = $raw | ConvertFrom-Json
      $changed = $false

      if (-not $json.permissions) {
        $json | Add-Member -NotePropertyName permissions -NotePropertyValue @()
      }
      if ($json.permissions -notcontains "webNavigation") {
        $json.permissions = @($json.permissions) + @("webNavigation")
        $changed = $true
      }

      if ($json.content_scripts) {
        foreach ($cs in $json.content_scripts) {
          $hasBti = $false
          if ($cs.js) {
            foreach ($j in $cs.js) {
              if ($j -like "*bti_content*") { $hasBti = $true }
            }
          }
          if ($hasBti -and -not $cs.all_frames) {
            $cs | Add-Member -NotePropertyName all_frames -NotePropertyValue $true -Force
            $changed = $true
          }
        }
      }

      if ($changed) {
        $json | ConvertTo-Json -Depth 20 | Set-Content $manifestPath -Encoding UTF8
        Log-Msg "[3/4] manifest.json patched" "Green"
      } else {
        Log-Msg "[3/4] manifest.json OK" "Green"
      }
      $manifestOk = $true
    } catch {
      Log-Msg ("[3/4] manifest parse failed: " + $_.Exception.Message) "Yellow"
      Copy-Item (Join-Path $PatchDir "manifest.json") $manifestPath -Force
      Log-Msg "[3/4] manifest.json replaced from repo" "Yellow"
      $manifestOk = $true
    }
  }

  $localPopup = Join-Path $TargetDir "popup.js"
  $useRepoPopup = $false
  if (-not (Test-Path $localPopup)) {
    $useRepoPopup = $true
  } else {
    $size = (Get-Item $localPopup).Length
    Log-Msg ("popup.js size: " + $size + " bytes")
    if ($size -lt 5000) { $useRepoPopup = $true }
  }

  if ($useRepoPopup) {
    $files = @("popup.html", "popup.js", "styles.css", "background.js", "arb_calculator.js", "match_matcher.js", "pinnacle_api.js")
    foreach ($f in $files) {
      $src = Join-Path $PatchDir $f
      if (Test-Path $src) {
        Copy-Item $src (Join-Path $TargetDir $f) -Force
      }
    }
    Log-Msg "[4/4] Using repo popup/background" "Green"
  } else {
    $bgHelper = Join-Path $PatchDir "background.js"
    if (Test-Path $bgHelper) {
      Copy-Item $bgHelper (Join-Path $TargetDir "background-scan-arb.js") -Force
    }
    Log-Msg "[4/4] Keeping your popup.js" "Green"
  }

  $fileCount = (Get-ChildItem $TargetDir -File -Recurse).Count
  Log-Msg ("Files installed: " + $fileCount) "Cyan"

  if (-not (Test-Path (Join-Path $TargetDir "manifest.json"))) {
    Log-Msg "ERROR: manifest.json missing" "Red"
    exit 1
  }

  Log-Msg "=== DONE ===" "Green"
  Log-Msg "Open edge://extensions" "Cyan"
  Log-Msg ("Load folder: " + $TargetDir) "Cyan"
  Log-Msg "1) pbc00 login  2) BTI match page  3) search in extension" "White"
  exit 0

} catch {
  Log-Msg ("FATAL: " + $_.Exception.Message) "Red"
  exit 1
}
