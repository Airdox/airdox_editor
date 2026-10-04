# AirDox · High-Quality-Stems auf Google Colab (Fernworker)

Dieses Notebook ist der **externe Rechenworker** für den High-Quality-Pfad des
airdox_SMART_Editor. Der Editor schreibt eine **Arbeitskopie** und ein
Job-Manifest in einen Google-Drive-Ordner; dieses Notebook nimmt den Job an,
rechnet mit BS-RoFormer und legt die Stems samt SHA-256 zurück. Danach erkennt
der Editor `COMPLETED` und importiert die Ergebnisse – der Benutzer muss Colab
**nicht** bedienen, außer diesem Notebook einmal zu starten.

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
>
> **Wenn der Editor „Wartet auf den externen Rechner“ zeigt.** Das heißt: der
> Steckbrief liegt in der Ablage, aber kein Rechner hat ihn beansprucht
> (`claim.json` fehlt). Drei Ursachen, in dieser Reihenfolge prüfen:
>
> 1. **Anderer Ordner.** `JOB_ORDNER` (Zelle 1) und der im Editor gewählte
>    Ordner müssen derselbe Ordner desselben Google-Kontos sein. Zelle 5 druckt
>    vor dem Start `--check-store` – dort steht das Urteil im Klartext.
> 2. **Worker läuft nicht.** Zelle 5 muss ausgeführt sein und darf nicht sofort
>    mit einem Fehlercode enden. Sie läuft **absichtlich** weiter und meldet alle
>    60 s „Warte auf Jobs …“ – das ist der Lebensbeweis, kein Hänger.
> 3. **Modellfilter.** Steht `MODELL_ID` auf einem anderen Modell als im
>    Steckbrief, überspringt der Worker den Job: Er rechnet **nie** ein anderes
>    Modell als das im Manifest. `MODELL_ID = ""` lässt das Manifest
>    entscheiden. Ein sofort beendeter Lauf (unbekannte Option, fehlender
>    Adapter) wird in Zelle 5 als Fehlercode gemeldet.
>
> `python3 colab/remote_worker.py --root "<Jobablage>" --check-store` zeigt den
> Zustand jederzeit an – auf dem Laptop wie in Colab und **ohne** etwas zu
> verändern.

<<<CELL md
### 0 · Was hier passiert

1. Google Drive mounten (Transport, keine Datenbank)
2. Repo-Quellcode bereitstellen (aus Drive-Archiv oder per `git clone`)
3. Modell **aus dem Katalog des Repos** laden (`src/stems/modelCatalog.json`) –
   keine erfundene URL, `sha256` wird geprüft, sobald der Katalog ihn nennt
4. `colab/remote_worker.py` starten: Jobs finden, beanspruchen, verifizieren,
   rechnen (GPU, sonst CPU), Ergebnisse + Hashes zurückschreiben
5. Am Ende zeigt das Notebook, welche Jobs fertig sind

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

# ── Rechnen & Warteschlange ──────────────────────────────────────────────────
GERAET = "auto"              # auto | cuda | cpu
MODELL_ID = ""               # "" = Modell aus dem Job-Manifest; sonst Katalog-ID
PROFIL = ""                  # "" = Profil aus dem Job-Manifest (HIGH_QUALITY)
FEHLGESCHLAGENE_WIEDERHOLEN = True  # True = zuvor fehlgeschlagene Jobs erneut versuchen
ALTE_JOBS_BEREINIGEN = False        # True = erledigte/abgebrochene Jobs aufräumen
MAX_JOBS = 0                 # 0 = so lange arbeiten, bis abgebrochen wird
POLL_SEKUNDEN = 15           # Pause zwischen zwei Durchläufen
ABBRUCH_SEKUNDEN = 5         # alle N s wird cancel.flag AUCH während der Rechnung geprüft
EINMALIG = False             # True = nur einen Durchlauf (für Tests)
VERBOSE = False              # True = ausführlicheres Logging (jede Poll-Runde)
>>>

<<<CELL py
# 1 · Google Drive mounten & Warteschlange prüfen
from google.colab import auth  # type: ignore
auth.authenticate_user()

from google.colab import drive  # type: ignore
drive.mount("/content/drive")

import json, os, pathlib
JOB_ROOT = str(pathlib.Path("/content/drive/MyDrive") / JOB_ORDNER)
jobs_dir = os.path.join(JOB_ROOT, "jobs")
os.makedirs(jobs_dir, exist_ok=True)
print("Jobablage:", JOB_ROOT)

job_dirs = sorted([d for d in os.listdir(jobs_dir) if os.path.isdir(os.path.join(jobs_dir, d))])
if not job_dirs:
    print("\n✓ Warteschlange ist leer (0 Jobs). Neue Aufträge aus dem AirDox Editor erscheinen hier automatisch.")
