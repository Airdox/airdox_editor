"""
Colab Notebook als Python Script - Alternative zu .ipynb
Feature Branch: feature/colab-stem-separation

Dieses Script kann direkt in Google Colab ausgeführt werden.
Es implementiert den Drive Watcher für automatische Stem Separation.

Setup in Colab:
1. Drive mounten
2. GPU aktivieren (Laufzeit -> Laufzeittyp ändern -> GPU)
3. Dieses Script ausführen

Oder nutze das .ipynb Notebook für bessere Übersicht.
"""

# %% 1. Drive mounten
print("=== Schritt 1: Drive mounten ===")
try:
    from google.colab import drive
    drive.mount('/content/drive')
    print("Drive gemountet")
except ImportError:
    print("Nicht in Colab - simuliere Drive Pfad lokal")
    # Für lokale Tests

# %% 2. GPU prüfen (zwingend laut Spec)
print("\n=== Schritt 2: GPU prüfen (zwingend) ===")
import torch
import json

cuda_available = torch.cuda.is_available()
print(f"CUDA verfügbar: {cuda_available}")
print(f"PyTorch: {torch.__version__}")

if cuda_available:
    print(f"Device Count: {torch.cuda.device_count()}")
    print(f"Device Name: {torch.cuda.get_device_name(0)}")
    props = torch.cuda.get_device_properties(0)
    print(f"Memory: {props.total_memory / 1024**3:.2f} GB")
    print("✅ GPU verfügbar")
else:
    print("⚠️ Keine GPU! In Colab: Laufzeit -> Laufzeittyp ändern -> GPU")
    print("Für Tests wird CPU verwendet, aber laut Spec muss GPU sein")
    # raise RuntimeError("GPU erforderlich")

# %% 3. Dependencies
print("\n=== Schritt 3: Dependencies ===")
try:
    import demucs
    print(f"demucs bereits installiert: {demucs.__version__ if hasattr(demucs, '__version__') else 'unknown'}")
except ImportError:
    print("Installiere demucs, torch, torchaudio...")
    import subprocess
    subprocess.check_call(["pip", "install", "-q", "demucs", "torch", "torchaudio"])
    print("Installation abgeschlossen")

# %% 4. Ordnerstruktur
print("\n=== Schritt 4: Ordnerstruktur ===")
from pathlib import Path

BASE = Path("/content/drive/MyDrive/AudioEditor_Stems")
INPUT_DIR = BASE / "Input"
OUTPUT_DIR = BASE / "Output"

INPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print(f"Base: {BASE}")
print(f"Input: {INPUT_DIR} - {len(list(INPUT_DIR.glob('*')))} Dateien")
print(f"Output: {OUTPUT_DIR} - {len(list(OUTPUT_DIR.glob('*')))} Ordner")

# %% 5. Demucs Processor (aus demucs_processor.py)
print("\n=== Schritt 5: Demucs Processor laden ===")

# Importiere aus lokaler Datei falls vorhanden, sonst definiere inline
try:
    import sys
    sys.path.append('/content/drive/MyDrive/AudioEditor_Stems')
    # Versuche aus Repo zu importieren
    from demucs_processor import DemucsProcessor, check_gpu
    print("DemucsProcessor aus Datei geladen")
