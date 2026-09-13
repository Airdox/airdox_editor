/**
 * @license
 * Regression suite for the main-process file logger
 * (electron/logger.cjs) and its renderer ingestion contract.
 *
 * Guarantees:
 *  - a configured logger actually creates an append-only *.log file
 *  - the session header, level filtering and categories work
 *  - renderer entries are merged into the same file (process tag)
 *  - readRecent() returns the written tail
 *  - secrets are redacted and binary payloads are summarized, never dumped
 *  - the retention prune removes only expired daily files
 *
 * Run with: node tests/file-logger.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FileLogger, summarizeForLog, localDateStamp, LEVELS } = require('../electron/logger.cjs');

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'airdox-logger-test-'));
let checkCount = 0;
function check(name, cond) {
  assert.ok(cond, name);
  checkCount += 1;
  console.log(`  ✓ ${name}`);
}

try {
  // --- 1. Configure & write -------------------------------------------------
  const dir = path.join(tmpRoot, 'logs-a');
  const logger = new FileLogger();
  logger.configure({ logDirectory: dir, processName: 'test', level: 'INFO' });

  logger.debug('SYSTEM', 'darf nicht geschrieben werden (DEBUG < INFO)');
  logger.info('SYSTEM', 'Erster Test-Eintrag');
  logger.warn('DATABASE', 'Ein Warn-Hinweis', { count: 3 });
  logger.error('STEMS', 'Ein Fehler', new Error('boom'));
  await logger.flush();

  const filePath = logger.getCurrentFilePath();
  const text = await readFile(filePath, 'utf8');

  check('Logdatei wurde erstellt', filePath.includes('airdox-editor-'));
  check('Session-Header mit SESSION START vorhanden', text.includes(`SESSION ${logger.sessionId} START`));
  check('System-Informationen (PID) im Header', text.includes(`PID ${process.pid}`));
  check('INFO-Eintrag geschrieben', text.includes('Erster Test-Eintrag'));
  check('WARN mit Kategorie geschrieben', text.includes('[test/DATABASE]') && text.includes('Ein Warn-Hinweis'));
  check('ERROR mit Stack geschrieben', text.includes('[test/STEMS]') && text.includes('Ein Fehler') && text.includes('boom'));
  check('DEBUG-Eintrag wird bei Level INFO gefiltert', !text.includes('darf nicht geschrieben werden'));
  check('Details werden als JSON gespiegelt', text.includes('"count":3'));

  // --- 2. Renderer ingestion ------------------------------------------------
  const ingestResult = logger.ingestRendererEntries([
    {
      timestamp: Date.now(),
      level: 'INFO',
      category: 'UI',
      message: 'Renderer meldet sich',
      sessionId: 'renderer-unit-test',
    },
    { level: 'ERROR', category: 'AUDIO_ENGINE', message: 'Renderer-Fehler', stack: 'at fake' },
    { level: 'WEIRD' /* unknown level -> INFO */, message: 'ohne Kategorie' },
    { not: 'a valid entry' },
  ]);
  assert.equal(ingestResult.accepted, 3, 'drei gültige Renderer-Einträge akzeptiert');
  await logger.flush();

  const textAfterIngest = await readFile(filePath, 'utf8');
  check('Renderer-Einträge in gemeinsamer Datei', textAfterIngest.includes('[renderer/UI]') && textAfterIngest.includes('Renderer meldet sich'));
  check('Renderer-Quelle ist markiert', textAfterIngest.includes('renderer:renderer-unit-test'));
  check('Renderer-Fehler inkl. Stack', textAfterIngest.includes('Renderer-Fehler') && textAfterIngest.includes('at fake'));

  // --- 3. readRecent ---------------------------------------------------------
  const tail = logger.readRecent(1024 * 1024);
  assert.equal(tail.file, filePath);
  check('readRecent liefert Dateiinhalt zurück', tail.text.includes('Renderer meldet sich'));

  // --- 4. Sanitizing / redaction --------------------------------------------
  const safe = summarizeForLog({
    apiKey: 'supersecret',
    token: 'jwt-value',
    audio: Buffer.from([1, 2, 3, 4]),
    view: new Uint8Array(10),
    nested: { fine: true },
  });
  assert.equal(safe.apiKey, '[redacted]', 'API-Key wird geschwärzt');
  assert.equal(safe.token, '[redacted]', 'Token wird geschwärzt');
  assert.equal(safe.audio.__binary, 'Buffer', 'Buffer wird zusammengefasst');
  assert.equal(safe.audio.byteLength, 4);
  assert.equal(safe.view.__binary, 'Uint8Array');
  assert.equal(safe.view.byteLength, 10);
  assert.equal(safe.nested.fine, true);
  check('Geheimnisse werden geschwärzt und Binärdaten zusammengefasst', true);

  // Zirkuläre Objekte dürfen nicht zum Absturz führen.
  const circular = { self: null };
  circular.self = circular;
  const circularSummary = summarizeForLog(circular);
  check('Zirkuläre Referenzen sind protokollierbar', circularSummary.self === '[Circular]');

  // Error-Objekte landen mit Namen/Message/Stack im Log.
  const errSummary = summarizeForLog(new Error('x'));
  assert.equal(errSummary.message, 'x');
  check('Error-Objekte werden strukturiert erfasst', Boolean(errSummary.stack));

  // --- 5. Console capture without duplication --------------------------------
  const capDir = path.join(tmpRoot, 'logs-cap');
  const capLogger = new FileLogger();
  capLogger.configure({ logDirectory: capDir, level: 'DEBUG' });
  capLogger.installConsoleCapture();
  const before = capLogger.entriesWritten;
  console.warn('externes Drittcode-Warnsignal');
  capLogger.info('SYSTEM', 'Eigener Log-Eintrag des Loggers');
  await capLogger.flush();
  const capText = await readFile(capLogger.getCurrentFilePath(), 'utf8');
  check('externe console.warn wird als CONSOLE-Eintrag erfasst', capText.includes('externes Drittcode-Warnsignal'));
  check('Spiegelung eigener Einträge erzeugt keine Duplikate',
    capText.split('Eigener Log-Eintrag des Loggers').length === 2); // 1 Vorkommen + Split-Ende
  assert.ok(capLogger.entriesWritten - before >= 2, 'beide Ereignisse gezählt, aber keines doppelt gespiegelt');

  // --- 6. Level constants ----------------------------------------------------
  assert.ok(LEVELS.ERROR > LEVELS.WARN && LEVELS.WARN > LEVELS.INFO && LEVELS.INFO > LEVELS.DEBUG);
  check('Log-Level-Hierarchie ist streng geordnet', true);

  // --- 7. Retention ----------------------------------------------------------
  const dir2 = path.join(tmpRoot, 'logs-b');
  const retentionLogger = new FileLogger();
  retentionLogger.configure({ logDirectory: dir2, level: 'DEBUG', retentionDays: 14 });
  const oldName = `airdox-editor-2000-01-01.log`;
  const todayName = `airdox-editor-${localDateStamp()}.log`;
  await writeFile(path.join(dir2, oldName), 'old\n');
  await writeFile(path.join(dir2, todayName), 'today\n');
  // Eine Fremddatei darf niemals angefasst werden.
  await writeFile(path.join(dir2, 'unrelated.txt'), 'keep\n');
  await retentionLogger.pruneOldLogs();
  const remaining = await readdir(dir2);
  assert.ok(!remaining.includes(oldName), 'abgelaufene Tagesdatei wird gelöscht');
  assert.ok(remaining.includes(todayName), 'heutige Tagesdatei bleibt erhalten');
  assert.ok(remaining.includes('unrelated.txt'), 'fremde Dateien bleiben unberührt');
  check('Retention löscht nur alte airdox-Tagesdateien', true);

  // --- 8. flushSync (Crash-Fall) ---------------------------------------------
  const syncLogger = new FileLogger();
  const dir3 = path.join(tmpRoot, 'logs-c');
  syncLogger.configure({ logDirectory: dir3, level: 'INFO' });
  syncLogger.info('SYSTEM', 'Synchroner Flush vor Prozessende');
  syncLogger.flushSync();
  const syncText = await readFile(syncLogger.getCurrentFilePath(), 'utf8');
  check('flushSync schreibt sofort auf die Festplatte', syncText.includes('Synchroner Flush vor Prozessende'));

  // --- 9. Info payload -------------------------------------------------------
  const info = logger.getInfo();
  assert.equal(info.processName, 'test');
  assert.equal(info.sessionId, logger.sessionId);
  assert.ok(info.entriesWritten >= 6);
  check('getInfo() meldet Session, Pfad und Zähler', Boolean(info.currentFile) && info.platform === process.platform);

  console.log(`\nfile logger: ${checkCount} Gruppen mit allen Einzelprüfungen bestanden`);
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
