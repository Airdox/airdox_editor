#!/usr/bin/env python3
"""Test: colab/remote_worker.py — Master-Plan Phase 2-10 (Stück für Stück)"""
import sys, os, tempfile, time, json, hashlib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'colab'))

from pathlib import Path
from remote_worker import (
    force_drive_refresh, atomic_write_json, atomic_read_json,
    sha256_file, HeartbeatWorker, claim_job, ProgressWriter,
    write_done_manifest, prepare_input
)

def test_force_refresh():
    with tempfile.TemporaryDirectory() as td:
        force_drive_refresh(Path(td))
        assert True, "force_drive_refresh completed"
    print("[PASS] Phase 3 — force_drive_refresh")

def test_atomic_json():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "test.json"
        atomic_write_json(p, {"a": 1, "b": [2, 3]})
        data = atomic_read_json(p)
        assert data["a"] == 1
        assert p.exists()
        # Kein Halbfile (.tmp) darf übrig bleiben
        assert not (p.with_suffix(p.suffix + ".tmp")).exists()
    print("[PASS] Phase 4/6/7/8 — atomic_write_json + read")

def test_sha256():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "dummy.wav"
        p.write_text("test")
        h = sha256_file(p)
        assert len(h) == 64
        assert h == hashlib.sha256(b"test").hexdigest()
    print("[PASS] Phase 8 — sha256_file")

def test_heartbeat():
    with tempfile.TemporaryDirectory() as td:
        hb = HeartbeatWorker(Path(td))
        hb.tick()
        status_path = Path(td) / "worker.status.json"
        assert status_path.exists()
        data = atomic_read_json(status_path)
        assert data["status"] == "IDLE"
        assert "timestamp" in data
        assert "vram_free_mb" in data
    print("[PASS] Phase 4 — HeartbeatWorker.tick()")

def test_claim_and_progress():
    with tempfile.TemporaryDirectory() as td:
        job_dir = Path(td) / "jobs" / "j01"
        job_dir.mkdir(parents=True)
        # Claim
        assert claim_job(job_dir) is True
        assert (job_dir / "claim.lock").exists()
        # Zweiter Claim soll False zurückgeben (jung < 30 s)
        assert claim_job(job_dir) is False
        # Progress
        pw = ProgressWriter(job_dir / "progress.json")
        pw.update(45, "Inferenz...")
        prog = atomic_read_json(job_dir / "progress.json")
        assert prog["percent"] == 45
    print("[PASS] Phase 6 — claim_job + Phase 7 — ProgressWriter")

def test_done_manifest():
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "output"
        out.mkdir()
        # Fake stems
        for s in ["drums.wav", "bass.wav", "other.wav", "vocals.wav"]:
            (out / s).write_text("stem_data")
        done_path = write_done_manifest(out, "j01", ["drums", "bass", "other", "vocals"])
        assert done_path.exists()
        done = atomic_read_json(done_path.parent / "done.json")
        assert done["status"] == "COMPLETED"
        assert "drums.wav" in done["files"]
        assert done["files"]["drums.wav"]["bytes"] == len("stem_data")
        assert len(done["files"]["drums.wav"]["sha256"]) == 64
    print("[PASS] Phase 8 — write_done_manifest")

def test_prepare_input():
    with tempfile.TemporaryDirectory() as td:
        inp = Path(td) / "input"
        inp.mkdir()
        # FLAC bevorzugt
        (inp / "track.flac").write_text("flac")
        (inp / "track.mp3").write_text("mp3")
        manifest = {"job_id": "j01"}
        result = prepare_input(Path(td), manifest)
        assert result.name == "track.flac"
    print("[PASS] Phase 1 — prepare_input (Original beibehalten)")

if __name__ == "__main__":
    test_force_refresh()
    test_atomic_json()
    test_sha256()
    test_heartbeat()
    test_claim_and_progress()
    test_done_manifest()
    test_prepare_input()
    print("\n=== ALLE COlab-TESTS BESTANDEN ===")
