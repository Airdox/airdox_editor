// =============================================================================
// test_manager_lifecycle.cpp
// -----------------------------------------------------------------------------
// End-to-end smoke test of StemEngineManager against the mock ONNX Runtime
// header (tests/mock_ort). This does NOT validate separation quality (the
// mock session performs no real math) — it validates the concurrency
// contract: loadTrack() correctly starts/joins worker generations, the audio
// thread can call renderNextBlock() throughout without crashing/racing/
// blocking, seek()/shutdown() are safe, and a full run finishes cleanly under
// ThreadSanitizer.
//
// Build (from this directory):
//   g++ -std=c++20 -O1 -g -fsanitize=thread -pthread \
//       -I ../include -I mock_ort \
//       ../src/StemInferenceWorker.cpp ../src/HighQualityStemCache.cpp \
//       ../src/StemEngineManager.cpp test_manager_lifecycle.cpp -o t && ./t
// =============================================================================
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>

#include "stem_engine/StemEngine.h"

using namespace airdox::stem_engine;

int main() {
    EngineConfig cfg;
    cfg.sampleRateHz = 44100.0;
    cfg.numChannels = 2;
    cfg.instantChunkFrames = 512;   // small for a fast test
    cfg.hqChunkFrames = 1024;
    cfg.chunkOverlapRatio = 0.5f;
    cfg.instantBufferSeconds = 1.0;
    cfg.ringBufferCapacityFrames = 1 << 14;

    StemEngineManager manager(cfg);
    const bool initOk = manager.initialize("instant_mock.onnx", "hq_mock.onnx", {HardwareProvider::CPU});
    if (!initOk) {
        printf("[FAIL] initialize() returned false\n");
        return 1;
    }

    // 3 seconds of fake stereo interleaved PCM.
    const std::size_t numFrames = static_cast<std::size_t>(cfg.sampleRateHz * 3);
    auto pcm = std::make_shared<std::vector<float>>(numFrames * cfg.numChannels, 0.1f);

    manager.loadTrack(pcm, 0, cfg.sampleRateHz);

    // Simulate an audio callback thread pulling blocks continuously while
    // background workers run, seeking a couple of times mid-stream, exactly
    // as a real host transport would.
    constexpr std::size_t blockFrames = 512;
    std::vector<float> chL(blockFrames), chR(blockFrames);
    float* planar[2] = {chL.data(), chR.data()};

    std::size_t transportFrame = 0;
    for (int iter = 0; iter < 300; ++iter) {
        manager.syncPlayhead(transportFrame); // host transport publishes position once per block
        manager.renderNextBlock(StemId::Vocal, planar, 2, blockFrames);
        manager.renderNextBlock(StemId::Drums, planar, 2, blockFrames);
        transportFrame += blockFrames;
        if (iter == 100) { manager.seek(numFrames / 3); transportFrame = numFrames / 3; }
        if (iter == 200) { manager.seek(numFrames / 5); transportFrame = numFrames / 5; }
        std::this_thread::sleep_for(std::chrono::microseconds(500));
    }

    const auto status = manager.statusSnapshot();
    printf("[INFO] final state=%d activeSource=%d cachedSeconds=%.2f xruns=%llu\n",
           static_cast<int>(status.state), static_cast<int>(status.activeSource),
           status.cachedSeconds, static_cast<unsigned long long>(status.xrunCount));

    manager.shutdown();
    printf("[OK] StemEngineManager lifecycle test completed without crash/deadlock\n");
    return 0;
}
