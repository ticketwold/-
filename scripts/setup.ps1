# 양방배팅 프로그램 초기 설정 (Windows PowerShell)
# 사용법: 프로젝트 폴더에서 .\scripts\setup.ps1

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

$Example = Join-Path $ProjectRoot "config\settings.yaml.example"
$Target  = Join-Path $ProjectRoot "config\settings.yaml"

if (-not (Test-Path $Example)) {
  Write-Host "[오류] config\settings.yaml.example 파일을 찾을 수 없습니다." -ForegroundColor Red
  Write-Host "현재 위치: $ProjectRoot"
  exit 1
}

if (Test-Path $Target) {
  Write-Host "config\settings.yaml 파일이 이미 있습니다. 건너뜁니다." -ForegroundColor Yellow
} else {
  Copy-Item $Example $Target
  Write-Host "config\settings.yaml 파일을 생성했습니다." -ForegroundColor Green
}

Write-Host ""
Write-Host "다음 단계:"
Write-Host "  1. config\settings.yaml 에서 사이트 계정 정보 수정"
Write-Host "  2. pip install -r requirements.txt"
Write-Host "  3. playwright install chromium"
Write-Host "  4. python -m src.main pinnacle --sport football --limit 5"
