# AirDox 0.4.4 · Vorbereitung, Nachweis, Google-Freigabe

**Dieses Notebook ist im Windows-Paket selbstenthaltend.** Es benötigt kein
Worker-ZIP in Google Drive. Verwenden Sie das Notebook aus „Notebook speichern
& Colab öffnen“, nicht diese Entwicklervorlage aus dem Repository.

<<<CELL md
## Ablauf und klare Grenze

1. **Vorbereitung ohne Drive-Zugriff:** eingebettetes Paket prüfen/entpacken,
   eigene Python-Umgebung installieren, Modellhash prüfen, echte Testtrennung
   mit mitgeliefertem Musik-Testausschnitt durchführen. Originale des Nutzers
   werden hierbei nicht gelesen.
2. **AUTH_REQUIRED:** der Prüfbericht wird lokal in der Laufzeit geschrieben.
   Es wurde noch kein Drive-Zugriff autorisiert.
3. **Persönliche Google-Freigabe:** erst die ausdrücklich markierte Zelle ruft
   `drive.mount()` auf. Google kann eine erneute Freigabe verlangen. Niemals
   Passwörter, Cookies oder Autorisierungscodes an Dritte/den Chat senden.
4. **Worker starten:** Verbindungstest des Editors beantwortet eine frische
   Zufallsanforderung. Erst danach ist der Hin-/Rückweg dieser Sitzung belegt.

**Die Anmeldung am Colab-Dienst selbst kann schon vor Schritt 1 erforderlich
sein.** Ohne Google-Konto wurden diese vorbereitenden Schritte bereits in CI
getestet; das ist keine Anmeldung in Ihrem Konto. Google-GPU und Drive werden
nicht durch einen CPU-Test auf GitHub vorgetäuscht.

Laufzeit → Laufzeittyp ändern → T4 GPU empfohlen. Nur eine Sitzung pro
Jobordner verwenden. Für den extern gesteuerten Workerbetrieb gelten Googles
Nutzungs- und Ressourcenbeschränkungen; der kostenlose Dienst ist kein
zugesicherter Hintergrund-Rechenserver. Es wird kein Abo automatisch gekauft.
>>>

<<<CELL py
# AIRDOX_STAGE: configuration (no Google authorization)
import os
from pathlib import Path
JOB_ORDNER = "airdox-stem-jobs"  # Unterordner von Meine Ablage / MyDrive
GERAET = os.environ.get("AIRDOX_COLAB_DEVICE", "auto")
TORCH_INDEX = os.environ.get("AIRDOX_COLAB_TORCH_INDEX", "cu124")  # CI: cpu; Colab: cu124
MAX_JOBS = 1  # Standard: nach einem Auftrag beenden, keine unbegrenzte Sitzung
WORKERBETRIEB_BESTAETIGT = False  # Erst nach Prüfung der Nutzungs-/Tarifbedingungen auf True setzen
CONTENT_ROOT = Path(os.environ.get("AIRDOX_COLAB_CONTENT", "/content")).resolve()
CONTENT_ROOT.mkdir(parents=True, exist_ok=True)
>>>

<<<CELL py
# AIRDOX_STAGE: verified self-contained payload (no Drive, no GitHub login)
import base64, hashlib, io, json, zipfile
BUNDLE_B64 = "__AIRDOX_BUNDLE_B64__"
BUNDLE_SHA256 = "__AIRDOX_BUNDLE_SHA256__"
assert not BUNDLE_B64.startswith("__"), "Dies ist die Entwicklervorlage. Bitte das Notebook aus dem Windows-Paket verwenden."
payload = base64.b64decode(BUNDLE_B64, validate=True)
assert hashlib.sha256(payload).hexdigest() == BUNDLE_SHA256, "Notebook-Paket beschädigt"
REPO_DIR = (CONTENT_ROOT / "airdox-colab-v2").resolve()
REPO_DIR.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(io.BytesIO(payload)) as archive:
    assert len(archive.namelist()) == len(set(archive.namelist())), "Doppelte Archivpfade"
    for item in archive.infolist():
        target = (REPO_DIR / item.filename).resolve()
        assert REPO_DIR in target.parents and not item.is_dir(), "Unsicherer Archivpfad"
    archive.extractall(REPO_DIR)
version = json.loads((REPO_DIR / "bundle.json").read_text(encoding="utf-8"))
for name, expected in version["files"].items():
    assert hashlib.sha256((REPO_DIR / name).read_bytes()).hexdigest() == expected, f"Datei beschädigt: {name}"
print("Paket verifiziert:", version["appVersion"], version["sourceRevision"])
>>>

