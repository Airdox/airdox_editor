import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeTorchRuntime, clearTorchProbeCache } from '../src/stems/backends/runtimeProbe';

// The bundled Windows CPU runtime measured 24.23 s on a cold import. A real
// 21 s child response guards against restoring the former 20 s false failure.
const root = await mkdtemp(path.join(os.tmpdir(), 'airdox-cold-import-'));
const interpreter = path.join(root, 'fake-python.cjs');
await writeFile(interpreter, `
if (process.argv.some(arg => arg.includes('find_spec'))) {
  console.log('AIRDDOX_PROBE '+JSON.stringify({version:'3.11.9',executable:'fixture',modules:{torch:true}}));
} else setTimeout(() => console.log('AIRDDOX_TORCH 2.5.1+cpu'), 21000);
`);
let ticks = 0;
const interval = setInterval(() => ticks++, 100);
try {
  clearTorchProbeCache();
  const started = Date.now();
  const strict = await probeTorchRuntime({ command: process.execPath, argsPrefix: [interpreter], mode: 'strict' });
  assert.equal(strict.available, true, strict.reason);
  assert.equal(strict.verification, 'import');
  assert.ok(Date.now() - started >= 21000);
  assert.ok(ticks > 20, `Host bleibt während kaltem Import asynchron (${ticks} Ticks)`);
  const fastStart = Date.now();
  const fast = await probeTorchRuntime({ command: process.execPath, argsPrefix: [interpreter], mode: 'fast' });
  assert.equal(fast.available, true);
  assert.ok(Date.now() - fastStart < 1000, 'Status löst keinen zweiten langen Import aus');
  console.log(`PASS kalter >20s Import: ${ticks} Host-Ticks; anschließender schneller Status aus Cache`);
} finally { clearInterval(interval); await rm(root, { recursive: true, force: true }); }
