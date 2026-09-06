/**
 * Regression tests for beat grid drift.
 *
 * Symptom this guards against: waveform, beat grid and cues line up at the
 * start of an imported track but progressively lose sync towards the end.
 * Cause: a variable Rekordbox grid (many <TEMPO> markers / measured ANLZ
 * beats) was collapsed into a single constant BPM and extrapolated.
 */

import { parseRekordboxXml, buildBeatGridFromTempoMarkers } from '../src/rekordbox/xmlParser';
import {
  timeToBeatPosition,
  beatPositionToTime,
  snapTimeToBeat,
  barAndBeatAt,
  beatsInRange,
  extendBeatGrid,
  beatGridFromTimes,
  hasMeasuredBeats,
} from '../src/rekordbox/beatGridUtils';
import { BeatGrid, DataOrigin } from '../src/types/rekordbox';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

console.log('Testing beat grid drift handling...');

// ---------------------------------------------------------------------------
// 1. Multiple <TEMPO> markers must all be honoured
// ---------------------------------------------------------------------------
{
  // A track recorded by a human band: starts at 120 BPM, drifts to 121 then
  // 122. Rekordbox stores one TEMPO marker per detected tempo region.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Live Take" Artist="Band" TotalTime="300"
           AverageBpm="120.00" Tonality="8A" Location="file://localhost/tmp/a.wav">
      <TEMPO Inizio="0.000" Bpm="120.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.000" Bpm="121.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="180.000" Bpm="122.00" Metro="4/4" Battito="1"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

  const { tracks } = parseRekordboxXml(xml);
  assert(tracks.length === 1, 'one track expected');
  const grid = tracks[0].beatGrid as BeatGrid;

  assert(hasMeasuredBeats(grid), 'grid must carry measured beats');

  // Every tempo marker must land exactly on a beat, otherwise the grid has
  // drifted away from what Rekordbox recorded.
  for (const anchor of [60.0, 180.0]) {
    const nearest = grid.beats.reduce((best, b) =>
      Math.abs(b.time - anchor) < Math.abs(best.time - anchor) ? b : best
    );
    assert(
      approx(nearest.time, anchor, 0.002),
      `tempo marker at ${anchor}s should coincide with a beat, closest was ${nearest.time}`
    );
  }

  // The naive constant-BPM model is measurably wrong late in the track.
  const spbConstant = 60 / 120;
  const lastBeat = grid.beats[grid.beats.length - 1];
  const naiveTime = grid.firstBeat + lastBeat.index * spbConstant;
  const drift = Math.abs(naiveTime - lastBeat.time);
  assert(
    drift > 1.0,
    `constant-BPM extrapolation should be off by more than a second, was ${drift.toFixed(3)}s`
  );
  console.log(`  constant-BPM model would be ${drift.toFixed(2)}s off at the end of the track`);
}

// ---------------------------------------------------------------------------
// 2. A single <TEMPO> marker still yields a clean constant grid
// ---------------------------------------------------------------------------
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="2" Name="Studio" Artist="X" TotalTime="120"
           AverageBpm="128.00" Location="file://localhost/tmp/b.wav">
      <TEMPO Inizio="0.500" Bpm="128.00" Metro="4/4" Battito="1"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

  const grid = parseRekordboxXml(xml).tracks[0].beatGrid as BeatGrid;
  assert(approx(grid.firstBeat, 0.5, 1e-6), `firstBeat 0.5 expected, got ${grid.firstBeat}`);
  assert(approx(grid.bpm, 128, 1e-6), 'bpm 128 expected');

  const spb = 60 / 128;
  const b10 = grid.beats[10];
  assert(approx(b10.time, 0.5 + 10 * spb, 1e-6), 'constant grid must stay exact');
}

// ---------------------------------------------------------------------------
// 3. Battito > 1 shifts the downbeat backwards, not forwards
// ---------------------------------------------------------------------------
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="3" Name="Offbeat" Artist="X" TotalTime="60"
           AverageBpm="120.00" Location="file://localhost/tmp/c.wav">
      <TEMPO Inizio="2.000" Bpm="120.00" Metro="4/4" Battito="3"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

  const grid = parseRekordboxXml(xml).tracks[0].beatGrid as BeatGrid;
  // Beat 3 sits at 2.0s, so beat 1 of that bar sits at 2.0 - 2*0.5 = 1.0s
  assert(approx(grid.firstBeat, 1.0, 1e-6), `firstBeat 1.0 expected, got ${grid.firstBeat}`);
  assert(grid.beats[0].beatInBar === 1, 'grid should start on a downbeat');
}

