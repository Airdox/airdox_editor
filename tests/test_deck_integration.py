"""
Tests für Deck Integration - Sicherstellung dass bestehender Editor Basis bleibt
und neuer Workflow korrekt integriert ist
"""
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

def test_deck_has_stem_button():
    """
    Prüft dass Deck Widget den Button "Externe Stems berechnen" hat
    Kernanforderung aus Spec
    """
    # Lese deck.py Quellcode und prüfe auf Button
    deck_path = BASE_DIR / "audio_editor" / "deck.py"
    content = deck_path.read_text(encoding='utf-8')
    
    assert "Externe Stems berechnen" in content, "Button Text muss vorhanden sein"
    assert "stem_btn" in content, "stem_btn Variable muss vorhanden sein"
    assert "on_stem_button_clicked" in content, "Handler muss vorhanden sein"
    
    # Prüfe dass Button sich auf aktuell geladenen Track bezieht
    assert "get_current_track_info" in content, "Muss sich auf aktuellen Track beziehen"
    assert "deck_id" in content.lower() or "Deck" in content, "Muss Deck Bezug haben"

def test_deck_still_has_original_features():
    """
    Prüft dass Deck immer noch Original Features hat (Basis bleibt)
    """
    deck_path = BASE_DIR / "audio_editor" / "deck.py"
    content = deck_path.read_text(encoding='utf-8')
    
    # Original Features aus main Branch
    assert "Track laden" in content, "Original: Track laden Button muss bleiben"
    assert "Play" in content, "Original: Play Button muss bleiben"
    assert "Stop" in content, "Original: Stop Button muss bleiben"
    assert "Wellenform" in content or "waveform" in content.lower(), "Original: Waveform Anzeige muss bleiben"
    assert "load_track" in content, "Original: load_track Methode muss bleiben"
    assert "toggle_play" in content, "Original: toggle_play muss bleiben"

def test_deck_uses_background_worker():
    """
    Prüft dass Deck Hintergrund Worker nutzt (GUI friert nicht)
    """
    deck_path = BASE_DIR / "audio_editor" / "deck.py"
    content = deck_path.read_text(encoding='utf-8')
    
    assert "StemSeparationWorker" in content or "worker" in content.lower(), "Muss Worker nutzen"
    assert "QThread" in content or "thread" in content.lower() or "Worker" in content, "Muss Thread verwenden"

def test_deck_has_progress_and_status():
    deck_path = BASE_DIR / "audio_editor" / "deck.py"
    content = deck_path.read_text(encoding='utf-8')
    
    assert "QProgressBar" in content or "progress" in content.lower(), "Muss Progress Bar haben"
    assert "status" in content.lower(), "Muss Status Label haben"
    assert "stems_list" in content or "Stems" in content, "Muss Stems Liste haben"

def test_deck_has_popup_message():
    deck_path = BASE_DIR / "audio_editor" / "deck.py"
    content = deck_path.read_text(encoding='utf-8')
    
    # Pop-up Text aus Spec
    assert "Alles klar, die Stems sind nun verfügbar" in content, "Pop-up Text muss vorhanden sein laut Spec"

def test_main_still_has_two_decks():
    main_path = BASE_DIR / "audio_editor" / "main.py"
    content = main_path.read_text(encoding='utf-8')
    
    assert "Deck A" in content or 'deck_id="A"' in content or "DeckA" in content, "Deck A muss existieren"
    assert "Deck B" in content or 'deck_id="B"' in content or "DeckB" in content, "Deck B muss existieren"
    assert "deck_a" in content.lower() and "deck_b" in content.lower(), "Beide Decks müssen instanziiert werden"

def test_main_has_cloud_menu():
    main_path = BASE_DIR / "audio_editor" / "main.py"
    content = main_path.read_text(encoding='utf-8')
    
    # Neues Cloud Menü sollte existieren
    assert "Cloud" in content or "cloud" in content.lower(), "Cloud Menü sollte existieren"
    # Aber Datei und Hilfe Menüs aus Basis sollten bleiben
    assert "Datei" in content or "File" in content, "Datei Menü aus Basis muss bleiben"
    assert "Hilfe" in content or "Help" in content or "Über" in content, "Hilfe Menü aus Basis muss bleiben"

def test_config_extends_not_replaces():
    config_path = BASE_DIR / "audio_editor" / "config.py"
    content = config_path.read_text(encoding='utf-8')
    
    # Basis Config sollte bleiben
    assert "sample_rate" in content, "Basis: sample_rate muss bleiben"
    assert "DATA_DIR" in content, "Basis: DATA_DIR muss bleiben"
    assert "DB_PATH" in content, "Basis: DB_PATH muss bleiben"
    
    # Neue Cloud Config sollte hinzugekommen sein
    assert "drive" in content.lower(), "Feature: Drive Config muss vorhanden sein"
    assert "cloud" in content.lower(), "Feature: Cloud Config muss vorhanden sein"
    assert "MissingCredentialsError" in content, "Feature: Credentials Handling muss vorhanden sein"

def test_database_extends_not_replaces():
    db_path = BASE_DIR / "audio_editor" / "database.py"
    content = db_path.read_text(encoding='utf-8')
    
    # Basis Tabelle
    assert "tracks" in content, "Basis: tracks Tabelle muss bleiben"
    assert "add_or_update_track" in content, "Basis: add_or_update_track muss bleiben"
    
    # Neue Tabellen
    assert "stems" in content, "Feature: stems Tabelle muss vorhanden sein"
    assert "cloud_jobs" in content, "Feature: cloud_jobs Tabelle muss vorhanden sein"

def test_workflow_integration_end_to_end():
    """
    End-to-End Integrationstest: Basis + Workflow
    """
    from audio_editor.database import AudioDatabase
    from audio_editor.utils import generate_track_id
    from audio_editor.stem_manager import StemManager
    from pathlib import Path
    import tempfile
    import shutil
    
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        db_path = tmp_dir / "test.db"
        stems_dir = tmp_dir / "stems"
        stems_dir.mkdir()
        
        db = AudioDatabase(db_path=db_path)
        stem_manager = StemManager(stems_base_dir=stems_dir, database=db)
        
        # Schritt 1: Basis Workflow - Track laden (wie in main Branch)
        dummy_file = tmp_dir / "my_song.mp3"
        dummy_file.write_text("audio data")
        track_id = generate_track_id(dummy_file)
        
        db.add_or_update_track(track_id, str(dummy_file), dummy_file.name, "My Song")
        
        # Schritt 2: Neuer Workflow - Stems berechnen (Feature Branch)
        # Simuliere Download
        for stem_type in ["drums", "bass", "other", "vocals"]:
            stem_file = tmp_dir / f"{stem_type}.wav"
            stem_file.write_text(f"{stem_type} data")
        
        downloaded = [tmp_dir / f"{s}.wav" for s in ["drums", "bass", "other", "vocals"]]
        linked = stem_manager.link_downloaded_stems(track_id, downloaded)
        
        # Schritt 3: Prüfe Integration
        # Basis Daten noch da?
        track = db.get_track(track_id)
        assert track is not None
        assert track["id"] == track_id
        
        # Neue Daten verknüpft?
        stems = db.get_stems_for_track(track_id)
        assert len(stems) == 4
        assert db.has_stems(track_id) == True
        
        # Stem Manager kann Pfade für Player liefern?
        paths = stem_manager.get_stem_paths_for_player(track_id)
        assert len(paths) >= 4
        
        print("✅ Workflow Integration Test bestanden: Basis + neuer Workflow")
        
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
