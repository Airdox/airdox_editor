# Airdox SMART Editor - Cloud Stem Separation

**Basis:** Bestehender Electron + React + TypeScript Editor (main Branch)  
**Feature Branch:** `feature/colab-stem-separation`  
**Neues Feature:** Automatisierte, cloudbasierte Quellentrennung per Button-Klick

Dies ist die Integration des Cloud Workflows in den bestehenden Airdox Editor. Der bestehende Editor bleibt Basis, der neue Workflow erweitert ihn.

## 🎯 Bestehender Editor (Basis - main)

Der bestehende Editor ist ein professioneller DJ-Audio-Editor:

- **Tech Stack:** Electron, React 19, TypeScript, Vite, Tailwind
- **Features:**
  - Rekordbox Import (XML, ANLZ, Database)
  - Waveform Analyse (Detail, Overview, Clip Deck)
  - Stem Separation lokal (ONNX, BSROFormer, Demucs)
  - Audio Engine, Editing Engine, Mix Analyse
  - Deck Ansicht: ClipDeckView, DeckStemsControl
  - Electron Windows Build (NSIS Setup)

Siehe `package.json`, `src/App.tsx`, `src/components/DeckStemsControl.tsx`, `src/components/ClipDeckView.tsx`

## 🚀 Neues Feature: Cloud Stem Separation (Feature Branch)

Dieses Feature ermöglicht **vollautomatisierte Stem-Separation direkt aus dem Editor heraus** via Google Drive + Colab GPU:

### Workflow

1. **Button in Deck-Ansicht:** „Externe Stems berechnen“ bezieht sich strikt auf den aktuell geladenen Track im jeweiligen Deck
2. **Lokale Aufbereitung:** Automatische temporäre Arbeitskopie, Hintergrund-Worker (GUI friert nie ein)
3. **Cloud Upload:** Automatischer Upload zu Google Drive `/AudioEditor_Stems/Input/`
4. **Colab Trigger:** Automatisches Triggern von Google Colab via Drive Watcher / Webhook
5. **GPU Verarbeitung:** `htdemucs` Modell (Hybrid Transformer Demucs) auf Colab GPU
6. **Download & Verknüpfung:** Polling, automatischer Download, DB-Verknüpfung, Pop-up „Alles klar, die Stems sind nun verfügbar.“

### Architektur

```
[Electron Deck A/B - Track geladen]  (bestehender Editor)
    |
    | Click "Externe Stems berechnen" (neu in DeckStemsControl.tsx + Python)
    v
[Worker Thread - QThread / Node Worker]
    |---> Temporäre Kopie (data/temp/ oder python/temp/)
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
    |---> Download nach data/stems/<Track_ID>/ oder resources/stems/
    |---> StemManager.link_downloaded_stems()
    |---> DB Verknüpfung (tracks <-> stems)
    v
[UI Pop-up]
    "Alles klar, die Stems sind nun verfügbar."
```

## 📁 Projekt Struktur (nach Merge)

```
# Bestehender Electron Editor (main)
src/
  App.tsx, main.tsx
  components/
    ClipDeckView.tsx          # Deck Ansicht (Basis)
    DeckStemsControl.tsx      # Stems Control (Basis) + NEU: Cloud Button
    DetailWaveform.tsx, etc.
  audio/
    stemEngine.ts, audioEngine.ts, etc.
  stems/
    modelManager.ts, backends/, etc.
electron/
  main.cjs, stemEngineBridge.cjs, etc.
python/
  bsroformer_inference.py, install_bsroformer.py
colab/
  airdox-stem-gate.ipynb, airdox-stem-gate.md
resources/
  stem-runtime/, models/

# Neues Python Cloud Feature (feature Branch)
audio_editor/                 # NEU: Python Desktop App (parallel zu Electron)
  __init__.py
  main.py                     # PySide6 GUI mit Deck A/B
  deck.py                     # Deck Widget mit "Externe Stems berechnen"
  player.py, database.py, config.py, utils.py
  stem_manager.py
  cloud/
    drive_client.py           # GoogleDriveClient + MockDriveClient
    colab_trigger.py          # Trigger Logik
    worker.py                 # QThread Worker
  colab/
    demucs_processor.py       # htdemucs GPU Verarbeitung
    colab_notebook.ipynb      # Fertiges Colab Notebook
    COLAB_SETUP.md
    colab_notebook.py

# Integration in Electron (neu)
src/components/CloudStemButton.tsx  # NEU: React Button für Cloud Stems (geplant)
src/hooks/useCloudStems.ts          # NEU: Hook für Cloud Workflow

# Tests & CI/CD
tests/                        # NEU: 68 Tests
  test_existing_editor.py     # Basis bleibt erhalten
  test_deck_integration.py    # Workflow Integration
  test_config.py, test_database.py, etc.
.github/workflows/
  windows-build.yml           # Bestehend: Electron Windows Build
  ci.yml                      # NEU: Tests + Build
  release.yml                 # NEU: Auto Release bei Push

# Config
.env.example                  # Erweitert: Gemini + Google Drive
requirements.txt              # Python Deps
package.json                  # Node Deps (bestehend)
```

