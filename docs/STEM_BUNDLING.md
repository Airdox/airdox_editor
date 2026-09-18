# Stem-Engine bündeln – Gewichte und Runtime in den Windows-Build

**Stand: 18.09.2026**

Diese Anleitung beantwortet die Frage „Warum steht da *keine Gewichte* – und wie
verschwindet das?" und beschreibt den **Offline-Weg**: Python-Runtime und
BS-RoFormer-Checkpoint liegen im Build, die Zielmaschine braucht danach weder
Python noch Internet.

---


> **DJ-/ONNX-Pfad:** Für den schnellen In-Memory-Pfad (ohne Python, ohne
> Chunk-Dateien) gibt es ein zweites, optionales Modell: `htdemucs_fp16weights.onnx`.
> Bundling, Provider-Auswahl und Diagnose stehen in **`docs/STEM_ONNX_FASTPATH.md`**.

## 1. Warum überhaupt „keine Gewichte"?

Der Katalog (`src/stems/modelCatalog.json`) beschreibt Modelle, aber er enthält
sie nicht. `resources/models/` und `resources/stem-runtime/` enthalten im Repo
nur Platzhalter-READMEs. Ohne Dateien meldet die Engine für jedes Profil
`available: false`; die UI schreibt dann an den Profil-Button **„keine Gewichte"**
(`DeckStemsControl.tsx`) und nennt im Tooltip den konkreten Grund, z. B.

```
PREVIEW        htdemucs-ft-4stem          Checkpoint fehlt: htdemucs_ft | model_hash "unverified"
BALANCED/HIGH  bsroformer-musdb18hq-4stem Checkpoint fehlt: model_bs_roformer_ep_17_sdr_9.6568.ckpt
HQ / MAX                                       | Config fehlt: config_bs_roformer_384_8_2_485100.yaml
```

Ein Jobstart wird dann mit `MODEL_MISSING` abgelehnt – **absichtlich**: seit dem
Repair vom 18.09.2026 gibt es keinen spektralen Fallback mehr, der Pseudo-Stems
als Trennung ausgibt (§2, §38). Es fehlen schlicht die Gewichte.

Zwei Wege führen zu Gewichten:

