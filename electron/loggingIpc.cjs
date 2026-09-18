'use strict';
/**
 * Main-process adapter for the existing durable logWriter.
 *
 * This is intentionally only an explicit IPC registration helper: it does not
 * add another writer, queue, rotation policy, or renderer API. The supplied
 * writer remains the single persistent owner of `<userData>/airdox-smart-editor.log`.
 */

const { formatLogLine } = require('./logWriter.cjs');

function appendDesktopLog(getWriter, entry) {
  try {
    const writer = getWriter();
    if (!writer || typeof writer.append !== 'function') return false;
    return writer.append(formatLogLine(entry));
  } catch {
    // Never allow a logging failure to reject a renderer operation.
    return false;
  }
}

function getDesktopLogFilePath(getWriter) {
  try {
    const writer = getWriter();
    return writer && typeof writer.filePath === 'string' ? writer.filePath : null;
  } catch {
    return null;
  }
}

/** Registers only the two contextBridge methods exposed by preload.cjs. */
function registerDesktopLoggingIpc(ipcMain, getWriter) {
  ipcMain.handle('rekordbox:append-log', (_event, entry) => appendDesktopLog(getWriter, entry));
  ipcMain.handle('rekordbox:get-log-file-path', () => getDesktopLogFilePath(getWriter));
}

module.exports = {
  appendDesktopLog,
  getDesktopLogFilePath,
  registerDesktopLoggingIpc,
};
