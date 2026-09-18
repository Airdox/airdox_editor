"""
Google Drive Client für Audio Editor
Feature Branch: feature/colab-stem-separation

- Automatisierte Authentifizierung über vorhandene Credentials
- Ordnerstruktur: /AudioEditor_Stems/Input/ und /AudioEditor_Stems/Output/<Track_ID>/
- Upload, Polling, Download von Stems
- Mock-Implementierung für Entwicklung ohne Credentials
"""

import os
import json
import time
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime
import hashlib

from ..config import (
    get_drive_folders, 
    get_app_dirs, 
    load_config,
    get_credentials_or_raise,
    MissingCredentialsError,
    MOCK_DRIVE_DIR
)

# Standard Stems
STANDARD_STEMS = ["drums", "bass", "other", "vocals"]

class DriveClientBase:
    """Basis-Interface für Drive Clients"""
    def ensure_folder_structure(self) -> Dict[str, str]:
        raise NotImplementedError
    
    def upload_track(self, local_path: Path, track_id: str) -> Dict:
        raise NotImplementedError
    
    def check_output_ready(self, track_id: str) -> Tuple[bool, List[Dict]]:
        raise NotImplementedError
    
    def download_stems(self, track_id: str, local_dir: Path) -> List[Path]:
        raise NotImplementedError
    
    def list_input_files(self) -> List[Dict]:
        raise NotImplementedError

