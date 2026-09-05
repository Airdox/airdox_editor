/**
 * @license
 * High-fidelity DJ procedural track generator: "Terminator (Original Mix)"
 * Generates genuine 130.00 BPM 4/4 electronic track with kick, bassline,
 * synth stabs, hi-hats, claps, and breakdown sections for authentic audio editing.
 */

export function generateElectronicDjTrack(
  audioCtx: AudioContext,
  bpm: number = 130.0,
  bars: number = 64,
  firstBeatSec: number = 0.0
): AudioBuffer {
  const sampleRate = audioCtx.sampleRate;
  const beatsPerBar = 4;
  const totalBeats = bars * beatsPerBar;
  const secondsPerBeat = 60.0 / bpm;
  const normalizedFirstBeat = Math.max(0.0, firstBeatSec);
  const totalDuration = normalizedFirstBeat + totalBeats * secondsPerBeat; // e.g. 64 bars @ 130 bpm = ~118.15s
  const totalSamples = Math.floor(sampleRate * totalDuration);

  const buffer = audioCtx.createBuffer(2, totalSamples, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const sixteenthSamples = Math.max(1, Math.round((secondsPerBeat / 4) * sampleRate));

  // Key: 2A (E-flat minor / D# minor)
  // Frequencies: Eb1=38.89Hz, Eb2=77.78Hz, Gb2=92.50Hz, Ab2=110Hz, Bb2=116.54Hz, Db3=138.59Hz
  const rootFreq = 38.89; // Sub-bass
  const bassNotes = [rootFreq, rootFreq, rootFreq * 1.5, rootFreq * 1.2, rootFreq, rootFreq * 1.33, rootFreq, rootFreq * 1.2];
  const chordNotes = [311.13, 369.99, 466.16]; // Eb4, Gb4, Bb4

  for (let beat = 0; beat < totalBeats; beat++) {
    const bar = Math.floor(beat / 4);
    const beatInBar = beat % 4;
    const startSample = Math.round((normalizedFirstBeat + beat * secondsPerBeat) * sampleRate);
    if (startSample >= totalSamples) break;
    const isBreakdown = (bar >= 24 && bar < 32) || (bar >= 48 && bar < 56);
    const isBuildUp = (bar >= 30 && bar < 32) || (bar >= 54 && bar < 56);

    // 1. KICK DRUM (on every beat, absent during breakdown)
    if (!isBreakdown || isBuildUp) {
      const kickLen = Math.floor(0.28 * sampleRate);
      for (let i = 0; i < kickLen && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        // Pitch drop envelope from 150Hz down to 42Hz
        const f = 42 + 120 * Math.exp(-t * 26);
        const phase = 2 * Math.PI * f * t;
        const env = Math.exp(-t * 14);
        const kickSample = Math.sin(phase) * env * 0.75;
        // Click transient
        const click = (Math.random() * 2 - 1) * Math.exp(-t * 80) * 0.15;
        const total = (kickSample + click) * 0.85;

        left[startSample + i] += total;
        right[startSample + i] += total;
      }
    }

    // 2. SNARE / CLAP (on beats 2 & 4 = beatInBar 1 & 3)
    if ((beatInBar === 1 || beatInBar === 3) && (!isBreakdown || isBuildUp)) {
      const clapLen = Math.floor(0.2 * sampleRate);
      for (let i = 0; i < clapLen && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 22);
        // Multi-tap clap bursts
        let tap = 0;
        if (t < 0.03) {
          tap = Math.sin(t * 1200) * 0.3;
        }
        const noise = (Math.random() * 2 - 1) * 0.45;
        const body = Math.sin(2 * Math.PI * 220 * t) * 0.25;
        const val = (noise + tap + body) * env * 0.55;

        left[startSample + i] += val * 0.9;
        right[startSample + i] += val * 1.0;
      }
    }

    // 3. HI-HATS (16th notes: closed & open on the off-beat)
    for (let sub = 0; sub < 4; sub++) {
      const subStart = startSample + sub * sixteenthSamples;
      const isOpen = sub === 2; // off-beat open hat
      const hatLen = Math.floor((isOpen ? 0.16 : 0.04) * sampleRate);
      const amp = isOpen ? 0.28 : 0.12;

      for (let i = 0; i < hatLen && subStart + i < totalSamples; i++) {
        const t = i / sampleRate;
        const decay = isOpen ? 18 : 65;
        const env = Math.exp(-t * decay);
        // High-passed noise
        const n1 = Math.random() * 2 - 1;
        const n2 = Math.sin(2 * Math.PI * 8500 * t) * 0.3;
        const hatVal = (n1 + n2) * env * amp;

        // Stereo pan alternating
        const pan = sub % 2 === 0 ? 0.85 : 1.15;
        left[subStart + i] += hatVal * (2 - pan) * 0.5;
        right[subStart + i] += hatVal * pan * 0.5;
      }
    }

    // 4. SYNTH BASSLINE (running 16th groove)
    if (!isBreakdown) {
      for (let sub = 0; sub < 4; sub++) {
        const subStart = startSample + sub * sixteenthSamples;
        const noteIdx = (beat * 4 + sub) % bassNotes.length;
        const freq = bassNotes[noteIdx];
        const bassLen = Math.floor(0.12 * sampleRate);

        for (let i = 0; i < bassLen && subStart + i < totalSamples; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 18);
          // Sawtooth waveform with low-pass resonance
          const saw = (2 * ((t * freq) % 1) - 1);
          const subOsc = Math.sin(2 * Math.PI * freq * t);
          const bVal = (saw * 0.35 + subOsc * 0.65) * env * 0.38;

          left[subStart + i] += bVal;
          right[subStart + i] += bVal;
        }
      }
    }

    // 5. SYNTH CHORD STABS (every 2 bars or breakdown atmospheric chords)
    if (bar % 2 === 0 && beatInBar === 0) {
      const stabLen = Math.floor(0.65 * sampleRate);
      for (let i = 0; i < stabLen && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 4.5);
        let chordVal = 0;
        for (const cf of chordNotes) {
          const saw = 2 * ((t * cf) % 1) - 1;
          chordVal += saw * 0.12;
        }
        const spreadL = chordVal * env * 0.4;
        const spreadR = chordVal * env * 0.45;
        left[startSample + i] += spreadL;
        right[startSample + i] += spreadR;
      }
    }
  }

  // Normalize / Soft clip to prevent harsh distortion
  for (let i = 0; i < totalSamples; i++) {
    left[i] = Math.tanh(left[i]);
    right[i] = Math.tanh(right[i]);
  }

  return buffer;
}
