/**
 * STEM JOB SERVICE – Vertrag zwischen Engine und Editor.
 *
 * `src/stems/stemJobService.ts` ist die Schicht, die der Editor (IPC im
 * Desktop-Fall, HTTP im Browser-Fall) tatsächlich anspricht. Geprüft wird hier
 * genau das, was die UI braucht und was in der Engine selbst nicht sichtbar
 * ist:
 *
 *   1. Profilauswahl + Stem-Liste kommen aus den Deskriptoren (kein
 *      hartkodiertes vocals/drums/bass/other) – ein 3-Stem-Modell liefert 3
 *      Stems, auch in der Job-Ansicht.
 *   2. `start()` gibt sofort eine Job-Ansicht zurück (JobId vor dem ersten
 *      Sample), Fortschritt läuft über Events.
 *   3. Abbruch: Original unverändert, kein Stem als fertig markiert.
 *   4. Pause/Fortsetzung beenden den Job nicht, verändern das Ergebnis nicht.
 *   5. Cache: zweiter Lauf mit identischen Einstellungen trifft den Cache.
 *   6. `stemBytes()` liefert decodefähige WAV-Bytes; unbekannte Stem-Id ist ein
 *      Typisierter Fehler (`STEM_CONFIG_INVALID`), kein Rate-Guess.
 *   7. Node-Bridge (`src/stems/nodeBridge.ts`) liefert strukturierte
 *      `{ ok:false, code }`-Ergebnisse statt geplatzter Promises über IPC.
 *
 * Als Backend dient das deterministische Pipeline-Double (ausdrücklich KEIN
 * trainiertes Modell), damit die Prüfung ohne Checkpoint in CI läuft.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemJobService, type StemServiceEvent } from '../src/stems/stemJobService';
import { createStemBridge, STEM_BRIDGE_VERSION } from '../src/stems/nodeBridge';
import { ModelRegistry } from '../src/stems/modelRegistry';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { sha256File } from '../src/stems/wavIo';
import type { ModelDescriptor } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM JOB SERVICE – PROFIL,STEM-LISTE,PROGRESS,CANCEL,CACHE,BRIDGE');
console.log('═══════════════════════════════════════════════════════════════════');

const CHUNK_SAMPLES = 44100;

/** 3-Stem-Double: beweist, dass die Stem-Liste aus dem Deskriptor kommt. */
function tripleDescriptor(): ModelDescriptor {
  return {
    id: 'triple-double-v1',
    family: 'pipeline_double',
    version: '1.0.0',
    checkpoint: { file: 'triple-double-v1.synthetic', format: 'synthetic' },
    sampleRate: 44100,
    inputChannels: 2,
    outputStems: ['kick', 'bassline', 'melody'],
    stemOrder: ['melody', 'kick', 'bassline'],
    stemDisplayNames: { kick: 'Kick', bassline: 'Bassline', melody: 'Melodie' },
    modelHash: 'synthetic:triple-double-v1',
    license: 'MIT',
    backendSupport: ['in-process'],
    precision: ['f32'],
    recommendedOverlap: 1,
    chunkSizeSamples: CHUNK_SAMPLES,
    qualityProfile: {
      serves: ['PREVIEW'],
      numOverlap: { PREVIEW: 1 },
      rationale: 'Test-Double mit drei Stems.',
    },
  } as ModelDescriptor;
}

interface Harness {
  root: string;
  inputPath: string;
  service: StemJobService;
  events: StemServiceEvent[];
  double: PipelineDoubleSeparator;
}

async function makeHarness(options: { slowMsPerFrame?: number; allowDoubleRootSuffix?: string } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), `stem-service-${options.allowDoubleRootSuffix ?? ''}`));
  const track = generateEdmTestTrack({ seconds: 3 });
  const written = await writeTestAudio(path.join(root, 'Original'), 'edm_mix', track);
  const double = new PipelineDoubleSeparator({ simulatedMsPerFrame: options.slowMsPerFrame ?? 0 });
  const registry = ModelRegistry.fromBundledCatalog({ extra: [tripleDescriptor()] });
  const service = new StemJobService({
    root,
    registry,
    allowPipelineDouble: true,
    chunkSizeSamples: CHUNK_SAMPLES,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: double }),
  });
  const events: StemServiceEvent[] = [];
  service.onEvent((event) => events.push(event));
  return { root, inputPath: written.mixPath, service, events, double };
}

function lastOf(events: StemServiceEvent[], type: StemServiceEvent['type']): StemServiceEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

