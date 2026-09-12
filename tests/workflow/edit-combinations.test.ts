/**
 * @license
 * Workflow scenario matrix over the edit engine (vitest so it is counted in the
 * coverage report; the `tests/edit-*.test.ts` suites keep guarding the same
 * contract as plain scripts).
 *
 * Combinations are enumerated, not picked: every edit operation × every drop
 * position class × three tempos × marker layouts. For each combination the same
 * five invariants have to hold, and they are the ones the user sees:
 *
 *   I1  timeline length   — the arithmetic of the operation is what happened
 *   I2  gapless layout    — spans tile [0, duration] without holes or overlaps
 *   I3  provenance        — no column is invented; ANLZ-only edits stay ANLZ
 *   I4  marker follow-up  — cues/loops move exactly like the material around them
 *   I5  idempotence       — projecting the same edit list twice changes nothing
 *
 * A combination whose expected result does not occur is collected and reported.
 * `KNOWN_DEVIATIONS` is the documented list: an expectation that fails outside
 * it makes this suite red, so a regression cannot hide as "a known issue".
 */
import { describe, it, expect } from 'vitest';
import { planClipDrop } from '../../src/edit/editDrop';
import { projectEditTimeline, retimeCues, retimeLoops } from '../../src/edit/editTimeline';
import { projectTrackEdits, waveformOriginAfterEdit } from '../../src/edit/editModel';
import { ColumnSource } from '../../src/edit/editWaveform';
import { DataOrigin } from '../../src/types/rekordbox';
import type { EditSegment, PaletteClip, TrackModel, WaveformAnalysisData } from '../../src/types/rekordbox';

const SR = 1000;
const COLUMNS = 100;
const SECONDS = 10;
const BUCKET = SECONDS / COLUMNS;

function variant(multiplier: number, tag: string): WaveformAnalysisData {
  const peaks = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) peaks[i] = multiplier * (i + 1);
  return {
    length: COLUMNS,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy: peaks,
    midEnergy: peaks,
    highEnergy: peaks,
    origin: DataOrigin.REKORDBOX_ANLZ,
    secPerBucket: BUCKET,
    sourceTag: tag,
  };
}

function baseSegment(overrides: Partial<EditSegment> = {}): EditSegment {
  return {
    id: 'base',
    type: 'ORIGINAL',
    trackId: 'deck',
    sourceStart: 0,
    sourceEnd: SECONDS,
    projectStart: 0,
    projectDuration: SECONDS,
    gain: 1,
    ...overrides,
  } as EditSegment;
}

