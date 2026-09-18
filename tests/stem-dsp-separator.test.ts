/**
 * Test der eingebauten Stem-Separation (DSP-Heuristik).
 *
 * Geprüft wird das, was die Engine garantieren kann – und das, was sie
 * ausdrücklich NICHT behaupten darf:
 *  - verlustfreie Rekombination (Σ Stems == Mix),
 *  - Determinismus und Block-Verarbeitung identisch zum Ein-Schuss-Lauf,
 *  - musikalisch erwartbare Energieverteilung auf dem Goldstandard-Track,
 *  - ehrliche Metadaten (trainedModel=false, qualityTier=HEURISTIC),
 *  - technisches Bestehen, aber kein Freischalten des Qualitäts-Gates.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateGoldStandardTrack, type GoldStandardTrack } from '../src/stems/goldStandard';
import {
  DSP_SEPARATOR_ENGINE,
  separateStemsDsp,
  separateStemsDspChunked,
  sumDspStems,
} from '../src/stems/dspSeparator';
import { DspHeuristicSeparator } from '../src/stems/backends/dspHeuristicSeparator';
import { StemSeparationEngine } from '../src/stems/stemSeparationEngine';
import { runStemIsolationGate } from '../src/stems/stemIsolationGate';
import { encodeWavFloat32, fileFingerprint, readWavFile } from '../src/stems/wavIo';
import { rms } from '../src/stems/dsp';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`[ PASS ] ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`[ FAIL ] ${name}`);
      console.error(`         ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

function segmentRms(track: GoldStandardTrack, data: Float32Array, fromSeconds: number, toSeconds: number): number {
  const start = Math.floor(fromSeconds * track.sampleRate) * 2;
  const end = Math.floor(toSeconds * track.sampleRate) * 2;
  return rms(data.subarray(start, end));
}

function maxAbsDifference(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

async function run(): Promise<void> {
  const track = generateGoldStandardTrack();
  const stereo = { data: track.mix, sampleRate: track.sampleRate, channels: 2, frames: track.frames };
  const report = separateStemsDsp(stereo);
  const stems = new Map(report.stems.map((stem) => [stem.id, stem.data]));

  await test('#1 Vier Stems in fester Reihenfolge mit Klarnamen', () => {
    assert.deepEqual(report.stemOrder, ['vocals', 'drums', 'bass', 'other']);
    assert.deepEqual(report.stems.map((stem) => stem.label), ['Vocals', 'Drums', 'Bass', 'Inst']);
    for (const stem of report.stems) {
      assert.equal(stem.frames, track.frames);
      assert.equal(stem.channels, 2);
      assert.equal(stem.sampleRate, track.sampleRate);
      assert.equal(stem.data.length, track.frames * 2);
    }
  });

  await test('#2 Verlustfreie Rekombination: Summe der Stems == Originalmix', () => {
    const summed = sumDspStems(report.stems);
    const error = maxAbsDifference(summed, track.mix);
    assert.ok(error < 1e-5, `Rekombinationsfehler zu groß: ${error}`);
    assert.ok(report.recombinationMaxError < 1e-9, `Interner Fehler zu groß: ${report.recombinationMaxError}`);
  });

  await test('#3 Determinismus: zwei Läufe sind bitgleich', () => {
    const second = separateStemsDsp(stereo);
    for (const stem of second.stems) {
      assert.equal(maxAbsDifference(stem.data, stems.get(stem.id)!), 0, `Stem ${stem.id} ist nicht deterministisch`);
    }
  });

  await test('#4 Blockweise Separation ist identisch zum Ein-Schuss-Lauf', async () => {
    const chunked = await separateStemsDspChunked(stereo, { blockFrames: 4410 });
    for (const stem of chunked.stems) {
      assert.equal(maxAbsDifference(stem.data, stems.get(stem.id)!), 0, `Stem ${stem.id} weicht im Blockmodus ab`);
    }
    assert.equal(chunked.recombinationMaxError, report.recombinationMaxError);
  });

  await test('#5 Fortschritt wird im Blockmodus gemeldet und erreicht 100 %', async () => {
    const ratios: number[] = [];
    await separateStemsDspChunked(stereo, {
      blockFrames: 22050,
      onProgress: (progress) => ratios.push(progress.ratio),
      yieldBetweenBlocks: async () => undefined,
    });
    assert.ok(ratios.length >= 2, 'Zu wenige Fortschrittsmeldungen');
    assert.ok(ratios.every((ratio) => ratio >= 0 && ratio <= 1), 'Fortschritt außerhalb von 0..1');
    assert.equal(ratios[ratios.length - 1], 1);
  });

  await test('#6 Abbruch im Blockmodus beendet die Separation', async () => {
    let calls = 0;
    await assert.rejects(
      separateStemsDspChunked(stereo, {
        blockFrames: 4410,
        isCancelled: () => ++calls > 1,
        yieldBetweenBlocks: async () => undefined,
      }),
      /abgebrochen/i
    );
  });

  await test('#7 Vocals: mittiger Gesangsabschnitt dominiert den breiten Abschnitt', () => {
    const vocalSection = segmentRms(track, stems.get('vocals')!, 10, 15);
    const wideSection = segmentRms(track, stems.get('vocals')!, 15, 20);
    assert.ok(vocalSection > wideSection * 2.5, `Vocal-Kontrast zu gering: ${vocalSection} vs ${wideSection}`);
  });

  await test('#8 Drums: Transienten-Abschnitte dominieren, Gesang bleibt draußen', () => {
    const drums = stems.get('drums')!;
    const vocals = stems.get('vocals')!;
    // 20-25 s: Kick, Snare-Noise und Hi-Hats – der Drums-Stem muss hier einen
    // deutlichen Anteil des Mixes tragen.
    const denseDrums = segmentRms(track, drums, 20, 25);
    const denseMix = segmentRms(track, track.mix, 20, 25);
    assert.ok(denseDrums / denseMix > 0.25, `Drums-Anteil im dichten Abschnitt zu klein: ${(denseDrums / denseMix).toFixed(3)}`);
    // 0-5 s: nur Kick + Subbass (keine Vocals) → mehr Drums-Energie als im
    // Gesangsabschnitt 10-15 s.
    const kickSection = segmentRms(track, drums, 0, 5);
    const vocalSectionDrums = segmentRms(track, drums, 10, 15);
    assert.ok(kickSection > vocalSectionDrums * 1.1, `Kick-Abschnitt nicht stärker als Gesangsabschnitt: ${kickSection} vs ${vocalSectionDrums}`);
    // Vocal-Attacken dürfen den Drums-Stem nicht dominieren.
    const vocalSectionVocals = segmentRms(track, vocals, 10, 15);
    assert.ok(vocalSectionDrums < vocalSectionVocals, `Drums lauter als Vocals im Gesangsabschnitt: ${vocalSectionDrums} vs ${vocalSectionVocals}`);
  });

  await test('#9 Bass: tiefer Abschnitt wird getrennt, Hi-Hat-Abschnitt bleibt leer', () => {
    const bassSection = segmentRms(track, stems.get('bass')!, 0, 5);
    const hatSection = segmentRms(track, stems.get('bass')!, 15, 20);
    assert.ok(bassSection > hatSection * 8, `Bass-Trennung zu schwach: ${bassSection} vs ${hatSection}`);
    assert.ok(hatSection < 0.02, `Bass-Stem enthält zu viel Hochton: ${hatSection}`);
  });

  await test('#10 Ehrliche Metadaten: Heuristik, kein trainiertes Modell', () => {
    assert.equal(report.engine, DSP_SEPARATOR_ENGINE);
    assert.equal(report.trainedModel, false);
    assert.equal(report.qualityTier, 'HEURISTIC');
    assert.ok(report.notes.some((note) => /kein trainiertes KI-Modell/i.test(note)), 'Hinweis auf Heuristik fehlt');
  });

  await test('#11 Mono-Material läuft und rekonstruiert exakt', () => {
    const mono = new Float32Array(track.frames);
    for (let f = 0; f < track.frames; f++) mono[f] = (track.mix[f * 2] + track.mix[f * 2 + 1]) / 2;
    const result = separateStemsDsp({ data: mono, sampleRate: track.sampleRate, channels: 1, frames: track.frames });
    assert.equal(result.channels, 1);
    let maxError = 0;
    for (let i = 0; i < mono.length; i++) {
      const sum = result.stems.reduce((acc, stem) => acc + stem.data[i], 0);
      maxError = Math.max(maxError, Math.abs(mono[i] - sum));
    }
    assert.ok(maxError < 1e-5, `Mono-Rekombinationsfehler: ${maxError}`);
    assert.ok(result.notes.some((note) => /Mono/i.test(note)), 'Mono-Hinweis fehlt');
  });

  await test('#12 Ungültige Eingaben werden abgelehnt', () => {
    assert.throws(() => separateStemsDsp({ data: new Float32Array(8), sampleRate: 800, channels: 2, frames: 4 }), /Sample-Rate/);
    assert.throws(() => separateStemsDsp({ data: new Float32Array(12), sampleRate: 44100, channels: 3, frames: 4 }), /Mono oder Stereo/);
  });

  await test('#13 Backend-Adapter schreibt WAV-Dateien und lässt das Original unberührt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stem-dsp-'));
    try {
      const inputPath = path.join(root, 'input.wav');
      await writeFile(inputPath, Buffer.from(encodeWavFloat32(track.sampleRate, 2, track.mix, track.frames)));
      const before = await fileFingerprint(inputPath);
      const engine = new StemSeparationEngine({
        workingRoot: path.join(root, 'working'),
        outputRoot: path.join(root, 'output'),
        cacheRoot: path.join(root, 'cache'),
        modelStoreDir: path.join(root, 'models'),
      });
      const summary = await engine.separate({ inputPath, modelId: DSP_SEPARATOR_ENGINE, profile: 'HIGH_QUALITY', trackName: 'dsp_test' });
      assert.equal(summary.status, 'COMPLETED');
      assert.equal(summary.validation.fromTrainedModel, false, 'Heuristik darf sich nicht als trainiert ausgeben');
      assert.deepEqual(summary.validation.stemOrder, ['vocals', 'drums', 'bass', 'other']);
      assert.equal(summary.stems.length, 4);
      const backendReport = summary.metadata.events.find((event) => event.phase === 'backend-report');
      assert.ok(backendReport?.detail?.includes('"weights":"dsp-heuristic"'), 'Backend-Report kennzeichnet die Gewichte nicht');
      for (const stem of summary.stems) {
        const audio = await readWavFile(stem.filePath);
        assert.equal(audio.channels, 2);
        assert.equal(audio.frames, track.frames);
      }
      const after = await fileFingerprint(inputPath);
      assert.deepEqual(after, before, 'Originaldatei wurde verändert');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test('#14 Stem Isolation Gate: technisch grün, Qualität bleibt geschlossen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stem-gate-dsp-'));
    try {
      const engine = new StemSeparationEngine({
        workingRoot: path.join(root, 'working'),
        outputRoot: path.join(root, 'output'),
        cacheRoot: path.join(root, 'cache'),
        modelStoreDir: path.join(root, 'models'),
        backendFactory: () => new DspHeuristicSeparator(),
      });
      const report2 = await runStemIsolationGate({ engine, outputRoot: path.join(root, 'test_run'), request: { modelId: DSP_SEPARATOR_ENGINE } });
      assert.equal(report2.technicalPass, true, 'Technische Prüfung muss bestehen');
      assert.equal(report2.fromTrainedModel, false);
      assert.equal(report2.qualityPass, false, 'Ohne trainierte Gewichte darf das Qualitäts-Gate nicht öffnen');
      assert.equal(report2.releaseDecision, 'TECHNICAL_PASS_QUALITY_FAIL');
      assert.ok(report2.recombinationErrorDb > 20, `Rekombination zu schlecht: ${report2.recombinationErrorDb}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test('#15 Laufzeit bleibt praxistauglich (30 s Stereo)', () => {
    assert.ok(report.durationMs < 20000, `Separation zu langsam: ${report.durationMs} ms`);
  });

  console.log(`\nstem-dsp-separator: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
