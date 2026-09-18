import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

console.log('=== ASAR UNPACK TEST – §10 ===');

async function run() {
  const pkgPath = path.resolve('package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

  const build = pkg.build;
  assert.ok(build, 'build config exists');
  assert.ok(build.asar, 'asar true');
  assert.ok(Array.isArray(build.asarUnpack), 'asarUnpack array');

  const unpack = build.asarUnpack as string[];
  const requiredPatterns = [
    'stem-runtime',
    'models',
    '.node',
    'python',
    'node-bridge.cjs',
  ];

  for (const pat of requiredPatterns) {
    const found = unpack.some((p) => p.includes(pat));
    assert.ok(found, `asarUnpack must include pattern for ${pat}: got ${unpack.join(', ')}`);
    console.log(`  [PASS] asarUnpack includes ${pat}`);
  }

  assert.ok(Array.isArray(build.extraResources), 'extraResources');
  const extra = build.extraResources as { from: string; to: string }[];
  const hasStemRuntime = extra.some((e) => e.from.includes('stem-runtime') && e.to === 'stem-runtime');
  const hasModels = extra.some((e) => e.from.includes('models') && e.to === 'models');
  assert.ok(hasStemRuntime, 'extraResources must include stem-runtime -> stem-runtime');
  assert.ok(hasModels, 'extraResources must include models -> models');
  console.log('  [PASS] extraResources includes stem-runtime and models');

  // Check files array includes python and dist
  const files = build.files as string[];
  assert.ok(files.some((f) => f.includes('dist')), 'files includes dist');
  assert.ok(files.some((f) => f.includes('electron')), 'files includes electron');
  assert.ok(files.some((f) => f.includes('python') || f.includes('modelCatalog')), 'files includes python or catalog');
  console.log('  [PASS] files includes dist, electron, python/catalog');

  console.log('ASAR unpack test passed – resources/stem-runtime and models are unpacked per §10');
}

run().catch((e) => { console.error(e); process.exit(1); });
