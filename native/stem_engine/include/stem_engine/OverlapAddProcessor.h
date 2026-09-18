// =============================================================================
// OverlapAddProcessor.h
// -----------------------------------------------------------------------------
// Windowing + Overlap-Add (OLA) reconstruction for chunk-based neural
// inference. Neural stem-separation models are evaluated on fixed-size
// windows; naively concatenating independently-inferred windows produces
// audible clicks/discontinuities at every boundary because:
//   (a) the model's receptive field sees different context at the edges, and
//   (b) there is no guarantee consecutive windows agree in phase/amplitude.
//
// The standard fix is Overlap-Add with a window function that satisfies the
// "Constant OverLap-Add" (COLA) criterion: overlapping windows, each tapered
// to zero at their edges, sum back to (approximately) unity gain everywhere.
// A Hann window at 50% overlap is exactly COLA-compliant; a Hamming window at
// 50% overlap is only approximately compliant (small ripple) but is included
// as an option because some checkpoints were trained/validated with it.
// =============================================================================
#pragma once

#include <algorithm>
#include <cmath>
#include <numbers>
#include <vector>

#include "StemTypes.h"

namespace airdox::stem_engine {

enum class WindowType { Hann, Hamming };

// Precomputes and caches a symmetric analysis/synthesis window of a given
// length. Constructed once at startup (or on chunk-size change) — never in
// the hot path.
class WindowTable {
public:
    WindowTable(std::size_t length, WindowType type) : window_(length, 0.0f) {
        generate(type);
    }

    const std::vector<float>& samples() const noexcept { return window_; }
    std::size_t size() const noexcept { return window_.size(); }

private:
    void generate(WindowType type) {
        const std::size_t n = window_.size();
        if (n == 0) return;
        // Periodic form (divide by N, not N-1) is used because this window is
        // multiplied into a signal that will be tiled with hop < N; the
        // periodic form is what keeps the COLA sum flat across tile
        // boundaries. (The symmetric N-1 form is only correct for one-shot
        // spectral analysis windows, not for OLA synthesis.)
        const double twoPi = 2.0 * std::numbers::pi;
        for (std::size_t i = 0; i < n; ++i) {
            const double phase = twoPi * static_cast<double>(i) / static_cast<double>(n);
            double w = 0.0;
            switch (type) {
                case WindowType::Hann:
                    w = 0.5 - 0.5 * std::cos(phase);
                    break;
                case WindowType::Hamming:
                    w = 0.54 - 0.46 * std::cos(phase);
                    break;
            }
            window_[i] = static_cast<float>(w);
        }
    }

    std::vector<float> window_;
};

// -----------------------------------------------------------------------------
// OverlapAddProcessor
// -----------------------------------------------------------------------------
// Accumulates windowed, inference-produced chunks into a rolling output
// buffer at their correct (overlapping) time offsets, normalizing by the
// summed window energy so amplitude stays correct even at the very start/end
// of a track where fewer overlapping windows contribute.
//
// This class is used exclusively on background/worker threads (both the
// Instant Low-Latency path and the High-Quality path route their model
// output through an instance of this class before it ever reaches a ring
// buffer that the RT thread touches). It performs heap-free processing
// per-chunk after construction: all buffers are pre-sized.
// -----------------------------------------------------------------------------
class OverlapAddProcessor {
public:
    OverlapAddProcessor(std::size_t chunkFrames, std::size_t hopFrames, WindowType windowType)
        : chunkFrames_(chunkFrames),
          hopFrames_(hopFrames),
          window_(chunkFrames, windowType),
          accum_(chunkFrames, 0.0f),
          weightAccum_(chunkFrames, 0.0f) {}

    std::size_t chunkFrames() const noexcept { return chunkFrames_; }
    std::size_t hopFrames() const noexcept { return hopFrames_; }

    // Applies the analysis/synthesis window to `chunk` in place. Call this on
    // the raw model output BEFORE accumulate(), so that both this chunk and
    // its neighbours are tapered before being summed.
    void applyWindow(float* chunk, std::size_t numFrames) const noexcept {
        const auto& w = window_.samples();
        const std::size_t n = std::min(numFrames, w.size());
        for (std::size_t i = 0; i < n; ++i) {
            chunk[i] *= w[i];
        }
    }

    // Feeds one windowed chunk into the internal accumulator at time offset 0
    // (relative to the accumulator's current head) and immediately emits the
    // fully-resolved `hopFrames_` samples that can no longer be modified by
    // any future overlapping chunk. This is the classic "streaming OLA"
    // pattern: we only ever need to keep `chunkFrames_` samples of history.
    //
    // `windowedChunk` : chunkFrames_ samples, already windowed via applyWindow().
    // `out`           : caller-provided buffer of at least hopFrames_ samples;
    //                   receives the finished, normalized audio.
    //
    // NORMALIZATION NOTE: the model's chunk output is windowed exactly ONCE
    // here (this is plain OLA, not the analysis+synthesis "WOLA" scheme used
    // inside STFT pipelines, where the window is effectively squared because
    // it is applied both before and after the FFT). Consequently the correct
    // COLA normalizer is the *linear* sum of the window at hop spacing, not
    // its sum of squares. For a periodic Hann window at exactly 50% overlap
    // this linear sum equals 1.0 in steady state, so normalization becomes a
    // no-op there and only matters during the ramp-up/ramp-down at the very
    // start/end of a track.
    void accumulateAndEmit(const float* windowedChunk, float* out) noexcept {
        const auto& w = window_.samples();

        // 1. Sum the incoming windowed chunk and its window weight into the
        //    rolling accumulators (this *is* the "Add" of Overlap-Add).
        for (std::size_t i = 0; i < chunkFrames_; ++i) {
            accum_[i] += windowedChunk[i];
            weightAccum_[i] += w[i];
        }

        // 2. The first `hopFrames_` samples of the accumulator are now final:
        //    no future chunk (which can only start at +hopFrames_ or later)
        //    will ever touch them again. Normalize by summed window energy to
        //    correct for the COLA gain and emit.
        for (std::size_t i = 0; i < hopFrames_; ++i) {
            const float weight = weightAccum_[i];
            out[i] = (weight > 1.0e-8f) ? (accum_[i] / weight) : accum_[i];
        }

        // 3. Slide the accumulator left by hopFrames_ (drop the finished
        //    region, keep the still-pending overlap tail) and zero-fill the
        //    freshly exposed tail so the next accumulate() starts clean.
        const std::size_t tail = chunkFrames_ - hopFrames_;
        std::move(accum_.begin() + hopFrames_, accum_.end(), accum_.begin());
        std::move(weightAccum_.begin() + hopFrames_, weightAccum_.end(), weightAccum_.begin());
        std::fill(accum_.begin() + tail, accum_.end(), 0.0f);
        std::fill(weightAccum_.begin() + tail, weightAccum_.end(), 0.0f);
    }

    void reset() noexcept {
        std::fill(accum_.begin(), accum_.end(), 0.0f);
        std::fill(weightAccum_.begin(), weightAccum_.end(), 0.0f);
    }

private:
    std::size_t chunkFrames_;
    std::size_t hopFrames_;
    WindowTable window_;
    std::vector<float> accum_;       // Rolling weighted-sum accumulator.
    std::vector<float> weightAccum_; // Rolling sum-of-squared-window accumulator.
};

} // namespace airdox::stem_engine
