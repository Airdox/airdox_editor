# Project Roadmap

## 0.4.20+ – Current Focus

- Rekordbox pipeline as primary path (ANLZ/PWV, PQTZ verbatim, no synthetic fallback)
- Stem Separation Engine non-destructive, chunked, overlap-add, cache, job metadata
- ModelRegistry data-driven from modelCatalog.json, 5 models, content hash
- Backends via IStemSeparator only: native-cli audiocpp_cli first, python-torch bsroformer_inference.py
- Technical gate 10 checks, isolation gate 30s gold standard seed 20260913, 6 stems, 6 segments, 15 variants, metrics SDR/SI-SDR/bleed/stereo/transient/level/spectrum/phase, qualityScore 1-9.5 never 10, release decision TECHNICAL_FAIL / TECHNICAL_PASS_QUALITY_FAIL / RELEASE_READY
- Colab gate source of truth md -> ipynb, checked in CI, tarball without weights
- Editor integration: stemJobService, nodeBridge bundled to dist/stems/node-bridge.cjs, IPC stems:engine-status, stems:job-*, HTTP /api/stems/*
- Logging merged daily file, retention 14d, secret redaction, binary summarization, console/fetch/XHR capture, flush on error/pagehide
- Recording processor and Pro Recorder modal: whole-file optimization, true-peak ceiling, format selection
- MIDI mappings DDJ-FLX4 / DDJ-1000, LED feedback, exhaustive matrix tests
- Waveform: no synthetic fallback, honest empty state, native ANLZ buckets preserved via analysisComposer, palette clips carry analysis slice + beatOffsets for exact round-trip, drag-drop MIME application/x-airdox-palette-clip

## Next

- Library search, Smart Filter, Batch Review
- Palette 2.0 and Mix preview
- Cloud, Hardware, Video
