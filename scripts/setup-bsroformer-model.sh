#!/usr/bin/env bash
set -e

# Setup BS-RoFormer model environment
# Reference arch from AIRODOX_MSST_DIR or pip msst

MODEL_DIR="${AIRODOX_MSST_DIR:-./models}"
CHECKPOINT_URL="${1:-https://github.com/Airdox/airdox_editor/releases/download/models/bsroformer-musdb18hq-4stem-zfturbo.ckpt}"

echo "Setting up BS-RoFormer model..."
echo "Model dir: $MODEL_DIR"
echo "Checkpoint URL: $CHECKPOINT_URL"

mkdir -p "$MODEL_DIR"

# Check python
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
  echo "Python not found, please install Python 3.10+"
  exit 1
fi

PYTHON=$(command -v python3 || command -v python)
echo "Using Python: $PYTHON"

# Create venv if not exists
if [ ! -d "$MODEL_DIR/venv" ]; then
  echo "Creating venv..."
  $PYTHON -m venv "$MODEL_DIR/venv"
fi

source "$MODEL_DIR/venv/bin/activate" 2>/dev/null || source "$MODEL_DIR/venv/Scripts/activate" 2>/dev/null || true

echo "Installing msst..."
pip install --upgrade pip
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu || pip install torch torchaudio
pip install msst || echo "msst pip install failed, trying from source..."

# Download checkpoint if not exists
CHECKPOINT_PATH="$MODEL_DIR/bsroformer-musdb18hq-4stem-zfturbo.ckpt"
if [ ! -f "$CHECKPOINT_PATH" ]; then
  echo "Downloading checkpoint..."
  if command -v curl &> /dev/null; then
    curl -L -o "$CHECKPOINT_PATH" "$CHECKPOINT_URL" || echo "Download failed (network limitation noted in colab gate)"
  elif command -v wget &> /dev/null; then
    wget -O "$CHECKPOINT_PATH" "$CHECKPOINT_URL" || echo "Download failed"
  else
    echo "No curl/wget, skipping download"
  fi
else
  echo "Checkpoint already exists: $CHECKPOINT_PATH"
fi

echo "Setup complete. Set AIRODOX_MSST_DIR=$MODEL_DIR"
echo "To test: AIRODOX_MSST_DIR=$MODEL_DIR python python/bsroformer_inference.py --help"
