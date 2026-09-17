#!/usr/bin/env bash
set -e

# One-click stem model setup (Demucs + RoFormer)

echo "Setting up stem separation models..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Setup BS-RoFormer
"$SCRIPT_DIR/setup-bsroformer-model.sh" "$@"

# Setup Demucs
echo "Setting up Demucs..."
PYTHON=$(command -v python3 || command -v python)
$PYTHON -m pip install demucs || echo "Demucs install failed, may need manual install"

echo "All models setup attempted."
echo "Check colab/airdox-stem-gate.md for Colab instructions if network fails (release-assets unreachable via SSL_ERROR_SYSCALL noted)."
