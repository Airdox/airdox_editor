import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { probeTorchRuntime, clearTorchProbeCache } from '../src/stems/backends/runtimeProbe';

// The bundled Windows CPU runtime measured 24.23 s on a cold import. A real
// 21 s child response guards against restoring the former 20 s false failure.
// Control the child transport: an unrelated >5 s Windows process startup must
// not consume the fast precheck budget before this test reaches the import.
// Production probe timers and the 21 s delay still run in real time.
let starts = 0;
const pending = new Set<ReturnType<typeof setTimeout>>();
mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
  assert.equal(command, process.execPath);
  starts++;
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough() });
  const fast = args.some(arg => arg.includes('find_spec'));
  const timer = setTimeout(() => {
    pending.delete(timer);
    stdout.end(fast
      ? 'AIRDDOX_PROBE '+JSON.stringify({version:'3.11.9',executable:'fixture',modules:{torch:true}})
      : 'AIRDDOX_TORCH 2.5.1+cpu');
    child.emit('close', 0);
  }, fast ? 0 : 21000);
  pending.add(timer);
  child.kill = () => {
    clearTimeout(timer);
    pending.delete(timer);
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  return child;
});
syncBuiltinESMExports();
let ticks = 0;
const interval = setInterval(() => ticks++, 100);
try {
  clearTorchProbeCache();
  const started = Date.now();
  const strict = await probeTorchRuntime({ command: process.execPath, mode: 'strict' });
  assert.equal(strict.available, true, strict.reason);
  assert.equal(strict.verification, 'import');
  assert.ok(Date.now() - started >= 21000);
  assert.ok(ticks > 20, `Host bleibt während kaltem Import asynchron (${ticks} Ticks)`);
  const fastStart = Date.now();
  const fast = await probeTorchRuntime({ command: process.execPath, mode: 'fast' });
  assert.equal(fast.available, true);
  assert.equal(fast.cached, true);
  assert.equal(starts, 2, 'Nur Vorprüfung und Import starten einen Prozess');
  assert.ok(Date.now() - fastStart < 1000, 'Status löst keinen zweiten langen Import aus');
  console.log(`PASS kalter >20s Import: ${ticks} Host-Ticks; anschließender schneller Status aus Cache`);
} finally {
  clearInterval(interval);
  for (const timer of pending) clearTimeout(timer);
  mock.restoreAll();
  syncBuiltinESMExports();
  clearTorchProbeCache();
}
