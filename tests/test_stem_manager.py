"""
Tests für stem_manager.py
"""
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_get_stem_dir(stem_manager, temp_stems_dir):
    track_id = "test123"
    stem_dir = stem_manager.get_stem_dir(track_id)
    
    assert stem_dir.exists()
    assert stem_dir == temp_stems_dir / track_id
    assert track_id in str(stem_dir)

def test_list_local_stems_empty(stem_manager):
    stems = stem_manager.list_local_stems("nonexistent")
    assert stems == []

def test_list_local_stems_with_files(stem_manager, temp_stems_dir):
    track_id = "track_with_stems"
    stem_dir = stem_manager.get_stem_dir(track_id)
    
    # Erstelle Dummy Stems
    for stem_type in ["drums", "bass", "other", "vocals"]:
        (stem_dir / f"{stem_type}.wav").write_text(f"{stem_type} data")
    
    stems = stem_manager.list_local_stems(track_id)
    assert len(stems) == 4
    assert all(s.exists() for s in stems)

def test_has_local_stems(stem_manager, temp_stems_dir):
    track_id = "test_has"
    
    assert stem_manager.has_local_stems(track_id) == False
    
    stem_dir = stem_manager.get_stem_dir(track_id)
    for stem_type in ["drums", "bass", "other", "vocals"]:
        (stem_dir / f"{stem_type}.wav").write_text("data")
    
    assert stem_manager.has_local_stems(track_id) == True
    
    # Nur 3 Stems -> False
    track_id2 = "test_has_partial"
    stem_dir2 = stem_manager.get_stem_dir(track_id2)
    for stem_type in ["drums", "bass", "other"]:
        (stem_dir2 / f"{stem_type}.wav").write_text("data")
    
    assert stem_manager.has_local_stems(track_id2) == False

def test_detect_stem_type(stem_manager):
    assert stem_manager._detect_stem_type("drums.wav") == "drums"
    assert stem_manager._detect_stem_type("my_bass_track.wav") == "bass"
    assert stem_manager._detect_stem_type("OTHER_stem.mp3") == "other"
    assert stem_manager._detect_stem_type("vocals_final.wav") == "vocals"
    assert stem_manager._detect_stem_type("unknown.wav") is None
    assert stem_manager._detect_stem_type("drums_bass_mix.wav") in ["drums", "bass"]  # Erstes Match

def test_link_downloaded_stems(stem_manager, temp_db, temp_dir):
    track_id = "link_test"
    
    # Erstelle Dummy heruntergeladene Dateien
    downloaded = []
    for stem_type in ["drums", "bass", "other", "vocals"]:
        f = temp_dir / f"{stem_type}.wav"
        f.write_text(f"{stem_type} content")
        downloaded.append(f)
    
    # Verknüpfe
    linked = stem_manager.link_downloaded_stems(track_id, downloaded)
    
    assert len(linked) == 4
    assert all("stem_type" in s for s in linked)
    assert all("file_path" in s for s in linked)
    
    # Prüfe DB
    stems_in_db = temp_db.get_stems_for_track(track_id)
    assert len(stems_in_db) == 4
    
    # Prüfe dass Dateien in Zielverzeichnis kopiert wurden
    stem_dir = stem_manager.get_stem_dir(track_id)
    for stem_type in ["drums", "bass", "other", "vocals"]:
        assert (stem_dir / f"{stem_type}.wav").exists()

def test_link_downloaded_stems_with_drive_ids(stem_manager, temp_dir):
    track_id = "link_with_ids"
    
    downloaded = []
    for stem_type in ["drums", "bass"]:
        f = temp_dir / f"{stem_type}.wav"
        f.write_text("data")
        downloaded.append(f)
    
    drive_ids = {"drums": "drive_drums_id", "bass": "drive_bass_id"}
    
    linked = stem_manager.link_downloaded_stems(track_id, downloaded, drive_file_ids=drive_ids)
    
    assert len(linked) == 2
    drums = [s for s in linked if s["stem_type"] == "drums"][0]
    assert drums["drive_file_id"] == "drive_drums_id"

