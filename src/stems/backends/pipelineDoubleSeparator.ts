/**
 * Pipeline double – NOT a separation model.
 *
 * This backend exists so the whole engine (chunk plan, slice IO, overlap-add,
 * validation, cache, cancellation, error handling) can be tested automatically
 * without a 300 MB checkpoint. It is a deterministic, sum preserving signal
 * split with an arbitrary mask – it does NOT separate sources and can never
 * pass a quality gate.
 *
 * Guard rails so it can never be mistaken for real separation:
 *  - `capabilities().trainedModel === false`
 *  - the engine only uses it when `allowPipelineDouble === true`
 *  - every produced job is tagged `family: "pipeline_double"`
 *
 * Two coherence modes make the overlap-add logic testable:
 *  - `coherent`: the mask depends on the ABSOLUTE sample position, so two
 *    overlapping chunks agree and the reconstruction is exact.
 *  - `incoherent`: the chunk output is attenuated towards the chunk borders,
 *    which is exactly the failure mode overlap exists for – a model sees less
 *    context at the edge of its window and its estimate drops off there. With
 *    hard cuts those dips stay audible; with the engine's overlapping crossfade
 *    the neighbouring chunk covers them. The continuity test proves it.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { StemSeparationError } from '../errors';
import { decodeWav, encodeWavFloat32, readWavFile } from '../wavIo';
import type { BackendAvailability, BackendCapabilities, BackendSeparationRequest, BackendSeparationResponse, IStemSeparator } from './types';
import type { ModelDescriptor, ModelFamily, StemId } from '../types';

export interface PipelineDoubleOptions {
  /** `incoherent` degrades chunk edges on purpose (overlap-add test). */
  mode?: 'coherent' | 'incoherent';
  /** Artificial delay per 64k frames, used by the cancellation test. */
  simulatedMsPerFrame?: number;
  /** Edge degradation width in samples (incoherent mode). */
  edgeFadeSamples?: number;
}

const STEM_PHASES = [0.0, 1.7, 3.1, 4.6];

function softWeight(stemIndex: number, position: number): number {
  const phase = STEM_PHASES[stemIndex % STEM_PHASES.length];
  const slow = Math.sin((position / 4410) * 0.7 + phase);
  const fast = Math.sin((position / 512) * 0.13 + phase * 2.1);
  return 0.55 + 0.35 * slow + 0.1 * fast;
}

export class PipelineDoubleSeparator implements IStemSeparator {
  readonly kind = 'in-process' as const;
  readonly family: ModelFamily = 'pipeline_double';
  readonly name = 'pipeline-double:in-process';
  private readonly options: Required<PipelineDoubleOptions>;
  /** Counted so tests can assert that inference really ran per chunk. */
  public invocationCount = 0;
  /** Report of the most recent run – lets tests verify what reached the backend. */
  public lastReport(): Record<string, unknown> | undefined {
    return this.lastRunReport;
  }

  private lastRunReport?: Record<string, unknown>;

  constructor(options: PipelineDoubleOptions = {}) {
    this.options = {
      mode: options.mode ?? 'coherent',
      simulatedMsPerFrame: options.simulatedMsPerFrame ?? 0,
      edgeFadeSamples: options.edgeFadeSamples ?? 5512,
    };
  }

  capabilities(): BackendCapabilities {
    return {
      kind: this.kind,
      family: this.family,
      name: this.name,
      supportedDevices: ['cpu'],
      supportedPrecision: ['f32'],
      streamsProgress: true,
      cancellable: true,
      trainedModel: false,
    };
  }

