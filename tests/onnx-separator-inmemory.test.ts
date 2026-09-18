// @requires: onnxruntime
/**
 * ONNX-Pfad, Teil 2: echte onnxruntime-node-Session, echt in-memory.
 *
 * Das Fixture `tests/fixtures/onnx/tiny-stem-separator.onnx` hat exakt die
 * I/O-Signatur des HT-Demucs-ONNX-Exports (mix [1,2,N] → stems [1,4,2,N],
 * Reihenfolge drums/bass/other/vocals) und ist deterministisch:
 * `stems[i] = mix * gain[i]` mit gain = [0.5, 0.3, 0.15, 0.05].
 *
 * Damit prüfbar, ohne 166 MB zu laden:
 *   #1 Session lädt, Segmentlänge kommt aus dem Graphen,
 *   #2 die Segment-Overlap-Add-Rekonstruktion ergibt über alle Segmente genau
 *      `mix * gain` – inklusive der Datei-Ränder (kein Klick, kein Verlust),
 *   #3 der Engine-Pfad schreibt **keine** Chunk-Dateien (zero disk I/O),
 *   #4 Stem-Vertauschung wird erkannt statt still falsch gelabelt,
 *   #5 fast_dj validiert ohne Grenzmetriken, studio_master misst sie.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OnnxSeparator, describeProviderPlan, warmSessionCount, disposeWarmSessions, type OnnxRuntimeLike } from '../src/stems/backends/onnxSeparator';
import { StemSeparationEngine } from '../src/stems/stemSeparationEngine';
import { StemJobService } from '../src/stems/stemJobService';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { encodeWavFloat32, readWavFile } from '../src/stems/wavIo';
import { writeFile, mkdir } from 'node:fs/promises';
import type { ModelDescriptor } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ONNX IN-MEMORY PIPELINE – echte Session, echte Rekonstruktion  ');
console.log('═══════════════════════════════════════════════════════════════════');

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'onnx', 'tiny-stem-separator.onnx');
const GAINS: Record<number, number> = { 0: 0.5, 1: 0.3, 2: 0.15, 3: 0.05 };
const SEGMENT = 4096;

async function loadRuntime(): Promise<OnnxRuntimeLike> {
  const moduleName = 'onnxruntime-node';
  const loaded = (await import(/* @vite-ignore */ moduleName)) as unknown as OnnxRuntimeLike & { default?: OnnxRuntimeLike };
  return loaded?.InferenceSession ? loaded : (loaded.default as OnnxRuntimeLike);
}

async function makeDescriptor(): Promise<{ descriptor: ModelDescriptor; store: string; registry: ModelRegistry }> {
  const store = await mkdtemp(path.join(os.tmpdir(), 'onnx-store-'));
  const file = path.basename(FIXTURE);
  await writeFile(path.join(store, file), await (await import('node:fs/promises')).readFile(FIXTURE));
  const descriptor = {
    id: 'tiny-onnx-double',
    family: 'htdemucs',
    architecture: 'Testgraph',
    version: 'opset17-testgraph',
    checkpoint: { file, format: 'onnx' as const },
    sampleRate: 44100,
    inputChannels: 2,
    outputStems: ['drums', 'bass', 'other', 'vocals'],
    stemOrder: ['drums', 'bass', 'other', 'vocals'],
    stemDisplayNames: { drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals' },
    modelHash: 'unverified',
    license: 'MIT (Test-Fixture)',
    backendSupport: ['onnx' as const],
    precision: ['f32' as const],
    recommendedOverlap: 1,
    chunkSizeSamples: SEGMENT,
    qualityProfile: {
      serves: ['PREVIEW', 'BALANCED', 'HIGH'] as const,
      numOverlap: { PREVIEW: 1, BALANCED: 1, HIGH: 1 },
      rationale: 'Testgraph mit HT-Demucs-Signatur.',
    },
    notes: 'Nur für Tests.',
  } as unknown as ModelDescriptor;
  const registry = ModelRegistry.fromCatalog({ models: [descriptor] });
  return { descriptor, store, registry };
}

function makeMix(frames: number, channels = 2): Float32Array {
  const data = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame++) {
    data[frame * channels] = 0.6 * Math.sin((2 * Math.PI * 220 * frame) / 44100) + 0.2 * Math.sin((2 * Math.PI * 3000 * frame) / 44100);
    data[frame * channels + 1] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / 44100 + 0.4);
  }
  return data;
}

