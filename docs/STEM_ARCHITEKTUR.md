# STEM-Architektur — Aufbau & Skizze

airdox_SMART_Editor · Stand 18.09.2026 · verifiziert gegen `main` @ `e5fe650`
(Arbeitsbranch `arena/01a0b3f4-airdox-editor`)

Dieses Dokument ist die **Skizze** der Stem-Separation: Schichten, Datenfluss,
Verträge, Invarianten. Die Detaildokumentation der Engine steht in
[`STEM_SEPARATION_ENGINE.md`](./STEM_SEPARATION_ENGINE.md), der UI-/Demucs-Pfad
in [`STEM_SEPARATION.md`](./STEM_SEPARATION.md). Alles hier ist gegen den
aktuellen Quellcode geprüft (Abschnitt 10 listet die ausgeführten Checks), und
Abschnitt 11 nennt die Stellen, an denen die älteren Dokumente vom Code
abweichen.

Grafische Übersicht: [`assets/stem-architektur.svg`](./assets/stem-architektur.svg)

---

## 0. In fünf Sätzen

1. Die Stem-Separation ist ein **GUI-freier Kern** (`src/stems/`, 9.958 Zeilen TS),
   der über genau zwei Transporte (Electron-IPC und HTTP/SSE) an den Editor
   angebunden ist — beide Transporte nutzen dieselbe Implementierung
   (`StemJobService`).
2. Separation ist immer **Inferenz eines trainierten Modells** (primär
   BS-RoFormer); spektrale DSP-Verfahren (`stftSeparator`) sind aus dem
   Produktionspfad entfernt und werfen `STEM_ENGINE_UNAVAILABLE`.
3. Das Original ist **read-only**: sha256 vor und nach jedem Lauf, jede
   Transformation auf einer Arbeitskopie, Ergebnis erst nach bestandener
   Validierung im Zielordner.
4. Der Kern kennt keine Modell-Details — Modell, Stem-Reihenfolge, Overlap,
   Präzision und Profil kommen aus `modelCatalog.json` (`ModelRegistry`), die
   Backend-Wahl läuft über das einzige Interface `IStemSeparator`.
5. Ohne verifizierten Checkpoint (`modelHash: "unverified"` / fehlend) ist die
   Engine `UNAVAILABLE`; es wird dann **kein** Stem fabriziert, sondern
   `STEM AI UNAVAILABLE` mit Diagnose angezeigt.

---

## 1. Schichtenmodell

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 1 · RENDERER (React, Browser-Kontext, kein node:*)                                        │
│   DeckStemsControl ─ StemQualityWarningModal ─ App.tsx (Wiring)                           │
│   audio/stemEngine.ts (Client-Fassade: Verfügbarkeit, Job, Cache, Abbruch)                │
│   audio/stemPlayback.ts + audioEngine.ts (Solo/Mute/Volume, Acapella, Reset)              │
└───────────────────────────────────────┬───────────────────────────────────────────────────┘
                                        │  Vertrag: src/stems/transportTypes.ts
                                        │  (StemJobView · StemServiceStatus · StemDesktopApi)
              ┌─────────────────────────┴──────────────────────────┐
              │ 2 · TRANSPORT                                      │
   ┌──────────▼───────────────────────┐        ┌───────────────────▼─────────────────────┐
   │ Desktop (Electron)               │        │ Browser / Dev-Server                    │
   │ electron/preload.cjs             │        │ server.ts (Express)                     │
   │ electron/stemEngineBridge.cjs    │        │ /api/stems/engine · /api/stems/jobs…    │
   │ 11 IPC-Kanäle `stems:*`          │        │ SSE /jobs/:id/events                    │
   │ Bundle: dist/stems/node-bridge.cjs        │ import direkt aus src/stems             │
   └──────────┬───────────────────────┘        └───────────────────┬─────────────────────┘
              └─────────────────────────┬──────────────────────────┘
