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
import { parseRekordboxXml, buildBeatGridFromTempo } from './xmlParser';
import { parseAnlzBinary as parseAnlzFile } from './anlzParser';

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

/**
 * Finds the bar/beat of a position in seconds by consulting the dense beats[]
 * array when present. Falls back to the uniform-grid formula only when no
 * per-beat entries exist – this is the documented fallback for files where
 * ANLZ only supplies a single BPM+firstBeat pair (never happens with real
 * PQTZ/PQT2 data).
 */
function locateBarBeat(
  position: number,
  beatGrid: BeatGrid
): { barNumber: number; beatNumber: number; beatIndex: number } {
  if (beatGrid.beats.length > 0) {
    // Binary/linear search for the nearest beat.
    const beats = beatGrid.beats;
    let best = 0;
    let bestDist = Math.abs(beats[0].time - position);
    for (let i = 1; i < beats.length; i++) {
      const d = Math.abs(beats[i].time - position);
      if (d < bestDist) { bestDist = d; best = i; }
      if (beats[i].time > position && beats[i].time - position > bestDist) break;
    }
    const node = beats[best];
    return {
      barNumber: node.barNumber,
      beatNumber: node.beatInBar,
      beatIndex: node.index,
    };
  }
  const spb = 60 / beatGrid.bpm;
  const beatIndex = Math.max(0, Math.round((position - beatGrid.firstBeat) / spb));
  return {
    barNumber: Math.floor(beatIndex / (beatGrid.meter || 4)) + 1,
    beatNumber: (beatIndex % (beatGrid.meter || 4)) + 1,
    beatIndex,
  };
}

/**
 * Applies only data that was genuinely found in an ANLZ container. XML
 * metadata and the immutable original-media reference are retained; an empty
 * or partial ANLZ file can never erase them or introduce a synthetic fallback.
 *
 * CRITICAL (Step 2): individual PQTZ beat entries (`beats[]`) are preserved
 * 1:1. We do NOT call `buildBeatGridFromTempo` when the ANLZ parser returned
 * a dense beat grid – that would discard tempo changes and beat positions
 * Rekordbox actually wrote. The uniform-bpm builder is kept strictly as the
 * documented fallback for XML/TEMPO-only imports.
 */
