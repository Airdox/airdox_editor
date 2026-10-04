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
    <root>/jobs/<jobId>/logs/worker.jsonl strukturierte Schritte (max. 200)
    <root>/jobs/<jobId>/logs/worker.log   lesbares Protokoll (max. 200 Zeilen)
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
from collections import deque
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

SCHEMA_VERSION = 1
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}
JOB_ID_MIN = 8
# Wie schnell ein laufender Job die `cancel.flag` des Editors bemerkt (§37).
# 5 s sind auf Drive/Rclone-Mounts ein Kompromiss aus Last und Reaktionszeit:
# Vorher wurde der Abbruch erst beim *nächsten* Job überhaupt wahrgenommen –
# der Nutzer sah „nichts passiert“, während Colab weiterrechnete.
CANCEL_POLL_SECONDS = float(os.environ.get("AIRODOX_STEM_CANCEL_POLL_SECONDS", "5"))
CANCEL_KILL_GRACE_SECONDS = float(os.environ.get("AIRODOX_STEM_CANCEL_GRACE_SECONDS", "10"))
MAX_WORKER_TRACE_LINES = 200



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
        self._log_lock = threading.Lock()

    # -- Pfade ------------------------------------------------------------- #
    def job_dir(self, job_id: str) -> str:
        return os.path.join(self.jobs_dir, job_id)

    def manifest_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "manifest.json")

    def claim_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "claim.json")

    def worker_trace_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "logs", "worker.jsonl")

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

    def cancel_flag_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "cancel.flag")

    def cancel_requested(self, job_id: str) -> bool:
        return os.path.isfile(self.cancel_flag_path(job_id))

    def consume_cancel_flag(self, job_id: str) -> None:
        """Nimmt die Abbruchbitte weg, nachdem sie erfüllt wurde.

        Würde die Fahne liegen bleiben, wäre *jeder* spätere Job mit derselben
        Id in derselben Ablage sofort wieder abgebrochen – der Editor legt bei
        einem fehlenden Manifest denselben Job erneut aus (§21 B). Das Ergebnis
        wäre: Nutzer klickt auf „Externe Zerlegung“, der Worker verwirft den
        Job lautlos – „es passiert einfach nichts“.
        """
        try:
            os.remove(self.cancel_flag_path(job_id))
        except OSError:
            pass  # schon weg oder kurzer Sperre – kein Grund, den Job zu verlieren

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

    def _append_capped_line(self, path: str, line: str) -> None:
        """Behält höchstens MAX_WORKER_TRACE_LINES und ersetzt die Datei atomar."""
        safe_line = str(line).replace("\r", " ").replace("\n", " ")[:1200] + "\n"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with self._log_lock:
                tail = deque(maxlen=MAX_WORKER_TRACE_LINES)
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as handle:
                        tail.extend(handle)
                except FileNotFoundError:
                    pass
                tail.append(safe_line)
                tmp = path + f".{uuid.uuid4().hex}.tmp"
                with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                    handle.writelines(tail)
                os.replace(tmp, path)
        except OSError:
            pass

    def log(self, job_id: str, message: str) -> None:
        path = os.path.join(self.job_dir(job_id), "logs", "worker.log")
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._append_capped_line(path, f"{timestamp} {message}")
        print(f"[STEM-REMOTE-WORKER] {job_id} {message}", flush=True)

    def log_event(
        self,
        job_id: str,
        step: str,
        message: str,
        *,
        level: str = "info",
        **fields: Any,
    ) -> None:
        """Schreibt einen begrenzten JSONL-Diagnoseschritt plus lesbare Logzeile."""
        at = int(time.time() * 1000)
        event: Dict[str, Any] = {
            "id": f"worker-{uuid.uuid4().hex}",
            "source": "worker",
            "jobId": job_id,
            "at": at,
            "step": str(step)[:100],
            "level": level if level in {"info", "warning", "error"} else "info",
            "message": str(message)[:400],
            "workerId": self.worker_id[:100],
        }
        # Nur kleine, nicht-sensitive Diagnosefelder; keine Pfade, Tokens oder Audiodaten.
        for key in ("status", "phase", "code", "percent", "device"):
            value = fields.get(key)
            if isinstance(value, (str, int, float, bool)) and not isinstance(value, bool):
                event[key] = str(value)[:180] if key in {"status", "phase", "code", "device"} else value

        trace_path = self.worker_trace_path(job_id)
        self._append_capped_line(
            trace_path,
            json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
        )
        self.log(job_id, f"step={step} {message}")


