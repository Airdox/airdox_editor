// =============================================================================
// StemTypes.h
// -----------------------------------------------------------------------------
// Shared, allocation-free value types used across the StemEngine subsystem.
// This header has NO dependency on ONNX Runtime or JUCE so it can be included
// from the real-time audio callback translation unit without pulling in heavy
// third-party headers.
// =============================================================================
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace airdox::stem_engine {

// -----------------------------------------------------------------------------
// The four stems produced by the model pipeline. Order MUST match the output
// tensor layout of the loaded ONNX graph (see ModelDescriptor::stemOrder in
// the TypeScript ModelRegistry — this native engine mirrors that contract).
// -----------------------------------------------------------------------------
enum class StemId : uint8_t {
    Drums = 0,
    Bass  = 1,
    Vocal = 2,
    Other = 3,
    Count = 4
};

inline constexpr std::size_t kStemCount = static_cast<std::size_t>(StemId::Count);

inline constexpr std::string_view stemName(StemId id) noexcept {
    switch (id) {
        case StemId::Drums: return "drums";
        case StemId::Bass:  return "bass";
        case StemId::Vocal: return "vocal";
        case StemId::Other: return "other";
        default:            return "unknown";
    }
}

// -----------------------------------------------------------------------------
// Hardware execution providers, ordered by preference. The worker walks this
// list top to bottom at session-creation time and silently falls back to the
// next entry if `Ort::Session` construction throws (missing driver, missing
// DLL/dylib, unsupported GPU, etc.). CPU is always last and always succeeds.
// -----------------------------------------------------------------------------
enum class HardwareProvider : uint8_t {
    TensorRT,
    DirectML,
    CoreML,
    CUDA,
    CPU
};

// -----------------------------------------------------------------------------
// Numeric precision of the loaded checkpoint. INT8/FP16 models trade a small
// amount of separation quality for 2-4x lower inference latency, which is
// what makes "State 1" (first 5s instant buffer) feasible in real time.
// -----------------------------------------------------------------------------
enum class ModelPrecision : uint8_t { FP32, FP16, INT8 };

// -----------------------------------------------------------------------------
// Which of the two internal engines actually produced the audio the listener
// currently hears. Exposed for UI/telemetry (e.g. a small on-screen "HQ" LED).
// -----------------------------------------------------------------------------
enum class ActiveSource : uint8_t { InstantStreamer, HighQualityCache, Crossfading };

// -----------------------------------------------------------------------------
// Coarse lifecycle state of the hybrid pipeline for a single loaded track.
// Mirrors the three "States" from the spec (instant buffer, background pass,
// dynamic handoff) plus explicit idle/error states for robustness.
// -----------------------------------------------------------------------------
enum class EngineState : uint8_t {
    Idle,                 // No track loaded.
    InstantBuffering,     // State 1: filling the first N seconds chunk-by-chunk.
    BackgroundAnalyzing,  // State 2: full-track HQ pass running concurrently.
    CacheReady,           // Full-track HQ cache complete; handoff can occur any time.
    Error
};

// -----------------------------------------------------------------------------
// Describes one fixed-size PCM chunk to be processed by the inference worker.
// Plain-old-data, safe to pass across the SPSC ring buffer by value.
// -----------------------------------------------------------------------------
struct ChunkDescriptor {
    std::size_t startFrame   = 0;   // First sample frame (per channel) in the track.
    std::size_t numFrames    = 0;   // Frame count of this chunk (pre-overlap).
    std::size_t hopFrames    = 0;   // Advance between successive chunk starts (OLA hop).
    double      sampleRateHz = 44100.0;
    uint64_t    sequence     = 0;   // Monotonic id, used to detect stale/duplicate work.
};

// -----------------------------------------------------------------------------
// Fixed engine-wide tunables. Deliberately `constexpr`/POD so they can live in
// read-only memory and be referenced from the RT thread without indirection.
// -----------------------------------------------------------------------------
struct EngineConfig {
    double      sampleRateHz          = 44100.0;
    int         numChannels           = 2;
    std::size_t instantChunkFrames    = 4096;     // ~93ms @ 44.1kHz: fast quantised model.
    std::size_t hqChunkFrames         = 16384;    // ~372ms @ 44.1kHz: full-precision model.
    float       chunkOverlapRatio     = 0.5f;     // 50% overlap -> Hann satisfies COLA.
    double      instantBufferSeconds  = 5.0;      // State 1 target: first 5s instantly.
    float       crossfadeMinMs        = 10.0f;
    float       crossfadeMaxMs        = 50.0f;
    float       crossfadeDefaultMs    = 25.0f;
    std::size_t ringBufferCapacityFrames = 1u << 17; // 131072 frames, power-of-two required.
};

} // namespace airdox::stem_engine
