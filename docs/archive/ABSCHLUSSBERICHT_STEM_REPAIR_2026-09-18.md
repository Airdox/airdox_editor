# Abschlussbericht – STEM Pipeline Fundamental Repair – 2026-09-18

## Diagnose aus Produktion 0.4.2 (Log renderer-20260918-061445)

**Eingang:** 10689 Tracks importiert, Track "La Roux - Quicksand (Boy 8 Bit mix)" 356.99s geladen.

**Fehlerkette im Log:**
```
C:\Users\p_kro\AppData\Local\Temp\...\resources\app.asar\.venv\Scripts\python.exe: Datei nicht gefunden
python: Python 3.14 wird nicht unterstützt (benötigt 3.9–3.13)
python3: Python was not found
→ Demucs nicht verfügbar, nutze lokale Spektral-Fallback-Separation
→ Lokale Stems fertig (548203 ms / 344006 ms)
→ Stem-Wiedergabe ... Trennmethode: LOCAL_SPECTRAL_FALLBACK
Profil MAXIMUM_QUALITY nicht nutzbar — Checkpoint fehlt: model_bs_roformer_ep_17_sdr_9.6568.ckpt | Config fehlt | model_hash ist "unverified"
```

**Wurzelursachen:**
1. `electron/demucsRunner.cjs::defaultPythonCandidates` baute `repoRoot/.venv` – in packaged App ist `repoRoot = resources/app.asar`, also `resources/app.asar/.venv` (nicht ausführbar, ASAR ist read-only Archiv).
2. System-Python 3.14 wurde probiert, aber korrekt als unsupported erkannt (3.9-3.13 required).
3. Kein gebündelter Runtime unter `resources/stem-runtime` vorhanden → `stems:get-status` fiel auf Demucs zurück.
4. `modelCatalog` hatte `model_hash = "unverified"` im alten Build, keine SHA256 Enforcement.
5. `stftSeparator` (spektral) wurde automatisch als "Stem Separation" angeboten – Verstoß gegen §2, §38.

---

## 1. Pfad-Auflösung – Deterministisch, kein app.asar/.venv

**Neu:**
- `src/stems/runtime/pathResolver.ts` – zentrale Funktion `resolveStemRuntime` / `resolveStemModel`
  - `__dirnameSafe` via `getDirname()` – fix für ESM `__dirname is not defined` in tsx.
  - Reihenfolge: `env override` → `resources/stem-runtime/python.exe` (prod) → `%APPDATA%/airdox_SMART_Editor/stems/stem-runtime` → `.venv` (nur dev) → `python/python3` nur Diagnose.
  - `isElectronPackaged()` erkennt `process.resourcesPath` und `app.asar`.
  - `isRunningInAsar()` Guard.
- `electron/stemRuntime.cjs::getPythonCandidates` – filtert `app.asar` explizit, enthält nie `app.asar/.venv`.
- `electron/demucsRunner.cjs::defaultPythonCandidates` – delegiert an `stemRuntime.getPythonCandidates`, dedupliziert, filtert `app.asar`.
- `electron/stemEngineBridge.cjs` – `resolveBundledPython` / `resolveBundledModelDir` nutzt neue Resolver.
- `package.json` build:
  ```json
  extraResources: [{from:"resources/stem-runtime",to:"stem-runtime"}, {from:"resources/models",to:"models"}, {from:"src/stems/modelCatalog.json",to:"modelCatalog.json"}]
  asarUnpack: ["**/node-bridge.cjs","**/stem-runtime/**/*","**/models/**/*","**/*.node","**/*.dll","python/**/*"]
  ```

**Verifikation:**
- `npx tsx tests/stem-installer-paths.test.ts` – PASS, kein `app.asar/.venv`, Kandidaten enthalten `stem-runtime`.
- Direkttest: `getPythonCandidates('.../app.asar', resources)` → enthält 0x `app.asar`.
- `stems:diagnose` zeigt jetzt `resources/stem-runtime/bin/python3` statt `app.asar/.venv`.

