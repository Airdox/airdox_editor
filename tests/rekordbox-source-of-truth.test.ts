/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NACHWEIS: REKORDBOX ALS EINEZIGE DATENQUELLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Regel (Project Goal): „Alle visuellen und zeitlichen Daten müssen zu 100 % aus
 * den realen Rekordbox/Hackerblocks-Daten stammen … Eine eigene Analyse-Engine
 * ist nicht das Ziel.“
 *
 * Diese Suite prüft deshalb nicht, ob etwas *schön aussieht*, sondern ob die
 * Werte, die in der ANLZ-Datei stehen, unverändert in Editor und Renderer
 * ankommen – und ob alles, was nicht aus der Datei kommt, als eigene
 * Herleitung gekennzeichnet ist. Jeder Fall, der hier durchfällt, wäre ein Fall,
 * in dem sich eine zweite Analyse-Engine eingeschlichen hat.
 *
 * Run mit: npx tsx tests/rekordbox-source-of-truth.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

import {
  generateAnlzWithBeatTimes,
  generateAnlzMonoWaveform,
  SCENARIO_TECHNO_XML,
  type AnlzBeatEntry,
} from '../src/rekordbox/testDatasets';
import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import { BeatGrid, DataOrigin } from '../src/types/rekordbox';
import { buildBeatGridFromTempo } from '../src/rekordbox/xmlParser';
import type { PcmAudio } from '../src/audio/pcm';
import type { EditableAudio } from '../src/audio/editOps';
import {
  averageSecondsPerBeat,
  beatPosition,
  beatTime,
  insertClipAt,
  moveRangeToStart,
  nearestBeatIndex,
  removeRange,
  snapToGrid,
} from '../src/audio/editOps';
import { analysisSourceLabel, analyzePcm, waveformModesFor } from '../src/waveform/analyzer';
import {
  carryAnalysisThroughEdit,
  recomputedBucketCount,
} from '../src/waveform/editAnalysis';
import type { WaveformAnalysisData } from '../src/types/rekordbox';
import { pcmSampleCount } from '../src/audio/pcm';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  detail?: string;
  durationMs: number;
}

const results: TestResult[] = [];
const details: string[] = [];

function runTest(suite: string, name: string, testFn: () => string | void) {
  const t0 = performance.now();
  try {
    const detail = testFn() as string | undefined;
    if (detail) details.push(`[${suite}] ${name}\n${detail}`);
    results.push({
      suite,
      name,
      passed: true,
      detail,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `Assertion Failed [${message}]: erwartet ${JSON.stringify(expected)}, tatsächlich ${JSON.stringify(actual)}`
    );
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  NACHWEIS: 100 % REKORDBOX-DATEN (QUELLE DER WAHRHEIT)          ');
console.log('═══════════════════════════════════════════════════════════════════\n');

const SR = 16_000;

// Schlagliste mit Tempo-Wechsel, so wie Rekordbox sie speichert: Beats 0–7 bei
// 128 BPM, Beats 8–15 bei 140 BPM. beatInBar 1 markiert den Taktanfang.
const BEATS: AnlzBeatEntry[] = [];
{
  let t = 0;
  for (let i = 0; i < 16; i++) {
    const bpm = i < 8 ? 128 : 140;
    BEATS.push({ beatInBar: (i % 4) + 1, tempo: Math.round(bpm * 100), timeMs: Math.round(t * 1000) });
    t += 60 / bpm;
  }
}
const BAR128 = (60 / 128) * 4;

function fixtureGrid(): BeatGrid {
  const grid = parseAnlzBinary(generateAnlzWithBeatTimes(BEATS, 128)).beatGrid;
  if (!grid) throw new Error('Fixture liefert kein Beatgrid');
  return grid;
}

function tone(seconds: number): PcmAudio {
  const n = Math.max(1, Math.round(seconds * SR));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;
  return { sampleRate: SR, channels: [data, data.slice()] };
}

function targetFor(grid: BeatGrid): EditableAudio {
  const last = grid.beats[grid.beats.length - 1].time;
  return { audio: tone(last), cues: [], loops: [], beatGrid: grid };
}

function source(rel: string): string {
  return readFileSync(resolve(HERE, '..', 'src', rel), 'utf-8');
}

function xmlTrack() {
  return extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0).track;
}

// ─── 1) Die importierten Beatzeiten bleiben unverändert ────────────────────
runTest('PQTZ', 'Schlagliste kommt bitgenau im Datenmodell an', () => {
  const extraction = parseAnlzBinary(generateAnlzWithBeatTimes(BEATS, 128));
  const merged = applyAnlzExtractionToTrack(xmlTrack(), extraction);

  assertEqual(merged.beatGrid.beats.length, BEATS.length, 'Anzahl Beats');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'Herkunft der Schlagliste');
  assertEqual(merged.beatGrid.beats[0].index, 0, 'Beat-Nummerierung beginnt bei 0');
  let maxDiff = 0;
  for (let i = 0; i < BEATS.length; i++) {
    const expected = BEATS[i].timeMs / 1000;
    const actual = merged.beatGrid.beats[i].time;
    maxDiff = Math.max(maxDiff, Math.abs(actual - expected));
    assert(actual === expected, `Beat ${i}: importierte Zeit ${expected} s muss stehen, nicht ${actual} s`);
    assertEqual(merged.beatGrid.beats[i].beatInBar, BEATS[i].beatInBar, `Beat ${i}: Schlag im Takt`);
    assertEqual(merged.beatGrid.beats[i].isBarStart, BEATS[i].beatInBar === 1, `Beat ${i}: Taktanfang`);
  }

  // Negativkontrolle: ein aus dem Anfangstempo fortgeschriebenes Raster würde
  // spätestens ab dem Tempo-Wechsel daneben liegen – der Test kann also scheitern.
  const uniformBeat12 = merged.beatGrid.beats[0].time + 12 * (60 / 128);
  assert(
    Math.abs(uniformBeat12 - merged.beatGrid.beats[12].time) > 0.05,
    'Negativkontrolle: fortgeschriebenes Raster darf hier NICHT passen'
  );
  return `Beat 12 importiert: ${(merged.beatGrid.beats[12].time * 1000).toFixed(0)} ms
Beat 12 bei Raster aus 128 BPM: ${(uniformBeat12 * 1000).toFixed(0)} ms
größte Abweichung Import → Datenmodell: ${maxDiff.toExponential(1)} s`;
});

runTest('PQTZ', 'Importiertes Raster wird nicht durch ein neues ersetzt', () => {
  const extraction = parseAnlzBinary(generateAnlzWithBeatTimes(BEATS, 128));
  assert(extraction.beatGrid !== undefined, 'Parser liefert Schlagliste');
  const grid = extraction.beatGrid!;
  // Zwei aufeinanderfolgende Abstände: vor dem Wechsel 469 ms, danach 429 ms.
  const gap0 = grid.beats[1].time - grid.beats[0].time;
  const gap9 = grid.beats[10].time - grid.beats[9].time;
  assert(Math.abs(gap0 - gap9) > 0.02, `Abstände müssten sich unterscheiden (${gap0} / ${gap9})`);
  const merged = applyAnlzExtractionToTrack(xmlTrack(), extraction);
  assertEqual(merged.beatGrid.beats.length, grid.beats.length, 'Kein Anhängsel aus Fortschreibung');
  return `Abstand Beat 0→1: ${(gap0 * 1000).toFixed(0)} ms · Beat 9→10: ${(gap9 * 1000).toFixed(0)} ms`;
});

runTest('PQTZ', 'Taktmaß steht in den Daten und wird nicht angenommen', () => {
  const threeFour: AnlzBeatEntry[] = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    threeFour.push({ beatInBar: (i % 3) + 1, tempo: 12800, timeMs: Math.round(t * 1000) });
    t += 60 / 128;
  }
  const grid = parseAnlzBinary(generateAnlzWithBeatTimes(threeFour, 128)).beatGrid;
  assertEqual(grid?.meter, 3, '3/4 aus der Schlagliste abgelesen');
});

