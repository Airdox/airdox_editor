/**
 * @license
 * React hook for Edit Assistant State Manager
 */

import { useState, useEffect, useCallback } from 'react';
import { editAssistant } from '../audio/editAssistant';
import {
  EditAssistantState,
  BufferIntegritySummary,
  EditValidationResult,
  EditOperationType,
} from '../types/editAssistant';
import { SelectionRange } from '../types/rekordbox';

export function useEditAssistant(
  buffer?: AudioBuffer | null,
  selection?: SelectionRange | null,
  clipboard?: AudioBuffer | null
) {
  const [state, setState] = useState<EditAssistantState>(editAssistant.getState());

  useEffect(() => {
    return editAssistant.subscribe((newState) => {
      setState(newState);
    });
  }, []);

  const summary: BufferIntegritySummary = editAssistant.getIntegritySummary(
    buffer || null,
    selection || null,
    clipboard || null
  );

  const validateCopy = useCallback(
    (sel: SelectionRange | null, buf: AudioBuffer | null): EditValidationResult => {
      return editAssistant.validateCopy(sel, buf);
    },
    []
  );

  const validateCut = useCallback(
    (sel: SelectionRange | null, buf: AudioBuffer | null): EditValidationResult => {
      return editAssistant.validateCut(sel, buf);
    },
    []
  );

  const validatePaste = useCallback(
    (clip: AudioBuffer | null, buf: AudioBuffer | null, time: number): EditValidationResult => {
      return editAssistant.validatePaste(clip, buf, time);
    },
    []
  );

  const validateInsert = useCallback(
    (clip: AudioBuffer | null, buf: AudioBuffer | null, time: number): EditValidationResult => {
      return editAssistant.validateInsert(clip, buf, time);
    },
    []
  );

  const validateDelete = useCallback(
    (sel: SelectionRange | null, buf: AudioBuffer | null): EditValidationResult => {
      return editAssistant.validateDelete(sel, buf);
    },
    []
  );

  const validateClear = useCallback(
    (sel: SelectionRange | null, buf: AudioBuffer | null): EditValidationResult => {
      return editAssistant.validateClear(sel, buf);
    },
    []
  );

  const setAutoCorrect = useCallback((enabled: boolean) => {
    editAssistant.setAutoCorrect(enabled);
  }, []);

  return {
    state,
    summary,
    validateCopy,
    validateCut,
    validatePaste,
    validateInsert,
    validateDelete,
    validateClear,
    setAutoCorrect,
  };
}