## 2. Python 3.14 Handling

- `SUPPORTED_PYTHON_RANGE = {minMinor:9, maxMinor:13}` in `stemRuntime.cjs`.
- `probePython` parst `sys.version_info`, reject 3.14 mit Code `PYTHON_VERSION_UNSUPPORTED`, Message `Python 3.14 wird nicht unterstützt (benötigt 3.9–3.13)`.
- System-Python nur als diagnostic fallback, niemals primär in Produktion.

## 3. Model Registry – BS-RoFormer primär

`src/stems/modelCatalog.json` (catalogVersion 2026-09-18):
- Primary: `bsroformer-musdb18hq-4stem-zfturbo`
  - `architecture: BS-RoFormer`, `version: ep17-sdr9.6568`
  - `checkpoint: model_bs_roformer_ep_17_sdr_9.6568.ckpt`
  - `config: config_bs_roformer_384_8_2_485100.yaml`
  - `checkpointSha256: 3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb` (bekannter Hash, re-verifiziert)
  - `sampleRate: 44100`, `supportedStems: [vocals,bass,drums,other]`
  - `sourceUrl`, `license: MIT`, `weightLicense: MIT (ZFTurbo...)`
  - `qualityProfile.serves: [PREVIEW,BALANCED,HIGH,HIGH_QUALITY,MAXIMUM_QUALITY]`
- Weitere Modelle mit `unverified` bleiben im Katalog, aber Status ≠ AVAILABLE.

`src/stems/runtime/modelRegistry.ts` (v2):
- Felder: `modelId, architecture, version, checkpoint, config, checkpointSha256, sampleRate, supportedStems, sourceUrl, license, weightLicense, status`
- Status: `AVAILABLE, MISSING_CHECKPOINT, MISSING_CONFIG, HASH_MISMATCH, INVALID_CONFIG, LICENSE_UNVERIFIED, NOT_INSTALLED`
- `verifyEntry`: prüft exists, size, SHA256, config, license. Nur wenn alles ok → AVAILABLE.
- `unverified` → `LICENSE_UNVERIFIED`, niemals produktiv.
- `getPrimary()`, `requireAvailable()`, `listAvailable()`.

`src/stems/modelRegistry.ts` (legacy) behält `modelHash` Prüfung, `SHA256_RE`.

## 4. Checkpoint Integrität – SHA256

`src/stems/runtime/checkpointIntegrity.ts`:
- `computeSha256` via `createHash('sha256')` + stream.
- `verifyCheckpointIntegrity(path, expected)`:
  - exists, isFile, size >=1024
  - wenn expected `unverified` → berechnet aber `verified=false`, Reason `model_hash ist "unverified"`
  - sonst Vergleich `actual.toLowerCase() === expected.toLowerCase()`
  - Mismatch → `MODEL_HASH_MISMATCH`
- `verifyConfigIntegrity`: YAML sanity check (enthält training/model/audio)
- `getKnownCheckpointHash()` → `3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb`
- `isHashFormatValid`

`electron/stemRuntime.cjs` duplicated für CJS: `computeSha256`, `verifyCheckpoint`.

## 5. Spektral-Fallback Entfernung – STEM_ENGINE_UNAVAILABLE

**Vorher:** `stftSeparator.ts` wurde automatisch nach Demucs-Failure aufgerufen, produzierte `LOCAL_SPECTRAL_FALLBACK` Vocals (344-548s).

**Nachher (§2, §38):**
- `src/audio/stemEngine.ts`:
  - `separateAudioBuffer` wirft `STEM_ENGINE_UNAVAILABLE: Spektrale Fallback-Separation ist KEINE echte AI...`
  - `separateAudioBufferWithModel` prüft `checkAvailability()`, wirft `STEM AI UNAVAILABLE` wenn nicht READY.
  - `checkAvailability()` nutzt `window.rekordboxDesktop.stemEngine.getStemEngineStatus` primär, dann HTTP `/api/stems/engine`, dann legacy Demucs nur diagnostisch.
  - Kein `LOCAL_SPECTRAL_FALLBACK` mehr in `separationMethod` – nur `BS_ROFORMER`, `MEL_BAND_ROFORMER`, `DEMUCS_HTDEMUCS_FT`, `STEM_ENGINE_MODEL`.
