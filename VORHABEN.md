# Vorhaben: Rekordbox-Desktop-Importpfad

**Stand: 12.09.2026**

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
- Natives Modul: `better-sqlite3-multiple-ciphers` als optionale Abhängigkeit; `npm run rebuild:electron` baut es für Electron. CI-Builds kompilieren es automatisch (Weg A, inkl. `asarUnpack`-Packaging), sodass `master.db`/`exportLibrary.db` dort immer lesbar sind und DB-Tracks gezielt per `AnalysisDataPath` (ohne PPTH-Vollscan) aufgelöst werden. Falls das Modul fehlt, bleibt der XML-Pfad voll funktionsfähig und die App meldet den nicht verfügbaren Datenbank-Import nachvollziehbar. 0.4.20: Erfolgs-Flag (`available`) im DB-Open-Pfad ergänzt – zuvor wurde jede erfolgreiche Entschlüsselung grundlos als „nicht lesbar" verworfen; Fake-Modul-Regressionstest (`tests/db-read-pipeline.test.mjs`) sichert die Pipeline ohne natives Modul ab.

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
- **Ehrlich leere Spur ohne ANLZ (wie Original)**: Bis eine ANLZ-Zuordnung vorliegt, zeigen `DetailWaveform`/`TrackOverview` **keinerlei** Wellenform-Amplituden — das Original zeichnet ohne Analysedaten ebenfalls keine Wellenform, also wird nichts erfunden (weder Hüllkurven noch Vorschau-Konturen mit Pseudo-Amplituden). Sichtbar bleiben ausschließlich die importierten Gitterdaten (Beat-Linien, Takt-Nummern, Cues, Loops, Takt-Ticks auf der Overview) plus ehrlicher Hinweistext; Status-Chip/Footer melden `KEINE WAVEFORM (ANLZ fehlt)` statt „VORSCHAU-PEAKS“. Ohne Beatgrid bleibt die Spur leer mit Hinweis.
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

## Phase 5 – Visueller Lock auf das Rekordbox-Original ✅

Die ANLZ-Daten werden unverändert übernommen; sämtliche Abweichung zum Original lag in der Visualisierung und wurde gegen die Referenz-Screenshots (`reference/01–03`) beseitigt:

- **Dokumentierte Visualisierungen statt Eigenberechnung** (Deep Symmetry / crate-digger, `src/waveform/renderModel.ts`):
  - **PWV5 (RGB-Detail)**: Die gespeicherten 3-Bit-Komponenten SIND die Spaltenfarbe (`rgbColumnColor`), der 5-Bit-Wert die Spaltenhöhe — keine Mischformel, keine geschachtelten Balken, keine erfundene Spine.
  - **PWAV/PWV2/PWV3 (blau)**: 5-Bit-Höhe + dokumentierte 3-Bit-Whiteness → Blau-Rampe „dunkelstes Blau bis fast Weiß“ (`monoBlueColor`); die Whiteness-Bits wurden früher verworfen und durch eine feste Kern-Linie ersetzt.
  - **PWV4 (Farb-Preview)**: 6-Byte-Layout (Luminanz, Blau-Intensität, R, G, B) → zweitonige Spalten: hinten `rgb·Luminanz` mit `max(d2,r,g)`-Höhe, vorn geboostet mit gespeicherter Front-Höhe (`pwv4BackColor`/`pwv4FrontColor`).
  - **PWV6/PWV7 (3-Band)**: dokumentierte Farben Low = dunkelblau, Mid = amber (transluzent, Überlappung wirkt braun), High = weiß, auf derselben Achse, High zuletzt (`threeBandLayers`).
