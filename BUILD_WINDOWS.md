# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `D:\airdox_SMART_Editor\Setup`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-<version>-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-<version>-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Striktes D:-Layout (Pflicht)

Auf Windows liegt **alles** unter einer Wurzel auf **Laufwerk D:**
(`electron/windowsPaths.cjs` ist die Single Source of Truth):

| Ordner | Inhalt |
| --- | --- |
| `D:\airdox_SMART_Editor\Setup` | Build-Artefakte (Setup-.exe, Portable-.exe) |
| `D:\airdox_SMART_Editor\App` | Standard-Installationsordner des NSIS-Setups (im Setup änderbar) |
| `D:\airdox_SMART_Editor\Data` | Laufzeitdaten: `logs/`, `stems/` (Arbeitsdaten, Cache, `Models/`, `stem-runtime/`), ANLZ-Pfadindex |

Das Layout ist **strikt**: Ohne Laufwerk D: brechen der Package-Build
(`node scripts/win-drive-preflight.mjs` läuft vor jedem `package:win*` vorweg),
der Installer (`electron/installer.nsh`) und der App-Start jeweils mit **klarer
Fehlermeldung** ab – es gibt keine stille Ablage auf C:.

- **Update-Verhalten:** Eine vorhandene Installation wird am bisherigen Ort
  aktualisiert. Wer von C: auf D: wechseln will, deinstalliert einmal und
  installiert neu – die Neuinstallation landet automatisch auf D:.
- **Ausnahmen (nur explizit):** `AIRDOX_WINDOWS_ROOT` verlegt die gesamte
  Wurzel (z. B. für Rechner ohne D:), `AIRDOX_STEMS_ROOT` nur die Stem-Daten.
  Beide gelten für Installer-Prüfung, App-Start und Dev-Server.
- **Zwischendateien** (`dist/`, `node_modules/`) bleiben wie bisher im Repo –
  auf D: landet alles Ausgelieferte und alles Persistente.

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)
3. **Laufwerk D:** mit mehreren GB freiem Speicher (Pflicht – siehe oben)

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

Das fertige Setup bzw. die portable `.exe` liegt danach in `D:\airdox_SMART_Editor\Setup`.
Fehlt Laufwerk D:, bricht der Build vorab mit klarer Fehlermeldung ab.

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
- Die Build-Artefakte liegen außerhalb des Repos auf D: (`D:\airdox_SMART_Editor\Setup`),
  `dist/` ist per `.gitignore` ausgenommen.

## BS-RoFormer in der gepackten App nachinstallieren

Der Button **„BS-RoFormer installieren“** installiert die primäre Engine, nicht
mehr den alten Demucs-Pfad. Voraussetzung: **Python 3.10–3.12, 64-Bit**
(empfohlen 3.11), Internetzugang und mehrere GB freier Speicher. Der Installer
verwendet zunächst CPU-Wheels von torch/torchaudio 2.5.1; CUDA ist nicht nötig.

- Runtime: `D:\airdox_SMART_Editor\Data\stems\stem-runtime\Scripts\python.exe`
- Checkpoint und Config: `D:\airdox_SMART_Editor\Data\stems\Models\`
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
denselben Installer unter `AIRDOX_STEMS_ROOT` bzw. – auf Windows –
`D:\airdox_SMART_Editor\Data\stems` (sonst `stem-engine-data/` im Repo).

### Prüfung der Reparatur

`npm run lint`, `npm run build` und `npm test` sind erfolgreich
(44 Tests bestanden, 3 hardware-/modellabhängige Live-Tests übersprungen).
Die neuen Regressionstests prüfen den ASAR-/Windows-Pfad, Wiederholung nach
Fehlern, Download-/Hash-Fehler und die Neuauflösung der Engine ohne echte Downloads.
Der vollständige Installer mit echten Gewichten und die gepackte Windows-EXE
müssen zusätzlich auf Windows geprüft werden; der Linux-Testlauf ersetzt das nicht.
Die bestehende EXE erhält die Reparatur erst durch einen neuen Windows-Build.
