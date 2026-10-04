/**
 * Test: src/bridge/DriveRemoteBridge.ts — Phase 5 / 9 / 10
 * Run: npx tsx tests/drive-remote-bridge.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Direct import of the TypeScript source (tsx handles .ts)
import {
  checkWorkerStatus, forceDriveRefresh, isClaimed,
  readProgress, readDoneManifest, checkIntegrity, loadStemsToDeck,
} from '../src/bridge/DriveRemoteBridge';

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

// --- Phase 5: Preflight ---
{
  const d = tmpDir('pre_');
  // Missing status file
  const r1 = checkWorkerStatus({ bridgeRoot: d, maxWorkerAgeSec: 75, claimTimeoutMs: 60000, progressPollIntervalMs: 3000, doneTimeoutMs: 300000 });
  assert(r1.reachable === false, 'preflight missing should be unreachable');
  assert(r1.message.includes('nicht erreichbar'), 'preflight message should warn');

  // Stale heartbeat (older than 75 s)
  fs.mkdirSync(path.join(d, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'worker.status.json'), JSON.stringify({ timestamp: Math.round(Date.now()/1000)-100, status: 'IDLE', current_job: null, vram_free_mb: 100, model: 'test' }));
  const r2 = checkWorkerStatus({ bridgeRoot: d, maxWorkerAgeSec: 75, claimTimeoutMs: 60000, progressPollIntervalMs: 3000, doneTimeoutMs: 300000 });
  assert(r2.reachable === false, 'stale heartbeat >75s should block');
  assert(r2.ageSec >= 100, 'ageSec should reflect stale');

  // Fresh heartbeat
  fs.writeFileSync(path.join(d, 'worker.status.json'), JSON.stringify({ timestamp: Math.round(Date.now()/1000)-10, status: 'PROCESSING', current_job: 'j1', vram_free_mb: 14000, model: 'bsroformer-musdb18hq-4stem-zfturbo' }));
  const r3 = checkWorkerStatus({ bridgeRoot: d, maxWorkerAgeSec: 75, claimTimeoutMs: 60000, progressPollIntervalMs: 3000, doneTimeoutMs: 300000 });
  assert(r3.reachable === true, 'fresh heartbeat should allow');
  assert(r3.status === 'PROCESSING', 'status should be PROCESSING');
  console.log('[PASS] Phase 5 — checkWorkerStatus (missing / stale / ok)');
}

// --- Phase 3: Force refresh ---
{
  const d = tmpDir('ref_');
  forceDriveRefresh(d);
  assert(true, 'forceRefresh should not throw');
  console.log('[PASS] Phase 3 — forceDriveRefresh');
}

// --- Phase 6: Claim check ---
{
  const d = tmpDir('claim_');
  fs.mkdirSync(d, { recursive: true });
  assert(isClaimed(d) === false, 'no lock => false');
  fs.writeFileSync(path.join(d, 'claim.lock'), JSON.stringify({ claimed_at: Date.now() }));
  assert(isClaimed(d) === true, 'fresh lock => true');
  console.log('[PASS] Phase 6 — isClaimed');
}

// --- Phase 7: Progress ---
{
  const d = tmpDir('prog_');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'progress.json'), JSON.stringify({ percent: 63, phase: 'Inferenz...', updated_at: Date.now() }));
  const p = readProgress(d);
  assert(p !== null && p.percent === 63, 'progress read');
  console.log('[PASS] Phase 7 — readProgress');
}

// --- Phase 8/9: Done + Integrity ---
{
  const d = tmpDir('done_');
  fs.mkdirSync(path.join(d, 'output'), { recursive: true });
  const stemData = Buffer.from('fake_stem_data_40mb_approx');
  for (const s of ['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav']) {
    fs.writeFileSync(path.join(d, 'output', s), stemData);
  }
  fs.writeFileSync(path.join(d, 'done.json'), JSON.stringify({
    job_id: 'j01', status: 'COMPLETED', completed_at: Math.round(Date.now()/1000),
    files: {
      'drums.wav': { bytes: stemData.length, sha256: 'a'.repeat(64), path: 'drums.wav' },
      'bass.wav': { bytes: stemData.length, sha256: 'a'.repeat(64), path: 'bass.wav' },
      'other.wav': { bytes: stemData.length, sha256: 'a'.repeat(64), path: 'other.wav' },
      'vocals.wav': { bytes: stemData.length, sha256: 'a'.repeat(64), path: 'vocals.wav' },
    }
  }));
  const done = readDoneManifest(d);
  assert(done !== null && done.status === 'COMPLETED', 'done manifest read');
  const integrity = checkIntegrity(d, done);
  assert(integrity.ok === false, 'hash mismatch should fail integrity (we used dummy hash a...))'); // weil Hash nicht passt
  // Aber Bytes sollten passen
  assert(integrity.sizeMismatches.length === 0, 'sizes should match');
  console.log('[PASS] Phase 8/9 — readDoneManifest + checkIntegrity');
}

// --- Phase 10: Load to Deck ---
{
  const d = tmpDir('deck_');
  fs.mkdirSync(path.join(d, 'output'), { recursive: true });
  for (const s of ['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav']) {
    fs.writeFileSync(path.join(d, 'output', s), Buffer.from('stem'));
  }
  const res = loadStemsToDeck(path.join(d, 'output'), { gridStartMs: 0, cuePoints: [{beat:4, timeMs:0}] });
  assert(res.assigned === true, 'all 4 stems assigned');
  assert(res.channels.drums !== null && res.channels.drums.decoded === true, 'drums decoded');
  assert(res.cleanupQueued === true, 'cleanup queued');
  assert(res.errors.length === 0, 'no deck errors');
  console.log('[PASS] Phase 10 — loadStemsToDeck');
}

console.log('\n=== ALLE BRIDGE-TESTS BESTANDEN ===');
