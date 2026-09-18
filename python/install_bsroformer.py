#!/usr/bin/env python3
"""Packaged-app BS-RoFormer setup. Called with an explicit, writable venv.

Downloads are staged and checkpoint hashes checked BEFORE torch.load. The final
step uses the same model loader as separation, not a speculative READY flag.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

TORCH = ["torch==2.5.1", "torchaudio==2.5.1"]


def pip_install(*packages):
    subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *packages], check=True)


def sha256(file):
    digest = hashlib.sha256()
    with open(file, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(ref, directory):
    name = ref["file"]
    if Path(name).name != name or "\\" in name:
        raise ValueError("Ungültiger Modell-Dateiname")
    target = directory / name
    expected = ref.get("sha256")
    if expected and target.is_file() and sha256(target) == expected:
        print(f"SHA256 bereits geprüft: {name}", flush=True)
        return target
    url = ref["url"]
    if not url.startswith("https://"):
        raise ValueError("Modell-Downloads benötigen HTTPS")
    partial = target.with_name(target.name + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "airdox-stem-installer"})
        with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as out:
            received = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                out.write(block)
                received += len(block)
                if received % (16 * 1024 * 1024) < len(block):
                    print(f"{name}: {received // (1024 * 1024)} MB", flush=True)
        if partial.stat().st_size == 0:
            raise ValueError(f"Leerer Download: {name}")
        if expected and sha256(partial) != expected:
            raise ValueError(f"SHA256 stimmt nicht: {name}. Datei wird nicht aktiviert.")
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def verify(model, directory, adapter_path):
    import torch
    import torchaudio  # noqa: F401 - require a matching audio wheel
    import soundfile  # noqa: F401

    checkpoint = directory / model["checkpoint"]["file"]
    if sha256(checkpoint) != model["checkpoint"]["sha256"]:
        raise ValueError("Checkpoint-SHA256 ungültig; Modell wird nicht geladen")
    spec = importlib.util.spec_from_file_location("airdox_inference", adapter_path)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    config = adapter.load_config_dict(str(directory / model["config"]["file"]))
    if list(config.training.instruments) != model["stemOrder"]:
        raise ValueError("Config-Stem-Reihenfolge widerspricht dem Modellkatalog")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    network = adapter.build_model(model["family"], config, "", "cpu", "f32")
    adapter.load_checkpoint(network, str(checkpoint), False, "cpu")
    # A short, real forward pass validates architecture, checkpoint and output
    # shape. It is a functional smoke test, not a separation quality benchmark.
    frames = 8192
    with torch.inference_mode():
        output = network(torch.zeros(1, model["inputChannels"], frames))
    expected = (1, len(model["stemOrder"]), model["inputChannels"], frames)
    if tuple(output.shape) != expected or not torch.isfinite(output).all():
        raise ValueError(f"Ungültige Test-Inferenz: {tuple(output.shape)}, erwartet {expected}")
    print("BSROFORMER_VERIFIED", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", type=int, choices=[3, 4, 5, 6], required=True)
    parser.add_argument("--descriptor", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--adapter", required=True)
    args = parser.parse_args()
    model = json.loads(Path(args.descriptor).read_text(encoding="utf-8"))
    directory = Path(args.model_dir)
    directory.mkdir(parents=True, exist_ok=True)
    if args.step == 3:
        pip_install("--upgrade", "pip")
        # Deliberately CPU wheels: deterministic, smaller, no CUDA prerequisite.
        pip_install("--index-url", "https://download.pytorch.org/whl/cpu", *TORCH)
    elif args.step == 4:
        # Pin torch again so dependency resolution cannot silently upgrade it.
        pip_install(*TORCH, "msst==0.1.0", "beartype==0.18.5", "einops==0.8.1",
                    "rotary-embedding-torch==0.8.6", "numpy==1.26.4",
                    "soundfile==0.13.1", "PyYAML==6.0.2", "ml-collections==1.1.0")
    elif args.step == 5:
        download(model["checkpoint"], directory)
        download(model["config"], directory)
    else:
        verify(model, directory, args.adapter)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"BS-RoFormer: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
