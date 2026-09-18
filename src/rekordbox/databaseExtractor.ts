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
  CuePoint,
  DataOrigin,
  ExtractedDatabaseRecord,
  LoopPoint,
  PhraseSection,
  TrackModel,
  WaveformAnalysisData,
} from '../types/rekordbox';
import { analyzeAudioBuffer } from '../waveform/analyzer';
import { parseRekordboxXml, buildBeatGridFromTempo } from './xmlParser';
import { AnlzTagDiagnostic, parseAnlzBinary as parseAnlzFile } from './anlzParser';
import { logger } from '../utils/logger';

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
  tagBlocks: AnlzTagDiagnostic[];
  unknownTags: AnlzTagDiagnostic[];
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
    tagBlocks: parsed.tagBlocks,
    unknownTags: parsed.unknownTags,
    cues: parsed.cues,
    loops: parsed.loops,
    phrases: parsed.phrases,
    waveform: parsed.waveform,
    waveformVariants: parsed.waveformVariants ?? (parsed.waveform ? [parsed.waveform] : []),
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

const WAVEFORM_PRIORITY_MERGE: Record<string, number> = {
  PWV7: 7,
  PWV5: 6,
  PWV6: 5,
  'P@V6': 5,
  PWV4: 4,
  PWV3: 3,
  PWV2: 2,
  PWAV: 1,
};

function waveformPriority(tag?: string): number {
  if (!tag) return 0;
  return WAVEFORM_PRIORITY_MERGE[tag] ?? 0;
}

export function mergeAnlzExtractions(
  primary: AnlzExtractionResult,
  secondary: AnlzExtractionResult
): AnlzExtractionResult {
  const primaryHasData = primary.tagsFound.length > 0 || primary.waveformVariants.length > 0 || primary.cues.length > 0 || primary.loops.length > 0 || primary.phrases.length > 0 || !!primary.beatGrid;
  const secondaryHasData = secondary.tagsFound.length > 0 || secondary.waveformVariants.length > 0 || secondary.cues.length > 0 || secondary.loops.length > 0 || secondary.phrases.length > 0 || !!secondary.beatGrid;

  if (!primaryHasData) return secondary;
  if (!secondaryHasData) return primary;

  // Waveform variants union with priority: primary first, then secondary, dedup by object identity not needed, keep all
  const mergedVariants = [...primary.waveformVariants, ...secondary.waveformVariants];
  // Determine best waveform by priority
  let best = mergedVariants[0];
  let bestPrio = -1;
  for (const v of mergedVariants) {
    const prio = waveformPriority(v.sourceTag);
    if (prio > bestPrio) {
      bestPrio = prio;
      best = v;
    }
  }

  // Beatgrid: DAT (primary) is authoritative
  const mergedBeatGrid = primary.beatGrid ?? secondary.beatGrid;

  // Cues/phrases: secondary (EXT) takes priority when non-empty, else primary
  const mergedCues = secondary.cues.length > 0 ? secondary.cues : primary.cues;
  const mergedPhrases = secondary.phrases.length > 0 ? secondary.phrases : primary.phrases;
  const mergedLoops = secondary.loops.length > 0 ? secondary.loops : primary.loops;

  // Tags union without duplicates, primary first
  const tagsFound: string[] = [];
  const seen = new Set<string>();
  for (const t of [...primary.tagsFound, ...secondary.tagsFound]) {
    if (!seen.has(t)) {
      seen.add(t);
      tagsFound.push(t);
    }
  }

  const warnings = [...primary.warnings, ...secondary.warnings];

  return {
    tagsFound,
    tagBlocks: [...primary.tagBlocks, ...secondary.tagBlocks],
    unknownTags: [...primary.unknownTags, ...secondary.unknownTags],
    cues: mergedCues,
    loops: mergedLoops,
    phrases: mergedPhrases,
    waveform: best,
    waveformVariants: mergedVariants,
    beatGrid: mergedBeatGrid,
    bpm: mergedBeatGrid ? (primary.bpm ?? secondary.bpm) ?? mergedBeatGrid.bpm : (primary.bpm ?? secondary.bpm),
    firstBeat: mergedBeatGrid ? (primary.firstBeat ?? secondary.firstBeat) ?? mergedBeatGrid.firstBeat : (primary.firstBeat ?? secondary.firstBeat),
    analysisPath: primary.analysisPath ?? secondary.analysisPath,
    warnings,
    pssiMood: secondary.pssiMood ?? primary.pssiMood,
    pssiEndBeat: secondary.pssiEndBeat ?? primary.pssiEndBeat,
    pssiBank: secondary.pssiBank ?? primary.pssiBank,
    pssiMasked: secondary.pssiMasked ?? primary.pssiMasked,
  };
}

