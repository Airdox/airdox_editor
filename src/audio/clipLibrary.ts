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
import { PcmAudio, pcmDuration, pcmPeak, pcmSampleCount, pcmScale } from './pcm';
import { extractMiniPeaksPcm } from '../waveform/analyzer';
import { averageSecondsPerBeat } from './editOps';
import {
  EditableAudio,
  EditReport,
  OverdubOutcome,
  insertClipAt,
  overdubRange,
  replaceRange,
  snapToGrid,
} from './editOps';
import { TempoFitReport, fitToTempo, planTempoFit, tempoFitNote } from './timeStretch';

/** MIME-Typ des Drag-&-Drop-Payloads (eine einzige Quelle, keine Raterei). */
export const CLIP_DND_MIME = 'application/x-airdox-clip';

/** Beschriftung der Bibliothek – überall identisch (Panel, Menüs, tooltips). */
export const CLIP_LIBRARY_LABEL = 'Clip-Bibliothek';

/** Anzahl Vorschau-Buckets pro Clip-Eintrag. */
export const CLIP_MINI_PEAK_BUCKETS = 48;

/** Farbfolge für neue Clips: bernsteinfarben zuerst, danach die Rekordbox-Töne. */
export const CLIP_COLORS = ['#ff9500', '#ffb74d', '#f2c14e', '#7ad3a2', '#5bb8ff', '#b98bff', '#ff6b6b'];

export type ClipDropMode = 'insert' | 'overdub' | 'replace' | 'deck';

// ── Pegel: Normalisierung und Übersteuerungsschutz ────────────────────────

/**
 * Ziel-Pegelspitze eines Clips, bevor er in eine Spur kommt. 0,89 sind −1 dBFS:
 * laut genug, um in einer bereits vollen Spur zu sitzen, aber mit genug Luft,
 * dass ein darübergelegter Overdub nicht sofort übersteuert.
 */
export const CLIP_NORM_TARGET_PEAK = 0.89;

/** Höchstens so viel Lautstärke wird zugegeben – sonst wird der Rauschtebel mit hochgezogen. */
export const CLIP_NORM_MAX_GAIN_DB = 12;

/** Harte Obergrenze für jede Summe; kein Sample einer Änderung liegt danach darüber. */
export const CLIP_HEADROOM_CEILING = 0.999;

/** Linearer Pegelwert zu dBFS (0 → −∞). */
export function toDbfs(peak: number): number {
  return peak > 0 ? 20 * Math.log10(Math.min(1, peak)) : Number.NEGATIVE_INFINITY;
}

export function fromDbfs(db: number): number {
  return Math.pow(10, db / 20);
}

export interface ClipGainReport {
  /** Verstärkung, die auf den Clip angewendet wurde (1 = unverändert) */
  gain: number;
  gainDb: number;
  peakBefore: number;
  peakAfter: number;
  targetPeak: number;
  ceiling: number;
  /** true, wenn die Samples wirklich angefasst wurden */
  applied: boolean;
  /** warum nicht? */
  skipped?: 'stumm' | 'über ziel' | 'ziel nicht erreichbar' | 'aus';
  note?: string;
  /**
   * Spitze direkt nach der Tempoangleichung, bevor der letzte Zug kam. Der
   * Vocoder verbreitert Impulse – dadurch kann die Spitze über das Ziel wandern,
   * obwohl der Clip vorher sauber aussteuerte.
   */
  peakAfterStretch?: number;
  /** Faktor des letzten Zugs nach der Tempoangleichung (1 = nicht nötig). */
  postStretchGain?: number;
}

/** Größter Ausschlag eines Clips – für Bibliothek, Tooltip und Menü. */
export function clipPeakOf(clip: PaletteClip): number {
  const audio = clipAudioOf(clip);
  return audio ? pcmPeak(audio) : 0;
}

/** Knapper Pegeltext, z. B. „Peak 0,412 (−7,7 dBFS) → 0,890 (−1,0 dBFS), +6,8 dB“. */
export function describeClipLevel(clip: PaletteClip, targetPeak = CLIP_NORM_TARGET_PEAK): string {
  const peak = clipPeakOf(clip);
  if (peak <= 0) return 'Peak 0 (stumm)';
  const plan = planClipGain(peak, targetPeak);
  const ziel = plan.gain === 1 ? peak : Math.min(targetPeak, peak * plan.gain);
  return (
    `Peak ${peak.toFixed(3)} (${fmtDb(toDbfs(peak))} dBFS) → ${ziel.toFixed(3)} (${fmtDb(toDbfs(ziel))} dBFS), ` +
    `${fmtDb(20 * Math.log10(plan.gain || 1))} dB${plan.limited ? ' (begrenzt)' : ''}`
  );
}

