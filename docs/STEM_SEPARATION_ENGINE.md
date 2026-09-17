# STEM SEPARATION ENGINE — airdox_SMART_Editor

Nicht-destruktive KI-Stem-Separation für elektronische Musik (Techno, House,
Deep/Progressive House, Trance, DnB, Dubstep, EDM, Electro, Synthwave).

**Status: TEIL 1 (technische Funktionalität) und TEIL 2 (Goldstandard-Testtrack,
Qualitätsmetriken, Stem Isolation Gate) sind implementiert und automatisiert
geprüft. Ein echtes Qualitäts-`PASS` ist in dieser Umgebung mangels
trainiertem Checkpoint nicht erreichbar** — siehe
[Abschnitt 14](#14-teil-2--stem-isolation-gate-goldstandard-testtrack-qualitätsmetriken).

---

## 1. Unumstößliche Regeln

1. **Originale sind read-only.** Jede Transformation läuft auf einer Arbeitskopie.
   Vor und nach jedem Lauf wird der sha256 des Originals geprüft; eine Änderung
   ist ein harter Fehler (`ORIGINAL_MODIFIED`). Das gilt auch für jeden
   Fehler- und Abbruchpfad.
2. **Separation = trainiertes neuronales Modell.** Primäre HQ-Engine ist
   **BS-RoFormer** (STFT → Band-Split → Zeit-/Band-Attention → Masken-Schätzung
   → iSTFT). Regelwerke wie „alles unter 100 Hz = Bass" sind ausgeschlossen.
   STFT/Band-Split sind nur interne Repräsentation des Modells, kein Filter.
3. **Qualität vor Tempo.** In `HIGH_QUALITY`/`MAXIMUM_QUALITY` werden niemals
   automatisch die schnellsten Parameter gewählt.
4. **Keine Architektur-Festlegung auf einen Checkpoint.** Modellvariante,
   Stem-Reihenfolge, Overlap, Präzision und Profil kommen aus der
   `ModelRegistry` — der Kern kennt keine BS-RoFormer-Details.
5. **Der Kern ist GUI-frei und automatisiert testbar** (`src/stems/*`, keine
   Electron-/React-Importe).

---

## 2. Datenfluss

```
ORIGINAL/track.wav                      ← wird NIE geschrieben (sha256 geprüft)
   │  decode + Integritätsprüfung
   ▼
Working/track_44.1k_stereo.wav          ← 44,1 kHz, Stereo, float32 (Arbeitskopie)
   │  Chunk-Plan (überlappend)
   ▼
Backend-Inferenz je Chunk               ← BS-RoFormer (native C++ → Python/Torch → …)
   │  Overlap-Add / Crossfade
   ▼
Separation/track/{vocals,drums,bass,other}.wav
   │  Validierung (Datei, Header, Samplezahl, Samplerate, Kanäle, Hash,
   │                Rekombination, Chunk-Grenzen)
   ▼
Separation/track/job.json               ← Job-Metadaten (reproduzierbar)
   │
   ▼
Cache/<input_audio_hash:model_hash:settings_hash>/
```

Ordner werden vom Engine-Aufruf konfiguriert (`workingRoot`, `outputRoot`,
`cacheRoot`, `modelStoreDir`). Neu-Läufe verschieben den alten Stand nach
`Separation/track/.history/<jobId>_<hash>` statt zu überschreiben.

---

## 3. Modulübersicht (`src/stems/`, ~7.900 Zeilen inkl. Backends, Anbindung und Teil-2-Modulen)

| Modul | Aufgabe |
|---|---|
| `types.ts` | Alle Verträge: `ModelDescriptor`, `Stem`, `SeparationSettings`, `BoundaryContinuityReport`, `StemErrorCode` (20 Codes) |
| `stemSeparationEngine.ts` | `StemSeparationEngine`: Orchestrierung, Profile, Backend-Wahl, Abbruch, Cache, Historie |
| `stemJobService.ts` | `StemJobService`: job-orientierte Schicht für den Editor (Job-Id sofort, Events, Einzel-Stem-Download, Staging) |
| `transportTypes.ts` | Der einzige Datervertrag über IPC/HTTP (`StemJobView`, `StemServiceStatus`, `StemDesktopApi`) – frei von Node-Importen |
| `nodeBridge.ts` | Einstiegspunkt für das CommonJS-Bundle des Main-Prozesses (`dist/stems/node-bridge.cjs`) |
| `modelRegistry.ts` | `ModelRegistry` — lädt/validiert `modelCatalog.json`, Profil-Auflösung, `parametersFor()`, Content-Hash |
| `modelCatalog.json` | Datengetriebener Modell-Katalog (URLs, Hashes, `stemOrder`, `qualityProfile`) |
| `modelManager.ts` | `ModelManager` — Verfügbarkeit, sha256-Prüfung, Download-Freigabe, `listStatus()` |
| `stemRegistry.ts` | `StemRegistry` — Ausgabe-Index ↔ Stem-Id **aus dem Deskriptor**, nie aus Annahmen |
| `preprocessor.ts` | `Preprocessor` — Arbeitskopie, 44,1 kHz, Stereo-Duplizierung (kein Downmix), Resampling |
| `chunkProcessor.ts` | `planChunks`, `validateChunkPlan`, `SeparationCancellationToken` (cancel/pause/resume) |
| `reconstructor.ts` | `OverlapAddReconstructor`, `measureContinuity` (Klicks, Pegel-, Stereo-Sprünge, Transienten), `measureBoundaryError` |
| `qualityValidator.ts` | Datei-/Header-/Hash-Prüfung, Rekombinations- und Grenzmetrik, Issue-Codes |
| `qualityGate.ts` | `runTechnicalGate()` — die 10 technischen Prüfungen von Teil 1, schreibt JSON-Bericht |
| `separationJob.ts` | `SeparationJob` — `job.json`, Statusübergänge, Fortschritt, Validierungsbericht |
| `separationCache.ts` | `SeparationCache` — Schlüssel, Integrität, Invalidierung bei Beschädigung |
| `wavIo.ts` | Selbstständige WAV-I/O (float32/16/24/32), Resampling, `sha256File`, `analyzeAudio` |
| `testAudioGenerator.ts` | Deterministischer, kurzer 4-Stem-EDM-Testtrack (Kick, Bass, Hats, Supersaw) für Teil-1-Tests |
| `dsp.ts` (Teil 2) | FFT/STFT, Onset-Erkennung, Cross-Correlation-Lag — reine Signalanalyse |
| `mixEffects.ts` (Teil 2) | Bus-Effekte (Kompression, Limiting, Sättigung, Clipping, Stereo-Breite, Reverb, Delay, Sidechain, Auto-Pan) für Testvarianten |
| `metrics.ts` (Teil 2) | SDR/SI-SDR/Interference/Bleed/Stereo/Transient/Pegel/Spektrum/Phase, `evaluateStem()`, `qualityScore()` |
| `goldStandard.ts` (Teil 2) | `generateGoldStandardTrack()` — 30-s-Goldstandard, 6 Ground-Truth-Stems, 6 Segmente |
| `goldStandardVariants.ts` (Teil 2) | `buildGoldStandardVariants()` — 15 benannte Mix-Varianten |
| `stemGroupMapping.ts` (Teil 2) | Ordnet Ground-Truth-Quellen den tatsächlichen Modell-Stems zu |
| `stemIsolationGate.ts` (Teil 2) | `runStemIsolationGate()` — End-to-End-Gate, Report-Verzeichnis, Release-Entscheidung |
| `backends/types.ts` | `IStemSeparator` — das einzige Interface, das der Kern kennt |
| `backends/roformerSeparator.ts` | `BSRoFormerSeparator`, `MelBandRoFormerSeparator` (Transport: `native-cli` / `python-torch`) |
| `backends/htDemucsSeparator.ts` | `HTDemucsSeparator` (PREVIEW-Profil) |
| `backends/processTransport.ts` | JSONL-Protokoll, Exit-Code-Map, SIGTERM, Probe von Executables |
| `backends/pipelineDoubleSeparator.ts` | **Test-Double, kein Modell** — nur mit `allowPipelineDouble: true`, taggt jeden Job als `pipeline_double` |

Python (nur Entwicklung/Konvertierung/Offline-Tests, nie im Endprodukt):

| Datei | Aufgabe |
|---|---|
| `python/bsroformer_inference.py` | Adapter auf die Referenz-Implementierung; spricht exakt das JSONL-Protokoll des Kerns |
| `tests/fixtures/bsroformer/tiny_bs_roformer.yaml` | Verkleinerte, aber strukturell echte BS-RoFormer-Architektur für CI |
| `tests/fixtures/backends/stub_separator.py` | Protokoll-Stub für Backend-Vertragstests |

---

## 4. Modell-Registry

Jeder Eintrag (`ModelDescriptor`) trägt mindestens: `id`, `family`, `version`,
`checkpoint{file,url}`, `config{file,url}`, `sampleRate`, `inputChannels`,
`outputStems`, **`stemOrder`**, `modelHash`, `license`, `backendSupport`,
`precision`, `chunkSizeSamples`, `recommendedOverlap`, `qualityProfile`.

Registrierte Modelle (Content-Hash `91db7a913ae42946`):

| id | Familie | Stems | Rolle |
|---|---|---|---|
| `bsroformer-musdb18hq-4stem-zfturbo` | `bs_roformer` | vocals, bass, drums, other | **HIGH_QUALITY / MAXIMUM_QUALITY** |
| `bsroformer-viperx-vocals-1297` | `bs_roformer` | vocals, other | HQ-Vocal-Alternative |
| `melbandroformer-viperx-vocals-3005` | `mel_band_roformer` | vocals, other | Vergleichsfamilie |
| `htdemucs-ft-4stem` | `htdemucs` | drums, bass, other, vocals | **PREVIEW** |
| `pipeline-double-v1` | `pipeline_double` | 4 | Test-Double, kein Modell |

**Stem-Reihenfolge:** `stemOrder` kommt aus dem Checkpoint-Config
(`training.instruments` bzw. `target_instrument`). Der Adapter meldet
`configStemOrder` im `done`-Report; weicht der Deskriptor ab, bricht der Lauf mit
`MODEL_INCOMPATIBLE` ab — falsch benannte Stems sind damit ausgeschlossen
(getestet: `other,vocals` gegen Config `vocals,other`).

---

## 5. Qualitätsprofile

| Profil | Modell | Chunk-Overlap | Präferenz Präzision | Parameter aus dem Deskriptor |
|---|---|---|---|---|
| `PREVIEW` | `htdemucs-ft-4stem` | 0,25 | q8_0 → f16 → f32 | num_overlap 1 |
| `HIGH_QUALITY` | `bsroformer-musdb18hq-4stem-zfturbo` | 0,50 | f32 → native | num_overlap 4, Ensemble 1 |
| `MAXIMUM_QUALITY` | `bsroformer-musdb18hq-4stem-zfturbo` | 0,60 | f32 → native | **num_overlap 6, Ensemble 3** |

`MAXIMUM_QUALITY` erhöht also innere Overlaps *und* Ensemble-Pässe; beides wird
bis ins Backend durchgereicht (im Test über den `lastReport()` des Backends
belegt, nicht nur in den Metadaten).

---

## 6. Backends

Der Kern kennt ausschließlich `IStemSeparator`
(`capabilities`, `supportsDescriptor`, `isAvailable`, `separate`).

**Transport-Reihenfolge:** natives C++-Binary (`audiocpp_cli`, Dialekte
`audio.cpp` / `bsroformer.cpp`) → Python/Torch-Adapter → Fehler
`BACKEND_UNAVAILABLE`. Native Builds liefern eine feste Ausgabe-Menge
(vocals + instrumental); verlangt der Deskriptor mehr Stems, wird das
**abgelehnt statt teilausgeliefert**.

**JSONL-Protokoll** (stdout, eine Meldung pro Zeile):

```json
{"type":"progress","fraction":0.42,"phase":"chunk 2/5"}
{"type":"stem","index":0,"name":"vocals","path":"/abs/stem_0_vocals.wav"}
{"type":"log","level":"warning","message":"…"}
{"type":"error","code":"GPU_OUT_OF_MEMORY","message":"…"}
{"type":"done","device":"cpu","stems":[…],"report":{…}}
```

**Exit-Code-Map:** `0` ok · `130` `INFERENCE_CANCELLED` · `2`
`STEM_CONFIG_INVALID` · `3` `MODEL_CORRUPT` · `4` `WRITE_DENIED` · `5`
`AUDIO_CORRUPT`. Eine Protokoll-`error`-Meldung mit bekanntem Code gewinnt
gegenüber der Exit-Map; fehlt `done`, gilt `INFERENCE_FAILED`; startet der
Prozess gar nicht, `BACKEND_UNAVAILABLE`.

**Referenz-Architektur:** der Adapter importiert `models.bs_roformer.BSRoformer`
aus (1) `--reference-source-dir`/`AIRODOX_MSST_DIR` (Checkout von
ZFTurbo/Music-Source-Separation-Training) oder (2) dem offiziellen PyPI-Paket
`msst` (`pip install --no-deps msst==0.1.0`). Die tatsächlich benutzte Quelle
steht als `referenceSource` im `done`-Report.

**Endprodukt:** natives C++ → GPU → CPU-Fallback → portables Format
(GGUF/SafeTensors). Python/PyTorch bleiben Entwicklungs- und Konvertierungswerkzeug.

---

## 7. Chunking & Overlap-Add

`planChunks({ totalFrames, chunkSamples, overlapFraction, sampleRate })`
erzeugt lückenlose, überlappende Segmente; das letzte Segment endet exakt am
Dateiende (kein doppeltes Tail). `overlapFraction = 0` ist erlaubt und liefert
bewusst harte Schnitte — sie dienen dem Nachweis, dass Overlap-Add nötig ist.

`OverlapAddReconstructor` akkumuliert mit Raised-Cosine-Fenster, normiert über
die Fenstersumme und liefert Interleaved-float32.

**Grenzmetrik** (`measureContinuity`, Zweitdifferenz-Klickdetektor mit
99,9-Perzentil-Innenreferenz):

* `excessDb` — Klickstärke an Grenzen gegenüber dem Dateiinneren (Limit 6 dB)
* `rmsJumpDb` — Lautheitssprung (Limit 9 dB)
* `stereoJump` — Änderung der Mid/Side-Korrelation (Limit 0,35)
* `duplicateTransients` / `missingTransients` — verdoppelte/verlorene Einsätze
* zusätzlich `measureBoundaryError`: Rekonstruktionsfehler **an** Grenzen gegen
  den Fehler **im** Inneren (`boundaryErrorExcessDb`, Limit 12 dB)

**Gemessener Nachweis** (3 s Testtrack, Chunk 44.100 Samples = 1 s):

| Lauf | Rekombinationsfehler | Grenzfehler | Innenfehler | Überschuss | Pegelsprung |
|---|---|---|---|---|---|
| harte Schnitte (overlap 0) | −18,4 dB | −5,5 dB | −143,5 dB | **+138 dB → VALIDATION_FAILED** | 3,7 dB |
| Overlap-Add (overlap 0,5) | −77,2 dB | −67,9 dB | −72,5 dB | +4,7 dB (ok) | 0,0 dB |

Overlap-Add verbessert die Rekombination um 59 dB und macht den
grenzspezifischen Fehler verschwindend — harte Schnitte werden zuverlässig als
Artefakt erkannt. Im normalen Gate-Durchlauf (kohärentes Double):
Rekombination −147,4 dB, Grenzüberschuss −15,7 dB, Pegelsprung 3,8·10⁻⁸ dB,
Stereo-Sprung 2,1·10⁻⁷, 0 doppelte / 0 fehlende Transienten an den Grenzen
22050/44100/66150/88200.

---

## 8. Validierung

Ein Stem gilt erst dann als fertig, wenn **alle** Punkte erfüllt sind:
Verarbeitung abgeschlossen, plausible Dateigröße, gültiger WAV-Header,
korrekte Samplezahl, Samplerate und Kanalzahl, endliche Werte, berechneter Hash.

Issue-Codes: `STEM_FILE_MISSING`, `STEM_SIZE_IMPLAUSIBLE`, `STEM_HEADER_INVALID`,
`STEM_SAMPLE_RATE_MISMATCH`, `STEM_CHANNEL_MISMATCH`, `STEM_FRAME_MISMATCH`,
`STEM_NON_FINITE`, `STEM_OVER_LEVEL` (Warnung), `STEM_DC_OFFSET` (Warnung),
`RECOMBINATION_DEVIATION`, `DUPLICATE_TRANSIENT`, `MISSING_TRANSIENT`,
`BOUNDARY_CLICK`, `BOUNDARY_LEVEL_JUMP`, `BOUNDARY_STEREO_JUMP` (Warnung),
`BOUNDARY_SPECIFIC_ERROR`.

Rekombinationslimit: trainierte Modelle −24 dB (Warnung, echte Modelle
rekonstruieren den Mix nie exakt), deterministisches Double −90 dB (Fehler),
per `recombinationLimitDb` überschreibbar.

---

## 9. Cache

Schlüssel `input_audio_hash : model_hash : settings_hash`
(`buildCacheKey`). Jeder Parameter, der das Ergebnis ändern kann (Overlap,
Präzision, num_overlap, DC-Removal, …), fließt in `settings_hash` — geändert
bedeutet neue Inferenz (getestet). Der Cache berührt niemals Originale.
Beschädigte Einträge werden erkannt (`CACHE_CORRUPT`), verworfen und neu
berechnet.

---

## 10. Abbruch, Pause, Wiederaufnahme

`SeparationCancellationToken` mit `cancel()`, `pause()`, `resume()`;
Backend-Prozesse werden per SIGTERM beendet (Exit 130 → `INFERENCE_CANCELLED`).
Nach einem Abbruch gilt: Original unverändert, **keine** Stem-Datei als fertig
markiert, `job.json` mit Status `CANCELLED`, Temporärdateien im
Arbeitsverzeichnis. `pause()`/`resume()` ändern das Ergebnis nicht.

---

## 11. Fehlermatrix

| Situation | Code | Original |
|---|---|---|
| Modell nicht in der Registry / Checkpoint fehlt | `MODEL_MISSING` | unverändert |
| Checkpoint unlesbar / Hash-Abweichung | `MODEL_CORRUPT` | unverändert |
| `stem_order` widerspricht Config, Präzision nicht unterstützt | `MODEL_INCOMPATIBLE` | unverändert |
| Katalog fehlerhaft / doppelte IDs | `MODEL_REGISTRY_INVALID` | unverändert |
| Audio fehlt / unlesbar | `AUDIO_MISSING` / `AUDIO_CORRUPT` | unverändert |
| Samplerate passt nicht zum Modell | `AUDIO_INVALID_SAMPLE_RATE` | unverändert |
| Format ohne Decoder | `AUDIO_UNSUPPORTED_FORMAT` | unverändert |
| GPU nicht verfügbar / Speicher voll | `GPU_UNAVAILABLE` / `GPU_OUT_OF_MEMORY` / `CPU_FALLBACK_REQUIRED` | unverändert |
| Keine Schreibrechte / Platte voll | `WRITE_DENIED` / `DISK_FULL` | unverändert |
| Abbruch / fehlgeschlagene Inferenz | `INFERENCE_CANCELLED` / `INFERENCE_FAILED` | unverändert |
| Kein lauffähiges Backend | `BACKEND_UNAVAILABLE` | unverändert |
| Cache beschädigt | `CACHE_CORRUPT` | unverändert |
| Unvollständige/unbekannte Stem-Lieferung | `STEM_CONFIG_INVALID` | unverändert |
| Original verändert | `ORIGINAL_MODIFIED` | — (harter Fehler) |
| Validierung besteht nicht | `VALIDATION_FAILED` | unverändert |

Alle Fälle sind in `tests/stem-separation-engine-gate.test.ts` (Gruppe 14) und
`tests/stem-separation-backend-contract.test.ts` automatisiert; nach der
gesamten Matrix wird der Original-Hash erneut geprüft.

---

## 12. Technische Gate (Teil 1)

`runTechnicalGate()` prüft und protokolliert zehn Punkte:

`ORIGINAL_HASH_UNCHANGED`, `SEPARATION_COMPLETED`, `WORKING_COPY_44K_STEREO`,
`CHUNKED_INFERENCE`, `OVERLAP_ADD_RECONSTRUCTION`, `STEM_FILES_VALIDATED`,
`STEREO_PRESERVED`, `JOB_METADATA_COMPLETE`, `CACHE_REUSE`,
`ENGINE_INTEGRITY_CHECK`.

Der Bericht wird als JSON geschrieben (maschinenlesbar, CI-auswertbar) und
enthält je Prüfung `pass`, Titel, Details und Messwerte.

---

## 13. Tests

```bash
npm test                    # komplette Suite über scripts/run-tests.mjs (Fund + SKIP-Logik)
npm run test:stems          # Gruppe `stems`: Registry + Backend-Vertrag + Technical Gate
                            # + Stem Isolation Gate (Teil 2) + Job-Schicht + IPC-Vertrag
npm run test:stems:release  # Gruppe `stems-release` mit --fail-on-skip (Freigabe-Lauf)
npm run test:stems:live     # Gruppe `stems-live`: echte BS-RoFormer-Architektur + Live-Gate
npm run test:stems:all      # alle Separations- und Gate-Suiten (SKIPs erlaubt)
npm run lint                # tsc --noEmit
```

`scripts/run-tests.mjs` sammelt die Tests per Dateisuche (`tests/**/*.test.*`) –
neue Testdateien brauchen keinen Eintrag in `package.json` mehr. Eine Zeile, die
von parallelen Branches umgeschrieben werden muss, war die Ursache für doppelt
vorhandene `"test"`-Schlüssel und damit für ungültiges JSON (CI-Abbruch bereits
bei `npm ci`). Umgebungsabhängige Suiten erklären sich im Dateikopf:
`// @requires: python, torch, demucs, model, network` → ohne diese Voraussetzungen
meldet der Runner SKIP statt Fehler; mit `--fail-on-skip` wird ein SKIP zum
Freigabe-Hindernis (so läuft `test:stems:live`).

| Suite | Gruppen | Belegt |
|---|---|---|
| `tests/stem-separation-registry.test.ts` | 8 | Katalog-Validierung, Profil-Auflösung, Stem-Mapping, Modell-Hashes, Cache-Schlüssel |
| `tests/stem-separation-backend-contract.test.ts` | 10 | JSONL-Protokoll, `stem_order`-Prüfung, SIGTERM, Exit-Code-Map, GPU→CPU-Fallback, native Verträge, `BACKEND_UNAVAILABLE` |
| `tests/stem-separation-engine-gate.test.ts` | 19 | Gesamtdurchlauf, Read-only-Nachweis, Resampling, Stereo, Grenzmetrik, harte Schnitte vs. Overlap-Add, Backend-Aufrufzählung, Job-Metadaten, Cache, Abbruch/Pause, Fehlermatrix, Profile, Historie, Recovery, Gate-Bericht |
| `tests/stem-separation-bsroformer-live.test.ts` | 8 | echte Architektur + Protokoll, keine stillen Zufallsgewichte, `stem_order`-Widerspruch, Overlap-Add auf echter Modellausgabe, Abbruch des echten Prozesses, Original-Hash |
| `tests/stem-isolation-gate.test.ts` (TEIL 2) | 18 | 30-s-Goldstandard-Track (deterministisch, 6 Stems, 6 Segmente), ≥15 Mix-Varianten, Frequenzüberlappungspaare, Stem-Group-Mapping, Metrik-Grundfunktionen (SI-SDR/Bleed/Transient/Stereo), Chunk-Boundary-A/B-Test, Determinismus, Original-Integrität, Crash-Recovery, Fehlerfälle, Stem-Isolation-Gate End-to-End (muss `TECHNICAL_PASS_QUALITY_FAIL` liefern, nie fabriziertes `RELEASE_READY`), Report-Verzeichnis (§26), Release-Entscheidung-Eindeutigkeit |
| `tests/stem-job-service.test.ts` | 10 | Job-Ansicht sofort, Stem-Liste aus dem Deskriptor (3-Stem-Modell), monotones Progress, Einzel-Stem-Download, `job.json`, Cache, Abbruch, Pause/Fortsetzung, Bridge-Ergebnisse, Staging statt Original |
| `tests/stem-engine-ipc-contract.test.ts` | 8 | Katalog→`STEM_NAMES`, preload↔Host-Kanaleindeutigkeit, `StemDesktopApi`↔preload 1:1, browser-sicherer Vertrag, Brücke ohne Build, Request-Filterung, End-to-End über das echte Bundle, UI-Routing |
| `tests/stem-isolation-gate-live.test.ts` (opt-in) | 6 | **Qualitätsfreigabe** mit trainiertem Checkpoint über den Produktionspfad (`StemSeparationEngine` → Adapter → BS-RoFormer): `modelHash`-Prüfung gegen das Manifest, Gate-Entscheidung `RELEASE_READY`/`QUALITY_FAIL`, Messwerttabelle je Stem, Original-Hash vor/nach. Läuft nur mit `AIRODOX_STEM_ALLOW_QUALITY_RUN=1` und installiertem Checkpoint – sonst SKIP, nie ein erfundenes PASS |

Alle Suiten überspringen sauber, wenn Python/PyTorch fehlen (nur
`stem-separation-bsroformer-live.test.ts`; `stem-isolation-gate.test.ts` läuft
immer, da es gegen den `PipelineDoubleSeparator` testet).

### Einrichtung der Modellumgebung

```bash
bash scripts/setup-bsroformer-model.sh                 # Architektur + HQ-Gewichte
bash scripts/setup-bsroformer-model.sh --skip-download # nur Architektur
bash scripts/setup-bsroformer-model.sh --models id1,id2 --home /pfad --force
```

Das Skript liest **alle** URLs aus `src/stems/modelCatalog.json`, löscht niemals
einen vorhandenen Stand, prüft sha256 gegen den Katalog (bzw. meldet den
berechneten Hash, solange `modelHash: "unverified"` steht) und schreibt
`manifest.json`. Nützliche Variablen: `AIRODOX_STEM_HOME`, `AIRODOX_STEM_PYTHON`,
`AIRODOX_MSST_DIR`, `AIRODOX_STEM_CHECKPOINT_DIR`.

---

## 14. TEIL 2 — Stem Isolation Gate, Goldstandard-Testtrack, Qualitätsmetriken

TEIL 2 ist implementiert: Testtrack, Varianten, Metriken, Bleed-/Transient-/
Stereo-/Chunk-Boundary-/Recombination-Tests und der Stem Isolation Gate selbst
sind vorhanden und automatisiert getestet (`npm run test:stems` schließt
`tests/stem-isolation-gate.test.ts` ein). **Was weiterhin fehlt, ist ein
trainierter Checkpoint** — deshalb kann dieser Gate in dieser Umgebung niemals
ein echtes Qualitäts-`PASS` liefern, sondern konsequent nur
`TECHNICAL_PASS_QUALITY_FAIL` (siehe unten). Das ist beabsichtigtes Verhalten,
kein Bug.

### 14.1 Module

| Modul | Zweck |
|---|---|
| `src/stems/dsp.ts` | FFT, STFT, Onset-Erkennung, Cross-Correlation-Lag — reine Analyse, kein Audio-I/O |
| `src/stems/mixEffects.ts` | Bus-Effekte für Testvarianten: Kompression, Limiting, Sättigung, Clipping, Stereo-Breite, Reverb, Delay, Sidechain, Auto-Pan |
| `src/stems/metrics.ts` | SDR, SI-SDR, Interference, Bleed-Tabelle, Stereo-Vergleich, Transient-Vergleich, Pegel-/Spektral-/Phasen-Vergleich, `evaluateStem()`, `qualityScore()` (1–9.5, nie 10) |
| `src/stems/goldStandard.ts` | `generateGoldStandardTrack()` — deterministischer 30-s-Track, Seed `TEST_SEED=20260913`, 6 Ground-Truth-Stems (vocals/drums/bass/synth/percussion/fx), 6 Segmente à 5 s mit gezielten Frequenzüberlappungen |
| `src/stems/goldStandardVariants.ts` | `buildGoldStandardVariants()` — 15 benannte Mix-Varianten (Clean … Dense Full Mix) aus denselben Ground-Truth-Stems |
| `src/stems/stemGroupMapping.ts` | Ordnet die 6 Ground-Truth-Quellen den tatsächlichen Modell-Stems zu (z. B. 4-Stem-Modell: `other` = synth+percussion+fx), dokumentiert statt versteckt |
| `src/stems/stemIsolationGate.ts` | `runStemIsolationGate()` — End-to-End-Orchestrierung: Track bauen → Separation laufen lassen → pro Stem gegen Ground Truth vergleichen → rekombinieren → Original-Hash prüfen → Ergebnistabelle + `report_run/`-Verzeichnis + Release-Entscheidung |

### 14.2 Warum ein Qualitäts-`PASS` hier nicht möglich ist

In der Sandbox sind GitHub-Release-Assets nicht erreichbar (siehe §15), also
ist kein trainierter Checkpoint installierbar. Jeder Lauf mit dem echten
BS-RoFormer-Adapter läuft folglich mit `--allow-random-weights`; jeder solche
Lauf meldet `weights: "random"`. Ein untrainiertes Netz erzeugt zufällige
Masken — die Ausgabe ist technisch gültig, aber keine Separation.

`runStemIsolationGate()` erkennt das explizit über `detectRandomWeights()`
(request-Extra ODER Backend-Report) und über `capabilities().trainedModel`
des Backends, und setzt in diesem Fall **hart**:

* `qualityPass = false`
* `releaseDecision = 'TECHNICAL_PASS_QUALITY_FAIL'` (nie `RELEASE_READY`)

Das gilt auch für den `PipelineDoubleSeparator` (Teil 1, kein Modell
überhaupt) — beide Fälle sind in `tests/stem-isolation-gate.test.ts` #16
verifiziert: der Gate darf niemals ein Qualitäts-`PASS` fabrizieren, ohne
dass eine echte, trainierte Separation stattgefunden hat.

Erst wenn trainierte Gewichte vorliegen
(`scripts/setup-bsroformer-model.sh`, erwartet
`model_bs_roformer_ep_17_sdr_9.6568.ckpt`), kann `RELEASE_READY` überhaupt
erreicht werden. Bis dahin gilt: **technisch funktionsfähig, Qualität
"nicht bewertbar" statt fabriziert.**

### 14.3 Report-Layout

`runStemIsolationGate({ outputRoot })` schreibt exakt die im Master-Prompt
geforderte Struktur:

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

### 14.4 Qualitätsfreigabe außerhalb der Sandbox (Google Colab)

Wo Release-Assets unerreichbar sind, wird die Messung nicht weggelassen oder
weichgerechnet, sondern **derselbe Code auf einer Maschine mit Netzwerk**
ausgeführt. Dafür liegt `colab/airdox-stem-gate.ipynb` im Repo (gebaut aus
`colab/airdox-stem-gate.md`, Prüfung in CI):

```bash
npm run stems:gate:archive             # stem-gate-colab.tar.gz (Quellcode, ~0,5 MB)
# → Datei nach Google Drive, Notebook in Colab öffnen (Laufzeit: T4), Zellen laufen lassen
npm run test:stems:gate                # derselbe Lauf, lokal, wenn Gewichte erreichbar sind
npm run test:stems:gate:strict         # wie oben, aber QUALITY_FAIL = Exit-Code != 0
npm run stems:gate:notebook -- --check # .ipynb passt zu .md (CI)
```

Der Freigabe-Lauf ist `tests/stem-isolation-gate-live.test.ts` und läuft über
den Produktionspfad (`StemSeparationEngine` → `BSRoFormerSeparator` →
`python/bsroformer_inference.py`). Seine Invarianten:

* **Opt-in:** ohne `AIRODOX_STEM_ALLOW_QUALITY_RUN=1` bricht die Suite ab, bevor
  Audio ein Backend erreicht – ein aufwändiger Lauf (GPU-Stunde) kann nicht
  versehentlich anspringen. Der Runner setzt das Flag für `test:stems:gate*`.
* **Identität:** sha256 des Checkpoints gegen `modelCatalog.json`; bei
  `modelHash: "unverified"` wird der gemessene Hash als `model-hash-patch.json`
  ausgegeben, damit er gepinnt werden kann. Ein gemessener Hash != gepinnter
  Hash bricht ab.
* **Kein Qualitäts-Autor:** Bestehen oder Nichtbestehen entscheidet
  `runStemIsolationGate()`. Die Suite prüft nur die Bedingungen, ohne die das
  Ergebnis wertlos wäre (`fromTrainedModel`, `weights != random`, Original-Hash
  unverändert, alle Stems technisch valide, Bericht vollständig) und meldet
  `TECHNICAL_PASS_QUALITY_FAIL` als gültiges Protokoll, nicht als Testfehler.
* **Plausibilität:** gemessenes SI-SDR je Stem muss innerhalb
  `AIRODOX_STEM_GATE_SDR_TOLERANCE` (Default 4 dB) um die publizierten
  Referenzwerte liegen – ein Checkpoint mit anderer Config/Stem-Reihenfolge
  fällt dadurch auf, statt einen schönen Mittelwert zu liefern.
* **Nachweis:** `stem-gate-summary.json` + `test_run/` (Entscheidung, Scores,
  Hashes, Gerät/Profil/Präzision, Laufzeit). Freigabe gilt nur für den
  dokumentierten Stand **und** den dokumentierten `modelHash`.

Ein Colab-Lauf ersetzt ausdrücklich nicht den Windows-Packaging-Build und nicht
Punkt 6 (natives C++-Runtime, GGUF/SafeTensors); er beantwortet nur die Frage
„trennt das trainierte Modell gut genug, über die gesamte Kette, ohne das
Original anzufassen“.

---

## 15. Offene Punkte / bekannte Grenzen

* Natives C++-Runtime-Binary existiert noch nicht — der Vertrag
  (`audiocpp_cli --task sep …`) ist implementiert und getestet, das Binary fehlt
  in dieser Umgebung (kein `cmake`). Der Python-Pfad ist Entwicklungswerkzeug.
* `modelHash` steht im Katalog auf `"unverified"`, solange die Gewichte nicht
  geladen und geprüft wurden; das Setup-Skript liefert den zu hinterlegenden
  sha256. Wo Release-Assets nicht erreichbar sind, erledigt das
  `colab/airdox-stem-gate.ipynb` Download, Hash-Berechnung und Freigabemessung
  (§14.4) – der daraus entstehende Patch-Vorschlag muss ins Repo, sonst bleibt
  der Lauf unbeweisbar.
* **Anbindung an den Editor ist erfolgt** (Schritt 3 aus Teil 1 → jetzt):
  `src/stems/stemJobService.ts` ist die job-orientierte Schicht über der Engine,
  `src/stems/nodeBridge.ts` wird per `npm run build:stems-bridge` nach
  `dist/stems/node-bridge.cjs` gebündelt, `electron/stemEngineBridge.cjs` registriert
  die IPC-Kanäle (`stems:engine-status`, `stems:job-*`, `stems:job-progress`),
  `server.ts` bedient dieselben Vorgänge über HTTP (`/api/stems/engine`,
  `/api/stems/jobs…`). Der Renderer (`src/audio/stemEngine.ts`) wählt nach Profil:
  `HIGH_QUALITY`/`MAXIMUM_QUALITY` über den Kern, `PREVIEW` bleibt der
  Demucs-Pfad; die Stem-Liste kommt aus `stems.stemIds` (Deskriptor), die
  htdemucs-Namen des Vorschau-Pfads aus `modelCatalog.json` statt aus einer
  Konstanten. Fortschritt und „Abbrechen“ sitzen im Deck (`DeckStemsControl`).
  Offen geblieben: Der Mischpult-Desk des Decks hat vier Slots
  (vocals/drums/bass/other). Modelle mit anderen Stem-Mengen laufen durch die
  Engine und werden als Job sauber validiert, aber `buildTrackStems` bricht mit
  klarer Meldung ab, statt Stems still zu ignorieren – ein 6-Stem-oder
  2-Stem-Mixer ist ein eigener UI-Schritt.
