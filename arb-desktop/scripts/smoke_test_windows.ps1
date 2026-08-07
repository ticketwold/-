# Smoke test: ArbDesktop.exe starts and stays alive for a few seconds.
$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot "..\dist\ArbDesktop"
$exe = Join-Path $root "ArbDesktop.exe"

if (-not (Test-Path $exe)) {
    throw "Smoke test failed: $exe not found"
}

Write-Host "Starting smoke test for $exe"
$proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
Start-Sleep -Seconds 6

if ($proc.HasExited) {
    throw "Smoke test failed: ArbDesktop.exe exited early with code $($proc.ExitCode)"
}

Write-Host "Smoke test OK - process still running (pid=$($proc.Id))"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host "Smoke test completed"
