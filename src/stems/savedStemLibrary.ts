import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './wavIo';
import type { SeparationJobMetadata, StemDescriptor } from './types';

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
        if (metadata.validation?.pass !== true || metadata.originalIntegrity?.unchanged === false) continue;
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
    if (stems.length === expected.length) return { metadata, metadataPath, stems };
  }
  return null;
}
