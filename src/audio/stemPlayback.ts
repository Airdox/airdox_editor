import { STEM_TYPES, StemsMixerState, TrackStems } from './stemEngine';

export interface StemPlaybackController {
  getIsPlaying(): boolean;
  getCurrentTime(): number;
  playWithStems(
    stems: TrackStems,
    mixer: StemsMixerState,
    offset: number,
    loop: boolean,
    loopStart: number,
    loopEnd: number
  ): void;
  play(buffer: AudioBuffer, offset: number, loop: boolean, loopStart: number, loopEnd: number): void;
  updateStemMixer(mixer: StemsMixerState): void;
}

export function isCustomStemMix(mixer: StemsMixerState): boolean {
  return STEM_TYPES.some(
    (stem) => mixer[stem].muted || mixer[stem].solo || mixer[stem].volume !== 1
  );
}

/**
 * Applies a preset immediately. This specifically prevents the old bug where
 * Acapella changed four inactive GainNodes while the untouched master source
 * continued playing, making Acapella sound exactly like the original.
 */
export function applyStemMixDuringPlayback(
  engine: StemPlaybackController,
  stems: TrackStems | null,
  original: AudioBuffer | null,
  mixer: StemsMixerState,
  loop = false,
  loopStart = 0,
  loopEnd = 0
): void {
  if (engine.getIsPlaying() && stems && original) {
    const position = engine.getCurrentTime();
    if (isCustomStemMix(mixer)) {
      engine.playWithStems(stems, mixer, position, loop, loopStart, loopEnd);
    } else {
      engine.play(original, position, loop, loopStart, loopEnd);
    }
    return;
  }
  engine.updateStemMixer(mixer);
}
