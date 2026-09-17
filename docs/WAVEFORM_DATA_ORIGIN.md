# Technische Dokumentation: Wellenform-Datenherkunft (Waveform Data Provenance)

Diese Dokumentation beschreibt detailliert die zwei fundamentalen Bereiche von Audiodaten und Wellenform-Repräsentationen innerhalb des Rekordbox-Edit-Systems:

1. **Bereich 1: Ausschließlich aus Rekordbox analysierte Daten (`DataOrigin.REKORDBOX_ANLZ`)**
2. **Bereich 2: Konstruktiv, workflowbedingt oder frei berechnete Datenanteile (`DataOrigin.PROJECT`, `DataOrigin.LOCAL_ANALYSIS`, `DataOrigin.GENERATED_FALLBACK`)**

---

## 1. Bereich 1: Ausschließlich aus Rekordbox analysierte Daten

In diesem Bereich entstammt jedes einzelne Byte der Wellenform-, Beatgrid- und Cue-Informationen direkt und unverändert den offiziellen Pioneer DJ Rekordbox-Analysedateien oder -Datenbanken. Es findet **keine** algorithmische Synthese oder Verfälschung durch den Browser statt.

### 1.1 Binäre ANLZ-Analysedateien (`.DAT`, `.EXT`, `.2EX`)
Pioneer Rekordbox speichert bei der Track-Analyse vorberechnete Wellenform-Buckets in binären ANLZ-Containern ab (oft im Ordner `PIONEER/USBANLZ/...` auf USB-Sticks oder in `AppData/Roaming/Pioneer/rekordbox/share`). Das System decodiert diese Dateien über `src/rekordbox/anlzParser.ts`:

* **PWV3 / PWV2 (Klassische Detail-Wellenform)**:
  * 4-Bit oder 5-Bit logarithmische Amplitudendaten (0–31 bzw. 0–15).
  * Monochrom-Wellenformdarstellung für Standard-CDJs (CDJ-900, CDJ-2000).
* **PWV4 (RGB-Vorstufe 6-Byte Format)**:
  * 6 Bytes pro Zeitintervall. Die dominanten Frequenzbänder werden direkt aus den Pioneer-Bytes ausgelesen.
* **PWV5 (RGB-Wellenform mit 16-Bit Bit-Packung)**:
  * Layout: 2 Bytes (Big Endian `uint16`) pro Bucket.
  * Bit 13–15: Low Energy (Bass / Rot, 3 Bit, Werte 0–7).
  * Bit 10–12: Mid Energy (Mitten / Grün, 3 Bit, Werte 0–7).
  * Bit 7–9: High Energy (Höhen / Blau, 3 Bit, Werte 0–7).
  * Bit 2–6: Gesamtamplitude / Peak (5 Bit, Werte 0–31).
  * Repräsentiert die native Pioneer Rekordbox RGB-Wellenformanzeige.
* **PWV6 & PWV7 (Pioneer CDJ-3000 / Rekordbox 6 Dreifarb-3BAND)**:
  * Triple-Byte Format (3 Bytes à 8 Bit pro Zeitschritt).
  * Byte 0: `mid` Frequenz-Energie (0–255).
  * Byte 1: `high` Frequenz-Energie (0–255).
  * Byte 2: `low` Frequenz-Energie (0–255).
  * Peak errechnet sich aus dem Amplitudenmaximum der drei Bänder.
  * Dies ist die hochauflösende 3BAND-Ansicht, bei der Bass (Cyan/Blau), Mitten (Orange/Bernstein) und Höhen (Weiß) mit exakten Pioneer-Parametern gerendert werden.
* **PQTZ / PQT2 (Quantized Beatgrid)**:
  * Exakte Zeitstempel jedes einzelnen Taktschlags in Millisekunden (`timeMs / 1000`).
  * Taktunterteilung (`beatInBar`: 1 bis 16), Taktanfang (`isBarStart: beatInBar === 1`) und Tempoangaben in Hundertstel-BPM (`tempo / 100`).
* **PCOB & PCO2 (Cue Points, Hot Cues, Active Loops)**:
  * PCPT- und PCP2-Einträge mit Millisekunden-Offset (`timeMs`), Loop-Endpunkt (`loopMs`), RGB-Farbcodes und Hot-Cue-Buchstaben (A–H).
