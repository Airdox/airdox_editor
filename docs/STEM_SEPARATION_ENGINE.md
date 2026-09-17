# Stem Separation Engine

Die Stem-Separation ist als nicht-destruktive Pipeline unter `src/stems/` implementiert. Eingabedateien werden nur gelesen; Ergebnisse und Prüfberichte liegen in eigenen Ausgabeordnern.

## Nicht-destruktiver Kern

- **ORIGINAL read-only**: sha256 vor/nach jeder Operation, `ORIGINAL_MODIFIED` hard fail
- **WORKING COPY**: 44.1kHz stereo float32, resampled via linear interpolation, kein Schreiben auf Original
- **Chunked Inference**: `planChunks` mit outer overlap (raised cosine) + inner num_overlap, Validierung via `validateChunkPlan`
- **Overlap-Add Rekonstruktion**: `OverlapAddReconstructor` mit raised cosine window, exakte Identität error <1e-6, `measureContinuity` prüft boundary click/level/stereo/transient
- **Validierung**: header, rate, channels, frames, hash, recombination -24dB trained / -90dB double (SDR), boundary click/level/stereo/transient
- **job.json Metadaten**: input hash, model hash, settings hash, backend, precision, extras, cache key `input: model: settings`, pause/cancel/resume via `SeparationCancellationToken`, history archiving, error matrix 20 codes

## ModelRegistry

Data-driven aus `src/stems/modelCatalog.json`, 5 Modelle, content hash `91db7a913ae42946`:

- Validiert required fields (id, displayName, stemOrder, outputStems, trainedModel, backend, qualityProfile, checkpoint)
- stemOrder vs outputStems (müssen als Sets matchen, Reihenfolge darf für Demucs abweichen)
- display names non-empty
- hash formats hex >=32 chars
- qualityProfile serves/numOverlap/ensemblePasses
- content hash SHA256 der Modelle
- Selection prefers bs_roformer for HQ: `selectModelForProfile('HIGH_QUALITY')` gibt bsroformer-musdb18hq-4stem-zfturbo

Katalog:
- bsroformer-musdb18hq-4stem-zfturbo (vocals,bass,drums,other) HIGH_QUALITY
- bsroformer-musdb18-4stem (vocals,drums,bass,other) HIGH_QUALITY
- melband-roformer-4stem-v1 (vocals,drums,bass,other) MAXIMUM_QUALITY
- htdemucs-ft-4stem (drums,bass,other,vocals) PREVIEW – native Demucs order
- pipeline-double-v1 (vocals,drums,bass,other) double, not trained

## Backends via IStemSeparator only

- Interface `IStemSeparator` mit `backendId`, `capabilities()`, `separate(request)`
- **native-cli** `audiocpp_cli --task sep` (vocals+instrumental fixed) first, dann python-torch adapter `python/bsroformer_inference.py`
- Python adapter: reference arch from AIRODOX_MSST_DIR or pip msst, JSONL protocol (progress, stem, log, error, done), exit code map 0 ok /130 cancelled/2 bad args/3 model/4 IO/5 audio, SIGTERM cancel, GPU→CPU fallback via `runWithGpuFallback`
- `htDemucsSeparator` mit quality profile shifts 10, overlap 0.5, float32, clip-mode rescale, stemOrder aus Katalog
- `processTransport` mit Exit-Code Map, JSONL parsing, cancellation

## Technischer Kern

`StemSeparationEngine` validiert die Eingabe, wählt ein registriertes Modell, führt den Backend-Adapter aus und schreibt `SeparationSummary`-Metadaten. Das `PipelineDoubleSeparator` ist ein deterministischer Transport-Double für CI und ist ausdrücklich **kein** Qualitätsnachweis.

`runTechnicalGate()` 10 Checks, JSON report, machine readable:

1. ORIGINAL_HASH_UNCHANGED
2. SEPARATION_COMPLETED
3. WORKING_COPY_44K_STEREO
4. CHUNKED_INFERENCE
5. OVERLAP_ADD_RECONSTRUCTION
6. STEM_FILES_VALIDATED
7. STEREO_PRESERVED
8. JOB_METADATA_COMPLETE
9. CACHE_REUSE
10. ENGINE_INTEGRITY_CHECK

Report: `stem-gate-run/technical-gate-report.json`

## Stem Isolation Gate (Part 2)

`runStemIsolationGate()` erzeugt deterministisch einen 30-Sekunden-Testtrack (Seed `20260913`) mit sechs Ground-Truth-Stems (vocals, drums, bass, synth, percussion, fx), 6 Segmenten mit overlap pairs defeating filters (INTRO, VERSE, PRE, DROP, BREAK, OUTRO), 15 Mix-Varianten (clean, compressed, limited, saturated, clipped, widened, reverb, delay, sidechain, comp+sat, limit+wide, verb+delay, all, low_comp, high_sat) und objektiven Metriken (SI-SDR/SDR, Bleed, Transienten, Stereo, Spektrum und Phasenlage). QualityScore 1-9.5 never 10, random-weights detection caps quality.

Schreibt:

```
test_run/
  metadata.json
  original/mix.wav
  ground_truth/*.wav
  separated/*.wav
  recombined/mix.wav
  metrics/metrics.json
  report/report.html
```

Release decision genau einer von TECHNICAL_FAIL / TECHNICAL_PASS_QUALITY_FAIL / RELEASE_READY. Ohne trainiertes Modell ist das beabsichtigte Ergebnis TECHNICAL_PASS_QUALITY_FAIL; ein Pipeline-Double oder zufällige Gewichte können niemals RELEASE_READY liefern.

```bash
npm run test:stems
npm run test:stems:live # requires AIRODOX_STEM_ALLOW_QUALITY_RUN=1 and checkpoint
npm run lint
```

## Colab Gate

`colab/airdox-stem-gate.md` source of truth, built to ipynb via `md-to-notebook.mjs`, checked in CI via `npm run stems:gate:notebook -- --check`; `build-stem-gate-tarball.mjs` erstellt source archive ohne weights. Network limitation: release-assets unreachable via SSL_ERROR_SYSCALL in sandbox, daher Colab notebook für quality gate.

## Editor Integration

- `stemJobService.ts` job layer mit pause/cancel/resume, staging renderer bytes, status mapping
- `nodeBridge.ts` bundled to `dist/stems/node-bridge.cjs` via `build:stems-bridge`, structured-clone-safe results
- IPC `stems:engine-status`, `stems:job-*`, `stems:job-progress`, HTTP `/api/stems/*` in `server.ts`
- Renderer `src/audio/stemEngine.ts` selects profile (HQ via engine, PREVIEW via Demucs), stem list from descriptor, progress + cancel in deck
- `stemEngineInstaller.ts` one-click installer with progress events

## Logging System

Main logger `electron/logger.cjs` + renderer `src/utils/logger.ts` merged into same daily file `%APPDATA%/airdox_SMART_Editor/logs/airdox-editor-YYYY-MM-DD.log` oder `logs/` dev, retention 14d via AIRDOX_LOG_RETENTION_DAYS, level via AIRDOX_LOG_LEVEL, secret redaction, binary summarization, console/fetch/XHR capture, flush on error/pagehide.

## Weitere Systeme

- Recording processor and Pro Recorder modal: whole-file optimization, true-peak ceiling, format selection
- MIDI mappings for DDJ-FLX4 / DDJ-1000, LED feedback, exhaustive matrix tests
- Waveform: no synthetic fallback in production renderer, honest empty state, native ANLZ buckets preserved via analysisComposer, palette clips carry analysis slice + beatOffsets for exact round-trip, drag-drop MIME `application/x-airdox-palette-clip` with timeline clamping

## Acceptance

- `npm run test:package` valid JSON
- `npm run stems:gate:notebook -- --check` passes
- `npm run test:stems` passes
- `npm run lint` passes
- build succeeds
- no original modification in any path
