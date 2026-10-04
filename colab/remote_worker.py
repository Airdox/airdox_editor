#!/usr/bin/env python3
"""Colab worker for the versioned airdox remote-stem job protocol.

The editor is the source of truth for job creation/import.  This worker only
claims a Drive-backed job, verifies the copied input, runs the existing
``python/bsroformer_inference.py`` adapter and publishes validated WAVs plus
hashes.  All protocol code uses the Python standard library so ``--help``,
``--check-store`` and ``--self-test`` do not require Torch or a GPU.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Optional

SCHEMA_VERSION = 1
REMOTE_STATUSES = {
    "PENDING", "PREPARING", "RUNNING", "RECONSTRUCTING", "VALIDATING",
    "COMPLETED", "CANCELLED", "FAILED",
}
TERMINAL_STATUSES = {"COMPLETED", "CANCELLED", "FAILED"}
DEFAULT_STEMS = ["drums", "bass", "other", "vocals"]
DEFAULT_MODEL = "bsroformer-musdb18hq-4stem-zfturbo"
DEFAULT_ROOT = Path("/content/drive/MyDrive/airdox_stem_bridge")
JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$")
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")

# Legacy names retained for the existing Colab utilities and their unit tests.
BRIDGE_ROOT = DEFAULT_ROOT
WORKER_STATUS = BRIDGE_ROOT / "worker.status.json"
JOBS_ROOT = BRIDGE_ROOT / "jobs"
MODEL_NAME = DEFAULT_MODEL
STEM_ORDER = list(DEFAULT_STEMS)
HEARTBEAT_INTERVAL = 15
MAX_AGE_STALE = 75


# ---------------------------------------------------------------------------
# Shared, safe JSON / path / manifest helpers
# ---------------------------------------------------------------------------
def atomic_write_json(path: Path, data: dict) -> None:
    """Write JSON via a same-directory temporary file and atomic replace."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temp_path), str(path))
        # Directory fsync is available on Linux/Colab, but not on every host.
        try:
            directory_fd = os.open(str(path.parent), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except (AttributeError, OSError):
            pass
    finally:
        try:
            temp_path.unlink()
        except OSError:
            pass


def atomic_read_json(path: Path, default: Optional[dict] = None) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else default
    except (OSError, ValueError, TypeError):
        return default


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_job_id(value: Any) -> bool:
    return isinstance(value, str) and bool(JOB_ID_PATTERN.fullmatch(value)) and ".." not in value


def _safe_relative_parts(value: Any) -> list[str]:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value or value.startswith("/"):
        raise ValueError(f"Unsicherer relativer Pfad im Manifest: {value!r}")
    if re.match(r"^[A-Za-z]:", value):
        raise ValueError(f"Unsicherer relativer Pfad im Manifest: {value!r}")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Unsicherer relativer Pfad im Manifest: {value!r}")
    return parts


def safe_job_path(root: Path, relative: str) -> Path:
    """Resolve a manifest-relative path without allowing it outside ``root``."""
    parts = _safe_relative_parts(relative)
    root_resolved = Path(root).resolve()
    resolved = root_resolved.joinpath(*parts).resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError as error:
        raise ValueError(f"Pfad verlässt die Jobablage: {relative!r}") from error
    return resolved


def validate_manifest(manifest: Any, expected_job_id: Optional[str] = None) -> dict:
    """Validate the shared v1 manifest before trusting any path or job field."""
    if not isinstance(manifest, dict):
        raise ValueError("Manifest ist kein JSON-Objekt")
    version = manifest.get("schemaVersion")
    if type(version) is not int or version != SCHEMA_VERSION:
        raise ValueError(f"Manifest-Schema {version!r} wird nicht unterstützt (erwartet {SCHEMA_VERSION})")

    job_id = manifest.get("jobId")
    if not _safe_job_id(job_id):
        raise ValueError(f"Ungültige jobId im Manifest: {job_id!r}")
    if expected_job_id is not None and job_id != expected_job_id:
        raise ValueError(f"Manifest-Id {job_id} passt nicht zum Verzeichnis {expected_job_id}")
    status = manifest.get("status")
    if not isinstance(status, str) or status not in REMOTE_STATUSES:
        raise ValueError(f"Unbekannter Status {status!r}")

    input_data = manifest.get("input")
    if not isinstance(input_data, dict):
        raise ValueError("Manifest ohne input-Block")
    for field in ("fileName", "relativePath", "sha256"):
        if not isinstance(input_data.get(field), str) or not input_data[field]:
            raise ValueError(f"Manifest-Feld input.{field} fehlt oder ist leer")
    if not SHA256_PATTERN.fullmatch(input_data["sha256"]):
        raise ValueError("Manifest-Feld input.sha256 ist kein SHA-256-Hash")
    input_parts = _safe_relative_parts(input_data["relativePath"])
    if input_parts[:3] != ["jobs", job_id, "input"] or len(input_parts) != 4:
        raise ValueError("input.relativePath muss auf jobs/<jobId>/input/<datei> zeigen")

    engine = manifest.get("engine")
    if not isinstance(engine, dict):
        raise ValueError("Manifest ohne engine-Block")
    for field in ("modelId", "profile"):
        if not isinstance(engine.get(field), str) or not engine[field]:
            raise ValueError(f"Manifest-Feld engine.{field} fehlt oder ist leer")
    stems = engine.get("stems")
    if (
        not isinstance(stems, list)
        or not stems
        or any(not isinstance(stem, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", stem) for stem in stems)
        or len(set(stems)) != len(stems)
    ):
        raise ValueError("Manifest ohne gültige engine.stems-Liste")
    stem_order = engine.get("stemOrder", stems)
    if (
        not isinstance(stem_order, list)
        or any(not isinstance(stem, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", stem) for stem in stem_order)
        or set(stem_order) != set(stems)
    ):
        raise ValueError("Manifest engine.stemOrder passt nicht zu engine.stems")

    output = manifest.get("output")
    if output is None:
        output = {"stems": []}
        manifest["output"] = output
    if not isinstance(output, dict) or not isinstance(output.get("stems", []), list):
        raise ValueError("Manifest output.stems ist keine Liste")
    for stem in output.get("stems", []):
        if not isinstance(stem, dict):
            raise ValueError("Manifest enthält einen ungültigen Stem-Eintrag")
        for field in ("id", "fileName", "relativePath", "sha256"):
            if not isinstance(stem.get(field), str) or not stem[field]:
                raise ValueError(f"Manifest-Feld output.stems[].{field} fehlt")
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", stem["id"]):
            raise ValueError(f"Ungültige Stem-ID im Manifest: {stem['id']!r}")
        output_parts = _safe_relative_parts(stem["relativePath"])
        if output_parts[:3] != ["jobs", job_id, "output"] or len(output_parts) != 4:
            raise ValueError("output.stems[].relativePath muss auf jobs/<jobId>/output/<datei> zeigen")
        if not SHA256_PATTERN.fullmatch(stem["sha256"]):
            raise ValueError(f"Manifest-Hash für Stem {stem['id']} ist ungültig")
    return manifest


def load_manifest(path: Path, expected_job_id: Optional[str] = None) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    return validate_manifest(raw, expected_job_id)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _touch_manifest(manifest: dict, **updates: Any) -> dict:
    result = dict(manifest)
    result.update(updates)
    now = _now_ms()
    result["updatedAt"] = now
    result["updatedAtIso"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now / 1000)) + f".{now % 1000:03d}Z"
    return result


def _job_relative(job_id: str, *parts: str) -> str:
    return "/".join(("jobs", job_id, *parts))


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(temp_path, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temp_path), str(path))
    finally:
        try:
            temp_path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Legacy helpers retained for tests/notebooks from the earlier layout
# ---------------------------------------------------------------------------
def force_drive_refresh(target_dir: Path) -> None:
    """Nudge Drive/FUSE to refresh directory metadata without modifying it."""
    try:
        os.sync()
    except (AttributeError, OSError):
        pass
    try:
        os.listdir(str(target_dir))
    except OSError:
        pass
    time.sleep(0.01)


class HeartbeatWorker:
    def __init__(self, root: Path = BRIDGE_ROOT):
        self.root = Path(root)
        self.status_path = self.root / "worker.status.json"
        self.current_job: Optional[str] = None
        self.status = "IDLE"
        self.model = MODEL_NAME

    def tick(self, vram_free_mb: int = 0) -> None:
        atomic_write_json(self.status_path, {
            "timestamp": int(time.time()),
            "status": self.status,
            "current_job": self.current_job,
            "vram_free_mb": vram_free_mb,
            "model": self.model,
        })

    def set_job(self, job_id: Optional[str]) -> None:
        self.current_job = job_id
        self.status = "PROCESSING" if job_id else "IDLE"
        self.tick()


def claim_job(job_dir: Path) -> bool:
    """Legacy ``claim.lock`` helper; v1 jobs use ``claim.json`` leases."""
    lock_path = Path(job_dir) / "claim.lock"
    if lock_path.exists():
        try:
            if time.time() - lock_path.stat().st_mtime < 30:
                return False
        except OSError:
            return False
    atomic_write_json(lock_path, {
        "claimed_at": int(time.time()),
        "worker": "colab-bsroformer",
        "model": MODEL_NAME,
    })
    return True


class ProgressWriter:
    def __init__(self, progress_path: Path):
        self.path = Path(progress_path)

    def update(self, percent: int, phase: str = "BS-RoFormer Inferenz läuft...") -> None:
        atomic_write_json(self.path, {"percent": percent, "phase": phase, "updated_at": int(time.time())})


def write_done_manifest(output_dir: Path, job_id: str, stems: list) -> Path:
    """Legacy ``done.json`` writer retained for backwards-compatible diagnostics."""
    output_dir = Path(output_dir)
    files_meta = {}
    for stem in stems:
        candidate = output_dir / f"{stem}.wav"
        if not candidate.exists() and (output_dir / f"{stem}.flac").exists():
            candidate = output_dir / f"{stem}.flac"
        if candidate.exists():
            files_meta[f"{stem}.wav"] = {
                "bytes": candidate.stat().st_size,
                "sha256": sha256_file(candidate),
                "path": candidate.name,
            }
    done_path = output_dir.parent / "done.json"
    atomic_write_json(done_path, {
        "job_id": job_id,
        "status": "COMPLETED",
        "model": MODEL_NAME,
        "completed_at": int(time.time()),
        "files": files_meta,
    })
    return done_path


def prepare_input(job_dir: Path, manifest: Optional[dict] = None) -> Path:
    """Legacy input selector; prefer lossless originals when several exist."""
    input_dir = Path(job_dir) / "input"
    candidates = [
        entry for entry in input_dir.iterdir()
        if entry.is_file() and entry.suffix.lower() in (".flac", ".wav", ".mp3", ".aiff", ".ogg")
    ]
    if not candidates:
        raise FileNotFoundError(f"Kein Eingabefile in {input_dir}")
    candidates.sort(key=lambda item: (0 if item.suffix.lower() == ".flac" else 1 if item.suffix.lower() == ".mp3" else 2, item.name))
    return candidates[0]


# ---------------------------------------------------------------------------
# Protocol v1 worker
# ---------------------------------------------------------------------------
def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="airdox BS-RoFormer Remote Worker (versioniertes Job-Manifest)",
        allow_abbrev=False,
    )
    parser.add_argument("--root", default=os.environ.get("AIRODOX_STEM_REMOTE_DIR", str(DEFAULT_ROOT)),
                        help="Wurzel der lokalen/Google-Drive-Jobablage")
    parser.add_argument("--once", action="store_true", help="Einmal scannen und danach beenden")
    parser.add_argument("--check-store", action="store_true", help="Ablage/Leases/Modellfilter nur lesend diagnostizieren")
    parser.add_argument("--self-test", action="store_true", help="Protokoll- und Abbruch-Selbsttest ohne Torch/GPU")
    parser.add_argument("--model-dir", default=os.environ.get("AIRODOX_STEM_MODEL_DIR", "/content/models"),
                        help="Ordner mit Modell-Checkpoint und optionaler Konfiguration")
    parser.add_argument("--adapter", default=str(Path(__file__).resolve().parent.parent / "python" / "bsroformer_inference.py"),
                        help="Vorhandener BS-RoFormer-Adapter (Python-Datei)")
    parser.add_argument("--work-dir", default=str(Path(tempfile.gettempdir()) / "airdox-remote-worker"),
                        help="Lokaler, temporärer Arbeitsordner")
    parser.add_argument("--device", default="auto", help="Rechengerät (auto, cuda oder cpu)")
    parser.add_argument("--poll", type=float, default=15, help="Sekunden zwischen Jobscans")
    parser.add_argument("--cancel-poll", type=float, default=5,
                        help="Sekunden zwischen Abbruchprüfungen während der Separation")
    parser.add_argument("--worker", default=f"colab-{socket.gethostname()}-{os.getpid()}",
                        help="Stabile Kennung dieses Workers")
    parser.add_argument("--model", default="", help="Optionaler Modellfilter; abweichende Jobs werden übersprungen")
    parser.add_argument("--profile", default="", help="Optionaler Qualitätsprofilfilter")
    parser.add_argument("--max-jobs", type=int, default=0, help="Maximale Jobs pro Lauf; 0 bedeutet unbegrenzt")
    parser.add_argument("--idle-log-seconds", type=float, default=60,
                        help="Intervall für Lebenszeichen im Leerlauf; 0 deaktiviert")
    parser.add_argument("--retry-failed", action="store_true",
                        help="Fehlgeschlagene Jobs (FAILED) automatisch auf PENDING zurücksetzen und abarbeiten")
    parser.add_argument("--clean-finished", action="store_true",
                        help="Bereits abgeschlossene (COMPLETED) oder abgebrochene (CANCELLED) Jobs aus der Ablage entfernen")
    parser.add_argument("--verbose", action="store_true", help="Zusätzliche Diagnoseausgabe")
    return parser.parse_args(argv)


def _say(message: str, verbose: bool = False, *, force: bool = False) -> None:
    if force or verbose:
        print(message, flush=True)


def _write_worker_status(root: Path, options: argparse.Namespace, status: str, job_id: Optional[str] = None) -> None:
    atomic_write_json(root / "worker.status.json", {
        "id": options.worker,
        "workerId": options.worker,
        "host": socket.gethostname(),
        "status": status,
        "currentJob": job_id,
        "heartbeatAt": _now_ms(),
        "heartbeatAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": options.device,
        "version": "colab-python-worker/1",
        "phase": "Inferenz läuft" if status == "PROCESSING" else "Warte auf Jobs",
        "pollSeconds": options.poll,
        "modelId": options.model or None,
    })


def _claim_timestamp_ms(claim: dict) -> Optional[float]:
    for key in ("heartbeatAt", "claimedAt", "timestamp"):
        value = claim.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            # v1 timestamps are milliseconds; tolerate the legacy seconds form.
            return float(value if value > 10_000_000_000 else value * 1000)
    return None


def _claim_is_fresh(claim: Optional[dict], lease_ms: int = 30 * 60 * 1000) -> bool:
    if not isinstance(claim, dict):
        return False
    timestamp = _claim_timestamp_ms(claim)
    return timestamp is not None and max(0, _now_ms() - timestamp) < lease_ms


def _cancel_requested(job_dir: Path, manifest: dict) -> bool:
    return (job_dir / "cancel.flag").exists() or manifest.get("cancelRequested") is True


def _consume_cancel_flag(job_dir: Path) -> None:
    try:
        (job_dir / "cancel.flag").unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # Drive/FUSE can briefly reject a delete; the CANCELLED manifest is
        # still authoritative and the next run can retry consuming the flag.
        pass


def _append_job_log(job_dir: Path, event: str, message: str, **fields: Any) -> None:
    log_dir = job_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = _now_ms()
    claim = atomic_read_json(job_dir / "claim.json") or {}
    level = fields.pop("level", "info")
    record = {
        "id": f"{job_dir.name}:{timestamp}:{uuid.uuid4().hex}",
        "source": "worker",
        "jobId": job_dir.name,
        "at": timestamp,
        "step": event,
        "level": level if level in ("info", "warning", "error") else "info",
        "message": message,
        "workerId": fields.pop("workerId", claim.get("id")),
        **fields,
    }
    try:
        with open(log_dir / "worker.jsonl", "a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        with open(log_dir / "worker.log", "a", encoding="utf-8", newline="\n") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(timestamp / 1000))} {event}: {message}\n")
    except OSError:
        # Logs are useful evidence, not a reason to corrupt/lose an audio job.
        pass


def _set_manifest(job_dir: Path, manifest: dict, **updates: Any) -> dict:
    updated = _touch_manifest(manifest, **updates)
    atomic_write_json(job_dir / "manifest.json", updated)
    return updated


def _mark_cancelled(
    job_dir: Path, manifest: dict, worker: Optional[dict] = None, worker_id: Optional[str] = None
) -> dict:
    worker_data = worker or manifest.get("worker") or {}
    updated = _set_manifest(
        job_dir,
        manifest,
        status="CANCELLED",
        phase="Vom Editor abgebrochen",
        cancelRequested=True,
        worker={**worker_data, "heartbeatAt": _now_ms()},
    )
    _consume_cancel_flag(job_dir)
    _append_job_log(
        job_dir, "worker.cancelled", "Abbruchanforderung erkannt; Ergebnisse werden verworfen.",
        level="warning", workerId=worker_id or worker_data.get("id"),
    )
    return updated


def _write_progress(job_dir: Path, percent: float, phase: str) -> None:
    atomic_write_json(job_dir / "progress.json", {
        "percent": max(0, min(100, int(round(percent)))),
        "phase": phase,
        "updatedAt": _now_ms(),
    })


def _remove_partial_outputs(output_dir: Path, stems: list[str]) -> None:
    for stem in stems:
        for suffix in (".wav", ".flac"):
            try:
                (output_dir / f"{stem}{suffix}").unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
    for name in ("result.json",):
        try:
            (output_dir / name).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _wav_info(path: Path) -> tuple[int, int, int]:
    with wave.open(str(path), "rb") as audio:
        channels = audio.getnchannels()
        rate = audio.getframerate()
        frames = audio.getnframes()
    if channels < 1 or rate < 1 or frames < 1:
        raise ValueError(f"WAV-Datei ist leer oder ungültig: {path.name}")
    return frames, rate, channels


class WorkerCancelled(Exception):
    pass


def _terminate_process(process: subprocess.Popen[str], grace_seconds: float = 1.0) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        pass
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def _run_adapter(
    command: list[str],
    options: argparse.Namespace,
    root: Path,
    job_dir: Path,
    manifest: dict,
    claim: dict,
    local_output: Path,
) -> tuple[int, str]:
    """Run the adapter while polling cancel.flag and refreshing its lease."""
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        process = subprocess.Popen(
            command,
            cwd=str(Path(options.adapter).resolve().parent),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as error:
        raise RuntimeError(f"Adapter konnte nicht gestartet werden: {error}") from error

    lines: queue.Queue[Optional[str]] = queue.Queue()

    def collect_output() -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                lines.put(line.rstrip("\r\n"))
        except (OSError, ValueError):
            # The child can close its pipe while the worker is terminating it.
            pass
        finally:
            lines.put(None)

    reader = threading.Thread(target=collect_output, name="airdox-adapter-output", daemon=True)
    reader.start()
    cancel_interval = max(0.05, float(options.cancel_poll))
    last_heartbeat = 0.0
    last_progress = 3.0
    finished_output: list[str] = []
    reached_eof = False

    def drain_lines() -> None:
        nonlocal last_progress, reached_eof
        while True:
            try:
                line = lines.get_nowait()
            except queue.Empty:
                break
            if line is None:
                reached_eof = True
                continue
            if line:
                finished_output.append(line)
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    _say(f"[adapter] {line}", bool(options.verbose))
                    continue
                if isinstance(event, dict) and event.get("type") == "progress":
                    fraction = event.get("fraction")
                    if isinstance(fraction, (int, float)):
                        last_progress = 3 + max(0, min(1, float(fraction))) * 90
                    phase = str(event.get("phase") or "Inferenz läuft")
                    try:
                        updated = _set_manifest(
                            job_dir, manifest, status="RUNNING", phase=phase,
                            percent=max(3, min(99, int(round(last_progress)))),
                        )
                        manifest.clear()
                        manifest.update(updated)
                    except OSError:
                        pass
                    _write_progress(job_dir, last_progress, phase)
                    _append_job_log(job_dir, "worker.inference_progress", phase, percent=last_progress)
                else:
                    _say(f"[adapter] {line}", bool(options.verbose))

    try:
        while process.poll() is None:
            drain_lines()
            if _cancel_requested(job_dir, manifest):
                _say("abgebrochen (cancel.flag) während der Rechnung", force=True)
                _append_job_log(
                    job_dir, "worker.cancelled", "Abbruch während der Inferenz – Adapter wird beendet.",
                    level="warning", workerId=claim.get("id"),
                )
                _terminate_process(process, grace_seconds=min(1.0, cancel_interval))
                raise WorkerCancelled("Der Editor hat den Abbruch während der Separation angefordert")
            now = time.monotonic()
            if now - last_heartbeat >= 5:
                claim["heartbeatAt"] = _now_ms()
                try:
                    atomic_write_json(job_dir / "claim.json", claim)
                    _write_worker_status(root, options, "PROCESSING", manifest["jobId"])
                except OSError:
                    pass
                last_heartbeat = now
            time.sleep(cancel_interval)
        return_code = process.wait()
        while not reached_eof:
            drain_lines()
            if not reached_eof:
                time.sleep(0.005)
        output = "\n".join(finished_output)
        return return_code, output
    finally:
        if process.poll() is None:
            _terminate_process(process)
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        reader.join(timeout=1)


def _resolve_adapter_command(
    options: argparse.Namespace,
    job_id: str,
    manifest: dict,
    local_input: Path,
    local_output: Path,
) -> list[str]:
    engine = manifest["engine"]
    family = str(engine.get("family") or "bs_roformer")
    if family not in ("bs_roformer", "mel_band_roformer"):
        raise ValueError(f"Der Python-Adapter unterstützt die Architektur {family!r} nicht")

    checkpoint = engine.get("checkpoint") if isinstance(engine.get("checkpoint"), dict) else {}
    checkpoint_name = str(checkpoint.get("file") or "model_bs_roformer_ep_17_sdr_9.6568.ckpt")
    # The manifest carries a file identity, never an arbitrary local path.
    checkpoint_name = Path(checkpoint_name).name
    checkpoint_path = Path(options.model_dir).expanduser() / checkpoint_name

    config_data = engine.get("config") if isinstance(engine.get("config"), dict) else {}
    config_name = str(config_data.get("file") or "")
    config_path = Path(options.model_dir).expanduser() / Path(config_name).name if config_name else None

    stems = engine.get("stemOrder") or engine.get("stems") or DEFAULT_STEMS
    stems = [str(stem) for stem in stems]
    if not stems:
        raise ValueError("Manifest enthält keine Stem-Reihenfolge")
    chunk_size = engine.get("chunkSizeSamples") or engine.get("chunk_size") or 131584
    overlap = engine.get("numOverlap") or engine.get("num_overlap") or 4
    command = [
        sys.executable,
        str(Path(options.adapter).expanduser().resolve()),
        "--family", family,
        "--checkpoint", str(checkpoint_path),
        "--input", str(local_input),
        "--output-dir", str(local_output),
        "--stem-order", ",".join(stems),
        "--stems", ",".join(stems),
        "--chunk-size", str(int(chunk_size)),
        "--num-overlap", str(int(overlap)),
        "--device", str(options.device or "auto"),
    ]
    if config_path is not None:
        command.extend(["--config", str(config_path)])
    return command


def _publish_outputs(
    job_dir: Path,
    manifest: dict,
    local_output: Path,
    claim: dict,
) -> dict:
    job_id = manifest["jobId"]
    stems = manifest["engine"].get("stemOrder") or manifest["engine"].get("stems") or DEFAULT_STEMS
    output_dir = job_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    published = []

    for stem_id in stems:
        stem_id = str(stem_id)
        file_name = f"{stem_id}.wav"
        source = local_output / file_name
        if not source.is_file():
            alternatives = list(local_output.glob(f"stem_*_{stem_id}.wav"))
            if alternatives:
                source = alternatives[0]
            else:
                raise FileNotFoundError(f"Adapter hat den erwarteten Stem nicht geschrieben: {file_name}")
        size = source.stat().st_size
        if size <= 44:
            raise ValueError(f"Adapter hat einen leeren Stem geschrieben: {file_name} ({size} Bytes)")
        frames, sample_rate, channels = _wav_info(source)
        payload_hash = sha256_file(source)
        destination = output_dir / file_name
        with open(source, "rb") as handle:
            _atomic_write_bytes(destination, handle.read())
        published.append({
            "id": stem_id,
            "fileName": file_name,
            "relativePath": _job_relative(job_id, "output", file_name),
            "sha256": payload_hash,
            "bytes": size,
            "frames": frames,
            "sampleRate": sample_rate,
            "channels": channels,
        })

    result_path = output_dir / "result.json"
    completed = _touch_manifest(
        manifest,
        status="COMPLETED",
        phase="Fertig",
        percent=100,
        output={"stems": published, "resultFile": _job_relative(job_id, "output", "result.json")},
        worker={**claim, "heartbeatAt": _now_ms(), "device": claim.get("device", "auto")},
    )
    result_document = {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": job_id,
        "status": "COMPLETED",
        "modelId": completed["engine"]["modelId"],
        "profile": completed["engine"]["profile"],
        "completedAtIso": completed["updatedAtIso"],
        "stems": published,
        "worker": completed.get("worker"),
    }
    atomic_write_json(result_path, result_document)
    # COMPLETED is the commit marker: publish it only after every WAV and the
    # result document are durable in the shared job folder.
    atomic_write_json(job_dir / "manifest.json", completed)
    _append_job_log(job_dir, "worker.completed", f"{len(published)} geprüfte Stems liegen bereit.", stems=[s["id"] for s in published])
    return completed


def _mark_failed(job_dir: Path, manifest: dict, claim: dict, error: Exception) -> None:
    code = getattr(error, "code", None) or "REMOTE_WORKER_FAILED"
    message = str(error)
    failed = _set_manifest(
        job_dir,
        manifest,
        status="FAILED",
        phase="Fehlgeschlagen",
        error={"code": code, "message": message, "at": _now_ms()},
        worker={**claim, "heartbeatAt": _now_ms()},
    )
    atomic_write_json(job_dir / "error.json", {
        "jobId": failed["jobId"], "code": code, "message": message,
        "at": _now_ms(), "worker": claim.get("id"),
    })
    _append_job_log(job_dir, "worker.failed", message, level="error", code=code, workerId=claim.get("id"))


def _process_job(options: argparse.Namespace, root: Path, job_dir: Path, manifest: dict) -> str:
    job_id = manifest["jobId"]
    output_dir = job_dir / "output"

    if _cancel_requested(job_dir, manifest):
        _mark_cancelled(job_dir, manifest, worker_id=options.worker)
        _say(f"Job {job_id}: abgebrochen (cancel.flag) vor dem Start", force=True)
        return "cancelled"

    existing_claim = atomic_read_json(job_dir / "claim.json")
    if _claim_is_fresh(existing_claim) and existing_claim.get("id") != options.worker:
        _say(f"Job {job_id}: frisch beansprucht von {existing_claim.get('id')}; übersprungen", force=True)
        return "skipped"

    claim = {
        "id": options.worker,
        "host": socket.gethostname(),
        "claimedAt": _now_ms(),
        "heartbeatAt": _now_ms(),
        "device": options.device,
        "version": "colab-python-worker/1",
    }
    job_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(job_dir / "claim.json", claim)
    _write_worker_status(root, options, "PROCESSING", job_id)
    manifest = _set_manifest(
        job_dir,
        manifest,
        status="RUNNING",
        phase="Arbeitskopie wird geladen",
        percent=1,
        attempts=int(manifest.get("attempts") or 0) + 1,
        worker=claim,
    )
    _append_job_log(job_dir, "worker.claimed", "Worker hat den Job beansprucht.", worker=options.worker)

    work_root = Path(options.work_dir).expanduser().resolve() / job_id
    local_output = work_root / "output"
    try:
        work_root.mkdir(parents=True, exist_ok=True)
        local_output.mkdir(parents=True, exist_ok=True)
        _remove_partial_outputs(local_output, list(manifest["engine"].get("stems") or DEFAULT_STEMS))
        input_path = safe_job_path(root, manifest["input"]["relativePath"])
        expected_bytes = int(manifest.get("input", {}).get("bytes") or 0)
        wait_deadline = time.monotonic() + 300
        while time.monotonic() < wait_deadline:
            try:
                if hasattr(os, "sync"):
                    os.sync()
            except Exception:
                pass
            if input_path.is_file() and (expected_bytes == 0 or input_path.stat().st_size >= expected_bytes):
                break
            _say(f"Warte auf vollständige Cloud-Synchronisation der Eingabedatei ({input_path.name}) …", force=True)
            _write_worker_status(root, options, "PROCESSING", job_id)
            time.sleep(5)
        if not input_path.is_file():
            raise FileNotFoundError(f"Eingabedatei fehlt in der Jobablage: {manifest['input']['relativePath']}")
        input_hash = sha256_file(input_path)
        if input_hash.lower() != manifest["input"]["sha256"].lower():
            raise ValueError(
                f"SHA-256 der Arbeitskopie stimmt nicht ({input_hash[:12]}… statt {manifest['input']['sha256'][:12]}…)"
            )
        local_input = work_root / Path(manifest["input"]["fileName"]).name
        shutil.copyfile(input_path, local_input)
        _append_job_log(job_dir, "worker.input_verified", "Arbeitskopie wurde per SHA-256 verifiziert.", sha256=input_hash)
        manifest = _set_manifest(job_dir, manifest, phase="Eingabe verifiziert", percent=2)
        _write_progress(job_dir, 2, "Eingabe verifiziert")

        command = _resolve_adapter_command(options, job_id, manifest, local_input, local_output)
        adapter_path = Path(command[1])
        if not adapter_path.is_file():
            raise FileNotFoundError(f"Adapter fehlt: {adapter_path}")
        _append_job_log(job_dir, "worker.inference_started", f"Inferenz mit {manifest['engine']['modelId']} gestartet.", device=options.device)
        manifest = _set_manifest(job_dir, manifest, phase="Inferenz läuft", percent=3)
        _write_progress(job_dir, 3, "Inferenz läuft")

        return_code, output = _run_adapter(command, options, root, job_dir, manifest, claim, local_output)
        if return_code != 0:
            if "Numba needs NumPy 2.2 or less" in output or "No module named 'ml_collections'" in output:
                _say("Fehlende oder inkompatible Abhängigkeit erkannt – installiere numpy<=2.2.0 / ml-collections automatisch …", force=True)
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "-q", "numpy<=2.2.0", "ml-collections"],
                    check=False
                )
                _say("Wiederhole Inferenz mit angepasster Python-Umgebung …", force=True)
                return_code, output = _run_adapter(command, options, root, job_dir, manifest, claim, local_output)
            if return_code != 0:
                detail = output.strip().splitlines()[-1] if output.strip() else f"Adapter exit code {return_code}"
                raise RuntimeError(f"Adapter fehlgeschlagen (Exit {return_code}): {detail}")
        if _cancel_requested(job_dir, manifest):
            raise WorkerCancelled("Der Editor hat den Abbruch nach der Separation angefordert")

        # Discard stale public results before committing the newly validated set.
        _remove_partial_outputs(output_dir, list(manifest["engine"].get("stems") or DEFAULT_STEMS))
        _append_job_log(job_dir, "worker.inference_completed", "Inferenz wurde ohne Fehler abgeschlossen.")
        completed = _publish_outputs(job_dir, manifest, local_output, claim)
        _write_progress(job_dir, 100, "Fertig")
        _write_worker_status(root, options, "IDLE")
        _say(f"Job {job_id}: COMPLETED ({', '.join(stem['id'] for stem in completed['output']['stems'])})", force=True)
        return "completed"
    except WorkerCancelled:
        _remove_partial_outputs(local_output, list(manifest["engine"].get("stems") or DEFAULT_STEMS))
        _remove_partial_outputs(output_dir, list(manifest["engine"].get("stems") or DEFAULT_STEMS))
        _mark_cancelled(job_dir, manifest, claim)
        _write_progress(job_dir, 0, "Vom Editor abgebrochen")
        _write_worker_status(root, options, "IDLE")
        return "cancelled"
    except Exception as error:
        expected_stems = list(manifest["engine"].get("stems") or DEFAULT_STEMS)
        _remove_partial_outputs(local_output, expected_stems)
        _remove_partial_outputs(output_dir, expected_stems)
        _mark_failed(job_dir, manifest, claim, error)
        _write_worker_status(root, options, "IDLE")
        _say(f"Job {job_id}: FAILED – {error}", force=True)
        return "failed"
    finally:
        # The lease stays as evidence. Its heartbeat timestamp lets the editor
        # distinguish a finished/stale worker from a live one.
        try:
            claim["heartbeatAt"] = _now_ms()
            atomic_write_json(job_dir / "claim.json", claim)
        except OSError:
            pass


def run_worker_cycle(options: argparse.Namespace, root: Path) -> dict[str, int]:
    jobs_root = root / "jobs"
    jobs_root.mkdir(parents=True, exist_ok=True)
    force_drive_refresh(jobs_root)
    counts = {"scanned": 0, "pending": 0, "processed": 0, "skipped": 0, "failed": 0, "cancelled": 0}
    for job_dir in sorted((entry for entry in jobs_root.iterdir() if entry.is_dir()), key=lambda entry: entry.name):
        if options.max_jobs > 0 and counts["processed"] >= options.max_jobs:
            break
        counts["scanned"] += 1
        manifest_path = job_dir / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = load_manifest(manifest_path, job_dir.name)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            counts["skipped"] += 1
            _say(f"Job {job_dir.name}: Manifest unlesbar – übersprungen ({error})", bool(options.verbose))
            continue
        if manifest["status"] in TERMINAL_STATUSES:
            if getattr(options, "retry_failed", False) and manifest["status"] == "FAILED":
                _say(f"Job {job_dir.name}: Status war FAILED – wird durch --retry-failed erneut auf PENDING gesetzt", force=True)
                manifest = _set_manifest(
                    job_dir,
                    manifest,
                    status="PENDING",
                    phase="Wartet auf den externen Rechner",
                    percent=0,
                )
                try:
                    (job_dir / "claim.json").unlink(missing_ok=True)
                    (job_dir / "error.json").unlink(missing_ok=True)
                except OSError:
                    pass
            elif getattr(options, "clean_finished", False) and manifest["status"] in ("COMPLETED", "CANCELLED"):
                shutil.rmtree(job_dir, ignore_errors=True)
                continue
            else:
                continue
        counts["pending"] += 1
        model_id = str(manifest["engine"].get("modelId") or "")
        profile = str(manifest["engine"].get("profile") or "")
        if options.model and model_id != options.model:
            counts["skipped"] += 1
            _say(f"Job {job_dir.name}: Modell {model_id} passt nicht zum Filter {options.model}; übersprungen", force=True)
            continue
        if options.profile and profile != options.profile:
            counts["skipped"] += 1
            _say(f"Job {job_dir.name}: Profil {profile} passt nicht zum Filter {options.profile}; übersprungen", force=True)
            continue
        result = _process_job(options, root, job_dir, manifest)
        if result in ("completed", "failed", "cancelled"):
            counts["processed"] += 1
            if result == "failed":
                counts["failed"] += 1
            elif result == "cancelled":
                counts["cancelled"] += 1
        else:
            counts["skipped"] += 1
    _write_worker_status(root, options, "IDLE")
    print("worker.poll " + json.dumps(counts, ensure_ascii=False), flush=True)
    return counts


def check_store(root: Path, options: argparse.Namespace) -> int:
    """Read-only status report. Missing roots are never created by diagnostics."""
    root = Path(root).expanduser()
    if not root.is_dir():
        print(f"Jobablage existiert nicht: {root}")
        return 1
    jobs_root = root / "jobs"
    if not jobs_root.is_dir():
        print(f"Jobablage ohne jobs-Ordner: {root}")
        print("Urteil: Der Notebook-Worker kann hier keine Jobs finden.")
        return 0

    job_dirs = sorted((entry for entry in jobs_root.iterdir() if entry.is_dir()), key=lambda entry: entry.name)
    if not job_dirs:
        print(f"0 Job(s) in der Ablage: {root}")
        print("Urteil: Ablage erreichbar, derzeit keine offenen Jobs.")
        return 0

    for job_dir in job_dirs:
        manifest_path = job_dir / "manifest.json"
        if not manifest_path.is_file():
            print(f"{job_dir.name}: manifest.json fehlt")
            print("Urteil: Job-Steckbrief fehlt; Editor-/Upload-Pfad prüfen.")
            continue
        try:
            manifest = load_manifest(manifest_path, job_dir.name)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"{job_dir.name}: Manifest ungültig ({error})")
            print("Urteil: Manifest-Schema oder Ablagepfad prüfen.")
            continue

        claim = atomic_read_json(job_dir / "claim.json")
        fresh_claim = manifest["status"] not in TERMINAL_STATUSES and _claim_is_fresh(claim)
        model_id = str(manifest["engine"].get("modelId") or "")
        profile = str(manifest["engine"].get("profile") or "")
        cancel_exists = (job_dir / "cancel.flag").exists()
        if fresh_claim:
            lease_text = f"frisch beansprucht von {claim.get('id', 'unbekannt')}"
        else:
            lease_text = "ohne Lease"
        print(
            f"{job_dir.name} | Status: {manifest['status']} | Modell: {model_id} | Profil: {profile} "
            f"| Lease: {lease_text} | Abbruchfahne: {'JA' if cancel_exists else 'nein'}"
        )
        if manifest.get("phase"):
            print(f"  Phase: {manifest['phase']}")

        if cancel_exists or manifest.get("cancelRequested"):
            print("Urteil: Abbruchfahne liegt bereit; der Worker setzt den Job auf CANCELLED.")
        elif manifest["status"] in TERMINAL_STATUSES:
            print(f"Urteil: Job ist bereits {manifest['status']} und wird nicht erneut gerechnet.")
        elif options.model and options.model != model_id:
            print(f"Urteil: Modellfilter {options.model} passt nicht; der Worker würde den Job überspringen.")
        elif options.profile and options.profile != profile:
            print(f"Urteil: Profilfilter {options.profile} passt nicht; der Worker würde den Job überspringen.")
        elif fresh_claim:
            print("Urteil: Job ist frisch beansprucht; der externe Rechner arbeitet bereits.")
        elif manifest.get("phase"):
            print(f"Urteil: {manifest['phase']} – kein frischer Worker-Claim ist sichtbar.")
        else:
            print("Urteil: Job wartet auf den externen Rechner (Google Drive) – Worker/Notebook prüfen.")
    return 0


