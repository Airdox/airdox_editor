"""
Einfache SQLite-Datenbank für Tracks und Metadaten
(main branch - ohne Stem-Verknüpfung)
"""
import sqlite3
from pathlib import Path
from datetime import datetime
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
            conn.commit()

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
            conn.commit()
