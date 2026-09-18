// =============================================================================
// HighQualityStemCache.h
// -----------------------------------------------------------------------------
// Storage backend for the "State 2 / State 3" full-track high-quality pass.
// Two backends are supported behind one interface:
//
//   * RAM mode    — a plain heap buffer. Fastest, used by default for tracks
//                    that fit comfortably in memory (a 4-stem, stereo, 10
//                    minute track at 32-bit float is ~440 MB, which is fine
//                    on desktop hardware).
//   * mmap mode   — a memory-mapped scratch file. Used when
//                    `preferMemoryMapped` is set (e.g. very long tracks, or
//                    constrained-RAM environments); the OS page cache handles
//                    eviction so the process's resident set stays bounded
//                    while sequential/random reads remain fast.
//
// Both backends expose identical read/write semantics: the background worker
// writes finished, OLA-reconstructed stem audio in track-time order; the
// audio thread (or a non-RT prefetch step just ahead of it) performs
// random-access reads keyed by frame offset, guarded by a coverage bitmap so
// a read of not-yet-processed audio is detected and refused rather than
// returning stale/garbage samples.
// =============================================================================
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <vector>

#include "StemTypes.h"

#if defined(_WIN32)
  #define AIRDOX_STEM_ENGINE_WINDOWS 1
#else
  #define AIRDOX_STEM_ENGINE_WINDOWS 0
#endif

namespace airdox::stem_engine {

// Tracks, per fixed-size block, whether the HQ pass has produced valid audio
// for that block yet. A simple atomic bitset: the writer sets bits (release),
// the reader tests bits (acquire) before trusting the underlying samples.
class CoverageMap {
public:
    explicit CoverageMap(std::size_t numBlocks) : bits_(numBlocks) {
        for (auto& b : bits_) b.store(false, std::memory_order_relaxed);
    }

    void markReady(std::size_t block) noexcept {
        if (block < bits_.size()) bits_[block].store(true, std::memory_order_release);
    }

    bool isReady(std::size_t block) const noexcept {
        return block < bits_.size() && bits_[block].load(std::memory_order_acquire);
    }

    // Checks a contiguous run of blocks; used before starting a handoff so we
    // don't crossfade into a cache region with holes.
    bool isRangeReady(std::size_t firstBlock, std::size_t lastBlockInclusive) const noexcept {
        if (lastBlockInclusive >= bits_.size()) return false;
        for (std::size_t b = firstBlock; b <= lastBlockInclusive; ++b) {
            if (!isReady(b)) return false;
        }
        return true;
    }

    std::size_t numBlocks() const noexcept { return bits_.size(); }

private:
    std::vector<std::atomic<bool>> bits_;
};

struct HighQualityStemCacheConfig {
    std::size_t numFrames = 0;      // Total frames in the source track.
    int numChannels = 2;
    double sampleRateHz = 44100.0;
    std::size_t blockFrames = 4096; // Coverage-map granularity.
    bool preferMemoryMapped = false;
    std::filesystem::path scratchFilePath; // Only used when preferMemoryMapped.
};

// -----------------------------------------------------------------------------
// HighQualityStemCache
// -----------------------------------------------------------------------------
class HighQualityStemCache {
public:
    explicit HighQualityStemCache(const HighQualityStemCacheConfig& cfg);
    ~HighQualityStemCache();

    HighQualityStemCache(const HighQualityStemCache&) = delete;
    HighQualityStemCache& operator=(const HighQualityStemCache&) = delete;

    // Writes one finished, OLA-reconstructed block for `stem`/`channel`
    // starting at `startFrame`. Called only from the background worker
    // thread. Marks the corresponding coverage block(s) ready on success.
    bool writeBlock(StemId stem, int channel, std::size_t startFrame,
                     const float* data, std::size_t numFrames);

    // Reads `numFrames` starting at `startFrame` into `dst`. Returns false
    // (and does not modify `dst`) if any part of the requested range is not
    // yet covered — callers (the RT audio thread) must treat this as "not
    // ready yet" and keep using the Instant Streamer, never as an error.
    // This function only performs memory reads (RAM) or page-cache-backed
    // mmap reads — no syscalls beyond what the OS already resident-maps, so
    // it is safe to call from the audio thread as long as the mapping was
    // established ahead of time (it is, at HighQualityStemCache construction,
    // off the RT thread).
    bool readBlock(StemId stem, int channel, std::size_t startFrame,
                    float* dst, std::size_t numFrames) const noexcept;

    bool isRangeReady(std::size_t startFrame, std::size_t numFrames) const noexcept;

    double coveredSeconds() const noexcept;
    const HighQualityStemCacheConfig& config() const noexcept { return config_; }

private:
    float* channelPtr(StemId stem, int channel) noexcept;
    const float* channelPtr(StemId stem, int channel) const noexcept;

    HighQualityStemCacheConfig config_;
    std::unique_ptr<CoverageMap> coverage_;

    // RAM backend storage (used when !preferMemoryMapped).
    std::vector<std::vector<float>> ramPlanes_; // [stem*numChannels + channel][numFrames]

    // mmap backend storage (used when preferMemoryMapped). Platform-specific
    // handles are opaque `void*`/`int` here; see the .cpp for
    // CreateFileMapping/MapViewOfFile (Windows) vs. mmap/munmap (POSIX).
    void* mappedRegion_ = nullptr;
    std::size_t mappedRegionBytes_ = 0;
#if AIRDOX_STEM_ENGINE_WINDOWS
    void* fileHandle_ = nullptr;   // HANDLE
    void* mappingHandle_ = nullptr; // HANDLE
#else
    int fileDescriptor_ = -1;
#endif
};

} // namespace airdox::stem_engine