/**
 * Applies only data that was genuinely found in an ANLZ container. XML
 * metadata and the immutable original-media reference are retained; an empty
 * or partial ANLZ file can never erase them or introduce a synthetic fallback.
 * Strict-PQTZ: only a beatGrid with actual beat nodes is considered genuine.
 * Tail extension: when ANLZ beats are shorter than the track, continue
 * uniformly with tailExtended flag, never rewriting original nodes.
 */
export function applyAnlzExtractionToTrack(
  track: TrackModel,
  extraction: AnlzExtractionResult
): TrackModel {
  const hasGenuineBeatGrid = !!extraction.beatGrid && (extraction.beatGrid.beats?.length ?? 0) > 0;
  // Strict: scalar bpm without beats is NOT adopted.
  const bpm = hasGenuineBeatGrid ? extraction.beatGrid!.bpm : track.bpm;
  const firstBeat = hasGenuineBeatGrid ? extraction.beatGrid!.firstBeat : track.beatGrid.firstBeat;
  const hasAnlzCues = extraction.cues.length > 0;
  const hasAnlzLoops = extraction.loops.length > 0;
  const hasAnlzPhrases = extraction.phrases.length > 0;
  const hasAnlzWaveform = extraction.waveform !== undefined || extraction.waveformVariants.length > 0;
  const waveform = extraction.waveform ?? track.analysis;
  const variants = hasAnlzWaveform
    ? extraction.waveformVariants.length > 0
      ? extraction.waveformVariants
      : extraction.waveform
      ? [extraction.waveform]
      : track.analysisVariants
    : track.analysisVariants;

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

  let finalBeatGrid = track.beatGrid;
  if (hasGenuineBeatGrid) {
    const src = extraction.beatGrid!;
    const beats = [...src.beats];
    const last = beats[beats.length - 1];
    if (last.time < track.duration) {
      const spb = 60.0 / src.bpm;
      let time = last.time + spb;
      let barNumber = last.barNumber;
      let beatInBar = last.beatInBar;
      let idx = beats.length;
      while (time <= track.duration + spb) {
        beatInBar++;
        if (beatInBar > src.meter) {
          beatInBar = 1;
          barNumber++;
        }
        beats.push({
          index: idx++,
          time,
          isBarStart: beatInBar === 1,
          barNumber,
          beatInBar,
          tailExtended: true,
        });
        time += spb;
        if (beats.length > 200_000) break;
      }
    }
    finalBeatGrid = {
      firstBeat: src.firstBeat,
      bpm: src.bpm,
      meter: src.meter,
      beats,
      origin: DataOrigin.REKORDBOX_ANLZ,
    };
  }

  const databaseRecord: ExtractedDatabaseRecord = {
    trackId: track.id,
    databaseSource: hasAnlzCues || hasAnlzWaveform || hasGenuineBeatGrid || hasAnlzPhrases || hasAnlzLoops ? 'REKORDBOX_ANLZ' : track.databaseRecord?.databaseSource ?? 'REKORDBOX_XML',
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
    anlzWarnings: extraction.warnings,
  };

  return {
    ...track,
    bpm,
    beatGrid: finalBeatGrid,
    cues,
    loops: hasAnlzLoops ? extraction.loops : track.loops,
    phrases,
    analysis: waveform ?? track.analysis,
    analysisVariants: variants,
    databaseRecord,
  };
}

