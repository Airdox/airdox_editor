/**
 * Stem separation service for the editor UI.
 *
 * Two engines, one contract:
 *
 *  1. `desktop`  – the external, trained separator (`audio-separator` CLI)
 *                  reached through the Electron IPC bridge. Best quality, but
 *                  only available in the packaged desktop app on a machine
 *                  where that CLI is installed.
 *  2. `builtin`  – the in-process heuristic DSP separator
 *                  (`src/stems/dspSeparator.ts`). Runs everywhere: browser,
 *                  dev server, desktop, no Python, no GPU, no download.
 *
 * The service never pretends the heuristic is a trained model: every result
 * carries `trainedModel`, `qualityTier` and human readable `notes` that the UI
 * shows to the user.
 */
import type { StemId } from '../stems/types';
import {
  DSP_SEPARATOR_ENGINE,
  separateStemsDspChunked,
  type DspAudio,
  type DspSeparatorOptions,
} from '../stems/dspSeparator';
import { classifyStemFiles, DEFAULT_STEM_ORDER } from '../stems/stemFileNames';
import type { StemModelEntry } from '../stems/modelCatalog';

export type StemEngineId = 'desktop' | 'builtin';

export interface StemProgress {
  phase: 'prepare' | 'separating' | 'decoding' | 'done';
  ratio: number;
  message: string;
}

export interface SeparatedStems {
  engine: StemEngineId;
  modelId: string;
  trainedModel: boolean;
  qualityTier: 'TRAINED' | 'HEURISTIC';
  ids: StemId[];
  labels: string[];
  buffers: AudioBuffer[];
  /** Absolute paths – only present for the desktop engine. */
  paths?: string[];
  notes: string[];
  durationMs: number;
  /** Largest |mix − Σstems| deviation measured by the built-in engine. */
  recombinationMaxError?: number;
}

export interface SeparateStemsRequest {
  context: BaseAudioContext;
  /** Decoded audio of the track (usually the current working buffer). */
  buffer: AudioBuffer;
  /** Real local path of the source file, when one is known. */
  sourcePath?: string | null;
  /** Optional desktop bridge (`window.rekordboxDesktop`). */
  desktop?: StemDesktopBridge | null;
  profile?: 'PREVIEW' | 'HIGH_QUALITY';
  /** Gewünschte Modell-Gewichte (nur Desktop-Engine; null = Standardmodell). */
  model?: StemModelSelection | null;
  /** Überspringt die externe Inferenz (z. B. weil die Heuristik gewählt wurde). */
  preferBuiltin?: boolean;
  stemOrder?: readonly StemId[];
  dspOptions?: DspSeparatorOptions;
  onProgress?: (progress: StemProgress) => void;
  isCancelled?: () => boolean;
}

/** Minimal shape of the Electron bridge used here (keeps this module testable). */
/** Modell-Auswahl, die an die Desktop-Bridge übergeben wird. */
export interface StemModelSelection {
  id?: string | null;
  fileName: string;
  label?: string;
  downloadUrl?: string | null;
  sha256?: string | null;
  expectedSizeBytes?: number | null;
}

export function toStemModelSelection(entry: StemModelEntry | null | undefined): StemModelSelection | null {
  if (!entry || !entry.fileName) return null;
  return {
    id: entry.id,
    fileName: entry.fileName,
    label: entry.label,
    downloadUrl: entry.downloadUrl ?? null,
    sha256: null,
    expectedSizeBytes: null,
  };
}

export interface StemDesktopBridge {
  separateStems(
    inputFilePath: string,
    options?: { modelFilename?: string; model?: StemModelSelection | null; chunkDuration?: number; extraArgs?: string[] }
  ): Promise<string[]>;
  readOriginalAudio(location: string): Promise<{ data: ArrayBuffer; path: string }>;
  separatorStatus?(): Promise<SeparatorStatus | null>;
}

export interface SeparatorStatus {
  available: boolean;
  command?: string | null;
  reason?: string;
  hint?: string;
}

const DESKTOP_ENGINE_LABEL = 'audio-separator (extern, trainiertes Modell)';

function progress(request: SeparateStemsRequest, phase: StemProgress['phase'], ratio: number, message: string): void {
  request.onProgress?.({ phase, ratio: Math.max(0, Math.min(1, ratio)), message });
}

