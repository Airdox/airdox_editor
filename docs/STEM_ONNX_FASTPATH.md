# ONNX-Fast-Path – Stems ohne Python, ohne Chunk-Dateien

Der DJ-Pfad der Stem-Engine. Er beantwortet das Problem des alten Wegs:

| | alter Weg (BS-RoFormer, PyTorch) | ONNX-Fast-Path |
| --- | --- | --- |
| Prozess | Python-Subprozess je Chunk | direkt im Editor-Prozess |
| Dateien je Track | hunderte `chunk_NNNN.wav` + Stem-WAVs je Chunk | **keine** Zwischendateien |
| Übergabe | WAV-Dateien auf der Platte | `Float32Array` in RAM/VRAM |
| Grenzkontrolle | volle Kontinuitäts-/Rekombinationsanalyse | Geometrie, endliche Samples, Peak, Stille |
| Modell | 503 MiB Checkpoint + Config + torch | ein `.onnx`-Graph (166 MiB fp16) |
| Rechenzeit | > 10 min je Track | Sekunden bis ~1 min, je nach GPU |

Qualitativ bleibt der Fast-Path bewusst **unter** BS-RoFormer (MUSDB18-HQ
vocals ≈ 8,8 dB SDR gegenüber ≈ 9,7 dB). Es ist derselbe HT-Demucs-Stamm, nur
anders ausgeführt: `fast_dj` ist der Kompromiss für den Live-Betrieb,
`studio_master` bleibt der Qualitätspfad.

## 1. Was der Fast-Path technisch anders macht

* **`src/stems/backends/onnxSeparator.ts`** implementiert `IStemSeparator` mit
  `capabilities().inMemory = true`. Der Backend-Vertrag wurde dafür um zwei
  optionale Felder erweitert: `workingSamples` (Eingang) und `inlineStems`
  (Ausgang). Beide sind optional – die Python-Backends bleiben unverändert und
  bekommen weiterhin Pfade.
* Die Engine erkennt `inMemory` und lässt dann alles Dateibasierte weg:
  kein `chunk_NNNN.wav`, kein `out_NNNN/`-Ordner, kein Zurücklesen der
  Backend-Dateien. Fertige Stems entstehen einmalig als `stems/*.wav`.
* **Execution Provider** werden zur Laufzeit gewählt, nicht geraten:
  `ort.listSupportedBackends()` sagt, was die installierte Runtime mitbringt.
  Reihenfolge: `directml` (Windows/DX12, AMD·NVIDIA·Intel) → `cuda`/`tensorrt`
  (NVIDIA, Linux/Windows) → `coreml` (macOS) → `cpu`. Scheitert eine GPU-Session,
  wird automatisch CPU genommen (der Job läuft, das Report-Feld `cpuFallback`
  und `providers` sagen, was wirklich gerechnet hat).
  Eine Session wird **warmgehalten** – Segmentierung/Laden (166 MiB Graph)
  passiert einmal, nicht je Track.
* **Segmentierung**: Der Graph verlangt eine feste Eingangslänge (HT-Demucs:
  343 980 Samples = 7,8 s bei 44,1 kHz). Die Engine bildet daraus Segmente mit
  25 % Überlappung, packt sie in einen wiederverwendeten `Float32Array` (letztes
  Segment wird gepaddet, nicht gekürzt) und rekonstruiert mit derselben
  Overlap-Add-Logik wie der Studio-Pfad.
  *Hinweis*: Die 30–60-Sekunden-Fenster aus der Aufgabe sind mit dem
  HT-Demucs-Graph **nicht möglich** – seine Eingangsachse ist fest. Für ganze
  Tracks „am Stück“ bräuchte es einen Export mit dynamischer Achse (möglich,
  aber für FP16/CoreML/DirectML nicht empfohlen bzw. nicht überall lauffähig).
  Die Fensterlänge ist deshalb datengetrieben: sie kommt aus der Graph-Metadaten
  und lässt sich über den Katalog steuern.
* **Validierung**: `mode: 'fast_dj'` (Standard in App und Dev-Server) prüft
  Geometrie, endliche Samples, Peak und Stille. `continuity` und
  `recombinationErrorDb` sind im Report dann `null` – „nicht gemessen“ ist
  ausdrücklich nicht dasselbe wie „gemessen und gut“. `AIRODOX_STEM_MODE=studio_master`
  schaltet die volle Analyse wieder ein.

## 2. Modell beschaffen

Das ONNX-Modell gehört seit dem DJ-Pfad zum **Standard-Set** von
`npm run stems:bundle` (zusammen mit dem BS-RoFormer-Checkpoint) und landet
damit im Build unter `resources/models`. Wer nur den schnellen Pfad braucht:

