"""
Background Worker für Stem Separation
Feature Branch: feature/colab-stem-separation

- Erstellt temporäre Arbeitskopie
- Läuft in separatem Thread damit GUI nicht einfriert
- Upload -> Trigger -> Polling -> Download -> Verknüpfung
"""

import time
import shutil
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional

# Versuche PySide6 für QThread, fallback zu threading
try:
    from PySide6.QtCore import QThread, Signal
    USE_QTHREAD = True
except ImportError:
    USE_QTHREAD = False
    import threading
    # Dummy Signal für Fallback
    class Signal:
        def __init__(self, *args): pass
        def emit(self, *args): pass
        def connect(self, *args): pass

from ..config import get_app_dirs, load_config, POLL_INTERVAL_SECONDS, POLL_TIMEOUT_SECONDS
from ..utils import create_temp_copy, generate_track_id
from ..database import AudioDatabase
from ..stem_manager import StemManager
from .drive_client import get_drive_client, DriveClientBase
from .colab_trigger import ColabTrigger


if USE_QTHREAD:
    class StemSeparationWorker(QThread):
        """
        QThread-basierter Worker für GUI Integration
        Signale für Fortschritt und Status
        """
        progress = Signal(int)  # 0-100
        status_message = Signal(str)
        finished_success = Signal(str, list)  # track_id, list of stem paths
        error_occurred = Signal(str, str)  # track_id, error message
        log_message = Signal(str)

        def __init__(self, track_path: Path, track_id: str, deck_id: str = "A", parent=None):
            super().__init__(parent)
            self.track_path = Path(track_path)
            self.track_id = track_id
            self.deck_id = deck_id
            self.job_id = str(uuid.uuid4())[:8]
            
            self.app_dirs = get_app_dirs()
            self.config = load_config()
            self.db = AudioDatabase()
            self.stem_manager = StemManager(database=self.db)
            
            self.drive_client: DriveClientBase = get_drive_client()
            self.colab_trigger = ColabTrigger(drive_client=self.drive_client)
            
            self._is_cancelled = False
            self.temp_copy_path: Optional[Path] = None

        def cancel(self):
            self._is_cancelled = True
            self.status_message.emit("Abgebrochen...")
            self.log_message.emit("[Worker] Abbruch angefordert")

        def _log(self, msg: str):
            print(msg)
            self.log_message.emit(msg)

        def _emit_progress(self, percent: int, message: str):
            self.progress.emit(percent)
            self.status_message.emit(message)
            self._log(f"[Worker {self.job_id}] {percent}% - {message}")

        def run(self):
            try:
                self._run_pipeline()
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                self._log(f"[Worker] Fehler: {e}\n{tb}")
                self.db.update_cloud_job(self.job_id, status="failed", error_message=str(e))
                self.error_occurred.emit(self.track_id, str(e))
                self._cleanup_temp()

        def _run_pipeline(self):
            self._log(f"[Worker] Starte Pipeline für Track {self.track_id} (Deck {self.deck_id})")
            self.db.create_cloud_job(self.job_id, self.track_id, status="preparing")
            
            # Schritt 1: Validierung
            if not self.track_path.exists():
                raise FileNotFoundError(f"Quelldatei nicht gefunden: {self.track_path}")
            
            self._emit_progress(5, f"Track validiert: {self.track_path.name}")

            # Schritt 2: Temporäre Arbeitskopie
            self._emit_progress(10, "Erstelle temporäre Arbeitskopie...")
            try:
                self.temp_copy_path = create_temp_copy(self.track_path, self.app_dirs["temp"])
                self._log(f"[Worker] Temp Kopie: {self.temp_copy_path}")
            except Exception as e:
                raise RuntimeError(f"Fehler bei temporärer Kopie: {e}")

            if self._is_cancelled:
                self._cleanup_temp()
                return

            # Schritt 3: Ordnerstruktur sicherstellen
            self._emit_progress(15, "Prüfe Cloud-Ordnerstruktur...")
            try:
                folders = self.drive_client.ensure_folder_structure()
                self._log(f"[Worker] Drive Ordner: {folders}")
            except Exception as e:
                raise RuntimeError(f"Fehler bei Drive Ordnerstruktur: {e}")

            # Schritt 4: Upload
            self._emit_progress(25, "Lade Track auf Google Drive hoch...")
            self.db.update_cloud_job(self.job_id, status="uploading")
            try:
                upload_result = self.drive_client.upload_track(self.temp_copy_path, self.track_id)
                self._log(f"[Worker] Upload Ergebnis: {upload_result}")
                self.db.update_cloud_job(
                    self.job_id, 
                    status="uploaded", 
                    drive_input_file_id=upload_result.get("file_id")
                )
            except Exception as e:
                raise RuntimeError(f"Upload fehlgeschlagen: {e}")

            if self._is_cancelled:
                self._cleanup_temp()
                return

            # Schritt 5: Colab Trigger
            self._emit_progress(40, "Triggere Colab Verarbeitung (htdemucs GPU)...")
            self.db.update_cloud_job(self.job_id, status="triggering")
            try:
                trigger_info = self.colab_trigger.trigger_after_upload(
                    self.track_id, upload_result, self.track_path
                )
                self._log(f"[Worker] Trigger Info: {trigger_info}")
                self.db.update_cloud_job(self.job_id, status="processing")
            except Exception as e:
                # Trigger Fehler ist nicht kritisch wenn Drive Watcher verwendet wird
                self._log(f"[Worker] Trigger Warnung (nicht kritisch): {e}")

            if self._is_cancelled:
                self._cleanup_temp()
                return

            # Schritt 6: Polling - Warte auf Ergebnisse
            self._emit_progress(50, "Warte auf Colab Ergebnisse (htdemucs GPU Verarbeitung)...")
            poll_interval = self.config.get("cloud", {}).get("poll_interval", POLL_INTERVAL_SECONDS)
            poll_timeout = self.config.get("cloud", {}).get("poll_timeout", POLL_TIMEOUT_SECONDS)
            
            start_time = time.time()
            last_check = 0
            
            while not self._is_cancelled:
                elapsed = time.time() - start_time
                if elapsed > poll_timeout:
                    raise TimeoutError(
                        f"Timeout nach {poll_timeout}s - Keine Ergebnisse von Colab. "
                        f"Bitte prüfe ob das Colab Notebook läuft und GPU aktiviert ist."
                    )
                
                # Nur alle poll_interval Sekunden prüfen
                if time.time() - last_check >= poll_interval:
                    last_check = time.time()
                    
                    try:
                        is_ready, stems_info = self.drive_client.check_output_ready(self.track_id)
                        self._log(f"[Worker] Polling: ready={is_ready}, stems={len(stems_info)}, elapsed={int(elapsed)}s")
                        
                        if is_ready:
                            self._emit_progress(80, f"Ergebnisse gefunden! {len(stems_info)} Stems bereit")
                            break
                        else:
                            # Fortschritt basierend auf Zeit schätzen (50-80%)
                            time_progress = min(30, int((elapsed / poll_timeout) * 30))
                            self._emit_progress(
                                50 + time_progress,
                                f"Verarbeite in Colab... ({int(elapsed)}s / {len(stems_info)} Stems erkannt)"
                            )
                    except Exception as e:
                        self._log(f"[Worker] Polling Fehler (retry): {e}")
                
                # Kurz schlafen damit Thread nicht busy-waited
                time.sleep(1)
            
            if self._is_cancelled:
                self._cleanup_temp()
                return

            # Schritt 7: Download
            self._emit_progress(85, "Lade separierte Stems herunter...")
            self.db.update_cloud_job(self.job_id, status="downloading")
            try:
                local_stem_dir = self.app_dirs["stems"] / self.track_id
                local_stem_dir.mkdir(parents=True, exist_ok=True)
                
                downloaded = self.drive_client.download_stems(self.track_id, local_stem_dir)
                self._log(f"[Worker] Downloaded: {downloaded}")
                
                if not downloaded:
                    raise RuntimeError("Keine Stems heruntergeladen - Output Ordner leer")
                
            except Exception as e:
                raise RuntimeError(f"Download fehlgeschlagen: {e}")

            if self._is_cancelled:
                self._cleanup_temp()
                return

            # Schritt 8: Verknüpfung in DB
            self._emit_progress(95, "Verknüpfe Stems mit Originaltrack...")
            self.db.update_cloud_job(self.job_id, status="linking")
            try:
                # Organisiere und verknüpfe
                linked = self.stem_manager.link_downloaded_stems(
                    self.track_id, downloaded
                )
                self._log(f"[Worker] Verknüpft: {linked}")
                
                if len(linked) < 4:
                    self._log(f"[Worker] Warnung: Nur {len(linked)} Stems verknüpft, erwartet 4")
                
            except Exception as e:
                raise RuntimeError(f"Verknüpfung fehlgeschlagen: {e}")

            # Schritt 9: Abschluss
            self._emit_progress(100, "Alles klar, die Stems sind nun verfügbar.")
            self.db.update_cloud_job(self.job_id, status="completed")
            self._log(f"[Worker] Pipeline abgeschlossen für {self.track_id}")
            
            # Cleanup temp
            self._cleanup_temp()
            
            # Signal für UI
            stem_paths = [Path(s["file_path"]) for s in self.db.get_stems_for_track(self.track_id)]
            self.finished_success.emit(self.track_id, stem_paths)

        def _cleanup_temp(self):
            """Löscht temporäre Arbeitskopie"""
            if self.temp_copy_path and self.temp_copy_path.exists():
                try:
                    self.temp_copy_path.unlink()
                    self._log(f"[Worker] Temp Datei gelöscht: {self.temp_copy_path}")
                except Exception as e:
                    self._log(f"[Worker] Fehler beim Löschen von Temp: {e}")
            self.temp_copy_path = None

