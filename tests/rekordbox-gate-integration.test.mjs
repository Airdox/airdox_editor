/**
 * @license
 * Master-DB-Gate Integrationstest: XML → TrackID → Gate → ANLZ → Original.
 *
 * Anders als tests/master-db-gate.test.mjs wird hier **nichts am Gate
 * injiziert**: Es werden echte Dateien auf der Platte angelegt (ANLZ,
 * Original-Audio, bei Verfügbarkeit eine echte SQLCipher-master.db) und die
 * unveränderte Kette
 *
 *     djmdContent.ID → AnalysisDataPath → ANLZ → PPTH → Original-Audio
 *
 * über `electron/dbReader.cjs` und `electron/masterDbGate.cjs` ausgeführt.
 * Zusätzlich wird derselbe ANLZ-Byte-Buffer durch den echten Renderer-Parser
 * (`src/rekordbox/anlzParser.ts`) geschickt, damit der Bucket-Nachweis des
 * Gates mit dem angezeigten Waveform-Array übereinstimmt.
 *
 * Ist `better-sqlite3-multiple-ciphers` für die laufende Laufzeit verfügbar,
 * wird eine **echte, verschlüsselte** master.db mit dem Rekordbox-Schlüssel
 * erzeugt und der Gate ohne jede Injektion darauf losgelassen. Fehlt das
 * native Modul, wird genau das gemeldet (SKIP) – der Rest des Tests läuft mit
 * einer neutralen Datenbankquelle weiter und die Aussage bleibt klar.
 *
 * Am Ende wird byteweise geprüft, dass master.db, ANLZ und Original-Audio
 * unverändert sind.
 *
 * Run with: node tests/rekordbox-gate-integration.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const dbReader = require('../electron/dbReader.cjs');
const gate = require('../electron/masterDbGate.cjs');
const shared = require('../electron/generated/anlzStructure.cjs');

const TRACK_ID = '142225026';
const workDir = mkdtempSync(path.join(os.tmpdir(), 'airdox-gate-integration-'));
const musicDir = path.join(workDir, 'Andreas Henneberg');
const analysisDir = path.join(workDir, 'Pioneer', 'rekordbox7', 'analysis');
mkdirSync(musicDir, { recursive: true });
mkdirSync(analysisDir, { recursive: true });

const originalPath = path.join(musicDir, 'Skirmish (Original Mix).mp3');
const analysisPath = path.join(analysisDir, 'PQT000000.DAT');
const masterDbPath = path.join(workDir, 'master.db');

const fingerprint = (filePath) => {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
};

// ─── Echte Dateien anlegen ───────────────────────────────────────────────
function section(tag, body = Buffer.alloc(0), headerValue = 0x18) {
  const total = 12 + body.length;
  const buffer = Buffer.alloc(total);
  buffer.write(tag, 0, 'ascii');
  buffer.writeUInt32BE(headerValue, 4);
  buffer.writeUInt32BE(total, 8);
  body.copy(buffer, 12);
  return buffer;
}

function pmaiHeader(headerLen = 32) {
  const buffer = Buffer.alloc(headerLen);
  buffer.write('PMAI', 0, 'ascii');
  buffer.writeUInt32BE(headerLen, 4);
  buffer.writeUInt32BE(0, 8);
  return buffer;
}

function ppthSection(pathValue) {
  const encoded = Buffer.from(
    [...pathValue].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]).concat([0, 0])
  );
  const body = Buffer.alloc(4 + encoded.length);
  body.writeUInt32BE(encoded.length, 0);
  encoded.copy(body, 4);
  return section('PPTH', body, 0x10);
}

/**
 * Body-Felder werden immer über ihren Sektions-Offset adressiert: der Body
 * beginnt bei Sektionsoffset +12, das heißt body[X - 12] == Sektionsoffset X.
 */
const at = (sectionOffset) => sectionOffset - 12;