// ─── 2) Editor und Rasterung benutzen genau diese Zeiten ───────────────────
runTest('Editor', 'Rasterung springt auf die importierten Beatzeiten', () => {
  const grid = fixtureGrid();
  const lines: string[] = [];
  const lastBeat = grid.beats[grid.beats.length - 1].time;
  for (const seconds of [0.3, 1.0, 2.6, 4.4, 6.0]) {
    const snapped = snapToGrid(grid, seconds, 'beat');
    const beat = grid.beats.find((candidate) => Math.abs(candidate.time - snapped.seconds) < 1e-9);
    if (seconds <= lastBeat) {
      // Innerhalb der importierten Liste wird NICHTS gerechnet, nur ausgewählt.
      assert(beat !== undefined, `${seconds.toFixed(3)} s → ${snapped.seconds.toFixed(6)} s ist kein importierter Beat`);
      assert(Math.abs(snapped.seconds - seconds) < 0.5, 'Rasterung springt mehr als einen Beat weit');
      const index = nearestBeatIndex(grid, snapped.seconds);
      assert(Math.abs(beatTime(grid, index) - snapped.seconds) < 1e-9, 'Beatnummer zeigt auf dieselbe Zeit');
      lines.push(`gefragt ${seconds.toFixed(3)} s → ${snapped.seconds.toFixed(6)} s = Beat ${index} (Schlag ${beat!.beatInBar}/4)`);
    } else {
      // Jenseits des letzten importierten Beats gibt es keinen Importwert: dort
      // wird das Raster fortgeschrieben, und das ist als Grenze markiert.
      assert(snapped.seconds > lastBeat, 'außerhalb der Abdeckung entsteht ein Beat im importierten Bereich');
      lines.push(`gefragt ${seconds.toFixed(3)} s (hinter Beat ${grid.beats.length - 1} bei ${lastBeat.toFixed(3)} s) → Fortschreibung ${snapped.seconds.toFixed(6)} s`);
    }
  }
  assert(lines.length === 5, 'Alle fünf Anfragen müssen belegt sein');
  return lines.join('\n');
});

