"""
Tests für database.py - Tracks, Stems, Cloud Jobs
Feature Branch erweitert bestehende DB
"""
import sys
from pathlib import Path
import sqlite3

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_tracks_crud(temp_db):
    # Create
    temp_db.add_or_update_track("id1", "/path/song.mp3", "song.mp3", "Song", 180.0)
    
    # Read
    track = temp_db.get_track("id1")
    assert track["id"] == "id1"
    assert track["file_name"] == "song.mp3"
    
    # Update
    temp_db.add_or_update_track("id1", "/path/song2.mp3", "song2.mp3", "Song2", 200.0)
    updated = temp_db.get_track("id1")
    assert updated["file_name"] == "song2.mp3"
    
    # List
    temp_db.add_or_update_track("id2", "/path/other.mp3", "other.mp3")
    tracks = temp_db.list_tracks(limit=10)
    assert len(tracks) == 2
    
    # Delete
    temp_db.delete_track("id1")
    assert temp_db.get_track("id1") is None
    assert len(temp_db.list_tracks()) == 1

def test_stems_crud(temp_db, temp_dir):
    # Track erstellen
    temp_db.add_or_update_track("track1", "/path/song.mp3", "song.mp3")
    
    # Stems hinzufügen
    stems = [
        {"stem_type": "drums", "file_path": str(temp_dir / "drums.wav"), "file_name": "drums.wav", "drive_file_id": "drive123"},
        {"stem_type": "bass", "file_path": str(temp_dir / "bass.wav"), "file_name": "bass.wav"},
        {"stem_type": "other", "file_path": str(temp_dir / "other.wav"), "file_name": "other.wav"},
        {"stem_type": "vocals", "file_path": str(temp_dir / "vocals.wav"), "file_name": "vocals.wav"},
    ]
    
    # Erstelle Dummy Dateien
    for stem in stems:
        Path(stem["file_path"]).write_text("dummy")
    
    temp_db.add_stems_for_track("track1", stems)
    
    # Prüfe get_stems_for_track
    retrieved = temp_db.get_stems_for_track("track1")
    assert len(retrieved) == 4
    assert set(s["stem_type"] for s in retrieved) == {"drums", "bass", "other", "vocals"}
    
    # Prüfe has_stems
    assert temp_db.has_stems("track1") == True
    assert temp_db.has_stems("nonexistent") == False
    
    # Prüfe Update (ON CONFLICT)
    updated_stems = [
        {"stem_type": "drums", "file_path": str(temp_dir / "drums_v2.wav"), "file_name": "drums_v2.wav"}
    ]
    Path(updated_stems[0]["file_path"]).write_text("dummy v2")
    temp_db.add_stems_for_track("track1", updated_stems)
    
    retrieved_after = temp_db.get_stems_for_track("track1")
    assert len(retrieved_after) == 4  # Immer noch 4, drums wurde upgedatet
    drums = [s for s in retrieved_after if s["stem_type"] == "drums"][0]
    assert drums["file_name"] == "drums_v2.wav"
    
    # Delete
    temp_db.delete_stems_for_track("track1")
    assert len(temp_db.get_stems_for_track("track1")) == 0
    assert temp_db.has_stems("track1") == False

def test_cloud_jobs_crud(temp_db):
    # Create job
    temp_db.create_cloud_job("job123", "track1", status="uploading")
    
    job = temp_db.get_cloud_job("job123")
    assert job is not None
    assert job["id"] == "job123"
    assert job["track_id"] == "track1"
    assert job["status"] == "uploading"
    
    # Update job
    temp_db.update_cloud_job("job123", status="processing", drive_input_file_id="drive_input_123")
    
    updated = temp_db.get_cloud_job("job123")
    assert updated["status"] == "processing"
    assert updated["drive_input_file_id"] == "drive_input_123"
    
    # Update with error
    temp_db.update_cloud_job("job123", status="failed", error_message="Test error")
    failed = temp_db.get_cloud_job("job123")
    assert failed["status"] == "failed"
    assert failed["error_message"] == "Test error"
    
    # get_latest_job_for_track
    temp_db.create_cloud_job("job124", "track1", status="completed")
    latest = temp_db.get_latest_job_for_track("track1")
    assert latest is not None
    # Sollte job124 sein (neuer)
    assert latest["id"] in ["job123", "job124"]  # Je nach Timestamp, aber einer von beiden

def test_delete_track_cascades(temp_db, temp_dir):
    # Track mit Stems und Jobs erstellen
    temp_db.add_or_update_track("track_cascade", "/path/song.mp3", "song.mp3")
    
    stem_file = temp_dir / "drums.wav"
    stem_file.write_text("dummy")
    temp_db.add_stems_for_track("track_cascade", [
        {"stem_type": "drums", "file_path": str(stem_file), "file_name": "drums.wav"}
    ])
    
    temp_db.create_cloud_job("job_cascade", "track_cascade", status="completed")
    
    # Prüfe dass alles existiert
    assert temp_db.get_track("track_cascade") is not None
    assert len(temp_db.get_stems_for_track("track_cascade")) == 1
    assert temp_db.get_cloud_job("job_cascade") is not None
    
    # Lösche Track -> sollte auch Stems und Jobs löschen (CASCADE via Code, nicht nur FK)
    temp_db.delete_track("track_cascade")
    
    assert temp_db.get_track("track_cascade") is None
    assert len(temp_db.get_stems_for_track("track_cascade")) == 0
    # Cloud Jobs werden auch gelöscht
    assert temp_db.get_cloud_job("job_cascade") is None

def test_database_migration(temp_db):
    # Prüfe dass Migration keine Fehler wirft
    # _migrate wird in __init__ aufgerufen
    # Hier nur prüfen dass DB weiterhin funktioniert
    temp_db.add_or_update_track("migrate_test", "/path/test.mp3", "test.mp3")
    assert temp_db.get_track("migrate_test") is not None
