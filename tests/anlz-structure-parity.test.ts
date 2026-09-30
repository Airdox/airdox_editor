/**
 * @license
 * ANLZ-Struktur-Parität: Renderer-Parser ↔ Electron-Gate.
 *
 * `src/rekordbox/anlzStructure.ts` ist die einzige Quelle der ANLZ-Spezifikation.
 * Der Renderer (`src/rekordbox/anlzParser.ts`) importiert sie als TypeScript,
 * der Electron-Hauptprozess (`electron/masterDbGate.cjs`) über das generierte
 * Spiegelmodul `electron/generated/anlzStructure.cjs`.
 *
 * Dieser Test beweist, dass beide Module über identische Fixtures identische
 * Ergebnisse liefern – Sektionstags, PPTH-Pfad, gewählter Waveform-Abschnitt,
 * dekodierte Spalten und der Byte-für-Byte gleiche Zahleninhalt. Damit ist die
 * Aussage "der Gate akzeptiert genau die Waveform, die der Editor anzeigt"
 * keine Behauptung, sondern eine überprüfbare Eigenschaft.
 *
 * Zusätzlich wird der Build-Zustand des Spiegelmoduls geprüft
 * (`npm run build:anlz-structure:check` darf nichts zu tun brauchen).
 *
 * Run with: npx tsx tests/anlz-structure-parity.test.ts
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ANLZ_EXTENSIONS,
  WAVEFORM_TAGS,
  decodeAnlzWaveform,
  decodeAnlzWaveformColumns,
  readAnlzWaveformSpec,
  scanAnlzSections,
} from '../src/rekordbox/anlzStructure';
import { parseAnlzBinary } from '../src/rekordbox/anlzParser';
import { DataOrigin } from '../src/types/rekordbox';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const generated = require('../electron/generated/anlzStructure.cjs');

// ─── Fixtures im echten Sektions-Envelope ─────────────────────────────────
function section(tag: string, body = Buffer.alloc(0), headerValue = 0x18): Buffer {
  const total = 12 + body.length;
  const buffer = Buffer.alloc(total);
  buffer.write(tag, 0, 'ascii');
  buffer.writeUInt32BE(headerValue, 4);
  buffer.writeUInt32BE(total, 8);
  body.copy(buffer, 12);
  return buffer;
}

function pmaiHeader(headerLen = 32): Buffer {
  const buffer = Buffer.alloc(headerLen);
  buffer.write('PMAI', 0, 'ascii');
  buffer.writeUInt32BE(headerLen, 4);
  buffer.writeUInt32BE(0, 8);
  return buffer;
}

function ppthSection(pathValue: string): Buffer {
  const encoded = Buffer.from(
    [...pathValue].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]).concat([0, 0])
  );
  const body = Buffer.alloc(4 + encoded.length);
  body.writeUInt32BE(encoded.length, 0);
  encoded.copy(body, 4);
  return section('PPTH', body, 0x10);
}

/** PWV5: u4 entry_bytes @+0x0c, u4 entries @+0x10, u4 unknown, data @+0x18. */
function pwv5Section(entryBytes: 2 | 3, entryCount: number, fill = 0xa5): Buffer {
  const body = Buffer.alloc(0x18 + entryBytes * entryCount, fill);
  body.writeUInt32BE(entryBytes, 0x0c);
  body.writeUInt32BE(entryCount, 0x10);
  body.writeUInt32BE(0, 0x14);
  return section('PWV5', body, 0x18);
}

function pwv3Section(entryCount: number): Buffer {
  const body = Buffer.alloc(0x18 + entryCount, 0x3f);
  body.writeUInt32BE(1, 0x0c);
  body.writeUInt32BE(entryCount, 0x10);
  body.writeUInt32BE(0, 0x14);
  return section('PWV3', body, 0x18);
}

/** PQTZ: len_header 0x18, u4 ?, u4 ?, u4 len_beats, 8-byte entries. */
function pqtzSection(beatCount: number): Buffer {
  const body = Buffer.alloc(0x18 + beatCount * 8, 0x00);
  body.writeUInt32BE(0, 0x0c);
  body.writeUInt32BE(0, 0x10);
  body.writeUInt32BE(beatCount, 0x14);
  for (let i = 0; i < beatCount; i++) {
    const entry = 0x18 + i * 8;
    body.writeUInt16BE((i % 4) + 1, entry); // beat in bar
    body.writeUInt16BE(12800, entry + 2); // tempo * 100 = 128.00
    body.writeUInt32BE(i * 625, entry + 4); // time in ms
  }
  return section('PQTZ', body, 0x18);
}

const PAV = 'C:\\Users\\dj\\Music\\Andreas Henneberg\\Skirmish (Original Mix).mp3';

