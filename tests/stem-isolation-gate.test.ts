import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateGoldStandardTrack, TEST_SEED } from '../src/stems/goldStandard';
import { buildGoldStandardVariants } from '../src/stems/goldStandardVariants';
import { buildStemGroupMap, sumStems } from '../src/stems/stemGroupMapping';
import { evaluateStem, measureBleed, qualityScore, sdr, siSdr, MAX_SDR_DB } from '../src/stems/metrics';
import { downmixMono } from '../src/stems/dsp';
import { planChunks, SeparationCancellationToken } from '../src/stems/chunkProcessor';
import { measureContinuity, OverlapAddReconstructor, SILENT_DB } from '../src/stems/reconstructor';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { createDefaultBackendFactory, StemSeparationEngine } from '../src/stems/stemSeparationEngine';
import { runStemIsolationGate } from '../src/stems/stemIsolationGate';
import { encodeWavFloat32, fileFingerprint, readWavFile, sha256File } from '../src/stems/wavIo';
import { StemSeparationError } from '../src/stems/errors';

const checks: string[] = [];
function ok(label: string): void { checks.push(label); console.log(`  ✓ ${label}`); }

function makeEngine(root: string, name: string, double = new PipelineDoubleSeparator({ mode: 'coherent' }), outputRoot?: string): StemSeparationEngine {
  return new StemSeparationEngine({
    workingRoot: path.join(root, name, 'working'),
    outputRoot: outputRoot ?? path.join(root, name, 'output'),
    cacheRoot: path.join(root, name, 'cache'),
    modelStoreDir: path.join(root, name, 'models'),
    allowPipelineDouble: true,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: double }),
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error }; }
}

async function testGoldStandardTrack(): Promise<void> {
  console.log('\n[1] Goldstandard-Track: 30 s, deterministisch, 6 Ground-Truth-Stems');
  const track = generateGoldStandardTrack();
  assert.equal(track.seed, TEST_SEED);
  assert.equal(track.seconds, 30);
  assert.equal(track.sampleRate, 44100);
  assert.equal(track.channels, 2);
  assert.equal(track.frames, 44100 * 30);
  assert.deepEqual([...track.stems.keys()].sort(), ['bass', 'drums', 'fx', 'percussion', 'synth', 'vocals']);
  assert.equal(track.segments.length, 6);
  track.segments.forEach((segment, index) => {
    assert.equal(segment.startSeconds, index * 5, `Segment ${segment.id} beginnt falsch`);
    assert.equal(segment.endSeconds, (index + 1) * 5, `Segment ${segment.id} endet falsch`);
  });
  for (const [id, data] of track.stems) {
    let energy = 0;
    for (const value of data) { assert.ok(Number.isFinite(value), `Stem ${id} enthält NaN/Inf`); energy += value * value; }
    assert.ok(energy > 0, `Stem ${id} ist stumm`);
  }
  const repeat = generateGoldStandardTrack();
  assert.deepEqual(track.mix, repeat.mix, 'gleicher Seed muss bitidentischen Mix liefern');
  assert.notDeepEqual(track.mix, generateGoldStandardTrack({ seed: TEST_SEED + 1 }).mix, 'anderer Seed muss anderen Mix liefern');
  ok(`30 s @ ${track.sampleRate} Hz, Seed ${track.seed}, 6 Segmente, deterministisch`);

  const sum = new Float32Array(track.mix.length);
  for (const data of track.stems.values()) for (let i = 0; i < sum.length; i++) sum[i] += data[i];
  let maxError = 0;
  for (let i = 0; i < sum.length; i++) maxError = Math.max(maxError, Math.abs(sum[i] - track.mix[i]));
  assert.ok(maxError < 1e-5, `Summe(Stems) weicht vom Mix ab: ${maxError}`);
  let peak = 0;
  for (const value of track.mix) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak <= 0.9, `Mix übersteuert (peak ${peak})`);
  ok(`Mix ist exakte Summe der Stems (max. Abweichung ${maxError.toExponential(2)}), Peak ${peak.toFixed(3)}`);

  const overlaps: [string, string, string][] = [
    ['sub-overlap', 'drums', 'bass'],
    ['kick-bass-synth', 'bass', 'synth'],
    ['vocal-synth', 'vocals', 'synth'],
    ['hats-percussion-stereo', 'percussion', 'synth'],
    ['dense-edm', 'fx', 'vocals'],
  ];
  for (const [segmentId, a, b] of overlaps) {
    const segment = track.segments.find((s) => s.id === segmentId);
    assert.ok(segment, `Segment ${segmentId} fehlt`);
    assert.ok(segment.overlapPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a)), `Segment ${segmentId} deklariert keinen Overlap ${a}<->${b}`);
  }
  ok('Frequenzüberlappungen (Kick/Bass, Bass/Synth, Vocal/Synth, Perc/Synth, FX/Vocal) deklariert');
}

