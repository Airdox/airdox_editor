import os
import subprocess
import sys
import xml.etree.ElementTree as ET

def log(step, msg):
    print(f"\n[SCHRITT {step}] {msg}")
    print("-" * 50)

def step_1_dependencies():
    log(1, "Prüfe und installiere erforderliche Python-Pakete...")
    packages = ["numpy", "librosa", "soundfile", "pyinstaller"]
    for pkg in packages:
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg])
    print("Alle Abhängigkeiten sind bereit.")

def step_2_create_core_modules():
    log(2, "Erstelle / Aktualisiere die Kernmodule (Rekordbox, RGB-Waveforms, Stems)...")
    
    # Rekordbox & Beatgrid Parser Modul
    rekordbox_code = '''"""
Automatisch generierter Rekordbox-Parser für taktgenaues Schneiden und Cues.
"""
import xml.etree.ElementTree as ET

def load_rekordbox_xml(xml_path):
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception as e:
        print(f"Fehler beim Laden der XML: {e}")
        return []

    tracks = []
    for track in root.findall(".//TRACK"):
        track_info = {
            "id": track.get("TrackID"),
            "name": track.get("Name"),
            "artist": track.get("Artist"),
            "bpm": float(track.get("AverageBPM", 120.0)),
            "path": track.get("Location", "").replace("file://localhost", "").replace("%20", " "),
            "cue_points": [],
            "beatgrid": []
        }
        for pos in track.findall("POSITION_MARK"):
            track_info["cue_points"].append({
                "name": pos.get("Name"),
                "start": float(pos.get("Start", 0.0)),
                "type": pos.get("Type")
            })
        for tempo in track.findall("TEMPO"):
            track_info["beatgrid"].append({
                "bpm": float(tempo.get("BPM", 120.0)),
                "time": float(tempo.get("Inizio", 0.0))
            })
        tracks.append(track_info)
    return tracks
'''
    with open("rekordbox_parser.py", "w", encoding="utf-8") as f:
        f.write(rekordbox_code)

    # 3-Band RGB Wellenform Modul
    waveform_code = '''"""
Generierung der 3-Band-RGB-Wellenform (Low, Mid, High) für DJ Airdox Editor.
"""
import numpy as np
import librosa

def generate_3band_rgb_waveform(audio_path, target_width=800):
    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
        
        low_band = np.mean(S[0:24, :], axis=0)
        mid_band = np.mean(S[24:370, :], axis=0)
        high_band = np.mean(S[370:, :], axis=0)
        
        def resample_array(arr, length):
            if len(arr) == 0:
                return np.zeros(length)
            return np.interp(np.linspace(0, len(arr) - 1, length), np.arange(len(arr)), arr)
            
        return {
            "r": resample_array(low_band, target_width),
            "g": resample_array(mid_band, target_width),
            "b": resample_array(high_band, target_width)
        }
    except Exception as e:
        print(f"Wellenform-Fehler: {e}")
        return None
'''
    with open("waveform_renderer.py", "w", encoding="utf-8") as f:
        f.write(waveform_code)
        
    print("Kernmodule erfolgreich geschrieben.")

def step_3_build_executable():
    log(3, "Erstelle die ausführbare Windows-EXE mit PyInstaller...")
    
    # Prüfen ob eine Hauptdatei existiert (main.py oder app.py)
    entry_point = "main.py"
    if not os.path.exists(entry_point):
        # Falls main.py nicht existiert, erstellen wir einen Fallback
        with open("main.py", "w", encoding="utf-8") as f:
            f.write('''import sys\nfrom rekordbox_parser import load_rekordbox_xml\nprint("DJ Airdox Editor gestartet.")\n''')

    spec_content = f"""# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ['{entry_point}'],
    pathex=[],
    binaries=[],
    datas=[('rekordbox_parser.py', '.'), ('waveform_renderer.py', '.')],
    hiddenimports=['librosa', 'soundfile', 'numpy', 'xml.etree.ElementTree'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='DJ_Airdox_Editor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
"""
    with open("build.spec", "w", encoding="utf-8") as f:
        f.write(spec_content)

    subprocess.check_call(["pyinstaller", "build.spec", "--clean"])
    print("Build erfolgreich abgeschlossen! Die EXE befindet sich im Ordner 'dist/DJ_Airdox_Editor'.")

if __name__ == "__main__":
    print("=== DJ AIRDOX EDITOR - AUTONOME PIPELINE ===")
    step_1_dependencies()
    step_2_create_core_modules()
    step_3_build_executable()
    print("\nAlle Schritte wurden vollautomatisch ausgeführt!")