import { spawn } from 'node:child_process';
import type { SeparationCancellationToken } from './chunkProcessor';
import { StemSeparationError } from './errors';

export interface InferenceRunnerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  token?: SeparationCancellationToken;
  onLine?: (line: string) => void;
}

export function runInferenceProcess(options: InferenceRunnerOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) options.onLine?.(line);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setInterval(() => {
      if (options.token?.isCancelled) child.kill('SIGTERM');
    }, 20);

    child.once('error', (error) => {
      clearInterval(timer);
      reject(new StemSeparationError('BACKEND_UNAVAILABLE', error.message, error));
    });

    child.once('close', (code) => {
      clearInterval(timer);
      if (options.token?.isCancelled) {
        reject(new StemSeparationError('CANCELLED', 'Inference wurde abgebrochen'));
      } else if ((code ?? 1) !== 0) {
        reject(new StemSeparationError('INFERENCE_FAILED', `Inference beendet mit Exit-Code ${code}`, stderr));
      } else {
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });
  });
}
