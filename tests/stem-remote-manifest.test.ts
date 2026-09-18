/**
 * FERN-JOB-MANIFEST – Vertrag zwischen Editor und externem Worker (§17–§19, §22, §34).
 *
 * Der Fernpfad (High Quality extern) transportiert Jobs über einen
 * Google-Drive-Ordner. Was dabei über die Grenze geht, muss **prüfbar** sein:
 * eine unbekannte Schema-Version, eine fremde Job-Id, ein Pfad außerhalb der
 * Jobwurzel oder ein „COMPLETED“ mit fehlenden Stems darf niemals still
 * durchgehen. Genau diese Fälle stehen hier – ohne Netz, ohne Drive, ohne
 * Modell, weil es reine Protokolllogik ist.
 *
 *   1. Manifest bauen: UUID, Zeiten, Schema, Idempotenzschlüssel
 *   2. Fremde/kaputte Manifeste werden abgelehnt (kein Ratemodus)
 *   3. Idempotenz: gleicher Input + gleiches Modell ⇒ gleicher Schlüssel,
 *      anderes Profil/Modell ⇒ anderer Schlüssel (§19)
 *   4. „COMPLETED“ ohne alle Stems ist kein Erfolg (§34 K)
 *   5. Leere/fehlende Outputs sind kein Erfolg (§34 I/J)
 *   6. Layout: Pfade bleiben in der Jobwurzel (kein Ausbruch aus der Ablage)
 */
import assert from 'node:assert/strict';
import {
  buildManifest,
  buildResultDocument,
  createRemoteJobId,
  idempotencyKeyFor,
  parseManifest,
  serializeManifest,
  verifyCompletedManifest,
  withStatus,
  RemoteProtocolError,
} from '../src/stems/remote/manifest';
import {
  assertSafeRelative,
  jobInputPath,
  jobManifestPath,
  jobOutputPath,
  isSafeJobId,
  stemFileName,
} from '../src/stems/remote/layout';
import { REMOTE_JOB_SCHEMA_VERSION } from '../src/stems/remote/types';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FERN-JOB-MANIFEST – SCHEMA, IDEMPOTENZ, VOLLSTÄNDIGKEIT         ');
console.log('═══════════════════════════════════════════════════════════════════');

function baseManifest(jobId = createRemoteJobId()) {
  return buildManifest({
    jobId,
    trackName: 'track_abc',
    appVersion: '0.4.2',
    input: {
      fileName: 'track_abc.wav',
      relativePath: jobInputPath(jobId, 'track_abc.wav'),
      sha256: 'a'.repeat(64),
      bytes: 1_234_567,
      durationSeconds: 300,
      sampleRate: 44100,
      channels: 2,
    },
    engine: {
      backend: 'bs_roformer',
      family: 'bs_roformer',
      modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
      profile: 'HIGH_QUALITY',
      stems: ['drums', 'bass', 'other', 'vocals'],
      device: 'auto',
    },
    idempotencyKey: idempotencyKeyFor({
      sha256: 'a'.repeat(64),
      modelId: 'bsroformer-musdb18hq-4stem-zfturbo',
      profile: 'HIGH_QUALITY',
    }),
  });
}

