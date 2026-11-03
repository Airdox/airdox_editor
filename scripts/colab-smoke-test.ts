import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { generateEdmTestTrack, writeTestAudio } from '../src/stems/testAudioGenerator';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const secondsIndex = process.argv.indexOf('--seconds');
const seconds = secondsIndex === -1 ? 1 : Number(process.argv[secondsIndex + 1]);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Diagnose ist auf 1 bis 30 synthetische Audiosekunden begrenzt.');
const evidence = path.resolve('reports', 'colab-smoke', stamp);
await mkdir(evidence, { recursive: true });
const settingsPath = path.join(process.env.APPDATA!, 'airdox_smart_editor', 'stems', 'RemoteJobs', 'settings.json');
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
const local = new StemJobService({ root: path.join(evidence, 'engine') });
const remote = new RemoteStemJobService({ root: path.join(evidence, 'engine'), localService: local, settings, disableBackgroundPolling: true });
const name = `AIRODOX_SYNTHETIC_DIAGNOSTIC_${seconds}_SECONDS`;
const audio = await writeTestAudio(path.join(evidence, 'synthetic'), name, generateEdmTestTrack({ seconds }));
const resultPath = path.join(evidence, 'result.json');
const startedAt = Date.now();
let jobId = '';
try {
  const status = await remote.status();
  if (!status.reachable) throw new Error(status.reason || 'Drive-Transport nicht erreichbar');
  const job = await remote.start({ inputPath: audio.mixPath, trackName: name, modelId: 'bsroformer-musdb18hq-4stem-zfturbo', profile: 'HIGH_QUALITY', device: 'auto' });
  jobId = job.jobId;
  console.log(JSON.stringify({ event: 'synthetic_uploaded', jobId, evidence, modelId: job.modelId, profile: job.profile, startedAt: new Date(startedAt).toISOString() }));
  const deadline = startedAt + 15 * 60_000;
  let previous = '';
  while (Date.now() < deadline) {
    const status = await remote.poll();
    const current = remote.get(jobId)!;
    const update = JSON.stringify({ status: current.status, phase: current.phase, percent: current.percent, worker: current.worker?.id });
    if (update !== previous) { console.log(update); previous = update; }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) {
      await writeFile(resultPath, JSON.stringify({ syntheticOnly: true, seconds, startedAt, finishedAt: Date.now(), workerStatus: status.worker, job: current }, null, 2));
      if (current.status !== 'COMPLETED' || !current.localJobId || current.importedStems?.length !== 4) throw new Error(`Diagnoseauftrag nicht vollständig importiert: ${current.error?.message || current.status}`);
      console.log(JSON.stringify({ event: 'verified_import', jobId, stems: current.importedStems.map(stem => stem.id), resultPath, elapsedSeconds: (Date.now() - startedAt) / 1000 }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  if (remote.get(jobId)?.status !== 'COMPLETED') {
    const cancellation = await remote.cancel(jobId, 'Synthetischer Diagnosetest: Zeitlimit erreicht');
    await writeFile(resultPath, JSON.stringify({ syntheticOnly: true, timedOut: true, jobId, cancellation, job: remote.get(jobId) }, null, 2));
    throw new Error('Diagnosetest hat das 15-Minuten-Zeitlimit erreicht; Abbruch angefordert');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { remote.dispose(); }
