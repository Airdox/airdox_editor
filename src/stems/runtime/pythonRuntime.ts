/**
 * Python runtime handling (§7, §8, §9).
 *
 * Must NOT rely on global python/python3 in PATH for production.
 * Must handle Python 3.14 as unsupported (needs 3.9-3.13).
 * Must provide reproducible supported Python version, preferably dedicated runtime.
 */

import { spawn } from 'node:child_process';
import { resolveStemRuntime } from './pathResolver';

export interface PythonRuntimeInfo {
  pythonPath: string;
  pythonVersion: string;
  pythonVersionTuple: [number, number, number];
  executable: string;
  isSupported: boolean;
  isSystemPython: boolean;
  torchVersion?: string;
  torchaudioVersion?: string;
  hasTorch: boolean;
  hasDemucs: boolean;
  reason?: string;
}

const SUPPORTED_MINOR_RANGE: [number, number] = [9, 13]; // 3.9 - 3.13

function parseVersion(versionArray: number[]): string {
  return versionArray.join('.');
}

function isVersionSupported(major: number, minor: number): boolean {
  return major === 3 && minor >= SUPPORTED_MINOR_RANGE[0] && minor <= SUPPORTED_MINOR_RANGE[1];
}

function runProbe(pythonPath: string, script: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, code: null, error: 'Timeout' });
      }
    }, timeoutMs);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonPath, ['-c', script], { windowsHide: true });
    } catch (e) {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: null, error: err.message });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      }
    });
  });
}

export async function probePythonRuntime(pythonPath: string): Promise<PythonRuntimeInfo> {
  const script = `
import json, sys
result = {"version": list(sys.version_info[:3]), "executable": sys.executable}
try:
    import torch
    result["torch"] = torch.__version__
    result["hasTorch"] = True
    result["cudaAvailable"] = torch.cuda.is_available()
    try:
        result["cudaVersion"] = torch.version.cuda or None
    except:
        result["cudaVersion"] = None
except Exception as e:
    result["hasTorch"] = False
    result["torchError"] = str(e)
try:
    import torchaudio
    result["torchaudio"] = torchaudio.__version__
except Exception as e:
    result["torchaudioError"] = str(e)
try:
    import demucs
    result["hasDemucs"] = True
except Exception as e:
    result["hasDemucs"] = False
    result["demucsError"] = str(e)
print(json.dumps(result))
`.trim();

  const proc = await runProbe(pythonPath, script);
  if (proc.code !== 0) {
    return {
      pythonPath,
      pythonVersion: 'unknown',
      pythonVersionTuple: [0, 0, 0],
      executable: pythonPath,
      isSupported: false,
      isSystemPython: !pythonPath.includes('.venv') && !pythonPath.includes('stem-runtime'),
      hasTorch: false,
      hasDemucs: false,
      reason: proc.error || proc.stderr || `Exit code ${proc.code}`,
    };
  }

  try {
    const lastLine = proc.stdout.trim().split('\n').pop() || '';
    const parsed = JSON.parse(lastLine);
    const [major, minor, patch] = parsed.version as [number, number, number];
    const versionStr = parseVersion(parsed.version);
    const supported = isVersionSupported(major, minor);

    return {
      pythonPath,
      pythonVersion: versionStr,
      pythonVersionTuple: [major, minor, patch],
      executable: parsed.executable || pythonPath,
      isSupported: supported,
      isSystemPython: !pythonPath.includes('.venv') && !pythonPath.includes('stem-runtime'),
      torchVersion: parsed.torch,
      torchaudioVersion: parsed.torchaudio,
      hasTorch: Boolean(parsed.hasTorch),
      hasDemucs: Boolean(parsed.hasDemucs),
      reason: supported ? undefined : `Python ${versionStr} wird nicht unterstützt (benötigt 3.9–3.13)`,
    };
  } catch (e) {
    return {
      pythonPath,
      pythonVersion: 'unknown',
      pythonVersionTuple: [0, 0, 0],
      executable: pythonPath,
      isSupported: false,
      isSystemPython: true,
      hasTorch: false,
      hasDemucs: false,
      reason: `Ungültige Python-Antwort: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface ResolvedPythonRuntime {
  info: PythonRuntimeInfo | null;
  runtimePath: string | null;
  isProduction: boolean;
  candidates: string[];
  available: boolean;
  reason?: string;
}

export async function resolvePythonRuntime(options: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  resourcesPath?: string;
} = {}): Promise<ResolvedPythonRuntime> {
  const resolved = resolveStemRuntime(options);
  const candidates = resolved.candidates;

  if (!resolved.pythonPath) {
    return {
      info: null,
      runtimePath: null,
      isProduction: resolved.isProduction,
      candidates,
      available: false,
      reason: resolved.reason,
    };
  }

  const info = await probePythonRuntime(resolved.pythonPath);
  if (!info.isSupported) {
    return {
      info,
      runtimePath: resolved.pythonPath,
      isProduction: resolved.isProduction,
      candidates,
      available: false,
      reason: info.reason,
    };
  }

  return {
    info,
    runtimePath: resolved.pythonPath,
    isProduction: resolved.isProduction,
    candidates,
    available: true,
  };
}

export function getSupportedPythonRange(): string {
  return `3.${SUPPORTED_MINOR_RANGE[0]}–3.${SUPPORTED_MINOR_RANGE[1]}`;
}
