"""
Hilfsfunktionen für den Audio Editor
"""
import hashlib
import shutil
import uuid
from pathlib import Path
from datetime import datetime

def generate_track_id(file_path: Path) -> str:
    """Generiert eine stabile ID für einen Track basierend auf Pfad + Hash"""
    file_path = Path(file_path)
    # Hash aus Dateiname + Größe + mtime für Stabilität
    stat = file_path.stat() if file_path.exists() else None
    base = f"{file_path.name}_{stat.st_size if stat else 0}_{stat.st_mtime if stat else 0}"
    return hashlib.md5(base.encode()).hexdigest()[:12]

def create_temp_copy(source_path: Path, temp_dir: Path) -> Path:
    """Erstellt eine temporäre Arbeitskopie einer Audiodatei"""
    source_path = Path(source_path)
    temp_dir = Path(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    track_id = generate_track_id(source_path)
    temp_filename = f"{track_id}_{source_path.name}"
    dest = temp_dir / temp_filename
    
    shutil.copy2(source_path, dest)
    return dest

def format_time(seconds: float) -> str:
    """Formatiert Sekunden zu MM:SS"""
    if seconds is None:
        return "--:--"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m:02d}:{s:02d}"

def get_timestamp():
    return datetime.now().isoformat()