function pqtzSection(beatCount) {
  const body = Buffer.alloc(0x18 + beatCount * 8, 0x00);
  body.writeUInt32BE(beatCount, at(0x14));
  for (let i = 0; i < beatCount; i++) {
    const entry = at(0x18 + i * 8);
    body.writeUInt16BE((i % 4) + 1, entry);
    body.writeUInt16BE(12800, entry + 2);
    body.writeUInt32BE(i * 469, entry + 4);
  }
  return section('PQTZ', body, 0x18);
}

function pcobSection(entries) {
  const body = Buffer.alloc(0x18 + entries.length * 0x38, 0x00);
  body.writeUInt32BE(0, at(0x0c)); // nicht die Hot-Cue-Liste
  body.writeUInt16BE(entries.length, at(0x12));
  entries.forEach((timeMs, index) => {
    const entry = at(0x18 + index * 0x38);
    body.write('PCPT', entry, 'ascii');
    body.writeUInt32BE(0x38, entry + 0x08);
    body.writeUInt32BE(index + 1, entry + 0x0c);
    body.writeUInt8(1, entry + 0x1c);
    body.writeUInt32BE(timeMs, entry + 0x20);
  });
  return section('PCOB', body, 0x18);
}

const WAVEFORM_BUCKETS = 480;
function pwv5Section() {
  const body = Buffer.alloc(0x18 + WAVEFORM_BUCKETS * 2, 0x00);
  body.writeUInt32BE(2, at(0x0c)); // len_entry_bytes
  body.writeUInt32BE(WAVEFORM_BUCKETS, at(0x10)); // len_entries
  body.writeUInt32BE(0, at(0x14)); // unknown
  for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
    const level = Math.min(0x1f, 4 + Math.round(20 * Math.abs(Math.sin(i / 18))));
    body.writeUInt16BE((level << 2) | (3 << 7) | (5 << 10) | (6 << 13), at(0x18) + i * 2);
  }
  return section('PWV5', body, 0x18);
}

// Ein "Original-Audio": eine winzige, aber echte RIFF/WAVE-Datei.
function minimalWav(sampleCount = 441) {
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i++) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 12) * 12000), 44 + i * 2);
  }
  return buffer;
}

const anlzBytes = Buffer.concat([
  pmaiHeader(),
  ppthSection(originalPath),
  pqtzSection(96),
  pcobSection([15000, 48000, 96000]),
  pwv5Section(),
]);
writeFileSync(analysisPath, anlzBytes);
writeFileSync(originalPath, minimalWav());

// ─── Echte SQLCipher-master.db, falls das native Modul verfügbar ist ────
let realDatabase = false;
let Database = null;
try {
  Database = require('better-sqlite3-multiple-ciphers');
  realDatabase = true;
} catch {
  realDatabase = false;
}

const DJMD_CUE_ROWS = [
  { ID: '900001', ContentID: TRACK_ID, InMsec: 15000, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 1, Color: 0, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'INTRO', BeatLoopSize: 0 },
  { ID: '900002', ContentID: TRACK_ID, InMsec: 48000, InFrame: 0, OutMsec: 61000, OutFrame: 0, Kind: 2, Color: 0, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'LOOP A', BeatLoopSize: 4 },
  { ID: '900003', ContentID: '999999999', InMsec: 1000, InFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 1, Color: 0, ColorTableIndex: 0, ActiveLoop: 0, Comment: 'anderer Track', BeatLoopSize: 0 },
];

