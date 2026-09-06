/**
 * @license
 * Airdox_intelligents_Editor – Nachweis: realer Schneide-Workflow
 *
 * Dieser Durchlauf spielt genau das nach, was in der App getan wird, und zwar an
 * Material, bei dem jeder Takt eine eigene Signatur hat. Geprüft wird deshalb
 * nicht „unsere Rechnung gegen sich selbst", sondern: liegt der erwartete Inhalt
 * wirklich an der erwarteten Stelle?
 *
 * Ablauf (16 Takte Material, 120 BPM, 8 kHz) – ein Durchlauf, die Schritte bauen
 * aufeinander auf, es wird nichts zwischendurch zurückgesetzt:
 *   1.  Ausgangsmaterial vermessen (jeder Takt eindeutig bestimmbar)
 *   2.  Rasterung: Einfügen eine Takt hoch, Ersetzen an den nächsten Rand
 *   3.  Takte 5–12 (8 Takte) erst als Clip in die Bibliothek (CLONE)
 *   4.  ausschneiden – Marker und Schleifen müssen mitwandern
 *   5.  den Clip an einer beliebigen Stelle einfügen – dabei Pegel angleichen
 *   6.  darüberlegen – Übersteuerungsschutz, trockenes Material bleibt unangetastet
 *   7.  zwei Takte ersetzen – Länge bleibt, Rest unverändert
 *   8.  Bibliothekspflege und Ablage-Absichten (Duplizieren … Strg = Deck)
 *   9.  die letzten beiden Takte nach vorne ziehen
 *   10. Schritt zurück / wiederherstellen – samplegenau (Undo/Redo wie in der App)
 *   11. Projekt speichern und wieder öffnen (Spur + Bibliothek)
 *   12. Quelldatei unverändert (Read-Only-Zusage, SHA-256)
 *   13. Beweis-WAVs (quelle.wav, endstand.wav)
 *
 * Ausführen: npx tsx tests/workflow-real.test.ts   (bzw. npm run proof:workflow-real)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  CLIP_HEADROOM_CEILING,
  CLIP_MINI_PEAK_BUCKETS,
  CLIP_NORM_TARGET_PEAK,
  addClip,
  applyClipDrop,
  buildClip,
  clipAudioOf,
  clipDisplayIndex,
  clipExportFileName,
  describeClip,
  dropModeFor,
  duplicateClip,
  ensureConsistentClip,
  moveClip,
  normalizeLibrary,
  readClipDragPayload,
  removeClip,
  renameClip,
  resolveClipTargetTime,
  toDbfs,
} from '../src/audio/clipLibrary';
import { EditableAudio, cutRange, moveRangeToStart, regrowBeatGrid, secondsPerBeat } from '../src/audio/editOps';
import { PcmAudio, pcmDuration, pcmPeak, pcmRangesEqual, pcmSampleCount, pcmScale, pcmSlice } from '../src/audio/pcm';
import { decodeWav, encodeWav } from '../src/audio/wav';
import {
  buildProjectFile,
  decodeAudioBlock,
  parseProject,
  serializeProject,
  type ProjectClip,
  type ProjectTrack,
} from '../src/projects/projectFormat';
import { extractMiniPeaksPcm } from '../src/waveform/analyzer';
import { BeatGrid, CuePoint, DataOrigin, EditHistoryEntry, LoopPoint, PaletteClip } from '../src/types/rekordbox';

// ── Maßstab des Materials ──────────────────────────────────────────────────

const SAMPLE_RATE = 8000;
const BPM = 120;
const SPB = 60 / BPM; // 0,5 s
const METER = 4;
const BAR_SECONDS = SPB * METER; // 2 s
const BAR_SAMPLES = Math.round(BAR_SECONDS * SAMPLE_RATE); // 16000
const BARS = 16;
const TOTAL_SAMPLES = BAR_SAMPLES * BARS;

/** Tonhöhe und Pegel eines Takts – die unabhängige Signatur des Inhalts. */
const barFreq = (bar: number) => 220 + 100 * bar; // 220 … 1720 Hz
const barPeak = (bar: number) => 0.3 + 0.02 * bar; // 0,30 … 0,60

function barTone(bar: number): Float32Array {
  const out = new Float32Array(BAR_SAMPLES);
  const freq = barFreq(bar);
  const amp = barPeak(bar);
  for (let j = 0; j < BAR_SAMPLES; j++) {
    const envelope = 0.35 + 0.65 * (1 - j / BAR_SAMPLES); // am Taktanfang am lautesten
    out[j] = amp * envelope * Math.sin((2 * Math.PI * freq * j) / SAMPLE_RATE);
  }
  return out;
}

function buildMaterial(): PcmAudio {
  const left = new Float32Array(TOTAL_SAMPLES);
  const right = new Float32Array(TOTAL_SAMPLES);
  for (let bar = 0; bar < BARS; bar++) {
    const tone = barTone(bar);
    left.set(tone, bar * BAR_SAMPLES);
    for (let j = 0; j < BAR_SAMPLES; j++) {
      right[bar * BAR_SAMPLES + j] = tone[j] * 0.9; // rechts leiser – fällt bei Kanaltausch auf
    }
  }
  return { sampleRate: SAMPLE_RATE, channels: [left, right] };
}

const barRange = (bar: number) => ({ start: bar * BAR_SAMPLES, end: (bar + 1) * BAR_SAMPLES });

