# Implementierungs-Audit: Rekordbox-/ANLZ-Pipeline als Primärpfad

Stand: 2026-09-09 · Branch `arena/01a08880-airdox-editor`

Dieses Dokument ist der repo-weite Code-Audit **nach** der Umsetzung der vier
kritischen Korrekturen aus dem Architektur-Audit. Es belegt für jede noch
verbliebene Fundstelle (Abschnitt 18 des Implementierungsauftrags): Datei,
Funktion, Aufrufkontext, Produktionspfad oder Test sowie die Bewertung
zulässig/unzulässig.

---

## 1. Umsetzungsstatus der vier Schritte

| Schritt | Ziel | Status | Nachweis |
|---|---|---|---|
| 1 | `AnalysisDataPath` tatsächlich verwenden, `share/PIONEER/USBANLZ/...` deterministisch auflösen | umgesetzt (war vorhanden, Vertrag dokumentiert) | `src/rekordbox/analysisResolver.ts`, `src/App.tsx` (`tryAutoLoadAnlz`, `ensureDbAnalysisIndex`, PPTH-Scan) · `tests/analysis-resolver.test.ts` (12/12) |
| 2 | PQTZ-Beatpositionen originalgetreu ins Datenmodell | umgesetzt (war vorhanden, Fallback-Dokumentation ergänzt) | `adoptAnlzBeatGrid` in `src/rekordbox/databaseExtractor.ts`, `tailExtended`-Flag, `buildBeatGridFromTempo`-Vertrag in `src/rekordbox/xmlParser.ts` · `tests/pqtz-strict.test.ts` (6/6), `tests/xml-exclusive-import.test.ts` (8/8) |
| 3 | Renderer auf `beatGrid.beats[]` + echte ANLZ-Varianten umstellen | umgesetzt (Renderer-Logik in testbare Helfer extrahiert) | `selectGridRenderBeats`, `selectTrackWaveform` in `src/waveform/renderModel.ts`, genutzt in `DetailWaveform.tsx` + `TrackOverview.tsx` · `tests/renderer-original-data.test.ts` (13/13) |
| 4 | Synthetische Waveform-Fallbacks + eigene Analyse aus dem Produktions-Visualisierungspfad entfernen | umgesetzt | Kick-/Hüllkurven-Synthese aus `DetailWaveform.tsx` + `TrackOverview.tsx` entfernt, `analyzeAudioBuffer` aus dem XML-Deck-Pfad entfernt, ehrlicher Leerzustand (`waveformMissingNotice`) |

Alle Schritte sind einzeln nach ihrer Umsetzung getestet worden; die komplette
`npm test`-Kette ist grün (siehe Abschnitt 5).

---

## 2. Ziel-Datenfluss → tatsächliche Implementierung

```text
REKORDBOX XML  ──────────────►  parseRekordboxXmlAsync / mapRekordboxDatabaseRows
    │                                 │
    ├── LOCATION ─────────────────────┼──► originalMedia.location
    │                                 │         │
    │                                 │         ▼  readOriginalAudio (read-only)
    │                                 │      ORIGINAL-AUDIO (Wiedergabe/Schnitt/Export/DSP)
    │                                 │
    └── rawXmlAttributes.analysisDataPath ──► resolveAnalysisFilePath(sourceDbDir, …)
                                                  │  (kein Raten, keine Suche)
                                                  ▼
                                        <share>/PIONEER/USBANLZ/<hash>/<uuid>/ANLZnnnn.DAT
                                                  │  + deterministische Schwesterdatei ANLZnnnn.EXT
                                                  ▼
                                              parseAnlzBinary  (PPTH/PQTZ/PCOB/PCO2/PWV2–7/PSSI)
                                                  │
                             applyAnlzExtractionToTrack (merge DAT→EXT, PQTZ verbatim)
                                                  ▼
                                          INTERNES MODELL (TrackModel)
                                                  │
                                                  ▼
                                     selectTrackWaveform / selectGridRenderBeats
                                                  ▼
                        DetailWaveform.tsx · TrackOverview.tsx (Canvas-Renderer)
```

Wichtige Garantien des Pfads:

