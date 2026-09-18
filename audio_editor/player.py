"""
Einfacher Audio-Player (Mock / Basis-Implementierung)
In main branch ohne echte Audio-Engine, nur Status-Verwaltung
"""
from pathlib import Path
from enum import Enum
from .utils import format_time

class PlayerState(Enum):
    STOPPED = "stopped"
    PLAYING = "playing"
    PAUSED = "paused"
    LOADING = "loading"

class AudioPlayer:
    """Basis-Audio-Player - in echter App würde hier z.B. sounddevice/pyaudio laufen"""
    def __init__(self, deck_id: str = "A"):
        self.deck_id = deck_id
        self.state = PlayerState.STOPPED
        self.current_track_path: Path | None = None
        self.current_track_id: str | None = None
        self.duration: float | None = None
        self.position: float = 0.0

    def load(self, file_path: Path, track_id: str, duration: float = None):
        self.current_track_path = Path(file_path)
        self.current_track_id = track_id
        self.duration = duration
        self.state = PlayerState.STOPPED
        self.position = 0.0
        print(f"[Player {self.deck_id}] Loaded: {file_path} (ID: {track_id})")
        return True

    def play(self):
        if not self.current_track_path:
            return False
        self.state = PlayerState.PLAYING
        print(f"[Player {self.deck_id}] Playing")
        return True

    def pause(self):
        if self.state == PlayerState.PLAYING:
            self.state = PlayerState.PAUSED
            print(f"[Player {self.deck_id}] Paused")
            return True
        return False

    def stop(self):
        self.state = PlayerState.STOPPED
        self.position = 0.0
        print(f"[Player {self.deck_id}] Stopped")
        return True

    def get_current_track(self):
        return {
            "path": self.current_track_path,
            "id": self.current_track_id,
            "state": self.state,
            "duration": self.duration,
            "position": self.position
        }

    def is_track_loaded(self):
        return self.current_track_path is not None and self.current_track_path.exists()
