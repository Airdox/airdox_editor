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

### Metrik-Konventionen

* `sdr()` ist **nicht** skaleninvariant und bestraft Pegelfehler — dafür wird
  es im Recombination- und Level-Vergleich gebraucht.
* `siSdr()` projiziert die Schätzung zuerst auf die Referenz und ignoriert
  damit einen reinen Gain-Offset.
* Beide sind auf ±`MAX_SDR_DB` (180 dB) begrenzt. Ein **stummer** Stem liefert
  `-MAX_SDR_DB`, niemals einen perfekten Wert — ein Backend, das nichts
  ausgibt, kann den Gate dadurch nicht bestehen.
* `interferenceDb()` orthogonalisiert die Störquellen (Gram-Schmidt) gegen das
  Ziel, damit gemeinsam belegte Energie nicht mehrfach gezählt wird.
* `measureContinuity()` meldet `excessDb` monoton: eine exakte Rekonstruktion
  liegt auf dem Boden `SILENT_DB` (-240 dB), jede reale Abweichung liegt
  darüber. `duplicateTransients`/`missingTransients` werden über eine
  Onset-Erkennung rund um jede Chunk-Grenze tatsächlich gezählt.

```bash
npm run test:stems
npm run lint
```

## Woher kommen die trainierten Gewichte?

Das Qualitäts-Gate kann ohne trainierten Checkpoint niemals `RELEASE_READY`
erreichen. Es fehlen dafür **zwei** Dinge — der Download allein genügt nicht:

1. **Die Gewichtsdatei** (siehe unten).
2. **Ein Inferenz-Adapter**, der sie tatsächlich ausführt. `BSRoFormerSeparator`
   in `src/stems/backends/roformerSeparator.ts` ist derzeit nur eine
   Adapter-Grenze: ohne `fallback` wirft `separate()` sofort. Es gibt keinen
   Python-/ONNX-Prozess, der ein `.ckpt` lädt.

### Bezugsquelle

Empfohlen ist das 4-Stem-MUSDB18HQ-Modell von ZFTurbo, das zur bereits
registrierten Modell-ID `bsroformer-musdb18hq-4stem-zfturbo` und deren
Stem-Reihenfolge (`vocals, drums, bass, other`) passt:

| | |
|---|---|
| Checkpoint | `model_bs_roformer_ep_17_sdr_9.6568.ckpt` (~700 MB) |
| Config | `config_bs_roformer_384_8_2_485100.yaml` |
| Release | ZFTurbo/Music-Source-Separation-Training, Tag `v1.0.12` |
| SDR (MUSDB18 test avg) | 9.65 |

```bash
bash scripts/setup-bsroformer-model.sh          # -> models/bsroformer/
STEM_MODEL_SHA256=<hash> bash scripts/setup-bsroformer-model.sh   # mit Pinning
```

`models/`, `*.ckpt`, `*.onnx`, `*.th` und `*.safetensors` sind in `.gitignore`.
Gewichte gehören **nicht** ins Repository.

### In dieser Sandbox nicht möglich

Der Download scheitert hier reproduzierbar. Erreichbar ist nur `github.com`
selbst; die eigentlichen Asset-Hosts sind geblockt (gemessen, nicht vermutet):

| Host | Ergebnis |
|---|---|
| `github.com` (Release-URL) | `302` — antwortet |
| `release-assets.githubusercontent.com` | `SSL_ERROR_SYSCALL` |
| `objects.githubusercontent.com` | blockiert |
| `huggingface.co`, `cdn-lfs.huggingface.co` | blockiert |
| `raw.githubusercontent.com`, `zenodo.org`, `dl.fbaipublicfiles.com` | blockiert |
| `pypi.org`, `files.pythonhosted.org` | erreichbar |

Zudem ist kein PyTorch installiert (`import torch` schlägt fehl, Python 3.11.2).
Der Gate-Lauf muss deshalb auf einer lokalen Maschine mit Netzzugang und GPU
erfolgen.

### Lizenzlage (vor kommerzieller Nutzung klären)

