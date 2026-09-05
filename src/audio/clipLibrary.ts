/**
 * @license
 * Clip-Bibliothek: der gemeinsame Kern für alle Clips
 *
 * Alles, was mit Clips passiert – anlegen, reparieren, umbenennen, duplizieren,
 * sortieren, per Drag & Drop übertragen und an einer Zielposition einfügen – läuft
 * über diese Module. Sie sind frei von React und DOM, damit dieselben Funktionen
 * getestet werden, die auch in der App laufen (siehe tests/clip-library.test.ts).
 *
 * Wichtigste Zusage: ein Clip ist *immer* selbsterklärend. Er trägt seine Samples
 * (clipPcm), seine Mini-Peaks für die Vorschau, Dauer, Beat-/Taktzahl und die
 * Herkunft. Ein Clip aus einer Projektdatei, aus einer Spur oder aus dem
 * Drag-&-Drop-Weg sieht danach identisch aufgebaut.
 */

import { BeatGrid, DataOrigin, PaletteClip } from '../types/rekordbox';
import { PcmAudio, pcmDuration, pcmSampleCount } from './pcm';
import { extractMiniPeaksPcm } from '../waveform/analyzer';
import { EditableAudio, EditReport, insertClipAt, overdubRange, replaceRange, snapToGrid } from './editOps';

/** MIME-Typ des Drag-&-Drop-Payloads (eine einzige Quelle, keine Raterei). */
export const CLIP_DND_MIME = 'application/x-airdox-clip';

/** Beschriftung der Bibliothek – überall identisch (Panel, Menüs, tooltips). */
export const CLIP_LIBRARY_LABEL = 'Clip-Bibliothek';

/** Anzahl Vorschau-Buckets pro Clip-Eintrag. */
export const CLIP_MINI_PEAK_BUCKETS = 48;

/** Farbfolge für neue Clips: bernsteinfarben zuerst, danach die Rekordbox-Töne. */
export const CLIP_COLORS = ['#ff9500', '#ffb74d', '#f2c14e', '#7ad3a2', '#5bb8ff', '#b98bff', '#ff6b6b'];

export type ClipDropMode = 'insert' | 'overdub' | 'replace' | 'deck';

/** Beschreibung der Drop-Absicht (Tastenzustand beim Loslassen). */
export function dropModeFor(modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): ClipDropMode {
  if (modifiers.altKey) return 'overdub';
  if (modifiers.shiftKey) return 'replace';
  if (modifiers.ctrlKey || modifiers.metaKey) return 'deck';
  return 'insert';
}

export const CLIP_DROP_LABELS: Record<ClipDropMode, string> = {
  insert: 'einfügen (Timeline schiebt sich nach rechts)',
  overdub: 'darüberlegen (Alt)',
  replace: 'Bereich ersetzen (Umschalt)',
  deck: 'in den Deck-Spieler laden (Strg)',
};

// ── Payload ────────────────────────────────────────────────────────────────

export function encodeClipDragPayload(clipId: string): string {
  return JSON.stringify({ kind: 'airdox.clip', id: clipId });
}

/** Liest den Clip aus einem DataTransfer-artigen Objekt; null bei Fremdinhalten. */
export function readClipDragPayload(
  transfer: { getData: (type: string) => string; types?: readonly string[] } | null | undefined
): { clipId: string } | null {
  if (!transfer) return null;
  let raw = '';
  try {
    raw = transfer.getData(CLIP_DND_MIME);
  } catch {
    raw = '';
  }
  if (!raw) {
    // Einige Webviews reichen nur text/plain durch – dann akzeptieren wir genau
    // unser Erkennungsmerkmal, niemals fremde Texte.
    const fallback = (() => {
      try {
        return transfer.getData('text/plain');
      } catch {
        return '';
      }
    })();
    if (!fallback.trimStart().startsWith('{')) return null;
    raw = fallback;
  }
  try {
    const value = JSON.parse(raw) as { kind?: unknown; id?: unknown };
    if (value?.kind !== 'airdox.clip' || typeof value.id !== 'string' || !value.id) return null;
    return { clipId: value.id };
  } catch {
    return null;
  }
}

// ── Aufbau und Reparatur ───────────────────────────────────────────────────

export interface ClipDraft {
  id?: string;
  name: string;
  sourceTrackId: string;
  sourceTrackName: string;
  sourceStart: number;
  sourceEnd: number;
  bpm: number;
  key: string;
  meter?: number;
  origin?: DataOrigin;
  pcm: PcmAudio;
}

export function clipAudioOf(clip: PaletteClip): PcmAudio | null {
  if (clip.clipPcm && pcmSampleCount(clip.clipPcm) > 0) return clip.clipPcm;
  const buffer = clip.audioBuffer;
  if (!buffer || buffer.length === 0) return null;
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch)),
  };
}