/** A path is only usable by the main process when it is a real local path. */
export function isUsableLocalPath(candidate?: string | null): boolean {
  if (!candidate || typeof candidate !== 'string') return false;
  const value = candidate.trim();
  if (!value) return false;
  if (/^(blob:|data:|http:|https:|file:)/i.test(value)) return false;
  // Windows: C:\… or \\server\share ; POSIX: /… ; nothing else is a real path.
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

export function audioBufferToDspAudio(buffer: AudioBuffer): { audio: DspAudio; notes: string[] } {
  const notes: string[] = [];
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  if (channels === 1 || channels === 2) {
    const data = new Float32Array(frames * channels);
    const channelData: Float32Array[] = [];
    for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) data[f * channels + c] = channelData[c][f] || 0;
    }
    return { audio: { data, sampleRate: buffer.sampleRate, channels, frames }, notes };
  }
  notes.push(`Quelle hat ${channels} Kanäle – für die Separation auf Stereo reduziert.`);
  const data = new Float32Array(frames * 2);
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));
  const half = Math.ceil(channels / 2);
  for (let f = 0; f < frames; f++) {
    let left = 0;
    let right = 0;
    for (let c = 0; c < channels; c++) {
      const value = channelData[c][f] || 0;
      if (c < half) left += value;
      else right += value;
    }
    data[f * 2] = left / half;
    data[f * 2 + 1] = right / Math.max(1, channels - half);
  }
  return { audio: { data, sampleRate: buffer.sampleRate, channels: 2, frames }, notes };
}

export function dspAudioToAudioBuffer(context: BaseAudioContext, audio: DspAudio, data: Float32Array): AudioBuffer {
  const out = context.createBuffer(audio.channels, audio.frames, audio.sampleRate);
  for (let c = 0; c < audio.channels; c++) {
    const channel = out.getChannelData(c);
    for (let f = 0; f < audio.frames; f++) channel[f] = data[f * audio.channels + c] || 0;
  }
  return out;
}

/** Built-in heuristic engine – works in every environment. */
export async function separateStemsBuiltin(request: SeparateStemsRequest): Promise<SeparatedStems> {
  const started = Date.now();
  const { audio, notes } = audioBufferToDspAudio(request.buffer);
  progress(request, 'separating', 0.05, 'Intere DSP-Separation läuft …');
  const report = await separateStemsDspChunked(audio, {
    stemOrder: request.stemOrder ?? DEFAULT_STEM_ORDER,
    blockFrames: request.profile === 'PREVIEW' ? Math.floor(audio.sampleRate * 1) : Math.floor(audio.sampleRate * 0.5),
    isCancelled: request.isCancelled,
    onProgress: (step) => progress(request, 'separating', 0.05 + step.ratio * 0.9, `Intere DSP-Separation: ${Math.round(step.ratio * 100)} %`),
    ...request.dspOptions,
  });
  progress(request, 'decoding', 0.97, 'Stems werden als Audiopuffer erzeugt …');
  const buffers = report.stems.map((stem) => dspAudioToAudioBuffer(request.context, audio, stem.data));
  return {
    engine: 'builtin',
    modelId: report.engine,
    trainedModel: false,
    qualityTier: 'HEURISTIC',
    ids: report.stems.map((stem) => stem.id),
    labels: report.stems.map((stem) => stem.label),
    buffers,
    notes: [...report.notes, ...notes],
    durationMs: Date.now() - started,
    recombinationMaxError: report.recombinationMaxError,
  };
}

