/**
 * Device status diagnostics endpoint stem.runtime.diagnostics (§13).
 *
 * Must deliver:
 * pythonVersion, pythonPath, torchVersion, cudaAvailable, cudaVersion,
 * gpuName, gpuMemory, modelPath, configPath, checkpointPath,
 * checkpointSha256, modelStatus, engineStatus
 */

import { resolveStemRuntime, resolveStemModel, getStemRuntimeDiagnosticsBase } from './pathResolver';
import { resolvePythonRuntime } from './pythonRuntime';
import { ModelRegistryV2 } from './modelRegistry';
import { computeSha256 } from './checkpointIntegrity';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface GpuInfo {
  cudaAvailable: boolean;
  cudaVersion: string | null;
  gpuName: string | null;
  gpuMemory: string | null;
  device: string;
}

export interface StemRuntimeDiagnostics {
  // Runtime
  pythonVersion: string | null;
  pythonPath: string | null;
  torchVersion: string | null;
  cudaAvailable: boolean;
  cudaVersion: string | null;
  gpuName: string | null;
  gpuMemory: string | null;
  // Model
  modelPath: string | null;
  configPath: string | null;
  checkpointPath: string | null;
  checkpointSha256: string | null;
  modelStatus: string;
  engineStatus: string;
  // Extended
  runtime: {
    isProduction: boolean;
    isAsar: boolean;
    platform: string;
    arch: string;
    resourcesPath: string | null;
    appDataRoot: string;
    candidates: string[];
  };
  models: Array<{
    modelId: string;
    status: string;
    checkpointPath: string | null;
    configPath: string | null;
    checkpointSha256: string | null;
    verified: boolean;
    reason?: string;
  }>;
  backend: {
    python: {
      available: boolean;
      version: string | null;
      path: string | null;
      hasTorch: boolean;
      torchVersion: string | null;
      reason?: string;
    };
    gpu: GpuInfo;
  };
  timestamp: number;
}

async function getGpuInfo(pythonPath: string | null): Promise<GpuInfo> {
  if (!pythonPath) {
    return {
      cudaAvailable: false,
      cudaVersion: null,
      gpuName: null,
      gpuMemory: null,
      device: 'cpu',
    };
  }

  const script = `
import json
try:
    import torch
    result = {
        "cudaAvailable": torch.cuda.is_available(),
        "cudaVersion": torch.version.cuda if hasattr(torch.version, 'cuda') else None,
        "device": "cuda" if torch.cuda.is_available() else "cpu"
    }
    if torch.cuda.is_available():
        try:
            result["gpuName"] = torch.cuda.get_device_name(0)
        except:
            result["gpuName"] = None
        try:
            props = torch.cuda.get_device_properties(0)
            result["gpuMemory"] = f"{props.total_memory // (1024*1024)} MB"
        except:
            result["gpuMemory"] = None
    else:
        result["gpuName"] = None
        result["gpuMemory"] = None
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"cudaAvailable": False, "cudaVersion": None, "gpuName": None, "gpuMemory": None, "device": "cpu", "error": str(e)}))
`.trim();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonPath, ['-c', script], { windowsHide: true });
    } catch {
      resolve({
        cudaAvailable: false,
        cudaVersion: null,
        gpuName: null,
        gpuMemory: null,
        device: 'cpu',
      });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        cudaAvailable: false,
        cudaVersion: null,
        gpuName: null,
        gpuMemory: null,
        device: 'cpu',
      });
    }, 8000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const last = stdout.trim().split('\n').pop() || '{}';
        const parsed = JSON.parse(last);
        resolve({
          cudaAvailable: Boolean(parsed.cudaAvailable),
          cudaVersion: parsed.cudaVersion ?? null,
          gpuName: parsed.gpuName ?? null,
          gpuMemory: parsed.gpuMemory ?? null,
          device: parsed.device ?? (parsed.cudaAvailable ? 'cuda' : 'cpu'),
        });
      } catch {
        resolve({
          cudaAvailable: false,
          cudaVersion: null,
          gpuName: null,
          gpuMemory: null,
          device: 'cpu',
        });
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        cudaAvailable: false,
        cudaVersion: null,
        gpuName: null,
        gpuMemory: null,
        device: 'cpu',
      });
    });
  });
}

