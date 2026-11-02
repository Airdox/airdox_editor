const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { registerRecorder, ffmpeg } = require('../electron/recorder.cjs');

app.whenReady().then(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'airdox-hook-'));
  const deadline = setTimeout(() => app.exit(1), 180000);
  let window;
  try {
    registerRecorder({ ipcMain, app: { getPath: () => directory } });
    await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { useRecorder } from './src/features/recorder/useRecorder'; import { audioEngine } from './src/audio/audioEngine'; window.startTestTone = () => { const context = audioEngine.getContext(); const buffer = context.createBuffer(2, context.sampleRate * 3, context.sampleRate); for (let channel = 0; channel < 2; channel++) { const samples = buffer.getChannelData(channel); for (let frame = 0; frame < samples.length; frame++) samples[frame] = 0.1 * Math.sin(2 * Math.PI * 440 * frame / context.sampleRate); } audioEngine.masterLimiter.disconnect(context.destination); audioEngine.play(buffer); }; window.stopTestTone = () => audioEngine.stop(); function Harness() { const recorder = useRecorder({ activeTrack: null, recordingSource: 'EDITOR_MASTER', protectedPaths: [], showOperationFeedback: () => {}, setChatbotOpen: () => {}, recordingFormat: 'WEBM', recordingSampleRate: 48000, recordingBitDepth: 24, recordingChannels: 'STEREO', recordingLimiter: false }); window.recorderHook = recorder; React.useEffect(() => { (window.recorderHistory ||= []).push(recorder.recorderStage); }, [recorder.recorderStage]); return null; } createRoot(document.getElementById('root')).render(React.createElement(Harness));`, resolveDir: path.resolve(__dirname, '..'), loader: 'tsx' }, bundle: true, platform: 'browser', outfile: path.join(directory, 'hook.js') });
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><div id="root"></div><script src="./hook.js"></script>');
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadFile(path.join(directory, 'index.html'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const tick = () => new Promise(resolve => setTimeout(resolve, 50));
      const stage = async expected => { for (let attempt = 0; attempt < 200; attempt++) { if (window.recorderHook?.recorderStage === expected) return; await tick(); } throw new Error('Expected stage ' + expected + ', got ' + window.recorderHook?.recorderStage); };
      await stage('IDLE');
      window.recorderHook.setRecorderPreRoll(0);
      await tick();
      await Promise.all([window.recorderHook.handleRecorderStart(), window.recorderHook.handleRecorderStart()]);
      await stage('RECORDING');
      window.startTestTone();
      await new Promise(resolve => setTimeout(resolve, 1300));
      if (window.recorderHook.recorderElapsed <= 0) throw new Error('Clock did not advance');
      await window.recorderHook.handleRecorderStop();
      await stage('DONE');
      window.stopTestTone();
      const saved = window.recorderHook.recorderSavedPath;
      if (!saved) throw new Error('No saved recording');
      window.recorderHook.openRecorder();
      window.recorderHook.setRecorderSource('AUDIO_INPUT');
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied (test)', 'NotAllowedError'); };
      await tick();
      await window.recorderHook.handleRecorderStart();
      await stage('ERROR');
      if (!window.recorderHook.recorderError.includes('Permission denied')) throw new Error('Permission error missing');
      window.recorderHook.openRecorder();
      window.recorderHook.setRecorderSource('EDITOR_MASTER');
      window.recorderHook.setRecorderPreRoll(3);
      await tick();
      await window.recorderHook.handleRecorderStart();
      await stage('PREROLL');
      await window.recorderHook.handleRecorderStop();
      await stage('IDLE');
      await new Promise(resolve => setTimeout(resolve, 3200));
      if (window.recorderHook.recorderStage !== 'IDLE') throw new Error('Cancelled capture started later');
      return { passed: true, saved, states: window.recorderHistory, doubleStart: 'prevented', permissionError: 'visible', prerollCancel: 'passed', clock: 'advances' };
    })()`);
    const signal = await ffmpeg(['-i', result.saved, '-af', 'volumedetect', '-f', 'null', '-']);
    if (!(Number(signal.match(/mean_volume: ([-0-9.]+) dB/)?.[1]) > -50)) throw new Error('Internal master recording has no test signal');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(deadline); window?.destroy(); await rm(directory, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});
