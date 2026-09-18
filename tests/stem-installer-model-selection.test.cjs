'use strict';
/**
 * CONTRACT TEST: Der In-App-Installer installiert exakt das im
 * Einstellungsmenü gewählte Modell (options.modelId) – und ohne Angabe das
 * primäre BS-RoFormer-Modell (Legacy-Verhalten). Kein Python für ONNX,
 * korrekte Verifizierungs-Marker je Familie, strikte Hash-Prüfung.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installStemEngine, installationPaths } = require('../electron/stemInstaller.cjs');

function makeEnv() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-installer-model-'));
  const repo = path.join(temp, 'repo');
  const stemsRoot = path.join(temp, 'stems');
  const paths = installationPaths(repo, { stemsRoot });
  fs.mkdirSync(path.dirname(paths.catalog), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/stems/modelCatalog.json'), paths.catalog);
  return { temp, repo, stemsRoot, paths };
}

function torchRunDouble(paths, { marker = 'BSROFORMER_VERIFIED', record } = {}) {
  return async (_command, args) => {
    record?.push(args);
    if (args.includes('-c')) return { ok: true, output: '3.11\n' };
    if (args.includes('venv')) {
      fs.mkdirSync(path.dirname(paths.python), { recursive: true });
      fs.writeFileSync(paths.python, 'test double');
      return { ok: true, output: '' };
    }
    return { ok: true, output: args.includes('6') ? `${marker}\n` : '' };
  };
}

function fakeFetch(payload, calls) {
  return async () => {
    calls.count += 1;
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(payload.length) : null) },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(payload) })),
          };
        },
      },
    };
  };
}

async function main() {
  // 1. Ohne modelId bleibt das primäre Modell (Legacy-Verhalten).
  {
    const { repo, stemsRoot, paths } = makeEnv();
    const result = await installStemEngine(repo, undefined, { stemsRoot, run: torchRunDouble(paths) });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.model, 'bsroformer-musdb18hq-4stem-zfturbo');
    const descriptor = JSON.parse(fs.readFileSync(path.join(stemsRoot, 'install-model.json'), 'utf8'));
    assert.equal(descriptor.id, 'bsroformer-musdb18hq-4stem-zfturbo');
  }

  // 2. modelId: anderes PyTorch-Modell (Mel-Band RoFormer) – exakt dieses wird installiert.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    const result = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'melbandroformer-viperx-vocals-3005',
      run: torchRunDouble(paths),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.model, 'melbandroformer-viperx-vocals-3005');
    const descriptor = JSON.parse(fs.readFileSync(path.join(stemsRoot, 'install-model.json'), 'utf8'));
    assert.equal(descriptor.id, 'melbandroformer-viperx-vocals-3005');
    assert.equal(descriptor.family, 'mel_band_roformer');
  }

  // 3. modelId: HT-Demucs (demucs-th) – DEMUXC_VERIFIED-Marker erforderlich.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    const run = torchRunDouble(paths, { marker: 'DEMUXC_VERIFIED' });
    const result = await installStemEngine(repo, undefined, { stemsRoot, modelId: 'htdemucs-ft-4stem', run });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.model, 'htdemucs-ft-4stem');
    const descriptor = JSON.parse(fs.readFileSync(path.join(stemsRoot, 'install-model.json'), 'utf8'));
    assert.equal(descriptor.id, 'htdemucs-ft-4stem');
    // Falscher Marker (BS-RoFormer) reicht nicht für ein Demucs-Modell.
    const wrongMarker = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'htdemucs-ft-4stem',
      run: async (c, a) => (a.includes('6') ? { ok: true, output: 'BSROFORMER_VERIFIED\n' } : run(c, a)),
    });
    assert.equal(wrongMarker.ok, false, 'Falscher Verifizierungs-Marker darf nicht durchgehen');
  }

  // 4. ONNX-Modell: reiner Download, kein Python, keine venv – 3 Schritte.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    let pythonCalls = 0;
    const fakeRun = async () => { pythonCalls += 1; return { ok: true, output: '' }; };
    const payload = Buffer.from('onnx-fixture');
    const calls = { count: 0 };
    const progress = [];
    const result = await installStemEngine(repo, (p) => progress.push(p), {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      run: fakeRun,
      fetchImpl: fakeFetch(payload, calls),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.model, 'htdemucs-onnx-4stem-fp16');
    assert.equal(pythonCalls, 0, 'ONNX-Pfad darf kein Python starten');
    assert.equal(calls.count, 1);
    const file = path.join(paths.modelDir, 'htdemucs_fp16weights.onnx');
    assert.ok(fs.existsSync(file), 'ONNX-Datei liegt im Model-Store');
    assert.ok(fs.readFileSync(file).equals(payload), 'ONNX-Inhalt unverändert');
    assert.equal(progress.at(-1).percent, 100);
    assert.equal(progress.at(-1).totalSteps, 3);
    // Zweiter Lauf: vorhandene Datei wird nicht erneut heruntergeladen.
    const result2 = await installStemEngine(repo, undefined, {
      stemsRoot, modelId: 'htdemucs-onnx-4stem-fp16', run: fakeRun, fetchImpl: fakeFetch(payload, calls),
    });
    assert.equal(result2.ok, true, result2.error);
    assert.equal(calls.count, 1, 'Vorhandene Datei darf nicht erneut geladen werden');
  }

  // 5. ONNX mit verifizierbarem SHA256: Abweichung wird abgelehnt, Datei nicht aktiviert.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    const catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8'));
    const onnx = catalog.models.find((model) => model.id === 'htdemucs-onnx-4stem-fp16');
    onnx.checkpoint.sha256 = 'ab'.repeat(32);
    fs.writeFileSync(paths.catalog, JSON.stringify(catalog));
    const calls = { count: 0 };
    const result = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      run: async () => ({ ok: true, output: '' }),
      fetchImpl: fakeFetch(Buffer.from('wrong-bytes'), calls),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /SHA256/);
    assert.ok(!fs.existsSync(path.join(paths.modelDir, 'htdemucs_fp16weights.onnx')), 'Datei mit falschem Hash darf nicht aktiviert werden');
    assert.ok(!fs.existsSync(path.join(paths.modelDir, 'htdemucs_fp16weights.onnx.part')), 'Teil-Datei muss geräumt sein');
  }

  // 6. Ablehnungen: unbekanntes Modell und Test-Double (synthetic).
  {
    const { repo, stemsRoot } = makeEnv();
    const unknown = await installStemEngine(repo, undefined, { stemsRoot, modelId: 'nope-does-not-exist' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /fehlt im Modell-Katalog/);
    const synthetic = await installStemEngine(repo, undefined, { stemsRoot, modelId: 'pipeline-double-v1' });
    assert.equal(synthetic.ok, false);
    assert.match(synthetic.error, /Test-Double/);
  }

  console.log('PASS: installer installiert exakt das gewählte Katalog-Modell');
}

main().catch((error) => { console.error(error); process.exit(1); });
