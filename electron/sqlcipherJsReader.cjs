/**
 * @license
 * Compiler-free Rekordbox database access (pure JavaScript).
 *
 * The native binding `better-sqlite3-multiple-ciphers` is only an optional
 * accelerator: prebuilt binaries stop at Electron ABI 146, so an Electron 44
 * build has to compile the module (Visual Studio + node-gyp) or the database
 * import is unavailable. This module removes that requirement:
 *
 *   1. `sqlcipherCodec.cjs` decrypts the SQLCipher page layout with node:crypto.
 *   2. `sql.js` (SQLite compiled to WebAssembly, no native code) runs the
 *      read-only queries against the in-memory plaintext copy.
 *
 * The source file is opened read-only and never modified; the decrypted copy
 * only exists in memory (it is never written to disk).
 */

const fs = require('node:fs');
const path = require('node:path');
const { decryptDatabase } = require('./sqlcipherCodec.cjs');

// A pathological library (or a mistaken pointer at a disk image) must not take
// the whole app down; 1 GiB is far above any real Rekordbox database.
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;

let sqlJsPromise;

/** Loads sql.js lazily; the wasm file is resolved next to the installed package. */
function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      const initSqlJs = require('sql.js');
      const distDir = path.join(path.dirname(require.resolve('sql.js/package.json')), 'dist');
      return initSqlJs({ locateFile: (file) => path.join(distDir, file) });
    })().catch((error) => {
      sqlJsPromise = undefined;
      throw error;
    });
  }
  return sqlJsPromise;
}

async function isAvailable() {
  try {
    await loadSqlJs();
    return true;
  } catch {
    return false;
  }
}

function unavailableError() {
  return new Error(
    'Das reine JavaScript-Leseverfahren ist nicht verfügbar. Bitte das npm-Paket "sql.js" installieren ' +
      '(npm install sql.js) – oder das optionale Modul better-sqlite3-multiple-ciphers bauen.'
  );
}

/**
 * Reads a Rekordbox SQLCipher file and returns plain SQLite bytes plus the
 * accepted cipher profile. Plain (unencrypted) SQLite files pass through.
 */
async function decryptFileToPlainSqlite(filePath, passphrase) {
  const details = fs.statSync(filePath);
  if (!details.isFile()) throw new Error('Die Datenbankdatei ist keine reguläre Datei.');
  if (details.size > MAX_DATABASE_BYTES) {
    throw new Error(
      `Die Datenbankdatei ist größer als ${Math.round(MAX_DATABASE_BYTES / (1024 * 1024))} MB und wird nicht im Arbeitsspeicher entschlüsselt. ` +
        'Bitte das optionale Modul better-sqlite3-multiple-ciphers verwenden.'
    );
  }

  // 'r' + no write handle anywhere: the Rekordbox source stays untouched.
  const handle = fs.openSync(filePath, 'r');
  let encrypted;
  try {
    encrypted = Buffer.allocUnsafe(details.size);
    let read = 0;
    while (read < details.size) {
      const chunk = fs.readSync(handle, encrypted, read, details.size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
  } finally {
    fs.closeSync(handle);
  }

  const result = decryptDatabase(encrypted, passphrase);
  // Release the encrypted copy before the engine allocates its own.
  encrypted = null;
  if (!result.ok) {
    const detailsText = result.tried && result.tried.length ? ` Versuche: ${result.tried.join('; ')}` : '';
    const error = new Error(`${result.reason}${detailsText}`);
    error.cipherAttempts = result.tried;
    throw error;
  }
  return result;
}

/** Opens plain SQLite bytes with the WebAssembly engine (read-only usage). */
async function openPlainDatabase(bytes) {
  const SQL = await loadSqlJs().catch(() => {
    throw unavailableError();
  });
  try {
    return { db: new SQL.Database(bytes), driver: 'sql.js (SQLite/WASM)' };
  } catch (error) {
    throw new Error(`Die entschlüsselte Datenbank konnte nicht geöffnet werden: ${error.message || error}`);
  }
}

module.exports = {
  MAX_DATABASE_BYTES,
  isAvailable,
  loadSqlJs,
  decryptFileToPlainSqlite,
  openPlainDatabase,
  unavailableError,
};
