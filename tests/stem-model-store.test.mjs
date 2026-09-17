/**
 * Test des Stem-Model-Stores der Desktop-App (electron/stemModelStore.cjs).
 *
 * Geprüft wird der komplette Lebenszyklus der Modell-Gewichte gegen einen
 * lokalen HTTP-Stub: Katalog-Status, Download mit Fortschritt, Prüfsummen- und
 * Größenkontrolle, Wiederaufnahme (HTTP Range), Abbruch, Import eigener
 * Checkpoints und Entfernen – inklusive der Regel, dass niemals eine halbe
 * Datei als installiertes Modell sichtbar wird.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createStemModelStore, isModelFileName, safeModelFileName, MANIFEST_FILE, PART_SUFFIX } = require(
  path.join(root, 'electron', 'stemModelStore.cjs')
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[ PASS ] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[ FAIL ] ${name}`);
    console.error(`         ${error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : String(error)}`);
    process.exitCode = 1;
  }
}

// --- Test-Server -----------------------------------------------------------
const MODEL_BYTES = crypto.randomBytes(280 * 1024); // 280 kB „Gewichte“
const MODEL_HASH = crypto.createHash('sha256').update(MODEL_BYTES).digest('hex');
const SLOW_BYTES = crypto.randomBytes(4 * 1024 * 1024);

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/model.ckpt' || url.pathname === '/slow.ckpt') {
      const body = url.pathname === '/model.ckpt' ? MODEL_BYTES : SLOW_BYTES;
      const range = req.headers.range ? /bytes=(\d+)-/.exec(req.headers.range) : null;
      if (range) {
        const start = Number(range[1]);
        const slice = body.subarray(start);
        res.writeHead(206, { 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(body.length) });
      if (url.pathname === '/slow.ckpt') {
        // Bewusst langsam, damit der Abbruch greifen kann.
        let offset = 0;
        const timer = setInterval(() => {
          const chunk = SLOW_BYTES.subarray(offset, offset + 16 * 1024);
          offset += chunk.length;
          res.write(chunk);
          if (offset >= SLOW_BYTES.length) {
            clearInterval(timer);
            res.end();
          }
        }, 40);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.end(body);
      return;
    }
    if (url.pathname === '/broken.ckpt') {
      const body = Buffer.from('das ist kein Modell');
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Length': '0' });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const server = await startServer();
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stem-model-store-'));

const CATALOG = [
  {
    id: 'bsroformer-test',
    fileName: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    label: 'BS-RoFormer (Test)',
    architecture: 'BS_ROFORMER',
    stemOrder: ['vocals', 'other'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: true,
    qualityHint: 'Testeintrag',
    downloadUrl: `${baseUrl}/model.ckpt`,
    approximateSizeMb: 260,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'htdemucs-test',
    fileName: 'htdemucs',
    label: 'HT-Demucs (Test)',
    architecture: 'DEMUCS',
    stemOrder: ['drums', 'bass', 'other', 'vocals'],
    trainedModel: true,
    requiresExternalRuntime: true,
    recommended: false,
    qualityHint: 'CLI lädt selbst',
    downloadUrl: null,
    profile: 'HIGH_QUALITY',
  },
  {
    id: 'dsp-heuristic-v1',
    fileName: null,
    label: 'Interne Heuristik',
    architecture: 'HEURISTIC_DSP',
    stemOrder: ['vocals', 'drums', 'bass', 'other'],
    trainedModel: false,
    requiresExternalRuntime: false,
    recommended: false,
    qualityHint: 'Ohne Gewichte',
    downloadUrl: null,
    profile: 'PREVIEW',
  },
];

function newStore(name) {
  return createStemModelStore({ rootDir: path.join(workRoot, name) });
}

try {
  await test('#1 Dateinamen-Prüfung: nur Gewichte, keine Pfadtricks', () => {
    assert.equal(isModelFileName('model.ckpt'), true);
    assert.equal(isModelFileName('htdemucs'), false);
    assert.equal(isModelFileName('setup.exe'), false);
    assert.equal(safeModelFileName('/tmp/x/../../model.onnx'), 'model.onnx');
    assert.throws(() => safeModelFileName(''), /Ungültiger Modell-Dateiname/);
    assert.throws(() => safeModelFileName('..'), /Ungültiger Modell-Dateiname/);
  });

  await test('#2 Katalog-Status zeigt fehlende, delegierte und eingebaute Modelle', async () => {
    const store = newStore('status');
    const result = await store.status(CATALOG);
    assert.ok(result.modelDir.endsWith('status'));
    assert.equal(result.installedCount, 0);
    const byId = new Map(result.models.map((entry) => [entry.id, entry]));
    assert.equal(byId.get('bsroformer-test').installed, false);
    assert.equal(byId.get('bsroformer-test').delegateToRuntime, false, 'Mit Direkt-URL wird nicht delegiert');
    assert.equal(byId.get('htdemucs-test').delegateToRuntime, true, 'Ohne URL lädt die CLI');
    assert.equal(byId.get('dsp-heuristic-v1').requiresExternalRuntime, false);
    assert.equal(byId.get('dsp-heuristic-v1').installed, false);
  });

  await test('#3 Download legt Gewichte + Manifest atomar an und meldet Fortschritt', async () => {
    const store = newStore('download');
    const phases = [];
    const result = await store.download({
      fileName: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
      url: `${baseUrl}/model.ckpt`,
      sha256: MODEL_HASH,
      expectedSizeBytes: MODEL_BYTES.length,
      onProgress: (progress) => phases.push(progress.phase),
    });
    assert.equal(result.sizeBytes, MODEL_BYTES.length);
    assert.equal(result.sha256, MODEL_HASH);
    assert.ok(fs.existsSync(result.filePath));
    assert.ok(!fs.existsSync(`${result.filePath}${PART_SUFFIX}`), 'Temporäre .part-Datei muss weggeräumt sein');
    assert.ok(phases.includes('connect') && phases.includes('verify') && phases.includes('done'), `Phasen unvollständig: ${phases}`);

    const manifest = JSON.parse(await fsp.readFile(path.join(store.rootDir, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.models['model_bs_roformer_ep_317_sdr_12.9755.ckpt'].sha256, MODEL_HASH);
    assert.equal(manifest.models['model_bs_roformer_ep_317_sdr_12.9755.ckpt'].source, 'DOWNLOAD');

    const status = await store.status(CATALOG);
    const entry = status.models.find((model) => model.id === 'bsroformer-test');
    assert.equal(entry.installed, true);
    assert.equal(entry.sizeBytes, MODEL_BYTES.length);
    assert.equal(status.installedCount, 1);
  });

  await test('#4 Falsche Prüfsumme wird abgelehnt und hinterlässt kein Modell', async () => {
    const store = newStore('hash');
    await assert.rejects(
      store.download({ fileName: 'model.ckpt', url: `${baseUrl}/broken.ckpt`, sha256: 'f'.repeat(64) }),
      (error) => error.code === 'MODEL_HASH_MISMATCH'
    );
    assert.equal(fs.existsSync(store.modelPath('model.ckpt')), false);
    assert.equal(fs.existsSync(store.partPath('model.ckpt')), false, 'Beschädigte .part-Datei muss gelöscht werden');
  });

  await test('#5 Falsche Größe und HTTP-Fehler werden klassifiziert', async () => {
    const store = newStore('size');
    await assert.rejects(
      store.download({ fileName: 'model.ckpt', url: `${baseUrl}/model.ckpt`, expectedSizeBytes: 1234 }),
      (error) => error.code === 'MODEL_SIZE_MISMATCH'
    );
    await assert.rejects(
      store.download({ fileName: 'model.ckpt', url: `${baseUrl}/gibt-es-nicht.ckpt` }),
      (error) => error.code === 'MODEL_DOWNLOAD_FAILED'
    );
    await assert.rejects(store.download({ fileName: 'model.ckpt' }), (error) => error.code === 'MODEL_NO_URL');
  });

  await test('#6 Abbruch stoppt den Download, Ziel bleibt leer', async () => {
    const store = newStore('cancel');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(
      store.download({ fileName: 'slow.ckpt', url: `${baseUrl}/slow.ckpt`, signal: controller.signal }),
      (error) => error.code === 'MODEL_DOWNLOAD_CANCELLED' || error.code === 'MODEL_DOWNLOAD_FAILED'
    );
    assert.equal(fs.existsSync(store.modelPath('slow.ckpt')), false, 'Abgebrochener Download darf kein installiertes Modell vortäuschen');
    const installed = await store.listInstalled();
    assert.ok(installed.every((entry) => entry.fileName !== 'slow.ckpt' || entry.state === 'DOWNLOADING'));
  });

  await test('#7 Wiederaufnahme über HTTP Range vervollständigt die Gewichte', async () => {
    const store = newStore('resume');
    await store.ensureRoot();
    const part = store.partPath('model.ckpt');
    const firstHalf = MODEL_BYTES.subarray(0, Math.floor(MODEL_BYTES.length / 2));
    await fsp.writeFile(part, firstHalf);
    const result = await store.download({ fileName: 'model.ckpt', url: `${baseUrl}/model.ckpt`, sha256: MODEL_HASH });
    assert.equal(result.sizeBytes, MODEL_BYTES.length);
    const onDisk = await fsp.readFile(result.filePath);
    assert.equal(crypto.createHash('sha256').update(onDisk).digest('hex'), MODEL_HASH);
  });

  await test('#8 Eigene Checkpoints importieren und entfernen', async () => {
    const store = newStore('import');
    const source = path.join(workRoot, 'eigener-checkpoint.onnx');
    await fsp.writeFile(source, MODEL_BYTES);
    const imported = await store.importFile(source);
    assert.equal(imported.source, 'IMPORT');
    assert.equal(imported.sizeBytes, MODEL_BYTES.length);
    assert.ok(fs.existsSync(imported.filePath));
    assert.notEqual(imported.filePath, source, 'Original darf nicht verschoben werden');

    await assert.rejects(store.importFile(path.join(workRoot, 'setup.exe')), (error) => error.code === 'MODEL_UNSUPPORTED_FILE');

    const status = await store.status(CATALOG);
    const local = status.models.find((entry) => entry.fileName === 'eigener-checkpoint.onnx');
    assert.ok(local, 'Importierter Checkpoint muss im Status auftauchen');
    assert.equal(local.installed, true);
    assert.equal(local.source, 'IMPORT');

    await store.remove('eigener-checkpoint.onnx');
    assert.equal(fs.existsSync(imported.filePath), false);
    const after = await store.status(CATALOG);
    assert.ok(!after.models.some((entry) => entry.fileName === 'eigener-checkpoint.onnx'));
  });

  await test('#9 ensureModel: lokal verfügbar, delegiert an CLI, oder Download', async () => {
    const store = newStore('ensure');
    const delegated = await store.ensureModel({ fileName: 'htdemucs' });
    assert.equal(delegated.available, false);
    assert.equal(delegated.delegateToRuntime, true);
    assert.ok(/automatisch/.test(delegated.reason));

    const downloaded = await store.ensureModel({ fileName: 'model.ckpt', downloadUrl: `${baseUrl}/model.ckpt`, sha256: MODEL_HASH });
    assert.equal(downloaded.available, true);
    assert.equal(downloaded.source, 'DOWNLOAD');

    const local = await store.ensureModel({ fileName: 'model.ckpt' });
    assert.equal(local.available, true);
    assert.equal(local.source, 'LOKAL');

    const missing = await store.ensureModel({ fileName: 'unbekannt.ckpt' });
    assert.equal(missing.available, false);
    assert.equal(missing.delegateToRuntime, true);
  });

  await test('#10 Halbe Downloads erscheinen als DOWNLOADING, Fremddateien werden ignoriert', async () => {
    const store = newStore('listing');
    await store.ensureRoot();
    await fsp.writeFile(store.partPath('halb.ckpt'), Buffer.from('unvollständig'));
    await fsp.writeFile(path.join(store.rootDir, 'notizen.txt'), 'kein Modell');
    await fsp.writeFile(path.join(store.rootDir, 'ganz.onnx'), MODEL_BYTES);
    const installed = await store.listInstalled();
    const byName = new Map(installed.map((entry) => [entry.fileName, entry]));
    assert.equal(byName.get('halb.ckpt').state, 'DOWNLOADING');
    assert.equal(byName.get('ganz.onnx').state, 'INSTALLED');
    assert.equal(byName.has('notizen.txt'), false);
    const withHash = await store.listInstalled({ withHash: true });
    assert.equal(withHash.find((entry) => entry.fileName === 'ganz.onnx').sha256, MODEL_HASH);
  });
} finally {
  server.close();
  await fsp.rm(workRoot, { recursive: true, force: true });
}

console.log(`\nstem-model-store: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exitCode = 1;
