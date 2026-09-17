/**
 * CJS bundle entry for Electron main process
 * Bundled to dist/stems/node-bridge.cjs
 * Structured-clone-safe results
 */

import { StemSeparationEngine, createDefaultBackendFactory } from './stemSeparationEngine';
import { PipelineDoubleSeparator } from './backends/pipelineDoubleSeparator';
import { BSRoFormerSeparator, MelBandRoFormerSeparator } from './backends/roformerSeparator';
import { HTDemucsSeparator } from './backends/htDemucsSeparator';
import { SeparationCancellationToken } from './chunkProcessor';
import { getModelCatalog } from './modelRegistry';
import * as path from 'node:path';
import * as os from 'node:os';

// Export for CJS
export { StemSeparationEngine, PipelineDoubleSeparator, BSRoFormerSeparator, MelBandRoFormerSeparator, HTDemucsSeparator, SeparationCancellationToken };

export async function separate(request: {
  inputPath: string;
  modelId?: string;
  profile?: 'PREVIEW' | 'HIGH_QUALITY' | 'MAXIMUM_QUALITY';
  trackName?: string;
  chunkSizeSamples?: number;
  overlap?: number;
  extras?: Record<string, string | number | boolean>;
}) {
  const tmpRoot = path.join(os.tmpdir(), 'airdox-stems');
  const engine = new StemSeparationEngine({
    workingRoot: path.join(tmpRoot, 'working'),
    outputRoot: path.join(tmpRoot, 'output'),
    cacheRoot: path.join(tmpRoot, 'cache'),
    allowPipelineDouble: true,
    backendFactory: (model, req) => {
      const catalog = getModelCatalog();
      const entry = catalog.models.find(m => m.id === model.id);
      const backendType = entry?.backend || 'pipeline-double';
      if (backendType === 'bsroformer') {
        return new BSRoFormerSeparator({ stemOrder: model.stemOrder, fallback: new PipelineDoubleSeparator({ stemOrder: model.stemOrder }) });
      }
      if (backendType === 'melband-roformer') {
        return new MelBandRoFormerSeparator({ stemOrder: model.stemOrder, fallback: new PipelineDoubleSeparator({ stemOrder: model.stemOrder }) });
      }
      if (backendType === 'htdemucs') {
        return new HTDemucsSeparator({ stemOrder: model.stemOrder, fallback: new PipelineDoubleSeparator({ stemOrder: model.stemOrder }) });
      }
      return new PipelineDoubleSeparator({ stemOrder: model.stemOrder });
    },
  });

  const token = new SeparationCancellationToken();
  const result = await engine.separate({
    inputPath: request.inputPath,
    modelId: request.modelId,
    profile: request.profile,
    trackName: request.trackName,
    chunkSizeSamples: request.chunkSizeSamples,
    overlap: request.overlap,
    extras: request.extras,
    token,
    onProgress: (entry) => {
      // In real bridge, would send via IPC; here just log
      // console.log(`[bridge] ${entry.phase}`, entry.detail?.slice(0, 200));
    },
  });

  // Ensure structured-clone-safe (no Float32Array, etc.)
  return {
    status: result.status,
    stems: result.stems.map(s => ({
      id: s.id,
      filePath: s.filePath,
      sampleRate: s.sampleRate,
      channels: s.channels,
      frames: s.frames,
    })),
    metadata: {
      settings: result.metadata.settings,
      job: result.metadata.job,
      events: result.metadata.events.map(e => ({ phase: e.phase, detail: e.detail ? String(e.detail).slice(0, 1000) : undefined, at: e.at })),
    },
    validation: result.validation,
    cacheHit: result.cacheHit,
  };
}

// For CJS require
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof module !== 'undefined' && (module as any).exports) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (module as any).exports = {
    separate,
    StemSeparationEngine,
    PipelineDoubleSeparator,
    BSRoFormerSeparator,
    MelBandRoFormerSeparator,
    HTDemucsSeparator,
    SeparationCancellationToken,
    createDefaultBackendFactory,
  };
}