┌───────────────────────────────────────▼───────────────────────────────────────────────────┐
│ 3 · JOB-SCHICHT  src/stems/stemJobService.ts (554 Z.)                                      │
│   Job-Id sofort · Event-Stream · Pause/Resume/Cancel · Cache-Hit · Einzel-Stem-Download    │
│   Verzeichniswurzeln: Working/ · Separation/ · Cache/ · Models/ · Staging/                 │
│   (Renderer-Bytes landen in Staging/ — die Quelldatei wird nie beschrieben)                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 4 · ENGINE-KERN  src/stems/stemSeparationEngine.ts (647 Z.)                                │
│   Preprocessor → ModelManager → Backend-Wahl → Chunk-Plan → Inferenz → Overlap-Add →       │
│   Validierung → Promotion/Cache → Integritätsprüfung des Originals                         │
│   Helfer: modelRegistry · modelManager · stemRegistry · chunkProcessor · reconstructor ·   │
│           qualityValidator · separationJob · separationCache · wavIo                       │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 5 · BACKENDS  src/stems/backends/  — einziges Interface: IStemSeparator                    │
│   BSRoFormerSeparator · MelBandRoFormerSeparator · HTDemucsSeparator · PipelineDouble*     │
│   processTransport.ts: JSONL-Protokoll + Exit-Code-Map + SIGTERM                            │
│   (* PipelineDoubleSeparator ist ein Test-Double, kein Modell — nur mit allowPipelineDouble)│
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 6 · RUNTIME & MODELLE  src/stems/runtime/ (1.751 Z.)                                       │
│   pathResolver (deterministisch, kein app.asar/.venv) · pythonRuntime (3.9–3.13) ·         │
│   modelRegistry v2 (Status AVAILABLE … NOT_INSTALLED) · checkpointIntegrity (sha256) ·     │
│   preflight (11 Checks, 10 kritisch) · diagnostics                                          │
│   Gewichte/Config: resources/models/ bzw. ~/.cache/airdox-stems/checkpoints/                │
│   Interpreter: resources/stem-runtime/python.exe (prod) bzw. .venv (dev)                    │
└───────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                        │ JSONL über stdout, Exit-Codes
┌───────────────────────────────────────▼─────────────────────────────────────────────────────┐
│ 7 · INFERENZ  python/bsroformer_inference.py (466 Z.) → models.bs_roformer.BSRoformer (Torch)│
│   Quelle: AIRODOX_MSST_DIR (Checkout) oder PyPI-Paket `msst`; Ziel: natives C++-Binary       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

   quer dazu, rechts am Kern:  QUALITÄTSGATES
   qualityValidator (Datei/Header/Hash/Rekombination/Grenzen) · qualityGate (10 technische
   Checks) · metrics + goldStandard(+Variants) + stemIsolationGate (Release-Entscheidung)
