# AirDox · High-Quality-Stems auf Google Colab (Fernworker)

Dieses Notebook ist der **externe Rechenworker** für den High-Quality-Pfad des
airdox_SMART_Editor. Der Editor schreibt eine **Arbeitskopie** und ein
Job-Manifest in einen Google-Drive-Ordner; dieses Notebook nimmt den Job an,
rechnet mit BS-RoFormer und legt die Stems samt SHA-256 zurück. Danach erkennt
der Editor `COMPLETED` und importiert die Ergebnisse. Für jeden Job muss die
Worker-Zelle in einer aktiven Colab-Laufzeit laufen: Drive-Sync allein startet
oder weckt Colab **nicht**. Nach Ende/Abbruch einer Laufzeit die Zelle erneut starten.

> **Arbeitsweise.** Es gibt keinen Server und keine Datenbank (§38): Google Drive
> ist die Jobablage, dieses Notebook der Rechenknecht. Die gesamte Editorlogik
> (Arbeitskopie bilden, Idempotenz, Import, Original-Schutz) bleibt im Editor.
>
> **Originaldateien.** Hochgeladen wird immer die Arbeitskopie des Editors,
> niemals die Originaldatei des Nutzers. Der Worker prüft den SHA-256 der
> Arbeitskopie vor der Separation und den jeder Ausgabedatei danach.
>
> **Idempotenz.** Ein Job mit Status `COMPLETED`/`FAILED`/`CANCELLED` wird nie
> erneut gerechnet – auch nicht nach einem Colab-Neustart. Zwei Worker
> gleichzeitig sind durch die Lease (`claim.json`) ausgeschlossen.
>
> **Abbruch im Lauf.** Klickt der Nutzer im Editor auf „Abbrechen“, landet
> `cancel.flag` im Jobordner. Dieses Notebook schaut alle 5 Sekunden danach –
> **auch mitten in der Rechnung**: Der Adapter-Prozess wird beendet (SIGTERM,
> nach 10 s SIGKILL), das Manifest auf `CANCELLED` gesetzt und die Fahne
> verbraucht. Kein GPU-Betrieb geht weiter, kein Ergebnis wird noch importiert,
> und derselbe Jobordner bleibt für einen neuen Lauf benutzbar. Takt:
> `--cancel-poll` (Sekunden).

<<<CELL md
### 0 · Was hier passiert

1. Google Drive mounten (Transport, keine Datenbank)
2. Repo-Quellcode bereitstellen (aus Drive-Archiv oder per `git clone`)
3. Modell **aus dem Katalog des Repos** laden (`src/stems/modelCatalog.json`) –
   keine erfundene URL, `sha256` wird geprüft, sobald der Katalog ihn nennt
4. `colab/remote_worker.py` starten: Jobs finden, beanspruchen, verifizieren,
   rechnen (GPU, sonst CPU), Ergebnisse + Hashes zurückschreiben
5. Im Leerlauf zeigt `worker.poll` alle `POLL_SEKUNDEN`, wie viele Jobordner geprüft wurden; pro Job schreibt der Worker korrelierbare Schritte nach `jobs/<jobId>/logs/worker.jsonl` und `worker.log` (jeweils auf 200 Zeilen begrenzt). Im Ablage-Root zeigen `worker.status.json` und `worker.log`, ob der Worker den Ordner erreicht und welche Phase er bearbeitet.
6. Nach einem Worker-Claim zeigt der Editor `claim.json`-Lebenszeichen und übernimmt die Worker-Schritte ins Statusfenster. Die CLI-Optionen `--model` und `--profile` werden ausdrücklich erkannt; Abkürzungen von `--model-dir` sind deaktiviert, damit Colab-Argumente nicht falsch zugeordnet werden.

Der Worker ruft den **vorhandenen** Adapter `python/bsroformer_inference.py` auf –
dieselbe Kette, die der Editor lokal für den HQ-Pfad benutzt. Es wird kein
zweites Separationsskript erfunden.
>>>