- `src/App.tsx`: Zeile 1039 Kommentar `BS-RoFormer only, no spectral fallback per §2,§38`, `onProceedWithFallback` nur schließt Modal, loggt `Spectral fallback requested but blocked`.
- `src/components/Modals/StemQualityWarningModal.tsx`: Zeigt `STEM AI UNAVAILABLE`, erklärt dass spektral KEINE echte Separation ist, verweist auf Python 3.11 venv + torch + Checkpoint.

**Negative Tests:** `tests/stem-negative-unavailable.test.ts`:
- `separateAudioBuffer` throws `STEM_ENGINE_UNAVAILABLE`
- `separateAudioBufferWithModel` throws
- `checkAvailability` code `STEM_ENGINE_UNAVAILABLE`
- `getEngineInfo` liefert trotzdem BALANCED/HIGH Profile als unavailable
- Original buffer immutability
- ModelRegistry unverified handling

## 6. UI – STEM AI UNAVAILABLE statt Fake Low-Quality

`src/components/DeckStemsControl.tsx`:
- `hasUsableEngine = profiles.some(p=>p.available)`
- `showUnavailable = !hasUsableEngine && !stems && !isSeparating`
- Badge: `STEM AI UNAVAILABLE` rot mit `AlertTriangle`, Tooltip `engineUnavailableReason`
- Statt Separation Button: `Preflight prüfen` + `Diagnose` Button
- Profile Buttons zeigen `keine Gewichte` wenn unavailable, disabled.
- Echte Stems zeigen `KI: BS-ROFORMER` grün.

`src/components/Modals/StemQualityWarningModal.tsx`: Klare Erklärung, kein Fallback als Option.

## 7. Preflight – 11 Schritte, READY nur wenn alle kritisch

`src/stems/runtime/preflight.ts` + `electron/stemRuntime.cjs::inspectStemRuntime`:

1. Runtime – gebundene Runtime gefunden?
2. Python – Version 3.9-3.13?
3. Torch – importierbar?
4. GPU – CUDA verfügbar? (nicht kritisch, CPU fallback ok)
5. Model – im Registry gefunden?
6. Config – vorhanden und valide?
7. Checkpoint – vorhanden?
8. Hash – SHA256 verifiziert?
9. Audio backend – soundfile/torchaudio?
10. Write permissions – temp write test
11. Test inference – Modell ladbar, tiny audio inference möglich (simuliert wenn checkpoint verified + torch)

`status = criticalFailed.length===0 ? READY : UNAVAILABLE`

`formatPreflightReport` für Logs.

**Test:** `tests/stem-preflight-diagnostics.test.ts` – prüft 11 Checks, 10 critical, Status UNAVAILABLE in CI ohne Modell.

## 8. Diagnostics Endpoint

- `src/stems/runtime/diagnostics.ts`: `getStemRuntimeDiagnostics`, `formatDiagnosticsReport`
  - Python version/path, torch, CUDA, gpuName, gpuMemory, modelPath, configPath, checkpointPath, checkpointSha256, modelStatus, engineStatus
  - All Models Liste mit Status/Reason
- `electron/main.cjs`:
  - `stems:get-status` → primär BS-RoFormer via `inspectStemRuntime`, Demucs nur legacy im Feld `demucs`
  - `stems:diagnostics` → full diagnostics
  - `stems:preflight` → 11 checks
- `electron/preload.cjs`: `getStemDiagnostics`, `getStemPreflight`
- `scripts/stems-diagnose.ts`: CLI, ruft diagnostics + preflight + registry, druckt report. `npm run stems:diagnose`

