const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { analyzeRecording } = require('../scripts/recorder-audio-analysis.cjs');
const directory = mkdtempSync(path.join(tmpdir(), 'recorder-negative-'));
// These generated WAVs test only verifier rejection. They are NEVER hardware-gate input.
function fixture(name, frequency) {
  const rate=48000, frames=rate*5, data=Buffer.alloc(44+frames*4);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
  for(let i=rate;i<rate*4;i++) for(let c=0;c<2;c++) data.writeInt16LE(frequency ? Math.round(3000*Math.sin(2*Math.PI*frequency*i/rate)) : 0,44+i*4+c*2);
  const file=path.join(directory,name);writeFileSync(file,data);return file;
}
try {
  assert.throws(()=>analyzeRecording(path.join(directory,'missing.wav'),{captureSeconds:5}),/ENOENT/);
  assert.throws(()=>analyzeRecording('unused',{captureSucceeded:false,captureSeconds:5}),/Capture did not succeed/);
  assert.throws(()=>analyzeRecording(fixture('silent.wav',0),{captureSeconds:5}),/silence/);
  assert.throws(()=>analyzeRecording(fixture('wrong.wav',880),{captureSeconds:5}),/wrong frequency/);
  const valid=fixture('verifier-positive-only.wav',440);
  assert.equal(analyzeRecording(valid,{captureSeconds:5}).passed,true);
  assert.throws(()=>analyzeRecording(valid,{captureSeconds:10}),/duration mismatch/);
  console.log('Verifier controls PASS: missing file, failed capture, silence, 880 Hz, duration mismatch rejected; isolated 440 Hz verifier fixture accepted. No hardware-gate claim.');
} finally { rmSync(directory,{recursive:true,force:true}); }
