# AirDox · Einen Stem-Auftrag interaktiv mit Colab Free berechnen

Dieses Notebook verarbeitet **einen von dir ausgewählten Auftrag** und endet
danach. Du startest jeden Lauf bewusst im Notebook. Der Editor importiert fertige
Stems aus Drive und speichert sie dauerhaft auf deinem Rechner.

Es werden keine kostenpflichtigen APIs, Cloud-VMs, Abos oder Compute Units
gebucht. Verwende dein kostenloses Colab-Konto. Ohne verfügbare GPU hält der
Ablauf an; es gibt keinen Wechsel zu einem bezahlten Angebot.

Colab Free garantiert weder GPU noch Laufzeit. Google priorisiert interaktive
Notebooks und schränkt unter anderem verteilte Worker und Fernsteuerung ein.
Dieser begrenzte Notebook-Ablauf ist keine Zusage von Google zur Zulässigkeit
einer bestimmten Integration. Für verlässlich unbeaufsichtigten Betrieb verwende
den lokalen Editor. [Google Colab FAQ](https://research.google.com/colaboratory/faq.html)

Voraussetzungen: Google-Konto, freier Drive-Speicher, synchronisierter Jobordner
und zum Editor passender Quellcode. Die Audio-Arbeitskopie wird zu Google
übertragen. Originaldateien werden nicht verändert. Die Dauer hängt von Modell,
Tracklänge und zugeteilter GPU ab.

<<<CELL md
### Ablauf

1. Im Editor „Externe Zerlegung (Google Colab)“ starten und Drive-Sync abwarten.
2. In Colab eine kostenlose GPU-Laufzeit auswählen, falls verfügbar.
3. Einstellungen und Zelle 1 ausführen. Bei mehreren Aufträgen die vollständige
   `JOB_ID` aus der Liste eintragen und diese beiden Zellen erneut ausführen.
4. Zellen 2–5 ausführen. Zelle 5 berechnet ausschließlich den ausgewählten Job.
5. Nach `COMPLETED` den lokalen Import abwarten, dann Colab-Laufzeit trennen.
   Weitere Jobs erfordern eine neue bewusste Auswahl in Zelle 1.

Bleibt der Editor auf „Wartet auf den externen Rechner“, prüfe denselben
Google-Account und `JOB_ORDNER`, den Uploadstatus und die Ausgabe von Zelle 5.
Unterbrochene Inferenz beginnt beim nächsten Versuch von vorn; bereits fertige
Jobs werden nicht erneut gerechnet.

Für einen unabhängigen Praxistest `PRAKTIKUM_SELBSTTEST = True` setzen und alle
Zellen nacheinander ausführen. Das Notebook erzeugt dann selbst einen kurzen
Auftrag in Drive, berechnet ihn auf der GPU und prüft alle vier Ausgaben. Ein
vorhandener Editor-Auftrag ist dafür nicht erforderlich. Danach die Einstellung
für normale Aufträge wieder auf `False` setzen.
>>>

<<<CELL py #@param
JOB_ORDNER = "airdox-stem-jobs"  # Unterordner in My Drive
JOB_ID = ""  # Leer nur bei genau einem offenen Auftrag; sonst vollständige ID
FEHLGESCHLAGENE_WIEDERHOLEN = False  # Nur für den ausgewählten Job
REPO_ARCHIV = "airdox-stem-jobs/airdox-editor-src.tar.gz"
REPO_URL = "https://github.com/Airdox/airdox_editor.git"
BRANCH = "stem-colab-20261101-r2"  # Fester Release-Stand passend zu dieser Windows-Ausgabe
MSST_COMMIT = "9cc76c03ccd4da5ddf3477e93d386a1648a77732"
ABBRUCH_SEKUNDEN = 5
PRAKTIKUM_SELBSTTEST = False  # True: unabhängiger kurzer GPU-/Drive-Test ohne Editor-Auftrag
>>>

<<<CELL py
# 1 · GPU und genau einen Auftrag prüfen, bevor Modelle geladen werden
import json, os, pathlib, re, torch, uuid
SELECTED_JOB_ID = None  # Nach einem Fehler keine alte Auswahl weiterverwenden.
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
if PRAKTIKUM_SELBSTTEST:
    jobs_dir.mkdir(parents=True, exist_ok=True)
    SELECTED_JOB_ID = "colab-selftest-" + uuid.uuid4().hex[:12]
    MODELL_ID = "bsroformer-musdb18hq-4stem-zfturbo"
    PROFIL = "HIGH_QUALITY"
else:
    if not jobs_dir.is_dir():
        raise RuntimeError("Keine Jobablage gefunden. Auftrag im Editor starten und Drive-Sync abwarten.")
    offen = {}
    for folder in sorted(jobs_dir.iterdir()):
        if not folder.is_dir() or not re.fullmatch(r"[A-Za-z0-9_-]+", folder.name):
            continue
        try:
            data = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        print(folder.name, data.get("status"), (data.get("engine") or {}).get("modelId"))
        if data.get("status") in {"PENDING", "PREPARING", "RUNNING"} or (FEHLGESCHLAGENE_WIEDERHOLEN and data.get("status") == "FAILED"):
            offen[folder.name] = data
    auswahl = JOB_ID.strip()
    if not auswahl:
        if len(offen) != 1:
            raise RuntimeError(f"{len(offen)} offene Aufträge: einen Auftrag bereitstellen bzw. dessen vollständige JOB_ID wählen.")
        auswahl = next(iter(offen))
    if auswahl not in offen:
        raise RuntimeError("Auftrag fehlt, ist fertig/abgebrochen oder benötigt eine ausdrückliche Fehlerwiederholung.")
    SELECTED_MANIFEST = offen[auswahl]
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
# 2 · Passenden Editor-Quellcode und Referenzarchitektur bereitstellen
import subprocess, sys, tarfile
assert SELECTED_JOB_ID, "Zuerst Zelle 1 erfolgreich ausführen."
REPO_DIR = "/content/airdox"
archive = drive_root / REPO_ARCHIV if REPO_ARCHIV and not PRAKTIKUM_SELBSTTEST else None
if archive and archive.is_file():
    os.makedirs(REPO_DIR, exist_ok=True)
    with tarfile.open(archive, "r:gz") as bundle:
        bundle.extractall(REPO_DIR, filter="data")
    # Das bereitgestellte Archiv enthält den Wurzelordner airdox-editor/.
    if os.path.isfile(os.path.join(REPO_DIR, "airdox-editor", "colab", "remote_worker.py")):
        REPO_DIR = os.path.join(REPO_DIR, "airdox-editor")
    print("Quellcode aus Archiv. Bei Editor-Updates Archiv mit npm run stems:gate:archive erneuern.")
elif not os.path.isdir(REPO_DIR):
    subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, REPO_DIR], check=True)
