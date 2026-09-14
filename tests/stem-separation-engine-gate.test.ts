/**
 * TECHNICAL GATE (part 1, §20).
 *
 * INPUT AUDIO -> READ-ONLY ORIGINAL -> WORKING COPY -> 44.1 kHz STEREO
 * -> MODEL INFERENCE -> CHUNKED INFERENCE -> OVERLAP-ADD -> STEM FILES
 * -> VALIDATION -> JOB METADATA -> CACHE
 *
 * plus: original hash before == original hash after (otherwise FAIL),
 * cancellation behaviour (§15), recovery (§17), error matrix (§16) and the
 * boundary artefact checks (§14).
 *
 * The separation in this file is produced by the deterministic pipeline double
 * (explicitly NOT a trained model) so the pipeline is testable without a
 * 300 MB checkpoint. The trained path is covered by
 * `stem-separation-bsroformer-live.test.ts`.
 */
import assert from 'node:assert/strict';
import { restoreWriteAccess, simulateWriteDenial } from './support/permissionProbe';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemSeparationEngine, createDefaultBackendFactory, DEFAULT_CHUNK_OVERLAP } from '../src/stems/stemSeparationEngine';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';
import { runTechnicalGate } from '../src/stems/qualityGate';
import { SeparationCancellationToken, planChunks, validateChunkPlan } from '../src/stems/chunkProcessor';
import { OverlapAddReconstructor } from '../src/stems/reconstructor';
import { encodeWavFloat32, readWavFile, parseWavLayout, sha256File, analyzeAudio } from '../src/stems/wavIo';
import { SeparationCache, buildCacheKey } from '../src/stems/separationCache';
import { StemSeparationError } from '../src/stems/errors';
import type { QualityProfile } from '../src/stems/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM SEPARATION ENGINE – TECHNICAL GATE (TEIL 1)               ');
console.log('═══════════════════════════════════════════════════════════════════');

const CHUNK_SAMPLES = 44100; // 1 s – forces several chunks on a 3 s track

