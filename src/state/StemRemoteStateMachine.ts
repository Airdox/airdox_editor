/**
 * StemRemoteStateMachine — Zustandsmaschine für den Google-Drive / Colab-Workflow
 * Master-Plan Phase 2 → Phase 10 (10 Phasen abgebildet in 7 Hauptzuständen)
 *
 * Zustände und Übergänge (gemäß Prompt §3):
 *   IDLE
 *     ↓ [Start Remote Stem]
 *   CHECKING_WORKER  (Phase 5 — Pre-Flight Gatekeeper, worker.status.json)
 *     ↓ [Worker erreichbar < 75 s]  |  ↓ [Stale / nicht erreichbar → ERROR_TIMEOUT]
 *   UPLOADING        (Phase 1 — Original-Datei kopiert, kein WAV-Bloat)
 *     ↓ [Upload / Manifest geschrieben]
 *   WAITING_CLAIM    (Phase 6 — claim.lock erwartet)
 *     ↓ [claim.lock gefunden]  |  ↓ [Timeout → ERROR_NO_CLAIM]
 *   PROCESSING       (Phase 7 — Fortschritt via progress.json, Phase 8 — done.json)
 *     ↓ [done.json gefunden + Integrity OK]  |  ↓ [Fehler / Timeout]
 *   SYNCING_BACK     (Phase 9 — Lokale Sync und Integritätsprüfung)
 *     ↓ [Alle 4 Stems validiert, Byte-Größen + Hash OK, nicht gesperrt]
 *   LOADED_IN_DECK   (Phase 10 — Audio-Engine-Injektion, Raster/Cues, Modal schließen, Cleanup)
 *     ↓ [Asynchroner Cleanup-Trigger] → IDLE
 */

export type StateName =
  | 'IDLE'
  | 'CHECKING_WORKER'
  | 'UPLOADING'
  | 'WAITING_CLAIM'
  | 'PROCESSING'
  | 'SYNCING_BACK'
  | 'LOADED_IN_DECK'
  | 'ERROR_TIMEOUT'
  | 'ERROR_NO_CLAIM'
  | 'ERROR_INTEGRITY'
  | 'ERROR_DECK';

export interface Transition {
  from: StateName;
  to: StateName;
  trigger: string;
  timeoutMs?: number;
  requireCondition?: (ctx: StateContext) => boolean;
}

export interface StateContext {
  jobId: string;
  bridgeRoot: string;
  workerStatusAgeSec: number;
  inputFilePath?: string;
  claimLocked?: boolean;
  progressPercent?: number;
  progressPhase?: string;
  doneManifest?: any;
  integrityOk?: boolean;
  deckLoaded?: boolean;
  cleanupQueued?: boolean;
  errors: string[];
  startedAt: number;
}

export interface StateMeta {
  name: StateName;
  description: string;
  phaseNumbers: number[]; // welche Master-Plan-Phasen abgedeckt
  timeoutDefaultMs: number;
  exitOnError?: boolean;
}

