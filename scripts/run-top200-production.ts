import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { Top200BatchService } from '../src/stems/remote/top200Batch';

const root = 'F:/AirDox/Top200';
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'production-process.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const manifest = JSON.parse(await readFile('reports/top200-master-execution.json', 'utf8'));
const settings = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'airdox_smart_editor/stems/RemoteJobs/settings.json'), 'utf8'));
const local = new StemJobService({ root });
const remote = new RemoteStemJobService({ root, localService: local, settings, disableBackgroundPolling: true });
const batches = new Top200BatchService(root, remote);
remote.onEvent(event => {
  if ('job' in event) console.log(JSON.stringify({ event: event.type, jobId: event.job.jobId, track: event.job.trackName, status: event.job.status, percent: event.job.percent }));
});
const existing = (await batches.list())[0];
const batch = existing ?? await batches.create(manifest.tracks, 'bsroformer-musdb18hq-4stem-zfturbo');
await writeFile(path.join(root, 'active-batch.json'), JSON.stringify({ batchId: batch.id, root, source: manifest.source, createdAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ event: 'production_batch_started', batchId: batch.id, root, tracks: batch.entries.length, ready: batch.entries.filter(entry => entry.status === 'READY').length }));
if (existing) batches.resume(batch.id);
let importing = false;
async function importReadyResults() {
  if (importing) return;
  importing = true;
  try {
    await remote.poll();
    for (const job of remote.list()) {
      if (job.status === 'FAILED' && job.error?.message?.includes('ENOSPC')) {
        try { await remote.retryImport(job.jobId); }
        catch (error) { console.error(String(error)); }
      }
    }
    const jobs = remote.list();
    const states = jobs.reduce<Record<string, number>>((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {});
    const progress = { event: 'batch_progress', batchId: batch.id, states, at: new Date().toISOString(), jobs: jobs.map(job => ({ jobId: job.jobId, track: job.trackName, status: job.status, localJobId: job.localJobId, error: job.error })) };
    await writeFile(path.join(root, 'production-progress.json'), JSON.stringify(progress, null, 2));
    console.log(JSON.stringify({ event: progress.event, batchId: batch.id, states }));
  } catch (error) { console.error(String(error)); }
  finally { importing = false; }
}
void batches.wait(batch.id).then(async () => {
  console.log(JSON.stringify({ event: 'upload_finished', batchId: batch.id }));
  await importReadyResults();
}).catch(error => console.error(String(error)));
setInterval(() => { void importReadyResults(); }, 15000);
void importReadyResults();
