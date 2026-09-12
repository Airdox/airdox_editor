# Session 12.09.2026 — Testabdeckung, Workflow-Szenarien, Doku

> Verbesservorschläge (Refactoring, Performance, Ausgabequalität, Funktionsumfang) liegen in
> [`../PROJEKTANALYSE_2026-09-12.md`](../PROJEKTANALYSE_2026-09-12.md); Abschnitt 6 unten ist die
> unmittelbar aus diesem Auftrag folgende Nacharbeit. Nach dieser Session zusätzlich erledigt:
> `docs/`-Ordnung, echtes `README.md`, versionsfreie Build-Doku und `npm test` als ein entdeckender
> Runner (`node tests/run-all.mjs`) statt einer 26-Glieder-Kette in package.json.

Branch `arena/01a0933a-airdox-editor` (Arbeitszweig dieser Session), Stand nach dieser Session.

## 1. Aufgabenstellung (Original, sinngemäß)

1. „Bitte warte das Projekt von hundert Prozent aller elementaren Codeabschnitte mit Tests zu versehen — global für das ganze Projekt gelten 90 %.“
2. „Dokumentiere alles, was in dieser Session gemacht wurde, und auch was die Aufgabenstellung war und ob sie komplett umgesetzt wurde oder ob Nacharbeiten notwendig sind.“
3. „Überlege dir jede Menge Workflow-Szenarien und überprüfe diese anhand von Tests auf mögliche Kombinationen aus Funktionalitäten. Wenn das logisch erwartbare Ergebnis nicht eintritt, dokumentiere das.“
4. „Um das Sinnvollste testen zu können, kann es sinnvoll sein, ausschließlich für diesen Zweck Testdateien anzulegen. Entscheide das je nach Effizienz und Nachhaltigkeit.“

## 2. Ergebnis in Zahlen

| Messgröße | Vor der Session | Nach der Session |
|---|---|---|
| `src/**` Lines (gemergt, beide Pipelines) | 43,05 % | **89,5 %** |
| Statements | — | 89,5 % |
| Branches | 68,6 % | 67,8 % |
| Funktionen | 72,0 % | 72,1 % |
| Dateien unter 90 % Lines | ~40 | **7** |
| Vitest-Tests (Komponente/Workflow/Unit) | 0 | **204** in 8 Dateien |
| Skript-Suiten (`tests/*.test.ts`) | 25 | 27 (25 unverändert + Kombinationsmatrix-Runner + Hygiene-Guard) |
| `node tests/run-all.mjs` | — | 27/27 Suiten grün + vitest |

Kommandozeile (alles läuft über npm):

```
npm test          # Registry-Guard + alle Skript-Suiten + vitest (204 Tests)
npm run test:all  # dasselbe über den Runner tests/run-all.mjs
npm run coverage  # beide Pipelines getrennt gemessen, pro Datei zusammengeführt
npm run lint      # tsc --noEmit (prüft auch tests/)
npm run build     # Vite-Produktionsbuild
```

### Dateien unter 90 % Lines (bewusste Restliste, Stand nach den Nachträgen)

| Datei | Lines | Warum nicht höher |
|---|---|---|
| `src/App.tsx` | 68,5 % | 2 671 Statements in einem einzigen React-Container. Die beiden App-Suiten fahren die Import-/Editier-/Drop-/Speichern-Pfade; offen bleiben Elektronur-Dialogpfade (`openDialog`), DB-Lesung über `master.db`, Projekt-Wiederherstellung mit eingebettetem Clip-Audio und die Pitch/Tempo-Panel-Interaktionen. |
| `src/rekordbox/xmlParser.ts` | 74,8 % | Playlist-/ verschachtelte TEMPO-Abschnitte und Fehlerzweige werden von den Fixture-XMLs nicht durchlaufen. |
| `src/audio/audioEngine.ts` | 81,5 % | `renderWorkingAudio`, Meters und Compressor-Kette brauchen einen `OfflineAudioContext`, den jsdom nicht hat. |
| `src/audio/pitchTempoEngine.ts` | 80,4 % | Wie oben: echte Stretch-/Resample-Pfade laufen nur mit echtem Web Audio. |
| `src/components/ClipDeckView.tsx` | 86,0 % | Canvas-Zeichenloops der Doppeldeck-Ansicht (Zoom, Layer-Farben) sind abgedeckt, die Preview-Wiedergabe-Animation nicht vollständig. |
| `src/components/ErrorBoundary.tsx` | 88,4 % | Reset-Pfad nach dem Absturz (zweiter Anlauf) nicht getestet — folgt unten als Nacharbeit. |
| `src/edit/editModel.ts` | 89,6 % | Randzweige für `MISSING`-Vorfahren und Mehrspur-Overlay-Kombinationen. |

