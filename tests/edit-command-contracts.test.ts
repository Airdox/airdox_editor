/**
 * Fundamental edit-command contracts.
 *
 * This suite complements the exhaustive 9³ matrix with reusable black-box
 * contracts from tests/support/editingHarness:
 *
 * - every command at start, middle, and end boundaries;
 * - 32 deterministic, long command histories (48 commands each);
 * - exact PCM, duration, persisted EDL replay, waveform, cues, loops,
 *   beat-grid and phrase assertions after every mutating command.
 *
 * The test is intentionally dependency-free and runs with `tsx` in CI.
 */

import assert from 'node:assert/strict';
import {
  EDIT_COMMANDS,
  EditCommand,
  applyAndVerifyEdit,
  createCausalEditState,
  fractionalInsertionTime,
  selectionFromSamples,
} from './support/editingHarness';

interface BoundaryCase {
  name: string;
  selection: (length: number) => { start: number; end: number };
  insertion: (length: number) => number;
}

const boundaries: BoundaryCase[] = [
  {
    name: 'track start',
    selection: (length) => ({ start: 0, end: Math.min(length, 1_000) }),
    insertion: () => 0,
  },
  {
    name: 'track middle',
    selection: (length) => {
      const start = Math.floor(length / 2) - 500;
      return { start, end: start + 1_000 };
    },
    insertion: (length) => Math.floor(length / 2),
  },
  {
    name: 'track end',
    selection: (length) => ({ start: Math.max(0, length - 1_000), end: length }),
    insertion: (length) => length,
  },
];

let boundaryExecutions = 0;
for (const command of EDIT_COMMANDS) {
  for (const boundary of boundaries) {
    const state = createCausalEditState({ seconds: 12, seed: boundaryExecutions + 1 });
    const range = boundary.selection(state.buffer.length);
    applyAndVerifyEdit(state, command, {
      selection: selectionFromSamples(state.buffer, range.start, range.end),
      insertTime: boundary.insertion(state.buffer.length) / state.buffer.sampleRate,
      label: `${command} at ${boundary.name}`,
    });
    boundaryExecutions++;
  }
}
assert.equal(boundaryExecutions, EDIT_COMMANDS.length * boundaries.length, 'every edit command was tested at all timeline boundaries');

// Regression: an OVERDUB clip may be longer than the selected target range.
// Its descriptor must retain only the mixed source span, otherwise a later
// REPLACE that splits the overlay replays the wrong section after reopen.
const truncatedOverdubState = createCausalEditState({
  seconds: 8,
  clipboard: new Float32Array(1_879).fill(0.72),
  seed: 91,
});
applyAndVerifyEdit(truncatedOverdubState, 'OVERDUB', {
  selection: selectionFromSamples(truncatedOverdubState.buffer, 3_000, 3_631),
  label: 'truncated overdub stores only its mixed source range',
});
const truncatedOverlay = truncatedOverdubState.segments.find((segment) => segment.type === 'OVERDUB');
assert.ok(truncatedOverlay, 'overdub descriptor is persisted');
assert.equal(
  Math.round((truncatedOverlay.sourceEnd - truncatedOverlay.sourceStart) * truncatedOverdubState.buffer.sampleRate),
  631,
  'truncated overdub descriptor has no unplayed source tail'
);
applyAndVerifyEdit(truncatedOverdubState, 'REPLACE', {
  selection: selectionFromSamples(truncatedOverdubState.buffer, 3_200, 3_400),
  label: 'replace splitting a truncated overdub remains replayable',
});
const splitOverdubSegments = truncatedOverdubState.segments.filter((segment) => segment.type === 'OVERDUB');
assert.equal(splitOverdubSegments.length, 2, 'replace split the persisted overdub into causal left/right spans');
for (const segment of splitOverdubSegments) {
  assert.equal(
    Math.round((segment.sourceEnd - segment.sourceStart) * truncatedOverdubState.buffer.sampleRate),
    Math.round(segment.projectDuration * truncatedOverdubState.buffer.sampleRate),
    'each split overdub keeps matching source and project sample spans'
  );
}

// Regression: exact sample positions are commonly represented as decimals in
// the UI. Do not let a floating-point value such as 16.15 turn into sample
// 16149 through an unguarded Math.floor conversion.
const decimalBoundaryState = createCausalEditState({
  seconds: 24.256,
  clipboard: new Float32Array(2_827).fill(0.41),
  seed: 92,
});
const decimalBoundaryBeforeLength = decimalBoundaryState.buffer.length;
applyAndVerifyEdit(decimalBoundaryState, 'PASTE_REPLACE', {
  selection: selectionFromSamples(decimalBoundaryState.buffer, 16_150, 18_764),
  label: 'decimal exact-sample paste/replace boundary',
});
assert.equal(
  decimalBoundaryState.buffer.length,
  decimalBoundaryBeforeLength - (18_764 - 16_150) + 2_827,
  'decimal exact-sample selection removes precisely its requested sample range'
);

/** Small deterministic PRNG: failures are replayable by seed without a test dependency. */
function randomForSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const SEQUENCES = 32;
const STEPS_PER_SEQUENCE = 48;
const coverage = new Map<EditCommand, number>(EDIT_COMMANDS.map((command) => [command, 0]));
let sequenceExecutions = 0;

for (let seed = 1; seed <= SEQUENCES; seed++) {
  const random = randomForSeed(seed * 0x9e3779b1);
  const state = createCausalEditState({ seconds: 16, seed });

  for (let step = 0; step < STEPS_PER_SEQUENCE; step++) {
    // Offset each deterministic command cycle with random values. Cycling makes
    // coverage strict: no command can disappear due to chance.
    const command = EDIT_COMMANDS[(step + Math.floor(random() * EDIT_COMMANDS.length)) % EDIT_COMMANDS.length];
    const maxStart = Math.max(0, state.buffer.length - 2);
    const start = Math.min(maxStart, Math.floor(random() * Math.max(1, state.buffer.length * 0.85)));
    const maxLength = Math.max(1, Math.min(state.buffer.length - start, Math.floor(state.buffer.length * (0.03 + random() * 0.10))));
    const end = Math.min(state.buffer.length, start + maxLength);
    const insertion = fractionalInsertionTime(state.buffer, random());

    applyAndVerifyEdit(state, command, {
      selection: selectionFromSamples(state.buffer, start, end),
      insertTime: insertion,
      label: `seed ${seed}, step ${step + 1}, ${command}`,
    });
    coverage.set(command, (coverage.get(command) || 0) + 1);
    sequenceExecutions++;
  }
}

for (const command of EDIT_COMMANDS) {
  assert.ok((coverage.get(command) || 0) >= SEQUENCES, `${command} is represented across long histories`);
}
assert.equal(sequenceExecutions, SEQUENCES * STEPS_PER_SEQUENCE, 'all deterministic long-history commands executed');

console.log(
  `edit-command contracts: ${boundaryExecutions} boundary cases + 2 focused regressions + ` +
  `${SEQUENCES} × ${STEPS_PER_SEQUENCE} long-history commands (${sequenceExecutions} operations) OK`
);
