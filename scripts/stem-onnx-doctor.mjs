#!/usr/bin/env node
/**
 * ONNX-Fast-Path-Diagnose (§ new).
 *
 * Beantwortet auf dem Zielrechner in einem Lauf:
 *   - liegt onnxruntime-node bereit und welche Execution Provider kann es?
 *   - welchen Provider würde die Engine wählen (mit und ohne Modell)?
 *   - ist das ONNX-Modell da, wie groß ist es, welchen sha256 hat es?
 *   - welche Segmentlänge verlangt der Graph (inputMetadata)?
 *   - wie schnell rechnet dieser Rechner wirklich (RTF, nur mit --bench)?
 *
 * Aufruf:
 *   npm run stems:onnx:doctor
 *   npm run stems:onnx:doctor -- --model-dir "C:\\Users\\me\\AppData\\Roaming\\airdox_SMART_Editor\\stems\\Models"
 *   npm run stems:onnx:doctor -- --bench --seconds 30
 *   npm run stems:onnx:doctor -- --json
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'htdemucs-onnx-4stem-fp16';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

async function loadCatalog() {
  const raw = await readFile(path.join(ROOT, 'src', 'stems', 'modelCatalog.json'), 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const json = Boolean(arg('json', false));
  const bench = Boolean(arg('bench', false));
  const seconds = Number(arg('seconds', 30));
  const catalog = await loadCatalog();
  const descriptor = catalog.models.find((entry) => entry.id === MODEL_ID);
  const report = { ok: true, problems: [], runtime: {}, providers: {}, model: {}, bench: null };

  // ---- 1. Runtime ---------------------------------------------------------
  let ort = null;
  try {
    ort = await import('onnxruntime-node');
  } catch (error) {
    report.ok = false;
    report.problems.push(
      `onnxruntime-node nicht ladbar: ${error.message}. Installation: npm install (Binary steckt im npm-Tarball; „npm install onnxruntime-node --onnxruntime-node-install=skip" überspringt den CUDA-Download)`
    );
  }
  if (ort) {
    const supported = typeof ort.listSupportedBackends === 'function' ? ort.listSupportedBackends() : [];
    let ortVersion = ort.env?.versions?.onnxruntime;
    if (!ortVersion) {
      try {
        const { createRequire } = await import('node:module');
        ortVersion = createRequire(import.meta.url)('onnxruntime-node/package.json').version;
      } catch {
        ortVersion = 'unbekannt';
      }
    }
    report.runtime = { version: ortVersion, node: process.versions.node, platform: `${process.platform}-${process.arch}` };
    report.providers = {
      supported,
      bundled: supported.filter((entry) => entry.bundled !== false).map((entry) => entry.name),
      downloadable: supported.filter((entry) => entry.bundled === false).map((entry) => entry.name),
    };
    // Der TS-Modul-Import klappt nur unter tsx; sonst entscheidet dieselbe
    // Plattformlogik hier lokal (Quelle: src/stems/backends/onnxSeparator.ts).
    let planned = null;
    try {
      const module = await import('../src/stems/backends/onnxSeparator.ts');
      planned = module.describeProviderPlan?.('auto') ?? null;
    } catch {
      planned = null;
    }
    if (!planned) {
      const platformOrder = process.platform === 'win32' ? ['dml'] : process.platform === 'darwin' ? ['coreml'] : ['cuda', 'tensorrt'];
      const bundledSet = new Set(report.providers.bundled ?? []);
      planned = [...platformOrder.filter((name) => bundledSet.has(name)), 'cpu'];
    }
    report.providers.planned = planned;
  }

  // ---- 2. Modell ----------------------------------------------------------
  const modelDirArg = arg('model-dir', undefined);
  const candidates = [
    modelDirArg && modelDirArg !== 'true' ? String(modelDirArg) : null,
    process.env.AIRDOX_STEM_MODEL_DIR,
    process.env.AIRDOX_STEM_CHECKPOINT_DIR,
    path.join(ROOT, 'resources', 'models'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'airdox_SMART_Editor', 'stems', 'Models') : null,
    process.env.HOME ? path.join(process.env.HOME, '.config', 'airdox_SMART_Editor', 'stems', 'Models') : null,
  ].filter(Boolean);

  const file = descriptor?.checkpoint?.file ?? 'htdemucs_fp16weights.onnx';
  let modelPath = null;
  for (const dir of candidates) {
    const candidate = path.join(dir, file);
    if (existsSync(candidate)) {
      modelPath = candidate;
      break;
    }
  }
  if (!modelPath) {
    report.ok = false;
    report.problems.push(
      `Modell ${file} nicht gefunden. Gesucht in: ${candidates.join(', ')}. Laden mit: npm run stems:bundle -- --models ${MODEL_ID}`
    );
  } else {
    const size = statSync(modelPath).size;
    const hash = await sha256(modelPath);
    const expected = descriptor?.checkpoint?.sha256;
    const pinned = typeof expected === 'string' && /^[a-f0-9]{64}$/i.test(expected);
    report.model = {
      path: modelPath,
      bytes: size,
      mib: Number((size / (1024 * 1024)).toFixed(1)),
      sha256: hash,
      expected: expected ?? null,
      hashVerified: pinned ? hash.toLowerCase() === expected.toLowerCase() : false,
      pinned: Boolean(pinned),
    };
    if (pinned && !report.model.hashVerified) {
      report.ok = false;
      report.problems.push(`sha256 weicht ab: Datei ${hash} != Katalog ${expected}`);
    }
    if (!pinned) {
      report.problems.push(
        `Katalog führt für ${MODEL_ID} noch "unverified". Nach dem ersten Download diesen Wert in src/stems/modelCatalog.json eintragen: "sha256": "${hash}" (und modelHash/checkpointSha256 gleich setzen) – danach prüft jeder Lauf und jedes Bundling den Hash.`
      );
    }
    if (ort) {
      try {
        const session = await ort.InferenceSession.create(modelPath, { executionProviders: report.providers.planned?.length ? report.providers.planned : ['cpu'], graphOptimizationLevel: 'all' });
        const input = session.inputMetadata?.[0];
        const output = session.outputMetadata?.[0];
        report.model.input = input ? { name: input.name, type: input.type, shape: input.shape } : null;
        report.model.output = output ? { name: output.name, type: output.type, shape: output.shape } : null;
        const segment = Array.isArray(input?.shape) ? Number(input.shape[input.shape.length - 1]) : NaN;
        report.model.segmentSamples = Number.isFinite(segment) ? segment : null;
        if (report.model.segmentSamples && descriptor?.chunkSizeSamples && report.model.segmentSamples !== descriptor.chunkSizeSamples) {
          report.problems.push(
            `Segmentlänge des Graphen (${report.model.segmentSamples}) weicht vom Katalog (${descriptor.chunkSizeSamples}) ab – die Engine nutzt die Graphenlänge.`
          );
        }
      } catch (error) {
        report.ok = false;
        report.problems.push(`Session ließ sich nicht erstellen: ${error.message}`);
      }
    }
  }

  // ---- 3. Micro-Benchmark (RTF) ------------------------------------------
  if (bench && ort && modelPath && report.model.segmentSamples) {
    const segment = report.model.segmentSamples;
    const frames = Math.max(segment, Math.round(seconds * 44100));
    const input = new Float32Array(2 * frames);
    for (let i = 0; i < frames; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 110 * i) / 44100);
      input[frames + i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / 44100);
    }
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: report.providers.planned?.length ? report.providers.planned : ['cpu'], graphOptimizationLevel: 'all' });
    const started = Date.now();
    let processed = 0;
    for (let offset = 0; offset + segment <= frames; offset += segment) {
      const chunk = new Float32Array(2 * segment);
      chunk.set(input.subarray(offset, offset + segment), 0);
      chunk.set(input.subarray(frames + offset, frames + offset + segment), segment);
      const tensor = new ort.Tensor('float32', chunk, [1, 2, segment]);
      await session.run({ [session.inputNames[0]]: tensor });
      processed += segment;
    }
    const elapsedMs = Date.now() - started;
    const audioSeconds = processed / 44100;
    report.bench = {
      audioSeconds: Number(audioSeconds.toFixed(1)),
      elapsedMs,
      rtf: Number((elapsedMs / 1000 / audioSeconds).toFixed(3)),
      secondsPerAudioMinute: Number(((elapsedMs / 1000 / audioSeconds) * 60).toFixed(1)),
      provider: (report.providers.planned?.length ? report.providers.planned : ['cpu'])[0],
    };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const line = (label, value) => process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
    process.stdout.write('═══════════════════════════════════════════════════════════════════\n');
    process.stdout.write('  airdox – ONNX Fast-Path-Diagnose\n');
    process.stdout.write('═══════════════════════════════════════════════════════════════════\n');
    line('Runtime', report.runtime.version ? `onnxruntime ${report.runtime.version} (Node ${report.runtime.node}, ${report.runtime.platform})` : 'nicht ladbar');
    line('Provider gebündelt', (report.providers.bundled ?? []).join(', ') || '—');
    line('Provider nachladbar', (report.providers.downloadable ?? []).join(', ') || '—');
    line('Provider geplant', (report.providers.planned ?? []).join(' > ') || '—');
    if (report.model.path) {
      line('Modell', report.model.path);
      line('Größe', `${report.model.mib} MiB`);
      line('sha256', `${report.model.sha256}${report.model.pinned ? (report.model.hashVerified ? '  ✓ geprüft' : '  ✗ weicht ab') : '  (nicht im Katalog gepinnt)'}`);
      line('I/O', report.model.input ? `${report.model.input.name} ${JSON.stringify(report.model.input.shape)} -> ${report.model.output?.name} ${JSON.stringify(report.model.output?.shape)}` : '—');
      line('Segment', report.model.segmentSamples ? `${report.model.segmentSamples} Samples (${(report.model.segmentSamples / 44100).toFixed(1)} s)` : '—');
    }
    if (report.bench) {
      line('Benchmark', `${report.bench.audioSeconds} s Audio in ${report.bench.elapsedMs} ms -> RTF ${report.bench.rtf} (${report.bench.secondsPerAudioMinute} s je Audiominute, ${report.bench.provider})`);
      line('Hochrechnung', `6-Minuten-Track ≈ ${Math.round((report.bench.secondsPerAudioMinute * 6) / 60)} min Rechenzeit mit diesem Provider`);
    } else if (!bench) {
      line('Benchmark', 'übersprungen (mit --bench aktivieren)');
    }
    if (report.problems.length) {
      process.stdout.write('\n  Hinweise:\n');
      for (const problem of report.problems) process.stdout.write(`    - ${problem}\n`);
    }
    process.stdout.write(report.ok ? '\n✔ ONNX-Pfad einsatzbereit.\n' : '\n✘ ONNX-Pfad noch nicht einsatzbereit (siehe Hinweise).\n');
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\n✘ FEHLER: ${error?.stack ?? error}\n`);
  process.exit(1);
});
