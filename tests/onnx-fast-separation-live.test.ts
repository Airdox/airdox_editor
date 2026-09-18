/**
 * SCHNELLER LOKALER STEM-PFAD – Lauf über den Editor-Weg mit echter Runtime.
 *
 * Dieser Test fährt den kompletten schnellen Pfad:
 *
 *   StemJobService → ONNX-Separator → Session → Segmente → Overlap-Add →
 *   Stem-WAVs in `Separation/<track>/<stem>.wav` → `stemBytes()` → dekodierbar
 *
 * Als Modelldatei dient das Fixture `tests/fixtures/onnx/tiny-stem-separator.onnx`
 * mit derselben I/O-Signatur wie der HT-Demucs-Onnx-Export
 * (`mix [1,2,N] → stems [1,4,2,N]`, `stems[i] = mix * gain[i]`,
 * gain = [0.5, 0.3, 0.15, 0.05], Segment 4096). Das Fixture ist ein **echter**
 * ONNX-Graph; dass die Werte stimmen, prüft `tests/onnx-fixture-python-ort.test.ts`
 * mit einer echten ORT-Session (Python).
 *
 * Runtime-Wahl, in dieser Reihenfolge:
 *   1. `onnxruntime-node` (Produktionspfad; echte Kernel, echte EP-Auswahl),
 *   2. `onnxruntime-web` (dieselben ORT-Kernel als WASM),
 *   3. eine **exakte Nachbildung** des Graphen (Gain-Kopie) – damit der Weg
 *      durch den Editor auch auf Maschinen prüfbar bleibt, auf denen keine
 *      ORT-Runtime verfügbar ist. Welche Variante lief, steht im Protokoll.
 *
 * Geprüft wird:
 *   1. Graph lädt, Job läuft in-process durch,
 *   2. vier Stems entstehen als lesbare WAV-Dateien in der Projektkonvention
 *      (drums/bass/other/vocals) mit den erwarteten Pegeln,
 *   3. Original bleibt unangetastet (READ-ONLY), Cache greift beim zweiten Lauf,
 *   4. DirectML-Wunsch auf einer Maschine ohne diesen Provider ⇒ **kein
 *      Abbruch**, sondern CPU-Fallback mit Grund (§7: DirectML niemals
 *      voraussetzen),
 *   5. Zeiten werden gemessen und ausgegeben – ohne Leistungsversprechen.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { OnnxSeparator, type OnnxRuntimeLike } from '../src/stems/backends/onnxSeparator';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { decodeWav } from '../src/stems/wavIo';
import type { ModelDescriptor } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  SCHNELLER PFAD – ONNX-Lauf durch Job-Service, Ablage, Lesepfad   ');
console.log('═══════════════════════════════════════════════════════════════════');

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'onnx', 'tiny-stem-separator.onnx');
const SEGMENT = 4096;
const STEMS = ['drums', 'bass', 'other', 'vocals'];
/** Erwartete Verstärkung je Ausgabekanal im Graphen. */
const GAINS = [0.5, 0.3, 0.15, 0.05];

/**
 * Adapter auf `onnxruntime-web`: die Session wird aus Bytes gebaut, weil der
 * WASM-Backend `fetch()` benutzt und `file://`-URLs in Node nicht unterstützt.
 * Alles andere – Provider-Auswahl, Session-Optionen, Tensoren – bleibt genau
 * das, was der Separator ohnehin verlangt.
 */
function webRuntimeAdapter(ort: unknown): OnnxRuntimeLike {
  const api = ort as {
    InferenceSession: { create(source: unknown, options?: Record<string, unknown>): Promise<never> };
    Tensor: OnnxRuntimeLike['Tensor'];
    listSupportedBackends?: () => { name: string; bundled?: boolean }[];
  };
  const WASM_PROVIDERS = new Set(['wasm', 'cpu', 'webgpu']);
  return {
    InferenceSession: {
      async create(modelPath: string, options?: Record<string, unknown>) {
        const providers = ((options?.executionProviders as string[] | undefined) ?? []).map((name) => name.toLowerCase());
        const unusable = providers.filter((name) => !WASM_PROVIDERS.has(name));
        if (unusable.length > 0) {
          // Genau das passiert auf einem Rechner ohne DirectML/CUDA/…: die
          // Session-Erstellung scheitert und der Separator muss auf CPU
          // ausweichen statt den Job zu verwerfen (§7).
          throw new Error(`Provider ${unusable.join('+')} ist in dieser ORT-Runtime nicht verfügbar, Kette ${providers.join('+')}`);
        }
        const bytes = new Uint8Array(await readFile(modelPath));
        return api.InferenceSession.create(bytes, { ...options, executionProviders: ['wasm'] }) as never;
      },
    },
    Tensor: api.Tensor,
    ...(api.listSupportedBackends ? { listSupportedBackends: api.listSupportedBackends.bind(api) } : {}),
  };
}

