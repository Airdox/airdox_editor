/**
 * @license
 * Original Protection Agent (renderer side) — permanent monitoring.
 *
 * This agent watches every work step in the app that could touch a file.
 * Before such a step runs, the agent classifies the risk:
 *
 *  - READ of an original: allowed (originals exist to be read; the app never
 *    hides a missing source behind synthesized data).
 *  - ANY risky operation (write, append, overwrite, rename, move, delete,
 *    truncate) on a registered original source: BLOCKED. The agent opens a
 *    clear intervention popup that explains the risk comprehensively in
 *    plain language, and the operation is aborted. All work happens on
 *    working copies instead.
 *
 * DATA-INTEGRITY CONTRACT (von A bis Z): the agent is pure monitoring —
 * it never reads, writes, or modifies files itself. It only classifies,
 * blocks, and explains. Registered originals are never touched by it.
 *
 * Two layers of protection:
 *  1. This renderer agent (early, with the user-facing intervention popup).
 *  2. The main-process Original Guard (electron/originalGuard.cjs), which
 *     permanently blocks risky writes to registered originals even if this
 *     agent or the renderer is bypassed.
 */

import { PaletteClip, TrackModel } from '../types/rekordbox';

/** Operations that can touch files; READ is the only allowed one on originals. */
export type GuardOperation =
  | 'READ'
  | 'WRITE'
  | 'APPEND'
  | 'OVERWRITE'
  | 'RENAME'
  | 'MOVE'
  | 'DELETE'
  | 'TRUNCATE';

export type OriginalKind = 'AUDIO' | 'ANLZ' | 'DATABASE' | 'XML' | 'PROJECT' | 'UNKNOWN';

export interface OriginalEntry {
  path: string;
  kind: OriginalKind;
}

export interface GuardVerdict {
  allowed: boolean;
  verdict: 'ALLOWED' | 'BLOCKED_ORIGINAL';
  operation: GuardOperation;
  targetPath: string;
  originalPath?: string;
  kind?: OriginalKind;
  reason?: string;
}

/** Everything the intervention popup needs to explain the situation. */
export interface GuardIntervention {
  ts: number;
  operation: GuardOperation;
  targetPath: string;
  originalPath: string;
  kind: OriginalKind;
  explanation: {
    title: string;
    what: string;
    why: string;
    consequence: string;
    safeAlternative: string;
  };
}

const OPERATION_LABELS: Record<string, string> = {
  WRITE: 'überschreiben',
  APPEND: 'ergänzen',
  OVERWRITE: 'überschreiben',
  RENAME: 'umbenennen',
  MOVE: 'verschieben',
  DELETE: 'löschen',
  TRUNCATE: 'leeren',
  READ: 'lesen',
};

const KIND_LABELS: Record<string, string> = {
  AUDIO: 'die Original-Audiodatei',
  ANLZ: 'die Original-Analysedatei (ANLZ) von Rekordbox',
  DATABASE: 'die Original-Datenbank von Rekordbox',
  XML: 'die Original-XML-Datei von Rekordbox',
  PROJECT: 'eine Original-Quelle',
  UNKNOWN: 'eine Original-Quelle',
};

/**
 * Normalizes a path the same way the main process does (browser-safe mirror
 * of pathGuard.normalizeForCompare): slash-unified, '.'/'..' resolved,
 * case-folded. Used for consistent comparisons inside the renderer.
 */
export function normalizeComparablePath(p: string): string {
  const s = String(p).replace(/\\/g, '/');
  // Browser-safe mirror of pathGuard.normalizeForCompare: drive-letter paths
  // are a virtual root (no cwd prefix), '.'/'..' resolved, case-folded.
  const driveMatch = /^([a-zA-Z]):/.exec(s);
  const base = driveMatch ? `${driveMatch[1].toLowerCase()}:/` : '';
  const rest = driveMatch ? s.slice(driveMatch[0].length) : s;
  const parts: string[] = [];
  for (const raw of rest.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(raw.toLowerCase());
  }
  return base + parts.join('/');
}

/**
 * Pure risk classification for one operation on one path.
 * Read-only: no side effects, inputs are not mutated.
 */
