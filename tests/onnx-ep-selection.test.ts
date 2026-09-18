/**
 * ONNX-Pfad, Teil 1: Entscheidungen ohne ONNX Runtime.
 *
 * Alles, was vor dem ersten `session.run` passiert, ist reine Logik und wird
 * hier ohne Binary geprüft: Execution-Provider-Reihenfolge je Gerät/Plattform,
 * Modellpfad-Auflösung, Segmentlänge aus der Graph-Metadaten, Zero-Padding des
 * letzten Segments und die Stem-Reihenfolge des Graphen.
 *
 * Teil 2 (`onnx-separator-inmemory`) fährt dieselbe Pipeline dann mit einer
 * echten onnxruntime-node-Session.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normaliseExecutionProvider,
  selectExecutionProviders,
  resolveOnnxModelPath,
  segmentSamplesFromMetadata,
  packSegment,
  stemRowsFor,
  describeProviderPlan,
} from '../src/stems/backends/onnxSeparator';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemSeparationError } from '../src/stems/errors';
import type { ModelDescriptor } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ONNX EXECUTION PROVIDERS + SEGMENT-PACKING (ohne Binary)      ');
console.log('═══════════════════════════════════════════════════════════════════');

const WIN_BUNDLED = { dml: true, cpu: true, webgpu: true, cuda: false, tensorrt: false };
const LINUX_BUNDLED = { cpu: true, webgpu: true, cuda: false, tensorrt: false };

async function run() {
  // ---- #1: Provider-Aliase -------------------------------------------------
  console.log('\n[ TEST ] #1 Provider-Namen normalisieren');
  assert.equal(normaliseExecutionProvider('DirectML'), 'dml');
  assert.equal(normaliseExecutionProvider('DmlExecutionProvider'), 'dml');
  assert.equal(normaliseExecutionProvider('CUDAExecutionProvider'), 'cuda');
  assert.equal(normaliseExecutionProvider('CoreML'), 'coreml');
  assert.equal(normaliseExecutionProvider('CPU'), 'cpu');
  console.log('  ✓ DirectML/DmlExecutionProvider -> dml, CUDA… -> cuda, CoreML -> coreml');

  // ---- #2: Auswahl je Gerät und Plattform ---------------------------------
  console.log('\n[ TEST ] #2 GPU-Pfad wird gewählt, CPU bleibt immer letzter Ausweg');
  const windowsAuto = selectExecutionProviders({ requested: 'auto', platform: 'win32', supported: Object.keys(WIN_BUNDLED), bundled: WIN_BUNDLED });
  assert.equal(windowsAuto[0], 'dml', `Windows auto muss DirectML zuerst nehmen, war: ${windowsAuto.join(',')}`);
  assert.equal(windowsAuto.at(-1), 'cpu');
  const macAuto = selectExecutionProviders({ requested: 'auto', platform: 'darwin', supported: ['cpu', 'coreml', 'webgpu'], bundled: { coreml: true, cpu: true } });
  assert.equal(macAuto[0], 'coreml');
  const linuxAuto = selectExecutionProviders({ requested: 'auto', platform: 'linux', supported: Object.keys(LINUX_BUNDLED), bundled: LINUX_BUNDLED });
  assert.deepEqual(linuxAuto, ['cpu'], 'ohne installiertes CUDA darf Linux nicht CUDA versprechen');
  const linuxCuda = selectExecutionProviders({ requested: 'cuda', platform: 'linux', supported: Object.keys(LINUX_BUNDLED), bundled: LINUX_BUNDLED });
  assert.deepEqual(linuxCuda, ['cuda', 'tensorrt', 'cpu'], 'explizit angefordertes CUDA wird versucht (postinstall-Binaries)');
  assert.deepEqual(selectExecutionProviders({ requested: 'cpu', platform: 'win32', supported: Object.keys(WIN_BUNDLED), bundled: WIN_BUNDLED }), ['cpu'], 'cpu erzwingt CPU');
  assert.deepEqual(selectExecutionProviders({ requested: 'directml', platform: 'win32', supported: Object.keys(WIN_BUNDLED), bundled: WIN_BUNDLED }), ['dml', 'cpu']);
  assert.deepEqual(describeProviderPlan('auto'), describeProviderPlan());
  console.log(`  ✓ win32/auto -> ${windowsAuto.join(' > ')}`);
  console.log(`  ✓ darwin/auto -> ${macAuto.join(' > ')}, linux/auto -> ${linuxAuto.join(' > ')}`);

  // ---- #3: Runtime-Report ohne listSupportedBackends ----------------------
  console.log('\n[ TEST ] #3 Ohne Runtime-Report greift die Plattformordnung');
  const blind = selectExecutionProviders({ requested: 'auto', platform: 'win32' });
  assert.equal(blind[0], 'dml');
  assert.equal(blind.at(-1), 'cpu');
  console.log(`  ✓ ohne Backend-Liste -> ${blind.join(' > ')}`);

  // ---- #4: Modellpfad + Segmentlänge --------------------------------------
  console.log('\n[ TEST ] #4 Modellpfad und Segmentlänge kommen aus Deskriptor + Graph');
  const registry = ModelRegistry.fromBundledCatalog();
  const onnxModel = registry.get('htdemucs-onnx-4stem-fp16')!;
  assert.ok(onnxModel, 'Katalog muss das ONNX-Performancemodell führen');
  assert.equal(onnxModel.checkpoint.format, 'onnx');
  assert.equal(onnxModel.chunkSizeSamples, 343980, '7,8 s bei 44,1 kHz – feste Eingangslänge des HT-Demucs-Graphen');
  assert.deepEqual(onnxModel.stemOrder, ['drums', 'bass', 'other', 'vocals']);
  assert.equal(path.resolve(resolveOnnxModelPath(onnxModel, '/models')), path.resolve('/models/htdemucs_fp16weights.onnx'));
  const absolute = { ...onnxModel, checkpoint: { ...onnxModel.checkpoint, file: '/etc/passwd' } };
  assert.throws(() => resolveOnnxModelPath(absolute, '/models'), (error: unknown) => error instanceof StemSeparationError && error.code === 'MODEL_MISSING');
  assert.equal(segmentSamplesFromMetadata([{ name: 'mix', shape: [1, 2, 343980] }]), 343980);
  assert.equal(segmentSamplesFromMetadata([{ name: 'mix', shape: [1, 2, 'N'] }]), undefined, 'dynamische Achse -> keine feste Segmentlänge');
  assert.equal(segmentSamplesFromMetadata(undefined), undefined);
  console.log(`  ✓ ${onnxModel.checkpoint.file}, Segment ${onnxModel.chunkSizeSamples} Samples`);

  // ---- #5: Segment-Packing inkl. Zero-Padding -----------------------------
  console.log('\n[ TEST ] #5 Letztes Segment wird gepaddet, nicht gekürzt');
  const channels = 2;
  const segment = 8;
  const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // 5 Frames
  const padded = packSegment({ samples, startFrame: 2, frames: 3, channels, segmentSamples: segment });
  assert.equal(padded.length, segment * channels);
  assert.deepEqual([...padded.slice(0, 6)], [5, 6, 7, 8, 9, 10], 'Frames 2..4 gehören an den Anfang');
  assert.deepEqual([...padded.slice(6)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Rest ist exakt null');
  const longSamples = new Float32Array(Array.from({ length: segment * channels }, (_, i) => i + 1));
  const full = packSegment({ samples: longSamples, startFrame: 0, frames: segment, channels, segmentSamples: segment });
  assert.deepEqual([...full], [...longSamples], 'volles Segment ohne Padding');
  const target = new Float32Array(segment * channels).fill(9);
  const reused = packSegment({ samples, startFrame: 0, frames: 5, channels, segmentSamples: segment, target });
  assert.equal(reused, target, 'Puffer wird wiederverwendet (keine Allokation pro Segment)');
  assert.deepEqual([...target.slice(10)], new Array(6).fill(0), 'Wiederverwendung räumt den Rest auf');
  console.log('  ✓ Padding, Trimming und Puffer-Wiederverwendung stimmen');

  // ---- #6: Stem-Reihenfolge aus dem Deskriptor ----------------------------
  console.log('\n[ TEST ] #6 Graph-Reihenfolge wird über stem_order aufgelöst');
  const rows = stemRowsFor(onnxModel, ['vocals', 'drums']);
  assert.deepEqual(rows, [{ stem: 'vocals', outputIndex: 3 }, { stem: 'drums', outputIndex: 0 }]);
  // Ein Modell mit anderer Reihenfolge im Graphen darf nicht falsch gelabelt werden:
  const swapped = { ...onnxModel, stemOrder: ['vocals', 'drums', 'bass', 'other'] } as ModelDescriptor;
  assert.deepEqual(stemRowsFor(swapped, ['vocals']), [{ stem: 'vocals', outputIndex: 0 }]);
  assert.throws(() => stemRowsFor(onnxModel, ['guitar']), (error: unknown) => error instanceof StemSeparationError && error.code === 'STEM_CONFIG_INVALID');
  console.log('  ✓ vocals -> Zeile 3 (Originalreihenfolge), Fehler bei unbekanntem Stem');

  console.log('\n✔ ONNX EP-SELECTION + SEGMENT-PACKING: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
