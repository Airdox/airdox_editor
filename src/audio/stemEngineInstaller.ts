/**
 * @license
 * airdox In-App-Installer-Client für die KI-Stem-Engine.
 *
 * Ein Aufruf, zwei Transportwege:
 *  - Desktop (Electron): IPC `installStemEngine` + Progress-Events.
 *  - Browser/Dev-Server: POST /api/stems/install als Server-Sent-Events-Stream.
 *
 * Installiert exakt das Modell, das im Einstellungsmenü gewählt wurde
 * (`StemInstallOptions.modelId`). Ohne `modelId` bleibt das primäre
 * BS-RoFormer-Modell (Legacy-Verhalten). Je Checkpoint-Format führt der
 * Host die passenden Schritte aus: PyTorch-Modelle (Python-Suche,
 * Benutzer-Runtime, torch/torchaudio, Familien-Pakete, Checkpoint,
 * Test-Inferenz) und ONNX-Modelle (reiner, hashgeprüfter Download).
 */

export interface StemInstallProgressUpdate {
  step: number;
  totalSteps: number;
  percent: number;
  label: string;
  logLine?: string;
}

export interface StemInstallResult {
  ok: boolean;
  error?: string;
  python?: string;
  model?: string;
  restartRequired?: boolean;
  /**
   * Wahrheitsgemäße Abschlussmeldung des Installers. PyTorch-Modelle melden
   * „installiert und verifiziert“ (Test-Inferenz lief), ONNX-Modelle melden
   * getrennt, ob der Katalog-Hash sie prüfen kann und ob die In-Process-Runtime
   * ladbar ist.
   */
  label?: string;
  /** Handlungsrelevanter Hinweis, z. B. „Runtime nicht ladbar“ oder „Hash noch unverified“. */
  warning?: string;
  /** Berechneter SHA256 der Modelldatei (ONNX-Pfad). */
  sha256?: string;
  hashVerified?: boolean;
  runtimeAvailable?: boolean;
}

/** Installationsziel: exakt das im Einstellungsmenü gewählte Modell. */
export interface StemInstallOptions {
  /** Modell-ID aus dem Katalog (settings menu). Ohne Angabe: primäres Modell. */
  modelId?: string;
}

export async function installStemEngineWithProgress(
  onProgress: (progress: StemInstallProgressUpdate) => void,
  options: StemInstallOptions = {}
): Promise<StemInstallResult> {
  const desktop = typeof window !== 'undefined' ? window.rekordboxDesktop : undefined;

  if (desktop?.installStemEngine) {
    const unsubscribe = desktop.onStemInstallProgress
      ? desktop.onStemInstallProgress((progress) => onProgress(progress))
      : undefined;
    try {
      return await desktop.installStemEngine(options.modelId ? { modelId: options.modelId } : undefined);
    } finally {
      unsubscribe?.();
    }
  }

  // Browser path: consume the SSE stream from the local dev/production server.
  const response = await fetch('/api/stems/install', {
    method: 'POST',
    headers: options.modelId ? { 'Content-Type': 'application/json' } : undefined,
    body: options.modelId ? JSON.stringify({ modelId: options.modelId }) : undefined,
  });
  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) detail = payload.error;
    } catch { /* not JSON */ }
    return { ok: false, error: `Installation konnte nicht gestartet werden: ${detail}` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: StemInstallResult = {
    ok: false,
    error: 'Der Installations-Stream endete ohne Ergebnis.',
  };

  const handleEvent = (eventName: string, data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (eventName === 'progress') onProgress(parsed as StemInstallProgressUpdate);
      else if (eventName === 'done') result = parsed as StemInstallResult;
    } catch { /* skip malformed frame */ }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) handleEvent(eventName, dataLines.join('\n'));
    }
  }
  return result;
}
