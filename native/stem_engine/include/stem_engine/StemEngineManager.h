// =============================================================================
// StemEngineManager.h
// -----------------------------------------------------------------------------
// Top-level orchestrator implementing the Hybrid Streaming & Background
// Caching Model described in the architecture spec:
//
//   State 1 — Instant Buffer:   fast/quantised model fills the first N
//                                seconds around the playhead, chunk by chunk,
//                                into a lock-free ring buffer the audio
//                                thread can read from immediately.
//   State 2 — Background Pass:  a full-track pass with the high-quality model
//                                runs concurrently on another worker thread,
//                                writing finished stem audio into a
//                                memory-mapped cache file.
//   State 3 — Dynamic Handoff:  once the HQ cache covers the section the
//                                playhead is about to reach, the manager
//                                crossfades the RT output from the Instant
//                                ring buffer to the HQ cache reader.
//
// `StemEngineManager` owns both `StemInferenceWorker`s and both worker
// threads, but exposes only a tiny, allocation-free surface
// (`renderNextBlock`) to the audio callback.
// =============================================================================
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

#include "AudioRingBuffer.h"
#include "HighQualityStemCache.h"
#include "OverlapAddProcessor.h"
#include "StemInferenceWorker.h"
#include "StemTypes.h"

namespace airdox::stem_engine {

// Snapshot of engine status, safe to copy out to a UI thread for display.
struct EngineStatusSnapshot {
    EngineState state = EngineState::Idle;
    ActiveSource activeSource = ActiveSource::InstantStreamer;
    double cachedSeconds = 0.0;      // How much of the track the HQ pass has finished.
    double trackDurationSeconds = 0.0;
    ProviderReport instantProvider;
    ProviderReport hqProvider;
    std::uint64_t xrunCount = 0;     // Diagnostic counter, see renderNextBlock().
};

// -----------------------------------------------------------------------------
// StemEngineManager
// -----------------------------------------------------------------------------
class StemEngineManager {
public:
    explicit StemEngineManager(EngineConfig config);
    ~StemEngineManager();

    StemEngineManager(const StemEngineManager&) = delete;
    StemEngineManager& operator=(const StemEngineManager&) = delete;

    // ---- Non-realtime control surface (call from UI/load thread only) -----

    // Initializes both ONNX sessions. `instantModel` should be an
    // INT8/FP16-quantised chunk model; `hqModel` the full-precision
    // high-quality checkpoint (e.g. BS-RoFormer / HTDemucs ONNX export).
    bool initialize(const std::filesystem::path& instantModel,
                     const std::filesystem::path& hqModel,
                     const std::vector<HardwareProvider>& providerPreference);

    // Kicks off State 1 (instant buffer fill around `playheadFrame`) and
    // State 2 (full-track background pass) for a newly loaded track. Safe to
    // call again to switch tracks; cancels any in-flight background pass for
    // the previous track first.
    void loadTrack(std::shared_ptr<const std::vector<float>> interleavedSourcePcm,
                    std::size_t playheadFrame,
                    double sampleRateHz);

    // Requests a discontinuous jump of the playhead (user scrub / cue jump /
    // loop-back). This does NOT touch the instant ring buffer or its OLA
    // state directly — those are owned exclusively by `instantWorkerLoop()`
    // (single-writer invariant). Instead it publishes a pending-seek request
    // that the instant worker thread observes and actions on its own turn,
    // which is what keeps this safe to call from a UI/control thread
    // concurrently with the background workers (verified under
    // ThreadSanitizer, see tests/test_manager_lifecycle.cpp).
    void seek(std::size_t newPlayheadFrame);
    void shutdown();

    EngineStatusSnapshot statusSnapshot() const;

    // ---- Real-time control surface (audio I/O callback thread ONLY) -------

    // The DJ application's own transport (tempo/pitch control, beat sync,
    // scratch, etc.) is the single source of truth for "where is the
    // playhead right now" — StemEngineManager does not run its own clock.
    // The audio callback must call this exactly ONCE per audio block, before
    // calling `renderNextBlock()` for each of the (up to 4) stems it needs
    // that block, so the HQ-cache coverage lookahead in
    // `updateHandoffState()` is evaluated against a single, consistent
    // position rather than being advanced multiple times per block.
    // RT-safe: a single relaxed atomic store, no allocation, no blocking.
    void syncPlayhead(std::size_t currentFrame) noexcept {
        playheadFrame_.store(currentFrame, std::memory_order_relaxed);
    }

