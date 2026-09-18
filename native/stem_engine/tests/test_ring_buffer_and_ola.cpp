// =============================================================================
// test_ring_buffer_and_ola.cpp
// -----------------------------------------------------------------------------
// Self-contained correctness tests for the two pieces of the engine that have
// no ONNX Runtime dependency and are the most safety-critical to get right:
//   1. AudioRingBuffer  — SPSC lock-free correctness under concurrent
//      producer/consumer threads (wrap-around, back-pressure, underrun).
//   2. OverlapAddProcessor — COLA reconstruction: windowing + overlap-add of
//      a constant-amplitude signal must reconstruct that same constant
//      amplitude (this is the mathematical definition of COLA correctness).
//
// Build & run (no ONNX Runtime needed):
//   g++ -std=c++20 -O2 -pthread -I../include test_ring_buffer_and_ola.cpp -o t && ./t
// =============================================================================
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

#include "stem_engine/AudioRingBuffer.h"
#include "stem_engine/OverlapAddProcessor.h"

using namespace airdox::stem_engine;

static void testRingBufferBasic() {
    AudioRingBuffer rb(16); // power of two
    assert(rb.capacityFrames() == 16);
    assert(rb.availableToWrite() == 16);
    assert(rb.availableToRead() == 0);

    std::vector<float> src = {1, 2, 3, 4, 5};
    assert(rb.write(src.data(), src.size()));
    assert(rb.availableToRead() == 5);

    std::vector<float> dst(5, 0.0f);
    const std::size_t got = rb.read(dst.data(), dst.size());
    assert(got == 5);
    for (std::size_t i = 0; i < 5; ++i) assert(dst[i] == src[i]);
    assert(rb.availableToRead() == 0);

    printf("[OK] AudioRingBuffer basic write/read\n");
}

static void testRingBufferWrapAround() {
    AudioRingBuffer rb(8);
    std::vector<float> a = {1, 2, 3, 4, 5, 6};
    assert(rb.write(a.data(), a.size()));
    std::vector<float> tmp(6);
    rb.read(tmp.data(), 6); // drain most of it, leaving read/write indices near the end

    std::vector<float> b = {7, 8, 9, 10, 11};
    assert(rb.write(b.data(), b.size())); // this wraps around the ring
    std::vector<float> out(5);
    const std::size_t got = rb.read(out.data(), 5);
    assert(got == 5);
    for (std::size_t i = 0; i < 5; ++i) assert(out[i] == b[i]);

    printf("[OK] AudioRingBuffer wrap-around\n");
}

static void testRingBufferUnderrunIsSafe() {
    AudioRingBuffer rb(8);
    std::vector<float> dst(10, -1.0f);
    const std::size_t got = rb.read(dst.data(), 10);
    assert(got == 0); // nothing written yet -> short read, never garbage/crash
    printf("[OK] AudioRingBuffer underrun returns short read, not garbage\n");
}

static void testRingBufferConcurrentProducerConsumer() {
    AudioRingBuffer rb(1024);
    constexpr std::size_t kTotal = 200000;
    std::atomic<bool> stop{false};

    std::thread producer([&] {
        std::size_t written = 0;
        std::vector<float> chunk(37);
        while (written < kTotal) {
            for (std::size_t i = 0; i < chunk.size(); ++i) chunk[i] = static_cast<float>(written + i);
            const std::size_t n = std::min(chunk.size(), kTotal - written);
            if (rb.write(chunk.data(), n)) {
                written += n;
            } else {
                std::this_thread::yield();
            }
        }
    });

    std::thread consumer([&] {
        std::size_t nextExpected = 0;
        std::vector<float> chunk(23);
        while (nextExpected < kTotal) {
            const std::size_t want = std::min(chunk.size(), kTotal - nextExpected);
            const std::size_t got = rb.read(chunk.data(), want);
            for (std::size_t i = 0; i < got; ++i) {
                assert(chunk[i] == static_cast<float>(nextExpected + i));
            }
            nextExpected += got;
            if (got == 0) std::this_thread::yield();
        }
    });

    producer.join();
    consumer.join();
    printf("[OK] AudioRingBuffer concurrent SPSC producer/consumer, %zu frames, no data loss/corruption\n", kTotal);
}

static void testOverlapAddReconstructsConstantSignal() {
    // A Hann window at 50% overlap is exactly COLA: feeding a constant-value
    // signal through window+OLA must reproduce that same constant value
    // (after the initial ramp-up region where fewer windows have summed).
    constexpr std::size_t chunkFrames = 8;
    constexpr std::size_t hopFrames = 4; // 50% overlap
    OverlapAddProcessor ola(chunkFrames, hopFrames, WindowType::Hann);

    constexpr float kConstant = 0.75f;
    constexpr int kChunksToFeed = 12;

    std::vector<float> reconstructed;
    for (int c = 0; c < kChunksToFeed; ++c) {
        std::vector<float> chunk(chunkFrames, kConstant);
        ola.applyWindow(chunk.data(), chunk.size());
        std::vector<float> emitted(hopFrames);
        ola.accumulateAndEmit(chunk.data(), emitted.data());
        reconstructed.insert(reconstructed.end(), emitted.begin(), emitted.end());
    }

    // Skip the first chunk's worth of samples (ramp-up transient where the
    // window hasn't reached full overlap yet) and check steady-state.
    for (std::size_t i = chunkFrames; i < reconstructed.size() - chunkFrames; ++i) {
        const float err = std::fabs(reconstructed[i] - kConstant);
        if (err > 1e-4f) {
            printf("[FAIL] OLA reconstruction at %zu: got %f expected %f\n", i, reconstructed[i], kConstant);
            assert(false);
        }
    }
    printf("[OK] OverlapAddProcessor COLA reconstruction of constant signal (Hann, 50%% overlap)\n");
}

int main() {
    testRingBufferBasic();
    testRingBufferWrapAround();
    testRingBufferUnderrunIsSafe();
    testRingBufferConcurrentProducerConsumer();
    testOverlapAddReconstructsConstantSignal();
    printf("\nAll StemEngine core-primitive tests passed.\n");
    return 0;
}
