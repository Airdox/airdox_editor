"""
Tests für Cloud Workflow - Mock Modus
Feature Branch: feature/colab-stem-separation
"""
import sys
from pathlib import Path
import tempfile
import shutil
import json

# Füge Projekt Root zu Path hinzu
BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

from audio_editor.cloud.drive_client import MockDriveClient
from audio_editor.stem_manager import StemManager
from audio_editor.database import AudioDatabase
from audio_editor.config import get_app_dirs

def test_mock_drive_upload_download():
    print("=== Test Mock Drive Upload/Download ===")
    
    # Setup
    mock_client = MockDriveClient()
    mock_client.ensure_folder_structure()
    
    # Erstelle Dummy Audio
    temp_dir = Path(tempfile.mkdtemp())
    dummy_audio = temp_dir / "test_song.mp3"
    dummy_audio.write_text("dummy audio data for testing stem separation workflow")
    
    track_id = "test_track_123"
    
    # Upload
    print(f"Upload: {dummy_audio} mit ID {track_id}")
    result = mock_client.upload_track(dummy_audio, track_id)
    print(f"Upload Result: {result}")
    
    assert Path(result["path"]).exists(), "Upload Datei sollte existieren"
    assert Path(result["trigger_path"]).exists(), "Trigger Datei sollte existieren"
    
    # Simuliere Colab Verarbeitung
    print("Simuliere Colab Verarbeitung...")
    success = mock_client.simulate_colab_processing(track_id)
    assert success, "Simulation sollte erfolgreich sein"
    
    # Check Output Ready
    is_ready, stems_info = mock_client.check_output_ready(track_id)
    print(f"Ready: {is_ready}, Stems: {stems_info}")
    assert is_ready, "Output sollte bereit sein nach Simulation"
    assert len(stems_info) >= 4, "Sollte 4 Stems haben"
    
    # Download
    download_dir = temp_dir / "downloaded"
    downloaded = mock_client.download_stems(track_id, download_dir)
    print(f"Downloaded: {downloaded}")
    assert len(downloaded) >= 4, "Sollte 4 Dateien heruntergeladen haben"
    
    # Cleanup
    shutil.rmtree(temp_dir)
    print("✅ Mock Drive Upload/Download Test bestanden")

def test_stem_manager():
    print("\n=== Test Stem Manager ===")
    
    # Nutze temporäre DB
    temp_dir = Path(tempfile.mkdtemp())
    db_path = temp_dir / "test.db"
    stems_dir = temp_dir / "stems"
    
    db = AudioDatabase(db_path=db_path)
    manager = StemManager(stems_base_dir=stems_dir, database=db)
    
    track_id = "test_track_456"
    
    # Erstelle Dummy Stems
    dummy_stems = []
    for stem_type in ["drums", "bass", "other", "vocals"]:
        stem_file = temp_dir / f"{stem_type}.wav"
        stem_file.write_text(f"dummy {stem_type} data")
        dummy_stems.append(stem_file)
    
    # Verknüpfe
    linked = manager.link_downloaded_stems(track_id, dummy_stems)
    print(f"Linked: {linked}")
    assert len(linked) == 4, "Sollte 4 Stems verknüpft haben"
    
    # Prüfe DB
    stems_from_db = db.get_stems_for_track(track_id)
    print(f"DB Stems: {stems_from_db}")
    assert len(stems_from_db) == 4, "DB sollte 4 Stems haben"
    
    # Prüfe has_stems
    assert db.has_stems(track_id), "has_stems sollte True sein"
    
    # Cleanup
    shutil.rmtree(temp_dir)
    print("✅ Stem Manager Test bestanden")

def test_config_credentials():
    print("\n=== Test Config Credentials ===")
    from audio_editor.config import has_valid_credentials, find_credentials_file, load_config
    import os
    
    # Teste Mock Modus
    os.environ["USE_MOCK_DRIVE"] = "1"
    
    has_creds = has_valid_credentials()
    print(f"has_valid_credentials (mit Mock): {has_creds}")
    assert has_creds, "Mit Mock sollte Credentials vorhanden sein"
    
    config = load_config()
    print(f"Config: {config['cloud']}")
    
    # Cleanup
    del os.environ["USE_MOCK_DRIVE"]
    print("✅ Config Credentials Test bestanden")

def test_demucs_processor_import():
    print("\n=== Test Demucs Processor Import ===")
    try:
        from audio_editor.colab.demucs_processor import check_gpu, STANDARD_STEMS
        print(f"Standard Stems: {STANDARD_STEMS}")
        gpu_info = check_gpu()
        print(f"GPU Info: {gpu_info}")
        print("✅ Demucs Processor Import Test bestanden (Modell nicht geladen, nur Import)")
    except ImportError as e:
        print(f"⚠️ Demucs nicht installiert (erwartet außerhalb Colab): {e}")
        print("✅ Test trotzdem bestanden (Import Fehler ist ok lokal)")

if __name__ == "__main__":
    test_config_credentials()
    test_mock_drive_upload_download()
    test_stem_manager()
    test_demucs_processor_import()
    print("\n=== Alle Tests bestanden ===")
