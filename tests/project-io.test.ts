/**
 * @license
 * Nachweis-Suite: Projektdatei (speichern ↔ öffnen) und Clipseitigkeit
 *
 * Prüft das Format von src/projects/projectFormat.ts – inklusive des Weges durch
 * die echten Dateien auf der Platte – und dass ein Projekt ohne die Originaldatei
 * wieder aufgeht (die Originale werden ja nie verändert und auch nicht benötigt).
 *
 * Ausführen: npx tsx tests/project-io.test.ts
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { generateDemoTrack } from '../src/audio/demoTrack';
import { copyRangeToEnd, removeRange, EditableAudio } from '../src/audio/editOps';
import { PcmAudio, pcmDuration, pcmRangesEqual, pcmSampleCount } from '../src/audio/pcm';
import { encodeWav } from '../src/audio/wav';
import { extractMiniPeaksPcm } from '../src/waveform/analyzer';
import {
  PROJECT_KIND,
  PROJECT_SCHEMA,
  audioBlockDuration,
  buildProjectFile,
  decodeAudioBlock,
  encodeAudioBlock,
  fnv1a64,
  parseProject,
  projectFileName,
  serializeProject,
  type ProjectTrack,
} from '../src/projects/projectFormat';
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

/**
 * Die Projektdatei bettet die Arbeitskopie als 16-Bit-WAV ein. Ein Rundlauf ist
 * deshalb bis auf ein halbes Quantisierungs-Step exakt – und danach stabil
 * (ein zweiter Rundlauf ändert nichts mehr), was hier ebenfalls geprüft wird.
 */
function maxDeviation(a: PcmAudio, b: PcmAudio): number {
  const n = Math.min(pcmSampleCount(a), pcmSampleCount(b));
  let worst = 0;
  for (let ch = 0; ch < Math.min(a.channels.length, b.channels.length); ch++) {
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a.channels[ch][i] - b.channels[ch][i]));
  }
  return worst;
}

const ARTIFACT_DIR = path.join(process.cwd(), 'tests', 'artifacts', 'edit-workflow');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const demo = generateDemoTrack({ bars: 8, bpm: 128, sampleRate: 24000 });
const SPB = 60 / 128;

function trackWithoutEdits(): EditableAudio {
  const cues: CuePoint[] = [0, 1, 2, 3, 4].map((bar, i) => ({
    id: `cue-${i}`,
    name: `MEM ${i + 1}`,
    type: 'MEMORY' as const,
    position: bar * 4 * SPB,
    inMsec: Math.round(bar * 4 * SPB * 1000),
    cueIndex: i + 1,
    barNumber: bar + 1,
    beatNumber: 1,
    color: '#ff2222',
    origin: DataOrigin.REKORDBOX_XML,
  }));
  const loops: LoopPoint[] = [
    {
      id: 'loop-1',
      name: 'Loop 1',
      start: 2 * 4 * SPB,
      end: 3 * 4 * SPB,
      length: 4 * SPB,
      color: '#00a2ff',
      origin: DataOrigin.REKORDBOX_XML,
    },
  ];
  const beats = Array.from({ length: 33 }, (_, i) => ({
    index: i,
    time: i * SPB,
    isBarStart: i % 4 === 0,
    barNumber: Math.floor(i / 4) + 1,
    beatInBar: (i % 4) + 1,
  }));
  return {
    audio: demo.pcm,
    cues,
    loops,
    beatGrid: { firstBeat: 0, bpm: 128, meter: 4, origin: DataOrigin.REKORDBOX_XML, beats },
  };
}

