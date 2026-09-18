// =============================================================================
// StemEngine.h
// -----------------------------------------------------------------------------
// Umbrella header for the StemEngine subsystem. Include this single header
// from JUCE/host application code to get the full public API:
//
//   - StemTypes.h              shared enums/POD config (no ORT dependency)
//   - AudioRingBuffer.h        lock-free SPSC ring buffer(s)
//   - OverlapAddProcessor.h    Hann/Hamming windowing + streaming OLA
//   - StemInferenceWorker.h    ONNX Runtime session wrapper, one per model
//   - HighQualityStemCache.h   RAM/mmap-backed full-track stem cache
//   - StemEngineManager.h      top-level orchestrator (the class hosts embed)
//
// See docs/ARCHITECTURE.md in this directory for the full data-flow diagram
// and docs/PERFORMANCE.md for memory/latency budget guidance.
// =============================================================================
#pragma once

#include "StemTypes.h"
#include "AudioRingBuffer.h"
#include "OverlapAddProcessor.h"
#include "StemInferenceWorker.h"
#include "HighQualityStemCache.h"
#include "StemEngineManager.h"
