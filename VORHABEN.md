# Vorhaben: Rekordbox-Desktop-Importpfad

**Stand: 09.09.2026**

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
- Natives Modul: `better-sqlite3-multiple-ciphers` als optionale Abhängigkeit; `npm run rebuild:electron` baut es für Electron. CI-Builds kompilieren es automatisch (Weg A, inkl. `asarUnpack`-Packaging), sodass `master.db`/`exportLibrary.db` dort immer lesbar sind und DB-Tracks gezielt per `AnalysisDataPath` (ohne PPTH-Vollscan) aufgelöst werden. Falls das Modul fehlt, bleibt der XML-Pfad voll funktionsfähig und die App meldet den nicht verfügbaren Datenbank-Import nachvollziehbar.

## Phase 4 – Desktop-Export- & Projekt-Pfad ✅

Der Lese-Pfad (XML → ANLZ → Datenbank) wird um den Schreib-Pfad ergänzt, der den nicht-destruktiven Roundtrip vollendet. Exporte und Projektdateien werden ausschließlich als **neue Dateien** über den nativen Windows-Dialog gespeichert; das Überschreiben einer Original-Rekordbox-Quelle (Audio, XML, ANLZ, Datenbank) wird hart verweigert.

- Write-Bridge: `saveExportFile` + `openProjectFile` (`electron/main.cjs`, `preload.cjs`, `src/types/desktop.d.ts`). Der Zielpfad wird in `electron/pathGuard.cjs` (pfad- und groß/kleinschreibungs-insensitiv) gegen die Originalpfade geprüft; bei Kollision schlägt der Export fehl, statt zu überschreiben.
- Versioniertes Projektformat `.airdox.json` (`src/rekordbox/projectFile.ts`): Projektname, Deck-Tracks (Metadaten, Cues, Loops, Beatgrid-Anker, Edit-Segmente), Palette-Clips und Auswahl. Original-Audio wird nicht dupliziert, sondern über seinen Read-Only-Pfad referenziert und beim Laden erneut gelesen; nur nicht wieder-öffnbare Audiodaten (lokale Importe ohne Pfad, eingefügte/ersetzte Clips) werden als Base64-WAV eingebettet.
- `Datei → Projekt speichern/öffnen` (Ctrl+S / Ctrl+Shift+O) sowie der Speichern-Button im Transport werden an die echte Projekt-Persistenz angebunden; der `ExportModal` nutzt im Desktop-Modus den nativen Speichern-Dialog (Browser-Fallback bleibt erhalten).
- Tests: `project-file.test.ts` (10 Checks: WAV-Kodierung, Roundtrip, keine Duplizierung quellgestützter Tracks, Versions-/Format-Validierung) und `path-guard.test.mjs` (Überschreib-Schutz).

**Verifikation mit Rekordbox 7:** Die Schlüssellogik und das Schema-Mapping sind gegen die veröffentlichten Spezifikationen getestet (12 + 12 + 6 + 11.000-Track-Checks); die tatsächliche Entschlüsselung einer echten `master.db`/`exportLibrary.db` sollte auf dem Windows-Rechner einmalig gegen die eigene Bibliothek bestätigt werden (Analysepfade/Standorte können je nach Rekordbox-7-Einstellungen abweichen).

## XML-Import-Garantie (verbindlich)

Für Tracks mit Rekordbox-Herkunft (`REKORDBOX_XML`, `REKORDBOX_DB`, `REKORDBOX_ANLZ`) stammen **alle** visualisierten Daten ausschließlich aus Rekordbox-Quellen. Der Workflow in `src/App.tsx` (`handleSelectTrackFromXml`, `tryAutoLoadAnlz`, `isRekordboxOrigin`) garantiert:

