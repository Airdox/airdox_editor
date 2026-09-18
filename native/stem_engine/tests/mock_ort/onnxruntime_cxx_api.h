// =============================================================================
// TEST-ONLY MOCK of a minimal subset of the ONNX Runtime C++ API surface.
// -----------------------------------------------------------------------------
// This file exists ONLY so the StemEngine sources can be syntax/type-checked
// in this sandbox, which has no network access to fetch the real ONNX
// Runtime SDK. It is NOT shipped, NOT linked, and NOT a substitute for the
// real onnxruntime_cxx_api.h — production builds must use the genuine
// ONNX Runtime distribution (see native/stem_engine/docs/BUILD.md).
// The declarations here mirror the real API's names/signatures as closely as
// possible (verified against ONNX Runtime 1.19-1.22 public headers) purely
// to give the reference implementation something real to compile against.
// =============================================================================
#pragma once

#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

enum OrtLoggingLevel { ORT_LOGGING_LEVEL_WARNING = 2 };
enum GraphOptimizationLevel { ORT_ENABLE_ALL = 99 };
enum ExecutionMode { ORT_SEQUENTIAL = 0, ORT_PARALLEL = 1 };
enum OrtAllocatorType { OrtArenaAllocator = 0, OrtDeviceAllocator = 1 };
enum OrtMemType { OrtMemTypeDefault = 0, OrtMemTypeCPU = 1 };

struct OrtSessionOptions {};
struct OrtStatus { std::string message; };

struct OrtTensorRTProviderOptions {
    int device_id = 0;
    int trt_fp16_enable = 0;
    int trt_engine_cache_enable = 0;
};

inline constexpr uint32_t COREML_FLAG_USE_NONE = 0;

inline OrtStatus* OrtSessionOptionsAppendExecutionProvider_DML(OrtSessionOptions&, int) { return nullptr; }
inline OrtStatus* OrtSessionOptionsAppendExecutionProvider_TensorRT(OrtSessionOptions&, const OrtTensorRTProviderOptions*) { return nullptr; }
inline OrtStatus* OrtSessionOptionsAppendExecutionProvider_CoreML(OrtSessionOptions&, uint32_t) { return nullptr; }

namespace Ort {

struct Exception : public std::runtime_error {
    explicit Exception(const std::string& msg) : std::runtime_error(msg) {}
};

inline void ThrowOnError(OrtStatus* status) {
    if (status) throw Exception(status->message);
}

class Env {
public:
    Env() = default;
    Env(OrtLoggingLevel, const char*) {}
};

class SessionOptions {
public:
    SessionOptions() = default;
    SessionOptions& SetIntraOpNumThreads(int) { return *this; }
    SessionOptions& SetExecutionMode(ExecutionMode) { return *this; }
    SessionOptions& SetGraphOptimizationLevel(GraphOptimizationLevel) { return *this; }
    SessionOptions& EnableCpuMemArena() { return *this; }
    SessionOptions& DisableMemPattern() { return *this; }
    operator OrtSessionOptions&() { return opts_; }
private:
    OrtSessionOptions opts_;
};

class MemoryInfo {
public:
    MemoryInfo() = default;
    explicit MemoryInfo(std::nullptr_t) {}
    static MemoryInfo CreateCpu(OrtAllocatorType, OrtMemType) { return MemoryInfo(); }
};

class AllocatedStringPtr {
public:
    explicit AllocatedStringPtr(std::string s) : value_(std::move(s)) {}
    const char* get() const { return value_.c_str(); }
private:
    std::string value_;
};

class AllocatorWithDefaultOptions {
public:
    AllocatorWithDefaultOptions() = default;
};

class Value {
public:
    Value() = default;
    template <typename T>
    static Value CreateTensor(const MemoryInfo&, T* data, std::size_t elementCount,
                               const int64_t* shape, std::size_t shapeLen) {
        Value v;
        v.data_ = reinterpret_cast<float*>(data);
        v.count_ = elementCount;
        (void)shape; (void)shapeLen;
        return v;
    }
    float* GetTensorMutableData() { return data_; }
private:
    float* data_ = nullptr;
    std::size_t count_ = 0;
};

class RunOptions {
public:
    explicit RunOptions(std::nullptr_t) {}
};

class Session {
public:
    Session(Env&, const wchar_t*, SessionOptions&) {}
    Session(Env&, const char*, SessionOptions&) {}

    std::size_t GetInputCount() const { return 1; }
    std::size_t GetOutputCount() const { return 1; }

    AllocatedStringPtr GetInputNameAllocated(std::size_t, AllocatorWithDefaultOptions&) const {
        return AllocatedStringPtr("input");
    }
    AllocatedStringPtr GetOutputNameAllocated(std::size_t, AllocatorWithDefaultOptions&) const {
        return AllocatedStringPtr("output");
    }

    void Run(const RunOptions&, const char* const*, Value*, std::size_t,
             const char* const*, Value*, std::size_t) {}
};

} // namespace Ort
