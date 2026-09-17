/**
 * Test des Stem-Separations-Services der Oberfläche (src/audio/stemSeparation.ts).
 *
 * Das ist der Pfad, der vorher komplett tot war: Ohne Electron (Browser,
 * Dev-Preview) gab es nur die Meldung „Desktop Bridge nicht gefunden“, und in
 * der Desktop-App führte eine fehlende Python-CLI zu einem harten Abbruch.
 * Geprüft wird deshalb die komplette Kette inkl. sichtbarem Fallback:
 *   trainierte CLI (Desktop) → eingebaute DSP-Heuristik (immer).
 */
import assert from 'node:assert/strict';
import {
  audioBufferToDspAudio,
  isUsableLocalPath,
  separateStemsAuto,
  separateStemsBuiltin,
  type StemDesktopBridge,
  type StemProgress,
} from '../src/audio/stemSeparation';
import { decodeWav, encodeWavFloat32 } from '../src/stems/wavIo';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`[ PASS ] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[ FAIL ] ${name}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// --- Minimal-Fakes für die Web-Audio-Schnittstelle -------------------------
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(index: number): Float32Array {
    return this.data[index];
  }
}

function createFakeContext(): BaseAudioContext {
  return {
    createBuffer: (channels: number, length: number, sampleRate: number) => new FakeAudioBuffer(channels, length, sampleRate),
    decodeAudioData: (bytes: ArrayBuffer, onSuccess?: (buffer: FakeAudioBuffer) => void, onError?: (error: unknown) => void) => {
      try {
        const wav = decodeWav(new Uint8Array(bytes));
        const buffer = new FakeAudioBuffer(wav.channels, wav.frames, wav.sampleRate);
        for (let f = 0; f < wav.frames; f++) {
          for (let c = 0; c < wav.channels; c++) buffer.getChannelData(c)[f] = wav.data[f * wav.channels + c] || 0;
        }
        onSuccess?.(buffer);
        return Promise.resolve(buffer);
      } catch (error) {
        onError?.(error);
        return Promise.reject(error);
      }
    },
  } as unknown as BaseAudioContext;
}

/** Zwei Sekunden Testmaterial: mittige „Vocals“ + tiefe, perkussive „Kick“. */
function createTestBuffer(sampleRate = 44100, seconds = 2, channels = 2): FakeAudioBuffer {
  const buffer = new FakeAudioBuffer(channels, Math.floor(sampleRate * seconds), sampleRate);
  for (let f = 0; f < buffer.length; f++) {
    const t = f / sampleRate;
    const beat = t % 0.5;
    const kick = Math.sin(2 * Math.PI * (140 * Math.exp(-beat * 30) + 45) * beat) * Math.exp(-beat * 12) * 0.8;
    const vocal = Math.sin(2 * Math.PI * 320 * t) * 0.4 + Math.sin(2 * Math.PI * 640 * t) * 0.2;
    const side = Math.sin(2 * Math.PI * 2200 * t) * 0.15;
    const left = kick + vocal * 0.9 + side;
    const right = kick + vocal * 0.9 - side;
    for (let c = 0; c < channels; c++) {
      const value = channels === 1 ? left : c === 0 ? left : c === 1 ? right : (left + right) / 2;
      buffer.getChannelData(c)[f] = value;
    }
  }
  return buffer;
}

function createDesktopBridge(options: {
  available: boolean;
  files?: string[];
  failWith?: Error;
  calls?: string[];
}): StemDesktopBridge {
  const sampleRate = 44100;
  const frames = 1024;
  return {
    async separatorStatus() {
      options.calls?.push('status');
      return options.available
        ? { available: true, command: '/usr/local/bin/audio-separator' }
        : { available: false, command: null, reason: 'audio-separator nicht im PATH', hint: 'pip install "audio-separator[cpu]"' };
    },
    async separateStems(inputPath: string) {
      options.calls?.push(`separate:${inputPath}`);
      if (options.failWith) throw options.failWith;
      return options.files ?? [];
    },
    async readOriginalAudio(location: string) {
      options.calls?.push(`read:${location}`);
      const data = new Float32Array(frames * 2);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 40) * 0.3;
      const bytes = encodeWavFloat32(sampleRate, 2, data, frames);
      const arrayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(arrayBuffer).set(bytes);
      return { data: arrayBuffer, path: location };
    },
  };
}

async function run(): Promise<void> {
  await test('#1 Pfadprüfung: nur echte lokale Pfade gehen an den Main-Prozess', () => {
    assert.equal(isUsableLocalPath('C:\\Music\\Track.wav'), true);
    assert.equal(isUsableLocalPath('/home/dj/Music/Track.wav'), true);
    assert.equal(isUsableLocalPath('\\\\nas\\music\\track.wav'), true);
    assert.equal(isUsableLocalPath('Track.wav'), false, 'Nur ein Dateiname ist kein Pfad');
    assert.equal(isUsableLocalPath('blob:http://localhost/uuid'), false);
    assert.equal(isUsableLocalPath('data:audio/wav;base64,AAA'), false);
    assert.equal(isUsableLocalPath('https://example.org/a.wav'), false);
    assert.equal(isUsableLocalPath(null), false);
    assert.equal(isUsableLocalPath('   '), false);
  });

  await test('#2 AudioBuffer → DSP-Audio: Stereo bleibt Stereo, 6 Kanäle werden erklärt', () => {
    const stereo = audioBufferToDspAudio(createTestBuffer(44100, 0.2, 2) as unknown as AudioBuffer);
    assert.equal(stereo.audio.channels, 2);
    assert.equal(stereo.audio.frames, stereo.audio.data.length / 2);
    assert.deepEqual(stereo.notes, []);

    const surround = audioBufferToDspAudio(createTestBuffer(44100, 0.2, 6) as unknown as AudioBuffer);
    assert.equal(surround.audio.channels, 2);
    assert.ok(surround.notes.some((note) => /6 Kanäle/.test(note)), 'Kanal-Reduktion muss dokumentiert werden');
  });

  await test('#3 Browser ohne Desktop-Bridge: interne Heuristik liefert 4 abspielbare Stems', async () => {
    const context = createFakeContext();
    const buffer = createTestBuffer() as unknown as AudioBuffer;
    const progressEntries: StemProgress[] = [];
    const result = await separateStemsAuto({
      context,
      buffer,
      sourcePath: null,
      desktop: null,
      onProgress: (entry) => progressEntries.push(entry),
    });
    assert.equal(result.engine, 'builtin');
    assert.equal(result.trainedModel, false);
    assert.equal(result.qualityTier, 'HEURISTIC');
    assert.deepEqual(result.ids, ['vocals', 'drums', 'bass', 'other']);
    assert.deepEqual(result.labels, ['Vocals', 'Drums', 'Bass', 'Inst']);
    assert.equal(result.buffers.length, 4);
    for (const stem of result.buffers) {
      assert.equal(stem.length, buffer.length);
      assert.equal(stem.numberOfChannels, 2);
      assert.ok(Number.isFinite(stem.getChannelData(0)[Math.floor(buffer.length / 2)]));
    }
    assert.ok(result.fallbackReasons.some((reason) => /Desktop-Bridge fehlt/.test(reason)), 'Fallback-Grund fehlt (kein stiller Fallback)');
    assert.ok(progressEntries.length >= 2, 'Fortschritt muss gemeldet werden');
    assert.equal(progressEntries[progressEntries.length - 1].phase, 'done');
    assert.ok((result.recombinationMaxError ?? 1) < 1e-9);
  });

  await test('#4 Desktop ohne installierte CLI: sichtbarer Fallback auf die Heuristik', async () => {
    const calls: string[] = [];
    const result = await separateStemsAuto({
      context: createFakeContext(),
      buffer: createTestBuffer(44100, 1) as unknown as AudioBuffer,
      sourcePath: '/music/Track.wav',
      desktop: createDesktopBridge({ available: false, calls }),
    });
    assert.equal(result.engine, 'builtin');
    assert.ok(result.fallbackReasons.some((reason) => /nicht im PATH/.test(reason)));
    assert.deepEqual(calls, ['status'], 'Ohne CLI darf kein Separator-Lauf gestartet werden');
  });

  await test('#5 Desktop mit CLI-Fehler: Fallback meldet die Ursache', async () => {
    const result = await separateStemsAuto({
      context: createFakeContext(),
      buffer: createTestBuffer(44100, 1) as unknown as AudioBuffer,
      sourcePath: '/music/Track.wav',
      desktop: createDesktopBridge({ available: true, failWith: new Error('SEPARATOR_NOT_INSTALLED: audio-separator fehlt') }),
    });
    assert.equal(result.engine, 'builtin');
    assert.ok(result.fallbackReasons.some((reason) => /SEPARATOR_NOT_INSTALLED/.test(reason)));
  });

  await test('#6 Desktop mit trainiertem Modell: 2 Stems korrekt benannt und geladen', async () => {
    const calls: string[] = [];
    const files = ['/out/Track (Vocals) MDX.wav', '/out/Track (Instrumental) MDX.wav'];
    const result = await separateStemsAuto({
      context: createFakeContext(),
      buffer: createTestBuffer(44100, 1) as unknown as AudioBuffer,
      sourcePath: '/music/Track.wav',
      desktop: createDesktopBridge({ available: true, files, calls }),
      model: { id: 'mdxnet-inst-hq3', fileName: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
    });
    assert.equal(result.engine, 'desktop');
    assert.equal(result.trainedModel, true);
    assert.equal(result.qualityTier, 'TRAINED');
    assert.deepEqual(result.ids, ['vocals', 'other']);
    assert.deepEqual(result.labels, ['Vocals', 'Inst']);
    assert.deepEqual(result.paths, files);
    assert.equal(result.buffers.length, 2);
    assert.equal(result.buffers[0].length, 1024);
    assert.ok(calls.includes('separate:/music/Track.wav'));
    assert.ok(calls.some((call) => call.startsWith('read:/out/Track (Vocals)')));
    assert.deepEqual(result.fallbackReasons, []);
  });

  await test('#7 Desktop ohne echten Pfad: Heuristik statt fehlerhaftem IPC-Aufruf', async () => {
    const calls: string[] = [];
    const result = await separateStemsAuto({
      context: createFakeContext(),
      buffer: createTestBuffer(44100, 1) as unknown as AudioBuffer,
      sourcePath: 'Track.wav', // typischer Browser-Import: nur der Dateiname
      desktop: createDesktopBridge({ available: true, files: ['/out/a.wav'], calls }),
    });
    assert.equal(result.engine, 'builtin');
    assert.ok(result.fallbackReasons.some((reason) => /echter lokaler Dateipfad/.test(reason)));
    assert.ok(!calls.some((call) => call.startsWith('separate:')), 'IPC darf ohne echten Pfad nicht aufgerufen werden');
  });

  await test('#8 Ausdrücklich gewählte Heuristik überspringt die externe Inferenz', async () => {
    const calls: string[] = [];
    const result = await separateStemsAuto({
      context: createFakeContext(),
      buffer: createTestBuffer(44100, 1) as unknown as AudioBuffer,
      sourcePath: '/music/Track.wav',
      desktop: createDesktopBridge({ available: true, files: ['/out/a.wav'], calls }),
      preferBuiltin: true,
    });
    assert.equal(result.engine, 'builtin');
    assert.ok(result.fallbackReasons.some((reason) => /ausdrücklich/.test(reason)));
    assert.deepEqual(calls, []);
  });

  await test('#9 Abbruch beendet die Separation, statt halbe Stems zu liefern', async () => {
    await assert.rejects(
      separateStemsBuiltin({
        context: createFakeContext(),
        buffer: createTestBuffer(44100, 3) as unknown as AudioBuffer,
        isCancelled: () => true,
      }),
      /abgebrochen/i
    );
  });

  console.log(`\nstem-separation-service: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
