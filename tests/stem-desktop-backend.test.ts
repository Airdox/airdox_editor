/**
 * Tests for the real inference backend (`audio-separator` CLI) and the desktop
 * entry point.
 *
 * The CLI binary is never spawned: a fake runner is injected, so these tests
 * run in any container. What they verify is the contract around the binary —
 * the part that was previously wrong:
 *   - stem identity comes from forced per-stem filenames, never from directory
 *     order (the old desktop code returned every .wav it found),
 *   - argv is passed as an array (no shell interpolation of user paths),
 *   - CLI failures map onto actionable error codes,
 *   - the original input file is never modified.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AudioSeparatorSeparator, checkAudioSeparator, DEFAULT_AUDIO_SEPARATOR_MODEL } from '../src/stems/backends/audioSeparatorSeparator';
import { separateForDesktop, preflight, cancelSeparation, describeError } from '../src/stems/desktopEntry';
import { StemSeparationError } from '../src/stems/errors';
import { encodeWavFloat32, sha256File } from '../src/stems/wavIo';

const checks: string[] = [];
const ok = (label: string) => { checks.push(label); console.log(`  ✓ ${label}`); };

function tone(frames: number, sampleRate = 44100): Float32Array {
  const data = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((2 * Math.PI * 220 * f) / sampleRate) * 0.3;
    data[f * 2] = v; data[f * 2 + 1] = v;
  }
  return data;
}

/** Fake CLI: writes the files a real run would produce, honouring --custom_output_names. */
function fakeRunner(behaviour: { fail?: string; exitMessage?: string; shuffle?: boolean; omit?: string } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const runner = async (options: { command: string; args?: string[]; onLine?: (l: string) => void }) => {
    const args = options.args ?? [];
    calls.push({ command: options.command, args });
    if (behaviour.fail) throw new StemSeparationError('INFERENCE_FAILED', behaviour.fail, behaviour.exitMessage ?? behaviour.fail);
    const outDir = args[args.indexOf('--output_dir') + 1];
    const names = JSON.parse(args[args.indexOf('--custom_output_names') + 1]) as Record<string, string>;
    options.onLine?.('Separating... 50%');
    let entries = Object.values(names);
    if (behaviour.shuffle) entries = [...entries].reverse();
    for (const base of entries) {
      if (behaviour.omit && base === `stem_${behaviour.omit}`) continue;
      await writeFile(path.join(outDir, `${base}.wav`), encodeWavFloat32(44100, 2, tone(2048), 2048));
    }
    return { code: 0, stdout: 'done', stderr: '' };
  };
  return { runner, calls };
}

async function testStemIdentity(root: string): Promise<void> {
  console.log('\n[1] Stem-Identität kommt aus erzwungenen Dateinamen, nicht aus der Reihenfolge');
  const input = path.join(root, 'in.wav');
  await writeFile(input, encodeWavFloat32(44100, 2, tone(4096), 4096));
  const outputRoot = path.join(root, 'out1');
  await import('node:fs/promises').then((m) => m.mkdir(outputRoot, { recursive: true }));

  // The fake writes files in REVERSE order: a positional implementation would
  // label vocals as "other". Identity must survive that.
  const { runner, calls } = fakeRunner({ shuffle: true });
  const backend = new AudioSeparatorSeparator({ runner, stemOrder: ['vocals', 'drums', 'bass', 'other'] });
  const result = await backend.separate({
    inputPath: input, outputRoot, stemOrder: ['vocals', 'drums', 'bass', 'other'], sampleRate: 44100, channels: 2,
  });

  assert.deepEqual(result.stems.map((s) => s.id), ['vocals', 'drums', 'bass', 'other']);
  for (const stem of result.stems) {
    assert.ok(path.basename(stem.filePath).includes(String(stem.id)), `Datei ${stem.filePath} passt nicht zu Stem ${stem.id}`);
    assert.ok(stem.frames > 0 && stem.sampleRate === 44100, 'Stem-Metadaten müssen aus der echten Datei stammen');
  }
  ok('4 Stems in korrekter Identität trotz umgekehrter Schreibreihenfolge');

  const args = calls[0].args;
  assert.equal(args[0], input, 'Eingabepfad muss als eigenes argv-Element uebergeben werden');
  assert.ok(args.includes('--custom_output_names'), 'ohne --custom_output_names waere die Identitaet geraten');
  assert.equal(args[args.indexOf('--model_filename') + 1], DEFAULT_AUDIO_SEPARATOR_MODEL);
  assert.equal(args[args.indexOf('--output_format') + 1], 'WAV');
  const names = JSON.parse(args[args.indexOf('--custom_output_names') + 1]);
  assert.deepEqual(names, { Vocals: 'stem_vocals', Drums: 'stem_drums', Bass: 'stem_bass', Other: 'stem_other' });
  ok('argv als Array (keine Shell-Interpolation), Modell/Format/Namen korrekt gesetzt');

  assert.equal(backend.capabilities().trainedModel, true, 'echtes Backend muss trainedModel=true melden');
  ok('capabilities().trainedModel === true (Gate darf ein Qualitaetsurteil faellen)');
}