else:
    print(f"\n▶ Warteschlange ({len(job_dirs)} Job(s)):")
    for idx, name in enumerate(job_dirs, 1):
        mpath = os.path.join(jobs_dir, name, "manifest.json")
        status, track, phase = "unbekannt", name, ""
        if os.path.isfile(mpath):
            try:
                with open(mpath, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                status = data.get("status", "unbekannt")
                track = data.get("trackName") or (data.get("input") or {}).get("fileName") or name
                phase = data.get("phase") or ""
            except Exception:
                pass
        icon = "⏳" if status in ("PENDING", "PREPARING") else "⚙️" if status == "RUNNING" else "✓" if status == "COMPLETED" else "❌"
        print(f"  {idx}. {icon} {track} [{status}] {f'– {phase}' if phase else ''} (ID: {name[:8]}…)")
>>>

<<<CELL py
# 2 · Abhängigkeiten + Quellcode
import os, subprocess, sys

# 2a) Python-Abhängigkeiten installieren ('msst' existiert nicht auf PyPI und würde pip abbrechen)
subprocess.run([
    sys.executable, "-m", "pip", "install", "-q",
    "numpy<=2.2.0", "soundfile", "pyyaml", "ml-collections", "einops", "rotary-embedding-torch", "beartype"
], check=True)

# 2b) Referenz-Architektur (ZFTurbo/Music-Source-Separation-Training) bereitstellen
MSST_DIR = "/content/msst"
if not os.path.isfile(os.path.join(MSST_DIR, "models", "bs_roformer", "bs_roformer.py")):
    print("Klone Referenz-Architektur (ZFTurbo/Music-Source-Separation-Training) …")
    subprocess.run([
        "git", "clone", "--quiet", "--depth", "1",
        "https://github.com/ZFTurbo/Music-Source-Separation-Training.git",
        MSST_DIR
    ], check=True)
os.environ["AIRODOX_MSST_DIR"] = MSST_DIR
print("Referenz-Architektur bereit:", MSST_DIR)

if MSST_DIR not in sys.path:
    sys.path.insert(0, MSST_DIR)
import ml_collections, soundfile, yaml
from models.bs_roformer.bs_roformer import BSRoformer
print("Python-Abhängigkeiten & BS-RoFormer-Architektur erfolgreich geladen.")

REPO_DIR = "/content/airdox"
if os.path.isdir(os.path.join("/content/drive/MyDrive", os.path.dirname(REPO_ARCHIV))) and os.path.isfile(os.path.join("/content/drive/MyDrive", REPO_ARCHIV)):
    os.makedirs(REPO_DIR, exist_ok=True)
    subprocess.run(["tar", "-xzf", os.path.join("/content/drive/MyDrive", REPO_ARCHIV), "-C", REPO_DIR], check=True)
    print("Quellcode aus Drive-Archiv entpackt:", REPO_DIR)
    print(
        "Achtung: Ein Archiv in Drive ist ein eingefrorener Stand. Läuft der Editor mit einer neueren "
        "Fassung, passen Kommandozeile und Jobprotokoll nicht zusammen – dann das Archiv neu bauen "
        "(npm run stems:gate:archive) oder REPO_ARCHIV leeren und aus Git beziehen."
    )
else:
    if not os.path.isdir(os.path.join(REPO_DIR, ".git")):
        subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, REPO_DIR], check=True)
    else:
        subprocess.run(["git", "-C", REPO_DIR, "fetch", "origin", BRANCH, "--depth", "1"], check=False)
        subprocess.run(["git", "-C", REPO_DIR, "reset", "--hard", "FETCH_HEAD"], check=False)
        subprocess.run(["git", "-C", REPO_DIR, "clean", "-fd"], check=False)
    print("Quellcode ausgecheckt:", REPO_DIR)

