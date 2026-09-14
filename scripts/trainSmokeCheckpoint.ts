/**
 * Trains the EDMSMOKE checkpoint for the Stem Isolation Gate (TEIL 2).
 *
 * Pipeline:
 *   1. Generate a small synthetic EDM dataset (mix + 4 ground truth stems)
 *      with `generateEdmTestTrack` – seeds are DISJOINT from the evaluation
 *      track's seed, so the gate measures generalisation, not memorisation.
 *   2. Train the tiny architecture from `edmsmoke_bs_roformer.yaml` with
 *      `python/train_smoke_checkpoint.py` (plain CPU, minutes not hours).
 *   3. Install checkpoint + config into the model store so the production
 *      adapter and `test:stems:gate` pick them up.
 *
 * The result is a SMOKE checkpoint on SYNTHETIC data: it proves the trained
 * path end-to-end (weights="checkpoint", real SI-SDR above random) but is NOT
 * the MUSDB18-HQ production model. See the fixture header for details.
 *
 * Usage: npm run stems:smoke:train  [env: AIRODOX_SMOKE_STEPS=250]
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';

const REPO_ROOT = process.cwd();
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'tests/fixtures/bsroformer/edmsmoke_bs_roformer.yaml');
const TRAINER = path.join(REPO_ROOT, 'python/train_smoke_checkpoint.py');
const STEM_HOME = process.env.AIRODOX_STEM_HOME ?? path.join(os.homedir(), '.cache', 'airdox-stems');
const DATA_DIR = path.join(STEM_HOME, 'edmsmoke-data');
const CHECKPOINT_DIR = process.env.AIRODOX_STEM_CHECKPOINT_DIR ?? path.join(STEM_HOME, 'checkpoints');
const CHECKPOINT_NAME = 'model_bs_roformer_edmsmoke.ckpt';
/** The gate test evaluates seed 0xede2 – training seeds MUST NOT contain it. */
const EVAL_SEED = 0xede2;
/** Different bpm values force actual source separation instead of one learned loop. */
const DATASET_SPEC = [
  { seed: 0xa11ce, seconds: 12, bpm: 122 },
  { seed: 0xb0b, seconds: 12, bpm: 128 },
  { seed: 0xcafe, seconds: 12, bpm: 124 },
  { seed: 0xd00d, seconds: 12, bpm: 130 },
  { seed: 0x5157, seconds: 12, bpm: 126 },
  { seed: 0x2badd, seconds: 12, bpm: 120 },
  { seed: 0x3ffe, seconds: 12, bpm: 132 },
  { seed: 0x4711, seconds: 12, bpm: 118 },
];

async function prepareDataset(): Promise<void> {
  console.log(`[1/3] Dataset nach ${DATA_DIR}`);
  await mkdir(DATA_DIR, { recursive: true });
  const samples: Array<{ mix: string; stems: Record<string, string> }> = [];
  for (const spec of DATASET_SPEC) {
    if (spec.seed === EVAL_SEED) throw new Error(`Trainings-Seed kollidiert mit Eval-Seed: ${spec.seed}`);
    const track = generateEdmTestTrack({ ...spec, sampleRate: 44100 });
    const written = await writeTestAudio(DATA_DIR, `sample_${spec.seed.toString(16)}`, track);
    const stems: Record<string, string> = {};
    for (const [stemId, stemPath] of written.stemPaths) stems[stemId] = stemPath;
    samples.push({ mix: written.mixPath, stems });
    console.log(`  ✓ sample_${spec.seed.toString(16)}: ${track.seconds}s @ ${track.meta.bpm} BPM`);
  }
  await writeFile(
    path.join(DATA_DIR, 'manifest.json'),
    JSON.stringify({ format: 'edmsmoke-v1', samples }, null, 2),
    'utf8'
  );
}

async function main(): Promise<void> {
  await prepareDataset();

  const steps = Number(process.env.AIRODOX_SMOKE_STEPS ?? 250);
  const outPath = path.join(CHECKPOINT_DIR, CHECKPOINT_NAME);
  console.log(`\n[2/3] Training (${steps} Schritte, CPU)`);
  const resumeArgs = process.env.AIRODOX_SMOKE_RESUME && steps > 0 ? ['--start-checkpoint', outPath] : [];
  const result = spawnSync(
    process.env.AIRODOX_STEM_PYTHON ?? 'python3',
    [
      TRAINER,
      '--config', FIXTURE_CONFIG,
      '--reference-source-dir', path.join(STEM_HOME, 'vendor', 'msst'),
      '--data-dir', DATA_DIR,
      '--steps', String(steps),
      '--chunk-size', String(process.env.AIRODOX_SMOKE_CHUNK ?? 65536),
      '--seed', '1234',
      '--out', outPath,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (result.status !== 0) {
    throw new Error(`Training fehlgeschlagen (exit ${result.status}).`);
  }

  console.log(`\n[3/3] Checkpoint installieren nach ${CHECKPOINT_DIR}`);
  await mkdir(CHECKPOINT_DIR, { recursive: true });
  await copyFile(FIXTURE_CONFIG, path.join(CHECKPOINT_DIR, path.basename(FIXTURE_CONFIG)));
  console.log(`  ✓ ${outPath}`);
  console.log(`  ✓ ${path.join(CHECKPOINT_DIR, path.basename(FIXTURE_CONFIG))}`);
  console.log('\n✔ EDMSMOKE-Checkpoint bereit. Gate laufen lassen: npm run test:stems:gate');
}

main().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exitCode = 1;
});
