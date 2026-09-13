#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
# CPU wheels avoid accidentally downloading CUDA runtimes on editor machines.
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
python -m pip install demucs==4.0.1
python -m demucs --help >/dev/null
echo "Demucs ist installiert. Das Modell htdemucs_ft wird bei der ersten Separation automatisch geladen."
