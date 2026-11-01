const { randomUUID } = require('node:crypto');
const { open, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', ...args], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (data) => { output = (output + data).slice(-100000); });
    child.stderr.on('data', (data) => { output = (output + data).slice(-100000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

function registerRecorder({ ipcMain, app, powerSaveBlocker, openFile = open, runEncoder = ffmpeg }) {
  const sessions = new Map();
  const opening = new Set();
  ipcMain.handle('recorder:formats', async () => {
    try {
      const encoders = await runEncoder(['-encoders']);
      return ['WEBM', ...(encoders.includes('pcm_s24le') ? ['WAV'] : []), ...(encoders.includes('libmp3lame') ? ['MP3'] : []), ...(encoders.includes('flac') ? ['FLAC'] : [])];
    } catch { return ['WEBM']; }
  });
  ipcMain.handle('recorder:open', async (event, options = {}) => {
    if (!['WEBM', 'WAV', 'MP3', 'FLAC'].includes(options.format || 'WEBM')) throw new Error('Ungültiges Aufnahmeformat.');
    if (sessions.has(event.sender.id) || opening.has(event.sender.id)) throw new Error('Eine Aufnahme läuft bereits.');
    opening.add(event.sender.id);
    try {
    const directory = path.join(app.getPath('music'), 'AirDox Recordings');
    await mkdir(directory, { recursive: true });
    const name = typeof options.name === 'string' ? options.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) : 'Set';
    const target = path.join(directory, `${name || 'Set'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.webm`);
    const file = await openFile(target, 'wx');
    const blocker = powerSaveBlocker?.start('prevent-app-suspension');
    const release = () => { if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); };
    const state = { file, target, options, release, queue: Promise.resolve() };
    sessions.set(event.sender.id, state);
    event.sender.once('destroyed', () => {
      if (sessions.get(event.sender.id) === state) {
        sessions.delete(event.sender.id);
        void state.queue.finally(async () => { try { await file.close(); } finally { release(); } }).catch(() => {});
      }
    });
    return target;
    } finally { opening.delete(event.sender.id); }
  });
  ipcMain.handle('recorder:append', async (event, bytes) => {
    const state = sessions.get(event.sender.id);
    if (!state) throw new Error('Keine aktive Aufnahme.');
    if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024) throw new Error('Ungültiger Audioblock.');
    state.queue = state.queue.then(async () => {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await state.file.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw new Error('Datenträger schreibt keine Daten.');
        offset += result.bytesWritten;
      }
      await state.file.sync();
    });
    await state.queue;
  });
  ipcMain.handle('recorder:close', async (event) => {
    const state = sessions.get(event.sender.id);
    if (!state) return null;
    sessions.delete(event.sender.id);
    try { await state.queue; await state.file.sync(); } finally { try { await state.file.close(); } finally { state.release(); } }
    if (state.options.format && state.options.format !== 'WEBM') {
      const format = state.options.format;
      const destination = state.target.replace(/\.webm$/, `.${format.toLowerCase()}`);
      const pcm = state.options.bitDepth === 16 ? 'pcm_s16le' : state.options.bitDepth === 32 ? 'pcm_f32le' : 'pcm_s24le';
      const codec = format === 'MP3' ? ['-c:a', 'libmp3lame', '-b:a', '320k'] : format === 'FLAC' ? ['-c:a', 'flac'] : ['-c:a', pcm, '-rf64', 'auto'];
      try {
        await runEncoder(['-n', '-i', state.target, '-vn', ...codec, '-ar', state.options.sampleRate === 44100 ? '44100' : '48000', '-ac', state.options.channels === 'MONO' ? '1' : '2', destination]);
      } catch (error) { throw new Error(`Konvertierung fehlgeschlagen. Originalaufnahme bleibt erhalten: ${state.target}. ${error.message}`); }
      return destination;
    }
    return state.target;
  });
}
module.exports = { registerRecorder, ffmpeg };
