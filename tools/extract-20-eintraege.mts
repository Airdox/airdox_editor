/**
 * @license
 * Extraktions-Werkzeug: 20 Einzel-Einträge inkl. aller zugehörigen Daten.
 *
 * Quelle  : die Rekordbox-XML-Testdatensätze dieses Repositories
 *           (src/rekordbox/testDatasets.ts → 4 handgeschriebene Szenarien,
 *           ergänzt um 16 generierte, aber realistische Bibliotheks-Einträge).
 * Ziel    : ein Ordner mit den Unterordnern
 *             Testdateien/   → 20 × Einzel-XML + 20 × Voll-JSON + Sammel-XML
 *             Audio/         → 20 × 16-bit-PCM-WAV (Render im Track-BPM)
 *             Datenbanken/   → master.db + exportLibrary.db (SQLCipher)
 *                              + Klartext-SQL-Dumps + ANLZ/ (20 × .DAT + .EXT)
 *
 * Jeder Eintrag läuft durch die echte Import-Pipeline des Projekts:
 *   xmlParser.parseRekordboxXml            → Metadaten, Beatgrid, Cues, Loops
 *   waveform/analyzer.analyzeAudioBuffer   → Waveform aus dem realen PCM-Render
 *   databaseExtractor.parseAnlzBinary      → Rück-Leseprobe der ANLZ-Dateien
 *   dbReader.readRekordboxDatabase         → Entschlüsselung der erzeugten DBs
 *   dbParser.mapRekordboxDatabaseRows      → Mapping der DB-Zeilen
 *
 * Aufruf: npx tsx tools/extract-20-eintraege.mts [zielOrdner]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyAnlzExtractionToTrack,
  extractTrackFromRekordboxXml,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import { mapRekordboxDatabaseRows } from '../src/rekordbox/dbParser';
import { ALL_TEST_SCENARIOS, generatePcmWavArrayBuffer } from '../src/rekordbox/testDatasets';
import { parseRekordboxXml } from '../src/rekordbox/xmlParser';
import { analyzeAudioBuffer } from '../src/waveform/analyzer';
import type { CuePoint, LoopPoint, TrackModel } from '../src/types/rekordbox';
import { DataOrigin } from '../src/types/rekordbox';

const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const ENTRY_COUNT = 20;
const AUDIO_PREVIEW_SECONDS = 15; // Render-Länge je WAV (Metadaten beschreiben den vollen Track)
const SAMPLE_RATE = 44100;
const WAVEFORM_COLUMNS = 900;

const TARGET_DIR =
  process.argv[2] || path.join(os.homedir(), 'Desktop', 'Testdateien Audio Datenbanken');

const DIR_TESTDATEIEN = path.join(TARGET_DIR, 'Testdateien');
const DIR_AUDIO = path.join(TARGET_DIR, 'Audio');
const DIR_DATENBANKEN = path.join(TARGET_DIR, 'Datenbanken');
const DIR_ANLZ = path.join(DIR_DATENBANKEN, 'ANLZ');

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

function sha256(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'Track'
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function floatArrayToRounded(values: Float32Array, decimals = 4): number[] {
  const factor = 10 ** decimals;
  return Array.from(values, (value) => Math.round(value * factor) / factor);
}

/** Deterministischer PRNG, damit das Paket bei erneutem Aufruf identisch bleibt. */
function createRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return {
    next(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0xffffffff;
    },
    int(min: number, max: number): number {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(this.next() * items.length)] as T;
    },
  };
}

// ---------------------------------------------------------------------------
// 1) Quell-XML: 20 TRACK-Einträge (4 Repo-Szenarien + 16 generierte)
// ---------------------------------------------------------------------------

const GENRES: Array<{ genre: string; bpmMin: number; bpmMax: number }> = [
  { genre: 'Techno', bpmMin: 126, bpmMax: 134 },
  { genre: 'Tech House', bpmMin: 122, bpmMax: 127 },
  { genre: 'Melodic House &amp; Techno', bpmMin: 120, bpmMax: 124 },
  { genre: 'Drum &amp; Bass', bpmMin: 170, bpmMax: 176 },
  { genre: 'House', bpmMin: 124, bpmMax: 128 },
  { genre: 'Hard Techno', bpmMin: 140, bpmMax: 148 },
  { genre: 'Trance', bpmMin: 136, bpmMax: 140 },
  { genre: 'Breakbeat', bpmMin: 132, bpmMax: 138 },
];

const TITLE_A = ['Neon', 'Iron', 'Velvet', 'Static', 'Cobalt', 'Solar', 'Hollow', 'Crystal', 'Analog', 'Midnight', 'Rust', 'Glass', 'Phantom', 'Ember', 'Titan', 'Lucid'];
const TITLE_B = ['Circuit', 'Harbour', 'Signal', 'District', 'Machine', 'Mirage', 'Protocol', 'Cascade', 'Voltage', 'Transit', 'Reactor', 'Corridor', 'Frequency', 'Engine', 'Atlas', 'Pulse'];
const TITLE_C = ['(Club Mix)', '(Extended Mix)', '(Original Mix)', '(Peak Time Rework)', '(VIP Edit)', '(Dub Mix)', '(Roller Mix)', '(Late Night Mix)'];
const ARTISTS = ['Klangfeld', 'Mara Voss', 'Subsonic Pulse', 'DJ Frânçois', 'Björk Lindqvist', 'Marcos Delgado', 'Nullpunkt', 'Akiro Tanaka', 'Rosa Belmont', 'Vector Nine', 'Helena Frost', 'Tobiás Krüger', 'Sonar Kollektiv', 'Petra Halvorsen', 'Ivo Marchetti', 'Nadja Weiss'];
const ALBUMS = ['Subterranean Records', 'Ibiza Sessions Vol. 9', 'Neurofunk Archives', 'Warehouse Tapes', 'Nordlicht EP', 'Concrete Poetry', 'Night Bus Series', 'Analog Hearts'];
const LABELS = ['Subterranean', 'Kraftwerk Audio', 'Nordlicht', 'Ibiza Underground', 'Concrete Music', 'Night Bus', 'Analog Heart Records', 'Warehouse Limited'];
const KEYS = ['1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A', '9A', '10A', '11A', '12A', '1B', '4B', '7B', '9B'];
const COMMENT_SNIPPETS = [
  'Peak-Hour Master [Memory Cues verified]',
  'Groove baseline &amp; syncopated claps',
  'Reese-Bass, 16-Bar-Roller, sauberer Mixout',
  'Vocal-Chops im Break, Drop quantisiert',
  'Lange Intro-Passage, ideal zum Layering',
  'Percussion-lastig, wenig Sub im Outro',
];

interface GeneratedEntry {
  id: number;
  title: string;
  artist: string;
  album: string;
  label: string;
  genre: string;
  bpm: number;
  key: string;
  duration: number;
  rating: number;
  playCount: number;
  year: number;
  comments: string;
  firstBeat: number;
  memoryCues: Array<{ name: string; start: number }>;
  hotCues: Array<{ name: string; start: number; num: number; rgb: [number, number, number] }>;
  loops: Array<{ name: string; start: number; end: number }>;
}