- Es gibt **keine parallele eigene Audioanalyse** als Quelle für Waveform oder
  Beatgrid von Rekordbox-Tracks. `analyzeAudioBuffer` kommt im Deck-Lade-Pfad
  nicht mehr vor (Quelltext-Guard in `tests/renderer-original-data.test.ts`).
- Rekordbox-Pfade werden **deterministisch** aufgelöst: führende `/` werden
  entfernt, `share/`-Präfix wird normalisiert, der Anker ist
  `<dbDir>/share/PIONEER/USBANLZ/...`. Keine Suche, keine Namensrekonstruktion,
  keine Hash-Verzeichnis-Raterei (Tests: `analysis-resolver.test.ts`).
- PQTZ-Originalzeiten werden in `BeatGrid.beats[]` **verbatim** übernommen;
  nur nach dem letzten Original-Beat werden uniforme Fortsetzungen mit
  `tailExtended: true` angehängt, damit das Grid nie mitten im Track endet.
- Der Renderer zeichnet Beats an den **Originalzeitpositionen** aus `beats[]`
  (`collectVisibleBeats`, `selectGridRenderBeats`); die uniforme
  `firstBeat + n·60/BPM`-Rekonstruktion läuft ausschließlich für Grids **ohne**
  gespeicherte Knoten und meldet sich über `uniformFallback`.

---

## 3. Code-Audit: `analyzeAudioBuffer(`

| # | Datei | Funktion | Aufrufkontext | Pfad | Bewertung |
|---|---|---|---|---|---|
| A1 | `src/App.tsx` | `handleDelete` | Destruktives Löschen der **Arbeitskopie**; danach `analysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT)` | Produktion, Editier-/DSP-Pfad (nicht Import) | **zulässig** – analysiert den realen, veränderten Arbeits-Audiopuffer, Herkunft explizit `PROJECT`, nie als Rekordbox deklariert. Hinweis: Rekordbox `analysisVariants` bleiben vorgezogen (Zoom-Auflösungen); Verhalten unverändert gegenüber dem Stand vor dem Audit. |
| A2 | `src/App.tsx` | `handleClear` | Destruktives Stummschalten der Arbeitskopie; `analysis = analyzeAudioBuffer(newBuffer, DataOrigin.PROJECT)` | Produktion, Editier-/DSP-Pfad | **zulässig** – wie A1, Herkunft `PROJECT`. |
| A3 | `src/App.tsx` | `handleOpenProject` | Nicht-Rekordbox-Track beim Projektladen: einmalige `LOCAL_ANALYSIS` des Originals | Produktion, lokaler Track-Pfad | **zulässig** – nur `!isRekordboxOrigin(...)`; Rekordbox-Tracks erhalten `null` und durchlaufen `tryAutoLoadAnlz`. |
| A4 | `src/App.tsx` | `loadAudioFile` | Import einer lokalen Audiodatei (kein Rekordbox-Kontext) | Produktion, lokaler Track-Pfad | **zulässig** – die einzige eigene Analyse im lokalen Import, Herkunft `LOCAL_ANALYSIS`. |
| A5 | `src/rekordbox/databaseExtractor.ts` | `extractTrackFromRekordboxXml` | Hilfsfunktion, die nur Tests importieren (`audioBuffer?`-Zweig → `LOCAL_ANALYSIS`) | Test-only, Produktion ungenutzt | **zulässig** – kein Produktionsaufruf; Test-Fixtures erzeugen nie Rekordbox-Labels für eigene Analyse. |
| A6 | `src/waveform/analyzer.ts` | `analyzeAudioBuffer` (Definition) | Implementierung der lokalen Peak-/Band-Analyse | Produktion (Basis für A1–A4) | **zulässig** – die Funktion selbst ist nicht der Verstoß; Verstöße wären Aufrufe im Rekordbox-Visualisierungspfad (existieren nicht mehr). |
| A7 | `src/App.tsx` | `handleSelectTrackFromXml` | **entfernt** (ehemaliger Audit-Fund `analyzeAudioBuffer(...)` im Rekordbox-Deck-Pfad) | Produktion | behoben – Quelltext-Guard in `tests/renderer-original-data.test.ts` (Suite „no own analysis“) verhindert Wiederkehr. |

