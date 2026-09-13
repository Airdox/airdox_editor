import {
  parseMusicalKey,
  calculateHarmonicPitchShift,
  resampleChannelData,
  wsolaTimeStretchChannelData,
  pitchShiftChannelData,
} from '../src/audio/pitchTempoEngine';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('Testing pitchTempoEngine...');

// 1. Key parsing
const am = parseMusicalKey('8A');
assert(am !== null && am.root === 9 && am.isMinor === true, '8A should be Am (root 9, minor)');
const c = parseMusicalKey('8B');
assert(c !== null && c.root === 0 && c.isMinor === false, '8B should be C (root 0, major)');

const fsharpM = parseMusicalKey('F#m');
assert(fsharpM !== null && fsharpM.camelot === '11A' && fsharpM.root === 6, 'F#m should be 11A');

// 2. Harmonic Pitch Shift calculation
const shiftAmToEm = calculateHarmonicPitchShift('8A', '9A'); // Am (9) to Em (4) -> diff = -5
assert(shiftAmToEm.semitones === -5, `Am to Em expected -5 semitones, got ${shiftAmToEm.semitones}`);

const shiftRelative = calculateHarmonicPitchShift('8A', '8B'); // Am to C major
assert(shiftRelative.semitones === 0, `Am to C relative expected 0 semitones, got ${shiftRelative.semitones}`);

// 3. WSOLA Time-Stretching
const sampleRate = 44100;
const durationSec = 0.5;
const length = Math.floor(sampleRate * durationSec);
const sine = new Float32Array(length);
for (let i = 0; i < length; i++) {
  sine[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
}

// Stretch factor 0.8 (20% faster)
const stretchedFast = wsolaTimeStretchChannelData([sine], sampleRate, 0.8);
assert(stretchedFast[0].length < length, 'Stretched fast should have fewer samples');
assert(!Number.isNaN(stretchedFast[0][100]), 'No NaNs in output');

// Pitch shift by +2 semitones
const pitchShifted = pitchShiftChannelData([sine], sampleRate, 2);
assert(pitchShifted[0].length === length || Math.abs(pitchShifted[0].length - length) < 100, 'Pitch shift maintains approx length');

console.log('All pitchTempoEngine tests passed successfully!');
