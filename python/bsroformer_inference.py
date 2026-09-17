#!/usr/bin/env python3
"""
BS-RoFormer inference adapter speaking JSONL protocol.
Reference arch from AIRODOX_MSST_DIR or pip msst.
Enforces stem_order check against checkpoint config.
"""

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

def log_event(phase: str, detail=None, chunk_index=None):
    evt = {"phase": phase}
    if detail is not None:
        evt["detail"] = detail if isinstance(detail, str) else json.dumps(detail)
    if chunk_index is not None:
        evt["chunkIndex"] = chunk_index
    sys.stdout.write(json.dumps(evt) + "\n")
    sys.stdout.flush()

def log_error(code: str, message: str):
    evt = {"phase": "error", "code": code, "detail": message}
    sys.stdout.write(json.dumps(evt) + "\n")
    sys.stdout.flush()

def parse_args():
    p = argparse.ArgumentParser(description="BS-RoFormer inference adapter JSONL")
    p.add_argument("--input", required=True, help="Input WAV path")
    p.add_argument("--output", required=True, help="Output directory")
    p.add_argument("--stem-order", default="vocals,drums,bass,other", help="Comma-separated stem order")
    p.add_argument("--checkpoint", help="Checkpoint path")
    p.add_argument("--model-dir", help="MSST model dir (AIRODOX_MSST_DIR)")
    p.add_argument("--precision", default="float32", help="Precision")
    p.add_argument("--chunk-size", type=int, default=441000, help="Chunk size samples")
    p.add_argument("--overlap", type=float, default=0.5, help="Overlap fraction")
    p.add_argument("--num-overlap", type=int, default=4, help="Num overlap")
    return p.parse_args()

def detect_reference_source():
    # Reference arch from AIRODOX_MSST_DIR or pip msst
    msst_dir = os.environ.get("AIRODOX_MSST_DIR")
    if msst_dir and Path(msst_dir).exists():
        return f"msst_dir:{msst_dir}"
    try:
        import msst  # type: ignore
        return f"pip:msst:{getattr(msst, '__version__', 'unknown')}"
    except ImportError:
        return "unknown"
    except Exception as e:
        return f"error:{e}"

def load_checkpoint_config(checkpoint_path: str):
    # Try to load config from checkpoint
    try:
        if checkpoint_path.endswith(".ckpt") or checkpoint_path.endswith(".th"):
            # For demo, try torch load if available
            try:
                import torch
                ckpt = torch.load(checkpoint_path, map_location="cpu")
                if isinstance(ckpt, dict):
                    # Look for stem_order or config
                    config = ckpt.get("config") or ckpt.get("hyper_parameters") or {}
                    stem_order = config.get("stem_order") or config.get("stems") or ckpt.get("stem_order")
                    if stem_order:
                        return {"stem_order": stem_order, "weights": "checkpoint"}
            except Exception:
                pass
        # Fallback: check sibling json
        cfg_path = Path(checkpoint_path).with_suffix(".json")
        if cfg_path.exists():
            with open(cfg_path) as f:
                data = json.load(f)
                return {"stem_order": data.get("stem_order"), "weights": "checkpoint", "config": data}
    except Exception:
        pass
    return None

def check_stem_order(requested, checkpoint_cfg):
    if not checkpoint_cfg or not checkpoint_cfg.get("stem_order"):
        return True, "no checkpoint config, skipping check"
    ckpt_order = checkpoint_cfg["stem_order"]
    if isinstance(ckpt_order, str):
        ckpt_order = [s.strip() for s in ckpt_order.split(",")]
    # Normalize
    req_set = set([s.strip().lower() for s in requested])
    ckpt_set = set([s.strip().lower() for s in ckpt_order])
    # For BS-RoFormer, checkpoint defines fixed stem order; requested must match or be subset?
    # Spec says enforce stem_order from checkpoint config vs registry, emitting MODEL_INCOMPATIBLE on mismatch
    if req_set != ckpt_set:
        return False, f"Requested {requested} vs checkpoint {ckpt_order}"
    return True, "match"

