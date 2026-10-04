/**
 * Transport-Bedienung: Wiedergabe, Springen, Zoom und Ansichtsfenster.
 *
 * Warum diese Datei existiert:
 *   `App.tsx` war eine einzige Komponente mit ~4.800 Zeilen, in der Bedienlogik,
 *   Zustand und Darstellung untrennbar vermischt waren. Dies ist Schritt 1 der
 *   im Plan (`docs/REFACTORING_PLAN.md`, WP-06) festgelegten Zerlegung.
 *
 *   Verschoben, nicht umgeschrieben: die Rümpfe der Handler sind unverändert
 *   übernommen. Die Abhängigkeiten kommen als Parameter herein, damit der Hook
 *   ohne Zugriff auf den Komponenten-Zustand testbar und lesbar ist.
 */

import { useCallback } from 'react';
import type React from 'react';
import { audioEngine } from '../../audio/audioEngine';
import { getPositionSec, setPosition } from '../../state/transportStore';
import type { SelectionRange, TrackModel } from '../../types/rekordbox';
import type { StemsMixerState, TrackStems } from '../../audio/stemEngine';

/** Voreinstellungen des Zoom-Menüs in Takten. */
export type ZoomPreset = '2_BARS' | '4_BARS' | '8_BARS' | '16_BARS' | '32_BARS' | '64_BARS' | 'FULL_TRACK';

/** Standard-Ansichtsfenster in Sekunden (ca. 9–10 Takte bei 130 bpm). */
export const DEFAULT_VIEW_DURATION_SEC = 18.0;

const MIN_VIEW_DURATION_SEC = 3.0;

export interface UseTransportControlsOptions {
  activeTrack: TrackModel | null;
  workingAudioBuffer: AudioBuffer | null;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  loopActive: boolean;
  selection: SelectionRange | null;
  activeTrackStems: TrackStems | null;
  stemsMixerState: StemsMixerState;
  /** Wahr, wenn die Stem-Mischung vom Standard abweicht und deshalb gespielt wird. */
  stemsMixIsCustom: boolean;
  /** Wird gebraucht, wenn ein Track ohne hinterlegte Audiodatei geöffnet wird. */
  audioFileInputRef: React.RefObject<HTMLInputElement | null>;
  viewDuration: number;
  setViewDuration: React.Dispatch<React.SetStateAction<number>>;
  setViewOffset: React.Dispatch<React.SetStateAction<number>>;
}

export interface TransportControls {
  handleTogglePlay: () => void;
  handleReturnToStart: () => void;
  handleSeek: (targetTime: number) => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleResetZoom: () => void;
  handleSelectZoomPreset: (preset: ZoomPreset) => void;
  handlePanView: (newOffset: number) => void;
}

