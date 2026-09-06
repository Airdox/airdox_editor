/**
 * @license
 * Airdox_intelligents_Editor – Projektdatei
 *
 * Format für „Projekt speichern“ und „Projekt öffnen“. Rein und ohne DOM: dasselbe
 * Modul schreibt die Datei in der App und prüfen sie die Tests.
 *
 * Wichtig für die Projektregeln: die Datei enthält die *Arbeitskopie* (geschnittenes
 * Audio) und alle Marker, nicht die Originaldatei. Originale werden nur referenziert
 * (Pfad + Prüfsumme) und beim Öffnen nicht angefasst.
 */

import { PcmAudio, pcmDuration, pcmSampleCount } from '../audio/pcm';
import { decodeWav, encodeWav } from '../audio/wav';
import {
  BeatGrid,
  BeatNode,
  CuePoint,
  DataOrigin,
  EditOperationType,
  LoopPoint,
  OriginalMediaReference,
  PhraseSection,
  WaveformMode,
} from '../types/rekordbox';

export const PROJECT_KIND = 'airdox-intelligents-project';
export const PROJECT_SCHEMA = 1;
export const PROJECT_EXTENSION = 'airdoxproj.json';
export const PROJECT_FILTER_PATTERN = '*.airdoxproj.json;*.json';

export interface ProjectAudioBlock {
  /** 16-Bit-PCM-WAV, base64 – damit das Projekt ohne Originaldatei öffbar bleibt. */
  encoding: 'wav16+base64';
  base64: string;
  sampleRate: number;
  channels: number;
  samples: number;
  bytes: number;
  checksum: string;
  checksumAlgorithm: 'FNV-1a-64';
}

export interface ProjectSegment {
  id: string;
  type: EditOperationType;
  sourceStart: number;
  sourceEnd: number;
  projectStart: number;
  projectDuration: number;
  gain: number;
  clipId?: string;
}

export interface ProjectTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  label?: string;
  rating?: number;
  playCount?: number;
  year?: string;
  comments?: string;
  dateAdded?: string;
  remixer?: string;
  isrc?: string;
  key: string;
  bpm: number;
  duration: number;
  sampleRate: number;
  channels: number;
  origin: DataOrigin;
  originalSha256: string;
  isOriginalUntouched: boolean;
  /** Referenz auf die Originaldatei – Lesespur, niemals ein Schreibziel. */
  source?: OriginalMediaReference;
  audio: ProjectAudioBlock;
  cues: CuePoint[];
  loops: LoopPoint[];
  beatGrid: {
    firstBeat: number;
    bpm: number;
    meter: number;
    origin: DataOrigin;
    beats: BeatNode[];
  };
  phrases?: PhraseSection[];
  segments: ProjectSegment[];
}

export interface ProjectClip {
  id: string;
  name: string;
  sourceTrackId: string;
  sourceTrackName: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  beats: number;
  bars: number;
  bpm: number;
  key: string;
  color: string;
  origin: DataOrigin;
  audio: ProjectAudioBlock;
  miniPeaks: number[];
}

export interface ProjectFile {
  kind: typeof PROJECT_KIND;
  schema: number;
  app: { name: string; version: string };
  createdAt: string;
  projectName: string;
  activeTrackId: string;
  view: {
    waveformMode: WaveformMode;
    quantize: boolean;
    viewOffset: number;
    viewDuration: number;
    paletteOpen: boolean;
    /** Tempoangleichung beim Ablagen eines Clips (fehlt das Feld: an). */
    clipTempoMatch?: boolean;
    /** Tonhöhe folgt dem Tempo (fehlt das Feld: aus, Tonhöhe bleibt). */
    clipPitchFollow?: boolean;
    /** Aufgeklappte Deck-Ansicht der Clip-Bibliothek (fehlt das Feld: zu). */
    clipDeckOpen?: boolean;
  };
  tracks: ProjectTrack[];
  clips: ProjectClip[];
  provenance: {
    /** Zusage an die Nutzer: Originaldateien werden durch dieses Projekt nie verändert. */
    originalsModified: false;
    note: string;
  };
}

