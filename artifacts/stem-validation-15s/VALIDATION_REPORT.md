# Stem validation – 18.09.2026

## Testmaterial

`test15s_mixture.wav` is a deterministic 15-second stereo test mix at 44.1 kHz,
seed `20260918`. It contains vocals, drums, bass and other/instrument material.

## Automated result

- `npm run lint`: PASS
- `npm run test:stems`: **16/16 PASS**, 0 skipped
- Technical Gate Teil 1: **10/10 PASS**
- Stem Isolation Gate Teil 2: automated contract/negative-quality tests PASS
- Progress reporting: fixed so processed audio position follows the actual
  fraction inside the current chunk instead of jumping to the chunk end.

## Important release status

A real quality certification for all production models is **not yet possible in
this environment**. `npm run test:stems:live` skipped both live tests because
Python/PyTorch and trained checkpoints are not installed. The documentation
explicitly requires a trained checkpoint and the Stem Isolation Gate must report
`TECHNICAL_PASS_QUALITY_FAIL` for random/untrained weights; it must never claim
`RELEASE_READY`.

Therefore this report does **not** claim that the three requested architectures
have been proven qualitatively. The 15-second file is test input only, not a
separation result.

## Required next release gate

Run on a machine with the real trained weights and Python/PyTorch:

```bash
AIRODOX_STEM_ALLOW_QUALITY_RUN=1 npm run test:stems:gate:strict
```

For each selected model, the gate must produce every expected stem WAV, validate
headers and stereo, preserve the original hash, pass recombination and quality
metrics, and write the HTML/JSON report before the model can be called fully
operational.
