#!/usr/bin/env python3
"""BS-RoFormer / Mel-Band RoFormer inference adapter for airdox SMART Editor.

This is the *development / offline* transport of the stem engine (§7 of the
master prompt: Python is for development, conversion and offline tests – the
shipped application uses a native C++ runtime).

The adapter drives the upstream reference implementation
(ZFTurbo/Music-Source-Separation-Training: `models.bs_roformer.bs_roformer`)
and speaks the JSON Lines protocol of `src/stems/backends/processTransport.ts`:

    {"type":"progress","fraction":0.42,"phase":"..."}
    {"type":"stem","index":0,"name":"vocals","path":"/abs/stem_0_vocals.wav"}
    {"type":"log","level":"info","message":"..."}
    {"type":"error","code":"GPU_OUT_OF_MEMORY","message":"..."}
    {"type":"done","device":"cpu","report":{...}}

Exit codes: 0 ok | 130 cancelled | 2 bad arguments | 3 model problem |
4 IO problem | 5 unsupported audio.

The model – not this script – performs the separation. This file only does
sample format handling, chunking with overlap-add and file IO.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from typing import Dict, List, Optional

EXIT_OK = 0
EXIT_CANCELLED = 130
EXIT_BAD_ARGS = 2
EXIT_MODEL = 3
EXIT_IO = 4
EXIT_AUDIO = 5


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str, level: str = "info") -> None:
    emit({"type": "log", "level": level, "message": message})


class Cancelled(Exception):
    pass


_CANCELLED = False


def _handle_sigterm(signum, frame):  # noqa: ANN001
    global _CANCELLED
    _CANCELLED = True
    log("SIGTERM empfangen – Inferenz wird abgebrochen", "warning")


def check_cancelled() -> None:
    if _CANCELLED:
        raise Cancelled()


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BS-RoFormer inference adapter")
    parser.add_argument("--family", required=True, choices=["bs_roformer", "mel_band_roformer"])
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--config", required=False)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stem-order", required=True, help="comma separated stem ids, index = model output index")
    parser.add_argument("--stems", required=False, default="")
    parser.add_argument("--chunk-size", type=int, required=True)
    parser.add_argument("--num-overlap", type=int, default=4)
    parser.add_argument("--ensemble-passes", type=int, default=1)
    parser.add_argument("--precision", default="f32", choices=["native", "f32", "f16", "bf16", "q8_0"])
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "cuda:0", "mps"])
    parser.add_argument("--reference-source-dir", required=False, default=os.environ.get("AIRODOX_MSST_DIR", ""))
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument(
        "--allow-random-weights",
        action="store_true",
        help="DEVELOPMENT ONLY: build the architecture without trained weights. "
        "The result is NOT a separation and is reported as weights=random.",
    )
    return parser.parse_args(argv)


def load_config_dict(config_path: str):
    import yaml
    from ml_collections import ConfigDict

    class _TupleLoader(yaml.SafeLoader):
        pass

    def _tuple_constructor(loader, node):
        return tuple(loader.construct_sequence(node))

    _TupleLoader.add_constructor("tag:yaml.org,2002:python/tuple", _tuple_constructor)
    with open(config_path, "r", encoding="utf-8") as handle:
        raw = yaml.load(handle, Loader=_TupleLoader)
    return ConfigDict(raw)


def _reference_roots(reference_source_dir: str) -> List[str]:
    """Where `models.bs_roformer.*` can be imported from.

    Two supported sources, in this order:
      1. `--reference-source-dir` / AIRODOX_MSST_DIR – a checkout of
         ZFTurbo/Music-Source-Separation-Training,
      2. the packaged release (`pip install msst`), whose module tree lives in
         `<site-packages>/msst` and is import-identical to the checkout.
    """
    roots: List[str] = []
    if reference_source_dir:
        roots.append(reference_source_dir)
    try:
        import msst  # type: ignore

        roots.append(os.path.dirname(msst.__file__))
    except Exception:  # noqa: BLE001 - optionale Quelle
        pass
    return [root for root in roots if root]


def import_model_class(family: str, reference_source_dir: str):
    """Returns (model class, source root) or raises with an actionable message."""
    try:
        if family == "bs_roformer":
            from msst.models.bs_roformer.bs_roformer import BSRoformer as ModelClass
        else:
            from msst.models.bs_roformer.mel_band_roformer import MelBandRoformer as ModelClass
        import msst
        return ModelClass, os.path.dirname(msst.__file__)
    except Exception:
        pass

    errors: List[str] = []
    for root in _reference_roots(reference_source_dir):
        if root not in sys.path:
            sys.path.insert(0, root)
        try:
            if family == "bs_roformer":
                from models.bs_roformer.bs_roformer import BSRoformer as ModelClass
            else:
                from models.bs_roformer.mel_band_roformer import MelBandRoformer as ModelClass
            return ModelClass, root
        except ImportError as error:
            errors.append(f"{root}: {error}")
    raise RuntimeError(
        "Referenz-Architektur (models.bs_roformer) nicht importierbar. "
        "Abhilfe: `pip install msst` oder --reference-source-dir auf einen Checkout von "
        "ZFTurbo/Music-Source-Separation-Training setzen. Details: " + ("; ".join(errors) or "keine Quelle konfiguriert")
    )


def build_model(family: str, config, reference_source_dir: str, device: str, precision: str):
    import torch

    ModelClass, source_root = import_model_class(family, reference_source_dir)
    globals()["REFERENCE_SOURCE_ROOT"] = source_root
    log(f"Referenz-Architektur: {source_root}")

    model_kwargs = dict(config.model)
    model = ModelClass(**model_kwargs)
    dtype = {
        "f16": torch.float16,
        "bf16": torch.bfloat16,
    }.get(precision)
    if dtype is not None and device != "cpu":
        model = model.to(dtype)
    return model.to(device).eval()


def load_checkpoint(model, checkpoint_path: str, allow_random: bool, device: str) -> str:
    import torch

    if allow_random:
        log("ACHTUNG: --allow-random-weights aktiv. Das Modell ist UNTRAINIERT – "
            "die Ausgabe ist keine Separation.", "warning")
        return "random"
    if not os.path.exists(checkpoint_path):
        emit({"type": "error", "code": "MODEL_MISSING", "message": f"Checkpoint fehlt: {checkpoint_path}"})
        sys.exit(EXIT_MODEL)
    try:
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "MODEL_CORRUPT", "message": f"Checkpoint nicht lesbar: {error}"})
        sys.exit(EXIT_MODEL)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    try:
        model.load_state_dict(state)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "MODEL_INCOMPATIBLE", "message": f"Checkpoint passt nicht zur Architektur: {error}"})
        sys.exit(EXIT_MODEL)
    return "checkpoint"


def read_audio(path: str, sample_rate: int):
    import numpy as np
    import soundfile as sf

    data, file_rate = sf.read(path, dtype="float32", always_2d=True)
    if file_rate != sample_rate:
        emit({
            "type": "error",
            "code": "AUDIO_INVALID_SAMPLE_RATE",
            "message": f"Eingabe hat {file_rate} Hz, das Modell erwartet {sample_rate} Hz",
        })
        sys.exit(EXIT_AUDIO)
    audio = data.T.copy()  # (channels, frames)
    if audio.shape[0] == 1:
        audio = np.concatenate([audio, audio], axis=0)
        log("Mono-Eingabe nach Stereo dupliziert")
    elif audio.shape[0] > 2:
        audio = audio[:2].copy()
        log(f"{audio.shape[0]} Kanäle auf das Front-Paar reduziert", "warning")
    return audio


def write_audio(path: str, audio, sample_rate: int) -> None:
    import soundfile as sf

    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, audio.T, sample_rate, subtype="FLOAT")


def separation_window(chunk_size: int, num_overlap: int):
    import numpy as np

    window = np.ones(chunk_size, dtype="float32")
    fade = max(1, chunk_size // max(2, num_overlap * 2))
    ramp = np.linspace(0.0, 1.0, fade, dtype="float32")
    window[:fade] = ramp
    window[-fade:] = ramp[::-1]
    return window


def run_inference(model, mix, args, config, device: str, progress_offset: float, progress_span: float):
    """Chunked inference with overlap-add – the model does the separation."""
    import numpy as np
    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 2)))
    sample_rate = int(getattr(config.audio, "sample_rate", args.sample_rate))
    chunk_size = int(args.chunk_size)
    num_overlap = max(1, int(args.num_overlap))
    hop = max(1, chunk_size // num_overlap)
    channels, total = mix.shape
    num_stems = int(getattr(config.model, "num_stems", 1))

    estimates = np.zeros((num_stems, channels, total), dtype="float32")
    weights = np.zeros(total, dtype="float32")
    window = separation_window(chunk_size, num_overlap)

    positions = list(range(0, max(1, total - chunk_size + 1), hop))
    if not positions or positions[-1] + chunk_size < total:
        positions.append(max(0, total - chunk_size))
    total_chunks = len(positions) * max(1, args.ensemble_passes)
    processed = 0

    dtype = {"f16": torch.float16, "bf16": torch.bfloat16}.get(args.precision)
    autocast = dtype is not None and str(device).startswith("cuda")

    # inference_mode statt no_grad: deaktiviert zusätzlich die Version-Counter-
    # Buchführung pro Tensor – messbar weniger Overhead bei vielen kleinen
    # Fensteraufrufen (hier: hunderte Chunks pro Track).
    with torch.inference_mode():
        for pass_index in range(max(1, args.ensemble_passes)):
            # Deterministic ensemble shifts (reproducible MAXIMUM_QUALITY runs).
            shift = 0 if pass_index == 0 else ((pass_index * 1011) % 3001) - 1500
            if shift != 0:
                shifted = np.roll(mix, shift, axis=1)
            else:
                shifted = mix
            for index, start in enumerate(positions):
                check_cancelled()
                end = min(start + chunk_size, total)
                segment = shifted[:, start:end]
                if segment.shape[1] < chunk_size:
                    pad = chunk_size - segment.shape[1]
                    segment = np.pad(segment, ((0, 0), (0, pad)), mode="reflect")
                # from_numpy auf einem nicht-kontiguierlichen View zahlt bei
                # .float()/.to(device) einen versteckten Kopiervorgang nach dem
                # anderen – einmal sauber anlegen ist schneller.
                segment = np.ascontiguousarray(segment)
                tensor = torch.from_numpy(segment).float().unsqueeze(0).to(device, non_blocking=True)
                if dtype is not None and not autocast:
                    tensor = tensor.to(dtype)
                if autocast:
                    with torch.autocast(device_type="cuda", dtype=dtype):
                        output = model(tensor)
                else:
                    output = model(tensor)
                if not isinstance(output, torch.Tensor):
                    output = output[0]
                result = output.float().cpu().numpy()[0]  # (num_stems, channels, chunk)
                if result.ndim == 2:  # single stem model may drop the stem axis
                    result = result[None, ...]
                length = end - start
                window_slice = window[:length]
                stem_count = min(num_stems, result.shape[0])
                estimates[:stem_count, :, start:end] += result[:stem_count, :, :length] * window_slice
                if pass_index == 0:
                    weights[start:end] += window_slice
                processed += 1
                emit({
                    "type": "progress",
                    "fraction": progress_offset + progress_span * (processed / total_chunks),
                    "phase": f"pass {pass_index + 1}/{args.ensemble_passes} chunk {index + 1}/{len(positions)}",
                })
            if shift != 0:
                estimates = np.roll(estimates, -shift, axis=2)

    safe = np.maximum(weights, 1e-8)
    estimates = estimates / safe[None, None, :]
    return estimates, sample_rate


def main(argv: List[str]) -> int:
    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)
    args = parse_args(argv)
    started = time.time()

    try:
        import numpy as np  # noqa: F401
        import torch
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "BACKEND_UNAVAILABLE", "message": f"PyTorch nicht verfügbar: {error}"})
        return EXIT_MODEL

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device.startswith("cuda") and not torch.cuda.is_available():
        log("CUDA nicht verfügbar – CPU-Fallback", "warning")
        device = "cpu"
    if device.startswith("cuda"):
        # Kostenloser Speedup ohne Qualitätsänderung an der SDR-Metrik:
        # cudnn autotuned die FFT-/Conv-Kernel, TF32 beschleunigt MatMuls auf
        # Ampere+ deutlich (fp32-Genauigkeit der Speicherung bleibt).
        try:
            torch.backends.cudnn.benchmark = True
            torch.set_float32_matmul_precision("high")
        except Exception:
            pass

    if not args.config:
        emit({"type": "error", "code": "MODEL_MISSING", "message": "Ohne --config kann die Architektur nicht aufgebaut werden"})
        return EXIT_BAD_ARGS

    try:
        config = load_config_dict(args.config)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "MODEL_CORRUPT", "message": f"Config nicht lesbar: {error}"})
        return EXIT_MODEL

    try:
        model = build_model(args.family, config, args.reference_source_dir, device, args.precision)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "MODEL_CORRUPT", "message": f"Modell konnte nicht aufgebaut werden: {error}"})
        return EXIT_MODEL

    weight_state = load_checkpoint(model, args.checkpoint, args.allow_random_weights, device)

    try:
        mix = read_audio(args.input, int(getattr(config.audio, "sample_rate", args.sample_rate)))
    except Cancelled:
        return EXIT_CANCELLED
    except SystemExit as exit_code:
        return int(exit_code.code or EXIT_AUDIO)
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "AUDIO_CORRUPT", "message": f"Eingabe nicht lesbar: {error}"})
        return EXIT_AUDIO

    stem_order = [stem.strip() for stem in args.stem_order.split(",") if stem.strip()]
    if not stem_order:
        emit({"type": "error", "code": "STEM_CONFIG_INVALID", "message": "stem-order ist leer"})
        return EXIT_BAD_ARGS

    # The checkpoint's own config is authoritative for the stem order. A
    # descriptor that disagrees is rejected instead of producing mislabelled
    # stems (§4: niemals blind output[0] = vocals annehmen).
    config_instruments = list(getattr(config.training, "instruments", []) or [])
    target_instrument = getattr(config.training, "target_instrument", None)
    if target_instrument:
        if stem_order[0] != target_instrument:
            emit({
                "type": "error",
                "code": "MODEL_INCOMPATIBLE",
                "message": (
                    f"Checkpoint trennt '{target_instrument}', die Registry erwartet '{stem_order[0]}' an Output-Index 0"
                ),
            })
            return EXIT_MODEL
        log(f"Single-Stem-Checkpoint (target_instrument={target_instrument}); "
            f"weitere Stems werden als Residual abgeleitet: {stem_order[1:] or 'keine'}")
    elif config_instruments:
        expected = config_instruments[: len(stem_order)]
        if expected != stem_order:
            emit({
                "type": "error",
                "code": "MODEL_INCOMPATIBLE",
                "message": (
                    "stem_order passt nicht zu training.instruments des Checkpoints: "
                    f"Registry={stem_order}, Config={config_instruments}"
                ),
            })
            return EXIT_MODEL
        log(f"Multi-Stem-Checkpoint mit training.instruments={config_instruments}")

    try:
        estimates, sample_rate = run_inference(model, mix, args, config, device, 0.05, 0.9)
    except Cancelled:
        emit({"type": "error", "code": "INFERENCE_CANCELLED", "message": "Inferenz abgebrochen"})
        return EXIT_CANCELLED
    except torch.cuda.OutOfMemoryError as error:  # type: ignore[attr-defined]
        emit({"type": "error", "code": "GPU_OUT_OF_MEMORY", "message": str(error)})
        return EXIT_MODEL
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "INFERENCE_FAILED", "message": f"{type(error).__name__}: {error}"})
        return EXIT_MODEL

    channels = mix.shape[0]
    model_stems = estimates.shape[0]
    written: List[dict] = []
    os.makedirs(args.output_dir, exist_ok=True)
    requested = [stem.strip().lower() for stem in (args.stems or "").split(",") if stem.strip()]

    # Model outputs occupy the first entries of stem-order. Any further stem is
    # derived as the residual of the mix (this is exactly how native runtimes
    # produce `instrumental.wav` next to `vocals.wav`).
    derived_residual = None
    for index, stem_id in enumerate(stem_order):
        if requested and stem_id.lower() not in requested:
            continue
        if index < model_stems:
            audio = estimates[index]
        else:
            if derived_residual is None:
                derived_residual = mix.copy()
                for stem_index in range(model_stems):
                    derived_residual -= estimates[stem_index]
                log(f"Stem '{stem_id}' als Residual des Mixes abgeleitet (mix - {model_stems} Modell-Stems)")
            audio = derived_residual
        target = os.path.join(args.output_dir, f"stem_{index}_{stem_id}.wav")
        try:
            write_audio(target, audio, sample_rate)
        except Exception as error:  # noqa: BLE001
            emit({"type": "error", "code": "WRITE_DENIED", "message": f"Stem konnte nicht geschrieben werden: {error}"})
            return EXIT_IO
        written.append({"index": index, "name": stem_id, "path": os.path.abspath(target)})
        emit({"type": "stem", "index": index, "name": stem_id, "path": os.path.abspath(target)})

    emit({
        "type": "done",
        "device": device,
        "stems": written,
        "report": {
            "family": args.family,
            "weights": weight_state,
            "configStemOrder": config_instruments,
            "targetInstrument": target_instrument,
            "precision": args.precision,
            "numOverlap": args.num_overlap,
            "ensemblePasses": args.ensemble_passes,
            "chunkSize": args.chunk_size,
            "sampleRate": sample_rate,
            "channels": channels,
            "modelStems": model_stems,
            "referenceSource": globals().get("REFERENCE_SOURCE_ROOT", ""),
            "seconds": round(time.time() - started, 2),
            "torch": torch.__version__,
        },
    })
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Cancelled:
        sys.exit(EXIT_CANCELLED)
    except BrokenPipeError:
        sys.exit(EXIT_OK)
