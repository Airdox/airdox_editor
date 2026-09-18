# Google Colab Setup für AudioEditor Stem Separation

Diese Anleitung beschreibt wie der vollautomatisierte Workflow zwischen Desktop-App und Google Colab eingerichtet wird.

## Architektur Überblick

```
[Desktop App - Deck A/B]
    |
    | 1. Temporäre Arbeitskopie
    | 2. Upload zu Google Drive /AudioEditor_Stems/Input/
    | 3. Erstellt _TRIGGER_<Track_ID>.json
    v
[Google Drive]
    |
    | 4. Colab Notebook beobachtet Input Ordner (Drive Watcher)
    |    - Erkennt neue Trigger-Dateien
    |    - Lädt htdemucs Modell (GPU)
    v
[Google Colab - GPU Instance]
    |
    | 5. Separation mit htdemucs
    |    - Modell: Hybrid Transformer Demucs
    |    - Gewichte: Offiziell via demucs Bibliothek
    |    - GPU zwingend
    | 6. Speichert nach /AudioEditor_Stems/Output/<Track_ID>/
    |    - drums.wav, bass.wav, other.wav, vocals.wav
    |    - status.json, DONE Marker
    v
[Google Drive]
    |
    | 7. Desktop App pollt alle 15s ob Output bereit
    | 8. Download nach data/stems/<Track_ID>/
    | 9. Verknüpfung in SQLite DB
    | 10. Pop-up: "Alles klar, die Stems sind nun verfügbar."
    v
[Desktop App]
```

## Schritt 1: Google Cloud Projekt & Credentials

### Option A: Service Account (empfohlen für Automatisierung)

1. Gehe zu https://console.cloud.google.com
2. Erstelle neues Projekt oder wähle bestehendes
3. Aktiviere Google Drive API
4. Gehe zu IAM & Admin -> Service Accounts
5. Erstelle Service Account mit Rolle "Editor" oder custom mit Drive Zugriff
6. Erstelle Key (JSON) und lade herunter
7. Speichere als `service_account.json` im Projekt-Root oder `~/.config/audio_editor/`
8. Wichtig: Teile den Drive Ordner `AudioEditor_Stems` mit der Service Account Email (aus JSON)

### Option B: OAuth (für persönlichen Drive)

1. In Cloud Console -> APIs & Services -> Credentials
2. OAuth Consent Screen konfigurieren
3. OAuth Client ID erstellen (Desktop App)
4. Lade `credentials.json` herunter
5. Beim ersten Start wird OAuth Flow im Browser geöffnet
6. Token wird als `token.json` gespeichert

### Speichern der Credentials

Die App sucht automatisch an folgenden Orten:
- `./credentials.json`
- `./service_account.json`
- `./token.json`
- `~/.config/audio_editor/credentials.json`
- `~/.config/audio_editor/service_account.json`
- Env Var `GOOGLE_APPLICATION_CREDENTIALS=/pfad/zu/json`
- Env Var `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON='{"type":...}'`

Nur wenn keine Credentials gefunden werden, fragt die App explizit nach.

## Schritt 2: Colab Notebook einrichten

### Notebook aus Repo

Das Repo enthält `audio_editor/colab/colab_notebook.ipynb` - lade diese Datei direkt in Colab hoch.

### Manuelles Notebook erstellen

Falls du manuell erstellen willst:

#### Zelle 1: Drive mounten
```python
from google.colab import drive
drive.mount('/content/drive')
```

#### Zelle 2: GPU prüfen (zwingend!)
```python
import torch
print(f"CUDA verfügbar: {torch.cuda.is_available()}")
print(f"GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'Keine GPU!'}")
assert torch.cuda.is_available(), "Bitte GPU aktivieren: Laufzeit -> Laufzeittyp ändern -> GPU"
```

#### Zelle 3: Dependencies installieren
```python
!pip install -q demucs torch torchaudio
```

#### Zelle 4: Processor Code (aus Repo kopieren)
Kopiere `audio_editor/colab/demucs_processor.py` in Colab oder:

```python
# Falls du das Repo in Drive hast
import sys
sys.path.append('/content/drive/MyDrive/AudioEditor_Stems/repo')

from pathlib import Path
from audio_editor.colab.demucs_processor import DemucsProcessor, check_gpu

check_gpu()
```

#### Zelle 5: Watcher starten (Hauptautomatisierung)
```python
processor = DemucsProcessor(
    output_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Output")
)

processor.watch_and_process(
    input_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Input"),
    poll_interval=10
)
```

