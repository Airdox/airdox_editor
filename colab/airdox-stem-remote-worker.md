# AirDox · Colab-Fernworker v2

Dieses Notebook gehört zur gemeinsam ausgelieferten Windows-App. Es verarbeitet
Arbeitskopien mit dem trainierten 4-Stem-BS-RoFormer-Modell. Google Drive ist
Transport, keine Datenbank. Originale und Rekordbox-Daten bleiben unverändert.

<<<CELL md
## Vorbereitung (bei jeder neuen Colab-Sitzung)

1. In der Windows-App „Colab-Paket öffnen“ wählen. **Beide Dateien** aus diesem
   Ordner verwenden: dieses Notebook und `airdox-colab-worker.zip`.
2. Das ZIP nach `Meine Ablage/airdox-stem-jobs/airdox-colab-worker.zip` hochladen.
3. Dieses Notebook in Colab öffnen. Laufzeit → Laufzeittyp ändern → **T4 GPU**.
4. Unten den Jobordner anpassen und „Alle ausführen“ wählen. Drive-Zugriff
   persönlich bestätigen. Nach „BEREIT“ im Editor die Verbindung erneut prüfen.
5. Nur **eine** Worker-Sitzung pro Jobordner betreiben. Colab kann Sitzungen
   beenden; bei einem Abbruch neu starten. „Einmal starten, immer verfügbar“
   wird ausdrücklich nicht versprochen.

Die lange laufende letzte Zelle wartet auf Aufträge. Das ist normal, solange
regelmäßig „Wartet auf Jobs“ erscheint und der Editor ein frisches Lebenszeichen
anzeigt. Ein grüner Ordnerzugriff allein beweist keine Worker-Verbindung.
>>>

<<<CELL py
JOB_ORDNER = "airdox-stem-jobs"  # relativ zu Meine Ablage / MyDrive
GERAET = "auto"                 # auto, cuda oder cpu
EINMALIG = False                # Normalbetrieb: False
MAX_JOBS = 0                    # 0 = bis zum Stoppen der Zelle
>>>

<<<CELL py
from google.colab import drive
from pathlib import Path
import json, hashlib, os, subprocess, sys, zipfile

drive.mount("/content/drive")
DRIVE_ROOT = Path("/content/drive/MyDrive").resolve()
JOB_ROOT = (DRIVE_ROOT / JOB_ORDNER).resolve()
assert DRIVE_ROOT in JOB_ROOT.parents, "JOB_ORDNER muss ein Unterordner von MyDrive sein"
JOB_ROOT.mkdir(parents=True, exist_ok=True)
ARCHIV = JOB_ROOT / "airdox-colab-worker.zip"
assert ARCHIV.is_file(), f"Bitte das zur EXE gehörende Colab-Paket hier ablegen: {ARCHIV}"
REPO_DIR = Path("/content/airdox-colab-v2")
REPO_DIR.mkdir(exist_ok=True)
with zipfile.ZipFile(ARCHIV) as bundle:
    for name in bundle.namelist():
        target = (REPO_DIR / name).resolve()
        assert REPO_DIR in target.parents, f"Unsicherer Archivpfad: {name}"
    bundle.extractall(REPO_DIR)
version = json.loads((REPO_DIR / "bundle.json").read_text())
for name, expected in version["files"].items():
    actual = hashlib.sha256((REPO_DIR / name).read_bytes()).hexdigest()
    assert actual == expected, f"Paketdatei beschädigt: {name}"
print("AirDox-Version:", version["appVersion"], "Quellstand:", version["sourceRevision"])
print("Jobablage:", JOB_ROOT)
>>>

<<<CELL py
# Eigene Umgebung: Colab-Kernel und dessen vorinstallierte Pakete bleiben unberührt.
# uv stellt nötigenfalls Python 3.11 bereit, auch wenn Colab einen neueren Kernel hat.
subprocess.run([sys.executable, "-m", "pip", "install", "uv==0.8.22"], check=True)
VENV = Path("/content/airdox-colab-venv")
PYTHON = str(VENV / "bin/python")
subprocess.run([sys.executable, "-m", "uv", "venv", "--python", "3.11", "--seed", str(VENV)], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "torch==2.5.1", "torchaudio==2.5.1",
                "--index-url", "https://download.pytorch.org/whl/cu124"], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "-r", str(REPO_DIR / "colab/requirements-worker.txt")], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "--no-deps", "msst==0.1.0"], check=True)
MODELL_DIR = "/content/airdox-models"
subprocess.run([PYTHON, "-u", str(REPO_DIR / "colab/remote_setup.py"),
                "--model-dir", MODELL_DIR, "--device", GERAET], check=True)
>>>

<<<CELL md
## Worker starten

Diese Zelle läuft absichtlich dauerhaft. Erst „BEREIT“ bedeutet, dass Pakete,
Modell-Hash, Modellarchitektur und Rechengerät geprüft wurden. Ein vollständiger
Funktionsnachweis braucht zusätzlich einen echten Auftrag aus der Windows-App
und dessen erfolgreichen Rückimport. Siehe `ABNAHME.md` im Colab-Paket.

Bei einem Fehler bleibt die Zelle rot; Startfehler werden nicht verschluckt.
Ohne GPU kann die Berechnung erheblich länger dauern. Nach Sitzungsende das
Notebook erneut ausführen. Keine Passwörter oder Tokens in die Parameter kopieren.
>>>

<<<CELL py
command = [PYTHON, "-u", str(REPO_DIR / "colab/remote_worker.py"),
           "--root", str(JOB_ROOT), "--model-dir", MODELL_DIR,
           "--adapter", str(REPO_DIR / "python/bsroformer_inference.py"),
           "--work-dir", "/content/airdox-work", "--device", GERAET, "--poll", "15"]
if EINMALIG:
    command += ["--once"]
if MAX_JOBS:
    command += ["--max-jobs", str(MAX_JOBS)]
process = subprocess.Popen(command)
try:
    code = process.wait()
    assert code == 0, f"Worker beendet mit Exitcode {code}; Fehlermeldung oben beachten"
except KeyboardInterrupt:
    process.send_signal(2)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    print("Worker gestoppt. Nicht abgeschlossene Jobs bleiben in Drive erhalten.")
    raise
>>>
