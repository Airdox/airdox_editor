# E2E-Nachweis: Vereinigte Rekordbox-Pipeline (11.09.2026)

## Was wurde vereinigt

- **Basis (der funktionierende Stand vom 09.09., ~23:00 Uhr):** `52af2dc`
  (Branch `arena/01a0880b`) — die verifizierte DB-/ANLZ-Pipeline mit
  Visual-Lock, exakter Pfadverknüpfung XML → `master.db` → `AnalysisDataPath`
  und ausschließlicher Visualisierung originaler Rekordbox-Analysedaten.
- **Weiterarbeit (letzter Branch):** `arena/01a08dc7` — restauriert `52af2dc`
  verbatim und ergänzt den strengen ANLZ-Primärpfad (harte Pipelinefehler
  statt stiller Fallbacks, ID-Vertrag `XML TrackID == djmdContent.ID`).

## Verknüpfungsverträge (deterministisch, keine Verzerrung)

1. **ID-Vertrag** (Primär): XML-`TrackID` existiert genau einmal als
   `djmdContent.ID` **und** der kanonische Dateipfad ist identisch.
2. **Pfadvertrag** (aus 52af2dc restauriert): eindeutiger exakter kanonischer
   Pfadtreffer XML-`Location` ↔ `djmdContent.FolderPath`. Mehrdeutige Pfade
   (gleicher Pfad, verschiedene Analyse-Zeilen) werden im Index hart
   ausgeschlossen — es wird nie geraten.
3. **Kein Vertrag erfüllt → sichtbarer Pipelinefehler.** Kein PPTH-Scan, kein
   Fuzzy-Matching, keine eigene Analyse, keine Ersatzdaten.

Alle visualisierten Daten (Waveform, Beatgrid, Cues, Loops, Phrasen) stammen
ausschließlich aus den bereits analysierten Rekordbox-Daten (ANLZ DAT/EXT/2EX
über den `master.db`-`AnalysisDataPath`). Es finden keinerlei eigene
Berechnungen, Anpassungen oder Weglassungen statt.

## Testlauf (Screenshots)

Echte App (Vite-Build, Headless-Chromium) mit simulierter Desktop-Bridge:
fake `master.db`-Zeilen + **echte binäre ANLZ-Container** (Deep-Symmetry-konforme
Fixtures aus `tests/fixtures/testDatasets.ts`: PPTH, PQTZ, PCOB, PCO2, PWV3,
PWV5, PWV7, PSSI).

| Datei | Fall | Ergebnis |
|---|---|---|
| `01-app-start.png` | App-Start | leeres Deck, keine erfundenen Daten |
| `02-collection-modal.png` | XML-Import | 3 Tracks in der Track-Auswahl |
| `03-track101-id-contract.png` | TrackID 101 == djmdContent.ID 101 + exakter Pfad | ANLZ-Waveform: 900 Buckets, PWV7, 3 Varianten, 4 Phrasen (PSSI), Cues/Loops — Badge `REKORDBOX_ANLZ` |
| `04-track999-path-contract.png` | fremde TrackID 999, eindeutiger exakter Pfad → DB-Zeile 555 | identische ANLZ-Daten über den restaurierten Pfadvertrag |
| `05-track777-pipeline-error.png` | kein DB-Datensatz | sichtbarer `[ANLZ Pipelinefehler]`-Alert, Deck unverändert, **keine** Ersatz-Waveform |
| `console-log.txt` | Log-Beweis | `[Track-Link] … (ID-Vertrag, DB-Track 101)`, `… (eindeutiger Pfadvertrag, DB-Track 555)`, `[ANLZ Pipelinefehler] … TrackID 777` |

Alle 8 E2E-Assertions bestanden; zusätzlich die volle Unit-Suite
(`npm test`, 105 Checks inkl. 3 neuer Vertrags-Tests in
`tests/analysis-resolver.test.ts`) und `tsc --noEmit` ohne Fehler.

## Reproduktion

```bash
npx tsx tests/e2e/generate-anlz-fixtures.ts   # echte ANLZ-Binärcontainer
npm run dev                                    # App auf Port 3000
node tests/e2e/rekordbox-pipeline.e2e.mjs      # Headless-Chromium nötig
```