/** Eindeutiger Name in der Bibliothek („Clip 3 (Kopie)“, „Clip 3 (Kopie 2)“ …). */
export function uniqueClipName(clips: PaletteClip[], wanted: string, exceptId?: string): string {
  const taken = new Set(clips.filter((clip) => clip.id !== exceptId).map((clip) => clip.name.trim().toLowerCase()));
  const base = wanted.trim() || 'Clip';
  if (!taken.has(base.toLowerCase())) return base;
  const match = /^(.*?)\s*(?:\(Kopie(?: (\d+))?\))?$/.exec(base);
  const stem = (match?.[1] || base).trim() || 'Clip';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem} (Kopie)` : `${stem} (Kopie ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})`;
}

/**
 * Erzeugt einen vollständigen Clip aus einem Entwurf. Dauer, Beat-/Taktzahl,
 * Mini-Peaks und Farbe werden immer neu berechnet – nie aus Unsicherem übernommen.
 */
export function buildClip(draft: ClipDraft, options: { existing?: PaletteClip[]; id?: string } = {}): PaletteClip {
  const pcm = draft.pcm;
  const sampleRate = pcm.sampleRate || 44100;
  const duration = Math.max(0, pcmDuration(pcm));
  const bpm = draft.bpm > 0 ? draft.bpm : 128;
  const meter = Math.max(1, draft.meter ?? 4);
  const beats = duration > 0 ? Math.round((duration / (60 / bpm)) * 100) / 100 : 0;
  const start = Number.isFinite(draft.sourceStart) ? Math.max(0, draft.sourceStart) : 0;
  const end = Number.isFinite(draft.sourceEnd) && draft.sourceEnd > start ? draft.sourceEnd : start + duration;
  const id = options.id ?? draft.id ?? nextClipId(options.existing ?? []);
  const name = uniqueClipName(options.existing ?? [], draft.name.trim() || 'Clip', id);
  const colorIndex = (options.existing?.length ?? 0) % CLIP_COLORS.length;

  return {
    id,
    name,
    sourceTrackId: draft.sourceTrackId,
    sourceTrackName: draft.sourceTrackName,
    sourceStart: start,
    sourceEnd: end,
    duration: Math.round(duration * 1e6) / 1e6,
    beats,
    bars: Math.round((beats / meter) * 100) / 100,
    bpm,
    key: draft.key || '–',
    color: CLIP_COLORS[colorIndex],
    clipPcm: pcm,
    miniPeaks: extractMiniPeaksPcm(pcm, CLIP_MINI_PEAK_BUCKETS),
    origin: draft.origin ?? DataOrigin.PROJECT,
  };
}

/**
 * Repariert einen Clip aus Fremdbestand (Projektdatei, ältere Stände): Samples,
 * Dauer, Beat-Zahlen und Vorschau werden aus dem vorhandenen Audiomaterial
 * nachgerechnet. Wirft, wenn gar keine Samples vorhanden sind.
 */
export function ensureConsistentClip(clip: PaletteClip, options: { bpm?: number } = {}): PaletteClip {
  const audio = clipAudioOf(clip);
  if (!audio || pcmSampleCount(audio) === 0) {
    throw new Error(`Clip „${clip.name}“ enthält keine Audiodaten.`);
  }
  const duration = Math.max(0, pcmDuration(audio));
  const bpm = clip.bpm > 0 ? clip.bpm : (options.bpm ?? 0) > 0 ? options.bpm! : 128;
  const beats = duration > 0 ? Math.round((duration / (60 / bpm)) * 100) / 100 : 0;
  const peaks =
    clip.miniPeaks && clip.miniPeaks.length === CLIP_MINI_PEAK_BUCKETS
      ? clip.miniPeaks
      : extractMiniPeaksPcm(audio, CLIP_MINI_PEAK_BUCKETS);

  return {
    ...clip,
    duration: Math.round(duration * 1e6) / 1e6,
    bpm,
    beats,
    bars: Math.round((beats / 4) * 100) / 100,
    sourceEnd: clip.sourceEnd > clip.sourceStart ? clip.sourceEnd : clip.sourceStart + duration,
    clipPcm: audio,
    miniPeaks: peaks,
    color: clip.color || CLIP_COLORS[0],
    name: clip.name?.trim() || 'Clip',
  };
}

export function nextClipId(clips: PaletteClip[]): string {
  let n = clips.length + 1;
  const ids = new Set(clips.map((clip) => clip.id));
  while (ids.has(`clip-${n}`)) n++;
  return `clip-${n}`;
}

// ── Bibliotheks-Operationen (rein, ohne React) ────────────────────────────

/**
 * Setzt einen Clip an das Ende der Bibliothek – der einzige Anlage-Weg. IDs und
 * Namen bleiben eindeutig, auch wenn dasselbe Material zweimal abgelegt wird.
 */
export function addClip(clips: PaletteClip[], clip: PaletteClip): PaletteClip[] {
  return [...clips, { ...clip, id: freeClipId(clips, clip.id), name: uniqueClipName(clips, clip.name) }];
}

function freeClipId(clips: PaletteClip[], wanted: string): string {
  const taken = new Set(clips.map((clip) => clip.id));
  const base = wanted?.trim() || nextClipId(clips);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Bringt eine ganze Bibliothek in Ordnung – nach dem Öffnen einer Projektdatei
 * oder einem Import: jedes Mitglied wird aufgefrischt, IDs und Namen werden
 * eindeutig. Clips ohne Audiodaten fallen heraus und werden gemeldet, statt
 * halbleere Einträge zu hinterlassen.
 */
export function normalizeLibrary(
  clips: PaletteClip[],
  options: { bpm?: number } = {}
): { clips: PaletteClip[]; dropped: Array<{ name: string; reason: string }> } {
  const out: PaletteClip[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];
  for (const clip of clips) {
    let repaired: PaletteClip;
    try {
      repaired = ensureConsistentClip(clip, options);
    } catch (err) {
      dropped.push({ name: clip.name?.trim() || 'Clip ohne Namen', reason: (err as Error).message });
      continue;
    }
    const id = freeClipId(out, repaired.id);
    out.push({ ...repaired, id, name: uniqueClipName(out, repaired.name, id) });
  }
  return { clips: out, dropped };
}

export function removeClip(clips: PaletteClip[], id: string): PaletteClip[] {
  return clips.filter((clip) => clip.id !== id).map((clip, index) => ({ ...clip, color: clip.color || CLIP_COLORS[index % CLIP_COLORS.length] }));
}

export function renameClip(clips: PaletteClip[], id: string, name: string): PaletteClip[] {
  return clips.map((clip) => (clip.id === id ? { ...clip, name: name.trim() || clip.name } : clip));
}

export function duplicateClip(clips: PaletteClip[], id: string, takenIds?: Set<string>): PaletteClip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return clips;
  const source = clips[index];
  let n = 1;
  const isTaken = (candidate: string) => clips.some((clip) => clip.id === candidate) || takenIds?.has(candidate);
  let newId = `${source.id}-kopie`;
  while (isTaken(newId)) newId = `${source.id}-kopie-${++n}`;
  const copy: PaletteClip = {
    ...source,
    id: newId,
    name: uniqueClipName(clips, `${source.name} (Kopie)`),
    clipPcm: source.clipPcm
      ? {
          sampleRate: source.clipPcm.sampleRate,
          channels: source.clipPcm.channels.map((channel) => Float32Array.from(channel)),
        }
      : source.clipPcm,
  };
  const next = [...clips];
  next.splice(index + 1, 0, copy);
  return next;
}

export function moveClip(clips: PaletteClip[], id: string, delta: number): PaletteClip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return clips;
  const target = Math.min(clips.length - 1, Math.max(0, index + delta));
  if (target === index) return clips;
  const next = [...clips];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Ordnungsgemäße Nummerierung der Bibliothek (für Exportnamen und Beschriftung). */
export function clipDisplayIndex(clips: PaletteClip[], id: string): number {
  const index = clips.findIndex((clip) => clip.id === id);
  return index < 0 ? 0 : index + 1;
}

// ── Zielzeit für Drop und Einfügen ─────────────────────────────────────────

/**
 * Wo darf der Clip landen? Rückgabe ist immer innerhalb der Spur und – wenn
 * Quantize an ist – auf dem Raster. Bei `insert` wird nach rechts aufgerastet,
 * damit der Clip nicht mitten im Takt anfängt; `overdub`/`replace` rasten auf
 * den nächstgelegenen Beat.
 */
export function resolveClipTargetTime(
  wantedSeconds: number,
  grid: BeatGrid | null | undefined,
  options: { quantize?: boolean; mode?: ClipDropMode; maxSeconds?: number } = {}
): { seconds: number; snapped: boolean; reason?: string } {
  const mode = options.mode ?? 'insert';
  const floor = Math.max(0, wantedSeconds);
  if (!grid || options.quantize === false) {
    const clamped = clampToTrack(floor, options.maxSeconds, 0);
    return { seconds: clamped, snapped: clamped !== floor };
  }
  const direction = mode === 'insert' ? 'up' : 'nearest';
  const snapMode = mode === 'insert' || mode === 'replace' ? 'bar' : 'beat';
  const snapped = snapToGrid(grid, floor, snapMode, direction);
  const ceiling =
    mode === 'insert' ? options.maxSeconds : options.maxSeconds !== undefined ? options.maxSeconds - 1e-9 : undefined;
  let seconds = clampToTrack(snapped.seconds, ceiling, floor);
  if (ceiling !== undefined && snapped.seconds > ceiling && floor <= ceiling) {
    // Raster liegt außerhalb der Spur – dann mindestens an den gültigen Rand.
    seconds = clampToTrack(snapped.seconds - secondsPerBeatSafe(grid), ceiling, floor);
  }
  return {
    seconds,
    snapped: Math.abs(seconds - floor) > 1e-9 || snapped.snapped,
    reason: snapped.snapped ? (snapMode === 'bar' ? 'auf Taktanfang gerastet' : 'auf Beat gerastet') : undefined,
  };
}

function secondsPerBeatSafe(grid: BeatGrid): number {
  return grid.bpm > 0 ? 60 / grid.bpm : 0.5;
}

function clampToTrack(seconds: number, maxSeconds: number | undefined, fallback: number): number {
  if (maxSeconds === undefined) return Math.max(0, seconds);
  if (maxSeconds <= 0) return Math.max(0, fallback);
  return Math.min(Math.max(0, seconds), Math.max(0, maxSeconds - 1e-9) || maxSeconds);
}

/** Knapper Beschreibungstext für Rückmeldung und Protokoll. */
export function describeClip(clip: PaletteClip): string {
  const samples = clip.clipPcm ? pcmSampleCount(clip.clipPcm) : 0;
  return (
    `${clip.name}: ${clip.duration.toFixed(3)} s, ${clip.beats} Beats (${clip.bars} Takte) @ ${clip.bpm.toFixed(1)} BPM, ` +
    `${clip.key}, ${samples} Samples @ ${clip.clipPcm?.sampleRate ?? 0} Hz`
  );
}

// ── Ablage auf die Zeitachse (der eigentliche Clip-Drop) ──────────────────

export interface ClipDropOutcome {
  mode: ClipDropMode;
  target: EditableAudio;
  report: EditReport;
  /** Endgültige Zielzeit in Sekunden (nach Rasterung und Klemmung). */
  atSeconds: number;
  snapped: boolean;
  reason?: string;
  clipEndSeconds: number;
}

/**
 * Was beim Ablagen eines Clips auf die Zeitachse passiert – genau diese Funktion
 * ruft auch die App, damit das Geprüfte und das Genutzte identisch sind.
 *
 * insert:  Timeline schiebt sich nach rechts, Rest der Spur bleibt erhalten
 * overdub: Clip wird über den vorhandenen Bereich gemischt (Länge gleich)
 * replace: Bereich wird getauscht (Länge = Clip, Rest rückt nicht)
 */
export function applyClipDrop(
  track: EditableAudio,
  clipAudio: PcmAudio,
  wantedSeconds: number,
  options: { quantize?: boolean; mode: Exclude<ClipDropMode, 'deck'> }
): ClipDropOutcome {
  const trackEnd = pcmDuration(track.audio);
  const clipLength = pcmDuration(clipAudio);
  const mode = options.mode;
  const placed = resolveClipTargetTime(wantedSeconds, track.beatGrid, {
    quantize: options.quantize,
    mode,
    maxSeconds: mode === 'insert' ? Number.POSITIVE_INFINITY : trackEnd,
  });
  const at = placed.seconds;
  const end = Math.min(trackEnd, at + clipLength);

  let outcome: { target: EditableAudio; report: EditReport };
  if (mode === 'insert') {
    outcome = insertClipAt(track, at, clipAudio);
  } else if (mode === 'replace') {
    outcome = replaceRange(track, at, Math.max(end, at + 1 / (clipAudio.sampleRate || 44100)), clipAudio);
  } else {
    outcome = overdubRange(track, at, Math.max(end, at + 1 / (clipAudio.sampleRate || 44100)), clipAudio, 0.85);
  }

  return {
    mode,
    target: outcome.target,
    report: outcome.report,
    atSeconds: at,
    snapped: placed.snapped,
    reason: placed.reason,
    clipEndSeconds: at + clipLength,
  };
}

/** Beschriftung für Rückmeldung und Protokoll. */
export function clipDropTitle(clip: PaletteClip, mode: ClipDropMode): string {
  if (mode === 'insert') return `Clip eingefügt: ${clip.name}`;
  if (mode === 'replace') return `Clip ersetzt Bereich: ${clip.name}`;
  if (mode === 'overdub') return `Clip überlagert: ${clip.name}`;
  return `Clip im Deck-Spieler: ${clip.name}`;
}
