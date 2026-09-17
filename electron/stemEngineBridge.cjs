/**
 * Loads dist/stems/node-bridge.cjs, sanitizes requests, registers IPC
 */

const path = require('node:path');
const fs = require('node:fs');

function loadNodeBridge() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'stems', 'node-bridge.cjs'),
    path.join(__dirname, '..', 'dist', 'stems', 'node-bridge.js'),
    path.join(process.cwd(), 'dist', 'stems', 'node-bridge.cjs'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(p);
        return mod;
      }
    } catch (e) {
      console.warn('[stemEngineBridge] failed to load', p, e.message);
    }
  }
  return null;
}

function sanitizeRequest(req) {
  if (!req || typeof req !== 'object') throw new Error('Invalid request');
  const inputPath = req.inputPath || req.input;
  if (!inputPath || typeof inputPath !== 'string') throw new Error('inputPath required');
  // Prevent directory traversal? Allow absolute paths only
  const sanitized = {
    inputPath: path.resolve(inputPath),
    modelId: typeof req.modelId === 'string' ? req.modelId : undefined,
    profile: typeof req.profile === 'string' ? req.profile : 'HIGH_QUALITY',
    trackName: typeof req.trackName === 'string' ? req.trackName.replace(/[^a-zA-Z0-9_.-]/g, '_') : undefined,
    chunkSizeSamples: typeof req.chunkSizeSamples === 'number' ? Math.max(1, Math.floor(req.chunkSizeSamples)) : undefined,
    overlap: typeof req.overlap === 'number' ? Math.max(0, Math.min(0.9, req.overlap)) : undefined,
    extras: req.extras && typeof req.extras === 'object' ? req.extras : undefined,
  };
  return sanitized;
}

function registerStemEngineIpc(ipcMain, options = {}) {
  const { app, logger } = options;
  const bridge = loadNodeBridge();

  // Engine status
  ipcMain.handle('stems:engine-status', async () => {
    try {
      const catalogPath = path.join(__dirname, '..', 'src', 'stems', 'modelCatalog.json');
      let models = [];
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        const catalog = JSON.parse(raw);
        models = catalog.models || [];
      } catch {}
      return {
        available: true,
        models: models.map(m => ({ id: m.id, displayName: m.displayName, backend: m.backend, trainedModel: m.trainedModel })),
        bridgeLoaded: !!bridge,
        contentHash: (() => { try { return JSON.parse(fs.readFileSync(catalogPath, 'utf8')).contentHash; } catch { return 'unknown'; } })(),
      };
    } catch (e) {
      return { available: false, error: e.message, bridgeLoaded: !!bridge };
    }
  });

  ipcMain.handle('stems:separate', async (_event, req) => {
    const sanitized = sanitizeRequest(req);
    if (logger) logger.info('stems:separate request', sanitized);
    if (!bridge) {
      throw new Error('Stem engine bridge not loaded – run npm run build:stems-bridge');
    }
    try {
      // Bridge should expose separate method
      if (typeof bridge.separate === 'function') {
        return await bridge.separate(sanitized);
      } else if (bridge.StemSeparationEngine) {
        const engine = new bridge.StemSeparationEngine({
          workingRoot: path.join(app.getPath('userData'), 'stems', 'working'),
          outputRoot: path.join(app.getPath('userData'), 'stems', 'output'),
          cacheRoot: path.join(app.getPath('userData'), 'stems', 'cache'),
          allowPipelineDouble: true,
        });
        return await engine.separate(sanitized);
      } else {
        throw new Error('Bridge does not expose separate');
      }
    } catch (e) {
      if (logger) logger.error('stems:separate failed', { error: e.message });
      throw e;
    }
  });

  ipcMain.handle('stems:job-status', async (_event, jobId) => {
    if (!bridge || !bridge.jobStore) return { status: 'UNKNOWN' };
    return { status: 'UNKNOWN', jobId };
  });

  ipcMain.handle('stems:job-cancel', async (_event, jobId) => {
    return { cancelled: true, jobId };
  });

  ipcMain.handle('stems:job-progress', async (event) => {
    // This would be event-based in real implementation
    return { progress: 0 };
  });

  console.log('[stemEngineBridge] IPC handlers registered, bridgeLoaded=', !!bridge);
}

module.exports = {
  loadNodeBridge,
  sanitizeRequest,
  registerStemEngineIpc,
};
