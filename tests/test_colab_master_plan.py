#!/usr/bin/env python3
"""
Python-Seite des Fernworker-Protokolls (colab/remote_worker.py).

Warum diese Datei existiert: der Worker ist die Hälfte des Fernpfads, die nie
im Editor läuft. Sein Protokoll muss **dasselbe** sein wie das des Editors
(`src/stems/remote/layout.ts`) – sonst legt der Worker Dateien an, die niemand
liest, und der Editor wartet für immer auf „Wartet auf den externen Rechner“.
Genau das war passiert: der Worker schrieb `claim.lock` und `done.json`, der
Editor las `claim.json` und `manifest.json`.

Die TS-Suite (`tests/stem-remote-worker-cli.test.mjs`) prüft denselben Worker
über die Kommandozeile; hier werden die Bausteine direkt geprüft.

Aufruf:  python3 tests/test_colab_master_plan.py
"""
import hashlib
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'colab'))

from remote_worker import (  # noqa: E402
    CANCEL_FILE,
    CLAIM_FILE,
    INPUT_DIR,
    LOGS_DIR,
    MANIFEST_FILE,
    OUTPUT_DIR,
    RESULT_FILE,
    SCHEMA_VERSION,
    WORKER_LOG_FILE,
    WORKER_TRACE_FILE,
    ManifestError,
    atomic_read_json,
    atomic_write_json,
    cancel_requested,
    claim_is_fresh,
    claim_job,
    consume_cancel,
    force_drive_refresh,
    load_input_track,
    manifest_input_file_name,
    sha256_file,
    validate_manifest,
)


def test_layout_matches_editor():
    """Die Dateinamen müssen exakt die aus src/stems/remote/layout.ts sein."""
    assert MANIFEST_FILE == "manifest.json"
    assert CLAIM_FILE == "claim.json"          # nicht claim.lock
    assert CANCEL_FILE == "cancel.flag"
    assert INPUT_DIR == "input"
    assert OUTPUT_DIR == "output"
    assert LOGS_DIR == "logs"
    assert RESULT_FILE == "result.json"        # nicht done.json
    assert WORKER_LOG_FILE == "worker.log"
    assert WORKER_TRACE_FILE == "worker.jsonl"
    assert SCHEMA_VERSION == 1
    print("[PASS] Layout identisch zum Editor (claim.json, cancel.flag, result.json)")


def test_atomic_json():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "test.json"
        atomic_write_json(path, {"a": 1, "b": [2, 3]})
        data = atomic_read_json(path)
        assert data["a"] == 1
        assert path.exists()
        # Keine Halbdatei darf liegen bleiben.
        assert not path.with_suffix(path.suffix + ".tmp").exists()
        # Eine unlesbare Datei ergibt den Default statt einer Exception.
        broken = Path(td) / "broken.json"
        broken.write_text("{")
        assert atomic_read_json(broken, {"fallback": True}) == {"fallback": True}
    print("[PASS] atomic_write_json / atomic_read_json (atomar, fehlertolerant)")


def test_sha256_streamed():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "track.flac"
        path.write_bytes(b"fLaC" + b"\x00" * 4096)
        digest = sha256_file(path)
        assert len(digest) == 64
        assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
    print("[PASS] sha256_file (gestreamt, identisch zum Voll-Hash)")


def test_force_refresh_is_readonly():
    with tempfile.TemporaryDirectory() as td:
        before = sorted(os.listdir(td))
        force_drive_refresh(Path(td))
        assert sorted(os.listdir(td)) == before
        # Ein fehlender Ordner darf keine Exception werfen (Drive-Aushängung).
        force_drive_refresh(Path(td) / "gibt-es-nicht")
    print("[PASS] force_drive_refresh verändert nichts")