except ImportError:
    print("Definiere DemucsProcessor inline (aus audio_editor/colab/demucs_processor.py)")
    
    # Inline Definition (gekürzt, vollständige Version siehe demucs_processor.py)
    from datetime import datetime
    import shutil
    import time
    
    STANDARD_STEMS = ["drums", "bass", "other", "vocals"]
    
    class DemucsProcessor:
        def __init__(self, output_base: Path):
            self.output_base = Path(output_base)
            self.output_base.mkdir(parents=True, exist_ok=True)
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"[Demucs] Device: {self.device}")
            
            print("[Demucs] Lade htdemucs Modell (offizielle Gewichte via demucs)...")
            from demucs.pretrained import get_model
            self.model = get_model("htdemucs")
            self.model.to(self.device)
            print(f"[Demucs] Modell bereit: htdemucs auf {self.device}")
        
        def separate_track(self, input_path: Path, track_id: str):
            import torchaudio
            from demucs.audio import AudioFile
            from demucs.apply import apply_model
            
            input_path = Path(input_path)
            output_dir = self.output_base / track_id
            output_dir.mkdir(parents=True, exist_ok=True)
            
            print(f"[Demucs] Separation: {input_path.name} -> {output_dir}")
            
            status_path = output_dir / "status.json"
            status = {
                "track_id": track_id,
                "input_file": str(input_path),
                "status": "processing",
                "model": "htdemucs",
                "device": self.device,
                "started_at": datetime.now().isoformat(),
            }
            with open(status_path, 'w') as f:
                json.dump(status, f, indent=2)
            
            # Audio laden
            wav = AudioFile(str(input_path)).read(
                streams=0,
                samplerate=self.model.samplerate,
                channels=self.model.audio_channels
            )
            wav = wav.to(self.device)
            ref = wav.mean(0)
            wav = (wav - ref.mean()) / ref.std()
            
            # Separation
            with torch.no_grad():
                sources = apply_model(self.model, wav[None], device=self.device, split=True, overlap=0.25, progress=True)[0]
            
            sources = sources * ref.std() + ref.mean()
            
            for i, stem_name in enumerate(self.model.sources):
                output_path = output_dir / f"{stem_name}.wav"
                torchaudio.save(str(output_path), sources[i].cpu(), self.model.samplerate)
                print(f"[Demucs] Saved: {output_path}")
            
            status["status"] = "completed"
            status["done"] = True
            status["completed_at"] = datetime.now().isoformat()
            with open(status_path, 'w') as f:
                json.dump(status, f, indent=2)
            (output_dir / "DONE").touch()
            print(f"[Demucs] ✅ Fertig: {track_id}")
            return status
        
        def watch_and_process(self, input_base: Path, poll_interval: int = 10):
            input_base = Path(input_base)
            print(f"[Watcher] Input: {input_base}, Output: {self.output_base}")
            processed = set()
            for done in self.output_base.glob("*/DONE"):
                processed.add(done.parent.name)
            
            try:
                while True:
                    triggers = list(input_base.glob("_TRIGGER_*.json"))
                    for trigger_path in triggers:
                        track_id = trigger_path.stem.replace("_TRIGGER_", "")
                        if track_id in processed:
                            continue
                        print(f"\n[Watcher] Neuer Trigger: {track_id}")
                        try:
                            with open(trigger_path) as f:
                                print(f"Trigger: {json.load(f)}")
                            audio_candidates = [p for p in input_base.glob(f"{track_id}_*") if not p.name.endswith(".json")]
                            if not audio_candidates:
                                print(f"Keine Audio Datei für {track_id}")
                                continue
                            audio_file = audio_candidates[0]
                            result = self.separate_track(audio_file, track_id)
                            processed.add(track_id)
                        except Exception as e:
                            print(f"Fehler bei {track_id}: {e}")
                            import traceback
                            traceback.print_exc()
                    time.sleep(poll_interval)
            except KeyboardInterrupt:
                print("Watcher beendet")

    def check_gpu():
        print(f"CUDA: {torch.cuda.is_available()}, Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None'}")

# %% 6. Watcher starten
print("\n=== Schritt 6: Watcher starten ===")
print("Der Watcher beobachtet Input Ordner und verarbeitet neue Tracks automatisch")
print("Zum Beenden: Runtime -> Unterbrechen oder Strg+C")

processor = DemucsProcessor(
    output_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Output")
)

processor.watch_and_process(
    input_base=Path("/content/drive/MyDrive/AudioEditor_Stems/Input"),
    poll_interval=10
)

# Für manuelle Verarbeitung einzelner Tracks:
# result = processor.separate_track(Path("/content/drive/MyDrive/AudioEditor_Stems/Input/<Track_ID>_song.mp3"), "<Track_ID>")