- **Beatgrid** ← XML-`TEMPO`-/DB-Parameter (uniforme Rekonstruktion) bzw. ANLZ-PQTZ-Einzelpositionen, die im Modell **und** im Renderer (`DetailWaveform`) Vorrang vor der uniformen Neuberechnung haben.
- **Waveform** ← ausschließlich ANLZ (`PWAV`/`PWV2`–`PWV7`); es läuft **keine** eigene Peak-Analyse (`analyzeAudioBuffer` wird für diese Tracks nicht aufgerufen). Auto-Resolve und Desktop-Import laden deterministisch **beide** Geschwister-Container (`ANLZnnnn.DAT` **und** `ANLZnnnn.EXT`, via `deriveSiblingExtension` + `mergeAnlzExtractions`), da volle Farb-Waveform (`PWV5`), Phrasen (`PSSI`) und Farb-Cues (`PCO2`) nur in der EXT liegen. Mono-Vorschau-Varianten (`PWAV`/`PWV2`/`PWV3`) werden im authentischen Rekordbox-Blau gerendert, Band-Varianten in der Spektral-Palette.
- **ANLZ automatisch aus der lokalen Rekordbox-DB** (`ensureDbAnalysisIndex` in `App.tsx`): Beim Start (und lazy beim ersten Track-Load) scannt die App `%APPDATA%\Pioneer\rekordbox*` read-only nach `master.db`/`exportLibrary.db`, baut den exakten Audio-Pfad → `AnalysisDataPath`-Index und verknüpft XML-Tracks ohne eigene `AnalysisDataPath` deterministisch (nur exakte Pfadtrenffer, kein Fuzzy-Matching). Die zugehörige ANLZ-Datei wird dann automatisch mit DAT+EXT-Gezwister-Container geladen – kein manueller DATA-Klick nötig. Ohne lokale DB/lesbares SQLCipher-Modul bleibt der manuelle Import (DATA-Panel, `chooseRekordboxDatabase`) der Rückfall.
- **ANLZ automatisch per PPTH-Scan** (`ensureAnlzPpthIndex` + `scanAnlzForPaths` in `electron/dbReader.cjs`): **SQLCipher-unabhängiger Fallback** für den Fall, dass keine `master.db`/`exportLibrary.db` lesbar ist. Jeder ANLZ-Container speichert den exakten Audio-Pfad im `PPTH`-Header (UTF-16BE, vgl. Deep-Symmetry-Spezifikation — PPTH enthält kein Total-Time-Feld); die Main-Prozess-Bridge liest aus den Standard-Verzeichnissen (`%APPDATA%\Pioneer\rekordbox*\share\PIONEER\USBANLZ`, read-only, nur Header) die PPTH-Pfade aller Container – **rekursiv**, da Rekordbox sämtliche Container in verschachtelten Unterordnern unterhalb von `USBANLZ/` ablegt (`USBANLZ/<Bucket>/<ID>/ANLZnnnn.DAT`; dokumentiert u. a. in rekordcrate — „nested subdirectories"); flache Layouts funktionieren weiterhin. Sicherheitsgrenzen: max. 8 Ebenen, max. 100.000 Dateien, keine Symlinks (bei Limit: `truncated`-Flag im Log). Zusätzlich werden die Laufwerke der Scan-Ziele auf Export-Analyse geprüft (`<Laufwerk>:\PIONEER\USBANLZ`, z. B. `G:\…` bei Audio auf Export-Medien) sowie verschobene Bibliotheken über `rekordboxAgent/storage/options.json` (Root-Ebene unter `Pioneer\`, nicht in den Versionsordnern): `analysis-data-root-path` (z. B. `D:\PIONEER\Master\share` bei Rekordbox 7.2.16) liefert dessen `PIONEER\USBANLZ`-Baum, `db-path` die `master.db` (z. B. `D:\PIONEER\Master\master.db`). **Tier 1** = exakter Pfadtrenffer (inkl. Normalisierung von `file://`, `\\?\`-Long-Path-Präfix, Groß/Kleinschreibung, Trennern); **Tier 2** = eindeutiger Dateinamen-Treffer (Datei wurde nach der Analyse verschoben – wird als „PRÜFEN!" markiert). Ordner-Erkennung zusätzlich rekursiv unter dem Pioneer-Root (rekordbox6/7/Custom-Layouts). Einmalig lazy pro Session, Treffer und Verfehlungen werden gecacht; neue XML-Sammlungen lösen einen erneuten Scan aus. Seit 0.4.19: PPTH wird als Tag im PMAI-Container gesucht (UTF-16BE/LE/ASCII, Offset-0-Layout als Legacy-Fallback); EXT-Geschwister mit DAT-Partner werden ohne Re-Read zugeordnet; der Scan läuft asynchron mit Fortschritts-Toast (kein UI-Freeze bei 20k+ Dateien); das Log meldet zusätzlich die Zahl extrahierter PPTH-Pfade (Diagnose: Extraktion vs. Matching) und alle DB-Auto-Ergebnisse (Kandidaten/Gründe) sichtbar im Diagnosebericht.
- **ANLZ-Status ist im UI sichtbar** (keine DevTools nötig): TrackHeader zeigt einen Status-Chip (`ANLZ OK • PWV5` / `ANLZ via DATEINAME – PRÜFEN!` / `KEIN ANLZ • SCAN N DAT.` mit Hover-Details), der DetailWaveform-Footer zeigt das Scan-Ergebnis (`KEIN ANLZ (SCAN N DAT.)` statt bloßem `VORSCHAU-PEAKS`). Die laufende Build-Version steht in Titelleiste, Track-Header und Info-Modal (Vite-`__APP_VERSION__` aus `package.json`).
- **Keine leere Spur ohne ANLZ**: Bis eine ANLZ-Zuordnung vorliegt, zeigen `DetailWaveform`/`TrackOverview` eine explizit als **„VORSCHAU“** gekennzeichnete Beatgrid-Kontur (nur BPM/Bar-Struktur des importierten Rekordbox-Beatgrids, 55 % Alpha, mit Hinweistext) – keine erfundenen Peaks, keine `analyzeAudioBuffer`. Ohne Beatgrid bleibt die Spur leer mit Hinweis.
- **Cues/Loops** ← XML/`djmdCue`/ANLZ, unverändert übernommen (robuster `POSITION_MARK`-Parser toleriert Alternativ-Tags `CUE`/`HOT_CUE`/`MEMORY_CUE`/`MARK` und attributnamenunabhängige `Start`/`Position`/`Time`, `Name`/`Comment`, `Num`/`Number`, RGB case-insensitiv; Loop-Erkennung via `End`; **ohne Positions-Attribut wird ein Mark-Element ignoriert** – verhindert False-Positives bei Fremd-Exporten); **Phrasen** ← ausschließlich ANLZ-PSSI (kein Template).
- **Kein Ersatz-Audio**: Ist das Original nicht lesbar, lädt der Track metadatenbasiert (Dauer aus XML/DB); die UI meldet, was fehlt. DB-Tracks mit `AnalysisDataPath` lösen ihre ANLZ-Datei automatisch auf (mit PPTH-Plausibilitätsprüfung).
- **Renderer synthetisieren keine Waveform-Daten**: Echte Peaks/Phrasen kommen nur aus ANLZ; die VORSCHAU-Kontur ist die einzige Ausnahme und ist immer als Vorschau beschriftet (`DetailWaveform`, `TrackOverview`).
- **Keine Demo-/Testdaten in der App**: kein Demo-Starttrack und keine synthetischen Fallbacks — Demo-Bootstrap, `DEFAULT_REKORDBOX_XML`, `src/audio/synthesizerTrack.ts`, `generateRekordboxPhrases` (Template-Phrasen) und `generateAnalysisFromMetadata` (Pseudo-Waveform) wurden entfernt; die App startet stringent leer. `GENERATED_FALLBACK` bleibt ausschließlich als ehrliche Herkunftsmarkierung im Typ-Enum bestehen. Test-Fixtures liegen unter `tests/fixtures/`, nicht im App-Quelltext (`src/`).

