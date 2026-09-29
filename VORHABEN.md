# Vorhaben: Rekordbox-Desktop-Importpfad

**Stand: 29.09.2026**

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

**Verifikation mit Rekordbox 7:** Die Schlüssellogik und das Schema-Mapping sind gegen die veröffentlichten Spezifikationen getestet (12 + 12 + 6 + 11.000-Track-Checks); die tatsächliche Entschlüsselung einer echten `master.db`/`exportLibrary.db` sollte auf dem Windows-Rechner einmalig gegen die eigene Bibliothek bestätigt werden (Analysepfade/Standorte können je nach Rekordbox-7-Einstellungen abweichen).

## Phase 5 – Master-DB-Gate & eingebettete Sammlung ✅

Der Track-Lade-Pfad ist jetzt eine rein Rekordbox-getriebene Kette ohne jede eigene Analyse als Fallback:

```
TRACK IMPORT → eingebettete rekordbox_export2.xml (kein Dateidialog)
     → bestehendes Track-Auswahlfenster
     → MASTER DB GATE (TrackID → djmdContent → AnalysisDataPath → ANLZ → Original-Audio)
     → Stack/Editor, 100 % Rekordbox-Analyse
```

- **Eingebettete XML statt Dateidialog.** Der Track-Import lädt `rekordbox_export2.xml` (10,5 MB, 12.246 Tracks) als App-Ressource: in der Desktop-App über `readBundledRekordboxXml()` aus `resources/rekordbox/rekordbox_export2.xml` (electron-builder `extraResources`), im Browser/Dev-Bundel als Vite-Asset derselben Datei. Externer XML-Import per Menü, Dateidialog oder Drag & Drop bleibt deaktiviert; der Parser (`src/rekordbox/xmlParser.ts`) bleibt unverändert im Einsatz.
- **`electron/masterDbGate.cjs` (verbindlich).** Pro Track, read-only: `TrackID` → `djmdContent` (gezielte Einzelzeilen-Abfrage `openContentRow`, inkl. `djmdCue`) → `AnalysisDataPath` → ANLZ-Struktur- und Waveform-Check (`PWAV`/`PWV2`–`PWV7`) → Original-Audio. Die XML-Location hat Vorrang als Originalpfad; fällt sie aus (z. B. geräteinterne `file://localhost//contents_…`-Pfade), übernimmt `FolderPath`+`FileNameL` aus der `master.db`.
- **Zustandsmaschine statt Fallback.** Fehlercode-Status statt stiller Ersatzanalyse: `MASTER_DB_NOT_FOUND`, `SQLCIPHER_UNAVAILABLE`, `MASTER_DB_OPEN_FAILED`, `MASTER_DB_SCHEMA_INVALID`, `TRACK_NOT_FOUND_IN_MASTER_DB`, `ANLZ_NOT_FOUND`, `ANLZ_READ_FAILED`, `ANLZ_INVALID`, `REKORDBOX_WAVEFORM_MISSING`, `ORIGINAL_AUDIO_NOT_FOUND`. `handleSelectTrackFromXml()` bricht bei `gate.ok === false` ab und erzeugt nie `analyzeAudioBuffer`/`LOCAL_ANALYSIS`; Waveform, Beatgrid, Cues und Phrasen stammen ausschließlich aus ANLZ (`DataOrigin.REKORDBOX_ANLZ`), XML oder – als letzte Marker-Quelle – `djmdCue` aus dem Gate. Als Originalpfad wird die XML-Location bevorzugt; weicht sie von der ANLZ-`PPTH`-Quelle ab (veraltete Export-Location, umgezogene Bibliothek), entscheidet die PPTH-Quelle – und nur wenn alle Kandidaten fehlen, gibt es `ORIGINAL_AUDIO_NOT_FOUND`.
- **IPC-Brücke.** `rekordbox:resolve-track-gate` und `rekordbox:read-bundled-xml` (`electron/main.cjs`, `electron/preload.cjs`, `src/types/desktop.d.ts`); alle geprüften Quellpfade werden zusätzlich in der `OriginalSourceRegistry` registriert und bleiben damit vor Überschreibungen geschützt. Der lokale ANLZ-Pfadindex (`analysisRegistry.cjs`) bleibt als Cache für Projekt-Ladevorgänge erhalten, ist aber für den XML-Ladepfad nicht mehr die alleinige Quelle.
- **Tests.** `tests/master-db-gate.test.mjs` (alle 11 Codes inkl. XML→master.db-Fallback, ANLZ-Sektionswalk exakt nach `anlzParser.ts`, Read-only-Kontrakt) und `tests/rekordbox-track-import-pipeline.test.ts` (kein XML-Dateidialog, echte Sammlung mit TrackID `142225026`, Gate-Verdrahtung preload→main→Gate, erzwungene `REKORDBOX_ANLZ`-Herkunft, kein `LOCAL_ANALYSIS`-Fallback im Ladepfad, electron-builder-Ressource).
