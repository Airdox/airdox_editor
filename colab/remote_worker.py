#!/usr/bin/env python3
"""airdox_SMART_Editor – High-Quality-Fernworker (Google Colab).

Der Worker ist ein **Rechenknecht**: Er findet Jobs in der Google-Drive-Ablage,
beansprucht sie, prüft den Input-Hash, rechnet mit dem High-Quality-Modell
(BS-RoFormer über den vorhandenen Adapter ``python/bsroformer_inference.py``)
und schreibt Stems, Hashes und Status zurück. Editorlogik gibt es hier nicht
(§24, §42).

Protokoll (dieselbe Ablage wie ``scripts/stem-remote-worker.ts``)::

    <root>/jobs/<jobId>/manifest.json     Status + Modell + Input-Hash + Outputs
    <root>/jobs/<jobId>/input/<file>.wav  Arbeitskopie (nie das Original)
    <root>/jobs/<jobId>/claim.json        Lease: wer rechnet gerade
    <root>/jobs/<jobId>/cancel.flag       Editor: „brich ab“
    <root>/jobs/<jobId>/output/<stem>.wav Ergebnisse
    <root>/jobs/<jobId>/output/result.json Ergebnisdokument
    <root>/jobs/<jobId>/error.json        letzter Fehler

Eigenschaften, die bewusst so sind:
  * **Idempotenz** – ein Job mit Status COMPLETED/FAILED/CANCELLED wird nie
    erneut gerechnet, auch nicht nach einem Colab-Neustart (§19).
  * **Lease** – ein frisch beanspruchter Job gehört einem anderen Worker.
  * **Hash-Kontrolle** – Input und jeder Output werden per SHA-256 geprüft;
    Vollständigkeit aller erwarteten Stems wird erzwungen (§22, §34).
  * **CPU-Rückfall** – schlägt die GPU fehl (oder fehlt sie), rechnet der
    Adapter auf CPU weiter; der Zustand landet im Manifest (§7, §21 F/G/H).
  * Keine Zugangsdaten im Job: Drive-Zugriff läuft über den gemounteten
    Drive-Ordner, Tokens liegen nie in der Jobablage (§23).

Aufruf (auch ohne Colab, z. B. zum Trockenlauf gegen einen lokalen Ordner)::

    python3 colab/remote_worker.py --root /pfad/zur/jobablage --once
    python3 colab/remote_worker.py --root /content/drive/MyDrive/airdox-stem-jobs --self-test
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

SCHEMA_VERSION = 1
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}
JOB_ID_MIN = 8


# --------------------------------------------------------------------------- #
# Manifest-Helfer (bewusst ohne Abhängigkeiten – nur stdlib)
# --------------------------------------------------------------------------- #


class ProtocolError(Exception):
    """Verletzung des Job-Protokolls (Manifest, Hashes, Vollständigkeit)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def write_json_atomic(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def validate_manifest(manifest: dict, expected_job_id: str) -> dict:
    """Prüft die Felder, ohne die ein Job nicht sicher zuordenbar ist."""
    if not isinstance(manifest, dict):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Manifest ist kein Objekt")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ProtocolError("REMOTE_SCHEMA_UNSUPPORTED", f"Schema {manifest.get('schemaVersion')} wird nicht unterstützt")
    if manifest.get("jobId") != expected_job_id:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "Manifest-Id passt nicht zum Verzeichnis")
    if manifest.get("status") not in TERMINAL_STATUSES | {"PENDING", "PREPARING", "RUNNING", "RECONSTRUCTING", "VALIDATING"}:
        raise ProtocolError("REMOTE_MANIFEST_INVALID", f"Unbekannter Status {manifest.get('status')!r}")
    for field in ("sha256", "fileName", "relativePath"):
        if not manifest.get("input", {}).get(field):
            raise ProtocolError("REMOTE_MANIFEST_INVALID", f"input.{field} fehlt")
    engine = manifest.get("engine") or {}
    if not engine.get("modelId") or not engine.get("stems"):
        raise ProtocolError("REMOTE_MANIFEST_INVALID", "engine.modelId/stems fehlt")
    return manifest


