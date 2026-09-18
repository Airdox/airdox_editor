# Local Audio Editor - Cloud Stem Separation Feature

**Branch:** `feature/colab-stem-separation`  
**Basis:** `main` Branch mit Deck-Ansicht  
**Feature:** Automatisierte, cloudbasierte Quellentrennung per Button-Klick

## 🎯 Feature Überblick

Dieses Feature ermöglicht die **vollautomatisierte Stem-Separation direkt aus dem Audio-Editor heraus**:

1. **Button in Deck-Ansicht**: „Externe Stems berechnen“ bezieht sich strikt auf den aktuell geladenen Track im jeweiligen Deck
2. **Lokale Aufbereitung**: Automatische temporäre Arbeitskopie, Hintergrund-Worker (GUI friert nie ein)
3. **Cloud Upload**: Automatischer Upload zu Google Drive `/AudioEditor_Stems/Input/`
4. **Colab Trigger**: Automatisches Triggern von Google Colab via Drive Watcher / Webhook
5. **GPU Verarbeitung**: `htdemucs` Modell (Hybrid Transformer Demucs) auf Colab GPU
6. **Download & Verknüpfung**: Polling, automatischer Download, DB-Verknüpfung, Pop-up „Alles klar, die Stems sind nun verfügbar.“

## 🏗️ Architektur

```
[Deck A/B - Track geladen]
    |
    | Click "Externe Stems berechnen"
    v
[Worker Thread - QThread]
    |---> Temporäre Kopie (data/temp/)
    |---> GoogleDriveClient.upload_track() -> /AudioEditor_Stems/Input/<Track_ID>_file.mp3
    |---> _TRIGGER_<Track_ID>.json erstellen
    |---> ColabTrigger (Drive Watcher + optional Webhook)
    |
    | Polling alle 15s
    v
[Google Drive]
    Input/  <- Uploads
    Output/<Track_ID>/ <- Ergebnisse von Colab

[Google Colab - GPU]
    - drive.mount('/content/drive')
    - torch.cuda.is_available() == True (zwingend)
    - from demucs.pretrained import get_model('htdemucs')
    - Gewichte offiziell via demucs/torchaudio Bibliotheken
    - Output: drums.wav, bass.wav, other.wav, vocals.wav
    - status.json + DONE Marker

[Worker Thread]
    |---> Download nach data/stems/<Track_ID>/
    |---> StemManager.link_downloaded_stems()
    |---> DB Verknüpfung (tracks <-> stems)
    v
[UI Pop-up]
    "Alles klar, die Stems sind nun verfügbar."
```

## 📁 Projekt Struktur (Feature Branch)

```
audio_editor/
  __init__.py
  main.py                 # Hauptfenster mit Cloud Menü
  deck.py                 # Deck Widget mit "Externe Stems berechnen" Button
  player.py               # Audio Player
  database.py             # SQLite mit tracks, stems, cloud_jobs Tabellen
  config.py               # Credentials Handling (auto-discovery)
  utils.py                # Hilfsfunktionen
  stem_manager.py         # NEU: Verwaltung lokaler Stems
  cloud/
    __init__.py
    drive_client.py       # NEU: GoogleDriveClient + MockDriveClient
    colab_trigger.py      # NEU: Trigger Logik (Watcher + Webhook)
    worker.py             # NEU: QThread Worker für Hintergrundprozess
  colab/
    __init__.py
    demucs_processor.py   # NEU: htdemucs GPU Verarbeitung für Colab
    colab_notebook.ipynb  # NEU: Fertiges Colab Notebook
    COLAB_SETUP.md        # NEU: Setup Anleitung

data/
  audio_editor.db         # SQLite DB
  stems/<Track_ID>/       # Heruntergeladene Stems
  temp/                   # Temporäre Kopien
  mock_drive/             # Mock Drive für Entwicklung

requirements.txt          # Erweitert um google-api, requests
.env.example              # NEU: Env Var Beispiel
config.json.example       # NEU: Config Beispiel
```

## 🚀 Installation & Start

