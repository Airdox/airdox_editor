# AirDox · Stem-Freigabe auf Google Colab

Dieses Notebook führt **genau den Code aus dem Repo** aus – kein zweites,
frei erfundenes Separation-Skript. Es ist für den einen Schritt gebaut, der in
unserer Entwicklungs-Sandbox blockiert ist: GitHub-Release-Assets (die
trainierten Gewichte) sind dort über `release-assets.githubusercontent.com` /
`objects.githubusercontent.com` nicht erreichbar (`SSL_ERROR_SYSCALL`), npm und
github.com selbst gehen dagegen.

> **Was dieses Notebook beweist – und was nicht.**
>
> Bewiesen wird: das Stem-Isolation-Gate (Teil 2) läuft über die
> Produktionskette `StemSeparationEngine → python/bsroformer_inference.py →
> ZFTurbo-BS-RoFormer` mit **trainierten** Gewichten; das Original bleibt
> bitgenau unverändert; die gemessenen SI-SDR-Werte liegen im Band der
> publizierten Referenz. Außerdem liefert es den `sha256` des Checkpoints, damit
> `modelHash` im Katalog gepinnt werden kann.
>
> **Nicht** bewiesen wird: Windows-/Electron-Verhalten, das native C++-Runtime
> (Punkt 6) und irgendetwas an der Benutzeroberfläche. Colab ist ein
> Linux-Container mit T4 – ein Meilenstein-Gate, kein Ersatz für den
> Packaging-Build.

<<<CELL md
### 0 · Was hier passiert

1. Quellcode aus Google Drive (Archiv von `npm run stems:gate:archive`) **oder** per `git clone`
2. Node + `tsx` – die Testsuite läuft über denselben Runner wie lokal; dazu `soundfile`/`pyyaml`/`auraloss`
3. **Reichweite prüfen** – genau der Test, den die Sandbox nicht bestehen konnte
4. Checkpoint + Config **aus dem Modell-Katalog** laden (`src/stems/modelCatalog.json`, keine erfundene URL), sha256 prüfen
5. `npm run test:stems` (CI-Suite) → danach das **Freigabe-Gate** mit den
   trainierten Gewichten (`npm run test:stems:gate`)
6. Messwerte + `sha256` → Patch-Vorschlag und Archiv nach Google Drive

Das Notebook erfindet nichts: keine Modell-URL (die steht in `src/stems/modelCatalog.json`),
keine eigenen Schwellen (die setzen `src/stems/stemIsolationGate.ts` und
`src/stems/metrics.ts`) und kein grünes Ergebnis – es führt nur aus, was auch
lokal laufen würde, wenn man an die Release-Assets herankäme.

Kein Audio wird verändert: Der Gate behandelt seine Eingabespur read-only und
vergleicht den `sha256` vorher und nachher – er fällt durch, wenn sich etwas
unterscheidet.
>>>

<<<CELL py #@param
# ── Quelle ───────────────────────────────────────────────────────────────────
ARCHIV_IN_DRIVE = "stem-gate-colab.tar.gz"   # Dateiname in My Drive (empfohlen)
REPO_URL = ""                                 # z.B. "https://github.com/Airdox/airdox_editor.git"
BRANCH = "arena/01a09d15-airdox-editor"       # nur benutzt, wenn REPO_URL gesetzt ist

# ── Lauf ───────────────────────────────────────────────────────────────────
GERÄT = "auto"              # auto | cuda | cpu   (cpu = gleicher Pfad, nur langsamer)
PROFIL = "HIGH_QUALITY"     # HIGH_QUALITY | MAXIMUM_QUALITY
PRÄZISION = "f32"           # f32 | f16 | bf16    (f16/bf16 nur auf CUDA; Freigabe: f32)
OVERLAP = ""                # "" = Empfehlung des Modells (4); "1" = bewusster Schnelllauf
FEHLER_BEI_QUALITAET_FAIL = False   # True → Notebook bricht ab, wenn das Gate nicht
                                    # RELEASE_READY meldet (für Nachtläufe sinnvoll)

# ── Ausgabe ──────────────────────────────────────────────────────────────────
DRIVE_ZIELORDNER = "AirDox/stem-gate"
>>>

<<<CELL py
# ── 1 · Umgebung ────────────────────────────────────────────────────────────
import glob, hashlib, json, os, pathlib, platform, shutil, subprocess, sys, time

STEM_HOME = "/content/stem-home"
GATE_OUT = "/content/stem-gate-run"

