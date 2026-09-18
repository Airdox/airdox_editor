@echo off
echo === AudioEditor - Mock Modus (ohne Google Drive) ===
echo Ideal zum Testen ohne Credentials
echo.

REM Setze Mock Modus
set USE_MOCK_DRIVE=1
echo Mock Modus aktiv: USE_MOCK_DRIVE=1
echo Mock Drive Verzeichnis: data\mock_drive\AudioEditor_Stems\
echo.

REM Prüfe EXE
if exist "dist\AudioEditor\AudioEditor.exe" (
    echo Starte EXE im Mock Modus...
    start "" "dist\AudioEditor\AudioEditor.exe"
    exit /b 0
)

if exist "AudioEditor.exe" (
    echo Starte EXE im Mock Modus...
    start "" "AudioEditor.exe"
    exit /b 0
)

REM Python Fallback
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo FEHLER: Python nicht gefunden!
    pause
    exit /b 1
)

pip install -r requirements.txt --quiet

echo Starte App im Mock Modus...
echo.
echo Test Ablauf:
echo 1. Track laden in Deck A/B
echo 2. Button "Externe Stems berechnen" klicken
echo 3. Fortschritt beobachten (Upload, Trigger, Download)
echo 4. Pop-up "Alles klar, die Stems sind nun verfügbar."
echo.
python -m audio_editor.main

pause