* **Architektur** `lucidrains/BS-RoFormer`: MIT.
* **Trainings-/Inferenz-Framework** ZFTurbo/MSST: MIT (gilt für den **Code**).
* **Die Gewichte selbst**: ZFTurbo hat dafür *keine* ausdrückliche Lizenz
  veröffentlicht. Die MIT-Lizenz des Repos deckt den Code, nicht zwingend die
  Checkpoints. Trainiert wurde auf MUSDB18-HQ, einem forschungsorientierten
  Datensatz.
* Für Entwicklung und Evaluierung unproblematisch. Vor einer kommerziellen
  Auslieferung ist eine schriftliche Bestätigung des Autors nötig.
* Zum Vergleich: Demucs-Gewichte sind ausdrücklich **nicht** von der MIT-Lizenz
  gedeckt ("only for scientific purposes"), und mehrere populäre
  RoFormer-Checkpoints (viperx, becruily) sind ungeklärt bzw. explizit
  nicht-kommerziell. Ein MIT-lizenzierter ONNX-Reexport desselben 4-Stem-Modells
  existiert (`silverdaw/bs-roformer-rhythm-onnx`) und wäre die sauberere
  Variante, falls der Adapter ohnehin auf ONNX Runtime gebaut wird.

## Desktop-Integration (Electron)

Der Weg von der UI bis zur Inferenz:

```
App.tsx  ──IPC──▶ electron/main.cjs ──▶ electron/stemsEngine.cjs ──▶ AudioSeparatorSeparator ──▶ audio-separator (CLI)
         ◀─progress/result─                (Bundle von src/stems/desktopEntry.ts)
```

* `src/stems/desktopEntry.ts` ist die einzige Schnittstelle zum Desktop:
  `separateForDesktop`, `cancelSeparation`, `preflight`, `describeError`.
* Das Bundle `electron/stemsEngine.cjs` wird mit `npm run build:stems` erzeugt
  (läuft automatisch in `npm run build` und damit in jedem `package:win`).
  Es ist ein Artefakt und daher **nicht** eingecheckt — nie von Hand editieren.

### IPC-Kanäle

| Kanal | Richtung | Zweck |
| --- | --- | --- |
| `audio:stems-preflight` | invoke | Ist `audio-separator` installiert? Liefert ggf. Installationshinweis. |
| `audio:separate-stems` | invoke | Startet einen Job (`{ inputFilePath, jobId, usePipelineDouble? }`). |
| `audio:cancel-stems` | invoke | Bricht einen laufenden Job über seine `jobId` ab. |
| `audio:stems-progress` | main → renderer | Fortschritt (`{ jobId, phase, percent }`). |

Ergebnisse liegen unter `userData/stems/{working,separated,cache,models}`, pro
Job in einem eigenen Unterordner.

### Stem-Identität

Die Zuordnung Datei → Stem wird **erzwungen**, nicht geraten: der Adapter
übergibt `--custom_output_names` und erwartet exakt `stem_<id>.wav`. Fehlt ein
Stem, ist das ein `INFERENCE_FAILED` — es wird nie eine kürzere Liste
zurückgegeben, die die UI dann verschoben beschriften würde. Renderer-seitig
trägt `TrackModel.stems: TrackStem[]` die `id` mit; `TrackSeparation.tsx`
leitet Label und Farbe aus dieser `id` ab, nicht aus dem Array-Index.

### Voraussetzung auf dem Zielrechner

```bash
pip install "audio-separator[gpu]"   # oder [cpu]
npm run stems:setup                  # lädt das BS-RoFormer-Modell
```

Fehlt das Binary, meldet die UI das vor dem Start des Jobs im Klartext, statt
mitten im Track zu scheitern.

### Was hier nicht verifiziert werden konnte

Die Sandbox hat kein `audio-separator` und keinen Zugriff auf die Model-Hosts.
Verifiziert ist deshalb der komplette Pfad bis einschließlich Adapter (mit
injiziertem Runner, siehe `tests/stem-desktop-backend.test.ts`) sowie ein
End-to-End-Lauf über das Pipeline-Double. Der Lauf mit echten Gewichten muss
auf einer Maschine mit installierter CLI nachgeholt werden; das Gate meldet bis
dahin korrekt `TECHNICAL_PASS_QUALITY_FAIL`.
