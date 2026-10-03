#!/usr/bin/env python3
"""Reproducible Colab setup; downloads only the pinned catalog model.

Torch is supplied by the isolated notebook venv (never modify Colab's kernel).
No credentials, arbitrary URLs or shell commands are accepted from jobs.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

from remote_worker import MODEL_ID, ProtocolError, sha256_file

ROOT = Path(__file__).resolve().parents[1]


def model():
    catalog = json.loads((ROOT / "src/stems/modelCatalog.json").read_text(encoding="utf-8"))
    return next(m for m in catalog["models"] if m["id"] == MODEL_ID)


def validate_engine(engine):
    descriptor = model()
    if engine.get("modelId") != MODEL_ID or engine.get("family") != descriptor["family"]:
        raise ProtocolError("REMOTE_MODEL_UNSUPPORTED", f"Dieser Worker unterstützt ausschließlich {MODEL_ID}")
    if engine.get("stems") != descriptor["stemOrder"]:
        raise ProtocolError("REMOTE_MODEL_INCOMPATIBLE", "Stem-Reihenfolge stimmt nicht mit dem Modell überein")
    for key in ("checkpoint", "config"):
        if (engine.get(key) or {}).get("file") != descriptor[key]["file"]:
            raise ProtocolError("REMOTE_MODEL_INCOMPATIBLE", f"{key} stimmt nicht mit dem Katalog überein")
    if engine["checkpoint"].get("sha256") != descriptor["checkpoint"]["sha256"]:
        raise ProtocolError("REMOTE_MODEL_INCOMPATIBLE", "Checkpoint-Hash im Job passt nicht zur Worker-Version")
    profile = engine.get("profile")
    profiles = descriptor["qualityProfile"]
    if profile not in profiles["serves"]:
        raise ProtocolError("STEM_CONFIG_INVALID", "Nicht unterstütztes Qualitätsprofil")
    for key, expected in (("numOverlap", profiles["numOverlap"][profile]),
                          ("ensemblePasses", profiles["ensemblePasses"][profile]),
                          ("chunkSizeSamples", descriptor["chunkSizeSamples"])):
        if engine.get(key, 1 if key == "ensemblePasses" else expected) != expected:
            raise ProtocolError("STEM_CONFIG_INVALID", f"{key} passt nicht zum Qualitätsprofil")


def download(url, target, expected_hash=None):
    target = Path(target)
    if target.is_file() and expected_hash and sha256_file(str(target)) == expected_hash:
        print(f"Verifiziert vorhanden: {target.name}", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".part")
    for attempt in range(3):
        try:
            print(f"Download {target.name}, Versuch {attempt + 1}/3", flush=True)
            with urllib.request.urlopen(url, timeout=60) as response, temp.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            if expected_hash and sha256_file(str(temp)) != expected_hash:
                raise ValueError("SHA256 stimmt nicht mit dem Modellkatalog überein")
            if not temp.stat().st_size:
                raise ValueError("Leerer Download")
            os.replace(temp, target)
            return
        except Exception:
            temp.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def preflight(model_dir, adapter, device):
    import torch
    import torchaudio  # require compatible binary pair, even before a job arrives
    import numpy
    import soundfile
    import scipy.signal
    import yaml
    import ml_collections
    descriptor = model()
    checkpoint = Path(model_dir) / descriptor["checkpoint"]["file"]
    expected = descriptor["checkpoint"]["sha256"]
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or not checkpoint.is_file() or sha256_file(str(checkpoint)) != expected:
        raise ProtocolError("MODEL_CORRUPT", "Modell fehlt oder Hash falsch. Setup-Zelle erneut ausführen.")
    config_file = Path(model_dir) / descriptor["config"]["file"]
    spec = importlib.util.spec_from_file_location("airdox_adapter", adapter)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Release YAML contains !!python/tuple. Use the production adapter's
    # restricted SafeLoader extension, never yaml.UnsafeLoader/FullLoader.
    config = module.load_config_dict(str(config_file))
    if list(config.training.instruments) != descriptor["stemOrder"]:
        raise ProtocolError("MODEL_INCOMPATIBLE", "Konfiguration hat eine andere Stem-Reihenfolge")
    module.import_model_class(descriptor["family"], "")
    if device == "cuda" and not torch.cuda.is_available():
        raise ProtocolError("GPU_UNAVAILABLE", "CUDA angefordert, aber keine GPU vorhanden. Colab-Laufzeit T4 wählen oder GERAET=auto.")
    actual = "cuda" if device != "cpu" and torch.cuda.is_available() else "cpu"
    if actual == "cuda":
        (torch.ones(8, device="cuda") + 1).sum().item()
    return dict(device=actual, modelId=MODEL_ID, modelSha256=expected,
                torch=torch.__version__, gpu=torch.cuda.get_device_name(0) if actual == "cuda" else None)


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--model-dir", default="/content/models")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = parser.parse_args()
    descriptor = model()
    for key in ("checkpoint", "config"):
        item = descriptor[key]
        download(item["url"], Path(args.model_dir) / item["file"], item.get("sha256"))
    result = preflight(args.model_dir, str(ROOT / "python/bsroformer_inference.py"), args.device)
    print(json.dumps(dict(preflight="PASS", **result), indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if os.environ.get("GITHUB_ACTIONS"):
            message = f"{type(error).__name__}: {error}".replace("%", "%25").replace("\n", "%0A").replace("\r", "%0D")
            print(f"::error title=Colab preflight::{message}", flush=True)
        raise
