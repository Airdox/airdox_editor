/**
 * FERN-JOB-QUELLE – Originaldatei durchschleifen statt 130-MB-WAV rendern.
 *
 * Warum dieser Test existiert:
 *   Der Fernpfad hat die Arbeitskopie immer aus dem `AudioBuffer` des Decks
 *   gerendert (32-Bit-Float-Stereo-WAV). Ein 4-Minuten-Track wurde dadurch zu
 *   ~130 MB, die über Google Drive synchronisiert werden mussten – obwohl
 *   dieselbe Musik als FLAC mit ~40 MB auf der Platte liegt. Seit der
 *   Originaldatei-Durchleitung darf das nicht mehr passieren, und zwar
 *   **bitgenau**: eine neu kodierte Datei wäre kein verlustfreier Durchgriff
 *   mehr, und eine umbenannte FLAC wäre ein Manifest, das lügt.
 *
 * Geprüft wird:
 *   1. `sourceFile` ⇒ Arbeitskopie ist byte-identisch zur Quelle, Endung bleibt
 *      `.flac`, Manifest nennt Container, Größe und die echte Geometrie
 *   2. Die hochgeladene Datei ist die Quelldatei (SHA-256), nicht ein Render
 *   3. Die Größe bleibt unter der eines gerenderten 32-Bit-WAV derselben Dauer
 *   4. Das Original wird nur gelesen (Hash/Größe/mtime unverändert)
 *   5. Falscher Hash ⇒ `ORIGINAL_MODIFIED`, es entsteht kein Job
 *   6. Ohne `sourceFile` (bearbeiteter Track) ⇒ weiterhin `.wav` aus Bytes
 *   7. Der Colab-Worker findet die Datei über `input.fileName` im Manifest
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StemJobService } from '../src/stems/stemJobService';
import { RemoteStemJobService } from '../src/stems/remote/remoteStemJobService';
import { FolderTransport } from '../src/stems/remote/transport';
import { parseManifest } from '../src/stems/remote/manifest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'pipeline-double-v1';
const PROFILE = 'PREVIEW' as const;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERN-JOB-QUELLE – ORIGINALDATEI STATT 130-MB-WAV                  ');
console.log('═══════════════════════════════════════════════════════════════════');

/* ------------------------------------------------------------------------- *
 * Eine echte FLAC-Datei: „fLaC“ + STREAMINFO-Block (34 Bytes) + Frame-Daten.
 * Der Worker dekodiert sie mit torchaudio/soundfile; der Editor liest nur den
 * Kopf. SAMPLE_RATE/TOTAL_SAMPLES stehen exakt im STREAMINFO – genau deshalb
 * braucht der Editor kein Rendering, um die Dauer zu kennen.
 * ----------------------------------------------------------------------- */
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const TOTAL_SAMPLES = SAMPLE_RATE * 240; // 4 Minuten
const FLAC_PAYLOAD_BYTES = 38 * 1024 * 1024; // ~38 MB „komprimierte“ Frames