## Code-Audit: `buildBeatGridFromTempo(`

| # | Datei | Funktion | Aufrufkontext | Pfad | Bewertung |
|---|---|---|---|---|---|
| B1 | `src/rekordbox/xmlParser.ts` | Definition | Dokumentierter **einziger** Uniform-Grid-Fallback (TEMPO-Skalare ohne Knoten) | Produktion | **zulässig** – Vertrag jetzt im JSDoc fixiert; nie `REKORDBOX_ANLZ`. |
| B2 | `src/App.tsx` | `buildCollectionTrackModel` | Kompakte Collection-Einträge ohne Grid (XML/DB) | Produktion | **zulässig** – dokumentierter Fallback, Herkunft `REKORDBOX_XML`/`REKORDBOX_DB`. |
| B3 | `src/App.tsx` | `handleSelectTrackFromXml` | Expansion des kompakten Collection-Grids beim Deck-Laden, **bevor** ANLZ aufgelöst wird | Produktion | **zulässig** – dokumentierter Fallback; vorhandenes PQTZ ersetzt diesen Grid anschließend verbatim (`tryAutoLoadAnlz` → `applyAnlzExtractionToTrack`). |
| B4 | `src/App.tsx` | `loadAudioFile` | Lokale Audiodatei ohne Beatdaten (130 BPM-Startwert) | Produktion, lokaler Pfad | **zulässig** – Herkunft `LOCAL_ANALYSIS`, nie als Rekordbox deklariert. |
| B5 | `src/rekordbox/dbParser.ts` | `buildDeckTrackFromDatabase` | Nur von Tests genutzter Helfer; DB-Skalare | Test-only | **zulässig** – kein Produktionsaufruf; Herkunft `REKORDBOX_DB`. |
| B6 | `src/rekordbox/trackGuards.ts` | `adoptSerializedGrid` | Alte Projekte **vor** Beat-Persistenz (dokumentierter Legacy-Fall) | Produktion | **zulässig** – einzig für Dateien ohne persistierte Knoten. |
| B7 | `src/rekordbox/databaseExtractor.ts` | `extractTrackFromRekordboxXml` | Fallback `bg = rawTrack.beatGrid || …` | Test-only | **zulässig** – kein Produktionsaufruf. |
| B8 | `src/App.tsx` | `applyGridShift` (inline) | Uniforme Neuerzeugung nur, wenn keine Knoten existieren; sonst `shiftBeatNodes` | Produktion, USER_EDIT | **zulässig** – Ersatz-Grid nur ohne Knoten; Originaldaten bleiben via Undo nachvollziehbar. |

## Code-Audit: `generateAnalysisFromMetadata(` / `generateElectronicDjTrack(`

Repo-weit **keine Treffer** (Quellcode, Tests, Electron). Exit-Code des Greps: 1.

---

## 4. Repo-weite Schlüssel-Suche

- `USBANLZ` / `AnalysisDataPath` / `ANLZ0000`: nur Kommentare + Implementierung
  der deterministischen Auflösung (`analysisResolver.ts`, `tryAutoLoadAnlz`,
  DB-Index). Keine Reste von „eingelesen, aber ungenutzt“.
- `PQTZ`: Parser (`anlzParser.ts`), verbatim-Adoption (`databaseExtractor.ts`),
  Renderer-Kommentare + Datenbank-Inspektor. Der Einzelbeat wird nicht mehr
  verworfen.
- `PWV2`–`PWV7` (+`PWAV`): ein Parser (`anlzParser.ts`), Varianten werden im
  Modell als `analysisVariants` behalten und zoomabhängig vom Renderer gewählt
  (`selectTrackWaveform`). Kein zweiter Parser, keine erfundene Auflösung.
- **Keine synthetische Waveform** mehr in `DetailWaveform.tsx` / `TrackOverview.tsx`
  (Guard: Suite „no synthetic fallback“ in `tests/renderer-original-data.test.ts`).

### Verbleibende, bewusst erlaubte Stellen mit eigener Berechnung

- `src/audio/pitchTempoEngine.ts` (Hanning-Fenster, `Math.cos`): DSP, keine
  Visualisierung.