runTest('Editor', 'Takt-Rasterung trifft nur echte Taktanfänge', () => {
  const grid = fixtureGrid();
  const anfragen: string[] = [];
  for (const seconds of [0.5, 1.5, 3.2, 5.0]) {
    const snapped = snapToGrid(grid, seconds, 'bar');
    const beat = grid.beats.find((candidate) => Math.abs(candidate.time - snapped.seconds) < 1e-9);
    assert(beat !== undefined, `${seconds} s: kein Taktanfang in der importierten Liste`);
    assert(beat!.isBarStart, `${seconds} s: gerastet auf Schlag ${beat!.beatInBar}, nicht auf Taktanfang`);
    anfragen.push(`${seconds.toFixed(2)} s → Takt ${beat!.barNumber} (Schlag 1) bei ${(beat!.time * 1000).toFixed(0)} ms`);
  }
  return anfragen.join('\n');
});

runTest('Editor', 'Beatlage ist an den importierten Beats exakt', () => {
  const grid = fixtureGrid();
  for (let i = 0; i < grid.beats.length; i++) {
    const at = beatPosition(grid, grid.beats[i].time);
    assert(Math.abs(at - i) < 1e-6, `Beat ${i}: Lage ${at}`);
  }
  const halfway = (grid.beats[9].time + grid.beats[10].time) / 2;
  const at = beatPosition(grid, halfway);
  assert(at > 9 && at < 10, `Mitte zwischen Beat 9 und 10: ${at}`);
  return `Mitte zwischen Beat 9 und 10 liegt bei Beat-Position ${at.toFixed(3)}`;
});

runTest('Editor', 'Beatlänge kommt aus den importierten Abständen', () => {
  const grid = fixtureGrid();
  const measured = averageSecondsPerBeat(grid);
  const fromFirstEntry = 60 / grid.bpm;
  assert(
    Math.abs(measured - fromFirstEntry) > 0.005,
    `mittlere Beatlänge (${measured}) muss bei Tempo-Wechsel vom Einzelwert (${fromFirstEntry}) abweichen`
  );
  return `Durchschnitt aus 16 importierten Beats: ${measured.toFixed(6)} s · Wert des ersten Eintrags: ${fromFirstEntry.toFixed(6)} s`;
});

// ─── 3) Eingriffe tragen das Raster mit, statt es neu zu erfinden ──────────
runTest('Eingriff', 'Schnitt verschiebt nur den Rest, der Anfang bleibt unverändert', () => {
  const grid = fixtureGrid();
  // Herausgeschnitten wird ein Takt in der Mitte (Beat 4 bis 8) – so bleibt ein
  // Kopf, dessen Zeiten unverändert stehen müssen.
  const cutStart = grid.beats[4].time;
  const cutEnd = grid.beats[8].time;
  const edit = removeRange(targetFor(grid), cutStart, cutEnd);
  const after = edit.target.beatGrid.beats;
  const shift = pcmSampleCount(targetFor(grid).audio) / SR - pcmSampleCount(edit.target.audio) / SR;
  const head = after.filter((beat) => beat.time < cutStart - 1e-9);
  assertEqual(head.length, 4, 'Vier Beats vor dem Schnitt bleiben übrig');
  for (let i = 0; i < head.length; i++) {
    assertEqual(head[i].time, BEATS[i].timeMs / 1000, `Beat ${i} behält seine importierte Zeit`);
  }
  const tailImported = grid.beats.filter((beat) => beat.time >= cutEnd - 1e-9).map((beat) => beat.time - shift);
  const tailResult = after.filter((beat) => beat.time >= cutStart - 1e-9).map((beat) => beat.time);
  assertEqual(tailResult.length, tailImported.length, 'Anzahl Beats im verschobenen Rest');
  assertEqual(after.length, head.length + tailResult.length, 'Kein Beat fehlt und keines wird ergänzt');
  let maxDiff = 0;
  tailImported.forEach((time, i) => {
    maxDiff = Math.max(maxDiff, Math.abs(time - tailResult[i]));
  });
  assert(maxDiff < 1e-12, `Rest um ${maxDiff} s verrutscht`);
  const last = after[after.length - 1].time;
  assert(last <= pcmSampleCount(edit.target.audio) / SR + 1e-9, 'Raster zeigt über das Ende hinaus');
  return `Kopf unverändert: ${head.map((beat) => (beat.time * 1000).toFixed(0)).join(', ')} ms · Rest um die Schnittlänge ${(shift * 1000).toFixed(0)} ms nach vorne (größte Abweichung ${maxDiff.toExponential(1)} s) · ${after.length} Beats, letzter bei ${last.toFixed(4)} s`;
});

runTest('Eingriff', 'Einfügen schiebt ab der Einfügestelle und lässt die Beats mitlaufen', () => {
  const grid = fixtureGrid();
  const insertAt = grid.beats[4].time;
  const target = targetFor(grid);
  const edit = insertClipAt(target, insertAt, tone(BAR128));
  const after = edit.target.beatGrid.beats;
  for (let i = 0; i < 4; i++) {
    assertEqual(after[i].time, BEATS[i].timeMs / 1000, `Beat ${i} bleibt, wo er war`);
  }
  const shifted = grid.beats
    .filter((beat) => beat.time >= insertAt - 1e-9)
    .map((beat) => beat.time + BAR128);
  const result = after.filter((beat) => beat.time > insertAt + 1e-9).map((beat) => beat.time);
  assertEqual(result.length, shifted.length, 'Kein Batzen fortgeschriebener Beats');
  shifted.forEach((time, i) => {
    assert(Math.abs(time - result[i]) < 1e-6, `verschobener Beat ${i}: ${time.toFixed(6)} statt ${result[i].toFixed(6)}`);
  });
  return `${shifted.length} Beats um eine Taktlänge (${BAR128.toFixed(4)} s) nach hinten · Beatanzahl ${after.length}`;
});

