/**
 * @license
 * Deck-Pipeline nach dem Master-DB-Gate (rein, testbar).
 *
 *   Master DB (SQLCipher-Gate bestanden)
 *        ↓ normalisierte Trackdaten
 *   ANLZ vorhanden? ── JA → echte ANLZ-Analysis  → Waveform
 *                   └─ NEIN → generateAnalysisFromMetadata(DB-Daten) → Waveform
 *
 * Diese Datei entscheidet NICHT über das Gate selbst – sie darf nur mit
 * Daten aufgerufen werden, deren Master-DB-Gate erfolgreich war
 * (`gate.ok === true`). Ein fehlgeschlagenes Gate führt hier zu einem
 * harten Fehler statt zu einem stillen Fallback.
 */

import { DataOrigin, TrackModel, WaveformAnalysisData } from '../types/rekordbox';
import { buildBeatGridFromTempo } from './xmlParser';
import { generateAnalysisFromMetadata } from '../waveform/metadataAnalysis';
import {
  MasterDbGateResult,
  normalizeMasterDbTrack,
  mergeRekordboxSources,
} from './masterDbPipeline';
import { PartialTrackModel } from '../types/rekordbox';

export type AnalysisSource = 'ANLZ' | 'AUDIO_ANALYSIS' | 'METADATA_FALLBACK' | 'NONE';

export interface DeckPipelineInput {
  /** Ergebnis des verbindlichen Master-DB-Gates. */
  gate: MasterDbGateResult;
  /** Ergänzende Rekordbox-Quelle (XML-Eintrag der Sammlung), optional. */
  supplementary?: PartialTrackModel | null;
  /** Echte, dekodierte ANLZ-Analyse, falls vorhanden (höchste Priorität). */
  anlzAnalysis?: WaveformAnalysisData | null;
  /** Aus der Originaldatei berechnete Analyse (read-only gelesen), optional. */
  audioAnalysis?: WaveformAnalysisData | null;
  /** Dauer aus dem tatsächlich geladenen Originalaudio, falls vorhanden. */
  audioDuration?: number | null;
  /** First-Beat aus ANLZ/XML-Beatgrid, falls vorhanden. */
  firstBeat?: number | null;
}

export interface DeckPipelineFailure {
  ok: false;
  errorCode: string;
  reason: string;
}

export interface DeckPipelineSuccess {
  ok: true;
  track: TrackModel;
  analysisSource: AnalysisSource;
  /** Beweiskette des DB-Zugriffs für Diagnose/Tests. */
  provenance: {
    source: 'rekordbox-master-db';
    sqlcipher: true;
    databaseOpened: true;
    schemaValidated: true;
    trackQueryExecuted: true;
    trackFound: true;
    trackId: string;
    dbPath: string;
    matchedBy: string;
  };
}

export type DeckPipelineResult = DeckPipelineSuccess | DeckPipelineFailure;

/**
 * Baut den Deck-Track ausschließlich aus Daten, die das Master-DB-Gate
 * geliefert hat (ergänzt um zulässige Zusatzquellen).
 */
export function buildDeckTrackAfterGate(input: DeckPipelineInput): DeckPipelineResult {
  const { gate } = input;
  if (!gate || gate.ok !== true) {
    const code = gate && 'errorCode' in gate ? gate.errorCode : 'REKORDBOX_DB_GATE_FAILED';
    console.error(`[Pipeline] MASTER_DB_GATE_FAILED: ${code}`);
    return {
      ok: false,
      errorCode: code,
      reason:
        gate && 'reason' in gate
          ? gate.reason
          : 'Das Rekordbox-Master-DB-Gate wurde nicht erfolgreich durchlaufen.',
    };
  }

  const dbTrack = normalizeMasterDbTrack(gate.track);
  const merged = mergeRekordboxSources(dbTrack, input.supplementary ?? null);

  const duration =
    (Number.isFinite(input.audioDuration as number) && (input.audioDuration as number) > 0
      ? (input.audioDuration as number)
      : undefined) ?? merged.duration;

  if (!duration || duration <= 0) {
    return {
      ok: false,
      errorCode: 'MASTER_DB_TRACK_DURATION_MISSING',
      reason:
        'Die Master Database liefert für diesen Track keine verwertbare Dauer; es wird kein Wert erfunden.',
    };
  }

  const bpm = merged.bpm;
  const firstBeat =
    Number.isFinite(input.firstBeat as number) && (input.firstBeat as number) >= 0
      ? (input.firstBeat as number)
      : merged.beatGrid?.firstBeat ?? 0;

  // ---- Analysis-Priorität: ANLZ > Audioanalyse > Metadata-Fallback -------
  let analysis: WaveformAnalysisData | null = null;
  let analysisSource: AnalysisSource = 'NONE';

  if (input.anlzAnalysis) {
    analysis = input.anlzAnalysis;
    analysisSource = 'ANLZ';
    console.info('[RekordboxAnalysis] ANLZ available');
    console.info('[Waveform] using Rekordbox ANLZ analysis');
  } else if (input.audioAnalysis) {
    analysis = input.audioAnalysis;
    analysisSource = 'AUDIO_ANALYSIS';
    console.info('[RekordboxAnalysis] ANLZ unavailable – using original audio analysis');
  } else {
    console.info('[RekordboxAnalysis] ANLZ unavailable');
    console.info('[RekordboxAnalysis] using metadata fallback');
    analysis = generateAnalysisFromMetadata(duration, bpm ?? null, merged.cues ?? [], firstBeat);
    if (analysis) {
      analysisSource = 'METADATA_FALLBACK';
      console.info('[Waveform] metadata analysis generated');
    }
  }

  const gridBpm = bpm ?? merged.beatGrid?.bpm;
  const beatGrid = gridBpm
    ? buildBeatGridFromTempo(firstBeat, gridBpm, duration, merged.beatGrid?.meter ?? 4, DataOrigin.REKORDBOX_DB)
    : {
        firstBeat,
        bpm: 0,
        meter: 4,
        beats: [],
        origin: DataOrigin.REKORDBOX_DB,
      };

  const track: TrackModel = {
    ...(merged as TrackModel),
    id: gate.trackId,
    title: merged.title || gate.track.fileName || 'Rekordbox Track',
    artist: merged.artist || 'Unknown Artist',
    album: merged.album || '',
    bpm: bpm ?? 0,
    key: merged.key || '',
    duration,
    sampleRate: merged.sampleRate ?? 44100,
    channels: merged.channels ?? 2,
    originalSha256: merged.originalSha256 || 'NOT_COMPUTED_READ_ONLY_SOURCE',
    isOriginalUntouched: true,
    audioBuffer: merged.audioBuffer ?? null,
    beatGrid,
    cues: merged.cues ?? [],
    loops: merged.loops ?? [],
    analysis,
    phrases: merged.phrases ?? [],
    origin: DataOrigin.REKORDBOX_DB,
    workingSegments: [
      {
        id: `seg-db-${gate.trackId}`,
        type: 'ORIGINAL',
        trackId: gate.trackId,
        sourceStart: 0,
        sourceEnd: duration,
        projectStart: 0,
        projectDuration: duration,
        gain: 1.0,
      },
    ],
  };

  return {
    ok: true,
    track,
    analysisSource,
    provenance: {
      source: 'rekordbox-master-db',
      sqlcipher: true,
      databaseOpened: true,
      schemaValidated: true,
      trackQueryExecuted: true,
      trackFound: true,
      trackId: gate.trackId,
      dbPath: gate.dbPath,
      matchedBy: gate.matchedBy,
    },
  };
}