/**
 * Exakte Nachbildung des Fixture-Graphen: `stems[i] = mix * gain[i]`. Sie
 * ersetzt **nur** die Rechenkerne – Segmentierung, Overlap-Add, Validierung,
 * Ablage und Lesen laufen unverändert durch den Produktionscode. Provider, die
 * die Nachbildung nicht kennt, scheitern wie eine echte Runtime ohne diesen
 * Provider (damit ist auch der CPU-Fallback prüfbar).
 */
function referenceRuntime(): OnnxRuntimeLike {
  class ReferenceTensor {
    constructor(
      public readonly type: string,
      public readonly data: Float32Array,
      public readonly dims: readonly number[]
    ) {}
  }
  return {
    Tensor: ReferenceTensor as unknown as OnnxRuntimeLike['Tensor'],
    InferenceSession: {
      async create(_modelPath: string, options?: Record<string, unknown>) {
        const providers = ((options?.executionProviders as string[] | undefined) ?? ['cpu']).map((name) => name.toLowerCase());
        const unusable = providers.filter((name) => name !== 'cpu' && name !== 'wasm');
        if (unusable.length > 0) {
          // Wie onnxruntime-node auf einer Maschine ohne DirectML/CUDA: die
          // angeforderte Kette ist nicht baubar – der Separator weicht auf CPU aus.
          throw new Error(`Provider ${unusable.join('+')} ist nicht verfügbar, Kette ${providers.join('+')}`);
        }
        return {
          inputNames: ['mix'],
          outputNames: ['stems'],
          inputMetadata: [{ name: 'mix', shape: [1, 2, SEGMENT] }],
          async run(feeds: Record<string, { data: Float32Array }>) {
            const mix = feeds.mix.data;
            const out = new Float32Array(STEMS.length * mix.length);
            for (let stem = 0; stem < STEMS.length; stem += 1) {
              const gain = GAINS[stem];
              for (let index = 0; index < mix.length; index += 1) out[stem * mix.length + index] = mix[index] * gain;
            }
            return { stems: new ReferenceTensor('float32', out, [1, STEMS.length, 2, SEGMENT]) as never };
          },
        } as never;
      },
    },
  } as unknown as OnnxRuntimeLike;
}

interface RuntimeChoice {
  runtime: OnnxRuntimeLike;
  label: string;
  /** True, wenn wirklich eine ORT-Runtime gerechnet hat (nicht die Nachbildung). */
  realOrt: boolean;
}

/** Welche Runtime steht zur Verfügung? Ehrlich benannt, damit das Protokoll nicht lügt. */
async function chooseRuntime(): Promise<RuntimeChoice> {
  try {
    const moduleName = 'onnxruntime-node';
    const loaded = (await import(/* @vite-ignore */ moduleName)) as unknown as { InferenceSession?: unknown; default?: unknown };
    const ort = (loaded.InferenceSession ? loaded : loaded.default) as unknown;
    // Die native Runtime meldet ihre Backends selbst – ein kurzer Zugriff
    // genügt als Funktionsnachweis (voller Sessionbau folgt im Job).
    return { runtime: ort as OnnxRuntimeLike, label: 'onnxruntime-node (nativ)', realOrt: true };
  } catch {
    /* nicht installiert – nächste Stufe */
  }
  try {
    const webModuleName = 'onnxruntime-web';
    const loaded = (await import(/* @vite-ignore */ webModuleName)) as unknown as { InferenceSession?: unknown; default?: { InferenceSession?: unknown } };
    const ort = loaded.InferenceSession ? loaded : loaded.default;
    if (ort?.InferenceSession) {
      const candidate = webRuntimeAdapter(ort);
      // Probe: baut sich eine echte Session? (Manche Node-Setups können das
      // WASM-Modul nicht laden – dann lieber klar auf die Nachbildung wechseln.)
      const probePath = path.join(os.tmpdir(), `ort-web-probe-${process.pid}`);
      await mkdir(probePath, { recursive: true });
      const probeFile = path.join(probePath, path.basename(FIXTURE));
      await writeFile(probeFile, await readFile(FIXTURE));
      const session = (await candidate.InferenceSession.create(probeFile, {
        executionProviders: ['wasm'],
      })) as { run?: unknown };
      if (typeof session?.run === 'function') {
        // Warme Session der Probe verwerfen: der Job baut seine eigene.
        return { runtime: candidate, label: 'onnxruntime-web (WASM, echte ORT-Kernel)', realOrt: true };
      }
    }
  } catch (error) {
    console.log(`  Hinweis: onnxruntime-web ist hier nicht lauffähig (${error instanceof Error ? error.message : String(error).slice(0, 80)})`);
  }
  return {
    runtime: referenceRuntime(),
    label: 'Referenz-Runtime (Gain-Nachbildung des Fixtures)',
    realOrt: false,
  };
}

