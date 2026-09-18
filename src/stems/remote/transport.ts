/**
 * Transport für den Fernpfad (§15, §16, §23).
 *
 * Zwei Betriebsarten, dieselbe Semantik (relative POSIX-Pfade, atomare
 * Schreibvorgänge, klare „nicht erreichbar“-Fehler):
 *
 *  - `folder` – ein **Ordner**, den Google Drive synchronisiert (Drive für
 *    Desktop, rclone-Mount, gemountetes Netzwerk-Laufwerk). Das ist die
 *    Voreinstellung, weil sie ohne jede Zugangsdaten im Editor auskommt: die
 *    Authentifizierung macht der Drive-Client des Nutzers, nicht diese App
 *    (§23 – keine OAuth-Tokens im Repository, keine Credentials im Code).
 *  - `rclone` – ein rclone-Remote (`gdrive:airdox-stem-jobs`). Auch hier liegt
 *    das Geheimnis in der rclone-Konfiguration des Nutzers; der Editor ruft nur
 *    die CLI auf und protokolliert niemals deren Inhalt.
 *
 * Ein Ausfall des Transports ist ein **temporärer** Zustand, kein Job-Fehler
 * (§21 C): `probe()` und alle Leseoperationen werfen `RemoteUnreachableError`,
 * und der Aufrufer entscheidet, ob er wartet oder abbricht.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteTransportConfig } from './types';
import { REMOTE_JOBS_DIR } from './layout';

const run = promisify(execFile);

export class RemoteUnreachableError extends Error {
  readonly code = 'REMOTE_UNREACHABLE';
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RemoteUnreachableError';
    this.details = details;
  }
}

export const REMOTE_TRANSPORT_MISSING = 'REMOTE_TRANSPORT_MISSING';

export interface IRemoteTransport {
  readonly kind: 'folder' | 'rclone';
  /** Anzeigename für die UI – nie ein Pfad mit Zugangsdaten. */
  readonly label: string;
  /** Ziel (Ordner bzw. Remote:pfad). */
  readonly target: string;
  /** Wirft `RemoteUnreachableError`, wenn der Transport nicht benutzbar ist. */
  probe(): Promise<void>;
  readText(relative: string): Promise<string | null>;
  writeText(relative: string, text: string): Promise<void>;
  readBytes(relative: string): Promise<Uint8Array | null>;
  writeBytes(relative: string, bytes: Uint8Array): Promise<void>;
  exists(relative: string): Promise<boolean>;
  /** Namen in einem Ordner (ohne Pfad). Fehlender Ordner ⇒ leere Liste. */
  list(relativeDir: string): Promise<string[]>;
  remove(relative: string): Promise<void>;
  /** Größe in Bytes, `null` wenn nicht vorhanden. */
  size(relative: string): Promise<number | null>;
  /** SHA-256 des Inhalts (Streaming), `null` wenn nicht vorhanden. */
  sha256(relative: string): Promise<string | null>;
}

