# Vorhaben: Rekordbox-Desktop-Importpfad

**Stand: 06.09.2026**

Die Anwendung wird schrittweise zu einer Windows-Desktop-App ausgebaut. Rekordbox-XML liefert Bibliothek, Metadaten und Dateipfade. Rekordbox-Datenbank- und ANLZ-Daten haben Vorrang für Waveform, Beatgrid, Cues und Songstruktur. Eigene Berechnungen sind ausschließlich gekennzeichnete Fallbacks.

Original-Audio, XML-, ANLZ- und Datenbankdateien bleiben immer unverändert und werden nur lesend verarbeitet. Nach der Track-Auswahl werden ausschließlich die Daten dieses Tracks geladen; große Bibliotheken bleiben dabei speicherschonend durchsuchbar.

## Phase 1 – Desktop-Grundlage ✅

Die Windows-App prüft XML-`Location`-Pfade und kann unterstützte Originalaudiodateien ausschließlich lesend öffnen. Sie erzeugt keinen synthetischen Ersatztrack mehr, wenn die Originaldatei nicht verfügbar ist.

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
- Natives Modul: `better-sqlite3-multiple-ciphers` als optionale Abhängigkeit; `npm run rebuild:electron` baut es für Electron. Falls das Modul fehlt, bleibt der XML-Pfad voll funktionsfähig und die App meldet den nicht verfügbaren Datenbank-Import nachvollziehbar.

## Phase 4 – Desktop-Export- & Projekt-Pfad ✅

Der Lese-Pfad (XML → ANLZ → Datenbank) wird um den Schreib-Pfad ergänzt, der den nicht-destruktiven Roundtrip vollendet. Exporte und Projektdateien werden ausschließlich als **neue Dateien** über den nativen Windows-Dialog gespeichert; das Überschreiben einer Original-Rekordbox-Quelle (Audio, XML, ANLZ, Datenbank) wird hart verweigert.

- Write-Bridge: `saveExportFile` + `openProjectFile` (`electron/main.cjs`, `preload.cjs`, `src/types/desktop.d.ts`). Der Zielpfad wird in `electron/pathGuard.cjs` (pfad- und groß/kleinschreibungs-insensitiv) gegen die Originalpfade geprüft; bei Kollision schlägt der Export fehl, statt zu überschreiben.
- Versioniertes Projektformat `.airdox.json` (`src/rekordbox/projectFile.ts`): Projektname, Deck-Tracks (Metadaten, Cues, Loops, Beatgrid-Anker, Edit-Segmente), Palette-Clips und Auswahl. Original-Audio wird nicht dupliziert, sondern über seinen Read-Only-Pfad referenziert und beim Laden erneut gelesen; nur nicht wieder-öffnbare Audiodaten (lokale Importe ohne Pfad, eingefügte/ersetzte Clips) werden als Base64-WAV eingebettet.
- `Datei → Projekt speichern/öffnen` (Ctrl+S / Ctrl+Shift+O) sowie der Speichern-Button im Transport werden an die echte Projekt-Persistenz angebunden; der `ExportModal` nutzt im Desktop-Modus den nativen Speichern-Dialog (Browser-Fallback bleibt erhalten).
- Tests: `project-file.test.ts` (10 Checks: WAV-Kodierung, Roundtrip, keine Duplizierung quellgestützter Tracks, Versions-/Format-Validierung) und `path-guard.test.mjs` (Überschreib-Schutz).

**Verifikation mit Rekordbox 7:** Die Schlüssellogik und das Schema-Mapping sind gegen die veröffentlichten Spezifikationen getestet (12 + 12 + 6 + 11.000-Track-Checks). Die Entschlüsselung selbst ist jetzt ebenfalls maschinell abgedeckt: `tests/db-reader-open.test.mjs` schreibt eine echte SQLCipher-`master.db`, liest sie über `electron/dbReader.cjs` zurück und prüft die Fehlerpfade (12 Checks). Offen bleibt die einmalige Gegenprobe gegen die eigene Bibliothek auf dem Windows-Rechner (Analysepfade/Standorte können je nach Rekordbox-7-Einstellungen abweichen).

## Phase 5 – Testdaten-Paket & Korrektur des Extraktionspfads ✅

Der Lese-Pfad ist jetzt vollständig durch einen reproduzierbaren Datensatz abgedeckt. `tools/extract-20-eintraege.mts` erzeugt 20 Einzel-Einträge mit allen zugehörigen Daten in den Ordnern `Testdateien/` (Einzel-XML + Voll-JSON + Sammel-XML), `Audio/` (16-bit-PCM-WAV im Track-BPM) und `Datenbanken/` (SQLCipher-`master.db` + `exportLibrary.db`, Klartext-Dumps, `ANLZ/` mit `.DAT` und `.EXT`). Jeder Eintrag durchläuft die echte Pipeline: `xmlParser` → `waveform/analyzer` → `databaseExtractor` → `anlzParser` → `dbReader` → `dbParser`.

Dabei sind drei Fehler im Extraktionspfad aufgefallen und behoben:

- `electron/dbReader.cjs`: `openRekordboxDb()` lieferte `{ db, dbType }` ohne `available`, wodurch `readRekordboxDatabase()` jede *erfolgreich* entschlüsselte Bibliothek als Fehlschlag behandelte und den Dateihandle offen ließ – der Datenbank-Import war damit faktisch tot. Jetzt `{ available: true, db, dbType }`.
- `databaseExtractor.extractTrackFromRekordboxXml()`: Genre, Label, Rating, Play Count, Jahr, Kommentar, Remixer, die Roh-Attribute und die Read-Only-Referenz auf das Original fehlten im erzeugten `TrackModel` und gingen beim Laden in ein Deck verloren.
- `anlzParser.parseAnlzBinary()`: mehrere Cue-Sektionen derselben Quelle und Kategorie überschrieben sich still (letzte Sektion gewann). Sie werden jetzt zusammengeführt; `PCO2` hat unabhängig von der Sektionsreihenfolge Vorrang vor `PCOB`.

Tests: `extraction-completeness.test.ts` (8 Checks: Metadaten-Vollständigkeit, Sektions-Merge, PCO2-Vorrang bei umgekehrter Reihenfolge, Trennung Hot/Memory) und `db-reader-open.test.mjs` (12 Checks). Die erzeugten Datenbanken werden mit dem Projekt-Reader entschlüsselt (je 20 Tracks, 263 Cues); ohne installiertes `better-sqlite3-multiple-ciphers` meldet der Reader weiterhin nachvollziehbar `available: false` und der XML-Pfad bleibt funktionsfähig.
