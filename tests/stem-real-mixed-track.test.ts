import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stemEngine, STEM_TYPES, StemType, TrackStems } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

const FIXTURE = path.resolve('tests/fixtures/musdb-falcon69');
const OUTPUT = path.resolve('stem-test-output/musdb-falcon69');

type Stereo = { left: Float32Array; right: Float32Array; sampleRate: number };
function decodePcm16Wav(bytes: Buffer): Stereo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let offset = 12, channels = 0, sampleRate = 0, dataOffset = 0, dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      assert.equal(view.getUint16(offset + 8, true), 1, 'fixture must be PCM');
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      assert.equal(view.getUint16(offset + 22, true), 16, 'fixture must be PCM16');
    } else if (id === 'data') {
      dataOffset = offset + 8; dataSize = size; break;
    }
    offset += 8 + size + (size & 1);
  }
  assert.equal(channels, 2);
  const frames = dataSize / 4;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(dataOffset + i * 4, true) / 32768;
    right[i] = view.getInt16(dataOffset + i * 4 + 2, true) / 32768;
  }
  return { left, right, sampleRate };
}

function encodePcm16Wav(buffer: AudioBuffer): Buffer {
  const bytes = Buffer.alloc(44 + buffer.length * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + buffer.length * 4, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(buffer.sampleRate, 24);
  bytes.writeUInt32LE(buffer.sampleRate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(buffer.length * 4, 40);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  for (let i = 0; i < buffer.length; i++) {
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return bytes;
}

function rms(values: Float32Array): number {
  let energy = 0; for (const value of values) energy += value * value;
  return Math.sqrt(energy / values.length);
}
function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length); let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return ab / Math.sqrt(aa * bb);
}

async function run() {
  // The production separator receives exactly one pre-mixed professional song excerpt.
  const mix = decodePcm16Wav(await readFile(path.join(FIXTURE, 'mixture.wav')));
  const source = makeAudioBuffer(mix.left, mix.sampleRate, mix.right);
  stemEngine.clearCache();

  // Reproduce the exact packaged-Windows failure reported by the user: the
  // Electron IPC exists, but its system Python has no Demucs module. The same
  // production method used by the UI must recover locally instead of showing
  // an error dialog or leaving the deck without stems.
  const originalWindow = globalThis.window;
  let ipcSeparationCalls = 0;
  (globalThis as unknown as { window: Window }).window = {
    rekordboxDesktop: {
      getStemEngineStatus: async () => ({
        available: false,
        python: null,
        model: 'htdemucs_ft',
        weightsPresent: 0,
        weightsRequired: 4,
        weightsReady: false,
        probes: [],
        reason: "C:\\Python314\\python.exe: No module named demucs",
      }),
      separateStems: async () => {
        ipcSeparationCalls++;
        throw new Error('must not invoke separation after failed preflight');
      },
    },
  } as unknown as Window;

  let stems: TrackStems;
  try {
    stems = await stemEngine.separateAudioBufferWithModel(
      source, 'musdb-falcon69-blind-mix', 'fixture-mixture-only'
    );
  } finally {
    if (originalWindow === undefined) delete (globalThis as unknown as { window?: Window }).window;
    else (globalThis as unknown as { window: Window }).window = originalWindow;
  }
  assert.equal(ipcSeparationCalls, 0, 'failed preflight must be detected before sending the song to IPC');
  assert.equal(stems.separationMethod, 'LOCAL_SPECTRAL_FALLBACK');
  await mkdir(OUTPUT, { recursive: true });

  const rmsLevels = new Map<StemType, number>();
  for (const stem of STEM_TYPES) {
    const level = rms(stems[stem].getChannelData(0));
    rmsLevels.set(stem, level);
    assert.ok(level > 0.0001, `${stem} must contain audible audio, got RMS ${level}`);
    await writeFile(path.join(OUTPUT, `${stem}.wav`), encodePcm16Wav(stems[stem]));
  }
  assert.ok(rmsLevels.get('vocals')! > 0.001, 'Vocal Solo must not be silent');

  // Exact reconstruction proves all outputs originate from, and cover, the complete mix.
  let maxDiff = 0;
  for (let i = 0; i < source.length; i++) {
    const reconstructed = STEM_TYPES.reduce((sum, stem) => sum + stems[stem].getChannelData(0)[i], 0);
    maxDiff = Math.max(maxDiff, Math.abs(reconstructed - mix.left[i]));
  }
  assert.ok(maxDiff < 1e-5, `four stems must reconstruct the input mix; max diff ${maxDiff}`);

  // References are loaded only now, after blind inference, and only for evaluation.
  const scores = new Map<StemType, number>();
  for (const stem of STEM_TYPES) {
    const reference = decodePcm16Wav(await readFile(path.join(FIXTURE, `${stem}.wav`)));
    const score = correlation(stems[stem].getChannelData(0), reference.left);
    scores.set(stem, score);
    assert.ok(score > 0.2, `${stem} output must contain its real source; correlation ${score}`);
  }
  const mixVocalCorrelation = correlation(
    mix.left,
    decodePcm16Wav(await readFile(path.join(FIXTURE, 'vocals.wav'))).left
  );
  assert.ok(
    scores.get('vocals')! > mixVocalCorrelation,
    'Vocal stem must be more vocal-focused than the original full mix'
  );

  console.log('REAL PRE-MIXED TRACK PASS — The Easton Ellises - Falcon 69 (MUSDB excerpt)');
  console.log(`input: mixture.wav only | correlations vocals=${scores.get('vocals')!.toFixed(3)} drums=${scores.get('drums')!.toFixed(3)} bass=${scores.get('bass')!.toFixed(3)} other=${scores.get('other')!.toFixed(3)}`);
  console.log(`RMS vocals=${rmsLevels.get('vocals')!.toFixed(4)} drums=${rmsLevels.get('drums')!.toFixed(4)} bass=${rmsLevels.get('bass')!.toFixed(4)} other=${rmsLevels.get('other')!.toFixed(4)}`);
  console.log(`audition files: ${OUTPUT}`);
}
run().catch((error) => { console.error(error); process.exit(1); });
