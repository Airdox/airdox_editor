"""
Konfiguration für den Audio Editor - Feature Branch: colab-stem-separation
Erweiterte Konfiguration mit Cloud-Credentials Handling
"""
import os
import json
from pathlib import Path
from typing import Optional, Dict, Any

APP_NAME = "AudioEditor"
APP_VERSION = "0.2.0-feature-colab"
BRANCH = "feature/colab-stem-separation"

# Basis-Pfade
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "audio_editor.db"
STEMS_DIR = DATA_DIR / "stems"
STEMS_DIR.mkdir(exist_ok=True)
TEMP_DIR = DATA_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# Mock Drive für Entwicklung ohne Credentials
MOCK_DRIVE_DIR = DATA_DIR / "mock_drive"
MOCK_DRIVE_DIR.mkdir(exist_ok=True)

# Config-Dateien
CONFIG_FILE = BASE_DIR / "config.json"
CREDENTIALS_SEARCH_PATHS = [
    BASE_DIR / "credentials.json",
    BASE_DIR / "service_account.json",
    BASE_DIR / "token.json",
    Path.home() / ".config" / "audio_editor" / "credentials.json",
    Path.home() / ".config" / "audio_editor" / "service_account.json",
    Path.home() / ".audio_editor" / "credentials.json",
]

# Google Drive Ordnerstruktur
DRIVE_BASE_FOLDER = "AudioEditor_Stems"
DRIVE_INPUT_FOLDER = f"{DRIVE_BASE_FOLDER}/Input"
DRIVE_OUTPUT_FOLDER = f"{DRIVE_BASE_FOLDER}/Output"

# Polling & Timeouts
POLL_INTERVAL_SECONDS = 15
POLL_TIMEOUT_SECONDS = 3600  # 1 Stunde
UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024  # 10MB

DEFAULT_CONFIG = {
    "sample_rate": 44100,
    "buffer_size": 512,
    "theme": "dark",
    "recent_tracks_limit": 20,
    "auto_save": True,
    # Cloud Config
    "cloud": {
        "drive_base_folder": DRIVE_BASE_FOLDER,
        "drive_input_folder": DRIVE_INPUT_FOLDER,
        "drive_output_folder": DRIVE_OUTPUT_FOLDER,
        "poll_interval": POLL_INTERVAL_SECONDS,
        "poll_timeout": POLL_TIMEOUT_SECONDS,
        "use_mock_drive": False,  # Auf True für lokale Entwicklung ohne Google Credentials
        "colab_webhook_url": None,
        "auto_download_stems": True
    }
}

class MissingCredentialsError(Exception):
    """Wird geworfen wenn keine Google Drive Credentials gefunden wurden"""
    pass

def find_credentials_file() -> Optional[Path]:
    """Sucht nach existierenden Credentials-Dateien an bekannten Orten"""
    for p in CREDENTIALS_SEARCH_PATHS:
        if p.exists():
            return p
    # Prüfe GOOGLE_APPLICATION_CREDENTIALS env var
    env_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if env_path and Path(env_path).exists():
        return Path(env_path)
    return None