async function testFailureModes(root: string): Promise<void> {
  console.log('\n[2] Fehlerfälle werden klassifiziert statt generisch durchgereicht');
  const input = path.join(root, 'in2.wav');
  await writeFile(input, encodeWavFloat32(44100, 2, tone(2048), 2048));
  const outputRoot = path.join(root, 'out2');
  await import('node:fs/promises').then((m) => m.mkdir(outputRoot, { recursive: true }));
  const req = { inputPath: input, outputRoot, stemOrder: ['vocals', 'other'] as const, sampleRate: 44100, channels: 2 };

  const cases: [string, string][] = [
    ['No such file or directory: model.ckpt', 'BACKEND_UNAVAILABLE'],
    ['CUDA out of memory', 'INFERENCE_FAILED'],
    ['ConnectionError: Max retries exceeded', 'BACKEND_UNAVAILABLE'],
  ];
  for (const [message, expected] of cases) {
    const { runner } = fakeRunner({ fail: message });
    const backend = new AudioSeparatorSeparator({ runner });
    const error = await backend.separate({ ...req, stemOrder: ['vocals', 'other'] }).then(() => undefined, (e: unknown) => e as StemSeparationError);
    assert.ok(error instanceof StemSeparationError, `"${message}" muss StemSeparationError liefern`);
    assert.equal(error.code, expected, `"${message}" -> erwartet ${expected}, erhalten ${error.code}`);
  }
  ok('Modell fehlt / OOM / kein Netz jeweils korrekt klassifiziert');

  // A stem the CLI silently did not produce must be a loud failure, never a
  // short list that the UI would mislabel.
  const { runner: omitRunner } = fakeRunner({ omit: 'bass' });
  const omitBackend = new AudioSeparatorSeparator({ runner: omitRunner });
  const omitError = await omitBackend
    .separate({ ...req, stemOrder: ['vocals', 'drums', 'bass', 'other'] })
    .then(() => undefined, (e: unknown) => e as StemSeparationError);
  assert.ok(omitError instanceof StemSeparationError);
  assert.equal(omitError.code, 'INFERENCE_FAILED');
  assert.ok(/bass/.test(omitError.message), 'Fehlermeldung muss den fehlenden Stem nennen');
  ok('Fehlender Stem -> lauter Fehler statt stillschweigend kuerzerer Liste');

  const missing = await checkAudioSeparator({ command: 'definitiv-nicht-installiert-xyz' });
  assert.equal(missing.available, false);
  assert.ok(/pip install/.test(missing.reason ?? ''), 'Preflight muss einen Installationshinweis geben');
  ok(`Preflight ohne Binary: available=false mit Installationshinweis`);
}

async function testDesktopEntry(root: string): Promise<void> {
  console.log('\n[3] Desktop-Entry: Original unveraendert, Fehler uebersetzt, Abbruch');
  const input = path.join(root, 'desk.wav');
  await writeFile(input, encodeWavFloat32(44100, 2, tone(44100), 44100));
  const hashBefore = await sha256File(input);
  const roots = {
    workingRoot: path.join(root, 'd/working'), outputRoot: path.join(root, 'd/out'),
    cacheRoot: path.join(root, 'd/cache'), modelStoreDir: path.join(root, 'd/models'),
  };

  const phases: string[] = [];
  const result = await separateForDesktop({ ...roots, inputPath: input, jobId: 'job-1', usePipelineDouble: true, onProgress: (e) => phases.push(e.phase) });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.originalUnchanged, true, 'Original darf nie veraendert werden');
  assert.equal(result.originalHashBefore, hashBefore);
  assert.equal(result.originalHashAfter, hashBefore);
  assert.equal(await sha256File(input), hashBefore, 'Hash auf der Platte muss identisch sein');
  assert.equal(result.fromTrainedModel, false, 'Pipeline-Double darf sich nie als trainiert ausgeben');
  assert.ok(result.stems.length > 0 && result.stems.every((s) => typeof s.id === 'string' && s.filePath.endsWith('.wav')));
  ok(`Lauf ueber Double: ${result.stems.map((s) => s.id).join(', ')}, Original-Hash identisch`);

  const files = await readdir(roots.outputRoot, { recursive: true } as never) as unknown as string[];
  assert.ok(files.length > 0, 'Ausgaben muessen unterhalb von outputRoot liegen');
  ok('Ausgaben landen ausschliesslich im dafuer vorgesehenen outputRoot');

  const failed = await separateForDesktop({ ...roots, inputPath: path.join(root, 'gibtsnicht.wav'), jobId: 'job-2', usePipelineDouble: true });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error?.code, 'AUDIO_MISSING');
  assert.ok((failed.error?.message ?? '').length > 20, 'Fehlermeldung muss fuer Menschen lesbar sein');
  ok(`Fehlende Datei -> ${failed.error?.code} mit verstaendlicher Meldung`);

  assert.equal(cancelSeparation('unbekannte-job-id'), false, 'unbekannte Job-ID darf nicht true melden');
  ok('cancelSeparation() meldet false fuer unbekannte Job-ID');

  const pre = await preflight({ command: 'definitiv-nicht-installiert-xyz' } as never);
  assert.equal(pre.available, false);
  assert.equal(pre.defaultModel, DEFAULT_AUDIO_SEPARATOR_MODEL);
  ok('preflight() meldet fehlendes Binary inkl. Default-Modellname');

  assert.equal(describeError(new StemSeparationError('WRITE_DENIED', 'x')).code, 'WRITE_DENIED');
  assert.ok(describeError(new Error('boom')).message.includes('boom'));
  ok('describeError() uebersetzt Codes und behaelt Originaltext');
}

async function run(): Promise<void> {
  console.log('══ DESKTOP-BACKEND / AUDIO-SEPARATOR ══');
  const root = await mkdtemp(path.join(os.tmpdir(), 'stem-desktop-'));
  try {
    await testStemIdentity(root);
    await testFailureModes(root);
    await testDesktopEntry(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\nstem-desktop-backend: ${checks.length} Prüfungen bestanden`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