class MockDriveClient(DriveClientBase):
    """
    Mock-Implementierung die lokales Dateisystem nutzt statt Google Drive
    Nützlich für Entwicklung und Tests ohne Credentials
    Simuliert: /AudioEditor_Stems/Input/ und /AudioEditor_Stems/Output/<Track_ID>/
    """
    def __init__(self, mock_root: Path = None):
        self.mock_root = Path(mock_root) if mock_root else MOCK_DRIVE_DIR
        self.mock_root.mkdir(parents=True, exist_ok=True)
        self.folders = get_drive_folders()
        print(f"[MockDrive] Initialisiert mit Root: {self.mock_root}")

    def _get_input_dir(self) -> Path:
        d = self.mock_root / self.folders["input"]
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _get_output_dir(self, track_id: str = None) -> Path:
        base = self.mock_root / self.folders["output"]
        base.mkdir(parents=True, exist_ok=True)
        if track_id:
            d = base / track_id
            d.mkdir(parents=True, exist_ok=True)
            return d
        return base

    def ensure_folder_structure(self) -> Dict[str, str]:
        input_dir = self._get_input_dir()
        output_dir = self._get_output_dir()
        print(f"[MockDrive] Ordnerstruktur sichergestellt: {input_dir}, {output_dir}")
        return {
            "input": str(input_dir),
            "output": str(output_dir),
            "input_id": str(input_dir),
            "output_id": str(output_dir)
        }

    def upload_track(self, local_path: Path, track_id: str) -> Dict:
        local_path = Path(local_path)
        input_dir = self._get_input_dir()
        
        # Zielname: <track_id>_<originalname>
        dest_name = f"{track_id}_{local_path.name}"
        dest_path = input_dir / dest_name
        
        shutil.copy2(local_path, dest_path)
        
        # Metadata JSON
        metadata = {
            "track_id": track_id,
            "original_name": local_path.name,
            "uploaded_at": datetime.now().isoformat(),
            "size": local_path.stat().st_size,
            "mock_file_id": hashlib.md5(str(dest_path).encode()).hexdigest()[:16]
        }
        meta_path = input_dir / f"{track_id}_metadata.json"
        with open(meta_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        
        # Trigger-Datei für Colab Watcher
        trigger = {
            "track_id": track_id,
            "file_name": dest_name,
            "original_name": local_path.name,
            "uploaded_at": datetime.now().isoformat(),
            "status": "pending",
            "source": "audio_editor_mock"
        }
        trigger_path = input_dir / f"_TRIGGER_{track_id}.json"
        with open(trigger_path, 'w') as f:
            json.dump(trigger, f, indent=2)
        
        print(f"[MockDrive] Upload: {local_path} -> {dest_path}")
        print(f"[MockDrive] Trigger erstellt: {trigger_path}")
        
        return {
            "file_id": metadata["mock_file_id"],
            "file_name": dest_name,
            "path": str(dest_path),
            "trigger_path": str(trigger_path),
            "metadata": metadata
        }

    def check_output_ready(self, track_id: str) -> Tuple[bool, List[Dict]]:
        output_dir = self._get_output_dir(track_id)
        if not output_dir.exists():
            return False, []
        
        found_stems = []
        for stem_type in STANDARD_STEMS:
            # Suche nach stem Dateien
            for ext in [".wav", ".mp3", ".flac"]:
                # Verschiedene mögliche Namenskonventionen
                candidates = [
                    output_dir / f"{stem_type}{ext}",
                    output_dir / f"{stem_type}.wav",
                ]
                # Glob für Dateien mit stem_type im Namen
                candidates.extend(output_dir.glob(f"*{stem_type}*{ext}"))
                
                for cand in candidates:
                    if cand.exists() and cand.is_file():
                        found_stems.append({
                            "stem_type": stem_type,
                            "file_name": cand.name,
                            "path": str(cand),
                            "file_id": hashlib.md5(str(cand).encode()).hexdigest()[:16],
                            "size": cand.stat().st_size
                        })
                        break
                if any(f["stem_type"] == stem_type for f in found_stems):
                    break
        
        # Prüfe auf status.json oder done marker
        status_file = output_dir / "status.json"
        done_marker = output_dir / "DONE"
        
        is_ready = False
        if done_marker.exists():
            is_ready = True
        elif status_file.exists():
            try:
                with open(status_file, 'r') as f:
                    status = json.load(f)
                    if status.get("status") == "completed" or status.get("done"):
                        is_ready = True
                    # Auch wenn 4 Stems vorhanden sind, als ready betrachten
                    if len(found_stems) >= 4:
                        is_ready = True
            except:
                if len(found_stems) >= 4:
                    is_ready = True
        else:
            # Fallback: Wenn 4 Stems da sind, ready
            if len(found_stems) >= 4:
                is_ready = True
        
        return is_ready, found_stems

    def download_stems(self, track_id: str, local_dir: Path) -> List[Path]:
        local_dir = Path(local_dir)
        local_dir.mkdir(parents=True, exist_ok=True)
        
        output_dir = self._get_output_dir(track_id)
        if not output_dir.exists():
            return []
        
        downloaded = []
        is_ready, stems_info = self.check_output_ready(track_id)
        
        for stem_info in stems_info:
            src = Path(stem_info["path"])
            dest = local_dir / src.name
            if src.exists():
                shutil.copy2(src, dest)
                downloaded.append(dest)
                print(f"[MockDrive] Download: {src} -> {dest}")
        
        return downloaded

    def list_input_files(self) -> List[Dict]:
        input_dir = self._get_input_dir()
        files = []
        for f in input_dir.iterdir():
            if f.is_file() and not f.name.startswith("_TRIGGER_") and not f.name.endswith("_metadata.json"):
                files.append({
                    "name": f.name,
                    "path": str(f),
                    "size": f.stat().st_size
                })
        return files

    def simulate_colab_processing(self, track_id: str):
        """
        Simuliert die Colab-Verarbeitung für Tests:
        Kopiert Input nach Output und erstellt Dummy-Stems
        """
        input_dir = self._get_input_dir()
        output_dir = self._get_output_dir(track_id)
        
        # Finde Input-Datei für diesen Track
        input_files = list(input_dir.glob(f"{track_id}_*"))
        if not input_files:
            print(f"[MockDrive] Keine Input-Datei für {track_id} gefunden")
            return False
        
        input_file = [f for f in input_files if not f.name.endswith(".json")][0] if len(input_files) > 0 else input_files[0]
        
        # Erstelle Dummy-Stems (kopiere Input 4x mit unterschiedlichem Namen)
        for stem_type in STANDARD_STEMS:
            dest = output_dir / f"{stem_type}.wav"
            shutil.copy2(input_file, dest)
            print(f"[MockDrive] Simulierter Stem erstellt: {dest}")
        
        # Status-Datei
        status = {
            "track_id": track_id,
            "status": "completed",
            "done": True,
            "processed_at": datetime.now().isoformat(),
            "model": "htdemucs (simulated)",
            "stems": STANDARD_STEMS
        }
        with open(output_dir / "status.json", 'w') as f:
            json.dump(status, f, indent=2)
        
        (output_dir / "DONE").touch()
        print(f"[MockDrive] Simulation abgeschlossen für {track_id}")
        return True


class GoogleDriveClient(DriveClientBase):
    """
    Echter Google Drive Client mit google-api-python-client
    """
    def __init__(self, credentials: Dict = None):
        self.credentials_data = credentials
        self.service = None
        self.folders = get_drive_folders()
        self._folder_cache = {}
        self._authenticate()

    def _authenticate(self):
        """Authentifiziert sich bei Google Drive"""
        try:
            from google.oauth2 import service_account
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build
            
            # Prüfe ob es ein Service Account ist
            if self.credentials_data and "type" in self.credentials_data and self.credentials_data["type"] == "service_account":
                print("[Drive] Authentifiziere mit Service Account")
                creds = service_account.Credentials.from_service_account_info(
                    self.credentials_data,
                    scopes=["https://www.googleapis.com/auth/drive"]
                )
                self.service = build('drive', 'v3', credentials=creds)
            elif self.credentials_data and "installed" in self.credentials_data or "client_id" in self.credentials_data:
                # OAuth User Credentials
                print("[Drive] Authentifiziere mit OAuth Credentials")
                # Hier würde normalerweise der OAuth Flow laufen
                # Für Automatisierung: Token aus Datei oder Env
                creds = Credentials.from_authorized_user_info(self.credentials_data, scopes=["https://www.googleapis.com/auth/drive"])
                self.service = build('drive', 'v3', credentials=creds)
            else:
                # Versuche über Application Default Credentials oder Datei
                print("[Drive] Versuche Default Credentials")
                # Fallback: Versuche service account file path
                creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
                if creds_path and Path(creds_path).exists():
                    creds = service_account.Credentials.from_service_account_file(
                        creds_path,
                        scopes=["https://www.googleapis.com/auth/drive"]
                    )
                    self.service = build('drive', 'v3', credentials=creds)
                else:
                    raise MissingCredentialsError("Keine gültigen Google Credentials gefunden für Drive Client")
            
            print("[Drive] Erfolgreich authentifiziert")
        except ImportError as e:
            print(f"[Drive] Google Bibliotheken nicht installiert: {e}")
            print("[Drive] Fallback zu MockDriveClient")
            raise
        except Exception as e:
            print(f"[Drive] Authentifizierung fehlgeschlagen: {e}")
            raise

    def _find_or_create_folder(self, folder_name: str, parent_id: str = None) -> str:
        """Findet oder erstellt einen Ordner, gibt ID zurück"""
        cache_key = f"{parent_id}_{folder_name}"
        if cache_key in self._folder_cache:
            return self._folder_cache[cache_key]

        # Suche
        query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and trashed=false"
        if parent_id:
            query += f" and '{parent_id}' in parents"
        
        results = self.service.files().list(q=query, fields="files(id, name)").execute()
        files = results.get('files', [])
        
        if files:
            folder_id = files[0]['id']
            self._folder_cache[cache_key] = folder_id
            return folder_id
        
        # Erstelle
        file_metadata = {
            'name': folder_name,
            'mimeType': 'application/vnd.google-apps.folder'
        }
        if parent_id:
            file_metadata['parents'] = [parent_id]
        
        folder = self.service.files().create(body=file_metadata, fields='id').execute()
        folder_id = folder.get('id')
        self._folder_cache[cache_key] = folder_id
        print(f"[Drive] Ordner erstellt: {folder_name} (ID: {folder_id})")
        return folder_id

    def ensure_folder_structure(self) -> Dict[str, str]:
        """Stellt sicher dass die Ordnerstruktur existiert"""
        # Base Ordner AudioEditor_Stems
        base_id = self._find_or_create_folder(self.folders["base"])
        # Input
        input_id = self._find_or_create_folder("Input", parent_id=base_id)
        # Output
        output_id = self._find_or_create_folder("Output", parent_id=base_id)
        
        print(f"[Drive] Ordnerstruktur: Base={base_id}, Input={input_id}, Output={output_id}")
        return {
            "base": self.folders["base"],
            "input": self.folders["input"],
            "output": self.folders["output"],
            "base_id": base_id,
            "input_id": input_id,
            "output_id": output_id
        }

    def upload_track(self, local_path: Path, track_id: str) -> Dict:
        """Lädt Track in Input Ordner hoch"""
        from googleapiclient.http import MediaFileUpload
        
        local_path = Path(local_path)
        folders = self.ensure_folder_structure()
        input_folder_id = folders["input_id"]
        
        # Dateiname mit Track-ID für Zuordnung
        dest_name = f"{track_id}_{local_path.name}"
        
        file_metadata = {
            'name': dest_name,
            'parents': [input_folder_id]
        }
        
        media = MediaFileUpload(str(local_path), resumable=True)
        file = self.service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, name, size'
        ).execute()
        
        file_id = file.get('id')
        print(f"[Drive] Upload erfolgreich: {dest_name} (ID: {file_id})")
        
        # Trigger-Datei erstellen
        trigger_content = {
            "track_id": track_id,
            "file_name": dest_name,
            "file_id": file_id,
            "original_name": local_path.name,
            "uploaded_at": datetime.now().isoformat(),
            "status": "pending"
        }
        
        trigger_name = f"_TRIGGER_{track_id}.json"
        trigger_metadata = {
            'name': trigger_name,
            'parents': [input_folder_id]
        }
        
        # Temporäre Trigger-Datei lokal erstellen
        temp_trigger = Path(get_app_dirs()["temp"]) / trigger_name
        with open(temp_trigger, 'w') as f:
            json.dump(trigger_content, f, indent=2)
        
        trigger_media = MediaFileUpload(str(temp_trigger), mimetype='application/json')
        trigger_file = self.service.files().create(
            body=trigger_metadata,
            media_body=trigger_media,
            fields='id'
        ).execute()
        
        print(f"[Drive] Trigger erstellt: {trigger_name} (ID: {trigger_file.get('id')})")
        
        # Cleanup temp
        temp_trigger.unlink(missing_ok=True)
        
        return {
            "file_id": file_id,
            "file_name": dest_name,
            "trigger_file_id": trigger_file.get('id'),
            "metadata": trigger_content
        }

    def check_output_ready(self, track_id: str) -> Tuple[bool, List[Dict]]:
        """Prüft ob Output für Track bereit ist"""
        folders = self.ensure_folder_structure()
        output_base_id = folders["output_id"]
        
        # Suche nach Ordner für diesen Track
        query = f"mimeType='application/vnd.google-apps.folder' and name='{track_id}' and '{output_base_id}' in parents and trashed=false"
        results = self.service.files().list(q=query, fields="files(id, name)").execute()
        track_folders = results.get('files', [])
        
        if not track_folders:
            return False, []
        
        track_folder_id = track_folders[0]['id']
        
        # Liste Dateien in diesem Ordner
        query = f"'{track_folder_id}' in parents and trashed=false"
        results = self.service.files().list(q=query, fields="files(id, name, size, mimeType)").execute()
        files = results.get('files', [])
        
        found_stems = []
        has_status_completed = False
        
        for f in files:
            fname_lower = f['name'].lower()
            for stem_type in STANDARD_STEMS:
                if stem_type in fname_lower:
                    found_stems.append({
                        "stem_type": stem_type,
                        "file_name": f['name'],
                        "file_id": f['id'],
                        "size": f.get('size', 0)
                    })
                    break
            if f['name'] == "status.json" or f['name'] == "DONE":
                # Prüfe Status
                if f['name'] == "DONE":
                    has_status_completed = True
                elif f['name'] == "status.json":
                    # Lade status.json Inhalt
                    try:
                        from googleapiclient.http import MediaIoBaseDownload
                        import io
                        request = self.service.files().get_media(fileId=f['id'])
                        fh = io.BytesIO()
                        downloader = MediaIoBaseDownload(fh, request)
                        done = False
                        while not done:
                            _, done = downloader.next_chunk()
                        fh.seek(0)
                        status_data = json.loads(fh.read().decode())
                        if status_data.get("status") == "completed" or status_data.get("done"):
                            has_status_completed = True
                    except:
                        pass
        
        is_ready = has_status_completed or len(found_stems) >= 4
        return is_ready, found_stems

    def download_stems(self, track_id: str, local_dir: Path) -> List[Path]:
        """Lädt Stems für einen Track herunter"""
        from googleapiclient.http import MediaIoBaseDownload
        import io
        
        local_dir = Path(local_dir)
        local_dir.mkdir(parents=True, exist_ok=True)
        
        folders = self.ensure_folder_structure()
        output_base_id = folders["output_id"]
        
        # Finde Track-Ordner
        query = f"mimeType='application/vnd.google-apps.folder' and name='{track_id}' and '{output_base_id}' in parents and trashed=false"
        results = self.service.files().list(q=query, fields="files(id, name)").execute()
        track_folders = results.get('files', [])
        
        if not track_folders:
            return []
        
        track_folder_id = track_folders[0]['id']
        
        # Liste und downloade
        query = f"'{track_folder_id}' in parents and trashed=false"
        results = self.service.files().list(q=query, fields="files(id, name)").execute()
        files = results.get('files', [])
        
        downloaded = []
        for f in files:
            # Nur Stem-Dateien und relevante
            if not any(st in f['name'].lower() for st in STANDARD_STEMS):
                if f['name'] not in ["status.json", "DONE"]:
                    continue
                # status.json auch herunterladen für Info, aber nicht als Stem zählen
                if f['name'] in ["status.json", "DONE"]:
                    continue
            
            dest_path = local_dir / f['name']
            request = self.service.files().get_media(fileId=f['id'])
            fh = io.FileIO(str(dest_path), 'wb')
            downloader = MediaIoBaseDownload(fh, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            fh.close()
            downloaded.append(dest_path)
            print(f"[Drive] Download: {f['name']} -> {dest_path}")
        
        return downloaded

    def list_input_files(self) -> List[Dict]:
        folders = self.ensure_folder_structure()
        input_id = folders["input_id"]
        query = f"'{input_id}' in parents and trashed=false"
        results = self.service.files().list(q=query, fields="files(id, name, size)").execute()
        return results.get('files', [])


def get_drive_client() -> DriveClientBase:
    """
    Factory: Gibt den passenden Drive Client zurück
    - Wenn Credentials vorhanden: echter GoogleDriveClient
    - Sonst: MockDriveClient
    - Wenn USE_MOCK_DRIVE gesetzt: immer Mock
    """
    config = load_config()
    use_mock = config.get("cloud", {}).get("use_mock_drive", False)
    
    if os.getenv("USE_MOCK_DRIVE", "").lower() in ("1", "true", "yes"):
        use_mock = True
    
    if use_mock:
        print("[DriveFactory] Verwende MockDriveClient (USE_MOCK_DRIVE aktiv)")
        return MockDriveClient()
    
    try:
        creds = get_credentials_or_raise()
        if creds.get("mock"):
            return MockDriveClient()
        # Versuche echten Client
        try:
            client = GoogleDriveClient(credentials=creds)
            # Teste Verbindung durch Ordnerstruktur
            client.ensure_folder_structure()
            return client
        except ImportError:
            print("[DriveFactory] Google Bibliotheken nicht installiert, fallback zu Mock")
            return MockDriveClient()
        except Exception as e:
            print(f"[DriveFactory] Echter Drive Client fehlgeschlagen: {e}")
            print("[DriveFactory] Fallback zu MockDriveClient für Entwicklung")
            return MockDriveClient()
    except MissingCredentialsError as e:
        print(f"[DriveFactory] {e}")
        print("[DriveFactory] Verwende MockDriveClient als Fallback")
        return MockDriveClient()
