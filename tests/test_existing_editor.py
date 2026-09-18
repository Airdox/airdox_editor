"""
Tests für bestehenden Editor (Basis) - Sicherstellung dass Workflow Integration Basis nicht bricht
Feature Branch muss bestehenden Editor voll erhalten
"""
import sys
from pathlib import Path
import tempfile
import shutil

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_utils_generate_track_id(tmp_path):
    from audio_editor.utils import generate_track_id
    
    # Erstelle Dummy Datei
    dummy = tmp_path / "song.mp3"
    dummy.write_text("dummy")
    
    track_id1 = generate_track_id(dummy)
    track_id2 = generate_track_id(dummy)
    
    # Gleiche Datei sollte gleiche ID geben (stabile Hash)
    assert track_id1 == track_id2
    assert len(track_id1) == 12  # MD5 truncated
    assert isinstance(track_id1, str)

def test_utils_create_temp_copy(tmp_path):
    from audio_editor.utils import create_temp_copy
    
    source = tmp_path / "original.mp3"
    source.write_text("audio data")
    
    temp_dir = tmp_path / "temp"
    temp_copy = create_temp_copy(source, temp_dir)
    
    assert temp_copy.exists()
    assert temp_copy.read_text() == "audio data"
    assert temp_dir in temp_copy.parents
    # Name sollte Track ID enthalten
    assert source.name in temp_copy.name or len(temp_copy.name) > len(source.name)

def test_utils_format_time():
    from audio_editor.utils import format_time
    
    assert format_time(0) == "00:00"
    assert format_time(65) == "01:05"
    assert format_time(125) == "02:05"
    assert format_time(None) == "--:--"

def test_database_tracks_crud(temp_db):
    # temp_db kommt aus conftest
    from audio_editor.database import AudioDatabase
    
    # add_or_update_track
    temp_db.add_or_update_track(
        track_id="track123",
        file_path="/tmp/song.mp3",
        file_name="song.mp3",
        title="Test Song",
        duration=180.5
    )
    
    # get_track
    track = temp_db.get_track("track123")
    assert track is not None
    assert track["id"] == "track123"
    assert track["file_name"] == "song.mp3"
    assert track["title"] == "Test Song"
    
    # list_tracks
    tracks = temp_db.list_tracks(limit=10)
    assert len(tracks) >= 1
    assert any(t["id"] == "track123" for t in tracks)
    
    # update
    temp_db.add_or_update_track(
        track_id="track123",
        file_path="/tmp/song2.mp3",
        file_name="song2.mp3",
        title="Updated Song"
    )
    updated = temp_db.get_track("track123")
    assert updated["file_name"] == "song2.mp3"
    
    # delete
    temp_db.delete_track("track123")
    assert temp_db.get_track("track123") is None

def test_database_stems_tables_exist(temp_db):
    # Prüfe dass neue Tabellen in Feature Branch existieren
    import sqlite3
    with sqlite3.connect(temp_db.db_path) as conn:
        cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
    
    assert "tracks" in tables, "tracks Tabelle muss existieren (Basis)"
    assert "stems" in tables, "stems Tabelle muss existieren (Feature Branch)"
    assert "cloud_jobs" in tables, "cloud_jobs Tabelle muss existieren (Feature Branch)"

def test_player_basic():
    from audio_editor.player import AudioPlayer, PlayerState
    from pathlib import Path
    import tempfile
    
    # Erstelle Dummy Datei
    tmp = Path(tempfile.mktemp(suffix=".mp3"))
    tmp.write_text("dummy")
    
    player = AudioPlayer(deck_id="A")
    
    assert player.state == PlayerState.STOPPED
    assert not player.is_track_loaded()
    
    # Load
    player.load(tmp, track_id="test123", duration=180.0)
    assert player.is_track_loaded()
    assert player.current_track_id == "test123"
    assert player.duration == 180.0
    
    # Play/Pause/Stop
    assert player.play() == True
    assert player.state == PlayerState.PLAYING
    
    assert player.pause() == True
    assert player.state == PlayerState.PAUSED
    
    assert player.stop() == True
    assert player.state == PlayerState.STOPPED
    assert player.position == 0.0
    
    tmp.unlink()

def test_config_app_dirs():
    from audio_editor.config import get_app_dirs, get_drive_folders
    
    dirs = get_app_dirs()
    assert "base" in dirs
    assert "data" in dirs
    assert "db" in dirs
    assert "stems" in dirs
    assert "temp" in dirs
    assert "mock_drive" in dirs
    
    # Alle Pfade sollten Path Objekte sein
    for k, v in dirs.items():
        assert isinstance(v, Path), f"{k} sollte Path sein"
    
    folders = get_drive_folders()
    assert "base" in folders
    assert "input" in folders
    assert "output" in folders
    assert "AudioEditor_Stems" in folders["base"]

def test_existing_editor_still_works_as_basis():
    """
    Integrationstest: Bestehender Editor ist Basis für neuen Workflow
    - Tracks können geladen werden
    - DB funktioniert
    - Player funktioniert
    - Neue Features erweitern, nicht ersetzen
    """
    from audio_editor.database import AudioDatabase
    from audio_editor.player import AudioPlayer
    from audio_editor.utils import generate_track_id
    from pathlib import Path
    import tempfile
    
    # Simuliere alten Workflow
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        db_path = tmp_dir / "test.db"
        db = AudioDatabase(db_path=db_path)
        
        # Track hinzufügen (alter Workflow)
        dummy_file = tmp_dir / "my_song.mp3"
        dummy_file.write_text("audio")
        track_id = generate_track_id(dummy_file)
        
        db.add_or_update_track(track_id, str(dummy_file), dummy_file.name, "My Song", 200.0)
        
        # Player laden (alter Workflow)
        player = AudioPlayer(deck_id="A")
        player.load(dummy_file, track_id, 200.0)
        assert player.is_track_loaded()
        
        # Neuer Workflow erweitert, bricht alten nicht
        # Prüfe dass neue Tabellen existieren aber alte Daten noch da
        track = db.get_track(track_id)
        assert track is not None
        assert track["id"] == track_id
        
        # Neue Features: Stems und Cloud Jobs
        import sqlite3
        with sqlite3.connect(db_path) as conn:
            cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stems', 'cloud_jobs')")
            new_tables = cur.fetchall()
            assert len(new_tables) == 2, "Neue Tabellen müssen existieren"
        
        print("✅ Bestehender Editor bleibt Basis, neue Features erweitern")
        
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
