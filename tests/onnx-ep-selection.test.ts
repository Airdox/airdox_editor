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
  OnnxSeparator,
  disposeWarmSessions,
  normaliseExecutionProvider,
  resetSharedOnnxRuntime,
  selectExecutionProviders,
  resolveOnnxModelPath,
  segmentSamplesFromMetadata,
  packSegment,
  stemRowsFor,
  describeProviderPlan,
  type OnnxRuntimeLike,
  type OnnxTensorLike,
} from '../src/stems/backends/onnxSeparator';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemSeparationError } from '../src/stems/errors';
import type { BackendSeparationRequest } from '../src/stems/backends/types';
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

  // ---- #7: GPU-Treiberabsturz zur Laufzeit -> CPU-Ausweg ------------------
  // Reproduziert den Produktionsfehler DXGI 887A0020 (DRIVER_INTERNAL_ERROR):
  // Die DirectML-Session lässt sich bauen, aber `session.run` kippt mitten im
  // Job. Erwartung: Kette wird gesperrt, das Segment auf CPU wiederholt, der
  // Job endet mit exaktem Ergebnis statt INFERENCE_FAILED.
  console.log('\n[ TEST ] #7 GPU-Absturz mitten im Lauf: Segment-Wiederholung auf CPU, sample-genaues Ergebnis');
  {
    await disposeWarmSessions();
    await resetSharedOnnxRuntime();

    const SEG = 4096; // >= 2 × MIN_OVERLAP_SAMPLES (Pflichtgröße von planChunks)
    const GAINS = [0.5, 0.3, 0.15, 0.05];
    const descriptor = {
      id: 'fake-gpu-crash',
      family: 'htdemucs',
      architecture: 'FakeGraph',
      version: 'test',
      checkpoint: { file: 'fake.onnx', format: 'onnx' as const },
      sampleRate: 44100,
      inputChannels: 2,
      outputStems: ['drums', 'bass', 'other', 'vocals'],
      stemOrder: ['drums', 'bass', 'other', 'vocals'],
      chunkSizeSamples: SEG,
      backendSupport: ['onnx' as const],
    } as unknown as ModelDescriptor;

    const makeRuntime = (opts: { crashAfterDmlRuns: number; cpuCrashes?: boolean }) => {
      const counters = { creates: [] as string[][], dmlRuns: 0, cpuRuns: 0 };
      const runtime = {
        listSupportedBackends: () => [
          { name: 'dml', bundled: true },
          { name: 'cpu', bundled: true },
        ],
        Tensor: class {
          constructor(readonly type: 'float32', readonly data: Float32Array, readonly dims: readonly number[]) {}
        },
        InferenceSession: {
          create: async (_modelPath: string, options?: Record<string, unknown>) => {
            const providers = (options?.executionProviders as string[]) ?? ['cpu'];
            counters.creates.push(providers);
            const gpu = providers[0] !== 'cpu';
            return {
              inputNames: ['mix'],
              outputNames: ['stems'],
              inputMetadata: [{ name: 'mix', type: 'tensor(float)', shape: [1, 2, SEG] }],
              outputMetadata: [{ name: 'stems', type: 'tensor(float)', shape: [1, 4, 2, SEG] }],
              run: async (feeds: Record<string, OnnxTensorLike>) => {
                if (gpu) {
                  counters.dmlRuns += 1;
                  if (counters.dmlRuns > opts.crashAfterDmlRuns) {
                    throw new Error(
                      'onnxruntime.dll DmlCommandRecorder.cpp(371) Exception(3) 887A0020 DXGI_ERROR_DRIVER_INTERNAL_ERROR (Test-Fake)'
                    );
                  }
                } else {
                  counters.cpuRuns += 1;
                  if (opts.cpuCrashes) throw new Error('CPU-Kernel ebenfalls defekt (Test-Fake)');
                }
                // Deterministischer „Export“: Zeile i = mix * GAINS[i] (wie das Tiny-Fixture).
                const mix = feeds['mix'].data;
                const stems = new Float32Array(4 * mix.length);
                for (let row = 0; row < 4; row += 1) {
                  for (let i = 0; i < mix.length; i += 1) stems[row * mix.length + i] = mix[i] * GAINS[row];
                }
                return { stems: { data: stems, dims: [1, 4, 2, SEG], type: 'float32' } as OnnxTensorLike };
              },
            };
          },
        },
      } as unknown as OnnxRuntimeLike;
      return { runtime, counters };
    };

    const makeMix = (frames: number): Float32Array => {
      const data = new Float32Array(frames * 2);
      for (let frame = 0; frame < frames; frame += 1) {
        data[frame * 2] = 0.6 * Math.sin((2 * Math.PI * 220 * frame) / 44100);
        data[frame * 2 + 1] = 0.4 * Math.sin((2 * Math.PI * 400 * frame) / 44100 + 0.3);
      }
      return data;
    };

    const makeSeparator = (runtime: OnnxRuntimeLike, storeDir: string) =>
      new OnnxSeparator({ modelStoreDir: storeDir, loadRuntime: async () => runtime, family: 'htdemucs' });

    const frames = SEG * 2 + 100; // drei Segmente bei 25 % Überlappung
    const mix = makeMix(frames);
    const makeRequest = (onProgress?: (fraction: number, phase: string) => void): BackendSeparationRequest => ({
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
      device: 'directml',
      profile: 'PREVIEW',
      onProgress,
    });

    // (a) Absturz beim zweiten Segment: Segment 1 lief auf DML, Rest auf CPU –
    //     zusammengesetzt muss das Ergebnis exakt mix*gain bleiben.
    const notes: string[] = [];
    const fakeA = makeRuntime({ crashAfterDmlRuns: 1 });
    const separatorA = makeSeparator(fakeA.runtime, '/virtual-store/crash-a');
    const response = await separatorA.separate(makeRequest((_f, phase) => notes.push(phase)));
    assert.equal(response.device, 'cpu', 'nach Treiberabsturz muss das Ergebnis von der CPU kommen');
    assert.equal(response.cpuFallback, true, 'der Absturz-Ausweg muss gemeldet werden');
    assert.ok(String(response.report?.gpuCrash).includes('887A0020'), 'Report muss den Treiberfehler nennen');
    assert.equal(response.inlineStems?.length, 4);
    let worst = 0;
    for (const stem of response.inlineStems!) {
      const gain = GAINS[descriptor.stemOrder.indexOf(stem.name)];
      for (let i = 0; i < stem.samples.length; i += 1) worst = Math.max(worst, Math.abs(stem.samples[i] - mix[i] * gain));
    }
    assert.ok(worst < 1e-6, `DML- und CPU-Segmente müssen sample-genau zusammenpassen (Abweichung ${worst})`);
    assert.equal(fakeA.counters.dmlRuns, 2, 'ein DML-Lauf erfolgreich, einer abgestürzt');
    assert.equal(fakeA.counters.cpuRuns, 2, 'Segment 2 (wiederholt) + Segment 3 liefen auf CPU');
    assert.equal(fakeA.counters.creates.filter((p) => p[0] !== 'cpu').length, 1, 'genau eine GPU-Session gebaut');
    assert.ok(notes.some((n) => n.includes('wiederhole Segment 2')), `Fortschritt muss die Wiederholung erklären: ${notes.join(' | ')}`);
    console.log('  ✓ 1 DML-Segment + Absturz -> CPU wiederholt, Gesamtergebnis sample-genau, cpuFallback + gpuCrash gemeldet');

    // (b) Zweiter Job: die abgestürzte Kette ist gesperrt – kein GPU-Versuch mehr.
    const second = await separatorA.separate(makeRequest());
    assert.equal(second.device, 'cpu');
    assert.equal(second.cpuFallback, true, 'explizit angefordertes DirectML mit gesperrter Kette ist ein Rückfall');
    assert.equal(fakeA.counters.dmlRuns, 2, 'kein erneuter GPU-Lauf nach dem Absturz');
    assert.equal(fakeA.counters.creates.filter((p) => p[0] !== 'cpu').length, 1, 'kein erneuter GPU-Sessionbau nach Absturz');
    console.log(`  ✓ Folge-Job geht direkt auf CPU (${fakeA.counters.creates.length} Session-Bauten gesamt, davon GPU: 1)`);

    // (c) Kippt auch die CPU, bleibt INFERENCE_FAILED sprechend – mit beiden Ursachen.
    const fakeC = makeRuntime({ crashAfterDmlRuns: 0, cpuCrashes: true });
    const separatorC = makeSeparator(fakeC.runtime, '/virtual-store/crash-c');
    await assert.rejects(
      separatorC.separate(makeRequest()),
      (error: unknown) => {
        assert.ok(error instanceof StemSeparationError && error.code === 'INFERENCE_FAILED', `INFERENCE_FAILED erwartet, war: ${error}`);
        assert.ok(error.message.includes('887A0020'), 'Fehlertext muss den GPU-Absturz nennen');
        assert.ok(error.message.includes('CPU-Kernel'), 'Fehlertext muss auch das Scheitern des CPU-Auswegs nennen');
        return true;
      }
    );
    console.log('  ✓ CPU-Ausweg scheitert ebenfalls -> INFERENCE_FAILED mit GPU- und CPU-Ursache');

    await disposeWarmSessions();
    await resetSharedOnnxRuntime();
  }

  console.log('\n✔ ONNX EP-SELECTION + SEGMENT-PACKING: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