<<<CELL py #@param
# ── Jobablage (Google Drive) ─────────────────────────────────────────────────
# Muss derselbe Ordner sein, den der Editor unter Einstellungen → „High Quality
# extern“ eingestellt hat. Empfehlung: einen eigenen Drive-Unterordner nutzen.
JOB_ORDNER = "airdox-stem-jobs"          # Ordner in "My Drive"

# ── Quellcode ────────────────────────────────────────────────────────────────
REPO_ARCHIV = "airdox-stem-jobs/airdox-editor-src.tar.gz"  # optional: Repo-Archiv in Drive
REPO_URL = "https://github.com/Airdox/airdox_editor.git"    # benutzt, wenn kein Archiv
BRANCH = "main"

# ── Rechnen ──────────────────────────────────────────────────────────────────
GERAET = "auto"              # auto | cuda | cpu
MODELL_ID = ""               # "" = Modell aus dem Job-Manifest; sonst Katalog-ID
PROFIL = ""                  # "" = Profil aus dem Job-Manifest (HIGH_QUALITY)
MAX_JOBS = 0                 # 0 = so lange arbeiten, bis abgebrochen wird
POLL_SEKUNDEN = 15           # Pause zwischen zwei Durchläufen
ABBRUCH_SEKUNDEN = 5         # alle N s wird cancel.flag AUCH während der Rechnung geprüft
EINMALIG = False             # True = nur einen Durchlauf (für Tests)
VERBOSE = False              # True = ausführlicheres Logging (jede Poll-Runde)
>>>

<<<CELL py
# 1 · Google Drive mounten – Transportmittel für Jobs, Inputs und Ergebnisse
from google.colab import drive  # type: ignore
drive.mount("/content/drive")

import os, pathlib
JOB_ROOT = str(pathlib.Path("/content/drive/MyDrive") / JOB_ORDNER)
os.makedirs(os.path.join(JOB_ROOT, "jobs"), exist_ok=True)
print("Jobablage:", JOB_ROOT)
print("Offene Jobs:", len(os.listdir(os.path.join(JOB_ROOT, "jobs"))) if os.path.isdir(os.path.join(JOB_ROOT, "jobs")) else 0)
>>>

<<<CELL py
# 2 · Abhängigkeiten + Quellcode
import os, subprocess, sys

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "soundfile", "pyyaml"], check=False)

REPO_DIR = "/content/airdox"
if os.path.isdir(os.path.join("/content/drive/MyDrive", os.path.dirname(REPO_ARCHIV))) and os.path.isfile(os.path.join("/content/drive/MyDrive", REPO_ARCHIV)):
    os.makedirs(REPO_DIR, exist_ok=True)
    subprocess.run(["tar", "-xzf", os.path.join("/content/drive/MyDrive", REPO_ARCHIV), "-C", REPO_DIR], check=True)
    print("Quellcode aus Drive-Archiv entpackt:", REPO_DIR)
else:
    if not os.path.isdir(os.path.join(REPO_DIR, ".git")):
        subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, REPO_DIR], check=True)
    else:
        subprocess.run(["git", "-C", REPO_DIR, "fetch", "origin", BRANCH, "--depth", "1"], check=False)
        subprocess.run(["git", "-C", REPO_DIR, "checkout", "FETCH_HEAD"], check=False)
    print("Quellcode ausgecheckt:", REPO_DIR)

ADAPTER = os.path.join(REPO_DIR, "python", "bsroformer_inference.py")
WORKER = os.path.join(REPO_DIR, "colab", "remote_worker.py")
assert os.path.isfile(WORKER), f"Worker fehlt: {WORKER}"
print("Adapter:", ADAPTER)
print("Worker: ", WORKER)
>>>

<<<CELL py
# 3 · Modell aus dem Katalog des Repos – keine hart verdrahtete URL (§25, §26)
import json, os, sys

KATALOG = os.path.join(REPO_DIR, "src", "stems", "modelCatalog.json")
with open(KATALOG, encoding="utf-8") as handle:
    katalog = json.load(handle)

MODELL_DIR = "/content/models"
os.makedirs(MODELL_DIR, exist_ok=True)

