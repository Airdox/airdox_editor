# AudioEditor - Windows Release
Branch: feature/colab-stem-separation

## Hinweis zum Build

Im Linux Sandbox konnte kein natives Windows PE .exe gebaut werden (PyInstaller kann nicht cross-compilieren ohne Wine/Windows VM).
Deshalb enthält dieses Release:

1. **Linux Build (für Referenz)** in `dist/AudioEditor/` - 57 MB, ELF Binary
2. **Portable Windows Package** das auf Windows mit Python 3.10+ sofort läuft (Batch Launcher)
3. **Build Script** `build_exe_windows.bat` um auf Windows echte .exe zu bauen
4. **Anleitung** für Windows

## Option A: Portable auf Windows starten (ohne .exe Build, sofort testen)

Voraussetzung: Python 3.10+ installiert (https://python.org) und "Add to PATH" aktiviert.

1. Entpacke `AudioEditor-Windows-Portable.zip` (siehe unten wie erstellt)
2. Doppelklick auf `Run_AudioEditor.bat` oder `Run_AudioEditor_Mock.bat`

Oder manuell:
```bat
cd AudioEditor-Windows-Portable
pip install -r requirements.txt
set USE_MOCK_DRIVE=1
python -m audio_editor.main
```

Das startet die App mit Deck A/B und Button "Externe Stems berechnen".

## Option B: Echte .exe auf Windows bauen (empfohlen für finale Distribution)

Auf einem Windows PC:

```bat
git clone <repo>
cd AudioEditor
# Oder entpacke das Release Zip

# Build Script ausführen (erstellt echte Windows .exe)
build_exe_windows.bat
```

Das Script macht:
- pip install -r requirements.txt
- pip install pyinstaller
- pyinstaller --name AudioEditor --windowed --onedir audio_editor/main.py
- Ergebnis in dist\AudioEditor\AudioEditor.exe

Danach:
- Doppelklick auf `dist\AudioEditor\AudioEditor.exe`
- Oder `dist\AudioEditor\Run_AudioEditor.bat`

## Was du testen kannst (Mock Modus, ohne Google Credentials)

1. App starten (Mock Modus aktiv via USE_MOCK_DRIVE=1)
2. In Deck A: "Track laden" -> wähle MP3/WAV
3. Klick "Externe Stems berechnen"
4. Beobachte Fortschritt:
   - Temporäre Kopie
   - Upload zu Mock Drive (data/mock_drive/)
   - Trigger
   - Simuliertes Colab Processing (kopiert Track 4x als Stems)
   - Download nach data/stems/<Track_ID>/
   - Pop-up: "Alles klar, die Stems sind nun verfügbar."
5. Stems Liste erscheint im Deck

## Echte Cloud Nutzung auf Windows

1. Google Cloud Projekt erstellen, Drive API aktivieren
2. Service Account JSON herunterladen
3. Als `service_account.json` in App Verzeichnis legen
   ODER Env Var setzen:
   ```bat
   set GOOGLE_APPLICATION_CREDENTIALS=C:\pfad\zu\service_account.json
   ```
4. Drive Ordner `AudioEditor_Stems` mit Service Account Email teilen
5. Colab Notebook `audio_editor/colab/colab_notebook.ipynb` in Colab öffnen
   - GPU aktivieren: Laufzeit -> Laufzeittyp ändern -> GPU
   - Watcher starten
6. In App: Track laden, "Externe Stems berechnen"
7. Colab verarbeitet mit htdemucs GPU, speichert nach Output/<Track_ID>/
8. App lädt automatisch herunter

## Dateien im Release

- `AudioEditor/` - Source Code (feature Branch)
- `dist/AudioEditor/` - Linux Build (Referenz, 57 MB)
- `Run_AudioEditor.bat` - Windows Launcher
- `Run_AudioEditor_Mock.bat` - Launcher mit Mock Modus
- `build_exe_windows.bat` - Build Script für echte Windows .exe
- `requirements.txt`
- `audio_editor/colab/colab_notebook.ipynb` - Colab Notebook
- `audio_editor/colab/COLAB_SETUP.md` - Setup Anleitung
- `config.json.example`, `.env.example`
- `data/` - Wird automatisch erstellt (DB, Stems, Temp, Mock Drive)

## Troubleshooting Windows

- **PySide6 Fehler**: `pip install --upgrade PySide6`
- **Kein Python gefunden**: Python von python.org installieren, "Add to PATH" ankreuzen
- **Antivirus blockiert .exe**: Ausnahme hinzufügen (PyInstaller Exes werden manchmal als False Positive erkannt)
- **Mock Modus**: Immer mit `USE_MOCK_DRIVE=1` testen wenn keine Credentials vorhanden

## Technische Details

- Python: 3.10+ empfohlen (getestet mit 3.13)
- GUI: PySide6 (Qt6)
- Cloud: google-api-python-client, google-auth
- Colab: torch, torchaudio, demucs (nur in Colab, nicht im Desktop Build)
- DB: SQLite (builtin)
- Größe: ~60 MB (onedir) oder ~150 MB (onefile mit PySide6)

## Lizenz

MIT
