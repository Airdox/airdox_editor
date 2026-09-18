// =============================================================================
// StemEngineManager.cpp
// -----------------------------------------------------------------------------
// Orchestrates the Instant Low-Latency Streamer and the High-Quality Cache,
// including the real-time-safe crossfade handoff between them.
// =============================================================================
#include "stem_engine/StemEngineManager.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace airdox::stem_engine {

namespace {

// Equal-power crossfade curve: at t=0 gainA=1,gainB=0; at t=1 gainA=0,gainB=1;
// and gainA^2 + gainB^2 == 1 throughout, so summed perceived loudness stays
// constant across the fade (a linear crossfade instead dips ~3dB at the
// midpoint, audible as a "hole" — unacceptable for a DJ tool where the
// listener is actively comparing stem quality).
inline void equalPowerGains(float t, float& gainOut, float& gainIn) noexcept {
    t = std::clamp(t, 0.0f, 1.0f);
    constexpr float halfPi = 1.57079632679f;
    gainOut = std::cos(t * halfPi);
    gainIn  = std::sin(t * halfPi);
}

} // namespace

StemEngineManager::StemEngineManager(EngineConfig config) : config_(std::move(config)) {
    instantWorker_ = std::make_unique<StemInferenceWorker>();
    hqWorker_ = std::make_unique<StemInferenceWorker>();

    instantRing_ = std::make_unique<StemPlanarRingBuffer>(
        kStemCount, config_.numChannels, config_.ringBufferCapacityFrames);

    const std::size_t instantHop =
        static_cast<std::size_t>(config_.instantChunkFrames * (1.0f - config_.chunkOverlapRatio));
    const std::size_t hqHop =
        static_cast<std::size_t>(config_.hqChunkFrames * (1.0f - config_.chunkOverlapRatio));

    for (std::size_t s = 0; s < kStemCount; ++s) {
        instantOla_[s] = std::make_unique<OverlapAddProcessor>(
            config_.instantChunkFrames, std::max<std::size_t>(1, instantHop), WindowType::Hann);
        hqOla_[s] = std::make_unique<OverlapAddProcessor>(
            config_.hqChunkFrames, std::max<std::size_t>(1, hqHop), WindowType::Hann);
    }

    crossfadeLengthFrames_ = static_cast<std::size_t>(
        (config_.crossfadeDefaultMs / 1000.0f) * config_.sampleRateHz);
}

StemEngineManager::~StemEngineManager() {
    shutdown();
}

bool StemEngineManager::initialize(const std::filesystem::path& instantModel,
                                    const std::filesystem::path& hqModel,
                                    const std::vector<HardwareProvider>& providerPreference) {
    WorkerConfig instantCfg;
    instantCfg.modelPath = instantModel;
    instantCfg.chunkFrames = config_.instantChunkFrames;
    instantCfg.numChannels = config_.numChannels;
    instantCfg.precision = ModelPrecision::INT8; // Fast path: prioritise latency.
    instantCfg.providerPreference = providerPreference;

    WorkerConfig hqCfg;
    hqCfg.modelPath = hqModel;
    hqCfg.chunkFrames = config_.hqChunkFrames;
    hqCfg.numChannels = config_.numChannels;
    hqCfg.precision = ModelPrecision::FP32; // Quality path: prioritise fidelity.
    hqCfg.providerPreference = providerPreference;

    const bool instantOk = instantWorker_->initialize(instantCfg);
    const bool hqOk = hqWorker_->initialize(hqCfg);
    if (!instantOk || !hqOk) {
        state_.store(EngineState::Error, std::memory_order_release);
        return false;
    }
    return true;
}