async function testVariantsAndMapping(): Promise<void> {
  console.log('\n[2] Mix-Varianten und Stem-Group-Mapping');
  const track = generateGoldStandardTrack();
  const variants = buildGoldStandardVariants(track);
  assert.ok(variants.length >= 15, `erwartet >=15 Varianten, erhalten ${variants.length}`);
  assert.equal(new Set(variants.map((v) => v.id)).size, variants.length, 'Varianten-IDs müssen eindeutig sein');
  for (const variant of variants) {
    assert.equal(variant.buffer.frames, track.frames, `Variante ${variant.id} hat falsche Länge`);
    let energy = 0;
    for (const value of variant.buffer.data) { assert.ok(Number.isFinite(value), `Variante ${variant.id} enthält NaN/Inf`); energy += value * value; }
    assert.ok(energy > 0, `Variante ${variant.id} ist Stille`);
  }
  const width = (data: Float32Array): number => {
    let mid = 0, side = 0;
    for (let f = 0; f < track.frames; f++) { const l = data[f * 2], r = data[f * 2 + 1]; mid += ((l + r) / 2) ** 2; side += ((l - r) / 2) ** 2; }
    return Math.sqrt(side / Math.max(1e-18, mid));
  };
  const wide = variants.find((v) => v.id === 'I_stereo_widened')!;
  const narrow = variants.find((v) => v.id === 'J_mono_compatible')!;
  assert.ok(width(wide.buffer.data) > width(narrow.buffer.data), 'Stereo-Widened muss breiter sein als Mono-Compatible');
  ok(`${variants.length} Varianten, alle endlich/nichtleer, Breitenmanipulation messbar`);

  const map = buildStemGroupMap(['vocals', 'drums', 'bass', 'other'], track.stemOrder);
  assert.equal(map.unassigned.length, 0);
  assert.deepEqual(map.groups.get('other')?.sort(), ['fx', 'percussion', 'synth']);
  assert.deepEqual(map.groups.get('vocals'), ['vocals']);
  const combined = sumStems(track.stems, ['fx', 'percussion', 'synth'], track.frames, 2);
  for (let i = 0; i < combined.length; i++) {
    const expected = track.stems.get('fx')![i] + track.stems.get('percussion')![i] + track.stems.get('synth')![i];
    assert.ok(Math.abs(combined[i] - expected) < 1e-6, 'sumStems muss die exakte Summe liefern');
  }
  ok('4-Stem-Modell: other = {fx+percussion+synth}, keine unzugeordnete Quelle');
}