function projectFromTrack(track: EditableAudio, projectName: string) {
  const projectTrack: Omit<ProjectTrack, 'audio'> & { pcm: PcmAudio } = {
    id: 'nachweis-track',
    title: 'Nachweisspur',
    artist: 'Airdox Editor',
    album: 'Workflow-Beweis',
    key: '1A',
    bpm: 128,
    duration: Math.round(pcmDuration(track.audio) * 1e6) / 1e6,
    sampleRate: track.audio.sampleRate,
    channels: track.audio.channels.length,
    origin: DataOrigin.PROJECT,
    originalSha256: 'sha256-nachweis-0001',
    isOriginalUntouched: true,
    source: {
      location: 'file:///C:/Musik/Rekordbox/Nachweisspur.wav',
      accessMode: 'READ_ONLY',
      status: 'MISSING',
    },
    cues: track.cues,
    loops: track.loops,
    beatGrid: track.beatGrid,
    phrases: [],
    segments: [
      {
        id: 'seg-original',
        type: 'ORIGINAL',
        sourceStart: 0,
        sourceEnd: track.audio.channels[0].length / track.audio.sampleRate,
        projectStart: 0,
        projectDuration: track.audio.channels[0].length / track.audio.sampleRate,
        gain: 1,
      },
    ],
    pcm: track.audio,
  };

  return buildProjectFile({
    projectName,
    activeTrackId: 'nachweis-track',
    view: { waveformMode: 'AMBER', quantize: true, viewOffset: 4.5, viewDuration: 12, paletteOpen: false },
    tracks: [projectTrack],
    clips: [
      {
          id: 'clip-1',
          name: 'Erster Takt',
          sourceTrackId: 'nachweis-track',
          sourceTrackName: 'Nachweisspur',
          sourceStart: 0,
          sourceEnd: 4 * SPB,
          duration: 4 * SPB,
          beats: 4,
          bars: 1,
          bpm: 128,
          key: '1A',
          color: '#ff9500',
          origin: DataOrigin.PROJECT,
          miniPeaks: extractMiniPeaksPcm(demo.pcm, 48),
          pcm: {
            sampleRate: demo.pcm.sampleRate,
            channels: demo.pcm.channels.map((ch) => Float32Array.from(ch.subarray(0, Math.round(4 * SPB * 24000)))),
          },
      },
    ],
    app: { name: 'Airdox_intelligents_Editor', version: '0.1.0' },
  });
}

// ── Round-Trip ───────────────────────────────────────────────────────────

runTest('Projektdatei', 'ein Editierstand überlebt Speichern und Öffnen vollständig', () => {
  const base = trackWithoutEdits();
  const copied = copyRangeToEnd(base, 0, 4 * SPB, { alignToBar: true });
  const trimmed = removeRange(copied.target, 2 * 4 * SPB, 3 * 4 * SPB);

  const project = projectFromTrack(trimmed.target, 'Nachweis – drei Schritte');
  const text = serializeProject(project);
  const parsed = parseProject(text);
  assert.equal(parsed.errors.length, 0, `Fehler beim Lesen: ${parsed.errors.join(' | ')}`);
  const restored = parsed.project!;
  const track = restored.tracks[0];

  // Audiodaten: Samplezahl exakt, Werte innerhalb eines halben 16-Bit-Steps
  const { pcm } = decodeAudioBlock(track.audio);
  assert.equal(pcmSampleCount(pcm), pcmSampleCount(trimmed.target.audio), 'Samplezahl verändert');
  assert.equal(pcmRangesEqual(pcm, 0, pcm, 0, 1), true);
  const deviation = maxDeviation(pcm, trimmed.target.audio);
  assert.ok(deviation <= 1 / 32768, `Quantisierungsabweichung ${deviation} ist größer als ein LSB`);
  // Zweiter Rundlauf darf nichts mehr ändern (keine schleichende Entmischung)
  const again = decodeAudioBlock(encodeAudioBlock(pcm)).pcm;
  assert.equal(pcmRangesEqual(again, 0, pcm, 0, pcmSampleCount(pcm)), true, 'Zweiter Rundlauf verändert die Samples');

  // Marker, Loops, Beatgrid
  assert.deepEqual(track.cues, trimmed.target.cues, 'Marker unterscheiden sich');
  assert.deepEqual(track.loops, trimmed.target.loops, 'Loops unterscheiden sich');
  assert.equal(track.beatGrid.beats.length, trimmed.target.beatGrid.beats.length, 'Beatgrid-Länge');
  assert.equal(track.beatGrid.beats[7].time, trimmed.target.beatGrid.beats[7].time, 'Beatzeit 7');

  // Projektmeta
  assert.equal(restored.projectName, 'Nachweis – drei Schritte');
  assert.equal(restored.activeTrackId, 'nachweis-track');
  assert.equal(restored.view.waveformMode, 'AMBER');
  assert.equal(restored.view.viewOffset, 4.5);
  assert.equal(restored.view.paletteOpen, false);
  assert.equal(restored.app.name, 'Airdox_intelligents_Editor');
  assert.equal(restored.tracks.length, 1);
  assert.equal(restored.clips.length, 1);
  assert.equal(restored.clips[0].name, 'Erster Takt');
  assert.equal(restored.clips[0].miniPeaks.length, 48);

  // Clip-Audio independently erhalten
  const clipPcm = decodeAudioBlock(restored.clips[0].audio).pcm;
  assert.equal(maxDeviation(clipPcm, demo.pcm) <= 1 / 32768, true, 'Clip-Audio zu stark verändert');
  assert.equal(pcmSampleCount(clipPcm), Math.round(4 * SPB * 24000), 'Clip-Länge verändert');

  // Herkunft: Original nur referenziert, niemals ein Schreibziel
  assert.equal(track.source?.accessMode, 'READ_ONLY');
  assert.equal(track.isOriginalUntouched, true);
  assert.equal(restored.provenance.originalsModified, false);
});