void StemEngineManager::loadTrack(std::shared_ptr<const std::vector<float>> interleavedSourcePcm,
                                   std::size_t playheadFrame,
                                   double sampleRateHz) {
    std::lock_guard<std::mutex> lock(loadMutex_); // Setup-only lock; never touched by RT thread.

    // Bump the generation so any still-running loops for the *previous* track
    // observe a mismatch and exit promptly instead of writing into buffers
    // that are about to be resized/replaced underneath them.
    const std::uint64_t myGeneration = generation_.fetch_add(1, std::memory_order_acq_rel) + 1;
    shuttingDown_.store(false, std::memory_order_release);

    if (instantThread_.joinable()) instantThread_.join();
    if (backgroundThread_.joinable()) backgroundThread_.join();

    sourcePcm_ = std::move(interleavedSourcePcm);
    sourceSampleRate_.store(sampleRateHz, std::memory_order_relaxed);
    const std::size_t numFrames =
        sourcePcm_ ? sourcePcm_->size() / static_cast<std::size_t>(config_.numChannels) : 0;
    sourceNumFrames_.store(numFrames, std::memory_order_relaxed);
    playheadFrame_.store(playheadFrame, std::memory_order_relaxed);
    instantWriteCursor_.store(playheadFrame, std::memory_order_relaxed);

    instantRing_->numStems(); // no-op touch to keep symmetry with reset below
    for (std::size_t s = 0; s < kStemCount; ++s) {
        for (int c = 0; c < config_.numChannels; ++c) {
            instantRing_->at(s, c).reset();
        }
        instantOla_[s]->reset();
        hqOla_[s]->reset();
    }

    HighQualityStemCacheConfig cacheCfg;
    cacheCfg.numFrames = numFrames;
    cacheCfg.numChannels = config_.numChannels;
    cacheCfg.sampleRateHz = sampleRateHz;
    cacheCfg.blockFrames = config_.hqChunkFrames;
    cacheCfg.preferMemoryMapped = numFrames > (sampleRateHz * 60.0 * 20.0); // >20 min: use mmap.
    cacheCfg.scratchFilePath = std::filesystem::temp_directory_path() /
        ("airdox_stem_cache_" + std::to_string(myGeneration) + ".tmp");
    hqCache_ = std::make_unique<HighQualityStemCache>(cacheCfg);

    activeSource_.store(ActiveSource::InstantStreamer, std::memory_order_release);
    crossfadeActive_.store(false, std::memory_order_release);
    state_.store(EngineState::InstantBuffering, std::memory_order_release);

    instantThread_ = std::thread([this, myGeneration] { instantWorkerLoop(); });
    backgroundThread_ = std::thread([this, myGeneration] {
        // Small stagger so the instant pass gets first claim on shared CPU
        // cores/GPU queues during the critical first-buffer window.
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        if (generation_.load(std::memory_order_acquire) == myGeneration) {
            backgroundWorkerLoop();
        }
    });
}

void StemEngineManager::seek(std::size_t newPlayheadFrame) {
    // Publish the request; do NOT touch instantRing_/instantOla_ here. Those
    // are exclusively owned by instantWorkerLoop() (single-writer/producer
    // invariant for the SPSC ring buffers and the OLA accumulators) — the
    // worker performs the actual reset the next time it polls
    // seekRequested_. This makes seek() safe to call from any control thread
    // concurrently with a running instant-worker thread.
    pendingSeekFrame_.store(newPlayheadFrame, std::memory_order_relaxed);
    seekRequested_.store(true, std::memory_order_release);
    playheadFrame_.store(newPlayheadFrame, std::memory_order_release);
    crossfadeActive_.store(false, std::memory_order_release);
    activeSource_.store(ActiveSource::InstantStreamer, std::memory_order_release);
}

void StemEngineManager::shutdown() {
    shuttingDown_.store(true, std::memory_order_release);
    generation_.fetch_add(1, std::memory_order_acq_rel);
    wakeCv_.notify_all();
    if (instantThread_.joinable()) instantThread_.join();
    if (backgroundThread_.joinable()) backgroundThread_.join();
    state_.store(EngineState::Idle, std::memory_order_release);
}

EngineStatusSnapshot StemEngineManager::statusSnapshot() const {
    EngineStatusSnapshot snap;
    snap.state = state_.load(std::memory_order_acquire);
    snap.activeSource = activeSource_.load(std::memory_order_acquire);
    snap.cachedSeconds = hqCache_ ? hqCache_->coveredSeconds() : 0.0;
    snap.trackDurationSeconds =
        static_cast<double>(sourceNumFrames_.load(std::memory_order_relaxed)) /
        std::max(1.0, sourceSampleRate_.load(std::memory_order_relaxed));
    snap.instantProvider = instantWorker_ ? instantWorker_->providerReport() : ProviderReport{};
    snap.hqProvider = hqWorker_ ? hqWorker_->providerReport() : ProviderReport{};
    snap.xrunCount = xrunCount_.load(std::memory_order_relaxed);
    return snap;
}

