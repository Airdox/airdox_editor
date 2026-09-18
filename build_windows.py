"""
Build Script für Windows Executable
Erstellt AudioEditor.exe mit PyInstaller
"""
import os
import sys
import shutil
from pathlib import Path
import PyInstaller.__main__

BASE_DIR = Path(__file__).parent
MAIN_PY = BASE_DIR / "audio_editor" / "main.py"

# Clean previous builds
for d in ["build", "dist"]:
    p = BASE_DIR / d
    if p.exists():
        shutil.rmtree(p, ignore_errors=True)
        print(f"Cleaned {p}")

# PyInstaller args
# --onedir ist stabiler für PySide6 als --onefile
# --windowed = kein Konsolenfenster auf Windows
# --name = Name der Exe
# --add-data = zusätzliche Daten (falls nötig)
# --hidden-import = falls PyInstaller Imports nicht erkennt

args = [
    str(MAIN_PY),
    "--name=AudioEditor",
    "--windowed",
    "--onedir",
    "--clean",
    "--noconfirm",
    # Icon falls vorhanden, sonst weglassen
    # "--icon=assets/icon.ico",
    # Hidden imports für Cloud Feature
    "--hidden-import=googleapiclient",
    "--hidden-import=google.auth",
    "--hidden-import=google.oauth2",
    "--hidden-import=googleapiclient.discovery",
    "--hidden-import=requests",
    "--hidden-import=PySide6.QtCore",
    "--hidden-import=PySide6.QtWidgets",
    "--hidden-import=PySide6.QtGui",
    # Collect all für PySide6
    "--collect-all=PySide6",
    "--collect-all=shiboken6",
    # Exclude große ML libs die nur in Colab gebraucht werden
    "--exclude-module=torch",
    "--exclude-module=torchaudio",
    "--exclude-module=demucs",
    # Pfade
    f"--paths={BASE_DIR}",
]

print("=== PyInstaller Args ===")
print(" ".join(args))
print("\n=== Starte Build (dauert 2-4 Minuten) ===")

PyInstaller.__main__.run(args)

print("\n=== Build abgeschlossen ===")
dist_dir = BASE_DIR / "dist" / "AudioEditor"
if dist_dir.exists():
    print(f"Dist Verzeichnis: {dist_dir}")
    print(f"Inhalt: {list(dist_dir.iterdir())[:20]}")
    # Größe
    total_size = sum(f.stat().st_size for f in dist_dir.rglob("*") if f.is_file()) / 1024 / 1024
    print(f"Gesamtgröße: {total_size:.1f} MB")
else:
    print("Dist Verzeichnis nicht gefunden!")
    print(f"Dist root: {list((BASE_DIR / 'dist').iterdir()) if (BASE_DIR / 'dist').exists() else 'nicht vorhanden'}")

