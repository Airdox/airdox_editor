import assert from 'node:assert/strict';
import { runBackendProcess } from '../src/stems/backends/processTransport';

const args = ['-e', "console.log('Demucs separated track into output folder');"];
await assert.rejects(runBackendProcess({ command: process.execPath, args }), /ohne done-Nachricht/);
const plain = await runBackendProcess({ command: process.execPath, args, protocol: 'exit-code' });
assert.equal(plain.exitCode, 0);
assert.ok(plain.logs.some(line => line.includes('Demucs')));
await assert.rejects(runBackendProcess({ command: process.execPath, args: ['-e', "console.error('Demucs failed'); process.exit(1)"], protocol: 'exit-code' }), /Demucs failed/);
await assert.rejects(runBackendProcess({ command: process.execPath, args: ['-e', "console.log(JSON.stringify({type:'error',code:'MODEL_MISSING',message:'weights missing'}))"], protocol: 'exit-code' }), /weights missing/);
console.log('PASS Demucs CLI: plain exit0 accepted explicitly; JSONL remains strict; nonzero/protocol errors rejected.');
