/**
 * LIVE BS-RoFormer test – real architecture, real transport, real process.
 *
 * This is the only test in the suite that runs the actual BS-RoFormer
 * implementation (ZFTurbo/Music-Source-Separation-Training) through the
 * production adapter `python/bsroformer_inference.py`, driven by
 * `BSRoFormerSeparator` + `runBackendProcess`. It proves:
 *
 *   - the architecture is really built from the checkpoint config
 *     (STFT -> band split -> time/band attention -> mask estimator -> iSTFT),
 *   - the JSONL protocol, stem order, progress and cancellation work with the
 *     real backend, not only with a stub,
 *   - a missing/garbage checkpoint fails loudly – it NEVER silently falls back
 *     to untrained weights,
 *   - the engine's overlap-add path works on real model output.
 *
 * QUALITY IS NOT VERIFIED HERE. Without trained weights the network produces
 * random masks, so every such run is reported as `weights: "random"` and the
 * quality verdict stays with TEIL 2 (Stem Isolation Gate). If no trained
 * checkpoint is installed this file says so explicitly instead of pretending.
 *
 * Skips cleanly when Python/PyTorch, the adapter or the upstream sources are
 * missing, so it stays usable in CI containers without a model environment.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BSRoFormerSeparator } from '../src/stems/backends/roformerSeparator';
import { probeExecutable, runBackendProcess } from '../src/stems/backends/processTransport';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { OverlapAddReconstructor, measureContinuity } from '../src/stems/reconstructor';
import { planChunks, SeparationCancellationToken } from '../src/stems/chunkProcessor';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { analyzeAudio, encodeWavFloat32, readWavFile, sha256File } from '../src/stems/wavIo';
import { StemSeparationError } from '../src/stems/errors';
import type { BackendSeparationRequest } from '../src/stems/backends/types';
import type { ModelDescriptor } from '../src/stems/types';

const ADAPTER = path.resolve('python/bsroformer_inference.py');
const TINY_CONFIG = path.resolve('tests/fixtures/bsroformer/tiny_bs_roformer.yaml');
const REFERENCE_CANDIDATES = [process.env.AIRODOX_MSST_DIR, '/home/user/.cache/airdox-stems/vendor/msst'].filter(
  Boolean
) as string[];
/** Trained checkpoints, if the setup script has fetched them. */
const CHECKPOINT_CANDIDATES = [
  process.env.AIRODOX_STEM_CHECKPOINT_DIR,
  '/home/user/.cache/airdox-stems/checkpoints',
].filter(Boolean) as string[];
const TRAINED_4STEM = 'model_bs_roformer_ep_17_sdr_9.6568.ckpt';

async function findPython(): Promise<string | undefined> {
  for (const candidate of [
    process.env.AIRODOX_STEM_PYTHON,
    '/home/user/.venv/bin/python',
    'python3',
    'python',
  ].filter(Boolean) as string[]) {
    const probe = await probeExecutable(candidate, ['-c', 'import torch, soundfile; print(torch.__version__)']);
    if (probe.found) return candidate;
  }
  return undefined;
}

/** `models.bs_roformer` comes from a checkout or from the packaged release. */
async function findReferenceSource(python: string): Promise<{ dir?: string; installedPackage: boolean }> {
  for (const candidate of REFERENCE_CANDIDATES) {
    const probe = await probeExecutable(python, [
      '-c',
      `import os,sys; sys.path.insert(0, ${JSON.stringify(candidate)}); import models.bs_roformer.bs_roformer as m; print(m.__file__)`,
    ]);
    if (probe.found) return { dir: candidate, installedPackage: false };
  }
  const installed = await probeExecutable(python, ['-c', 'import msst, os; print(os.path.dirname(msst.__file__))']);
  return { installedPackage: installed.found };
}

function liveDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  const base = ModelRegistry.fromBundledCatalog().require('bsroformer-viperx-vocals-1297');
  return {
    ...base,
    id: 'live-bsroformer-fixture',
    checkpoint: { file: 'live.ckpt', format: 'pytorch-ckpt' },
    config: { file: 'tiny_bs_roformer.yaml', format: 'yaml' },
    ...overrides,
  } as ModelDescriptor;
}

function baseRequest(partial: Partial<BackendSeparationRequest> & { descriptor: ModelDescriptor; workingWavPath: string; outputDir: string }): BackendSeparationRequest {
  return {
    stems: ['vocals', 'other'],
    chunkIndex: 0,
    chunkCount: 1,
    startSample: 0,
    frames: 0,
    numOverlap: 2,
    ensemblePasses: 1,
    precision: 'f32',
    device: 'cpu',
    profile: 'HIGH_QUALITY',
    ...partial,
  };
}

async function run() {
  const python = await findPython();
  if (!python) {
    console.log('\n⚠ SKIP: kein Python mit PyTorch/soundfile – Live-BS-RoFormer kann hier nicht laufen.');
    return;
  }
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  STEM SEPARATION – LIVE BS-RoFormer (echte Architektur)          ');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`\n  Python: ${python}`);
  console.log(`  Adapter: ${path.relative(process.cwd(), ADAPTER)}`);
  const reference = await findReferenceSource(python);
  if (!reference.dir && !reference.installedPackage) {
    console.log('\n⚠ SKIP: Referenz-Architektur fehlt (weder Checkout noch Paket `msst`).');
    console.log('  Installation: bash scripts/setup-bsroformer-model.sh');
    return;
  }
  const referenceDir = reference.dir;
  console.log(
    `  Referenz-Architektur: ${reference.dir ?? 'Paket msst (pip install msst) – vom Adapter aufgelöst'}`
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-live-'));
  const store = path.join(root, 'models');
  const originalDir = path.join(root, 'Original');
  await mkdir(store, { recursive: true });
  await copyFile(TINY_CONFIG, path.join(store, 'tiny_bs_roformer.yaml'));
  await writeFile(path.join(store, 'garbage.ckpt'), Buffer.from('not a pytorch checkpoint at all'));

  const track = generateEdmTestTrack({ seconds: 2 });
  const written = await writeTestAudio(originalDir, 'live', track);
  const hashBefore = await sha256File(written.mixPath);

  const inputDir = path.join(root, 'input');
  await mkdir(inputDir, { recursive: true });
  const slicePath = path.join(inputDir, 'slice.wav');
  await writeFile(slicePath, encodeWavFloat32(44100, 2, track.mix, track.frames));

  const backend = new BSRoFormerSeparator({
    transport: 'python-torch',
    pythonCommand: python,
    adapterScript: ADAPTER,
    referenceSourceDir: referenceDir,
    modelStoreDir: store,
  });

  // ---- 1. Backend-Kapazität über echte Probes --------------------------------
  console.log('\n[ TEST ] #1 Backend meldet sich mit echtem PyTorch verfügbar');
  const availability = await backend.isAvailable();
  assert.equal(availability.available, true, `Backend nicht verfügbar: ${availability.reason}`);
  assert.equal(backend.capabilities().trainedModel, true, 'BS-RoFormer muss als trainiertes Modell deklariert sein');
  console.log(`  ✓ ${backend.name} verfügbar, Probe: ${availability.probes?.[0]?.detail}`);

  // ---- 2. Echte Architektur + Protokoll (Zufallsgewichte) --------------------
  console.log('\n[ TEST ] #2 Echte BS-RoFormer-Architektur läuft über das JSONL-Protokoll');
  const outputDir = path.join(root, 'out-1');
  await mkdir(outputDir, { recursive: true });
  const progress: number[] = [];
  const response = await backend.separate(
    baseRequest({
      descriptor: liveDescriptor(),
      workingWavPath: slicePath,
      outputDir,
      frames: track.frames,
      extras: { allowRandomWeights: true },
      onProgress: (fraction) => progress.push(fraction),
    })
  );
  const report = response.report as Record<string, unknown>;
  assert.equal(report.family, 'bs_roformer');
  assert.equal(report.weights, 'random', 'ohne trainierten Checkpoint muss weights=random gemeldet werden');
  assert.deepEqual(report.configStemOrder, ['vocals', 'other'], 'Stem-Reihenfolge muss aus dem Checkpoint-Config kommen');
  assert.equal(report.targetInstrument, 'vocals');
  assert.equal(report.sampleRate, 44100);
  assert.equal(report.channels, 2);
  assert.ok(typeof report.torch === 'string' && report.torch.length > 0, 'torch-Version fehlt im Report');
  assert.ok(String(report.referenceSource ?? '').length > 0, 'Adapter muss die Quelle der Architektur melden');
  assert.ok(progress.length > 0, 'echtes Backend muss Fortschritt streamen');
  assert.equal(response.stems.length, 2, `erwartete 2 Stems, erhielt ${response.stems.length}`);
  for (const stem of response.stems) {
    const decoded = await readWavFile(stem.filePath);
    assert.equal(decoded.sampleRate, 44100, `Stem ${stem.name}: Samplerate`);
    assert.equal(decoded.channels, 2, `Stem ${stem.name}: Stereo muss erhalten bleiben`);
    assert.equal(decoded.frames, track.frames, `Stem ${stem.name}: Framezahl`);
    const stats = analyzeAudio(decoded.data, decoded.channels, decoded.frames);
    assert.ok(Number.isFinite(stats.peak) && stats.peak > 0, `Stem ${stem.name}: keine plausible Ausgabe`);
  }
  console.log(`  ✓ done-Report: family=${report.family} weights=${report.weights} torch=${report.torch} ${report.seconds}s`);
  console.log(`  ✓ Architektur aus: ${report.referenceSource}`);
  console.log(`  ✓ configStemOrder=${(report.configStemOrder as string[]).join(',')} targetInstrument=${report.targetInstrument}`);
  console.log(`  ✓ ${progress.length} Fortschrittsmeldung(en), 2 Stem-Dateien (44100 Hz / 2 ch / ${track.frames} Frames)`);

  // ---- 3. Ohne trainierte Gewichte wird niemals stillschweigend geraten ------
  console.log('\n[ TEST ] #3 Fehlender/beschädigter Checkpoint bricht ab – keine stillen Zufallsgewichte');
  const missing = await backend
    .separate(
      baseRequest({
        descriptor: liveDescriptor({ checkpoint: { file: 'does-not-exist.ckpt', format: 'pytorch-ckpt' } }),
        workingWavPath: slicePath,
        outputDir,
        frames: track.frames,
      })
    )
    .catch((error: StemSeparationError) => error);
  assert.ok(missing instanceof StemSeparationError, 'fehlender Checkpoint muss ein Fehler sein');
  assert.equal(missing.code, 'MODEL_MISSING');

  const garbage = await backend
    .separate(
      baseRequest({
        descriptor: liveDescriptor({ checkpoint: { file: 'garbage.ckpt', format: 'pytorch-ckpt' } }),
        workingWavPath: slicePath,
        outputDir,
        frames: track.frames,
      })
    )
    .catch((error: StemSeparationError) => error);
  assert.ok(garbage instanceof StemSeparationError, 'beschädigter Checkpoint muss ein Fehler sein');
  assert.equal(garbage.code, 'MODEL_CORRUPT');
  console.log('  ✓ fehlender Checkpoint -> MODEL_MISSING');
  console.log('  ✓ unlesbarer Checkpoint -> MODEL_CORRUPT (weights=random nur mit expliziter Freigabe)');

  // ---- 4. stem_order-Widerspruch wird abgelehnt -----------------------------
  console.log('\n[ TEST ] #4 Widersprüchliche stem_order wird abgelehnt (keine falsch benannten Stems)');
  const wrongOrder = await backend
    .separate(
      baseRequest({
        descriptor: liveDescriptor({ stemOrder: ['other', 'vocals'] }),
        workingWavPath: slicePath,
        outputDir,
        frames: track.frames,
        extras: { allowRandomWeights: true },
      })
    )
    .catch((error: StemSeparationError) => error);
  assert.ok(wrongOrder instanceof StemSeparationError);
  assert.equal(wrongOrder.code, 'MODEL_INCOMPATIBLE');
  console.log('  ✓ other,vocals gegen Config vocals,other -> MODEL_INCOMPATIBLE');

  // ---- 5. Chunking + Overlap-Add auf echter Modellausgabe --------------------
  console.log('\n[ TEST ] #5 Chunked Inference + Overlap-Add mit echter Modellausgabe');
  const chunkSamples = 44100; // 1 s – erzwingt mehrere Chunks auf 2 s
  const plans = planChunks({ totalFrames: track.frames, chunkSamples, overlapFraction: 0.5, sampleRate: 44100 });
  assert.ok(plans.length > 1, 'Chunk-Plan muss mehrere Segmente liefern');
  const stemIds = ['vocals', 'other'];
  const reconstructors = new Map(
    stemIds.map((stem) => [stem, new OverlapAddReconstructor({ totalFrames: track.frames, channels: 2, plans })])
  );
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    const chunkSlice = path.join(inputDir, `chunk_${index}.wav`);
    await writeFile(
      chunkSlice,
      encodeWavFloat32(44100, 2, track.mix.subarray(plan.startSample * 2, plan.endSample * 2), plan.endSample - plan.startSample)
    );
    const chunkDir = path.join(root, `out-chunk-${index}`);
    await mkdir(chunkDir, { recursive: true });
    const chunkResponse = await backend.separate(
      baseRequest({
        descriptor: liveDescriptor(),
        workingWavPath: chunkSlice,
        outputDir: chunkDir,
        startSample: plan.startSample,
        frames: plan.endSample - plan.startSample,
        chunkIndex: index,
        chunkCount: plans.length,
        extras: { allowRandomWeights: true },
      })
    );
    for (const stem of chunkResponse.stems) {
      const decoded = await readWavFile(stem.filePath);
      assert.equal(decoded.frames, plan.endSample - plan.startSample, `Chunk ${index} / ${stem.name}: Framezahl`);
      reconstructors.get(stem.name)!.add(plan, decoded.data);
    }
  }
  const vocals = reconstructors.get('vocals')!.finalize();
  assert.equal(vocals.length, track.frames * 2, 'rekonstruierter Stem muss die volle Länge haben');
  assert.equal(reconstructors.get('vocals')!.addedChunks, plans.length, 'jeder Chunk muss ins Overlap-Add eingehen');
  const continuity = measureContinuity(vocals, 2, track.frames, plans.slice(1).map((plan) => plan.startSample));
  assert.ok(Number.isFinite(continuity.rmsJumpDb) && Number.isFinite(continuity.excessDb), 'Grenzmetrik muss messbar sein');
  console.log(`  ✓ ${plans.length} Chunks à ${chunkSamples} Samples (50 % Überlappung) über das echte Modell`);
  console.log(
    `  ✓ Overlap-Add: ${track.frames} Frames, Pegelsprung ${continuity.rmsJumpDb.toFixed(3)} dB, ` +
      `Klick-Überschuss ${continuity.excessDb.toFixed(1)} dB, ${continuity.duplicateTransients} doppelte / ${continuity.missingTransients} fehlende Transienten`
  );
  console.log('    (Zufallsgewichte schätzen je Chunk anders – der Sprung belegt hier nur die Messung,');
  console.log('     nicht die Qualität. Overlap-Add-Korrektheit beweist der Technical Gate mit dem Double.)');

  // ---- 6. Abbruch beendet den echten Prozess --------------------------------
  console.log('\n[ TEST ] #6 Abbruch beendet den echten Backend-Prozess (SIGTERM)');
  const token = new SeparationCancellationToken();
  const cancelDir = path.join(root, 'out-cancel');
  await mkdir(cancelDir, { recursive: true });
  const started = Date.now();
  const cancelTimer = setTimeout(() => token.cancel('TEST_ABORT'), 700);
  const cancelled = await backend
    .separate(
      baseRequest({
        descriptor: liveDescriptor(),
        workingWavPath: slicePath,
        outputDir: cancelDir,
        frames: track.frames,
        token,
        extras: { allowRandomWeights: true },
      })
    )
    .catch((error: StemSeparationError) => error)
    .finally(() => clearTimeout(cancelTimer));
  clearTimeout(cancelTimer);
  assert.ok(cancelled instanceof StemSeparationError, 'Abbruch muss einen Fehler liefern');
  assert.equal(cancelled.code, 'INFERENCE_CANCELLED');
  console.log(`  ✓ Abbruch nach ${Date.now() - started} ms -> INFERENCE_CANCELLED, Prozess beendet`);

  // ---- 7. Trainierte Gewichte (nur wenn installiert) -------------------------
  console.log('\n[ TEST ] #7 Trainierte Gewichte / Status TEIL 2');
  let trainedCheckpoint: string | undefined;
  for (const dir of CHECKPOINT_CANDIDATES) {
    const candidate = path.join(dir, TRAINED_4STEM);
    try {
      await readFile(candidate);
      trainedCheckpoint = candidate;
      break;
    } catch {
      /* weiter suchen */
    }
  }
  if (!trainedCheckpoint) {
    console.log('  ⚠ Kein trainierter BS-RoFormer-Checkpoint installiert.');
    console.log(`    Erwartet: ${TRAINED_4STEM} in einem von: ${CHECKPOINT_CANDIDATES.join(', ')}`);
    console.log('    Einrichtung: bash scripts/setup-bsroformer-model.sh');
    console.log('    => TEIL 2 (30-s-EDM-Track, Ground Truth, SI-SDR, STEM ISOLATION GATE) ist damit');
    console.log('       in dieser Umgebung NICHT ausführbar. Alle Läufe oben sind weights=random und');
    console.log('       belegen ausschließlich die technische Funktion, nicht die Trennqualität.');
  } else {
    const trainedStore = path.dirname(trainedCheckpoint);
    const trainedBackend = new BSRoFormerSeparator({
      transport: 'python-torch',
      pythonCommand: python,
      adapterScript: ADAPTER,
      referenceSourceDir: referenceDir,
      modelStoreDir: trainedStore,
    });
    const trainedDir = path.join(root, 'out-trained');
    await mkdir(trainedDir, { recursive: true });
    const trainedResponse = await trainedBackend.separate(
      baseRequest({
        descriptor: liveDescriptor({ checkpoint: { file: TRAINED_4STEM, format: 'pytorch-ckpt' } }),
        workingWavPath: slicePath,
        outputDir: trainedDir,
        frames: track.frames,
        numOverlap: 4,
      })
    );
    assert.equal(trainedResponse.report?.weights, 'checkpoint', 'trainierter Lauf muss weights=checkpoint melden');
    console.log(`  ✓ trainierter Lauf mit ${path.basename(trainedCheckpoint)} (weights=checkpoint)`);
  }

  // ---- 8. Original bleibt unangetastet --------------------------------------
  console.log('\n[ TEST ] #8 Original bleibt während aller Live-Läufe unverändert');
  const hashAfter = await sha256File(written.mixPath);
  assert.equal(hashAfter, hashBefore, 'Original wurde verändert');
  console.log(`  ✓ sha256 unverändert (${hashAfter.slice(0, 16)}…)`);

  console.log('\n✔ LIVE BS-RoFormer: technische Funktion bestätigt (Qualität = TEIL 2)');
  console.log(`  Arbeitsverzeichnis: ${root}`);
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exitCode = 1;
});
