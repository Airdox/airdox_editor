/**
 * Backend contract tests over REAL processes.
 *
 * `tests/fixtures/backends/stub_separator.py` speaks the same JSON Lines
 * protocol and CLI as `python/bsroformer_inference.py`, so these tests drive the
 * production transport code: argv construction, progress parsing, stem mapping
 * through `stemOrder`, cancellation via SIGTERM, exit-code mapping and the
 * GPU -> CPU fallback path. Only the neural network is replaced.
 *
 * The tests skip cleanly when no Python interpreter is available.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BSRoFormerSeparator, MelBandRoFormerSeparator } from '../src/stems/backends/roformerSeparator';
import { HTDemucsSeparator } from '../src/stems/backends/htDemucsSeparator';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { runBackendProcess, probeExecutable, EXIT_CANCELLED } from '../src/stems/backends/processTransport';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemSeparationEngine, createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { SeparationCancellationToken } from '../src/stems/chunkProcessor';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { encodeWavFloat32 } from '../src/stems/wavIo';
import { StemSeparationError } from '../src/stems/errors';
import type { ModelDescriptor } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM SEPARATION – BACKEND CONTRACT (PROZESS-PROTOKOLL)         ');
console.log('═══════════════════════════════════════════════════════════════════');

const STUB = path.resolve('tests/fixtures/backends/stub_separator.py');

async function findPython(): Promise<string | undefined> {
  for (const candidate of [process.env.AIRODOX_STEM_PYTHON, '/home/user/.venv/bin/python', 'python3', 'python'].filter(Boolean) as string[]) {
    const probe = await probeExecutable(candidate, ['-c', 'print(1)']);
    if (probe.found) return candidate;
  }
  return undefined;
}

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  const base = ModelRegistry.fromBundledCatalog().require('bsroformer-viperx-vocals-1297');
  return {
    ...base,
    id: 'contract-test-model',
    checkpoint: { file: 'contract.ckpt', format: 'pytorch-ckpt' },
    config: { file: 'contract.yaml', format: 'pytorch-ckpt' },
    ...overrides,
  } as ModelDescriptor;
}

async function run() {
  const python = await findPython();
  if (!python) {
    console.log('\n⚠ SKIP: kein Python-Interpreter gefunden – Backend-Protokoll kann nicht geprüft werden.');
    return;
  }
  console.log(`\n  Python für Vertragstests: ${python}`);

  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-contract-'));
  const store = path.join(root, 'models');
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, 'contract.ckpt'), 'synthetic');
  await writeFile(path.join(store, 'contract.yaml'), 'audio: {}\n');

  const track = generateEdmTestTrack({ seconds: 1 });
  const written = await writeTestAudio(path.join(root, 'Original'), 'contract', track);
  const inputDir = path.join(root, 'input');
  await mkdir(inputDir, { recursive: true });
  const slicePath = path.join(inputDir, 'slice.wav');
  await writeFile(slicePath, encodeWavFloat32(44100, 2, track.mix, track.frames));

  const descriptor = testDescriptor();

  // ---- 1. progress + stem protocol ----------------------------------------
  console.log('\n[ TEST ] #1 JSONL-Protokoll: Fortschritt, Stems, done-Report');
  // Der Protokoll-Stub braucht kein torch – die Produktionsprüfung aber sehr
  // wohl. Beides wird hier festgehalten, damit die Suite auf einem Runner ohne
  // PyTorch das echte Transportprotokoll fahren kann, statt komplett zu
  // überspringen, die strengen Availability-Regeln aber trotzdem geprüft bleiben.
  const strictBackend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: STUB,
    modelStoreDir: store,
  });
  const torchPresent = await probeExecutable(python, ['-c', 'import torch; print(1)']).then((probe) => probe.found);
  const strictAvailability = await strictBackend.isAvailable();
  assert.equal(
    strictAvailability.available,
    torchPresent,
    `Standardprüfung muss PyTorch verlangen (torch vorhanden=${torchPresent}, gemeldet=${strictAvailability.available})`
  );
  console.log(`  ✓ Availability-Standard: PyTorch erforderlich (vorhanden=${torchPresent})`);

  const backend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: STUB, requireTorch: false,
    modelStoreDir: store,
    env: { STUB_CHUNKS: '4' },
  });
  const availability = await backend.isAvailable();
  assert.equal(availability.available, true, `Backend nicht verfügbar: ${availability.reason}`);
  assert.equal(backend.capabilities().trainedModel, true);
  assert.equal(backend.capabilities().cancellable, true);

  const progressFractions: number[] = [];
  const outDir = path.join(root, 'out1');
  await mkdir(outDir, { recursive: true });
  const response = await backend.separate({
    descriptor,
    workingWavPath: slicePath,
    outputDir: outDir,
    stems: descriptor.stemOrder,
    startSample: 0,
    frames: track.frames,
    chunkIndex: 0,
    chunkCount: 1,
    numOverlap: 2,
    ensemblePasses: 1,
    precision: 'f32',
    device: 'cpu',
    profile: 'HIGH_QUALITY',
    onProgress: (fraction) => progressFractions.push(fraction),
  });
  assert.equal(response.backend, 'python-torch');
  assert.equal(response.engine, 'bs_roformer');
  assert.equal(progressFractions.length, 4, 'vier Fortschrittsmeldungen erwartet');
  assert.equal(progressFractions[progressFractions.length - 1], 1);
  assert.deepEqual(
    response.stems.map((stem) => stem.outputIndex),
    [0, 1],
    'Stems müssen ihren Output-Index melden'
  );
  assert.deepEqual(response.stems.map((stem) => stem.name), ['vocals', 'other']);
  for (const stem of response.stems) {
    const bytes = await readFile(stem.filePath);
    assert.ok(bytes.length > 44, 'Stem-Datei muss Inhalt haben');
  }
  console.log(`  ✓ ${progressFractions.length} Fortschrittsmeldungen (${progressFractions.join(', ')})`);
  console.log(`  ✓ Stems: ${response.stems.map((stem) => `${stem.outputIndex}:${stem.name}`).join(', ')}`);

  // ---- 2. stem order comes from the checkpoint config ----------------------
  console.log('\n[ TEST ] #2 stem_order wird gegen das Checkpoint-Config geprüft');
  const mismatchBackend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: STUB, requireTorch: false,
    modelStoreDir: store,
    // The checkpoint config declares the opposite order of the registry entry.
    env: { STUB_CHUNKS: '1', STUB_CONFIG_STEM_ORDER: 'other,vocals' },
  });
  const wrongOrder = testDescriptor();
  const outMismatch = path.join(root, 'out-mismatch');
  await mkdir(outMismatch, { recursive: true });
  const mismatchError = await mismatchBackend
    .separate({
      descriptor: wrongOrder,
      workingWavPath: slicePath,
      outputDir: outMismatch,
      stems: wrongOrder.stemOrder,
      startSample: 0,
      frames: track.frames,
      chunkIndex: 0,
      chunkCount: 1,
      numOverlap: 2,
      ensemblePasses: 1,
      precision: 'f32',
      device: 'cpu',
      profile: 'HIGH_QUALITY',
    })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(mismatchError instanceof StemSeparationError, 'falsche Stem-Reihenfolge muss fehlschlagen');
  assert.equal(mismatchError.code, 'MODEL_INCOMPATIBLE');
  console.log(`  ✓ widersprüchliche stem_order -> ${mismatchError.code} (keine falsch benannten Stems)`);

  // ---- 3. cancellation kills the child process ----------------------------
  console.log('\n[ TEST ] #3 Abbruch beendet den Backend-Prozess (SIGTERM)');
  const cancelBackend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: STUB, requireTorch: false,
    modelStoreDir: store,
    env: { STUB_CHUNKS: '50', STUB_SLEEP_MS: '120', STUB_CANCEL_AFTER_STEP: '2' },
  });
  const token = new SeparationCancellationToken();
  const outCancel = path.join(root, 'out-cancel');
  await mkdir(outCancel, { recursive: true });
  const started = Date.now();
  const cancelError = await cancelBackend
    .separate({
      descriptor,
      workingWavPath: slicePath,
      outputDir: outCancel,
      stems: descriptor.stemOrder,
      startSample: 0,
      frames: track.frames,
      chunkIndex: 0,
      chunkCount: 1,
      numOverlap: 2,
      ensemblePasses: 1,
      precision: 'f32',
      device: 'cpu',
      profile: 'HIGH_QUALITY',
      token,
      onProgress: (fraction) => {
        if (fraction >= 0.04) token.cancel('Abbruch im Vertragstest');
      },
    })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(cancelError instanceof StemSeparationError);
  assert.equal(cancelError.code, 'INFERENCE_CANCELLED');
  assert.ok(Date.now() - started < 20000, 'Abbruch muss zügig wirken');
  console.log(`  ✓ Abbruch nach ${Date.now() - started} ms -> ${cancelError.code}`);
  assert.equal(EXIT_CANCELLED, 130, 'Exit-Code-Konvention dokumentiert');

  // ---- 4. exit codes map to typed errors ----------------------------------
  console.log('\n[ TEST ] #4 Exit-Codes werden auf Fehler-Codes abgebildet');
  const cases: [string, string][] = [
    ['MODEL_CORRUPT', 'MODEL_CORRUPT'],
    ['WRITE_DENIED', 'WRITE_DENIED'],
    ['AUDIO_CORRUPT', 'AUDIO_CORRUPT'],
    ['STEM_CONFIG_INVALID', 'STEM_CONFIG_INVALID'],
    ['GPU_OUT_OF_MEMORY', 'GPU_OUT_OF_MEMORY'],
  ];
  for (const [stubCode, expected] of cases) {
    const failing = new BSRoFormerSeparator({
      transport: 'python-torch',
      pythonCommand: python,
      adapterScript: STUB, requireTorch: false,
      modelStoreDir: store,
      env: { STUB_FAIL_CODE: stubCode },
    });
    const outFail = path.join(root, `out-fail-${stubCode}`);
    await mkdir(outFail, { recursive: true });
    const error = await failing
      .separate({
        descriptor,
        workingWavPath: slicePath,
        outputDir: outFail,
        stems: descriptor.stemOrder,
        startSample: 0,
        frames: track.frames,
        chunkIndex: 0,
        chunkCount: 1,
        numOverlap: 2,
        ensemblePasses: 1,
        precision: 'f32',
        device: 'cpu',
        profile: 'HIGH_QUALITY',
      })
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof StemSeparationError, `${stubCode}: StemSeparationError erwartet`);
    assert.equal(error.code, expected, `${stubCode}: erwartete ${expected}, erhielt ${error.code}`);
    console.log(`  ✓ Backend-Fehler ${stubCode} -> ${error.code}`);
  }

  // ---- 5. GPU request falls back to CPU ------------------------------------
  console.log('\n[ TEST ] #5 GPU-Anfrage fällt auf CPU zurück, wenn das Backend CPU meldet');
  const deviceBackend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: STUB, requireTorch: false,
    modelStoreDir: store,
    env: { STUB_CHUNKS: '1' },
  });
  const outDevice = path.join(root, 'out-device');
  await mkdir(outDevice, { recursive: true });
  const deviceResponse = await deviceBackend.separate({
    descriptor,
    workingWavPath: slicePath,
    outputDir: outDevice,
    stems: descriptor.stemOrder,
    startSample: 0,
    frames: track.frames,
    chunkIndex: 0,
    chunkCount: 1,
    numOverlap: 2,
    ensemblePasses: 1,
    precision: 'f32',
    device: 'cuda',
    profile: 'HIGH_QUALITY',
  });
  assert.equal(deviceResponse.device, 'cpu', 'Stub meldet CPU');
  console.log(`  ✓ angefordert cuda, geliefert ${deviceResponse.device} (cpuFallback=${deviceResponse.cpuFallback ?? false})`);

  // ---- 6. engine end-to-end through a spawned backend ----------------------
  console.log('\n[ TEST ] #6 Engine nutzt den Prozess-Backend-Pfad vollständig');
  const registry = ModelRegistry.fromBundledCatalog({ extra: [descriptor] });
  const engine = new StemSeparationEngine({
    registry,
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'Cache'),
    modelStoreDir: store,
    backendFactory: {
      candidates: (candidateDescriptor: ModelDescriptor) =>
        candidateDescriptor.family === 'bs_roformer'
          ? [
              new BSRoFormerSeparator({
                transport: 'python-torch',
                pythonCommand: python,
                adapterScript: STUB, requireTorch: false,
                modelStoreDir: store,
                env: { STUB_CHUNKS: '2' },
              }),
            ]
          : [new PipelineDoubleSeparator()],
    },
  });
  const engineResult = await engine.separate({
    inputPath: written.mixPath,
    modelId: 'contract-test-model',
    chunkSizeSamples: 22050,
    overlap: 0.5,
    trackName: 'contract',
  });
  assert.equal(engineResult.status, 'COMPLETED');
  assert.equal(engineResult.metadata.settings.backend, 'python-torch');
  assert.equal(engineResult.stems.length, 2);
  assert.deepEqual(
    engineResult.stems.map((stem) => stem.id),
    ['vocals', 'other'],
    'Stems müssen aus stem_order stammen'
  );
  assert.ok(engineResult.stems.every((stem) => stem.channelCount === 2 && stem.sampleRate === 44100));
  assert.ok(engineResult.validation?.pass, JSON.stringify(engineResult.validation?.issues));
  assert.equal(engineResult.originalIntegrity.unchanged, true);
  // python-torch ist ein Ganzdatei-Backend (processesWholeFile): ein Prozess
  // für den ganzen Track statt ~1 Prozess je 3-Sekunden-Chip – der Chunk-Plan
  // der Engine muss deshalb auf genau einen Plan schrumpfen.
  assert.equal(engineResult.metadata.chunkCount, 1, 'Ganzdatei-Backend bekommt genau einen Plan (kein Prozess-Ping-Pong)');
  console.log(`  ✓ ${engineResult.stems.length} Stems über Prozess-Backend, Validierung bestanden`);
  console.log(`  ✓ chunkCount ${engineResult.metadata.chunkCount} (Ganzdatei), backend ${engineResult.metadata.settings.backend}`);

  // ---- 7. native CLI contract ---------------------------------------------
  console.log('\n[ TEST ] #7 Native Deployment-Verträge (audio.cpp / BSRoformer.cpp)');
  const native = new BSRoFormerSeparator({
    transport: 'native-cli',
    nativeCommand: 'audiocpp_cli',
    nativeDialect: 'audio.cpp',
    modelStoreDir: store,
  });
  const nativeAvailability = await native.isAvailable();
  assert.equal(nativeAvailability.available, false, 'ohne installiertes Binary muss der native Pfad als nicht verfügbar gemeldet werden');
  assert.match(nativeAvailability.reason ?? '', /audiocpp_cli/);
  assert.equal(native.supportsDescriptor(descriptor), true, 'vocals+other ist der native Ausgabeumfang');
  const fourStem = ModelRegistry.fromBundledCatalog().require('bsroformer-musdb18hq-4stem-zfturbo');
  assert.equal(native.supportsDescriptor(fourStem), false, '4-Stem-Deskriptor ist über den nativen Vocal-Pfad nicht bedienbar');
  console.log(`  ✓ natives Binary fehlt -> nicht verfügbar (${nativeAvailability.reason})`);
  console.log('  ✓ natives Backend bedient vocals+other, lehnt 4-Stem-Deskriptor ab (statt Teilergebnis)');

  const nativeError = await native
    .separate({
      descriptor: fourStem,
      workingWavPath: slicePath,
      outputDir: path.join(root, 'out-native'),
      stems: fourStem.stemOrder,
      startSample: 0,
      frames: track.frames,
      chunkIndex: 0,
      chunkCount: 1,
      numOverlap: 4,
      ensemblePasses: 1,
      precision: 'f32',
      device: 'cpu',
      profile: 'HIGH_QUALITY',
    })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(nativeError instanceof StemSeparationError);
  assert.equal(nativeError.code, 'MODEL_INCOMPATIBLE');
  console.log(`  ✓ inkompatibles Modell -> ${nativeError.code}`);

  // ---- 8. engine rejects an unavailable backend ----------------------------
  console.log('\n[ TEST ] #8 Engine meldet BACKEND_UNAVAILABLE, wenn kein Backend läuft');
  const unavailableEngine = new StemSeparationEngine({
    registry,
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'CacheUnavailable'),
    modelStoreDir: store,
    backendFactory: createDefaultBackendFactory({
      pythonCommand: '/nonexistent/python',
      adapterScript: STUB,
      modelStoreDir: store,
    }),
  });
  const unavailableError = await unavailableEngine
    .separate({ inputPath: written.mixPath, modelId: 'contract-test-model', chunkSizeSamples: 22050, trackName: 'unavailable' })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(unavailableError instanceof StemSeparationError);
  assert.equal(unavailableError.code, 'BACKEND_UNAVAILABLE');
  console.log(`  ✓ kein lauffähiges Backend -> ${unavailableError.code}`);

  // ---- 9. protocol level unit checks ---------------------------------------
  console.log('\n[ TEST ] #9 Prozess-Transport: Fehler ohne done-Nachricht');
  const noDoneError = await runBackendProcess({
    command: python,
    args: ['-c', 'print("nur eine Zeile, kein JSON"); print(\'{"type":"log","message":"ohne done"}\')'],
  }).then(() => undefined, (error: unknown) => error);
  assert.ok(noDoneError instanceof StemSeparationError);
  assert.equal(noDoneError.code, 'INFERENCE_FAILED');
  console.log(`  ✓ Backend ohne done-Nachricht -> ${noDoneError.code}`);

  const missingBinary = await runBackendProcess({ command: '/nonexistent/binary', args: [] }).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(missingBinary instanceof StemSeparationError);
  assert.equal(missingBinary.code, 'BACKEND_UNAVAILABLE');
  console.log(`  ✓ nicht existierendes Binary -> ${missingBinary.code}`);

  // ---- 10. other families keep the same contract ---------------------------
  console.log('\n[ TEST ] #10 Mel-Band RoFormer und HTDemucs behalten denselben Vertrag');
  const mel = new MelBandRoFormerSeparator({ transport: 'python-torch', pythonCommand: python, adapterScript: STUB, requireTorch: false, modelStoreDir: store });
  assert.equal(mel.family, 'mel_band_roformer');
  assert.equal(mel.capabilities().trainedModel, true);
  const melDescriptor = ModelRegistry.fromBundledCatalog().require('melbandroformer-viperx-vocals-3005');
  assert.equal(mel.supportsDescriptor(melDescriptor), true);
  assert.equal(mel.supportsDescriptor(descriptor), false, 'Familien dürfen nicht untereinander einspringen');

  const demucs = new HTDemucsSeparator({ pythonCommand: python });
  assert.equal(demucs.family, 'htdemucs');
  assert.equal(demucs.supportsDescriptor(ModelRegistry.fromBundledCatalog().require('htdemucs-ft-4stem')), true);
  assert.equal(demucs.supportsDescriptor(descriptor), false);
  const demucsStatus = await demucs.isAvailable();
  console.log(`  ✓ mel_band_roformer verfügbar=${(await mel.isAvailable()).available}, htdemucs verfügbar=${demucsStatus.available}`);
  console.log('  ✓ beide Familien lehnen fremde Deskriptoren ab');

  // read-only guard on the original directory
  const originalFiles = await readFile(path.join(root, 'Original', 'contract_mixture.wav'));
  assert.ok(originalFiles.length > 1000);
  await chmod(path.join(root, 'Original'), 0o755);
  console.log('\n✔ BACKEND CONTRACT: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
