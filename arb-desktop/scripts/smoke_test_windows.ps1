# Windows startup survival test — ArbDesktop.exe must stay alive 5 minutes.
# Validates %LOCALAPPDATA%\arb-desktop\crash.log STARTUP steps.
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\dist\ArbDesktop")
$exe = Join-Path $root "ArbDesktop.exe"
$crashLog = Join-Path $env:LOCALAPPDATA "arb-desktop\crash.log"
$durationSec = 300
$sampleSec = 15

if (-not (Test-Path $exe)) {
    throw "STARTUP FAIL: ArbDesktop.exe not found at $exe"
}

if (Test-Path $crashLog) {
    Remove-Item $crashLog -Force
}

Write-Host "=== Windows startup survival test ($durationSec s) ==="
Write-Host "Exe: $exe"
Write-Host "Crash log: $crashLog"

$proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
Write-Host "Started pid=$($proc.Id)"

$elapsed = 0
while ($elapsed -lt $durationSec) {
    Start-Sleep -Seconds $sampleSec
    $elapsed += $sampleSec
    if ($proc.HasExited) {
        $code = $proc.ExitCode
        Write-Host "--- crash.log tail ---"
        if (Test-Path $crashLog) { Get-Content $crashLog -Tail 80 }
        throw "STARTUP FAIL: ArbDesktop.exe exited after ${elapsed}s (exit code $code)"
    }
    Write-Host "[$elapsed s] process alive (pid=$($proc.Id))"
}

if ($proc.HasExited) {
    throw "STARTUP FAIL: process exited at end of wait"
}

Write-Host "=== 5 minute survival PASS ==="

if (-not (Test-Path $crashLog)) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "STARTUP FAIL: crash.log not created at $crashLog"
}

$logText = Get-Content $crashLog -Raw
Write-Host "--- crash.log ---"
Get-Content $crashLog -Tail 60

$required = @(
    "[STARTUP 01]",
    "[STARTUP 03]",
    "[STARTUP 04]",
    "[STARTUP 05]",
    "[STARTUP 09]"
)
$missing = @()
foreach ($step in $required) {
    if ($logText -notmatch [regex]::Escape($step)) {
        $missing += $step
    }
}
if ($missing.Count -gt 0) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "STARTUP FAIL: crash.log missing steps: $($missing -join ', ')"
}

Write-Host "STARTUP log steps: PASS"
Write-Host "RESULT: Windows exe survival 5min = PASS"

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host "Smoke test completed - process terminated"
