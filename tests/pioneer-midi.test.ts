import assert from 'node:assert/strict';
import {
  identifyControllerProfile,
  parsePioneerMidiMessage,
  getPioneerPadLedMessage,
  MidiAction,
} from '../src/midi/pioneerMappings';
import { midiManager } from '../src/midi/midiManager';

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  PIONEER DJ MIDI CONTROLLER INTEGRATION TEST SUITE               ');
console.log('═══════════════════════════════════════════════════════════════════');

async function runTests() {
  // Test 1: Hardware device matching
  console.log('[ TEST ] #1 Hardware device name identification and profile selection');
  const flx4Profile = identifyControllerProfile('Pioneer DDJ-FLX4 MIDI');
  assert.equal(flx4Profile.id, 'PIONEER_DDJ_FLX4', 'Matches DDJ-FLX4 profile');

  const ddj1000Profile = identifyControllerProfile('DDJ-1000 Controller');
  assert.equal(ddj1000Profile.id, 'PIONEER_DDJ_1000', 'Matches DDJ-1000 profile');

  const genericProfile = identifyControllerProfile('Unknown MIDI Controller');
  assert.equal(genericProfile.id, 'GENERIC_MIDI', 'Falls back to GENERIC_MIDI');
  console.log('  -> [PASS] Hardware discovery identifies DDJ-FLX4, DDJ-1000, and generic controllers.');

  // Test 2: DDJ-FLX4 action pad to stems mappings
  console.log('[ TEST ] #2 DDJ-FLX4 Performance Pads 1-4 mapped to Vocals, Drums, Bass, Other');
  const msgPad1 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x00, 0x7f]), flx4Profile);
  const msgPad2 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x01, 0x7f]), flx4Profile);
  const msgPad3 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x02, 0x7f]), flx4Profile);
  const msgPad4 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x03, 0x7f]), flx4Profile);

  assert.equal(msgPad1?.type, 'STEM_TOGGLE');
  assert.equal(msgPad1?.stem, 'vocals', 'Pad 1 mapped to Vocals toggle');
  assert.equal(msgPad2?.stem, 'drums', 'Pad 2 mapped to Drums toggle');
  assert.equal(msgPad3?.stem, 'bass', 'Pad 3 mapped to Bass toggle');
  assert.equal(msgPad4?.stem, 'other', 'Pad 4 mapped to Other toggle');
  console.log('  -> [PASS] DDJ-FLX4 Stems performance pads 1-4 verified.');

  // Test 3: DDJ-1000 action pads with alternate offset 0x40..0x43
  console.log('[ TEST ] #3 DDJ-1000 Performance Pads 1-4 mapped to Vocals, Drums, Bass, Other');
  const d1000Pad1 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x40, 0x7f]), ddj1000Profile);
  const d1000Pad2 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x41, 0x7f]), ddj1000Profile);
  const d1000Pad3 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x42, 0x7f]), ddj1000Profile);
  const d1000Pad4 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x43, 0x7f]), ddj1000Profile);

  assert.equal(d1000Pad1?.type, 'STEM_TOGGLE');
  assert.equal(d1000Pad1?.stem, 'vocals', 'DDJ-1000 Pad 1 mapped to Vocals');
  assert.equal(d1000Pad2?.stem, 'drums', 'DDJ-1000 Pad 2 mapped to Drums');
  assert.equal(d1000Pad3?.stem, 'bass', 'DDJ-1000 Pad 3 mapped to Bass');
  assert.equal(d1000Pad4?.stem, 'other', 'DDJ-1000 Pad 4 mapped to Other');
  console.log('  -> [PASS] DDJ-1000 Stems performance pads 1-4 verified.');

  // Test 4: Stems solo pads 5-8
  console.log('[ TEST ] #4 Performance Pads 5-8 mapped to Stem Solo');
  const msgPad5 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x04, 0x7f]), flx4Profile);
  const msgPad6 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x05, 0x7f]), flx4Profile);
  const msgPad7 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x06, 0x7f]), flx4Profile);
  const msgPad8 = parsePioneerMidiMessage(new Uint8Array([0x90, 0x07, 0x7f]), flx4Profile);

  assert.equal(msgPad5?.type, 'STEM_SOLO');
  assert.equal(msgPad5?.stem, 'vocals', 'Pad 5 mapped to Vocals Solo');
  assert.equal(msgPad6?.stem, 'drums', 'Pad 6 mapped to Drums Solo');
  assert.equal(msgPad7?.stem, 'bass', 'Pad 7 mapped to Bass Solo');
  assert.equal(msgPad8?.stem, 'other', 'Pad 8 mapped to Other Solo');
  console.log('  -> [PASS] Stems Solo pads 5-8 verified.');

  // Test 5: Transport controls
  console.log('[ TEST ] #5 Transport Controls (Play/Pause, Cue, Loop)');
  const playMsg = parsePioneerMidiMessage(new Uint8Array([0x90, 0x0b, 0x7f]), flx4Profile);
  const cueMsg = parsePioneerMidiMessage(new Uint8Array([0x90, 0x0c, 0x7f]), flx4Profile);
  const loopMsg = parsePioneerMidiMessage(new Uint8Array([0x90, 0x14, 0x7f]), flx4Profile);

  assert.equal(playMsg?.type, 'PLAY_PAUSE', 'FLX4 Play/Pause note 0x0B recognized');
  assert.equal(cueMsg?.type, 'CUE', 'FLX4 Cue note 0x0C recognized');
  assert.equal(loopMsg?.type, 'LOOP_TOGGLE', 'FLX4 Loop note 0x14 recognized');
  console.log('  -> [PASS] Pioneer transport notes (0x0B Play, 0x0C Cue, 0x14 Loop) verified.');

  // Test 6: LED feedback generation for stems mute/solo
  console.log('[ TEST ] #6 Hardware LED feedback message generation');
  const ledVocalOn = getPioneerPadLedMessage(1, true, 'vocals', 0);
  assert.equal(ledVocalOn[0], 0x90, 'Channel 1 Note-On status byte');
  assert.equal(ledVocalOn[1], 0x00, 'Pad 1 note byte (0x00)');
  assert.equal(ledVocalOn[2], 127, 'Velocity 127 for active stem LED');

  const ledVocalOff = getPioneerPadLedMessage(1, false, 'vocals', 0);
  assert.equal(ledVocalOff[2], 0, 'Velocity 0 for muted stem LED');
  console.log('  -> [PASS] LED feedback illuminates active stems and turns off muted stems.');

  // Test 7: Action subscriber and dispatching
  console.log('[ TEST ] #7 Event dispatch & subscriber notifications');
  midiManager.clearEventLog();
  const receivedActions: MidiAction[] = [];
  const unsubscribe = midiManager.subscribe((action) => {
    receivedActions.push(action);
  });

  // Raw MIDI Note-On packet from DDJ-FLX4 Pad 1 (Vocals)
  midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, 0x00, 0x7f]), flx4Profile);

  assert.equal(receivedActions.length, 1, 'Received 1 dispatched action');
  assert.equal(receivedActions[0].type, 'STEM_TOGGLE', 'Dispatched STEM_TOGGLE action');
  assert.equal(receivedActions[0].stem, 'vocals', 'Dispatched vocals stem toggle');

  // Play/Pause Note-On
  midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, 0x0b, 0x7f]), flx4Profile);

  assert.equal(receivedActions.length, 2, 'Received 2 dispatched actions');
  assert.equal(receivedActions[1].type, 'PLAY_PAUSE', 'Dispatched PLAY_PAUSE action');

  unsubscribe();
  midiManager.handleMidiMessage('Pioneer DDJ-FLX4', new Uint8Array([0x90, 0x00, 0x7f]), flx4Profile);
  assert.equal(receivedActions.length, 2, 'Unsubscribed handler receives no further actions');
  console.log('  -> [PASS] MIDI messages correctly translated to Pioneer DJ stem and deck actions.');

  console.log('───────────────────────────────────────────────────────────────────');
  console.log('All Pioneer MIDI Controller tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Pioneer MIDI Test Failed:', err);
  process.exit(1);
});
