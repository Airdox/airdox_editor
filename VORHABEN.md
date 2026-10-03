# Vorhaben: Rekordbox-Desktop-Importpfad

**Stand: 30.09.2026**

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
- Quellen werden wahlweise per Windows-Dateidialog oder über die automatische Ordnersuche (`Pioneer\Master|rekordbox7|rekordbox6|rekordbox` + `rekordboxAgent/storage/options.json`) geladen. `Master` ist die Ablage einer extern geführten Rekordbox-Bibliothek (`PIONEER\Master\master.db`); fehlte dieser Unterordner, fiel die Suche still auf eine fremde AppData-`master.db` zurück. Die options.json wird am **kanonischen Geschwister-Ort** `Pioneer\rekordboxAgent\storage\options.json` gelesen (alternativ innerhalb des Version-Ordners), `db-path` akzeptiert Datei- **und** Ordnerangaben – ein benutzerdefinierter Bibliotheksort geht damit nicht mehr verloren. Zusätzlich wird der vom Nutzer angegebene Export-Root `D:\PIONEER` read-only nach `master.db`/`exportLibrary.db` im Root sowie in `Master` und den bekannten `rekordbox*`-Unterordnern geprüft; ANLZ-Pfade `/PIONEER/...` werden über `editor_patch/analysisPath.cjs` relativ zum **Analysis-Data-Root** aufgelöst: erster Kandidat ist `analysis-data-root-path` aus derselben options.json (z. B. `D:\PIONEER\Master\share`), danach Datenbank-Root, Standard-Share und zuletzt der Export-Root `D:\PIONEER`. Sie werden ausdrücklich **nicht** relativ zu `D:\PIONEER` gesucht. Ein vollständig aufgeschriebener Laufwerkspfad bleibt unverändert und wird nicht auf eine andere Wurzel umgeschrieben (kein gleichnamiges ANLZ-Pendant als Ersatz). Nicht durch Laufwerkssuche oder Dateinamen-Raten; ein Override ist über `AIRODOX_REKORDBOX_ANALYSIS_ROOT` möglich (Test: `tests/analysis-path-root.test.mjs`). Bei `TRACK_NOT_FOUND_IN_MASTER_DB` nennt der Gate zusätzlich die durchsuchten Datenbankpfade, damit „Track fehlt“ von „falsche Bibliothek gesucht“ unterscheidbar bleibt (Test: `tests/rekordbox-locate-options.test.mjs`).
- **1:1-Regel (verbindlich, testfest):** Jeder Eintrag in der Rekordbox-XML (Exportdatei) hat genau einen Datenbankeintrag und genau die dazugehörigen Analyse-Dateien. Die einzige Verbindung ist die Rekordbox-TrackID (= `djmdContent.ID`). Es wird **nie** eine andere Datei, Zeile, Waveform oder Analyse genommen, weil etwas fehlt, gelöscht (`rb_local_deleted`) oder unerreichbar ist; es wird **nie** nach Titel/Künstler/Dateiname „ähnlich“ zugeordnet; und es wird **nie** selbst gerechnet (keine lokale FFT, keine Synthese), um fehlende Rekordbox-Analyse zu ersetzen. Fehlt ein Glied, bricht der Gate hart ab (`ANLZ_NOT_FOUND`, `TRACK_NOT_FOUND_IN_MASTER_DB`, …). Der Gate verwirft zusätzlich jede Zeile, deren ID nicht exakt der angefragten TrackID entspricht. Eine selbst berechnete Wellenform (`GENERATED_FALLBACK`) darf sich nie als Rekordbox-Daten ausgeben: keine erfundenen ANLZ-Tags, kein Validierungsvermerk (`databaseRecord.waveformOrigin`, `anlzTagsFound`). Das Nachladen von Audio zu einem Rekordbox-Track ist nur mit **exakt derselben** Originaldatei erlaubt und überschreibt ANLZ-Waveform/-Beatgrid/-Marker nicht. Nachweis: `tests/rekordbox-one-to-one-integrity.test.ts`.
- Natives Modul: `better-sqlite3-multiple-ciphers` ist **Pflichtabhängigkeit** (nicht mehr optional) und wird automatisch für die verwendete Electron-Version gebaut – siehe Phase 6.

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
- **`electron/masterDbGate.cjs` (verbindlich).** Pro Track, read-only: `TrackID` → `djmdContent` (gezielte Einzelzeilen-Abfrage `openContentRow`, inkl. `djmdCue`) → `AnalysisDataPath` → ANLZ → Original-Audio. Der Gate akzeptiert nicht nur „die Datei sieht gültig aus“, sondern **dekodiert die Waveform selbst** und meldet Abschnitt, Bucket-Anzahl und Amplitudenhöhe; erst damit gilt die Kette als bestanden. Der ANLZ-Container wird über die gemeinsame Spezifikation `src/rekordbox/anlzStructure.ts` gelesen (siehe Phase 6).
- **Zustandsmaschine statt Fallback.** Fehlercode-Status statt stiller Ersatzanalyse: `OK`, `MASTER_DB_NOT_FOUND`, `SQLCIPHER_UNAVAILABLE`, `MASTER_DB_OPEN_FAILED`, `MASTER_DB_SCHEMA_INVALID`, `TRACK_NOT_FOUND_IN_MASTER_DB`, `ANLZ_NOT_FOUND`, `ANLZ_READ_FAILED`, `ANLZ_INVALID`, `REKORDBOX_WAVEFORM_MISSING`, `ANLZ_WAVEFORM_UNREADABLE`, `ANLZ_SOURCE_MISMATCH`, `ORIGINAL_AUDIO_NOT_FOUND`. `handleSelectTrackFromXml()` bricht bei `gate.ok === false` ab und erzeugt nie `analyzeAudioBuffer`/`LOCAL_ANALYSIS`; Waveform und ANLZ-Beatgrid stammen aus tatsächlich dekodierten ANLZ-Sektionen. BPM/FirstBeat allein erzeugen kein Beatgrid und werden nicht als ANLZ-Grid umetikettiert; vorhandene XML-Metadaten bleiben als XML gekennzeichnet. Cues/Phrasen kommen aus ANLZ, XML oder – als letzte Marker-Quelle – `djmdCue` aus dem Gate.
- **Originalpfad = PPTH-Konsistenzbeweis.** Kandidaten sind XML-Location, `FolderPath`+`FileNameL` und ANLZ-`PPTH`. Geräteinterne Locations (`file://localhost//contents_…`) sind keine lokale Datei und werden nie geladen, sondern als verworfen dokumentiert. Existiert die `PPTH`-Quelle, hat sie Vorrang; passt keine existierende Datei zur `PPTH`, gibt es `ANLZ_SOURCE_MISMATCH` statt eine fremde Waveform anzuzeigen.
- **Renderer gegen Gate abgeglichen.** Nach dem Dekodieren muss die Bucket-Anzahl des Renderers exakt der vom Gate gemeldeten entsprechen, sonst `ANLZ_WAVEFORM_UNREADABLE`. Damit ist „die Waveform, die der Gate freigibt“ dieselbe wie „die Waveform, die der Editor zeigt“.
- **IPC-Brücke.** `rekordbox:resolve-track-gate` und `rekordbox:read-bundled-xml` (`electron/main.cjs`, `electron/preload.cjs`, `src/types/desktop.d.ts`); alle geprüften Quellpfade werden zusätzlich in der `OriginalSourceRegistry` registriert und bleiben damit vor Überschreibungen geschützt. Der lokale ANLZ-Pfadindex (`analysisRegistry.cjs`) bleibt als Cache für Projekt-Ladevorgänge erhalten, ist aber für den XML-Ladepfad nicht mehr die alleinige Quelle.
- **Tests.** `tests/master-db-gate.test.mjs` (Zustandsmaschine, XML→master.db-Fallback, ANLZ-Sektionswalk, Read-only-Kontrakt), `tests/rekordbox-track-import-pipeline.test.ts` (kein XML-Dateidialog, echte Sammlung mit TrackID `142225026`, Gate-Verdrahtung preload→main→Gate, erzwungene `REKORDBOX_ANLZ`-Herkunft, kein `LOCAL_ANALYSIS`-Fallback, electron-builder-Ressource), `tests/rekordbox-gate-hardening.test.mjs` und `tests/rekordbox-gate-integration.test.mjs` (siehe Phase 6).