runTest('Projektdatei', 'Selbstständigkeit: ohne Originaldatei öffnenbar', () => {
  const project = projectFromTrack(trackWithoutEdits(), 'Ohne Original');
  const text = serializeProject(project);
  // Es gibt keinen Pfad, den das Projekt zum Öffnen braucht – nur der Vermerk bleibt.
  assert.ok(!text.includes('"resolvedPath"'), 'Projekt erwartet einen aufgelösten Originalpfad');
  const parsed = parseProject(text);
  assert.equal(parsed.project?.tracks[0].source?.status, 'MISSING');
  const { pcm } = decodeAudioBlock(parsed.project!.tracks[0].audio);
  assert.ok(pcmSampleCount(pcm) > 0, 'Audio fehlt, obwohl es eingebettet ist');
});

runTest('Projektdatei', 'erneutes Speichern ergibt dieselbe Datei (bis auf den Zeitstempel)', () => {
  const project = projectFromTrack(trackWithoutEdits(), 'Stabil');
  const first = serializeProject(project);
  const parsed = parseProject(first);
  const reloaded = parsed.project!;
  const second = serializeProject(
    buildProjectFile({
      projectName: reloaded.projectName,
      activeTrackId: reloaded.activeTrackId,
      view: reloaded.view,
      tracks: reloaded.tracks.map((track) => ({
        ...track,
        pcm: decodeAudioBlock(track.audio).pcm,
      })),
      clips: reloaded.clips.map((clip) => ({
        ...clip,
        pcm: decodeAudioBlock(clip.audio).pcm,
      })),
      app: reloaded.app,
    })
  );
  // Gleiche Schlüsselreihenfolge zu verlangen wäre überflüssig – verglichen wird der
  // Inhalt: tiefengleich, und die eingebetteten Audiodaten Byte für Byte.
  const strip = (text: string) => {
    const value = JSON.parse(text);
    delete value.createdAt;
    return value;
  };
  assert.deepEqual(strip(second), strip(first), 'Zweiter Speichervorgang verändert den Inhalt');
  assert.equal(
    second.match(/"base64": "([^"]+)"/g)!.join('|'),
    first.match(/"base64": "([^"]+)"/g)!.join('|'),
    'Audiodaten driften beim erneuten Speichern'
  );
});

runTest('Projektdatei', 'Audio ist kompakt eingebettet und Prüfsumme deckt die Bytes', () => {
  const base = trackWithoutEdits();
  const block = encodeAudioBlock(base.audio);
  const wavBytes = encodeWav(base.audio);
  assert.equal(block.bytes, wavBytes.length);
  assert.equal(block.samples, pcmSampleCount(base.audio));
  assert.equal(block.encoding, 'wav16+base64');
  assert.equal(Math.round(audioBlockDuration(block) * 1000), Math.round(pcmDuration(base.audio) * 1000));
  assert.ok(block.base64.length > wavBytes.length, 'base64 muss größer sein als die Bytes');
  assert.ok(block.base64.length < Math.ceil((wavBytes.length * 4) / 3) + 8, 'base64 ist unnötig aufgebläht');
  assert.equal(block.checksum, fnv1a64(wavBytes), 'Prüfsumme passt nicht zu den WAV-Bytes');
});

// ── Validierung ──────────────────────────────────────────────────────────

