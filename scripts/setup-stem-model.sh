#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import sys
if not (sys.version_info.major == 3 and 9 <= sys.version_info.minor <= 13):
    raise SystemExit(f"Python {sys.version_info.major}.{sys.version_info.minor} wird nicht unterstützt; bitte Python 3.11 oder 3.12 verwenden.")
PY
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
# CPU wheels avoid accidentally downloading CUDA runtimes on editor machines.
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
python -m pip install demucs==4.0.1
python -c "import demucs, torch, torchaudio; print('Demucs/PyTorch Import OK')"
python -m demucs --help >/dev/null
echo "Demucs ist installiert. Das Modell htdemucs_ft wird bei der ersten Separation automatisch geladen."
