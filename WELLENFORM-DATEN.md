# Woher die Daten für die Wellenform kommen

Dokumentiert den tatsächlichen Code-Pfad – keine Wunschbeschreibung. Maßgeblich sind
`src/rekordbox/xmlParser.ts`, `src/rekordbox/anlzParser.ts`,
`src/rekordbox/databaseExtractor.ts`, `src/audio/pcm.ts`, `src/audio/wav.ts`,
`src/waveform/analyzer.ts`, `src/components/DetailWaveform.tsx`,
`src/components/TrackOverview.tsx`, `electron/main.cjs` und `src/App.tsx`.

## Kurzfassung: die Vorrangfolge

| Vorrang | Datenquelle | Was sie liefert | `WaveformAnalysisData.origin` |
| --- | --- | --- | --- |
| 1 | **ANLZ-Analyse** der Rekordbox (`.DAT`, `.EXT`, `.2EX`) | Fertige Peak-Buckets (PWAV/PWV2…PWV7), Beatgrid, Cues, Loops, PSSI-Phrasen | `REKORDBOX_ANLZ` |
| 2 | **Eigene Analyse** des geladenen Tonträgers (`analyzePcm`) | Peaks L/R/Mono + Drei-Band-Energie aus den Samples | `LOCAL_ANALYSIS` |
| 3 | **Projektdatei** (`.airdoxproj.json`) | EINGEBETTETE Arbeitskopie → wird wie Schritt 2 analysiert | `PROJECT` |
| – | **Rekordbox XML** | *Keine* Wellenform – nur Metadaten, Beatgrid-Rahmen, Marker, Loops, Dateipfad | – |

Der Wichtigste Satz: **Die Rekordbox-XML enthält keine Wellenformdaten.** Sie enthält
allenfalls `Location` – den Pfad zum Tonträger. Eine Wellenform entsteht erst, wenn
entweder die ANLZ-Datei der Rekordbox gelesen oder das Audio selbst analysiert wird.
Ein Track, dem beides fehlt, bleibt ein reiner Metadaten-Track mit `analysis: null`,
und das Deck zeigt den Hinweis „Kein Track geladen“ statt einer erfundenen Kurve.

## Regel: 100 % Rekordbox-Daten

Project Goal dieses Projekts ist: „Alle visuellen und zeitlichen Daten müssen zu
100 % aus den realen Rekordbox/Hackerblocks-Daten stammen … Eine eigene
Analyse-Engine ist nicht das Ziel." Daraus folgt für den Code-Pfad:

* **Rekordbox analysiert, wir importieren, modellieren, zeichnen und schneiden.**
  `analyzePcm` in `src/waveform/analyzer.ts` ist die einzige Stelle, die selbst
  rechnet, und sie arbeitet ausschließlich dort, wo Rekordbox nichts geliefert hat
  (eigene WAV-Datei, Demospur) oder wo ein Eingriff Material erzeugt hat, das in
  keiner Importkurve steht.
* **Originaldaten gewinnen.** Steht ein Wert in der Datei, wird genau dieser Wert
  dargestellt: Beatzeit aus PQTZ (nicht `firstBeat + i · 60/bpm`), Bucket aus
  PWAV/PWV3…PWV7, Taktanfang und Schlag-im-Takt aus den importierten Einträgen,
  Taktmaß aus dem Abstand der Taktanfänge (`inferMeter` in `anlzParser.ts`) bzw.
  aus `Metro` der XML; in der XML zählt jeder `<TEMPO>`-Eintrag, nicht nur der
  erste (`buildBeatGridFromTempoPoints` in `xmlParser.ts`).