function toLocal(root: string, relative: string): string {
  return path.join(root, ...relative.split('/').filter(Boolean));
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/** Prüft, ob ein Verzeichnis existiert und schreibbar ist. */
async function probeFolder(root: string): Promise<void> {
  if (!root) {
    throw new RemoteUnreachableError('Kein Ablageordner konfiguriert (Remote-Pfad fehlt).');
  }
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new RemoteUnreachableError(`Der konfigurierte Remote-Pfad ist kein Ordner: ${root}`, { root });
    }
  } catch (error) {
    if (error instanceof RemoteUnreachableError) throw error;
    throw new RemoteUnreachableError(
      `Google-Drive-Ordner nicht erreichbar: ${root}. Ist Drive für Desktop gestartet bzw. das Laufwerk verbunden?`,
      { root, cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Ordner-Transport (Google Drive für Desktop, rclone-Mount, Netzwerkpfad).
 *
 * Schreibvorgänge laufen über `<datei>.tmp` + `rename`: Drive sieht so nie eine
 * halb geschriebene Manifest-Datei, und ein abgebrochener Upload kann keinen
 * Job in einen widersprüchlichen Zustand bringen.
 */
export class FolderTransport implements IRemoteTransport {
  readonly kind = 'folder' as const;
  readonly label: string;
  readonly target: string;
  private readonly root: string;

  constructor(config: { root: string; label?: string }) {
    this.root = path.resolve(config.root);
    this.target = this.root;
    this.label = config.label ?? 'Google Drive (Ordner)';
  }

  async probe(): Promise<void> {
    await probeFolder(this.root);
    await mkdir(toLocal(this.root, REMOTE_JOBS_DIR), { recursive: true });
  }

  async readText(relative: string): Promise<string | null> {
    const file = toLocal(this.root, relative);
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return null;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
        throw new RemoteUnreachableError(`Datei vorübergehend nicht lesbar (${code}): ${relative}`, { relative });
      }
      throw error;
    }
  }

  async writeText(relative: string, text: string): Promise<void> {
    await this.writeBytes(relative, new TextEncoder().encode(text));
  }

  async readBytes(relative: string): Promise<Uint8Array | null> {
    const file = toLocal(this.root, relative);
    try {
      return await readFile(file);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return null;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
        // Drive synchronisiert im Hintergrund: eine Datei kann kurz gesperrt
        // sein. Das ist ein Transport-, kein Job-Problem.
        throw new RemoteUnreachableError(`Datei vorübergehend nicht lesbar (${code}): ${relative}`, { relative });
      }
      throw error;
    }
  }

  async writeBytes(relative: string, bytes: Uint8Array): Promise<void> {
    const file = toLocal(this.root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EBUSY') {
        throw new RemoteUnreachableError(`Schreiben in den Drive-Ordner fehlgeschlagen (${code}): ${relative}`, {
          relative,
          code,
        });
      }
      throw error;
    }
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await stat(toLocal(this.root, relative));
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir: string): Promise<string[]> {
    try {
      const entries = await readdir(toLocal(this.root, relativeDir), { withFileTypes: true });
      // Drive legt temporäre Dateien an (`.tmp`, `~$…`): die gehören nicht in
      // die Auswertung, sonst „findet“ der Poll halbe Uploads als Job.
      return entries
        .filter((entry) => !entry.name.startsWith('.') && !entry.name.endsWith('.tmp'))
        .map((entry) => entry.name);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return [];
      throw new RemoteUnreachableError(`Ordner nicht lesbar (${code}): ${relativeDir}`, { relativeDir });
    }
  }

  async remove(relative: string): Promise<void> {
    await rm(toLocal(this.root, relative), { force: true, recursive: false });
  }

  async size(relative: string): Promise<number | null> {
    try {
      const info = await stat(toLocal(this.root, relative));
      return info.size;
    } catch {
      return null;
    }
  }

  async sha256(relative: string): Promise<string | null> {
    const file = toLocal(this.root, relative);
    try {
      await stat(file);
    } catch {
      return null;
    }
    return sha256OfFile(file);
  }
}

/**
 * rclone-Transport. Nutzt die Konfiguration des Nutzers (`rclone config`) –
 * der Editor sieht und speichert keine Tokens (§23). Fehlt das Binary oder ist
 * das Remote nicht konfiguriert, meldet `probe()` das im Klartext, statt einen
 * Job in einen unklaren Zustand laufen zu lassen.
 */
export class RcloneTransport implements IRemoteTransport {
  readonly kind = 'rclone' as const;
  readonly label = 'Google Drive (rclone)';
  readonly target: string;
  private readonly binary: string;
  private readonly configPath?: string;

  constructor(config: { root: string; binary?: string; configPath?: string }) {
    this.target = config.root.replace(/\/+$/, '');
    this.binary = config.binary ?? process.env.AIRODOX_STEM_REMOTE_RCLONE ?? 'rclone';
    this.configPath = config.configPath;
  }

  private args(base: string[]): string[] {
    return this.configPath ? [...base, '--config', this.configPath] : base;
  }