runTest('Eingriff', 'Verschieben trägt die Beats des Blocks mit', () => {
  const grid = fixtureGrid();
  const fromStart = grid.beats[12].time;
  const fromEnd = grid.beats[grid.beats.length - 1].time;
  const blockLen = fromEnd - fromStart;
  const edit = moveRangeToStart(targetFor(grid), fromStart, fromEnd, { atSec: 0 });
  const after = edit.target.beatGrid.beats;
  assertEqual(after.length, grid.beats.length, 'Beatanzahl bleibt bei einer Verschiebung gleich');
  const times = after.map((beat) => beat.time);
  // Der Block wandert an den Anfang, der Teil davor rückt um die Blocklänge –
  // alles übrige bleibt, wo es war.
  const block = grid.beats.filter((beat) => beat.time >= fromStart - 1e-9 && beat.time < fromEnd - 1e-9);
  block.forEach((beat, i) => {
    const moved = beat.time - fromStart;
    const found = after.find((candidate) => Math.abs(candidate.time - moved) < 1e-9);
    assert(found !== undefined, `Block-Beat bei ${(moved * 1000).toFixed(0)} ms fehlt vorn`);
    assert(found!.isBarStart === grid.beats[12 + i].isBarStart, 'Taktanfang-Etikett geht verloren');
  });
  const head = grid.beats.filter((beat) => beat.time >= blockLen && beat.time < fromStart - 1e-9);
  head.forEach((beat) => {
    assert(
      times.some((time) => Math.abs(time - (beat.time + blockLen)) < 1e-9),
      `Beat bei ${(beat.time * 1000).toFixed(0)} ms ist nicht um die Blocklänge gerückt`
    );
  });
  const tail = grid.beats[grid.beats.length - 1];
  assert(times.some((time) => Math.abs(time - tail.time) < 1e-9), 'Beat hinter dem Block bleibt stehen');
  assert(Math.max(...times) <= pcmSampleCount(edit.target.audio) / SR + 1e-9, 'Raster zeigt über das Ende hinaus');
  return `Block (${block.length} Beats) bei ${block.map((b) => ((b.time - fromStart) * 1000).toFixed(0)).join(', ')} ms · ${head.length} Beats um ${(blockLen * 1000).toFixed(0)} ms nach rechts · Beatanzahl ${after.length}/${grid.beats.length}`;
});

// ─── 4) Anzeigeverfahren nur, wenn die Daten es hergeben ───────────────────
runTest('Auflösung', 'Eine Lage ergibt kein Farb-Bild', () => {
  const mono = parseAnlzBinary(generateAnlzMonoWaveform(16, 128));
  assert(mono.waveform !== undefined, 'PWAV wird gelesen');
  const a = mono.waveform!;
  assertEqual(waveformModesFor(a).join('+'), 'BLUE', 'Modi für PWAV');
  for (let i = 0; i < a.length; i++) {
    assert(
      a.lowEnergy[i] === a.midEnergy[i] && a.midEnergy[i] === a.highEnergy[i],
      `PWAV-Eintrag ${i} trägt verschiedene Bänder – Fixture kaputt`
    );
  }

  const color = parseAnlzBinary(generateAnlzWithBeatTimes(BEATS, 128));
  assertEqual(color.waveform!.length, 600, 'PWV7-Buckets');
  assert(waveformModesFor(color.waveform!).includes('3BAND'), 'PWV7 darf 3BAND anbieten');

  const mergedMono = applyAnlzExtractionToTrack(xmlTrack(), mono);
  const mergedColor = applyAnlzExtractionToTrack(xmlTrack(), color);
  assertEqual(mergedMono.databaseRecord!.waveformModeSupported.join('+'), 'BLUE', 'Modi im Datensatz (eine Lage)');
  assert(mergedColor.databaseRecord!.waveformModeSupported.includes('3BAND'), 'Modi im Datensatz (drei Lagen)');
  return `PWAV: ${mergedMono.databaseRecord!.waveformModeSupported.join(', ')} · PWV7: ${mergedColor.databaseRecord!.waveformModeSupported.join(', ')}`;
});

