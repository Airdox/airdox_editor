# Projektanalyse — Improve / Refactor / Simplify / Performance / Ausgabequalität / Funktionsumfang

Stand: 12.09.2026, Branch `arena/01a0933a-airdox-editor`, Version 0.4.20.
Grundlage sind Messungen im Repo (keine Vermutungen); jede Zahl ist mit dem Kommando darunter nachprüfbar.

```
find src -name '*.ts*' | xargs wc -l | tail -1     # 17 777 Zeilen in 45 Dateien
find tests -name '*.test.*' | xargs wc -l | tail -1  # 9 148 Zeilen in 33 Suiten
find electron -name '*.cjs' | xargs wc -l | tail -1  # 1 500 Zeilen
npm run coverage                                    # 89,4 % Lines, 89,4 % Stmts, 67,8 % Branch, 72,1 % Funkt.
npx tsc --noEmit                                    # fehlerfrei (prüft auch tests/)
```

Größenordnung der Hotspots: `src/App.tsx` 2 671 Zeilen (39 × `useState`, 48 Handler, 0 × `React.memo`), `src/components/DetailWaveform.tsx` 1 661 Zeilen, `src/rekordbox/anlzParser.ts` 835, `src/components/ClipDeckView.tsx` 724, `src/components/Modals/DatabaseExtractionModal.tsx` 696.

---

## A. Ordnung / Wartbarkeit (klein, sofort machbar)

**A1 — 20 Roh-Konsolenaufrufe am Loggersystem vorbei.**
`src/App.tsx` nutzt an 19 Stellen `console.warn/info/error` (Zeilen 219, 242, 443, 455, 499, 502, 509, 517, 1598, 1686, 1689, 1704, 1713, 1750, 1817, 1967, 2025, 2095, 2152, 2235), `ExportModal.tsx:133` eine. Diese Meldungen — genau die bei Rekordbox-Erkennungsproblemen interessanten — landen **nicht** im Datei-Log (`utils/fileLog.ts`) und nicht im System-Protokoll-Dialog, weil `utils/logger.ts:163-172` die einzige Senke ist, die beides speist.
*Nutzen:* Nutzerberichte werden nachvollziehbar, ohne dass DevTools geöffnet sein müssen. *Aufwand:* 20 Zeilen umhängen (Tag-Erhaltung: `[ANLZ Auto]`, `[DB Auto]`, `[Projekt]`). *Risiko:* null. *Verifikation:* bestehender Logger-Test + ein neuer Fall „App-Meldung erscheint im System-Protokoll".

