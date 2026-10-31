import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { decodeWav } from '../src/stems/wavIo';
import { runScnetWorker } from '../src/stems/backends/scnetWorker';

// Serial real-model comparisons on identical audio. No cache hits or inference doubles.
const out = path.resolve(process.argv[2] ?? 'artifacts/stem-cpu-20261031');
await mkdir(out, { recursive: true });
const source = path.resolve(process.argv[3] ?? 'artifacts/stem-workflow-20261030/mixture.wav');
const audio = decodeWav(await readFile(source));
const frames = Math.min(audio.frames, audio.sampleRate * 12);
const moduleFile = path.join(out, 'measured-separate.mjs');
await writeFile(moduleFile, `
import separate from '@audio/neural-separate';
import { load } from '@audio/neural-runtime';
export default async (channels, options) => {
  let loadMs = 0, runMs = 0, runs = 0;
  const started = performance.now();
  const result = await separate(channels, { ...options,
    session: async spec => {
      const start = performance.now();
      const session = await load(spec, {backend:'node', sessionOptions: options.sessionOptions});
      loadMs += performance.now() - start;
      return {...session, run: async (...args) => {
        const start = performance.now(); const result = await session.run(...args);
        runMs += performance.now() - start; runs++; return result;
      }};
    },
  });
  options.progress({chunk: runs, totalChunks: runs, metrics: {loadMs, runMs, runs, totalMs: performance.now()-started}});
  return result;
};
`);
const variants = [
  { name: 'baseline', sessionOptions: { enableCpuMemArena: false, enableMemPattern: false } },
  { name: 'threads-1', sessionOptions: { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 1 } },
  { name: 'threads-2-arena', sessionOptions: { enableCpuMemArena: true, enableMemPattern: true, intraOpNumThreads: 2 } },
  { name: 'baseline-repeat', sessionOptions: { enableCpuMemArena: false, enableMemPattern: false } },
  { name: 'threads-2', sessionOptions: { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 2 } },
  { name: 'production', sessionOptions: { enableCpuMemArena: true, enableMemPattern: true, intraOpNumThreads: 2 } },
];
const report: any = { cpu: os.cpus()[0].model, logicalCores: os.cpus().length, ramBytes: os.totalmem(), source, seconds: frames/audio.sampleRate, variants: [] };
let reference: any;
for (const variant of variants) {
  if (process.argv[4] && !process.argv[4].split(',').includes(variant.name)) continue;
  console.log('START', variant.name);
  const channels = [0, 1].map(ch => Float32Array.from({length: frames}, (_, i) => audio.data[i*audio.channels+ch]));
  const start = performance.now(); let metrics: any;
  const result = await runScnetWorker(channels, {model:'scnet', device:'node', sampleRate:audio.sampleRate,
    weights:path.join(process.env.APPDATA!, 'airdox_SMART_Editor/stems/Models'), step:0.5,
    sessionOptions:variant.sessionOptions}, undefined, (event: any) => { if(event.metrics) metrics=event.metrics; }, variant.name === 'production' ? undefined : pathToFileURL(moduleFile).href);
  reference ??= result;
  let error=0, signal=0, peakError=0;
  for (const id of Object.keys(result.stems)) for(let ch=0;ch<2;ch++) {
    const x=result.stems[id][ch], y=reference.stems[id][ch];
    for(let i=0;i<x.length;i++) { if(!Number.isFinite(x[i]))throw Error('Non-finite output'); const d=x[i]-y[i];error+=d*d;signal+=y[i]*y[i];peakError=Math.max(peakError,Math.abs(d)); }
  }
  const row={...variant, elapsedMs:performance.now()-start, metrics, snrDb:error ? 10*Math.log10(signal/error):null, peakError};
  report.variants.push(row); console.log(JSON.stringify(row));
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
}
