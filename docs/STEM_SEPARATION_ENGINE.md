# Stem Separation Engine

Die Stem-Separation ist als nicht-destruktive Pipeline unter `src/stems/`
implementiert. Eingabedateien werden nur gelesen; Ergebnisse und Prüfberichte
liegen in eigenen Ausgabeordnern.

## Technischer Kern

`StemSeparationEngine` validiert die Eingabe, wählt ein registriertes Modell,
führt den Backend-Adapter aus und schreibt `SeparationSummary`-Metadaten. Das
`PipelineDoubleSeparator` ist ein deterministischer Transport-Double für CI und
ist ausdrücklich **kein** Qualitätsnachweis.

## Stem Isolation Gate

`runStemIsolationGate()` erzeugt deterministisch einen 30-Sekunden-Testtrack
(Seed `20260913`) mit sechs Ground-Truth-Stems, 15 Mix-Varianten und
objektiven Metriken (SI-SDR/SDR, Bleed, Transienten, Stereo, Spektrum und
Phasenlage). Der Gate schreibt:

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

Ohne trainiertes Modell ist das beabsichtigte Ergebnis
`TECHNICAL_PASS_QUALITY_FAIL`; ein Pipeline-Double oder zufällige Gewichte
können niemals `RELEASE_READY` liefern.

```bash
npm run test:stems
npm run lint
```
