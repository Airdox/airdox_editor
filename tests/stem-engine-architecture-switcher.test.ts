/**
 * STEM-ARCHITEKTUR-UMSCHALTER – Vertrag zwischen Einstellungen-UI und Engine.
 *
 * Der Nutzer soll im Settings-Menü zwischen den Modell-Familien (Architekturen)
 * wechseln können (BS-RoFormer / Mel-Band-RoFormer / HTDemucs). Das prüft
 * genau diesen Pfad, quer über die Schichten:
 *
 *   1. `StemJobService.status()` liefert eine `families`-Liste – eine pro
 *      Katalog-Familie (ohne das Test-Double), mit Label, Verfügbarkeit,
 *      bedienten Profilen und Modell-Ids. Das ist die Datenquelle für den
 *      Button-Selector in `WorkspaceSettingsModal`.
 *   2. `start({ family })` (ohne `modelId`) löst über die gewählte Familie
 *      auf; die zurückgegebene Job-Ansicht trägt `family` und das passende
 *      `modelId` dieser Familie.
 *   3. `family` + inkompatibles `profile` wird mit dem gleichen
 *      `MODEL_INCOMPATIBLE`-Fehler abgelehnt wie eine explizite `modelId`, die
 *      das Profil nicht bedient – keine stille Rückkehr zu einer anderen
 *      Familie.
 *   4. `family` + kompatibler `modelId` läuft durch; `family` + inkompatibler
 *      `modelId` wird abgelehnt (Konsistenzcheck).
 *   5. Der IPC-Sanitizer (`electron/stemEngineBridge.cjs`) lässt nur bekannte
 *      Familiennamen durch und verwirft Unsinn wie ein normales Feld.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';

const require = createRequire(import.meta.url);

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM-ARCHITEKTUR-UMSCHALTER (SETTINGS-MENÜ ↔ ENGINE)            ');
console.log('═══════════════════════════════════════════════════════════════════');

const CHUNK_SAMPLES = 44100;

async function makeService() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-family-switch-'));
  const track = generateEdmTestTrack({ seconds: 2 });
  const written = await writeTestAudio(path.join(root, 'Original'), 'edm_mix', track);
  const double = new PipelineDoubleSeparator({ simulatedMsPerFrame: 0 });
  const service = new StemJobService({
    root,
    allowPipelineDouble: true,
    chunkSizeSamples: CHUNK_SAMPLES,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: double }),
  });
  return { service, inputPath: written.mixPath };
}

async function run() {
  // =========================================================================
  console.log('\n[ TEST ] #1 status().families – eine Karte pro Architektur, kein Test-Double');
  const { service, inputPath } = await makeService();
  const status = await service.status();
  assert.ok(Array.isArray(status.families), 'status() muss eine families-Liste liefern');
  const familyIds = status.families.map((entry) => entry.family);
  assert.deepEqual(
    [...familyIds].sort(),
    ['bs_roformer', 'htdemucs', 'mel_band_roformer'],
    'genau die drei echten Architekturen, pipeline_double ist kein Auswahlpunkt'
  );
  for (const entry of status.families) {
    assert.ok(entry.label && entry.label.length > 0, `${entry.family} braucht ein UI-Label`);
    assert.ok(entry.description && entry.description.length > 0, `${entry.family} braucht eine Beschreibung`);
    assert.ok(entry.modelIds.length > 0, `${entry.family} muss auf mindestens ein Katalog-Modell zeigen`);
    assert.ok(Array.isArray(entry.serves), `${entry.family} muss die bedienten Profile nennen`);
  }
  const bsRoformer = status.families.find((entry) => entry.family === 'bs_roformer')!;
  assert.deepEqual(bsRoformer.modelIds, ['bsroformer-musdb18hq-4stem-zfturbo', 'bsroformer-viperx-vocals-1297']);
  assert.ok(bsRoformer.serves.includes('HIGH_QUALITY'), 'BS-RoFormer bedient HIGH_QUALITY');
  const htdemucs = status.families.find((entry) => entry.family === 'htdemucs')!;
  assert.deepEqual(htdemucs.serves, ['PREVIEW'], 'htdemucs bedient nur PREVIEW laut Katalog');
  console.log(`  ✓ ${status.families.length} Architekturen mit Label/Beschreibung/Modellen: ${familyIds.join(', ')}`);

  // =========================================================================
  console.log('\n[ TEST ] #2 start({ family }) löst auf das passende Modell dieser Familie auf');
  const job = await service.start({ inputPath, profile: 'PREVIEW', family: 'htdemucs' });
  assert.equal(job.family, 'htdemucs', 'Job-Ansicht trägt die tatsächlich verwendete Familie');
  assert.equal(job.modelId, 'htdemucs-ft-4stem', 'PREVIEW+htdemucs löst auf das htdemucs-Modell auf');
  service.cancel(job.jobId, 'Test');
  console.log(`  ✓ family=htdemucs, profile=PREVIEW → modelId=${job.modelId}`);

  const bsJob = await service.start({ inputPath, profile: 'PREVIEW', family: 'bs_roformer' });
  assert.equal(bsJob.family, 'bs_roformer');
  assert.equal(bsJob.modelId, 'bsroformer-musdb18hq-4stem-zfturbo', 'Gleiches Profil, andere Familie → anderes Modell');
  service.cancel(bsJob.jobId, 'Test');
  console.log(`  ✓ family=bs_roformer, profile=PREVIEW → modelId=${bsJob.modelId} (unterscheidet sich von htdemucs)`);

  // =========================================================================
  console.log('\n[ TEST ] #3 family + inkompatibles Profil wird abgelehnt, keine stille Umleitung');
  await assert.rejects(
    () => service.start({ inputPath, profile: 'HIGH_QUALITY', family: 'htdemucs' }),
    (error: any) => {
      assert.equal(error.code, 'MODEL_INCOMPATIBLE');
      return true;
    },
    'htdemucs bedient HIGH_QUALITY nicht – muss ablehnen statt auf bs_roformer umzuschalten'
  );
  console.log('  ✓ MODEL_INCOMPATIBLE statt stiller Architektur-Umleitung');

  // =========================================================================
  console.log('\n[ TEST ] #4 family + modelId: Konsistenzcheck');
  const consistent = await service.start({
    inputPath,
    profile: 'PREVIEW',
    modelId: 'htdemucs-ft-4stem',
    family: 'htdemucs',
  });
  assert.equal(consistent.modelId, 'htdemucs-ft-4stem');
  service.cancel(consistent.jobId, 'Test');
  await assert.rejects(
    () => service.start({ inputPath, profile: 'PREVIEW', modelId: 'htdemucs-ft-4stem', family: 'bs_roformer' }),
    (error: any) => {
      assert.equal(error.code, 'MODEL_INCOMPATIBLE');
      return true;
    },
    'modelId aus einer Familie + explizite andere family muss abgelehnt werden'
  );
  console.log('  ✓ modelId/family Mismatch wird erkannt');

  // =========================================================================
  console.log('\n[ TEST ] #5 IPC-Sanitizer lässt nur bekannte Architekturen durch');
  const bridgeHost = require(path.join(path.resolve('.'), 'electron', 'stemEngineBridge.cjs')) as {
    sanitizeRequest: (raw: unknown) => Record<string, unknown>;
  };
  const okFamily = bridgeHost.sanitizeRequest({ family: 'mel_band_roformer' });
  assert.equal(okFamily.family, 'mel_band_roformer');
  const badFamily = bridgeHost.sanitizeRequest({ family: 'made-up-architecture' });
  assert.equal(badFamily.family, undefined, 'unbekannte Familie wird verworfen, nicht durchgereicht');
  const noFamily = bridgeHost.sanitizeRequest({ profile: 'PREVIEW' });
  assert.equal(noFamily.family, undefined, 'kein family-Feld → kein Default erfunden');
  console.log('  ✓ sanitizeRequest kennt nur die Katalog-Familien');

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALLE ARCHITEKTUR-UMSCHALTER-TESTS BESTANDEN                       ');
  console.log('═══════════════════════════════════════════════════════════════════');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
