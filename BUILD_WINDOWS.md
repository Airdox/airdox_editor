# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-<version>-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-<version>-portable.exe`) |
| `npm run package:win` | beide Varianten |

Die `<version>` kommt automatisch aus `package.json` — Versions-Regeln und
Release-Prozess: [`docs/VERSIONIERUNG.md`](docs/VERSIONIERUNG.md).

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (für den Klon aus GitHub)

Der Basis-Build benötigt **kein** Visual Studio: XML-/ANLZ-Import, Audio-Editor
und Export funktionieren vollständig. Das optionale SQLCipher-Modul ist per
`"npmRebuild": false` für den **Lokal-Build** ohne C++-Toolchain deaktiviert
(dann ohne DB-Import, ANLZ-PPTH-Pfad bleibt aktiv). Der **CI-Build** (GitHub
Actions) rebuildet das Modul dagegen automatisch gegen das Electron-ABI —
deshalb funktioniert der DB-Import in allen CI-Releases.

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
Tag (z. B. `git tag v<version> && git push origin v<version>`) wird
automatisch ein GitHub-Release mit den `.exe`-Dateien erzeugt — der
empfohlene Weg ist das Release-Script, siehe
[`docs/VERSIONIERUNG.md`](docs/VERSIONIERUNG.md).

## Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import (`better-sqlite3-multiple-ciphers`, optionalDependency) ist
**in allen CI-Releases aktiv**: Der Workflow rebuildet das native Modul nach
`npm ci` mit `npm run rebuild:electron` gegen die Electron-Header — ohne
diesen Schritt wäre das Modul gegen das Runner-Node kompiliert
(`NODE_MODULE_VERSION`-Mismatch, DB nicht lesbar).

Für einen **Lokal-Build** gilt: ohne Visual Studio Build Tools fehlt das
Modul (App läuft ohne DB-Import, ANLZ-PPTH bleibt voll funktionsfähig); mit
installierten Build Tools („Desktopentwicklung mit C++“) vor dem Paketieren:

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
