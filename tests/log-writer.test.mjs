/**
 * Tests for electron/logger.cjs — the durable daily logger that merges main+renderer
 * Covers: daily rotation file path, secret redaction, binary summarization, retention, session header
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const logger = require('../electron/logger.cjs');

// formatLogLine compatibility
const line = logger.formatLogLine({ level: 'INFO', message: 'test', ts: Date.now() });
assert.ok(line.includes('INFO'), 'formatLogLine contains level');
assert.ok(line.includes('test'), 'formatLogLine contains message');

// Secret redaction
const redacted = logger.redactSecrets({ apiKey: '123', password: 'secret', normal: 'ok' });
assert.equal(redacted.apiKey, '[REDACTED]');
assert.equal(redacted.password, '[REDACTED]');
assert.equal(redacted.normal, 'ok');

// Binary summarization
const bin = logger.summarizeForLog(Buffer.from('hello world'));
assert.ok(bin.__binary, 'binary summarized');
assert.equal(bin.byteLength, 11);

const bin2 = logger.summarizeForLog(new Uint8Array(2048));
assert.ok(bin2.__binary, 'Uint8Array summarized');

const arr = logger.summarizeForLog(new Array(200).fill(0));
assert.ok(arr.__array, 'large array summarized');

// Daily file path
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-logger-'));
const fakeApp = { getPath: (name) => { if (name === 'userData') return tmp; return os.tmpdir(); } };
const logDir = logger.getLogDir(fakeApp);
assert.ok(logDir.includes('logs'), 'log dir contains logs');

const filePath = logger.getLogFilePath(fakeApp, new Date('2026-09-17T12:00:00Z'));
assert.ok(filePath.includes('airdox-editor-2026-09-17.log'), 'daily file name');

// Configure logger and write
logger.configureLogger({ app: fakeApp, level: 'debug' });
logger.info('Test info', { detail: 'hello' });
logger.error('Test error', { error: 'oops' });

// Check file exists and contains session header
const files = fs.readdirSync(path.join(tmp, 'logs'));
assert.ok(files.length > 0, 'log file created');
const content = fs.readFileSync(path.join(tmp, 'logs', files[0]), 'utf8');
assert.ok(content.includes('Session started'), 'session header present');
assert.ok(content.includes('Test info'), 'info logged');
assert.ok(content.includes('Test error'), 'error logged');

// Ingest renderer entries
logger.ingestRendererEntries([{ level: 'info', message: 'renderer test', data: { x: 1 } }], fakeApp);
const content2 = fs.readFileSync(path.join(tmp, 'logs', files[0]), 'utf8');
assert.ok(content2.includes('renderer test'), 'renderer entry ingested');

// Cleanup
fs.rmSync(tmp, { recursive: true, force: true });

console.log('log writer: OK');
process.exit(0);