runTest('Validierung', 'fremde und kaputte Dateien werden mit klarem Text abgelehnt', () => {
  const cases: Array<{ label: string; text: string; matches: RegExp }> = [
    { label: 'kein JSON', text: 'Audio? Nein.', matches: /Kein gültiges JSON/ },
    { label: 'JSON ohne Projektart', text: '{"a":1}', matches: /kein Airdox-Projekt/ },
    {
      label: 'fremde Projektart',
      text: JSON.stringify({ kind: 'ableton-set', schema: 1, tracks: [] }),
      matches: /kein Airdox-Projekt/,
    },
    {
      label: 'zukünftiges Schema',
      text: JSON.stringify({ kind: PROJECT_KIND, schema: PROJECT_SCHEMA + 3, tracks: [{ id: 'x' }] }),
      matches: /kann nicht gelesen werden/,
    },
    {
      label: 'ohne Spuren',
      text: JSON.stringify({ kind: PROJECT_KIND, schema: PROJECT_SCHEMA, tracks: [] }),
      matches: /keine Spuren/,
    },
    {
      label: 'Spur ohne Audio',
      text: JSON.stringify({ kind: PROJECT_KIND, schema: PROJECT_SCHEMA, tracks: [{ id: 'a', title: 'Ohne' }] }),
      matches: /eingebettete Audiodaten fehlen/,
    },
    {
      label: 'exaktes Schema',
      text: JSON.stringify({ kind: PROJECT_KIND, schema: PROJECT_SCHEMA, tracks: 5 }),
      matches: /keine Spuren/,
    },
    {
      label: 'gemeldete Originaländerung',
      text: (() => {
        const project = projectFromTrack(trackWithoutEdits(), 'Manipuliert');
        const text = serializeProject(project);
        return text.replace('"originalsModified": false', '"originalsModified": true');
      })(),
      matches: /veränderte Originale/,
    },
  ];

  for (const entry of cases) {
    const parsed = parseProject(entry.text);
    assert.equal(parsed.project, null, `${entry.label}: hätte abgelehnt werden müssen`);
    assert.ok(
      parsed.errors.some((message) => entry.matches.test(message)),
      `${entry.label}: unklare Fehlermeldung (${parsed.errors.join(' | ')})`
    );
  }
});

