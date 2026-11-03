// Run: electron scripts/recorder-real-roundtrip.cjs
// Loads the REAL production main entry. No custom media/IPC handler, hook harness,
// getDisplayMedia override or supplied input stream. Native consent stays native.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeRecording } = require('./recorder-audio-analysis.cjs');
const directory = path.resolve(__dirname, '../reports/recorder-app-' + new Date().toISOString().replace(/[:.]/g, '-'));
const report = { passed: false, createdAt: new Date().toISOString(), versions: process.versions,
  route: 'Production electron/main.cjs -> App REC button -> RecorderModal -> useRecorder SYSTEM_LOOPBACK -> native production consent -> real Windows loopback -> production preload/IPC -> saved file -> RecorderModal audio playback',
  tone: 'Only AudioContext.destination, gain 0.03, 440 Hz for 3 s between 1 s quiet periods',
  limitations: ['Default Windows system mix; exclusive ASIO and long sessions untested. Playback completion is observed programmatically; no human hearing claim.'] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
const save = async () => { await fs.mkdir(directory,{recursive:true}); await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)); };
const execute = code => target.webContents.executeJavaScript(code,true);
const buttons = () => execute(`Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent.trim(),title:b.title,disabled:b.disabled}))`);
const click = text => execute(`(() => { const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b || b.disabled) throw new Error('Missing/disabled normal UI button: '+${JSON.stringify(text)}); b.click(); })()`);
async function until(predicate,label,timeout=60000) {
  const start=Date.now();while(Date.now()-start<timeout){if(await predicate())return;await wait(200);}throw new Error('Timeout: '+label);
}
async function screenshot(name) { await fs.writeFile(path.join(directory,name+'.png'),(await target.webContents.capturePage()).toPNG()); }
async function capture(withTone) {
  const music = path.join(app.getPath('music'),'AirDox Recordings');
  const before = new Set(await fs.readdir(music).catch(()=>[]));
  await execute(`window.recorderGateMeters=[]; window.addEventListener('airdox-recorder-meter',e=>window.recorderGateMeters.push({at:Date.now(),...e.detail}));`);
  await click('Aufnahme starten');
  report.status='Waiting for native production Systemaudio consent. Confirm in app.'; await save();
  await until(()=>execute(`document.body.innerText.includes('Aufnahme läuft')`),'native consent / recording',120000);
  const startedAt=Date.now();
  await screenshot(withTone?'recording-tone':'recording-control');
  await execute(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms)); await wait(1000);
    ${withTone ? `const context=new AudioContext();await context.resume();const oscillator=context.createOscillator(),gain=context.createGain();gain.gain.value=0.03;oscillator.frequency.value=440;oscillator.connect(gain).connect(context.destination);oscillator.start();await wait(3000);oscillator.stop();await context.close();` : `await wait(3000);`}
    await wait(1000);
  })()`);
  const stoppedAt=Date.now(); await click('Aufnahme stoppen');
  await until(()=>execute(`document.body.innerText.includes('Set gespeichert')`),'normal stop/save');
  await screenshot(withTone?'done-tone':'done-control');
  const created=(await fs.readdir(music)).filter(name=>!before.has(name));
  const wav=created.find(name=>name.endsWith('.wav'));
  if(!wav) throw new Error('No new WAV from production recorder');
  const original=path.join(music,wav), bytes=await fs.readFile(original);
  const retained=path.join(directory,withTone?'system-loopback.wav':'no-tone-control.wav');
  await fs.writeFile(retained,bytes);
  const result={original,retained,sha256:createHash('sha256').update(bytes).digest('hex'),startedAt,stoppedAt,captureSeconds:(stoppedAt-startedAt)/1000,meters:await execute('window.recorderGateMeters'),ui:await execute('document.body.innerText')};
  for(const name of created.filter(name=>name.endsWith('.webm'))) await fs.copyFile(path.join(music,name),path.join(directory,withTone?'system-loopback-original.webm':'no-tone-original.webm'));
  return result;
}
async function run(window) {
  target=window;
  await save();
  try {
    report.hashes={};
    for(const file of ['electron/main.cjs','electron/preload.cjs','electron/recorder.cjs','src/App.tsx','src/features/recorder/useRecorder.ts','src/components/Modals/RecorderModal.tsx','dist/index.html']) {
      report.hashes[file]=createHash('sha256').update(await fs.readFile(path.resolve(__dirname,'..',file))).digest('hex');
    }
    for(const file of await fs.readdir(path.resolve(__dirname,'../dist/assets'))) {
      if(file.endsWith('.js')) report.hashes['dist/assets/'+file]=createHash('sha256').update(await fs.readFile(path.resolve(__dirname,'../dist/assets',file))).digest('hex');
    }
    await until(async()=> (await buttons()).some(b=>b.text==='REC'),'integrated App REC entry');
    report.before=await buttons(); await click('REC');
    await until(async()=> (await buttons()).some(b=>b.text.includes('System Loopback')),'RecorderModal mount');
    // Use rendered source and format buttons; no direct hook access.
    await execute(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Rekordbox / System Loopback')).click()`);
    await until(async()=> (await buttons()).some(b=>b.text==='WAV'&&!b.disabled),'WAV encoder');
    await click('WAV'); await screenshot('idle');
    const toneOnly=process.argv.includes('--tone-only');
    if(!toneOnly) {
      report.control=await capture(false);
      try { analyzeRecording(report.control.retained,{captureSeconds:report.control.captureSeconds}); throw new Error('No-tone control unexpectedly passed the tone gate'); }
      catch(error) { if(!error.analysis)throw error;report.control.analysis=error.analysis; }
    } else {
      report.controlReport=path.resolve(__dirname,'../reports/recorder-app-2026-11-02T14-38-58-878Z/report.json');
      report.control=JSON.parse(await fs.readFile(report.controlReport,'utf8')).control;
      if(!report.control?.retained)throw new Error('Retained no-tone control missing');
      await fs.access(report.control.retained);
    }
    await execute(`window.recorderGateDiagnostics=[];window.addEventListener('airdox-recorder-diagnostic',e=>window.recorderGateDiagnostics.push(e.detail));`);
    report.startClickAt=Date.now();
    await click(toneOnly?'Aufnahme starten':'Neue Aufnahme');
    report.status='CONSENT WAITING: native production Systemaudio dialog';await save();
    // New button already starts; avoid a duplicate start in capture().
    // Stop after consent, then perform the measured tone sequence below.
    await until(()=>execute(`document.body.innerText.includes('Aufnahme läuft')`),'second native consent',120000);
    const startedAt=Date.now();
    report.recordingObservedAt=startedAt;report.status='RECORDING: real tone sequence';await save();
    await execute(`window.recorderGateMeters=[];`);
    await execute(`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));await wait(1000);const context=new AudioContext();await context.resume();const oscillator=context.createOscillator(),gain=context.createGain();gain.gain.value=0.03;oscillator.frequency.value=440;oscillator.connect(gain).connect(context.destination);oscillator.start();await wait(3000);oscillator.stop();await context.close();await wait(1000);})()`);
    const stoppedAt=Date.now();await click('Aufnahme stoppen');
    await until(()=>execute(`document.body.innerText.includes('Set gespeichert')`),'tone stop/save');
    await screenshot('done');
    const music=path.join(app.getPath('music'),'AirDox Recordings');
    const files=await fs.readdir(music);const candidates=await Promise.all(files.filter(n=>n.endsWith('.wav')).map(async name=>({file:path.join(music,name),mtime:(await fs.stat(path.join(music,name))).mtimeMs})));
    const original=candidates.sort((a,b)=>b.mtime-a.mtime)[0]?.file;
    if(!original || original===report.control.original) throw new Error('New tone recording missing');
    const retained=path.join(directory,'system-loopback.wav');const bytes=await fs.readFile(original);await fs.writeFile(retained,bytes);
    report.capture={original,retained,sha256:createHash('sha256').update(bytes).digest('hex'),captureSeconds:(stoppedAt-startedAt)/1000,startedAt,stoppedAt,meters:await execute('window.recorderGateMeters')};
    report.diagnostics=await execute('window.recorderGateDiagnostics');
    await fs.copyFile(original.replace(/\.wav$/,'.webm'),path.join(directory,'system-loopback-original.webm'));
    try { report.analysis=analyzeRecording(retained,{captureSeconds:report.capture.captureSeconds}); }
    catch(error) { report.analysis=error.analysis;throw error; }
    await click('Aufnahme anhören');
    await until(()=>execute(`!!document.querySelector('audio')?.src`),'normal saved-file playback load');
    report.playback=await execute(`(async()=>{const audio=document.querySelector('audio');audio.volume=0.3;const ended=new Promise((resolve,reject)=>{audio.addEventListener('ended',resolve,{once:true});audio.addEventListener('error',()=>reject(new Error('Playback failed')),{once:true});});await audio.play();await ended;return{ended:audio.ended,duration:audio.duration,currentTime:audio.currentTime,source:'RecorderModal audio controls / production readOriginalAudio'};})()`);
    if(!report.playback.ended)throw new Error('Playback did not complete');
    report.passed=true;report.status='Roundtrip passed';
  }catch(error){report.error=error.stack||String(error);report.buttons=await buttons().catch(()=>[]);}
  finally{await save();console.log(JSON.stringify({directory,...report},null,2));app.exit(report.passed?0:1);}
}
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>run(window)));
// Real production entry registers all handlers and creates the actual App window.
require('../electron/main.cjs');