async function testMetrics(): Promise<void> {
  console.log('\n[3] Metriken: Selbstvergleich, Degradation, Stille, Skaleninvarianz');
  const track = generateGoldStandardTrack();
  const signal = (id: string) => ({ data: track.stems.get(id)!, channels: 2, frames: track.frames, sampleRate: track.sampleRate });
  const others = [...track.stems.entries()].filter(([id]) => id !== 'vocals').map(([id, data]) => ({ id, signal: { data, channels: 2, frames: track.frames, sampleRate: track.sampleRate } }));

  const perfect = evaluateStem('vocals', signal('vocals'), signal('vocals'), others);
  assert.ok(perfect.siSdrDb > 100, `Selbstvergleich muss sehr hohen SI-SDR liefern, war ${perfect.siSdrDb}`);
  assert.equal(perfect.transients.preserved, true);
  assert.equal(perfect.stereo.becameMono, false);
  const perfectScore = qualityScore(perfect);
  assert.ok(perfectScore.score > 8 && perfectScore.score < 10, `Selbstvergleich-Score unplausibel: ${perfectScore.score}`);
  ok(`Selbstvergleich SI-SDR ${perfect.siSdrDb.toFixed(0)} dB, Score ${perfectScore.score.toFixed(2)} (nie 10)`);

  // Regression: a silent estimate must never be scored as a perfect separation.
  const silent = { ...signal('vocals'), data: new Float32Array(track.frames * 2) };
  const silentMetrics = evaluateStem('vocals', signal('vocals'), silent, others);
  assert.equal(silentMetrics.sdrDb, -MAX_SDR_DB, `stummer Stem muss -${MAX_SDR_DB} dB SDR liefern, war ${silentMetrics.sdrDb}`);
  assert.equal(silentMetrics.siSdrDb, -MAX_SDR_DB, `stummer Stem muss -${MAX_SDR_DB} dB SI-SDR liefern, war ${silentMetrics.siSdrDb}`);
  assert.ok(qualityScore(silentMetrics).score <= 1.5, 'stummer Stem darf nicht als brauchbar bewertet werden');
  ok('Stiller Stem -> minimaler SDR/SI-SDR und minimaler Score (keine Fehlbewertung als perfekt)');

  // SI-SDR ignores a pure gain offset, plain SDR must not.
  const mono = downmixMono(track.stems.get('vocals')!, 2, track.frames);
  const quiet = mono.map((v) => v * 0.1);
  assert.ok(siSdr(mono, quiet) > 100, `SI-SDR muss skaleninvariant sein, war ${siSdr(mono, quiet)}`);
  assert.ok(sdr(mono, quiet) < 20, `SDR muss den Pegelfehler bestrafen, war ${sdr(mono, quiet)}`);
  ok(`Skaleninvarianz: SI-SDR ${siSdr(mono, quiet).toFixed(0)} dB vs. SDR ${sdr(mono, quiet).toFixed(1)} dB bei -20 dB Pegelfehler`);

  const noisy = new Float32Array(track.stems.get('vocals')!.length);
  let state = 12345;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  for (let i = 0; i < noisy.length; i++) noisy[i] = track.stems.get('vocals')![i] + (random() * 2 - 1) * 0.05;
  const noisyMetrics = evaluateStem('vocals', signal('vocals'), { ...signal('vocals'), data: noisy }, others);
  assert.ok(noisyMetrics.siSdrDb < perfect.siSdrDb && noisyMetrics.siSdrDb > 0, `Rauschen muss messbar degradieren: ${noisyMetrics.siSdrDb}`);
  assert.ok(qualityScore(noisyMetrics).score < perfectScore.score, 'verrauschter Stem muss schlechter bewertet werden');
  ok(`Rauschen degradiert SI-SDR auf ${noisyMetrics.siSdrDb.toFixed(1)} dB und senkt den Score`);
}

async function testBleedTransientStereo(): Promise<void> {
  console.log('\n[4] Bleed-, Transienten- und Stereo-Test');
  const track = generateGoldStandardTrack();
  const asSignal = (id: string, data?: Float32Array) => ({ data: data ?? track.stems.get(id)!, channels: 2, frames: track.frames, sampleRate: track.sampleRate });
  const interferer = [{ id: 'vocals', signal: asSignal('vocals') }];
  const wrong = evaluateStem('bass', asSignal('bass'), asSignal('vocals'), interferer);
  const clean = evaluateStem('bass', asSignal('bass'), asSignal('bass'), interferer);
  const worstWrong = Math.max(...wrong.bleed.map((b) => b.bleedDb));
  const worstClean = Math.max(...clean.bleed.map((b) => b.bleedDb));
  assert.ok(worstWrong > worstClean + 10, `Bleed muss falsche Quelle klar anzeigen: ${worstWrong} vs ${worstClean}`);
  assert.equal(measureBleed('bass', downmixMono(track.stems.get('bass')!, 2, track.frames), downmixMono(track.stems.get('bass')!, 2, track.frames), []).length, 0);
  ok(`Bleed sauber ${worstClean.toFixed(1)} dB vs. falsche Quelle ${worstWrong.toFixed(1)} dB`);

  const blockFrames = Math.floor(track.sampleRate * 1.25);
  const gated = new Float32Array(track.frames * 2);
  for (let f = 0; f < track.frames; f++) {
    const gain = Math.floor(f / blockFrames) % 2 === 0 ? 1 : 0;
    gated[f * 2] = track.stems.get('drums')![f * 2] * gain;
    gated[f * 2 + 1] = track.stems.get('drums')![f * 2 + 1] * gain;
  }
  const drums = evaluateStem('drums', asSignal('drums'), asSignal('drums', gated), []);
  assert.ok(drums.transients.referenceCount > 0, 'Drums müssen Transienten enthalten');
  assert.ok(drums.transients.missingCount > 0, 'entfernte Transienten müssen erkannt werden');
  assert.equal(drums.transients.preserved, false);
  ok(`${drums.transients.missingCount}/${drums.transients.referenceCount} Transienten als fehlend erkannt`);

  const synth = track.stems.get('synth')!;
  const collapsed = new Float32Array(synth.length);
  const widened = new Float32Array(synth.length);
  for (let f = 0; f < track.frames; f++) {
    const l = synth[f * 2], r = synth[f * 2 + 1], mid = (l + r) / 2, side = (l - r) / 2;
    collapsed[f * 2] = mid; collapsed[f * 2 + 1] = mid;
    widened[f * 2] = mid + side * 3; widened[f * 2 + 1] = mid - side * 3;
  }
  assert.equal(evaluateStem('synth', asSignal('synth'), asSignal('synth', collapsed), []).stereo.becameMono, true, 'Mono-Kollaps muss erkannt werden');
  const wide = evaluateStem('synth', asSignal('synth'), asSignal('synth', widened), []).stereo;
  assert.ok(wide.widthDeltaDb > 0 && !wide.becameMono, 'künstliche Verbreiterung muss positives widthDelta zeigen');
  ok(`Mono-Kollaps erkannt, Verbreiterung +${wide.widthDeltaDb.toFixed(2)} dB, kein Fehlalarm`);
}