**A2 — README und Build-Doku sind Platzhalter bzw. veraltet.** `README.md` beschrieb bis zu dieser Session das AI-Studio-Startgerüst („Run and deploy your AI Studio app", `GEMINI_API_KEY`), `BUILD_WINDOWS.md` nannte Artefakte mit 0.4.18. → README neu geschrieben (Projekt, Befehle, Doku-Index), Build-Doku versionsfrei formuliert, `docs/README.md` als Lesereihenfolge ergänzt. *Erledigt in dieser Session.*

**A3 — `metadata.json` und das `clean`-Skript verweisen auf AI-Studio-Reste.** `metadata.json` deklariert `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`, `"clean": "rm -rf dist release server.js"` löscht eine `server.js`, die es nicht mehr gibt. Vorschlag: `metadata.json` entweder löschen oder auf das reale Produkt umbiegen (Name „Rekordbox DJ Audio Editor" ≠ `productName` `airdox_SMART_Editor`), `clean` auf `dist release coverage` stellen. *Risiko:* nur, falls der AI-Studio-Workflow der Nutzer die Datei braucht — deshalb nicht eigenmächtig gelöscht.

**A4 — `electron/dbReader.cjs` war für GitHub eine Binärdatei.** In Zeile 589 stand ein **rohes NUL-Byte** in einem Regex-Zeichenfeld (`/[\s<00>]+$/` statt `/[\s\x00]+$/`). Semantisch identisch, praktisch: `grep` („binary file matches“, `git diff` („Binary files differ“ und die PR-Ansicht konnten 960 Zeilen der meistgeänderten Datei im Electron-Teil nicht mehr anzeigen — Reviews dort waren blind. Behoben (Escape-Folge) und durch `tests/source-hygiene.test.ts` dauerhaft gesichert: kein rohes Steuerzeichen, kein BOM, nur LF, Newline am Dateiende — 94 Quelldateien, 4 Prüfungen.

## B. Refactoring / Vereinfachung

**B1 — `src/App.tsx` in drei Schichten zerlegen (größter Hebel).**
Ist: 2 671 Zeilen, 48 Handler, 39 Einzelfelder. Die Datei enthält vier klar getrennte Zuständigkeiten: (1) Import-/Quellenversorgung (XML/DB/ANLZ, Zeilen ~380–560, ~1530–1830), (2) Deck-Transport und Audio-Bereitstellung (~539–820), (3) Editier-Projektion und Grid-Werkzeuge (~816–1520), (4) Projekt-Persistenz (~1960–2250).
Vorschlag: daraus vier Hooks machen — `useSourceLoader`, `useDeckTransport`, `useEditProjector`, `useProjectIO` — und den Zustand in einen `useReducer` pro Domäne legen; App.tsx behält nur noch Komposition + Layout (Ziel: < 600 Zeilen).
Warum das sicher ist: die 32 App-Szenario-Tests in `tests/ui/app-workflows.test.tsx` + `tests/ui/app-tools.test.tsx` fahren genau diese Pfade über sichtbare Titel/Labels und bleiben bei korrekter Zerlegung unverändert grün — der beste vorhanden Refactoring-Sicherheitsgurt. Kein Verhalten, keine Strings ändern; Reihung: erst `useProjectIO` (am unabhängigsten), dann `useSourceLoader`.
*Nutzen:* Deckungsanzeige wird aussagekräftig (App.tsx ist mit 68,4 % der Ausreißer, weil ein Render-Block mit 2 671 Statements gemessen wird), Review-Blast-Radius sinkt, Wiederverwendung für Deck B/C. *Aufwand:* 2–3 Sessions. *Risiko:* mittel (Effekt-Reihenfolge, Cleanup von `addEventListener` in Zeile ~2318) → in Teilschritten mit je einem Gate-Lauf.

**B2 — Zeichenschleifen dreimal parallel.** `DetailWaveform.tsx` (23 × `fillRect`, 3 rAF-Schleifen), `ClipDeckView.tsx` (2 × `fillRect`, 2 rAF), `TrackOverview.tsx` (10 × `fillRect`). Die Datenseite ist bereits sauber ausgelagert (`src/waveform/renderModel.ts`, 99,0 % gedeckt, malt selbst nichts) — die Pixel-Seite nicht. Vorschlag: `src/waveform/painter.ts` mit `paintBands(ctx, model, geometry, style)` / `paintGrid` / `paintSelection`, die drei Komponenten rufen nur noch Geometrie + Stil auf. *Nutzen:* identische Darstellung an allen drei Orten (heute: unterschiedliche Randbehandlung beim Zoom), halb so viel Canvas-Code, Deckungsproblem der drei Komponenten löst sich mit. *Aufwand:* 1 Session. *Risiko:*gering — visuell, deshalb vor/nach mit den Referenz-Screenshots in `reference/` abgleichen.

**B3 — Zwei `Date.now()`-Quellen für dieselbe Identität.** In dieser Session für den LOCAL-IMPORT-Pfad gefixt (Track-Id vs. Segment-`trackId`), der Mustertyp existiert aber weiter: überall dort, wo `id: Date.now().toString()` und ein zweites `Date.now()` in einem Objekt stehen, kann bei Tick-Übergang eine inkonsistente ID entstehen. Vorschlag: `nextEditId()`-Hilfsfunktion (Monotonzähler, in `src/edit/editModel.ts`) und eine `createSegment(...)`-Fabrik, die Track-/Segment-ID aus derselben Quelle speist; danach per grep ausschließen (`grep -n "Date.now()" src/**/*.tsx` soll nur noch in Timecode-/Stats-Kontexten stehen).

**B4 — `tests/*.test.ts` (25 Skript-Suiten) haben fünf verschiedene Mini-Testframeworks.** Jede Suite definiert ihre eigene `runTest/assert`-Schleife (~15 Zeilen Boilerplate × 25). Vereinfachung, die den Vertragscharakter erhält: ein winziges `tests/helpers/microTest.ts` (same 20 Zeilen, ein Ausgang) und die Suiten importieren es; vitest bleibt für Komponenten/Workflows. Alternative (mehr Nutzen, mehr Aufwand): die datenlastigen Skript-Suiten als `it()`-Fälle nach `tests/unit/` migrieren — dann gibt es **einen** Runner und die Coverage-Pipeline braucht keine Merge-Mechanik mehr (`tests/coverage-summary.mjs` könnte entfallen). Empfehlung: Zwischenschritt — erst Helpers auslagern, Migration nur für die 6 Suiten, die ohnehin keine Node-APIs brauchen.
*Diese Session hat bereits vereinheitlicht:* `npm test` ist jetzt ein einziger discovering Runner (`node tests/run-all.mjs`) statt einer von Hand gepflegten 26-Glieder-Kette; der Registry-Guard prüft die Entdeckungslücke direkt (`--list`).

## C. Performance

**C1 — Wellenform-Malen und Render-Export blockieren den UI-Thread.** Belege: kein `Worker`, kein `OffscreenCanvas` im ganzen `src/` (`grep -rn "new Worker\|OffscreenCanvas" src` → 0 Treffer); `audioEngine.exportToWavBlob()` (Zeile 328) baut den Blob synchron, `analyzeAudioBuffer()` rechnet 200 Buckets/s im Aufrufer-Thread, `DetailWaveform` zeichnet in rAF-Schleifen.
Vorschlag, in Nutzenreihenfolge:
1. `analyzeAudioBuffer` + `extractMiniPeaks` in einen Worker auslagern (der Rechenkern ist bereits frei von DOM-Zugriffen — Ein-/Ausgabe sind `Float32Array`s, also `postMessage` mit Transfer). Bei 10-Minuten-Tracks sind das ~4 800 Buckets × 2 Kanäle, heute spürbar beim Import.
2. `exportToWavBlob` in Blöcken schreiben (`Blob` aus `Uint8Array`-Chunks) oder in den Worker verlagern, Fortschritt über das bestehende `logger`-Abo melden.
3. Detail-Waveform nur bei Geometrie-/Modelländerung neu zeichnen (heute auch bei reinem Playhead-Schritt) — Trennung in zwei Ebenen: statisches Modell-Canvas (offscreen, nur bei Modellwechsel) + Overlay-Canvas für Playhead/Selection. Das ist auch der Rekordbox-Vorbildaufbau.
*Messlatte:* Zeit von „Datei fällt in den Drop-Container" bis „Waveform sichtbar" und CPU der Render-Taste; vor der Änderung mit `performance.mark()` messen, nachher muss der Wert gehalten werden.

**C2 — Kein `React.memo` an den heißen Kind-Komponenten.** 0 × `memo` bei 39 `useState`-Feldern in App.tsx: Jeder Transport-Tick (Playhead-Position, `audioEngine.getCurrentTime()` in einer rAF-Schleife) re-rendernt Palette, Browser-Zeile, Modals und die drei Waveform-Container mit. Vorschlag: `React.memo` auf `PalettePanel`, `BrowserMultiTrackBar`, `TrackHeader`, `ClipDeckView`, plus Playhead-Position in einen separaten, dünnen Leaf-State (oder eine Ref + Overlay-Canvas, siehe C1.3) — statt durch die ganze Baumkette zu flußen. *Nutzen:* spürbar flüssigeres Scrubbing auf schwacher Hardware, genau die Zielgruppe (DJ-Laptops). *Aufwand:* ein Nachmittag, sehr geringes Risiko dank App-Szenarien.

**C3 — 539 kB JS in einem Chunk plus 2,0 MB Quellmap im Paket.** `vite.config.ts` setzt `build.sourcemap: true`; electron-builder packt `dist/**/*` → die `.map` wandert ins asar. Vorschlag: `sourcemap: mode === 'production' ? 'hidden' : true` (Fehler analysierbar via Sentry-artiger Beigabe, aber nicht im Auslieferungspaket) und `build.rollupOptions.output.manualChunks` für `lucide-react`/Vendor; außerdem `codeSplitting` für die Modal-Brocken (`DatabaseExtractionModal` 696 Zeilen, `RekordboxXmlImportModal` 642) per `React.lazy`, weil beide nicht zum Start gehört werden müssen. *Nutzen:* kleineres Setup, schnellerer Start (weniger Parsing vor dem ersten Paint), Quellcode nicht im installierten Paket.

**C4 — `allowedHosts: true` im Dev-Server** (`vite.config.ts`) ist für die Sandbox nötig, gehört aber nicht in die Auslieferung und ist eine unnötige Tür im Entwickleralltag. Vorschlag: aus Umgebungsvariable steuern (`VITE_DEV_ALLOWED_HOSTS`), Standard `false`.

## D. Ausgabequalität

**D1 — 16-Bit-WAV-Export ohne Dithering oder True-Peak-Begrenzung.** `exportToWavBlob` quantisiert auf `Int16` (44-Byte-Header, 16-bit stereo, Mono spiegelt L — in `tests/unit/engine-and-logging.test.ts` byte-genau festgeschrieben). Bei Overdub-Mischungen (`MIX`-Multiplikator) und Gain-Automation entstehen leise, hart quantisierte Ausblendungen.
Vorschlag: TPDF-Dithering (1,5 LSB Dreieckssumme zweier LSB-großer Zufallswerte) vor der Quantisierung + konfigurierbares Kopfhörer-/Mastering-Peak-Handling (Clipping-Erkennung mit Warnung im Feedback-Dialog statt stummer Übersteuerung), optional 24-Bit-PCM als zweites Exportformat im `ExportModal` (der Inspektor `MultiLayerRenderInspector` ist formatneutral, `format='JSON'` zeigt das).
*Verifikation:* neuer Byte-Test: identische Eingabe → deterministischer Output pro Seed (Seed fest), Sinus bei −120 dB_fs bleibt nach Dither hörbar-repräsentiert statt auf 0 zu fallen, Peak-Meldung bei >0 dBFS.

**D2 — Waveform-Skalen: unbearbeitete Bereiche zeigen EXAKT Rekordbox; editierte Bereiche werden aufgerechnet.** Das ist Absicht (Phase-6-Entscheidung, dokumentiert in `src/edit/editModel.ts`,getestet in `tests/workflow/edit-combinations.test.ts`: 105 Kombinationen, Invariante `computedColumns === 0`). Was fehlt, ist die **Kenntlichmachung**: heute zeigt das Provenienz-Badge `USER_EDIT`, aber dieeditierte Kontur ist von einer echten nicht zu unterscheiden. Vorschlag: im Detail-Waveform eine dezente Markierung der aufgerechneten Segmente (gestrichelte Kontur oder 10 % Transparenz, im `reference/`-Stil) + Tooltip „Spalten aus Original-Waveform aufgerechnet (kein Re-Analyse-Lauf)". Reine Anzeige, kein Eingriff in die Herkunftskette.

**D3 — Beatgrid-Raster nach Clipschnitt.** `gridOriginAfterEdit` und `retime*` halten Grid, Cues, Loops und Phasen konsistent (Tests grün, Abweichung #6 — 1 ms Timeline-Schrumpfung — behoben). Offene Feinheit: Bei `CLEAR` über das Timeline-Ende hinaus wird die Timeline mit Stille **verlängert** statt beschnitten (Doku in `src/edit/editDrop.ts`/`editModel.ts`, per Test festgeschrieben). Aus Nutzer-/Rekordbox-Sicht wäre „CLEAR schneidet ab" erwartbarer. Vorschlag: Verhalten im `EditModeBar` sichtbar machen (Längen-Delta als Feedback) oder auf „beschneiden" umstellen — Produktentscheidung, nicht technisch.

**D4 — Export-XML-Strenge.** `exportToRekordboxXml` (`src/rekordbox/xmlParser.ts:596`) ist inzwischen nullsicher für fehlende `beatGrid`/`loops`/`cues`/`album` (in dieser Session gefixt, Fehlen wird dokumentiert statt erfunden). Zwei echte Lücken bleiben: Datei deckt 74,8 % der Zeilen ab, `Playlist`-/Mehrtitel-Export wird von keinem Test erzeugt; und unbekannte `Key`-Werte (Camelot außerhalb 12B/1A) werden weitergereicht, ohne sie zu kennzeichnen. Vorschlag: Fixture mit `<PLAYLISTS>` + zwei `<TEMPO>`-Punkten ergänzen und die Deckung der Datei auf ≥90 % ziehen — das ist zugleich der beste Schutz gegen stumme Strukturänderungen.

## E. Funktionsumfang (Vorschläge, nach Nutzen/Aufwand)

1. **Undo/Redo-Historie als Liste** (der Undo-Ring existiert im Edit-Modell und ist per `Ctrl+Z/Y` bedienbar; ein Panel „Schritte" mit Klick auf einen Eintrag = Sprung in den Zustand — bei 48 App-Handlern der günstige Win für Nachvollziehbarkeit; Datensicherheit bleibt beim bestehenden Ring).
2. **Loops aus der Timeline heraus schneiden** und als `LOOP`-Segimenttyp sichtbar machen (Loop-Daten werden beim Schneiden bereits umgerechnet und erhalten, aber nicht editiert — `retimeLoops` ist fertig).
3. **Beatgrid-Raster-Auswahl (1/2 Takt … 4 Takte) auch für Clip-Drops** — Quantisierung existiert für Auswahl und Klonen (`button[title="Quantize Mode"]`), das Einfügen per Drag folgt dem Raster noch nicht durchgängig.
4. **Palette: Clip-Halsketten** (mehrere Clips aus derselben Quelle mit eigenem Fenster) und Duplizieren mit `Strg+Klick` — heute eine Karte pro Clip.
5. **Beim Export direkt in den Zielordner schreiben** statt nur `saveExportFile` (Desktop-Bridge) — plus „XML + WAV gemeinsam in Projektordner" als ein Schritt; Pfadschutz (`electron/pathGuard.cjs`, read-only-Garantie) ist vorhanden und muss nur mitbenutzt werden.
6. **Multi-Deck (C/D)** — das Deck-Modell ist bereits auf ein Deck plus Clip-Editor ausgelegt; die Edit-Projektion arbeitet spuren-, nicht deckbezogen, daher wäre ein zweites Deck vor allem UI-Arbeit an `ClipDeckView`.
7. **Provenienz-Prüfbericht als Datei** (JSON mit je Track: ANLZ-Variante, Bucketanzahl, PQTZ-Anzahl, Grid-Edit-Historie, `computeBufferChecksum`) — schließt die Lücke zum Supportfall „warum sieht die Kurve anders aus" und nutzt die vorhandene Prüfsummenfunktion `sha256-…`.

## F. Abhängigkeiten / Hygiene

* **Unbenutzt** (0 Referenzen in `src/`, `electron/`, `vite.config.ts`, `index.html`): `@google/genai`, `express`, `motion`, `dotenv`, `autoprefixer` (Prefixing übernimmt `@tailwindcss/vite`). `vite` steht doppelt in `dependencies` **und** `devDependencies`. Vorschlag: `npm rm @google/genai express motion dotenv autoprefixer` und `vite` nur als devDependency behalten — kleinere Installation, kleinere Supply-Chain, `npm ci` wird schneller. Absichtlich **nicht** in dieser Session ausgeführt, weil `package-lock.json` und damit der CI-Beweggrund geändert würden (erst nach Freigabe).
* Größte Lasten, die wirklich gebraucht werden: `lucide-react` (Import in 3+ Komponenten), `react`/`react-dom`, `tailwindcss` 4.
* `better-sqlite3-multiple-ciphers` ist `optionalDependencies` und wird in `electron/dbReader.cjs:100` lazily in `try/catch` geladen → ohne Modul startet die App sauber und meldet den fehlenden DB-Import auf Deutsch (Zeile 143). Genau deshalb funktioniert der Basis-Windows-Build ohne C++-Toolchain (siehe `BUILD_WINDOWS.md`); CI kompiliert ihn trotzdem (`rebuild:electron`), damit `master.db`/`exportLibrary.db` mit ANLZ-Auflösung pro Track funktionieren.

## G. CI / Release

* **Neu in dieser Session:** der Workflow hat jetzt einen vom Build **getrennten** `tests`-Job
  (ubuntu-latest **und** windows-latest: `npm ci` → `npm run lint` → `npm test` → `npm run coverage`).
  Er blockiert das Artefakt bewusst nicht, zeigt aber beide Ampeln am PR.
* **Warum das nötig war:** der erste PR-Build (12.09.) lief rot, *nachdem* `npm ci` erfolgreich durchgelaufen war — im
  `package.json` fehlten die neuen `devDependencies` (vitest, jsdom, @testing-library/*, c8), obwohl
  `package-lock.json` sie enthielt. `npm ci` installierte daraufhin genau diese Pakete nicht, und
  `tsc --noEmit` meldete „Cannot find module 'vitest'" nur in `tests/`. Lehre: **Manifest und Lock
  sind zwei Quellen, die mitgeführt werden müssen** — `npm ci --dry-run` im Pre-Push-Hook oder der
  `tests`-Job fängt das jetzt ab. (Die Dev-Dependencies sind wieder eingetragen, der Lock neu
  synchronisiert.)
* **Neu:** `tests/source-hygiene.test.ts` (A4) läuft in beiden CI-Betriebsystemen mit; die
  Suite wird vom Runner automatisch entdeckt (27 Skript-Suiten), ohne dass package.json angefasst
  werden muss — genau dafür ist `node tests/run-all.mjs` als `npm test` da.
* `npm run coverage` ist weiterhin kein Gate (der `tests`-Job misst, macht aber keinen Fehlschritt
  daraus). Vorschlag: Schwellwert im Coverage-Skript
  (`--fail-under=89` mit begründeter Ausnahme-Liste), damit die Zahl nicht heimlich sinkt.
* **Versionspolitik ist invertiert:** `main` hat `package.json` 0.4.20, die letzten Releases sind
  v0.5.10 (auf dem Tag stand 0.5.10). Der Commit `4acc0dc Versioning: einheitliches Schema
  (Semver, package.json als einzige Quelle)` liegt auf der 0.5-Linie und fehlt `main` — wieder
  aufgreifen und *vor* dem nächsten Taggen anwenden, sonst heißen Artefakte `…-0.4.20-…` während
  das Release v0.5.11 heißt.
* Linien-Zustand (mit `gh api repos/Airdox/airdox_editor/compare/main...v0.5.10` prüfbar): `main`
  ist 5 voraus / 26 zurück gegenüber `v0.5.10`. Auf der Tag-Linie liegen Fixe, die `main` nicht
  hat: `query_only`/`busy_timeout` für den `master.db`-Zugriff, Suche ausschließlich auf Partition
  `D:` (Nutzer-Vorgabe, `274c89e`), Single-Flight-DB-Load, asynchroner ANLZ-PPTH-Scan mit Cache
  und Fortschritt, „Mix Lab"-Mischvorschau (Stage 2), Gatekeeper-JSON-Bericht mit
  `scripts/waveform-gates.mjs`, drei Planungsdocs. Empfehlung: diese Punkte einzeln cherry-picken
  (`git cherry-pick -x <sha>` je Fix, jeweils mit eigenem Testlauf) statt die Linien zu mergen —
  ein Merge der 26 Commits würde `src/App.tsx` (+769 Zeilen Abweichung) und
  `electron/dbReader.cjs` (+655) gegeneinander auflösen müssen.

## Vorgeschlagene Reihenfolge (Roadmap)

| # | Schritt | Aufwand | Risiko | Warum zuerst |
| --- | --- | --- | --- | --- |
| 1 | A1 Logger-Kanäle + C2 `React.memo`/Playhead-Leaf + C3 sourcemap/chunks | 1 Tag | sehr gering | sofort spürbare Qualität/Performance, keine Architekturänderung |
| 2 | D1 Dithering/Peak-Handling + 24-Bit-Option | 1–2 Tage | gering (byte-feste Tests vorhanden) | Ausgabequalität ist das Verkaufsargument |
| 3 | B2 `waveform/painter.ts` | 1–2 Tage | gering-mittel | beseitigt drei parallel gepflegte Zeichenpfade |
| 4 | C1 Worker für Analyse/Export | 2 Tage | mittel | Import- und Export-Ruckler verschwinden |
| 5 | B1 App.tsx in vier Hooks + Reducer | 2–3 Sessions | mittel | größter Hebel, braucht die volle Testdecke als Netz |
| 6 | G CI-Testschritt + F Dependency-Purge | 0,5 Tag | gering | hält alle anderen Ergebnisse stabil |
| 7 | E Funktionsumfang (Punkte 1–3 zuerst) | je 1–2 Tage | gering | Nutzen für die Arbeit mit echten Sets |

## Was in dieser Session zusätzlich schon erledigt ist

* Testbasis: 203 vitest-Tests + 25 Skript-Suiten, `npm run coverage` mit **best-of-pipelines**-Merge (89,4 % Lines in `src/**`), Registry-Guard gegen „Suite läuft nie", `tests/helpers/appHarness.tsx` als gemeinsamer UI-Treiber (Beschriftungen nur noch ein Pflegeort).
* Sechs Produktfehler aus den Szenario-Tests behoben (Ablehnungs-Hinweis Drop, doppelte `Date.now()`-ID, CLONE-Knopf ohne Wirkung, Bars-Beschriftung 16× falsch, XML-Export-Crash bei leerem Modell, 1-ms-Timeline-Schrumpfung beim Fenster-Drop ans Ende) — Details und Belege: [`sessions/2026-09-12-testabdeckung.md`](sessions/2026-09-12-testabdeckung.md).
* Ordnung: `docs/` mit Lesereihenfolge und Session-Protokollen, echtes `README.md`, versionsfreie Build-Doku, `npm test` als ein entdeckender Runner statt 26-Glieder-Kette.