function buildGeneratedEntries(count: number): GeneratedEntry[] {
  const random = createRandom(20260906);
  const entries: GeneratedEntry[] = [];
  const hotCueColors: Array<[number, number, number]> = [
    [0, 162, 255],
    [0, 230, 118],
    [255, 145, 0],
    [213, 0, 249],
  ];

  for (let i = 0; i < count; i++) {
    const spec = random.pick(GENRES);
    const bpm = random.int(spec.bpmMin, spec.bpmMax) + random.pick([0, 0.25, 0.5]);
    const spb = 60 / bpm;
    const barCount = random.int(56, 104); // 4/4-Takte
    const duration = Number((barCount * 4 * spb + random.next() * spb).toFixed(3));
    const title = `${random.pick(TITLE_A)} ${random.pick(TITLE_B)} ${random.pick(TITLE_C)}`;

    const barToSec = (bar: number) => Number(((bar - 1) * 4 * spb).toFixed(3));
    const drop1Bar = random.int(17, 25);
    const drop2Bar = drop1Bar + random.int(16, 32);
    const breakdownBar = Math.max(9, drop1Bar - random.int(4, 8));

    entries.push({
      id: 1000 + i * 7 + 1,
      title,
      artist: random.pick(ARTISTS),
      album: random.pick(ALBUMS),
      label: random.pick(LABELS),
      genre: spec.genre,
      bpm: Number(bpm.toFixed(2)),
      key: random.pick(KEYS),
      duration,
      rating: random.pick([0, 102, 153, 204, 255]),
      playCount: random.int(0, 140),
      year: random.int(2019, 2026),
      comments: random.pick(COMMENT_SNIPPETS),
      firstBeat: random.pick([0, Number((spb * 0.25).toFixed(4)), Number((spb * 0.5).toFixed(4))]),
      memoryCues: [
        { name: 'Intro Start', start: barToSec(1) },
        { name: 'Bassline Entrance', start: barToSec(random.int(5, 9)) },
        { name: 'Breakdown', start: barToSec(breakdownBar) },
        { name: 'Buildup Rise', start: barToSec(drop1Bar - 4) },
        { name: 'DROP 1', start: barToSec(drop1Bar) },
        { name: 'Second Breakdown', start: barToSec(drop2Bar - 8) },
        { name: 'DROP 2', start: barToSec(drop2Bar) },
        { name: 'Outro Mixout', start: barToSec(barCount - random.int(4, 8)) },
      ].filter((cue) => cue.start >= 0 && cue.start < duration),
      hotCues: [
        { name: 'Hot Cue A', start: barToSec(1), num: 0, rgb: hotCueColors[0] },
        { name: 'Hot Cue B', start: barToSec(breakdownBar), num: 1, rgb: hotCueColors[1] },
        { name: 'Hot Cue C', start: barToSec(drop1Bar), num: 2, rgb: hotCueColors[2] },
        { name: 'Hot Cue D', start: barToSec(drop2Bar), num: 3, rgb: hotCueColors[3] },
      ].filter((cue) => cue.start < duration),
      loops: [
        {
          name: `Intro ${random.pick([4, 8])}-Bar Loop`,
          start: barToSec(1),
          end: barToSec(1 + random.pick([4, 8])),
        },
        {
          name: `Break ${random.pick([8, 16])}-Bar Loop`,
          start: barToSec(breakdownBar),
          end: barToSec(breakdownBar + random.pick([8, 16])),
        },
      ].filter((loop) => loop.start < duration && loop.end <= duration + 0.001),
    });
  }
  return entries;
}

function generatedTrackToXml(entry: GeneratedEntry, audioFileName: string, audioFolder: string): string {
  const folder = audioFolder.replace(/\\/g, '/').replace(/^\/+/, '');
  const location = `file://localhost/${folder}/${encodeURIComponent(audioFileName)}`;
  const marks = [
    ...entry.memoryCues.map(
      (cue) =>
        `      <POSITION_MARK Name="${escapeXml(cue.name)}" Type="0" Start="${cue.start.toFixed(3)}" Num="-1" Red="255" Green="34" Blue="34" />`
    ),
    ...entry.hotCues.map(
      (cue) =>
        `      <POSITION_MARK Name="${escapeXml(cue.name)}" Type="0" Start="${cue.start.toFixed(3)}" Num="${cue.num}" Red="${cue.rgb[0]}" Green="${cue.rgb[1]}" Blue="${cue.rgb[2]}" />`
    ),
    ...entry.loops.map(
      (loop) =>
        `      <POSITION_MARK Name="${escapeXml(loop.name)}" Type="4" Start="${loop.start.toFixed(3)}" End="${loop.end.toFixed(3)}" Num="-1" Red="255" Green="170" Blue="0" />`
    ),
  ].join('\n');

  return [
    `    <TRACK TrackID="${entry.id}" Name="${escapeXml(entry.title)}" Artist="${escapeXml(entry.artist)}" Album="${escapeXml(entry.album)}"`,
    `           Genre="${entry.genre}" TotalTime="${entry.duration.toFixed(3)}" AverageBpm="${entry.bpm.toFixed(2)}" Tonality="${entry.key}" BitRate="320"`,
    `           Comments="${escapeXml(entry.comments)}" Year="${entry.year}" Rating="${entry.rating}" PlayCount="${entry.playCount}"`,
    `           Label="${escapeXml(entry.label)}" DateAdded="2026-09-06" Location="${location}">`,
    `      <TEMPO Inizio="${entry.firstBeat.toFixed(4)}" Bpm="${entry.bpm.toFixed(2)}" Metro="4/4" Battito="1" />`,
    marks,
    '    </TRACK>',
  ].join('\n');
}

/** Extrahiert den kompletten <TRACK>…</TRACK>-Block aus einem Szenario-XML. */
function extractTrackBlock(scenarioXml: string): string {
  const match = scenarioXml.match(/<TRACK[\s\S]*<\/TRACK>/);
  if (!match) throw new Error('Kein TRACK-Block im Szenario gefunden.');
  return match[0]
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line : `    ${line}`))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 2) ANLZ-Schreiber (dokumentierte Deep-Symmetry-Layouts, wie im Projekt)
// ---------------------------------------------------------------------------

class ByteWriter {
  bytes: number[] = [];
  u8(value: number) { this.bytes.push(value & 0xff); return this; }
  u16(value: number) { this.bytes.push((value >> 8) & 0xff, value & 0xff); return this; }
  u32(value: number) {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    return this;
  }
  ascii(text: string) { for (const ch of text) this.bytes.push(ch.charCodeAt(0)); return this; }
  zeros(count: number) { for (let i = 0; i < count; i++) this.bytes.push(0); return this; }
  utf16Be(text: string) {
    for (const ch of text) this.bytes.push((ch.charCodeAt(0) >> 8) & 0xff, ch.charCodeAt(0) & 0xff);
    this.bytes.push(0, 0);
    return this;
  }
  concat(values: number[]) { this.bytes.push(...values); return this; }
  get body() { return this.bytes; }
}

interface AnlzTag { tag: string; lenHeader: number; body: number[] }

function encodeTag(writer: ByteWriter, tag: string, header: number, body: number[]): void {
  writer.ascii(tag).u32(header).u32(12 + body.length).concat(body);
}

function encodePpth(sourcePath: string): AnlzTag {
  const w = new ByteWriter();
  w.u32(sourcePath.length * 2 + 2).utf16Be(sourcePath);
  return { tag: 'PPTH', lenHeader: 0x10, body: w.body };
}

function encodePqtz(beats: Array<{ beatInBar: number; tempo: number; timeMs: number }>): AnlzTag {
  const w = new ByteWriter();
  w.u32(0).u32(0x80000).u32(beats.length);
  beats.forEach((b) => w.u16(b.beatInBar).u16(b.tempo).u32(b.timeMs));
  return { tag: 'PQTZ', lenHeader: 0x18, body: w.body };
}

function encodePcptEntry(timeMs: number, opts: { hotCue: number; loop?: number; orderFirst?: number; orderLast?: number }): number[] {
  const w = new ByteWriter();
  const isLoop = opts.loop !== undefined;
  w.ascii('PCPT').u32(0x1c).u32(0x38).u32(opts.hotCue).u32(0).u32(0x10000)
    .u16(opts.orderFirst ?? 0xffff).u16(opts.orderLast ?? 0xffff)
    .u8(isLoop ? 2 : 1).u8(0x00).u8(0x03).u8(0xe8)
    .u32(timeMs).u32(isLoop ? (opts.loop as number) : 0).zeros(16);
  return w.body;
}

function encodePcob(type: 0 | 1, entries: number[][]): AnlzTag {
  const w = new ByteWriter();
  w.u32(type).u16(0).u16(entries.length).u32(0);
  entries.forEach((entry) => w.concat(entry));
  return { tag: 'PCOB', lenHeader: 0x18, body: w.body };
}

