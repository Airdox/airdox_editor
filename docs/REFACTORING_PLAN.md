# Refaktorisierungsplan airdox_SMART_Editor

**Stand:** 03.10.2026
**Basis-Commit:** `eea1a94` (Merge PR #74, Branch `main`)
**Gegenstand:** Wartbarkeit, Performance-Stabilität und -Geschwindigkeit
**Umfang der Analyse:** `src/**` (127 Dateien), `electron/**` (13), `server.ts`, `tests/**` (75 Suiten), Build-Kette (`vite.config.ts`, `package.json`, CI)

---

## 0. Auftrag, Vorgehen, Nicht-Ziele

### 0.1 Vorgehen der Analyse

Alle Aussagen in diesem Plan sind **gemessen oder am Code belegt** (Datei:Zeile). Verwendete Methoden:

| Methode | Werkzeug |
|---|---|
| Zeilen-/Strukturmetriken | `wc`, `grep`, eigenes Auswertungsskript über `src/App.tsx` |
| Typprüfung | `npx tsc --noEmit` (grün, 11,6 s) |
| Testbaseline | `node scripts/run-tests.mjs --serial` → **71/71 grün, 4 Skip, 93,2 s** |
| Bundle-Analyse | `npx vite build` + gezielter `esbuild`-Lauf über den `three`-Importpfad |
| Laufzeitmessung | `npx tsx`-Benchmark für `analyzeAudioBuffer` und die Wellenform-Spaltenberechnung |
| Abdeckungs-Mapping | Kreuzverweis aller `src`-Module gegen `tests/**` |
| Toter Code | Import-Analyse über `src`, `electron`, `tests`, `scripts`, `server.ts` |

> Hinweis zur Umgebung: `better-sqlite3-multiple-ciphers` ließ sich in der Audit-Umgebung nicht nativ bauen (Netzsperre) → `npm install --ignore-scripts`. Alle Electron-/SQLCipher-Pfade wurden daher **statisch** auditiert, die TypeScript-/Test-/Bundle-Messungen liefen echt.

### 0.2 Nicht-Ziele dieses Plans

- **Keine** neuen Funktionen, keine UI-Redesigns, keine Rekordbox-Formatweiterentwicklung.
- **Keine** Änderung an den fachlichen Garantien: Original bleibt read-only, ANLZ-/DB-Werte schlagen Schätzwerte, Kausalität von Edits (siehe `VORHABEN.md`, `docs/PROJECT_ROADMAP.md`).
- **Keine** Dependency-Migration (React 19, Vite 6, Express 4 bleiben). Neue Dev-Abhängigkeiten nur dort, wo der Nutzen belegt ist (Kapitel 11: Entscheidungen).

---

## 1. Management Summary

### 1.1 Die fünf Kernbefunde

1. **`src/App.tsx` ist ein Monolith** – 4.793 Zeilen, 87 `useState`, 46 `useCallback`, 51 Imports, größter Einzelblock **781 Zeilen** (Chatbot-Aktions-Switch). Jede Änderung berührt die Datei, in der alles hängt; jede Zustandsänderung rendert potenziell den kompletten Baum.
2. **Der Playback-Loop erzeugt Dauerlast** – ein `requestAnimationFrame`-Loop setzt **3 React-States pro Frame** (`currentTime`, `meterL`, `meterR`) → ~180 State-Updates/s → vollständige Re-Renders der App inkl. 1.390-Zeilen-Canvas-Komponente. Zusätzlich läuft der Canvas-Render-Loop **dauerhaft weiter, auch im Leerlauf**, und zeichnet bei jedem Prop-Wechsel neu.
3. **Speicher wird nicht bewirtschaftet** – Undo/Redo hält **bis zu 30 vollständige `AudioBuffer`-Kopien** (5-Minuten-Stereo-Track ≈ 105,8 MB je Snapshot → bis ≈ 3,1 GB), der Stem-Cache ist **unbegrenzt** und doppelt verschlüsselt, der Logger parst+schreibt **pro Log-Zeile** den kompletten localStorage-Puffer synchron.
4. **Schwere Arbeit läuft auf dem Hauptthread** – 10,5-MB-XML-Import (DOMParser), komplette Wellenform-Analyse und Edit-Renderings laufen ohne Web Worker; es gibt im gesamten `src` **keinen einzigen** `new Worker`/`worker_threads`-Einsatz.
5. **Qualitätssicherung greift zu kurz** – **48 von 120 `src`-Modulen** sind vom Testbestand aus nicht erreichbar (Importgraph-Analyse), darunter **35 der 36 Komponenten** und zentrale Module wie `audioEngine.ts`, `recordingProcessor.ts`, `useEditAssistant.ts`. `strict` ist in `tsconfig.json` **nicht** aktiv, es gibt **keinen** Linter, keine Coverage-Schwelle, kein Performance-Budget und CI nur für Windows.

### 1.2 Die drei Quick Wins (Phase 1, ≤ 1 Woche, hohe Wirkung, kleines Risiko)

| # | Maßnahme | Wirkung | Aufwand |
|---|---|---|---|
| Q1 | Playhead/Meter aus React-State in einen Store mit `useSyncExternalStore` verlagern; Canvas/Header selektiv subscriben | ~180 Full-App-Renders/s → 0; UI bleibt bedienbar, während Audio läuft | 1–2 Tage |
| Q2 | Canvas in **Basis-Layer** (Waveform/Beatgrid/Phrasen) und **Overlay-Layer** (Playhead/Selection/Hover/Cues) trennen; Leerlauf ohne Repaint | Frame-Kosten von ~2,4–4,0 ms (gemessen) auf < 0,5 ms; Idle-CPU gegen 0 | 1–2 Tage |
| Q3 | `three` per `React.lazy` aus dem Hauptbundle lösen + `manualChunks`; Logger-Schreibvorgänge bündeln | Hauptbundle 1.371 kB → ~830 kB roh (≈372 → ≈235 kB gzip); Logging-Kosten O(n) → O(1) | 0,5–1 Tag |

### 1.3 Zielbild in einem Satz

Die App wird in **reine Domänenlogik (testbar, ohne React)**, **eine explizite Zustandsschicht (Stores je Fachbereich)** und **dünne, memoisierte Präsentationskomponenten** zerlegt; Audio-Zeit und Meter laufen **außerhalb von React** über einen Frame-Treiber direkt in Canvas/DOM, und der Editzustand hat genau **eine Wahrheit** (Segmente + Cues), aus der alle abgeleiteten Werte (Arbeitsbuffer, Analyse, Dauer) deterministisch materialisiert werden.

---

## 2. Baseline – die Zahlen, gegen die wir messen

| Kennzahl | Wert | Quelle/Beleg |
|---|---|---|
| Quellcode (TS/TSX/CJS) in `src`, `electron`, `server.ts` | **53.434 Zeilen** | `find` + `wc -l` |
| `src/App.tsx` | **4.793 Zeilen / 200.831 Bytes** | `wc` |
| Komponenten im Hauptbaum | 36 Rendering-Dateien, 12.535 Zeilen | `src/components/**` |
| `useState` / `useEffect` / `useCallback` / `useMemo` in `App.tsx` | **87 / 12 / 46 / 3** | `grep` |
| Größter Block in `App.tsx` | 781 Zeilen `handleExecuteChatbotAction` | Auswertungsskript |
| Props von `MenuBar` / `DetailWaveform` / `DeckStemsControl` | 40 / 37 / 32 | Interface-Member |
| `React.memo` im gesamten `src` | **0** | `grep` |
| Web-Worker-Nutzung im Renderer | **0** | `grep 'new Worker'` |
| Tests (Suiten / Zeilen) | 75 / 15.443 | `tests/**` |
| Teststatus Baseline | **71 bestanden, 4 übersprungen, 0 fehlgeschlagen (93,2 s serial)** | `node scripts/run-tests.mjs --serial` |
| `tsc --noEmit` | grün (mit `strict: false`) | `npm run lint` |
| Explizite `: any` / `as any` / `@ts-ignore` in `src` | 19 / 14 / 3 | `grep` |
| Vite-Hauptchunk JS | **1.371,36 kB (372,58 kB gzip)** | `npx vite build` |
| `three`-Anteil (einziger Importpfad) | **≈ 536 kB min (≈ 138 kB gzip) ≈ 39 %** | `esbuild`-Messlauf |
| Lazy-Chunk `bundledCollection` (10,5-MB-XML als `?raw`) | 10.618,09 kB (1.131,52 kB gzip) | `npx vite build` |
| CSS-Chunk | 102,13 kB (16,25 kB gzip) | dito |
| `analyzeAudioBuffer` | **20 ms/30 s** bzw. **77 ms/300 s** Track | Benchmark (Node 22, tsx) |
| 1 Frame Canvas-Repaint (1.920 Spalten, 18-s-Fenster) | **2,41 ms**; Full-Track-Fenster **3,97 ms** | Benchmark |
| Modulgrößen Hotspots | `DetailWaveform` 1.390 · `editingEngine` 1.253 · `remoteStemJobService` 1.207 · `stemEngine` 1.207 · `stemJobService` 1.045 · `server.ts` 976 · `electron/main.cjs` 915 | `wc -l` |
| `.git`-Größe / eingecheckte ZIPs | 26 MB / 2 × 13,08 MB (`airdox_editor_fix.zip`, `_v2.zip`) | `du`, `git ls-files` |
| CI | nur `.github/workflows/windows-build.yml` | – |

---

## 3. Befunde im Detail

Priorisierung: **P0** = sofort (Stabilität/Dauerlast), **P1** = als Nächstes (Wartbarkeit/Kernrisiken), **P2** = danach (Hygiene/Ausbau).

### 3.1 Architektur & Wartbarkeit

#### B1 – `App.tsx` als Alles-Orchestrator (P1)
**Beleg:** `src/App.tsx:404–539` (87 States in einem Component-Scope), `src/App.tsx:1944` (Undo-Snapshot), `src/App.tsx:3061` (`handleTrackImport`, 372 Zeilen), `src/App.tsx:3504` (`handleOpenProject`, 348 Zeilen), `src/App.tsx:4014–4793` (`handleExecuteChatbotAction`, 781 Zeilen), ≈92 Inline-Arrow-Props im JSX.
**Wirkung:** Jede Änderung an Import, Export, Stems, Recording, Chatbot oder Transport landet in derselben Datei. Merge-Konflikte bei Parallelarbeit sind strukturell garantiert. Der Chatbot-Switch dupliziert die Fachlogik, die Menü/Keyboard/MIDI bereits besitzen – drei Einstiegspunkte mit potenziell abweichendem Verhalten.
**Konsequenz:** Feature-Hooks + Command-Registry (WP-06).

#### B2 – Fachlogik an vier Einstiegspunkten dupliziert (P1)
**Beleg:** Edit-Befehle als Keyboard-Shortcuts (`App.tsx:3889 ff.`), MIDI-Aktionen (`App.tsx:1659 ff.`), Menü/Toolbar (`App.tsx:4270 ff.`) und Chatbot-Switch (`App.tsx:4014 ff.`). Die Tests `tests/edit-command-contracts.test.ts` und `tests/edit-command-matrix.test.ts` definieren den Vertrag bereits – der Code hält ihn nur durch Disziplin.
**Wirkung:** Jede Regeländerung (z. B. Marker-Grenzfall, Quantisierung) muss an 4 Orten nachgezogen werden.
**Konsequenz:** Ein `CommandRegistry`-Modul als **einziger** Ausführungspfad (WP-06).

#### B3 – Doppelte/abweichende Facheinheiten (P2)
**Beleg:**
- `clamp()` in `src/audio/editingEngine.ts:99` **und** `src/waveform/analysisComposer.ts:72`
- `timeToSampleFloor()` in `src/audio/audioEngine.ts:21` **und** `src/audio/editingEngine.ts:104`
- `dbToLinear()`/`linearToDb()` in `src/audio/recordingProcessor.ts:30,34` **und** `src/stems/mixEffects.ts:30,34`
- `sha256Bytes()` in `src/stems/remote/remoteStemJobService.ts:111` **und** `src/stems/wavIo.ts:33`
- Medien-Pfad-Vergleich: `areSameMediaPath()` in `App.tsx:274–318` spiegelt bewusst `isSameMediaPath()` aus `electron/masterDbGate.cjs` (Kommentar im Code)
- ANLZ-Pfadauflösung: `analysisPath.cjs` (Root) und `electron/analysisRegistry.cjs` + `electron/masterDbGate.cjs`
- Legacy-Parser: `src/utils/anlzParser.ts` neben `src/rekordbox/anlzParser.ts`
**Wirkung:** Divergenz-Risiko bei Windows-Pfaden, Sample-Epsilon und dB-Rechnung — genau die Stellen, an denen „nur manchmal“-Fehler entstehen. Der Root-`analysisPath.cjs`-Test wird vom Runner **nicht** ausgeführt (er liegt außerhalb von `tests/`).
**Konsequenz:** je ein Modul pro Konzept + Paritätstest (WP-10).

#### B4 – Toter Code und Root-Clutter (P2)
**Beleg (Import-Analyse über `src`, `electron`, `tests`, `scripts`, `server.ts`):**
- `src/audio/stftSeparator.ts` (408 Zeilen) – **null Referenzen**
- `src/audio/synthesizerTrack.ts` (165) – **null Referenzen**
- `src/components/WaveformRenderer.tsx` (91) + `src/utils/anlzParser.ts` (61) – Referenz nur aufeinander, sonst nirgends
- Root: `fix.cjs`, `fix-typo.cjs`, `fix_context_syntax.cjs`, `fix_and_force_push.cjs`, `master-fix-and-push.cjs`, `full_auto_fix.mjs`, `clean_fix.cjs`, `diagnose_and_fix.ps1`, `final_fix.ps1`, `patch_masterDbGate.ps1`, `fix_sqlcipher.ps1`, `collect_for_claude.ps1`, `setup-installer-pipeline.cjs`, `patch_app.py`, `src/fix.js`, `src/full_auto_fix.mjs`, `src/build_pipeline.py`, `build_pipeline.py`, `build_installer_only.py`, `main.py`, `rb_*.py`, `waveform_renderer.py`, `test_analysis.ts`, `analysisPath.cjs` + `analysisPath.test.cjs`, `anlz-mismatch-diagnose.patch`, `fix-package.txt`, `metadata.json`, `visualization.html`, `code_analysis_out/**`
- Eingecheckt: `airdox_editor_fix.zip` und `airdox_editor_fix_v2.zip` (je 13,08 MB) im HEAD; 5 × 1,07 MB WAV-Fixtures plus 5,29-MB-Artefakt
**Wirkung:** `src/fix.js` enthält hartkodierte Windows-Pfade („`C:\Users\p_kro\airdox_editor`“) und wird bei Suchen nach Fehlerursachen gefunden. Die Root-Skripte werden ausschließlich von anderen Altlasten referenziert (Inhalte der beiden ZIPs, `code_analysis_out/graph.json`) oder in Dokumentation erwähnt (`metadata.json` in `docs/STEM_SEPARATION_ENGINE.md`) – kein Build-, Test- oder Laufzeitpfad nutzt sie. Die ZIPs im HEAD kosten Klonzeit und Repo-Größe, ohne Nutzen für Build oder Tests.
**Konsequenz:** Löschen bzw. nach `tools/legacy/` verschieben; ZIPs aus dem HEAD entfernen (WP-15).

#### B5 – Typsicherheit und Regelwerk ausgeschaltet (P1)
**Beleg:** `tsconfig.json` setzt **kein** `strict`, kein `noUncheckedIndexedAccess`, kein `noImplicitOverride`; `npm run lint` ist identisch mit `tsc --noEmit`; keine ESLint-/Prettier-/Biome-Konfiguration im Repo (`ls` + `grep package.json`). In `src` 19 × `: any`, 14 × `as any`, 3 × `@ts-ignore`, 5 × `: any` in `server.ts`.
**Wirkung:** `null`/`undefined`-Pfade (AudioBuffer, TrackModel, Analyse) sind typseitig unsichtbar; die drei Quellen, die real abstürzen können (Fenster geschlossen, Track gewechselt, Buffer noch nicht dekodiert), sind genau die `any`-Stellen. `react-hooks/exhaustive-deps` hätte zwei reale Bugs (B7, B8) verhindert.
**Konsequenz:** gestufte Aktivierung + Linter (WP-13).

#### B6 – Electron- und Server-Schicht als Einzeldateien (P2)
**Beleg:** `electron/main.cjs` 915 Zeilen mit **27 `ipcMain.handle`-Kanälen** in einer Datei (u. a. Audio-Datei lesen, echten WAV-Export schreiben, Projektdatei öffnen, Logs); `electron/masterDbGate.cjs` 731 Zeilen; `server.ts` 976 Zeilen mit ~25 Routen, `express.json({ limit: '500mb' })` in `server.ts:267,270`, Chat-Endpunkt `server.ts:499–633` plus Offline-Fallback `server.ts:675–976`.
**Wirkung:** IPC-Vertrag, Dateisystemzugriff und Fensterverwaltung sind schwer getrennt prüfbar; die 500-MB-JSON-Limits halten komplette WAV-Sätze als geparste Strings im Speicher (doppelt: String + Buffer) statt zu streamen.
**Konsequenz:** IPC-/Routen-Split je Domäne, Streaming statt JSON-Body (WP-11, WP-12).

### 3.2 Performance & Reaktivität

#### B7 – Drei React-State-Updates pro Frame (P0)
**Beleg:** `src/App.tsx:1023–1049`:
```ts
const updateLoop = () => {
  if (audioEngine.getIsPlaying()) {
    setCurrentTime(time); setMeterL(...); setMeterR(...);
    if (time > viewOffset + viewDuration * 0.9) setViewOffset(...);   // ändert die Effect-Deps!
  } else { setMeterL(...); setMeterR(...); }
  animId = requestAnimationFrame(updateLoop);
};
```
**Wirkung:** Bei 60 fps sind das ~180 State-Updates/s. Jedes Update rendert `App` neu – inklusive `MenuBar` (40 Props), `DeckStemsControl` (32), `DetailWaveform` (37) ohne jede Memoisierung. Zusätzlich: `viewOffset` wird innerhalb des Loops gesetzt, hängt aber selbst in der Dependency-Liste des Effekts (`[viewOffset, viewDuration]`) → der Loop wird beim Auto-Scroll **jeden Frame abgerissen und neu registriert**.
**Konsequenz:** Frame-Treiber außerhalb von React + Store (WP-02).

#### B8 – Zwei Effekte mit fatalen Abhängigkeiten (P0)
**Beleg:**
- Keyboard-Effekt **ohne** Dependency-Array: `src/App.tsx:3889–3950` – der Effekt endet in `Z. 3949/3950` auf `});` ohne zweites Argument. Dadurch laufen `window.addEventListener('keydown', …)` **und** `removeEventListener` bei **jedem** Render (also bei jeder State-Änderung).
- MIDI-Effekt mit `currentTime` in den Abhängigkeiten: `src/App.tsx:1710` → bei Wiedergabe 60 ×/s `midiManager.init()`, `unsubscribe`/`subscribe`-Churn.
**Wirkung:** Messbarer Overhead im Hot Path; im Falle des MIDI-Effekts zusätzlich die Gefahr verlorener/doppelter Events während der Umschaltfenster.
**Konsequenz:** Feste Dependency-Listen, stabile Handler über Store/Refs; Linter-Regel verhindert Rückfall (WP-03, WP-13).

#### B9 – Canvas-Loop kennt keinen Leerlauf und zeichnet doppelt (P0)
**Beleg:** `src/components/DetailWaveform.tsx:202–726`. Der Effekt ruft `render()` sofort auf (Z. 716) und plant am Ende jeder Zeichnung den nächsten Frame (`animId = requestAnimationFrame(render)`, Z. 714; ebenso im Leerzustand Z. 290). Dependency-Liste enthält `currentTime`, `viewOffset`, `viewDuration`, `hoveredTime` (Z. 718–727).
**Wirkung:** (a) Bei Wiedergabe startet der Effekt jeden Frame neu (Cleanup + Neuaufbau der Zeichnung); (b) nach dem letzten Prop-Wechsel **läuft der rAF-Loop unbegrenzt weiter** und zeichnet dieselbe Szene mit ~2,4–4,0 ms pro Frame (gemessen) – auch wenn die Maus stillsteht und die Wiedergabe pausiert. (c) `hoveredTime` wird bei jedem `mousemove` gesetzt (`Z. 782`) → zusätzlicher Re-Render + Effektneustart pro Mausbewegung.
**Nebenbefund (Qualität):** `updateCanvasSize` (Z. 145–175) setzt `canvas.width = rect.width` **ohne `devicePixelRatio`** – auf HiDPI-Displays wird die Wellenform unscharf, 1-px-Rekordbox-Linien werden zu 2-px-Bändern.
**Konsequenz:** Layer-Trennung, Dirty-Flags, DPR-Korrektur, Hover über Ref + rAF statt State (WP-03).

#### B10 – Kein Code-Splitting, `three` im Startpfad (P1)
**Beleg:** `vite.config.ts` (35 Zeilen) hat **kein** `build.rollupOptions.manualChunks`; `MultiLayer3DVisualizer.tsx:2` ist der einzige `three`-Import und wird über `ExportModal` → `MultiLayerRenderInspector` **statisch** in `App.tsx` gezogen.
**Wirkung:** ≈536 kB min (≈138 kB gzip) davon liegen im Startchunk, obwohl sie erst beim Öffnen eines Modals gebraucht werden. Insgesamt 1.371 kB roh / 372,58 kB gzip für den ersten Frame.
**Konsequenz:** `React.lazy` + `manualChunks` + Budget (WP-16).

#### B11 – Logging kostet mehr als die geloggte Arbeit (P1)
**Beleg:** `src/utils/logger.ts:484–500`: **pro Eintrag** `localStorage.getItem` → `JSON.parse` → `push` → `slice(-400)` → `JSON.stringify` → `setItem` (synchron, Main-Thread). Zusätzlich globales `fetch`-/`XHR`-/`console`-Wrapping (`Z. 244–340`) und ein 3-s-Flush-Intervall (`Z. 221`) mit Batch-Größe 50 (`Z. 77`).
**Wirkung:** Jede Log-Zeile kostet O(400) Parse- und Serialize-Arbeit plus synchronen Storage-Write; in Phasen mit vielen Einträgen (Import, Separation, Fehlerkaskade) ist das ein Ruckel-Verstärker.
**Konsequenz:** Write-behind-Puffer, Frame-/Idle-Flush, größenbasiertes Ringkriterium (WP-08).

#### B12 – Hauptthread blockierende Analyse- und Importpfade (P1)
**Beleg:** kein Worker im Renderer (`grep 'new Worker'` = 0). `analyzeAudioBuffer` (`src/waveform/analyzer.ts:11`) läuft bei jedem Edit, Undo/Redo und Clip-Import; `parseRekordboxXmlAsync` (`src/rekordbox/xmlParser.ts`) parst den 10,5-MB-Export mit `DOMParser` auf dem Main-Thread (nur `setTimeout(20 ms)` zwischen den Phasen für das Progress-Modal).
**Messung:** Analyse ist **nicht** der Durchsatz-Engpass (20 ms/30 s, 77 ms/300 s Track) – sie ist ein **Latenz**-Problem (77 ms am Stück plus GC sind mehrere verworfene Frames) und wird mehrfach pro Edit aufgerufen (`App.tsx:1542, 1993, 1999, 2035, 2041, 3582, 3691`).
**Wirkung:** Ruckeln beim Import/Editieren; UI ohne Rückmeldung während des XML-Parsings großer Sammlungen.
**Konsequenz:** Analyse-Cache + Worker-Auslagerung mit Chunking (WP-04).

### 3.3 Speicher & langfristige Stabilität

#### B13 – Undo/Redo hält bis zu ~3 GB Audio im Speicher (P0)
**Beleg:** `src/App.tsx:1944–1958` (Snapshot mit `cloneAudioBuffer`), Grenze 30 Einträge (`prev.slice(-30, …)`), weitere Kopien in `handleRedo`/`handleClear` (`Z. 1973, 2016`).
**Rechnung:** 5-min-Stereo @ 44,1 kHz = 300 s × 44.100 × 4 Byte × 2 Kanäle = **105,8 MB** je Snapshot. 30 Snapshots = **≈ 3,1 GB** plus Redo-Stack. Undo/Redo existiert doppelt (Audio + Segmente), obwohl Audio aus den Segmenten rekonstruierbar ist.
**Wirkung:** OOM/GC-Stottern genau in langen Editing-Sessions; auf 8-GB-Maschinen ist das der wahrscheinlichste „Editor friert ein“-Grund.
**Konsequenz:** Snapshot ohne Audio + bytebasiertes Limit (WP-05).

#### B14 – Unbegrenzte Caches (P1)
**Beleg:** `src/audio/stemEngine.ts:277–300`: `stemsCache: Map<string, TrackStems>` ohne Obergrenze; jeder Track wird **zweifach** eingetragen (`sha256` + `trackId`). `TrackStems` enthält 4 vollständige `AudioBuffer` → ~420 MB pro 5-min-Track. Daneben `stemEngine`-Status-Cache, `availabilityCache`, `SeparationCache` (Dateiebene, mit Integritätsprüfung – vorbildlich) und `analysis`-Daten im `TrackModel`.
**Wirkung:** Speicher wächst monoton mit der Zahl der im Projekt besuchten Tracks; kein Verdrängungskriterium, keine Sichtbarkeit in der Diagnose.
**Konsequenz:** LRU mit Byte-Budget + Diagnose-Kennzahl (WP-08).

#### B15 – 500-MB-JSON-Kanäle und ungechunkte Pufferpfade (P2)
**Beleg:** `server.ts:267,270` (`express.json({ limit: '500mb' })`), `server.ts:129` (1 MB), `server.ts:633` (8 MB). Stems-WAVs gehen als JSON-Body/Base64 oder `Uint8Array` durch IPC (`electron/main.cjs:434`, `:807`).
**Wirkung:** Spitzenlast beim Trennen/Exportieren; doppelte Kopien (JSON-String + geparster Buffer) im Main-Prozess und im Renderer.
**Konsequenz:** Streaming-Endpunkte/Dateipfad-Handoff, Limits senken (WP-12).

### 3.4 Qualitätssicherung

#### B16 – Abdeckungslücken genau dort, wo die Risiken liegen (P1)
**Beleg (Importgraph-Analyse: welche `src`-Module sind von `tests/**` aus direkt oder transitiv erreichbar):** 72 von 120 Modulen sind erreichbar, **48 nicht** – darunter **35 der 36 Komponentendateien** sowie:
`src/App.tsx`, `src/main.tsx`, `src/audio/audioEngine.ts`, `src/audio/recordingProcessor.ts`, `src/audio/stemEngineInstaller.ts`, `src/hooks/useEditAssistant.ts`, `src/rekordbox/bundledCollection.ts`, `src/utils/anlzParser.ts`, `src/stems/runtime/errors.ts`, `src/stems/runtime/types.ts`, `src/types/chatbot.ts` (+ die drei toten Dateien aus B4).
Ein Teil davon ist trivial (Typen, Fehlerklassen) – die riskanten sind `audioEngine`, `useEditAssistant` und der komplette UI-Baum: `tests/clip-waveform-detail.test.ts` prüft Canvas-Code **textbasiert**, nicht im Browser/DOM.
Positiv: Der Testbestand ist für ein Projekt dieser Größe außergewöhnlich (75 Suiten, 15.443 Zeilen, u. a. 11.000-Track-Import, Gate-Hardening, Edit-Kausalität).
**Wirkung:** Refaktorisierung ohne Charakterisierungstests ist riskant; die vorhandenen Tests decken Logik, aber kaum UI-Verhalten und keine Performance ab.
**Konsequenz:** DOM-Testharness, Perf-Budgets, Coverage-Schwelle (WP-14).

#### B17 – CI prüft nur Windows, ohne Lint/Coverage/Budget (P1)
**Beleg:** `.github/workflows/windows-build.yml`: `npm ci` → `rekordbox:native:ensure` → `npm run build` → `npm test` → NSIS-Build. Kein Linux-Job, kein Lint, keine Coverage, kein Bundle-Budget, keine Perf-Schwelle.
**Wirkung:** Regressionsschutz hängt allein an 93 s Testlauf; Performance- und Bundle-Regressionen bleiben unsichtbar. Der Testlauf ist seriell – daher die 93 s (parallel deutlich schneller, siehe Runner `--serial`).
**Konsequenz:** Zusätzlicher Linux-Job + Budget-Gate (WP-01, WP-16).

---

## 4. Zielarchitektur

### 4.1 Schichten und Verantwortlichkeiten

```
┌──────────────────────────────────────────────────────────────────────┐
│ features/*  (UI-Flows, Hooks)                                        │
│   transport · editing · palette · stems · import · recorder · chat   │
│   – sprechen nur über Commands mit der Domäne, halten keinen Audio-  │
│     Buffer im React-State, sind einzeln testbar                      │
├──────────────────────────────────────────────────────────────────────┤
│ state/*  (Stores, useSyncExternalStore)                              │
│   projectStore (Tracks, Segmente, Cues, Historie)                    │
│   transportStore (isPlaying, positionSec, loop, meters)              │
│   settingsStore (Persistenz an EINER Stelle)                         │
├──────────────────────────────────────────────────────────────────────┤
│ domain/*  (rein, ohne React/DOM, 100 % testbar)                      │
│   timeline.ts  (Zeit↔Sample, Epsilon, Snap)                          │
│   editGraph.ts (Segmente → Renderplan)                               │
│   editCommands.ts / commandRegistry.ts (ein Ausführungspfad)         │
│   analysis/* (Analyse, Cache-Keys)                                   │
├──────────────────────────────────────────────────────────────────────┤
│ audio/*  (Web-Audio-Adapter, einziger Ort mit AudioContext)          │
│   playbackEngine.ts (Nodes, Lifecycle, Gain-Plan, Position)          │
├──────────────────────────────────────────────────────────────────────┤
│ platform/*  (Desktop-IPC vs. HTTP-Fallback, eine API-Fläche)         │
│   desktopBridge.ts · httpFallback.ts · contracts.ts                  │
├──────────────────────────────────────────────────────────────────────┤
│ io/*  (Dateien, XML, DB, Projekte, Export)                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 Verbindliche Regeln (werden per Lint/Review/Tests erzwungen)

1. **Eine Wahrheit:** `workingSegments` + `cues` sind kanonisch. `workingAudioBuffer`, `analysis`, `duration` sind **abgeleitet** und werden ausschließlich über `deriveProjectState(track, segments, source)` materialisiert. Kein Code setzt Dauer oder Analyse „von Hand“.
2. **Kein `AudioBuffer` in React-State oder Props.** Audio liegt im Engine-/Cache-Besitz; UI bekommt Kennzahlen (Dauer, Peaks) und IDs.
3. **UI-Tick ≠ React-Render.** Zeitkritische Werte (Playhead, Meter) laufen über Stores + direkte Canvas-/DOM-Updates; React rendert nur Zustandswechsel (Play/Stop, Track, Auswahl durch Nutzer).
4. **Ein Ausführungspfad:** Jede Fachtätigkeit existiert genau einmal als Command; Keyboard, MIDI, Menü, Toolbar und Chatbot mappen nur noch auf Command-IDs (`tests/edit-command-contracts.test.ts` bleibt die Messlatte).
5. **Domäne kennt kein React, kein DOM, kein IPC.** Import-Richtung immer `features → state → domain ← audio/io/platform`.
6. **Jede Nebenwirkung ist abräumbar:** Listener/Timer/Worker besitzen genau eine Registrierungs- und eine Aufräumstelle; Effekte haben vollständige Dependency-Listen (Lint-Fehler = Build-Fehler).
7. **Budget statt Gefühl:** Bundle-Größe, Frame-Zeit, Analyse-Latenz, Cache-Bytes und Tests sind als Schwellen im Repo hinterlegt und laufen in CI.

### 4.3 Ziel-Dateibaum (Auszug, Neuzuschnitt)

```
src/
  app/App.tsx                     # Komposition, < 200 Zeilen
  app/providers.tsx               # Stores/Fehlerrahmen/Tastaturbindung
  state/projectStore.ts
  state/transportStore.ts
  state/settingsStore.ts
  domain/timeline.ts
  domain/editGraph.ts
  domain/editCommands.ts
  domain/analysis/analyze.ts
  domain/analysis/analysisCache.ts
  domain/analysis/analysis.worker.ts
  audio/playbackEngine.ts
  audio/stemsPlayback.ts
  features/transport/usePlayhead.ts
  features/transport/playheadDriver.ts
  features/editing/useEditActions.ts
  features/editing/historyStore.ts
  features/stems/useStemSeparation.ts
  features/import/useTrackImport.ts
  features/recorder/useRecorder.ts
  features/chatbot/chatbotCommands.ts
  features/settings/…
  platform/desktopBridge.ts
  components/…                     # nur Darstellung, memoisiert
```

Der Umbau erfolgt **inkrementell mit Re-Exporten**: Alte Pfade (`src/audio/editingEngine.ts` usw.) bleiben zunächst als Fassade bestehen, damit kein „Big Bang“ entsteht (siehe WP-06, Migrationsregeln).

---

## 5. Arbeitspakete

Legende Aufwand: **S** ≤ 1 Tag · **M** 2–4 Tage · **L** 5–10 Tage. „Risiko“ = Gefahr einer Verhaltensänderung.

---

### WP-01 · Mess- und Sicherungsnetz (Phase 0) · S · Risiko: keine
**Ziel:** Jede Verbesserung ist danach beweisbar.
**Schritte:**
1. `scripts/bench-waveform.mjs` (Anhang C.5) und `scripts/bench-analysis.mjs` anlegen (Ausführung über `npx tsx`, wie `scripts/stems-diagnose.ts`); Ausgabe als JSON für Verlaufsvergleiche.
2. `scripts/check-bundle-budget.mjs`: liest `dist/assets/*.js`, vergleicht mit Schwellen aus `budgets.json` (Start ≤ 260 kB gzip, Lazy-Chunks ohne Limit, `three`-Referenz).
3. CI-Job `quality-linux.yml`: Ubuntu, `npm ci --ignore-scripts`, `npm run lint`, `npm test` (parallel), `npm run build`, Budget-Check. Der Windows-Job bleibt unverändert für Installer.
4. Baseline-Tag `perf-baseline-2026-10-03` setzen (Zahlen aus Kapitel 2 einfrieren).
**DoD:** Ein Befehl `npm run verify` führt Typcheck + Tests + Budget aus und schlägt bei Regression fehl.

---

### WP-02 · Transport-Store + Frame-Treiber (Phase 1) · M · Risiko: mittel
**Ziel:** Kein React-State-Update mehr pro Frame; Playhead und Meter laufen direkt in die Anzeige.
**Schritte:**
1. `state/transportStore.ts` mit `useSyncExternalStore`, Selektoren und einer nicht-reaktiven `getTransport()`-Lesefassade (Skizze Anhang C.1).
2. `features/transport/playheadDriver.ts`: rAF-Treiber, schreibt `positionSec` (jeden Frame) und `meters` (gedrosselt auf 20 Hz) in den Store; startet/stoppt mit Wiedergabe über eine `AbortController`-ähnliche Handle-Struktur (Skizze C.2).
3. `App.tsx:1023–1049` ersetzen. `currentTime`/`meterL`/`meterR` bleiben **nicht** als React-State erhalten; Verbraucher:
   - `TrackHeader`/`TrackOverview`: lesen `positionSec` per Selektor mit Drosselung (10 Hz Textanzeige),
   - `DetailWaveform`: bekommt den Treiber und zeichnet selbst,
   - `BottomControlBlock`/Transportleiste: nur `isPlaying` + Diskretwerte.
4. Auto-Scroll (`viewOffset`-Nachführung) wandert in den Treiber und wird **nur noch** als Store-Wert plus ereignisbasierte `onViewportChange`-Meldung geführt – nicht mehr als React-Prop-Kette, die den Effekt neu startet.
5. `handleSeek`/`handleTogglePlay` schreiben in Store + Engine (kein `setCurrentTime` mehr).
**Tests:** neuer Test „Playhead-Treiber: N Ticks → 0 React-Commits für reine Positionsänderungen“ – umgesetzt framework-frei über einen Zähler im Render-Double (die Suite bleibt bei `node:assert`); bestehende Transport-/Edit-Tests bleiben grün.
**DoD:** Idle/Wiedergabe erzeugt keine Full-App-Renders; `App.tsx` enthält kein `setInterval`/`rAF` mehr; `viewOffset`-Churn beseitigt.

---

### WP-03 · Visualisierungsschicht (Phase 1) · M · Risiko: mittel (Optik!)
**Ziel:** Repaint nur, wenn sich sichtbar etwas ändert; HiDPI korrekt.
**Schritte:**
1. `DetailWaveform` in zwei Canvas-Ebenen splitten:
   - **Basis-Layer**: Hintergrund, Beatgrid, Bar-Nummern, Wellenform-Spalten, Phrasen-Leiste → Repaint nur bei Änderung von `{track.analysis, viewOffset, viewDuration, waveformMode, canvasSize, dpr}` (Hash-Vergleich).
   - **Overlay-Layer**: Playhead, Auswahl, Hover, Cue-Marker, Kontextmenü-Marker → Repaint bei Store-/Interaktionsänderung, im Leerlauf **kein** Frame.
2. rAF-Loop entfernen; Zeichnen ereignisgesteuert (`requestAnimationFrame`-koalesziert, aber nur bei Dirty-Flag). Hover über `useRef` + koalesziertes Repaint statt `useState`.
3. DPR-Korrektur: `canvas.width = Math.round(cssW * dpr)`, `ctx.setTransform(dpr,0,0,dpr,0,0)`; 1-px-Linien auf halbe Pixel ausrichten (Rekordbox-Treue).
4. Props stabilisieren: alle Callbacks aus `App.tsx` als `useCallback`, alle Komponenten mit `React.memo` (mindestens `DetailWaveform`, `MenuBar`, `DeckStemsControl`, `BottomControlBlock`, `PalettePanel`, `TrackHeader`, `ClipDeckView`, `BrowserMultiTrackBar`).
5. Optional in derselben Schicht: Wellenform-Spalten als `ImageData`-Streifen cachen, damit Pan/Zoom ohne erneutes Abtasten auskommt.
**Tests:** `tests/clip-waveform-detail.test.ts` erweitern; neue Tests „Basis-Layer zeichnet bei unveränderten Eingaben 0-mal“ und „Leerlauf erzeugt 0 rAF-Aufrufe“ – über ein Canvas-Double, das jede Zeichenoperation zählt, und ein gestubbtes `requestAnimationFrame` (framework-frei, wie die übrigen Suiten).
**DoD:** Messung aus WP-01 zeigt ≤ 0,5 ms pro Frame im Leerlauf/Wiedergabe; Screenshot-Vergleich gegen `reference/*.png` ohne sichtbare Abweichung.

---

### WP-04 · Analyse: Cache + Worker (Phase 2) · M · Risiko: niedrig
**Ziel:** Analyse aus dem Frame-Pfad heraus, Ergebnisse wiederverwenden.
**Schritte:**
1. `domain/analysis/analysisCache.ts`: Key `trackId:sourceSha256:segmentsHash:algorithmVersion`, LRU mit Byte-Budget (Default 256 MB, Settings überschreibbar). Segmentshash über kanonische Segmentliste → bei Undo/Redo ohne Neuberechnung.
2. `analysis.worker.ts` (Vite-Worker) mit Transfer der `Float32Array`-Ergebnisse; Fallback auf synchronen Pfad, wenn Worker nicht verfügbar (Tests, Electron-Preload-Kontext). Der Worker erhält nur Kanaldaten + Parameter (pure Funktion, `analyzer.ts` bleibt unverändert nutzbar).
3. Chunking der Analyse (z. B. 30-s-Blöcke) mit Fortschritt und Abbruch, damit kein Long-Task > 50 ms entsteht.
4. `App.tsx`-Aufrufe (`1542, 1993, 1999, 2035, 2041, 3582, 3691`) auf `getAnalysis(track, segments)` umstellen; jede direkte `analyzeAudioBuffer`-Nutzung außerhalb der Domäne wird Lint-Fehler.
**Tests:** Cache-Trefferrate/Invalidierung (Segmentänderung → Miss, Undo → Hit), Worker-Parität (Ergebnis bitgleich zum synchronen Pfad), Long-Task-Budget im Perf-Harness.
**DoD:** Wiederholtes Undo/Redo eines 5-Minuten-Tracks führt zu 0 Neuberechnungen.

---

### WP-05 · Edit-Historie ohne Audiokopien (Phase 2) · M · Risiko: mittel-hoch
**Ziel:** Speicher pro History-Schritt von ≈106 MB auf O(Segmentliste) senken.
**Schritte:**
1. `features/editing/historyStore.ts`: Eintrag = `{description, timestamp, segments, cues, selection, duration, analysisRef}`. Audio wird über `renderEditSegments(sourceBuffer, segments)` rekonstruiert; geteilte Clip-Buffer sind unveränderlich und werden **referenziert**, nicht kopiert.
2. Byte-Budget statt fester Zahl: `HISTORY_MAX_ENTRIES = 100`, `HISTORY_MAX_BYTES = 128 MB` (Schätzung aus Segmenten × Kanalbreite), Verdrängung von vorne.
3. Invariantenprüfung nach jedem Restore (`duration`, Segmentgrenzen, Cue-Positionen, Analyse-Hash) mit lauter Fehlermeldung statt stiller Abweichung.
4. Golden-Test „Undo-Kette 20 × Insert/Delete/Replace → Audio bitgleich zum Direktlauf“ (erweitert `tests/edit-command-matrix.test.ts`, `tests/ripple-delete-original-integrity.test.ts`).
**Risiko-Mitigation:** Das Verhalten bleibt identisch, weil der rekonstruierte Arbeitsbuffer nach jedem Restore ohnehin erzeugt wird (`App.tsx:1996–1999`); die Änderung entfernt nur die redundante Kopie.
**DoD:** Speicher nach 30 Edits < 600 MB (War 3,1 GB); alle Edit-/Kausalitätstests grün ohne Anpassung.

---

### WP-06 · `App.tsx`-Dekomposition (Phase 2) · L · Risiko: mittel
**Ziel:** Von 4.793 Zeilen auf < 200 Zeilen Komposition; ein Ausführungspfad für Fachlogik.
**Migrationsregeln (wichtig für Reviewbarkeit):**
- **Ein Feature pro PR**, immer „verschieben, nicht umschreiben“ (kein Verhaltenswechsel im selben Commit).
- Jeder Schritt endet mit grüner Suite + unverändertem `reference/*.png`-Screenshot.
- Alte Importpfade bleiben bis zum Ende als Re-Export-Fassade bestehen.

**Reihenfolge und Zielorte:**

| Schritt | Aus `App.tsx` | Nach | Zeilen ca. |
|---|---|---|---|
| 1 | Transport/Playhead/Zoom (`1603–1762`) | `features/transport/*` | 160 |
| 2 | Persistenz-Settings (`519–607, 1128–1140`) | `state/settingsStore.ts` | 90 |
| 3 | Import (XML/DB/Bundled) (`3001–3434`) | `features/import/useTrackImport.ts` | 430 |
| 4 | Projekt speichern/öffnen/neu (`3435–3960`) | `features/project/useProjectFiles.ts` | 520 |
| 5 | Edit-Befehle (`1944–3000`) | `features/editing/*` + `domain/editCommands.ts` | 1.050 |
| 6 | Stems (`533–1602`) | `features/stems/*` | 1.070 |
| 7 | Recorder (`645–871`) | `features/recorder/useRecorder.ts` | 230 |
| 8 | Chatbot-Switch (`4014–4793`) | `features/chatbot/chatbotCommands.ts` (Registry) | 780 |
| 9 | Paletten/Deck-B/Cues (`2113–3000`) | `features/palette/*`, `features/cues/*` | 300 |

**Command-Registry (Kern des Ganzen):**
```ts
// domain/editCommands.ts
export interface CommandContext { project: ProjectState; transport: TransportState; clipboard: ClipboardState; }
export type CommandId = 'COPY' | 'CUT' | 'PASTE' | 'INSERT' | 'REPLACE' | 'OVERDUB' | 'DELETE' | 'CLEAR' | 'UNDO' | 'REDO' | …;
export const COMMANDS: Record<CommandId, (ctx: CommandContext, params: unknown) => CommandResult> = { … };
```
Keyboard, MIDI, Menü, Toolbar und Chatbot mappen nur noch `(CommandId, params)`; die 781-Zeilen-Switch wird zu einer Map mit je einer kleinen Datei/Function.
**Tests:** `tests/edit-command-contracts.test.ts` und `edit-command-matrix.test.ts` werden von „Textvertrag“ zu echtem Ausführungsvertrag gegen `COMMANDS`; zusätzlich Snapshot-Test der Command-ID-Abdeckung (jede ID hat Handler + Test).
**DoD:** `App.tsx` < 200 Zeilen, keine Fachlogik mehr darin; alle 4 Eingabepfade rufen identische Command-IDs.

---

### WP-07 · Audio-Engine: Zustandsmaschine + schnelles Rendering (Phase 3) · L · Risiko: hoch
**Ziel:** Engine-Lifecycle deterministisch; Edit-Rendering deutlich schneller.
**Schritte:**
1. `audio/playbackEngine.ts` als explizite Zustandsmaschine (`idle → starting → playing → paused → stopping`), Node-Lifecycle mit `disconnect()` beim Stopp (heute bleiben Verbindungen bestehen), Fehlerereignisse (`onended` vs. Abbruch) unterscheidbar.
2. Zeitarithmetik (`getCurrentTime`, Sample↔Sekunde, Epsilon) nach `domain/timeline.ts` verschieben – pure, testbare Funktionen ohne `AudioContext`.
3. `renderEditSegments` beschleunigen (Skizze C.4): für Segmente ohne Resampling und ohne Overdub `Float32Array.set(subarray)` statt Sample-Schleife mit Funktionsaufruf pro Sample; Overdub-Pfad bleibt unverändert. Erwartung: 5-Minuten-Mixdown von Sekunden auf < 200 ms.
4. Gain-/Mute-/Solo-Plan zentral berechnen (`planStemGains(state)`) und nur noch Differenzen auf die GainNodes anwenden (heute: komplette Neuzuweisung bei jeder Änderung).
5. Position/Meter über den Treiber aus WP-02, keine eigenen Timer.
**Tests:** Timeline-Mathematik vollständig (Round-Trip S→Sample→S, Epsilon-Grenzen); Mixdown-Paritätstest alt/neu (bitgleich für alle Kombinationen aus `edit-command-matrix`); Gain-Plan-Unit-Tests (Mute+Solo-Interaktion).
**DoD:** Paritätstests grün, Mixdown-Benchmark dokumentiert, keine hängenden AudioNodes nach 100 Play/Stop-Zyklen (`ctx`-Diagnose).

---

### WP-08 · Speicher- und Cache-Bewirtschaftung (Phase 3) · M · Risiko: niedrig
**Ziel:** Speicherverbrauch ist begrenzt, sichtbar und einstellbar.
**Schritte:**
1. `stemsCache` → `AudioBufferLru` mit Byte-Budget (Default 1 GB, Settings), Schlüssel nur `sha256` (der `trackId`-Doppeleintrag entfällt; Lookup über `trackId → sha256`-Index).
2. `analysisCache` (WP-04) und `SeparationCache` (Dateiebene) mit denselben Budget-/TTL-Parametern in den Einstellungen.
3. Logger: Write-behind (Ringpuffer im Speicher, Flush per `requestIdleCallback`/250-ms-Fallback, maximal 1 × 2 s), localStorage nur **Delta** und größenbegrenzt (nicht 400 Einträge × Vollserialisierung pro Ereignis); Datei-Persistenz unverändert (Audit-Anforderung).
4. Diagnose-Kennzahlen in `SystemLogModal`/`getStemDiagnostics`: Cache-Bytes, History-Bytes, Objektzahlen.
**Tests:** LRU-Verdrängung (Byte-Grenze, Reihenfolge), Logger-Drosselung (1000 Einträge → 1 Storage-Write), `tests/file-logger.test.mjs` bleibt grün.
**DoD:** 60-Minuten-Session mit 20 Tracks bleibt < 1,5 GB RSS (Perf-Harness).

---

### WP-09 · Observability ohne Hot-Path-Kosten (Phase 4) · S · Risiko: niedrig
**Ziel:** Diagnose bleibt vollständig, kostet aber keine Frames.
**Schritte:**
1. Log-Level je Kategorie (`debug`-Kategorien im Produktionsbuild abschaltbar), Hot-Path-Regel: keine `logger.*`-Aufrufe in Frame-/Sample-Schleifen (Lint-Custom-Regel oder Review-Checkliste).
2. `performance.mark/measure` für Import, Analyse, Mixdown, Separation; Messwerte im Systemlog sichtbar.
3. Sampling/Wiederholungszähler für Fetches (heute wird jede langsame Anfrage einzeln geloggt).
**DoD:** Ein 5-Minuten-Playback erzeugt ≤ 5 Log-Einträge pro Minute; Langlauf-Diagnose bleibt möglich.

---

### WP-10 · IO-Entdopplung: Pfade, ANLZ, XML (Phase 3) · M · Risiko: mittel
**Ziel:** Ein Modul pro Konzept, Paritätsgarantie.
**Schritte:**
1. `platform/mediaPath.ts` (TS) + `electron/mediaPath.cjs` (CJS) aus **einer** Quelle generieren (das Muster existiert schon: `scripts/build-anlz-structure.mjs` → `electron/generated/anlzStructure.cjs`, inkl. `--check` und Paritätstest). Anwenden auf: Medien-Pfadvergleich, ANLZ-Pfadauflösung (`analysisPath.cjs` → löschen, `electron/analysisRegistry.cjs` behalten).
2. Duplikate zusammenführen: `clamp`/`timeToSampleFloor` → `domain/timeline.ts`; `dbToLinear`/`linearToDb` → `audio/units.ts`; `sha256Bytes` → `stems/hash.ts`.
3. XML-Import: Parser in Worker (oder inkrementelles SAX über `DOMParser`-Chunks) mit Fortschritt/Abbruch; `tests/large-xml-import.test.ts` und `import-simulation.test.ts` bleiben die Messlatte.
4. `bundledCollection`-XML aus dem JS-Bundle in `public/` (bzw. `resources/`) verlegen und lazy per `fetch` laden; Fallback auf `read-bundled-xml`-IPC bleibt.
**Tests:** Paritätstest generierte CJS ↔ TS; Pfad-Matrix (Windows/POSIX, `file://`, `?/`-Laufwerke, Groß-/Kleinschreibung); Worker-Parität.
**DoD:** Nur noch **je eine** Implementierung pro Konzept; `npm run build:anlz-structure:check`-Analogie als `build:path-parity:check` in CI.

---

### WP-11 · Electron-Struktur (Phase 4) · L · Risiko: mittel-hoch (Sicherheitsgrenzen!)
**Ziel:** IPC-Vertrag sichtbar, testbar, je Domäne isoliert – ohne die bestehenden Sicherheitsgarantien anzutasten.
**Schritte:**
1. `electron/main.cjs` (915) aufteilen: `windows.cjs`, `protocol.cjs` (bleibt `contextIsolation: true, nodeIntegration: false, sandbox: true`, `will-navigate`-Sperre, `setWindowOpenHandler('deny')`), `ipc/rekordbox.cjs`, `ipc/stems.cjs`, `ipc/files.cjs`, `ipc/logs.cjs`, `ipc/audit.cjs` (der bestehende Audit-Wrapper `Z. 74–160` bleibt zentral).
2. `electron/preload.cjs` als **einzige** API-Fläche mit generierten Typen: `src/types/desktop.d.ts` aus den Kanaldefinitionen ableiten (`preload.cjs` + `contracts.cjs` → `.d.ts`) und im Build prüfen, dass Datei und Code übereinstimmen.
3. Kanalvertrag testen: für **jeden** der 27 Kanäle mindestens Test für „vorhanden/abgelehnt/falsche Argumente“, Ausbau von `tests/stem-engine-ipc-contract.test.ts` zu einem generischen Vertragstest.
4. Streaming für große Nutzdaten (`rekordbox:save-export-file`, `rekordbox:read-original-audio`, `stems:separate`): Dateipfad-Übergabe statt Byte-Array über IPC.
**Tests:** generischer IPC-Vertragstest, `path-guard`-, `master-db-gate`-, `rekordbox-gate-*`-Suiten unverändert grün.
**DoD:** Keine Datei > 400 Zeilen in `electron/`; jede Kanaländerung bricht einen Test.

---

### WP-12 · Server & Protokoll (Phase 3) · M · Risiko: niedrig
**Ziel:** `server.ts` (976) in Router und Dienste zerlegen, Datenmengen kontrolliert.
**Schritte:**
1. `server/routes/{stems,jobs,remote,logs,chat,health}.ts`, `server/services/{aiCopilot,logStore}.ts`; die Offline-Antwort (`Z. 675–976`) wird ein eigenes Modul mit Tests.
2. Body-Limits: 500 MB entfernen; Uploads streamen (`multipart` bzw. Dateipfad) mit Backpressure und Fortschritt; JSON-Limits bleiben restriktiv (1–10 MB).
3. Job-Events (`/api/stems/jobs/:id/events`) auf SSE mit Heartbeat und Wiederaufsetzpunkt prüfen (heute Polling).
4. Einheitliche Fehlerhülle `{ok:false, code, message}` für alle Routen (existiert teils schon) + Test.
**Tests:** Routen-Integrationstests (supertest-äquivalent ohne neue Runtime-Abhängigkeit: `fetch` gegen `app.listen(0)`), Job-Streaming, 413/415-Fälle.
**DoD:** Keine Route > 60 Zeilen; kein Body-Limit > 16 MB; alle bestehenden Stems-Remote-Tests grün.

---

### WP-13 · Typen, Lint, Regeln (Phase 2, gestuft) · M · Risiko: niedrig
**Ziel:** Fehlerklasse „null/undefined“ und „falsche Effekt-Abhängigkeiten“ ist nicht mehr möglich.
**Schritte (jeweils eigener PR, damit Fehlerlawinen beherrschbar bleiben):**
1. ESLint (Flat Config) + `typescript-eslint` + `react-hooks` (Regel `exhaustive-deps: error`, `rules-of-hooks: error`), `no-floating-promises` (`error`), `no-console` (außer Logger/Server), `import/no-cycle` (warn). Prettier **oder** Biome nur, wenn gewünscht (Kapitel 11).
2. `tsc`-Stufen: `noUnusedLocals`/`noUnusedParameters` → `strictNullChecks` → `strict: true` → `noUncheckedIndexedAccess`. Pro Stufe: Fehler beheben oder mit begründeter, befristeter Ausnahme (`// @ts-expect-error: Grund, Ticket`) markieren.
3. `any`-Abbau: 19 `: any` + 14 `as any` + 3 `@ts-ignore` auf 0 in `src`; `server.ts`-`any`s typisieren.
4. `npm run verify` = `lint && typecheck && test && build && budget`.
**DoD:** `strict: true` grün, ESLint mit 0 Fehlern, 0 `@ts-ignore` in `src`, CI erzwingt beides.

---

### WP-14 · Test-Harness: DOM, Perf, Coverage (Phase 2–4) · L · Risiko: niedrig
**Ziel:** Refaktorisierung wird von Tests getragen, nicht von Hoffnung.
**Schritte:**
1. DOM-Testumgebung (`happy-dom` oder `jsdom`) + `@testing-library/react` als devDependency; Test-Renderer zählt React-Commits (Basis für WP-02/WP-03-Nachweise). **Bewusste Entscheidung** (Kap. 11.3), damit die bestehende framework-freie Testkultur (`node:assert` + `tsx`) nicht unbemerkt ersetzt wird – reine Logiktests bleiben framework-frei.
2. Charakterisierungstests für die 35 ungetesteten Komponenten (Start: die 8 größten) – jeweils „rendert ohne Crash“, „Props → sichtbarer Zustand“, „keine Effekt-Schleifen“.
3. Perf-Harness im Electron-Renderer (bestehende `scripts/run-electron-node.mjs`-Infrastruktur): lädt den Produktionsbuild, misst Idle-Frames, Frame-Zeiten, Speicher nach N Edits, Kaltstart. Schwellen aus `budgets.json`, Exit-Code 1 bei Überschreitung.
4. Coverage (v8) mit Schwellen: `src/domain/**` ≥ 80 %, `src/features/**` ≥ 50 %, gesamt ≥ 60 %; Report in CI als Artefakt.
5. Property-/Kombinationstests für Edits erweitern (Insert→Delete, Replace→Undo→Redo, Clear→Overdub, Marker exakt auf `start`/`end`, Segmente an Cue-Grenzen) – dort, wo `edit-command-matrix.test.ts` noch Lücken hat.
**DoD:** `npm run verify` prüft Typen, Lint, Tests, Coverage, Bundle, Perf; jeder WP hat mindestens einen neuen Test.

---

### WP-15 · Aufräumen und Repo-Hygiene (Phase 1–2) · S · Risiko: niedrig
**Ziel:** Weniger Rauschen, kleinere Klone, keine irreführenden Altlasten.
**Schritte:**
1. Toten Code löschen: `src/audio/stftSeparator.ts`, `src/audio/synthesizerTrack.ts`, `src/components/WaveformRenderer.tsx`, `src/utils/anlzParser.ts` (WP-10 führt `utils/anlzParser` zusammen, dann entfällt die Datei).
2. Root-Einmal-Skripte nach `tools/legacy/` verschieben (oder löschen): `fix*.cjs`, `master-fix-and-push.cjs`, `full_auto_fix.mjs`, `clean_fix.cjs`, `*.ps1`, `patch_app.py`, `setup-installer-pipeline.cjs`, `analysisPath.cjs/.test.cjs`, `test_analysis.ts`, `metadata.json`, `fix-package.txt`, `anlz-mismatch-diagnose.patch`; `src/fix.js`, `src/full_auto_fix.mjs`, `src/build_pipeline.py` entfernen (nichts referenziert sie).
3. ZIPs (`airdox_editor_fix*.zip`, je 13 MB) aus dem HEAD entfernen; `python/`, `rb_*.py`, `rekordbox_parser.py`, `waveform_renderer.py` auf Nutzung prüfen und konsolidieren (nur `python/bsroformer_inference.py` + `install_bsroformer.py` sind im Build verdrahtet).
4. Sichtbare/generierte Artefakte (`visualization.html`, `code_analysis_out/**`, `artifacts/stem-validation-15s/*.wav`) aus dem HEAD nehmen und per Skript reproduzierbar machen; große Fixtures über ein dokumentiertes Download-/Generierungsskript beziehen (Muster existiert: `stems:bundle`).
5. `.gitignore` erweitern (`*.zip`, `code_analysis_out/`, `dist/` bleibt, `logs/` vorhanden), README um „Repo-Layout“ und „`npm run verify`“ ergänzen.
**DoD:** HEAD enthält keinen toten Code, keine ZIPs, keine 5-MB-Artefakte ohne Skript; `git clone` < 15 MB.

---

### WP-16 · Build & Release (Phase 1, dann Phase 4) · M · Risiko: niedrig
**Ziel:** Kleineres Startbundle, reproduzierbare Budgets.
**Schritte:**
1. `React.lazy` für `ExportModal`, `DatabaseExtractionModal`, `RekordboxXmlImportModal`, `MultiLayerRenderInspector` (+ `three`), `RemoteFlowModal`, `MidiControllerModal`, `RecorderModal`; `Suspense`-Fallback im vorhandenen Design.
2. `build.rollupOptions.output.manualChunks`: `react-vendor`, `lucide`, `three` (lazy-only), `xml`/`bundled-collection` getrennt.
3. `budgets.json` + `scripts/check-bundle-budget.mjs` (WP-01) in CI.
4. `electron-builder`: `asarUnpack`-Prüfung (existiert in `tests/stem-asar-unpack.test.ts`) beibehalten; Installergröße messen und im Release-Report dokumentieren.
**DoD:** Start-JS ≤ 260 kB gzip; `three` in keinem Startchunk; Budget-Check bricht den Build bei Regression.

---

## 6. Phasen, Reihenfolge, Freigabekriterien

| Phase | Inhalt | Dauer (1 Dev) | Freigabekriterium |
|---|---|---|---|
| **0 – Messen** | WP-01, Baseline-Tag, CI-Linux-Job | 1–2 Tage | `npm run verify` existiert und ist in CI grün |
| **1 – Sofortwirkung** | WP-02, WP-03, WP-16.1/2, WP-15.1/2, Logger aus WP-08.3 | 1 Woche | Idle ~0 Frames; keine Full-App-Renders; Bundle ≤ 260 kB gzip; Speicher-Test 30 Edits < 600 MB (mit WP-05-Sofortvariante: History-Limit auf 8 + Audio nur für den letzten Schritt) |
| **2 – Entkopplung** | WP-06 (Schritte 1–5, 8), WP-05, WP-13, WP-14.1/2 | 2–3 Wochen | `App.tsx` < 800 Zeilen; Command-Registry aktiv; `strictNullChecks` grün; DOM-Testharness läuft |
| **3 – Engine & IO** | WP-06 Rest, WP-07, WP-04, WP-08, WP-10, WP-12 | 2–3 Wochen | Mixdown-Parität + Benchmarks; Analyse-Cache wirksam; nur eine Pfad-/Parser-Implementierung; Server-Router getrennt |
| **4 – Härtung** | WP-11, WP-09, WP-14.3/4/5, WP-16.3/4 | 1–2 Wochen | Perf-/Coverage-Budget in CI; jede Datei in `electron/` < 400 Zeilen; `npm run verify` blockiert Regressionen |

**Summe:** ca. **8–11 Wochen** für eine Person, **5–7 Wochen** bei zwei Entwicklern mit klarer Datei-Ownership (Phasen 2 und 3 sind gut parallelisierbar: `features/*` vs. `audio|io|server`).

**Nicht parallelisieren:** WP-02/WP-03 (gleiche Dateien) · WP-05/WP-06.5 (Edits) · WP-07/WP-04 (beide im Analyse-/Render-Pfad).

---

## 7. KPIs: Baseline → Ziel, mit Messbefehl

| KPI | Baseline | Ziel | Messung |
|---|---|---|---|
| React-Renders/s während Wiedergabe | ~180 State-Updates/s → mehrere Full-Tree-Renders/Frame | **0** pro Frame (nur Canvas/Store-Subscriber) | Test-Renderer-Zähler (WP-14.1) + React-Profiler im Perf-Harness |
| Repaints im Leerlauf | dauerhaft ~60/s | **0/s** | rAF-Zähler im Perf-Harness |
| Frame-Zeit (Overlay-Wiedergabe) | 2,41 ms (18-s-Fenster) / 3,97 ms (Full-Track), Node-Messung | **≤ 0,5 ms** Overlay, Basis-Paint nur bei View-Änderung | `scripts/bench-waveform.mjs`, Perf-Harness |
| Speicher nach 30 Edits (5-min-Track) | bis ≈ 3,1 GB | **< 600 MB** | Perf-Harness: `process.memoryUsage()` nach Skriptlauf |
| Speicher 60-min-Session, 20 Tracks | unbegrenzt (Stem-Cache) | **< 1,5 GB** RSS | dito |
| Analyse-Latenz Long-Task | 77 ms am Stück pro Aufruf | **< 50 ms** je Chunk, gecacht | Worker-Test + Long-Task-Observer |
| Startbundle JS (gzip) | 372,58 kB | **≤ 260 kB** | `npx vite build` + `check-bundle-budget.mjs` |
| XML-Import 10,5 MB: Blockade | Main-Thread | UI bleibt interaktiv, kein Task > 50 ms | Perf-Harness |
| Testlaufzeit | 93,2 s (serial) | **≤ 60 s** parallel, 0 Flakes | `npm test` in CI |
| Module ohne Test (Importgraph) | 48 von 120 (35/36 Komponenten) | **0** in `domain/**`/`features/**`, Komponenten ≥ 50 % | Coverage-Report + Reachability-Skript |
| `strict` / Lint | aus / kein Linter | **an / 0 Fehler** | `npm run verify` |
| HEAD-Clone-Größe | 26 MB `.git`, 26 MB ZIPs im HEAD | **< 15 MB** | `git count-objects -vH` |
| `App.tsx` | 4.793 Zeilen | **< 200 Zeilen** | `wc -l` |

---

## 8. Verifikationsstrategie (welcher WP durch welche Tests abgesichert wird)

| WP | Bestehende Suiten (müssen grün bleiben) | Neue Tests |
|---|---|---|
| WP-02 | – | Treiber-Tick-Zählung, „0 Renders bei Positionsänderung“ |
| WP-03 | `clip-waveform-detail.test.ts`, `editing-waveform-causality.test.ts` | Layer-Dirty-Flags, DPR-Geometrie, Screenshot-Parität |
| WP-04 | `onnx-separator-inmemory`, `stem-separation-*` | Cache-Hit/Miss, Worker-Parität, Chunk-Grenzen |
| WP-05 | `edit-command-matrix`, `ripple-delete-original-integrity`, `editing-waveform-causality` | History-Byte-Budget, Undo-Kette bitgleich, Restore-Invarianten |
| WP-06 | `edit-command-contracts`, `edit-command-matrix`, `delete-mode`, `auto-cue`, `midi-exhaustive-matrix` | Registry-Abdeckung aller Command-IDs, 4-Eingabepfade-Äquivalenz |
| WP-07 | `pitch-tempo`, `audio-export`, `stem-peak-headroom` | Timeline-Mathematik, Mixdown-Parität alt/neu, Node-Cleanup |
| WP-08 | `file-logger`, `stem-job-service*` | LRU-Verdrängung, Logger-Drosselung, Budget-Settings |
| WP-10 | `anlz-structure-parity`, `anlz-real-format`, `rekordbox-*`, `large-xml-import`, `import-simulation` | Pfad-Parität generiert ↔ TS, Worker-XML-Parität |
| WP-11 | `path-guard`, `master-db-gate`, `rekordbox-gate-*`, `stem-engine-ipc-contract` | generischer IPC-Vertrag über alle 27 Kanäle |
| WP-12 | `stem-remote-*`, `stem-job-service*` | Routen-Integration, 413/415, SSE-Reconnect |
| WP-13 | `tsc --noEmit` | ESLint- und Strict-Gate in CI |
| WP-14 | alle | Perf-/Coverage-/Bundle-Budget |
| WP-15/16 | `stem-asar-unpack`, `stem-bundle-weights` | Bundle-Budget, Repo-Layout-Check |

**Guardrails (dürfen durch keinen WP verletzt werden):**
1. Keine Operation verändert schreibend eine Originalquelle (`read-only`-Garantie, `pathGuard`, Export-Schutz).
2. ANLZ-/DB-Werte haben weiter Vorrang vor Schätzungen; `origin`-Felder bleiben ehrlich.
3. Wellenform bleibt eine kontinuierliche Darstellung, keine „Edit-Balken“ (`WAVEFORM_DATA_ORIGIN.md`).
4. Der Projekt-Datei- und Exportvertrag bleibt kompatibel (bereits geschriebene `.airdox`-Projekte müssen ladbar bleiben).
5. Log-Format (Kategorie/Level/Dateiablage) bleibt supportfähig (`docs/LOGGING.md`).

---

## 9. Risikoregister

| Risiko | Auswirkung | Eintritt | Gegenmaßnahme |
|---|---|---|---|
| Verhaltensänderung im Audio-Renderpfad (WP-07) | Klang/Export weicht ab | mittel | Paritätstest alt/neu vor dem Umschalten; Feature-Flag `renderEngineV2` mit A/B bis Freigabe |
| Optik-Regression Waveform (WP-03) | Rekordbox-Treue verletzt | mittel | Referenzscreenshots `reference/01–03*.png` als Vergleich + Pixel-Diff-Toleranz |
| Undo/Redo ohne Audio ändert Verhalten (WP-05) | Nutzer verliert Edits | mittel | Restore-Invariantenprüfung, Undo-Kette-Test, Fallback: Audio-Kopie nur für den letzten Schritt behalten |
| Store-Umbau (WP-02/06) bricht seltene Pfade (Chatbot/MIDI) | Funktion still weg | mittel | Charakterisierungstests **vor** dem Umbau; Command-Registry-Abdeckungstest |
| Zu große PRs | Review unbrauchbar | hoch | Migrationsregeln WP-06 (ein Feature/PR, „move not rewrite“), Datei-Ownership je Phase |
| Electron-Sicherheit bei Aufteilung (WP-11) | Sicherheitslücke | niedrig–mittel | `contextIsolation/sandbox`-Invariantentest in CI; Security-Review durch zweite Person |
| Native/CI-Umgebungsunterschiede | Tests grün, App kaputt | mittel | Windows-Job bleibt Release-Gate (Installer + Test), Linux-Job nur Qualität |
| Refactor-Concurrent-Featurekonflikt | Merge-Chaos | mittel | „Code-Freeze für `App.tsx`“ während Phase 2; neue Features erst nach WP-06 |

---

## 10. Aufwandsschätzung

| WP | Beschreibung | Aufwand |
|---|---|---|
| WP-01 | Messnetz, Budgets, CI | 1–2 T |
| WP-02 | Transport-Store + Treiber | 2–3 T |
| WP-03 | Canvas-Layer, DPR, Memo | 2–3 T |
| WP-04 | Analyse-Cache + Worker | 3–4 T |
| WP-05 | History ohne Audiokopien | 3–4 T |
| WP-06 | App-Dekomposition + Command-Registry | 8–10 T |
| WP-07 | Engine-Zustandsmaschine + schnelles Rendern | 6–8 T |
| WP-08 | Caches/Logger-Budgets | 2–3 T |
| WP-09 | Observability | 1 T |
| WP-10 | IO-Entdopplung, XML-Worker | 3–4 T |
| WP-11 | Electron-Struktur + IPC-Vertrag | 5–6 T |
| WP-12 | Server-Router + Streaming | 3–4 T |
| WP-13 | Lint + gestufte Strictness | 4–6 T |
| WP-14 | DOM-/Perf-/Coverage-Harness | 5–7 T |
| WP-15 | Aufräumen, Repo-Hygiene | 1–2 T |
| WP-16 | Code-Splitting, Bundle-Budget | 1–2 T |
| **Summe** | | **50–68 Personentage** |

---

## 11. Entscheidungen (festgelegt am 04.10.2026)

Die sieben Punkte sind entschieden – bewusst in einfacher Sprache, damit sie ohne Vorwissen
lesbar sind. Die ursprüngliche Fragestellung steht jeweils als Kursivzeile darunter.

1. **Zustand: eigene Stores, kein zustand.** *Frage war: eigene Stores oder zustand?*
   Der eigene Store (`useSyncExternalStore`) kann genau das, was hier gebraucht wird – die
   Abspielposition ohne React-Neuzeichnung an den Canvas geben –, kostet keine Abhängigkeit und
   keine Anpassung am Electron-Build. **Bereits umgesetzt** (`src/state/transportStore.ts`).

2. **Lint: Biome.** *Frage war: ESLint oder Biome?*
   Ein Werkzeug, ein Befehl, ein Bruchteil der Laufzeit; es prüft zusätzlich die Formatierung, die
   bisher gar nicht geprüft wird. Die Regeln, auf die es hier ankommt, sind enthalten: fehlende
   Effekt-Abhängigkeiten (die Ursache des Tastatur-Fehlers aus Phase 1), `noFloatingPromises`,
   `noExplicitAny` und Importgrenzen zwischen den Schichten. Wird in Phase 2 (WP-13) eingeführt.
   *Falls das Team ESLint bevorzugt:* jederzeit austauschbar, beide prüfen dieselben Regeln.

3. **Komponententests: `happy-dom`.** *Frage war: happy-dom oder jsdom?*
   Wird über `happy-dom/global-registrator` nur in den Tests geladen, die es brauchen. Kein Wechsel
   des Testframeworks – die Suite bleibt bei `node:assert` und dem eigenen Runner. Canvas wird
   weiterhin durch ein Double ersetzt; jsdom nur, wenn ein Test echte Canvas-APIs verlangt
   (derzeit nicht nötig). Teil von WP-14.

4. **Git-Historie: nur aus dem HEAD entfernen, nicht umschreiben.** *Frage war: HEAD bereinigen oder
   Historie umschreiben (`filter-repo`)?*
   Eine Umschreibung ändert jede Commit-Nummer, macht bestehende Klone unbrauchbar und trifft die
   parallel laufenden Sitzungen und offenen Pull Requests. Die alten Stände bleiben zwar in der
   Historie, aber ein flacher Klon lädt sie nicht. **Bereits umgesetzt** – 26,2 MB ZIPs, 5,3 MB
   Validierungs-WAV und `bun.lock` sind aus dem HEAD entfernt, die Historie ist unangetastet.

5. **Performance-Messung: Electron-Renderer**, kein Playwright. *Frage war: Electron oder
   Playwright/Chromium?*
   Misst genau die Umgebung, in der das Programm beim Nutzer läuft, ohne neue Abhängigkeit und ohne
   zusätzlichen 300-MB-Browser-Download. Playwright bleibt eine Option für Phase 4, wenn Bilder und
   Interaktionen automatisch verglichen werden sollen (der Optik-Abgleich gegen `reference/*.png`
   ist bis heute manuell). Teil von WP-14.

6. **Umfang Phase 1: alle drei Quick Wins.** *Frage war: volle Kombination oder nur die reinen
   Laufzeit-Verbesserungen?*
   **Bereits umgesetzt** – Lazy-Modals, Bundle-Budget und Split sind enthalten: Startbundle
   361 → 199 kB gzip, 1334 → 669 kB roh.

7. **Code-Freeze: kein harter Freeze, aber ein „weiches" Fenster für zwei Dateien.** *Frage war, ob
   ein Code-Freeze für `App.tsx` während Phase 2 organisatorisch möglich ist.*
   Nötig ist kein Stillstand des Projekts, sondern eine Absprache: Während Phase 2 soll keine
   **andere** Sitzung `src/App.tsx` oder `src/components/DetailWaveform.tsx` umbauen. Alles andere
   (Stems, Rekordbox, Electron, Dokumentation) läuft parallel weiter.
   *Warum:* Genau diese zwei Dateien waren es, die der parallele Umbau aus PR #75 gleichzeitig
   verändert hat – 18 Konflikte, die von Hand zusammengeführt werden mussten. Bei WP-06 (Zerlegung
   von `App.tsx`) würde sich das ohne Absprache mehrfach wiederholen. Ich arbeite zusätzlich in
   kleinen Schritten und führe `main` bei jedem Schritt sofort ein, damit ein Konflikt nie größer
   wird als nötig.

**Stand der Umsetzung:** Punkte 1, 4 und 6 sind erledigt (Phase 0 + 1, siehe
[`REFACTORING_STATUS.md`](REFACTORING_STATUS.md)). Punkte 2, 3 und 5 gehören zu Phase 2–4
(WP-13, WP-14). Punkt 7 ist eine Absprache, keine technische Änderung.

**Ebenfalls erledigt:** Der Baseline-Tag `perf-baseline-2026-10-03` zeigt auf `main` @ `eea1a94`
(Stand vor der Refaktorisierung) und existiert lokal. Er ist noch nicht zu GitHub übertragen –
das ist der einzige offene Punkt der Phase-0-Checkliste.

---

## Anhang A · Struktur-Inventar (Hotspots)

| Datei | Zeilen | Testbezug | Befund |
|---|---|---|---|
| `src/App.tsx` | 4.793 | indirekt | Monolith, 87 States, B1/B7/B8/B13 |
| `src/components/DetailWaveform.tsx` | 1.390 | `clip-waveform-detail` | Doppel-Render, kein Leerlauf, kein DPR, B9 |
| `src/audio/editingEngine.ts` | 1.253 | viele | doppelte Helfer, Sample-Schleife, B3/B15 |
| `src/stems/remote/remoteStemJobService.ts` | 1.207 | `stem-remote-*` | `sha256Bytes`-Duplikat, B3 |
| `src/audio/stemEngine.ts` | 1.207 | viele | unbounded Cache, B14 |
| `src/stems/stemJobService.ts` | 1.045 | `stem-job-service*` | Statusproben/Backend-Auswahl |
| `server.ts` | 976 | – | Routing + Chat + Offline-Fallback, B6 |
| `electron/main.cjs` | 915 | mehrere | 27 IPC-Kanäle in einer Datei, B6 |
| `src/rekordbox/testDatasets.ts` | 754 | 3 Suiten | korrekt (nur Testdaten-Quelle) |
| `src/components/Modals/WorkspaceSettingsModal.tsx` | 657 | – | untested |
| `src/utils/logger.ts` | 654 | `file-logger` | O(n)-Storage pro Eintrag, B11 |
| `src/rekordbox/anlzParser.ts` | 653 | `anlz-*` | legitim; Legacy-Parser daneben (B3) |

## Anhang B · Belegliste (Kurzform)

| Nr. | Beleg |
|---|---|
| B1 | `src/App.tsx:404–522`, `:3061`, `:3504`, `:4014–4793`; 87 `useState` |
| B2 | `App.tsx:1659 ff.`, `:3889 ff.`, `:4014 ff.`, `:4270 ff.` |
| B3 | `editingEngine.ts:99` / `analysisComposer.ts:72`; `audioEngine.ts:21` / `editingEngine.ts:104`; `recordingProcessor.ts:30,34` / `mixEffects.ts:30,34`; `remoteStemJobService.ts:111` / `wavIo.ts:33`; `App.tsx:274–318` ↔ `electron/masterDbGate.cjs`; `analysisPath.cjs` ↔ `electron/analysisRegistry.cjs` |
| B4 | Import-Analyse: `stftSeparator.ts`, `synthesizerTrack.ts`, `WaveformRenderer.tsx`, `utils/anlzParser.ts` ohne Referenz; Root-Skripte; ZIPs in `git ls-files` |
| B5 | `tsconfig.json` (kein `strict`); `package.json` `"lint": "tsc --noEmit"`; Linter-Konfiguration nicht vorhanden |
| B6 | `electron/main.cjs` (915 Z., 27 `ipcMain.handle`); `server.ts:267,270,499–633,675–976` |
| B7 | `App.tsx:1023–1049` (Deps `[viewOffset, viewDuration]`) |
| B8 | `App.tsx:3949` (Effekt ohne Deps); `App.tsx:1710` (`currentTime` in Deps) |
| B9 | `DetailWaveform.tsx:202–726`, `:782`, `:145–175` |
| B10 | `vite.config.ts` ohne `manualChunks`; `MultiLayer3DVisualizer.tsx:2` |
| B11 | `logger.ts:77,221,484–500` |
| B12 | kein `new Worker` in `src`; `analyzer.ts:11`; `xmlParser.ts` (`parseRekordboxXmlAsync`) |
| B13 | `App.tsx:1944–1958`, `:1973`, `:2016` (30 × `cloneAudioBuffer`) |
| B14 | `stemEngine.ts:277–300` |
| B15 | `server.ts:267,270`; `electron/main.cjs:434,807` |
| B16 | Importgraph-Analyse: 72/120 Module test-erreichbar, 35/36 Komponenten ohne Testbezug; `tests/**` 75 Suiten |
| B17 | `.github/workflows/windows-build.yml` |

## Anhang C · Vorlagen (copy-paste)

### C.1 Transport-Store
```ts
// src/state/transportStore.ts
import { useSyncExternalStore } from 'react';

export interface TransportState { isPlaying: boolean; positionSec: number; loopActive: boolean; loopStart: number; loopEnd: number; }
export interface MeterState { left: number; right: number; }

let state: TransportState = { isPlaying: false, positionSec: 0, loopActive: false, loopStart: 0, loopEnd: 0 };
const listeners = new Set<() => void>();

export function setTransport(patch: Partial<TransportState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function getTransport(): TransportState { return state; }
export function subscribeTransport(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Nur für primitive Selektoren verwenden (Referenzstabilität). */
export function useTransport<T>(select: (s: TransportState) => T): T {
  return useSyncExternalStore(subscribeTransport, () => select(getTransport()));
}
```

### C.2 Playhead-Treiber (außerhalb von React)
```ts
// src/features/transport/playheadDriver.ts
import { getTransport, setTransport } from '../../state/transportStore';

export interface MeterSink { push(m: { left: number; right: number }): void; }
export interface PlaybackPort { getCurrentTime(): number; getIsPlaying(): boolean; getMasterMeter(): { left: number; right: number }; }

export function startPlayheadDriver(port: PlaybackPort, meters: MeterSink, onAutoScroll: (pos: number) => void) {
  let raf = 0;
  let lastMeterAt = 0;
  const tick = (now: number) => {
    if (port.getIsPlaying()) {
      const pos = port.getCurrentTime();
      if (pos !== getTransport().positionSec) setTransport({ positionSec: pos });
      onAutoScroll(pos);                       // Viewport als Store-Wert, kein React-State
      if (now - lastMeterAt >= 50) {           // 20 Hz reichen für VU
        meters.push(port.getMasterMeter());
        lastMeterAt = now;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
```

### C.3 Canvas-Layer mit Dirty-Flag
```ts
type LayerKey = string; // `${trackId}:${analysisVersion}:${viewOffset}:${viewDuration}:${w}:${h}:${dpr}:${mode}`
let lastBaseKey: LayerKey | null = null;

function drawBase(key: LayerKey, paint: () => void) {         // Basis: Wellenform, Grid, Phrasen
  if (key === lastBaseKey) return;
  lastBaseKey = key;
  paint();
}
let pendingOverlay: (() => void) | null = null;
let overlayRaf = 0;
function flushOverlay(canvas: HTMLCanvasElement) {
  overlayRaf = 0;
  const paint = pendingOverlay; pendingOverlay = null;
  paint?.();                                                  // nur einmal pro Frame
}
function drawOverlay(paint: () => void, canvas: HTMLCanvasElement) {  // Overlay: Playhead, Auswahl, Hover
  pendingOverlay = paint;                                     // koalesziert im nächsten rAF
  if (!overlayRaf) overlayRaf = requestAnimationFrame(() => flushOverlay(canvas));
}
```

### C.4 Schneller Segment-Mixdown
```ts
// in renderEditSegments(): schleifenfreier Pfad, wenn kein Resampling/Overdub nötig
const noResample = Math.abs(source.sampleRate - outputRate) < 1e-9;
if (noResample && segment.type !== 'OVERDUB') {
  const src = source.getChannelData(Math.min(channel, source.numberOfChannels - 1));
  const srcOffset = Math.round(segment.sourceStart * source.sampleRate);
  destination.set(src.subarray(srcOffset, srcOffset + destinationLength), destinationStart);
  continue;
}
// sonst: bestehender sample-genauer Pfad (Overdub/Oversampling) unverändert
```

### C.5 Benchmark-Skript (WP-01)
```js
// scripts/bench-waveform.mjs  (Aufruf: npx tsx scripts/bench-waveform.mjs --json)
// Hinweis: Der Import setzt die tsx-Laufzeit voraus – analog zu scripts/stems-diagnose.ts.
import { performance } from 'node:perf_hooks';
const { analyzeAudioBuffer } = await import('../src/waveform/analyzer.ts');
const { sampleWaveformColumn } = await import('../src/waveform/spectralColor.ts');
// … Mock-Buffer erzeugen, analyzeAudioBuffer messen, 1920 Spalten für 18-s- und Full-Track-Fenster messen,
// Ergebnis als JSON ausgeben: { analyzeMs, columns18sMs, columnsFullMs }
```

### C.6 History-Eintrag ohne Audiokopie
```ts
export interface HistoryEntry {
  description: string; timestamp: number;
  segments: EditSegment[];      // strukturkloniert (klein)
  cues: CuePoint[];
  selection: SelectionRange | null;
  duration: number;
  analysis?: WaveformAnalysisData;   // geteilte TypedArrays, unveränderlich behandelt
}
// Restore: workingBuffer = renderEditSegments(track.audioBuffer, entry.segments)
```

### C.7 CI-Job `quality-linux.yml` (Phase 0)
```yaml
name: Qualität (Linux)
on: [push, pull_request]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci --ignore-scripts
      - run: npm run lint
      - run: node scripts/run-tests.mjs
      - run: npx vite build
      - run: node scripts/check-bundle-budget.mjs
```

---

## Anhang D · Reihenfolge als Checkliste

- [x] Phase 0: `npm run verify`, Benchmarks, Budgets, Linux-CI, Baseline-Tag  *(erledigt 04.10.2026; Tag lokal gesetzt, noch nicht zu GitHub übertragen)*
- [x] Phase 1: Transport-Store + Treiber → Canvas-Layer/DPR → Logger-Batching → Code-Splitting/Budget → toten Code & Root-Clutter entfernen  *(erledigt 04.10.2026; `React.memo` bewusst nach WP-06 verschoben, siehe Statusbericht Abschnitt 3)*
- [ ] Phase 2: Command-Registry + `App.tsx`-Dekomposition (Schritte 1–5, 8) → History ohne Audiokopien → ESLint + `strictNullChecks` → DOM-Testharness
- [ ] Phase 3: `strict: true` → Engine-Zustandsmaschine + Mixdown → Analyse-Cache/Worker → Speicher-Budgets → IO-Entdopplung/XML-Worker → Server-Router
- [ ] Phase 4: Electron-Modularisierung + IPC-Vertragstest → Perf-Harness/Budgets/Coverage in CI → Observability → Release-Bericht
