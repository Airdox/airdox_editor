# Refaktorisierung – Statusbericht

**Stand:** 04.10.2026 · **Basis:** `main` @ `c08e96f` (PR #76 gemergt) ·
**Branch:** `arena/01a10410-airdox-editor` (auf `main` nachgezogen)
**Plan:** [`docs/REFACTORING_PLAN.md`](REFACTORING_PLAN.md) (freigegebene Roadmap, Phase 0–4)
**Freigaben des Auftraggebers:** eigene Stores statt zustand ✓ · ZIPs nur aus HEAD, keine History-Umschreibung ✓ · Phase 1 vollständig ✓

Dieser Bericht beschreibt, was seit der Freigabe umgesetzt wurde, mit welchem Nachweis, wo vom Plan
abgewichen wurde und was als Nächstes ansteht. Er ist die Fortschreibung zu Kapitel 6 des Plans.

---

## 1. Kurzfassung

Phase 0 (Messnetz) und Phase 1 (Transport, Zeichenschicht, Speicherlast, Code-Splitting, Aufräumen)
sind umgesetzt. Nachweis: `npm run verify` läuft vollständig grün – Typcheck, 75/75 Tests,
Produktionsbuild und beide Budgets (Bundle, Benchmark) in einem Befehl.

Die drei großen Wirkungen:

| Größe | vorher | jetzt | Nachweis |
|---|---|---|---|
| Startbundle (Entry + statische Importe) | 361,0 kB gzip / 1334,5 kB roh | **199,1 kB gzip / 668,3 kB roh** | `npm run budget` |
| Spiegel-Schreibvorgänge des Loggers (1.000 Einträge) | 1.000 (O(n) je Eintrag) | **40** | `npm run test -- --only logger-storage-batching` |
| Rechenzeit pro Wellenform-Frame (1920 Spalten, 18-s-Fenster) | 2,539 ms (Kaltstart) | **0,117 ms** (Minimum aus 5 Läufen) | `npm run bench` |
| React-Updates pro Sekunde bei Wiedergabe | ≈ 180 | **0** (Position geht am Renderer vorbei an den Canvas) | `tests/transport-playhead-driver.test.ts` |
| `App.tsx` | 4.870 Zeilen, 84 `useState` | **3.245 Zeilen, 73 `useState`** | `wc -l` |

---

## 2. Verifikationsstand (04.10.2026)

Auf GitHub (Linux-Runner, ohne native Module) zusätzlich bestätigt: PR #76, Job „Qualität (Linux)" grün.

```
npm run verify
  > npm run lint      →  tsc --noEmit, keine Fehler
  > npm test          →  77/77 bestanden, 4 übersprungen, 0 fehlgeschlagen (91,6 s)
  > npm run build     →  vite 6,11 s + stems-bridge + server.cjs
  > npm run budget    →  199,1 kB gzip / 668,3 kB roh  (Budget 260 / 900) ✓
```

Die 4 übersprungenen Tests sind Umgebungsgrenzen (ONNX-Runtime, PyTorch, Demucs im Sandkasten)
und haben mit dieser Arbeit nichts zu tun – dieselben 4 Sprünge gab es vor der Freigabe.

Ergänzend gemessen (nicht Teil von `verify`):

```
npm run bench        →  analyzeAudioBuffer(30 s)  6,74 ms  (Median 6,92)
                        analyzeAudioBuffer(300 s) 69,01 ms (Median 72,58)
                        1920 Spalten, 18-s-Fenster  0,117 ms (Median 0,141)
                        1920 Spalten, Full-Track    0,53 ms  (Median 0,545)
npm run bench:budget →  keine Budgetverletzung
```

> **Wichtige Messkorrektur:** Die Rohmessungen aus der Planungsphase (18,29 / 180,22 / 2,539 ms)
> waren JIT-Kaltstart-Artefakte. Der Benchmark wärmt jetzt auf und prüft das Minimum aus 5 Läufen;
> erst diese Zahlen sind reproduzierbar (Median weicht nur noch um 2–5 % ab, vorher Faktor 2–10).
> Als Budgetgrundlage sind die alten Werte damit unbrauchbar – die Budgets in `budgets.json` wurden
> entsprechend neu gesetzt und begründet.

---

## 2a. Zusammenführung mit `main` (parallele Sitzung)

Während dieser Arbeit hat eine **zweite Arena-Sitzung** auf `main` gemergt (PR #75, Commit `47bc212`,
„Playhead-Ebene trennen, Transport-Ref, echter SHA-256“) und dabei genau dieselben zwei Kerndateien
angefasst (`src/App.tsx`, `src/components/DetailWaveform.tsx`) – mit einem verwandten, aber flacheren
Ansatz. Der Branch wurde deshalb mit `main` zusammengeführt (`git merge origin/main`, 18 Konflikte in
zwei Dateien) und so aufgelöst, dass beide Beiträge erhalten bleiben:

| Beitrag der Parallelsitzung | Entscheidung |
|---|---|
| `src/utils/sha256.ts` – **echtes** SHA-256 über die Dateibytes (vorher ein nachgebauter FNV-Hash des linken Kanals, der sich „sha256“ nannte) | **übernommen**; `computeBufferChecksum` ist entfernt, `App.tsx` hasht jetzt die vollständigen Dateibytes parallel zum Dekodieren |
| `trackRevision` + `setTracks`-Wrapper – erzwingt ein Neuzeichnen der Basis-Ebene, wenn ein Edit den `AudioBuffer` **an Ort und Stelle** ändert (die Track-Identität bleibt dabei gleich) | **übernommen**; `DetailWaveform` hat dafür jetzt eine gleichnamige optionale Prop, die `markBase()` auslöst. Ohne sie wäre nach einem Edit die Wellenform stehen geblieben |
| Ruhigere Fehlermeldung beim fehlgeschlagenen Dekodieren (Ursache im Text statt fester Liste) | **übernommen** |
| `src/waveform/canvasLayers.ts` – eigener Zeichenpfad für die Playhead-Ebene | **übernommen und erweitert**: `drawPlayhead` ist jetzt die *einzige* Implementierung des Playhead-Strichs; die Detail-Wellenform ruft sie mit `clear: false` auf, weil sie am Frame-Anfang selbst leert (sonst würden Auswahl, Hover und Snap-Badge überschrieben). Der Test prüft beide Betriebsarten. |
| Gedrosselter React-Loop (30 Hz Zeit, 20 Hz Pegel, `currentTimeRef`) in `App.tsx` | **verworfen** – vom Transport-Store samt Frame-Treiber abgelöst: dort entstehen **0** React-Updates pro Frame statt 30–50, und der Pegelabfall bei Pause liegt im Treiber |
| `playheadCanvasRef` + zweiter Dauer-`rAF` im Detail-Waveform | **verworfen** – davon bleibt nur die geteilte Zeichenfunktion; gezeichnet wird über den Layer-Scheduler, der im Leerlauf gar nichts tut |
| `docs/REFAKTORISIERUNGSPLAN.md` (Plan der Parallelsitzung) | bleibt liegen; **dieser** Bericht und `docs/REFACTORING_PLAN.md` sind die für diese Sitzung maßgebliche Roadmap |

---

## 2a2. Merge-Stand

| PR | Inhalt | Zustand |
|---|---|---|
| #76 | Phase 0 + 1 vollständig, Phase 2 begonnen (WP-06 Schritte 1–4, 7) | **gemergt** als `c08e96f` (04.10.2026) |

Nach dem Merge auf `main`:

- **Linux-CI („Qualität"): grün**, 1 m 32 s.
- **Windows-Build: rot** – Ursache liegt **nicht** in diesem PR, sondern in
  `tests/stem-remote-worker-selftest.test.mjs` aus dem parallelen PR #78: Der Test vergleicht die
  Ausgabe des Python-Helfers (`colab/remote_worker.py`) mit dem Text „während der Rechnung". Auf
  Windows kommt die Ausgabe falsch dekodiert an (`w�hrend`), die Zusicherung scheitert. Belegt:
  schon der Merge von #78 (vor diesem Merge) fiel an derselben Stelle durch, während der Merge von
  #75 noch grün war. Zu beheben ist das im Test (Ausgabe explizit als UTF-8 lesen) oder im Helfer
  (Ausgabe erzwingt UTF-8) – ein eigener kleiner Folge-PR.

## 2b. Entscheidungen aus Kapitel 11 (geschlossen am 04.10.2026)

| # | Frage | Entscheidung | Stand |
|---|---|---|---|
| 1 | Eigene Stores oder zustand? | **Eigene Stores** (`useSyncExternalStore`), keine neue Abhängigkeit | umgesetzt |
| 2 | ESLint oder Biome? | **Biome** (Formatierung + Regeln in einem Werkzeug); ESLint bleibt als Alternative möglich | Phase 2 (WP-13) |
| 3 | happy-dom oder jsdom? | **happy-dom**, nur in den Tests, die es brauchen; Testframework bleibt | Phase 2–4 (WP-14) |
| 4 | HEAD bereinigen oder Historie umschreiben? | **Nur HEAD** – eine Umschreibung würde alle Klone und offenen PRs brechen | umgesetzt |
| 5 | Performance-Harness: Electron oder Playwright? | **Electron** (echte Zielumgebung, keine neue Abhängigkeit); Playwright optional in Phase 4 | Phase 4 (WP-14) |
| 6 | Phase 1: alle Quick Wins? | **Ja, alle drei** (Lazy-Modals, Budget, Split) | umgesetzt |
| 7 | Code-Freeze für `App.tsx` in Phase 2? | **Kein harter Freeze, aber weiche Absprache:** während Phase 2 keine parallele Sitzung auf `App.tsx`/`DetailWaveform.tsx` | organisatorisch |

Zur Begründung im Detail: [`REFACTORING_PLAN.md`](REFACTORING_PLAN.md), Kapitel 11.

## 3. Was umgesetzt ist (nach Arbeitspaket)

### WP-01 · Mess- und Sicherungsnetz (Phase 0) ✓
- `npm run verify` = Typcheck → Tests → Build → Budget, schlägt bei Regression fehl.
- `scripts/bench-waveform.mjs`: deterministisches Signal, Aufwärmlauf, Minimum aus 5 Läufen
  (`AIRDOX_BENCH_REPEATS`), `--json` und `--budget`.
- `scripts/check-bundle-budget.mjs`: liest `dist/.vite/manifest.json` und zählt **nur** den Entry-Chunk
  plus seine statischen Importe – Lazy-Chunks zählen nicht, sonst würde das Budget die Code-Splitting-
  Arbeit bestrafen.
- `budgets.json` mit begründeten Obergrenzen (Bundle, vier Benchmark-Fälle).
- `.github/workflows/quality-linux.yml`: der Job, der auf Linux läuft (bisher gab es nur Windows-CI) –
  Typprüfung, Tests, Build, Bundle-Budget, Benchmark-Budget in **1 m 6 s** (grün auf PR #76,
  <https://github.com/Airdox/airdox_editor/actions/runs/37163055339>).
- Baseline-Tag `perf-baseline-2026-10-03` gesetzt (zeigt auf `main` @ `eea1a94`, also den Stand **vor**
  der Refaktorisierung; noch nicht gepusht – `git push origin perf-baseline-2026-10-03`).

**Nebenbefund (Beleg, dass WP-01 seinen Zweck erfüllt):** Der neue Logger-Test hat einen echten,
seit Langem bestehenden Fehler gefunden – siehe Abschnitt 4.

### WP-02 · Transport-Store + Frame-Treiber (Phase 1) ✓
- `src/state/transportStore.ts`: eigener Store über `useSyncExternalStore`, kein zustand (Freigabe).
  `positionSec` wird pro Frame gesetzt, ohne React-Render; `meters` sind auf 20 Hz gedrosselt;
  `isPlaying` wechselt nur bei echten Zustandswechseln (vorher: 2 State-Updates pro Frame).
- `src/features/transport/playheadDriver.ts`: der einzige `requestAnimationFrame`-Loop der App.
  `App.tsx` enthält **keinen** `requestAnimationFrame`-Aufruf und kein `setInterval` für Positionen mehr.
- `tests/transport-playhead-driver.test.ts` (framework-frei, gestubbte Frame-Queue) belegt:
  120 Treiber-Ticks erzeugen 0 React-Commits, solange nur die Position läuft.
- Verbraucher umgestellt: `DetailWaveform` (Playhead über `subscribeTransport`), Anzeigen
  (`useThrottledPosition(100)`), Pegel (`useThrottledMeters(50)`).
- **Zwei Komponentenverträge haben sich dadurch geändert** (bewusst, Tests lesen Quelltext):
  `TrackHeader` nimmt keine `currentTime`/`getPositionSec` mehr von außen, `EditModeBar` keine
  `meterL`/`meterR`. Beide abonnieren selbst.
- Mid-Effekt-Kopplung entfernt: der MIDI-Effekt hing an `currentTime` und registrierte sich damit
  bei jedem Positionswechsel neu (bei 60 fps also 60 ×/s); ebenso der Keyboard-Handler, der in
  einem Effekt **ohne Dependency-Array** stand – jetzt `keyHandlerRef` + genau eine Registrierung.

### WP-03 · Visualisierungsschicht (Phase 1) ✓ (mit einer bewussten Verschiebung)
- `src/waveform/layerScheduler.ts`: trennt teure Basis (Wellenform, Grid, Parts, Cues) von
  günstigem Overlay (Playhead, Auswahl, Hover). Im Leerlauf wird **nichts** gezeichnet; der frühere
  Endlos-rAF, der dieselbe Szene weiterpinselte, ist weg. `tests/waveform-layer-scheduler.test.ts`.
- `DetailWaveform.tsx`: getrenntes Overlay-Canvas (`pointer-events-none`) über dem Basis-Canvas, das
  die Mausereignisse behält – die Interaktionspfade (Seek, Pan, Kontextmenü, Snap-Badge) blieben
  unverändert. HiDPI ist korrekt: `setTransform(dpr, 0, 0, dpr, 0, 0)` statt ignoriertem `devicePixelRatio`.
- Messung des Zeichenpfads: 0,117 ms pro Frame im 18-s-Fenster (Ziel aus der DoD: ≤ 0,5 ms) ✓.
  Die Aussage gilt für den Sampling-/Zeichenpfad der Spalten, nicht für GPU-Compositing.
- **Abweichung (begründet):** `React.memo` für die schweren Kinder wurde **nicht** gesetzt. `App.tsx`
  übergibt rund 92 Inline-Arrow-Props; ein `memo` wäre dadurch wirkungslos und würde nur
  Vergleichskosten erzeugen. Die Memoization der *Zeichnung* leistet der Layer-Scheduler, die
  Memoization der *Komponenten* gehört zu WP-06 (Callbacks stabilisieren), wo sie dann tatsächlich greift.

### Logger-Schreiblast (Phase-1-Punkt „Logger-Batching") ✓
- `src/utils/logger.ts`: Der localStorage-Spiegel wurde bisher pro Eintrag geschrieben – je Eintrag
  ein vollständiger `JSON.stringify` + `setItem` über bis zu 400 Einträge. Jetzt läuft ein Puffer
  (`STORAGE_WRITE_BATCH = 25`), `getStorageWriteCount()` macht die Last messbar; ERROR/FATAL und
  `flush(true)` (pagehide/beforeunload) schreiben weiterhin sofort.
- **Gefundener Fehler:** `persist()` rief `flush()` auch dann, wenn die Warteschlange über die
  Batch-Grenze wuchs, während bereits ein Flush lief. Da `flush()` während eines laufenden Requests
  früh zurückkehrt, blieb die Grenze dauerhaft überschritten – und danach rief **jede weitere
  Log-Zeile** `flush()` erneut auf. Ergebnis: bis zu 904 Schreibvorgänge für 1.000 Einträge.
  Behoben über `inFlightFlush`-Prüfung plus Nachziehen im `finally` des Flushes.
- `tests/logger-storage-batching.test.ts`: 1.000 Einträge → **40** Schreibvorgänge, plus Prüfungen für
  Sofortschreiben bei ERROR, `flush()`-Vollständigkeit und `clear()`.

### WP-15 · Aufräumen und Repo-Hygiene (Phase 1) ✓
- **Aus HEAD entfernt:** `airdox_editor_fix.zip` und `airdox_editor_fix_v2.zip` (2 × 13,1 MB = 26,2 MB
  Ballast, deren Inhalt längst im Quellbaum liegt). Historie wird nicht umgeschrieben (Freigabe).
- **Aus HEAD entfernt:** `bun.lock` (Toolchain ist npm, `package-lock.json` bleibt),
  `artifacts/stem-validation-15s/test15s_mixture.wav` (5,3 MB, per Validierungslauf reproduzierbar;
  `artifacts/**/*.wav` ist jetzt ignoriert, der Report bleibt versioniert).
- **Toter Code gelöscht:** `src/audio/stftSeparator.ts` (408 Z.), `src/audio/synthesizerTrack.ts` (165 Z.),
  `src/components/WaveformRenderer.tsx` (91 Z.), `src/utils/anlzParser.ts` (61 Z.),
  `src/fix.js`, `src/full_auto_fix.mjs`, `src/build_pipeline.py` – vorher per Importgraph geprüft.
- **31 Einmal-Skripte** aus dem Repo-Root nach `tools/legacy/` verschoben (`fix*.cjs`, `*.ps1`,
  `rb_*.py`, alter Python-/Inno-Setup-Pfad, `analysisPath.cjs` samt Test außerhalb des Runners …).
  Mit `tools/legacy/README.md`, das jede Gruppe und ihren Ersatz benennt.
- `code_analysis_out/` und `visualization.html` (Analyse-Werkzeug, per README selbst dokumentiert)
  liegen jetzt unter `tools/code_analysis/` statt im Root.

### WP-16 · Build & Release (Phase 1) ✓
- `vite.config.ts`: `build.manifest` (nötig für die Bundle-Messung) und `manualChunks`
  (`react-vendor`, `lucide`).
- `src/components/Modals/lazyModals.ts`: 14 Dialoge werden über `React.lazy` + `<Suspense>` geladen.
  Damit fällt der `three`-Baum (529 kB) aus dem Startbundle und lädt erst, wenn der 3D-Visualizer
  wirklich geöffnet wird. `bundledCollection` (10,6 MB Quelltext, 1,13 MB gzip) bleibt lazy.
- Die Modal-Chunks liegen bei 2,6–8,0 kB gzip – der Start lädt sie nicht.

### WP-14 · Test-Harness (vorgezogener Teil) ✓
Zwei neue Testarten, die es vorher nicht gab:
- `tests/app-render-smoke.test.tsx`: rendert die **gesamte** App serverseitig. Vorher war kein
  einziger Test in der Lage, eine der 36 Komponenten zu rendern; Fehler außerhalb der reinen Logik
  waren damit unsichtbar.
- Framework-freie Logiktests für Treiber und Scheduler (gestubbte `requestAnimationFrame`-Queue,
  Zähler-Doubles) im Stil der bestehenden Suite (`node:assert`, kein vitest/Playwright).

---

## 3a. Phase 2 · WP-06 `App.tsx`-Dekomposition (begonnen 04.10.2026)

Der Plan nennt neun Schritte. Umgesetzt sind die Schritte **1, 2, 3, 4 und 7** sowie die
Voraussetzung dafür (die reinen Modulfunktionen). `App.tsx` ist dadurch von **4.870 auf 3.245 Zeilen**
geschrumpft (−33 %), die Zahl der `useState`-Stellen von **84 auf 73**.

| Schritt | Was | Neuer Ort | Zeilen |
|---|---|---|---|
| 1 | Transport, Zoom, Ansicht, MIDI-Brücke | `features/transport/useTransportControls.ts`, `useMidiBridge.ts` | 326 |
| 2 | Einstellungen und ihre Persistenz | `state/settingsStore.ts` (+ neuer Test) | 204 |
| – | reine Projektfunktionen (Voraussetzung für 3/4) | `features/project/projectModel.ts` | 302 |
| 3 | Track-Import (ANLZ, Datenbank, Sammlung, Audiodatei) | `features/import/useTrackImport.ts` | 768 |
| 4 | Projekt speichern/öffnen, Datei-Laden | `features/project/useProjectFiles.ts` | 550 |
| 7 | Set-Aufnahme (Zustand + Ablauf) | `features/recorder/useRecorder.ts` | 312 |

**Vorgehen (wie im Plan gefordert):** jeder Schritt verschiebt, statt umzuschreiben; die Rümpfe der
Funktionen sind wörtlich übernommen. Abhängigkeiten kommen als Parameter herein und sind typisiert
(`TrackImportDependencies`, `ProjectFileDependencies`, `RecorderDependencies`). Nach jedem Schritt:
`tsc` grün und vollständige Testsuite.

**Was dabei aufgefallen ist:**

- Zwei der 20 Textvertrags-Tests lasen die Import-Handler aus `App.tsx`. Sie zeigen jetzt auf das neue
  Modul; die Verträge selbst (kein Dateidialog, ANLZ-Herkunft erzwungen, kein synthetischer
  Analysepfad, XML beim Ziehen abgelehnt) sind unverändert und grün.
- `interface ClipboardProvenance` stand **zwischen** den Import-Zeilen von `App.tsx` – leicht zu
  übersehen und ein Grund, warum die Datei schwer zu lesen war. Es liegt jetzt im Projektmodul.
- Der Aufnahme-Zustand (12 Schalter) und seine fünf Handler standen 200 Zeilen auseinander.
  Auffällig: der Ablauf ist ohne die Komponente vollständig lesbar.

**Verifikation nach jedem Schritt:** `tsc --noEmit` grün, **78/78 Tests** (+4 Umgebungs-SKIPs, ~96 s),
Build und Bundle-Budget grün (201,3 kB gzip / 674,9 kB roh).

**Als Nächstes (Reihenfolge des Plans):**

| Schritt | Was | Zeilen ca. |
|---|---|---|
| 5 | Edit-Befehle + Command-Registry (`COMMANDS`, 4 Eingabepfade auf dieselben IDs) | 1.050 |
| 6 | Stems (Separation, Mixer, Fern-/Colab-Pfad) | 1.070 |
| 8 | Chatbot-Switch → Command-Registry | 185 (Rest: 780) |
| 9 | Paletten/Deck-B/Cues | 300 |

Schritt 5 ist der Kern des Plans („die 781-Zeilen-Switch wird zu einer Map“) und macht `React.memo`
anschließend wirksam – bis dahin bleibt es bewusst weg (siehe Abschnitt 4).

---

## 4. Abweichungen vom Plan und Korrekturen

| Punkt im Plan | Befund bei der Umsetzung | Entscheidung |
|---|---|---|
| `rekordbox_export2.xml` (10,5 MB) als Repo-Ballast (Kap. 2/3) | Es ist **Laufzeitressource**: `package.json` → `extraResources` packt sie ins Produkt, `electron/main.cjs` liest sie als eingebettete Sammlung. | **Bleibt.** Ein Löschen hätte den DB-Extraktor ohne Nutzerdatei gebrochen. Nur die ZIP-Dateien flogen raus. |
| `reference/01–03*.png` als Ballast | Die Dateien sind der im Plan selbst benannte optische Vergleichsmaßstab für WP-03 (und `src/waveform/spectralColor.ts` verweist auf sie). | Bleiben (828 kB), Nutzen übersteigt die Ersparnis. |
| `tools/code_analysis`, `code_analysis_out`, `visualization.html` löschen | Das Analyse-Werkzeug ist mit README selbst dokumentiert und reproduzierbar. | Verschoben statt gelöscht (Root sauber, Wissen bleibt). |
| Logger-Batching als reine Optimierung | Dabei kam der Flush-Fehler aus Abschnitt 3 zum Vorschein (bis zu 904 statt 40 Schreibvorgänge). | Fehler behoben, Test sichert ihn ab. |
| `React.memo` in WP-03 | Setzt stabile Callbacks voraus, die erst WP-06 liefert. | Verschoben nach WP-06, Begründung oben. |

---

## 4a. Konsequenz aus der Zusammenführung

Zwei Dinge sind damit belegt und für die nächsten Phasen wichtig:

1. **Beide Sitzungen haben am selben Hotspot gearbeitet.** `App.tsx` und `DetailWaveform.tsx` sind
   nicht nur intern zu groß, sie sind auch die Dateien, in denen parallele Arbeit zwangsläufig
   kollidiert. Das erhöht die Priorität von **WP-06** (Dekomposition) und **WP-03/WP-06**-Grenzen:
   solange 84 `useState` und ~92 Inline-Callbacks in einer Datei liegen, ist jeder Merge ein
   manueller Eingriff.
2. **Die Zustandsführung ist jetzt eindeutig.** Nach der Zusammenführung gibt es genau eine Quelle für
   die Wiedergabeposition (Transport-Store) und genau zwei Wege, sie zu lesen: `subscribeTransport`
   (Canvas/Playhead) und `useThrottledPosition` (Anzeigen). Ein zweiter Pfad wie `currentTimeRef` darf
   nicht wieder entstehen – das ist als Regel in Abschnitt 5 des Plans aufzunehmen.

---

## 5. Nächste Schritte (Phase 2, in der Planreihenfolge)

1. **WP-06 · `App.tsx`-Dekomposition** (größter Hebel, `App.tsx` hat weiterhin ~4.860 Zeilen und
   84 `useState`): Command-Registry für die ~92 Inline-Callbacks → danach greift `React.memo`,
   Custom-Hooks für zusammengehörige Zustandsgruppen, Modals in eigene Container.
2. **WP-05 · Edit-Historie ohne Audiokopien** (Undo klont heute bis zu 30 × ganze `AudioBuffer`).
3. **WP-13 · ESLint + `strictNullChecks`** (gestuft, damit die 19 `any`/14 `as any` nicht alles blockieren).
4. **WP-04 · Analyse-Cache + Worker** (0 `new Worker` im Projekt heute).
5. **WP-08 · Speicher-Budgets** für `stemsCache` (heute ohne Eviction) und Audio-Engine-Nodes
   (`stop()` trennt keine Nodes).
6. **WP-14 · DOM-Testharness** für Interaktion/Canvas (der SSR-Smoke deckt nur das Rendern ab).

Offene Punkte, die bewusst **nicht** in Phase 1 gehörten: `strict: true` (Phase 3), Electron-Aufteilung
(Phase 4), Server-Router (Phase 3), Coverage-Bericht in CI (Phase 4).

---

## 6. So prüft man diesen Stand

```bash
npm ci                       # native Bindings ggf. mit: npm install --ignore-scripts
npm run verify               # Typcheck + 75 Tests + Build + Bundle-Budget
npm run bench                # Leistungszahlen (Minimum aus 5 Läufen)
npm run bench:budget         # Leistungsbudget
node scripts/run-tests.mjs --only logger-storage-batching
node scripts/run-tests.mjs --only app-render-smoke
node scripts/run-tests.mjs --only transport-playhead-driver
node scripts/run-tests.mjs --only waveform-layer-scheduler
```

Nicht in dieser Umgebung prüfbar (Windows/Electron/PyTorch): `test:rekordbox:runtime`,
`test:stems:live`, `test:stems:gate` – die vier Tests, die `npm test` als SKIP meldet.
