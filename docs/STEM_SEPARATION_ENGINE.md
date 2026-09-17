# Stem Separation Engine

Die Stem-Separation ist eine **nicht-destruktive** Pipeline: Originaldateien
werden ausschließlich gelesen, Ergebnisse landen in eigenen Ausgabeordnern, und
jede Separation trägt ihre Herkunft (`DataOrigin.PROJECT_DSP`) sowie eine
ehrliche Qualitätskennzeichnung.

Es gibt zwei Engines mit derselben Vertragsoberfläche
(`src/audio/stemSeparation.ts` → `separateStemsAuto()`):
**Status: TEIL 1 (technische Funktionalität) und TEIL 2 (Goldstandard-Testtrack,
Qualitätsmetriken, Stem Isolation Gate) sind implementiert und automatisiert
geprüft. Ein echtes Qualitäts-`PASS` ist in dieser Umgebung mangels
trainiertem Checkpoint nicht erreichbar** — siehe
[Abschnitt „Teil 2“](#teil-2--stem-isolation-gate-goldstandard-testtrack-qualitätsmetriken).

## Technischer Kern

| Engine | Wo | Gewichte | Qualität | Verfügbarkeit |
|---|---|---|---|---|
| `desktop` (externe Inferenz) | Electron-Main-Process | echte trainierte Gewichte (`.ckpt`, `.onnx`, `.pth`) | `TRAINED` | nur Desktop-App + installierte `audio-separator`-CLI |
| `builtin` (interne Heuristik) | Renderer/Node, `src/stems/dspSeparator.ts` | keine | `HEURISTIC` | immer (Browser, Dev-Preview, Desktop) |

**Kein stiller Fallback:** Fehlt die CLI, ein Modell oder ein echter Dateipfad,
wird der Grund gesammelt (`fallbackReasons`), im Feedback-Dialog angezeigt, im
System-Protokoll festgehalten und im Deck als Badge `DSP-HEURISTIK` sichtbar
gemacht.

## 1. Eingebaute Heuristik (`dsp-heuristic-v1`)

Deterministisch, abhängigungsfrei, isomorph (Browser **und** Node), O(n):

1. **Vocals** – Mid/Side-Dominanz (Centre-Extraction) im Band 170 Hz–9 kHz,
   zusätzlich werden mittige Transienten ausgesteuert (Snare/Kick gehört nicht
   in den Gesang).
2. **Drums** – Transienten-Gate (schnelle gegen langsame Hüllkurve, rektifizierte
   Summe statt Mono-Downmix, damit hart panierte Hats nicht auslöschen).
3. **Bass** – 4th-order Butterworth-Tiefpass (170 Hz) auf dem Rest.
4. **Other** – exakter Rest.

Weil `other` als `mix − vocals − drums − bass` definiert ist, summieren sich die
Stems **samplegenau** zurück zum Mix (gemessener Fehler < 1e-9). Laufzeit:
30 s Stereo ≈ 0,25 s.

Grenzen, die bewusst nicht kaschiert werden: Mono-Material lässt sich ohne
Stereo-Bild nur eingeschränkt trennen (Hinweis im Report), und die Heuristik ist
kein Ersatz für trainierte Gewichte.

## 2. Modell-Gewichte (Model-Store)

`electron/stemModelStore.cjs` verwaltet die Gewichte im Benutzerdaten-Ordner:

```
<userData>/stem-models/
  model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt
  model_bs_roformer_ep_317_sdr_12.9755.ckpt
  htdemucs/…            (von der CLI verwaltet)
  model-manifest.json   (sha256, Größe, Quelle, Zeitstempel)
```

Regeln:

- Downloads landen zuerst in `<name>.part` und werden erst nach
  Größen- **und** Prüfsummenkontrolle atomar umbenannt → keine halben Gewichte.
- Wiederaufnahme über HTTP `Range`; Abbruch über `AbortController`.
- Direkt-Downloads nur über **HTTPS** (`AIRDOX_ALLOW_INSECURE_MODEL_DOWNLOAD=1`
  ausschließlich für lokale Tests).
- Dateinamen werden auf ihr Basename reduziert (keine Pfadtricks), erlaubte
  Endungen: `.ckpt .onnx .pth .th .pt .bin`.
- Modelle ohne Direkt-URL (z. B. `htdemucs`) delegiert die App an die CLI:
  `--model_filename htdemucs --model_file_dir <userData>/stem-models`. Die CLI
  lädt die Gewichte beim ersten Lauf in genau diesen Ordner; der Store zeigt sie
  danach als installiert an.

Der Katalog (`src/stems/modelCatalog.ts`) ist isomorph und wird zur Laufzeit mit
der Modell-Liste der CLI (`audio-separator -l --list_format=json`) über
`mergeRuntimeModels()` zusammengeführt.

## 3. Desktop-Anbindung (Electron)

`electron/main.cjs` + `electron/stemRunner.cjs`:

- `execFile` mit **Argument-Array** statt Shell-String: Tracknamen mit
  Leerzeichen, Umlauten oder Klammern können den Aufruf nicht zerlegen,
  Command-Injection über Dateinamen ist ausgeschlossen.
- Eigener Ausgabeordner pro Quelle (`<userData>/separated_stems/<Name>-<sha1>`),
  Ergebnis ist das Vorher/Nachher-Diff → keine Stem-Leichen früherer Läufe.
- Fortschritt aus den tqdm-Zeilen der CLI, Abbruch per IPC, Timeout 45 min.

IPC-Kanäle:

| Kanal | Zweck |
|---|---|
| `audio:separate-stems` | Trennen (Optionen: `model`, `modelFilename`, `chunkDuration`, `extraArgs`) |
| `audio:separator-status` | Ist die CLI verfügbar? (Pfad, Grund, Installationshinweis) |
| `audio:separate-stems:cancel` | Lauf abbrechen |
| `audio:separate-stems:progress` | Fortschritt/Phase/Code an den Renderer |
| `stems:models:list` | Katalog + Ist-Zustand des Modell-Ordners |
| `stems:models:runtime-catalog` | Von der CLI gemeldete Modelle |
| `stems:models:download` / `:cancel` / `:remove` / `:import` / `:open-folder` | Gewichte verwalten |
| `stems:models:progress` | Download-Fortschritt |

Fehlercodes (werden im Renderer in verständliche deutsche Meldungen inkl.
nächstem Schritt übersetzt):

`SEPARATOR_NOT_INSTALLED`, `SEPARATOR_INPUT_MISSING`, `SEPARATOR_NO_OUTPUT`,
`SEPARATOR_MODEL_MISSING`, `SEPARATOR_MODEL_NO_URL`, `SEPARATOR_MODEL_UNSUPPORTED`,
`SEPARATOR_MODEL_FAILED`, `SEPARATOR_RUNTIME_FAILED`, `SEPARATOR_TIMEOUT`,
`SEPARATOR_CANCELLED`, `SEPARATOR_FAILED`.

## 4. Editor-Anbindung

- `TrackHeader`: „Stems trennen“ erscheint für **jede** verknüpfte Audiodatei
  (nicht mehr nur bei vorhandenem Rekordbox-Dateipfad), zeigt Fortschritt und
  einen Abbruch-Button.
- `EditModeBar` / `TrackSeparation`: ACTIVE-PART-Buttons erhalten ihre
  Beschriftung und Farbe aus den tatsächlichen Stem-Ids (`vocals`, `drums`,
  `bass`, `other`) statt aus der Array-Position; ein Badge kennzeichnet
  `KI-MODELL` bzw. `DSP-HEURISTIK`.
- `audioEngine`: Stem-Gains werden pro Stem-Set neu aufgebaut (keine
  Alt-Gains), Mute/Solo überleben `play()`/`stop()`, Offset und Loop-Ende
  werden pro Stem geklemmt.
- Stems ersetzen den Mix nur, solange sie zum aktuell hörbaren Working-Buffer
  gehören; nach einem Edit sind alte Stems automatisch ungültig.
- Menü **Bearbeiten → Stem-Modelle & Gewichte …** öffnet die Modellverwaltung.

## 5. Stem Isolation Gate

`runStemIsolationGate()` erzeugt deterministisch einen 30-Sekunden-Testtrack
(Seed `20260913`) mit sechs Ground-Truth-Stems, 15 Mix-Varianten und objektiven
Metriken (SI-SDR/SDR, Bleed, Transienten, Stereo, Spektrum, Phasenlage):
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

Ohne trainierte Gewichte ist das beabsichtigte Ergebnis
`TECHNICAL_PASS_QUALITY_FAIL`: Weder das `PipelineDoubleSeparator` noch die
DSP-Heuristik können `RELEASE_READY` liefern, weil `fromTrainedModel` nur bei
echten Gewichten wahr ist.

## 6. Voraussetzungen für die trainierte Engine (Windows/macOS/Linux)

```bash
pip install "audio-separator[cpu]"    # bzw. [gpu] für CUDA
audio-separator --help                # muss im PATH funktionieren
```

Optional: eigener Pfad zur CLI über die Umgebungsvariable
`AIRDOX_AUDIO_SEPARATOR`. Die App findet die CLI zusätzlich in den
Python-Script-Ordnern (`…/Scripts`, `%APPDATA%/Python/*/Scripts`,
`~/.local/bin`).

## 7. Tests

```bash
npm run test:stems           # Gate, DSP-Heuristik, Service-Kette, Dateinamen
npm run test:stems:desktop   # Electron-Runner + Model-Store (mit HTTP-Stub)
npm run test:stems:live      # optionale Live-Inferenz (nur mit Checkpoint)
npm run lint && npm run build
```

Abdeckung: verlustfreie Rekombination, Determinismus, Block- vs.
Ein-Schuss-Lauf, Fortschritt/Abbruch, Energieverteilung auf dem Goldstandard,
ehrliche Metadaten, Mono, Backend-Adapter inkl. unverändertem Original-Hash,
Gate-Entscheidung, Fallback-Kette im Renderer, CLI-Aufruf/Argumente,
Fehlerklassifikation, Ausgabe-Diff, Modell-Download (Hash, Größe, Resume,
Abbruch, Import, Entfernen).
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
