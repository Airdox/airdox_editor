#!/usr/bin/env python3
"""Contract stub for the out-of-process backend protocol.

It speaks exactly the JSON Lines protocol of
`src/stems/backends/processTransport.ts` and accepts the same CLI as
`python/bsroformer_inference.py`, so the real transport code (argv building,
progress parsing, stem mapping, cancellation, exit code mapping) is exercised –
only the model is replaced.

Behaviour is controlled by environment variables:
  STUB_CHUNKS            number of progress steps (default 3)
  STUB_SLEEP_MS          delay per progress step (default 0)
  STUB_FAIL_CODE         emit an error message and exit with this code
  STUB_CANCEL_AFTER_STEP cancel itself after N steps (simulates a slow model)
  STUB_STEMS             comma separated stem ids to emit (default from --stem-order)
  STUB_CONFIG_STEM_ORDER report a different configStemOrder (mismatch simulation)
  STUB_REPORT_DEVICE     device reported in the done message (default cpu)
"""
import argparse
from array import array
import json
import os
import signal
import struct
import sys
import time

EXIT_OK = 0
EXIT_CANCELLED = 130


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def write_wav(path, sample_rate, channels, samples, frames):
    """Writes interleaved float32 samples as an IEEE float WAV file."""
    body = samples[: frames * channels].tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(body)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 3, channels, sample_rate,
                                   sample_rate * channels * 4, channels * 4, 32)
    header += b"data" + struct.pack("<I", len(body))
    with open(path, "wb") as handle:
        handle.write(header + body)


def read_wav_samples(path):
    """Returns (sample_rate, channels, frames, samples) of a float32 WAV file."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:4] != b"RIFF":
        emit({"type": "error", "code": "AUDIO_CORRUPT", "message": "Eingabe ist kein RIFF/WAV"})
        raise SystemExit(5)
    offset = 12
    sample_rate = 44100
    channels = 2
    bits = 32
    data = b""
    while offset + 8 <= len(blob):
        chunk_id = blob[offset:offset + 4]
        size = struct.unpack("<I", blob[offset + 4:offset + 8])[0]
        body = offset + 8
        if chunk_id == b"fmt ":
            channels, sample_rate = struct.unpack("<HI", blob[body + 2:body + 8])
            bits = struct.unpack("<H", blob[body + 14:body + 16])[0]
        elif chunk_id == b"data":
            data = blob[body:body + size]
        offset = body + size + (size % 2)
    if bits != 32:
        emit({"type": "error", "code": "AUDIO_CORRUPT", "message": f"Stub erwartet float32, erhielt {bits} Bit"})
        raise SystemExit(5)
    count = len(data) // 4
    samples = array("f")
    samples.frombytes(data[: count * 4])
    return sample_rate, channels, count // channels, samples


def main(argv):
    cancelled = {"flag": False}

    def handle(signum, frame):
        cancelled["flag"] = True
        emit({"type": "log", "level": "warning", "message": "SIGTERM erhalten"})

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    parser = argparse.ArgumentParser()
    parser.add_argument("--family", default="bs_roformer")
    parser.add_argument("--checkpoint", default="")
    parser.add_argument("--config", default="")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stem-order", required=True)
    parser.add_argument("--stems", default="")
    parser.add_argument("--chunk-size", type=int, default=1024)
    parser.add_argument("--num-overlap", type=int, default=2)
    parser.add_argument("--ensemble-passes", type=int, default=1)
    parser.add_argument("--precision", default="f32")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--reference-source-dir", default="")
    parser.add_argument("--allow-random-weights", action="store_true")
    args = parser.parse_args(argv)

    emit({"type": "log", "level": "info", "message": f"stub started family={args.family} device={args.device}"})

    fail_code = os.environ.get("STUB_FAIL_CODE")
    if fail_code:
        emit({"type": "error", "code": fail_code, "message": f"stub failure {fail_code}"})
        mapping = {"MODEL_CORRUPT": 3, "WRITE_DENIED": 4, "AUDIO_CORRUPT": 5, "STEM_CONFIG_INVALID": 2}
        return mapping.get(fail_code, 1)

    steps = int(os.environ.get("STUB_CHUNKS", "3"))
    sleep_ms = int(os.environ.get("STUB_SLEEP_MS", "0"))
    cancel_after = int(os.environ.get("STUB_CANCEL_AFTER_STEP", "0"))
    for step in range(1, steps + 1):
        if sleep_ms:
            time.sleep(sleep_ms / 1000.0)
        if cancelled["flag"]:
            emit({"type": "error", "code": "INFERENCE_CANCELLED", "message": "stub abgebrochen"})
            return EXIT_CANCELLED
        emit({"type": "progress", "fraction": step / steps, "phase": f"stub step {step}/{steps}"})
        if cancel_after and step >= cancel_after:
            # Simulate a backend that keeps running until it is killed.
            while not cancelled["flag"]:
                time.sleep(0.05)
            emit({"type": "error", "code": "INFERENCE_CANCELLED", "message": "stub abgebrochen"})
            return EXIT_CANCELLED

    sample_rate, channels, frames, samples = read_wav_samples(args.input)
    stem_order = [stem for stem in args.stem_order.split(",") if stem]
    requested = [stem for stem in (args.stems or "").split(",") if stem]
    emitted = [stem for stem in stem_order if not requested or stem in requested]
    stems = []
    os.makedirs(args.output_dir, exist_ok=True)
    # The stub splits the input evenly so the emitted stems still sum to the
    # mixture: the engine validator checks recombination and transients, and a
    # protocol double must not fail those checks for the wrong reason.
    share = 1.0 / max(1, len(emitted))
    for index, stem_id in enumerate(stem_order):
        if stem_id not in emitted:
            continue
        target = os.path.join(args.output_dir, f"stem_{index}_{stem_id}.wav")
        split = array("f", [value * share for value in samples])
        write_wav(target, sample_rate, channels, split, frames)
        stems.append({"index": index, "name": stem_id, "path": os.path.abspath(target)})
        emit({"type": "stem", "index": index, "name": stem_id, "path": os.path.abspath(target)})

    # STUB_CONFIG_STEM_ORDER simulates a checkpoint whose own config declares a
    # different stem order than the registry - the engine must reject that.
    reported_order = os.environ.get("STUB_CONFIG_STEM_ORDER")
    config_order = [stem for stem in reported_order.split(",") if stem] if reported_order else stem_order
    # STUB_REPORT_DEVICE lets the stub report the device it really used, e.g.
    # "cpu" although CUDA was requested (fallback path of the engine).
    used_device = os.environ.get("STUB_REPORT_DEVICE", "cpu")
    emit({
        "type": "done",
        "device": used_device,
        "stems": stems,
        "report": {
            "backend": "stub",
            "configStemOrder": config_order,
            "numOverlap": args.num_overlap,
            "precision": args.precision,
            "weights": "random" if args.allow_random_weights else "stub",
        },
    })
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