class JobCancelled(Exception):
    """Der Editor hat `cancel.flag` gesetzt – laufende Arbeit wird beendet (§37).

    Kein Fehler: der Job endet als `CANCELLED`, ein Ergebnis wird bewusst nicht
    mehr geschrieben, damit der Editor es nie importieren kann.
    """


# --------------------------------------------------------------------------- #
# Separation
# --------------------------------------------------------------------------- #


class CancelWatchdog:
    """Beobachtet `cancel.flag`, solange ein Job rechnet, und beendet den Kindprozess.

    Der Fortschrittsstrom des Adapters allein reicht nicht: zwischen zwei
    Chunks können Minuten liegen, und ein hängender Adapter meldet gar nichts
    mehr. Deshalb läuft die Prüfung in einem eigenen Thread. Entdeckter
    Abbruch ⇒ SIGTERM, nach `grace_seconds` SIGKILL, dann `triggered = True`.
    """

    def __init__(
        self,
        cancel_check,
        *,
        poll_seconds: float = CANCEL_POLL_SECONDS,
        grace_seconds: float = CANCEL_KILL_GRACE_SECONDS,
    ) -> None:
        self._cancel_check = cancel_check
        self._poll = max(0.2, float(poll_seconds))
        self._grace = max(0.5, float(grace_seconds))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._process: Optional[subprocess.Popen] = None
        self.triggered = False
        self.checked = 0

    def attach(self, process: subprocess.Popen) -> None:
        self._process = process

    def check_now(self) -> bool:
        """Ein Blick auf die Ablage – wirft nie (Transportstörung ≠ Abbruch)."""
        try:
            self.checked += 1
            return bool(self._cancel_check())
        except Exception:  # noqa: BLE001 – Abbruchprüfung darf den Job nicht killen
            return False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="airdox-cancel-watchdog", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._poll):
            if self.triggered:
                return
            if self.check_now():
                self.trigger()
                return

    def trigger(self) -> None:
        self.triggered = True
        process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=self._grace)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
        except OSError:
            pass

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=self._poll * 4 + 1)
        self._thread = None


class WorkerLeaseHeartbeat:
    """Erneuert claim.json während langer Inferenz, unabhängig von Progress-Chunks."""

    def __init__(self, store: JobStore, job_id: str, claim: Dict[str, Any], interval: float = 30.0) -> None:
        self.store = store
        self.job_id = job_id
        self.claim = claim
        self.interval = max(1.0, interval)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="airdox-worker-heartbeat", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        warned = False
        while not self._stop.wait(self.interval):
            try:
                self.store.heartbeat(self.job_id, self.claim)
                warned = False
            except Exception:  # noqa: BLE001 – ein Lease-Schreibfehler darf die Inferenz nicht beenden
                if not warned:
                    self.store.log_event(
                        self.job_id,
                        "worker.heartbeat_write_failed",
                        "Worker-Lebenszeichen konnte nicht in die Jobablage geschrieben werden.",
                        level="warning",
                        code="REMOTE_HEARTBEAT_WRITE_FAILED",
                    )
                    warned = True

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None


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
        watchdog: Optional["CancelWatchdog"] = None,
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
        # Der Watchdog bekommt den Prozess: so beendet ein Abbruch die Inferenz
        # innerhalb von Sekunden, statt sie bis zum Ende laufen zu lassen (§37).
        if watchdog is not None:
            watchdog.attach(process)
            watchdog.start()
        cancelled = False
        try:
            for line in process.stdout:
                line = line.strip()
                if watchdog is not None and watchdog.triggered:
                    cancelled = True
                    break
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
            if watchdog is not None and watchdog.triggered:
                cancelled = True
        finally:
            if watchdog is not None:
                watchdog.stop()
        if cancelled:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            raise JobCancelled("Der Editor hat den Abbruch verlangt (cancel.flag) – Inferenz beendet.")
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait()
        if code != 0:
            raise ProtocolError("INFERENCE_FAILED", f"Adapter endete mit Code {code}: {(stderr or '')[-400:]}")
        report["logs"] = logs[-20:]
        return report


