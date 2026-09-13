import { STEM_TYPES, StemsMixerState, TrackStems } from './stemEngine';

export interface StemPlaybackController {
  getIsPlaying(): boolean;
  getIsPlayingStems(): boolean;
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
    const customMix = isCustomStemMix(mixer);
    const alreadyPlayingStems = engine.getIsPlayingStems();

    // The running master is not connected to the four stem GainNodes. Replace
    // it once when the first Solo/Mute/volume action is made.
    if (customMix && !alreadyPlayingStems) {
      engine.playWithStems(
        stems,
        mixer,
        engine.getCurrentTime(),
        loop,
        loopStart,
        loopEnd
      );
      return;
    }

    // Reset while stems are active must return to the authoritative master.
    if (!customMix && alreadyPlayingStems) {
      engine.play(
        original,
        engine.getCurrentTime(),
        loop,
        loopStart,
        loopEnd
      );
      return;
    }
  }

  // Once four stem sources are active, changing Solo/Mute/volume must only
  // alter gains. Restarting sources on every click can trigger stale onended
  // events and briefly stop or silence the newly started vocal source.
  engine.updateStemMixer(mixer);
}
