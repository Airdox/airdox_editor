<<<CELL md
# AirDox Rekordbox Top 200

Im Editor gewünschte Rekordbox-Sammlung importieren, Top 200 prüfen und Stapel übertragen. Nach dem ersten Zehner-Zwischenstand
BATCH_ID unten eintragen und alle Zellen ausführen. Weitere Tracks werden während der Trennung nachgeliefert. Fertige Jobs werden bei
Wiederaufnahme übersprungen. Für FAILED-Jobs im selben Stapel `FEHLGESCHLAGENE_WIEDERHOLEN = True` setzen. Erst nach verifiziertem Setup werden ausschließlich diese Stapel-IDs wiederholt; COMPLETED und CANCELLED bleiben unverändert.
`colab/batch_setup.py` zusätzlich als `airdox-batch-setup.py` nach My Drive kopieren (derselbe Stand wie im Archiv).
Vor dem ersten Lauf das mitgelieferte aktuelle Archiv aus dem Installationsordner `resources/colab` verwenden und
`stem-gate-colab.tar.gz` nach My Drive kopieren. Das Archiv enthält den neuen
Stapel-Worker; der ältere Release-Branch enthält ihn noch nicht.
Lokal wird ffmpeg im PATH oder AIRDOX_FFMPEG benötigt. Der Editor prüft und
importiert Ergebnisse automatisch mit dauerhafter Zuordnung zum Original.
>>>

<<<CELL md
### Ablauf

1. Im Editor Modell wählen, Top-200-Stapel übertragen und Drive-Sync abwarten.
2. In Colab eine verfügbare GPU-Laufzeit auswählen.
3. BATCH_ID eintragen und die Zellen in Reihenfolge ausführen.
4. Das Modell kommt ausschließlich aus dem Editor-Manifest. Abweichende Modelle,
   unbestätigte Gewichte und inkompatible Stem-Typen führen zu einem Fehler.
5. Nach Abschluss den lokalen Import abwarten, dann Colab-Laufzeit trennen.

Jeder fertige Track wird sofort einzeln mit Manifest und Prüfsummen nach Drive
geschrieben. Der Editor speichert seinen Status nach jedem Track und
veröffentlicht spätestens alle zehn Übertragungen einen Stapel-Zwischenstand.
Das Notebook folgt dieser Liste bis `uploadComplete` gesetzt ist; es wartet
nicht auf den vollständigen 200er-Upload, bevor die erste Trennung beginnt.

`MODELL_WIEDERVERWENDEN` aktiviert optional den neuen langlebigen Separator.
Die Protokoll- und Abbruchtests bestehen; vor produktivem GPU-Einsatz müssen
Ausgabeparität, VRAM-Verhalten und Durchsatz mit der jeweiligen Laufzeit geprüft
werden. Der geöffnete ältere Worker wird durch dieses Notebook nicht verändert.

Derzeit ist ZFTurbo BS-RoFormer mit vier Stems verifiziert: Drums, Bass, Other,
Vocals. Die katalogisierten Viperx-Modelle liefern nur zwei Stems und haben keine
verifizierten Gewichts-Hashes. Demucs/SCNet besitzen hier keinen freigegebenen
Colab-Adapter. Sie werden nicht still als Ersatz verwendet.

Bleibt der Editor auf „Wartet auf den externen Rechner“, prüfe denselben
Google-Account und `JOB_ORDNER`, den Uploadstatus und die Ausgabe von Zelle 5.
Unterbrochene Inferenz beginnt beim nächsten Versuch von vorn; bereits fertige
Jobs werden nicht erneut gerechnet.

Einzeljob-Selbsttests bleiben im unveränderten Einzeljob-Notebook.
>>>

<<<CELL py #@param
JOB_ORDNER = "airdox-stem-jobs"  # Unterordner in My Drive
BATCH_ID = ""  # Stapel-ID aus dem Editor
FEHLGESCHLAGENE_WIEDERHOLEN = False #@param {type:"boolean"}
REPO_ARCHIV = "stem-gate-colab.tar.gz"
BRANCH = "stem-colab-20261101-r4"  # Fester Release-Stand passend zu dieser Windows-Ausgabe
MSST_COMMIT = "9cc76c03ccd4da5ddf3477e93d386a1648a77732"
ABBRUCH_SEKUNDEN = 5
GPU_BATCH_GROESSE = 0  # 0: automatisch bis 16 Fenster; 1: seriell zum Vergleich; z.B. 4: fest
MODELL_WIEDERVERWENDEN = False #@param {type:"boolean"}
>>>

