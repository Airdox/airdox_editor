# Windows-Build – Rekordbox Desktop Import

Diese Anleitung baut die Desktop-App für Windows 10/11 (x64). **Ein C-Compiler ist
dafür nicht mehr nötig** – weder Visual Studio noch Build Tools, noch Python.
Der Datenbank-Import (Phase 3) läuft im Paket über den reinen JavaScript-Pfad.

```
Fehler vor dieser Umstellung:
  ⨯ node-gyp failed to rebuild '…\node_modules\better-sqlite3-multiple-ciphers'
  Error: Could not find any Visual Studio installation to use
```

## 1. Warum der Fehler auftrat

| Umstand | Wert |
| --- | --- |
| Electron im Projekt | 44.2.0 → Node-ABI **149** |
| Vorgebaute `better-sqlite3-multiple-ciphers`-Binaries (v12.11.1) | Electron-ABI bis **146** (= Electron 42) |
| Folge | electron-builder musste das native Modul selbst bauen → node-gyp → Visual Studio |

`better-sqlite3-multiple-ciphers` ist im Projekt eine **optionale** Abhängigkeit.
electron-builder hat sie beim Paketieren trotzdem neu gebaut (`install-app-deps`).
Zwei Änderungen beheben das:

1. `package.json → build.npmRebuild: false` – electron-builder startet keinen
   node-gyp-Lauf mehr; das Paketieren braucht damit keine Build-Umgebung.
2. `electron/sqlcipherCodec.cjs` + `sql.js` – entschlüsselt `master.db` und
   `exportLibrary.db` im Hauptprozess mit `node:crypto` (AES-256-CBC,
   PBKDF2-HMAC-SHA512, Seiten-HMAC) und führt die Abfragen mit SQLite als
   WebAssembly aus. Kein natives Modul, keine ABI-Bindung, Read-Only.

Ist das native Modul *doch* vorhanden (selbst gebaut oder als Prebuild für
Electron ≤ 42), wird es automatisch als schnellerer Pfad verwendet. Die App
meldet im Dialog „Datenquellen”, welches Leseverfahren aktiv ist.

Bewusst **nicht** eingerichtet: ein `postinstall`-Hook mit
`electron-builder install-app-deps` (electron-builder empfiehlt ihn manchmal).
Er würde bei jedem `npm install` erneut node-gyp aufrufen und damit die
Compilervoraussetzung zurückbringen.

## 1a. Prüfen, ob die Korrektur wirklich aktiv ist

electron-builder loggt den entscheidenden Unterschied in der ersten Minute.
**Alt (fehlgeschlagen):**

```
• executing @electron/rebuild  electronVersion=44.2.0 arch=x64 buildFromSource=false …
• preparing       moduleName=better-sqlite3-multiple-ciphers arch=x64
⨯ Attempting to build a module with a space in the path
⨯ node-gyp failed to rebuild '…\node_modules\better-sqlite3-multiple-ciphers'
```

**Korrekt (mit `npmRebuild: false`):**

```
• skipped dependencies rebuild  reason=npmRebuild is set to false
• packaging       platform=win32 arch=x64 electron=44.2.0 appOutDir=release\win-unpacked
```

Erscheint die obere Zeile trotz aktueller Branch, wurde ein altes `package.json`
verwendet (nicht gezogener Stand, editierte `build`-Sektion oder ein global
gesetztes `npmRebuild`). Die npm-Skripte übergeben deshalb zusätzlich
`--config.npmRebuild=false` auf der Kommandozeile – dieser Override gewinnt gegen
jede `package.json`. Prüfen lässt sich das in einem Zug:

```bat
npm run check:build-env
```

Der Guard bricht ab, bevor der Build startet, wenn `npmRebuild` fehlt,
`dist/index.html` absolute Asset-Pfade enthält, der Projektpfad Leerzeichen hat
*und* das native Modul installiert ist, oder Node.js < 20 ist. Warnungen gibt es
für OneDrive-Pfade (Sync-Sperren).

## 2. Bauen

Voraussetzungen: Windows 10/11 x64, Node.js ≥ 20 (npm ≥ 10), etwas 2 GB freier
Plattenspeicher – und ein Projektpfad **ohne Leerzeichen und außerhalb von
OneDrive** (z. B. `C:\Dev\airdox_editor`). Leerzeichen im Pfad bringen selbst
mit installiertem Visual Studio nichts: node-gyp bricht dann mit
„Attempting to build a module with a space in the path" ab.
Eingabeaufforderung oder PowerShell im Projektordner:

```bat
npm ci
npm run package:win
```

> **Wichtig bei OneDrive / Desktop-Ordnern:** Der Projektordner sollte **nicht**
> unter OneDrive (oder einem anderen Synchronisationsclient) liegen. Der Sync
> sperrt Dateien in `node_modules\` und `release\`, was zu `EPERM`, `EBUSY` oder
> halb geschriebenen Dateien führt – ein typischer Grund, warum Builds auf einem
> Rechner laufen und auf dem anderen nicht. Empfohlen: `C:\Dev\airdox_editor`.
> Zusätzlich lange Pfade aktivieren: `git config --system core.longpaths true`
> und in den Gruppenrichtlinien „Lange Pfade aktivieren“ (Win10 1607+).

Ergebnis im Ordner `release\`:

* `Rekordbox Desktop Import-0.1.0-win-x64.exe` – NSIS-Installer (Auswahl des
  Zielordners, Desktop- und Startmenü-Verknüpfung, pro Benutzer ohne Admin-Rechte)
* `Rekordbox Desktop Import-Portable-0.1.0-x64.exe` – einzelne EXE ohne
  Installation (für USB-Sticks oder Testläufe)

Nur ein Ziel bauen:

```bat
npm run package:win:installer
npm run package:win:portable
```

Vor dem Paketieren lohnt der Blick auf Tests und Diagnose:

```bat
npm run lint
npm test
node tools\windows-native-hint.cjs
```

`windows-native-hint.cjs` prüft Electron-Version, ABI, optionale native
Abhängigkeit und entschüsselt testweise die mitgelieferte SQLCipher-Fixture –
dann ist der Datenbank-Import nach dem Build nachweislich funktionsfähig.

## 3. Erster Start und Datenquellen

1. App starten, **Datei → Rekordbox XML** für die Kollektion (funktioniert immer).
2. Für Waveform/Beatgrid/Cues mit Vorrang: **ANLZ-Datei im Windows-Dialog
   auswählen** (`.DAT`, `.EXT`, `.2EX`).
3. Für die Bibliothek direkt: **Rekordbox-Datenbank auswählen** oder
   „Standardordner durchsuchen".

Erwartete Ablageorte von `master.db` (nur lesend):

```
%APPDATA%\Pioneer\rekordbox7\master.db
%APPDATA%\Pioneer\rekordbox6\master.db
%APPDATA%\Pioneer\rekordbox\master.db
```

Rekordbox 7 legt den echten Pfad zusätzlich in
`%APPDATA%\Pioneer\rekordbox7\rekordboxAgent\storage\options.json` (`db-path`) ab –
die Suche liest diese Datei aus. Für USB-Laufwerke mit Device Library Plus wird
`PIONEER\rekordbox\exportLibrary.db` erkannt.

Rekordbox sollte beim Lesen geschlossen sein: die App erstellt einen Snapshot
der Hauptdatei, eine vorhandene `-wal`-Datei wird nicht ausgewertet (die App weist
in den Hinweisen darauf hin).

## 4. Fehlersuche

| Meldung | Ursache / Lösung |
| --- | --- |
| `Could not find any Visual Studio installation to use` | Tritt mit diesem Stand nicht mehr auf. Erscheint sie nach eigenen Änderungen doch: `npmRebuild: false` in `package.json → build` entfernen bzw. das native Modul bewusst bauen (Abschnitt 6). |
| `Der Datenbank-Import ist nur in der Windows-Desktop-App verfügbar` | Im Browser (Vite-Dev) geöffnet – die Read-Only-Bridge gibt es nur in der Electron-App (`npm run desktop` oder die gebaute EXE). |
| `… konnte mit keinem bekannten SQLCipher-Profil entschlüsselt werden` | Datei ist keine Rekordbox-`master.db`/`exportLibrary.db`, wurde von einer anderen Rekordbox-Version mit abweichenden Parametern geschrieben, oder sie wird gerade von Rekordbox beschrieben. Rekordbox schließen und erneut versuchen; die Hinweise im Log-Dialog nennen die geprüften Profile. |
| Weißes Fenster nach dem Start | `vite.config.ts` muss `base: './'` enthalten, damit `dist/index.html` die Assets relativ lädt (file://). |
| `Die Originaldatei ist größer als 1 GB …` | Bewusste Grenze des Read-Only-Bridges; Datei auf ein Laufwerk mit ausreichendem Speicher kopieren oder die Originalgröße prüfen. |
| `npm ci` bricht bei `better-sqlite3-multiple-ciphers` ab | Nur als `optionalDependencies` eingetragen – `npm ci --omit=optional` überspringt es vollständig. |
| Windows-SmartScreen-Warnung „Unbekannter Herausgeber" | Der Build ist nicht signiert. „Weitere Informationen → Trotzdem ausführen", oder mit eigenem Zertifikat signieren (Abschnitt 7). |
| Sehr großer Arbeitsspeicher beim Datenbank-Import | Snapshot im RAM: ca. 3× Dateigröße plus Zeilen. 100.000 Tracks (≈ 43 MB `master.db`) dauern ≈ 3,5 s und belegen ≈ 330 MB. Für deutlich größere Bibliotheken das native Modul bauen (Abschnitt 6). |

Die App schreibt alle Hinweise zusätzlich in den **Systemlog-Dialog**
(`Kategorie: DATABASE`) – dort stehen Lesezeit, verwendetes Leseverfahren und
alle Warnungen, ohne die Konsole zu brauchen.

## 5. Build über GitHub Actions (ohne lokalen Build)

`.github/workflows/windows-build.yml` baut auf `windows-latest` und lädt die
beiden `.exe`-Dateien als Workflow-Artefakt hoch:

**Actions → „Windows-Build (Installer + Portable)“ → Run workflow** (Ziel wählbar).
GitHub-Runner enthalten Visual Studio Build Tools, dort würde also auch das
native Modul kompilieren.

## 6. Optional: natives SQLCipher-Modul (schneller, nur für Riesenbibliotheken)

Nur sinnvoll, wenn `master.db` deutlich größer als ~100 MB ist.

Variante A – ohne Compiler, aber mit passendem Electron (die vorgebauten
Binaries von `better-sqlite3-multiple-ciphers` enden bei Electron-ABI 146):

```bat
npm install better-sqlite3-multiple-ciphers --no-audit
cd node_modules\better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=42.2.0 --arch=x64 --platform=win32 --verbose
cd ..\..
```

`--target` ist die im Projekt installierte Electron-Version (hier: Electron 42,
weil dafür ein Prebuild existiert). Danach `npm run package:win` nicht vergessen.

Variante B – mit Build-Tools, beliebiges Electron (auch 44):

```bat
:: Visual Studio 2022 Build Tools installieren, Workload „Desktopentwicklung mit C++“
:: (enthält MSVC + Windows SDK), dazu Python 3 und im Projektordner:
npm config set msvs_version 2022
npm install better-sqlite3-multiple-ciphers --no-audit
npm run rebuild:electron
npm run package:win
```

Beim Paketieren mit `npmRebuild: false` muss das Modul vor dem Build für die
Electron-ABI fertig in `node_modules` liegen – `npm run rebuild:electron`
erledigt das. `asarUnpack` ist bereits konfiguriert, damit die `.node`-Datei
nicht im Archiv landet.

## 7. Eigenes Zertifikat (optional)

```powershell
$env:CSC_LINK = "C:\Pfade\zum\zertifikat.p12"
$env:CSC_KEY_PASSWORD = "…"
npm run package:win
```

## 8. Icon

`app-resources/icon.png` (256×256) ist die Vorlage, `app-resources/icon.ico`
(16–256 px) liegt für den Windows-Build bei und wird von `win.icon` verwendet.
Nach einem Austausch der Vorlage:

```bat
npm run icon
```

## 9. Was nach dem ersten Build zu prüfen ist

* [ ] `Rekordbox Desktop Import-…-win-x64.exe` installiert ohne Administrator-Rechte.
* [ ] Kollektion aus XML lädt (11.000 Tracks in < 0,5 s).
* [ ] Datenbank-Import meldet „reines JavaScript“ **und** liefert Tracks.
* [ ] Waveform/Beatgrid/Cues einer ANLZ-Datei erscheinen im Edit-Modus.
* [ ] Originale `*.wav`/`*.mp3` werden über die XML-`Location` geöffnet.
* [ ] SHA-256 der Originaldatei bleibt unverändert (App schreibt nie zurück).