  private async call(base: string[], timeoutMs = 120_000): Promise<string> {
    try {
      const { stdout } = await run(this.binary, this.args(base), { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
      return stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RemoteUnreachableError(
        `rclone-Aufruf fehlgeschlagen (${this.binary}). Ist rclone installiert und das Remote konfiguriert? ${detail.slice(0, 300)}`,
        { target: this.target }
      );
    }
  }

  private remote(relative: string): string {
    return `${this.target}/${relative.replace(/^\/+/, '')}`;
  }

  async probe(): Promise<void> {
    await this.call(['about', this.target, '--json'], 60_000);
  }

  async readText(relative: string): Promise<string | null> {
    try {
      return await this.call(['cat', this.remote(relative)], 60_000);
    } catch (error) {
      if (error instanceof RemoteUnreachableError && /not found|object not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async writeText(relative: string, text: string): Promise<void> {
    await this.writeBytes(relative, new TextEncoder().encode(text));
  }

  async readBytes(relative: string): Promise<Uint8Array | null> {
    const file = await this.materialise(relative);
    if (!file) return null;
    const bytes = await readFile(file);
    await rm(file, { force: true }).catch(() => undefined);
    return bytes;
  }

  /** Lokaler Zwischenspeicher für rclone-Übertragungen. */
  private async scratchDir(): Promise<string> {
    return path.join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', `airdox-remote-${process.pid}`);
  }

  async writeBytes(relative: string, bytes: Uint8Array): Promise<void> {
    const tmpDir = await this.scratchDir();
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${createHash('sha1').update(relative).digest('hex').slice(0, 12)}.tmp`);
    await writeFile(tmpFile, bytes);
    try {
      await this.call(['copyto', tmpFile, this.remote(relative)], 600_000);
    } finally {
      await rm(tmpFile, { force: true }).catch(() => undefined);
    }
  }

  private async materialise(relative: string): Promise<string | null> {
    const tmpDir = await this.scratchDir();
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, path.basename(relative));
    try {
      await this.call(['copyto', this.remote(relative), tmpFile], 600_000);
      return tmpFile;
    } catch (error) {
      if (error instanceof RemoteUnreachableError && /not found|object not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async exists(relative: string): Promise<boolean> {
    const listed = await this.list(path.posix.dirname(relative));
    return listed.includes(path.posix.basename(relative));
  }

  async list(relativeDir: string): Promise<string[]> {
    try {
      const out = await this.call(['lsf', '--files-only', this.remote(relativeDir)], 60_000);
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.endsWith('.tmp'));
    } catch (error) {
      if (error instanceof RemoteUnreachableError && /not found|directory not found/i.test(error.message)) return [];
      throw error;
    }
  }

  async remove(relative: string): Promise<void> {
    await this.call(['deletefile', this.remote(relative)], 60_000).catch(() => undefined);
  }

  async size(relative: string): Promise<number | null> {
    try {
      const out = await this.call(['size', this.remote(relative), '--json'], 60_000);
      const parsed = JSON.parse(out) as { bytes?: number };
      return typeof parsed.bytes === 'number' ? parsed.bytes : null;
    } catch {
      return null;
    }
  }

  async sha256(relative: string): Promise<string | null> {
    try {
      const out = await this.call(['hashsum', 'sha256', this.remote(relative)], 300_000);
      const match = out.trim().split(/\s+/)[0];
      return match && /^[0-9a-f]{64}$/i.test(match) ? match.toLowerCase() : null;
    } catch {
      return null;
    }
  }
}

export function createTransport(config: RemoteTransportConfig | undefined): IRemoteTransport {
  if (!config || !config.root) {
    throw new RemoteUnreachableError(
      'Kein Google-Drive-Ziel konfiguriert. Einstellungen → „High Quality extern“: Ordner des Drive-Clients auswählen ' +
        'oder ein rclone-Remote angeben (AIRODOX_STEM_REMOTE_DIR / AIRODOX_STEM_REMOTE_RCLONE).'
    );
  }
  if (config.kind === 'rclone') {
    return new RcloneTransport({ root: config.root, binary: config.binary, configPath: config.configPath });
  }
  return new FolderTransport({ root: config.root });
}