const FIXTURES: Array<{ name: string; bytes: Buffer }> = [
  { name: 'full DAT (PPTH+PQTZ+PWV5)', bytes: Buffer.concat([pmaiHeader(), ppthSection(PAV), pqtzSection(64), pwv5Section(2, 180)]) },
  { name: 'ohne PMAI-Header', bytes: Buffer.concat([ppthSection(PAV), pwv3Section(96)]) },
  { name: 'mehrere Waveform-Abschnitte (PWV3 + PWV5 → PWV5 gewinnt)', bytes: Buffer.concat([pmaiHeader(), pwv3Section(40), pwv5Section(2, 70)]) },
  { name: 'nur Beatgrid, keine Waveform', bytes: Buffer.concat([pmaiHeader(), ppthSection(PAV), pqtzSection(32)]) },
  { name: 'Waveform-Sektion ohne lesbares Layout', bytes: Buffer.concat([pmaiHeader(), section('PWV5', Buffer.alloc(48, 0x80), 0x18)]) },
  { name: 'abgeschnittene Datei', bytes: Buffer.concat([pmaiHeader(), ppthSection(PAV)]).subarray(0, 40) },
  { name: 'Nullbytes', bytes: Buffer.alloc(64) },
  { name: 'zu klein', bytes: Buffer.alloc(8) },
  { name: 'Legacy-Envelope (Länge nur in len_header)', bytes: Buffer.concat([(() => { const body = Buffer.alloc(24, 0x02); const b = Buffer.alloc(12 + body.length); b.write('PQTZ', 0, 'ascii'); b.writeUInt32BE(12 + body.length, 4); b.writeUInt32BE(0, 8); body.copy(b, 12); return b; })(), pwv5Section(2, 30)]) },
];

// ─── 1. Beide Module liefern dieselben Ergebnisse ────────────────────────
function arrayBufferOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

for (const fixture of FIXTURES) {
  const tsScan = scanAnlzSections(fixture.bytes);
  const cjsScan = generated.scanAnlzSections(fixture.bytes);
  assert.deepEqual(cjsScan.tags, tsScan.tags, `${fixture.name}: Sektionstags identisch`);
  assert.equal(cjsScan.valid, tsScan.valid, `${fixture.name}: valid identisch`);
  assert.equal(cjsScan.hasWaveform, tsScan.hasWaveform, `${fixture.name}: hasWaveform identisch`);
  assert.equal(cjsScan.ppthPath, tsScan.ppthPath, `${fixture.name}: PPTH identisch`);
  assert.equal(cjsScan.byteLength, tsScan.byteLength, `${fixture.name}: byteLength identisch`);
  assert.deepEqual(cjsScan.reason, tsScan.reason, `${fixture.name}: Fehlergrund identisch`);
  assert.deepEqual(cjsScan.sections, tsScan.sections, `${fixture.name}: Sektionsoffset identisch`);
  assert.deepEqual(cjsScan.waveform, tsScan.waveform, `${fixture.name}: Waveform-Auswahl identisch`);

  const tsWave = decodeAnlzWaveform(fixture.bytes);
  const cjsWave = generated.decodeAnlzWaveform(fixture.bytes);
  assert.deepEqual(cjsWave.summary, tsWave.summary, `${fixture.name}: Waveform-Kennzahlen identisch`);
  if (tsWave.columns && cjsWave.columns) {
    assert.deepEqual(
      Array.from(cjsWave.columns.peaks),
      Array.from(tsWave.columns.peaks),
      `${fixture.name}: dekodierte Peaks identisch`
    );
    assert.deepEqual(
      Array.from(cjsWave.columns.lowEnergy),
      Array.from(tsWave.columns.lowEnergy),
      `${fixture.name}: Low-Energy identisch`
    );
    assert.deepEqual(
      Array.from(cjsWave.columns.highEnergy),
      Array.from(tsWave.columns.highEnergy),
      `${fixture.name}: High-Energy identisch`
    );
  }
}

// ─── 2. Der Renderer-Parser benutzt genau diese Waveform ────────────────
for (const fixture of FIXTURES) {
  const scan = scanAnlzSections(fixture.bytes);
  const parsed = parseAnlzBinary(arrayBufferOf(fixture.bytes));
  if (!scan.waveform) {
    assert.equal(parsed.waveform, undefined, `${fixture.name}: keine Waveform erwartet`);
    continue;
  }
  assert.ok(parsed.waveform, `${fixture.name}: Parser muss die Waveform dekodieren`);
  assert.equal(parsed.waveform!.origin, DataOrigin.REKORDBOX_ANLZ, `${fixture.name}: Herkunft REKORDBOX_ANLZ`);
  assert.equal(parsed.waveformTag, scan.waveform.tag, `${fixture.name}: gleicher Waveform-Abschnitt`);
  assert.equal(parsed.waveform!.length, scan.waveform.entryCount, `${fixture.name}: gleiche Bucket-Anzahl`);
  assert.ok((parsed.waveformPeakMax ?? 0) > 0, `${fixture.name}: dekodierte Waveform trägt Amplituden`);
}