const STATE_META: Record<StateName, StateMeta> = {
  IDLE: {
    name: 'IDLE',
    description: 'Worker bereit, keine aktive Stem-Separation',
    phaseNumbers: [0],
    timeoutDefaultMs: 0,
  },
  CHECKING_WORKER: {
    name: 'CHECKING_WORKER',
    description: 'Phase 5 — Pre-Flight Gatekeeper: Prüfe worker.status.json (Heartbeat < 75 s)',
    phaseNumbers: [5],
    timeoutDefaultMs: 90000,
    exitOnError: true,
  },
  UPLOADING: {
    name: 'UPLOADING',
    description: 'Phase 1 — Originaldatei atomar kopieren (kein 32-Bit-Float-WAV-Bloat); Phase 2 — Ordnerstruktur',
    phaseNumbers: [1, 2],
    timeoutDefaultMs: 120000,
  },
  WAITING_CLAIM: {
    name: 'WAITING_CLAIM',
    description: 'Phase 6 — Auf claim.lock warten (Colab hat Job angenommen)',
    phaseNumbers: [6],
    timeoutDefaultMs: 120000,
  },
  PROCESSING: {
    name: 'PROCESSING',
    description: 'Phase 7 — Live-Fortschritt (progress.json); Phase 8 — Abgeschlossen (done.json + Manifest)',
    phaseNumbers: [7, 8],
    timeoutDefaultMs: 600000, // 10 min für Inferenz
  },
  SYNCING_BACK: {
    name: 'SYNCING_BACK',
    description: 'Phase 9 — Lokale Sync- und Integritätsprüfung (Byte-Größen, Hash, nicht gesperrt)',
    phaseNumbers: [9],
    timeoutDefaultMs: 60000,
  },
  LOADED_IN_DECK: {
    name: 'LOADED_IN_DECK',
    description: 'Phase 10 — Deck-Übernahme (Audio-Engine, Raster/Cues, Fader, Modal schließen, Cleanup)',
    phaseNumbers: [10],
    timeoutDefaultMs: 30000,
  },
  ERROR_TIMEOUT: {
    name: 'ERROR_TIMEOUT',
    description: 'Gatekeeper-Timeout oder Gesamt-Timeout — Colab-Worker nicht erreichbar',
    phaseNumbers: [5],
    timeoutDefaultMs: 0,
    exitOnError: true,
  },
  ERROR_NO_CLAIM: {
    name: 'ERROR_NO_CLAIM',
    description: 'Claim-Timeout — Worker hat Job nie übernommen',
    phaseNumbers: [6],
    timeoutDefaultMs: 0,
    exitOnError: true,
  },
  ERROR_INTEGRITY: {
    name: 'ERROR_INTEGRITY',
    description: 'Integritätsfehler — Dateien unvollständig oder Hash-Mismatch',
    phaseNumbers: [9],
    timeoutDefaultMs: 0,
    exitOnError: true,
  },
  ERROR_DECK: {
    name: 'ERROR_DECK',
    description: 'Deck-Fehler — AudioContext-Injektion oder Cue-Bindung fehlgeschlagen',
    phaseNumbers: [10],
    timeoutDefaultMs: 0,
    exitOnError: true,
  },
};

export class StemRemoteStateMachine {
  private state: StateName = 'IDLE';
  private ctx: StateContext;
  private timer: NodeJS.Timeout | null = null;
  private transitions: Transition[];

  constructor(initialCtx: Partial<StateContext> = {}) {
    this.ctx = {
      jobId: initialCtx.jobId || `job-${Date.now()}`,
      bridgeRoot: initialCtx.bridgeRoot || '/content/drive/MyDrive/airdox_stem_bridge',
      workerStatusAgeSec: initialCtx.workerStatusAgeSec ?? Infinity,
      errors: initialCtx.errors || [],
      startedAt: initialCtx.startedAt ?? Date.now(),
      ...initialCtx,
    };

    this.transitions = this.buildTransitions();
  }

