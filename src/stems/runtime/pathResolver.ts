/**
 * Central path resolution for stem runtime and models (§34, §35).
 *
 * No scattered relative paths – this is the single source of truth.
 * Distinguishes DEV vs PRODUCTION and never hardcodes C:\Program Files.
 *
 * DEV:
 *   project/.venv/Scripts/python.exe (win) or project/.venv/bin/python3 (posix)
 *   project/models or ~/.cache/airdox-stems
 *
 * PRODUCTION (Windows):
 *   resources/stem-runtime/python.exe
 *   resources/stem-runtime/Lib/...
 *   resources/models/ OR %APPDATA%/airdox_SMART_Editor/stems/Models
 *
 * Portable builds resolve relative to executable, not hardcoded Program Files.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function getDirname(): string {
  try {
    // @ts-ignore – works in ESM
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {}
  try {
    // ESM fallback
    // @ts-ignore
    if (typeof import.meta !== 'undefined' && (import.meta as any).dirname) return (import.meta as any).dirname;
  } catch {}
  try {
    // @ts-ignore
    if (typeof import.meta !== 'undefined' && (import.meta as any).url) {
      return path.dirname(fileURLToPath((import.meta as any).url));
    }
  } catch {}
  return process.cwd();
}
const __dirnameSafe = getDirname();

export interface StemRuntimePaths {
  /** Absolute path to python executable (if found) */
  pythonPath: string | null;
  /** Directory containing the runtime (stem-runtime/) */
  runtimeDir: string | null;
  /** Whether this is a production (packaged) build */
  isProduction: boolean;
  /** Whether running inside Electron ASAR */
  isAsar: boolean;
  /** All candidate paths tried */
  candidates: string[];
  /** Reason if not found */
  reason?: string;
}

export interface StemModelPaths {
  /** Directory containing checkpoints */
  modelStoreDir: string;
  /** Full path to primary checkpoint */
  checkpointPath: string | null;
  /** Full path to config */
  configPath: string | null;
  /** All candidate dirs tried */
  candidates: string[];
}

function isElectronPackaged(): boolean {
  if (process.env.ELECTRON_IS_PACKAGED === '1') return true;
  if ((process as any).resourcesPath) return true;
  if (__dirnameSafe.includes('app.asar')) return true;
  return false;
}

function getResourcesPath(): string | null {
  const res = (process as any).resourcesPath as string | undefined;
  if (res) return res;
  const candidates = [
    path.join(process.cwd(), 'resources'),
    path.join(__dirnameSafe, '..', '..', '..', 'resources'),
    path.join(__dirnameSafe, '..', '..', 'resources'),
    path.join(__dirnameSafe, '..', 'resources'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function getAppDataStemsRoot(): string {
  // %APPDATA%/airdox_SMART_Editor/stems or ~/.config equivalent
  if (process.env.AIRDOX_STEMS_ROOT) return process.env.AIRDOX_STEMS_ROOT;
  const appName = 'airdox_SMART_Editor';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, appName, 'stems');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName, 'stems');
  }
  return path.join(os.homedir(), '.config', appName, 'stems');
}

function getRepoRoot(): string {
  let dir = __dirnameSafe;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.name === 'airdox_SMART_Editor') return dir;
      }
    } catch {}
    dir = path.join(dir, '..');
  }
  return process.cwd();
}

/**
 * Resolves the stem Python runtime.
 * Never relies on global `python` or `python3` in PATH for production.
 * System Python is only fallback/diagnosis and must be version-checked.
 */
