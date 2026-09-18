/**
 * Prozessweite Laufzeit-Verdikte verwerfen.
 *
 * `runtimeProbe` und `onnxSeparator` cachen ihre Ergebnisse bewusst
 * prozessweit (ein Statusaufruf darf nicht jedes Mal `import torch` bzw. die
 * native ONNX-Runtime laden). Genau diese Caches müssen nach einer
 * Installation geleert werden – sonst meldet die App weiter „nicht
 * verfügbar“, obwohl die Dateien gerade angekommen sind.
 *
 * Aufrufer: `electron/stemEngineBridge.cjs` (Desktop, nach
 * `refreshRuntime()`), `server.ts` (Dev/Browser, nach `/api/stems/install`)
 * und die Tests.
 */
import { clearTorchProbeCache } from './backends/runtimeProbe';
import { resetSharedOnnxRuntime } from './backends/onnxSeparator';
import { clearModelHashCache } from './modelManager';

export async function clearRuntimeCaches(): Promise<void> {
  // Positive Verdikte bleiben (ein installiertes PyTorch verschwindet nicht
  // durch ein Installationsskript), negative werden verworfen – sie sind der
  // Grund, warum die App nach einer Installation weiter „nicht verfügbar“ sah.
  clearTorchProbeCache({ keepPositive: true });
  await resetSharedOnnxRuntime();
  clearModelHashCache();
}