function buildFlacFile(): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 4096, false); // min block size
  view.setUint16(2, 4096, false); // max block size
  // 6 gepackte Bytes: 20 Bit Samplerate | 3 Bit (Kanäle-1) | 5 Bit (Bps-1) |
  // 36 Bit Sample-Anzahl – big endian, direkt hinter den Framegrößen.
  const packed =
    BigInt(SAMPLE_RATE) * 2n ** 44n +
    BigInt(CHANNELS - 1) * 2n ** 41n +
    BigInt(BITS_PER_SAMPLE - 1) * 2n ** 36n +
    BigInt(TOTAL_SAMPLES);
  for (let index = 0; index < 8; index++) {
    streamInfo[10 + index] = Number((packed >> BigInt(8 * (7 - index))) & 0xffn);
  }
  // MD5-Signatur (16 Bytes) – Inhalt ist für den Test beliebig, aber vorhanden.
  for (let index = 0; index < 16; index++) streamInfo[18 + index] = index + 1;

  const header = new Uint8Array(4 + 4 + streamInfo.length);
  header.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
  header[4] = 0x00; // letzter Block = nein, Typ 0 = STREAMINFO
  header[5] = 0;
  header[6] = 0;
  header[7] = streamInfo.length;
  header.set(streamInfo, 8);

  const file = new Uint8Array(header.length + FLAC_PAYLOAD_BYTES);
  file.set(header, 0);
  // Deterministischer Pseudo-Zufall: sieht aus wie Frame-Daten, ist aber frei
  // von Mustern, die ein Parser versehentlich als Kopf deuten könnte.
  let seed = 0x2f6e2b1;
  for (let index = header.length; index < file.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    file[index] = (seed >>> 16) & 0xff;
  }
  return file;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Harness {
  base: string;
  root: string;
  drive: string;
  remote: RemoteStemJobService;
  dispose(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'stem-remote-source-'));
  const root = path.join(base, 'engine');
  const drive = path.join(base, 'drive');
  await mkdir(root, { recursive: true });
  await mkdir(drive, { recursive: true });
  const local = new StemJobService({ root, allowPipelineDouble: true, chunkSizeSamples: 44100, logger: quietLogger });
  const transport = new FolderTransport({ root: drive });
  const remote = new RemoteStemJobService({
    root,
    localService: local,
    transport,
    allowPipelineDouble: true,
    disableBackgroundPolling: true,
    env: {},
    settings: { pollIntervalMs: 5_000, workerLeaseMs: 60_000, jobTimeoutMs: 5 * 60_000 },
    logger: quietLogger,
  });
  return {
    base,
    root,
    drive,
    remote,
    async dispose() {
      remote.dispose();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function fingerprint(file: string): Promise<string> {
  const info = await stat(file);
  const bytes = await readFile(file);
  return `${createHash('sha256').update(bytes).digest('hex')}:${info.size}:${info.mtimeMs}`;
}

async function run() {
  const harness = await makeHarness();
  try {
    const musicDir = path.join(harness.base, 'Music');
    await mkdir(musicDir, { recursive: true });
    const flacPath = path.join(musicDir, 'Nightdrive (Extended Mix).flac');
    const flac = buildFlacFile();
    await writeFile(flacPath, flac);
    const flacHash = sha256(flac);
    const originalBefore = await fingerprint(flacPath);

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #1 Originaldatei wird bitgenau kopiert – Endung bleibt .flac');
    const job = await harness.remote.start({
      sourceFile: { path: flacPath, sha256: flacHash, bytes: flac.byteLength },
      trackName: 'track_87868672',
      profile: PROFILE,
      modelId: MODEL_ID,
    });
    assert.equal(job.status, 'RUNNING', 'der Job läuft nach dem Upload');

    const manifest = parseManifest(
      await readFile(path.join(harness.drive, 'jobs', job.jobId, 'manifest.json'), 'utf8'),
      job.jobId
    );
    assert.equal(manifest.input.fileName, 'track_87868672.flac', 'die Endung der Quelle bleibt erhalten');
    assert.equal(manifest.input.format, 'FLAC', 'das Manifest nennt den echten Container');
    assert.equal(manifest.input.bytes, flac.byteLength, 'das Manifest nennt die echte Quellgröße');
    assert.equal(manifest.input.sha256, flacHash, 'der Input-Hash ist der Hash der Originaldatei');
    assert.equal(manifest.input.sampleRate, SAMPLE_RATE, 'Samplerate aus STREAMINFO');
    assert.equal(manifest.input.channels, CHANNELS, 'Kanäle aus STREAMINFO');
    const expectedDuration = TOTAL_SAMPLES / SAMPLE_RATE;
    assert.ok(
      Math.abs(manifest.input.durationSeconds - expectedDuration) < 0.001,
      `Dauer aus STREAMINFO: ${manifest.input.durationSeconds} ≠ ${expectedDuration}`
    );
    console.log(
      `  ✓ ${manifest.input.fileName}: ${(manifest.input.bytes / (1024 * 1024)).toFixed(1)} MB, ` +
        `${manifest.input.sampleRate} Hz, ${manifest.input.durationSeconds.toFixed(1)} s`
    );

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #2 In der Ablage liegt die Quelldatei, kein Render');
    const uploaded = await readFile(path.join(harness.drive, manifest.input.relativePath));
    assert.equal(sha256(uploaded), flacHash, 'hochgeladene Bytes sind bitgleich zur Originaldatei');
    assert.equal(uploaded.byteLength, flac.byteLength, 'keine Byte-Zugabe durch Umschreiben');

    // Derselbe Track als 32-Bit-Float-Stereo-WAV – der alte Weg.
    const renderedWavBytes = 44 + expectedDuration * SAMPLE_RATE * CHANNELS * 4;
    assert.ok(
      uploaded.byteLength < renderedWavBytes / 2,
      `Durchleitung (${(uploaded.byteLength / (1024 * 1024)).toFixed(1)} MB) muss deutlich kleiner sein ` +
        `als das Rendering (${(renderedWavBytes / (1024 * 1024)).toFixed(1)} MB)`
    );
    console.log(
      `  ✓ ${(uploaded.byteLength / (1024 * 1024)).toFixed(1)} MB statt ` +
        `${(renderedWavBytes / (1024 * 1024)).toFixed(1)} MB gerenderter 32-Bit-WAV ` +
        `(${Math.round((1 - uploaded.byteLength / renderedWavBytes) * 100)} % weniger)`
    );

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #3 Das Original wird ausschließlich gelesen');
    assert.equal(await fingerprint(flacPath), originalBefore, 'SHA-256, Größe und mtime der Quelle unverändert (§31)');
    const record = JSON.parse(
      await readFile(path.join(harness.root, 'RemoteJobs', `${job.jobId}.json`), 'utf8')
    ) as { passthrough: boolean; inputFormat: string; workingCopyPath: string; originalPath: string };
    assert.equal(record.passthrough, true, 'der Job-Datensatz belegt die Durchleitung');
    assert.equal(record.inputFormat, 'FLAC');
    assert.equal(record.originalPath, flacPath);
    assert.ok(record.workingCopyPath.endsWith('.flac'), `Arbeitskopie behält die Endung: ${record.workingCopyPath}`);
    console.log(`  ✓ Arbeitskopie ${path.basename(record.workingCopyPath)} im Engine-Ordner, Quelle unverändert`);

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #4 Der Colab-Worker findet die Datei über das Manifest');
    const python = process.env.AIRODOX_STEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const probe = spawnSync(
      python,
      [
        '-c',
        [
          'import json, sys',
          'sys.path.insert(0, "colab")',
          'from remote_worker import manifest_input_file_name, load_input_track',
          'from pathlib import Path',
          'manifest = json.load(open(sys.argv[1], encoding="utf-8"))',
          'name = manifest_input_file_name(manifest)',
          'print("name=" + str(name))',
          'track = Path(sys.argv[2]).parent / name',
          'assert track.is_file(), f"Arbeitskopie fehlt: {track}"',
          'assert track.suffix.lower() == ".flac", f"falsche Endung: {track.suffix}"',
          'print("worker-finds-input=ok")',
        ].join('\n'),
        path.join(harness.drive, 'jobs', job.jobId, 'manifest.json'),
        path.join(harness.drive, manifest.input.relativePath),
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(probe.status, 0, `Python-Seite lehnt das Manifest ab:\n${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout, /name=track_87868672\.flac/);
    assert.match(probe.stdout, /worker-finds-input=ok/);
    console.log('  ✓ manifest_input_file_name() liefert track_87868672.flac – die Datei liegt dort');

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #5 Falscher Hash ⇒ kein Job, klare Ursache');
    const rejected = await harness.remote
      .start({
        sourceFile: { path: flacPath, sha256: 'a'.repeat(64), bytes: flac.byteLength },
        trackName: 'track_rejected',
        profile: PROFILE,
        modelId: MODEL_ID,
      })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string; message?: string });
    assert.ok(rejected, 'eine veränderte Quelle darf keinen Job starten');
    assert.equal(rejected.code, 'ORIGINAL_MODIFIED');
    assert.match(rejected.message ?? '', /passt nicht zum erwarteten Hash/);
    console.log(`  ✓ ORIGINAL_MODIFIED: ${rejected.message}`);

    // ---------------------------------------------------------------------
    console.log('\n[ TEST ] #6 Bearbeiteter Track ⇒ weiterhin gerenderte .wav');
    const rendered = await harness.remote.start({
      bytes: new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x44, 0xac, 0x00, 0x00, 0x20, 0x62, 0x00, 0x00,
        0x08, 0x00, 0x20, 0x00, 0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
      trackName: 'track_edited',
      profile: PROFILE,
      modelId: MODEL_ID,
    });
    const renderedManifest = parseManifest(
      await readFile(path.join(harness.drive, 'jobs', rendered.jobId, 'manifest.json'), 'utf8'),
      rendered.jobId
    );
    assert.equal(renderedManifest.input.fileName, 'track_edited.wav', 'ohne Quellzeiger bleibt der WAV-Weg');
    assert.equal(renderedManifest.input.format, 'WAV');
    const renderedRecord = JSON.parse(
      await readFile(path.join(harness.root, 'RemoteJobs', `${rendered.jobId}.json`), 'utf8')
    ) as { passthrough?: boolean };
    assert.notEqual(renderedRecord.passthrough, true, 'ein Render ist keine Durchleitung');
    console.log('  ✓ gerenderter Mix bleibt .wav – Durchleitung nur mit Quellzeiger');
  } finally {
    await harness.dispose();
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALLE PRÜFUNGEN ZUR ORIGINALDATEI-DURCHLEITUNG BESTANDEN');
  console.log('═══════════════════════════════════════════════════════════════════');
}

await run();