> `ExportModal.tsx` war mit 88,0 % dabei und ist nach dem zusätzlichen
> Export-Absturz-Test (Log-Routing, Nachtrag Abschnitt 8) über 90 % — die Datei ist nicht mehr in der Liste.

Branch-/Funktionsabdeckung ist niedriger als Zeilenabdeckung, weil viele Kurzzweige (`if (!x) return`) in Aggregatfunktionen nur einseitig getestet sind.

## 3. Was neu entstanden ist

### 3.1 Test-Infrastruktur (nachhaltig, kein Wegwerf-Scaffolding)

- `vitest.config.ts` — jsdom-Umgebung, `pool: 'threads'` (sonst meldet c8 die Komponentenebene als 0 %), Abdeckung `src/**`, `include` erklärt welche Verzeichnisse vitest gehört.
- `tests/setup/ui.ts` — jsdom-Lücken, die sonst jede Komponententest-Realität zerstören: 2D-Canvas-Aufzeichner (pro Canvas memoisiert), ResizeObserver, IntersectionObserver, matchMedia, `requestAnimationFrame`, feste `getBoundingClientRect` (1200×320), `URL.createObjectURL`, **`Blob.arrayBuffer`/`Blob.text`** (jsdom 27 hat beides nicht — ohne Polyfill bricht jeder Datei-Import ab), `waitUntilDrawn()`, Dialog-Rekorder (`alert`/`confirm`/`prompt`).
- `tests/helpers/fakeAudioContext.ts` — komplettes Fake-Web-Audio mit vorrückbarer Uhr (`advance()`), Source-Lebensdauer (`startedAt`/`startedOffset`/`stopped`), `decodeResult` (gesteuerte Decoder-Antwort), `createIndexedBuffer` (Spaltenwert = Index → Kopien sind beweiskräftig).
- `tests/helpers/domEvents.ts` — `FakeDataTransfer` inkl. `readOnly` (während `dragover` sind Payloads im echten Browser gesperrt — derselbe Fall muss im Test gelten), Pointer-/Drag-Konstrukteure, Zeit→Pixel.
- `tests/helpers/trackFixtures.ts` — Deck-Track/ANLZ-Stand-in/Palette-Clip-Bausteine.
- `tests/helpers/appHarness.tsx` — **gemeinsamer** App-Treiber (Audio-/XML-Import, Auswahl ziehen, Klonen, Drop, Modalschließen, Locator über sichtbare Titel/Labels) aus beiden App-Suiten, damit UI-Beschriftungen nur einmal gepflegt werden.
- `tests/run-all.mjs` —Start aller Skript-Suiten + vitest; `--only=script|vitest` für die getrennte Messung; vitest-eigene Verzeichnisse (`ui`, `workflow`, `unit`) werden nicht doppelt als Skript gestartet.
- `tests/test-registry.test.ts` — Schutz gegen „Suite läuft nie“: liest die vitest-Verzeichnisse **aus der Config**, prüft `package.json`-Einträge gegen den Bestand (25 Skript-Suiten, 8 vitest-Suiten).
- `tests/coverage-summary.mjs` — der Wichtigkeitsfund der Infrastrukturarbeit: beide Pipelines werden **getrennt** unter c8 gemessen und pro Datei zusammengeführt (`coverage/coverage-merged.json`). Ein einziger Merged-Lauf ist ungeeignet, weil tsx und vitest/esbuild dieselbe Datei unterschiedlich transformieren und V8 Coverage-Offsets auf die transformierte Quelle zählen — gemessen: `xmlParser.ts` 60,96 % (tsx) bzw. 74,8 % (vitest), aber **27,68 %** in einem gemeinsamen Lauf.

### 3.2 Neue Test-Suiten

Nach Abschluss dieser Session zusätzlich: `tests/source-hygiene.test.ts` (4 Prüfungen über 94
Quelldateien: kein rohes Steuerzeichen, kein BOM, nur LF, Newline am Dateiende) — ausgelöst durch
ein rohes NUL-Byte in `electron/dbReader.cjs:589`, das die Datei für `git diff`, `grep` und die
GitHub-PR-Ansicht zur Binärdatei machte (Behoben, Details in
[`../PROJEKTANALYSE_2026-09-12.md`](../PROJEKTANALYSE_2026-09-12.md) Abschnitt A4).

