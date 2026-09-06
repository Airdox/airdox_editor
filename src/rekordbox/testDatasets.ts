/**
 * @license
 * Rekordbox Test Datasets & Audio Simulation Generator
 * 
 * Provides production-realistic test XML datasets, synthesized PCM WAV audio files,
 * and binary ANLZ chunks for comprehensive import simulation and automated testing.
 */

import { CuePoint, LoopPoint, PhraseSection, TrackModel, DataOrigin } from '../types/rekordbox';
import { parseRekordboxXml } from './xmlParser';
import { extractTrackFromRekordboxXml } from './databaseExtractor';

export interface TestScenario {
  id: string;
  name: string;
  category: 'Techno' | 'Tech House' | 'Drum & Bass' | 'Edge Cases & Stress';
  bpm: number;
  duration: number;
  key: string;
  xmlString: string;
  description: string;
  expectedMemoryCues: number;
  expectedHotCues: number;
  expectedLoops: number;
  expectedPhrases: number;
}

// 1. Scenario: Dark Techno Master (128.00 BPM)
export const SCENARIO_TECHNO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="101" Name="Obsidian Voltage (Club Mix)" Artist="Klangfeld" Album="Subterranean Records" 
           Genre="Techno" TotalTime="240.0" AverageBpm="128.00" Tonality="6A" BitRate="320" 
           Comments="Peak-Hour Master [Memory Cues verified]" Year="2025" Rating="255" PlayCount="18">
      <TEMPO Inizio="0.000" Bpm="128.00" Metro="4/4" Battito="1" />
      <!-- Memory Cues (Type="0", Num="-1") -->
      <POSITION_MARK Name="Intro Start" Type="0" Start="0.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Kick In" Type="0" Start="15.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Breakdown" Type="0" Start="60.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Buildup Rise" Type="0" Start="90.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="DROP 1" Type="0" Start="105.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Outro Mixout" Type="0" Start="195.000" Num="-1" Red="255" Green="34" Blue="34" />
      <!-- Hot Cues (Type="0", Num="0..3") -->
      <POSITION_MARK Name="Hot Cue A" Type="0" Start="0.000" Num="0" Red="0" Green="162" Blue="255" />
      <POSITION_MARK Name="Hot Cue B" Type="0" Start="60.000" Num="1" Red="0" Green="230" Blue="118" />
      <POSITION_MARK Name="Hot Cue C" Type="0" Start="105.000" Num="2" Red="255" Green="145" Blue="0" />
      <POSITION_MARK Name="Hot Cue D" Type="0" Start="180.000" Num="3" Red="213" Green="0" Blue="249" />
      <!-- Active Loop (Type="4") -->
      <POSITION_MARK Name="Buildup 8-Bar Loop" Type="4" Start="75.000" End="90.000" Num="-1" Red="255" Green="170" Blue="0" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

// 2. Scenario: Tech House Groove (125.00 BPM)
export const SCENARIO_TECH_HOUSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="202" Name="Sunlight Shuffle (Extended Mix)" Artist="Marcos Delgado" Album="Ibiza Sessions Vol. 9" 
           Genre="Tech House" TotalTime="210.0" AverageBpm="125.00" Tonality="8A" BitRate="320" 
           Comments="Groove baseline &amp; syncopated claps" Year="2024" Rating="204" PlayCount="42">
      <TEMPO Inizio="0.240" Bpm="125.00" Metro="4/4" Battito="1" />
      <POSITION_MARK Name="First Beat" Type="0" Start="0.240" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Bassline Entrance" Type="0" Start="15.600" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Vocal Chop Breakdown" Type="0" Start="61.680" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="MAIN DROP" Type="0" Start="92.400" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Fade Out" Type="0" Start="184.560" Num="-1" Red="255" Green="34" Blue="34" />
      <!-- Hot Cues -->
      <POSITION_MARK Name="Cue A Intro" Type="0" Start="0.240" Num="0" Red="0" Green="170" Blue="255" />
      <POSITION_MARK Name="Cue B Vocal" Type="0" Start="61.680" Num="1" Red="255" Green="82" Blue="82" />
      <!-- Loops -->
      <POSITION_MARK Name="Intro 4-Bar Loop" Type="4" Start="0.240" End="7.920" Num="-1" Red="255" Green="160" Blue="0" />
      <POSITION_MARK Name="Break 8-Bar Loop" Type="4" Start="61.680" End="77.040" Num="-1" Red="255" Green="160" Blue="0" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