async function testChunkBoundaries(): Promise<void> {
  console.log('\n[5] Chunk-Boundary-Test: Overlap-Add vs. Single-Pass');
  const track = generateGoldStandardTrack();
  const plans = planChunks({ totalFrames: track.frames, chunkSamples: 65536, overlapFraction: 0.5, sampleRate: track.sampleRate });
  assert.ok(plans.length >= 2, 'Testtrack muss in mehrere Chunks zerfallen');
  const reconstructor = new OverlapAddReconstructor({ totalFrames: track.frames, channels: 2, plans });
  for (const plan of plans) reconstructor.add(plan, track.mix.subarray(plan.startSample * 2, plan.endSample * 2));
  const boundaries = plans.slice(1).map((p) => p.startSample);
  const report = measureContinuity(reconstructor.finalize(), 2, track.frames, boundaries, track.mix);
  assert.equal(report.excessDb, SILENT_DB, `Chunk-Grenzen dürfen keine Fehler erzeugen (excessDb=${report.excessDb})`);
  assert.ok(report.rmsJumpDb < 0.5, `keine Pegelsprünge erwartet (${report.rmsJumpDb} dB)`);
  assert.equal(report.duplicateTransients, 0);
  assert.equal(report.missingTransients, 0);
  ok(`${plans.length} Chunks, excessDb ${report.excessDb.toFixed(1)}, 0 doppelte/fehlende Transienten`);

  // A deliberately broken reconstruction must be caught, otherwise the check is worthless.
  const broken = reconstructor.finalize();
  const boundary = boundaries[0];
  for (let f = boundary; f < Math.min(track.frames, boundary + 400); f++) { broken[f * 2] = 0; broken[f * 2 + 1] = 0; }
  const brokenReport = measureContinuity(broken, 2, track.frames, boundaries, track.mix);
  assert.ok(brokenReport.excessDb > report.excessDb, 'zerstörte Rekonstruktion muss einen höheren Fehler melden');
  assert.ok(brokenReport.rmsJumpDb > report.rmsJumpDb, 'zerstörte Chunk-Grenze muss einen Pegelsprung melden');
  ok(`Sabotierte Chunk-Grenze wird erkannt (excessDb ${brokenReport.excessDb.toFixed(1)}, Sprung ${brokenReport.rmsJumpDb.toFixed(1)} dB)`);
}

