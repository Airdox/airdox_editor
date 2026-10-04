#!/usr/bin/env python3
"""
airdox_SMART_Editor — Fernworker für Google Colab (High Quality extern).

Dieser Worker ist die zweite Hälfte des Fernpfads (§15–§22, §30–§37): der
Editor legt einen Job in der Google-Drive-Ablage an, dieser Worker findet ihn,
beansprucht ihn, rechnet mit dem BS-RoFormer-Adapter und schreibt die Stems
zurück. Der Editor bleibt dabei die einzige Instanz, die entscheidet, ob ein
Ergebnis gilt (§24, §42).

Protokoll — **identisch** zu `src/stems/remote/layout.ts` und zum Node-Worker
(`scripts/stem-remote-worker.ts`). Beide Seiten schreiben dieselben Dateien:

    <root>/
      worker.status.json              Lebenszeichen dieses Workers
      jobs/<jobId>/manifest.json      Quelle der Wahrheit (Status, Stems, Hashes)
      jobs/<jobId>/claim.json         Lease: wer rechnet gerade (§21 F)
      jobs/<jobId>/cancel.flag        Abbruchwunsch des Editors (§37)
      jobs/<jobId>/error.json         letzter Fehler, maschinenlesbar
      jobs/<jobId>/input/<datei>      Arbeitskopie – **die Originaldatei**
      jobs/<jobId>/output/<stem>.wav  Ergebnisse
      jobs/<jobId>/output/result.json Ergebnissatz mit Hashes
      jobs/<jobId>/logs/worker.log    lesbares Protokoll
      jobs/<jobId>/logs/worker.jsonl  strukturierte, korrelierbare Schritte

Eingabe = Originaldatei, kein Rendering (§3, Phase 1 des Master-Plans):
  Der Editor kopiert seit der Durchleitung die echte Quelldatei (FLAC/MP3/WAV)
  in `input/`, benannt wie im Manifest (`input.fileName`). Dieser Worker lädt
  sie nativ – `load_input_track()` dekodiert FLAC verlustfrei. Es wird hier
  **nie** eine 32-Bit-Float-WAV erzeugt: genau das war der 130-MB-Bloat.

Aufruf (die Zeile baut das Notebook `colab/airdox-stem-remote-worker.md`):
    python3 colab/remote_worker.py --root "<Jobablage>" --check-store
    python3 colab/remote_worker.py --root "<Jobablage>" --adapter python/bsroformer_inference.py --once
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

# =====================================================================
# Gemeinsamer Vertrag mit dem Editor
# =====================================================================
# Diese Werte spiegeln `src/stems/remote/types.ts` und
# `src/stems/remote/manifest.ts::parseManifest`. Der Vertragstest
# `tests/stem-remote-manifest-python.test.mjs` prüft beide Seiten gegen
# dieselbe Fixture – fällt eine Seite aus dem Tritt, fällt der Test.
SCHEMA_VERSION = 1

REMOTE_STATUSES = [
    "PENDING", "PREPARING", "RUNNING", "RECONSTRUCTING",
    "VALIDATING", "COMPLETED", "CANCELLED", "FAILED",
]
TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"]

MANIFEST_FILE = "manifest.json"
CLAIM_FILE = "claim.json"
CANCEL_FILE = "cancel.flag"
ERROR_FILE = "error.json"
INPUT_DIR = "input"
OUTPUT_DIR = "output"
LOGS_DIR = "logs"
RESULT_FILE = "result.json"
WORKER_LOG_FILE = "worker.log"
WORKER_TRACE_FILE = "worker.jsonl"
WORKER_STATUS_FILE = "worker.status.json"

WORKER_VERSION = "colab-worker/2"
DEFAULT_LEASE_MS = 180_000
MAX_TRACE_LINES = 200

DEFAULT_ROOT = Path(
    os.environ.get("AIRODOX_STEM_REMOTE_DIR")
    or "/content/drive/MyDrive/airdox_stem_bridge"
)

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$")
SUPPORTED_INPUT_SUFFIXES = (".flac", ".wav", ".mp3", ".aif", ".aiff")


class ManifestError(ValueError):
    """Manifest ist nicht lesbar oder verletzt den Vertrag (§17, §22, §34)."""


class CancelledByEditor(Exception):
    """Der Editor hat `cancel.flag` gesetzt – Arbeit sofort fallen lassen (§37)."""


# =====================================================================
# Layout (Spiegel von src/stems/remote/layout.ts)
# =====================================================================
def is_safe_job_id(job_id: object) -> bool:
    return isinstance(job_id, str) and bool(_JOB_ID_RE.match(job_id)) and ".." not in job_id


def assert_safe_relative(value: object, job_id: str = "") -> str:
    """Ein fremdes Manifest darf nie aus der Job-Wurzel herausführen."""
    if not isinstance(value, str) or not value:
        raise ManifestError(f"Manifest ohne sicheren relativen Pfad (jobId={job_id})")
    if value.startswith("/") or "\\" in value or ".." in value.split("/"):
        raise ManifestError(f"Unsicherer relativer Pfad im Manifest: {value!r}")
    return value


def jobs_root(root: Path) -> Path:
    return root / "jobs"


def job_dir(root: Path, job_id: str) -> Path:
    if not is_safe_job_id(job_id):
        raise ManifestError(f"Ungültige Job-Id: {job_id!r}")
    return jobs_root(root) / job_id


def _require_string(value: object, field: str, job_id: str) -> str:
    if not isinstance(value, str) or not value:
        raise ManifestError(f"Manifest ohne {field} (jobId={job_id})")
    return value


def validate_manifest(manifest: dict, expected_job_id: Optional[str] = None) -> dict:
    """
    Prüft ein Manifest genau wie `parseManifest` im Editor.

    Bewusst streng: ein Manifest, das nicht sauber gelesen werden kann, ist ein
    FAILED-Job und kein „irgendwie fertig“. Dazu gehört die Schema-Version –
    ein Worker, der eine neuere Version still akzeptiert, würde Felder
    übersehen, die der Editor für zwingend hält.
    """
    if not isinstance(manifest, dict):
        raise ManifestError("Manifest ist kein Objekt")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ManifestError(
            f"Manifest-Schema {manifest.get('schemaVersion')} wird nicht unterstützt "
            f"(erwartet {SCHEMA_VERSION})"
        )
    job_id = manifest.get("jobId")
    if not is_safe_job_id(job_id):
        raise ManifestError(f"Ungültige jobId im Manifest: {job_id!r}")
    if expected_job_id and job_id != expected_job_id:
        raise ManifestError(f"Manifest-Id {job_id} passt nicht zum Verzeichnis {expected_job_id}")
    if manifest.get("status") not in REMOTE_STATUSES:
        raise ManifestError(f"Unbekannter Status {manifest.get('status')!r}")

    block = manifest.get("input")
    if not isinstance(block, dict):
        raise ManifestError("Manifest ohne input-Block")
    _require_string(block.get("sha256"), "input.sha256", job_id)
    _require_string(block.get("fileName"), "input.fileName", job_id)
    assert_safe_relative(block.get("relativePath"), job_id)

    engine = manifest.get("engine")
    if not isinstance(engine, dict):
        raise ManifestError("Manifest ohne engine-Block")
    _require_string(engine.get("modelId"), "engine.modelId", job_id)
    _require_string(engine.get("profile"), "engine.profile", job_id)
    stems = engine.get("stems")
    if not isinstance(stems, list) or not stems:
        raise ManifestError("Manifest ohne engine.stems")

    output = manifest.get("output") or {"stems": []}
    if not isinstance(output, dict) or not isinstance(output.get("stems"), list):
        raise ManifestError("Manifest output.stems ist keine Liste")
    for stem in output["stems"]:
        if not isinstance(stem, dict):
            raise ManifestError("Manifest enthält einen ungültigen Stem-Eintrag")
        _require_string(stem.get("id"), "output.stems[].id", job_id)
        _require_string(stem.get("fileName"), "output.stems[].fileName", job_id)
        assert_safe_relative(stem.get("relativePath"), job_id)
        _require_string(stem.get("sha256"), f"output.stems[{stem.get('id')}].sha256", job_id)
    manifest.setdefault("output", output)
    manifest.setdefault("attempts", 0)
    return manifest


def manifest_input_file_name(manifest: dict) -> Optional[str]:
    """
    Dateiname der Arbeitskopie aus dem Manifest.

    Der Editor schreibt `input.fileName` (`src/stems/remote/manifest.ts`) – bei
    durchgeschleiften Originalen mit deren Endung (`.flac`, `.mp3`, …). Der
    Worker darf nicht raten, welche Datei gemeint ist, wenn sie im Steckbrief
    steht; `input_file` bleibt als Alias für ältere Ablagen.
    """
    if not isinstance(manifest, dict):
        return None
    block = manifest.get("input")
    if isinstance(block, dict):
        name = block.get("fileName")
        if isinstance(name, str) and name.strip():
            return Path(name).name
    legacy = manifest.get("input_file")
    if isinstance(legacy, str) and legacy.strip():
        return Path(legacy).name
    return None


# =====================================================================
# Datei-Helfer: atomar, gestreamt, Drive-tauglich
# =====================================================================
def force_drive_refresh(target_dir: Path) -> None:
    """Erzwingt Aktualisierung des virtuellen Laufwerks (FUSE / Drive for Desktop)."""
    try:
        os.sync()
    except Exception:  # noqa: BLE001 – nicht jedes Dateisystem kennt das
        pass
    try:
        os.listdir(str(target_dir))
    except Exception:  # noqa: BLE001
        pass


def atomic_write_json(path: Path, data: dict) -> None:
    """Schreibt JSON atomar (temp + rename + fsync) – verhindert Halbdateien."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(tmp), str(path))


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(tmp), str(path))


