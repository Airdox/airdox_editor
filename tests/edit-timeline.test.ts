/**
 * @license
 * Edit projection tests (Phase 6: drag & drop edits and their follow-up states).
 *
 * P  – The projected timeline is the single source of truth: an untouched track
 *       stays identity, an insert MOVES material instead of overwriting it, a
 *       delete closes the gap, a replace pads short clips with silence, Clear
 *       mutes without changing length, and an Overdub never changes the layout.
 * R  – Follow-up state: cues, loops, phrases and beat nodes follow the shifted
 *       material, markers inside removed material are dropped (never left
 *       dangling on foreign audio), and only an explicitly flagged insert grid
 *       continues the beatgrid across inserted material.
 *
 * Run with: npx tsx tests/edit-timeline.test.ts
 */

import { DataOrigin, EditSegment, CuePoint, LoopPoint, PhraseSection, BeatNode } from '../src/types/rekordbox';
import {
  clipBufferTimeOf,
  extendGridAcrossGap,
  locateSpan,
  projectEditTimeline,
  retimeBeatNodes,
  retimeCues,
  retimeLoops,
  retimePhrases,
  retimeTime,
  sourceTrackTimeOf,
  spanAllowsVerbatimClipColumns,
} from '../src/edit/editTimeline';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({ suite, name, passed: false, error: err?.message || String(err), durationMs: 0 });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function near(actual: number, expected: number, message: string, tol = 1e-6) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`Assertion Failed: ${message} (got ${actual}, want ${expected})`);
  }
}

function seg(partial: Partial<EditSegment> & { id: string; type: EditSegment['type'] }): EditSegment {
  return {
    trackId: 'deck',
    sourceStart: 0,
    sourceEnd: 0,
    projectStart: 0,
    projectDuration: 0,
    gain: 1.0,
    ...partial,
  } as EditSegment;
}

const base = seg({
  id: 'seg-orig',
  type: 'ORIGINAL',
  sourceStart: 0,
  sourceEnd: 30,
  projectStart: 0,
  projectDuration: 30,
});

// ─── P: layout projection ───────────────────────────────────────────────────

runTest('projection', 'P1 unedited track projects to identity (single original span)', () => {
  const tl = projectEditTimeline({ segments: [base], sourceDuration: 30 });
  assert(tl.isIdentity, 'identity flag set');
  assert(tl.spans.length === 1, 'exactly one span');
  assert(tl.spans[0].kind === 'original', 'span is original material');
  near(tl.duration, 30, 'project duration equals source duration');
  assert(tl.structuralEdits === 0, 'no structural edits counted');
});

runTest('projection', 'P2 insert shifts the following material right (real insert, no overwrite)', () => {
  const tl = projectEditTimeline({
    segments: [
      base,
      seg({
        id: 'ins',
        type: 'INSERT',
        projectStart: 10,
        projectDuration: 4,
        clipId: 'c1',
        sourceTrackId: 'src',
        sourceClipStart: 2,
        tempoRatio: 1,
      }),
    ],
    sourceDuration: 30,
  });
  assert(!tl.isIdentity, 'edited project is not identity');
  assert(tl.spans.length === 3, `3 spans (got ${tl.spans.length})`);
  const [head, clip, tail] = tl.spans;
  near(head.projectStart, 0, 'head starts at 0');
  near(head.duration, 10, 'head keeps the material before the insert');
  assert(clip.kind === 'clip', 'middle span is clip material');
  near(clip.duration, 4, 'clip span is exactly as long as the clip');
  near(tail.projectStart, 14, 'tail moved right by the inserted length');
  near(tail.sourceStart, 10, 'tail still points at source second 10');
  near(tail.duration, 20, 'tail keeps its own length');
  near(tl.duration, 34, 'project grew by the clip length');
  assert(clip.sourceTrackId === 'src' && clip.sourceClipStart === 2, 'clip provenance survives the projection');
});

