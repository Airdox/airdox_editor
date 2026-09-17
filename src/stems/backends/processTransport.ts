import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StemSeparationError } from '../errors';
import type { SeparationCancellationToken } from '../chunkProcessor';
import { mapExitCode } from './types';

export interface ProcessTransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  token?: SeparationCancellationToken;
  onEvent?: (event: { phase: string; detail?: string; chunkIndex?: number }) => void;
  onLog?: (line: string) => void;
}

export interface ProcessResult {
  code: number;
  events: { phase: string; detail?: string }[];
  stdout: string;
  stderr: string;
}

export function runProcessTransport(options: ProcessTransportOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const events: { phase: string; detail?: string }[] = [];
    let settled = false;

    const handleCancel = () => {
      if (options.token?.isCancelled) {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) {
              try { child.kill('SIGKILL'); } catch {}
            }
          }, 2000);
        } catch {}
      }
    };

    const cancelInterval = setInterval(handleCancel, 100);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        options.onLog?.(trimmed);
        try {
          const evt = JSON.parse(trimmed) as { phase?: string; detail?: string; chunkIndex?: number };
          if (evt && typeof evt.phase === 'string') {
            events.push({ phase: evt.phase, detail: evt.detail });
            options.onEvent?.({ phase: evt.phase, detail: evt.detail, chunkIndex: evt.chunkIndex });
          }
        } catch {
          // not JSONL, treat as log
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) options.onLog?.(line.trim());
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelInterval);
      reject(new StemSeparationError('BACKEND_UNAVAILABLE', `Process failed to start: ${options.command} ${options.args.join(' ')}: ${err.message}`, err));
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelInterval);
      const exitCode = code ?? 1;
      if (options.token?.isCancelled) {
        reject(new StemSeparationError('CANCELLED', 'Process cancelled via SIGTERM'));
        return;
      }
      const mapped = mapExitCode(exitCode);
      if (exitCode !== 0) {
        if (mapped.code === 'CANCELLED') {
          reject(new StemSeparationError('CANCELLED', `Process cancelled, exit ${exitCode}`));
        } else if (mapped.code === 'MODEL_INCOMPATIBLE') {
          reject(new StemSeparationError('MODEL_INCOMPATIBLE', `Model incompatible, exit ${exitCode}: ${stderr.slice(0,500)}`));
        } else if (mapped.code === 'INVALID_REQUEST') {
          reject(new StemSeparationError('INVALID_REQUEST', `Invalid request, exit ${exitCode}: ${stderr.slice(0,500)}`));
        } else {
          reject(new StemSeparationError('INFERENCE_FAILED', `Inference failed exit ${exitCode}: ${stderr.slice(0,1000)}`));
        }
        return;
      }
      resolve({ code: exitCode, events, stdout, stderr });
    });
  });
}

export async function runWithGpuFallback(
  primary: ProcessTransportOptions,
  fallbackEnv: NodeJS.ProcessEnv,
  onLog?: (line: string) => void,
): Promise<ProcessResult> {
  try {
    return await runProcessTransport({ ...primary, onLog });
  } catch (e) {
    const err = e as StemSeparationError;
    // If error suggests GPU OOM or CUDA unavailable, retry on CPU
    const msg = err.message.toLowerCase();
    if (msg.includes('cuda') || msg.includes('gpu') || msg.includes('out of memory') || msg.includes('cublas') || msg.includes('cudnn')) {
      onLog?.(`GPU failed (${err.code}), retrying on CPU`);
      return await runProcessTransport({
        ...primary,
        env: { ...primary.env, ...fallbackEnv, CUDA_VISIBLE_DEVICES: '', FORCE_CPU: '1' },
        onLog,
      });
    }
    throw e;
  }
}
