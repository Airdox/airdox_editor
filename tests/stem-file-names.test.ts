/**
 * Test der Stem-Dateinamen-Zuordnung (src/stems/stemFileNames.ts).
 *
 * Die externe CLI benennt ihre Ausgaben selbst (z. B.
 * „Artist - Title (Vocals) Model.wav“). Die Deck-Buttons dürfen ihre
 * Beschriftung/Farbe nicht aus der Array-Position raten, sondern aus dieser
 * Zuordnung – sonst wäre der zweite Stem eines 2-Stem-Modells „Drums“.
 */
import assert from 'node:assert/strict';
import { classifyStemFileName, classifyStemFiles, stemLabel } from '../src/stems/stemFileNames';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`[ PASS ] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[ FAIL ] ${name}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

test('#1 Typische CLI-Ausgaben werden korrekt zugeordnet', () => {
  const cases: [string, string][] = [
    ['C:\\stems\\Daft Punk - One More Time (Vocals) UVR-MDX-NET.wav', 'vocals'],
    ['/tmp/stems/Track (Instrumental) Model.wav', 'other'],
    ['Track (Drums) htdemucs.wav', 'drums'],
    ['Track (Bass) htdemucs.wav', 'bass'],
    ['Track (No Vocals) KARAOKE.wav', 'other'],
    ['Track (Percussion) MDX.wav', 'drums'],
  ];
  for (const [file, expected] of cases) {
    assert.equal(classifyStemFileName(file).id, expected, file);
    assert.equal(classifyStemFileName(file).matched, true, file);
  }
});

test('#2 Unbekannte Namen fallen auf „other“ mit lesbarem Label', () => {
  const entry = classifyStemFileName('/tmp/Track (Guitar) htdemucs_6s.wav');
  assert.equal(entry.id, 'other');
  assert.equal(entry.matched, false);
  assert.equal(entry.label, 'Guitar');
});

test('#3 Deck-Reihenfolge ist stabil und verliert keine Datei', () => {
  const files = [
    '/tmp/Track (Other) m.wav',
    '/tmp/Track (Bass) m.wav',
    '/tmp/Track (Vocals) m.wav',
    '/tmp/Track (Drums) m.wav',
  ];
  const ordered = classifyStemFiles(files);
  assert.deepEqual(ordered.map((entry) => entry.id), ['vocals', 'drums', 'bass', 'other']);
  assert.deepEqual(ordered.map((entry) => entry.label), ['Vocals', 'Drums', 'Bass', 'Inst']);
  assert.equal(ordered.length, files.length);
});

test('#4 2-Stem-Modell: Vocals/Instrumental wird nicht zu Drums umgedeutet', () => {
  const ordered = classifyStemFiles(['/tmp/Song (Vocals) MDX.wav', '/tmp/Song (Instrumental) MDX.wav']);
  assert.deepEqual(ordered.map((entry) => entry.id), ['vocals', 'other']);
  assert.deepEqual(ordered.map((entry) => entry.label), ['Vocals', 'Inst']);
});

test('#5 Mehrere Treffer desselben Buckets bleiben erhalten und werden nummeriert', () => {
  const ordered = classifyStemFiles([
    '/tmp/Song (Vocals) demucs.wav',
    '/tmp/Song (Guitar) demucs.wav',
    '/tmp/Song (Piano) demucs.wav',
    '/tmp/Song (Drums) demucs.wav',
  ]);
  assert.deepEqual(ordered.map((entry) => entry.id), ['vocals', 'drums', 'other', 'other']);
  const otherLabels = ordered.filter((entry) => entry.id === 'other').map((entry) => entry.label);
  assert.equal(new Set(otherLabels).size, otherLabels.length, 'Doppelte Buckets brauchen unterscheidbare Labels');
  assert.equal(ordered.length, 4, 'Keine Datei darf still verschwinden (Playback ersetzt den Mix)');
});

test('#6 Leere Eingaben und Klarnamen', () => {
  assert.deepEqual(classifyStemFiles([]), []);
  assert.equal(stemLabel('vocals'), 'Vocals');
  assert.equal(stemLabel('guitar'), 'guitar');
});

console.log(`\nstem-file-names: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exitCode = 1;