<<<CELL py
# AIRDOX_STAGE: isolated runtime and real inference (no Google/Drive imports)
import subprocess, sys
assert TORCH_INDEX in {"cpu", "cu124"}, "Unzulässiger Paketindex"
subprocess.run([sys.executable, "-m", "pip", "install", "uv==0.8.22"], check=True)
VENV = CONTENT_ROOT / "airdox-colab-venv"
PYTHON = str(VENV / "bin/python")
subprocess.run([sys.executable, "-m", "uv", "venv", "--python", "3.11", "--seed", "--clear", str(VENV)], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "torch==2.5.1", "torchaudio==2.5.1",
                "--index-url", f"https://download.pytorch.org/whl/{TORCH_INDEX}"], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "-r", str(REPO_DIR / "colab/requirements-worker.txt")], check=True)
subprocess.run([PYTHON, "-m", "pip", "install", "--no-deps", "msst==0.1.0"], check=True)
subprocess.run([PYTHON, "-m", "pip", "check"], check=True)
MODELL_DIR = os.environ.get("AIRDOX_COLAB_MODEL_DIR", str(CONTENT_ROOT / "airdox-models"))
subprocess.run([PYTHON, "-u", str(REPO_DIR / "colab/remote_setup.py"),
                "--model-dir", MODELL_DIR, "--device", GERAET], check=True)
PREAUTH_REPORT = CONTENT_ROOT / "airdox-preauth-report.json"
subprocess.run([PYTHON, "-u", str(REPO_DIR / "colab/preauth_check.py"),
                "--model-dir", MODELL_DIR, "--device", GERAET, "--report", str(PREAUTH_REPORT)], check=True)
preauth = json.loads(PREAUTH_REPORT.read_text(encoding="utf-8"))
assert preauth["result"] == "PASS" and preauth["state"] == "AUTH_REQUIRED"
assert preauth["sourceCommit"] == version["sourceRevision"]
print("VORBEREITUNG BESTANDEN. Nächster Schritt benötigt Ihre persönliche Google-Drive-Freigabe.")
print("Nachweisdatei:", PREAUTH_REPORT)
>>>

<<<CELL md
## STOPP: Hier beginnt der persönliche Google-Zugriff

Bis hier wurden nur öffentliche Pakete/Modellgewichte und der eingebettete
Testausschnitt benutzt. Die nächste Zelle lässt Google den Zugriff auf Drive
bestätigen. Drive-Mount gibt Notebook-Code Zugriff auf die gemounteten Dateien;
führen Sie deshalb nur das unveränderte, geprüfte Notebook aus.

Der Editor benötigt weiterhin einen synchronisierten Drive-Ordner auf Windows.
Die Google-Anmeldung dort und die Drive-Freigabe in Colab sind getrennte Vorgänge.
Ein Desktop-OAuth-Token würde Colab nicht automatisch anmelden.
>>>

<<<CELL py
# AIRDOX_AUTH_GATE -- CI and pre-auth checks MUST STOP BEFORE THIS CELL
assert preauth["result"] == "PASS" and preauth["state"] == "AUTH_REQUIRED"
from google.colab import drive
drive.mount(str(CONTENT_ROOT / "drive"))
DRIVE_ROOT = (CONTENT_ROOT / "drive/MyDrive").resolve()
JOB_ROOT = (DRIVE_ROOT / JOB_ORDNER).resolve()
assert DRIVE_ROOT in JOB_ROOT.parents, "Jobordner muss innerhalb von MyDrive liegen"
JOB_ROOT.mkdir(parents=True, exist_ok=True)
import shutil
shutil.copyfile(PREAUTH_REPORT, JOB_ROOT / "preauth-report.json")
print("Drive freigegeben. Jobablage:", JOB_ROOT)
>>>

<<<CELL py
# AIRDOX_STAGE: authenticated worker; resources are only used after explicit consent
assert WORKERBETRIEB_BESTAETIGT, "Bitte zuerst Googles Nutzungsbedingungen/Tarif prüfen und WORKERBETRIEB_BESTAETIGT auf True setzen. Es wird nichts gekauft."
command = [PYTHON, "-u", str(REPO_DIR / "colab/remote_worker.py"),
           "--root", str(JOB_ROOT), "--model-dir", MODELL_DIR,
           "--adapter", str(REPO_DIR / "python/bsroformer_inference.py"),
           "--work-dir", str(CONTENT_ROOT / "airdox-work"), "--device", GERAET, "--poll", "15"]
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
    print("Worker gestoppt. Jobzustand bleibt erhalten.")
    raise
>>>