async function run() {
  const { descriptor, store, registry } = await makeDescriptor();
  const runtime = await loadRuntime();

  // ---- #1: Session + Segmentlänge aus dem Graphen -------------------------
  console.log('\n[ TEST ] #1 Session lädt, Segmentlänge kommt aus dem Graphen');
  const separator = new OnnxSeparator({ modelStoreDir: store, runtime, family: 'htdemucs' });
  const availability = await separator.isAvailable(descriptor);
  assert.equal(availability.available, true, availability.reason);
  const warm = await separator.warmUp(descriptor, 'cpu');
  assert.equal(warm.segmentSamples, SEGMENT, 'Segmentlänge muss aus inputMetadata kommen');
  assert.equal(warm.providers.at(-1), 'cpu');
  const providers = await separator.executionProviders(descriptor);
  assert.equal(providers.providers.at(-1), 'cpu', 'CPU muss immer als Ausweg drin bleiben');
  assert.ok(warmSessionCount() >= 1, 'Session bleibt warm');
  console.log(`  ✓ Session geladen, Segment ${warm.segmentSamples}, Provider ${providers.providers.join(' > ')}`);

  // ---- #2: Overlap-Add über mehrere Segmente ------------------------------
  console.log('\n[ TEST ] #2 Rekonstruktion über Segmentgrenzen stimmt sample-genau');
  const frames = SEGMENT * 3 + 777; // drei volle Segmente + Rest
  const mix = makeMix(frames);
  const response = await separator.separate({
    descriptor,
    workingWavPath: '',
    workingSamples: mix,
    sampleRate: 44100,
    channels: 2,
    outputDir: '',
    startSample: 0,
    frames,
    stems: ['drums', 'bass', 'other', 'vocals'],
    chunkIndex: 0,
    chunkCount: 1,
    numOverlap: 1,
    ensemblePasses: 1,
    precision: 'f32',
    device: 'cpu',
    profile: 'PREVIEW',
  });
  assert.equal(response.stems.length, 0, 'in-memory: keine Dateien');
  assert.equal(response.inlineStems?.length, 4, 'vier Stems inline');
  assert.equal(response.report?.zeroDiskChunks, true);
  for (const stem of response.inlineStems!) {
    const index = descriptor.stemOrder.indexOf(stem.name);
    assert.ok(index >= 0);
    assert.equal(stem.frames, frames, `${stem.name}: volle Länge`);
    assert.equal(stem.samples.length, frames * 2);
    let worst = 0;
    for (let i = 0; i < stem.samples.length; i++) worst = Math.max(worst, Math.abs(stem.samples[i] - mix[i] * GAINS[index]));
    assert.ok(worst < 1e-6, `${stem.name}: Abweichung ${worst} (Segment-Overlap-Add fehlerhaft)`);
  }
  // Randprüfung: der letzte Frame ist gepaddet worden und darf nicht kippen.
  const lastFrameEnergy = Math.abs(response.inlineStems![0].samples.at(-1)!) + Math.abs(response.inlineStems![0].samples.at(-2)!);
  assert.ok(lastFrameEnergy > 1e-6, 'letzter Frame darf nicht auf 0 fallen');
  console.log(`  ✓ 4 Stems × ${frames} Frames rekonstruiert, max. Abweichung < 1e-6, Tail gepaddet`);
  assert.equal(warmSessionCount() >= 1, true);
  await disposeWarmSessions();

  // ---- #3: Der Engine-Pfad schreibt keine Chunk-Dateien -------------------
  console.log('\n[ TEST ] #3 Engine-Pfad: kein Chunk-WAV, kein Output-Verzeichnis');
  const root = await mkdtemp(path.join(os.tmpdir(), 'onnx-engine-'));
  const inputDir = path.join(root, 'Eingang');
  await mkdir(inputDir, { recursive: true });
  const inputPath = path.join(inputDir, 'mix.wav');
  await writeFile(inputPath, encodeWavFloat32(44100, 2, mix, frames));

  const engine = new StemSeparationEngine({
    registry,
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'Cache'),
    modelStoreDir: store,
    mode: 'fast_dj',
    backendFactory: {
      candidates: () => [new OnnxSeparator({ modelStoreDir: store, runtime, family: 'htdemucs' })],
    },
  });
  const summary = await engine.separate({ inputPath, modelId: descriptor.id, profile: 'PREVIEW', trackName: 'mix' });
  assert.equal(summary.status, 'COMPLETED');
  assert.equal(summary.stems.length, 4);
  // Der Chunk-Ordner entsteht für in-memory Backends erst gar nicht.
  const workingEntries = await readdir(path.join(root, 'Working')).catch(() => [] as string[]);
  const chunkDirExists = await stat(path.join(workingEntries.length ? path.join(root, 'Working') : root, 'chunks')).then(() => true).catch(() => false);
  assert.equal(chunkDirExists, false, 'kein chunk-Verzeichnis im Working-Root');
  for (const stem of summary.stems) {
    assert.ok((await stat(stem.filePath)).size > 44, `${stem.id}.wav muss als Produkt existieren`);
  }
  const jobDir = path.dirname(summary.stems[0].filePath);
  const files = (await readdir(jobDir)).sort();
  assert.deepEqual(files.filter((name) => name.endsWith('.wav')), ['bass.wav', 'drums.wav', 'other.wav', 'vocals.wav'], 'nur die vier Produktdateien');
  assert.equal(files.some((name) => name.startsWith('chunk_')), false, 'keine Chunk-WAVs');
  assert.equal(files.some((name) => name.startsWith('out_')), false, 'keine per-Chunk-Ausgabeordner');
  const drums = await readWavFile(path.join(jobDir, 'drums.wav'));
  assert.equal(drums.frames, frames);
  console.log(`  ✓ nur ${files.join(', ')} – 0 Chunk-Dateien, 4 Produktdateien`);

  // ---- #4: Stem-Vertauschung fällt auf -----------------------------------
  console.log('\n[ TEST ] #4 Falsche Stem-Namen werden abgelehnt, nicht geraten');
  await assert.rejects(
    separator.separate({
      descriptor,
      workingWavPath: '',
      workingSamples: mix,
      sampleRate: 44100,
      channels: 2,
      outputDir: '',
      startSample: 0,
      frames,
      stems: ['guitar'],
      chunkIndex: 0,
      chunkCount: 1,
      numOverlap: 1,
      ensemblePasses: 1,
      precision: 'f32',
      device: 'cpu',
      profile: 'PREVIEW',
    }),
    /STEM_CONFIG_INVALID|nicht geliefert/
  );
  console.log('  ✓ unbekannter Stem -> STEM_CONFIG_INVALID');

  // ---- #5: fast_dj vs. studio_master -------------------------------------
  console.log('\n[ TEST ] #5 fast_dj validiert schlank, studio_master misst die Grenzen');
  const fastRoot = await mkdtemp(path.join(os.tmpdir(), 'onnx-fast-'));
  const makeService = (mode: 'fast_dj' | 'studio_master', target: string) =>
    new StemJobService({
      root: target,
      registry,
      mode,
      // Der Model-Store ist der des Fixtures (nicht <root>/Models), damit die
      // Testinstanz nicht 166 MB Gewichte braucht.
      modelStoreDir: store,
      backendFactory: { candidates: () => [new OnnxSeparator({ modelStoreDir: store, runtime, family: 'htdemucs' })] },
    });
  const fastService = makeService('fast_dj', fastRoot);
  const started = Date.now();
  const job = await fastService.start({ inputPath, profile: 'PREVIEW', trackName: 'mix' });
  const finished = await fastService.waitFor(job.jobId);
  const fastMs = Date.now() - started;
  assert.equal(finished.status, 'COMPLETED');
  const view = fastService.getJob(job.jobId);
  assert.equal(view?.result?.stems.length, 4, 'der Transport liefert vier fertige Stems');
  assert.equal(view?.result?.stems.some((stem) => stem.sha256.length === 0), false, 'jeder Stem hat eine Prüfsumme');
  const summaryFast = await fastService.engine.separate({ inputPath, modelId: descriptor.id, profile: 'PREVIEW', mode: 'fast_dj', trackName: 'fast' });
  assert.equal(summaryFast.validation?.mode, 'fast_dj');
  assert.equal(summaryFast.validation?.continuity, null, 'fast_dj misst keine Grenzkontinuität');
  assert.equal(summaryFast.validation?.recombinationErrorDb, null, 'fast_dj misst keine Rekombination');
  assert.equal(summaryFast.validation?.pass, true);
  const summaryStrict = await fastService.engine.separate({ inputPath, modelId: descriptor.id, profile: 'PREVIEW', mode: 'studio_master', trackName: 'strict' });
  assert.equal(summaryStrict.validation?.mode, 'studio_master');
  assert.notEqual(summaryStrict.validation?.continuity, null, 'studio_master liefert die Grenzmetriken');
  assert.equal(typeof summaryStrict.validation?.recombinationErrorDb, 'number');
  console.log(`  ✓ fast_dj: continuity=null (nicht gemessen), studio_master: excessDb=${summaryStrict.validation?.continuity?.excessDb.toFixed(1)} dB`);
  console.log(`  ✓ UI-Job über den Service: ${finished.status} in ${fastMs} ms (Provider ${describeProviderPlan('cpu').join('>')})`);

  console.log('\n✔ ONNX IN-MEMORY PIPELINE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
