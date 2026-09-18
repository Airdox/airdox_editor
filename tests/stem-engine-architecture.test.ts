/**
 * Stem-Architekturen im Einstellungsmenü.
 *
 * Der Nutzer wählt dort eine *Architektur* (Modell) statt nur ein Qualitätsprofil.
 * Diese Datei sichert die drei Stellen ab, an denen das schiefgehen kann:
 *
 *   #1 die Auswahlliste (`describeArchitectures`) – `auto` oben, Test-Double
 *      versteckt, Installationsstatus aus dem Katalogstatus übernommen,
 *   #2 die Persistenz (`load/saveStemArchitectureSettings`) – kaputte Werte
 *      fallen auf Defaults zurück, nichts wirft,
 *   #3 die Job-Optionen (`resolveArchitectureJobOptions`) – `auto` erzeugt
 *      *keine* modelId (die Profil-Auflösung bleibt allein beim Katalog), eine
 *      feste Architektur gewinnt, Modus/Gerät gehen immer mit,
 *   #4 die Geräteliste (`deviceChoices`) – ohne Runtime bleibt alles wählbar,
 *      mit Runtime werden Provider ohne Bundle als nicht verfügbar markiert.
 *
 * Kein Test braucht `onnxruntime-node`: die Laufzeitinfo wird über eine
 * injizierte Runtime-Attrappe geprüft, nicht über die echte Bibliothek.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_STEM_ARCHITECTURE_SETTINGS,
  STEM_ARCHITECTURE_STORAGE_KEY,
  architectureLabel,
  describeArchitectures,
  deviceChoices,
  loadStemArchitectureSettings,
  resolveArchitectureJobOptions,
  saveStemArchitectureSettings,
} from '../src/audio/stemArchitectures';
import type { StemServiceStatus } from '../src/stems/transportTypes';
import { StemJobService } from '../src/stems/stemJobService';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM ARCHITEKTUREN – AUSWAHL, PERSISTENZ, JOB-OPTIONEN           ');
console.log('═══════════════════════════════════════════════════════════════════');

function model(overrides: Partial<StemServiceStatus['models'][number]>): StemServiceStatus['models'][number] {
  return {
    id: 'modell',
    family: 'htdemucs',
    version: '1.0.0',
    format: 'demucs-th',
    installed: false,
    hashVerified: false,
    stems: ['drums', 'bass', 'other', 'vocals'],
    serves: ['PREVIEW'],
    ...overrides,
  };
}

function fakeStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => (key === STEM_ARCHITECTURE_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === STEM_ARCHITECTURE_STORAGE_KEY) value = next;
    },
    read: () => value,
  };
}

async function run() {
  // ---- #1: Auswahlliste ----------------------------------------------------
  console.log('\n[ TEST ] #1 Auswahlliste aus dem Engine-Status');
  const models: StemServiceStatus['models'] = [
    model({ id: 'bsroformer-musdb18hq-4stem-zfturbo', family: 'bs_roformer', installed: true, hashVerified: true, serves: ['BALANCED', 'HIGH', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'] }),
    model({ id: 'htdemucs-onnx-4stem-fp16', family: 'htdemucs', format: 'onnx', installed: false, reason: 'ONNX-Modell fehlt: htdemucs_fp16weights.onnx', serves: ['PREVIEW', 'BALANCED'] }),
    model({ id: 'pipeline-double-v1', family: 'pipeline_double', format: 'pipeline-double', installed: true, serves: ['PREVIEW'] }),
  ];
  const options = describeArchitectures(models);
  assert.equal(options[0].id, 'auto', '„Automatisch" steht oben');
  assert.equal(options[0].installed, true, 'auto gilt als installiert, sobald irgendein Modell nutzbar ist');
  assert.equal(options.length, 3, 'Test-Double ist ohne includeTestDouble versteckt');
  const onnx = options.find((entry) => entry.id === 'htdemucs-onnx-4stem-fp16');
  assert.ok(onnx);
  assert.equal(onnx.inProcess, true, 'ONNX-Format wird als in-process markiert');
  assert.equal(onnx.installed, false);
  assert.match(onnx.reason ?? '', /ONNX-Modell fehlt/, 'Grund kommt aus dem Status');
  const doubled = describeArchitectures(models, { includeTestDouble: true });
  assert.equal(doubled.length, 4, 'mit includeTestDouble erscheint das Double');
  const empty = describeArchitectures([]);
  assert.equal(empty[0].installed, false, 'ohne Modelle ist „Automatisch" ehrlich als nicht einsatzbereit markiert');
  assert.match(empty[0].reason ?? '', /kein Modell installiert/i);
  console.log(`  ✓ ${options.map((entry) => `${entry.id}${entry.installed ? '' : ' (fehlt)'}`).join(', ')}`);

  // ---- #2: Persistenz ------------------------------------------------------
  console.log('\n[ TEST ] #2 Persistenz und kaputte Werte');
  const storage = fakeStorage();
  assert.deepEqual(loadStemArchitectureSettings(storage), DEFAULT_STEM_ARCHITECTURE_SETTINGS);
  const chosen = { architectureId: 'htdemucs-onnx-4stem-fp16', validationMode: 'studio_master' as const, device: 'directml' as const };
  saveStemArchitectureSettings(storage, chosen);
  assert.deepEqual(loadStemArchitectureSettings(storage), chosen, 'Runde durch den Speicher bleibt identisch');
  assert.ok((storage.read() ?? '').includes('htdemucs-onnx-4stem-fp16'));
  assert.deepEqual(loadStemArchitectureSettings(fakeStorage('kein json')), DEFAULT_STEM_ARCHITECTURE_SETTINGS, 'Müll fällt auf Defaults zurück');
  assert.deepEqual(
    loadStemArchitectureSettings(fakeStorage(JSON.stringify({ architectureId: '', validationMode: 'hauruck', device: 'quantenchip' }))),
    DEFAULT_STEM_ARCHITECTURE_SETTINGS,
    'unbekannte Felder werden verworfen'
  );
  assert.doesNotThrow(() => saveStemArchitectureSettings(undefined, chosen), 'fehlender Speicher wirft nicht');
  console.log('  ✓ Defaults, Round-Trip, Müll-Filter');

  // ---- #3: Job-Optionen ----------------------------------------------------
  console.log('\n[ TEST ] #3 Was ein Separation-Job aus der Auswahl macht');
  const auto = resolveArchitectureJobOptions({ architectureId: 'auto', validationMode: 'fast_dj', device: 'auto' });
  assert.equal(auto.modelId, undefined, '„Automatisch" pinnt kein Modell – die Profil-Auflösung bleibt beim Katalog');
  assert.deepEqual(auto, { mode: 'fast_dj', device: 'auto' });
  const pinned = resolveArchitectureJobOptions(chosen);
  assert.equal(pinned.modelId, 'htdemucs-onnx-4stem-fp16', 'feste Architektur gewinnt');
  assert.equal(pinned.mode, 'studio_master');
  assert.equal(pinned.device, 'directml');
  assert.equal(architectureLabel({ architectureId: 'auto', validationMode: 'fast_dj', device: 'auto' }, options), 'Automatisch');
  assert.match(architectureLabel(chosen, options), /ONNX/, 'Label kommt aus der Liste, wenn bekannt');
  console.log(`  ✓ auto→kein modelId, ${pinned.modelId} → ${pinned.mode}/${pinned.device}`);

  // ---- #4: Geräteliste -----------------------------------------------------
  console.log('\n[ TEST ] #4 Geräteliste folgt der Laufzeit');
  const withoutRuntime = deviceChoices(undefined);
  assert.ok(withoutRuntime.every((choice) => choice.available), 'ohne Info bleibt alles wählbar');
  const withRuntime = deviceChoices({
    runtimeAvailable: true,
    providers: ['dml', 'cpu'],
    supported: [{ name: 'dml', bundled: true }, { name: 'cpu', bundled: true }],
    modelInstalled: false,
  });
  const byId = Object.fromEntries(withRuntime.map((choice) => [choice.id, choice]));
  assert.equal(byId.directml.available, true, 'DirectML ist verfügbar, wenn die Runtime es mitbringt');
  assert.equal(byId.cpu.available, true);
  assert.equal(byId.cuda.available, false, 'CUDA bleibt ohne Provider gesperrt');
  assert.match(byId.cuda.reason ?? '', /cuda\/tensorrt/);
  const deadRuntime = deviceChoices({ runtimeAvailable: false, providers: [], supported: [], modelInstalled: false, reason: 'Cannot find module onnxruntime-node' });
  assert.equal(deadRuntime.find((choice) => choice.id === 'cpu')?.available, true, 'CPU bleibt als Rückfall wählbar');
  assert.equal(deadRuntime.find((choice) => choice.id === 'directml')?.available, false);
  console.log('  ✓ dml/cpu frei, cuda gesperrt, ohne Runtime nur CPU');

  // ---- #5: Status trägt die Felder, die die UI braucht ---------------------
  console.log('\n[ TEST ] #5 StemJobService.status() liefert Format + ONNX-Laufzeitinfo');
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-arch-'));
  const store = path.join(root, 'Models');
  await mkdir(store, { recursive: true });
  const service = new StemJobService({
    root,
    modelStoreDir: store,
    // Attrappe: keine echte onnxruntime-node-Abhängigkeit im Testlauf.
    loadOnnxRuntime: async () => {
      throw new Error('onnxruntime-node im Test nicht installiert');
    },
  });
  const status = await service.status();
  const onnxModel = status.models.find((entry) => entry.id === 'htdemucs-onnx-4stem-fp16');
  assert.ok(onnxModel, 'ONNX-Eintrag steht im Status');
  assert.equal(onnxModel.format, 'onnx', 'Format wird für die UI mitgegeben');
  assert.ok(status.onnx, 'ONNX-Laufzeitinfo ist Teil des Status');
  assert.equal(status.onnx?.runtimeAvailable, false, 'fehlende Runtime wird ehrlich gemeldet');
  assert.match(status.onnx?.reason ?? '', /onnxruntime-node/);
  assert.equal(status.onnx?.modelInstalled, false, 'ohne Gewichte ist das Modell nicht installiert');
  assert.ok(Array.isArray(status.onnx?.supported), 'Provider-Liste ist immer vorhanden (ggf. leer)');
  console.log('  ✓ format=onnx, Laufzeit nicht verfügbar, Modell nicht installiert');

  console.log('\n✅ Stem-Architekturen: alle Prüfungen bestanden.');
}

run().catch((error) => {
  console.error('\n❌ Stem-Architekturen fehlgeschlagen:', error);
  process.exitCode = 1;
});