// 3. Scenario: Drum & Bass Peak Hour (174.00 BPM)
export const SCENARIO_DNB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.2" Company="AlphaTheta" />
  <COLLECTION Entries="1">
    <TRACK TrackID="303" Name="Quantum Velocity (VIP Roller)" Artist="Subsonic Pulse" Album="Neurofunk Archives" 
           Genre="Drum &amp; Bass" TotalTime="190.0" AverageBpm="174.00" Tonality="4A" BitRate="320" 
           Comments="Fast 174bpm roller with reese bass" Year="2025" Rating="255" PlayCount="65">
      <TEMPO Inizio="0.000" Bpm="174.00" Metro="4/4" Battito="1" />
      <POSITION_MARK Name="Intro Atmosphere" Type="0" Start="0.000" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Drum Intro" Type="0" Start="11.034" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Reese Bassline" Type="0" Start="22.069" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Drop 1 Buildup" Type="0" Start="33.103" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="MAIN DROP 1" Type="0" Start="44.138" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Second Breakdown" Type="0" Start="88.276" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="DROP 2 (Switch)" Type="0" Start="110.345" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="Outro Beat" Type="0" Start="165.517" Num="-1" Red="255" Green="34" Blue="34" />
      <!-- Hot Cues -->
      <POSITION_MARK Name="Cue A" Type="0" Start="0.000" Num="0" Red="0" Green="162" Blue="255" />
      <POSITION_MARK Name="Cue B Drop 1" Type="0" Start="44.138" Num="1" Red="255" Green="23" Blue="68" />
      <POSITION_MARK Name="Cue C Drop 2" Type="0" Start="110.345" Num="2" Red="255" Green="145" Blue="0" />
      <!-- Loop -->
      <POSITION_MARK Name="Roller 16-Bar Loop" Type="4" Start="44.138" End="66.207" Num="-1" Red="255" Green="170" Blue="0" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

// 4. Scenario: Edge Cases, Dirty Data & Resilience Stress Test
export const SCENARIO_EDGE_CASES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.8.5" Company="Pioneer DJ" />
  <COLLECTION Entries="1">
    <TRACK TrackID="999" Name="Música de São Paulo &amp; München &quot;VIP&quot; &lt;Test&gt;" Artist="DJ Frânçois &amp; Björk" 
           Album="Global Bass / ÄÖÜ &amp; 100%" Genre="Latin Tech / Électronique" 
           TotalTime="180.12345" AverageBpm="126.50" Tonality="11B" BitRate="320" 
           Comments="Testing Unicode: ñ, é, ü, &amp;, &quot;, float start=14.769230769" Year="2025" Rating="150" PlayCount="7">
      <TEMPO Inizio="0.1234" Bpm="126.50" Metro="4/4" Battito="1" />
      <!-- Memory Cues with fractional numbers and unicode labels -->
      <POSITION_MARK Name="CUE 1: Início &amp; Intro" Type="0" Start="0.1234" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="CUE 2: Percussão Pesada" Type="0" Start="15.30198" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="CUE 3: &quot;Drop Máximo&quot;" Type="0" Start="45.6593" Num="-1" Red="255" Green="34" Blue="34" />
      <POSITION_MARK Name="CUE 4: Final / Outro" Type="0" Start="150.852" Num="-1" Red="255" Green="34" Blue="34" />
      <!-- Hot Cue with unstandard values -->
      <POSITION_MARK Name="Hot Cue Alpha" Type="0" Start="0.1234" Num="0" Red="0" Green="180" Blue="255" />
      <POSITION_MARK Name="Hot Cue Beta" Type="0" Start="45.6593" Num="1" Red="255" Green="64" Blue="129" />
      <!-- Zero duration or edge loop -->
      <POSITION_MARK Name="Tight 1-Beat Roll" Type="4" Start="45.6593" End="46.1336" Num="-1" Red="255" Green="150" Blue="0" />
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;

