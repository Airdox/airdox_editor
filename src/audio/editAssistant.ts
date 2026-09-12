/**
 * @license
 * Edit Assistant State Manager for airdox_SMART_Editor
 * Validates audio buffer & selection integrity prior to destructive/timeline operations
 * (Copy, Cut, Paste, Insert, Delete, Clear, Replace, Overdub).
 * Safeguards against buffer corruption, zero-length slices, NaN bounds, and out-of-bounds indexing.
 */

import { SelectionRange } from '../types/rekordbox';
import {
  EditOperationType,
  EditValidationResult,
  EditIntegrityIssue,
  BufferIntegritySummary,
  EditAssistantState,
} from '../types/editAssistant';
import { logger } from '../utils/logger';

export class EditAssistantStateManager {
  private state: EditAssistantState = {
    status: 'IDLE',
    lastValidation: null,
    autoCorrect: true,
    validationHistory: [],
  };

  private listeners = new Set<(state: EditAssistantState) => void>();

  public getState(): EditAssistantState {
    return { ...this.state };
  }

  public setAutoCorrect(enabled: boolean): void {
    this.state.autoCorrect = enabled;
    this.notify();
  }

  public subscribe(listener: (state: EditAssistantState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const currentState = this.getState();
    this.listeners.forEach((l) => {
      try {
        l(currentState);
      } catch (err) {
        logger.error('EDITING', `Error in EditAssistant listener: ${err instanceof Error ? err.message : String(err)}`, { error: err });
      }
    });
  }

  private recordValidation(result: EditValidationResult): void {
    const hasError = result.issues.some((i) => i.severity === 'error');
    const hasWarning = result.issues.some((i) => i.severity === 'warning');

    let status: 'HEALTHY' | 'WARNING' | 'ERROR' | 'IDLE' = 'HEALTHY';
    if (hasError) {
      status = 'ERROR';
    } else if (hasWarning) {
      status = 'WARNING';
    }

    this.state = {
      ...this.state,
      status,
      lastValidation: result,
      validationHistory: [result, ...this.state.validationHistory.slice(0, 29)],
    };

    if (hasError) {
      logger.warn(
        'EDITING',
        `[EditAssistant] Blocked ${result.operation} due to integrity issues: ${result.issues.map((i) => i.message).join(' | ')}`
      );
    } else if (hasWarning) {
      logger.info(
        'EDITING',
        `[EditAssistant] ${result.operation} validated with warnings: ${result.issues.map((i) => i.message).join(' | ')}`
      );
    }

    this.notify();
  }

  /**
   * Safely auto-corrects selection boundaries within the track duration.
   */
  public autoCorrectSelection(selection: SelectionRange, maxDuration: number): SelectionRange {
    let start = Math.max(0, selection.start);
    let end = Math.max(0, selection.end);
    if (start > end) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    if (start >= maxDuration) {
      start = Math.max(0, maxDuration - 1.0);
    }
    if (end > maxDuration) {
      end = maxDuration;
    }
    if (end <= start) {
      end = Math.min(maxDuration, start + 0.5);
    }
    const duration = end - start;
    return {
      ...selection,
      start,
      end,
      duration,
    };
  }

  /**
   * Validate working AudioBuffer health.
   */
  public checkAudioBufferIntegrity(buffer: AudioBuffer | null): {
    healthy: boolean;
    issues: EditIntegrityIssue[];
  } {
    const issues: EditIntegrityIssue[] = [];

    if (!buffer) {
      issues.push({
        code: 'NO_AUDIO_BUFFER',
        severity: 'error',
        message: 'Kein aktiver Audio-Puffer im Deck vorhanden.',
        remedy: 'Lade oder verknüpfe zuerst eine Audiodatei (WAV, MP3, FLAC, AIFF) mit dem Track.',
      });
      return { healthy: false, issues };
    }

    if (buffer.length <= 0 || buffer.duration <= 0) {
      issues.push({
        code: 'BUFFER_ZERO_LENGTH',
        severity: 'error',
        message: 'Der Audio-Puffer hat eine Länge von 0 Samples.',
        remedy: 'Überprüfe die Quelldatei oder lade den Track neu.',
      });
      return { healthy: false, issues };
    }

    if (buffer.numberOfChannels <= 0) {
      issues.push({
        code: 'BUFFER_CHANNELS_INVALID',
        severity: 'error',
        message: 'Der Audio-Puffer besitzt keine gültigen Audiokanäle (0 Kanäle).',
      });
      return { healthy: false, issues };
    }

    try {
      const chData = buffer.getChannelData(0);
      if (!chData || chData.length !== buffer.length) {
        issues.push({
          code: 'BUFFER_CHANNELS_INVALID',
          severity: 'error',
          message: 'Audiodaten im Speicherkanal sind inkonsistent oder beschädigt.',
        });
        return { healthy: false, issues };
      }
    } catch (e) {
      issues.push({
        code: 'BUFFER_CHANNELS_INVALID',
        severity: 'error',
        message: `Kanalzugriffsfehler: ${e instanceof Error ? e.message : 'Unbekannter Pufferfehler'}`,
      });
      return { healthy: false, issues };
    }

    return { healthy: true, issues };
  }

  /**
   * Validates selection range and buffer boundaries for selection-based operations
   * (Copy, Cut, Delete, Clear, etc.).
   */
  public validateSelectionBufferIntegrity(
    selection: SelectionRange | null,
    buffer: AudioBuffer | null,
    operation: EditOperationType
  ): EditValidationResult {
    const issues: EditIntegrityIssue[] = [];
    const timestamp = Date.now();

    // 1. Buffer check
    const bufCheck = this.checkAudioBufferIntegrity(buffer);
    issues.push(...bufCheck.issues);

    if (!bufCheck.healthy || !buffer) {
      const res: EditValidationResult = {
        isValid: false,
        operation,
        issues,
        timestamp,
      };
      this.recordValidation(res);
      return res;
    }

    // 2. Selection null check
    if (!selection) {
      issues.push({
        code: 'NO_SELECTION',
        severity: 'error',
        message: 'Kein Audio-Bereich ausgewählt.',
        remedy: 'Markiere einen Taktbereich mit den Beat-Select-Tasten (z. B. 4, 8, 16 Beats) oder ziehe eine Auswahl in der Waveform.',
      });
      const res: EditValidationResult = {
        isValid: false,
        operation,
        issues,
        metrics: {
          bufferDuration: buffer.duration,
          bufferSampleRate: buffer.sampleRate,
          bufferChannels: buffer.numberOfChannels,
        },
        timestamp,
      };
      this.recordValidation(res);
      return res;
    }

    // 3. Finite numbers check
    if (!Number.isFinite(selection.start) || !Number.isFinite(selection.end)) {
      issues.push({
        code: 'EMPTY_SELECTION',
        severity: 'error',
        message: 'Die Zeitkoordinaten der Auswahl enthalten ungültige Zahlenwerte (NaN/Infinity).',
      });
      const res: EditValidationResult = {
        isValid: false,
        operation,
        issues,
        timestamp,
      };
      this.recordValidation(res);
      return res;
    }

    let sanitizedStart = Math.max(0, selection.start);
    let sanitizedEnd = Math.max(0, selection.end);

    // 4. Reversed selection check
    if (sanitizedStart > sanitizedEnd) {
      if (this.state.autoCorrect) {
        const tmp = sanitizedStart;
        sanitizedStart = sanitizedEnd;
        sanitizedEnd = tmp;
        issues.push({
          code: 'SELECTION_REVERSED',
          severity: 'warning',
          message: 'Auswahl war invertiert und wurde automatisch korrigiert (Start ↔ Ende).',
        });
      } else {
        issues.push({
          code: 'SELECTION_REVERSED',
          severity: 'error',
          message: 'Startzeit der Auswahl liegt hinter der Endzeit.',
        });
      }
    }

    // 5. Minimum duration / sample check
    const rawDuration = sanitizedEnd - sanitizedStart;
    const rate = buffer.sampleRate;
    const selectionSamples = Math.floor(rawDuration * rate);

    if (rawDuration < 0.0005 || selectionSamples <= 0) {
      issues.push({
        code: 'EMPTY_SELECTION',
        severity: 'error',
        message: `Auswahldauer ist zu klein (${rawDuration.toFixed(4)}s / 0 Samples). Mindestens 1 Millisekunde erforderlich.`,
        remedy: 'Vergrößere die Auswahl über die Beat-Select-Leiste.',
      });
    }

    // 6. Out-of-bounds checks
    if (sanitizedStart >= buffer.duration) {
      issues.push({
        code: 'SELECTION_OUT_OF_BOUNDS',
        severity: 'error',
        message: `Auswahlstart (${sanitizedStart.toFixed(3)}s) liegt hinter dem Track-Ende (${buffer.duration.toFixed(3)}s).`,
        remedy: 'Verschiebe die Auswahl in den Bereich des Tracks.',
      });
    } else if (sanitizedEnd > buffer.duration) {
      if (this.state.autoCorrect) {
        const diff = sanitizedEnd - buffer.duration;
        sanitizedEnd = buffer.duration;
        issues.push({
          code: 'SELECTION_OUT_OF_BOUNDS',
          severity: 'warning',
          message: `Auswahlende überstieg Track-Länge um +${diff.toFixed(3)}s und wurde am Track-Ende verankert.`,
        });
      } else {
        issues.push({
          code: 'SELECTION_OUT_OF_BOUNDS',
          severity: 'error',
          message: `Auswahlende (${sanitizedEnd.toFixed(3)}s) übersteigt die Track-Länge (${buffer.duration.toFixed(3)}s).`,
        });
      }
    }

    // 7. Delete-specific safeguards
    if (operation === 'DELETE') {
      const delSamples = Math.floor(sanitizedEnd * rate) - Math.floor(sanitizedStart * rate);
      const remainingSamples = buffer.length - delSamples;

      if (remainingSamples <= 0 || (sanitizedStart <= 0.001 && sanitizedEnd >= buffer.duration - 0.001)) {
        issues.push({
          code: 'DELETION_EXCEEDS_BUFFER',
          severity: 'error',
          message: 'Vollständiges Löschen des gesamten Tracks verhindert (Ergebnis wäre ein leerer Puffer).',
          remedy: 'Nutze stattdessen "Stummschalten (Clear)" oder lade einen neuen Track.',
        });
      }
    }

    const sanitizedDuration = Math.max(0, sanitizedEnd - sanitizedStart);
    const sanitizedSelection: SelectionRange = {
      ...selection,
      start: sanitizedStart,
      end: sanitizedEnd,
      duration: sanitizedDuration,
    };

    const hasError = issues.some((i) => i.severity === 'error');
    const res: EditValidationResult = {
      isValid: !hasError,
      operation,
      issues,
      sanitizedSelection: !hasError ? sanitizedSelection : undefined,
      metrics: {
        bufferDuration: buffer.duration,
        bufferSampleRate: buffer.sampleRate,
        bufferChannels: buffer.numberOfChannels,
        selectionDuration: sanitizedDuration,
        selectionSamples: Math.floor(sanitizedDuration * rate),
      },
      timestamp,
    };

    this.recordValidation(res);
    return res;
  }

  /**
   * Validates clipboard buffer integrity prior to Paste / Insert operations.
   */
  public validateClipboardBufferIntegrity(
    clipboard: AudioBuffer | null,
    targetBuffer: AudioBuffer | null,
    insertionTime: number,
    operation: EditOperationType
  ): EditValidationResult {
    const issues: EditIntegrityIssue[] = [];
    const timestamp = Date.now();

    // 1. Target buffer check
    const targetCheck = this.checkAudioBufferIntegrity(targetBuffer);
    issues.push(...targetCheck.issues);

    if (!targetCheck.healthy || !targetBuffer) {
      const res: EditValidationResult = {
        isValid: false,
        operation,
        issues,
        timestamp,
      };
      this.recordValidation(res);
      return res;
    }

    // 2. Clipboard check
    if (!clipboard) {
      issues.push({
        code: 'CLIPBOARD_EMPTY',
        severity: 'error',
        message: 'Die Zwischenablage ist leer.',
        remedy: 'Kopiere zuerst einen Audio-Bereich mit COPY (Strg+C).',
      });
      const res: EditValidationResult = {
        isValid: false,
        operation,
        issues,
        metrics: {
          bufferDuration: targetBuffer.duration,
          bufferSampleRate: targetBuffer.sampleRate,
          bufferChannels: targetBuffer.numberOfChannels,
        },
        timestamp,
      };
      this.recordValidation(res);
      return res;
    }

    if (clipboard.length <= 0 || clipboard.duration <= 0) {
      issues.push({
        code: 'CLIPBOARD_ZERO_LENGTH',
        severity: 'error',
        message: 'Die Zwischenablage enthält 0 Audiodaten-Samples.',
        remedy: 'Kopiere einen gültigen Taktbereich erneut.',
      });
    }

    // 3. Playhead insertion time check
    let sanitizedTime = insertionTime;
    if (!Number.isFinite(sanitizedTime) || sanitizedTime < 0) {
      sanitizedTime = 0;
      issues.push({
        code: 'PLAYHEAD_OUT_OF_BOUNDS',
        severity: 'warning',
        message: 'Ungültige Playhead-Position – Einfügen wurde auf 0.000s korrigiert.',
      });
    } else if (sanitizedTime > targetBuffer.duration + 0.5) {
      sanitizedTime = targetBuffer.duration;
      issues.push({
        code: 'PLAYHEAD_OUT_OF_BOUNDS',
        severity: 'warning',
        message: `Playhead (${insertionTime.toFixed(3)}s) lag hinter dem Track-Ende – Material wird direkt am Track-Ende (${targetBuffer.duration.toFixed(3)}s) angefügt.`,
      });
    }

    // 4. Sample Rate check
    if (clipboard.sampleRate !== targetBuffer.sampleRate) {
      issues.push({
        code: 'SAMPLE_RATE_MISMATCH',
        severity: 'info',
        message: `Abtastraten-Hinweis: Zwischenablage (${clipboard.sampleRate}Hz) weicht von Deck-Puffer (${targetBuffer.sampleRate}Hz) ab.`,
      });
    }

    const hasError = issues.some((i) => i.severity === 'error');
    const res: EditValidationResult = {
      isValid: !hasError,
      operation,
      issues,
      sanitizedInsertionTime: sanitizedTime,
      metrics: {
        bufferDuration: targetBuffer.duration,
        bufferSampleRate: targetBuffer.sampleRate,
        bufferChannels: targetBuffer.numberOfChannels,
        clipboardDuration: clipboard.duration,
        clipboardSamples: clipboard.length,
      },
      timestamp,
    };

    this.recordValidation(res);
    return res;
  }

  // Convenience methods for direct call sites
  public validateCopy(selection: SelectionRange | null, buffer: AudioBuffer | null): EditValidationResult {
    return this.validateSelectionBufferIntegrity(selection, buffer, 'COPY');
  }

  public validateCut(selection: SelectionRange | null, buffer: AudioBuffer | null): EditValidationResult {
    return this.validateSelectionBufferIntegrity(selection, buffer, 'CUT');
  }

  public validateDelete(selection: SelectionRange | null, buffer: AudioBuffer | null): EditValidationResult {
    return this.validateSelectionBufferIntegrity(selection, buffer, 'DELETE');
  }

  public validateClear(selection: SelectionRange | null, buffer: AudioBuffer | null): EditValidationResult {
    return this.validateSelectionBufferIntegrity(selection, buffer, 'CLEAR');
  }

  public validatePaste(
    clipboard: AudioBuffer | null,
    targetBuffer: AudioBuffer | null,
    playheadTime: number
  ): EditValidationResult {
    return this.validateClipboardBufferIntegrity(clipboard, targetBuffer, playheadTime, 'PASTE');
  }

  public validateInsert(
    clipboard: AudioBuffer | null,
    targetBuffer: AudioBuffer | null,
    playheadTime: number
  ): EditValidationResult {
    return this.validateClipboardBufferIntegrity(clipboard, targetBuffer, playheadTime, 'INSERT');
  }

  /**
   * Generates a real-time status summary of buffer and selection integrity.
   */
  public getIntegritySummary(
    buffer: AudioBuffer | null,
    selection: SelectionRange | null,
    clipboard: AudioBuffer | null
  ): BufferIntegritySummary {
    const hasBuffer = !!buffer && buffer.length > 0;
    const hasSelection = !!selection && selection.duration > 0;
    const hasClipboard = !!clipboard && clipboard.length > 0;

    let selectionValid = false;
    let selectionSamples = 0;
    if (hasBuffer && hasSelection && selection) {
      const isWithinBounds = selection.start >= 0 && selection.end <= buffer.duration + 0.05;
      selectionValid = isWithinBounds && selection.duration > 0.0005;
      selectionSamples = Math.floor(selection.duration * buffer.sampleRate);
    }

    const clipboardValid = hasClipboard && (clipboard?.duration || 0) > 0;

    let status: 'HEALTHY' | 'WARNING' | 'ERROR' | 'IDLE' = 'IDLE';
    if (hasBuffer) {
      if (hasSelection && !selectionValid) {
        status = 'WARNING';
      } else {
        status = 'HEALTHY';
      }
    }

    return {
      hasBuffer,
      bufferDuration: buffer?.duration || 0,
      bufferChannels: buffer?.numberOfChannels || 0,
      sampleRate: buffer?.sampleRate || 0,
      sampleCount: buffer?.length || 0,
      hasSelection,
      selectionValid,
      selectionDuration: selection?.duration || 0,
      selectionSamples,
      hasClipboard,
      clipboardValid,
      clipboardDuration: clipboard?.duration || 0,
      status,
    };
  }
}

export const editAssistant = new EditAssistantStateManager();