    // Renders `numFrames` of the requested stem into `outPlanar[channel]`.
    // Must never block, allocate, throw, or take a lock that a non-RT thread
    // might hold for an unbounded time. Internally this:
    //   1. Reads from the Instant ring buffer and/or the HQ cache reader.
    //   2. Applies an equal-power crossfade if a handoff is in progress.
    //   3. Falls back to silence (never garbage/uninitialized memory) and
    //      increments `xrunCount_` if neither source has enough data ready —
    //      this is the deliberate, audible-but-safe degradation path for a
    //      transient GPU stall, versus blocking the callback (an XRUN that
    //      corrupts the whole audio graph, not just one stem).
    void renderNextBlock(StemId stem, float* const* outPlanar, int numChannels, std::size_t numFrames) noexcept;

private:
    // ---- Background worker loops (run on std::thread, not RT) --------------
    void instantWorkerLoop();
    void backgroundWorkerLoop();

    // Decides, once per audio block, whether a crossfade handoff should begin
    // or continue. Pure arithmetic on atomics — safe to call from the audio
    // thread even though the *decision inputs* are produced by workers.
    void updateHandoffState(std::size_t playheadFrame) noexcept;

    EngineConfig config_;

    std::unique_ptr<StemInferenceWorker> instantWorker_;
    std::unique_ptr<StemInferenceWorker> hqWorker_;

    std::unique_ptr<StemPlanarRingBuffer> instantRing_;
    std::unique_ptr<HighQualityStemCache> hqCache_;

    std::array<std::unique_ptr<OverlapAddProcessor>, kStemCount> instantOla_;
    std::array<std::unique_ptr<OverlapAddProcessor>, kStemCount> hqOla_;

    // Source audio for the currently loaded track. Shared ownership: the
    // loader thread and both worker threads all read from it concurrently
    // (read-only after construction, so this needs no synchronization beyond
    // the shared_ptr's own atomic refcount).
    std::shared_ptr<const std::vector<float>> sourcePcm_;
    std::atomic<double> sourceSampleRate_{44100.0};
    std::atomic<std::size_t> sourceNumFrames_{0};

    std::atomic<std::size_t> playheadFrame_{0};
    std::atomic<std::size_t> instantWriteCursor_{0}; // Next frame the instant worker will produce.

    // Pending-seek handshake: the control thread (seek()) only *requests* a
    // jump by publishing the target frame and raising the flag; the instant
    // worker thread — the sole owner of instantRing_/instantOla_ — performs
    // the actual reset on its own turn. This preserves the single-writer
    // invariant for those structures and is what makes seek() callable
    // concurrently with the running worker without locks or data races.
    std::atomic<std::size_t> pendingSeekFrame_{0};
    std::atomic<bool> seekRequested_{false};

    // Crossfade state machine, touched by the audio thread only (workers only
    // ever set `hqCache_` coverage, which the audio thread polls).
    std::atomic<bool> crossfadeActive_{false};
    std::size_t crossfadeElapsedFrames_ = 0;
    std::size_t crossfadeLengthFrames_ = 0;

    std::atomic<EngineState> state_{EngineState::Idle};
    std::atomic<ActiveSource> activeSource_{ActiveSource::InstantStreamer};
    std::atomic<std::uint64_t> xrunCount_{0};

    // Worker thread lifecycle. `generation_` is bumped on every loadTrack()
    // call so in-flight workers from a *previous* track can detect they are
    // stale and exit early instead of racing the new track's state.
    std::atomic<std::uint64_t> generation_{0};
    std::atomic<bool> shuttingDown_{false};
    std::thread instantThread_;
    std::thread backgroundThread_;
    std::mutex loadMutex_; // Guards start/stop of worker threads; never touched by the RT thread.
    std::condition_variable wakeCv_;
    std::mutex wakeMutex_;
};

} // namespace airdox::stem_engine