export function useTransportControls(options: UseTransportControlsOptions): TransportControls {
  const {
    activeTrack,
    workingAudioBuffer,
    isPlaying,
    setIsPlaying,
    loopActive,
    selection,
    activeTrackStems,
    stemsMixerState,
    stemsMixIsCustom,
    audioFileInputRef,
    viewDuration,
    setViewDuration,
    setViewOffset,
  } = options;

  // Playback Toggle (supports both master working audio and isolated multi-stem playback)
  const handleTogglePlay = useCallback(() => {
    if (!activeTrack) {
      alert('Bitte lade zuerst einen Track oder importiere eine Audiodatei (WAV, MP3, FLAC).');
      return;
    }

    if (!workingAudioBuffer) {
      if (
        confirm(
          `Für "${activeTrack.title}" ist noch keine Audiodatei verknüpft.\n\nMöchtest du jetzt die passende Originaldatei (WAV, MP3, FLAC, AIFF) auswählen?`
        )
      ) {
        audioFileInputRef.current?.click();
      }
      return;
    }

    if (isPlaying) {
      // `pause()` liefert die exakte Position: sie geht in den Store, damit
      // Playhead und Anzeigen ohne React-Update nachziehen.
      setPosition(audioEngine.pause());
      setIsPlaying(false);
    } else {
      let loopStart = 0;
      let loopEnd = 0;
      if (loopActive && selection) {
        loopStart = selection.start;
        loopEnd = selection.end;
      }
      if (activeTrackStems && stemsMixIsCustom) {
        audioEngine.playWithStems(activeTrackStems, stemsMixerState, getPositionSec(), loopActive, loopStart, loopEnd);
      } else {
        audioEngine.play(workingAudioBuffer, getPositionSec(), loopActive, loopStart, loopEnd);
      }
      setIsPlaying(true);
    }
  }, [
    activeTrack,
    workingAudioBuffer,
    isPlaying,
    loopActive,
    selection,
    activeTrackStems,
    stemsMixerState,
    stemsMixIsCustom,
    audioFileInputRef,
    setIsPlaying,
  ]);

  const handleReturnToStart = useCallback(() => {
    audioEngine.stop();
    setIsPlaying(false);
    setPosition(0);
    setViewOffset(0);
  }, [setIsPlaying, setViewOffset]);

  const handleSeek = useCallback(
    (targetTime: number) => {
      const clamped = Math.max(0, Math.min(activeTrack?.duration || 0, targetTime));
      setPosition(clamped);
      if (isPlaying && workingAudioBuffer) {
        if (activeTrackStems && stemsMixIsCustom) {
          audioEngine.playWithStems(activeTrackStems, stemsMixerState, clamped, loopActive);
        } else {
          audioEngine.play(workingAudioBuffer, clamped, loopActive);
        }
      }
    },
    [
      activeTrack,
      isPlaying,
      workingAudioBuffer,
      activeTrackStems,
      stemsMixerState,
      stemsMixIsCustom,
      loopActive,
    ]
  );

  // Zoom controls
  const handleZoomIn = () => {
    setViewDuration((prev) => Math.max(MIN_VIEW_DURATION_SEC, prev * 0.7));
  };
  const handleZoomOut = () => {
    setViewDuration((prev) => Math.min(activeTrack?.duration || 120, prev * 1.4));
  };
  const handleResetZoom = () => {
    setViewDuration(DEFAULT_VIEW_DURATION_SEC);
  };
  const handleSelectZoomPreset = useCallback(
    (preset: ZoomPreset) => {
      const bpm = activeTrack?.bpm || 120.0;
      const secPerBar = (60 / bpm) * 4;
      let targetDuration = 16.0;

      if (preset === 'FULL_TRACK') {
        targetDuration = activeTrack ? activeTrack.duration : 60.0;
        setViewOffset(0);
        setViewDuration(targetDuration);
        return;
      }

      const barMap: Record<string, number> = {
        '2_BARS': 2,
        '4_BARS': 4,
        '8_BARS': 8,
        '16_BARS': 16,
        '32_BARS': 32,
        '64_BARS': 64,
      };
      const bars = barMap[preset] || 16;
      targetDuration = bars * secPerBar;

      if (activeTrack && targetDuration > activeTrack.duration) {
        targetDuration = activeTrack.duration;
      }

      const half = targetDuration / 2;
      let newOffset = Math.max(0, getPositionSec() - half);
      if (activeTrack && newOffset + targetDuration > activeTrack.duration) {
        newOffset = Math.max(0, activeTrack.duration - targetDuration);
      }
      setViewDuration(targetDuration);
      setViewOffset(newOffset);
    },
    [activeTrack, setViewDuration, setViewOffset]
  );

  const handlePanView = (newOffset: number) => {
    const maxOffset = Math.max(0, (activeTrack?.duration || 120) - viewDuration);
    setViewOffset(Math.max(0, Math.min(maxOffset, newOffset)));
  };

  return {
    handleTogglePlay,
    handleReturnToStart,
    handleSeek,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleSelectZoomPreset,
    handlePanView,
  };
}
