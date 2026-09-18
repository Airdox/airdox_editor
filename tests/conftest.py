"""
Pytest Konfiguration und gemeinsame Fixtures
Feature Branch: feature/colab-stem-separation
Sichert ab dass bestehender Editor Basis bleibt
"""
import os
import sys
import tempfile
import shutil
from pathlib import Path
import pytest

# Projekt Root
BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

# Mock Modus für alle Tests standardmäßig aktiv
os.environ["USE_MOCK_DRIVE"] = "1"

@pytest.fixture
def temp_dir():
    """Temporäres Verzeichnis das nach Test gelöscht wird"""
    d = Path(tempfile.mkdtemp())
    yield d
    shutil.rmtree(d, ignore_errors=True)

@pytest.fixture
def temp_db(temp_dir):
    """Temporäre Datenbank für Tests"""
    from audio_editor.database import AudioDatabase
    db_path = temp_dir / "test.db"
    db = AudioDatabase(db_path=db_path)
    return db

@pytest.fixture
def temp_stems_dir(temp_dir):
    """Temporäres Stems Verzeichnis"""
    stems_dir = temp_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    return stems_dir

@pytest.fixture
def stem_manager(temp_db, temp_stems_dir):
    """StemManager mit temporärer DB und Verzeichnis"""
    from audio_editor.stem_manager import StemManager
    return StemManager(stems_base_dir=temp_stems_dir, database=temp_db)

@pytest.fixture
def mock_drive_client(temp_dir):
    """MockDriveClient mit temporärem Root"""
    from audio_editor.cloud.drive_client import MockDriveClient
    mock_root = temp_dir / "mock_drive"
    client = MockDriveClient(mock_root=mock_root)
    client.ensure_folder_structure()
    return client

@pytest.fixture
def dummy_audio_file(temp_dir):
    """Dummy Audio Datei für Tests"""
    audio_file = temp_dir / "test_song.mp3"
    audio_file.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00dummy audio content for testing " * 100)
    return audio_file

@pytest.fixture
def dummy_track_id():
    return "test_track_12345"

@pytest.fixture
def app_dirs_temp(temp_dir, monkeypatch):
    """App Dirs die auf temp zeigen"""
    # Monkeypatch get_app_dirs um temp zu nutzen
    from audio_editor import config
    original_data_dir = config.DATA_DIR
    
    # Erstelle temp data Struktur
    data_dir = temp_dir / "data"
    data_dir.mkdir()
    (data_dir / "stems").mkdir()
    (data_dir / "temp").mkdir()
    (data_dir / "mock_drive").mkdir()
    
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "DB_PATH", data_dir / "test.db")
    monkeypatch.setattr(config, "STEMS_DIR", data_dir / "stems")
    monkeypatch.setattr(config, "TEMP_DIR", data_dir / "temp")
    monkeypatch.setattr(config, "MOCK_DRIVE_DIR", data_dir / "mock_drive")
    
    return {
        "base": BASE_DIR,
        "data": data_dir,
        "db": data_dir / "test.db",
        "stems": data_dir / "stems",
        "temp": data_dir / "temp",
        "mock_drive": data_dir / "mock_drive"
    }
