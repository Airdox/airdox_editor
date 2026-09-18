/**
 * Checkpoint integrity – SHA256 verification (§5, §6).
 *
 * The model must NOT be used with model_hash = "unverified" productively.
 * On start: find checkpoint, check exists, size, sha256, compare against registry,
 * only if match mark as AVAILABLE.
 *
 * On mismatch: MODEL_HASH_MISMATCH and NO separation.
 */

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export interface CheckpointIntegrityResult {
  exists: boolean;
  path: string;
  size: number;
  sha256: string | null;
  expectedSha256: string | null;
  verified: boolean;
  reason?: string;
}

const sha256Cache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
const sha256Inflight = new Map<string, Promise<string>>();

export async function computeSha256(filePath: string): Promise<string> {
  const info = await stat(filePath);
  const size = Number(info.size);
  const mtimeMs = Number(info.mtimeMs);
  const cached = sha256Cache.get(filePath);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return cached.sha256;
  }
  const key = `${filePath}|${size}|${mtimeMs}`;
  const inflight = sha256Inflight.get(key);
  if (inflight) return inflight;
  const task = new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const sha256 = hash.digest('hex');
      sha256Cache.set(filePath, { size, mtimeMs, sha256 });
      resolve(sha256);
    });
    stream.on('error', reject);
  }).finally(() => {
    sha256Inflight.delete(key);
  });
  sha256Inflight.set(key, task);
  return task;
}

export async function verifyCheckpointIntegrity(
  checkpointPath: string,
  expectedSha256: string | null
): Promise<CheckpointIntegrityResult> {
  try {
    const info = await stat(checkpointPath);
    if (!info.isFile()) {
      return {
        exists: false,
        path: checkpointPath,
        size: 0,
        sha256: null,
        expectedSha256,
        verified: false,
        reason: `Checkpoint ist kein File: ${checkpointPath}`,
      };
    }
    if (info.size < 1024) {
      return {
        exists: true,
        path: checkpointPath,
        size: info.size,
        sha256: null,
        expectedSha256,
        verified: false,
        reason: `Checkpoint zu klein (${info.size} Bytes): ${checkpointPath}`,
      };
    }

    // If expected is null or "unverified", we still compute hash but mark as unverified
    if (!expectedSha256 || expectedSha256 === 'unverified') {
      const actual = await computeSha256(checkpointPath);
      return {
        exists: true,
        path: checkpointPath,
        size: info.size,
        sha256: actual,
        expectedSha256,
        verified: false,
        reason: `model_hash ist "unverified" – Integrität kann nicht geprüft werden. Berechnet: ${actual}`,
      };
    }

    const actual = await computeSha256(checkpointPath);
    const verified = actual.toLowerCase() === expectedSha256.toLowerCase();
    return {
      exists: true,
      path: checkpointPath,
      size: info.size,
      sha256: actual,
      expectedSha256,
      verified,
      reason: verified ? undefined : `MODEL_HASH_MISMATCH: erwartet ${expectedSha256}, gefunden ${actual}`,
    };
  } catch (error) {
    return {
      exists: false,
      path: checkpointPath,
      size: 0,
      sha256: null,
      expectedSha256,
      verified: false,
      reason: `Checkpoint nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ConfigIntegrityResult {
  exists: boolean;
  path: string;
  size: number;
  valid: boolean;
  reason?: string;
}

export async function verifyConfigIntegrity(configPath: string): Promise<ConfigIntegrityResult> {
  try {
    const info = await stat(configPath);
    if (!info.isFile()) {
      return { exists: false, path: configPath, size: 0, valid: false, reason: 'Config ist kein File' };
    }
    if (info.size < 10) {
      return { exists: true, path: configPath, size: info.size, valid: false, reason: 'Config zu klein' };
    }
    // Basic YAML sanity: must contain some expected keys
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(configPath, 'utf8');
    const hasTraining = content.includes('training') || content.includes('model') || content.includes('audio');
    if (!hasTraining) {
      return { exists: true, path: configPath, size: info.size, valid: false, reason: 'Config enthält keine erwarteten Schlüssel' };
    }
    return { exists: true, path: configPath, size: info.size, valid: true };
  } catch (error) {
    return {
      exists: false,
      path: configPath,
      size: 0,
      valid: false,
      reason: `Config nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function getKnownCheckpointHash(): string {
  // The hash that was observed in live test for model_bs_roformer_ep_17_sdr_9.6568.ckpt
  return '3e9daecd70aaed5b5a0d1f861cc4d77eaa45afb3fc6301b1cf32c1be0f5868fb';
}

export function isHashFormatValid(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}
