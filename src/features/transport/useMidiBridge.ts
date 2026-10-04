/**
 * Verbindung zwischen MIDI-Hardware (Pioneer DDJ-FLX4 / DDJ-1000) und den
 * Transport-Aktionen der Anwendung.
 *
 * Warum diese Datei existiert:
 *   Der Effekt stand mitten in `App.tsx` (Zerlegung WP-06, Schritt 1) und
 *   registrierte sich bei jeder Änderung eines der sechs Handler neu. Hier ist
 *   die Zuordnung Hardware-Ereignis → Aktion an einer Stelle sichtbar; die
 *   Komponente liefert nur noch die Aktionen herein.
 */

import { useEffect } from 'react';
import { midiManager } from '../../midi/midiManager';
import { getPositionSec } from '../../state/transportStore';
import type { StemType } from '../../audio/stemEngine';

/** Umrechnung der Drehregler-Schritte in Sekunden. */
const SEEK_SECONDS_PER_STEP = 0.15;

export interface UseMidiBridgeOptions {
  handleTogglePlay: () => void;
  handleReturnToStart: () => void;
  handleSeek: (targetTime: number) => void;
  handleToggleStemMute: (stem: StemType) => void;
  handleToggleStemSolo: (stem: StemType) => void;
  handleMasterVolumeChange: (volume: number) => void;
  setLoopActive: (updater: (previous: boolean) => boolean) => void;
  setMidiConnected: (connected: boolean) => void;
  setMidiStatusLabel: (label: string) => void;
}

export function useMidiBridge(options: UseMidiBridgeOptions): void {
  const {
    handleTogglePlay,
    handleReturnToStart,
    handleSeek,
    handleToggleStemMute,
    handleToggleStemSolo,
    handleMasterVolumeChange,
    setLoopActive,
    setMidiConnected,
    setMidiStatusLabel,
  } = options;

  // Pioneer DDJ-FLX4 & DDJ-1000 MIDI Controller Hardware Lifecycle.
  // Read transport time through a ref so 60fps playhead updates don't re-init MIDI listeners.
  useEffect(() => {
    let cancelled = false;

    const refreshDeviceState = () => {
      if (cancelled) return;
      setMidiConnected(midiManager.getConnectedDevices().length > 0);
      setMidiStatusLabel(midiManager.getStatusLabel());
    };

    midiManager.init().then(refreshDeviceState);
    const unsubState = midiManager.onStateChange(refreshDeviceState);

    const unsubActions = midiManager.subscribe((action) => {
      switch (action.type) {
        case 'STEM_TOGGLE':
          if (action.stem) handleToggleStemMute(action.stem);
          break;
        case 'STEM_SOLO':
          if (action.stem) handleToggleStemSolo(action.stem);
          break;
        case 'PLAY_PAUSE':
          handleTogglePlay();
          break;
        case 'CUE':
          handleReturnToStart();
          break;
        case 'LOOP_TOGGLE':
          setLoopActive((prev) => !prev);
          break;
        case 'SEEK':
          if (action.value !== undefined) {
            handleSeek(getPositionSec() + action.value * SEEK_SECONDS_PER_STEP);
          }
          break;
        case 'MASTER_VOLUME':
          if (action.value !== undefined) {
            handleMasterVolumeChange(action.value);
          }
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubState();
      unsubActions();
    };
  }, [
    handleToggleStemMute,
    handleToggleStemSolo,
    handleTogglePlay,
    handleReturnToStart,
    handleSeek,
    handleMasterVolumeChange,
    setLoopActive,
    setMidiConnected,
    setMidiStatusLabel,
  ]);
}
