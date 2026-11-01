# Coverage audit: real Top200 gate remains unsatisfied

Audited 2026-11-01. Base HEAD: `7792beba003bede46402b576ee7021d274321207`, with concurrent uncommitted product changes. No package installs, package/lock changes, product source edits, or live GPU runs were performed. The parent's `stem-remote-job-service.test.ts` session 82392 was not duplicated or consumed.

## Exact scope and present result

`coverage-baseline.json` contains the exact sorted inventory, per-file SHA-256, exclusions, Node test output, raw-data directory, and changed-during-capture list. It enumerates tracked plus nonignored untracked source, including unloaded files. These are denominator **candidates**, not a count of executable statements.

| First-party source | Inventory files | Measurement now |
|---|---:|---|
| JS/TS: 124 TS, 42 TSX, 26 CJS, 19 MJS | 211 | Raw V8 only; no source-mapped line/statement/branch/function percentage |
| Python | 14 | Separate coverage.py baseline below measures 4 files |
| Native C++ and headers | 11 | Unmeasured |
| Shell and PowerShell | 9 | Unmeasured |
| Total inventory | 245 | Whole-project percentage **unknown** |

Includes operational scripts, tools/legacy source and root configuration code, as well as src, electron, server.ts, colab, python and native source. Excludes tests/fixtures/support, declarations, coverage tooling, and generated/build/resource/report trees. Nonignored untracked additions such as Top200 source are included. Notebook cells, HTML, CSS and CMake files are separately listed in `unmeasuredArtifacts`; notebook bootstrap code still needs an explicit execution/test scope. Data/weights/vendor binaries are not executable first-party source denominators. The production relevance of tools/legacy should be settled explicitly before freezing the release scope, rather than silently excluding it to improve the result.

The V8 capture observed positive execution in four inventoried files. This is file reachability evidence only, **not coverage**. Unloaded files stay in the inventory. The killed Top200 batch process did not supply a complete raw profile. No numeric JS coverage is claimed.

The checkout changed during collection: electron/main.cjs, electron/preload.cjs, src/App.tsx, RecorderModal.tsx, RemoteSetupModal.tsx, Top200Panel.tsx, WorkspaceSettingsModal.tsx, useRecorder.ts, settingsStore.ts (full paths in JSON). No aggregate from this capture can certify the current checkout.

**Gate:** >=90% whole-project coverage and 100% critical paths are NOT ESTABLISHED. This means the user's prerequisite remains unmet; it is not a measured claim that total coverage equals zero or that it is definitely below 90%.

## Bounded execution evidence

`node scripts/audit-coverage.mjs --run` ran four suites sequentially with 90 seconds per suite:

- `stem-top200-batch.test.ts`: timed out; incomplete, not passed. No retry alongside parent work.
- `stem-top200-worker.test.mjs`: passed using default Python.
- `stem-remote-manifest.test.ts`: passed.
- `stem-remote-state-machine.test.ts`: passed.

Five raw V8 files were retained. No test-pass fraction is presented as coverage. Native Node coverage propagates through inherited `NODE_V8_COVERAGE`; it cannot measure Python, browser, or C++ execution. Missing local packages: c8, v8-to-istanbul, @bcoe/v8-coverage, and Istanbul coverage/report libraries. Native compiler/llvm/gcov commands were not found on PATH. `node --check scripts/audit-coverage.mjs` passed. The c8 configuration is prepared but cannot be executed/validated with c8 until that dependency is available.

## Actual Python coverage baseline, including unloaded source

The default `python` is Python 3.14 and lacks coverage.py. An already-installed `coverage.exe` uses Python 3.11 with coverage.py 7.14.1. This command collected branch data without installs:

```powershell
coverage run --branch --source=colab,python,scripts --data-file=reports/coverage-audit/coverage-python.dat tests/top200_batch_test.py
coverage json --data-file=reports/coverage-audit/coverage-python.dat -o reports/coverage-audit/coverage-python.json
coverage report --data-file=reports/coverage-audit/coverage-python.dat
```

| Exact measured Python scope | Executable lines | Covered lines | Branch outcomes | Covered outcomes |
|---|---:|---:|---:|---:|
| colab/remote_worker.py | 867 | 0 | 274 | 0 |
| colab/top200_batch.py | 93 | 73 | 38 | 27 |
| python/bsroformer_inference.py | 413 | 0 | 108 | 0 |
| python/install_bsroformer.py | 215 | 0 | 70 | 0 |
| Total for these four files | 1588 | 73 | 490 | 27 |

Exact line coverage: `73/1588 = 4.596977329974811%`. Branch coverage: `27/490 = 5.510204081632653%`. coverage.py's combined display metric is `(73+27)/(1588+490) = 4.8123195380173245%`; do not confuse this with line coverage. Three completely unloaded modules contribute their full executable denominators. This is a **four-file Python baseline**, not whole-project coverage and not the full 14-file Python inventory. `top200_batch.py` itself has line coverage `73/93 = 78.49462365591398%` and branch coverage `27/38 = 71.05263157894737%`, short of a 100% critical-module target.

The instrumented Python run was **red**: two test methods ran, and `test_scoped_resume_and_error_isolation` failed at tests/top200_batch_test.py:54 because `workerWallSeconds` was `0.0`, not greater than zero. The worker mock is immediate and product code uses `time.monotonic()`; interpreter/timer resolution is a possible explanation, not a verified root cause. The Node wrapper using default Python passed. Coverage data from this failing run remains useful as a partial baseline but cannot certify release readiness. No test or product change was made to conceal the failure.