export const ALL_TEST_SCENARIOS: TestScenario[] = [
  {
    id: 'techno-master',
    name: 'Techno Master Anthem (128 BPM)',
    category: 'Techno',
    bpm: 128.0,
    duration: 240.0,
    key: '6A',
    xmlString: SCENARIO_TECHNO_XML,
    description: 'High-energy Peak-Time Techno with 6 Memory Cues, 4 Hot Cues (A-D), and 1 8-Bar Loop.',
    expectedMemoryCues: 6,
    expectedHotCues: 4,
    expectedLoops: 1,
    expectedPhrases: 8,
  },
  {
    id: 'tech-house-groove',
    name: 'Tech House Groove (125 BPM)',
    category: 'Tech House',
    bpm: 125.0,
    duration: 210.0,
    key: '8A',
    xmlString: SCENARIO_TECH_HOUSE_XML,
    description: 'Ibiza style Tech House track with offset beatgrid (0.240s), 5 Memory Cues, and 2 Loops.',
    expectedMemoryCues: 5,
    expectedHotCues: 2,
    expectedLoops: 2,
    expectedPhrases: 8,
  },
  {
    id: 'dnb-roller',
    name: 'Drum & Bass Peak Hour (174 BPM)',
    category: 'Drum & Bass',
    bpm: 174.0,
    duration: 190.0,
    key: '4A',
    xmlString: SCENARIO_DNB_XML,
    description: 'Fast-paced 174 BPM Neurofunk track with 8 rapid Memory Cues and 16-bar phrase blocks.',
    expectedMemoryCues: 8,
    expectedHotCues: 3,
    expectedLoops: 1,
    expectedPhrases: 8,
  },
  {
    id: 'edge-cases-stress',
    name: 'Edge Cases & Resilience Test',
    category: 'Edge Cases & Stress',
    bpm: 126.5,
    duration: 180.12,
    key: '11B',
    xmlString: SCENARIO_EDGE_CASES_XML,
    description: 'Tests UTF-8 unicode characters, entity unescaping, high-precision floats, and boundary conditions.',
    expectedMemoryCues: 4,
    expectedHotCues: 2,
    expectedLoops: 1,
    expectedPhrases: 8,
  },
];

/**
 * Generates a valid 16-bit PCM RIFF/WAVE ArrayBuffer with rhythmic audio
 * (synthesized kick drum, snare/clap, and sub-bass according to BPM).
 */