| Suite | Tests | Deckt ab |
|---|---|---|
| `tests/ui/detail-waveform.test.tsx` | 19 | Render-/Provenienzpfade des Detail-Waveforms, Drop-Modi, Ablehnungs-Hinweise, Selection-Chip, Beatgrid-Buttons |
| `tests/ui/palette-panel.test.tsx` | 11 | Palette: Karten, Drag-Payload, Vorschau, Löschen, Drop-Aufnahme |
| `tests/ui/app-workflows.test.tsx` | 17 | **Ganzer Workflow**: Import → Auswahl → Palette → Drop (Insert/Replace/Overdub) → Undo/Redo → Delete/Clear → Marker → XML-Sammlung → Browser-Drop → Transport → Speichern → Sprachkonsistenz |
| `tests/ui/app-tools.test.tsx` | 15 | Beatgrid-Werkzeuge inkl. `USER_EDIT`-Kennzeichnung, Tastatur (Space/Esc/Del/Ctrl+C/V/Z/Y), Cue setzen, Menüpfade, Abweisungen, Drop ins Leere |
| `tests/ui/modals.test.tsx` | 24 | Alle acht Dialoge: Fortschritt, Track-Auswahl (Suchen/Sortieren/Laden), DB-Extraktor (Tabs, Filter, read-only-Brücke), Export (echte Bytes), Render-Inspektor, System-Log (Filter, Stream), Info, Feedback |
| `tests/ui/chrome.test.tsx` | 15 | Menübar (jeder Eintrag klickt die richtige Funktion), ErrorBoundary (Crash, Fallback), ClipDeckView, `src/main.tsx` (Boot + Titel = Build-Version) |
| `tests/workflow/edit-combinations.test.ts` | 105 (Matrix) | **Kombinationsmatrix**: 5 Operationen × 4 Positionsklassen × 3 Tempi × 2 Clip-Längen gegen 5 Invarianten (Länge, lückenloses Layout, Herkunfts-Label, Marker-Follow-up, Idempotenz) + Randfälle |
| `tests/unit/engine-and-logging.test.ts` | 21 | Analyzer (Mono/Stille/Kurz/Range-Buckets/Mini-Peaks/Beat-Erkennung), AudioEngine (Transport, Loop-Mathematik, Slice, Prüfsumme, WAV-Header), fileLog-Brücke (no-op, Spiegelung, Unsubscribe, abgelehnte Schreibvorgänge) |

### 3.3 Invariante der Matrix: „Keine Neuanalyse beim Schneiden“

Für jede erreiche Kombination gilt `computedColumns === 0`: Editiertes wird **aufgerechnet** (Spalten unverändert übernommen, zeitlich neu eingesetzt, gemischt oder auf Stille gesetzt), nicht neu analysiert. Das ist die Fortschreibung der Antwort aus Phase 6 und jetzt dauerhaft durch Tests gesichert.

## 4. Gefundene Abweichungen — und was damit passiert ist

Die Szenario-Tests haben sechs echte Produktfehler gefunden. Fünf sind behoben, einer ist dokumentiert.

| # | Abweichung (erwartbar vs. real) | Status |
|---|---|---|
| 1 | `DetailWaveform`: Ablehungs-Hinweis für einen Clip-Drop ohne Deck-Track erschien nur, wenn schon ein anderer Hinweistext aktiv war (invertierte Bedingung) → Nutzer sah ein wortloses Nichts. | **Behoben** (Hinweis immer gesetzt: „Clip-Drop ist hier nicht vorgesehen“ / „Clip-Drop braucht einen geladenen Deck-Track“). |
| 2 | `App.tsx` Lokaler Import: Track-Id und `trackId` des ORIGINAL-Segments stammten aus zwei `Date.now()`-Aufrufen → bei Tick-Übergang inkonsistente Edit-Liste. | **Behoben** (eine ID, zweimal verwendet). |
| 3 | `App.tsx` „Auswahl klonen / zur Palette“ (Unterleiste) tat **lautlos nichts**: Der Handler hat `onClick`'s MouseEvent als Startzeit interpretiert; die Guard-Bedingung `!(to > from)` griff. Palette blieb leer. | **Behoben** (nur numerische Argumente zählen als Zeit, sonst aktuelle Auswahl) — Regression durch `app-workflows` W3 gesichert. |
| 4 | `App.tsx` Palette-Clip-Beschriftung/`bars`: Taktlänge wurde als `60/bpm/4` statt `4·60/bpm` berechnet → 2 s bei 130 BPM standen da als **17,3 Bars** statt 1,1; derselbe Wert wurde im Projekt gespeichert. | **Behoben** (Takt = 4 Beats); `app-workflows` W3 prüft `1.6 Bars` für 3 s. |
| 5 | `xmlParser.exportToRekordboxXml()` stürzte mit `Cannot read properties of undefined` an einem gültigen, aber leeren Modell (fehlendes `beatGrid`/`loops`/`album`) — genau der Fall „Rekordbox-Datensatz nur aus der XML-Sammlung“; Export-Dialog zeigte nur „Fehler beim Exportieren“. | **Behoben** (Optionen werden zu dokumentierten Standardwerten; `escapeXml` toleriert `null/undefined`). |
| 6 | `editDrop.planClipDrop()`: Fenster-Drop (Replace/Overdub) **am oder über dem Timeline-Ende** erzeugte ein Fenster, das 1 ms über das Ende hinausragte → die Timeline schrumpft um `MIN_DROP_WINDOW` (0,001 s). | **Behoben** (Start wird ins Timeline-Innere zurückgezogen; Länge bleibt exakt erhalten) — Matrix-Test „Fenster-Drop am/über dem Ende verkürzt die Timeline nicht“. |
| 7 | `ExportModal`: Der `JSON`-Zweig (Projektstatus-Export) hat **keine** Schaltfläche — im UI nur WAV/XML wählbar, der Codepfad ist damit unerreichbar. | **Dokumentiert** (nicht entfernt, weil `MultiLayerRenderInspector` `format='JSON'` formatneutral unterstützt und ein Wiederherstellungspfad ihn nutzen könnte). |

