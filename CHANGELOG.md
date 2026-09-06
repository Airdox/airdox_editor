# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Zum Versionsschema siehe [VERSIONING.md](./VERSIONING.md).

## [0.4] – 2026-09-06

### Behoben
- **Wellenform driftete weiterhin vom Audio weg — die eigentliche Ursache.**
  In `analyzeAudioBuffer` wurde `samplesPerBucket` per `Math.floor` abgerundet,
  *bevor* daraus die Zeitbasis `secPerBucket` abgeleitet wurde. Da die Anzeige
  Bucket *b* an Position `b × secPerBucket` zeichnet, fehlt pro Bucket ein
  Sekundenbruchteil, der sich über zehntausende Buckets aufsummiert: am Anfang
  exakt null, am Ende maximal.
  - Bei 44,1 kHz beträgt die exakte Schrittweite 220,5 Samples. Das Abrunden
    auf 220 kostet **0,82 s bei 6 Minuten** und **1,36 s bei 10 Minuten**.
  - Bei 48 kHz ist die Schrittweite mit 240 Samples ganzzahlig, der Fehler also
    exakt null — deshalb blieb der Bug bei 48-kHz-Material unsichtbar und trat
    nur bei den üblichen 44,1-kHz-Dateien auf.
  - Zeitbasis und Bucket-Grenzen nutzen jetzt die exakte gebrochene
    Schrittweite; der Versatz liegt für alle Sampleraten unter 1 ms.
- Derselbe Rundungsfehler in `extractMiniPeaks` (Vorschau der Palette-Clips)
  ließ das Ende jedes Clips ungescannt; ebenfalls auf exakte Schrittweite
  umgestellt.
- Neue Regressionstests `tests/waveform-timebase.test.ts` prüfen die Zeitbasis
  bei 22,05/32/44,1/48/96 kHz und lokalisieren Marker spät im Track.

## [0.3] – 2026-09-06

### Behoben
- **Beatgrid und Wellenform liefen im Track-Verlauf auseinander.** Am Anfang
  saßen Raster, Cues und Wellenform sauber übereinander, mit zunehmender
  Spieldauer wurde der Versatz immer größer. Zwei unabhängige Ursachen:
  - Der XML-Import wertete von mehreren `<TEMPO>`-Markern nur einen aus und
    rechnete den ganzen Track mit dieser einen BPM linear hoch. Bei variablem
    Tempo summiert sich der Fehler auf mehrere Sekunden (im Regressionstest
    3,0 s am Trackende). Jetzt werden alle Tempo-Regionen ausgewertet.
  - Gemessene Beatgrids (ANLZ-`PQTZ`, mit Zeitstempel pro Beat) wurden nach dem
    Einlesen verworfen und aus einer Durchschnitts-BPM neu erzeugt — beim
    Deck-Laden, beim ANLZ-Merge und beim Projekt-Neuladen. Sie bleiben jetzt
    erhalten und werden bei Bedarf am Ende fortgeschrieben statt ersetzt.
- **Rekordbox-Scroll-Wellenformen wurden zeitlich gestreckt.** PWV3/PWV4/PWV5/
  PWV7 sind fest mit 150 Einträgen pro Sekunde abgetastet; die Anzeige verteilte
  sie stattdessen über die Trackdauer. Das skalierte die gesamte Darstellung um
  einen konstanten Faktor — bei 0:00 unsichtbar, später deutlich sichtbar. Die
  feste Zeitbasis wird nun aus der Analysedatei übernommen.
- Projektdateien speichern die gemessenen Beat-Zeiten (`beatTimesMs`), damit ein
  wiedergeladenes Projekt nicht erneut auf konstantes Tempo zurückfällt.

### Geändert
- Neues Modul `src/rekordbox/beatGridUtils.ts`: Zeit↔Beat-Umrechnung,
  Beat-Snapping, Takt/Zählzeit und Rasterlinien arbeiten interpolierend auf den
  gemessenen Beats statt mit `firstBeat + index × 60/BPM`.
- Wellenform-Anzeige, Auswahl (BEAT SELECT, ½, ×2) und Memory-Cue-Beschriftung
  nutzen durchgängig das reale Raster.
- Neue Regressionstests `tests/beatgrid-drift.test.ts` (in `npm test`).

## [0.2] – 2026-09-06

### Hinzugefügt
- Versionsanzeige in der Titelleiste sowie neuer Dialog **Hilfe → Über Airdox Smart Editor**
  (`src/components/Modals/AboutModal.tsx`) mit Version und Build-Zeitpunkt.
- Zentrale Versionskonstanten in `src/version.ts`; Vite injiziert `__APP_VERSION__`
  und `__APP_BUILD_TIME__` zur Buildzeit.
- Effekt-Spuren-Modell: neue reine DSP-Engine `src/audio/effectEngine.ts`
  (GAIN, LOWPASS, ECHO) mit Typen `EffectTrack` / `EffectSegment` und Tests
  (`tests/effect-engine.test.ts`, in `npm test` eingebunden).
- `audioEngine.renderWorkingAudio` akzeptiert optional `effectTracks`.
- Projektdokumentation: `CHANGELOG.md`, `VERSIONING.md`, `TASKS.md`.
- Anwendungs-Icons unter `build/`.

### Geändert
- **Rebranding zu „Airdox Smart Editor"**: Paketname `airdox_smart_editor`,
  Electron `appId` `info.airdox.smarteditor`, überarbeitete `README.md`.
- Der Multi-Layer-Render-Inspector zeigt jetzt das reale Schichtenmodell aus
  `workingSegments` statt erfundener Beispieldaten.

## [0.1]

- Erste interne Fassung: Rekordbox-Import (XML, ANLZ, DB), nicht-destruktiver
  Wellenform-Editor, Pitch-/Tempo-Engine, WAV-Export.