else:
    print("Vorhandenen Quellcode wiederverwendet. Für Versionswechsel eine frische Laufzeit starten.")
print("AirDox-Quellstand:", subprocess.check_output(["git", "-C", REPO_DIR, "rev-parse", "HEAD"], text=True).strip() if os.path.isdir(os.path.join(REPO_DIR, ".git")) else "Drive-Archiv")
WORKER = os.path.join(REPO_DIR, "colab", "remote_worker.py")
ADAPTER = os.path.join(REPO_DIR, "python", "bsroformer_inference.py")
assert os.path.isfile(WORKER) and os.path.isfile(ADAPTER), "Quellcode-Archiv unvollständig."
help_result = subprocess.run([sys.executable, WORKER, "--help"], capture_output=True, text=True, check=True)
assert "--job-id" in help_result.stdout, "Archiv/Branch ist zu alt: neuen Quellcode mit --job-id bereitstellen."
# Colabs CUDA-fähiges PyTorch beibehalten; nur benötigte Zusatzpakete installieren.
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
# 3 · Nur das ausgewählte Modell laden und vor Verwendung prüfen
import hashlib, urllib.request
READY_JOB_ID = None
assert SELECTED_JOB_ID, "Zuerst Zelle 1 ausführen."
with open(os.path.join(REPO_DIR, "src", "stems", "modelCatalog.json"), encoding="utf-8") as handle:
    katalog = json.load(handle)
