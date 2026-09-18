// =============================================================================
// StemInferenceWorker.h
// -----------------------------------------------------------------------------
// Wraps a single `Ort::Session` (ONNX Runtime) and everything required to run
// it efficiently and repeatedly on background threads:
//   * Execution-provider (EP) selection with graceful hardware fallback.
//   * Pre-allocated input/output tensors + a small memory pool so a full
//     inference pass performs zero heap allocations after warm-up.
//   * A thin, EP-agnostic `infer()` call used by both the Instant and the
//     High-Quality pipelines (they simply load different checkpoints /
//     chunk sizes into two separate `StemInferenceWorker` instances).
//
// This header only declares the class; see StemEngine.cpp for the
// implementation, including the actual `Ort::SessionOptions` provider wiring.
// =============================================================================
#pragma once

#include <atomic>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

#include "StemTypes.h"

namespace airdox::stem_engine {

// Fixed-size scratch memory reused across every `infer()` call. Allocated
// once at `initialize()` time; `TensorMemoryPool` never grows or shrinks
// during playback, which is the property that makes inference "allocation
// free" from the caller's perspective (ONNX Runtime's arena allocator still
// does its own internal bookkeeping, but no cudaMalloc/mmap/new touches the
// hot path once the arena has warmed up).
struct TensorMemoryPool {
    std::vector<float> inputScratch;    // [numChannels * chunkFrames]
    std::vector<float> combinedOutput;  // [kStemCount * numChannels * chunkFrames], model's raw output tensor.
    std::array<std::vector<float>, kStemCount> outputScratch; // Reserved for future post-processing stages.

    void resize(std::size_t chunkFrames, int numChannels) {
        inputScratch.assign(chunkFrames * static_cast<std::size_t>(numChannels), 0.0f);
        combinedOutput.assign(kStemCount * chunkFrames * static_cast<std::size_t>(numChannels), 0.0f);
        for (auto& buf : outputScratch) {
            buf.assign(chunkFrames * static_cast<std::size_t>(numChannels), 0.0f);
        }
    }
};

// Diagnostics captured at session-init time, surfaced to logging/telemetry so
// support can tell at a glance whether a user is actually running on their
// GPU/NPU or silently degraded to CPU.
struct ProviderReport {
    HardwareProvider requested = HardwareProvider::CPU;
    HardwareProvider active    = HardwareProvider::CPU;
    bool fellBackToCpu = false;
    std::string detail;
};

// Configuration needed to construct one worker (one model, one chunk size).
struct WorkerConfig {
    std::filesystem::path modelPath;
    std::size_t chunkFrames   = 4096;
    int numChannels           = 2;
    ModelPrecision precision  = ModelPrecision::FP16;
    // Ordered fallback chain, e.g. {DirectML, CPU} on Windows or
    // {CoreML, CPU} on macOS. The worker tries each in order.
    std::vector<HardwareProvider> providerPreference = {HardwareProvider::CPU};
    int cpuIntraOpThreads = 2; // Kept deliberately small: the RT audio thread
                                // and other workers also need CPU headroom.
};

// -----------------------------------------------------------------------------
// StemInferenceWorker
// -----------------------------------------------------------------------------
// NOT thread-safe for concurrent `infer()` calls on the same instance — each
// `StemInferenceWorker` is owned by exactly one background worker thread
// (see StemEngineManager, which keeps one instance per {Instant, HighQuality}
// role). `Ort::Session::Run` itself uses internal thread pools for intra-op
// parallelism, configured via SessionOptions below.
// -----------------------------------------------------------------------------
class StemInferenceWorker {
public:
    StemInferenceWorker() = default;
    ~StemInferenceWorker() = default;

    StemInferenceWorker(const StemInferenceWorker&) = delete;
    StemInferenceWorker& operator=(const StemInferenceWorker&) = delete;

    // Creates the Ort::Env (shared per-process, see .cpp), builds
    // SessionOptions with the requested EP fallback chain, loads the model,
    // and pre-allocates all scratch tensors. Throws only during setup (never
    // during steady-state playback); callers should run this on a
    // non-realtime thread and catch `Ort::Exception`.
    bool initialize(const WorkerConfig& config);

    // Runs one forward pass over a single chunk of interleaved-planar input
    // audio (`numChannels` contiguous per-channel blocks of `chunkFrames`
    // samples each, i.e. planar layout matching TensorMemoryPool::inputScratch).
    // Results are written into `outStems`, one pointer per stem, each with
    // capacity for `numChannels * chunkFrames` floats. Returns false (and
    // leaves outStems untouched) if the session is not initialized.
    //
    // REAL-TIME SAFETY: this function is intentionally NOT called from the
    // audio I/O callback. It performs a full neural-network forward pass
    // (microseconds to tens of milliseconds depending on hardware) and must
    // only run on a background `StemEngineManager` worker thread.
    bool infer(const float* interleavedPlanarInput,
               std::array<float*, kStemCount>& outStems) noexcept;

    const ProviderReport& providerReport() const noexcept { return providerReport_; }
    const WorkerConfig& config() const noexcept { return config_; }
    bool isReady() const noexcept { return session_ != nullptr; }

private:
    // Attempts to append one execution provider to `options`. Returns true on
    // success. Implemented per-provider in the .cpp with `#ifdef` guards so
    // this same source builds on Windows/macOS/Linux, simply compiling out
    // providers that are not present in the linked ONNX Runtime distribution.
    bool tryAppendProvider(Ort::SessionOptions& options, HardwareProvider provider, std::string& detailOut);

    WorkerConfig config_;
    ProviderReport providerReport_;

    // Ort::Env must outlive every Session created from it. We keep a
    // process-wide shared instance (see StemEngine.cpp `sharedOrtEnv()`) and
    // only own the Session + allocator locally.
    std::unique_ptr<Ort::Session> session_;
    Ort::MemoryInfo memoryInfo_{nullptr};

    std::vector<std::string> inputNames_;
    std::vector<std::string> outputNames_;
    std::vector<const char*> inputNamesRaw_;
    std::vector<const char*> outputNamesRaw_;

    std::vector<int64_t> inputShape_;   // e.g. {1, numChannels, chunkFrames}
    std::vector<int64_t> outputShape_;  // e.g. {1, kStemCount, numChannels, chunkFrames}

    TensorMemoryPool pool_;
};

} // namespace airdox::stem_engine
