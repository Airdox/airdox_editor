/**
 * FAIL-FAST (§14) – aus dem Produktionslog vom 18.09.2026:
 *
 * `stems:job-wait` meldete erst nach **263 s** `BACKEND_UNAVAILABLE`, obwohl
 * der Grund (keine Python/PyTorch-Laufzeit) in Millisekunden feststand. Der
 * Job wurde also angenommen, decodiert/gestaged – und erst danach geprüft.
 *
 * Dieser Test hält die neue Ordnung fest:
 *   #1 der freie Auto-Pfad lehnt sofort ab (`BACKEND_UNAVAILABLE`, Grund im
 *      Text) und legt *keinen* Job an,
 *   #2 eine fest gewählte Architektur wird angenommen, scheitert aber
 *      weiterhin vor dem Decodieren (`Working/` bleibt leer),
 *   #3 die Ablehnung nennt Modell *und* Profil strukturiert (UI kann zeigen).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemJobService } from '../src/stems/stemJobService';
import type { BackendFactory } from '../src/stems/stemSeparationEngine';
import type {
  BackendAvailability,
  BackendCapabilities,
  IStemSeparator,
} from '../src/stems/backends/types';
import type { ModelDescriptor, ModelFamily } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FAIL-FAST: GRUND STATT 263-s-WARTEZEIT                          ');
console.log('═══════════════════════════════════════════════════════════════════');

const PRIMARY_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
const ONNX_ID = 'htdemucs-onnx-4stem-fp16';

/** Python/PyTorch fehlt – exakt die Meldung aus dem Produktionslog. */
class DownPythonBackend implements IStemSeparator {
  readonly kind = 'python-torch' as const;
  readonly family: ModelFamily = 'bs_roformer';
  readonly name = 'bs_roformer:python-torch';
  readonly availabilityKey = 'test|down|python';
  separateCalls = 0;

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
    return {
      available: false,
      reason:
        'bs_roformer:python-torch: Python/PyTorch-Laufzeit nicht verfügbar ' +
        '(C:\\Users\\p_kro\\AppData\\Roaming\\airdox_SMART_Editor\\stems\\stem-runtime\\Scripts\\python.exe)',
    };
  }

  async separate(): Promise<never> {
    this.separateCalls += 1;
    throw new Error('Das Backend darf nie erreicht werden – die Prüfung gehört vorher hin');
  }
}

/** ONNX-Graph liegt bereit, aber die in-process-Runtime ist nicht ladbar. */
class DownOnnxBackend implements IStemSeparator {
  readonly kind = 'onnx' as const;
  readonly family: ModelFamily = 'htdemucs';
  readonly name = 'htdemucs:onnx';
  readonly availabilityKey = 'test|down|onnx';
  separateCalls = 0;

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

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === 'htdemucs' && descriptor.checkpoint?.format === 'onnx';
  }

  async isAvailable(): Promise<BackendAvailability> {
    return {
      available: false,
      reason: `htdemucs:onnx: onnxruntime-node ist nicht verfügbar. Ursache: Cannot find package 'onnxruntime-node'`,
    };
  }

  async separate(): Promise<never> {
    this.separateCalls += 1;
    throw new Error('Das Backend darf nie erreicht werden – die Prüfung gehört vorher hin');
  }
}

async function makeScenario() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'airdox-failfast-store-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'airdox-failfast-root-'));
  // Beide Modelldateien liegen vollständig vor: Datei-Präsenz darf *nicht* als
  // „rechenbar“ durchgehen.
  await writeFile(path.join(store, 'model_bs_roformer_ep_17_sdr_9.6568.ckpt'), Buffer.alloc(4096, 1));
  await writeFile(
    path.join(store, 'config_bs_roformer_384_8_2_485100.yaml'),
    'training:\n  instruments: [drums, bass, other, vocals]\nmodel: {}\naudio: {}\n'
  );
  await writeFile(path.join(store, 'htdemucs_fp16weights.onnx'), Buffer.alloc(2048, 2));

  const python = new DownPythonBackend();
  const onnx = new DownOnnxBackend();
  const factory: BackendFactory = {
    candidates(descriptor) {
      if (descriptor.family === 'htdemucs') return [onnx];
      if (descriptor.family === 'bs_roformer') return [python];
      return [];
    },
  };
  const warnings: { message: string; details?: unknown }[] = [];
  const service = new StemJobService({
    root,
    modelStoreDir: store,
    registry: ModelRegistry.fromBundledCatalog(),
    mode: 'fast_dj',
    backendFactory: factory,
    logger: {
      warn: (_category, message, details) => warnings.push({ message, details }),
    },
  });
  const inputDir = path.join(root, 'Original');
  await mkdir(inputDir, { recursive: true });
  const inputPath = path.join(inputDir, 'mix.wav');
  await writeFile(inputPath, Buffer.alloc(4096));
  return { store, root, service, python, onnx, warnings, inputPath };
}

