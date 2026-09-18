import assert from 'node:assert/strict';
import { stemEngine, STEM_TYPES, TrackStems } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

const sampleRate = 8000;
const samples = new Float32Array(800);
for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
const source = makeAudioBuffer(samples, sampleRate);
const originalWindow = globalThis.window as any;
const originalFetch = globalThis.fetch;

function desktop(overrides: Record<string, unknown>): Window {
  return { rekordboxDesktop: overrides } as unknown as Window;
}

async function expectUnavailable(name: string, configure: () => void): Promise<void> {
  stemEngine.clearCache();
  configure();
  await assert.rejects(
    () => (stemEngine as any).separateAudioBufferWithModel(source, `strict-${name}`, `sha-strict-${name}`),
    (error: any) => {
      const msg = String(error.message);
      const code = error.code || '';
      assert.ok(
        msg.includes('STEM_ENGINE_UNAVAILABLE') || msg.includes('STEM AI UNAVAILABLE') || msg.includes('nicht verfügbar') || msg.includes('deprecated') || code === 'STEM_ENGINE_UNAVAILABLE',
        `${name}: must throw STEM_ENGINE_UNAVAILABLE (got: ${msg} code:${code})`
      );
      return true;
    },
    `${name}: must reject with STEM_ENGINE_UNAVAILABLE, not fallback`
  );

  // Even with allowFallback true, must still reject per §2 – spectral fallback NOT allowed as Stem Separation
  stemEngine.clearCache();
  configure();
  await assert.rejects(
    () => (stemEngine as any).separateAudioBufferWithModel(source, `fallback-${name}`, `sha-${name}`, () => {}, { allowFallback: true }),
    (error: any) => {
      const msg = String(error.message);
      assert.ok(msg.includes('STEM_ENGINE_UNAVAILABLE') || msg.includes('STEM AI UNAVAILABLE') || msg.includes('deprecated') || msg.includes('KEINE echte'), `${name}: fallback still blocked got ${msg}`);
      return true;
    },
    `${name}: even with allowFallback must still reject`
  );

  // Also separateAudioBuffer must throw
  stemEngine.clearCache();
  configure();
  await assert.rejects(
    () => stemEngine.separateAudioBuffer(source, `old-${name}`, `sha-old-${name}`, () => {}),
    (error: any) => {
      assert.ok(String(error.message).includes('STEM_ENGINE_UNAVAILABLE') || String(error.message).includes('KEINE echte'));
      return true;
    }
  );
}

async function run() {
  let separationCalls = 0;
  try {
    await expectUnavailable('unsupported-python-314', () => {
      (globalThis as any).window = desktop({
        getStemEngineStatus: async () => ({ available: false, reason: 'Python 3.14 wird nicht unterstützt', code: 'PYTHON_VERSION_UNSUPPORTED' }),
        separateStems: async () => { separationCalls++; },
      });
    });
    assert.equal(separationCalls, 0, 'unsupported Python detected before inference');

    await expectUnavailable('status-ipc-rejected', () => {
      (globalThis as any).window = desktop({ getStemEngineStatus: async () => { throw new Error('IPC unavailable'); } });
    });

    await expectUnavailable('module-disappeared-after-probe', () => {
      (globalThis as any).window = desktop({
        getStemEngineStatus: async () => ({ available: true }),
        separateStems: async () => { throw new Error("No module named 'demucs'"); },
      });
    });

    await expectUnavailable('browser-network-offline', () => {
      (globalThis as any).window = {} as Window;
      globalThis.fetch = async () => { throw new Error('network offline'); };
    });

    await expectUnavailable('service-http-503', () => {
      (globalThis as any).window = {} as Window;
      globalThis.fetch = async () => ({
        ok: false, status: 503, json: async () => ({ error: 'model download failed' }),
      } as unknown as Response);
    });

    await expectUnavailable('malformed-service-response', () => {
      (globalThis as any).window = {} as Window;
      globalThis.fetch = async () => ({
        ok: true, status: 200, json: async () => ({ engine: 'not-demucs', stems: {} }),
      } as unknown as Response);
    });

    console.log('Stem production fallback matrix: 6 failure modes correctly return STEM_ENGINE_UNAVAILABLE (no spectral fallback)');
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    globalThis.fetch = originalFetch;
  }
}
run().catch((error) => { console.error(error); process.exit(1); });