<<<CELL py
import json, os, pathlib, re, torch, uuid
SELECTED_JOB_ID = None
READY_JOB_ID = None
if not torch.cuda.is_available():
    raise RuntimeError("Keine GPU verfügbar. Kostenlosen GPU-Laufzeittyp wählen oder später erneut versuchen; lokal weiterarbeiten ist möglich.")
print("GPU:", torch.cuda.get_device_name(0), "| PyTorch:", torch.__version__)
from google.colab import drive
try:
    drive.mount("/content/drive")
except Exception:
    raise RuntimeError("Drive konnte nicht eingebunden werden. Konto und Freigabe prüfen.")
drive_root = pathlib.Path("/content/drive/MyDrive").resolve()
job_root_path = (drive_root / JOB_ORDNER).resolve()
if not job_root_path.is_relative_to(drive_root) or job_root_path == drive_root:
    raise ValueError("JOB_ORDNER muss ein Unterordner von My Drive sein.")
JOB_ROOT = str(job_root_path)
jobs_dir = job_root_path / "jobs"
if not jobs_dir.is_dir():
    raise RuntimeError("Keine Jobablage gefunden. Auftrag im Editor starten und Drive-Sync abwarten.")
import runpy
setup_source = drive_root / "airdox-batch-setup.py"
if not setup_source.is_file():
    raise RuntimeError("colab/batch_setup.py als airdox-batch-setup.py nach My Drive kopieren und Drive-Sync abwarten.")
setup_api = runpy.run_path(str(setup_source))
SELECTED_MANIFEST = setup_api["select_batch_job"](JOB_ROOT, BATCH_ID, retry_failed=FEHLGESCHLAGENE_WIEDERHOLEN)
auswahl = SELECTED_MANIFEST["jobId"]
MODELL_ID = SELECTED_MANIFEST["engine"]["modelId"]
PROFIL = SELECTED_MANIFEST["engine"]["profile"]
input_info = SELECTED_MANIFEST["input"]
input_path = jobs_dir / auswahl / "input" / pathlib.Path(input_info["fileName"]).name
if not input_path.is_file() or input_path.stat().st_size != input_info["bytes"]:
    raise RuntimeError("Audio-Upload noch nicht vollständig. Drive-Sync abwarten und Zelle 1 erneut starten.")
SELECTED_JOB_ID = auswahl
print("Ausgewählt:", SELECTED_JOB_ID, "|", MODELL_ID, "|", PROFIL)
>>>

<<<CELL py
import subprocess, sys, tarfile
assert SELECTED_JOB_ID, "Zuerst Zelle 1 erfolgreich ausführen."
REPO_DIR = "/content/airdox-" + BRANCH
archive = drive_root / REPO_ARCHIV if REPO_ARCHIV else None
if not archive or not archive.is_file():
    raise RuntimeError("Aktuelles stem-gate-colab.tar.gz fehlt in My Drive. Mitgeliefertes Archiv aus resources/colab hochladen; kein Release-/Cache-Ersatz.")
import tempfile
REPO_DIR = tempfile.mkdtemp(prefix="airdox-batch-", dir="/content")
with tarfile.open(archive, "r:gz") as bundle:
    bundle.extractall(REPO_DIR, filter="data")
if os.path.isfile(os.path.join(REPO_DIR, "airdox-editor", "colab", "remote_worker.py")):
    REPO_DIR = os.path.join(REPO_DIR, "airdox-editor")
