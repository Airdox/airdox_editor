# Wiederherstellung: Rekordbox-Waveform ohne Stem-Rollback

## Referenzanalyse und Ursache

Die Referenz `0e245d7c89ea8e0e51626964c3776bc1bc3f046a` (Version 4.2.0)
wurde mit dem aktuellen `HEAD` verglichen. Die relevante Änderung in
`src/App.tsx` war:

```ts
// 4.2.0
const analysis = selectedDef.analysis || analyzeAudioBuffer(originalAudio, DataOrigin.LOCAL_ANALYSIS);

// aktueller Stand vor diesem Fix
const analysis = selectedDef.analysis || null;
```

Der Wegfall der zweiten Quelle erklärt die leere Darstellung bei einer
Collection-Auswahl. Gleichzeitig gab es keinen automatischen Weg von einem
bei DB-Import vorhandenen `djmdContent.AnalysisDataPath` zurück zum
Deck-Track. Die bereits vorhandenen Parser konnten deshalb nur nach einem
**manuellen** ANLZ-Import arbeiten.

Der Fix rollt weder `App.tsx` noch die Stem-Architektur zurück. Statt der alten
Audioanalyse wird der bessere, echte Rekordbox-Weg automatisch verfolgt. Bei
einer Rekordbox-Quelle wird keine BPM-/Duration- oder Audio-Ersatzwaveform
erzeugt; ein DAT ohne gültigen Waveform-Tag bleibt sichtbar als ehrlicher
Leerzustand mit Diagnose.

## Implementierte Datenkette

```text
D:\ (verbindlicher Root für diese Reparatur)
  -> ausgewählte master.db (readonly)
  -> tatsächliches Schema: sqlite_master + PRAGMA table_info + Indizes
  -> djmdProperty: DBVersion/DBID, sofern tatsächlich vorhanden
  -> djmdContent.ID (erneut per parameterisiertem SELECT gelesen)
  -> djmdContent.AnalysisDataPath
  -> normalisierter, auf D:\ begrenzter `master.db/share/PIONEER/USBANLZ/...` Pfad
  -> exakt abgeleitete ANLZnnnn.DAT, .EXT und .2EX Geschwister
  -> immutable IPC-Byte-Snapshots
  -> FourCC/len_header/len_tag Parser (Big Endian)
  -> normalisiertes `WaveformAnalysisData`
  -> vorhandenes `selectTrackWaveform`/`DetailWaveform` Rendering
```

`AnalysisDataPath` wird nicht aus Titel, BPM, Dateinamen oder einem vermuteten
ANLZ-Hash rekonstruiert. Relative Werte sind nur als
`[share/]PIONEER/USBANLZ/...` gültig; absolute Werte, `..`, fremde Laufwerke
und Ziele außerhalb von `D:\` werden mit einer expliziten Fehlerstufe
abgewiesen. Die Dateien werden nur mit `stat`/`readFile` gelesen. Die DB wird
mit `readonly: true` geöffnet; Schema- und Trackabfragen sind ausschließlich
`SELECT`/`PRAGMA`.

## Parser- und Auswahlregeln

* Jeder Block validiert `offset + 12`, `len_header >= 12`,
  `len_tag >= len_header`, `offset + len_tag <= fileLength` sowie
  array-spezifische Grenzen. Bei einem ungültigen sequentiellen Block wird
  abgebrochen, nicht in Nutzdaten nach scheinbaren FourCCs gesucht.
* Unbekannte, aber gültige Blocks bleiben mit FourCC, Offset, Längen und einem
  begrenzten Rohdaten-Snapshot in `unknownTags`; sie verwerfen nachfolgende
  Blocks nicht.
* Unterstützt werden `PPTH`, `PVBR`, `PQTZ`/`PQT2`, `PCOB`/`PCPT`,
  `PCO2`/`PCP2`, `PSSI`, `PWAV`, `PWV2` bis `PWV7` und `P@V6`.
* `PQTZ` bleibt ein eigenständiges Big-Endian-Format: `u16 beat`,
  `u16 BPM × 100`, `u32 Millisekunden`. Datenbank-BPM wird davon nicht
  abgeleitet.
* DAT → EXT → 2EX werden zusammengeführt. Die detaillierteste native Variante
  gewinnt; bei gleicher Auflösung wählt der Renderer die reichere Quelle
  (z. B. `PWV7` vor `PWV3`).
* Die aktuelle, per Frequenz-Sweep bestätigte 3-Band-Reihenfolge in
  `PWV6`/`P@V6`/`PWV7` lautet **low, mid, high**. `PWV4` wird als
  red/green/blue = low/mid/high mit seinem dokumentierten
  Helligkeitskanal dekodiert.
* PPTH wird lediglich gegen `FolderPath`/`FileNameL` plausibilisiert
  (`EXACT`, `PLACEHOLDER_BASENAME`, `MISMATCH`). Ein Mismatch diagnostiziert,
  verwirft aber keinen anhand der DB eindeutig zugeordneten ANLZ-Pfad.

## Laufzeitdiagnose und Race-Schutz

Bei jeder DB-Trackauswahl schreibt das Systemlog die Werte für Root,
master.db, ContentID, AnalysisDataPath, aufgelöstes Verzeichnis sowie Status
und Pfad aller drei Geschwister. Nach dem Parser folgen Tags, PPTH-Status,
gewählter Waveform-Tag und Column-Anzahl. Fehler verwenden eine der klaren
Stufen `MASTER_DB`, `SCHEMA`, `TRACK`, `ANALYSIS_DATA_PATH` oder `ANLZ_FILES`;
sie werden nie als erfolgreicher Analyseimport gemeldet.

Eine monoton steigende Selection-Request-ID stellt sicher, dass eine verspätete
Antwort für Track A niemals den inzwischen gewählten Track B überschreibt.

## Reproduzierbarer Golden-Test

`tests/rekordbox-track-analysis-pipeline.test.ts` enthält die vollständige,
kleine D:-Fixture-Kette mit einem `djmdContent`-Record (`ID=4242`),
`AnalysisDataPath`, DAT/EXT/2EX-Status, real-layout ANLZ-DAT/EXT Bytes und dem
bestehenden Renderer. Er beweist:

```text
4242 -> AnalysisDataPath -> DAT + EXT (+ explizit fehlendes 2EX)
     -> PQTZ/PWV5/PWV3/PWV7 -> PWV7 -> DetailWaveform render model
```

Die Testdaten sind bewusst in-memory und anonymisiert: Im Checkout liegt keine
Benutzer-`master.db`, keine Original-ANLZ und keine Original-Audiodatei. Ein
realer D:-Datenträger kann in dieser Linux-Sandbox daher nicht geöffnet oder
gehasht werden. Das Produkt liest ihn jedoch ausschließlich über den oben
beschriebenen Read-only-IPC-Weg.

## Stem-Technologie

Die Änderungen berühren keine Dateien unter `src/stems/`, keine Stem-IPC und
keine Modell-/Gate-Konfiguration. Insbesondere bleiben
`bsroformer-musdb18hq-4stem-zfturbo`, `bs_roformer`,
`ep17-sdr9.6568`, 44.1 kHz und die HIGH_QUALITY-Gate-Umgebung unverändert.