## Phase 6 – Laufzeit-Härtung: SQLCipher, Diagnose und ehrlicher Nachweis 🟡

Ziel dieser Phase war **nicht** eine weitere Architektur, sondern der Nachweis,
dass die Kette aus Phase 5 auf einem echten Windows-Rechner tatsächlich
läuft – und dass der Build nicht erneut „erfolgreich“ sein kann, wenn sie es
nicht tut.

### Was implementiert ist

- **Eine einzige ANLZ-Spezifikation für Gate und Renderer.**
  `src/rekordbox/anlzStructure.ts` besitzt den Container-Walk (PMAI-Header,
  Sektions-Envelope, Legacy-Längenregel), den `PPTH`-Decoder und das Layout
  aller `PWAV`/`PWV2`–`PWV7`-Abschnitte samt Dekoder. `anlzParser.ts` importiert
  es; der Electron-Hauptprozess nutzt das deterministisch erzeugte Spiegelmodul
  `electron/generated/anlzStructure.cjs` (`npm run build:anlz-structure`).
  Die CI prüft mit `npm run build:anlz-structure:check`, dass das Spiegelmodul
  nicht veraltet ist, und `tests/anlz-structure-parity.test.ts` vergleicht beide
  Implementierungen über neun Fixtures semantisch (Tags, PPTH, Waveform-Auswahl,
  dekodierte Spalten Byte für Byte). Es gibt keine zweite, auseinanderlaufende
  ANLZ-Spezifikation mehr.
