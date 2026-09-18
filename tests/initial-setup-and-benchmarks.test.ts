/**
 * Tests für Ersteinrichtung, Speicherpfade und 5-Minuten-Referenz-Benchmarks.
 */
import assert from 'node:assert/strict';
import {
  STEM_ARCHITECTURE_BENCHMARKS,
  getArchitectureBenchmark,
  describeArchitectures,
  loadWorkspacePathSettings,
  saveWorkspacePathSettings,
  DEFAULT_WORKSPACE_PATH_SETTINGS,
  INITIAL_SETUP_COMPLETED_KEY,
  WORKSPACE_PATHS_STORAGE_KEY,
} from '../src/audio/stemArchitectures';
import type { StemServiceStatus } from '../src/stems/transportTypes';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  TEST: ERSTEINRICHTUNG & 5-MINUTEN-BENCHMARKS                     ');
console.log('═══════════════════════════════════════════════════════════════════');

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
}

async function run() {
  // Test 1: Benchmarks für 5-Minuten-Referenztitel vorhanden
  console.log('\n[ TEST 1 ] 5-Minuten-Referenz-Benchmarks für alle Architekturen');
  const requiredKeys = ['bsroformer-musdb18hq-4stem-zfturbo', 'bsroformer-viperx-vocals-1297', 'melbandroformer-viperx-vocals-3005', 'htdemucs-onnx-4stem-fp16', 'htdemucs-ft-4stem', 'auto'];

  for (const key of requiredKeys) {
    const bm = getArchitectureBenchmark(key);
    assert.ok(bm, `Benchmark für ${key} existiert`);
    assert.ok(bm.gpuTime.includes('Sek') || bm.gpuTime.includes('s'), `${key} hat GPU-Zeitangabe`);
    assert.ok(bm.cpuTime.includes('Min') || bm.cpuTime.includes('Sek'), `${key} hat CPU-Zeitangabe`);
    assert.ok(bm.sdrScore.length > 0, `${key} hat SDR-Angabe`);
    assert.ok(bm.realtimeFactor.length > 0, `${key} hat Realtime-Faktor`);
    assert.ok(bm.useCase.length > 0, `${key} hat Einsatzzweck`);
  }
  console.log('  ✓ Alle 5-Minuten-Referenzzeiten, GPU/CPU-Angaben und SDR-Werte vollständig.');

  // Test 2: describeArchitectures liefert benchmark5Min mit
  console.log('\n[ TEST 2 ] describeArchitectures() hängt 5-Minuten-Benchmarks an');
  const models: StemServiceStatus['models'] = [
    {
      id: 'bsroformer-musdb18hq-4stem-zfturbo',
      family: 'bs_roformer',
      version: 'ep17-sdr9.6568',
      format: 'pytorch-ckpt',
      installed: true,
      hashVerified: true,
      stems: ['drums', 'bass', 'other', 'vocals'],
      serves: ['HIGH_QUALITY', 'MAXIMUM_QUALITY'],
    },
    {
      id: 'htdemucs-onnx-4stem-fp16',
      family: 'htdemucs',
      version: 'fp16',
      format: 'onnx',
      installed: false,
      hashVerified: false,
      stems: ['drums', 'bass', 'other', 'vocals'],
      serves: ['PREVIEW'],
    },
  ];

  const options = describeArchitectures(models);
  assert.equal(options.length, 3); // auto + 2 models
  assert.ok(options[0].benchmark5Min, 'auto hat Benchmark');
  assert.ok(options[1].benchmark5Min, 'bsroformer hat Benchmark');
  assert.ok(options[2].benchmark5Min, 'htdemucs hat Benchmark');
  assert.equal(options[1].benchmark5Min.sdrScore, '9.65 dB SDR (Gold-Standard)');
  assert.equal(options[2].benchmark5Min.sdrScore, '8.80 dB SDR (Sehr gut)');
  console.log('  ✓ Architekturoptionen tragen 5-Minuten-Benchmarks für Settings-UI.');

  // Test 3: Pfad- und Ersteinrichtungs-Persistenz
  console.log('\n[ TEST 3 ] Ersteinrichtungs- & Pfad-Persistenz');
  const storage = fakeStorage();
  
  // Vor Einrichtung: Standardwerte
  const initial = loadWorkspacePathSettings(storage);
  assert.equal(initial.setupCompleted, false);
  assert.ok(initial.appProjectsPath.length > 0);
  assert.ok(initial.stemDataPath.length > 0);

  // Nach Einrichtung speichern
  const custom = {
    appProjectsPath: 'D:\\DJ_Projects',
    stemDataPath: 'D:\\AI_Models\\stems',
    setupCompleted: true,
  };
  saveWorkspacePathSettings(storage, custom);

  const loaded = loadWorkspacePathSettings(storage);
  assert.equal(loaded.setupCompleted, true);
  assert.equal(loaded.appProjectsPath, 'D:\\DJ_Projects');
  assert.equal(loaded.stemDataPath, 'D:\\AI_Models\\stems');
  assert.equal(storage.getItem(INITIAL_SETUP_COMPLETED_KEY), 'true');
  console.log('  ✓ Pfade und Ersteinrichtungs-Status werden sauber serialisiert & deserialisiert.');

  // Test 4: Ungültige Werte fallen auf Defaults zurück
  console.log('\n[ TEST 4 ] Ungültige Pfad-Daten & Presets');
  const badStorage = fakeStorage({
    [WORKSPACE_PATHS_STORAGE_KEY]: 'invalid json',
  });
  const fallback = loadWorkspacePathSettings(badStorage);
  assert.equal(fallback.setupCompleted, false);
  assert.equal(fallback.appProjectsPath, DEFAULT_WORKSPACE_PATH_SETTINGS.appProjectsPath);
  assert.equal(fallback.stemDataPath, DEFAULT_WORKSPACE_PATH_SETTINGS.stemDataPath);

  // Test 5: Preset-Listen
  const { APP_PROJECTS_PRESETS, STEM_DATA_PRESETS } = await import('../src/audio/stemArchitectures');
  assert.ok(APP_PROJECTS_PRESETS.length >= 3, 'Mindestens 3 Projekt-Presets');
  assert.ok(STEM_DATA_PRESETS.length >= 3, 'Mindestens 3 Stem-Daten-Presets');
  for (const p of APP_PROJECTS_PRESETS) {
    assert.ok(p.id && p.label && p.path, `Projekt-Preset ${p.id} hat alle Pflichtfelder`);
  }
  for (const p of STEM_DATA_PRESETS) {
    assert.ok(p.id && p.label && p.path, `Stem-Preset ${p.id} hat alle Pflichtfelder`);
  }
  console.log('  ✓ Preset-Listen für Dropdown-Auswahl vollständig.');

  console.log('\n✅ Alle Ersteinrichtungs- und Benchmark-Tests erfolgreich bestanden!');
}

run().catch((err) => {
  console.error('❌ Test fehlgeschlagen:', err);
  process.exitCode = 1;
});
