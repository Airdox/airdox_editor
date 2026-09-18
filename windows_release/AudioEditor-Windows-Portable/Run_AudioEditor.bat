@echo off
echo === AudioEditor - Cloud Stem Separation ===
echo Branch: feature/colab-stem-separation
echo.

REM Prüfe ob EXE existiert (echter Windows Build)
if exist "dist\AudioEditor\AudioEditor.exe" (
    echo Starte kompilierte EXE: dist\AudioEditor\AudioEditor.exe
    start "" "dist\AudioEditor\AudioEditor.exe"
    exit /b 0
)

REM Prüfe ob im dist Ordner direkt
if exist "AudioEditor.exe" (
    echo Starte EXE: AudioEditor.exe
    start "" "AudioEditor.exe"
    exit /b 0
)

REM Fallback: Python direkt
echo Keine EXE gefunden, starte via Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo FEHLER: Python nicht gefunden! Bitte installieren von https://python.org
    echo Und "Add Python to PATH" ankreuzen.
    pause
    exit /b 1
)

echo Installiere Dependencies falls nötig...
pip install -r requirements.txt --quiet

echo Starte App...
python -m audio_editor.main

if %errorlevel% neq 0 (
    echo.
    echo FEHLER beim Start! Versuche mit Mock Modus...
    set USE_MOCK_DRIVE=1
    python -m audio_editor.main
    pause
)
