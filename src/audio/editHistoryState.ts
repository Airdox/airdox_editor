import type { EditHistoryEntry } from '../types/rekordbox';

export const MAX_EDIT_HISTORY_STEPS = 30;

export interface EditHistoryState {
  undoStack: EditHistoryEntry[];
  redoStack: EditHistoryEntry[];
}

export type EditHistoryAction =
  | { type: 'PUSH'; entry: EditHistoryEntry }
  | { type: 'UNDO'; trackId: string; current: EditHistoryEntry }
  | { type: 'REDO'; trackId: string; current: EditHistoryEntry }
  | { type: 'CLEAR' };

export const EMPTY_EDIT_HISTORY: EditHistoryState = {
  undoStack: [],
  redoStack: [],
};

function capHistory(stack: EditHistoryEntry[]): EditHistoryEntry[] {
  return stack.length > MAX_EDIT_HISTORY_STEPS ? stack.slice(-MAX_EDIT_HISTORY_STEPS) : stack;
}

function lastIndexForTrack(stack: EditHistoryEntry[], trackId: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].trackId === trackId) return index;
  }
  return -1;
}

function removeAt(stack: EditHistoryEntry[], index: number): EditHistoryEntry[] {
  return [...stack.slice(0, index), ...stack.slice(index + 1)];
}

export function editHistoryReducer(state: EditHistoryState, action: EditHistoryAction): EditHistoryState {
  switch (action.type) {
    case 'PUSH':
      return {
        undoStack: capHistory([...state.undoStack, action.entry]),
        // A new branch invalidates redo for this deck, not unrelated decks.
        redoStack: state.redoStack.filter((entry) => entry.trackId !== action.entry.trackId),
      };
    case 'UNDO': {
      const targetIndex = lastIndexForTrack(state.undoStack, action.trackId);
      if (targetIndex < 0) return state;
      return {
        undoStack: removeAt(state.undoStack, targetIndex),
        redoStack: capHistory([...state.redoStack, action.current]),
      };
    }
    case 'REDO': {
      const targetIndex = lastIndexForTrack(state.redoStack, action.trackId);
      if (targetIndex < 0) return state;
      return {
        undoStack: capHistory([...state.undoStack, action.current]),
        redoStack: removeAt(state.redoStack, targetIndex),
      };
    }
    case 'CLEAR':
      return EMPTY_EDIT_HISTORY;
  }
}
