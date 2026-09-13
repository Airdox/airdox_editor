$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
py -3 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install torch torchaudio
& .\.venv\Scripts\python.exe -m pip install demucs==4.0.1
& .\.venv\Scripts\python.exe -m demucs --help | Out-Null
Write-Host "Demucs ist installiert. htdemucs_ft wird bei der ersten Separation automatisch geladen."
