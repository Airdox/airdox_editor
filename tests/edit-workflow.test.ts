/**
 * @license
 * Nachweis-Suite für den realen Schneide-Workflow
 *
 * Szenario (wie bestellt): eine gut selbst generierte Demospur importieren, die
 * ersten vier Einheiten ans Ende kopieren, in der nächsten Version die letzten
 * vier Einheiten an den Taktanfang setzen, danach in der Mitte vier Einheiten
 * entfernen – und die Ergebnisse als WAV-Dateien speichern. Das Gleiche wird mit
 * vier Beats (1 Takt) und vier Takten (16 Beats) durchgerechnet.
 *
 * Getestet wird dasselbe Modul, das die Werkzeugleiste aufruft (src/audio/editOps).
 * Zusätzlich werden die Beweise auf Platte geschrieben und danach mit dem
 * WAV-Decoder zurückgelesen.
 *
 * Ausführen: npx tsx tests/edit-workflow.test.ts
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { generateDemoTrack, dominantBarTone } from '../src/audio/demoTrack';
import {
  PcmAudio,
  pcmDuration,
  pcmRangesEqual,
  pcmRms,
  pcmSampleCount,
} from '../src/audio/pcm';
import { decodeWav, encodeWav } from '../src/audio/wav';
import {
  beatTime,
  copyRange,
  copyRangeToEnd,
  cutRange,
  insertClipAt,
  moveRangeToStart,
  overdubRange,
  pasteAt,
  removeRange,
  replaceRange,
  secondsPerBeat,
  silenceRange,
  EditableAudio,
} from '../src/audio/editOps';
import { analyzePcm, extractMiniPeaksPcm } from '../src/waveform/analyzer';
import { DataOrigin, CuePoint, LoopPoint } from '../src/types/rekordbox';

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
    results.push({ suite, name, passed: true, durationMs: Math.round((performance.now() - t0) * 100) / 100 });
  } catch (err: any) {
    results.push({
      suite,
      name,
      passed: false,
      error: err?.message ?? String(err),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });
  }
}

// ── Aufbau ──────────────────────────────────────────────────────────────────

const BPM = 128;
const SAMPLE_RATE = 24000; // 1 Beat = 11250 Samples – ganzzahlig, exakte Schnitte
const BARS = 8;
const SPB = secondsPerBeat({ firstBeat: 0, bpm: BPM, meter: 4, beats: [], origin: DataOrigin.PROJECT });
const BEAT_SAMPLES = Math.round(SPB * SAMPLE_RATE);

const demo = generateDemoTrack({ bars: BARS, bpm: BPM, sampleRate: SAMPLE_RATE });
const beatSamples = (beats: number) => Math.round(beats * SPB * SAMPLE_RATE);

function makeCues(bars: number[]): CuePoint[] {
  return bars.map((bar, i) => {
    const position = bar * 4 * SPB;
    return {
      id: `cue-${i}`,
      name: `MEM ${i + 1}`,
      type: 'MEMORY' as const,
      position,
      inMsec: Math.round(position * 1000),
      cueIndex: i + 1,
      barNumber: bar + 1,
      beatNumber: 1,
      color: '#ff2222',
      origin: DataOrigin.REKORDBOX_XML,
    };
  });
}

function baseTrack(): EditableAudio {
  const duration = pcmDuration(demo.pcm);
  return {
    audio: demo.pcm,
    cues: makeCues([0, 1, 2, 3, 4, 5, 6, 7]),
    loops: [
      { id: 'loop-inside', name: 'Loop A', start: 2 * 4 * SPB, end: 3 * 4 * SPB, length: 4 * SPB, color: '#00a2ff', origin: DataOrigin.REKORDBOX_XML },
      { id: 'loop-wide', name: 'Loop B', start: 1 * 4 * SPB, end: 6 * 4 * SPB, length: 5 * 4 * SPB, color: '#00a2ff', origin: DataOrigin.REKORDBOX_XML },
    ],
    beatGrid: {
      firstBeat: 0,
      bpm: BPM,
      meter: 4,
      origin: DataOrigin.REKORDBOX_XML,
      beats: Array.from({ length: Math.ceil(duration / SPB) + 1 }, (_, i) => ({
        index: i,
        time: i * SPB,
        isBarStart: i % 4 === 0,
        barNumber: Math.floor(i / 4) + 1,
        beatInBar: (i % 4) + 1,
      })),
    },
  };
}

const ONE_BAR_SAMPLES = 4 * BEAT_SAMPLES;

/**
 * Erkennt pro Takt den dominierenden Identifikationston. Die resultierende Folge
 * ist die semantische Kontrolle: „Takt 3 steht jetzt an Position 5“, unabhängig
 * von Samplezahlen.
 */