def run(cmd, check=True, quiet=False):
    """Führt einen Shell-Befehl im Arbeitsordner aus (Standard: /content/airdox)."""
    if not quiet:
        print("$ " + cmd, flush=True)
    proc = subprocess.run(cmd, shell=True, text=True, capture_output=True, cwd=str(work))
    out = (proc.stdout or "") + (proc.stderr or "")
    if out and not quiet:
        print(out[-6000:], flush=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"Befehl fehlgeschlagen ({proc.returncode}): {cmd}\n{out[-2500:]}")
    return proc

work = pathlib.Path("/content/airdox")
os.makedirs(work, exist_ok=True)
print(f"Python   {platform.python_version()}  ({sys.executable})")
print(f"CPU      {platform.machine()} · {os.cpu_count()} Kerne · {work}")
gpu = run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", check=False, quiet=True)
print("GPU      " + (gpu.stdout.strip() if gpu.returncode == 0 else "keine – läuft auf CPU (identischer Pfad, deutlich langsamer)"))
run("command -v git >/dev/null || (apt-get -qq update && apt-get -qq install -y git) >/dev/null 2>&1", check=False)
>>>

<<<CELL py
# ── 2 · Quellcode ───────────────────────────────────────────────────────────
# Empfohlen: das Archiv aus Drive. Es enthält genau den Stand, der gemessen
# werden soll – inklusive modelCatalog.json, damit die Hash-Kette vollständig
# bleibt (Notebook > Katalog > Download > sha256).
src = pathlib.Path("/content/airdox/airdox-editor")
if os.path.isdir(src) and any(os.scandir(src)):
    print(f"✓ {src} existiert bereits – Auschecken übersprungen (Ordner löschen für einen frischen Lauf)")
elif ARCHIV_IN_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    kandidaten = [f"/content/drive/My Drive/{ARCHIV_IN_DRIVE}", f"/content/drive/MyDrive/{ARCHIV_IN_DRIVE}"]
    kandidaten += glob.glob("/content/drive/**/" + os.path.basename(ARCHIV_IN_DRIVE), recursive=True)
    archiv = next((k for k in kandidaten if os.path.exists(k)), None)
    if archiv is None:
        raise RuntimeError(
            f"Archiv '{ARCHIV_IN_DRIVE}' nicht in Drive gefunden.\n"
            "  a) lokal `npm run stems:gate:archive` und die Datei nach My Drive legen, oder\n"
            "  b) REPO_URL im Config-Feld setzen (Branch muss den Stand enthalten)."
        )
    print(f"entpacke {archiv}")
    run(f"tar -xzf {archiv!r}", quiet=True)
elif REPO_URL:
    run(f"git clone --quiet --branch {BRANCH!r} --single-branch {REPO_URL!r} {src}")
else:
    raise RuntimeError("Weder ARCHIV_IN_DRIVE noch REPO_URL gesetzt.")

for pflicht in ["src/stems/modelCatalog.json", "python/bsroformer_inference.py", "tests/stem-isolation-gate-live.test.ts", "scripts/setup-bsroformer-model.sh"]:
    assert os.path.isfile(os.path.join(src, pflicht)), f"Stand unvollständig: {pflicht} fehlt"
stand = run("git -C airdox-editor rev-parse --short HEAD", check=False, quiet=True).stdout.strip()
print(f"✓ Stand: {stand or 'Archiv ohne git-Metadaten'} · {src}")
>>>

<<<CELL py
# ── 3 · Node + Projekt-Abhängigkeiten ────────────────────────────────────────
# Colab bringt teils ein uraltes Node mit; der Runner braucht >= 20. Der
# Tarball von nodejs.org ist der robuste Weg (kein apt-Quellen-Patchen,
# kein halblanges `npm ci -h`, falls Nodesource-Setup scheitert).
node = run("node -v 2>/dev/null || true", quiet=True).stdout.strip()
if not node or int(node.lstrip("v").split(".")[0]) < 20:
    NODE_VERSION = "22.14.0"
    run(
        f"set -e; curl -fsSLo /tmp/node.tar.xz "
        f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz "
        "&& tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && node -v && npm -v"
    )
print("node", run("node -v", quiet=True).stdout.strip(), "· npm", run("npm -v", quiet=True).stdout.strip())
# --omit=optional --ignore-scripts: kein Electron-Binary-Download, kein
# Native-Build von better-sqlite3. Die Freigabe-Suite braucht beides nicht.
run("npm ci --omit=optional --ignore-scripts --no-audit --no-fund")
run("npx tsx --version")
>>>