export function generatePcmWavArrayBuffer(
  durationSec: number = 30.0,
  bpm: number = 128.0,
  sampleRate: number = 44100
): ArrayBuffer {
  const numChannels = 2;
  const numSamples = Math.floor(sampleRate * durationSec);
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize; // 44-byte standard RIFF header

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // 1. RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeString(view, 8, 'WAVE');

  // 2. "fmt " sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // 3. "data" sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true); // Subchunk2Size

  // 4. Synthesize realistic electronic DJ rhythm
  const spb = 60.0 / bpm; // Seconds per beat
  let offset = 44;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatPos = (t % spb) / spb; // 0..1 within current beat
    const beatNumber = Math.floor(t / spb);
    const barBeat = (beatNumber % 4) + 1; // 1, 2, 3, 4

    let sampleL = 0;
    let sampleR = 0;

    // A. 4/4 Electronic Kick Drum on every beat
    if (beatPos < 0.35) {
      const kickFreq = 140 * Math.exp(-beatPos * 14) + 48; // Pitch drop 140Hz -> 48Hz
      const kickEnv = Math.exp(-beatPos * 9);
      const kick = Math.sin(2 * Math.PI * kickFreq * beatPos * spb) * kickEnv * 0.75;
      sampleL += kick;
      sampleR += kick;
    }

    // B. Snare / Clap on Beats 2 and 4
    if ((barBeat === 2 || barBeat === 4) && beatPos < 0.25) {
      const noise = (Math.random() * 2 - 1) * Math.exp(-beatPos * 12) * 0.35;
      const snap = Math.sin(2 * Math.PI * 220 * beatPos) * Math.exp(-beatPos * 25) * 0.3;
      sampleL += noise + snap;
      sampleR += noise + snap;
    }

    // C. Hi-Hat on the 8th note upbeat (off-beat)
    const upbeat = Math.abs(beatPos - 0.5);
    if (upbeat < 0.12) {
      const hatEnv = Math.exp(-upbeat * 28);
      const hatNoise = (Math.random() * 2 - 1) * hatEnv * 0.22;
      sampleL += hatNoise * 0.8;
      sampleR += hatNoise * 1.1; // Stereo spread
    }

    // D. Rolling Bassline
    const bassNote = [55, 55, 65.4, 49][beatNumber % 4] || 55; // A1 / C2 / G1
    const bassEnv = 0.5 + 0.5 * Math.sin(2 * Math.PI * (t % (spb / 2)) / (spb / 2));
    const bass = Math.sin(2 * Math.PI * bassNote * t) * 0.2 * bassEnv;
    sampleL += bass;
    sampleR += bass;

    // Hard clamp to 16-bit integer range
    const intL = Math.max(-32768, Math.min(32767, Math.floor(sampleL * 32767)));
    const intR = Math.max(-32768, Math.min(32767, Math.floor(sampleR * 32767)));

    view.setInt16(offset, intL, true);
    view.setInt16(offset + 2, intR, true);
    offset += 4;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Creates an in-memory Web Audio AudioBuffer for the test scenario.
 */
export function createTestAudioBuffer(
  audioCtx: AudioContext,
  durationSec: number = 30.0,
  bpm: number = 128.0
): AudioBuffer {
  const sampleRate = audioCtx.sampleRate;
  const numSamples = Math.floor(sampleRate * durationSec);
  const audioBuffer = audioCtx.createBuffer(2, numSamples, sampleRate);
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);

  const spb = 60.0 / bpm;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatPos = (t % spb) / spb;
    const beatNumber = Math.floor(t / spb);
    const barBeat = (beatNumber % 4) + 1;

    let l = 0;
    let r = 0;

    // Kick
    if (beatPos < 0.35) {
      const kickFreq = 140 * Math.exp(-beatPos * 14) + 48;
      const kickEnv = Math.exp(-beatPos * 9);
      const kick = Math.sin(2 * Math.PI * kickFreq * beatPos * spb) * kickEnv * 0.75;
      l += kick;
      r += kick;
    }

    // Snare
    if ((barBeat === 2 || barBeat === 4) && beatPos < 0.25) {
      const noise = (Math.random() * 2 - 1) * Math.exp(-beatPos * 12) * 0.35;
      l += noise;
      r += noise;
    }

    // Offbeat Hat
    const upbeat = Math.abs(beatPos - 0.5);
    if (upbeat < 0.12) {
      const hat = (Math.random() * 2 - 1) * Math.exp(-upbeat * 28) * 0.22;
      l += hat * 0.85;
      r += hat * 1.15;
    }

    left[i] = Math.max(-1, Math.min(1, l));
    right[i] = Math.max(-1, Math.min(1, r));
  }

  return audioBuffer;
}

/**
 * Generates a synthetic binary ANLZ buffer simulating official Pioneer Rekordbox files
 * containing PCOB (Memory Cues), PWV5 (Waveform analysis), and PQTZ (Beatgrid).
 */