export function classifyRisk(
  operation: GuardOperation,
  targetPath: string,
  originals: OriginalEntry[]
): GuardVerdict {
  const base = { operation, targetPath };
  if (operation === 'READ') {
    return { allowed: true, verdict: 'ALLOWED', ...base };
  }
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return { allowed: true, verdict: 'ALLOWED', ...base, reason: 'Kein Pfad übergeben — nichts zu schützen.' };
  }
  const key = normalizeComparablePath(targetPath);
  const original = originals.find((o) => o.path && normalizeComparablePath(o.path) === key);
  if (original) {
    return {
      allowed: false,
      verdict: 'BLOCKED_ORIGINAL',
      ...base,
      originalPath: original.path,
      kind: original.kind,
      reason: 'Originalquelle geschützt: nur Lesegriffe sind erlaubt (Read-Only).',
    };
  }
  return { allowed: true, verdict: 'ALLOWED', ...base, reason: 'Arbeitskopie oder neue Datei — Original bleibt unangetastet.' };
}

/**
 * Collects every original source path the working data refers to:
 * track media (XML LOCATION + resolved path), plus any ANLZ / database /
 * XML paths the app has learned about this session.
 */
export function collectOriginals(
  tracks: TrackModel[],
  clips: PaletteClip[],
  extra: { anlzPaths?: string[]; databasePaths?: string[]; xmlPaths?: string[] } = {}
): OriginalEntry[] {
  const map = new Map<string, OriginalEntry>();
  const add = (p: string | null | undefined, kind: OriginalKind) => {
    if (!p || typeof p !== 'string' || !p.trim()) return;
    const key = normalizeComparablePath(p);
    if (!map.has(key)) map.set(key, { path: p, kind });
  };
  for (const t of tracks) {
    add(t.originalMedia?.location, 'AUDIO');
    add(t.originalMedia?.resolvedPath, 'AUDIO');
  }
  // Palette clips reference the same source audio as their source track.
  for (const c of clips) {
    const source = tracks.find((t) => t.id === c.sourceTrackId);
    add(source?.originalMedia?.location, 'AUDIO');
    add(source?.originalMedia?.resolvedPath, 'AUDIO');
  }
  for (const p of extra.anlzPaths ?? []) add(p, 'ANLZ');
  for (const p of extra.databasePaths ?? []) add(p, 'DATABASE');
  for (const p of extra.xmlPaths ?? []) add(p, 'XML');
  return Array.from(map.values());
}

/**
 * Builds the plain-language, layperson-readable explanation for an
 * intervention. The same wording is shown in the popup.
 */
export function buildIntervention(
  verdict: GuardVerdict,
  context?: string | null
): GuardIntervention | null {
  if (verdict.allowed || !verdict.originalPath) return null;
  const kindLabel = KIND_LABELS[verdict.kind ?? 'UNKNOWN'] ?? KIND_LABELS.UNKNOWN;
  const opLabel = OPERATION_LABELS[verdict.operation] ?? verdict.operation.toLowerCase();

  const contextLine = context ? ` (Ausgelöst von: ${context})` : '';
  return {
    ts: Date.now(),
    operation: verdict.operation,
    targetPath: verdict.targetPath,
    originalPath: verdict.originalPath,
    kind: verdict.kind ?? 'UNKNOWN',
    explanation: {
      title: 'Originaldatei ist geschützt — Aktion blockiert',
      what: `Gerade wollte die Aktion „${contextLine.trim() === '(' ? 'Speichern' : context || 'Speichern/Export'}“ ${kindLabel} direkt ${opLabel}:\n„${verdict.originalPath}“`,
      why: 'Originalquellen sind die unbearbeiteten Vorlagen Ihrer Arbeit — das Audiomaterial selbst oder die Analyse, die Rekordbox daraus erzeugt hat. Airdox öffnet sie bewusst nur mit Lesezugriff, damit nichts davon verloren gehen kann. Ein einziges versehentliches Überschreiben, Umbenennen oder Löschen ist ENDGÜLTIG: Es gibt kein „Rückgängig“, keine Sicherungskopie und keinen Ersatz — und auch Ihre Rekordbox-Bibliothek würde ihr Original verlieren.',
      consequence: `Konsequenz bei Durchführung: ${kindLabel} wird dauerhaft verändert oder gelöscht — irreversibel, ohne Wiederherstellungsmöglichkeit.`,
      safeAlternative:
        'Sichere Arbeitsweise (der Standard von Airdox): Es wird immer eine ARBEITSKOPIE bearbeitet. Ihr Ergebnis wird als NEUE Datei gespeichert (z. B. „Titel – Mix.wav“). Das Original bleibt dabei zu 100 % unverändert — Sie erhalten Ihr bearbeitetes Ergebnis, ohne auch nur ein einziges Byte des Originals zu riskieren.',
    },
  };
}

