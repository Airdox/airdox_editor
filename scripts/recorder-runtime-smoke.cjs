const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { registerRecorder, ffmpeg } = require('../electron/recorder.cjs');

app.whenReady().then(async () => {
  const mandatoryLoopback = process.argv.includes('--require-loopback');
  const directory = await mkdtemp(path.join(tmpdir(), 'airdox-runtime-'));
  const timer = setTimeout(() => { console.error('Recorder runtime timeout'); app.exit(1); }, 180000);
  let window;
  try {
    registerRecorder({ ipcMain, app: { getPath: () => directory } });
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const page = path.join(directory, 'recorder-test.html');
    await writeFile(page, '<!doctype html><title>AirDox Recorder Runtime Test</title>');
    await window.loadFile(page);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const formats = await window.airdoxRecorder.formats();
      const results = [];
      for (const format of formats) {
        await window.airdoxRecorder.open({ format, sampleRate: 48000, channels: 'STEREO' });
        const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 320000 });
        let queue = Promise.resolve();
        let chunks = 0;
        recorder.ondataavailable = (event) => {
          chunks++;
          queue = queue.then(async () => window.airdoxRecorder.append(new Uint8Array(await event.data.arrayBuffer())));
        };
        recorder.start(100);
        await new Promise(resolve => setTimeout(resolve, 700));
        await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
        await queue;
        results.push({ format, chunks, state: recorder.state, path: await window.airdoxRecorder.close() });
      }
      oscillator.stop();
      destination.stream.getTracks().forEach(track => track.stop());
      await context.close();
      return results;
    })()`);
    if (process.platform === 'win32') {
      console.log('Synthetic MediaRecorder captures complete; checking Windows loopback');
      session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        callback({ video: request.frame, audio: 'loopback' });
      });
      try {
      const loopback = await Promise.race([window.webContents.executeJavaScript(`(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!stream.getAudioTracks().length) throw new Error('No system loopback audio track');
        await window.airdoxRecorder.open({ format: 'WEBM', sampleRate: 48000, channels: 'STEREO' });
        const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus' });
        let queue = Promise.resolve();
        let chunks = 0;
        recorder.ondataavailable = event => { chunks++; queue = queue.then(async () => window.airdoxRecorder.append(new Uint8Array(await event.data.arrayBuffer()))); };
        recorder.start(100);
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.03;
        oscillator.frequency.value = 440;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        await new Promise(resolve => setTimeout(resolve, 700));
        oscillator.stop();
        await context.close();
        await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
        await queue;
        stream.getTracks().forEach(track => track.stop());
        return { format: 'SYSTEM_LOOPBACK_WEBM', chunks, state: recorder.state, path: await window.airdoxRecorder.close() };
      })()`, true), new Promise((_, reject) => setTimeout(() => reject(new Error('Windows loopback capture timed out after 15 seconds')), 15000))]);
      result.push(loopback);
      } catch (error) { if (mandatoryLoopback) throw error; console.error(`Loopback unavailable (optional smoke only): ${error.message}`); }
    }
    if (mandatoryLoopback && !result.some(item => item.format === 'SYSTEM_LOOPBACK_WEBM')) throw new Error('Mandatory Windows loopback recording missing');
    for (const recording of result) {
      if (recording.chunks < 2 || recording.state !== 'inactive') throw new Error('Recorder did not emit streaming chunks or stop');
      const signal = await ffmpeg(['-i', recording.path, '-af', 'bandpass=f=440:width_type=h:w=100,volumedetect', '-f', 'null', '-']);
      const meanDb = Number(signal.match(/mean_volume: ([-0-9.]+) dB/)?.[1]);
      if (!(meanDb > -65)) throw new Error(`No test tone in ${recording.format}: ${meanDb} dB`);
      recording.testToneDb = meanDb;
    }
    console.log(JSON.stringify({ passed: true, recordings: result }, null, 2));
    process.exitCode = 0;
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(timer);
    window?.destroy();
    await rm(directory, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