# Welches Modell? Reihenfolge: MODELL_ID (Formular) → Job-Manifeste → Katalog.
def modell_aus_jobs() -> str:
    jobs_dir = os.path.join(JOB_ROOT, "jobs")
    if not os.path.isdir(jobs_dir):
        return ""
    for name in sorted(os.listdir(jobs_dir)):
        manifest = os.path.join(jobs_dir, name, "manifest.json")
        if os.path.isfile(manifest):
            try:
                with open(manifest, encoding="utf-8") as handle:
                    data = json.load(handle)
                if data.get("status") not in {"COMPLETED", "FAILED", "CANCELLED"}:
                    return str(data.get("engine", {}).get("modelId") or "")
            except Exception:
                continue
    return ""

MODELL_ID = MODELL_ID or modell_aus_jobs()
modell = next((m for m in katalog["models"] if m["id"] == MODELL_ID), None) if MODELL_ID else None
if modell is None:
    # Nichts offen: den primären HQ-Eintrag zeigen (Download lohnt trotzdem,
    # der nächste Job findet das Modell dann schon vor).
    modell = next((m for m in katalog["models"] if m["id"] == "bsroformer-musdb18hq-4stem-zfturbo"), katalog["models"][0])
print("Modell:", modell["id"], "|", modell.get("architecture"), "| Stems:", ",".join(modell.get("stemOrder", [])))
print("Gewichte:", modell["checkpoint"]["file"], "| sha256 im Katalog:", str(modell["checkpoint"].get("sha256"))[:16], "…")

def lade(url: str, ziel: str) -> None:
    if os.path.isfile(ziel) and os.path.getsize(ziel) > 1024:
        print("schon vorhanden:", os.path.basename(ziel))
        return
    subprocess.run(["wget", "-q", "--show-progress", "-O", ziel, url], check=True)

lade(modell["checkpoint"]["url"], os.path.join(MODELL_DIR, os.path.basename(modell["checkpoint"]["file"])))
if modell.get("config", {}).get("url"):
    lade(modell["config"]["url"], os.path.join(MODELL_DIR, os.path.basename(modell["config"]["file"])))

# Integrität: wenn der Katalog einen Hash nennt, MUSS er stimmen (§26).
import hashlib
erwartet = modell["checkpoint"].get("sha256")
if erwartet and erwartet != "unverified":
    digest = hashlib.sha256()
    with open(os.path.join(MODELL_DIR, os.path.basename(modell["checkpoint"]["file"])), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    gemessen = digest.hexdigest()
    print("sha256 gemessen:", gemessen)
    assert gemessen == erwartet, f"Checkpoint-Hash weicht vom Katalog ab ({gemessen} != {erwartet})"
    print("Checkpoint verifiziert.")
else:
    print("Katalog führt für dieses Modell noch keinen Hash (unverified) – bitte nach diesem Lauf pinnen.")
>>>

<<<CELL py
# 4 · GPU-Check – kein Job bricht ab, nur weil DirectML/CUDA fehlt (§7)
import os, subprocess
try:
    print(subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True).stdout.strip() or "Keine NVIDIA-GPU sichtbar")
except FileNotFoundError:
    print("nvidia-smi fehlt – CPU-Pfad")
print("device:", GERAET, "| max jobs:", MAX_JOBS, "| einmalig:", EINMALIG, "| Abbruch alle:", ABBRUCH_SEKUNDEN, "s")
>>>

<<<CELL py
# 5 · Worker starten und für neue Jobs laufen lassen.
#    Drive-Sync startet diese Zelle nicht automatisch. Die Ausgabe zeigt
#    worker.poll (scanned/pending); nach einem Colab-Neustart Zelle erneut ausführen.
import subprocess, sys, os

kommando = [
    sys.executable, WORKER,
    "--root", JOB_ROOT,
    "--model-dir", MODELL_DIR,
    "--adapter", ADAPTER,
    "--work-dir", "/content/airdox-work",
    "--device", GERAET,
    "--poll", str(POLL_SEKUNDEN),
    "--cancel-poll", str(ABBRUCH_SEKUNDEN),
    "--worker", f"colab-{os.getpid()}",
]
if MODELL_ID:
    kommando += ["--model", MODELL_ID]