## 🔧 Installation

### Bestehender Electron Editor (main)

```bash
npm ci
npm run dev          # Dev Server
npm run desktop      # Electron
npm run package:win  # Windows EXE
```

### Neues Python Cloud Feature (Feature Branch)

```bash
# Python Dependencies
pip install -r requirements.txt

# Für echte Cloud: Credentials
cp service_account.json.example ./service_account.json
# Oder Env Var
export GOOGLE_APPLICATION_CREDENTIALS=/pfad/zu/service_account.json

# App starten (PySide6)
python -m audio_editor.main
# Oder Mock Modus ohne Credentials
USE_MOCK_DRIVE=1 python -m audio_editor.main
```

### Integration: Electron + Python Cloud

Der neue Workflow kann sowohl:
- In Python App `audio_editor/main.py` getestet werden (Mock Modus)
- Als auch in Electron via Node Bridge integriert werden:
  ```ts
  // In DeckStemsControl.tsx
  // Button "Externe Stems berechnen" -> ruft python/cloud/worker via IPC
  ```

## 🔐 Authentifizierung

Auto-Discovery (laut Spec):

1. `USE_MOCK_DRIVE=1` -> Mock Modus
2. `config.json` -> `cloud.use_mock_drive`
3. Env Vars: `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`
4. Dateien: `./credentials.json`, `./service_account.json`, `~/.config/audio_editor/`
5. Nur wenn keine vorhanden -> Dialog fragt explizit

## 🧪 Tests (68 Tests)

```bash
USE_MOCK_DRIVE=1 pytest tests/ -v
# 68 passed

# Basis bleibt erhalten:
pytest tests/test_existing_editor.py -v
pytest tests/test_deck_integration.py -v
```

- `test_existing_editor.py` (8) – Basis Editor bleibt
- `test_deck_integration.py` (9) – Workflow Integration
- `test_config.py` (11), `test_database.py` (5), `test_stem_manager.py` (10)
- `test_drive_client.py` (9), `test_colab_trigger.py` (7), `test_worker.py` (4), `test_cloud_workflow.py` (4)

## 🚀 CI/CD – Auto Version bei GitHub Push

Bei Push auf `main`, `feature/colab-stem-separation`, Tags `v*`:

- **ci.yml:** Tests auf Python 3.10/3.11/3.12 + Lint + Build Linux + Windows EXE
- **release.yml:** Auto Release
  - Version aus `__init__.py` + commit + timestamp
  - Tag: `v0.2.0-feature-colab-stem-separation-<commit>-<timestamp>`
  - Erstellt GitHub Release mit ZIPs + EXEs automatisch

Siehe `GITHUB_PUSH_GUIDE.md`

## 📦 Windows Release

- `windows_release/AudioEditor-Windows-Portable.zip` – Portable mit BAT Launchern
- `windows_release/build_exe_windows.bat` – Baut echte Windows .exe auf Windows PC
- `dist/AudioEditor/AudioEditor.exe` – Linux Build (Referenz, 57 MB)
- Echte Windows EXE wird via GitHub Actions auf `windows-latest` Runner gebaut

## 📓 Colab Setup

Siehe `audio_editor/colab/COLAB_SETUP.md` und `colab/airdox-stem-gate.md`

Wichtig: In Colab GPU aktivieren!
- Laufzeit -> Laufzeittyp ändern -> GPU (T4/V100/A100)

## 🔄 Workflow Integration in bestehenden Editor

Der bestehende `DeckStemsControl.tsx` hat bereits lokale Stem Separation. Neuer Cloud Button erweitert:

```tsx
// In DeckStemsControl.tsx (geplant)
<button onClick={handleExternalStems}>
  Externe Stems berechnen
</button>
// handleExternalStems -> IPC zu Python cloud/worker.py
// Oder direkt via Google Drive API in TypeScript
```

Python Implementierung bleibt als Referenz und für Tests, kann via `electron/stemEngineBridge.cjs` in Electron integriert werden.

## 📝 Lizenz

MIT
