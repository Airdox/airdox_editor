# Vorhaben: Airdox_intelligents_Editor – Rekordbox-Desktop-Importpfad

**Stand: 05.09.2026**

Die Anwendung wird schrittweise zu einer Windows-Desktop-App ausgebaut. Rekordbox-XML liefert Bibliothek, Metadaten und Dateipfade. Rekordbox-Datenbank- und ANLZ-Daten haben Vorrang für Waveform, Beatgrid, Cues und Songstruktur. Eigene Berechnungen sind ausschließlich gekennzeichnete Fallbacks.

Original-Audio, XML-, ANLZ- und Datenbankdateien bleiben immer unverändert und werden nur lesend verarbeitet. Nach der Track-Auswahl werden ausschließlich die Daten dieses Tracks geladen; große Bibliotheken bleiben dabei speicherschonend durchsuchbar.

## Phase 1 – Desktop-Grundlage ✅

Die Windows-App prüft XML-`Location`-Pfade und kann unterstützte Originalaudiodateien ausschließlich lesend öffnen. Sie erzeugt keinen synthetischen Ersatztrack mehr, wenn die Originaldatei nicht verfügbar ist – der frühere Generator `src/audio/synthesizerTrack.ts` ist entfernt, fehlende Originale bleiben ein reiner Metadaten-/ANLZ-Track mit Status `MISSING`.

- Read-only-Bridge: `inspectLocation`, `readOriginalAudio` (`electron/main.cjs`, `preload.cjs`, `src/types/desktop.d.ts`).
- Track-Auswahl lädt erst nach expliziter Auswahl die Daten des Tracks; XML-Kollektionen werden mit kompakten Beatgrid-Metadaten durchsuchbar gehalten (11.000 Tracks < 0,5 s).

## Phase 2 – ANLZ-Dekodierung ✅

Rekordbox-ANLZ-Dateien (`.DAT`, `.EXT`, `.2EX`) werden gegen die dokumentierte Binärstruktur (Deep Symmetry / Kaitai-Spezifikation) dekodiert und haben Vorrang für Waveform, Beatgrid, Cues, Loops und Songstruktur:

- `PPTH` Quelle, `PQTZ` Beatgrid, `PCOB`/`PCPT` klassische Cues, `PCO2`/`PCP2` erweiterte (nxs2) Cues inkl. Kommentaren, Farben und quantisierten Loops.
- `PWV2`–`PWV7` Waveform-Sektionen (inkl. CDJ-3000 3-Band) mit Prioritätsauswahl.
- `PSSI` Song-Struktur inkl. XOR-Entschlüsselung der Rekordbox-6-Exporte (maskiert/unmaskiert, Mood, Bank, Fills).
- Die alte Test-Fixture bleibt als gekennzeichneter Legacy-Fallback erhalten.
- Read-only-Bridge: `chooseAnalysisFile` + `readAnalysisFile`; Dateiauswahl im Windows-Dialog, Quelle wird nie beschrieben.

## Phase 3 – Rekordbox-7-Datenbank ✅

Die lokale Rekordbox-6/7-Bibliothek (`master.db`) und die OneLibrary-Exportdatenbank (`exportLibrary.db`, Device Library Plus) werden unterstützt. Beide sind SQLCipher-verschlüsselt; der entschlüsselte Inhalt wird ausschließlich lesend abgefragt:

- `electron/dbReader.cjs`: deobfusciert die dokumentierten Community-Schlüssel (`402fd…` master.db, `r8gd…` OneLibrary), öffnet die Datenbank mit SQLite-`readonly`, liest `djmdContent`/`djmdCue` (+ Artist/Album/Genre/Key/Label/Playlists) bzw. die OneLibrary-Tabellen (`content`, `cue`, `artist`, …) und schließt sie sofort wieder.
- `src/rekordbox/dbParser.ts`: normalisiert beide Schemata (BPM × 100, Rating 0–255/0–5, ms/µs-Zeitstempel) auf denselben Collection-Vertrag wie der XML-Import; Cues, Hot Cues und Loops werden inkl. Takt/Beat-Alignment übernommen, eigene Audioberechnungen entstehen nicht.
- Quellen werden wahlweise per Windows-Dateidialog oder über die automatische Ordnersuche (`Pioneer\rekordbox7|rekordbox6|rekordbox` + `rekordboxAgent/storage/options.json`) geladen.
- Natives Modul: `better-sqlite3-multiple-ciphers` als optionale Abhängigkeit; `npm run rebuild:electron` baut es für Electron. Fehlt das Modul, übernimmt seit Phase 4 der reine JavaScript-Leser (kein Funktionsverlust, keine Build-Tools) – und erst wenn beides nicht kann, bleibt der XML-Pfad voll funktionsfähig und die App meldet den Datenbank-Import nachvollziehbar.