/**
 * Computes Rekordbox song structure phrases (PSSI) from BPM and duration
 */
export function generateRekordboxPhrases(
  bpm: number,
  durationSec: number,
  firstBeatSec: number = 0.0
): PhraseSection[] {
  const secondsPerBeat = 60.0 / bpm;
  const secondsPerBar = secondsPerBeat * 4.0;
  const totalBars = Math.floor(durationSec / secondsPerBar);

  const phrases: PhraseSection[] = [];
  let currentBar = 1;

  // Typical electronic DJ arrangement template matching Pioneer Rekordbox Phrase Analysis:
  // INTRO (16 bars) -> UP / BUILD (16 bars) -> CHORUS / MAIN (32 bars) -> BREAKDOWN (16 bars) -> DROP (32 bars) -> OUTRO (16 bars)
  const template: { name: PhraseSection['name']; bars: number; color: string }[] = [
    { name: 'INTRO', bars: 16, color: '#3b82f6' }, // Blue
    { name: 'UP', bars: 16, color: '#10b981' }, // Green
    { name: 'CHORUS', bars: 32, color: '#f59e0b' }, // Amber
    { name: 'BREAKDOWN', bars: 16, color: '#8b5cf6' }, // Purple
    { name: 'DROP', bars: 32, color: '#ef4444' }, // Red
    { name: 'CHORUS', bars: 32, color: '#f59e0b' }, // Amber
    { name: 'OUTRO', bars: 16, color: '#3b82f6' }, // Blue
  ];

  for (let i = 0; i < template.length && currentBar <= totalBars; i++) {
    const t = template[i];
    const barsInPhrase = Math.min(t.bars, totalBars - currentBar + 1);
    const startBar = currentBar;
    const endBar = currentBar + barsInPhrase;
    const startTime = firstBeatSec + (startBar - 1) * secondsPerBar;
    const endTime = firstBeatSec + (endBar - 1) * secondsPerBar;

    phrases.push({
      id: `phrase-${i + 1}`,
      name: t.name,
      startBar,
      endBar,
      startTime: Math.max(0, startTime),
      endTime: Math.min(durationSec, endTime),
      color: t.color,
      // Own template calculation, clearly labeled as a fallback.
      origin: DataOrigin.GENERATED_FALLBACK,
    });

    currentBar += barsInPhrase;
  }

  return phrases;
}

/**
 * Extracts all visual assets (Memory Cues, Waveform Analysis, Beatgrid, Phrases)
 * from Rekordbox XML text into a unified TrackModel and ExtractedDatabaseRecord.
 * Honest empty state: without genuine ANLZ or decoded audio there is NO
 * synthetic waveform, NO template phrases, NO invented ANLZ tags.
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
  const bg = rawTrack.beatGrid || buildBeatGridFromTempo(0.0, bpm, duration);

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

  // Honest: only when decoded audio is present we compute LOCAL_ANALYSIS,
  // otherwise no waveform at all.
  let analysis: WaveformAnalysisData | null = null;
  if (audioBuffer) {
    analysis = analyzeAudioBuffer(audioBuffer, DataOrigin.LOCAL_ANALYSIS);
  }

  // No template phrases — PSSI only exists after genuine ANLZ merge.
  const phrases: PhraseSection[] = [];

  const dbRecord: ExtractedDatabaseRecord = {
    trackId: rawTrack.id || '1',
    databaseSource: 'REKORDBOX_XML',
    anlzTagsFound: [],
    memoryCuesCount: memoryCues.filter((c) => c.type === 'MEMORY').length,
    hotCuesCount: memoryCues.filter((c) => c.type === 'HOT_CUE').length,
    loopsCount: (rawTrack.loops || []).length,
    waveformBuckets: analysis?.length ?? 0,
    waveformModeSupported: analysis ? ['BLUE', 'RGB', '3BAND'] : [],
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

export interface GeneratedWaveformFallbackContext {
  reason?: string;
  contentId?: string;
  trackId?: string;
  /** True only when the caller has already verified an ANLZ waveform exists. */
  anlzWaveformAvailable?: boolean;
}

