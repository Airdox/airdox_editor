/**
 * Model Registry, Stem Registry, Model Manager, Cache – contract tests.
 *
 * Verifies §4 (models are data), §10 (dynamic stems, never positional
 * assumptions), §12 (cache key + integrity) and the error taxonomy of §16.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRegistry, registryFromJson, validateDescriptor } from '../src/stems/modelRegistry';
import { StemRegistry } from '../src/stems/stemRegistry';
import { ModelManager } from '../src/stems/modelManager';
import { SeparationCache, buildCacheKey, hashSettings } from '../src/stems/separationCache';
import { StemSeparationError } from '../src/stems/errors';
import type { ModelDescriptor, SeparationSettings } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM SEPARATION – MODEL REGISTRY / STEM REGISTRY / CACHE       ');
console.log('═══════════════════════════════════════════════════════════════════');

const REQUIRED_FIELDS = [
  'id', 'family', 'version', 'checkpoint', 'sampleRate', 'inputChannels',
  'outputStems', 'stemOrder', 'stemDisplayNames', 'modelHash', 'license',
  'backendSupport', 'precision', 'recommendedOverlap', 'chunkSizeSamples', 'qualityProfile',
];

function baseSettings(overrides: Partial<SeparationSettings> = {}): SeparationSettings {
  return {
    profile: 'HIGH_QUALITY',
    modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
    modelVersion: 'ep17-sdr9.6568',
    modelHash: 'unverified',
    family: 'bs_roformer',
    backend: 'python-torch',
    precision: 'f32',
    device: 'auto',
    sampleRate: 44100,
    channels: 2,
    chunkSizeSamples: 131584,
    chunkOverlap: 0.5,
    numOverlap: 4,
    ensemblePasses: 1,
    clipMode: 'rescale',
    dcRemoval: false,
    stems: ['vocals', 'bass', 'drums', 'other'],
    extras: {},
    ...overrides,
  };
}

async function run() {
  const registry = ModelRegistry.fromBundledCatalog();
  const validation = registry.validate();
  const errors = validation.issues.filter((issue) => issue.severity === 'error');

  // ---- 1. catalog structure ------------------------------------------------
  console.log('\n[ TEST ] #1 Registry lädt den Katalog und validiert jeden Eintrag');
  assert.equal(errors.length, 0, `Registry-Fehler: ${JSON.stringify(errors)}`);
  assert.ok(registry.list().length >= 5, 'mindestens 5 Modelle registriert');
  for (const model of registry.list()) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in model, `${model.id}: Pflichtfeld ${field} fehlt`);
    }
  }
  console.log(`  ✓ ${registry.list().length} Modelle, ${validation.issues.length} Hinweise, 0 Fehler`);
  console.log(`  ✓ Registry-Content-Hash ${registry.contentHash()}`);

  // ---- 2. BS-RoFormer is the primary HQ engine -----------------------------
  console.log('\n[ TEST ] #2 Profilauflösung: BS-RoFormer ist die High-Quality-Engine');
  assert.equal(registry.selectForProfile('HIGH_QUALITY').family, 'bs_roformer');
  assert.equal(registry.selectForProfile('MAXIMUM_QUALITY').family, 'bs_roformer');
  assert.equal(registry.selectForProfile('PREVIEW').family, 'htdemucs', 'PREVIEW nutzt die schnellere Engine');
  const fourStem = registry.require('bsroformer-musdb18hq-4stem-zfturbo');
  // Authoritative: release v1.0.12 config_bs_roformer_384_8_2_485100.yaml, training.instruments.
  assert.deepEqual(fourStem.stemOrder, ['drums', 'bass', 'other', 'vocals']);
  assert.equal(fourStem.sampleRate, 44100);
  assert.equal(fourStem.inputChannels, 2);
  console.log(`  ✓ HIGH_QUALITY -> ${registry.selectForProfile('HIGH_QUALITY').id}`);
  console.log(`  ✓ MAXIMUM_QUALITY -> ${registry.selectForProfile('MAXIMUM_QUALITY').id}`);
  console.log(`  ✓ PREVIEW -> ${registry.selectForProfile('PREVIEW').id}`);
  console.log(`  ✓ 4-Stem-Reihenfolge aus der Registry: ${fourStem.stemOrder.join(', ')} (nicht blind vocals/drums/bass/other)`);

  // ---- 3. quality parameters come from the descriptor ----------------------
  console.log('\n[ TEST ] #3 Qualitätsparameter stammen aus der Modellbeschreibung');
  const viperx = registry.require('bsroformer-viperx-vocals-1297');
  assert.equal(registry.parametersFor(viperx, 'HIGH_QUALITY').numOverlap, 2, 'empfohlener num_overlap des Checkpoints');
  assert.ok(
    registry.parametersFor(viperx, 'MAXIMUM_QUALITY').numOverlap > registry.parametersFor(viperx, 'HIGH_QUALITY').numOverlap,
    'MAXIMUM_QUALITY erhöht die Inferenzdurchläufe'
  );
  assert.ok(registry.parametersFor(viperx, 'MAXIMUM_QUALITY').ensemblePasses >= 3, 'MAXIMUM_QUALITY nutzt Ensemble-Läufe');
  console.log(`  ✓ viperx num_overlap HIGH=${registry.parametersFor(viperx, 'HIGH_QUALITY').numOverlap} MAX=${registry.parametersFor(viperx, 'MAXIMUM_QUALITY').numOverlap}`);
  console.log(`  ✓ viperx Ensemble-Pässe MAX=${registry.parametersFor(viperx, 'MAXIMUM_QUALITY').ensemblePasses}`);

  // ---- 4. invalid descriptors are rejected ---------------------------------
  console.log('\n[ TEST ] #4 Ungültige Modellbeschreibungen werden abgelehnt');
  const broken: unknown[] = [
    { ...fourStem, id: '' },
    { ...fourStem, family: 'unknown_family' },
    { ...fourStem, stemOrder: ['vocals', 'bass', 'drums'] },
    { ...fourStem, stemOrder: ['vocals', 'bass', 'drums', 'guitar'] },
    { ...fourStem, modelHash: 'nicht-ein-hash' },
    { ...fourStem, recommendedOverlap: 0 },
    { ...fourStem, backendSupport: [] },
    { ...fourStem, inputChannels: 5 },
    { ...fourStem, qualityProfile: { serves: ['HIGH_QUALITY'], numOverlap: {} } },
  ];
  for (const candidate of broken) {
    const { descriptor, issues } = validateDescriptor(candidate);
    assert.equal(descriptor, undefined, `ungültiger Eintrag wurde akzeptiert: ${JSON.stringify(issues)}`);
    assert.ok(issues.some((issue) => issue.severity === 'error'), 'mindestens ein Fehler erwartet');
  }
  console.log(`  ✓ ${broken.length} fehlerhafte Deskriptoren abgelehnt`);

  assert.throws(
    () => registryFromJson({ models: [{ ...fourStem, id: 'x' }, { ...fourStem, id: 'x' }] }, { strict: true }),
    (error: unknown) => error instanceof StemSeparationError && error.code === 'MODEL_REGISTRY_INVALID',
    'doppelte model_id muss die Registry ablehnen'
  );
  assert.throws(
    () => registryFromJson({ models: [] }),
    (error: unknown) => error instanceof StemSeparationError && error.code === 'MODEL_REGISTRY_INVALID',
    'leerer Katalog muss abgelehnt werden'
  );
  console.log('  ✓ doppelte IDs und leerer Katalog -> MODEL_REGISTRY_INVALID');

  // ---- 5. StemRegistry maps by declared order ------------------------------
  console.log('\n[ TEST ] #5 StemRegistry bildet Ausgaben über stem_order ab');
  const stems = new StemRegistry(fourStem);
  assert.equal(stems.stemAt(0), 'drums');
  assert.equal(stems.stemAt(2), 'other');
  assert.equal(stems.indexOf('other'), 2);
  assert.throws(() => stems.stemAt(9), /nicht definiert/);
  assert.throws(() => stems.indexOf('guitar'), /wird von Modell/);

  const byIndex = stems.mapOutputs(
    [
      { name: 'irrelevant', filePath: '/tmp/3.wav', outputIndex: 3 },
      { name: 'irrelevant', filePath: '/tmp/0.wav', outputIndex: 0 },
      { name: 'irrelevant', filePath: '/tmp/1.wav', outputIndex: 1 },
      { name: 'irrelevant', filePath: '/tmp/2.wav', outputIndex: 2 },
    ],
    ['vocals', 'bass', 'drums', 'other']
  );
  assert.equal(byIndex.get('drums')?.filePath, '/tmp/0.wav', 'Output-Index 0 ist drums gemäß Release-Config');
  assert.equal(byIndex.get('other')?.filePath, '/tmp/2.wav');

  const byName = stems.mapOutputs(
    ['other', 'vocals', 'drums', 'bass'].map((name) => ({ name, filePath: `/tmp/${name}.wav` })),
    ['vocals', 'bass', 'drums', 'other']
  );
  assert.equal(byName.get('bass')?.filePath, '/tmp/bass.wav');

  const indexedNames = stems.mapOutputs(
    [0, 1, 2, 3].map((index) => ({ name: `stem_${index}_x`, filePath: `/tmp/${index}.wav` })),
    ['vocals', 'bass', 'drums', 'other']
  );
  assert.equal(indexedNames.get('vocals')?.filePath, '/tmp/3.wav');

  assert.throws(
    () => stems.mapOutputs([{ name: 'vocals', filePath: '/tmp/v.wav' }], ['vocals', 'bass', 'drums', 'other']),
    (error: unknown) => error instanceof StemSeparationError && error.code === 'STEM_CONFIG_INVALID',
    'unvollständige Lieferung darf nie als fertig gelten'
  );
  assert.throws(
    () =>
      stems.mapOutputs(
        [...['vocals', 'bass', 'drums', 'other'], 'guitar'].map((name) => ({ name, filePath: `/tmp/${name}.wav` })),
        ['vocals', 'bass', 'drums', 'other']
      ),
    /unbekannte Stems/,
    'unerwartete Ausgaben müssen auffallen'
  );
  console.log('  ✓ Abbildung per Output-Index, per Name und per stem_<i>_<name>');
  console.log('  ✓ unvollständige/unbekannte Lieferungen -> STEM_CONFIG_INVALID');

  // ---- 6. ModelManager ----------------------------------------------------
  console.log('\n[ TEST ] #6 ModelManager prüft Verfügbarkeit und Hashes');
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-registry-'));
  const store = path.join(root, 'models');
  await mkdir(store, { recursive: true });
  const manager = new ModelManager(registry, { storeDir: store, allowDownload: false });

  const missing = await manager.verify('bsroformer-miperx'.replace('miperx', 'viperx-vocals-1297'));
  assert.equal(missing.available, false, 'nicht installiertes Modell muss als nicht verfügbar gemeldet werden');
  assert.match(missing.reason ?? '', /Checkpoint fehlt/);

  await assert.rejects(
    () => manager.ensureAvailable('bsroformer-viperx-vocals-1297'),
    (error: unknown) => error instanceof StemSeparationError && error.code === 'MODEL_MISSING'
  );
  console.log('  ✓ fehlender Checkpoint -> MODEL_MISSING (ohne Download)');

  // corrupt checkpoint: hash mismatch must be reported, never ignored
  const corruptManager = new ModelManager(
    ModelRegistry.fromBundledCatalog({
      extra: [
        {
          ...viperx,
          id: 'test-hash-check',
          checkpoint: { file: 'hash-check.ckpt', format: 'pytorch-ckpt', sha256: 'a'.repeat(64) },
          config: undefined,
        } as ModelDescriptor,
      ],
    }),
    { storeDir: store, allowDownload: false }
  );
  await writeFile(path.join(store, 'hash-check.ckpt'), 'definitiv nicht der echte checkpoint');
  await assert.rejects(
    () => corruptManager.ensureAvailable('test-hash-check'),
    (error: unknown) => error instanceof StemSeparationError && error.code === 'MODEL_CORRUPT'
  );
  console.log('  ✓ sha256-Abweichung -> MODEL_CORRUPT');

  // synthetic checkpoints materialise locally
  const double = registry.require('pipeline-double-v1');
  await manager.ensureDescriptorAvailable(double);
  const synthetic = await manager.readSynthetic(double);
  assert.equal(synthetic.modelId, 'pipeline-double-v1');
  console.log('  ✓ synthetischer Checkpoint wird lokal erzeugt und gelesen');

  const statusList = await manager.listStatus();
  assert.equal(statusList.length, registry.list().length);
  console.log(`  ✓ listStatus liefert ${statusList.length} Berichte`);

  // ---- 7. cache ------------------------------------------------------------
  console.log('\n[ TEST ] #7 Cache-Schlüssel und Integritätsprüfung');
  const settings = baseSettings();
  const settingsHash = hashSettings(settings);
  assert.equal(settingsHash.length, 64);
  assert.equal(hashSettings({ ...settings, stems: ['other', 'vocals', 'drums', 'bass'] }), settingsHash, 'Stem-Reihenfolge im Request darf den Schlüssel nicht ändern');
  assert.notEqual(hashSettings({ ...settings, numOverlap: 8 }), settingsHash, 'num_overlap ist Teil des Schlüssels');
  assert.notEqual(hashSettings({ ...settings, modelHash: 'x'.repeat(64) }), settingsHash, 'model_hash ist Teil des Schlüssels');
  assert.notEqual(hashSettings({ ...settings, chunkOverlap: 0.25 }), settingsHash, 'chunk_overlap ist Teil des Schlüssels');
  assert.notEqual(hashSettings({ ...settings, precision: 'f16' }), settingsHash, 'precision ist Teil des Schlüssels');
  assert.notEqual(hashSettings({ ...settings, dcRemoval: true }), settingsHash, 'dc_removal ist Teil des Schlüssels');
  const key = buildCacheKey('inputhash', 'modelhash', settingsHash);
  assert.equal(key, 'inputhash:modelhash:' + settingsHash);
  console.log('  ✓ Schlüssel = input_audio_hash : model_hash : settings_hash');
  console.log('  ✓ Parameter (overlap, precision, num_overlap, dc) verändern den Schlüssel');

  const cache = new SeparationCache(path.join(root, 'cache'));
  await cache.ensureRoot();
  const miss = await cache.lookup(key);
  assert.equal(miss.hit, false);
  assert.match(miss.reason ?? '', /kein Cache-Eintrag/);

  // corrupt entries are invalidated, never trusted
  const entryDir = cache.entryDirectory(key);
  await mkdir(entryDir, { recursive: true });
  await writeFile(path.join(entryDir, 'job.json'), '{ das ist kein json');
  const corrupt = await cache.lookup(key);
  assert.equal(corrupt.hit, false);
  assert.match(corrupt.reason ?? '', /CACHE_CORRUPT/);
  console.log('  ✓ beschädigter Cache-Eintrag wird verworfen und als CACHE_CORRUPT gemeldet');

  const entries = await cache.entries();
  assert.equal(entries.length, 0, 'beschädigter Eintrag wird entfernt');
  console.log('  ✓ Cache-Verzeichnis nach Invalidierung leer');

  // ---- 8. descriptor metadata completeness ---------------------------------
  console.log('\n[ TEST ] #8 Jede Modellbeschreibung trägt Lizenz, Backend, Präzision und Chunking');
  for (const model of registry.list()) {
    assert.ok(model.license.length > 3, `${model.id}: Lizenz fehlt`);
    assert.ok(model.backendSupport.length > 0, `${model.id}: kein Backend`);
    assert.ok(model.precision.length > 0, `${model.id}: keine Präzision`);
    assert.ok(model.chunkSizeSamples >= 4096, `${model.id}: Chunk zu klein`);
    assert.ok(model.qualityProfile.serves.length > 0, `${model.id}: kein Profil`);
    for (const profile of model.qualityProfile.serves) {
      const overlap = model.qualityProfile.numOverlap[profile];
      assert.ok(typeof overlap === 'number' && overlap >= 1, `${model.id}: numOverlap für ${profile} fehlt`);
    }
    assert.ok(model.stemOrder.every((stem) => Boolean(model.stemDisplayNames[stem])), `${model.id}: Anzeigename fehlt`);
  }
  console.log('  ✓ alle Deskriptoren vollständig');

  const native = registry.list().filter((model) => model.backendSupport.includes('native-cli'));
  assert.ok(native.length >= 2, 'native Deployment-Pfade müssen registriert sein');
  console.log(`  ✓ native Backends registriert für: ${native.map((model) => model.id).join(', ')}`);

  const reportPath = path.join(root, 'registry-report.json');
  await writeFile(reportPath, JSON.stringify({ models: registry.list(), issues: validation.issues }, null, 2));
  assert.ok((await readFile(reportPath, 'utf8')).length > 1000);
  console.log(`\n  Bericht: ${reportPath}`);
  console.log('\n✔ MODEL REGISTRY / STEM REGISTRY / CACHE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
