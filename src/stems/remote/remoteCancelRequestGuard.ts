/**
 * Client-side guard for remote-job cancellation requests.
 *
 * A rejected or failed request must not be retried on every React render or
 * repeated button event. Accepted requests stay locked until the job reaches a
 * terminal state; other outcomes get a short, explicit retry cooldown.
 */
export const REMOTE_CANCEL_RETRY_COOLDOWN_MS = 5_000;

type Attempt =
  | { state: 'IN_FLIGHT' }
  | { state: 'ACCEPTED' }
  | { state: 'COOLDOWN'; retryAt: number };

export class RemoteCancelRequestGuard {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly retryCooldownMs = REMOTE_CANCEL_RETRY_COOLDOWN_MS) {
    if (!Number.isFinite(retryCooldownMs) || retryCooldownMs < 0) {
      throw new RangeError('Die Abbruch-Wartezeit muss eine nicht-negative endliche Zahl sein.');
    }
  }

  /** Atomically reserves a request slot; `now` is injectable for deterministic tests. */
  begin(jobId: string, now = Date.now()): boolean {
    if (!jobId) return false;

    const current = this.attempts.get(jobId);
    if (current?.state === 'IN_FLIGHT' || current?.state === 'ACCEPTED') return false;
    if (current?.state === 'COOLDOWN' && now < current.retryAt) return false;

    this.attempts.set(jobId, { state: 'IN_FLIGHT' });
    return true;
  }

  /** Records whether the service accepted the request, or starts a retry cooldown. */
  settle(jobId: string, accepted: boolean, now = Date.now()): void {
    if (this.attempts.get(jobId)?.state !== 'IN_FLIGHT') return;

    this.attempts.set(
      jobId,
      accepted
        ? { state: 'ACCEPTED' }
        : { state: 'COOLDOWN', retryAt: now + this.retryCooldownMs },
    );
  }

  isPending(jobId: string): boolean {
    const state = this.attempts.get(jobId)?.state;
    return state === 'IN_FLIGHT' || state === 'ACCEPTED';
  }

  isCoolingDown(jobId: string, now = Date.now()): boolean {
    const current = this.attempts.get(jobId);
    return current?.state === 'COOLDOWN' && now < current.retryAt;
  }

  /** Jobs are forgotten as soon as a status snapshot says they are no longer active. */
  forget(jobId: string): void {
    this.attempts.delete(jobId);
  }

  trackedJobIds(): string[] {
    return [...this.attempts.keys()];
  }
}
