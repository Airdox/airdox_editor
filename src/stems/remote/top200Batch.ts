import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from '../wavIo';
import type { RemoteStemJobService } from './remoteStemJobService';

export interface BatchTrack { id: string; title?: string; playCount?: number; originalSha256?: string; originalMedia?: { location: string }; databaseRecord?: { filePath?: string } }
export interface BatchEntry { track: BatchTrack; inputPath?: string; originalSha256?: string; jobId?: string; status: string; percent: number; error?: string; localJobId?: string }
export interface Top200Batch { id: string; entries: BatchEntry[]; createdAt: number; modelId?: string; published?: boolean; uploadComplete?: boolean; error?: string }
export function selectTop200(tracks: BatchTrack[]): BatchTrack[] {
  const seen = new Set<string>();
  return tracks.filter(track => typeof track.id === 'string' && !seen.has(track.id) && !!seen.add(track.id))
    .sort((left, right) => count(right) - count(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).slice(0, 200);
}
function count(track: BatchTrack): number { return Number.isFinite(track.playCount) ? Math.max(0, track.playCount!) : 0; }
export async function checkBatchTrack(track: BatchTrack): Promise<string> {
  const location = track.originalMedia?.location || track.databaseRecord?.filePath;
  if (!location) throw new Error('Kein Originalpfad in Rekordbox');
  if (process.platform === 'win32' && location.startsWith('file:')) {
    const url = new URL(location);
    if ((!url.hostname || url.hostname === 'localhost') && !/^\/[A-Za-z]:\//.test(url.pathname)) throw new Error('XML-Pfad enthält kein eindeutiges Windows-Laufwerk. Aktuelle XML oder bestätigte Medienwurzel erforderlich.');
  }
  const filename = location.startsWith('file:') ? fileURLToPath(location) : location;
  if (!path.isAbsolute(filename)) throw new Error('Originalpfad ist nicht absolut');
  if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(filename)) throw new Error('Originalpfad enthält kein eindeutiges Windows-Laufwerk.');
  await access(filename, constants.R_OK);
  const info = await stat(filename);
  if (!info.isFile() || !info.size) throw new Error('Audiodatei fehlt oder ist leer');
  return path.resolve(filename);
}
export class Top200BatchService {
  private running = new Map<string, Promise<void>>();
  constructor(private root: string, private remote: RemoteStemJobService, private convert = convertAudio) {}
  private directory() { return path.join(this.root, 'Top200Batches'); }
  private filename(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Ungültige Stapel-ID');
    return path.join(this.directory(), `${id}.json`);
  }
  private async save(batch: Top200Batch) {
    await mkdir(this.directory(), { recursive: true });
    const filename = this.filename(batch.id);
    await writeFile(`${filename}.tmp`, JSON.stringify(batch));
    await rename(`${filename}.tmp`, filename);
  }
  async get(id: string): Promise<Top200Batch> { return JSON.parse(await readFile(this.filename(id), 'utf8')); }
  async list(): Promise<Top200Batch[]> {
    await mkdir(this.directory(), { recursive: true });
    const batches = [];
    for (const name of await readdir(this.directory())) {
      if (name.endsWith('.json')) batches.push(await this.get(name.slice(0, -5)));
    }
    return batches.sort((left, right) => right.createdAt - left.createdAt);
  }
  async preview(tracks: BatchTrack[]): Promise<BatchEntry[]> {
    const entries: BatchEntry[] = [];
    for (const track of selectTop200(tracks)) {
      try { entries.push({ track, inputPath: await checkBatchTrack(track), status: 'READY', percent: 0 }); }
      catch (error) { entries.push({ track, status: 'FAILED', percent: 0, error: String(error) }); }
    }
    return entries;
  }
  async lookup(trackId: string, hash: string): Promise<string | null> {
    for (const batch of await this.list()) {
      for (const entry of batch.entries) {
        if (entry.track.id === trackId && entry.originalSha256 === hash && entry.jobId) {
          const localJobId = await this.remote.restoreCompletedJob(entry.jobId, hash);
          if (localJobId) return localJobId;
        }
      }
    }
    return null;
  }
  async create(tracks: BatchTrack[], modelId = 'bsroformer-musdb18hq-4stem-zfturbo') {
    if (modelId !== 'bsroformer-musdb18hq-4stem-zfturbo') throw new Error(`Editor-Modell ${modelId} ist für den Colab-4-Stem-Adapter nicht verifiziert. Keine automatische Modelländerung.`);
    const batch = { id: randomUUID(), entries: await this.preview(tracks), createdAt: Date.now(), modelId };
    await this.save(batch);
    this.resume(batch.id);
    return batch;
  }
  resume(id: string) {
    if (!this.running.has(id)) {
      const task = this.run(id).finally(() => this.running.delete(id));
      this.running.set(id, task);
      void task.catch(async error => {
        const batch = await this.get(id);
        batch.error = String(error);
        await this.save(batch);
      }).catch(() => undefined);
    }
  }
  async wait(id: string) { await this.running.get(id); }
  async retry(id: string) {
    await this.wait(id);
    const batch = await this.refresh(id);
    for (const entry of batch.entries) {
      if (entry.status !== 'FAILED') continue;
      if (entry.jobId) {
        try {
          const imported = await this.remote.retryImport(entry.jobId);
          entry.status = imported.status; entry.percent = imported.percent; entry.localJobId = imported.localJobId; entry.error = imported.error?.message;
          continue;
        } catch (error) {
          if ((error as { code?: string }).code !== 'REMOTE_RESULT_NOT_READY') { entry.error = String(error); continue; }
        }
      }
      entry.jobId = undefined; entry.error = undefined; entry.status = 'READY'; entry.percent = 0;
    }
    batch.error = undefined; batch.published = false;
    await this.save(batch);
    this.resume(id);
    return batch;
  }
  private async run(id: string) {
    const batch = await this.get(id);
    let checkpointCount = 0;
    for (const entry of batch.entries) {
      if (entry.jobId || entry.status === 'FAILED') continue;
      const work = path.join(this.directory(), `${id}-${batch.entries.indexOf(entry)}.wav`);
      try {
        entry.inputPath = await checkBatchTrack(entry.track);
        entry.originalSha256 = await sha256File(entry.inputPath);
        entry.status = 'PREPARING';
        await this.save(batch);
        await this.convert(entry.inputPath, work);
        if (await sha256File(entry.inputPath) !== entry.originalSha256) throw new Error('Originaldatei wurde während der Konvertierung verändert');
        const job = await this.remote.start({ inputPath: work, sourceOriginalPath: entry.inputPath, trackName: entry.track.title || entry.track.id, profile: 'HIGH_QUALITY', modelId: batch.modelId ?? 'bsroformer-musdb18hq-4stem-zfturbo', queueWaitTimeoutMs: 7 * 24 * 60 * 60_000 });
        entry.jobId = job.jobId;
        entry.status = job.status;
      } catch (error) { entry.status = 'FAILED'; entry.error = String(error); }
      await this.save(batch);
      await rm(work, { force: true });
      checkpointCount++;
      if (checkpointCount % 10 === 0) {
        await this.remote.publishBatch(batch.id, batch.entries.flatMap(item => item.jobId ? [item.jobId] : []), false);
        batch.published = true;
        batch.uploadComplete = false;
        await this.save(batch);
      }
    }
    await this.remote.publishBatch(batch.id, batch.entries.flatMap(entry => entry.jobId ? [entry.jobId] : []));
    batch.published = true;
    batch.uploadComplete = true;
    batch.error = undefined;
    await this.save(batch);
  }
  async refresh(id: string) {
    if (this.running.has(id)) return this.get(id);
    await this.remote.poll();
    const batch = await this.get(id);
    for (const entry of batch.entries) {
      if (!entry.jobId) continue;
      const job = this.remote.get(entry.jobId);
      if (!job) { entry.error = 'Zugeordneter Fernauftrag fehlt'; continue; }
      entry.status = job.status;
      entry.percent = job.percent;
      entry.localJobId = job.localJobId;
      entry.error = job.error?.message;
    }
    await this.save(batch);
    return batch;
  }
}
async function convertAudio(input: string, output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.AIRDOX_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', output], { windowsHide: true });
    let details = '';
    child.stderr.on('data', chunk => { details = (details + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Audiokonvertierung: ${details}`)));
  });
}
