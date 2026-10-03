# Abschlussbericht – Stem-Workflow-Audit: die „2–3-Minuten-Bremse" in der Arbeitskopie

**Datum:** 2026-09-19
**Eingang (Benutzer):** „Irgendwas stimmt hier generell nicht – nur alleine das Vorbereiten
der Arbeitskopie dauert min. 2–3 Minuten. Schau dir den ganzen Workflow wirklich von Anfang
bis Ende an und schau, ob da irgendwelche Bremsen zwischen sind."
**Umfang:** Kompletter Workflow-Audit (Renderer → IPC → Staging → Arbeitskopie → Inferenz →
Rekonstruktion → Validierung → Stem-Import) + Entfernung der gemessenen Bremsen + Verträge
als Tests.

---

## 1. Der Workflow (was bei „Stems jetzt trennen" läuft)

```
Renderer (UI-Thread)
  1. AudioBuffer liegt im AudioContext-Tempo vor (Windows-Gerätetempo: i. d. R. 48 kHz)
  2. encodeStereoFloatWav()  – kompletter Mix als float32-WAV im Renderer
  3. IPC `stems:job-start`   – ~139 MB Byte-Stream (6-min-Track)
Main-Prozess (Electron, derselbe Event-Loop wie IPC/UI-Events)
  4. stageBytes()            – Staging/<name>.wav (ursprünglich: 2× Vollkopie + Write)
  5. prepareWorkingCopy()    – „Arbeitskopie …" (die vom Nutzer bemängelte Phase):
       a. fingerprintOriginal   – sha256 des Originals (read-only-Vertrag)
       b. decodeAudioFile       – WAV-Read (48 kHz float32 → Fast Path)
       c. resample 48k → 44.1k  – KÄISER-WINDOWED SINC, kompletter Track
       d. analyzeAudio + encodeWavFloat32 + writeFile (127 MB)
       e. Roundtrip-Verifikation (byte-exakte Arbeitskopie)
  6. Cache-Check → Chunk-Plan (7.8-s-Segmente, 50 % Outer-Overlap bei HIGH)
  7. ONNX-Inferenz (in-process, 2× Modellsekunden durch das Overlap)
  8. Overlap-Add-Rekonstruktion + 4× Stem-WAV schreiben
  9. fast_dj-Validierung (4× lesen + sha256, Geometrie/Finite/Peak)
 10. verifyOriginalIntegrity (sha256 des Originals erneut)
Renderer
 11. 4× `stems:job-stem` (je 127 MB IPC) + decodeAudioData je Stem
```

## 2. Diagnose – die Bremsen, gemessen

Messsystem: flottes Linux-Dev-System (Node 22). 6-Minuten-Track, 48 kHz → 44.1 kHz, Stereo.
Auf dem Windows-Laptop des Nutzers correspondiert Messung 2.1 mit den gemeldeten
2–3 Minuten.