- **Gate und Renderer sind gekoppelt.** Der Gate dekodiert die Waveform und
  liefert `analysis.waveform = { tag, buckets, entryBytes, style, peakMax }`. Der
  Renderer muss `analysis.length === gate.analysis.waveform.buckets` liefern,
  sonst `ANLZ_WAVEFORM_UNREADABLE`. Kein FFT, keine Beat-Erkennung, keine
  Ersatzzählung – der gemeinsame Decoder liest ausschließlich Bytes, die
  Rekordbox geschrieben hat.
- **Original-Audio mit Konsistenzbeweis.** Kandidaten sind XML-Location,
  `FolderPath`+`FileNameL` und `PPTH`; Gerätepfade (`file://localhost//contents_…`)
  werden nie geladen. `PPTH` gewinnt, wenn es einen existierenden Kandidaten
  eindeutig identifiziert; andernfalls `ANLZ_SOURCE_MISMATCH`. Die
  Pfadnormalisierung ist mit `normalizeMediaPathForComparison()` im Renderer
  identisch, damit beide Seiten nie unterschiedlich urteilen.
- **Gate-Ergebnis landet am Track.** `analysisSource` und `databaseRecord`
  tragen jetzt TrackID, `contentId`, Datenbankpfad/-typ, `AnalysisDataPath`,
  `PPTH`, Originalpfad, Waveform-Herkunft, Cue-Quelle und `gateCode` –
  erweitert, nicht als zweite parallele Struktur.
- **Sichtbarer Herkunftsnachweis.** Nach dem Laden meldet die UI
  `SOURCE / DATABASE / ANALYSIS / WAVEFORM / CUES / AUDIO` (kleine Leiste im
  Track-Header plus Feedback-Dialog). Die GUI nennt bei Fehlern den echten
  Gate-Code (`[MASTER_DB_NOT_FOUND]`, `[SQLCIPHER_UNAVAILABLE]`, …) statt
  „Track konnte nicht geladen werden“.
- **Diagnose.** `npm run rekordbox:doctor -- 142225026` druckt je Glied der
  Kette einen Status (`Database`, `SQLCipher`, `djmdContent`, `Track`,
  `AnalysisDataPath`, `ANLZ`, `ANLZ structure`, `Waveform`, `PPTH`,
  `Original audio`, `FINAL`) und verändert niemals eine Datei.
  `npm run rekordbox:preflight` prüft Electron-Version, Modul, Ladefähigkeit,
  Cipher-Funktion und read-only geöffnete `master.db`.
- **Echter Windows-Lauf.** `npm run test:rekordbox:runtime -- 142225026`
  läuft `locateRekordboxDatabases() → openContentRow() → resolveTrackFromMasterDb()`
  ohne jede Simulation gegen die installierte Bibliothek, prüft
  `ok`, `code`, `dbType`, `content.id`, ANLZ-Welleform, PPTH-Konsistenz und
  Cues – und vergleicht master.db, ANLZ und Original-Audio vor/nach dem Lauf
  byteweise. Ohne Rekordbox-Installation: `SKIP`, nie ein falsches Grün.
