/**
 * ProcessTransport – shared spawn/protocol/cancel handling for every
 * out-of-process backend (native C++ CLI as well as Python runtimes).
 *
 * Wire protocol (JSON Lines on stdout):
 *   {"type":"progress","fraction":0.42,"phase":"chunk 3/12"}
 *   {"type":"stem","index":0,"name":"vocals","path":"/abs/vocals.wav"}
 *   {"type":"log","level":"info","message":"..."}
 *   {"type":"error","code":"GPU_OUT_OF_MEMORY","message":"..."}
 *   {"type":"done","device":"cpu","report":{...}}
 *
 * Exit codes (shared with `python/bsroformer_inference.py` and documented for
 * native binaries in `docs/STEM_SEPARATION_ENGINE.md`):
 *   0 ok | 130 cancelled | 2 bad arguments | 3 model problem | 4 IO problem |
 *   5 unsupported audio
 */
import { spawn } from 'node:child_process';
import { StemSeparationError, classifyFailure } from '../errors';
import type { CancellationToken } from '../chunkProcessor';
import type { ComputeDevice } from '../types';

export const EXIT_OK = 0;
export const EXIT_CANCELLED = 130;
export const EXIT_BAD_ARGS = 2;
export const EXIT_MODEL = 3;
export const EXIT_IO = 4;
export const EXIT_AUDIO = 5;

export interface ProcessMessage {
  type: 'progress' | 'stem' | 'log' | 'error' | 'done' | 'unknown';
  [key: string]: unknown;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  token?: CancellationToken;
  timeoutMs?: number;
  onProgress?: (fraction: number, phase: string) => void;
  /** Milliseconds between SIGTERM and SIGKILL after a cancel. */
  killGraceMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  cancelled: boolean;
  device: ComputeDevice;
  stems: { index?: number; name: string; path: string }[];
  report: Record<string, unknown>;
  logs: string[];
  stderr: string;
  durationMs: number;
}

/** Codes a backend may report through the protocol; anything else is ignored. */
const KNOWN_ERROR_CODES = new Set([
  'MODEL_MISSING', 'MODEL_CORRUPT', 'MODEL_INCOMPATIBLE', 'MODEL_REGISTRY_INVALID',
  'AUDIO_MISSING', 'AUDIO_CORRUPT', 'AUDIO_UNSUPPORTED_FORMAT', 'AUDIO_INVALID_SAMPLE_RATE',
  'GPU_UNAVAILABLE', 'GPU_OUT_OF_MEMORY', 'CPU_FALLBACK_REQUIRED',
  'WRITE_DENIED', 'DISK_FULL', 'INFERENCE_CANCELLED', 'INFERENCE_FAILED',
  'BACKEND_UNAVAILABLE', 'CACHE_CORRUPT', 'STEM_CONFIG_INVALID', 'VALIDATION_FAILED',
]);

const EXIT_CODE_MAP: Record<number, Parameters<typeof classifyFailure>[0]> = {
  [EXIT_BAD_ARGS]: 'STEM_CONFIG_INVALID',
  [EXIT_MODEL]: 'MODEL_CORRUPT',
  [EXIT_IO]: 'WRITE_DENIED',
  [EXIT_AUDIO]: 'AUDIO_CORRUPT',
};

