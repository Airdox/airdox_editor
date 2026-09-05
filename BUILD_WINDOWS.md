# Windows-Build

Die App wird mit **Electron + electron-builder** zu einer nativen Windows-App gebaut.
Es entstehen zwei Artefakte (im Ordner `release/`):

| Befehl | Artefakt |
| --- | --- |
| `npm run package:win:nsis` | Installer `Rekordbox Desktop Import Setup 0.1.0.exe` |
| `npm run package:win:portable` | Einzelne portable `.exe` (`Rekordbox Desktop Import-0.1.0-portable.exe`) |
| `npm run package:win` | beide Varianten |

## Voraussetzungen (auf dem Windows-Rechner)

1. **Node.js** (LTS, ≥ 20) – https://nodejs.org
2. **Git** (optional)
3. Für den optionalen Rekordbox-Datenbank-Import (`master.db` / `exportLibrary.db`):
   Visual Studio **Build Tools** mit „Desktopentwicklung mit C++“ (nötig, um
   `better-sqlite3-multiple-ciphers` für Electron zu kompilieren). Ohne sie
   bleibt der XML-/ANLZ-Import voll funktionsfähig.

## Bauen

```powershell
git clone https://github.com/Airdox/airdox_editor.git
cd airdox_editor

npm install
# Optional: natives SQLCipher-Modul für Electron neu bauen
npm run rebuild:electron

npm run package:win
```

Das fertige Setup bzw. die portable `.exe` liegt danach in `release/`.

## Hinweise

- **Read-Only-Garantie:** Die App öffnet Original-Audio, XML-, ANLZ- und
  Datenbankdateien ausschließlich lesend. Exporte/Projektdateien werden nur als
  **neue** Dateien gespeichert; ein Überschreiben einer Original-Rekordbox-Quelle
  wird verweigert (`electron/pathGuard.cjs`).
- Die Build-Artefakte (`dist/`, `release/`) sind per `.gitignore` ausgenommen
  und werden nicht eingecheckt.
- Ein echtes `master.db`/`exportLibrary.db` sollte einmalig auf dem eigenen
  Rechner gegengeprüft werden (siehe `VORHABEN.md`, Phase 3).
