import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
const root = 'F:/AirDox/Top200';
const settings = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'airdox_smart_editor/stems/RemoteJobs/settings.json'), 'utf8'));
const local = new StemJobService({ root });
const remote = new RemoteStemJobService({ root, localService: local, settings, disableBackgroundPolling: true });
try {
  const job = await remote.retryImport('9197cce9-582a-4214-9d23-71bff8e0ed26');
  const result = { jobId: job.jobId, status: job.status, localJobId: job.localJobId, stems: job.importedStems, error: job.error, root, at: new Date().toISOString() };
  await writeFile(path.join(root, 'first-track-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { remote.dispose(); }