def atomic_read_json(path: Path, default: Optional[dict] = None) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:  # noqa: BLE001 – halbe Datei während des Drive-Syncs
        return default


def sha256_file(path: Path) -> str:
    """SHA-256 per Stream – eine 40-MB-FLAC gehört nicht in den Speicher."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def append_capped_line(path: Path, line: str) -> None:
    """Hängt eine Zeile an und hält die Datei auf `MAX_TRACE_LINES` begrenzt."""
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: List[str] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            existing = [entry for entry in handle.read().splitlines() if entry]
    except Exception:  # noqa: BLE001
        existing = []
    existing.append(line)
    atomic_write_text(path, "\n".join(existing[-MAX_TRACE_LINES:]) + "\n")


def now_ms() -> int:
    return int(time.time() * 1000)


# =====================================================================
# Eingabe: Originaldatei laden, nie neu rendern
# =====================================================================
def load_input_track(input_dir: Path, preferred: Optional[str] = None) -> Path:
    """
    Wählt die Eingabedatei im Job-Input.

    Reihenfolge: Name aus dem Manifest → FLAC → MP3 → WAV → Rest. Der Editor
    benennt die Arbeitskopie nach der Quelle, deshalb ist der Manifest-Name die
    beste Auskunft; die Endungs-Präferenz ist nur der Rückfall.
    """
    if not input_dir.is_dir():
        raise FileNotFoundError(f"Kein Eingabeordner: {input_dir}")
    if preferred:
        candidate = input_dir / preferred
        if candidate.is_file():
            return candidate
    candidates = [
        entry for entry in sorted(input_dir.iterdir())
        if entry.is_file() and entry.suffix.lower() in SUPPORTED_INPUT_SUFFIXES
    ]
    if not candidates:
        raise FileNotFoundError(f"Keine unterstützte Audiodatei in {input_dir} gefunden.")
    order = {".flac": 0, ".mp3": 1, ".wav": 2}
    candidates.sort(key=lambda entry: (order.get(entry.suffix.lower(), 3), entry.name))
    chosen = candidates[0]
    size_mb = chosen.stat().st_size / (1024 * 1024)
    print(f"[WORKER] Eingabe: {chosen.name} ({size_mb:.1f} MB, {chosen.suffix.lower()})")
    return chosen


def prepare_input(job_dir_path: Path, manifest: dict) -> Path:
    """Kompatibilität zu älteren Ablagen: Eingabe ohne Manifest-Namen finden."""
    return load_input_track(job_dir_path / INPUT_DIR, manifest_input_file_name(manifest))


# =====================================================================
# Lease / Abbruch
# =====================================================================
def read_claim(directory: Path) -> Optional[dict]:
    return atomic_read_json(directory / CLAIM_FILE)


def claim_is_fresh(claim: Optional[dict], lease_ms: int = DEFAULT_LEASE_MS) -> bool:
    if not isinstance(claim, dict):
        return False
    stamp = claim.get("heartbeatAt") or claim.get("claimedAt") or 0
    try:
        return (now_ms() - int(stamp)) < lease_ms
    except (TypeError, ValueError):
        return False


def claim_job(directory: Path, worker_id: str, device: str = "auto") -> dict:
    """Schreibt die Lease (§21 F). Der Editor zeigt daraus den Rechner."""
    claim = {
        "id": worker_id,
        "host": socket.gethostname(),
        "claimedAt": now_ms(),
        "heartbeatAt": now_ms(),
        "device": device,
        "version": WORKER_VERSION,
    }
    atomic_write_json(directory / CLAIM_FILE, claim)
    return claim


def cancel_requested(directory: Path) -> bool:
    return (directory / CANCEL_FILE).exists()


def consume_cancel(directory: Path) -> None:
    """
    Verbrauchte Fahne löschen (§21 B, §37).

    Bliebe sie liegen, dürfte derselbe Jobordner nie wieder rechnen – der
    Nutzer würde beim zweiten Versuch wieder „nichts passiert“ sehen.
    """
    try:
        (directory / CANCEL_FILE).unlink()
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass


# =====================================================================
# Worker
# =====================================================================
class Worker:
    def __init__(self, args: argparse.Namespace):
        self.root = Path(args.root).expanduser()
        self.jobs = jobs_root(self.root)
        self.worker_id = args.worker or f"colab-{socket.gethostname()}-{os.getpid()}"
        self.adapter = args.adapter
        self.model_dir = args.model_dir
        self.work_dir = Path(args.work_dir)
        self.device = args.device or "auto"
        self.model_filter = args.model
        self.profile = args.profile
        self.poll_s = max(1.0, float(args.poll))
        self.cancel_poll_s = max(0.5, float(args.cancel_poll))
        self.max_jobs = max(1, int(args.max_jobs))
        self.verbose = bool(args.verbose)
        self.idle_log_s = max(0.0, float(args.idle_log_seconds))
        self.quiet = bool(getattr(args, "quiet", False))

    # ---- Protokollierung -------------------------------------------------
    def log(self, message: str) -> None:
        if not self.quiet:
            print(f"[WORKER] {message}", flush=True)

    def trace(self, job_id: str, step: str, message: str, **fields) -> None:
        """Ein Schritt in beide Log-Dateien – der Editor liest sie mit (§21 D)."""
        at = now_ms()
        event = {
            "id": str(uuid.uuid4()),
            "source": "worker",
            "jobId": job_id,
            "at": at,
            "step": step,
            "level": fields.pop("level", "info"),
            "message": message[:400],
            "workerId": self.worker_id,
            **fields,
        }
        try:
            logs = job_dir(self.root, job_id) / LOGS_DIR
            append_capped_line(logs / WORKER_TRACE_FILE, json.dumps(event, ensure_ascii=False))
            append_capped_line(
                logs / WORKER_LOG_FILE,
                f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(at / 1000))}Z step={step} {event['message']}",
            )
        except Exception:  # noqa: BLE001 – Diagnose darf den Job nicht stoppen
            pass
        self.log(f"jobId={job_id} step={step} {message}")

    def write_manifest(self, directory: Path, manifest: dict, patch: dict) -> dict:
        updated = dict(manifest)
        updated.update(patch)
        updated["updatedAt"] = now_ms()
        updated["updatedAtIso"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write_json(directory / MANIFEST_FILE, updated)
        return updated

    def write_error(self, directory: Path, code: str, message: str) -> None:
        try:
            atomic_write_json(directory / ERROR_FILE, {"code": code, "message": message, "at": now_ms()})
        except Exception:  # noqa: BLE001
            pass

    def heartbeat(self, active_job: Optional[str] = None) -> None:
        try:
            atomic_write_json(self.root / WORKER_STATUS_FILE, {
                "status": "BUSY" if active_job else "IDLE",
                "worker": self.worker_id,
                "job": active_job,
                "device": self.device,
                "version": WORKER_VERSION,
                "timestamp": int(time.time()),
            })
        except Exception:  # noqa: BLE001
            pass

    # ---- Adapter ---------------------------------------------------------
    def adapter_command(self, manifest: dict, input_path: Path, output_dir: Path) -> List[str]:
        engine = manifest.get("engine", {})
        stems = [str(stem) for stem in (engine.get("stems") or [])]
        stem_order = ",".join(str(stem) for stem in (engine.get("stemOrder") or stems))
        checkpoint = (engine.get("checkpoint") or {}).get("file") or ""
        if self.model_dir and checkpoint and not os.path.isabs(checkpoint):
            checkpoint = str(Path(self.model_dir) / checkpoint)
        config = ((engine.get("config") or {}).get("file") or "")
        if self.model_dir and config and not os.path.isabs(config):
            config = str(Path(self.model_dir) / config)
        command = [
            sys.executable, self.adapter,
            "--family", str(engine.get("family") or "bs_roformer"),
            "--checkpoint", checkpoint,
            "--input", str(input_path),
            "--output-dir", str(output_dir),
            "--stem-order", stem_order,
            "--stems", ",".join(stems),
            "--chunk-size", str(int(engine.get("chunkSizeSamples") or 131584)),
            "--num-overlap", str(int(engine.get("numOverlap") or 4)),
            "--device", str(self.device),
        ]
        if config:
            command += ["--config", config]
        return command

    def run_adapter(self, directory: Path, job_id: str, manifest: dict, input_path: Path) -> Dict[str, object]:
        """
        Startet den Adapter und liest seine JSONL-Ereignisse.

        Währenddessen wird `cancel.flag` geprüft: ein Abbruch mitten in einer
        (minuten- bis stundenlangen) Rechnung muss den Kindprozess beenden,
        sonst rechnet die GPU weiter, nachdem der Nutzer längst abgebrochen hat.
        """
        stems_dir = directory / OUTPUT_DIR
        stems_dir.mkdir(parents=True, exist_ok=True)
        command = self.adapter_command(manifest, input_path, stems_dir)
        self.log("Adapter: " + " ".join(shlex.quote(part) for part in command))
        child = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        report: Dict[str, object] = {"device": self.device}
        last_percent = -1
        assert child.stdout is not None

        # Die Adapter-Zeilen laufen in eine Warteschlange, der Abbruch-Takt
        # bleibt im Hauptzweig. Beides zu trennen ist der ganze Punkt: ein
        # Modell, das minutenlang pro Chunk rechnet, sendet in dieser Zeit
        # keine einzige Zeile - die cancel.flag muss trotzdem binnen Sekunden
        # wirken, sonst rechnet die GPU weiter, nachdem der Nutzer abbrach.
        events: "queue.Queue[Optional[str]]" = queue.Queue()

        def pump() -> None:
            try:
                assert child.stdout is not None
                for raw in child.stdout:
                    events.put(raw)
            finally:
                events.put(None)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()

        def terminate_child() -> None:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()

        try:
            while True:
                try:
                    raw = events.get(timeout=self.cancel_poll_s)
                except queue.Empty:
                    if cancel_requested(directory):
                        terminate_child()
                        raise CancelledByEditor("cancel.flag waehrend der Rechnung gesehen")
                    if child.poll() is not None and events.empty():
                        break
                    continue
                if raw is None:
                    break
                line = raw.strip()
                if not line:
                    continue
                if self.verbose:
                    self.log(f"adapter: {line[:300]}")
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                kind = event.get("type")
                if kind == "progress":
                    fraction = float(event.get("fraction") or 0.0)
                    percent = max(0, min(100, int(round(fraction * 100))))
                    if percent != last_percent and percent % 5 == 0:
                        last_percent = percent
                        phase = str(event.get("phase") or "Inferenz läuft")
                        self.write_manifest(directory, manifest, {
                            "status": "RUNNING",
                            "phase": phase,
                            "percent": max(3, min(95, percent)),
                        })
                        self.trace(job_id, "worker.inference_progress", f"{phase} ({percent} %).",
                                   status="RUNNING", phase=phase, percent=percent)
                elif kind == "stem":
                    self.trace(job_id, "worker.stem_written",
                               f"Stem {event.get('name')} vom Adapter geschrieben.",
                               status="RUNNING", percent=90)
                elif kind == "error":
                    raise RuntimeError(f"{event.get('code')}: {event.get('message')}")
                elif kind == "done":
                    report = dict(event)
                elif kind == "log" and self.verbose:
                    self.log(f"adapter[{event.get('level')}]: {event.get('message')}")
                if cancel_requested(directory):
                    terminate_child()
                    raise CancelledByEditor("cancel.flag waehrend der Rechnung gesehen")
        finally:
            if child.poll() is None:
                child.kill()
        code = child.wait()
        if cancel_requested(directory):
            raise CancelledByEditor("cancel.flag nach der Rechnung gesehen")
        if code != 0:
            raise RuntimeError(f"Adapter endete mit Code {code}")
        return report

    # ---- Ergebnisse ------------------------------------------------------
    def collect_stems(self, directory: Path, job_id: str, manifest: dict) -> List[dict]:
        """
        Legt die Stem-Dateien unter den Namen des Editors ab und vermisst sie.

        Der Adapter schreibt `stem_<index>_<id>.wav`; der Editor erwartet
        `output/<id>.wav` (`stemFileName` in `layout.ts`). Beides wird
        akzeptiert, damit derselbe Worker mit beiden Adapter-Fassungen läuft.
        """
        engine = manifest.get("engine", {})
        wanted = [str(stem) for stem in (engine.get("stems") or [])]
        stems_dir = directory / OUTPUT_DIR
        stems_dir.mkdir(parents=True, exist_ok=True)
        delivered: List[dict] = []
        for stem_id in wanted:
            candidates = [stems_dir / f"{stem_id}.wav"]
            candidates += sorted(stems_dir.glob(f"stem_*_{stem_id}.wav"))
            source = next((entry for entry in candidates if entry.is_file()), None)
            if source is None:
                continue
            target = stems_dir / f"{stem_id}.wav"
            if source != target:
                shutil.copyfile(str(source), str(target))
            size = target.stat().st_size
            delivered.append({
                "id": stem_id,
                "fileName": target.name,
                "relativePath": f"jobs/{job_id}/{OUTPUT_DIR}/{target.name}",
                "sha256": sha256_file(target),
                "bytes": size,
                "frames": 0,
                "sampleRate": 0,
                "channels": 0,
            })
        return delivered

    # ---- Ein Job ---------------------------------------------------------
    def process_job(self, directory: Path) -> str:
        job_id = directory.name
        manifest = atomic_read_json(directory / MANIFEST_FILE)
        if manifest is None:
            self.log(f"{job_id}: kein lesbares manifest.json – übersprungen")
            return "skipped"
        try:
            validate_manifest(manifest, job_id)
        except ManifestError as error:
            self.log(f"{job_id}: Manifest ungültig – {error}")
            self.write_error(directory, "REMOTE_MANIFEST_INVALID", str(error))
            return "failed"

        if manifest.get("status") in TERMINAL_STATUSES:
            self.log(f"{job_id} ist {manifest.get('status')} – wird nicht erneut gerechnet (§19).")
            return "skipped"
        if self.model_filter and manifest.get("engine", {}).get("modelId") != self.model_filter:
            self.log(
                f"{job_id}: Modell {manifest.get('engine', {}).get('modelId')} ≠ Filter "
                f"{self.model_filter} – überspringen."
            )
            return "skipped"

        # Abbruch **vor** dem Start (§37): nichts rechnen, was niemand will.
        if cancel_requested(directory):
            self.write_manifest(directory, manifest, {
                "status": "CANCELLED",
                "phase": "Vom Editor abgebrochen",
                "cancelRequested": True,
            })
            consume_cancel(directory)
            self.trace(job_id, "worker.cancelled", "Job abgebrochen (cancel.flag) vor dem Start.",
                       status="CANCELLED", phase="Vom Editor abgebrochen")
            self.log(f"{job_id}: abgebrochen (cancel.flag) vor dem Start")
            return "cancelled"

        claim = read_claim(directory)
        if claim_is_fresh(claim) and claim.get("id") != self.worker_id:
            self.log(f"{job_id}: frisch beansprucht von {claim.get('id')} – dieser Worker lässt ihn.")
            return "skipped"

        claim = claim_job(directory, self.worker_id, self.device)
        manifest = self.write_manifest(directory, manifest, {
            "status": "RUNNING",
            "phase": "Arbeitskopie wird geladen",
            "percent": 1,
            "attempts": int(manifest.get("attempts") or 0) + 1,
            "worker": claim,
        })
        self.heartbeat(job_id)
        self.trace(job_id, "worker.claimed", "Worker hat den Job beansprucht.",
                   status="RUNNING", phase="Arbeitskopie wird geladen", percent=1)

        try:
            # ---- Eingabe: Hash prüfen, bevor gerechnet wird (§22) --------
            input_path = load_input_track(
                directory / INPUT_DIR, manifest_input_file_name(manifest)
            )
            expected = str(manifest.get("input", {}).get("sha256") or "").lower()
            actual = sha256_file(input_path)
            if expected and actual != expected:
                raise RuntimeError(
                    f"SHA256 der Arbeitskopie stimmt nicht ({actual[:12]}… statt {expected[:12]}…)"
                )
            self.trace(job_id, "worker.input_verified",
                       f"Arbeitskopie {input_path.name} per SHA-256 verifiziert.",
                       status="RUNNING", phase="Eingabe verifiziert", percent=2)

            if not self.adapter:
                raise RuntimeError("Kein Adapter angegeben (--adapter) – ohne ihn kann nicht gerechnet werden.")
            if not Path(self.adapter).is_file():
                raise RuntimeError(f"Adapter fehlt: {self.adapter}")

            # ---- Rechnung -------------------------------------------------
            self.trace(job_id, "worker.inference_started", "Inferenz gestartet.",
                       status="RUNNING", phase="Inferenz läuft", percent=3)
            report = self.run_adapter(directory, job_id, manifest, input_path)

            if cancel_requested(directory):
                raise CancelledByEditor("cancel.flag vor der Übergabe gesehen")

            stems = self.collect_stems(directory, job_id, manifest)
            if not stems:
                raise RuntimeError("Der Adapter hat keine Stems geliefert")

            device = str(report.get("device") or self.device)
            completed = self.write_manifest(directory, manifest, {
                "status": "COMPLETED",
                "phase": "Fertig",
                "percent": 100,
                "output": {"stems": stems, "resultFile": f"jobs/{job_id}/{OUTPUT_DIR}/{RESULT_FILE}"},
                "worker": {**claim, "heartbeatAt": now_ms(), "device": device},
            })
            atomic_write_json(directory / OUTPUT_DIR / RESULT_FILE, {
                "schemaVersion": SCHEMA_VERSION,
                "jobId": job_id,
                "status": "COMPLETED",
                "modelId": manifest.get("engine", {}).get("modelId"),
                "profile": manifest.get("engine", {}).get("profile"),
                "completedAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "stems": stems,
                "worker": completed.get("worker"),
                "workerId": self.worker_id,
            })
            self.trace(job_id, "worker.completed",
                       f"Job abgeschlossen; {len(stems)} Stems liegen bereit.",
                       status="COMPLETED", phase="Fertig", percent=100, device=device)
            self.log(f"{job_id}: COMPLETED ({', '.join(stem['id'] for stem in stems)})")
            return "completed"
        except CancelledByEditor as error:
            self.write_manifest(directory, manifest, {
                "status": "CANCELLED",
                "phase": "Vom Editor abgebrochen",
                "cancelRequested": True,
            })
            consume_cancel(directory)
            self.trace(job_id, "worker.cancelled", f"Abbruch während der Rechnung: {error}",
                       status="CANCELLED", phase="Vom Editor abgebrochen")
            self.log(f"{job_id}: abgebrochen (cancel.flag) während der Rechnung")
            return "cancelled"
        except Exception as error:  # noqa: BLE001 – ein Job-Aus ist kein Worker-Aus
            message = str(error)
            self.write_error(directory, "INFERENCE_FAILED", message)
            self.write_manifest(directory, manifest, {
                "status": "FAILED",
                "phase": "Fehlgeschlagen",
                "error": {"code": "INFERENCE_FAILED", "message": message, "at": now_ms()},
            })
            self.trace(job_id, "worker.failed", message, status="FAILED", level="error")
            self.log(f"{job_id}: FAILED – {message}")
            return "failed"
        finally:
            self.heartbeat(None)

    # ---- Schleife --------------------------------------------------------
    def pending_jobs(self) -> List[Path]:
        if not self.jobs.is_dir():
            return []
        force_drive_refresh(self.jobs)
        found = []
        for entry in sorted(self.jobs.iterdir()):
            if entry.is_dir() and is_safe_job_id(entry.name) and (entry / MANIFEST_FILE).is_file():
                found.append(entry)
        return found

    def run_cycle(self) -> int:
        processed = 0
        for directory in self.pending_jobs():
            if processed >= self.max_jobs:
                break
            outcome = self.process_job(directory)
            if outcome in ("completed", "failed", "cancelled"):
                processed += 1
        return processed

    def run(self) -> int:
        self.log(f"Ablage: {self.root} | Worker: {self.worker_id} | Gerät: {self.device}")
        self.heartbeat(None)
        while True:
            processed = self.run_cycle()
            if processed:
                self.log(f"{processed} Job(s) bearbeitet")
            if getattr(self, "once", False):
                self.log(f"{processed} Job(s) bearbeitet – Ende (--once)")
                return 0
            if self.idle_log_s > 0 and processed == 0:
                self.log(f"Warte auf Jobs … ({self.poll_s:.0f} s Takt)")
            time.sleep(self.poll_s)

    # ---- Diagnose --------------------------------------------------------
    def check_store(self) -> int:
        """
        `--check-store`: sehen, was die Ablage sagt – ohne sie zu verändern.

        Das ist die Antwort auf „Wartet auf den externen Rechner“: steht dort
        überhaupt ein Job? Hat ihn schon jemand beansprucht? Liegt eine
        Abbruchfahne? Passt der Modellfilter? Ohne diese Zeilen bleibt der
        Wartezustand ein Ratespiel.
        """
        if not self.root.exists():
            print(f"FEHLER: die Ablage {self.root} existiert nicht.")
            print("Urteil: Google-Drive-Ordner prüfen (Pfad im Editor unter „Fern-Jobs“).")
            return 1
        print(f"Ablage: {self.root}")
        print(f"Worker: {self.worker_id}")
        if not self.jobs.is_dir():
            print("Kein jobs/-Ordner – der Editor hat noch keinen Fern-Job angelegt.")
            print("Urteil: im Editor „High Quality extern“ starten, dann erneut prüfen.")
            return 0
        force_drive_refresh(self.jobs)
        directories = [entry for entry in sorted(self.jobs.iterdir()) if entry.is_dir()]
        if not directories:
            print("Keine Jobs in der Ablage.")
            print("Urteil: im Editor „High Quality extern“ starten, dann erneut prüfen.")
            return 0
        waiting = 0
        for directory in directories:
            manifest = atomic_read_json(directory / MANIFEST_FILE)
            status = manifest.get("status") if manifest else "?"
            phase = (manifest.get("phase") if manifest else "") or ""
            model_id = (manifest.get("engine", {}) or {}).get("modelId") if manifest else "?"
            claim = read_claim(directory)
            flags = []
            if cancel_requested(directory):
                flags.append("Abbruchfahne: JA")
            else:
                flags.append("Abbruchfahne: nein")
            if claim_is_fresh(claim):
                flags.append(f"frisch beansprucht von {claim.get('id')}")
            elif claim:
                flags.append("Lease abgelaufen (Job ist verwaist)")
            else:
                flags.append("ohne Lease")
            print(f"  {directory.name}: status={status} phase={phase} modell={model_id} | " + ", ".join(flags))
            if self.model_filter and model_id != self.model_filter:
                print(f"    → Modellfilter {self.model_filter}: diesen Job würde der Worker überspringen")
            if status not in TERMINAL_STATUSES and not claim_is_fresh(claim):
                waiting += 1
        if waiting:
            print(f"{waiting} Job(s) warten auf einen Worker.")
            if self.model_filter:
                print(f"Urteil: Modellfilter prüfen – der Worker rechnet nur {self.model_filter}.")
            else:
                print("Urteil: Worker-Zelle in Colab starten (Zelle 5) – sie beansprucht die Jobs.")
        else:
            print("Urteil: nichts Offenes – alle Jobs sind beansprucht oder beendet.")
        return 0


# =====================================================================
# Kommandozeile
# =====================================================================
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    """
    Dieselben Optionen, die das Notebook baut (Zelle 5).

    `allow_abbrev=False` ist Pflicht: sonst frisst `--model` die Abkürzung von
    `--model-dir` und überschreibt den Modellordner mit der Modell-Id – der Job
    scheitert dann am fehlenden Checkpoint, statt die Option abzulehnen.
    """
    parser = argparse.ArgumentParser(
        prog="remote_worker.py",
        description="airdox Fernworker – High Quality extern (Google Drive + BS-RoFormer)",
        allow_abbrev=False,
    )
    parser.add_argument("--root", default=str(DEFAULT_ROOT),
                        help="Jobablage (Google-Drive-Ordner oder rclone-Mount)")
    parser.add_argument("--adapter", default=os.environ.get("AIRODOX_STEM_ADAPTER", ""),
                        help="Pfad zu python/bsroformer_inference.py")
    parser.add_argument("--model-dir", default=os.environ.get("AIRODOX_STEM_MODEL_DIR", ""),
                        help="Ordner mit Checkpoint und Config")
    parser.add_argument("--work-dir", default=os.path.join(tempfile.gettempdir(), "airdox-remote-worker"),
                        help="Lokales Arbeitsverzeichnis")
    parser.add_argument("--worker", default="", help="Worker-Kennung für die Lease")
    parser.add_argument("--device", default="auto", help="auto/cpu/cuda/cuda:0/mps")
    parser.add_argument("--model", default="", help="Nur Jobs dieses Modells rechnen (Filter)")
    parser.add_argument("--profile", default="", help="Qualitätsprofil (Anzeige/Protokoll)")
    parser.add_argument("--poll", type=float, default=15.0, help="Sekunden zwischen Ablage-Scans")
    parser.add_argument("--cancel-poll", type=float, default=5.0,
                        help="Sekunden zwischen Abbruch-Prüfungen während der Rechnung")
    parser.add_argument("--max-jobs", type=int, default=1_000_000, help="Höchstzahl Jobs pro Lauf")
    parser.add_argument("--idle-log-seconds", type=float, default=60.0,
                        help="Abstand der „Warte auf Jobs“-Meldung (0 = aus)")
    parser.add_argument("--once", action="store_true", help="Ein Durchlauf, dann beenden")
    parser.add_argument("--verbose", action="store_true", help="Adapter-Ausgabe durchreichen")
    parser.add_argument("--quiet", action="store_true", help="Nur Fehler ausgeben")
    parser.add_argument("--check-store", action="store_true",
                        help="Nur诊断: Ablage beschreiben, nichts verändern")
    parser.add_argument("--self-test", action="store_true",
                        help="Protokoll-Selbsttest (Abbruch, Lease, Manifest) ohne GPU")
    return parser.parse_args(argv)


# =====================================================================
# Selbsttest: Protokoll ohne GPU, ohne Modell, ohne Netz
# =====================================================================
SLOW_ADAPTER = """
import json, os, sys, time
print(json.dumps({"type": "progress", "fraction": 0.1, "phase": "chunk 1"}), flush=True)
time.sleep(30)
print(json.dumps({"type": "done", "device": "cpu"}), flush=True)
"""

FAST_ADAPTER = """
import json, os, sys, wave
import argparse
parser = argparse.ArgumentParser(allow_abbrev=False)
for name in ("--family", "--checkpoint", "--input", "--output-dir", "--stem-order",
             "--stems", "--chunk-size", "--num-overlap", "--device", "--config"):
    parser.add_argument(name)