## Defensible complete measurement strategy

1. Freeze the checkout or record hashes before and after and fail certification on any differences. Freeze the source manifest as well, including nonignored untracked release source. Reconcile every manifest entry against a report; an absent entry is an error or an explicit zero, never an implicit exclusion. List reviewed exclusions and notebook/code-generation treatment.
2. For all first-party JS/TS use a pinned c8 reporter with `--all`, explicit extensions and manifest-aligned include/exclude rules. `scripts/project-coverage.c8.json` is prepared for 90% lines/statements/functions/branches with zero-loaded files included. Once installed through the parent's normal dependency process, run `node node_modules/c8/bin/c8.js --config scripts/project-coverage.c8.json node scripts/run-tests.mjs` in the appropriate release test environment. This is a future full run, not an action performed by this audit. Preserve child-process coverage and validate tsx inline source-map remapping against known source lines. Node and renderer/browser/Electron profiles must be remapped to original paths and merged by counters before aggregation. Renderer files cannot disappear simply because Node tests do not import them.
3. Expand coverage.py `--branch --source` to every inventory Python directory and reconcile the output with all 14 Python source files. `--source` discovers unexecuted importable files; namespace/layout omissions still require reconciliation. Use one documented Python interpreter. Cover notebook bootstrap separately or extract the executable code for collection. Include worker subprocess collection when exercising real worker processes.
4. Instrument native sources with Clang `-fprofile-instr-generate -fcoverage-mapping`; merge process profiles and export llvm-cov JSON. Ensure every shipping translation unit and inline header implementation is compiled into the instrumented targets, including unexecuted ones. If native source is not shipped in this release, that exclusion must be explicit and supported by the build graph.
5. Instrument shipping operational PowerShell/shell code with appropriate tools or explicitly resolve its scope. No Node report can establish coverage for these files. Keep native/Python/JS per-runtime results visible. For a cross-runtime line aggregate, sum covered executable source lines and total executable source lines after deduplication: `sum(covered)/sum(total)`. Never average percentages, physical lines, test counts, or file-reach counts. Branch and statement definitions differ between runtimes; report those per runtime and enforce each runtime's floors so a large well-covered subsystem cannot hide a gap.
6. Enforce 90% total executable-line coverage at minimum; a conservative release policy also uses 90% per-runtime lines/branches and JS statements/functions. For 100% critical paths, maintain an explicit path-to-test matrix and enforce 100% line/branch outcomes in the mapped critical code in addition to every critical scenario passing. Check Top200 rank/select, model authority, input/conversion integrity, publish/claim, resume/idempotence, failure isolation/retry, cancellation races, transport loss/timeout, result hash/content validation and saved-library mapping across TS, IPC/server, UI and Python. Excluding difficult error branches is not evidence of critical-path completion.
7. Reuse the parent's in-flight regression result when it completes; do not count it as instrumented coverage retroactively. Prior targeted passes and real ffmpeg conversion are behavioral evidence only. Require bounded representative real-model/transport acceptance evidence as part of the final critical-path matrix in the correct environment; this audit did not run GPU work or the real Top200 batch.

Tool behavior is supported by [c8's all-source and source-map documentation](https://github.com/bcoe/c8#checking-for-full-source-coverage-using---all), [coverage.py source discovery](https://coverage.readthedocs.io/en/latest/source.html), and [Clang source-based coverage](https://clang.llvm.org/docs/SourceBasedCodeCoverage.html).

## Existing critical-path behavioral evidence

| Path | Evidence | Current status |
|---|---|---|
| Top200 ranking/limit, DJPlayCount mapping, deduplication, missing file | Assertions in stem-top200-batch.test.ts | Prior pass supplied by parent; bounded instrumented rerun timed out |
| Publish only submitted job IDs; restart without reconversion/duplicate jobs; checked two-job import; wrong-hash lookup; original bytes unchanged; retry after missing file appears | Same batch test, using pipeline double | Prior pass supplied by parent; not trained-model coverage |
| Actual working-copy ffmpeg conversion, 44.1 kHz and original-source mapping | stem-top200-convert.test.ts, manual suite | Prior pass supplied by parent; not rerun |
| Model ID/profile/artifact/stem authority; scoped resume; per-job GPU-error isolation | top200_batch_test.py via stem-top200-worker.test.mjs | Default-Python wrapper passed; separate Python 3.11 coverage run failed elapsed-time assertion |
| Manifest schema/path traversal/idempotency; incomplete or empty results rejected | stem-remote-manifest.test.ts | Passed in this capture |
| Remote state transitions | stem-remote-state-machine.test.ts | Passed in this capture |
| Original SHA/mtime/size, duplicate start, worker claim/heartbeat trace, restart import, corrupt/missing outputs, transport degradation, timeout, cancellation and stale cancel flags | Assertions in stem-remote-job-service.test.ts | Parent session 82392 pending from this audit's perspective; no duplicate or inferred pass |
| Real trained-model execution, browser/UI-to-IPC/server wiring, real Drive synchronization, all critical branches | No complete instrumented evidence in this audit | Unestablished |

The exact path matrix still needs review and instrumented completion. Neither existing targeted passes nor this bounded audit establish 100% critical-path coverage.