function encodePcp2Entry(
  timeMs: number,
  opts: { hotCue: number; type?: 1 | 2; loop?: number; comment?: string; colorCode?: number; colorRgb?: [number, number, number] }
): number[] {
  const w = new ByteWriter();
  const comment = opts.comment ?? '';
  const commentBytes = comment.length > 0 ? comment.length * 2 + 2 : 0;
  const hasColor = opts.colorRgb !== undefined || opts.colorCode !== undefined;
  const lenEntry = 0x28 + 4 + commentBytes + (hasColor ? 4 : 0);

  w.ascii('PCP2').u32(0x0a).u32(lenEntry).u32(opts.hotCue)
    .u8(opts.type ?? 1).u8(0x00).u8(0x03).u8(0xe8)
    .u32(timeMs).u32(opts.loop ?? 0)
    .u8(opts.colorCode ?? 0).u8(0x01).zeros(6)
    .u16(0).u16(0).u32(commentBytes);
  if (commentBytes > 0) w.utf16Be(comment);
  if (hasColor) {
    w.u8(opts.colorCode ?? 0);
    const rgb = opts.colorRgb ?? [0, 0, 0];
    w.u8(rgb[0]).u8(rgb[1]).u8(rgb[2]);
  }
  return w.body;
}

function encodePco2(type: 0 | 1, entries: number[][]): AnlzTag {
  const w = new ByteWriter();
  w.u32(type).u16(entries.length).u16(0);
  entries.forEach((entry) => w.concat(entry));
  return { tag: 'PCO2', lenHeader: 0x0e, body: w.body };
}

function encodePwv5Rgb(columns: Array<{ peak: number; low: number; mid: number; high: number }>): AnlzTag {
  const w = new ByteWriter();
  w.u32(2).u32(columns.length).u32(0x00960000);
  const q = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value * max)));
  columns.forEach((c) => {
    const value =
      (q(c.low, 7) << 13) | (q(c.mid, 7) << 10) | (q(c.high, 7) << 7) | (q(c.peak, 31) << 2);
    w.u16(value);
  });
  return { tag: 'PWV5', lenHeader: 0x18, body: w.body };
}

function encodePwv3Mono(columns: number[]): AnlzTag {
  const w = new ByteWriter();
  w.u32(1).u32(columns.length).u32(0x00960000);
  columns.forEach((peak) => w.u8(Math.max(0, Math.min(31, Math.round(peak * 31)))));
  return { tag: 'PWV3', lenHeader: 0x18, body: w.body };
}

function encodePwv7Triple(columns: Array<{ mid: number; high: number; low: number }>): AnlzTag {
  const w = new ByteWriter();
  w.u32(3).u32(columns.length).u32(0x00960000);
  const b = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255)));
  columns.forEach((c) => { w.u8(b(c.mid)); w.u8(b(c.high)); w.u8(b(c.low)); });
  return { tag: 'PWV7', lenHeader: 0x18, body: w.body };
}

function encodePssiPhrase(opts: { index: number; beat: number; kind: number }): number[] {
  const w = new ByteWriter();
  w.u16(opts.index).u16(opts.beat).u16(opts.kind)
    .u8(0).u8(1).u8(0).u8(0).u8(0).u8(0)
    .u16(0).u16(0).u16(0).u8(0).u8(0).u8(0).u8(0).u16(0);
  return w.body;
}

const PSSI_MASK_BASE = [
  0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2,
  0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1,
];

function encodePssi(mood: number, endBeat: number, entries: number[][], bank: number): AnlzTag {
  const body = new ByteWriter();
  body.u32(24).u16(entries.length);
  const payload = new ByteWriter();
  payload.u16(mood).zeros(6).u16(endBeat).zeros(2).u8(bank).zeros(1);
  entries.forEach((e) => payload.concat(e));
  const payloadBytes = payload.body;
  for (let i = 0; i < payloadBytes.length; i++) {
    payloadBytes[i] ^= (PSSI_MASK_BASE[i % PSSI_MASK_BASE.length] + entries.length) & 0xff;
  }
  body.concat(payloadBytes);
  return { tag: 'PSSI', lenHeader: 0x14, body: body.body };
}

function assembleAnlzFile(tags: AnlzTag[]): Buffer {
  const headerLen = 0x1c;
  const sectionsSize = tags.reduce((sum, t) => sum + 12 + t.body.length, 0);
  const writer = new ByteWriter();
  writer.ascii('PMAI').u32(headerLen).u32(headerLen + sectionsSize).u32(1).u32(0x10000).u32(0x10000).u32(0);
  tags.forEach((t) => encodeTag(writer, t.tag, t.lenHeader, t.body));
  return Buffer.from(writer.body);
}

// ---------------------------------------------------------------------------
// 3) Ausführung
// ---------------------------------------------------------------------------

interface EntryArtifacts {
  index: number;
  entryId: string;
  baseName: string;
  title: string;
  artist: string;
  bpm: number;
  duration: number;
  key: string;
  files: Record<string, { path: string; bytes: number; sha256: string }>;
  counts: { memoryCues: number; hotCues: number; loops: number; phrases: number; beatGridBeats: number; waveformBuckets: number };
}

