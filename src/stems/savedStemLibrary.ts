import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sha256File } from './wavIo';
import { validateStemFile } from './qualityValidator';
import type { QualityValidationReport, SeparationJobMetadata, StemDescriptor, StemValidationReport } from './types';

export interface SavedStemQuery {
  inputFingerprint: string;
  modelId?: string;
  family?: string;
  profile?: string;
}

/** Completed WAVs are durable library assets, independent of RAM and models. */
export async function findSavedStemResult(root: string, query: SavedStemQuery) {
  const hash = query.inputFingerprint.match(/^stem-pcm-wav-v1:sha256:([a-f0-9]{64})$/)?.[1];
  if (!hash) return null;
  const candidates: { metadata: SeparationJobMetadata; metadataPath: string }[] = [];
  async function scan(dir: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && depth > 0) await scan(path.join(dir, entry.name), depth - 1);
      if (!entry.isFile() || entry.name !== 'job.json') continue;
      try {
        const metadataPath = path.join(dir, entry.name);
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as SeparationJobMetadata;
        if (metadata.status !== 'COMPLETED' || metadata.inputAudioHash !== hash) continue;
        if (query.modelId && metadata.settings.modelId !== query.modelId) continue;
        if (query.family && metadata.settings.family !== query.family) continue;
        if (query.profile && metadata.settings.profile !== query.profile) continue;
        const legacyRemote = metadata.validation === undefined && metadata.settings?.extras?.remote === true;
        if (!legacyRemote && metadata.validation?.pass !== true) continue;
        if (metadata.originalIntegrity?.unchanged === false) continue;
        candidates.push({ metadata, metadataPath });
      } catch { /* A partial or damaged manifest is never a finished result. */ }
    }
  }
  // Include old results and their history, so existing separations survive the upgrade.
  await scan(path.join(root, 'Separation'), 4);
  await scan(path.join(root, 'Cache'), 1);
  candidates.sort((a, b) => (b.metadata.timing.finishedAt ?? b.metadata.timing.startedAt) -
    (a.metadata.timing.finishedAt ?? a.metadata.timing.startedAt));
  for (const candidate of candidates) {
    const { metadata, metadataPath } = candidate;
    const expected = metadata.settings.stems;
    if (!expected?.length || new Set(expected).size !== expected.length || metadata.stems.length !== expected.length) continue;
    const stems: StemDescriptor[] = [];
    for (const stem of metadata.stems) {
      try {
        if (!stem.complete || !expected.includes(stem.id) || stems.some(s => s.id === stem.id)) break;
        // Cache manifests and archived results can retain their former absolute path.
        const filePath = path.join(path.dirname(metadataPath),
          path.dirname(metadataPath).toLowerCase().includes(`${path.sep}cache${path.sep}`) ? 'stems' : '',
          path.basename(stem.filePath));
        if ((await stat(filePath)).size !== stem.bytes || await sha256File(filePath) !== stem.sha256) break;
        stems.push({ ...stem, filePath });
      } catch { break; }
    }
    if (stems.length !== expected.length) continue;
    if (metadata.validation === undefined) {
      // Older remote imports have hashes but no persisted technical report.
      // Treat them as untrusted until every WAV has been decoded and checked.
      if (metadata.settings?.extras?.remote !== true) continue;
      const reports: StemValidationReport[] = [];
      const geometry = stems[0];
      if (!Number.isSafeInteger(geometry.frames) || geometry.frames < 1 ||
          !Number.isSafeInteger(geometry.sampleRate) || geometry.sampleRate < 1 ||
          !Number.isSafeInteger(geometry.channelCount) || geometry.channelCount < 1) continue;
      let valid = true;
      for (const stem of stems) {
        if (stem.frames !== geometry.frames || stem.sampleRate !== geometry.sampleRate ||
            stem.channelCount !== geometry.channelCount) { valid = false; break; }
        try {
          const { report, audio } = await validateStemFile(stem.id, stem.filePath, {
            expectedFrames: geometry.frames,
            expectedSampleRate: geometry.sampleRate,
            expectedChannels: geometry.channelCount,
          });
          if (!report.pass || !report.headerOk || !report.sizePlausible || !report.finiteSamples ||
              report.peak <= 0 || report.sha256 !== stem.sha256 ||
              audio.frames !== stem.frames || audio.sampleRate !== stem.sampleRate ||
              audio.channels !== stem.channelCount) { valid = false; break; }
          reports.push(report);
        } catch { valid = false; break; }
      }
      if (!valid || reports.length !== expected.length) continue;
      const validation: QualityValidationReport = {
        pass: true, issues: reports.flatMap(report => report.issues), stems: reports,
        continuity: null, recombinationErrorDb: null, fromTrainedModel: true, mode: 'fast_dj',
      };
      const upgraded = { ...metadata, validation };
      const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(upgraded, null, 2)}\n`, 'utf8');
        await rename(temporaryPath, metadataPath);
      } catch {
        await unlink(temporaryPath).catch(() => undefined);
        continue;
      }
      return { metadata: upgraded, metadataPath, stems };
    }
    return { metadata, metadataPath, stems };
  }
  return null;
}