runTest('projection', 'P3 insert at position 0 and at the end stay gapless', () => {
  const atZero = projectEditTimeline({
    segments: [base, seg({ id: 'a', type: 'INSERT', projectStart: 0, projectDuration: 2 })],
    sourceDuration: 30,
  });
  near(atZero.spans[0].projectStart, 0, 'clip first');
  assert(atZero.spans[0].kind === 'clip', 'clip occupies the head');
  near(atZero.spans[1].sourceStart, 0, 'original starts after the clip');
  near(atZero.duration, 32, 'total length');

  const atEnd = projectEditTimeline({
    segments: [base, seg({ id: 'b', type: 'INSERT', projectStart: 30, projectDuration: 2 })],
    sourceDuration: 30,
  });
  near(atEnd.duration, 32, 'appended clip lengthens the project');
  assert(atEnd.spans[atEnd.spans.length - 1].kind === 'clip', 'clip is the last span');
});

runTest('projection', 'P4 replace keeps the window length and pads short clips with silence', () => {
  const tl = projectEditTimeline({
    segments: [
      base,
      seg({ id: 'r', type: 'REPLACE', projectStart: 8, projectDuration: 6, clipId: 'c2', sourceStart: 0, sourceEnd: 4 }),
    ],
    sourceDuration: 30,
  });
  near(tl.duration, 30, 'replacing a 6s window keeps the project length');
  const clip = tl.spans.find((s) => s.kind === 'clip');
  const pad = tl.spans.find((s) => s.kind === 'silence');
  assert(!!clip && !!pad, 'clip span plus explicit silence padding exist');
  near(clip!.duration, 4, 'clip material fills 4s');
  near(pad!.duration, 2, 'remaining 2s are explicit silence, not leftover audio');
  near(pad!.projectStart, clip!.projectStart + 4, 'padding directly follows the clip');
});

runTest('projection', 'P5 delete (CUT) removes the range and pulls everything left', () => {
  const tl = projectEditTimeline({
    segments: [base, seg({ id: 'd', type: 'CUT', projectStart: 5, projectDuration: 3 })],
    sourceDuration: 30,
  });
  near(tl.duration, 27, 'project shortened by the removed range');
  assert(tl.spans.length === 2, 'head and shifted tail');
  near(tl.spans[1].sourceStart, 8, 'tail resumes after the cut in the source');
  near(tl.spans[1].projectStart, 5, 'tail starts at the cut position');
  const located = locateSpan(tl, 5.5);
  assert(!!located && located.span.kind === 'original', 'position after the cut maps to original material');
});

runTest('projection', 'P6 clear mutes the window without changing the timeline length', () => {
  const tl = projectEditTimeline({
    segments: [base, seg({ id: 'c', type: 'CLEAR', projectStart: 4, projectDuration: 2 })],
    sourceDuration: 30,
  });
  near(tl.duration, 30, 'length untouched');
  const silence = tl.spans.filter((s) => s.kind === 'silence');
  assert(silence.length === 1, 'one silence span');
  near(silence[0].duration, 2, 'silence covers exactly the cleared window');
  assert(tl.structuralEdits === 1, 'clear counts as a structural (layout-visible) edit');
});

runTest('projection', 'P7 overdub overlays without touching the layout', () => {
  const tl = projectEditTimeline({
    segments: [base, seg({ id: 'o', type: 'OVERDUB', projectStart: 20, projectDuration: 5, clipId: 'c3' })],
    sourceDuration: 30,
  });
  assert(tl.spans.length === 1, 'layout unchanged');
  assert(!tl.isIdentity, 'a mix overlay is an edit, not the pristine state');
  assert(tl.overdubs.length === 1, 'exactly one overdub');
  near(tl.overdubs[0].projectStart, 20, 'overlay position kept');
  assert(tl.structuralEdits === 0, 'no length change claimed');
});

runTest('projection', 'P8 overdub beyond the project end is clamped, not dropped', () => {
  const tl = projectEditTimeline({
    segments: [base, seg({ id: 'o2', type: 'OVERDUB', projectStart: 28, projectDuration: 9, clipId: 'c3' })],
    sourceDuration: 30,
  });
  near(tl.overdubs[0].duration, 2, 'clamped to the remaining project length');
});