- `src/components/ClipDeckView.tsx`: zeichnet Clip-Vorschauen aus dem
  **eigenen Clip-Audiopuffer** (`activeClip.audioBuffer`, Herkunft `PROJECT`)
  – das ist der erlaubte Audio-Preview-Kontext (Palette/Clip-Deck), kein
  Rekordbox-Waveform-Ersatz. Die Beatlinien dort sind uniforme Clip-Raster aus
  `clip.bpm` (Clip-Vorschau, nicht Track-Beatgrid-Renderer).
- `src/App.tsx` `handleAddMemoryCue` u. ä.: Beat-Index-Berechnung für Labels
  (keine Visualisierung von Rekordbox-Daten als solche).

---

## 5. Testnachweise

Vollständige Kette (`npm test`):

| Test-Datei | Deckt ab (Auftragsabschnitt) | Ergebnis |
|---|---|---|
| `tests/analysis-resolver.test.ts` | Test 2 – AnalysisDataPath → `share/PIONEER/USBANLZ` → ANLZ; keine Suche/Rekonstruktion | 12/12 |
| `tests/pqtz-strict.test.ts` | Test 4 – PQTZ-Erhaltung, kein Uniform-Neuaufbau | 6/6 |
| `tests/xml-exclusive-import.test.ts` | PQTZ verbatim, kein synthetischer Fallback in der Merge-Schicht | 8/8 |
| `tests/anlz-real-format.test.ts` | Test 3 – ANLZ-Parsing (echtes Layout) | 12/12 |
| `tests/anlz-ext-merge.test.ts` | DAT↔EXT-Schwesterdatei + Merge-Prioritäten | 12/12 |
| `tests/waveform-variants.test.ts` | Tests 5/6 – Varianten + Zoom-Auswahl, kein Synth | 10/10 |
| `tests/renderer-original-data.test.ts` | Tests 5/6/7/8 – Renderer liest `beats[]`; keine Synthese; kein `analyzeAudioBuffer` im Deck-Pfad; ehrlicher Leerzustand | 13/13 |
| `tests/track-guards.test.ts` | Tests 7/8 + USER_EDIT-/RB-Abweichungsmeldung | 11/11 |
| `tests/import-simulation.test.ts`, `large-xml-import`, `rekordbox-db-import`, `project-file`, `pitch-tempo`, `db-reader-keys`, `path-guard`, `log-writer`, `anlz-ppth-scan` | Gesamtkette XML→DB→Modell→Renderer-Umfeld | grün |

Zusätzlich: `npx tsc --noEmit` → Exit 0.

---

## 6. Definition of Done – Einordnung

- `AnalysisDataPath` wird tatsächlich verwendet: ja (Auto-Load + deterministische
  Auflösung, keine Suche/Reconstruction).
- ANLZ wird automatisch dem geladenen Track zugeordnet: ja (DB-Index exakte
  Audio-Pfad-Matches + PPTH-Scan; manueller Dialog nur noch Fallback).
- `PIONEER/USBANLZ/...` korrekt aufgelöst: ja (`<dbDir>/share/...`-Anker).
- Echte Rekordbox-Waveformdaten: ja (PWV-Varianten, zoomabhängig).
- Echte PQTZ-Beatpositionen bleiben erhalten: ja (`beats[]` verbatim).
- Renderer verwendet `beats[]`: ja (`selectGridRenderBeats` + Canvas).
- Keine synthetische Waveform im Produktionsrenderer: ja (ehrlicher Leerzustand).
- Keine eigene Audioanalyse im normalen Rekordbox-Trackpfad: ja (entfernt +
  Quelltext-Guard).
- Kein stiller Analyse-Fallback: ja (MISSING-Zustand wird textlich ausgewiesen).
- Audio und Analyse getrennt: ja (Audio-Engine vs. ANLZ-Datenfluss).
- Datenherkunft nachvollziehbar: ja (`DataOrigin` in Modell/Renderer-Labels).
- Benutzeränderungen als `USER_EDIT`: ja, inkl. Hinweis „Beatgrid wurde
  gegenüber der importierten Rekordbox-Analyse verändert.“
- Tests beweisen die Kette XML → ANLZ → Modell → Renderer: ja (Abschnitt 5).
