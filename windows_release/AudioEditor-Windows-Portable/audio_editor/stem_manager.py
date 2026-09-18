"""
Stem Manager - Verwaltung lokaler Stems und Verknüpfung mit Originaltracks
Feature Branch: colab-stem-separation
"""
import shutil
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime

from .config import STEMS_DIR, get_app_dirs
from .database import AudioDatabase

# Standard Demucs Stems
STANDARD_STEMS = ["drums", "bass", "other", "vocals"]

class StemManager:
    def __init__(self, stems_base_dir: Path = None, database: AudioDatabase = None):
        self.stems_base_dir = Path(stems_base_dir) if stems_base_dir else STEMS_DIR
        self.stems_base_dir.mkdir(parents=True, exist_ok=True)
        self.db = database or AudioDatabase()

    def get_stem_dir(self, track_id: str) -> Path:
        """Gibt das Verzeichnis für die Stems eines Tracks zurück"""
        d = self.stems_base_dir / track_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def list_local_stems(self, track_id: str) -> List[Path]:
        """Listet lokal vorhandene Stem-Dateien für einen Track"""
        stem_dir = self.get_stem_dir(track_id)
        if not stem_dir.exists():
            return []
        stems = []
        for stem_type in STANDARD_STEMS:
            # Suche nach Dateien die stem_type im Namen haben
            for ext in [".wav", ".mp3", ".flac"]:
                pattern = f"*{stem_type}*{ext}"
                stems.extend(stem_dir.glob(pattern))
                # Auch exakte Namen
                exact = stem_dir / f"{stem_type}{ext}"
                if exact.exists() and exact not in stems:
                    stems.append(exact)
        return stems

    def has_local_stems(self, track_id: str) -> bool:
        """Prüft ob alle 4 Standard-Stems lokal vorhanden sind"""
        stems = self.list_local_stems(track_id)
        found_types = set()
        for p in stems:
            for st in STANDARD_STEMS:
                if st in p.name.lower():
                    found_types.add(st)
        return len(found_types) >= 4

    def link_downloaded_stems(self, track_id: str, downloaded_files: List[Path], drive_file_ids: Dict[str, str] = None) -> List[Dict]:
        """
        Verknüpft heruntergeladene Stems mit dem Originaltrack in der DB
        downloaded_files: Liste der lokalen Pfade
        drive_file_ids: Optional Mapping stem_type -> drive_file_id
        Returns: Liste der DB-Einträge
        """
        drive_file_ids = drive_file_ids or {}
        stem_records = []
        
        for file_path in downloaded_files:
            file_path = Path(file_path)
            # Erkenne Stem-Typ aus Dateinamen
            stem_type = self._detect_stem_type(file_path.name)
            if not stem_type:
                continue
            
            # Kopiere/Verschiebe in das richtige Verzeichnis falls noch nicht dort
            target_dir = self.get_stem_dir(track_id)
            target_path = target_dir / file_path.name
            if file_path.resolve() != target_path.resolve():
                if file_path.exists():
                    shutil.copy2(file_path, target_path)
                    file_path = target_path
            
            stem_records.append({
                "stem_type": stem_type,
                "file_path": str(file_path),
                "file_name": file_path.name,
                "drive_file_id": drive_file_ids.get(stem_type)
            })
        
        if stem_records:
            self.db.add_stems_for_track(track_id, stem_records)
            print(f"[StemManager] {len(stem_records)} Stems für Track {track_id} verknüpft")
        
        return stem_records

    def _detect_stem_type(self, filename: str) -> Optional[str]:
        """Erkennt Stem-Typ aus Dateinamen"""
        lower = filename.lower()
        for stem_type in STANDARD_STEMS:
            if stem_type in lower:
                return stem_type
        return None

    def get_stems_for_track(self, track_id: str) -> List[Dict]:
        """Holt Stems aus DB für einen Track"""
        return self.db.get_stems_for_track(track_id)

    def delete_stems(self, track_id: str, delete_files: bool = True):
        """Löscht Stems für einen Track"""
        if delete_files:
            stem_dir = self.get_stem_dir(track_id)
            if stem_dir.exists():
                shutil.rmtree(stem_dir, ignore_errors=True)
                print(f"[StemManager] Stem-Verzeichnis gelöscht: {stem_dir}")
        self.db.delete_stems_for_track(track_id)

    def get_stem_paths_for_player(self, track_id: str) -> Dict[str, Path]:
        """Gibt Dict stem_type -> Path für Playback zurück"""
        stems = self.db.get_stems_for_track(track_id)
        result = {}
        for s in stems:
            p = Path(s["file_path"])
            if p.exists():
                result[s["stem_type"]] = p
        return result

    def organize_downloaded_stems(self, track_id: str, source_dir: Path) -> List[Path]:
        """
        Organisiert heruntergeladene Stems aus einem Quellverzeichnis in die Zielstruktur
        """
        source_dir = Path(source_dir)
        target_dir = self.get_stem_dir(track_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        
        organized = []
        for file_path in source_dir.rglob("*"):
            if file_path.is_file() and file_path.suffix.lower() in [".wav", ".mp3", ".flac", ".m4a"]:
                if any(stem in file_path.name.lower() for stem in STANDARD_STEMS):
                    dest = target_dir / file_path.name
                    shutil.copy2(file_path, dest)
                    organized.append(dest)
        
        return organized