def _make_self_test_manifest(job_id: str, input_bytes: bytes) -> dict:
    input_rel = _job_relative(job_id, "input", "mix.wav")
    now = _now_ms()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": job_id,
        "createdAt": now,
        "updatedAt": now,
        "createdAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "updatedAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "PENDING",
        "phase": "Wartet auf den externen Rechner (Google Drive)",
        "percent": 0,
        "idempotencyKey": hashlib.sha256(input_bytes).hexdigest(),
        "origin": {"app": "airdox_SMART_Editor", "version": "self-test"},
        "input": {
            "fileName": "mix.wav", "relativePath": input_rel,
            "sha256": hashlib.sha256(input_bytes).hexdigest(), "bytes": len(input_bytes),
        },
        "engine": {
            "backend": "bs_roformer", "family": "bs_roformer",
            "modelId": DEFAULT_MODEL, "profile": "HIGH_QUALITY",
            "stems": list(DEFAULT_STEMS), "stemOrder": list(DEFAULT_STEMS),
            "checkpoint": {"file": "model.ckpt"}, "chunkSizeSamples": 131584, "numOverlap": 4,
        },
        "output": {"stems": []}, "attempts": 0,
    }


def self_test() -> int:
    """Exercise pre-start and in-flight cancellation without /content or Torch."""
    with tempfile.TemporaryDirectory(prefix="airdox-worker-selftest-") as temporary:
        base = Path(temporary)
        root = base / "drive"
        jobs_root = root / "jobs"
        jobs_root.mkdir(parents=True)
        work_dir = base / "work"
        adapter = base / "slow_adapter.py"
        adapter.write_text(
            "import argparse, os, time\n"
            "p=argparse.ArgumentParser(allow_abbrev=False)\n"
            "for n in ('--family','--checkpoint','--input','--output-dir','--stem-order','--stems','--chunk-size','--num-overlap','--device','--config'):\n"
            "    p.add_argument(n)\n"
            "a=p.parse_args()\n"
            "os.makedirs(a.output_dir, exist_ok=True)\n"
            "open(os.path.join(a.output_dir, 'adapter-started'), 'w').write('started')\n"
            "time.sleep(20)\n",
            encoding="utf-8",
        )
        input_bytes = b"self-test audio input"
        job_ids = [
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        ]
        for job_id in job_ids:
            job_dir = jobs_root / job_id
            input_dir = job_dir / "input"
            input_dir.mkdir(parents=True)
            (input_dir / "mix.wav").write_bytes(input_bytes)
            atomic_write_json(job_dir / "manifest.json", _make_self_test_manifest(job_id, input_bytes))
        before_job = jobs_root / job_ids[0]
        (before_job / "cancel.flag").write_text("{}", encoding="utf-8")

        options = argparse.Namespace(
            root=str(root), model_dir=str(base / "models"), adapter=str(adapter), work_dir=str(work_dir),
            device="cpu", worker="self-test-worker", model="", profile="", max_jobs=0,
            cancel_poll=0.05, poll=0.1, verbose=False,
        )
        holder: dict[str, Any] = {}

        def process_cycle() -> None:
            try:
                holder["counts"] = run_worker_cycle(options, root)
            except BaseException as error:  # surface thread failures below
                holder["error"] = error

        thread = threading.Thread(target=process_cycle, name="airdox-worker-selftest")
        thread.start()
        during_job = jobs_root / job_ids[1]
        started_marker = work_dir / job_ids[1] / "output" / "adapter-started"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and thread.is_alive() and not started_marker.exists():
            time.sleep(0.02)
        if not started_marker.exists():
            thread.join(timeout=2)
            if "error" in holder:
                raise holder["error"]
            raise RuntimeError("Selbsttest konnte den Adapter nicht starten")
        (during_job / "cancel.flag").write_text("{}", encoding="utf-8")
        thread.join(timeout=10)
        if thread.is_alive():
            raise RuntimeError("Selbsttest: Abbruch während der Rechnung hat den Adapter nicht beendet")
        if "error" in holder:
            raise holder["error"]

        first = load_manifest(before_job / "manifest.json", job_ids[0])
        second = load_manifest(during_job / "manifest.json", job_ids[1])
        if first["status"] != "CANCELLED" or second["status"] != "CANCELLED":
            raise RuntimeError(f"Selbsttest: CANCELLED erwartet, erhalten {first['status']} / {second['status']}")
        if (before_job / "cancel.flag").exists() or (during_job / "cancel.flag").exists():
            raise RuntimeError("Selbsttest: cancel.flag wurde nicht verbraucht")
        if (during_job / "output" / "result.json").exists():
            raise RuntimeError("Selbsttest: abgebrochene Rechnung hat ein Ergebnis veröffentlicht")

    print("abgebrochen (cancel.flag) vor dem Start – Fahne verbraucht")
    print("abgebrochen (cancel.flag) während der Rechnung – Adapter beendet, Ergebnis verworfen")
    print("Selbsttest OK – Manifest, Lease und Abbruch vor/während der Inferenz")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    options = parse_args(argv)
    if options.self_test:
        return self_test()

    root = Path(options.root).expanduser()
    if options.check_store:
        return check_store(root, options)

    root.mkdir(parents=True, exist_ok=True)
    (root / "jobs").mkdir(parents=True, exist_ok=True)
    Path(options.work_dir).expanduser().mkdir(parents=True, exist_ok=True)
    _say(f"Worker {options.worker} bereit; Ablage: {root}", force=True)

    last_idle_notice = time.monotonic()
    while True:
        counts = run_worker_cycle(options, root)
        if options.once:
            print(f"{counts['processed']} Job(s) bearbeitet – Ende (--once)", flush=True)
            return 0
        if counts["processed"] == 0:
            now = time.monotonic()
            if options.idle_log_seconds > 0 and now - last_idle_notice >= options.idle_log_seconds:
                _say("Warte auf Jobs …", force=True)
                last_idle_notice = now
            time.sleep(max(0.1, options.poll))
        else:
            last_idle_notice = time.monotonic()


if __name__ == "__main__":
    sys.exit(main())
