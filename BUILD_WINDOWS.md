# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-0.4.1-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-0.4.1-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)

Der Basis-Build benötigt **kein** Visual Studio: XML-/ANLZ-Import, Audio-Editor
und Export funktionieren vollständig. Das optionale SQLCipher-Modul ist per
`"npmRebuild": false` abgeschaltet, sodass der Build auch in Pfaden **mit
Leerzeichen** und ohne C++-Toolchain durchläuft.

## Bauen (PowerShell – Windows)

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor
npm ci
npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`.

## Automatischer Build (GitHub Actions)

Der Workflow `.github/workflows/windows-build.yml` baut auf jedem Push auf
`main`, auf Tags `v*` und einmal täglich um 03:00 UTC (05:00 DE) automatisch
beide Windows-Artefakte und lädt sie als Artifact (30 Tage) hoch. Bei einem
Tag (z. B. `git tag v0.4.1 && git push --tags`) wird automatisch ein GitHub
Release mit den `.exe`-Dateien erzeugt.

## Optional: Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import (`better-sqlite3-multiple-ciphers`) ist optional. Ohne ihn bleibt
der XML-/ANLZ-Import voll funktionsfähig; die App meldet den nicht verfügbaren
DB-Import nachvollziehbar. Zum Aktivieren:

1. Visual Studio **Build Tools** mit „Desktopentwicklung mit C++“ installieren.
2. Modul für Electron kompilieren und erneut bauen:
   ```powershell
   npm run rebuild:electron
   npm run package:win
   ```

## Hinweise

- **Read-Only-Garantie:** Original-Audio, XML, ANLZ und Datenbanken werden
  ausschließlich lesend geöffnet; Exporte/Projektdateien als neue Datei
  gespeichert (`electron/pathGuard.cjs`).
- Die App läuft im Produktionsmodus über ein eigenes privilegiertes Protokoll
  `airdox://app/`, sodass CORS-/File-Probleme (weisser Bildschirm) auch bei
  Installation in Programme-Ordner mit Leerzeichen nicht mehr auftreten.
- Die Build-Artefakte (`dist/`, `release/`) sind per `.gitignore` ausgenommen.

## BS-RoFormer in der gepackten App nachinstallieren

Der Button **„BS-RoFormer installieren“** installiert die primäre Engine, nicht
mehr den alten Demucs-Pfad. Voraussetzung: **Python 3.10–3.12, 64-Bit**
(empfohlen 3.11), Internetzugang und mehrere GB freier Speicher. Der Installer
verwendet zunächst CPU-Wheels von torch/torchaudio 2.5.1; CUDA ist nicht nötig.

- Runtime: `%APPDATA%/airdox_SMART_Editor/stems/stem-runtime/Scripts/python.exe`
- Checkpoint und Config: `%APPDATA%/airdox_SMART_Editor/stems/Models/`
- Python-Hilfsskripte: `resources/app.asar.unpacked/python/` (im Build enthalten).

Es wird weder in `app.asar` noch in das temporäre Entpackverzeichnis einer
portablen EXE installiert. Der Benutzerdatenordner bleibt bei einem App-Update
bzw. Neustart erhalten. Ein leerer mitgelieferter `resources/models/`-Ordner
blockiert die Nachinstallation nicht mehr. Die Architektur wird als `msst`
installiert; auf dem Zielrechner sind weder npm, Bash noch Git erforderlich.

Downloads werden als `.part` geschrieben. Erst ein zum Modellkatalog passender
SHA256 aktiviert den Checkpoint. Der letzte Installationsschritt lädt die
Gewichte mit dem produktiven Adapter und prüft einen kurzen CPU-Forward-Pass
inklusive Output-Form und endlicher Samples. Ein bloßes Vorhandensein der Dateien
zählt nicht als erfolgreiche Installation. Die primäre Stem-Reihenfolge folgt
`training.instruments` der [originalen Release-Config v1.0.12](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.12/config_bs_roformer_384_8_2_485100.yaml):
**drums, bass, other, vocals**.

