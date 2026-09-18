/**
 * REGRESSION aus dem Produktionslog vom 18.09.2026 (renderer-20260918-153836).
 *
 * Ausgangslage auf dem betroffenen Rechner:
 *   - BS-RoFormer-Checkpoint + Config liegen vollständig im Model-Store,
 *   - es gibt keine Python/PyTorch-Laufzeit,
 *   - der ONNX-Graph (DJ-Pfad) ist vorhanden und lauffähig.
 *
 * Vorher: `selectForProfile`/`resolveModel` prüften nur die *Datei-Präsenz*.
 * BALANCED/HIGH lagen deshalb weiter auf dem BS-RoFormer-Modell („Preferenz
 * bs_roformer"), wurden als nicht verfügbar angezeigt – und ein Lauf, der
 * diesen Pfad nahm, scheiterte erst nach Minuten mit
 *   `BACKEND_UNAVAILABLE: Kein Backend für bsroformer-musdb18hq-4stem-zfturbo
 *    verfügbar. bs_roformer:python-torch: Python/PyTorch-Laufzeit nicht verfügbar`
 * obwohl der installierte ONNX-Graph dasselbe Profil bedienen konnte.
 *
 * Geprüft wird:
 *   #1 die Profil-Matrix bewirbt das *rechenbare* Modell (ONNX) für
 *      PREVIEW/BALANCED/HIGH und nennt für HIGH_QUALITY den echten Grund,
 *   #2 `status.usable` ist wahr und `defaultProfile` ist ein lauffähiges Profil,
 *   #3 ein Job ohne modelId landet auf dem ONNX-Modell (nicht auf BS-RoFormer),
 *   #4 die Auswahl startet keinen zusätzlichen Interpreter (Probe gecacht),
 *   #5 der ONNX-Job läuft mit dem Deskriptor-Stem-Order durch.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemJobService } from '../src/stems/stemJobService';
import type { BackendFactory } from '../src/stems/stemSeparationEngine';
import type {
  BackendAvailability,
  BackendCapabilities,
  BackendSeparationRequest,
  BackendSeparationResponse,
  InlineStem,
  IStemSeparator,
} from '../src/stems/backends/types';
import type { ModelDescriptor, ModelFamily } from '../src/stems/types';
import { writeTestAudio, generateEdmTestTrack } from '../src/stems/testAudioGenerator';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  REGRESSION: LAUFFÄHIGES MODELL STATT DATEI-PRÄSENZ               ');
console.log('═══════════════════════════════════════════════════════════════════');

const PRIMARY_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
const ONNX_ID = 'htdemucs-onnx-4stem-fp16';

/**
 * Zählender Ersatz für den ONNX-Graph (kein 166-MiB-Download in der CI).
 *
 * Bewusst *keine* Ableitung vom Pipeline-Double: dessen
 * `supportsDescriptor` akzeptiert nur `pipeline_double`, und die Literaltypen
 * (`kind`, `name`) sind nicht überschreibbar. Hier zählt nur der Vertrag des
 * in-process-Pfads: `capabilities().inMemory`, `inlineStems`, `outputIndex`
 * entlang `descriptor.stemOrder`.
 */
class CountingOnnxDouble implements IStemSeparator {
  readonly kind = 'onnx' as const;
  readonly family: ModelFamily = 'htdemucs';
  readonly name = 'htdemucs:onnx';
  readonly availabilityKey = 'test|htdemucs|onnx';
  availableCalls = 0;
  invocations = 0;

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === 'htdemucs' && descriptor.checkpoint?.format === 'onnx';
  }

  capabilities(): BackendCapabilities {
    return {
      kind: 'onnx',
      family: 'htdemucs',
      name: this.name,
      supportedDevices: ['auto', 'cpu'],
      supportedPrecision: ['f32'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: true,
      inMemory: true,
    };
  }

  async isAvailable(): Promise<BackendAvailability> {
    this.availableCalls += 1;
    return { available: true, detail: { testDouble: true } };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    this.invocations += 1;
    const frames = request.frames;
    const channels = request.channels ?? 2;
    const source = request.workingSamples ?? new Float32Array(frames * channels);
    const stems: InlineStem[] = request.stems.map((name, index) => {
      const gain = 1 / (index + 2);
      const samples = new Float32Array(frames * channels);
      for (let i = 0; i < samples.length; i++) samples[i] = source[i] * gain;
      return { name, samples, frames, channels, outputIndex: request.descriptor.stemOrder.indexOf(name) };
    });
    return {
      engine: 'htdemucs',
      backend: 'onnx',
      stems: [],
      inlineStems: stems,
      device: 'cpu',
      report: { backendName: this.name, testDouble: true },
    };
  }
}

/** Python-Backend ohne Runtime – exakt die Situation aus dem Log. */
class MissingPythonSeparator implements IStemSeparator {
  readonly kind = 'python-torch' as const;
  readonly family: ModelFamily = 'bs_roformer';
  readonly name = 'bs_roformer:python-torch';
  readonly availabilityKey = 'test|bs_roformer|python-torch';
  availableCalls = 0;

  capabilities(): BackendCapabilities {
    return {
      kind: 'python-torch',
      family: 'bs_roformer',
      name: this.name,
      supportedDevices: ['auto', 'cpu'],
      supportedPrecision: ['f32'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: true,
      inMemory: false,
    };
  }

  async isAvailable(): Promise<BackendAvailability> {
    this.availableCalls += 1;
    return {
      available: false,
      reason:
        'bs_roformer:python-torch: Python/PyTorch-Laufzeit nicht verfügbar ' +
        '(C:\\Users\\p_kro\\AppData\\Roaming\\airdox_SMART_Editor\\stems\\stem-runtime\\Scripts\\python.exe)',
    };
  }

  async separate(): Promise<never> {
    throw new Error('Der Python-Pfad darf in diesem Test nie ausgeführt werden');
  }
}

async function makeScenario() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'airdox-runnable-store-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'airdox-runnable-root-'));