export function generateSyntheticAnlzBuffer(bpm: number = 128.0): ArrayBuffer {
  // PCOB chunk (cues) + PQTZ (beatgrid) + PWV5 (waveform)
  const buffer = new ArrayBuffer(2048);
  const view = new DataView(buffer);
  let offset = 0;

  // 1. Tag 'PCOB'
  // Header: 4 bytes tag + 4 bytes chunkSize + 4 bytes count
  const pcobSize = 12 + 4 * 24; // 108 bytes
  view.setUint8(offset++, 80); // P
  view.setUint8(offset++, 67); // C
  view.setUint8(offset++, 79); // O
  view.setUint8(offset++, 66); // B
  view.setUint32(offset, pcobSize, false); // chunkSize (big endian)
  offset += 4;
  view.setUint32(offset, 4, false); // cueCount = 4
  offset += 4;

  for (let c = 0; c < 4; c++) {
    const cueMs = Math.round(c * (60000 / bpm) * 8); // every 8 beats
    view.setUint8(offset, 1); // type = 1 (Memory Cue)
    view.setInt8(offset + 1, -1); // cueNum = -1
    view.setUint16(offset + 2, 0, false);
    view.setUint32(offset + 4, cueMs, false); // timeMs
    view.setUint8(offset + 8, 255); // Red
    view.setUint8(offset + 9, 34); // Green
    view.setUint8(offset + 10, 34); // Blue
    offset += 24;
  }

  // 2. Tag 'PQTZ' (Quantize / Beatgrid)
  const pqtzSize = 32;
  view.setUint8(offset++, 80); // P
  view.setUint8(offset++, 81); // Q
  view.setUint8(offset++, 84); // T
  view.setUint8(offset++, 90); // Z
  view.setUint32(offset, pqtzSize, false);
  offset += 4;
  view.setUint16(offset, Math.round(bpm * 100), false); // BPM * 100
  offset += 2;
  view.setUint32(offset, 0, false); // firstBeatOffset = 0
  offset += 22; // Pad to pqtzSize

  // 3. Tag 'PWV5' (Waveform preview)
  const sampleEntries = 100;
  const pwvSize = 12 + sampleEntries * 3;
  view.setUint8(offset++, 80); // P
  view.setUint8(offset++, 87); // W
  view.setUint8(offset++, 86); // V
  view.setUint8(offset++, 53); // 5
  view.setUint32(offset, pwvSize, false);
  offset += 4;
  view.setUint32(offset, sampleEntries, false);
  offset += 4;

  for (let w = 0; w < sampleEntries; w++) {
    const low = Math.floor(120 + 80 * Math.sin(w * 0.2));
    const mid = Math.floor(100 + 70 * Math.cos(w * 0.3));
    const high = Math.floor(80 + 50 * Math.sin(w * 0.4));
    view.setUint8(offset++, low);
    view.setUint8(offset++, mid);
    view.setUint8(offset++, high);
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Real-layout ANLZ fixture builders (Deep Symmetry documented byte layouts)
// ---------------------------------------------------------------------------

type AnlzTag = { tag: string; lenHeader: number; body: number[] };

class AnlzByteWriter {
  bytes: number[] = [];

  u8(value: number) {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number) {
    this.bytes.push((value >> 8) & 0xff, value & 0xff);
    return this;
  }
  u32(value: number) {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    );
    return this;
  }
  u32s(value: number) {
    return this.u32(value);
  }
  ascii(text: string) {
    for (const ch of text) this.bytes.push(ch.charCodeAt(0));
    return this;
  }
  zeros(count: number) {
    for (let i = 0; i < count; i++) this.bytes.push(0);
    return this;
  }
  utf16Be(text: string, nulTerminated = true) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      this.bytes.push((code >> 8) & 0xff, code & 0xff);
    }
    if (nulTerminated) this.bytes.push(0, 0);
    return this;
  }
  concat(values: number[]) {
    this.bytes.push(...values);
    return this;
  }
  get body() {
    return this.bytes;
  }
}

function encodeTag(writer: AnlzByteWriter, tag: string, header: number, body: number[]): void {
  writer.ascii(tag).u32(header).u32(12 + body.length).concat(body);
}

function encodePcptEntry(timeMs: number, opts: { hotCue: number; loop?: number; orderFirst?: number; orderLast?: number } = {
  hotCue: 0,
}): number[] {
  const w = new AnlzByteWriter();
  const isLoop = opts.loop !== undefined;
  w.ascii('PCPT')
    .u32(0x1c)
    .u32(0x38)
    .u32(opts.hotCue)
    .u32(0)
    .u32(0x10000)
    .u16(opts.orderFirst ?? 0xffff)
    .u16(opts.orderLast ?? 0xffff)
    .u8(isLoop ? 2 : 1)
    .u8(0x00)
    .u8(0x03)
    .u8(0xe8)
    .u32(timeMs)
    .u32(isLoop ? (opts.loop as number) : 0)
    .zeros(16);
  return w.body;
}