- **Paketierung kann nicht mehr ohne SQLCipher durchlaufen.**
  `better-sqlite3-multiple-ciphers` ist Pflichtabhängigkeit, `npmRebuild` ist
  `true`. `beforePack` baut gezielt nur dieses Modul und **lädt es in der echten
  Electron-Laufzeit** (`ELECTRON_RUN_AS_NODE`); `afterPack` prüft `app.asar`, das
  native Binary im `app.asar.unpacked` und lädt das **gepackte** Modul in
  Electron. Jeder Fehler bricht den Build ab. `npm run desktop` baut das Modul
  für die Entwicklungs-Electron-Version automatisch; beim Start protokolliert der
  Hauptprozess den Laufzeitstatus.
- **Niemand schreibt in Rekordbox-Quellen.** `tests/rekordbox-gate-hardening.test.mjs`
  prüft für Gate, dbReader, ANLZ-Spiegel, Preflight, Doctor und Runtime-Test das
  Fehlen jeder Schreib-API sowie das read-only Öffnen (`readonly: true`,
  `fileMustExist: true`) und den Größen-/mtime-Vergleich der master.db. Einzige
  erlaubte Schreibung: die SQLCipher-Funktionsprobe des Preflights, die ihre
  eigene temporäre Datei im Systemtemp anlegt und wieder entfernt – der Scan
  schneidet diese Funktion explizit heraus und begrenzt sie auf `os.tmpdir()`.
- **Nachweise ehrlich gemacht (CI-Reparatur, 30.09.2026).** Der Push-Build war
  seit PR #65 rot, weil die neuen Phase-6-Tests drei echte Fehler aufdeckten,
  die behoben sind:
  1. `openRekordboxDb` meldete auch den *Erfolgsfall* nicht als
     `available: true` (Regression aus `2de7327`) – `openContentRow` und
     `readRekordboxDatabase` hätten auf jeder echten Installation
     `MASTER_DB_OPEN_FAILED` mit leerem Grund geliefert, obwohl die
     Datenbank einwandfrei entschlüsselt wurde.
  2. Die SQLCipher-Funktionsprobe lief auf einer `:memory:`-Datenbank;
     SQLCipher verweigert `PRAGMA key` dort ausdrücklich („Setting key not
     supported for in-memory or temporary databases"). Preflight, Doctor und
     die Packaging-Hooks wären damit **selbst auf gesunden Maschinen rot
     gewesen**. Alle Proben arbeiten jetzt auf einer eigenen temporären Datei
     im Systemtemp (read-only-Kontrakt gegenüber Rekordbox bleibt unberührt).
  3. Die electron-builder-Hooks hätten den Packvorgang zu Unrecht abgebrochen:
     `context.arch` ist ein Arch-Enum (`x64 = 1`), das `@electron/rebuild`
     aber den Klarnamen erwartet, und `asar.listPackage` liefert Pfade mit
     führendem `/` (unter Windows `\`), sodass der ANLZ-Spiegel-Check nie
     gegriffen hätte. Beides normalisiert; die Cipher-Probe in den Hooks
     nutzt ebenfalls eine Temp-Datei.
  Zusätzlich erkennt der Test-Runner fehlgeschlagene Tests jetzt als
  `::error`-GitHub-Annotations (die Job-Logs hängen an externem
  Blob-Storage, das nicht aus jeder Umgebung erreichbar ist), und die
  Preflight-Tests laufen deterministisch gegen einen isolierten App-Root,
  statt von der Installation auf der Testmaschine abzuhängen.

### Was noch offen ist (ehrlich)

- Der **vollständige Windows-Lauf gegen eine echte Rekordbox-Installation**
  (echte `master.db`, echte `SQLCipher`-Entschlüsselung, TrackID `142225026`,
  echte ANLZ, echtes Original-Audio, GUI bis zur angezeigten Waveform) wurde in
  dieser Umgebung **nicht** ausgeführt – dort ist weder Windows noch Rekordbox
  vorhanden. Das native Modul wurde für die lokale Suite manuell gegen die
  lokalen Node-Header gebaut; der Electron-Nachweis (`beforePack`/`afterPack`)
  läuft nur in der Windows-CI. Die Kette ist vorbereitet, automatisiert
  (`npm run test:rekordbox:runtime`, `npm run rekordbox:doctor`) und in der CI
  als eigener Schritt verankert; der Abschlussnachweis erfolgt auf einem
  Windows-Rechner mit Rekordbox. **Phase 5/6 gilt erst dann als abgeschlossen,
  wenn dieser Lauf grün ist.**
- `rekordbox_export2.xml` liegt als App-Ressource bei; die Track-Auswahl lädt
  nur den gewählten Track, nicht die ganze Bibliothek ins Deck.
