# Changelog - AudioEditor

## [0.2.0] - 2026-09-18 - Feature: Cloud Stem Separation
### Branch: feature/colab-stem-separation

#### Added (Neuer Workflow, bestehender Editor bleibt Basis)
- Deck-Ansicht: Button "Externe Stems berechnen" strikt für aktuell geladenen Track
- Lokale Aufbereitung: temporäre Arbeitskopie in data/temp/
- Hintergrund Worker: QThread (StemSeparationWorker) - GUI friert nicht ein
- Cloud Upload: GoogleDriveClient + MockDriveClient Fallback
  - Ordner /AudioEditor_Stems/Input/ und /AudioEditor_Stems/Output/<Track_ID>/
  - Trigger-Datei _TRIGGER_<Track_ID>.json für Colab Watcher
- Colab Trigger: Drive Watcher (Haupt) + Webhook (COLAB_WEBHOOK_URL)
- GPU Config: check_gpu() mit torch.cuda.is_available() zwingend
- Modell: htdemucs aus demucs Bibliothek, offizielle Gewichte via demucs.pretrained.get_model
- Output: drums, bass, other, vocals + status.json + DONE
- Download & Verknüpfung: Polling 15s, Download nach data/stems/<Track_ID>/, DB Verknüpfung
- Pop-up: "Alles klar, die Stems sind nun verfügbar."
- Auth: Auto-Discovery aus Env, Dateien, config - nur fragen wenn keine vorhanden
- Mock Modus: USE_MOCK_DRIVE=1 für Entwicklung ohne Credentials
- Colab Notebook: audio_editor/colab/colab_notebook.ipynb + .py + COLAB_SETUP.md
- Windows Release: Portable ZIP + build_exe_windows.bat für echte .exe

#### Tests (68 Tests, alle bestanden)
- test_existing_editor.py (8 Tests) - Basis bleibt erhalten
  - test_utils_generate_track_id, create_temp_copy, format_time
  - test_database_tracks_crud, stems_tables_exist
  - test_player_basic, config_app_dirs
  - test_existing_editor_still_works_as_basis
- test_deck_integration.py (9 Tests) - Workflow Integration
  - test_deck_has_stem_button, still_has_original_features
  - test_deck_uses_background_worker, has_progress_and_status
  - test_deck_has_popup_message, main_still_has_two_decks
  - test_config_extends_not_replaces, database_extends_not_replaces
  - test_workflow_integration_end_to_end
- test_config.py (11 Tests) - Credentials & Config
- test_database.py (5 Tests) - Tracks, Stems, Cloud Jobs CRUD
- test_stem_manager.py (10 Tests) - Stem Verwaltung
- test_drive_client.py (9 Tests) - Mock Drive Upload/Download
- test_colab_trigger.py (7 Tests) - Trigger & Webhook
- test_worker.py (4 Tests) - Full Pipeline Mock
- test_cloud_workflow.py (4 Tests) - End-to-End Mock

#### CI/CD - Auto Version bei GitHub Push
- .github/workflows/ci.yml - Tests auf Python 3.10, 3.11, 3.12 + Lint + Build
- .github/workflows/release.yml - Auto Release bei Push
  - Version aus audio_editor/__init__.py + commit hash + timestamp
  - Tag: v0.2.0-feature-colab-stem-separation-<commit>-<timestamp>
  - Für main: v0.2.0-<commit>
  - Für Tags: nutzt Tag als Version
  - Erstellt GitHub Release mit ZIPs automatisch
  - Windows Build auf windows-latest Runner

#### Preserved (Bestehender Editor bleibt Basis)
- audio_editor/player.py - Unverändert, Basis Play/Pause/Stop
- audio_editor/utils.py - Unverändert, generate_track_id, create_temp_copy
- audio_editor/database.py - Erweitert, nicht ersetzt (tracks bleibt, stems + cloud_jobs neu)
- audio_editor/config.py - Erweitert, nicht ersetzt (Basis Pfade bleiben)
- audio_editor/deck.py - Erweitert, nicht ersetzt (Track laden, Play, Stop bleiben + neuer Button)
- audio_editor/main.py - Erweitert, nicht ersetzt (2 Decks bleiben + Cloud Menü)

## [0.1.0] - 2026-09-18 - Initial
### Branch: main
- Basis Audio Editor mit Deck Ansicht (A/B)
- Track laden, Play/Pause/Stop
- Wellenform Anzeige Placeholder
- SQLite Datenbank für Tracks
- PySide6 GUI Dark Theme