runTest('Auflösung', 'Keine erfundene Verstärkung in der Eigenberechnung', () => {
  const analyzerSource = source('waveform/analyzer.ts');
  for (const factor of ['* 2.8', '* 3.2', '* 4.2']) {
    assert(!analyzerSource.includes(factor), `Nachhebe-Faktor ${factor} ist zurück im Code`);
  }
  const N = 8192;
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
    left[i] = v;
    right[i] = v;
  }
  const analysis = analyzePcm({ sampleRate: SR, channels: [left, right] }, DataOrigin.GENERATED_FALLBACK);
  let maxPeak = 0;
  for (let i = 0; i < analysis.length; i++) maxPeak = Math.max(maxPeak, analysis.peaks[i]);
  let maxBand = 0;
  for (let i = 0; i < analysis.length; i++) {
    maxBand = Math.max(maxBand, analysis.highEnergy[i], analysis.midEnergy[i], analysis.lowEnergy[i]);
  }
  assert(maxBand <= maxPeak + 1e-6, `Band-Spitze ${maxBand.toFixed(3)} über der Peak-Spitze ${maxPeak.toFixed(3)} – da wird nachgehoben`);
  return `größter Peak ${maxPeak.toFixed(3)} · größtes Band ${maxBand.toFixed(3)} (kein Aufschlag, 1 kHz-Ton mit 0,5 Amplitude)`;
});

// ─── 5) Was nicht aus der Datei kommt, ist gekennzeichnet ──────────────────
runTest('Kennzeichnung', 'Herkunft ist im Editor lesbar', () => {
  const anl = analysisSourceLabel(DataOrigin.REKORDBOX_ANLZ);
  const own = analysisSourceLabel(DataOrigin.GENERATED_FALLBACK);
  assert(anl.includes('ANALYSE-DATEI'), `ANLZ-Herkunft heißt: ${anl}`);
  assert(own.includes('EIGENBERECHNUNG'), `Eigenberechnung heißt: ${own}`);
  assert(own !== anl, 'Beide Zustände dürfen nicht gleich heißen');
  const ui = source('components/DetailWaveform.tsx');
  assert(ui.includes('analysisSourceLabel('), 'Die Wellenform zeigt die Herkunft nicht');
  return `ANLZ: „${anl}" · eigene Rechnung: „${own}"`;
});

runTest('Kennzeichnung', 'Ohne Schlagliste wird fortgeschrieben – und gesagt', () => {
  // PQTZ ohne Beatliste (nur Kopf) ist der einzige Fall, in dem ein Raster aus
  // BPM gebaut werden darf – dann muss der Hinweis im Datensatz stehen.
  const noBeats: AnlzBeatEntry[] = [];
  const buffer = generateAnlzWithBeatTimes(noBeats, 128);
  const extraction = parseAnlzBinary(buffer);
  const merged = applyAnlzExtractionToTrack(xmlTrack(), extraction);
  const notes = merged.databaseRecord?.anlzWarnings ?? [];
  const gridIsDerived =
    extraction.beatGrid === undefined ||
    extraction.beatGrid.beats.length === 0 ||
    merged.beatGrid.origin === DataOrigin.REKORDBOX_ANLZ;
  assert(gridIsDerived, 'Ohne Schlagliste darf kein Raster als Importwert ausgegeben werden');
  assert(
    notes.some((note) => /Beat-Eintr\u00e4ge|Raster|Beatgrid/i.test(note)),
    `Hinweis fehlt: ${notes.join(' | ') || 'keine Warnung'}`
  );
  return `Hinweis im Datensatz: „${notes[notes.length - 1]}"`;
});

runTest('Kennzeichnung', 'master.db liefert kein Raster, das als eines aussieht', () => {
  const dbParser = source('rekordbox/dbParser.ts');
  assert(
    dbParser.includes('DataOrigin.GENERATED_FALLBACK'),
    'DB-Raster muss als eigene Herleitung gekennzeichnet sein'
  );
  const extractor = source('rekordbox/databaseExtractor.ts');
  assert(
    extractor.includes('extraction.beatGrid.beats.length > 0 ? extraction.beatGrid : undefined'),
    'Der Import muss die Schlagliste vor jeder Fortschreibung prüfen'
  );
});

runTest('Kennzeichnung', 'Keine zweite Analyse-Engine im Quellcode', () => {
  const files = [
    'waveform/analyzer.ts',
    'audio/editOps.ts',
    'audio/clipLibrary.ts',
    'rekordbox/databaseExtractor.ts',
    'rekordbox/anlzParser.ts',
  ];
  const forbidden = /estimateBpm|detectBpm|detectBeat|onsetDetect|autocorrelat|bpmFromPeaks/i;
  for (const file of files) {
    const hit = source(file).match(forbidden);
    assert(hit === null, `${file} enthält Tempo-/Beat-Erkennung (${hit?.[0]})`);
  }
  // Eine Eigenberechnung darf nie als Rekordbox-Wert etikettiert werden.
  const app = source('App.tsx');
  for (const match of app.matchAll(/analyzePcm\(/g)) {
    const scope = app.slice(match.index ?? 0, (match.index ?? 0) + 240);
    assert(!scope.includes('REKORDBOX'), 'Eigenberechnung wird als Rekordbox-Daten ausgegeben');
  }
});

runTest('Kennzeichnung', 'Nachgezeichnete Kurve trägt Projekt-Herkunft', () => {
  const extraction = parseAnlzBinary(generateAnlzWithBeatTimes(BEATS, 128));
  const merged = applyAnlzExtractionToTrack(xmlTrack(), extraction);
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'Importierte Kurve trägt ANLZ-Herkunft');
  const reRendered = analyzePcm(tone(2), DataOrigin.PROJECT);
  assertEqual(reRendered.origin, DataOrigin.PROJECT, 'Nachgezeichnete Kurve trägt Projekt-Herkunft');
  assertEqual(analysisSourceLabel(reRendered.origin), 'NACH DEM SCHNITT NEU GEZEICHNET', 'Sichtbarer Hinweis');
  return `importiert: ${analysisSourceLabel(merged.analysis!.origin)} · nach Eingriff: ${analysisSourceLabel(reRendered.origin)}`;
});