export function resolveStemRuntime(options: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  resourcesPath?: string;
} = {}): StemRuntimePaths {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const isProd = isElectronPackaged() || Boolean(env.AIRODOX_STEM_FORCE_PRODUCTION);

  // 1. Explicit env override – highest priority
  const explicit = env.AIRODOX_STEM_PYTHON || env.DEMUCS_PYTHON;
  if (explicit && !/(^|[\\/])app\.asar([\\/]|$)/i.test(explicit)) {
    candidates.push(explicit);
    if (fs.existsSync(explicit)) {
      return {
        pythonPath: explicit,
        runtimeDir: path.dirname(explicit),
        isProduction: isProd,
        isAsar: __dirnameSafe.includes('app.asar'),
        candidates,
      };
    }
  }

  // 2. Production paths – deterministic
  const resourcesPath = options.resourcesPath ?? getResourcesPath();
  if (resourcesPath) {
    const prodCandidates = process.platform === 'win32'
      ? [
          path.join(resourcesPath, 'stem-runtime', 'python.exe'),
          path.join(resourcesPath, 'stem-runtime', 'Scripts', 'python.exe'),
          path.join(resourcesPath, 'stem-runtime', 'bin', 'python.exe'),
        ]
      : [
          path.join(resourcesPath, 'stem-runtime', 'bin', 'python3'),
          path.join(resourcesPath, 'stem-runtime', 'bin', 'python'),
        ];
    for (const c of prodCandidates) {
      candidates.push(c);
      if (fs.existsSync(c)) {
        return {
          pythonPath: c,
          runtimeDir: path.join(resourcesPath, 'stem-runtime'),
          isProduction: true,
          isAsar: __dirnameSafe.includes('app.asar'),
          candidates,
        };
      }
    }
  }

  // 3. AppData fallback for portable / installed builds where resources may be elsewhere
  const appDataRoot = getAppDataStemsRoot();
  const appDataCandidates = process.platform === 'win32'
    ? [
        path.join(appDataRoot, 'stem-runtime', 'Scripts', 'python.exe'),
        path.join(appDataRoot, 'stem-runtime', 'python.exe'),
        path.join(appDataRoot, 'runtime', 'python.exe'),
      ]
    : [
        path.join(appDataRoot, 'stem-runtime', 'bin', 'python3'),
        path.join(appDataRoot, 'runtime', 'bin', 'python3'),
      ];
  for (const c of appDataCandidates) {
    candidates.push(c);
    if (fs.existsSync(c)) {
      return {
        pythonPath: c,
        runtimeDir: path.dirname(path.dirname(c)),
        isProduction: true,
        isAsar: false,
        candidates,
      };
    }
  }

  // 4. Development paths – local venv
  const repoRoot = options.repoRoot ?? getRepoRoot();
  const devCandidates = process.platform === 'win32'
    ? [
        path.join(repoRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(repoRoot, 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(repoRoot, '.venv', 'bin', 'python3'),
        path.join(repoRoot, '.venv', 'bin', 'python'),
        path.join(repoRoot, 'venv', 'bin', 'python3'),
      ];
  for (const c of devCandidates.filter(c => !/(^|[\\/])app\.asar([\\/]|$)/i.test(c))) {
    candidates.push(c);
    if (fs.existsSync(c)) {
      return {
        pythonPath: c,
        runtimeDir: path.join(repoRoot, '.venv'),
        isProduction: false,
        isAsar: false,
        candidates,
      };
    }
  }

  // 5. System Python – ONLY as diagnostic fallback, never primary
  // We still return it as candidate but mark reason that it's system python
  // and must be version-checked (3.9-3.13 only)
  const systemCandidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const c of systemCandidates) candidates.push(c);

  return {
    pythonPath: null,
    runtimeDir: null,
    isProduction: isProd,
    isAsar: __dirnameSafe.includes('app.asar'),
    candidates,
    reason: `Keine gebundene Stem-Runtime gefunden. Kandidaten: ${candidates.join(', ')}. DEV: .venv erstellen. PROD: resources/stem-runtime/ muss existieren.`,
  };
}

/**
 * Resolves model store directory and specific checkpoint/config paths.
 * Never hardcodes C:\Program Files – uses resourcesPath or appData.
 */
export function resolveStemModel(options: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  resourcesPath?: string;
  modelId?: string;
  checkpointFile?: string;
  configFile?: string;
} = {}): StemModelPaths {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  // Placeholder directories shipped by electron-builder are not installations.
  const containsModel = (dir: string) =>
    fs.existsSync(path.join(dir, options.checkpointFile ?? 'model_bs_roformer_ep_17_sdr_9.6568.ckpt')) &&
    fs.existsSync(path.join(dir, options.configFile ?? 'config_bs_roformer_384_8_2_485100.yaml'));


  // 1. Env override wins
  const envDir = env.AIRODOX_STEM_MODEL_DIR || env.AIRODOX_STEM_CHECKPOINT_DIR;
  if (envDir) {
    candidates.push(envDir);
    return {
      modelStoreDir: envDir,
      checkpointPath: options.checkpointFile ? path.join(envDir, options.checkpointFile) : null,
      configPath: options.configFile ? path.join(envDir, options.configFile) : null,
      candidates,
    };
  }

  // 2. Production: resources/models, resources/stem-runtime/models
  const resourcesPath = options.resourcesPath ?? getResourcesPath();
  if (resourcesPath) {
    const prodDirs = [
      path.join(resourcesPath, 'models'),
      path.join(resourcesPath, 'stem-runtime', 'models'),
      path.join(resourcesPath, 'stem-runtime', 'checkpoints'),
    ];
    for (const dir of prodDirs) {
      candidates.push(dir);
      if (containsModel(dir)) {
        return {
          modelStoreDir: dir,
          checkpointPath: options.checkpointFile ? path.join(dir, options.checkpointFile) : null,
          configPath: options.configFile ? path.join(dir, options.configFile) : null,
          candidates,
        };
      }
    }
  }

  // 3. AppData: %APPDATA%/airdox_SMART_Editor/stems/Models
  const appDataRoot = getAppDataStemsRoot();
  const appDataDirs = [
    path.join(appDataRoot, 'Models'),
    path.join(appDataRoot, 'models'),
    path.join(appDataRoot, 'checkpoints'),
  ];
  for (const dir of appDataDirs) {
    candidates.push(dir);
    if (containsModel(dir)) {
      return {
        modelStoreDir: dir,
        checkpointPath: options.checkpointFile ? path.join(dir, options.checkpointFile) : null,
        configPath: options.configFile ? path.join(dir, options.configFile) : null,
        candidates,
      };
    }
  }

  // 4. Development: ~/.cache/airdox-stems, repo/models, repo/checkpoints
  const homeCache = path.join(os.homedir(), '.cache', 'airdox-stems');
  const repoRoot = options.repoRoot ?? getRepoRoot();
  const devDirs = [
    path.join(homeCache, 'checkpoints'),
    path.join(homeCache, 'models'),
    path.join(homeCache),
    path.join(repoRoot, 'models'),
    path.join(repoRoot, 'checkpoints'),
    path.join(repoRoot, '.cache', 'airdox-stems', 'checkpoints'),
  ];
  for (const dir of devDirs) {
    candidates.push(dir);
    if (containsModel(dir)) {
      return {
        modelStoreDir: dir,
        checkpointPath: options.checkpointFile ? path.join(dir, options.checkpointFile) : null,
        configPath: options.configFile ? path.join(dir, options.configFile) : null,
        candidates,
      };
    }
  }

  // Fallback: return first dev dir as default even if not exists
  const fallback = path.join(homeCache, 'checkpoints');
  candidates.push(fallback);
  return {
    modelStoreDir: fallback,
    checkpointPath: options.checkpointFile ? path.join(fallback, options.checkpointFile) : null,
    configPath: options.configFile ? path.join(fallback, options.configFile) : null,
    candidates,
  };
}

export function isRunningInAsar(): boolean {
  return __dirnameSafe.includes('app.asar') || (process as any).resourcesPath?.includes('app.asar') || false;
}

export function getStemRuntimeDiagnosticsBase(): {
  platform: string;
  arch: string;
  isProduction: boolean;
  isAsar: boolean;
  resourcesPath: string | null;
  appDataRoot: string;
  repoRoot: string;
} {
  return {
    platform: process.platform,
    arch: process.arch,
    isProduction: isElectronPackaged(),
    isAsar: isRunningInAsar(),
    resourcesPath: getResourcesPath(),
    appDataRoot: getAppDataStemsRoot(),
    repoRoot: getRepoRoot(),
  };
}
