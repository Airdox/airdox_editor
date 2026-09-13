import assert from 'node:assert/strict';
import { stemEngine, STEM_TYPES, TrackStems } from '../src/audio/stemEngine';
import { makeAudioBuffer } from './support/editingHarness';

const sampleRate = 8000;
const samples = new Float32Array(800);
for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
const source = makeAudioBuffer(samples, sampleRate);
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

function desktop(overrides: Record<string, unknown>): Window {
  return { rekordboxDesktop: overrides } as unknown as Window;
}

async function expectFallback(name: string, configure: () => void): Promise<TrackStems> {
  // 1. The DEFAULT path must now REFUSE the silent quality downgrade: without
  //    an explicit allowFallback opt-in, a missing Demucs installation is an
  //    error, never a degraded "success".
  stemEngine.clearCache();
  configure();
  await assert.rejects(
    () => stemEngine.separateAudioBufferWithModel(source, `strict-${name}`, `sha-strict-${name}`),
    (error: Error) => {
      assert.ok(
        error.message.includes('nicht verfügbar') || error.message.includes('NICHT erzeugt'),
        `${name}: strict mode error explains the refusal (got: ${error.message})`
      );
      return true;
    },
    `${name}: default (strict) mode must reject instead of silently using the fallback`
  );

  // 2. Only with the explicit opt-in does the local separator run — clearly
  //    tagged so it can never be mistaken for AI separation.
  stemEngine.clearCache();
  configure();
  const phases: string[] = [];
  const result = await stemEngine.separateAudioBufferWithModel(
    source, `fallback-${name}`, `sha-${name}`, (progress) => phases.push(progress.phaseText),
    { allowFallback: true }
  );
  assert.equal(result.separationMethod, 'LOCAL_SPECTRAL_FALLBACK', `${name}: local fallback selected`);
  assert.ok(typeof result.fallbackReason === 'string' && result.fallbackReason.length > 0, `${name}: fallback reason recorded`);
  assert.ok(phases.some((phase) => phase.includes('lokale Spektral-Separation')), `${name}: fallback disclosed`);
  let maxDiff = 0;
  for (let i = 0; i < source.length; i++) {
    const sum = STEM_TYPES.reduce((value, stem) => value + result[stem].getChannelData(0)[i], 0);
    maxDiff = Math.max(maxDiff, Math.abs(sum - samples[i]));
  }
  assert.ok(maxDiff < 1e-5, `${name}: outputs reconstruct source`);
  return result;
}

async function run() {
  let separationCalls = 0;
  try {
    await expectFallback('unsupported-python-314', () => {
      (globalThis as unknown as { window: Window }).window = desktop({
        getStemEngineStatus: async () => ({ available: false, reason: 'Python 3.14 wird nicht unterstützt' }),
        separateStems: async () => { separationCalls++; },
      });
    });
    assert.equal(separationCalls, 0, 'unsupported Python detected before inference');

    await expectFallback('status-ipc-rejected', () => {
      (globalThis as unknown as { window: Window }).window = desktop({ getStemEngineStatus: async () => { throw new Error('IPC unavailable'); } });
    });

    await expectFallback('module-disappeared-after-probe', () => {
      (globalThis as unknown as { window: Window }).window = desktop({
        getStemEngineStatus: async () => ({ available: true }),
        separateStems: async () => { throw new Error("No module named 'demucs'"); },
      });
    });

    await expectFallback('browser-network-offline', () => {
      (globalThis as unknown as { window: Window }).window = {} as Window;
      globalThis.fetch = async () => { throw new Error('network offline'); };
    });

    await expectFallback('service-http-503', () => {
      (globalThis as unknown as { window: Window }).window = {} as Window;
      globalThis.fetch = async () => ({
        ok: false, status: 503, json: async () => ({ error: 'model download failed' }),
      } as Response);
    });

    await expectFallback('malformed-service-response', () => {
      (globalThis as unknown as { window: Window }).window = {} as Window;
      globalThis.fetch = async () => ({
        ok: true, status: 200, json: async () => ({ engine: 'not-demucs', stems: {} }),
      } as Response);
    });

    console.log('Stem production fallback matrix: 6 Python/IPC/network/model failure modes passed');
  } finally {
    if (originalWindow === undefined) delete (globalThis as unknown as { window?: Window }).window;
    else (globalThis as unknown as { window: Window }).window = originalWindow;
    globalThis.fetch = originalFetch;
  }
}
run().catch((error) => { console.error(error); process.exit(1); });
