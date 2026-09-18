/**
 * Profil→Modell-Auflösung bei unvollständig installierten Gewichten (§4, §6, §23).
 *
 * Regression für „Vorschau zeigt dauerhaft keine Gewichte": Der Katalog
 * deklariert PREVIEW sowohl für das schnelle htdemucs-Modell als auch für das
 * primäre BS-RoFormer-Modell – die Demucs-Gewichte sind aber optional und werden
 * von keinem Installer mitgeliefert. Ohne Verfügbarkeitsprüfung blieb das
 * Vorschau-Profil deshalb auch nach einer erfolgreichen BS-RoFormer-Installation
 * unbenutzbar („keine Gewichte"), obwohl die Engine das Profil bedienen könnte.
 *
 * Geprüft wird:
 *   #1 ohne Gewichte bleibt die reine Katalog-Reihenfolge (kein Verhaltenswechsel),
 *   #2 mit vorhandenem BS-RoFormer-Checkpoint bedient BS-RoFormer das Vorschau-Profil,
 *   #3 die UI-Matrix (StemJobService) meldet genau das Modell, das ein Job nutzt,
 *   #4 das In-Process-Test-Double wird nie zum Standard, nur per expliziter modelId.
 *
 * Der echte 503-MiB-Checkpoint gehört nicht in die CI: für die Auswahl zählt die
 * Datei-Präsenz, deshalb genügen Platzhalter-Dateien in einem temporären Store.
 * Die Hash-Verifikation selbst deckt `stem-separation-registry.test.ts` ab.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { StemSeparationEngine, type BackendFactory } from '../src/stems/stemSeparationEngine';
import { StemJobService } from '../src/stems/stemJobService';
import type { IStemSeparator } from '../src/stems/backends/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM PROFILE FALLBACK – VORSCHAU OHNE DEMUCS-GEWICHTE          ');
console.log('═══════════════════════════════════════════════════════════════════');

const PRIMARY_ID = 'bsroformer-musdb18hq-4stem-zfturbo';
const DEMUCS_ID = 'htdemucs-ft-4stem';

interface CatalogModel {
  id: string;
  checkpoint: { file: string; sha256?: string; format?: string };
  config?: { file: string };
  checkpointSha256?: string;
  modelHash: string;
}

async function loadCatalog(): Promise<{ models: CatalogModel[] }> {
  const raw = await readFile(path.join(process.cwd(), 'src', 'stems', 'modelCatalog.json'), 'utf8');
  return JSON.parse(raw) as { models: CatalogModel[] };
}

function availableRoformerBackend(available = true): BackendFactory {
  const separator: IStemSeparator = {
    kind: 'python-torch',
    family: 'bs_roformer',
    name: 'test-bs-roformer-runtime',
    capabilities: () => ({
      kind: 'python-torch',
      family: 'bs_roformer',
      name: 'test-bs-roformer-runtime',
      supportedDevices: ['auto', 'cpu', 'cuda'],
      supportedPrecision: ['native', 'f32', 'f16', 'bf16', 'q8_0'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: true,
      inMemory: false,
    }),
    isAvailable: async () => (available ? { available: true } : { available: false, reason: 'Test-Runtime fehlt' }),
    separate: async () => {
      throw new Error('Test-Backend wird in diesem Status-Test nicht ausgeführt');
    },
  };
  return {
    candidates: (descriptor) => (descriptor.family === 'bs_roformer' ? [separator] : []),
  };
}

async function run() {
  const catalog = await loadCatalog();
  const primary = catalog.models.find((model) => model.id === PRIMARY_ID);
  assert.ok(primary, `Katalog muss ${PRIMARY_ID} führen`);
  assert.ok(primary.config, 'primäres Modell braucht eine Config');

  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-profile-'));
  const store = path.join(root, 'Models');
  await mkdir(store, { recursive: true });

  // ---- #1: keine Gewichte -> Katalog-Reihenfolge, alles unbenutzbar ---------
  console.log('\n[ TEST ] #1 Ohne Gewichte bleibt die Reihenfolge des Katalogs');
  const bareRegistry = ModelRegistry.fromBundledCatalog();
  assert.equal(bareRegistry.selectForProfile('PREVIEW').id, DEMUCS_ID, 'reine Katalogfrage bleibt htdemucs');
  const bareEngine = new StemSeparationEngine({
    registry: bareRegistry,
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'Cache'),
    modelStoreDir: store,
  });
  assert.equal(bareEngine.resolveModel('PREVIEW').id, DEMUCS_ID, 'ohne Dateien keine stille Umsortierung');
  assert.equal(bareEngine.isSelectable(bareRegistry.require(PRIMARY_ID)), false, 'nichts vorhanden -> nicht auswählbar');
  console.log(`  ✓ leerer Store  -> PREVIEW bleibt ${DEMUCS_ID} (Auswahl wie bisher)`);

  // ---- Vorbereitung: BS-RoFormer „installiert" (nur Präsenz, kein Hash) -----
  // Der Testkatalog verzichtet auf den sha256-Zwang, damit eine Platzhalterdatei
  // nicht als „beschädigt" gilt. Die Auswahlregel ist davon unberührt.
  const testCatalog = JSON.parse(JSON.stringify(catalog)) as { models: CatalogModel[] };
  const testPrimary = testCatalog.models.find((model) => model.id === PRIMARY_ID)!;
  testPrimary.checkpoint.sha256 = 'unverified';
  delete testPrimary.checkpointSha256;
  testPrimary.modelHash = 'unverified';
  const registry = ModelRegistry.fromCatalog(testCatalog);

  await writeFile(path.join(store, testPrimary.checkpoint.file), 'placeholder-checkpoint', 'utf8');
  await writeFile(path.join(store, testPrimary.config!.file), 'placeholder-config', 'utf8');

  const engine = new StemSeparationEngine({
    registry,
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'Cache'),
    modelStoreDir: store,
  });

  // ---- #2: BS-RoFormer übernimmt das Vorschau-Profil ------------------------
  console.log('\n[ TEST ] #2 Installierter BS-RoFormer bedient das Vorschau-Profil');
  const preview = engine.resolveModel('PREVIEW');
  assert.equal(preview.id, PRIMARY_ID, 'PREVIEW muss auf das installierte Modell ausweichen');
  assert.equal(preview.family, 'bs_roformer');
  assert.equal(
    registry.selectForProfile('PREVIEW').family,
    'htdemucs',
    'die Katalog-Reihenfolge selbst bleibt unverändert (nur die Auswahl nutzt die Verfügbarkeit)'
  );
  assert.equal(registry.selectForProfile('PREVIEW', undefined, { isAvailable: () => false }).id, DEMUCS_ID);
  const engineStatus = await engine.status();
  assert.equal(engineStatus.profiles.PREVIEW, PRIMARY_ID);
  assert.equal(engineStatus.profiles.HIGH_QUALITY, PRIMARY_ID);
  console.log(`  ✓ PREVIEW -> ${preview.id} (${preview.family}), Katalog-Reihenfolge unverändert`);

  // ---- #3: dieselbe Matrix für die UI (StemJobService) ---------------------
  console.log('\n[ TEST ] #3 Die UI-Matrix nennt genau das Modell, das ein Job nutzt');
  const service = new StemJobService({ root, registry, chunkSizeSamples: 44100, backendFactory: availableRoformerBackend() });
  const status = await service.status();
  assert.equal(status.usable, true, 'mit Gewichten und Backend ist die Engine nutzbar');
  const previewProfile = status.profiles.find((entry) => entry.profile === 'PREVIEW')!;
  assert.equal(previewProfile.modelId, PRIMARY_ID);
  assert.equal(previewProfile.available, true, 'Vorschau darf nicht mehr „keine Gewichte" zeigen');
  assert.deepEqual(previewProfile.stems.map((stem) => stem.id), ['drums', 'bass', 'other', 'vocals']);
  assert.equal(previewProfile.parameters.numOverlap, 2, 'PREVIEW nutzt den Katalogwert des primären Modells');
  assert.equal(previewProfile.reason, undefined);
  // Und die Auflösung, die der Jobstart benutzt, stimmt damit überein:
  assert.equal(service.engine.resolveModel('PREVIEW').id, previewProfile.modelId);
  console.log(`  ✓ PREVIEW: modelId=${previewProfile.modelId}, available=${previewProfile.available}, num_overlap=${previewProfile.parameters.numOverlap}`);

  const unavailableRuntimeService = new StemJobService({
    root,
    registry,
    chunkSizeSamples: 44100,
    backendFactory: availableRoformerBackend(false),
  });
  const unavailableStatus = await unavailableRuntimeService.status();
  assert.equal(unavailableStatus.usable, false, 'Gewichte ohne Runtime dürfen nicht als nutzbar gelten');
  assert.match(
    unavailableStatus.profiles.find((entry) => entry.profile === 'PREVIEW')?.reason ?? '',
    /Test-Runtime fehlt/,
    'UI-Preflight muss Backendfehler vor dem Jobstart nennen'
  );
  console.log('  ✓ installierte Gewichte ohne Runtime -> Status nicht nutzbar');

  // ---- #4: das Test-Double wird nie zum Standard ---------------------------
  console.log('\n[ TEST ] #4 Das Pipeline-Double bleibt ein explizites Testwerkzeug');
  const double = registry.require('pipeline-double-v1');
  assert.equal(engine.isSelectable(double), false, 'synthetische Double-Dateien dürfen kein Profil besetzen');
  assert.equal(engine.resolveModel('PREVIEW').id, PRIMARY_ID, 'Double ändert die Profilwahl nicht');
  assert.equal(
    engine.resolveModel('PREVIEW', 'pipeline-double-v1').id,
    'pipeline-double-v1',
    'explizit angefordert bleibt das Double erlaubt'
  );
  console.log('  ✓ Double nur per expliziter modelId, nie als Profil-Default');

  console.log('\n✔ STEM PROFILE FALLBACK: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
