'use strict';
/**
 * Ehrliche Installationsmeldung für ONNX-Modelle.
 *
 * Aus dem Produktionslog vom 18.09.2026: „KI-Modell wurde installiert und
 * verifiziert: htdemucs-onnx-4stem-fp16“ – für einen Graphen, dessen
 * Katalog-Eintrag noch `unverified` ist und dessen Runtime im App-Prozess
 * fehlen kann. Der Installer sagt jetzt genau, was er geprüft hat:
 *
 *   #1 Katalog-Hash „unverified“ → Hash wird *berechnet* und als Manifest
 *      festgehalten; die Meldung nennt ihn und die Runtime-Lage.
 *   #2 Lauffähige Hash-Prüfung → „SHA256-geprüft“, kein Hinweis.
 *   #3 Fehlt die in-process ONNX-Runtime, nennt die Meldung die Ursache –
 *      „installiert und verifiziert“ wäre gelogen.
 *   #4 Vorhandene Datei mit falschem Hash wird nicht aktiviert (Regression).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installStemEngine, installationPaths } = require('../electron/stemInstaller.cjs');

function makeEnv() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-onnx-honesty-'));
  const repo = path.join(temp, 'repo');
  const stemsRoot = path.join(temp, 'stems');
  const paths = installationPaths(repo, { stemsRoot });
  fs.mkdirSync(path.dirname(paths.catalog), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/stems/modelCatalog.json'), paths.catalog);
  return { temp, repo, stemsRoot, paths };
}

function fakeFetch(payload) {
  return async () => ({
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
  });
}

function setCatalogHash(paths, sha256) {
  const catalog = JSON.parse(fs.readFileSync(paths.catalog, 'utf8'));
  const model = catalog.models.find((entry) => entry.id === 'htdemucs-onnx-4stem-fp16');
  model.checkpoint.sha256 = sha256;
  fs.writeFileSync(paths.catalog, JSON.stringify(catalog, null, 2));
  return model;
}

async function main() {
  const payload = Buffer.from('tiny-onnx-graph-placeholder'.repeat(64));
  const realSha = crypto.createHash('sha256').update(payload).digest('hex');

  // 1. Katalog-Hash unverified, Runtime fehlt: berechnen + ehrlich melden.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    setCatalogHash(paths, undefined);
    const result = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      fetchImpl: fakeFetch(payload),
      checkOnnxRuntime: () => ({ available: false, reason: "Cannot find package 'onnxruntime-node'" }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sha256, realSha, 'Der berechnete SHA256 muss zurückkommen (zum Eintragen in den Katalog)');
    assert.equal(result.hashVerified, false, 'Ohne Katalog-Hash ist nichts verifiziert');
    assert.equal(result.runtimeAvailable, false);
    assert.doesNotMatch(result.label, /verifiziert|geprüft/, `Label darf nichts behaupten: ${result.label}`);
    assert.match(result.label, /htdemucs-onnx-4stem-fp16/);
    assert.match(result.warning, /onnxruntime-node/, `Runtime-Warnung fehlt: ${result.warning}`);
    assert.match(result.warning, /Cannot find package/);

    const manifest = JSON.parse(fs.readFileSync(path.join(paths.modelDir, 'installed-models.json'), 'utf8'));
    assert.equal(manifest['htdemucs-onnx-4stem-fp16'].sha256, realSha, 'Manifest muss den berechneten Hash festhalten');
    assert.equal(manifest['htdemucs-onnx-4stem-fp16'].catalogSha256, null);
    assert.equal(manifest['htdemucs-onnx-4stem-fp16'].file, 'htdemucs_fp16weights.onnx');
    console.log('  ✓ #1 unverified → Hash berechnet, Runtime-Lage gemeldet, Manifest geschrieben');
  }

  // 2. Verifizierbarer Hash + lauffähige Runtime: „SHA256-geprüft“, kein Hinweis.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    setCatalogHash(paths, realSha);
    const result = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      fetchImpl: fakeFetch(payload),
      checkOnnxRuntime: () => ({ available: true }),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.hashVerified, true);
    assert.match(result.label, /SHA256-geprüft/);
    assert.equal(result.warning, undefined, `Kein Hinweis bei geprüftem Hash: ${result.warning}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(paths.modelDir, 'installed-models.json'), 'utf8'));
    assert.equal(manifest['htdemucs-onnx-4stem-fp16'].catalogSha256, realSha);
    console.log('  ✓ #2 geprüfter Hash → „SHA256-geprüft“, kein Hinweis');
  }

  // 3. Zweiter Lauf mit identischer Datei: idempotent, kein erneuter Download.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    setCatalogHash(paths, realSha);
    const options = {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      fetchImpl: fakeFetch(payload),
      checkOnnxRuntime: () => ({ available: true }),
    };
    await installStemEngine(repo, undefined, options);
    let downloads = 0;
    const countingFetch = async (...args) => {
      downloads += 1;
      return fakeFetch(payload)(...args);
    };
    const second = await installStemEngine(repo, undefined, { ...options, fetchImpl: countingFetch });
    assert.equal(second.ok, true, second.error);
    assert.equal(downloads, 0, 'Vorhandene, geprüfte Datei darf nicht erneut geladen werden');
    assert.equal(second.hashVerified, true);
    console.log('  ✓ #3 zweiter Lauf ohne Download');
  }

  // 4. Regression: vorhandene Datei mit falschem Hash wird nicht aktiviert.
  {
    const { repo, stemsRoot, paths } = makeEnv();
    setCatalogHash(paths, 'ab'.repeat(32));
    fs.mkdirSync(paths.modelDir, { recursive: true });
    fs.writeFileSync(path.join(paths.modelDir, 'htdemucs_fp16weights.onnx'), Buffer.from('falscher inhalt'));
    const result = await installStemEngine(repo, undefined, {
      stemsRoot,
      modelId: 'htdemucs-onnx-4stem-fp16',
      fetchImpl: fakeFetch(Buffer.from('anderer inhalt')),
      checkOnnxRuntime: () => ({ available: true }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /SHA256/);
    console.log('  ✓ #4 falscher Hash → keine Aktivierung');
  }

  console.log('PASS: ONNX-Installation meldet genau das, was sie geprüft hat');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