function makeEngine(root: string, double: PipelineDoubleSeparator, overrides: Record<string, unknown> = {}) {
  return new StemSeparationEngine({
    workingRoot: path.join(root, 'Working'),
    outputRoot: path.join(root, 'Separation'),
    cacheRoot: path.join(root, 'Cache'),
    modelStoreDir: path.join(root, 'Models'),
    allowPipelineDouble: true,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: double }),
    ...overrides,
  });
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-gate-'));
  const originalDir = path.join(root, 'Original');
  await mkdir(originalDir, { recursive: true });

  const track = generateEdmTestTrack({ seconds: 3 });
  const written = await writeTestAudio(originalDir, 'edm_gate', track);
  const inputPath = written.mixPath;
  const hashBefore = await sha256File(inputPath);
  const originalBytes = await readFile(inputPath);

  // =====================================================================
  console.log('\n[ TEST ] #1 Chunk-Plan: überlappende Segmente, lückenlose Abdeckung');
  const plans = planChunks({ totalFrames: track.frames, chunkSamples: CHUNK_SAMPLES, overlapFraction: 0.5, sampleRate: 44100 });
  const coverage = validateChunkPlan(plans, track.frames);
  assert.ok(coverage.ok, `Chunk-Plan ungültig: ${coverage.problems.join('; ')}`);
  assert.ok(plans.length >= 4, `erwartet >= 4 Chunks, erhalten ${plans.length}`);
  assert.equal(plans[0].startSample, 0);
  assert.equal(plans[plans.length - 1].endSample, track.frames);
  for (let i = 1; i < plans.length; i++) {
    assert.ok(plans[i].startSample < plans[i - 1].endSample, 'Segmente müssen überlappen');
  }
  console.log(`  ✓ ${plans.length} Chunks: ${plans.map((plan) => `${plan.startSample}-${plan.endSample}`).join(' | ')}`);
  console.log(`  ✓ Überlappung je Grenze: ${plans[1].overlapIn} Samples (${((plans[1].overlapIn / CHUNK_SAMPLES) * 100).toFixed(0)} %)`);

  // Overlap-Add must be exact for identical chunk content (identity property).
  const identity = new OverlapAddReconstructor({ totalFrames: track.frames, channels: 2, plans });
  for (const plan of plans) identity.add(plan, track.mix.subarray(plan.startSample * 2, plan.endSample * 2));
  const reconstructed = identity.finalize();
  let identityError = 0;
  for (let i = 0; i < reconstructed.length; i++) identityError = Math.max(identityError, Math.abs(reconstructed[i] - track.mix[i]));
  assert.ok(identityError < 1e-6, `Overlap-Add ist nicht exakt (max. Fehler ${identityError})`);
  console.log(`  ✓ Overlap-Add identitätstreu, max. Fehler ${identityError.toExponential(2)}`);

  // =====================================================================
  console.log('\n[ TEST ] #2 Kompletter Durchlauf über das QualityGate (§20)');
  const double = new PipelineDoubleSeparator({ mode: 'coherent' });
  const engine = makeEngine(root, double);
  const gate = await runTechnicalGate({
    engine,
    inputPath,
    expectChunks: 4,
    reportPath: path.join(root, 'stem-test-output', 'technical-gate-report.json'),
    request: { modelId: 'pipeline-double-v1', chunkSizeSamples: CHUNK_SAMPLES, overlap: 0.5, trackName: 'edm_gate' },
  });
  for (const check of gate.checks) {
    console.log(`  ${check.pass ? '✓' : '✘'} ${check.id}: ${check.detail}`);
  }
  assert.ok(gate.pass, `Technical Gate fehlgeschlagen: ${JSON.stringify(gate.checks.filter((check) => !check.pass), null, 2)}`);
  assert.equal(gate.originalHashBefore, gate.originalHashAfter, 'Original-Hash muss unverändert sein');
  assert.equal(gate.summary.failed, 0);
  console.log(`  ✓ Gate bestanden (${gate.summary.passed}/${gate.summary.total} Prüfungen, ${gate.durationMs} ms)`);

  // =====================================================================
  console.log('\n[ TEST ] #3 Nicht-destruktiv: Original byte-identisch und nur lesend');
  const hashAfter = await sha256File(inputPath);
  const bytesAfter = await readFile(inputPath);
  assert.equal(hashAfter, hashBefore, 'Original-Hash verändert – FAIL');
  assert.ok(bytesAfter.equals(originalBytes), 'Original-Bytes verändert – FAIL');
  const workingFiles = await readdir(path.join(root, 'Working'));
  assert.ok(workingFiles.some((file) => file.endsWith('_44.1k_stereo.wav')), 'Arbeitskopie fehlt');
  const originalDirFiles = await readdir(originalDir);
  assert.deepEqual(
    originalDirFiles.sort(),
    ['edm_gate_bass.wav', 'edm_gate_drums.wav', 'edm_gate_mixture.wav', 'edm_gate_other.wav', 'edm_gate_vocals.wav'],
    'im Original-Ordner darf nichts Neues entstehen'
  );
  console.log(`  ✓ sha256 vorher == nachher (${hashBefore.slice(0, 16)}…)`);
  console.log(`  ✓ Arbeitskopie: ${workingFiles.find((file) => file.includes('44.1k'))}`);
  console.log(`  ✓ Original-Ordner unverändert (${originalDirFiles.length} Dateien)`);

  // =====================================================================
  console.log('\n[ TEST ] #4 Arbeitskopie ist 44,1 kHz Stereo float32');
  const workingPath = path.join(root, 'Working', 'edm_gate_44.1k_stereo.wav');
  const workingLayout = parseWavLayout(new Uint8Array(await readFile(workingPath)));
  assert.equal(workingLayout.sampleRate, 44100);
  assert.equal(workingLayout.channels, 2);
  assert.equal(workingLayout.formatTag, 3, 'IEEE float erwartet');
  assert.equal(workingLayout.bitsPerSample, 32);
  console.log(`  ✓ ${workingLayout.sampleRate} Hz / ${workingLayout.channels} ch / float${workingLayout.bitsPerSample}`);

  // =====================================================================
  console.log('\n[ TEST ] #5 Resampling: 48 kHz Quelle wird bandbegrenzt auf 44,1 kHz');
  const track48 = generateEdmTestTrack({ seconds: 2, sampleRate: 48000, seed: 7 });
  const written48 = await writeTestAudio(path.join(root, 'Original48'), 'edm48', track48);
  const engine48 = makeEngine(root, new PipelineDoubleSeparator());
  const result48 = await engine48.separate({
    inputPath: written48.mixPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    trackName: 'edm48',
  });
  assert.equal(result48.status, 'COMPLETED');
  const layout48 = parseWavLayout(new Uint8Array(await readFile(path.join(root, 'Working', 'edm48_44.1k_stereo.wav'))));
  assert.equal(layout48.sampleRate, 44100, 'Arbeitskopie muss 44,1 kHz haben');
  const expectedFrames = Math.round(track48.frames * (44100 / 48000));
  assert.ok(Math.abs(layout48.dataSize / 8 - expectedFrames) <= 2, `Framezahl ${layout48.dataSize / 8} != erwartet ${expectedFrames}`);
  const stem48 = await readWavFile(result48.stems[0].filePath);
  assert.equal(stem48.sampleRate, 44100);
  console.log(`  ✓ 48000 Hz -> 44100 Hz, ${track48.frames} -> ${Math.floor(layout48.dataSize / 8)} Frames (erwartet ~${expectedFrames})`);

  // =====================================================================
  console.log('\n[ TEST ] #6 Mono-Quelle wird dupliziert, nie heruntergemischt');
  const monoFrames = 44100;
  const mono = new Float32Array(monoFrames);
  for (let i = 0; i < monoFrames; i++) mono[i] = 0.4 * Math.sin((2 * Math.PI * 110 * i) / 44100);
  const monoPath = path.join(root, 'Original', 'mono.wav');
  await writeFile(monoPath, encodeWavFloat32(44100, 1, mono, monoFrames));
  const monoResult = await engine.separate({
    inputPath: monoPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    trackName: 'mono',
  });
  assert.equal(monoResult.status, 'COMPLETED');
  const monoWorking = parseWavLayout(new Uint8Array(await readFile(path.join(root, 'Working', 'mono_44.1k_stereo.wav'))));
  assert.equal(monoWorking.channels, 2, 'Arbeitskopie muss Stereo sein');
  assert.ok(monoResult.stems.every((stem) => stem.channelCount === 2), 'alle Stems müssen Stereo sein');
  const monoAudio = await readWavFile(path.join(root, 'Working', 'mono_44.1k_stereo.wav'));
  let maxSideEnergy = 0;
  for (let f = 0; f < monoAudio.frames; f++) {
    maxSideEnergy = Math.max(maxSideEnergy, Math.abs(monoAudio.data[f * 2] - monoAudio.data[f * 2 + 1]));
  }
  assert.ok(maxSideEnergy < 1e-6, 'Mono-Duplikat darf keinen Side-Anteil erfinden');
  console.log('  ✓ Mono -> Stereo dupliziert, Side-Anteil 0 (kein Downmix, kein erfundenes Stereo)');

  // =====================================================================
  console.log('\n[ TEST ] #7 Stereo-Erhaltung: Breite bleibt in den Stems erhalten');
  const mixAudio = await readWavFile(inputPath);
  const mixStats = analyzeAudio(mixAudio.data, 2, mixAudio.frames);
  let widestStem = 0;
  for (const stem of gate.checks.find((check) => check.id === 'STEM_FILES_VALIDATED') ? [] : []) void stem;
  const jobDir = path.join(root, 'Separation', 'edm_gate');
  const jobMeta = JSON.parse(await readFile(path.join(jobDir, 'job.json'), 'utf8'));
  for (const stem of jobMeta.stems) {
    const audio = await readWavFile(path.join(jobDir, `${stem.id}.wav`));
    const stats = analyzeAudio(audio.data, 2, audio.frames);
    assert.equal(audio.channels, 2, `${stem.id} muss Stereo sein`);
    widestStem = Math.max(widestStem, stats.sideToMidRatio);
    assert.ok(Number.isFinite(stats.stereoCorrelation));
  }
  assert.ok(widestStem > 0.01, 'mindestens ein Stem muss Side-Anteile enthalten (Stereo-Breite)');
  console.log(`  ✓ Mix Side/Mid ${mixStats.sideToMidRatio.toFixed(3)}, breitester Stem ${widestStem.toFixed(3)}`);

  // =====================================================================
  console.log('\n[ TEST ] #8 Chunk-Grenzen: keine Klicks, keine Pegel-/Stereo-Sprünge');
  assert.ok(jobMeta.validation, 'job.json muss den Validierungsbericht enthalten');
  const gateContinuity = gate.checks.find((check) => check.id === 'OVERLAP_ADD_RECONSTRUCTION')!.evidence!
    .continuity as typeof jobMeta.validation.continuity;
  const validation = { ...jobMeta.validation, continuity: gateContinuity };
  assert.ok(validation.pass, `Validierung fehlgeschlagen: ${JSON.stringify(validation.issues)}`);
  assert.ok(validation.continuity.excessDb < 6, `Grenzüberschuss ${validation.continuity.excessDb} dB`);
  assert.ok(validation.continuity.rmsJumpDb < 9, `Pegelsprung ${validation.continuity.rmsJumpDb} dB`);
  assert.ok(validation.continuity.stereoJump < 0.35, `Stereo-Sprung ${validation.continuity.stereoJump}`);
  assert.equal(validation.continuity.duplicateTransients, 0, 'keine doppelten Transienten');
  assert.equal(validation.continuity.missingTransients, 0, 'keine fehlenden Transienten');
  assert.deepEqual(validation.continuity.boundarySampleOffsets, plans.slice(1).map((plan) => plan.startSample),
    'die gemessenen Grenzen müssen exakt den Chunk-Grenzen entsprechen');
  console.log(`  ✓ Grenzüberschuss ${validation.continuity.excessDb.toFixed(1)} dB (Innensprung ${validation.continuity.interiorDeltaDb.toFixed(1)} dB)`);
  console.log(`  ✓ Pegelsprung ${validation.continuity.rmsJumpDb.toExponential(1)} dB, Stereo-Sprung ${validation.continuity.stereoJump.toExponential(1)}`);
  console.log(`  ✓ Transienten: 0 doppelt, 0 fehlend an ${validation.continuity.boundarySampleOffsets.length} Grenzen (${validation.continuity.boundarySampleOffsets.join(', ')})`);

  // =====================================================================
  console.log('\n[ TEST ] #9 Ohne Overlap entstehen hörbare Grenzen – Overlap-Add behebt sie');
  // The incoherent double simulates a model whose estimate drops off towards a
  // chunk edge (no context there). With hard cuts those dips stay in the
  // result; with 50 % overlap the neighbouring chunk covers them.
  const hardEngine = makeEngine(root, new PipelineDoubleSeparator({ mode: 'incoherent', edgeFadeSamples: 1024 }), {
    cacheRoot: path.join(root, 'CacheHard'),
    recombinationLimitDb: -30,
    boundaryErrorExcessDb: 12,
  });
  const hardCut = await hardEngine
    .separate({ inputPath, modelId: 'pipeline-double-v1', chunkSizeSamples: CHUNK_SAMPLES, overlap: 0, trackName: 'edm_hardcut' })
    .catch((error: StemSeparationError) => error);
  const overlapEngine = makeEngine(root, new PipelineDoubleSeparator({ mode: 'incoherent', edgeFadeSamples: 1024 }), {
    cacheRoot: path.join(root, 'CacheOverlap'),
    recombinationLimitDb: -30,
    boundaryErrorExcessDb: 12,
  });
  const overlapped = await overlapEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_overlap',
  });

  assert.ok(hardCut instanceof StemSeparationError, 'harte Schnitte müssen als Grenzartefakt erkannt werden');
  assert.equal(hardCut.code, 'VALIDATION_FAILED');
  const hardValidation = hardCut.details.validation as {
    continuity: { boundaryErrorDb: number; interiorErrorDb: number; boundaryErrorExcessDb: number };
    recombinationErrorDb: number;
    issues: { code: string }[];
  };
  assert.ok(
    hardValidation.issues.some((issue) => issue.code === 'BOUNDARY_SPECIFIC_ERROR'),
    `erwartete BOUNDARY_SPECIFIC_ERROR, erhielt ${JSON.stringify(hardValidation.issues.map((issue) => issue.code))}`
  );
  assert.ok(hardValidation.continuity.boundaryErrorExcessDb > 20, `Grenzfehler sollte dominant sein, Überschuss ${hardValidation.continuity.boundaryErrorExcessDb}`);

  assert.equal(overlapped.status, 'COMPLETED', 'mit 50 % Überlappung muss die Rekonstruktion bestehen');
  assert.ok(overlapped.validation?.pass, JSON.stringify(overlapped.validation?.issues));
  assert.ok(overlapped.validation.continuity.boundaryErrorExcessDb < 12, 'kein grenzspezifischer Fehler mit Überlappung');
  const improvement = hardValidation.recombinationErrorDb - overlapped.validation.recombinationErrorDb;
  assert.ok(improvement > 30, `Überlappung muss den Rekombinationsfehler deutlich senken, Verbesserung ${improvement.toFixed(1)} dB`);
  console.log(`  ✓ harte Schnitte: Grenzfehler ${hardValidation.continuity.boundaryErrorDb.toFixed(1)} dB vs. ${hardValidation.continuity.interiorErrorDb.toFixed(1)} dB innen -> +${hardValidation.continuity.boundaryErrorExcessDb.toFixed(0)} dB (VALIDATION_FAILED)`);
  console.log(`  ✓ mit 50 % Overlap-Add: Grenzfehler ${overlapped.validation.continuity.boundaryErrorDb.toFixed(1)} dB, Überschuss ${overlapped.validation.continuity.boundaryErrorExcessDb.toFixed(1)} dB`);
  console.log(`  ✓ Rekombinationsfehler: ${hardValidation.recombinationErrorDb.toFixed(1)} dB -> ${overlapped.validation.recombinationErrorDb.toFixed(1)} dB (${improvement.toFixed(0)} dB besser)`);

  // =====================================================================
  console.log('\n[ TEST ] #10 Chunk-basierte Inferenz wird je Segment ausgeführt');
  const countingDouble = new PipelineDoubleSeparator();
  const countingEngine = makeEngine(root, countingDouble, { cacheRoot: path.join(root, 'CacheCount') });
  const progress: { percent: number; chunkIndex?: number; chunkCount?: number }[] = [];
  const counted = await countingEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_count',
    onProgress: (entry) => progress.push({ percent: entry.percent, chunkIndex: entry.chunkIndex, chunkCount: entry.chunkCount }),
  });
  assert.equal(counted.status, 'COMPLETED');
  assert.equal(countingDouble.invocationCount, counted.metadata.chunkCount, 'Backend muss je Chunk einmal laufen');
  assert.ok(progress.length > 5, 'Fortschritt muss berichtet werden');
  assert.ok(progress.some((entry) => entry.chunkIndex === 0 && entry.chunkCount === counted.metadata.chunkCount));
  assert.ok(progress[progress.length - 1].percent >= 99, 'Fortschritt muss 100 % erreichen');
  console.log(`  ✓ ${countingDouble.invocationCount} Backend-Aufrufe für ${counted.metadata.chunkCount} Chunks`);
  console.log(`  ✓ ${progress.length} Fortschrittsmeldungen, letzte ${progress[progress.length - 1].percent.toFixed(0)} %`);

  // =====================================================================
  console.log('\n[ TEST ] #11 Job-Metadaten sind vollständig und reproduzierbar (§11)');
  const meta = counted.metadata;
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.inputAudioHash, hashBefore, 'input_audio_hash muss dem Original entsprechen');
  assert.equal(meta.settings.modelId, 'pipeline-double-v1');
  assert.ok(meta.settings.modelVersion.length > 0);
  assert.ok(meta.settings.modelHash.length > 0);
  assert.equal(meta.settings.backend, 'in-process');
  assert.equal(meta.settings.precision, 'f32');
  assert.equal(meta.settings.sampleRate, 44100);
  assert.equal(meta.settings.channels, 2);
  assert.equal(meta.settings.chunkOverlap, 0.5);
  assert.ok(meta.settingsHash.length === 64);
  assert.equal(meta.cacheKey, buildCacheKey(meta.inputAudioHash, meta.settings.modelHash, meta.settingsHash));
  assert.ok(meta.timing.startedAt > 0 && (meta.timing.totalMs ?? 0) >= 0);
  assert.ok(meta.events.length > 3, 'Event-Trace erwartet');
  assert.equal(meta.settings.profile, 'HIGH_QUALITY');
  assert.equal(meta.stems.length, 4);
  for (const stem of meta.stems) {
    assert.ok(stem.sha256.length === 64, `${stem.id}: Hash fehlt`);
    assert.ok(stem.bytes > 1000, `${stem.id}: unplausible Größe`);
    assert.equal(stem.complete, true, `${stem.id} nicht als vollständig markiert`);
  }
  console.log(`  ✓ jobId ${meta.jobId}`);
  console.log(`  ✓ input ${meta.inputAudioHash.slice(0, 12)}… model ${meta.settings.modelId}@${meta.settings.modelVersion} hash ${meta.settings.modelHash}`);
  console.log(`  ✓ backend ${meta.settings.backend} precision ${meta.settings.precision} overlap ${meta.settings.chunkOverlap} settings ${meta.settingsHash.slice(0, 12)}…`);

  // =====================================================================
  console.log('\n[ TEST ] #12 Cache: identische Parameter vermeiden erneute Inferenz (§12)');
  const callsBefore = countingDouble.invocationCount;
  const cached = await countingEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_count',
  });
  assert.equal(cached.cacheHit, true, 'zweiter Lauf muss aus dem Cache kommen');
  assert.equal(countingDouble.invocationCount, callsBefore, 'keine erneute Inferenz erlaubt');
  assert.deepEqual(
    cached.stems.map((stem) => stem.sha256),
    counted.stems.map((stem) => stem.sha256),
    'Cache muss identische Stems liefern'
  );
  const differentOverlap = await countingEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.25,
    trackName: 'edm_count_overlap',
  });
  assert.equal(differentOverlap.cacheHit, false, 'geänderte Parameter dürfen keinen Cache-Treffer erzeugen');
  assert.ok(countingDouble.invocationCount > callsBefore, 'neue Parameter müssen neu berechnet werden');
  console.log(`  ✓ Cache-Treffer ohne neuen Backend-Lauf (${callsBefore} Aufrufe vorher und nachher)`);
  console.log(`  ✓ andere Überlappung -> neue Inferenz (${countingDouble.invocationCount} Aufrufe)`);

  // a corrupt cache entry must be invalidated, not trusted
  const cache = new SeparationCache(path.join(root, 'CacheCount'));
  const entryDir = cache.entryDirectory(counted.metadata.cacheKey);
  const stemFiles = await readdir(path.join(entryDir, 'stems'));
  await writeFile(path.join(entryDir, 'stems', stemFiles[0]), 'zerstoert');
  const afterCorruption = await countingEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_count',
  });
  assert.equal(afterCorruption.cacheHit, false, 'beschädigter Cache darf nicht verwendet werden');
  assert.equal(afterCorruption.status, 'COMPLETED');
  console.log('  ✓ beschädigter Cache-Eintrag wird invalidiert und neu berechnet');

  // =====================================================================
  console.log('\n[ TEST ] #13 Abbruch: Status CANCELLED, keine fertigen Stems (§15, §17)');
  const slowDouble = new PipelineDoubleSeparator({ simulatedMsPerFrame: 0.02 });
  const cancelEngine = makeEngine(root, slowDouble, { cacheRoot: path.join(root, 'CacheCancel') });
  const token = new SeparationCancellationToken();
  const cancelPromise = cancelEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_cancel',
    token,
    onProgress: (entry) => {
      if ((entry.chunkIndex ?? 0) >= 1) token.cancel('Abbruch im Test');
    },
  });
  const cancelled = await cancelPromise;
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.stems.length, 0, 'abgebrochene Läufe dürfen keine Stems melden');
  assert.equal(cancelled.metadata.error?.code, 'INFERENCE_CANCELLED');
  const cancelDir = path.join(root, 'Separation', 'edm_cancel');
  const cancelFiles = (await readdir(cancelDir).catch(() => [] as string[])).filter((file) => file.endsWith('.wav'));
  assert.equal(cancelFiles.length, 0, 'keine Stem-Dateien nach Abbruch');
  const cancelMeta = JSON.parse(await readFile(path.join(cancelDir, 'job.json'), 'utf8'));
  assert.equal(cancelMeta.status, 'CANCELLED');
  assert.deepEqual(cancelMeta.stems, []);
  assert.equal(cancelMeta.originalIntegrity.unchanged, true, 'Original muss nach Abbruch unverändert sein');
  assert.equal(await sha256File(inputPath), hashBefore);
  console.log(`  ✓ Status CANCELLED nach Abbruch bei Chunk ${(cancelMeta.events.find((event: { phase: string }) => event.phase.startsWith('chunk:')) ? '>=1' : '1')}`);
  console.log('  ✓ 0 Stem-Dateien, job.json = CANCELLED, Original unverändert');

  // pause/resume must not corrupt the run
  const pauseDouble = new PipelineDoubleSeparator({ simulatedMsPerFrame: 0.005 });
  const pauseEngine = makeEngine(root, pauseDouble, { cacheRoot: path.join(root, 'CachePause') });
  const pauseToken = new SeparationCancellationToken();
  let paused = false;
  const pausePromise = pauseEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_pause',
    token: pauseToken,
    onProgress: (entry) => {
      if (!paused && (entry.chunkIndex ?? 0) >= 1) {
        paused = true;
        pauseToken.pause();
        setTimeout(() => pauseToken.resume(), 60);
      }
    },
  });
  const pausedResult = await pausePromise;
  assert.equal(pausedResult.status, 'COMPLETED');
  assert.ok(paused, 'Pause muss ausgelöst worden sein');
  assert.ok(pausedResult.validation?.pass);
  console.log('  ✓ Pause/Resume verändert das Ergebnis nicht (Status COMPLETED, Validierung bestanden)');

  // =====================================================================
  console.log('\n[ TEST ] #14 Fehlermatrix (§16)');
  const errors: [string, () => Promise<unknown>, string][] = [
    [
      'Modell fehlt in der Registry',
      () => engine.separate({ inputPath, modelId: 'gibt-es-nicht', trackName: 'err1' }),
      'MODEL_MISSING',
    ],
    [
      'Checkpoint nicht installiert',
      () =>
        makeEngine(root, new PipelineDoubleSeparator(), {
          cacheRoot: path.join(root, 'CacheMissingModel'),
          modelStoreDir: path.join(root, 'EmptyModels'),
        }).separate({ inputPath, modelId: 'bsroformer-viperx-vocals-1297', trackName: 'err2' }),
      'MODEL_MISSING',
    ],
    [
      'Pipeline-Double ohne Freigabe',
      () =>
        new StemSeparationEngine({
          workingRoot: path.join(root, 'Working'),
          outputRoot: path.join(root, 'Separation'),
          cacheRoot: path.join(root, 'CacheNoDouble'),
          modelStoreDir: path.join(root, 'Models'),
        }).separate({ inputPath, modelId: 'pipeline-double-v1', trackName: 'err3' }),
      'MODEL_INCOMPATIBLE',
    ],
  ];
  for (const [title, action, expected] of errors) {
    const error = (await action().then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
    assert.ok(error instanceof StemSeparationError, `${title}: erwartete StemSeparationError`);
    assert.equal(error.code, expected, `${title}: erwartete ${expected}, erhielt ${error.code}`);
    console.log(`  ✓ ${title} -> ${error.code}`);
  }

  // damaged audio
  const corruptPath = path.join(root, 'Original', 'corrupt.wav');
  await writeFile(corruptPath, Buffer.from('RIFFxxxxWAVEund dann nur Müll'));
  const corruptError = (await engine
    .separate({ inputPath: corruptPath, modelId: 'pipeline-double-v1', trackName: 'err4' })
    .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
  assert.ok(['AUDIO_CORRUPT', 'AUDIO_UNSUPPORTED_FORMAT'].includes(corruptError.code), `erwartete AUDIO_CORRUPT, erhielt ${corruptError.code}`);
  console.log(`  ✓ beschädigtes Audio -> ${corruptError.code}`);

  const missingAudio = (await engine
    .separate({ inputPath: path.join(root, 'Original', 'gibt-es-nicht.wav'), modelId: 'pipeline-double-v1', trackName: 'err5' })
    .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
  assert.equal(missingAudio.code, 'AUDIO_MISSING');
  console.log(`  ✓ fehlendes Audio -> ${missingAudio.code}`);

  // invalid sample rate
  const badRatePath = path.join(root, 'Original', 'badrate.wav');
  const badRate = new Float32Array(4000);
  for (let i = 0; i < badRate.length; i++) badRate[i] = 0.1;
  const badRateBytes = encodeWavFloat32(4000, 2, badRate, 2000);
  const view = new DataView(badRateBytes.buffer);
  view.setUint32(24, 4000, true);
  await writeFile(badRatePath, badRateBytes);
  const badRateError = (await engine
    .separate({ inputPath: badRatePath, modelId: 'pipeline-double-v1', trackName: 'err6' })
    .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
  assert.equal(badRateError.code, 'AUDIO_INVALID_SAMPLE_RATE');
  console.log(`  ✓ ungültige Samplerate -> ${badRateError.code}`);

  // unsupported format (no decoder injected)
  const mp3Path = path.join(root, 'Original', 'track.mp3');
  await writeFile(mp3Path, Buffer.from('ID3 fake mp3'));
  const formatError = (await engine
    .separate({ inputPath: mp3Path, modelId: 'pipeline-double-v1', trackName: 'err7' })
    .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
  assert.equal(formatError.code, 'AUDIO_UNSUPPORTED_FORMAT');
  console.log(`  ✓ nicht unterstütztes Format ohne Decoder -> ${formatError.code}`);

  // missing write permission
  const readOnlyRoot = path.join(root, 'ReadOnly');
  await mkdir(readOnlyRoot, { recursive: true });
  const writable = await simulateWriteDenial(readOnlyRoot);
  if (writable) {
    console.log('  – Schreibrechte-Simulation unwirksam (Windows/ACL oder Root): Fall übersprungen');
  } else {
    const permissionError = (await new StemSeparationEngine({
      workingRoot: path.join(root, 'Working'),
      outputRoot: readOnlyRoot,
      cacheRoot: path.join(root, 'CachePerm'),
      modelStoreDir: path.join(root, 'Models'),
      allowPipelineDouble: true,
      backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator() }),
    })
      .separate({ inputPath, modelId: 'pipeline-double-v1', trackName: 'err8' })
      .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
    assert.equal(permissionError?.code, 'WRITE_DENIED', `erwartete WRITE_DENIED, erhielt ${permissionError?.code}`);
    console.log(`  ✓ fehlende Schreibrechte -> ${permissionError.code}`);
  }
  await restoreWriteAccess(readOnlyRoot);

  // invalid stem configuration
  const stemError = (await engine
    .separate({ inputPath, modelId: 'pipeline-double-v1', stems: ['guitar'], trackName: 'err9' })
    .then(() => undefined, (caught: unknown) => caught)) as StemSeparationError;
  assert.equal(stemError.code, 'STEM_CONFIG_INVALID');
  console.log(`  ✓ ungültige Stem-Konfiguration -> ${stemError.code}`);

  // after every failure the original must still be untouched
  assert.equal(await sha256File(inputPath), hashBefore, 'Original nach Fehlerfällen verändert – FAIL');
  console.log('  ✓ Original nach allen Fehlerfällen unverändert');

  // =====================================================================
  console.log('\n[ TEST ] #15 Profile steuern Engine und Parameter (§6)');
  const status = await engine.status();
  for (const profile of ['PREVIEW', 'HIGH_QUALITY', 'MAXIMUM_QUALITY'] as QualityProfile[]) {
    const model = engine.resolveModel(profile);
    assert.equal(model.id, status.profiles[profile]);
    console.log(`  ✓ ${profile.padEnd(16)} -> ${status.profiles[profile]} (${model.family})`);
  }
  assert.equal(DEFAULT_CHUNK_OVERLAP.MAXIMUM_QUALITY > DEFAULT_CHUNK_OVERLAP.PREVIEW, true, 'höhere Profile brauchen mehr Überlappung');
  const maxSettings = engine.buildSettings(engine.resolveModel('MAXIMUM_QUALITY'), 'MAXIMUM_QUALITY', { inputPath }, {
    capabilities: () => ({ supportedPrecision: ['f32', 'native', 'bf16', 'f16', 'q8_0'] }),
  } as never);
  const previewSettings = engine.buildSettings(engine.resolveModel('PREVIEW'), 'PREVIEW', { inputPath }, {
    capabilities: () => ({ supportedPrecision: ['f32'] }),
  } as never);
  assert.ok(maxSettings.numOverlap >= 4, 'MAXIMUM_QUALITY braucht hohe num_overlap');
  assert.ok(maxSettings.ensemblePasses >= 3, 'MAXIMUM_QUALITY nutzt Ensemble-Pässe');
  assert.ok(maxSettings.chunkOverlap > previewSettings.chunkOverlap, 'MAXIMUM_QUALITY überlappt stärker als PREVIEW');
  assert.equal(previewSettings.family, 'htdemucs', 'PREVIEW nutzt die schnellere Engine');
  console.log(`  ✓ MAXIMUM_QUALITY: num_overlap ${maxSettings.numOverlap}, ensemble ${maxSettings.ensemblePasses}, chunk-overlap ${maxSettings.chunkOverlap}`);
  console.log(`  ✓ PREVIEW: ${previewSettings.family} num_overlap ${previewSettings.numOverlap}, chunk-overlap ${previewSettings.chunkOverlap}`);

  // =====================================================================
  console.log('\n[ TEST ] #16 Ergebnislayout (§3) und Historie bei Neu-Läufen');
  const layoutFiles = (await readdir(jobDir)).sort();
  assert.ok(layoutFiles.includes('vocals.wav') && layoutFiles.includes('drums.wav') && layoutFiles.includes('bass.wav') && layoutFiles.includes('other.wav'));
  assert.ok(layoutFiles.includes('job.json'));
  assert.ok(!layoutFiles.includes('.partial'), 'temporäre Dateien müssen aufgeräumt sein');
  console.log(`  ✓ Separation/edm_gate/: ${layoutFiles.join(', ')}`);

  const rerunDifferentSettings = await engine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES * 2,
    overlap: 0.5,
    trackName: 'edm_gate',
  });
  assert.equal(rerunDifferentSettings.status, 'COMPLETED');
  const history = await readdir(path.join(jobDir, '.history')).catch(() => [] as string[]);
  assert.ok(history.length >= 1, 'früheres Ergebnis muss archiviert werden');
  console.log(`  ✓ vorheriger Lauf archiviert nach .history/${history[0]}`);

  // =====================================================================
  console.log('\n[ TEST ] #17 Validierung erkennt manipulierte Stem-Dateien (§17)');
  const tamperDir = path.join(root, 'Separation', 'edm_gate');
  const drumsPath = path.join(tamperDir, 'drums.wav');
  const drumsBytes = await readFile(drumsPath);
  const truncated = drumsBytes.subarray(0, drumsBytes.length - 4000);
  await writeFile(drumsPath, truncated);
  const cache2 = new SeparationCache(path.join(root, 'Cache'));
  const key = buildCacheKey(hashBefore, 'synthetic:pipeline-double-v1-deterministic', counted.metadata.settingsHash);
  void key;
  const rerun = await engine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: CHUNK_SAMPLES,
    overlap: 0.5,
    trackName: 'edm_gate',
  });
  assert.equal(rerun.status, 'COMPLETED', 'Neu-Berechnung muss die manipulierte Datei ersetzen');
  const repaired = parseWavLayout(new Uint8Array(await readFile(drumsPath)));
  assert.equal(Math.floor(repaired.dataSize / 8), track.frames, 'Stem muss wieder die volle Länge haben');
  console.log(`  ✓ manipulierte Stem-Datei wurde durch validierte Ausgabe ersetzt (${Math.floor(repaired.dataSize / 8)} Frames)`);

  // =====================================================================
  console.log('\n[ TEST ] #18 Qualitätsprofil MAXIMUM_QUALITY erhöht die Inferenz');
  const maxDouble = new PipelineDoubleSeparator();
  const maxEngine = makeEngine(root, maxDouble, { cacheRoot: path.join(root, 'CacheMax') });
  const maxResult = await maxEngine.separate({
    inputPath,
    modelId: 'pipeline-double-v1',
    profile: 'MAXIMUM_QUALITY',
    chunkSizeSamples: CHUNK_SAMPLES,
    trackName: 'edm_max',
  });
  assert.equal(maxResult.status, 'COMPLETED');
  assert.equal(maxResult.metadata.settings.profile, 'MAXIMUM_QUALITY');
  assert.ok(maxResult.metadata.settings.numOverlap >= 4, 'MAXIMUM_QUALITY muss num_overlap erhöhen');
  assert.ok(maxResult.metadata.settings.chunkOverlap >= 0.5, 'MAXIMUM_QUALITY braucht hohe Überlappung');
  assert.ok(maxResult.validation?.pass, JSON.stringify(maxResult.validation?.issues));

  // The parameters must actually reach the backend, not only the metadata.
  const lastBackendReport = maxDouble.lastReport();
  assert.equal(lastBackendReport?.profile, 'MAXIMUM_QUALITY');
  assert.equal(lastBackendReport?.numOverlap, maxResult.metadata.settings.numOverlap);

  // Ensemble passes are a model capability, so they are checked where the
  // real HQ models declare them: MAXIMUM_QUALITY must raise them.
  const hqDescriptor = maxEngine.registry.require('bsroformer-musdb18hq-4stem-zfturbo');
  const hqParams = maxEngine.registry.parametersFor(hqDescriptor, 'HIGH_QUALITY');
  const maxParams = maxEngine.registry.parametersFor(hqDescriptor, 'MAXIMUM_QUALITY');
  assert.ok(maxParams.ensemblePasses > hqParams.ensemblePasses, `Ensemble: ${hqParams.ensemblePasses} -> ${maxParams.ensemblePasses}`);
  assert.ok(maxParams.numOverlap > hqParams.numOverlap, `num_overlap: ${hqParams.numOverlap} -> ${maxParams.numOverlap}`);
  console.log(`  ✓ MAXIMUM_QUALITY (Double): num_overlap ${maxResult.metadata.settings.numOverlap}, chunk-overlap ${maxResult.metadata.settings.chunkOverlap}, erreicht das Backend`);
  console.log(`  ✓ MAXIMUM_QUALITY (BS-RoFormer): num_overlap ${hqParams.numOverlap} -> ${maxParams.numOverlap}, Ensemble ${hqParams.ensemblePasses} -> ${maxParams.ensemblePasses}`);

  // =====================================================================
  console.log('\n[ TEST ] #19 Gate-Bericht ist maschinenlesbar geschrieben');
  const reportPath = path.join(root, 'stem-test-output', 'technical-gate-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.gate, 'TECHNICAL_FUNCTIONALITY');
  assert.equal(report.pass, true);
  assert.ok(report.checks.length >= 10);
  assert.equal(report.originalHashBefore, report.originalHashAfter);
  console.log(`  ✓ ${reportPath}`);
  console.log(`  ✓ ${report.checks.length} Prüfungen, Original-Hash identisch`);

  await rm(path.join(root, 'Working', '.chunks'), { recursive: true, force: true });
  console.log('\n✔ TECHNICAL GATE: alle Prüfungen bestanden (Teil 1)');
  console.log(`  Arbeitsverzeichnis: ${root}`);
}

run().catch((error) => {
  console.error('\n✘ FEHLER:', error);
  process.exit(1);
});