**Verifikation mit Rekordbox 7:** Die Schlüssellogik und das Schema-Mapping sind gegen die veröffentlichten Spezifikationen getestet (12 + 12 + 6 + 11.000-Track-Checks); die tatsächliche Entschlüsselung einer echten `master.db`/`exportLibrary.db` sollte auf dem Windows-Rechner einmalig gegen die eigene Bibliothek bestätigt werden (Analysepfade/Standorte können je nach Rekordbox-7-Einstellungen abweichen).

## Phase 4 – Windows-Auslieferung ohne Build-Toolchain ✅

Der Paketierlauf für Windows durfte nicht mehr von einem C-Compiler abhängen: `better-sqlite3-multiple-ciphers` liefert vorgebaute Binaries nur bis Electron-ABI 146, das Projekt nutzt Electron 44 (ABI 149) – electron-builder musste also kompilieren und schlug ohne Visual Studio fehl (`Could not find any Visual Studio installation to use`).

- `electron/sqlcipherCodec.cjs`: reines JavaScript für das SQLCipher-Seitenformat – Salt aus den ersten 16 Bytes, PBKDF2 (v4: SHA-512/256 000 Iterationen, v3: SHA-1/64 000), AES-256-CBC je Seite, IV und HMAC aus dem Reserve-Bereich (v4: 80 Bytes), Prüfung über `crypto.timingSafeEqual` und den rekonstruierten SQLite-Seitenkopf. Profile werden der Reihe nach durchprobiert (v4 → v3 → v2 → v1, 1 KiB/4 KiB Seiten); Auto-Vacuum-Restseiten und Klartext-SQLite werden erkannt.
- `electron/sqlcipherJsReader.cjs` + `sql.js`: die entschlüsselten Seiten liegen nur im Arbeitsspeicher (nie auf der Platte) und werden mit SQLite als WebAssembly abgefragt. Originaldatei bleibt unangetastet, Größe auf 1 GiB begrenzt.
- `electron/dbReader.cjs`: Engine-Auswahl (natives Modul → JavaScript-Fallback), spaltentolerante Abfragen über `PRAGMA table_info` (abweichende Rekordbox-Versionen führen zu Hinweisen, nicht zu Importabbruch), Hinweis auf eine vorhandene `-wal`-Datei, `describeEngines()` für die UI.
- Packaging: `build.npmRebuild = false` (kein node-gyp beim Bauen) und `build.publish = null` – `publish` in der Konfiguration ist ein Provider-Name, der Modus `never` existiert nur als CLI-Flag; ungenutzte Server-Reste (`express`, `dotenv`, `@types/express`) und das doppelt eingetragene `vite` sind aus den Runtime-Abhängigkeiten entfernt (69 Pakete weniger im Paket), `sql.js` bleibt enthalten.  `asarUnpack` für optionale Native-Binaries und `sql.js`, NSIS-Installer + Portable-EXE, `base: './'` in `vite.config.ts` (sonst weißes Fenster aus dem `file://`-Loader), App-Icon (`app-resources/`), plattformneutrales `npm run clean`.
- Build-Guard: `tools/check-build-env.cjs` bricht vor dem Build ab, wenn `npmRebuild` fehlt, wenn `dist/index.html` absolute Asset-Pfade enthält oder wenn der Projektpfad Leerzeichen *und* ein installiertes Native-Modul kombiniert (node-gyp: 'space in the path'). Die `package:win*`-Skripte erzwingen zusätzlich `--config.npmRebuild=false`, damit ein altes `package.json` den node-gyp-Lauf nicht reaktivieren kann; `npm run check:build-env` prüft das einzeln.
- Diagnose: `tools/windows-native-hint.cjs` prüft Electron-ABI, optionale Abhängigkeit und entschlüsselt testweise eine Fixture; `BUILD-WINDOWS.md` dokumentiert Build, Fehlersuche und den optionalen nativen Pfad. `.github/workflows/windows-build.yml` baut Installer und Portable-EXE auf einem Windows-Runner.
- Verifikation: echte SQLCipher-Dateien (mit SQLCipher 4.12 erzeugt, Schema `djmd*` bzw. OneLibrary, deutsche Umlaute und Windows-Pfade) werden entschlüsselt, gelesen und liefern identische Zeilen wie der native Pfad – 12 Prüfungen in `tests/sqlcipher-js-reader.test.mjs`, Fixture-Erzeugung unter `tools/generate-sqlcipher-fixtures.py`. `tests/desktop-bridge.test.mjs` prüft die Windows-Verdrahtung ohne Electron-Binary: alle IPC-Kanäle von `preload.cjs` haben einen Handler in `main.cjs`, die Typen in `src/types/desktop.d.ts` decken die Bridge ab, Dateiendungen werden abgewiesen, und die Fixture bleibt nach dem Import bitgenau unverändert, der Build-Guard meldet die bekannten Fehlerbilder (11 Prüfungen). Messung: 11.000 Tracks (3,7 MB) in ≈ 0,8 s, 100.000 Tracks (43 MB) in ≈ 3,5 s.