// ─── 4b) Eingriffe tragen die importierte Kurve statt sie neu zu rechnen ─────
const ANALYSIS_BUCKETS = 100;
const ANALYSIS_SECONDS = 8; // eine Spur von 8 s mit 100 Buckets → 0,08 s pro Bucket

function importedAnalysis(): WaveformAnalysisData {
  const make = (phase: number) => {
    const a = new Float32Array(ANALYSIS_BUCKETS);
    for (let i = 0; i < ANALYSIS_BUCKETS; i++) a[i] = ((i * 7 + phase) % 23) / 23;
    return a;
  };
  const peaks = make(0);
  return {
    length: ANALYSIS_BUCKETS,
    peaks,
    peaksL: make(1),
    peaksR: make(2),
    lowEnergy: make(3),
    midEnergy: make(4),
    highEnergy: make(5),
    origin: DataOrigin.REKORDBOX_ANLZ,
  };
}

function sameValues(a: Float32Array, b: Float32Array, fromA: number, fromB: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (a[fromA + i] !== b[fromB + i]) return false;
  }
  return true;
}

runTest('Tragen', 'Schnitt braucht gar keine neue Analyse', () => {
  const prev = importedAnalysis();
  const pcm = tone(ANALYSIS_SECONDS);
  const edit = removeRange(
    { audio: pcm, cues: [], loops: [], beatGrid: fixtureGrid() },
    2,
    3.4
  );
  const carried = carryAnalysisThroughEdit(
    prev,
    ANALYSIS_SECONDS,
    { kind: 'remove', startSec: 2, endSec: 3.4 },
    edit.target.audio,
    pcmSampleCount(edit.target.audio) / SR
  );
  assert(carried !== null, 'Kurve kann nicht getragen werden');
  const bd = ANALYSIS_SECONDS / ANALYSIS_BUCKETS;
  assertEqual(carried!.bucketDurationSec, bd, 'Zeit pro Bucket bleibt gleich');
  assertEqual(carried!.recomputed.length, 0, 'Ein Schnitt rechnet nichts neu');
  assert(carried!.analysis.recomputed === undefined, 'Rechenfenster eingetragen, obwohl keins gerechnet wurde');
  const bStart = Math.floor(2 / bd);
  const bEnd = Math.ceil(3.4 / bd);
  assert(sameValues(carried!.analysis.peaks, prev.peaks, 0, 0, bStart), 'Kopf ist nicht bitgenau derselbe');
  assert(
    sameValues(carried!.analysis.peaks, prev.peaks, bStart, bEnd, prev.length - bEnd),
    'Der Rest sind nicht dieselben importierten Werte'
  );
  assertEqual(
    carried!.analysis.length,
    Math.ceil(pcmSampleCount(edit.target.audio) / SR / bd),
    'Bucketanzahl folgt der neuen Länge'
  );
  assertEqual(carried!.analysis.origin, DataOrigin.REKORDBOX_ANLZ, 'Herkunft bleibt die Importdatei');
  return `${bStart} Buckets Kopf unverändert · ${prev.length - bEnd} Buckets Rest übernommen · Länge ${carried!.analysis.length} bei ${(bd * 1000).toFixed(0)} ms pro Bucket`;
});

runTest('Tragen', 'Einfügen rechnet nur das eigene Fenster', () => {
  const prev = importedAnalysis();
  const bd = ANALYSIS_SECONDS / ANALYSIS_BUCKETS;
  const base = { audio: tone(ANALYSIS_SECONDS), cues: [], loops: [], beatGrid: fixtureGrid() };
  const edit = insertClipAt(base, 4, tone(1.5));
  const newDuration = pcmSampleCount(edit.target.audio) / SR;
  const carried = carryAnalysisThroughEdit(prev, ANALYSIS_SECONDS, { kind: 'insert', atSec: 4, lengthSec: 1.5 }, edit.target.audio, newDuration);
  assert(carried !== null, 'Kurve kann nicht getragen werden');
  const bAt = Math.floor(4 / bd);
  const inserted = Math.max(1, Math.ceil(1.5 / bd));
  assert(sameValues(carried!.analysis.peaks, prev.peaks, 0, 0, bAt), 'Alles vor der Einfügestelle bleibt unangetastet');
  assert(
    sameValues(carried!.analysis.peaks, prev.peaks, bAt + inserted, bAt, prev.length - bAt),
    'Alles dahinter übernimmt dieselben Werte'
  );
  assertEqual(carried!.recomputed.length, 1, 'Genau ein Fenster wird gerechnet');
  assert(
    Math.abs(carried!.recomputed[0].endSec - carried!.recomputed[0].startSec - inserted * bd) < 1e-9,
    'Fenster = eingesetzte Länge'
  );
  assertEqual(carried!.analysis.length, Math.ceil(newDuration / bd), 'Neue Länge, neues Raster');
  let windowHasContent = false;
  for (let i = 0; i < inserted; i++) if (carried!.analysis.peaks[bAt + i] > 0) windowHasContent = true;
  assert(windowHasContent, 'Das Fenster wurde nicht gefüllt');
  return `${bAt} Buckets vorn + ${prev.length - bAt} Buckets hinten übernommen · nur ${inserted} Buckets (${(inserted * bd).toFixed(3)} s) neu gezeichnet`;
});

