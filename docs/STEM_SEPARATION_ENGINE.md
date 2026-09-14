# STEM SEPARATION ENGINE — airdox_SMART_Editor

Nicht-destruktive KI-Stem-Separation für elektronische Musik (Techno, House,
Deep/Progressive House, Trance, DnB, Dubstep, EDM, Electro, Synthwave).

**Status: TEIL 1 (technische Funktionalität) ist implementiert und automatisiert
geprüft. TEIL 2 (Trennqualität, Stem Isolation Gate) ist implementiert** —
30-s-EDM-Track mit Ground Truth, SI-SDR-Metrik und Gate laufen als
`npm run test:stems:gate`. Ausgeführt wird der Gate entweder mit dem echten
MUSDB18-HQ-Checkpoint (`model_bs_roformer_ep_17_sdr_9.6568.ckpt`) oder — wenn
dieser nicht beschaffbar ist (Sandbox ohne GitHub-Release-Assets) — mit dem
lokaly trainierten EDMSMOKE-Smoke-Checkpoint
(`npm run stems:smoke:train`, synthetische Domäne, beweist den trainierten
Pfad END-TO-END, kein Produktionsmodell). [Abschnitt 14](#14-teil-2--stem-isolation-gate).

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

## 3. Modulübersicht (`src/stems/`, 5.080 Zeilen inkl. Backends)

| Modul | Aufgabe |
|---|---|
| `types.ts` | Alle Verträge: `ModelDescriptor`, `Stem`, `SeparationSettings`, `BoundaryContinuityReport`, `StemErrorCode` (20 Codes) |
| `stemSeparationEngine.ts` | `StemSeparationEngine`: Orchestrierung, Profile, Backend-Wahl, Abbruch, Cache, Historie |
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
| `testAudioGenerator.ts` | Deterministischer EDM-Testtrack (Kick, Bass, Hats, Supersaw, Side-Mix) für Tests |
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
npm run test:stems          # Registry + Backend-Vertrag + Technical Gate
npm run test:stems:live     # echte BS-RoFormer-Architektur über den Adapter
npm run test:stems:all      # beides
npm run lint                # tsc --noEmit
```

| Suite | Gruppen | Belegt |
|---|---|---|
| `tests/stem-separation-registry.test.ts` | 8 | Katalog-Validierung, Profil-Auflösung, Stem-Mapping, Modell-Hashes, Cache-Schlüssel |
| `tests/stem-separation-backend-contract.test.ts` | 10 | JSONL-Protokoll, `stem_order`-Prüfung, SIGTERM, Exit-Code-Map, GPU→CPU-Fallback, native Verträge, `BACKEND_UNAVAILABLE` |
| `tests/stem-separation-engine-gate.test.ts` | 19 | Gesamtdurchlauf, Read-only-Nachweis, Resampling, Stereo, Grenzmetrik, harte Schnitte vs. Overlap-Add, Backend-Aufrufzählung, Job-Metadaten, Cache, Abbruch/Pause, Fehlermatrix, Profile, Historie, Recovery, Gate-Bericht |
| `tests/stem-separation-bsroformer-live.test.ts` | 8 | echte Architektur + Protokoll, keine stillen Zufallsgewichte, `stem_order`-Widerspruch, Overlap-Add auf echter Modellausgabe, Abbruch des echten Prozesses, Original-Hash |

Alle Suiten überspringen sauber, wenn Python/PyTorch fehlen.

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

## 14. TEIL 2 — STEM ISOLATION GATE

Die Qualitätsfreigabe ist als automatisierter Gate implementiert
(`src/stems/isolationGate.ts`, Test: `tests/stem-separation-isolation-gate.test.ts`,
`npm run test:stems:gate`). Ablauf:

1. **30-s-EDM-Testtrack** mit Ground-Truth-Stems, deterministisch aus Seed
   `0xede2` (126 BPM). Die Trainings-Seeds des Smoke-Checkpoints sind
   bewusst disjunkt dazu — der Gate misst Generalisierung, kein Auswendiglernen.
2. **SI-SDR gegen Ground Truth** pro Stem (Mono-Downmix, mittelbereinigt,
   skaleninvariant). Zusätzlich wird pro Stem die **Mischungs-Baseline**
   (SI-SDR des Rohmixes gegen die Ground Truth) und daraus der
   **Isolationsgewinn** (SI-SDR − Baseline) gemessen.
3. **Random-Control**: dieselbe Architektur mit `--allow-random-weights`
   (Development-only) **muss** durch den Gate fallen; zusätzlich muss der
   Isolationsgewinn jedes trainierten Stems den des Zufalls-Laufs deutlich
   schlagen (Abstand ≥ 3 dB). Das beweist, dass der Gate trainiert und
   untrainiert unterscheidet, statt alles durchzuwinken.
4. **Stem Isolation Gate**: jeder Stem braucht (a) SI-SDR ≥ Floor und
   (b) Isolationsgewinn ≥ Gain-Schwelle — **oder** als Alternative für
   überlappungsdominierte Quellen einen Isolationsgewinn ≥
   `strongIsolationGainDb` (Standard 10 dB), weil absolute SI-SDR bei
   taktgleicher Überlagerung physikalisch gedeckelt ist. Spezifikationsschwellen
   (echtes Modell): **6 dB / 6 dB / 10 dB** (`DEFAULT_THRESHOLDS`,
   umgebungsweise über `AIRODOX_GATE_MIN_SISDR_DB` /
   `AIRODOX_GATE_MIN_GAIN_DB` / `AIRODOX_GATE_STRONG_GAIN_DB` überschreibbar).
   Ein Gate mit `weights: "random"` ist per Konstruktion immer FAIL — das ist
   sein Diskriminierungsbeweis, kein Defekt.

### Checkpoint-Beschaffung

- **Produktionsmodell**: `scripts/setup-bsroformer-model.sh` lädt
  `model_bs_roformer_ep_17_sdr_9.6568.ckpt` (MUSDB18-HQ, ZFTurbo v1.0.12).
  In Umgebungen ohne Zugriff auf GitHub-Release-Assets (z. B. hart
  eingeschränkte Sandbox-Egress-Regeln) schlägt das fehl.
- **EDMSMOKE-Fallback**: `npm run stems:smoke:train` generiert synthetische
  EDM-Stücke (andere Seeds/BPMs als der Eval-Track), trainiert die verkleinerte
  Referenzarchitektur (`tests/fixtures/bsroformer/edmsmoke_bs_roformer.yaml`,
  dim 64 / depth 3 / 4 Stems) per Wellenform-L1 in der Original-Architektur
  (`python/train_smoke_checkpoint.py`, CPU, ~10–30 min) und installiert
  `model_bs_roformer_edmsmoke.ckpt`. Der Gate erkennt es automatisch und
  kennzeichnet jeden Bericht klar als Smoke-Modell auf synthetischer Domäne.

### Gemessene Werte (EDMSMOKE, 1000 Trainingsschritte, CPU, Wellenform-L1 1,50→0,37)

| Stem   | SI-SDR | Baseline | Isolationsgewinn | Zufalls-Gain |
| ------ | ------ | -------- | ---------------- | ------------ |
| vocals | +10,3 dB | −6,2 dB  | **+16,6 dB** | −23,4 dB |
| bass   | +15,4 dB | −0,9 dB  | **+16,3 dB** | −10,9 dB |
| drums  | +15,8 dB | −3,5 dB  | **+19,3 dB** | −23,7 dB |
| other  | −11,5 dB | −23,3 dB | **+11,8 dB** (Alternative-Klausel) | −14,5 dB |

### Was damit belegt ist — und was nicht

Belegt: der komplette trainierte Pfad (Dataset → Training → Checkpoint →
Adapter → `weights: "checkpoint"` → SI-SDR deutlich über Random → Gate-Verdict)
sowie die Diskriminierungsfähigkeit des Gates (Abstand 26–43 dB pro Stem).

**Nicht belegt ist Produktionsqualität.** Der Smoke-Checkpoint ist auf
synthetischem Material trainiert; erst das MUSDB18-HQ-Modell liefert belastbare
SI-SDR-Werte für reale Musik. Offen bleiben außerdem:

1. perzeptive QA (Klicks, Pumpen, Übersprechen, Stereo-Bild, Höhenverlust)
2. ergänzende spektrale Distanzmetriken neben SI-SDR
3. Kalibrierung der Schwellen an realen Checkpoints (der Eval-Track überlappt
   Vocals und Akkorde absichtlich taktgleich — für `other` ist die 6-dB-Schwelle
   auf synthetischem Material nur begrenzt erreichbar)

---

## 15. Offene Punkte / bekannte Grenzen

* Natives C++-Runtime-Binary existiert noch nicht — der Vertrag
  (`audiocpp_cli --task sep …`) ist implementiert und getestet, das Binary fehlt
  in dieser Umgebung (kein `cmake`). Der Python-Pfad ist Entwicklungswerkzeug.
* `modelHash` steht im Katalog auf `"unverified"`, solange die Gewichte nicht
  geladen und geprüft wurden; das Setup-Skript liefert den zu hinterlegenden
  sha256.
* GUI/IPC-Anbindung des bestehenden Editors (`electron/demucsRunner.cjs`,
  `src/audio/stemEngine.ts` mit hart kodierter 4-Stem-Liste und Demucs-Gewichten)
  ist bewusst noch nicht umgestellt — Teil 1 bleibt kernfokussiert.