def expected_stems(manifest: dict) -> List[str]:
    return [str(stem) for stem in (manifest.get("engine", {}).get("stems") or [])]


def verify_outputs(manifest: dict, output_dir: str) -> List[dict]:
    """Stellt sicher, dass **alle** erwarteten Stems lesbar und nicht leer sind."""
    stems = manifest.get("output", {}).get("stems") or []
    delivered = {stem.get("id"): stem for stem in stems}
    missing = [stem for stem in expected_stems(manifest) if stem not in delivered]
    if missing:
        raise ProtocolError("REMOTE_OUTPUT_INCOMPLETE", f"Es fehlen Stems: {', '.join(missing)}")
    for stem_id, stem in delivered.items():
        path = os.path.join(output_dir, os.path.basename(str(stem.get("fileName") or "")))
        if not os.path.isfile(path) or os.path.getsize(path) <= 44:
            raise ProtocolError("REMOTE_OUTPUT_EMPTY", f"Stem {stem_id} fehlt oder ist leer: {path}")
        if stem.get("sha256") and sha256_file(path) != stem["sha256"]:
            raise ProtocolError("REMOTE_OUTPUT_HASH_MISMATCH", f"Stem {stem_id} hat einen anderen Hash als im Manifest")
    return list(delivered.values())


# --------------------------------------------------------------------------- #
# Job-Ablage
# --------------------------------------------------------------------------- #