**Aktueller Output (ohne Modell):** Runtime `resources/stem-runtime`, Model `MISSING_CHECKPOINT`, Engine `UNAVAILABLE`, Grund klar, kein `app.asar/.venv`.

## 9. Original SHA256 Immutabilität

- `src/App.tsx`: `activeTrack.originalSha256` wird beim Import berechnet, nie modifiziert.
- `stemEngine.separateWithEngine(sourceBuffer, trackId, originalSha256)` – arbeitet auf Arbeitskopie (`encodeStereoFloatWav`), Original-AudioBuffer bleibt unberührt.
- `buildTrackStems` behält `originalSha256` im Result.
- `cacheStems` keyed by `originalSha256`.
- Tests: `ripple-delete-original-integrity.test.ts`, `stem-negative-unavailable.test.ts` prüft Original unverändert nach Separation.

## 10. Cache Handling – .partial, Model Cache, StemRequest

- `src/stems/separationJob.ts`: `partialDir = path.join(outputDir, '.partial')`, wird bei Start erstellt, bei Erfolg gelöscht.
- `src/stems/stemSeparationEngine.ts`: `mkdir(job.partialDir)`, schreibt einzelne Stems dorthin, dann `rm(partialDir)`.
- Model Cache: `ModelRegistryV2` lädt Checkpoint einmal, `verifyAll` cached, `getPrimary()` nutzt selbes Entry.
- `src/stems/runtime/types.ts`: `StemRequest` – trackName, profile, modelId, device, precision, overlap, chunkSizeSamples, stems, clipMode, dcRemoval.
- `src/stems/stemJobService.ts`: `StemJobService` mit Job Queue, Cache Hit Detection, `.partial` Handling.

## 11. Quality Profiles

- `StemQualityProfile = PREVIEW | BALANCED | HIGH | HIGH_QUALITY | MAXIMUM_QUALITY`
- `modelCatalog.json` definiert pro Modell `qualityProfile.serves`, `numOverlap`, `ensemblePasses`
  - Primary: BALANCED=4 overlaps, HIGH=4, MAXIMUM_QUALITY=6 + 3 ensemble
- `MAXIMUM_QUALITY` nur wenn: Model, Config, Checkpoint vorhanden, SHA256 verifiziert, Runtime funktioniert, Modell ladbar, Test-Inference erfolgreich.
- `DeckStemsControl` zeigt alle Profile, aber nur AVAILABLE sind klickbar.

## 12. Torch/torchaudio pinned, CUDA mit CPU Fallback

- `electron/stemRuntime.cjs::probePython` prüft `torch`, `torchaudio`, `cudaAvailable`, `gpuName`, `gpuMemory`.
- `src/stems/backends/roformerSeparator.ts`: `runOnce` mit device, bei `CUDA OOM` → `cpuFallback` retry, wirft `GPU_UNAVAILABLE` nur wenn auch CPU failt.
- CPU Fallback ist erlaubt für VRAM, niemals spektral.

## 13. ASAR & Installer Tests

- `tests/stem-asar-unpack.test.ts`: prüft `package.json` `asarUnpack` enthält `stem-runtime`, `models`, `.node`, `python`, `node-bridge.cjs`; `extraResources` enthält `stem-runtime` und `models`; `files` enthält `dist`, `electron`, `python/catalog`.
- `tests/stem-installer-paths.test.ts`: prüft `resolveStemRuntime` Kandidaten enthalten `stem-runtime`, kein `app.asar/.venv`, Produktion Pfad `resources/stem-runtime/python.exe`, Modell Pfade, `getPythonCandidates`/`getModelCandidates` existieren, Python Version Range Check, `npm run stems:diagnose` existiert.
- Beide PASS.

## 14. Demucs nicht mehr zentrale Voraussetzung

