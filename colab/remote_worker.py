#!/usr/bin/env python3
"""Drive folder worker, protocol v1 / worker v2.

Run ONE Colab session per job folder. Drive sync is not a distributed lock
service; leases detect conflicts but cannot guarantee cross-client atomicity.
The adapter computes locally; only verified, complete files are published.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Any

SCHEMA_VERSION = 1
WORKER_VERSION = "colab-worker/2"
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}
MODEL_ID = "bsroformer-musdb18hq-4stem-zfturbo"


class ProtocolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: str):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def write_json_atomic(path: str, payload: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def safe_path(root: str, relative: str) -> str:
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Unsicherer relativer Pfad")
    if relative.startswith("/") or any(p in {"", ".", ".."} for p in relative.split("/")):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Pfad verlässt die Jobablage")
    base = Path(root).resolve()
    target = (base / relative).resolve()
    if base not in target.parents:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Pfad/Symlink verlässt die Jobablage")
    return str(target)


def validate_manifest(manifest: dict, expected_job_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{7,63}", expected_job_id) or ".." in expected_job_id:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Ungültige Job-ID")
    if not isinstance(manifest, dict) or manifest.get("jobId") != expected_job_id:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Manifest-ID passt nicht zum Verzeichnis")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ProtocolError("REMOTE_SCHEMA_UNSUPPORTED", "Nicht unterstützte Protokollversion")
    if manifest.get("status") not in TERMINAL_STATUSES | {"PENDING", "PREPARING", "RUNNING", "RECONSTRUCTING", "VALIDATING"}:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Unbekannter Status")
    source = manifest.get("input") or {}
    name = source.get("fileName", "")
    if not isinstance(name, str) or not name or any(c in name for c in "/\\:") or name in {".", ".."}:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Ungültiger Eingabename")
    if source.get("relativePath") != f"jobs/{expected_job_id}/input/{name}":
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Input gehört nicht zu diesem Job")
    if not re.fullmatch(r"[a-f0-9]{64}", str(source.get("sha256", ""))):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Ungültiger Input-Hash")
    engine = manifest.get("engine") or {}
    stems = engine.get("stems")
    if not engine.get("modelId") or not isinstance(stems, list) or not stems or len(stems) != len(set(stems)):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Modell/Stem-Liste fehlt oder ist mehrdeutig")
    if any(s not in {"vocals", "drums", "bass", "other", "instrumental"} for s in stems):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Unbekannter Stem")
    return manifest


def expected_stems(manifest):
    return manifest["engine"]["stems"]


class JobStore:
    def __init__(self, root: str, worker_id: str, lease_seconds: float = 180):
        self.root = os.path.abspath(root)
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.jobs_dir = os.path.join(self.root, "jobs")

    def job_dir(self, job_id):
        return safe_path(self.root, f"jobs/{job_id}")

    def manifest_path(self, job_id):
        return os.path.join(self.job_dir(job_id), "manifest.json")

    def claim_path(self, job_id):
        return os.path.join(self.job_dir(job_id), "claim.json")

    def output_dir(self, job_id):
        return os.path.join(self.job_dir(job_id), "output")

    def list_job_ids(self):
        if not os.path.isdir(self.jobs_dir):
            return []
        return sorted(n for n in os.listdir(self.jobs_dir)
                      if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{7,63}", n)
                      and ".." not in n and os.path.isfile(self.manifest_path(n)))

    def read_manifest(self, job_id):
        return read_json(self.manifest_path(job_id))

    def write_manifest(self, job_id, manifest):
        manifest["updatedAt"] = int(time.time() * 1000)
        manifest["updatedAtIso"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json_atomic(self.manifest_path(job_id), manifest)

    def claim_is_fresh(self, job_id):
        claim = read_json(self.claim_path(job_id))
        if not claim or claim.get("id") == self.worker_id:
            return False
        age = time.time() * 1000 - float(claim.get("heartbeatAt", 0))
        return age < self.lease_seconds * 1000

    def claim(self, job_id, **extra):
        now = int(time.time() * 1000)
        claim = dict(id=self.worker_id, claimedAt=now, heartbeatAt=now, version=WORKER_VERSION, **extra)
        write_json_atomic(self.claim_path(job_id), claim)
        return claim

    def heartbeat(self, job_id, claim):
        owner = read_json(self.claim_path(job_id))
        if owner and owner.get("id") != self.worker_id:
            raise ProtocolError("REMOTE_LEASE_LOST", "Ein anderer Worker hat die Lease übernommen. Nur eine Colab-Sitzung verwenden.")
        claim["heartbeatAt"] = int(time.time() * 1000)
        write_json_atomic(self.claim_path(job_id), claim)

    def cancel_requested(self, job_id):
        return os.path.isfile(os.path.join(self.job_dir(job_id), "cancel.flag"))

    def write_error(self, job_id, code, message, worker):
        write_json_atomic(os.path.join(self.job_dir(job_id), "error.json"),
                          dict(jobId=job_id, code=code, message=message, worker=worker, at=int(time.time() * 1000)))

    def log(self, job_id, message):
        print(f"[STEM-REMOTE-WORKER] {job_id} {message}", flush=True)
        try:
            dest = os.path.join(self.job_dir(job_id), "logs", "worker.log")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")
        except OSError:
            pass


class LocalAdapterRunner:
    def __init__(self, adapter):
        self.adapter = adapter

    def run(self, *, manifest, input_path, output_dir, model_dir, device, on_progress=None,
            tick=lambda: None, timeout=21600, idle_timeout=1800):
        engine = manifest["engine"]
        checkpoint = os.path.join(model_dir, os.path.basename(engine["checkpoint"]["file"]))
        config = os.path.join(model_dir, os.path.basename(engine["config"]["file"]))
        args = [sys.executable, "-u", self.adapter, "--family", engine["family"],
                "--checkpoint", checkpoint, "--config", config, "--input", input_path,
                "--output-dir", output_dir, "--stem-order", ",".join(expected_stems(manifest)),
                "--stems", ",".join(expected_stems(manifest)), "--chunk-size", str(engine.get("chunkSizeSamples", 131584)),
                "--num-overlap", str(engine.get("numOverlap", 4)),
                "--ensemble-passes", str(engine.get("ensemblePasses", 1)), "--device", device]
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   encoding="utf-8", errors="replace", bufsize=1)
        events = queue.Queue(maxsize=256)
        stop = threading.Event()
        logs = deque(maxlen=25)

        def pump(stream, source):
            try:
                for line in iter(stream.readline, ""):
                    while not stop.is_set():
                        try:
                            events.put((source, line[:16384]), timeout=0.1)
                            break
                        except queue.Full:
                            continue
                    if stop.is_set():
                        break
            finally:
                stream.close()
                while not stop.is_set():
                    try:
                        events.put((source, None), timeout=0.1)
                        break
                    except queue.Full:
                        continue

        threads = [threading.Thread(target=pump, args=(stream, name), daemon=True)
                   for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr"))]
        for thread in threads:
            thread.start()
        started = last_progress = time.monotonic()
        report = None
        reported_error = None
        ended = 0
        try:
            while ended < 2:
                tick()
                now = time.monotonic()
                if now - started > timeout or now - last_progress > idle_timeout:
                    raise ProtocolError("REMOTE_INFERENCE_TIMEOUT", "Berechnung ohne rechtzeitiges Ergebnis/Fortschritt beendet")
                try:
                    source, line = events.get(timeout=0.2)
                except queue.Empty:
                    continue
                if line is None:
                    ended += 1
                    continue
                if source == "stderr":
                    logs.append(line.strip())
                    continue
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    logs.append(line.strip())
                    continue
                kind = event.get("type")
                if kind == "progress":
                    last_progress = time.monotonic()
                    if on_progress:
                        on_progress(float(event.get("fraction", 0)), str(event.get("phase", "")))
                elif kind == "done":
                    report = event
                elif kind == "error":
                    reported_error = ProtocolError(str(event.get("code", "INFERENCE_FAILED")), str(event.get("message", "Adapter-Fehler")))
                elif kind == "log":
                    logs.append(str(event.get("message", "")))
            code = process.wait(timeout=5)
            if reported_error:
                raise reported_error
            if code != 0:
                raise ProtocolError("INFERENCE_FAILED", f"Adapter Exit {code}: {'; '.join(logs)[-1600:]}")
            if not report or not isinstance(report.get("stems"), list):
                raise ProtocolError("REMOTE_OUTPUT_INCOMPLETE", "Adapter meldete kein vollständiges Ergebnis")
            return report
        finally:
            stop.set()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for thread in threads:
                thread.join(timeout=2)


def _wav_geometry(path):
    # The production adapter writes IEEE FLOAT WAV; stdlib wave cannot read it.
    import struct
    with open(path, "rb") as handle:
        if handle.read(4) != b"RIFF":
            raise ProtocolError("REMOTE_OUTPUT_INVALID", "Kein RIFF-WAV")
        handle.read(4)
        if handle.read(4) != b"WAVE":
            raise ProtocolError("REMOTE_OUTPUT_INVALID", "Kein WAVE-Container")
        geometry = None
        data_bytes = None
        file_bytes = os.path.getsize(path)
        while handle.tell() + 8 <= file_bytes:
            tag, size = struct.unpack("<4sI", handle.read(8))
            if handle.tell() + size > file_bytes:
                raise ProtocolError("REMOTE_OUTPUT_INVALID", "WAV ist unvollständig")
            if tag == b"fmt ":
                raw = handle.read(size)
                if len(raw) < 16:
                    raise ProtocolError("REMOTE_OUTPUT_INVALID", "WAV fmt fehlt")
                fmt, channels, rate, _, align, bits = struct.unpack("<HHIIHH", raw[:16])
                if fmt not in (1, 3) or channels not in (1, 2) or rate <= 0 or align != channels * bits // 8 or align == 0:
                    raise ProtocolError("REMOTE_OUTPUT_INVALID", "Nicht unterstütztes WAV-Format")
                geometry = channels, rate, align
            else:
                if tag == b"data":
                    data_bytes = size
                handle.seek(size, 1)
            if size % 2:
                handle.seek(1, 1)
        if not geometry or not data_bytes or data_bytes % geometry[2]:
            raise ProtocolError("REMOTE_OUTPUT_INVALID", "WAV ohne vollständige Audiodaten")
        channels, rate, align = geometry
        return data_bytes // align, rate, channels


def verify_outputs(manifest, output_dir):
    outputs = manifest.get("output", {}).get("stems", [])
    if {s.get("id") for s in outputs} != set(expected_stems(manifest)):
        raise ProtocolError("REMOTE_OUTPUT_INCOMPLETE", "Nicht alle Stems vorhanden")
    for stem in outputs:
        dest = safe_path(output_dir, stem["fileName"])
        _wav_geometry(dest)
        if sha256_file(dest) != stem["sha256"]:
            raise ProtocolError("REMOTE_OUTPUT_HASH_MISMATCH", "Stem-Hash falsch")
    return outputs


def run_job(store, job_id, manifest, *, model_dir, device, adapter, work_dir,
            sync_timeout=600, timeout=21600, idle_timeout=1800, heartbeat_interval=10):
    validate_manifest(manifest, job_id)
    if manifest["status"] in TERMINAL_STATUSES:
        return "skipped"
    # PREPARING means editor has not yet published the input completely.
    if manifest["status"] in {"PENDING", "PREPARING"}:
        return "skipped"
    if store.claim_is_fresh(job_id):
        return "skipped"
    claim = store.claim(job_id, device=device)
    manifest.update(status="RUNNING", phase="Arbeitskopie wird synchronisiert", percent=1,
                    attempts=int(manifest.get("attempts", 0)) + 1, worker=claim)
    last_heartbeat = [0.0]

    def tick():
        if store.cancel_requested(job_id):
            raise ProtocolError("INFERENCE_CANCELLED", "Vom Editor abgebrochen")
        if time.monotonic() - last_heartbeat[0] >= heartbeat_interval:
            store.heartbeat(job_id, claim)
            last_heartbeat[0] = time.monotonic()

    try:
        tick()
        store.write_manifest(job_id, manifest)
        remote_input = safe_path(store.root, manifest["input"]["relativePath"])
        local_dir = safe_path(work_dir, job_id)
        os.makedirs(local_dir, exist_ok=True)
        local_input = safe_path(local_dir, manifest["input"]["fileName"])
        deadline = time.monotonic() + sync_timeout
        while True:
            tick()
            try:
                shutil.copyfile(remote_input, local_input)
                valid = (os.path.getsize(local_input) == manifest["input"]["bytes"]
                         and sha256_file(local_input) == manifest["input"]["sha256"])
            except (FileNotFoundError, PermissionError):
                valid = False
            if valid:
                break
            if time.monotonic() >= deadline:
                raise ProtocolError("REMOTE_INPUT_SYNC_TIMEOUT", "Arbeitskopie fehlt/ist unvollständig. Drive-Synchronisierung prüfen.")
            time.sleep(min(1, max(0.01, deadline - time.monotonic())))
        store.log(job_id, "Input SHA256 verifiziert; lokale Berechnung startet")
        inference_input = local_input
        original_rate = manifest["input"]["sampleRate"]
        if original_rate != 44100:
            import soundfile as sf
            from scipy.signal import resample_poly
            from math import gcd
            audio, rate = sf.read(local_input, dtype="float32", always_2d=True)
            if rate != original_rate:
                raise ProtocolError("REMOTE_INPUT_INVALID", "Eingabe-Samplerate passt nicht zum Manifest")
            divisor = gcd(rate, 44100)
            converted = resample_poly(audio, 44100 // divisor, rate // divisor, axis=0)
            inference_input = os.path.join(local_dir, "model-input-44100.wav")
            sf.write(inference_input, converted, 44100, subtype="FLOAT")
        output_dir = safe_path(local_dir, "output")
        shutil.rmtree(output_dir, ignore_errors=True)
        os.makedirs(output_dir)
        last_progress = [0.0]

        def progress(fraction, phase):
            tick()
            if time.monotonic() - last_progress[0] < heartbeat_interval:
                return
            last_progress[0] = time.monotonic()
            manifest.update(percent=max(1, min(95, int(fraction * 95))), phase=phase or "Berechnung läuft")
            manifest["worker"] = dict(claim)
            store.write_manifest(job_id, manifest)

        runner = LocalAdapterRunner(adapter)
        kwargs = dict(manifest=manifest, input_path=inference_input, output_dir=output_dir, model_dir=model_dir,
                      on_progress=progress, tick=tick, timeout=timeout, idle_timeout=idle_timeout)
        manifest["phase"] = "Berechnung läuft"
        store.write_manifest(job_id, manifest)
        try:
            report = runner.run(device=device, **kwargs)
        except ProtocolError as error:
            if device == "cpu" or error.code not in {"GPU_UNAVAILABLE", "GPU_OUT_OF_MEMORY"}:
                raise
            store.log(job_id, f"{error.code}: CPU-Rückfall")
            claim.update(device="cpu", cpuFallback=True, fallbackReason=error.message)
            manifest.update(worker=dict(claim), phase="Berechnung läuft – CPU-Fallback")
            store.write_manifest(job_id, manifest)
            report = runner.run(device="cpu", **kwargs)
        tick()
        by_name = {s["name"]: s["path"] for s in report["stems"]}
        if set(by_name) != set(expected_stems(manifest)) or len(report["stems"]) != len(by_name):
            raise ProtocolError("REMOTE_OUTPUT_INCOMPLETE", "Adapter lieferte nicht genau die erwarteten Stems")
        manifest.update(phase="Ergebnisse werden nach Drive übertragen", percent=96)
        store.write_manifest(job_id, manifest)
        stems = []
        for stem_id in expected_stems(manifest):
            tick()
            candidate = Path(by_name[stem_id]).resolve()
            if Path(output_dir).resolve() not in candidate.parents:
                raise ProtocolError("REMOTE_OUTPUT_INVALID", "Adapter lieferte einen fremden Ausgabepfad")
            if original_rate != 44100:
                import numpy as np
                data, rate = sf.read(candidate, dtype="float32", always_2d=True)
                divisor = gcd(rate, original_rate)
                restored = resample_poly(data, original_rate // divisor, rate // divisor, axis=0)
                frames_expected = round(manifest["input"]["durationSeconds"] * original_rate)
                restored = restored[:frames_expected]
                if len(restored) < frames_expected:
                    restored = np.pad(restored, ((0, frames_expected - len(restored)), (0, 0)))
                sf.write(candidate, restored, original_rate, subtype="FLOAT")
            frames, rate, channels = _wav_geometry(str(candidate))
            if channels != manifest["input"]["channels"] or abs(frames / rate - manifest["input"]["durationSeconds"]) > 0.15:
                raise ProtocolError("REMOTE_OUTPUT_INVALID", "Stem-Dauer/Kanäle passen nicht zur Arbeitskopie")
            relative = f"jobs/{job_id}/output/{stem_id}.wav"
            target = safe_path(store.root, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            temp = target + ".tmp"
            shutil.copyfile(candidate, temp)
            os.replace(temp, target)
            stems.append(dict(id=stem_id, fileName=f"{stem_id}.wav", relativePath=relative,
                              sha256=sha256_file(str(candidate)), bytes=candidate.stat().st_size,
                              frames=frames, sampleRate=rate, channels=channels))
        tick()
        claim.update(device=report.get("device", device), heartbeatAt=int(time.time() * 1000))
        manifest.update(output=dict(stems=stems, resultFile=f"jobs/{job_id}/output/result.json"),
                        worker=claim, status="COMPLETED", phase="Fertig", percent=100)
        write_json_atomic(os.path.join(store.output_dir(job_id), "result.json"),
                          dict(schemaVersion=1, jobId=job_id, status="COMPLETED", modelId=manifest["engine"]["modelId"],
                               profile=manifest["engine"]["profile"], stems=stems, worker=claim, report=report.get("report", {})))
        tick()
        store.write_manifest(job_id, manifest)
        store.log(job_id, "COMPLETED – alle Stems veröffentlicht")
        return "completed"
    except ProtocolError as error:
        # A losing worker must not overwrite the new owner's manifest.
        if error.code == "REMOTE_LEASE_LOST":
            store.log(job_id, error.message)
            return "skipped"
        cancelled = error.code == "INFERENCE_CANCELLED"
        manifest.update(status="CANCELLED" if cancelled else "FAILED", phase=error.message,
                        error=dict(code=error.code, message=error.message, at=int(time.time() * 1000)))
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, error.code, error.message, store.worker_id)
        store.log(job_id, f"{manifest['status']}: {error.code}: {error.message}")
        return "cancelled" if cancelled else "failed"
    except Exception as error:
        message = f"{type(error).__name__}: {error}"[:1500]
        manifest.update(status="FAILED", phase="Worker-Fehler", error=dict(code="REMOTE_WORKER_FAILED", message=message))
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, "REMOTE_WORKER_FAILED", message, store.worker_id)
        store.log(job_id, message)
        return "failed"


def parse_args(argv):
    parser = argparse.ArgumentParser(description="AirDox Colab-Worker", allow_abbrev=False)
    parser.add_argument("--root", default=os.environ.get("AIRODOX_STEM_REMOTE_DIR", ""))
    parser.add_argument("--model-dir", default="/content/models")
    parser.add_argument("--adapter", default=str(Path(__file__).resolve().parents[1] / "python/bsroformer_inference.py"))
    parser.add_argument("--work-dir", default="/content/airdox-work")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--worker", default=f"colab-{uuid.uuid4().hex[:12]}")
    parser.add_argument("--poll", type=float, default=15)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-jobs", type=int, default=0)
    parser.add_argument("--sync-timeout", type=float, default=600)
    parser.add_argument("--job-timeout", type=float, default=21600)
    parser.add_argument("--idle-timeout", type=float, default=1800)
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as root:
        store = JobStore(root, "self-test")
        job = str(uuid.uuid4())
        store.claim(job)
        assert JobStore(root, "other").claim_is_fresh(job)
        try:
            safe_path(root, "../outside")
            raise AssertionError("path traversal accepted")
        except ProtocolError:
            pass
    print("Worker protocol self-test PASS (not an inference test)")
    return 0


def main(argv):
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.root or min(args.poll, args.sync_timeout, args.job_timeout, args.idle_timeout) <= 0:
        raise ProtocolError("STEM_CONFIG_INVALID", "Jobordner und positive Zeitgrenzen erforderlich")
    from remote_setup import preflight
    health = preflight(args.model_dir, args.adapter, args.device)
    store = JobStore(args.root, args.worker)
    os.makedirs(store.jobs_dir, exist_ok=True)
    os.makedirs(args.work_dir, exist_ok=True)
    status_path = os.path.join(store.root, "worker.json")
    previous = read_json(status_path)
    if previous and previous.get("state") == "ready" and time.time() * 1000 - previous.get("heartbeatAt", 0) < 180000:
        raise ProtocolError("REMOTE_WORKER_CONFLICT", "Bereits ein Worker aktiv. Alte Colab-Sitzung stoppen und 3 Minuten warten.")
    stop = threading.Event()
    status = dict(schemaVersion=1, id=args.worker, version=WORKER_VERSION, state="ready", **health)
    heartbeat_errors = []

    def heartbeat():
        while not stop.is_set():
            try:
                current = read_json(status_path)
                if current and current.get("id") != args.worker and current.get("state") == "ready" and current != previous:
                    raise ProtocolError("REMOTE_WORKER_CONFLICT", "Zweite Colab-Sitzung erkannt")
                status["heartbeatAt"] = int(time.time() * 1000)
                write_json_atomic(status_path, dict(status))
            except Exception as error:
                heartbeat_errors.append(str(error))
                stop.set()
                return
            stop.wait(10)

    status["heartbeatAt"] = int(time.time() * 1000)
    write_json_atomic(status_path, status)
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    print(f"[STEM-REMOTE-WORKER] BEREIT: {args.worker}, {health['device']}, {MODEL_ID}", flush=True)
    processed = failures = 0
    try:
        while not stop.is_set():
            for job_id in store.list_job_ids():
                if stop.is_set():
                    break
                try:
                    manifest = store.read_manifest(job_id)
                    validate_manifest(manifest, job_id)
                    if manifest["status"] in TERMINAL_STATUSES:
                        continue
                    from remote_setup import validate_engine
                    validate_engine(manifest["engine"])
                    result = run_job(store, job_id, manifest, model_dir=args.model_dir, device=health["device"],
                                     adapter=args.adapter, work_dir=args.work_dir, sync_timeout=args.sync_timeout,
                                     timeout=args.job_timeout, idle_timeout=args.idle_timeout)
                    if result in {"completed", "failed", "cancelled"}:
                        processed += 1
                        failures += result == "failed"
                except (json.JSONDecodeError, OSError, ProtocolError, TypeError, ValueError) as error:
                    store.log(job_id, f"Job nicht angenommen: {error}")
                    if isinstance(error, ProtocolError):
                        store.write_error(job_id, error.code, error.message, store.worker_id)
                    failures += 1
                if args.max_jobs and processed >= args.max_jobs:
                    return 1 if failures else 0
            if args.once:
                return 1 if failures else 0
            print(f"[STEM-REMOTE-WORKER] Wartet auf Jobs; bearbeitet={processed}", flush=True)
            stop.wait(args.poll)
        if heartbeat_errors:
            raise ProtocolError("REMOTE_WORKER_HEARTBEAT_FAILED", heartbeat_errors[-1])
        return 0
    finally:
        stop.set()
        thread.join(timeout=5)
        current = read_json(status_path)
        if current and current.get("id") == args.worker:
            status.update(state="stopped", heartbeatAt=int(time.time() * 1000))
            write_json_atomic(status_path, status)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("Worker gestoppt. Offene Jobs bleiben erhalten.", flush=True)
        sys.exit(130)
    except Exception as error:
        print(f"[STEM-REMOTE-WORKER] START/LAUF FEHLGESCHLAGEN: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