export async function getStemRuntimeDiagnostics(options: {
  env?: NodeJS.ProcessEnv;
  modelId?: string;
} = {}): Promise<StemRuntimeDiagnostics> {
  const env = options.env ?? process.env;
  const base = getStemRuntimeDiagnosticsBase();
  const runtimeResolved = resolveStemRuntime({ env });
  const pythonResolved = await resolvePythonRuntime({ env });

  let registry: ModelRegistryV2 | null = null;
  try {
    registry = await ModelRegistryV2.create({ env });
  } catch {
    registry = null;
  }

  const primaryModelId = options.modelId ?? 'bsroformer-musdb18hq-4stem-zfturbo';
  const primary = registry?.get(primaryModelId);

  let checkpointSha256: string | null = null;
  if (primary?.checkpointPath) {
    try {
      const info = await stat(primary.checkpointPath);
      if (info.isFile()) {
        checkpointSha256 = await computeSha256(primary.checkpointPath);
      }
    } catch {
      checkpointSha256 = null;
    }
  }

  const gpuInfo = await getGpuInfo(pythonResolved.runtimePath);

  const models = registry
    ? registry.list().map((m) => ({
        modelId: m.modelId,
        status: m.status,
        checkpointPath: m.checkpointPath,
        configPath: m.configPath,
        checkpointSha256: m.checkpointSha256,
        verified: m.checkpointVerified,
        reason: m.reason,
      }))
    : [];

  const pythonVersion = pythonResolved.info?.pythonVersion ?? null;
  const pythonPath = pythonResolved.runtimePath ?? runtimeResolved.pythonPath ?? null;
  const torchVersion = pythonResolved.info?.torchVersion ?? null;

  const modelStatus = primary?.status ?? 'NOT_INSTALLED';
  const engineStatus = pythonResolved.available && modelStatus === 'AVAILABLE' ? 'READY' : 'UNAVAILABLE';

  return {
    pythonVersion,
    pythonPath,
    torchVersion,
    cudaAvailable: gpuInfo.cudaAvailable,
    cudaVersion: gpuInfo.cudaVersion,
    gpuName: gpuInfo.gpuName,
    gpuMemory: gpuInfo.gpuMemory,
    modelPath: primary?.checkpointPath ?? null,
    configPath: primary?.configPath ?? null,
    checkpointPath: primary?.checkpointPath ?? null,
    checkpointSha256,
    modelStatus,
    engineStatus,
    runtime: {
      isProduction: base.isProduction,
      isAsar: base.isAsar,
      platform: base.platform,
      arch: base.arch,
      resourcesPath: base.resourcesPath,
      appDataRoot: base.appDataRoot,
      candidates: runtimeResolved.candidates,
    },
    models,
    backend: {
      python: {
        available: pythonResolved.available,
        version: pythonVersion,
        path: pythonPath,
        hasTorch: pythonResolved.info?.hasTorch ?? false,
        torchVersion,
        reason: pythonResolved.reason ?? pythonResolved.info?.reason,
      },
      gpu: gpuInfo,
    },
    timestamp: Date.now(),
  };
}

export async function formatDiagnosticsReport(diag: StemRuntimeDiagnostics): Promise<string> {
  const lines: string[] = [];
  lines.push('=== AIRDOX STEM DIAGNOSTICS ===');
  lines.push('');
  lines.push('Runtime:');
  lines.push(`  Platform: ${diag.runtime.platform} ${diag.runtime.arch}`);
  lines.push(`  Production: ${diag.runtime.isProduction}`);
  lines.push(`  ASAR: ${diag.runtime.isAsar}`);
  lines.push(`  Resources: ${diag.runtime.resourcesPath ?? 'not found'}`);
  lines.push(`  AppData: ${diag.runtime.appDataRoot}`);
  lines.push(`  Python: ${diag.pythonVersion ?? 'not found'} (${diag.pythonPath ?? 'none'})`);
  lines.push(`  Candidates: ${diag.runtime.candidates.join(', ')}`);
  lines.push('');
  lines.push('Torch:');
  lines.push(`  Version: ${diag.torchVersion ?? 'not available'}`);
  lines.push(`  Has Torch: ${diag.backend.python.hasTorch}`);
  lines.push('');
  lines.push('GPU:');
  lines.push(`  CUDA: ${diag.cudaAvailable ? 'available' : 'not available'}`);
  lines.push(`  CUDA Version: ${diag.cudaVersion ?? 'n/a'}`);
  lines.push(`  GPU: ${diag.gpuName ?? 'n/a'}`);
  lines.push(`  Memory: ${diag.gpuMemory ?? 'n/a'}`);
  lines.push(`  Device: ${diag.backend.gpu.device}`);
  lines.push('');
  lines.push('Model:');
  const primary = diag.models.find((m) => m.modelId === 'bsroformer-musdb18hq-4stem-zfturbo');
  if (primary) {
    lines.push(`  ID: ${primary.modelId}`);
    lines.push(`  Status: ${primary.status}`);
    lines.push(`  Checkpoint: ${primary.checkpointPath ?? 'missing'}`);
    lines.push(`  Config: ${primary.configPath ?? 'missing'}`);
    lines.push(`  SHA256: ${diag.checkpointSha256 ?? 'not computed'}`);
    lines.push(`  Expected: ${primary.checkpointSha256}`);
    lines.push(`  Verified: ${primary.verified}`);
    if (primary.reason) lines.push(`  Reason: ${primary.reason}`);
  } else {
    lines.push('  Primary model not found');
  }
  lines.push('');
  lines.push('All Models:');
  for (const m of diag.models) {
    lines.push(`  - ${m.modelId}: ${m.status}${m.reason ? ` (${m.reason})` : ''}`);
  }
  lines.push('');
  lines.push('Engine:');
  lines.push(`  Status: ${diag.engineStatus}`);
  lines.push(`  Model Status: ${diag.modelStatus}`);
  if (diag.backend.python.reason) lines.push(`  Python Reason: ${diag.backend.python.reason}`);
  lines.push('');
  lines.push(`Timestamp: ${new Date(diag.timestamp).toISOString()}`);
  return lines.join('\n');
}