function toneSequence(pcm: PcmAudio): number[] {
  const bars = Math.floor(pcmSampleCount(pcm) / ONE_BAR_SAMPLES);
  return Array.from({ length: bars }, (_, bar) => {
    const found = dominantBarTone(pcm, bar * ONE_BAR_SAMPLES, (bar + 1) * ONE_BAR_SAMPLES, demo.barFrequencies);
    if (found.strength < found.secondStrength * 1.4) {
      throw new Error(
        `Takt ${bar + 1} nicht sicher erkennbar (Ton ${found.index}, ${found.strength} gegen ${found.secondStrength})`
      );
    }
    return found.index;
  });
}

function digest(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ARTIFACT_DIR = path.join(process.cwd(), 'tests', 'artifacts', 'edit-workflow');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

interface ProofEntry {
  file: string;
  label: string;
  samples: number;
  durationSec: number;
  bytes: number;
  sha256: string;
  rms: number;
}

const proofs: ProofEntry[] = [];

function writeProof(pcm: PcmAudio, file: string, label: string): ProofEntry {
  const wav = encodeWav(pcm);
  const filePath = path.join(ARTIFACT_DIR, file);
  fs.writeFileSync(filePath, Buffer.from(wav));
  const entry: ProofEntry = {
    file,
    label,
    samples: pcmSampleCount(pcm),
    durationSec: Math.round(pcmDuration(pcm) * 1e6) / 1e6,
    bytes: wav.length,
    sha256: digest(Buffer.from(wav)),
    rms: Math.round(pcmRms(pcm) * 1e6) / 1e6,
  };
  proofs.push(entry);
  return entry;
}

// ── 1. Grundlagen ───────────────────────────────────────────────────────────

runTest('Demospur', 'Takt- und Beatlänge gehen samplegenau auf', () => {
  if (BEAT_SAMPLES !== 11250) throw new Error(`Beatlänge ${BEAT_SAMPLES} statt 11250 Samples`);
  const total = pcmSampleCount(demo.pcm);
  if (total !== BARS * 4 * BEAT_SAMPLES) {
    throw new Error(`Spur ist ${total} Samples lang, erwartet ${BARS * 4 * BEAT_SAMPLES}`);
  }
  if (demo.pcm.channels.length !== 2) throw new Error('Demospur muss Stereo sein');
  if (demo.bars !== BARS || demo.bpm !== BPM) throw new Error('Demospur ignoriert die Parameter');
  const rms = pcmRms(demo.pcm);
  if (rms < 0.05 || rms > 0.9) throw new Error(`Demospur klingt unplausibel (RMS ${rms})`);
});

runTest('Demospur', 'jeder Takt ist anhand seines Identifikationstons unterscheidbar', () => {
  for (let bar = 0; bar < BARS; bar++) {
    const a = bar * 4 * BEAT_SAMPLES;
    const b = a + 4 * BEAT_SAMPLES;
    const found = dominantBarTone(demo.pcm, a, b, demo.barFrequencies);
    if (found.index !== bar) {
      throw new Error(`Takt ${bar + 1}: Ton ${found.index} erkannt (Stärke ${found.strength} vs ${found.secondStrength})`);
    }
  }
});

runTest('WAV-Codec', 'Encode → Decode erhält die Samples innerhalb 16-Bit-Auflösung', () => {
  const wav = encodeWav(demo.pcm);
  if (wav.length !== 44 + pcmSampleCount(demo.pcm) * 4) {
    throw new Error(`WAV-Headergröße passt nicht: ${wav.length}`);
  }
  const { pcm, bitDepth, warnings } = decodeWav(wav);
  if (bitDepth !== 16) throw new Error(`Bittiefe ${bitDepth} statt 16`);
  if (warnings.length > 0) throw new Error(`unerwartete Warnungen: ${warnings.join(', ')}`);
  if (pcmSampleCount(pcm) !== pcmSampleCount(demo.pcm)) throw new Error('Samplezahl changed beim Rundlauf');
  let maxDiff = 0;
  for (let ch = 0; ch < 2; ch++) {
    const a = demo.pcm.channels[ch];
    const b = pcm.channels[ch];
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  }
  if (maxDiff > 1 / 32768 + 1e-6) throw new Error(`Quantisierungsfehler zu groß: ${maxDiff}`);
});

runTest('Analyse', 'Wellenform-Peaks folgen den Schnitten (stummer Bereich = keine Peaks)', () => {
  const silenced = silenceRange(baseTrack(), 4 * SPB, 5 * SPB);
  const before = analyzePcm(demo.pcm, DataOrigin.PROJECT);
  const after = analyzePcm(silenced.target.audio, DataOrigin.PROJECT);
  if (after.length === 0 || before.length === 0) throw new Error('keine Peaks berechnet');
  const buckets = after.length;
  const startBucket = Math.ceil(((4 * SPB) / pcmDuration(demo.pcm)) * buckets) + 2;
  const endBucket = Math.floor(((5 * SPB) / pcmDuration(demo.pcm)) * buckets) - 2;
  if (endBucket <= startBucket) throw new Error('Bucket-Auflösung zu grob für die Kontrolle');
  let maxInRange = 0;
  for (let i = startBucket; i < endBucket; i++) {
    maxInRange = Math.max(maxInRange, after.peaks[i] ?? 0);
  }
  if (maxInRange > 0.05) throw new Error(`stummer Bereich zeigt Peaks ${maxInRange}`);
  const peaks = extractMiniPeaksPcm(silenced.target.audio, 64);
  if (peaks.length !== 64) throw new Error('Mini-Peaks für die Palette falsche Länge');
});

// ── 2. Der bestellte Workflow, zwei Auflösungen ────────────────────────────

interface ScenarioResult {
  v1: ProofEntry;
  v2: ProofEntry;
  v3: ProofEntry;
  base: ProofEntry;
  cueReport: string;
  checks: string[];
}

function runScenario(unitLabel: string, beatsPerUnit: number, filePrefix: string): ScenarioResult {
  const unitBeats = beatsPerUnit; // 4 Beats oder 4 Takte (=16 Beats)
  const unitSec = unitBeats * SPB;
  const base = baseTrack();
  const baseSamples = pcmSampleCount(base.audio);
  const baseCues = base.cues.map((c) => c.position);

  // (0) Ausgangsdatei als Referenz
  const baseProof = writeProof(base.audio, `${filePrefix}-0-ausgang.wav`, `Ausgangsspur (${BARS} Takte)`);

  // (1) ersten Block ans Ende kopieren
  const copyStart = 0;
  const copyEnd = unitSec;
  const step1 = copyRangeToEnd(base, copyStart, copyEnd, { alignToBar: true });
  const v1Samples = pcmSampleCount(step1.target.audio);

  if (step1.report.padSamples !== 0) {
    throw new Error(`Auffüllung erwartet 0, weil die Spur takteilig ist (bekamen ${step1.report.padSamples})`);
  }
  if (v1Samples !== baseSamples + beatSamples(unitBeats)) {
    throw new Error(`Länge nach Copy: ${v1Samples}, erwartet ${baseSamples + beatSamples(unitBeats)}`);
  }
  // Der angehängte Block ist samplegenau der Anfangsblock
  if (
    !pcmRangesEqual(
      step1.target.audio,
      baseSamples,
      base.audio,
      0,
      beatSamples(unitBeats)
    )
  ) {
    throw new Error('Der angehängte Block ist nicht identisch mit dem Ursprungsblock');
  }
  // nichts anderes wurde verändert
  if (!pcmRangesEqual(step1.target.audio, 0, base.audio, 0, baseSamples)) {
    throw new Error('Kopieren hat den vorhandenen Inhalt verändert');
  }
  // Marker bleiben unverändert, Beatgrid wächst
  if (JSON.stringify(step1.target.cues.map((c) => c.position)) !== JSON.stringify(baseCues)) {
    throw new Error('Copy ans Ende darf Marker nicht verschieben');
  }
  const gridAfterCopy = step1.target.beatGrid.beats;
  if (gridAfterCopy.length < Math.floor(pcmDuration(step1.target.audio) / SPB)) {
    throw new Error('Beatgrid deckt die verlängerte Spur nicht ab');
  }
  const appendedOnBarLine = (baseSamples % (4 * BEAT_SAMPLES)) === 0;
  if (!appendedOnBarLine) throw new Error('angehängter Block startet nicht auf einer Taktlinie');
  // Semantische Kontrolle: die Taktfolge ist die alte plus die kopierten Takte
  const baseTones = toneSequence(base.audio);
  const v1Tones = toneSequence(step1.target.audio);
  const copiedTones = baseTones.slice(0, unitBeats / 4);
  if (JSON.stringify(v1Tones) !== JSON.stringify([...baseTones, ...copiedTones])) {
    throw new Error(
      `Taktfolge nach Copy: ${v1Tones.join(',')} – erwartet ${[...baseTones, ...copiedTones].join(',')}`
    );
  }

  const v1Proof = writeProof(step1.target.audio, `${filePrefix}-1-ans-ende.wav`, `Version 1: Anfangsblock (${unitLabel}) ans Ende kopiert`);

  // (2) in einer neuen Version: den letzten Block an den Taktanfang setzen
  const v1Duration = pcmDuration(step1.target.audio);
  const moveFrom = v1Duration - unitSec;
  const step2 = moveRangeToStart(step1.target, moveFrom, v1Duration, { atSec: step1.target.beatGrid.firstBeat });
  const v2Samples = pcmSampleCount(step2.target.audio);
  if (v2Samples !== v1Samples) {
    throw new Error(`Verschieben ändert die Länge (${v1Samples} → ${v2Samples})`);
  }
  // Am Anfang liegt jetzt exakt der previously letzte Block
  if (!pcmRangesEqual(step2.target.audio, 0, step1.target.audio, baseSamples, beatSamples(unitBeats))) {
    throw new Error('Der an den Anfang gesetzte Block ist nicht der alte Endblock');
  }
  // Der Rest rückt um genau einen Block nach rechts, das Material hinter dem
  // alten Block (hier: nichts) bleibt – Kontrolle über alle Takte nach dem Kopf
  if (
    !pcmRangesEqual(
      step2.target.audio,
      beatSamples(unitBeats),
      step1.target.audio,
      0,
      baseSamples
    )
  ) {
    throw new Error('Material vor dem verschobenen Block wurde nicht korrekt nach rechts geschoben');
  }
  // Jeder Marker wandert genau einen Block nach rechts (sie alle liegen davor)
  const movedCuePositions = step2.target.cues.map((c) => c.position);
  const expectedCuePositions = baseCues.map((p) => p + unitSec);
  if (JSON.stringify(movedCuePositions) !== JSON.stringify(expectedCuePositions)) {
    throw new Error(
      `Marker nach Verschieben: ${movedCuePositions.map((v) => v.toFixed(4)).join(',')} statt ` +
        expectedCuePositions.map((v) => v.toFixed(4)).join(',')
    );
  }
  // Verschieben = Rotation der Taktfolge, sonst nichts
  const v2Tones = toneSequence(step2.target.audio);
  const tailCount = unitBeats / 4;
  const rotatedTones = [...v1Tones.slice(v1Tones.length - tailCount), ...v1Tones.slice(0, v1Tones.length - tailCount)];
  if (JSON.stringify(v2Tones) !== JSON.stringify(rotatedTones)) {
    throw new Error(`Taktfolge nach Move: ${v2Tones.join(',')} – erwartet ${rotatedTones.join(',')}`);
  }
  if (v2Tones.length !== v1Tones.length) {
    throw new Error(`Verschieben darf keine Takte erzeugen oder kosten (${v1Tones.length} → ${v2Tones.length})`);
  }

  const v2Proof = writeProof(step2.target.audio, `${filePrefix}-2-an-den-anfang.wav`, `Version 2: letzter Block (${unitLabel}) an den Taktanfang`);

  // (3) in der Mitte vier Einheiten rausnehmen
  const v2Duration = pcmDuration(step2.target.audio);
  const middleStartBeat = Math.floor((v2Duration / SPB) / 2 / unitBeats) * unitBeats;
  const cutStart = beatTime(step2.target.beatGrid, middleStartBeat);
  const cutEnd = beatTime(step2.target.beatGrid, middleStartBeat + unitBeats);
  const sampleAtCut = Math.floor(cutStart * SAMPLE_RATE);
  const sampleAfterCut = Math.floor(cutEnd * SAMPLE_RATE);

  const cuesBeforeCut = step2.target.cues.map((c) => c.position);
  const step3 = removeRange(step2.target, cutStart, cutEnd);
  const v3Samples = pcmSampleCount(step3.target.audio);
  if (v3Samples !== v2Samples - beatSamples(unitBeats)) {
    throw new Error(`Nach Entfernen: ${v3Samples} Samples, erwartet ${v2Samples - beatSamples(unitBeats)}`);
  }
  // Nahtstelle: links unverändert, rechts das, was nach demremoved Block kam
  if (!pcmRangesEqual(step3.target.audio, 0, step2.target.audio, 0, sampleAtCut)) {
    throw new Error('Material vor dem Schnitt wurde verändert');
  }
  if (
    sampleAfterCut < pcmSampleCount(step2.target.audio) &&
    !pcmRangesEqual(
      step3.target.audio,
      sampleAtCut,
      step2.target.audio,
      sampleAfterCut,
      pcmSampleCount(step2.target.audio) - sampleAfterCut
    )
  ) {
    throw new Error('Material nach dem Schnitt wurde nicht sauber nachgezogen');
  }
  // Marker: innerhalb entfernt, danach nachgezogen
  const inside = cuesBeforeCut.filter((p) => p >= cutStart && p < cutEnd).length;
  const after = cuesBeforeCut.filter((p) => p >= cutEnd).length;
  if (step3.report.removedCues !== inside) throw new Error(`${inside} Marker im Bereich, gemeldet ${step3.report.removedCues}`);
  if (step3.report.shiftedCues !== after) throw new Error(`${after} Marker danach, gemeldet ${step3.report.shiftedCues}`);
  if (step3.target.cues.length !== cuesBeforeCut.length - inside) {
    throw new Error('Anzahl Marker nach Schnitt stimmt nicht');
  }
  // Nachgezogene Marker: exakt unitSec weiter links als vorher
  const shiftedBefore = cuesBeforeCut.filter((p) => p >= cutEnd).map((p) => p - unitSec);
  const shiftedAfter = step3.target.cues.filter((c) => c.position >= cutStart - 1e-9).map((c) => c.position);
  if (JSON.stringify(shiftedAfter) !== JSON.stringify(shiftedBefore)) {
    throw new Error(
      `Nachgezogene Marker: ${shiftedAfter.map((v) => v.toFixed(4)).join(',')} statt ${shiftedBefore.map((v) => v.toFixed(4)).join(',')}`
    );
  }
  // Loops: Ripple-Verhalten im Detail geprüft (jeder Loop muss das erwarten,
  // was seine Lage zum Schnitt hergibt)
  const preLoops = step2.target.loops;
  if (preLoops.length === 0) throw new Error('Testspur hat keine Loops – Prüfung wirkungslos');
  for (const before of preLoops) {
    const after = step3.target.loops.find((l) => l.id === before.id);
    if (before.end <= cutStart) {
      if (!after || Math.abs(after.start - before.start) > 1e-9 || Math.abs(after.end - before.end) > 1e-9) {
        throw new Error(`Loop ${before.id} liegt ganz vor dem Schnitt und muss unverändert bleiben`);
      }
    } else if (before.start >= cutEnd) {
      if (!after || Math.abs(before.start - after.start - unitSec) > 1e-9 || Math.abs(before.end - after.end - unitSec) > 1e-9) {
        throw new Error(`Loop ${before.id} liegt nach dem Schnitt und muss um ${unitSec.toFixed(4)} s nach links`);
      }
    } else if (before.start < cutStart && before.end > cutEnd) {
      if (!after || Math.abs(after.start - before.start) > 1e-9 || Math.abs(before.end - after.end - unitSec) > 1e-6) {
        throw new Error(`Loop ${before.id} umspannt den Schnitt: nur die Schnittlänge darf fehlen`);
      }
    } else if (before.start < cutStart) {
      if (!after || Math.abs(after.end - cutStart) > 1e-9) {
        throw new Error(`Loop ${before.id} endet im Schnitt: er muss an der Nahtstelle geklemmt werden`);
      }
    } else if (before.end > cutEnd) {
      if (!after || Math.abs(after.start - cutStart) > 1e-9) {
        throw new Error(`Loop ${before.id} beginnt im Schnitt: sein Anfang muss auf die Nahtstelle rücken`);
      }
    } else if (after) {
      throw new Error(`Loop ${before.id} lag vollständig im Schnitt und muss entfernt sein`);
    }
  }

  // Inhaltlich: die Taktfolge ist die alte ohne die entfernten Takte, die
  // nachfolgenden Takte rücken exakt eine Einheit nach links
  const v3Tones = toneSequence(step3.target.audio);
  const barAtCut = Math.round(cutStart / (ONE_BAR_SAMPLES / SAMPLE_RATE));
  const removedCount = unitBeats / 4;
  const expectedTones = [...v2Tones.slice(0, barAtCut), ...v2Tones.slice(barAtCut + removedCount)];
  if (JSON.stringify(v3Tones) !== JSON.stringify(expectedTones)) {
    throw new Error(
      `Taktfolge nach Entfernen: ${v3Tones.join(',')} – erwartet ${expectedTones.join(',')} ` +
      `(Schnitt an Taktindex ${barAtCut}, ${removedCount} Takte)`
    );
  }
  if (v3Tones.length + removedCount !== v2Tones.length) {
    throw new Error(`Erwartet ${v2Tones.length - removedCount} Takte, bekommen ${v3Tones.length}`);
  }

  const v3Proof = writeProof(step3.target.audio, `${filePrefix}-3-mitte-raus.wav`, `Version 3: mittlere ${unitLabel} entfernt`);

  return {
    base: baseProof,
    v1: v1Proof,
    v2: v2Proof,
    v3: v3Proof,
    cueReport: `${cuesBeforeCut.length} Marker vorher → ${step3.target.cues.length} nachher (${inside} im Schnitt entfernt, ${after} nachgezogen)`,
    checks: [
      `Einheit = ${unitLabel} = ${unitBeats} Beats = ${unitSec.toFixed(4)} s`,
      `Samples: ${baseSamples} → ${v1Samples} → ${v2Samples} → ${v3Samples}`,
      `Beatgrid-Beats nach V3: ${step3.target.beatGrid.beats.length}, Dauer ${pcmDuration(step3.target.audio).toFixed(4)} s`,
      step3.report.description,
    ],
  };
}

let scenarioBeats: ScenarioResult | null = null;
let scenarioBars: ScenarioResult | null = null;

runTest('Workflow 4 Beats', 'Anfang ans Ende, dann ans Anfang, dann Mitte raus', () => {
  scenarioBeats = runScenario('4 Beats', 4, 'nachweis-4beats');
});

runTest('Workflow 4 Takte', 'Anfang ans Ende, dann ans Anfang, dann Mitte raus', () => {
  scenarioBars = runScenario('4 Takte', 16, 'nachweis-4takten');
});

runTest('Gegenprobe', 'bei 4 Takten heben sich die drei Schritte exakt auf', () => {
  if (!scenarioBars) throw new Error('Szenario lief nicht');
  // Kopie der ersten vier Takte ans Ende, diese Kopie an den Anfang, dann die
  // alten vier Takte in der Mitte raus – das muss bytegenau die Ausgangsspur sein.
  if (scenarioBars.base.sha256 !== scenarioBars.v3.sha256) {
    throw new Error('Version 3 ist nicht identisch mit der Ausgangsspur');
  }
  if (scenarioBars.v1.sha256 === scenarioBars.v2.sha256) {
    throw new Error('Version 1 und 2 dürfen nicht dasselbe sein (Copy vs. Move)');
  }
});

// ── 3. Ausschneiden ↔ Einschneiden, Palette, Ersetzen, Overdub ──────────────

runTest('Zwischenablage', 'Ausschneiden und am selben Platz einschneiden stellt den Originalzustand her', () => {
  const base = baseTrack();
  const from = 2 * 4 * SPB;
  const to = 2 * 4 * SPB + 2 * SPB; // zwei Beats mitten raus
  const cut = cutRange(base, from, to);
  const cutSamples = Math.floor(to * SAMPLE_RATE) - Math.floor(from * SAMPLE_RATE);
  if (pcmSampleCount(cut.target.audio) !== pcmSampleCount(base.audio) - cutSamples) {
    throw new Error('Ausschnitt verkürzt die Spur nicht um die Schnittlänge');
  }
  if (pcmSampleCount(cut.clip) !== cutSamples) {
    throw new Error('Der Cut-Clip enthält nicht genau den ausgeschnittenen Block');
  }
  const pasted = insertClipAt(cut.target, from, cut.clip);
  if (pasted.report.addedSamples !== cutSamples) {
    throw new Error(`Einschneiden meldet ${pasted.report.addedSamples} eingefügte Samples`);
  }
  if (pcmSampleCount(pasted.target.audio) !== pcmSampleCount(base.audio)) {
    throw new Error('Rückweg hat die ursprüngliche Länge nicht wiederhergestellt');
  }
  for (let ch = 0; ch < base.audio.channels.length; ch++) {
    const a = pasted.target.audio.channels[ch];
    const b = base.audio.channels[ch];
    for (let i = 0; i < b.length; i++) {
      if (a[i] !== b[i]) throw new Error(`Sample ${i} in Kanal ${ch} weicht nach Cut+Insert ab`);
    }
  }
});

runTest('Palette', 'Auswahl → Clip → in andere Spur einfügen (samplegenau, mit Marker-Shift)', () => {
  const base = baseTrack();
  const clip = copyRange(base, 3 * 4 * SPB, 3 * 4 * SPB + 4 * SPB); // ein Takt
  const peaks = extractMiniPeaksPcm(clip, 48);
  if (peaks.length !== 48 || peaks.every((p) => p === 0)) throw new Error('Palette-Vorschau liefert keine Peaks');

  const other = generateDemoTrack({ bars: 4, bpm: BPM, sampleRate: SAMPLE_RATE });
  const otherTarget: EditableAudio = { audio: other.pcm, cues: makeCues([0, 1, 2]), loops: [] as LoopPoint[], beatGrid: base.beatGrid };
  const otherCueCount = otherTarget.cues.length;
  const insertAt = 1 * 4 * SPB;
  const inserted = insertClipAt(otherTarget, insertAt, clip);

  if (pcmSampleCount(inserted.target.audio) !== pcmSampleCount(other.pcm) + pcmSampleCount(clip)) {
    throw new Error('Einfügen hat die Länge nicht um den Clip verlängert');
  }
  if (!pcmRangesEqual(inserted.target.audio, Math.floor(insertAt * SAMPLE_RATE), clip, 0, pcmSampleCount(clip))) {
    throw new Error('Der eingefügte Clip liegt nicht samplegenau an der Zielposition');
  }
  const shiftedCue = inserted.target.cues.find((c) => c.barNumber === 2);
  if (!shiftedCue || Math.abs(shiftedCue.position - (insertAt + pcmDuration(clip))) > 1e-6) {
    throw new Error(`Marker hinter dem Einschub wurde nicht verschoben (${inserted.report.shiftedCues} gemeldet)`);
  }
  if (inserted.target.cues.length !== otherCueCount) throw new Error('Einfügen darf keine Marker löschen');
});

runTest('Ersetzen und Overdub', 'Replace überschreibt genau den Bereich, Overdub bleibt im Pegel', () => {
  const base = baseTrack();
  const clip = copyRange(base, 5 * 4 * SPB, 5 * 4 * SPB + 2 * SPB); // kürzer als der Zielbereich
  const startSec = 1 * 4 * SPB;
  const endSec = startSec + 4 * SPB; // vier Beats Zielbereich
  const replaced = replaceRange(base, startSec, endSec, clip);

  if (pcmSampleCount(replaced.target.audio) !== pcmSampleCount(base.audio)) {
    throw new Error('Ersetzen darf die Spurlänge nicht ändern');
  }
  if (!pcmRangesEqual(replaced.target.audio, Math.floor(startSec * SAMPLE_RATE), clip, 0, pcmSampleCount(clip))) {
    throw new Error('Clip liegt nicht exakt im ersetzten Bereich');
  }
  const restStart = Math.floor((startSec * SAMPLE_RATE) + pcmSampleCount(clip));
  const restEnd = Math.floor(endSec * SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch++) {
    const data = replaced.target.audio.channels[ch];
    for (let i = restStart; i < restEnd; i++) {
      if (data[i] !== 0) throw new Error('Rest des Bereichs ist nach dem Ersetzen nicht still');
    }
  }

  const overdubbed = overdubRange(base, startSec, endSec, clip, 0.85);
  for (const ch of overdubbed.target.audio.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) > 1.0001) throw new Error(`Overdub clippt bei Sample ${i}: ${ch[i]}`);
    }
  }
  if (pcmSampleCount(overdubbed.target.audio) !== pcmSampleCount(base.audio)) {
    throw new Error('Overdub darf die Länge nicht ändern');
  }
});