async function testPipelineBehaviour(root: string, mixPath: string): Promise<void> {
  console.log('\n[6] Determinismus, Original-Integrität, Abbruch, Fehlerfälle');
  const runA = await makeEngine(root, 'det-a').separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'det_a' });
  const runB = await makeEngine(root, 'det-b').separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'det_b' });
  assert.equal(runA.stems.length, runB.stems.length);
  for (let i = 0; i < runA.stems.length; i++) {
    const [a, b] = await Promise.all([readWavFile(runA.stems[i].filePath), readWavFile(runB.stems[i].filePath)]);
    assert.deepEqual(a.data, b.data, `Stem ${runA.stems[i].id} ist nicht deterministisch`);
  }
  ok(`${runA.stems.length} Stems bitidentisch über zwei unabhängige Läufe`);

  const before = await fileFingerprint(mixPath);
  const token = new SeparationCancellationToken();
  const cancelled = await settle(makeEngine(root, 'cancel', new PipelineDoubleSeparator({ mode: 'coherent', simulatedMsPerFrame: 0.01 })).separate({
    inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'cancel', token,
    onProgress: () => token.cancel(),
  }));
  assert.ok(!cancelled.ok || cancelled.value.status === 'CANCELLED', 'Abbruch darf nie COMPLETED mit Teilergebnis liefern');
  const after = await fileFingerprint(mixPath);
  assert.equal(after.sha256, before.sha256, 'Original muss nach Abbruch unverändert sein');
  assert.equal(after.size, before.size);
  const cancelLabel = cancelled.ok === true ? cancelled.value.status : (cancelled.error as StemSeparationError).code;
  ok(`Abbruch -> ${cancelLabel}, Original-Hash unverändert`);

  const engine = makeEngine(root, 'errors');
  const empty = path.join(root, 'empty.wav');
  await writeFile(empty, Buffer.alloc(0));
  const emptyResult = await settle(engine.separate({ inputPath: empty, modelId: 'pipeline-double-v1', trackName: 'empty' }));
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.ok === false && emptyResult.error instanceof StemSeparationError, 'leere Datei muss klassifizierten Fehler liefern');
  assert.ok(['AUDIO_CORRUPT', 'AUDIO_UNSUPPORTED_FORMAT', 'AUDIO_MISSING'].includes((emptyResult as { error: StemSeparationError }).error.code));

  const missing = await settle(engine.separate({ inputPath: path.join(root, 'does-not-exist.wav'), modelId: 'pipeline-double-v1', trackName: 'missing' }));
  assert.ok(missing.ok === false && (missing.error as StemSeparationError).code === 'AUDIO_MISSING');

  const unknown = await settle(engine.separate({ inputPath: mixPath, modelId: 'gibt-es-nicht', trackName: 'unknown' }));
  assert.ok(unknown.ok === false && (unknown.error as StemSeparationError).code === 'INVALID_REQUEST');

  const oneSample = path.join(root, 'one-sample.wav');
  await writeFile(oneSample, encodeWavFloat32(44100, 2, new Float32Array([0.1, -0.1]), 1));
  const single = await settle(engine.separate({ inputPath: oneSample, modelId: 'pipeline-double-v1', trackName: 'one_sample' }));
  if (single.ok === false) assert.ok(single.error instanceof StemSeparationError, '1-Sample-Datei muss klassifizierten Fehler liefern');
  ok('Fehlermatrix: leere Datei, fehlende Datei, unbekanntes Modell, 1-Sample-Datei alle klassifiziert');

  const readOnly = path.join(root, 'read-only');
  await makeEngine(root, 'perm', new PipelineDoubleSeparator(), readOnly).separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'warmup' });
  await chmod(readOnly, 0o500);
  const denied = await settle(makeEngine(root, 'perm2', new PipelineDoubleSeparator(), readOnly).separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'denied' }));
  await chmod(readOnly, 0o700);
  assert.equal(denied.ok, false, 'fehlendes Schreibrecht muss einen Fehler liefern');
  assert.equal((denied as { error: StemSeparationError }).error.code, 'WRITE_DENIED');
  assert.equal(await sha256File(mixPath), before.sha256, 'Original muss auch nach Schreibfehler unverändert sein');
  ok('WRITE_DENIED bei fehlendem Schreibrecht, Original unangetastet');
}

