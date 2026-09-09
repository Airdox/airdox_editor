# Windows-Build – airdox_SMART_Editor

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte im Ordner `release/`:

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `airdox_SMART_Editor-0.4.2-setup.exe` |
| `npm run package:win:portable` | Portable `.exe` (`airdox_SMART_Editor-0.4.2-portable.exe`) |
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
Tag (z. B. `git tag v0.4.2 && git push --tags`) wird automatisch ein GitHub
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