runTest('projection', 'P9 multiple edits apply in order and stay gapless', () => {
  const tl = projectEditTimeline({
    segments: [
      base,
      seg({ id: 'i1', type: 'INSERT', projectStart: 5, projectDuration: 2 }),
      // The second insert refers to the timeline AFTER the first one (project time 12).
      seg({ id: 'i2', type: 'INSERT', projectStart: 12, projectDuration: 3 }),
      seg({ id: 'd1', type: 'CUT', projectStart: 0, projectDuration: 1 }),
    ],
    sourceDuration: 30,
  });
  near(tl.duration, 30 + 2 + 3 - 1, 'total length = original + inserts - cuts');
  let cursor = 0;
  for (const s of tl.spans) {
    near(s.projectStart, cursor, `span starts gaplessly at ${cursor.toFixed(3)}`);
    cursor += s.duration;
  }
  near(cursor, tl.duration, 'spans cover the project exactly');
});

runTest('projection', 'P10 clip time mapping: buffer position vs source-track position', () => {
  const tl = projectEditTimeline({
    segments: [
      base,
      seg({
        id: 'i',
        type: 'INSERT',
        projectStart: 10,
        projectDuration: 4,
        sourceStart: 1,
        sourceTrackId: 's',
        sourceClipStart: 6,
        tempoRatio: 2,
      }),
    ],
    sourceDuration: 30,
  });
  const clip = tl.spans.find((s) => s.kind === 'clip')!;
  near(clipBufferTimeOf(clip, 1), 2, 'played clip buffer position');
  near(sourceTrackTimeOf(clip, 1), 6 + 2 * 2, 'stretched material covers 2× source seconds');
  assert(!spanAllowsVerbatimClipColumns(clip), 'a 2× time stretch may not reuse source columns');
});

runTest('projection', 'P11 verbatim clip reuse only for untouched timing, pitch and gain', () => {
  const mk = (over: Partial<EditSegment>) =>
    projectEditTimeline({
      segments: [
        base,
        seg({
          id: 'i',
          type: 'INSERT',
          projectStart: 10,
          projectDuration: 4,
          sourceTrackId: 's',
          sourceClipStart: 6,
          tempoRatio: 1,
          pitchShift: 0,
          gain: 1,
          ...over,
        }),
      ],
      sourceDuration: 30,
    }).spans.find((s) => s.kind === 'clip')!;
  assert(spanAllowsVerbatimClipColumns(mk({})), 'untouched clip material reuses stored columns');
  assert(!spanAllowsVerbatimClipColumns(mk({ pitchShift: 2 })), 'pitch shifted material must not reuse stored colors');
  assert(!spanAllowsVerbatimClipColumns(mk({ gain: 0.5 })), 'gained material must not reuse stored amplitudes');
  assert(!spanAllowsVerbatimClipColumns(mk({ sourceTrackId: undefined })), 'unknown origin must not reuse columns');
});

// ─── R: follow-up state of an edit ──────────────────────────────────────────

runTest('retime', 'R1 insert moves every marker at/after the insert position', () => {
  const edit = { mode: 'insert' as const, start: 10, end: 14, delta: 4 };
  near(retimeTime(9.5, edit)!, 9.5, 'before stays');
  near(retimeTime(10, edit)!, 14, 'at the insert point shifts');
  near(retimeTime(29, edit)!, 33, 'after shifts');
  const cues: CuePoint[] = [
    { id: 'a', name: 'A', type: 'MEMORY', position: 2, color: '#f00' },
    { id: 'b', name: 'B', type: 'MEMORY', position: 10, color: '#f00' },
    { id: 'c', name: 'C', type: 'HOT_CUE', position: 20, color: '#0f0' },
  ];
  const res = retimeCues(cues, edit);
  assert(res.dropped === 0 && res.moved === 2, 'two markers moved, none lost');
  near(res.cues[1].position, 14, 'cue at the insert point follows the material');
  assert(
    res.cues.every((c) => c.origin !== DataOrigin.USER_EDIT),
    'retiming never rewrites cue provenance'
  );
});

