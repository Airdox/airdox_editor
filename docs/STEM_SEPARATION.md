# Stem Separation – User Guide

## Profiles

- **PREVIEW**: Fast, HT-Demucs FT 4-stem (drums,bass,other,vocals), shifts 1, overlap 0.25
- **HIGH_QUALITY**: BS-RoFormer MUSDB18HQ 4-stem ZFTurbo (vocals,bass,drums,other), chunk 441k, overlap 0.5, numOverlap 4
- **MAXIMUM_QUALITY**: Mel-Band RoFormer 4-stem, overlap 0.6, numOverlap 8, ensemble 2

Selection prefers bs_roformer for HQ.

## Workflow

1. Import track (Rekordbox XML/DB or local file) – ORIGINAL read-only, sha256 before/after
2. Choose profile in DeckStemsControl (chips from descriptor)
3. Engine creates working copy 44.1k stereo float32 in `workingRoot/jobId/working.wav`
4. Chunked inference: planChunks with outer overlap raised cosine + inner num_overlap
5. Backend: native-cli audiocpp_cli first (vocals+instrumental fixed), then python-torch bsroformer_inference.py
6. Overlap-add reconstruction, validation, recombination check
7. Output stems in `outputRoot/trackName/*.wav` + job.json with input/model/settings hash, backend, precision, extras
8. Cache key `input: model: settings` – second run hits cache if same input/model/settings

## Pause/Cancel/Resume

- Cancel via SIGTERM, job status CANCELLED
- Pause via token.pause(), resume via token.resume()
- History archiving in `historyRoot/jobId/job.json`

## Error Matrix (20 codes)

AUDIO_MISSING, AUDIO_CORRUPT, AUDIO_UNSUPPORTED_FORMAT, WRITE_DENIED, BACKEND_UNAVAILABLE, INFERENCE_FAILED, CANCELLED, INVALID_REQUEST, CACHE_CORRUPT, ORIGINAL_MODIFIED (hard fail), MODEL_INCOMPATIBLE, MODEL_HASH_MISMATCH, STEM_VALIDATION_FAILED, RECOMBINATION_FAILED, BOUNDARY_SPECIFIC_ERROR, WORKING_COPY_FAILED, CHUNK_PLAN_INVALID, SETTINGS_INVALID, TIMEOUT, UNKNOWN

## Installation

```bash
npm run stems:setup        # Demucs + RoFormer via bash
npm run stems:setup:win    # Windows PowerShell
npm run stems:setup:bsroformer
```

Or one-click in app via `stems:install` IPC with progress events.

## Quality Gate

Technical gate 10 checks, isolation gate 30s gold standard seed 20260913, 6 stems, 6 segments, 15 variants, metrics SDR/SI-SDR/bleed/stereo/transient/level/spectrum/phase, qualityScore 1-9.5 never 10, report test_run/ with metadata/original/ground_truth/separated/recombined/metrics/report.html, release decision exactly one of TECHNICAL_FAIL / TECHNICAL_PASS_QUALITY_FAIL / RELEASE_READY.

Without trained model, expected TECHNICAL_PASS_QUALITY_FAIL; pipeline-double or random weights never RELEASE_READY.

```bash
npm run test:stems
npm run test:stems:live # requires checkpoint and AIRODOX_STEM_ALLOW_QUALITY_RUN=1
```

## Colab

`colab/airdox-stem-gate.md` source of truth, built to ipynb via `md-to-notebook.mjs`, checked in CI. Network limitation: release-assets unreachable via SSL_ERROR_SYSCALL in sandbox, so Colab needed for quality gate.

## Logging

Logs in `%APPDATA%/airdox_SMART_Editor/logs/airdox-editor-YYYY-MM-DD.log`, retention 14d, level env, secret redaction, binary summarization.

## Editor Integration

- `stemJobService.ts` job layer
- `nodeBridge.ts` bundled to `dist/stems/node-bridge.cjs`
- IPC `stems:engine-status`, `stems:job-*`, `stems:job-progress`
- Renderer `src/audio/stemEngine.ts` selects profile, stem list from descriptor, progress + cancel