def _finish_cancelled(store: JobStore, job_id: str, manifest: dict, claim: Optional[dict] = None, note: str = "") -> str:
    """Manifest auf CANCELLED setzen und die Abbruchbitte des Editors annehmen.

    Die Fahne wird verbraucht (`consume_cancel_flag`), damit derselbe Jobordner
    einen später erneut veröffentlichten Lauf nicht sofort wieder abwürgt.
    """
    manifest["status"] = "CANCELLED"
    manifest["phase"] = "Vom Editor abgebrochen"
    manifest["cancelRequested"] = True
    if claim:
        manifest["worker"] = {**claim, "heartbeatAt": int(time.time() * 1000)}
    store.log_event(
        job_id,
        "worker.cancelled",
        "Abbruchanforderung bestätigt; Ergebnis wird verworfen.",
        level="warning",
        status="CANCELLED",
        phase="Vom Editor abgebrochen",
    )
    store.write_manifest(job_id, manifest)
    store.consume_cancel_flag(job_id)
    store.log(job_id, f"abgebrochen (cancel.flag){' – ' + note if note else ''}")
    return "cancelled"


def run_job(
    store: JobStore,
    job_id: str,
    manifest: dict,
    *,
    model_dir: str,
    device: str,
    adapter: str,
    work_dir: str,
    cancel_poll: float = CANCEL_POLL_SECONDS,
) -> str:
    """Ein Job, vollständig: Hash prüfen, rechnen, prüfen, zurückschreiben.

    Ein Abbruch des Editors wird in *jeder* Phase ernst genommen – vor dem
    Upload, während der Inferenz (Watchdog beendet den Adapter) und vor dem
    Zurückschreiben. Ergebnis eines abgebrochenen Laufs ist `CANCELLED`, nie
    ein Ergebnis, das der Editor doch noch importiert (§37).
    """
    if manifest.get("status") in TERMINAL_STATUSES:
        store.log(job_id, f"übersprungen – Status {manifest['status']} (§19)")
        return "skipped"
    if store.cancel_requested(job_id):
        return _finish_cancelled(store, job_id, manifest, note="vor dem Start")
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
    lease_heartbeat = WorkerLeaseHeartbeat(store, job_id, dict(claim))
    lease_heartbeat.start()
    store.log_event(
        job_id,
        "worker.claimed",
        "Worker hat den Job beansprucht.",
        status="RUNNING",
        phase="Arbeitskopie wird geladen",
        percent=1,
        device=device,
    )

    try:
        remote_input = os.path.join(store.root, manifest["input"]["relativePath"])
        if not os.path.isfile(remote_input):
            raise ProtocolError("REMOTE_INPUT_MISSING", f"Eingabedatei fehlt: {remote_input}")
        local_input = os.path.join(work_dir, job_id, manifest["input"]["fileName"])
        os.makedirs(os.path.dirname(local_input), exist_ok=True)
        shutil.copyfile(remote_input, local_input)
        if store.cancel_requested(job_id):
            return _finish_cancelled(store, job_id, manifest, claim, note="beim Laden der Arbeitskopie")
        actual = sha256_file(local_input)
        if actual != manifest["input"]["sha256"]:
            raise ProtocolError(
                "REMOTE_INPUT_HASH_MISMATCH",
                f"SHA256 der Arbeitskopie stimmt nicht ({actual[:12]}… statt {manifest['input']['sha256'][:12]}…)",
            )
        store.log_event(
            job_id,
            "worker.input_verified",
            "Arbeitskopie wurde per SHA-256 verifiziert.",
            status="RUNNING",
            phase="Eingabe verifiziert",
            percent=2,
            device=device,
        )

        output_dir = store.output_dir(job_id)
        os.makedirs(output_dir, exist_ok=True)

        last_progress_key: List[Optional[Tuple[str, int]]] = [None]

        def on_progress(fraction: float, phase: str) -> None:
            percent = max(0, min(99, int(fraction * 100)))
            manifest["percent"] = max(int(manifest.get("percent") or 0), percent)
            manifest["phase"] = phase or "Inferenz läuft"
            manifest.setdefault("worker", claim)["heartbeatAt"] = int(time.time() * 1000)
            store.write_manifest(job_id, manifest)
            progress_key = (manifest["phase"], manifest["percent"] // 10)
            if progress_key != last_progress_key[0]:
                last_progress_key[0] = progress_key
                store.log_event(
                    job_id,
                    "worker.inference_progress",
                    f"{manifest['phase']} ({manifest['percent']} %).",
                    status="RUNNING",
                    phase=manifest["phase"],
                    percent=manifest["percent"],
                    device=device,
                )

        watchdog = CancelWatchdog(lambda: store.cancel_requested(job_id), poll_seconds=cancel_poll)
        runner = LocalAdapterRunner(adapter)
        store.log_event(
            job_id,
            "worker.inference_started",
            f"Inferenz mit {manifest['engine'].get('modelId')} gestartet.",
            status="RUNNING",
            phase="Inferenz läuft",
            percent=3,
            device=device,
        )
        try:
            report = runner.run(
                manifest=manifest,
                input_path=local_input,
                output_dir=output_dir,
                model_dir=model_dir,
                device=device,
                on_progress=on_progress,
                watchdog=watchdog,
            )
        except ProtocolError as error:
            if device != "cpu" and error.code in {"GPU_UNAVAILABLE", "GPU_OUT_OF_MEMORY", "INFERENCE_FAILED"}:
                # §21 F/G: GPU nicht nutzbar ⇒ CPU versuchen, nicht aufgeben.
                store.log_event(
                    job_id,
                    "worker.cpu_fallback",
                    "GPU nicht verfügbar; Verarbeitung wird auf CPU fortgesetzt.",
                    level="warning",
                    status="RUNNING",
                    phase="Verarbeitung läuft – CPU-Fallback",
                    code=error.code,
                    device="cpu",
                )
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
                    watchdog=watchdog,
                )
                report["cpuFallback"] = True
                report["fallbackReason"] = error.message[:300]
            else:
                raise

        store.log_event(
            job_id,
            "worker.inference_completed",
            "Inferenz wurde ohne Fehler abgeschlossen.",
            status="RUNNING",
            phase="Ergebnisse werden geschrieben",
            percent=95,
            device=str(report.get("device") or device),
        )

        # Abbruch gewinnt – auch kurz vor der Abgabe der Stems (§37)
        if watchdog.triggered or store.cancel_requested(job_id):
            return _finish_cancelled(store, job_id, manifest, claim, note="Ergebnis verworfen")

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
            store.log_event(
                job_id,
                "worker.output_written",
                f"Stem {stem_id} geschrieben und geprüft.",
                status="RUNNING",
                phase=f"Ergebnis {stem_id} geschrieben",
                percent=96,
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
        store.log_event(
            job_id,
            "worker.completed",
            f"Job abgeschlossen; {len(stems)} geprüfte Stems liegen bereit.",
            status="COMPLETED",
            phase="Fertig",
            percent=100,
            device=str(device_report),
        )
        # Manifest als letzter Commit-Marker: beim ersten COMPLETED-Poll sind
        # Stems, Ergebnisdokument und Ablaufspur bereits in der Ablage.
        store.write_manifest(job_id, manifest)
        return "completed"
    except JobCancelled as cancelled:
        # „während der Rechnung“ ist der Nachweis, dass der Watchdog gegriffen
        # hat – der Selbsttest (tests/stem-remote-worker-selftest.test.mjs)
        # prüft genau dieses Wort, damit dieser Pfad nie wieder fehlt.
        return _finish_cancelled(store, job_id, manifest, claim, note=f"während der Rechnung – {cancelled}")
    except ProtocolError as error:
        manifest["status"] = "FAILED"
        manifest["phase"] = "Fehlgeschlagen"
        manifest["error"] = {"code": error.code, "message": error.message, "at": int(time.time() * 1000)}
        manifest["worker"] = {**claim, "heartbeatAt": int(time.time() * 1000)}
        store.log_event(job_id, "worker.failed", f"Worker hat den Job mit Fehlercode {error.code} beendet.", level="error", status="FAILED", phase="Fehlgeschlagen", code=error.code)
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, error.code, error.message, store.worker_id)
        store.log(job_id, f"FAILED – {error.code}: {error.message}")
        return "failed"
    except Exception as error:  # noqa: BLE001 – ein Job darf den Worker nie beenden
        manifest["status"] = "FAILED"
        manifest["phase"] = "Fehlgeschlagen"
        manifest["error"] = {"code": "INFERENCE_FAILED", "message": str(error)[:500], "at": int(time.time() * 1000)}
        manifest["worker"] = {**claim, "heartbeatAt": int(time.time() * 1000)}
        store.log_event(job_id, "worker.failed", "Worker hat den Job wegen eines unerwarteten Fehlers beendet.", level="error", status="FAILED", phase="Fehlgeschlagen", code="INFERENCE_FAILED")
        store.write_manifest(job_id, manifest)
        store.write_error(job_id, "INFERENCE_FAILED", str(error)[:500], store.worker_id)
        store.log(job_id, f"FAILED – INFERENCE_FAILED: {error}")
        return "failed"
    finally:
        lease_heartbeat.stop()


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
        # Lease-Lebenszeichen laufen auch ohne Inferenz-Progress weiter.
        heartbeat_job_id = str(uuid.uuid4())
        os.makedirs(store.job_dir(heartbeat_job_id), exist_ok=True)
        heartbeat_claim = store.claim(heartbeat_job_id)
        heartbeat_claim["heartbeatAt"] = int(time.time() * 1000) - 60_000
        write_json_atomic(store.claim_path(heartbeat_job_id), heartbeat_claim)
        lease_heartbeat = WorkerLeaseHeartbeat(store, heartbeat_job_id, heartbeat_claim, interval=1.0)
        lease_heartbeat.start()
        time.sleep(1.1)
        lease_heartbeat.stop()
        assert other.claim_is_fresh(heartbeat_job_id) is True, "Lease muss während langer Inferenz regelmäßig erneuert werden"
        assert read_json(store.claim_path(heartbeat_job_id))["heartbeatAt"] > int(time.time() * 1000) - 5_000
        # Text- und JSONL-Diagnose bleiben auch nach vielen Ereignissen begrenzt.
        bounded_job_id = str(uuid.uuid4())
        trace_path = store.worker_trace_path(bounded_job_id)
        log_path = os.path.join(store.job_dir(bounded_job_id), "logs", "worker.log")
        for index in range(MAX_WORKER_TRACE_LINES + 9):
            store._append_capped_line(trace_path, json.dumps({"index": index}))
            store._append_capped_line(log_path, f"line-{index}")
        with open(trace_path, "r", encoding="utf-8") as handle:
            trace_lines = handle.readlines()
        with open(log_path, "r", encoding="utf-8") as handle:
            text_lines = handle.readlines()
        assert len(trace_lines) == MAX_WORKER_TRACE_LINES and json.loads(trace_lines[0])["index"] == 9
        assert len(text_lines) == MAX_WORKER_TRACE_LINES and text_lines[0].strip() == "line-9"
        # 5. cancel.flag gewinnt – und wird verbraucht, damit der Ordner
        #    für einen erneut veröffentlichten Lauf nicht verseucht bleibt
        with open(store.cancel_flag_path(job_id), "w", encoding="utf-8") as handle:
            handle.write("{}")
        pending = dict(manifest, status="RUNNING")
        store.write_manifest(job_id, pending)
        assert run_job(store, job_id, store.read_manifest(job_id), model_dir=tmp, device="cpu", adapter="unused", work_dir=tmp) == "cancelled"
        assert store.cancel_requested(job_id) is False, "Abbruchbitte muss nach der Erfüllung weg sein"
        assert store.read_manifest(job_id)["status"] == "CANCELLED"
        # 6. Abbruch WÄHREND der Laufzeit: der Watchdog beendet den Kindprozess
        flag_state = {"hit": False}
        sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        watchdog = CancelWatchdog(lambda: flag_state["hit"], poll_seconds=0.2, grace_seconds=2)
        watchdog.attach(sleeper)
        watchdog.start()
        try:
            time.sleep(0.4)
            assert sleeper.poll() is None, "Watchdog darf nicht ohne Grund beenden"
            flag_state["hit"] = True
            deadline = time.time() + 15
            while time.time() < deadline and not (watchdog.triggered and sleeper.poll() is not None):
                time.sleep(0.1)
            assert watchdog.triggered, "cancel.flag während der Inferenz wird übersehen"
            assert sleeper.poll() is not None, "Adapter läuft nach dem Abbruch weiter (GPU/Colab brennt weiter)"
        finally:
            watchdog.stop()
            if sleeper.poll() is None:
                sleeper.kill()
        # 7. Einzelfall „Prüfen ohne Fahne“: Watchdog löst nicht von selbst aus
        quiet = CancelWatchdog(lambda: False, poll_seconds=0.2)
        quiet.start()
        time.sleep(0.5)
        assert quiet.triggered is False and quiet.checked > 0, "Watchdog prüft, ohne voreilig abzubrechen"
        quiet.stop()
        # 8. Abbruch END-TO-END: Adapter rechnet, Editor setzt cancel.flag,
        #    der Lauf stirbt – und die Fahne ist danach verbraucht.
        live_id = str(uuid.uuid4())
        live_dir = store.job_dir(live_id)
        os.makedirs(os.path.join(live_dir, "input"), exist_ok=True)
        os.makedirs(os.path.join(live_dir, "output"), exist_ok=True)
        mix_path = os.path.join(live_dir, "input", "mix.wav")
        with open(mix_path, "wb") as handle:
            handle.write(b"RIFF" + b"\x00" * 64)
        fake_adapter = os.path.join(tmp, "slow_adapter.py")
        with open(fake_adapter, "w", encoding="utf-8") as handle:
            handle.write(
                "import json, sys, time\n"
                "print(json.dumps({'type': 'progress', 'fraction': 0.1, 'phase': 'chunk 1'}), flush=True)\n"
                "time.sleep(120)\n"
            )
        live_manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "jobId": live_id,
            "status": "RUNNING",
            "createdAt": int(time.time() * 1000),
            "engine": {
                "modelId": "bsroformer-musdb18hq-4stem-zfturbo",
                "profile": "HIGH_QUALITY",
                "stems": ["vocals"],
                "family": "bs_roformer",
                "checkpoint": {"file": "model.ckpt"},
            },
            "input": {
                "fileName": "mix.wav",
                "relativePath": f"jobs/{live_id}/input/mix.wav",
                "sha256": sha256_file(mix_path),
                "bytes": os.path.getsize(mix_path),
            },
            "output": {"stems": []},
        }
        store.write_manifest(live_id, live_manifest)
        started_at = time.time()
        outcome_box: Dict[str, Any] = {}

        def _cancel_soon() -> None:
            time.sleep(1.2)
            with open(store.cancel_flag_path(live_id), "w", encoding="utf-8") as handle:
                handle.write('{"reason":"self-test"}')

        bomber = threading.Thread(target=_cancel_soon, daemon=True)
        bomber.start()
        outcome_box["value"] = run_job(
            store,
            live_id,
            store.read_manifest(live_id),
            model_dir=tmp,
            device="cpu",
            adapter=fake_adapter,
            work_dir=os.path.join(tmp, "work"),
            cancel_poll=0.3,
        )
        bomber.join(timeout=5)
        elapsed = time.time() - started_at
        assert outcome_box["value"] == "cancelled", f"laufender Job endete als {outcome_box['value']}, erwartet cancelled"
        assert elapsed < 60, "Der Lauf durfte nicht bis zum Ende des Adapters warten"
        assert store.read_manifest(live_id)["status"] == "CANCELLED"
        assert store.cancel_requested(live_id) is False, "Fahne muss nach dem Erfüllen verbraucht sein"
        assert not os.listdir(os.path.join(live_dir, "output")), "ein abgebrochener Lauf legt nichts ab"
        with open(store.worker_trace_path(live_id), "r", encoding="utf-8") as handle:
            trace_steps = {json.loads(line)["step"] for line in handle if line.strip()}
        for step in ("worker.claimed", "worker.input_verified", "worker.inference_started", "worker.inference_progress", "worker.cancelled"):
            assert step in trace_steps, f"Diagnoseprotokoll enthält {step} nicht"
        print("[STEM-REMOTE-WORKER] Selbsttest OK (Manifest, Idempotenz, Vollständigkeit, Lease, Trace/Log-Begrenzung, Abbruch vor/während der Rechnung)")
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
    parser.add_argument(
        "--cancel-poll",
        type=float,
        default=CANCEL_POLL_SECONDS,
        help="Sekunden zwischen Abbruch-Prüfungen während der Inferenz (0 = nur vor dem Start)",
    )
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-jobs", type=int, default=0, help="0 = unbegrenzt")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def _console_event(worker_id: str, step: str, **fields: Any) -> None:
    event = {
        "source": "worker",
        "at": int(time.time() * 1000),
        "step": step,
        "workerId": worker_id,
        **fields,
    }
    print("[STEM-REMOTE-WORKER] " + json.dumps(event, sort_keys=True, ensure_ascii=True), flush=True)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.root:
        print("[STEM-REMOTE-WORKER] Kein --root angegeben (Drive-Ordner der Jobablage).", file=sys.stderr)
        return 2
    store = JobStore(args.root, args.worker)
    os.makedirs(args.work_dir, exist_ok=True)
    _console_event(args.worker, "worker.started", rootLabel=os.path.basename(os.path.normpath(store.root)), device=args.device)
    processed = 0
    while True:
        job_ids = store.list_job_ids()
        pending = 0
        cycle_processed = 0
        for job_id in job_ids:
            if args.max_jobs and processed >= args.max_jobs:
                break
            manifest = store.read_manifest(job_id)
            if not manifest:
                continue
            try:
                validate_manifest(manifest, job_id)
            except ProtocolError as error:
                store.log_event(job_id, "worker.manifest_invalid", "Manifest konnte nicht validiert werden.", level="error", code=error.code)
                continue
            if manifest.get("status") in TERMINAL_STATUSES:
                continue
            pending += 1
            outcome = run_job(
                store,
                job_id,
                manifest,
                model_dir=args.model_dir,
                device=args.device,
                adapter=args.adapter,
                work_dir=args.work_dir,
                cancel_poll=args.cancel_poll,
            )
            if outcome in {"completed", "failed", "cancelled"}:
                processed += 1
                cycle_processed += 1
        sleep_seconds = max(5, args.poll)
        _console_event(
            args.worker,
            "worker.poll",
            scanned=len(job_ids),
            pending=pending,
            processed=cycle_processed,
            sleepSeconds=sleep_seconds,
        )
        if args.once:
            _console_event(args.worker, "worker.stopped", processed=processed, reason="once")
            return 0
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
