# Stem Separation Engine

Die Stem-Separation ist als nicht-destruktive Pipeline unter `src/stems/`
implementiert. Eingabedateien werden nur gelesen; Ergebnisse und Prüfberichte
liegen in eigenen Ausgabeordnern.

**Status: TEIL 1 (technische Funktionalität) und TEIL 2 (Goldstandard-Testtrack,
Qualitätsmetriken, Stem Isolation Gate) sind implementiert und automatisiert
geprüft. Ein echtes Qualitäts-`PASS` ist in dieser Umgebung mangels
trainiertem Checkpoint nicht erreichbar** — siehe
[Abschnitt „Teil 2“](#teil-2--stem-isolation-gate-goldstandard-testtrack-qualitätsmetriken).

## Technischer Kern

`StemSeparationEngine` validiert die Eingabe, wählt ein registriertes Modell,
führt den Backend-Adapter aus und schreibt `SeparationSummary`-Metadaten. Das
`PipelineDoubleSeparator` ist ein deterministischer Transport-Double für CI und
ist ausdrücklich **kein** Qualitätsnachweis.

## Teil 2 — Stem Isolation Gate, Goldstandard-Testtrack, Qualitätsmetriken

TEIL 2 ist implementiert: Testtrack, Varianten, Metriken, Bleed-/Transient-/
Stereo-/Chunk-Boundary-/Recombination-Tests und der Stem Isolation Gate selbst
sind vorhanden und automatisiert getestet (`npm run test:stems` führt
`tests/stem-isolation-gate.test.ts` aus). **Was weiterhin fehlt, ist ein
trainierter Checkpoint** — deshalb kann dieser Gate in dieser Umgebung niemals
ein echtes Qualitäts-`PASS` liefern, sondern konsequent nur
`TECHNICAL_PASS_QUALITY_FAIL` (siehe unten). Das ist beabsichtigtes Verhalten,
kein Bug.

### Module

| Modul | Zweck |
|---|---|
| `src/stems/dsp.ts` | FFT, STFT, Onset-Erkennung, Cross-Correlation-Lag — reine Analyse, kein Audio-I/O |
| `src/stems/mixEffects.ts` | Bus-Effekte für Testvarianten: Kompression, Limiting, Sättigung, Clipping, Stereo-Breite, Reverb, Delay, Sidechain, Auto-Pan |
| `src/stems/metrics.ts` | SDR, SI-SDR, Interference, Bleed-Tabelle, Stereo-Vergleich, Transient-Vergleich, Pegel-/Spektral-/Phasen-Vergleich, `evaluateStem()`, `qualityScore()` (1–9.5, nie 10) |
| `src/stems/goldStandard.ts` | `generateGoldStandardTrack()` — deterministischer 30-s-Track, Seed `TEST_SEED=20260913`, 6 Ground-Truth-Stems (vocals/drums/bass/synth/percussion/fx), 6 Segmente à 5 s mit gezielten Frequenzüberlappungen |
| `src/stems/goldStandardVariants.ts` | `buildGoldStandardVariants()` — 15 benannte Mix-Varianten (Clean … Dense Full Mix) aus denselben Ground-Truth-Stems |
| `src/stems/stemGroupMapping.ts` | Ordnet die 6 Ground-Truth-Quellen den tatsächlichen Modell-Stems zu (z. B. 4-Stem-Modell: `other` = synth+percussion+fx), dokumentiert statt versteckt |
| `src/stems/stemIsolationGate.ts` | `runStemIsolationGate()` — End-to-End-Orchestrierung: Track bauen → Separation laufen lassen → pro Stem gegen Ground Truth vergleichen → rekombinieren → Original-Hash prüfen → Ergebnistabelle + `report_run/`-Verzeichnis + Release-Entscheidung |

### Goldstandard-Track (6 Segmente)

| Zeit | Segment | Inhalt |
|---|---|---|
| 0–5 s | Kick + Subbass | Kick, Subbass und Bass mit stark überlappendem Frequenzbereich |
| 5–10 s | Kick + Bass + Synth | Synth mit Energie im unteren/mittleren Frequenzbereich, überlappend mit Bass |
| 10–15 s | Vocal + Synth | Vocal-Melodie und Synth-Pad mit stark überlappenden Formantbereichen |
| 15–20 s | Hats + Percussion + Stereo-Synth | Hochfrequenz- und Stereo-Verhalten: Hats, Percussion, breiter Stereo-Synth mit Delay |
| 20–25 s | Dense EDM Section | Alle Hauptquellen gleichzeitig inkl. Sidechain-Pumping |
| 25–30 s | Master-Bus-Simulation | Voller Mix als Grundlage für die Master-Bus-Varianten; Ground-Truth-Stems bleiben unprozessiert |

Der Mix ist die **exakte lineare Summe** der sechs Ground-Truth-Stems
(Recombination bleibt prüfbar); die 15 Mix-Varianten (Clean, Normalized,
Compressed, Heavily Compressed, Limited, Very Loud, Saturated, Clipped,
Stereo-Widened, Mono-Compatible, Extreme Panning, Heavy Reverb, Heavy Delay,
Sidechain, Dense Full Mix) verändern nur den Mix, nie die Ground Truth.

### Warum ein Qualitäts-`PASS` hier nicht möglich ist

`runStemIsolationGate()` erkennt untrainierte Läufe explizit über
`detectRandomWeights()` (request-Extra ODER Backend-Report `weights=random`)
und über `validation.fromTrainedModel` der Engine, und setzt in diesem Fall
**hart**:

* `qualityPass = false`
* `releaseDecision = 'TECHNICAL_PASS_QUALITY_FAIL'` (nie `RELEASE_READY`)

Das gilt auch für den `PipelineDoubleSeparator` (kein Modell überhaupt) —
beide Fälle sind in `tests/stem-isolation-gate.test.ts` (#16) verifiziert: der
Gate darf niemals ein Qualitäts-`PASS` fabrizieren, ohne dass eine echte,
trainierte Separation stattgefunden hat. Erst wenn trainierte Gewichte
vorliegen, kann `RELEASE_READY` überhaupt erreicht werden. Bis dahin gilt:
**technisch funktionsfähig, Qualität „nicht bewertbar“ statt fabriziert.**

### Report-Layout

`runStemIsolationGate({ outputRoot })` schreibt die geforderte Struktur:

```
test_run/
  metadata.json
  original/mix.wav
  ground_truth/{vocals,drums,bass,synth,percussion,fx}.wav
  separated/{...}.wav
  recombined/mix.wav
  metrics/metrics.json
  report/report.html
```

`report.html` enthält die Ergebnistabelle (Stem | Isolation | Bleed |
Transient | Stereo | Recombination | PASS/FAIL) sowie alle Gate-Checks und
die Release-Entscheidung als Badge.

## Tests

```bash
npm run test:stems          # Stem Isolation Gate (Teil 2): 18 Testgruppen
npm run test:stems:live     # echte BS-RoFormer-Architektur über den Adapter
npm run test:stems:all      # beides
npm run lint                # tsc --noEmit
```

| Suite | Gruppen | Deckt ab |
|---|---|---|
| `tests/stem-isolation-gate.test.ts` (Teil 2) | 18 | 30-s-Goldstandard-Track (deterministisch, 6 Stems, 6 Segmente), ≥15 Mix-Varianten, Frequenzüberlappungspaare, Stem-Group-Mapping, Metrik-Grundfunktionen (SI-SDR/Bleed/Transient/Stereo), Chunk-Boundary-A/B-Test, Determinismus, Original-Integrität, Crash-Recovery, Fehlerfälle (leere Datei, 1-Sample, Schreibrechte), Stem-Isolation-Gate End-to-End (muss `TECHNICAL_PASS_QUALITY_FAIL` liefern, nie fabriziertes `RELEASE_READY`), Report-Verzeichnis, Release-Entscheidung-Eindeutigkeit |
| `tests/stem-separation-bsroformer-live.test.ts` | — | echte Architektur + Protokoll; überspringt sauber, wenn Python/PyTorch fehlen |

`tests/stem-isolation-gate.test.ts` läuft immer (auch ohne GPU/PyTorch), da es
gegen den deterministischen `PipelineDoubleSeparator` testet.

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
