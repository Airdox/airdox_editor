import { access } from 'node:fs/promises';
import path from 'node:path';
import type separateFnType from '@audio/neural-separate';
import type { BackendAvailability, BackendAvailabilityOptions, BackendCapabilities, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator } from './types';
import type { ComputeDevice, ModelDescriptor } from '../types';

type SeparateFn = typeof separateFnType;

/**
 * Fast four-stem path based on the published audiojs SCNet int8 ONNX model.
 * The upstream package supplies the model-matched STFT/iSTFT, normalization,
 * overlap-add and checksum-pinned weight download; this adapter keeps the
 * editor's existing job/cache/validation contract and never stages audio chunks.
 */
export class ScnetSeparator implements IStemSeparator {
  readonly kind = 'onnx' as const;
  readonly family = 'scnet' as const;
  readonly name = 'scnet:onnx-int8';
  readonly availabilityKey: string;
  private readonly modelStoreDir: string;
  private readonly injectedSeparate?: SeparateFn;

  constructor(options: { modelStoreDir: string; separate?: SeparateFn }) {
    this.modelStoreDir = options.modelStoreDir;
    this.injectedSeparate = options.separate;
    this.availabilityKey = `onnx|scnet|${options.modelStoreDir}`;
  }

  capabilities(): BackendCapabilities {
    return {
      kind: 'onnx', family: this.family, name: this.name,
      supportedDevices: ['auto', 'cpu'], supportedPrecision: ['f32'],
      streamsProgress: true, cancellable: true, trainedModel: true,
      inMemory: true, processesWholeFile: true,
    };
  }

  async isAvailable(options: BackendAvailabilityOptions & { descriptor?: ModelDescriptor } = {}): Promise<BackendAvailability> {
    const descriptor = options.descriptor;
    if (descriptor) {
      try {
        await access(path.join(this.modelStoreDir, descriptor.checkpoint.file));
      } catch {
        return { available: false, reason: `SCNet-Modell fehlt: ${descriptor.checkpoint.file}` };
      }
    }
    try {
      if (!this.injectedSeparate) {
        const runtimeModule = 'onnxruntime-node';
        await import(/* @vite-ignore */ runtimeModule);
      }
      return { available: true, detail: { runtime: 'onnxruntime-node', model: 'SCNet int8' } };
    } catch (error) {
      return { available: false, reason: `ONNX-Runtime für SCNet nicht verfügbar: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    if (!request.workingSamples) throw new Error('SCNet benötigt workingSamples im Arbeitsspeicher.');
    request.token?.throwIfCancelled();
    const channels = request.channels ?? 2;
    if (channels !== 2) throw new Error(`SCNet erwartet Stereo; erhalten: ${channels} Kanäle.`);
    const left = new Float32Array(request.frames);
    const right = new Float32Array(request.frames);
    for (let frame = 0; frame < request.frames; frame++) {
      left[frame] = request.workingSamples[frame * 2];
      right[frame] = request.workingSamples[frame * 2 + 1];
    }
    const packageName = '@audio/neural-separate';
    const separate = this.injectedSeparate ?? (await import(/* @vite-ignore */ packageName)).default;
    const result = await separate([left, right], {
      model: 'scnet',
      sampleRate: request.sampleRate ?? request.descriptor.sampleRate,
      weights: this.modelStoreDir,
      device: 'node',
      targets: request.stems,
      // SCNet's upstream default is 25% of an 11 s window (2.75 s stride),
      // which measured ~26 min for a 5 min track on the target i3. DJ profiles
      // use fewer repeated windows to stay inside the interactive time budget.
      step: request.profile === 'PREVIEW' ? 0.5 : 0.4,
      progress: ({ chunk, totalChunks }) => {
        request.token?.throwIfCancelled();
        request.onProgress?.(totalChunks ? chunk / totalChunks : 0, `SCNet: Abschnitt ${chunk}/${totalChunks}`);
      },
    });
    request.token?.throwIfCancelled();
    const inlineStems = request.stems.map((stemId) => {
      const channelsOut = result.stems[stemId];
      if (!channelsOut || channelsOut.length !== 2 || channelsOut[0].length !== request.frames || channelsOut[1].length !== request.frames) {
        throw new Error(`SCNet lieferte keinen gültigen Stereo-Stem "${stemId}".`);
      }
      const samples = new Float32Array(request.frames * 2);
      for (let frame = 0; frame < request.frames; frame++) {
        samples[frame * 2] = channelsOut[0][frame];
        samples[frame * 2 + 1] = channelsOut[1][frame];
      }
      return { name: stemId, samples, frames: request.frames, channels: 2, outputIndex: request.descriptor.stemOrder.indexOf(stemId) };
    });
    const device: ComputeDevice = 'cpu';
    request.onProgress?.(1, 'SCNet: Trennung abgeschlossen');
    return { engine: this.family, backend: this.kind, stems: [], inlineStems, device, report: { architecture: 'SCNet', quantization: 'int8 weights / fp32 inference', runtime: 'onnxruntime-node' } };
  }
}
