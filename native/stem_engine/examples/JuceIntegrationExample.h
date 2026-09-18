// =============================================================================
// JuceIntegrationExample.h
// -----------------------------------------------------------------------------
// Illustrates how a JUCE `AudioIODeviceCallback` (or `AudioProcessor::
// processBlock`) should drive `StemEngineManager`. This file is a REFERENCE
// only — it is not compiled as part of the CMake target (JUCE is not a
// dependency of this module) — copy the pattern into your actual JUCE host.
//
// Key points this example demonstrates:
//   * `syncPlayhead()` is called exactly once per callback, before any
//     `renderNextBlock()` calls, from the audio thread.
//   * `renderNextBlock()` is called once per stem the UI currently needs
//     audible (e.g. only "vocals" while Acapella mode is engaged, or all
//     four stems mixed with independent gain/mute for a full stem mixer).
//   * Per-stem gain/mute (a common DJ operation — solo one stem, mute
//     another) is applied AFTER `renderNextBlock()`, as a trivial scalar
//     multiply over the already-rendered planar buffer — no extra locking or
//     allocation, and it composes cleanly with whatever mix the manager
//     already produced (Instant / Crossfading / HighQuality).
// =============================================================================
#pragma once

// #include <JuceHeader.h> // Real integration: uncomment in your JUCE project.
#include "stem_engine/StemEngine.h"

namespace airdox::stem_engine::examples {

// A minimal stand-in for JUCE's AudioBuffer<float>/AudioIODeviceCallback
// interface, so this example is self-contained and illustrative without
// pulling in the JUCE dependency itself.
struct MinimalAudioCallback {
    StemEngineManager& engine;
    std::size_t transportFrame = 0;

    // Per-stem UI state a real DJ mixer view would own (solo/mute/gain).
    struct StemMixState { bool muted = false; bool soloed = false; float gain = 1.0f; };
    std::array<StemMixState, kStemCount> mix{};

    // Called by the audio device thread. `numChannels`/`numFrames` mirror
    // JUCE's `audioDeviceIOCallbackWithContext(inputs, outputs, numSamples)`.
    void audioDeviceIOCallback(float* const* outputChannelData, int numChannels, int numFrames) noexcept {
        // 1. Publish the current transport position ONCE per block. In a
        //    real JUCE app this comes from your own sample-accurate
        //    transport counter (e.g. incremented by numFrames per callback,
        //    or read from a host-sync position info struct).
        engine.syncPlayhead(transportFrame);

        // 2. Zero the true output first: we will additively mix whichever
        //    stems are currently audible into it. This buffer is provided
        //    by the host and MUST NOT be assumed pre-zeroed.
        for (int c = 0; c < numChannels; ++c) {
            std::fill(outputChannelData[c], outputChannelData[c] + numFrames, 0.0f);
        }

        // 3. Fixed-size stack scratch per stem — no heap allocation. 8 is a
        //    safe upper bound for stereo; extend if your host supports more
        //    output channels per stem bus.
        constexpr int kMaxChannels = 8;
        float scratchStorage[kMaxChannels][4096]; // 4096: matches a common max JUCE block size; size to your host.
        float* scratchPtrs[kMaxChannels];
        for (int c = 0; c < numChannels && c < kMaxChannels; ++c) scratchPtrs[c] = scratchStorage[c];

        const bool anySoloed = std::any_of(mix.begin(), mix.end(), [](const StemMixState& s) { return s.soloed; });

        for (std::size_t s = 0; s < kStemCount; ++s) {
            const auto& state = mix[s];
            const bool audible = anySoloed ? state.soloed : !state.muted;
            if (!audible) continue;

            engine.renderNextBlock(static_cast<StemId>(s), scratchPtrs, numChannels,
                                    static_cast<std::size_t>(numFrames));

            for (int c = 0; c < numChannels && c < kMaxChannels; ++c) {
                float* dst = outputChannelData[c];
                const float* src = scratchPtrs[c];
                for (int i = 0; i < numFrames; ++i) {
                    dst[i] += src[i] * state.gain;
                }
            }
        }

        // 4. Advance the transport for the NEXT callback. A real host would
        //    do this via its own playback-rate-aware transport (accounting
        //    for time-stretch/pitch/scratch), not a raw frame increment —
        //    shown simplified here for clarity.
        transportFrame += static_cast<std::size_t>(numFrames);
    }
};

} // namespace airdox::stem_engine::examples