function encodePcp2Entry(
  timeMs: number,
  opts: {
    hotCue: number;
    type?: 1 | 2;
    loop?: number;
    colorId?: number;
    comment?: string;
    colorCode?: number;
    colorRgb?: [number, number, number];
    loopNumerator?: number;
    loopDenominator?: number;
  }
): number[] {
  const w = new AnlzByteWriter();
  const comment = opts.comment ?? '';
  const commentBytes = comment.length > 0 ? comment.length * 2 + 2 : 0;
  const hasColor = opts.colorRgb !== undefined || opts.colorCode !== undefined;

  // Fixed header + fixed fields (0x28 bytes) + comment length + comment + color.
  const lenEntry = 0x28 + 4 + commentBytes + (hasColor ? 4 : 0);

  w.ascii('PCP2')
    .u32(0x0a)
    .u32(lenEntry)
    .u32(opts.hotCue)
    .u8(opts.type ?? 1)
    .u8(0x00)
    .u8(0x03)
    .u8(0xe8)
    .u32(timeMs)
    .u32(opts.loop ?? 0)
    .u8(opts.colorId ?? 0)
    .u8(0x01)
    .zeros(6)
    .u16(opts.loopNumerator ?? 0)
    .u16(opts.loopDenominator ?? 0)
    .u32(commentBytes);
  if (commentBytes > 0) w.utf16Be(comment);
  if (hasColor) {
    w.u8(opts.colorCode ?? 0);
    const rgb = opts.colorRgb ?? [0, 0, 0];
    w.u8(rgb[0]).u8(rgb[1]).u8(rgb[2]);
  }
  return w.body;
}

function encodePcob(type: 0 | 1, entries: number[][]): AnlzTag {
  const w = new AnlzByteWriter();
  w.u32(type).u16(0).u16(entries.length).u32(0);
  entries.forEach((entry) => w.concat(entry));
  return { tag: 'PCOB', lenHeader: 0x18, body: w.body };
}

function encodePco2(type: 0 | 1, entries: number[][]): AnlzTag {
  const w = new AnlzByteWriter();
  w.u32(type).u16(entries.length).u16(0);
  entries.forEach((entry) => w.concat(entry));
  return { tag: 'PCO2', lenHeader: 0x0e, body: w.body };
}

function encodePqtz(bpm: number, firstBeatMs: number, beats: { beatInBar: number; tempo: number; timeMs: number }[]): AnlzTag {
  const w = new AnlzByteWriter();
  w.u32(0).u32(0x80000).u32(beats.length);
  beats.forEach((b) => w.u16(b.beatInBar).u16(b.tempo).u32(b.timeMs));
  return { tag: 'PQTZ', lenHeader: 0x18, body: w.body };
}

function encodePpth(path: string): AnlzTag {
  const w = new AnlzByteWriter();
  const len = path.length * 2 + 2;
  w.u32(len).utf16Be(path);
  return { tag: 'PPTH', lenHeader: 0x10, body: w.body };
}

function encodePwv5(count: number): AnlzTag {
  const w = new AnlzByteWriter();
  w.u32(2).u32(count).u32(0x00960305);
  for (let i = 0; i < count; i++) {
    // 3-bit R, 3-bit G, 3-bit B + 5-bit height + 2 unused bits.
    const height = Math.min(31, 8 + Math.floor(20 * Math.abs(Math.sin(i * 0.15))));
    const value = (0x50 << 11) | (0x30 << 8) | (0x20 << 5) | height;
    w.u16(value);
  }
  return { tag: 'PWV5', lenHeader: 0x18, body: w.body };
}

function encodePssiPhrase(opts: {
  index: number;
  beat: number;
  kind: number;
  k1?: number;
  k2?: number;
  k3?: number;
  b?: number;
  beats?: number[];
  fill?: number;
  beatFill?: number;
}): number[] {
  const w = new AnlzByteWriter();
  w.u16(opts.index)
    .u16(opts.beat)
    .u16(opts.kind)
    .u8(0)
    .u8(opts.k1 ?? 0)
    .u8(0)
    .u8(opts.k2 ?? 0)
    .u8(0)
    .u8(opts.b ?? 0)
    .u16(opts.beats?.[0] ?? 0)
    .u16(opts.beats?.[1] ?? 0)
    .u16(opts.beats?.[2] ?? 0)
    .u8(0)
    .u8(opts.k3 ?? 0)
    .u8(0)
    .u8(opts.fill ?? 0)
    .u16(opts.beatFill ?? 0);
  return w.body;
}

const PSSI_MASK_BASE = [
  0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2,
  0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1,
];