async function testGateEndToEnd(root: string): Promise<void> {
  console.log('\n[7] Stem Isolation Gate End-to-End und Report-Layout');
  const outputRoot = path.join(root, 'test_run');
  const report = await runStemIsolationGate({
    engine: makeEngine(root, 'gate'),
    outputRoot,
    request: { modelId: 'pipeline-double-v1', chunkSizeSamples: 65536, overlap: 0.5 },
  });
  assert.equal(report.gate, 'STEM_ISOLATION');
  assert.equal(report.part, 2);
  assert.equal(report.originalHashBefore, report.originalHashAfter, 'Original-Hash muss im Gate-Lauf unverändert sein');
  assert.equal(report.technicalPass, true, 'technischer Teil muss bestehen');
  assert.equal(report.fromTrainedModel, false);
  assert.equal(report.qualityPass, false, 'Pipeline-Double darf die Quality-Gate niemals bestehen');
  assert.equal(report.releaseDecision, 'TECHNICAL_PASS_QUALITY_FAIL', 'ohne trainiertes Modell nie RELEASE_READY');
  assert.ok(report.rows.length > 0, 'Ergebnistabelle darf nicht leer sein');
  for (const row of report.rows) {
    for (const key of ['isolation', 'bleed', 'transient', 'stereo', 'recombination'] as const) {
      assert.ok(Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 10, `${row.stemId}.${key} außerhalb 0..10: ${row[key]}`);
    }
    assert.ok(row.groundTruthComponents.length > 0, `${row.stemId} ohne Ground-Truth-Zuordnung`);
  }
  assert.ok(['TECHNICAL_FAIL', 'TECHNICAL_PASS_QUALITY_FAIL', 'RELEASE_READY'].includes(report.releaseDecision));
  assert.equal(report.checks.find((c) => c.id === 'ORIGINAL_HASH_UNCHANGED')?.pass, true);
  assert.equal(report.checks.find((c) => c.id === 'FROM_TRAINED_MODEL')?.pass, false);
  assert.equal(report.checks.find((c) => c.id === 'STEM_ISOLATION_GATE')?.pass, false);
  ok(`Release-Entscheidung ${report.releaseDecision}, Score ${report.overallScore.toFixed(2)}/10, ${report.rows.length} Stems`);

  const expected = [
    'metadata.json', 'original/mix.wav', 'recombined/mix.wav', 'metrics/metrics.json', 'report/report.html',
    'ground_truth/vocals.wav', 'ground_truth/drums.wav', 'ground_truth/bass.wav',
    'ground_truth/synth.wav', 'ground_truth/percussion.wav', 'ground_truth/fx.wav',
    'separated/vocals.wav', 'separated/drums.wav', 'separated/bass.wav', 'separated/other.wav',
  ];
  for (const rel of expected) await readFile(path.join(outputRoot, rel));
  const metrics = JSON.parse(await readFile(path.join(outputRoot, 'metrics', 'metrics.json'), 'utf8'));
  assert.equal(metrics.gate, 'STEM_ISOLATION');
  assert.equal(metrics.releaseDecision, report.releaseDecision);
  const metadata = JSON.parse(await readFile(path.join(outputRoot, 'metadata.json'), 'utf8'));
  assert.equal(metadata.qualityPass, false);
  assert.equal(metadata.segments.length, 6);
  const html = await readFile(path.join(outputRoot, 'report', 'report.html'), 'utf8');
  assert.ok(html.includes('Stem Isolation Gate'));
  assert.ok(html.includes(report.releaseDecision));
  for (const row of report.rows) assert.ok(html.includes(`<td>${row.stemId}</td>`), `Report zeigt ${row.stemId} nicht`);
  const groundTruth = await readWavFile(path.join(outputRoot, 'ground_truth', 'vocals.wav'));
  assert.equal(groundTruth.frames, 44100 * 30, 'Ground-Truth muss die volle Tracklänge haben');
  ok(`${expected.length} Report-Pfade vorhanden, metrics.json/metadata.json/report.html konsistent`);

  const failing = await runStemIsolationGate({
    engine: makeEngine(root, 'gate-split', new PipelineDoubleSeparator({ mode: 'split' })),
    outputRoot: path.join(root, 'test_run_split'),
    request: { modelId: 'pipeline-double-v1' },
  });
  assert.equal(failing.qualityPass, false);
  assert.notEqual(failing.releaseDecision, 'RELEASE_READY', 'auch ein anderes Double-Verhalten darf nie RELEASE_READY liefern');
  ok(`Alternatives Double-Verhalten -> ${failing.releaseDecision} (nie RELEASE_READY)`);
}

async function run(): Promise<void> {
  console.log('══ STEM ISOLATION GATE (TEIL 2) ══');
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-gate-'));
  try {
    await testGoldStandardTrack();
    await testVariantsAndMapping();
    await testMetrics();
    await testBleedTransientStereo();
    await testChunkBoundaries();
    const track = generateGoldStandardTrack();
    const mixPath = path.join(root, 'mix.wav');
    await writeFile(mixPath, encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames));
    await testPipelineBehaviour(root, mixPath);
    await testGateEndToEnd(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\nstem-isolation-gate: ${checks.length} Prüfungen bestanden`);
  console.log('Hinweis: Qualitätsurteil beruht auf dem Pipeline-Double, daher ist');
  console.log('TECHNICAL_PASS_QUALITY_FAIL das korrekte Ergebnis (siehe docs/STEM_SEPARATION_ENGINE.md).');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
