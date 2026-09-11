/**
 * @license
 * Rekordbox Data & Database Extraction Engine
 * 
 * Extracts visualization data directly from Rekordbox data structures:
 * 1. Memory Cues & Hot Cues (from Rekordbox XML <POSITION_MARK>, ANLZ PCOB/PCO2, or SQLite djmdCue)
 * 2. Waveform Visualization Data (from ANLZ PWV3/PWV4/PWV5 or 3-band spectral analysis cache)
 * 3. Beatgrid & Bar alignment (from XML <TEMPO>, ANLZ PQTZ, or djmdContent)
 * 4. Song Structure / Phrases (from ANLZ PSSI or phrase analysis)
 */

import {
  BeatGrid,
  BeatNode,
  CuePoint,
  DataOrigin,
  ExtractedDatabaseRecord,
  LoopPoint,
  PhraseSection,
  TrackModel,
  WaveformAnalysisData,
} from '../types/rekordbox';
import { parseRekordboxXml } from './xmlParser';
import { parseAnlzBinary as parseAnlzFile, WAVEFORM_PRIORITY } from './anlzParser';

/**
 * Parses binary Rekordbox ANLZ file (.DAT, .EXT, .2EX).
 * The concrete byte layouts are implemented in ./anlzParser against the
 * independently documented Deep Symmetry ANLZ format specification and
 * cover the following sections:
 * - 'PPTH': source audio path
 * - 'PQTZ': Quantized beatgrid
 * - 'PCOB' / 'PCO2': Cue Objects (Memory Cues, Hot Cues, Loops);
 *   PCO2 (nxs2) takes priority over the classic PCOB list.
 * - 'PWAV' / 'PWV2' / 'PWV3' / 'PWV4' / 'PWV5' / 'PWV6' / 'PWV7': waveforms
 * - 'PSSI': Song Structure Phrases (incl. Rekordbox 6 XOR mask)
 */
export interface AnlzExtractionResult {
  tagsFound: string[];
  cues: CuePoint[];
  loops: LoopPoint[];
  phrases: PhraseSection[];
  waveform?: WaveformAnalysisData;
  waveformVariants: WaveformAnalysisData[];
  beatGrid?: BeatGrid;
  bpm?: number;
  firstBeat?: number;
  analysisPath?: string;
  warnings: string[];
  pssiMood?: number;
  pssiEndBeat?: number;
  pssiBank?: number;
  pssiMasked?: boolean;
}

function toExtractionResult(parsed: ReturnType<typeof parseAnlzFile>): AnlzExtractionResult {
  return {
    tagsFound: parsed.tagsFound,
    cues: parsed.cues,
    loops: parsed.loops,
    phrases: parsed.phrases,
    waveform: parsed.waveform,
    waveformVariants: parsed.waveformVariants,
    beatGrid: parsed.beatGrid,
    bpm: parsed.bpm,
    firstBeat: parsed.firstBeat,
    analysisPath: parsed.analysisPath,
    warnings: parsed.warnings,
    pssiMood: parsed.pssiMood,
    pssiEndBeat: parsed.pssiEndBeat,
    pssiBank: parsed.pssiBank,
    pssiMasked: parsed.pssiMasked,
  };
}

export function parseAnlzBinary(buffer: ArrayBuffer): AnlzExtractionResult {
  return toExtractionResult(parseAnlzFile(buffer));
}

function waveformTagPriority(tag?: string): number {
  return tag ? (WAVEFORM_PRIORITY[tag] ?? 0) : 0;
}