```
npm run stems:bundle -- --models htdemucs-onnx-4stem-fp16
```

Der Katalogeintrag `htdemucs-onnx-4stem-fp16` erwartet dort:

```
<Model-Store>/htdemucs_fp16weights.onnx    166 MiB, opset 17
```

Bekannte Quelle (MIT, Export von `demucs-onnx`, Gewichte von Meta HT-Demucs):

```
https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx
```

Alternativen:

| Datei | Größe | Hinweis |
| --- | --- | --- |
| `htdemucs_fp16weights.onnx` | 166 MiB | Standard für den Laptop/PC, gleiche Laufzeit wie fp32 |
| `htdemucs.onnx` | 316 MiB | fp32-Gewichte, minimal genauer |
| Bag `htdemucs_ft` (4 Spezialisten) | 1,26 GB | beste Qualität (≈ ft-Niveau), 4 Sessions, nur für starke GPUs |

Alle drei haben die Signatur `mix (1,2,N) → stems (1,4,2,N)`, Reihenfolge
`[drums, bass, other, vocals]` – der Katalog bildet sie über `stemOrder` ab.

**Der Hash muss eingetragen werden.** Solange `checkpoint.sha256` im Katalog auf
`"unverified"` steht, prüft niemand die Datei. Nach dem ersten Download:

```powershell
npm run stems:onnx:doctor -- --model-dir "C:\Pfad\zum\Store"
```

Der Doctor zeigt den sha256. Diesen Wert in `src/stems/modelCatalog.json` bei
`htdemucs-onnx-4stem-fp16` als `checkpoint.sha256`, `checkpointSha256` und
`modelHash` eintragen. Danach prüfen Doctor, Bundling und jeder Job den Hash.

## 3. Diagnose

```powershell
npm run stems:onnx:doctor                       # Provider, Modell, Segment, Hinweise
npm run stems:onnx:doctor -- --bench --seconds 30
npm run stems:onnx:doctor -- --json
```

Die Bench-Ausgabe nennt RTF und Sekunden Rechenzeit je Audiominute; damit lässt
sich die 10-Sekunden-Frage auf echter Hardware beantworten. Beispiel (Sandbox,
Testgraph, CPU): RTF 0,003 – der reale HT-Demucs liegt bei RTF ≈ 0,2 auf einem
Laptop-CPU-Kern und deutlich darunter auf einer GPU.

Wichtig für die Erwartung: die 10 Sekunden sind ein **GPU-Ziel**. Ohne GPU
(oder mit `--device cpu`) rechnet HT-Demucs auf CPU je nach Länge im Bereich
20–60 s pro Track. Deshalb bleibt `studio_master` als Fallback erhalten.

## 4. Erste Schritte auf einem Windows-Rechner

```powershell
# 1) Abhängigkeit (Binary steckt im npm-Tarball, inkl. DirectML-DLL für win32-x64)
npm install

# 2) Modell in den Store legen (s. o.): htdemucs_fp16weights.onnx

# 3) Prüfen, ob der Fast-Path greift
npm run stems:onnx:doctor
#    erwartet: Provider gebündelt: cpu, webgpu, dml
#              Provider geplant:   dml > cpu

# 4) Dev-Server/App starten und einen Track trennen
npm run dev
```

In der App ist `fast_dj` voreingestellt. Für einen Referenzlauf mit voller
Validierung:

```powershell
$env:AIRODOX_STEM_MODE="studio_master"; npm run dev
```

## 5. Grenzen und offene Punkte

* Geprüft ist hier die CPU-Schiene plus die Provider-Auswahllogik (Tests
  `tests/onnx-ep-selection.test.ts` und `tests/onnx-separator-inmemory.test.ts`).
  DirectML/CUDA/CoreML brauchen echte Hardware – der Doctor macht das auf dem
  Zielrechner in einem Aufruf sichtbar.
* `onnxruntime-node` ist eine **optionale** Abhängigkeit: fehlt sie, bleibt der
  Studio-Pfad nutzbar und die ONNX-Tests werden übersprungen.
* Der Katalogwert `chunkSizeSamples: 343980` ist die bekannte HT-Demucs-Länge.
  Die Engine liest die tatsächliche Länge aus dem Graphen und meldet
  Abweichungen – kein stiller Neu-Zuschnitt.
* Ein einziger großer Fensterdurchlauf pro Track (und damit weniger
  Segmentnähte) wäre erst mit dynamischer Eingangsachse sinnvoll; das ist eine
  Export-Entscheidung, keine Engine-Entscheidung.
