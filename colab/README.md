# Colab Stem Gate

This directory contains the Colab quality gate for the stem separation engine.

## Source of Truth

`airdox-stem-gate.md` is the source of truth. It is built to `airdox-stem-gate.ipynb` via:

```bash
npm run stems:gate:notebook
npm run stems:gate:notebook -- --check
```

CI checks that the ipynb matches the md.

## Network Limitation

In sandbox, GitHub release assets are unreachable via `release-assets.githubusercontent.com` / `objects.githubusercontent.com` (SSL_ERROR_SYSCALL) while npm and github.com work. Thus trained checkpoint cannot be fetched here, requiring Colab notebook `colab/airdox-stem-gate.ipynb` for quality gate on machine with network.

## Usage in Colab

1. Open `airdox-stem-gate.ipynb` in Colab
2. Run all cells
3. The gate will:
   - Clone repo
   - Setup models (bsroformer, demucs)
   - Generate gold standard track (seed 20260913)
   - Run technical gate (10 checks)
   - Run isolation gate (15 variants)
   - Produce report in `test_run/` with metadata/original/ground_truth/separated/recombined/metrics/report.html
   - Decide RELEASE_READY / TECHNICAL_PASS_QUALITY_FAIL / TECHNICAL_FAIL

## Tarball

Build source archive without weights:

```bash
npm run stems:gate:archive
```