function makeTrack(segments: EditSegment[], bpm: number, withCues = true): TrackModel {
  const analysis = variant(1, 'ANLZ0000');
  const cues = withCues
    ? [
        { id: 'c0', name: 'IN', type: 'MEMORY' as const, position: 0, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
        { id: 'c1', name: 'DROP', type: 'MEMORY' as const, position: 5, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
        { id: 'c2', name: 'OUT', type: 'MEMORY' as const, position: 9, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
      ]
    : [];
  const loops = withCues
    ? [{ id: 'l1', name: 'LOOP', start: 4, end: 6, length: 2, color: '#ff0', origin: DataOrigin.REKORDBOX_XML }]
    : [];
  return {
    id: 'deck',
    title: 'Scenario Track',
    artist: 'KA',
    album: 'AL',
    bpm,
    key: '2A',
    duration: SECONDS,
    sampleRate: SR,
    channels: 2,
    cues,
    loops,
    phrases: [],
    analysis,
    analysisVariants: [analysis],
    baseAnalysis: analysis,
    baseAnalysisVariants: [analysis],
    beatGrid: { firstBeat: 0, bpm, meter: 4, beats: [], origin: DataOrigin.REKORDBOX_XML },
    origin: DataOrigin.REKORDBOX_ANLZ,
    workingSegments: segments,
    originalSha256: 'sha',
  } as unknown as TrackModel;
}

const clip = (duration: number, sourceStart: number, id = 'c-1'): PaletteClip =>
  ({
    id,
    name: `Clip ${id}`,
    sourceTrackId: 'deck',
    sourceTrackName: 'Scenario Track',
    sourceStart,
    sourceEnd: sourceStart + duration,
    duration,
    beats: Math.round(duration / (60 / 120)),
    bars: duration / ((60 / 120) * 4),
    bpm: 120,
    key: '2A',
    color: '#00a2ff',
    origin: DataOrigin.PROJECT,
  }) as unknown as PaletteClip;

type Op = 'insert' | 'replace' | 'overdub' | 'clear' | 'delete';
const OPS: Op[] = ['insert', 'replace', 'overdub', 'clear', 'delete'];
const BMPS = [120, 130, 174];
const POSITION_CLASSES = [
  { name: 'start', at: 0 },
  { name: 'middle', at: 4 },
  { name: 'near-end', at: 8 },
  { name: 'past-end (clamps)', at: 12 },
];
const CLIP_LENGTHS = [2, 4];

/** Builds the edit list one operation produces at `at` with a `len`-second clip. */
function segmentsFor(op: Op, at: number, len: number): EditSegment[] {
  const base = baseSegment();
  const position = Math.min(Math.max(at, 0), SECONDS);
  if (op === 'insert') {
    const plan = planClipDrop({ mode: 'insert', clipDuration: len, timelineDuration: SECONDS, dropTime: at });
    return [
      base,
      {
        id: 'edit',
        type: 'INSERT',
        trackId: 'deck',
        clipId: 'c-1',
        sourceTrackId: 'deck',
        sourceStart: plan.window.start,
        sourceEnd: plan.window.start + len,
        sourceClipStart: 0,
        projectStart: plan.projectStart,
        projectDuration: plan.projectDuration,
        gain: 1,
        tempoRatio: 1,
        pitchShift: 0,
      } as unknown as EditSegment,
    ];
  }
  if (op === 'replace' || op === 'overdub') {
    const plan = planClipDrop({
      mode: op,
      clipDuration: len,
      timelineDuration: SECONDS,
      dropTime: at,
      windowEnd: position + len,
    });
    const windowLen = plan.projectDuration;
    return [
      base,
      {
        id: 'edit',
        type: op === 'replace' ? 'REPLACE' : 'OVERDUB',
        trackId: 'deck',
        clipId: 'c-1',
        sourceTrackId: 'deck',
        sourceStart: 0,
        sourceEnd: windowLen,
        sourceClipStart: 0,
        projectStart: plan.projectStart,
        projectDuration: windowLen,
        gain: op === 'overdub' ? 0.5 : 1,
        tempoRatio: 1,
        pitchShift: 0,
      } as unknown as EditSegment,
    ];
  }
  if (op === 'clear') {
    // The UI can only select inside the project, so the window is clamped here too.
    const windowLen = Math.min(len, SECONDS - position);
    return [
      base,
      {
        id: 'edit',
        type: 'CLEAR',
        trackId: 'deck',
        sourceStart: position,
        sourceEnd: position + windowLen,
        projectStart: position,
        projectDuration: windowLen,
        gain: 0,
      } as unknown as EditSegment,
    ];
  }
  return [
    base,
    {
      id: 'edit',
      type: 'CUT',
      trackId: 'deck',
      sourceStart: position,
      sourceEnd: Math.min(SECONDS, position + len),
      projectStart: position,
      projectDuration: Math.min(SECONDS, position + len) - position,
      gain: 1,
    } as unknown as EditSegment,
  ];
}

/** Expected timeline length after the operation (the arithmetic the user sees). */
function expectedDuration(op: Op, at: number, len: number): number {
  const position = Math.min(Math.max(at, 0), SECONDS);
  switch (op) {
    case 'insert':
      return SECONDS + len;
    case 'clear':
      // A clear only silences — even at the very end, where nothing is left to silence.
      return SECONDS;
    case 'delete':
      return SECONDS - Math.min(SECONDS, position + len) + position;
    default:
      return SECONDS;
  }
}

/** Every span pair must be gapless and ordered — the waveform cannot show holes. */
function layoutIsGapless(spans: Array<{ projectStart: number; duration: number }>, total: number): string | null {
  let cursor = 0;
  for (const span of spans) {
    if (span.projectStart > cursor + 1e-6) return `Lücke vor ${span.projectStart.toFixed(3)}`;
    if (span.projectStart < cursor - 1e-6) return `Überlappung bei ${span.projectStart.toFixed(3)}`;
    cursor = span.projectStart + span.duration;
  }
  return Math.abs(cursor - total) < 1e-6 ? null : `Ende bei ${cursor.toFixed(3)} ≠ ${total.toFixed(3)}`;
}

interface Deviation {
  key: string;
  expected: string;
  actual: string;
}

/**
 * Deviations that the product currently shows and that are documented in
 * VORHABEN.md ("Abweichungen"). Anything new here has to be fixed, not listed.
 */
const KNOWN_DEVIATIONS: Array<{ match: string; why: string }> = [];

function deviationKey(op: Op, pos: string): string {
  return `${op}@${pos}`;
}

const deviations: Deviation[] = [];

describe('Workflow-Matrix — Edit-Operationen × Position × Tempo', () => {
  for (const op of OPS) {
    describe(`Operation: ${op}`, () => {
      for (const bpm of BMPS) {
        for (const pos of POSITION_CLASSES) {
          it(`I1/I2 ${op} @${pos.name} bei ${bpm} BPM: Länge und lückenloses Layout`, () => {
            for (const len of CLIP_LENGTHS) {
              const segments = segmentsFor(op, pos.at, len);
              const projection = projectEditTimeline(
                { segments, sourceDuration: SECONDS },
                (seg) => ({ playDuration: (seg as { projectDuration?: number }).projectDuration ?? 0 })
              );
              const want = expectedDuration(op, pos.at, len);
              const got = projection.duration;
              if (Math.abs(want - got) > 1e-6) {
                deviations.push({
                  key: `${deviationKey(op, pos.name)} len=${len}`,
                  expected: `duration ${want}`,
                  actual: `duration ${got}`,
                });
              }
              expect(Math.abs(got - want)).toBeLessThan(1e-6);
              const gap = layoutIsGapless(
                projection.spans.map((s) => ({ projectStart: s.projectStart, duration: s.duration })),
                projection.duration
              );
              expect(gap, `Layout: ${gap ?? 'ok'}`).toBeNull();
            }
          });
        }
      }

      it(`I3 ${op}: Marker folgen der Timeline exakt`, () => {
        for (const len of CLIP_LENGTHS) {
          const position = Math.min(Math.max(4, 0), SECONDS);
          const segments = segmentsFor(op, 4, len);
          const projection = projectEditTimeline({ segments, sourceDuration: SECONDS });
          const delta = projection.duration - SECONDS;
          const cues = [
            { id: 'c0', name: 'IN', type: 'MEMORY' as const, position: 0, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
            { id: 'c1', name: 'DROP', type: 'MEMORY' as const, position: 5, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
            { id: 'c2', name: 'OUT', type: 'MEMORY' as const, position: 9, color: '#f00', origin: DataOrigin.REKORDBOX_XML },
          ];
          const mode = op === 'insert' ? 'insert' : op === 'delete' ? 'remove' : 'replace';
          const moved = retimeCues(cues, { mode, start: position, end: position + len, delta });
          // Nothing may sit beyond the new project end.
          for (const cue of moved.cues) {
            expect(cue.position).toBeLessThanOrEqual(projection.duration + 1e-6);
          }
          if (op === 'insert') {
            // Everything behind the insert shifts by exactly the clip length.
            expect(moved.cues.length).toBe(3);
            expect(moved.cues[2].position).toBeCloseTo(9 + len, 6);
          }
          if (op === 'delete') {
            // A cue inside the removed range must not survive as a lie.
            expect(moved.cues.length).toBeLessThanOrEqual(3);
            expect(moved.dropped + moved.cues.length).toBe(3);
          }
          const loops = retimeLoops(
            [{ id: 'l1', name: 'LOOP', start: 4, end: 6, length: 2, color: '#ff0', origin: DataOrigin.REKORDBOX_XML }],
            { mode, start: position, end: position + len, delta }
          );
          for (const loop of loops.loops) {
            expect(loop.end).toBeGreaterThan(loop.start);
            expect(loop.end).toBeLessThanOrEqual(projection.duration + 1e-6);
          }
        }
      });

      it(`I4 ${op}: Wellenform-Herkunft bleibt nachvollziehbar (keine Neuanalyse)`, () => {
        for (const bpm of BMPS) {
          const track = makeTrack(segmentsFor(op, 4, 2), bpm);
          const projection = projectTrackEdits(track, [clip(2, 4)], [track]);
          const stats = projection.stats;
          expect(stats, 'Statistik fehlt').toBeTruthy();
          const label = waveformOriginAfterEdit(projection);
          expect(typeof label).toBe('string');
          // No operation in this matrix stretches or pitch-shifts material, so no
          // column may be recomputed from audio: the ANLZ columns are carried over,
          // moved, mixed or silenced — that is the "aufgerechnete statt neu
          // analysierte" promise of the edit waveform.
          expect(stats!.computedColumns, `computedColumns bei ${op}`).toBe(0);
          const stored = stats!.verbatimColumns + stats!.retimedColumns + stats!.clipColumns;
          if (op === 'clear') {
            expect(stats!.silenceColumns).toBeGreaterThan(0);
          } else if (op !== 'delete') {
            expect(stored, 'editiertes Material hat gespeicherte Spalten').toBeGreaterThan(0);
          }
        }
      });

      it(`I5 ${op}: zweites Projektieren ist unverändert (kein Drift)`, () => {
        const track = makeTrack(segmentsFor(op, 4, 2), 130);
        const first = projectTrackEdits(track, [clip(2, 4)], [track]);
        const second = projectTrackEdits(track, [clip(2, 4)], [track]);
        expect(second.timeline.duration).toBe(first.timeline.duration);
        expect(second.timeline.spans.length).toBe(first.timeline.spans.length);
        expect(second.variants.length).toBe(first.variants.length);
        const peaks = (a: WaveformAnalysisData, b: WaveformAnalysisData) =>
          a.peaks.every((v, i) => Math.abs(v - b.peaks[i]) < 1e-9);
        expect(peaks(first.variants[0], second.variants[0])).toBe(true);
      });
    });
  }

  it('Kombinations-Invariante: identischer Zustand ohne Edit (Identität)', () => {
    for (const bpm of BMPS) {
      const track = makeTrack([baseSegment()], bpm);
      const projection = projectTrackEdits(track, [], [track]);
      expect(projection.identity).toBe(true);
      expect(projection.timeline.duration).toBeCloseTo(SECONDS, 6);
      expect(projection.timeline.structuralEdits).toBe(0);
    }
  });

  it('Dokumentation: nur bekannte Abweichungen treten auf', () => {
    const unknown = deviations.filter(
      (d) => !KNOWN_DEVIATIONS.some((k) => d.key.startsWith(k.match))
    );
    // The full list is asserted, so a *new* deviation is a red test, not a note.
    expect(unknown).toEqual([]);
    expect(deviations.length).toBeGreaterThanOrEqual(0);
  });

  it('Boundary-Fall: Drop außerhalb des Timeline-Bereichs wird geclamped, nicht ignoriert', () => {
    const plan = planClipDrop({ mode: 'insert', clipDuration: 2, timelineDuration: SECONDS, dropTime: -5 });
    expect(plan.projectStart).toBe(0);
    expect(plan.clamped).toBe(true);
    const planEnd = planClipDrop({ mode: 'insert', clipDuration: 2, timelineDuration: SECONDS, dropTime: 999 });
    expect(planEnd.projectStart).toBe(SECONDS);
    expect(planEnd.clamped).toBe(true);
    const replacePastEnd = planClipDrop({
      mode: 'replace',
      clipDuration: 8,
      timelineDuration: SECONDS,
      dropTime: 9,
      windowEnd: 17,
    });
    expect(replacePastEnd.projectStart + replacePastEnd.projectDuration).toBeLessThanOrEqual(SECONDS + 1e-6);
    expect(replacePastEnd.truncated).toBe(true);
  });

  it('Boundary-Fall: CLEAR über das Timeline-Ende hinaus streckt mit Stille, schneidet nichts ab', () => {
    // Reachable only through a hand-built edit list (the UI clamps selections);
    // the engine keeps the documented CLEAR promise: material is muted, never removed.
    const segments = [
      baseSegment(),
      {
        id: 'wide',
        type: 'CLEAR',
        trackId: 'deck',
        sourceStart: 8,
        sourceEnd: 12,
        projectStart: 8,
        projectDuration: 4,
        gain: 0,
      } as unknown as EditSegment,
    ];
    const projection = projectEditTimeline({ segments, sourceDuration: SECONDS });
    expect(projection.duration).toBeCloseTo(12, 6);
    expect(projection.spans.at(-1)!.kind).toBe('silence');
  });

  it('Boundary-Fall: Fenster-Drop am / über dem Ende verkürzt die Timeline nicht', () => {
    for (const mode of ['replace', 'overdub'] as const) {
      const plan = planClipDrop({
        mode,
        clipDuration: 8,
        timelineDuration: SECONDS,
        dropTime: 12,
        windowEnd: 20,
      });
      expect(plan.projectStart + plan.projectDuration).toBeLessThanOrEqual(SECONDS + 1e-9);
      expect(plan.clamped).toBe(true);
      const segments = [
        baseSegment(),
        {
          id: 'edit',
          type: mode === 'replace' ? 'REPLACE' : 'OVERDUB',
          trackId: 'deck',
          clipId: 'c-1',
          sourceTrackId: 'deck',
          sourceStart: 0,
          sourceEnd: plan.projectDuration,
          sourceClipStart: 0,
          projectStart: plan.projectStart,
          projectDuration: plan.projectDuration,
          gain: 1,
          tempoRatio: 1,
          pitchShift: 0,
        } as unknown as EditSegment,
      ];
      const projection = projectEditTimeline({ segments, sourceDuration: SECONDS });
      expect(projection.duration, `${mode} darf die Länge nicht verändern`).toBeCloseTo(SECONDS, 6);
    }
  });

  it('Boundary-Fall: leerer Clip und leeres Material erzeugen kein Phantom-Segment', () => {
    const plan = planClipDrop({ mode: 'insert', clipDuration: 0, timelineDuration: SECONDS, dropTime: 4 });
    expect(plan.projectDuration).toBe(0);
    expect(plan.note).toContain('kein Audiomaterial');
    const track = makeTrack(
      [
        baseSegment(),
        {
          id: 'empty',
          type: 'INSERT',
          trackId: 'deck',
          clipId: 'zero',
          sourceTrackId: 'deck',
          sourceStart: 4,
          sourceEnd: 4,
          projectStart: 4,
          projectDuration: 0,
          gain: 1,
        } as unknown as EditSegment,
      ],
      130
    );
    const projection = projectTrackEdits(track, [clip(0, 4, 'zero')], [track]);
    expect(projection.timeline.duration).toBeCloseTo(SECONDS, 6);
  });
});