function fmtDb(value: number): string {
  if (!Number.isFinite(value)) return '−∞';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}

/**
 * Wie stark darf der Clip angehoben werden? Begrenzt auf das Ziel und auf
 * CLIP_NORM_MAX_GAIN dB – ein fast stiller Clip wird nicht auf Gebrüll gezogen.
 */
export function planClipGain(
  peakBefore: number,
  targetPeak = CLIP_NORM_TARGET_PEAK,
  maxGainDb = CLIP_NORM_MAX_GAIN_DB
): { gain: number; limited: boolean } {
  if (!(peakBefore > 0)) return { gain: 1, limited: false };
  const wanted = targetPeak / peakBefore;
  const cap = fromDbfs(maxGainDb);
  if (wanted <= 1) return { gain: 1, limited: false };
  if (wanted > cap) return { gain: cap, limited: true };
  return { gain: wanted, limited: false };
}

/**
 * Normalisiert Audiomaterial auf den Ziel-Pegel. Gibt neue Samples zurück – das
 * Original (und damit der Bibliotheks-Eintrag) bleibt unberührt.
 */
export function normalizeClipAudio(
  pcm: PcmAudio,
  options: { targetPeak?: number; maxGainDb?: number; enabled?: boolean } = {}
): { pcm: PcmAudio; report: ClipGainReport } {
  const targetPeak = options.targetPeak ?? CLIP_NORM_TARGET_PEAK;
  const maxGainDb = options.maxGainDb ?? CLIP_NORM_MAX_GAIN_DB;
  const before = pcmPeak(pcm);
  const base: ClipGainReport = {
    gain: 1,
    gainDb: 0,
    peakBefore: before,
    peakAfter: before,
    targetPeak,
    ceiling: CLIP_HEADROOM_CEILING,
    applied: false,
  };
  if (options.enabled === false) return { pcm, report: { ...base, skipped: 'aus' } };
  if (!(before > 0)) return { pcm, report: { ...base, skipped: 'stumm', note: 'Der Clip ist still – es gibt nichts anzupassen.' } };
  if (before >= targetPeak) {
    return {
      pcm,
      report: {
        ...base,
        skipped: 'über ziel',
        note: `Peak ${before.toFixed(3)} liegt bereits über dem Ziel ${targetPeak.toFixed(3)} – der Clip wird nicht lauter, beim Überlagern greift der Kopfraum.`,
      },
    };
  }
  const plan = planClipGain(before, targetPeak, maxGainDb);
  const scaled = pcmScale(pcm, plan.gain);
  const after = pcmPeak(scaled);
  return {
    pcm: scaled,
    report: {
      gain: plan.gain,
      gainDb: 20 * Math.log10(plan.gain),
      peakBefore: before,
      peakAfter: after,
      targetPeak,
      ceiling: CLIP_HEADROOM_CEILING,
      applied: Math.abs(plan.gain - 1) > 1e-12,
      skipped: plan.gain >= 1 && after < targetPeak ? 'ziel nicht erreichbar' : undefined,
      note: plan.limited
        ? `Anhebung auf ${CLIP_NORM_MAX_GAIN_DB.toFixed(0)} dB begrenzt – Peak danach ${after.toFixed(3)}.`
        : undefined,
    },
  };
}

/** Pegelangleichung direkt am Bibliotheks-Eintrag (Vorschau wird mitgerechnet). */
export function normalizeClip(
  clip: PaletteClip,
  options: { targetPeak?: number; maxGainDb?: number } = {}
): { clip: PaletteClip; report: ClipGainReport } {
  const audio = clipAudioOf(clip);
  if (!audio) throw new Error(`Clip „${clip.name}“ enthält keine Audiodaten.`);
  const result = normalizeClipAudio(audio, options);
  return {
    clip: {
      ...clip,
      clipPcm: result.pcm,
      audioBuffer: undefined,
      miniPeaks: extractMiniPeaksPcm(result.pcm, CLIP_MINI_PEAK_BUCKETS),
    },
    report: result.report,
  };
}

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

/** Beatlänge: bei importierter Beatliste deren eigener mittlerer Abstand. */
function secondsPerBeatSafe(grid: BeatGrid): number {
  const measured = averageSecondsPerBeat(grid);
  if (measured > 0) return measured;
  return grid.bpm > 0 ? 60 / grid.bpm : 0.5;
}