/**
 * Merges two ANLZ extractions from sibling containers (ANLZnnnn.DAT and
 * ANLZnnnn.EXT) into one. Rekordbox splits the analysis: the .DAT carries
 * source path, PQTZ beat grid, PCOB cue lists and preview waveforms, while
 * the .EXT carries the full-resolution color waveform (PWV5), PSSI phrase
 * structure and PCO2 extended cues. The merge stays deterministic and never
 * invents data:
 *
 *  - tagsFound / warnings are unioned (order-preserving);
 *  - ALL genuine waveform variants of both files are kept; the highest
 *    priority variant (PWV7 > PWV5 > PWV6 > ... > PWAV) becomes `waveform`;
 *  - the primary beat grid wins when it holds decoded beat nodes (PQTZ is
 *    authoritative in the .DAT), otherwise the secondary grid is adopted;
 *  - non-empty cue/loop/phrase lists of the secondary file take priority
 *    (PCO2/PSSI live in the .EXT); empty lists fall back to the primary's.
 *
 * Positional contract: `primary` is the DAT-side extraction, `secondary`
 * the EXT-side extraction — callers enforce this regardless of which
 * sibling file was read first.
 */
export function mergeAnlzExtractions(
  primary: AnlzExtractionResult,
  secondary: AnlzExtractionResult
): AnlzExtractionResult {
  // Ordered de-duplicated union (the raw parser keeps one entry per section,
  // so a single file can already list e.g. PCOB twice — the merged view
  // normalizes to distinct tags).
  const tagsFound: string[] = [];
  for (const tag of [...primary.tagsFound, ...secondary.tagsFound]) {
    if (!tagsFound.includes(tag)) tagsFound.push(tag);
  }

  const waveformVariants = [...primary.waveformVariants, ...secondary.waveformVariants];
  const waveform =
    waveformTagPriority(secondary.waveform?.sourceTag) >
    waveformTagPriority(primary.waveform?.sourceTag)
      ? secondary.waveform
      : (primary.waveform ?? secondary.waveform);

  const primaryHasBeats = (primary.beatGrid?.beats?.length ?? 0) > 0;
  const secondaryHasBeats = (secondary.beatGrid?.beats?.length ?? 0) > 0;
  const gridWinner =
    (primaryHasBeats || !secondaryHasBeats ? primary : secondary);
  const gridLoser = gridWinner === primary ? secondary : primary;

  return {
    tagsFound,
    cues: secondary.cues.length > 0 ? secondary.cues : primary.cues,
    loops: secondary.loops.length > 0 ? secondary.loops : primary.loops,
    phrases: secondary.phrases.length > 0 ? secondary.phrases : primary.phrases,
    waveform,
    waveformVariants,
    beatGrid: gridWinner.beatGrid,
    bpm: gridWinner.bpm ?? gridLoser.bpm,
    firstBeat: gridWinner.firstBeat ?? gridLoser.firstBeat,
    analysisPath: primary.analysisPath ?? secondary.analysisPath,
    warnings: [...primary.warnings, ...secondary.warnings],
    pssiMood: secondary.pssiMood ?? primary.pssiMood,
    pssiEndBeat: secondary.pssiEndBeat ?? primary.pssiEndBeat,
    pssiBank: secondary.pssiBank ?? primary.pssiBank,
    pssiMasked: secondary.pssiMasked ?? primary.pssiMasked,
  };
}

/**
 * Adopts the original Rekordbox beat positions decoded from PQTZ without
 * adding, deleting, spacing, or otherwise rebuilding entries. Each node keeps
 * the exact PQTZ timestamp, beat-in-bar and per-beat tempo decoded by the ANLZ
 * parser. Without decoded entries there is no ANLZ grid to adopt.
 */
function adoptAnlzBeatGrid(
  extraction: AnlzExtractionResult,
  track: TrackModel,
  bpm: number
): BeatGrid {
  const anlzBeats = extraction.beatGrid?.beats;
  if (!anlzBeats || anlzBeats.length === 0) return track.beatGrid;

  return {
    firstBeat: anlzBeats[0].time,
    bpm,
    meter: extraction.beatGrid?.meter || track.beatGrid.meter || 4,
    beats: anlzBeats.map((node) => ({ ...node })),
    origin: DataOrigin.REKORDBOX_ANLZ,
  };
}