<<<CELL py
# ── 4 · Python: torch ist auf Colab vorhanden, fehlt nur das Drumherum ───────
run("python -c \"import torch; print('torch', torch.__version__, '· cuda', torch.cuda.is_available())\"")
run("pip install -q --no-input soundfile pyyaml auraloss 2>&1 | tail -3", check=False)
run("python -c \"import torch, soundfile, yaml; print('soundfile', soundfile.__version__, '· yaml ok')\"")
try:
    import auraloss  # wird von der MSST-Architektur für ein paar Verlustfunktionen importiert
    print("auraloss ok")
except Exception as exc:
    print("Hinweis: auraloss nicht importierbar –", exc)
>>>

<<<CELL py
# ── 5 · Der eigentliche Grund für dieses Notebook: Reichweite ───────────────
# Die URLs kommen aus dem Katalog, nicht aus dem Notebook.
os.chdir(src)
catalog = json.load(open("src/stems/modelCatalog.json"))
modell = next(m for m in catalog["models"] if m["id"] == "bsroformer-musdb18hq-4stem-zfturbo")
print("Katalog-Modell  :", modell["id"], modell["version"])
print("Checkpoint-Datei:", modell["checkpoint"]["file"])
print("modelHash im Katalog:", modell.get("modelHash"))

def erreichbar(url, timeout=25):
    import urllib.request
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "airdox-stem-gate"})
        with urllib.request.urlopen(req, timeout=timeout) as antwort:
            return antwort.status, antwort.headers.get("Content-Length")
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"

for url in [u for u in [modell["checkpoint"]["url"], (modell.get("config") or {}).get("url")] if u]:
    print("  ", erreichbar(url), url[:96])
>>>

<<<CELL py
# ── 6 · Gewichte einrichten (Architektur + Checkpoint + Manifest) ───────────
# Das Setup-Skript erfindet keine Quellen: es liest die URLs aus
# modelCatalog.json, prüft sha256 gegen den Katalog und schreibt manifest.json.
# Bei Abbruch bleibt das Manifest unvollständig – ein erfundener Eintrag wird
# bewusst nicht geschrieben.
setup = run(
    f"AIRODOX_STEM_HOME={STEM_HOME} AIRODOX_STEM_PYTHON=$(which python) bash scripts/setup-bsroformer-model.sh",
    check=False,
)
checkpoint = os.path.join(STEM_HOME, "checkpoints", modell["checkpoint"]["file"])
vorhanden = os.path.exists(checkpoint)
print("\nCheckpoint vorhanden:", vorhanden, os.path.getsize(checkpoint) if vorhanden else 0, "Bytes")
if vorhanden:
    sha = hashlib.sha256(open(checkpoint, "rb").read()).hexdigest()
    manifest = json.load(open(os.path.join(STEM_HOME, "manifest.json"))) if os.path.exists(os.path.join(STEM_HOME, "manifest.json")) else {}
    aus_manifest = next((m.get("sha256") for m in (manifest.get("models") or []) if m.get("id") == modell["id"]), "kein Manifest-Eintrag")
    print("sha256 (hier nachgerechnet):", sha)
    print("sha256 (Setup-Manifest)    :", aus_manifest)
    print("sha256 (Katalog, gepinnt)  :", modell.get("modelHash"))
    assert sha == aus_manifest, "Setup-Manifest und Datei stimmen nicht überein"
    if modell.get("modelHash") not in (None, "unverified"):
        assert sha == modell["modelHash"], "Checkpoint passt nicht zum gepinnten modelHash"
        print("✓ passt zum im Katalog gepinnten modelHash")
    else:
        print("→ modelHash ist noch 'unverified'; dieser Lauf liefert den Wert zum Pinnen.")
if not vorhanden:
    raise RuntimeError(
        "Checkpoint nicht geladen – Zelle 5 zeigt, woran es scheitert. Notausgang: Datei im\n"
        f"Browser herunterladen und unter {checkpoint} ablegen, dann diese Zelle erneut laufen lassen."
    )
>>>

<<<CELL py
# ── 7 · Umgebung für die Engine: dieselben Variablen wie im Desktop-Host ────
os.environ["AIRODOX_STEM_HOME"] = STEM_HOME
os.environ["AIRODOX_STEM_PYTHON"] = shutil.which("python")
os.environ["AIRODOX_STEM_CHECKPOINT_DIR"] = os.path.join(STEM_HOME, "checkpoints")
msst = os.path.join(STEM_HOME, "vendor", "msst")
if os.path.isdir(msst):
    os.environ["AIRODOX_MSST_DIR"] = msst
