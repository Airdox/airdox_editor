/**
 * @license
 * Automated Test Suite for Rekordbox XML, Audio, and Database Extraction
 * 
 * Run with: npx tsx tests/import-simulation.test.ts
 */

import {
  ALL_TEST_SCENARIOS,
  SCENARIO_TECHNO_XML,
  SCENARIO_TECH_HOUSE_XML,
  SCENARIO_DNB_XML,
  SCENARIO_EDGE_CASES_XML,
  generatePcmWavArrayBuffer,
  generateSyntheticAnlzBuffer,
} from '../src/rekordbox/testDatasets';
import { parseRekordboxXml, buildBeatGridFromTempo, unescapeXml } from '../src/rekordbox/xmlParser';
import { applyAnlzExtractionToTrack, extractTrackFromRekordboxXml, parseAnlzBinary } from '../src/rekordbox/databaseExtractor';
import { DataOrigin } from '../src/types/rekordbox';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

function runTest(suite: string, name: string, testFn: () => void) {
  const t0 = performance.now();
  try {
    testFn();
    results.push({
      suite,
      name,
      passed: true,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message || String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion Failed [${message}]: expected ${expected}, got ${actual}`);
  }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  REKORDBOX IMPORT & VISUALIZATION DATA EXTRACTION TEST SUITE     ');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── SUITE 1: XML Parsing & Memory Cue Extraction (Techno Master) ───────────
runTest('XML Parser', 'Scenario 1 (Techno): Parse XML version and track count', () => {
  const parsed = parseRekordboxXml(SCENARIO_TECHNO_XML);
  assertEqual(parsed.rawVersion, '1.0.0', 'XML Version');
  assertEqual(parsed.tracks.length, 1, 'Track count');
  const track = parsed.tracks[0];
  assertEqual(track.bpm, 128.0, 'BPM');
  assertEqual(track.title, 'Obsidian Voltage (Club Mix)', 'Title');
  assertEqual(track.artist, 'Klangfeld', 'Artist');
  assertEqual(track.key, '6A', 'Tonality Key');
});

runTest('XML Parser', 'Preserves XML Location as a read-only original-media reference', () => {
  const xml = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1"><TRACK TrackID="42" Name="Reference" Artist="Tester" TotalTime="120" AverageBpm="128" Tonality="8A" Location="file://localhost/C:/Music/Reference.wav"><TEMPO Inizio="0" Bpm="128"/></TRACK></COLLECTION></DJ_PLAYLISTS>`;
  const track = parseRekordboxXml(xml).tracks[0]!;
  assertEqual(track.originalMedia?.location, 'file://localhost/C:/Music/Reference.wav', 'XML Location');
  assertEqual(track.originalMedia?.accessMode, 'READ_ONLY', 'Source access mode');
  assertEqual(track.originalMedia?.status, 'UNVERIFIED', 'Source status before desktop validation');
});

runTest('XML Parser', 'Scenario 1 (Techno): Extract Memory Cues with millisecond accuracy', () => {
  const parsed = parseRekordboxXml(SCENARIO_TECHNO_XML);
  const track = parsed.tracks[0]!;
  const memCues = track.cues!.filter((c) => c.type === 'MEMORY');
  assertEqual(memCues.length, 6, 'Memory Cue count');

  // Verify positions and inMsec
  const expectedSec = [0.0, 15.0, 60.0, 90.0, 105.0, 195.0];
  expectedSec.forEach((sec, idx) => {
    assertEqual(memCues[idx].position, sec, `Cue ${idx + 1} position in seconds`);
    assertEqual(memCues[idx].inMsec, Math.round(sec * 1000), `Cue ${idx + 1} inMsec`);
    assert(memCues[idx].barNumber! >= 1, `Cue ${idx + 1} barNumber must be >= 1`);
    assert(memCues[idx].beatNumber! >= 1 && memCues[idx].beatNumber! <= 4, `Cue ${idx + 1} beatNumber must be 1..4`);
  });

  // Verify Cue Names
  assertEqual(memCues[0].name, 'Intro Start', 'Cue 1 Name');
  assertEqual(memCues[4].name, 'DROP 1', 'Cue 5 Name');
});

runTest('XML Parser', 'Scenario 1 (Techno): Extract Hot Cues A, B, C, D and Loops', () => {
  const parsed = parseRekordboxXml(SCENARIO_TECHNO_XML);
  const track = parsed.tracks[0]!;
  const hotCues = track.cues!.filter((c) => c.type === 'HOT_CUE');
  assertEqual(hotCues.length, 4, 'Hot Cue count');

  const expectedLetters = ['A', 'B', 'C', 'D'];
  hotCues.forEach((hc, idx) => {
    assertEqual(hc.letter, expectedLetters[idx], `Hot cue letter for index ${idx}`);
    assertEqual(hc.hotCueNum, idx, `Hot cue number for index ${idx}`);
  });

  assertEqual(track.loops!.length, 1, 'Loop count');
  assertEqual(track.loops![0].start, 75.0, 'Loop Start');
  assertEqual(track.loops![0].end, 90.0, 'Loop End');
  assertEqual(track.loops![0].length, 15.0, 'Loop Length');
});

// ─── SUITE 2: BeatGrid & Offset Alignment (Tech House) ──────────────────────
runTest('BeatGrid', 'Scenario 2 (Tech House): Offset Inizio (0.240s) & 125 BPM', () => {
  const parsed = parseRekordboxXml(SCENARIO_TECH_HOUSE_XML);
  const track = parsed.tracks[0]!;
  assertEqual(track.bpm, 125.0, 'BPM');
  assertEqual(track.beatGrid!.firstBeat, 0.24, 'Beatgrid First Beat Offset');

  // Verify first beat node
  const beats = track.beatGrid!.beats;
  assert(beats.length > 10, 'Beat node list generated');
  assertEqual(Math.round(beats[0].time * 1000), 240, 'First beat time in ms');
  assertEqual(beats[0].isBarStart, true, 'First beat is bar start');
  assertEqual(beats[0].barNumber, 1, 'First beat bar number is 1');
  assertEqual(beats[0].beatInBar, 1, 'First beat beat in bar is 1');

  // Second beat should be 0.240 + (60 / 125) = 0.240 + 0.480 = 0.720s
  assertEqual(Math.round(beats[1].time * 1000), 720, 'Second beat time in ms');
  assertEqual(beats[1].isBarStart, false, 'Second beat is not bar start');
  assertEqual(beats[1].beatInBar, 2, 'Second beat is 2 in bar');
});

// ─── SUITE 3: High Tempo Phrase Blocks (Drum & Bass 174 BPM) ───────────────
runTest('Phrases & Cues', 'Scenario 3 (DnB): High tempo 174 BPM & 8 Memory Cues', () => {
  const parsed = parseRekordboxXml(SCENARIO_DNB_XML);
  const track = parsed.tracks[0]!;
  assertEqual(track.bpm, 174.0, 'BPM 174');
  const memCues = track.cues!.filter((c) => c.type === 'MEMORY');
  assertEqual(memCues.length, 8, '8 Memory Cues extracted');

  // Full Track Extraction with Waveform and Phrases
  const { track: fullTrack } = extractTrackFromRekordboxXml(SCENARIO_DNB_XML, 0);
  assert(fullTrack !== null, 'Full track extracted');
  assert(fullTrack.phrases.length >= 6, 'PSSI phrase sections synthesized');
  assertEqual(fullTrack.phrases[0].name, 'INTRO', 'First phrase is INTRO');
  assertEqual(fullTrack.phrases[0].endBar - fullTrack.phrases[0].startBar, 16, 'Intro length is 16 bars');
});

// ─── SUITE 4: Edge Cases, Unicode & Entity Decoding ────────────────────────
runTest('Edge Cases', 'Scenario 4: Decode XML entities & special characters', () => {
  const parsed = parseRekordboxXml(SCENARIO_EDGE_CASES_XML);
  const track = parsed.tracks[0]!;

  assertEqual(
    track.title,
    'Música de São Paulo & München "VIP" <Test>',
    'Unescaped title with quotes, ampersand, and brackets'
  );
  assertEqual(track.artist, 'DJ Frânçois & Björk', 'Unicode artist name');
  assertEqual(track.album, 'Global Bass / ÄÖÜ & 100%', 'Umlauts in album');

  // Cue with high precision float
  const memCues = track.cues!.filter((c) => c.type === 'MEMORY');
  assertEqual(memCues[1].inMsec, 15302, 'Millisecond round for 15.30198s');
  assertEqual(memCues[2].name, 'CUE 3: "Drop Máximo"', 'Decoded quote entities in cue name');
});

// ─── SUITE 5: Waveform Analysis & Visualization Data Extraction ────────────
runTest('Waveform Extractor', 'Synthesize multi-band spectral waveform buckets', () => {
  const { track: fullTrack } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  assert(fullTrack !== null, 'Full track extracted');
  assert(fullTrack.analysis !== undefined, 'Waveform analysis object created');
  assert(fullTrack.analysis.peaks.length >= 800, 'At least 800 overview peak buckets');
  assert(fullTrack.analysis.lowEnergy.length >= 800, 'Frequency band energy generated');

  // Verify amplitude range [0..1]
  const samplePeak = fullTrack.analysis.peaks[100];
  assert(samplePeak >= 0 && samplePeak <= 1, 'Peak amplitude is normalized within [0..1]');

  assert(fullTrack.analysis.lowEnergy[100] >= 0 && fullTrack.analysis.lowEnergy[100] <= 1, 'Low band [0..1]');
  assert(fullTrack.analysis.midEnergy[100] >= 0 && fullTrack.analysis.midEnergy[100] <= 1, 'Mid band [0..1]');
  assert(fullTrack.analysis.highEnergy[100] >= 0 && fullTrack.analysis.highEnergy[100] <= 1, 'High band [0..1]');
});

// ─── SUITE 6: Binary ANLZ Parser ───────────────────────────────────────────
runTest('ANLZ Parser', 'Parse synthetic Pioneer ANLZ binary chunk (PCOB, PQTZ, PWV5)', () => {
  const buffer = generateSyntheticAnlzBuffer(128.0);
  const result = parseAnlzBinary(buffer);

  assert(result.tagsFound.includes('PCOB'), 'PCOB cue tag detected');
  assert(result.tagsFound.includes('PQTZ'), 'PQTZ beatgrid tag detected');
  assert(result.tagsFound.includes('PWV5'), 'PWV5 waveform tag detected');
  assertEqual(result.cues.length, 4, '4 binary cues extracted from PCOB');
  assertEqual(result.bpm, 128.0, 'BPM parsed from PQTZ');
});

runTest('ANLZ Parser', 'Prioritizes extracted Rekordbox analysis without losing XML metadata', () => {
  const { track } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);
  const extracted = parseAnlzBinary(generateSyntheticAnlzBuffer(128.0));
  const merged = applyAnlzExtractionToTrack(track, extracted);

  assertEqual(merged.title, track.title, 'XML title is retained');
  assertEqual(merged.artist, track.artist, 'XML artist is retained');
  assertEqual(merged.databaseRecord!.databaseSource, 'REKORDBOX_ANLZ', 'ANLZ source is recorded');
  assertEqual(merged.beatGrid.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ beatgrid has priority');
  assertEqual(merged.analysis!.origin, DataOrigin.REKORDBOX_ANLZ, 'ANLZ waveform has priority');
  assert(merged.cues.every((cue) => cue.origin === DataOrigin.REKORDBOX_ANLZ), 'ANLZ cues have priority');
});

// ─── SUITE 7: RIFF/WAVE Audio Synthesizer ───────────────────────────────────
runTest('Audio Synthesizer', 'Generate valid 16-bit PCM WAV audio file with RIFF header', () => {
  const duration = 5.0;
  const sampleRate = 44100;
  const buffer = generatePcmWavArrayBuffer(duration, 128.0, sampleRate);

  assert(buffer.byteLength > 44, 'Buffer larger than WAV header');
  const view = new DataView(buffer);

  // Check 'RIFF'
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  assertEqual(riff, 'RIFF', 'RIFF header tag');

  // Check 'WAVE'
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  assertEqual(wave, 'WAVE', 'WAVE format tag');

  // Check audio parameters
  const channels = view.getUint16(22, true);
  assertEqual(channels, 2, '2 Stereo Channels');
  const sr = view.getUint32(24, true);
  assertEqual(sr, sampleRate, 'Sample Rate 44100 Hz');
  const bitDepth = view.getUint16(34, true);
  assertEqual(bitDepth, 16, '16-bit PCM');

  // Expected payload size: 44 + 5 * 44100 * 2 channels * 2 bytes = 44 + 882000 = 882044 bytes
  const expectedBytes = 44 + Math.floor(duration * sampleRate) * 4;
  assertEqual(buffer.byteLength, expectedBytes, 'Exact WAV byte size matches duration');
});

// ─── SUITE 8: Memory Cue Seek Math ──────────────────────────────────────────
runTest('Cue Navigation', 'Verify sequential Memory Cue jump offsets', () => {
  const { track: fullTrack } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0)!;
  const mems = fullTrack.cues.filter((c) => c.type === 'MEMORY').sort((a, b) => a.position - b.position);

  let current = 0.0;
  // Jump Next from 0.0 -> Cue 2 at 15.0
  const next1 = mems.find((c) => c.position > current + 0.08);
  assert(next1 !== undefined, 'Next cue found');
  assertEqual(next1!.position, 15.0, 'Next cue at 15.0s');

  // Jump Next from 15.0 -> Cue 3 at 60.0
  current = 15.0;
  const next2 = mems.find((c) => c.position > current + 0.08);
  assertEqual(next2!.position, 60.0, 'Next cue at 60.0s');

  // Jump Prev from 60.0 -> Cue 2 at 15.0
  current = 60.0;
  const prevList = mems.filter((c) => c.position < current - 0.08);
  const prev1 = prevList[prevList.length - 1];
  assertEqual(prev1.position, 15.0, 'Prev cue back to 15.0s');
});

// ─── SUMMARY OUTPUT ─────────────────────────────────────────────────────────
console.log('Test Results:\n');
let passedCount = 0;
let failedCount = 0;

results.forEach((r, idx) => {
  const icon = r.passed ? ' PASS ' : ' FAIL ';
  const status = r.passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`${status}[${icon}]${reset} #${idx + 1} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
  if (!r.passed) {
    console.error(`       Error: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