function clampToTrack(seconds: number, maxSeconds: number | undefined, fallback: number): number {
  if (maxSeconds === undefined) return Math.max(0, seconds);
  if (maxSeconds <= 0) return Math.max(0, fallback);
  return Math.min(Math.max(0, seconds), Math.max(0, maxSeconds - 1e-9) || maxSeconds);
}

/**
 * Ein Satz für Rückmeldung und Protokoll: was der Pegel getan hat. Liefert null,
 * wenn nichts zu melden ist – die Oberfläche erfindet hier keine Formulierungen.
 */
export function clipLevelNote(
  level: ClipGainReport,
  mix?: { gainUsed: number; dryPeak: number; peakAfter: number; regionScale: number; attenuated: boolean } | null
): string | null {
  const parts: string[] = [];
  if (level.applied) {
    parts.push(
      `Clip vor dem Einfügen normalisiert: Peak ${level.peakBefore.toFixed(3)} → ${level.peakAfter.toFixed(3)} ` +
        `(${signedDb(level.gainDb)}) auf ${toDbfs(level.targetPeak).toFixed(1)} dBFS-Ziel`
    );
  } else if (level.skipped === 'über ziel') {
    parts.push(`Clip bleibt bei Peak ${level.peakBefore.toFixed(3)} – schon über dem Ziel von ${level.targetPeak.toFixed(3)}`);
  } else if (level.skipped === 'ziel nicht erreichbar') {
    parts.push(`Anhebung auf ${CLIP_NORM_MAX_GAIN_DB.toFixed(0)} dB begrenzt – Peak danach ${level.peakAfter.toFixed(3)}`);
  } else if (level.skipped === 'stumm') {
    parts.push('Clip ist still – keine Pegelanpassung');
  }
  if (level.postStretchGain !== undefined && level.postStretchGain !== 1) {
    parts.push(
      `Spitze nach Tempoangleichung ${level.peakAfterStretch?.toFixed(3)} → nachgezogen auf ${level.peakAfter.toFixed(3)} ` +
        `(${toDbfs(level.postStretchGain).toFixed(1)} dB)`
    );
  }
  if (mix?.attenuated) {
    parts.push(
      `Überlagerung auf ${mix.gainUsed.toFixed(3)} zurückgenommen (Bereichs-Peak ${mix.dryPeak.toFixed(3)}), ` +
        `Ergebnis-Peak ${mix.peakAfter.toFixed(3)} – kein Clipping`
    );
  }
  if (mix && mix.regionScale < 1) {
    parts.push(`Überlappungsbereich auf ${toDbfs(mix.peakAfter).toFixed(1)} dBFS angeglichen`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

function signedDb(value: number): string {
  if (!Number.isFinite(value)) return '−∞ dB';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} dB`;
}

/** Knapper Beschreibungstext für Rückmeldung und Protokoll. */
export function describeClip(clip: PaletteClip): string {
  const samples = clip.clipPcm ? pcmSampleCount(clip.clipPcm) : 0;
  return (
    `${clip.name}: ${clip.duration.toFixed(3)} s, ${clip.beats} Beats (${clip.bars} Takte) @ ${clip.bpm.toFixed(1)} BPM, ` +
    `${clip.key}, ${samples} Samples @ ${clip.clipPcm?.sampleRate ?? 0} Hz, Peak ${clipPeakOf(clip).toFixed(3)} ` +
    `(${Number.isFinite(toDbfs(clipPeakOf(clip))) ? toDbfs(clipPeakOf(clip)).toFixed(1) : '−∞'} dBFS)`
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
  /** Die Samples, die tatsächlich in die Spur geschrieben wurden (normalisiert). */
  placedAudio: PcmAudio;
  /** Was die Pegelangleichung getan hat. */
  level: ClipGainReport;
  /** Was die Tempoangleichung an die Zielspur getan hat. */
  tempo: TempoFitReport;
  /** Beim Überlagern: wie der Kopfraum gerechnet wurde. */
  mix?: { gainUsed: number; dryPeak: number; peakAfter: number; regionScale: number; attenuated: boolean };
}

/** Einstellungen, die vor der Ablage gelten – Schalter der Oberfläche, hier gesammelt. */
export interface ClipFitOptions {
  normalize?: boolean;
  ceiling?: number;
  tempoMatch?: boolean;
  pitchFollowsTempo?: boolean;
}

export interface ClipFitResult {
  /** Material nach Pegel- und Tempoangleichung – genau das, was in die Spur kommt. */
  pcm: PcmAudio;
  level: ClipGainReport;
  tempo: TempoFitReport;
}

/**
 * Was einem Clip widerfährt, bevor er in einer Spur landet: erst der Pegel, dann
 * das Tempo. Die Reihenfolge ist Absicht – die Pegelmessung soll das Material
 * zeigen, das tatsächlich eingefügt wird, und die Tempoangleichung darf den
 * Pegel nicht wieder verschieben (beide Wege normieren bzw. mischen linear).
 */
export function fitClipForTrack(
  clipAudio: PcmAudio,
  sourceBpm: number,
  targetBpm: number,
  options: ClipFitOptions = {}
): ClipFitResult {
  const normalized = normalizeClipAudio(clipAudio, { enabled: options.normalize !== false });
  const tempo = fitToTempo(normalized.pcm, {
    sourceBpm,
    targetBpm,
    enabled: options.tempoMatch !== false,
    pitchFollowsTempo: options.pitchFollowsTempo === true,
  });
  const result: ClipFitResult = { pcm: tempo.pcm, level: normalized.report, tempo: tempo.report };
  // Nach dem Dehnen kann die Spitze höher liegen als vorher: ein Phasenvocoder
  // verteilt einen Impuls über mehrere Rahmen, und im Extremfall addieren sich die
  // Rahmen an einer Stelle. Der Clip darf deshalb nicht über die Obergrenze –
  // ein letzter Zug nach unten, nur wenn es nötig ist.
  if (tempo.report.applied && options.normalize !== false) {
    const ceiling = options.ceiling ?? CLIP_HEADROOM_CEILING;
    const afterStretch = pcmPeak(tempo.pcm);
    if (afterStretch > ceiling && afterStretch > 0) {
      const post = ceiling / afterStretch;
      const held = pcmScale(tempo.pcm, post);
      result.pcm = held;
      result.level = {
        ...normalized.report,
        peakAfter: pcmPeak(held),
        peakAfterStretch: afterStretch,
        postStretchGain: post,
      };
    }
  }
  return result;
}

/**
 * Was beim Ablagen eines Clips auf die Zeitachse passiert – genau diese Funktion
 * ruft auch die App, damit das Geprüfte und das Genutzte identisch sind.
 *
 * Vor jeder Ablage stehen zwei Anpassungen, immer in dieser Reihenfolge:
 *
 * 1. Pegel: Der Clip wird auf CLIP_NORM_TARGET_PEAK (−1 dBFS) normalisiert,
 *    höchstens um CLIP_NORM_MAX_GAIN_DB angehoben. Beim Darüberlegen wird
 *    zusätzlich der Kopfraum des Zielbereichs gemessen und der Clip notfalls
 *    leiser gemischt – damit nach der Summation kein Sample über
 *    CLIP_HEADROOM_CEILING liegt. Es wird nichts hart begrenzt.
 * 2. Tempo: Stammen Clip und Zielspur aus verschiedenen Tempi, wird die Dauer
 *    des Clips auf das Zieltempo gebracht (`fitToTempo`). Ohne diesen Schritt
 *    lägen die Beats des Clips nach zwei Takten meilenweit neben dem Raster der
 *    Zielspur. Tonhöhe bleibt dabei stehen (Phasenvocoder); wer sie wie auf
 *    einem Plattenspieler mitnehmen will, setzt `pitchFollowsTempo`.
 *
 * insert:  Timeline schiebt sich nach rechts, Rest der Spur bleibt erhalten
 * overdub: Clip wird über den vorhandenen Bereich gemischt (Länge gleich)
 * replace: Bereich wird getauscht (Länge = Clip, Rest rückt nicht)
 */
export function applyClipDrop(
  track: EditableAudio,
  clipAudio: PcmAudio,
  wantedSeconds: number,
  options: {
    quantize?: boolean;
    mode: Exclude<ClipDropMode, 'deck'>;
    normalize?: boolean;
    ceiling?: number;
    /** Tempo, aus dem das Material stammt (die `bpm` des Clips). */
    sourceBpm?: number;
    /** Tempoangleichung an die Zielspur (Standard: an). */
    tempoMatch?: boolean;
    /** Tonhöhe folgt dem Tempo (Key-Lock aus). */
    pitchFollowsTempo?: boolean;
  }
): ClipDropOutcome {
  const mode = options.mode;
  const ceiling = options.ceiling ?? CLIP_HEADROOM_CEILING;
  const fitted = fitClipForTrack(clipAudio, options.sourceBpm ?? 0, track.beatGrid?.bpm ?? 0, {
    normalize: options.normalize !== false,
    tempoMatch: options.tempoMatch !== false,
    pitchFollowsTempo: options.pitchFollowsTempo === true,
  });
  const block = fitted.pcm;
  const trackEnd = pcmDuration(track.audio);
  const clipLength = pcmDuration(block);
  const placed = resolveClipTargetTime(wantedSeconds, track.beatGrid, {
    quantize: options.quantize,
    mode,
    maxSeconds: mode === 'insert' ? Number.POSITIVE_INFINITY : trackEnd,
  });
  const at = placed.seconds;
  const end = Math.min(trackEnd, at + clipLength);
  const blockLengthSamples = Math.max(1, pcmSampleCount(block));

  let outcome: { target: EditableAudio; report: EditReport; mix?: OverdubOutcome['mix'] };
  if (mode === 'insert') {
    outcome = insertClipAt(track, at, block);
  } else if (mode === 'replace') {
    outcome = replaceRange(track, at, Math.max(end, at + 1 / (block.sampleRate || 44100)), block);
  } else {
    outcome = overdubRange(
      track,
      at,
      Math.max(end, at + blockLengthSamples / (block.sampleRate || 44100)),
      block,
      1,
      { ceiling }
    );
  }

  return {
    mode,
    target: outcome.target,
    report: outcome.report,
    atSeconds: at,
    snapped: placed.snapped,
    reason: placed.reason,
    clipEndSeconds: at + clipLength,
    placedAudio: block,
    level: fitted.level,
    tempo: fitted.tempo,
    mix: outcome.mix,
  };
}

/**
 * Dateiname für den WAV-Export eines Clips („07_Name.wav“). Eine Quelle für
 * Einzel- und Massenexport, damit beide gleich benennen.
 */
export function clipExportFileName(clips: PaletteClip[], clip: PaletteClip): string {
  const index = clipDisplayIndex(clips, clip.id);
  const safeName = (clip.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'clip').replace(/_+$/, '');
  return `${String(Math.max(1, index)).padStart(2, '0')}_${safeName}.wav`;
}

/**
 * Ein Satz für Statuszeile und Protokoll: was Pegel *und* Tempo getan haben.
 * Ergänzung zu `clipLevelNote`, damit die Oberfläche beide Meldungen gleich
 * formuliert – und keine Anpassung verschweigt.
 */
export function clipDropNote(outcome: {
  level: ClipGainReport;
  tempo?: TempoFitReport;
  mix?: { gainUsed: number; dryPeak: number; peakAfter: number; regionScale: number; attenuated: boolean } | null;
}): string | null {
  const parts = [clipLevelNote(outcome.level, outcome.mix ?? null), outcome.tempo ? tempoFitNote(outcome.tempo) : null];
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join('; ') : null;
}

/** Was beim nächsten Ablagen passiert – ohne zu rechnen, für Menü und Checkbox. */
export function describeClipFit(
  clip: PaletteClip,
  targetBpm: number,
  options: { tempoMatch?: boolean; pitchFollowsTempo?: boolean } = {}
): string {
  const plan = planTempoFit(clip.bpm, targetBpm, {
    enabled: options.tempoMatch !== false,
    pitchFollowsTempo: options.pitchFollowsTempo === true,
  });
  if (!plan.willApply) {
    if (plan.reason === 'aus') return 'Tempoangleichung aus';
    if (plan.reason === 'kein tempo') return 'kein Raster in Quell- oder Zielspur';
    return 'Tempo gleich – keine Änderung';
  }
  const dauer = `${clip.duration.toFixed(3)} s → ${(clip.duration / plan.speed).toFixed(3)} s`;
  return (
    `${clip.bpm.toFixed(1)} → ${targetBpm.toFixed(1)} BPM (${plan.percent >= 0 ? '+' : '−'}${Math.abs(plan.percent).toFixed(1)} %, ${dauer}), ` +
    (options.pitchFollowsTempo ? `Tonhöhe ${plan.pitchCents >= 0 ? '+' : '−'}${Math.abs(plan.pitchCents).toFixed(0)} Cent` : 'Tonhöhe bleibt')
  );
}

/** Beschriftung für Rückmeldung und Protokoll. */
export function clipDropTitle(clip: PaletteClip, mode: ClipDropMode): string {
  if (mode === 'insert') return `Clip eingefügt: ${clip.name}`;
  if (mode === 'replace') return `Clip ersetzt Bereich: ${clip.name}`;
  if (mode === 'overdub') return `Clip überlagert: ${clip.name}`;
  return `Clip im Deck-Spieler: ${clip.name}`;
}