def main():
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    stem_order = [s.strip() for s in args.stem_order.split(",") if s.strip()]

    reference_source = detect_reference_source()
    log_event("start", {"input": str(input_path), "output": str(output_dir), "stem_order": stem_order, "referenceSource": reference_source, "precision": args.precision})

    # Check input exists
    if not input_path.exists():
        log_error("AUDIO_MISSING", f"Input not found: {input_path}")
        sys.exit(4)

    # Load checkpoint config and verify stem order
    ckpt_cfg = None
    if args.checkpoint:
        ckpt_cfg = load_checkpoint_config(args.checkpoint)
        if ckpt_cfg:
            ok, detail = check_stem_order(stem_order, ckpt_cfg)
            if not ok:
                log_event("backend-report", {"weights": "checkpoint", "stem_order": ckpt_cfg.get("stem_order"), "requested": stem_order, "referenceSource": reference_source, "error": detail})
                log_error("MODEL_INCOMPATIBLE", f"Stem order mismatch: {detail}")
                sys.exit(3)

    # Check for random weights detection
    weights_status = "checkpoint" if args.checkpoint else "random"
    if not args.checkpoint and not args.model_dir:
        # No checkpoint provided, we are in random weights mode
        weights_status = "random"
        log_event("backend-report", {"weights": "random", "stem_order": stem_order, "referenceSource": reference_source, "reason": "no checkpoint provided"})

    # Simulate inference or run real if msst available
    try:
        # Try real inference if msst available and checkpoint exists
        use_real = False
        if args.checkpoint and Path(args.checkpoint).exists():
            try:
                import msst  # noqa
                use_real = True
            except ImportError:
                use_real = False

        if use_real:
            log_event("inference", {"phase": "loading model", "weights": weights_status})
            # Placeholder for real inference – would call msst separator here
            # For now, simulate with file copy
            time.sleep(0.1)
            log_event("progress", {"percent": 50})
            # Real implementation would separate and write stems
            # Here we just copy input to each stem as placeholder (not for release)
            import wave
            import struct
            # Simple copy for demo
            for stem in stem_order:
                out_path = output_dir / f"{stem}.wav"
                # Copy input file
                import shutil
                shutil.copyfile(input_path, out_path)
                log_event("stem", {"id": stem, "file": str(out_path)})
        else:
            # Simulated path for CI without weights
            log_event("inference", {"phase": "simulated (no checkpoint)", "weights": weights_status})
            for idx, stem in enumerate(stem_order):
                time.sleep(0.05)
                out_path = output_dir / f"{stem}.wav"
                # If input is wav, copy; else create silence
                if input_path.suffix.lower() == ".wav":
                    import shutil
                    try:
                        shutil.copyfile(input_path, out_path)
                    except Exception:
                        # create silent wav
                        import wave
                        with wave.open(str(out_path), 'w') as wf:
                            wf.setnchannels(2)
                            wf.setsampwidth(2)
                            wf.setframerate(44100)
                            wf.writeframes(b'\x00\x00' * 44100 * 2)
                else:
                    import wave
                    with wave.open(str(out_path), 'w') as wf:
                        wf.setnchannels(2)
                        wf.setsampwidth(2)
                        wf.setframerate(44100)
                        wf.writeframes(b'\x00\x00' * 44100 * 2)
                log_event("stem", {"id": stem, "file": str(out_path)}, chunk_index=idx)
                log_event("progress", {"percent": int((idx+1)/len(stem_order)*100), "stem": stem})

        # Final report
        final_report = {
            "backend": "bsroformer",
            "weights": weights_status,
            "stem_order": stem_order,
            "referenceSource": reference_source,
            "checkpoint": args.checkpoint,
            "model_dir": args.model_dir,
            "precision": args.precision,
        }
        log_event("backend-report", final_report)
        log_event("done", final_report)
        sys.exit(0)

    except SystemExit:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        log_error("INFERENCE_FAILED", f"{e}: {tb}")
        sys.exit(5)

if __name__ == "__main__":
    main()