- **Kamm-Geometrie**: Spalten breiter als 2 px erhalten eine 1-px-schwarze Lücke wie im Original (`columnDrawWidth`).
- **Alternierende Takt-Schattierung** hinter der Wellenform (`isBarShaded` + `BAR_SHADE_FILL`) sowie dunkle Takt-Ticks auf der Overview.
- **Scharfes Canvas**: Beide Wellenform-Canvases werden mit `devicePixelRatio`-Skalierung (ResizeObserver) hinterlegt statt gestrecktem 1200×320-Bitmap.
- **Ehrlich leer statt Eigenberechnung**: Der ANLZ-lose Fallback hat zuerst eine selbst berechnete Pseudo-Wellenform (Kick/Sub/Hat-Hüllkurven, erfundene Break-Takte) und danach eine Block-Kontur mit Pseudo-Amplituden gezeichnet — beides entfernt. Ohne ANLZ bleibt das Wellenform-Pane leer wie im Original; nur Gitterdaten (Beat-Linien, Takt-Nummern, Overview-Ticks) und Hinweistext werden gezeichnet, Status/Footer melden `KEINE WAVEFORM (ANLZ fehlt)`.
- **Overview ohne Mittelung**: Jede geladene ANLZ-Spalte wird direkt auf ihre Displayposition abgebildet; keine Peak-Hold-, Mittelwert- oder Glättungsaggregation.
- **Auto-Align** nutzt für die Transientensuche ausschließlich die gespeicherten Spaltenhöhen (`peaks`), keine eigene Kanal-Gewichtung.
- **DB-Pfad-Diagnose sichtbar**: Der Status-Chip meldet bei fehlender ANLZ jetzt zusätzlich den Zustand des DB-Pfads (`DB x/y LESBAR • n LINKS` inkl. Grund, z. B. fehlendes SQLCipher-Modul oder keine DB gefunden); ein fehlgeschlagener DB-Erstversuch bekommt genau einen Retry (`dbIndexDiagRef` in `src/App.tsx`).

Tests: `tests/render-look.test.ts` (R1–R7: PWV5-Farb-Pass-through, Blau-Rampe, PWV4-Zweiton-Formeln, 3-Band-Farben/-Reihenfolge, Kamm-Geometrie, Takt-Schattierung, PWV5-End-to-End-Pass-through, ehrlich leeres Pane ohne ANLZ, Peak-Hold statt Mittelung).

## Phase 6 – Drag & Drop im Editor + projizierte Folgezustände ✅

Ziel: Überall dort, wo es einen Sinn ergibt, wird gezogen und fallengelassen — und danach zeigt
die Deckansicht **die** Wellenform der bearbeiteten Timeline, nicht mehr die des Originals.

**Drag & Drop-Quellen und -Ziele** (ein gemeinsamer Protokollvertrag in `src/dnd/dragPayload.ts`):

| Ziehen von | Ablegen auf | Wirkung |
|---|---|---|
| Clip in der Schnipselpalette (Sidebar) | Timeline in Deck A | Einfügen an der Drop-Position; Shift/Ctrl = Bereich ersetzen, Alt = überlagern |
| Clip in der Schnipselpalette (Sidebar) | Papierkorb-Button | Clip löschen |
| Auswahl-Chip im Detail-Wellenform-Footer | Schnipselpalette | Auswahl wird neuer Clip (Timeline bleibt unverändert) |
| Clip-Karte in der Palette-/Deckansicht | „In Deck A einfügen“ / „Auswahl ersetzen“ / „Überlagern“ | dieselbe Wirkung wie der Button-Klick |
| Clip-Karte in der Deckansicht (FULL_DECK) | Clip-Vorschaufläche | Einfügen an Playhead |
| Insert-Block in der Edit-Spur unter der Wellenform | Timeline | Block verschieben (kein Löschen/Neu-Einfügen, Marker im Block wandern mit) |
| Titel in der Browser-/Sammlungsleiste | Deck A | Track wird ins Deck geladen (Timeline-Reset auf dieses Deck) |
| Audiodatei / Rekordbox XML aus dem Windows-Explorer | überall im Fenster | Import (Overlay meldet es; interne Drags werden nie als Dateidrop fehlgedeutet) |

Modifier, Drop-Fenster und Clip-Länge werden nicht im UI berechnet, sondern von einem reinen
Planer (`src/edit/editDrop.ts → planClipDrop`) abgeleitet; die Drop-Vorschau (Geist + Modus-Text)
nutzt exakt dieselbe Geometrie, die anschließend projiziert wird.