function encodePssi(
  mood: number,
  endBeat: number,
  entries: number[][],
  opts: { masked?: boolean; bank?: number } = {}
): AnlzTag {
  const body = new AnlzByteWriter();
  body.u32(24).u16(entries.length);

  const payload = new AnlzByteWriter();
  payload.u16(mood).zeros(6).u16(endBeat).zeros(2).u8(opts.bank ?? 0).zeros(1);
  entries.forEach((e) => payload.concat(e));

  const payloadBytes = payload.body;
  if (opts.masked) {
    for (let i = 0; i < payloadBytes.length; i++) {
      payloadBytes[i] ^= (PSSI_MASK_BASE[i % PSSI_MASK_BASE.length] + entries.length) & 0xff;
    }
  }
  body.concat(payloadBytes);

  return { tag: 'PSSI', lenHeader: 0x14, body: body.body };
}

function assembleAnlzFile(tags: AnlzTag[]): ArrayBuffer {
  const headerLen = 0x1c;
  const sectionsSize = tags.reduce((sum, t) => sum + 12 + t.body.length, 0);
  const writer = new AnlzByteWriter();
  writer.ascii('PMAI').u32(headerLen).u32(headerLen + sectionsSize).u32(1).u32(0x10000).u32(0x10000).u32(0);
  tags.forEach((t) => encodeTag(writer, t.tag, t.lenHeader, t.body));
  const bytes = Uint8Array.from(writer.body);
  return bytes.buffer;
}

function standardBeatGrid(bpm: number, firstBeatMs: number, beatCount: number) {
  const beats: { beatInBar: number; tempo: number; timeMs: number }[] = [];
  for (let i = 0; i < beatCount; i++) {
    beats.push({
      beatInBar: (i % 4) + 1,
      tempo: Math.round(bpm * 100),
      timeMs: firstBeatMs + Math.round((60000 / bpm) * i),
    });
  }
  return beats;
}

/**
 * .DAT fixture with the real PMAI/PPTH/PQTZ/PCOB/PWV5 layouts: two memory
 * points + one loop, one hot cue and a 4-beat beat grid.
 */
export function generateRealAnlzDatFixture(bpm: number = 128.0): ArrayBuffer {
  const spbMs = Math.round(60000 / bpm);
  const tags: AnlzTag[] = [
    encodePpth('C:\\Music\\Reference.wav'),
    encodePqtz(bpm, 0, standardBeatGrid(bpm, 0, 32)),
    encodePcob(0, [
      encodePcptEntry(0, { hotCue: 0, orderFirst: 0xffff, orderLast: 1 }),
      encodePcptEntry(8 * spbMs, { hotCue: 0, orderFirst: 0, orderLast: 2 }),
      encodePcptEntry(16 * spbMs, { hotCue: 0, orderFirst: 1, orderLast: 0xffff }),
      encodePcptEntry(4 * spbMs, { hotCue: 0, loop: 12 * spbMs, orderFirst: 2, orderLast: 3 }),
    ]),
    encodePcob(1, [
      encodePcptEntry(16 * spbMs, { hotCue: 1, orderFirst: 0xffff, orderLast: 0xffff }),
    ]),
    encodePwv5(600),
  ];
  return assembleAnlzFile(tags);
}

/**
 * .EXT fixture with PCO2 extended cues (comments + colors), PWV3/PWV7 and
 * PSSI song structure (optionally in the masked Rekordbox 6 export encoding).
 */