export interface ProjectParseResult {
  project: ProjectFile | null;
  errors: string[];
  warnings: string[];
}

/** Deterministischer, synchroner Inhaltswert (keine kryptografische Aussage). */
export function fnv1a64(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 = (Math.imul(h2 ^ bytes[i], 0x85ebca6b) + (h2 >>> 13)) >>> 0;
  }
  return `fnv1a64-${(h1 >>> 0).toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function encodeAudioBlock(pcm: PcmAudio): ProjectAudioBlock {
  const wav = encodeWav(pcm);
  return {
    encoding: 'wav16+base64',
    base64: toBase64(wav),
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.length,
    samples: pcmSampleCount(pcm),
    bytes: wav.length,
    checksum: fnv1a64(wav),
    checksumAlgorithm: 'FNV-1a-64',
  };
}

export function decodeAudioBlock(block: ProjectAudioBlock): { pcm: PcmAudio; warning?: string } {
  const bytes = fromBase64(block.base64);
  const { pcm, warnings } = decodeWav(bytes);
  const notes: string[] = [...warnings];
  if (pcmSampleCount(pcm) !== block.samples) {
    notes.push(`Protokoll sagt ${block.samples} Samples, Datei enthält ${pcmSampleCount(pcm)}.`);
  }
  if (pcm.sampleRate !== block.sampleRate) {
    notes.push(`Samplingrate abweichend: ${pcm.sampleRate} statt ${block.sampleRate} Hz.`);
  }
  const actual = fnv1a64(bytes);
  if (block.checksum && actual !== block.checksum) {
    notes.push(`Prüfsumme der eingebetteten Audiodaten weicht ab (${actual}).`);
  }
  return { pcm, warning: notes.length > 0 ? notes.join(' ') : undefined };
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Dauer (Sekunden) aus einem Audio-Block, ohne die Audiodaten zu entpacken. */
export function audioBlockDuration(block: ProjectAudioBlock): number {
  return block.samples / block.sampleRate;
}

function sanitizeNumber(value: unknown, fallback: number, name: string, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`Feld „${name}" ist keine Zahl (${JSON.stringify(value)}), ${fallback} wird benutzt.`);
    return fallback;
  }
  return value;
}

export interface ProjectDraftInput {
  projectName: string;
  activeTrackId: string;
  view: ProjectFile['view'];
  tracks: Array<Omit<ProjectTrack, 'audio'> & { pcm: PcmAudio }>;
  clips: Array<Omit<ProjectClip, 'audio'> & { pcm: PcmAudio }>;
  app: { name: string; version: string };
}

export function buildProjectFile(input: ProjectDraftInput): ProjectFile {
  return {
    kind: PROJECT_KIND,
    schema: PROJECT_SCHEMA,
    app: input.app,
    createdAt: new Date().toISOString(),
    projectName: input.projectName,
    activeTrackId: input.activeTrackId,
    view: input.view,
    tracks: input.tracks.map(({ pcm, ...rest }) => ({
      ...rest,
      duration: Math.round(pcmDuration(pcm) * 1e6) / 1e6,
      sampleRate: pcm.sampleRate,
      channels: pcm.channels.length,
      audio: encodeAudioBlock(pcm),
    })),
    clips: input.clips.map(({ pcm, ...rest }) => ({
      ...rest,
      audio: encodeAudioBlock(pcm),
    })),
    provenance: {
      originalsModified: false,
      note:
        'Enthält nur die Arbeitskopie des Editors. Originaldateien (Rekordbox-Medien, ' +
        'master.db, exportLibrary.db) werden nie geöffnet, geschrieben oder verschoben.',
    },
  };
}

export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Liest und validiert eine Projektdatei. Fehlerhafte Projekte werden abgelehnt,
 * Auffälligkeiten (etwa abweichende Prüfsummen) als Warnungen zurückgegeben.
 */
