/**
 * TEIL 2 – Stem Isolation Gate / Goldstandard-Testtrack / Quality Gate.
 *
 * This is the acceptance-test suite for part 2 of the master prompt:
 *
 *   §2-§3   30 s deterministic goldstandard track, ground truth first
 *   §4-§9   6 segments, frequency-overlap traps, master-bus segment
 *   §10     >=15 named mix variants
 *   §11     frequency-overlap pairs that defeat naive filters
 *   §12-§14 per-stem metrics, bleed test, transient test, stereo test
 *   §15     chunk-boundary test (single pass vs chunked)
 *   §16     recombination test
 *   §17     original integrity (hash before == after, absolute rule)
 *   §18     error-case matrix (reuses/extends the technical gate's matrix)
 *   §19     crash-recovery
 *   §20     determinism
 *   §21     regression tests
 *   §26     report directory layout
 *   §27     result table
 *   §28     hard fail conditions
 *   §29     Stem Isolation Gate
 *   §31     Release Decision (exactly one of the three states)
 *
 * Runs entirely against the deterministic PipelineDoubleSeparator so it is
 * usable in any CI container without GPU/PyTorch/checkpoints. Because the
 * double is *not* a trained model, every quality verdict here is expected to
 * land on `TECHNICAL_PASS_QUALITY_FAIL` — this file proves the GATE is
 * correct (it must never fabricate a PASS without real separation), not that
 * any given model is "release ready". The real-model run is a separate,
 * optional path (`tests/stem-isolation-gate-live.test.ts` when trained
 * weights are available; see docs/STEM_SEPARATION_ENGINE.md §14).
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StemSeparationEngine, createDefaultBackendFactory } from '../src/stems/stemSeparationEngine';
import { PipelineDoubleSeparator } from '../src/stems/backends/pipelineDoubleSeparator';
import { generateGoldStandardTrack, TEST_SEED } from '../src/stems/goldStandard';
import { buildGoldStandardVariants } from '../src/stems/goldStandardVariants';
import { buildStemGroupMap, sumStems } from '../src/stems/stemGroupMapping';
import { evaluateStem, qualityScore, sdr, siSdr, MAX_SDR_DB, MAX_QUALITY_SCORE } from '../src/stems/metrics';
import { runStemIsolationGate } from '../src/stems/stemIsolationGate';
import { downmixMono } from '../src/stems/dsp';
import { OverlapAddReconstructor, measureContinuity } from '../src/stems/reconstructor';
import { planChunks, SeparationCancellationToken } from '../src/stems/chunkProcessor';
import { encodeWavFloat32, fileFingerprint, readWavFile, sha256File } from '../src/stems/wavIo';
import { StemSeparationError } from '../src/stems/errors';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  STEM SEPARATION ENGINE – STEM ISOLATION GATE (TEIL 2)          ');
console.log('═══════════════════════════════════════════════════════════════════');

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

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    const value = await promise;
    return { ok: true as const, value };
  } catch (error) {
    return { ok: false as const, error };
  }
}
function outcomeLabel<T extends { status: string }>(outcome: Outcome<T>): string {
  if (outcome.ok === true) return outcome.value.status;
  const error: unknown = (outcome as { ok: false; error: unknown }).error;
  return error instanceof StemSeparationError ? error.code : String(error);
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-isolation-gate-'));

  // =====================================================================
  console.log('\n[ TEST ] #1 Goldstandard-Track: 30s, deterministisch, 6 Ground-Truth-Stems');
  const track = generateGoldStandardTrack();
  assert.equal(track.seed, TEST_SEED, 'Default-Seed muss TEST_SEED sein');
  assert.equal(track.seconds, 30, 'Track muss 30s lang sein');
  assert.equal(track.sampleRate, 44100);
  assert.equal(track.channels, 2);
  assert.equal(track.stemOrder.length, 6, 'erwartet 6 Ground-Truth-Stems');
  assert.deepEqual([...track.stems.keys()].sort(), ['bass', 'drums', 'fx', 'percussion', 'synth', 'vocals']);
  assert.equal(track.segments.length, 6, 'erwartet 6 Segmente à 5s');
  for (let i = 0; i < track.segments.length; i++) {
    assert.equal(track.segments[i].startSeconds, i * 5);
    assert.equal(track.segments[i].endSeconds, (i + 1) * 5);
  }
  const track2 = generateGoldStandardTrack();
  let maxDiff = 0;
  for (let i = 0; i < track.mix.length; i++) maxDiff = Math.max(maxDiff, Math.abs(track.mix[i] - track2.mix[i]));
  assert.equal(maxDiff, 0, 'gleicher Seed muss bitidentischen Mix liefern');
  console.log(`  ✓ 30s @ ${track.sampleRate} Hz, Seed ${track.seed}, ${track.segments.length} Segmente, deterministisch (maxDiff=${maxDiff})`);

  console.log('\n[ TEST ] #2 Mix ist exakte Summe der Ground-Truth-Stems (Voraussetzung für Recombination-Test)');
  const sum = new Float32Array(track.mix.length);
  for (const data of track.stems.values()) for (let i = 0; i < sum.length; i++) sum[i] += data[i];
  let maxSumError = 0;
  for (let i = 0; i < sum.length; i++) maxSumError = Math.max(maxSumError, Math.abs(sum[i] - track.mix[i]));
  assert.ok(maxSumError < 1e-5, `Summe der Stems weicht vom Mix ab: ${maxSumError}`);
  console.log(`  ✓ max. Abweichung Summe(Stems) vs. Mix: ${maxSumError.toExponential(2)}`);

  // =====================================================================
  console.log('\n[ TEST ] #3 >=15 Mix-Varianten (§10), alle endlich und nichtleer');
  const variants = buildGoldStandardVariants(track);
  assert.ok(variants.length >= 15, `erwartet >=15 Varianten, erhalten ${variants.length}`);
  const expectedNames = [
    'Clean',
    'Normalized',
    'Compressed',
    'Heavily Compressed',
    'Limited',
    'Very Loud',
    'Saturated',
    'Clipped',
    'Stereo-Widened',
    'Mono-Compatible',
    'Extreme Panning',
    'Heavy Reverb',
    'Heavy Delay',
    'Sidechain',
    'Dense Full Mix',
  ];
  for (const name of expectedNames) {
    assert.ok(
      variants.some((v) => v.title.toLowerCase().includes(name.toLowerCase().split(' ')[0])),
      `Variante fehlt: ${name}`
    );
  }
  for (const variant of variants) {
    let finite = true;
    let energy = 0;
    for (let i = 0; i < variant.buffer.data.length; i++) {
      if (!Number.isFinite(variant.buffer.data[i])) finite = false;
      energy += variant.buffer.data[i] * variant.buffer.data[i];
    }
    assert.ok(finite, `Variante ${variant.id} enthält NaN/Inf`);
    assert.ok(energy > 0, `Variante ${variant.id} ist Stille`);
  }
  console.log(`  ✓ ${variants.length} Varianten, alle endlich & nichtleer: ${variants.map((v) => v.id).join(', ')}`);

  // =====================================================================
  console.log('\n[ TEST ] #4 Frequenzüberlappende Segmente sind wie spezifiziert belegt (§11)');
  const overlapChecks: [string, string, string][] = [
    ['sub-overlap', 'drums', 'bass'],
    ['kick-bass-synth', 'bass', 'synth'],
    ['vocal-synth', 'vocals', 'synth'],
    ['hats-percussion-stereo', 'percussion', 'synth'],
    ['dense-edm', 'fx', 'vocals'],
  ];
  for (const [segmentId, a, b] of overlapChecks) {
    const segment = track.segments.find((s) => s.id === segmentId);
    assert.ok(segment, `Segment ${segmentId} fehlt`);
    assert.ok(
      segment!.overlapPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
      `Segment ${segmentId} deklariert keinen Overlap ${a}<->${b}`
    );
  }
  console.log('  ✓ Kick<->Bass, Bass<->Synth, Vocal<->Synth, Percussion<->Synth, FX<->Vocal jeweils im richtigen Segment deklariert');

  // =====================================================================
  console.log('\n[ TEST ] #5 Stem-Group-Mapping: jede Ground-Truth-Quelle wird einem Modell-Stem zugeordnet');
  const groupMap = buildStemGroupMap(['vocals', 'drums', 'bass', 'other'], track.stemOrder);
  assert.equal(groupMap.unassigned.length, 0, 'alle Ground-Truth-Stems müssen zugeordnet sein');
  assert.deepEqual(groupMap.groups.get('other')?.sort(), ['fx', 'percussion', 'synth']);
  console.log(`  ✓ other = {${groupMap.groups.get('other')!.join('+')}}, keine unzugeordneten Quellen`);

  // =====================================================================
  console.log('\n[ TEST ] #6 Metrik-Grundfunktionen: Referenz gegen sich selbst ist perfekt, Rauschen degradiert messbar');
  const referenceSignal = { data: track.stems.get('vocals')!, channels: 2 as const, frames: track.frames, sampleRate: track.sampleRate };
  const others = [...track.stems.entries()].filter(([id]) => id !== 'vocals').map(([id, data]) => ({ id, signal: { data, channels: 2 as const, frames: track.frames, sampleRate: track.sampleRate } }));
  const perfectMetrics = evaluateStem('vocals', referenceSignal, referenceSignal, others);
  assert.ok(perfectMetrics.siSdrDb > 100, `Selbstvergleich sollte extrem hohen SI-SDR liefern, war ${perfectMetrics.siSdrDb}`);
  assert.equal(perfectMetrics.transients.preserved, true);
  assert.equal(perfectMetrics.stereo.becameMono, false);

  const noisy = new Float32Array(referenceSignal.data.length);
  const rand = (() => {
    let s = 12345;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();
  for (let i = 0; i < noisy.length; i++) noisy[i] = referenceSignal.data[i] + (rand() * 2 - 1) * 0.05;
  const noisyMetrics = evaluateStem('vocals', referenceSignal, { ...referenceSignal, data: noisy }, others);
  assert.ok(noisyMetrics.siSdrDb < perfectMetrics.siSdrDb, 'verrauschte Schätzung muss niedrigeren SI-SDR haben');
  assert.ok(noisyMetrics.siSdrDb > 0, `moderat verrauschte Schätzung sollte noch positiven SI-SDR haben, war ${noisyMetrics.siSdrDb}`);
  // The vocals ground truth stem is itself centre-panned (L==R by
  // construction, see addVocal), so it has no side energy to lose. Use the
  // synth stem instead, which has genuine stereo width (supersaw/pluck/delay).
  const stereoReferenceSignal = { data: track.stems.get('synth')!, channels: 2 as const, frames: track.frames, sampleRate: track.sampleRate };
  const monoVersion = new Float32Array(stereoReferenceSignal.data.length);
  for (let f = 0; f < track.frames; f++) {
    const mid = (stereoReferenceSignal.data[f * 2] + stereoReferenceSignal.data[f * 2 + 1]) * 0.5;
    monoVersion[f * 2] = mid;
    monoVersion[f * 2 + 1] = mid;
  }
  const monoMetrics = evaluateStem('synth', stereoReferenceSignal, { ...stereoReferenceSignal, data: monoVersion }, others);
  assert.equal(monoMetrics.stereo.becameMono, true, 'Kollaps auf Mono muss erkannt werden (Stereo-Test darf das nie unbemerkt lassen)');
  const perfectScore = qualityScore(perfectMetrics);
  assert.ok(perfectScore.score < 10, 'qualityScore darf nie 10 vergeben (§21: 10 ist unerreichbar aus einem fertigen Stereo-Mix)');
  assert.ok(perfectScore.score > 8, `Selbstvergleich sollte extrem hoch bewertet werden, war ${perfectScore.score}`);
  console.log(`  ✓ Selbstvergleich SI-SDR=${perfectMetrics.siSdrDb.toFixed(1)} dB (score ${perfectScore.score.toFixed(2)}, nie 10), Rauschen degradiert auf ${noisyMetrics.siSdrDb.toFixed(1)} dB, Mono-Kollaps erkannt`);

  // =====================================================================
  console.log('\n[ TEST ] #7 Bleed-Test: falsche Quelle im Stem wird gemessen und ist größer als bei sauberer Trennung');
  const vocalsAsBass = evaluateStem('bass', { data: track.stems.get('bass')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate }, { data: track.stems.get('vocals')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate }, [
    { id: 'vocals', signal: { data: track.stems.get('vocals')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate } },
  ]);
  const cleanBleed = evaluateStem('bass', { data: track.stems.get('bass')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate }, { data: track.stems.get('bass')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate }, [
    { id: 'vocals', signal: { data: track.stems.get('vocals')!, channels: 2, frames: track.frames, sampleRate: track.sampleRate } },
  ]);
  const worstBleedWrong = Math.max(...vocalsAsBass.bleed.map((b) => b.bleedDb));
  const worstBleedClean = cleanBleed.bleed.length > 0 ? Math.max(...cleanBleed.bleed.map((b) => b.bleedDb)) : -100;
  assert.ok(worstBleedWrong > worstBleedClean, `Bleed einer komplett falschen Quelle (${worstBleedWrong} dB) muss höher sein als bei sauberer Trennung (${worstBleedClean} dB)`);
  console.log(`  ✓ Bleed sauber=${worstBleedClean.toFixed(1)} dB vs. komplett falsche Quelle=${worstBleedWrong.toFixed(1)} dB — Tabelle erkennt den Unterschied`);

  // =====================================================================
  console.log('\n[ TEST ] #8 Transient-Test: fehlende/duplizierte Onsets werden erkannt');
  const drumsMono = downmixMono(track.stems.get('drums')!, 2, track.frames);
  const halvedDrums = new Float32Array(drumsMono.length);
  // Remove every second half-second block worth of transients by zeroing it out
  // -> onset detector must report missing onsets, `preserved` must flip false.
  const blockFrames = Math.floor(track.sampleRate * 1.25);
  for (let i = 0; i < halvedDrums.length; i++) {
    const block = Math.floor(i / blockFrames);
    halvedDrums[i] = block % 2 === 0 ? drumsMono[i] : 0;
  }
  const drumsStereo = { data: track.stems.get('drums')!, channels: 2 as const, frames: track.frames, sampleRate: track.sampleRate };
  const halvedStereo = new Float32Array(track.frames * 2);
  for (let f = 0; f < track.frames; f++) {
    const block = Math.floor(f / blockFrames);
    const gain = block % 2 === 0 ? 1 : 0;
    halvedStereo[f * 2] = drumsStereo.data[f * 2] * gain;
    halvedStereo[f * 2 + 1] = drumsStereo.data[f * 2 + 1] * gain;
  }
  const drumMetrics = evaluateStem('drums', drumsStereo, { ...drumsStereo, data: halvedStereo }, []);
  assert.ok(drumMetrics.transients.missingCount > 0, 'entfernte Transienten müssen als fehlend erkannt werden');
  assert.equal(drumMetrics.transients.preserved, false, 'preserved muss false sein, wenn die Hälfte der Transienten fehlt');
  console.log(`  ✓ ${drumMetrics.transients.missingCount}/${drumMetrics.transients.referenceCount} Transienten als fehlend erkannt, preserved=false`);

  // =====================================================================
  console.log('\n[ TEST ] #9 Stereo-Test: Korrelation, Mid/Side, Breite, niemals unbemerkter Mono-Kollaps');
  const synthStereo = { data: track.stems.get('synth')!, channels: 2 as const, frames: track.frames, sampleRate: track.sampleRate };
  const widened = new Float32Array(synthStereo.data.length);
  for (let f = 0; f < track.frames; f++) {
    const l = synthStereo.data[f * 2];
    const r = synthStereo.data[f * 2 + 1];
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    widened[f * 2] = mid + side * 3;
    widened[f * 2 + 1] = mid - side * 3;
  }
  const stereoMetrics = evaluateStem('synth', synthStereo, { ...synthStereo, data: widened }, []);
  assert.ok(stereoMetrics.stereo.widthDeltaDb > 0, 'künstlich verbreiterte Schätzung muss positives widthDelta zeigen');
  assert.equal(stereoMetrics.stereo.becameMono, false);
  console.log(`  ✓ widthDeltaDb=${stereoMetrics.stereo.widthDeltaDb.toFixed(2)} dB bei künstlicher Verbreiterung, kein falscher Mono-Alarm`);

  // =====================================================================
  console.log('\n[ TEST ] #10 Chunk-Boundary-Test: Single-Pass vs. Chunked liefert identische Rekonstruktion (keine Klicks/Sprünge)');
  const chunkSamples = 65536;
  const plans = planChunks({ totalFrames: track.frames, chunkSamples, overlapFraction: 0.5, sampleRate: track.sampleRate });
  assert.ok(plans.length >= 2, 'Testtrack muss in mehrere Chunks zerfallen');
  const reconstructor = new OverlapAddReconstructor({ totalFrames: track.frames, channels: 2, plans });
  for (const plan of plans) reconstructor.add(plan, track.mix.subarray(plan.startSample * 2, plan.endSample * 2));
  const chunked = reconstructor.finalize();
  const continuity = measureContinuity(
    chunked,
    2,
    track.frames,
    plans.slice(1).map((p) => p.startSample),
    track.mix
  );
  assert.ok(continuity.excessDb <= 0.01, `Chunk-Grenzen dürfen keine hörbaren Klicks erzeugen (excessDb=${continuity.excessDb})`);
  assert.ok(continuity.rmsJumpDb < 0.5, `keine Pegelsprünge an Chunk-Grenzen erwartet (${continuity.rmsJumpDb} dB)`);
  assert.equal(continuity.duplicateTransients, 0, 'keine duplizierten Transienten an Chunk-Grenzen');
  assert.equal(continuity.missingTransients, 0, 'keine verlorenen Transienten an Chunk-Grenzen');
  console.log(`  ✓ ${plans.length} Chunks, excessDb=${continuity.excessDb.toExponential(2)}, rmsJump=${continuity.rmsJumpDb.toFixed(3)} dB, 0 doppelte/fehlende Transienten`);

  // =====================================================================
  console.log('\n[ TEST ] #11 Determinismus: zwei identische Läufe liefern bitidentische Stems');
  const double1 = new PipelineDoubleSeparator({ mode: 'coherent' });
  const engine1 = makeEngine(root, double1, { cacheRoot: path.join(root, 'CacheDet1') });
  const originalDir = path.join(root, 'Original');
  await mkdir(originalDir, { recursive: true });
  const mixPath = path.join(originalDir, 'determinism_mix.wav');
  await writeFile(mixPath, encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames));
  const runA = await engine1.separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', chunkSizeSamples: chunkSamples, trackName: 'det_a' });
  const double2 = new PipelineDoubleSeparator({ mode: 'coherent' });
  const engine2 = makeEngine(root, double2, { cacheRoot: path.join(root, 'CacheDet2') });
  const runB = await engine2.separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', chunkSizeSamples: chunkSamples, trackName: 'det_b' });
  assert.equal(runA.stems.length, runB.stems.length);
  for (let i = 0; i < runA.stems.length; i++) {
    const a = await readWavFile(runA.stems[i].filePath);
    const b = await readWavFile(runB.stems[i].filePath);
    assert.equal(a.data.length, b.data.length);
    let maxDelta = 0;
    for (let s = 0; s < a.data.length; s++) maxDelta = Math.max(maxDelta, Math.abs(a.data[s] - b.data[s]));
    assert.ok(maxDelta < 1e-6, `Stem ${runA.stems[i].id} nicht deterministisch reproduzierbar (maxDelta=${maxDelta})`);
  }
  console.log(`  ✓ ${runA.stems.length} Stems bitidentisch über zwei unabhängige Läufe`);

  // =====================================================================
  console.log('\n[ TEST ] #12 Original-Integrität: Hash vor/nach jedem Testlauf identisch (absolute Regel)');
  const before = await fileFingerprint(mixPath);
  const doubleFinal = new PipelineDoubleSeparator({ mode: 'coherent' });
  const engineFinal = makeEngine(root, doubleFinal, { cacheRoot: path.join(root, 'CacheFinal') });
  await engineFinal.separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', chunkSizeSamples: chunkSamples, trackName: 'integrity' });
  const after = await fileFingerprint(mixPath);
  assert.equal(before.sha256, after.sha256, 'Original-Hash muss unverändert bleiben');
  console.log(`  ✓ sha256 unverändert (${before.sha256.slice(0, 16)}…)`);

  // =====================================================================
  console.log('\n[ TEST ] #13 Crash-Recovery: Abbruch mitten im Lauf lässt Original unverändert & keine falschen "fertig"-Stems');
  const crashDouble = new PipelineDoubleSeparator({ simulatedMsPerFrame: 0.01 });
  const crashEngine = makeEngine(root, crashDouble, { cacheRoot: path.join(root, 'CacheCrash') });
  const crashToken = new SeparationCancellationToken();
  const crashHashBefore = await sha256File(mixPath);
  const crashPromise = crashEngine.separate({
    inputPath: mixPath,
    modelId: 'pipeline-double-v1',
    chunkSizeSamples: chunkSamples,
    trackName: 'crash_sim',
    token: crashToken,
    onProgress: (entry) => {
      if ((entry.chunkIndex ?? 0) >= 1) crashToken.cancel();
    },
  });
  const crashResult = await settle(crashPromise);
  assert.ok(!crashResult.ok || crashResult.value.status === 'CANCELLED', 'simulierter Absturz muss CANCELLED oder eine StemSeparationError liefern, nie COMPLETED mit Teil-Ergebnis');
  const crashHashAfter = await sha256File(mixPath);
  assert.equal(crashHashAfter, crashHashBefore, 'Original muss nach simuliertem Absturz unverändert sein');
  const crashOutcomeLabel = outcomeLabel(crashResult);
  console.log(`  ✓ simulierter Absturz -> ${crashOutcomeLabel}, Original unverändert`);

  // =====================================================================
  console.log('\n[ TEST ] #14 Fehlerfälle: 1-Sample-Datei, leere Datei, falsche Kanalzahl — Original bleibt unangetastet');
  const errEngine = makeEngine(root, new PipelineDoubleSeparator(), { cacheRoot: path.join(root, 'CacheErr') });
  const oneSamplePath = path.join(originalDir, 'one_sample.wav');
  await writeFile(oneSamplePath, encodeWavFloat32(44100, 2, new Float32Array([0.1, -0.1]), 1));
  const oneSampleResult = await settle(errEngine.separate({ inputPath: oneSamplePath, modelId: 'pipeline-double-v1', trackName: 'one_sample' }));
  // Either it degrades gracefully (COMPLETED on a near-empty result) or it fails
  // loudly with a StemSeparationError — what it must never do is silently
  // corrupt the (nonexistent) "original" or throw an unclassified error.
  if (oneSampleResult.ok === false) assert.ok(oneSampleResult.error instanceof StemSeparationError, '1-Sample-Datei muss klassifizierten Fehler liefern');
  const emptyPath = path.join(originalDir, 'empty.wav');
  await writeFile(emptyPath, Buffer.alloc(0));
  const emptyError = await errEngine
    .separate({ inputPath: emptyPath, modelId: 'pipeline-double-v1', trackName: 'empty' })
    .then(() => undefined, (e: unknown) => e as StemSeparationError);
  assert.ok(emptyError instanceof StemSeparationError, 'leere Datei muss StemSeparationError liefern');
  assert.ok(['AUDIO_CORRUPT', 'AUDIO_UNSUPPORTED_FORMAT', 'AUDIO_MISSING'].includes(emptyError.code), `unerwarteter Code für leere Datei: ${emptyError.code}`);
  const oneSampleLabel = outcomeLabel(oneSampleResult);
  console.log(`  ✓ 1-Sample-Datei behandelt (${oneSampleLabel}), leere Datei -> ${emptyError.code}`);

  // =====================================================================
  console.log('\n[ TEST ] #15 Kein Schreibrecht: klassifizierter Fehler, Original unangetastet, keine Teilschreibvorgänge sichtbar');
  const readOnlyRoot = path.join(root, 'ReadOnlyGate');
  await mkdir(readOnlyRoot, { recursive: true });
  await chmod(readOnlyRoot, 0o500);
  const permError = await new StemSeparationEngine({
    workingRoot: path.join(root, 'Working'),
    outputRoot: readOnlyRoot,
    cacheRoot: path.join(root, 'CachePermGate'),
    modelStoreDir: path.join(root, 'Models'),
    allowPipelineDouble: true,
    backendFactory: createDefaultBackendFactory({ pipelineDouble: new PipelineDoubleSeparator() }),
  })
    .separate({ inputPath: mixPath, modelId: 'pipeline-double-v1', trackName: 'perm_gate' })
    .then(() => undefined, (e: unknown) => e as StemSeparationError);
  assert.ok(permError instanceof StemSeparationError);
  assert.equal(permError.code, 'WRITE_DENIED');
  await chmod(readOnlyRoot, 0o700);
  const permHashAfter = await sha256File(mixPath);
  assert.equal(permHashAfter, crashHashBefore, 'Original muss auch nach Schreibrechte-Fehler unverändert sein');
  console.log(`  ✓ ${permError.code}, Original unverändert`);

  // =====================================================================
  console.log('\n[ TEST ] #16 Stem Isolation Gate End-to-End: Pipeline-Double MUSS QUALITY FAIL liefern (nie fabriziertes PASS)');
  const gateReport = await runStemIsolationGate({
    engine: makeEngine(root, new PipelineDoubleSeparator({ mode: 'coherent' }), { cacheRoot: path.join(root, 'CacheGateE2E') }),
    outputRoot: path.join(root, 'test_run'),
    request: { modelId: 'pipeline-double-v1', chunkSizeSamples: chunkSamples, overlap: 0.5 },
  });
  assert.equal(gateReport.originalHashBefore, gateReport.originalHashAfter, 'Original-Hash muss im Gate-Lauf unverändert sein');
  assert.equal(gateReport.technicalPass, true, 'technischer Teil muss bestehen (Pipeline läuft korrekt durch)');
  assert.equal(gateReport.qualityPass, false, 'Pipeline-Double darf niemals die Quality-Gate bestehen');
  assert.equal(gateReport.releaseDecision, 'TECHNICAL_PASS_QUALITY_FAIL', 'Release-Entscheidung muss TECHNICAL_PASS_QUALITY_FAIL sein, nie RELEASE_READY ohne echtes Modell');
  assert.ok(gateReport.rows.length > 0, 'Ergebnistabelle darf nicht leer sein');
  assert.equal(gateReport.fromTrainedModel, false);
  console.log(`  ✓ Release-Entscheidung: ${gateReport.releaseDecision} (score ${gateReport.overallScore.toFixed(2)}/10, ${gateReport.rows.length} Stems in Tabelle)`);

  console.log('\n[ TEST ] #17 Report-Verzeichnisstruktur (§26) vollständig geschrieben');
  const expectedFiles = [
    'metadata.json',
    'original/mix.wav',
    'ground_truth/vocals.wav',
    'ground_truth/drums.wav',
    'ground_truth/bass.wav',
    'ground_truth/synth.wav',
    'ground_truth/percussion.wav',
    'ground_truth/fx.wav',
    'recombined/mix.wav',
    'metrics/metrics.json',
    'report/report.html',
  ];
  for (const rel of expectedFiles) {
    const full = path.join(root, 'test_run', rel);
    await readFile(full); // throws if missing
  }
  const metricsJson = JSON.parse(await readFile(path.join(root, 'test_run', 'metrics', 'metrics.json'), 'utf8'));
  assert.equal(metricsJson.gate, 'STEM_ISOLATION');
  assert.equal(metricsJson.part, 2);
  const reportHtml = await readFile(path.join(root, 'test_run', 'report', 'report.html'), 'utf8');
  assert.ok(reportHtml.includes('Stem Isolation Gate'), 'Report muss den Gate-Namen enthalten');
  assert.ok(reportHtml.includes('TECHNICAL_PASS_QUALITY_FAIL') || reportHtml.includes(gateReport.releaseDecision));
  console.log(`  ✓ ${expectedFiles.length} erwartete Pfade vorhanden, metrics.json und report.html valide`);

  console.log('\n[ TEST ] #18 Release-Entscheidung ist immer genau einer von drei Zuständen (§31)');
  const validDecisions = ['TECHNICAL_FAIL', 'TECHNICAL_PASS_QUALITY_FAIL', 'RELEASE_READY'];
  assert.ok(validDecisions.includes(gateReport.releaseDecision));
  console.log(`  ✓ ${gateReport.releaseDecision} ist ein gültiger, eindeutiger Zustand`);

  console.log('\n[ TEST ] #19 Ein stummer Stem erreicht nie einen guten Score (Regression)');
  // Ohne Stille-Guard liefern sdr()/siSdr() fuer einen leeren Stem einen
  // PERFEKTEN Wert: der Fehler ist dann ~0, und 10*log10(x/0) laeuft in den
  // Maximalwert. Ein Backend, das schlicht nichts ausgibt, haette das Gate so
  // bestanden. Ein stummer Stem muss den schlechtesten Wert bekommen.
  const refTone = new Float64Array(4096);
  for (let i = 0; i < refTone.length; i++) refTone[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
  const silentEstimate = new Float64Array(refTone.length);
  assert.equal(sdr(refTone, silentEstimate), -MAX_SDR_DB, 'stummer Stem muss -MAX_SDR_DB liefern, nicht +MAX_SDR_DB');
  assert.equal(siSdr(refTone, silentEstimate), -MAX_SDR_DB, 'stummer Stem muss auch bei SI-SDR -MAX_SDR_DB liefern');
  console.log(`  ✓ stummer Stem -> ${-MAX_SDR_DB} dB bei sdr() und siSdr()`);

  console.log('\n[ TEST ] #20 sdr() bestraft Pegelfehler, siSdr() ignoriert ihn');
  // Die beiden Metriken duerfen nicht dieselbe Funktion sein: der
  // Recombination-Check braucht gerade die Pegelempfindlichkeit von sdr().
  const halved = Float64Array.from(refTone, (v) => v * 0.5);
  const sdrHalved = sdr(refTone, halved);
  const siSdrHalved = siSdr(refTone, halved);
  assert.ok(sdrHalved < 20, `sdr() muss -6 dB Pegelfehler bestrafen, war ${sdrHalved.toFixed(2)} dB`);
  assert.ok(siSdrHalved > 100, `siSdr() muss skaleninvariant sein, war ${siSdrHalved.toFixed(2)} dB`);
  console.log(`  ✓ Pegelfehler -6 dB: sdr=${sdrHalved.toFixed(2)} dB (bestraft), siSdr=${siSdrHalved.toFixed(2)} dB (invariant)`);

  console.log('\n[ TEST ] #21 Werte bleiben endlich und der Score erreicht nie 10 (§24)');
  assert.ok(Number.isFinite(sdr(refTone, refTone.slice())), 'identische Signale duerfen nicht Infinity liefern');
  assert.equal(sdr(refTone, refTone.slice()), MAX_SDR_DB);
  assert.ok(MAX_QUALITY_SCORE < 10, 'der Qualitaetsscore darf nie 10/10 behaupten');
  console.log(`  ✓ identisch -> ${MAX_SDR_DB} dB (endlich), Score-Deckel ${MAX_QUALITY_SCORE}`);

  // Cleanup best-effort (temp dirs are outside the repo, but keep the sandbox tidy).
  await rm(root, { recursive: true, force: true }).catch(() => {});

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALLE TEIL-2-TESTS BESTANDEN                                       ');
  console.log('  Hinweis: Qualitäts-Verdikt basiert auf Pipeline-Double / ggf.      ');
  console.log('  ungetrainierten Gewichten -> "nicht bewertbar" ist hier korrekt,   ');
  console.log('  siehe docs/STEM_SEPARATION_ENGINE.md §14.                         ');
  console.log('═══════════════════════════════════════════════════════════════════');
}

run().catch((error) => {
  console.error('\n✘ TEIL 2 TEST FEHLGESCHLAGEN');
  console.error(error);
  process.exitCode = 1;
});