Tests: `tests/xml-exclusive-import.test.ts` (PQTZ-Erhalt, Tail-Ergänzung, Legacy-Grid, Synthese-Verbot, Cue-Parser-Guard), `tests/anlz-ext-merge.test.ts` (Sibling-Ableitung DAT↔EXT, Merge-Prioritäten, Track-Integration), `tests/anlz-ppth-scan.test.mjs` (PPTH-Header-Scan: UTF-16BE/LE, DAT+EXT-Paarung, Tier-1-Exakttreffer, Tier-2-Name-Treffer inkl. Ambiguitäts-Ausschluss, rekursive Unterordner-Suche inkl. DAT+EXT-Paarung in Unterordnern, Export-Laufwerk-Scan (`<Laufwerk>:\PIONEER\USBANLZ`), `tests/options-json.test.mjs` (echte RB-7.2.16-Struktur: Root- vor Nested-Priorität, `db-path`-/`analysis-data-root-path`-Auflösung, Tier-1-Treffer aus verschobenem Baum), `\\?\`-Präfix, Read-Only), `tests/import-simulation.test.ts` (u. a. Synthese-Verbot: keine Waveform/Phrasen ohne echte Quelle). Fixtures: `tests/fixtures/testDatasets.ts`.

## Log-Datei (Diagnose aller entscheidenden Parameter)

Jeder Eintrag des In-App-Logs wird in der Desktop-Version zusätzlich **dauerhaft** in eine Datei gespiegelt, damit eine fehlende Waveform nachträglich eindeutig diagnostizierbar ist:

- **Ort**: `<userData>/airdox-smart-editor.log` (Windows: `%APPDATA%/airdox_SMART_Editor/airdox-smart-editor.log`); Rotation bei 5 MB → `airdox-smart-editor.prev.log`. Der Pfad steht im **System-Log-Modal** mit Button „Im Ordner zeigen".
- **Format** (`electron/logWriter.cjs`): eine Zeile pro Eintrag `ISO-Zeitstempel LEVEL [KATEGORIE] Nachricht | {JSON-Details}`, zeilensicher, abgeschnitten bei 2.000/4.000 Zeichen; Schreibfehler brechen niemals die App.
- **Gespiegelte Entscheidungsparameter**: ANLZ-Auflösung (`analysisDataPath`, `sourceDbDir`, `resolved`), Dateigrößen, Tags, **Waveform-Varianten je Tag inkl. Bucket-Anzahl**, beste Variante, Beat-Knoten/BPM/First-Beat, Cues/Loops/Phrasen-Zählung, PPTH-Plausibilität, Schwesterdatei (EXT: geladen/Grund des Fehlschlags), Merge-Ergebnis auf dem Track (`waveformSource`, `variants`, `beatGridOrigin`), Deck-Ladung (Origin, Media-Status, `hasAudio`, Dauer, Regel `ANLZ_ONLY`), DB-/XML-Import-Zählwerte inkl. Link-Index — plus explizite Warnungen bei **ANLZ ohne PWV-Variante** und **Rekordbox-Track ohne Waveform**.
- Bricht der Waveform-Pfad, zeigt die Datei exakt den fehlgeschlagenen Schritt (Auflösung → Lesen → PWV-Parsing → Merge → Renderer-Regel `ANLZ_ONLY`).

Tests: `tests/log-writer.test.mjs` (Format, Zeilensicherheit, Zirkular-Schutz, Trunkierung, Rotation, Never-Throws).