/**
 * Creates synthetic high-precision multi-band waveform data aligned to duration & cues.
 * It is intentionally an explicit last-resort source, never a substitute for
 * valid Rekordbox ANLZ data. The optional diagnostic context keeps its origin
 * visible in both the live SystemLogModal and persistent desktop log.
 */
export function generateAnalysisFromMetadata(
  durationSec: number,
  bpm: number,
  cues: CuePoint[],
  firstBeatSec: number = 0.0,
  context: GeneratedWaveformFallbackContext = {}
): WaveformAnalysisData {
  logger.warn('DATABASE', '[WAVEFORM] Generated waveform fallback activated.', {
    origin: DataOrigin.GENERATED_FALLBACK,
    reason: context.reason || 'Kein verifizierter nativer Waveform-Datensatz verfügbar.',
    contentId: context.contentId,
    trackId: context.trackId,
    duration: durationSec,
    bpm,
    cueCount: cues.length,
    anlzWaveformAvailable: context.anlzWaveformAvailable === true,
  });
  const bucketsPerSec = 180;
  const totalBuckets = Math.max(100, Math.floor(durationSec * bucketsPerSec));
  const peaks = new Float32Array(totalBuckets);
  const lowEnergy = new Float32Array(totalBuckets);
  const midEnergy = new Float32Array(totalBuckets);
  const highEnergy = new Float32Array(totalBuckets);

  const secondsPerBeat = 60.0 / bpm;
  const cueTimes = cues.map((c) => c.position);

  for (let b = 0; b < totalBuckets; b++) {
    const time = (b / totalBuckets) * durationSec;
    // Align with firstBeatSec
    const beatOffset = time - firstBeatSec;
    const beatFraction = ((beatOffset % secondsPerBeat) + secondsPerBeat) % secondsPerBeat / secondsPerBeat;

    // Kick transient on downbeats (20-100Hz -> Low / Red)
    const isBeatTransient = beatFraction < 0.12;
    const kickAmp = isBeatTransient ? Math.exp(-beatFraction * 20.0) : 0.05;

    // Hi-hats on off-beats (8kHz -> High / Blue)
    const offbeatOffset = beatOffset + secondsPerBeat * 0.5;
    const offbeatFraction = ((offbeatOffset % secondsPerBeat) + secondsPerBeat) % secondsPerBeat / secondsPerBeat;
    const hatAmp = offbeatFraction < 0.15 ? Math.exp(-offbeatFraction * 25.0) * 0.6 : 0.05;

    // Synth / vocal melody in mids (500Hz-3kHz -> Green/Cyan)
    const synthAmp = 0.2 + 0.3 * Math.sin(time * 2.5) * Math.cos(time * 0.8);

    // Boost around drop cue markers
    const nearCue = cueTimes.some((ct) => Math.abs(ct - time) < 4.0);
    const cueBoost = nearCue ? 1.3 : 1.0;

    const low = Math.min(1.0, Math.max(0, (kickAmp * 0.95 + 0.1) * cueBoost));
    const mid = Math.min(1.0, Math.max(0, (synthAmp * 0.8 + 0.15) * cueBoost));
    const high = Math.min(1.0, Math.max(0, (hatAmp * 0.9 + 0.1) * cueBoost));

    lowEnergy[b] = low;
    midEnergy[b] = mid;
    highEnergy[b] = high;
    peaks[b] = Math.min(1.0, Math.max(low, mid, high));
  }

  return {
    length: totalBuckets,
    peaks,
    peaksL: peaks,
    peaksR: peaks,
    lowEnergy,
    midEnergy,
    highEnergy,
    // Clearly labeled: this is an own calculation, never Rekordbox data.
    origin: DataOrigin.GENERATED_FALLBACK,
  };
}
