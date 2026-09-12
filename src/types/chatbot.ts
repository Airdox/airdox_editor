/**
 * @license
 * Rekordbox DJ Editor - Chatbot Copilot Types
 */

export type ChatbotModel =
  | 'gemini-3.5-flash'
  | 'gemini-3.1-flash-lite'
  | 'gemini-3.1-pro-preview';

export type ChatbotActionType =
  | 'SET_ZOOM'
  | 'SEEK_TO'
  | 'SELECT_RANGE'
  | 'ADD_CUE'
  | 'ADD_MEMORY_CUE'
  | 'SHIFT_BEATGRID'
  | 'PERFORM_EDIT'
  | 'SET_QUANTIZE'
  | 'SET_WAVEFORM_MODE'
  | 'ADD_TO_PALETTE'
  | 'AUTO_ALIGN_GRID'
  | 'SET_MIX_IN_POINT';

export interface ChatbotAction {
  id: string;
  type: ChatbotActionType;
  label: string;
  description?: string;
  params: Record<string, any>;
  executed?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
  actions?: ChatbotAction[];
  model?: string;
}

export interface TrackEditorContext {
  title?: string;
  artist?: string;
  bpm?: number;
  key?: string;
  duration?: number;
  currentTime?: number;
  currentBar?: number;
  hasSelection?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  selectionBeats?: number;
  selectionBars?: number;
  hasClipboard?: boolean;
  quantize?: boolean;
  waveformMode?: string;
  paletteClipsCount?: number;
  undoCount?: number;
  redoCount?: number;
  mixInAnalysis?: any;
}