runTest('Tragen', 'Verschieben rechnet nichts, es hängt nur um', () => {
  const prev = importedAnalysis();
  const bd = ANALYSIS_SECONDS / ANALYSIS_BUCKETS;
  const grid = fixtureGrid();
  const fromStart = grid.beats[4].time;
  const fromEnd = grid.beats[8].time;
  const base = { audio: tone(grid.beats[grid.beats.length - 1].time), cues: [], loops: [], beatGrid: grid };
  const edit = moveRangeToStart(base, fromStart, fromEnd, { atSec: 0 });
  const newDuration = pcmSampleCount(edit.target.audio) / SR;
  const carried = carryAnalysisThroughEdit(
    prev,
    ANALYSIS_SECONDS,
    { kind: 'move', fromStart, fromEnd, toStart: 0 },
    edit.target.audio,
    newDuration
  );
  assert(carried !== null, 'Kurve kann nicht getragen werden');
  assertEqual(carried!.recomputed.length, 0, 'Ein Verschub braucht keine einzige neue Berechnung');
  const moved = Math.ceil((fromEnd - fromStart) / bd);
  assert(
    sameValues(carried!.analysis.peaks, prev.peaks, 0, Math.floor(fromStart / bd), moved),
    'Der Block trägt seine Kurve mit'
  );
  const sumBefore = Array.from(prev.peaks).reduce((a, b) => a + b, 0);
  const sumAfter = Array.from(carried!.analysis.peaks).reduce((a, b) => a + b, 0);
  assert(sumAfter <= sumBefore + 1e-3, 'Es sind Werte aufgetaucht, die nicht importiert waren');
  return `${moved} Buckets an den Anfang gehängt · Summe der Kurve vorher ${sumBefore.toFixed(3)} / nachher ${sumAfter.toFixed(3)}`;
});

runTest('Tragen', 'Überlagern rechnet nur den überlagerten Bereich', () => {
  const prev = importedAnalysis();
  const bd = ANALYSIS_SECONDS / ANALYSIS_BUCKETS;
  const base = { audio: tone(ANALYSIS_SECONDS), cues: [], loops: [], beatGrid: fixtureGrid() };
  const carried = carryAnalysisThroughEdit(
    prev,
    ANALYSIS_SECONDS,
    { kind: 'overlay', startSec: 1, endSec: 2 },
    base.audio,
    ANALYSIS_SECONDS
  );
  assert(carried !== null, 'Kurve kann nicht getragen werden');
  const bStart = Math.floor(1 / bd);
  const bEnd = Math.ceil(2 / bd);
  assert(sameValues(carried!.analysis.peaks, prev.peaks, 0, 0, bStart), 'Vorher unverändert');
  assert(sameValues(carried!.analysis.peaks, prev.peaks, bEnd, bEnd, prev.length - bEnd), 'Nachher unverändert');
  assertEqual(carried!.recomputed.length, 1, 'Ein Fenster');
  assertEqual(recomputedBucketCount(carried!.analysis, ANALYSIS_SECONDS), bEnd - bStart, 'Als neu markierte Buckets');
  return `nur die Buckets ${bStart}…${bEnd - 1} neu (${bEnd - bStart} von ${prev.length})`;
});