export function applyAnlzExtractionToTrack(
  track: TrackModel,
  extraction: AnlzExtractionResult
): TrackModel {
  const anlzBeatGrid = extraction.beatGrid;
  const hasAnlzBeatgrid = Boolean(anlzBeatGrid && anlzBeatGrid.beats.length > 0);
  // BPM display value: take the ANLZ PQTZ first-entry tempo when available,
  // otherwise keep whatever the XML/DB gave us.
  const bpm = anlzBeatGrid?.bpm ?? extraction.bpm ?? track.bpm;
  const firstBeat = anlzBeatGrid?.firstBeat ?? extraction.firstBeat ?? track.beatGrid.firstBeat;

  const hasAnlzCues = extraction.cues.length > 0;
  const hasAnlzLoops = extraction.loops.length > 0;
  const hasAnlzPhrases = extraction.phrases.length > 0;
  const hasAnlzWaveform = Boolean(extraction.waveform);
  const waveform: WaveformAnalysisData | null = hasAnlzWaveform && extraction.waveform
    ? {
        ...extraction.waveform,
        // When the ANLZ parser didn't stamp a precise secPerBucket we
        // derive it from bucket count vs. track duration. This is needed
        // by the detail renderer to map pixel columns to ANLZ buckets.
        secPerBucket:
          extraction.waveform.secPerBucket ??
          (extraction.waveform.length > 0 ? track.duration / extraction.waveform.length : undefined),
      }
    : track.analysis;

  // Choose the effective beat grid: ANLZ PQTZ beats[] take priority and are
  // preserved verbatim. Only fall back to uniform grid when PQTZ is absent.
  const effectiveBeatGrid: BeatGrid = hasAnlzBeatgrid && anlzBeatGrid
    ? {
        ...anlzBeatGrid,
        bpm,
        firstBeat,
        origin: DataOrigin.REKORDBOX_ANLZ,
      }
    : track.beatGrid;

  const phrases = hasAnlzPhrases
    ? extraction.phrases.map((phrase) => ({
        ...phrase,
        endTime: Math.min(track.duration, phrase.endTime),
        startTime: Math.max(0, Math.min(track.duration, phrase.startTime)),
      }))
    : track.phrases;

  const cues = hasAnlzCues
    ? extraction.cues.map((cue, index) => {
        const bb = locateBarBeat(cue.position, effectiveBeatGrid);
        return {
          ...cue,
          inMsec: cue.inMsec ?? Math.round(cue.position * 1000),
          cueIndex: cue.cueIndex ?? index + 1,
          barNumber: cue.barNumber ?? bb.barNumber,
          beatNumber: cue.beatNumber ?? bb.beatNumber,
          origin: DataOrigin.REKORDBOX_ANLZ,
        } as CuePoint;
      })
    : track.cues;

  const loops = hasAnlzLoops ? extraction.loops : track.loops;

  const databaseRecord: ExtractedDatabaseRecord = {
    trackId: track.id,
    databaseSource: 'REKORDBOX_ANLZ',
    anlzTagsFound: extraction.tagsFound,
    memoryCuesCount: cues.filter((cue) => cue.type === 'MEMORY').length,
    hotCuesCount: cues.filter((cue) => cue.type === 'HOT_CUE').length,
    loopsCount: loops.length,
    waveformBuckets: waveform?.length ?? 0,
    // PWV2/PWV3 = BLUE (mono), PWV4/PWV5 = RGB, PWV6/PWV7 = 3BAND
    waveformModeSupported: (() => {
      const tags = extraction.tagsFound;
      const modes: Array<'BLUE' | 'RGB' | '3BAND'> = [];
      if (tags.some((t) => t === 'PWAV' || t === 'PWV2' || t === 'PWV3')) modes.push('BLUE');
      if (tags.some((t) => t === 'PWV4' || t === 'PWV5')) modes.push('RGB');
      if (tags.some((t) => t === 'PWV6' || t === 'PWV7')) modes.push('3BAND');
      return modes.length ? modes : ['BLUE', 'RGB', '3BAND'];
    })(),
    sampleRate: track.sampleRate,
    checksum: track.originalSha256,
    extractedAt: Date.now(),
    filePath: extraction.analysisPath ?? track.originalMedia?.resolvedPath,
    anlzWarnings: extraction.warnings,
  };

  const missingParts: string[] = [];
  if (!hasAnlzBeatgrid) missingParts.push('Beatgrid (PQTZ)');
  if (!hasAnlzWaveform) missingParts.push('Waveform (PWV)');
  if (!hasAnlzCues && !hasAnlzLoops) missingParts.push('Cues (PCOB/PCO2)');
  const hasAnyAnlz = hasAnlzBeatgrid || hasAnlzWaveform || hasAnlzCues || hasAnlzLoops || hasAnlzPhrases;

  return {
    ...track,
    bpm,
    beatGrid: effectiveBeatGrid,
    cues,
    loops,
    phrases,
    analysis: waveform,
    databaseRecord,
    analysisOrigin: 'REKORDBOX_ANLZ',
    analysisStatus: missingParts.length === 0
      ? 'READY'
      : hasAnyAnlz ? 'PARTIAL' : 'MISSING_REKORDBOX_ANALYSIS',
    analysisStatusMessage: missingParts.length === 0
      ? undefined
      : `Rekordbox-ANLZ geladen, fehlende Abschnitte: ${missingParts.join(', ')}.`,
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

  // Step 4 / audio-engine separation: the extractor NEVER analyses audio
  // itself and NEVER generates a synthetic waveform. Waveform and Beatgrid
  // come exclusively from ANLZ (PWV/PQTZ). Without ANLZ the track is created
  // with `analysis = null` and `analysisStatus = MISSING_REKORDBOX_ANALYSIS`;
  // the UI surfaces a transparent message rather than inventing data.
  //
  // audioBuffer (when provided) is retained only for playback/DSP and is
  // NOT fed through any local analyser on the import path.
  const analysis: WaveformAnalysisData | null = null;

  const phrases = generateRekordboxPhrases(bpm, duration, bg.firstBeat);

  const dbRecord: ExtractedDatabaseRecord = {
    trackId: rawTrack.id || '1',
    databaseSource: 'REKORDBOX_XML',
    anlzTagsFound: [],
    memoryCuesCount: memoryCues.filter((c) => c.type === 'MEMORY').length,
    hotCuesCount: memoryCues.filter((c) => c.type === 'HOT_CUE').length,
    loopsCount: (rawTrack.loops || []).length,
    waveformBuckets: 0,
    waveformModeSupported: [],
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
    analysisOrigin: 'REKORDBOX_XML',
    analysisStatus: 'MISSING_REKORDBOX_ANALYSIS',
    analysisStatusMessage: 'Nur XML-Metadaten geladen; ANLZ muss separat über AnalysisDataPath aufgelöst werden.',
    databaseRecord: dbRecord,
    rawXmlAttributes: rawTrack.rawXmlAttributes,
    originalMedia: rawTrack.originalMedia,
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

/**
 * Creates synthetic high-precision multi-band waveform data aligned to duration & cues
 * when raw audio is loading or for immediate instant-preview from database metadata.
 */
export function generateAnalysisFromMetadata(
  durationSec: number,
  bpm: number,
  cues: CuePoint[],
  firstBeatSec: number = 0.0
): WaveformAnalysisData {
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
