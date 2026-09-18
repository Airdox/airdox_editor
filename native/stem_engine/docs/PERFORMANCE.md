# StemEngine — Performance & Memory Guidelines

## 1. Memory Budget

Per loaded track, steady-state RAM usage breaks down as follows (stereo,
44.1 kHz, 4 stems, float32 throughout):

| Structure | Formula | Example (4 min track) |
|---|---|---|
| Source PCM (`sourcePcm_`) | `numFrames * numChannels * 4 bytes` | 4 min ⇒ ~10.5M frames × 2ch × 4B ≈ **84 MB** |
| Instant ring buffers | `ringBufferCapacityFrames * numChannels * kStemCount * 4 bytes` | 131072 × 2 × 4 × 4B ≈ **4.2 MB** (constant, independent of track length) |
| HQ cache (RAM mode) | `numFrames * numChannels * kStemCount * 4 bytes` | ~10.5M × 2 × 4 × 4B ≈ **336 MB** |
| HQ cache (mmap mode) | same bytes, but resident-set is OS-managed (pages evicted under memory pressure) | Resident set stays well below 336 MB in practice |
| OLA accumulators (×2 engines ×4 stems) | `chunkFrames * 4 bytes` each, negligible | < 1 MB total |
| ONNX Runtime arena (per session) | Model + intermediate-tensor dependent; typically 50–300 MB per session for a BS-RoFormer/HTDemucs-class checkpoint | Two sessions (instant + HQ) ⇒ budget ~600 MB worst case |

**Rule of thumb:** budget ~450 MB + (1.4× track duration in minutes × 21 MB)
of resident RAM for one fully-loaded track with both engines warm. A DJ app
that keeps 2 decks loaded should therefore budget roughly 1–1.5 GB for the
StemEngine subsystem alone on top of its own audio buffers and UI.

### When to switch the HQ cache to mmap mode

`StemEngineManager::loadTrack()` already does this automatically past a
20-minute threshold (`preferMemoryMapped = numFrames > sampleRate * 60 * 20`),
but the same trade-off applies any time you are running multiple decks
concurrently on constrained hardware:

* **RAM mode** — lowest read latency (no page-fault possibility on first
  touch after `writeBlock` fills it), but resident set scales linearly with
  track length × stem count.
* **mmap mode** — resident set is bounded by the OS page cache's willingness
  to keep pages hot; long/rarely-revisited regions can be evicted and
  transparently re-read from disk. The very first read of an evicted page
  incurs a page fault (a few dozen microseconds to low milliseconds on NVMe,
  worse on spinning disks) — acceptable for a cache read invoked from
  `renderNextBlock`'s crossfade path (which runs at block-rate, not
  sample-rate), but you should still prefer RAM mode for any track short
  enough to comfortably fit, to eliminate that possibility entirely.

## 2. Memory Pooling — the actual "zero allocation" claim, precisely stated

"Zero allocation during runtime" refers specifically to the **audio I/O
callback thread** (`StemEngineManager::renderNextBlock`) and to
**steady-state inference** (`StemInferenceWorker::infer`), not to the
background worker threads' one-time setup:

* `TensorMemoryPool` (`StemInferenceWorker.h`) is sized once in `initialize()`
  (`pool_.resize(...)`) and never resized again. Every `infer()` call reuses
  both `pool_.inputScratch` (via `std::memcpy` in) and `pool_.combinedOutput`
  (bound directly to the output `Ort::Value`, then de-interleaved out) — no
  heap allocation occurs inside the per-chunk `infer()` call path.
* `AudioRingBuffer`'s backing `std::vector<float>` is allocated once at
  construction (`StemEngineManager`'s constructor, itself called from
  `loadTrack()`/app-startup, never from the audio thread).
* `HighQualityStemCache`'s RAM planes or mmap region are allocated once in its
  constructor (`loadTrack()` time), not per block.
* `OverlapAddProcessor`'s accumulators are sized once at construction; `reset()`
  only fills existing memory with zero, it never reallocates.
* `renderNextBlock`'s only "dynamic-looking" storage is `float hqScratch[kMaxBlockFrames]`
  — a fixed-size **stack** array, not a heap allocation, bounded by a compile-time
  constant (8192 frames) that comfortably covers any realistic host block size.

