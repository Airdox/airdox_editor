# Offline verifier; reads only this package. No Google login, no audio access.
# Hash consistency is NOT a digital publisher signature.
param([string]$Directory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
# Use .NET directly: Get-FileHash may be unavailable in Windows PowerShell
# when launched from PowerShell 7 with its inherited module search path.
function Get-PackageSha256([string]$File) {
    $stream = [System.IO.File]::OpenRead($File)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
try {
    $root = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $manifest = Get-Content -LiteralPath (Join-Path $root 'NACHWEISKETTE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.result -ne 'PRE_AUTH_VERIFIED') { throw 'Invalid release manifest' }
    $count = 0
    foreach ($entry in $manifest.files.PSObject.Properties) {
        $name = $entry.Name
        if ($name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//)') { throw "Unsafe path: $name" }
        $target = [System.IO.Path]::GetFullPath((Join-Path $root $name))
        if (-not $target.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escape: $name" }
        $file = Get-Item -LiteralPath $target
        if ($file.Length -ne $entry.Value.bytes -or (Get-PackageSha256 $target) -ne $entry.Value.sha256) { throw "Changed or incomplete: $name" }
        $count++
    }
    if ($count -lt 15) { throw 'Incomplete evidence inventory' }
    $required = @('model-preflight', 'model-live', 'notebook-preauth', 'windows-types', 'windows-tests', 'windows-build', 'windows-smoke')
    foreach ($stage in $required) {
        $recordPath = Join-Path $root "NACHWEISE/$stage.json"
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.result -ne 'PASS' -or $record.exitCode -ne 0 -or $record.sourceCommit -ne $manifest.sourceCommit) { throw "Stage not passing or wrong source: $stage" }
        if ($record.log.file -ne "$stage.log") { throw "Unexpected log path: $stage" }
        $hash = (Get-PackageSha256 (Join-Path $root "NACHWEISE/$stage.log"))
        if ($hash -ne $record.log.sha256) { throw "Changed log: $stage" }
        if (-not $manifest.files.PSObject.Properties["NACHWEISE/$stage.json"]) { throw "Unbound stage: $stage" }
    }
    Write-Host "PASS: $count Dateien und alle $($required.Count) Pflichtstufen geprueft."
    Write-Host "Version: $($manifest.appVersion) | Source: $($manifest.sourceCommit)"
    Write-Host 'Google-Konto / Drive / Colab-GPU: NICHT getestet, persoenliche Freigabe erforderlich.'
    Write-Host 'Hash-Integritaet ist keine Herausgeber-Signatur. EXEs sind nicht code-signiert.'
    if ($env:GITHUB_ACTIONS) {
        Write-Output "::notice title=Release evidence verified::Version=$($manifest.appVersion); Source=$($manifest.sourceCommit); Files=$count; RequiredStages=$($required.Count); Google=NOT_ATTEMPTED"
    }
    exit 0
} catch {
    if ($env:GITHUB_ACTIONS) {
        $message = $_.Exception.Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
        Write-Output "::error title=Package verifier::$message"
    }
    Write-Error "FAIL: $($_.Exception.Message)"
    exit 1
}
