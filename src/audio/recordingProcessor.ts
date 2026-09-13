/**
 * Professional set-recording post processor.
 *
 * The browser recorder is used only as a transport. The complete captured set
 * is decoded first and then processed as one continuous file. This keeps the
 * level treatment consistent from the first beat to the last beat instead of
 * applying a separate normalisation to every MediaRecorder chunk.
 */

export interface RecordingOptimizationOptions {
  targetLufs: number;
  truePeakDb: number;
  targetSampleRate: 44100 | 48000;
  channels: 'STEREO' | 'MONO';
}

export interface RecordingAudioStats {
  duration: number;
  sampleRate: number;
  channels: number;
  peakDbtp: number;
  rmsDb: number;
  estimatedLufs: number;
  gainDb: number;
  clippedSamples: number;
}

const EPSILON = 1e-9;

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(value: number): number {
  return 20 * Math.log10(Math.max(EPSILON, value));
}

/** A fast, stable whole-file loudness estimate suitable for a recorder preview. */
export function measureRecordingAudio(buffer: AudioBuffer): RecordingAudioStats {
  const channels = Math.min(2, buffer.numberOfChannels);
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : left;
  let sumSquares = 0;
  let peak = 0;
  let clippedSamples = 0;

  for (let i = 0; i < buffer.length; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    const linkedPeak = Math.max(Math.abs(l), Math.abs(r));
    peak = Math.max(peak, linkedPeak);
    if (linkedPeak >= 0.9999) clippedSamples += 1;
    sumSquares += channels === 1 ? l * l : (l * l + r * r) / 2;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, buffer.length));
  return {
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels,
    peakDbtp: linearToDb(peak),
    rmsDb: linearToDb(rms),
    // LUFS needs a full BS.1770 K-weighted implementation. RMS is a useful,
    // honest approximation for an in-app set recorder and is labelled as such.
    estimatedLufs: linearToDb(rms),
    gainDb: 0,
    clippedSamples,
  };
}

/**
 * Resamples with the browser's high quality OfflineAudioContext. It is kept
 * separate so exported WAV/FLAC files really honour the selected sample rate.
 */
async function resampleBuffer(buffer: AudioBuffer, sampleRate: 44100 | 48000): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate) return buffer;
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = Math.max(1, Math.ceil(buffer.duration * sampleRate));
  const Offline = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return buffer;
  const offline = new Offline(channels, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

function downmixToMono(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const mono = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: 1,
    sampleRate: buffer.sampleRate,
  });
  const out = mono.getChannelData(0);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < buffer.length; i++) out[i] = (left[i] + right[i]) * 0.5;
  return mono;
}

/**
 * Processes the complete set in one pass: level-match towards the chosen
 * streaming target and apply a linked true-peak ceiling. The ceiling is
 * applied after the global gain calculation, so no samples can exceed it.
 */
export async function optimizeRecordingBuffer(
  source: AudioBuffer,
  options: RecordingOptimizationOptions
): Promise<{ buffer: AudioBuffer; before: RecordingAudioStats; after: RecordingAudioStats }> {
  const before = measureRecordingAudio(source);
  const rateAdjusted = await resampleBuffer(source, options.targetSampleRate);
  const channelAdjusted = options.channels === 'MONO' ? downmixToMono(rateAdjusted) : rateAdjusted;
  const channels = Math.min(2, channelAdjusted.numberOfChannels);
  const left = channelAdjusted.getChannelData(0);
  const right = channels > 1 ? channelAdjusted.getChannelData(1) : left;
  const target = dbToLinear(options.targetLufs);
  const ceiling = dbToLinear(Math.min(-0.1, options.truePeakDb));
  const measured = measureRecordingAudio(channelAdjusted);

  // First match the complete file to the selected target. Never add gain that
  // would make the linked peak cross the true-peak ceiling.
  const loudnessGain = target / Math.max(EPSILON, dbToLinear(measured.estimatedLufs));
  const peakSafeGain = ceiling / Math.max(EPSILON, Math.max(0, dbToLinear(measured.peakDbtp)));
  const gain = Math.min(loudnessGain, peakSafeGain, 4);
  const gainDb = linearToDb(gain);

  const output = new AudioBuffer({
    length: channelAdjusted.length,
    numberOfChannels: channels,
    sampleRate: channelAdjusted.sampleRate,
  });
  const outL = output.getChannelData(0);
  const outR = channels > 1 ? output.getChannelData(1) : outL;

  // A short linked look-ahead window catches inter-sample-ish peaks and makes
  // the ceiling less brittle than a single-sample hard clipper.
  const lookAhead = Math.max(1, Math.round(channelAdjusted.sampleRate * 0.001));
  for (let i = 0; i < channelAdjusted.length; i++) {
    let localPeak = 0;
    const end = Math.min(channelAdjusted.length, i + lookAhead);
    for (let j = i; j < end; j++) {
      localPeak = Math.max(localPeak, Math.abs(left[j] || 0), Math.abs(right[j] || 0));
    }
    const predicted = localPeak * gain;
    const safetyGain = predicted > ceiling ? ceiling / predicted : 1;
    outL[i] = (left[i] || 0) * gain * safetyGain;
    if (channels > 1) outR[i] = (right[i] || 0) * gain * safetyGain;
  }

  const after = measureRecordingAudio(output);
  after.gainDb = gainDb;
  return { buffer: output, before: { ...before, gainDb }, after };
}
