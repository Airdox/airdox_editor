"""
Erweiterte SQLite-Datenbank für Tracks und Stems
Feature Branch: colab-stem-separation
"""
import sqlite3
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional
from .config import DB_PATH

class AudioDatabase:
    def __init__(self, db_path: Path = None):
        self.db_path = Path(db_path) if db_path else DB_PATH
        self._init_db()

    def _init_db(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    title TEXT,
                    artist TEXT,
                    duration REAL,
                    sample_rate INTEGER,
                    added_at TEXT,
                    last_played TEXT
                )
            """)
            # Neue Tabelle für Stems (Feature Branch)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS stems (
                    id TEXT PRIMARY KEY,
                    track_id TEXT NOT NULL,
                    stem_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    created_at TEXT,
                    drive_file_id TEXT,
                    local_size INTEGER,
                    FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE,
                    UNIQUE(track_id, stem_type)
                )
            """)
            # Tabelle für Cloud-Jobs
            conn.execute("""
                CREATE TABLE IF NOT EXISTS cloud_jobs (
                    id TEXT PRIMARY KEY,
                    track_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    drive_input_file_id TEXT,
                    drive_output_folder_id TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    error_message TEXT,
                    FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
                )
            """)
            conn.commit()
            # Migration: Falls alte DB ohne stems Tabelle
            self._migrate()

    def _migrate(self):
        """Einfache Migration für bestehende DBs"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                # Prüfe ob stems Tabelle Spalten hat
                cur = conn.execute("PRAGMA table_info(stems)")
                cols = [r[1] for r in cur.fetchall()]
                if "drive_file_id" not in cols:
                    try:
                        conn.execute("ALTER TABLE stems ADD COLUMN drive_file_id TEXT")
                    except:
                        pass
        except:
            pass

    # --- Tracks ---
    def add_or_update_track(self, track_id: str, file_path: str, file_name: str = None, title: str = None, duration: float = None):
        file_name = file_name or Path(file_path).name
        now = datetime.now().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO tracks (id, file_path, file_name, title, duration, added_at, last_played)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    file_path=excluded.file_path,
                    file_name=excluded.file_name,
                    title=excluded.title,
                    duration=excluded.duration,
                    last_played=excluded.last_played
            """, (track_id, file_path, file_name, title or file_name, duration, now, now))
            conn.commit()

    def get_track(self, track_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM tracks WHERE id=?", (track_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    def list_tracks(self, limit=100):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM tracks ORDER BY last_played DESC LIMIT ?", (limit,))
            return [dict(r) for r in cur.fetchall()]

    def delete_track(self, track_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM tracks WHERE id=?", (track_id,))
            conn.execute("DELETE FROM stems WHERE track_id=?", (track_id,))
            conn.execute("DELETE FROM cloud_jobs WHERE track_id=?", (track_id,))
            conn.commit()

    # --- Stems ---
    def add_stems_for_track(self, track_id: str, stems: List[Dict]):
        """
        stems: Liste von Dicts mit keys: stem_type, file_path, file_name, drive_file_id (optional)
        """
        now = datetime.now().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            for stem in stems:
                stem_id = f"{track_id}_{stem['stem_type']}"
                file_path = stem["file_path"]
                size = Path(file_path).stat().st_size if Path(file_path).exists() else 0
                conn.execute("""
                    INSERT INTO stems (id, track_id, stem_type, file_path, file_name, created_at, drive_file_id, local_size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(track_id, stem_type) DO UPDATE SET
                        file_path=excluded.file_path,
                        file_name=excluded.file_name,
                        created_at=excluded.created_at,
                        drive_file_id=excluded.drive_file_id,
                        local_size=excluded.local_size
                """, (
                    stem_id,
                    track_id,
                    stem["stem_type"],
                    str(file_path),
                    stem.get("file_name", Path(file_path).name),
                    now,
                    stem.get("drive_file_id"),
                    size
                ))
            conn.commit()

    def get_stems_for_track(self, track_id: str) -> List[Dict]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM stems WHERE track_id=? ORDER BY stem_type", (track_id,))
            return [dict(r) for r in cur.fetchall()]

    def has_stems(self, track_id: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("SELECT COUNT(*) FROM stems WHERE track_id=?", (track_id,))
            count = cur.fetchone()[0]
            return count >= 4  # Drums, Bass, Other, Vocals

    def delete_stems_for_track(self, track_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM stems WHERE track_id=?", (track_id,))
            conn.commit()

    # --- Cloud Jobs ---
    def create_cloud_job(self, job_id: str, track_id: str, status: str = "uploading"):
        now = datetime.now().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO cloud_jobs (id, track_id, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
            """, (job_id, track_id, status, now, now))
            conn.commit()

    def update_cloud_job(self, job_id: str, status: str = None, drive_input_file_id: str = None, 
                         drive_output_folder_id: str = None, error_message: str = None):
        now = datetime.now().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            # Dynamisches Update
            fields = []
            params = []
            if status:
                fields.append("status=?")
                params.append(status)
            if drive_input_file_id:
                fields.append("drive_input_file_id=?")
                params.append(drive_input_file_id)
            if drive_output_folder_id:
                fields.append("drive_output_folder_id=?")
                params.append(drive_output_folder_id)
            if error_message is not None:
                fields.append("error_message=?")
                params.append(error_message)
            fields.append("updated_at=?")
            params.append(now)
            params.append(job_id)
            
            if fields:
                sql = f"UPDATE cloud_jobs SET {', '.join(fields)} WHERE id=?"
                conn.execute(sql, params)
                conn.commit()

    def get_cloud_job(self, job_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM cloud_jobs WHERE id=?", (job_id,))
            row = cur.fetchone()
            return dict(row) if row else None

    def get_latest_job_for_track(self, track_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM cloud_jobs WHERE track_id=? ORDER BY created_at DESC LIMIT 1", (track_id,))
            row = cur.fetchone()
            return dict(row) if row else None
