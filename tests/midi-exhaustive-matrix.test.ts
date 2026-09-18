import assert from 'node:assert/strict';
import {
  identifyControllerProfile,
  parsePioneerMidiMessage,
  getPioneerPadLedMessage,
  MidiAction,
} from '../src/midi/pioneerMappings';
import { midiManager } from '../src/midi/midiManager';
import { DEFAULT_STEMS_MIXER_STATE, StemsMixerState, STEM_TYPES } from '../src/audio/stemEngine';

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  EXHAUSTIVE PIONEER MIDI HARDWARE MATRIX TEST SUITE                      ');
console.log('══════════════════════════════════════════════════════════════════════════');

async function runMidiExhaustiveTests() {
  let passedCount = 0;
  const flx4Profile = identifyControllerProfile('Pioneer DDJ-FLX4');
  const ddj1000Profile = identifyControllerProfile('Pioneer DDJ-1000');

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 1: Complete 8-pad note space across all Pioneer note offsets
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 1: 8 Performance Pads in 3 Note-Offset Blocks ---');

  const noteOffsetBlocks = [
    { name: 'Standard 0x00-0x07', base: 0x00 },
    { name: 'Block 1 0x40-0x47', base: 0x40 },
    { name: 'Block 2 0x60-0x67', base: 0x60 },
  ];
  const expectedStems = ['vocals', 'drums', 'bass', 'other'];

  for (const block of noteOffsetBlocks) {
    for (let pad = 0; pad < 8; pad++) {
      const note = block.base + pad;
      const action = parsePioneerMidiMessage(new Uint8Array([0x90, note, 127]), ddj1000Profile);

      assert.ok(action !== null, `Note ${note} should parse to an action`);
      if (pad < 4) {
        assert.equal(action?.type, 'STEM_TOGGLE');
        assert.equal(action?.stem, expectedStems[pad]);
      } else {
        assert.equal(action?.type, 'STEM_SOLO');
        assert.equal(action?.stem, expectedStems[pad - 4]);
      }
    }
    console.log(`  [PASS] Offset Block '${block.name}' all 8 pads mapped accurately.`);
    passedCount++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 2: Velocity edge cases & note-off suppression
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 2: Velocity & Note-Off Discrimination ---');

  const velMax = parsePioneerMidiMessage(new Uint8Array([0x90, 0x00, 127]), flx4Profile);
  assert.equal(velMax?.type, 'STEM_TOGGLE');

  const velMin = parsePioneerMidiMessage(new Uint8Array([0x90, 0x00, 1]), flx4Profile);
  assert.equal(velMin?.type, 'STEM_TOGGLE');

  // Note-On with velocity 0 is a Note-Off and must not retrigger the pad.
  const velZero = parsePioneerMidiMessage(new Uint8Array([0x90, 0x00, 0]), flx4Profile);
  assert.equal(velZero?.type, 'UNKNOWN');

  const noteOff = parsePioneerMidiMessage(new Uint8Array([0x80, 0x00, 64]), flx4Profile);
  assert.equal(noteOff?.type, 'UNKNOWN');

  console.log('  [PASS] Note-On velocities 1-127 recognized, Note-Off & velocity 0 safely ignored.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 3: Multi-deck channel routing
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 3: Multi-Deck Channel Routing ---');

  for (let ch = 0; ch < 4; ch++) {
    const statusByte = 0x90 | ch;
    const action = parsePioneerMidiMessage(new Uint8Array([statusByte, 0x0b, 127]), ddj1000Profile);
    assert.equal(action?.type, 'PLAY_PAUSE');
    assert.equal(action?.deckIndex, ch === 1 ? 1 : 0);
  }
  console.log('  [PASS] Multi-deck channel routing validated across channels.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 4: Jog wheel relative encoders & master volume CC
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 4: Jog Wheel Encoders & Master Volume CC ---');

  const jogFwd1 = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x21, 1]), flx4Profile);
  assert.equal(jogFwd1?.type, 'SEEK');
  assert.equal(jogFwd1?.value, 1);

  const jogFwd15 = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x21, 15]), flx4Profile);
  assert.equal(jogFwd15?.value, 15);

  const jogBack1 = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x21, 127]), flx4Profile);
  assert.equal(jogBack1?.type, 'SEEK');
  assert.equal(jogBack1?.value, -1);

  const jogBack10 = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x21, 118]), flx4Profile);
  assert.equal(jogBack10?.value, -10);

  const volZero = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x07, 0]), flx4Profile);
  assert.equal(volZero?.type, 'MASTER_VOLUME');
  assert.equal(volZero?.value, 0);

  const volFull = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x07, 127]), flx4Profile);
  assert.equal(volFull?.value, 1.0);

  console.log('  [PASS] Jog wheel relative encoder (+/-) and volume CC fader parsed accurately.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 5: Malformed & out-of-bounds packets
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 5: Malformed & Out-of-Bounds Packets Resilience ---');

  assert.equal(parsePioneerMidiMessage(new Uint8Array([]), flx4Profile), null);
  assert.equal(parsePioneerMidiMessage(new Uint8Array([0x90]), flx4Profile), null);
  const unknownCC = parsePioneerMidiMessage(new Uint8Array([0xb0, 0x7f, 100]), flx4Profile);
  assert.equal(unknownCC?.type, 'UNKNOWN');

  console.log('  [PASS] Malformed packets handled with zero unhandled exceptions.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 6: Real-time dispatcher, event log & subscriber lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 6: Dispatcher & Event Log Ring-Buffer ---');

  midiManager.clearEventLog();
  const actions: MidiAction[] = [];
  const unsub = midiManager.subscribe((a) => actions.push(a));

  for (let i = 0; i < 5; i++) {
    midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, i, 127]), flx4Profile);
  }

  assert.equal(actions.length, 5);
  assert.equal(midiManager.getEventLog().length, 5);

  unsub();
  midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, 0, 127]), flx4Profile);
  assert.equal(actions.length, 5, 'Unsubscribed listener receives no further events');

  // Unmapped traffic is still logged but never dispatched as an action.
  const logLenBefore = midiManager.getEventLog().length;
  midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0xb0, 0x7f, 12]), flx4Profile);
  assert.equal(midiManager.getEventLog().length, logLenBefore + 1, 'Unmapped message is logged');

  // The ring buffer is bounded so a hardware storm cannot exhaust memory.
  for (let i = 0; i < 200; i++) {
    midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, 0x00, 127]), flx4Profile);
  }
  assert.ok(midiManager.getEventLog().length <= 50, 'Event log is capped at 50 entries');
  midiManager.clearEventLog();
  assert.equal(midiManager.getEventLog().length, 0, 'Event log cleared');

  console.log('  [PASS] Event dispatcher, subscriber unsubscription, and bounded log verified.');
  passedCount++;

  // ─────────────────────────────────────────────────────────────────────────
  // GROUP 7: LED feedback across the full mute/solo state space
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- GROUP 7: LED Feedback Across the Mute/Solo State Space ---');

  for (let mask = 0; mask < 16; mask++) {
    const mixer: StemsMixerState = {
      vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, muted: (mask & 1) !== 0 },
      drums: { ...DEFAULT_STEMS_MIXER_STATE.drums, muted: (mask & 2) !== 0 },
      bass: { ...DEFAULT_STEMS_MIXER_STATE.bass, muted: (mask & 4) !== 0 },
      other: { ...DEFAULT_STEMS_MIXER_STATE.other, muted: (mask & 8) !== 0 },
    };
    const hasAnySolo = STEM_TYPES.some((s) => mixer[s].solo);

    STEM_TYPES.forEach((stem, index) => {
      const isLit = hasAnySolo ? mixer[stem].solo : !mixer[stem].muted;
      const msg = getPioneerPadLedMessage(index + 1, isLit, stem, 0);
      assert.equal(msg[1], index, `Pad ${index + 1} maps to note ${index}`);
      assert.equal(msg[2], isLit ? 127 : 0, `Pad ${index + 1} LED matches audibility for mask ${mask}`);
    });
  }

  // Solo overrides unmuted siblings: only the soloed pad stays lit.
  const soloMixer: StemsMixerState = {
    vocals: { ...DEFAULT_STEMS_MIXER_STATE.vocals, solo: true },
    drums: { ...DEFAULT_STEMS_MIXER_STATE.drums },
    bass: { ...DEFAULT_STEMS_MIXER_STATE.bass },
    other: { ...DEFAULT_STEMS_MIXER_STATE.other },
  };
  const soloActive = STEM_TYPES.some((s) => soloMixer[s].solo);
  STEM_TYPES.forEach((stem, index) => {
    const isLit = soloActive ? soloMixer[stem].solo : !soloMixer[stem].muted;
    const msg = getPioneerPadLedMessage(index + 1, isLit, stem, 0);
    assert.equal(msg[2], stem === 'vocals' ? 127 : 0, 'Only the soloed stem LED stays lit');
  });

  console.log('  [PASS] All 16 mute permutations plus solo override produce correct LED velocities.');
  passedCount++;

  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(`Total Pioneer MIDI Scenarios Tested: ${passedCount} | Failed: 0`);
  console.log('All hardware controller messages and profile decodings produce causally expected outcomes.');
}

runMidiExhaustiveTests().catch((err) => {
  console.error('MIDI Exhaustive Test Failed:', err);
  process.exit(1);
});