  // Gewichte des Primärmodells liegen vollständig vor (Datei-Präsenz reicht
  // für `isSelectable`, nicht für einen Lauf).
  await writeFile(path.join(store, 'model_bs_roformer_ep_17_sdr_9.6568.ckpt'), Buffer.alloc(4096, 1));
  await writeFile(
    path.join(store, 'config_bs_roformer_384_8_2_485100.yaml'),
    'training:\n  instruments: [drums, bass, other, vocals]\nmodel: {}\naudio: {}\n'
  );
  await writeFile(path.join(store, 'htdemucs_fp16weights.onnx'), Buffer.alloc(2048, 2));

  const onnx = new CountingOnnxDouble();
  const python = new MissingPythonSeparator();
  const factory: BackendFactory = {
    candidates(descriptor) {
      if (descriptor.family === 'htdemucs') return [onnx];
      if (descriptor.family === 'bs_roformer') return [python];
      return [];
    },
  };

  const service = new StemJobService({
    root,
    modelStoreDir: store,
    registry: ModelRegistry.fromBundledCatalog(),
    mode: 'fast_dj',
    backendFactory: factory,
    chunkSizeSamples: 44100,
  });
  const written = await writeTestAudio(path.join(root, 'Original'), 'regression_mix', generateEdtTrack());
  return { store, root, service, onnx, python, inputPath: written.mixPath };
}

function generateEdtTrack() {
  return generateEdmTestTrack({ seconds: 2 });
}

async function run() {
  const scenario = await makeScenario();
  const { service, onnx, python, inputPath } = scenario;

  // ---- #1 + #2: Profil-Matrix ------------------------------------------------
  console.log('\n[ TEST ] #1/#2 Profil-Matrix bewirbt das rechenbare Modell');
  const status = await service.status();
  const byProfile = new Map(status.profiles.map((entry) => [entry.profile, entry]));
  for (const profile of ['PREVIEW', 'BALANCED', 'HIGH'] as const) {
    const entry = byProfile.get(profile)!;
    assert.equal(entry.modelId, ONNX_ID, `${profile} muss auf den lauffähigen ONNX-Graphen zeigen (war ${entry.modelId})`);
    assert.equal(entry.available, true, `${profile} muss verfügbar sein: ${entry.reason ?? ''}`);
  }
  const hq = byProfile.get('HIGH_QUALITY')!;
  assert.equal(hq.modelId, PRIMARY_ID, 'HIGH_QUALITY bleibt beim Primärmodell');
  assert.equal(hq.available, false);
  assert.match(hq.reason ?? '', /Python\/PyTorch-Laufzeit nicht verfügbar/, `Grund fehlt: ${hq.reason}`);
  assert.equal(status.usable, true, 'Mit installiertem ONNX-Graph muss die Engine nutzbar sein');
  assert.ok(
    ['PREVIEW', 'BALANCED', 'HIGH'].includes(status.defaultProfile),
    `defaultProfile muss lauffähig sein (war ${status.defaultProfile})`
  );
  console.log(
    `  ✓ usable=${status.usable}, defaultProfile=${status.defaultProfile}, PREVIEW/BALANCED/HIGH → ${ONNX_ID}, HQ-Grund: ${hq.reason}`
  );

  // ---- #3 + #5: Job landet auf dem lauffähigen Modell ------------------------
  console.log('\n[ TEST ] #3/#5 Job ohne modelId nutzt das lauffähige Modell');
  const view = await service.start({ inputPath, profile: 'BALANCED', trackName: 'regression_mix' });
  assert.equal(view.modelId, ONNX_ID, `Job muss ${ONNX_ID} nutzen (war ${view.modelId})`);
  assert.equal(view.family, 'htdemucs');
  assert.deepEqual(view.stems, ['drums', 'bass', 'other', 'vocals'], 'Stems aus dem Deskriptor');
  const finished = await service.waitFor(view.jobId);
  assert.equal(finished.status, 'COMPLETED', `Job fehlgeschlagen: ${finished.error?.message ?? ''}`);
  assert.equal(finished.result?.validationPass, true);
  assert.equal(python.availableCalls > 0, true, 'Der nicht lauffähige Pfad wurde geprüft (und abgelehnt)');
  console.log(`  ✓ ${view.jobId}: ${view.modelId} → ${finished.status}, ${finished.result?.stems.length} Stems`);

  // ---- #4: Probes sind gecacht ----------------------------------------------
  console.log('\n[ TEST ] #4 Wiederholte Statusabfragen proben nicht erneut');
  const callsAfterFirstStatus = onnx.availableCalls + python.availableCalls;
  for (let i = 0; i < 3; i++) {
    service.invalidateStatus();
    const again = await service.status();
    assert.equal(again.usable, true);
  }
  const callsAfterRepeats = onnx.availableCalls + python.availableCalls;
  assert.equal(
    callsAfterRepeats,
    callsAfterFirstStatus,
    `Backend-Probes müssen gecacht sein (vorher ${callsAfterFirstStatus}, nachher ${callsAfterRepeats})`
  );
  console.log(`  ✓ 4 Statusaufrufe + 1 Job → ${callsAfterRepeats} Backend-Probes (statt 5×2)`);

  await rm(scenario.root, { recursive: true, force: true });
  await rm(scenario.store, { recursive: true, force: true });
  console.log('\n✔ LAUFFÄHIGE MODELLWAHL: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