runTest('Nicht-destruktiv', 'Eingehende Spur und Quell-WAV bleiben bytegenau unverändert', () => {
  const sourceFile = path.join(ARTIFACT_DIR, 'quelle-original.wav');
  const wav = encodeWav(demo.pcm);
  fs.writeFileSync(sourceFile, Buffer.from(wav));
  const before = digest(fs.readFileSync(sourceFile));
  const snapshot = Float32Array.from(demo.pcm.channels[0].subarray(0, 100000));

  const track = baseTrack();
  const a = copyRangeToEnd(track, 0, 2 * SPB);
  const b = removeRange(a.target, 1 * 4 * SPB, 2 * 4 * SPB);
  const c = moveRangeToStart(b.target, 0, 1 * SPB);
  for (const outcome of [a, b, c]) {
    if (outcome.target.audio === demo.pcm) throw new Error('Operation hat das Objekt zurückgegeben statt zu kopieren');
  }
  for (let i = 0; i < snapshot.length; i++) {
    if (demo.pcm.channels[0][i] !== snapshot[i]) throw new Error(`Demospur wurde bei Sample ${i} verändert`);
  }
  const after = digest(fs.readFileSync(sourceFile));
  fs.unlinkSync(sourceFile);
  if (before !== after) throw new Error('Quelldatei auf der Platte wurde verändert');
});

