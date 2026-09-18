"""
Tests für drive_client.py - MockDriveClient und Factory
"""
import sys
from pathlib import Path
import json
import os

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_mock_drive_ensure_folder_structure(mock_drive_client):
    folders = mock_drive_client.ensure_folder_structure()
    
    assert "input" in folders
    assert "output" in folders
    assert Path(folders["input"]).exists()
    assert Path(folders["output"]).exists()

def test_mock_drive_upload_track(mock_drive_client, dummy_audio_file, dummy_track_id):
    result = mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    assert "file_id" in result
    assert "file_name" in result
    assert "path" in result
    assert "trigger_path" in result
    assert "metadata" in result
    
    # Dateien sollten existieren
    assert Path(result["path"]).exists()
    assert Path(result["trigger_path"]).exists()
    
    # File Name sollte Track ID enthalten
    assert dummy_track_id in result["file_name"]
    
    # Metadata
    assert result["metadata"]["track_id"] == dummy_track_id
    assert result["metadata"]["original_name"] == dummy_audio_file.name
    
    # Trigger Datei Inhalt
    with open(result["trigger_path"]) as f:
        trigger = json.load(f)
    assert trigger["track_id"] == dummy_track_id
    assert trigger["status"] == "pending"

def test_mock_drive_check_output_not_ready(mock_drive_client, dummy_track_id):
    is_ready, stems = mock_drive_client.check_output_ready(dummy_track_id)
    
    assert is_ready == False
    assert stems == []

def test_mock_drive_simulate_and_check_ready(mock_drive_client, dummy_audio_file, dummy_track_id):
    # Upload
    mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    # Simuliere Colab
    success = mock_drive_client.simulate_colab_processing(dummy_track_id)
    assert success == True
    
    # Jetzt sollte ready sein
    is_ready, stems = mock_drive_client.check_output_ready(dummy_track_id)
    
    assert is_ready == True
    assert len(stems) >= 4
    
    stem_types = [s["stem_type"] for s in stems]
    assert "drums" in stem_types
    assert "bass" in stem_types
    assert "other" in stem_types
    assert "vocals" in stem_types
    
    # Prüfe status.json und DONE
    from audio_editor.config import get_drive_folders
    # MockDriveClient nutzt MOCK_DRIVE_DIR
    output_dir = mock_drive_client._get_output_dir(dummy_track_id)
    assert (output_dir / "status.json").exists()
    assert (output_dir / "DONE").exists()
    
    with open(output_dir / "status.json") as f:
        status = json.load(f)
    assert status["status"] == "completed"
    assert status["track_id"] == dummy_track_id

def test_mock_drive_download_stems(mock_drive_client, dummy_audio_file, dummy_track_id, temp_dir):
    # Upload + Simulate
    mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    mock_drive_client.simulate_colab_processing(dummy_track_id)
    
    # Download
    download_dir = temp_dir / "downloads"
    downloaded = mock_drive_client.download_stems(dummy_track_id, download_dir)
    
    assert len(downloaded) >= 4
    assert all(p.exists() for p in downloaded)
    assert all(p.parent == download_dir for p in downloaded)

def test_mock_drive_list_input_files(mock_drive_client, dummy_audio_file, dummy_track_id):
    # Anfangs leer (außer Trigger und Metadata werden gefiltert)
    initial_files = mock_drive_client.list_input_files()
    # Können Dateien vorhanden sein von vorherigen Tests, aber wir prüfen nach Upload
    
    mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    files = mock_drive_client.list_input_files()
    # Sollte mindestens unsere Datei enthalten (Trigger und Metadata werden gefiltert)
    assert len(files) >= 1
    assert any(dummy_track_id in f["name"] for f in files)

def test_get_drive_client_factory_mock(monkeypatch):
    from audio_editor.cloud.drive_client import get_drive_client, MockDriveClient
    
    monkeypatch.setenv("USE_MOCK_DRIVE", "1")
    
    client = get_drive_client()
    assert isinstance(client, MockDriveClient)
    
    monkeypatch.delenv("USE_MOCK_DRIVE", raising=False)

def test_get_drive_client_factory_no_credentials(monkeypatch, tmp_path):
    from audio_editor.cloud.drive_client import get_drive_client, MockDriveClient
    from audio_editor import config
    
    # Keine Credentials, sollte auf Mock zurückfallen
    monkeypatch.setattr(config, "CREDENTIALS_SEARCH_PATHS", [tmp_path / "nonexistent.json"])
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.delenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("GOOGLE_DRIVE_CREDENTIALS", raising=False)
    monkeypatch.delenv("USE_MOCK_DRIVE", raising=False)
    
    # Mock in config deaktivieren, aber trotzdem sollte Fallback zu Mock kommen
    # weil keine echten Credentials und google libs evtl nicht installiert
    client = get_drive_client()
    # Sollte Mock sein als Fallback
    assert isinstance(client, MockDriveClient)

def test_drive_client_base_interface():
    from audio_editor.cloud.drive_client import DriveClientBase
    
    base = DriveClientBase()
    
    # Alle Methoden sollten NotImplementedError werfen
    import pytest
    with pytest.raises(NotImplementedError):
        base.ensure_folder_structure()
    with pytest.raises(NotImplementedError):
        base.upload_track(Path("/tmp/test.mp3"), "track123")
    with pytest.raises(NotImplementedError):
        base.check_output_ready("track123")
    with pytest.raises(NotImplementedError):
        base.download_stems("track123", Path("/tmp"))
    with pytest.raises(NotImplementedError):
        base.list_input_files()
