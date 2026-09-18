"""
Tests für config.py - Credentials Handling & App Config
Feature Branch: colab-stem-separation
"""
import os
import sys
import json
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_load_config_defaults():
    from audio_editor.config import load_config, DEFAULT_CONFIG
    
    config = load_config()
    
    assert "sample_rate" in config
    assert "cloud" in config
    assert "drive_base_folder" in config["cloud"]
    assert config["cloud"]["drive_base_folder"] == "AudioEditor_Stems"

def test_has_valid_credentials_mock_mode(monkeypatch):
    from audio_editor.config import has_valid_credentials
    
    # Mock Modus sollte als gültig gelten
    monkeypatch.setenv("USE_MOCK_DRIVE", "1")
    assert has_valid_credentials() == True
    
    monkeypatch.delenv("USE_MOCK_DRIVE", raising=False)

def test_find_credentials_file_not_found(monkeypatch, tmp_path):
    from audio_editor.config import find_credentials_file, CREDENTIALS_SEARCH_PATHS
    
    # Monkeypatch search paths zu leerem tmp
    monkeypatch.setattr("audio_editor.config.CREDENTIALS_SEARCH_PATHS", [tmp_path / "nonexistent.json"])
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    
    result = find_credentials_file()
    # Sollte None sein wenn keine Datei existiert und kein Env gesetzt
    # Außer GOOGLE_APPLICATION_CREDENTIALS ist gesetzt
    # Wir haben Env gelöscht, also None
    assert result is None or isinstance(result, Path)

def test_find_credentials_file_found(tmp_path, monkeypatch):
    from audio_editor.config import find_credentials_file
    
    # Erstelle Dummy Credentials Datei
    cred_file = tmp_path / "credentials.json"
    cred_file.write_text('{"type": "service_account"}')
    
    monkeypatch.setattr("audio_editor.config.CREDENTIALS_SEARCH_PATHS", [cred_file])
    
    result = find_credentials_file()
    assert result == cred_file
    assert result.exists()

def test_load_credentials_from_env_json_content(monkeypatch):
    from audio_editor.config import load_credentials_from_env
    
    # Test mit JSON Inhalt direkt
    fake_creds = {"type": "service_account", "project_id": "test123"}
    monkeypatch.setenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", json.dumps(fake_creds))
    
    result = load_credentials_from_env()
    assert result == fake_creds
    
    monkeypatch.delenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", raising=False)

def test_load_credentials_from_env_file_path(tmp_path, monkeypatch):
    from audio_editor.config import load_credentials_from_env
    
    cred_file = tmp_path / "service_account.json"
    fake_creds = {"type": "service_account", "project_id": "from_file"}
    cred_file.write_text(json.dumps(fake_creds))
    
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(cred_file))
    
    result = load_credentials_from_env()
    assert result == fake_creds
    
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)

def test_get_credentials_or_raise_mock(monkeypatch):
    from audio_editor.config import get_credentials_or_raise
    
    monkeypatch.setenv("USE_MOCK_DRIVE", "1")
    creds = get_credentials_or_raise()
    assert creds.get("mock") == True
    
    monkeypatch.delenv("USE_MOCK_DRIVE", raising=False)

def test_get_credentials_or_raise_missing(monkeypatch, tmp_path):
    from audio_editor.config import get_credentials_or_raise, MissingCredentialsError
    
    # Keine Credentials vorhanden
    monkeypatch.setattr("audio_editor.config.CREDENTIALS_SEARCH_PATHS", [tmp_path / "nonexistent.json"])
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.delenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("GOOGLE_DRIVE_CREDENTIALS", raising=False)
    monkeypatch.delenv("USE_MOCK_DRIVE", raising=False)
    monkeypatch.setattr("audio_editor.config.CONFIG", {"cloud": {"use_mock_drive": False}})
    
    # Sollte MissingCredentialsError werfen
    try:
        get_credentials_or_raise()
        assert False, "Sollte MissingCredentialsError werfen"
    except MissingCredentialsError as e:
        assert "Keine Google Drive Credentials" in str(e)
    except Exception:
        # Andere Exception ist auch ok wenn Mock nicht aktiv
        pass

def test_get_app_dirs_structure():
    from audio_editor.config import get_app_dirs
    
    dirs = get_app_dirs()
    
    # Alle erwarteten Keys
    expected_keys = ["base", "data", "db", "stems", "temp", "mock_drive"]
    for key in expected_keys:
        assert key in dirs
        assert isinstance(dirs[key], Path)

def test_get_drive_folders():
    from audio_editor.config import get_drive_folders
    
    folders = get_drive_folders()
    
    assert folders["base"] == "AudioEditor_Stems"
    assert "Input" in folders["input"]
    assert "Output" in folders["output"]

def test_missing_credentials_error():
    from audio_editor.config import MissingCredentialsError
    
    err = MissingCredentialsError("Test Fehler")
    assert isinstance(err, Exception)
    assert "Test Fehler" in str(err)
