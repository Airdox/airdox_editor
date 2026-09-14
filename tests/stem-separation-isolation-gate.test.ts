/**
 * STEM ISOLATION GATE – TEIL 2: the QUALITY gate of the stem engine.
 *
 * While part 1 (engine gate + live test) proves technical function, this test
 * proves separation QUALITY against ground truth:
 *
 *   1. A 30-second EDM track with known ground truth stems is generated
 *      (deterministic, seed 0xede2 – disjoint from all training seeds).
 *   2. The REAL backend separates the full track. With a trained checkpoint
 *      the Stem Isolation Gate must PASS: every stem needs SI-SDR above the
 *      floor AND an isolation gain over the mixture baseline.
 *   3. The same architecture with random weights (development-only
 *      `allowRandomWeights`) must FAIL the gate – proving the gate
 *      discriminates trained from untrained instead of rubber-stamping.
 *
 * Checkpoint resolution (first match wins):
 *   - REAL:  `model_bs_roformer_ep_17_sdr_9.6568.ckpt` + its config (MUSDB18-HQ,
 *            see src/stems/modelCatalog.json → bsroformer-musdb18hq-4stem-zfturbo)
 *   - SMOKE: `model_bs_roformer_edmsmoke.ckpt` (synthetic domain, trained via
 *            `npm run stems:smoke:train` – proves the trained path end-to-end)
 *   - none:  random control only; the test then says explicitly that quality
 *            CANNOT be verified in this environment (like the live test).
 *
 * Thresholds are overridable via AIRODOX_GATE_MIN_SISDR_DB /
 * AIRODOX_GATE_MIN_GAIN_DB so environments can calibrate without code changes.
 *
 * Skips cleanly when Python/PyTorch or the reference architecture is missing.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BSRoFormerSeparator } from '../src/stems/backends/roformerSeparator';
import { probeExecutable } from '../src/stems/backends/processTransport';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { encodeWavFloat32, readWavFile, sha256File } from '../src/stems/wavIo';
import {
  DEFAULT_THRESHOLDS,
  evaluateStemIsolation,
  writeIsolationReport,
  type StemIsolationReport,
  type StemIsolationThresholds,
} from '../src/stems/isolationGate';
import type { BackendSeparationRequest } from '../src/stems/backends/types';
import type { ModelDescriptor } from '../src/stems/types';

const ADAPTER = path.resolve('python/bsroformer_inference.py');
const SMOKE_CONFIG_FIXTURE = path.resolve('tests/fixtures/bsroformer/edmsmoke_bs_roformer.yaml');

const REAL_4STEM = 'model_bs_roformer_ep_17_sdr_9.6568.ckpt';
const REAL_CONFIG = 'config_bs_roformer_384_8_2_485100.yaml';
const SMOKE_CKPT = 'model_bs_roformer_edmsmoke.ckpt';
const SMOKE_CONFIG = 'edmsmoke_bs_roformer.yaml';

const CHECKPOINT_DIRS = [
  process.env.AIRODOX_STEM_CHECKPOINT_DIR,
  '/home/user/.cache/airdox-stems/checkpoints',
].filter(Boolean) as string[];

/** 30 seconds – the Teil-2 evaluation length. */
const EVAL_SECONDS = 30;
const EVAL_SEED = 0xede2;
const EVAL_BPM = 126;

/** Numbered thresholds; a stem must clear BOTH (or beat the baseline strongly). */
function gateThresholds(): StemIsolationThresholds {
  return {
    minSiSdrDb: Number(process.env.AIRODOX_GATE_MIN_SISDR_DB ?? DEFAULT_THRESHOLDS.minSiSdrDb),
    minIsolationGainDb: Number(process.env.AIRODOX_GATE_MIN_GAIN_DB ?? DEFAULT_THRESHOLDS.minIsolationGainDb),
    strongIsolationGainDb: Number(
      process.env.AIRODOX_GATE_STRONG_GAIN_DB ?? DEFAULT_THRESHOLDS.strongIsolationGainDb
    ),
  };
}

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

async function findReferenceSource(python: string): Promise<{ dir?: string; installedPackage: boolean }> {
  for (const candidate of [process.env.AIRODOX_MSST_DIR, '/home/user/.cache/airdox-stems/vendor/msst'].filter(
    Boolean
  ) as string[]) {
    const probe = await probeExecutable(python, [
      '-c',
      `import os,sys; sys.path.insert(0, ${JSON.stringify(candidate)}); import models.bs_roformer.bs_roformer as m; print(m.__file__)`,
    ]);
    if (probe.found) return { dir: candidate, installedPackage: false };
  }
  const installed = await probeExecutable(python, ['-c', 'import msst, os; print(os.path.dirname(msst.__file__))']);
  return { installedPackage: installed.found };
}

