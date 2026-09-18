/**
 * @license
 * Compatibility entry point for the historical renderer file-log bootstrap.
 *
 * Durability now belongs directly to LoggerService: every entry is mirrored
 * best-effort to the explicit Electron bridge at creation time. Keeping this
 * exported initializer prevents legacy callers from failing while avoiding the
 * former second subscriber (which could write every entry twice).
 */

import { logger } from './logger';

/**
 * @deprecated LoggerService performs its own non-blocking desktop persistence.
 * Existing callers may keep invoking this function; no extra bridge or writer
 * is created and therefore no duplicate log records are produced.
 */
export function initFileLogging(): () => void {
  logger.debug('SYSTEM', 'Legacy-Datei-Logging-Initialisierung bestätigt; LoggerService-Persistenz ist bereits aktiv.');
  return () => {};
}
