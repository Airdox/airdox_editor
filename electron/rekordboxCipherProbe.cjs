/**
 * @license
 * Isolierte SQLCipher-Funktionsprobe für den Rekordbox-Runtime-Preflight.
 *
 * Warum es dieses Modul gibt: `better-sqlite3-multiple-ciphers` verweigert
 * `PRAGMA key` auf ":memory:"-Datenbanken ("Setting key not supported for
 * in-memory or temporary databases"). Der echte Verschlüsselungsweg lässt sich
 * also nur mit einer echten Datei beweisen. Diese Datei entsteht aber
 * AUSSCHLIESSLICH in einem frischen Unterverzeichnis des OS-Temp-Verzeichnisses
 * (`mkdtemp`) und wird am Ende des Laufs vollständig wieder entfernt.
 *
 * Dieses Modul ist der einzige Ort auf dem Track-Lade-Pfad mit Datei-Erzeugung.
 * Der Hardening-Test (`tests/rekordbox-gate-hardening.test.mjs`) erzwingt das
 * Vertragsbild: nur tmpdir, keine Nutzer-/Rekordbox-Pfade, vollständige
 * Aufräumung. Rekordbox-Quelldateien werden niemals angesprochen.
 *
 * Die Probe öffnet die Scratch-DB zweimal: einmal zum Schreiben (mit dem
 * Probe-Schlüssel), einmal read-only zum Entschlüsseln und Gegenlesen. Damit
 * sind "Schlüssel setzbar" und "Daten wieder lesbar" für dieselben Bytes
 * bewiesen – dieselbe Reihenfolge, mit der `electron/dbReader.cjs` echte
 * master.db/exportLibrary.db-Dateien öffnet.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROBE_KEY = 'airdox-runtime-preflight';
const PROBE_MARKER = 'rekordbox';

/**
 * In-memory-less functional proof of the SQLCipher binding. Creates and
 * removes exactly one scratch directory below the OS temp directory.
 *
 * @param {Function} Database Konstruktor von better-sqlite3-multiple-ciphers
 * @returns {{ok: boolean, cipherVersion: string|null, detail?: string}}
 */
function probeCipherFunctionality(Database) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-cipher-probe-'));
  const file = path.join(dir, 'probe.db');
  try {
    // 1. Schreiben: Schlüssel setzen, verschlüsselt persistieren.
    const writeDb = new Database(file);
    try {
      writeDb.pragma('cipher = sqlcipher');
      writeDb.pragma('legacy = 4');
      writeDb.pragma(`key = '${PROBE_KEY}'`);
      writeDb.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT);');
      writeDb.prepare('INSERT INTO probe (value) VALUES (?)').run(PROBE_MARKER);
    } finally {
      writeDb.close();
    }

    // 2. Lesen: erneut öffnen (read-only), entschlüsseln, gegenlesen.
    let cipherVersion = null;
    const readDb = new Database(file, { readonly: true, fileMustExist: true });
    try {
      readDb.pragma('cipher = sqlcipher');
      readDb.pragma('legacy = 4');
      readDb.pragma(`key = '${PROBE_KEY}'`);
      const row = readDb.prepare('SELECT count(*) AS n FROM probe').get();
      const stored = readDb.prepare('SELECT value FROM probe LIMIT 1').get();
      try {
        const result = readDb.pragma('cipher_version', { simple: true });
        cipherVersion = typeof result === 'object' && result ? result.cipher_version : result;
      } catch {
        // ältere SQLCipher-Builds kennen cipher_version nicht
      }
      const ok = Number(row && row.n) === 1 && String(stored && stored.value) === PROBE_MARKER;
      return {
        ok,
        cipherVersion: cipherVersion ? String(cipherVersion) : null,
        detail: ok ? undefined : 'Werte der verschlüsselten Scratch-DB stimmen nicht überein.',
      };
    } finally {
      try {
        readDb.close();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    return { ok: false, cipherVersion: null, detail: error && error.message ? error.message : String(error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { probeCipherFunctionality, PROBE_KEY, PROBE_MARKER };
