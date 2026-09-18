// =============================================================================
// AudioRingBuffer.h
// -----------------------------------------------------------------------------
// Lock-free, wait-free Single-Producer/Single-Consumer (SPSC) ring buffer for
// planar float PCM audio.
//
// THREAD-SAFETY CONTRACT (read this before touching the class):
//   * Exactly ONE thread may call `write()`  -> the producer.
//   * Exactly ONE thread may call `read()`   -> the consumer.
//   * `availableToRead()` / `availableToWrite()` may be called from either
//     side of the respective role (producer polls space, consumer polls data).
//   * No mutex, no `new`/`malloc`, no exceptions, no syscalls in the hot path.
//     This is what makes it safe to call `read()` from a real-time audio
//     callback: worst-case execution time is O(numFrames), fully bounded,
//     with zero possibility of priority inversion (a classic mutex can suffer
//     priority inversion if a low-priority producer thread holds the lock
//     while the RT thread wants it -> guaranteed XRUN).
//
// MEMORY ORDERING:
//   The classic SPSC pattern uses two atomic cursors, `writeIndex_` and
//   `readIndex_`. The producer only ever WRITES `writeIndex_` and READS
//   `readIndex_`; the consumer is the mirror image. Because each cursor has
//   exactly one writer, plain `relaxed` loads of "my own" cursor are safe,
//   and `acquire`/`release` on the *other* cursor establishes the
//   happens-before edge that makes the payload bytes visible before the
//   index update that publishes them.
// =============================================================================
#pragma once

#include <atomic>
#include <cstddef>
#include <cstring>
#include <memory>
#include <vector>

namespace airdox::stem_engine {

// A single-channel, power-of-two-capacity float ring buffer.
// `StemPlanarRingBuffer` (below) composes N of these, one per output stem
// channel, so multi-stem audio can be produced/consumed without any locking
// across stems either.
class AudioRingBuffer {
public:
    // capacityFrames MUST be a power of two: this lets us replace the modulo
    // operation (slow, has a branch on some ISAs) with a single bitwise AND
    // in the audio-thread hot path.
    explicit AudioRingBuffer(std::size_t capacityFrames)
        : capacityMask_(capacityFrames - 1),
          buffer_(capacityFrames, 0.0f) {
        // Enforce power-of-two at construction time (allocation happens here,
        // off the RT thread, during engine setup -- never during playback).
        const bool isPowerOfTwo = (capacityFrames != 0) &&
                                   ((capacityFrames & (capacityFrames - 1)) == 0);
        capacityFrames_ = isPowerOfTwo ? capacityFrames : nextPowerOfTwo(capacityFrames);
        if (!isPowerOfTwo) {
            buffer_.assign(capacityFrames_, 0.0f);
            capacityMask_ = capacityFrames_ - 1;
        }
    }

    // ---- Producer side (worker thread) -------------------------------------

    // Returns the number of frames that can currently be written without
    // overrunning the consumer. Safe to call from the producer thread.
    std::size_t availableToWrite() const noexcept {
        const std::size_t w = writeIndex_.load(std::memory_order_relaxed);
        const std::size_t r = readIndex_.load(std::memory_order_acquire);
        return capacityFrames_ - (w - r);
    }

    // Copies `numFrames` samples from `src` into the ring. Caller must first
    // check `availableToWrite() >= numFrames`; if the buffer is too full this
    // returns false and writes nothing (never partially writes) so the
    // background pass can back off and retry rather than corrupt state.
    bool write(const float* src, std::size_t numFrames) noexcept {
        if (numFrames > availableToWrite()) {
            return false;
        }
        const std::size_t w = writeIndex_.load(std::memory_order_relaxed);
        const std::size_t idx = w & capacityMask_;
        const std::size_t firstLeg = std::min(numFrames, capacityFrames_ - idx);
        std::memcpy(buffer_.data() + idx, src, firstLeg * sizeof(float));
        if (const std::size_t remainder = numFrames - firstLeg; remainder > 0) {
            std::memcpy(buffer_.data(), src + firstLeg, remainder * sizeof(float));
        }
        // release: publishes the payload written above to the consumer thread
        // *before* it can observe the advanced index.
        writeIndex_.store(w + numFrames, std::memory_order_release);
        return true;
    }

    // ---- Consumer side (audio I/O callback) --------------------------------