/**
 * Applies only data that was genuinely found in an ANLZ container. XML
 * metadata and the immutable original-media reference are retained; an empty
 * or partial ANLZ file can never erase them or introduce a synthetic fallback.
 */
export function applyAnlzExtractionToTrack(
  track: TrackModel,
  extraction: AnlzExtractionResult
): TrackModel {
  // Strict-PQTZ rule: the ANLZ beat grid (and its bpm/first beat) is adopted
  // only when real beat nodes were decoded. BPM/first-beat scalars without
  // nodes (legacy or corrupt PQTZ) never trigger a uniform grid rebuild; the
  // XML grid — genuine Rekordbox data — is kept and the gap is reported.
  const hasAnlzBeatgrid = (extraction.beatGrid?.beats.length ?? 0) > 0;
  const bpm = hasAnlzBeatgrid ? (extraction.bpm ?? track.bpm) : track.bpm;
  const firstBeat = hasAnlzBeatgrid
    ? (extraction.firstBeat ?? track.beatGrid.firstBeat)
    : track.beatGrid.firstBeat;
  const pqtzUnusable =
    !hasAnlzBeatgrid &&
    (extraction.tagsFound.includes('PQTZ') || extraction.tagsFound.includes('PQT2'));
  const beatWarnings = pqtzUnusable
    ? ['PQTZ ohne lesbare Beat-Einträge; XML-Beatgrid beibehalten.']
    : [];
  const hasAnlzCues = extraction.cues.length > 0;
  const hasAnlzLoops = extraction.loops.length > 0;
  const hasAnlzPhrases = extraction.phrases.length > 0;
  const waveform = extraction.waveform ?? track.analysis;
  const analysisVariants =
    extraction.waveformVariants.length > 0 ? extraction.waveformVariants : track.analysisVariants;

  const phrases = hasAnlzPhrases
    ? extraction.phrases.map((phrase) => ({
        ...phrase,
        // PSSI is decoded against the ANLZ beat grid; never let a phrase
        // extend past the actual working duration of the track.
        endTime: Math.min(track.duration, phrase.endTime),
        startTime: Math.max(0, Math.min(track.duration, phrase.startTime)),
      }))
    : track.phrases;

  const cues = hasAnlzCues
    ? extraction.cues.map((cue, index) => {
        const beatIndex = Math.max(0, Math.round((cue.position - firstBeat) / (60 / bpm)));
        return {
          ...cue,
          inMsec: cue.inMsec ?? Math.round(cue.position * 1000),
          cueIndex: cue.cueIndex ?? index + 1,
          barNumber: cue.barNumber ?? Math.floor(beatIndex / 4) + 1,
          beatNumber: cue.beatNumber ?? (beatIndex % 4) + 1,
          origin: DataOrigin.REKORDBOX_ANLZ,
        };
      })
    : track.cues;

  const databaseRecord: ExtractedDatabaseRecord = {
    trackId: track.id,
    databaseSource: 'REKORDBOX_ANLZ',
    anlzTagsFound: extraction.tagsFound,
    memoryCuesCount: cues.filter((cue) => cue.type === 'MEMORY').length,
    hotCuesCount: cues.filter((cue) => cue.type === 'HOT_CUE').length,
    loopsCount: (hasAnlzLoops ? extraction.loops : track.loops).length,
    waveformBuckets: waveform?.length ?? 0,
    waveformModeSupported: waveform ? ['BLUE', 'RGB', '3BAND'] : [],
    sampleRate: track.sampleRate,
    checksum: track.originalSha256,
    extractedAt: Date.now(),
    filePath: extraction.analysisPath ?? track.originalMedia?.resolvedPath,
    anlzWarnings: [...extraction.warnings, ...beatWarnings],
  };

  return {
    ...track,
    bpm,
    beatGrid: hasAnlzBeatgrid
      ? adoptAnlzBeatGrid(extraction, track, bpm)
      : track.beatGrid,
    cues,
    loops: hasAnlzLoops ? extraction.loops : track.loops,
    phrases,
    analysis: waveform,
    analysisVariants,
    databaseRecord,
  };
}