async function run() {
  // =========================================================================
  console.log('\n[ TEST ] #1 Manifest bauen: Schema, Id, Zeiten, Idempotenzschlüssel');
  const manifest = baseManifest();
  assert.equal(manifest.schemaVersion, REMOTE_JOB_SCHEMA_VERSION);
  assert.match(manifest.jobId, /^[0-9a-f-]{36}$/, 'Job-Id ist eine UUID, nicht der Dateiname (§18)');
  assert.equal(manifest.status, 'PENDING');
  assert.equal(manifest.output.stems.length, 0);
  assert.equal(manifest.createdAtIso.endsWith('Z'), true, 'zusätzlich ISO-Zeit für Colab/Menschen');
  const roundTrip = parseManifest(serializeManifest(manifest), manifest.jobId);
  assert.deepEqual(roundTrip.input, manifest.input);
  assert.deepEqual(roundTrip.engine.stems, ['drums', 'bass', 'other', 'vocals']);
  console.log(`  ✓ Manifest ${manifest.jobId.slice(0, 8)}… serialisiert und wieder gelesen`);

  // =========================================================================
  console.log('\n[ TEST ] #2 Kaputte/fremde Manifeste werden abgelehnt');
  const wrongSchema = JSON.stringify({ ...manifest, schemaVersion: 99 });
  assert.throws(
    () => parseManifest(wrongSchema),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'REMOTE_SCHEMA_UNSUPPORTED',
    'unbekanntes Schema muss hart scheitern'
  );
  assert.throws(
    () => parseManifest(JSON.stringify(manifest), createRemoteJobId()),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'REMOTE_MANIFEST_INVALID',
    'Manifest-Id ≠ Verzeichnis-Id muss abgelehnt werden'
  );
  assert.throws(() => parseManifest('{kein json'), (error: unknown) => error instanceof RemoteProtocolError);
  const traversal = JSON.stringify({
    ...manifest,
    input: { ...manifest.input, relativePath: '../../etc/passwd' },
  });
  assert.throws(
    () => parseManifest(traversal),
    'ein Manifest darf nicht aus der Jobablage hinauszeigen'
  );
  assert.throws(() => assertSafeRelative('/absolut/wav.wav'));
  assert.throws(() => assertSafeRelative('jobs\\..\\x.wav'));
  assert.equal(isSafeJobId('../../x'), false);
  assert.equal(isSafeJobId(createRemoteJobId()), true);
  console.log('  ✓ Schema, Id-Abgleich, Pfad-Ausbruch und JSON-Fehler sind harte Fehler');

  // =========================================================================
  console.log('\n[ TEST ] #3 Idempotenzschlüssel: gleiche Arbeit ⇒ gleicher Schlüssel (§19)');
  const same = idempotencyKeyFor({ sha256: 'b'.repeat(64), modelId: 'm1', profile: 'HIGH_QUALITY' });
  assert.equal(same, idempotencyKeyFor({ sha256: 'b'.repeat(64), modelId: 'm1', profile: 'HIGH_QUALITY' }));
  assert.notEqual(same, idempotencyKeyFor({ sha256: 'c'.repeat(64), modelId: 'm1', profile: 'HIGH_QUALITY' }));
  assert.notEqual(same, idempotencyKeyFor({ sha256: 'b'.repeat(64), modelId: 'm1', profile: 'MAXIMUM_QUALITY' }));
  assert.notEqual(same, idempotencyKeyFor({ sha256: 'b'.repeat(64), modelId: 'm2', profile: 'HIGH_QUALITY' }));
  console.log('  ✓ Schlüssel hängt an Input-Hash, Modell und Profil – nicht an Dateinamen oder Zeit');

  // =========================================================================
  console.log('\n[ TEST ] #4 „COMPLETED“ ohne alle Stems ist kein Erfolg (§34 K)');
  const incomplete = withStatus(manifest, {
    status: 'COMPLETED',
    output: {
      stems: [
        { id: 'drums', fileName: 'drums.wav', relativePath: jobOutputPath(manifest.jobId, 'drums.wav'), sha256: 'd'.repeat(64), bytes: 1000, frames: 10, sampleRate: 44100, channels: 2 },
      ],
    },
  });
  const incompleteCheck = verifyCompletedManifest(incomplete);
  assert.equal(incompleteCheck.ok, false);
  assert.equal(incompleteCheck.ok === false && incompleteCheck.code, 'REMOTE_OUTPUT_INCOMPLETE');
  assert.match(incompleteCheck.ok === false ? incompleteCheck.message : '', /bass, other, vocals/);
  console.log('  ✓ fehlende Stems ⇒ REMOTE_OUTPUT_INCOMPLETE mit Klartext-Liste');

  // =========================================================================
  console.log('\n[ TEST ] #5 Leere Outputs sind kein Erfolg (§34 I/J)');
  const stems = ['drums', 'bass', 'other', 'vocals'].map((id) => ({
    id,
    fileName: stemFileName(id),
    relativePath: jobOutputPath(manifest.jobId, stemFileName(id)),
    sha256: 'e'.repeat(64),
    bytes: id === 'vocals' ? 44 : 4096,
    frames: 100,
    sampleRate: 44100,
    channels: 2,
  }));
  const emptyCheck = verifyCompletedManifest(withStatus(manifest, { status: 'COMPLETED', output: { stems } }));
  assert.equal(emptyCheck.ok, false);
  assert.equal(emptyCheck.ok === false && emptyCheck.code, 'REMOTE_OUTPUT_EMPTY');
  const goodCheck = verifyCompletedManifest(
    withStatus(manifest, { status: 'COMPLETED', output: { stems: stems.map((stem) => ({ ...stem, bytes: 4096 })) } })
  );
  assert.equal(goodCheck.ok, true, 'erst mit allen vier nicht-leeren Stems ist der Job fertig');
  assert.equal(verifyCompletedManifest(manifest).ok, false, 'RUNNING ist nicht COMPLETED');
  console.log('  ✓ 44-Byte-„WAV“ zählt nicht als Stem; Vollständigkeit wird erzwungen');

  // =========================================================================
  console.log('\n[ TEST ] #6 Layout bleibt in der Ablage; Ergebnisdokument ist lesbar');
  assert.equal(jobManifestPath('job-12345678'), 'jobs/job-12345678/manifest.json');
  // Ein Pfad im Dateinamen wird auf den Basisnamen reduziert: kein Verzeichnis
  // kann aus der Jobablage herausführen, Sonderzeichen werden ersetzt.
  assert.equal(jobInputPath('job-12345678', 'a b/c?.wav'), 'jobs/job-12345678/input/c_.wav');
  assert.equal(jobInputPath('job-12345678', '../../x.wav'), 'jobs/job-12345678/input/x.wav');
  assert.equal(stemFileName('vocals'), 'vocals.wav');
  const doc = JSON.parse(buildResultDocument(withStatus(manifest, { status: 'COMPLETED', output: { stems } }))) as {
    jobId: string;
    stems: { id: string }[];
  };
  assert.equal(doc.jobId, manifest.jobId);
  assert.deepEqual(doc.stems.map((stem) => stem.id), ['drums', 'bass', 'other', 'vocals']);
  console.log('  ✓ Pfade normalisiert, Ergebnisdokument trägt Job-Id und Stem-Liste');

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALLE MANIFEST-PRÜFUNGEN BESTANDEN');
  console.log('═══════════════════════════════════════════════════════════════════');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
