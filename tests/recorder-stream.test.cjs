const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerRecorder, ffmpeg } = require('../electron/recorder.cjs');

async function run() {
  const directory = await mkdtemp(path.join(tmpdir(), 'airdox-recorder-'));
  try {
    const handlers = new Map();
    registerRecorder({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app: { getPath: () => directory } });
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const event = { sender };
    const invoke = (name, ...args) => handlers.get(`recorder:${name}`)(event, ...args);
    const stranger = { sender: Object.assign(new EventEmitter(), { id: 2 }) };
    await assert.rejects(handlers.get('recorder:append')(stranger, new Uint8Array([9])), /Keine aktive/);
    const formats = await invoke('formats');
    for (const missing of [false, true]) {
      const unavailable = new Map();
      registerRecorder({ ipcMain: { handle: (name, handler) => unavailable.set(name, handler) }, app: { getPath: () => directory }, runEncoder: async () => { if (missing) throw new Error('Encoder missing'); return ''; } });
      assert.deepEqual(await unavailable.get('recorder:formats')(), ['WEBM']);
    }
    assert.ok(formats.includes('WEBM'));
    await assert.rejects(invoke('open', { format: 'INVALID' }), /Ungültiges/);
    await assert.rejects(invoke('append', new Uint8Array([1])), /Keine aktive/);
    const target = await invoke('open');
    await assert.rejects(invoke('open'), /bereits/);
    await assert.rejects(invoke('append', 'invalid'), /Ungültiger/);
    await assert.rejects(invoke('append', new Uint8Array(8 * 1024 * 1024 + 1)), /Ungültiger/);
    await Promise.all([invoke('append', new Uint8Array([1, 2])), invoke('append', new Uint8Array([3, 4]))]);
    assert.equal(await invoke('close'), target);
    assert.deepEqual([...await readFile(target)], [1, 2, 3, 4]);
    assert.equal(await invoke('close'), null);
    const second = await invoke('open');
    assert.notEqual(target, second);
    await invoke('append', new Uint8Array([5]));
    sender.emit('destroyed');
    await assert.rejects(invoke('append', new Uint8Array([6])), /Keine aktive/);
    assert.deepEqual([...await readFile(second)], [5]);
    for (const zeroWrite of [true, false]) {
      const faultHandlers = new Map();
      let closed = false;
      let blocked = false;
      registerRecorder({
        ipcMain: { handle: (name, handler) => faultHandlers.set(name, handler) },
        app: { getPath: () => directory },
        powerSaveBlocker: { start: () => { blocked = true; return 1; }, isStarted: () => blocked, stop: () => { blocked = false; } },
        openFile: async () => ({ write: async () => { if (!zeroWrite) throw new Error('ENOSPC'); return { bytesWritten: 0 }; }, sync: async () => {}, close: async () => { closed = true; } }),
      });
      const fault = (name, ...args) => faultHandlers.get(`recorder:${name}`)(event, ...args);
      await fault('open');
      assert.equal(blocked, true);
      await assert.rejects(fault('append', new Uint8Array([1])), zeroWrite ? /keine Daten/ : /ENOSPC/);
      await assert.rejects(fault('close'), zeroWrite ? /keine Daten/ : /ENOSPC/);
      assert.equal(closed, true);
      assert.equal(blocked, false);
    }
    if (formats.includes('MP3')) {
      const fixture = path.join(directory, 'tone.webm');
      await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', fixture]);
      const bytes = await readFile(fixture);
      for (const format of formats) {
        const capture = await invoke('open', { format, sampleRate: format === 'FLAC' ? 44100 : 48000, channels: format === 'FLAC' ? 'MONO' : 'STEREO', name: '../test:recording' });
        for (let offset = 0; offset < bytes.length; offset += 1024) await invoke('append', new Uint8Array(bytes.subarray(offset, offset + 1024)));
        const saved = await invoke('close');
        assert.ok((await readFile(saved)).length > 100);
        assert.ok((await readFile(capture)).length > 100);
        const signal = await ffmpeg(['-i', saved, '-af', 'volumedetect', '-f', 'null', '-']);
        assert.ok(Number(signal.match(/mean_volume: ([-\d.]+) dB/)?.[1]) > -50, 'Persisted recording must contain the test tone');
        console.log(`Synthetic 440 Hz capture: ${format} persisted and decoded successfully`);
      }
      await invoke('open', { format: 'MP3' });
      await invoke('append', new Uint8Array([1, 2, 3]));
      await assert.rejects(invoke('close'), /Originalaufnahme bleibt erhalten/);
    } else console.log('FFmpeg conversion tests skipped: encoder unavailable');
    console.log('Recorder streaming: ordered persistent writes, isolation, validation, close and renderer loss passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