def load_credentials_from_env() -> Optional[Dict[str, Any]]:
    """
    Versucht Credentials aus Umgebungsvariablen zu laden.
    Unterstützt:
    - GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (JSON Inhalt als String)
    - GOOGLE_DRIVE_CREDENTIALS (Pfad oder JSON)
    - GOOGLE_APPLICATION_CREDENTIALS (Pfad)
    - GOOGLE_DRIVE_TOKEN (OAuth Token JSON)
    """
    # 1. Direkter JSON Inhalt
    json_content = os.getenv("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON")
    if json_content:
        try:
            return json.loads(json_content)
        except:
            # Könnte auch ein Pfad sein
            if Path(json_content).exists():
                try:
                    with open(json_content, 'r') as f:
                        return json.load(f)
                except:
                    pass

    # 2. GOOGLE_DRIVE_CREDENTIALS
    creds_env = os.getenv("GOOGLE_DRIVE_CREDENTIALS")
    if creds_env:
        try:
            # Versuche als JSON zu parsen
            return json.loads(creds_env)
        except:
            # Versuche als Pfad
            if Path(creds_env).exists():
                try:
                    with open(creds_env, 'r') as f:
                        return json.load(f)
                except:
                    pass

    # 3. Datei-basiert über GOOGLE_APPLICATION_CREDENTIALS
    gac_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if gac_path and Path(gac_path).exists():
        try:
            with open(gac_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Config] Fehler beim Laden von GOOGLE_APPLICATION_CREDENTIALS: {e}")

    # 4. Token aus Datei
    cred_file = find_credentials_file()
    if cred_file:
        try:
            with open(cred_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                print(f"[Config] Credentials gefunden: {cred_file}")
                return data
        except Exception as e:
            print(f"[Config] Fehler beim Laden von {cred_file}: {e}")

    return None

def has_valid_credentials() -> bool:
    """Prüft ob gültige Credentials verfügbar sind (ohne Exception)"""
    # Mock Modus ist auch "gültig" für Dev
    if os.getenv("USE_MOCK_DRIVE", "").lower() in ("1", "true", "yes"):
        return True
    
    config = load_config()
    if config.get("cloud", {}).get("use_mock_drive"):
        return True

    creds = load_credentials_from_env()
    if creds:
        return True
    
    # Prüfe ob token.json oder credentials.json existiert
    if find_credentials_file():
        return True
    
    return False

def get_credentials_or_raise():
    """Gibt Credentials zurück oder wirft MissingCredentialsError"""
    if os.getenv("USE_MOCK_DRIVE", "").lower() in ("1", "true", "yes"):
        return {"mock": True}
    
    config = load_config()
    if config.get("cloud", {}).get("use_mock_drive"):
        return {"mock": True}

    creds = load_credentials_from_env()
    if creds:
        return creds
    
    raise MissingCredentialsError(
        "Keine Google Drive Credentials gefunden!\n\n"
        "Bitte hinterlege Credentials auf einem der folgenden Wege:\n"
        "- Datei: ./credentials.json oder ./service_account.json\n"
        "- Datei: ~/.config/audio_editor/credentials.json\n"
        "- Env Var: GOOGLE_APPLICATION_CREDENTIALS=/pfad/zu/service_account.json\n"
        "- Env Var: GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON='{...json...}'\n"
        "- Oder setze USE_MOCK_DRIVE=1 für lokale Entwicklung ohne Cloud\n\n"
        "Siehe .env.example und config.json.example"
    )

def load_config() -> Dict[str, Any]:
    """Lädt Konfiguration aus Datei oder gibt Defaults zurück"""
    cfg = DEFAULT_CONFIG.copy()
    # Deep copy für cloud dict
    cfg["cloud"] = DEFAULT_CONFIG["cloud"].copy()
    
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
                # Merge top-level
                for k, v in user_config.items():
                    if k == "cloud" and isinstance(v, dict):
                        cfg["cloud"].update(v)
                    else:
                        cfg[k] = v
        except Exception as e:
            print(f"[Config] Fehler beim Laden von config.json: {e}")

    # Env-Overrides für Cloud
    webhook = os.getenv("COLAB_WEBHOOK_URL")
    if webhook:
        cfg["cloud"]["colab_webhook_url"] = webhook

    use_mock = os.getenv("USE_MOCK_DRIVE")
    if use_mock is not None:
        cfg["cloud"]["use_mock_drive"] = use_mock.lower() in ("1", "true", "yes")

    return cfg

def get_app_dirs():
    """Gibt wichtige App-Verzeichnisse zurück"""
    return {
        "base": BASE_DIR,
        "data": DATA_DIR,
        "db": DB_PATH,
        "stems": STEMS_DIR,
        "temp": TEMP_DIR,
        "mock_drive": MOCK_DRIVE_DIR
    }

def get_drive_folders():
    cfg = load_config()
    cloud_cfg = cfg.get("cloud", {})
    return {
        "base": cloud_cfg.get("drive_base_folder", DRIVE_BASE_FOLDER),
        "input": cloud_cfg.get("drive_input_folder", DRIVE_INPUT_FOLDER),
        "output": cloud_cfg.get("drive_output_folder", DRIVE_OUTPUT_FOLDER)
    }

# Geladene Config
CONFIG = load_config()
