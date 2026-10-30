import separate from '@audio/neural-separate';

const arg = process.argv.find((value) => value.startsWith('--seconds='));
const seconds = Math.max(11, Number(arg?.split('=')[1] ?? 11));
const stepArg = process.argv.find((value) => value.startsWith('--step='));
const step = Math.min(0.75, Math.max(0.25, Number(stepArg?.split('=')[1] ?? 0.5)));
const sampleRate = 44100;
const frames = seconds * sampleRate;
const left = new Float32Array(frames);
const right = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  const beat = i / sampleRate;
  left[i] = 0.25 * Math.sin(2 * Math.PI * 110 * beat) + 0.08 * Math.sin(2 * Math.PI * 880 * beat);
  right[i] = 0.23 * Math.sin(2 * Math.PI * 110 * beat + 0.2) + 0.07 * Math.sin(2 * Math.PI * 1320 * beat);
}

const started = performance.now();
let lastProgress = '';
const result = await separate([left, right], {
  model: 'scnet', sampleRate, device: 'node', step,
  progress: ({ chunk, totalChunks }) => {
    lastProgress = `${chunk}/${totalChunks}`;
    process.stdout.write(`SCNet chunk ${lastProgress}\n`);
  },
});
const elapsed = (performance.now() - started) / 1000;
for (const stem of ['drums', 'bass', 'other', 'vocals']) {
  const channels = result.stems[stem];
  if (!channels || channels.length !== 2 || channels.some((channel) => channel.length !== frames || channel.some((v) => !Number.isFinite(v)))) {
    throw new Error(`Invalid SCNet output for ${stem}`);
  }
}
const rtf = seconds / elapsed;
console.log(JSON.stringify({ seconds, elapsedSeconds: Number(elapsed.toFixed(2)), step, realtimeFactor: Number(rtf.toFixed(3)), estimatedFiveMinuteSeconds: Math.round(300 / rtf), lastProgress, runtime: 'Node CPU' }, null, 2));
