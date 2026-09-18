/**
 * Einstellungen des Fernpfads (§15, §23, §35).
 *
 * Reihenfolge: gespeicherte Einstellung > Umgebungsvariable > Vorgabe.
 * Gespeichert wird eine kleine JSON-Datei **im Engine-Datenordner**
 * (`<root>/RemoteJobs/settings.json`) – und darin stehen ausschließlich Pfade
 * und Intervalle, niemals Tokens oder Zugangsdaten. Die Authentifizierung
 * gegenüber Google übernimmt der Drive-Client bzw. rclone des Nutzers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteTransportConfig } from './types';

export const REMOTE_SETTINGS_FILE = 'settings.json';

export interface RemoteSettingsState {
  kind?: 'folder' | 'rclone';
  root?: string;
  rcloneBinary?: string;
  rcloneConfig?: string;
  pollIntervalMs?: number;
  workerLeaseMs?: number;
  jobTimeoutMs?: number;
}

export const REMOTE_DEFAULTS = {
  /** Poll-Intervall im Editor (§20: Polling genügt für Version 1). */
  pollIntervalMs: 15_000,
  /** Ohne Lebenszeichen gilt ein beanspruchter Job als verwaist. */
  workerLeaseMs: 30 * 60_000,
  /** Absolute Obergrenze; danach FAILED mit Timeout-Grund (§21 E). */
  jobTimeoutMs: 6 * 60 * 60_000,
} as const;

export function settingsFromEnv(env: Record<string, string | undefined> = process.env): RemoteSettingsState {
  const fromEnv: RemoteSettingsState = {};
  const root = env.AIRODOX_STEM_REMOTE_DIR;
  if (root) {
    fromEnv.root = root;
    fromEnv.kind = env.AIRODOX_STEM_REMOTE_KIND === 'rclone' ? 'rclone' : 'folder';
  }
  const rcloneRemote = env.AIRODOX_STEM_REMOTE_RCLONE;
  if (rcloneRemote) {
    fromEnv.kind = 'rclone';
    fromEnv.root = rcloneRemote;
  }
  if (env.AIRODOX_STEM_REMOTE_POLL_MS) fromEnv.pollIntervalMs = Number(env.AIRODOX_STEM_REMOTE_POLL_MS);
  if (env.AIRODOX_STEM_REMOTE_LEASE_MS) fromEnv.workerLeaseMs = Number(env.AIRODOX_STEM_REMOTE_LEASE_MS);
  if (env.AIRODOX_STEM_REMOTE_TIMEOUT_MS) fromEnv.jobTimeoutMs = Number(env.AIRODOX_STEM_REMOTE_TIMEOUT_MS);
  return fromEnv;
}

/** Alle Schichten zusammenführen; spätere gewinnen. Leere Werte zählen nicht. */
export function mergeRemoteSettings(...layers: (RemoteSettingsState | undefined)[]): RemoteSettingsState {
  const merged: RemoteSettingsState = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer) as [keyof RemoteSettingsState, unknown][]) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function transportConfigFrom(settings: RemoteSettingsState): RemoteTransportConfig | undefined {
  if (!settings.root) return undefined;
  return {
    kind: settings.kind ?? 'folder',
    root: settings.root,
    binary: settings.rcloneBinary,
    configPath: settings.rcloneConfig,
  };
}

export async function loadRemoteSettingsFile(root: string): Promise<RemoteSettingsState> {
  try {
    const raw = await readFile(path.join(root, 'RemoteJobs', REMOTE_SETTINGS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as RemoteSettingsState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveRemoteSettingsFile(root: string, settings: RemoteSettingsState): Promise<string> {
  const dir = path.join(root, 'RemoteJobs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, REMOTE_SETTINGS_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await (await import('node:fs/promises')).rename(tmp, file);
  return file;
}
