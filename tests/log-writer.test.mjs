/**
 * Tests for electron/logWriter.cjs — the durable single-line log writer that
 * persists every decisive pipeline parameter (ANLZ resolution, file sizes,
 * tags, waveform variants, merge verdicts) so a missing waveform can be
 * diagnosed from the log file alone.
 *
 * Covers: ISO timestamp format, level/category, newline collapsing, data JSON
 * serialization (incl. circular fallback), truncation, rotation into
 * .prev.log, and the never-throws guarantee.
 *
 * Run with: node tests/log-writer.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatLogLine, createLogWriter, DEFAULT_MAX_BYTES } = require('../electron/logWriter.cjs');

// ─── formatLogLine ──────────────────────────────────────────────────────────
const ts = new Date('2026-09-09T16:42:31.512Z').getTime();
const line = formatLogLine({ ts, level: 'INFO', category: 'DATABASE', message: 'Auflösung', data: { resolved: 'C:\\anlz\\ANLZ0000.DAT', bytes: 31415 } });
assert.ok(line.startsWith('2026-09-09T16:42:31.512Z INFO [DATABASE] Auflösung'), 'ISO time, level, category, message');
assert.ok(line.includes('"resolved":"C:\\\\anlz\\\\ANLZ0000.DAT"'), 'data appended as JSON');
assert.ok(!line.includes('\n'), 'single line only');

// Defaults and casing
const minimal = formatLogLine({ message: 'x' });
assert.ok(/ INFO \[SYSTEM\] x$/.test(minimal), 'defaults to INFO [SYSTEM]');
assert.ok(!minimal.endsWith(' | '), 'no dangling separator without data');

// Persistence boundary redacts secrets even if a caller bypassed LoggerService.
const secretLine = formatLogLine({
  ts,
  message: 'Authorization=should-not-persist Bearer abc.def',
  data: { password: 'nope', apiKey: 'also-nope', musicalKey: '8A' },
});
assert.ok(!secretLine.includes('should-not-persist') && !secretLine.includes('abc.def'), 'message credentials redacted');
assert.ok(!secretLine.includes('"password":"nope"') && !secretLine.includes('"apiKey":"also-nope"'), 'JSON credentials redacted');
assert.ok(secretLine.includes('"musicalKey":"8A"'), 'technical non-secret metadata is retained');

// Newlines inside message/data collapse instead of breaking the line format
const multi = formatLogLine({ ts, message: 'a\nb\r\nc', data: { x: '1\n2' } });
assert.strictEqual(multi.split('\n').length, 1, 'newlines collapsed');
assert.ok(multi.includes('a \\n b \\n c'), 'escaped newline markers');

// Circular data never throws and degrades to a string
const circular = { self: null };
circular.self = circular;
const circLine = formatLogLine({ ts, message: 'circular', data: circular });
assert.ok(circLine.includes('circular'), 'circular data handled');

// Truncation keeps lines bounded
const longMsg = formatLogLine({ ts, message: 'm'.repeat(5000) });
assert.ok(longMsg.length < 5000 && longMsg.includes('(+'), 'long message truncated with marker');
const longData = formatLogLine({ ts, message: 'ok', data: { blob: 'd'.repeat(9000) } });
assert.ok(longData.length < 9500 && longData.includes('(+'), 'long data truncated with marker');

// ─── createLogWriter ────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-log-'));
const filePath = path.join(tmp, 'nested', 'airdox-smart-editor.log');

const writer = createLogWriter(filePath);
assert.strictEqual(writer.bytesWritten, 0, 'fresh file starts at 0 bytes');
assert.strictEqual(writer.append(formatLogLine({ ts, message: 'erste Zeile' })), true, 'append succeeds');
assert.strictEqual(writer.append(formatLogLine({ ts, message: 'zweite Zeile' })), true, 'append succeeds');
const written = fs.readFileSync(filePath, 'utf8').trim().split('\n');
assert.strictEqual(written.length, 2, 'both lines persisted');
assert.ok(writer.bytesWritten > 0, 'byte accounting grows');

// Byte accounting resumes across restarts
const writer2 = createLogWriter(filePath);
assert.strictEqual(writer2.bytesWritten, writer.bytesWritten, 'existing size adopted');

// Rotation: tiny maxBytes forces a .prev.log rollover without data loss
const rotPath = path.join(tmp, 'rotate.log');
const rot = createLogWriter(rotPath, { maxBytes: 400 });
for (let i = 0; i < 10; i++) {
  assert.strictEqual(rot.append(formatLogLine({ ts, level: 'INFO', category: 'DATABASE', message: `entry ${i} ${'x'.repeat(60)}` })), true, `append ${i} succeeds`);
}
assert.ok(fs.existsSync(rot.prevPath), 'rotation creates .prev.log');
const prevContent = fs.readFileSync(rot.prevPath, 'utf8').trim();
const curContent = fs.readFileSync(rotPath, 'utf8').trim();
assert.ok(prevContent.includes('entry'), 'prev log retains earlier entries');
assert.ok(curContent.includes('entry 9'), 'current log continues after rotation');
assert.ok(fs.statSync(rot.prevPath).size <= 400 + 200, 'rotated file bounded (~maxBytes + one line)');

// A rotation failure is non-fatal: preserve current contents and accurate byte
// accounting rather than crashing or pretending the file is empty.
const failedRotationPath = path.join(tmp, 'rotation-failure.log');
const failedRotation = createLogWriter(failedRotationPath, { maxBytes: 20 });
assert.strictEqual(failedRotation.append('first durable line'), true);
fs.mkdirSync(failedRotation.prevPath);
fs.writeFileSync(path.join(failedRotation.prevPath, 'blocker'), 'x');
const bytesBeforeFailedRotation = failedRotation.bytesWritten;
assert.strictEqual(failedRotation.append('second durable line'), true, 'rotation failure falls back to current log append');
assert.ok(failedRotation.bytesWritten > bytesBeforeFailedRotation, 'failed rotation keeps byte accounting');
const failedRotationContents = fs.readFileSync(failedRotationPath, 'utf8');
assert.ok(failedRotationContents.includes('first durable line') && failedRotationContents.includes('second durable line'), 'failed rotation loses no current data');

// Never throws on unwritable targets — append degrades to false. A regular
// file used as a directory component fails mkdir/write on every OS (ENOTDIR).
const blocker = path.join(tmp, 'blocker');
fs.writeFileSync(blocker, 'x');
const bogus = createLogWriter(path.join(blocker, 'log.log'));
assert.strictEqual(bogus.append('anything'), false, 'unwritable target degrades to false');
assert.strictEqual(DEFAULT_MAX_BYTES, 5 * 1024 * 1024, '5 MB default rotation');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('log writer: OK');
process.exit(0);
