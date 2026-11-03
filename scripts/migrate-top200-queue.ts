import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { planQueueMigration } from '../src/stems/remote/queueMigration.mjs';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
const root = 'F:/AirDox/Top200';
const metadataOnly = process.argv.includes('--metadata-only');
const importsOnly = process.argv.includes('--imports-only');
const active = JSON.parse(await readFile(path.join(root, 'active-batch.json'), 'utf8'));
const batch = JSON.parse(await readFile(path.join(root, 'Top200Batches', active.batchId + '.json'), 'utf8'));
const settings = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'airdox_smart_editor/stems/RemoteJobs/settings.json'), 'utf8'));
if (settings.kind !== 'folder') throw new Error('Migration benötigt den vorhandenen Ordnertransport.');
const backup = path.join(root, 'QueueMigrationBackups', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(backup, { recursive: true });
const jobs = [...new Set<string>(batch.entries.flatMap(entry => entry.jobId ? [entry.jobId] : []))];
const plans = [];
for (const id of jobs) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Ungültige gespeicherte Job-ID');
  try {
    const localPath = path.join(root, 'RemoteJobs', id + '.json');
    const remotePath = path.join(settings.root, 'jobs', id, 'manifest.json');
    const localRaw = await readFile(localPath, 'utf8'); const remoteRaw = await readFile(remotePath, 'utf8');
    const claim = await readFile(path.join(settings.root, 'jobs', id, 'claim.json'), 'utf8').then(JSON.parse).catch(() => null);
    const cancelled = await readFile(path.join(settings.root, 'jobs', id, 'cancel.flag')).then(() => true).catch(() => false);
    const plan = planQueueMigration(JSON.parse(localRaw), JSON.parse(remoteRaw), { claim, cancelled });
    await writeFile(path.join(backup, id + '.local.json'), localRaw, { flag: 'wx' });
    await writeFile(path.join(backup, id + '.remote.json'), remoteRaw, { flag: 'wx' });
    await writeFile(path.join(backup, id + '.decision.json'), JSON.stringify({ claim, cancelled, action: plan.action, reason: plan.reason }, null, 2), { flag: 'wx' });
    plans.push({ id, localPath, remotePath, localRaw, remoteRaw, plan });
  } catch (error) { console.error(id, String(error)); }
}
const service = new RemoteStemJobService({ root, localService: new StemJobService({ root }), settings, disableBackgroundPolling: true });
const results = [];
try {
  for (const item of plans.filter(item => !metadataOnly && item.plan.action === 'import')) {
    console.log(JSON.stringify({ event: 'import_existing_result', id: item.id }));
    try { const job = await service.retryImport(item.id); results.push({ id: item.id, action: 'import', status: job.status, error: job.error }); console.log(JSON.stringify({ id: item.id, status: job.status, error: job.error })); }
    catch (error) { results.push({ id: item.id, action: 'import', error: String(error) }); }
  }
  for (const item of plans.filter(item => !importsOnly && ['extend-wait', 'repair-timeout'].includes(item.plan.action))) {
    const jobDirectory = path.dirname(item.remotePath);
    const newClaim = await readFile(path.join(jobDirectory, 'claim.json'), 'utf8').then(JSON.parse).catch(() => null);
    const newCancellation = await readFile(path.join(jobDirectory, 'cancel.flag')).then(() => true).catch(() => false);
    if (newClaim || newCancellation) { results.push({ id: item.id, action: 'skip', reason: 'claim-or-cancel-before-write' }); continue; }
    if (await readFile(item.remotePath, 'utf8') !== item.remoteRaw || await readFile(item.localPath, 'utf8') !== item.localRaw) { results.push({ id: item.id, action: 'skip', reason: 'changed-since-backup' }); continue; }
    if (item.plan.manifest) { await writeFile(item.remotePath + '.migration.tmp', JSON.stringify(item.plan.manifest)); await rename(item.remotePath + '.migration.tmp', item.remotePath); }
    await writeFile(item.localPath + '.migration.tmp', JSON.stringify(item.plan.record)); await rename(item.localPath + '.migration.tmp', item.localPath);
    results.push({ id: item.id, action: item.plan.action });
  }
  results.push(...plans.filter(item => item.plan.action === 'skip').map(item => ({ id: item.id, action: 'skip', reason: item.plan.reason })));
  const unlinkedLocalRecords = (await readdir(path.join(root, 'RemoteJobs'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name) && !jobs.includes(name.slice(0, -5)));
  await writeFile(path.join(backup, 'report.json'), JSON.stringify({ batchId: active.batchId, backup, results, unlinkedLocalRecords, unlinkedPolicy: 'Unlinked records are inventoried only and never reassigned by title.' }, null, 2));
  console.log(JSON.stringify({ backup, counts: results.reduce((counts, item) => { const key = item.action + (item.status ? ':' + item.status : ''); counts[key] = (counts[key] || 0) + 1; return counts; }, {}) }));
} finally { service.dispose(); }