# Welcher Stand rechnet hier? (Editor-Log und Colab-Ausgabe müssen denselben
# Stand zeigen – sonst passen Worker und Jobprotokoll nicht zusammen.)
stand = subprocess.run(["git", "-C", REPO_DIR, "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
print("Quellcode-Stand:", (stand.stdout or "").strip() or "unbekannt (kein Git)")

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
# 5 · Erst nachsehen, dann rechnen lassen.
#
#     Wichtig: Läuft der Worker, bleibt diese Zelle **absichtlich** offen – er
#     wartet auf Jobs. Alle 60 s erscheint „Warte auf Jobs …“; das ist der
#     Beweis, dass er lebt, kein Hänger. Zelle stoppen = Worker aus (ein
#     halbfertiger Job wird beim nächsten Start wieder aufgenommen).
import os, subprocess, sys, time

def ablage_ansehen(zusatz=None):
    """`--check-store`: Status, Lease, Abbruchfahne und ein Urteil – ohne Rechnen."""
    return subprocess.run(
        [sys.executable, WORKER, "--root", JOB_ROOT, "--check-store", *(zusatz or [])],
        capture_output=True, text=True,
    )

# 5a) Vorflug: Sehen Notebook und Editor dieselbe Ablage, und wartet dort ein Job?
vorflug_zusatz = []
if MODELL_ID:
    vorflug_zusatz += ["--model", MODELL_ID]
vorflug = ablage_ansehen(vorflug_zusatz)
print(vorflug.stdout.strip() or vorflug.stderr.strip())
if vorflug.returncode != 0:
    print("!! Die Ablage ist so nicht benutzbar – der Worker würde nichts finden. Bitte zuerst das Urteil oben klären.")

# 5b) Worker starten
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
if FEHLGESCHLAGENE_WIEDERHOLEN:
    kommando += ["--retry-failed"]
if ALTE_JOBS_BEREINIGEN:
    kommando += ["--clean-finished"]
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
gestartet = time.time()
ergebnis = subprocess.run(kommando, check=False)
laufzeit = time.time() - gestartet

# 5c) Ein sofort beendeter Worker ist der klassische Grund, warum der Editor
#     „Wartet auf den externen Rechner“ zeigt: nichts hat den Job beansprucht.
if ergebnis.returncode != 0:
    print(
        f"!! Der Worker wurde nach {laufzeit:.0f} s mit Code {ergebnis.returncode} beendet. "
        "Der Job bleibt in der Ablage und wird beim nächsten Start wieder aufgenommen – "
        "aber nur, wenn die Ursache oben behoben ist (unbekannte Option, fehlender Adapter, keine Rechte am Ordner)."
    )
else:
    print(f"Worker beendet (Laufzeit {laufzeit:.0f} s).")

# 5d) Nach dem Lauf derselbe Blick wie vorher: was steht jetzt in der Ablage?
nachher = ablage_ansehen()
print(nachher.stdout.strip() or nachher.stderr.strip())
>>>

<<<CELL py
# 6 · Übersicht: welche Jobs liegen in der Ablage, welcher Status?
#     Diese Zelle kommt ohne den Worker aus (sie funktioniert also auch, wenn der
#     Quellcode-Stand defekt ist) und beantwortet die Frage, die der Editor nicht
#     beantworten kann: Hat der Rechner den Job überhaupt gesehen?
import json, os, time

def alter(stempel):
    try:
        return f"vor {int(max(0, time.time() - float(stempel) / 1000))} s"
    except (TypeError, ValueError):
        return "unbekannt"

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
    claim = {}
    try:
        with open(os.path.join(jobs_dir, name, "claim.json"), encoding="utf-8") as handle:
            claim = json.load(handle)
    except Exception:
        claim = {}
    input_datei = os.path.join(jobs_dir, name, "input", os.path.basename(str((data.get("input") or {}).get("fileName") or "")))
    zeile = {
        "job": name,
        "status": data.get("status"),
        "phase": data.get("phase"),
        "model": (data.get("engine") or {}).get("modelId"),
        "device": (data.get("worker") or {}).get("device"),
        "lease": f"{claim.get('id')} ({alter(claim.get('heartbeatAt') or claim.get('claimedAt'))})" if claim else "keine",
        "input": "da" if os.path.isfile(input_datei) else "fehlt/unterwegs",
        "cancel": "JA" if os.path.isfile(os.path.join(jobs_dir, name, "cancel.flag")) else "nein",
    }
    zeilen.append(zeile)
for z in zeilen:
    print(
        f"{z['job']}  {str(z['status']):<10} {str(z['model']):<36} {str(z['device'] or '-'):<8} "
        f"Input {z['input']:<15} Lease {z['lease']:<28} Abbruch {z['cancel']}  {z['phase'] or ''}"
    )
print(f"\n{len(zeilen)} Job(s) in der Ablage.")
print("Der Editor erkennt COMPLETED automatisch und importiert die Stems – Colab muss dafür nichts weiter tun.")

# Und dieselbe Sicht noch einmal mit Urteil: was ist als Nächstes zu tun?
if os.path.isfile(WORKER):
    subprocess.run([sys.executable, WORKER, "--root", JOB_ROOT, "--check-store"], check=False)
>>>

<<<CELL md
### Ablaufspur während eines Jobs

- In der Worker-Zellenausgabe erscheint regelmäßig ein strukturiertes `worker.poll` mit `scanned`, `pending` und `processed`. Im Leerlauf meldet `--idle-log-seconds` zusätzlich, dass die Zelle weiterläuft; ein geänderter Jobbestand wird sofort angezeigt.
- Im Ablage-Root zeigt `worker.status.json` Worker-ID, Host, Gerät/GPU, aktuelle Phase und Heartbeat. Während eines Jobs aktualisiert der Heartbeat-Thread zusätzlich `claim.json` und die globale Statusdatei.
- Für jeden Job enthält `jobs/<jobId>/logs/worker.jsonl` die korrelierbaren Ereignisse (`worker.claimed`, `worker.input_verified`, `worker.inference_started`, Fortschritt, geprüfte Outputs und Abschluss/Fehler); `worker.log` ist die lesbare Ergänzung. Logs sind auf 200 Zeilen begrenzt; Start-/Diagnosemeldungen landen außerdem im Root-`worker.log`.
- Fehlerdetails stehen zusätzlich in `error.json`; vor dem Teilen private Pfade, Dateinamen, Zugangsdaten und Audioinhalte entfernen. Die lokale Simulation belegt nicht, dass Google Drive oder eine echte Colab-Laufzeit synchronisiert hat.
>>>