runTest('retime', 'R2 delete drops markers inside the hole and pulls the rest left', () => {
  const edit = { mode: 'remove' as const, start: 5, end: 8, delta: -3 };
  near(retimeTime(4.9, edit)!, 4.9, 'before stays');
  assert(retimeTime(6, edit) === null, 'inside removed material has no target');
  near(retimeTime(8, edit)!, 5, 'the cut end collapses onto the cut start');
  near(retimeTime(20, edit)!, 17, 'after shifts left');
  const cues: CuePoint[] = [
    { id: 'a', name: 'before', type: 'MEMORY', position: 1, color: '#f00' },
    { id: 'b', name: 'inside', type: 'MEMORY', position: 6, color: '#f00' },
    { id: 'c', name: 'after', type: 'MEMORY', position: 12, color: '#f00' },
  ];
  const res = retimeCues(cues, edit);
  assert(res.dropped === 1, 'the marker of deleted audio is dropped, not left dangling');
  assert(res.cues.length === 2, 'survivors remain');
  near(res.cues[1].position, 9, 'later marker follows the shifted material');
});

runTest('retime', 'R3 replace keeps positions, delete clamps loops to the new geometry', () => {
  const loops: LoopPoint[] = [
    { id: 'l1', name: 'L1', start: 4, end: 6, length: 2, color: '#0f0', origin: DataOrigin.REKORDBOX_ANLZ },
    { id: 'l2', name: 'L2', start: 5.5, end: 6, length: 0.5, color: '#0f0', origin: DataOrigin.REKORDBOX_ANLZ },
  ];
  const replaced = retimeLoops(loops, { mode: 'replace', start: 5, end: 9, delta: 0 });
  assert(replaced.loops.length === 2, 'positions untouched for a length-preserving edit');
  near(replaced.loops[0].length, 2, 'loop length preserved');
  assert(
    replaced.loops.every((l) => l.origin === DataOrigin.REKORDBOX_ANLZ),
    'imported loop provenance survives'
  );

  const cut = retimeLoops(loops, { mode: 'remove', start: 5.2, end: 5.8, delta: -0.6 });
  assert(cut.loops.length === 2, 'both loops survive a small cut');
  near(cut.loops[0].end, 5.4, 'loop crossing the cut is shortened to the new geometry');
  const dropped = retimeLoops(loops, { mode: 'remove', start: 4, end: 7, delta: -3 });
  assert(dropped.loops.length === 0 && dropped.dropped === 2, 'loops without length are removed');
});

runTest('retime', 'R4 phrases shift and only re-number bars for whole-bar deltas', () => {
  const phrases: PhraseSection[] = [
    { id: 'p1', name: 'UP', startBar: 5, endBar: 8, startTime: 10, endTime: 18, color: '#123456' },
    { id: 'p2', name: 'DOWN', startBar: 1, endBar: 4, startTime: 0, endTime: 8, color: '#654321' },
  ];
  const barSeconds = 2.0;

  // Bar-exact insert of 4s after 20s: both phrases start before it → times and
  // bars stay as imported.
  const afterEnd = retimePhrases(phrases, { mode: 'insert', start: 20, end: 24, delta: 4 }, barSeconds);
  near(afterEnd.phrases[0].endTime, 18, 'phrase before the insert is untouched');
  assert(afterEnd.barShifted === 0, 'phrases before the edit point are never re-numbered');

  // Bar-exact insert inside the first phrase: times shift, bars shift by 2.
  const inside = retimePhrases(phrases, { mode: 'insert', start: 12, end: 16, delta: 4 }, barSeconds);
  near(inside.phrases[0].endTime, 22, 'phrase end follows the shifted tail');
  assert(inside.barShifted === 0, 'a phrase starting before the insert keeps its start bar');

  // Bar-exact remove of 4s at 12s: the phrase start is before → bars untouched.
  const removed = retimePhrases(phrases, { mode: 'remove', start: 12, end: 16, delta: -4 }, barSeconds);
  near(removed.phrases[0].endTime, 14, 'removed length is subtracted from the phrase end');

  // Non bar-exact delta: times follow, bars are NOT silently requantized.
  const odd = retimePhrases(phrases, { mode: 'insert', start: 4, end: 6.5, delta: 2.5 }, barSeconds);
  assert(odd.barShifted === 0, 'a non-bar-exact delta never fakes a bar re-numbering');
  near(odd.phrases[0].startTime, 12.5, 'times still follow the shift');
});

