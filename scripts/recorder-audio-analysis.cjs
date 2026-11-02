const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

function command(executable, args) {
  const result = spawnSync(executable, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed: ${result.error || result.stderr.toString()}`);
  return result.stdout;
}
function analyzeRecording(file, { captureSeconds, captureSucceeded = true } = {}) {
  if (!captureSucceeded) throw new Error('Capture did not succeed');
  const original = readFileSync(file); // Missing files must fail, never substitute a fixture.
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const stream = probe.streams.find(s => s.codec_type === 'audio');
  if (!stream) throw new Error('No audio stream');
  const raw = command('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ar', '48000', '-f', 'f32le', '-']);
  const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const channels = stream.channels, rate = 48000, frames = samples.length / channels;
  const duration = frames / rate;
  if (!Number.isFinite(captureSeconds) || captureSeconds <= 0) throw new Error('Measured capture duration required');
  const errors = [];
  if (duration < 4.8 || Math.abs(duration - captureSeconds) > Math.max(0.5, captureSeconds * 0.1)) errors.push('duration mismatch');
  const measurements = [];
  for (let channel = 0; channel < channels; channel++) {
    const signal = Float32Array.from({ length: frames }, (_, i) => samples[i * channels + channel]);
    const metrics = (start, end) => {
      let sum = 0, peak = 0, clipped = 0;
      const first = Math.floor(start * rate), last = Math.min(signal.length, Math.floor(end * rate));
      for (let i=first;i<last;i++) { const x=signal[i]; sum+=x*x; peak=Math.max(peak,Math.abs(x)); if(Math.abs(x)>=0.999) clipped++; }
      const count = last-first, rms = Math.sqrt(sum/count);
      return { frames: count, rms, rmsDbfs: rms>0 ? 20*Math.log10(rms) : -Infinity, peak, clippedSamples: clipped };
    };
    // Analyze a settled 4096-sample Hann window within the 3 s tone.
    const power = (frequency, offset) => {
      let real=0, imaginary=0;
      for(let j=0;j<4096;j++) { const x=signal[offset+j]*(0.5-0.5*Math.cos(2*Math.PI*j/4095)); const angle=2*Math.PI*frequency*j/rate; real+=x*Math.cos(angle); imaginary+=x*Math.sin(angle); }
      return real*real+imaginary*imaginary;
    };
    let dominantHz=0, maximum=0;
    for(let hz=80;hz<=2000;hz++) { const p=power(hz,Math.floor(2*rate)); if(p>maximum) {maximum=p;dominantHz=hz;} }
    const tonePower = power(440, Math.floor(2*rate));
    const quietPower = Math.max(power(440, Math.floor(0.3*rate)), power(440, Math.floor(4.5*rate)));
    const toneBandContrastDb = 10*Math.log10(Math.max(tonePower,1e-30)/Math.max(quietPower,1e-30));
    const full=metrics(0,duration), tone=metrics(1.3,3.7), quietBefore=metrics(0.1,0.8), quietAfter=metrics(4.3,4.9);
    measurements.push({channel, full, tone, quietBefore, quietAfter, dominantHz, toneBandContrastDb});
    if (!(tone.rmsDbfs > -60)) errors.push(`channel ${channel}: silence/insufficient signal`);
    if (Math.abs(dominantHz-440)>5) errors.push(`channel ${channel}: wrong frequency ${dominantHz}`);
    if (!(toneBandContrastDb>=15)) errors.push(`channel ${channel}: tone/quiet contrast below 15 dB`);
    if (full.clippedSamples/full.frames>=0.001) errors.push(`channel ${channel}: clipping`);
  }
  const report = { passed: errors.length===0, file, sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length, captureSeconds, durationSeconds: duration, codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels, bitsPerSample: Number(stream.bits_per_raw_sample || stream.bits_per_sample), measurements, errors };
  if (errors.length) { const error = new Error(errors.join('; ')); error.analysis = report; throw error; }
  return report;
}
module.exports = { analyzeRecording };
if (require.main === module) {
  try { console.log(JSON.stringify(analyzeRecording(process.argv[2], {captureSeconds: Number(process.argv[3])}),null,2)); }
  catch(error) { console.error(JSON.stringify({passed:false,error:error.message,analysis:error.analysis},null,2)); process.exitCode=1; }
}