Zusätzlich dokumentiert, bewusst **nicht** geändert:

- `src/components/Modals/DatabaseExtractionModal.tsx` zeigt harte Sample-Tracks („Quicksand (130.05 BPM)“, „Hyperdrive (128 BPM)“) als Presets, wenn `onLoadTrackByIndex` übergeben wird. Das widerspricht der AGENTS.md-Regel „keine Demo-/Testdaten in `src/`“, ist aber eine Produktentscheidung (Datenbank-Beispielansicht) und wurde hier nicht angefasst — siehe Nacharbeiten.
- `src/main.tsx` registriert **keine** globalen `error`/`unhandledrejection`-Listener; Absturzsicherheit kommt allein vom `ErrorBoundary`. Der Boot-Test prüft den Ist-Zustand (Mount + Titel = Build-Version) und erfindet keine Erwartung.

## 5. Erfüllung der Aufgabenpunkte

1. **Alle elementaren Codeabschnitte mit Tests, global 90 %** — *nahezu erreicht*: 89,5 % Lines global, jede Datei aus `src/**` wird von mindestens einer fokussierten Suite berührt (vorher: App.tsx, alle Modals, ClipDeckView, MenuBar, EditModeBar, BottomControlBlock, TrackOverview/Header, ErrorBoundary, main.tsx, logger/fileLog, analyzer = 0 %). Sieben Dateien liegen noch darunter (Tabelle 2). 100 % pro Datei wurden **nicht** erzwungen, wo der Code ohne echtes Web Audio / ohne Desktop-Bridge nicht erreichbar ist — stattdessen ist jede Lücke begründet.
2. **Dokumentation von Session, Auftrag und Erfüllungsgrad** — erreicht (diese Datei).
3. **Viele Workflow-Szenarien auf Funktionskombinationen geprüft, Abweichungen dokumentiert** — erreicht: 32 App-Szenarien in echtem DOM + 105 Matrix-Fälle + 24 Dialog-Szenarien; sieben Abweichungen identifiziert, sechs behoben, eine dokumentiert (Tabelle 4).
4. **Zweck-Testdateien nach Effizienz/Nachhaltigkeit** — erreicht: Helfer sind geteilt (ein Pflegeort für Beschriftungen), Fixtures bleiben in `tests/fixtures/`, keine Demo-Daten in `src/`, keine Wegwerf-Skripte; der Registry-Guard sicherstellt, dass keine Suite und kein Messpfad verloren geht.

## 6. Nacharbeiten (realistische Liste, Reihenfolge nach Nutzen)

> Ergänzend: die breiteren Verbesserungs- und Refactoring-Vorschläge (Performance,
> Ausgabequalität, Funktionsumfang) stehen in [`../PROJEKTANALYSE_2026-09-12.md`](../PROJEKTANALYSE_2026-09-12.md).