modell = next((m for m in katalog["models"] if m["id"] == MODELL_ID), None)
assert modell is not None, f"Modell fehlt im Katalog: {MODELL_ID}"
assert modell.get("family") == "bs_roformer" or modell.get("architecture") == "BS-RoFormer", "Dieses Notebook unterstützt den BS-RoFormer-HQ-Pfad."
MODELL_DIR = "/content/models"
os.makedirs(MODELL_DIR, exist_ok=True)
def sha256(datei):
    digest = hashlib.sha256()
    with open(datei, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
def lade(artefakt):
    ziel = os.path.join(MODELL_DIR, os.path.basename(artefakt["file"]))
    erwartet = artefakt.get("sha256")
    assert erwartet and erwartet != "unverified", f"Kein verifizierter Hash im Katalog: {artefakt['file']}"
    if os.path.isfile(ziel) and sha256(ziel) == erwartet:
        print("Verifiziert wiederverwendet:", os.path.basename(ziel))
        return
    zwischen = ziel + ".part"
    urllib.request.urlretrieve(artefakt["url"], zwischen)
    assert sha256(zwischen) == erwartet, f"Download-Hash stimmt nicht: {artefakt['file']}"
    os.replace(zwischen, ziel)
    print("Geladen und verifiziert:", os.path.basename(ziel))
lade(modell["checkpoint"])
if modell.get("config", {}).get("url"):
    lade(modell["config"])
READY_JOB_ID = SELECTED_JOB_ID
>>>

<<<CELL py #@param
# 3b · Vollständiger Colab-Praxistest (optional, erzeugt keinen echten Editor-Auftrag)
if PRAKTIKUM_SELBSTTEST:
    import hashlib, math, struct, uuid, wave, time
    from datetime import datetime, timezone
    assert READY_JOB_ID == SELECTED_JOB_ID and torch.cuda.is_available(), "Zellen 1–3 zuerst erfolgreich ausführen."
    test_id = SELECTED_JOB_ID
    test_dir = pathlib.Path(JOB_ROOT) / "jobs" / test_id
    input_dir, output_dir = test_dir / "input", test_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=False)
    output_dir.mkdir(parents=True, exist_ok=True)
    wav_path = input_dir / "selftest.wav"
    rate, frames = 44100, 44100
    pcm = bytearray()
    for i in range(frames):
        tone = 8500 * math.sin(2 * math.pi * 220 * i / rate) + 3500 * math.sin(2 * math.pi * 660 * i / rate)
        beat = 7000 * math.exp(-((i % 11025) / 550) ** 2)
        sample = max(-32768, min(32767, int(tone + beat)))
        pcm.extend(struct.pack("<hh", sample, sample))
    with wave.open(str(wav_path), "wb") as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(pcm)
    digest = sha256(str(wav_path))
    now = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schemaVersion": 1, "jobId": test_id, "createdAt": now, "updatedAt": now,
        "status": "PENDING", "phase": "Praxistest", "percent": 0,
        "origin": {"app": "airdox_SMART_Editor", "version": "colab-selftest"},
        "idempotencyKey": digest,
        "input": {"fileName": "selftest.wav", "relativePath": f"jobs/{test_id}/input/selftest.wav", "sha256": digest, "bytes": wav_path.stat().st_size},
        "engine": {"backend": "python-torch", "family": "bs_roformer", "modelId": modell["id"], "profile": "HIGH_QUALITY", "stems": modell["stemOrder"], "stemOrder": modell["stemOrder"], "chunkSizeSamples": modell["chunkSizeSamples"], "numOverlap": modell["qualityProfile"]["numOverlap"]["HIGH_QUALITY"], "checkpoint": {"file": modell["checkpoint"]["file"]}, "config": {"file": modell["config"]["file"]}},
        "output": {"stems": []}
    }
    (test_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    cmd = [sys.executable, WORKER, "--root", JOB_ROOT, "--job-id", test_id, "--once", "--max-jobs", "1", "--model-dir", MODELL_DIR, "--adapter", ADAPTER, "--work-dir", "/content/airdox-selftest-work", "--device", "cuda", "--model", modell["id"], "--profile", "HIGH_QUALITY", "--worker", f"colab-selftest-{os.getpid()}"]
    started = time.monotonic(); subprocess.run(cmd, check=True)
    final = json.loads((test_dir / "manifest.json").read_text(encoding="utf-8"))
    assert final.get("status") == "COMPLETED", final
    import soundfile as sf
    stems = final["output"]["stems"]
    files = [test_dir / "output" / stem["fileName"] for stem in stems]
    assert {stem["id"] for stem in stems} == {"drums", "bass", "other", "vocals"}, stems
    assert len(files) == 4 and (output_dir / "result.json").is_file(), files
    hashes = []
    for stem, path in zip(stems, files):
        assert path.is_file() and path.stat().st_size == stem["bytes"], path
        actual = sha256(str(path))
        assert actual == stem["sha256"], (stem["id"], actual)
        info = sf.info(str(path))
        assert info.samplerate == rate and info.channels == 2 and info.frames == frames, (stem["id"], info)
        hashes.append(actual)
    assert len(set(hashes)) == 4, "Vier unterschiedliche Stems erwartet"
    report = {"jobId": test_id, "status": final["status"], "gpu": torch.cuda.get_device_name(0), "seconds": round(time.monotonic() - started, 1), "outputs": [{"name": p.name, "sha256": h} for p, h in zip(files, hashes)]}
    (test_dir / "colab-selftest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("COLAB-PRAXISTEST BESTANDEN:", json.dumps(report, ensure_ascii=False))
>>>

<<<CELL py
# 4 · Laufbedingungen nochmals prüfen
assert SELECTED_JOB_ID and torch.cuda.is_available(), "Auftrag oder GPU fehlt."
print("Genau ein Auftrag:", SELECTED_JOB_ID, "| GPU:", torch.cuda.get_device_name(0))
print("Audio und Zwischenergebnisse liegen während der Inferenz unter /content/airdox-work.")
print("Kein Warten auf Folgeaufträge oder kostenpflichtiger Ausweichdienst.")
>>>

<<<CELL py
# 5 · Ausgewählten Auftrag einmal ausführen, Ergebnis prüfen, dann enden
import time
assert SELECTED_JOB_ID and torch.cuda.is_available(), "Zuerst Auftrag und GPU prüfen."
assert READY_JOB_ID == SELECTED_JOB_ID, "Zelle 3 für den ausgewählten Auftrag ausführen."
kommando = [sys.executable, WORKER, "--root", JOB_ROOT,
    "--job-id", SELECTED_JOB_ID, "--once", "--max-jobs", "1",
    "--model-dir", MODELL_DIR, "--adapter", ADAPTER,
    "--work-dir", "/content/airdox-work", "--device", "cuda",
    "--model", MODELL_ID, "--profile", PROFIL,
    "--cancel-poll", str(ABBRUCH_SEKUNDEN), "--worker", f"colab-{os.getpid()}"]
if FEHLGESCHLAGENE_WIEDERHOLEN:
    kommando += ["--retry-failed"]
subprocess.run([sys.executable, WORKER, "--root", JOB_ROOT, "--job-id", SELECTED_JOB_ID, "--check-store"], check=True)
gestartet = time.monotonic()
subprocess.run(kommando, check=True)
with open(os.path.join(JOB_ROOT, "jobs", SELECTED_JOB_ID, "manifest.json"), encoding="utf-8") as handle:
    ergebnis = json.load(handle)
print("Status:", ergebnis["status"], "| Laufzeit:", round(time.monotonic() - gestartet, 1), "s")
if ergebnis["status"] != "COMPLETED":
    raise RuntimeError(f"Auftrag nicht abgeschlossen: {ergebnis.get('phase')} | {ergebnis.get('error')}. Keine automatische Wiederholung.")
print("Stems liegen in Drive. Lokalen Import abwarten, dann Laufzeit trennen.")
>>>

<<<CELL md
### Diagnose und Wiederverwendung

Pro Auftrag liegen Manifest, Ergebnis-Hashes und begrenzte Logs unter
`jobs/<JobId>/`. Die Berechnung kopiert das Audio auf die lokale Colab-Platte;
fertige Stems werden anschließend nach Drive geschrieben. Bei Abbruch im Editor
wird `cancel.flag` während der Rechnung geprüft. Eine Laufzeitunterbrechung kann
einen Neustart der Berechnung erfordern; `COMPLETED` wird nicht erneut gerechnet.

Die dauerhaft importierten Ergebnisse gehören in den lokalen `Separation`-Ordner,
nicht allein auf die flüchtige Colab-Platte. Spätere Wiederverwendung im Editor
benötigt weder GPU-Zeit noch einen erneuten Upload.

Die Python-Abhängigkeiten und GPU-Inferenz müssen in der tatsächlich zugeteilten
Colab-Laufzeit geprüft werden. Lokale Protokolltests ersetzen diesen Test nicht.
>>>