  private buildTransitions(): Transition[] {
    return [
      // IDLE → CHECKING_WORKER
      { from: 'IDLE', to: 'CHECKING_WORKER', trigger: 'START_REMOTE_STEM', timeoutMs: 0 },
      // CHECKING_WORKER → UPLOADING (Worker erreichbar)
      { from: 'CHECKING_WORKER', to: 'UPLOADING', trigger: 'WORKER_OK', timeoutMs: 90000, requireCondition: (c) => c.workerStatusAgeSec < 75 },
      // CHECKING_WORKER → ERROR_TIMEOUT (Stale / nicht erreichbar)
      { from: 'CHECKING_WORKER', to: 'ERROR_TIMEOUT', trigger: 'WORKER_STALE', timeoutMs: 90000, requireCondition: (c) => c.workerStatusAgeSec >= 75 },
      // UPLOADING → WAITING_CLAIM (Manifest + Input geschrieben)
      { from: 'UPLOADING', to: 'WAITING_CLAIM', trigger: 'INPUT_READY', timeoutMs: 120000 },
      // WAITING_CLAIM → PROCESSING (claim.lock gefunden)
      { from: 'WAITING_CLAIM', to: 'PROCESSING', trigger: 'CLAIM_FOUND', timeoutMs: 120000, requireCondition: (c) => !!c.claimLocked },
      // WAITING_CLAIM → ERROR_NO_CLAIM (Timeout)
      { from: 'WAITING_CLAIM', to: 'ERROR_NO_CLAIM', trigger: 'CLAIM_TIMEOUT', timeoutMs: 120000, requireCondition: (c) => !c.claimLocked },
      // PROCESSING → SYNCING_BACK (done.json gefunden + Fortschritt 100 %)
      { from: 'PROCESSING', to: 'SYNCING_BACK', trigger: 'DONE_FOUND', timeoutMs: 600000, requireCondition: (c) => !!c.doneManifest && (c.progressPercent ?? 0) >= 100 },
      // PROCESSING → ERROR_TIMEOUT (Inferenz zu lange / Fehler)
      { from: 'PROCESSING', to: 'ERROR_TIMEOUT', trigger: 'INFERENCE_TIMEOUT', timeoutMs: 600000, requireCondition: (c) => (c.errors.length > 0) },
      // SYNCING_BACK → LOADED_IN_DECK (Integrität OK)
      { from: 'SYNCING_BACK', to: 'LOADED_IN_DECK', trigger: 'INTEGRITY_OK', timeoutMs: 60000, requireCondition: (c) => !!c.integrityOk },
      // SYNCING_BACK → ERROR_INTEGRITY (Fehler)
      { from: 'SYNCING_BACK', to: 'ERROR_INTEGRITY', trigger: 'INTEGRITY_FAIL', timeoutMs: 60000, requireCondition: (c) => c.integrityOk === false },
      // LOADED_IN_DECK → IDLE (Cleanup queued / Reset)
      { from: 'LOADED_IN_DECK', to: 'IDLE', trigger: 'RESET', timeoutMs: 30000, requireCondition: (c) => !!c.cleanupQueued },
      // LOADED_IN_DECK → ERROR_DECK (Deck-Fehler)
      { from: 'LOADED_IN_DECK', to: 'ERROR_DECK', trigger: 'DECK_FAIL', timeoutMs: 30000, requireCondition: (c) => (c.errors.filter(e => e.includes('Deck') || e.includes('Audio')).length > 0) },
    ];
  }

  getState(): StateName {
    return this.state;
  }

  getMeta(): StateMeta {
    return STATE_META[this.state];
  }

  getContext(): Readonly<StateContext> {
    return { ...this.ctx };
  }

  /**
   * Hauptübergang — prüft Bedingung und timeout, dann wechselt Zustand.
   */
  transition(trigger: string, updates?: Partial<StateContext>, force?: boolean): boolean {
    // Updates zuerst anwenden, damit Bedingungen mit neuem Kontext geprüft werden
    if (updates) {
      this.ctx = { ...this.ctx, ...updates, errors: updates.errors !== undefined ? updates.errors : this.ctx.errors };
    }
    const t = this.transitions.find(
      (tr) => tr.from === this.state && tr.trigger === trigger && (force || !tr.requireCondition || tr.requireCondition(this.ctx))
    );
    if (!t) {
      // Fallback: Prüfung aller möglichen Übergänge aus aktuellem Zustand
      const fallback = this.transitions.find(
        (tr) => tr.from === this.state && tr.trigger === trigger
      );
      if (!fallback) return false;
      // Wenn Bedingung nicht erfüllt, nicht wechseln
      if (fallback.requireCondition && !fallback.requireCondition(this.ctx)) {
        return false;
      }
    }

    const next = t ? t.to : (this.transitions.find(tr => tr.from === this.state && tr.trigger === trigger)?.to);
    if (!next) return false;

    // Timeout-Handler auf alten Zustand aufräumen
    this.clearTimeout();

    // Kontext aktualisieren

    // Zustand wechseln
    const prev = this.state;
    this.state = next;
    this.ctx = { ...this.ctx, errors: this.ctx.errors };

    // Neubeginn Timer für Timeout (wenn definiert)
    const meta = STATE_META[this.state];
    if (meta.timeoutDefaultMs > 0) {
      this.timer = setTimeout(() => {
        // Automatischer Timeout-Übergang (nur für bestimmte Fehler-Zustände)
        if (this.state === 'CHECKING_WORKER') this.transition('WORKER_STALE', { errors: [...this.ctx.errors, 'Pre-Flight-Timeout: Worker nicht erreichbar'] });
        else if (this.state === 'WAITING_CLAIM') this.transition('CLAIM_TIMEOUT', { errors: [...this.ctx.errors, 'Claim-Timeout: Worker hat nicht übernommen'] });
        else if (this.state === 'PROCESSING') this.transition('INFERENCE_TIMEOUT', { errors: [...this.ctx.errors, 'Inferenz-Timeout'] });
        else if (this.state === 'SYNCING_BACK') this.transition('INTEGRITY_FAIL', { errors: [...this.ctx.errors, 'Integritäts-Timeout'] });
      }, meta.timeoutDefaultMs);
    }

    return true;
  }

