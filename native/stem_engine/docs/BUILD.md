# StemEngine — Build Guide

This module is a standalone CMake target (`airdox_stem_engine`) and is not
part of the Electron/Vite build (`npm run build`). It is meant for a future
native host — a JUCE audio engine, a small native Node addon bridging into
the existing Electron app, or a standalone benchmarking tool — that replaces
today's Python-process-based separation backend (`electron/stemRuntime.cjs`,
`src/stems/backends/*`) with in-process, real-time C++/ONNX inference.

## 1. Prerequisites

* CMake ≥ 3.20
* A C++20 compiler (MSVC 19.3x / Xcode 14+ / GCC 11+ / Clang 14+)
* The official ONNX Runtime C/C++ SDK for your platform (see §2) — **not**
  vendored in this repo, and not the same as the `onnxruntime` **Python**
  wheel already used by `python/bsroformer_inference.py` for the existing
  Python-process backend.

## 2. Getting ONNX Runtime

Download the pre-built distribution matching your target OS/EP from the
[ONNX Runtime GitHub Releases](https://github.com/microsoft/onnxruntime/releases)
page, then extract it somewhere stable, e.g. `C:\sdk\onnxruntime` or
`/opt/onnxruntime`.

| Platform | Recommended package |
|---|---|
| Windows (DirectML) | `Microsoft.ML.OnnxRuntime.DirectML` NuGet, or `onnxruntime-win-x64-directml-<ver>.zip` |
| Windows (TensorRT) | `onnxruntime-win-x64-gpu-<ver>.zip` (includes CUDA/TensorRT EPs; requires matching CUDA/TensorRT runtime installed) |
| macOS (CoreML) | `onnxruntime-osx-universal2-<ver>.tgz` (CoreML EP is compiled into the standard macOS package) |
| Linux (CPU reference/dev) | `onnxruntime-linux-x64-<ver>.tgz` |

Then configure with:

```bash
cmake -S native/stem_engine -B native/stem_engine/build \
      -DONNXRUNTIME_ROOT=/opt/onnxruntime \
      -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build native/stem_engine/build -j
```

## 3. Sandboxed / offline reference builds (no ORT SDK available)

For environments without network access to fetch the ONNX Runtime SDK (CI
smoke tests, this development sandbox, etc.), a syntax-compatible mock header
is provided at `tests/mock_ort/onnxruntime_cxx_api.h`. It reproduces the
subset of the ORT C++ API this module uses, with no real inference behind it,
so the concurrency/DSP logic (ring buffers, OLA windowing, worker lifecycle,
crossfade handoff) can still be compiled, run, and checked under
ThreadSanitizer/UBSan:

```bash
cmake -S native/stem_engine -B native/stem_engine/build \
      -DSTEM_ENGINE_USE_MOCK_ORT=ON
cmake --build native/stem_engine/build -j
ctest --test-dir native/stem_engine/build --output-on-failure
```

**A binary built with `STEM_ENGINE_USE_MOCK_ORT=ON` must never ship** — it
performs no real stem separation. This mode exists purely to validate the
architecture's thread-safety and DSP correctness independent of the (large,
platform-specific) real SDK.

## 4. Recommended sanitizer regimen for changes to this module

Any change touching `StemEngineManager`, `AudioRingBuffer`, or
`HighQualityStemCache` should be re-validated with:

```bash
g++ -std=c++20 -O1 -g -fsanitize=thread -pthread \
    -I include -I tests/mock_ort \
    src/StemInferenceWorker.cpp src/HighQualityStemCache.cpp src/StemEngineManager.cpp \
    tests/test_manager_lifecycle.cpp -o /tmp/tsan_test && /tmp/tsan_test
```

Zero `WARNING: ThreadSanitizer` lines is the bar — this reference
implementation was hardened against exactly one real race caught this way
(a naive `seek()` mutating instant-worker-owned state from a control thread;
see `docs/ARCHITECTURE.md` §3.2 and the fix in `StemEngineManager::seek()`).

## 5. Exporting ONNX models

This engine expects two ONNX graphs per deployment:

1. **Instant model** — INT8 or FP16 quantised, small chunk size (e.g. 4096
   samples), optimized for latency over absolute fidelity.
2. **HQ model** — FP32 (or the checkpoint's native precision), larger chunk
   size (e.g. 16384 samples), optimized for fidelity.

Both must export with:

* Input: `[1, numChannels, chunkFrames]` float32, time-domain planar audio.
* Output: `[1, 4, numChannels, chunkFrames]` float32, stem axis ordered
  `[drums, bass, vocal, other]` to match `StemId` in `StemTypes.h`. If your
  checkpoint's native stem order differs, either re-export with a permute
  node or add an explicit remap layer in `StemInferenceWorker::infer()` —
  do not silently rely on positional luck (this mirrors the strict
  `stemOrder` contract already enforced by the existing TypeScript
  `ModelRegistry`, see `docs/STEM_SEPARATION_ENGINE.md` §4 in the repo root).

Refer to `docs/STEM_SEPARATION_ENGINE.md` for the checkpoints already
qualified for this project (BS-RoFormer HQ, HTDemucs preview) — exporting
those to ONNX (e.g. via `torch.onnx.export` from the reference PyTorch
implementations already vendored under `python/`) is the natural first
integration target for this native engine.
