/**
 * Renderer diagnostic logger regression coverage.
 *
 * Exercises all levels, bounded ring buffer, subscribers, detail sanitizing,
 * global error handlers and the direct non-blocking Electron persistence path.
 */
import assert from 'node:assert/strict';
import {
  LoggerService,
  redactLogText,
  sanitizeLogDetails,
} from '../src/utils/logger';

type Handler = (event: any) => void;

class FakeWindow {
  readonly listeners = new Map<string, Handler[]>();
  rekordboxDesktop?: any;
  innerWidth = 1280;
  innerHeight = 720;

  addEventListener(type: string, handler: Handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type: string, event: any) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalConsole = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
// Keep test output readable while still exercising console sink calls.
console.debug = () => undefined;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

function installWindow(fake: FakeWindow | undefined) {
  if (fake) {
    Object.defineProperty(globalThis, 'window', { value: fake, configurable: true, writable: true });
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

try {
  // ── Sanitizing / privacy / non-serializable values ──────────────────────
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const sanitized = sanitizeLogDetails({
    password: 'do-not-persist',
    token: 'also-do-not-persist',
    musicalKey: '8A',
    circular,
    dom: { tagName: 'div', nodeType: 1 },
    bytes: new Uint8Array([1, 2, 3]),
    unsupported: () => 'x',
  }) as Record<string, any>;
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.token, '[REDACTED]');
  assert.equal(sanitized.musicalKey, '8A');
  assert.equal(sanitized.circular.self, '[Circular]');
  assert.equal(sanitized.dom, '[DOM Element <DIV>]');
  assert.equal(sanitized.bytes, '[Binary data 3 bytes]');
  assert.match(String(sanitized.unsupported), /^\[Function/);
  assert.doesNotMatch(redactLogText('Authorization=secret-value Bearer abc.def {"apiKey":"json-secret"}'), /secret-value|abc\.def|json-secret/);

  // ── All levels, max entries, subscription and unsubscribe ───────────────
  installWindow(undefined);
  const ring = new LoggerService({ maxEntries: 3, installGlobalHandlers: false });
  const received: string[] = [];
  const unsubscribe = ring.subscribe((entry) => received.push(entry.level));
  ring.debug('SYSTEM', 'debug');
  ring.info('SYSTEM', 'info');
  ring.warn('SYSTEM', 'warn');
  ring.error('SYSTEM', 'error', new Error('error-stack'));
  ring.fatal('SYSTEM', 'fatal', new Error('fatal-stack'));
  assert.deepEqual(received, ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
  assert.deepEqual(ring.getEntries().map((entry) => entry.level), ['WARN', 'ERROR', 'FATAL']);
  assert.match(ring.getEntries()[1].stack || '', /error-stack/);
  unsubscribe();
  ring.info('SYSTEM', 'not-subscribed');
  assert.equal(received.length, 5);
  ring.clear();
  assert.equal(ring.getEntries().length, 1, 'clear retains only its explicit audit event');
  assert.equal(ring.getEntries()[0].message, 'Log-Puffer zurückgesetzt.');

  // A failing live subscriber must not prevent later subscribers or persistence.
  const listenerSafe = new LoggerService({ installGlobalHandlers: false });
  let laterSubscriberCalled = false;
  listenerSafe.subscribe(() => { throw new Error('listener failure'); });
  listenerSafe.subscribe(() => { laterSubscriberCalled = true; });
  assert.doesNotThrow(() => listenerSafe.info('SYSTEM', 'listener-safe'));
  assert.equal(laterSubscriberCalled, true);

  // ── Direct Electron mirroring and the required payload shape ────────────
  const desktop = new FakeWindow();
  const persisted: any[] = [];
  desktop.rekordboxDesktop = {
    appendLog(entry: any) {
      persisted.push(entry);
      return Promise.resolve(true);
    },
  };
  installWindow(desktop);
  const persistedLogger = new LoggerService({ installGlobalHandlers: false });
  const durableEntry = persistedLogger.error('DATABASE', 'password=hidden', {
    id: 'diagnostic-id',
    details: 'safe',
    apiKey: 'must-not-reach-file',
  });
  await Promise.resolve();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].ts, durableEntry.timestamp);
  assert.equal(persisted[0].level, 'ERROR');
  assert.equal(persisted[0].category, 'DATABASE');
  assert.match(persisted[0].message, /password=\[REDACTED\]/);
  assert.equal(persisted[0].data.id, durableEntry.id);
  assert.equal(persisted[0].data.details.apiKey, '[REDACTED]');
  assert.ok(typeof persisted[0].data.stack === 'string');

  // Missing bridge, a synchronous throw and a rejected invocation must all be
  // harmless and must not create recursive error entries.
  installWindow(new FakeWindow());
  const noBridge = new LoggerService({ installGlobalHandlers: false });
  assert.doesNotThrow(() => noBridge.info('SYSTEM', 'browser/no bridge'));

  const throwingBridge = new FakeWindow();
  throwingBridge.rekordboxDesktop = { appendLog() { throw new Error('sync IPC failed'); } };
  installWindow(throwingBridge);
  const syncFailure = new LoggerService({ installGlobalHandlers: false });
  assert.doesNotThrow(() => syncFailure.warn('SYSTEM', 'sync persistence failure'));
  assert.equal(syncFailure.getEntries().length, 1);

  const rejectingBridge = new FakeWindow();
  rejectingBridge.rekordboxDesktop = { appendLog() { return Promise.reject(new Error('async IPC failed')); } };
  installWindow(rejectingBridge);
  const asyncFailure = new LoggerService({ installGlobalHandlers: false });
  assert.doesNotThrow(() => asyncFailure.warn('SYSTEM', 'async persistence failure'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(asyncFailure.getEntries().length, 1);

  // ── Browser global error and unhandled rejection handling ───────────────
  const globals = new FakeWindow();
  installWindow(globals);
  const globalLogger = new LoggerService({ maxEntries: 10 });
  assert.equal(globalLogger.getEntries()[0].message, 'Umfassendes Log-System erfolgreich initialisiert (Max Transparenz).');
  globals.dispatch('error', {
    message: 'bad password=not-for-log',
    filename: 'renderer.ts',
    lineno: 12,
    colno: 3,
    error: new Error('boom'),
  });
  globals.dispatch('unhandledrejection', { reason: new Error('async boom') });
  const globalEntries = globalLogger.getEntries();
  assert.equal(globalEntries.at(-2)?.level, 'FATAL');
  assert.equal(globalEntries.at(-2)?.category, 'SYSTEM');
  assert.doesNotMatch(globalEntries.at(-2)?.message || '', /not-for-log/);
  assert.equal(globalEntries.at(-1)?.level, 'FATAL');
  assert.match(globalEntries.at(-1)?.stack || '', /async boom/);

  originalConsole.log('logger: OK');
} finally {
  console.debug = originalConsole.debug;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