* **PSSI (Rekordbox Phrasen- und Songstruktur)**:
  * Enthält die Pioneer DJ KI-Analyse bezüglich Intro, Verse, Chorus, Breakdown, Drop und Outro.
  * In Rekordbox 6/7 durch `PSSI_MASK_BASE` XOR-verschleiert, wird in `src/rekordbox/anlzParser.ts` mathematisch bitgenau demaskiert.

### 1.2 Rekordbox SQLite-Datenbank (`master.db` & `exportLibrary.db`)
* Liest über `src/rekordbox/dbReader.ts` direkt die Pioneer-Datenbankstrukturen:
  * `djmdSong`, `djmdContent`: Bitrate, Samplingrate, Tonart (z.B. Camelot 8A / OpenKey 4d), BPM.
  * `djmdCue`: Memory-Cues und Hot-Cues mit exakten Microsekunden-Offsets.
* Ist ein ANLZ-Verzeichnis verknüpft, wird die Wellenform mit dem Status `DataOrigin.REKORDBOX_ANLZ` markiert.

### 1.3 Rekordbox XML-Kollektion (`rekordbox.xml`)
* Liest offizielle `<COLLECTION>`-Knoten mit `<TEMPO>` (Bpm, Metro, Inizio) und `<POSITION_MARK>` (Cues & Loops).
* Wenn die XML zusammen mit den zugehörigen ANLZ-Dateien geladen wird, bleibt die Wellenform 100% nativ Rekordbox.

---

## 2. Bereich 2: Konstruktiv, workflowbedingt oder frei berechnete Datenanteile

In diesem Bereich stammen Wellenformen oder Zeitstrukturen **nicht** ausschließlich aus Pioneer Rekordbox, sondern werden zur Laufzeit durch Audio-DSP, Bearbeitungsoperationen oder Fallback-Generatoren berechnet.

### 2.1 Workflowbedingte Neuberechnung nach Schnitt- & Editieroperationen (`DataOrigin.PROJECT`)
Sobald der Benutzer im Editor einen Schnitt- oder Manipulationsbefehl anwendet, wird die Kausalitätskette des Original-Tracks modifiziert:
* **Befehle**: `CUT`, `PASTE`, `INSERT`, `REPLACE`, `OVERDUB`, `DELETE`, `CLEAR (Mute)`.
* **Kausalitäts-DSP (`src/editing/editingEngine.ts`)**:
  * Bei `DELETE` oder `CUT`: Der Audio-Puffer wird verkürzt; alle Cues und Beatgrid-Marker hinter dem Schnittpunkt werden kausal um exakt die gelöschte Dauer $\Delta t$ nach links verschoben.
  * Bei `INSERT` oder `PASTE`: Der Audio-Puffer wird verlängert; Cues hinter dem Einfügepunkt verschieben sich um die Pufferlänge des eingefügten Bereichs nach rechts.
  * Bei `CLEAR`: Der selektierte Zeitbereich wird auf Amplitudenwert `0` gesetzt (Stummschaltung). Die Wellenform fällt in diesem Bereich exakt auf 0 ab.
  * Bei `OVERDUB`: Zwei Audio-Streams werden mit `tanh`-Softclipping gemischt.
* **Neuanalyse (`src/waveform/analyzer.ts -> analyzeAudioBuffer`)**:
  * Der modifizierte PCM-Audiospeicher (`AudioBuffer`) wird mit 200 Schritten pro Sekunde (Buckets) spektral zerlegt:
    * **Low-Pass Filter (20–250 Hz)**: Isolierung der Bassdrum- und Subbass-Energie (Rot/Cyan).
    * **Band-Pass Filter (250–4000 Hz)**: Mitten (Grün/Bernstein) für Gesang und Snaredrum.
    * **High-Pass Filter (4000–20000 Hz)**: Höhen (Blau/Weiß) für Hi-Hats und Becken.
  * Das Ergebnis erhält den Status `DataOrigin.PROJECT`. Die Herkunft wird für den Benutzer transparent im Datenursprung-Badge angezeigt.

### 2.2 Reiner Audio-Import ohne Rekordbox-Analyse (`DataOrigin.LOCAL_ANALYSIS`)
Wird eine externe Audiodatei (`.mp3`, `.wav`, `.aiff`, `.flac`) direkt in das Deck gezogen, ohne dass eine Pioneer ANLZ-Datei existiert:
* Die Wellenform wird zu **100% frei berechnet** über die Web Audio API und den integrierten Analyzer.
* Transienten-Detektion (`detectBeatgridAlignment`): Kickdrum-Onsets werden über einen 180 Hz Tiefpassfilter und Energy-Flux-Detektion gescannt, um den ersten Beat (`firstBeat`) auf die Millisekunde genau zu ermitteln.
* BPM-Schätzung (`estimateBpm`): Autokorrelation des Energiedifferenz-Signals im DJ-Bereich [85, 175 BPM].