| Weg | Voraussetzung | Ergebnis |
| --- | --- | --- |
| **In-App-Installation** (Dialog „BS-RoFormer jetzt installieren") | Python **3.10–3.12** auf dem Zielrechner + Internet | Runtime + Gewichte in `%APPDATA%/airdox_SMART_Editor/stems/` |
| **Bundling** (dieses Dokument) | Build-Rechner mit Internet | Runtime + Gewichte im Build, Zielrechner offline-fähig |

Der In-App-Weg scheitert auf Rechnern mit nur Python 3.13/3.14 – genau der Fall
aus dem Produktionslog (`Python 3.14 wird nicht unterstützt`). Deshalb der
Bundle-Weg.

---

## 2. Bundling in drei Schritten (Build-Rechner)

```powershell
cd airdox_editor
npm ci

# 1) Python-Runtime nach resources/stem-runtime (relokatierbar, ~1.2 GB nach Paketen)
npm run stems:runtime

# 2) Standard-Set nach resources/models (669 MiB):
#    BS-RoFormer-Checkpoint + Config (503 MiB, sha256-geprüft) und
#    HT-Demucs-ONNX für den Fast-Path (166 MiB)
npm run stems:bundle
npm run stems:bundle -- --models bsroformer-musdb18hq-4stem-zfturbo   # nur Studio
npm run stems:bundle -- --models htdemucs-onnx-4stem-fp16             # nur Fast-Path

# 3) Windows-Artefakte bauen (portable EXE + NSIS-Installer)
npm run package:win
```

Ergebnis:

```
resources/stem-runtime/            python.exe, Lib/, Scripts/ (torch, torchaudio, msst, soundfile …)
resources/models/
  model_bs_roformer_ep_17_sdr_9.6568.ckpt     (~503 MiB, sha256 3e9daecd…5868fb)
  config_bs_roformer_384_8_2_485100.yaml
  bundle-manifest.json                        (was wurde wann gebündelt)
release/airdox_SMART_Editor-<version>-portable.exe   (~1.7 GB)
```

Beides landet über `extraResources` + `asarUnpack` (siehe `package.json`) neben
der `app.asar` und wird von `resolveStemRuntime()` / `resolveStemModel()`
gefunden – noch vor `%APPDATA%`.

### Prüfen, ohne zu bauen

```powershell
npm run stems:bundle:check     # nur Bestand prüfen, schreibt nichts
npm run stems:diagnose         # 11 Preflight-Checks + Modell-/Runtime-Pfade
```

`stems:diagnose` muss `Engine: READY` und `Model Status: AVAILABLE` zeigen. In
der App selbst: Stems-Leiste → **Preflight prüfen**.

---

## 3. Details und Optionen

### Runtime (`npm run stems:runtime`)

| Option | Bedeutung |
| --- | --- |
| *(keine)* | python-build-standalone, Architektur `install_only` – **relokatierbar**, richtig für die portable EXE (die sich bei jedem Start in einen anderen Temp-Ordner entpackt) |
| `--mode venv` | `python -m venv` aus einem lokalen Python 3.10–3.12. Nur für den NSIS-Installer mit stabilem Installationsordner; ein venv ist **nicht** relokatierbar |
| `--python 3.12` | andere Minor-Version (Standard 3.11) |
| `--target <dir>` | anderes Ziel (Standard `resources/stem-runtime`) |
| `--torch-index <url\|pypi>` | Spiegel/Proxy statt `https://download.pytorch.org/whl/cpu` |
| `--skip-packages` | nur Interpreter, keine Pakete |
| `--dry-run`, `--force` | nur anzeigen bzw. Ziel neu aufbauen |

Gepinnt sind dieselben Versionen wie im In-App-Installer
(`python/install_bsroformer.py`): **torch 2.5.1 / torchaudio 2.5.1 (CPU)**,
`msst 0.1.0`, `soundfile 0.13.1`, `numpy 1.26.4`, `PyYAML 6.0.2` u. a.

### Gewichte (`npm run stems:bundle`)

| Option | Bedeutung |
| --- | --- |
| *(keine)* | Standard-Set: `bsroformer-musdb18hq-4stem-zfturbo` **und** `htdemucs-onnx-4stem-fp16` in `resources/models` |
| `bsroformer-musdb18hq-4stem-zfturbo` | nur der Studio-Pfad (Checkpoint + Config, 503 MiB) |
| `htdemucs-onnx-4stem-fp16` | nur der DJ-Fast-Path (ein `.onnx`, 166 MiB) |
| `--models id1,id2` | weitere/andere Katalogeinträge |
| `--source <dir>` | lokale Kopien statt Netz (Firewall, Mirror, USB-Stick) |
| `--check-only` | nichts schreiben, nur Hash/Präsenz prüfen (CI-Freigabe) |
| `--dry-run` | nur zeigen, was geladen würde |
| `--force` | vorhandene Dateien neu laden |
| `--target <dir>` | anderes Ziel |

Downloads werden als `.part` geschrieben und erst nach passendem SHA256
aktiviert; ein Hash-Fehler hinterlässt keine halbe Datei. Der Checkpoint wird
**nicht** versioniert – `resources/models/*` ist per `.gitignore` ausgenommen.

### Firmennetz / TLS-Inspektion

Node bringt eigene CA-Zertifikate mit; scheitert `fetch`, weichen beide Skripte
automatisch auf `curl` aus (ab Windows 10 enthalten). Bleibt der Download
blockiert, hilft `--source` (vorab geladene Dateien) oder ein Spiegel über
`--torch-index`.

---

## 4. Nach dem Fix: was „Vorschau" jetzt macht

Das Vorschau-Profil zeigt auf **htdemucs** (schnell) *und* ist im Katalog auch
für **BS-RoFormer** deklariert. Die Auswahl nimmt jetzt das erste Modell, dessen
Dateien tatsächlich vorhanden sind:

* nur BS-RoFormer installiert → **Vorschau läuft über BS-RoFormer** (2 Overlaps statt 4),
* Demucs-Gewichte zusätzlich vorhanden → Vorschau nutzt wieder htdemucs,
* gar nichts installiert → wie bisher: `htdemucs-ft-4stem` mit Grund „Checkpoint fehlt …".

Die Demucs-Gewichte sind weiterhin optional; sie werden von keinem Installer
ausgeliefert. Ein Nutzer kann also mit **einer** Installation alle fünf Profile
bedienen.

## 5. Bekannte Grenzen

* Die Runtime-Prüfung (`RUNTIME_OK`, torch/torchaudio/msst/soundfile) läuft
  automatisch am Ende von `stems:runtime`; die eigentliche 4-Stem-Inferenz
  gehört trotzdem einmal auf die Zielhardware (`npm run test:stems:gate` mit
  echter Datei).
* CPU-Inferenz ist langsam: BS-RoFormer auf 2 Kernen braucht für einen
  6-Minuten-Track Stunden. Für echte Arbeit ist eine GPU oder eine kürzere
  Auswahl sinnvoll.
* Der portable Build wächst auf ~1.7 GB (mit beiden Modellen); für schlanke Builds ohne Runtime gibt
  es weiterhin den In-App-Installer (Python 3.10–3.12 vorausgesetzt).
