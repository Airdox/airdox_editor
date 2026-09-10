/**
 * @license
 * Stufe-4-Test des Pipeline-Stufenplans: ANLZ-Tag-Inventar (read-only).
 *
 * Legt eine reale Verzeichnisstruktur an (master.db + share/PIONEER/USBANLZ),
 * bestückt sie mit den echt-formatigen ANLZ-Fixtures (.DAT: PMAI/PPTH/PQTZ/
 * PCOB/PWV5, .EXT: PCO2/PWV3/PWV7/PSSI) und lässt die Diagnose-CLI
 * `scripts/anlz-probe.mjs` als eigenen Prozess laufen. Geprüft wird:
 *
 *   1. Gate erfüllt: PPTH + PQTZ + PWV* → Exit 0, Bericht PASS.
 *   2. Inventar stimmt: pro Waveform-Tag len_entry_bytes/len_entries/Stil,
 *      Beat-/Cue-/Loop-/Phrasen-Zahlen, PSSI-Parameter (maskiert, Bank).
 *   3. PPTH-Plausibilitätsvergleich mit djmdContent-Pfad = exakter Treffer.
 *   4. Read-Only: alle ANLZ-Dateien und die master.db sind nachher
 *      byte-identisch (SHA-256).
 *   5. Negativ: eine Datei ohne PWV verletzt das Gate → Exit 1.
 *
 * Run with: npx tsx tests/anlz-probe.test.ts
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateRealAnlzDatFixture,
  generateRealAnlzExtFixture,
} from './fixtures/testDatasets';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeScript = path.join(repoRoot, 'scripts', 'anlz-probe.mjs');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const dbReader = require('../electron/dbReader.cjs');

assert.ok(fs.existsSync(tsxCli), 'tsx muss installiert sein (devDependency)');

// ---------------------------------------------------------------------------
// Layout: <tmp>/db/master.db + <tmp>/db/share/PIONEER/USBANLZ/x/ANLZ0001.*
// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-anlz-'));
const dbDir = path.join(workDir, 'db');
const anlzDir = path.join(dbDir, 'share', 'PIONEER', 'USBANLZ', 'x');
fs.mkdirSync(anlzDir, { recursive: true });

const datPath = path.join(anlzDir, 'ANLZ0001.DAT');
const extPath = path.join(anlzDir, 'ANLZ0001.EXT');
fs.writeFileSync(datPath, Buffer.from(generateRealAnlzDatFixture(128)));
fs.writeFileSync(extPath, Buffer.from(generateRealAnlzExtFixture(128)));

const dbPath = path.join(dbDir, 'master.db');
{
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath);
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${dbReader.getMasterDbKey()}'`);
  db.exec(`
    CREATE TABLE djmdContent (ID INTEGER PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, AnalysisDataPath TEXT);
    INSERT INTO djmdContent (ID, FolderPath, FileNameL, Title, AnalysisDataPath)
    VALUES (1, 'C:\\Music\\', 'Reference.wav', 'Reference', '/PIONEER/USBANLZ/x/ANLZ0001.DAT');
  `);
  db.close();
}

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const before = [datPath, extPath, dbPath].map((p) => ({ p, sha: sha256(p), size: fs.statSync(p).size }));

function runProbe(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, probeScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

// ---------------------------------------------------------------------------
// 1) Positivlauf über master.db → Track 1
// ---------------------------------------------------------------------------

const reportPath = path.join(workDir, 'report.json');
const result = runProbe(['--db', dbPath, '--track', '1', '--json', reportPath]);
const out = `${result.stdout || ''}\n${result.stderr || ''}`;

assert.strictEqual(result.status, 0, `Probe muss Exit 0 liefern, war ${result.status}\n${out}`);
assert.match(out, /Gate PPTH\+PQTZ\+PWV\*\s+PASS/, 'Gate muss PASS sein');
assert.match(out, /PPTH-Plausibilität vs\. djmdContent-Pfad: PASS/, 'PPTH muss exakt zum DB-Pfad passen');
assert.match(out, /Fingerabdruck NACHHER\s+PASS/, 'Read-Only-Beweis muss PASS sein');
assert.match(out, /len_entry_bytes 2 · len_entries 600 · Stil RGB_5BIT/, 'PWV5-Inventar (DAT) muss stimmen');
assert.match(out, /PSSI: 4 Phrasen · maskiert=true/, 'PSSI-Inventar (EXT) muss stimmen');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
assert.strictEqual(report.result, 'PASS');
assert.deepStrictEqual(report.gate, { ppth: true, pqtz: true, pwv: true, ppthMatch: true, pass: true });
assert.strictEqual(report.files.length, 2, 'DAT und EXT müssen gelesen werden');

const dat = report.files.find((f: any) => f.kind === 'DAT');
const ext = report.files.find((f: any) => f.kind === 'EXT');
assert.ok(dat && ext, 'beide Container im Bericht');

assert.ok(dat.tagsFound.includes('PPTH') && dat.tagsFound.includes('PQTZ') && dat.tagsFound.includes('PWV5'));
assert.strictEqual(dat.ppth, 'C:\\Music\\Reference.wav');
assert.strictEqual(dat.ppthMatch, true);
assert.strictEqual(dat.beats, 32, 'PQTZ-Beat-Zahl (DAT)');
assert.strictEqual(dat.loops, 1, 'Loop-Zahl (DAT)');
const pwv5 = dat.tagInventory.find((t: any) => t.tag === 'PWV5');
assert.deepStrictEqual(pwv5.waveform, { entryBytes: 2, entryCount: 600, style: 'RGB_5BIT' });

assert.ok(ext.tagsFound.includes('PWV3') && ext.tagsFound.includes('PWV7') && ext.tagsFound.includes('PSSI'));
const pwv3 = ext.tagInventory.find((t: any) => t.tag === 'PWV3');
const pwv7 = ext.tagInventory.find((t: any) => t.tag === 'PWV7');
assert.deepStrictEqual(pwv3.waveform, { entryBytes: 1, entryCount: 900, style: 'MONO_5BIT' });
assert.deepStrictEqual(pwv7.waveform, { entryBytes: 3, entryCount: 900, style: 'TRIPLE_BYTE' });
assert.strictEqual(ext.pssi.masked, true);
assert.strictEqual(ext.pssi.bank, 3);
assert.strictEqual(ext.phrases, 4);
assert.strictEqual(ext.cues > 0, true, 'PCO2-Cues müssen gezählt werden');

// ---------------------------------------------------------------------------
// 2) Direktmodus ohne Datenbank (--anlz) muss ebenfalls das Gate erfüllen
// ---------------------------------------------------------------------------

const direct = runProbe(['--anlz', datPath]);
assert.strictEqual(direct.status, 0, `Direktmodus muss Exit 0 liefern\n${direct.stdout}${direct.stderr}`);
assert.match(direct.stdout || '', /ERGEBNIS: PASS/);

// ---------------------------------------------------------------------------
// 3) Negativ: PPTH-only verletzt das Gate (kein PWV*) → Exit 1
// ---------------------------------------------------------------------------

function ppthOnly(pathStr: string): Buffer {
  const chars = [...pathStr];
  const pathBuf = Buffer.alloc(chars.length * 2);
  chars.forEach((ch, i) => pathBuf.writeUInt16BE(ch.charCodeAt(0), i * 2));
  const lenPath = pathBuf.length;
  const lenTag = 0x10 + lenPath;
  const buf = Buffer.alloc(lenTag);
  buf.write('PPTH', 0, 'ascii');
  buf.writeUInt32BE(0x10, 4);
  buf.writeUInt32BE(lenTag, 8);
  buf.writeUInt32BE(lenPath, 0x0c);
  pathBuf.copy(buf, 0x10);
  return buf;
}

const poorPath = path.join(workDir, 'ANLZ0009.DAT');
fs.writeFileSync(poorPath, ppthOnly('C:\\Music\\Reference.wav'));
const poor = runProbe(['--anlz', poorPath]);
assert.strictEqual(poor.status, 1, 'ohne PWV* muss das Gate FAIL sein (Exit 1)');
assert.match(poor.stdout || '', /Gate PPTH\+PQTZ\+PWV\*\s+FAIL/);
assert.match(poor.stdout || '', /ERGEBNIS: FAIL/);

// ---------------------------------------------------------------------------
// 4) Read-Only-Beweis: alles byte-identisch
// ---------------------------------------------------------------------------

for (const entry of before) {
  assert.strictEqual(sha256(entry.p), entry.sha, `${entry.p} muss unverändert sein`);
  assert.strictEqual(fs.statSync(entry.p).size, entry.size, `${entry.p} Größe unverändert`);
}

fs.rmSync(workDir, { recursive: true, force: true });
console.log('anlz-probe (Stufe 4: ANLZ-Tag-Inventar read-only): OK');