export function generateRealAnlzExtFixture(
  bpm: number = 128.0,
  opts: { maskPssi?: boolean } = {}
): ArrayBuffer {
  const spbMs = Math.round(60000 / bpm);
  const tags: AnlzTag[] = [
    encodePpth('C:\\Music\\Reference.wav'),
    encodePqtz(bpm, 0, standardBeatGrid(bpm, 0, 128)),
    encodePcob(0, [
      encodePcptEntry(0, { hotCue: 0, orderFirst: 0xffff, orderLast: 0xffff }),
    ]),
    encodePco2(1, [
      encodePcp2Entry(0, { hotCue: 1, comment: 'Einsatz A', colorCode: 3, colorRgb: [0, 162, 255] }),
      encodePcp2Entry(8 * spbMs, { hotCue: 2, comment: 'Drop', colorCode: 5, colorRgb: [255, 80, 80] }),
      encodePcp2Entry(32 * spbMs, { hotCue: 3, colorCode: 9, colorRgb: [0, 230, 118] }),
    ]),
    encodePco2(0, [
      encodePcp2Entry(16 * spbMs, { hotCue: 0, comment: 'Breakdown Memory' }),
    ]),
    {
      tag: 'PWV3',
      lenHeader: 0x18,
      body: (() => {
        const w = new AnlzByteWriter();
        w.u32(1).u32(900).u32(0x00960000);
        for (let i = 0; i < 900; i++) w.u8(10 + Math.floor(20 * Math.abs(Math.sin(i * 0.1))));
        return w.body;
      })(),
    },
    {
      tag: 'PWV7',
      lenHeader: 0x18,
      body: (() => {
        const w = new AnlzByteWriter();
        w.u32(3).u32(900).u32(0x00960000);
        for (let i = 0; i < 900; i++) {
          w.u8(20 + Math.floor(60 * Math.abs(Math.sin(i * 0.07))));
          w.u8(15 + Math.floor(50 * Math.abs(Math.cos(i * 0.09))));
          w.u8(10 + Math.floor(40 * Math.abs(Math.sin(i * 0.05))));
        }
        return w.body;
      })(),
    },
    encodePssi(
      1,
      65,
      [
        encodePssiPhrase({ index: 1, beat: 1, kind: 1, k1: 1 }),
        encodePssiPhrase({ index: 2, beat: 17, kind: 2, k2: 0, k3: 1 }),
        encodePssiPhrase({ index: 3, beat: 33, kind: 5, k1: 1 }),
        encodePssiPhrase({ index: 4, beat: 65, kind: 6, k1: 1 }),
      ],
      { masked: opts.maskPssi ?? true, bank: 3 }
    ),
  ];
  return assembleAnlzFile(tags);
}

/** Ein Schlag aus der PQTZ-Schlagliste (Zeit in Millisekunden, Tempo ×100). */
export interface AnlzBeatEntry {
  beatInBar: number;
  tempo: number;
  timeMs: number;
}

/**
 * ANLZ-Datei mit frei vorgegebener Schlagliste und einer Dreier-PWV7-Kurve.
 * Gebaut für die Frage „kommt der importierte Beat bitgenau an?“ – die Zeiten
 * dürfen auch ungleichmäßig stehen (Tempo-Änderung im Stück), so wie Rekordbox
 * es in echten Dateien tut.
 */
export function generateAnlzWithBeatTimes(beats: AnlzBeatEntry[], bpm: number): ArrayBuffer {
  const tags: AnlzTag[] = [
    encodePpth('C:\\Music\\Tempowechsel.wav'),
    encodePqtz(bpm, beats.length > 0 ? beats[0].timeMs : 0, beats),
    {
      tag: 'PWV7',
      lenHeader: 0x18,
      body: (() => {
        const w = new AnlzByteWriter();
        w.u32(3).u32(600).u32(0x00960000);
        for (let i = 0; i < 600; i++) {
          w.u8(30 + Math.floor(50 * Math.abs(Math.sin(i * 0.07))));
          w.u8(60 + Math.floor(40 * Math.abs(Math.cos(i * 0.09))));
          w.u8(90 + Math.floor(30 * Math.abs(Math.sin(i * 0.05))));
        }
        return w.body;
      })(),
    },
  ];
  return assembleAnlzFile(tags);
}

/**
 * ANLZ-Datei mit Wellenform aus genau einer Lage (PWAV, 5 Bit): low = mid = high
 * = peak. Das ist der reale Fall „Auflösung ja, aber kein Farb-Bild“.
 */
export function generateAnlzMonoWaveform(beatCount: number, bpm: number = 128.0): ArrayBuffer {
  const count = 400;
  const tags: AnlzTag[] = [
    encodePpth('C:\\Music\\NurEineLage.wav'),
    encodePqtz(bpm, 0, standardBeatGrid(bpm, 0, Math.max(4, beatCount))),
    {
      tag: 'PWAV',
      lenHeader: 0x14,
      body: (() => {
        const w = new AnlzByteWriter();
        w.u32(count).u32(0x10000);
        for (let i = 0; i < count; i++) w.u8(8 + (i % 24));
        return w.body;
      })(),
    },
  ];
  return assembleAnlzFile(tags);
}
