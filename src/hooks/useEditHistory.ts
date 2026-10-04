import { useCallback, useReducer } from 'react';
import type { EditHistoryEntry } from '../types/rekordbox';
import { editHistoryReducer, EMPTY_EDIT_HISTORY } from '../audio/editHistoryState';

function lastEntryForTrack(stack: EditHistoryEntry[], trackId: string): EditHistoryEntry | null {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].trackId === trackId) return stack[index];
  }
  return null;
}

/** UI adapter for bounded, per-track immutable EditHistoryEntry stacks. */
export function useEditHistory(activeTrackId: string | null) {
  const [state, dispatch] = useReducer(editHistoryReducer, EMPTY_EDIT_HISTORY);
  const undoStack = activeTrackId ? state.undoStack.filter((entry) => entry.trackId === activeTrackId) : [];
  const redoStack = activeTrackId ? state.redoStack.filter((entry) => entry.trackId === activeTrackId) : [];

  const push = useCallback((entry: EditHistoryEntry) => {
    dispatch({ type: 'PUSH', entry });
  }, []);

  const undo = useCallback((current: EditHistoryEntry): EditHistoryEntry | null => {
    const target = lastEntryForTrack(state.undoStack, current.trackId);
    if (!target) return null;
    dispatch({ type: 'UNDO', trackId: current.trackId, current });
    return target;
  }, [state.undoStack]);

  const redo = useCallback((current: EditHistoryEntry): EditHistoryEntry | null => {
    const target = lastEntryForTrack(state.redoStack, current.trackId);
    if (!target) return null;
    dispatch({ type: 'REDO', trackId: current.trackId, current });
    return target;
  }, [state.redoStack]);

  const clear = useCallback(() => dispatch({ type: 'CLEAR' }), []);

  return {
    undoStack,
    redoStack,
    allUndoCount: state.undoStack.length,
    allRedoCount: state.redoStack.length,
    push,
    undo,
    redo,
    clear,
  };
}