print("AirDox-Quellstand:", subprocess.check_output(["git", "-C", REPO_DIR, "rev-parse", "HEAD"], text=True).strip() if os.path.isdir(os.path.join(REPO_DIR, ".git")) else "Drive-Archiv")
WORKER = os.path.join(REPO_DIR, "colab", "remote_worker.py")
ADAPTER = os.path.join(REPO_DIR, "python", "bsroformer_inference.py")
assert os.path.isfile(WORKER) and os.path.isfile(ADAPTER), "Quellcode-Archiv unvollständig."
help_result = subprocess.run([sys.executable, WORKER, "--help"], capture_output=True, text=True, check=True)
assert "--job-id" in help_result.stdout, "Archiv/Branch ist zu alt: neuen Quellcode mit --job-id bereitstellen."
assert "--batch-size" in help_result.stdout, "Worker zu alt: aktuellen Quellcode als Drive-Archiv bereitstellen."
adapter_help = subprocess.run([sys.executable, ADAPTER, "--help"], capture_output=True, text=True, check=True)
assert "--batch-size" in adapter_help.stdout, "Adapter zu alt: aktuelles Archiv mit npm run stems:gate:archive bauen und REPO_ARCHIV setzen."
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "numpy<=2.2.0",
    "soundfile", "pyyaml", "ml-collections", "einops", "rotary-embedding-torch", "beartype"], check=True)
MSST_DIR = "/content/msst"
if not os.path.isdir(os.path.join(MSST_DIR, ".git")):
    subprocess.run(["git", "init", "-q", MSST_DIR], check=True)
    subprocess.run(["git", "-C", MSST_DIR, "remote", "add", "origin", "https://github.com/ZFTurbo/Music-Source-Separation-Training.git"], check=True)
subprocess.run(["git", "-C", MSST_DIR, "fetch", "--depth", "1", "origin", MSST_COMMIT], check=True)
subprocess.run(["git", "-C", MSST_DIR, "checkout", "--detach", MSST_COMMIT], check=True)
os.environ["AIRODOX_MSST_DIR"] = MSST_DIR
if MSST_DIR not in sys.path:
    sys.path.insert(0, MSST_DIR)
from models.bs_roformer.bs_roformer import BSRoformer
print("Architektur bereit:", MSST_COMMIT)
>>>

<<<CELL py
READY_JOB_ID = None
assert SELECTED_JOB_ID, "Zuerst Zelle 1 ausführen."
import runpy, inspect
batch_api = runpy.run_path(str(pathlib.Path(WORKER).with_name("top200_batch.py")))
if "retry_failed" not in inspect.signature(batch_api["run_batch"]).parameters or "verify_model_files" not in batch_api:
    raise RuntimeError("Archiv zu alt: Recorder muss den aktuellen Batch-Stand bereitstellen.")
setup_path = pathlib.Path(REPO_DIR) / "colab" / "batch_setup.py"
if not setup_path.is_file() or setup_path.read_bytes() != setup_source.read_bytes():
    raise RuntimeError("Setup-Datei und Archiv passen nicht zusammen. Beide aus demselben Recorder-Stand bereitstellen.")
with open(os.path.join(REPO_DIR, "src", "stems", "modelCatalog.json"), encoding="utf-8") as handle:
    katalog = json.load(handle)
MODELL_DIR = "/content/models"
modell = setup_api["prepare_model"](SELECTED_MANIFEST, katalog, MODELL_DIR, batch_api["validate_model"])
sha256 = setup_api["sha256"]
print("Verifiziert:", modell["id"], modell["checkpoint"]["file"], modell["config"]["file"])
READY_JOB_ID = SELECTED_JOB_ID
>>>

<<<CELL py
import runpy, sys
from pathlib import Path
assert torch.cuda.is_available(), "GPU fehlt"
assert READY_JOB_ID == SELECTED_JOB_ID, "Zellen 1–3 ausführen"
batch_module = runpy.run_path(str(Path(WORKER).with_name("top200_batch.py")))
command = [sys.executable, WORKER, "--root", JOB_ROOT,
    "--model-dir", MODELL_DIR, "--adapter", ADAPTER,
    "--work-dir", "/content/airdox-work", "--device", "cuda",
    "--batch-size", str(GPU_BATCH_GROESSE), "--model", MODELL_ID, "--profile", PROFIL,
    "--cancel-poll", str(ABBRUCH_SEKUNDEN), "--worker", f"colab-{os.getpid()}"]
batch_module["verify_model_files"](SELECTED_MANIFEST, katalog, command)
results = batch_module["run_batch"](JOB_ROOT, BATCH_ID, command, catalog=katalog, monitor_gpu=True, persistent=MODELL_WIEDERVERWENDEN, retry_failed=FEHLGESCHLAGENE_WIEDERHOLEN)
print("Stapel beendet:", results)
>>>