class JobStore:
    """Zugriff auf die Jobablage (gemounteter Drive-Ordner)."""

    def __init__(self, root: str, worker_id: str, lease_seconds: int = 1800) -> None:
        self.root = os.path.abspath(root)
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.jobs_dir = os.path.join(self.root, "jobs")

    # -- Pfade ------------------------------------------------------------- #
    def job_dir(self, job_id: str) -> str:
        return os.path.join(self.jobs_dir, job_id)

    def manifest_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "manifest.json")

    def claim_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "claim.json")

    def input_path(self, job_id: str, file_name: str) -> str:
        return os.path.join(self.job_dir(job_id), "input", os.path.basename(file_name))

    def output_dir(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "output")

    # -- Abfragen ---------------------------------------------------------- #
    def list_job_ids(self) -> List[str]:
        if not os.path.isdir(self.jobs_dir):
            return []
        out = []
        for name in sorted(os.listdir(self.jobs_dir)):
            if name.startswith(".") or name.endswith(".tmp"):
                continue
            if len(name) < JOB_ID_MIN:
                continue
            if os.path.isfile(self.manifest_path(name)) or os.path.isfile(self.claim_path(name)):
                out.append(name)
        return out

    def read_manifest(self, job_id: str) -> Optional[dict]:
        return read_json(self.manifest_path(job_id))

    def write_manifest(self, job_id: str, manifest: dict) -> None:
        manifest["updatedAt"] = int(time.time() * 1000)
        manifest["updatedAtIso"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json_atomic(self.manifest_path(job_id), manifest)

    def claim_is_fresh(self, job_id: str) -> bool:
        claim = read_json(self.claim_path(job_id))
        if not claim:
            return False
        stamp = claim.get("heartbeatAt") or claim.get("claimedAt") or 0
        try:
            age = time.time() * 1000 - float(stamp)
        except (TypeError, ValueError):
            return False
        if claim.get("id") == self.worker_id:
            return False
        return 0 <= age < self.lease_seconds * 1000

    def cancel_requested(self, job_id: str) -> bool:
        return os.path.isfile(os.path.join(self.job_dir(job_id), "cancel.flag"))

    def claim(self, job_id: str, **extra: Any) -> Dict[str, Any]:
        claim = {
            "id": self.worker_id,
            "host": socket.gethostname(),
            "claimedAt": int(time.time() * 1000),
            "heartbeatAt": int(time.time() * 1000),
            "version": "colab-worker/1",
            **extra,
        }
        write_json_atomic(self.claim_path(job_id), claim)
        return claim

    def heartbeat(self, job_id: str, claim: Dict[str, Any]) -> None:
        claim["heartbeatAt"] = int(time.time() * 1000)
        write_json_atomic(self.claim_path(job_id), claim)

    def write_error(self, job_id: str, code: str, message: str, worker: str) -> None:
        write_json_atomic(
            os.path.join(self.job_dir(job_id), "error.json"),
            {"jobId": job_id, "code": code, "message": message, "at": int(time.time() * 1000), "worker": worker},
        )

    def log(self, job_id: str, message: str) -> None:
        path = os.path.join(self.job_dir(job_id), "logs", "worker.log")
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")
        except OSError:
            pass
        print(f"[STEM-REMOTE-WORKER] {job_id} {message}", flush=True)


# --------------------------------------------------------------------------- #
# Separation
# --------------------------------------------------------------------------- #


class LocalAdapterRunner:
    """Ruft den vorhandenen Adapter ``python/bsroformer_inference.py`` auf.

    Der Adapter ist derselbe, den der Editor lokal für den HQ-Pfad benutzt:
    die Modell-/Neustart-Logik wird also nicht doppelt gebaut (§42). Er spricht
    JSON-Lines; hier werden Fortschritt und Ergebnis gelesen.
    """

    def __init__(self, adapter: str) -> None:
        self.adapter = adapter

    def _python_device(self, device: str) -> str:
        return {"cuda": "cuda", "cpu": "cpu", "auto": "auto"}.get(device, "auto")

    def run(
        self,
        *,
        manifest: dict,
        input_path: str,
        output_dir: str,
        model_dir: str,
        device: str,
        on_progress=None,
    ) -> Dict[str, Any]:
        engine = manifest["engine"]
        checkpoint = os.path.join(model_dir, os.path.basename(str(engine.get("checkpoint", {}).get("file") or "")))
        config_file = engine.get("config", {}).get("file")
        config_path = os.path.join(model_dir, os.path.basename(str(config_file))) if config_file else None
        args = [
            sys.executable,
            self.adapter,
            "--family",
            str(engine.get("family") or "bs_roformer"),
            "--checkpoint",
            checkpoint,
            "--input",
            input_path,
            "--output-dir",
            output_dir,
            "--stem-order",
            ",".join(expected_stems(manifest)),
            "--stems",
            ",".join(expected_stems(manifest)),
            "--chunk-size",
            str(engine.get("chunkSizeSamples") or 131584),
            "--num-overlap",
            str(engine.get("numOverlap") or 4),
            "--device",
            self._python_device(device),
        ]
        if config_path and os.path.isfile(config_path):
            args += ["--config", config_path]

        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        report: Dict[str, Any] = {}
        logs: List[str] = []
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line.startswith("{"):
                logs.append(line)
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "progress" and on_progress:
                on_progress(float(event.get("fraction") or 0.0), str(event.get("phase") or ""))
            elif kind == "done":
                report = event
            elif kind == "error":
                raise ProtocolError(str(event.get("code") or "INFERENCE_FAILED"), str(event.get("message") or "Adapter-Fehler"))
            elif kind == "log":
                logs.append(str(event.get("message")))
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait()
        if code != 0:
            raise ProtocolError("INFERENCE_FAILED", f"Adapter endete mit Code {code}: {(stderr or '')[-400:]}")
        report["logs"] = logs[-20:]
        return report


def run_job(
    store: JobStore,
    job_id: str,
    manifest: dict,
    *,
    model_dir: str,
    device: str,
    adapter: str,
    work_dir: str,
) -> str:
    """Ein Job, vollständig: Hash prüfen, rechnen, prüfen, zurückschreiben."""
    if manifest.get("status") in TERMINAL_STATUSES:
        store.log(job_id, f"übersprungen – Status {manifest['status']} (§19)")
        return "skipped"
    if store.cancel_requested(job_id):
        manifest["status"] = "CANCELLED"
        manifest["phase"] = "Vom Editor abgebrochen"
        store.write_manifest(job_id, manifest)
        store.log(job_id, "abgebrochen (cancel.flag)")
        return "cancelled"
    if store.claim_is_fresh(job_id):
        store.log(job_id, "wird bereits von einem anderen Worker gerechnet – übersprungen")
        return "skipped"

    claim = store.claim(job_id, device=device, gpu=_gpu_name())
    manifest["status"] = "RUNNING"
    manifest["phase"] = "Arbeitskopie wird geladen"
    manifest["percent"] = 1
    manifest["attempts"] = int(manifest.get("attempts") or 0) + 1
    manifest["worker"] = claim
    store.write_manifest(job_id, manifest)

    try:
        remote_input = os.path.join(store.root, manifest["input"]["relativePath"])
        if not os.path.isfile(remote_input):
            raise ProtocolError("REMOTE_INPUT_MISSING", f"Eingabedatei fehlt: {remote_input}")
        local_input = os.path.join(work_dir, job_id, manifest["input"]["fileName"])
        os.makedirs(os.path.dirname(local_input), exist_ok=True)
        shutil.copyfile(remote_input, local_input)
        actual = sha256_file(local_input)
        if actual != manifest["input"]["sha256"]:
            raise ProtocolError(
                "REMOTE_INPUT_HASH_MISMATCH",
                f"SHA256 der Arbeitskopie stimmt nicht ({actual[:12]}… statt {manifest['input']['sha256'][:12]}…)",
            )
        store.log(job_id, f"Arbeitskopie verifiziert ({actual[:12]}…) – CPU/GPU: {device}")

        output_dir = store.output_dir(job_id)
        os.makedirs(output_dir, exist_ok=True)

        def on_progress(fraction: float, phase: str) -> None:
            manifest["percent"] = max(int(manifest.get("percent") or 0), min(99, int(fraction * 100)))
            manifest["phase"] = phase or "Inferenz läuft"
            manifest.setdefault("worker", claim)["heartbeatAt"] = int(time.time() * 1000)
            store.write_manifest(job_id, manifest)

        runner = LocalAdapterRunner(adapter)
        try:
            report = runner.run(
                manifest=manifest,
                input_path=local_input,
                output_dir=output_dir,
                model_dir=model_dir,
                device=device,
                on_progress=on_progress,
            )
        except ProtocolError as error:
            if device != "cpu" and error.code in {"GPU_UNAVAILABLE", "GPU_OUT_OF_MEMORY", "INFERENCE_FAILED"}:
                # §21 F/G: GPU nicht nutzbar ⇒ CPU versuchen, nicht aufgeben.
                store.log(job_id, f"GPU-Ausfall ({error.code}) – CPU-Rückfall")
                claim["cpuFallback"] = True
                claim["fallbackReason"] = error.message[:300]
                manifest["worker"] = claim
                manifest["phase"] = "Verarbeitung läuft – CPU-Fallback"
                store.write_manifest(job_id, manifest)
                report = runner.run(
                    manifest=manifest,
                    input_path=local_input,
                    output_dir=output_dir,
                    model_dir=model_dir,
                    device="cpu",
                    on_progress=on_progress,
                )
                report["cpuFallback"] = True
                report["fallbackReason"] = error.message[:300]
            else:
                raise

        # Outputs einsammeln und prüfen (§34)
        stems = []
        for stem_id in expected_stems(manifest):
            candidate = os.path.join(output_dir, f"{stem_id}.wav")
            if not os.path.isfile(candidate):
                matches = [name for name in os.listdir(output_dir) if name.lower().startswith(stem_id.lower()) and name.endswith(".wav")]
                if not matches:
                    raise ProtocolError("REMOTE_OUTPUT_INCOMPLETE", f"Adapter hat keinen Stem {stem_id} geschrieben")
                candidate = os.path.join(output_dir, matches[0])
            size = os.path.getsize(candidate)
            if size <= 44:
                raise ProtocolError("REMOTE_OUTPUT_EMPTY", f"Stem {stem_id} ist leer ({size} Bytes)")
            frames, sample_rate, channels = _wav_geometry(candidate)
            stems.append(
                {
                    "id": stem_id,
                    "fileName": os.path.basename(candidate),
                    "relativePath": os.path.relpath(candidate, store.root).replace(os.sep, "/"),
                    "sha256": sha256_file(candidate),
                    "bytes": size,
                    "frames": frames,
                    "sampleRate": sample_rate,
                    "channels": channels,
                }
            )

        manifest["output"] = {
            "stems": stems,
            "resultFile": f"jobs/{job_id}/output/result.json",
        }
        manifest["status"] = "COMPLETED"
        manifest["phase"] = "Fertig"
        manifest["percent"] = 100
        device_report = report.get("device") or device
        manifest["worker"] = {
            **claim,
            "heartbeatAt": int(time.time() * 1000),
            "device": device_report,
            "cpuFallback": bool(report.get("cpuFallback")),
            "fallbackReason": report.get("fallbackReason"),
            "torch": report.get("torchVersion"),
            "gpu": _gpu_name(),
        }
        store.write_manifest(job_id, manifest)
        write_json_atomic(
            os.path.join(output_dir, "result.json"),
            {
                "schemaVersion": SCHEMA_VERSION,
                "jobId": job_id,
                "status": "COMPLETED",
                "modelId": manifest["engine"]["modelId"],
                "profile": manifest["engine"]["profile"],
                "completedAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "stems": stems,
                "worker": manifest["worker"],
                "report": {key: report.get(key) for key in ("device", "durationMs", "weights") if key in report},
            },
        )
        store.log(job_id, f"COMPLETED – {len(stems)} Stems, Gerät {device_report}")
        return "completed"
    except ProtocolError as error:
        manifest["status"] = "FAILED"
        manifest["phase"] = "Fehlgeschlagen"
        manifest["error"] = {"code": error.code, "message": error.message, "at": int(time.time() * 1000)}
        manifest["worker"] = {**claim, "heartbeatAt": int(time.time() * 1000)}
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, error.code, error.message, store.worker_id)
        store.log(job_id, f"FAILED – {error.code}: {error.message}")
        return "failed"
    except Exception as error:  # noqa: BLE001 – ein Job darf den Worker nie beenden
        manifest["status"] = "FAILED"
        manifest["phase"] = "Fehlgeschlagen"
        manifest["error"] = {"code": "INFERENCE_FAILED", "message": str(error)[:500], "at": int(time.time() * 1000)}
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, "INFERENCE_FAILED", str(error)[:500], store.worker_id)
        store.log(job_id, f"FAILED – INFERENCE_FAILED: {error}")
        return "failed"