**Actionable guidance for integrators:** if you introduce new per-chunk state
(e.g. a new post-processing stage), always pre-size it in `initialize()`/the
constructor and mutate it in place in the hot path. Run new code through
Valgrind's `--tool=massif` or a custom `operator new` interceptor in CI to
catch accidental hot-path allocations before they reach production — a single
missed `std::vector` resize inside a per-chunk loop is enough to reintroduce a
latent XRUN source under memory pressure.

## 3. Preventing Audio Dropouts (XRUNs) When GPU Processing Spikes

The whole point of the Hybrid Streaming & Background Caching Model is that
**inference never runs on the audio thread**, so a GPU/driver stall cannot by
itself cause a classic XRUN (missed audio-thread deadline). Instead, a stall
manifests as the *ring buffer running dry*, which this design treats as a
recoverable, bounded degradation rather than a fatal error:

1. **Back-pressure, not blocking, on the producer side.** `instantWorkerLoop`
   checks `availableToWrite() >= hop` before running inference and sleeps
   briefly if the ring is full — it never blocks the *consumer*.
2. **Bounded, silent degradation on the consumer side.** `renderNextBlock`'s
   `AudioRingBuffer::read()` returns a short count on underrun; the remainder
   of the output buffer is explicitly zero-filled and `xrunCount_` is
   incremented. The audio graph keeps running — you get a brief gap in one
   stem, not a crashed callback, not a corrupted shared buffer, and not stale
   memory.
3. **Chunk size vs. buffer depth trade-off.** `instantChunkFrames` (default
   4096 @ 44.1 kHz ≈ 93 ms) and `ringBufferCapacityFrames` (default 131072
   frames ≈ 3 s) together define how much of a GPU stall the instant path can
   absorb before an underrun becomes audible: the worker is normally running
   comfortably ahead of the playhead, so a single slow inference call (e.g. a
   50 ms GPU hiccup) is invisible — it just eats into banked-ahead buffer
   rather than starving the very next block.
4. **Keep EP intra-op threads modest.** `WorkerConfig::cpuIntraOpThreads`
   defaults to 2 specifically so CPU-EP inference does not compete with the
   audio thread (or the *other* worker's inference) for every core — over-
   subscribing CPU threads is one of the most common self-inflicted XRUN
   causes when adding ML inference to an existing real-time audio app.
5. **Avoid `DisableMemPattern`/sequential-execution surprises silently.** Some
   EPs (DirectML) *require* `DisableMemPattern()` + `ORT_SEQUENTIAL` — using
   the wrong execution mode with these EPs is a documented source of
   inconsistent/occasionally much slower inference, which increases the odds
   of the instant worker falling behind. `tryAppendProvider()` sets these
   automatically for DirectML so integrators don't have to remember it.
6. **Monitor `xrunCount_` in production.** `EngineStatusSnapshot::xrunCount`
   is designed to be polled by a lightweight UI timer (not the audio thread)
   and logged/telemetered; a rising rate under real-world load is the
   earliest signal that `instantChunkFrames`/`ringBufferCapacityFrames` need
   retuning for a given hardware tier, well before a user notices audible
   gaps.

## 4. Benchmarking Checklist Before Shipping a New Model/EP Combination

- [ ] Measure `StemInferenceWorker::infer()` wall-clock time (not including
      the input memcpy) across 100+ chunks; the 95th-percentile time must be
      well under `hopFrames / sampleRateHz` seconds for the *instant* worker
      to keep up with real-time playback without growing latency.
- [ ] Confirm `ProviderReport::fellBackToCpu` is false on target hardware —
      a silent CPU fallback is the most common cause of "it worked in the
      demo but stutters on the user's laptop."
  - [ ] Run the full lifecycle test (`tests/test_manager_lifecycle.cpp`) under
      ThreadSanitizer after any change to `StemEngineManager` — the seek/
      generation/ring-buffer contracts are easy to accidentally violate when
      adding new shared state.
- [ ] Confirm RSS stays within the budget in §1 across a >20 minute track
      (mmap threshold) and a <1 minute track (RAM mode) to validate both
      cache backends.
