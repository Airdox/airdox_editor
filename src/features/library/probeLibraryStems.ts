/** Node-only batch probe. Do not export from the renderer's library/index. */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateStemFile } from '../../stems/qualityValidator';
import type { SeparationJobMetadata } from '../../stems/types';
import { normalizeLibraryPath, type LibraryStemArtifact, type LibraryStemProbeResult, type LibraryStemRequest, type LibraryStemSnapshot } from './stems';

/** Keep one instance per library root. It caches successful validation by file identity. */
export function createLibraryStemProbe(root: string, concurrency = 2) {
  const validated = new Map<string, { signature: string; artifact: LibraryStemArtifact }>();
  let inflight: Promise<LibraryStemSnapshot> | undefined;
  let inflightKey = '';
  return function probeLibraryStems(requests: readonly LibraryStemRequest[]): Promise<LibraryStemSnapshot> {
    const key = JSON.stringify(requests);
    if (inflight && key === inflightKey) return inflight;
    inflightKey = key;
    const task = probe(requests);
    inflight = task;
    void task.finally(() => { if (inflight === task) inflight = undefined; }).catch(() => {});
    return task;
  };

  async function probe(requests: readonly LibraryStemRequest[]): Promise<LibraryStemSnapshot> {
    const wanted = new Set(requests.map(r => normalizeLibraryPath(r.sourcePath)).filter(Boolean));
    const index = new Map<string, { metadata: SeparationJobMetadata; directory: string }[]>();
    let scanComplete = true;
    async function scan(directory: string, depth: number): Promise<void> {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') scanComplete = false; return; }
      for (const entry of entries) {
        // Cache/<key>/stems contains audio only, not nested job manifests.
        if (entry.isDirectory() && entry.name.toLowerCase() === 'stems') continue;
        if (entry.isDirectory()) { if (depth > 0) await scan(path.join(directory, entry.name), depth - 1); else scanComplete = false; }
        if (!entry.isFile() || entry.name !== 'job.json') continue;
        try {
          const metadata = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')) as SeparationJobMetadata;
          const binding = getOriginalBinding(metadata);
          const source = normalizeLibraryPath(binding?.path || metadata.originalIntegrity?.path || metadata.inputPath || '');
          if (!wanted.has(source) || metadata.status !== 'COMPLETED') continue;
          const records = index.get(source) || [];
          records.push({ metadata, directory });
          index.set(source, records);
        } catch { scanComplete = false; }
      }
    }
    // One traversal for the entire collection, including persisted previous sessions.
    await scan(path.join(root, 'Separation'), 4);
    await scan(path.join(root, 'Cache'), 1);
    const results = new Map<string, Omit<LibraryStemProbeResult, 'sourcePath'>>();
    const sources = [...wanted];
    let cursor = 0;
    async function worker() {
      while (cursor < sources.length) {
        const source = sources[cursor++];
        let result: Omit<LibraryStemProbeResult, 'sourcePath'> = {
          status: scanComplete ? 'checked' : 'unknown', checkedAt: Date.now(), requiredStems: [], artifacts: [],
        };
        const candidates = index.get(source) || [];
        candidates.sort((a,b) => (b.metadata.timing?.finishedAt || 0) - (a.metadata.timing?.finishedAt || 0));
        for (const { metadata, directory } of candidates) {
          try {
            const integrity = metadata.originalIntegrity;
            if (integrity?.unchanged !== true) continue;
            const binding = getOriginalBinding(metadata);
            const originalPath = normalizeLibraryPath(binding?.path || integrity.path);
            const original = await stat(originalPath);
            if (!original.isFile() || original.size !== (binding?.size ?? integrity.sizeBefore) || original.mtimeMs !== (binding?.mtime ?? integrity.mtimeMsBefore)) continue;
            const required = metadata.settings?.stems;
            if (!Array.isArray(required) || required.length < 2 || new Set(required).size !== required.length ||
                !Array.isArray(metadata.stems) || metadata.stems.length !== required.length) continue;
            const artifacts: LibraryStemArtifact[] = [];
            for (const stem of metadata.stems) {
              if (!stem.complete || !required.includes(stem.id) || artifacts.some(a => a.id === stem.id)) break;
              const filePath = path.join(directory, directory.toLowerCase().includes(`${path.sep}cache${path.sep}`) ? 'stems' : '', path.basename(stem.filePath));
              const before = await stat(filePath);
              if (!before.isFile() || before.size !== stem.bytes) break;
              const signature = JSON.stringify([before.size, before.mtimeMs, before.ctimeMs, before.ino, stem.id, stem.sha256, stem.frames, stem.sampleRate, stem.channelCount]);
              let artifact = validated.get(filePath)?.signature === signature ? validated.get(filePath)!.artifact : undefined;
              if (!artifact) {
                const { report, audio } = await validateStemFile(stem.id, filePath, {
                  expectedFrames: stem.frames, expectedSampleRate: stem.sampleRate, expectedChannels: stem.channelCount,
                });
                const after = await stat(filePath);
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
                    !report.pass || !report.headerOk || !report.sizePlausible || !report.finiteSamples || report.peak <= 0 || report.sha256 !== stem.sha256) break;
                artifact = { id: stem.id, path: filePath, bytes: after.size, frames: audio.frames,
                  sampleRate: audio.sampleRate, channels: audio.channels, verified: true };
                validated.set(filePath, { signature, artifact });
              }
              artifacts.push(artifact);
            }
            if (artifacts.length !== required.length || new Set(artifacts.map(a => a.path)).size !== artifacts.length) continue;
            const first = artifacts[0];
            if (!artifacts.every(a => a.frames === first.frames && a.sampleRate === first.sampleRate && a.channels === first.channels)) continue;
            const originalAfter = await stat(originalPath);
            if (originalAfter.size !== original.size || originalAfter.mtimeMs !== original.mtimeMs || originalAfter.ctimeMs !== original.ctimeMs) continue;
            result = { status: 'checked', checkedAt: Date.now(), requiredStems: required, artifacts };
            break;
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) result.status = 'unknown';
          }
        }
        results.set(source, result);
      }
    }
    const workers = Number.isFinite(concurrency) ? Math.max(1, Math.min(8, Math.floor(concurrency))) : 2;
    await Promise.all(Array.from({ length: Math.min(workers, sources.length) }, worker));
    return Object.fromEntries(requests.map(request => [request.trackId, {
      sourcePath: request.sourcePath, ...(results.get(normalizeLibraryPath(request.sourcePath)) || { status: 'unknown', requiredStems: [], artifacts: [] }),
    }]));
  }
}

/** Explicit provenance for renderer PCM staging inputs; recorded only for unedited originals. */
function getOriginalBinding(metadata: SeparationJobMetadata): { path: string; size: number; mtime: number } | undefined {
  const extras = metadata.settings?.extras;
  if (extras?.librarySourceUnedited !== true || typeof extras.librarySourcePath !== 'string' || !extras.librarySourcePath.trim() ||
      typeof extras.librarySourceSize !== 'number' || !Number.isSafeInteger(extras.librarySourceSize) || extras.librarySourceSize <= 0 ||
      typeof extras.librarySourceModifiedAt !== 'number' || !Number.isFinite(extras.librarySourceModifiedAt)) return undefined;
  return { path: extras.librarySourcePath, size: extras.librarySourceSize, mtime: extras.librarySourceModifiedAt };
}