if (realDatabase) {
  const key = dbReader.getMasterDbKey();
  const db = new Database(masterDbPath);
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${key}'`);
  db.exec(`
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT,
      ArtistID INTEGER, AlbumID INTEGER, GenreID INTEGER, BPM REAL, Length REAL,
      TrackNo INTEGER, BitRate INTEGER, BitDepth INTEGER, Commnt TEXT, FileType TEXT,
      Rating INTEGER, ReleaseYear TEXT, RemixerID INTEGER, LabelID INTEGER, KeyID INTEGER,
      StockDate TEXT, ColorID INTEGER, DJPlayCount INTEGER, AnalysisDataPath TEXT,
      FileSize INTEGER, SampleRate REAL, DateCreated TEXT, ReleaseDate TEXT, ISRC TEXT,
      Subtitle TEXT, ComposerID INTEGER
    );
    CREATE TABLE djmdCue (
      ID TEXT PRIMARY KEY, ContentID TEXT, InMsec INTEGER, InFrame INTEGER,
      OutMsec INTEGER, OutFrame INTEGER, Kind INTEGER, Color INTEGER,
      ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER
    );
  `);
  const insertContent = db.prepare(
    `INSERT INTO djmdContent (ID, FolderPath, FileNameL, Title, BPM, Length, AnalysisDataPath)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertContent.run(
    TRACK_ID,
    musicDir,
    'Skirmish (Original Mix).mp3',
    'Andreas Henneberg - Skirmish (Original Mix)',
    128,
    0.01,
    analysisPath
  );
  const insertCue = db.prepare(
    `INSERT INTO djmdCue (ID, ContentID, InMsec, InFrame, OutMsec, OutFrame, Kind, Color,
      ColorTableIndex, ActiveLoop, Comment, BeatLoopSize) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of DJMD_CUE_ROWS) {
    insertCue.run(row.ID, row.ContentID, row.InMsec, row.InFrame, row.OutMsec, row.OutFrame, row.Kind, row.Color, row.ColorTableIndex, row.ActiveLoop, row.Comment, row.BeatLoopSize);
  }
  db.close();
}

const before = {
  anlz: fingerprint(analysisPath),
  original: fingerprint(originalPath),
  db: realDatabase ? fingerprint(masterDbPath) : null,
};

// ─── Testlauf ───────────────────────────────────────────────────────────
const results = [];
function step(label, fn) {
  fn();
  results.push(`  [OK] ${label}`);
}

let gateResult = null;
const previousOverride = process.env.AIRODOX_REKORDBOX_DB;
if (realDatabase) process.env.AIRODOX_REKORDBOX_DB = masterDbPath;