args = parser.parse_args()
print(json.dumps({"type": "progress", "fraction": 0.5, "phase": "chunk 1"}), flush=True)
for stem in [part for part in (args.stems or "").split(",") if part]:
    with wave.open(os.path.join(args.output_dir, f"{stem}.wav"), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(44100)
        handle.writeframes(b"\\x01\\x00" * 512)
print(json.dumps({"type": "done", "device": "cpu"}), flush=True)
"""


def _selftest_job(root: Path, job_id: str, cancel: bool = False) -> Path:
    directory = job_dir(root, job_id)
    (directory / INPUT_DIR).mkdir(parents=True, exist_ok=True)
    (directory / OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    mix = directory / INPUT_DIR / "mix.flac"
    mix.write_bytes(b"fLaC" + b"\x00" * 64)
    atomic_write_json(directory / MANIFEST_FILE, {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": job_id,
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "status": "RUNNING",
        "phase": "Wartet auf den externen Rechner (Google Drive)",
        "percent": 0,
        "idempotencyKey": "a" * 64,
        "origin": {"app": "airdox_SMART_Editor", "version": "selftest"},
        "input": {
            "fileName": mix.name,
            "relativePath": f"jobs/{job_id}/{INPUT_DIR}/{mix.name}",
            "sha256": sha256_file(mix),
            "bytes": mix.stat().st_size,
            "format": "FLAC",
        },
        "engine": {
            "modelId": "selftest-model",
            "profile": "HIGH_QUALITY",
            "family": "bs_roformer",
            "stems": ["vocals", "drums"],
            "checkpoint": {"file": "model.ckpt"},
            "chunkSizeSamples": 131584,
            "numOverlap": 4,
        },
        "output": {"stems": []},
    })
    if cancel:
        (directory / CANCEL_FILE).write_text("{}\n")
    return directory


def self_test() -> int:
    """
    Prüft das Protokoll, das der Editor erwartet – ohne GPU und ohne Modell.

    Genau diese Pfade waren früher kaputt: die `cancel.flag` wurde nur vor dem
    Start gesehen, nicht während der Rechnung, und der Worker schrieb Dateien
    (`claim.lock`, `done.json`), die der Editor nie liest. Beides fühlt sich für
    den Nutzer gleich an: „ich drücke Abbrechen und es passiert nichts“.
    """
    print("Selbsttest: Protokoll, Lease, Abbruch (ohne GPU)")
    failures: List[str] = []
    with tempfile.TemporaryDirectory(prefix="airdox-worker-selftest-") as tmp:
        root = Path(tmp)
        slow_adapter = root / "slow_adapter.py"
        slow_adapter.write_text(SLOW_ADAPTER)
        fast_adapter = root / "fast_adapter.py"
        fast_adapter.write_text(FAST_ADAPTER)

        base = {
            "root": str(root), "adapter": "", "model_dir": "", "work_dir": str(root / "work"),
            "worker": "colab-selftest", "device": "cpu", "model": "", "profile": "",
            "poll": 1.0, "cancel_poll": 0.5, "max_jobs": 10, "idle_log_seconds": 0.0,
            "once": True, "verbose": False, "quiet": True, "check_store": False, "self_test": False,
        }

        # 1 · Abbruch vor dem Start ⇒ CANCELLED, Fahne verbraucht
        first = _selftest_job(root, "11111111-2222-4333-8444-000000000001", cancel=True)
        worker = Worker(parse_args([
            "--root", str(root), "--worker", "colab-selftest", "--device", "cpu",
            "--once", "--quiet", "--cancel-poll", "0.5",
        ]))
        outcome = worker.process_job(first)
        manifest = atomic_read_json(first / MANIFEST_FILE) or {}
        if outcome != "cancelled" or manifest.get("status") != "CANCELLED":
            failures.append("Abbruch vor dem Start führte nicht zu CANCELLED")
        if (first / CANCEL_FILE).exists():
            failures.append("cancel.flag wurde nicht verbraucht")
        print("  ✓ Job abgebrochen (cancel.flag) vor dem Start, Fahne verbraucht")

        # 2 · Abbruch **während** der Rechnung ⇒ Watchdog beendet den Kindprozess.
        #    Die Fahne erscheint erst, nachdem der Adapter läuft – genau der Fall,
        #    der früher übersehen wurde (GPU rechnete nach dem Klick weiter).
        second = _selftest_job(root, "22222222-3333-4444-8555-000000000002")
        worker.adapter = str(slow_adapter)

        def set_cancel_later() -> None:
            time.sleep(2.0)
            (second / CANCEL_FILE).write_text("{}\n")

        canceller = threading.Thread(target=set_cancel_later, daemon=True)
        started = time.time()
        canceller.start()
        outcome = worker.process_job(second)
        canceller.join(timeout=5)
        elapsed = time.time() - started
        manifest = atomic_read_json(second / MANIFEST_FILE) or {}
        if outcome != "cancelled" or manifest.get("status") != "CANCELLED":
            failures.append("Abbruch während der Rechnung führte nicht zu CANCELLED")
        # Der Adapter schläft 30 s; ein funktionierender Watchdog ist deutlich
        # früher fertig. Bleibt er bei ~30 s, wurde die Fahne nicht gelesen.
        if elapsed > 20:
            failures.append(f"Abbruch während der Rechnung hat {elapsed:.0f} s gedauert (Watchdog wirkungslos)")
        if elapsed < 1.5:
            failures.append("Abbruch wurde vor dem Adapter-Start erkannt – der Watchdog-Pfad lief nicht")
        print(f"  ✓ Abbruch während der Rechnung: nach {elapsed:.1f} s beendet (Adapter lief), Status CANCELLED")

        # 3 · Ein sauberer Lauf schreibt claim.json, result.json und COMPLETED
        third = _selftest_job(root, "33333333-4444-4555-8666-000000000003")
        worker.adapter = str(fast_adapter)
        outcome = worker.process_job(third)
        manifest = atomic_read_json(third / MANIFEST_FILE) or {}
        if outcome != "completed" or manifest.get("status") != "COMPLETED":
            failures.append("sauberer Lauf endete nicht COMPLETED")
        if not (third / CLAIM_FILE).exists():
            failures.append("claim.json fehlt")
        if not (third / OUTPUT_DIR / RESULT_FILE).exists():
            failures.append("output/result.json fehlt")
        stems = (manifest.get("output") or {}).get("stems") or []
        if len(stems) != 2:
            failures.append(f"erwartete 2 Stems im Manifest, gefunden {len(stems)}")
        if (manifest.get("worker") or {}).get("id") != "colab-selftest":
            failures.append("Worker steht nicht im Manifest")
        print("  ✓ sauberer Lauf: claim.json, result.json, COMPLETED mit Stems und Worker")

        # 4 · Fertige Jobs laufen nicht erneut (§19)
        again = worker.process_job(third)
        if again != "skipped":
            failures.append("fertiger Job wurde erneut gerechnet")
        print("  ✓ COMPLETED bleibt COMPLETED – kein zweiter Lauf (§19)")

        # 5 · Diagnose verändert nichts
        before = sorted(entry.name for entry in third.iterdir())
        Worker(parse_args(["--root", str(root), "--check-store", "--quiet"])).check_store()
        after = sorted(entry.name for entry in third.iterdir())
        if before != after:
            failures.append("--check-store hat die Ablage verändert")
        print("  ✓ --check-store beschreibt die Ablage, ohne sie zu verändern")

    if failures:
        print("Selbsttest FEHLGESCHLAGEN:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Selbsttest OK")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    worker = Worker(args)
    worker.once = bool(args.once)
    if args.check_store:
        return worker.check_store()
    if not worker.root.exists():
        print(f"FEHLER: die Ablage {worker.root} existiert nicht.")
        return 1
    worker.jobs.mkdir(parents=True, exist_ok=True)
    return worker.run()


if __name__ == "__main__":
    sys.exit(main())
