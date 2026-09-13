$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# Demucs/PyTorch wheels are not reliably available for the newest Python on its
# release day. Never let `py -3` silently select Python 3.14 as happened in the
# reported Windows installation. Prefer the explicitly supported versions.
$selected = $null
foreach ($version in @("3.12", "3.11", "3.10", "3.9")) {
  try {
    & py "-$version" -c "import sys; assert sys.version_info[:2] == tuple(map(int, '$version'.split('.')))" 2>$null
    if ($LASTEXITCODE -eq 0) { $selected = $version; break }
  } catch { }
}
if (-not $selected) {
  throw "Kein unterstütztes Python gefunden. Bitte Python 3.11 oder 3.12 (64 Bit) installieren. Python 3.14 wird derzeit nicht verwendet."
}

Write-Host "Verwende Python $selected für Demucs."
& py "-$selected" -m venv .venv
$python = ".\.venv\Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install torch torchaudio
& $python -m pip install demucs==4.0.1
& $python -c "import demucs, torch, torchaudio; print('Demucs/PyTorch Import OK')"
& $python -m demucs --help | Out-Null
Write-Host "Demucs ist geprüft und installiert. htdemucs_ft wird bei der ersten Separation automatisch geladen."
