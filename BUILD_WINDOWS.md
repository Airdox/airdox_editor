# Windows-Build

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte (im Ordner `release/`):

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `Airdox Smart Editor Setup 0.2.0.exe` |
| `npm run package:win:portable` | Einzelne portable `.exe` (`Airdox Smart Editor-0.2.0-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Automatischer Build (ohne Windows-Rechner)

Der Workflow [`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)
baut beide Artefakte bei jedem Push auf einem echten Windows-Runner. Die
fertigen `.exe`-Dateien liegen danach unter
**Actions → Windows-Build → Artifacts** zum Download bereit:

- `airdox-smart-editor-setup` – NSIS-Installer
- `airdox-smart-editor-portable` – portable EXE

Der Workflow lässt sich unter Actions auch manuell über
*Run workflow* starten.

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (optional)

Der Basis-Build benötigt **kein** Visual Studio: XML-/ANLZ-Import, Audio-Editor
und Export funktionieren vollständig. Der native Rebuild des optionalen
SQLCipher-Moduls ist per `"npmRebuild": false` abgeschaltet, sodass der Build
auch in Pfaden **mit Leerzeichen** und ohne C++-Toolchain durchläuft.

## Bauen

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor

npm install
npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`.

## Optional: Rekordbox-Datenbank-Import (master.db / exportLibrary.db)

Der DB-Import (`better-sqlite3-multiple-ciphers`) ist optional. Ohne ihn bleibt
der XML-/ANLZ-Import voll funktionsfähig; die App meldet den nicht verfügbaren
DB-Import nachvollziehbar. Um ihn zu aktivieren:

1. Visual Studio **Build Tools** mit „Desktopentwicklung mit C++“ installieren.
2. Modul für Electron kompilieren und erneut bauen:

```powershell
npm run rebuild:electron
npm run package:win
```

## Hinweise

- **Read-Only-Garantie:** Die App öffnet Original-Audio, XML-, ANLZ- und
  Datenbankdateien ausschließlich lesend. Exporte/Projektdateien werden nur als
  **neue** Dateien gespeichert; ein Überschreiben einer Original-Rekordbox-Quelle
  wird verweigert (`electron/pathGuard.cjs`).
- Die Build-Artefakte (`dist/`, `release/`) sind per `.gitignore` ausgenommen
  und werden nicht eingecheckt.
- Ein echtes `master.db`/`exportLibrary.db` sollte einmalig auf dem eigenen
  Rechner gegengeprüft werden (siehe `VORHABEN.md`, Phase 3).