Dieser Watcher läuft endlos und:
- Beobachtet `/MyDrive/AudioEditor_Stems/Input/` auf `_TRIGGER_*.json`
- Verarbeitet neue Tracks automatisch mit htdemucs GPU
- Speichert nach `/MyDrive/AudioEditor_Stems/Output/<Track_ID>/`

### Modell Details

- **Modell**: `htdemucs` (Hybrid Transformer Demucs)
- **Laden**: `from demucs.pretrained import get_model; get_model('htdemucs')`
- **Gewichte**: Automatisch über PyTorch Hub / demucs Bibliothek, keine manuellen Links
- **Hardware**: GPU zwingend (Colab T4, V100, A100)
- **Stems**: drums, bass, other, vocals
- **Output**: WAV Dateien + status.json + DONE Marker

## Schritt 3: Desktop App nutzen

1. Starte App: `python -m audio_editor.main`
2. Lade Track in Deck A oder B
3. Klicke Button "Externe Stems berechnen" im jeweiligen Deck
4. App zeigt Fortschritt:
   - Temporäre Kopie erstellen
   - Upload zu Drive
   - Trigger Colab
   - Polling auf Ergebnisse
   - Download & Verknüpfung
5. Bei Erfolg: Pop-up "Alles klar, die Stems sind nun verfügbar."

## Automatisierung ohne manuellen Colab Start

### Option A: Colab manuell laufen lassen (einfachste)
- Starte Notebook einmal und lasse Watcher laufen
- Colab bleibt ~12h aktiv (mit Pro länger)
- Für Hobby-Nutzung ausreichend

### Option B: Colab Pro Scheduled Execution
- Colab Pro erlaubt Scheduled Notebooks
- Notebook alle Stunde starten lassen
- Watcher prüft dann ob neue Jobs da sind

### Option C: Webhook + kleiner Server
- Setze `COLAB_WEBHOOK_URL` in config
- Kleiner Flask/FastAPI Server empfängt Webhook von Desktop App
- Server triggert Colab via Colab API oder startet Processing selbst
- Beispiel Server in `audio_editor/cloud/colab_trigger.py` Dokumentation

### Option D: Google Cloud Function
- Cloud Function die auf Drive Änderungen reagiert (Drive API Watch)
- Triggert Colab oder führt Demucs selbst auf Cloud Run mit GPU aus

Für diese Implementierung wurde **Option A (Drive Watcher)** als Hauptstrategie gewählt, da sie:
- Keine extra Server benötigt
- Vollständig über Drive funktioniert
- Einfach zu verstehen und zu debuggen ist
- Der Spec entspricht ("Google Drive API Watcher")

## Mock Modus für Entwicklung

Ohne echte Google Credentials:

```bash
export USE_MOCK_DRIVE=1
python -m audio_editor.main
```

Oder in `config.json`:
```json
{
  "cloud": {
    "use_mock_drive": true
  }
}
```

Oder im Credentials Dialog "Mock-Modus" wählen.

Dann:
- Uploads gehen nach `data/mock_drive/AudioEditor_Stems/Input/`
- Colab Simulation via `MockDriveClient.simulate_colab_processing()`
- Keine echten Cloud Calls
- Ideal für UI Entwicklung und Tests

## Troubleshooting

### Keine GPU in Colab
Lösung: Laufzeit -> Laufzeittyp ändern -> Hardwarebeschleuniger GPU

### Drive Ordner nicht gefunden
Lösung: App erstellt Ordner automatisch beim ersten Upload. Prüfe ob Drive gemountet ist.

### Timeout nach 1 Stunde
Lösung: 
- Prüfe ob Colab Watcher läuft
- Prüfe ob Trigger-Datei in Input liegt
- Erhöhe `poll_timeout` in config (3600s default)
- Für sehr lange Tracks: Demucs braucht Zeit, GPU prüfen

### Credentials Fehler
Lösung:
- Prüfe ob `service_account.json` im richtigen Pfad liegt
- Prüfe ob Drive Ordner mit Service Account Email geteilt wurde
- Nutze Mock Modus für Tests

### Stems werden nicht verknüpft
Lösung:
- Prüfe `data/stems/<Track_ID>/` ob Dateien vorhanden
- Prüfe SQLite DB `data/audio_editor.db` Tabelle `stems`
- Logs in App beachten

## Sicherheit

- Teile Service Account nur mit nötigen Ordnern, nicht gesamtem Drive
- Nutze .gitignore für credentials.json, token.json
- Für Produktion: Verwende Secret Manager statt Env Vars
- Mock Modus für öffentliche Demos ohne Credentials Leaks

## Weiterführende Links

- Demucs: https://github.com/facebookresearch/demucs
- Google Drive API: https://developers.google.com/drive/api/v3
- Colab GPU: https://colab.research.google.com/notebooks/gpu.ipynb
