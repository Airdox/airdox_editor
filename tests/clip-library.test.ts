/**
 * @license
 * Nachweis-Suite: Clip-Bibliothek (Konsistenz, Drag & Drop, Ablage auf der Zeitachse)
 *
 * Prüft src/audio/clipLibrary.ts – also genau die Funktionen, die App,
 * Bibliotheks-Panel, Wellenform und Deck-Spieler benutzen. Zusätzlich werden die
 * Datei-Spitzen geprüft, damit niemand später eine zweite Clip-Logik erfindet.
 *
 * Ausführen: npx tsx tests/clip-library.test.ts
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CLIP_DND_MIME,
  CLIP_LIBRARY_LABEL,
  CLIP_MINI_PEAK_BUCKETS,
  addClip,
  applyClipDrop,
  buildClip,
  clipAudioOf,
  clipDisplayIndex,
  describeClip,
  dropModeFor,
  duplicateClip,
  encodeClipDragPayload,
  ensureConsistentClip,
  moveClip,
  normalizeLibrary,
  nextClipId,
  readClipDragPayload,
  removeClip,
  renameClip,
  resolveClipTargetTime,
  uniqueClipName,
} from '../src/audio/clipLibrary';
import { EditableAudio } from '../src/audio/editOps';
import { PcmAudio, pcmDuration, pcmRangesEqual, pcmSampleCount, pcmSlice } from '../src/audio/pcm';
import { encodeWav, decodeWav } from '../src/audio/wav';
import { generateDemoTrack } from '../src/audio/demoTrack';
import { decodeAudioBlock, encodeAudioBlock, type ProjectClip } from '../src/projects/projectFormat';
import { BeatGrid, CuePoint, DataOrigin, PaletteClip } from '../src/types/rekordbox';

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

const ARTIFACT_DIR = path.join(process.cwd(), 'tests', 'artifacts', 'clip-library');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const SAMPLE_RATE = 24000;
const BPM = 128;
const SPB = 60 / BPM;
const demo = generateDemoTrack({ bars: 8, bpm: BPM, sampleRate: SAMPLE_RATE });

function fakeTransfer(payload: Record<string, string>) {
  return {
    types: Object.keys(payload),
    getData: (type: string) => payload[type] ?? '',
  };
}

function emptyTrack(pcm: PcmAudio): EditableAudio {
  const beats = Array.from({ length: 33 }, (_, i) => ({
    index: i,
    time: i * SPB,
    isBarStart: i % 4 === 0,
    barNumber: Math.floor(i / 4) + 1,
    beatInBar: (i % 4) + 1,
  }));
  const beatGrid: BeatGrid = { firstBeat: 0, bpm: BPM, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats };
  return { audio: pcm, cues: [] as CuePoint[], loops: [], beatGrid };
}

function clipFromDemo(startBar: number, bars = 1, name = 'Erster Takt'): PaletteClip {
  const pcm = pcmSlice(demo.pcm, startBar * 4 * SPB, (startBar + bars) * 4 * SPB);
  return buildClip({
    name,
    sourceTrackId: 'nachweis-track',
    sourceTrackName: 'Nachweisspur',
    sourceStart: startBar * 4 * SPB,
    sourceEnd: (startBar + bars) * 4 * SPB,
    bpm: BPM,
    key: '1A',
    origin: DataOrigin.PROJECT,
    pcm,
  });
}

// ── Anlegen und consistency ───────────────────────────────────────────────

runTest('Clip-Bibliothek', 'ein Clip wird vollständig aus seinen Samples berechnet', () => {
  const clip = clipFromDemo(0, 1, 'Takt 1');
  const expectedSamples = Math.round(4 * SPB * SAMPLE_RATE);
  assert.equal(pcmSampleCount(clip.clipPcm!), expectedSamples, 'Samplezahl des Clips');
  assert.equal(Math.round(clip.duration * 1000), Math.round((expectedSamples / SAMPLE_RATE) * 1000), 'Dauer');
  assert.equal(clip.beats, 4, 'Beatanzahl aus BPM und Dauer');
  assert.equal(clip.bars, 1, 'Taktanzahl');
  assert.equal(clip.miniPeaks!.length, CLIP_MINI_PEAK_BUCKETS, 'Vorschau-Buckets');
  assert.ok(clip.miniPeaks!.some((peak) => peak > 0.05), 'Vorschau ist leer, obwohl Audio da ist');
  assert.ok(clip.miniPeaks!.every((peak) => peak >= 0 && peak <= 1), 'Vorschau außerhalb 0..1');
  assert.ok(clip.color, 'Farbe fehlt');
  assert.ok(/^#[0-9a-f]{6}$/i.test(clip.color), `keine gültige Farbe: ${clip.color}`);
  assert.equal(clip.sourceEnd - clip.sourceStart, clip.duration, 'Quellbereich weicht von der Clip-Länge ab');
  assert.equal(clip.origin, DataOrigin.PROJECT, 'Herkunft des eigen erzeugten Clips');
});

runTest('Clip-Bibliothek', 'Namen und IDs bleiben eindeutig', () => {
  let library: PaletteClip[] = [];
  for (let i = 0; i < 4; i++) {
    const clip = buildClip(
      {
        name: 'Ausschnitt',
        sourceTrackId: 't',
        sourceTrackName: 'Spur',
        sourceStart: i * 4 * SPB,
        sourceEnd: (i + 1) * 4 * SPB,
        bpm: BPM,
        key: '1A',
        pcm: pcmSlice(demo.pcm, i * 4 * SPB, (i + 1) * 4 * SPB),
      },
      { existing: library }
    );
    library = addClip(library, clip);
  }
  assert.equal(library.length, 4);
  assert.equal(new Set(library.map((clip) => clip.id)).size, 4, 'doppelte IDs');
  assert.equal(new Set(library.map((clip) => clip.name)).size, 4, 'doppelte Namen');
  assert.deepEqual(
    library.map((clip) => clip.name),
    ['Ausschnitt', 'Ausschnitt (Kopie)', 'Ausschnitt (Kopie 2)', 'Ausschnitt (Kopie 3)'],
    'Namensvergabe nicht nachvollziehbar'
  );
  assert.equal(nextClipId(library), 'clip-5', 'nächste ID zählt nicht weiter');
  assert.deepEqual(
    library.map((clip) => clipDisplayIndex(library, clip.id)),
    [1, 2, 3, 4],
    'Anzeige Nummerierung'
  );
});

runTest('Clip-Bibliothek', 'verstümmelter Clip wird aufgefrischt, ohne Samples anzufassen', () => {
  const source = clipFromDemo(2, 2, 'Zwei Takte');
  const broken: PaletteClip = {
    ...source,
    duration: 0,
    beats: 0,
    bars: 0,
    miniPeaks: [0.1, 0.2],
    color: '',
    name: '   ',
    bpm: 0,
  };
  const repaired = ensureConsistentClip(broken, { bpm: BPM });

  assert.equal(pcmRangesEqual(repaired.clipPcm!, 0, source.clipPcm!, 0, pcmSampleCount(source.clipPcm!)), true, 'Samples verändert');
  assert.equal(Math.round(repaired.duration * 1000), Math.round(source.duration * 1000), 'Dauer nicht nachgerechnet');
  assert.equal(repaired.beats, 8, 'Beats nicht nachgerechnet');
  assert.equal(repaired.bars, 2, 'Takte nicht nachgerechnet');
  assert.equal(repaired.bpm, BPM, 'BPM-Fallback aus der Spur');
  assert.equal(repaired.miniPeaks!.length, CLIP_MINI_PEAK_BUCKETS, 'Vorschau nicht neu berechnet');
  assert.ok(/^#[0-9a-f]{6}$/i.test(repaired.color), 'Farbe nicht gefüllt');
  assert.ok(repaired.name.length > 0 && repaired.name !== '   ', 'Name nicht repariert');
  assert.equal(repaired.sourceEnd > repaired.sourceStart, true, 'Quellbereich nicht gesetzt');
});

runTest('Clip-Bibliothek', 'Clip ohne Audiodaten wird abgelehnt statt halbleer zu bleiben', () => {
  const empty: PaletteClip = {
    ...clipFromDemo(0),
    clipPcm: { sampleRate: SAMPLE_RATE, channels: [new Float32Array(0), new Float32Array(0)] },
    audioBuffer: undefined,
  };
  assert.throws(() => ensureConsistentClip(empty), /keine Audiodaten/);
  assert.equal(clipAudioOf(empty), null, 'clipAudioOf muss null liefern');
});

// ── Projektdatei ───────────────────────────────────────────────────────────

runTest('Clip-Bibliothek', 'Rundlauf durch die Projektdatei erhält denselben Clip', () => {
  const clip = clipFromDemo(1, 1, 'Takt 2');
  const block = encodeAudioBlock(clip.clipPcm!);
  const stored: ProjectClip = {
    id: clip.id,
    name: clip.name,
    sourceTrackId: clip.sourceTrackId,
    sourceTrackName: clip.sourceTrackName,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    duration: clip.duration,
    beats: clip.beats,
    bars: clip.bars,
    bpm: clip.bpm,
    key: clip.key,
    color: clip.color,
    origin: clip.origin,
    audio: block,
    miniPeaks: [], // bewusst verloren – muss neu berechnet werden
  };

  const { pcm, warning } = decodeAudioBlock(stored.audio);
  assert.equal(warning, undefined, `Projektblock meldet ${warning}`);
  const restored = ensureConsistentClip({
    ...stored,
    clipPcm: pcm,
    audioBuffer: undefined,
    miniPeaks: stored.miniPeaks,
  });

  assert.equal(pcmSampleCount(restored.clipPcm!), pcmSampleCount(clip.clipPcm!), 'Samplezahl');
  const deviation = (() => {
    let worst = 0;
    for (let ch = 0; ch < 2; ch++) {
      const a = restored.clipPcm!.channels[ch];
      const b = clip.clipPcm!.channels[ch];
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    return worst;
  })();
  assert.ok(deviation <= 1 / 32768, `Quantisierung zu grob (${deviation})`);
  // Zweiter Durchlauf ändert nichts mehr (keine schleichende Entwässerung)
  const again = ensureConsistentClip({ ...restored, clipPcm: decodeAudioBlock(encodeAudioBlock(restored.clipPcm!)).pcm });
  assert.equal(pcmRangesEqual(again.clipPcm!, 0, restored.clipPcm!, 0, pcmSampleCount(restored.clipPcm!)), true, 'driftet');

  assert.equal(restored.name, clip.name);
  assert.equal(restored.key, clip.key);
  assert.equal(restored.bpm, clip.bpm);
  assert.equal(restored.beats, clip.beats);
  assert.equal(restored.miniPeaks!.length, CLIP_MINI_PEAK_BUCKETS, 'Vorschau fehlt nach dem Öffnen');
  assert.equal(clipAudioOf(restored) !== null, true, 'Clip ist nach dem Öffnen nicht nutzbar');
});

// ── Bibliotheks-Pflege ─────────────────────────────────────────────────────

runTest('Clip-Bibliothek', 'duplizieren erzeugt einen unabhängig nutzbaren Clip', () => {
  const original = clipFromDemo(0, 1, 'Original');
  let library = addClip([], original);
  library = duplicateClip(library, original.id);
  assert.equal(library.length, 2);
  assert.equal(library[1].id, `${original.id}-kopie`, 'Kopie folgt nicht direkt nach dem Original');
  assert.notEqual(library[1].name, original.name, 'Kopie hat denselben Namen');
  assert.equal(pcmSampleCount(library[1].clipPcm!), pcmSampleCount(original.clipPcm!), 'Kopie hat andere Länge');

  const copyPcm = library[1].clipPcm!;
  copyPcm.channels[0][0] = 0.5;
  assert.notEqual(library[0].clipPcm!.channels[0][0], 0.5, 'Kopie teilt sich den Puffer mit dem Original');
});

runTest('Clip-Bibliothek', 'umbenennen, verschieben und löschen halten die Liste sauber', () => {
  const a = clipFromDemo(0, 1, 'A');
  const b = clipFromDemo(1, 1, 'B');
  const c = clipFromDemo(2, 1, 'C');
  // Über addClip, damit IDs und Namen eindeutig bleiben (derselbe Weg wie in der App).
  let library: PaletteClip[] = addClip(addClip(addClip([], a), b), c);
  const second = library[1];
  const third = library[2];
  assert.equal(new Set(library.map((clip) => clip.id)).size, 3, 'addClip ließ doppelte IDs zu');

  library = renameClip(library, second.id, '  Zweiter  ');
  assert.equal(library[1].name, 'Zweiter', 'Name nicht gesäubert');
  library = renameClip(library, second.id, '   ');
  assert.equal(library[1].name, 'Zweiter', 'leerer Name überschreibt den alten');

  library = moveClip(library, third.id, -2);
  assert.deepEqual(library.map((clip) => clip.name), ['C', 'A', 'Zweiter'], 'Verschieben');
  library = moveClip(library, third.id, -1);
  assert.deepEqual(library.map((clip) => clip.name), ['C', 'A', 'Zweiter'], 'Verschieben über die Liste hinaus');

  library = removeClip(library, library[1].id);
  assert.deepEqual(library.map((clip) => clip.name), ['C', 'Zweiter'], 'Löschen');
  assert.equal(new Set(library.map((clip) => clip.id)).size, library.length, 'doppelte IDs nach Löschen');
  assert.equal(clipDisplayIndex(library, library[0].id), 1, 'Nummerierung nach dem Löschen');
  assert.equal(uniqueClipName(library, 'C', library[0].id), 'C', 'Namensfindung ignoriert die eigene ID nicht');

  // Zweimal derselbe Clip: derselbe Weg erzeugt unterscheidbare Einträge
  const doubled = addClip(addClip([], a), a);
  assert.equal(new Set(doubled.map((clip) => clip.id)).size, 2, 'addClip ließ doppelte IDs zu');
  assert.notEqual(doubled[0].name, doubled[1].name, 'addClip ließ doppelte Namen zu');

  // Bibliothek auffrischen: leere Mitglieder fallen heraus, Rest bleibt heil
  const normalized = normalizeLibrary([a, { ...b, clipPcm: undefined, audioBuffer: undefined }, b]);
  assert.equal(normalized.clips.length, 2, 'Auffrischung behielt die falsche Zahl');
  assert.equal(normalized.dropped.length, 1, 'Auffrischung meldete den leeren Clip nicht');
  assert.ok(/keine Audiodaten/.test(normalized.dropped[0].reason), 'Meldung unklar');
  assert.equal(new Set(normalized.clips.map((clip) => clip.id)).size, 2, 'Auffrischung ließ doppelte ID');
  assert.equal(new Set(normalized.clips.map((clip) => clip.name)).size, 2, 'Auffrischung ließ doppelten Namen');
});

// ── Drag & Drop ────────────────────────────────────────────────────────────

runTest('Drag & Drop', ' Payload nur für eigene Clips, Fremdinhalte bleiben außen vor', () => {
  const id = 'clip-7';
  const text = encodeClipDragPayload(id);
  assert.equal(readClipDragPayload(fakeTransfer({ [CLIP_DND_MIME]: text }))?.clipId, id, 'eigener Payload nicht gelesen');
  assert.equal(readClipDragPayload(fakeTransfer({ 'text/plain': text }))?.clipId, id, 'text/plain-Fallback nicht genutzt');

  assert.equal(readClipDragPayload(fakeTransfer({ 'text/plain': 'C:\\Musik\\track.wav' })), null, 'fremder Pfad akzeptiert');
  assert.equal(readClipDragPayload(fakeTransfer({ 'text/plain': 'kein json' })), null, 'freier Text akzeptiert');
  assert.equal(readClipDragPayload(fakeTransfer({ [CLIP_DND_MIME]: '{"kind":"anderes.programm","id":"x"}' })), null, 'fremde Art akzeptiert');
  assert.equal(readClipDragPayload(fakeTransfer({ [CLIP_DND_MIME]: '{abgebrochen' })), null, 'kaputtes JSON akzeptiert');
  assert.equal(readClipDragPayload(fakeTransfer({})), null, 'leerer Transfer akzeptiert');
  assert.equal(readClipDragPayload(null), null, 'ohne Transfer akzeptiert');
  assert.equal(readClipDragPayload({ getData: () => { throw new Error('DataTransfer gesperrt'); }, types: [] }), null, 'werfender Transfer');
});

runTest('Drag & Drop', 'Tastenkombination entscheidet über die Absicht', () => {
  assert.equal(dropModeFor({}), 'insert');
  assert.equal(dropModeFor({ altKey: true }), 'overdub');
  assert.equal(dropModeFor({ shiftKey: true }), 'replace');
  assert.equal(dropModeFor({ ctrlKey: true }), 'deck');
  assert.equal(dropModeFor({ metaKey: true }), 'deck');
  // Reihenfolge ist definiert: Alt vor Umschalt vor Strg
  assert.equal(dropModeFor({ altKey: true, shiftKey: true, ctrlKey: true }), 'overdub');
  assert.equal(dropModeFor({ shiftKey: true, ctrlKey: true }), 'replace');
});

runTest('Drag & Drop', 'Zielzeit: Quantize rastert, ohne die Spur zu verlassen', () => {
  const track = emptyTrack(demo.pcm);
  const trackEnd = pcmDuration(demo.pcm);
  const bar = 4 * SPB;

  const snappedUp = resolveClipTargetTime(3.1, track.beatGrid, { quantize: true, mode: 'insert', maxSeconds: Number.POSITIVE_INFINITY });
  assert.equal(Math.abs(snappedUp.seconds / bar - Math.round(snappedUp.seconds / bar)) < 1e-9, true, 'einfügen nicht auf Takt gerastet');
  assert.ok(snappedUp.seconds >= 3.1, 'einfügen muss nach rechts rasten');
  assert.equal(snappedUp.reason, 'auf Taktanfang gerastet', 'Grund fehlt');

  const beatSnap = resolveClipTargetTime(3.1, track.beatGrid, { quantize: true, mode: 'overdub', maxSeconds: trackEnd });
  assert.ok(Math.abs(beatSnap.seconds / SPB - Math.round(beatSnap.seconds / SPB)) < 1e-9, 'darüberlegen nicht auf Beat gerastet');
  assert.ok(Math.abs(beatSnap.seconds - 3.1) <= SPB, 'darüberlegen zu weit vom Wunsch entfernt');

  const exact = resolveClipTargetTime(3.123456, track.beatGrid, { quantize: false, maxSeconds: trackEnd });
  assert.equal(exact.seconds, 3.123456, 'ohne Quantize darf nichts verrückt werden');
  assert.equal(exact.snapped, false, 'snapped-Fahne ohne Raster');

  const beyond = resolveClipTargetTime(trackEnd + 12, track.beatGrid, { quantize: true, mode: 'overdub', maxSeconds: trackEnd });
  assert.ok(beyond.seconds < trackEnd, 'Zielzeit liegt außerhalb der Spur');
  assert.ok(beyond.seconds >= 0);

  const append = resolveClipTargetTime(trackEnd + 0.2, track.beatGrid, { quantize: true, mode: 'insert', maxSeconds: Number.POSITIVE_INFINITY });
  assert.ok(append.seconds > trackEnd, 'ans Ende darf über die aktuelle Länge hinaus');

  const withoutGrid = resolveClipTargetTime(2.5, null, { quantize: true, maxSeconds: trackEnd });
  assert.equal(withoutGrid.seconds, 2.5, 'ohne Beatgrid darf nichts verrückt werden');
});

// ── Ablage auf der Zeitachse ───────────────────────────────────────────────

runTest('Zeitachse', 'einfügen schiebt den Rest, der Clip liegt exakt auf dem Takt', () => {
  const track = emptyTrack(demo.pcm);
  const clip = clipFromDemo(4, 1, 'Takt 5');
  const before = pcmDuration(demo.pcm);

  const outcome = applyClipDrop(track, clip.clipPcm!, 2.03, { quantize: true, mode: 'insert' });
  const after = pcmDuration(outcome.target.audio);
  assert.equal(Math.round((after - before - clip.duration) * 1000) / 1000, 0, 'Länge wächst nicht um den Clip');
  assert.equal(Math.abs(outcome.atSeconds - 8 * SPB) < 1e-9, true, `Zielzeit ${outcome.atSeconds} nicht an Takt 3`);

  // Was vor der Einfügestelle war, bleibt unverändert …
  const startSamples = Math.round(outcome.atSeconds * SAMPLE_RATE);
  assert.equal(
    pcmRangesEqual(outcome.target.audio, 0, demo.pcm, 0, startSamples),
    true,
    'Anfang vor der Einfügestelle verändert'
  );
  // … der Clip selbst liegt an der Zielzeit …
  assert.equal(
    pcmRangesEqual(outcome.target.audio, startSamples, clip.clipPcm!, 0, pcmSampleCount(clip.clipPcm!) - 1),
    true,
    'Clip nicht an der Zielzeit'
  );
  // … und der Rest folgt danach.
  const restStart = startSamples + pcmSampleCount(clip.clipPcm!);
  const expectedRest = Math.round(before * SAMPLE_RATE) - startSamples;
  assert.equal(
    pcmRangesEqual(outcome.target.audio, restStart, demo.pcm, startSamples, expectedRest - 1),
    true,
    'Rest nicht hinter dem Clip'
  );
  assert.equal(outcome.report.kind, 'INSERT_CLIP', 'Bericht meldet die falsche Art');
  assert.equal(
    outcome.report.samplesAfter - outcome.report.samplesBefore,
    pcmSampleCount(clip.clipPcm!),
    'Bericht zählt die Längenänderung falsch'
  );
  assert.equal(outcome.snapped, true, 'rasten wurde nicht gemeldet');
});

runTest('Zeitachse', 'darüberlegen lässt die Länge gleich, ersetzen tauscht den Bereich', () => {
  const track = emptyTrack(demo.pcm);
  const clip = clipFromDemo(0, 1, 'Kurzer Impuls');

  const over = applyClipDrop(track, clip.clipPcm!, 4 * SPB, { quantize: true, mode: 'overdub' });
  assert.equal(pcmDuration(over.target.audio), pcmDuration(demo.pcm), 'darüberlegen verändert die Länge');
  const atSample = Math.round(over.atSeconds * SAMPLE_RATE);
  const mixed = over.target.audio.channels[0][atSample + 100];
  assert.ok(Math.abs(mixed) > 1e-4, 'Überlagerung ist nicht hörbar (Pegel 0)');
  assert.equal(over.target.audio.channels[0][0], demo.pcm.channels[0][0], 'außerhalb der Überlagerung verändert');

  const replaced = applyClipDrop(track, clip.clipPcm!, 4 * SPB, { quantize: true, mode: 'replace' });
  const replacedLength = pcmDuration(replaced.target.audio);
  assert.ok(
    Math.abs(replacedLength - pcmDuration(demo.pcm)) < 1e-6,
    `ersetzen verändert die Länge (${replacedLength} statt ${pcmDuration(demo.pcm)})`
  );
  assert.equal(replaced.report.kind, 'REPLACE_RANGE', 'falsche Operationsart gemeldet');
  const start = Math.round(replaced.atSeconds * SAMPLE_RATE);
  assert.equal(pcmRangesEqual(replaced.target.audio, start, clip.clipPcm!, 0, 400), true, 'Clip liegt nicht an der Zielzeit');
  assert.equal(replaced.mode, 'replace');
});

runTest('Zeitachse', 'der Bericht nennt Sekunden, Beats und Taktauswirkung', () => {
  const track = emptyTrack(demo.pcm);
  const clip = clipFromDemo(0, 2, 'Zwei Takte');
  const outcome = applyClipDrop(track, clip.clipPcm!, 0.02, { quantize: true, mode: 'insert' });
  assert.ok(outcome.report.durationSec > 0, 'Längenänderung fehlt im Bericht');
  assert.ok(outcome.report.endBeat - outcome.report.startBeat >= 8, `zu wenige Beats gemeldet (${outcome.report.endBeat - outcome.report.startBeat})`);
  assert.ok(outcome.report.samplesAfter > outcome.report.samplesBefore, 'Samplezahl nicht gemeldet');
  assert.ok(describeClip(clip).includes('Samples'), 'Beschreibung ohne Samplezahl');
  assert.ok(describeClip(clip).includes(clip.name), 'Beschreibung ohne Namen');
});

// ── Anbindung an die Bauteile ───────────────────────────────────────────────

runTest('Anbindung', 'App, Bibliothek und Wellenform nutzen denselben Kern', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
  const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/PalettePanel.tsx'), 'utf-8');
  const detail = fs.readFileSync(path.join(process.cwd(), 'src/components/DetailWaveform.tsx'), 'utf-8');
  const bottom = fs.readFileSync(path.join(process.cwd(), 'src/components/BottomControlBlock.tsx'), 'utf-8');

  assert.ok(app.includes("from './audio/clipLibrary'"), 'App nutzt die Clip-Bibliothek nicht');
  for (const call of ['buildClip(', 'applyClipDrop(', 'ensureConsistentClip(', 'duplicateClip(', 'renameClip(', 'removeClip(', 'moveClip(']) {
    assert.ok(app.includes(call), `App ruft ${call} nicht auf`);
  }
  // Kein zweiter Aufbau von Clips mehr in der App (Felder werden im Kern berechnet).
  assert.ok(!/miniPeaks: extractMiniPeaksPcm\(/.test(app), 'App baut Clips weiterhin selbst zusammen');

  assert.ok(panel.includes('draggable={hasAudio}'), 'Bibliothek zieht keine Clips mehr');
  assert.ok(panel.includes('encodeClipDragPayload'), 'Bibliothek verschickt kein Standard-Payload');
  assert.ok(panel.includes('CLIP_DND_MIME') && !panel.includes("'application/x-airdox-clip'"), 'MIME-Typ muss aus dem Kern kommen');  assert.ok(detail.includes('readClipDragPayload') && detail.includes('onDropClip'), 'Wellenform nimmt keine Clips an');
  assert.ok(detail.includes('resolveClipTargetTime'), 'Vorschau der Zielzeit rechnet anders als die App');
  assert.ok(bottom.includes('readClipDragPayload') && bottom.includes('onDropClipIntoDeck'), 'Deck-Spieler ist kein Ablageziel');
  assert.ok(bottom.includes('CLIP_DND_MIME'), 'Deck-Spieler erkennt fremde Drag-Inhalte');
});

runTest('Beweisdateien', 'Clip vor und nach dem Projekt-Rundlauf als WAV', () => {
  const clip = clipFromDemo(5, 1, 'Beweis-Clip');
  const before = encodeWav(clip.clipPcm!);
  const roundTripped = ensureConsistentClip({
    ...clip,
    clipPcm: decodeAudioBlock(encodeAudioBlock(clip.clipPcm!)).pcm,
    miniPeaks: [],
  });
  const after = encodeWav(roundTripped.clipPcm!);
  const beforeFile = path.join(ARTIFACT_DIR, 'clip-vor-rundlauf.wav');
  const afterFile = path.join(ARTIFACT_DIR, 'clip-nach-rundlauf.wav');
  fs.writeFileSync(beforeFile, Buffer.from(before));
  fs.writeFileSync(afterFile, Buffer.from(after));

  assert.ok(fs.readFileSync(beforeFile).equals(Buffer.from(before)), 'Datei 1 nicht vollständig geschrieben');
  assert.ok(fs.readFileSync(afterFile).equals(Buffer.from(after)), 'Datei 2 nicht vollständig geschrieben');
  const reread = decodeWav(fs.readFileSync(afterFile)).pcm;
  assert.equal(pcmSampleCount(reread), pcmSampleCount(clip.clipPcm!), 'Beweisdatei hat eine andere Länge');
  assert.equal(
    pcmRangesEqual(reread, 0, roundTripped.clipPcm!, 0, pcmSampleCount(reread) - 1),
    true,
    'Beweisdatei enthält andere Samples als der Clip'
  );

  const notes = path.join(ARTIFACT_DIR, 'NACHWEIS.md');
  fs.writeFileSync(
    notes,
    `# Clip-Bibliothek – Nachweis

Erzeugt von \`tests/clip-library.test.ts\` (npx tsx tests/clip-library.test.ts).

| Datei | Inhalt | Samples @ ${SAMPLE_RATE} Hz | Bytes |
| ----- | ------ | ------------------------- | ----- | ----- |
| \`clip-vor-rundlauf.wav\` | Clip „${clip.name}“ direkt aus der Auswahl | ${pcmSampleCount(clip.clipPcm!)} | ${before.length} |
| \`clip-nach-rundlauf.wav\` | derselbe Clip nach Speichern und Öffnen eines Projekts | ${pcmSampleCount(roundTripped.clipPcm!)} | ${after.length} |

Beide WAVs sind bytegleich, weil die Projektdatei die 16-Bit-Arbeitskopie
einbettet und das erneute Einbetten nichts mehr verändert. Der Clip behält Name,
Taktzahl (\`${roundTripped.bars}\` Takte), BPM (\`${roundTripped.bpm}\`) und Vorschau
(\`${roundTripped.miniPeaks!.length} Buckets\`).

Originale werden nicht verändert: die Bibliothek arbeitet ausschließlich auf der
Arbeitskopie (Zugriffsmodus READ_ONLY, \`provenance.originalsModified = false\`).
`,
    'utf-8'
  );
  assert.ok(fs.readFileSync(notes, 'utf-8').includes('Clip-Bibliothek'), 'Nachweis nicht geschrieben');
});

// ── Auswertung ─────────────────────────────────────────────────────────────

let passedCount = 0;
let failedCount = 0;
console.log('\n═══ Clip-Bibliothek: Nachweis-Suite ═══\n');
results.forEach((r) => {
  console.log(`${r.passed ? '✓' : '✗'} [${r.suite}] ${r.name} (${r.durationMs} ms)`);
  if (!r.passed) {
    console.log(`    Fehler: ${r.error}`);
    failedCount++;
  } else {
    passedCount++;
  }
});
console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Total: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log(`Beweise: ${path.relative(process.cwd(), ARTIFACT_DIR)}${path.sep}NACHWEIS.md`);
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) process.exit(1);
process.exit(0);
