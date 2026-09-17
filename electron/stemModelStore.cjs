'use strict';

/**
 * Stem-Model-Store: Verwaltung der Modell-Gewichte (.ckpt/.onnx/.pth/.th) im
 * Benutzerdaten-Ordner der Desktop-App.
 *
 * Grundsätze:
 *  - Kein stiller Download: Gewichte werden nur geladen, wenn die UI es
 *    ausdrücklich auslöst (`stems:models:download`) oder ein eigener
 *    Direkt-URL-Eintrag im Katalog hinterlegt ist.
 *  - Downloads landen zuerst in `<name>.part` und werden erst nach
 *    Größen-/Hash-Prüfung atomar umbenannt → keine halben Gewichte.
 *  - Modelle ohne Direkt-URL delegiert die App an die Separator-CLI
 *    (`--model_filename` + `--model_file_dir`); die CLI lädt dann selbst in
 *    genau diesen Ordner. Der Store zeigt solche Dateien anschließend als
 *    „installiert (von CLI geladen)“.
 *  - Dieses Modul importiert kein `electron` und ist damit in Node testbar
 *    (tests/stem-model-store.test.mjs).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MODEL_EXTENSIONS = ['.ckpt', '.onnx', '.pth', '.th', '.pt', '.bin'];
const PART_SUFFIX = '.part';
const MANIFEST_FILE = 'model-manifest.json';

function isModelFileName(name) {
  return MODEL_EXTENSIONS.includes(path.extname(String(name)).toLowerCase());
}

function safeModelFileName(name) {
  const base = path.basename(String(name ?? '').trim());
  if (!base || base === '.' || base === '..') throw new Error('Ungültiger Modell-Dateiname');
  if (/[\\/]|\u0000/.test(base)) throw new Error('Modell-Dateiname enthält Pfadtrenner');
  return base;
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

function toProgressEvent(payload) {
  const transferred = Number(payload.transferredBytes) || 0;
  const total = Number(payload.totalBytes) || 0;
  return {
    fileName: payload.fileName,
    phase: payload.phase,
    transferredBytes: transferred,
    totalBytes: total,
    ratio: total > 0 ? Math.max(0, Math.min(1, transferred / total)) : null,
    message: payload.message ?? '',
  };
}

/**
 * @param {object} options
 * @param {string} options.rootDir          Modell-Ordner (userData/stem-models)
 * @param {(input:string, init?:object)=>Promise<any>} [options.fetchImpl]  für Tests austauschbar
 */