else:
    # Fallback Implementierung ohne QThread (für Tests)
    class StemSeparationWorker:
        def __init__(self, track_path: Path, track_id: str, deck_id: str = "A", parent=None):
            self.track_path = Path(track_path)
            self.track_id = track_id
            self.deck_id = deck_id
            self.job_id = str(uuid.uuid4())[:8]
            self.app_dirs = get_app_dirs()
            self.config = load_config()
            self.db = AudioDatabase()
            self.stem_manager = StemManager(database=self.db)
            self.drive_client = get_drive_client()
            self.colab_trigger = ColabTrigger(drive_client=self.drive_client)
            self._is_cancelled = False
            self.temp_copy_path = None
            # Dummy signals
            self.progress = Signal()
            self.status_message = Signal()
            self.finished_success = Signal()
            self.error_occurred = Signal()
            self.log_message = Signal()

        def start(self):
            import threading
            t = threading.Thread(target=self.run, daemon=True)
            t.start()

        def run(self):
            # Gleiche Logik wie oben, vereinfacht
            print(f"[Worker Fallback] Starte für {self.track_id}")
            try:
                self.temp_copy_path = create_temp_copy(self.track_path, self.app_dirs["temp"])
                self.drive_client.ensure_folder_structure()
                upload_result = self.drive_client.upload_track(self.temp_copy_path, self.track_id)
                self.colab_trigger.trigger_after_upload(self.track_id, upload_result, self.track_path)
                
                # Simuliere Verarbeitung wenn Mock
                if hasattr(self.drive_client, 'simulate_colab_processing'):
                    time.sleep(2)
                    self.drive_client.simulate_colab_processing(self.track_id)
                
                # Polling
                for _ in range(60):
                    is_ready, _ = self.drive_client.check_output_ready(self.track_id)
                    if is_ready:
                        break
                    time.sleep(1)
                
                local_dir = self.app_dirs["stems"] / self.track_id
                downloaded = self.drive_client.download_stems(self.track_id, local_dir)
                self.stem_manager.link_downloaded_stems(self.track_id, downloaded)
                
                if self.temp_copy_path and self.temp_copy_path.exists():
                    self.temp_copy_path.unlink()
                
                print(f"[Worker Fallback] Fertig für {self.track_id}")
                self.finished_success.emit(self.track_id, downloaded)
            except Exception as e:
                print(f"[Worker Fallback] Fehler: {e}")
                self.error_occurred.emit(self.track_id, str(e))
