/**
 * @license
 * Zentraler Playback-Clock für die UI.
 *
 * Performance-Kontrakt: Wiedergabezeit (Playhead) und Master-Pegel werden
 * IMPERATIV über eine einzige requestAnimationFrame-Loop verteilt. Kein
 * Subscriber löst React-State-Updates pro Frame aus – sonst re-rendert die
 * komplette App 60×/Sekunde und Button-Klicks reagieren erst Sekunden später.
 *
 * Render-Pipeline der Wellenformen:
 *   - Statische Szene (Waveform, Beatgrid, Cues) → Offscreen-Canvas, nur bei
 *     echten Änderungen (Track/Zoom/Pan) neu gezeichnet.
 *   - Dynamische Szene (Playhead, Auswahl, Meter) → gezeichnet via Clock-Frame.
 */

import { audioEngine } from './audioEngine';

export interface PlaybackFrame {
  /** Authoritative Wiedergabeposition in Sekunden (auch im Pausenzustand korrekt). */
  time: number;
  isPlaying: boolean;
  /** Master-Pegel L/R (0..1) mit Decay-Rücklauf bei Pause. */
  meter: { left: number; right: number };
}

type FrameListener = (frame: PlaybackFrame) => void;

const METER_DECAY_PER_FRAME = 0.85;

class PlaybackClock {
  private listeners = new Set<FrameListener>();
  private rafId: number | null = null;
  private meter = { left: 0, right: 0 };

  /**
   * Registriert einen Frame-Listener. Die Loop läuft nur, solange mindestens
   * ein Listener aktiv ist (kein Leak, keine Idle-Last nach Unmount).
   */
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    if (this.rafId === null) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Aktuelle Frame-Daten ohne auf den nächsten Tick zu warten. */
  peek(): PlaybackFrame {
    return this.buildFrame();
  }

  private start(): void {
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      if (this.listeners.size === 0) {
        this.stop();
        return;
      }
      const frame = this.buildFrame();
      for (const listener of this.listeners) listener(frame);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private buildFrame(): PlaybackFrame {
    const isPlaying = audioEngine.getIsPlaying();
    if (isPlaying) {
      const raw = audioEngine.getMasterMeter();
      this.meter = { left: raw.left, right: raw.right };
    } else if (this.meter.left > 0.001 || this.meter.right > 0.001) {
      this.meter = {
        left: Math.max(0, this.meter.left * METER_DECAY_PER_FRAME),
        right: Math.max(0, this.meter.right * METER_DECAY_PER_FRAME),
      };
    } else {
      this.meter = { left: 0, right: 0 };
    }
    return {
      time: audioEngine.getCurrentTime(),
      isPlaying,
      meter: this.meter,
    };
  }
}

/** Prozessweiter Singleton – Subscriber: DetailWaveform, TrackOverview, EditModeBar, App. */
export const playbackClock = new PlaybackClock();
