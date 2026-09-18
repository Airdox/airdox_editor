# StemEngine — Native C++20 / ONNX Runtime Stem Separation Engine

A low-latency, high-quality real-time stem separation engine for the
airdox DJ editor, implementing the **Hybrid Streaming & Background Caching
Model**:

* **Instant Low-Latency Streamer** — a fast/quantised ONNX model fills a
  lock-free ring buffer with the first few seconds of stems around the
  playhead almost immediately after track load.
* **Cached High-Quality Engine** — a full-precision model analyzes the
  entire track in the background, writing into a RAM- or mmap-backed cache.
* **Dynamic Handoff** — an inaudible, equal-power crossfade (10–50 ms)
  automatically hands playback from the instant streamer to the high-quality
  cache once it has caught up to the playhead.

This is a **native reference architecture**, separate from (and intended as
the eventual successor to) the existing Python-process-based separation
backend used by the shipped Electron app (`electron/stemRuntime.cjs`,
`src/stems/backends/roformerSeparator.ts`) — see `docs/BUILD.md` §5 for how
the two connect (same qualified checkpoints, exported to ONNX).

## Contents

```
native/stem_engine/
├── include/stem_engine/
│   ├── StemEngine.h              # Umbrella header — include this one
│   ├── StemTypes.h                # Shared enums/POD config, no ORT dependency
│   ├── AudioRingBuffer.h          # Lock-free SPSC ring buffer(s)
│   ├── OverlapAddProcessor.h      # Hann/Hamming windowing + streaming OLA
│   ├── StemInferenceWorker.h      # ONNX Runtime session wrapper
│   ├── HighQualityStemCache.h     # RAM/mmap-backed full-track stem cache
│   └── StemEngineManager.h        # Top-level orchestrator
├── src/
│   ├── StemInferenceWorker.cpp
│   ├── HighQualityStemCache.cpp
│   └── StemEngineManager.cpp
├── tests/
│   ├── test_ring_buffer_and_ola.cpp     # No ORT dependency; run anywhere
│   ├── test_manager_lifecycle.cpp       # Full orchestrator smoke test (needs a model or the mock)
│   └── mock_ort/onnxruntime_cxx_api.h   # TEST-ONLY stand-in for the real ORT SDK
├── examples/
│   └── JuceIntegrationExample.h         # Reference audio-callback wiring
├── docs/
│   ├── ARCHITECTURE.md            # Data-flow diagram + thread-safety contracts
│   ├── PERFORMANCE.md             # Memory budget, pooling, XRUN avoidance
│   └── BUILD.md                   # SDK acquisition + CMake instructions
└── CMakeLists.txt
```

## Quick start (logic-only reference build, no ONNX SDK needed)

```bash
cmake -S native/stem_engine -B native/stem_engine/build -DSTEM_ENGINE_USE_MOCK_ORT=ON
cmake --build native/stem_engine/build -j
ctest --test-dir native/stem_engine/build --output-on-failure
```

This validates every piece of the concurrency/DSP design (SPSC ring buffer
correctness under real concurrent threads, COLA reconstruction accuracy, and
the full `StemEngineManager` lifecycle — including load/seek/shutdown races —
under ThreadSanitizer) without requiring the (large, platform-specific) real
ONNX Runtime distribution. See `docs/BUILD.md` for the real-SDK build.

## Design documents

Start with **`docs/ARCHITECTURE.md`** for the full data-flow diagram and the
thread-safety contracts that make this design real-time-safe, then
**`docs/PERFORMANCE.md`** for memory budgeting and XRUN-avoidance guidance
before integrating into a shipping build.
