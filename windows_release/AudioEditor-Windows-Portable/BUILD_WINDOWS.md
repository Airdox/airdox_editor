# Windows EXE Build Anleitung

## Warum kein fertiges .exe im Linux Build?

PyInstaller kann NICHT cross-compilieren:
- Linux Build -> Linux ELF Binary (was wir im Sandbox gebaut haben: 57 MB)
- Windows Build -> Windows PE .exe (muss auf Windows gebaut werden)

Deshalb: Auf Windows PC das Build Script ausführen.

## Schnellstart auf Windows

1. Python 3.10+ installieren von https://python.org
   - Haken bei "Add Python to PATH"

2. Repo entpacken / klonen

3. Doppelklick auf `build_exe_windows.bat`

4. Nach 2-5 Minuten: `dist/AudioEditor/AudioEditor.exe` ist fertig

5. Testen: Doppelklick auf `dist/AudioEditor/AudioEditor.exe` oder `Run_AudioEditor_Mock.bat`

## Manueller Build

```bat
pip install -r requirements.txt
pip install pyinstaller

pyinstaller --name=AudioEditor --windowed --onedir ^
    --collect-all=PySide6 --collect-all=shiboken6 ^
    --hidden-import=googleapiclient --hidden-import=google.auth ^
    --exclude-module=torch --exclude-module=torchaudio --exclude-module=demucs ^
    audio_editor/main.py
```

Ergebnis: `dist/AudioEditor/` Ordner mit .exe und _internal/

## OneFile Build (einzelne .exe, größer)

```bat
pyinstaller --name=AudioEditor --windowed --onefile ^
    --collect-all=PySide6 --collect-all=shiboken6 ^
    audio_editor/main.py
```

Ergebnis: `dist/AudioEditor.exe` ~150 MB (alles in einer Datei)

## Distribution

Für Weitergabe:

```bat
:: Mit 7-Zip oder Windows Explorer zippen
7z a AudioEditor-Windows-v0.2.0.zip dist\AudioEditor\

:: Oder portable ZIP ohne EXE (benötigt Python auf Ziel-PC)
7z a AudioEditor-Windows-Portable.zip ^
    audio_editor\ requirements.txt ^
    Run_AudioEditor.bat Run_AudioEditor_Mock.bat ^
    README.md config.json.example .env.example ^
    audio_editor\colab\
```

## Troubleshooting

- **Antivirus meckert**: PyInstaller EXEs werden manchmal als False Positive erkannt. Ausnahme hinzufügen oder Code signieren.
- **MSVCR DLL fehlt**: Visual C++ Redistributable installieren
- **PySide6 Fehler**: `pip install --upgrade PySide6 shiboken6`
- **Schwarzes Fenster**: --windowed entfernt Konsole, für Debugging ohne --windowed bauen
- **Zu groß**: --onedir ist kleiner und schneller beim Start als --onefile

## Alternative: cx_Freeze, Nuitka, Briefcase

- Nuitka: Kompiliert zu echter C EXE, noch kleiner/schneller, aber komplexer
- Briefcase: Für Multi-Platform (Windows, macOS, Linux)
- Für diesen Task reicht PyInstaller
