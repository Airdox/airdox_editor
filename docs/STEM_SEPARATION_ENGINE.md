# Stem Separation Engine

Die Stem-Separation ist eine **nicht-destruktive** Pipeline: Originaldateien
werden ausschließlich gelesen, Ergebnisse landen in eigenen Ausgabeordnern, und
jede Separation trägt ihre Herkunft (`DataOrigin.PROJECT_DSP`) sowie eine
ehrliche Qualitätskennzeichnung.

Es gibt zwei Engines mit derselben Vertragsoberfläche
(`src/audio/stemSeparation.ts` → `separateStemsAuto()`):

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
