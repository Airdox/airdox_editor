/**
 * @license
 * Deck waveform source resolution — the rule that decides what the detail
 * waveform draws for a track that was just loaded into the deck.
 *
 * Pure module (no React, no canvas) so the guarantee stays unit-testable:
 * covered by tests/deck-waveform-source.test.ts and by the waveform
 * gatekeeper's source-contract agent.
 *
 * Priority — a track loaded into the deck ALWAYS shows a waveform, and the
 * provenance of what is drawn is always reported, never hidden:
 *
 *   1. genuine Rekordbox ANLZ data (auto-resolved by the deck loader via
 *      AnalysisDataPath / PPTH scan) — the real Rekordbox waveform;
 *   2. analysis that came with the collection entry;
 *   3. the track's own decoded audio, analysed locally (real samples of the
 *      track itself — tagged LOCAL_ANALYSIS, never presented as Rekordbox
 *      data);
 *   4. only when no audio could be read at all: a preview contour derived
 *      from the Rekordbox beatgrid/BPM metadata (tagged GENERATED_FALLBACK),
 *      so the deck is never an empty black bar.
 */

import { DataOrigin, TrackModel, WaveformAnalysisData } from '../types/rekordbox';
import { analyzeAudioBuffer } from './analyzer';
import { generateAnalysisFromMetadata } from '../rekordbox/databaseExtractor';

export type DeckWaveformSource =
  | 'ANLZ'
  | 'COLLECTION'
  | 'LOCAL_AUDIO'
  | 'METADATA_PREVIEW'
  | 'NONE';

export interface DeckWaveformResult {
  track: TrackModel;
  source: DeckWaveformSource;
}

/** True when the track carries waveform data that came out of an ANLZ file. */
function hasAnlzWaveform(track: TrackModel): boolean {
  if (track.analysisVariants && track.analysisVariants.length > 0) return true;
  return !!track.analysis && track.analysis.origin === DataOrigin.REKORDBOX_ANLZ;
}

/**
 * Returns the track together with the provenance of the waveform the deck
 * will draw. Never mutates the input track; only adds an analysis when one is
 * missing. Duration 0 yields no metadata preview (there is nothing to draw).
 */
export function resolveDeckWaveform(track: TrackModel): DeckWaveformResult {
  if (hasAnlzWaveform(track)) return { track, source: 'ANLZ' };
  if (track.analysis) return { track, source: 'COLLECTION' };
  if (track.audioBuffer) {
    const analysis: WaveformAnalysisData = analyzeAudioBuffer(track.audioBuffer, DataOrigin.LOCAL_ANALYSIS);
    return { track: { ...track, analysis }, source: 'LOCAL_AUDIO' };
  }
  if (!(track.duration > 0)) return { track, source: 'NONE' };
  const analysis = generateAnalysisFromMetadata(
    track.duration,
    track.beatGrid?.bpm ?? track.bpm,
    track.cues ?? [],
    track.beatGrid?.firstBeat ?? 0
  );
  return { track: { ...track, analysis }, source: 'METADATA_PREVIEW' };
}

/** Human-readable provenance of the waveform currently drawn in the deck. */
export function describeDeckWaveformSource(source: DeckWaveformSource): string {
  switch (source) {
    case 'ANLZ':
      return 'Waveform: echte Rekordbox-ANLZ-Daten (automatisch zugeordnet).';
    case 'COLLECTION':
      return 'Waveform: Analysedaten aus dem Rekordbox-Import.';
    case 'LOCAL_AUDIO':
      return 'Waveform: aus dem Originalaudio berechnet (keine Rekordbox-ANLZ-Daten gefunden).';
    case 'METADATA_PREVIEW':
      return 'Waveform: Vorschau aus Beatgrid/BPM (weder ANLZ noch Audio lesbar).';
    default:
      return 'Keine Waveformdaten vorhanden.';
  }
}