```bash
# Dependencies
pip install -r requirements.txt

# Für echte Cloud Nutzung: Credentials hinterlegen
# Option 1: Datei
cp service_account.json.example ./service_account.json
# Oder
cp credentials.json ./credentials.json

# Option 2: Env Var
export GOOGLE_APPLICATION_CREDENTIALS=/pfad/zu/service_account.json

# App starten
python -m audio_editor.main

# Oder Mock Modus für Entwicklung ohne Credentials
USE_MOCK_DRIVE=1 python -m audio_editor.main
```

## 🔐 Authentifizierung

Die App sucht **automatisch** nach Credentials (laut Spec):

1. `USE_MOCK_DRIVE=1` Env Var -> Mock Modus
2. `config.json` -> `cloud.use_mock_drive`
3. Env Vars:
   - `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` (JSON Inhalt)
   - `GOOGLE_DRIVE_CREDENTIALS` (Pfad oder JSON)
   - `GOOGLE_APPLICATION_CREDENTIALS` (Pfad)
4. Dateien:
   - `./credentials.json`
   - `./service_account.json`
   - `./token.json`
   - `~/.config/audio_editor/credentials.json`
   - `~/.config/audio_editor/service_account.json`
   - `~/.audio_editor/credentials.json`

**Nur wenn keine gefunden werden**, fragt die App explizit via Dialog nach.

## 🎛️ UI - Deck Ansicht

Jedes Deck (A/B) hat jetzt:

- **Track laden** (wie vorher)
- **Play/Pause/Stop** (wie vorher)
- **NEU: „Externe Stems berechnen“ Button**
  - Blau hervorgehoben, fett
  - Nur aktiv wenn Track geladen
  - Bezieht sich strikt auf aktuell geladenen Track in diesem Deck
  - Tooltip erklärt Workflow
- **Progress Bar** (sichtbar während Verarbeitung)
- **Status Label** (z.B. „Lade auf Drive hoch...“, „Warte auf Colab...“)
- **Stems Liste** (zeigt verfügbare Stems: drums, bass, other, vocals)

## 🔄 Workflow Details

### Lokale Aufbereitung
```python
# In deck.py on_stem_button_clicked()
track_info = self.get_current_track_info()  # Strikt dieses Deck
temp_copy = create_temp_copy(track_path, temp_dir)  # Arbeitskopie
worker = StemSeparationWorker(track_path, track_id, deck_id)
worker.start()  # QThread -> GUI friert nicht ein
```

### Cloud Upload & Trigger
```python
# drive_client.py
upload_result = drive_client.upload_track(temp_copy, track_id)
# -> /AudioEditor_Stems/Input/<Track_ID>_original.mp3
# -> _TRIGGER_<Track_ID>.json

# colab_trigger.py
trigger_info = colab_trigger.trigger_after_upload(track_id, upload_result, original)
# -> Drive Watcher (Hauptstrategie)
# -> Optional Webhook POST an COLAB_WEBHOOK_URL
```

### Colab GPU Verarbeitung
```python
# colab/demucs_processor.py - Läuft in Colab
import torch
assert torch.cuda.is_available()  # GPU zwingend
from demucs.pretrained import get_model
model = get_model('htdemucs')  # Offizielle Gewichte
model.to('cuda')

# Separation
sources = apply_model(model, wav, device='cuda', split=True, overlap=0.25)

# Speichert nach /MyDrive/AudioEditor_Stems/Output/<Track_ID>/
# drums.wav, bass.wav, other.wav, vocals.wav
# status.json, DONE
```

### Download & Verknüpfung
```python
# worker.py Polling
while not ready:
    is_ready, stems_info = drive_client.check_output_ready(track_id)
    time.sleep(poll_interval)

downloaded = drive_client.download_stems(track_id, local_stem_dir)
stem_manager.link_downloaded_stems(track_id, downloaded)
# -> data/stems/<Track_ID>/
# -> SQLite stems Tabelle

# UI
QMessageBox.information("Alles klar, die Stems sind nun verfügbar.")
```