if PROFIL:
    kommando += ["--profile", PROFIL]
if MAX_JOBS:
    kommando += ["--max-jobs", str(MAX_JOBS)]
if EINMALIG:
    kommando += ["--once"]
if VERBOSE:
    kommando += ["--verbose"]

print("Start:", " ".join(kommando))
subprocess.run(kommando, check=False)
>>>

<<<CELL py
# 6 · Übersicht: welche Jobs liegen in der Ablage, welcher Status?
import json, os

jobs_dir = os.path.join(JOB_ROOT, "jobs")
zeilen = []
for name in sorted(os.listdir(jobs_dir)) if os.path.isdir(jobs_dir) else []:
    manifest = os.path.join(jobs_dir, name, "manifest.json")
    if not os.path.isfile(manifest):
        continue
    try:
        with open(manifest, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        continue
    trace_path = os.path.join(jobs_dir, name, "logs", "worker.jsonl")
    last_step = "-"
    try:
        with open(trace_path, encoding="utf-8") as handle:
            lines = [line for line in handle if line.strip()]
        if lines:
            last_step = str(json.loads(lines[-1]).get("step") or "-")
    except (OSError, ValueError):
        pass
    zeilen.append((name, data.get("status"), data.get("phase"), data.get("engine", {}).get("modelId"), (data.get("worker") or {}).get("device"), last_step))
for job_id, status, phase, model, device, last_step in zeilen:
    print(f"{job_id}  {status:<10} {str(model):<36} {str(device or '-'):<8} {last_step:<28} {phase or ''}")
print(f"\n{len(zeilen)} Job(s) in der Ablage.")
print("Der Editor importiert COMPLETED automatisch. Für weitere Jobs muss die Worker-Zelle in der aktiven Colab-Laufzeit weiterlaufen.")
>>>

<<<CELL md
### Diagnose: Statusfenster wartet länger als zwei Minuten

1. Job-ID im Editor notieren. Unter `jobs/<jobId>/` müssen `manifest.json` und `input/*.wav` im selben Drive-Konto/Jobordner sichtbar sein. Mit der Drive-Webansicht prüfen, dass Windows tatsächlich synchronisiert hat.
2. Die Ausgabe der laufenden Worker-Zelle muss regelmäßig eine Zeile `worker.poll` mit `scanned`, `pending` und `processed` zeigen. Fehlt die Zeile, ist Zelle #5 noch nicht gestartet (z. B. weil Setup/Modelldownload noch läuft) oder die Laufzeit steht. `scanned: 0` trotz offenem Editor-Job spricht für einen falschen `JOB_ORDNER`, falschen Drive-Mount oder noch nicht synchronisierte Datei.
3. Sobald der Worker den Job sieht, erscheint `claim.json`; `heartbeatAt` muss während der Rechnung weiterlaufen. Im Ablage-Root aktualisiert `worker.status.json` zusätzlich den Worker-Heartbeat und die aktive Jobphase. Der Editor übernimmt Claim und Worker-Protokoll beim nächsten Poll.
4. `jobs/<jobId>/logs/worker.jsonl` enthält strukturierte Ereignisse (`worker.claimed`, `worker.input_verified`, `worker.inference_started`, `worker.inference_progress`, `worker.output_written`, `worker.completed` oder `worker.failed`). `worker.log` ist die menschenlesbare Ergänzung; bei Fehlern außerdem `error.json` prüfen.
5. Bei `COMPLETED` muss `manifest.json` alle Outputs aufführen. Danach zeigt der Editor `editor.output_validated` und `editor.result_imported`. Die Ablaufspur wird auch im Statusfenster angezeigt.

Keine `input/*.wav`, Zugangsdaten oder vollständigen privaten Pfade in öffentliche Logs/Issues kopieren. Für neue Jobs muss die Colab-Worker-Zelle aktiv bleiben; Drive-Sync allein startet keinen externen Rechner.
>>>
