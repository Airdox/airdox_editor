/**
 * @license
 * Engine and logging units: the code that computes what the UI later shows.
 *
 * These are the "elementary code sections" the waveform depends on — the
 * analysis that produces columns, the WAV encoder that ships them, the transport
 * math behind the playhead, and the log mirror that has to survive a broken
 * desktop bridge. Each is driven directly, with a fake Web Audio clock so time
 * behaviour is asserted instead of waited for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  analyzeAudioBuffer,
  analyzeRangeBuckets,
  detectBeatgridAlignment,
  extractMiniPeaks,
} from '../../src/waveform/analyzer';
import { audioEngine } from '../../src/audio/audioEngine';
import { DataOrigin } from '../../src/types/rekordbox';
import { createFakeAudioBuffer, createIndexedBuffer } from '../helpers/fakeAudioContext';
import { fakeAudio } from '../setup/ui';

const SR = 44100;

function silentBuffer(seconds: number, channels = 2) {
  return createFakeAudioBuffer(channels, Math.round(seconds * SR), SR);
}

describe('analyzeAudioBuffer — local (non-Rekordbox) analysis', () => {
  it('produces ~200 columns per second and a matching bucket width', () => {
    const analysis = analyzeAudioBuffer(createIndexedBuffer(8, SR, 1) as unknown as AudioBuffer);
    expect(analysis.length).toBe(1600);
    expect(analysis.peaks.length).toBe(1600);
    expect(analysis.secPerBucket * analysis.length).toBeCloseTo(8, 1);
    // Column values are normalised heights, never raw samples.
    for (const v of analysis.peaks) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(analysis.peaks.some((v) => v > 0)).toBe(true);
  });

  it('labels the origin it was given (provenance stays visible)', () => {
    const own = analyzeAudioBuffer(createIndexedBuffer(2, SR, 1) as unknown as AudioBuffer, DataOrigin.LOCAL_ANALYSIS);
    expect(own.origin).toBe(DataOrigin.LOCAL_ANALYSIS);
  });

  it('a silent file analyses to silence — no invented contour', () => {
    const analysis = analyzeAudioBuffer(silentBuffer(2) as unknown as AudioBuffer);
    expect(analysis.peaks.every((v) => v === 0)).toBe(true);
    expect(analysis.lowEnergy.every((v) => v === 0)).toBe(true);
    expect(analysis.highEnergy.every((v) => v === 0)).toBe(true);
  });

  it('a mono file mirrors into both channels instead of leaving one empty', () => {
    const analysis = analyzeAudioBuffer(createIndexedBuffer(2, SR, 1, 1) as unknown as AudioBuffer);
    expect(Array.from(analysis.peaksL)).toEqual(Array.from(analysis.peaksR));
  });

  it('a very short file still yields a usable column set', () => {
    const analysis = analyzeAudioBuffer(createFakeAudioBuffer(2, 32, SR) as unknown as AudioBuffer);
    expect(analysis.length).toBeGreaterThanOrEqual(100);
    expect(analysis.secPerBucket).toBeGreaterThan(0);
  });
});

describe('analyzeRangeBuckets / peaks / beat alignment', () => {
  it('buckets exactly the requested window', () => {
    const left = new Float32Array(SR); // one second
    for (let i = 0; i < left.length; i++) left[i] = Math.sin(i / 40);
    const columns = analyzeRangeBuckets({ left, sampleRate: SR }, 0.25, 0.75, 0.05);
    expect(columns.length).toBe(10);
    expect(columns.secPerBucket).toBeCloseTo(0.05, 6);
    expect(columns.samplesPerBucket).toBe(Math.round(0.05 * SR));
  });

  it('clamps an out-of-range window instead of reading past the buffer', () => {
    const left = new Float32Array(SR);
    const columns = analyzeRangeBuckets({ left, sampleRate: SR }, 0.5, 4, 0.05);
    expect(columns.length).toBeGreaterThanOrEqual(1);
    expect(columns.length * columns.secPerBucket).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('tolerates an inverted or empty window', () => {
    const left = new Float32Array(SR);
    const columns = analyzeRangeBuckets({ left, sampleRate: SR }, 0.8, 0.2, 0.05);
    expect(columns.length).toBeGreaterThanOrEqual(1);
    const zeroRate = analyzeRangeBuckets({ left, sampleRate: 0 }, 0, 1, 0);
    expect(zeroRate.length).toBeGreaterThanOrEqual(1);
  });

  it('extractMiniPeaks returns the requested number of normalised columns', () => {
    const buffer = createIndexedBuffer(3, 1000, 1) as unknown as AudioBuffer;
    const peaks = extractMiniPeaks(buffer, 48);
    expect(peaks.length).toBe(48);
    expect(peaks.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('detectBeatgridAlignment stays inside the searched neighbourhood', () => {
    const buffer = createIndexedBuffer(6, SR, 1) as unknown as AudioBuffer;
    const first = detectBeatgridAlignment(buffer, 120, 0);
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(-0.5);
    expect(first).toBeLessThanOrEqual(buffer.duration);
  });
});

describe('audioEngine — transport, slicing, checksum, WAV export', () => {
  beforeEach(() => {
    fakeAudio.currentTime = 0;
    audioEngine.stop();
  });

  afterEach(() => {
    audioEngine.stop();
    vi.restoreAllMocks();
  });

  it('plays on the audio clock and pauses at the position it reached', () => {
    const buffer = createIndexedBuffer(8, SR, 1) as unknown as AudioBuffer;
    audioEngine.play(buffer, 0);
    expect(audioEngine.getIsPlaying()).toBe(true);
    fakeAudio.advance(3);
    expect(audioEngine.getCurrentTime()).toBeCloseTo(3, 6);
    const at = audioEngine.pause();
    expect(at).toBeCloseTo(3, 6);
    expect(audioEngine.getIsPlaying()).toBe(false);
    expect(audioEngine.getCurrentTime()).toBeCloseTo(3, 6);
  });

  it('a looped region wraps the playhead instead of running past the loop', () => {
    const buffer = createIndexedBuffer(8, SR, 1) as unknown as AudioBuffer;
    audioEngine.play(buffer, 0, true, 2, 4);
    fakeAudio.advance(7);
    const pos = audioEngine.getCurrentTime();
    expect(pos).toBeGreaterThanOrEqual(2);
    expect(pos).toBeLessThan(4);
  });

  it('the started source carries the requested offset', () => {
    const buffer = createIndexedBuffer(8, SR, 1) as unknown as AudioBuffer;
    const before = fakeAudio.sources.length;
    audioEngine.play(buffer, 1.5);
    const source = fakeAudio.sources[before];
    expect(source.startedOffset).toBeCloseTo(1.5, 6);
    expect(fakeAudio.sources.length).toBe(before + 1);
  });

  it('sliceAudioBuffer copies the requested window out of the original', () => {
    const buffer = createIndexedBuffer(4, 1000, 1) as unknown as AudioBuffer;
    const sliced = audioEngine.sliceAudioBuffer(buffer, 1, 3);
    expect(sliced.duration).toBeCloseTo(2, 6);
    const src = buffer.getChannelData(0);
    const dst = sliced.getChannelData(0);
    for (let i = 0; i < 100; i++) {
      expect(dst[i]).toBe(src[1000 + i]);
    }
  });

  it('the checksum is stable per buffer and differs between them', () => {
    const a = audioEngine.computeBufferChecksum(createIndexedBuffer(2, 1000, 1) as unknown as AudioBuffer);
    const b = audioEngine.computeBufferChecksum(createIndexedBuffer(2, 1000, 1) as unknown as AudioBuffer);
    const c = audioEngine.computeBufferChecksum(createIndexedBuffer(2, 1000, 0.5) as unknown as AudioBuffer);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('sha256-')).toBe(true);
  });

  it('exports 16-bit stereo PCM WAV whose size follows the sample count', async () => {
    const buffer = createIndexedBuffer(1, 1000, 1) as unknown as AudioBuffer;
    const blob = await audioEngine.exportToWavBlob(buffer).arrayBuffer();
    const bytes = new Uint8Array(blob);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(36, 4)).toBe('data');
    // 1000 samples × 2 channels × 2 bytes + the 44-byte header.
    expect(blob.byteLength).toBe(44 + 1000 * 2 * 2);
    // RIFF size field = file size − 8.
    const view = new DataView(blob);
    expect(view.getUint32(4, true)).toBe(blob.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(1000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bit depth
  });

  it('reports master level without throwing when nothing plays', () => {
    const meter = audioEngine.getMasterMeter();
    expect(meter).toHaveProperty('left');
    expect(meter).toHaveProperty('peak');
  });

  it('a rejected log write never surfaces as an app error', async () => {
    // The mirror in fileLog must swallow bridge failures; a throwing appendLog
    // would otherwise turn logging into a crash source.
    const { logger } = await import('../../src/utils/logger');
    expect(() => logger.info('SYSTEM', 'Engine-Testeintrag')).not.toThrow();
  });
});

describe('Datei-Logging (fileLog bridge)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as unknown as { rekordboxDesktop?: unknown }).rekordboxDesktop;
  });

  afterEach(() => {
    delete (window as unknown as { rekordboxDesktop?: unknown }).rekordboxDesktop;
  });

  it('degrades to a no-op notice without the desktop bridge', async () => {
    const [{ initFileLogging }, { logger }] = await Promise.all([
      import('../../src/utils/fileLog'),
      import('../../src/utils/logger'),
    ]);
    const before = logger.getEntries().length;
    const stop = initFileLogging();
    expect(typeof stop).toBe('function');
    const note = logger.getEntries().slice(before).map((e) => e.message).join(' ');
    expect(note).toContain('Datei-Logging nicht verfügbar');
    expect(() => logger.warn('SYSTEM', 'Eintrag ohne Bridge')).not.toThrow();
    stop();
  });

  it('mirrors every entry into the durable file and stops on unsubscribe', async () => {
    const appended: Array<Record<string, unknown>> = [];
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = {
      appendLog: async (entry: Record<string, unknown>) => {
        appended.push(entry);
      },
      getLogFilePath: async () => 'C:/Users/dj/airdox-smart-editor.log',
    };
    const [{ initFileLogging }, { logger }] = await Promise.all([
      import('../../src/utils/fileLog'),
      import('../../src/utils/logger'),
    ]);
    const stop = initFileLogging();
    logger.error('DATABASE', 'ANLZ fehlt für Track X', { code: 'MISSING_REKORDBOX_ANALYSIS' });
    await Promise.resolve();
    await Promise.resolve();
    expect(appended.length).toBeGreaterThan(0);
    const mirrored = appended.find((e) => e.message === 'ANLZ fehlt für Track X');
    expect(mirrored).toBeTruthy();
    expect(mirrored!.level).toBe('ERROR');
    expect(mirrored!.category).toBe('DATABASE');
    // The activation note is itself part of the durable log — the file explains
    // its own existence when the user opens it later.
    expect(appended.some((e) => String(e.message).includes('Datei-Logging aktiv'))).toBe(true);
    // The activation note names the file the user has to open for support.
    expect(logger.getEntries().some((e) => e.message.includes('airdox-smart-editor.log'))).toBe(true);
    stop();
    const count = appended.length;
    logger.info('SYSTEM', 'nach dem Abmelden');
    await Promise.resolve();
    expect(appended.length).toBe(count);
  });

  it('a rejecting bridge never throws into the app', async () => {
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = {
      appendLog: () => Promise.reject(new Error('Schreibfehler')),
      getLogFilePath: () => Promise.reject(new Error('kein Pfad')),
    };
    const [{ initFileLogging }, { logger }] = await Promise.all([
      import('../../src/utils/fileLog'),
      import('../../src/utils/logger'),
    ]);
    const stop = initFileLogging();
    expect(() => logger.info('SYSTEM', 'trotz Ablehnung')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop();
  });
});