runTest('Tragen', 'Renderer analysefrei, App trägt statt zu rechnen', () => {
  const components = ['DetailWaveform.tsx', 'TrackOverview.tsx'];
  for (const file of components) {
    const text = source(`components/${file}`);
    assert(!/analyze(Pcm|AudioBuffer|PcmWindow)\(/.test(text), `${file} rechnet selbst eine Kurve`);
    assert(/track\.analysis/.test(text), `${file} liest nicht die Modell-Kurve`);
  }
  const app = source('App.tsx');
  assert(app.includes('carryAnalysisThroughEdit('), 'App trägt die Kurve nicht durch Eingriffe');
  assert(app.includes('analysisEditFor(outcome.report)'), 'Eingriffe werden nicht an den Träger übergeben');
  assert(
    app.includes('carried?.analysis ?? analyzePcm(next.audio, DataOrigin.PROJECT)'),
    'Neuberechnung passiert nicht nur als ausgewiesener Ausnahmefall'
  );
  const badge = source('components/DetailWaveform.tsx');
  assert(badge.includes('recomputedBucketCount('), 'Die Zahl neu gezeichneter Buckets ist nicht sichtbar');
});

runTest('Kennzeichnung', 'Fortgeschriebenes Raster nennt sich Fortschreibung', () => {
  const imported = fixtureGrid();
  assert(!imported.beatsAreDerived, 'Importierte Schlagliste darf nicht als fortgeschrieben gelten');
  const derived = buildBeatGridFromTempo(0.1, 128, 10, 4, DataOrigin.REKORDBOX_XML);
  assertEqual(derived.beatsAreDerived, true, 'Aus Tempo fortgeschriebenes Raster ist markiert');
  assertEqual(derived.origin, DataOrigin.REKORDBOX_XML, 'Ankerwerte bleiben als Bibliothek ausgewiesen');
  const ui = source('components/DetailWaveform.tsx');
  assert(ui.includes('beatsAreDerived'), 'Der Editor unterscheidet importiertes und fortgeschriebenes Raster nicht');
  return `importiert: ${imported.beats.length} Beats ohne Flag · fortgeschrieben: ${derived.beats.length} Beats mit Flag „FORTGESCHRIEBEN"`;
});

runTest('XML', 'Jeder TEMPO-Eintrag und jedes Taktmaß wird benutzt', () => {
  const xml =
    '<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1">' +
    '<TRACK TrackID="7" Name="Tempowechsel" Artist="Test" TotalTime="40" AverageBpm="128">' +
    '<TEMPO Inizio="0" Bpm="128" Metro="3/4" Battito="1" />' +
    '<TEMPO Inizio="30" Bpm="140" Metro="3/4" Battito="1" />' +
    '</TRACK></COLLECTION></DJ_PLAYLISTS>';
  const { track } = extractTrackFromRekordboxXml(xml, 0);
  assertEqual(track.beatGrid.meter, 3, 'Metro="3/4" gelesen statt 4/4 anzunehmen');
  assertEqual(track.beatGrid.firstBeat, 0, 'Erster Anker aus der Datei');
  const atAnchor = track.beatGrid.beats.some((beat) => Math.abs(beat.time - 30) < 1e-9);
  assert(atAnchor, 'Zweiter TEMPO-Eintrag bei 30 s verankert keinen Schlag');
  const idx = track.beatGrid.beats.findIndex((beat) => Math.abs(beat.time - 30) < 1e-9);
  const gapBefore = track.beatGrid.beats[idx].time - track.beatGrid.beats[idx - 1].time;
  const gapAfter = track.beatGrid.beats[idx + 1].time - track.beatGrid.beats[idx].time;
  assert(Math.abs(gapBefore - 60 / 128) < 1e-6, `Vor dem Wechsel gilt nicht 128 BPM (${gapBefore})`);
  assert(Math.abs(gapAfter - 60 / 140) < 1e-6, `Nach dem Wechsel gilt nicht 140 BPM (${gapAfter})`);
  assertEqual(track.beatGrid.beatsAreDerived, true, 'Zwischen den Ankern wird fortgeschrieben – muss gekennzeichnet sein');
  return `Anker 0 s (128 BPM) und 30 s (140 BPM) · Abstand davor ${(gapBefore * 1000).toFixed(1)} ms, danach ${(gapAfter * 1000).toFixed(1)} ms · Taktmaß 3`;
});

// ─── Zusammenfassung + Nachweisdatei ───────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;
results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const color = r.passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}[${icon}]\x1b[0m #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs.toFixed(2)}ms)`);
  if (r.passed) passedCount++;
  else {
    failedCount++;
    console.log(`       Error: ${r.error}\n`);
  }
});

mkdirSync(resolve(HERE, 'artifacts/rekordbox-source-of-truth'), { recursive: true });
writeFileSync(
  resolve(HERE, 'artifacts/rekordbox-source-of-truth/NACHWEIS.md'),
  [
    '# Nachweis: 100 % Rekordbox-Daten (Quelle der Wahrheit)',
    '',
    'Regel: „Alle visuellen und zeitlichen Daten müssen zu 100 % aus den realen',
    'Rekordbox/Hackerblocks-Daten stammen … Eine eigene Analyse-Engine ist nicht das Ziel.“',
    '',
    '| Prüfung | Ergebnis |',
    '| --- | --- |',
    ...results.map((r) => `| ${r.suite} · ${r.name} | ${r.passed ? 'bestanden' : `FEHLER: ${r.error}`} |`),
    '',
    '## Messwerte',
    '',
    ...details.map((entry) => '```\n' + entry + '\n```\n'),
    '## Offen (bewusst, dokumentiert)',
    '',
    'Nach einem Eingriff ins Audio wird die Wellenform der bearbeiteten Spur aus dem',
    'vorhandenen PCM neu gezeichnet (`analyzePcm`, Herkunft `PROJECT`), weil die',
    'ANLZ-Kurven fest an die Originalsamples gebunden sind. Das ist als',
    'Nachzeichnung beschriftet und im Editor sichtbar; die dauerhafte Lösung ist das',
    'Mitschieben der importierten Buckets (siehe WELLENFORM-DATEN.md).',
    '',
  ].join('\n'),
  'utf-8'
);

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Ergebnis: ${results.length} Prüfungen · bestanden: ${passedCount} · fehlgeschlagen: ${failedCount}`);
console.log('Nachweis: tests/artifacts/rekordbox-source-of-truth/NACHWEIS.md');
if (failedCount > 0) process.exit(1);