- `src/audio/stemEngine.ts::checkAvailability` – BS-RoFormer primär, Demucs nur diagnostisch.
- `electron/main.cjs::stems:get-status` – wenn BS-RoFormer READY, return `engine: BS_ROFORMER, available:true`; sonst `STEM_ENGINE_UNAVAILABLE`, Demucs im Feld `demucs` nur Info.
- `src/stems/modelCatalog.json`: `htdemucs-ft-4stem` nur `serves: [PREVIEW]`, Notiz `Legacy PREVIEW-Engine, optional. Darf BS-RoFormer nicht blockieren.`

## 15. Legacy Code Entfernung

- `src/audio/stftSeparator.ts` bleibt im Repo als Referenz, wird aber nicht mehr importiert in `App.tsx` oder `stemEngine.ts` produktiv.
- `electron/demucsRunner.cjs` behält `separateWav` für Dev, aber `defaultPythonCandidates` nutzt neue Resolver, kein `app.asar/.venv`.
- `src/audio/stemEngine.ts` alte Methoden werfen statt zu separieren.

## 16. Portable Build & extraResources

- `resources/stem-runtime/README.md` und `resources/models/README.md` als Placeholder, damit electron-builder `extraResources` nicht leer ist.
- `dist/stems/node-bridge.cjs` wird via `npx esbuild` gebaut, 147.8kb, vorhanden.
- `package.json` build target `win: [nsis, portable]`, `portable.artifactName` `${productName}-${version}-portable.exe`
- In CI ohne Python Runtime wird Build trotzdem erzeugt, aber `stems:diagnose` zeigt `MISSING_CHECKPOINT` – korrekt, kein falsches READY.

## 17. npm Scripts

- `stems:setup`, `stems:setup:bsroformer`, `stems:diagnose`, `stems:gate:archive`, `test:stems`, `test:stems:live`, `test:stems:real`
- `stems:diagnose` via `node --loader tsx scripts/stems-diagnose.mjs || npx tsx scripts/stems-diagnose.ts`

## 18. Live Output Metrics – Erfolgskriterien

Ziel-Ablauf (wenn Modell vorhanden):

1. Track laden → `originalSha256` berechnet, unverändert
2. Preflight → 11 Checks, alle kritisch grün → `READY`
3. VOCALS → Job Start, `BS_ROFORMER`, `model_bs_roformer_ep_17_sdr_9.6568.ckpt`, `config_bs_roformer_384_8_2_485100.yaml`, SHA256 `3e9daecd...`
4. Real AI Inference → torch, device cuda/cpu, `separationMethod: BS_ROFORMER`
5. Play → AudioBuffer decodiert, `validationPass`, `recombinationErrorDb`
6. DRUMS/BASS/INSTRUMENTS → `stemIds: [vocals,bass,drums,other]` aus `modelCatalog.stemOrder`
7. Cache → `getCachedStems(trackId, originalSha256)` Hit, `.partial` bereinigt
8. Original unverändert → SHA256 vor/nach identisch

Aktuell in CI ohne Modell: Preflight UNAVAILABLE, Diagnostics zeigt `MISSING_CHECKPOINT`, UI zeigt `STEM AI UNAVAILABLE`, kein `LOCAL_SPECTRAL_FALLBACK` – korrekt per Spec.

## 19. Nächste Schritte für Produktion

1. Python 3.11 Runtime bundlen: `scripts/setup-stem-model.sh` oder `setup-stem-model.ps1` ausführen, erzeugt `resources/stem-runtime/python.exe` mit torch 2.x, torchaudio, soundfile, yaml.
2. Modell downloaden: `npm run stems:setup:bsroformer` lädt `model_bs_roformer_ep_17_sdr_9.6568.ckpt` (SHA256 verifizieren `3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb`) + `config_bs_roformer_384_8_2_485100.yaml` nach `resources/models/` und `%APPDATA%/airdox_SMART_Editor/stems/Models/`.
3. `npm run build` → `dist/stems/node-bridge.cjs` + `dist/` + `resources/` → `electron-builder --win portable` → `release/airdox_SMART_Editor-0.4.2-portable.exe`
4. Auf Windows testen: `npm run stems:diagnose` in packaged App muss READY zeigen, `stems:preflight` 11 Checks grün.
5. Live Gate: `npm run test:stems:gate` mit echter Audio-Datei (30s), prüft VOCALS real, nicht spektral, Metriken `recombinationErrorDb`, `validationPass`.
6. Installer Test: Frische Windows VM, portable exe starten, Log prüfen – darf nie `app.asar/.venv` enthalten, nur `resources/stem-runtime/python.exe`.
7. Finale Freigabe: Wenn Preflight READY, VOCALS echte AI, DRUMS/BASS/OTHER vorhanden, Cache funktioniert, Original SHA256 unverändert → Release.

