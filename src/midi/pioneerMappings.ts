/**
 * @license
 * Pioneer DJ Controller MIDI Mappings
 * Explicit definitions for Pioneer DDJ-FLX4 and Pioneer DDJ-1000,
 * with standard Action Pads assigned to Stems (Vocals, Drums, Bass, Other).
 */

import { StemType } from '../audio/stemEngine';

export type ControllerModel = 'PIONEER_DDJ_FLX4' | 'PIONEER_DDJ_1000' | 'GENERIC_MIDI';

export interface MidiAction {
  type:
    | 'STEM_TOGGLE'
    | 'STEM_SOLO'
    | 'STEM_VOLUME'
    | 'PLAY_PAUSE'
    | 'CUE'
    | 'SEEK'
    | 'LOOP_TOGGLE'
    | 'HOT_CUE'
    | 'MASTER_VOLUME'
    | 'UNKNOWN';
  stem?: StemType;
  deckIndex?: number; // 0 = Deck A / Deck 1, 1 = Deck B / Deck 2
  value?: number;
  rawNote?: number;
  rawCC?: number;
}

export interface ControllerProfile {
  id: ControllerModel;
  displayName: string;
  matchNames: string[];
  deckCount: number;
  hasRgbPads: boolean;
}

export const CONTROLLER_PROFILES: ControllerProfile[] = [
  {
    id: 'PIONEER_DDJ_FLX4',
    displayName: 'Pioneer DDJ-FLX4',
    matchNames: ['DDJ-FLX4', 'Pioneer DDJ-FLX4', 'DDJ-FLX4 MIDI', 'FLX4'],
    deckCount: 2,
    hasRgbPads: true,
  },
  {
    id: 'PIONEER_DDJ_1000',
    displayName: 'Pioneer DDJ-1000',
    matchNames: ['DDJ-1000', 'Pioneer DDJ-1000', 'DDJ-1000 MIDI', 'DDJ-1000SRT'],
    deckCount: 4,
    hasRgbPads: true,
  },
  {
    id: 'GENERIC_MIDI',
    displayName: 'Standard MIDI Controller',
    matchNames: ['*'],
    deckCount: 2,
    hasRgbPads: false,
  },
];

/**
 * Detects the controller profile based on the MIDI device name string.
 */
export function identifyControllerProfile(deviceName: string): ControllerProfile {
  const clean = (typeof deviceName === 'string' ? deviceName : '').toLowerCase();
  for (const profile of CONTROLLER_PROFILES) {
    if (profile.id === 'GENERIC_MIDI') continue;
    for (const pattern of profile.matchNames) {
      if (clean.includes(pattern.toLowerCase())) {
        return profile;
      }
    }
  }
  return CONTROLLER_PROFILES.find((p) => p.id === 'GENERIC_MIDI')!;
}

/**
 * Maps an incoming MIDI message (status byte, data1, data2) to a high-level DJ action.
 *
 * Performance / Action Pads in STEMS mode:
 * Pad 1 -> VOCALS (Mute / Unmute)
 * Pad 2 -> DRUMS  (Mute / Unmute)
 * Pad 3 -> BASS   (Mute / Unmute)
 * Pad 4 -> OTHER  (Mute / Unmute)
 *
 * Pads 5–8 (or Shift + Pads 1–4):
 * Pad 5 -> Solo VOCALS
 * Pad 6 -> Solo DRUMS
 * Pad 7 -> Solo BASS
 * Pad 8 -> Solo OTHER
 */