type GateMode =
  | { kind: 'real'; checkpointPath: string; configPath: string; storeDir: string }
  | { kind: 'smoke'; checkpointPath: string; configPath: string; storeDir: string }
  | { kind: 'random-only' };

async function detectMode(): Promise<GateMode> {
  for (const dir of CHECKPOINT_DIRS) {
    const realCheckpoint = path.join(dir, REAL_4STEM);
    const realConfig = path.join(dir, REAL_CONFIG);
    try {
      await Promise.all([readFile(realCheckpoint), readFile(realConfig)]);
      return { kind: 'real', checkpointPath: realCheckpoint, configPath: realConfig, storeDir: dir };
    } catch {
      /* weiter suchen */
    }
  }
  for (const dir of CHECKPOINT_DIRS) {
    const smokeCheckpoint = path.join(dir, SMOKE_CKPT);
    const smokeConfig = path.join(dir, SMOKE_CONFIG);
    try {
      await Promise.all([readFile(smokeCheckpoint), readFile(smokeConfig)]);
      return { kind: 'smoke', checkpointPath: smokeCheckpoint, configPath: smokeConfig, storeDir: dir };
    } catch {
      /* weiter suchen */
    }
  }
  return { kind: 'random-only' };
}

function fourStemDescriptor(): ModelDescriptor {
  const base = ModelRegistry.fromBundledCatalog().require('bsroformer-musdb18hq-4stem-zfturbo');
  return { ...base } as ModelDescriptor;
}

function baseRequest(
  partial: Partial<BackendSeparationRequest> & { descriptor: ModelDescriptor; workingWavPath: string; outputDir: string }
): BackendSeparationRequest {
  return {
    stems: ['vocals', 'bass', 'drums', 'other'],
    chunkIndex: 0,
    chunkCount: 1,
    startSample: 0,
    frames: 0,
    numOverlap: 4,
    ensemblePasses: 1,
    precision: 'f32',
    device: 'cpu',
    profile: 'HIGH_QUALITY',
    ...partial,
  };
}

function printReport(report: StemIsolationReport): void {
  console.log(
    `  ${report.pass ? '✔' : '✘'} STEM ISOLATION GATE: ${report.summary.passed}/${report.summary.total} Stems bestanden (weights=${report.weights})`
  );
  for (const stem of report.stems) {
    console.log(`    ${stem.pass ? '✓' : '✗'} ${stem.stem.padEnd(7)} ${stem.detail}`);
  }
  for (const note of report.notes) console.log(`    ℹ ${note}`);
}