def test_delete_stems(stem_manager, temp_db, temp_stems_dir):
    track_id = "delete_test"
    
    # Erstelle Stems
    stem_dir = stem_manager.get_stem_dir(track_id)
    (stem_dir / "drums.wav").write_text("data")
    (stem_dir / "bass.wav").write_text("data")
    
    # Verknüpfe in DB
    temp_db.add_stems_for_track(track_id, [
        {"stem_type": "drums", "file_path": str(stem_dir / "drums.wav"), "file_name": "drums.wav"},
        {"stem_type": "bass", "file_path": str(stem_dir / "bass.wav"), "file_name": "bass.wav"},
    ])
    
    assert len(temp_db.get_stems_for_track(track_id)) == 2
    assert stem_dir.exists()
    
    # Lösche
    stem_manager.delete_stems(track_id, delete_files=True)
    
    assert len(temp_db.get_stems_for_track(track_id)) == 0
    assert not stem_dir.exists()
    
    # Teste delete_files=False
    track_id2 = "delete_no_files"
    stem_dir2 = stem_manager.get_stem_dir(track_id2)
    (stem_dir2 / "drums.wav").write_text("data")
    temp_db.add_stems_for_track(track_id2, [
        {"stem_type": "drums", "file_path": str(stem_dir2 / "drums.wav"), "file_name": "drums.wav"}
    ])
    
    stem_manager.delete_stems(track_id2, delete_files=False)
    assert len(temp_db.get_stems_for_track(track_id2)) == 0
    assert stem_dir2.exists()  # Dateien bleiben

def test_get_stem_paths_for_player(stem_manager, temp_db, temp_stems_dir):
    track_id = "player_test"
    
    # Erstelle Stems und verknüpfe
    stem_dir = stem_manager.get_stem_dir(track_id)
    for stem_type in ["drums", "bass"]:
        p = stem_dir / f"{stem_type}.wav"
        p.write_text("data")
    
    temp_db.add_stems_for_track(track_id, [
        {"stem_type": "drums", "file_path": str(stem_dir / "drums.wav"), "file_name": "drums.wav"},
        {"stem_type": "bass", "file_path": str(stem_dir / "bass.wav"), "file_name": "bass.wav"},
        {"stem_type": "vocals", "file_path": "/nonexistent/vocals.wav", "file_name": "vocals.wav"},  # Existiert nicht
    ])
    
    paths = stem_manager.get_stem_paths_for_player(track_id)
    
    # Nur existierende Dateien sollten zurückkommen
    assert "drums" in paths
    assert "bass" in paths
    assert "vocals" not in paths  # Existiert nicht lokal

def test_organize_downloaded_stems(stem_manager, temp_dir):
    track_id = "organize_test"
    
    # Quelle mit verschachtelten Dateien
    source_dir = temp_dir / "source"
    source_dir.mkdir()
    (source_dir / "drums.wav").write_text("drums")
    (source_dir / "bass.mp3").write_text("bass")
    subdir = source_dir / "subdir"
    subdir.mkdir()
    (subdir / "vocals.wav").write_text("vocals")
    (subdir / "other.flac").write_text("other")
    (source_dir / "ignore.txt").write_text("ignore")
    
    organized = stem_manager.organize_downloaded_stems(track_id, source_dir)
    
    # Sollte 4 Stems finden (ignore.txt ignorieren)
    assert len(organized) == 4
    assert all(p.exists() for p in organized)
    
    # Zielverzeichnis sollte Dateien enthalten
    stem_dir = stem_manager.get_stem_dir(track_id)
    assert (stem_dir / "drums.wav").exists()
    assert (stem_dir / "bass.mp3").exists()