export function parsePioneerMidiMessage(
  data: Uint8Array,
  _profile: ControllerProfile
): MidiAction | null {
  if (!data || data.length < 2) return null;

  const status = data[0];
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const data1 = data[1];
  const data2 = data.length > 2 ? data[2] : 0;

  const isNoteOn = command === 0x90 && data2 > 0;
  const isCC = command === 0xb0;

  const deckIndex = channel === 1 ? 1 : 0;

  // 1. Play / Pause button
  // DDJ-FLX4 & DDJ-1000: Note 0x0B (11) on the deck channel
  if (isNoteOn && data1 === 0x0b) {
    return { type: 'PLAY_PAUSE', deckIndex, rawNote: data1 };
  }

  // 2. Cue button
  // DDJ-FLX4 & DDJ-1000: Note 0x0C (12) on the deck channel
  if (isNoteOn && data1 === 0x0c) {
    return { type: 'CUE', deckIndex, rawNote: data1 };
  }

  // 3. Loop toggle
  // DDJ-FLX4: Note 0x14 (20) or Note 0x10 (16)
  if (isNoteOn && (data1 === 0x14 || data1 === 0x10)) {
    return { type: 'LOOP_TOGGLE', deckIndex, rawNote: data1 };
  }

  // 4. Jog wheel (pitch bend / seek)
  // DDJ-FLX4 & DDJ-1000: CC 0x21 (33) or CC 0x22 (34)
  if (isCC && (data1 === 0x21 || data1 === 0x22)) {
    // Relative encoder value: 0..63 = forward, 64..127 = backward (2's complement)
    const delta = data2 < 64 ? data2 : data2 - 128;
    return { type: 'SEEK', deckIndex, value: delta, rawCC: data1 };
  }

  // 5. Master volume fader / level
  if (isCC && data1 === 0x07) {
    return { type: 'MASTER_VOLUME', value: data2 / 127, rawCC: data1 };
  }

  // 6. Action pads / performance pads (STEMS MAPPING)
  // DDJ-FLX4 sends notes 0x00..0x07 or 0x40..0x47 in pad mode.
  // DDJ-1000 sends notes 0x00..0x07, 0x40..0x47, or 0x60..0x67.
  if (isNoteOn) {
    const padNumber = resolvePadNumber(data1);

    if (padNumber !== null) {
      switch (padNumber) {
        case 1:
          return { type: 'STEM_TOGGLE', stem: 'vocals', deckIndex, rawNote: data1 };
        case 2:
          return { type: 'STEM_TOGGLE', stem: 'drums', deckIndex, rawNote: data1 };
        case 3:
          return { type: 'STEM_TOGGLE', stem: 'bass', deckIndex, rawNote: data1 };
        case 4:
          return { type: 'STEM_TOGGLE', stem: 'other', deckIndex, rawNote: data1 };

        case 5:
          return { type: 'STEM_SOLO', stem: 'vocals', deckIndex, rawNote: data1 };
        case 6:
          return { type: 'STEM_SOLO', stem: 'drums', deckIndex, rawNote: data1 };
        case 7:
          return { type: 'STEM_SOLO', stem: 'bass', deckIndex, rawNote: data1 };
        case 8:
          return { type: 'STEM_SOLO', stem: 'other', deckIndex, rawNote: data1 };
      }
    }
  }

  return { type: 'UNKNOWN', deckIndex, rawNote: data1 };
}

/**
 * Normalizes the different MIDI note layouts (FLX4 / DDJ-1000) into a 1-based pad index (1..8).
 */
function resolvePadNumber(note: number): number | null {
  // Standard 0..7
  if (note >= 0 && note <= 7) return note + 1;
  // Pioneer pad block 64..71 (0x40..0x47)
  if (note >= 64 && note <= 71) return note - 64 + 1;
  // Pioneer pad block 96..103 (0x60..0x67)
  if (note >= 96 && note <= 103) return note - 96 + 1;
  // Keyboard / General MIDI drum pads 36..43 (C1..G1)
  if (note >= 36 && note <= 43) return note - 36 + 1;
  // General 48..55
  if (note >= 48 && note <= 55) return note - 48 + 1;

  return null;
}

/**
 * Generates a MIDI Note-On message for LED feedback on Pioneer DDJ action pads.
 */
export function getPioneerPadLedMessage(
  padNumber: number, // 1..8
  active: boolean,
  _stem?: StemType,
  channel: number = 0
): Uint8Array {
  const noteOffset = 0x00 + (padNumber - 1);
  const velocity = active ? 127 : 0; // 127 = full LED brightness / 0 = off
  return new Uint8Array([0x90 | (channel & 0x0f), noteOffset, velocity]);
}
