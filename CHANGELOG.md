# Changelog

## v0.4.5 — ANLZ-Pipeline (2026-09-09)

Die Rekordbox-ANLZ-Analyse (`.DAT` / `.EXT` / `.2EX`) ist jetzt der primäre
Produktionspfad für Waveform + Beatgrid. Keine erratene Fallback-Waveform,
keine rekursiven Suchläufe, keine Rekursion.

### Phase 1 — Deterministischer Pfad-Resolver
- `AnalysisDataPath` aus `master.db.content` wird direkt gegen den
  `<share>/PIONEER/USBANLZ/.../ANLZ0000.DAT`-Pfad aufgelöst.
- Desktop-Bridge (`resolveAndReadAnlz`) öffnet die Datei **ausschließlich
  lesend** (`readAnalysisFile` mit `'r'`); kein Schreiben, kein Raten.
- Kein Walk/Glob/Dateiname-Matching mehr; fehlender Pfad → Status
  `MISSING_REKORDBOX_ANALYSIS`.

### Phase 2 — PQTZ-Beats 1:1 erhalten
- Jeder PQTZ-Eintrag (Beat-Taktnummer, Taktwechsel, Zeit in ms) wird als
  `BeatNode` in `beatGrid.beats[]` übernommen.
- `buildBeatGridFromTempo` wird **nur** als dokumentierter Fallback für
  reine XML/TEMPO-Imports, Demo-Tracks und User-File-Import benutzt.
- Bar/Beat-Lookup (`locateBarBeatAt`), Quantize-Snap und Selection-
  Zählung durchsuchen die dichte Beats-Liste (Tempowechsel werden exakt
  wiedergegeben).

### Phase 3 — Renderer nutzt echte ANLZ-Daten
- `DetailWaveform`: Header-Taktstriche, Overlay-Linien, Hover-Tooltip
  und Selection-Bars zählen jetzt über `beats[]` statt
  `firstBeat + n·60/BPM`.
- PWV-Tags (PWAV/PWV2 mono, PWV3 mono-5bit, PWV4 color-6byte, PWV5 RGB,
  PWV6/PWV7 3-Band) werden im Parser korrekt dekodiert und direkt über
  `lowEnergy`/`midEnergy`/`highEnergy` gerendert.
- PWV-Tag-Identifikator (`PWV: PWV7` etc.) wird im Waveform-Status-Strip
  angezeigt, damit der Nutzer sieht, welche Waveform-Variante tatsächlich
  geladen wurde.

### Phase 4 — Keine stillen Fallbacks
- Der XML/DB-Import ruft `analyzeAudioBuffer()` auf dem regulären
  ANLZ-Pfad **nicht** auf (0 Aufrufe, durch Test T7 statisch verifiziert).
- Fehlende ANLZ → `analysisStatus = MISSING_REKORDBOX_ANALYSIS`,
  transparente Warnbox in `TrackHeader` und „⚠ KEINE REKORDBOX-WAVEFORM"-
  Overlay im `DetailWaveform` statt synthetischer Kick-Waveform.
- Demo-/Bootstrap-Audio explizit als `GENERATED_TEST` markiert.
- Auto-Align: läuft **nie automatisch**; bei manueller Nutzung auf einem
  ANLZ-Track erscheint Bestätigungs-Dialog, Grid wird als `USER_EDIT`
  markiert, das original PQTZ bleibt in `originalAnlzBeatGrid` erhalten.
- „Beat 1.1 hier" und Grid-Shift (±1/±10 ms) setzen ebenfalls
  `USER_EDIT` + schreiben ein Operation-Telemetrie-Feedback.

### Tests
- Neuer Test-Suite `tests/anlz-pipeline.test.ts` mit 8 Themenblöcken
  (38 Assertions):
  1. XML `LOCATION`-Parsing
  2. PathResolver (relativ/absolut/leer)
  3. ANLZ-Parser (PQTZ + PWV2)
  4. PQTZ-Beats bleiben 1:1 (Tempowechsel)
  5. Snap/Bar-Beat-Lookup über `beats[]`
  6. PWV→Model-Übernahme
  7. Statische Prüfung: Import ruft `analyzeAudioBuffer()` nicht auf
  8. Fehlende ANLZ → `MISSING_REKORDBOX_ANALYSIS` ohne Synthese
- PWV7 3-Band (CDJ-3000) Byte-Layout separat verifiziert.
- Alle bestehenden Tests (17 Edit-Funktionen, 10 Project-Persistenz,
  PNG-Screenshots) bleiben grün.

### Grep-Audit (verbleibende Referenzen)
| Token | Stellen | Rechtfertigung |
|---|---|---|
| `analyzeAudioBuffer()` | 5 | (1) GENERATED_TEST-Bootstrap; (2) `rerenderFromSegments` nach Edit (einzig legitime Produktionsstelle, rendert vom Working-Buffer); (3) Projekt-Wiederöffnen (dekodierter Buffer); (4) User-Audio-File-Import. Keine davon im ANLZ-Importpfad. |
| `generateAnalysisFromMetadata` | nur Export in `databaseExtractor.ts` | wird nirgends aufgerufen (Test T8 verifiziert). |
| rekursiver Walk / `readdir` / `glob` | 0 Treffer in `src/rekordbox` / `electron` | — |
| `buildBeatGridFromTempo` | XML-Fallback, Demo, User-Import | nie wenn ANLZ-PQTZ vorhanden ist. |

Bundle-Größe: **486.71 kB JS / 61.00 kB CSS** (gzip 137.64 kB / 11.03 kB).