/**
 * The agent: one instance per app session. Register originals (kept in sync
 * with the main-process guard) and route every risky work step through
 * guardOperation() — it returns false and opens the popup when it blocks.
 */
export class OriginalProtectionAgent {
  private originals: OriginalEntry[] = [];
  private onIntervene: ((intervention: GuardIntervention) => void) | null = null;
  private onLog: ((message: string, data?: unknown) => void) | null = null;

  /** Wires the intervention popup (and the app logger). */
  setHandler(onIntervene: (intervention: GuardIntervention) => void): void {
    this.onIntervene = onIntervene;
  }

  setLogger(onLog: (message: string, data?: unknown) => void): void {
    this.onLog = onLog;
  }

  /**
   * Syncs the known originals to this agent AND to the permanent
   * main-process guard registry. Returns how many originals are protected.
   */
  syncOriginals(entries: OriginalEntry[]): number {
    this.originals = entries;
    if (typeof window !== 'undefined' && window.rekordboxDesktop?.originalGuardRegister) {
      void window.rekordboxDesktop
        .originalGuardRegister(entries.map((e) => ({ path: e.path, kind: e.kind })))
        .catch(() => {
          // Desktop bridge unavailable (browser mode) — renderer layer stays active.
        });
    }
    return entries.length;
  }

  getProtectedCount(): number {
    return this.originals.length;
  }

  /**
   * THE entry point: route every work step that could touch a file through
   * here. Returns true when the step may continue; false when the agent
   * blocked it (the intervention popup is opened automatically).
   */
  guardOperation(operation: GuardOperation, targetPath: string, context?: string): boolean {
    const verdict = classifyRisk(operation, targetPath, this.originals);
    if (verdict.allowed) return true;
    const intervention = buildIntervention(verdict, context);
    if (intervention) {
      this.onLog?.(
        `Originalschutz: Aktion blockiert — ${operation} auf Original „${verdict.originalPath}“ (Arbeitskopie nutzen).`,
        { operation, target: targetPath, original: verdict.originalPath, kind: verdict.kind }
      );
      this.onIntervene?.(intervention);
    }
    return false;
  }

  /**
   * Parses the main-process guard rejection marker thrown by
   * rekordbox:save-export-file and converts it into an intervention, so the
   * permanent main-layer block also produces the user-facing popup.
   */
  reportMainGuardRejection(error: unknown, context?: string): GuardIntervention | null {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const match = /^ORIGINAL_GUARD_BLOCKED\|(.+)\|(.+)\|(.+)$/.exec(message);
    if (!match) return null;
    const [, targetPath, originalPath, kind] = match;
    const intervention = buildIntervention(
      {
        allowed: false,
        verdict: 'BLOCKED_ORIGINAL',
        operation: 'WRITE',
        targetPath,
        originalPath,
        kind: (['AUDIO', 'ANLZ', 'DATABASE', 'XML', 'PROJECT'].includes(kind)
          ? kind
          : 'UNKNOWN') as OriginalKind,
        reason: 'Main-Prozess-Guard: Write auf Originalquelle blockiert.',
      },
      context
    );
    if (intervention) {
      this.onLog?.(
        `Originalschutz (Main-Guard): Schreibzugriff auf Original „${originalPath}“ blockiert.`,
        { target: targetPath, original: originalPath, kind }
      );
    }
    return intervention;
  }
}