export async function runBackendProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const logs: string[] = [];
  const stems: { index?: number; name: string; path: string }[] = [];
  let stderr = '';
  let device: ComputeDevice = 'cpu';
  let report: Record<string, unknown> = {};
  let reportedError: { code?: string; message?: string } | undefined;
  let doneSeen = false;

  return new Promise<ProcessResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
      });
    } catch (error) {
      reject(classifyFailure('BACKEND_UNAVAILABLE', `Backend konnte nicht gestartet werden: ${options.command}`, error));
      return;
    }

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let cancelRequested = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const result: ProcessResult = {
        exitCode: child.exitCode,
        cancelled: cancelRequested || child.exitCode === EXIT_CANCELLED,
        device,
        stems,
        report,
        logs,
        stderr: stderr.slice(-8000),
        durationMs: Date.now() - started,
      };
      if (result.cancelled) {
        reject(new StemSeparationError('INFERENCE_CANCELLED', 'Backend-Inferenz wurde abgebrochen', { exitCode: child.exitCode }));
        return;
      }
      if (child.exitCode !== EXIT_OK) {
        // A protocol level error code wins over the exit code mapping: it is the
        // more specific information the backend gave us.
        const reportedCode = reportedError?.code && KNOWN_ERROR_CODES.has(reportedError.code)
          ? (reportedError.code as Parameters<typeof classifyFailure>[0])
          : undefined;
        const mapped = EXIT_CODE_MAP[child.exitCode ?? -1];
        const message = reportedError?.message || `Backend beendete sich mit Code ${String(child.exitCode)}`;
        reject(classifyFailure(reportedCode ?? mapped ?? 'INFERENCE_FAILED', message, { stderr: result.stderr, logs: logs.slice(-10) }));
        return;
      }
      if (reportedError) {
        const code = reportedError.code && KNOWN_ERROR_CODES.has(reportedError.code)
          ? (reportedError.code as Parameters<typeof classifyFailure>[0])
          : 'INFERENCE_FAILED';
        reject(classifyFailure(code, reportedError.message ?? 'Backend meldete einen Fehler', { code: reportedError.code }));
        return;
      }
      if (!doneSeen) {
        reject(new StemSeparationError('INFERENCE_FAILED', 'Backend beendete sich ohne done-Nachricht', { logs: logs.slice(-10) }));
        return;
      }
      resolve(result);
    };

    const requestCancel = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, options.killGraceMs ?? 4000);
      killTimer.unref?.();
    };

    if (options.token) {
      if (options.token.cancelled) requestCancel();
      else {
        const original = options.token.cancel.bind(options.token);
        // Cooperative cancellation: forward the token's cancel to the child.
        const watcher = setInterval(() => {
          if (options.token!.cancelled) requestCancel();
        }, 120);
        watcher.unref?.();
        child.on('close', () => {
          clearInterval(watcher);
          void original;
        });
      }
    }

    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        requestCancel();
        stderr += '\n[transport] Zeitüberschreitung';
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    }

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: ProcessMessage | undefined;
        try {
          message = JSON.parse(trimmed) as ProcessMessage;
        } catch {
          logs.push(trimmed);
          continue;
        }
        switch (message?.type) {
          case 'progress': {
            const fraction = Number(message.fraction ?? 0);
            options.onProgress?.(Number.isFinite(fraction) ? fraction : 0, String(message.phase ?? ''));
            break;
          }
          case 'stem':
            stems.push({
              index: typeof message.index === 'number' ? message.index : undefined,
              name: String(message.name ?? ''),
              path: String(message.path ?? ''),
            });
            break;
          case 'log':
            logs.push(String(message.message ?? ''));
            break;
          case 'error':
            reportedError = { code: String(message.code ?? ''), message: String(message.message ?? '') };
            break;
          case 'done':
            doneSeen = true;
            if (typeof message.device === 'string') device = message.device as ComputeDevice;
            if (message.report && typeof message.report === 'object') report = message.report as Record<string, unknown>;
            if (Array.isArray(message.stems)) {
              // The done message is authoritative: streamed stem messages are
              // progress information and must not be counted twice.
              stems.length = 0;
              for (const entry of message.stems as Record<string, unknown>[]) {
                stems.push({
                  index: typeof entry.index === 'number' ? entry.index : undefined,
                  name: String(entry.name ?? ''),
                  path: String(entry.path ?? ''),
                });
              }
            }
            break;
          default:
            logs.push(trimmed);
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 32000) stderr = stderr.slice(-16000);
    });

    child.on('error', (error) => {
      reject(classifyFailure('BACKEND_UNAVAILABLE', `Backend-Prozess fehlgeschlagen: ${options.command}`, error));
    });
    child.on('close', () => finish());
  });
}

/** Probes an executable with `--version` style arguments without failing. */
export async function probeExecutable(
  command: string,
  args: string[] = ['--version'],
  timeoutMs = 8000,
  env?: Record<string, string>
): Promise<{ found: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch (error) {
      resolve({ found: false, detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ found: false, detail: 'Zeitüberschreitung' });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ found: false, detail: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Only a clean exit counts: a runtime that prints an ImportError to
      // stderr is not available, no matter how much it printed.
      resolve({ found: code === 0, detail: out.trim().slice(0, 200) });
    });
  });
}