    // Returns the number of frames immediately available for reading.
    // Must only be called from the consumer thread.
    std::size_t availableToRead() const noexcept {
        const std::size_t w = writeIndex_.load(std::memory_order_acquire);
        const std::size_t r = readIndex_.load(std::memory_order_relaxed);
        return w - r;
    }

    // Copies up to `numFrames` into `dst`. Returns the number of frames
    // actually copied (may be less than requested if underrun — the caller
    // in the real-time callback MUST handle a short read by filling silence,
    // never by blocking).
    std::size_t read(float* dst, std::size_t numFrames) noexcept {
        const std::size_t available = availableToRead();
        const std::size_t toRead = std::min(numFrames, available);
        const std::size_t r = readIndex_.load(std::memory_order_relaxed);
        const std::size_t idx = r & capacityMask_;
        const std::size_t firstLeg = std::min(toRead, capacityFrames_ - idx);
        std::memcpy(dst, buffer_.data() + idx, firstLeg * sizeof(float));
        if (const std::size_t remainder = toRead - firstLeg; remainder > 0) {
            std::memcpy(dst + firstLeg, buffer_.data(), remainder * sizeof(float));
        }
        // release: ensures the freed capacity is visible to the producer only
        // after our reads of `buffer_` above have completed.
        readIndex_.store(r + toRead, std::memory_order_release);
        return toRead;
    }

    // Advances the read cursor without copying (used to drop stale/expired
    // low-latency audio once the HQ cache takes over — see StemEngineManager).
    void discard(std::size_t numFrames) noexcept {
        const std::size_t toDrop = std::min(numFrames, availableToRead());
        readIndex_.fetch_add(toDrop, std::memory_order_acq_rel);
    }

    void reset() noexcept {
        writeIndex_.store(0, std::memory_order_relaxed);
        readIndex_.store(0, std::memory_order_relaxed);
    }

    std::size_t capacityFrames() const noexcept { return capacityFrames_; }

private:
    static std::size_t nextPowerOfTwo(std::size_t v) noexcept {
        std::size_t p = 1;
        while (p < v) p <<= 1;
        return p;
    }

    std::size_t capacityFrames_;
    std::size_t capacityMask_;
    std::vector<float> buffer_;

    // Cache-line padding avoids false sharing: producer hammers writeIndex_,
    // consumer hammers readIndex_. Without separation both cursors could land
    // on the same 64-byte line, forcing needless cache-coherency traffic
    // (MESI ping-pong) between the audio thread's core and the worker's core.
    alignas(64) std::atomic<std::size_t> writeIndex_{0};
    alignas(64) std::atomic<std::size_t> readIndex_{0};
};

// -----------------------------------------------------------------------------
// StemPlanarRingBuffer
// -----------------------------------------------------------------------------
// Owns one AudioRingBuffer per stem per channel (planar layout: e.g. for
// stereo 4-stem output that's 8 independent ring buffers). Planar layout is
// preferred over interleaved here because:
//   1. It matches the ONNX model's native output layout (no transpose needed).
//   2. Per-stem gain/mute/solo (common DJ operations) becomes a pure scalar
//      multiply over a contiguous buffer -> SIMD-friendly, cache-friendly.
// -----------------------------------------------------------------------------
class StemPlanarRingBuffer {
public:
    StemPlanarRingBuffer(std::size_t numStems, int numChannels, std::size_t capacityFrames) {
        buffers_.reserve(numStems * static_cast<std::size_t>(numChannels));
        for (std::size_t s = 0; s < numStems; ++s) {
            for (int c = 0; c < numChannels; ++c) {
                buffers_.push_back(std::make_unique<AudioRingBuffer>(capacityFrames));
            }
        }
        numStems_ = numStems;
        numChannels_ = numChannels;
    }

    AudioRingBuffer& at(std::size_t stemIndex, int channel) noexcept {
        return *buffers_[stemIndex * static_cast<std::size_t>(numChannels_) + static_cast<std::size_t>(channel)];
    }

    const AudioRingBuffer& at(std::size_t stemIndex, int channel) const noexcept {
        return *buffers_[stemIndex * static_cast<std::size_t>(numChannels_) + static_cast<std::size_t>(channel)];
    }

    std::size_t numStems() const noexcept { return numStems_; }
    int numChannels() const noexcept { return numChannels_; }

private:
    std::size_t numStems_ = 0;
    int numChannels_ = 0;
    std::vector<std::unique_ptr<AudioRingBuffer>> buffers_;
};

} // namespace airdox::stem_engine