  private clearTimeout(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Status-Meldung für Modal / UI (deutsche Fehlermeldungen gemäß Prompt)
   */
  getUserMessage(): string {
    const meta = this.getMeta();
    switch (this.state) {
      case 'IDLE':
        return 'Bereit für Stem-Separation. Klicke auf „Start Remote Stem“.';
      case 'CHECKING_WORKER':
        return `Colab-Worker prüfen... (Heartbeat ${this.ctx.workerStatusAgeSec}s alt)`;
      case 'UPLOADING':
        return 'Originaldatei wird atomar in die Bridge kopiert (Phase 1 — kein WAV-Bloat).';
      case 'WAITING_CLAIM':
        return 'Warte auf Colab-Worker: noch kein Lebenszeichen eines Workers in der Ablage (Phase 6).';
      case 'PROCESSING':
        return `BS-RoFormer Inferenz läuft... (${this.ctx.progressPercent ?? 0} % — ${this.ctx.progressPhase ?? 'Initialisierung'})`;
      case 'SYNCING_BACK':
        return 'Stems synchronisieren und Integrität prüfen (Phase 9 — Byte-Größen + Hash + Cloud-Lock).';
      case 'LOADED_IN_DECK':
        return 'Stem-Spuren im Deck geladen — Beatgrid & Cues gebunden (Phase 10).';
      case 'ERROR_TIMEOUT':
        return 'Colab-Worker nicht erreichbar. Bitte Notebook-Laufzeit prüfen und Worker-Zelle ausführen. (Phase 5 Gatekeeper)';
      case 'ERROR_NO_CLAIM':
        return 'Job vom Worker nicht angenommen (Claim-Timeout). Bitte Notebook neu starten (Phase 6).';
      case 'ERROR_INTEGRITY':
        return 'Integritätsprüfung fehlgeschlagen — Dateien unvollständig oder Hash-Mismatch (Phase 9).';
      case 'ERROR_DECK':
        return 'Deck-Übernahme fehlgeschlagen — AudioContext-Fehler oder Cue-Bindung (Phase 10).';
      default:
        return meta.description;
    }
  }

  /**
   * Vollständiger Lebenszyklus als Beispiel-Sequenz (für Tests / Dokumentation)
   */
  static fullLifecycleExample(): string[] {
    return [
      'IDLE',
      'CHECKING_WORKER (Phase 5)',
      'UPLOADING (Phase 1 + 2)',
      'WAITING_CLAIM (Phase 6)',
      'PROCESSING (Phase 7 + 8)',
      'SYNCING_BACK (Phase 9)',
      'LOADED_IN_DECK (Phase 10)',
      'IDLE (Cleanup + Reset)',
    ];
  }

  destroy(): void {
    this.clearTimeout();
  }
}
