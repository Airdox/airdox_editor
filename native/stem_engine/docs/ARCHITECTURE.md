# StemEngine — Architecture & Data Flow

This document describes the native C++20 / ONNX Runtime **StemEngine**: a
low-latency, high-quality real-time stem separation subsystem designed to sit
underneath a DJ application's audio graph (JUCE `AudioIODeviceCallback`,
`AudioProcessor`, or an equivalent RtAudio/PortAudio callback).

It implements the **Hybrid Streaming & Background Caching Model**: an
"Instant Low-Latency Stem Engine" gives the DJ audible stems within roughly
one buffer's worth of latency after loading a track, while a "Cached
High-Quality Stem Engine" analyzes the full track in the background and takes
over — via an inaudible equal-power crossfade — once its cache reaches the
region the playhead is about to enter.

---

## 1. Component Overview

| Component | File | Thread ownership |
|---|---|---|
| `AudioRingBuffer` / `StemPlanarRingBuffer` | `AudioRingBuffer.h` | 1 producer (instant worker), 1 consumer (audio thread) per buffer |
| `OverlapAddProcessor` / `WindowTable` | `OverlapAddProcessor.h` | Owned by whichever worker thread uses it (never shared) |
| `StemInferenceWorker` | `StemInferenceWorker.h/.cpp` | Called only from its owning background worker thread |
| `HighQualityStemCache` / `CoverageMap` | `HighQualityStemCache.h/.cpp` | 1 writer (background worker), many readers (audio thread + prefetch) |
| `StemEngineManager` | `StemEngineManager.h/.cpp` | Orchestrator; owns both worker threads; exposes an RT-safe facade |

---

## 2. Data-Flow / Block Diagram

```
                                   ┌───────────────────────────────────────────┐
                                   │              StemEngineManager             │
                                   │        (owns lifecycle of everything)      │
                                   └───────────────────────────────────────────┘
                                                       │
              ┌────────────────────────────────────────┼─────────────────────────────────────────┐
              │ loadTrack()                             │ syncPlayhead() / renderNextBlock()        │
              ▼                                         ▼                                          │
┌───────────────────────────────────┐    ┌─────────────────────────────────────────────────────┐  │
│   Background Worker Thread A       │    │              AUDIO I/O CALLBACK THREAD               │  │
│   "Instant Low-Latency Streamer"   │    │       (real-time priority — 0 alloc, 0 locks)        │  │
│   State 1                          │    │                                                       │  │
│                                     │    │  1. syncPlayhead(transportFrame)                     │  │
│  loop:                             │    │  2. for each requested StemId:                       │  │
│   ┌─ pull raw PCM chunk @ cursor   │    │       renderNextBlock(stem, outPlanar, ...)          │  │
│   │  (instantChunkFrames, e.g.     │    │        │                                              │  │
│   │   ~93 ms @ 44.1kHz)            │    │        ├─ InstantStreamer  → read() AudioRingBuffer   │  │
│   ├─ StemInferenceWorker::infer()  │    │        ├─ Crossfading      → read() BOTH + equal-power │  │
│   │  (INT8/FP16 quantised model,   │    │        │                     blend over 10–50ms        │  │
│   │   CPU/GPU/NPU via ORT EP)      │    │        └─ HighQualityCache → readBlock() mmap/RAM cache│  │
│   ├─ Hann window (applyWindow)     │    │  3. underrun ⇒ fill silence, bump xrunCount (never     │  │
│   ├─ OLA accumulate+emit (hop)     │◄───┼──── AudioRingBuffer::read()   block / never garbage)   │  │
│   └─ AudioRingBuffer::write(hop)   │    │                                                       │  │
│        (SPSC, lock-free)           │    └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────┘                                                              │
              ▲                                                                                     │
              │ instantWriteCursor_ (atomic, worker-owned)                                          │
              │ pendingSeekFrame_/seekRequested_ (atomic handshake, control-thread → worker)         │
              │                                                                                     │
┌───────────────────────────────────┐                                                              │
│   Background Worker Thread B       │    ┌─────────────────────────────────────────────────────┐  │
│   "High-Quality Full-Track Pass"   │    │            HighQualityStemCache                      │  │
│   State 2                          │    │   (RAM planes OR mmap-backed scratch file)           │  │
│                                     │    │                                                       │  │
│  loop (cursor = 0 .. trackEnd):    │    │  Layout: [stem][channel][frame] contiguous planes    │  │
│   ┌─ pull raw PCM chunk @ cursor   ├───►│  writeBlock() marks CoverageMap bits (release)        │◄─┘
│   │  (hqChunkFrames, e.g. ~372 ms) │    │  readBlock() checks CoverageMap bits (acquire) THEN   │
│   ├─ StemInferenceWorker::infer()  │    │  copies — refuses partially-covered ranges rather     │
│   │  (FP32/native model, best      │    │  than returning stale/garbage samples.               │
│   │   available EP)                │    └─────────────────────────────────────────────────────┘
│   ├─ Hann window (applyWindow)     │
│   ├─ OLA accumulate+emit (hop)     │              StemEngineManager::updateHandoffState()
│   └─ HighQualityStemCache::write   │              polls hqCache_->isRangeReady(playhead, lookahead)
│        Block() (per stem/channel)  │              each audio block; starts a crossfade the
└───────────────────────────────────┘              instant the HQ cache covers the upcoming window.
```

