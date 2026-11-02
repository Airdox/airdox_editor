import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';

const [evidenceArgument, jobId] = process.argv.slice(2);
if (!evidenceArgument || !/^[a-f0-9-]{36}$/.test(jobId || '')) throw new Error('Aufruf: colab-retry-import.ts <Diagnoseordner> <JobId>');
const evidence = path.resolve(evidenceArgument);
const root = path.join(evidence, 'engine');
const settings = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'airdox_smart_editor', 'stems', 'RemoteJobs', 'settings.json'), 'utf8'));
const local = new StemJobService({ root });
const remote = new RemoteStemJobService({ root, localService: local, settings, disableBackgroundPolling: true });
try {
  const job = await remote.retryImport(jobId);
  if (job.status !== 'COMPLETED' || !job.localJobId || job.importedStems?.length !== 4) throw new Error(job.error?.message || `Importstatus: ${job.status}`);
  const result = { importOnly: true, recomputed: false, finishedAt: new Date().toISOString(), job };
  await writeFile(path.join(evidence, 'import-retry.json'), JSON.stringify(result, null, 2));
  const report = path.resolve('reports', 'colab-smoke', path.basename(evidence));
  await mkdir(report, { recursive: true });
  await writeFile(path.join(report, 'import-retry.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: 'verified_import_retry', jobId, evidence, stems: job.importedStems.map(stem => ({ id: stem.id, sha256: stem.sha256 })) }));
} finally { remote.dispose(); }
