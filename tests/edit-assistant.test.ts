/**
 * @license
 * Edit Assistant State Manager & Buffer Integrity Test Suite
 */

import { EditAssistantStateManager } from '../src/audio/editAssistant';
import { SelectionRange } from '../src/types/rekordbox';

// Minimal AudioBuffer mock for node environment
function createMockAudioBuffer(durationSec: number, sampleRate = 44100, channels = 2): AudioBuffer {
  const length = Math.floor(durationSec * sampleRate);
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(new Float32Array(length));
  }
  return {
    duration: durationSec,
    length,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (c: number) => channelData[c] || new Float32Array(length),
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

function runTests() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  EDIT ASSISTANT BUFFER INTEGRITY & SAFETY VALIDATION SUITE        ');
  console.log('═══════════════════════════════════════════════════════════════════');

  const assistant = new EditAssistantStateManager();
  const mockBuffer = createMockAudioBuffer(60.0); // 60 seconds

  // Test 1: Copy with no selection
  {
    const res = assistant.validateCopy(null, mockBuffer);
    if (res.isValid || !res.issues.some((i) => i.code === 'NO_SELECTION')) {
      throw new Error('Test 1 Failed: Expected NO_SELECTION error');
    }
    console.log('[ PASS ] #1 [Copy] Rejects null selection with clear remedy');
  }

  // Test 2: Copy with no buffer
  {
    const sel: SelectionRange = { start: 0, end: 4, duration: 4, barsCount: 2, beatsCount: 8 };
    const res = assistant.validateCopy(sel, null);
    if (res.isValid || !res.issues.some((i) => i.code === 'NO_AUDIO_BUFFER')) {
      throw new Error('Test 2 Failed: Expected NO_AUDIO_BUFFER error');
    }
    console.log('[ PASS ] #2 [Copy] Rejects operation when active audio buffer is missing');
  }

  // Test 3: Auto-correct reversed selection
  {
    assistant.setAutoCorrect(true);
    const reversedSel: SelectionRange = { start: 10, end: 4, duration: 6, barsCount: 3, beatsCount: 12 };
    const res = assistant.validateCopy(reversedSel, mockBuffer);
    if (!res.isValid) {
      throw new Error('Test 3 Failed: Reversed selection should be auto-corrected when autoCorrect is true');
    }
    if (!res.sanitizedSelection || res.sanitizedSelection.start !== 4 || res.sanitizedSelection.end !== 10) {
      throw new Error('Test 3 Failed: Reversed selection was not properly swapped');
    }
    console.log('[ PASS ] #3 [Auto-Correct] Inverted selection automatically swapped and normalized');
  }

  // Test 4: Auto-correct out of bounds end
  {
    assistant.setAutoCorrect(true);
    const oobSel: SelectionRange = { start: 50, end: 75, duration: 25, barsCount: 12, beatsCount: 48 };
    const res = assistant.validateCopy(oobSel, mockBuffer);
    if (!res.isValid || !res.sanitizedSelection) {
      throw new Error('Test 4 Failed: Out of bounds end should be clamped');
    }
    if (res.sanitizedSelection.end !== 60.0) {
      throw new Error(`Test 4 Failed: Expected end to be clamped to 60.0, got ${res.sanitizedSelection.end}`);
    }
    console.log('[ PASS ] #4 [Auto-Correct] Out-of-bounds selection safely anchored to track duration');
  }

  // Test 5: Paste with null clipboard
  {
    const res = assistant.validatePaste(null, mockBuffer, 10.0);
    if (res.isValid || !res.issues.some((i) => i.code === 'CLIPBOARD_EMPTY')) {
      throw new Error('Test 5 Failed: Expected CLIPBOARD_EMPTY error');
    }
    console.log('[ PASS ] #5 [Paste] Blocks paste when clipboard buffer is empty');
  }

  // Test 6: Paste with valid clipboard
  {
    const clip = createMockAudioBuffer(4.0);
    const res = assistant.validatePaste(clip, mockBuffer, 10.0);
    if (!res.isValid) {
      throw new Error('Test 6 Failed: Valid paste should pass');
    }
    if (res.sanitizedInsertionTime !== 10.0) {
      throw new Error('Test 6 Failed: Expected sanitizedInsertionTime = 10.0');
    }
    console.log('[ PASS ] #6 [Paste] Confirms valid clipboard buffer insertion');
  }

  // Test 7: Delete entire track safeguard
  {
    const entireTrackSel: SelectionRange = { start: 0, end: 60.0, duration: 60.0, barsCount: 30, beatsCount: 120 };
    const res = assistant.validateDelete(entireTrackSel, mockBuffer);
    if (res.isValid || !res.issues.some((i) => i.code === 'DELETION_EXCEEDS_BUFFER')) {
      throw new Error('Test 7 Failed: Expected DELETION_EXCEEDS_BUFFER error to prevent complete track wipeout');
    }
    console.log('[ PASS ] #7 [Safety Gate] Prevents catastrophic deletion of entire track');
  }

  // Test 8: Valid partial delete
  {
    const validDel: SelectionRange = { start: 4.0, end: 8.0, duration: 4.0, barsCount: 2, beatsCount: 8 };
    const res = assistant.validateDelete(validDel, mockBuffer);
    if (!res.isValid) {
      throw new Error('Test 8 Failed: Valid partial delete should succeed');
    }
    console.log('[ PASS ] #8 [Delete] Validates safe range removal');
  }

  // Test 9: Clear (Mute) validation
  {
    const clearSel: SelectionRange = { start: 8.0, end: 12.0, duration: 4.0, barsCount: 2, beatsCount: 8 };
    const res = assistant.validateClear(clearSel, mockBuffer);
    if (!res.isValid) {
      throw new Error('Test 9 Failed: Valid clear should succeed');
    }
    console.log('[ PASS ] #9 [Clear] Confirms non-destructive silence buffer operation');
  }

  // Test 10: autoCorrectSelection helper method
  {
    const badSel: SelectionRange = { start: 80, end: 100, duration: 20, barsCount: 10, beatsCount: 40 };
    const fixed = assistant.autoCorrectSelection(badSel, 60.0);
    if (fixed.end > 60.0 || fixed.start >= 60.0) {
      throw new Error(`Test 10 Failed: Expected bounds inside 60.0, got ${fixed.start} -> ${fixed.end}`);
    }
    console.log('[ PASS ] #10 [Selection Repair] autoCorrectSelection clamps and repairs invalid bounds');
  }

  console.log('───────────────────────────────────────────────────────────────────');
  console.log('Total: 10 | Passed: 10 | Failed: 0');
  console.log('═══════════════════════════════════════════════════════════════════');
}

runTests();
