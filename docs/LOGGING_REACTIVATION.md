# Reaktiviertes Desktop-Diagnoselogging

## Zweck und Architektur

Das vorhandene Logging-System wurde nicht ersetzt. `LoggerService` bleibt die zentrale Quelle für `LogEntry`-Objekte, den Ringbuffer (maximal 1.000 Einträge), Console-Ausgabe, Live-Subscriber und den JSON-Diagnoseexport von `SystemLogModal`.

Seit dieser Reparatur wird **jede** erzeugte `LogEntry` zusätzlich best effort an die bereits vorhandene Electron-Dateipersistenz übergeben:

```text
LoggerService
  → Ringbuffer
  → Browser-/DevTools-Console
  → Live-Subscriber → SystemLogModal
  → rekordboxDesktop.appendLog (nur Electron)
  → rekordbox:append-log (Main IPC)
  → electron/logWriter.cjs
  → <Electron userData>/airdox-smart-editor.log
```

Im Browser/Vite-Modus fehlt die Electron-Bridge erwartungsgemäß. Dann bleiben Ringbuffer, Console, globale Fehlerbehandlung und das SystemLogModal aktiv; die Dateispiegelung ist ein geräuschloser No-op.

## IPC-Vertrag

| Komponente | Vorher | Jetzt |
|---|---|---|
| Preload `appendLog` | `log:append` | `rekordbox:append-log` |
| Preload `getLogFilePath` | `log:get-path` | `rekordbox:get-log-file-path` |
| Main process | beide, parallel registrierte Namensfamilien | ausschließlich die zwei `rekordbox:*`-Kanäle |

Die Preload-API bleibt absichtlich eng: `contextBridge` exponiert nur einzelne Funktionen, kein `ipcRenderer`, kein generisches `invoke`/`send` und kein Node.js im Renderer.

## Persistenz, Rotation und Fehlerverhalten

`electron/logWriter.cjs` bleibt der einzige Datei-Writer. Er schreibt eine einzelne strukturierte Zeile pro Eintrag, begrenzt Nachricht/Daten, faltet Zeilenumbrüche und rotiert bei 5 MiB:

```text
airdox-smart-editor.log       aktuelle Datei
airdox-smart-editor.prev.log  vorherige, rotierte Datei
```

Der Speicherort wird ausschließlich mit `app.getPath('userData')` bestimmt und ist daher installations- und benutzerkonform; auf Windows liegt er im Electron-`userData`-Bereich der App. Weder `master.db`, ANLZ-Dateien noch Originalaudio sind jemals Logging-Ziele.

Alle Fehler am Diagnosepfad werden abgefangen:

- keine Desktop-Bridge,
- fehlende oder synchron fehlschlagende `appendLog`-Funktion,
- abgelehnte IPC-Promise,
- nicht beschreibbares Logziel,
- fehlgeschlagene Rotation oder Writer-Erzeugung.

Keiner dieser Fälle erzeugt einen zweiten Logger-Aufruf. Dadurch ist keine rekursive `logger.error → persist → logger.error`-Schleife möglich und die beobachtete Track-, Waveform-, Edit- oder Stem-Operation läuft weiter.

## Datenschutz

Der Renderer-Logger begrenzt und normalisiert Details vor allen Sinks. Er behandelt DOM-Knoten, Binärdaten, Funktionen, `bigint`, Zyklen und zu tiefe/große Objektstrukturen robust. Sensible Detail-Schlüssel wie `password`, `token`, `apiKey`, `authorization`, `sqlcipherKey`, `credential` und `secret` werden redigiert. Auch verbreitete Freitextformen (`password=…`, `Authorization=…`, Bearer-Token und URLs mit Zugangsdaten) werden vor der Ausgabe redigiert. `logWriter.cjs` redigiert diese Formen ein zweites Mal am persistenten Main-Process-Rand, falls eine fehlerhafte Integration die zentrale Renderer-Sanitization umgeht.

Technische Rekordbox-Metadaten bleiben für die Diagnose sichtbar: Pfade, Content-ID, Titel/Artist, BPM, `AnalysisDataPath`, Datei-Status, FourCC-Tags, gewählte Waveform-Variante und Request-ID. SQLCipher-Schlüssel werden nicht geloggt.

## Rekordbox-/Waveform-Ereignisse

Die Auswahl eines `MASTER_DB`-Tracks erzeugt strukturierte Ereignisse für:

1. `Track request started` mit Request-ID/Content-ID,
2. Master-DB-Gate-Ergebnis (`MASTER_DB_NOT_FOUND`, `SQLCIPHER_UNAVAILABLE`, `MASTER_DB_OPEN_FAILED`, `MASTER_DB_SCHEMA_INVALID`, `TRACK_NOT_FOUND_IN_MASTER_DB` usw.),
3. Schema, Track und `AnalysisDataPath`, sobald diese Stufen tatsächlich erreicht wurden,
4. jeden DAT/EXT/2EX-Status ohne Binärpayload,
5. gefundenen FourCC-Tags, übersprungene Dateien und Decoderwarnungen,
6. gewählte Waveform-Quelle (`REKORDBOX_ANLZ`, `AUDIO_ANALYSIS`, `GENERATED_FALLBACK`) samt `sourceTag`, Buckets und Dauer,
7. finalen `TrackModel`-Analyse-Zustand sowie `Track request applied`.

Ein überholter Request wird als `Track request superseded; ANLZ result discarded` mit alter und aktueller Request-ID geloggt. Der vorhandene monotone Guard verhindert weiterhin, dass ein später eintreffendes Ergebnis für Track A die Auswahl Track B oder C überschreibt.

`generateAnalysisFromMetadata()` bleibt ein ausdrücklich gekennzeichneter letzter Ausweg und emittiert immer `Generated waveform fallback activated` mit `origin: GENERATED_FALLBACK`. Die Master-DB/ANLZ-Kette generiert bei fehlendem oder beschädigtem Waveform-Block keine Ersatz-Waveform.

## Tests

Zusätzlich zu den vorhandenen Parser-, D:-Pfad-, Master-DB-Schema-, Waveform- und Stem-Tests decken folgende Tests die Reaktivierung ab:

- `tests/logger.test.ts`: Levels, Ringbuffer, Live-Subscriber, Clear, DOM/Zyklus/Binär-Sanitizing, Stacktraces, globale Fehler, fehlende/fehlerhafte Bridge und Credential-Redaktion.
- `tests/preload-log-bridge.test.mjs`: ausgeführtes Preload mit Electron-Mock; exakte Kanäle und keine generische IPC-Exposition.
- `tests/logging-ipc.test.mjs`: Main-Handler, fehlende Legacy-Kanäle, Writer-Übergabe und Fehler-No-op.
- `tests/desktop-log-persistence.test.ts`: vollständige Seam `Logger → Bridge → Main-Handler → logWriter → Datei`.
- `tests/log-writer.test.mjs`: Append, Rotation in `.prev.log`, Größenbegrenzung, zirkuläre Daten und nicht beschreibbare Ziele.
- `tests/system-log-modal-model.test.ts`: Level-/Kategorie-/Suche-Filter inklusive ERROR+FATAL und FourCC-Suche in Details.
- `tests/masterdb-gate-codes.test.mjs`: maschinenlesbare Gate-Codes für Root-/fehlende-DB-/fehlende-ID-Fälle.