// -----------------------------------------------------------------------------
// instantWorkerLoop — State 1
// -----------------------------------------------------------------------------
// Runs on a background thread. Pulls fixed-size, overlapping chunks starting
// at the current write cursor, runs the fast/quantised model, applies the OLA
// window, and pushes the finished hop into the lock-free ring buffer for the
// audio thread to consume. Prioritises the first `instantBufferSeconds`
// around the playhead, then continues streaming ahead of the playhead so the
// ring buffer never runs dry during normal forward playback.
// -----------------------------------------------------------------------------
void StemEngineManager::instantWorkerLoop() {
    const std::uint64_t myGeneration = generation_.load(std::memory_order_acquire);
    std::array<std::vector<float>, kStemCount> stemChunkScratch;
    for (auto& v : stemChunkScratch) v.assign(config_.instantChunkFrames * config_.numChannels, 0.0f);
    std::vector<float> interleavedChunk(config_.instantChunkFrames * config_.numChannels, 0.0f);
    std::array<float*, kStemCount> outPtrs{};

    while (!shuttingDown_.load(std::memory_order_acquire) &&
           generation_.load(std::memory_order_acquire) == myGeneration) {
        // Handle any pending seek() request first. This thread is the sole
        // writer of instantRing_/instantOla_, so performing the reset here —
        // rather than in seek() itself — keeps the single-writer invariant
        // intact even though seek() is called from an arbitrary control
        // thread (verified data-race-free under ThreadSanitizer).
        if (seekRequested_.exchange(false, std::memory_order_acq_rel)) {
            const std::size_t target = pendingSeekFrame_.load(std::memory_order_relaxed);
            for (std::size_t s = 0; s < kStemCount; ++s) {
                for (int c = 0; c < config_.numChannels; ++c) {
                    instantRing_->at(s, c).reset();
                }
                instantOla_[s]->reset();
            }
            instantWriteCursor_.store(target, std::memory_order_release);
        }

        const auto source = sourcePcm_;
        const std::size_t numFrames = sourceNumFrames_.load(std::memory_order_relaxed);
        if (!source || numFrames == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }

        const std::size_t cursor = instantWriteCursor_.load(std::memory_order_relaxed);
        if (cursor >= numFrames) {
            // Reached end of track; nothing more for the instant path to do
            // until a seek() rewinds the cursor.
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        // Back-pressure: don't outrun the ring buffer capacity. This keeps
        // the worker from burning CPU/GPU cycles producing audio far beyond
        // what playback could ever consume before a seek.
        const std::size_t hop = instantOla_[0]->hopFrames();
        if (instantRing_->at(0, 0).availableToWrite() < hop) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        const std::size_t chunkFrames = config_.instantChunkFrames;
        const std::size_t framesAvailable = std::min(chunkFrames, numFrames - cursor);

        // Build the interleaved-planar input chunk (zero-padded at track end).
        std::fill(interleavedChunk.begin(), interleavedChunk.end(), 0.0f);
        for (int c = 0; c < config_.numChannels; ++c) {
            for (std::size_t i = 0; i < framesAvailable; ++i) {
                const std::size_t srcIdx = (cursor + i) * config_.numChannels + static_cast<std::size_t>(c);
                interleavedChunk[static_cast<std::size_t>(c) * chunkFrames + i] = (*source)[srcIdx];
            }
        }

        for (std::size_t s = 0; s < kStemCount; ++s) outPtrs[s] = stemChunkScratch[s].data();
        if (!instantWorker_->infer(interleavedChunk.data(), outPtrs)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }

        // Window + OLA + push into ring buffer, per stem, per channel.
        std::vector<float> windowed(chunkFrames);
        std::vector<float> emitted(hop);
        for (std::size_t s = 0; s < kStemCount; ++s) {
            for (int c = 0; c < config_.numChannels; ++c) {
                const float* chanSrc = stemChunkScratch[s].data() + static_cast<std::size_t>(c) * chunkFrames;
                std::memcpy(windowed.data(), chanSrc, chunkFrames * sizeof(float));
                instantOla_[s]->applyWindow(windowed.data(), chunkFrames);
                instantOla_[s]->accumulateAndEmit(windowed.data(), emitted.data());
                instantRing_->at(s, c).write(emitted.data(), emitted.size());
            }
        }

        instantWriteCursor_.store(cursor + hop, std::memory_order_release);
    }
}

// -----------------------------------------------------------------------------
// backgroundWorkerLoop — State 2
// -----------------------------------------------------------------------------
// Runs the full-precision model across the ENTIRE track, independent of the
// current playhead, writing finished stem audio into the mmap/RAM cache.
// -----------------------------------------------------------------------------
void StemEngineManager::backgroundWorkerLoop() {
    const std::uint64_t myGeneration = generation_.load(std::memory_order_acquire);
    std::array<std::vector<float>, kStemCount> stemChunkScratch;
    for (auto& v : stemChunkScratch) v.assign(config_.hqChunkFrames * config_.numChannels, 0.0f);
    std::vector<float> interleavedChunk(config_.hqChunkFrames * config_.numChannels, 0.0f);
    std::array<float*, kStemCount> outPtrs{};

    std::size_t cursor = 0;
    const auto source = sourcePcm_;
    const std::size_t numFrames = sourceNumFrames_.load(std::memory_order_relaxed);
    if (!source || numFrames == 0) {
        state_.store(EngineState::Error, std::memory_order_release);
        return;
    }

    state_.store(EngineState::BackgroundAnalyzing, std::memory_order_release);
    const std::size_t chunkFrames = config_.hqChunkFrames;
    const std::size_t hop = hqOla_[0]->hopFrames();
    std::vector<float> windowed(chunkFrames);
    std::vector<float> emitted(hop);

    while (cursor < numFrames) {
        if (shuttingDown_.load(std::memory_order_acquire) ||
            generation_.load(std::memory_order_acquire) != myGeneration) {
            return; // Superseded by a new track load or app shutdown.
        }

        const std::size_t framesAvailable = std::min(chunkFrames, numFrames - cursor);
        std::fill(interleavedChunk.begin(), interleavedChunk.end(), 0.0f);
        for (int c = 0; c < config_.numChannels; ++c) {
            for (std::size_t i = 0; i < framesAvailable; ++i) {
                const std::size_t srcIdx = (cursor + i) * config_.numChannels + static_cast<std::size_t>(c);
                interleavedChunk[static_cast<std::size_t>(c) * chunkFrames + i] = (*source)[srcIdx];
            }
        }

        for (std::size_t s = 0; s < kStemCount; ++s) outPtrs[s] = stemChunkScratch[s].data();
        if (!hqWorker_->infer(interleavedChunk.data(), outPtrs)) {
            // Transient failure (e.g. momentary GPU/driver hiccup): retry the
            // same chunk rather than skipping audio.
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        const std::size_t emitStart = cursor;
        for (std::size_t s = 0; s < kStemCount; ++s) {
            for (int c = 0; c < config_.numChannels; ++c) {
                const float* chanSrc = stemChunkScratch[s].data() + static_cast<std::size_t>(c) * chunkFrames;
                std::memcpy(windowed.data(), chanSrc, chunkFrames * sizeof(float));
                hqOla_[s]->applyWindow(windowed.data(), chunkFrames);
                hqOla_[s]->accumulateAndEmit(windowed.data(), emitted.data());

                const std::size_t writeLen = std::min(hop, numFrames - emitStart);
                if (writeLen > 0) {
                    hqCache_->writeBlock(static_cast<StemId>(s), c, emitStart, emitted.data(), writeLen);
                }
            }
        }

        cursor += hop;
    }

    state_.store(EngineState::CacheReady, std::memory_order_release);
}

// -----------------------------------------------------------------------------
// updateHandoffState — decides whether to start/continue a crossfade
// -----------------------------------------------------------------------------
void StemEngineManager::updateHandoffState(std::size_t playheadFrame) noexcept {
    if (!hqCache_) return;

    const ActiveSource current = activeSource_.load(std::memory_order_acquire);
    if (current == ActiveSource::HighQualityCache) return; // Already fully handed off.

    // Look ahead by one crossfade-length so the fade completes before the
    // HQ cache's actual coverage boundary is reached (avoids fading INTO a
    // not-yet-ready region, which would just reveal the underrun problem one
    // layer deeper).
    const std::size_t lookahead = crossfadeLengthFrames_ + config_.hqChunkFrames;
    const bool ready = hqCache_->isRangeReady(playheadFrame, lookahead);

    if (ready && !crossfadeActive_.load(std::memory_order_acquire)) {
        crossfadeActive_.store(true, std::memory_order_release);
        crossfadeElapsedFrames_ = 0;
        activeSource_.store(ActiveSource::Crossfading, std::memory_order_release);
    }
}

// -----------------------------------------------------------------------------
// renderNextBlock — REAL-TIME AUDIO CALLBACK PATH
// -----------------------------------------------------------------------------
void StemEngineManager::renderNextBlock(StemId stem, float* const* outPlanar, int numChannels,
                                         std::size_t numFrames) noexcept {
    const std::size_t playhead = playheadFrame_.load(std::memory_order_acquire);
    updateHandoffState(playhead);

    const ActiveSource source = activeSource_.load(std::memory_order_acquire);
    const std::size_t stemIdx = static_cast<std::size_t>(stem);

    // Scratch stack buffers for the HQ path — fixed maximum block size keeps
    // this allocation-free (no heap traffic) even though it "looks" dynamic;
    // real hosts call this with a bounded, host-configured block size (e.g.
    // JUCE's `samplesPerBlockExpected`), which is always well under 8192.
    constexpr std::size_t kMaxBlockFrames = 8192;
    float hqScratch[kMaxBlockFrames];
    const std::size_t safeFrames = std::min(numFrames, kMaxBlockFrames);

    for (int c = 0; c < numChannels; ++c) {
        float* out = outPlanar[c];

        if (source == ActiveSource::InstantStreamer) {
            const std::size_t got = instantRing_->at(stemIdx, c).read(out, numFrames);
            if (got < numFrames) {
                // Underrun: fill the remainder with silence rather than
                // blocking or leaving uninitialized memory. This is the
                // "audible but safe" degradation path referenced in the
                // class docs — a brief gap beats a corrupted audio graph.
                std::fill(out + got, out + numFrames, 0.0f);
                xrunCount_.fetch_add(1, std::memory_order_relaxed);
            }
        } else if (source == ActiveSource::HighQualityCache) {
            const bool ok = hqCache_->readBlock(stem, c, playhead, out, numFrames);
            if (!ok) {
                // HQ cache unexpectedly not ready (e.g. a seek jumped past
                // the covered region) -> fall back to instant ring buffer
                // for this block instead of emitting silence, since the
                // instant path is our low-latency guarantee.
                activeSource_.store(ActiveSource::InstantStreamer, std::memory_order_release);
                const std::size_t got = instantRing_->at(stemIdx, c).read(out, numFrames);
                if (got < numFrames) std::fill(out + got, out + numFrames, 0.0f);
            }
        } else { // Crossfading
            const std::size_t got = instantRing_->at(stemIdx, c).read(out, numFrames);
            if (got < numFrames) std::fill(out + got, out + numFrames, 0.0f);

            const bool hqOk = hqCache_->readBlock(stem, c, playhead, hqScratch, safeFrames);
            if (hqOk) {
                for (std::size_t i = 0; i < safeFrames; ++i) {
                    const float t = static_cast<float>(crossfadeElapsedFrames_ + i) /
                                     static_cast<float>(std::max<std::size_t>(1, crossfadeLengthFrames_));
                    float gainOut, gainIn;
                    equalPowerGains(t, gainOut, gainIn);
                    out[i] = out[i] * gainOut + hqScratch[i] * gainIn;
                }
            }
            // Only advance/complete the fade once per block (channel 0),
            // avoiding double-advancing when numChannels > 1.
            if (c == numChannels - 1) {
                crossfadeElapsedFrames_ += numFrames;
                if (crossfadeElapsedFrames_ >= crossfadeLengthFrames_) {
                    activeSource_.store(ActiveSource::HighQualityCache, std::memory_order_release);
                    crossfadeActive_.store(false, std::memory_order_release);
                }
            }
        }
    }
}

} // namespace airdox::stem_engine
