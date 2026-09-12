# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-<Version>-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-<Version>-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)

Der Basis-Build benötigt **kein** Visual Studio: XML-/ANLZ-Import, Audio-Editor
und Export funktionieren vollständig. Das optionale SQLCipher-Modul ist per
`"npmRebuild": false` abgeschaltet, sodass der Build auch in Pfaden **mit
Leerzeichen** und ohne C++-Toolchain durchläuft.

## Bauen (PowerShell – Windows)

`.gitattributes` erzwingt LF-Zeilenenden auch bei `core.autocrlf=true`
(Windows-Standard): ohne diese Einstellung gelten nach dem Clone alle Dateien als
verändert und `git status` verrauscht.

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor
npm ci
npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`. Vorher die
Prüfschritte laufen lassen: `npm run lint`, `npm test`, `npm run coverage`.

## Fertiges Artefakt aus GitHub Actions beziehen (kein lokaler Build nötig)

Der Workflow hängt beide `.exe` als Artifact an den Lauf; der Workflow lässt sich auch
manuell auf einem Zweig starten:

```bash
gh workflow run windows-build.yml --ref <branch>          # Build anstoßen
gh run list --workflow windows-build.yml --limit 3        # Lauf finden
gh run watch <run-id>                                     # bis "success" begleiten
gh run download <run-id> -n airdox-smart-editor-windows -D release   # Artefakt holen
```

Im Artifact `airdox-smart-editor-windows` liegen `airdox_SMART_Editor-<Version>-setup.exe`,
`airdox_SMART_Editor-<Version>-portable.exe` **und** `SHA256SUMS.txt` (von einem CI-Schritt
erzeugt: SHA256, Dateigröße, Zahl der nativen Module im Paket, asar-Größe). Nach dem Download
prüfen:

```powershell
Get-FileHash .\airdox_SMART_Editor-<Version>-portable.exe -Algorithm SHA256   # Windows
sha256sum airdox_SMART_Editor-<Version>-portable.exe                          # Linux/macOS
```

Zwei weitere Knöpfe am Workflow:

* **`release_draft`** (nur `workflow_dispatch`, Bool, Standard `false`): legt die beiden `.exe`
  als **Entwurf** (`draft` + `prerelease`) an den rollenden Tag `ci-windows-build`. Damit ist ein
  Zweig-Build per Browser downloadbar, ohne ein öffentliches Release zu erzeugen; jeder neue
  dispatch-Lauf überschreibt die Dateien (`overwrite_files`). Normal-Builds (PR, `main`,
  Cron) bleiben unberührt.
* Ein zweiter Job **`tests`** läuft auf ubuntu **und** windows (`npm ci` → `npm run lint` →
  `npm test` → `npm run coverage`). Er blockiert das Artefakt nicht, zieht aber die Ampel —
  seit ein Build grün wurde, obwohl `npm ci` die Test-Stack-`devDependencies` weggelassen hatte.

Die Artefakt-/Release-Download-URLs liegen auf Azure-Blob-Hosts
(`*.blob.core.windows.net`); in abgeschotteten Umgebungen (CI-Sandboxen, manche Firmennetze) sind
sie geblockt — dann die `.exe` im Browser von der Actions-/Release-Seite holen und die SHA256 aus
`SHA256SUMS.txt` vergleichen. Der Dateiname folgt der `version` in `package.json` (aktuell
`0.4.20`), die Release-Tags sind separat gezählt (`v0.5.x`) — siehe
`docs/PROJEKTANALYSE_2026-09-12.md`, Abschnitt G.

## Automatischer Build (GitHub Actions)

Der Workflow `.github/workflows/windows-build.yml` baut auf jedem Push auf
`main`, auf Tags `v*` und einmal täglich um 03:00 UTC (05:00 DE) automatisch
beide Windows-Artefakte und lädt sie als Artifact (30 Tage) hoch. Bei einem
Tag (z. B. `git tag v0.4.20 && git push --tags`) wird automatisch ein GitHub
Release mit den `.exe`-Dateien erzeugt.

## Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import (`better-sqlite3-multiple-ciphers`) ermöglicht die **gezielte**
ANLZ-Auflösung pro Track (`AnalysisDataPath` → exakte Datei, kein Vollscan).
**CI-Builds enthalten ihn automatisch**: Der Workflow kompiliert das Modul per
`npm run rebuild:electron` für die Electron-ABI (die `windows-latest`-Runner
haben VS Build Tools + Python vorinstalliert) und packt es per `asarUnpack`
mit ein. Schlägt das Kompilieren fehl, ist der Build rot.

Nur für **lokale** Windows-Builds ohne C++-Toolchain bleibt das Modul optional:
Ohne es bleibt der XML-/ANLZ-Import voll funktionsfähig; die App meldet den
nicht verfügbaren DB-Import nachvollziehbar. Zum lokalen Aktivieren:

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
