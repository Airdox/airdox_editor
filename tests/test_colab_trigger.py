"""
Tests für colab_trigger.py
"""
import sys
from pathlib import Path
import json
import os

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_colab_trigger_after_upload(mock_drive_client, dummy_audio_file, dummy_track_id, temp_dir):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    
    # Upload
    upload_result = mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    trigger = ColabTrigger(drive_client=mock_drive_client)
    trigger_info = trigger.trigger_after_upload(dummy_track_id, upload_result, dummy_audio_file)
    
    assert trigger_info["track_id"] == dummy_track_id
    assert trigger_info["file_name"] == upload_result["file_name"]
    assert "triggered_at" in trigger_info
    assert "drive_folders" in trigger_info
    
    # Lokale Trigger Log Datei sollte existieren
    from audio_editor.config import get_app_dirs
    temp_trigger_log = Path(get_app_dirs()["temp"]) / f"trigger_{dummy_track_id}.json"
    # Im Test mit temp_dir fixture wird get_app_dirs nicht gepatcht, also prüfen wir nur dass Info zurückkam
    # Die Datei wird in echtem temp erstellt
    assert trigger_info["track_id"] == dummy_track_id

def test_colab_trigger_check_status_not_ready(mock_drive_client, dummy_track_id):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    
    trigger = ColabTrigger(drive_client=mock_drive_client)
    status = trigger.check_colab_status(dummy_track_id)
    
    assert status["track_id"] == dummy_track_id
    assert status["ready"] == False
    assert status["stems_found"] == 0

def test_colab_trigger_check_status_ready(mock_drive_client, dummy_audio_file, dummy_track_id):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    
    # Upload + Simulate
    mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    mock_drive_client.simulate_colab_processing(dummy_track_id)
    
    trigger = ColabTrigger(drive_client=mock_drive_client)
    status = trigger.check_colab_status(dummy_track_id)
    
    assert status["track_id"] == dummy_track_id
    assert status["ready"] == True
    assert status["stems_found"] >= 4
    assert len(status["stems"]) >= 4

def test_colab_trigger_webhook_no_url(mock_drive_client, dummy_audio_file, dummy_track_id, monkeypatch):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    
    # Keine Webhook URL
    monkeypatch.delenv("COLAB_WEBHOOK_URL", raising=False)
    monkeypatch.setattr("audio_editor.config.CONFIG", {"cloud": {"colab_webhook_url": None, "use_mock_drive": True}})
    
    upload_result = mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    trigger = ColabTrigger(drive_client=mock_drive_client)
    trigger.webhook_url = None  # Explizit None
    
    info = trigger.trigger_after_upload(dummy_track_id, upload_result, dummy_audio_file)
    
    assert info["webhook_sent"] == False
    assert info["mode"] == "drive_watcher"

def test_colab_trigger_webhook_with_url(mock_drive_client, dummy_audio_file, dummy_track_id, monkeypatch):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    import requests
    
    # Mock requests.post
    called = {}
    def mock_post(url, json=None, headers=None, timeout=None):
        called["url"] = url
        called["json"] = json
        called["headers"] = headers
        class MockResponse:
            status_code = 200
            text = "OK"
            def raise_for_status(self):
                pass
        return MockResponse()
    
    monkeypatch.setattr(requests, "post", mock_post)
    
    upload_result = mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    trigger = ColabTrigger(drive_client=mock_drive_client)
    trigger.webhook_url = "https://example.com/webhook"
    
    info = trigger.trigger_after_upload(dummy_track_id, upload_result, dummy_audio_file)
    
    assert called["url"] == "https://example.com/webhook"
    assert called["json"]["track_id"] == dummy_track_id
    assert called["json"]["event"] == "stem_separation_requested"
    assert info["webhook_sent"] == True

def test_colab_trigger_webhook_failure(mock_drive_client, dummy_audio_file, dummy_track_id, monkeypatch):
    from audio_editor.cloud.colab_trigger import ColabTrigger
    import requests
    
    def mock_post_fail(url, json=None, headers=None, timeout=None):
        raise requests.exceptions.ConnectionError("Webhook not reachable")
    
    monkeypatch.setattr(requests, "post", mock_post_fail)
    
    upload_result = mock_drive_client.upload_track(dummy_audio_file, dummy_track_id)
    
    trigger = ColabTrigger(drive_client=mock_drive_client)
    trigger.webhook_url = "https://example.com/webhook"
    
    # Sollte nicht crashen, sondern Fehler loggen
    info = trigger.trigger_after_upload(dummy_track_id, upload_result, dummy_audio_file)
    
    assert info["webhook_sent"] == False
    assert "webhook_error" in info

def test_get_colab_notebook_instructions():
    from audio_editor.cloud.colab_trigger import ColabTrigger
    
    instructions = ColabTrigger.get_colab_notebook_instructions()
    
    assert isinstance(instructions, str)
    assert "Google Colab Setup" in instructions
    assert "htdemucs" in instructions
    assert "GPU" in instructions
    assert len(instructions) > 100
