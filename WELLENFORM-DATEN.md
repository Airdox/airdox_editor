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

## Schritt 4 – Nach jedem Schnitt wird neu gerechnet

Der einzige Weg, Audio zu ändern, ist `commitEditable(trackId, target, …)` in
`src/App.tsx`:

1. `workingPcm` (PCM der Arbeitskopie) ist Maß aller Dinge.
2. Daraus entstehen `audioBuffer` für die Wiedergabe (`pcmToAudioBuffer`) und
   `analysis = analyzePcm(next.audio, …)`.
3. `workingSegments` ist nur noch Provenienz-Protokoll fürs Projekt, nicht die
   Zeichengrundlage.

Das heißt: Nach Einfügen, Löschen, Darüberlegen, Ersetzen oder einem Undo steht die
Wellenform wieder mit den Samples in Einklang – es werden keine Buckets verschoben
oder alt weitergereicht. Undo/Redo stellen den kompletten Schnappschuss
(Samples, Marker, Loops, Grid) wieder her, und die Analyse läuft erneut.

## Schritt 5 – Projektdatei

`src/projects/projectFormat.ts` schreibt die Arbeitskopie als `wav16+base64`-Block in
die JSON-Datei (16-Bit-PCM, Prüfsumme `FNV-1a-64`). Beim Öffnen wird der Block
dekodiert (`decodeAudioBlock`), als `AudioBuffer` aufbereitet und mit
`analyzePcm(pcm, DataOrigin.PROJECT)` neu analysiert. Die Wellenform eines geöffneten
Projekts ist also dieselbe Rechnung wie bei Schritt 2, nur auf der gespeicherten
Arbeitskopie – und quantisiert durch 16 Bit um höchstens ein halbes LSB.

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