print("AIRODOX_STEM_HOME        =", os.environ["AIRODOX_STEM_HOME"])
print("AIRODOX_STEM_PYTHON      =", os.environ["AIRODOX_STEM_PYTHON"])
print("AIRODOX_STEM_CHECKPOINT_DIR =", os.environ["AIRODOX_STEM_CHECKPOINT_DIR"])
print("AIRODOX_MSST_DIR         =", os.environ.get("AIRODOX_MSST_DIR", "(nicht gesetzt)"))
architektur = (
    "import sys;"
    f"sys.path.insert(0, r'{msst}');"
    "import models.bs_roformer.bs_roformer as m; print('Architektur-Quelle:', m.__file__)"
)
probe = run(f'python -c "{architektur}"', check=False, quiet=True)
if probe.returncode != 0:
    print("Vendor-Checkout nicht nutzbar – installiere das offizielle Paket (nur Architektur, keine Gewichte):")
    run("pip install -q --no-deps msst==0.1.0", check=False)
    run("python -c \"import msst, os; print('Architektur-Quelle:', os.path.join(os.path.dirname(msst.__file__), 'models/bs_roformer/bs_roformer.py'))\"")
else:
    print(probe.stdout.strip())
# Die Engine findet die Architektur über denselben Weg wie der Desktop-Host.
assert os.path.isfile(os.path.join(src, "python/bsroformer_inference.py"))
>>>

<<<CELL py
# ── 8 · Stand muss grün sein, bevor gemessen wird ───────────────────────────
# Die CI-Suite (Registry, Backend-Vertrag, Technical Gate, Stem Isolation Gate
# gegen den Double, Job-Schicht, IPC-Vertrag). Fällt sie aus, ist jeder Messwert
# wertlos – deshalb hier hartes Abbruchkriterium.
run("npm run test:stems")
>>>

<<<CELL py
# ── 9 · FREIGABE-LAUF: Stem Isolation Gate mit trainierten Gewichten ────────
# Dieselbe Suite wie lokal – nur mit den Umgebungsvariablen, die der
# Runner plattformneutral über --set-env weitergibt (Windows-cmd kennt kein
# `KEY=WERT command`). npm run test:stems:gate ist genau dieser Aufruf.
flags = [
    "--set-env AIRODOX_STEM_ALLOW_QUALITY_RUN=1",   # ohne dieses Flag skippt die Suite
    f"--set-env AIRODOX_STEM_GATE_OUT={GATE_OUT}",
    "--set-env AIRODOX_STEM_GATE_DEVICE=" + GERÄT,
    "--set-env AIRODOX_STEM_GATE_PROFILE=" + PROFIL,
    "--set-env AIRODOX_STEM_GATE_PRECISION=" + PRÄZISION,
    "--set-env AIRODOX_STEM_GATE_EMIT_PATCH=1",     # sha256 als Patch-Vorschlag ablegen
]
if OVERLAP:
    flags.append("--set-env AIRODOX_STEM_GATE_OVERLAP=" + str(OVERLAP))
started = time.time()
lauf = run("node scripts/run-tests.mjs --only stem-isolation-gate-live " + " ".join(flags), check=False)
print(f"\nLaufzeit {time.time() - started:.0f} s · Exit-Code {lauf.returncode}")
if lauf.returncode != 0:
    print("Der Lauf ist fehlgeschlagen – Ausgabe oben. Kein Freigabe-Ergebnis.")
>>>

<<<CELL py
# ── 10 · Ergebnis ───────────────────────────────────────────────────────────
summary_path = os.path.join(GATE_OUT, "stem-gate-summary.json")
if not os.path.exists(summary_path):
    print("Kein stem-gate-summary.json: der Lauf ist vor der Messung abgebrochen (Log oben).")
    raise SystemExit
summary = json.load(open(summary_path))
entscheidung = summary["releaseDecision"]
print("=" * 74)
print(f"  Entscheidung           {entscheidung}")
print(f"  Technik / Qualität     {summary['technicalPass']} / {summary['qualityPass']}")
print(f"  Gesamtscore            {summary['overallScore']}/10")
print(f"  Rekombinations-SDR     {summary['recombinationErrorDb']} dB")
print(f"  Original-Hash gleich   {summary['originalHashBefore'] == summary['originalHashAfter']}")
print(f"  Profil/Gerät/Präzision {summary['profile']}/{summary['device']}/{summary['precision']} · Overlap {OVERLAP or 'Deskriptor'}")
print("-" * 74)
for stem_id, zeile in summary["siSdrByStem"].items():
    band = "im Band" if zeile["withinBand"] else "AUSSER BAND"
    print(f"  {stem_id:<7} SI-SDR {zeile['siSdrDb']:>7} dB · publiziert {zeile['published']} dB · {band}")
