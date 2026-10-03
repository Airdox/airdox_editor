# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-0.4.4-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-0.4.4-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)
3. **Visual Studio Build Tools** mit „Desktopentwicklung mit C++“ – nur falls
   `npm ci` für `better-sqlite3-multiple-ciphers` kein fertiges Binary laden
   kann. Der GitHub-Workflow `windows-latest` bringt die Build Tools bereits
   mit; auf einem normalen Entwicklerrechner genügt in der Regel der
   mitgelieferte Prebuild.

`better-sqlite3-multiple-ciphers` ist **Pflichtabhängigkeit** (nicht mehr
`optionalDependencies`): Ohne sie kann die App keine Rekordbox-`master.db`
lesen, und der Track-Import liefert `SQLCIPHER_UNAVAILABLE`. Das ist eine
bewusste Entscheidung – ein still fehlendes natives Modul war die Ursache
dafür, dass „erfolgreiche“ Builds trotzdem kaputt ausgeliefert wurden.

## Bauen (PowerShell – Windows)

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor
npm ci
npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`.

## Automatischer Build (GitHub Actions)

Der Workflow `.github/workflows/windows-build.yml` baut auf Pushes nach `main`
und auf dem aktuellen Arena-Arbeitsbranch sowie bei manuellem Start. Es gibt
keinen automatischen Tag-Release und keinen täglichen Zeitplan.

- Windows: Typprüfung, Notebook-Konsistenz, Test-Suite, NSIS + portable EXE,
  gepackten Renderer starten und Fernjob-IPC prüfen, Colab-Ressourcen prüfen.
- Linux: trainiertes BS-RoFormer-Modell hashprüfen; echte Python-Worker-Läufe
  bei 44,1/48 kHz einschließlich Editor-Rückimport. Außerdem das **exportierte**
  Notebook mit neuer Runtime bis `AUTH_REQUIRED` ausführen. Windows hängt von
  diesem Job ab und lädt seine Nachweise aus demselben Lauf.
- Downloadartefakt: `airdox_SMART_Editor_Windows_0.4.4_mit_Nachweisen`: **ein Paket**
  mit EXEs, `NACHWEISKETTE.json`, `PRUEFEN.ps1`, Rohlogs/Einzeltestergebnissen,
  Windows-Smoke-Bericht/-Screenshot und passendem Colab-Notebook/Worker-ZIP.

Die Colab-Paketdateien werden durch `npm run stems:remote:bundle` aus demselben
Checkout gebaut und als `resources/colab` mitgeliefert. Die Windows-Packskripte
führen diesen Schritt automatisch aus (Python 3 erforderlich **beim Bauen**,
nicht für den Fernpfad auf dem Nutzer-PC). Lokale Entwicklerbuilds ohne
Modell-/Notebook-Evidence werden ausdrücklich `NOT_VERIFIED` markiert; die
geprüfte Notebook-Exportfunktion ist dann gesperrt. CI setzt
`AIRDOX_REQUIRE_EVIDENCE=1` und bricht ohne die Pflichtnachweise ab. `afterPack` verweigert ein Paket mit
fehlenden Colab-Dateien.

**Wichtig:** Grüne Build-Tests sind kein Nachweis einer realen Google-Sitzung.
Siehe [Colab-Abnahme](docs/COLAB_ABNAHME.md). Setup/portable sind unsigniert,
sofern kein separates Code-Signing-Zertifikat bereitgestellt wurde.

## Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import läuft über `better-sqlite3-multiple-ciphers`. Das Modul wird
automatisch für die Electron-Version des Builds kompiliert – **es ist kein
manueller Schritt nötig**:

| Schritt | Was passiert |
| --- | --- |
| `npm run desktop` | baut das native Modul für die Entwicklungs-Electron-Version (stamp-basiert, wiederholt sich nur bei Versionswechsel) und startet Electron |
| `npm run package:win` | `electron-builder` baut das Modul neu (`npmRebuild: true`) und führt `scripts/electron-builder-hooks.cjs` aus |
| `beforePack` | baut gezielt nur das SQLCipher-Modul und **lädt es in der echten Electron-Laufzeit** (`ELECTRON_RUN_AS_NODE`); Fehler ⇒ Build bricht ab |
| `afterPack` | prüft `app.asar`, prüft das native Binary im `app.asar.unpacked` und **lädt das gepackte Modul in Electron**; Fehler ⇒ Build bricht ab |

Ein Build läuft also nicht mehr „erfolgreich“ durch, obwohl SQLCipher
anschließend fehlt.

### Manuelle Befehle (Diagnose)

```powershell
npm run rekordbox:native:rebuild   # Modul für Electron neu bauen (--force)
npm run rekordbox:native:check     # nur melden, ob ein Rebuild nötig ist
npm run rekordbox:preflight -- --require-db # Electron-ABI + Datenbank read-only
npm run rekordbox:doctor -- 142225026       # vollständige Gate-Diagnose
npm run test:rekordbox:runtime -- 142225026 # echter Windows-Lauf
```

Die Diagnose-Skripte starten über `scripts/run-electron-node.mjs` mit der
Electron-Node-ABI, für die das native Modul gebaut wurde. `npm run
rekordbox:doctor` druckt je Glied der Kette einen Status und ändert niemals
Rekordbox-Quelldateien. `npm run test:rekordbox:runtime` läuft ausschließlich
unter Windows; ohne Datenbank meldet es `SKIP`, mit Rekordbox-Daten prüft es
die echte Kette. Ein `SKIP` ist kein erfolgreicher Echtlauf.

Die ausführliche PowerShell-Schrittfolge für einen echten Test mit
`D:\PIONEER`, Compiler-/ABI-Hinweisen und Fehlercodes steht in
[`docs/REKORDBOX_WINDOWS_LOCAL_TEST.md`](docs/REKORDBOX_WINDOWS_LOCAL_TEST.md).

### Bibliothek an einem ungewöhnlichen Ort

`AIRODOX_REKORDBOX_DB` (durch `;` getrennt) überschreibt die Suche in den
Pioneer-AppData-Ordnern, z. B. für eine externe Library:

```powershell
$env:AIRODOX_REKORDBOX_DB = 'E:\Rekordbox\master.db'
npm run rekordbox:doctor -- 142225026
```

## Hinweise

- **Vollständigkeit der ANLZ-Spezifikation:** `src/rekordbox/anlzStructure.ts`
  ist die einzige Quelle des ANLZ-Container-Formats. Renderer und
  Electron-Hauptprozess benutzen dieselbe Implementierung; für den
  Hauptprozess erzeugt `npm run build:anlz-structure` das Spiegelmodul
  `electron/generated/anlzStructure.cjs` (wird mit committet). Die CI prüft mit
  `npm run build:anlz-structure:check`, dass das Spiegelmodul nicht veraltet
  ist, und `tests/anlz-structure-parity.test.ts` beweist die Gleichheit beider
  Implementierungen über dieselben Fixtures.
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

### Historischer Prüfstand der lokalen Engine-Reparatur (nicht 0.4.4-Fernpfad)

`npm run lint`, `npm run build` und `npm test` sind erfolgreich
(46 Tests bestanden, 3 hardware-/modellabhängige Live-Tests übersprungen).
Die neuen Regressionstests prüfen den ASAR-/Windows-Pfad, Wiederholung nach
Fehlern, Download-/Hash-Fehler und die Neuauflösung der Engine ohne echte Downloads.
Der vollständige Installer mit echten Gewichten und die gepackte Windows-EXE
müssen zusätzlich auf Windows geprüft werden; der Linux-Testlauf ersetzt das nicht.
Die bestehende EXE erhält die Reparatur erst durch einen neuen Windows-Build.