### State machine (per loaded track)

```
        loadTrack()
   Idle ───────────────► InstantBuffering ─────► BackgroundAnalyzing ─────► CacheReady
                          (State 1: ring buffer   (State 2: full-track HQ    (State 3 continues:
                           filling around          pass running               dynamic handoff keeps
                           playhead)                concurrently)             happening block-by-block
                                                                               as playback moves through
                                                                               newly-covered regions)
```

`CacheReady` does not mean "always playing from cache" — it means the
background pass has *finished*. The actual audible source
(`ActiveSource::InstantStreamer` / `Crossfading` / `HighQualityCache`) is
decided per-block by `updateHandoffState()`, purely from `CoverageMap`
lookahead, and can revert to `InstantStreamer` if a seek jumps the playhead
outside covered territory (see `renderNextBlock`'s HQ-read-failure fallback).

---

## 3. Thread-Safety Contracts (the load-bearing part of this design)

1. **Single-writer ring buffers.** Each `AudioRingBuffer` has exactly one
   producer (`instantWorkerLoop`) and one consumer (the audio callback via
   `renderNextBlock`). No other code path ever calls `write()` or `read()` on
   the same instance. This is what allows the implementation to use only
   `std::atomic<std::size_t>` cursors with acquire/release ordering instead of
   a mutex — see the extensive comments in `AudioRingBuffer.h`.

2. **Single-writer OLA/coverage state.** `instantOla_[stem]` is only ever
   touched by `instantWorkerLoop`; `hqOla_[stem]` only by
   `backgroundWorkerLoop`. `seek()` does **not** reach into these structures
   directly — it publishes a request (`pendingSeekFrame_`/`seekRequested_`)
   that `instantWorkerLoop` consumes on its own thread. This exact race (a
   naive `seek()` resetting the worker's buffers directly) was caught by
   ThreadSanitizer during development of this reference implementation; the
   request/consume handshake is the fix. See `tests/test_manager_lifecycle.cpp`.

3. **RT-safe read path.** `renderNextBlock` only performs: atomic loads,
   fixed-size stack buffers (`kMaxBlockFrames`), `AudioRingBuffer::read()`
   (bounded memcpy), and `HighQualityStemCache::readBlock()` (bounded memcpy
   against already-mapped memory). No `new`, no `malloc`, no mutex, no
   exception can be thrown from this path, and no call can block for an
   unbounded time.

4. **Generation counter for track switches.** `generation_` is bumped on
   every `loadTrack()`/`shutdown()`. Both worker loops check it every
   iteration and exit promptly if stale, preventing a slow-to-stop background
   pass for track N from writing into buffers already reassigned to track
   N+1.

---

## 4. Why Overlap-Add instead of naive chunk concatenation

Neural stem-separation models are evaluated on fixed windows. Two adjacent,
independently-inferred windows are **not guaranteed to agree in phase or
amplitude at their shared boundary** — concatenating them naively produces an
audible click/discontinuity every `chunkFrames` samples. `OverlapAddProcessor`
fixes this with the standard OLA construction:

1. Each chunk is tapered with a periodic Hann window before being summed
   (`applyWindow`).
2. Overlapping, tapered chunks are summed into a rolling accumulator
   (`accumulateAndEmit`), together with a rolling sum of the window itself.
3. Once no future chunk can still contribute to a given sample (i.e. it has
   fallen `hopFrames` behind the newest chunk's start), it is normalized by
   the accumulated window weight and emitted.

At 50% overlap, a periodic Hann window is exactly constant-overlap-add
(COLA): its per-hop sum equals `1.0` in steady state, so normalization is a
no-op except during the ramp-up/-down at the very start/end of a track. This
is verified by `tests/test_ring_buffer_and_ola.cpp::testOverlapAddReconstructsConstantSignal`.

---

## 5. Execution-Provider Fallback Chain

`StemInferenceWorker::initialize()` walks a caller-supplied ordered list of
`HardwareProvider`s (e.g. `{TensorRT, DirectML, CPU}` on Windows,
`{CoreML, CPU}` on macOS) and appends the first one that successfully
registers with `Ort::SessionOptions`. If a provider's native library, driver,
or hardware is missing, `Ort::Exception` is caught and the next provider in
the chain is tried — CPU is always appended as a guaranteed last resort. The
resulting `ProviderReport` (requested vs. active vs. `fellBackToCpu`) is
surfaced via `StemEngineManager::statusSnapshot()` for UI/telemetry, so
support can immediately tell whether a user's GPU/NPU acceleration is
actually engaged.