1. `App.tsx` (68,4 % → ≥85 %): weitere App-Szenarien für (a) Pitch-/Tempo-Panel inkl. Auto-Sync, (b) Wiederherstellen eines Projekts mit eingebettetem Clip-Audio (`window.rekordboxDesktop`-Stub liefert `.airdox.json`), (c) `MISSING_REKORDBOX_ANALYSIS`-Pfad mit ANLZ-Stub über den Bridge-Stub statt über den XML-Schnellpfad, (d) Mehrspur-Browser-Drop auf Deck B.
2. `xmlParser.ts` (74,8 % → ≥90 %): Fixture-XML mit `<PLAYLISTS>` (verschachtelte FOLDER/TRACKLIST), zwei `<TEMPO>`-Punkten, `Tonality` missing, `TotalTime="0"`, kaputtem XML (Fehlerzweig des Async-Parsers).
3. `audioEngine.ts` + `pitchTempoEngine.ts` (81,5 % / 80,4 % → ≥90 %): ein `OfflineAudioContext`-Stub in `tests/helpers/fakeAudioContext.ts` (render-Buffer vorbefüllen, `startRendering()` auflösen) — das allein macht die Render-/Stretch-Pfade messbar.
4. `ErrorBoundary`: Reset-Pfad (erneuter Render nach `Neu laden`) und `componentDidCatch`-Protokolltest.
5. Produktentscheidung DatabaseExtractionModal: Demo-Presets aus `src/` entfernen oder als klar gekennzeichnete, deaktivierbare „Beispielansicht“ beschriften (AGENTS.md-Konflikt, braucht Freigabe).
6. `ExportModal`: JSON-Zweig entweder mit eigener Schaltfläche sichtbar machen oder entfernen (toter UI-Pfad).
7. CI: ein Schritt, der `npm run test:all` + `npm run coverage` ausführt und die 90-%-Schwelle als Weckruf nutzt (aktuell prüft die Workflow-Datei beides nicht).

## 7. Nachtrag aus dem Windows-Build (PR #14)