export function parseProject(text: string): ProjectParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { project: null, errors: [`Kein gültiges JSON: ${(err as Error).message}`], warnings };
  }
  if (!raw || typeof raw !== 'object') {
    return { project: null, errors: ['Datei enthält kein JSON-Objekt.'], warnings };
  }
  const data = raw as Record<string, any>;
  if (data.kind !== PROJECT_KIND) {
    return {
      project: null,
      errors: [
        `Das ist kein Airdox-Projekt (Art „${String(data.kind ?? 'unbekannt')}" statt „${PROJECT_KIND}").`,
      ],
      warnings,
    };
  }
  if (typeof data.schema !== 'number' || data.schema > PROJECT_SCHEMA) {
    return {
      project: null,
      errors: [
        `Projektschema ${String(data.schema)} kann nicht gelesen werden (diese App kennt bis ${PROJECT_SCHEMA}).`,
      ],
      warnings,
    };
  }
  if (data.schema < PROJECT_SCHEMA) {
    warnings.push(`Projekt hat Schema ${data.schema}; es wird ohne Änderung der Daten gelesen.`);
  }
  if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
    errors.push('Das Projekt enthält keine Spuren.');
  }

  const tracks: ProjectTrack[] = [];
  (Array.isArray(data.tracks) ? data.tracks : []).forEach((entry: any, index: number) => {
    const label = `Spur ${index + 1}`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label}: kein Objekt.`);
      return;
    }
    const block = entry.audio as ProjectAudioBlock | undefined;
    if (!block || typeof block.base64 !== 'string' || block.base64.length === 0) {
      errors.push(`${label}: eingebettete Audiodaten fehlen.`);
      return;
    }
    if (block.encoding !== 'wav16+base64') {
      errors.push(`${label}: unbekanntes Audioformat „${String(block.encoding)}".`);
      return;
    }
    const bpm = sanitizeNumber(entry.bpm, 128, `${label}.bpm`, errors);
    const sampleRate = sanitizeNumber(entry.sampleRate, 44100, `${label}.sampleRate`, errors);
    if (bpm <= 0) errors.push(`${label}: BPM muss > 0 sein.`);
    if (sampleRate <= 0) errors.push(`${label}: Samplingrate muss > 0 sein.`);

    const beats: BeatNode[] = Array.isArray(entry.beatGrid?.beats)
      ? entry.beatGrid.beats.map((b: any, i: number) => ({
          index: typeof b.index === 'number' ? b.index : i,
          time: Number.isFinite(b.time) ? b.time : 0,
          isBarStart: Boolean(b.isBarStart),
          barNumber: Number.isFinite(b.barNumber) ? b.barNumber : Math.floor(i / 4) + 1,
          beatInBar: Number.isFinite(b.beatInBar) ? b.beatInBar : (i % 4) + 1,
        }))
      : [];
    if (beats.length === 0) {
      warnings.push(`${label}: Beatgrid ist leer – es wird aus BPM neu aufgebaut.`);
    }

    tracks.push({
      id: String(entry.id ?? `track-${index}`),
      title: String(entry.title ?? 'Ohne Titel'),
      artist: String(entry.artist ?? 'Unbekannt'),
      album: String(entry.album ?? ''),
      genre: entry.genre,
      label: entry.label,
      rating: entry.rating,
      playCount: entry.playCount,
      year: entry.year,
      comments: entry.comments,
      dateAdded: entry.dateAdded,
      remixer: entry.remixer,
      isrc: entry.isrc,
      key: String(entry.key ?? '2A'),
      bpm,
      duration: sanitizeNumber(entry.duration, 0, `${label}.duration`, errors),
      sampleRate,
      channels: sanitizeNumber(entry.channels, 2, `${label}.channels`, errors),
      origin: (entry.origin as DataOrigin) ?? DataOrigin.PROJECT,
      originalSha256: String(entry.originalSha256 ?? ''),
      isOriginalUntouched: entry.isOriginalUntouched !== false,
      source: entry.source,
      audio: block,
      cues: Array.isArray(entry.cues) ? entry.cues : [],
      loops: Array.isArray(entry.loops) ? entry.loops : [],
      beatGrid: {
        firstBeat: Number.isFinite(entry.beatGrid?.firstBeat) ? entry.beatGrid.firstBeat : 0,
        bpm: Number.isFinite(entry.beatGrid?.bpm) ? entry.beatGrid.bpm : bpm,
        meter: Number.isFinite(entry.beatGrid?.meter) ? Math.max(1, Math.floor(entry.beatGrid.meter)) : 4,
        origin: entry.beatGrid?.origin ?? DataOrigin.PROJECT,
        beats,
      },
      phrases: Array.isArray(entry.phrases) ? entry.phrases : [],
      segments: Array.isArray(entry.segments) ? entry.segments : [],
    });
  });

  const clips: ProjectClip[] = (Array.isArray(data.clips) ? data.clips : []).map((entry: any, index: number) => {
    if (!entry?.audio?.base64) {
      warnings.push(`Clip ${index + 1} hat keine Audiodaten und wird ohne Klang geladen.`);
    }
    return {
      id: String(entry?.id ?? `clip-${index}`),
      name: String(entry?.name ?? `Clip ${index + 1}`),
      sourceTrackId: String(entry?.sourceTrackId ?? ''),
      sourceTrackName: String(entry?.sourceTrackName ?? ''),
      sourceStart: Number(entry?.sourceStart) || 0,
      sourceEnd: Number(entry?.sourceEnd) || 0,
      duration: Number(entry?.duration) || 0,
      beats: Number(entry?.beats) || 0,
      bars: Number(entry?.bars) || 0,
      bpm: Number(entry?.bpm) || 128,
      key: String(entry?.key ?? '2A'),
      color: String(entry?.color ?? '#ff9500'),
      origin: (entry?.origin as DataOrigin) ?? DataOrigin.PROJECT,
      audio: entry?.audio as ProjectAudioBlock,
      miniPeaks: Array.isArray(entry?.miniPeaks) ? entry.miniPeaks : [],
    };
  });

  const project: ProjectFile = {
    kind: PROJECT_KIND,
    schema: PROJECT_SCHEMA,
    app: {
      name: String(data.app?.name ?? 'unbekannt'),
      version: String(data.app?.version ?? '0'),
    },
    createdAt: String(data.createdAt ?? ''),
    projectName: String(data.projectName ?? 'Ohne Namen'),
    activeTrackId: String(data.activeTrackId ?? tracks[0]?.id ?? ''),
    view: {
      waveformMode: (['BLUE', 'RGB', '3BAND', 'AMBER'].includes(data.view?.waveformMode)
        ? data.view.waveformMode
        : 'AMBER') as WaveformMode,
      quantize: data.view?.quantize !== false,
      viewOffset: Number(data.view?.viewOffset) || 0,
      viewDuration: Number(data.view?.viewDuration) || 18,
      paletteOpen: data.view?.paletteOpen !== false,
      // Fehlende Felder (ältere Projektdateien) bedeuten die Standard-Schalter.
      clipTempoMatch: data.view?.clipTempoMatch !== false,
      clipPitchFollow: data.view?.clipPitchFollow === true,
      clipDeckOpen: data.view?.clipDeckOpen === true,
    },
    tracks,
    clips,
    provenance: {
      originalsModified: false,
      note: String(data.provenance?.note ?? 'Keine Herkunftsangabe in der Datei.'),
    },
  };

  if (data.provenance?.originalsModified === true) {
    errors.push('Die Datei meldet veränderte Originale – Import abgebrochen.');
  }
  if (!data.activeTrackId && tracks.length > 0) {
    warnings.push('Keine aktive Spur markiert; die erste Spur wird geöffnet.');
  }

  return { project: errors.length > 0 ? null : project, errors, warnings };
}

/** Dateiname für ein Projekt (ohne Pfad, ohne Doppelendung). */
export function projectFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const base = cleaned.length > 0 ? cleaned : 'projekt';
  return base.endsWith(`.${PROJECT_EXTENSION}`) ? base : `${base}.${PROJECT_EXTENSION}`;
}
