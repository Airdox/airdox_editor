# PowerShell one-click stem model setup for Windows

param(
    [string]$CheckpointUrl = "https://github.com/Airdox/airdox_editor/releases/download/models/bsroformer-musdb18hq-4stem-zfturbo.ckpt"
)

$ModelDir = if ($env:AIRODOX_MSST_DIR) { $env:AIRODOX_MSST_DIR } else { ".\models" }

Write-Host "Setting up BS-RoFormer model..."
Write-Host "Model dir: $ModelDir"
Write-Host "Checkpoint URL: $CheckpointUrl"

New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

# Check python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) {
    Write-Error "Python not found, please install Python 3.10+"
    exit 1
}

Write-Host "Using Python: $($python.Source)"

# Create venv
if (-not (Test-Path "$ModelDir\venv")) {
    Write-Host "Creating venv..."
    & python -m venv "$ModelDir\venv"
}

# Activate and install
$venvPython = "$ModelDir\venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
    & $venvPython -m pip install msst
    & $venvPython -m pip install demucs
} else {
    Write-Host "venv python not found, using system python"
    & python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
    & python -m pip install msst
    & python -m pip install demucs
}

$CheckpointPath = Join-Path $ModelDir "bsroformer-musdb18hq-4stem-zfturbo.ckpt"
if (-not (Test-Path $CheckpointPath)) {
    Write-Host "Downloading checkpoint..."
    try {
        Invoke-WebRequest -Uri $CheckpointUrl -OutFile $CheckpointPath
    } catch {
        Write-Host "Download failed (network limitation): $_"
    }
} else {
    Write-Host "Checkpoint already exists: $CheckpointPath"
}

Write-Host "Setup complete. Set AIRODOX_MSST_DIR=$ModelDir"
