// =============================================================================
// StemInferenceWorker.cpp
// -----------------------------------------------------------------------------
// ONNX Runtime session lifecycle: environment, execution-provider fallback
// chain, tensor pre-allocation, and the per-chunk inference call.
// =============================================================================
#include "stem_engine/StemInferenceWorker.h"

#include <array>
#include <cstring>
#include <iostream>

#if defined(_WIN32)
  #include <onnxruntime_providers.h> // DirectML / TensorRT append helpers ship here on Windows builds.
#endif

namespace airdox::stem_engine {

namespace {

// A single process-wide Ort::Env. ONNX Runtime explicitly requires exactly
// one Env per process (constructing more is legal but wasteful and can
// confuse provider-level global state such as CUDA/DirectML device pools).
// Meyer's singleton: thread-safe initialization guaranteed by the C++11+
// static-local rule, and this is only ever touched from non-RT threads
// (worker initialize() calls), so the one-time lock it implies is fine.
Ort::Env& sharedOrtEnv() {
    static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "AirdoxStemEngine");
    return env;
}

const char* toString(HardwareProvider p) noexcept {
    switch (p) {
        case HardwareProvider::TensorRT: return "TensorRT";
        case HardwareProvider::DirectML: return "DirectML";
        case HardwareProvider::CoreML:   return "CoreML";
        case HardwareProvider::CUDA:     return "CUDA";
        case HardwareProvider::CPU:      return "CPU";
    }
    return "Unknown";
}

} // namespace

bool StemInferenceWorker::tryAppendProvider(Ort::SessionOptions& options,
                                             HardwareProvider provider,
                                             std::string& detailOut) {
    try {
        switch (provider) {
            case HardwareProvider::CPU:
                // CPU EP is implicit/default; nothing to append. Still tune
                // intra-op threading so the background workers don't starve
                // the RT audio thread of CPU time on shared cores.
                options.SetIntraOpNumThreads(config_.cpuIntraOpThreads);
                options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
                detailOut = "CPU execution provider (OpenMP-backed kernels)";
                return true;

#if defined(_WIN32)
            case HardwareProvider::DirectML: {
                // DirectML works across all DX12-capable GPUs on Windows,
                // including integrated GPUs and NPUs exposed via DX12, which
                // makes it the most broadly compatible GPU EP for a shipped
                // DJ application (no vendor-specific driver requirement
                // beyond a current DX12 driver).
                Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(options, /*deviceId*/ 0));
                // DML requires sequential execution mode and disables the
                // memory pattern optimizer (both documented ORT requirements
                // for the DML EP as of 1.17+).
                options.DisableMemPattern();
                options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
                detailOut = "DirectML execution provider (device 0)";
                return true;
            }
            case HardwareProvider::TensorRT: {
                OrtTensorRTProviderOptions trtOptions{};
                trtOptions.device_id = 0;
                trtOptions.trt_fp16_enable = (config_.precision != ModelPrecision::FP32) ? 1 : 0;
                trtOptions.trt_engine_cache_enable = 1; // Amortize JIT engine build cost across track loads.
                Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_TensorRT(options, &trtOptions));
                detailOut = "TensorRT execution provider (fp16 cache enabled)";
                return true;
            }
#endif

#if defined(__APPLE__)
            case HardwareProvider::CoreML: {
                // COREML_FLAG_USE_NONE lets CoreML pick the best available
                // compute unit (ANE / GPU / CPU) per-op at graph-compile
                // time, which is preferable to hard-pinning the whole graph
                // to the Neural Engine (some ops silently fall back to CPU
                // if forced onto ANE, which is worse than letting CoreML
                // decide per-subgraph).
                uint32_t coremlFlags = COREML_FLAG_USE_NONE;
                Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_CoreML(options, coremlFlags));
                detailOut = "CoreML execution provider (ANE/GPU auto-select)";
                return true;
            }
#endif

            default:
                detailOut = std::string(toString(provider)) + " not compiled in on this platform";
                return false;
        }
    } catch (const Ort::Exception& ex) {
        detailOut = std::string(toString(provider)) + " unavailable: " + ex.what();
        return false;
    }
}

