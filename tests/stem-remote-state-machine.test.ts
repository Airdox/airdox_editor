/**
 * Test: src/state/StemRemoteStateMachine.ts
 */
import { StemRemoteStateMachine } from '../src/state/StemRemoteStateMachine';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

{
  const sm = new StemRemoteStateMachine({ bridgeRoot: '/tmp', jobId: 'j-sm-01' });
  assert(sm.getState() === 'IDLE', 'initial state IDLE');

  assert(sm.transition('START_REMOTE_STEM') === true, 'start transition');
  assert(sm.getState() === 'CHECKING_WORKER', 'after start');

  assert(sm.transition('WORKER_OK', { workerStatusAgeSec: 10 }) === true, 'work ok');
  assert(sm.getState() === 'UPLOADING', 'after work ok');

  assert(sm.transition('INPUT_READY') === true, 'input ready');
  assert(sm.getState() === 'WAITING_CLAIM', 'after input ready');

  assert(sm.transition('CLAIM_TIMEOUT', { errors: ['Claim-Timeout'] }) === true, 'claim timeout');
  assert(sm.getState() === 'ERROR_NO_CLAIM', 'after claim timeout');

  sm.destroy();
}

{
  const sm2 = new StemRemoteStateMachine({ jobId: 'j-full' });
  sm2.transition('START_REMOTE_STEM');
  sm2.transition('WORKER_OK', { workerStatusAgeSec: 20 });
  sm2.transition('INPUT_READY');
  sm2.transition('CLAIM_FOUND', { claimLocked: true });
  assert(sm2.getState() === 'PROCESSING', 'after claim found');

  sm2.transition('DONE_FOUND', { doneManifest: { status: 'COMPLETED' }, progressPercent: 100 });
  assert(sm2.getState() === 'SYNCING_BACK', 'after done');

  sm2.transition('INTEGRITY_OK', { integrityOk: true });
  assert(sm2.getState() === 'LOADED_IN_DECK', 'after integrity ok');

  const msg = sm2.getUserMessage();
  assert(msg.includes('Deck'), 'deck message should mention Deck');
  console.log('[PASS] Phase 2-10 — State-Machine transitions + messages');
  sm2.destroy();
}

console.log('\n=== ALLE STATE-MACHINE-TESTS BESTANDEN ===');