function createStemModelStore(options = {}) {
  const rootDir = options.rootDir;
  if (!rootDir) throw new Error('rootDir fehlt für den Stem-Model-Store');
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  const activeDownloads = new Map();

  const modelPath = (fileName) => path.join(rootDir, safeModelFileName(fileName));
  const partPath = (fileName) => `${modelPath(fileName)}${PART_SUFFIX}`;

  async function ensureRoot() {
    await fsp.mkdir(rootDir, { recursive: true });
    return rootDir;
  }

  async function readManifest() {
    try {
      return JSON.parse(await fsp.readFile(path.join(rootDir, MANIFEST_FILE), 'utf8'));
    } catch {
      return { models: {} };
    }
  }

  async function writeManifest(manifest) {
    await ensureRoot();
    await fsp.writeFile(path.join(rootDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  async function describeFile(fileName) {
    const filePath = modelPath(fileName);
    try {
      const info = await fsp.stat(filePath);
      if (!info.isFile()) return null;
      return { fileName, filePath, sizeBytes: info.size, modifiedAt: info.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Alle Gewichte im Ordner inkl. Größe, Hash (lazy) und Manifest-Eintrag. */
  async function listInstalled(options2 = {}) {
    await ensureRoot();
    const manifest = await readManifest();
    const entries = await fsp.readdir(rootDir, { withFileTypes: true });
    const installed = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name === MANIFEST_FILE) continue;
      const downloading = name.endsWith(PART_SUFFIX);
      const fileName = downloading ? name.slice(0, -PART_SUFFIX.length) : name;
      if (!isModelFileName(fileName)) continue;
      const info = await fsp.stat(path.join(rootDir, name));
      const record = manifest.models?.[fileName] ?? null;
      installed.push({
        fileName,
        filePath: path.join(rootDir, name),
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
        state: downloading ? 'DOWNLOADING' : 'INSTALLED',
        sha256: record?.sha256 ?? null,
        source: record?.source ?? 'UNBEKANNT',
        modelId: record?.modelId ?? null,
        downloadedAt: record?.downloadedAt ?? null,
      });
    }
    if (options2.withHash) {
      for (const item of installed) {
        if (item.state === 'INSTALLED' && !item.sha256) item.sha256 = await sha256OfFile(item.filePath);
      }
    }
    return installed.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  /**
   * Katalog mit dem Ist-Zustand des Ordners zusammenführen.
   * @param {Array<object>} catalog Einträge aus src/stems/modelCatalog.ts
   */
  async function status(catalog = []) {
    const installed = await listInstalled();
    const byName = new Map(installed.map((item) => [item.fileName.toLowerCase(), item]));
    const models = catalog.map((entry) => {
      const fileName = entry.fileName ? safeModelFileName(entry.fileName) : null;
      const local = fileName ? byName.get(fileName.toLowerCase()) ?? null : null;
      return {
        id: entry.id,
        label: entry.label,
        fileName,
        architecture: entry.architecture,
        stemOrder: entry.stemOrder ?? null,
        trainedModel: Boolean(entry.trainedModel),
        requiresExternalRuntime: Boolean(entry.requiresExternalRuntime),
        recommended: Boolean(entry.recommended),
        qualityHint: entry.qualityHint ?? '',
        license: entry.license ?? null,
        downloadUrl: entry.downloadUrl ?? null,
        approximateSizeMb: entry.approximateSizeMb ?? null,
        profile: entry.profile ?? 'HIGH_QUALITY',
        installed: Boolean(local && local.state === 'INSTALLED'),
        downloading: Boolean(local && local.state === 'DOWNLOADING'),
        localPath: local ? local.filePath : null,
        sizeBytes: local ? local.sizeBytes : null,
        sha256: local ? local.sha256 : null,
        source: local ? local.source : null,
        // Ohne Direkt-URL lädt die Separator-CLI die Gewichte selbst.
        delegateToRuntime: Boolean(entry.requiresExternalRuntime && !entry.downloadUrl),
      };
    });
    // Lokale Gewichte, die nicht im Katalog stehen (eigene Checkpoints).
    const catalogNames = new Set(models.map((model) => model.fileName?.toLowerCase()).filter(Boolean));
    for (const item of installed) {
      if (catalogNames.has(item.fileName.toLowerCase())) continue;
      models.push({
        id: `local-${item.fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase()}`,
        label: item.fileName.replace(/\.[^.]+$/, ''),
        fileName: item.fileName,
        architecture: 'VR_ARCH',
        stemOrder: null,
        trainedModel: true,
        requiresExternalRuntime: true,
        recommended: false,
        qualityHint: 'Eigener Checkpoint im Modell-Ordner (nicht kuratiert).',
        license: null,
        downloadUrl: null,
        approximateSizeMb: Math.round(item.sizeBytes / (1024 * 1024)),
        profile: 'HIGH_QUALITY',
        installed: item.state === 'INSTALLED',
        downloading: item.state === 'DOWNLOADING',
        localPath: item.filePath,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        source: item.source,
        delegateToRuntime: false,
      });
    }
    return { modelDir: rootDir, models, installedCount: installed.filter((item) => item.state === 'INSTALLED').length };
  }

  async function rememberModel(fileName, record) {
    const manifest = await readManifest();
    manifest.models = manifest.models ?? {};
    manifest.models[fileName] = { ...(manifest.models[fileName] ?? {}), ...record };
    await writeManifest(manifest);
  }

  /**
   * Lädt Gewichte über eine Direkt-URL in den Modell-Ordner.
   * Unterstützt Abbruch, Fortschritt und Wiederaufnahme (HTTP Range).
   */
  async function download(options2 = {}) {
    const { fileName, url, sha256: expectedHash, expectedSizeBytes, onProgress, signal } = options2;
    const safeName = safeModelFileName(fileName);
    if (!url) throw Object.assign(new Error(`Keine Download-URL für ${safeName} hinterlegt`), { code: 'MODEL_NO_URL' });
    if (!fetchImpl) throw Object.assign(new Error('Diese Node-Laufzeit bietet kein fetch für Modell-Downloads'), { code: 'MODEL_DOWNLOAD_UNSUPPORTED' });
    await ensureRoot();

    const target = modelPath(safeName);
    const partial = partPath(safeName);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener?.('abort', cancel, { once: true });
    }
    activeDownloads.set(safeName, { cancel, startedAt: Date.now() });

    try {
      let resumeFrom = 0;
      try {
        const info = await fsp.stat(partial);
        if (info.isFile()) resumeFrom = info.size;
      } catch {
        resumeFrom = 0;
      }

      const headers = {};
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
      onProgress?.(toProgressEvent({ fileName: safeName, phase: 'connect', transferredBytes: resumeFrom, totalBytes: expectedSizeBytes ?? 0, message: `Verbinde mit ${new URL(url).host} …` }));

      const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (!response.ok && response.status !== 206) {
        throw Object.assign(new Error(`Download fehlgeschlagen (HTTP ${response.status}) für ${safeName}`), { code: 'MODEL_DOWNLOAD_FAILED' });
      }
      const resumed = response.status === 206 && resumeFrom > 0;
      if (!resumed && resumeFrom > 0) {
        // Server kennt kein Range → komplett neu laden.
        await fsp.rm(partial, { force: true });
        resumeFrom = 0;
      }
      const headerLength = Number(response.headers?.get?.('content-length') ?? 0) || 0;
      const totalBytes = headerLength ? resumeFrom + headerLength : expectedSizeBytes ?? 0;
      if (!response.body) throw Object.assign(new Error('Der Download lieferte keinen Datenstrom'), { code: 'MODEL_DOWNLOAD_FAILED' });

      await fsp.mkdir(path.dirname(partial), { recursive: true });
      const out = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
      let transferred = resumeFrom;
      let lastReport = 0;
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastReport > 120) {
          lastReport = now;
          onProgress?.(toProgressEvent({ fileName: safeName, phase: 'download', transferredBytes: transferred, totalBytes, message: `${(transferred / 1048576).toFixed(1)} MB geladen` }));
        }
      });
      try {
        await pipeline(source, out);
      } catch (error) {
        if (controller.signal.aborted) throw Object.assign(new Error('Modell-Download abgebrochen'), { code: 'MODEL_DOWNLOAD_CANCELLED' });
        throw Object.assign(new Error(`Modell-Download abgebrochen: ${error.message}`), { code: 'MODEL_DOWNLOAD_FAILED' });
      }

      onProgress?.(toProgressEvent({ fileName: safeName, phase: 'verify', transferredBytes: transferred, totalBytes: totalBytes || transferred, message: 'Prüfe Gewichte …' }));
      const actualSize = (await fsp.stat(partial)).size;
      if (!actualSize) throw Object.assign(new Error('Der Download lieferte eine leere Datei'), { code: 'MODEL_DOWNLOAD_FAILED' });
      if (expectedSizeBytes && actualSize !== expectedSizeBytes) {
        throw Object.assign(new Error(`Größe der Gewichte passt nicht: erwartet ${expectedSizeBytes} Byte, erhalten ${actualSize} Byte`), { code: 'MODEL_SIZE_MISMATCH' });
      }
      const digest = await sha256OfFile(partial);
      if (expectedHash && digest.toLowerCase() !== String(expectedHash).toLowerCase()) {
        await fsp.rm(partial, { force: true });
        throw Object.assign(new Error(`Prüfsumme der Gewichte passt nicht (sha256 ${digest.slice(0, 12)}…)`), { code: 'MODEL_HASH_MISMATCH' });
      }

      await fsp.rm(target, { force: true });
      await fsp.rename(partial, target);
      await rememberModel(safeName, { sha256: digest, sizeBytes: actualSize, source: 'DOWNLOAD', downloadedAt: Date.now(), url });
      onProgress?.(toProgressEvent({ fileName: safeName, phase: 'done', transferredBytes: actualSize, totalBytes: actualSize, message: 'Gewichte installiert' }));
      return { fileName: safeName, filePath: target, sizeBytes: actualSize, sha256: digest, source: 'DOWNLOAD' };
    } finally {
      activeDownloads.delete(safeName);
    }
  }

  function cancelDownload(fileName) {
    const entry = fileName ? activeDownloads.get(safeModelFileName(fileName)) : null;
    if (entry) {
      entry.cancel();
      return true;
    }
    let cancelled = 0;
    for (const active of activeDownloads.values()) {
      active.cancel();
      cancelled += 1;
    }
    return cancelled > 0;
  }

  /** Eigene Checkpoints in den Modell-Ordner kopieren (z. B. aus Colab). */
  async function importFile(sourcePath, options2 = {}) {
    const resolved = path.resolve(String(sourcePath));
    if (!isModelFileName(resolved)) {
      throw Object.assign(new Error(`Nur Modell-Gewichte (${MODEL_EXTENSIONS.join(', ')}) können importiert werden`), { code: 'MODEL_UNSUPPORTED_FILE' });
    }
    const info = await fsp.stat(resolved);
    if (!info.isFile()) throw Object.assign(new Error('Der Import-Pfad ist keine Datei'), { code: 'MODEL_IMPORT_FAILED' });
    await ensureRoot();
    const fileName = options2.fileName ? safeModelFileName(options2.fileName) : safeModelFileName(path.basename(resolved));
    const target = modelPath(fileName);
    if (path.resolve(target) === resolved) return { fileName, filePath: target, sizeBytes: info.size, source: 'IMPORT' };
    await fsp.copyFile(resolved, target);
    const digest = await sha256OfFile(target);
    await rememberModel(fileName, { sha256: digest, sizeBytes: info.size, source: 'IMPORT', importedAt: Date.now(), sourcePath: resolved, modelId: options2.modelId ?? null });
    return { fileName, filePath: target, sizeBytes: info.size, sha256: digest, source: 'IMPORT' };
  }

  async function remove(fileName) {
    const safeName = safeModelFileName(fileName);
    await fsp.rm(modelPath(safeName), { force: true });
    await fsp.rm(partPath(safeName), { force: true });
    const manifest = await readManifest();
    if (manifest.models?.[safeName]) {
      delete manifest.models[safeName];
      await writeManifest(manifest);
    }
    return { removed: safeName };
  }

  /**
   * Stellt sicher, dass die Gewichte für einen Lauf lokal verfügbar sind.
   * Ohne Direkt-URL wird an die CLI delegiert (die lädt in denselben Ordner).
   */
  async function ensureModel(entry, options2 = {}) {
    if (!entry || !entry.fileName) return { available: false, reason: 'Kein Modell gewählt', delegateToRuntime: false };
    const fileName = safeModelFileName(entry.fileName);
    const local = await describeFile(fileName);
    if (local) {
      return { available: true, fileName, filePath: local.filePath, sizeBytes: local.sizeBytes, delegateToRuntime: false, source: 'LOKAL' };
    }
    if (entry.downloadUrl) {
      const result = await download({ fileName, url: entry.downloadUrl, sha256: entry.sha256, expectedSizeBytes: entry.expectedSizeBytes, onProgress: options2.onProgress, signal: options2.signal });
      return { available: true, fileName, filePath: result.filePath, sizeBytes: result.sizeBytes, delegateToRuntime: false, source: 'DOWNLOAD' };
    }
    return {
      available: false,
      fileName,
      delegateToRuntime: true,
      reason: `Die Gewichte "${fileName}" liegen noch nicht im Modell-Ordner; die Separator-CLI lädt sie beim ersten Lauf automatisch herunter.`,
    };
  }

  return {
    rootDir,
    modelPath,
    partPath,
    ensureRoot,
    listInstalled,
    status,
    download,
    cancelDownload,
    importFile,
    remove,
    describeFile,
    ensureModel,
    sha256OfFile,
    activeDownloadCount: () => activeDownloads.size,
  };
}

module.exports = {
  MODEL_EXTENSIONS,
  MANIFEST_FILE,
  PART_SUFFIX,
  createStemModelStore,
  isModelFileName,
  safeModelFileName,
  sha256OfFile,
};
