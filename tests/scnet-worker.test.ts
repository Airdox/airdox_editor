import assert from 'node:assert/strict';
import { runScnetWorker } from '../src/stems/backends/scnetWorker';
import { SeparationCancellationToken } from '../src/stems/chunkProcessor';

const fixture = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const busyModule = fixture(`export default async function(channels, options) {
  options.progress({chunk: 0, totalChunks: 1});
  const until = Date.now() + 500;
  while (Date.now() < until) {}
  options.progress({chunk: 1, totalChunks: 1});
  return {stems: {vocals: channels}};
}`);

let ticks = 0;
const clock = setInterval(() => ticks++, 20);
const events: number[] = [];
try {
  const result = await runScnetWorker([new Float32Array([1, 2]), new Float32Array([3, 4])], {}, undefined, event => events.push(event.chunk), busyModule);
  assert.deepEqual([...result.stems.vocals[0]], [1, 2]);
  assert.deepEqual(events, [0, 1]);
  assert.ok(ticks >= 5, `Host muss bei synchroner Worker-Arbeit reagieren (Ticks ${ticks})`);
  console.log(`PASS SCNet CPU-Isolation: ${ticks} Host-Ticks während 500 ms CPU-Arbeit`);

  const pausedToken = new SeparationCancellationToken();
  pausedToken.pause();
  let pausedEvents = 0;
  const paused = runScnetWorker([new Float32Array(2), new Float32Array(2)], {}, pausedToken, () => pausedEvents++, busyModule);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(pausedEvents, 0, 'Pausierter Worker startet keinen Abschnitt');
  pausedToken.resume();
  await paused;
  assert.equal(pausedEvents, 2);
  console.log('PASS SCNet Pause/Fortsetzen an Abschnittsgrenzen');

  const token = new SeparationCancellationToken();
  let cancelAt = 0;
  const neverFinishes = fixture(`export default async function(channels, options) {
    options.progress({chunk: 0, totalChunks: 1});
    while(true) {}
  }`);
  const cancelled = runScnetWorker([new Float32Array(2), new Float32Array(2)], {}, token, () => {
    cancelAt = Date.now(); token.cancel('Testabbruch');
  }, neverFinishes);
  await assert.rejects(cancelled, error => (error as any).code === 'INFERENCE_CANCELLED');
  assert.ok(Date.now() - cancelAt < 1500, 'Blockierten Worker zeitnah abbrechen');
  console.log(`PASS SCNet Abbruch während CPU-Endlosschleife: ${Date.now() - cancelAt} ms`);

  await assert.rejects(runScnetWorker([new Float32Array(2), new Float32Array(2)], {}, undefined, undefined,
    fixture(`export default async function() { throw new Error('Modell kaputt'); }`)), /Modell kaputt/);
  console.log('PASS SCNet Worker-Fehler wird an Job weitergereicht');
} finally {
  clearInterval(clock);
}
