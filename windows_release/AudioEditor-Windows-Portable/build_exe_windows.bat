@echo off
echo === AudioEditor Windows EXE Build ===
echo Branch: feature/colab-stem-separation
echo.

REM Prüfe Python
python --version
if %errorlevel% neq 0 (
    echo FEHLER: Python nicht gefunden! Bitte von python.org installieren und "Add to PATH" ankreuzen.
    pause
    exit /b 1
)

echo.
echo === Installiere Dependencies ===
pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller

echo.
echo === Clean alte Builds ===
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist AudioEditor.spec del AudioEditor.spec

echo.
echo === Baue Windows EXE (dauert 2-5 Minuten) ===
echo PyInstaller mit PySide6, onedir, windowed...

pyinstaller ^
    --name=AudioEditor ^
    --windowed ^
    --onedir ^
    --clean ^
    --noconfirm ^
    --collect-all=PySide6 ^
    --collect-all=shiboken6 ^
    --hidden-import=googleapiclient ^
    --hidden-import=google.auth ^
    --hidden-import=google.oauth2 ^
    --hidden-import=requests ^
    --exclude-module=torch ^
    --exclude-module=torchaudio ^
    --exclude-module=demucs ^
    audio_editor/main.py

if %errorlevel% neq 0 (
    echo FEHLER beim Build!
    pause
    exit /b 1
)

echo.
echo === Build erfolgreich ===
echo EXE liegt in: dist\AudioEditor\AudioEditor.exe
dir dist\AudioEditor\AudioEditor.exe

echo.
echo === Erstelle Launcher BATs in dist ===
echo @echo off > dist\AudioEditor\Run_AudioEditor.bat
echo echo Starte AudioEditor... >> dist\AudioEditor\Run_AudioEditor.bat
echo start "" "AudioEditor.exe" >> dist\AudioEditor\Run_AudioEditor.bat

echo @echo off > dist\AudioEditor\Run_AudioEditor_Mock.bat
echo echo Starte AudioEditor im Mock Modus (ohne Google Drive)... >> dist\AudioEditor\Run_AudioEditor_Mock.bat
echo set USE_MOCK_DRIVE=1 >> dist\AudioEditor\Run_AudioEditor_Mock.bat
echo start "" "AudioEditor.exe" >> dist\AudioEditor\Run_AudioEditor_Mock.bat

echo @echo off > dist\AudioEditor\Run_AudioEditor_Debug.bat
echo echo Starte AudioEditor mit Konsole fuer Debugging... >> dist\AudioEditor\Run_AudioEditor_Debug.bat
echo AudioEditor.exe --debug >> dist\AudioEditor\Run_AudioEditor_Debug.bat
echo pause >> dist\AudioEditor\Run_AudioEditor_Debug.bat

echo.
echo === Kopiere Zusatzdateien ===
copy README.md dist\AudioEditor\ 2>nul
copy config.json.example dist\AudioEditor\ 2>nul
copy .env.example dist\AudioEditor\ 2>nul
xcopy audio_editor\colab dist\AudioEditor\colab\ /E /I /Y 2>nul

echo.
echo === Fertig! ===
echo Du kannst jetzt testen:
echo   dist\AudioEditor\AudioEditor.exe
echo   dist\AudioEditor\Run_AudioEditor_Mock.bat
echo.
echo Fuer ZIP Release:
echo   7z a AudioEditor-Windows-v0.2.0.zip dist\AudioEditor\
echo.
pause