runTest('Validierung', 'unleserliches Audio schlägt sauber fehl statt still zu schweigen', () => {
  const project = projectFromTrack(trackWithoutEdits(), 'Defektes Audio');
  const text = serializeProject(project).replace(/"base64": "(.{20})/, '"base64": "!!!$1');
  const parsed = parseProject(text);
  assert.ok(parsed.project, `Datei wurde zu hart abgelehnt: ${parsed.errors.join(' | ')}`);
  assert.throws(() => decodeAudioBlock(parsed.project!.tracks[0].audio), /base64|WAV|Uint8Array|Invalid|gering|Failed/i);
});

runTest('Validierung', 'veränderte Audiodaten fallen durch die Prüfsumme auf', () => {
  const project = projectFromTrack(trackWithoutEdits(), 'Verändert');
  const block = project.tracks[0].audio;
  // Gleiche Samplezahl, anderer Inhalt – die eingebettete Prüfsumme muss es melden.
  const silence = encodeWav({
    sampleRate: block.sampleRate,
    channels: [new Float32Array(block.samples), new Float32Array(block.samples)],
  });
  const parsed = parseProject(serializeProject(project).replace(block.base64, Buffer.from(silence).toString('base64')));
  assert.ok(parsed.project, `zu hart abgelehnt: ${parsed.errors.join(' | ')}`);
  const { pcm, warning } = decodeAudioBlock(parsed.project!.tracks[0].audio);
  assert.ok(warning && /Prüfsumme/.test(warning), `keine Warnung trotz veränderter Bytes (${warning})`);
  assert.equal(pcmSampleCount(pcm), block.samples, 'Samplezahl sollte trotzdem lesbar bleiben');
});

runTest('Validierung', 'leeres Beatgrid führt zu Warnung und Neu­berechnung im Aufrufer', () => {
  const project = projectFromTrack(trackWithoutEdits(), 'Ohne Grid');
  project.tracks[0].beatGrid.beats = [];
  const parsed = parseProject(serializeProject(project));
  assert.equal(parsed.project !== null, true);
  assert.ok(parsed.warnings.some((note) => /Beatgrid/.test(note)), parsed.warnings.join(' | '));
});

// ── Dateinamen ───────────────────────────────────────────────────────────

runTest('Dateinamen', 'ungültige Zeichen und Dopplungen werden bereinigt', () => {
  assert.equal(projectFileName('Mein Projekt'), 'Mein Projekt.airdoxproj.json');
  assert.equal(projectFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j.airdoxproj.json');
  assert.equal(projectFileName('schon.airdoxproj.json'), 'schon.airdoxproj.json');
  assert.equal(projectFileName('   '), 'projekt.airdoxproj.json');
  assert.equal(projectFileName('leer ""'), 'leer _.airdoxproj.json');
  assert.ok(projectFileName('x'.repeat(400)).length <= 141, 'Namenslänge nicht begrenzt');
});

// ── Beweise auf der Platte ───────────────────────────────────────────────

runTest('Beweisdateien', 'Projektdatei wird geschrieben, zurückgelesen und im Nachweis vermerkt', () => {
  const base = trackWithoutEdits();
  const step1 = copyRangeToEnd(base, 0, 4 * SPB, { alignToBar: true });
  const step2 = removeRange(step1.target, 2 * 4 * SPB, 3 * 4 * SPB);
  const project = projectFromTrack(step2.target, 'Nachweis – Projekt');
  const text = serializeProject(project);

  // Der Zeitstempel wird für die Beweisdatei fixiert, damit ein Testlauf die
  // eingecheckte Datei nicht bei jedem Run verändert.
  const stamp = (value: string) => value.replace(/"createdAt": "[^"]*"/, '"createdAt": "ZEITSTEMPEL-FIXIERT"');
  const proofText = stamp(text);
  const file = path.join(ARTIFACT_DIR, 'nachweis-projekt.airdoxproj.json');
  fs.writeFileSync(file, proofText, 'utf-8');
  const onDisk = fs.readFileSync(file, 'utf-8');
  assert.equal(onDisk, proofText, 'Dateiinhalt weicht ab');
  assert.equal(stamp(onDisk), stamp(text), 'Beweisdatei weicht vom gespeicherten Inhalt ab');

  const parsed = parseProject(onDisk);
  assert.equal(parsed.errors.length, 0, parsed.errors.join(' | '));
  const { pcm } = decodeAudioBlock(parsed.project!.tracks[0].audio);
  assert.equal(pcmSampleCount(pcm), pcmSampleCount(step2.target.audio), 'Samplezahl auf der Platte falsch');
  assert.ok(maxDeviation(pcm, step2.target.audio) <= 1 / 32768, 'Audiodaten auf der Platte verfälscht');

  // WAV-Gegencheck: dieselbe Arbeitskopie als Tondatei neben dem Projekt
  const wavFile = path.join(ARTIFACT_DIR, 'nachweis-projekt-arbeitskopie.wav');
  const wavBytes = encodeWav(pcm);
  fs.writeFileSync(wavFile, Buffer.from(wavBytes));
  const sha = createHash('sha256').update(Buffer.from(wavBytes)).digest('hex');
  assert.equal(fs.statSync(wavFile).size, wavBytes.length);

  const manifest = path.join(ARTIFACT_DIR, 'NACHWEIS.md');
  if (fs.existsSync(manifest)) {
    const notes = fs.readFileSync(manifest, 'utf-8');
    const addendum = `## Projektdatei (Beweis)

- \`nachweis-projekt.airdoxproj.json\` – Schema ${PROJECT_SCHEMA}, Art „${PROJECT_KIND}",
  ${project.tracks.length} Spur, ${project.clips.length} Clip aus der Clip-Bibliothek, Arbeitskopie eingebettet
  (${parsed.project!.tracks[0].audio.samples} Samples @ ${parsed.project!.tracks[0].audio.sampleRate} Hz).
- \`nachweis-projekt-arbeitskopie.wav\` – dieselbe Arbeitskopie als Tondatei,
  SHA-256 \`${sha}\`.
- Die Datei enthält nur referenzierte, unveränderte Originale (accessMode READ_ONLY,
  Status MISSING) und lässt sich ohne sie öffnen.
`;
    if (!notes.includes('Projektdatei (Beweis)')) {
      fs.writeFileSync(manifest, notes.replace(/\nDie WAVs sind Beweise/, `\n${addendum}\nDie WAVs sind Beweise`), 'utf-8');
    }
  }
});

// ── Auswertung ─────────────────────────────────────────────────────────────

let passedCount = 0;
let failedCount = 0;
console.log('\n═══ Projektdatei: Nachweis-Suite ═══\n');
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
console.log('═══════════════════════════════════════════════════════════════════\n');

if (failedCount > 0) process.exit(1);
process.exit(0);