// PPTH wird vom Walk gelesen – der Parser darf nichts Zweites daraus machen.
{
  const bytes = Buffer.concat([pmaiHeader(), ppthSection(PAV), pwv5Section(2, 20)]);
  const parsed = parseAnlzBinary(arrayBufferOf(bytes));
  assert.equal(parsed.analysisPath, PAV, 'Parser übernimmt den PPTH-Pfad des gemeinsamen Walks');
  assert.equal(scanAnlzSections(bytes).ppthPath, PAV, 'Walk liest denselben PPTH-Pfad');
}

// ─── 3. Konstanten sind identisch ───────────────────────────────────────
assert.deepEqual([...generated.WAVEFORM_TAGS], [...WAVEFORM_TAGS], 'Waveform-Tags identisch');
assert.deepEqual([...generated.ANLZ_EXTENSIONS], [...ANLZ_EXTENSIONS], 'ANLZ-Endungen identisch');
assert.equal(typeof generated.readAnlzWaveformSpec, 'function', 'readAnlzWaveformSpec ist gespiegelt');
assert.equal(
  generated.readAnlzWaveformSpec.length,
  readAnlzWaveformSpec.length,
  'readAnlzWaveformSpec hat dieselbe Signatur'
);

// ─── 4. Das Spiegelmodul ist aktuell und rein lesend ────────────────────
const generatedSource = await readFile(`${root}electron/generated/anlzStructure.cjs`, 'utf8');
assert.ok(
  generatedSource.includes('GENERATED FILE'),
  'electron/generated/anlzStructure.cjs ist als generiertes Modul gekennzeichnet'
);
assert.ok(
  !/\bwriteFileSync\b|\bappendFileSync\b|\bunlinkSync\b|\brmSync\b|\btruncateSync\b|\bfs\.write/.test(generatedSource),
  'das generierte ANLZ-Modul enthält keine Schreib-API'
);
const sharedSource = await readFile(`${root}src/rekordbox/anlzStructure.ts`, 'utf8');
const sharedCode = sharedSource
  .split('\n')
  .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
  .join('\n');
assert.ok(
  !/\bwriteFileSync\b|\bappendFileSync\b|\bunlinkSync\b|\brmSync\b|\btruncateSync\b/.test(sharedSource),
  'die gemeinsame ANLZ-Quelle enthält keine Schreib-API'
);
assert.ok(
  !/\banalyzeAudioBuffer\b|\bFFT\s*\(|\bbeatDetect\w*\s*\(|\bgetByteFrequencyData\b/.test(sharedCode),
  'die gemeinsame ANLZ-Quelle analysiert kein Audio (kein FFT, keine Beat-Erkennung)'
);

// ─── 5. Nur eine einzige ANLZ-Spezifikation im Renderer ─────────────────
const parserSource = await readFile(`${root}src/rekordbox/anlzParser.ts`, 'utf8');
assert.ok(
  !/function readWaveformSpec|const WAVEFORM_PRIORITY\s*:\s*Record/.test(parserSource),
  'anlzParser.ts enthält keine zweite Waveform-Spezifikation mehr'
);
const createWaveformBody = /function createWaveform\([\s\S]*?\n\}/.exec(parserSource)?.[0] || '';
assert.ok(
  createWaveformBody.includes('decodeAnlzWaveformColumns'),
  'createWaveform ist nur noch ein Hüllenwrapper um den gemeinsamen Decoder'
);
assert.ok(
  !/getUint8?\(|getUint16\(/.test(createWaveformBody),
  'der Waveform-Decoder liest keine Bytes mehr selbst aus' 
);
assert.ok(
  parserSource.includes("from './anlzStructure'"),
  'anlzParser.ts importiert die gemeinsame ANLZ-Struktur'
);
const gateSource = await readFile(`${root}electron/masterDbGate.cjs`, 'utf8');
assert.ok(
  gateSource.includes("require('./generated/anlzStructure.cjs')"),
  'masterDbGate.cjs nutzt das generierte Spiegelmodul'
);
assert.ok(
  !/function scanAnlzSections/.test(gateSource),
  'masterDbGate.cjs enthält keinen eigenen ANLZ-Walk'
);

console.log(
  `anlz-structure-parity: ${FIXTURES.length} Fixtures, Renderer-Parser und Electron-Gate nutzen dieselbe ANLZ-Spezifikation (${WAVEFORM_TAGS.join('/')})`
);