## 🧪 Mock Modus & Tests

Für Entwicklung ohne echte Google Credentials:

```bash
# Mock Drive aktivieren
export USE_MOCK_DRIVE=1
python -m audio_editor.main

# In App: Cloud -> Mock Drive testen
# Erstellt Dummy Upload, simuliert Colab, prüft Download
```

Mock Drive:
- Speichert in `data/mock_drive/AudioEditor_Stems/`
- `MockDriveClient.simulate_colab_processing(track_id)` kopiert Input 4x als Stems
- Keine echten API Calls
- Ideal für UI Tests

## 📓 Colab Notebook

Siehe `audio_editor/colab/colab_notebook.ipynb` und `COLAB_SETUP.md`

**Wichtig**: In Colab GPU aktivieren!
- Laufzeit -> Laufzeittyp ändern -> Hardwarebeschleuniger: GPU

Notebook Zellen:
1. Drive mounten
2. GPU prüfen (`torch.cuda.is_available()`)
3. `pip install demucs torch torchaudio`
4. DemucsProcessor Klasse (htdemucs)
5. Watcher starten (beobachtet Input Ordner)

## 🔧 Konfiguration

`config.json` (optional):
```json
{
  "cloud": {
    "drive_base_folder": "AudioEditor_Stems",
    "drive_input_folder": "AudioEditor_Stems/Input",
    "drive_output_folder": "AudioEditor_Stems/Output",
    "poll_interval": 15,
    "poll_timeout": 3600,
    "use_mock_drive": false,
    "colab_webhook_url": null
  }
}
```

Env Vars:
- `USE_MOCK_DRIVE=1` -> Mock Modus
- `GOOGLE_APPLICATION_CREDENTIALS=/pfad/zu/json`
- `COLAB_WEBHOOK_URL=https://...`
- `COLAB_WEBHOOK_TOKEN=...`

## 📊 Datenbank

Erweitert um:

**stems Tabelle:**
- id, track_id, stem_type (drums/bass/other/vocals), file_path, file_name, created_at, drive_file_id, local_size

**cloud_jobs Tabelle:**
- id, track_id, status (preparing, uploading, processing, downloading, completed, failed), drive_input_file_id, drive_output_folder_id, created_at, updated_at, error_message

## ✅ Spec Erfüllung

- [x] Button „Externe Stems berechnen“ in Deck-Ansicht
- [x] Bezieht sich strikt auf aktuell geladenen Track im jeweiligen Deck
- [x] Temporäre Arbeitskopie
- [x] Hintergrundprozess/Worker-Thread (GUI friert nicht)
- [x] Upload zu Google Drive `/AudioEditor_Stems/Input/`
- [x] Automatisiertes Triggern von Colab (Drive Watcher + Webhook)
- [x] Keine manuellen Schritte für Nutzer auf Drive/Colab
- [x] GPU Instanz in Colab (zwingend, torch.cuda.is_available())
- [x] Modell htdemucs aus demucs Bibliothek
- [x] Gewichte über offizielle PyTorch/Demucs Bibliotheken (keine manuellen Links)
- [x] Output nach `/AudioEditor_Stems/Output/<Track_ID>/` (drums, bass, other, vocals)
- [x] Polling ob Ergebnisse bereit
- [x] Automatischer Download in lokalen App-Ordner
- [x] Verknüpfung in lokaler DB
- [x] Pop-up „Alles klar, die Stems sind nun verfügbar.“
- [x] Authentifizierung: Auto-Discovery aus System/Config/Env, nur fragen wenn keine vorhanden
- [x] Separater Git Branch `feature/colab-stem-separation`

## 🌿 Git Branches

- `main`: Basis Audio Editor ohne Cloud Feature
- `feature/colab-stem-separation`: Dieses Feature (aktuell)

```bash
git checkout main
python -m audio_editor.main  # Basis ohne Cloud

git checkout feature/colab-stem-separation
python -m audio_editor.main  # Mit Cloud Feature
```

## 📝 Lizenz

MIT