**Folgezustände: eine Ableitung für Audio, Wellenform, Dauer und Marker.** Nach jedem Edit (und
nach Undo/Redo sowie nach dem Öffnen eines Projekts) leitet `projectTrackEdits()`
(`src/edit/editModel.ts`) aus der Segmentliste alles neu ab: Timeline und Spans
(`src/edit/editTimeline.ts`), Working-Audio (`src/edit/projectedAudio.ts`), Waveform-Varianten mit
Spalten-Herkunft (`src/edit/editWaveform.ts`), Projekt-Dauer und die Edit-Spur unter der Wellenform.
Es gibt damit keinen Zustand, in dem Wellenform und Audio unterschiedliche LAYOUTS zeigen — das
war der Fehler, den alte Edit-Handler hinterließen (Audio wurde neu gerendert, die Wellenform blieb
die des Originals, Delete/Clear löschten die Rekordbox-Analyse stattdessen komplett).

**Antwort auf „muss dafür neu analysiert werden?“: Nein.** Wo bereits ANLZ-Spalten existieren, wird
der bearbeitete Bereich **aufgerechnet** — reines Index-Umschreiben der gespeicherten Spalten, ohne
Interpolation, Mittelung oder Glättung:

- Spalte `i = floor(t / secPerBucket)` des Ursprungs → Ausgabespalte `j = floor(t′ / secPerBucket)`;
  unveränderte Originale bleiben `ANLZ`, nach einem Shift `ANLZ_RETIMED` (Werte identisch, Position neu).
- Ein reingezogener Clip kopiert die Spalten seiner Quell-Datei (`CLIP_ANLZ`) — aber nur, wenn
  `spanAllowsVerbatimClipColumns()` sie erlaubt: Tempo­faktor 1, kein Pitch-Shift, Neutral-Gain,
  Quelle mit bekannter Track-ID und Quellenfenster. Zeitgedehntes Material darf niemals so tun, als
  hätte es Originaldaten.
- Clear schreibt echte Nullen (`SILENCE`), Overdub mischt pro Spalte das Maximum (`MIX`), und wo
  keinerlei Vorfahr existiert, bleibt die Spalte `MISSING` (leeres Pane + Hinweis) oder wird aus dem
  Edit-Audio gemessen und ist dann als `COMPUTED` / `USER_EDIT` gekennzeichnet.
- Originale bleiben unverändert: `baseAnalysis`/`baseAnalysisVariants` sind eingefroren, die
  Komposition ist nie Eingabe für die nächste Komposition und wird nie persistiert (`.airdox`-Dateien
  speichern Segmente und Marker, keine Waveform-Arrays).

Kürzungs-/Verschiebeeffekte auf Cues, Loops, Phrasen und Beat-Knoten laufen inkrementell über
dasselbe Delta (`retimeCues`/`retimeLoops`/`retimePhrases`/`retimeBeatNodes`); Füll-Beats über eine
Lücke entstehen nur, wenn das Deck bereits importierte Knoten hatte, und werden mit `insertGrid`
markiert (Herkunft dann `USER_EDIT` — die veränderte Rekordbox-Grid-Zeile bleibt sichtbar).

**Warum „nicht wissbare Analysedaten“ eben doch teilweise wissbar sind:** Die Wellenform ist eine
Peak-/Band-Indikator-Darstellung pro Zeitfenster. Ein reiner Schnitt verschiebt nur die Fenster —
die gespeicherten Werte gelten weiter. Neu gemessen werden muss ausschließlich Material, dessen
Samples erst durch den Edit entstehen (Clipboard ohne Quellenfenster, zeitgedehnte Clips, Overdub-Summe).

Tests (in `npm test` aufgenommen): `tests/edit-timeline.test.ts` (17), `tests/edit-waveform.test.ts` (10),
`tests/edit-model.test.ts` (9), `tests/edit-audio.test.ts` (6), `tests/edit-dnd.test.ts` (21: Payload-
Protokoll inkl. Foreign-Drag-Ablehnung, Modifier-Semantik, Drop-Geometrie, Folgezustand eines echten
Drops durch die echte Projektion — inkl. Nachweis, dass ein Drop mit ANLZ-Vorfahr **null** eigene
Analysen auslöst). Audit-Ergänzung: `REKORDBOX_PIPELINE_IMPLEMENTATION_AUDIT.md` → „Edit projection audit“.
