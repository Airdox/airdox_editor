"""
Konfiguration für den Audio Editor (main branch)
Einfache Pfad- und Settings-Verwaltung
"""
import os
import json
from pathlib import Path

APP_NAME = "AudioEditor"
APP_VERSION = "0.1.0"

# Basis-Pfade
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "audio_editor.db"
STEMS_DIR = DATA_DIR / "stems"
STEMS_DIR.mkdir(exist_ok=True)
TEMP_DIR = DATA_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# Config-Datei (optional)
CONFIG_FILE = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "sample_rate": 44100,
    "buffer_size": 512,
    "theme": "dark",
    "recent_tracks_limit": 20,
    "auto_save": True
}

def load_config():
    """Lädt Konfiguration aus Datei oder gibt Defaults zurück"""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
                cfg = {**DEFAULT_CONFIG, **user_config}
                return cfg
        except Exception as e:
            print(f"[Config] Fehler beim Laden von config.json: {e}")
    return DEFAULT_CONFIG.copy()

def get_app_dirs():
    """Gibt wichtige App-Verzeichnisse zurück"""
    return {
        "base": BASE_DIR,
        "data": DATA_DIR,
        "db": DB_PATH,
        "stems": STEMS_DIR,
        "temp": TEMP_DIR
    }

# Geladene Config
CONFIG = load_config()
