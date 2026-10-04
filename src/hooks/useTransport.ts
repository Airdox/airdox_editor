import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { audioEngine } from '../audio/audioEngine';

interface UseTransportOptions {
  viewOffset: number;
  viewDuration: number;
  setViewOffset: Dispatch<SetStateAction<number>>;
}

/** Owns transport-facing UI state and publishes meter/time updates at bounded rates. */
export function useTransport({ viewOffset, viewDuration, setViewOffset }: UseTransportOptions) {
  const [currentTime, setCurrentTimeState] = useState(0);
  const currentTimeRef = useRef(0);
  const setCurrentTime = useCallback((nextTime: number) => {
    currentTimeRef.current = nextTime;
    setCurrentTimeState(nextTime);
  }, []);
  const [isPlaying, setIsPlaying] = useState(false);
  const [masterVolume, setMasterVolumeState] = useState(0.9);
  const [meterL, setMeterL] = useState(0);
  const [meterR, setMeterR] = useState(0);
  const viewRef = useRef({ viewOffset, viewDuration, setViewOffset });

  useEffect(() => {
    viewRef.current = { viewOffset, viewDuration, setViewOffset };
  }, [viewOffset, viewDuration, setViewOffset]);

  useEffect(() => {
    let animId = 0;
    let lastTimeUiUpdate = Number.NEGATIVE_INFINITY;
    let lastMeterUiUpdate = Number.NEGATIVE_INFINITY;
    const timeUiIntervalMs = 1000 / 30;
    const meterUiIntervalMs = 1000 / 20;

    const updateLoop = (timestamp: number) => {
      if (audioEngine.getIsPlaying()) {
        const time = audioEngine.getCurrentTime();
        currentTimeRef.current = time;
        if (timestamp - lastTimeUiUpdate >= timeUiIntervalMs) {
          setCurrentTimeState(time);
          lastTimeUiUpdate = timestamp;
        }

        const viewport = viewRef.current;
        if (time > viewport.viewOffset + viewport.viewDuration * 0.9) {
          viewport.setViewOffset(Math.max(0, time - viewport.viewDuration * 0.2));
        }

        if (timestamp - lastMeterUiUpdate >= meterUiIntervalMs) {
          const meter = audioEngine.getMasterMeter();
          setMeterL(meter.left);
          setMeterR(meter.right);
          lastMeterUiUpdate = timestamp;
        }
      } else if (timestamp - lastMeterUiUpdate >= meterUiIntervalMs) {
        setMeterL((previous) => Math.max(0, previous * 0.85));
        setMeterR((previous) => Math.max(0, previous * 0.85));
        lastMeterUiUpdate = timestamp;
      }
      animId = requestAnimationFrame(updateLoop);
    };

    animId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  const setMasterVolume = useCallback((volume: number) => {
    setMasterVolumeState(volume);
    audioEngine.setMasterVolume(volume);
  }, []);

  return {
    currentTime,
    currentTimeRef,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    masterVolume,
    setMasterVolume,
    meterL,
    meterR,
  };
}
