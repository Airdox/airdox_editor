/**
 * @license
 * Edit Assistant types for airdox_SMART_Editor
 * Validates selection buffer integrity, clipboard validity, and non-destructive audio editing safeguards.
 */

import { SelectionRange } from './rekordbox';

export type EditOperationType =
  | 'COPY'
  | 'CUT'
  | 'PASTE'
  | 'INSERT'
  | 'DELETE'
  | 'CLEAR'
  | 'REPLACE'
  | 'OVERDUB';

export type EditIntegrityIssueCode =
  | 'NO_SELECTION'
  | 'EMPTY_SELECTION'
  | 'SELECTION_OUT_OF_BOUNDS'
  | 'SELECTION_REVERSED'
  | 'NO_AUDIO_BUFFER'
  | 'BUFFER_ZERO_LENGTH'
  | 'BUFFER_CHANNELS_INVALID'
  | 'CLIPBOARD_EMPTY'
  | 'CLIPBOARD_ZERO_LENGTH'
  | 'PLAYHEAD_OUT_OF_BOUNDS'
  | 'DELETION_EXCEEDS_BUFFER'
  | 'SAMPLE_RATE_MISMATCH';

export interface EditIntegrityIssue {
  code: EditIntegrityIssueCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  technicalDetail?: string;
  remedy?: string;
}

export interface EditValidationMetrics {
  bufferDuration: number;
  bufferSampleRate: number;
  bufferChannels: number;
  selectionDuration?: number;
  selectionSamples?: number;
  clipboardDuration?: number;
  clipboardSamples?: number;
}

export interface EditValidationResult {
  isValid: boolean;
  operation: EditOperationType;
  issues: EditIntegrityIssue[];
  sanitizedSelection?: SelectionRange;
  sanitizedInsertionTime?: number;
  metrics?: EditValidationMetrics;
  timestamp: number;
}

export interface BufferIntegritySummary {
  hasBuffer: boolean;
  bufferDuration: number;
  bufferChannels: number;
  sampleRate: number;
  sampleCount: number;
  hasSelection: boolean;
  selectionValid: boolean;
  selectionDuration: number;
  selectionSamples: number;
  hasClipboard: boolean;
  clipboardValid: boolean;
  clipboardDuration: number;
  status: 'HEALTHY' | 'WARNING' | 'ERROR' | 'IDLE';
}

export interface EditAssistantState {
  status: 'HEALTHY' | 'WARNING' | 'ERROR' | 'IDLE';
  lastValidation: EditValidationResult | null;
  autoCorrect: boolean;
  validationHistory: EditValidationResult[];
}