| # | Bremse | Wo | Wirkung (gemessen) |
|---|--------|----|--------------------|
| 2.1 | **Resampler re-rechnete pro Frame/Tap eine Bessel-Reihe** (`besselI0`, bis 25 Iterationen mit `** 2`), plus `Math.sin` pro Tap, plus **ein `weights`-Array pro Frame** (16 Mio. kleine Arrays bei 6 min) – und der gesamte Loop lief **synchron im Main-Prozess**: kein IPC, keine Fortschritts-Events, UI eingefroren | `src/stems/wavIo.ts` (`resample`) | **60,61 s** hier → mehrere Minuten auf dem Laptop. *Das* war die „Arbeitskopie 2–3 Min". |
| 2.2 | Statische Phase-Text: während 2.1 lief, zeigte die UI „Arbeitskopie für Profil X vorbereiten…" ohne Bewegung; Abbruch griff erst **nach** der Prep | `stemSeparationEngine.separate()` erstellte den Job **nach** `prepareWorkingCopy` | Wahrnehmung „hängt"; Cancel wirklos für die ganze 2–3-Min-Phase |
| 2.3 | `encodeStereoFloatWav` (Renderer) legte **pro Frame ein `[left,right]`-Array** an (17 Mio. Allokationen, GC-Druck) | `src/audio/stemEngine.ts` | 0,27 s → 0,19 s + GC-Spitzen weg (6 min/48 kHz) |
| 2.4 | `encodeWavFloat32` schrieb **per-Sample** mit `DataView.setFloat32` + `isFinite` (31,7 Mio. Sets) – pro Arbeitskopie **und** 4× pro Stem-Export | `src/stems/wavIo.ts` | 0,21 s → 0,09 s (2,2×), Ausgabe **byte-identisch** |
| 2.5 | `sha256Bytes` kopierte den kompletten Buffer (`buffer.slice`) vor jedem Hash; Roundtrip-Check las die 127-MB-Datei zusätzlich komplett in den Heap | `src/stems/wavIo.ts`, `preprocessor.ts` | 0,19 s → 0,10 s pro Hash; zwei Vollkopien + Heap-Spitze weg |
| 2.6 | `stageBytes` rief `toBuffer(bytes)` **zweimal** (Write + Debug-Log) → zwei 139-MB-Vollkopien | `src/stems/stemJobService.ts` | eine Vollkopie weg |
| 2.7 | `job.json` führte `prepareMs`/`validateMs` nie – die langsamen Phasen waren nach dem Lauf nicht nachvollziehbar | `stemSeparationEngine.ts` | Timings werden jetzt gefühlt |

### Was **nicht** geändert wurde (bewusst, mit Begründung)

* **50 % Outer-Overlap (HIGH/HIGH_QUALITY)** = 2× Inferenz-Arbeit. Das ist die
  bewusste Qualitätseinstellung (spiegelt das Demucs-Chunking; `DEFAULT_CHUNK_OVERLAP`).
  Über die Profiltabelle verstellbar – keine „Bremse", sondern Setting.
* **fast_dj-Validierung** (4× 127 MB lesen + Hash) und **Original-Integrity**
  (sha256 vor/nach): Kernverträge aus §17/§14 – bleiben.
* **Stem-Import 4× 127 MB sequenziell über IPC** (Phase 11): Speicherbewusst gebaut
  (nicht 4 Buffers gleichzeitig); dauert Sekunden, nicht Minuten.
* **ONNX-Inferenz im Main-Prozess**: bleibt der größte verbleibende Block (ehrliche
  Modellzeit; 2× durch Overlap; auf DirectML/CUDA deutlich schneller). Eine
  Worker-Thread-Migration des Engine-Kerns wäre der nächste Architekturschritt –
  eigener Arbeitsauftrag, weil sie den IPC-/Transport-Vertrag (Events, Bytes) berührt.

## 3. Änderungen

### 3.1 Neuer Resampler (`src/stems/wavIo.ts`)

* **Exakte Koeffizienten-Tabelle statt Bessel-Reihe pro Frame/Tap.** Mit der
  gekürzten Verhältniszahl `fromRate = p·g`, `toRate = q·g` liegt die
  Tap-Position `x = (i−n·p/q)/max(1,p/q)` exakt auf dem Gitter
  `x = (i·q − n·p)/D` (`D = max(p,q)`, ganzzahlig, weit unter 2^53). Der ganze
  Koeffizient `cutoff·sinc(π·cutoff·x)·kaiser(x/halfTaps)` hängt nur noch von
  `m = i·q − n·p` ab → einmal pro Lauf vorge-rechnet (Tabelle ~11 k Einträge),
  pro Frame bleibt ein reines Multiply-Accumulate über Floats (kein sin, keine
  Bessel-Reihe, keine Allokation).
* **async mit Yield-Raster** (`yieldEveryFrames`, Default-Nutzung: 100 000
  Output-Frames): der Main-Prozess bleibt während des Resamplings frei –
  IPC, Fortschritts-Events und UI laufen weiter.
* **`onProgress` (0..1)** und **`isCancelled`** (wirft `ResampleCancelledError`).
* Werteabweichung zum Referenz-Algorithmus: **max 1,04e-7** (1 float32-ULP) –
  das Ganzzahlen-Gitter entfernt die `n·ratio`-Double-Schwankung (~1e-13).