async function run() {
  // =========================================================================
  console.log('\n[ TEST ] #1 Status: Profile, Modelle und Stem-Listen aus dem Katalog');
  const probe = await makeHarness();
  const status = await probe.service.status();
  assert.equal(status.ok, true);
  assert.equal(status.accessMode, 'ORIGINALS_READ_ONLY');
  const registryErrors = (status.registryIssues as { severity: string }[]).filter((issue) => issue.severity === 'error');
  assert.equal(registryErrors.length, 0, `Registry-Fehler: ${JSON.stringify(registryErrors)}`);
  // Warnungen sind erlaubt und erwartet: sie melden "unverified"-Hashes, solange
  // die trainierten Gewichte nicht geladen wurden (TEIL 2, Pinning).
  const unverifiedWarnings = (status.registryIssues as { code?: string }[]).filter((issue) => issue.code === 'MODEL_HASH_UNVERIFIED');
  assert.ok(unverifiedWarnings.length <= status.models.length);
  assert.equal(status.profiles.length, 3, 'genau die drei Profile aus dem Kern');

  const preview = status.profiles.find((entry) => entry.profile === 'PREVIEW')!;
  const high = status.profiles.find((entry) => entry.profile === 'HIGH_QUALITY')!;
  const maximum = status.profiles.find((entry) => entry.profile === 'MAXIMUM_QUALITY')!;
  assert.equal(preview.modelId, 'htdemucs-ft-4stem', 'PREVIEW bleibt beim Demucs-Pfad');
  assert.deepEqual(
    preview.stems.map((stem) => stem.id),
    ['drums', 'bass', 'other', 'vocals'],
    'PREVIEW-Stems folgen dem htdemucs-Deskriptor (stemOrder), nicht der alten Konstanten'
  );
  assert.equal(high.modelId, 'bsroformer-musdb18hq-4stem-zfturbo');
  assert.deepEqual(high.stems.map((stem) => stem.id), ['vocals', 'bass', 'drums', 'other']);
  assert.deepEqual(
    high.stems.map((stem) => stem.displayName),
    ['Vocals', 'Bass', 'Drums', 'Other'],
    'Anzeigenamen kommen aus stemDisplayNames'
  );
  assert.equal(maximum.parameters.numOverlap > high.parameters.numOverlap, true, 'MAXIMUM_QUALITY erhöht num_overlap');
  assert.equal(maximum.parameters.ensemblePasses > high.parameters.ensemblePasses, true, 'MAXIMUM_QUALITY fährt das Ensemble hoch');
  // Ohne installierte Gewichte ist nichts benutzbar – der Editor darf dann
  // kein „KI bereit" melden.
  const trainedUsable = high.available;
  assert.equal(status.usable, status.profiles.some((entry) => entry.available));
  assert.equal(status.defaultProfile, trainedUsable ? 'HIGH_QUALITY' : 'PREVIEW');
  console.log(`  ✓ 3 Profile, Stems je Profil aus dem Deskriptor (HQ: ${high.stems.map((s) => s.id).join(',')})`);
  console.log(`  ✓ usable=${status.usable} → defaultProfile=${status.defaultProfile} (Grund: ${high.reason ?? 'Modell installiert'})`);
  assert.ok(status.models.length >= 5, 'alle Katalogmodelle werden gemeldet');
  assert.ok(status.models.every((model) => model.stems.length > 0), 'jedes Modell meldet seine Stems');
  console.log(`  ✓ ${status.models.length} Modelle gemeldet, ${status.cacheEntries.length} Cache-Einträge`);

  // =========================================================================
  console.log('\n[ TEST ] #2/start: JobId sofort, Stem-Liste aus dem Deskriptor (3 Stems)');
  const startedAt = Date.now();
  const view = await probe.service.start({
    inputPath: probe.inputPath,
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    trackName: 'edm_service',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  const startedInMs = Date.now() - startedAt;
  assert.ok(view.jobId.startsWith('stem_'), `JobId wird sofort vergeben: ${view.jobId}`);
  assert.equal(view.status, 'PENDING', 'direkt nach start() läuft noch nichts als fertig');
  assert.equal(startedInMs < 5000, true, `start() darf nicht auf die Inferenz warten (war ${startedInMs} ms)`);
  assert.deepEqual(view.stems, ['melody', 'kick', 'bassline'], 'Stem-Reihenfolge = stemOrder, Länge = 3');
  assert.equal(view.stems.includes('vocals'), false, 'keine implizit ergänzten Legacy-Stems');
  console.log(`  ✓ ${view.jobId}: ${view.stems.length} Stems (${view.stems.join(', ')}) nach ${startedInMs} ms übernommen`);

  const finished = await probe.service.waitFor(view.jobId);
  assert.equal(finished.status, 'COMPLETED', `Abgeschlossen statt ${finished.status}: ${finished.error?.message ?? ''}`);
  assert.equal(finished.percent, 100);
  assert.ok(finished.result, 'Ergebnis-Metadaten vorhanden');
  assert.equal(finished.result!.stems.length, 3, 'genau die Deskriptor-Stems landen im Ergebnis');
  assert.deepEqual(finished.result!.stems.map((stem) => stem.id), ['melody', 'kick', 'bassline']);
  assert.equal(finished.result!.validationPass, true, 'technische Validierung muss durchgehen');
  assert.equal(finished.result!.originalUnchanged, true);
  assert.equal(finished.result!.trainedModel, false, 'Double bleibt als untrainiert markiert');
  assert.ok(finished.engineJobId?.startsWith('job_'), 'engineJobId aus dem Fortschritt übergeben');
  console.log(`  ✓ validiert: ${finished.result!.stems.map((stem) => `${stem.id}(${stem.frames} Samples)`).join(' ')}`);

  console.log('\n[ TEST ] #3 Fortschritt: wachsende Prozente, Chunk-Zähler, definiertes Ende');
  const progress = probe.events.filter((event) => event.type === 'progress');
  assert.ok(progress.length >= 3, `genug Fortschritts-Events (waren ${progress.length})`);
  const percents = progress.map((event) => event.job.percent);
  for (let i = 1; i < percents.length; i++) {
    assert.ok(percents[i] >= percents[i - 1], `Prozent müssen monoton wachsen: ${percents.join(' → ')}`);
  }
  assert.ok(progress.some((event) => event.job.chunkCount >= 3), `mehrere Chunks gemeldet (${progress.at(-1)!.job.chunkCount})`);
  assert.ok(progress.every((event) => event.job.phase.trim().length > 0), 'jede Meldung hat einen Phasentext');
  assert.equal(lastOf(probe.events, 'completed')?.job.jobId, view.jobId, 'completed-Event trägt denselben Job');
  console.log(`  ✓ ${progress.length} Events, ${percents[0]}% → ${percents.at(-1)}%, ${progress.at(-1)!.job.chunkCount} Chunks`);

  console.log('\n[ TEST ] #4 Einzelne Stems als WAV-Bytes für den Renderer');
  const wav = await probe.service.stemBytes(view.jobId, 'kick');
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', 'echter WAV-Container');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.ok(wav.length > 44, 'Datenblock vorhanden');
  await assert.rejects(
    () => probe.service.stemBytes(view.jobId, 'vocals'),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.equal(code, 'STEM_CONFIG_INVALID', 'Legacy-Stem „vocals" darf nicht erraten werden');
      return true;
    }
  );
  console.log(`  ✓ kick.wav: ${wav.length} Bytes, unknown stem → STEM_CONFIG_INVALID`);

  console.log('\n[ TEST ] #5 Job-Metadaten: Profil, Modell, Chunk-Plan, Original-Integrität');
  const metadata = (await probe.service.jobMetadata(view.jobId)) as {
    jobId: string;
    settings: { profile: string; modelId: string; stems: string[]; chunkSizeSamples: number; chunkOverlap: number };
    chunkCount: number;
    chunkPlan: unknown[];
    cacheKey: string;
    settingsHash: string;
    originalIntegrity: { sha256Before: string; sha256After?: string; unchanged: boolean };
    status: string;
  };
  assert.equal(metadata.settings.profile, 'PREVIEW');
  assert.equal(metadata.settings.modelId, 'triple-double-v1');
  assert.deepEqual(metadata.settings.stems, ['melody', 'kick', 'bassline']);
  assert.equal(metadata.settings.chunkOverlap, 0.5);
  assert.ok(metadata.chunkPlan.length >= 3, 'Chunk-Plan ist vollständig dokumentiert');
  assert.ok(/^[0-9a-f]{8,}$/.test(metadata.settingsHash), 'settingsHash reproducibel');
  assert.ok(metadata.cacheKey.includes(':'), `cacheKey ${metadata.cacheKey}`);
  assert.equal(metadata.originalIntegrity.unchanged, true);
  assert.equal(metadata.originalIntegrity.sha256Before, metadata.originalIntegrity.sha256After);
  console.log(`  ✓ job.json: ${metadata.chunkPlan.length} Chunks, cacheKey ${metadata.cacheKey.slice(0, 24)}…`);

  console.log('\n[ TEST ] #6 Cache: zweiter identischer Lauf ohne neue Inferenz');
  const invocationsBefore = probe.double.invocationCount;
  const again = await probe.service.start({
    inputPath: probe.inputPath,
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    trackName: 'edm_service',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  const reused = await probe.service.waitFor(again.jobId);
  assert.equal(reused.cacheHit, true, 'gleiche Einstellungen ⇒ Cache-Treffer');
  assert.equal(probe.double.invocationCount, invocationsBefore, 'Backend wurde nicht nochmal aufgerufen');
  assert.equal(reused.result!.stems.length, 3, 'Cache liefert dieselbe Stem-Anzahl');
  console.log(`  ✓ Cache-Treffer, ${probe.double.invocationCount} Backend-Aufrufe insgesamt (keiner zusätzlich)`);

  console.log('\n[ TEST ] #7 Abbruch: Original heil, kein Stem fertig, Status CANCELLED');
  const cancelHarness = await makeHarness({ slowMsPerFrame: 0.02 });
  const hashBefore = await sha256File(cancelHarness.inputPath);
  const cancelView = await cancelHarness.service.start({
    inputPath: cancelHarness.inputPath,
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    trackName: 'edm_cancel',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(cancelHarness.service.cancel(cancelView.jobId, 'Nutzer hat abgebrochen'), true);
  const cancelled = await cancelHarness.service.waitFor(cancelView.jobId).catch((error) => {
    const described = (error as { code?: string; message?: string }) ?? {};
    return { status: 'FAILED', error: { code: described.code ?? '?', message: described.message ?? '?' } } as never;
  });
  assert.equal(cancelled.status, 'CANCELLED', `Abbruch endet als ${cancelled.status}: ${cancelled.error?.message}`);
  assert.equal(cancelled.result, undefined, 'abgebrochener Job hat keine fertigen Stems');
  assert.equal(cancelled.percent < 100, true, 'kein 100%-Bericht nach Abbruch');
  assert.equal(await sha256File(cancelHarness.inputPath), hashBefore, 'Original ist byte-identisch');
  assert.ok(lastOf(cancelHarness.events, 'cancelled'), 'cancelled-Event wurde gemeldet');
  const cancelStem = await cancelHarness.service.stemBytes(cancelView.jobId, 'kick').then(() => 'ok', (error) => (error as { code: string }).code);
  assert.equal(cancelStem, 'STEM_CONFIG_INVALID', 'nach Abbruch gibt es keinen lesbaren Stem');
  console.log(`  ✓ ${cancelView.jobId} CANCELLED, Original-Hash unverändert, stemBytes → STEM_CONFIG_INVALID`);

  console.log('\n[ TEST ] #8 Pause/Fortsetzung: Job läuft weiter und endet korrekt');
  const pauseHarness = await makeHarness({ slowMsPerFrame: 0.02 });
  const pauseView = await pauseHarness.service.start({
    inputPath: pauseHarness.inputPath,
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    trackName: 'edm_pause',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  assert.equal(pauseHarness.service.pause('unbekannt'), false, 'Pause für unbekannten Job ist abweisbar');
  assert.equal(pauseHarness.service.resume('unbekannt'), false);
  assert.equal(pauseHarness.service.pause(pauseView.jobId), true);
  // Kooperative Pause: der laufende Chunk wird zu Ende gerechnet (ein Modell
  // lässt sich mitten im Tensor nicht anhalten), danach darf es nicht
  // weitergehen. Also: genug Zeit für den laufenden Chunk geben, dann stillstehen.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const paused = pauseHarness.service.getJob(pauseView.jobId)!;
  assert.notEqual(paused.status, 'COMPLETED', 'pause() hält den Job an');
  const percentAtPause = paused.percent;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(pauseHarness.service.getJob(pauseView.jobId)!.percent, percentAtPause, 'während der Pause wächst kein Fortschritt über Chunk-Grenzen');
  assert.equal(pauseHarness.service.resume(pauseView.jobId), true);
  const resumed = await pauseHarness.service.waitFor(pauseView.jobId);
  assert.equal(resumed.status, 'COMPLETED', `nach Fortsetzung fertig (Status ${resumed.status})`);
  assert.equal(resumed.result!.stems.length, 3, 'Pause verändert das Ergebnis nicht');
  assert.equal(resumed.result!.validationPass, true, 'validiertes Ergebnis wie ohne Pause');
  console.log(`  ✓ pausiert bei ${percentAtPause}%, stillgestanden, fortgesetzt → ${resumed.result!.stems.length} valide Stems`);

  console.log('\n[ TEST ] #9 Node-Bridge: strukturierte Ergebnisse statt IPC-Rejects');
  const bridge = createStemBridge({
    root: path.join(probe.root, 'bridge'),
    registry: ModelRegistry.fromBundledCatalog({ extra: [tripleDescriptor()] }),
    allowPipelineDouble: true,
    chunkSizeSamples: CHUNK_SAMPLES,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator() }),
  });
  assert.equal(bridge.version, STEM_BRIDGE_VERSION);
  const bridgeStatus = await bridge.status();
  assert.equal(bridgeStatus.ok, true);
  assert.equal(bridgeStatus.ok && bridgeStatus.data.profiles.length, 3);
  const bridgeStarted = await bridge.start({
    inputPath: probe.inputPath,
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    trackName: 'edm_bridge',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  assert.equal(bridgeStarted.ok, true, 'start() über die Bridge');
  assert.equal(bridgeStarted.ok && bridgeStarted.data.stems.length, 3, 'die Bridge meldet die Deskriptor-Stems');
  const bridgeJobId = bridgeStarted.ok ? bridgeStarted.data.jobId : '';
  const bridgeDone = await bridge.wait(bridgeJobId);
  assert.equal(bridgeDone.ok && bridgeDone.data.status, 'COMPLETED');
  const bridgeStem = await bridge.stem(bridgeJobId, 'melody');
  assert.equal(bridgeStem.ok, true);
  assert.ok(bridgeStem.ok && bridgeStem.data.wav instanceof Uint8Array, 'Uint8Array statt Buffer (structured-clone-sicher)');
  assert.ok(bridgeStem.ok && bridgeStem.data.wav.length > 44);
  const missing = await bridge.wait('stem_gibtsnicht');
  assert.equal(missing.ok, false, 'unbekannter Job darf nicht als Erfolg durchgehen');
  assert.equal(missing.ok === false && typeof missing.code, 'string');
  assert.ok(missing.ok === false && /Unbekannter Stem-Job/.test(missing.message));
  const badModel = await bridge.start({ inputPath: probe.inputPath, modelId: 'gibt-es-nicht' });
  assert.equal(badModel.ok, false);
  assert.ok(badModel.ok === false && badModel.code === 'MODEL_MISSING', 'Modellfehler bleibt typisiert');
  const noInput = await bridge.start({ profile: 'HIGH_QUALITY' });
  assert.equal(noInput.ok, false);
  assert.ok(noInput.ok === false && noInput.code === 'AUDIO_MISSING', 'ohne Quelle kein Job');
  bridge.close();
  console.log('  ✓ bridge: status/start/wait/stem ok, Fehler als { ok:false, code }');

  console.log('\n[ TEST ] #10 Bytes vom Renderer landen in Staging/, nie am Original');
  const hashOfOriginal = await sha256File(probe.inputPath);
  const mixBytes = await readFile(probe.inputPath);
  const staged = await probe.service.start({
    bytes: new Uint8Array(mixBytes),
    trackName: 'renderer mix!',
    profile: 'PREVIEW',
    modelId: 'triple-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
  });
  const stagedDone = await probe.service.waitFor(staged.jobId);
  assert.equal(stagedDone.status, 'COMPLETED', `Renderer-Bytes laufen durch (${stagedDone.error?.message ?? ''})`);
  assert.notEqual(stagedDone.trackName, undefined);
  const stagedSummary = (await probe.service.jobMetadata(staged.jobId)) as { inputPath: string };
  assert.ok(stagedSummary.inputPath.includes(path.join('Staging')), `Staging-Pfad statt Original: ${stagedSummary.inputPath}`);
  assert.equal(stagedSummary.inputPath.startsWith(path.join(probe.root, 'Original')), false, 'Original-Verzeichnis wird nicht beschrieben');
  assert.equal(await sha256File(probe.inputPath), hashOfOriginal, 'Original bleibt auch beim Staging-Lauf unverändert');
  console.log(`  ✓ ${path.basename(stagedSummary.inputPath)} in Staging/, TrackName „${staged.trackName}“ bereinigt`);

  for (const harness of [probe, cancelHarness, pauseHarness]) {
    await rm(harness.root, { recursive: true, force: true });
  }
  console.log('\n✔ STEM JOB SERVICE: alle Prüfungen bestanden');
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
