/**
 * Main-process durable logging IPC contract.
 * Tests Logger payload → explicit rekordbox IPC → existing logWriter → file,
 * and verifies handler/write failures resolve harmlessly rather than rejecting
 * the application action that emitted the diagnostic event.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLogWriter } = require('../electron/logWriter.cjs');
const {
  appendDesktopLog,
  getDesktopLogFilePath,
  registerDesktopLoggingIpc,
} = require('../electron/loggingIpc.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-logging-ipc-'));
try {
  const logPath = path.join(tmp, 'diagnostics', 'airdox-smart-editor.log');
  const writer = createLogWriter(logPath, { maxBytes: 512 });
  const calls = new Map();
  const ipcMain = {
    handle(channel, handler) {
      calls.set(channel, handler);
    },
  };

  registerDesktopLoggingIpc(ipcMain, () => writer);
  assert.deepEqual([...calls.keys()].sort(), [
    'rekordbox:append-log',
    'rekordbox:get-log-file-path',
  ], 'only the explicit preload channels are registered');
  assert.equal(calls.has('log:append'), false, 'obsolete generic channel is not registered');
  assert.equal(calls.has('log:get-path'), false, 'obsolete generic channel is not registered');

  const result = calls.get('rekordbox:append-log')(null, {
    ts: Date.parse('2026-09-18T12:00:00.000Z'),
    level: 'INFO',
    category: 'DATABASE',
    message: '[DATABASE] ANLZ tags detected',
    data: {
      id: 'log-42',
      details: { contentId: '4242', tags: ['PPTH', 'PWV5'], sourceTag: 'PWV5' },
      stack: undefined,
    },
  });
  assert.equal(result, true, 'main IPC forwards a renderer entry to the existing writer');
  const contents = fs.readFileSync(logPath, 'utf8');
  assert.match(contents, /INFO \[DATABASE\] \[DATABASE\] ANLZ tags detected/);
  assert.match(contents, /"contentId":"4242"/);
  assert.equal(calls.get('rekordbox:get-log-file-path')(), logPath);
  assert.equal(getDesktopLogFilePath(() => writer), logPath);

  // Unwritable/throwing writer and failed writer construction are observed
  // only as false/null values; no rejected handler can stop an app action.
  assert.doesNotThrow(() => appendDesktopLog(() => ({ append() { throw new Error('disk full'); } }), { message: 'x' }));
  assert.equal(appendDesktopLog(() => ({ append() { throw new Error('disk full'); } }), { message: 'x' }), false);
  assert.equal(appendDesktopLog(() => { throw new Error('userData unavailable'); }, { message: 'x' }), false);
  assert.equal(getDesktopLogFilePath(() => { throw new Error('userData unavailable'); }), null);

  console.log('logging IPC: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