### 2.3 Synthetische Tracks / XML-Metadaten-Fallback (`DataOrigin.GENERATED_FALLBACK`)
Wird eine Rekordbox-XML geladen, zu der die physische Audiodatei auf dem Dateisystem fehlt:
* Das System erzeugt über `src/audio/synthesizerTrack.ts` einen rhythmisch exakten, synthetischen 16-Bit PCM-Stereo-Audiopuffer mit 44,1 kHz.
* Bassdrums, synthetische Snare-Transienten und Hi-Hats werden exakt auf das XML-Beatgrid gerendert.
* Die daraus resultierende Wellenform ist vollständig synthetisch generiert und trägt den Ursprung `DataOrigin.GENERATED_FALLBACK`.

### 2.4 Tonhöhen- und Zeitanpassung von Clips (`pitchTempoEngine.ts`)
Werden Clips aus der Palette in Deck A eingefügt, während "Tonhöhe anpassen" (`matchPitch`) aktiv ist:
* Pitch-Shifting (z.B. Solfa / Sinc-Resampling oder Granular-Synthese) transponiert das Frequenzspektrum des Audioclips harmonisch auf die Tonart des Zieltracks.
* Die Frequenzbänder und Peaks des veränderten Audiomaterials werden für den neuen Bereich vollkommen neu errechnet.

---

## 3. Gegenüberstellung der beiden Datenbereiche

| Merkmal | Bereich 1: Rekordbox Exklusiv (`REKORDBOX_ANLZ`) | Bereich 2: Konstruktiv / Workflow / Frei berechnet |
| :--- | :--- | :--- |
| **Datenquelle** | Pioneer ANLZ-Dateien (`.DAT`, `.EXT`, `.2EX`) & Pioneer SQLite (`master.db`) | Lokaler PCM-AudioBuffer nach Edits, Audio-Import ohne ANLZ, Synthesizer |
| **Peak-Berechnung** | Native Pioneer-Quantisierung (4-Bit, 5-Bit, 8-Bit) | Echtzeit-Scan der Audio-Samples (`Math.max(|L|, |R|)`) in 200 Hz Fenstern |
| **Frequenzband-Trennung** | Vordefinierte Rekordbox-Werte (PWV5: 3-Bit RGB, PWV7: 8-Bit Low/Mid/High) | Rekursiver IIR-/Euler-Filter (Low: <250Hz, Mid: 250–4000Hz, High: >4000Hz) |
| **Beatgrid** | PQTZ-Header mit fixen Pioneer-Taktschlag-Tabellen | Lokale Transienten-Detektion (180Hz Tiefpass) oder Beat-Interpolation |
| **Cues & Loops** | PCPT/PCP2 Pioneer Hardware-Strukturen mit Originalfarben | Projekt-verwaltete Cues mit dynamischem Zeitversatz bei Schnittoperationen |
| **Manipulations-Zustand** | Read-Only (Originalzustand des Tracks geschützt) | Modifizierbar (Undo/Redo-Stack, Schnitt, Overdub, Clip-Deck) |
| **Herkunfts-Kennzeichnung** | `DataOrigin.REKORDBOX_ANLZ` (Grünes Badge im UI) | `DataOrigin.PROJECT`, `LOCAL_ANALYSIS`, `GENERATED_FALLBACK` |

---

## 4. Schutz des Originalzustands (Original Media Integrity)

Das Gesamtsystem garantiert, dass:
1. **Originaldateien niemals destruktiv überschrieben werden**: Quell-ANLZ-Dateien und Original-Audiodateien werden ausschließlich lesend (`read-only`) geöffnet.
2. **Kausale Trennung gewahrt bleibt**: Solange kein Editierbefehl erfolgt ist, sieht und hört der Benutzer exakt die Pioneer-Daten. Nach einem Schnittbefehl wechselt die Kennzeichnung sofort und transparent auf `PROJECT`, und die Wellenform spiegelt das physikalisch veränderte Audiosignal bitgenau wider.