runTest('retime', 'R5 beat nodes follow the edit; the hole is filled only with flagged beats', () => {
  const beats: BeatNode[] = Array.from({ length: 10 }, (_, i) => ({
    index: i,
    time: i * 0.5,
    isBarStart: i % 4 === 0,
    barNumber: Math.floor(i / 4) + 1,
    beatInBar: (i % 4) + 1,
  }));
  const edit = { mode: 'insert' as const, start: 2.0, end: 4.0, delta: 2.0 };
  const res = retimeBeatNodes(beats, edit);
  assert(res.dropped === 0, 'insert never destroys beats');
  near(res.beats[4].time, 4.0, 'first beat at/after the insert moved by the delta');
  near(res.beats[3].time, 1.5, 'beats before the insert stay exactly as imported');
  assert(
    res.beats.every((b, i) => b.index === i),
    'nodes are re-indexed after re-timing'
  );

  const gap = extendGridAcrossGap(res.beats, 2.0, 4.0, 120, 4, 0);
  assert(gap.generated === 4, `4 inserted beats (got ${gap.generated})`);
  const inserted = gap.beats.filter((b) => b.insertGrid);
  assert(inserted.length === 4, 'the filler beats are flagged as an edit consequence');
  assert(
    inserted.every((b) => b.time >= 2.0 - 1e-9 && b.time < 4.0),
    'fillers stay inside the inserted window'
  );
  near(inserted[0].time, 2.0, 'grid continues from the last real beat');
  assert(inserted[0].isBarStart && inserted[0].barNumber === 2, 'the downbeat numbering continues correctly');
  const realNodes = gap.beats.filter((b) => !b.insertGrid);
  assert(realNodes.length === beats.length, 'imported node count is preserved exactly');
  assert(
    realNodes.every((b) => res.beats.some((r) => r.time === b.time && r.isBarStart === b.isBarStart)),
    'imported intervals and bar flags survive verbatim'
  );

  const cut = retimeBeatNodes(beats, { mode: 'remove', start: 1.0, end: 2.0, delta: -1.0 });
  assert(cut.dropped === 1, `beat inside the hole dropped (got ${cut.dropped})`);
  assert(
    cut.beats.every((b) => b.time >= 0),
    'no negative beat times'
  );
});

runTest('retime', 'R6 locateSpan resolves project time to the owning material', () => {
  const tl = projectEditTimeline({
    segments: [
      base,
      seg({ id: 'i', type: 'INSERT', projectStart: 10, projectDuration: 4, sourceTrackId: 's', sourceClipStart: 6 }),
    ],
    sourceDuration: 30,
  });
  const before = locateSpan(tl, 5)!;
  assert(before.span.kind === 'original', 'before the insert is original material');
  near(before.span.sourceStart + before.offset, 5, 'source position of the head');
  const inside = locateSpan(tl, 11)!;
  assert(inside.span.kind === 'clip' && Math.abs(inside.offset - 1) < 1e-9, 'inside → clip, 1s in');
  near(sourceTrackTimeOf(inside.span, inside.offset), 7, 'source-track second resolves for the column copy');
  const after = locateSpan(tl, 20)!;
  assert(after.span.kind === 'original', 'after the insert is original material');
  near(after.span.sourceStart + after.offset, 16, 'tail source position accounts for the shift');
  assert(locateSpan(tl, 999) === null, 'outside the project resolves to nothing');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;
results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`${status}[${icon}]${RESET} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});
console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');
if (failedCount > 0) process.exit(1);