// ---------------------------------------------------------------------------
// 4. buildBeatGridFromTempoMarkers: bar numbering stays continuous
// ---------------------------------------------------------------------------
{
  const grid = buildBeatGridFromTempoMarkers(
    [
      { inizio: 0, bpm: 100, battito: 1 },
      { inizio: 12, bpm: 150, battito: 1 },
    ],
    24,
    4,
    DataOrigin.REKORDBOX_XML
  );

  // 100 BPM for 12s = 20 beats, then 150 BPM for 12s = 30 beats
  assert(grid.beats.length >= 48, `expected ~50 beats, got ${grid.beats.length}`);

  for (let i = 1; i < grid.beats.length; i++) {
    assert(
      grid.beats[i].time > grid.beats[i - 1].time,
      `beat times must increase monotonically (index ${i})`
    );
    const expectedBeatInBar = ((grid.beats[i - 1].beatInBar % 4) + 1);
    assert(
      grid.beats[i].beatInBar === expectedBeatInBar,
      `beatInBar must cycle 1..4 without gaps at index ${i}`
    );
  }

  // Tempo change is respected: spacing before/after 12s differs.
  const before = grid.beats.filter((b) => b.time < 11.9);
  const after = grid.beats.filter((b) => b.time > 12.1);
  const spbBefore = before[5].time - before[4].time;
  const spbAfter = after[5].time - after[4].time;
  assert(approx(spbBefore, 0.6, 1e-6), `100 BPM => 0.6 s/beat, got ${spbBefore}`);
  assert(approx(spbAfter, 0.4, 1e-6), `150 BPM => 0.4 s/beat, got ${spbAfter}`);
}

// ---------------------------------------------------------------------------
// 5. timeToBeatPosition / beatPositionToTime are inverse on a drifting grid
// ---------------------------------------------------------------------------
{
  const grid = beatGridFromTimes(
    [0, 500, 1010, 1530, 2060, 2600, 3150, 3710],
    4,
    115,
    DataOrigin.REKORDBOX_ANLZ
  );

  for (const t of [0.25, 1.2, 2.4, 3.0, 3.6]) {
    const pos = timeToBeatPosition(grid, t);
    const back = beatPositionToTime(grid, pos);
    assert(approx(back, t, 1e-9), `round trip failed for ${t}s (got ${back})`);
  }

  // Snapping picks the genuinely nearest measured beat.
  assert(approx(snapTimeToBeat(grid, 1.45), 1.53, 1e-9), 'snap should pick 1.53s');
  assert(approx(snapTimeToBeat(grid, 1.2), 1.01, 1e-9), 'snap should pick 1.01s');

  // Bar/beat labels come from the measured nodes.
  const m = barAndBeatAt(grid, 2.06);
  assert(m.bar === 2 && m.beat === 1, `expected bar 2 beat 1, got ${m.bar}/${m.beat}`);
}

// ---------------------------------------------------------------------------
// 6. beatsInRange only returns beats inside the window
// ---------------------------------------------------------------------------
{
  const grid = beatGridFromTimes([0, 500, 1000, 1500, 2000, 2500], 4, 120, DataOrigin.REKORDBOX_ANLZ);
  const visible = beatsInRange(grid, 0.9, 2.1);
  assert(visible.length === 3, `expected 3 beats in [0.9, 2.1], got ${visible.length}`);
  assert(visible.every((b) => b.time >= 0.9 && b.time <= 2.1), 'all beats must be inside window');
}

// ---------------------------------------------------------------------------
// 7. extendBeatGrid keeps measured beats and continues at the local tempo
// ---------------------------------------------------------------------------
{
  const grid = beatGridFromTimes([0, 500, 1000, 1500], 4, 120, DataOrigin.REKORDBOX_ANLZ);
  const extended = extendBeatGrid(grid, 5);

  assert(extended.beats.length > grid.beats.length, 'grid should have been extended');
  for (let i = 0; i < grid.beats.length; i++) {
    assert(
      extended.beats[i].time === grid.beats[i].time,
      `measured beat ${i} must not be modified`
    );
  }
  const last = extended.beats[extended.beats.length - 1];
  assert(last.time <= 5 + 1e-9, 'extension must not run past the duration');

  // Continues at 0.5 s/beat.
  const b4 = extended.beats[4];
  assert(approx(b4.time, 2.0, 1e-9), `expected 2.0s, got ${b4.time}`);

  // Extending an already long enough grid is a no-op.
  assert(extendBeatGrid(grid, 1.0) === grid, 'no extension needed => same object');
}

// ---------------------------------------------------------------------------
// 8. Fallback path: no measured beats => constant tempo maths still works
// ---------------------------------------------------------------------------
{
  const grid: BeatGrid = {
    firstBeat: 0.25,
    bpm: 120,
    meter: 4,
    beats: [],
    origin: DataOrigin.REKORDBOX_XML,
  };

  assert(!hasMeasuredBeats(grid), 'grid has no measured beats');
  assert(approx(timeToBeatPosition(grid, 2.25), 4, 1e-9), 'constant fallback position');
  assert(approx(beatPositionToTime(grid, 4), 2.25, 1e-9), 'constant fallback time');
  assert(approx(snapTimeToBeat(grid, 2.3), 2.25, 1e-9), 'constant fallback snap');

  const visible = beatsInRange(grid, 0, 1.3);
  assert(visible.length === 3, `expected beats at 0.25/0.75/1.25, got ${visible.length}`);
}

console.log('✓ beat grid drift tests passed');
