/**
 * Real inference backend: the MIT-licensed `audio-separator` CLI
 * (nomadkaraoke/python-audio-separator), which downloads and runs trained
 * UVR/BS-RoFormer checkpoints.
 *
 * Why a CLI subprocess and not an in-process model: the checkpoints are
 * PyTorch/ONNX and there is no Node runtime for them in this app. The CLI is
 * the same tool the previous ad-hoc implementation shelled out to, but here it
 * is driven through the engine's `IStemSeparator` contract, so cancellation,
 * error classification, stem identity and read-only guarantees all apply.
 *
 * Stem identity: `--custom_output_names` forces one deterministic filename per
 * stem. Never infer identity from directory listing order — that is
 * filesystem-dependent and silently mislabels stems.
 */
import { access, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { runInferenceProcess } from '../inferenceRunner';
import { StemSeparationError } from '../errors';
import type { BackendCapabilities, StemId } from '../types';
import type { BackendSeparationRequest, BackendSeparationResult, BackendStemResult, IStemSeparator } from './types';
import { readWavFile } from '../wavIo';

/** Default 4-stem MUSDB18HQ BS-RoFormer checkpoint (ZFTurbo, SDR 9.65). */
export const DEFAULT_AUDIO_SEPARATOR_MODEL = 'model_bs_roformer_ep_17_sdr_9.6568.ckpt';

/** CLI stem labels -> engine stem ids. The CLI capitalises its stem names. */
const STEM_LABEL_BY_ID: Record<string, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other', instrumental: 'Instrumental', guitar: 'Guitar', piano: 'Piano' };

export interface AudioSeparatorOptions {
  /** Executable name or absolute path. Default `audio-separator`. */
  command?: string;
  /** Checkpoint filename as listed by `audio-separator --list_models`. */
  modelFilename?: string;
  /** Where the CLI caches downloaded weights. */
  modelFileDir?: string;
  stemOrder?: StemId[];
  /** Extra CLI flags (e.g. `--use_autocast`). */
  extraArgs?: string[];
  /** Injectable process runner, so tests never spawn a real binary. */
  runner?: typeof runInferenceProcess;
}

/**
 * Maps CLI failures onto the engine's error codes. A missing binary and a
 * failed inference are very different problems for the user, so they must not
 * collapse into one generic message.
 */
function classify(error: unknown): StemSeparationError {
  if (error instanceof StemSeparationError) {
    const text = `${error.message} ${String(error.cause ?? '')}`;
    if (error.code === 'INFERENCE_FAILED') {
      if (/No such file|not found|ENOENT/i.test(text) && /model|checkpoint|\.ckpt|\.onnx/i.test(text)) {
        return new StemSeparationError('BACKEND_UNAVAILABLE', 'Modelldatei nicht gefunden. Bitte Checkpoint herunterladen (siehe docs/STEM_SEPARATION_ENGINE.md).', error.cause);
      }
      if (/CUDA out of memory|DefaultCPUAllocator|Killed|MemoryError/i.test(text)) {
        return new StemSeparationError('INFERENCE_FAILED', 'Zu wenig Speicher für die Separation. Kleineres Segment oder CPU-Modus verwenden.', error.cause);
      }
      if (/ConnectionError|Max retries|Temporary failure in name resolution|SSLError/i.test(text)) {
        return new StemSeparationError('BACKEND_UNAVAILABLE', 'Modell-Download fehlgeschlagen (keine Netzwerkverbindung).', error.cause);
      }
    }
    return error;
  }
  return new StemSeparationError('INFERENCE_FAILED', error instanceof Error ? error.message : String(error), error);
}

export class AudioSeparatorSeparator implements IStemSeparator {
  readonly backendId = 'audio-separator';
  private readonly options: AudioSeparatorOptions;
  private readonly stemOrder: StemId[];

  constructor(options: AudioSeparatorOptions = {}) {
    this.options = options;
    this.stemOrder = options.stemOrder ?? ['vocals', 'drums', 'bass', 'other'];
  }

  /**
   * `trainedModel: true` — unlike the pipeline double this really does run
   * trained weights, so a gate run against it is allowed to reach a quality
   * verdict.
   */
  capabilities(): BackendCapabilities {
    return { trainedModel: true, supportsCancellation: true, supportsStereo: true, stemOrder: this.stemOrder, backend: this.backendId, modelFilename: this.options.modelFilename ?? DEFAULT_AUDIO_SEPARATOR_MODEL };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResult> {
    const order = request.stemOrder.length ? request.stemOrder : this.stemOrder;
    const command = this.options.command ?? 'audio-separator';
    const modelFilename = this.options.modelFilename ?? DEFAULT_AUDIO_SEPARATOR_MODEL;
    const run = this.options.runner ?? runInferenceProcess;

    // Force one deterministic basename per stem instead of trusting the CLI's
    // "<track>_(Vocals)_<model>" convention or the directory order.
    const outputNames: Record<string, string> = {};
    for (const id of order) outputNames[STEM_LABEL_BY_ID[id] ?? id] = `stem_${id}`;

    const args = [
      request.inputPath,
      '--output_dir', request.outputRoot,
      '--output_format', 'WAV',
      '--model_filename', modelFilename,
      '--custom_output_names', JSON.stringify(outputNames),
      ...(this.options.modelFileDir ? ['--model_file_dir', this.options.modelFileDir] : []),
      ...(this.options.extraArgs ?? []),
    ];

    const events: { phase: string; detail?: string }[] = [
      { phase: 'backend-start', detail: JSON.stringify({ backend: this.backendId, model: modelFilename, stem_order: order }) },
    ];

    request.token?.throwIfCancelled();
    try {
      await run({
        command,
        args,
        token: request.token,
        onLine: (line) => {
          // The CLI reports percentages on its progress lines; surface them
          // instead of leaving the UI at an indeterminate spinner.
          const match = /(\d{1,3})%/.exec(line);
          request.onProgress?.({ phase: 'inference', detail: line.slice(0, 400) });
          if (match) request.onProgress?.({ phase: 'progress', detail: match[1] });
        },
      });
    } catch (error) {
      throw classify(error);
    }
    request.token?.throwIfCancelled();

    const stems: BackendStemResult[] = [];
    const listing = await readdir(request.outputRoot).catch(() => [] as string[]);
    for (const id of order) {
      const expected = path.join(request.outputRoot, `stem_${id}.wav`);
      let filePath = expected;
      if (!(await exists(expected))) {
        // Tolerate CLI versions that append a suffix to the custom name, but
        // still resolve by the unique per-stem token, never by position.
        const match = listing.find((f) => f.toLowerCase().startsWith(`stem_${id}`) && f.toLowerCase().endsWith('.wav'));
        if (!match) {
          throw new StemSeparationError('INFERENCE_FAILED', `Backend hat den Stem "${id}" nicht erzeugt (erwartet: ${path.basename(expected)}).`);
        }
        filePath = path.join(request.outputRoot, match);
        await rename(filePath, expected).then(() => { filePath = expected; }).catch(() => undefined);
      }
      const audio = await readWavFile(filePath).catch((error: unknown) => {
        throw new StemSeparationError('AUDIO_CORRUPT', `Stem "${id}" ist nicht lesbar: ${filePath}`, error);
      });
      stems.push({ id, filePath, sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames });
    }

    events.push({ phase: 'backend-report', detail: JSON.stringify({ backend: this.backendId, weights: 'trained', model: modelFilename, stem_order: order }) });
    return { stems, events };
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

export interface AudioSeparatorPreflight {
  available: boolean;
  version?: string;
  reason?: string;
  command: string;
}

/**
 * Checks whether the CLI is installed, without running a separation. The
 * desktop app calls this before offering the feature so the user gets an
 * actionable install hint instead of a failure mid-track.
 */
export async function checkAudioSeparator(options: { command?: string; runner?: typeof runInferenceProcess } = {}): Promise<AudioSeparatorPreflight> {
  const command = options.command ?? 'audio-separator';
  const run = options.runner ?? runInferenceProcess;
  try {
    const result = await run({ command, args: ['--version'] });
    const version = /(\d+\.\d+\.\d+)/.exec(`${result.stdout} ${result.stderr}`)?.[1];
    return { available: true, version, command };
  } catch (error) {
    const reason = error instanceof StemSeparationError && error.code === 'BACKEND_UNAVAILABLE'
      ? 'audio-separator ist nicht installiert. Installation: pip install "audio-separator[gpu]" (oder [cpu]).'
      : error instanceof Error ? error.message : String(error);
    return { available: false, reason, command };
  }
}
