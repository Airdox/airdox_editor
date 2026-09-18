/**
 * End-to-end desktop persistence seam: LoggerService → preload-shaped
 * appendLog bridge → registered main IPC handler → existing logWriter → file.
 * Electron itself is mocked only at its process boundary; the real formatter,
 * rotation-capable writer and exact IPC handler are executed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LoggerService } from '../src/utils/logger';

const require = createRequire(import.meta.url);
const { createLogWriter } = require('../electron/logWriter.cjs');
const { registerDesktopLoggingIpc } = require('../electron/loggingIpc.cjs');

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-desktop-log-e2e-'));

try {
  const handlers = new Map<string, (event: unknown, entry?: unknown) => unknown>();
  const writer = createLogWriter(path.join(tmp, 'userData', 'airdox-smart-editor.log'));
  registerDesktopLoggingIpc(
    { handle: (channel: string, handler: (event: unknown, entry?: unknown) => unknown) => handlers.set(channel, handler) },
    () => writer
  );

  const desktop = {
    rekordboxDesktop: {
      appendLog: (entry: unknown) => Promise.resolve(handlers.get('rekordbox:append-log')!(null, entry)),
      getLogFilePath: () => Promise.resolve(handlers.get('rekordbox:get-log-file-path')!(null)),
    },
    addEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
  };
  Object.defineProperty(globalThis, 'window', { value: desktop, configurable: true, writable: true });

  const logger = new LoggerService({ installGlobalHandlers: false });
  logger.info('DATABASE', '[DATABASE] AnalysisDataPath resolved under D:\\.', {
    contentId: '4242',
    analysisDataPath: '/PIONEER/USBANLZ/P001/00004242/ANLZ0000.DAT',
    sourceTag: 'PWV5',
  });
  // Drain the fire-and-forget Promise returned by the renderer bridge.
  await Promise.resolve();
  await Promise.resolve();

  const logPath = await desktop.rekordboxDesktop.getLogFilePath();
  assert.equal(logPath, writer.filePath);
  const output = fs.readFileSync(logPath as string, 'utf8');
  assert.match(output, /INFO \[DATABASE\] \[DATABASE\] AnalysisDataPath resolved under D/);
  assert.match(output, /"contentId":"4242"/);
  assert.match(output, /"sourceTag":"PWV5"/);

  console.log('desktop log persistence: OK');
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  fs.rmSync(tmp, { recursive: true, force: true });
}
