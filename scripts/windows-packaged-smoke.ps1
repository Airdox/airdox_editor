$ErrorActionPreference = 'Stop'
$env:AIRDOX_PACKAGED_SMOKE_DIR = Join-Path $env:RUNNER_TEMP 'airdox-smoke'
$app = Start-Process -FilePath '.\release\win-unpacked\airdox_SMART_Editor.exe' -PassThru
if (-not $app.WaitForExit(120000)) { Stop-Process -Id $app.Id -Force; throw 'Windows smoke timeout' }
if ($app.ExitCode -ne 0) { throw "Windows smoke failed: $($app.ExitCode)" }
$report = Get-Content (Join-Path $env:AIRDOX_PACKAGED_SMOKE_DIR 'windows-smoke.json') -Raw | ConvertFrom-Json
if ($report.result -ne 'PASS' -or -not $report.evidenceIpc) { throw 'No passing Windows smoke/evidence report' }
Copy-Item (Join-Path $env:AIRDOX_PACKAGED_SMOKE_DIR 'windows-smoke.*') release
Write-Output ($report | ConvertTo-Json -Depth 10)