```

### Schichtregeln (aus dem Code abgeleitet)

| Regel | Wo erzwungen |
|---|---|
| Renderer darf kein `node:*` sehen | `transportTypes.ts` ist der einzige Grenzvertrag, geprüft von `tests/stem-engine-ipc-contract.test.ts` |
| Kern ist GUI-frei | `src/stems/*` importiert weder React noch Electron |
| Kern kennt keine Modellfamilie | nur `IStemSeparator` (`backends/types.ts`), Descriptor aus `ModelRegistry` |
| Python ist Entwicklungstransport | `python/bsroformer_inference.py` spricht exakt das JSONL-Protokoll; natives Binary hat Vorrang (`createDefaultBackendFactory`) |
| Kein Stem ohne verifiziertes Modell | `runtime/modelRegistry.ts` (`unverified` → `LICENSE_UNVERIFIED`), `runtime/preflight.ts` |

---

## 2. Datenfluss einer Separation

Reihenfolge exakt wie in `stemSeparationEngine.separate()`:

```
ORIGINAL/track.wav                                  ← nie beschrieben
  │ 1  decode, sha256 „vorher“ (preprocessor/verifyOriginalIntegrity)
  ▼
Working/<track>_44.1k_stereo.wav                    ← 44,1 kHz, Stereo, float32
  │ 2  ModelManager.ensureDescriptorAvailable()  (Checkpoint VOR Backend-Probe)
  │ 3  Backend-Wahl: native-cli → python-torch → BACKEND_UNAVAILABLE
  │ 4  StemRegistry aus dem Deskriptor (Stem-Namen nie geraten)
  │ 5  cacheKey = hash(inputAudioHash, modelHash, settingsHash)
  │ 6  archivePreviousRun → Separation/<track>/.history/<jobId>_<hash>
  │ 7  Cache-Lookup → Treffer: materialise + validieren → COMPLETED (cacheHit)
  │ 8  planChunks() + validateChunkPlan()  (Lücken → STEM_CONFIG_INVALID)
  ▼
je Chunk: chunk_NNNN.wav ──▶ backend.separate() ──▶ Stem-WAVs
  │ 9  stemRegistry.mapOutputs(), Kanal-/Frame-Plausibilität,
  │     OverlapAddReconstructor.add(plan, data)
  ▼
  │10  finalize() + postprocess(clipMode, dcRemoval) → Separation/<track>/.partial/*.wav
  │11  validateSeparation(): Datei, Header, Frames, Samplerate, Kanäle, NaN,
  │     Peak, DC, Rekombinationsfehler, Chunk-Grenzmetrik
  ▼
Separation/<track>/{vocals,drums,bass,other}.wav    ← Promotion erst nach PASS
  │12  job.json (reproduzierbar) + Cache-Eintrag
  │13  sha256 „nachher“ → Abweichung = ORIGINAL_MODIFIED (harter Fehler)
  ▼
Cache/<inputHash:modelHash:settingsHash>/
```

Fortschritts-Marken im Code: `2 %` Original geprüft → `8…82 %` Chunks
(`base 8 + 74` verteilt) → `60 %` bei Cache-Treffer → `86 %` Overlap-Add →
Validierung → `COMPLETED`.

**Job-Statusmaschine** (`types.ts`, 8 Zustände):

```
PENDING → PREPARING → RUNNING → RECONSTRUCTING → VALIDATING → COMPLETED
                 │         │                                        │
                 └─────────┴──▶ CANCELLED        FAILED ◀───────────┘
                              (Abbruch/Pause)   (Validierung/Fehler)
```

---

## 3. Verträge an den vier Grenzen

### 3.1 Renderer ↔ Host (`transportTypes.ts`)

`StemJobView` (jobId, status, percent, phase, profile, modelId, `stems` aus dem
Deskriptor, chunkCount, cacheHit, `result{validationPass, recombinationErrorDb,
originalUnchanged, trainedModel}`), `StemServiceStatus`, `StemDesktopApi`.
Versioniert über `STEM_BRIDGE_VERSION = 1`.

### 3.2 IPC-Kanäle (Desktop)

`stems:engine-status`, `stems:job-start`, `stems:job-wait`, `stems:job-get`,
`stems:job-list`, `stems:job-cancel`, `stems:job-pause`, `stems:job-resume`,
`stems:job-stem`, `stems:job-metadata`, `stems:job-progress` (Push).
Legacy/Diagnose: `stems:get-status`, `stems:diagnostics`, `stems:preflight`,
`stems:separate`, `stems:install-engine` (+ `stems:install-progress`).

### 3.3 HTTP-Routen (Browser/Dev)

`GET /api/stems/engine` · `POST /api/stems/jobs` (202) · `GET /api/stems/jobs`
· `GET /api/stems/jobs/:id` · `GET /api/stems/jobs/:id/events` (SSE) ·
`POST …/cancel|pause|resume` · `GET …/metadata` ·
`GET …/stems/:stemId` (ein Stem pro Request — 4 × float32 sind schnell 250 MB).
Legacy: `/api/stems/status`, `/api/stems/install`, `/api/stems/separate`.

### 3.4 Backend-Prozess (JSONL + Exit-Codes)

```json
{"type":"progress","fraction":0.42,"phase":"chunk 2/5"}
{"type":"stem","index":0,"name":"vocals","path":"/abs/stem_0_vocals.wav"}
{"type":"log","level":"warning","message":"…"}
{"type":"error","code":"GPU_OUT_OF_MEMORY","message":"…"}
{"type":"done","device":"cpu","stems":[…],"report":{…}}
```

`0` ok · `130` `INFERENCE_CANCELLED` · `2` `STEM_CONFIG_INVALID` ·
`3` `MODEL_CORRUPT` · `4` `WRITE_DENIED` · `5` `AUDIO_CORRUPT`.
Protokoll-`error` schlägt die Exit-Map; ohne `done` gilt `INFERENCE_FAILED`;
startet der Prozess nicht: `BACKEND_UNAVAILABLE`. CUDA-OOM führt zu einem
CPU-Retry (`cpuFallback`), erst wenn auch der scheitert: `GPU_UNAVAILABLE`.
Insgesamt kennt der Kern **33 `StemErrorCode`-Werte** (`types.ts:304`).

---

## 4. Modell-Registry & Qualitätsprofile

`ModelRegistry.fromBundledCatalog()` liest `src/stems/modelCatalog.json`
(`catalogVersion 2026-09-18`) und meldet aktuell **Content-Hash
`eb1d74049ca9225f`**, 5 Modelle:

| id | Familie | `stemOrder` | bedient Profile | `modelHash` |
|---|---|---|---|---|
| `bsroformer-musdb18hq-4stem-zfturbo` | `bs_roformer` | drums, bass, other, vocals | PREVIEW…MAXIMUM_QUALITY | `3e9daecd70aa…` (gepinnt) |
| `bsroformer-viperx-vocals-1297` | `bs_roformer` | vocals, other | BALANCED…MAXIMUM_QUALITY | `unverified` |
| `melbandroformer-viperx-vocals-3005` | `mel_band_roformer` | vocals, other | BALANCED, HIGH | `unverified` |
| `htdemucs-ft-4stem` | `htdemucs` | drums, bass, other, vocals | PREVIEW (Legacy) | `unverified` |
| `pipeline-double-v1` | `pipeline_double` | vocals, drums, bass, other | PREVIEW (Test-Double) | `synthetic:…` |

Parameter kommen **nicht** aus Konstanten, sondern aus dem Deskriptor
(`parametersFor()`), Chunk-Overlap und Präferenz-Präzision aus dem Kern:

| Profil | numOverlap / Ensemble (Primärmodell) | Chunk-Overlap | Präzisions-Präferenz |
|---|---|---|---|
| `PREVIEW` | 2 / 1 | 0,25 | q8_0 → f16 → bf16 → f32 |
| `BALANCED` | 4 / 1 | 0,50 | f32 → native → bf16 → f16 |
| `HIGH` | 4 / 1 | 0,50 | f32 → native → bf16 → f16 |
| `HIGH_QUALITY` | 4 / 1 | 0,50 | f32 → native → bf16 → f16 |
| `MAXIMUM_QUALITY` | **6 / 3** | 0,60 | f32 → native → bf16 → f16 |

`MAXIMUM_QUALITY` erhöht also innere Overlaps **und** Ensemble-Pässe; beides
wird bis ins Backend durchgereicht. Chunk-Größe des Primärmodells:
131.584 Samples. Weicht die `stemOrder` des Deskriptors von der
Checkpoint-Config ab → `MODEL_INCOMPATIBLE` statt falsch benannter Stems.

---

## 5. Runtime-Auflösung & Packaging

**Pfad-Reihenfolge Runtime** (`resolveStemRuntime`, Ausgabe von
`npm run stems:diagnose`): `env override` → `resources/stem-runtime/bin/python3`
(prod) → `%APPDATA%/airdox_SMART_Editor/stems/stem-runtime` → `.venv` (nur dev)
→ `python`/`python3` ausschließlich für Diagnose. `app.asar`-Pfade werden
explizit gefiltert — der Produktionsfehler `resources/app.asar/.venv/…` ist
dadurch konstruktiv ausgeschlossen.

**Python:** unterstützt 3.9–3.13; 3.14 wird mit `PYTHON_VERSION_UNSUPPORTED`
abgelehnt. **Gewichte:** `resources/models/` (prod) bzw.
`~/.cache/airdox-stems/checkpoints/` (dev), sha256 gegen den Katalog.

**Packaging** (`package.json`): `extraResources` → `stem-runtime/`, `models/`,
`modelCatalog.json`; `asarUnpack` → `node-bridge.cjs`, `stem-runtime/**`,
`models/**`, `*.node|dll|so|dylib`, `python/**`. Ziel: `nsis` + `portable`.
Geprüft von `tests/stem-asar-unpack.test.ts` und `tests/stem-installer-paths.test.ts`.

---

## 6. Drei Qualitätsgates

| Gate | Modul | Entscheidet | Ergebnis |
|---|---|---|---|
| **Technisch** | `qualityValidator.ts` + `qualityGate.ts` | Datei/Header/Frames/Rate/Kanäle/NaN/Peak/DC, Rekombinationsfehler, Chunk-Grenzen (Klick, Pegel-, Stereo-Sprung), Stereo-Erhaltung, Cache-Reuse, Engine-Integrität — **10 Checks** | `validationPass`, Issue-Codes (`BOUNDARY_CLICK`, `RECOMBINATION_DEVIATION`, `STEM_FRAME_MISMATCH`, …) |
| **Job-Identität** | `separationJob.ts` + `separationCache.ts` | `job.json` vollständig & reproduzierbar, `.partial` → Promotion, Historie statt Überschreiben | `job.json`, `.history/` |
| **Isolation (Release)** | `stemIsolationGate.ts` + `metrics.ts` + `goldStandard*.ts` | 30-s-Goldstandard (Seed `20260913`, 6 Ground-Truth-Stems, 6 Segmente, 15 Mix-Varianten) → SI-SDR/Bleed/Transient/Stereo je Stem | `RELEASE_READY` oder `TECHNICAL_PASS_QUALITY_FAIL` |

Zentrale Anti-Fake-Regel: `runStemIsolationGate()` erkennt zufällige Gewichte
(`detectRandomWeights()`, `capabilities().trainedModel`) und setzt dann **hart**
`qualityPass = false` / `TECHNICAL_PASS_QUALITY_FAIL` — ein Qualitäts-`PASS`
ohne trainierte Separation ist nicht darstellbar. Der Live-Gate
(`tests/stem-isolation-gate-live.test.ts`) läuft nur mit
`AIRODOX_STEM_ALLOW_QUALITY_RUN=1` und installiertem Checkpoint, sonst SKIP.

---

## 7. Invarianten (Kern der Architektur)

1. **Original read-only** — sha256 vor/nach; `ORIGINAL_MODIFIED` ist ein harter
   Fehler, auch auf Fehler- und Abbruchpfaden.
2. **Separation = Modell** — kein Regelwerk, kein Spektral-Filter;
   `stftSeparator.ts` liegt nur noch als Referenz im Repo und wird von
   `App.tsx`/`stemEngine.ts` nicht importiert.
3. **Kein stiller Qualitäts-Downgrade** — fehlende Engine ⇒ Dialog +
   `STEM AI UNAVAILABLE`, nie ein „Low-Quality-Stem“.
4. **Qualität vor Tempo** — in HIGH/MAXIMUM_QUALITY werden nie automatisch die
   schnellsten Parameter gewählt.
5. **Keine Checkpoint-Hardkodierung** — Modell, Stems, Overlap, Präzision aus
   der Registry; die UI zeigt `stems.stemIds` aus dem Deskriptor.
6. **Validierung vor Sichtbarkeit** — Stems erscheinen erst nach bestandenem
   Gate im Zielordner; davor liegen sie in `.partial/`.

---

## 8. Modulverzeichnis (Zeilen gezählt mit `wc -l`)

**Kern `src/stems/` — 7.183 Z.** · `types.ts` 348 · `stemSeparationEngine.ts` 647 ·
`stemJobService.ts` 554 · `stemIsolationGate.ts` 494 · `wavIo.ts` 441 ·
`metrics.ts` 439 · `goldStandard.ts` 527 · `reconstructor.ts` 349 ·
`qualityValidator.ts` 304 · `modelManager.ts` 285 · `mixEffects.ts` 279 ·
`qualityGate.ts` 267 · `modelRegistry.ts` 261 · `testAudioGenerator.ts` 269 ·
`chunkProcessor.ts` 213 · `preprocessor.ts` 207 · `separationCache.ts` 186 ·
`separationJob.ts` 184 · `goldStandardVariants.ts` 161 · `stemRegistry.ts` 139 ·
`nodeBridge.ts` 136 · `transportTypes.ts` 143 · `dsp.ts` 222 ·
`stemGroupMapping.ts` 67 · `errors.ts` 61

**Backends — 1.024 Z.** · `roformerSeparator.ts` 329 · `processTransport.ts` 295 ·
`pipelineDoubleSeparator.ts` 182 · `htDemucsSeparator.ts` 120 · `types.ts` 98

**Runtime — 1.751 Z.** · `pathResolver.ts` 373 · `diagnostics.ts` 318 ·
`modelRegistry.ts` 309 · `preflight.ts` 274 · `pythonRuntime.ts` 208 ·
`checkpointIntegrity.ts` 146 · `types.ts` 72 · `errors.ts` 51

**Anbindung — 1.835 Z.** · `src/audio/stemEngine.ts` 782 · `stemPlayback.ts` 74 ·
`stemEngineInstaller.ts` 90 · `electron/stemRuntime.cjs` 509 ·
`electron/stemEngineBridge.cjs` 241 · `electron/stemInstaller.cjs` 139

**Python — 592 Z.** · `bsroformer_inference.py` 466 · `install_bsroformer.py` 126

**Tests:** 21 Dateien `tests/stem-*` (10 in der CI-Gruppe `--group stems`).

---

## 9. Verifikation (dieses Dokuments)

Ausgeführt am 18.09.2026 in der Sandbox (Node v22.22.3, ohne installierten
Checkpoint — deshalb `UNAVAILABLE`, was der erwartete Zustand ist):

| Befehl | Ergebnis |
|---|---|
| `node scripts/run-tests.mjs --group stems` | **10/10 bestanden**, 0 übersprungen, 0 fehlgeschlagen (175,5 s) |
| `npx tsx tests/stem-negative-unavailable.test.ts` | PASS — `separateAudioBuffer` blockiert, `STEM_ENGINE_UNAVAILABLE`, Original unverändert, 3 unverified-Modelle nicht AVAILABLE |
| `npx tsx tests/stem-preflight-diagnostics.test.ts` | PASS — 11 Checks, 10 kritisch; Namen: Runtime, Python, Torch, GPU, Model, Config, Checkpoint, Hash, Audio backend, Write permissions, Test inference; Status `UNAVAILABLE` |
| `npm run stems:diagnose` | Engine `UNAVAILABLE`, Model `MISSING_CHECKPOINT`, Checkpoint verified `false`, Preflight `UNAVAILABLE`; Runtime-Kandidaten ohne `app.asar` |
| `npx tsc --noEmit` | Exit 0 (keine Typfehler) |
| `grep -rn stftSeparator src/ electron/ server.ts tests/ scripts/` | keine Treffer — Spektral-Fallback ist tot im Produktionspfad |

Nicht ausgeführt: die Live-Suiten (`test:stems:live`, `test:stems:gate`) — sie
brauchen einen trainierten Checkpoint und PyTorch, die hier nicht installiert
sind. Ein echtes Qualitäts-`PASS` ist in dieser Umgebung nicht erreichbar.

---

## 10. Abweichungen: Doku ↔ Code (korrigiert)

| Ältere Aussage | Tatsächlicher Code-Stand |
|---|---|
| `STEM_SEPARATION_ENGINE.md` §3: „20 Fehlercodes“ | `types.ts:304` definiert **33** `StemErrorCode`-Werte |
| `STEM_SEPARATION_ENGINE.md` §4: Content-Hash `91db7a913ae42946` | `ModelRegistry.contentHash()` liefert **`eb1d74049ca9225f`** |
| §5 nennt drei Profile (PREVIEW/HIGH_QUALITY/MAXIMUM_QUALITY) | `QualityProfile` hat **fünf**: PREVIEW, BALANCED, HIGH, HIGH_QUALITY, MAXIMUM_QUALITY |
| §5: HIGH_QUALITY = „num_overlap 4, Ensemble 1“ | korrekt; zusätzlich BALANCED = 4/1 und PREVIEW = 2/1 beim Primärmodell |
| `STEM_SEPARATION.md` beschreibt Demucs als ausgelieferten Stem-Pfad | Demucs/htdemucs bedient nur noch `PREVIEW`; `stems:get-status` meldet BS-RoFormer primär und Demucs nur informativ |

---

## 11. Offene Punkte

1. **Natives C++-Runtime-Binary fehlt** — Vertrag (`audiocpp_cli`) implementiert
   und getestet, Binary nicht gebaut; der Python-Pfad ist Entwicklungswerkzeug.
2. **Checkpoint nicht gebündelt** — für `READY` müssen
   `resources/stem-runtime/python.exe` und
   `resources/models/model_bs_roformer_ep_17_sdr_9.6568.ckpt`
   (sha256 `3e9daecd…`) im Build liegen.
3. **Mixer-Desk hat vier Slots** — Modelle mit 2 oder 6 Stems laufen sauber
   durch Engine und Validierung, `buildTrackStems` bricht aber mit klarer
   Meldung ab statt Stems zu ignorieren.
4. **Fenster-Setup-Skripte** (`scripts/setup-stem-model.ps1`) sind auf Windows
   gegenzuprüfen; hier nur Linux-Pfad verifiziert.
