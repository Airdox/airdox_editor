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