## Phase 5 – Arbeiten am Klang: Editierkern, Projektdatei, Clip-Bibliothek ✅

Edits durften nicht mehr „nur“ im Bauteil passieren, sondern müssen nachweisbar sein. Der komplette Schnitt-Weg liegt deshalb in DOM-freien Modulen, die identisch von App und Tests benutzt werden:

- `src/audio/pcm.ts` (Arbeits-Sound als `PcmAudio`), `src/audio/wav.ts` (16/24/32-Bit-Ein-/Ausgabe), `src/audio/editOps.ts` (Ausschneiden, Kopieren, Einfügen, Ersetzen, Darüberlegen, Löschen, ans Ende kopieren, an den Taktanfang setzen – inklusive Marker-/Loop-Nachziehen, Loop-Klemmung und Bericht in Sekunden/Beats/Takten), `src/waveform/analyzer.ts` (Peaks und Bänder nach jedem Schnitt neu).
- `src/App.tsx` kennt genau einen Weg, Audio zu ändern: `commitEditable`. Undo/Redo sichern den vollständigen Schnappschuss (Samples, Marker, Loops, Beatgrid) und stellen ihn samplegenau wieder her; `audioBuffer` bleibt das unveränderte Original.
- Projektdatei: `src/projects/projectFormat.ts` (Art `airdox-intelligents-project`, Schema 1, Endung `.airdoxproj.json`, eingebettete Arbeitskopie als `wav16+base64` mit `FNV-1a-64`-Prüfsumme, Herkunft `provenance.originalsModified = false`) und `src/projects/projectIO.ts`. Speichern/Öffnen läuft über echte Dateidialoge (`datei:*`-Kanäle in `electron/main.cjs`, Schreiben nur an zuvor bestätigte Orte, Größenlimit 512 MiB), `Strg+S` / `Strg+Shift+S` / `Strg+Shift+O`.
- Clip-Bibliothek (`src/audio/clipLibrary.ts`, Panel „Clip-Bibliothek“): Clips tragen immer Samples, Mini-Peaks, Dauer, Beats/Takte und Herkunft; `buildClip` berechnet, `ensureConsistentClip` frischt auf, `normalizeLibrary` hält IDs und Namen eindeutig. Clips sind Drag-&-Drop-Quellen: auf die Wellenform gezogen = einfügen, `Alt` = darüberlegen, `Umschalt` = Bereich ersetzen, `Strg` (oder Ziehen auf das Feld „DECK-CLIP“ unten) = in den Deck-Spieler laden, wo TRANSPORT und LOOP auf den Clip bezogen sind, ohne die Spur zu verändern.
- Darstellung: bernsteinfarbene Wellenform als neuer Standard (`src/waveform/colors.ts`, Modus im Menü umschaltbar), `tests/edit-workflow.test.ts` (13), `tests/clip-library.test.ts` (15), `tests/project-io.test.ts` (10) und `tests/desktop-bridge.test.mjs` (19) prüfen Kern, Bibliothek, Format und Brücke; Beweis-WAVs und Nachweise liegen unter `tests/artifacts/`.

**Verifikation:** `npm test` (alle Suiten grün), `npm run lint`, `npm run build`; die Hörbarkeits-Belege liegen als WAVs samt `NACHWEIS.md` in `tests/artifacts/edit-workflow/` und `tests/artifacts/clip-library/`. Der Datenweg der Wellenform ist in [WELLENFORM-DATEN.md](WELLENFORM-DATEN.md) dokumentiert.
