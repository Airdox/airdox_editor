import { useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { midiManager } from '../midi/midiManager';
import type { StemType } from '../audio/stemEngine';

interface UseMidiLifecycleOptions {
  currentTimeRef: MutableRefObject<number>;
  setLoopActive: Dispatch<SetStateAction<boolean>>;
  onToggleStemMute: (stem: StemType) => void;
  onToggleStemSolo: (stem: StemType) => void;
  onTogglePlay: () => void;
  onReturnToStart: () => void;
  onSeek: (time: number) => void;
  onMasterVolumeChange: (volume: number) => void;
}

/** Owns the Web MIDI device lifecycle and maps controller actions to app commands. */
export function useMidiLifecycle({
  currentTimeRef,
  setLoopActive,
  onToggleStemMute,
  onToggleStemSolo,
  onTogglePlay,
  onReturnToStart,
  onSeek,
  onMasterVolumeChange,
}: UseMidiLifecycleOptions) {
  const [isMidiConnected, setIsMidiConnected] = useState(false);
  const [midiStatusLabel, setMidiStatusLabel] = useState('MIDI bereit');

  useEffect(() => {
    let cancelled = false;
    const refreshDeviceState = () => {
      if (cancelled) return;
      setIsMidiConnected(midiManager.getConnectedDevices().length > 0);
      setMidiStatusLabel(midiManager.getStatusLabel());
    };

    void midiManager.init().then(refreshDeviceState);
    const unsubscribeState = midiManager.onStateChange(refreshDeviceState);
    const unsubscribeActions = midiManager.subscribe((action) => {
      switch (action.type) {
        case 'STEM_TOGGLE':
          if (action.stem) onToggleStemMute(action.stem);
          break;
        case 'STEM_SOLO':
          if (action.stem) onToggleStemSolo(action.stem);
          break;
        case 'PLAY_PAUSE':
          onTogglePlay();
          break;
        case 'CUE':
          onReturnToStart();
          break;
        case 'LOOP_TOGGLE':
          setLoopActive((previous) => !previous);
          break;
        case 'SEEK':
          if (action.value !== undefined) onSeek(currentTimeRef.current + action.value * 0.15);
          break;
        case 'MASTER_VOLUME':
          if (action.value !== undefined) onMasterVolumeChange(action.value);
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeActions();
    };
  }, [
    currentTimeRef,
    setLoopActive,
    onToggleStemMute,
    onToggleStemSolo,
    onTogglePlay,
    onReturnToStart,
    onSeek,
    onMasterVolumeChange,
  ]);

  return { isMidiConnected, midiStatusLabel };
}