/** Goertzel-Leistung einer Frequenz – Messung ohne Kenntnis der Schnitt-Logik. */
function tonePower(pcm: PcmAudio, startSample: number, samples: number, freq: number): number {
  const data = pcm.channels[0];
  const n = Math.max(1, Math.min(samples, data.length - startSample));
  const k = (freq * n) / SAMPLE_RATE;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = data[startSample + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/** Welcher Takt liegt hier – und wie eindeutig? */
function identifyBar(pcm: PcmAudio, startSample: number, samples: number): { bar: number; margin: number; ratio: number } {
  const scored = Array.from({ length: BARS }, (_, bar) => ({ bar, power: tonePower(pcm, startSample, samples, barFreq(bar)) })).sort(
    (a, b) => b.power - a.power
  );
  const firstQuarter = pcmPeak(pcm, startSample, startSample + Math.floor(samples / 4));
  const lastQuarter = pcmPeak(pcm, startSample + Math.floor((3 * samples) / 4), startSample + samples);
  return {
    bar: scored[0].bar,
    margin: scored[1].power > 0 ? scored[0].power / scored[1].power : Number.POSITIVE_INFINITY,
    ratio: lastQuarter > 0 ? firstQuarter / lastQuarter : Number.POSITIVE_INFINITY,
  };
}

/** Taktfolge eines Materials, Takt für Takt identifiziert (null = nicht bestimmbar). */
function barsOf(pcm: PcmAudio): Array<number | null> {
  const count = Math.floor(pcmSampleCount(pcm) / BAR_SAMPLES);
  const out: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    const found = identifyBar(pcm, i * BAR_SAMPLES, BAR_SAMPLES);
    out.push(found.margin > 1.35 && found.ratio > 1.15 ? found.bar : null);
  }
  return out;
}

const fmtBars = (list: Array<number | null>): string => list.map((bar) => (bar === null ? '?' : String(bar))).join(' ');

function makeGrid(totalSamples: number): BeatGrid {
  const beats = Array.from({ length: Math.round(totalSamples / SAMPLE_RATE / SPB) + 1 }, (_, i) => ({
    index: i,
    time: i * SPB,
    isBarStart: i % METER === 0,
    barNumber: Math.floor(i / METER) + 1,
    beatInBar: (i % METER) + 1,
  }));
  return { firstBeat: 0, bpm: BPM, meter: METER, origin: DataOrigin.GENERATED_FALLBACK, beats };
}

function trackOf(pcm: PcmAudio): EditableAudio {
  const cueAt = (id: string, bar: number, name: string, color: string): CuePoint => ({
    id,
    name,
    type: 'MEMORY',
    position: bar * BAR_SECONDS,
    inMsec: Math.round(bar * BAR_SECONDS * 1000),
    barNumber: bar + 1,
    beatNumber: 1,
    color,
    origin: DataOrigin.LOCAL_ANALYSIS,
  });
  const cues: CuePoint[] = [
    cueAt('cue-1', 1, 'MEM 1', '#00a2ff'),
    cueAt('cue-2', 6, 'MEM 2 (fällt dem Schnitt zum Opfer)', '#00a2ff'),
    cueAt('cue-3', 14, 'MEM 3', '#7ad3a2'),
  ];
  const loops: LoopPoint[] = [
    { id: 'loop-1', start: 0, end: BAR_SECONDS, length: BAR_SECONDS, name: 'Intro-Schleife', color: '#ff9500', origin: DataOrigin.LOCAL_ANALYSIS },
    { id: 'loop-2', start: 8 * BAR_SECONDS, end: 10 * BAR_SECONDS, length: 2 * BAR_SECONDS, name: 'Takte 9–10', color: '#ff9500', origin: DataOrigin.LOCAL_ANALYSIS },
  ];
  return { audio: pcm, cues, loops, beatGrid: makeGrid(pcmSampleCount(pcm)) };
}

function maxAbsDifference(a: PcmAudio, b: PcmAudio): number {
  let worst = 0;
  const samples = Math.min(pcmSampleCount(a), pcmSampleCount(b));
  for (let ch = 0; ch < Math.min(a.channels.length, b.channels.length); ch++) {
    for (let i = 0; i < samples; i++) {
      const d = Math.abs(a.channels[ch][i] - b.channels[ch][i]);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

// ── Testrahmen ─────────────────────────────────────────────────────────────

const ARTIFACT_DIR = path.join('tests', 'artifacts', 'workflow-real');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

interface StepResult {
  index: number;
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  error?: string;
  durationMs: number;
}

const results: StepResult[] = [];

function step(name: string, expected: string, run: () => string): void {
  const t0 = performance.now();
  try {
    const actual = run();
    results.push({
      index: results.length + 1,
      name,
      passed: true,
      expected,
      actual,
      durationMs: Math.round((performance.now() - t0) * 10) / 10,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const carried = err instanceof Error ? (err as unknown as { actual?: unknown }).actual : undefined;
    const actual = typeof carried === 'string' ? carried : error;
    results.push({
      index: results.length + 1,
      name,
      passed: false,
      expected,
      actual,
      error,
      durationMs: Math.round((performance.now() - t0) * 10) / 10,
    });
  }
}

function expect(condition: unknown, message: string, actual?: string): void {
  if (!condition) {
    const err = new Error(message) as Error & { actual?: string };
    err.actual = actual !== undefined ? `${message} – tatsächlich: ${actual}` : message;
    throw err;
  }
}

// ── Zustand des Durchlaufs ──────────────────────────────────────────────────

const source = buildMaterial();
const sourceFile = path.join(ARTIFACT_DIR, 'quelle.wav');
fs.writeFileSync(sourceFile, Buffer.from(encodeWav(source)));
const sourceDigest = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');

let track = trackOf(source);
let library: PaletteClip[] = [];
let cutClip: PaletteClip | null = null;
const history: { undo: EditHistoryEntry[]; redo: EditHistoryEntry[] } = { undo: [], redo: [] };

/** Schnappschuss exakt so, wie die App Rückgängig baut (src/App.tsx pushHistorySnapshot). */
function pushSnapshot(description: string): void {
  history.undo.push({
    description,
    timestamp: 1700000000000 + history.undo.length,
    segments: [],
    selection: null,
    cues: track.cues.map((cue) => ({ ...cue })),
    loops: track.loops.map((loop) => ({ ...loop })),
    beatGrid: track.beatGrid,
    audio: track.audio,
  });
  history.redo = [];
}

function restore(entry: EditHistoryEntry): void {
  track = {
    audio: entry.audio ?? track.audio,
    cues: entry.cues ?? [],
    loops: entry.loops ?? [],
    beatGrid: entry.beatGrid ?? track.beatGrid,
  };
}

function snapshotOf(description: string): EditHistoryEntry {
  return {
    description,
    timestamp: 1700000000500,
    segments: [],
    selection: null,
    cues: track.cues.map((cue) => ({ ...cue })),
    loops: track.loops.map((loop) => ({ ...loop })),
    beatGrid: track.beatGrid,
    audio: track.audio,
  };
}

function undo(): void {
  const previous = history.undo.pop();
  if (!previous) throw new Error('nichts zum Zurücknehmen');
  history.redo.push(snapshotOf('Vor dem Rückgängig'));
  restore(previous);
}

function redo(): void {
  const next = history.redo.pop();
  if (!next) throw new Error('nichts zum Wiederherstellen');
  history.undo.push(snapshotOf('Vor dem Wiederholen'));
  restore(next);
}

// ── 1. Ausgangsmaterial ─────────────────────────────────────────────────────

step(
  'Ausgangsmaterial: 16 eindeutige Takte',
  'Taktfolge 0…15, Peak je Takt 0,30…0,60, Beatgrid mit 65 Beats',
  () => {
    const order = barsOf(track.audio);
    expect(
      fmtBars(order) === Array.from({ length: BARS }, (_, i) => String(i)).join(' '),
      'Taktfolge nicht wie gebaut',
      fmtBars(order)
    );
    for (let bar = 0; bar < BARS; bar++) {
      const { start, end } = barRange(bar);
      const peak = pcmPeak(track.audio, start, end);
      expect(Math.abs(peak - barPeak(bar)) < 0.02, `Peak in Takt ${bar} weicht ab`, peak.toFixed(4));
    }
    expect(pcmSampleCount(track.audio) === TOTAL_SAMPLES, 'Länge falsch', String(pcmSampleCount(track.audio)));
    expect(secondsPerBeat(track.beatGrid) === SPB, 'Beatlänge falsch', String(secondsPerBeat(track.beatGrid)));
    expect(track.beatGrid.beats.length === BARS * METER + 1, 'Beatgrid unvollständig', String(track.beatGrid.beats.length));
    return `${BARS} Takte, ${TOTAL_SAMPLES} Samples, Peaks je Takt 0,30…${String(barPeak(BARS - 1).toFixed(2)).replace('.', ',')} (gemessen ${Math.min(...Array.from({ length: BARS }, (_, bar) => pcmPeak(track.audio, barRange(bar).start, barRange(bar).end))).toFixed(3)}…${Math.max(...Array.from({ length: BARS }, (_, bar) => pcmPeak(track.audio, barRange(bar).start, barRange(bar).end))).toFixed(3)})`;
  }
);

// ── 2. Auswahl auf Taktränder ───────────────────────────────────────────────

const CUT_START_BAR = 4;
const CUT_BARS = 8;
const cutStartSeconds = CUT_START_BAR * BAR_SECONDS;
const cutEndSeconds = (CUT_START_BAR + CUT_BARS) * BAR_SECONDS;

step(
  'Auswahl Takte 5–12: Rasterung – Einfügen eine Takt hoch, Ersetzen an den nächsten Rand',
  `Einfügen: ${((CUT_START_BAR + 1) * BAR_SECONDS).toFixed(3)} s (aufwärts), Ersetzen: ${cutStartSeconds.toFixed(3)} s (nächster Rand), ohne Raster: frei · Auswahl selbst liegt samplegenau auf Takträndern`,
  () => {
    const wanted = cutStartSeconds + 0.13;
    const trackLength = pcmDuration(track.audio);
    const insert = resolveClipTargetTime(wanted, track.beatGrid, { quantize: true, mode: 'insert', maxSeconds: trackLength });
    expect(Math.abs(insert.seconds - (CUT_START_BAR + 1) * BAR_SECONDS) < 1e-9, 'Einfügen rastet nicht auf den nächsten Taktanfang', insert.seconds.toFixed(4));
    expect(insert.reason === 'auf Taktanfang gerastet', 'Rastermeldung fehlt', String(insert.reason));
    const replace = resolveClipTargetTime(wanted, track.beatGrid, { quantize: true, mode: 'replace', maxSeconds: trackLength });
    expect(Math.abs(replace.seconds - cutStartSeconds) < 1e-9, 'Ersetzen rastet nicht auf den nächstgelegenen Takt', replace.seconds.toFixed(4));
    const free = resolveClipTargetTime(wanted, null, { quantize: false });
    expect(Math.abs(free.seconds - wanted) < 1e-9, 'ohne Raster wird verschoben', free.seconds.toFixed(4));
    // Der Schnitt selbst arbeitet samplegenau auf den Takträndern – 0,1 s Versatz dürfen wir nicht „einbauen“.
    expect(Math.round(cutStartSeconds * SAMPLE_RATE) % BAR_SAMPLES === 0, 'Start nicht taktsynchron');
    expect(Math.round(cutEndSeconds * SAMPLE_RATE) % BAR_SAMPLES === 0, 'Ende nicht taktsynchron');
    return `Einfügen → ${insert.seconds.toFixed(3)} s (${insert.reason}), Ersetzen → ${replace.seconds.toFixed(3)} s, ohne Raster → ${free.seconds.toFixed(3)} s`;
  }
);

// ── 3. Erst in die Bibliothek, dann ausschneiden ────────────────────────────

step(
  'Auswahl als Clip in die Bibliothek (wie CLONE in der App)',
  `Clip über ${CUT_BARS} Takte, Peak = lautester Takt des Clips (${barPeak(CUT_START_BAR + CUT_BARS - 1).toFixed(3)} ± 0.02), ${CLIP_MINI_PEAK_BUCKETS} Vorschau-Buckets`,
  () => {
    const slice = pcmSlice(track.audio, cutStartSeconds, cutEndSeconds);
    const clip = buildClip(
      {
        name: 'Acht Takte Mitte',
        sourceTrackId: 'workflow-track',
        sourceTrackName: 'Workflow-Nachweisspur',
        sourceStart: cutStartSeconds,
        sourceEnd: cutEndSeconds,
        bpm: BPM,
        key: '2A',
        meter: METER,
        origin: DataOrigin.PROJECT,
        pcm: slice,
      },
      { existing: library }
    );
    library = addClip(library, clip);
    cutClip = library[0];
    expect(cutClip.bars === CUT_BARS, 'Taktzahl falsch', String(cutClip.bars));
    expect(Math.abs(pcmPeak(cutClip.clipPcm!) - barPeak(CUT_START_BAR + CUT_BARS - 1)) < 0.02, 'Clip-Pegelspitze falsch');
    expect((cutClip.miniPeaks ?? []).length === CLIP_MINI_PEAK_BUCKETS, 'Vorschau-Buckets falsch');
    expect(Math.max(...(cutClip.miniPeaks ?? [0])) > 0.4, 'Vorschau bildet den Peak nicht ab');
    const repaired = ensureConsistentClip(cutClip);
    expect(repaired.duration === cutClip.duration && repaired.beats === cutClip.beats, 'Reparatur ändert Konsistentes');
    const { dropped } = normalizeLibrary(library, { bpm: BPM });
    expect(dropped.length === 0, 'Bibliothek wirft den Clip heraus', dropped.map((d) => d.reason).join(', '));
    return describeClip(cutClip);
  }
);

step(
  'Ausschneiden: 8 Takte raus, Marker und Schleifen ziehen mit',
  '128000 Samples weniger, Takt-7-Marker entfällt, Takt-15-Marker rückt auf Takt 7, Intro-Schleife bleibt, Takte-9/10-Schleife entfällt',
  () => {
    pushSnapshot('8 Takte ausschneiden');
    const { target, report } = cutRange(track, cutStartSeconds, cutEndSeconds);
    const duration = pcmDuration(target.audio);
    track = { ...target, beatGrid: regrowBeatGrid(target.beatGrid, duration) };
    const order = barsOf(track.audio);
    const expectedOrder = [0, 1, 2, 3, 12, 13, 14, 15];
    expect(fmtBars(order) === fmtBars(expectedOrder), 'Taktfolge nach dem Schnitt falsch', fmtBars(order));
    expect(report.removedSamples === CUT_BARS * BAR_SAMPLES, 'entfernte Samplezahl falsch', String(report.removedSamples));
    expect(report.removedCues === 1, 'ein Marker musste entfallen', String(report.removedCues));
    expect(report.shiftedCues === 1, 'ein Marker musste mitwandern', String(report.shiftedCues));
    const barsWithCue = track.cues.map((cue) => Math.round(cue.position / BAR_SECONDS)).sort((a, b) => a - b);
    expect(barsWithCue.join(',') === '1,6', 'Markerzeiten nach dem Schnitt falsch', barsWithCue.join(','));
    expect(track.loops.length === 1, 'Anzahl Schleifen falsch', String(track.loops.length));
    expect(Math.abs(track.loops[0].end - BAR_SECONDS) < 1e-9, 'Intro-Schleife verschoben', track.loops[0].end.toFixed(3));
    expect(pcmSampleCount(track.audio) === (BARS - CUT_BARS) * BAR_SAMPLES, 'Länge nach dem Schnitt falsch', String(pcmSampleCount(track.audio)));
    expect(track.beatGrid.beats.length === Math.round(duration / SPB) + 1, 'Beatgrid wächst nicht mit', String(track.beatGrid.beats.length));
    // Der herausgeschnittene Inhalt ist genau das, was als Clip in der Bibliothek liegt.
    const clipped = clipAudioOf(cutClip!)!;
    expect(pcmRangesEqual(clipped, 0, source, cutStartSeconds * SAMPLE_RATE, pcmSampleCount(clipped)), 'Clip enthält nicht den ausgeschnittenen Inhalt');
    return `${report.removedSamples} Samples entfernt, ${fmtBars(order)}, Marker in Takt ${barsWithCue.join('+')}, ${track.loops.length} Schleife`;
  }
);

// ── 4. Clip an beliebiger Stelle wieder einfügen ───────────────────────────

const INSERT_WANTED_SECONDS = 3.71; // bewusst abseits jedes Taktrands
const insertTargetSeconds = 2 * BAR_SECONDS; // nächstgelegener Taktanfang darüber: Takt 3

step(
  'Clip an beliebiger Stelle einfügen: rastet auf Takt 3, Pegel wird angeglichen',
  `Zielzeit ${insertTargetSeconds.toFixed(3)} s · Taktfolge 0 1 [4…11] 2 3 12 13 14 15 · lautester eingefügter Takt ${CLIP_NORM_TARGET_PEAK.toFixed(3)}, nichts über ${CLIP_HEADROOM_CEILING.toFixed(3)}`,
  () => {
    pushSnapshot('Clip einfügen');
    const clipAudio = clipAudioOf(cutClip!);
    expect(clipAudio !== null, 'Clip ohne Audiodaten');
    const peakBefore = pcmPeak(clipAudio!);
    const outcome = applyClipDrop(track, clipAudio!, INSERT_WANTED_SECONDS, { quantize: true, mode: 'insert' });
    expect(outcome.mode === 'insert', 'falscher Ablagemodus', outcome.mode);
    expect(Math.abs(outcome.atSeconds - insertTargetSeconds) < 1e-9, 'nicht auf Takt 3 gerastet', outcome.atSeconds.toFixed(4));
    expect(outcome.snapped === true, 'rasten wurde nicht gemeldet');
    expect(outcome.level.applied === true, 'Normalisierung unterblieben');
    const expectedGain = CLIP_NORM_TARGET_PEAK / peakBefore;
    expect(Math.abs(outcome.level.gain - expectedGain) < 1e-6, 'Verstärkung rechnet anders als erwartet', `${outcome.level.gain} vs ${expectedGain}`);
    expect(Math.abs(pcmPeak(outcome.placedAudio) - CLIP_NORM_TARGET_PEAK) < 1e-3, 'Ziel-Pegel nicht erreicht', pcmPeak(outcome.placedAudio).toFixed(4));
    expect(pcmSampleCount(outcome.placedAudio) === pcmSampleCount(clipAudio!), 'Normalisierung verändert die Samplezahl');

    const before = track.audio;
    track = outcome.target;
    const order = barsOf(track.audio);
    const expected = [0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 2, 3, 12, 13, 14, 15];
    expect(fmtBars(order) === fmtBars(expected), 'eingefügter Inhalt liegt nicht an der erwarteten Stelle', fmtBars(order));
    // Die Normierung geht auf die *Spitzensample des Clips*: nur der lauteste Takt
    // des Clips landet auf dem Ziel, die leiseren entsprechend darunter.
    const insertedPeak = pcmPeak(track.audio, 2 * BAR_SAMPLES, 3 * BAR_SAMPLES);
    expect(
      Math.abs(insertedPeak - barPeak(CUT_START_BAR) * expectedGain) < 0.01,
      'erster eingefügter Takt nicht wie erwartet verstärkt',
      `${insertedPeak.toFixed(4)} statt ${(barPeak(CUT_START_BAR) * expectedGain).toFixed(4)}`
    );
    const loudestInserted = pcmPeak(track.audio, 9 * BAR_SAMPLES, 10 * BAR_SAMPLES);
    expect(
      Math.abs(loudestInserted - CLIP_NORM_TARGET_PEAK) < 0.01,
      'lautester Takt des Clips erreicht das Ziel nicht',
      loudestInserted.toFixed(4)
    );
    expect(loudestInserted <= CLIP_HEADROOM_CEILING, 'eingefügter Clip über der Obergrenze');
    expect(pcmRangesEqual(track.audio, 0, before, 0, 2 * BAR_SAMPLES), 'Material vor der Einfügestelle verändert');
    expect(
      pcmRangesEqual(track.audio, 10 * BAR_SAMPLES, before, 2 * BAR_SAMPLES, 6 * BAR_SAMPLES),
      'hinter dem Clip folgende Takte nicht richtig nachgerückt'
    );
    expect(
      pcmPeak(track.audio, 0, BAR_SAMPLES) === pcmPeak(before, 0, BAR_SAMPLES),
      'Pegel außerhalb des Clips verändert'
    );
    const barsWithCue = track.cues.map((cue) => Math.round(cue.position / BAR_SECONDS)).sort((a, b) => a - b);
    expect(barsWithCue.join(',') === '1,14', 'Marker ziehen beim Einfügen nicht mit', barsWithCue.join(','));
    const summary = `Ziel ${outcome.atSeconds.toFixed(3)} s · gain ${outcome.level.gain.toFixed(3)} (${(20 * Math.log10(outcome.level.gain)).toFixed(1)} dB) · Peak ${outcome.level.peakBefore.toFixed(3)}→${outcome.level.peakAfter.toFixed(3)} · ${fmtBars(order)}`;
    return summary;
  }
);

// ── 5. Darüberlegen: Übersteuerung verhindern ───────────────────────────────

step(
  'Darüberlegen: clippt nicht, trockenes Material bleibt unangetastet',
  `kein Sample über ${CLIP_HEADROOM_CEILING.toFixed(3)} · Clip wird bei Bedarf leiser gemischt · außerhalb bitgenau gleich`,
  () => {
    // Angeforderte Situation: Spur bis an den Zielpegel des Editors gefahren.
    const hotBase = trackOf(pcmScale(track.audio, CLIP_NORM_TARGET_PEAK / Math.max(pcmPeak(track.audio), 1e-9)));
    const clipAudio = clipAudioOf(cutClip!)!;
    const outcome = applyClipDrop(hotBase, clipAudio, 4 * BAR_SECONDS, { quantize: true, mode: 'overdub' });
    const peakAfter = pcmPeak(outcome.target.audio);
    expect(peakAfter <= CLIP_HEADROOM_CEILING + 1e-6, `Übersteuerung nach dem Überlagern: ${peakAfter.toFixed(4)}`);
    expect(outcome.mix !== undefined, 'Misch-Report fehlt');
    expect(outcome.mix!.attenuated === true, 'Kopfraum griff nicht – der Clip wurde ungekürzt gemischt');

    const startSample = Math.round(outcome.atSeconds * SAMPLE_RATE);
    const samples = Math.min(pcmSampleCount(outcome.placedAudio), pcmSampleCount(hotBase.audio) - startSample);
    const dryRegionPeak = pcmPeak(hotBase.audio, startSample, startSample + samples);
    const placedPeak = pcmPeak(outcome.placedAudio);
    const available = Math.max(0, CLIP_HEADROOM_CEILING - dryRegionPeak);
    const expectedGain = placedPeak > 0 ? available / placedPeak : 1;
    expect(
      outcome.mix!.gainUsed <= expectedGain + 1e-9,
      'Mischverstärkung höher als der verfügbare Kopfraum',
      `${outcome.mix!.gainUsed.toFixed(8)} vs ${expectedGain.toFixed(8)}`
    );
    // Linearität der Summe, samplegenau – kein Waveshaping.
    let worst = 0;
    for (let i = 0; i < samples; i += 97) {
      const expected = hotBase.audio.channels[0][startSample + i] + outcome.placedAudio.channels[0][i] * outcome.mix!.gainUsed;
      worst = Math.max(worst, Math.abs(outcome.target.audio.channels[0][startSample + i] - expected));
    }
    expect(worst < 1e-6, `Summe ist nicht linear (max. Abweichung ${worst})`);
    expect(pcmRangesEqual(outcome.target.audio, 0, hotBase.audio, 0, startSample), 'Material vor der Überlagerung verändert');
    const afterEnd = startSample + samples;
    expect(
      pcmRangesEqual(outcome.target.audio, afterEnd, hotBase.audio, afterEnd, pcmSampleCount(hotBase.audio) - afterEnd),
      'Material nach der Überlagerung verändert'
    );
    expect(pcmSampleCount(outcome.target.audio) === pcmSampleCount(hotBase.audio), 'Überlagern verändert die Länge');
    expect(
      outcome.report.warnings.length === 0,
      'bei intaktem Material sollte nichts gemeldet werden',
      outcome.report.warnings.join(' | ')
    );
    return `Trocken-Peak ${dryRegionPeak.toFixed(3)} · Clip ${placedPeak.toFixed(3)} · Mischartigkeit ${outcome.mix!.gainUsed.toFixed(3)} · Ergebnis-Peak ${peakAfter.toFixed(3)}`;
  }
);

// ── 6. Zwei Takte ersetzen ─────────────────────────────────────────────────

step(
  'Zwei Takte ersetzen: Länge gleich, Inhalt ausgetauscht, Rest unverändert',
  'gerastert auf Takt 14 (26,000 s) · Taktfolge 0 1 4 5 6 7 8 9 10 11 2 3 12 4 5 15',
  () => {
    pushSnapshot('Bereich ersetzen');
    const replacementPcm = pcmSlice(source, 4 * BAR_SECONDS, 6 * BAR_SECONDS);
    const replacementClip = buildClip(
      {
        name: 'Zwei Takte Ersatz',
        sourceTrackId: 'workflow-track',
        sourceTrackName: 'Workflow-Nachweisspur',
        sourceStart: 4 * BAR_SECONDS,
        sourceEnd: 6 * BAR_SECONDS,
        bpm: BPM,
        key: '2A',
        meter: METER,
        origin: DataOrigin.PROJECT,
        pcm: replacementPcm,
      },
      { existing: library }
    );
    library = addClip(library, replacementClip);
    const before = track.audio;
    const beforeDuration = pcmDuration(before);
    const outcome = applyClipDrop(track, clipAudioOf(library[1])!, 13 * BAR_SECONDS + 0.4, { quantize: true, mode: 'replace' });
    expect(Math.abs(outcome.atSeconds - 13 * BAR_SECONDS) < 1e-9, 'nicht auf Takt 14 gerastet', outcome.atSeconds.toFixed(4));
    expect(Math.abs(pcmDuration(outcome.target.audio) - beforeDuration) < 1e-6, 'ersetzen verändert die Länge');
    const startSample = Math.round(outcome.atSeconds * SAMPLE_RATE);
    const samples = Math.min(pcmSampleCount(outcome.placedAudio), pcmSampleCount(outcome.target.audio) - startSample);
    expect(pcmRangesEqual(outcome.target.audio, startSample, outcome.placedAudio, 0, samples - 1), 'Ersatz liegt nicht an der Zielzeit');
    expect(
      pcmRangesEqual(outcome.target.audio, 0, before, 0, startSample),
      'Material vor dem Ersatz verändert'
    );
    expect(
      pcmRangesEqual(outcome.target.audio, startSample + samples, before, startSample + samples, pcmSampleCount(before) - startSample - samples),
      'Material nach dem Ersatz verschoben'
    );
    const order = barsOf(outcome.target.audio);
    const expected = [0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 2, 3, 12, 4, 5, 15];
    expect(fmtBars(order) === fmtBars(expected), 'Taktfolge nach dem Ersetzen falsch', fmtBars(order));
    expect(outcome.report.kind === 'REPLACE_RANGE', 'falscher Operationstyp', outcome.report.kind);
    expect(outcome.level.applied === true, 'Ersatz-Clip wurde nicht normalisiert');
    track = outcome.target;
    return `ersetzt ab ${outcome.atSeconds.toFixed(3)} s (${samples} Samples), Länge bleibt ${pcmDuration(track.audio).toFixed(3)} s, ${fmtBars(order)}`;
  }
);

// ── 7. Bibliothekspflege und Ablage-Absichten ───────────────────────────────

step(
  'Bibliothek: duplizieren, umbenennen, sortieren, entfernen · Strg = Deck-Spieler',
  'ein Eintrag mehr nach dem Duplizieren, einer weniger nach dem Entfernen, eindeutige Namen, Reihenfolge zurücksetzbar, Deck lädt Originalsamples',
  () => {
    const clipsBefore = library.length;
    library = duplicateClip(library, library[0].id);
    expect(library.length === clipsBefore + 1, 'Duplikat fehlt', String(library.length));
    expect(library[1].name.includes('(Kopie)'), 'Duplikatname nicht eindeutig', library[1].name);
    expect(
      pcmRangesEqual(clipAudioOf(library[1])!, 0, clipAudioOf(library[0])!, 0, pcmSampleCount(clipAudioOf(library[1])!)),
      'Duplikat enthält anderen Inhalt'
    );
    expect(clipDisplayIndex(library, library[1].id) === 2, 'Nummerierung des Duplikats falsch', String(clipDisplayIndex(library, library[1].id)));

    const renamed = renameClip(library, library[1].id, 'Eigener Name');
    expect(renamed[1].name === 'Eigener Name', 'umbenennen wirkungslos', renamed[1].name);
    library = renamed;

    const orderBefore = library.map((clip) => clip.id).join('>');
    const movedId = library[0].id;
    const movedDown = moveClip(library, movedId, 1);
    expect(movedDown.map((clip) => clip.id).join('>') !== orderBefore, 'verschieben ohne Wirkung');
    expect(movedDown[1].id === movedId, 'verschieben landete nicht auf Position 2', movedDown.map((c) => c.id).join('>'));
    // Rückweg über dieselbe Clip-Id: moveClip verschiebt genau dieses Element um delta Positionen.
    const restoredOrder = moveClip(movedDown, movedId, -1);
    expect(new Set(restoredOrder.map((clip) => clip.id)).size === restoredOrder.length, 'Reihenfolge verlor Einträge');
    expect(restoredOrder.map((clip) => clip.id).join('>') === orderBefore, 'zurücksetzen der Reihenfolge misslang', restoredOrder.map((c) => c.id).join('>'));
    library = restoredOrder;

    expect(dropModeFor({ ctrlKey: true }) === 'deck', 'Strg muss in den Deck-Spieler zeigen');
    expect(dropModeFor({ metaKey: true }) === 'deck', 'Cmd muss in den Deck-Spieler zeigen');
    expect(dropModeFor({ altKey: true }) === 'overdub', 'Alt muss darüberlegen');
    expect(dropModeFor({ shiftKey: true }) === 'replace', 'Umschalt muss ersetzen');
    expect(dropModeFor({}) === 'insert', 'ohne Taste muss einfügen');
    const payload = readClipDragPayload({
      getData: (type: string) => (type === 'application/x-airdox-clip' ? JSON.stringify({ kind: 'airdox.clip', id: library[0].id }) : ''),
    });
    expect(payload?.clipId === library[0].id, 'Drag-Payload nicht lesbar');

    // Der Deck-Weg verändert nichts an der Spur und spielt genau die gespeicherten Samples.
    const deckAudio = clipAudioOf(library[0])!;
    expect(pcmPeak(deckAudio) === pcmPeak(library[0].clipPcm!), 'Deck spielt anderen Inhalt als gespeichert');
    expect(Math.abs(pcmPeak(deckAudio) - barPeak(CUT_START_BAR + CUT_BARS - 1)) < 0.02, 'Deck-Clip nicht das Originalmaterial');
    const samplesBefore = pcmSampleCount(track.audio);
    library = removeClip(library, library[1].id);
    expect(library.length === clipsBefore, 'entfernen zählt nicht zurück', String(library.length));
    expect(pcmSampleCount(track.audio) === samplesBefore, 'Bibliothekspflege verändert die Spur');
    const name = clipExportFileName(library, library[0]);
    expect(/^01_[A-Za-z0-9._-]+\.wav$/.test(name), `Exportname unplausibel: ${name}`);
    // Die Nummer im Dateinamen folgt der Position in der Liste – hier Takt 2 der Liste.
    const numbered: PaletteClip[] = [library[0], { ...library[1], id: 'clip-nummer-2', name: 'Zwei Takte Ersatz' }];
    expect(clipExportFileName(numbered, numbered[1]) === '02_Zwei_Takte_Ersatz.wav', 'Nummerierung folgt nicht der Liste', clipExportFileName(numbered, numbered[1]));
    expect(clipExportFileName(numbered, numbered[0]) === '01_Acht_Takte_Mitte.wav', 'erster Eintrag falsch nummeriert', clipExportFileName(numbered, numbered[0]));
    return `${clipsBefore + 1} Einträge nach dem Duplikat, ${library.length} nach dem Entfernen, Deck-Modus ${dropModeFor({ ctrlKey: true })}, Export ${name}`;
  }
);

// ── 8. Die letzten Takte nach vorne ziehen ─────────────────────────────────

step(
  'Die letzten beiden Takte nach vorne ziehen',
  'Taktfolge 5 15 0 1 4 5 6 7 8 9 10 11 2 3 12 4 · gleiche Länge · Marker bleiben gültig',
  () => {
    pushSnapshot('letzte zwei Takte nach vorne');
    const totalBars = Math.floor(pcmSampleCount(track.audio) / BAR_SAMPLES);
    const fromSeconds = (totalBars - 2) * BAR_SECONDS;
    const before = track.audio;
    const cuesBefore = track.cues.map((cue) => cue.position).sort((a, b) => a - b);
    const { target, report } = moveRangeToStart(track, fromSeconds, totalBars * BAR_SECONDS, { atSec: 0 });
    track = target;
    const order = barsOf(track.audio);
    // verschoben wurden die alten Indizes 14 und 15 – Inhalt: Takt 5 und Takt 15
    const expected = [5, 15, 0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 2, 3, 12, 4];
    expect(fmtBars(order) === fmtBars(expected), 'umgezogene Takte liegen nicht vorn', fmtBars(order));
    expect(pcmSampleCount(track.audio) === pcmSampleCount(before), 'Verschieben verändert die Länge');
    expect(report.kind === 'MOVE_TO_START', 'falscher Operationstyp', report.kind);
    expect(Math.abs(pcmDuration(track.audio) - pcmDuration(before)) < 1e-9, 'Dauer verändert');
    const cuesAfter = track.cues.map((cue) => cue.position).sort((a, b) => a - b);
    expect(cuesAfter.length === cuesBefore.length, 'Markeranzahl verändert', String(cuesAfter.length));
    expect(
      cuesAfter.every((time) => time >= -1e-9 && time <= pcmDuration(track.audio) + 1e-9),
      'Marker außerhalb der Spur',
      cuesAfter.join(',')
    );
    expect(
      new Set(cuesAfter.map((time) => time.toFixed(3))).size === cuesAfter.length,
      'Marker stehen nach dem Umziehen doppelt',
      cuesAfter.join(',')
    );
    expect(
      track.beatGrid.beats.every((beat) => beat.time <= pcmDuration(track.audio) + 1e-9),
      'Beatgrid zeigt über das Ende hinaus'
    );
    return `${fmtBars(order)} bei gleicher Länge (${pcmSampleCount(track.audio)} Samples)`;
  }
);

// ── 9. Undo / Redo ──────────────────────────────────────────────────────────

step(
  'Schritt zurück und wiederherstellen: samplegenau',
  'Undo liefert exakt den Stand vor dem Umziehen, Redo exakt den danach',
  () => {
    const afterMove = track.audio;
    const stateBeforeMove = history.undo[history.undo.length - 1]!.audio!;
    const afterMoveBars = fmtBars(barsOf(afterMove));
    const cuesAfter = JSON.stringify(track.cues);
    const loopsAfter = JSON.stringify(track.loops);
    undo();
    const restoredBars = barsOf(track.audio);
    const expectedBeforeMove = [0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 2, 3, 12, 4, 5, 15];
    expect(fmtBars(restoredBars) === fmtBars(expectedBeforeMove), 'Undo stellt die Taktfolge nicht her', fmtBars(restoredBars));
    const previous = history.undo[history.undo.length - 1];
    expect(previous.description === 'Bereich ersetzen', 'Undo zeigt auf den falschen Schritt', previous.description);
    expect(maxAbsDifference(track.audio, stateBeforeMove) === 0, 'Undo-Samples nicht bitgenau', String(maxAbsDifference(track.audio, stateBeforeMove)));
    redo();
    expect(fmtBars(barsOf(track.audio)) === afterMoveBars, 'Redo verliert das Umziehen', fmtBars(barsOf(track.audio)));
    expect(maxAbsDifference(track.audio, afterMove) === 0, 'Redo-Samples nicht bitgenau');
    expect(JSON.stringify(track.cues) === cuesAfter, 'Marker nicht wiederhergestellt');
    expect(JSON.stringify(track.loops) === loopsAfter, 'Schleifen nicht wiederhergestellt');
    return `undo → ${fmtBars(restoredBars).slice(0, 11)}…, redo identisch zum Stand nach dem Umziehen (${track.cues.length} Marker, ${track.loops.length} Schleifen)`;
  }
);

// ── 10. Projekt speichern und öffnen ───────────────────────────────────────

step(
  'Projektdatei: Endstand und Bibliothek überleben Speichern und Öffnen',
  'Samples innerhalb eines 16-Bit-Schritts (≤ 1/32768), Clipzahl/-taktzahl/-peak erhalten, originalsModified false',
  () => {
    const projectTrack: Omit<ProjectTrack, 'audio'> & { pcm: PcmAudio } = {
      id: 'workflow-track',
      title: 'Workflow-Nachweisspur',
      artist: 'Airdox Editor',
      album: 'Realer Workflow',
      key: '2A',
      bpm: BPM,
      duration: Math.round(pcmDuration(track.audio) * 1e6) / 1e6,
      sampleRate: SAMPLE_RATE,
      channels: track.audio.channels.length,
      origin: DataOrigin.PROJECT,
      originalSha256: `sha256:${sourceDigest.slice(0, 16)}`,
      isOriginalUntouched: true,
      source: { location: `file:///${sourceFile.replace(/\\/g, '/')}`, accessMode: 'READ_ONLY', status: 'AVAILABLE' },
      cues: track.cues,
      loops: track.loops,
      beatGrid: track.beatGrid,
      phrases: [],
      segments: [
        {
          id: 'seg-original',
          type: 'ORIGINAL',
          sourceStart: 0,
          sourceEnd: pcmDuration(track.audio),
          projectStart: 0,
          projectDuration: pcmDuration(track.audio),
          gain: 1,
        },
      ],
      pcm: track.audio,
    };
    const clips: Array<Omit<ProjectClip, 'audio'> & { pcm: PcmAudio }> = library.map((clip) => ({
      id: clip.id,
      name: clip.name,
      sourceTrackId: clip.sourceTrackId,
      sourceTrackName: clip.sourceTrackName,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      duration: clip.duration,
      beats: clip.beats,
      bars: clip.bars,
      bpm: clip.bpm,
      key: clip.key,
      color: clip.color,
      origin: clip.origin,
      miniPeaks: clip.miniPeaks ?? extractMiniPeaksPcm(clipAudioOf(clip)!, CLIP_MINI_PEAK_BUCKETS),
      pcm: clipAudioOf(clip)!,
    }));
    const text = serializeProject(
      buildProjectFile({
        projectName: 'Realer Workflow – Nachweis',
        activeTrackId: 'workflow-track',
        view: { waveformMode: 'AMBER', quantize: true, viewOffset: 0, viewDuration: 12, paletteOpen: true },
        tracks: [projectTrack],
        clips,
        app: { name: 'Airdox_intelligents_Editor', version: '0.1.0' },
      })
    );
    const parsed = parseProject(text);
    expect(parsed.errors.length === 0, `Lesefehler: ${parsed.errors.join(' | ')}`);
    const project = parsed.project!;
    expect(project.provenance.originalsModified === false, 'Projekt behauptet, Originale verändert zu haben');
    const restoredTrack = project.tracks[0];
    const restoredPcm = decodeAudioBlock(restoredTrack.audio).pcm;
    const deviation = maxAbsDifference(restoredPcm, track.audio);
    expect(deviation <= 1 / 32768 + 1e-9, `16-Bit-Raster verletzt: ${deviation}`, String(deviation));
    expect(pcmSampleCount(restoredPcm) === pcmSampleCount(track.audio), 'Länge nach Rundlauf anders');
    expect(fmtBars(barsOf(restoredPcm)) === fmtBars(barsOf(track.audio)), 'Taktfolge nach Rundlauf anders', fmtBars(barsOf(restoredPcm)));

    const restoredClips: PaletteClip[] = project.clips.map((clip) => ({
      id: clip.id,
      name: clip.name,
      sourceTrackId: clip.sourceTrackId,
      sourceTrackName: clip.sourceTrackName,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      duration: clip.duration,
      beats: clip.beats,
      bars: clip.bars,
      bpm: clip.bpm,
      key: clip.key,
      color: clip.color,
      origin: clip.origin,
      miniPeaks: clip.miniPeaks,
      clipPcm: decodeAudioBlock(clip.audio).pcm,
    }));
    const { clips: repaired, dropped } = normalizeLibrary(restoredClips, { bpm: BPM });
    expect(dropped.length === 0, `Clips fielen heraus: ${dropped.map((d) => d.reason).join(', ')}`);
    expect(repaired.length === library.length, 'Clipzahl anders', String(repaired.length));
    expect(repaired[0].bars === CUT_BARS, 'Taktzahl des Clips verloren', String(repaired[0].bars));
    expect(
      maxAbsDifference(clipAudioOf(repaired[0])!, clipAudioOf(library[0])!) <= 1 / 32768 + 1e-9,
      'Clip-Pegel nach Rundlauf verändert',
      String(maxAbsDifference(clipAudioOf(repaired[0])!, clipAudioOf(library[0])!))
    );
    // Wichtig: Die Normalisierung passiert beim Einfügen, nicht in der Bibliothek –
    // der gespeicherte Clip behält seinen Originalpegel.
    expect(
      Math.abs(pcmPeak(clipAudioOf(repaired[0])!) - barPeak(CUT_START_BAR + CUT_BARS - 1)) < 0.02,
      'Bibliotheks-Clip wurde destruktiv normalisiert',
      pcmPeak(clipAudioOf(repaired[0])!).toFixed(4)
    );
    return `${repaired.length} Clips, Abweichung ${(deviation * 32768).toFixed(3)}×1/32768, originalsModified=false`;
  }
);

// ── 11. Quelldatei unverändert ──────────────────────────────────────────────

step('Quelldatei unverändert (Read-Only-Zusage)', 'SHA-256 von quelle.wav vor und nach dem Durchlauf gleich', () => {
  const after = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
  expect(after === sourceDigest, 'Quelldatei wurde verändert', after.slice(0, 16));
  const decoded = decodeWav(fs.readFileSync(sourceFile)).pcm;
  // Die Datei liegt als 16-Bit-WAV vor, deshalb ist ein LSB Rundungsabstand erlaubt –
  // entscheidend ist, dass niemand die Datei angefasst hat (SHA-256 oben).
  expect(pcmSampleCount(decoded) === TOTAL_SAMPLES, 'Länge der Quelle gelesen', String(pcmSampleCount(decoded)));
  expect(decoded.channels.length === source.channels.length, 'Kanalzahl beim Lesen verändert', `${decoded.channels.length} vs ${source.channels.length}`);
  const deviation = maxAbsDifference(decoded, source);
  expect(deviation <= 1 / 32768 + 1e-9, 'Quellmaterial beim Lesen verändert', `${deviation.toFixed(6)} (1 LSB = ${(1 / 32768).toFixed(6)})`);
  return `sha256 ${after.slice(0, 16)}… unverändert (${(fs.statSync(sourceFile).size / 1024).toFixed(0)} kB)`;
});

// ── 12. Beweisdateien ──────────────────────────────────────────────────────

step('Beweisdateien: Endstand als WAV', 'eine WAV mit dem Ergebnis, alle Takte identifizierbar', () => {
  const file = path.join(ARTIFACT_DIR, 'endstand.wav');
  fs.writeFileSync(file, Buffer.from(encodeWav(track.audio)));
  const back = decodeWav(fs.readFileSync(file)).pcm;
  expect(pcmSampleCount(back) === pcmSampleCount(track.audio), 'Export-Länge falsch');
  expect(maxAbsDifference(back, track.audio) <= 1 / 32768 + 1e-9, 'Export verbügelt mehr als ein LSB');
  const bars = barsOf(back);
  expect(bars.every((bar) => bar !== null), 'Takte im Export nicht identifizierbar', fmtBars(bars));
  return `${path.basename(file)}: ${pcmSampleCount(back)} Samples, ${fmtBars(bars)}`;
});

// ── Auswertung ─────────────────────────────────────────────────────────────

fs.writeFileSync(
  path.join(ARTIFACT_DIR, 'NACHWEIS.md'),
  [
    '# Nachweis: realer Schneide-Workflow',
    '',
    'Durchlauf wie in der App: 8 Takte ausschneiden (vorher als Clip in die Bibliothek) →',
    'an einer beliebigen Stelle wieder einfügen (mit Pegelangleichung) → darüberlegen (mit',
    'Übersteuerungsschutz) → zwei Takte ersetzen → Bibliothek pflegen → die letzten beiden',
    'Takte nach vorne → Schritt zurück/wiederherstellen → Projekt speichern und öffnen →',
    'Quelldatei unverändert.',
    '',
    `Material: ${BARS} Takte @ ${BPM} BPM, ${SAMPLE_RATE} Hz, ein Takt = ${BAR_SECONDS} s = ${BAR_SAMPLES} Samples.`,
    '',
    '## Wie geprüft wird',
    '',
    'Jeder Takt trägt eine eigene Tonhöhe (' + barFreq(0) + ' + 100·k Hz) und einen eigenen Pegel',
    '(0,30 + 0,02·k) mit fallender Hüllkurve. Die Taktfolge wird deshalb **unabhängig** von der',
    'Schnitt-Logik bestimmt: Goertzel-Frequenzanalyse je Takt (der beste Treffer muss sich vom',
    'zweitbesten um Faktor 1,35 abheben) plus Hüllkurvenprüfung – ist der Taktanfang nicht lauter',
    'als sein Ende, gilt der Takt als nicht bestimmbar (das erkennt auch rückwärts gelesenes Material).',
    '',
    '## Schritte',
    '',
    '| # | Schritt | erwartet | tatsächlich | Prüfung |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.index} | ${r.name.replace(/\|/g, '/')} | ${r.expected.replace(/\|/g, '/')} | ${r.actual.replace(/\|/g, '/')} | ${
          r.passed ? '✓' : '✗ ' + (r.error ?? '').replace(/\|/g, '/')
        } |`
    ),
    '',
    `Pegelziele: Normalisierung auf ${CLIP_NORM_TARGET_PEAK.toFixed(3)} (${toDbfs(CLIP_NORM_TARGET_PEAK).toFixed(1)} dBFS), Obergrenze für jede Summe ${CLIP_HEADROOM_CEILING.toFixed(3)}.`,
    '',
    'Dateien: `quelle.wav` (unverändertes Material, 16-Bit), `endstand.wav` (Ergebnis des Durchlaufs).',
    'Erzeugt von `npx tsx tests/workflow-real.test.ts`.',
    '',
  ].join('\n'),
  'utf-8'
);

console.log('\n═══ Realer Schneide-Workflow: Nachweis ═══\n');
let failed = 0;
for (const r of results) {
  console.log(`${r.passed ? '✓' : '✗'} [Schritt ${r.index}] ${r.name} (${r.durationMs} ms)`);
  console.log(`      erwartet    : ${r.expected}`);
  console.log(`      tatsächlich : ${r.actual}`);
  if (!r.passed) {
    console.log(`      FEHLER      : ${r.error}`);
    failed++;
  }
}
console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Schritte: ${results.length} | bestanden: ${results.length - failed} | fehlgeschlagen: ${failed}`);
console.log(`Beweise: ${path.join(ARTIFACT_DIR, 'NACHWEIS.md')}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
process.exit(0);
