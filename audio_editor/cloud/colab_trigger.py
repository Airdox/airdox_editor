"""
Colab Trigger - Automatisiertes Triggern des Colab Prozesses
Feature Branch: feature/colab-stem-separation

Strategien:
1. Google Drive Watcher: Colab Notebook läuft und beobachtet Input-Ordner (Hauptstrategie)
2. Webhook: Falls COLAB_WEBHOOK_URL gesetzt, POST Request an externen Trigger
3. Status-Datei: Schreibt Trigger-JSON das von Colab erkannt wird
"""

import os
import json
import requests
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime

from ..config import load_config, get_app_dirs
from .drive_client import DriveClientBase, get_drive_client

class ColabTrigger:
    def __init__(self, drive_client: DriveClientBase = None):
        self.drive_client = drive_client or get_drive_client()
        self.config = load_config()
        self.webhook_url = self.config.get("cloud", {}).get("colab_webhook_url") or os.getenv("COLAB_WEBHOOK_URL")

    def trigger_after_upload(self, track_id: str, upload_result: Dict, original_file: Path) -> Dict:
        """
        Wird nach erfolgreichem Upload aufgerufen um Colab zu triggern
        - Schreibt Trigger-Datei (bereits im drive_client.upload_track erledigt)
        - Sendet optional Webhook
        - Loggt Job in DB
        """
        original_file = Path(original_file)
        
        trigger_info = {
            "track_id": track_id,
            "file_name": upload_result.get("file_name"),
            "file_id": upload_result.get("file_id"),
            "original_name": original_file.name,
            "triggered_at": datetime.now().isoformat(),
            "webhook_url": self.webhook_url,
            "drive_folders": self.drive_client.ensure_folder_structure() if hasattr(self.drive_client, 'ensure_folder_structure') else {}
        }
        
        print(f"[ColabTrigger] Trigger für Track {track_id}")
        print(f"  - Datei: {upload_result.get('file_name')}")
        print(f"  - Drive File ID: {upload_result.get('file_id')}")
        
        # 1. Drive Watcher ist Hauptmechanismus - Trigger-Datei wurde bereits erstellt
        # Der Colab Notebook Watcher erkennt _TRIGGER_<track_id>.json automatisch
        
        # 2. Webhook falls konfiguriert
        if self.webhook_url:
            try:
                self._send_webhook(trigger_info)
                trigger_info["webhook_sent"] = True
            except Exception as e:
                print(f"[ColabTrigger] Webhook fehlgeschlagen: {e}")
                trigger_info["webhook_sent"] = False
                trigger_info["webhook_error"] = str(e)
        else:
            print("[ColabTrigger] Kein Webhook konfiguriert - nutze Drive Watcher Modus")
            print("[ColabTrigger] Hinweis: Colab Notebook muss laufen und Input-Ordner beobachten")
            trigger_info["webhook_sent"] = False
            trigger_info["mode"] = "drive_watcher"
        
        # 3. Lokale Trigger-Info speichern für Debugging
        temp_dir = Path(get_app_dirs()["temp"])
        temp_dir.mkdir(parents=True, exist_ok=True)
        local_trigger_log = temp_dir / f"trigger_{track_id}.json"
        with open(local_trigger_log, 'w') as f:
            json.dump(trigger_info, f, indent=2)
        
        return trigger_info

    def _send_webhook(self, trigger_info: Dict):
        """Sendet POST Request an Webhook URL"""
        if not self.webhook_url:
            return
        
        print(f"[ColabTrigger] Sende Webhook an {self.webhook_url}")
        
        payload = {
            "event": "stem_separation_requested",
            "track_id": trigger_info["track_id"],
            "file_name": trigger_info["file_name"],
            "file_id": trigger_info["file_id"],
            "timestamp": trigger_info["triggered_at"],
            "source": "AudioEditor"
        }
        
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "AudioEditor-ColabTrigger/1.0"
        }
        
        # Optional: Auth Token aus Env
        webhook_token = os.getenv("COLAB_WEBHOOK_TOKEN")
        if webhook_token:
            headers["Authorization"] = f"Bearer {webhook_token}"
        
        response = requests.post(
            self.webhook_url,
            json=payload,
            headers=headers,
            timeout=15
        )
        
        print(f"[ColabTrigger] Webhook Response: {response.status_code}")
        if response.status_code not in (200, 202, 204):
            print(f"[ColabTrigger] Webhook Body: {response.text[:500]}")
            response.raise_for_status()
        
        print(f"[ColabTrigger] Webhook erfolgreich gesendet")

    def check_colab_status(self, track_id: str) -> Dict:
        """
        Prüft Status in Drive - wird vom Worker für Polling genutzt
        """
        is_ready, stems_info = self.drive_client.check_output_ready(track_id)
        return {
            "track_id": track_id,
            "ready": is_ready,
            "stems_found": len(stems_info),
            "stems": stems_info,
            "checked_at": datetime.now().isoformat()
        }

    @staticmethod
    def get_colab_notebook_instructions() -> str:
        """Gibt Anleitung für Colab Setup zurück"""
        return """
# Google Colab Setup für AudioEditor Stem Separation

## 1. Notebook öffnen
- Öffne `audio_editor/colab/colab_notebook.ipynb` in Google Colab
- Oder kopiere den Inhalt aus `audio_editor/colab/demucs_processor.py`

## 2. GPU aktivieren (WICHTIG!)
- In Colab: Laufzeit -> Laufzeittyp ändern -> Hardwarebeschleuniger: GPU (T4, V100 oder A100)
- Prüfe mit: `torch.cuda.is_available()` sollte True sein

## 3. Google Drive mounten
Das Notebook mountet automatisch /content/drive und erwartet:
- /MyDrive/AudioEditor_Stems/Input/  (Uploads vom Editor)
- /MyDrive/AudioEditor_Stems/Output/ (Ergebnisse)

## 4. Watcher starten
Das Notebook enthält eine Endlosschleife die:
- Input-Ordner auf _TRIGGER_*.json Dateien überwacht
- Bei neuem Trigger automatisch htdemucs ausführt
- Ergebnisse nach Output/<Track_ID>/ schreibt
- status.json und DONE Marker erstellt

## 5. Modell
- Verwendet Hybrid Transformer Demucs (htdemucs) aus demucs Bibliothek
- Gewichte werden automatisch über offizielle PyTorch Hub geladen
- Keine manuellen Download-Links nötig
- Standard-Stems: drums, bass, other, vocals

## Automatisierung
Für vollautomatischen Betrieb ohne manuelles Starten:
- Option A: Colab Notebook manuell einmal starten und laufen lassen (Watcher)
- Option B: Colab Pro mit Scheduled Execution
- Option C: Eigenen kleinen Server mit Webhook der Colab API triggert (siehe colab_trigger.py)
"""