function main() {
  const startedAt = Date.now();
  for (const dir of [TARGET_DIR, DIR_TESTDATEIEN, DIR_AUDIO, DIR_DATENBANKEN, DIR_ANLZ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // -- Quell-XML aufbauen ---------------------------------------------------
  const generated = buildGeneratedEntries(ENTRY_COUNT - ALL_TEST_SCENARIOS.length);
  const audioFileNames: string[] = [];
  const generatedXmlBlocks: string[] = [];

  generated.forEach((entry, i) => {
    const baseName = `${String(ALL_TEST_SCENARIOS.length + i + 1).padStart(2, '0')}_${slugify(entry.artist)}_-_${slugify(entry.title)}`;
    const wavName = `${baseName}.wav`;
    audioFileNames.push(wavName);
    generatedXmlBlocks.push(generatedTrackToXml(entry, wavName, DIR_AUDIO));
  });

  const scenarioBlocks = ALL_TEST_SCENARIOS.map((scenario, i) => ({
    block: extractTrackBlock(scenario.xmlString),
    baseName: `${String(i + 1).padStart(2, '0')}_${slugify(scenario.name)}`,
    scenarioId: scenario.id,
  }));

  const collectionXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />',
    '  <COLLECTION Entries="20">',
    ...scenarioBlocks.map((s) => s.block),
    ...generatedXmlBlocks,
    '  </COLLECTION>',
    '  <PLAYLISTS>',
    '    <NODE Type="0" Name="ROOT" Count="1">',
    '      <NODE Name="Testdateien Audio Datenbanken" Type="1" KeyType="0" Entries="20">',
    ...Array.from({ length: ENTRY_COUNT }, (_, i) => `        <TRACK Key="${i + 1}" />`),
    '      </NODE>',
    '    </NODE>',
    '  </PLAYLISTS>',
    '</DJ_PLAYLISTS>',
  ].join('\n');

  fs.writeFileSync(path.join(DIR_TESTDATEIEN, 'collection_20_tracks.xml'), collectionXml, 'utf-8');

  // -- Kollektion mit dem echten Parser prüfen ------------------------------
  const collectionParse = parseRekordboxXml(collectionXml);
  if (collectionParse.tracks.length !== ENTRY_COUNT) {
    throw new Error(
      `Sammel-XML enthält ${collectionParse.tracks.length} Tracks, erwartet wurden ${ENTRY_COUNT}.`
    );
  }

  const dbReader = require_('../electron/dbReader.cjs') as {
    isCipherAvailable: () => boolean;
    getMasterDbKey: () => string;
    getOneLibraryKey: () => string;
    readRekordboxDatabase: (filePath: string) => any;
  };

  const artifacts: EntryArtifacts[] = [];
  const masterContentRows: any[] = [];
  const masterCueRows: any[] = [];
  const oneLibraryContentRows: any[] = [];
  const oneLibraryCueRows: any[] = [];
  const artists = new Map<string, number>();
  const albums = new Map<string, number>();
  const genres = new Map<string, number>();
  const keys = new Map<string, number>();
  const labels = new Map<string, number>();
  const verification: string[] = [];

  const idFor = (map: Map<string, number>, name: string, startId: number) => {
    const clean = (name || '').trim() || 'Unknown';
    if (!map.has(clean)) map.set(clean, startId + map.size);
    return map.get(clean)!;
  };

  for (let i = 0; i < ENTRY_COUNT; i++) {
    const partial = collectionParse.tracks[i]!;
    const isScenario = i < scenarioBlocks.length;
    const baseName = isScenario ? scenarioBlocks[i]!.baseName : `${String(i + 1).padStart(2, '0')}_${slugify(partial.artist || 'Artist')}_-_${slugify(partial.title || 'Track')}`;

    // Einzel-XML (exakt der Block aus der Kollektion)
    const singleXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<DJ_PLAYLISTS Version="1.0.0">',
      '  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />',
      '  <COLLECTION Entries="1">',
      isScenario ? scenarioBlocks[i]!.block : generatedXmlBlocks[i - scenarioBlocks.length]!,
      '  </COLLECTION>',
      '</DJ_PLAYLISTS>',
    ].join('\n');
    const xmlPath = path.join(DIR_TESTDATEIEN, `${baseName}.xml`);
    fs.writeFileSync(xmlPath, singleXml, 'utf-8');

    // Audio-Render im Track-BPM
    const bpm = partial.bpm || 130;
    const wavBuffer = Buffer.from(generatePcmWavArrayBuffer(AUDIO_PREVIEW_SECONDS, bpm, SAMPLE_RATE));
    const wavPath = path.join(DIR_AUDIO, `${baseName}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);

    // Waveform aus dem realen PCM (Analyzer des Projekts)
    const pcm = new Int16Array(wavBuffer.buffer, wavBuffer.byteOffset + 44, (wavBuffer.length - 44) / 2);
    const left = new Float32Array(pcm.length / 2);
    const right = new Float32Array(pcm.length / 2);
    for (let s = 0; s < left.length; s++) {
      left[s] = pcm[s * 2] / 32768;
      right[s] = pcm[s * 2 + 1] / 32768;
    }
    const fakeAudioBuffer = {
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      length: left.length,
      duration: AUDIO_PREVIEW_SECONDS,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    } as unknown as AudioBuffer;
    const waveformFromAudio = analyzeAudioBuffer(fakeAudioBuffer, DataOrigin.LOCAL_ANALYSIS);

    // Komplette Extraktion über die Projektpipeline
    const { track, record } = extractTrackFromRekordboxXml(singleXml, 0, fakeAudioBuffer);
    track.analysis = waveformFromAudio;

    // extractTrackFromRekordboxXml() reicht Rating, Play Count, Kommentar, Genre,
    // Label, Jahr und die Original-Referenz nicht weiter – hier werden sie aus dem
    // geparsten XML-Eintrag ergänzt, damit kein Eintrag Daten verliert.
    Object.assign(track, {
      genre: partial.genre ?? track.genre,
      label: partial.label ?? partial.rawXmlAttributes?.Label ?? track.label,
      rating: partial.rating ?? track.rating,
      playCount: partial.playCount ?? track.playCount,
      year: partial.year || track.year,
      comments: partial.comments || track.comments,
      dateAdded: partial.dateAdded || track.dateAdded,
      remixer: partial.remixer || track.remixer,
      originalMedia: partial.originalMedia ?? track.originalMedia,
      rawXmlAttributes: partial.rawXmlAttributes ?? track.rawXmlAttributes,
    });

    // ANLZ-Dateien aus den echten Track-Daten erzeugen
    const spb = 60 / bpm;
    const beatCount = Math.min(4096, Math.max(32, Math.round((track.duration - track.beatGrid.firstBeat) / spb)));
    const beatGrid = Array.from({ length: beatCount }, (_, b) => ({
      beatInBar: (b % 4) + 1,
      tempo: Math.round(bpm * 100),
      timeMs: Math.round(track.beatGrid.firstBeat * 1000 + (60000 / bpm) * b),
    }));

    const sample = (values: Float32Array, columns: number) => {
      const out: number[] = [];
      for (let c = 0; c < columns; c++) {
        const idx = Math.min(values.length - 1, Math.floor((c / columns) * values.length));
        out.push(values[idx] ?? 0);
      }
      return out;
    };
    const peaks = sample(waveformFromAudio.peaks, WAVEFORM_COLUMNS);
    const lows = sample(waveformFromAudio.lowEnergy, WAVEFORM_COLUMNS);
    const mids = sample(waveformFromAudio.midEnergy, WAVEFORM_COLUMNS);
    const highs = sample(waveformFromAudio.highEnergy, WAVEFORM_COLUMNS);

    const memoryCues = track.cues.filter((c) => c.type === 'MEMORY');
    const hotCues = track.cues.filter((c) => c.type === 'HOT_CUE');
    const loops = track.loops;

    const memoryEntries = memoryCues.map((cue, idx) =>
      encodePcptEntry(Math.round(cue.position * 1000), {
        hotCue: 0,
        orderFirst: idx === 0 ? 0xffff : idx,
        orderLast: idx === memoryCues.length - 1 ? 0xffff : idx + 2,
      })
    );
    const loopEntries = loops.map((loop) =>
      encodePcptEntry(Math.round(loop.start * 1000), {
        hotCue: 0,
        loop: Math.max(1, Math.round((loop.end - loop.start) * 1000)),
        orderFirst: 0xfffe,
        orderLast: 0xfffe,
      })
    );
    const hotEntries = hotCues.map((cue) =>
      encodePcptEntry(Math.round(cue.position * 1000), { hotCue: (cue.hotCueNum ?? 0) + 1 })
    );

    const datPath = path.join(DIR_ANLZ, `${baseName}.DAT`);
    const datBuffer = assembleAnlzFile([
      encodePpth(wavPath),
      encodePqtz(beatGrid),
      encodePcob(0, [...memoryEntries, ...loopEntries]),
      ...(hotEntries.length ? [encodePcob(1, hotEntries)] : []),
      encodePwv5Rgb(
        peaks.map((peak, c) => ({ peak, low: lows[c] ?? 0, mid: mids[c] ?? 0, high: highs[c] ?? 0 }))
      ),
    ]);
    fs.writeFileSync(datPath, datBuffer);

    const phraseKind: Record<string, number> = { INTRO: 1, UP: 2, DOWN: 3, CHORUS: 5, OUTRO: 6 };
    const phraseEntries = (track.phrases || []).slice(0, 16).map((phrase, idx) =>
      encodePssiPhrase({
        index: idx + 1,
        beat: Math.max(1, Math.round((phrase.startTime - track.beatGrid.firstBeat) / spb) + 1),
        kind: phraseKind[phrase.name] ?? 2,
      })
    );
    const lastPhraseBeat = (track.phrases || []).length
      ? Math.max(1, Math.round(((track.phrases || [])[Math.max(0, (track.phrases || []).length - 1)].endTime - track.beatGrid.firstBeat) / spb))
      : beatCount;

    const extPath = path.join(DIR_ANLZ, `${baseName}.EXT`);
    const extBuffer = assembleAnlzFile([
      encodePpth(wavPath),
      encodePqtz(beatGrid),
      // Eine gemeinsame Memory-Bank (Typ 0): echte .EXT-Dateien führen
      // Memory Cues UND Loops in derselben PCO2-Sektion – zwei Sektionen
      // gleichen Typs würden sich beim Lesen gegenseitig überschreiben.
      encodePco2(0, [
        ...memoryCues.map((cue) => encodePcp2Entry(Math.round(cue.position * 1000), { hotCue: 0, comment: cue.name })),
        ...loops.map((loop) =>
          encodePcp2Entry(Math.round(loop.start * 1000), {
            hotCue: 0,
            type: 2,
            loop: Math.max(1, Math.round((loop.end - loop.start) * 1000)),
            comment: loop.name,
          })
        ),
      ]),
      encodePco2(
        1,
        hotCues.map((cue) =>
          encodePcp2Entry(Math.round(cue.position * 1000), {
            hotCue: (cue.hotCueNum ?? 0) + 1,
            comment: cue.name,
            colorCode: (cue.hotCueNum ?? 0) + 1,
            colorRgb: parseRgb(cue.color),
          })
        )
      ),
      encodePwv3Mono(peaks),
      encodePwv7Triple(peaks.map((_, c) => ({ mid: mids[c] ?? 0, high: highs[c] ?? 0, low: lows[c] ?? 0 }))),
      encodePssi(1, lastPhraseBeat, phraseEntries, 1),
    ]);
    fs.writeFileSync(extPath, extBuffer);

    // Rück-Leseprobe: die geschriebenen ANLZ-Dateien mit dem Projekt-Parser öffnen
    const datParse = parseAnlzBinary(toArrayBuffer(fs.readFileSync(datPath)));
    const extParse = parseAnlzBinary(toArrayBuffer(fs.readFileSync(extPath)));
    const finalTrack: TrackModel = applyAnlzExtractionToTrack(track, extParse);

    verification.push(
      `${baseName}: DAT[Tags=${datParse.tagsFound.join('/')}, Cues=${datParse.cues.length}, Loops=${datParse.loops.length}, Grid=${datParse.beatGrid?.beats.length ?? 0}] ` +
        `EXT[Tags=${extParse.tagsFound.join('/')}, Cues=${extParse.cues.length}, Loops=${extParse.loops.length}, Phrasen=${extParse.phrases.length}, Waveform=${extParse.waveform?.length ?? 0}]`
    );

    if (extParse.cues.length === 0) throw new Error(`${baseName}: EXT ohne Cues gelesen.`);
    const extMemory = extParse.cues.filter((c) => c.type === 'MEMORY').length;
    const extHot = extParse.cues.filter((c) => c.type === 'HOT_CUE').length;
    if (extMemory !== memoryCues.length || extHot !== hotCues.length || extParse.loops.length !== loops.length) {
      throw new Error(
        `${baseName}: EXT-Rücklesung unvollständig (Memory ${extMemory}/${memoryCues.length}, ` +
          `Hot ${extHot}/${hotCues.length}, Loops ${extParse.loops.length}/${loops.length}).`
      );
    }
    if (!extParse.waveform || extParse.waveform.length !== WAVEFORM_COLUMNS) {
      throw new Error(`${baseName}: PWV-Waveform wurde nicht korrekt zurückgelesen.`);
    }
    if (extParse.phrases.length === 0) throw new Error(`${baseName}: PSSI ohne Phrasen gelesen.`);

    // DB-Zeilen (master.db + exportLibrary.db)
    const artistId = idFor(artists, finalTrack.artist, 1);
    const albumId = idFor(albums, finalTrack.album, 1);
    const genreId = idFor(genres, finalTrack.genre || 'Electronic', 1);
    const keyId = idFor(keys, finalTrack.key, 1);
    const labelId = idFor(labels, finalTrack.label || finalTrack.album || 'n/a', 1);
    const contentId = Number(finalTrack.id) || 1000 + i;
    const lengthMs = Math.round(finalTrack.duration * 1000);

    masterContentRows.push({
      ID: contentId,
      FolderPath: path.dirname(wavPath),
      FileNameL: path.basename(wavPath),
      Title: finalTrack.title,
      ArtistID: artistId,
      AlbumID: albumId,
      GenreID: genreId,
      BPM: Math.round(bpm * 100),
      Length: lengthMs,
      TrackNo: i + 1,
      BitRate: 320,
      BitDepth: 16,
      Commnt: finalTrack.comments || '',
      FileType: 'wav',
      Rating: Math.round(((finalTrack.rating ?? 0) / 5) * 255),
      ReleaseYear: Number(finalTrack.year) || 2026,
      RemixerID: 0,
      LabelID: labelId,
      KeyID: keyId,
      StockDate: '2026-09-06',
      ColorID: 0,
      DJPlayCount: String(finalTrack.playCount ?? 0),
      AnalysisDataPath: datPath,
      FileSize: wavBuffer.length,
      SampleRate: SAMPLE_RATE,
      DateCreated: '2026-09-06 09:00:00',
      ReleaseDate: `${Number(finalTrack.year) || 2026}-01-01`,
      ISRC: `DEA${String(contentId).padStart(9, '0')}`,
      Subtitle: '',
      ComposerID: 0,
    });

    const memoryRows = finalTrack.cues
      .filter((c) => c.type === 'MEMORY')
      .map((cue, idx) => ({
        ID: `${contentId}${String(idx).padStart(3, '0')}`,
        ContentID: contentId,
        InMsec: Math.round(cue.position * 1000),
        InFrame: 0,
        OutMsec: -1,
        OutFrame: 0,
        Kind: 0,
        Color: 0,
        ColorTableIndex: 0,
        ActiveLoop: 0,
        Comment: cue.name,
        BeatLoopSize: 0,
      }));
    const hotRows = finalTrack.cues
      .filter((c) => c.type === 'HOT_CUE')
      .map((cue) => ({
        ID: `${contentId}9${String(cue.hotCueNum ?? 0)}`,
        ContentID: contentId,
        InMsec: Math.round(cue.position * 1000),
        InFrame: 0,
        OutMsec: -1,
        OutFrame: 0,
        Kind: (cue.hotCueNum ?? 0) + 1,
        Color: 0,
        ColorTableIndex: 0,
        ActiveLoop: 0,
        Comment: cue.name,
        BeatLoopSize: 0,
      }));
    const loopRows = finalTrack.loops.map((loop, idx) => ({
      ID: `${contentId}8${String(idx).padStart(2, '0')}`,
      ContentID: contentId,
      InMsec: Math.round(loop.start * 1000),
      InFrame: 0,
      OutMsec: Math.round(loop.end * 1000),
      OutFrame: 0,
      Kind: 0,
      Color: 0,
      ColorTableIndex: 0,
      ActiveLoop: 1,
      Comment: loop.name,
      BeatLoopSize: Math.max(1, Math.round((loop.end - loop.start) / spb)),
    }));
    masterCueRows.push(...memoryRows, ...hotRows, ...loopRows);

    oneLibraryContentRows.push({
      content_id: contentId,
      title: finalTrack.title,
      artist_id_artist: artistId,
      album_id: albumId,
      genre_id: genreId,
      bpmx100: Math.round(bpm * 100),
      length: lengthMs,
      rating: finalTrack.rating ?? 0,
      releaseYear: Number(finalTrack.year) || 2026,
      key_id: keyId,
      label_id: labelId,
      path: path.dirname(wavPath),
      fileName: path.basename(wavPath),
      fileSize: wavBuffer.length,
      samplingRate: SAMPLE_RATE,
      analysisDataFilePath: datPath,
      djComment: finalTrack.comments || '',
      djPlayCount: finalTrack.playCount ?? 0,
      dateCreated: '2026-09-06 09:00:00',
    });
    oneLibraryCueRows.push(
      ...[...memoryRows, ...hotRows, ...loopRows].map((row) => ({
        cue_id: Number(row.ID),
        content_id: contentId,
        kind: row.Kind,
        cueComment: row.Comment,
        inUsec: row.InMsec * 1000,
        outUsec: row.OutMsec >= 0 ? row.OutMsec * 1000 : null,
        isActiveLoop: row.ActiveLoop,
      }))
    );

    // Voll-JSON je Eintrag
    const entryJson = {
      eintrag: i + 1,
      quelle: {
        herkunft: isScenario
          ? `src/rekordbox/testDatasets.ts → ALL_TEST_SCENARIOS['${scenarioBlocks[i]!.scenarioId}']`
          : 'generierter Bibliotheks-Eintrag (gleiches Rekordbox-Schema, deterministischer Seed 20260906)',
        xmlDatei: path.relative(TARGET_DIR, xmlPath),
        trackId: finalTrack.id,
        xmlAttribute: partial.rawXmlAttributes ?? {},
      },
      track: {
        id: finalTrack.id,
        titel: finalTrack.title,
        artist: finalTrack.artist,
        album: finalTrack.album,
        genre: finalTrack.genre,
        label: finalTrack.label,
        bpm: finalTrack.bpm,
        tonart: finalTrack.key,
        dauerSekunden: finalTrack.duration,
        sampleRate: finalTrack.sampleRate,
        kanaele: finalTrack.channels,
        rating0bis5: finalTrack.rating,
        playCount: finalTrack.playCount,
        jahr: finalTrack.year,
        kommentar: finalTrack.comments,
        isrc: finalTrack.isrc,
        origin: finalTrack.origin,
        originalUnveraendert: finalTrack.isOriginalUntouched,
      },
      beatGrid: {
        firstBeat: finalTrack.beatGrid.firstBeat,
        bpm: finalTrack.beatGrid.bpm,
        meter: finalTrack.beatGrid.meter,
        origin: finalTrack.beatGrid.origin,
        anzahlBeats: finalTrack.beatGrid.beats.length,
        beats: finalTrack.beatGrid.beats.slice(0, 64),
        beatsHinweis: 'Die ersten 64 Beats; das vollständige Raster liegt in ANLZ/…​.DAT (PQTZ).',
      },
      memoryCues: finalTrack.cues.filter((c) => c.type === 'MEMORY'),
      hotCues: finalTrack.cues.filter((c) => c.type === 'HOT_CUE'),
      loops: finalTrack.loops,
      phrasen: finalTrack.phrases ?? [],
      waveform: {
        origin: finalTrack.analysis?.origin,
        buckets: finalTrack.analysis?.length ?? 0,
        secPerBucket: finalTrack.analysis?.secPerBucket,
        peaks: floatArrayToRounded(finalTrack.analysis?.peaks ?? new Float32Array()),
        lowEnergy: floatArrayToRounded(finalTrack.analysis?.lowEnergy ?? new Float32Array()),
        midEnergy: floatArrayToRounded(finalTrack.analysis?.midEnergy ?? new Float32Array()),
        highEnergy: floatArrayToRounded(finalTrack.analysis?.highEnergy ?? new Float32Array()),
        hinweis: 'peaksL/peaksR entsprechen bei ANLZ-Quellen den peaks und wurden nicht dupliziert.',
      },
      databaseRecord: record,
      dateien: {
        xml: path.relative(TARGET_DIR, xmlPath),
        audio: path.relative(TARGET_DIR, wavPath),
        anlzDat: path.relative(TARGET_DIR, datPath),
        anlzExt: path.relative(TARGET_DIR, extPath),
      },
      anlzRueckLeseprobe: {
        dat: summarizeAnlz(datParse),
        ext: summarizeAnlz(extParse),
      },
      datenbankZeile: {
        masterDb: masterContentRows[i],
        oneLibrary: oneLibraryContentRows[i],
        cueZeilenMasterDb: [...memoryRows, ...hotRows, ...loopRows].length,
      },
      checksummen: {
        xml: sha256(fs.readFileSync(xmlPath)),
        wav: sha256(wavBuffer),
        anlzDat: sha256(datBuffer),
        anlzExt: sha256(extBuffer),
      },
      extrahiertAm: new Date().toISOString(),
    };
    const jsonPath = path.join(DIR_TESTDATEIEN, `${baseName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(entryJson, null, 2), 'utf-8');

    const files: EntryArtifacts['files'] = {};
    for (const [label, file] of Object.entries({ xml: xmlPath, json: jsonPath, wav: wavPath, dat: datPath, ext: extPath })) {
      const stat = fs.statSync(file);
      files[label] = {
        path: path.relative(TARGET_DIR, file),
        bytes: stat.size,
        sha256: sha256(fs.readFileSync(file)),
      };
    }

    artifacts.push({
      index: i + 1,
      entryId: String(finalTrack.id),
      baseName,
      title: finalTrack.title,
      artist: finalTrack.artist,
      bpm: finalTrack.bpm,
      duration: finalTrack.duration,
      key: finalTrack.key,
      files,
      counts: {
        memoryCues: finalTrack.cues.filter((c) => c.type === 'MEMORY').length,
        hotCues: finalTrack.cues.filter((c) => c.type === 'HOT_CUE').length,
        loops: finalTrack.loops.length,
        phrases: (finalTrack.phrases ?? []).length,
        beatGridBeats: beatGrid.length,
        waveformBuckets: finalTrack.analysis?.length ?? 0,
      },
    });
  }

  // -- Datenbanken schreiben (SQLCipher, Community-Schlüssel) ---------------
  const Database = require_('better-sqlite3-multiple-ciphers');
  const masterDbPath = path.join(DIR_DATENBANKEN, 'master.db');
  const exportDbPath = path.join(DIR_DATENBANKEN, 'exportLibrary.db');
  for (const file of [masterDbPath, exportDbPath]) if (fs.existsSync(file)) fs.rmSync(file);

  const masterSchema = `
PRAGMA page_size = 4096;
CREATE TABLE djmdArtist (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE djmdAlbum (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE djmdGenre (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE djmdKey (ID INTEGER PRIMARY KEY, ScaleName TEXT, Seq INTEGER);
CREATE TABLE djmdLabel (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE djmdContent (ID INTEGER PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID INTEGER, AlbumID INTEGER, GenreID INTEGER, BPM INTEGER, Length INTEGER, TrackNo INTEGER, BitRate INTEGER, BitDepth INTEGER, Commnt TEXT, FileType TEXT, Rating INTEGER, ReleaseYear INTEGER, RemixerID INTEGER, LabelID INTEGER, KeyID INTEGER, StockDate TEXT, ColorID INTEGER, DJPlayCount TEXT, AnalysisDataPath TEXT, FileSize INTEGER, SampleRate INTEGER, DateCreated TEXT, ReleaseDate TEXT, ISRC TEXT, Subtitle TEXT, ComposerID INTEGER);
CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID INTEGER, InMsec INTEGER, InFrame INTEGER, OutMsec INTEGER, OutFrame INTEGER, Kind INTEGER, Color INTEGER, ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER);
CREATE TABLE djmdPlaylist (ID INTEGER PRIMARY KEY, Name TEXT, ParentID INTEGER, Attribute INTEGER);
CREATE TABLE djmdSongPlaylist (ID INTEGER PRIMARY KEY, PlaylistID INTEGER, ContentID INTEGER, TrackNo INTEGER);
CREATE INDEX idx_djmdCue_ContentID ON djmdCue(ContentID);`;

  const oneLibrarySchema = `
PRAGMA page_size = 4096;
CREATE TABLE artist (artist_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE album (album_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE genre (genre_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE key (key_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE label (label_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE content (content_id INTEGER PRIMARY KEY, title TEXT, artist_id_artist INTEGER, album_id INTEGER, genre_id INTEGER, bpmx100 INTEGER, length INTEGER, rating INTEGER, releaseYear INTEGER, key_id INTEGER, label_id INTEGER, path TEXT, fileName TEXT, fileSize INTEGER, samplingRate INTEGER, analysisDataFilePath TEXT, djComment TEXT, djPlayCount INTEGER, dateCreated TEXT);
CREATE TABLE cue (cue_id INTEGER PRIMARY KEY, content_id INTEGER, kind INTEGER, cueComment TEXT, inUsec INTEGER, outUsec INTEGER, isActiveLoop INTEGER);
CREATE TABLE playlist (playlist_id INTEGER PRIMARY KEY, name TEXT, playlist_id_parent INTEGER, attribute INTEGER);
CREATE TABLE playlist_content (playlist_content_id INTEGER PRIMARY KEY, playlist_id INTEGER, content_id INTEGER, sequenceNo INTEGER);
CREATE INDEX idx_cue_content ON cue(content_id);`;

  const masterDump: string[] = ['-- master.db (Klartext-Dump der erzeugten SQLCipher-Datenbank)', masterSchema, ''];
  const oneDump: string[] = ['-- exportLibrary.db (Klartext-Dump der erzeugten SQLCipher-Datenbank)', oneLibrarySchema, ''];

  function insertAll(db: any, table: string, rows: any[], dump: string[]) {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    const insertMany = db.transaction((items: any[]) => {
      for (const row of items) stmt.run(...columns.map((c) => row[c] ?? null));
    });
    insertMany(rows);
    for (const row of rows) {
      dump.push(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
          .map((c) => sqlLiteral(row[c]))
          .join(', ')});`
      );
    }
  }

  const keyRows = [...keys.entries()].map(([name, id]) => ({ ID: id, ScaleName: name, Seq: id }));
  const oneKeyRows = [...keys.entries()].map(([name, id]) => ({ key_id: id, name }));

  const masterDb = new Database(masterDbPath);
  masterDb.pragma('cipher = sqlcipher');
  masterDb.pragma('legacy = 4');
  masterDb.pragma(`key = '${dbReader.getMasterDbKey()}'`);
  masterDb.exec(masterSchema);
  insertAll(masterDb, 'djmdArtist', [...artists.entries()].map(([name, id]) => ({ ID: id, Name: name })), masterDump);
  insertAll(masterDb, 'djmdAlbum', [...albums.entries()].map(([name, id]) => ({ ID: id, Name: name })), masterDump);
  insertAll(masterDb, 'djmdGenre', [...genres.entries()].map(([name, id]) => ({ ID: id, Name: name })), masterDump);
  insertAll(masterDb, 'djmdKey', keyRows, masterDump);
  insertAll(masterDb, 'djmdLabel', [...labels.entries()].map(([name, id]) => ({ ID: id, Name: name })), masterDump);
  insertAll(masterDb, 'djmdContent', masterContentRows, masterDump);
  insertAll(masterDb, 'djmdCue', masterCueRows, masterDump);
  insertAll(masterDb, 'djmdPlaylist', [{ ID: 1, Name: 'Testdateien Audio Datenbanken', ParentID: null, Attribute: 0 }], masterDump);
  insertAll(
    masterDb,
    'djmdSongPlaylist',
    masterContentRows.map((row, i) => ({ ID: i + 1, PlaylistID: 1, ContentID: row.ID, TrackNo: i + 1 })),
    masterDump
  );
  masterDb.close();

  const oneDb = new Database(exportDbPath);
  oneDb.pragma('cipher = sqlcipher');
  oneDb.pragma('legacy = 4');
  oneDb.pragma(`key = '${dbReader.getOneLibraryKey()}'`);
  oneDb.exec(oneLibrarySchema);
  insertAll(oneDb, 'artist', [...artists.entries()].map(([name, id]) => ({ artist_id: id, name })), oneDump);
  insertAll(oneDb, 'album', [...albums.entries()].map(([name, id]) => ({ album_id: id, name })), oneDump);
  insertAll(oneDb, 'genre', [...genres.entries()].map(([name, id]) => ({ genre_id: id, name })), oneDump);
  insertAll(oneDb, 'key', oneKeyRows, oneDump);
  insertAll(oneDb, 'label', [...labels.entries()].map(([name, id]) => ({ label_id: id, name })), oneDump);
  insertAll(oneDb, 'content', oneLibraryContentRows, oneDump);
  insertAll(oneDb, 'cue', oneLibraryCueRows, oneDump);
  insertAll(oneDb, 'playlist', [{ playlist_id: 1, name: 'Testdateien Audio Datenbanken', playlist_id_parent: null, attribute: 0 }], oneDump);
  insertAll(
    oneDb,
    'playlist_content',
    oneLibraryContentRows.map((row, i) => ({ playlist_content_id: i + 1, playlist_id: 1, content_id: row.content_id, sequenceNo: i + 1 })),
    oneDump
  );
  oneDb.close();

  fs.writeFileSync(path.join(DIR_DATENBANKEN, 'master.db.sql'), masterDump.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(DIR_DATENBANKEN, 'exportLibrary.db.sql'), oneDump.join('\n'), 'utf-8');

  // -- Rück-Leseprobe Datenbanken über den Projekt-Reader -------------------
  const masterRead = dbReader.readRekordboxDatabase(masterDbPath);
  if (!masterRead.available) throw new Error(`master.db nicht lesbar: ${masterRead.reason}`);
  const masterMapped = mapRekordboxDatabaseRows(masterRead.rows, 'MASTER_DB');
  const exportRead = dbReader.readRekordboxDatabase(exportDbPath);
  if (!exportRead.available) throw new Error(`exportLibrary.db nicht lesbar: ${exportRead.reason}`);
  const exportMapped = mapRekordboxDatabaseRows(exportRead.rows, 'ONE_LIBRARY');

  if (masterMapped.tracks.length !== ENTRY_COUNT) throw new Error(`master.db liefert ${masterMapped.tracks.length} Tracks.`);
  if (exportMapped.tracks.length !== ENTRY_COUNT) throw new Error(`exportLibrary.db liefert ${exportMapped.tracks.length} Tracks.`);

  masterMapped.tracks.forEach((dbTrack, i) => {
    const xmlTrack = collectionParse.tracks[i]!;
    if (dbTrack.title !== xmlTrack.title) throw new Error(`Titel-Abweichung bei Eintrag ${i + 1}: ${dbTrack.title} != ${xmlTrack.title}`);
    if (Math.abs((dbTrack.bpm ?? 0) - (xmlTrack.bpm ?? 0)) > 0.01) throw new Error(`BPM-Abweichung bei Eintrag ${i + 1}.`);
  });

  // -- Manifest + README ----------------------------------------------------
  const manifest = {
    paket: 'Testdateien Audio Datenbanken',
    erstellt: new Date().toISOString(),
    quelle: 'Airdox/airdox_editor – Rekordbox-XML-Testdatensätze (src/rekordbox/testDatasets.ts)',
    werkzeug: 'tools/extract-20-eintraege.mts',
    eintraege: ENTRY_COUNT,
    audio: {
      format: 'RIFF/WAVE, 16-bit PCM, Stereo',
      sampleRate: SAMPLE_RATE,
      renderSekundenJeTrack: AUDIO_PREVIEW_SECONDS,
      hinweis: 'Die WAV ist ein Render im Track-BPM; Metadaten, Cues und Beatgrid beschreiben die volle Track-Länge.',
    },
    datenbanken: {
      masterDb: {
        datei: 'Datenbanken/master.db',
        verschluesselung: 'SQLCipher (legacy=4), dokumentierter Community-Schluessel aus electron/dbReader.cjs',
        tracks: masterRead.stats.tracks,
        cues: masterRead.stats.cues,
        playlists: masterRead.stats.playlists,
      },
      exportLibraryDb: {
        datei: 'Datenbanken/exportLibrary.db',
        verschluesselung: 'SQLCipher (legacy=4), OneLibrary-Schluessel aus electron/dbReader.cjs',
        tracks: exportRead.stats.tracks,
        cues: exportRead.stats.cues,
        playlists: exportRead.stats.playlists,
      },
    },
    summen: {
      memoryCues: artifacts.reduce((s, a) => s + a.counts.memoryCues, 0),
      hotCues: artifacts.reduce((s, a) => s + a.counts.hotCues, 0),
      loops: artifacts.reduce((s, a) => s + a.counts.loops, 0),
      phrasen: artifacts.reduce((s, a) => s + a.counts.phrases, 0),
      dateien: artifacts.reduce((s, a) => s + Object.keys(a.files).length, 0) + 5,
      bytes: artifacts.reduce((s, a) => s + Object.values(a.files).reduce((x, f) => x + f.bytes, 0), 0),
    },
    eintraegeDetail: artifacts,
    verifikationProEintrag: verification,
  };
  fs.writeFileSync(path.join(TARGET_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const csv = [
    'Nr;TrackID;Titel;Artist;BPM;Tonart;Dauer_s;MemoryCues;HotCues;Loops;Phrasen;Beats;Waveform_Buckets;XML;JSON;WAV;ANLZ_DAT;ANLZ_EXT',
    ...artifacts.map((a) =>
      [
        a.index,
        a.entryId,
        `"${a.title.replace(/"/g, '""')}"`,
        `"${a.artist.replace(/"/g, '""')}"`,
        a.bpm,
        a.key,
        a.duration,
        a.counts.memoryCues,
        a.counts.hotCues,
        a.counts.loops,
        a.counts.phrases,
        a.counts.beatGridBeats,
        a.counts.waveformBuckets,
        a.files.xml.path,
        a.files.json.path,
        a.files.wav.path,
        a.files.dat.path,
        a.files.ext.path,
      ].join(';')
    ),
  ].join('\n');
  fs.writeFileSync(path.join(TARGET_DIR, 'manifest.csv'), csv, 'utf-8');

  fs.writeFileSync(path.join(TARGET_DIR, 'README.md'), buildReadme(manifest, masterRead, exportRead), 'utf-8');
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(TARGET_DIR, 'extract-20-eintraege.mts'));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✅ ${ENTRY_COUNT} Einträge extrahiert nach: ${TARGET_DIR}  (${elapsed}s)\n`);
  console.log(`   master.db        : ${masterRead.stats.tracks} Tracks, ${masterRead.stats.cues} Cues (SQLCipher-Entschlüsselung über electron/dbReader.cjs OK)`);
  console.log(`   exportLibrary.db : ${exportRead.stats.tracks} Tracks, ${exportRead.stats.cues} Cues (OneLibrary-Entschlüsselung OK)`);
  console.log(`   Summen           : ${manifest.summen.memoryCues} Memory Cues, ${manifest.summen.hotCues} Hot Cues, ${manifest.summen.loops} Loops, ${manifest.summen.phrasen} Phrasen`);
  console.log(`   Dateien          : ${manifest.summen.dateien} (${(manifest.summen.bytes / 1024 / 1024).toFixed(1)} MB)\n`);
  verification.slice(0, 3).forEach((line) => console.log(`   ${line}`));
  console.log('   …');
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function parseRgb(color: string): [number, number, number] {
  const match = /(\d+)\D+(\d+)\D+(\d+)/.exec(color || '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 162, 255];
}

function summarizeAnlz(parsed: ReturnType<typeof parseAnlzBinary>) {
  return {
    tags: parsed.tagsFound,
    bpm: parsed.bpm,
    firstBeat: parsed.firstBeat,
    anlzPfad: parsed.analysisPath,
    memoryCues: parsed.cues.filter((c) => c.type === 'MEMORY').length,
    hotCues: parsed.cues.filter((c) => c.type === 'HOT_CUE').length,
    loops: parsed.loops.length,
    phrasen: parsed.phrases.length,
    waveformSpalten: parsed.waveform?.length ?? 0,
    pssi: { mood: parsed.pssiMood, endBeat: parsed.pssiEndBeat, bank: parsed.pssiBank, masked: parsed.pssiMasked },
    warnungen: parsed.warnings,
  };
}

function buildReadme(manifest: any, masterRead: any, exportRead: any): string {
  const rows = manifest.eintraegeDetail
    .map(
      (a: any) =>
        `| ${a.index} | ${a.entryId} | ${a.title} | ${a.artist} | ${a.bpm} | ${a.key} | ${a.duration.toFixed(1)} | ${a.counts.memoryCues} | ${a.counts.hotCues} | ${a.counts.loops} | ${a.counts.phrases} |`
    )
    .join('\n');

  return `# Testdateien · Audio · Datenbanken

