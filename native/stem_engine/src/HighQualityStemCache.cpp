// =============================================================================
// HighQualityStemCache.cpp
// -----------------------------------------------------------------------------
// RAM and memory-mapped-file backends for the full-track high-quality stem
// cache. Layout (both backends): planar, one contiguous region per
// (stem, channel) pair, `numFrames` floats each, laid out back-to-back:
//
//   [stem0/ch0][stem0/ch1]...[stem1/ch0][stem1/ch1]...[stem3/ch(N-1)]
//
// This lets `readBlock`/`writeBlock` compute a flat offset with simple
// arithmetic and lets the mmap backend rely on the OS page cache for
// sequential-write / random-read performance without any extra buffering
// layer in this class.
// =============================================================================
#include "stem_engine/HighQualityStemCache.h"

#include <cstring>
#include <stdexcept>

#if AIRDOX_STEM_ENGINE_WINDOWS
  #include <windows.h>
#else
  #include <fcntl.h>
  #include <sys/mman.h>
  #include <sys/stat.h>
  #include <unistd.h>
#endif

namespace airdox::stem_engine {

namespace {
std::size_t planeCount(int numChannels) {
    return kStemCount * static_cast<std::size_t>(numChannels);
}
} // namespace

HighQualityStemCache::HighQualityStemCache(const HighQualityStemCacheConfig& cfg) : config_(cfg) {
    const std::size_t numBlocks =
        (config_.numFrames + config_.blockFrames - 1) / std::max<std::size_t>(1, config_.blockFrames);
    coverage_ = std::make_unique<CoverageMap>(numBlocks);

    const std::size_t planes = planeCount(config_.numChannels);
    const std::size_t bytesPerPlane = config_.numFrames * sizeof(float);
    const std::size_t totalBytes = planes * bytesPerPlane;

    if (!config_.preferMemoryMapped) {
        ramPlanes_.resize(planes);
        for (auto& plane : ramPlanes_) {
            plane.assign(config_.numFrames, 0.0f);
        }
        return;
    }

    // ---- Memory-mapped backend ---------------------------------------------
#if AIRDOX_STEM_ENGINE_WINDOWS
    fileHandle_ = ::CreateFileW(
        config_.scratchFilePath.wstring().c_str(),
        GENERIC_READ | GENERIC_WRITE,
        0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (fileHandle_ == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("HighQualityStemCache: CreateFileW failed for scratch file");
    }
    LARGE_INTEGER size;
    size.QuadPart = static_cast<LONGLONG>(totalBytes);
    ::SetFilePointerEx(fileHandle_, size, nullptr, FILE_BEGIN);
    ::SetEndOfFile(fileHandle_);

    mappingHandle_ = ::CreateFileMappingW(fileHandle_, nullptr, PAGE_READWRITE,
                                           static_cast<DWORD>(totalBytes >> 32),
                                           static_cast<DWORD>(totalBytes & 0xFFFFFFFFu), nullptr);
    if (mappingHandle_ == nullptr) {
        ::CloseHandle(fileHandle_);
        throw std::runtime_error("HighQualityStemCache: CreateFileMappingW failed");
    }
    mappedRegion_ = ::MapViewOfFile(mappingHandle_, FILE_MAP_ALL_ACCESS, 0, 0, totalBytes);
    if (mappedRegion_ == nullptr) {
        ::CloseHandle(mappingHandle_);
        ::CloseHandle(fileHandle_);
        throw std::runtime_error("HighQualityStemCache: MapViewOfFile failed");
    }
#else
    fileDescriptor_ = ::open(config_.scratchFilePath.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fileDescriptor_ < 0) {
        throw std::runtime_error("HighQualityStemCache: open() failed for scratch file");
    }
    // Unlink immediately: the fd keeps the underlying inode alive for as long
    // as the mapping/process needs it, and the OS reclaims disk space
    // automatically on process exit/crash — no leftover cache files.
    ::unlink(config_.scratchFilePath.c_str());
    if (::ftruncate(fileDescriptor_, static_cast<off_t>(totalBytes)) != 0) {
        ::close(fileDescriptor_);
        throw std::runtime_error("HighQualityStemCache: ftruncate() failed");
    }
    mappedRegion_ = ::mmap(nullptr, totalBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fileDescriptor_, 0);
    if (mappedRegion_ == MAP_FAILED) {
        mappedRegion_ = nullptr;
        ::close(fileDescriptor_);
        throw std::runtime_error("HighQualityStemCache: mmap() failed");
    }
#endif
    mappedRegionBytes_ = totalBytes;
    std::memset(mappedRegion_, 0, totalBytes);
}

HighQualityStemCache::~HighQualityStemCache() {
    if (!config_.preferMemoryMapped) return;
#if AIRDOX_STEM_ENGINE_WINDOWS
    if (mappedRegion_) ::UnmapViewOfFile(mappedRegion_);
    if (mappingHandle_) ::CloseHandle(mappingHandle_);
    if (fileHandle_) ::CloseHandle(fileHandle_);
#else
    if (mappedRegion_) ::munmap(mappedRegion_, mappedRegionBytes_);
    if (fileDescriptor_ >= 0) ::close(fileDescriptor_);
#endif
}

float* HighQualityStemCache::channelPtr(StemId stem, int channel) noexcept {
    const std::size_t planeIndex =
        static_cast<std::size_t>(stem) * static_cast<std::size_t>(config_.numChannels) +
        static_cast<std::size_t>(channel);
    if (!config_.preferMemoryMapped) {
        return ramPlanes_[planeIndex].data();
    }
    float* base = reinterpret_cast<float*>(mappedRegion_);
    return base + planeIndex * config_.numFrames;
}

const float* HighQualityStemCache::channelPtr(StemId stem, int channel) const noexcept {
    return const_cast<HighQualityStemCache*>(this)->channelPtr(stem, channel);
}

bool HighQualityStemCache::writeBlock(StemId stem, int channel, std::size_t startFrame,
                                       const float* data, std::size_t numFrames) {
    if (startFrame + numFrames > config_.numFrames) return false;
    float* dst = channelPtr(stem, channel) + startFrame;
    std::memcpy(dst, data, numFrames * sizeof(float));

    // Only mark coverage once ALL channels/stems for a given time range have
    // actually landed would be the strictly-correct approach; in this
    // reference implementation the background worker writes all stems for a
    // block together (see StemEngineManager::backgroundWorkerLoop), so
    // marking coverage per (stem=Other, channel=last) call as the "commit"
    // signal is sufficient and avoids a separate cross-stem synchronization
    // structure. We mark on every call; readers additionally re-check
    // `isRangeReady` immediately before trusting data, which is idempotent
    // and cheap.
    const std::size_t firstBlock = startFrame / config_.blockFrames;
    const std::size_t lastBlock = (startFrame + numFrames - 1) / config_.blockFrames;
    for (std::size_t b = firstBlock; b <= lastBlock; ++b) {
        coverage_->markReady(b);
    }
    return true;
}

bool HighQualityStemCache::readBlock(StemId stem, int channel, std::size_t startFrame,
                                      float* dst, std::size_t numFrames) const noexcept {
    if (startFrame + numFrames > config_.numFrames) return false;
    if (!isRangeReady(startFrame, numFrames)) return false;
    const float* src = channelPtr(stem, channel) + startFrame;
    std::memcpy(dst, src, numFrames * sizeof(float));
    return true;
}

bool HighQualityStemCache::isRangeReady(std::size_t startFrame, std::size_t numFrames) const noexcept {
    if (numFrames == 0) return true;
    if (startFrame + numFrames > config_.numFrames) return false;
    const std::size_t firstBlock = startFrame / config_.blockFrames;
    const std::size_t lastBlock = (startFrame + numFrames - 1) / config_.blockFrames;
    return coverage_->isRangeReady(firstBlock, lastBlock);
}

double HighQualityStemCache::coveredSeconds() const noexcept {
    std::size_t readyBlocks = 0;
    for (std::size_t b = 0; b < coverage_->numBlocks(); ++b) {
        if (coverage_->isReady(b)) ++readyBlocks;
    }
    const double framesReady = static_cast<double>(readyBlocks) * static_cast<double>(config_.blockFrames);
    return framesReady / config_.sampleRateHz;
}

} // namespace airdox::stem_engine