### 3.2 Sichtbare, abbrechbare Arbeitskopie (`preprocessor.ts`, `stemSeparationEngine.ts`)

* `prepareWorkingCopy` meldet Phasen `fingerprint → decode → resample → encode →
  verify` (je mit Fraction); die Engine mappt das auf **0–2 % des Job-Fortschritts**
  mit lesbaren Texten („Arbeitskopie: Resampling auf 44100 Hz … 37 %").
* Der Job existiert jetzt **vor** der Prep → Fortschritt *und* Cancel wirken schon
  in der Arbeitskopie (früher: erst nach ihr). Abbruch liefert
  `INFERENCE_CANCELLED` (kein FAILED, keine halbe Arbeitskopie als Ergebnis).
* Roundtrip-Verifikation per **Stream-Hash** (`sha256File`) statt Heap-Re-Read.
* `job.timings.prepareMs` / `validateMs` werden geführt → `job.json`.

### 3.3 Kopie- und Encode-Bremsen

* `encodeWavFloat32`: Fast Path über `Float32Array.set` (ein Copy statt Millionen
  DataView-Sets); Legacy-Loop bleibt als Fallback (u. a. Kurz-Buffer: NaN→0-Semantik
  unverändert). **Byte-identisch** (im Test verifiziert).
* `sha256Bytes`: Zero-View über den exakten Bytebereich (Subarrays bleiben korrekt).
* `stageBytes`: ein einziger `toBuffer`-Aufruf.
* Renderer `encodeStereoFloatWav`: explizites L/R statt `[left,right]`-Array pro Frame.

## 4. Nachweis

**Messung (6-Minuten-Track, 48 kHz → 44.1 kHz, Stereo, Dev-System):**

| Schritt | Vorher | Nachher |
|---|---|---|
| Resampling (6 min, 48 kHz) | **60,61 s** | **2,56 s** (23,7×) |
| Resampling (1 min, 44,1→48 kHz) | ~10 s | 0,52 s |
| `prepareWorkingCopy` gesamt (6 min) | Minuten (UI eingefroren) | **4,37 s** (alle Phasen gemeldet) |
| `encodeWavFloat32` (6 min, 44,1 kHz) | 0,21 s | 0,09 s (byte-identisch) |
| Renderer-WAV-Encode (6 min, 48 kHz) | 0,27 s (17 Mio. Arrays) | 0,19 s (keine Allokation/Frame) |
| sha256 (139 MB) | 0,19 s + Vollkopie | 0,10 s, Zero-View |

**Tests:** `tests/stem-separation-working-copy-speed.test.ts` (neu, 6 Verträge:
Werte/Geometrie Down- + Upsampling + Mono + Same-Rate, Fortschritt monoton bis 1,
`ResampleCancelledError`, Phasen-Reihenfolge + Resampling-Fortschritt der
`prepareWorkingCopy`, Abbruch während Resampling → `INFERENCE_CANCELLED`,
Encode-Fast-Path byte-identisch + Null-Short-Fill, `sha256Bytes` Subarray-View).

* Komplette Suite: **61/61 bestanden**, 5 SKIP (Umgebung: kein torch/demucs/onnxruntime
  im Sandbox), `tsc --noEmit` sauber.

## 5. So prüft man es auf dem Windows-Rechner

1. 48-kHz-Track trennen (viele Windows-Audio-Geräte liefern 48 kHz an den
   AudioContext – genau der Pfad, der früher 2–3 Min kostete).
2. Die UI zeigt jetzt **lebendige Phasen** statt eines eingefrorenen Labels:
   „Arbeitskopie: Original wird geprüft (read-only)…" → „Arbeitskopie wird
   dekodiert…" → „Arbeitskopie: Resampling auf 44100 Hz … n %" → …
   Abbruch-Button wirkt auch während der Prep.
3. Nach dem Lauf steht in `job.json` → `timing` die Aufschlüsselung
   (`prepareMs`, `inferenceMs`, `reconstructMs`, `validateMs`) – die verbleibende
   Dauer ist dann ehrliche Inferenzzeit (profilabhängig; 50 % Overlap bei HIGH).