try {
  step('ANLZ-Struktur wird vom gemeinsamen Walk erkannt', () => {
    const scan = shared.scanAnlzSections(readFileSync(analysisPath));
    assert.equal(scan.valid, true, 'ANLZ ist strukturell gültig');
    assert.deepEqual(scan.tags, ['PPTH', 'PQTZ', 'PCOB', 'PWV5'], 'Sektionen wie erwartet');
    assert.equal(scan.ppthPath, originalPath, 'PPTH zeigt auf das Original-Audio');
    assert.equal(scan.waveform.tag, 'PWV5', 'PWV5 ist die maßgebliche Waveform');
    assert.equal(scan.waveform.entryCount, WAVEFORM_BUCKETS, 'Bucket-Anzahl');
  });

  if (realDatabase) {
    step('echte verschlüsselte master.db wird read-only gefunden', () => {
      const located = dbReader.locateRekordboxDatabases();
      const hit = located.find((entry) => entry.kind === 'MASTER_DB');
      assert.ok(hit, 'master.db wurde über AIRODOX_REKORDBOX_DB gefunden');
      assert.equal(path.resolve(hit.path), path.resolve(masterDbPath));
    });

    step('openContentRow() liest genau die TrackID', () => {
      const row = dbReader.openContentRow(masterDbPath, TRACK_ID);
      assert.equal(row.available, true, `master.db lesbar: ${row.reason || ''}`);
      assert.equal(row.dbType, 'MASTER_DB');
      assert.equal(row.row.ID, TRACK_ID, 'echte djmdContent-Zeile');
      assert.equal(row.row.AnalysisDataPath, analysisPath, 'echter AnalysisDataPath');
      assert.equal(row.cues.length, 2, 'nur die Cues dieses Tracks (ContentID-Filter)');
    });
  } else {
    results.push('  [SKIP] echte SQLCipher-master.db (better-sqlite3-multiple-ciphers nicht ladbar)');
  }

  // Ohne natives SQLCipher-Modul kann es keine echte master.db geben. Dann wird
  // ausschließlich die *Datenbankquelle* ersetzt (nicht die Gate-Logik): der
  // Rest der Kette – Dateisystem, ANLZ-Bytes, PPTH-Abgleich, Originalpfad –
  // läuft unverändert echt.
  const gateDeps = realDatabase
    ? {}
    : {
        locateRekordboxDatabases: async () => [
          { path: '<virtuelle master.db>', kind: 'MASTER_DB', label: 'master.db (Testfixture)' },
        ],
        isCipherAvailable: () => true,
        openContentRow: async () => ({
          available: true,
          dbType: 'MASTER_DB',
          row: {
            ID: TRACK_ID,
            Title: 'Andreas Henneberg - Skirmish (Original Mix)',
            FolderPath: musicDir,
            FileNameL: 'Skirmish (Original Mix).mp3',
            AnalysisDataPath: analysisPath,
          },
          cues: DJMD_CUE_ROWS.filter((cue) => cue.ContentID === TRACK_ID),
        }),
      };

  step(
    realDatabase
      ? 'resolveTrackFromMasterDb() läuft ohne jede Injektion'
      : 'resolveTrackFromMasterDb() läuft mit realem Dateisystem (nur die DB-Quelle ersetzt)',
    () => {}
  );
  gateResult = await gate.resolveTrackFromMasterDb(
    { trackId: TRACK_ID, mediaPath: `file://localhost${originalPath.replace(/\\/g, '/')}` },
    gateDeps
  );

  step('Gate liefert OK über die komplette Kette', () => {
    assert.equal(gateResult.ok, true, `Gate: ${gateResult.code} – ${gateResult.reason || ''}`);
    assert.equal(gateResult.code, 'OK');
    assert.equal(gateResult.content.id, TRACK_ID, 'TrackID aus der eingebetteten XML');
  });

  step('AnalysisDataPath und echte ANLZ wurden gelesen', () => {
    assert.equal(gateResult.analysis.path, analysisPath);
    assert.equal(gateResult.analysis.hasWaveform, true);
    assert.deepEqual(gateResult.analysis.tags, ['PPTH', 'PQTZ', 'PCOB', 'PWV5']);
    assert.equal(gateResult.analysis.waveform.tag, 'PWV5');
    assert.equal(gateResult.analysis.waveform.buckets, WAVEFORM_BUCKETS);
    assert.ok(gateResult.analysis.waveform.peakMax > 0, 'dekodierte Waveform trägt Amplituden');
  });

  step('PPTH und Original-Audio sind dieselbe Datei', () => {
    assert.equal(gateResult.analysis.ppthPath, originalPath);
    assert.equal(gateResult.original.path, originalPath);
    assert.ok(gate.isSameMediaPath(gateResult.original.path, gateResult.analysis.ppthPath));
  });

  step('Renderer-Parser liest exakt die geprüfte Waveform', () => {
    const parsed = parseWithRendererParser(readFileSync(analysisPath));
    assert.equal(parsed.tagsFound.join(','), gateResult.analysis.tags.join(','), 'identische Sektionen');
    assert.equal(parsed.analysisPath, originalPath, 'identischer PPTH-Pfad');
    assert.equal(parsed.waveformTag, 'PWV5', 'identischer Waveform-Abschnitt');
    assert.equal(parsed.waveform.length, gateResult.analysis.waveform.buckets, 'identische Bucket-Anzahl');
    assert.equal(parsed.waveform.origin, 'REKORDBOX_ANLZ', 'Herkunft ist die ANLZ-Datei');
    assert.equal(parsed.waveformPeakMax > 0, true, 'Amplituden vorhanden');
    assert.equal(parsed.bpm > 0, true, 'Beatgrid aus PQTZ (Rekordbox, nicht berechnet)');
    assert.ok(parsed.cues.length > 0, 'Cues aus dem ANLZ-PCOB-Abschnitt');
    assert.ok(
      parsed.cues.every((cue) => cue.origin === 'REKORDBOX_ANLZ'),
      'alle Marker stammen aus Rekordbox'
    );
  });

  step('djmdCue bleibt die letzte Marker-Quelle', () => {
    assert.equal(gateResult.cueSource, 'DJMD_CUE');
    if (realDatabase) {
      assert.equal(gateResult.cues.length, 2, 'djmdCue-Zeilen des Tracks');
      assert.ok(gateResult.cues.every((cue) => String(cue.ContentID) === TRACK_ID));
    }
  });

  step('Geräte-interne XML-Location wird als Kandidat geführt, aber nie als Original gewählt', () => {});
  const deviceResult = await gate.resolveTrackFromMasterDb(
    { trackId: TRACK_ID, mediaPath: 'file://localhost//contents_4136090260/unknownartist/unknownalbum/song.mp3' },
    gateDeps
  );
  step('…und wird verworfen', () => {
    assert.equal(deviceResult.ok, true, `Gerätepfad führt weiter zum echten Original: ${deviceResult.code}`);
    assert.equal(deviceResult.original.path, originalPath, 'Original ist die echte lokale Datei');
    assert.ok(
      deviceResult.rejected.some((entry) => entry.source === 'XML_LOCATION'),
      'der Gerätepfad ist als verworfen dokumentiert'
    );
  });

  step('Originaldateien sind byteweise unverändert', () => {
    assert.deepEqual(fingerprint(analysisPath), before.anlz, 'ANLZ unverändert');
    assert.deepEqual(fingerprint(originalPath), before.original, 'Original-Audio unverändert');
    if (realDatabase) {
      assert.deepEqual(fingerprint(masterDbPath), before.db, 'master.db unverändert');
    }
  });
} finally {
  if (previousOverride === undefined) delete process.env.AIRODOX_REKORDBOX_DB;
  else process.env.AIRODOX_REKORDBOX_DB = previousOverride;
  for (const line of results) console.log(line);
  console.log(
    realDatabase
      ? `rekordbox-gate-integration: OK (echte SQLCipher-master.db → echte ANLZ → echtes Original, ${WAVEFORM_BUCKETS} Waveform-Buckets)`
      : `rekordbox-gate-integration: OK (echte Dateien; SQLCipher-DB übersprungen – natives Modul nicht ladbar)`
  );
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Führt den echten Renderer-Parser (TypeScript) in einem Kindprozess aus, damit
 * der .mjs-Test ohne Build-Schritt den Produktionspfad prüft.
 */
function parseWithRendererParser(bytes) {
  const bridgePath = path.join(workDir, 'parse-anlz.ts');
  writeFileSync(
    bridgePath,
    [
      "import { parseAnlzBinary } from " + JSON.stringify(path.join(root, 'src/rekordbox/anlzParser.ts')) + ";",
      "import { readFileSync } from 'node:fs';",
      'const data = readFileSync(process.argv[2]);',
      'const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);',
      'const parsed = parseAnlzBinary(buffer);',
      'process.stdout.write(JSON.stringify({',
      '  tagsFound: parsed.tagsFound,',
      '  analysisPath: parsed.analysisPath,',
      '  waveformTag: parsed.waveformTag,',
      '  waveformPeakMax: parsed.waveformPeakMax,',
      '  bpm: parsed.bpm,',
      '  cues: parsed.cues,',
      '  waveform: parsed.waveform ? { length: parsed.waveform.length, origin: parsed.waveform.origin } : undefined,',
      '}));',
    ].join('\n')
  );
  const output = execFileSync('npx', ['tsx', bridgePath, analysisPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}
