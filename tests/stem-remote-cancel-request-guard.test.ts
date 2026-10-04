import assert from 'node:assert/strict';
import {
  RemoteCancelRequestGuard,
  REMOTE_CANCEL_RETRY_COOLDOWN_MS,
} from '../src/stems/remote/remoteCancelRequestGuard';

const guard = new RemoteCancelRequestGuard(REMOTE_CANCEL_RETRY_COOLDOWN_MS);
const jobId = 'remote-job-1234';

assert.equal(guard.begin(jobId, 1_000), true, 'der erste Abbruch wird reserviert');
assert.equal(guard.begin(jobId, 1_001), false, 'parallele Klicks während der Anfrage werden dedupliziert');
assert.equal(guard.isPending(jobId), true);

guard.settle(jobId, false, 2_000);
assert.equal(guard.isPending(jobId), false, 'eine abgelehnte Anfrage bleibt nicht als laufend markiert');
assert.equal(guard.isCoolingDown(jobId, 2_001), true);
assert.equal(guard.begin(jobId, 2_001), false, 'eine Ablehnung löst keine direkte Wiederholungs-Schleife aus');
assert.equal(
  guard.begin(jobId, 2_000 + REMOTE_CANCEL_RETRY_COOLDOWN_MS),
  true,
  'nach dem Cooldown ist ein bewusster neuer Versuch möglich',
);

guard.settle(jobId, true, 8_000);
assert.equal(guard.isPending(jobId), true, 'angenommene Abbrüche bleiben bis zum terminalen Status gesperrt');
assert.equal(guard.begin(jobId, 60_000), false, 'ein angenommenes Cancel kann nicht erneut gesendet werden');
assert.deepEqual(guard.trackedJobIds(), [jobId]);

guard.forget(jobId);
assert.equal(guard.begin(jobId, 60_001), true, 'nach Abschluss des Jobs wird die Sperre entfernt');

console.log('stem-remote-cancel-request-guard: Deduplizierung, Cooldown und terminale Freigabe geprüft');
