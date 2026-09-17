/**
 * One-click installer with progress events
 */

export interface InstallProgress {
  phase: 'start' | 'log' | 'done' | 'error';
  detail?: string;
  code?: number;
  isError?: boolean;
  script?: string;
}

export async function installModels(model: 'bsroformer' | 'demucs' | 'all' = 'all', onProgress?: (p: InstallProgress) => void): Promise<{ success: boolean; stdout: string }> {
  onProgress?.({ phase: 'start', script: model });

  // Try desktop installer
  try {
    // @ts-ignore
    if (window.stemEngine && typeof window.stemEngine.install === 'function') {
      // @ts-ignore
      const off = window.stemEngine.onInstallProgress?.((data) => {
        onProgress?.(data);
      });
      // @ts-ignore
      const result = await window.stemEngine.install({ model });
      off?.();
      onProgress?.({ phase: 'done' });
      return result;
    }
  } catch (e) {
    onProgress?.({ phase: 'error', detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  // Fallback: instruct user to run npm script
  const msg = `Desktop installer not available. Run: npm run stems:setup${model === 'bsroformer' ? ':bsroformer' : ''}`;
  onProgress?.({ phase: 'error', detail: msg });
  throw new Error(msg);
}

export async function checkInstall(): Promise<{ modelDir: string; checkpointExists: boolean; checkpointPath: string; envSet: boolean }> {
  try {
    // @ts-ignore
    if (window.stemEngine && typeof window.stemEngine.checkInstall === 'function') {
      // @ts-ignore
      return await window.stemEngine.checkInstall();
    }
  } catch {}
  return {
    modelDir: './models',
    checkpointExists: false,
    checkpointPath: './models/bsroformer-musdb18hq-4stem-zfturbo.ckpt',
    envSet: false,
  };
}