def _wav_geometry(path: str) -> Tuple[int, int, int]:
    """Sample Rate, Kanäle und Frames aus einem PCM/Float-WAV-Header."""
    import wave  # nur stdlib – läuft in Colab ohne Zusatzpakete

    with wave.open(path, "rb") as handle:
        frames = handle.getnframes()
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
    return frames, sample_rate, channels


def _gpu_name() -> str:
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
        return "cpu"
    except Exception:  # noqa: BLE001 – kein torch ⇒ reine CPU-Maschine
        return "cpu"


# --------------------------------------------------------------------------- #
# Einstieg
# --------------------------------------------------------------------------- #


def self_test() -> int:
    """Protokoll-Selbsttest ohne Torch/GPU – läuft überall (CI, Sandbox)."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = JobStore(tmp, "self-test-worker")
        job_id = str(uuid.uuid4())
        os.makedirs(store.job_dir(job_id), exist_ok=True)
        # 1. Manifest schreiben, lesen, validieren
        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "jobId": job_id,
            "status": "RUNNING",
            "createdAt": int(time.time() * 1000),
            "engine": {"modelId": "bsroformer-musdb18hq-4stem-zfturbo", "profile": "HIGH_QUALITY", "stems": ["vocals", "drums", "bass", "other"]},
            "input": {"fileName": "mix.wav", "relativePath": f"jobs/{job_id}/input/mix.wav", "sha256": "x" * 64, "bytes": 1},
            "output": {"stems": []},
        }
        store.write_manifest(job_id, manifest)
        assert validate_manifest(store.read_manifest(job_id), job_id)["jobId"] == job_id
        # 2. Terminale Jobs werden nicht erneut gerechnet
        done = dict(manifest, status="COMPLETED")
        store.write_manifest(job_id, done)
        assert run_job(store, job_id, store.read_manifest(job_id), model_dir=tmp, device="cpu", adapter="unused", work_dir=tmp) == "skipped"
        # 3. Unvollständige Ergebnisse werden abgelehnt
        done["status"] = "COMPLETED"
        done["output"] = {"stems": [{"id": "vocals", "fileName": "vocals.wav", "sha256": "y" * 64, "bytes": 100}]}
        try:
            verify_outputs(done, tmp)
            raise AssertionError("unvollständige Stems hätten abgelehnt werden müssen")
        except ProtocolError as error:
            assert error.code == "REMOTE_OUTPUT_INCOMPLETE"
        # 4. Lease verhindert Doppelarbeit
        other = JobStore(tmp, "other-worker")
        other.claim(job_id)
        assert store.claim_is_fresh(job_id) is True
        assert JobStore(tmp, "other-worker").claim_is_fresh(job_id) is False
        # 5. cancel.flag gewinnt
        with open(os.path.join(store.job_dir(job_id), "cancel.flag"), "w", encoding="utf-8") as handle:
            handle.write("{}")
        pending = dict(manifest, status="RUNNING")
        store.write_manifest(job_id, pending)
        assert run_job(store, job_id, store.read_manifest(job_id), model_dir=tmp, device="cpu", adapter="unused", work_dir=tmp) == "cancelled"
        print("[STEM-REMOTE-WORKER] Selbsttest OK (Manifest, Idempotenz, Vollständigkeit, Lease, Abbruch)")
    return 0


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="airdox High-Quality-Fernworker (Colab)")
    parser.add_argument("--root", default=os.environ.get("AIRODOX_STEM_REMOTE_DIR", ""), help="Jobablage (Drive-Ordner)")
    parser.add_argument("--model-dir", default=os.environ.get("AIRODOX_STEM_MODEL_DIR", "/content/models"))
    parser.add_argument("--adapter", default=os.environ.get("AIRODOX_STEM_ADAPTER", "/content/airdox/python/bsroformer_inference.py"))
    parser.add_argument("--work-dir", default="/content/airdox-work")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--worker", default=f"colab-{socket.gethostname()}-{os.getpid()}")
    parser.add_argument("--poll", type=int, default=15)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-jobs", type=int, default=0, help="0 = unbegrenzt")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.root:
        print("[STEM-REMOTE-WORKER] Kein --root angegeben (Drive-Ordner der Jobablage).", file=sys.stderr)
        return 2
    store = JobStore(args.root, args.worker)
    os.makedirs(args.work_dir, exist_ok=True)
    print(f"[STEM-REMOTE-WORKER] Start: worker={args.worker} root={store.root} device={args.device}", flush=True)
    processed = 0
    while True:
        for job_id in store.list_job_ids():
            if args.max_jobs and processed >= args.max_jobs:
                break
            manifest = store.read_manifest(job_id)
            if not manifest:
                continue
            try:
                validate_manifest(manifest, job_id)
            except ProtocolError as error:
                store.log(job_id, f"Manifest ungültig: {error.message}")
                continue
            if manifest.get("status") in TERMINAL_STATUSES:
                continue
            outcome = run_job(
                store,
                job_id,
                manifest,
                model_dir=args.model_dir,
                device=args.device,
                adapter=args.adapter,
                work_dir=args.work_dir,
            )
            if outcome in {"completed", "failed", "cancelled"}:
                processed += 1
        if args.once:
            print(f"[STEM-REMOTE-WORKER] {processed} Job(s) bearbeitet – Ende (--once).", flush=True)
            return 0
        time.sleep(max(5, args.poll))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
