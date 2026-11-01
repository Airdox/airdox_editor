import type { BatchTrack } from './top200Batch';

export function batchTracksFromImportedCollection(imported: BatchTrack[], loaded: (BatchTrack & { analysisSource?: { gateCode?: string; originalPath?: string } })[]): BatchTrack[] {
  if (!imported.length) throw new Error('Zuerst die gewünschte Rekordbox-Bibliothek im Editor importieren. Top 200 verwendet genau diese Sammlung.');
  const verified = new Map(loaded.filter(track => track.analysisSource?.gateCode === 'OK' && track.analysisSource.originalPath && /^[a-f0-9]{64}$/i.test(track.originalSha256 || '')).map(track => [track.id, track]));
  return imported.map(track => ({
    id: track.id,
    title: track.title,
    playCount: track.playCount,
    originalMedia: verified.get(track.id)?.originalSha256 === track.originalSha256 && track.originalSha256 ? { location: verified.get(track.id)!.analysisSource!.originalPath! } : track.originalMedia ? { location: track.originalMedia.location } : undefined,
    databaseRecord: track.databaseRecord?.filePath ? { filePath: track.databaseRecord.filePath } : undefined,
  }));
}
