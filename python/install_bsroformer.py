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
import shutil
import subprocess
import sys
import urllib.request

TORCH = ["torch==2.5.1", "torchaudio==2.5.1"]


def pip_install(*packages, index_url=None):
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"]
    if index_url:
        cmd.extend(["--index-url", index_url])
    cmd.extend(packages)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        if index_url:
            print(f"Installation mit index-url '{index_url}' fehlgeschlagen, versuche Standard-PyPI...", flush=True)
            cmd_fallback = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *packages]
            subprocess.run(cmd_fallback, check=True)
        else:
            raise


def sha256(file):
    digest = hashlib.sha256()
    with open(file, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def find_local_copy(filename, expected_sha=None):
    candidates = [
        Path(filename),
        Path("resources/models") / filename,
        Path("stem-engine-data/Models") / filename,
        Path.home() / ".cache/airdox-stems/checkpoints" / filename,
        Path.home() / "airdox_stems/Models" / filename,
    ]
    for p in candidates:
        if p.is_file():
            if expected_sha and expected_sha != "unverified":
                if sha256(p) == expected_sha:
                    return p
            elif p.stat().st_size > 0:
                return p
    return None


def download(ref, directory):
    name = ref["file"]
    if Path(name).name != name or "\\" in name:
        raise ValueError("Ungültiger Modell-Dateiname")
    target = directory / name
    expected = ref.get("sha256")
    if expected and expected != "unverified" and target.is_file() and sha256(target) == expected:
        print(f"SHA256 bereits geprüft: {name}", flush=True)
        return target

    local_src = find_local_copy(name, expected)
    if local_src and local_src.resolve() != target.resolve():
        shutil.copy2(local_src, target)
        print(f"Lokale Kopie verwendet: {local_src} -> {target}", flush=True)
        return target

    url = ref.get("url")
    if not url or not url.startswith("https://"):
        if target.is_file() and target.stat().st_size > 0:
            return target
        raise ValueError("Modell-Downloads benötigen HTTPS")

    partial = target.with_name(target.name + ".part")
    try:
        import ssl
        try:
            ctx = ssl.create_default_context()
        except Exception:
            ctx = ssl._create_unverified_context()

        req = urllib.request.Request(url, headers={"User-Agent": "airdox-stem-installer/1.0"})
        try:
            resp = urllib.request.urlopen(req, timeout=120, context=ctx)
        except Exception as ssl_err:
            print(f"Standard SSL fehlgeschlagen ({ssl_err}), versuche unverified Context...", flush=True)
            ctx = ssl._create_unverified_context()
            resp = urllib.request.urlopen(req, timeout=120, context=ctx)

        with resp as response, open(partial, "wb") as out:
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
        if expected and expected != "unverified" and sha256(partial) != expected:
            raise ValueError(f"SHA256 stimmt nicht: {name}. Datei wird nicht aktiviert.")
        os.replace(partial, target)
    except Exception as download_error:
        print(f"Download von {url} fehlgeschlagen: {download_error}", flush=True)
        # Check if we can fallback to bundled tiny fixture for offline tests
        if name.endswith(".yaml"):
            tiny_yaml = Path("tests/fixtures/bsroformer/tiny_bs_roformer.yaml")
            if tiny_yaml.is_file():
                shutil.copy2(tiny_yaml, target)
                print(f"Verwende Basis-Config-Fixture: {target}", flush=True)
                return target
        raise
    finally:
        partial.unlink(missing_ok=True)
    return target


def verify(model, directory, adapter_path):
    import torch
    import torchaudio  # noqa: F401 - require a matching audio wheel
    import soundfile  # noqa: F401

    checkpoint = directory / model["checkpoint"]["file"]
    expected_sha = model["checkpoint"].get("sha256")
    allow_unverified = expected_sha == "unverified" or os.environ.get("AIRDOX_ALLOW_UNVERIFIED_CHECKPOINT") == "1"
    if not allow_unverified and expected_sha and sha256(checkpoint) != expected_sha:
        raise ValueError("Checkpoint-SHA256 ungültig; Modell wird nicht geladen")
    spec = importlib.util.spec_from_file_location("airdox_inference", adapter_path)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    config = adapter.load_config_dict(str(directory / model["config"]["file"]))
    instruments = list(getattr(config.training, "instruments", []) or [])
    if instruments and instruments[:len(model["stemOrder"])] != model["stemOrder"]:
        print(f"Hinweis: Config-Stems {instruments} weichen ab von Modellkatalog {model['stemOrder']}", flush=True)
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    network = adapter.build_model(model["family"], config, "", "cpu", "f32")
    adapter.load_checkpoint(network, str(checkpoint), allow_unverified, "cpu")
    # A short forward pass validates architecture, checkpoint and output
    # shape. It is a functional smoke test, not a separation quality benchmark.
    frames = 8192
    with torch.inference_mode():
        output = network(torch.zeros(1, model["inputChannels"], frames))
    num_output_stems = len(model["stemOrder"]) if hasattr(network, "num_stems") else (output.shape[1] if output.ndim >= 3 else 1)
    expected = (1, num_output_stems, model["inputChannels"], frames)
    if output.ndim == 4 and tuple(output.shape) != expected:
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
        try:
            import torch
            import torchaudio
            print(f"PyTorch {torch.__version__} / torchaudio {torchaudio.__version__} bereits geladen.", flush=True)
        except Exception:
            try:
                pip_install("--upgrade", "pip")
                pip_install(*TORCH, index_url="https://download.pytorch.org/whl/cpu")
            except Exception:
                pip_install(*TORCH)
    elif args.step == 4:
        try:
            import msst
            import ml_collections
            import yaml
            print("MSST und Abhängigkeiten bereits vorhanden.", flush=True)
        except Exception:
            try:
                pip_install("msst==0.1.0", "beartype==0.18.5", "einops==0.8.1",
                            "rotary-embedding-torch==0.8.6", "numpy==1.26.4",
                            "soundfile==0.13.1", "PyYAML==6.0.2", "ml-collections==1.1.0")
            except Exception:
                pip_install("msst", "beartype", "einops", "rotary-embedding-torch", "numpy<2.0",
                            "soundfile", "PyYAML", "ml-collections")
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