print("-" * 74)
print("  Checkpoint-sha256 (gemessen):", summary["measuredSha256"])
print("  Katalog-Eintrag modelHash    :", summary["catalogModelHash"])
nicht_bestanden = [c for c in summary["checks"] if not c["pass"]]
if nicht_bestanden:
    print("  nicht bestandene Prüfungen:")
    for check in nicht_bestanden:
        print(f"    ✘ {check['id']}: {check['detail']}")
print("=" * 74)
if entscheidung == "RELEASE_READY":
    print("Freigabe erteilt – für GENAU diesen modelHash. Ohne Pin im Katalog ist der Lauf")
    print("zwar reproduzierbar, aber nicht beweisbar: modelHash eintragen (Patch unten).")
else:
    print("Kein Freigabe-Status. Separation bleibt damit als Vorschau gekennzeichnet – die")
    print("Zahlen sind dokumentiert, aber das Qualitäts-Gate ist ausdrücklich nicht erfüllt.")
if FEHLER_BEI_QUALITAET_FAIL and entscheidung != "RELEASE_READY":
    raise SystemExit("Gate nicht RELEASE_READY (FEHLER_BEI_QUALITAET_FAIL=True).")
>>>

<<<CELL py
# ── 11 · Ablage in Drive + Patch-Vorschlag ──────────────────────────────────
stamp = time.strftime("%Y%m%d-%H%M")
ziel = None
try:
    ziel = f"/content/drive/My Drive/{DRIVE_ZIELORDNER}/{stamp}"
    os.makedirs(ziel, exist_ok=True)
except Exception as exc:
    print("Drive nicht erreichbar – Ergebnis bleibt in", GATE_OUT, "(", exc, ")")

patch = os.path.join(GATE_OUT, "model-hash-patch.json")
if os.path.exists(patch):
    print(open(patch).read())
    if ziel:
        shutil.copy(patch, os.path.join(ziel, "model-hash-patch.json"))
if os.path.exists(os.path.join(GATE_OUT, "test_run", "report", "report.html")):
    print("HTML-Report:", os.path.join(GATE_OUT, "test_run", "report", "report.html"))
if ziel:
    archiv = shutil.make_archive(os.path.join(ziel, "stem-gate-run"), "gztar", root_dir="/content", base_dir="stem-gate-run")
    print("Archiv nach Drive:", archiv)
print("\nDamit der Lauf im Repo nachprüfbar ist, müssen drei Dinge committet werden:")
print(" 1) modelHash aus model-hash-patch.json → src/stems/modelCatalog.json")
print(" 2) stem-gate-summary.json (Anhang im PR oder docs/releases/)")
print(" 3) Doku-Abschnitt 'Qualitätsfreigabe' auf diesen Stand ziehen")
print("    und: welcher Stand gemessen wurde –", stand or "Archiv ohne git-Metadaten")
>>>

<<<CELL md
### Ergebnisse richtig einordnen

| Anzeige im Notebook | Bedeutung für die Freigabe |
|---|---|
| `RELEASE_READY` + `sha256` gepinnt | Separation ist mit genau diesem Checkpoint produktionsreif. |
| `TECHNICAL_PASS_QUALITY_FAIL` | Pipeline funktioniert, Modell trennt nicht gut genug auf diesem Goldstandard-Track. **Nicht** produktionsreif; Messwerte zeigen, welcher Stem die Schwelle reißt. |
| `TECHNICAL_FAIL` | Etwas in der Kette ist kaputt (Adapter, Config, `stem_order`, Laufzeitumgebung) – Qualitätsfrage noch gar nicht gestellt. |
| `AUSSER BAND` bei einem Stem | Der Checkpoint/die Config passt nicht zum Katalog-Eintrag (andere Gewichte, andere Stem-Reihenfolge) – Lauf verwerfen, nicht schönreden. |
| Setup-Skript bricht ab | Keine Gewichte, kein Manifest-Eintrag, kein Freigabe-Lauf. Genau das soll passieren. |

Ein Colab-Lauf ersetzt außerdem **nicht** den Windows-Packaging-Build (CI:
`windows-build.yml`) und nicht Punkt 6 (natives C++-Runtime, GGUF/SafeTensors).
>>>
