import {
  clamp,
  segmentToSampleRange,
  applyGain,
  applyLowpass,
  applyEcho,
  applyEffectSegment,
  applyEffectTracks,
} from '../src/audio/effectEngine';
import { EffectSegment, EffectTrack } from '../src/types/rekordbox';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) <= eps;
}

function ones(n: number): Float32Array {
  return new Float32Array(n).fill(1);
}

const SR = 1000;

console.log('Testing effectEngine...');

// 1. clamp
assert(clamp(5, 0, 1) === 1, 'clamp upper bound');
assert(clamp(-5, 0, 1) === 0, 'clamp lower bound');
assert(clamp(0.5, 0, 1) === 0.5, 'clamp passthrough');
assert(clamp(NaN, 2, 3) === 2, 'clamp NaN falls back to min');

// 2. segmentToSampleRange
const seg = (over: Partial<EffectSegment> = {}): EffectSegment => ({
  id: 's1',
  type: 'GAIN',
  startTime: 0.1,
  endTime: 0.3,
  params: {},
  ...over,
});

const range = segmentToSampleRange(seg(), SR, 1000);
assert(range !== null && range.start === 100 && range.end === 300, 'sample range 100..300');

const clipped = segmentToSampleRange(seg({ endTime: 99 }), SR, 500);
assert(clipped !== null && clipped.end === 500, 'range clipped to buffer length');

assert(
  segmentToSampleRange(seg({ startTime: 5, endTime: 6 }), SR, 100) === null,
  'range outside buffer is null'
);
assert(
  segmentToSampleRange(seg({ startTime: 0.3, endTime: 0.1 }), SR, 1000) === null,
  'inverted range is null'
);

// 3. GAIN
{
  const data = ones(10);
  applyGain(data, 2, 5, 0.5);
  assert(data[1] === 1, 'gain leaves samples before range untouched');
  assert(approx(data[2], 0.5) && approx(data[4], 0.5), 'gain applied inside range');
  assert(data[5] === 1, 'gain leaves samples after range untouched');
}
{
  const data = ones(4);
  applyGain(data, 0, 4, 0);
  assert(data.every((v) => v === 0), 'gain 0 silences');
}

// 4. LOWPASS – smooths a step / attenuates high frequencies
{
  const data = new Float32Array(200);
  for (let i = 0; i < data.length; i++) {
    // Nyquist-rate alternating signal = highest possible frequency
    data[i] = i % 2 === 0 ? 1 : -1;
  }
  applyLowpass(data, 0, data.length, 50, SR);
  let energy = 0;
  for (let i = 100; i < data.length; i++) energy += data[i] * data[i];
  assert(energy / 100 < 0.5, `lowpass should attenuate nyquist tone, got ${energy / 100}`);
}
{
  // DC signal must survive a lowpass essentially unchanged
  const data = ones(100);
  applyLowpass(data, 0, data.length, 200, SR);
  assert(approx(data[99], 1, 1e-3), 'lowpass passes DC');
}

// 5. ECHO – repeats energy after the delay time
{
  const data = new Float32Array(100);
  data[0] = 1;
  applyEcho(data, 0, data.length, 0.01, 0.5, 1, SR); // 10 samples delay, full wet
  assert(approx(data[0], 1), 'echo keeps the initial impulse');
  assert(approx(data[10], 0.5), `echo tap at 0.5, got ${data[10]}`);
  assert(approx(data[20], 0.25), `second tap at 0.25, got ${data[20]}`);
  assert(data[5] === 0, 'no energy between taps');
}
{
  const data = new Float32Array(50);
  data[0] = 1;
  applyEcho(data, 0, data.length, 0.01, 0.5, 0, SR);
  assert(data[10] === 0, 'mix 0 is a no-op');
}

// 6. applyEffectSegment dispatch + bypass
{
  const data = ones(10);
  applyEffectSegment(data, seg({ startTime: 0, endTime: 0.01, params: { amount: 2 } }), SR);
  assert(approx(data[0], 2), 'segment dispatches to GAIN');
}
{
  const data = ones(10);
  applyEffectSegment(
    data,
    seg({ startTime: 0, endTime: 0.01, params: { amount: 2 }, bypass: true }),
    SR
  );
  assert(data[0] === 1, 'bypassed segment does nothing');
}

// 7. applyEffectTracks – ordering and mute
{
  const data = ones(10);
  const tracks: EffectTrack[] = [
    {
      id: 't1',
      name: 'FX 1',
      segments: [seg({ id: 'a', startTime: 0, endTime: 0.01, params: { amount: 2 } })],
    },
    {
      id: 't2',
      name: 'FX 2',
      segments: [seg({ id: 'b', startTime: 0, endTime: 0.01, params: { amount: 3 } })],
    },
  ];
  applyEffectTracks(data, tracks, SR);
  assert(approx(data[0], 6), `stacked gains should multiply to 6, got ${data[0]}`);
}
{
  const data = ones(10);
  applyEffectTracks(
    data,
    [
      {
        id: 't1',
        name: 'FX 1',
        muted: true,
        segments: [seg({ startTime: 0, endTime: 0.01, params: { amount: 2 } })],
      },
    ],
    SR
  );
  assert(data[0] === 1, 'muted track is skipped');
}

console.log('✓ effectEngine tests passed');