bool StemInferenceWorker::initialize(const WorkerConfig& config) {
    config_ = config;
    memoryInfo_ = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    Ort::SessionOptions options;
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    // Arena allocators reuse freed blocks instead of returning them to the OS,
    // which is what keeps steady-state inference allocation-free at the OS
    // level even though ORT's internal allocator still "allocates" logically.
    options.EnableCpuMemArena();

    // Walk the caller-provided EP preference list; use the first that
    // succeeds. CPU is always appended as the final guaranteed fallback even
    // if the caller forgot to include it, so `Ort::Session` construction
    // below is always attemptable.
    auto preference = config_.providerPreference;
    if (preference.empty() || preference.back() != HardwareProvider::CPU) {
        preference.push_back(HardwareProvider::CPU);
    }

    bool anyAccelerated = false;
    HardwareProvider chosen = HardwareProvider::CPU;
    std::string detail;
    for (HardwareProvider p : preference) {
        if (tryAppendProvider(options, p, detail)) {
            chosen = p;
            anyAccelerated = (p != HardwareProvider::CPU);
            break;
        }
    }

    providerReport_.requested = preference.front();
    providerReport_.active = chosen;
    providerReport_.fellBackToCpu = !anyAccelerated && preference.front() != HardwareProvider::CPU;
    providerReport_.detail = detail;

    try {
#if defined(_WIN32)
        session_ = std::make_unique<Ort::Session>(sharedOrtEnv(), config_.modelPath.wstring().c_str(), options);
#else
        session_ = std::make_unique<Ort::Session>(sharedOrtEnv(), config_.modelPath.string().c_str(), options);
#endif
    } catch (const Ort::Exception& ex) {
        std::cerr << "[StemInferenceWorker] Failed to load model '" << config_.modelPath
                  << "': " << ex.what() << std::endl;
        session_.reset();
        return false;
    }

    // Cache I/O names once (name lookup does allocate internally in ORT, so
    // we do it exactly once here, never per-chunk).
    Ort::AllocatorWithDefaultOptions allocator;
    const std::size_t numInputs = session_->GetInputCount();
    const std::size_t numOutputs = session_->GetOutputCount();
    inputNames_.reserve(numInputs);
    outputNames_.reserve(numOutputs);
    for (std::size_t i = 0; i < numInputs; ++i) {
        auto name = session_->GetInputNameAllocated(i, allocator);
        inputNames_.emplace_back(name.get());
    }
    for (std::size_t i = 0; i < numOutputs; ++i) {
        auto name = session_->GetOutputNameAllocated(i, allocator);
        outputNames_.emplace_back(name.get());
    }
    inputNamesRaw_.clear();
    outputNamesRaw_.clear();
    for (auto& n : inputNames_) inputNamesRaw_.push_back(n.c_str());
    for (auto& n : outputNames_) outputNamesRaw_.push_back(n.c_str());

    // Model I/O contract: input [1, numChannels, chunkFrames] time-domain
    // planar audio; output [1, kStemCount, numChannels, chunkFrames]. This
    // matches the exported ONNX graphs referenced by the TypeScript
    // ModelRegistry (`stemOrder` drives the stem axis ordering).
    inputShape_  = {1, config_.numChannels, static_cast<int64_t>(config_.chunkFrames)};
    outputShape_ = {1, static_cast<int64_t>(kStemCount), config_.numChannels, static_cast<int64_t>(config_.chunkFrames)};

    pool_.resize(config_.chunkFrames, config_.numChannels);

    return true;
}

bool StemInferenceWorker::infer(const float* interleavedPlanarInput,
                                 std::array<float*, kStemCount>& outStems) noexcept {
    if (!session_) return false;

    // Copy caller data into our pre-allocated scratch buffer. This copy is
    // the only "extra" memory traffic per chunk (unavoidable because the
    // caller's ring-buffer memory must not be handed directly to ORT — ORT
    // may hold the input tensor pointer for the duration of Run(), and the
    // ring buffer's storage is being concurrently written/wrapped by the
    // producer). No heap allocation occurs: `pool_.inputScratch` was sized in
    // `initialize()`.
    std::memcpy(pool_.inputScratch.data(), interleavedPlanarInput,
                pool_.inputScratch.size() * sizeof(float));

    try {
        Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
            memoryInfo_, pool_.inputScratch.data(), pool_.inputScratch.size(),
            inputShape_.data(), inputShape_.size());

        // Single combined output tensor, [1, stems, channels, frames]. Using
        // one call to Run() (rather than one per stem) lets shared upstream
        // computation (e.g. a common STFT/encoder trunk) be evaluated once.
        // `pool_.combinedOutput` was sized once in initialize() — reusing it
        // here (instead of allocating a fresh vector per chunk) is what keeps
        // steady-state infer() calls free of heap traffic beyond whatever
        // ONNX Runtime's own arena allocator does internally.
        auto& combinedOutput = pool_.combinedOutput;
        Ort::Value outputTensor = Ort::Value::CreateTensor<float>(
            memoryInfo_, combinedOutput.data(), combinedOutput.size(),
            outputShape_.data(), outputShape_.size());

        session_->Run(Ort::RunOptions{nullptr},
                       inputNamesRaw_.data(), &inputTensor, 1,
                       outputNamesRaw_.data(), &outputTensor, 1);

        // De-interleave the combined [stem, channel, frame] output into the
        // caller's per-stem planar destination buffers.
        const std::size_t frameStride = config_.chunkFrames;
        const std::size_t channelStride = frameStride;
        const std::size_t stemStride = static_cast<std::size_t>(config_.numChannels) * channelStride;
        for (std::size_t s = 0; s < kStemCount; ++s) {
            float* dst = outStems[s];
            if (dst == nullptr) continue;
            const float* src = combinedOutput.data() + s * stemStride;
            std::memcpy(dst, src, stemStride * sizeof(float));
        }
        return true;
    } catch (const Ort::Exception& ex) {
        // A failed inference call must never crash the audio pipeline. The
        // caller (background worker loop) treats `false` as "keep existing
        // ring-buffer contents / retry next cycle", never as fatal.
        std::cerr << "[StemInferenceWorker] infer() failed: " << ex.what() << std::endl;
        return false;
    }
}

} // namespace airdox::stem_engine
