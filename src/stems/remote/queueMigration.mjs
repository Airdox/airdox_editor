export const BATCH_QUEUE_WAIT_MS = 7 * 24 * 60 * 60_000;

export function planQueueMigration(record, manifest, { claim = null, cancelled = false } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(record?.workingCopySha256 || '') || typeof record?.modelId !== 'string' || !record.modelId || typeof record?.profile !== 'string' || !record.profile) return { action: 'skip', reason: 'invalid-identity' };
  if (!record || !manifest || record.jobId !== manifest.jobId || record.workingCopySha256 !== manifest.input?.sha256 || record.modelId !== manifest.engine?.modelId || record.profile !== manifest.engine?.profile) return { action: 'skip', reason: 'identity' };
  if (manifest.status === 'COMPLETED') return { action: 'import', reason: 'completed' };
  if (cancelled || record.cancelRequestedAt || record.cancelPending || manifest.cancelRequested || record.status === 'CANCELLED' || manifest.status === 'CANCELLED') return { action: 'skip', reason: 'cancelled' };
  if (record.worker || manifest.worker || claim || (record.attempts || 0) > 0 || (manifest.attempts || 0) > 0) return { action: 'skip', reason: 'claimed' };
  if ([record.error, manifest.error].some(error => error && error.code !== 'REMOTE_TIMEOUT')) return { action: 'skip', reason: 'execution-error' };
  const timedOut = record.error?.code === 'REMOTE_TIMEOUT' || manifest.error?.code === 'REMOTE_TIMEOUT';
  if ((record.status === 'FAILED' || manifest.status === 'FAILED') && !timedOut) return { action: 'skip', reason: 'unknown-failure' };
  if (manifest.output?.stems?.length) return { action: 'skip', reason: 'partial-output' };
  if (!timedOut && record.queueWaitTimeoutMs === BATCH_QUEUE_WAIT_MS) return { action: 'skip', reason: 'already-migrated' };
  const updated = { ...record, queueWaitTimeoutMs: BATCH_QUEUE_WAIT_MS };
  if (timedOut) {
    updated.status = 'RUNNING'; updated.phase = 'Wartet auf Colab – Queuewartefrist migriert';
    delete updated.error; delete updated.finishedAt;
    const remote = { ...manifest, status: 'RUNNING', phase: updated.phase };
    delete remote.error;
    return { action: 'repair-timeout', record: updated, manifest: remote };
  }
  return { action: 'extend-wait', record: updated };
}
