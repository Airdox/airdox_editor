/**
 * Test der Electron-Helfer für die externe Stem-Separation (electron/stemRunner.cjs).
 *
 * Diese Bausteine entscheiden, ob die Desktop-App den Python-Separator sicher
 * aufruft: keine Shell-Strings, eigene Ausgabeordner pro Track, nur die Dateien
 * des aktuellen Laufs und verständliche Fehler mit nächstem Schritt.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = require(path.join(root, 'electron', 'stemRunner.cjs'));

let passed = 0;
let failed = 0;

function test(name, fn) {
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

test('#1 Separator-Aufruf nutzt ein Argument-Array (kein Shell-String)', () => {
  const args = runner.buildSeparatorArgs({
    inputPath: '/music/Mein Track (Extended Mix).wav',
    outputDir: '/out/Mein Track-12345678',
    modelFilename: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    modelFileDir: '/models',
    chunkDuration: 300,
    extraArgs: ['--use_autocast', '  ', null],
  });
  assert.deepEqual(args.slice(0, 5), [
    '/music/Mein Track (Extended Mix).wav',
    '--output_dir',
    '/out/Mein Track-12345678',
    '--output_format',
    'WAV',
  ]);
  assert.ok(args.includes('--model_filename'));
  assert.ok(args.includes('model_bs_roformer_ep_317_sdr_12.9755.ckpt'));
  assert.ok(args.includes('--model_file_dir'));
  assert.ok(args.includes('--chunk_duration'));
  assert.ok(args.includes('300'), 'chunkDuration muss als String übergeben werden');
  assert.ok(args.includes('--use_autocast'));
  assert.ok(!args.some((entry) => entry === null || entry === ''), 'Leere Argumente dürfen nicht durchgereicht werden');
  assert.throws(() => runner.buildSeparatorArgs({ outputDir: '/out' }), /inputPath fehlt/);
  assert.throws(() => runner.buildSeparatorArgs({ inputPath: '/in.wav' }), /outputDir fehlt/);
});

test('#2 Jeder Track bekommt einen eigenen, stabilen Ausgabeordner', () => {
  const a = runner.trackOutputRoot('/out', '/music/mix.wav');
  const b = runner.trackOutputRoot('/out', '/downloads/mix.wav');
  const again = runner.trackOutputRoot('/out', '/music/mix.wav');
  assert.notEqual(a, b, 'Gleiche Dateinamen aus anderen Ordnern müssen getrennt bleiben');
  assert.equal(a, again, 'Ausgabeordner muss stabil (reproduzierbar) sein');
  const tricky = runner.trackOutputRoot('/out', 'C:\\Users\\DJ\\Musik\\A/B: *?"<>| Track #1.wav');
  assert.ok(!/[<>:"|?*]/.test(path.basename(tricky)), 'Sonderzeichen müssen entschärft werden');
  assert.ok(path.basename(tricky).length > 0);
});

test('#3 Nur die WAV-Dateien des aktuellen Laufs werden zurückgegeben', () => {
  const before = [
    { name: 'alt (Vocals).wav', mtimeMs: 100, size: 10 },
    { name: 'unveraendert.wav', mtimeMs: 100, size: 10 },
  ];
  const after = [
    ...before,
    { name: 'neu (Vocals).wav', mtimeMs: 200, size: 99 },
    { name: 'neu (Instrumental).wav', mtimeMs: 200, size: 98 },
    { name: 'alt (Vocals).wav', mtimeMs: 300, size: 42 }, // überschrieben → zählt
    { name: 'log.txt', mtimeMs: 300, size: 5 },
  ];
  const stems = runner.collectStemOutputs({ outputDir: '/out', filesBefore: before, filesAfter: after });
  assert.deepEqual(stems, ['/out/alt (Vocals).wav', '/out/neu (Instrumental).wav', '/out/neu (Vocals).wav']);
  assert.ok(!stems.some((entry) => entry.endsWith('.txt')), 'Fremddateien dürfen nicht als Stem gelten');
  assert.deepEqual(runner.collectStemOutputs({ outputDir: '/out', filesBefore: before, filesAfter: before }), []);
  assert.throws(() => runner.collectStemOutputs({ filesBefore: [], filesAfter: [] }), /outputDir fehlt/);
});

test('#4 Fehler werden klassifiziert und bekommen einen nächsten Schritt', () => {
  const notInstalled = runner.classifySeparatorFailure({
    error: { code: 'ENOENT', message: 'spawn audio-separator ENOENT' },
  });
  assert.equal(notInstalled.code, 'SEPARATOR_NOT_INSTALLED');
  assert.ok(/pip install/.test(notInstalled.hint), 'Installationshinweis fehlt');

  const windows = runner.classifySeparatorFailure({
    error: { message: 'Command failed' },
    stderr: "'audio-separator' is not recognized as an internal or external command",
  });
  assert.equal(windows.code, 'SEPARATOR_NOT_INSTALLED');

  const cuda = runner.classifySeparatorFailure({ error: { message: 'exit 1' }, stderr: 'RuntimeError: CUDA out of memory' });
  assert.equal(cuda.code, 'SEPARATOR_RUNTIME_FAILED');
  assert.ok(/CPU-Variante/.test(cuda.hint));

  const model = runner.classifySeparatorFailure({
    error: { message: 'exit 1' },
    stderr: 'ERROR - Failed to download model file: HTTP 404',
  });
  assert.equal(model.code, 'SEPARATOR_MODEL_FAILED');

  const cancelled = runner.classifySeparatorFailure({ error: { killed: true, signal: 'SIGTERM' }, cancelled: true });
  assert.equal(cancelled.code, 'SEPARATOR_CANCELLED');

  const timeout = runner.classifySeparatorFailure({ error: { message: 'x' }, timedOut: true });
  assert.equal(timeout.code, 'SEPARATOR_TIMEOUT');

  const missing = runner.classifySeparatorFailure({
    error: { message: 'exit 1' },
    stderr: 'FileNotFoundError: /music/track.wav does not exist',
    inputPath: '/music/track.wav',
  });
  assert.equal(missing.code, 'SEPARATOR_INPUT_MISSING');

  const generic = runner.classifySeparatorFailure({ error: { message: 'exit 2' }, stderr: 'Traceback: kaputt' });
  assert.equal(generic.code, 'SEPARATOR_FAILED');
  assert.ok(generic.message.includes('kaputt'), 'Fehlerdetail muss in der Meldung auftauchen');
});

test('#5 Fortschrittszeilen der CLI werden ausgewertet', () => {
  assert.deepEqual(runner.parseSeparatorProgress(' 45%|████ | 90/200 [00:12<00:15, 7.1it/s]'), {
    ratio: 0.45,
    message: 'Externer Separator: 45 %',
  });
  const stage = runner.parseSeparatorProgress('INFO - Loading model UVR-MDX-NET-Inst_HQ_3.onnx');
  assert.equal(stage.ratio, null);
  assert.ok(/Loading model/.test(stage.message));
  assert.equal(runner.parseSeparatorProgress(''), null);
  assert.equal(runner.parseSeparatorProgress('irgendein Text'), null);
});

test('#6 CLI-Suche bevorzugt native Executables und ignoriert Log-Zeilen', () => {
  const found = runner.parseLookupOutput('INFO: Could not find files\r\nC:\\py\\Scripts\\audio-separator.cmd\r\nC:\\py\\Scripts\\audio-separator.exe\r\n');
  assert.equal(found, 'C:\\py\\Scripts\\audio-separator.exe');
  assert.equal(runner.parseLookupOutput('"/usr/local/bin/audio-separator"'), '/usr/local/bin/audio-separator');
  assert.equal(runner.parseLookupOutput(''), null);
  assert.equal(runner.requiresShell('C:\\py\\Scripts\\audio-separator.cmd'), true);
  assert.equal(runner.requiresShell('/usr/local/bin/audio-separator'), false);
  assert.deepEqual(runner.toShellArgs(['/a b/in.wav', '--output_dir', '/o u t', '--flag']), [
    '"/a b/in.wav"',
    '--output_dir',
    '"/o u t"',
    '--flag',
  ]);
});

test('#7 Modell-Liste der CLI wird tolerant geparst', () => {
  const list = runner.parseRuntimeModelList(
    'INFO - Loading models\n[{"model_name":"model_bs_roformer_ep_317_sdr_12.9755.ckpt","output_stems":["Vocals","Instrumental"],"model_size":260.4,"arch_type":"roformer"}]'
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].fileName, 'model_bs_roformer_ep_317_sdr_12.9755.ckpt');
  assert.deepEqual(list[0].stemNames, ['Vocals', 'Instrumental']);
  assert.equal(list[0].architecture, 'roformer');
  assert.equal(list[0].modelSize, 260.4);

  const wrapped = runner.parseRuntimeModelList('{"models":[{"filename":"htdemucs","output_stems":"drums,bass,other,vocals"}]}');
  assert.deepEqual(wrapped[0].stemNames, ['drums', 'bass', 'other', 'vocals']);

  const jsonl = runner.parseRuntimeModelList('{"fileName":"a.onnx"}\n{"fileName":"b.onnx"}');
  assert.equal(jsonl.length, 2);
  assert.deepEqual(runner.parseRuntimeModelList('kein JSON'), []);
  assert.deepEqual(runner.buildListModelsArgs({ modelFileDir: '/models' }), ['-l', '--list_format=json', '--model_file_dir', '/models']);
});

test('#8 Modell-Payload wird validiert (HTTPS-Pflicht, keine Pfadtricks)', () => {
  const model = runner.normalizeModelRequest({
    id: 'bsroformer',
    fileName: 'model.ckpt',
    downloadUrl: 'https://example.org/model.ckpt',
    sha256: 'A'.repeat(64),
    expectedSizeBytes: 2048.9,
  });
  assert.equal(model.fileName, 'model.ckpt');
  assert.equal(model.downloadUrl, 'https://example.org/model.ckpt');
  assert.equal(model.sha256, 'a'.repeat(64));
  assert.equal(model.expectedSizeBytes, 2048);

  assert.throws(
    () => runner.normalizeModelRequest({ fileName: 'm.ckpt', downloadUrl: 'http://example.org/m.ckpt' }),
    /nur über HTTPS/
  );
  assert.equal(
    runner.normalizeModelRequest({ fileName: 'm.ckpt', downloadUrl: 'http://example.org/m.ckpt' }, { env: { AIRDOX_ALLOW_INSECURE_MODEL_DOWNLOAD: '1' } }).downloadUrl,
    'http://example.org/m.ckpt'
  );
  assert.equal(runner.normalizeModelRequest({ fileName: '../../etc/passwd' }).fileName, 'passwd');
  assert.equal(runner.normalizeModelRequest({ fileName: 'htdemucs' }).fileName, 'htdemucs', 'CLI-Modellnamen ohne Endung sind erlaubt');
  assert.equal(runner.normalizeModelRequest({ fileName: 'm.ckpt', sha256: 'kurz' }).sha256, null);
  assert.equal(runner.normalizeModelRequest(null), null);
  assert.equal(runner.normalizeModelRequest({}), null);
});

test('#9 Suchreihenfolge: Override vor Python-Scripts vor PATH', () => {
  const candidates = runner.separatorCandidates({
    env: { AIRDOX_AUDIO_SEPARATOR: '/opt/sep/audio-separator' },
    platform: 'linux',
    scriptDirs: ['/usr/local/bin'],
  });
  assert.deepEqual(candidates.map((entry) => entry.source), ['env', 'python-scripts', 'path']);
  assert.equal(candidates[0].command, '/opt/sep/audio-separator');
  assert.equal(candidates[1].command, '/usr/local/bin/audio-separator');
  assert.equal(candidates[2].command, 'audio-separator');

  const windowsCandidates = runner.separatorCandidates({ env: {}, platform: 'win32', scriptDirs: ['C:\\py\\Scripts'] });
  assert.equal(windowsCandidates[0].command, 'C:\\py\\Scripts\\audio-separator.exe');
});

console.log(`\nstem-runner: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exitCode = 1;