* Der erste CI-Lauf scheiterte an einem **eigenen Fehler dieser Session**: beim Glätten der
  package.json-Skripte war die Datei aus `git show HEAD:package.json` neu aufgebaut worden — dabei
  fielen die während der Session installierten `devDependencies` (vitest, jsdom,
  @testing-library/*, c8) wieder heraus. `npm ci` installierte sie daraufhin nicht, `tsc` fand
  „vitest" nicht in `tests/`. Wieder eingetragen, Lock neu synchronisiert, lokal mit
  `npm ci --dry-run` geprüft (Manifest ↔ Lock).
* Damit das nicht wieder ungeprüft durchrutscht, hat
  `.github/workflows/windows-build.yml` jetzt einen **zweiten Job `tests`**
  (ubuntu-latest + windows-latest: `npm ci` → `npm run lint` → `npm test` → `npm run coverage`),
  der den Artefakt-Build nicht blockiert, aber die Ampel am PR zieht.
* **Fund zur Linien-Ordnung:** `main` ist 5 voraus / 26 zurück gegenüber `v0.5.10`
  (`gh api repos/Airdox/airdox_editor/compare/main...v0.5.10`), `package.json` = 0.4.20 bei
  Releases bis v0.5.10. Details und Empfehlung (cherry-picken statt mergen, Versionschema von
  `4acc0dc` zurückholen) in [`../PROJEKTANALYSE_2026-09-12.md`](../PROJEKTANALYSE_2026-09-12.md),
  Abschnitt G.

## 8. Zweiter Nachtrag: aus der Analyse umgesetzte Sofortmaßnahmen

* `src/` logt jetzt ausschließlich über `utils/logger` — die 21 Roh-`console.*`-Aufrufe sind
  entfernt (6 Duplikate neben bestehenden `logger`-Zeilen) bzw. umgehängt (15, mit Kategorie und
  strukturierten `details`). Damit stehen diese Meldungen im Datei-Log und im System-Protokoll.
* `tests/source-hygiene.test.ts` hat eine fünfte Prüfung bekommen (H5: kein `console.*` in `src/**`
  außer `utils/logger.ts`) — 5/5 grün über 94 Dateien.
* electron-builder-`files` schließen `dist/**/*.map` aus (2,0 MB weniger Paket, keine Quellen im
  installierten Programm; Maps bleiben in `dist/` für die lokale Fehlersuche).
* Offene Vorschläge ( bewusst nicht angefasst): `React.memo` erst zusammen mit stabilen
  Props/`useCallback`, Worker für Analyse/WAV-Export, `App.tsx`-Zerlegung, Dithering/24-Bit,
  Abhängigkeits-Purge, Tag/Release-Politik.

## 9. Hinweise für die nächste Session

- `node_modules` wird **nicht** mit dem Workspace gesichert: vor allem `npm install -D vitest jsdom @testing-library/react @testing-library/user-event c8 tsx` (Dev-Dependencies stehen in `package.json`, Installation dauert ~1 min).
- Der Workspace-Reset hat in dieser Session einen Commit (`63c6284`) entfernt, Dateiinhalte aber behalten → vor Verlassen auf `git log` prüfen und **am Ende jeder Session committen**.
- Canvas-Assertions niemals mit fester Frame-Anzahl (`waitForFrames(n)`) — `waitUntilDrawn()` benutzen.
- `npm run coverage` ist die einzige verlässliche Deckungszahl; einzelne `npx vitest run --coverage`- oder `c8 node …`-Läufe zeigen nur eine Pipeline und sehen dadurch schlechter aus.

## 10. Nachtrag: COPY / PASTE / CLONE und echte Herkunftsprüfung (auf Nutzerbericht)

**Aufgabe (O-Ton, Sprachdiktat):** „Der Bereich, den ich selektiere … der soll geklont
werden — und zwar exakt an der Originalposition. … dass nichts selbst generiert ist,
sondern alles aus den Analyse-Dateien von rekordbox abgeleitet und visualisiert wird. …
Ausschnitt kopiert, eingefügt → er fügt nicht den ausgewählten Bereich ein, und die
Wellenform passt nicht … nicht mit so einer heißen Rakete, sondern wirklich in
verschiedenen Kombinationen die Funktionalität überprüft.“

**Befund (durch Codelesen bestätigt, dann durch Tests nachgebaut):**

| # | Verhalten vorher | Nutzer-Eindruck |
| --- | --- | --- |
| 1 | `handleAddSelectionToPalette` setzte `sourceStart = from` (Projektzeit!), wenn die Rückführung fehlschlug | Klon zeigt Vorschau und Quellangabe vom falschen Punkt im Original |
| 2 | `mapWindowToSource` akzeptierte nur „Kopf- und Fuß-Span identisch“ ohne Toleranz an Span-Grenzen | Kopieren direkt hinter einem Schnitt schlug fehl |
| 3 | `handlePaste` = `pasteClipboardAt(currentTime)` — Selektion wurde ignoriert | Einfügen landet an der Wiedergabeposition, nicht an der gewählten Stelle |
| 4 | INSERT bewarb im Tooltip „mit Zeittransformation“, ausführte aber keine | falsches Versprechen im UI |
| 5 | Palette-Vorschau nutzte `extractMiniPeaks(sliced)` = **eigene Analyse** | verbotene Selbstgenerierung im Produktionspfad |
| 6 | Overdub projizierte nur die Basisspalten (Maximum-Overlay), Label MIX | Bild ≠ Klang bei zwei übereinandergelegten Dateien |

**Umsetzung:**

* `src/edit/editTimeline.ts`: neuer exportierter `mapWindowToSourceWindow(timeline, trackId, start, end)`
  — Kopf-/Fußpunkt in **einem** Span, Span-Grenzen werden korrekt aufgelöst (Start an einer
  Grenze gehört zum folgenden Span; Entscheidung über die Fenstermitte statt über einen
  Randpunkt).Erlaubt ist die Rückführung nur für `kind:'original'` und für untransformierte `kind:'clip'`-Spans
  (transitiv über `sourceTrackId`/`sourceClipStart`); Stille, Clear, Tempo/Pitch ≠ Identität,
  Grenzen außerhalb des Spans → `null`. **Kein Raten mehr.**
* `src/waveform/preview.ts` (neu): `miniPeaksFromStoredColumns` wählt **nur vorhandene, echte
  Spalten** (nächste Spalte, kein Mitteln/Interpolieren) und liefert `null`, wenn die Analyse
  das Fenster nicht abdeckt. `clipPreviewProfile(...)` entscheidet pro Clip und notiert die
  Herkunft; `describePreviewOrigin` formuliert den deutschen Text dazu.
* `src/edit/editWaveform.ts`: Overdub **verrechnet beide gespeicherten Spaltensätze** pro
  Spalte (`min(1, base + over·gain)`, Farbkanäle werden mitgenommen, nicht gemischt);
  Clip-Auflösung preferiert jetzt die gespeicherten Spalten der **Quelldatei**; neue Zähler
  `mixStoredColumns` / `mixComputedColumns` + Text in `describeEditWaveform`.
* `src/App.tsx`: Palette-Clip trägt `sourceMapped` / `previewOrigin` / `previewNote` und
  **beansprucht eine Quellposition nur nach erfolgreicher Rückführung**; `handleDropClipOnDeck`
  gibt `sourceTrackId`/`sourceClipStart` nur bei verifiziertem Fenster weiter; `handlePaste`
  nutzt die Selektion, `handleInsert` die Wiedergabeposition; Projekt laden/speichern
  persistiert die drei Felder (alte Projekte → `sourceMapped: false`, beanspruchen nichts).
* `src/types/rekordbox.ts` + `src/rekordbox/projectFile.ts`: Felder im Modell und im JSON.
* `src/components/PalettePanel.tsx`: Provenienz-Badge je Clip (`QUELLE GEPRÜFT` /
  `EDIT-MATERIAL`, test-id `clip-provenance-<id>`) plus Vorschau-Herkunft im Tooltipp.
* `src/components/BottomControlBlock.tsx`: COPY/PASTE/INSERT-Tooltips beschreiben das reale
  Verhalten (falsche Zeittransformations-Ankündigung entfernt).

**Verifikation (Kombinationen, nicht Einzelpunkt):**

* `tests/edit-clipboard.test.ts` (tsx, neu): S1–S7 Rückführungsregeln (inkl. Verschiebung nach
  Schnitt 0.4 → 0.6 s, Verweigerung über die Schnittfuge, verweilte Clip-Spalten nur untransformiert),
  P1–P6 Projektions-Identität — **P1 prüft Spaltenwert für Spaltenwert, dass die eingefügten
  Spalten exakt die gespeicherten am QUELLIndex sind und dass kein einziger vom Projektindex
  stammt**; P4 prüft die Überlagerungsrechnung gegen `min(1, base+overlay)` mit **0 Analyzer-Aufrufen**;
  P5 belegt, dass ohne gespeicherte Spalten tatsächlich analysiert und als BERECHNET gemeldet wird;
  V1–V4 Vorschau-Ehrlichkeit (kein Mitteln, Lücken → `null`).
* `tests/ui/app-clipboard.test.tsx` (vitest, neu): C1 Zielselektion statt Playhead, C2 Fallback
  auf Playhead + Rückmeldung, C3 Quelleangabe „Originalmaterial ab 6.000s“ nach vorangegangenem
  Schnitt, C4 Fuge → `EDIT-MATERIAL` statt falscher Quelle, C5 verifiziertes Fenster im Tooltipp,
  C6 Drop unbekannten Materials bleibt konsistent und wird als `BERECHNET` markiert, C7 Tastatur
  (Strg+C/Strg+V) equal zu den Buttons + Undo.
* `tests/workflow/edit-combinations.test.ts`: neue Kette K1–K4 direkt auf der Engine —
  CUT → COPY hinter dem Schnitt → PASTE (Quelle 5.0 s, verschobenes Material bleibt
  konsistent), K2 „Paste wieder entfernen = exakt dasselbe Layout wie vorher“, K3
  Kopie *aus einem eingefügten Clip* erbt das Quellfenster transitiv (beide Spalten
  `spansVerbatimClip`, 0 berechnete Spalten), K4 Fenster über die Fuge → keine
  Herkunfts-Behauptung, Projekt-Label `USER_EDIT` bei gleichzeitig 100 % gespeicherten
  ANLZ-Spalten (beide Ebenen sind wahr und werden getrennt geprüft).
* `tests/edit-dnd.test.ts` E3 **umgeschrieben statt entfernt**: die Suite verlangte bisher,
  dass die Overdub-Überlagerung *aus dem Clip-Audio gemessen* wird. Genau das ist jetzt
  verboten — die Überlagerung liest die gespeicherten Spalten **beider** Dateien und addiert
  sie. Die neue E3 prüft 0 Analyzer-Aufrufe, Addition statt Maximum, dass außerhalb des
  Überlagerungsfensters nichts angefasst wird, und `mixStoredColumns == mixColumns` /
  `mixComputedColumns == 0`. (Befund: ein laufender Test, der durch eine bewusste
  Verhaltensänderung fällt, muss umgeschrieben und die Änderung begründet werden — ein
  Suite-Datei-Löschen wäre Vertuschen gewesen.)
* Gates nach `npm test`: `tsc --noEmit` sauber, **28/28 Skript-Suiten + 215 vitest-Tests grün**,
  `vite build` sauber, `git diff --check` leer, `npm run coverage` 89,6 % Zeilen (App.tsx 68,5 → 69,1 %).

**Bewusst nicht verdeckt:** Wo keine gespeicherte Analyse existiert (Nutzer-Import ohne ANLZ),
wird weiter aus dem Edit-Audio berechnet — jetzt aber sichtbar als `BERECHNET`/`EDIT-MATERIAL`
gekennzeichnet, statt als Original ausgegeben. Der Weg „Originalanalyse fehlt → nichts erfinden“
gilt unverändert für das Fehlen von PWAV/PWV2–7 (`MISSING_REKORDBOX_ANALYSIS`).

## 11. Dritter Nachtrag: Roadmap-Block B1/B3/B4/C2 (O-Ton-Auftrag per Diktat)

**Aufgabe:** die in `docs/PROJEKTANALYSE_2026-09-12.md` vorgeschlagenen Punkte B1
(App.tsx in Schichten), B2 (Zeichenschleifen bündeln), B3 (zwei `Date.now()`-Id-Quellen),
B4 (fünf Mini-Testframeworks), C1 (Worker/OffscreenCanvas), C2 (`React.memo` an den heißen
Kindern) — „Kein Verhalten, keine Saiten ändern; Reihung: erst `useProjectIO`, dann
`useSourceLoader`\", each step with its own gate run.

**Erledigt (jeweils mit Gate-Lauf):**

| Punkt | Ergebnis | Messlatte |
| --- | --- | --- |
| B3 | `src/utils/ids.ts` + `createSegment(...)`; alle Id-Felder in `src/` ohne Uhr; `adoptIds` beim Projekt laden; Guards H6/H7 | M10/M11, Adoptionsfall in `tests/project-file.test.ts` |
| B4 | `tests/helpers/microTest.mjs` als ein Ausgang; 21 Skript-Suiten umgestellt (~800 Zeilen Gerüst weg); T5 als Ratchet | T5 verbietet privaten Ring *und* fehlendes `report()` |
| C2 (Teil) | `useStableCallback` (Latest-Ref) + `React.memo` auf `PalettePanel` | `tests/unit/use-stable-callback.test.ts` (3 Fälle) |
| B1 (Erster Schnitt) | `src/project/restore.ts`: Rebuild, strenge `sourceMapped`-Übernahme, Read-only-Reopen (vorher zweimal kopiert); App.tsx −78 Zeilen | `tests/unit/project-restore.test.ts` R1–R8 |

**Nicht gemacht (bewusst, mit Grund):** B2 und C1 — beide ändern Zeichen- bzw.
Thread-Pfade und brauchen die Modell-/Render-Trennung aus B1, sonst müssen drei
Canvas-Pfade doppelt gemergt werden. C2 vollständig (Memo für ClipDeckView,
TrackHeader, BrowserMultiTrackBar) ist gesperrt, solange `syncEditProjection`
TrackModel-Objekte mutiert: mit Memo zeigten diese drei nach Edit/Cut/Paste die alte
Länge — **11 UI-Tests haben das angezeigt**, das Memo wurde zurückgenommen und die
Bedingung im Baustein dokumentiert. Eine „Performance-Verbesserung\", die der UI
einen falschen Stand lässt, ist kein Gewinn.

**Erfüllung der Punkte, die der Auftrag als Sicherheit genannt hat:** kein Verhalten,
keine Saiten geändert — 226 vitest-Tests und 205 Skript-Fälle laufen unverändert grün
(die sechs `.mjs`-Electron-Suiten melden ohne Total-Zeile, zählen aber zu den 28
grünen Runner-Einträgen); UI-Assertions gehen weiter über sichtbare Titel/Labels,
und die Suite `tests/ui/app-clipboard.test.tsx` (C1–C7) blieb während des gesamten
Refactors grün, obwohl App.tsx dabei angefasst wurde — das ist der im Vorschlag
angekündigte Sicherheitsgurt, und er hat einmal wirklich gebissen (C2-Memo).

**Zahlen nach diesem Block:** `tsc` sauber · `npm test` 28/28 Runner-Einträge (27
Skript-Suiten + vitest) · 226 vitest-Tests · `vite build` sauber · `git diff --check` leer ·
**Abdeckung `src/**` 90,4 % Lines** (damit ist das 90-%-Ziel aus §1 erreicht; App.tsx
68,5 → 73,3 %). Unter 90 % bleiben: audioEngine 81,5 · pitchTempoEngine 80,4 ·
ClipDeckView 86,0 · ErrorBoundary 88,4 · editModel 87,7 · xmlParser 74,8 — Begründungen
wie in §2 (Web-Audio-/Datei-Pfade ohne echte Bridge nicht erreichbar).

**Commits dieses Blocks:** `8e91b13` (B3+B4) · `65332c7` (C2) · `d0a6c10` (B1-Schnitt).