/** External trained engine – needs Electron plus an installed separator CLI. */
export async function separateStemsViaDesktop(request: SeparateStemsRequest, sourcePath: string): Promise<SeparatedStems> {
  const desktop = request.desktop;
  if (!desktop?.separateStems) throw new Error('Desktop-Bridge nicht verfügbar');
  const started = Date.now();
  const model = request.model ?? null;
  progress(request, 'prepare', 0.02, model?.label ? `Starte ${DESKTOP_ENGINE_LABEL} mit ${model.label} …` : `Starte ${DESKTOP_ENGINE_LABEL} …`);
  const producedPaths = await desktop.separateStems(sourcePath, {
    modelFilename: model?.fileName ?? undefined,
    model,
  });
  if (!Array.isArray(producedPaths) || producedPaths.length === 0) throw new Error('Der externe Separator hat keine Stem-Dateien erzeugt');
  progress(request, 'decoding', 0.75, `${producedPaths.length} Stem-Dateien werden geladen …`);

  const ordered = classifyStemFiles(producedPaths, request.stemOrder ?? DEFAULT_STEM_ORDER);
  const buffers: AudioBuffer[] = [];
  const ids: StemId[] = [];
  const labels: string[] = [];
  const paths: string[] = [];
  for (const [index, entry] of ordered.entries()) {
    if (request.isCancelled?.()) throw new Error('Stem-Separation abgebrochen');
    const source = await desktop.readOriginalAudio(entry.filePath);
    buffers.push(await decodeAudio(request.context, source.data));
    ids.push(entry.id);
    labels.push(entry.label);
    paths.push(entry.filePath);
    progress(request, 'decoding', 0.75 + ((index + 1) / ordered.length) * 0.2, `Lade Stem ${index + 1}/${ordered.length}: ${entry.label}`);
  }
  if (!buffers.length) throw new Error('Keine Stem-Datei konnte gelesen werden');

  return {
    engine: 'desktop',
    modelId: model?.label ?? model?.fileName ?? DESKTOP_ENGINE_LABEL,
    trainedModel: true,
    qualityTier: 'TRAINED',
    ids,
    labels,
    buffers,
    paths,
    notes: [
      model?.fileName
        ? `Trainierte Gewichte über die Desktop-Bridge (audio-separator CLI, Modell: ${model.fileName}).`
        : 'Trainiertes Standardmodell über die Desktop-Bridge (audio-separator CLI).',
    ],
    durationMs: Date.now() - started,
  };
}

/** `decodeAudioData` across the promise/callback variants Chromium ships. */
export function decodeAudio(context: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const copy = data.slice(0);
    try {
      const result = context.decodeAudioData(copy, resolve, reject);
      if (result && typeof (result as unknown as Promise<AudioBuffer>).then === 'function') {
        (result as unknown as Promise<AudioBuffer>).then(resolve).catch(reject);
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface AutoSeparationResult extends SeparatedStems {
  /** Why the desktop engine was not used (empty when it was). */
  fallbackReasons: string[];
}

/**
 * Pick the best engine that actually works in the current environment and
 * fall back to the built-in heuristic instead of failing the whole feature.
 */
export async function separateStemsAuto(request: SeparateStemsRequest): Promise<AutoSeparationResult> {
  const fallbackReasons: string[] = [];
  const desktop = request.desktop ?? null;
  const sourcePath = request.sourcePath ?? null;

  if (request.preferBuiltin) {
    fallbackReasons.push('Interne DSP-Heuristik wurde ausdrücklich als Engine gewählt');
    const result = await separateStemsBuiltin(request);
    progress(request, 'done', 1, 'Stems bereit (interne Heuristik).');
    return { ...result, fallbackReasons };
  }

  if (desktop?.separateStems && isUsableLocalPath(sourcePath)) {
    let status: SeparatorStatus | null = null;
    if (desktop.separatorStatus) {
      try {
        status = await desktop.separatorStatus();
      } catch {
        status = null;
      }
    }
    if (status && status.available === false) {
      fallbackReasons.push(status.reason || 'Externer Separator nicht verfügbar');
    } else {
      try {
        const result = await separateStemsViaDesktop(request, sourcePath as string);
        progress(request, 'done', 1, 'Stems bereit (externes Modell).');
        return { ...result, fallbackReasons };
      } catch (error) {
        fallbackReasons.push(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (!desktop?.separateStems) {
    fallbackReasons.push('Desktop-Bridge fehlt (App läuft nicht in Electron)');
  } else {
    fallbackReasons.push('Kein echter lokaler Dateipfad für die externe Separation vorhanden');
  }

  const result = await separateStemsBuiltin(request);
  progress(request, 'done', 1, 'Stems bereit (interne Heuristik).');
  return { ...result, fallbackReasons };
}

export function describeStemEngine(result: SeparatedStems): string {
  return result.engine === 'desktop'
    ? `Externes Modell (${result.modelId})`
    : `Interne Heuristik (${DSP_SEPARATOR_ENGINE})`;
}