runTest('Beweisdateien', 'alle Versionsdateien lassen sich zurücklesen und stimmen mit den Arbeitsdaten', () => {
  if (proofs.length === 0) throw new Error('keine Beweise geschrieben');
  for (const proof of proofs) {
    const file = path.join(ARTIFACT_DIR, proof.file);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== proof.bytes) throw new Error(`${proof.file}: Größe weicht ab`);
    if (digest(bytes) !== proof.sha256) throw new Error(`${proof.file}: Prüfsumme weicht ab`);
    const { pcm } = decodeWav(bytes);
    if (pcmSampleCount(pcm) !== proof.samples) {
      throw new Error(`${proof.file}: ${pcmSampleCount(pcm)} Samples in der Datei, Protokoll sagt ${proof.samples}`);
    }
    if (Math.abs(pcmDuration(pcm) - proof.durationSec) > 1e-4) throw new Error(`${proof.file}: Dauer passt nicht`);
  }
});

// ── 4. NACHWEIS.md ─────────────────────────────────────────────────────────

runTest('Nachweis', 'NACHWEIS.md wird mit allen Kennzahlen geschrieben', () => {
  const lines: string[] = [];
  lines.push('# Nachweis: Schneide-Workflow der App');
  lines.push('');
  lines.push(
    `Demospur: ${BARS} Takte, ${BPM} BPM, ${SAMPLE_RATE} Hz, Stereo, Beat = ${SPB.toFixed(6)} s ` +
      `= ${BEAT_SAMPLES} Samples (ganzzahlig → exakte Schnitte).`
  );
  lines.push('');
  lines.push('Erzeugt mit `npx tsx tests/edit-workflow.test.ts` (Generator ist deterministisch,');
  lines.push('die Prüfsummen sind bei jedem Lauf identisch). Dieselben Funktionen wie die');
  lines.push('Werkzeugleiste: `src/audio/editOps.ts`.');
  lines.push('');
  lines.push('| Datei | Bedeutung | Samples | Dauer | Bytes | SHA-256 |');
  lines.push('| --- | --- | ---: | ---: | ---: | --- |');
  for (const p of proofs) {
    lines.push(
      `| \`${p.file}\` | ${p.label} | ${p.samples} | ${p.durationSec.toFixed(3)} s | ${p.bytes} | \`${p.sha256.slice(0, 16)}…\` |`
    );
  }
  lines.push('');
  const fullHashes = proofs.map((p) => `- \`${p.file}\` → \`${p.sha256}\``);
  lines.push('## Vollständige Prüfsummen');
  lines.push('');
  lines.push(...fullHashes);
  lines.push('');
  if (scenarioBeats) {
    lines.push('## Ablauf mit 4 Beats');
    lines.push('');
    lines.push(...scenarioBeats.checks.map((c) => `- ${c}`));
    lines.push(`- ${scenarioBeats.cueReport}`);
    lines.push('');
  }
  if (scenarioBars) {
    lines.push('## Ablauf mit 4 Takten');
    lines.push('');
    lines.push(...scenarioBars.checks.map((c) => `- ${c}`));
    lines.push(`- ${scenarioBars.cueReport}`);
    lines.push('');
  }
  lines.push('Die WAVs sind Beweise, keine Datenbestände: sie lassen sich mit dem Test jederzeit');
  lines.push('neu erzeugen und können gelöscht werden.');
  lines.push('');
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'NACHWEIS.md'), lines.join('\n'), 'utf-8');
  const written = fs.readFileSync(path.join(ARTIFACT_DIR, 'NACHWEIS.md'), 'utf-8');
  for (const p of proofs) {
    if (!written.includes(p.file)) throw new Error(`${p.file} fehlt im Nachweis`);
  }
});

// ── Auswertung ──────────────────────────────────────────────────────────────

let passedCount = 0;
let failedCount = 0;
console.log('\n═══ Schneide-Workflow: Nachweis-Suite ═══\n');
results.forEach((r) => {
  const mark = r.passed ? '✓' : '✗';
  console.log(`${mark} [${r.suite}] ${r.name} (${r.durationMs} ms)`);
  if (!r.passed) {
    console.log(`    Fehler: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});

console.log('');
for (const p of proofs) {
  console.log(`  Beweis: ${path.join('tests/artifacts/edit-workflow', p.file)} – ${p.samples} Samples, ${p.durationSec.toFixed(3)} s`);
}
console.log('');
console.log('───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) process.exit(1);
process.exit(0);
