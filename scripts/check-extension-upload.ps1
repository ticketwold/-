# Check extension folder and git - paste output to chat
$src = "C:\Users\user\Downloads\arb_v297\arb_v294"
$repo = Split-Path $PSScriptRoot -Parent
$dst = Join-Path $repo "extension-legacy"

Write-Host "=== Extension Upload Check ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1] Source folder" -ForegroundColor Yellow
if (Test-Path $src) {
  Write-Host "  OK: $src" -ForegroundColor Green
  Get-ChildItem $src -File | ForEach-Object {
    Write-Host ("  - {0} ({1} bytes)" -f $_.Name, $_.Length)
  }
} else {
  Write-Host "  MISSING: $src" -ForegroundColor Red
  Write-Host "  Edit path in scripts\check-extension-upload.ps1" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[2] Repo extension-legacy" -ForegroundColor Yellow
if (Test-Path $dst) {
  $files = Get-ChildItem $dst -File -Recurse -ErrorAction SilentlyContinue
  if ($files.Count -le 1) {
    Write-Host "  EMPTY (only README?)" -ForegroundColor Red
  } else {
    Write-Host ("  OK: {0} files" -f $files.Count) -ForegroundColor Green
  }
} else {
  Write-Host "  MISSING folder" -ForegroundColor Red
}

Write-Host ""
Write-Host "[3] Git" -ForegroundColor Yellow
Set-Location $repo
Write-Host ("  Repo: {0}" -f $repo)
try {
  $branch = git branch --show-current 2>&1
  Write-Host ("  Branch: {0}" -f $branch)
  git status --short extension-legacy 2>&1
} catch {
  Write-Host "  git not available or not a repo" -ForegroundColor Red
}

Write-Host ""
Write-Host "Copy ALL text above and paste into Cursor chat." -ForegroundColor Cyan
Write-Host "Or paste manifest.json + bti_content.js content directly." -ForegroundColor Cyan