async function run() {
  const python = await findPython();
  if (!python) {
    console.log('\n⚠ SKIP: kein Python mit PyTorch/soundfile – Stem Isolation Gate kann hier nicht laufen.');
    return;
  }
  const reference = await findReferenceSource(python);
  if (!reference.dir && !reference.installedPackage) {
    console.log('\n⚠ SKIP: Referenz-Architektur fehlt (weder Checkout noch Paket `msst`).');
    console.log('  Installation: bash scripts/setup-bsroformer-model.sh');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  TEIL 2 – STEM ISOLATION GATE (30-s-EDM, Ground Truth, SI-SDR)    ');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`\n  Python: ${python}`);

  const mode = await detectMode();
  const thresholds = gateThresholds();
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-gate2-'));
  const originalDir = path.join(root, 'Original');
  const inputDir = path.join(root, 'input');

  // ---- 1. 30-s-EDM-Track mit Ground Truth -----------------------------------
  console.log(`\n[ TEST ] #1 30-s-EDM-Track mit Ground Truth generieren (seed=${EVAL_SEED}, ${EVAL_BPM} BPM)`);
  const track = generateEdmTestTrack({ seconds: EVAL_SECONDS, sampleRate: 44100, bpm: EVAL_BPM, seed: EVAL_SEED });
  const written = await writeTestAudio(originalDir, 'gate', track);
  const hashBefore = await sha256File(written.mixPath);
  assert.equal(track.frames, 44100 * EVAL_SECONDS);
  assert.deepEqual([...track.stems.keys()].sort(), ['bass', 'drums', 'other', 'vocals']);
  console.log(`  ✓ ${track.seconds}s / ${track.frames} Frames / 4 Stems, Mix-Hash ${hashBefore.slice(0, 16)}…`);

  await mkdir(inputDir, { recursive: true });
  const slicePath = path.join(inputDir, 'gate_30s.wav');
  await writeFile(slicePath, encodeWavFloat32(44100, 2, track.mix, track.frames));

  const separatorOptions = {
    transport: 'python-torch' as const,
    pythonCommand: python,
    adapterScript: ADAPTER,
    referenceSourceDir: reference.dir,
  };

  let trainedReport: StemIsolationReport | undefined;

  if (mode.kind !== 'random-only') {
    // ---- 2. Trainierter Lauf: Gate muss BESTEHEN ----------------------------
    const isReal = mode.kind === 'real';
    const modelId = isReal ? 'bsroformer-musdb18hq-4stem-zfturbo' : 'bsroformer-edmsmoke-smoke';
    console.log(`\n[ TEST ] #2 Separation mit trainiertem Checkpoint (${isReal ? 'MUSDB18-HQ' : 'EDMSMOKE, synthetisches Smoke-Modell'})`);
    if (!isReal) {
      console.log('  ℹ Der echte MUSDB18-HQ-Checkpoint ist hier nicht installiert. Der Smoke-Checkpoint ist');
      console.log('    auf SYNTHETISCHEM Material trainiert und belegt den trainierten Pfad END-TO-END –');
      console.log('    er ist KEIN Ersatz für das Produktionsmodell (siehe Fixture-Header).');
    }
    const store = mode.storeDir;
    const descriptor: ModelDescriptor = {
      ...fourStemDescriptor(),
      id: modelId,
      checkpoint: { file: path.basename(mode.checkpointPath), format: 'pytorch-ckpt' },
      config: { file: path.basename(mode.configPath), format: 'pytorch-ckpt' },
    };

    const backend = new BSRoFormerSeparator({ ...separatorOptions, modelStoreDir: store });
    const availability = await backend.isAvailable();
    assert.equal(availability.available, true, `Backend nicht verfügbar: ${availability.reason}`);

    const outputDir = path.join(root, 'out-trained');
    await mkdir(outputDir, { recursive: true });
    const startedAt = Date.now();
    const response = await backend.separate(
      baseRequest({ descriptor, workingWavPath: slicePath, outputDir, frames: track.frames })
    );
    const durationMs = Date.now() - startedAt;
    assert.equal(response.report?.weights, 'checkpoint', `trainierter Lauf muss weights=checkpoint melden, war ${response.report?.weights}`);
    assert.equal(response.stems.length, 4, `erwartete 4 Stems, erhielt ${response.stems.length}`);

    const estimates = new Map<string, Float32Array>();
    for (const stem of response.stems) {
      const decoded = await readWavFile(stem.filePath);
      assert.equal(decoded.frames, track.frames, `Stem ${stem.name}: Framezahl`);
      estimates.set(stem.name, decoded.data);
    }
    trainedReport = evaluateStemIsolation({
      estimates,
      groundTruth: track.stems,
      mixture: track.mix,
      channels: 2,
      modelId,
      weights: 'checkpoint',
      trackSeconds: track.seconds,
      thresholds,
      durationMs,
      notes: isReal
        ? ['Checkpoint: MUSDB18-HQ (ZFTurbo v1.0.12), Produktionsmodell laut modelCatalog.json']
        : [
            'Checkpoint: EDMSMOKE – auf synthetischem EDM-Material (andre Seeds) trainiert.',
            'Beweist den trainierten Pfad (Checkpoint → Adapter → SI-SDR), kein Produktionsmodell.',
          ],
    });
    const reportPath = await writeIsolationReport(trainedReport, root, 'isolation-gate-trained');
    printReport(trainedReport);
    console.log(`  ✓ Laufzeit ${durationMs} ms, Report: ${reportPath}`);
    assert.equal(trainedReport.pass, true, 'Gate muss mit trainierten Gewichten BESTEHEN');
  } else {
    console.log('\n⚠ Kein trainierter BS-RoFormer-Checkpoint installiert – Qualitätsverifikation (Gate PASS)');
    console.log('  ist in dieser Umgebung NICHT möglich. Es läuft nur der Random-Control (#3), der');
    console.log('  beweist, dass das Gate untrainierte Gewichte ZUVERLÄSSIG DURCHFALLEN LÄSST.');
    console.log(`  Erwartete Pfade: ${REAL_4STEM} bzw. ${SMOKE_CKPT} in einem von: ${CHECKPOINT_DIRS.join(', ')}`);
    console.log('  Smoke-Checkpoint trainieren: npm run stems:smoke:train');
  }

  // ---- 3. Random-Control: Gate muss FALLEN ----------------------------------
  const randomControlEnabled = mode.kind === 'real' ? process.env.AIRODOX_GATE_RANDOM_CONTROL === '1' : true;
  if (randomControlEnabled) {
    console.log('\n[ TEST ] #3 Random-Control: dieselbe Architektur mit Zufallsgewichten muss DURCHFALLEN');
    const controlStore = path.join(root, 'models-control');
    await mkdir(controlStore, { recursive: true });
    await copyFile(SMOKE_CONFIG_FIXTURE, path.join(controlStore, SMOKE_CONFIG));
    // Dummy-Checkpoint: der Adapter wertet ihn mit --allow-random-weights nie aus.
    await writeFile(path.join(controlStore, 'random-init.ckpt'), Buffer.from('random control – never loaded'));
    const controlDescriptor: ModelDescriptor = {
      ...fourStemDescriptor(),
      id: 'bsroformer-random-control',
      checkpoint: { file: 'random-init.ckpt', format: 'pytorch-ckpt' },
      config: { file: SMOKE_CONFIG, format: 'pytorch-ckpt' },
    };
    const controlBackend = new BSRoFormerSeparator({ ...separatorOptions, modelStoreDir: controlStore });
    const controlDir = path.join(root, 'out-random');
    await mkdir(controlDir, { recursive: true });
    const controlResponse = await controlBackend.separate(
      baseRequest({
        descriptor: controlDescriptor,
        workingWavPath: slicePath,
        outputDir: controlDir,
        frames: track.frames,
        extras: { allowRandomWeights: true },
      })
    );
    assert.equal(controlResponse.report?.weights, 'random', 'Control-Lauf muss weights=random melden');
    const controlEstimates = new Map<string, Float32Array>();
    for (const stem of controlResponse.stems) {
      const decoded = await readWavFile(stem.filePath);
      controlEstimates.set(stem.name, decoded.data);
    }
    const randomReport = evaluateStemIsolation({
      estimates: controlEstimates,
      groundTruth: track.stems,
      mixture: track.mix,
      channels: 2,
      modelId: 'bsroformer-random-control',
      weights: 'random',
      trackSeconds: track.seconds,
      thresholds,
      notes: ['Development-only-Lauf (--allow-random-weights): kein Training, reine Diskriminierungsprobe.'],
    });
    const randomPath = await writeIsolationReport(randomReport, root, 'isolation-gate-random');
    printReport(randomReport);
    console.log(`  ✓ Random-Report: ${randomPath}`);
    assert.equal(randomReport.pass, false, 'Gate darf Zufallsgewichten niemals durchlassen');
    if (trainedReport) {
      // Diskriminierung pro Stem: der trainierte Isolationsgewinn muss den
      // Zufalls-Isolationsgewinn JEDES Stems deutlich schlagen (absolute
      // SI-SDR wäre hier das falsche Mass, siehe Alternative-Klausel oben).
      for (const trainedStem of trainedReport.stems) {
        const randomStem = randomReport.stems.find((stem) => stem.stem === trainedStem.stem);
        assert.ok(randomStem, `Random-Control muss ${trainedStem.stem} enthalten`);
        const margin = trainedStem.isolationGainDb - randomStem.isolationGainDb;
        assert.ok(
          margin >= 3,
          `Isolationsgewinn ${trainedStem.stem}: trainiert ${trainedStem.isolationGainDb.toFixed(2)} dB vs. ` +
            `zufällig ${randomStem.isolationGainDb.toFixed(2)} dB — Abstand ${margin.toFixed(2)} dB < 3 dB`
        );
        console.log(
          `  ✓ ${trainedStem.stem.padEnd(7)} Gain trainiert ${trainedStem.isolationGainDb.toFixed(2)} dB vs. ` +
            `zufällig ${randomStem.isolationGainDb.toFixed(2)} dB (Abstand ${margin.toFixed(1)} dB)`
        );
      }
    }
  }

  // ---- 4. Original bleibt unangetastet --------------------------------------
  console.log('\n[ TEST ] #4 Original bleibt während aller Gate-Läufe unverändert');
  const hashAfter = await sha256File(written.mixPath);
  assert.equal(hashAfter, hashBefore, 'Original wurde verändert');
  console.log(`  ✓ sha256 unverändert (${hashAfter.slice(0, 16)}…)`);

  console.log('\n✔ TEIL 2 abgeschlossen – Berichte im Arbeitsverzeichnis:');
  console.log(`  ${root}`);
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exitCode = 1;
});
