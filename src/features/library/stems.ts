import type { TrackModel } from '../../types/rekordbox';

export interface LibraryStemRequest { trackId: string; sourcePath: string }
export interface LibraryStemArtifact {
  id: string; path: string; bytes: number; frames: number; sampleRate: number; channels: number;
  /** Set only after current file readback/validation, never copied from job status. */
  verified: boolean;
}
export interface LibraryStemProbeResult {
  sourcePath: string;
  status: 'checked' | 'unknown' | 'checking';
  checkedAt?: number;
  requiredStems: readonly string[];
  artifacts: readonly LibraryStemArtifact[];
}
export type LibraryStemSnapshot = Readonly<Record<string, LibraryStemProbeResult>>;
export type LibraryStemStatus = 'available' | 'missing' | 'unknown' | 'checking';

export type LibrarySourceExtras = {
  librarySourcePath: string;
  librarySourceSize: number;
  librarySourceModifiedAt: number;
  librarySourceUnedited: true;
};

/** Allowlist for IPC/HTTP forwarding; never forward arbitrary engine switches. */
export function sanitizeLibrarySourceExtras(value: unknown): LibrarySourceExtras | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.librarySourceUnedited !== true || typeof input.librarySourcePath !== 'string' ||
      !normalizeLibraryPath(input.librarySourcePath) || typeof input.librarySourceSize !== 'number' ||
      !Number.isSafeInteger(input.librarySourceSize) || input.librarySourceSize <= 0 ||
      typeof input.librarySourceModifiedAt !== 'number' || !Number.isFinite(input.librarySourceModifiedAt)) return undefined;
  return { librarySourcePath: input.librarySourcePath, librarySourceSize: input.librarySourceSize,
    librarySourceModifiedAt: input.librarySourceModifiedAt, librarySourceUnedited: true };
}

export function normalizeLibraryPath(value: string): string {
  let path = value.trim();
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      path = `${url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}` : ''}${decodeURIComponent(url.pathname)}`;
    }
  } catch { return ''; }
  path = path.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}
export function getLibraryStemRequests(tracks: readonly Partial<TrackModel>[]): LibraryStemRequest[] {
  return tracks.flatMap(track => {
    const sourcePath = track.originalMedia?.resolvedPath || track.originalMedia?.location || track.rawXmlAttributes?.Location;
    return track.id && sourcePath ? [{ trackId: track.id, sourcePath }] : [];
  });
}
export function getLibraryStemStatus(track: Partial<TrackModel>, snapshot: LibraryStemSnapshot = {}): LibraryStemStatus {
  const result = track.id ? snapshot[track.id] : undefined;
  const sourcePath = track.originalMedia?.resolvedPath || track.originalMedia?.location || track.rawXmlAttributes?.Location || '';
  if (!result || !sourcePath || !normalizeLibraryPath(sourcePath) || normalizeLibraryPath(sourcePath) !== normalizeLibraryPath(result.sourcePath)) return 'unknown';
  if (result.status !== 'checked') return result.status;
  if (!Number.isFinite(result.checkedAt)) return 'unknown';
  const artifacts = result.artifacts;
  const required = result.requiredStems;
  if (required.length < 2 || new Set(required).size !== required.length) return 'missing';
  const good = artifacts.filter(a => a.verified && a.path.trim() && Number.isSafeInteger(a.bytes) && a.bytes > 44 &&
    Number.isSafeInteger(a.frames) && a.frames > 0 && Number.isSafeInteger(a.sampleRate) && a.sampleRate > 0 &&
    Number.isSafeInteger(a.channels) && a.channels > 0);
  if (good.length !== required.length || artifacts.length !== good.length || new Set(good.map(a => a.id)).size !== good.length ||
      new Set(good.map(a => normalizeLibraryPath(a.path))).size !== good.length) return 'missing';
  const first = good[0];
  return required.every(id => good.some(a => a.id === id)) && good.every(a => a.frames === first.frames && a.sampleRate === first.sampleRate && a.channels === first.channels)
    ? 'available' : 'missing';
}
export function hasUsableLibraryStems(track: Partial<TrackModel>, snapshot?: LibraryStemSnapshot): boolean {
  return getLibraryStemStatus(track, snapshot) === 'available';
}