${ENTRY_COUNT} Einzel-Einträge aus den Rekordbox-XML-Testdatensätzen des Projekts \`airdox_editor\`,
jeweils mit **allen zugehörigen Daten**. Erzeugt am ${manifest.erstellt} mit
\`tools/extract-20-eintraege.mts\` (liegt als Kopie in diesem Ordner).

## Inhalt

| Ordner | Inhalt |
| --- | --- |
| \`Testdateien/\` | ${ENTRY_COUNT} × Einzel-Track-XML + ${ENTRY_COUNT} × Voll-JSON (Metadaten, Beatgrid, Memory Cues, Hot Cues, Loops, Phrasen, Waveform, Prüfsummen) + \`collection_20_tracks.xml\` |
| \`Audio/\` | ${ENTRY_COUNT} × 16-bit-PCM-WAV (Stereo, ${SAMPLE_RATE} Hz, ${AUDIO_PREVIEW_SECONDS}s-Render im jeweiligen Track-BPM) |
| \`Datenbanken/\` | \`master.db\` (Rekordbox 6/7, djmd*-Schema) und \`exportLibrary.db\` (OneLibrary) – **SQLCipher-verschlüsselt**, dazu die Klartext-Dumps \`*.db.sql\` |
| \`Datenbanken/ANLZ/\` | ${ENTRY_COUNT} × \`.DAT\` (PPTH, PQTZ, PCOB/PCPT, PWV5) und \`.EXT\` (PCO2 mit Kommentaren/Farben, PWV3, PWV7, PSSI) |

## Herkunft der 20 Einträge

- **1–4**: die vier handgeschriebenen Szenarien aus \`src/rekordbox/testDatasets.ts\`
  (Techno Master, Tech House Groove, Drum & Bass Roller, Edge Cases) – unverändert übernommen.
- **5–20**: 16 zusätzliche Bibliotheks-Einträge im selben Rekordbox-Schema
  (deterministischer Seed 20260906, d. h. bei erneutem Aufruf identisch).

Alle 20 Einträge wurden durch die echte Import-Pipeline des Projekts geschickt:
\`xmlParser.parseRekordboxXml\` → \`waveform/analyzer.analyzeAudioBuffer\` →
\`databaseExtractor.extractTrackFromRekordboxXml\` → \`parseAnlzBinary\` →
\`applyAnlzExtractionToTrack\` → \`dbReader.readRekordboxDatabase\` → \`dbParser.mapRekordboxDatabaseRows\`.

Synthetische Testwerte (bewusst erfunden, keine echten Katalogdaten): ISRC,
\`StockDate\`/\`DateCreated\`/\`ReleaseDate\`, Dateigrößen und die WAV-Render selbst.

## Übersicht der Einträge

| # | TrackID | Titel | Artist | BPM | Tonart | Dauer (s) | Memory | Hot | Loops | Phrasen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

**Summen:** ${manifest.summen.memoryCues} Memory Cues, ${manifest.summen.hotCues} Hot Cues,
${manifest.summen.loops} Loops, ${manifest.summen.phrasen} Phrasen, ${manifest.summen.dateien} Dateien,
${(manifest.summen.bytes / 1024 / 1024).toFixed(1)} MB.

## Datenbanken

Beide Dateien sind mit den dokumentierten Community-Schlüsseln aus \`electron/dbReader.cjs\`
SQLCipher-verschlüsselt (\`cipher = sqlcipher\`, \`legacy = 4\`) und wurden anschließend mit genau
diesem Reader wieder geöffnet:

- \`master.db\` → ${masterRead.stats.tracks} Tracks, ${masterRead.stats.cues} Cues, ${masterRead.stats.playlists} Playlist
- \`exportLibrary.db\` → ${exportRead.stats.tracks} Tracks, ${exportRead.stats.cues} Cues, ${exportRead.stats.playlists} Playlist

Die Schlüssel liegen bewusst nicht in diesem Ordner – sie stehen bereits im Quellcode des Projekts.
Wer den Inhalt ohne Entschlüsselung ansehen möchte, nutzt \`Datenbanken/master.db.sql\` bzw.
\`Datenbanken/exportLibrary.db.sql\`.

## Neu erzeugen

\`\`\`bash
cd airdox_editor
npx tsx tools/extract-20-eintraege.mts "~/Desktop/Testdateien Audio Datenbanken"
\`\`\`

Voraussetzung: \`npm install\` sowie das native Modul \`better-sqlite3-multiple-ciphers\`
(für die SQLCipher-Datenbanken).
`;
}

main();