async function run() {
  const scenario = await makeScenario();
  const { service, python, onnx, warnings, inputPath, root } = scenario;

  // ---- #1 Auto-Pfad lehnt sofort ab -----------------------------------------
  console.log('\n[ TEST ] #1 Freie Profilwahl ohne lauffähiges Backend');
  const started = Date.now();
  await assert.rejects(
    () => service.start({ inputPath, profile: 'HIGH_QUALITY', trackName: 'mix' }),
    (error: unknown) => {
      const typed = error as { code?: string; message?: string; details?: Record<string, unknown> };
      assert.equal(typed.code, 'BACKEND_UNAVAILABLE', `Code war ${typed.code}: ${typed.message}`);
      assert.match(typed.message ?? '', /Kein Backend für/, 'Meldung muss mit dem Befund beginnen');
      assert.match(typed.message ?? '', /Python\/PyTorch-Laufzeit nicht verfügbar/, `Grund fehlt: ${typed.message}`);
      assert.equal(typed.details?.modelId, PRIMARY_ID);
      assert.equal(typed.details?.profile, 'HIGH_QUALITY');
      return true;
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `Ablehnung muss sofort kommen (war ${elapsed} ms)`);
  assert.equal(service.listJobs().length, 0, 'Abgelehnter Lauf darf keinen Job anlegen');
  assert.equal(python.separateCalls, 0);
  assert.equal(onnx.separateCalls, 0);
  assert.equal(warnings.length, 1, 'Die Ablehnung muss im Log stehen');
  console.log(`  ✓ abgelehnt nach ${elapsed} ms, kein Job, Log: ${warnings[0].message}`);

  // Auch die Profil-Matrix nennt das ONNX-Modell als nicht lauffähig.
  const status = await service.status();
  assert.equal(status.usable, false, 'Ohne Runtime ist die Engine nicht nutzbar');
  const balanced = status.profiles.find((entry) => entry.profile === 'BALANCED')!;
  assert.match(balanced.reason ?? '', /onnxruntime-node/, `ONNX-Grund fehlt: ${balanced.reason}`);
  assert.match(balanced.reason ?? '', /Python\/PyTorch-Laufzeit/, `Python-Grund fehlt: ${balanced.reason}`);
  console.log(`  ✓ status: usable=false, BALANCED-Grund = ${balanced.reason?.slice(0, 120)}…`);

  // ---- #2/#3 Fest gewählte Architektur: angenommen, aber vor dem Decodieren --
  console.log('\n[ TEST ] #2/#3 Festes Modell scheitert vor Arbeitskopie/Decode');
  const view = await service.start({ inputPath, modelId: ONNX_ID, profile: 'BALANCED', trackName: 'mix' });
  assert.equal(view.modelId, ONNX_ID, 'Der Nutzerwunsch wird nicht stillschweigend ersetzt');
  const waitStart = Date.now();
  // `waitFor` wirft den Fehler (Transport-Vertrag: `{ok:false, code, message}`),
  // der Job-Status bleibt trotzdem abrufbar.
  const thrown = await service.waitFor(view.jobId).then(
    () => null,
    (error: unknown) => error as { code?: string; message?: string }
  );
  const waitMs = Date.now() - waitStart;
  assert.ok(thrown, 'Der Lauf muss scheitern, solange keine Runtime ladbar ist');
  assert.equal(thrown?.code, 'BACKEND_UNAVAILABLE', `Fehlercode war ${thrown?.code}: ${thrown?.message}`);
  assert.match(thrown?.message ?? '', /onnxruntime-node/);
  assert.ok(waitMs < 5000, `Auch der feste Pfad muss schnell scheitern (war ${waitMs} ms)`);
  const finished = service.getJob(view.jobId)!;
  assert.equal(finished.status, 'FAILED');
  assert.equal(finished.error?.code, 'BACKEND_UNAVAILABLE');
  assert.match(finished.error?.message ?? '', /onnxruntime-node/);
  // Nichts wurde decodiert: die Arbeitskopie entsteht erst nach der Backend-Wahl.
  const workingEntries = await readdir(path.join(root, 'Working')).catch(() => [] as string[]);
  assert.equal(workingEntries.length, 0, `Kein Decode vor der Backend-Prüfung (gefunden: ${workingEntries.join(', ')})`);
  console.log(`  ✓ ${view.jobId}: FAILED nach ${waitMs} ms, Working/ leer (${finished.error?.message.slice(0, 80)}…)`);

  await rm(scenario.root, { recursive: true, force: true });
  await rm(scenario.store, { recursive: true, force: true });
  console.log('\n✔ FAIL-FAST: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