  supportsDescriptor(descriptor: ModelDescriptor): boolean {
    return descriptor.family === 'pipeline_double';
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true, reason: undefined, detail: { mode: this.options.mode } };
  }

  async separate(request: BackendSeparationRequest): Promise<BackendSeparationResponse> {
    if (!this.supportsDescriptor(request.descriptor)) {
      throw new StemSeparationError('MODEL_INCOMPATIBLE', `Pipeline-Double kann ${request.descriptor.id} nicht bedienen`);
    }
    this.invocationCount++;
    const decoded = await readWavFile(request.workingWavPath);
    if (decoded.channels !== 2) {
      throw new StemSeparationError('STEM_CONFIG_INVALID', `Double erwartet Stereo, erhielt ${decoded.channels} Kanäle`);
    }
    const frames = decoded.frames;
    const channels = 2;
    const stemCount = request.descriptor.stemOrder.length;
    const incoherent = this.options.mode === 'incoherent';
    const edge = Math.min(this.options.edgeFadeSamples, Math.floor(frames / 4));

    const outputs: Float32Array[] = Array.from({ length: stemCount }, () => new Float32Array(frames * channels));
    const block = 4096;
    for (let start = 0; start < frames; start += block) {
      request.token?.throwIfCancelled();
      const end = Math.min(frames, start + block);
      for (let f = start; f < end; f++) {
        // The mask always uses the ABSOLUTE position, so two overlapping chunks
        // agree and the reconstruction can be exact.
        const position = request.startSample + f;
        // Chunk border attenuation (incoherent mode): the estimate loses
        // accuracy towards a window edge that has a neighbouring chunk, like a
        // real model without context. The outer edges of the file are excluded –
        // there is no neighbour to cover them (real backends use reflect
        // padding there instead).
        let edgeGain = 1;
        if (incoherent && edge > 0) {
          const hasPrevious = request.chunkIndex > 0;
          const hasNext = request.chunkIndex < request.chunkCount - 1;
          if (hasPrevious && f < edge) edgeGain = 0.5 - 0.5 * Math.cos(Math.PI * (f / edge));
          else if (hasNext && f >= frames - edge) edgeGain = 0.5 - 0.5 * Math.cos(Math.PI * ((frames - 1 - f) / edge));
        }
        const weights: number[] = [];
        let weightSum = 0;
        for (let s = 0; s < stemCount; s++) {
          const w = Math.max(0.02, softWeight(s, position));
          weights.push(w);
          weightSum += w;
        }
        for (let c = 0; c < channels; c++) {
          const value = (decoded.data[f * channels + c] || 0) * edgeGain;
          for (let s = 0; s < stemCount; s++) {
            outputs[s][f * channels + c] = (value * weights[s]) / weightSum;
          }
        }
      }
      if (this.options.simulatedMsPerFrame > 0) {
        const delay = (end - start) * this.options.simulatedMsPerFrame;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 250)));
      }
      request.onProgress?.(end / frames, `double chunk ${request.chunkIndex + 1}/${request.chunkCount}`);
    }

    const stems: { name: string; filePath: string; outputIndex: number }[] = [];
    for (let s = 0; s < stemCount; s++) {
      const stemId: StemId = request.descriptor.stemOrder[s];
      const filePath = path.join(request.outputDir, `stem_${s}_${stemId}.wav`);
      await writeFile(filePath, encodeWavFloat32(decoded.sampleRate, channels, outputs[s], frames));
      stems.push({ name: stemId, filePath, outputIndex: s });
    }
    this.lastRunReport = {
      // Echoes the inference parameters the engine asked for, so tests can
      // verify that quality profiles actually reach the backend (the double
      // itself does not spend more CPU on more passes).
      family: this.family,
      mode: this.options.mode,
      invocations: this.invocationCount,
      frames,
      numOverlap: request.numOverlap,
      ensemblePasses: request.ensemblePasses,
      chunkSize: request.frames,
      sampleRate: decoded.sampleRate,
      channels,
      precision: request.precision,
      profile: request.profile,
    };
    return {
      engine: this.family,
      backend: this.kind,
      stems,
      device: 'cpu',
      report: this.lastRunReport,
    };
  }
}

export { decodeWav };