* **Kein stillschweigender Fallback.** Jede Abweichung trägt ein Etikett:
  `origin` an Analyse und Beatgrid, `beatGrid.beatsAreDerived` für Raster, die aus
  Anker und Tempo fortgeschrieben statt eingelesen wurden (im Editor:
  „GRID 128.0 BPM · FORTGESCHRIEBEN"),"  `recomputed` an der Kurve (Zeiträume eigener
  Rechnung) und der Klartext daneben in der Detail-Wellenform
  (`analysisSourceLabel`: „AUS DER ANALYSE-DATEI", „NACH DEM SCHNITT NEU
  GEZEICHNET", „EIGENBERECHNUNG – KEINE REKORDBOX-DATEN" …). Ein Raster, das nur
  aus dem mittleren Tempo der `master.db` fortgeschrieben wurde, heißt
  `GENERATED_FALLBACK` und nicht `REKORDBOX_DB`.
* **Nur anbieten, was die Daten hergeben.** `waveformModesFor` meldet `RGB` und
  `3BAND` nur, wenn tatsächlich verschiedene Bänder (bzw. getrennte Kanäle)
  importiert wurden; eine Kurve aus einer Lage (PWAV/PWV2) bleibt `BLUE`.
* **Bearbeiten ≠ neu analysieren.** Eingriffe tragen die Importkurve im
  Bucket-Raster mit (`src/waveform/editAnalysis.ts`), siehe Schritt 4.
* Nachweis: `npm run proof:source-of-truth`
  (`tests/rekordbox-source-of-truth.test.ts`, Messwerte in
  `tests/artifacts/rekordbox-source-of-truth/NACHWEIS.md`) – die Suite ist in
  `npm test` eingebunden und enthält Negativkontrollen: Ein fortgeschriebenes
  Raster müsste an den Fixture-Werten mit Tempo-Wechsel scheitern.

## Beatgrid aus der XML: `Battito` und `Metro` sind die Ansage

Ein Rekordbox-Export verankert das Raster mit einem oder mehreren `<TEMPO>`-Einträgen
(`Inizio`, `Bpm`, `Metro`, `Battito`). Real exportierte Bibliotheken nutzen das breit:
In einer geprüften Collection mit über 11 000 Zeilen hat rund ein Viertel der Tracks
einen Anker, der **nicht** auf Schlag 1 fällt (`Battito="3"`, `"4"`), und viele nennen
mehrere Anker im Stück. Deshalb gilt im Import (`src/rekordbox/xmlParser.ts`):

* Jeder Eintrag verankert einen Schlag an seiner `Inizio`-Zeit; ab dort gilt sein Tempo
  bis zum nächsten Eintrag. Nur die Schläge *dazwischen* werden fortgeschrieben
  (`beatsAreDerived`).
* `Battito` ist der Schlag-im-Takt des Ankers. Ist er 4, beginnt der nächste Takt einen
  Schlag später – und der Anlauf-Takt zählt als Takt 0, genau wie Rekordbox benennt.
  Die Zählung läuft über Anker hinweg fort; die Abstände in echten Dateien sind
  ganzzahlig (auf Millisekunden gerundet), deshalb stimmen die `Battito`-Werte der
  Folgeanker von selbst.
* `Metro="3/4"` ergibt 3 Schläge pro Takt – 4/4 wird nicht angenommen.
* Marker-Takt und Marker-Schlag (`barNumber`/`beatNumber` an Cues) werden **aus diesem
  Raster** abgelesen (auch in `databaseExtractor.ts`), nicht gegen `AverageBpm` und ein
  hartes 4/4 gerechnet. In echten Dateien sitzt der Hot Cue „1.1Bars" dann exakt auf
  Takt 1 Schlag 1 – dieser Abgleich ist Teil des Nachweises.
* Eine Zeile ohne `<TEMPO>` (es gibt sie: nur `AverageBpm`) bekommt ein Raster ab 0 s
  und heißt `GENERATED_FALLBACK`.

Und die `Location`: `file://localhost//contents_…/unknownartist/…` (verschwundene oder
in die Cloud verschobene Sammlungen) enthält keinen Laufwerksanteil. So ein Pfad wird
**nicht** geraten – `electron/locationPath.cjs` meldet den Grund in Klartext, und die
Zeile bleibt als „Original nicht gefunden" sichtbar. Pfade mit Laufwerk und
Prozentkodierung (`…/Moved%20from%20Cloud/…`) werden korrekt dekodiert.

## Schritt 1 – XML-Import: die Bibliothek wird gefüllt, die Welle noch nicht

`handleImportXmlFile` → `loadXmlFile(file)` → `parseRekordboxXmlAsync(text, onProgress)`:

* Gelesen wird pro `<TRACK>`-Element: `Name`, `Artist`, `Album`, `Genre`, `Label`,
  `KeyType`, `Year`, `Bpm`, `Duration`, `Date Added`, `Rating` (0–255 → 0–5),
  `PlayCount`, `Comments`, `Remixer`, `ISRC` und `Location`.
* Alle rohen Attribute zusätzlich in `rawXmlAttributes` – nichts geht verloren.
* Kindelemente: `<TEMPO Inizio Bpm>` → `beatGrid.firstBeat`/`bpm`,
  `<POSITION_MARK Type Num Start End Name Color>` → Hot Cues und Memory Cues
  (Bar-/Beat-Nummer aus `(start − firstBeat) / (60 / bpm)` berechnet),
  `<LOOP Start End>` → Loops.
* Für die Sammlung wird das Beatgrid **kompakt** gehalten (`buildDenseBeatGrid: false`,
  also `beats: []`), damit eine 100 000-Track-Bibliothek nicht mehrere Gigabyte kostet.
  Das dichte Grid entsteht erst für den Track, der tatsächlich ins Deck geladen wird.
* Ergebnis: `buildCollectionTrackModel(...)` setzt `analysis: pt.analysis || null`.
  Nach dem reinen XML-Import ist die Wellenform also bewusst **leer**, und die
  Collection-Liste zeigt Metadaten, keine Kurve.

## Schritt 2 – „In das Deck laden“: Tonträger lesen und selbst analysieren

`handleSelectTrackFromXml(selectedDef)`:

1. Liegt schon ein `audioBuffer` bei (z. B. aus einer Projektdatei), wird er benutzt.
2. Sonst, und nur in der Desktop-App: `window.rekordboxDesktop.readOriginalAudio(selectedDef.originalMedia.location)`.
   Der IPC-Kanal `rekordbox:read-original-audio` in `electron/main.cjs` macht daraus
   streng lesenden Zugriff:
   * `toLocalPath(location)`: Windows-Laufwerksbriefe werden **vor** der URL-Erkennung
     geprüft (`C:\Musik\…` sähe sonst wie ein URL-Schema `c:` aus), `file:`-URLs werden
     über `fileURLToPath` umgesetzt, jedes andere Schema (http, https, …) wird abgelehnt.
   * Endungsliste: `.wav .mp3 .flac .aiff .aif .m4a .aac .ogg` – sonst Fehlermeldung.
   * `access(R_OK)` + `stat` → muss eine reguläre Datei sein, Größe ≤ 1 GiB.
   * Geöffnet wird nur zum Lesen (`readFile`), die Bytes gehen per strukturiertem
     Klon an den Renderer; `accessMode: 'READ_ONLY'` steht im Ergebnis.
3. `audioCtx.decodeAudioData(source.data)` → `AudioBuffer` (das **Original**, bleibt
   unverändert auf `track.audioBuffer`), `resolvedPath`/`size`/`modifiedAt` werden als
   `originalMedia` notiert, Status `AVAILABLE` (bei Fehlern `MISSING` – dann wird nicht
   erfunden, sondern der Metadaten-Track bleibt).
4. `setWorkingPcm(pcmFromAudioBuffer(...))` – der Arbeits-Sound liegt ab jetzt als
   `PcmAudio {sampleRate, channels: Float32Array[]}` vor, die single source of truth
   für alles Weitere.
5. `analysis = selectedDef.analysis || analyzeAudioBuffer(originalAudio, LOCAL_ANALYSIS)`
   → ANLZ-Daten (Schritt 3) gewinnen immer; nur wenn keine da sind, rechnet die App.
6. `buildBeatGridFromTempo(firstBeat, bpm, duration, meter, origin)` füllt jetzt das
   dichte Grid für dieses eine Deck.

### Was `analyzePcm` konkret rechnet (`src/waveform/analyzer.ts`)

* Eimer: `bucketsPerSecond = 180`, mindestens 100, `samplesPerBucket = floor(len / buckets)`.
* Pro Eimer werden die Samples mit Schrittweite 2 besucht (`i += 2`) – ein Übersprung-
  Sampling, das bei 24/44,1 kHz die Peaks verlässlich einfängt und die Hälfte der Zeit kostet.
* `peaksL/peaksR` = betragsgrößter Wert von links/rechts, `peaks` = Maximum aus beiden,
  jeweils auf 0…1 begrenzt.
* Drei Bänder aus einem Ein-Pol-Tiefpass (≈ 260 Hz, `α = dt/(rc+dt)`) und einem
  Ein-Pol-Hochpass (≈ 3500 Hz, `α = rc/(rc+dt)`), Mittelband als Differenz
  `max(0, |s| − 0.7·low − 0.7·high)`.
* Band-Energien = Mittelwert pro Eimer, verstärkt mit 2.8 (Bass), 3.2 (Mitte),
  4.2 (Höhen) und bei 1.0 abgeschnitten.
* Herkunftsstempel: `origin: DataOrigin.LOCAL_ANALYSIS` – im UI und im Protokoll als
  eigene Berechnung gekennzeichnet, nie als Rekordbox-Daten ausgegeben.

Die Zahlen sind eine **Näherung** an das, was Rekordbox speichert: keine
FFT-Bänke, keine vorlagenoptimierten Farbzuordnungen. Deshalb hat ANLZ Vorrang.

## Schritt 3 – ANLZ: die Rekordbox-Daten haben Vorrang

Zwei Wege, dieselbe Funktion: `handleImportAnlzData(bytes, name)`.

* Browser: Datei reinziehen oder über die Datei-Auswahl.
* Desktop: `rekordbox:choose-analysis-file` (Dialog, Endungen `DAT/EXT/2EX`) und
  `rekordbox:read-analysis-file` (ebenfalls nur lesend, ≤ 1 GiB, akzeptiert nur die
  drei Endungen und nur Pfade aus dem Dialog).
* `parseAnlzBinary(buffer)` (`src/rekordbox/anlzParser.ts`) liest den Container-
  Header und dann Tag für Tag:
  * Waveform-Tags `PWAV`, `PWV2`, `PWV3`, `PWV4`, `PWV5`, `PWV6`, `PWV7`. Der Tag mit
    der höchsten Priorität gewinnt (`PWV7` 7 > `PWV5` 6 > `PWV6` 5 > `PWV4` 4 >
    `PWV3` 3 > `PWV2` 2 > `PWAV` 1), die Kopfzeilen werden je Tagtyp unterschiedlich
    interpretiert:
    | Form | Bytes/Eimer | Lesart |
    | --- | --- | --- |
    | `MONO_5BIT` (PWAV/PWV3, 1 B) | 1 | `peak = (wert & 0x1f) / 31`, alle Bänder gleich |
    | `MONO_4BIT` | 1 | `peak = (wert & 0x0f) / 15` |
    | `RGB_5BIT` (PWV5, 2 B) | 2 | Big-Endian-Bitfeld: Bass `>>13 & 7`, Mitte `>>10 & 7`, Höhen `>>7 & 7`, Peak `>>2 & 0x1f` |
    | `TRIPLE_BYTE` (PWV6/PWV7, 3 B) | 3 | der Reihe nach Mitte, Höhen, Bass (je `/255`), Peak = Maximum |
    | `COLOR_6BYTE` (PWV4, 6 B) | 6 | die letzten drei Bytes als Bass/Mitte/Höhen; Pioneers Farbabstimmung ist unveröffentlicht, deshalb ausdrücklich als **Näherung** gekennzeichnet |
  * `createWaveform(...)` baut daraus `WaveformAnalysisData` mit
    `peaksL = peaksR = peak` (die Analyse-Dateien der Rekordbox sind pro Kanal nicht
    getrennt) und `origin: REKORDBOX_ANLZ`.
  * Weitere Tags: `PQTZ`/`PQT2` → Beatgrid (8-Byte-Einträge mit Beat, Tempo × 100,
    Zeit in ms), Marker/Loops, `PSSI` → Phrasen/Mood/Bank, `PthL` → der in Rekordbox
    hinterlegte Analysepfad (`analysisPath`), plus `warnings` für alles Unsaubere.
* `applyAnlzExtractionToTrack(track, extraction)` (`databaseExtractor.ts`) überschreibt
  **nur, was die Datei wirklich enthält** (`waveform ?? track.analysis`, BPM, first
  beat, Cues, Loops, Phrasen) und lässt Metadaten, `originalSha256` und
  `isOriginalUntouched` in Ruhe. Eine leere oder halbe ANLZ-Datei kann XML-Werte also
  nicht löschen und keinen Fallback vortäuschen.
* Fürs Protokoll und das Inspektions-Fenster entsteht `databaseRecord` mit
  `waveformBuckets`, `waveformModeSupported`, `anlzTagsFound`, `anlzWarnings`,
  `filePath` – unten links in der Wellenform steht die Zahl der Buckets.

Rekordbox legt diese Analyse-Dateien normalerweise in einer Ordnerstruktur neben dem
Tonträger ab (Ordner `<Dateiname>.<Endung>/ANLZ/…`). Die App **rät diesen Pfad nicht**,
sondern fragt im Dialog nach – so kann eine Verwechslung mit einem anderen Track gar
nicht erst passieren.

## Schritt 4 – Nach einem Schnitt wird die Kurve getragen

Der einzige Weg, Audio zu ändern, ist `commitEditable(trackId, target, …)` in
`src/App.tsx`:

1. `workingPcm` (PCM der Arbeitskopie) ist Maß aller Dinge.
2. Daraus entsteht `audioBuffer` für die Wiedergabe (`pcmToAudioBuffer`).
3. Die Wellenform wird **nicht** pauschal neu gerechnet. `applyEdit` übergibt den
   Eingriff als `AnalysisEdit` (`analysisEditFor(report)`), und
   `carryAnalysisThroughEdit` (`src/waveform/editAnalysis.ts`) überträgt die
   vorhandene Kurve im Bucket-Raster: Zeit pro Bucket bleibt
   `Spurdauer / Bucketanzahl`, also sind Schnitt, Einfügen, Überlagern und
   Verschub im Eimer-Raster dasselbe Wegnehmen, Einfügen, Ersetzen und Umhängen
   bei ganzzahligen Indizes. Unberührte Eimer bleiben Bit für Bit dieselben
   Importwerte; gerechnet wird nur das Fenster, das das Material selbst nicht mehr
   hergibt – mit `analyzePcmWindow` in genau der Auflösung der importierten Spur.
   Ein reiner Verschub rechnet gar nichts.
4. Was trotzdem gerechnet werden musste, steht als `analysis.recomputed` (Liste von
   Zeitbereichen) und erscheint neben den Buckets als „n NEU GEZEICHNET".
5. `workingSegments` ist nur noch Provenienz-Protokoll fürs Projekt, nicht die
   Zeichengrundlage.
6. Undo/Redo stellen den kompletten Schnappschuss wieder her – seit diese Phase
   gehört die Wellenform dazu (`EditHistoryEntry.analysis`): Zurücknehmen wirft
   die Importkurve nicht weg, sondern setzt sie exakt wieder ein.
7. Nur wenn gar nichts zu tragen ist (eigene WAV-Datei, Demospur, Kurve fehlt)
   rechnet `analyzePcm(next.audio, DataOrigin.PROJECT)` die Spur vollständig – das
   ist der ausgewiesene Ausnahmefall, kein Umbiegen der Daten.

Quantisierung, ehrlich benannt: Ein Schnitt, der nicht auf einer Bucketgrenze
liegt, verschibt den Rest um höchstens einen Eimer (bei einer 8019-Eimer-Kurve
eines Drei-Minuten-Stücks sind das ~0,4 ms). Das Beatgrid wird davon nicht
berührt: Es folgt den Zeiten, nicht den Eimern.

## Schritt 5 – Projektdatei

`src/projects/projectFormat.ts` schreibt die Arbeitskopie als `wav16+base64`-Block in
die JSON-Datei (16-Bit-PCM, Prüfsumme `FNV-1a-64`). Beim Öffnen wird der Block
dekodiert (`decodeAudioBlock`), als `AudioBuffer` aufbereitet und mit
`analyzePcm(pcm, DataOrigin.PROJECT)` neu analysiert. Die Wellenform eines geöffneten
Projekts ist also dieselbe Rechnung wie bei Schritt 2, nur auf der gespeicherten
Arbeitskopie – und quantisiert durch 16 Bit um höchstens ein halbes LSB.

**Bekannte Grenze (offen, nicht stillschweigend):** Die Projektdatei speichert die
importierten Eimer nicht, weil 8000 Eimer × 6 Bänder den JSON-Block aufblähen
würden. Nach dem Öffnen eines Projekts ist die Kurve deshalb eine Eigenzeichnung
(`PROJECT`, im Editor beschriftet), obwohl die Originalkurve in der ANLZ-Datei
weiter existiert. Zwei Wege, das zu schließen – beide am Datenpfad, keiner als
neue Analyse-Engine: (a) die ANLZ-Datei beim Laden erneut lesen, wenn sie neben
dem Tonträger liegt, oder (b) die importierten Eimer komprimiert (Int16-Paare pro
Bucket) in den Projektblock legen. Schritt (a) ist bevorzugt, weil er nichts
Dubliziert.

## Schritt 6 – Darstellung

* `DetailWaveform.tsx`: `secPerBucket = track.duration / analysis.length`,
  `startBucket = floor(viewOffset / secPerBucket)`, `endBucket =
  ceil((viewOffset + viewDuration) / secPerBucket)`; gezeichnet wird pro Eimer eine
  Spalte, Breite mindestens 1,2 px. Ohne `analysis` oder mit `length === 0` wird
  schlicht nichts gezeichnet.
* `TrackOverview.tsx`: ein Balken pro Eimer über die ganze Breite, gleiche Buckets.
* Farben in beiden Ansichten aus `src/waveform/colors.ts`. `AMBER` (Standard)
  rechnet `amberColorCss(peak, low, high)` über eine HSL-Rampe mit Kontrastkurve
  (`contrastCurve`): leise `hsl(22°, 0.92, 0.22)` → Grundfarbe `hsl(29°, 1, 0.48)`
  → laut `hsl(45°, 1, 0.63)`. Bewusst *keine* RGB-Mischung in Richtung Cremeweiß
  und kein Weißstreifen auf jeder Bar: Höhen heben nur den Rot-/Grünanteil und
  senken den Blauanteil („heiß“, nicht „hell“), der Kern greift erst ab
  `peak ≥ 0.62` (`amberCoreAlpha`, max. 0.42) und die heiße Spitze `AMBER_HOT`
  nur ab `peak ≥ 0.82`. Hintergrund ist `#0a0806`. Die Mini-Vorschau der Clips
  nutzt dieselbe Rechnung. `BLUE`, `RGB` und `3BAND` bleiben über das Menü
  erreichbar (dort ebenfalls ohne Dauer-Weißschleier).
* Die Farbrechnung ist reine Mathematik ohne Canvas und wird deshalb von
  `tests/waveform-colors.test.ts` geprüft (Sättigung, Weißanteil, Kontrast zum
  Hintergrund, Kernschwelle, Verdrahtung der Renderer). Das Beweisbild liegt unter
  `tests/artifacts/waveform-colors/vorschau.png`: graue Marke = alte Rechnung,
  amber Marke = neue, identisches Signal.
* Mini-Vorschau der Clips: `extractMiniPeaksPcm(pcm, 48)` (48 Eimer, Schrittweite 4,
  Maximalbetrag, auf 1 begrenzt).

## Was bewusst nicht passiert

* Original-Audio, XML, ANLZ und Datenbanken werden nie verändert und nie als
  Schreibziel angeboten; `electron/main.cjs` erlaubt Schreiben ausschließlich an Pfade,
  die zuvor in einem Dialog bestätigt wurden (`assertWritableTarget`).
* Für eine Spur ohne Tonträger und ohne ANLZ wird keine Wellenform erfunden.
* Aus der Datenbank (`master.db`, `exportLibrary.db`) werden Metadaten, Cues, Loops und
  Beatgrid-Rahmen gelesen – **keine** Waveform-Buckets; die Wellenform kommt aus ANLZ
  oder aus eigener Analyse des geladenen Audios.