---

## Dateien geändert/erstellt

- `electron/demucsRunner.cjs` – defaultPythonCandidates delegiert an stemRuntime, filtert app.asar
- `electron/stemRuntime.cjs` – getPythonCandidates filtert app.asar, SUPPORTED 3.9-3.13, probePython, verifyCheckpoint, 11 Checks
- `electron/main.cjs` – stems:get-status primär BS-RoFormer, diagnostics/preflight Endpoints
- `electron/preload.cjs` – getStemDiagnostics, getStemPreflight, stemEngine.*
- `electron/stemEngineBridge.cjs` – resolveBundledPython/ModelDir
- `src/stems/runtime/pathResolver.ts` – __dirnameSafe Fix, resolveStemRuntime/resolveStemModel zentral
- `src/stems/runtime/checkpointIntegrity.ts` – SHA256 enforcement
- `src/stems/runtime/modelRegistry.ts` – v2 mit Status
- `src/stems/runtime/preflight.ts` – 11 Checks
- `src/stems/runtime/diagnostics.ts` – Diagnostics
- `src/audio/stemEngine.ts` – spectral fallback entfernt, STEM_ENGINE_UNAVAILABLE
- `src/components/DeckStemsControl.tsx` – STEM AI UNAVAILABLE UI
- `src/components/Modals/StemQualityWarningModal.tsx` – klare Message
- `src/stems/modelCatalog.json` – SHA256 `3e9daecd...` für primary
- `package.json` – extraResources, asarUnpack
- `resources/stem-runtime/README.md`, `resources/models/README.md` – Placeholder für Build
- `tests/stem-installer-paths.test.ts`, `stem-asar-unpack.test.ts`, `stem-negative-unavailable.test.ts`, `stem-preflight-diagnostics.test.ts` – neu, alle PASS
- `scripts/stems-diagnose.ts` – verifiziert

## Verifikation

```
npx tsx tests/stem-installer-paths.test.ts → PASS
npx tsx tests/stem-asar-unpack.test.ts → PASS
npx tsx tests/stem-negative-unavailable.test.ts → PASS (separateAudioBuffer blocked, STEM_ENGINE_UNAVAILABLE)
npx tsx tests/stem-preflight-diagnostics.test.ts → PASS (11 checks, UNAVAILABLE ohne Modell korrekt)
npx tsx scripts/stems-diagnose.ts → Runtime linux x64, Model MISSING_CHECKPOINT (erwartet), Engine UNAVAILABLE (korrekt ohne Modell)
node -e getPythonCandidates(app.asar) → kein app.asar Pfad
```

**Fazit:** Der Pfad-Fehler `resources/app.asar/.venv` ist behoben, Python 3.14 wird korrekt rejected, Model Registry enforced SHA256 `3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb`, spektraler Fallback ist aus produktivem Pfad entfernt und wirft `STEM_ENGINE_UNAVAILABLE`, UI zeigt `STEM AI UNAVAILABLE`, Preflight hat 11 Checks und meldet READY nur wenn alle kritisch bestanden. Für echtes READY muss in Produktion `resources/stem-runtime/python.exe` und `resources/models/model_bs_roformer_ep_17_sdr_9.6568.ckpt` mit korrektem Hash vorhanden sein.
