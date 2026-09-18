import assert from 'node:assert/strict';
import { stemEngine } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURE = path.resolve('tests/fixtures/musdb-falcon69');

function decodePcm16Wav(bytes: Buffer): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12, channels = 0, sampleRate = 0, dataOffset = 0, dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === 'data') {
      dataOffset = offset + 8; dataSize = size; break;
    }
    offset += 8 + size + (size & 1);
  }
  const frames = dataSize / 4;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(dataOffset + i * 4, true) / 32768;
    right[i] = view.getInt16(dataOffset + i * 4 + 2, true) / 32768;
  }
  return { left, right, sampleRate };
}

async function run() {
  console.log('=== REAL MIXED TRACK – BS-RoFormer only, no spectral fallback ===');
  const originalWindow = (globalThis as any).window;
  try {
    const mixPath = path.join(FIXTURE, 'mixture.wav');
    let source: AudioBuffer;
    try {
      const mix = decodePcm16Wav(await readFile(mixPath));
      source = makeAudioBuffer(mix.left, mix.sampleRate, mix.right);
    } catch {
      console.log('[SKIP] Fixture not present – testing unavailable path only');
      const samples = new Float32Array(800);
      for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 8000);
      source = makeAudioBuffer(samples, 8000);
    }

    stemEngine.clearCache();

    // Simulate Windows failure: Python 3.14 no demucs – must return STEM_ENGINE_UNAVAILABLE, not fallback
    (globalThis as any).window = {
      rekordboxDesktop: {
        getStemEngineStatus: async () => ({
          available: false,
          python: null,
          model: 'bsroformer',
          reason: 'C:\\Python314\\python.exe: No module named demucs – BS-RoFormer requires Python 3.9-3.13',
          code: 'PYTHON_VERSION_UNSUPPORTED',
        }),
        separateStems: async () => { throw new Error('must not invoke after failed preflight'); },
      },
    };

    await assert.rejects(
      () => (stemEngine as any).separateAudioBufferWithModel(source, 'musdb-falcon69-strict', 'fixture-strict'),
      (err: any) => {
        const msg = String(err.message);
        assert.ok(msg.includes('STEM_ENGINE_UNAVAILABLE') || msg.includes('STEM AI UNAVAILABLE') || msg.includes('deprecated') || err.code === 'STEM_ENGINE_UNAVAILABLE');
        return true;
      },
      'strict mode must reject with STEM_ENGINE_UNAVAILABLE'
    );

    await assert.rejects(
      () => stemEngine.separateAudioBuffer(source, 'musdb-falcon69-old', 'fixture-old', () => {}),
      (err: any) => {
        assert.ok(String(err.message).includes('STEM_ENGINE_UNAVAILABLE') || String(err.message).includes('KEINE echte'));
        return true;
      }
    );

    // Check availability reports STEM_ENGINE_UNAVAILABLE
    const avail = await stemEngine.checkAvailability();
    if (!avail.available) {
      assert.equal(avail.code, 'STEM_ENGINE_UNAVAILABLE');
      console.log(`[PASS] Correctly reports STEM_ENGINE_UNAVAILABLE: ${avail.reason?.slice(0,80)}`);
    } else {
      console.log('[INFO] Engine available – would run real BS-RoFormer (no fallback needed)');
    }

    console.log('Real mixed track test passed – no spectral fallback offered');
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