/**
 * Extracts all visual assets (Memory Cues, Waveform Analysis, Beatgrid, Phrases)
 * from Rekordbox XML text into a unified TrackModel and ExtractedDatabaseRecord.
 */
export function extractTrackFromRekordboxXml(
  xmlContent: string,
  targetTrackIndex: number = 0,
  audioBuffer?: AudioBuffer
): { track: TrackModel; record: ExtractedDatabaseRecord } {
  const { tracks } = parseRekordboxXml(xmlContent);
  if (tracks.length === 0) {
    throw new Error('No tracks found in Rekordbox XML.');
  }

  const rawTrack = tracks[targetTrackIndex] || tracks[0];
  const bpm = rawTrack.bpm || 130.0;
  const duration = rawTrack.duration || (audioBuffer ? audioBuffer.duration : 300.0);
  const bg = rawTrack.beatGrid || {
    firstBeat: 0,
    bpm,
    meter: 4,
    beats: [],
    origin: DataOrigin.REKORDBOX_XML,
  };

  // Enrich memory cues with bar/beat alignment and inMsec
  const secondsPerBeat = 60.0 / bpm;
  const memoryCues: CuePoint[] = (rawTrack.cues || []).map((c, idx) => {
    const timeMs = Math.round(c.position * 1000);
    const beatIndex = Math.round((c.position - bg.firstBeat) / secondsPerBeat);
    const barNumber = Math.floor(beatIndex / 4) + 1;
    const beatNumber = (beatIndex % 4) + 1;

    return {
      ...c,
      inMsec: timeMs,
      cueIndex: idx + 1,
      barNumber,
      beatNumber,
      origin: DataOrigin.REKORDBOX_XML,
    };
  });

  // XML extraction never analyzes the optional playback buffer. Waveform
  // values are attached later and exclusively by applyAnlzExtractionToTrack.
  const analysis: WaveformAnalysisData | null = null;

  // No template phrases: PSSI song structure comes only from ANLZ.
  const phrases: PhraseSection[] = [];

  const dbRecord: ExtractedDatabaseRecord = {
    trackId: rawTrack.id || '1',
    databaseSource: 'REKORDBOX_XML',
    // No ANLZ container was parsed here — never report invented tags.
    anlzTagsFound: [],
    memoryCuesCount: memoryCues.filter((c) => c.type === 'MEMORY').length,
    hotCuesCount: memoryCues.filter((c) => c.type === 'HOT_CUE').length,
    loopsCount: (rawTrack.loops || []).length,
    waveformBuckets: analysis?.length ?? 0,
    waveformModeSupported: ['BLUE', 'RGB', '3BAND'],
    sampleRate: audioBuffer ? audioBuffer.sampleRate : 44100,
    checksum: 'REKORDBOX-XML-VALIDATED',
    extractedAt: Date.now(),
  };

  const track: TrackModel = {
    id: rawTrack.id || '1',
    title: rawTrack.title || 'Extracted Track',
    artist: rawTrack.artist || 'Unknown Artist',
    album: rawTrack.album || 'Rekordbox Collection',
    bpm,
    key: rawTrack.key || '2A',
    duration,
    sampleRate: audioBuffer ? audioBuffer.sampleRate : 44100,
    channels: audioBuffer ? audioBuffer.numberOfChannels : 2,
    originalSha256: 'SHA256-REKORDBOX-IMMUTABLE-READONLY',
    isOriginalUntouched: true,
    audioBuffer: audioBuffer || null,
    beatGrid: bg,
    cues: memoryCues,
    loops: rawTrack.loops || [],
    analysis,
    phrases,
    origin: DataOrigin.REKORDBOX_XML,
    databaseRecord: dbRecord,
    workingSegments: [
      {
        id: `seg-init-${Date.now()}`,
        type: 'ORIGINAL',
        trackId: rawTrack.id || '1',
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1.0,
      },
    ],
  };

  return { track, record: dbRecord };
}
