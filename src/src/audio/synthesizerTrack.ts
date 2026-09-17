/**
 * @license
 * High-fidelity DJ procedural track generator: "La Roux - Quicksand (Boy 8 Bit mix)"
 * Generates genuine 130.05 BPM 4/4 electro track with 8-bit chip synths, punchy kicks,
 * running basslines, and breakdown/drop structures matching the Rekordbox EDIT mode reference.
 */

export function generateElectronicDjTrack(
  audioCtx: AudioContext,
  bpm: number = 130.05,
  bars: number = 194,
  firstBeatSec: number = 0.0
): AudioBuffer {
  const sampleRate = audioCtx.sampleRate;
  const beatsPerBar = 4;
  const totalBeats = bars * beatsPerBar;
  const secondsPerBeat = 60.0 / bpm;
  const normalizedFirstBeat = Math.max(0.0, firstBeatSec);
  const totalDuration = normalizedFirstBeat + totalBeats * secondsPerBeat; // ~357.5s for 194 bars @ 130.05 bpm
  const totalSamples = Math.floor(sampleRate * totalDuration);

  const buffer = audioCtx.createBuffer(2, totalSamples, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const sixteenthSamples = Math.max(1, Math.round((secondsPerBeat / 4) * sampleRate));

  // Key: 3A (B-flat minor / A# minor)
  // Bb1=58.27Hz, Bb2=116.54Hz, Db3=138.59Hz, Eb3=155.56Hz, F3=174.61Hz, Ab3=207.65Hz
  const rootFreq = 58.27; // Bb1
  const bassNotes = [rootFreq, rootFreq, rootFreq * 1.2, rootFreq, rootFreq * 1.33, rootFreq, rootFreq * 1.5, rootFreq * 1.2];
  // 8-bit chip arpeggio notes (Bb4, Db5, F5, Ab5)
  const arpNotes = [466.16, 554.37, 698.46, 830.61, 932.33, 830.61, 698.46, 554.37];

  for (let beat = 0; beat < totalBeats; beat++) {
    const bar = Math.floor(beat / 4);
    const beatInBar = beat % 4;
    const startSample = Math.round((normalizedFirstBeat + beat * secondsPerBeat) * sampleRate);
    if (startSample >= totalSamples) break;

    // Authentic song structure matching screenshot:
    // Bars 0-32: Intro build
    // Bars 33-96: Verse 1 and driving groove
    // Bars 97-112: The Breakdown (NO KICKS, pure 8-bit arpeggios in green/cyan, rising snare roll at 109-112)
    // Bars 113-160: THE MAIN DROP (Intense kicks, fiery red/orange waveform, distorted bass)
    // Bars 161-194: Outro groove & fade
    const isBreakdown = (bar >= 96 && bar < 112) || (bar >= 168 && bar < 176);
    const isBuildUp = (bar >= 108 && bar < 112); // Bars 109-112: intense rising snare & sweep
    const isDrop = (bar >= 112 && bar < 144); // Bar 113+ is drop

    // 1. KICK DRUM (Absent in breakdown, hits hard on every quarter beat in groove & drop)
    if (!isBreakdown) {
      const kickLen = Math.floor(0.32 * sampleRate);
      const intensity = isDrop ? 1.0 : 0.85;

      for (let i = 0; i < kickLen && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        // Pitch drop envelope from 160Hz down to 48Hz
        const f = 48 + 125 * Math.exp(-t * 30);
        // Using cosine ensures maximum punch/transient amplitude occurs precisely at t=0 (sample 0 of beat)
        const kickBody = Math.cos(2 * Math.PI * f * t) * Math.exp(-t * 16) * 0.78;
        // Immediate transient click at t=0
        const click = Math.cos(2 * Math.PI * 900 * t) * Math.exp(-t * 60) * 0.22;
        const total = (kickBody + click) * intensity;

        left[startSample + i] += total;
        right[startSample + i] += total;
      }
    }

    // 2. SNARE / CLAP (on beats 2 & 4; rolls during buildup 109-112)
    const isClapBeat = beatInBar === 1 || beatInBar === 3 || (isBuildUp && (beatInBar === 0 || beatInBar === 2));
    if (isClapBeat && (!isBreakdown || isBuildUp)) {
      const clapLen = Math.floor(0.22 * sampleRate);
      const clapAmp = isBuildUp ? 0.35 + ((bar - 108) / 4) * 0.45 : 0.6;

      for (let i = 0; i < clapLen && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 24);
        const noise = (Math.random() * 2 - 1) * 0.5;
        const tone = Math.sin(2 * Math.PI * 240 * t) * 0.3;
        const val = (noise + tone) * env * clapAmp;

        left[startSample + i] += val * 0.9;
        right[startSample + i] += val * 1.0;
      }
    }

    // 3. 8-BIT CHIP ARPEGGIO & SYNTH (Active throughout, especially dominant in breakdown 109-112)
    for (let sub = 0; sub < 4; sub++) {
      const subStart = startSample + sub * sixteenthSamples;
      const arpIdx = (beat * 4 + sub) % arpNotes.length;
      const freq = arpNotes[arpIdx];
      const noteLen = Math.floor(0.12 * sampleRate);
      const arpAmp = isBreakdown ? 0.42 : 0.25;

      for (let i = 0; i < noteLen && subStart + i < totalSamples; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 18);
        // Authentic 8-bit pulse wave (25% duty cycle)
        const phase = (t * freq) % 1;
        const pulse = phase < 0.25 ? 1.0 : -0.33;
        const val = pulse * env * arpAmp;

        // Stereo ping-pong
        const panL = sub % 2 === 0 ? 1.1 : 0.7;
        const panR = sub % 2 === 0 ? 0.7 : 1.1;
        left[subStart + i] += val * panL;
        right[subStart + i] += val * panR;
      }
    }

    // 4. HI-HATS (16th notes: closed & off-beat open)
    if (!isBreakdown || bar >= 110) {
      for (let sub = 0; sub < 4; sub++) {
        const subStart = startSample + sub * sixteenthSamples;
        const isOpen = sub === 2; // off-beat hat
        const hatLen = Math.floor((isOpen ? 0.18 : 0.05) * sampleRate);
        const amp = isOpen ? 0.26 : 0.14;

        for (let i = 0; i < hatLen && subStart + i < totalSamples; i++) {
          const t = i / sampleRate;
          const decay = isOpen ? 16 : 60;
          const env = Math.exp(-t * decay);
          const noise = Math.random() * 2 - 1;
          const metal = Math.sin(2 * Math.PI * 9200 * t) * 0.35;
          const hatVal = (noise + metal) * env * amp;

          left[subStart + i] += hatVal * 0.8;
          right[subStart + i] += hatVal * 1.0;
        }
      }
    }

    // 5. DISTORTED 8-BIT BASSLINE (Pumping on off-beats, absent in breakdown)
    if (!isBreakdown) {
      for (let sub = 0; sub < 4; sub++) {
        const subStart = startSample + sub * sixteenthSamples;
        const noteIdx = (beat * 4 + sub) % bassNotes.length;
        const bFreq = bassNotes[noteIdx];
        const bassLen = Math.floor(0.14 * sampleRate);

        for (let i = 0; i < bassLen && subStart + i < totalSamples; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 14);
          // Sawtooth with slight saturation
          const saw = 2 * ((t * bFreq) % 1) - 1;
          const square = ((t * bFreq) % 1) < 0.5 ? 0.6 : -0.6;
          const bVal = (saw * 0.5 + square * 0.5) * env * (isDrop ? 0.48 : 0.35);

          left[subStart + i] += bVal;
          right[subStart + i] += bVal;
        }
      }
    }
  }

  // Normalize / Soft clip
  for (let i = 0; i < totalSamples; i++) {
    left[i] = Math.tanh(left[i]);
    right[i] = Math.tanh(right[i]);
  }

  return buffer;
}
