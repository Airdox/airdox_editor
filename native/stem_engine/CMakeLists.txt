# =============================================================================
# native/stem_engine/CMakeLists.txt
# -----------------------------------------------------------------------------
# Builds the StemEngine static library plus its unit tests. This target is
# intentionally decoupled from the Electron/Node build (package.json) — it is
# meant to be consumed by a native host (a JUCE plugin/app, or a small native
# Node addon bridging into the existing Electron shell). See
# native/stem_engine/docs/BUILD.md for platform-specific instructions
# (Windows/DirectML, macOS/CoreML, Linux/CPU).
#
# ONNX Runtime is NOT vendored in this repository (its binaries are large,
# platform-specific, and versioned independently). Point CMake at a local
# extraction of the official distribution via -DONNXRUNTIME_ROOT=/path/to/sdk
# or -DORT_HOME=... ; see docs/BUILD.md for exact download links per OS.
# =============================================================================
cmake_minimum_required(VERSION 3.20)
project(airdox_stem_engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(STEM_ENGINE_BUILD_TESTS "Build StemEngine unit/lifecycle tests" ON)
option(STEM_ENGINE_USE_MOCK_ORT "Build against the bundled test-only ONNX Runtime mock instead of a real SDK (CI/sandboxes without network access)" OFF)

add_library(airdox_stem_engine STATIC
    src/StemInferenceWorker.cpp
    src/HighQualityStemCache.cpp
    src/StemEngineManager.cpp
)

target_include_directories(airdox_stem_engine PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)

if (STEM_ENGINE_USE_MOCK_ORT)
    message(WARNING
        "STEM_ENGINE_USE_MOCK_ORT is ON: linking against tests/mock_ort, a "
        "syntax-compatible stub with NO real inference. This produces a "
        "binary that compiles and exercises all concurrency/DSP logic but "
        "performs no actual model math. Never ship a binary built this way.")
    target_include_directories(airdox_stem_engine PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/mock_ort)
else()
    # ---- Real ONNX Runtime discovery ---------------------------------------
    if (NOT DEFINED ONNXRUNTIME_ROOT AND DEFINED ENV{ONNXRUNTIME_ROOT})
        set(ONNXRUNTIME_ROOT "$ENV{ONNXRUNTIME_ROOT}")
    endif()
    if (NOT ONNXRUNTIME_ROOT)
        message(FATAL_ERROR
            "ONNXRUNTIME_ROOT is not set. Download the official ONNX Runtime "
            "C/C++ distribution for your platform (see docs/BUILD.md) and "
            "configure with -DONNXRUNTIME_ROOT=/path/to/onnxruntime, or set "
            "STEM_ENGINE_USE_MOCK_ORT=ON for a logic-only reference build.")
    endif()

    find_path(ORT_INCLUDE_DIR onnxruntime_cxx_api.h
        PATHS "${ONNXRUNTIME_ROOT}/include" "${ONNXRUNTIME_ROOT}/include/onnxruntime/core/session")
    find_library(ORT_LIBRARY
        NAMES onnxruntime
        PATHS "${ONNXRUNTIME_ROOT}/lib")

    if (NOT ORT_INCLUDE_DIR OR NOT ORT_LIBRARY)
        message(FATAL_ERROR "Could not locate onnxruntime headers/library under ${ONNXRUNTIME_ROOT}")
    endif()

    target_include_directories(airdox_stem_engine PUBLIC ${ORT_INCLUDE_DIR})
    target_link_libraries(airdox_stem_engine PUBLIC ${ORT_LIBRARY})

    if (WIN32)
        # DirectML ships as a separate redistributable NuGet/DLL; the EP entry
        # point (OrtSessionOptionsAppendExecutionProvider_DML) is declared in
        # dml_provider_factory.h, shipped inside the GPU-enabled ORT package.
        find_path(ORT_DML_INCLUDE_DIR dml_provider_factory.h PATHS "${ONNXRUNTIME_ROOT}/include")
        if (ORT_DML_INCLUDE_DIR)
            target_include_directories(airdox_stem_engine PUBLIC ${ORT_DML_INCLUDE_DIR})
            target_compile_definitions(airdox_stem_engine PUBLIC AIRDOX_STEM_ENGINE_HAS_DML=1)
        endif()
    endif()

    if (APPLE)
        find_library(COREML_FRAMEWORK CoreML)
        find_library(FOUNDATION_FRAMEWORK Foundation)
        if (COREML_FRAMEWORK AND FOUNDATION_FRAMEWORK)
            target_link_libraries(airdox_stem_engine PUBLIC ${COREML_FRAMEWORK} ${FOUNDATION_FRAMEWORK})
            target_compile_definitions(airdox_stem_engine PUBLIC AIRDOX_STEM_ENGINE_HAS_COREML=1)
        endif()
    endif()
endif()

find_package(Threads REQUIRED)
target_link_libraries(airdox_stem_engine PUBLIC Threads::Threads)

if (MSVC)
    target_compile_options(airdox_stem_engine PRIVATE /W4)
else()
    target_compile_options(airdox_stem_engine PRIVATE -Wall -Wextra)
endif()

# -----------------------------------------------------------------------------
# Tests: the two primitive tests (ring buffer + OLA) have zero ORT dependency
# and always build; the manager lifecycle test requires either a real model
# pair or STEM_ENGINE_USE_MOCK_ORT=ON.
# -----------------------------------------------------------------------------
if (STEM_ENGINE_BUILD_TESTS)
    enable_testing()

    add_executable(stem_engine_primitive_tests tests/test_ring_buffer_and_ola.cpp)
    target_include_directories(stem_engine_primitive_tests PRIVATE include)
    target_link_libraries(stem_engine_primitive_tests PRIVATE Threads::Threads)
    add_test(NAME PrimitiveTests COMMAND stem_engine_primitive_tests)

    if (STEM_ENGINE_USE_MOCK_ORT)
        add_executable(stem_engine_manager_lifecycle_test tests/test_manager_lifecycle.cpp)
        target_link_libraries(stem_engine_manager_lifecycle_test PRIVATE airdox_stem_engine)
        add_test(NAME ManagerLifecycleTest COMMAND stem_engine_manager_lifecycle_test)
    endif()
endif()