def test_manifest_contract():
    """Derselbe Vertrag wie parseManifest() im Editor."""
    base = {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": "00000000-0000-4000-8000-000000000001",
        "status": "PENDING",
        "input": {
            "fileName": "track_87868672.flac",
            "relativePath": "jobs/00000000-0000-4000-8000-000000000001/input/track_87868672.flac",
            "sha256": "b" * 64,
        },
        "engine": {
            "modelId": "bsroformer-musdb18hq-4stem-zfturbo",
            "profile": "HIGH_QUALITY",
            "stems": ["drums", "bass", "other", "vocals"],
        },
        "output": {"stems": []},
    }
    validated = validate_manifest(dict(base), "00000000-0000-4000-8000-000000000001")
    assert validated["engine"]["stems"] == ["drums", "bass", "other", "vocals"]
    assert manifest_input_file_name(validated) == "track_87868672.flac"

    wrong_schema = dict(base, schemaVersion=99)
    try:
        validate_manifest(wrong_schema)
        raise AssertionError("fremde Schema-Version wurde akzeptiert")
    except ManifestError:
        pass

    escaping = dict(base)
    escaping["input"] = dict(base["input"], relativePath="../etc/passwd")
    try:
        validate_manifest(escaping)
        raise AssertionError("Pfad aus der Job-Wurzel wurde akzeptiert")
    except ManifestError:
        pass

    # Ältere Ablage ohne input.fileName, aber mit input_file-Alias.
    assert manifest_input_file_name({"input_file": "alt.mp3"}) == "alt.mp3"
    assert manifest_input_file_name({}) is None
    print("[PASS] Manifest-Vertrag (Schema, Pfadschutz, input.fileName + Alias)")


def test_input_prefers_flac_original():
    """Phase 1: die Originaldatei bleibt die Eingabe – kein WAV-Bloat."""
    with tempfile.TemporaryDirectory() as td:
        job = Path(td)
        (job / INPUT_DIR).mkdir(parents=True)
        (job / INPUT_DIR / "track.flac").write_bytes(b"fLaC" + b"\x00" * 64)
        (job / INPUT_DIR / "track.wav").write_bytes(b"RIFF" + b"\x00" * 64)
        # Der Name aus dem Manifest gewinnt – auch wenn eine WAV daneben liegt.
        chosen = load_input_track(job / INPUT_DIR, "track.flac")
        assert chosen.name == "track.flac"
        # Ohne Manifest-Name: FLAC vor WAV.
        assert load_input_track(job / INPUT_DIR).suffix == ".flac"
        try:
            load_input_track(job / "gibt-es-nicht")
            raise AssertionError("fehlender Eingabeordner wurde akzeptiert")
        except FileNotFoundError:
            pass
    print("[PASS] Eingabe = Originaldatei (FLAC gewinnt, kein Rendering)")


def test_lease_and_cancel():
    with tempfile.TemporaryDirectory() as td:
        job = Path(td) / "jobs" / "j01"
        job.mkdir(parents=True)
        assert cancel_requested(job) is False

        claim = claim_job(job, "colab-test", "cuda")
        assert (job / CLAIM_FILE).exists()
        assert claim["id"] == "colab-test"
        assert claim_is_fresh(atomic_read_json(job / CLAIM_FILE)) is True
        # Abgelaufene Lease gilt als verwaist, nicht als belegt.
        stale = dict(claim, heartbeatAt=int(time.time() * 1000) - 10 * 60_000,
                     claimedAt=int(time.time() * 1000) - 10 * 60_000)
        assert claim_is_fresh(stale) is False
        assert claim_is_fresh(None) is False

        (job / CANCEL_FILE).write_text("{}\n")
        assert cancel_requested(job) is True
        consume_cancel(job)
        assert cancel_requested(job) is False, "verbrauchte Fahne muss weg sein (§21 B)"
        consume_cancel(job)  # doppelt verbrauchen darf nicht krachen
    print("[PASS] Lease (claim.json) und cancel.flag inkl. Verbrauch")


if __name__ == "__main__":
    test_layout_matches_editor()
    test_atomic_json()
    test_sha256_streamed()
    test_force_refresh_is_readonly()
    test_manifest_contract()
    test_input_prefers_flac_original()
    test_lease_and_cancel()
    print("\n=== ALLE PYTHON-PROTOKOLLTESTS BESTANDEN ===")