Nach erfolgreicher Installation wird die Engine neu aufgelöst. Existieren
bereits Jobs in dieser Sitzung, bleibt deren Zustand erhalten und die UI fordert
stattdessen zum Speichern und Neustarten auf. Der Browser-/Serverbetrieb nutzt
denselben Installer unter `AIRDOX_STEMS_ROOT` bzw. `stem-engine-data/`.

## Stem-Engine offline mitliefern (Runtime + Gewichte im Build)

Wer auf dem Zielrechner **kein** Python 3.10–3.12 und **kein** Internet
voraussetzen will, bündelt Runtime und Checkpoint vor dem Build:

```powershell
npm run stems:runtime        # Python-Runtime -> resources/stem-runtime (~1.2 GB mit Paketen)
npm run stems:bundle         # Standard-Set -> resources/models (669 MiB):
                             #   BS-RoFormer 503 MiB (sha256-geprüft) + ONNX-Fast-Path 166 MiB
npm run stems:bundle:check   # nur prüfen, nichts schreiben (CI/Freigabe)
npm run package:win          # portable EXE + NSIS-Installer
```

Damit findet die gepackte App alles unter `resources/` – noch vor
`%APPDATA%/airdox_SMART_Editor/stems`. Die portable EXE wächst dadurch auf
~1.7 GB (mit ONNX-Fast-Path); ohne Bundling bleibt der In-App-Installer der Weg (siehe unten).
Details, Optionen (`--mode venv`, `--source`, `--torch-index`) und
Fehlerbehebung: **`docs/STEM_BUNDLING.md`**.

Wichtig für das Vorschau-Profil: Es zeigt auf htdemucs *und* – laut Katalog –
auf den primären BS-RoFormer. Die Profilauflösung nimmt das erste Modell, dessen
Dateien vorhanden sind. Eine BS-RoFormer-Installation allein macht „Vorschau"
deshalb jetzt nutzbar, obwohl die optionalen Demucs-Gewichte fehlen.

### DJ-Fast-Path (ONNX, in-process)

Für den Live-Betrieb gibt es einen zweiten Weg ohne Python und ohne
Chunk-Dateien: `src/stems/backends/onnxSeparator.ts` führt einen
HT-Demucs-ONNX-Graphen direkt im App-Prozess aus (GPU über DirectML/CUDA,
sonst CPU) und übergibt die Segmente als `Float32Array` – es entstehen keine
`chunk_NNNN.wav` mehr. Die App validiert in diesem Pfad standardmäßig schlank
(`fast_dj`); `AIRODOX_STEM_MODE=studio_master` schaltet die volle Analyse ein.

```powershell
npm install                    # zieht onnxruntime-node mit (optional, win32-x64 inkl. DirectML)
npm run stems:onnx:doctor      # Provider, Modell, Segmentlänge, Hash
npm run stems:onnx:doctor -- --bench --seconds 30
```

Ohne Modell läuft weiterhin der Studio-Pfad; Details, Modellquellen und die
Hash-Pflege stehen in **`docs/STEM_ONNX_FASTPATH.md`**.

### Prüfung der Reparatur

`npm run lint`, `npm run build` und `npm test` sind erfolgreich
(46 Tests bestanden, 3 hardware-/modellabhängige Live-Tests übersprungen).
Die neuen Regressionstests prüfen den ASAR-/Windows-Pfad, Wiederholung nach
Fehlern, Download-/Hash-Fehler und die Neuauflösung der Engine ohne echte Downloads.
Der vollständige Installer mit echten Gewichten und die gepackte Windows-EXE
müssen zusätzlich auf Windows geprüft werden; der Linux-Testlauf ersetzt das nicht.
Die bestehende EXE erhält die Reparatur erst durch einen neuen Windows-Build.