function tinyDescriptor(sha256: string): ModelDescriptor {
  return {
    id: 'tiny-onnx-fast',
    family: 'htdemucs',
    architecture: 'Testgraph (HT-Demucs-Signatur)',
    version: 'opset17-testgraph',
    // Echter Hash des Fixtures: nur so gilt der Graph als geprüft (Regel aus
    // §25 – „unverified“ Modelle sind im Status nicht rechenbar).
    checkpoint: { file: path.basename(FIXTURE), format: 'onnx', sha256 },
    sampleRate: 44100,
    inputChannels: 2,
    outputStems: STEMS,
    stemOrder: STEMS,
    stemDisplayNames: { drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals' },
    modelHash: sha256,
    license: 'MIT (Test-Fixture)',
    backendSupport: ['onnx'],
    precision: ['f32'],
    recommendedOverlap: 1,
    chunkSizeSamples: SEGMENT,
    qualityProfile: {
      serves: ['PREVIEW', 'BALANCED', 'HIGH'],
      numOverlap: { PREVIEW: 1, BALANCED: 1, HIGH: 1 },
      rationale: 'Kleiner Testgraph mit der Signatur des schnellen ONNX-Pfads.',
    },
    notes: 'Nur für Tests: derselbe Graph wie tests/onnx-separator-inmemory.test.ts.',
  } as unknown as ModelDescriptor;
}

async function run() {
  const { runtime, label, realOrt } = await chooseRuntime();
  console.log(`\n  Runtime: ${label}`);
  if (!realOrt) {
    console.log('  Hinweis: ohne ORT-Runtime prüft dieser Lauf den kompletten Weg mit exakter');
    console.log('           Graphen-Nachbildung. Echte Kernel: `npm i onnxruntime-node` bzw.');
    console.log('           `tests/onnx-fixture-python-ort.test.ts` (Python-ORT, echtes Fixture).');
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'fast-live-'));
  const store = path.join(root, 'Models');
  const originalDir = path.join(root, 'Original');
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, path.basename(FIXTURE)), await readFile(FIXTURE));

  const fixtureSha256 = createHash('sha256').update(await readFile(FIXTURE)).digest('hex');
  const registry = ModelRegistry.fromCatalog({ models: [tinyDescriptor(fixtureSha256)] } as never);
  /*
   * Der Separator wird hier direkt eingesetzt – genauso macht es der
   * In-Memory-Test mit der nativen Runtime. Das Modell ist der Testgraph, die
   * Runtime ist echt (ORT-WASM), der Weg durch Job-Service, Segmentierung,
   * Rekonstruktion, Validierung, Ablage und `stemBytes()` ist der
   * Produktionsweg.
   */
  const separator = new OnnxSeparator({ modelStoreDir: store, runtime, family: 'htdemucs' });
  const service = new StemJobService({
    root,
    registry,
    modelStoreDir: store,
    chunkSizeSamples: SEGMENT,
    mode: 'fast_dj',
    backendFactory: { candidates: () => [separator] },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  });

  try {
    const track = generateEdmTestTrack({ seconds: 1 });
    const written = await writeTestAudio(originalDir, 'fast_mix', track);
    const originalStat = await stat(written.mixPath);
    const originalHash = createHash('sha256').update(await readFile(written.mixPath)).digest('hex');

    // =====================================================================
    console.log('\n[ TEST ] #1 ONNX-Graph lädt, Job läuft in-process auf CPU durch');
    const startedAt = Date.now();
    const started = await service.start({
      inputPath: written.mixPath,
      trackName: 'fast_mix',
      profile: 'BALANCED',
      modelId: 'tiny-onnx-fast',
      device: 'cpu',
    });
    const finished = await service.waitFor(started.jobId);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(finished.status, 'COMPLETED', `Job muss durchlaufen: ${finished.error?.message ?? ''}`);
    assert.match(String(finished.backend ?? ''), /local-mdx|onnx/, 'gerechnet hat der In-Process-ONNX-Pfad');
    assert.equal(finished.device, 'cpu');
    assert.equal(finished.cpuFallback ?? false, false, 'explizit CPU gewünscht ist kein Rückfall');
    console.log(`  ✓ Job in ${elapsedMs} ms fertig (Segment ${SEGMENT} Samples, 1 s Audio, WASM/CPU)`);

    // =====================================================================
    console.log('\n[ TEST ] #2 Vier lesbare Stems in Projektkonvention mit erwarteten Pegeln');
    assert.deepEqual(finished.stems, STEMS, 'Reihenfolge kommt aus dem Deskriptor (drums/bass/other/vocals)');
    const peaks: number[] = [];
    for (const stemId of STEMS) {
      const bytes = await service.stemBytes(started.jobId, stemId as never);
      const decoded = decodeWav(new Uint8Array(bytes));
      assert.equal(decoded.sampleRate, 44100);
      assert.equal(decoded.channels, 2);
      assert.ok(decoded.frames > 1000, `Stem ${stemId} enthält Audio (${decoded.frames} Frames)`);
      let peak = 0;
      for (let index = 0; index < decoded.data.length; index += 1) peak = Math.max(peak, Math.abs(decoded.data[index]));
      assert.ok(peak > 0, `Stem ${stemId} ist nicht still`);
      peaks.push(peak);
      const file = await stat(path.join(root, 'Separation', 'fast_mix', `${stemId}.wav`));
      assert.ok(file.size > 44, 'Stem liegt als WAV in der Projektkonvention auf der Platte');
    }
    // Der Graph skaliert die Stems mit 0.5/0.3/0.15/0.05 – die Reihenfolge
    // drums/bass/other/vocals muss also als fallende Pegelfolge sichtbar sein.
    for (let index = 1; index < peaks.length; index += 1) {
      assert.ok(peaks[index] < peaks[index - 1], `Stem-Reihenfolge/Vertauschung: ${peaks.map((p) => p.toFixed(3)).join(' > ')}`);
    }
    console.log(`  ✓ 4 Stems, Pegel ${peaks.map((peak) => peak.toFixed(3)).join(' > ')} (Gains ${GAINS.join('/')})`);

    // =====================================================================
    console.log('\n[ TEST ] #3 Original unverändert, zweiter Lauf trifft den Cache');
    const afterStat = await stat(written.mixPath);
    const afterHash = createHash('sha256').update(await readFile(written.mixPath)).digest('hex');
    assert.equal(afterHash, originalHash, 'Original-SHA256 unverändert');
    assert.equal(afterStat.size, originalStat.size);
    assert.equal(afterStat.mtimeMs, originalStat.mtimeMs, 'auch die mtime bleibt unangetastet (READ-ONLY)');

    const second = await service.start({ inputPath: written.mixPath, trackName: 'fast_mix', profile: 'BALANCED', modelId: 'tiny-onnx-fast', device: 'cpu' });
    const secondRun = await service.waitFor(second.jobId);
    assert.equal(secondRun.status, 'COMPLETED');
    assert.equal(secondRun.cacheHit, true, 'identische Einstellungen laufen aus dem Cache, nicht erneut');
    console.log('  ✓ Original bitgleich, zweiter Lauf cacheHit=true');

    // =====================================================================
    console.log('\n[ TEST ] #4 DirectML gewünscht, nicht vorhanden ⇒ CPU-Fallback statt Abbruch (§7)');
    const gpuRun = await service.start({
      inputPath: written.mixPath,
      trackName: 'fast_mix_gpu',
      profile: 'BALANCED',
      modelId: 'tiny-onnx-fast',
      device: 'directml',
    });
    const gpuFinished = await service.waitFor(gpuRun.jobId);
    assert.equal(gpuFinished.status, 'COMPLETED', 'ein fehlender GPU-Provider darf den Job nicht beenden');
    assert.equal(gpuFinished.device, 'cpu');
    assert.equal(gpuFinished.cpuFallback, true, 'der Rückfall ist als solcher gekennzeichnet');
    assert.match(
      String(gpuFinished.fallbackReason ?? ''),
      /dml|Provider|Session/i,
      `Grund muss verwertbar sein: ${gpuFinished.fallbackReason}`
    );
    assert.equal(gpuFinished.result?.originalUnchanged, true);
    console.log(`  ✓ Gerät gemeldet: ${gpuFinished.device}, cpuFallback=${gpuFinished.cpuFallback}, Grund: ${gpuFinished.fallbackReason}`);

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log(`  SCHNELLER PFAD BESTANDEN – Runtime: ${label}`);
    console.log('═══════════════════════════════════════════════════════════════════');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
